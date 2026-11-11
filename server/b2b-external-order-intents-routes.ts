import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ensure } from './errors';
import * as M from './b2b-external-order-intents';
import * as S from './b2b-external-order-intents-schema';
import { originalRecoveryParams, intentRecoveryQuery } from './original-key-recovery';
const params = z.strictObject({ id: z.uuid().transform((v) => v.toLowerCase()) });
export function registerB2bExternalOrderIntentRoutes(
  app: FastifyInstance,
  opts: { available: boolean; readOnly: boolean },
) {
  const root = '/api/b2b/external-order-intents';
  const actor = (r: FastifyRequest, write = false) => {
    const required = [
      'products:read',
      'inventory:read',
      'orders:read',
      'purchasing:read',
      ...(write ? ['inventory:write', 'orders:write', 'purchasing:write'] : []),
    ];
    ensure(
      !r.apiScopes || required.every((s) => r.apiScopes!.includes(s)),
      403,
      'Brak wymaganych uprawnień intencji realizacji',
    );
    const apiKeyId = r.currentUser?.api_key_id;
    ensure(!r.apiScopes || typeof apiKeyId === 'string', 401, 'Brak kontekstu klucza');
    return { ...r.actor, ...(r.apiScopes ? { apiKeyId } : {}) };
  };
  const writable = (r: FastifyRequest) => {
    ensure(!opts.readOnly, 423, 'Ta kopia jest tylko do odczytu');
    ensure(opts.available, 503, 'Zewnętrzna intencja nie jest dostępna w tej kopii');
    return actor(r, true);
  };
  const send = (p: any, b: any) => {
    p.header('Cache-Control', 'no-store');
    return {
      ...b,
      read_only: opts.readOnly,
      can_manage: b.can_manage && !opts.readOnly,
      can_write_fields: b.can_write_fields && !opts.readOnly,
    };
  };
  app.get(root + '/options', async (r, p) => {
    z.strictObject({}).parse(r.query);
    return send(p, await M.b2bExternalOrderIntentOptions(actor(r)));
  });
  app.get(root + '/original-results/:key', async (r,p) => send(p, await M.recoverExternalIntentOriginalKey(actor(r), originalRecoveryParams.parse(r.params).key, intentRecoveryQuery.parse(r.query))));
  app.get(root + '/orders', async (r, p) =>
    send(
      p,
      await M.b2bExternalOrderIntentList(
        actor(r),
        S.b2bExternalOrderIntentPageQuery.parse(r.query),
      ),
    ),
  );
  app.post(root + '/orders', { bodyLimit: 65536 }, async (r, p) => {
    const a = writable(r),
      body = S.b2bExternalOrderIntentCreateInput.parse(r.body);
    ensure(
      !body.order.initial_fields?.length ||
        !r.apiScopes ||
        r.apiScopes.includes('order-fields:write'),
      403,
      'Brak scope order-fields:write',
    );
    const result = await M.createB2bExternalOrderIntent(a, body);
    p.code(result.reused ? 200 : 201);
    return send(p, result);
  });
  app.get(root + '/orders/:id', async (r, p) => {
    z.strictObject({}).parse(r.query);
    return send(p, await M.b2bExternalOrderIntentDetail(actor(r), params.parse(r.params).id));
  });
  app.post(root + '/orders/:id/allocate', { bodyLimit: 65536 }, async (r, p) => {
    const a = writable(r);
    return send(
      p,
      await M.allocateB2bExternalOrderIntent(
        a,
        params.parse(r.params).id,
        S.b2bExternalOrderIntentAllocateInput.parse(r.body),
      ),
    );
  });
  for (const action of ['cancel', 'reopen'] as const)
    app.post(root + '/orders/:id/' + action, { bodyLimit: 16384 }, async (r, p) => {
      const a = writable(r);
      return send(
        p,
        await M.actionB2bExternalOrderIntent(
          a,
          params.parse(r.params).id,
          action === 'cancel' ? 'close' : 'reopen',
          S.b2bExternalOrderIntentActionInput.parse(r.body),
        ),
      );
    });
}
