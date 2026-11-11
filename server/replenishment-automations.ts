import { createHmac, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { tenantTx, pool, localConfig } from './db';
import { audit, type Actor } from './domain';
import { ensure } from './errors';
import { assertCatalogExportAccess } from './catalog-export';
import {
  replenishmentPlansAvailable,
  replenishmentForecastAvailable,
  replenishmentAppendAvailable,
  replenishmentHash,
  createReplenishmentPreviewInTx,
  executeReplenishmentPlanInTx,
} from './replenishment-plans';
import * as S from './replenishment-automations-schema';
export * from './replenishment-automations-schema';
export const REPLENISHMENT_AUTOMATION_JOB = 'replenishment.automation';
type Row = Record<string, any>;
export type ReplenishmentAutomationJob = {
  id: string;
  tenant_id: string;
  lease_token: string;
  payload: { run_id: string };
};
const readTx = { wmsAdmission: 'read' as const };
const writeTx = { ...readTx, purchasingAdmission: true };
const source = (a: Actor) => (a.apiKeyId ? 'api' : 'manual');
function parse<T>(schema: { parse(v: unknown): T }, input: unknown): T {
  ensure(
    Buffer.byteLength(JSON.stringify(input) ?? '') <=
      S.REPLENISHMENT_AUTOMATION_LIMITS.request_bytes,
    413,
    'Reguła przekracza limit żądania',
  );
  return schema.parse(input);
}
export async function replenishmentAutomationsAvailable(c: Pool | PoolClient) {
  if (!(await replenishmentPlansAvailable(c))) return false;
  return (
    await c.query<{
      available: boolean;
    }>(`SELECT (SELECT bool_and(to_regclass('public.'||t) IS NOT NULL) FROM unnest(ARRAY['replenishment_automation_rules','replenishment_automation_rule_items','replenishment_automation_runs']) t)
 AND to_regprocedure('public.replenishment_automation_capture()') IS NOT NULL
 AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('public.stock') AND tgname='replenishment_automation_stock' AND tgenabled='O' AND NOT tgisinternal) AS available`)
  ).rows[0].available;
}
async function available(c: PoolClient) {
  ensure(
    await replenishmentAutomationsAvailable(c),
    503,
    'Automatyczne uzupełnianie nie jest dostępne w tej kopii',
  );
}
async function entry(a: Actor, write = false) {
  const role = await assertCatalogExportAccess(a, [
    'inventory:read',
    'purchasing:read',
    ...(write ? ['purchasing:write'] : []),
  ]);
  ensure(!write || role === 'admin', 403, 'Zmiany reguł wymagają administratora');
}
export async function assertReplenishmentAutomationActorInTx(
  c: PoolClient,
  a: Actor,
  write = false,
  pin = true,
) {
  const role = (
    await c.query<{ role: Actor['role'] | null }>('SELECT replenishment_current_role($1,$2) role', [
      a.userId,
      pin,
    ])
  ).rows[0].role;
  ensure(
    role && ['admin', 'operator', 'viewer'].includes(role),
    403,
    'Brak aktualnego członkostwa',
  );
  ensure(!write || role === 'admin', 403, 'Wymagany aktualny administrator');
  let manage = role === 'admin';
  if (a.apiKeyId && pin) {
    const g = (
      await c.query<{ g: string }>('SELECT replenishment_key_grant($1,$2,$3) g', [
        a.userId,
        a.apiKeyId,
        write,
      ])
    ).rows[0].g;
    ensure(g !== 'invalid', 401, 'Klucz wygasł lub został cofnięty');
    ensure(g === 'ok' || (!write && g === 'read_only'), 403, 'Brak aktualnych scope zakupowych');
    manage = manage && g === 'ok';
  }
  return {
    available: true,
    read_only: false,
    current_role: role,
    can_read: true,
    can_manage: manage,
    can_read_value: role === 'admin',
  };
}
async function final(c: PoolClient, a: Actor) {
  await c.query('SET CONSTRAINTS ALL IMMEDIATE');
  return assertReplenishmentAutomationActorInTx(c, a, true);
}
async function admit(c: PoolClient, a: Actor) {
  await available(c);
  await assertReplenishmentAutomationActorInTx(c, a, true, false);
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    'replenishment.automation.queue:' + a.tenantId,
  ]);
}
const stamp = (v: string | Date) => new Date(v).toISOString();
const ruleView = (r: Row, items: Row[]) => ({
  id: r.id,
  name: r.name,
  version: r.version,
  definition: r.definition,
  actor_id: r.actor_id,
  policy_items: items.map((i) => ({
    product_id: i.product_id,
    policy_id: i.policy_id,
    policy_version: i.policy_version,
    product_version: i.product_version,
  })),
  created_at: stamp(r.created_at),
  updated_at: stamp(r.updated_at),
});
const costKeys = new Set([
  'unit_cost_minor',
  'unit_cost',
  'line_total_minor',
  'total_minor',
  'total_before_minor',
  'total_after_minor',
  'known_minor',
  'total_net',
  'received_net',
  'cost_valid_until',
  'cost_confirmed_at',
]);
function project(v: any, show: boolean): any {
  if (Array.isArray(v)) return v.map((x) => project(x, show));
  if (v && typeof v === 'object')
    return Object.fromEntries(
      Object.entries(v)
        .filter(([k]) => show || !costKeys.has(k))
        .map(([k, x]) => [k, project(x, show)]),
    );
  return v;
}
const runView = (r: Row, flags: { can_manage: boolean; can_read_value?: boolean }) => ({
  id: r.id,
  rule_id: r.rule_id,
  rule_version: r.rule_version,
  version: r.version,
  state: r.state,
  name: r.name,
  definition: r.definition,
  actor_id: r.actor_id,
  policy_items: r.policy_items,
  crossings: r.crossings,
  result: project(r.result, flags.can_read_value === true),
  created_at: stamp(r.created_at),
  finished_at: r.finished_at ? stamp(r.finished_at) : null,
  can_cancel: flags.can_manage && r.state === 'queued',
});
async function items(c: PoolClient, id: string) {
  return (
    await c.query(
      'SELECT * FROM replenishment_automation_rule_items WHERE rule_id=$1 ORDER BY product_id',
      [id],
    )
  ).rows;
}
async function validate(c: PoolClient, d: S.ReplenishmentAutomationDefinition) {
  if (d.forecast)
    ensure(await replenishmentForecastAvailable(c), 503, 'Prognoza nie jest dostępna');
  if (d.destination === 'append_matching_draft')
    ensure(await replenishmentAppendAvailable(c), 503, 'Dopisywanie do szkicu nie jest dostępne');
  ensure(
    (await c.query('SELECT id FROM warehouses WHERE id=$1', [d.warehouse_id])).rowCount,
    422,
    'Magazyn nie należy do firmy',
  );
  await c.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))', [
    'catalog:' + (await c.query("SELECT current_setting('app.tenant_id') t")).rows[0].t,
  ]);
  const rows = (
    await c.query(
      `SELECT p.id product_id,p.version product_version,r.id policy_id,r.version policy_version,r.definition FROM products p JOIN replenishment_policies r ON r.tenant_id=p.tenant_id AND r.product_id=p.id AND r.warehouse_id=$2 WHERE p.id=ANY($1::uuid[]) AND p.active AND p.kind IN ('simple','variant') AND (r.definition->>'enabled')::boolean ORDER BY p.id FOR SHARE OF p,r`,
      [d.product_ids, d.warehouse_id],
    )
  ).rows;
  ensure(
    rows.length === d.product_ids.length,
    422,
    'Każdy produkt musi być własny, fizyczny, aktywny i mieć włączoną politykę',
  );
  return rows;
}
async function saveItems(c: PoolClient, a: Actor, id: string, rows: Row[]) {
  await c.query('DELETE FROM replenishment_automation_rule_items WHERE rule_id=$1', [id]);
  for (let offset = 0; offset < rows.length; offset += 100)
    await c.query(
      `INSERT INTO replenishment_automation_rule_items(tenant_id,rule_id,product_id,policy_id,policy_version,product_version) SELECT $1,$2,x.product_id,x.policy_id,x.policy_version,x.product_version FROM jsonb_to_recordset($3::jsonb) x(product_id uuid,policy_id uuid,policy_version integer,product_version integer)`,
      [a.tenantId, id, JSON.stringify(rows.slice(offset, offset + 100))],
    );
}
function cursor(id: string, bind: string) {
  const p = Buffer.from(JSON.stringify({ id, bind })).toString('base64url');
  return p + '.' + createHmac('sha256', localConfig.encryptionKey).update(p).digest('hex');
}
function after(value: string | undefined, bind: string) {
  if (!value) return null;
  const [p, m, ...rest] = value.split('.');
  ensure(
    !rest.length &&
      m ===
        createHmac('sha256', localConfig.encryptionKey)
          .update(p ?? '')
          .digest('hex'),
    422,
    'Nieprawidłowy kursor',
  );
  let b: Row;
  try {
    b = JSON.parse(Buffer.from(p, 'base64url').toString());
  } catch {
    ensure(false, 422, 'Nieprawidłowy kursor');
  }
  ensure(b.bind === bind && /^[a-f0-9-]{36}$/.test(b.id), 409, 'Kursor dotyczy innego zakresu');
  return b.id as string;
}
export async function replenishmentAutomationOptions(a: Actor) {
  await entry(a);
  return tenantTx(
    a.tenantId,
    async (c) => {
      const supported = await replenishmentAutomationsAvailable(c);
      const wh = (await c.query('SELECT id,name,code FROM warehouses ORDER BY id LIMIT 201')).rows;
      const forecast = await replenishmentForecastAvailable(c),
        append = await replenishmentAppendAvailable(c);
      const flags = await assertReplenishmentAutomationActorInTx(c, a);
      return {
        ...flags,
        available: supported,
        can_manage: supported && flags.can_manage,
        limits: S.REPLENISHMENT_AUTOMATION_LIMITS,
        warehouses: { data: wh.slice(0, 200), capped: wh.length > 200 },
        forecast_available: forecast,
        append_available: append,
        trigger: 'available_crosses_below_minimum',
        initial_low_triggers: false,
        queue_backpressure: true,
      };
    },
    readTx,
  );
}
export async function createReplenishmentAutomation(a: Actor, input: unknown) {
  const b = parse(S.replenishmentAutomationCreateInput, input);
  await entry(a, true);
  const hash = replenishmentHash({ actor_id: a.userId, source: source(a), body: b });
  return tenantTx(
    a.tenantId,
    async (c) => {
      await admit(c, a);
      const old = (
        await c.query('SELECT * FROM replenishment_automation_rules WHERE client_key=$1', [
          b.client_key,
        ])
      ).rows[0];
      if (old) {
        ensure(
          old.actor_id === a.userId && old.request_hash === hash,
          409,
          'Klucz dotyczy innej reguły',
        );
        const is = await items(c, old.id);
        return {
          ...(await assertReplenishmentAutomationActorInTx(c, a, true)),
          rule: ruleView(old, is),
          reused: true,
        };
      }
      ensure(
        (await c.query('SELECT count(*)::int n FROM replenishment_automation_rules')).rows[0].n <
          200,
        429,
        'Limit 200 reguł',
      );
      const is = await validate(c, b.definition);
      const r = (
        await c.query(
          `INSERT INTO replenishment_automation_rules(id,tenant_id,name,definition,actor_id,api_key_id,source,client_key,request_hash,initial_request) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
          [
            randomUUID(),
            a.tenantId,
            b.name,
            JSON.stringify(b.definition),
            a.userId,
            a.apiKeyId ?? null,
            source(a),
            b.client_key,
            hash,
            JSON.stringify(b),
          ],
        )
      ).rows[0];
      await saveItems(c, a, r.id, is);
      await audit(c, a, 'replenishment.automation.created', r.id, {
        definition: b.definition,
        policy_items: is.map((i) => ({
          product_id: i.product_id,
          policy_id: i.policy_id,
          policy_version: i.policy_version,
        })),
      });
      return { ...(await final(c, a)), rule: ruleView(r, is), reused: false };
    },
    writeTx,
  );
}
export async function patchReplenishmentAutomation(a: Actor, id: string, input: unknown) {
  const b = parse(S.replenishmentAutomationPatchInput, input);
  await entry(a, true);
  return tenantTx(
    a.tenantId,
    async (c) => {
      await admit(c, a);
      const old = (
        await c.query('SELECT * FROM replenishment_automation_rules WHERE id=$1 FOR UPDATE', [id])
      ).rows[0];
      ensure(old, 404, 'Reguła nie istnieje');
      ensure(old.version === b.version, 409, 'Reguła zmieniła się');
      ensure(old.version < 2147483647, 409, 'Wersja reguły wyczerpana');
      const is = await validate(c, b.definition);
      if (b.definition.enabled) {
        const prior = await items(c, id);
        const oldBy = new Map(prior.map((i) => [i.product_id, i]));
        for (const next of is) {
          const prev = oldBy.get(next.product_id);
          ensure(
            !prev ||
              (prev.policy_id === next.policy_id && prev.policy_version === next.policy_version),
            409,
            'Polityka zmieniła się; zapisz wyłączoną regułę, sprawdź ją i ponownie potwierdź',
          );
        }
      }
      const r = (
        await c.query(
          'UPDATE replenishment_automation_rules SET name=$2,definition=$3,version=version+1,actor_id=$4,api_key_id=$5,source=$6,updated_at=clock_timestamp() WHERE id=$1 RETURNING *',
          [id, b.name, JSON.stringify(b.definition), a.userId, a.apiKeyId ?? null, source(a)],
        )
      ).rows[0];
      await saveItems(c, a, id, is);
      await audit(c, a, 'replenishment.automation.changed', id, {
        before: old.definition,
        after: r.definition,
      });
      return { ...(await final(c, a)), rule: ruleView(r, is), reused: false };
    },
    writeTx,
  );
}
export async function replenishmentAutomationRuleDetail(a: Actor, id: string) {
  await entry(a);
  return tenantTx(
    a.tenantId,
    async (c) => {
      await available(c);
      const r = (await c.query('SELECT * FROM replenishment_automation_rules WHERE id=$1', [id]))
        .rows[0];
      ensure(r, 404, 'Reguła nie istnieje');
      const is = await items(c, id);
      return { ...(await assertReplenishmentAutomationActorInTx(c, a)), rule: ruleView(r, is) };
    },
    readTx,
  );
}
export async function replenishmentAutomationRules(a: Actor, input: unknown) {
  const q = S.replenishmentAutomationPageQuery.parse(input);
  await entry(a);
  return tenantTx(
    a.tenantId,
    async (c) => {
      await available(c);
      const early = await assertReplenishmentAutomationActorInTx(c, a, false, false);
      const bind = replenishmentHash({
          tenant: a.tenantId,
          actor: a.userId,
          role: early.current_role,
          kind: 'rules',
        }),
        last = after(q.cursor, bind);
      const rs = (
        await c.query(
          'SELECT * FROM replenishment_automation_rules WHERE ($1::uuid IS NULL OR id>$1) ORDER BY id LIMIT $2',
          [last, q.limit + 1],
        )
      ).rows;
      const ids = rs.slice(0, q.limit).map((r) => r.id);
      const all = (
        await c.query(
          'SELECT * FROM replenishment_automation_rule_items WHERE rule_id=ANY($1::uuid[]) ORDER BY rule_id,product_id',
          [ids],
        )
      ).rows;
      const total = (await c.query('SELECT count(*)::int n FROM replenishment_automation_rules'))
        .rows[0].n;
      const flags = await assertReplenishmentAutomationActorInTx(c, a);
      ensure(
        flags.current_role === early.current_role,
        409,
        'Uprawnienia zmieniły się; odśwież listę',
      );
      return {
        ...flags,
        data: rs.slice(0, q.limit).map((r) =>
          ruleView(
            r,
            all.filter((i) => i.rule_id === r.id),
          ),
        ),
        meta: { total, cursor: rs.length > q.limit ? cursor(rs[q.limit - 1].id, bind) : null },
      };
    },
    readTx,
  );
}
export async function replenishmentAutomationRuns(a: Actor, input: unknown) {
  const q = S.replenishmentAutomationRunsQuery.parse(input);
  await entry(a);
  return tenantTx(
    a.tenantId,
    async (c) => {
      await available(c);
      const early = await assertReplenishmentAutomationActorInTx(c, a, false, false),
        bind = replenishmentHash({
          tenant: a.tenantId,
          actor: a.userId,
          role: early.current_role,
          kind: 'runs',
          rule: q.rule_id ?? null,
        }),
        last = after(q.cursor, bind);
      const rs = (
        await c.query(
          'SELECT * FROM replenishment_automation_runs WHERE ($1::uuid IS NULL OR rule_id=$1) AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT $3',
          [q.rule_id ?? null, last, q.limit + 1],
        )
      ).rows;
      const total = (
        await c.query(
          'SELECT count(*)::int n FROM replenishment_automation_runs WHERE ($1::uuid IS NULL OR rule_id=$1)',
          [q.rule_id ?? null],
        )
      ).rows[0].n;
      const flags = await assertReplenishmentAutomationActorInTx(c, a);
      ensure(
        flags.current_role === early.current_role,
        409,
        'Uprawnienia zmieniły się; odśwież listę',
      );
      return {
        ...flags,
        data: rs.slice(0, q.limit).map((r) => runView(r, flags)),
        meta: { total, cursor: rs.length > q.limit ? cursor(rs[q.limit - 1].id, bind) : null },
      };
    },
    readTx,
  );
}
export async function replenishmentAutomationRunDetail(a: Actor, id: string) {
  await entry(a);
  return tenantTx(
    a.tenantId,
    async (c) => {
      await available(c);
      const r = (await c.query('SELECT * FROM replenishment_automation_runs WHERE id=$1', [id]))
        .rows[0];
      ensure(r, 404, 'Wykonanie nie istnieje');
      const flags = await assertReplenishmentAutomationActorInTx(c, a);
      return { ...flags, run: runView(r, flags) };
    },
    readTx,
  );
}
export async function cancelReplenishmentAutomationRun(a: Actor, id: string, input: unknown) {
  const b = parse(S.replenishmentAutomationCancelInput, input);
  const hash = replenishmentHash({ actor_id: a.userId, source: source(a), run_id: id, body: b });
  await entry(a, true);
  return tenantTx(
    a.tenantId,
    async (c) => {
      await admit(c, a);
      const r = (
        await c.query('SELECT * FROM replenishment_automation_runs WHERE id=$1 FOR UPDATE', [id])
      ).rows[0];
      ensure(r, 404, 'Wykonanie nie istnieje');
      if (r.state === 'cancelled' && r.cancel_key === b.client_key) {
        ensure(
          r.cancel_actor_id === a.userId && r.cancel_request_hash === hash,
          409,
          'Klucz anulowania dotyczy innego żądania',
        );
        const flags = await assertReplenishmentAutomationActorInTx(c, a, true);
        return { ...flags, run: runView(r, flags), reused: true };
      }
      ensure(
        r.state === 'queued' && r.version === b.version,
        409,
        'Wykonanie zmieniło się albo jest zakończone',
      );
      await c.query(
        "UPDATE jobs SET state='failed',error='Cancelled local replenishment automation',lease_token=NULL,locked_at=NULL WHERE id=$1",
        [r.job_id],
      );
      const updated = (
        await c.query(
          "UPDATE replenishment_automation_runs SET version=version+1,state='cancelled',cancel_key=$2,cancel_actor_id=$3,cancel_request_hash=$4,result='{}',finished_at=clock_timestamp() WHERE id=$1 RETURNING *",
          [id, b.client_key, a.userId, hash],
        )
      ).rows[0];
      await audit(c, a, 'replenishment.automation.cancelled', id, {});
      const flags = await final(c, a);
      return { ...flags, run: runView(updated, flags), reused: false };
    },
    writeTx,
  );
}
async function finishRun(c: PoolClient, r: Row, state: string, result: Row) {
  const updated = (
    await c.query(
      'UPDATE replenishment_automation_runs SET version=version+1,state=$2,result=$3,finished_at=clock_timestamp() WHERE id=$1 RETURNING *',
      [r.id, state, JSON.stringify(result)],
    )
  ).rows[0];
  await c.query(
    "UPDATE jobs SET state='done',error=NULL,lease_token=NULL,locked_at=NULL WHERE id=$1",
    [r.job_id],
  );
  return updated;
}
/** A current lease is held until the same transaction commits its complete plan
 * and terminal run. A retry cannot create a second preview/execution or PO. */
export async function processReplenishmentAutomation(job: ReplenishmentAutomationJob) {
  return tenantTx(
    job.tenant_id,
    async (c) => {
      await available(c);
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        'replenishment.automation.queue:' + job.tenant_id,
      ]);
      // Source EXCLUSIVE was obtained before callback/job locks. Cancels/edits use
      // that same admission, while trigger capture never takes a rule/job row lock.
      const leased = (
        await c.query(
          "SELECT id FROM jobs WHERE id=$1 AND tenant_id=$2 AND kind=$3 AND state='running' AND lease_token=$4 AND payload=$5::jsonb FOR UPDATE",
          [
            job.id,
            job.tenant_id,
            REPLENISHMENT_AUTOMATION_JOB,
            job.lease_token,
            JSON.stringify({ run_id: job.payload.run_id }),
          ],
        )
      ).rowCount;
      if (!leased) return { reused: true };
      const r = (
        await c.query('SELECT * FROM replenishment_automation_runs WHERE id=$1 FOR UPDATE', [
          job.payload.run_id,
        ])
      ).rows[0];
      ensure(r && r.job_id === job.id, 409, 'Nieprawidłowy zakres zadania');
      if (r.state !== 'queued') {
        await c.query("UPDATE jobs SET state='done',lease_token=NULL,locked_at=NULL WHERE id=$1", [
          job.id,
        ]);
        return { reused: true };
      }
      const rule = (
        await c.query('SELECT * FROM replenishment_automation_rules WHERE id=$1 FOR UPDATE', [
          r.rule_id,
        ])
      ).rows[0];
      const a: Actor = {
        tenantId: job.tenant_id,
        userId: r.actor_id,
        role: 'admin',
        ...(r.api_key_id ? { apiKeyId: r.api_key_id } : {}),
      };
      const role = (await c.query('SELECT replenishment_current_role($1,false) role', [a.userId]))
        .rows[0].role;
      if (!rule?.definition.enabled || rule.version !== r.rule_version || role !== 'admin') {
        await finishRun(c, r, 'skipped', {
          reason: role !== 'admin' ? 'approver_not_admin' : 'rule_changed',
        });
        await c.query('SET CONSTRAINTS ALL IMMEDIATE');
        return { state: 'skipped' };
      }
      const policies = (
        await c.query(
          'SELECT id,version,definition FROM replenishment_policies WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE',
          [r.policy_items.map((i: Row) => i.policy_id)],
        )
      ).rows;
      const byPolicy = new Map(policies.map((p) => [p.id, p]));
      if (
        r.policy_items.some((i: Row) => {
          const p = byPolicy.get(i.policy_id);
          return !p || p.version !== i.policy_version || !p.definition.enabled;
        })
      ) {
        await finishRun(c, r, 'skipped', { reason: 'policy_changed' });
        await final(c, a);
        return { state: 'skipped' };
      }
      const current = await validate(c, rule.definition);
      const selected = current.map((i) => ({
        product_id: i.product_id,
        policy_id: i.policy_id,
        policy_version: i.policy_version,
        product_version: i.product_version,
      }));
      // Product text/price version changes are read live. Authorization freezes
      // policy identity+revision, including the known cost approved at enable time.
      if (
        replenishmentHash(
          selected.map((i) => ({
            product_id: i.product_id,
            policy_id: i.policy_id,
            policy_version: i.policy_version,
          })),
        ) !==
        replenishmentHash(
          r.policy_items.map((i: Row) => ({
            product_id: i.product_id,
            policy_id: i.policy_id,
            policy_version: i.policy_version,
          })),
        )
      ) {
        await finishRun(c, r, 'skipped', { reason: 'policy_changed' });
        await c.query('SET CONSTRAINTS ALL IMMEDIATE');
        await assertReplenishmentAutomationActorInTx(c, a, true);
        return { state: 'skipped' };
      }
      const crossingIds = new Set<string>(r.crossings.map((x: Row) => x.product_id));
      const crossingCurrent = current.filter((i) => crossingIds.has(i.product_id));
      const crossingSelected = selected.filter((i) => crossingIds.has(i.product_id));
      ensure(
        crossingSelected.length === crossingIds.size,
        409,
        'Zakres zdarzenia nie zgadza się z regułą',
      );
      const body: Row = {
        client_key: r.id,
        warehouse_id: rule.definition.warehouse_id,
        items: crossingSelected.map((i) => ({
          product_id: i.product_id,
          product_version: i.product_version,
          policy_version: i.policy_version,
        })),
        ...(rule.definition.forecast ? { forecast: rule.definition.forecast } : {}),
      };
      if (rule.definition.destination === 'append_matching_draft') {
        const pairs = new Map(
          crossingCurrent.map((i) => [
            i.definition.supplier_id + ':' + i.definition.currency,
            { supplier_id: i.definition.supplier_id, currency: i.definition.currency },
          ]),
        );
        const targets = [];
        for (const pair of [...pairs.values()].sort((x, y) =>
          (x.supplier_id + ':' + x.currency).localeCompare(y.supplier_id + ':' + y.currency),
        )) {
          const po = (
            await c.query(
              "SELECT id,version FROM purchase_orders WHERE warehouse_id=$1 AND supplier_id=$2 AND currency=$3 AND state='draft' ORDER BY created_at,id LIMIT 1 FOR UPDATE",
              [body.warehouse_id, pair.supplier_id, pair.currency],
            )
          ).rows[0];
          if (po) targets.push({ ...pair, purchase_order_id: po.id, version: po.version });
        }
        if (targets.length) body.draft_targets = targets;
      }
      await c.query('SAVEPOINT automation_plan');
      let preview: Row;
      let execution: Row;
      try {
        const p = await createReplenishmentPreviewInTx(c, a, body, { finalize: false });
        preview = p.preview;
        if (!preview.ready) {
          await finishRun(c, r, 'error', { reason: 'plan_not_ready', preview_id: preview.id });
          await final(c, a);
          return { state: 'error', preview_id: preview.id };
        }
        execution = (
          await executeReplenishmentPlanInTx(
            c,
            a,
            preview.id,
            { client_key: r.id, scope_hash: preview.scope_hash, confirmed: true },
            { finalize: false },
          )
        ).execution;
      } catch (error) {
        await c.query('ROLLBACK TO SAVEPOINT automation_plan');
        // No external write occurs; failed planning has no PO/business side effects.
        await finishRun(c, r, 'error', { reason: 'planning_failed' });
        await final(c, a);
        return { state: 'error' };
      }
      // Policy/rule reads held SHARE/UPDATE throughout tentative writes. This check
      // precedes the final actor pins, after every PO, evidence and job/FK wait.
      const still = (
        await c.query('SELECT version,definition FROM replenishment_automation_rules WHERE id=$1', [
          rule.id,
        ])
      ).rows[0];
      ensure(
        still.version === r.rule_version && still.definition.enabled,
        409,
        'Reguła utraciła zgodę',
      );
      const state = execution.groups.length ? 'done' : 'nop';
      await finishRun(c, r, state, {
        preview_id: preview.id,
        execution_id: execution.id,
        purchase_order_ids: execution.groups.map((g: Row) => g.purchase_order_id),
      });
      await audit(c, a, 'replenishment.automation.applied', r.id, {
        preview_id: preview.id,
        execution_id: execution.id,
        state,
      });
      await final(c, a);
      return { state, preview_id: preview.id, execution_id: execution.id };
    },
    writeTx,
  );
}
/** Worker error handler is lease-bound and never retries PO effects separately. */
export async function failReplenishmentAutomation(
  job: ReplenishmentAutomationJob,
  _error: unknown,
) {
  return tenantTx(
    job.tenant_id,
    async (c) => {
      if (!(await replenishmentAutomationsAvailable(c))) return;
      const leased = (
        await c.query(
          "SELECT id FROM jobs WHERE id=$1 AND kind=$2 AND state='running' AND lease_token=$3 FOR UPDATE",
          [job.id, REPLENISHMENT_AUTOMATION_JOB, job.lease_token],
        )
      ).rowCount;
      if (!leased) return;
      const r = (
        await c.query(
          'SELECT * FROM replenishment_automation_runs WHERE id=$1 AND job_id=$2 FOR UPDATE',
          [job.payload.run_id, job.id],
        )
      ).rows[0];
      if (r?.state === 'queued') await finishRun(c, r, 'error', { reason: 'worker_failed' });
      else
        await c.query("UPDATE jobs SET state='done',lease_token=NULL,locked_at=NULL WHERE id=$1", [
          job.id,
        ]);
      await c.query('SET CONSTRAINTS ALL IMMEDIATE');
    },
    writeTx,
  );
}
/** Generic worker may have marked an exhausted lease failed before dispatch. */
export async function reapReplenishmentAutomations() {
  if (!(await replenishmentAutomationsAvailable(pool))) return 0;
  const candidates = (
    await pool.query(
      "SELECT r.id,r.tenant_id FROM replenishment_automation_runs r JOIN jobs j ON j.tenant_id=r.tenant_id AND j.id=r.job_id WHERE r.state='queued' AND j.state IN ('failed','done') ORDER BY r.created_at,r.id LIMIT 20",
    )
  ).rows;
  let changed = 0;
  for (const candidate of candidates)
    await tenantTx(
      candidate.tenant_id,
      async (c) => {
        const r = (
          await c.query('SELECT * FROM replenishment_automation_runs WHERE id=$1 FOR UPDATE', [
            candidate.id,
          ])
        ).rows[0];
        if (r?.state !== 'queued') return;
        const j = (await c.query('SELECT state FROM jobs WHERE id=$1 FOR UPDATE', [r.job_id]))
          .rows[0];
        if (!j || !['failed', 'done'].includes(j.state)) return;
        await c.query(
          "UPDATE replenishment_automation_runs SET version=version+1,state='error',result=$2,finished_at=clock_timestamp() WHERE id=$1",
          [r.id, JSON.stringify({ reason: 'lease_exhausted' })],
        );
        await c.query('SET CONSTRAINTS ALL IMMEDIATE');
        changed++;
      },
      writeTx,
    );
  return changed;
}
