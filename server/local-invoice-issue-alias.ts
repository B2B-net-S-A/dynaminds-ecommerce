/** App-level guard of the pinned native POST /api/local-invoices/previews/:id/issue
 * (local-invoice-routes.ts and local-invoices.ts are hash-pinned and stay unchanged).
 * Registered by buildApp before the native routes, as a preHandler of that one route:
 * - an order that already has a FV-S (230) invoice, or a 157 invoice issued from another
 *   preview, is refused with a Polish 409 before anything is numbered;
 * - every other request is answered by the handler of POST …/previews/:id/tax-issue, so the
 *   226 tax snapshot is always written with the issue (and a 230 preview is issued in FV-S).
 * `/issue` is therefore an alias of `/tax-issue`; the native handler is never reached while 226
 * is installed. The locked checks of the tax-issue transaction stay the authority; this guard
 * only gives the refusal a clear reason. Without 226 the native route answers as before. */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { tenantReadTx } from './db';
import { ensure } from './errors';
import { invoice230Available } from './invoice230';
import { taxInvoiceActor } from './tax226-local-invoices';
import { taxIssueHandler } from './tax226-routes';

export const NATIVE_ISSUE_ROUTE = '/api/local-invoices/previews/:id/issue';
export const ISSUE_REFUSAL_230 = 'Zamówienie ma już fakturę FV-S (230); drugiej faktury nie wystawisz — skoryguj fakturę FV-S';
export const ISSUE_REFUSAL_157 = 'Zamówienie ma już fakturę wystawioną z innego podglądu; drugiej faktury nie wystawisz — skoryguj tę fakturę';

/** 409 when the preview's order already has an invoice that this request would duplicate. A replay of
 * the same preview (its own 157 or 230 document) passes to the handler, which answers it with 200. */
export async function assertIssueAliasAllowed(tenantId: string, previewId: string): Promise<void> {
  await tenantReadTx(tenantId, async c => {
    const has230 = await invoice230Available(c);
    const own = (await c.query(`SELECT order_id FROM local_invoice_previews WHERE id=$1
      ${has230 ? 'UNION ALL SELECT order_id FROM invoice230_previews WHERE id=$1' : ''}`, [previewId])).rows[0];
    if (!own) return; // unknown preview: the handler answers 404
    if (has230) ensure(!(await c.query('SELECT 1 FROM invoice230_documents WHERE order_id=$1 AND preview_id<>$2', [own.order_id, previewId])).rowCount, 409, ISSUE_REFUSAL_230);
    ensure(!(await c.query(`SELECT 1 FROM documents d JOIN local_invoice_receipts r ON (r.tenant_id,r.document_id)=(d.tenant_id,d.id)
      WHERE d.order_id=$1 AND d.kind='invoice' AND d.mode='local_invoice' AND r.preview_id<>$2`, [own.order_id, previewId])).rowCount, 409, ISSUE_REFUSAL_157);
  });
}

export function registerLocalInvoiceIssueAlias(app: FastifyInstance, opts: { tax226Available: boolean; readOnly: boolean; sessionName: string }): void {
  if (!opts.tax226Available) return;
  const handler = taxIssueHandler({ available: true, readOnly: opts.readOnly, sessionName: opts.sessionName });
  app.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.method !== 'POST' || req.routeOptions.url !== NATIVE_ISSUE_ROUTE) return;
    ensure(!opts.readOnly, 423, 'Kopia jest tylko do odczytu');
    const previewId = z.strictObject({ id: z.uuid().transform(v => v.toLowerCase()) }).parse(req.params).id;
    const actor = taxInvoiceActor(req as never, opts.sessionName);
    await assertIssueAliasAllowed(actor.tenantId, previewId);
    const body = await handler(req, reply);
    return reply.send(body);
  });
}
