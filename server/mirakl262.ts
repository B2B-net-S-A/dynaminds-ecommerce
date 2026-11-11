/** Mirakl Seller operations of migration 252 (integration track L4, docs/parity/MIRAKL252-20261028.md):
 * - orders.schedule: the durable MiraklOrderSyncRepository of server/mirakl-order-sync.ts (checkpoint per channel,
 *   one OR11 page per job run through the existing channel reader and its shared A01/OR11/OF21 budget), staging into
 *   the import queue under the current admin role of the administrator who enabled it;
 * - offers.write (OF24 + OF02/OF03) and fulfillment.write (OR21/OR23/OR24): an outbox with one-click idempotency,
 *   phase 'sending' committed before HTTP, a lost answer kept 'uncertain' and settled by readback (OF21 / OR11)
 *   before anything is sent again;
 * - webhooks.receive: secret path token per channel (stored as SHA-256), idempotent event id, a per-endpoint rate,
 *   and the event only brings the OR11 poll forward — its body is never trusted as order data.
 * HTTP never runs inside a database transaction. Writes run only in the local simulation (DYNA_MIRAKL_FAKE=local):
 * the connector policy for real instances allows GET only, and write access needs the operator's agreement. */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { pool, tenantAppendTx, tenantReadTx, tenantTx } from './db';
import type { Actor } from './domain';
import { ensure, Problem } from './errors';
import { insertAuditEvent } from './audit-log';
import { decrypt } from './security';
import { stageOrders } from './imports';
import type { Transport } from './integrations';
import { miraklMoney, MiraklReadDeferred } from './mirakl';
import { createMiraklChannelReader, miraklChannelConnectionHash, parseMiraklCredentials, parseMiraklSettings,
  type MiraklAccountCache, type MiraklChannel, type MiraklReadRepository } from './mirakl-channel';
import { initialMiraklOrderCheckpoint, processMiraklOrderSync, type MiraklOrderSyncClaim, type MiraklOrderSyncRepository } from './mirakl-order-sync';
import { createMiraklWriter, miraklOfferLine, miraklPrice, miraklTracking, MiraklWriteDeferred, MiraklWriteRefused, MiraklWriteUncertain } from './mirakl262-wire';
import { createMiraklFake, type MiraklFake } from './mirakl262-fake';

export const MIRAKL262_ORDERS_JOB = 'mirakl262.orders';
export const MIRAKL262_WRITE_JOB = 'mirakl262.write';
export const MIRAKL262_WEBHOOK_MAX_BYTES = 65536;
const WEBHOOK_EVENTS_PER_MINUTE = 120;
const MAX_SENDS = 5;
/** An open write that cannot be settled within this time becomes failed/conflict and frees its target. */
const OPEN_LIMIT_MS = 24 * 3600 * 1000;
const WEBHOOK_EVENTS_PER_DAY = 5000;
const stale = (op: Row) => Date.now() - new Date(op.created_at).getTime() > OPEN_LIMIT_MS;
type Row = Record<string, any>;

// ---- runtime -----------------------------------------------------------------------------------------------
export type Mirakl262Runtime = { transport?: Transport; readRepository?: MiraklReadRepository; writes: boolean; simulation: boolean;
  now: () => number; pageSize: number; timeoutMs: number;
  /** OF24 imports are asynchronous: after a lost answer a value mismatch is not proof of absence before this delay. */
  offerReplayDelaySeconds: number };
let runtime: Mirakl262Runtime = { writes: false, simulation: false, now: Date.now, pageSize: 50, timeoutMs: 15000, offerReplayDelaySeconds: 900 };
export function configureMirakl262Runtime(patch: Partial<Mirakl262Runtime>): void { runtime = { ...runtime, ...patch }; }
export const mirakl262Runtime = (): Readonly<Mirakl262Runtime> => runtime;
/** Local simulation: every Mirakl call goes to an in-process fake per instance, shop and key; nothing leaves the
 * machine and the screen says SYMULACJA. Only with DYNA_MIRAKL_FAKE=local outside production. */
export const mirakl262Simulation = () => process.env.DYNA_MIRAKL_FAKE === 'local' && process.env.NODE_ENV !== 'production';
const simulatedFakes = new Map<string, MiraklFake>();
export function mirakl262SimulationFake(instanceUrl: string, shopId: string, apiKey: string): MiraklFake {
  const key = instanceUrl + '|' + shopId + '|' + createHash('sha256').update(apiKey).digest('hex');
  let f = simulatedFakes.get(key);
  if (!f) { f = createMiraklFake({ origin: instanceUrl, shopId, apiKey }); simulatedFakes.set(key, f); }
  return f;
}
export const mirakl262SimulationTransport: Transport = async (url, init) => {
  const u = new URL(url);
  const auth = new Headers(init.headers).get('authorization') ?? '';
  return mirakl262SimulationFake(u.origin, u.searchParams.get('shop_id') ?? '', auth).transport(url, init);
};
/** Budget repository of the simulation: same contract as server/mirakl-read-postgres.ts (per instance x operation
 * not_before, failed attempts keep their fence, A01 cache), in process memory and on the runtime clock. It stands
 * in only for the fake; a real instance needs the separate connector control database. */
export function createMirakl262SimulatedReadRepository(): MiraklReadRepository {
  const budgets = new Map<string, number>(), accounts = new Map<string, MiraklAccountCache>(), claims = new Map<string, string>();
  return {
    async readAccount(key) { const a = accounts.get(key); return a ? structuredClone(a) : null; },
    async reserveRead(i) {
      const until = budgets.get(i.budgetKey) ?? 0;
      if (until > i.now) return { retryAt: until };
      budgets.set(i.budgetKey, Math.max(until, i.notBefore));
      const claimId = randomUUID(); claims.set(claimId, i.budgetKey);
      return { claimId };
    },
    async storeAccount({ claimId, entry }) { ensure(claims.has(claimId), 409, 'Mirakl: zapis tożsamości bez rezerwacji'); accounts.set(entry.accountKey, structuredClone(entry)); },
    async deferRead(i) { ensure(claims.get(i.claimId) === i.budgetKey, 409, 'Mirakl: cooldown bez rezerwacji'); budgets.set(i.budgetKey, Math.max(budgets.get(i.budgetKey) ?? 0, i.notBefore)); },
  };
}

