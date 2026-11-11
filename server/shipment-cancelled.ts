import type { PoolClient } from 'pg';
import { ensure } from './errors';
import { CANCELLED_SHIPMENT } from './order-stage';

/**
 * A label cancelled with "Anuluj etykietę" (server/shipment-cancel.ts) keeps its shipment row, so every print and
 * download path refuses it on the server, not only the hidden card button.
 */
export async function assertLabelsNotCancelledInTx(
  c: PoolClient,
  shipmentIds: string[],
  refusal = 'Etykieta tej przesyłki została anulowana; nie można jej drukować ani pobrać',
): Promise<void> {
  if (!shipmentIds.length) return;
  const r = await c.query('SELECT 1 FROM shipments WHERE id=ANY($1::uuid[]) AND status=$2 LIMIT 1', [shipmentIds, CANCELLED_SHIPMENT]);
  ensure(!r.rowCount, 409, refusal);
}

/** The parcel plan SQL (134) does not read shipment status, so a cancelled DEMO label would pass as an "existing" parcel. */
export const CANCELLED_PARCEL_REFUSAL = 'Etykietę tego zamówienia anulowano; anulowanej etykiety nie można przydzielić do planu paczek';

export const RELABEL_REFUSAL =
  'Etykietę tego zamówienia anulowano. Nowej etykiety nie można utworzyć w tym samym zamówieniu: anulowana etykieta zostaje w historii, a zamówienie nadaje się tylko na jednej przesyłce';

/**
 * Every label path (DEMO, InPost, DPD, DHL, Poczta Polska) checks this before it queues or creates a label.
 * The sealed shipment guards count every shipment row of an order, the cancelled one included: a second row may be
 * inserted, but its hand-over is refused ("Wydanie wielu paczek wymaga jawnego przydziału pozycji",
 * order_shipments_guard 234, order_shipments_dispatch_guard 134/137), and the explicit parcel plan needs 2+ parcels
 * that include every existing shipment (order_parcel_frame 134). So the label is refused here, before it is bought.
 */
export async function assertNoShipmentForNewLabelInTx(c: PoolClient, orderId: string, refusal: string): Promise<void> {
  const rows = (await c.query<{ cancelled: boolean }>('SELECT status=$2 cancelled FROM shipments WHERE order_id=$1', [orderId, CANCELLED_SHIPMENT])).rows;
  ensure(!rows.length, 409, rows.length && rows.every((r) => r.cancelled) ? RELABEL_REFUSAL : refusal);
}
