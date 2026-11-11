import { beginAllegroRecovery, commitAllegroRecoveryInTx, refuseAllegroRecovery, allegroRecoveryRequired } from './allegro-oauth-recovery';
import type { FastifyRequest } from 'fastify';
import type { MiraklReadActor } from './mirakl-read-routes';
import type { PoolClient } from 'pg';
import { allegroAuthorityForRequest, allegroAuthorityForJobInTx,
  allegroAuthoritySecurityInTx, assertAllegroAuthorityBinding, assertAllegroAuthorityInTx,
  enlistAllegroAuthorityInTx, allegroAuthorityIsJob, pinAllegroJobSourceInTx,
  allegroOAuthCommitRefusal, allegroOAuthCommitRefusalDetails,
  type AllegroOAuthAuthority, type AllegroAuthoritySecurity } from './allegro-oauth-authority';
import { shopifyAccountPolicy, refreshShopifyOAuth } from './shopify-oauth';
import { shopifyGrantHash } from './shopify-auth-input';
import { amazonAccountPolicy } from './amazon-account';
import { Ebay, refreshEbay, ebayConnectionHash, ebayReadScopes, ebayScopesMatch } from './ebay';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import pg from 'pg';
import { holdingDbLock, lockDbClient } from './db-lock-holder';
import { pool, tenantTx } from './db';
import { ensure, Problem } from './errors';
import { encrypt, decrypt, tokenHash } from './security';
import { connector, safeFetch, type Transport } from './integrations';
import { audit, type Actor } from './domain';
import { allegroSettingsReadScope } from './allegro-creation';
export type OAuthConfig = { clientId: string; clientSecret: string; redirectUri: string };
export type IntegrationContext = {
  transport?: Transport;
  /** Construction-bound local fixture reader; ordinary remote workers retain page behavior. */
  localWooOrdersRead?: (channelId: string) => Promise<import('./local-woo-orders-read').LocalWooOrdersRead>;
  oauthConfig?: (mode: string) => OAuthConfig;
  sessionName?: string;
  /** Existing manual session authority is revalidated and pinned through tenant COMMIT. */
  miraklImportAuthority?: (c: PoolClient, actor: MiraklReadActor, channelId: string) => Promise<void>;
  allegroSecurity?: AllegroAuthoritySecurity;
  allegroAuthorityForChannel?: (c: PoolClient, channelId: string) =>
    AllegroOAuthAuthority | Promise<AllegroOAuthAuthority>;
};
/** Real native-authenticated request only; no principal/scopes from request body. */
export function withAllegroRequestContext(ctx: IntegrationContext, req: FastifyRequest,
  cookieName = ctx.sessionName ?? 'dyna_session'): IntegrationContext {
  return { ...ctx, allegroAuthorityForChannel: async (c, channelId) =>
    allegroAuthorityForRequest(req, cookieName, channelId,
      ctx.allegroSecurity ?? await allegroAuthoritySecurityInTx(c)) };
}
/** Lazy provider-specific job adapter. Other providers retain native authority. */
export function withAllegroJobContext(ctx: IntegrationContext, job: any): IntegrationContext {
  return { ...ctx, allegroAuthorityForChannel: async (c, channelId) =>
    allegroAuthorityForJobInTx(c, job, channelId,
      ctx.allegroSecurity ?? await allegroAuthoritySecurityInTx(c)) };
}
export async function enlistAllegroContextInTx(c: PoolClient, ctx: IntegrationContext,
  tenantId: string, channelId: string, userId?: string | null) {
  ensure(ctx.allegroAuthorityForChannel, 403, 'Brak zaufanej zgody wywołującego Allegro');
  const token = await ctx.allegroAuthorityForChannel(c, channelId);
  assertAllegroAuthorityBinding(token, tenantId, channelId, userId);
  await assertAllegroAuthorityInTx(c, token, channelId);
  enlistAllegroAuthorityInTx(c, token);
  if (allegroAuthorityIsJob(token)) await pinAllegroJobSourceInTx(c, token, channelId);
  return token;
}
async function checkAllegroContext(ctx: IntegrationContext, tenantId: string, channelId: string,
  userId?: string | null) {
  return tenantTx(tenantId, c => enlistAllegroContextInTx(c, ctx, tenantId, channelId, userId));
}
function enlistCommit(c: PoolClient, token: AllegroOAuthAuthority, tenantId: string,
  channelId: string, userId?: string | null) {
  assertAllegroAuthorityBinding(token, tenantId, channelId, userId);
  enlistAllegroAuthorityInTx(c, token);
  // HTTP gets no early member/session/key pins: source CAS waits first.
  return allegroAuthorityIsJob(token) ? pinAllegroJobSourceInTx(c, token, channelId) : Promise.resolve();
}
/** Known-response fence is persisted while refresh still holds its advisory lock.
 * It belongs to the same stored job/source connection, not the obsolete lease.
 * New lease/state/plan fields are never overwritten. Plain parent reads take no
 * reverse channel/plan row locks while the actual job row is pinned. */
