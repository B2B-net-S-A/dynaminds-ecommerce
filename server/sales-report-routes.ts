import {trackOrdinaryResponseCleanup} from './ordinary-request-lifetime';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ensure } from './errors';
import {
  salesReportOptions,
  salesReportSummary,
  salesReportOrders,
  salesReportOrderDetail,
  salesReportReturns,
  openSalesReportFile,
} from './sales-reports';
import { registerReportAnalyticsRoutes } from './reports-routes';
export function registerSalesReportRoutes(app: FastifyInstance, opts: { readOnly: boolean }) {
  const actor = (r: FastifyRequest) => {
    ensure(
      !r.apiScopes || ['orders:read', 'inventory:read'].every((s) => r.apiScopes!.includes(s)),
      403,
      'Wymagane scope orders:read i inventory:read',
    );
    const apiKeyId = r.currentUser?.api_key_id;
    ensure(!r.apiScopes || typeof apiKeyId === 'string', 401, 'Brak kontekstu klucza API');
    return { ...r.actor, ...(r.apiScopes ? { apiKeyId } : {}) };
  };
  registerReportAnalyticsRoutes(app, opts);
  const root = '/api/reports/sales';
  const add = (path: string, fn: (r: FastifyRequest) => Promise<unknown>) =>
    app.get(root + path, async (r, reply) => {
      reply.header('Cache-Control', 'no-store');
      return { ...((await fn(r)) as object), read_only: opts.readOnly };
    });
  add('/options', (r) => {
    z.strictObject({}).parse(r.query);
    return salesReportOptions(actor(r));
  });
  add('/summary', (r) => salesReportSummary(actor(r), r.query));
  add('/orders', (r) => salesReportOrders(actor(r), r.query));
  add('/orders/:id', (r) =>
    salesReportOrderDetail(actor(r), z.strictObject({ id: z.uuid() }).parse(r.params).id, r.query),
  );
  add('/returns', (r) => salesReportReturns(actor(r), r.query));
  const files = new WeakMap<FastifyRequest, Awaited<ReturnType<typeof openSalesReportFile>>>();
  app.addHook('onResponse', async (r) => {
    const file = files.get(r);
    if (file) {
      files.delete(r);
      await trackOrdinaryResponseCleanup(app,r,file.dispose);
    }
  });
  app.get(root + '/file', async (r, reply) => {
    const controller = new AbortController(),
      abort = () => controller.abort();
    r.raw.once('aborted', abort);
    reply.raw.once('close', () => {
      if (!reply.raw.writableFinished) abort();
    });
    try {
      const file = await openSalesReportFile(actor(r), r.query, controller.signal);
      files.set(r, file);
      const dispose = () => {
        void trackOrdinaryResponseCleanup(app,r,file.dispose).catch(() => {});
      };
      reply.raw.once('finish', dispose);
      reply.raw.once('close', () => {
        if (!reply.raw.writableFinished) file.abort();
        dispose();
      });
      return reply
        .header('Cache-Control', 'no-store')
        .header('X-Content-Type-Options', 'nosniff')
        .header('Content-Disposition', 'attachment; filename="sales-report.csv"')
        .header('Content-Length', file.bytes)
        .header('X-Sales-Report-Count', file.count)
        .type('text/csv; charset=utf-8')
        .send(file.stream);
    } finally {
      r.raw.off('aborted', abort);
    }
  });
}
