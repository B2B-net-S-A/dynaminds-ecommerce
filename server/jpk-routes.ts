/** JPK file downloads (session only, current finance administrator):
 * GET /api/jpk/v7m.xml?okres=YYYY-MM, GET /api/jpk/v7k.xml?okres=YYYY-MM, GET /api/jpk/fa.xml?od=…&do=….
 * Read-only: the XML is built on request and nothing is stored or sent (no e-Deklaracje gateway).
 * Every file is checked against the official MF schema before it is handed out: a file that does not
 * conform is refused (422, Polish message with the first schema error); header X-Walidacja-XSD says
 * `zgodny` or `pominieta` (source/dev tree without schemas/mf or the engine; a release refuses to start). */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { tenantTx } from './db';
import { Problem, ensure } from './errors';
import type { Actor } from './domain';
import { paymentImportAdmin } from './payment-imports';
import type { Fa3Request } from './fa3-documents';
import { JpkError, jpkAddressQuery, jpkTaxpayerQuery, resolveTaxpayer } from './jpk-model';
import { loadJpkDocuments, type JpkLoaded } from './jpk-source';
import { JPK_V7_FIRST_PERIOD, renderJpkV7, type JpkV7Variant } from './jpk-v7';
import { renderJpkFa } from './jpk-fa';
import { ensureJpkConforms, type JpkSchema } from './jpk-xsd';
import type { XsdResult } from './mf-xsd';

export type JpkRouteDeps = {
  /** Throws 403 unless the actor is the current finance administrator. */
  authorize: (a: Actor) => Promise<void>;
  load: (req: Fa3Request, from: string, to: string, by: 'tax' | 'issue') => Promise<JpkLoaded>;
  now: () => Date;
  /** Official-schema check of the file (tests); defaults to the vendored MF schemas. */
  xsd?: (schema: JpkSchema, xml: string) => Promise<XsdResult>;
};
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data w formacie RRRR-MM-DD')
  .refine(v => !Number.isNaN(Date.parse(v + 'T12:00:00Z')) && new Date(v + 'T12:00:00Z').toISOString().slice(0, 10) === v, 'Nie ma takiej daty');
const v7Query = jpkTaxpayerQuery.extend({
  okres: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Okres w formacie RRRR-MM'),
  nadwyzka: z.preprocess(v => (v === '' ? undefined : v), z.string().regex(/^[0-9]{1,13}$/, 'Nadwyżka w pełnych złotych').optional()),
});
const faQuery = jpkTaxpayerQuery.extend({ od: day, do: day }).extend(jpkAddressQuery.shape);
/** Polish 400 with the parameter name; never the raw validator text. */
function parse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const r = schema.safeParse(value ?? {});
  if (r.success) return r.data;
  const i = r.error.issues[0]!;
  if (i.code === 'unrecognized_keys') throw new Problem(400, 'Nieznany parametr: ' + (i as { keys: string[] }).keys.join(', '));
  const name = i.path.join('.') || 'zapytanie';
  // Own Polish messages are shown; the validator's default English texts are not.
  const own = !/^(Invalid|Too |Expected|Unrecognized|Required|Number must|String must)/.test(i.message);
  throw new Problem(400, `Niepoprawny parametr „${name}”${own ? ': ' + i.message : ''}`);
}
const lastDay = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();
const pad = (n: number) => String(n).padStart(2, '0');
const DAYS_366 = 366 * 86400000;

const defaultDeps = (sessionName: string): JpkRouteDeps => ({
  authorize: a => tenantTx(a.tenantId, c => paymentImportAdmin(c, a)),
  load: (req, from, to, by) => loadJpkDocuments(req, sessionName, from, to, by),
  now: () => new Date(),
});

