import { isCustomerWorkflowAction } from './customer-message-workflow-schema';
import { ensure } from './errors';
import { freezeEmailActions } from './email-actions';
import { freezeSmsActions } from './sms-actions';
import {freezeAutomaticStockActions} from './automation-local-channel';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { signalStatus } from './order-status-signals';
import { enqueueOutgoing } from './outbound-webhooks';
import { automationChain, queueV2Evaluation } from './automation-v2-triggers';
export type EventContext = {
  chain_id: string;
  depth: number;
  trace: string[];
  preview?: boolean;
  customer_message_preview?: true;
  operation?: { kind: 'rule' | 'schedule' | 'batch'; id: string; action_index: number };
};
export async function orderSnapshot(c: PoolClient, orderId: string) {
  const o = (
    await c.query(
      "SELECT id,status,source,total,currency,warehouse_id,workflow_status_id,tags,version,address->>'country' AS country FROM orders WHERE id=$1",
      [orderId],
    )
  ).rows[0];
  if (!o) return null;
  const items = (
    await c.query('SELECT sku,quantity FROM order_items WHERE order_id=$1 ORDER BY sku', [orderId])
  ).rows;
  return {
    ...o,
    item_count: items.reduce((n, i) => n + i.quantity, 0),
    skus: items.map((i) => i.sku),
  };
}
export async function event(
  c: PoolClient,
  tenantId: string,
  orderId: string,
  kind: string,
  detail: unknown = {},
  context?: EventContext,
) {
  const id = randomUUID(),
    snapshot = await orderSnapshot(c, orderId),
    ctx: EventContext = context ?? automationChain.getStore() ?? { chain_id: randomUUID(), depth: 0, trace: [] };
  const rules = (
    await c.query(
      'SELECT * FROM automation_rules WHERE enabled AND trigger=$1 ORDER BY priority,id LIMIT 100',
      [kind],
    )
  ).rows;
  const workflowIds = [
    ...new Set(
      rules.flatMap((r) =>
        (r.config.actions ?? [])
          .filter((a: any) => a.type === 'set_workflow')
          .map((a: any) => a.status_id),
      ),
    ),
  ];
  const workflows = workflowIds.length
    ? (
        await c.query('SELECT id,version FROM workflow_statuses WHERE id=ANY($1::uuid[])', [
          workflowIds,
        ])
      ).rows
    : [];
  for (const r of rules)
    if (r.config.actions)
      r.config.actions = r.config.actions.map((a: any) =>
        a.type === 'set_workflow'
          ? { ...a, status_version: workflows.find((s) => s.id === a.status_id)?.version }
          : a,
      );
  for (const r of rules)
    if (r.config.actions)
      r.config.actions = await freezeEmailActions(
        c,
        await freezeAutomaticStockActions(c,tenantId,r.actor_id,await freezeSmsActions(c, r.config.actions, false)),
        false,
      );
  await c.query(
    'INSERT INTO order_events(id,tenant_id,order_id,kind,detail) VALUES($1,$2,$3,$4,$5)',
    [id, tenantId, orderId, kind, JSON.stringify(detail)],
  );
  // Automation rules v2 evaluate the committed order later (server/automation-v2.ts).
  if (!ctx.preview) await queueV2Evaluation(c, tenantId, orderId, id, kind, { chain_id: ctx.chain_id, depth: ctx.depth, trace: ctx.trace }, detail);
  // An empty frozen rule list has no work to dispatch. Keeping a pending job
  // for every unconfigured order would fill the bounded communication queue.
  if(rules.length)await c.query('INSERT INTO jobs(id,tenant_id,kind,payload,dedup_key) VALUES($1,$2,$3,$4,$5)', [
    randomUUID(),
    tenantId,
    'automation',
    JSON.stringify({ eventId: id, orderId, trigger: kind, snapshot, context: ctx, rules }),
    `event:${id}`,
  ]);
  // AUTO-07: an own event changes nothing on the order, so no webhook `order.updated` and no status signal.
  if (!kind.startsWith('custom.')) {
    await enqueueOutgoing(c, tenantId, kind, snapshot);
    await signalStatus(c, tenantId, orderId);
  }
  return id;
}

// Explicitly local evidence: no automation freezing, outbox or provider/status signals.
export async function localOrderEvent(
  c: PoolClient,
  tenantId: string,
  orderId: string,
  kind: string,
  detail: unknown,
) {
  const id = randomUUID();
  await c.query(
    'INSERT INTO order_events(id,tenant_id,order_id,kind,detail) VALUES($1,$2,$3,$4,$5)',
    [id, tenantId, orderId, kind, JSON.stringify(detail)],
  );
  return id;
}

// Opt-in buyer communication dispatch. Snapshot excludes message/assignment data;
// this path deliberately has no outbound webhook or status/schedule signal.
export async function localAutomationEvent(
  c: PoolClient,
  tenantId: string,
  orderId: string,
  kind: string,
  rules: any[],
) {
  const id = randomUUID(),
    snapshot = await orderSnapshot(c, orderId),
    context = { chain_id: randomUUID(), depth: 0, trace: [] };
  if (!snapshot) throw new Error('Missing own order for local automation event');
  ensure(
    kind === 'customer_message.received' &&
      rules.every(
        (r) =>
          (r.config.actions ?? []).length > 0 &&
          (r.config.actions ?? []).every(isCustomerWorkflowAction),
      ),
    422,
    'Nieprawidłowa lokalna reguła wiadomości',
  );
  const frozen = rules;
  await c.query(
    'INSERT INTO order_events(id,tenant_id,order_id,kind,detail) VALUES($1,$2,$3,$4,$5)',
    [id, tenantId, orderId, kind, JSON.stringify({ source: 'buyer_portal' })],
  );
  await c.query('INSERT INTO jobs(id,tenant_id,kind,payload,dedup_key) VALUES($1,$2,$3,$4,$5)', [
    randomUUID(),
    tenantId,
    'automation',
    JSON.stringify({ eventId: id, orderId, trigger: kind, snapshot, context, rules: frozen }),
    `event:${id}`,
  ]);
  return id;
}
