import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { tenantTx } from './db';
import { audit, type Actor } from './domain';
import { ensure } from './errors';
import { assertProductsNotDeletedInTx, productDeletionsAvailable, productNotDeletedSQL } from './product-deletions';
import {
  prices,
  checkPriceList,
  priceListInput,
  priceListEdit,
  priceItemsInput,
  quoteInput,
} from './pricing';
export function registerPricingRoutes(app: FastifyInstance) {
  const id = (p: unknown) => z.object({ id: z.uuid() }).parse(p).id;
  const write = (req: any) =>
    ensure(req.actor.role !== 'viewer', 403, 'Konto ma uprawnienia tylko do odczytu');
  app.get('/api/price-lists', (req) =>
    tenantTx(req.actor.tenantId, async (c) => {
      const q = z
        .object({
          after: z.uuid().optional(),
          limit: z.coerce.number().int().min(1).max(100).default(25),
          search: z.string().trim().max(100).default(''),
          active: z.enum(['true', 'false']).optional(),
        })
        .parse(req.query);
      const rows = (
        await c.query(
          "SELECT * FROM price_lists WHERE ($1::uuid IS NULL OR id>$1) AND ($2='' OR strpos(lower(name),lower($2))>0) AND ($3::boolean IS NULL OR active=$3) ORDER BY id LIMIT $4",
          [q.after ?? null, q.search, q.active ?? null, q.limit + 1],
        )
      ).rows;
      return {
        data: rows.slice(0, q.limit),
        meta: { cursor: rows.length > q.limit ? rows[q.limit - 1].id : null },
      };
    }),
  );
  app.post('/api/price-lists', async (req, reply) => {
    write(req);
    const b = priceListInput.parse(req.body);
    return reply.code(201).send(
      await tenantTx(req.actor.tenantId, async (c) => {
        // Birth enrolls the list in the default catalog; take the exclusive
        // catalog lock before any row lock instead of upgrading a shared lock.
        await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`catalog:${req.actor.tenantId}`]);
        await checkPriceList(c, b);
        const row = (
          await c.query(
            'INSERT INTO price_lists(id,tenant_id,name,currency,fallback,adjustment_bps,adjustment_amount) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',
            [
              randomUUID(),
              req.actor.tenantId,
              b.name,
              b.currency,
              b.fallback,
              b.adjustment_bps,
              b.adjustment_amount,
            ],
          )
        ).rows[0];
        await audit(c, req.actor, 'pricing.create', row.id, { currency: b.currency });
        return row;
      }),
    );
  });
  app.patch('/api/price-lists/:id', (req) => {
    write(req);
    const b = priceListEdit.parse(req.body);
    return tenantTx(req.actor.tenantId, async (c) => {
      await c.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))', [`catalog:${req.actor.tenantId}`]);
      const row = (
        await c.query('SELECT * FROM price_lists WHERE id=$1 FOR UPDATE', [id(req.params)])
      ).rows[0];
      ensure(row, 404, 'Nie znaleziono cennika');
      ensure(row.version === b.version, 409, 'Cennik został zmieniony; odśwież dane');
      await checkPriceList(c, { ...b, currency: row.currency });
      const r = (
        await c.query(
          'UPDATE price_lists SET name=$2,active=$3,fallback=$4,adjustment_bps=$5,adjustment_amount=$6,version=version+1,updated_at=now() WHERE id=$1 RETURNING *',
          [row.id, b.name, b.active, b.fallback, b.adjustment_bps, b.adjustment_amount],
        )
      ).rows[0];
      await audit(c, req.actor, 'pricing.edit', row.id, { version: r.version, active: b.active });
      return r;
    });
  });
  app.get('/api/price-lists/:id/items', (req) =>
    tenantTx(req.actor.tenantId, async (c) => {
      const list = (await c.query('SELECT * FROM price_lists WHERE id=$1', [id(req.params)]))
        .rows[0];
      ensure(list, 404, 'Nie znaleziono cennika');
      const q = z
        .object({
          after: z.uuid().optional(),
          limit: z.coerce.number().int().min(1).max(100).default(25),
          search: z.string().trim().max(100).default(''),
        })
        .parse(req.query);
      const deletions = await productDeletionsAvailable(c);
      const rows = (
        await c.query(
          `SELECT i.product_id,i.price,p.sku,p.name FROM price_list_items i JOIN products p ON (p.tenant_id,p.id)=(i.tenant_id,i.product_id) WHERE i.price_list_id=$1 AND ${productNotDeletedSQL(deletions)} AND ($2::uuid IS NULL OR i.product_id>$2) AND ($3='' OR strpos(lower(p.sku||' '||p.name),lower($3))>0) ORDER BY i.product_id LIMIT $4`,
          [list.id, q.after ?? null, q.search, q.limit + 1],
        )
      ).rows;
      return {
        list,
        data: rows.slice(0, q.limit),
        meta: { cursor: rows.length > q.limit ? rows[q.limit - 1].product_id : null },
      };
    }),
  );
  app.put('/api/price-lists/:id/items', (req) => {
    write(req);
    const b = priceItemsInput.parse(req.body);
    ensure(
      new Set(b.items.map((i) => i.product_id)).size === b.items.length,
      422,
      'SKU nie mogą się powtarzać',
    );
    return tenantTx(req.actor.tenantId, (c) =>
      writePriceListItemsInTx(c, req.actor, id(req.params), b.items, b.version),
    );
  });
  app.post('/api/pricing/quote', (req) => {
    const b = quoteInput.parse(req.body);
    return tenantTx(req.actor.tenantId, (c) =>
      prices(c, b.product_ids, b.price_list_id, req.actor.tenantId),
    );
  });
}
/** Native PUT /api/price-lists/:id/items writer (price null removes the SKU
 * price). version null = no optimistic check (Base API has no list version). */
