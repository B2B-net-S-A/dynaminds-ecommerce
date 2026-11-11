/**
 * Automation rules v2: effects of lane M (supply). See server/automation-v2-effect-types.ts.
 *
 * supplier_order — the replenishment module (replenishment-plans.ts) plans and creates local draft purchase
 * orders for the order's short lines. Its preview/execute need the purchasing source admission, which is taken
 * only when a transaction begins (purchasing-transaction.ts) and cannot be upgraded inside the rule's run. So the
 * effect checks the shortage, policies and role in the run and queues SUPPLIER_ORDER_JOB in the same savepoint;
 * the job runs createReplenishmentPreviewInTx → executeReplenishmentPlanInTx in its own admitted transaction,
 * exactly like the module's own automation (replenishment-automations.ts). Nothing is sent to the supplier.
 *
 * send_to_fulfilment — the Amazon fulfilment module (amazon-fulfillment.ts): preview and queue in the run's
 * transaction (previewAmazonFulfillmentInTx, queueAmazonFulfillmentInTx); the module's own `amazon.fulfillment`
 * job does the rest. Only a simulation channel: a real account needs provider HTTP between transactions.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { result, type EffectEnv, type EffectModule } from './automation-v2-effect-types';
import { tenantTx } from './db';
import { audit, type Actor } from './domain';
import { ensure, Problem } from './errors';
import { localOrderEvent } from './events';
import {
  createReplenishmentPreviewInTx,
  executeReplenishmentPlanInTx,
  replenishmentPlansAvailable,
} from './replenishment-plans';
import { assertReplenishmentAutomationActorInTx } from './replenishment-automations';
import {
  amazonFulfillmentInput,
  previewAmazonFulfillmentInTx,
  queueAmazonFulfillmentInTx,
} from './amazon-fulfillment';

export const SUPPLIER_ORDER_JOB = 'automation.v2.supplier_order';
const POLICY_SUPPLIER = '';

/** A stable UUID (same shape as automation-v2-effects stableUuid): a retried job reuses the module's keys. */
function stableUuid(...parts: string[]): string {
  const h = createHash('sha256').update(parts.join('|')).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const supplierOrderParams = z.strictObject({
  /** '' = the supplier of each product's replenishment policy. */
  supplier_id: z.union([z.uuid(), z.literal(POLICY_SUPPLIER)]).default(POLICY_SUPPLIER),
});
type SupplierOrderParams = z.infer<typeof supplierOrderParams>;

const jobPayload = z.strictObject({
  order_id: z.uuid(),
  warehouse_id: z.uuid(),
  product_ids: z.array(z.uuid()).min(1).max(500),
  actor_id: z.uuid(),
  api_key_id: z.uuid().nullable(),
  rule_id: z.uuid(),
  rule_name: z.string(),
  run_id: z.uuid(),
});
type JobPayload = z.infer<typeof jobPayload>;
export interface SupplierOrderJob {
  id: string;
  tenant_id: string;
  lease_token: string;
  payload: unknown;
}
interface Outcome {
  state: 'done' | 'failed';
  changed: boolean;
  message: string;
  preview_id?: string;
  execution_id?: string;
  purchase_order_ids?: string[];
}

interface Shortage {
  product_id: string;
  sku: string;
  missing: number;
}

/** Lines whose order reservation plus free stock is below the ordered quantity (as product.stock_sufficient). */
async function shortages(c: PoolClient, orderId: string, warehouseId: string): Promise<Shortage[]> {
  return (
    await c.query<Shortage>(
      `SELECT x.product_id,x.sku,(x.needed-x.covered)::int AS missing FROM (
         SELECT i.product_id,p.sku,sum(i.quantity) AS needed,
           coalesce((SELECT sum(r.quantity) FROM reservations r WHERE r.order_id=$1 AND r.product_id=i.product_id AND r.state IN ('active','consumed')),0)
           + greatest(coalesce((SELECT s.on_hand-s.reserved FROM stock s WHERE s.warehouse_id=$2 AND s.product_id=i.product_id),0),0) AS covered
         FROM order_items i JOIN products p ON (p.tenant_id,p.id)=(i.tenant_id,i.product_id)
         WHERE i.order_id=$1 AND p.kind IN ('simple','variant') GROUP BY i.product_id,p.sku) x
       WHERE x.needed>x.covered ORDER BY x.sku,x.product_id`,
      [orderId, warehouseId],
    )
  ).rows;
}

async function adminForPurchasing(c: PoolClient, actor: Actor) {
  const role = (await c.query('SELECT replenishment_current_role($1,false) AS role', [actor.userId])).rows[0]?.role;
  ensure(role === 'admin', 403, 'Zamówienia do dostawców może zlecać tylko administrator');
}

async function supplierOrder(env: EffectEnv, p: SupplierOrderParams) {
  const { c, actor, orderId } = env;
  const type = 'supplier_order';
  ensure(await replenishmentPlansAvailable(c), 409, 'Planowanie zakupów nie jest dostępne w tej kopii');
  const o = (await c.query('SELECT id,warehouse_id,status FROM orders WHERE id=$1', [orderId])).rows[0];
  ensure(o, 404, 'Nie znaleziono zamówienia');
  ensure(o.status !== 'cancelled', 409, 'Zamówienie jest anulowane');
  ensure(o.warehouse_id, 422, 'Zamówienie nie ma magazynu');
  const short = await shortages(c, orderId, o.warehouse_id);
  if (!short.length) return result(type, false, 'Wszystkie pozycje są na stanie — bez zamówienia do dostawcy');
  const policies = new Map<string, string>(
    (
      await c.query(
        "SELECT product_id,definition->>'supplier_id' AS supplier_id FROM replenishment_policies WHERE warehouse_id=$1 AND product_id=ANY($2::uuid[]) AND (definition->>'enabled')::boolean",
        [o.warehouse_id, short.map((s) => s.product_id)],
      )
    ).rows.map((r) => [r.product_id, r.supplier_id]),
  );
  const missing = short.filter((s) => !policies.has(s.product_id));
  ensure(
    !missing.length,
    422,
    `Brak włączonej polityki uzupełnień (dostawcy) w magazynie zamówienia dla: ${missing.map((s) => s.sku).join(', ')}`,
  );
  const chosen = short.filter((s) => p.supplier_id === POLICY_SUPPLIER || policies.get(s.product_id) === p.supplier_id);
  if (!chosen.length) return result(type, false, 'Brakujące pozycje mają w polityce innego dostawcę — bez zmian');
  await adminForPurchasing(c, actor);
  const job = randomUUID();
  const payload: JobPayload = {
    order_id: orderId,
    warehouse_id: o.warehouse_id,
    product_ids: chosen.map((s) => s.product_id),
    actor_id: actor.userId,
    api_key_id: actor.apiKeyId ?? null,
    rule_id: env.rule.id,
    rule_name: env.rule.name,
    run_id: env.runId,
  };
  // One live or finished supplier order per order and supplier choice: a repeated run (or another rule)
  // changes nothing. A failed job does not count, so a run after the cause is fixed queues a new one.
  const scope = `v2-supplier-order:${orderId}:${p.supplier_id || 'policy'}`;
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`${actor.tenantId}:${scope}`]);
  const served = (
    await c.query("SELECT 1 FROM jobs WHERE kind=$1 AND (dedup_key=$2 OR dedup_key LIKE $2||':%') AND state<>'failed' LIMIT 1", [
      SUPPLIER_ORDER_JOB,
      scope,
    ])
  ).rowCount;
  if (served) return result(type, false, 'Zamówienie do dostawcy dla tego zamówienia zostało już zlecone — bez zmian');
  await c.query('INSERT INTO jobs(id,tenant_id,kind,payload,dedup_key,max_attempts) VALUES($1,$2,$3,$4,$5,3)', [
    job,
    actor.tenantId,
    SUPPLIER_ORDER_JOB,
    JSON.stringify(payload),
    `${scope}:${job}`,
  ]);
  const list = chosen.map((s) => `${s.sku} (brak ${s.missing})`).join(', ');
  return result(type, true, `Zlecono szkic zamówienia do dostawcy w module uzupełnień dla: ${list}`);
}

