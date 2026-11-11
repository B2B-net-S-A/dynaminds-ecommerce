import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ensure } from './errors';
import * as S from './return-destination-statuses';
import * as V from './return-destination-statuses-schema';

export function registerReturnDestinationStatusRoutes(app: FastifyInstance, config: { available: boolean; readOnly: boolean; intakeAvailable?: boolean }) {
  const prefix = '/api/return-assistant/statuses';
  const actor = (req: any): V.ReturnDestinationStatusActor => ({ ...req.actor,
    ...(req.apiScopes ? { apiKeyId: req.currentUser?.api_key_id, source: 'api' as const } : {}) });
  const id = (req: any) => z.strictObject({ id: V.returnDestinationStatusUuid }).parse(req.params).id;
  const empty = (req: any) => z.strictObject({}).parse(req.query);
  const context = { readOnly: config.readOnly, intakeAvailable: config.intakeAvailable === true };
  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0].replace(/^\/api\/v1\//, '/api/');
    if (path !== prefix && !path.startsWith(prefix + '/')) return;
    reply.header('Cache-Control', 'no-store');
    const writing = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
    if (writing) ensure(!config.readOnly, 423, 'Odtworzona kopia jest tylko do odczytu');
    const available = await S.returnDestinationStatusesAvailable();
    if (writing || path !== prefix + '/options') ensure(config.available && available, 503, 'Kopia nie zawiera kompletnej konfiguracji statusów');
    const scopes = req.apiScopes;
    if (scopes) ensure(['orders:read', 'inventory:read', ...(writing ? ['returns:configure'] : [])].every(scope => scopes.includes(scope)),
      403, 'Klucz nie ma zakresów konfiguracji statusów zwrotu');
  });
  app.get(prefix + '/options', async req => { empty(req); return S.returnDestinationStatusOptions(actor(req), context); });
  app.get(prefix, async req => S.returnDestinationStatusList(actor(req), V.returnDestinationStatusListQuery.parse(req.query), context));
  app.get(prefix + '/:id', async req => { empty(req); return S.returnDestinationStatusDetail(actor(req), id(req), context); });
  app.get(prefix + '/:id/history', async req => S.returnDestinationStatusHistory(actor(req), id(req), V.returnDestinationStatusHistoryQuery.parse(req.query), context));
  app.get(prefix + '/previews/:id', async req => { empty(req); return S.returnDestinationStatusPreview(actor(req), id(req), context); });
  app.get(prefix + '/operations/:id', async req => { empty(req); return S.returnDestinationStatusOperation(actor(req), id(req), context); });
  app.post(prefix + '/previews', { bodyLimit: 16384 }, async (req, reply) => {
    empty(req); const result = await S.previewReturnDestinationStatus(actor(req), V.returnDestinationStatusPreviewInput.parse(req.body), context);
    return reply.code(result.reused ? 200 : 201).send(result);
  });
  app.post(prefix + '/previews/:id/commit', { bodyLimit: 8192 }, async (req, reply) => {
    empty(req); const result = await S.commitReturnDestinationStatus(actor(req), id(req), V.returnDestinationStatusCommitInput.parse(req.body), context);
    return reply.code(result.reused ? 200 : 201).send(result);
  });
}
