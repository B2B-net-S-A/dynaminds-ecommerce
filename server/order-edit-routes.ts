import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { tenantTx } from './db';
import { ensure } from './errors';
import {
  orderCustomerInput,
  orderItemAddInput,
  orderItemQuantityInput,
  orderItemRemoveInput,
  updateOrderCustomerInTx,
  addOrderItemInTx,
  updateOrderItemInTx,
  removeOrderItemInTx,
} from './order-edit';
import { actorDisplayName, registerOrderSectionRoutes } from './order-sections-routes';

const orderParams = z.strictObject({ id: z.uuid('Nieprawidłowy identyfikator zamówienia') });
const itemParams = orderParams.extend({ itemId: z.uuid('Nieprawidłowy identyfikator pozycji') });
function write(req: FastifyRequest) {
  ensure(req.actor.role !== 'viewer', 403, 'Konto ma uprawnienia tylko do odczytu');
  ensure(!req.apiScopes || req.apiScopes.includes('orders:write'), 403, 'Klucz wymaga zakresu orders:write');
}

/** Operator edit of a not yet fulfilled order: buyer data and sale lines. */
export function registerOrderEditRoutes(app: FastifyInstance) {
  app.patch('/api/orders/:id/customer', async (req) => {
    write(req);
    const { id } = orderParams.parse(req.params);
    const b = orderCustomerInput.parse(req.body);
    const name = await actorDisplayName(req.actor);
    return tenantTx(req.actor.tenantId, (c) => updateOrderCustomerInTx(c, req.actor, id, b, name));
  });
  registerOrderSectionRoutes(app);
  app.post('/api/orders/:id/items', async (req) => {
    write(req);
    const { id } = orderParams.parse(req.params);
    const b = orderItemAddInput.parse(req.body);
    return tenantTx(req.actor.tenantId, (c) => addOrderItemInTx(c, req.actor, id, b));
  });
  app.patch('/api/orders/:id/items/:itemId', async (req) => {
    write(req);
    const { id, itemId } = itemParams.parse(req.params);
    const b = orderItemQuantityInput.parse(req.body);
    return tenantTx(req.actor.tenantId, (c) => updateOrderItemInTx(c, req.actor, id, itemId, b));
  });
  // DELETE carries the version in the query string; a body on DELETE is not portable.
  app.delete('/api/orders/:id/items/:itemId', async (req) => {
    write(req);
    const { id, itemId } = itemParams.parse(req.params);
    const b = orderItemRemoveInput.parse(req.query);
    return tenantTx(req.actor.tenantId, (c) => removeOrderItemInTx(c, req.actor, id, itemId, b));
  });
}