async function persistAllegroOAuthCommitRefusal(error: Problem) {
  const refusal = allegroOAuthCommitRefusalDetails(error);
  ensure(refusal, 500, 'Brak prywatnego kontekstu odmowy OAuth');
  if (!refusal.jobId) return;
  await tenantTx(refusal.tenantId, async c => {
    const current = (await c.query('SELECT kind,payload FROM jobs WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
      [refusal.tenantId, refusal.jobId])).rows[0];
    if (!current) return; // Deleted job cannot be reclaimed or executed.
    let channelId = current.payload.channel_id;
    if (current.payload.plan_id) {
      const table = current.kind === 'offer.write' ? 'offer_plans' : 'order_status_plans';
      channelId = (await c.query('SELECT channel_id FROM ' + table
        + ' WHERE tenant_id=$1 AND id=$2 AND job_id=$3',
        [refusal.tenantId,current.payload.plan_id,refusal.jobId])).rows[0]?.channel_id;
    }
    ensure(channelId===refusal.channelId,409,'Źródło odmowy OAuth zmieniło się');
    await c.query("UPDATE jobs SET payload=jsonb_set(payload,'{allegro_oauth_commit_refused}',$3::jsonb) "
      + 'WHERE tenant_id=$1 AND id=$2',
      [refusal.tenantId,refusal.jobId,JSON.stringify({channel_id:refusal.channelId,
        connection_id:refusal.connectionId})]);
  });
}
/** A received-token local refusal never enters generic automatic rotation retry. */
export async function stopAllegroOAuthCommitRefusal(job: any, error: unknown): Promise<boolean> {
  const refusal = allegroOAuthCommitRefusalDetails(error);
  if (!refusal) return false;
  ensure(refusal.tenantId === job.tenant_id && refusal.jobId === job.id, 403,
    'Odmowa dotyczy innego zadania');
  await persistAllegroOAuthCommitRefusal(error as Problem); // local persistence only, no provider HTTP
  await tenantTx(job.tenant_id, async c => {
    const current = (await c.query("SELECT kind,payload FROM jobs WHERE id=$1 AND tenant_id=$2 "
      + "AND state='running' AND lease_token=$3 FOR UPDATE",
      [job.id, job.tenant_id, job.lease_token])).rows[0];
    if (!current) return; // New lease is untouched; its known-response fence was already persisted.
    ensure(['orders.sync','offer.write','offer.sync','order.status.write','order.status.scan',
      'payment.source.read','offer.variants']
      .includes(current.kind), 409, 'Nieprawidłowe źródło odmowy OAuth');
    let channelId = current.payload.channel_id;
    if (current.payload.plan_id) {
      const table = current.kind === 'offer.write' ? 'offer_plans' : 'order_status_plans';
      channelId = (await c.query('SELECT channel_id FROM ' + table
        + ' WHERE tenant_id=$1 AND id=$2 AND job_id=$3',
        [job.tenant_id, current.payload.plan_id, job.id])).rows[0]?.channel_id;
    }
    ensure(channelId === refusal.channelId, 409, 'Odmowa dotyczy innego kanału');
    await c.query("UPDATE jobs SET state='failed',lease_token=NULL,locked_at=NULL, "
      + "error='Lokalny zapis tokenów Allegro odmówiony; wymagane ponowne połączenie i ręczne wznowienie', "
      + "payload=jsonb_set(payload,'{allegro_oauth_commit_refused}',$4::jsonb) "
      + "WHERE id=$1 AND tenant_id=$2 AND lease_token=$3 AND state='running'",
      [job.id, job.tenant_id, job.lease_token, JSON.stringify({ channel_id: refusal.channelId,
        connection_id: refusal.connectionId })]);
    // Provider plan phase/results remain untouched.
  });
  return true;
}
export const readScopes = 'allegro:api:orders:read allegro:api:sale:offers:read';
export const orderWriteScope = 'allegro:api:orders:write';
export const offerWriteScope = 'allegro:api:sale:offers:write';
export function oauthConfig(mode: string, ctx: IntegrationContext = {}) {
  if (ctx.oauthConfig) return ctx.oauthConfig(mode);
  const prefix = mode === 'sandbox' ? 'ALLEGRO_SANDBOX' : 'ALLEGRO';
  const config = {
    clientId: process.env[`${prefix}_CLIENT_ID`] ?? '',
    clientSecret: process.env[`${prefix}_CLIENT_SECRET`] ?? '',
    redirectUri:
      process.env[`${prefix}_REDIRECT_URI`] ?? 'http://127.0.0.1:4100/api/oauth/allegro/callback',
  };
  ensure(
    config.clientId && config.clientSecret,
    422,
    `Brak konfiguracji aplikacji OAuth: ${prefix}_CLIENT_ID i ${prefix}_CLIENT_SECRET`,
  );
  const u = new URL(config.redirectUri);
  ensure(
    ['127.0.0.1', 'localhost'].includes(u.hostname) &&
      ['http:', 'https:'].includes(u.protocol) &&
      !u.search &&
      !u.hash &&
      !u.username &&
      !u.password &&
      u.pathname === '/api/oauth/allegro/callback',
    422,
    'Callback OAuth musi wskazywać lokalny serwer aplikacji',
  );
  return config;
}
export async function loadChannel(tenantId: string, id: string) {
  const ch = await tenantTx(
    tenantId,
    async (c) => (await c.query('SELECT * FROM channels WHERE id=$1', [id])).rows[0],
  );
  ensure(ch, 404, 'Nie znaleziono integracji');
  return ch;
}
const base = (mode: string) =>
  mode === 'sandbox' ? 'https://allegro.pl.allegrosandbox.pl' : 'https://allegro.pl';
const tokensSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.number().int().min(1).max(86400),
  scope: z.string().optional(),
});
async function tokens(
  mode: string,
  config: OAuthConfig,
  params: Record<string, string>,
  ctx: IntegrationContext,
) {
  const response = await (ctx.transport ?? safeFetch)(base(mode) + '/auth/oauth/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(params).toString(),
  });
  ensure(response.ok, 502, `OAuth Allegro: HTTP ${response.status}`);
  const body = await response.json().catch(() => {
    throw new Problem(502, 'Nieprawidłowa odpowiedź OAuth Allegro');
  });
  const parsed = tokensSchema.safeParse(body);
  ensure(parsed.success, 502, 'Nieprawidłowa odpowiedź OAuth Allegro');
  return parsed.data;
}
export async function beginOAuth(
  actor: Actor,
  id: string,
  ctx: IntegrationContext = {},
  offersWrite = false,
  ordersWrite = false,
) {
  const ch = await loadChannel(actor.tenantId, id);
  ensure(ch.provider === 'allegro' && !ch.settings.simulation, 422, 'Wymagane połączenie Allegro');
  const scope = [
    readScopes,
    ...(offersWrite ? [offerWriteScope] : []),
    ...(offersWrite ? [allegroSettingsReadScope] : []),
    ...(ordersWrite ? [orderWriteScope] : []),
  ].join(' ');
  const config = oauthConfig(ch.mode, ctx),
    state = randomBytes(32).toString('base64url'),
    verifier = randomBytes(48).toString('base64url');
  await tenantTx(actor.tenantId, async (c) => {
    await enlistAllegroContextInTx(c, ctx, actor.tenantId, id, actor.userId);
    await c.query(
      "INSERT INTO oauth_states(state_hash,tenant_id,channel_id,user_id,verifier,expires_at,scope) VALUES($1,$2,$3,$4,$5,now()+interval '10 minutes',$6)",
      [tokenHash(state), actor.tenantId, id, actor.userId, encrypt({ verifier }), scope],
    );
    await audit(c, actor, 'oauth.start', id, { mode: ch.mode });
  });
  const url = new URL(base(ch.mode) + '/auth/oauth/authorize');
  for (const [k, v] of Object.entries({
    response_type: 'code',
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    state,
    scope: scope,
    code_challenge_method: 'S256',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
  }))
    url.searchParams.set(k, v);
  return { url: url.toString(), expires_in: 600 };
}
export async function finishOAuth(
  actor: Actor,
  state: string,
  code: string,
  ctx: IntegrationContext = {},
) {
  const accepted = await tenantTx(actor.tenantId, async (c) => {
    const own = (await c.query('SELECT channel_id FROM oauth_states WHERE state_hash=$1 AND user_id=$2',
      [tokenHash(state), actor.userId])).rows[0];
    ensure(own, 422, 'Nieprawidłowy, wykorzystany lub wygasły stan OAuth');
    const authority = await enlistAllegroContextInTx(c, ctx, actor.tenantId, own.channel_id, actor.userId);
    const row = (
      await c.query(
        'UPDATE oauth_states SET consumed_at=now() WHERE state_hash=$1 AND user_id=$2 AND consumed_at IS NULL AND expires_at>now() RETURNING *',
        [tokenHash(state), actor.userId],
      )
    ).rows[0];
    ensure(row, 422, 'Nieprawidłowy, wykorzystany lub wygasły stan OAuth');
    return { pending: row, authority };
  });
  const { pending, authority } = accepted;
  const ch = await loadChannel(actor.tenantId, pending.channel_id),
    config = oauthConfig(ch.mode, ctx);
  ensure(ch.provider === 'allegro' && !ch.settings.simulation, 422, 'Wymagane połączenie Allegro');
  const recovery = await beginAllegroRecovery(ch, authority, 'authorization_code');
  let result: z.infer<typeof tokensSchema>;
  try {
    result = await tokens(ch.mode, config, { grant_type: 'authorization_code', code,
      redirect_uri: config.redirectUri, code_verifier: decrypt(pending.verifier).verifier }, ctx);
  } catch {
    await refuseAllegroRecovery(recovery, 'response_unknown');
    throw allegroRecoveryRequired(recovery);
  }
  try {
    await tenantTx(actor.tenantId, async (c) => {
      await enlistCommit(c, authority, actor.tenantId, ch.id, actor.userId);
      // The token exchange happens outside this transaction. Recheck the captured
      // connection identity on the UPDATE itself, including after a row-lock wait.
      // A refresh of that same connection must not invalidate a legitimate reconnect.
      const saved = await c.query(
        `UPDATE channels SET credentials=$1,token_expires_at=now()+make_interval(secs=>$2),status='authorized_read',oauth_scopes=$4,settings=jsonb_set(settings,'{oauth_connection_id}',to_jsonb($5::text))
         WHERE id=$3 AND tenant_id=$6 AND provider='allegro' AND mode=$7
         AND coalesce(settings->'simulation','false'::jsonb)=$8::jsonb
         AND settings->'oauth_connection_id' IS NOT DISTINCT FROM $9::jsonb`,
        [
          encrypt({ access_token: result.access_token, refresh_token: result.refresh_token }),
          result.expires_in,
          ch.id,
          result.scope ?? pending.scope,
          randomUUID(),
          actor.tenantId,
          ch.mode,
          JSON.stringify(ch.settings.simulation === undefined ? false : ch.settings.simulation),
          ch.settings.oauth_connection_id === undefined
            ? null
            : JSON.stringify(ch.settings.oauth_connection_id),
        ],
      );
      ensure(saved.rowCount === 1, 409, 'Połączenie Allegro zmieniło się podczas autoryzacji');
      await commitAllegroRecoveryInTx(c, recovery);
      await audit(c, actor, 'oauth.connected', ch.id, { scope: result.scope ?? pending.scope });
    });
  } catch (error) {
    await refuseAllegroRecovery(recovery, 'local_commit_refused');
    throw allegroOAuthCommitRefusal(error, { tenantId: actor.tenantId, channelId: ch.id,
      connectionId: ch.settings.oauth_connection_id ?? null }, authority);
  }
  return { id: ch.id, status: 'authorized_read' };
}
export async function refreshOAuth(
  tenantId: string,
  id: string,
  expectedToken: string | undefined,
  ctx: IntegrationContext = {},
) {
  const lock = lockDbClient(new pg.Client({ connectionString: pool.options.connectionString }), 'channel-access'),
    key = `oauth:${tenantId}:${id}`;
  await lock.connect();
  try {
    return await holdingDbLock(lock, async () => {
    await lock.query("SET statement_timeout='15s'");
    await lock.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [key]);
    const ch = await loadChannel(tenantId, id),
      creds = decrypt(ch.credentials);
    ensure(
      ch.provider === 'allegro' && !ch.settings.simulation,
      422,
      'Wymagane połączenie Allegro',
    );
    const authority = await checkAllegroContext(ctx, tenantId, id);
    // Another process may have already rotated the one-use refresh token while this caller waited.
    if (expectedToken && creds.access_token !== expectedToken) return ch;
    if (
      !expectedToken &&
      ch.token_expires_at &&
      new Date(ch.token_expires_at).getTime() > Date.now() + 60000
    )
      return ch;
    ensure(
      ch.provider === 'allegro' && creds.refresh_token,
      401,
      'Połącz ponownie konto Allegro przez OAuth',
    );
    const recovery = await beginAllegroRecovery(ch, authority, 'refresh_token');
    let result: z.infer<typeof tokensSchema>;
    try {
      result = await tokens(ch.mode, oauthConfig(ch.mode, ctx),
        { grant_type: 'refresh_token', refresh_token: creds.refresh_token }, ctx);
    } catch {
      await refuseAllegroRecovery(recovery, 'response_unknown');
      throw allegroRecoveryRequired(recovery);
    }
    try {
      await tenantTx(tenantId, async (c) => {
        await enlistCommit(c, authority, tenantId, id);
        const saved = await c.query(
          `UPDATE channels SET credentials=$1,token_expires_at=now()+make_interval(secs=>$2),oauth_scopes=coalesce($4,oauth_scopes)
           WHERE id=$3 AND tenant_id=$5 AND provider='allegro' AND mode=$6
           AND credentials=$7 AND coalesce(settings->'simulation','false'::jsonb)=$8::jsonb
           AND settings->'oauth_connection_id' IS NOT DISTINCT FROM $9::jsonb
           AND oauth_scopes IS NOT DISTINCT FROM $10::text`,
          [
            encrypt({
              ...creds,
              access_token: result.access_token,
              refresh_token: result.refresh_token,
            }),
            result.expires_in,
            id,
            result.scope ?? null,
            tenantId,
            ch.mode,
            ch.credentials,
            JSON.stringify(ch.settings.simulation === undefined ? false : ch.settings.simulation),
            ch.settings.oauth_connection_id === undefined
              ? null
              : JSON.stringify(ch.settings.oauth_connection_id),
            ch.oauth_scopes,
          ],
        );
        ensure(saved.rowCount === 1, 409, 'Połączenie Allegro zmieniło się podczas odświeżania');
        await commitAllegroRecoveryInTx(c, recovery);
      });
    } catch (error) {
      await refuseAllegroRecovery(recovery, 'local_commit_refused');
      const refusal = allegroOAuthCommitRefusal(error, { tenantId, channelId: id,
        connectionId: ch.settings.oauth_connection_id ?? null }, authority);
      // Reclaim can change lease during HTTP. Persist the same-job fence BEFORE
      // finally releases the channel advisory lock; next refresh remints its
      // source authority only AFTER acquiring that lock, then sees the marker.
      try { await persistAllegroOAuthCommitRefusal(refusal); }
      catch { throw allegroOAuthCommitRefusal(new Problem(503,
        'Nie potwierdzono trwałego fence odmowy OAuth; wymagane ręczne odzyskiwanie'),
        { tenantId, channelId: id, connectionId: ch.settings.oauth_connection_id ?? null }, authority); }
      throw refusal;
    }
    return loadChannel(tenantId, id);
    });
  } finally {
    await lock.end();
  }
}
export async function refreshEbayOAuth(
  tenantId: string,
  id: string,
  expectedToken: string | undefined,
  ctx: IntegrationContext = {},
  validate?: (ch: any) => void | Promise<void>,
) {
  const lock = lockDbClient(new pg.Client({ connectionString: pool.options.connectionString }), 'channel-access');
  await lock.connect();
  try {
    return await holdingDbLock(lock, async () => {
    await lock.query("SET statement_timeout='15s'");
    await lock.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [
      `ebay-oauth:${tenantId}:${id}`,
    ]);
    const ch = await loadChannel(tenantId, id),
      creds = decrypt(ch.credentials);
    ensure(
      ch.provider === 'ebay' && !ch.settings.simulation,
      422,
      'Wymagane rzeczywiste połączenie eBay',
    );
    await validate?.(ch);
    ensure(
      !ch.settings.oauth_refresh_expires_at ||
        Date.parse(ch.settings.oauth_refresh_expires_at) > Date.now(),
      401,
      'Zgoda eBay wygasła; połącz ponownie konto przez OAuth',
    );
    if (expectedToken && creds.access_token !== expectedToken && ebayScopesMatch(ch)) return ch;
    if (
      !expectedToken &&
      ebayScopesMatch(ch) &&
      creds.access_token &&
      ch.token_expires_at &&
      new Date(ch.token_expires_at).getTime() > Date.now() + 60000
    )
      return ch;
    const result = await refreshEbay(
      ch.mode,
      creds,
      ctx.transport ?? safeFetch,
      ebayReadScopes(ch.settings),
    );
    await validate?.(ch);
    await tenantTx(tenantId, async (c) => {
      const current = (await c.query('SELECT * FROM channels WHERE id=$1 FOR UPDATE', [id]))
        .rows[0];
      ensure(
        current &&
          ebayConnectionHash(current) === ebayConnectionHash(ch) &&
          decrypt(current.credentials).access_token === creds.access_token,
        409,
        'Połączenie eBay zmieniło się podczas autoryzacji',
      );
      await c.query(
        'UPDATE channels SET credentials=$1,token_expires_at=now()+make_interval(secs=>$2),oauth_scopes=$3 WHERE id=$4',
        [
          encrypt({ ...creds, access_token: result.access_token }),
          result.expires_in,
          ebayReadScopes(ch.settings),
          id,
        ],
      );
    });
    return loadChannel(tenantId, id);
    });
  } finally {
    await lock.end();
  }
}
export async function channelRead<T>(
  tenantId: string,
  id: string,
  read: (client: ReturnType<typeof connector>) => Promise<T>,
  ctx: IntegrationContext = {},
  replayOnUnauthorized = true,
  validateConnection?: (channel: any) => void | Promise<void>,
) {
  let ch = await loadChannel(tenantId, id);
  ensure(!ch.settings.simulation, 422, 'To połączenie zawiera wyłącznie lokalny przykład');
  if (ch.provider === 'allegro') await checkAllegroContext(ctx, tenantId, id);
  if (['ebay', 'shopify'].includes(ch.provider)) await validateConnection?.(ch);
  if (ch.provider === 'shopify') {
    await tenantTx(tenantId, (c) => shopifyAccountPolicy(c, ch));
    if (
      decrypt(ch.credentials).oauth_grant_id &&
      (!ch.token_expires_at || new Date(ch.token_expires_at).getTime() <= Date.now() + 60000)
    )
      ch = await refreshShopifyOAuth(tenantId, id, undefined, ctx, validateConnection);
  }
  if (
    ch.provider === 'ebay' &&
    (!ebayScopesMatch(ch) ||
      !decrypt(ch.credentials).access_token ||
      !ch.token_expires_at ||
      new Date(ch.token_expires_at).getTime() <= Date.now() + 60000)
  )
    ch = await refreshEbayOAuth(tenantId, id, undefined, ctx, validateConnection);
  if (
    ch.provider === 'allegro' &&
    ch.token_expires_at &&
    new Date(ch.token_expires_at).getTime() <= Date.now() + 60000
  )
    ch = await refreshOAuth(tenantId, id, undefined, ctx);
  await validateConnection?.(ch);
  const creds = decrypt(ch.credentials);
  if (ch.provider === 'amazon') await tenantTx(tenantId, (c) => amazonAccountPolicy(c, ch));
  if (ch.provider === 'allegro')
    ensure(creds.access_token, 422, 'Połącz konto Allegro przez OAuth');
  const invoke = async (current: typeof ch, credentials: Record<string, string>) => {
    if (current.provider === 'allegro') await checkAllegroContext(ctx, tenantId, id);
    const client = connector(
      current.provider,
      current.mode,
      current.settings,
      credentials,
      ['amazon', 'shopify'].includes(current.provider)
        ? async (url, init) => {
            await tenantTx(tenantId, async (c) => {
              const latest = (await c.query('SELECT * FROM channels WHERE id=$1', [id])).rows[0];
              if (current.provider === 'amazon') await amazonAccountPolicy(c, latest);
              else await shopifyAccountPolicy(c, latest);
              ensure(
                current.provider === 'shopify'
                  ? shopifyGrantHash(latest) === shopifyGrantHash(current)
                  : latest.credentials === current.credentials,
                409,
                'Grant konta zmienił się podczas żądania',
              );
            });
            await validateConnection?.(current);
            return (ctx.transport ?? safeFetch)(url, init);
          }
        : ctx.transport,
    );
    try {
      const value = await read(client);
      if (current.provider === 'allegro') await checkAllegroContext(ctx, tenantId, id);
      return value;
    } finally {
      if (client instanceof Ebay) await client.releaseMutation().catch(() => {});
    }
  };
  try {
    return await invoke(ch, creds);
  } catch (e) {
    if (!(
      e instanceof Problem &&
      e.status === 401 &&
      ((ch.provider === 'allegro' && e.code === 'PROVIDER_HTTP_UNAUTHORIZED') || ch.provider === 'ebay' ||
        (ch.provider === 'shopify' && !!creds.oauth_grant_id))
    ))
      throw e;
    const renewed =
      ch.provider === 'shopify'
        ? await refreshShopifyOAuth(tenantId, id, creds.access_token, ctx, validateConnection)
        : ch.provider === 'ebay'
          ? await refreshEbayOAuth(tenantId, id, creds.access_token, ctx, validateConnection)
          : await refreshOAuth(tenantId, id, creds.access_token, ctx);
    // A write callback may have already changed the provider before a later GET failed.
    // Let its durable job reload the recorded phase instead of replaying the callback.
    if (!replayOnUnauthorized)
      throw new Problem(502, 'Token odświeżony; wynik zapisu zostanie ponownie odczytany');
    await validateConnection?.(renewed);
    return invoke(renewed, decrypt(renewed.credentials));
  }
}