/** The module's own preview and execute; a plan that is not ready stays as a preview for the purchasing team. */
async function planAndExecute(c: PoolClient, a: Actor, p: JobPayload, jobId: string): Promise<Outcome> {
  ensure(await replenishmentPlansAvailable(c), 409, 'Planowanie zakupów nie jest dostępne w tej kopii');
  const o = (await c.query('SELECT warehouse_id,status FROM orders WHERE id=$1', [p.order_id])).rows[0];
  ensure(o && o.status !== 'cancelled', 409, 'Zamówienie anulowano lub usunięto');
  ensure(o.warehouse_id === p.warehouse_id, 409, 'Magazyn zamówienia zmienił się');
  const items = (
    await c.query(
      'SELECT p.id AS product_id,p.version AS product_version,r.version AS policy_version FROM products p JOIN replenishment_policies r ON (r.tenant_id,r.product_id)=(p.tenant_id,p.id) AND r.warehouse_id=$2 WHERE p.id=ANY($1::uuid[]) ORDER BY p.id',
      [p.product_ids, p.warehouse_id],
    )
  ).rows;
  ensure(items.length === p.product_ids.length, 409, 'Polityka uzupełnień produktu została usunięta');
  const preview = (
    await createReplenishmentPreviewInTx(
      c,
      a,
      { client_key: stableUuid('v2-supplier-preview', jobId), warehouse_id: p.warehouse_id, items },
      { finalize: false },
    )
  ).preview as Record<string, any>;
  if (!preview.ready) {
    const errors = (
      await c.query(
        "SELECT coalesce(p.sku,'?') AS sku,r.errors FROM replenishment_rows r LEFT JOIN products p ON (p.tenant_id,p.id)=(r.tenant_id,r.product_id) WHERE r.preview_id=$1 AND r.status IN ('invalid','conflict') ORDER BY r.index",
        [preview.id],
      )
    ).rows.map((r) => `${r.sku}: ${(r.errors as string[]).join(', ')}`);
    return { state: 'failed', changed: true, preview_id: preview.id, message: `Plan uzupełnień wymaga poprawek — ${errors.join('; ')}` };
  }
  if (!preview.purchase)
    return { state: 'done', changed: false, preview_id: preview.id, message: 'Stan z dostawami pokrywa minimum polityki — bez nowego zamówienia do dostawcy' };
  const execution = (
    await executeReplenishmentPlanInTx(
      c,
      a,
      preview.id,
      { client_key: stableUuid('v2-supplier-execute', jobId), scope_hash: preview.scope_hash, confirmed: true },
      { finalize: false },
    )
  ).execution as Record<string, any>;
  const groups = execution.groups as Array<{ purchase_order_id: string; number: string; line_count: number }>;
  return {
    state: 'done',
    changed: true,
    preview_id: preview.id,
    execution_id: execution.id,
    purchase_order_ids: groups.map((g) => g.purchase_order_id),
    message: `Utworzono szkic zamówienia do dostawcy ${groups.map((g) => `${g.number} (${g.line_count} poz.)`).join(', ')}; nic nie wysłano do dostawcy`,
  };
}

