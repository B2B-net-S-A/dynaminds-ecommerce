import { createHash } from 'node:crypto';
import { pool } from './db';
import { ensure, Problem } from './errors';
import type { Transport } from './integrations';
import { amazonBase } from './amazon';
import { ebayRetryUntil } from './ebay-api-limits';
export class AmazonApiWait extends Problem {
  constructor(
    public readonly until: string,
    public readonly family: string,
    public readonly reason: string,
  ) {
    super(429, `Amazon ${family}: limit API. Najwcześniejsza próba: ${until}`);
  }
}
/** Only the two read operations reviewed for the MCF panel. No order creation or updates. */
export function amazonMcfReadFamily(url: URL, method: string | undefined): 'mcf_preview' | 'mcf_order' | null {
  if (method === 'POST' && url.pathname === '/fulfillment/outbound/2026-07-04/previews' && !url.search)
    return 'mcf_preview';
  const prefix = '/fulfillment/outbound/2026-07-04/orders/';
  if (method !== 'GET' || !url.pathname.startsWith(prefix) || url.search !== '?shipments=INCLUDE') return null;
  const tail = url.pathname.slice(prefix.length);
  try {
    const id = decodeURIComponent(tail);
    if (id.length < 1 || id.length > 40 || id === '.' || id === '..' || /[\x00-\x1f\x7f]/.test(id) || !id.trim() || encodeURIComponent(id) !== tail)
      return null;
    return 'mcf_order';
  } catch { return null; }
}
const limits = {
  mcf_preview: { rate: 2, burst: 30 },
  mcf_order: { rate: 2, burst: 30 },
  sellers: { rate: 0.016, burst: 15 },
  listing_write: { rate: 5, burst: 5 },
  shipment_write: { rate: 2, burst: 10 },
  search: { rate: 0.0056, burst: 20 },
  order: { rate: 0.5, burst: 30 },
  oauth: { rate: 1, burst: 5 },
  listings_search: { rate: 5, burst: 5 },
  listings_get: { rate: 5, burst: 10 },
  report_create: { rate: 0.0167, burst: 15 },
  report_status: { rate: 2, burst: 15 },
  report_document: { rate: 0.0167, burst: 15 },
};
export type AmazonMutationTransport = Transport & {
  mutation?: (url: string, init: RequestInit, beforeSend: () => Promise<void>) => Promise<Response>;
};
export function amazonApiTransport(
  mode: string,
  region: string,
  clientId: string,
  transport: Transport,
): AmazonMutationTransport {
  const run = async (url: string, init: RequestInit, beforeSend?: () => Promise<void>) => {
    const u = new URL(url),
      oauth = url === 'https://api.amazon.com/auth/o2/token';
    const family = amazonMcfReadFamily(u, init.method) ?? (
      init.method === 'POST' &&
      /^\/orders\/v0\/orders\/\d{3}-\d{7}-\d{7}\/shipmentConfirmation$/.test(u.pathname)
        ? 'shipment_write'
        : init.method === 'PATCH' &&
            /^\/listings\/2021-08-01\/items\/[A-Z0-9]{1,32}\/[^/]+$/.test(u.pathname)
          ? 'listing_write'
          : init.method === 'GET' && u.pathname === '/sellers/v1/marketplaceParticipations'
            ? 'sellers'
            : oauth
              ? 'oauth'
              : init.method === 'GET' &&
                  /^\/orders\/2026-01-01\/orders(?:\/\d{3}-\d{7}-\d{7})?$/.test(u.pathname)
                ? u.pathname.endsWith('/orders')
                  ? 'search'
                  : 'order'
                : init.method === 'GET' &&
                    /^\/listings\/2021-08-01\/items\/[A-Z0-9]{1,32}$/.test(u.pathname)
                  ? 'listings_search'
                  : init.method === 'GET' &&
                      /^\/listings\/2021-08-01\/items\/[A-Z0-9]{1,32}\/[^/]+$/.test(u.pathname)
                    ? 'listings_get'
                    : init.method === 'POST' && u.pathname === '/reports/2021-06-30/reports'
                      ? 'report_create'
                      : init.method === 'GET' &&
                          /^\/reports\/2021-06-30\/reports\/[A-Za-z0-9._:-]{1,200}$/.test(
                            u.pathname,
                          )
                        ? 'report_status'
                        : init.method === 'GET' &&
                            /^\/reports\/2021-06-30\/documents\/[A-Za-z0-9._:-]{1,200}$/.test(
                              u.pathname,
                            )
                          ? 'report_document'
                          : null);
    ensure(
      oauth
        ? init.method === 'POST'
        : u.origin === amazonBase(mode, region) &&
            !u.username &&
            !u.password &&
            !u.hash &&
            !!family,
      422,
      'Nieprawidłowy adres kontrolowanego Amazon API',
    );
    ensure(family, 422, 'Nieprawidłowa operacja Amazon');
    const scope = createHash('sha256')
      .update(JSON.stringify({ mode, region: oauth ? 'global' : region, clientId, family }))
      .digest('hex');
    const { rate, burst } = limits[family],
      c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query("SET LOCAL statement_timeout='8s'");
      await c.query(
        'INSERT INTO amazon_api_buckets(scope_hash,family,tokens) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
        [scope, family, burst],
      );
      const b = (
        await c.query(
          'SELECT tokens,updated_at,cooldown_until,cooldown_until>clock_timestamp() blocked,extract(epoch from (clock_timestamp()-updated_at)) elapsed FROM amazon_api_buckets WHERE scope_hash=$1 FOR UPDATE',
          [scope],
        )
      ).rows[0];
      const tokens = Math.min(burst, b.tokens + Math.max(0, Number(b.elapsed)) * rate);
      if (b.blocked)
        throw new AmazonApiWait(new Date(b.cooldown_until).toISOString(), family, 'cooldown');
      if (tokens < 1)
        throw new AmazonApiWait(
          new Date(Date.now() + Math.ceil(((1 - tokens) / rate) * 1000)).toISOString(),
          family,
          'rate',
        );
      await c.query(
        'UPDATE amazon_api_buckets SET tokens=$2,updated_at=clock_timestamp() WHERE scope_hash=$1',
        [scope, tokens - 1],
      );
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
    // No tenant or quota transaction is held during network IO. An uncertain read still consumes its permit.
    await beforeSend?.();
    const r = await transport(url, init);
    const observed = Number(r.headers.get('x-amzn-RateLimit-Limit'));
    if (Number.isFinite(observed) && observed > 0)
      await pool.query('UPDATE amazon_api_buckets SET observed_rate=$2 WHERE scope_hash=$1', [
        scope,
        observed,
      ]);
    if (r.status === 429) {
      const until = ebayRetryUntil(r.headers.get('retry-after') ?? String(Math.ceil(1 / rate)));
      await pool.query(
        'UPDATE amazon_api_buckets SET cooldown_until=GREATEST(cooldown_until,$2::timestamptz),limited_responses=limited_responses+1 WHERE scope_hash=$1',
        [scope, until],
      );
      throw new AmazonApiWait(until, family, 'cooldown');
    }
    return r;
  };
  const controlled: AmazonMutationTransport = (url, init) => run(url, init);
  controlled.mutation = run;
  return controlled;
}
export async function deferAmazonApiJob(job: any, error: unknown) {
  if (!(error instanceof AmazonApiWait)) return false;
  const r = await pool.query(
    "UPDATE jobs SET state='pending',attempts=GREATEST(0,attempts-1),run_at=$3,provider_wait_until=$3,provider_wait_reason=$4,error=$5,lease_token=NULL,locked_at=NULL WHERE id=$1 AND lease_token=$2 AND state='running'",
    [
      job.id,
      job.lease_token,
      error.until,
      'amazon.' + error.family + '.' + error.reason,
      error.message,
    ],
  );
  return !!r.rowCount;
}