export async function writePriceListItemsInTx(
  c: PoolClient,
  a: Actor,
  listId: string,
  items: { product_id: string; price: number | null }[],
  version: number | null,
) {
  await c.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))', [`catalog:${a.tenantId}`]);
  const row = (await c.query('SELECT * FROM price_lists WHERE id=$1 FOR UPDATE', [listId])).rows[0];
  ensure(row, 404, 'Nie znaleziono cennika');
  ensure(version === null || row.version === version, 409, 'Cennik został zmieniony; odśwież dane');
  const products = (
    await c.query(
      'SELECT id,kind FROM products WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE',
      [items.map((i) => i.product_id)],
    )
  ).rows;
  ensure(products.length === items.length, 404, 'Nie znaleziono produktu');
  await assertProductsNotDeletedInTx(c, products.map((p) => p.id));
  ensure(
    products.every((p) => p.kind !== 'group'),
    422,
    'Grupa wariantów nie ma ceny sprzedaży',
  );
  await c.query(
    'DELETE FROM price_list_items WHERE price_list_id=$1 AND product_id=ANY($2::uuid[])',
    [row.id, items.filter((i) => i.price === null).map((i) => i.product_id)],
  );
  await c.query(
    'INSERT INTO price_list_items(tenant_id,price_list_id,product_id,price) SELECT $1,$2,product_id,price FROM jsonb_to_recordset($3::jsonb) AS x(product_id uuid,price integer) WHERE price IS NOT NULL ON CONFLICT(tenant_id,price_list_id,product_id) DO UPDATE SET price=excluded.price',
    [a.tenantId, row.id, JSON.stringify(items)],
  );
  const r = (
    await c.query(
      'UPDATE price_lists SET version=version+1,updated_at=now() WHERE id=$1 RETURNING *',
      [row.id],
    )
  ).rows[0];
  await audit(c, a, 'pricing.items', row.id, {
    count: items.length,
    version: r.version,
  });
  return r;
}
