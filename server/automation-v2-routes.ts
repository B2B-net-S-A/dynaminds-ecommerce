/** HTTP API of automation rules v2 (contract header of shared/automation-v2.ts), under /api/automations/v2. */
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AutomationRuleInput, AutomationRuleVersion, ValueType } from '../shared/automation-v2';
import { tenantReadTx, tenantTx } from './db';
import { ensure } from './errors';
import { ensureAutomationEditor } from './automation-editors';
import { audit, type Actor } from './domain';
import { EXTRA_FIELD_PREFIX } from './automation-v2-fields';
import { MAX_RULES, parseRuleV2 } from './automation-v2-schema';
import { validateEffectsInTx } from './automation-v2-effects';
import { buildCatalog, ensureDefaultRulesInTx } from './automation-v2-catalog';
import { barcodeFor, isV2Row, previewRule, ruleFromRow, ruleInput, runNow, runSummary, testRule } from './automation-v2';
import { V2_PREFIX } from './automation-v2-triggers';
import { registerAutomationV2NotificationRoutes } from './automation-v2-notifications';

const uuid = z.uuid();
const id = (p: unknown) => z.object({ id: uuid }).parse(p).id;
// Creating and changing rules (and previewing or testing a draft): the administrator or an operator with the grant
// "Automatyzacje: edycja" (migration 267, server/automation-editors.ts).
const editor = (req: any) => ensureAutomationEditor(req.actor);
const operate = (req: any) => ensure(['admin', 'operator'].includes(req.actor.role), 403, 'Brak prawa obsługi zamówień');
const LIVE = "trigger LIKE 'v2:%' AND config->>'version'='2' AND NOT coalesce((config->>'deleted')::boolean,false)";

async function extraTypes(c: PoolClient): Promise<Record<string, ValueType>> {
  const rows = (await c.query('SELECT key,type FROM order_field_definitions WHERE enabled LIMIT 200')).rows;
  return Object.fromEntries(
    rows.map((d) => [
      EXTRA_FIELD_PREFIX + d.key,
      (d.type === 'number' ? 'number' : d.type === 'date' ? 'date' : ['select', 'radio', 'multi_select'].includes(d.type) ? 'list' : d.type === 'file' ? 'bool' : 'text') as ValueType,
    ]),
  );
}

/** Parses, checks and freezes a rule body against the tenant's data. */
async function validRule(c: PoolClient, raw: unknown, selfId?: string): Promise<AutomationRuleInput> {
  const r = parseRuleV2(raw, await extraTypes(c));
  ensure(r.rule, 422, r.error ?? 'Nieprawidłowa reguła');
  const effects = await validateEffectsInTx(c, r.rule.config.effects, selfId);
  const leaves = JSON.stringify(r.rule.config.conditions);
  // List values referring to the tenant's records must belong to it (RLS hides foreign rows).
  for (const [table, field] of [
    ['workflow_statuses', 'order.workflow_status'],
    ['warehouses', 'warehouse.id'],
    ['channels', 'source.account'],
  ] as const) {
    if (!leaves.includes(`"${field}"`)) continue;
    const values = collect(r.rule.config.conditions, field);
    if (values.length)
      ensure(
        (await c.query(`SELECT count(*)::int n FROM ${table} WHERE id::text=ANY($1::text[])`, [values])).rows[0].n === new Set(values).size,
        422,
        'Warunek wskazuje dane spoza organizacji',
      );
  }
  const sc = r.rule.config.status_change;
  const ownStatuses = sc ? [...sc.from, ...sc.to].filter((v) => /^[0-9a-f-]{36}$/i.test(v)) : [];
  if (ownStatuses.length)
    ensure(
      (await c.query('SELECT count(*)::int n FROM workflow_statuses WHERE id::text=ANY($1::text[])', [ownStatuses])).rows[0].n === new Set(ownStatuses).size,
      422,
      'Zmiana statusu wskazuje status spoza organizacji',
    );
  return { ...r.rule, config: { ...r.rule.config, effects } };
}

