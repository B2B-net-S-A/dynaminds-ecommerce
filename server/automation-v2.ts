/**
 * Automation rules v2 engine (Uwagi v3 §0): Conditions → Effects (shared/automation-v2.ts).
 *
 * Flow: every order event queues one `automation.v2` job (server/automation-v2-triggers.ts). The job, after the
 * change is committed, loads the order context once and walks the enabled rules of the event's triggers in
 * priority order. 'order.matches' rules fire only when the order newly meets the conditions (per rule+order state
 * kept in an inert `automation.v2.state` job row); event rules fire when their conditions hold. A firing rule gets
 * an automation_runs row and an `automation.v2.run` job at event time + delay, moved to the next working-hours
 * opening (Europe/Warsaw). The run re-checks the rule and its conditions, then applies all effects in one savepoint
 * and writes the order history entry "Reguła <name>: …". Loop protection: no rule twice in a chain, depth 8,
 * 100 runs per chain.
 */
import { createHmac, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { AutomationRuleInput, AutomationRuleV2, AutomationRunSummary, AutomationTestResult, EffectSpec } from '../shared/automation-v2';
import { localConfig, pool, tenantTx } from './db';
import { ensure, Problem } from './errors';
import { audit, type Actor } from './domain';
import { localOrderEvent } from './events';
import { lockEmailQueue } from './email-actions';
import { isLocalFinancialVersion } from './local-financial-policy';
import { evaluate, nextOpening } from './automation-v2-eval';
import { fieldMeta } from './automation-v2-fields';
import { contextSummary, loadOrderContexts } from './automation-v2-context';
import { applyEffect, describeEffect, EMAIL_EFFECTS, type EffectResult } from './automation-v2-effects';
import { automationChain, statusChangeMatches, V2_JOB, V2_PREFIX, V2_RUN_JOB, type ChainContext } from './automation-v2-triggers';

export const DEPTH_LIMIT = 8;
export const CHAIN_LIMIT = 100;
const STATE_JOB = 'automation.v2.state';

type Row = Record<string, any>;
type RunSource = AutomationRunSummary['source'];

/** Printable code of a rule: 'AR-' + 10 hex chars of an HMAC with the local secret (not guessable from the id). */
export function barcodeFor(tenantId: string, ruleId: string): string {
  return 'AR-' + createHmac('sha256', localConfig.encryptionKey).update(`automation-v2:${tenantId}:${ruleId}`).digest('hex').slice(0, 10).toUpperCase();
}

export function isV2Row(r: Row) {
  return typeof r.trigger === 'string' && r.trigger.startsWith(V2_PREFIX) && r.config?.version === 2;
}

export function ruleFromRow(r: Row): AutomationRuleV2 {
  const { deleted: _deleted, ...config } = r.config;
  return {
    id: r.id,
    name: r.name,
    trigger: r.trigger.slice(V2_PREFIX.length),
    enabled: r.enabled,
    config,
    priority: r.priority,
    version: Number(r.version),
    updated_at: new Date(r.updated_at).toISOString(),
    barcode: r.config.run?.barcode ? barcodeFor(r.tenant_id, r.id) : null,
  };
}

export const ruleInput = (r: Row): AutomationRuleInput => {
  const v = ruleFromRow(r);
  return { name: v.name, trigger: v.trigger, enabled: v.enabled, config: v.config };
};

export function runSummary(r: Row): AutomationRunSummary {
  return {
    id: r.id,
    rule_id: r.rule_id,
    rule_name: r.definition?.name ?? r.rule_name ?? '',
    order_id: r.order_id ?? null,
    order_number: r.number ?? r.snapshot?.number ?? null,
    source: (r.definition?.source ?? 'auto') as RunSource,
    status: r.state,
    reason: r.result?.reason ?? null,
    error: r.error ?? null,
    created_at: new Date(r.created_at).toISOString(),
  };
}

async function memberRole(tenantId: string, userId: string | null | undefined) {
  if (!userId) return null;
  return (await pool.query('SELECT role FROM memberships WHERE tenant_id=$1 AND user_id=$2', [tenantId, userId])).rows[0]?.role ?? null;
}

async function fenced(c: PoolClient, job: Row) {
  return (
    await c.query("SELECT id FROM jobs WHERE id=$1 AND state='running' AND lease_token=$2 FOR UPDATE", [job.id, job.lease_token])
  ).rowCount;
}

const finishJob = (c: PoolClient, id: string) =>
  c.query("UPDATE jobs SET state='done',error=NULL,lease_token=NULL,locked_at=NULL WHERE id=$1", [id]);

/** Previous 'order.matches' result of a rule for an order; stores the new one. */
async function flipState(c: PoolClient, tenantId: string, ruleId: string, orderId: string, matched: boolean): Promise<boolean> {
  const key = `v2state:${ruleId}:${orderId}`;
  const prev = (await c.query('SELECT payload FROM jobs WHERE dedup_key=$1 FOR UPDATE', [key])).rows[0];
  if (!prev)
    await c.query("INSERT INTO jobs(id,tenant_id,kind,payload,dedup_key,state) VALUES($1,$2,$3,$4,$5,'done')", [
      randomUUID(),
      tenantId,
      STATE_JOB,
      JSON.stringify({ matched }),
      key,
    ]);
  else if (prev.payload.matched !== matched)
    await c.query('UPDATE jobs SET payload=$2 WHERE dedup_key=$1', [key, JSON.stringify({ matched })]);
  return Boolean(prev?.payload.matched);
}

function definitionOf(rule: Row, actorId: string, source: RunSource) {
  return {
    engine: 'v2',
    name: rule.name,
    trigger: rule.trigger.slice(V2_PREFIX.length),
    config: rule.config,
    actor_id: actorId,
    source,
  };
}

async function insertRun(
  c: PoolClient,
  tenantId: string,
  rule: Row,
  eventId: string,
  orderId: string,
  jobId: string,
  definition: Row,
  snapshot: unknown,
  context: ChainContext,
  state: 'queued' | 'skipped' = 'queued',
  result: unknown = null,
  id: string = randomUUID(),
) {
  await c.query(
    `INSERT INTO automation_runs(id,tenant_id,rule_id,rule_version,event_id,order_id,job_id,definition,snapshot,context,state,result,finished_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,CASE WHEN $11='queued' THEN NULL ELSE now() END)`,
    [id, tenantId, rule.id, rule.version, eventId, orderId, jobId, JSON.stringify(definition), JSON.stringify(snapshot), JSON.stringify(context), state, result === null ? null : JSON.stringify(result)],
  );
  return id;
}

/** `automation.v2` job: decide which rules fire for one order event. */
export async function dispatchV2(job: Row) {
  return tenantTx(job.tenant_id, async (c) => {
    if (!(await fenced(c, job))) return;
    const p = job.payload;
    // A time check carries many orders (one job per tenant and 5 minutes); an order event carries one.
    const orders: string[] = Array.isArray(p.order_ids) ? p.order_ids : [p.order_id];
    for (const orderId of orders) await dispatchOrder(c, job, { ...p, order_id: orderId, context: orders.length > 1 ? { chain_id: randomUUID(), depth: 0, trace: [] } : p.context });
    return finishJob(c, job.id);
  });
}

async function dispatchOrder(c: PoolClient, job: Row, p: Row): Promise<void> {
  const chain: ChainContext = p.context ?? { chain_id: randomUUID(), depth: 0, trace: [] };
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`automation-v2-order:${job.tenant_id}:${p.order_id}`]);
  let eventId: string | null = p.event_id ?? null;
  const event = eventId ? (await c.query('SELECT id,created_at FROM order_events WHERE id=$1 AND order_id=$2', [eventId, p.order_id])).rows[0] : null;
  if (eventId && !event) return;
  const triggers = new Set<string>(p.triggers ?? []);
  if (triggers.has('order.all_scanned')) {
    const s = (await c.query('SELECT count(*)::int n,count(*) FILTER(WHERE scanned<quantity)::int open FROM order_pick_items WHERE order_id=$1', [p.order_id])).rows[0];
    if (!s.n || s.open) triggers.delete('order.all_scanned');
  }
  const rules = (
    await c.query(
      "SELECT * FROM automation_rules WHERE enabled AND trigger=ANY($1::text[]) AND config->>'version'='2' ORDER BY priority,id LIMIT 100",
      [[...triggers].map((t) => V2_PREFIX + t)],
    )
  ).rows.filter((r) => !r.config.deleted && r.config.run?.auto);
  if (!rules.length) return;
  const ctx = (await loadOrderContexts(c, [p.order_id])).get(p.order_id);
  if (!ctx) return;
  const now = Date.now();
  let scheduled = (
    await c.query("SELECT count(*)::int n FROM automation_runs WHERE context->>'chain_id'=$1 AND definition->>'engine'='v2'", [chain.chain_id])
  ).rows[0].n;
  const snapshot = contextSummary(ctx);
  // A time check has no order event of its own; the first firing rule records one.
  const ensureEvent = async () => {
    if (!eventId) eventId = await localOrderEvent(c, job.tenant_id, p.order_id, 'automation.time_check', { kind: p.kind });
    const at = event?.created_at ? new Date(event.created_at).getTime() : now;
    return { id: eventId, at };
  };
  for (const rule of rules) {
    if (chain.trace.includes(rule.id)) continue;
    const cfg = rule.config;
    const result = evaluate(cfg.conditions, ctx, fieldMeta, now);
    if (rule.trigger === V2_PREFIX + 'order.matches' || rule.trigger === V2_PREFIX + 'time.schedule') {
      const before = await flipState(c, job.tenant_id, rule.id, p.order_id, result.matched);
      if (!result.matched || before) continue;
    } else if (!result.matched) continue;
    // "Z wybranego statusu na wybrany": the job carries the status changes of its transaction.
    if (rule.trigger === V2_PREFIX + 'order.status_changed' && !statusChangeMatches(cfg.status_change, p.status_changes)) continue;
    if (
      cfg.run.mode === 'once' &&
      (await c.query("SELECT 1 FROM automation_runs WHERE rule_id=$1 AND order_id=$2 AND state IN ('queued','done') LIMIT 1", [rule.id, p.order_id])).rowCount
    )
      continue;
    const ev = await ensureEvent();
    const definition = definitionOf(rule, rule.actor_id, p.kind === 'time.tick' ? 'schedule' : rule.trigger === V2_PREFIX + 'order.matches' ? 'auto' : 'event');
    if (chain.depth >= DEPTH_LIMIT || scheduled >= CHAIN_LIMIT) {
      const reason = chain.depth >= DEPTH_LIMIT ? 'Zatrzymano łańcuch 8 zdarzeń' : `Limit ${CHAIN_LIMIT} wykonań w łańcuchu zdarzeń`;
      await insertRun(c, job.tenant_id, rule, ev.id, p.order_id, job.id, definition, snapshot, chain, 'skipped', { matched: true, reason });
      break;
    }
    if ((await c.query('SELECT 1 FROM automation_runs WHERE event_id=$1 AND rule_id=$2 AND rule_version=$3', [ev.id, rule.id, rule.version])).rowCount) continue;
    const runAt = nextOpening(ev.at + (cfg.run.delay_minutes ?? 0) * 60_000, cfg.run.hours);
    const jid = randomUUID(),
      runId = randomUUID();
    await c.query('INSERT INTO jobs(id,tenant_id,kind,payload,dedup_key,run_at,priority) VALUES($1,$2,$3,$4,$5,$6,$7)', [
      jid,
      job.tenant_id,
      V2_RUN_JOB,
      JSON.stringify({ run_id: runId }),
      `v2:run:${ev.id}:${rule.id}:${rule.version}`,
      new Date(runAt),
      rule.priority,
    ]);
    await insertRun(c, job.tenant_id, rule, ev.id, p.order_id, jid, definition, snapshot, chain, 'queued', null, runId);
    scheduled++;
    if (cfg.stop_further) break;
  }
}

