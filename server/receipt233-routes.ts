/** Session (and API-key) routes of fiscal receipts (233). Always registered; without 233 every call is
 * 503, in a read-only copy every write is 423. */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ensure } from './errors';
import { taxInvoiceActor } from './tax226-local-invoices';
import {
  receipt233DailyReport, receipt233DailyReports, receipt233Detail, receipt233OrderState, receipt233Print, receipt233Printer, receipt233Register, receipt233Retry,
  receipt233SavePrinter, receipt233TestPrinter,
} from './receipt233-service';

const id = (p: unknown) => z.strictObject({ id: z.uuid().transform(v => v.toLowerCase()) }).parse(p).id;
const empty = z.strictObject({});
export function registerReceipt233Routes(app: FastifyInstance, opts: { available: boolean; readOnly: boolean; sessionName: string }): void {
  const root = '/api/receipt233';
  const actor = (req: FastifyRequest, write: boolean) => {
    ensure(opts.available, 503, 'Paragony fiskalne (migracja 233) są niedostępne w tej kopii');
    ensure(!write || !opts.readOnly, 423, 'Kopia jest tylko do odczytu');
    return taxInvoiceActor(req as never, opts.sessionName);
  };
  const project = (v: any) => ({ ...v, read_only: opts.readOnly, ...(typeof v.can_write === 'boolean' ? { can_write: !opts.readOnly && v.can_write } : {}),
    ...(typeof v.can_configure === 'boolean' ? { can_configure: !opts.readOnly && v.can_configure } : {}) });
  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0].replace(/^\/api\/v1\//, '/api/');
    if (path === root || path.startsWith(root + '/')) reply.header('Cache-Control', 'no-store');
  });
  app.get(root + '/orders/:id', async req => project(await receipt233OrderState(actor(req, false), id(req.params), req.query as never)));
  app.post(root + '/orders/:id/receipts', async (req, reply) => {
    empty.parse(req.query);
    const v = await receipt233Print(actor(req, true), id(req.params), req.body);
    reply.code(v.reused ? 200 : 201);
    return project(v);
  });
  app.get(root + '/receipts', async req => {
    const q = z.strictObject({ order_id: z.uuid().transform(v => v.toLowerCase()).optional(), fiscal_date: z.iso.date().optional() }).parse(req.query);
    return project(await receipt233Register(actor(req, false), q));
  });
  app.get(root + '/receipts/:id', async req => { empty.parse(req.query); return project(await receipt233Detail(actor(req, false), id(req.params))); });
  app.post(root + '/receipts/:id/retry', async req => { empty.parse(req.query); return project(await receipt233Retry(actor(req, true), id(req.params), req.body)); });
  app.get(root + '/printer', async req => { empty.parse(req.query); return project(await receipt233Printer(actor(req, false))); });
  app.put(root + '/printer', async req => { empty.parse(req.query); return project(await receipt233SavePrinter(actor(req, true), req.body)); });
  // A draft configuration is tested only by the admin (write frame); the stored one by any reading role.
  app.post(root + '/printer/test', async req => {
    empty.parse(req.query);
    const body = req.body ?? {}, draft = typeof body === 'object' && body !== null && Object.keys(body).length > 0;
    return project(await receipt233TestPrinter(actor(req, draft), body));
  });
  app.get(root + '/daily-reports', async req => { empty.parse(req.query); return project(await receipt233DailyReports(actor(req, false))); });
  app.post(root + '/daily-reports', async (req, reply) => {
    empty.parse(req.query);
    const v = await receipt233DailyReport(actor(req, true), req.body);
    reply.code(v.reused ? 200 : 201);
    return project(v);
  });
}