function collect(g: any, field: string): string[] {
  return (g.items ?? []).flatMap((i: any) => (Array.isArray(i.items) ? collect(i, field) : i.field === field && Array.isArray(i.value) ? i.value.map(String) : []));
}

async function loadRule(c: PoolClient, ruleId: string, lock = false) {
  const r = (await c.query(`SELECT * FROM automation_rules WHERE id=$1${lock ? ' FOR UPDATE' : ''}`, [ruleId])).rows[0];
  ensure(r && isV2Row(r) && !r.config.deleted, 404, 'Nie znaleziono reguły');
  return r;
}

async function version(c: PoolClient, actor: Actor, ruleId: string, v: string, before: AutomationRuleInput | null, after: AutomationRuleInput | null) {
  await audit(c, actor, 'automation.v2.version', ruleId, { version: v, before, after });
}

async function insertRule(c: PoolClient, actor: Actor, b: AutomationRuleInput) {
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['rules:' + actor.tenantId]);
  const n = (await c.query(`SELECT count(*)::int n,coalesce(max(priority),-1)::int top FROM automation_rules WHERE ${LIVE}`)).rows[0];
  ensure(n.n < MAX_RULES, 422, `Limit ${MAX_RULES} reguł`);
  const row = (
    await c.query(
      "INSERT INTO automation_rules(id,tenant_id,name,trigger,action,config,enabled,priority,delay_seconds,actor_id) VALUES($1,$2,$3,$4,'actions',$5,$6,$7,$8,$9) RETURNING *",
      [randomUUID(), actor.tenantId, b.name, V2_PREFIX + b.trigger, JSON.stringify(b.config), b.enabled, Math.min(n.top + 1, 100), Math.min(b.config.run.delay_minutes * 60, 604800), actor.userId],
    )
  ).rows[0];
  await version(c, actor, row.id, String(row.version), null, ruleInput(row));
  return row;
}