interface ExecuteOptions {
  actor: Actor;
  /** Skip the condition re-check (never used by automatic runs). */
  force?: boolean;
}

/** Applies a queued run inside the caller's transaction and records its outcome. */
async function executeRun(c: PoolClient, run: Row, rule: Row, opts: ExecuteOptions): Promise<{ state: string; reason: string | null; error: string | null }> {
  const chain: ChainContext = run.context ?? { chain_id: randomUUID(), depth: 0, trace: [] };
  const cfg = rule.config;
  let reason: string | null = null;
  const ctx = (await loadOrderContexts(c, [run.order_id])).get(run.order_id);
  if (!ctx) reason = 'Nie znaleziono zamówienia';
  else if (chain.depth >= DEPTH_LIMIT || chain.trace.includes(rule.id)) reason = 'Zatrzymano powtarzającą się regułę lub łańcuch 8 zdarzeń';
  else if (run.definition.trigger !== 'customer_message.received' && (await isLocalFinancialVersion(c, run.order_id)))
    reason = 'Bieżąca wersja zamówienia wynika z lokalnego rozliczenia';
  const check = ctx ? evaluate(cfg.conditions, ctx, fieldMeta) : null;
  if (!reason && !opts.force && check && !check.matched) reason = 'Warunki nie są spełnione w chwili wykonania';
  let state = reason ? 'skipped' : 'done',
    error: string | null = null;
  const results: EffectResult[] = [];
  if (!reason) {
    const inner: ChainContext = { chain_id: chain.chain_id, depth: chain.depth + 1, trace: [...chain.trace, rule.id] };
    await c.query('SAVEPOINT v2_rule_effects');
    try {
      await automationChain.run(inner, async () => {
        const apply = async (r: Row, effects: EffectSpec[], trace: ChainContext): Promise<string[]> => {
          const out: string[] = [];
          for (const [i, e] of effects.entries()) {
            const res = await applyEffect(
              {
                c,
                actor: opts.actor,
                orderId: run.order_id,
                runId: run.id,
                rule: { id: r.id, name: r.name },
                context: { ...trace },
                runRule: async (ruleId) => {
                  const target = (await c.query("SELECT * FROM automation_rules WHERE id=$1 AND enabled AND config->>'version'='2'", [ruleId])).rows[0];
                  ensure(target && !target.config.deleted, 422, 'Uruchamiana reguła jest wyłączona lub usunięta');
                  ensure(!trace.trace.includes(target.id) && trace.depth < DEPTH_LIMIT, 409, 'Reguła już działa w tym łańcuchu');
                  const tctx = (await loadOrderContexts(c, [run.order_id])).get(run.order_id)!;
                  if (!evaluate(target.config.conditions, tctx, fieldMeta).matched) return `Reguła ${target.name}: warunki niespełnione`;
                  const nested: ChainContext = { ...trace, depth: trace.depth + 1, trace: [...trace.trace, target.id] };
                  const msgs = await automationChain.run(nested, () => apply(target, target.config.effects, nested));
                  return `Reguła ${target.name}: ${msgs.join('; ')}`;
                },
              },
              e,
              i,
            );
            results.push(res);
            out.push(res.message);
          }
          return out;
        };
        await apply(rule, cfg.effects, inner);
      });
      await c.query('RELEASE SAVEPOINT v2_rule_effects');
    } catch (e) {
      await c.query('ROLLBACK TO SAVEPOINT v2_rule_effects');
      await c.query('RELEASE SAVEPOINT v2_rule_effects');
      if (!(e instanceof Problem)) throw e;
      state = 'failed';
      error = e.message;
      results.length = 0;
    }
  }
  await c.query('UPDATE automation_runs SET state=$2,result=$3,error=$4,finished_at=now() WHERE id=$1', [
    run.id,
    state,
    JSON.stringify({ matched: check?.matched ?? false, reason, effects: results, conditions: check?.conditions ?? [] }),
    error,
  ]);
  if (state !== 'skipped')
    await localOrderEvent(c, opts.actor.tenantId, run.order_id, 'automation.rule_applied', {
      rule_id: rule.id,
      rule_name: rule.name,
      run_id: run.id,
      source: run.definition.source,
      state,
      message:
        state === 'done'
          ? `Reguła ${rule.name}: ${results.map((r) => r.message).join('; ') || 'bez zmian'}`
          : `Reguła ${rule.name}: nie wykonano — ${error}`,
    });
  await audit(c, opts.actor, state === 'done' ? 'automation.executed' : 'automation.' + state, rule.id, {
    engine: 'v2',
    runId: run.id,
    orderId: run.order_id,
    version: String(run.rule_version),
    reason,
    error,
  });
  return { state, reason, error };
}

