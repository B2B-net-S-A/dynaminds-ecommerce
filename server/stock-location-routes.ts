import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { tenantTx } from './db';
import { ensure } from './errors';
import { productDeletionsAvailable, productNotDeletedSQL } from './product-deletions';
import { locationMove, locationCount, locationOperation } from './stock-locations';
export function registerStockLocationRoutes(app: FastifyInstance, readTx: typeof tenantTx = tenantTx) {
  app.get('/api/stock-locations', (req) =>
    readTx(req.actor.tenantId, async (c) => {
      const q = z
        .object({
          warehouse_id: z.uuid(),
          product_id: z.uuid().optional(),
          q: z.string().trim().max(80).default(''),
          limit: z.coerce.number().int().min(1).max(100).default(25),
          after: z.string().max(1024).optional(),
        })
        .parse(req.query);
      ensure(
        (await c.query('SELECT id FROM warehouses WHERE id=$1', [q.warehouse_id])).rowCount,
        404,
        'Nie znaleziono magazynu',
      );
      let cursor: [string, string] | null = null;
      if (q.after) {
        try {
          cursor = z
            .tuple([z.uuid(), z.string().min(1).max(80)])
            .parse(JSON.parse(Buffer.from(q.after, 'base64url').toString()));
        } catch {
          ensure(false, 422, 'Nieprawidłowy kursor lokalizacji');
        }
      }
      const deletions = await productDeletionsAvailable(c);
      const rows = (
        await c.query(
          `SELECT l.*,p.sku,p.name,s.version,coalesce(h.quantity,0)::int AS reserved,(l.quantity-coalesce(h.quantity,0))::int AS available
   FROM stock_locations l JOIN products p ON (p.tenant_id,p.id)=(l.tenant_id,l.product_id) JOIN stock s ON (s.tenant_id,s.warehouse_id,s.product_id)=(l.tenant_id,l.warehouse_id,l.product_id)
   LEFT JOIN LATERAL(SELECT sum(a.quantity-coalesce((to_jsonb(a)->>'consumed_quantity')::integer,0)) AS quantity FROM reservation_locations a JOIN reservations r USING(tenant_id,order_id,product_id,warehouse_id) WHERE (a.tenant_id,a.warehouse_id,a.product_id,a.location)=(l.tenant_id,l.warehouse_id,l.product_id,l.location) AND r.state='active')h ON true
   WHERE l.warehouse_id=$1 AND ($2::uuid IS NULL OR l.product_id=$2) AND ${productNotDeletedSQL(deletions)} AND ($3='' OR starts_with(lower(p.sku),lower($3)) OR starts_with(lower(l.location),lower($3)))
   AND ($4::uuid IS NULL OR (l.product_id,l.location)>($4::uuid,$5::text)) ORDER BY l.product_id,l.location LIMIT $6`,
          [
            q.warehouse_id,
            q.product_id ?? null,
            q.q,
            cursor?.[0] ?? null,
            cursor?.[1] ?? null,
            q.limit + 1,
          ],
        )
      ).rows;
      const more = rows.length > q.limit,
        data = rows.slice(0, q.limit),
        last = data.at(-1);
      return {
        data,
        meta: {
          cursor: more
            ? Buffer.from(JSON.stringify([last.product_id, last.location])).toString('base64url')
            : null,
        },
      };
    }),
  );
  app.get('/api/stock-location-movements', (req) =>
    tenantTx(req.actor.tenantId, async (c) => {
      const q = z.object({ warehouse_id: z.uuid(), product_id: z.uuid() }).parse(req.query);
      return {
        data: (
          await c.query(
            'SELECT id,location,delta,kind,order_id,operation_id,note,created_at FROM stock_location_movements WHERE warehouse_id=$1 AND product_id=$2 ORDER BY created_at DESC,id DESC LIMIT 50',
            [q.warehouse_id, q.product_id],
          )
        ).rows,
      };
    }),
  );
  app.post('/api/stock-location-moves', (req) =>
    tenantTx(req.actor.tenantId, (c) =>
      locationOperation(c, req.actor, locationMove.parse(req.body), 'move'),
    ),
  );
  app.post('/api/stock-location-counts', (req) =>
    tenantTx(req.actor.tenantId, (c) =>
      locationOperation(c, req.actor, locationCount.parse(req.body), 'count'),
    ),
  );
}
