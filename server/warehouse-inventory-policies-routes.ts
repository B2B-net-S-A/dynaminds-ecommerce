import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ensure } from './errors';
import * as S from './warehouse-inventory-policies';
import * as V from './warehouse-inventory-policies-schema';

export function registerWarehouseInventoryPolicyRoutes(app: FastifyInstance, config: { available: boolean; readOnly: boolean }) {
  const ctx = { readOnly: config.readOnly };
  const actor = (req: any): V.WarehouseInventoryPolicyActor => ({ ...req.actor, ...(req.apiScopes ? { apiKeyId: req.currentUser?.api_key_id } : {}) });
  const id = (req: any) => z.strictObject({ id: z.uuid() }).parse(req.params).id.toLowerCase();
  const empty = (req: any) => z.strictObject({}).parse(req.query);
  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0].replace(/^\/api\/v1\//, '/api/');
    if (!path.startsWith('/api/warehouse-inventory-policies')) return;
    reply.header('Cache-Control', 'no-store');
    const writing = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
    if (writing) ensure(!config.readOnly, 423, 'Odtworzona kopia jest tylko do odczytu');
    const present = await S.warehouseInventoryPoliciesAvailable();
    if (writing || path !== '/api/warehouse-inventory-policies/options') ensure(config.available && present, 503, 'Kopia nie zawiera polityki magazynów');
    if (req.apiScopes) ensure(req.apiScopes.includes('inventory:read') && (!writing || req.apiScopes.includes('inventory:write')), 403, 'Klucz API nie ma zakresów magazynu');
  });
  const mutation = async (reply: any, p: Promise<Record<string, any>>) => { const r = await p; return reply.code(r.reused ? 200 : 201).send(r); };
  app.get('/api/warehouse-inventory-policies/options', req => {
    const q = V.warehouseInventoryPolicyHistoryQuery.omit({ kind: true }).parse(req.query);
    return S.warehouseInventoryPolicyOptions(actor(req), q, ctx);
  });
  app.post('/api/warehouse-inventory-policies/warehouses/:id/previews', { bodyLimit: 16384 }, (req, reply) => {
    empty(req); return mutation(reply, S.previewWarehouseInventoryPolicy(actor(req), id(req), V.warehouseInventoryPolicyPreviewInput.parse(req.body), ctx));
  });
  app.get('/api/warehouse-inventory-policies/previews/:id', req => { empty(req); return S.warehouseInventoryPolicyDetail(actor(req), 'preview', id(req), ctx); });
  app.post('/api/warehouse-inventory-policies/previews/:id/commit', { bodyLimit: 16384 }, (req, reply) => {
    empty(req); return mutation(reply, S.commitWarehouseInventoryPolicy(actor(req), id(req), V.warehouseInventoryPolicyCommitInput.parse(req.body), ctx));
  });
  app.get('/api/warehouse-inventory-policies/operations/:id', req => { empty(req); return S.warehouseInventoryPolicyDetail(actor(req), 'operation', id(req), ctx); });
  app.get('/api/warehouse-inventory-policies/history', req => S.warehouseInventoryPolicyHistory(actor(req), V.warehouseInventoryPolicyHistoryQuery.parse(req.query), ctx));
}