const needsEmailLock = (rule: Row) => (rule.config.effects ?? []).some((e: EffectSpec) => EMAIL_EFFECTS.has(e.type) || e.type === 'run_rule');

/** `automation.v2.run` job: applies one queued run as the rule's author. */
export async function processV2Run(job: Row) {
  const run = await tenantTx(job.tenant_id, async (c) => (await c.query('SELECT * FROM automation_runs WHERE id=$1', [job.payload.run_id])).rows[0]);
  ensure(run, 404, 'Nie znaleziono wykonania reguły');
  const role = await memberRole(job.tenant_id, run.definition.actor_id);
  return tenantTx(job.tenant_id, async (c) => {
    if (needsEmailLock({ config: run.definition.config })) await lockEmailQueue(c, job.tenant_id);
    if (!(await fenced(c, job))) return;
    const current = (await c.query('SELECT * FROM automation_runs WHERE id=$1 FOR UPDATE', [run.id])).rows[0];
    ensure(current.state === 'queued' && current.job_id === job.id, 409, 'Nieaktualne wykonanie reguły');
    const rule = (await c.query('SELECT * FROM automation_rules WHERE id=$1 FOR SHARE', [run.rule_id])).rows[0];
    const actor: Actor = { tenantId: job.tenant_id, userId: run.definition.actor_id, role: 'admin' };
    let reason: string | null = null;
    if (!rule?.enabled || rule.config?.deleted || String(rule.version) !== String(run.rule_version)) reason = 'Reguła wyłączona lub zmieniona po zdarzeniu';
    else if (role !== 'admin') reason = 'Autor reguły nie ma już uprawnień administratora';
    if (reason) {
      await c.query("UPDATE automation_runs SET state='skipped',result=$2,finished_at=now() WHERE id=$1", [run.id, JSON.stringify({ matched: false, reason })]);
    } else await executeRun(c, current, rule, { actor });
    await finishJob(c, job.id);
  });
}

