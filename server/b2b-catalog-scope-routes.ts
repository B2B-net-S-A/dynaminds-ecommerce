import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ensure } from './errors';
import * as S from './b2b-catalog-scope';
import * as V from './b2b-catalog-scope-schema';

/** Registration is owned by the central app; this module does not mount itself. */
export function registerB2BCatalogScopeRoutes(app: FastifyInstance, config: { available: boolean; readOnly: boolean }) {
  const ctx = { readOnly: config.readOnly };
  const actor = (req: any): V.B2BCatalogScopeActor => ({ ...req.actor,
    ...(req.apiScopes ? { apiKeyId: req.currentUser?.api_key_id, source: 'api' as const } : {}) });
  const entity = (req: any, key: 'account_id' | 'link_id' | 'id') =>
    z.strictObject({ [key]: z.uuid() }).parse(req.params)[key].toLowerCase();
  const empty = (req: any) => z.strictObject({}).parse(req.query);
  const normalized = (url: string) => url.split('?')[0].replace(/^\/api\/v1\//, '/api/');
  const ownPath = (path: string) => /^\/api\/b2b\/(?:accounts\/[^/]+\/catalog-scope(?:\/(?:previews|history))?|network\/links\/[^/]+\/catalog-scope(?:\/(?:previews|history))?|catalog-scope\/(?:previews\/[^/]+(?:\/commit)?|operations\/[^/]+))$/.test(path);
  const optionsPath = (path: string) => /^\/api\/b2b\/(?:accounts|network\/links)\/[^/]+\/catalog-scope$/.test(path);
  app.addHook('onRequest', async (req, reply) => {
    const path = normalized(req.url);
    if (!ownPath(path)) return;
    reply.header('Cache-Control', 'no-store');
    const writing = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
    if (writing) ensure(!config.readOnly, 423, 'Odtworzona kopia jest tylko do odczytu');
    const present = await S.b2bCatalogScopeAvailable();
    if (writing || !optionsPath(path)) ensure(config.available && present, 503, 'Kopia nie zawiera zakresów katalogów B2B');
    // Entity-specific compound grants, including receipt kind, are rechecked
    // in the service using the actual current membership/key before COMMIT.
    if (req.apiScopes) {
      ensure(req.apiScopes.includes('products:read') && (!writing || req.apiScopes.includes('products:write')), 403, 'Klucz API nie ma zakresów katalogu B2B');
      if (path.startsWith('/api/b2b/network/links/'))
        ensure(req.apiScopes.includes('purchasing:read') && (!writing || req.apiScopes.includes('purchasing:write')), 403, 'Klucz API nie ma zakresów współpracy B2B');
      if (writing && path.startsWith('/api/b2b/accounts/'))
        ensure(req.apiScopes.includes('inventory:read'), 403, 'Klucz API nie ma zakresu magazynu B2B');
    }
  });
  const mutation = async (reply: any, result: Promise<Record<string, any>>) => {
    const r = await result;
    return reply.code(r.reused ? 200 : 201).send(r);
  };
  app.get('/api/b2b/accounts/:account_id/catalog-scope', async req => {
    empty(req); return S.b2bCatalogScopeOptions(actor(req), 'supplier', entity(req, 'account_id'), ctx);
  });
  app.post('/api/b2b/accounts/:account_id/catalog-scope/previews', { bodyLimit: 16384 }, async (req, reply) => {
    empty(req); return mutation(reply, S.previewB2BSupplierCatalogScope(actor(req), entity(req, 'account_id'), V.b2bSupplierCatalogScopePreviewInput.parse(req.body), ctx));
  });
  app.get('/api/b2b/network/links/:link_id/catalog-scope', async req => {
    empty(req); return S.b2bCatalogScopeOptions(actor(req), 'buyer', entity(req, 'link_id'), ctx);
  });
  app.post('/api/b2b/network/links/:link_id/catalog-scope/previews', { bodyLimit: 16384 }, async (req, reply) => {
    empty(req); return mutation(reply, S.previewB2BBuyerCatalogScope(actor(req), entity(req, 'link_id'), V.b2bBuyerCatalogScopePreviewInput.parse(req.body), ctx));
  });
  app.get('/api/b2b/catalog-scope/previews/:id', async req => {
    empty(req); return S.b2bCatalogScopePreview(actor(req), entity(req, 'id'), ctx);
  });
  app.post('/api/b2b/catalog-scope/previews/:id/commit', { bodyLimit: 16384 }, async (req, reply) => {
    empty(req); return mutation(reply, S.commitB2BCatalogScope(actor(req), entity(req, 'id'), V.b2bCatalogScopeCommitInput.parse(req.body), ctx));
  });
  app.get('/api/b2b/catalog-scope/operations/:id', async req => {
    empty(req); return S.b2bCatalogScopeOperation(actor(req), entity(req, 'id'), ctx);
  });
  app.get('/api/b2b/accounts/:account_id/catalog-scope/history', async req =>
    S.b2bCatalogScopeHistory(actor(req), 'supplier', entity(req, 'account_id'), V.b2bCatalogScopeHistoryQuery.parse(req.query), ctx));
  app.get('/api/b2b/network/links/:link_id/catalog-scope/history', async req =>
    S.b2bCatalogScopeHistory(actor(req), 'buyer', entity(req, 'link_id'), V.b2bCatalogScopeHistoryQuery.parse(req.query), ctx));
}
