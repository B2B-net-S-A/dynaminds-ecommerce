/** Request-level 230 operations: each runs in the identity frame of the native FV (session or API
 * key, role, MFA; writes need admin/operator and documents:write) in one tenant transaction.
 * The issue itself goes through POST /api/local-invoices/previews/:id/tax-issue. */
import { receiptOfInvoiceInTx } from './receipt233';
import type { LocalInvoiceActor } from './local-invoice-values';
import { ensure } from './errors';
import { taxInvoiceFlags, taxInvoiceTransaction } from './tax226-local-invoices';
import {
  invoice230CalculateInput, invoice230DocumentInTx, invoice230PreviewInput, invoice230RegisterInTx, invoice230SnapshotInTx, requireInvoice230, storeInvoice230PreviewInTx,
} from './invoice230';

export async function invoice230Calculate(a: LocalInvoiceActor, orderId: string, input: unknown) {
  const b = invoice230CalculateInput.parse(input);
  return taxInvoiceTransaction(a, false, async c => {
    const calc = await invoice230SnapshotInTx(c, orderId, b, false);
    return { ...(await taxInvoiceFlags(c, a, false)), ...calc, issuable: calc.blockers.length === 0 };
  });
}
export async function invoice230Preview(a: LocalInvoiceActor, orderId: string, input: unknown) {
  const b = invoice230PreviewInput.parse(input);
  return taxInvoiceTransaction(a, true, async c => {
    const r = await storeInvoice230PreviewInTx(c, a, orderId, b);
    await c.query('SET CONSTRAINTS ALL IMMEDIATE');
    return { ...(await taxInvoiceFlags(c, a, true)), ...r, issue_path: `/local-invoices/previews/${r.preview.id}/tax-issue` };
  });
}
export async function invoice230PreviewDetail(a: LocalInvoiceActor, id: string) {
  return taxInvoiceTransaction(a, false, async c => {
    await requireInvoice230(c);
    const p = (await c.query('SELECT id,order_id,series_id,order_version::text,scope_hash,snapshot,expires_at,created_at FROM invoice230_previews WHERE id=$1', [id])).rows[0];
    ensure(p, 404, 'Nie znaleziono podglądu faktury');
    return { ...(await taxInvoiceFlags(c, a, false)), preview: p };
  });
}
export async function invoice230Detail(a: LocalInvoiceActor, id: string) {
  return taxInvoiceTransaction(a, false, async c => ({ ...(await taxInvoiceFlags(c, a, false)), ...(await invoice230DocumentInTx(c, id)), receipt: await receiptOfInvoiceInTx(c, id) }));
}
export async function invoice230Register(a: LocalInvoiceActor, orderId: string | null) {
  return taxInvoiceTransaction(a, false, async c => ({ ...(await taxInvoiceFlags(c, a, false)), data: await invoice230RegisterInTx(c, orderId) }));
}