export async function failV2(job: Row, e: unknown) {
  const message = e instanceof Problem ? e.message : 'Błąd wykonania automatyzacji';
  return tenantTx(job.tenant_id, async (c) => {
    const changed = (
      await c.query(
        "UPDATE jobs SET state=CASE WHEN attempts>=max_attempts OR $4 THEN 'failed' ELSE 'pending' END,error=$3,lease_token=NULL,locked_at=NULL,run_at=now()+interval '10 seconds' WHERE id=$1 AND lease_token=$2 AND state='running' RETURNING state",
        [job.id, job.lease_token, message, e instanceof Problem && [403, 404, 409, 422].includes(e.status)],
      )
    ).rows[0];
    if (changed?.state === 'failed' && job.kind === V2_RUN_JOB)
      await c.query("UPDATE automation_runs SET state='failed',error=$2,finished_at=now() WHERE id=$1 AND job_id=$3 AND state='queued'", [job.payload.run_id, message, job.id]);
  });
}

/** Manual button, list action or barcode: runs the rule now for each order, as the person who asked. */
export async function runNow(c: PoolClient, actor: Actor, rule: Row, orderIds: string[], source: 'manual' | 'barcode'): Promise<AutomationRunSummary[]> {
  ensure(rule && isV2Row(rule) && !rule.config.deleted, 404, 'Nie znaleziono reguły');
  ensure(rule.enabled, 409, 'Reguła jest wyłączona');
  ensure(source === 'manual' ? rule.config.run.manual_button : rule.config.run.barcode, 409, source === 'manual' ? 'Reguła nie ma przycisku ręcznego uruchomienia' : 'Reguła nie ma kodu kreskowego');
  if (needsEmailLock(rule)) await lockEmailQueue(c, actor.tenantId);
  const orders = (await c.query('SELECT id,number FROM orders WHERE id=ANY($1::uuid[]) ORDER BY id', [orderIds])).rows;
  ensure(orders.length === new Set(orderIds).size, 404, 'Nie znaleziono wszystkich zamówień w tej organizacji');
  const out: AutomationRunSummary[] = [];
  for (const o of orders) {
    const chain: ChainContext = { chain_id: randomUUID(), depth: 0, trace: [] };
    const eventId = await localOrderEvent(c, actor.tenantId, o.id, 'automation.manual_run', { rule_id: rule.id, source });
    const jid = randomUUID(),
      runId = randomUUID();
    await c.query("INSERT INTO jobs(id,tenant_id,kind,payload,dedup_key,state) VALUES($1,$2,$3,$4,$5,'done')", [jid, actor.tenantId, V2_RUN_JOB, JSON.stringify({ run_id: runId }), 'v2:manual:' + jid]);
    const ctx = (await loadOrderContexts(c, [o.id])).get(o.id)!;
    await insertRun(c, actor.tenantId, rule, eventId, o.id, jid, definitionOf(rule, actor.userId, source), contextSummary(ctx), chain, 'queued', null, runId);
    const run = (await c.query('SELECT * FROM automation_runs WHERE id=$1 FOR UPDATE', [runId])).rows[0];
    await executeRun(c, run, rule, { actor });
    const row = (await c.query('SELECT r.*,o.number FROM automation_runs r JOIN orders o ON (o.tenant_id,o.id)=(r.tenant_id,r.order_id) WHERE r.id=$1', [runId])).rows[0];
    out.push(runSummary(row));
  }
  return out;
}

