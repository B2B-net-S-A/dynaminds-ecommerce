import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ensure } from './errors';
import {
  customerReport,
  employeeReport,
  productStatsCsv,
  productStatsReport,
  salesReportPeriods,
  salesReportPeriodsCsv,
} from './reports-analytics';
import { backfillSalesDimensions, salesGroupReport } from './reports-groups';

/** Analytics reports (S7). Session users only: developer API keys have no operation for
 * these reports and are refused explicitly. Roles are re-read from memberships inside
 * every loader; the session role is not trusted. */
export function registerReportAnalyticsRoutes(app: FastifyInstance, opts: { readOnly: boolean }): void {
  const actor = (r: FastifyRequest) => {
    ensure(!r.apiScopes, 403, 'Raporty analityczne są dostępne tylko w sesji użytkownika');
    return r.actor;
  };
  const json = (path: string, fn: (r: FastifyRequest) => Promise<object>) =>
    app.get(path, async (r, reply) => {
      reply.header('Cache-Control', 'no-store');
      return { ...(await fn(r)), read_only: opts.readOnly };
    });
  const file = (path: string, fn: (r: FastifyRequest) => Promise<{ csv: string; filename: string }>) =>
    app.get(path, async (r, reply: FastifyReply) => {
      const out = await fn(r);
      return reply
        .header('Cache-Control', 'no-store')
        .header('X-Content-Type-Options', 'nosniff')
        .header('Content-Disposition', `attachment; filename="${out.filename}"`)
        .type('text/csv; charset=utf-8')
        .send(out.csv);
    });
  json('/api/reports/sales/periods', (r) => salesReportPeriods(actor(r), r.query));
  file('/api/reports/sales/periods/file', (r) => salesReportPeriodsCsv(actor(r), r.query));
  json('/api/reports/products', (r) => productStatsReport(actor(r), r.query));
  file('/api/reports/products/file', (r) => productStatsCsv(actor(r), r.query));
  json('/api/reports/customers', (r) => customerReport(actor(r), r.query));
  json('/api/reports/employees', (r) => employeeReport(actor(r), r.query));
  // ANALYTICS-002 (migration 247): grouping by source, delivery or payment with a comparison period.
  json('/api/reports/sales/groups', (r) => salesGroupReport(actor(r), r.query));
  app.post('/api/reports/sales/dimensions/backfill', async (r, reply) => {
    reply.header('Cache-Control', 'no-store');
    return backfillSalesDimensions(actor(r), opts.readOnly, r.body);
  });
}
