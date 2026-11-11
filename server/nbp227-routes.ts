/** Session (and API-key) routes of the 227 NBP rates: the stored table A rates (Dokumenty →
 * Kursy NBP), a read from NBP cached into them, a manual rate, the rate a tax point would
 * use, and the rate record of an issued local invoice. Always registered; without 227
 * every call is 503. NBP is read outside any database transaction. */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { tenantReadTx, tenantTx } from './db';
import { Problem, ensure } from './errors';
import type { NbpRatesPort } from './nbp-routes';
import { nbp227FetchProblem } from './nbp227-fetch';
import { NBP227_CURRENCIES, midScaled, nbpFetchInput, nbpManualInput, nbpRateForQuery, nbpRateLine, toPlnMinor, warsawDay } from './nbp227-model';
import { listRatesInTx, lookbackWindow, rateForTaxPointInTx, saveManualRateInTx, storeFetchedRangeInTx } from './nbp227';
import { productLogisticsRequestActor } from './product-logistics';
import { localInvoiceDocumentNbp, taxInvoiceActor } from './tax226-local-invoices';

const id = (p: unknown) => z.strictObject({ id: z.uuid().transform(v => v.toLowerCase()) }).parse(p).id;
const empty = z.strictObject({});
const listQuery = z.strictObject({ currency: z.enum(NBP227_CURRENCIES, 'Obsługiwana waluta: EUR') });
export type Nbp227RouteOptions = { available: boolean; readOnly: boolean; sessionName: string; port?: NbpRatesPort; now?: () => Date };

export function registerNbp227Routes(app: FastifyInstance, opts: Nbp227RouteOptions) {
  const today = () => warsawDay((opts.now ?? (() => new Date()))());
  const actor = (req: FastifyRequest, scope: string, write: boolean, roles: readonly string[] = ['admin', 'operator', 'viewer']) => {
    ensure(opts.available, 503, 'Kursy NBP (migracja 227) są niedostępne w tej kopii');
    ensure(!write || !opts.readOnly, 423, 'Ta kopia jest tylko do odczytu');
    ensure(!req.apiScopes || req.apiScopes.includes(scope), 403, 'Wymagane scope: ' + scope);
    ensure(roles.includes(req.actor.role), 403, roles.includes('operator') ? 'Brak uprawnień do kursów NBP' : 'Kurs ręczny wpisuje administrator');
    return productLogisticsRequestActor(req);
  };
  const reader = () => { const r = opts.readOnly ? undefined : opts.port?.readTableA; ensure(r, 503, 'Odczyt tabel NBP nie został włączony w tym środowisku. Wpisz kurs ręcznie.'); return r; };

  app.get('/api/nbp227/rates', async req => {
    const q = listQuery.parse(req.query), a = actor(req, 'documents:read', false);
    return { currency: q.currency, read_only: opts.readOnly, can_fetch: !opts.readOnly && Boolean(opts.port?.readTableA) && a.role !== 'viewer',
      can_manual: !opts.readOnly && a.role === 'admin', today: today(), rates: await tenantReadTx(a.tenantId, c => listRatesInTx(c, q.currency)) };
  });
  // Body {currency,start,end} or {currency,tax_point} (the days before that tax point).
  app.post('/api/nbp227/rates/fetch', async (req, reply) => {
    empty.parse(req.query);
    const a = actor(req, 'documents:write', true, ['admin', 'operator']), raw = req.body as Record<string, unknown> | null;
    const b = raw && typeof raw === 'object' && 'tax_point' in raw ? (() => { const v = nbpRateForQuery.parse(raw); return { currency: v.currency, ...lookbackWindow(v.tax_point) }; })() : nbpFetchInput.parse(raw);
    const now = today();
    ensure(b.end <= now, 422, 'Nie można pobrać tabel NBP z przyszłości');
    const read = reader(), controller = new AbortController(), abort = () => controller.abort();
    req.raw.once('aborted', abort);
    let pubs;
    try { pubs = await read(b.currency, b.start, b.end, controller.signal); }
    catch (e) { const p = nbp227FetchProblem(e); throw new Problem(p.status, p.message); }
    finally { req.raw.off('aborted', abort); reply.header('Cache-Control', 'no-store'); }
    const rates = await tenantTx(a.tenantId, c => storeFetchedRangeInTx(c, a, b.currency, b.start, b.end, pubs, now));
    return { currency: b.currency, start: b.start, end: b.end, publications: pubs.length, rates };
  });
  app.put('/api/nbp227/rates/manual', async req => {
    empty.parse(req.query);
    const a = actor(req, 'documents:write', true, ['admin']), b = nbpManualInput.parse(req.body);
    return { rate: await tenantTx(a.tenantId, c => saveManualRateInTx(c, a, b, today())) };
  });
  app.get('/api/nbp227/rate-for', async req => {
    const q = nbpRateForQuery.parse(req.query), a = actor(req, 'documents:read', false);
    const choice = await tenantReadTx(a.tenantId, c => rateForTaxPointInTx(c, q.currency, q.tax_point));
    if (!('rate' in choice)) return { currency: q.currency, tax_point: q.tax_point, rate: null, refusal: choice.refusal, vat_pln_minor: null, line: null };
    const vatPln = q.vat_minor === undefined ? null : toPlnMinor(BigInt(q.vat_minor), midScaled(choice.rate.mid)).toString();
    return { currency: q.currency, tax_point: q.tax_point, rate: choice.rate, refusal: null, vat_pln_minor: vatPln,
      line: vatPln === null ? null : nbpRateLine({ currency: q.currency, rate_date: choice.rate.effective_date, table_no: choice.rate.table_no, mid: choice.rate.mid, vat_pln_minor: vatPln }) };
  });
  // Under /api/local-invoices: the native onRequest hook adds no-store, 423 and the module check.
  app.get('/api/local-invoices/documents/:id/nbp', async req => {
    empty.parse(req.query);
    ensure(opts.available, 503, 'Kursy NBP (migracja 227) są niedostępne w tej kopii');
    const v = await localInvoiceDocumentNbp(taxInvoiceActor(req as any, opts.sessionName), id(req.params));
    return { ...v, read_only: opts.readOnly, can_write: !opts.readOnly && v.can_write, can_create_series: !opts.readOnly && v.can_create_series };
  });
}