/** Test mode: conditions and the effects that would run, nothing applied. */
export async function testRule(c: PoolClient, rule: AutomationRuleInput, orderId: string, ruleId?: string): Promise<AutomationTestResult> {
  const ctx = (await loadOrderContexts(c, [orderId])).get(orderId);
  ensure(ctx, 404, 'Nie znaleziono zamówienia');
  const r = evaluate(rule.config.conditions, ctx, fieldMeta);
  const names = await referenceNames(c, rule.config.effects);
  return {
    matched: r.matched,
    conditions: r.conditions,
    effects: rule.config.effects.map((e) => ({
      type: e.type,
      would: (r.matched ? '' : 'Nie wykona (warunki niespełnione): ') + describeEffect(e, names) + (e.type === 'run_rule' && e.params.rule_id === ruleId ? ' (ta sama reguła)' : ''),
    })),
  };
}

async function referenceNames(c: PoolClient, effects: EffectSpec[]) {
  const ids = effects.flatMap((e) => Object.values(e.params ?? {}).filter((v): v is string => typeof v === 'string' && /^[0-9a-f-]{36}$/.test(v)));
  if (!ids.length) return {};
  const rows = (
    await c.query(
      `SELECT id::text,name FROM workflow_statuses WHERE id=ANY($1::uuid[]) UNION ALL SELECT id::text,name FROM email_templates WHERE id=ANY($1::uuid[])
       UNION ALL SELECT id::text,name FROM sms_templates WHERE id=ANY($1::uuid[]) UNION ALL SELECT id::text,name FROM automation_rules WHERE id=ANY($1::uuid[])
       UNION ALL SELECT id::text,label FROM order_field_definitions WHERE id=ANY($1::uuid[]) UNION ALL SELECT id::text,name FROM outbound_subscriptions WHERE id=ANY($1::uuid[])
       UNION ALL SELECT id::text,name FROM warehouses WHERE id=ANY($1::uuid[])`,
      [ids],
    )
  ).rows;
  return Object.fromEntries(rows.map((r) => [r.id, r.name]));
}

