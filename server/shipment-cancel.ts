/**
 * "Anuluj etykietę" (automation rules v2 trigger shipment.cancelled): cancels a label that was not handed to the
 * carrier, so the order goes back from "Gotowe do nadania" to "Spakowane" (server/order-stage.ts) and the sections
 * locked by the label open again (server/order-sections.ts).
 *
 * Shipment rows are permanent (order_shipments_guard, 133/134/234): the label keeps its row with status 'canceled';
 * only status-only updates are allowed, which is what this does. The same guards count every shipment row of an
 * order, so this version cannot issue a second label for the same order (that needs a migration of the guards).
 *
 * Scope:
 * - DEMO label (mode 'demo', no carrier account): fully local;
 * - carrier account in simulation (mode 'demo' with a channel): simulated, its ready plan is cancelled too;
 * - real carrier API: InPost ShipX cancels only unpaid shipments and the DPD, DHL and Poczta Polska connectors have
 *   no cancel operation, so a bought label is refused with the place to cancel it.
 */
import type { PoolClient } from 'pg';
import { audit, getOrder, lockedOrder, type Actor } from './domain';
import { ensure, Problem } from './errors';
import { automationOnlyEvent } from './automation-v2-triggers';
import { CANCELLED_SHIPMENT } from './order-stage';
import { assertNoOrderParcelPlanInTx } from './order-parcel-guards';

const REAL_CARRIER_REFUSAL: Record<string, string> = {
  inpost: 'InPost ShipX anuluje tylko nieopłacone przesyłki; opłaconą etykietę anulujesz w Managerze Paczek InPost',
  dpd: 'Konektor DPD nie ma operacji anulowania etykiety; anuluj ją w panelu DPD',
  dhl: 'Konektor DHL nie ma operacji anulowania etykiety; anuluj ją w panelu DHL',
  pocztapolska: 'Konektor Poczty Polskiej nie ma operacji anulowania etykiety; anuluj ją w eNadawcy',
};

export type LabelCancelScope = 'local' | 'simulation';

/** Which kind of cancellation a shipment allows; throws the reason for a real carrier label. */
export function labelCancelScope(shipment: { mode: string; channel_id: string | null }, provider: string | null): LabelCancelScope {
  if (shipment.mode === 'demo') return shipment.channel_id ? 'simulation' : 'local';
  throw new Problem(409, REAL_CARRIER_REFUSAL[provider ?? ''] ?? 'Ten przewoźnik nie pozwala anulować etykiety przez API');
}

export async function cancelLabelInTx(c: PoolClient, a: Actor, orderId: string) {
  ensure(a.role !== 'viewer', 403, 'Konto ma uprawnienia tylko do odczytu');
  const o = await lockedOrder(c, orderId);
  ensure(o.status === 'packed', 409, 'Etykietę anulujesz przed nadaniem, gdy zamówienie jest „Gotowe do nadania”');
  await assertNoOrderParcelPlanInTx(c, orderId);
  const live = (
    await c.query('SELECT * FROM shipments WHERE order_id=$1 AND status<>$2 ORDER BY created_at,id FOR UPDATE', [orderId, CANCELLED_SHIPMENT])
  ).rows;
  ensure(live.length > 0, 409, 'Zamówienie nie ma etykiety do anulowania');
  ensure(live.length === 1, 409, 'Zamówienie ma kilka paczek; anulujesz je w planie paczek');
  const s = live[0];
  ensure(!s.dispatched_at, 409, 'Przesyłkę przekazano już przewoźnikowi; etykiety nie można anulować');
  const channel = s.channel_id ? (await c.query('SELECT provider,settings FROM channels WHERE id=$1', [s.channel_id])).rows[0] : null;
  const scope = labelCancelScope(s, channel?.provider ?? null);
  if (scope === 'simulation') {
    ensure(channel?.settings?.simulation === true, 409, 'Konto przewoźnika nie jest już w trybie symulacji');
    const plans = (await c.query("SELECT id,state FROM shipping_plans WHERE shipment_id=$1 AND state NOT IN ('preview','cancelled') FOR UPDATE", [s.id])).rows;
    ensure(plans.every((p) => p.state === 'ready'), 409, 'Przesyłka ma niezakończone zadanie przewoźnika; spróbuj za chwilę');
    for (const p of plans)
      await c.query("UPDATE shipping_plans SET state='cancelled',phase='cancelled',updated_at=now() WHERE id=$1", [p.id]);
  }
  await c.query('UPDATE shipments SET status=$2 WHERE id=$1', [s.id, CANCELLED_SHIPMENT]);
  await automationOnlyEvent(c, a.tenantId, orderId, 'shipment.cancelled', {
    shipment_id: s.id,
    carrier: s.carrier,
    tracking_number: s.tracking_number,
    scope,
  });
  await audit(c, a, 'shipment.label_cancelled', orderId, { shipment_id: s.id, scope });
  return getOrder(c, orderId);
}
