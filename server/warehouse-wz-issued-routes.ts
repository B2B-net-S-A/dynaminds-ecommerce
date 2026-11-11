import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ensure } from './errors';
import * as S from './warehouse-wz-issued';
import * as V from './warehouse-wz-issued-schema';

export function registerIssuedWzRoutes(app: FastifyInstance, context: { readOnly: boolean }) {
  const prefix = '/api/warehouse-wz-issued';
  const actor = (req: any): V.IssuedWzActor => ({ ...req.actor, apiKeyId: req.actor.apiKeyId ?? req.apiKeyId ?? req.currentUser?.api_key_id });
  const id = (req: any) => z.strictObject({ id: V.issuedWzUuid }).parse(req.params).id;
  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0].replace(/^\/api\/v1\//, '/api/');
    if (path !== prefix && !path.startsWith(prefix + '/')) return;
    reply.header('Cache-Control', 'no-store');
    if (!['GET','HEAD','OPTIONS'].includes(req.method)) {
      ensure(!context.readOnly, 423, 'Odtworzona kopia jest tylko do odczytu');
      ensure(false, 405, 'Wystawione dokumenty WZ są tylko do odczytu');
    }
    if (req.apiScopes) ensure(req.apiScopes.includes('inventory:read'), 403, 'Brak odczytu magazynu');
  });
  app.get(prefix + '/options', req => { z.strictObject({}).parse(req.query); return S.issuedWzOptions(actor(req), context); });
  app.get(prefix + '/documents', req => S.issuedWzList(actor(req), req.query, context));
  app.get(prefix + '/documents/:id', req => { z.strictObject({}).parse(req.query); return S.issuedWzDetail(actor(req), id(req), context); });
  app.get(prefix + '/documents/:id/export', req => S.issuedWzExport(actor(req), id(req), req.query, context));
}
