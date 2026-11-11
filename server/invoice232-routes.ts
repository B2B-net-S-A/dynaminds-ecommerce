/** Session (and API-key) routes of the KOR-S corrections (232). Always registered; without 232 every
 * call is 503, in a read-only copy every write is 423. */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ensure } from './errors';
import { taxInvoiceActor } from './tax226-local-invoices';
import {
  invoice232Calculate, invoice232Detail, invoice232Issue, invoice232Preview, invoice232PreviewDetail, invoice232Register, invoice232State,
} from './invoice232-service';
import { invoice232PrintHtml } from './invoice232-print';

const id = (p: unknown) => z.strictObject({ id: z.uuid().transform(v => v.toLowerCase()) }).parse(p).id;
const empty = z.strictObject({});
export function registerInvoice232Routes(app: FastifyInstance, opts: { available: boolean; readOnly: boolean; sessionName: string }): void {
  const root = '/api/invoice232';
  const actor = (req: FastifyRequest, write: boolean) => {
    ensure(opts.available, 503, 'Korekty faktur FV-S (migracja 232) są niedostępne w tej kopii');
    ensure(!write || !opts.readOnly, 423, 'Kopia jest tylko do odczytu');
    return taxInvoiceActor(req as never, opts.sessionName);
  };
  const project = (v: any) => ({ ...v, read_only: opts.readOnly, ...(typeof v.can_write === 'boolean' ? { can_write: !opts.readOnly && v.can_write } : {}) });
  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0].replace(/^\/api\/v1\//, '/api/');
    if (path === root || path.startsWith(root + '/')) reply.header('Cache-Control', 'no-store');
  });
  /** The corrected FV-S invoice: its lines in the current state, its corrections and the order's returns. */
  app.get(root + '/invoices/:id', async req => { empty.parse(req.query); return project(await invoice232State(actor(req, false), id(req.params))); });
  app.post(root + '/invoices/:id/calculate', async req => { empty.parse(req.query); return project(await invoice232Calculate(actor(req, false), id(req.params), req.body)); });
  app.post(root + '/invoices/:id/previews', async (req, reply) => {
    empty.parse(req.query);
    const v = await invoice232Preview(actor(req, true), id(req.params), req.body);
    reply.code(v.reused ? 200 : 201);
    return project(v);
  });
  app.get(root + '/previews/:id', async req => { empty.parse(req.query); return project(await invoice232PreviewDetail(actor(req, false), id(req.params))); });
  app.post(root + '/previews/:id/issue', async (req, reply) => {
    empty.parse(req.query);
    const v = await invoice232Issue(actor(req, true), id(req.params), req.body);
    reply.code(v.reused ? 200 : 201);
    return project(v);
  });
  app.get(root + '/corrections', async req => {
    const q = z.strictObject({ order_id: z.uuid().transform(v => v.toLowerCase()).optional(), original_document_id: z.uuid().transform(v => v.toLowerCase()).optional() }).parse(req.query);
    return project(await invoice232Register(actor(req, false), q));
  });
  app.get(root + '/corrections/:id', async req => { empty.parse(req.query); return project(await invoice232Detail(actor(req, false), id(req.params))); });
  app.get(root + '/corrections/:id/print', async (req, reply) => {
    empty.parse(req.query);
    const v = await invoice232Detail(actor(req, false), id(req.params));
    return reply.type('text/html; charset=utf-8').header('Cache-Control', 'no-store').send(invoice232PrintHtml(v.document));
  });
}
