/** Routes of migration 243 (purchase invoices received in KSeF; docs/parity/KSEF-PURCHASE243-20261027.md).
 * Settings of a NIP: administrator with a session only. "Pobierz teraz", the workflow (status, accounting number,
 * note), "Pobierz ponownie" of a refused file and the accountant's package: administrator or operator (session, or
 * an API key with documents:write; the package is a bulk export of counterparties' data, so viewer gets 403).
 * Reading the list, the detail and the FA(3) file: any role (or documents:read). Always registered; without 243
 * every call is 503, writes and the logged package in a read-only copy 423. */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { tenantReadTx, tenantTx } from './db';
import { ensure } from './errors';
import type { KsefActor } from './ksef229';
import { KSEF_REAL_ENABLED } from './ksef229-client';
import {
  ensureFetchJobInTx, exportPackage, invoiceDetailInTx, invoiceXmlInTx, listInvoicesInTx, patchInvoiceInTx, rejectsInTx, retryReject, runPurchaseFetch, saveSyncInTx, statusInTx, type Ksef243Options,
} from './ksef243';
import {
  PURCHASE_RUN, purchaseExportQuery, purchaseIdParam, purchaseInvoicePatch, purchaseKsefParam, purchaseListQuery, purchaseNipParam, purchaseRunInput, purchaseSyncInput,
  type PurchaseInvoicePatch, type PurchaseListQuery, type PurchaseSyncInput,
} from './ksef243-model';

export type Ksef243Service = {
  status(a: KsefActor): Promise<unknown>;
  saveSync(a: KsefActor, nip: string, body: PurchaseSyncInput): Promise<unknown>;
  run(a: KsefActor, nip: string): Promise<unknown>;
  list(a: KsefActor, q: PurchaseListQuery): Promise<unknown>;
  detail(a: KsefActor, id: string): Promise<unknown>;
  xml(a: KsefActor, id: string): Promise<{ body: Buffer; filename: string }>;
  patch(a: KsefActor, id: string, body: PurchaseInvoicePatch): Promise<unknown>;
  rejects(a: KsefActor): Promise<unknown>;
  retry(a: KsefActor, ksefNumber: string): Promise<unknown>;
  exportPackage(a: KsefActor, q: Partial<PurchaseListQuery>): Promise<{ body: Buffer; filename: string; count: number }>;
};
export function ksef243Service(o: Ksef243Options = {}): Ksef243Service {
  return {
    status: a => tenantReadTx(a.tenantId, c => statusInTx(c)),
    saveSync: (a, nip, b) => tenantTx(a.tenantId, c => saveSyncInTx(c, a, nip, b)),
    // "Pobierz teraz": one shorter run in the request; an unfinished fetch continues in the job.
    run: async (a, nip) => {
      const r = await runPurchaseFetch(a, nip, { budgetMs: PURCHASE_RUN.manualBudgetMs, maxPages: PURCHASE_RUN.manualMaxPages, ...o });
      if (r.outcome === 'partial') await tenantTx(a.tenantId, c => ensureFetchJobInTx(c, a.tenantId, a.userId, nip, 0));
      return r;
    },
    list: (a, q) => tenantReadTx(a.tenantId, c => listInvoicesInTx(c, q)),
    detail: (a, id) => tenantReadTx(a.tenantId, c => invoiceDetailInTx(c, id)),
    xml: (a, id) => tenantReadTx(a.tenantId, c => invoiceXmlInTx(c, id)),
    patch: (a, id, b) => tenantTx(a.tenantId, c => patchInvoiceInTx(c, a, id, b)),
    rejects: a => tenantReadTx(a.tenantId, c => rejectsInTx(c)),
    retry: (a, k) => retryReject(a, k, o),
    exportPackage: (a, q) => exportPackage(a, q, o),
  };
}
export type Ksef243RouteOptions = { available: boolean; readOnly: boolean; service: Ksef243Service };

const READ = ['admin', 'operator', 'viewer'], WRITE = ['admin', 'operator'];
const empty = z.strictObject({});

