/** B2B-004-X (251): the supplier accepts or rejects a network purchase, and the buyer gets an event per
 * decision and per dispatched supplier parcel.
 *
 * Decisions (see INTEGRATION.md): the checkout keeps creating the supplier order with its ordinary reservation, so
 * nothing is oversold while the supplier decides. The decision window is DECISION_WINDOW_HOURS. A rejection, an
 * expired window on an untouched order, or the supplier's own cancellation cancels the supplier order through
 * cancelOrder (which releases the reservation; a cancelled order also leaves the trade-credit exposure) and the
 * buyer's purchase. Started fulfilment or a dispatched parcel counts as acceptance, so the sweep never cancels an
 * order the supplier is working on. Lock order everywhere: buyer purchase, supplier order, decision. */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { pool, tenantReadTx, tenantTx } from './db';
import { audit, cancelOrder, type Actor } from './domain';
import { ensure, Problem } from './errors';
import { networkTx as tx, networkScope as scope, networkAdmin as admin } from './b2b-network';
import { networkLifecycleInstalled } from './b2b-network-lifecycle-release';
import { DECISION_WINDOW_HOURS, decisionPlan, sweepPlan, type DecisionState } from './b2b-network-lifecycle-model';
import { copyDropshipTrackingInTx } from './b2b-network-tracking';
import { networkSupplierBuyerOrder } from './b2b-network-orders';

const decideInput = z
  .object({ decision: z.enum(['accept', 'reject']), version: z.number().int().positive(), reason: z.string().trim().max(500).default(''), confirmed: z.literal(true) })
  .strict()
  .refine((b) => b.decision === 'accept' || b.reason.length >= 3, { message: 'Podaj powód odrzucenia (co najmniej 3 znaki)', path: ['reason'] });
const confirm = z.object({ confirmed: z.literal(true) }).strict();
const FULFILMENT = ['picking', 'packed', 'shipped', 'delivered', 'completed'];

const publicDecision = (d: any) => d && ({
  order_id: d.order_id, network_order_id: d.network_order_id, state: d.state as DecisionState, decide_by: d.decide_by, decided_at: d.decided_at,
  decided_via: d.decided_via, reason: d.reason, version: d.version, created_at: d.created_at, sweep_error: d.sweep_error ?? null,
});