// ---- shared ------------------------------------------------------------------------------------------------
let installed = false;
export async function mirakl262Available(c: Pick<PoolClient, 'query'> = pool): Promise<boolean> {
  if (!installed) installed = (await c.query("SELECT to_regclass('public.mirakl262_operations') IS NOT NULL AND to_regclass('public.mirakl262_webhook_events') IS NOT NULL ok")).rows[0]?.ok === true;
  return installed;
}
async function requireInstalled() { ensure(await mirakl262Available(), 503, 'Mirakl: harmonogram i zapisy wymagają migracji 252'); }
function requireAdmin(a: Actor) {
  ensure(a.role === 'admin', 403, 'Mirakl: wymagana rola administratora');
  ensure(!a.apiKeyId && a.source !== 'api', 403, 'Mirakl: operacje dostępne tylko z sesji administratora, nie kluczem API');
}
const sha = (v: unknown) => createHash('sha256').update(typeof v === 'string' ? v : JSON.stringify(v)).digest('hex');
async function channelInTx(c: PoolClient, channelId: string, lock = false): Promise<MiraklChannel & Row> {
  ensure(z.uuid().safeParse(channelId).success, 404, 'Nie znaleziono własnego kanału Mirakl');
  const ch = (await c.query(`SELECT * FROM channels WHERE id=$1${lock ? ' FOR SHARE' : ''}`, [channelId])).rows[0];
  ensure(ch, 404, 'Nie znaleziono własnego kanału Mirakl');
  ensure(ch.provider === 'mirakl', 422, 'To nie jest kanał Mirakl');
  return ch;
}
/** Short checks between provider calls: reads only, but offer_sync_is_admin takes FOR SHARE locks, which a READ ONLY
 * transaction refuses; tenantAppendTx is the light read-write runner (no domain admission), nothing is written. */
const guardTx = tenantAppendTx;
async function isAdmin(c: PoolClient, userId: string) { return (await c.query('SELECT offer_sync_is_admin($1) ok', [userId])).rows[0]?.ok === true; }
const iso = (ms: number) => new Date(ms).toISOString();
function readerFor(ch: MiraklChannel, guard: () => Promise<void>) {
  ensure(runtime.transport && runtime.readRepository, 503, 'Mirakl: odczyty nie są włączone w tym uruchomieniu (trwały budżet i transport)');
  let credentials: ReturnType<typeof parseMiraklCredentials>;
  try { credentials = parseMiraklCredentials(decrypt(ch.credentials)); } catch { throw new Problem(422, 'Mirakl: nieprawidłowe prywatne poświadczenia kanału'); }
  return createMiraklChannelReader({ channel: ch, credentials, repository: runtime.readRepository, transport: runtime.transport, guard, now: runtime.now });
}
function writerFor(ch: MiraklChannel) {
  ensure(runtime.writes && runtime.transport, 503, 'Mirakl: zapisy do operatora wymagają umowy i dostępu zapisu — czeka na dostawcę (dostępne w symulacji)');
  const credentials = parseMiraklCredentials(decrypt(ch.credentials));
  return createMiraklWriter({ settings: ch.settings, apiKey: credentials.api_key, transport: runtime.transport, timeoutMs: runtime.timeoutMs });
}
async function finishJob(c: PoolClient, job: Row, error: string | null = null) {
  await c.query(`UPDATE jobs SET state=$3,lease_token=NULL,locked_at=NULL,error=$4 WHERE id=$1 AND lease_token=$2`, [job.id, job.lease_token, error ? 'failed' : 'done', error]);
}
async function requeueJob(c: PoolClient, job: Row, seconds: number) {
  await c.query(`UPDATE jobs SET state='pending',attempts=0,lease_token=NULL,locked_at=NULL,error=NULL,run_at=now()+make_interval(secs=>$3) WHERE id=$1 AND lease_token=$2`, [job.id, job.lease_token, seconds]);
}
async function leaseHeld(c: PoolClient, job: Row) {
  return (await c.query("SELECT 1 FROM jobs WHERE id=$1 AND state='running' AND lease_token=$2", [job.id, job.lease_token])).rowCount === 1;
}
async function newJob(c: PoolClient, tenantId: string, kind: string, payload: Row) {
  const id = randomUUID();
  await c.query('INSERT INTO jobs(id,tenant_id,kind,payload,dedup_key,max_attempts) VALUES($1,$2,$3,$4,$5,5)', [id, tenantId, kind, JSON.stringify(payload), kind + ':' + id]);
  return id;
}

// ---- views -------------------------------------------------------------------------------------------------
const scheduleView = (s: Row | undefined) => s ? {
  id: s.id, enabled: s.enabled, interval_minutes: s.interval_minutes, state: s.state, reason: s.reason, window_start: s.window_start,
  watermark: s.watermark, next_run_at: s.next_run_at, last_run_at: s.last_run_at, pages: s.pages, staged: s.staged, version: s.version,
  page_offset: s.checkpoint?.offset ?? null, page_total: s.checkpoint?.totalCount ?? null,
} : null;
const operationView = (o: Row) => ({
  id: o.id, kind: o.kind, target: o.target, state: o.state, outcome: o.outcome, attempts: o.attempts, import_id: o.import_id,
  result: o.result, reason: o.reason, payload: o.payload, created_at: o.created_at, updated_at: o.updated_at,
});
export async function readMirakl262State(a: Actor, channelId: string) {
  requireAdmin(a); await requireInstalled();
  return tenantReadTx(a.tenantId, async c => {
    await channelInTx(c, channelId);
    const s = (await c.query('SELECT * FROM mirakl262_schedules WHERE channel_id=$1', [channelId])).rows[0];
    const ops = (await c.query('SELECT * FROM mirakl262_operations WHERE channel_id=$1 ORDER BY created_at DESC,id DESC LIMIT 50', [channelId])).rows;
    const hook = (await c.query('SELECT id,enabled,version,updated_at FROM mirakl262_webhook_endpoints WHERE channel_id=$1', [channelId])).rows[0] ?? null;
    const events = hook ? (await c.query('SELECT event_id,event_type,outcome,received_at FROM mirakl262_webhook_events WHERE endpoint_id=$1 ORDER BY received_at DESC,id DESC LIMIT 20', [hook.id])).rows : [];
    return { simulation: runtime.simulation, writes_enabled: runtime.writes, reads_enabled: Boolean(runtime.transport && runtime.readRepository),
      schedule: scheduleView(s), operations: ops.map(operationView), webhook: hook, events };
  });
}

// ---- orders.schedule ---------------------------------------------------------------------------------------
const scheduleInput = z.strictObject({ enabled: z.boolean(), interval_minutes: z.number().int().min(15).max(1440),
  start_from: z.iso.datetime({ offset: true }).optional(), version: z.number().int().positive().optional() });
