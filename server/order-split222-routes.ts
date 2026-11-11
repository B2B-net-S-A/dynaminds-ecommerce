/** Session (and /api/v1 API-key) routes of the native 222 order split. Always
 * registered so the /api/v1 aliases exist; every call answers 503 unless the 222
 * schema is present (`order_split222_available` in /api/health). */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ensure } from './errors';
import * as M from './order-split222';

const params = z.strictObject({ id: M.orderSplit222Id });
const empty = z.strictObject({});
export function registerOrderSplit222Routes(
  app: FastifyInstance,
  opts: { available: boolean; readOnly: boolean; service?: Pick<typeof M,
    'createOrderSplit222Preview' | 'executeOrderSplit222' | 'orderSplit222PreviewDetail' | 'orderSplit222ExecutionDetail' | 'orderSplit222Lineage'> },
) {
  const service = opts.service ?? M;
  const actor = (req: FastifyRequest, write: boolean) => {
    ensure(opts.available, 503, 'Podział zamówień jest niedostępny w tej kopii');
    ensure(!write || !opts.readOnly, 423, 'Ta kopia jest tylko do odczytu');
    const scopes = ['orders:read', 'inventory:read', ...(write ? ['orders:write', 'inventory:write'] : [])];
    ensure(!req.apiScopes || scopes.every((s) => req.apiScopes!.includes(s)), 403, 'Wymagane scope: ' + scopes.join(', '));
    ensure(!write || ['admin', 'operator'].includes(req.actor.role), 403, 'Podział zamówienia wymaga roli administratora lub operatora');
    if (!req.apiScopes) return M.captureOrderSplit222Actor({ ...req.actor, apiKeyId: undefined, source: 'manual' });
    const key = req.currentUser?.api_key_id, auth = req.headers.authorization;
    ensure(typeof key === 'string' && typeof auth === 'string' && auth.startsWith('Bearer '), 401, 'Brak kontekstu klucza API');
    return M.captureOrderSplit222Actor({ ...req.actor, apiKeyId: key, source: 'api' }, auth.slice(7));
  };
  const writeOptions = { bodyLimit: M.ORDER_SPLIT222_LIMITS.request_bytes };
  app.post('/api/orders/:id/splits/previews', writeOptions, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    empty.parse(req.query);
    const r = await service.createOrderSplit222Preview(actor(req, true), params.parse(req.params).id, req.body);
    return reply.code(r.reused ? 200 : 201).send({ ...r, read_only: opts.readOnly });
  });
  app.post('/api/order-splits/:id/execute', writeOptions, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    empty.parse(req.query);
    const r = await service.executeOrderSplit222(actor(req, true), params.parse(req.params).id, req.body);
    return reply.code(r.reused ? 200 : 201).send({ ...r, read_only: opts.readOnly });
  });
  app.get('/api/order-splits/previews/:id', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    empty.parse(req.query);
    return { ...(await service.orderSplit222PreviewDetail(actor(req, false), params.parse(req.params).id)), read_only: opts.readOnly };
  });
  app.get('/api/order-splits/executions/:id', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    empty.parse(req.query);
    return { ...(await service.orderSplit222ExecutionDetail(actor(req, false), params.parse(req.params).id)), read_only: opts.readOnly };
  });
  app.get('/api/orders/:id/splits', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    empty.parse(req.query);
    return { ...(await service.orderSplit222Lineage(actor(req, false), params.parse(req.params).id)), read_only: opts.readOnly };
  });
}
