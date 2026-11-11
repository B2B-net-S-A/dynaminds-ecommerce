import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from './db';
import { ensure } from './errors';
import * as P from './print-jobs';
import * as V from './print-job-values';
import { originalRecoveryParams, printRecoveryQuery } from './original-key-recovery';

export function registerPrintJobRoutes(app: FastifyInstance, opts: { available: boolean; readOnly: boolean }) {
  const root = '/api/print-jobs';
  const actor = (req: any): V.PrintActor => ({ ...req.actor, apiKeyId: req.actor.apiKeyId ?? req.apiKeyId });
  const id = (req: any) => z.strictObject({ id: V.printUuid }).parse(req.params).id;
  const emptyQuery = (req: any) => z.strictObject({}).parse(req.query);
  const flags = (value: any) => ({ ...value, read_only: opts.readOnly,
    ...(typeof value.can_write === 'boolean' ? { can_write: !opts.readOnly && value.can_write } : {}),
    ...(typeof value.can_manage === 'boolean' ? { can_manage: !opts.readOnly && value.can_manage } : {}),
    ...(opts.readOnly && value.job ? { job: { ...value.job, can_claim: false, can_reconcile: false } } : {}),
    ...(opts.readOnly && Array.isArray(value.jobs) ? { jobs: value.jobs.map((job: any) => ({ ...job, can_claim: false, can_reconcile: false })) } : {}),
  });
  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0].replace(/^\/api\/v1\//, '/api/');
    if (!path.startsWith(root + '/')) return;
    reply.header('Cache-Control', 'no-store');
    const content = req.method === 'GET' && /\/jobs\/[^/]+\/content$/.test(path);
    if (content) ensure(!opts.readOnly, 423, 'Kopia jest tylko do odczytu');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      ensure(!opts.readOnly, 423, 'Kopia jest tylko do odczytu');
      ensure(opts.available && await P.printJobsAvailable(pool), 503, 'Kopia nie zawiera kolejki wydruków');
    }
    if (req.apiScopes) ensure(req.apiScopes.includes('orders:read') &&
      (['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !content || req.apiScopes.includes('orders:write')),
      403, 'Klucz API nie ma zakresów kolejki wydruków');
  });
  app.get(root + '/options', async (req) => {
    emptyQuery(req);
    if (!opts.available) {
      await P.printJobsAvailable(pool);
      return { available: false, read_only: opts.readOnly, can_read: false,
        can_write: false, can_manage: false, current_role: null, stations: [], limits: V.PRINT_JOB_LIMITS };
    }
    return flags(await P.printJobMetadata(actor(req)));
  });
  app.get(root + '/original-results/:key', async req => flags(await P.recoverPrintOriginalKey(actor(req), originalRecoveryParams.parse(req.params).key, printRecoveryQuery.parse(req.query))));
  app.get(root + '/printers', async req => flags(await P.listPrintPrinters(actor(req), V.printPrinterQuery.parse(req.query))));
  app.post(root + '/printers', async (req, reply) => {
    emptyQuery(req); const r = await P.createPrintPrinter(actor(req), V.printPrinterCreateInput.parse(req.body));
    reply.code(r.reused ? 200 : 201); return flags(r);
  });
  app.patch(root + '/printers/:id', async req => {
    emptyQuery(req); return flags(await P.updatePrintPrinter(actor(req), id(req), V.printPrinterUpdateInput.parse(req.body)));
  });
  app.get(root + '/jobs', async req => flags(await P.listPrintJobs(actor(req), V.printJobQuery.parse(req.query))));
  app.post(root + '/jobs', { bodyLimit: 3 * 1024 * 1024 }, async (req, reply) => {
    emptyQuery(req); const r = await P.createPrintJob(actor(req), V.printJobCreateInput.parse(req.body));
    reply.code(r.reused ? 200 : 201); return flags(r);
  });
  app.get(root + '/jobs/:id', async req => { emptyQuery(req); return flags(await P.printJobDetail(actor(req), id(req))); });
  app.post(root + '/jobs/:id/claim', async req => {
    emptyQuery(req); return flags(await P.claimPrintJob(actor(req), id(req), V.printJobClaimInput.parse(req.body)));
  });
  app.get(root + '/jobs/:id/content', async req => {
    emptyQuery(req); const lease = V.printUuid.parse(req.headers['x-print-lease']);
    return flags(await P.printJobContent(actor(req), id(req), lease));
  });
  app.post(root + '/jobs/:id/ack', async req => {
    emptyQuery(req); return flags(await P.ackPrintJob(actor(req), id(req), V.printJobAckInput.parse(req.body)));
  });
  app.post(root + '/jobs/:id/reconcile', async req => {
    emptyQuery(req); return flags(await P.reconcilePrintJob(actor(req), id(req), V.printJobReconcileInput.parse(req.body)));
  });
}