/** Checkout (buyer scope on entry and return): the new purchase waits for the supplier. */
export async function openNetworkDecisionInTx(c: PoolClient, own: any): Promise<void> {
  if (!(await networkLifecycleInstalled(c))) return;
  await scope(c, own.supplier_tenant_id);
  await c.query(
    `INSERT INTO b2b258_order_decisions(tenant_id,order_id,buyer_tenant_id,network_order_id,link_id,account_id,decide_by)
     VALUES($1,$2,$3,$4,$5,$6,now()+make_interval(hours=>$7))`,
    [own.supplier_tenant_id, own.source_order_id, own.tenant_id, own.id, own.link_id, own.account_id, DECISION_WINDOW_HOURS],
  );
  await scope(c, own.tenant_id);
}
/** Buyer scope: the decision on an own purchase (null before 251 or for a purchase older than 251). */
export async function networkDecisionViewInTx(c: PoolClient, networkOrderId: string) {
  if (!(await networkLifecycleInstalled(c))) return null;
  return publicDecision((await c.query('SELECT * FROM b2b258_order_decisions WHERE network_order_id=$1', [networkOrderId])).rows[0]) ?? null;
}
async function buyerEvent(c: PoolClient, buyerTenant: string, networkOrderId: string, kind: string, key: string, detail: Record<string, unknown>) {
  await scope(c, buyerTenant);
  return (await c.query(
    `INSERT INTO b2b258_order_events(id,tenant_id,network_order_id,kind,dedup_key,detail,created_at) VALUES($1,$2,$3,$4,$5,$6,clock_timestamp())
     ON CONFLICT(tenant_id,network_order_id,dedup_key) DO NOTHING RETURNING id`,
    [randomUUID(), buyerTenant, networkOrderId, kind, key, JSON.stringify(detail)],
  )).rowCount ?? 0;
}
/** Buyer cancel (any scope): a pending decision is withdrawn. Ends in the buyer scope. */
export async function withdrawNetworkDecisionInTx(c: PoolClient, o: any, a: Actor, reason: string): Promise<void> {
  if (!(await networkLifecycleInstalled(c))) return;
  await scope(c, o.supplier_tenant_id);
  const d = (await c.query(
    "UPDATE b2b258_order_decisions SET state='withdrawn',decided_at=now(),decided_via='buyer',decided_by=$2,reason=$3,version=version+1 WHERE order_id=$1 AND state='pending' RETURNING *",
    [o.source_order_id, a.userId, reason.slice(0, 500)],
  )).rows[0];
  if (d) await buyerEvent(c, o.tenant_id, o.id, 'withdrawn', 'decision', { reason: d.reason });
  await scope(c, o.tenant_id);
}
/** Supplier scope on entry and return. Locks buyer purchase, supplier order and decision in that order. */
async function lockedDecision(c: PoolClient, supplierTenant: string, orderId: string) {
  const ref = (await c.query('SELECT * FROM b2b258_order_decisions WHERE tenant_id=$1 AND order_id=$2', [supplierTenant, orderId])).rows[0];
  ensure(ref, 404, 'Nie znaleziono zamówienia z sieci B2B');
  await scope(c, ref.buyer_tenant_id);
  const purchase = (await c.query('SELECT * FROM b2b_network_orders WHERE id=$1 FOR UPDATE', [ref.network_order_id])).rows[0];
  ensure(purchase, 409, 'Zamówienie zmieniło się; odśwież listę');
  // The same supplier-order lock and merge check as the buyer's cancel: a merged order is never cancelled from here.
  const view = await networkSupplierBuyerOrder(c, purchase, true);
  ensure(!view.origin, 409, 'Zamówienie dostawcy połączono z innym; rozstrzygnij je w karcie zamówienia');
  await scope(c, supplierTenant);
  const order = (await c.query('SELECT id,status FROM orders WHERE id=$1', [orderId])).rows[0];
  const d = (await c.query('SELECT * FROM b2b258_order_decisions WHERE tenant_id=$1 AND order_id=$2 FOR UPDATE', [supplierTenant, orderId])).rows[0];
  ensure(order && d, 409, 'Zamówienie zmieniło się; odśwież listę');
  const dispatched = ((await c.query('SELECT 1 FROM shipments WHERE order_id=$1 AND dispatched_at IS NOT NULL LIMIT 1', [orderId])).rowCount ?? 0) > 0;
  return { d, purchase, order, dispatched };
}
async function close(c: PoolClient, d: any, state: DecisionState, via: string, by: string | null, reason: string) {
  return (await c.query(
    'UPDATE b2b258_order_decisions SET state=$3,decided_via=$4,decided_by=$5,reason=$6,decided_at=now(),version=version+1 WHERE tenant_id=$1 AND order_id=$2 RETURNING *',
    [d.tenant_id, d.order_id, state, via, by, reason.slice(0, 500)],
  )).rows[0];
}
/** Cancels the supplier order (releasing its reservation) and the buyer's purchase. Supplier scope on entry/return. */
async function cancelBoth(c: PoolClient, d: any, purchase: any, order: any, a: Actor | { tenantId: string; userId: null }, by: string, reason: string) {
  if (order.status !== 'cancelled') await cancelOrder(c, a, d.order_id);
  await scope(c, d.buyer_tenant_id);
  ensure(!(await c.query('SELECT 1 FROM b2b_network_order_lines WHERE order_id=$1 AND received>0', [purchase.id])).rowCount, 409, 'Kupujący przyjął już towar; rozlicz przez zwrot');
  if (purchase.state === 'ordered')
    await c.query("UPDATE b2b_network_orders SET state='cancelled',version=version+1,cancel_request=$2,cancelled_at=now() WHERE id=$1",
      [purchase.id, JSON.stringify({ by, reason })]);
  await audit(c, { tenantId: d.buyer_tenant_id, userId: null }, 'b2b.network.supplier_cancel', purchase.id, { by, reason });
  await scope(c, d.tenant_id);
}
async function settleInTx(c: PoolClient, supplierTenant: string, orderId: string, now: Date) {
  const { d, purchase, order, dispatched } = await lockedDecision(c, supplierTenant, orderId);
  if (d.state !== 'pending') return false;
  const plan = sweepPlan(order.status, dispatched, now, d.decide_by);
  if (plan === 'wait') return false;
  const system = { tenantId: supplierTenant, userId: null };
  if (plan === 'accept') {
    await close(c, d, 'accepted', 'dispatch', null, '');
    await buyerEvent(c, d.buyer_tenant_id, d.network_order_id, 'accepted', 'decision', { via: 'dispatch' });
  } else if (plan === 'reject') {
    const reason = 'Dostawca anulował zamówienie';
    await cancelBoth(c, d, purchase, order, system, 'supplier', reason);
    await close(c, d, 'rejected', 'supplier', null, reason);
    await buyerEvent(c, d.buyer_tenant_id, d.network_order_id, 'rejected', 'decision', { reason });
  } else {
    const reason = 'Dostawca nie potwierdził zamówienia w terminie';
    await cancelBoth(c, d, purchase, order, system, 'expiry', reason);
    await close(c, d, 'expired', 'expiry', null, reason);
    await buyerEvent(c, d.buyer_tenant_id, d.network_order_id, 'expired', 'decision', { reason });
  }
  await scope(c, supplierTenant);
  await audit(c, system, 'b2b.network.decision_' + plan, orderId, { network_order_id: d.network_order_id });
  return true;
}
/** Buyer scope on entry and return: one event per dispatched supplier parcel. */
export async function recordDispatchEventsInTx(c: PoolClient, purchase: { id: string; tenant_id: string; supplier_tenant_id: string; source_order_id: string }) {
  if (!(await networkLifecycleInstalled(c))) return 0;
  await scope(c, purchase.supplier_tenant_id);
  const parcels = (await c.query('SELECT id,carrier,tracking_number,dispatched_at FROM shipments WHERE order_id=$1 AND dispatched_at IS NOT NULL ORDER BY dispatched_at,id LIMIT 100', [purchase.source_order_id])).rows;
  let added = 0;
  for (const p of parcels)
    added += await buyerEvent(c, purchase.tenant_id, purchase.id, 'dispatched', 'dispatch:' + p.id, { carrier: p.carrier, tracking_number: p.tracking_number, dispatched_at: p.dispatched_at });
  await scope(c, purchase.tenant_id);
  return added;
}

