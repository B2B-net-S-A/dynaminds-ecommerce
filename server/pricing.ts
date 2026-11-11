import type { PoolClient } from 'pg';
import { z } from 'zod';
import { ensure } from './errors';
import { productDeletionsAvailable, productNotDeletedSQL } from './product-deletions';
import { productCatalogsAvailable, assertProductCatalogPriceListInTx } from './product-catalogs';
export const currencies = z.enum(['PLN', 'EUR', 'USD', 'GBP', 'CZK']);
export const priceListInput = z
  .object({
    name: z.string().trim().min(2).max(120),
    currency: currencies,
    fallback: z.boolean().default(false),
    adjustment_bps: z.number().int().min(-9000).max(100000).default(0),
    adjustment_amount: z.number().int().min(-100000000).max(100000000).default(0),
  })
  .strict();
export const priceListEdit = priceListInput
  .omit({ currency: true })
  .extend({ active: z.boolean(), version: z.number().int().positive() })
  .strict();
export const priceItemsInput = z
  .object({
    version: z.number().int().positive(),
    items: z
      .array(
        z
          .object({
            product_id: z.uuid(),
            price: z.number().int().min(0).max(100000000).nullable(),
          })
          .strict(),
      )
      .min(1)
      .max(500),
  })
  .strict();
export async function prices(
  c: PoolClient,
  ids: string[],
  listId: string | undefined,
  tenantId: string,
) {
  const tenant = (await c.query('SELECT currency FROM tenants WHERE id=$1', [tenantId])).rows[0];
  ensure(tenant, 404, 'Nie znaleziono organizacji');
  let list: any = null;
  if (listId) {
    list = (
      await c.query('SELECT * FROM price_lists WHERE id=$1 AND tenant_id=$2 FOR SHARE', [
        listId,
        tenantId,
      ])
    ).rows[0];
    ensure(list, 404, 'Nie znaleziono cennika');
    ensure(list.active, 409, 'Cennik jest nieaktywny');
  }
  const catalogsAvailable = await productCatalogsAvailable(c);
  // A deleted product (225) has no current price: it counts as missing.
  const deletions = await productDeletionsAvailable(c);
  const products = (
    await c.query(
      `SELECT id,sku,price,version,active,kind${catalogsAvailable ? ',catalog_id' : ''} FROM products WHERE id=ANY($1::uuid[]) AND ${productNotDeletedSQL(deletions, 'products')} ORDER BY id FOR SHARE`,
      [ids],
    )
  ).rows;
  ensure(products.length === new Set(ids).size, 404, 'Nie znaleziono produktu');
  if (catalogsAvailable && list) {
    for (const catalogId of new Set<string>(products.map(p => p.catalog_id)))
      await assertProductCatalogPriceListInTx(c, catalogId, list.id);
  }
  const entries = list
    ? (
        await c.query(
          'SELECT product_id,price FROM price_list_items WHERE price_list_id=$1 AND product_id=ANY($2::uuid[])',
          [list.id, ids],
        )
      ).rows
    : [];
  const byId = new Map(entries.map((i) => [i.product_id, i.price]));
  const result = products.map((p) => {
    ensure(p.kind !== 'group', 422, 'Grupa wariantów nie ma ceny sprzedaży');
    const fixed = byId.get(p.id);
    ensure(
      !list || fixed !== undefined || (list.fallback && list.currency === tenant.currency),
      422,
      'Brak ceny SKU ' + p.sku + ' w cenniku; nie przeliczamy walut automatycznie',
    );
    const computed =
      list && fixed === undefined
        ? Number((BigInt(p.price) * BigInt(10000 + list.adjustment_bps) + 5000n) / 10000n) +
          list.adjustment_amount
        : (fixed ?? p.price);
    ensure(
      Number.isSafeInteger(computed) && computed >= 0 && computed <= 100000000,
      422,
      'Cena wynikowa poza zakresem dla SKU ' + p.sku,
    );
    return {
      product_id: p.id,
      sku: p.sku,
      price: computed,
      source: fixed !== undefined ? 'override' : list ? 'rule' : 'catalog',
      product_version: p.version,
    };
  });
  return {
    currency: list?.currency ?? tenant.currency,
    list: list
      ? { id: list.id, name: list.name, currency: list.currency, version: list.version }
      : null,
    items: result,
  };
}
export async function checkPriceList(c: PoolClient, b: { currency: string; fallback: boolean }) {
  const tenant = (
    await c.query(
      "SELECT currency FROM tenants WHERE id=nullif(current_setting('app.tenant_id',true),'')::uuid",
    )
  ).rows[0];
  ensure(
    !b.fallback || b.currency === tenant.currency,
    422,
    'Reguła katalogowa wymaga waluty organizacji. Dla innej waluty podaj ceny SKU.',
  );
}

export const quoteInput = z
  .object({ price_list_id: z.uuid().optional(), product_ids: z.array(z.uuid()).min(1).max(100) })
  .strict();
