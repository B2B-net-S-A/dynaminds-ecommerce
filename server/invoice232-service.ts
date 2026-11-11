/** Request-level KOR-S operations: each runs in the identity frame of the native FV (session or API
 * key, role, MFA; writes need admin/operator and documents:write) in one tenant transaction. */
import type { LocalInvoiceActor } from './local-invoice-values';
import { taxInvoiceFlags, taxInvoiceTransaction } from './tax226-local-invoices';
import { correctionRequest } from './invoice232-model';
import {
  invoice232DocumentInTx, invoice232RegisterInTx, invoice232SnapshotInTx, invoice232StateInTx, issueInvoice232InTx, requireInvoice232, storeInvoice232PreviewInTx,
} from './invoice232';
import { ensure } from './errors';

export async function invoice232State(a: LocalInvoiceActor, originalId: string) {
  return taxInvoiceTransaction(a, false, async c => ({ ...(await taxInvoiceFlags(c, a, false)), ...(await invoice232StateInTx(c, originalId)) }));
}
export async function invoice232Calculate(a: LocalInvoiceActor, originalId: string, input: unknown) {
  const b = correctionRequest.parse(input);
  return taxInvoiceTransaction(a, false, async c => {
    const calc = await invoice232SnapshotInTx(c, originalId, b);
    return { ...(await taxInvoiceFlags(c, a, false)), ...calc, issuable: calc.blockers.length === 0 };
  });
}
export async function invoice232Preview(a: LocalInvoiceActor, originalId: string, input: unknown) {
  return taxInvoiceTransaction(a, true, async c => {
    const r = await storeInvoice232PreviewInTx(c, a, originalId, input);
    await c.query('SET CONSTRAINTS ALL IMMEDIATE');
    return { ...(await taxInvoiceFlags(c, a, true)), ...r, issue_path: `/invoice232/previews/${r.preview.id}/issue` };
  });
}
export async function invoice232Issue(a: LocalInvoiceActor, previewId: string, input: unknown) {
  return taxInvoiceTransaction(a, true, async c => {
    const r = await issueInvoice232InTx(c, a, previewId, input);
    return { ...(await taxInvoiceFlags(c, a, true)), ...(await invoice232DocumentInTx(c, r.id)), reused: r.reused };
  });
}
export async function invoice232PreviewDetail(a: LocalInvoiceActor, id: string) {
  return taxInvoiceTransaction(a, false, async c => {
    await requireInvoice232(c);
    const p = (await c.query(`SELECT p.id,p.original_document_id,p.order_id,p.return_id,p.scope_hash,p.snapshot,p.expires_at,p.created_at,
      (SELECT x.id FROM invoice232_corrections x WHERE x.preview_id=p.id) issued_id FROM invoice232_previews p WHERE p.id=$1`, [id])).rows[0];
    ensure(p, 404, 'Nie znaleziono podglądu korekty');
    return { ...(await taxInvoiceFlags(c, a, false)), preview: p };
  });
}
export async function invoice232Detail(a: LocalInvoiceActor, id: string) {
  return taxInvoiceTransaction(a, false, async c => ({ ...(await taxInvoiceFlags(c, a, false)), ...(await invoice232DocumentInTx(c, id)) }));
}
export async function invoice232Register(a: LocalInvoiceActor, filter: { order_id?: string; original_document_id?: string }) {
  return taxInvoiceTransaction(a, false, async c => ({ ...(await taxInvoiceFlags(c, a, false)), data: await invoice232RegisterInTx(c, filter) }));
}