/** Background step: settles due decisions, records dispatch events and copies dropshipping tracking. Each order runs
 * in its own transaction; failures do not stop the others and are reported together at the end. */
export async function sweepB2bNetworkLifecycleDue(): Promise<void> {
  const ok = (await pool.query("SELECT to_regclass('public.b2b258_order_decisions') IS NOT NULL AND to_regclass('public.b2b258_tracking_copies') IS NOT NULL AS ok")).rows[0].ok;
  if (!ok) return;
  const failures: string[] = [];
  const due = (await pool.query(
    `SELECT d.tenant_id,d.order_id FROM b2b258_order_decisions d JOIN orders o ON (o.tenant_id,o.id)=(d.tenant_id,d.order_id)
     WHERE d.state='pending' AND (d.sweep_after IS NULL OR d.sweep_after<=now()) AND (d.decide_by<=now() OR o.status IN ('cancelled','picking','packed','shipped','delivered','completed')
       OR EXISTS(SELECT 1 FROM shipments s WHERE (s.tenant_id,s.order_id)=(d.tenant_id,d.order_id) AND s.dispatched_at IS NOT NULL))
     ORDER BY d.decide_by,d.order_id LIMIT 50`,
  )).rows;
  for (const row of due)
    try {
      await tx(row.tenant_id, async (c) => settleInTx(c, row.tenant_id, row.order_id, (await c.query('SELECT now() now')).rows[0].now));
    } catch (e) {
      // Park the row for an hour with the refusal (shown in the supplier's inbox); a business refusal is not a failure.
      const message = (e instanceof Error ? e.message : String(e)).slice(0, 500);
      try {
        await tenantTx(row.tenant_id, (c) => c.query("UPDATE b2b258_order_decisions SET sweep_error=$3,sweep_after=now()+interval '1 hour' WHERE tenant_id=$1 AND order_id=$2 AND state='pending'", [row.tenant_id, row.order_id, message]));
      } catch (p) { failures.push('decyzja ' + row.order_id + ': ' + (p instanceof Error ? p.message : String(p))); }
      if (!(e instanceof Problem && e.status === 409)) failures.push('decyzja ' + row.order_id + ': ' + message);
    }
  const parcels = (await pool.query(
    `SELECT DISTINCT d.buyer_tenant_id,d.network_order_id FROM b2b258_order_decisions d JOIN shipments s ON (s.tenant_id,s.order_id)=(d.tenant_id,d.order_id)
     WHERE d.state IN ('pending','accepted') AND s.dispatched_at IS NOT NULL
       AND NOT EXISTS(SELECT 1 FROM b2b258_order_events e WHERE e.tenant_id=d.buyer_tenant_id AND e.network_order_id=d.network_order_id AND e.dedup_key='dispatch:'||s.id)
     LIMIT 50`,
  )).rows;
  for (const row of parcels)
    try {
      await tenantTx(row.buyer_tenant_id, async (c) => {
        const p = (await c.query('SELECT * FROM b2b_network_orders WHERE id=$1 FOR UPDATE', [row.network_order_id])).rows[0];
        if (p) await recordDispatchEventsInTx(c, p);
      });
    } catch (e) { failures.push('nadanie ' + row.network_order_id + ': ' + (e instanceof Error ? e.message : String(e))); }
  const drops = (await pool.query(
    `SELECT d.tenant_id,d.id FROM b2b_dropship_orders d WHERE d.state='ordered' AND EXISTS(SELECT 1 FROM shipments s
       WHERE s.tenant_id=d.supplier_tenant_id AND s.order_id=d.supplier_order_id AND s.dispatched_at IS NOT NULL AND btrim(s.tracking_number)<>''
       AND NOT EXISTS(SELECT 1 FROM b2b258_tracking_copies t WHERE t.tenant_id=d.tenant_id AND t.dropship_order_id=d.id AND t.source_shipment_id=s.id))
     ORDER BY d.id LIMIT 50`,
  )).rows;
  for (const row of drops)
    try {
      await tenantTx(row.tenant_id, async (c) => {
        const d = (await c.query('SELECT * FROM b2b_dropship_orders WHERE id=$1 FOR UPDATE', [row.id])).rows[0];
        if (d) await copyDropshipTrackingInTx(c, d);
      });
    } catch (e) { failures.push('śledzenie ' + row.id + ': ' + (e instanceof Error ? e.message : String(e))); }
  if (failures.length) throw new Problem(500, 'Sieć B2B: ' + failures.length + ' zadań nie powiodło się: ' + failures.slice(0, 5).join('; '));
}