export async function saveMirakl262Schedule(a: Actor, channelId: string, body: unknown) {
  requireAdmin(a); await requireInstalled();
  const p = scheduleInput.safeParse(body);
  if (!p.success) throw new Problem(422, 'Mirakl: interwał 15–1440 minut (wspólny budżet OR11 instancji: 15 minut) i poprawna data startu');
  const b = p.data, at = runtime.now();
  if (b.start_from) ensure(Date.parse(b.start_from) <= at && Date.parse(b.start_from) >= at - 31 * 86400000, 422, 'Mirakl: start okna w ostatnich 31 dniach');
  return tenantTx(a.tenantId, async c => {
    const ch = await channelInTx(c, channelId, true);
    parseMiraklSettings(ch.settings);
    ensure(await isAdmin(c, a.userId), 403, 'Mirakl: wymagana rola administratora');
    const hash = miraklChannelConnectionHash(ch);
    const old = (await c.query('SELECT * FROM mirakl262_schedules WHERE channel_id=$1 FOR UPDATE', [channelId])).rows[0];
    let s: Row;
    if (old) {
      ensure(b.version === undefined || b.version === old.version, 409, 'Harmonogram Mirakl zmienił się; odśwież widok');
      ensure(!['queued', 'deferred'].includes(old.state) || !b.enabled || old.connection_hash === hash, 409, 'Mirakl: trwa odczyt starym połączeniem; spróbuj po jego zakończeniu');
      const reset = old.connection_hash !== hash || b.start_from !== undefined;
      s = (await c.query(`UPDATE mirakl262_schedules SET enabled=$2,interval_minutes=$3,actor_id=$4,connection_hash=$5,
        state=CASE WHEN state IN ('queued','deferred') THEN state ELSE 'idle' END,reason=NULL,
        checkpoint=CASE WHEN $6 AND state NOT IN ('queued','deferred') THEN NULL ELSE checkpoint END,
        window_start=CASE WHEN $7::timestamptz IS NOT NULL AND state NOT IN ('queued','deferred') THEN $7::timestamptz ELSE window_start END,
        next_run_at=CASE WHEN $2 THEN least(next_run_at,now()+make_interval(mins=>$3)) ELSE next_run_at END,
        version=version+1,updated_at=now() WHERE id=$1 RETURNING *`,
        [old.id, b.enabled, b.interval_minutes, a.userId, hash, reset, b.start_from ?? null])).rows[0];
      if (old.state === 'failed') s = (await c.query("UPDATE mirakl262_schedules SET next_run_at=now() WHERE id=$1 RETURNING *", [old.id])).rows[0];
    } else {
      s = (await c.query(`INSERT INTO mirakl262_schedules(id,tenant_id,channel_id,enabled,interval_minutes,actor_id,connection_hash,window_start)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`, [randomUUID(), a.tenantId, channelId, b.enabled, b.interval_minutes, a.userId, hash, b.start_from ?? iso(at - 86400000)])).rows[0];
    }
    await insertAuditEvent(c, a, 'integration.mirakl.orders.schedule', channelId, { enabled: s.enabled, interval_minutes: s.interval_minutes, version: s.version });
    return { schedule: scheduleView(s) };
  });
}
export async function runMirakl262ScheduleNow(a: Actor, channelId: string) {
  requireAdmin(a); await requireInstalled();
  return tenantTx(a.tenantId, async c => {
    await channelInTx(c, channelId);
    const s = (await c.query('SELECT * FROM mirakl262_schedules WHERE channel_id=$1 FOR UPDATE', [channelId])).rows[0];
    ensure(s && s.enabled, 409, 'Mirakl: najpierw włącz harmonogram');
    ensure(s.state !== 'failed', 409, 'Mirakl: harmonogram zatrzymany; zapisz go ponownie, aby wznowić');
    const r = (await c.query("UPDATE mirakl262_schedules SET next_run_at=now(),updated_at=now() WHERE id=$1 RETURNING *", [s.id])).rows[0];
    if (s.state === 'deferred' && s.job_id) await c.query("UPDATE jobs SET run_at=now() WHERE id=$1 AND state='pending'", [s.job_id]);
    return { schedule: scheduleView(r) };
  });
}
/** Worker step: due schedules get a job (one per window, the same job continues page by page) and open writes
 * whose job ended without settling them get a new one. Cross-tenant discovery by the owner pool, every change in
 * the row's own tenant transaction. */
export async function sweepMirakl262Due(): Promise<void> {
  if (!(await mirakl262Available())) return;
  const due = (await pool.query(`SELECT id,tenant_id FROM mirakl262_schedules WHERE enabled AND state='idle' AND next_run_at<=now() ORDER BY next_run_at LIMIT 20`)).rows;
  for (const d of due) {
    await tenantTx(d.tenant_id, async c => {
      const s = (await c.query("SELECT * FROM mirakl262_schedules WHERE id=$1 AND enabled AND state='idle' AND next_run_at<=now() FOR UPDATE SKIP LOCKED", [d.id])).rows[0];
      if (!s) return;
      let checkpoint = s.checkpoint;
      if (!checkpoint) {
        const start = new Date(s.window_start).getTime(), end = Math.min(runtime.now(), start + 31 * 86400000);
        if (end - start < 1000) { await c.query("UPDATE mirakl262_schedules SET next_run_at=now()+make_interval(mins=>interval_minutes) WHERE id=$1", [s.id]); return; }
        checkpoint = initialMiraklOrderCheckpoint({ connectionHash: s.connection_hash, window: { start_update_date: iso(start), end_update_date: iso(end) }, max: runtime.pageSize });
      }
      const jobId = await newJob(c, s.tenant_id, MIRAKL262_ORDERS_JOB, { schedule_id: s.id, channel_id: s.channel_id });
      await c.query("UPDATE mirakl262_schedules SET state='queued',job_id=$2,checkpoint=$3,updated_at=now() WHERE id=$1", [s.id, jobId, JSON.stringify(checkpoint)]);
    });
  }
  // A schedule whose job failed for good stops with a reason; open writes with an ended job get a new one.
  const lost = (await pool.query(`SELECT s.id,s.tenant_id FROM mirakl262_schedules s JOIN jobs j ON j.id=s.job_id WHERE s.state IN ('queued','deferred') AND j.state='failed' LIMIT 20`)).rows;
  for (const l of lost) await tenantTx(l.tenant_id, c => c.query("UPDATE mirakl262_schedules SET state='failed',reason='Zadanie odczytu przerwane po ostatniej próbie; zapisz harmonogram, aby wznowić',updated_at=now() WHERE id=$1 AND state IN ('queued','deferred')", [l.id]));
  const orphans = (await pool.query(`SELECT o.id,o.tenant_id FROM mirakl262_operations o LEFT JOIN jobs j ON j.id=o.job_id WHERE o.state IN ('queued','sending','sent','uncertain') AND (j.id IS NULL OR j.state IN ('failed','done')) LIMIT 20`)).rows;
  for (const o of orphans) await tenantTx(o.tenant_id, async c => {
    const row = (await c.query("SELECT o.* FROM mirakl262_operations o LEFT JOIN jobs j ON j.id=o.job_id WHERE o.id=$1 AND o.state IN ('queued','sending','sent','uncertain') AND (j.id IS NULL OR j.state IN ('failed','done')) FOR UPDATE OF o", [o.id])).rows[0];
    if (!row) return;
    if (row.attempts >= MAX_SENDS && row.state === 'queued') {
      await c.query("UPDATE mirakl262_operations SET state='failed',outcome='conflict',reason='Wyczerpano próby zapisu',updated_at=now() WHERE id=$1", [row.id]); return;
    }
    const jobId = await newJob(c, row.tenant_id, MIRAKL262_WRITE_JOB, { operation_id: row.id, channel_id: row.channel_id });
    // 'sending' with a dead job: the request may have left; settle it by readback.
    await c.query("UPDATE mirakl262_operations SET job_id=$2,state=CASE WHEN state='sending' THEN 'uncertain' ELSE state END,updated_at=now() WHERE id=$1", [row.id, jobId]);
  });
  // Retention (migration 253, prepared as 263): webhook events older than 90 days leave only through the owner's purge of their
  // tenant (at most 1000 rows per call); the rule and the bound live in the SQL, this only finds the tenants.
  if (await mirakl263RetentionAvailable()) {
    const stale = (await pool.query(`SELECT DISTINCT tenant_id FROM mirakl262_webhook_events WHERE received_at<now()-interval '90 days' LIMIT 20`)).rows;
    for (const s of stale) await tenantTx(s.tenant_id, c => c.query('SELECT public.mirakl263_purge_webhook_events()'));
  }
}
let retention = false;
async function mirakl263RetentionAvailable(): Promise<boolean> {
  if (!retention) retention = (await pool.query("SELECT to_regprocedure('public.mirakl263_purge_webhook_events()') IS NOT NULL ok")).rows[0]?.ok === true;
  return retention;
}