export function registerAutomationV2Routes(app: FastifyInstance) {
  const base = '/api/automations/v2';
  registerAutomationV2NotificationRoutes(app, base);
  app.get(base + '/catalog', (req) => tenantReadTx(req.actor.tenantId, (c) => buildCatalog(c)));

  app.get(base + '/rules', (req) =>
    tenantTx(req.actor.tenantId, async (c) => {
      await ensureDefaultRulesInTx(c, req.actor);
      return { data: (await c.query(`SELECT * FROM automation_rules WHERE ${LIVE} ORDER BY priority,id`)).rows.map(ruleFromRow) };
    }),
  );

  app.post(base + '/rules', (req) => {
    editor(req);
    return tenantTx(req.actor.tenantId, async (c) => ruleFromRow(await insertRule(c, req.actor, await validRule(c, req.body))));
  });

  app.put(base + '/rules/:id', (req) => {
    editor(req);
    const ruleId = id(req.params);
    const body = z.object({ version: z.union([z.number().int(), z.string().regex(/^\d+$/)]) }).passthrough().parse(req.body);
    const { version: expected, ...raw } = body;
    return tenantTx(req.actor.tenantId, async (c) => {
      const old = await loadRule(c, ruleId, true);
      ensure(String(old.version) === String(expected), 409, 'Reguła zmieniła się, odśwież dane');
      const b = await validRule(c, raw, ruleId);
      const row = (
        await c.query(
          "UPDATE automation_rules SET name=$2,trigger=$3,config=$4,enabled=$5,delay_seconds=$6,version=version+1,actor_id=$7,updated_at=now() WHERE id=$1 RETURNING *",
          [ruleId, b.name, V2_PREFIX + b.trigger, JSON.stringify(b.config), b.enabled, Math.min(b.config.run.delay_minutes * 60, 604800), req.actor.userId],
        )
      ).rows[0];
      await version(c, req.actor, ruleId, String(row.version), ruleInput(old), ruleInput(row));
      return ruleFromRow(row);
    });
  });

  app.post(base + '/rules/:id/copy', (req) => {
    editor(req);
    const ruleId = id(req.params);
    return tenantTx(req.actor.tenantId, async (c) => {
      const src = await loadRule(c, ruleId);
      // "Zapisz jako nowy": the editor may send its current form; otherwise the stored rule is copied.
      // A copy starts disabled so the same conditions never fire twice by accident.
      const body = req.body && typeof req.body === 'object' && 'config' in (req.body as object) ? req.body : { ...ruleInput(src), name: `${src.name} (kopia)`.slice(0, 120) };
      const b = await validRule(c, { ...(body as object), enabled: false });
      return ruleFromRow(await insertRule(c, req.actor, b));
    });
  });

  app.delete(base + '/rules/:id', (req) => {
    editor(req);
    const ruleId = id(req.params);
    return tenantTx(req.actor.tenantId, async (c) => {
      const old = await loadRule(c, ruleId, true);
      const used = (await c.query('SELECT 1 FROM automation_runs WHERE rule_id=$1 LIMIT 1', [ruleId])).rowCount;
      // Runs keep a foreign key to the rule: a used rule is disabled and hidden, never removed.
      if (used)
        await c.query("UPDATE automation_rules SET enabled=false,config=config||'{\"deleted\":true}'::jsonb,version=version+1,updated_at=now() WHERE id=$1", [ruleId]);
      else {
        await c.query("DELETE FROM jobs WHERE kind='automation.v2.state' AND dedup_key LIKE $1", [`v2state:${ruleId}:%`]);
        await c.query('DELETE FROM automation_rules WHERE id=$1', [ruleId]);
      }
      await version(c, req.actor, ruleId, String(Number(old.version) + 1), ruleInput(old), null);
      return { ok: true };
    });
  });

  app.patch(base + '/rules/order', (req) => {
    editor(req);
    const b = z.object({ ids: z.array(uuid).min(1).max(MAX_RULES) }).parse(req.body);
    ensure(new Set(b.ids).size === b.ids.length, 422, 'Powtórzona reguła');
    return tenantTx(req.actor.tenantId, async (c) => {
      const rows = (await c.query(`SELECT id FROM automation_rules WHERE ${LIVE} AND id=ANY($1::uuid[]) FOR UPDATE`, [b.ids])).rows;
      ensure(rows.length === b.ids.length, 404, 'Nie znaleziono wszystkich reguł');
      // Priority is the list order; it does not change the rule version (queued runs stay valid).
      for (const [i, ruleId] of b.ids.entries())
        await c.query('UPDATE automation_rules SET priority=$2,updated_at=now() WHERE id=$1', [ruleId, Math.min(i, 100)]);
      await audit(c, req.actor, 'automation.v2.order', null, { ids: b.ids });
      return { ok: true };
    });
  });

  app.post(base + '/rules/:id/preview', (req) => {
    editor(req);
    const ruleId = id(req.params);
    const b = z.object({ limit: z.number().int().min(1).max(2000).optional(), rule: z.unknown().optional() }).parse(req.body ?? {});
    return tenantReadTx(req.actor.tenantId, async (c) => {
      const rule = b.rule ? parseOrThrow(b.rule, await extraTypes(c)) : ruleInput(await loadRule(c, ruleId));
      return previewRule(c, rule, b.limit);
    });
  });

  app.post(base + '/rules/:id/test', (req) => {
    editor(req);
    const ruleId = id(req.params);
    const b = z.object({ order_id: uuid, rule: z.unknown().optional() }).parse(req.body);
    return tenantReadTx(req.actor.tenantId, async (c) => {
      const rule = b.rule ? parseOrThrow(b.rule, await extraTypes(c)) : ruleInput(await loadRule(c, ruleId));
      return testRule(c, rule, b.order_id, ruleId);
    });
  });

  app.post(base + '/rules/:id/run', (req) => {
    operate(req);
    const ruleId = id(req.params);
    const b = z.object({ order_ids: z.array(uuid).min(1).max(100) }).parse(req.body);
    ensure(new Set(b.order_ids).size === b.order_ids.length, 422, 'Powtórzone zamówienie');
    return tenantTx(req.actor.tenantId, async (c) => ({ runs: await runNow(c, req.actor, await loadRule(c, ruleId), b.order_ids, 'manual') }));
  });

  app.get(base + '/rules/:id/versions', (req) => {
    const ruleId = id(req.params);
    return tenantReadTx(req.actor.tenantId, async (c) => {
      const rows = (
        await c.query(
          "SELECT e.detail,e.created_at,coalesce(customer_message_actor_name(e.user_id),'System') actor FROM audit_events e WHERE e.action='automation.v2.version' AND e.entity_id=$1 ORDER BY e.created_at DESC,e.id DESC LIMIT 100",
          [ruleId],
        )
      ).rows;
      const data: AutomationRuleVersion[] = rows.map((r) => ({
        version: Number(r.detail.version),
        actor: r.actor,
        at: new Date(r.created_at).toISOString(),
        before: r.detail.before ?? null,
        after: r.detail.after ?? null,
      }));
      return { data };
    });
  });

  app.get(base + '/runs', (req) => {
    const q = z.object({ rule_id: uuid.optional(), order_id: uuid.optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }).parse(req.query);
    return tenantReadTx(req.actor.tenantId, async (c) => ({
      data: (
        await c.query(
          `SELECT r.*,o.number FROM automation_runs r JOIN orders o ON (o.tenant_id,o.id)=(r.tenant_id,r.order_id)
           WHERE r.definition->>'engine'='v2' AND ($1::uuid IS NULL OR r.rule_id=$1) AND ($2::uuid IS NULL OR r.order_id=$2)
           ORDER BY r.created_at DESC,r.id DESC LIMIT $3`,
          [q.rule_id ?? null, q.order_id ?? null, q.limit],
        )
      ).rows.map(runSummary),
    }));
  });

  app.get(base + '/manual', (req) => {
    z.object({ order_id: uuid.optional() }).parse(req.query);
    return tenantReadTx(req.actor.tenantId, async (c) => ({
      data: (
        await c.query(`SELECT id,name,config->>'group' AS grp FROM automation_rules WHERE enabled AND ${LIVE} AND (config->'run'->>'manual_button')::boolean ORDER BY priority,id`)
      ).rows.map((r) => ({ id: r.id, name: r.name, group: r.grp ?? 'Ogólne' })),
    }));
  });

  app.post(base + '/barcode', (req) => {
    operate(req);
    const b = z.object({ code: z.string().trim().min(4).max(40), order: z.string().trim().min(1).max(80) }).parse(req.body);
    return tenantTx(req.actor.tenantId, async (c) => {
      const code = b.code.toUpperCase();
      const rule = (await c.query(`SELECT * FROM automation_rules WHERE ${LIVE} AND (config->'run'->>'barcode')::boolean ORDER BY priority,id`)).rows.find(
        (r) => barcodeFor(r.tenant_id, r.id) === code,
      );
      ensure(rule, 404, 'Nieznany kod reguły');
      const order = (
        await c.query('SELECT id FROM orders WHERE id::text=$1 OR number=$1 OR external_id=$1 ORDER BY (id::text=$1) DESC,(number=$1) DESC LIMIT 2', [b.order])
      ).rows;
      ensure(order.length, 404, 'Nie znaleziono zamówienia');
      const [run] = await runNow(c, req.actor, rule, [order[0].id], 'barcode');
      return run;
    });
  });
}

function parseOrThrow(raw: unknown, types: Record<string, ValueType>): AutomationRuleInput {
  const r = parseRuleV2(raw, types);
  ensure(r.rule, 422, r.error ?? 'Nieprawidłowa reguła');
  return r.rule;
}