export function registerB2bNetworkDecisionRoutes(app: FastifyInstance) {
  // Supplier inbox and decision.
  app.get('/api/b2b/network/decisions', async (r) =>
    tenantReadTx(r.actor.tenantId, async (c) => {
      const q = z.object({ state: z.enum(['pending', 'accepted', 'rejected', 'expired', 'withdrawn', '']).default('') }).strict().parse(r.query);
      if (!(await networkLifecycleInstalled(c))) return { data: [] };
      const rows = (await c.query(
        `SELECT d.*,o.number,o.total,o.currency,o.status,a.name account_name FROM b2b258_order_decisions d
         JOIN orders o ON (o.tenant_id,o.id)=(d.tenant_id,d.order_id) JOIN b2b_accounts a ON (a.tenant_id,a.id)=(d.tenant_id,d.account_id)
         WHERE d.tenant_id=$1 AND ($2='' OR d.state=$2) ORDER BY d.created_at DESC,d.order_id LIMIT 100`,
        [r.actor.tenantId, q.state],
      )).rows;
      return { data: rows.map((d) => ({ ...publicDecision(d), number: d.number, total_gross: d.total, currency: d.currency, order_status: d.status, account_name: d.account_name })) };
    }),
  );
  app.post('/api/b2b/network/decisions/:orderId', async (r) => {
    ensure(r.actor.role === 'admin', 403, 'Zamówienia z sieci B2B akceptuje administrator dostawcy');
    const b = decideInput.parse(r.body), orderId = z.uuid().parse((r.params as any).orderId), a: Actor = r.actor;
    return tx(a.tenantId, async (c) => {
      ensure(await networkLifecycleInstalled(c), 503, 'Akceptacja zamówień wymaga migracji 251');
      await admin(c, a);
      const { d, purchase, order, dispatched } = await lockedDecision(c, a.tenantId, orderId);
      const now = (await c.query('SELECT now() now')).rows[0].now as Date;
      const plan = decisionPlan(d, b.decision, b.version, now);
      if (plan === 'replay') return { decision: publicDecision(d), reused: true };
      let out;
      if (plan === 'rejected')
        ensure(!dispatched && !FULFILMENT.includes(order.status), 409, 'Realizacja zamówienia już trwa; anuluj je w karcie zamówienia');
      if (plan === 'accepted') {
        ensure(order.status !== 'cancelled', 409, 'Zamówienie jest anulowane');
        out = await close(c, d, 'accepted', 'supplier', a.userId, b.reason);
        await buyerEvent(c, d.buyer_tenant_id, d.network_order_id, 'accepted', 'decision', { via: 'supplier' });
      } else {
        await cancelBoth(c, d, purchase, order, a, 'supplier', b.reason);
        out = await close(c, d, 'rejected', 'supplier', a.userId, b.reason);
        await buyerEvent(c, d.buyer_tenant_id, d.network_order_id, 'rejected', 'decision', { reason: b.reason });
      }
      await scope(c, a.tenantId);
      await audit(c, a, 'b2b.network.decision_' + (plan === 'accepted' ? 'accept' : 'reject'), orderId, { network_order_id: d.network_order_id, reason: b.reason });
      return { decision: publicDecision(out), reused: false };
    });
  });
  // Buyer: the decision and the event feed of an own purchase.
  app.get('/api/b2b/network/orders/:orderId/events', async (r) =>
    tenantReadTx(r.actor.tenantId, async (c) => {
      const id = z.uuid().parse((r.params as any).orderId);
      ensure((await c.query('SELECT 1 FROM b2b_network_orders WHERE id=$1', [id])).rowCount, 404, 'Nie znaleziono zakupu B2B');
      if (!(await networkLifecycleInstalled(c))) return { decision: null, data: [] };
      const events = (await c.query('SELECT kind,detail,created_at FROM b2b258_order_events WHERE tenant_id=$1 AND network_order_id=$2 ORDER BY created_at,id LIMIT 200', [r.actor.tenantId, id])).rows;
      return { decision: await networkDecisionViewInTx(c, id), data: events };
    }),
  );
  app.post('/api/b2b/network/orders/:orderId/events/sync', async (r) => {
    confirm.parse(r.body);
    const id = z.uuid().parse((r.params as any).orderId), a: Actor = r.actor;
    return tx(a.tenantId, async (c) => {
      await admin(c, a);
      const p = (await c.query('SELECT * FROM b2b_network_orders WHERE id=$1 FOR UPDATE', [id])).rows[0];
      ensure(p, 404, 'Nie znaleziono zakupu B2B');
      return { added: await recordDispatchEventsInTx(c, p) };
    });
  });
}
