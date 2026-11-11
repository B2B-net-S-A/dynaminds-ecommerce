/**
 * Automation rules v2: maps committed order events to v2 triggers and queues one evaluation job per event.
 * Kept free of domain imports: server/events.ts calls it for every order event.
 *
 * A v2 rule is stored with trigger 'v2:<key>' so legacy readers (v1 event rules, buyer-message workflows,
 * packing and local demo checks), which select by exact trigger, never see it.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';

export const V2_PREFIX = 'v2:';
export const V2_JOB = 'automation.v2';
export const V2_RUN_JOB = 'automation.v2.run';

/** Chain context of the v2 effects being applied: events raised by domain functions inherit it. */
export type ChainContext = { chain_id: string; depth: number; trace: string[] };
export const automationChain = new AsyncLocalStorage<ChainContext>();

const STAGES = [
  'new', 'paid', 'picking', 'packed', 'shipped', 'delivered', 'completed', 'cancelled',
  'return_initiated', 'return_received', 'return_completed',
];
const STATUS_KINDS = new Set(STAGES.map((s) => 'order.' + s));
const EDIT_KINDS = new Set([
  'order.section_edited', 'order.customer_updated', 'order.item_added', 'order.item_removed',
  'order.item_quantity_changed', 'order.delivery_address_changed', 'order.note_added', 'order.tags_changed',
]);
const DIRECT = new Set([
  'order.created', 'order.cancelled', 'payment.changed', 'order.all_scanned', 'order.item_missing',
  'shipment.created', 'shipment.cancelled', 'shipment.status_changed', 'document.issued', 'return.registered',
  'stock.changed', 'customer_message.received',
]);
/** Events of the engine itself: history only, never re-evaluated. */
const SILENT = (kind: string) => kind.startsWith('automation.') || kind.startsWith('custom.');

/** v2 trigger keys raised by an order event. 'order.matches' follows every order change. */
export function v2TriggersFor(kind: string): string[] {
  if (SILENT(kind)) return [];
  const t = new Set<string>(['order.matches']);
  if (DIRECT.has(kind)) t.add(kind);
  if (STATUS_KINDS.has(kind) || kind === 'order.workflow_changed') t.add('order.status_changed');
  if (EDIT_KINDS.has(kind)) t.add('order.section_edited');
  if (kind.startsWith('payment.') || kind === 'order.paid' || kind === 'order.payment_reopened') t.add('payment.changed');
  // The dispatcher keeps this trigger only when every line is scanned.
  if (kind === 'item.scanned') t.add('order.all_scanned');
  if (kind === 'return.requested' || kind === 'order.return_initiated') t.add('return.registered');
  if (kind === 'return.document') t.add('document.issued');
  if (kind === 'order.shipped' || kind === 'order.delivered' || kind === 'order.parcel.dispatched') t.add('shipment.status_changed');
  return [...t];
}

/** One status change of an order event: fulfilment stage code or own status (workflow_statuses.id). */
export type StatusChange = { from: string | null; to: string };
/** Previous and new status of the 'order.status_changed' trigger, filtered by config.status_change. */
export type StatusChangeFilter = { from: string[]; to: string[] };

/** Status change carried by an order event: `order.<stage>` {from} or `order.workflow_changed` {from,to}. */
export function statusChangeOf(kind: string, detail: unknown): StatusChange | null {
  const d = (detail ?? {}) as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === 'string' && v ? v : null);
  if (STATUS_KINDS.has(kind)) return { from: text(d.from), to: kind.slice('order.'.length) };
  if (kind === 'order.workflow_changed' && text(d.to)) return { from: text(d.from), to: text(d.to)! };
  return null;
}

/**
 * "Z dowolnego lub z wybranego statusu na wybrany". All status changes of one transaction are merged into one
 * evaluation (a set_workflow emits the stage change and the own-status change), so the filter looks at them
 * together: some previous status is in `from` and some new status is in `to`. Empty list = any status.
 */
export function statusChangeMatches(filter: StatusChangeFilter | undefined, changes: StatusChange[] | undefined): boolean {
  if (!filter || (!filter.from.length && !filter.to.length)) return true;
  const list = changes ?? [];
  if (!list.length) return false;
  const fromOk = !filter.from.length || list.some((ch) => ch.from !== null && filter.from.includes(ch.from));
  const toOk = !filter.to.length || list.some((ch) => filter.to.includes(ch.to));
  return fromOk && toOk;
}

/** Queues the v2 evaluation of an order event when the tenant has an enabled v2 rule for its triggers. */
export async function queueV2Evaluation(
  c: PoolClient,
  tenantId: string,
  orderId: string,
  eventId: string,
  kind: string,
  context: ChainContext,
  detail?: unknown,
) {
  const triggers = v2TriggersFor(kind);
  if (!triggers.length) return;
  const wanted = triggers.map((t) => V2_PREFIX + t);
  const any = await c.query('SELECT 1 FROM automation_rules WHERE enabled AND trigger=ANY($1::text[]) LIMIT 1', [wanted]);
  if (!any.rowCount) return;
  const change = statusChangeOf(kind, detail);
  // One evaluation per order and transaction: several events of one change (status + workflow + tags) merge their
  // triggers and status changes into the first event's job, which runs after the whole change is committed.
  await c.query(
    `INSERT INTO jobs(id,tenant_id,kind,payload,dedup_key) VALUES($1,$2,$3,$4,'v2:tx:'||txid_current()||':'||$5)
     ON CONFLICT (tenant_id,dedup_key) DO UPDATE SET payload=jsonb_set(jsonb_set(jobs.payload,'{triggers}',
       (SELECT jsonb_agg(DISTINCT t) FROM jsonb_array_elements_text((jobs.payload->'triggers')||(EXCLUDED.payload->'triggers')) t)),
       '{status_changes}',coalesce(jobs.payload->'status_changes',jsonb_build_array())||coalesce(EXCLUDED.payload->'status_changes',jsonb_build_array()))
     WHERE jobs.state='pending'`,
    [
      randomUUID(),
      tenantId,
      V2_JOB,
      JSON.stringify({ event_id: eventId, order_id: orderId, kind, triggers, context, status_changes: change ? [change] : [] }),
      orderId,
    ],
  );
}

/** History-and-automation event for facts that are not order changes for webhooks (labels, documents, tracking). */
export async function automationOnlyEvent(
  c: PoolClient,
  tenantId: string,
  orderId: string,
  kind: string,
  detail: Record<string, unknown> = {},
) {
  const id = randomUUID();
  await c.query('INSERT INTO order_events(id,tenant_id,order_id,kind,detail) VALUES($1,$2,$3,$4,$5)', [
    id,
    tenantId,
    orderId,
    kind,
    JSON.stringify(detail),
  ]);
  await queueV2Evaluation(c, tenantId, orderId, id, kind, automationChain.getStore() ?? { chain_id: randomUUID(), depth: 0, trace: [] }, detail);
  return id;
}
