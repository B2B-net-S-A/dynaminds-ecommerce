/**
 * Fulfilment stage and payment state shown to people (Uwagi v3 §1 and §7).
 *
 * Both are derived, not stored: a new value in orders.status or a new column on orders changes the
 * sealed fingerprints (docs/order-status-codes.md), so "Gotowe do nadania" is a packed order whose
 * label is bought and not yet handed to the carrier, and the payment state comes from the ledger.
 */
export const READY_TO_SHIP = 'ready_to_ship';

/** Shipment status of a cancelled label (shipment rows are permanent, so a cancelled label keeps its row). */
export const CANCELLED_SHIPMENT = 'canceled';

/** SQL boolean: the order (alias `o`) is packed and has a label that has not been dispatched nor cancelled. */
export const orderReadyToShipSql = (o: string) =>
  `(${o}.status='packed' AND (EXISTS(SELECT 1 FROM shipping_plans rts_sp WHERE rts_sp.tenant_id=${o}.tenant_id AND rts_sp.order_id=${o}.id AND rts_sp.state='ready')` +
  ` OR EXISTS(SELECT 1 FROM shipments rts_sh WHERE rts_sh.tenant_id=${o}.tenant_id AND rts_sh.order_id=${o}.id AND rts_sh.dispatched_at IS NULL AND rts_sh.status<>'${CANCELLED_SHIPMENT}')))`;

/** SQL text: orders.status, except a packed order with an undispatched label reads 'ready_to_ship'. */
export const orderFulfilmentStageSql = (o: string) =>
  `(CASE WHEN ${orderReadyToShipSql(o)} THEN '${READY_TO_SHIP}' ELSE ${o}.status END)`;

export type PaymentState = 'unpaid' | 'paid' | 'partial' | 'overpaid' | 'cod';

/**
 * net: ledger net received; nominal: amount the customer owes (0 for a cancelled order).
 * A cash-on-delivery order that is not yet settled reads 'cod' rather than 'unpaid'.
 */
export function paymentState(input: { payment_mode?: string | null; net: number; nominal: number }): PaymentState {
  const { net, nominal } = input;
  if (net > nominal) return 'overpaid';
  if (net >= nominal) return 'paid';
  if (input.payment_mode === 'cod') return 'cod';
  return net > 0 ? 'partial' : 'unpaid';
}