export function registerKsef243Routes(app: FastifyInstance, opts: Ksef243RouteOptions) {
  const s = opts.service;
  const actor = (req: FastifyRequest, o: { roles: string[]; write: boolean; scope?: string; sessionOnly?: boolean }): KsefActor => {
    ensure(opts.available, 503, 'Faktury zakupowe z KSeF (migracja 243) są niedostępne w tej kopii');
    const a = (req as any).actor as (KsefActor & { source?: string }) | undefined, scopes = (req as any).apiScopes as string[] | undefined;
    ensure(a?.userId, 401, 'Brak sesji');
    const api = Boolean(scopes || a.apiKeyId || a.source === 'api');
    ensure(!api || !o.sessionOnly, 403, 'Ustawienia pobierania faktur zakupowych wymagają sesji administratora (klucz API nie wystarczy)');
    ensure(!api || (o.scope && scopes?.includes(o.scope)), 403, 'Wymagane scope: ' + (o.scope ?? 'sesja'));
    ensure(o.roles.includes(a.role), 403, o.roles.length === 1 ? 'Ustawienia pobierania faktur zakupowych zmienia tylko administrator'
      : o.roles === WRITE ? 'Ta czynność wymaga roli administratora lub operatora' : 'Brak uprawnień do faktur zakupowych');
    ensure(!o.write || !opts.readOnly, 423, 'Ta kopia jest tylko do odczytu');
    return { tenantId: a.tenantId, userId: a.userId, role: a.role, ...(a.apiKeyId ? { apiKeyId: a.apiKeyId } : {}) };
  };
  const noStore = (reply: any) => reply.header('Cache-Control', 'private, no-store');
  const file = (reply: any, type: string, name: string, body: Buffer) => noStore(reply).type(type).header('X-Content-Type-Options', 'nosniff')
    .header('Content-Disposition', `attachment; filename="${name.replace(/[^A-Za-z0-9._-]/g, '_')}"`).send(body);

  app.get('/api/ksef243/status', async (req, reply) => {
    empty.parse(req.query); const a = actor(req, { roles: READ, write: false, scope: 'documents:read' }); noStore(reply);
    return { available: true, read_only: opts.readOnly, real_mf_enabled: KSEF_REAL_ENABLED, can_configure: a.role === 'admin' && !opts.readOnly,
      can_fetch: WRITE.includes(a.role) && !opts.readOnly, can_reopen: a.role === 'admin' && !opts.readOnly, ...(await s.status(a) as object) };
  });
  app.put('/api/ksef243/sync/:nip', async (req, reply) => {
    empty.parse(req.query); const a = actor(req, { roles: ['admin'], write: true, sessionOnly: true }); noStore(reply);
    const { nip } = purchaseNipParam.parse(req.params);
    return s.saveSync(a, nip, purchaseSyncInput(new Date()).parse(req.body));
  });
  app.post('/api/ksef243/sync/:nip/run', async (req, reply) => {
    empty.parse(req.query); const a = actor(req, { roles: WRITE, write: true, scope: 'documents:write' }); noStore(reply);
    const { nip } = purchaseNipParam.parse(req.params); purchaseRunInput.parse(req.body ?? {});
    return s.run(a, nip);
  });
  app.get('/api/ksef243/invoices', async (req, reply) => {
    const q = purchaseListQuery.parse(req.query); const a = actor(req, { roles: READ, write: false, scope: 'documents:read' }); noStore(reply);
    return s.list(a, q);
  });
  app.get('/api/ksef243/invoices/:id', async (req, reply) => {
    empty.parse(req.query); const a = actor(req, { roles: READ, write: false, scope: 'documents:read' }); noStore(reply);
    return s.detail(a, purchaseIdParam.parse(req.params).id);
  });
  app.get('/api/ksef243/invoices/:id/fa3.xml', async (req, reply) => {
    empty.parse(req.query); const a = actor(req, { roles: READ, write: false, scope: 'documents:read' });
    const f = await s.xml(a, purchaseIdParam.parse(req.params).id);
    return file(reply, 'application/xml; charset=utf-8', f.filename, f.body);
  });
  app.patch('/api/ksef243/invoices/:id', async (req, reply) => {
    empty.parse(req.query); const a = actor(req, { roles: WRITE, write: true, scope: 'documents:write' }); noStore(reply);
    return s.patch(a, purchaseIdParam.parse(req.params).id, purchaseInvoicePatch.parse(req.body));
  });
  app.get('/api/ksef243/rejects', async (req, reply) => {
    empty.parse(req.query); const a = actor(req, { roles: READ, write: false, scope: 'documents:read' }); noStore(reply);
    return s.rejects(a);
  });
  app.post('/api/ksef243/rejects/:ksef/retry', async (req, reply) => {
    empty.parse(req.query); const a = actor(req, { roles: WRITE, write: true, scope: 'documents:write' }); noStore(reply);
    const { ksef } = purchaseKsefParam.parse(req.params); empty.parse(req.body ?? {});
    return s.retry(a, ksef);
  });
  app.get('/api/ksef243/export.zip', async (req, reply) => {
    const q = purchaseExportQuery.parse(req.query); const a = actor(req, { roles: WRITE, write: true, scope: 'documents:write' });
    const f = await s.exportPackage(a, q);
    return file(reply, 'application/zip', f.filename, f.body);
  });
}
