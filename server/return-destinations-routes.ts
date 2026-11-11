import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ensure } from './errors';
import * as S from './return-destinations';
import * as V from './return-destinations-schema';

/** Not centrally registered until the SQL, core and actual physical adapter pass. */
export function registerReturnDestinationsRoutes(app: FastifyInstance,
  config: S.ReturnDestinationsContext & { available: boolean }) {
  const prefix = '/api/return-destinations';
  const actor = (req: any): V.ReturnDestinationsActor => ({ ...req.actor,
    ...(req.apiScopes ? { apiKeyId: req.currentUser?.api_key_id, source: 'api' as const } : {}) });
  const id = (req: any) => z.strictObject({ id: V.returnDestinationsUuid }).parse(req.params).id;
  const empty = (req: any) => z.strictObject({}).parse(req.query);
  const context: S.ReturnDestinationsContext = { readOnly: config.readOnly,
    receiveCore: config.receiveCore, applyPhysical: config.applyPhysical };
  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0].replace(/^\/api\/v1\//, '/api/');
    if (path !== prefix && !path.startsWith(prefix + '/')) return;
    reply.header('Cache-Control', 'no-store');
    const writing = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
    if (writing) ensure(!config.readOnly, 423, 'Odtworzona kopia jest tylko do odczytu');
    const available = await S.returnDestinationsAvailable();
    if (writing || path !== prefix + '/options') ensure(config.available && available, 503, 'Kopia nie zawiera kompletnego przyjęcia do magazynów');
    const scopes = req.apiScopes;
    if (scopes) ensure(['orders:read', 'inventory:read', ...(writing ? ['orders:write', 'inventory:write'] : [])].every(scope => scopes.includes(scope)),
      403, 'Klucz nie ma zakresów przyjęcia do magazynów');
  });
  app.get(prefix + '/options', async req => { empty(req); return S.returnDestinationsOptions(actor(req), context); });
  app.get(prefix + '/returns/:id/source', async req => S.returnDestinationsSource(actor(req), id(req), V.returnDestinationsSourceQuery.parse(req.query), context));
  app.get(prefix + '/returns/:id/history', async req => S.returnDestinationsHistory(actor(req), id(req), V.returnDestinationsHistoryQuery.parse(req.query), context));
  app.get(prefix + '/previews/:id', async req => { empty(req); return S.returnDestinationsPreviewDetail(actor(req), id(req), context); });
  app.get(prefix + '/operations/:id', async req => { empty(req); return S.returnDestinationsOperationDetail(actor(req), id(req), context); });
  // All legal200parts/500locations/500versions/500picks fit this bounded
  // envelope, including80-character location labels.
  app.post(prefix + '/returns/:id/previews', { bodyLimit: 524288 }, async (req, reply) => {
    empty(req); const result = await S.previewReturnDestinations(actor(req), id(req), V.returnDestinationsPreviewInput.parse(req.body), context);
    return reply.code(result.reused ? 200 : 201).send(result);
  });
  app.post(prefix + '/previews/:id/receive', { bodyLimit: 16384 }, async (req, reply) => {
    empty(req); const result = await S.receiveReturnDestinations(actor(req), id(req), V.returnDestinationsReceiveInput.parse(req.body), context);
    return reply.code(result.reused ? 200 : 201).send(result);
  });
}