async function record(c: PoolClient, a: Actor, p: JobPayload, jobId: string, out: Outcome) {
  await localOrderEvent(c, a.tenantId, p.order_id, 'automation.supplier_order', {
    rule_id: p.rule_id,
    rule_name: p.rule_name,
    run_id: p.run_id,
    job_id: jobId,
    ...out,
  });
  await audit(c, a, 'automation.supplier_order.' + out.state, p.order_id, { rule_id: p.rule_id, run_id: p.run_id, ...out });
  await c.query('UPDATE jobs SET state=$2,error=$3,lease_token=NULL,locked_at=NULL WHERE id=$1', [
    jobId,
    out.state,
    out.state === 'failed' ? out.message : null,
  ]);
}

const actorOf = (tenantId: string, p: JobPayload): Actor => ({
  tenantId,
  userId: p.actor_id,
  role: 'admin',
  ...(p.api_key_id ? { apiKeyId: p.api_key_id } : {}),
});

const admitted = { wmsAdmission: 'read' as const, purchasingAdmission: true };

/** SUPPLIER_ORDER_JOB worker: lease-bound; the result goes to the order's history and the job row. */
export async function processSupplierOrderJob(job: SupplierOrderJob): Promise<Outcome | null> {
  return tenantTx(
    job.tenant_id,
    async (c) => {
      const leased = (
        await c.query("SELECT id FROM jobs WHERE id=$1 AND kind=$2 AND state='running' AND lease_token=$3 FOR UPDATE", [
          job.id,
          SUPPLIER_ORDER_JOB,
          job.lease_token,
        ])
      ).rowCount;
      if (!leased) return null;
      const p = jobPayload.parse(job.payload);
      const a = actorOf(job.tenant_id, p);
      let out: Outcome;
      await c.query('SAVEPOINT v2_supplier_order');
      try {
        out = await planAndExecute(c, a, p, job.id);
        await c.query('RELEASE SAVEPOINT v2_supplier_order');
      } catch (e) {
        await c.query('ROLLBACK TO SAVEPOINT v2_supplier_order');
        if (!(e instanceof Problem)) throw e;
        out = { state: 'failed', changed: false, message: `Zamówienie do dostawcy: ${e.message}` };
      }
      await record(c, a, p, job.id, out);
      await c.query('SET CONSTRAINTS ALL IMMEDIATE');
      // The module's final actor pin, after every PO, evidence and job write (finalize:false above).
      if (out.changed) await assertReplenishmentAutomationActorInTx(c, a, true);
      return out;
    },
    admitted,
  );
}