export const PREVIEW_SCAN = 500;
/** Preview over the most recent orders (bounded); counts matching orders and returns up to 20 of them. */
export async function previewRule(c: PoolClient, rule: AutomationRuleInput, limit = PREVIEW_SCAN) {
  const ids = (await c.query('SELECT id FROM orders ORDER BY created_at DESC,id DESC LIMIT $1', [limit + 1])).rows.map((r) => r.id);
  const capped = ids.length > limit;
  const scan = ids.slice(0, limit);
  let matching = 0;
  const sample: Array<{ id: string; number: string }> = [];
  const now = Date.now();
  for (let i = 0; i < scan.length; i += 100) {
    const contexts = await loadOrderContexts(c, scan.slice(i, i + 100));
    for (const id of scan.slice(i, i + 100)) {
      const ctx = contexts.get(id);
      if (!ctx || !evaluate(rule.config.conditions, ctx, fieldMeta, now).matched) continue;
      matching++;
      if (sample.length < 20) sample.push({ id, number: ctx.number });
    }
  }
  return { matching, sample, scanned: scan.length, capped };
}

/**
 * Periodic check of time-dependent rules ('time.schedule' and 'order.matches'): queues one evaluation of a page of
 * open orders. A per-tenant cursor walks all open orders by id, so an order nobody touched for weeks (e.g.
 * "Dostarczone → Zakończone po 14 dniach") is reached too; after the last page the cursor starts over.
 */
