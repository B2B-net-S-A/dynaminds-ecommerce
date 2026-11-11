import { z } from 'zod';
import { tenantTx } from './db';
import type { Actor } from './domain';
import { ensure, Problem } from './errors';
import { decrypt } from './security';
import { safeFetch, type Transport } from './integrations';
import { Ebay, ebayBase, ebayConnectionHash, ebayJson } from './ebay';
import { EbayApiWait } from './ebay-api-limits';
import { ebayApplicationClient } from './ebay-seller-settings';
import { cachedEbayApiLimits } from './ebay-oauth';
import type { IntegrationContext } from './channel-access';

/** Official application quota, not seller/user quota and not our local lease budget.
 * Contract v1_beta.0.1: client_credentials + https://api.ebay.com/oauth/api_scope.
 * https://developer.ebay.com/api-docs/master/developer/analytics/openapi/3/developer_analytics_v1_beta_oas3.json
 * No polling, retry, quota enforcement, token persistence or caller-selected URL.
 */
const PATH = '/developer/analytics/v1_beta/rate_limit/';
const LIMIT = 1024 * 1024;
const text = z.string().min(1).max(200).regex(/^[^\u0000-\u001f\u007f]+$/);
const integer = z.number().int().nonnegative().safe();
const rate = z.object({
  limit: integer,
  remaining: integer,
  count: integer.optional(),
  reset: z.iso.datetime(),
  timeWindow: z.number().int().positive().safe(),
}).refine(v => v.remaining <= v.limit, 'Remaining exceeds its quota');
const response = z.object({
  rateLimits: z.array(z.object({
    apiContext: z.enum(['buy', 'sell', 'commerce', 'developer', 'tradingapi']),
    apiName: text,
    apiVersion: text,
    resources: z.array(z.object({name: text, rates: z.array(rate).max(20)})).max(1000),
  })).max(100),
  errors: z.array(z.unknown()).max(0).optional(),
  warnings: z.array(z.unknown()).max(0).optional(),
});

export function parseEbayProviderQuota(value: unknown) {
  const parsed = response.safeParse(value);
  ensure(parsed.success, 502, 'Niepełna lub nieprawidłowa odpowiedź limitów eBay');
  const rows: {
    api_context: string; api_name: string; api_version: string; resource: string;
    limit: number; remaining: number; count: number | null; reset: string; window_seconds: number;
  }[] = [];
  const groups = new Set<string>();
  for (const group of parsed.data.rateLimits) {
    const key = JSON.stringify([group.apiContext, group.apiName, group.apiVersion]);
    ensure(!groups.has(key), 502, 'Powtórzona grupa limitów eBay');
    groups.add(key);
    const resources = new Set<string>();
    for (const resource of group.resources) {
      ensure(!resources.has(resource.name), 502, 'Powtórzony zasób limitów eBay');
      resources.add(resource.name);
      const windows = new Set<number>();
      for (const item of resource.rates) {
        ensure(!windows.has(item.timeWindow), 502, 'Powtórzone okno limitów eBay');
        windows.add(item.timeWindow);
        ensure(rows.length < 2000, 502, 'Zbyt wiele okien limitów eBay');
        rows.push({api_context: group.apiContext, api_name: group.apiName,
          api_version: group.apiVersion, resource: resource.name, limit: item.limit,
          remaining: item.remaining, count: item.count ?? null, reset: item.reset,
          window_seconds: item.timeWindow});
      }
    }
  }
  return rows;
}

export async function readEbayApplicationQuota(
  mode: string, credentials: Record<string, string>, transport: Transport,
  fence: () => Promise<void>,
) {
  ensure(['sandbox', 'live'].includes(mode), 422, 'Nieprawidłowe środowisko eBay');
  const client = await ebayApplicationClient(new Ebay(mode, credentials, transport), fence);
  await fence();
  const result = await client.transport(ebayBase(mode) + PATH, {
    method: 'GET', redirect: 'error', signal: AbortSignal.timeout(12000),
    headers: {Authorization: 'Bearer ' + client.credentials.access_token, Accept: 'application/json'},
  }).catch(error => {
    if (error instanceof EbayApiWait) throw error;
    throw new Problem(502, 'Brak odpowiedzi limitów eBay; odczyt nie został ponowiony');
  });
  if (result.status === 204) {
    await result.body?.cancel();
    await fence();
    return {status: 'no_data' as const, rows: []};
  }
  if (result.status !== 200) {
    await result.body?.cancel();
    throw new Problem([401, 403, 429].includes(result.status) ? result.status : 502,
      'Odczyt limitów eBay: HTTP ' + result.status);
  }
  if (!/^application\/json(?:\s*;|$)/i.test(result.headers.get('content-type') ?? '')) {
    await result.body?.cancel();
    throw new Problem(502, 'Nieprawidłowy format odpowiedzi limitów eBay');
  }
  const rows = parseEbayProviderQuota(await ebayJson(result, LIMIT));
  await fence();
  return {status: rows.length ? 'observed' as const : 'no_data' as const, rows};
}

/** Browser session and current tenant admin are rechecked before each external
 * request and before releasing the result. No network inside tenant transactions.
 * Existing OAuth authority keeps API keys, expired or switched sessions out.
 */
export async function readEbayProviderQuota(
  actor: Actor, sessionHash: string, id: string, ctx: IntegrationContext = {},
) {
  z.uuid().parse(id);
  ensure(actor.role === 'admin', 403, 'Wymagana rola administratora');
  const check = async (expected?: string) => {
    await cachedEbayApiLimits(actor, sessionHash, id);
    return tenantTx(actor.tenantId, async c => {
      ensure((await c.query('SELECT offer_sync_is_admin($1) ok', [actor.userId])).rows[0]?.ok,
        403, 'Wymagana aktualna rola administratora');
      const ch = (await c.query('SELECT * FROM channels WHERE id=$1 FOR SHARE', [id])).rows[0];
      ensure(ch?.provider === 'ebay', 404, 'Nie znaleziono integracji eBay');
      ensure(ch.settings.simulation !== true, 422,
        'Przykład lokalny nie potwierdza limitów przyznanych przez eBay');
      ensure(!expected || ebayConnectionHash(ch) === expected, 409,
        'Połączenie eBay zmieniło się podczas odczytu limitów');
      return ch;
    });
  };
  const ch = await check(), pin = ebayConnectionHash(ch);
  const observed = await readEbayApplicationQuota(ch.mode, decrypt(ch.credentials),
    ctx.transport ?? safeFetch, async () => { await check(pin); });
  return {source: 'ebay_developer_analytics' as const, scope: 'application' as const,
    mode: ch.mode, observed_at: new Date().toISOString(), ...observed};
}
