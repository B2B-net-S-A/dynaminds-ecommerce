import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ensure } from './errors';
import type { PackingActor } from './packing-workstation-schema';
import * as P from './packing-photos';
export function registerPackingPhotoRoutes(app: FastifyInstance, opts: { readOnly: boolean }) {
  const actor = (req: any, write = false): PackingActor => {
    if (req.apiScopes) {
      ensure(req.currentUser?.api_key_id, 401, 'Brak tożsamości klucza');
      ensure(req.apiScopes.includes('orders:read') && (!write || req.apiScopes.includes('orders:write')), 403, 'Brak zakresów pakowania');
    }
    ensure(!write || !opts.readOnly, 423, 'Kopia jest tylko do odczytu');
    return { ...req.actor, source: req.apiScopes ? 'api' : 'manual', ...(req.apiScopes ? { apiKeyId: req.currentUser.api_key_id } : {}) };
  };
  const id = (req: any) => z.strictObject({ id: z.uuid() }).parse(req.params).id.toLowerCase();
  app.get('/api/packing/receipts/:id/photos', async (req, reply) => { reply.header('Cache-Control', 'no-store'); return P.packingPhotos(actor(req), id(req)); });
  app.get('/api/packing/photos/attempts/:id', async (req, reply) => { reply.header('Cache-Control', 'no-store'); return P.packingPhotoAttempt(actor(req), id(req)); });
  app.get('/api/packing/photos/:id/content', async (req, reply) => {
    reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff');
    return P.packingPhotoContent(actor(req), id(req));
  });
  app.post('/api/packing/photos', { bodyLimit: 710000, onRequest: async req => { actor(req, true); } }, async (req, reply) => {
    const r = await P.uploadPackingPhoto(actor(req, true), req.body); reply.code(r.reused ? 200 : 201); return r;
  });
  app.post('/api/packing/photos/confirm', { bodyLimit: 2048, onRequest: async req => { actor(req, true); } }, async (req, reply) => {
    const r = await P.confirmPackingPhoto(actor(req, true), req.body); reply.code(r.reused ? 200 : 201); return r;
  });
}