function scheduleRepository(job: Row, scheduleId: string): MiraklOrderSyncRepository {
  const tenantId = job.tenant_id as string;
  async function current(c: PoolClient, claim: Pick<MiraklOrderSyncClaim, 'binding'>, lock: boolean) {
    const s = (await c.query(`SELECT * FROM mirakl262_schedules WHERE id=$1${lock ? ' FOR UPDATE' : ''}`, [scheduleId])).rows[0];
    ensure(s && s.enabled && s.job_id === job.id && s.state === 'queued', 409, 'Mirakl: harmonogram zmienił się');
    ensure(await leaseHeld(c, job), 409, 'Mirakl: utracono dzierżawę zadania');
    const ch = await channelInTx(c, s.channel_id, lock);
    ensure(miraklChannelConnectionHash(ch) === claim.binding.connectionHash && s.connection_hash === claim.binding.connectionHash, 409, 'Mirakl: połączenie zmieniło się');
    ensure(s.actor_id === claim.binding.actorId && await isAdmin(c, s.actor_id), 403, 'Mirakl: administrator harmonogramu utracił uprawnienia');
    return { s, ch };
  }
  const revision = (s: Row, claim: MiraklOrderSyncClaim) => ensure(s.checkpoint?.revision === claim.checkpoint.revision, 409, 'Mirakl: checkpoint zmienił się');
  return {
    async claim(_job, binding) {
      return tenantTx(tenantId, async c => {
        const s = (await c.query('SELECT * FROM mirakl262_schedules WHERE id=$1 FOR UPDATE', [scheduleId])).rows[0];
        if (!s || s.job_id !== job.id || !['queued', 'deferred'].includes(s.state) || !(await leaseHeld(c, job))) return { state: 'stopped' as const };
        const stop = async (reason: string) => {
          await c.query("UPDATE mirakl262_schedules SET state='failed',reason=$2,job_id=NULL,updated_at=now() WHERE id=$1", [s.id, reason]);
          return { state: 'stopped' as const };
        };
        if (!s.enabled) { await c.query("UPDATE mirakl262_schedules SET state='idle',job_id=NULL,updated_at=now() WHERE id=$1", [s.id]); return { state: 'stopped' as const }; }
        const ch = (await c.query('SELECT * FROM channels WHERE id=$1', [s.channel_id])).rows[0];
        if (!ch || ch.provider !== 'mirakl' || miraklChannelConnectionHash(ch) !== binding.connectionHash) return stop('Połączenie kanału zmieniło się; zapisz harmonogram ponownie');
        if (!(await isAdmin(c, s.actor_id))) return stop('Administrator, który włączył harmonogram, utracił uprawnienia');
        if (s.state === 'deferred') await c.query("UPDATE mirakl262_schedules SET state='queued',updated_at=now() WHERE id=$1", [s.id]);
        return { state: 'claimed' as const, checkpoint: s.checkpoint };
      });
    },
    async guard(claim) { await guardTx(tenantId, async c => { const { s } = await current(c, claim, false); revision(s, claim); }); },
    async commitPage(claim, page) {
      await tenantTx(tenantId, async c => {
        const { s, ch } = await current(c, claim, true); revision(s, claim);
        const actor: Actor = { tenantId, userId: s.actor_id, role: 'admin' };
        const data = page.orders.length ? await stageOrders(c, actor, ch, page.orders.map(o => o.source)) : [];
        if (page.next.finished) {
          await c.query(`UPDATE mirakl262_schedules SET checkpoint=NULL,watermark=$2,window_start=$2,state='idle',reason=NULL,job_id=NULL,
            pages=pages+1,staged=staged+$3,last_run_at=now(),next_run_at=now()+make_interval(mins=>interval_minutes),updated_at=now() WHERE id=$1`,
            [s.id, page.next.window.end_update_date, data.length]);
          await finishJob(c, job);
        } else {
          await c.query("UPDATE mirakl262_schedules SET checkpoint=$2,pages=pages+1,staged=staged+$3,reason=NULL,updated_at=now() WHERE id=$1", [s.id, JSON.stringify(page.next), data.length]);
          await requeueJob(c, job, 0);
        }
        await insertAuditEvent(c, actor, 'integration.mirakl.orders.schedule.page', s.channel_id, { count: data.length, offset: page.next.offset, finished: page.next.finished });
      });
    },
    async defer(claim, input) {
      return tenantTx(tenantId, async c => {
        const { s } = await current(c, claim, true); revision(s, claim);
        const at = (await c.query('SELECT (now()+make_interval(secs=>$1)) t', [input.retryAfterSeconds])).rows[0].t as Date;
        await c.query("UPDATE mirakl262_schedules SET reason=$2,updated_at=now() WHERE id=$1", [s.id, 'Wspólny limit odczytu OR11 instancji; wznowienie po ' + at.toLocaleString('pl-PL', { timeZone: 'Europe/Warsaw' })]);
        await requeueJob(c, job, input.retryAfterSeconds);
        return { notBefore: at.toISOString() };
      });
    },
    async fail(claim, input) {
      await tenantTx(tenantId, async c => {
        const { s } = await current(c, claim, true); revision(s, claim);
        const reason = input.reason === 'READ_FAILED' ? 'Odczyt OR11 nieudany; sprawdź klucz i instancję' : 'Strona OR11 odrzucona przez kontrolę spójności; zmniejsz okno';
        await c.query("UPDATE mirakl262_schedules SET state='failed',reason=$2,job_id=NULL,updated_at=now() WHERE id=$1", [s.id, reason]);
        await finishJob(c, job, reason);
      });
    },
  };
}
async function processOrders(job: Row) {
  const scheduleId = z.uuid().parse(job.payload?.schedule_id);
  const s = (await tenantReadTx(job.tenant_id, c => c.query('SELECT s.*,c.settings,c.id AS cid FROM mirakl262_schedules s JOIN channels c ON c.id=s.channel_id WHERE s.id=$1', [scheduleId]))).rows[0];
  if (!s) { await tenantTx(job.tenant_id, c => finishJob(c, job)); return { status: 'stopped' as const }; }
  const currency = parseMiraklSettings(s.settings).currency;
  const result = await processMiraklOrderSync({
    job: { tenantId: job.tenant_id, jobId: job.id, leaseToken: job.lease_token },
    binding: { tenantId: job.tenant_id, channelId: s.channel_id, actorId: s.actor_id, connectionHash: s.connection_hash, currency, requireEnabled: true },
    repository: scheduleRepository(job, scheduleId),
    createReader: async guard => {
      const ch = await tenantReadTx(job.tenant_id, c => channelInTx(c, s.channel_id));
      return readerFor(ch, guard);
    },
  });
  if (result.status === 'stopped' || result.status === 'already_complete') await tenantTx(job.tenant_id, async c => {
    if (result.status === 'already_complete') await c.query("UPDATE mirakl262_schedules SET checkpoint=NULL,state='idle',job_id=NULL WHERE id=$1 AND job_id=$2", [scheduleId, job.id]);
    await finishJob(c, job);
  });
  if (result.status === 'deferred') await tenantTx(job.tenant_id, c => c.query("UPDATE mirakl262_schedules SET state='deferred' WHERE id=$1 AND job_id=$2 AND state='queued'", [scheduleId, job.id]));
  return result;
}

