import type { FastifyInstance, FastifyRequest } from 'fastify';
import { tenantTx } from './db';
import { ensure } from './errors';
import type { Actor } from './domain';
import { paymentImportAdmin } from './payment-imports';
import { parseSettlementQuery, serializeSettlement, settlementCsv, type SettlementQuery } from './settlement-report';
import { settlementReport, type SettlementReport } from './settlement-report-data';

export type SettlementReportDeps = {
  /** Throws 403 unless the actor is the current finance administrator. */
  authorize: (a: Actor) => Promise<void>;
  load: (tenantId: string, q: SettlementQuery) => Promise<SettlementReport>;
};
/** Same permission as payment imports (Przelewy i pobrania): the current admin
 * membership re-read from the database, not only the session role. */
const defaultDeps: SettlementReportDeps = {
  authorize: (a) => tenantTx(a.tenantId, (c) => paymentImportAdmin(c, a)),
  load: settlementReport,
};

/** Read-only settlement report: payments ↔ invoices ↔ corrections ↔ return credits. */
export function registerSettlementReportRoutes(
  app: FastifyInstance,
  opts: { readOnly: boolean },
  deps: SettlementReportDeps = defaultDeps,
): void {
  const run = async (req: FastifyRequest) => {
    // Developer API keys have no operation for this report; refuse explicitly as well.
    ensure(!req.apiScopes, 403, 'Raport rozliczeń jest dostępny tylko w sesji użytkownika');
    const q = parseSettlementQuery(req.query);
    await deps.authorize(req.actor);
    return deps.load(req.actor.tenantId, q);
  };
  app.get('/api/settlement-report', async (req, reply) => {
    const report = await run(req);
    reply.header('Cache-Control', 'no-store');
    return { ...(serializeSettlement(report) as object), read_only: opts.readOnly };
  });
  app.get('/api/settlement-report/file', async (req, reply) => {
    const report = await run(req);
    return reply
      .header('Cache-Control', 'no-store')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Disposition', `attachment; filename="rozliczenie-${report.from}-${report.to}.csv"`)
      .type('text/csv; charset=utf-8')
      .send(settlementCsv(report.rows, report.totals));
  });
}