/** Worker error handler: ends the lease once and leaves a readable failure on the order. */
export async function failSupplierOrderJob(job: SupplierOrderJob, e: unknown): Promise<void> {
  const message = `Zamówienie do dostawcy: ${e instanceof Problem ? e.message : 'błąd wykonania'}`;
  await tenantTx(job.tenant_id, async (c) => {
    const leased = (
      await c.query("SELECT id FROM jobs WHERE id=$1 AND kind=$2 AND state='running' AND lease_token=$3 FOR UPDATE", [
        job.id,
        SUPPLIER_ORDER_JOB,
        job.lease_token,
      ])
    ).rowCount;
    if (!leased) return;
    const p = jobPayload.safeParse(job.payload);
    if (p.success) await record(c, actorOf(job.tenant_id, p.data), p.data, job.id, { state: 'failed', changed: false, message });
    else await c.query("UPDATE jobs SET state='failed',error=$2,lease_token=NULL,locked_at=NULL WHERE id=$1", [job.id, message]);
  });
}

async function sendToFulfilment(env: EffectEnv, p: z.infer<typeof amazonFulfillmentInput>) {
  try {
    const plan = await previewAmazonFulfillmentInTx(env.c, env.actor, env.orderId, p);
    const queued = await queueAmazonFulfillmentInTx(env.c, env.actor, plan.id, false);
    return result('send_to_fulfilment', true, `Przekazano wysyłkę do Amazon (symulacja), zgłoszenie ${queued.state === 'queued' ? 'w kolejce' : queued.state}`);
  } catch (e) {
    if (!(e instanceof Problem)) throw e;
    throw new Problem(e.status >= 500 ? 409 : e.status, `Amazon: ${e.message}`);
  }
}

export const effects: EffectModule = {
  handlers: {
    supplier_order: {
      schema: supplierOrderParams,
      validate: async (c, p: SupplierOrderParams) => {
        if (p.supplier_id === POLICY_SUPPLIER) return;
        ensure((await c.query('SELECT 1 FROM suppliers WHERE id=$1 AND active', [p.supplier_id])).rowCount, 422, 'Dostawca jest nieaktywny lub spoza organizacji');
      },
      describe: (p: SupplierOrderParams, names) =>
        p.supplier_id === POLICY_SUPPLIER
          ? 'Utworzy szkic zamówienia do dostawcy z polityki uzupełnień dla brakujących pozycji'
          : `Utworzy szkic zamówienia u dostawcy ${names[p.supplier_id] ?? p.supplier_id} dla brakujących pozycji`,
      apply: (env, p: SupplierOrderParams) => supplierOrder(env, p),
    },
    send_to_fulfilment: {
      schema: amazonFulfillmentInput,
      describe: (p: z.infer<typeof amazonFulfillmentInput>) =>
        `Przekaże wysyłkę zamówienia Amazon do realizacji (przewoźnik ${p.carrier_code}; konto w trybie symulacji)`,
      apply: (env, p: z.infer<typeof amazonFulfillmentInput>) => sendToFulfilment(env, p),
    },
  },
  catalogParams: async (c) => {
    const present = (await c.query("SELECT to_regclass('public.suppliers') IS NOT NULL AS present")).rows[0].present;
    const suppliers = present ? (await c.query('SELECT id,name FROM suppliers WHERE active ORDER BY name,id LIMIT 200')).rows : [];
    return {
      supplier_order: [
        {
          key: 'supplier_id',
          label: 'Dostawca',
          kind: 'select',
          options: [
            { value: POLICY_SUPPLIER, label: 'Dostawca z polityki uzupełnień produktu' },
            ...suppliers.map((s) => ({ value: s.id, label: s.name })),
          ],
        },
      ],
      send_to_fulfilment: [
        { key: 'carrier_code', label: 'Kod przewoźnika Amazon (np. DPD, Other)', kind: 'text', required: true },
        { key: 'carrier_name', label: 'Nazwa przewoźnika (dla Other)', kind: 'text' },
        { key: 'shipping_method', label: 'Metoda wysyłki', kind: 'text' },
      ],
    };
  },
};
