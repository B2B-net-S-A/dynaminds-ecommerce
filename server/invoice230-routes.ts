/** Session (and API-key) routes of the 230 invoices. Always registered; without 230 every call is 503,
 * in a read-only copy every write is 423. The issue is POST /api/local-invoices/previews/:id/tax-issue. */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ensure, Problem } from './errors';
import { pool, tenantReadTx } from './db';
import { taxInvoiceActor } from './tax226-local-invoices';
import { invoice230Calculate, invoice230Detail, invoice230Preview, invoice230PreviewDetail, invoice230Register } from './invoice230-service';
import { invoice230PrintHtml } from './invoice230-print';
import { invoice232Available } from './invoice232';
import { invoice232Preview } from './invoice232-service';
import { registerLocalInvoiceOverflow } from './invoice-overflow230';

const id = (p: unknown) => z.strictObject({ id: z.uuid().transform(v => v.toLowerCase()) }).parse(p).id;
const empty = z.strictObject({});
export const INVOICE230_CORRECTION_REFUSAL = 'Korekta faktury FV-S (ZW/NP/OO/OSS, B2B lub EUR) nie jest jeszcze obsługiwana. Faktury nie można skorygować w tej wersji — przygotuj korektę poza aplikacją albo poczekaj na kolejny krok.';
/** With 232 installed the FV-S invoice is corrected only as KOR-S; the consumer (188/206/207) and B2B (160) paths still refuse it. */
export const INVOICE230_KOR_S_ONLY = 'Korekta faktury FV-S (ZW/NP/OO/OSS, B2B lub EUR) to korekta KOR-S — wystaw ją przyciskiem „Wystaw korektę” przy fakturze FV-S (POST /api/invoice232/invoices/:id/previews).';
export function registerInvoice230Routes(app: FastifyInstance, opts: { available: boolean; readOnly: boolean; sessionName: string }): void {
  const root = '/api/invoice230';
  const actor = (req: FastifyRequest, write: boolean) => {
    ensure(opts.available, 503, 'Faktury szczególne (migracja 230) są niedostępne w tej kopii');
    ensure(!write || !opts.readOnly, 423, 'Kopia jest tylko do odczytu');
    return taxInvoiceActor(req as never, opts.sessionName);
  };
  const project = (v: any) => ({ ...v, read_only: opts.readOnly, ...(typeof v.can_write === 'boolean' ? { can_write: !opts.readOnly && v.can_write } : {}) });
  // Invoices beyond the 157 lifetime budget: the native preview route routes them to FV-S (invoice-overflow230.ts).
  if (opts.available) registerLocalInvoiceOverflow(app, { readOnly: opts.readOnly, sessionName: opts.sessionName });
  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0].replace(/^\/api\/v1\//, '/api/');
    if (path === root || path.startsWith(root + '/')) reply.header('Cache-Control', 'no-store');
  });
  // Corrections of 230 invoices are not implemented: the 188/206/207 (consumer) and 160 (B2B) correction
  // paths read only FV157/FV159 and would answer 404; they get an explicit Polish 409 instead.
  const CORRECTION = /^\/api\/(local-consumer-credits|consumer-return-credits|b2b-corrections)\/(orders\/([0-9a-f-]{36})\/source|documents\/([0-9a-f-]{36})\/source|previews)$/i;
  app.addHook('preHandler', async req => {
    if (!opts.available) return;
    const path = req.url.split('?')[0].replace(/^\/api\/v1\//, '/api/'), m = CORRECTION.exec(path);
    const tenant = (req as any).actor?.tenantId as string | undefined;
    if (!m || !tenant) return;
    const order = m[3]?.toLowerCase() ?? null, doc = (m[4] ?? (req.method === 'POST' ? (req.body as any)?.original_document_id : null))?.toString().toLowerCase() ?? null;
    if (!order && !(doc && z.uuid().safeParse(doc).success)) return;
    const hit = await tenantReadTx(tenant, async c => (await c.query('SELECT 1 FROM invoice230_documents WHERE order_id=$1::uuid OR document_id=$2::uuid', [order, doc])).rowCount);
    if (hit) throw new Problem(409, (await invoice232Available(pool)) ? INVOICE230_KOR_S_ONLY : INVOICE230_CORRECTION_REFUSAL);
  });
  // Alias of the KOR-S preview (232); without 232 the correction is refused as before.
  app.post(root + '/documents/:id/corrections', async (req, reply) => {
    const a = actor(req, true), doc = id(req.params);
    if (!(await invoice232Available(pool))) throw new Problem(409, INVOICE230_CORRECTION_REFUSAL);
    const v = await invoice232Preview(a, doc, req.body);
    reply.code(v.reused ? 200 : 201);
    return project(v);
  });
  app.post(root + '/orders/:id/calculate', async req => { empty.parse(req.query); return project(await invoice230Calculate(actor(req, false), id(req.params), req.body)); });
  app.post(root + '/orders/:id/previews', async (req, reply) => {
    empty.parse(req.query);
    const v = await invoice230Preview(actor(req, true), id(req.params), req.body);
    reply.code(v.reused ? 200 : 201);
    return project(v);
  });
  app.get(root + '/previews/:id', async req => { empty.parse(req.query); return project(await invoice230PreviewDetail(actor(req, false), id(req.params))); });
  app.get(root + '/documents', async req => {
    const q = z.strictObject({ order_id: z.uuid().transform(v => v.toLowerCase()).optional() }).parse(req.query);
    return project(await invoice230Register(actor(req, false), q.order_id ?? null));
  });
  app.get(root + '/documents/:id', async req => { empty.parse(req.query); return project(await invoice230Detail(actor(req, false), id(req.params))); });
  app.get(root + '/documents/:id/print', async (req, reply) => {
    empty.parse(req.query);
    const v = await invoice230Detail(actor(req, false), id(req.params));
    return reply.type('text/html; charset=utf-8').header('Cache-Control', 'no-store').send(invoice230PrintHtml(v.document, v.receipt));
  });
}
