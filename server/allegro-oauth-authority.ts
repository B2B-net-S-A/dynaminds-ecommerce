import { drainPublicConstraintsInTx } from './public-constraint-drain';
import {assertNoFinancialReturn162AdmissionInTx} from './financial-return-completion';
// Trusted OAuth caller context. Wiring patch remains authored-only until applied.
// Root must wire begin/end and terminal AFTER all sibling finalizers. This file
// deliberately imports no pool, starts no transaction, and sends no HTTP.
// Job source pins use NOWAIT: current native config/job/channel orders differ.
// A conflict refuses the local commit; it NEVER retries a token HTTP request.
import { assertNoCatalogStockCountTerminalInTx } from './catalog-stock-control-transaction';
import type { FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { ensure, Problem } from './errors';
import { tokenHash } from './security';
import { requireWorkspaceMfa } from './mfa-policy';

// db imports this registry during startup. Load native descriptors/hash helpers
// only from authenticated factories, after the application graph is initialized.
let nativeOfferConnectionHash: typeof import('./offer-sync-policy')['offerConnectionHash'] | undefined;
let nativeStatusConnection: typeof import('./order-status')['statusConnection'] | undefined;

declare const authorityBrand: unique symbol;
export type AllegroOAuthAuthority = Readonly<{ [authorityBrand]: true }>;
export type AllegroAuthoritySecurity = Readonly<{
  accountSecurityAvailable: boolean;
  workspaceMfaPolicyAvailable: boolean;
  readOnly: boolean;
}>;
type Base = { tenantId: string; userId: string; channelId: string;
  security: AllegroAuthoritySecurity };
type SessionFrame = Base & { kind: 'session'; sessionHash: string };
type KeyFrame = Base & { kind: 'api_key'; keyId: string; keyHash: string;
  scopes: readonly string[] };
type JobKind = 'orders.sync' | 'offer.write' | 'offer.sync'
  | 'order.status.write' | 'order.status.scan' | 'payment.source.read' | 'offer.variants';
type JobFrame = Base & { kind: 'job'; jobId: string; leaseToken: string;
  jobKind: JobKind; payload: string; planId: string | null;
  config: 'offer' | 'status' | 'payment' | null; configVersion: number | null;
  batchId: string | null; orderId: string | null;
  /** offer.write / order.status.write whose plan already left 'ready' (write_started, or verify with an operation
   * Allegro accepted): the job only reads and reconciles the result (offers.ts accept_observed, order-status
   * non-ready path), so a paused or changed config (enabled, external_authorized, version) does not cut it off.
   * Actor, lease, plan and connection pins stay; a plan still 'ready' (a new write) needs the current config. */
  startedWrite: boolean };
type Frame = SessionFrame | KeyFrame | JobFrame;
/** Plan phases after the provider write began: only reading and reconciling follow. */
const STARTED_WRITE: readonly string[] = ['write_started', 'verify'];
type TxState = { authorities: Set<AllegroOAuthAuthority>;
  jobPins: Set<AllegroOAuthAuthority>; frozen: boolean; completed: boolean };
const custody = new WeakMap<AllegroOAuthAuthority, Readonly<Frame>>();
const registry = new WeakMap<PoolClient, TxState>();
/** Presence only; never authorization, admission or transaction readiness. */
export function hasAllegroAuthorityTransactionDuty(c:PoolClient){return Boolean(registry.get(c)?.authorities.size || registry.get(c)?.jobPins.size);}
const uuid = z.uuid();
const securitySchema = z.object({ accountSecurityAvailable: z.boolean(),
  workspaceMfaPolicyAvailable: z.boolean(), readOnly: z.boolean() }).strict();

function issue(frame: Frame): AllegroOAuthAuthority {
  // No private fields on the public token. No mutable arrays escape the registry.
  const token = Object.freeze({}) as AllegroOAuthAuthority;
  const security = Object.freeze({ ...frame.security });
  const value = frame.kind === 'api_key'
    ? Object.freeze({ ...frame, security, scopes: Object.freeze([...frame.scopes]) })
    : Object.freeze({ ...frame, security });
  custody.set(token, value);
  return token;
}
function frame(token: AllegroOAuthAuthority, channelId?: string): Readonly<Frame> {
  const f = custody.get(token);
  ensure(f && (!channelId || f.channelId === channelId), 403,
    'Brak zaufanej zgody wywołującego Allegro');
  return f;
}
function state(c: PoolClient): TxState {
  const s = registry.get(c);
  ensure(s && !s.frozen, 500, 'OAuth wymaga otwartej zarządzanej transakcji');
  return s;
}
export function beginAllegroAuthorityTransaction(c: PoolClient) {
  ensure(!registry.has(c), 500, 'Kontekst OAuth transakcji już istnieje');
  registry.set(c, { authorities: new Set(), jobPins: new Set(), frozen: false, completed: false });
}
export function endAllegroAuthorityTransaction(c: PoolClient) { registry.delete(c); }
export function enlistAllegroAuthorityInTx(c: PoolClient, token: AllegroOAuthAuthority) {
  frame(token); assertNoCatalogStockCountTerminalInTx(c);
  assertNoFinancialReturn162AdmissionInTx(c);
  state(c).authorities.add(token); return token;
}

/** Called only by a route after native authentication; never from request body. */
export async function allegroAuthorityForRequest(req: FastifyRequest, cookieName: string,
  channelId: string, security: AllegroAuthoritySecurity): Promise<AllegroOAuthAuthority> {
  const a = req.actor;
  ensure(a?.userId && a.tenantId, 401, 'Zaloguj się do systemu');
  uuid.parse(a.userId); uuid.parse(a.tenantId); uuid.parse(channelId);
  const checkedSecurity = securitySchema.parse(security);
  // Even GET can rotate credentials. No provider traffic in restored preview.
  ensure(!checkedSecurity.readOnly, 423, 'Połączenia z Allegro są wyłączone w podglądzie kopii');
  const bearer = req.headers.authorization?.startsWith('Bearer ')
    ? req.headers.authorization.slice(7) : undefined;
  if (a.apiKeyId) {
    ensure(a.source === 'api' && bearer && /^dyna_api_[a-f0-9]{64}$/.test(bearer),
      401, 'Nieprawidłowy kontekst klucza API');
    const path = req.url.split('?')[0];
    const { publicOperations } = await import('./developer-api');
    const descriptor = publicOperations.find(o =>
      (o.method === req.method || (req.method === 'HEAD' && o.method === 'GET')) &&
      new RegExp('^/api/v1' + o.path.replace(/:[a-z_]+/g, '[^/]+') + '$').test(path));
    ensure(descriptor, 403, 'Brak publicznego kontraktu tej operacji');
    const scopes = /^\/api\/v1\/import-external-intent-previews\/[^/]+\/execute$/.test(path)
      ? ['integrations:read','products:read','inventory:read','orders:read','purchasing:read',
        'integrations:write','inventory:write','orders:write','purchasing:write']
      : [descriptor.scope]; // exact additional native B2B execute requirements
    return issue({ kind: 'api_key', tenantId: a.tenantId, userId: a.userId,
      channelId, security: checkedSecurity, keyId: uuid.parse(a.apiKeyId),
      keyHash: tokenHash(bearer), scopes });
  }
  const token = req.cookies[cookieName] ?? bearer;
  ensure(token && !token.startsWith('dyna_api_'), 401, 'Sesja wygasła');
  return issue({ kind: 'session', tenantId: a.tenantId, userId: a.userId,
    channelId, security: checkedSecurity, sessionHash: tokenHash(token) });
}

async function owner<T>(c: PoolClient, tenantId: string,
  fn: () => Promise<T>): Promise<T> {
  const ctx = (await c.query(`SELECT current_user AS role, session_user AS owner,
    current_setting('app.tenant_id',true) AS tenant`)).rows[0];
  ensure(ctx.owner === 'postgres' && ['postgres', 'dyna_app'].includes(ctx.role)
    && ctx.tenant === tenantId, 403, 'Nieprawidłowy kontekst zgody Allegro');
  const switched = ctx.role === 'dyna_app';
  let failed = false;
  try {
    if (switched) await c.query('RESET ROLE');
    return await fn();
  } catch (e) {
    failed = true;
    if (e instanceof Problem) throw e;
    const code = (e as { code?: string })?.code;
    if (code === '55P03') throw new Problem(409,
      'Źródło zadania Allegro jest obecnie zmieniane; lokalny zapis wstrzymano',
      'ALLEGRO_OAUTH_SOURCE_BUSY');
    if (['55000', '42P01', '42703', '42883', '42501'].includes(code ?? ''))
      throw new Problem(503, 'Moduł autoryzacji jest niekompletny');
    throw e;
  } finally {
    if (switched) {
      // Do not mask the original SQL error with 25P02 on an aborted transaction.
      if (failed) { try { await c.query('SET LOCAL ROLE dyna_app'); } catch { /* caller rolls back */ } }
      else await c.query('SET LOCAL ROLE dyna_app');
    }
  }
}
async function securityGraph(c: PoolClient, security: AllegroAuthoritySecurity) {
  const p = (await c.query(`SELECT
    to_regclass('public.account_security') IS NOT NULL AS account,
    to_regclass('public.workspace_security_policies') IS NOT NULL AS mfa,
    EXISTS(SELECT 1 FROM public.migrations WHERE name='051_account_security') AS account_ledger,
    EXISTS(SELECT 1 FROM public.migrations WHERE name='057_workspace_mfa') AS mfa_ledger`)).rows[0];
  ensure(p.account === security.accountSecurityAvailable && p.mfa === security.workspaceMfaPolicyAvailable
    && (!p.account_ledger || p.account) && (!p.mfa_ledger || (p.mfa && p.account)),
    503, 'Moduł autoryzacji zmienił się lub jest niekompletny');
  ensure(!security.workspaceMfaPolicyAvailable || security.accountSecurityAvailable,
    503, 'Niekompletny moduł MFA');
}
async function channel(c: PoolClient, f: Base, pin = false) {
  const ch = (await c.query(`SELECT id,tenant_id,provider,mode,settings,oauth_scopes,
    sync_enabled,sync_actor_id FROM public.channels WHERE tenant_id=$1 AND id=$2`
    + (pin ? ' FOR NO KEY UPDATE NOWAIT' : ''), [f.tenantId, f.channelId])).rows[0];
  ensure(ch, 404, 'Nie znaleziono integracji');
  ensure(ch.provider === 'allegro' && !ch.settings?.simulation, 422,
    'Wymagane rzeczywiste połączenie Allegro');
  return ch;
}

/** Factory reads the actual stored job; caller provides identity/lease, not actor/scopes. */
export async function allegroAuthorityForJobInTx(c: PoolClient,
  job: Readonly<{ id: string; tenant_id: string; lease_token: string }>,
  channelId: string, security: AllegroAuthoritySecurity): Promise<AllegroOAuthAuthority> {
  uuid.parse(job.id); uuid.parse(job.tenant_id); uuid.parse(job.lease_token); uuid.parse(channelId);
  const checkedSecurity = securitySchema.parse(security);
  return owner(c, job.tenant_id, async () => {
    ensure(!checkedSecurity.readOnly, 423, 'Połączenia z Allegro są wyłączone w podglądzie kopii');
    await securityGraph(c, checkedSecurity);
    const current = (await c.query(`SELECT id,tenant_id,kind,payload,lease_token,state
      FROM public.jobs WHERE tenant_id=$1 AND id=$2`, [job.tenant_id, job.id])).rows[0];
    ensure(current && current.state === 'running' && current.lease_token === job.lease_token,
      409, 'Dzierżawa zadania Allegro została utracona');
    const kind = z.enum(['orders.sync','offer.write','offer.sync',
      'order.status.write','order.status.scan','payment.source.read','offer.variants']).parse(current.kind);
    const userId = uuid.parse(current.payload.actor_id);
    const planId = ['offer.write','order.status.write'].includes(kind)
      ? uuid.parse(current.payload.plan_id) : null;
    let config: JobFrame['config'] = kind === 'offer.sync' ? 'offer'
      : kind === 'order.status.scan' ? 'status'
      : kind === 'payment.source.read' && current.payload.automatic ? 'payment' : null;
    let configVersion: number | null = config === 'payment' ? current.payload.config_version
      : config ? current.payload.version : null;
    const batchId = kind === 'offer.variants' ? uuid.parse(current.payload.batch_id) : null;
    const orderId = kind === 'payment.source.read' ? uuid.parse(current.payload.order_id) : null;
    let startedWrite = false;
    if (planId) {
      const table = kind === 'offer.write' ? 'offer_plans' : 'order_status_plans';
      const versionColumn = kind === 'offer.write' ? 'sync_version' : 'config_version';
      const p = (await c.query(`SELECT actor_id,channel_id,job_id,state,phase,${versionColumn} AS version
        FROM public.${table} WHERE tenant_id=$1 AND id=$2`, [job.tenant_id, planId])).rows[0];
      ensure(p && p.actor_id === userId && p.channel_id === channelId
        && p.job_id === current.id && p.state === 'queued', 409, 'Źródło zadania Allegro zmieniło się');
      if (p.version != null) {
        config = kind === 'offer.write' ? 'offer' : 'status'; configVersion = p.version;
      }
      startedWrite = STARTED_WRITE.includes(p.phase);
    } else ensure(current.payload.channel_id === channelId, 409, 'Zadanie dotyczy innego kanału');
    if (batchId) {
      const b = (await c.query('SELECT actor_id,channel_id,job_id,state FROM public.variant_offer_batches '
        + 'WHERE tenant_id=$1 AND id=$2', [job.tenant_id,batchId])).rows[0];
      ensure(b && b.actor_id===userId && b.channel_id===channelId && b.job_id===current.id
        && ['preparing','queued'].includes(b.state),409,'Źródło operacji ofert zmieniło się');
    }
    if (orderId) ensure((await c.query('SELECT id FROM public.orders WHERE tenant_id=$1 AND id=$2 AND channel_id=$3',
      [job.tenant_id,orderId,channelId])).rowCount,409,'Źródło płatności dotyczy innego zamówienia');
    ensure(configVersion === null || (Number.isSafeInteger(configVersion) && configVersion > 0),
      409, 'Nieprawidłowa wersja źródła zadania');
    if (config === 'offer' || batchId)
      nativeOfferConnectionHash ??= (await import('./offer-sync-policy')).offerConnectionHash;
    if (config === 'status' || kind === 'payment.source.read')
      nativeStatusConnection ??= (await import('./order-status')).statusConnection;
    const authority = issue({ kind: 'job', tenantId: job.tenant_id, userId, channelId,
      security: checkedSecurity, jobId: current.id, leaseToken: current.lease_token,
      jobKind: kind, payload: JSON.stringify(current.payload), planId, config, configVersion, batchId, orderId,
      startedWrite });
    const refused = current.payload.allegro_oauth_commit_refused;
    if (refused) {
      const marker = z.object({ channel_id: uuid, connection_id: uuid.nullable() }).strict().parse(refused);
      ensure(marker.channel_id === channelId, 409, 'Odmowa dotyczy innego źródła zadania');
      const source = await channel(c, { tenantId: job.tenant_id, userId, channelId,
        security: checkedSecurity });
      if ((source.settings?.oauth_connection_id ?? null) === marker.connection_id)
        // The replacement lease must reach the special worker terminal branch,
        // not ordinary pending retry. Custody derives from the actual stored job.
        throw allegroOAuthCommitRefusal(new Problem(409,
          'Poprzedni zapis tokenów był niepewny; połącz konto ponownie przed ręcznym wznowieniem zadania'),
          { tenantId: job.tenant_id, channelId, connectionId: marker.connection_id }, authority);
    }
    return authority;
  });
}
async function jobSource(c: PoolClient, f: JobFrame, pin: boolean) {
  // Native offer config order is config -> job -> plan. Status config has
  // channel -> config -> job elsewhere: ALL source pins below are NOWAIT to
  // refuse a conflict instead of forming that cycle. No token HTTP retry.
  let cfg: any;
  if (f.config) {
    const table = f.config === 'offer' ? 'offer_sync_configs'
      : f.config === 'payment' ? 'source_payment_configs' : 'order_status_configs';
    cfg = (await c.query(`SELECT actor_id,enabled,version,external_authorized,connection_hash
      FROM public.${table} WHERE tenant_id=$1 AND channel_id=$2`
      + (pin ? ' FOR SHARE NOWAIT' : ''), [f.tenantId, f.channelId])).rows[0];
    ensure(cfg && (f.startedWrite || (cfg.enabled && cfg.external_authorized && cfg.version === f.configVersion))
      && cfg.actor_id === f.userId, 409, 'Konfigurację zadania Allegro wyłączono lub zmieniono');
  }
  const j = (await c.query(`SELECT kind,payload,state,lease_token FROM public.jobs
    WHERE tenant_id=$1 AND id=$2` + (pin ? ' FOR NO KEY UPDATE NOWAIT' : ''),
    [f.tenantId, f.jobId])).rows[0];
  ensure(j && j.state === 'running' && j.lease_token === f.leaseToken
    && j.kind === f.jobKind && JSON.stringify(j.payload) === f.payload,
    409, 'Dzierżawa lub źródło zadania Allegro zmieniło się');
  if (f.planId) {
    const table = f.jobKind === 'offer.write' ? 'offer_plans' : 'order_status_plans';
    const column = f.jobKind === 'offer.write' ? 'sync_version' : 'config_version';
    const p = (await c.query(`SELECT actor_id,channel_id,job_id,state,phase,${column} AS version
      FROM public.${table} WHERE tenant_id=$1 AND id=$2` + (pin ? ' FOR SHARE NOWAIT' : ''),
      [f.tenantId, f.planId])).rows[0];
    ensure(p && p.actor_id === f.userId && p.channel_id === f.channelId
      && p.job_id === f.jobId && p.state === 'queued' && p.version === f.configVersion
      && (!f.startedWrite || STARTED_WRITE.includes(p.phase)),
      409, 'Plan zadania Allegro zmienił się');
  }
  if (f.batchId) {
    const b = (await c.query('SELECT actor_id,channel_id,job_id,state,connection_hash FROM public.variant_offer_batches '
      + 'WHERE tenant_id=$1 AND id=$2' + (pin ? ' FOR SHARE NOWAIT' : ''), [f.tenantId,f.batchId])).rows[0];
    ensure(b && b.actor_id===f.userId && b.channel_id===f.channelId && b.job_id===f.jobId
      && ['preparing','queued'].includes(b.state),409,'Źródło operacji ofert zmieniło się');
    const ch = await channel(c,f,pin);
    ensure(b.connection_hash===nativeOfferConnectionHash!(ch),409,'Połączenie operacji ofert zmieniło się');
  }
  if (f.orderId) ensure((await c.query('SELECT id FROM public.orders WHERE tenant_id=$1 AND id=$2 AND channel_id=$3'
    + (pin ? ' FOR SHARE NOWAIT' : ''), [f.tenantId,f.orderId,f.channelId])).rowCount,
    409,'Źródło płatności dotyczy innego zamówienia');
  const ch = await channel(c, f, pin);
  if (f.jobKind==='payment.source.read')
    ensure(JSON.parse(f.payload).connection_hash===nativeStatusConnection!(ch),409,'Połączenie źródła płatności zmieniło się');
  if (cfg) ensure(cfg.connection_hash ===
    (f.config === 'offer' ? nativeOfferConnectionHash!(ch) : nativeStatusConnection!(ch)),
    409, 'Połączenie skonfigurowanego zadania Allegro zmieniło się');
  // No invented jobs.expires_at. Actual native lease/reclaim fields are used.
  // orders.sync can be explicitly queued while sync_enabled=false: do not add
  // a new blanket sync_enabled or sync_actor_id restriction here.
}
/** AFTER HTTP, BEFORE CAS. Session/key get no early IAM pins. */
export async function pinAllegroJobSourceInTx(c: PoolClient,
  token: AllegroOAuthAuthority, channelId: string) {
  const f = frame(token, channelId), s = state(c);
  ensure(f.kind === 'job', 403, 'Wymagana zgoda rzeczywistego zadania');
  assertNoCatalogStockCountTerminalInTx(c);
  await owner(c, f.tenantId, async () => { await securityGraph(c, f.security); await jobSource(c, f, true); });
  s.jobPins.add(token); s.authorities.add(token);
}

async function pinIdentities(c: PoolClient, frames: readonly Readonly<Frame>[]) {
  // Class-wise order, not actor1 -> tenant -> actor2 (native actor2 security
  // could otherwise hold user2 and wait on our tenant anchor).
  for (const userId of [...new Set(frames.map(f => f.userId))].sort())
    ensure((await c.query('SELECT id FROM public.users WHERE id=$1 FOR SHARE',
      [userId])).rowCount, 401, 'Konto nie istnieje');
  const sessions = frames.filter((f): f is Readonly<SessionFrame> => f.kind === 'session')
    .sort((a,b) => a.sessionHash.localeCompare(b.sessionHash));
  for (const f of sessions)
    ensure((await c.query(`SELECT token_hash FROM public.sessions
      WHERE token_hash=$1 AND user_id=$2 AND tenant_id=$3 FOR SHARE`,
      [f.sessionHash, f.userId, f.tenantId])).rowCount, 401, 'Sesja wygasła');
  for (const tenantId of [...new Set(frames.map(f => f.tenantId))].sort())
    ensure((await c.query('SELECT id FROM public.tenants WHERE id=$1 FOR SHARE',
      [tenantId])).rowCount, 403, 'Brak dostępu do organizacji');
  // Actual current native writers use user/tenant anchors. Also pin existing
  // policy rows directly; missing rows are protected by those anchors.
  for (const userId of [...new Set(frames.filter(f => f.security.accountSecurityAvailable)
    .map(f => f.userId))].sort())
    await c.query('SELECT user_id FROM public.account_security WHERE user_id=$1 FOR SHARE', [userId]);
  for (const tenantId of [...new Set(frames.filter(f => f.security.workspaceMfaPolicyAvailable)
    .map(f => f.tenantId))].sort())
    await c.query('SELECT tenant_id FROM public.workspace_security_policies WHERE tenant_id=$1 FOR SHARE', [tenantId]);
  for (const f of [...frames].sort((a,b) => a.userId.localeCompare(b.userId)))
    await c.query('SELECT role FROM public.memberships WHERE tenant_id=$1 AND user_id=$2 FOR SHARE',
      [f.tenantId, f.userId]);
  const keys = frames.filter((f): f is Readonly<KeyFrame> => f.kind === 'api_key')
    .sort((a,b) => a.keyId.localeCompare(b.keyId));
  for (const f of keys) await c.query(`SELECT id FROM public.api_keys
    WHERE tenant_id=$1 AND id=$2 FOR SHARE`, [f.tenantId, f.keyId]);
}
async function currentIdentity(c: PoolClient, f: Frame, clock: string) {
  const accountJoin = f.security.accountSecurityAvailable
    ? 'LEFT JOIN public.account_security a ON a.user_id=u.id' : '';
  const policyJoin = f.security.workspaceMfaPolicyAvailable
    ? 'LEFT JOIN public.workspace_security_policies p ON p.tenant_id=t.id' : '';
  const sessionVersion = f.security.accountSecurityAvailable
    ? 'AND s.account_version=coalesce(a.version,0)' : '';
  if (f.kind === 'session') {
    const current = (await c.query(`SELECT m.role${f.security.workspaceMfaPolicyAvailable
      ? `,coalesce(p.require_mfa,false) AND NOT (a.enabled_at IS NOT NULL
        AND s.mfa_verified_at IS NOT NULL AND s.mfa_verified_at>$4::timestamptz-interval '8 hours') AS mfa_required` : ''}
      FROM public.sessions s JOIN public.users u ON u.id=s.user_id
      JOIN public.tenants t ON t.id=s.tenant_id ${accountJoin} ${policyJoin}
      LEFT JOIN public.memberships m ON (m.tenant_id,m.user_id)=(s.tenant_id,s.user_id)
      WHERE s.token_hash=$1 AND s.user_id=$2 AND s.tenant_id=$3
      AND s.expires_at>$4::timestamptz ${sessionVersion}`,
      [f.sessionHash, f.userId, f.tenantId, clock])).rows[0];
    ensure(current, 401, 'Sesja wygasła lub została unieważniona');
    ensure(current.role === 'admin', 403, 'Wymagana aktualna rola administratora');
    requireWorkspaceMfa(current);
  } else if (f.kind === 'api_key') {
    const current = (await c.query(`SELECT k.scopes,m.role${f.security.workspaceMfaPolicyAvailable
      ? ',coalesce(p.require_mfa,false) AND a.enabled_at IS NULL AS mfa_required' : ''}
      FROM public.api_keys k JOIN public.users u ON u.id=k.user_id
      JOIN public.tenants t ON t.id=k.tenant_id ${accountJoin} ${policyJoin}
      LEFT JOIN public.memberships m ON (m.tenant_id,m.user_id)=(k.tenant_id,k.user_id)
      WHERE k.id=$1 AND k.token_hash=$2 AND k.user_id=$3 AND k.tenant_id=$4
      AND k.revoked_at IS NULL AND k.expires_at>$5::timestamptz`,
      [f.keyId, f.keyHash, f.userId, f.tenantId, clock])).rows[0];
    ensure(current, 401, 'Klucz API wygasł lub został unieważniony');
    ensure(current.role === 'admin', 403, 'Wymagana aktualna rola administratora');
    ensure(f.scopes.every(scope => current.scopes.includes(scope)), 403,
      'Klucz API nie ma bieżącego dostępu do tej operacji');
    ensure(!current.mfa_required, 403, 'Firma wymaga aktywnego MFA właściciela klucza API');
  } else {
    const current = (await c.query(`SELECT m.role FROM public.users u
      JOIN public.memberships m ON m.user_id=u.id WHERE u.id=$1 AND m.tenant_id=$2`,
      [f.userId, f.tenantId])).rows[0];
    ensure(current?.role === 'admin', 403, 'Autor zadania utracił rolę administratora');
    await jobSource(c, f, false); // locks were acquired before CAS; no new wait
  }
}
/** Unlocked fresh guard for BEFORE HTTP or immediately after HTTP. */
export async function assertAllegroAuthorityInTx(c: PoolClient,
  token: AllegroOAuthAuthority, channelId: string) {
  const f = frame(token, channelId);
  await owner(c, f.tenantId, async () => {
    await securityGraph(c, f.security); await channel(c, f);
    const clock = (await c.query('SELECT clock_timestamp()::text AS checked_at')).rows[0].checked_at;
    await currentIdentity(c, f, clock);
  });
}

/** Immediately before COMMIT, AFTER all constraints/hydration/sibling waits. */
export async function finalizeAllegroAuthoritiesInTx(c: PoolClient) {
  const s = registry.get(c);
  if (!s) throw new Problem(500, 'Brak zarządzanego kontekstu OAuth');
  ensure(!s.frozen, 500, 'Końcowa kontrola OAuth została już rozpoczęta');
  s.frozen = true;
  const tokens = [...s.authorities].sort((a,b) => {
    const x=frame(a), y=frame(b);
    return JSON.stringify([x.tenantId,x.userId,x.kind,x.channelId])
      .localeCompare(JSON.stringify([y.tenantId,y.userId,y.kind,y.channelId]));
  });
  if (!tokens.length) { s.completed = true; return; }
  const frames = tokens.map(t => frame(t));
  ensure(frames.every(f => f.tenantId === frames[0].tenantId), 403,
    'Zgody OAuth dotyczą różnych organizacji');
  for (const token of tokens) if (frame(token).kind === 'job')
    ensure(s.jobPins.has(token), 500, 'Zadanie OAuth nie przypięło źródła przed CAS');
  await drainPublicConstraintsInTx(c);
  await owner(c, frames[0].tenantId, async () => {
    for (const f of frames) await securityGraph(c, f.security);
    // Pin all authority resources BEFORE taking the one final clock. These
    // locks are late: native demotion/logout can commit during channel CAS wait.
    await pinIdentities(c, frames);
    // Recheck torn security and recovery metadata AFTER the last IAM wait, BEFORE the final clock.
    for (const f of frames) await securityGraph(c, f.security);
    await c.query('SELECT public.allegro_oauth_recovery_require()');
    const clock = (await c.query('SELECT clock_timestamp()::text AS checked_at')).rows[0].checked_at;
    for (const f of frames) await currentIdentity(c, f, clock);
  });
  s.completed = true;
  // Root caller must perform only COMMIT/ACK now. end() also runs on rollback.
}

/** Synchronous binding: no early IAM locks before channel CAS. */
export function assertAllegroAuthorityBinding(token: AllegroOAuthAuthority,
  tenantId: string, channelId: string, userId?: string | null) {
  const f = frame(token, channelId);
  ensure(f.tenantId === tenantId && (userId === undefined || f.userId === userId),
    403, 'Zgoda Allegro dotyczy innego wywołującego');
}
/** Server-only ledger source identity; no token/session/key material escapes. */
export function allegroAuthorityRecoveryIdentity(token: AllegroOAuthAuthority, tenantId: string, channelId: string) {
  assertAllegroAuthorityBinding(token,tenantId,channelId); const f=frame(token);
  return Object.freeze({kind:f.kind,userId:f.userId,jobId:f.kind==='job'?f.jobId:null});
}
export function allegroAuthorityIsJob(token: AllegroOAuthAuthority) {
  return frame(token).kind === 'job';
}
export async function allegroAuthoritySecurityInTx(c: PoolClient): Promise<AllegroAuthoritySecurity> {
  // Trusted worker/test adapter; HTTP supplies actual boot/restore capabilities.
  // securityGraph independently checks ledger and actual table presence.
  const p = (await c.query("SELECT to_regclass('public.account_security') IS NOT NULL AS account, "
    + "to_regclass('public.workspace_security_policies') IS NOT NULL AS mfa")).rows[0];
  return Object.freeze({ accountSecurityAvailable: p.account,
    workspaceMfaPolicyAvailable: p.mfa, readOnly: false });
}
type Refusal = Readonly<{ tenantId: string; channelId: string; connectionId: string | null; jobId: string | null }>;
const refusalCustody = new WeakMap<Error, Refusal>();
export function allegroOAuthCommitRefusal(error: unknown, source: Omit<Refusal, 'jobId'>,
  authority: AllegroOAuthAuthority): Problem {
  const f = frame(authority, source.channelId);
  assertAllegroAuthorityBinding(authority, source.tenantId, source.channelId);
  const problem = new Problem(error instanceof Problem ? error.status : 503,
    error instanceof Problem ? error.message : 'Lokalny zapis tokenów Allegro nie został potwierdzony',
    'ALLEGRO_OAUTH_COMMIT_REFUSED');
  refusalCustody.set(problem, Object.freeze({ tenantId: uuid.parse(source.tenantId),
    channelId: uuid.parse(source.channelId), connectionId: source.connectionId,
    jobId: f.kind === 'job' ? f.jobId : null }));
  return problem;
}
export function allegroOAuthCommitRefusalDetails(error: unknown): Refusal | undefined {
  return error instanceof Error ? refusalCustody.get(error) : undefined;
}

/** Current producers are disjoint. Mixed COUNT/OAuth needs a future shared final clock. */
export function assertNoAllegroAuthorityInTx(c: PoolClient) {
  ensure(!registry.get(c)?.authorities.size, 409,
    'Pomiar stanów i Allegro wymagają odrębnych transakcji');
}
