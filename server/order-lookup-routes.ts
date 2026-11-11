import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { tenantReadTx } from './db';
import { ensure } from './errors';

/**
 * Address-bar lookups for the web app (Uwagi v3 §8): /zamowienia/<number> needs the order id, and an order
 * opened by id needs its number for the address. Read-only, tenant-scoped (RLS plus an explicit tenant_id).
 */
const numberParams = z.strictObject({
  number: z.string().trim().min(1, 'Podaj numer zamówienia').max(120, 'Numer zamówienia jest za długi'),
});
const idParams = z.strictObject({ id: z.uuid('Nieprawidłowy identyfikator zamówienia') });

function read(req: FastifyRequest) {
  ensure(!req.apiScopes || req.apiScopes.includes('orders:read'), 403, 'Klucz wymaga zakresu orders:read');
}
const columns = 'o.id,o.number,o.status,o.version';
/** version is a bigint, so pg returns it as text, like the order card. */
type OrderRef = { id: string; number: string; status: string; version: string };

export function registerOrderLookupRoutes(app: FastifyInstance) {
  app.get('/api/orders/by-number/:number', async (req) => {
    read(req);
    const { number } = numberParams.parse(req.params);
    const row = await tenantReadTx(req.actor.tenantId, async (c) =>
      (await c.query<OrderRef>(`SELECT ${columns} FROM orders o WHERE o.tenant_id=$1 AND o.number=$2`, [req.actor.tenantId, number]))
        .rows[0],
    );
    ensure(row, 404, `Nie znaleziono zamówienia ${number}`);
    return row;
  });
  app.get('/api/orders/:id/ref', async (req) => {
    read(req);
    const { id } = idParams.parse(req.params);
    const row = await tenantReadTx(req.actor.tenantId, async (c) =>
      (await c.query<OrderRef>(`SELECT ${columns} FROM orders o WHERE o.tenant_id=$1 AND o.id=$2`, [req.actor.tenantId, id])).rows[0],
    );
    ensure(row, 404, 'Nie znaleziono zamówienia');
    return row;
  });
}
