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

/**
 * Every label path (DEMO, InPost, DPD, DHL, Poczta Polska) asks this before it queues or creates a label, and the
 * carrier worker asks it again in the transaction that writes the shipment. An order without a shipment gets a new
 * row (null). A label cancelled with "Anuluj etykietę" and never handed over is taken over by the new label: the
 * sealed order guards count every shipment row of an order (order_shipments_dispatch_guard 134/137), so the order
 * keeps one row and migration 268 (order_shipments_guard) moves the old identity to shipment268_replaced_labels.
 * Any other shipment refuses with `refusal`.
 */
export async function newLabelTargetInTx(c: PoolClient, orderId: string, refusal: string): Promise<string | null> {
  const rows = (
    await c.query<{ id: string; status: string; dispatched_at: Date | null }>(
      'SELECT id,status,dispatched_at FROM shipments WHERE order_id=$1 ORDER BY created_at,id FOR UPDATE',
      [orderId],
    )
  ).rows;
  if (!rows.length) return null;
  ensure(rows.length === 1 && rows[0].status === CANCELLED_SHIPMENT && !rows[0].dispatched_at, 409, refusal);
  return rows[0].id;
}

export interface LabelShipment {
  tenantId: string;
  orderId: string;
  carrier: string;
  trackingNumber: string;
  mode: string;
  status?: string;
  channelId?: string | null;
  externalId?: string | null;
  codExpected: number;
}

/**
 * Writes the shipment of a new label: a new row with `id`, or the cancelled row `target` from newLabelTargetInTx
 * with the new identity (tracking state starts again). Returns the shipment id the label has.
 */
export async function writeLabelShipmentInTx(c: PoolClient, target: string | null, id: string, s: LabelShipment): Promise<string> {
  const values = [s.carrier, s.trackingNumber, s.mode, s.status ?? 'created', s.channelId ?? null, s.externalId ?? null, s.codExpected];
  if (!target) {
    await c.query(
      'INSERT INTO shipments(id,tenant_id,order_id,carrier,tracking_number,mode,status,channel_id,external_id,cod_expected) VALUES($8,$9,$10,$1,$2,$3,$4,$5,$6,$7)',
      [...values, id, s.tenantId, s.orderId],
    );
    return id;
  }
  const r = await c.query(
    `UPDATE shipments SET carrier=$1,tracking_number=$2,mode=$3,status=$4,channel_id=$5,external_id=$6,cod_expected=$7,created_at=now(),
      tracking_data=NULL,tracking_at=NULL,tracking_revision=0,tracking_next_at=NULL,tracking_error=NULL,tracking_job_id=NULL,
      tracking_provider_created_at=NULL,tracking_demo_status=NULL
     WHERE id=$8 AND order_id=$9 AND status=$10 AND dispatched_at IS NULL`,
    [...values, target, s.orderId, CANCELLED_SHIPMENT],
  );
  ensure(r.rowCount === 1, 409, 'Anulowana etykieta zmieniła się; odśwież zamówienie');
  return target;
}

/** Labels that a new label replaced after "Anuluj etykietę" (migration 268), oldest first, for the order card. */
export async function replacedLabelsInTx(c: PoolClient, orderId: string) {
  return (
    await c.query<{ carrier: string; tracking_number: string; label_created_at: Date; replaced_at: Date; replaced_by: string }>(
      'SELECT carrier,tracking_number,label_created_at,replaced_at,replaced_by FROM shipment268_replaced_labels WHERE order_id=$1 ORDER BY replaced_at,id',
      [orderId],
    )
  ).rows;
}