export function registerJpkRoutes(app: FastifyInstance, opts: { sessionName: string }, deps: JpkRouteDeps = defaultDeps(opts.sessionName)): void {
  const guard = async (req: FastifyRequest) => {
    ensure(!req.apiScopes, 403, 'Pliki JPK są dostępne tylko w sesji użytkownika');
    await deps.authorize(req.actor);
  };
  const send = async (reply: FastifyReply, schema: JpkSchema, xml: string, filename: string, rows: number) => {
    const checked = await ensureJpkConforms(schema, xml, deps.xsd);
    if (checked.status === 'skipped') reply.log.warn({ schema, reason: checked.reason }, 'JPK bez walidacji XSD');
    return reply.type('application/xml; charset=utf-8')
      .header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff')
      .header('Content-Disposition', `attachment; filename="${filename}"`).header('X-JPK-Wiersze', String(rows))
      .header('X-Walidacja-XSD', checked.status === 'valid' ? 'zgodny' : 'pominieta').send(xml);
  };
  const refuse = (reply: FastifyReply, e: unknown) => {
    if (!(e instanceof JpkError)) throw e;
    if (e.status === 409) return reply.code(409).header('Cache-Control', 'no-store').send({ detail: e.message, documents: e.documents });
    throw new Problem(e.status, e.message);
  };
  const v7 = (variant: JpkV7Variant) => async (req: FastifyRequest, reply: FastifyReply) => {
    // Parameters first: a malformed request is 400 for anyone; permission is checked before any data is read.
    const q = parse(v7Query, req.query);
    if (Number(q.okres.replace('-', '')) < JPK_V7_FIRST_PERIOD) throw new Problem(400, 'JPK_V7(3) obejmuje okresy od 2026-02');
    await guard(req);
    try {
      const year = Number(q.okres.slice(0, 4)), month = Number(q.okres.slice(5, 7));
      const quarterEnd = variant === 'K' && month % 3 === 0;
      const from = quarterEnd ? `${year}-${pad(month - 2)}-01` : `${q.okres}-01`, to = `${q.okres}-${pad(lastDay(year, month))}`;
      const loaded = await deps.load(req as unknown as Fa3Request, from, to, 'tax');
      const documents = loaded.documents.filter(d => d.tax_date.slice(0, 7) === q.okres);
      const r = renderJpkV7({ variant, year, month, taxpayer: resolveTaxpayer(q, loaded.documents), generated_at: deps.now().toISOString(),
        documents, quarter_documents: quarterEnd ? loaded.documents : undefined, receipt_sales: loaded.receipt_sales, surplus_zloty: BigInt(q.nadwyzka ?? '0') });
      return await send(reply, variant === 'M' ? 'JPK_V7M' : 'JPK_V7K', r.xml, r.filename, r.rows);
    } catch (e) { return refuse(reply, e); }
  };
  app.get('/api/jpk/v7m.xml', v7('M'));
  app.get('/api/jpk/v7k.xml', v7('K'));
  app.get('/api/jpk/fa.xml', async (req, reply) => {
    const q = parse(faQuery, req.query);
    if (q.od > q.do) throw new Problem(400, 'Data „od” jest późniejsza niż „do”');
    if (Date.parse(q.do) - Date.parse(q.od) >= DAYS_366) throw new Problem(400, 'Zakres JPK_FA może obejmować najwyżej 366 dni');
    await guard(req);
    try {
      const loaded = await deps.load(req as unknown as Fa3Request, q.od, q.do, 'issue');
      const { od, do: to, wojewodztwo, powiat, gmina, ulica, nr_domu, nr_lokalu, miejscowosc, kod_pocztowy } = q;
      const r = renderJpkFa({ from: od, to, taxpayer: resolveTaxpayer(q, loaded.documents), generated_at: deps.now().toISOString(),
        address: { wojewodztwo, powiat, gmina, ulica, nr_domu, nr_lokalu, miejscowosc, kod_pocztowy }, documents: loaded.documents });
      return await send(reply, 'JPK_FA', r.xml, r.filename, r.invoices);
    } catch (e) { return refuse(reply, e); }
  });
}