let lastTimeCheck = 0;
const timeCursor = new Map<string, string | null>();
export async function scheduleV2TimeChecks(tenants?: readonly string[] | null, force = false, pageSize = 100) {
  // The worker loop ticks every second; time conditions are checked at most once a minute.
  if (!force && Date.now() - lastTimeCheck < 60_000) return;
  lastTimeCheck = Date.now();
  const due = (
    await pool.query(
      `SELECT DISTINCT tenant_id FROM automation_rules WHERE enabled AND trigger IN ('v2:time.schedule','v2:order.matches')
       AND ($1::uuid[] IS NULL OR tenant_id=ANY($1::uuid[])) LIMIT 50`,
      [tenants ? [...tenants] : null],
    )
  ).rows;
  const minute = Math.floor(Date.now() / 60_000);
  for (const t of due)
    await tenantTx(t.tenant_id, async (c) => {
      const timed = (
        await c.query(
          `SELECT 1 FROM automation_rules WHERE enabled AND (trigger='v2:time.schedule' OR (trigger='v2:order.matches' AND config::text ~ '"(older_than|newer_than|within_last|weekday_in|hour_between)"')) LIMIT 1`,
        )
      ).rowCount;
      if (!timed) return;
      const cursor = timeCursor.get(t.tenant_id) ?? null;
      const open = "status NOT IN ('completed','cancelled','return_completed')";
      // Recently changed orders react within a minute; the cursor page reaches the ones nobody touched.
      const recent = (await c.query(`SELECT id FROM orders WHERE ${open} ORDER BY updated_at DESC,id LIMIT $1`, [pageSize])).rows;
      const page = (
        await c.query(`SELECT id FROM orders WHERE ${open} AND ($1::uuid IS NULL OR id>$1::uuid) ORDER BY id LIMIT $2`, [cursor, pageSize])
      ).rows;
      const orders = [...new Map([...recent, ...page].map((o) => [o.id as string, o])).values()];
      if (!orders.length) {
        timeCursor.set(t.tenant_id, null);
        return;
      }
      const queued = await c.query('INSERT INTO jobs(id,tenant_id,kind,payload,dedup_key) VALUES($1,$2,$3,$4,$5) ON CONFLICT (tenant_id,dedup_key) DO NOTHING', [
        randomUUID(),
        t.tenant_id,
        V2_JOB,
        JSON.stringify({ event_id: null, order_ids: orders.map((o) => o.id), kind: 'time.tick', triggers: ['order.matches', 'time.schedule'], context: { chain_id: randomUUID(), depth: 0, trace: [] } }),
        `v2:tick:${minute}:${cursor ?? 'start'}`,
      ]);
      // The cursor moves only when this page was queued; a short page means the walk is complete.
      if (queued.rowCount) timeCursor.set(t.tenant_id, page.length < pageSize ? null : page[page.length - 1].id);
    });
}
