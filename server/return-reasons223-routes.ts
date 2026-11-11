/** Session (and /api/v1 API-key) routes of the native 223 return reason
 * dictionary. Always registered so the /api/v1 aliases exist; every call answers
 * 503 unless the 223 schema is present (`return_reasons223_available` in /api/health). */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { tenantTx, tenantReadTx } from './db';
import { ensure } from './errors';
import { createReturnReason, listReturnReasons, returnReasonListQuery, updateReturnReason } from './return-reasons223';

const params = z.strictObject({ id: z.uuid() });
const empty = z.strictObject({});
export function registerReturnReasons223Routes(app: FastifyInstance, opts: { available: boolean; readOnly: boolean }) {
  const actor = (req: FastifyRequest, write: boolean) => {
    ensure(opts.available, 503, 'Słownik powodów zwrotu jest niedostępny w tej kopii');
    ensure(!write || !opts.readOnly, 423, 'Ta kopia jest tylko do odczytu');
    const scopes = ['orders:read', ...(write ? ['returns:configure'] : [])];
    ensure(!req.apiScopes || scopes.every((s) => req.apiScopes!.includes(s)), 403, 'Wymagane scope: ' + scopes.join(', '));
    return req.apiScopes ? { ...req.actor, apiKeyId: req.currentUser?.api_key_id, source: 'api' as const } : req.actor;
  };
  app.get('/api/return-reasons', async (req) => {
    const a = actor(req, false), q = returnReasonListQuery.parse(req.query);
    return { data: await tenantReadTx(a.tenantId, (c) => listReturnReasons(c, { includeInactive: q.include_inactive === 'true' })),
      read_only: opts.readOnly };
  });
  app.post('/api/return-reasons', async (req, reply) => {
    const a = actor(req, true);
    empty.parse(req.query);
    return reply.code(201).send(await tenantTx(a.tenantId, (c) => createReturnReason(c, a, req.body)));
  });
  app.patch('/api/return-reasons/:id', async (req) => {
    const a = actor(req, true);
    empty.parse(req.query);
    return tenantTx(a.tenantId, (c) => updateReturnReason(c, a, params.parse(req.params).id, req.body));
  });
}