// ---- offers.write / fulfillment.write ----------------------------------------------------------------------
const offersInput = z.strictObject({ client_key: z.uuid(), product_ids: z.array(z.uuid()).min(1).max(100) });
const fulfillmentInput = z.strictObject({ client_key: z.uuid(), action: z.enum(['accept', 'tracking', 'ship']),
  order_id: z.string().min(1).max(160).refine(v => !/[\x00-\x1f\x7f/?#%,]/.test(v)), tracking: z.unknown().optional() });
async function insertOperation(c: PoolClient, a: Actor, ch: Row, input: { kind: string; target: string; client_key: string; request: unknown; payload: Row; order_id?: string | null; inbound_id?: string | null }) {
  const hash = sha(input.request);
  const prior = (await c.query('SELECT * FROM mirakl262_operations WHERE client_key=$1 FOR UPDATE', [input.client_key])).rows[0];
  if (prior) {
    ensure(prior.request_sha256 === hash && prior.channel_id === ch.id, 409, 'Ten klucz operacji użyto już z inną treścią');
    return { reused: true, operation: operationView(prior) };
  }
  const open = (await c.query("SELECT id FROM mirakl262_operations WHERE channel_id=$1 AND kind=$2 AND target=$3 AND state IN ('queued','sending','sent','uncertain') FOR UPDATE", [ch.id, input.kind, input.target])).rows[0];
  ensure(!open, 409, 'Poprzedni zapis tego zamówienia lub ofert jeszcze trwa; poczekaj na jego wynik');
  const id = randomUUID(), jobId = await newJob(c, a.tenantId, MIRAKL262_WRITE_JOB, { operation_id: id, channel_id: ch.id });
  let row: Row;
  try {
    row = (await c.query(`INSERT INTO mirakl262_operations(id,tenant_id,channel_id,connection_hash,kind,target,order_id,inbound_id,client_key,request_sha256,payload,job_id,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`, [id, a.tenantId, ch.id, miraklChannelConnectionHash(ch as MiraklChannel), input.kind, input.target,
      input.order_id ?? null, input.inbound_id ?? null, input.client_key, hash, JSON.stringify(input.payload), jobId, a.userId])).rows[0];
  } catch (e) {
    if ((e as { code?: string }).code === '23505') throw new Problem(409, 'Poprzedni zapis tego zamówienia lub ofert jeszcze trwa; poczekaj na jego wynik');
    throw e;
  }
  await insertAuditEvent(c, a, 'integration.mirakl.' + input.kind + '.queued', id, { channel_id: ch.id, target: input.target });
  return { reused: false, operation: operationView(row) };
}
export async function enqueueMirakl262Offers(a: Actor, channelId: string, body: unknown) {
  requireAdmin(a); await requireInstalled();
  const p = offersInput.safeParse(body);
  if (!p.success) throw new Problem(422, 'Mirakl: podaj client_key i 1–100 produktów');
  const b = p.data;
  ensure(new Set(b.product_ids).size === b.product_ids.length, 422, 'Mirakl: powtórzony produkt');
  return tenantTx(a.tenantId, async c => {
    const ch = await channelInTx(c, channelId, true);
    const prior = (await c.query('SELECT 1 FROM mirakl262_operations WHERE client_key=$1', [b.client_key])).rowCount;
    if (!prior) writerFor(ch); // refuse before anything is queued when writes are not available
    const rows = (await c.query(`SELECT p.id,p.sku,p.price,coalesce((SELECT sum(s.available) FROM stock s WHERE s.product_id=p.id),0)::int quantity
      FROM products p WHERE p.id=ANY($1::uuid[])`, [b.product_ids])).rows;
    ensure(rows.length === b.product_ids.length, 404, 'Nie znaleziono produktu w tej firmie');
    const lines = b.product_ids.map(id => {
      const r = rows.find(x => x.id === id)!;
      const line = miraklOfferLine.safeParse({ shop_sku: r.sku, price_minor: r.price, quantity: Math.max(0, r.quantity) });
      ensure(line.success, 422, 'Mirakl: SKU ' + String(r.sku).slice(0, 60) + ' nie nadaje się na shop_sku');
      return { product_id: id, ...line.data };
    });
    return insertOperation(c, a, ch, { kind: 'offers', target: 'offers', client_key: b.client_key, request: { kind: 'offers', channelId, product_ids: b.product_ids }, payload: { lines } });
  });
}
export async function enqueueMirakl262Fulfillment(a: Actor, channelId: string, body: unknown) {
  requireAdmin(a); await requireInstalled();
  const p = fulfillmentInput.safeParse(body);
  if (!p.success) throw new Problem(422, 'Mirakl: podaj client_key, działanie (accept, tracking, ship) i numer zamówienia Mirakl');
  const b = p.data;
  let tracking: z.infer<typeof miraklTracking> | undefined;
  if (b.action === 'tracking') {
    const t = miraklTracking.safeParse(b.tracking);
    if (!t.success) throw new Problem(422, 'Mirakl: numer przesyłki i kod lub nazwa przewoźnika');
    tracking = t.data;
  } else ensure(b.tracking === undefined, 422, 'Mirakl: dane przesyłki tylko dla działania tracking');
  return tenantTx(a.tenantId, async c => {
    const ch = await channelInTx(c, channelId, true);
    const prior = (await c.query('SELECT 1 FROM mirakl262_operations WHERE client_key=$1', [b.client_key])).rowCount;
    if (!prior) writerFor(ch);
    const inbound = (await c.query('SELECT id,order_id,raw FROM inbound_orders WHERE channel_id=$1 AND external_id=$2', [channelId, b.order_id])).rows[0];
    ensure(inbound, 404, 'Zamówienie Mirakl nie jest w kolejce importu tego kanału; najpierw je odczytaj');
    const payload: Row = { action: b.action };
    if (b.action === 'accept') {
      if (!prior) ensure(inbound.raw?.order_state === 'WAITING_ACCEPTANCE', 409, 'Mirakl: ostatni odczyt nie pokazuje oczekiwania na akceptację; odczytaj zamówienie ponownie');
      const lines = (inbound.raw?.order_lines ?? []).map((l: Row) => l?.order_line_id).filter((v: unknown) => typeof v === 'string');
      ensure(lines.length > 0 && lines.length <= 100, 422, 'Mirakl: zamówienie bez pozycji');
      payload.line_ids = lines;
    }
    if (tracking) payload.tracking = tracking;
    return insertOperation(c, a, ch, { kind: b.action, target: b.order_id, client_key: b.client_key, request: { ...b, channelId }, payload, order_id: inbound.order_id, inbound_id: inbound.id });
  });
}

type Step = { op: Row; ch: MiraklChannel & Row };
async function loadStep(job: Row): Promise<Step | null> {
  const opId = z.uuid().parse(job.payload?.operation_id);
  return tenantTx(job.tenant_id, async c => {
    const op = (await c.query('SELECT * FROM mirakl262_operations WHERE id=$1 FOR UPDATE', [opId])).rows[0];
    if (!op || op.job_id !== job.id || !['queued', 'sending', 'sent', 'uncertain'].includes(op.state) || !(await leaseHeld(c, job))) { await finishJob(c, job); return null; }
    const ch = (await c.query('SELECT * FROM channels WHERE id=$1', [op.channel_id])).rows[0];
    const settle = async (reason: string) => {
      // Permanent cause: the write ends here (no new job, the target is free again). One that may have left says so.
      const left = op.state !== 'queued';
      await c.query(`UPDATE mirakl262_operations SET state='failed',outcome=$3,reason=$2,updated_at=now() WHERE id=$1`,
        [op.id, left ? reason + '; wynik u operatora niepewny — sprawdź zamówienie lub oferty w panelu operatora' : reason, left ? 'conflict' : 'refused']);
      await finishJob(c, job);
      return null;
    };
    if (!ch || ch.provider !== 'mirakl' || miraklChannelConnectionHash(ch) !== op.connection_hash) return settle('Połączenie kanału zmieniło się; zapis zatrzymano');
    if (!(await isAdmin(c, op.created_by))) return settle('Administrator, który zlecił zapis, utracił uprawnienia');
    if (op.state === 'sending') op.state = (await c.query("UPDATE mirakl262_operations SET state='uncertain',updated_at=now() WHERE id=$1 RETURNING state", [op.id])).rows[0].state;
    return { op, ch };
  });
}
/** One state change of the operation under its lock, only while this job still holds the lease. */
async function update(job: Row, op: Row, from: string[], set: Row, next: { requeue?: number; keep?: boolean; error?: string }) {
  await tenantTx(job.tenant_id, async c => {
    const cur = (await c.query('SELECT state,job_id FROM mirakl262_operations WHERE id=$1 FOR UPDATE', [op.id])).rows[0];
    ensure(cur && from.includes(cur.state) && cur.job_id === job.id && await leaseHeld(c, job), 409, 'Mirakl: operacja zmieniła się w trakcie zapisu');
    const keys = Object.keys(set);
    await c.query(`UPDATE mirakl262_operations SET ${keys.map((k, i) => k + '=$' + (i + 2)).join(',')},updated_at=now() WHERE id=$1`,
      [op.id, ...keys.map(k => set[k] !== null && typeof set[k] === 'object' ? JSON.stringify(set[k]) : set[k])]);
    if (next.keep) { /* the job keeps its lease: the HTTP call follows */ }
    else if (next.requeue !== undefined) await requeueJob(c, job, next.requeue); else await finishJob(c, job, next.error ?? null);
    if (set.state && ['applied', 'partial', 'failed'].includes(set.state))
      await insertAuditEvent(c, { tenantId: job.tenant_id, userId: op.created_by }, 'integration.mirakl.' + op.kind + '.' + set.state, op.id, { outcome: set.outcome ?? null, target: op.target });
  });
}
async function send({ op, ch }: Step, job: Row) {
  const w = writerFor(ch);
  // Own shop binding first (A01 under the shared once-a-day budget; cached), then mark 'sending' durably.
  await readerFor(ch, async () => {}).account();
  await update(job, op, ['queued'], { state: 'sending', attempts: op.attempts + 1 }, { keep: true });
  try {
    if (op.kind === 'offers') {
      const r = await w.submitOffers(op.payload.lines.map((l: Row) => ({ shop_sku: l.shop_sku, price_minor: l.price_minor, quantity: l.quantity })));
      await update(job, op, ['sending'], { state: 'sent', import_id: r.import_id, reason: null }, { requeue: 5 });
      return { state: 'sent' };
    }
    if (op.kind === 'accept') await w.acceptOrder(op.target, op.payload.line_ids);
    else if (op.kind === 'tracking') await w.setTracking(op.target, op.payload.tracking);
    else await w.shipOrder(op.target);
    await update(job, op, ['sending'], { state: 'applied', outcome: op.outcome === 'replayed' ? 'replayed' : 'acknowledged', reason: null }, {});
    return { state: 'applied' };
  } catch (e) {
    if (e instanceof MiraklWriteRefused) {
      await update(job, op, ['sending'], { state: 'failed', outcome: 'refused', reason: e.message }, {});
      return { state: 'failed' };
    }
    if (e instanceof MiraklWriteDeferred) {
      // 429: nothing applied; the same lines wait for the provider's Retry-After.
      await update(job, op, ['sending'], { state: 'queued', reason: 'Limit zapisu operatora; ponowienie po ' + e.seconds + ' s' }, { requeue: e.seconds });
      return { state: 'queued' };
    }
    await update(job, op, ['sending'], { state: 'uncertain', reason: 'Brak potwierdzenia od Mirakl; wynik zostanie uzgodniony odczytem',
      next_attempt_at: new Date(Date.now() + (op.kind === 'offers' ? runtime.offerReplayDelaySeconds : 0) * 1000).toISOString() }, { requeue: 60 });
    return { state: 'uncertain' };
  }
}
async function pollImport({ op, ch }: Step, job: Row) {
  const w = writerFor(ch);
  let st;
  try { st = await w.importStatus(op.import_id); }
  catch (e) {
    if (e instanceof MiraklWriteRefused) { await update(job, op, ['sent'], { state: 'failed', outcome: 'import_report', reason: e.message }, {}); return { state: 'failed' }; }
    await update(job, op, ['sent'], { reason: 'Odczyt statusu importu OF02 nieudany; ponowienie' }, { requeue: e instanceof MiraklWriteDeferred ? e.seconds : 60 });
    return { state: 'sent' };
  }
  if (!st.done && stale(op)) {
    await update(job, op, ['sent'], { state: 'failed', outcome: 'import_report', result: { status: st.status }, reason: 'Import OF24 nie zakończył się w 24 h; sprawdź import w panelu operatora' }, {});
    return { state: 'failed' };
  }
  if (!st.done) { await update(job, op, ['sent'], { result: { status: st.status } }, { requeue: 30 }); return { state: 'sent' }; }
  let errors: { shop_sku: string; message: string }[] = [];
  if (st.lines_in_error > 0 && st.has_error_report) { try { errors = await w.importErrors(op.import_id); } catch { errors = []; } }
  const result = { status: st.status, lines_read: st.lines_read, lines_in_success: st.lines_in_success, lines_in_error: st.lines_in_error, errors };
  const state = st.failed || st.lines_in_success === 0 && st.lines_in_error > 0 ? 'failed' : st.lines_in_error > 0 ? 'partial' : 'applied';
  await update(job, op, ['sent'], { state, outcome: 'import_report', result, reason: state === 'applied' ? null : 'Mirakl odrzucił część ofert (raport OF03)' }, {});
  return { state };
}
/** Readback after a lost answer: never a blind second write. Settled → final state; provably not applied → the
 * same lines are queued again (at most MAX_SENDS); unknown → stays uncertain and is read again later. */
async function reconcile({ op, ch }: Step, job: Row) {
  const guard = async () => { await guardTx(job.tenant_id, async c => {
    const cur = (await c.query('SELECT state,job_id FROM mirakl262_operations WHERE id=$1', [op.id])).rows[0];
    ensure(cur?.state === 'uncertain' && cur.job_id === job.id && await leaseHeld(c, job), 409, 'Mirakl: operacja zmieniła się');
  }); };
  const reader = readerFor(ch, guard);
  let verdict: 'applied' | 'replay' | 'conflict' | 'unknown';
  try {
    if (op.kind === 'offers') {
      verdict = 'applied';
      for (const l of op.payload.lines as Row[]) {
        const page = await reader.readOffers({ sku: l.shop_sku, max: 1 });
        const o = page.data.find(x => x.shop_sku === l.shop_sku);
        if (!o || miraklMoney(o.price) !== l.price_minor || o.quantity !== l.quantity) { verdict = 'replay'; break; }
      }
    } else {
      const r = await reader.readOrdersByIds({ order_ids: [op.target] });
      const state = r.data[0]?.order_state;
      if (!state) verdict = 'unknown';
      else if (op.kind === 'accept') verdict = state === 'WAITING_ACCEPTANCE' ? 'replay' : ['REFUSED', 'CANCELED', 'CLOSED'].includes(state) ? 'conflict' : 'applied';
      else if (op.kind === 'ship') verdict = state === 'SHIPPING' ? 'replay' : ['SHIPPED', 'TO_COLLECT', 'RECEIVED', 'CLOSED'].includes(state) ? 'applied' : 'conflict';
      // OR23 is a PUT of the same carrier and number: repeating it on a SHIPPING/SHIPPED order is idempotent.
      else verdict = ['SHIPPING', 'SHIPPED'].includes(state) ? 'replay' : 'conflict';
    }
  } catch (e) {
    const wait = e instanceof MiraklReadDeferred ? e.seconds : 120;
    await update(job, op, ['uncertain'], { reason: 'Uzgodnienie odczytem odroczone (wspólny limit odczytu lub brak odpowiedzi)' }, { requeue: wait });
    return { state: 'uncertain' };
  }
  if (verdict === 'applied') { await update(job, op, ['uncertain'], { state: 'applied', outcome: 'reconciled', reason: null }, {}); return { state: 'applied' }; }
  if (verdict === 'conflict') { await update(job, op, ['uncertain'], { state: 'failed', outcome: 'conflict', reason: 'Stan zamówienia u operatora nie pozwala na ten zapis' }, {}); return { state: 'failed' }; }
  if ((verdict === 'unknown' && stale(op)) || (verdict === 'replay' && op.attempts >= MAX_SENDS)) {
    await update(job, op, ['uncertain'], { state: 'failed', outcome: 'conflict', reason: verdict === 'unknown'
      ? 'Odczyt nie rozstrzygnął wyniku w 24 h; sprawdź w panelu operatora' : 'Wyczerpano ponowne wysyłki; sprawdź w panelu operatora' }, {});
    return { state: 'failed' };
  }
  if (verdict === 'unknown') {
    await update(job, op, ['uncertain'], { reason: 'Odczyt nie rozstrzygnął wyniku; ponowny odczyt później' }, { requeue: 300 });
    return { state: 'uncertain' };
  }
  // OF24 is an asynchronous import: before the delay the old values may only mean the first import still runs.
  const notBefore = op.next_attempt_at ? new Date(op.next_attempt_at).getTime() : 0;
  if (op.kind === 'offers' && notBefore > Date.now()) {
    await update(job, op, ['uncertain'], { reason: 'Import OF24 może jeszcze trwać; ponowny odczyt przed ponowną wysyłką' }, { requeue: Math.ceil((notBefore - Date.now()) / 1000) });
    return { state: 'uncertain' };
  }
  await update(job, op, ['uncertain'], { state: 'queued', outcome: 'replayed', reason: 'Odczyt pokazał brak zmiany; zapis zostanie wysłany ponownie' }, { requeue: 0 });
  return { state: 'queued' };
}
async function processWrite(job: Row) {
  const step = await loadStep(job);
  if (!step) return { state: 'stopped' };
  if (step.op.state === 'queued') return send(step, job);
  if (step.op.state === 'sent') return pollImport(step, job);
  return reconcile(step, job);
}
export async function reconcileMirakl262Operation(a: Actor, channelId: string, operationId: string) {
  requireAdmin(a); await requireInstalled();
  return tenantTx(a.tenantId, async c => {
    await channelInTx(c, channelId);
    const op = (await c.query('SELECT * FROM mirakl262_operations WHERE id=$1 AND channel_id=$2 FOR UPDATE', [operationId, channelId])).rows[0];
    ensure(op, 404, 'Nie znaleziono operacji Mirakl');
    ensure(op.state === 'uncertain', 409, 'Uzgodnienie dotyczy tylko zapisu bez potwierdzenia');
    if (op.job_id) await c.query("UPDATE jobs SET run_at=now() WHERE id=$1 AND state='pending'", [op.job_id]);
    return { operation: operationView(op) };
  });
}

// ---- worker entry points -----------------------------------------------------------------------------------
export async function processMirakl262Job(job: Row): Promise<Row> {
  if (job.kind === MIRAKL262_ORDERS_JOB) return processOrders(job);
  ensure(job.kind === MIRAKL262_WRITE_JOB, 422, 'Nieobsługiwane zadanie Mirakl');
  return processWrite(job);
}
/** Unexpected failure of a run: the durable checkpoint/operation is the truth; the job is retried with backoff. */
export async function failMirakl262Job(job: Row, error: unknown): Promise<void> {
  const message = error instanceof Problem && error.status < 500 ? error.message.slice(0, 300) : 'Błąd zadania Mirakl; stan zostanie odczytany ponownie';
  await tenantTx(job.tenant_id, c => c.query(`UPDATE jobs SET state=CASE WHEN attempts>=max_attempts THEN 'failed' ELSE 'pending' END,error=$3,lease_token=NULL,locked_at=NULL,
    run_at=now()+make_interval(secs=>least(300,30*attempts)) WHERE id=$1 AND lease_token=$2`, [job.id, job.lease_token, message]));
}

// ---- webhooks.receive --------------------------------------------------------------------------------------
export async function rotateMirakl262Webhook(a: Actor, channelId: string) {
  requireAdmin(a); await requireInstalled();
  const token = randomBytes(32).toString('base64url');
  return tenantTx(a.tenantId, async c => {
    await channelInTx(c, channelId, true);
    const hash = sha(token);
    const row = (await c.query(`INSERT INTO mirakl262_webhook_endpoints(id,tenant_id,channel_id,token_sha256,created_by) VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(tenant_id,channel_id) DO UPDATE SET token_sha256=EXCLUDED.token_sha256,enabled=true,version=mirakl262_webhook_endpoints.version+1,updated_at=now() RETURNING id,version`,
      [randomUUID(), a.tenantId, channelId, hash, a.userId])).rows[0];
    await insertAuditEvent(c, a, 'integration.mirakl.webhook.rotated', channelId, { endpoint_id: row.id, version: row.version });
    // The only time the token is shown; the database keeps its hash.
    return { id: row.id, version: row.version, path: '/callbacks/mirakl/' + row.id + '/' + token };
  });
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const eventSchema = z.object({ id: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/).optional(), event_id: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/).optional(),
  type: z.string().regex(/^[A-Za-z0-9._:-]{1,80}$/) }).refine(v => v.id || v.event_id);
export type Mirakl262WebhookInput = { endpointId: string; token: string; contentType: string | undefined; raw: Buffer };
/** Returns only the HTTP status; no body, provider data or database detail leaves this function. */
export async function handleMirakl262Webhook(i: Mirakl262WebhookInput, readOnly: boolean): Promise<number> {
  if (readOnly) return 423;
  if (!UUID.test(i.endpointId) || !/^[A-Za-z0-9_-]{43}$/.test(i.token)) return 404;
  if (!(await mirakl262Available())) return 404;
  const ep = (await pool.query('SELECT id,tenant_id,channel_id,token_sha256,enabled FROM mirakl262_webhook_endpoints WHERE id=$1', [i.endpointId])).rows[0];
  if (!ep || !ep.enabled) return 404;
  if (!timingSafeEqual(Buffer.from(ep.token_sha256, 'hex'), Buffer.from(sha(i.token), 'hex'))) return 404;
  if ((i.contentType ?? '').split(';')[0].trim().toLowerCase() !== 'application/json') return 415;
  if (i.raw.length === 0 || i.raw.length > MIRAKL262_WEBHOOK_MAX_BYTES) return 413;
  let parsed: z.infer<typeof eventSchema>;
  try {
    const r = eventSchema.safeParse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(i.raw)));
    if (!r.success) return 400;
    parsed = r.data;
  } catch { return 400; }
  const eventId = (parsed.event_id ?? parsed.id)!;
  return tenantTx(ep.tenant_id, async c => {
    // One endpoint at a time: the per-minute and per-day counts are not racy.
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['mirakl262-webhook:' + ep.id]);
    const daily = (await c.query("SELECT count(*)::int n FROM mirakl262_webhook_events WHERE endpoint_id=$1 AND received_at>now()-interval '1 day'", [ep.id])).rows[0].n;
    const recent = (await c.query("SELECT count(*)::int n FROM mirakl262_webhook_events WHERE endpoint_id=$1 AND received_at>now()-interval '1 minute'", [ep.id])).rows[0].n;
    const dup = (await c.query('SELECT 1 FROM mirakl262_webhook_events WHERE endpoint_id=$1 AND event_id=$2', [ep.id, eventId])).rowCount;
    if (dup) return 200;
    if (recent >= WEBHOOK_EVENTS_PER_MINUTE || daily >= WEBHOOK_EVENTS_PER_DAY) return 429;
    const orderEvent = /ORDER/i.test(parsed.type);
    const inserted = (await c.query(`INSERT INTO mirakl262_webhook_events(id,tenant_id,endpoint_id,event_id,event_type,body_sha256,outcome) VALUES($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT(tenant_id,endpoint_id,event_id) DO NOTHING`, [randomUUID(), ep.tenant_id, ep.id, eventId, parsed.type, createHash('sha256').update(i.raw).digest('hex'), orderEvent ? 'sync_requested' : 'recorded'])).rowCount;
    // The event is a hint only: the order data always comes from the next OR11 read under the shared budget.
    if (inserted && orderEvent) await c.query("UPDATE mirakl262_schedules SET next_run_at=least(next_run_at,now()),updated_at=now() WHERE channel_id=$1 AND enabled", [ep.channel_id]);
    return 200;
  });
}

