import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ensure } from './errors';
import * as M from './b2b-network-dropshipping';
import * as S from './b2b-network-dropshipping-schema';
const uuid = z.uuid().transform((v) => v.toLowerCase());
const linkParams = z.strictObject({ link_id: uuid });
const objectParams = linkParams.extend({ id: uuid });
export function registerB2bNetworkDropshippingRoutes(
  app: FastifyInstance,
  opts: { available: boolean; readOnly: boolean },
) {
  const root = '/api/b2b/network/links/:link_id/dropshipping';
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
      'Brak wymaganych uprawnień dropshippingu',
    );
    const apiKeyId = r.currentUser?.api_key_id;
    ensure(!r.apiScopes || typeof apiKeyId === 'string', 401, 'Brak aktualnego kontekstu klucza');
    return { ...r.actor, ...(r.apiScopes ? { apiKeyId } : {}) };
  };
  const writable = (r: FastifyRequest) => {
    ensure(!opts.readOnly, 423, 'Ta kopia jest tylko do odczytu');
    ensure(opts.available, 503, 'Dropshipping nie jest dostępny w tej kopii');
    return actor(r, true);
  };
  const send = (reply: any, body: any) => {
    reply.header('Cache-Control', 'no-store');
    const manage = body.can_manage && !opts.readOnly;
    if (body.quote) body.quote.can_checkout = body.quote.can_checkout && manage;
    if (body.order) {
      body.order.can_cancel = body.order.can_cancel && manage;
      body.order.can_reconcile = body.order.can_reconcile && manage;
    }
    return { ...body, read_only: opts.readOnly, can_manage: manage };
  };
  app.get(root + '/options', async (r, p) => {
    z.strictObject({}).parse(r.query);
    return send(p, await M.b2bDropshipOptions(actor(r), linkParams.parse(r.params).link_id));
  });
  app.get(root + '/sources', async (r, p) =>
    send(
      p,
      await M.b2bDropshipSources(
        actor(r),
        linkParams.parse(r.params).link_id,
        S.b2bDropshipSourceQuery.parse(r.query),
      ),
    ),
  );
  app.get(root + '/sources/:id', async (r, p) => {
    z.strictObject({}).parse(r.query);
    const ids = objectParams.parse(r.params);
    return send(p, await M.b2bDropshipSource(actor(r), ids.link_id, ids.id));
  });
  app.get(root + '/quotes', async (r, p) =>
    send(
      p,
      await M.b2bDropshipQuotes(
        actor(r),
        linkParams.parse(r.params).link_id,
        S.b2bDropshipPageQuery.parse(r.query),
      ),
    ),
  );
  app.post(root + '/quotes', { bodyLimit: 65536 }, async (r, p) => {
    const a = writable(r);
    const body = S.b2bDropshipQuoteInput.parse(r.body);
    const result = await M.createB2bDropshipQuote(a, linkParams.parse(r.params).link_id, body);
    p.code(result.reused ? 200 : 201);
    return send(p, result);
  });
  app.get(root + '/quotes/:id', async (r, p) => {
    z.strictObject({}).parse(r.query);
    const ids = objectParams.parse(r.params);
    return send(p, await M.b2bDropshipQuote(actor(r), ids.link_id, ids.id));
  });
  app.post(root + '/quotes/:id/checkout', { bodyLimit: 16384 }, async (r, p) => {
    const a = writable(r),
      ids = objectParams.parse(r.params);
    const result = await M.checkoutB2bDropship(
      a,
      ids.link_id,
      ids.id,
      S.b2bDropshipCheckoutInput.parse(r.body),
    );
    p.code(result.reused ? 200 : 201);
    return send(p, result);
  });
  app.get(root + '/orders', async (r, p) =>
    send(
      p,
      await M.b2bDropshipOrders(
        actor(r),
        linkParams.parse(r.params).link_id,
        S.b2bDropshipPageQuery.parse(r.query),
      ),
    ),
  );
  app.get(root + '/orders/:id', async (r, p) => {
    z.strictObject({}).parse(r.query);
    const ids = objectParams.parse(r.params);
    return send(p, await M.b2bDropshipOrder(actor(r), ids.link_id, ids.id));
  });
  app.post(root + '/orders/:id/cancel', { bodyLimit: 16384 }, async (r, p) => {
    const a = writable(r),
      ids = objectParams.parse(r.params);
    return send(
      p,
      await M.cancelB2bDropship(a, ids.link_id, ids.id, S.b2bDropshipCancelInput.parse(r.body)),
    );
  });
  // 251 (B2B-005): copy the supplier parcel numbers to the customer order.
  app.post(root + '/orders/:id/tracking/sync', { bodyLimit: 16384 }, async (r, p) => {
    const a = writable(r),
      ids = objectParams.parse(r.params);
    z.strictObject({ confirmed: z.literal(true) }).parse(r.body);
    return send(p, await M.syncB2bDropshipTracking(a, ids.link_id, ids.id));
  });
  app.post(root + '/orders/:id/reconcile', { bodyLimit: 16384 }, async (r, p) => {
    const a = writable(r),
      ids = objectParams.parse(r.params);
    return send(
      p,
      await M.reconcileB2bDropship(
        a,
        ids.link_id,
        ids.id,
        S.b2bDropshipReconcileInput.parse(r.body),
      ),
    );
  });
}
