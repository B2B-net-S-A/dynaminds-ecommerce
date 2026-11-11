/**
 * Order actions that raise automation rules v2 events (Uwagi v3 §0 "Zdarzenia"):
 *   POST /api/orders/:id/items/:itemId/missing   body {quantity_missing, client_key?} -> order.item_missing
 *   POST /api/orders/:id/cancel-label                                                 -> shipment.cancelled
 *   POST /api/orders/:id/demo-shipment-status      body {status}                      -> shipment.status_changed
 * Operators and administrators in a user session or with an API key holding orders:write.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { tenantTx } from './db';
import { ensure } from './errors';
import { reportItemMissingInTx } from './order-item-missing';
import { cancelLabelInTx } from './shipment-cancel';
import { simulateDemoShipmentStatusInTx } from './shipment-demo-status';

const params = z.object({ id: z.uuid(), itemId: z.uuid().optional() });

export function registerOrderEventRoutes(app: FastifyInstance, opts: { readOnly: boolean }) {
  const writer = (req: any) => {
    ensure(!opts.readOnly, 423, 'Kopia jest tylko do odczytu');
    ensure(!req.apiScopes || req.apiScopes.includes('orders:write'), 403, 'Klucz API wymaga uprawnienia orders:write');
    ensure(req.actor.role !== 'viewer', 403, 'Konto ma uprawnienia tylko do odczytu');
    return params.parse(req.params);
  };
  app.post('/api/orders/:id/items/:itemId/missing', async (req) => {
    const p = writer(req);
    return tenantTx(req.actor.tenantId, (c) => reportItemMissingInTx(c, req.actor, p.id, p.itemId!, req.body ?? {}));
  });
  app.post('/api/orders/:id/cancel-label', async (req) => {
    const p = writer(req);
    return tenantTx(req.actor.tenantId, (c) => cancelLabelInTx(c, req.actor, p.id));
  });
  app.post('/api/orders/:id/demo-shipment-status', async (req) => {
    const p = writer(req);
    return tenantTx(req.actor.tenantId, (c) => simulateDemoShipmentStatusInTx(c, req.actor, p.id, req.body ?? {}));
  });
}