// ---- simulation seed (DYNA_MIRAKL_FAKE=local only) ----------------------------------------------------------
const seedInput = z.strictObject({ product_ids: z.array(z.uuid()).max(20).default([]) });
/** SYMULACJA: offers for the given local products (price 1,00 zł, stock 0) and two orders on the channel's fake. */
export async function seedMirakl262Simulation(a: Actor, channelId: string, body: unknown) {
  requireAdmin(a); await requireInstalled();
  ensure(runtime.simulation, 404, 'Nie znaleziono');
  const b = seedInput.parse(body ?? {});
  const { ch, products } = await tenantReadTx(a.tenantId, async c => ({ ch: await channelInTx(c, channelId),
    products: (await c.query('SELECT sku,name,price FROM products WHERE id=ANY($1::uuid[])', [b.product_ids])).rows }));
  const settings = parseMiraklSettings(ch.settings), key = parseMiraklCredentials(decrypt(ch.credentials)).api_key;
  const fake = mirakl262SimulationFake(settings.instance_url, settings.shop_id, key);
  for (const p of products) if (!fake.offers.has(p.sku)) fake.addOffer({ shop_sku: p.sku, price: 1, quantity: 0, title: p.name });
  const skus = products.length ? products.map(p => p.sku) : ['SYM-1'];
  const n = fake.orders.size + 1, tag = channelId.slice(0, 4).toUpperCase();
  fake.addOrder({ order_id: `SYM-${tag}-${n}-A`, state: 'WAITING_ACCEPTANCE', lines: [{ sku: skus[0], quantity: 1, price: products[0] ? miraklPrice(products[0].price) : 49.9 }] });
  fake.addOrder({ order_id: `SYM-${tag}-${n + 1}-S`, state: 'SHIPPING', lines: skus.slice(0, 2).map((s, k) => ({ sku: s, quantity: 2, price: products[k] ? miraklPrice(products[k].price) : 19.99 })) });
  return { offers: fake.offers.size, orders: [...fake.orders.values()].map(o => ({ order_id: o.order_id, state: o.order_state })) };
}
