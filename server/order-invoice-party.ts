/** The buyer of documents issued from an order (Uwagi v3 §6 follow-up): the invoice data edited on the order
 * card (latest order_events 'order.section_edited' of section 'invoice', see server/order-sections.ts), or the
 * customer of the order when nothing was entered. The rule is shared/order-invoice-party.ts. Reads only. */
import type { PoolClient } from 'pg';
import { ensure } from './errors';
import { invoicePartyOf, type InvoiceParty } from '../shared/order-invoice-party';

export type { InvoiceParty } from '../shared/order-invoice-party';

export async function orderInvoiceParty(c: PoolClient, tenantId: string, orderId: string): Promise<InvoiceParty> {
  const r = (
    await c.query(
      `SELECT o.customer_name,o.email,o.address,
        (SELECT e.detail->'values' FROM order_events e
          WHERE e.tenant_id=o.tenant_id AND e.order_id=o.id AND e.kind='order.section_edited'
            AND e.detail->>'section'='invoice' AND jsonb_typeof(e.detail->'values')='object'
          ORDER BY e.created_at DESC,e.id DESC LIMIT 1) invoice
       FROM orders o WHERE o.tenant_id=$1 AND o.id=$2`,
      [tenantId, orderId],
    )
  ).rows[0];
  ensure(r, 404, 'Nie znaleziono zamówienia');
  return invoicePartyOf(r, r.invoice);
}
