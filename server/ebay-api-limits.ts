import { createHash, randomUUID } from 'node:crypto';
import type { Transport } from './integrations';
import { pool, tenantTx } from './db';
import { ensure, Problem } from './errors';

// Local concurrency protection, NOT the provider's daily quota or a claimed account allowance.
export const EBAY_API_CONCURRENCY = 4;
export const EBAY_API_LEASE_SECONDS = 60;
export class EbayApiWait extends Problem {
  constructor(
    public readonly until: string,
    public readonly family: string,
    public readonly reason: 'cooldown' | 'concurrency',
  ) {
    super(
      429,
      `eBay ${family}: ${reason === 'cooldown' ? 'przerwa po ograniczeniu API' : 'wszystkie miejsca dla żądań są zajęte'}. Najwcześniejsza próba: ${until}`,
    );
  }
}
export const ebayApplicationHash = (mode: string, clientId: string) =>
  createHash('sha256').update(JSON.stringify({ mode, clientId })).digest('hex');
export const ebayApiScope = (appHash: string, family: string) =>
  createHash('sha256').update(JSON.stringify({ appHash, family })).digest('hex');
export function ebayApiFamily(mode: string, raw: string) {
  const u = new URL(raw),
    base = mode === 'sandbox' ? 'https://api.sandbox.ebay.com' : 'https://api.ebay.com';
  ensure(
    ['sandbox', 'live'].includes(mode) &&
      u.origin === base &&
      !u.username &&
      !u.password &&
      !u.hash,
    422,
    'Nieprawidłowy adres kontrolowanego API eBay',
  );
  if (u.pathname === '/identity/v1/oauth2/token') return 'oauth';
  if (u.pathname === '/ws/api.dll') return 'trading';
  if (u.pathname.startsWith('/commerce/taxonomy/v1/')) return 'taxonomy';
  if (u.pathname === '/developer/analytics/v1_beta/rate_limit/' && !u.search)
    return 'analytics';
  const match = /^\/sell\/(inventory|fulfillment|account)\/v1\//.exec(u.pathname);
  ensure(match, 422, 'Nieobsługiwana rodzina kontrolowanego API eBay');
  return match[1];
}
export function ebayRetryUntil(value: string | null, now = Date.now()) {
  value = value?.trim() ?? null;
  const ms =
    value && /^\d+(\.\d+)?$/.test(value)
      ? Number(value) * 1000
      : value && /^[A-Za-z]{3}, /.test(value)
        ? Date.parse(value) - now
        : NaN;
  const date = new Date(now + Math.max(0, Number.isFinite(ms) ? ms : 60000));
  return Number.isFinite(date.getTime()) && date.getUTCFullYear() <= 9999
    ? date.toISOString()
    : new Date(now + 60000).toISOString();
}
export type EbayApiPermit = {
  id: string;
  scope: string;
  family: string;
  url: string;
  method: string;
  released: boolean;
};
export async function acquireEbayApi(
  appHash: string,
  family: string,
  url: string,
  method: string,
): Promise<EbayApiPermit> {
  const scope = ebayApiScope(appHash, family),
    c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query("SET LOCAL statement_timeout='8s'");
    await c.query(
      'INSERT INTO ebay_api_buckets(scope_hash,app_hash,family) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
      [scope, appHash, family],
    );
    const bucket = (
      await c.query(
        'SELECT cooldown_until, cooldown_until>statement_timestamp() blocked FROM ebay_api_buckets WHERE scope_hash=$1 FOR UPDATE',
        [scope],
      )
    ).rows[0];
    if (bucket.blocked)
      throw new EbayApiWait(new Date(bucket.cooldown_until).toISOString(), family, 'cooldown');
    await c.query(
      'DELETE FROM ebay_api_leases WHERE scope_hash=$1 AND expires_at<=statement_timestamp()',
      [scope],
    );
    const leases = (
      await c.query('SELECT count(*)::int n FROM ebay_api_leases WHERE scope_hash=$1', [scope])
    ).rows[0].n;
    if (leases >= EBAY_API_CONCURRENCY)
      throw new EbayApiWait(new Date(Date.now() + 1000).toISOString(), family, 'concurrency');
    const id = randomUUID();
    await c.query(
      'INSERT INTO ebay_api_leases(id,scope_hash,expires_at) VALUES($1,$2,clock_timestamp()+make_interval(secs=>$3))',
      [id, scope, EBAY_API_LEASE_SECONDS],
    );
    await c.query('COMMIT');
    return { id, scope, family, url, method, released: false };
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}
export async function releaseEbayApi(p: EbayApiPermit) {
  if (p.released) return;
  await pool.query('DELETE FROM ebay_api_leases WHERE id=$1 AND scope_hash=$2', [p.id, p.scope]);
  p.released = true;
}
type Control = { mode: string; appHash: string; base: Transport };
const controls = new WeakMap<Transport, Control>();
async function send(control: Control, p: EbayApiPermit, url: string, init: RequestInit) {
  let response: Response | undefined;
  try {
    ensure(
      !p.released &&
        p.url === url &&
        p.method === String(init.method ?? 'GET') &&
        p.scope === ebayApiScope(control.appHash, ebayApiFamily(control.mode, url)),
      409,
      'Miejsce API nie odpowiada żądaniu',
    );
    ensure(
      (
        await pool.query(
          'SELECT 1 FROM ebay_api_leases WHERE id=$1 AND scope_hash=$2 AND expires_at>statement_timestamp()',
          [p.id, p.scope],
        )
      ).rowCount,
      409,
      'Miejsce API wygasło przed wysłaniem; uzgodnij wynik odczytem',
    );
    // Existing admissions may finish after a concurrent 429. No new admission bypasses cooldown.
    const r = (response = await control.base(url, init));
    if (r.status === 429) {
      const until = ebayRetryUntil(r.headers.get('retry-after'));
      await pool.query(
        'UPDATE ebay_api_buckets SET cooldown_until=greatest(cooldown_until,$2::timestamptz),last_429_at=clock_timestamp(),limited_responses=limited_responses+1 WHERE scope_hash=$1',
        [p.scope, until],
      );
    }
    if (!r.body) {
      await releaseEbayApi(p);
      return r;
    }
    const reader = r.body.getReader();
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await reader.read();
          if (next.done) {
            await releaseEbayApi(p);
            controller.close();
          } else controller.enqueue(next.value);
        } catch (e) {
          await releaseEbayApi(p).catch(() => {});
          controller.error(e);
        }
      },
      async cancel(reason) {
        try {
          await reader.cancel(reason);
        } finally {
          await releaseEbayApi(p);
        }
      },
    });
    return new Response(body, { status: r.status, statusText: r.statusText, headers: r.headers });
  } catch (e) {
    await response?.body?.cancel().catch(() => {});
    await releaseEbayApi(p).catch(() => {});
    throw e;
  }
}
export function ebayLimitedTransport(
  mode: string,
  clientId: string | undefined,
  base: Transport,
): Transport {
  const existing = controls.get(base);
  if (existing) {
    ensure(
      existing.mode === mode &&
        (!clientId || existing.appHash === ebayApplicationHash(mode, clientId)),
      409,
      'Transport eBay należy do innej aplikacji',
    );
    return base;
  }
  // Pure connector tests may supply only an access token. Runtime channel validation requires client_id.
  if (!clientId) {
    ensure(
      process.env.DYNA_TEST === 'true',
      422,
      'Brak identyfikatora aplikacji dla kontroli API eBay',
    );
    return base;
  }
  const control = { mode, appHash: ebayApplicationHash(mode, clientId), base };
  const wrapped: Transport = async (url, init) =>
    send(
      control,
      await acquireEbayApi(
        control.appHash,
        ebayApiFamily(mode, url),
        url,
        String(init.method ?? 'GET'),
      ),
      url,
      init,
    );
  controls.set(wrapped, control);
  return wrapped;
}
export const ebayHasApiControl = (transport: Transport) => controls.has(transport);
export async function reserveEbayTransport(transport: Transport, url: string, method: string) {
  const control = controls.get(transport);
  return control
    ? acquireEbayApi(control.appHash, ebayApiFamily(control.mode, url), url, method)
    : undefined;
}
export async function sendEbayReserved(
  transport: Transport,
  p: EbayApiPermit | undefined,
  url: string,
  init: RequestInit,
) {
  const control = controls.get(transport);
  return control && p ? send(control, p, url, init) : transport(url, init);
}
export async function deferEbayApiJob(job: any, e: unknown) {
  if (!(e instanceof EbayApiWait)) return false;
  await tenantTx(job.tenant_id, async (c) => {
    await c.query(
      "UPDATE jobs SET state='pending',attempts=greatest(0,attempts-1),lease_token=NULL,locked_at=NULL,error=$3,run_at=$4::timestamptz+interval '100 milliseconds',provider_wait_until=$4,provider_wait_reason=$5 WHERE id=$1 AND lease_token=$2 AND state='running'",
      [job.id, job.lease_token, e.message, e.until, `ebay:${e.family}:${e.reason}`],
    );
  });
  return true;
}

