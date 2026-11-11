/**
 * "Symuluj status przewoźnika (DEMO)": a DEMO shipment (mode 'demo', no carrier account) has no tracking, so the
 * card can set its carrier status by hand. It writes shipments.status (a status-only update the shipment guards
 * allow) and raises `shipment.status_changed` {shipment_id, from, to, status} like carrier tracking does
 * (server/tracking.ts), so rules with the condition "Status przesyłki" see the new status.
 */
import { z } from 'zod';
import type { PoolClient } from 'pg';
import { SHIPMENT_STATUSES, SHIPMENT_STATUS_LABELS } from '../shared/shipment-status';
import { audit, getOrder, lockedOrder, type Actor } from './domain';
import { ensure } from './errors';
import { automationOnlyEvent } from './automation-v2-triggers';
import { CANCELLED_SHIPMENT } from './order-stage';

export const demoShipmentStatusInput = z.strictObject({
  status: z.enum(SHIPMENT_STATUSES, { error: 'Wybierz status przesyłki' }),
});

export async function simulateDemoShipmentStatusInTx(c: PoolClient, a: Actor, orderId: string, raw: unknown) {
  ensure(a.role !== 'viewer', 403, 'Konto ma uprawnienia tylko do odczytu');
  const { status } = demoShipmentStatusInput.parse(raw);
  await lockedOrder(c, orderId);
  const s = (
    await c.query(
      "SELECT * FROM shipments WHERE order_id=$1 AND mode='demo' AND channel_id IS NULL AND status<>$2 ORDER BY created_at DESC,id DESC LIMIT 1 FOR UPDATE",
      [orderId, CANCELLED_SHIPMENT],
    )
  ).rows[0];
  ensure(s, 409, 'Symulacja dotyczy przesyłki DEMO; to zamówienie jej nie ma');
  ensure(s.dispatched_at, 409, 'Najpierw przekaż przesyłkę DEMO kurierowi (status „Nadane”)');
  ensure(s.status !== status, 409, `Przesyłka ma już status „${SHIPMENT_STATUS_LABELS[status]}”`);
  await c.query('UPDATE shipments SET status=$2 WHERE id=$1', [s.id, status]);
  await automationOnlyEvent(c, a.tenantId, orderId, 'shipment.status_changed', {
    shipment_id: s.id,
    from: s.status,
    to: status,
    status,
    scope: 'demo',
  });
  await audit(c, a, 'shipment.demo_status', orderId, { shipment_id: s.id, from: s.status, to: status });
  return getOrder(c, orderId);
}
