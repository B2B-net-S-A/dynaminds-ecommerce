/** Session (and API-key) routes of the 226 tax model: the product tax profile, the
 * tenant OSS settings and the tax facts of local invoices (preview, issue with the
 * snapshot, issued document). Always registered; without 226 every call is 503. */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { tenantTx, tenantReadTx } from './db';
import { ensure } from './errors';
import { productLogisticsRequestActor } from './product-logistics';
import { ossSettingsInput, taxProfileInput } from './tax226-model';
import { ossSettingsInTx, productTaxProfileInTx, saveOssSettingsInTx, saveProductTaxProfileInTx } from './tax226';
import { issueLocalInvoiceWithTax, localInvoiceDocumentTax, localInvoicePreviewTax, taxInvoiceActor } from './tax226-local-invoices';

const id = (p: unknown) => z.strictObject({ id: z.uuid().transform(v => v.toLowerCase()) }).parse(p).id;
const empty = z.strictObject({});
/** The handler of POST /api/local-invoices/previews/:id/tax-issue: 157 issue with the 226 snapshot, or a
 * 230 preview in the FV-S sub-series. Also serves the pinned native /issue through its alias guard. */
export function taxIssueHandler(opts: { available: boolean; readOnly: boolean; sessionName: string }) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    ensure(opts.available, 503, 'Model podatkowy (migracja 226) jest niedostępny w tej kopii');
    ensure(!opts.readOnly, 423, 'Kopia jest tylko do odczytu');
    empty.parse(req.query);
    const v = await issueLocalInvoiceWithTax(taxInvoiceActor(req as any, opts.sessionName), id(req.params), req.body);
    reply.code(v.reused ? 200 : 201);
    return { ...v, read_only: opts.readOnly, ...(typeof v.can_write === 'boolean' ? { can_write: !opts.readOnly && v.can_write, can_create_series: !opts.readOnly && v.can_create_series } : {}) };
  };
}
export function registerTax226Routes(app: FastifyInstance, opts: { available: boolean; readOnly: boolean; sessionName: string }) {
  const actor = (req: FastifyRequest, scope: string, write: boolean) => {
    ensure(opts.available, 503, 'Model podatkowy (migracja 226) jest niedostępny w tej kopii');
    ensure(!write || !opts.readOnly, 423, 'Ta kopia jest tylko do odczytu');
    ensure(!req.apiScopes || req.apiScopes.includes(scope), 403, 'Wymagane scope: ' + scope);
    ensure(!write || req.actor.role === 'admin', 403, 'Dane podatkowe zmienia administrator');
    return productLogisticsRequestActor(req);
  };
  const invoiceActor = (req: FastifyRequest, write: boolean) => {
    ensure(opts.available, 503, 'Model podatkowy (migracja 226) jest niedostępny w tej kopii');
    ensure(!write || !opts.readOnly, 423, 'Kopia jest tylko do odczytu');
    return taxInvoiceActor(req as any, opts.sessionName);
  };
  const project = (v: any) => ({ ...v, read_only: opts.readOnly, ...(typeof v.can_write === 'boolean'
    ? { can_write: !opts.readOnly && v.can_write, can_create_series: !opts.readOnly && v.can_create_series } : {}) });

  app.get('/api/products/:id/tax-profile', async req => {
    empty.parse(req.query);
    const a = actor(req, 'products:read', false);
    return { ...(await tenantReadTx(a.tenantId, c => productTaxProfileInTx(c, id(req.params)))), read_only: opts.readOnly };
  });
  app.put('/api/products/:id/tax-profile', async req => {
    empty.parse(req.query);
    const a = actor(req, 'products:write', true), b = taxProfileInput.parse(req.body);
    return { ...(await tenantTx(a.tenantId, c => saveProductTaxProfileInTx(c, a, id(req.params), b))), read_only: opts.readOnly };
  });
  app.get('/api/tax/oss', async req => {
    empty.parse(req.query);
    const a = actor(req, 'documents:read', false);
    return { ...(await tenantReadTx(a.tenantId, c => ossSettingsInTx(c))), read_only: opts.readOnly };
  });
  app.put('/api/tax/oss', async req => {
    empty.parse(req.query);
    const a = actor(req, 'documents:write', true), b = ossSettingsInput.parse(req.body);
    return { ...(await tenantTx(a.tenantId, c => saveOssSettingsInTx(c, a, b))), read_only: opts.readOnly };
  });
  // Under /api/local-invoices: the native onRequest hook adds no-store, 423 and the module check.
  app.get('/api/local-invoices/previews/:id/tax', async req => {
    empty.parse(req.query);
    return project(await localInvoicePreviewTax(invoiceActor(req, false), id(req.params)));
  });
  app.post('/api/local-invoices/previews/:id/tax-issue', taxIssueHandler(opts));
  app.get('/api/local-invoices/documents/:id/tax', async req => {
    empty.parse(req.query);
    return project(await localInvoiceDocumentTax(invoiceActor(req, false), id(req.params)));
  });
}