export const ebaySimulationApplication = (tenant: string, mode: string) =>
  ebayApplicationHash(mode, 'DEMO:' + tenant);
export async function reserveEbaySimulation(tenant: string, mode: string, family = 'inventory') {
  return acquireEbayApi(ebaySimulationApplication(tenant, mode), family, 'simulation', 'POST');
}
export async function ebayApiStatus(appHash: string) {
  const rows = (
    await pool.query(
      `SELECT b.family,CASE WHEN b.cooldown_until>statement_timestamp() THEN b.cooldown_until ELSE NULL END cooldown_until,
    b.last_429_at,b.limited_responses::text, (SELECT count(*)::int FROM ebay_api_leases l WHERE l.scope_hash=b.scope_hash AND l.expires_at>statement_timestamp()) active_requests
    FROM ebay_api_buckets b WHERE b.app_hash=$1 ORDER BY b.family`,
      [appHash],
    )
  ).rows;
  return {
    concurrency_limit: EBAY_API_CONCURRENCY,
    lease_seconds: EBAY_API_LEASE_SECONDS,
    families: ['inventory', 'fulfillment', 'account', 'taxonomy', 'oauth', 'trading', 'analytics'].map(
      (family) => ({
        family,
        ...(rows.find((r) => r.family === family) ?? {
          cooldown_until: null,
          last_429_at: null,
          limited_responses: '0',
          active_requests: 0,
        }),
      }),
    ),
    provider_quota_read: false,
  };
}
