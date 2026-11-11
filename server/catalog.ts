import { assertCatalogAttributesWriteInTx } from './catalog-attributes-transaction';
import { assertProductRulePriceTagsInTx } from './product-rule-price-tags';
import {
  attachProductLogistics,
  ensureProductLogisticsWriteAvailable,
  writeProductLogisticsInTx,
  productLogisticsAvailable,
} from './product-logistics';
import {
  emitCatalogProductEvent,
  emitCatalogProductEvents,
  type CatalogProductEvent,
} from './product-rule-events';
import { randomUUID } from 'node:crypto';
import { assertWmsLegacyQuantityWriteInTx } from './wms-lots';
import type { PoolClient } from 'pg';
import { productCatalogsAvailable, productCatalogOptionsInTx, resolveProductCatalogInTx, assertProductCatalogInTx, assertProductCatalogWarehouseInTx } from './product-catalogs';
import { z } from 'zod';
import { productSchema, catalogFields, audit, type Actor } from './domain';
import { ensure, Problem } from './errors';
import { productSkuSchema } from './product-sku-schema';
import { warehouseInventoryPoliciesAvailable } from './warehouse-inventory-policies';
import { catalogStockControlStrictCatalogInTx } from './catalog-stock-control';
import { warehousePolicyMapSQL, warehousePolicySellableQuantitySQL } from './warehouse-sellability';
import {
  attachProductSkuCapability,
  productSkuAvailable,
  assertProductSkuAvailable,
  resolveProductSkus,
  requireProductSkuAdminInTx,
} from './product-sku';
import { deletedProductIdsInTx, productDeletionsAvailable, productNotDeletedSQL } from './product-deletions';
export type ProductInput = z.infer<typeof productSchema>;
export const editSchema = catalogFields.extend({
  sku: productSkuSchema.optional(),
  version: z.number().int().positive(),
  components: productSchema.shape.components,
});
async function validateDefinition(
  c: PoolClient,
  b: ProductInput | any,
  id?: string,
  options: { preserveComponents?: true } = {},
) {
  ensure(
    (b.kind === 'variant') === Boolean(b.parent_id),
    422,
    'Wariant wymaga grupy nadrzędnej; inne typy nie mają rodzica',
  );
  if (b.parent_id) {
    const p = (await c.query(`SELECT kind FROM products p WHERE id=$1 AND ${productNotDeletedSQL(await productDeletionsAvailable(c))}`, [b.parent_id])).rows[0];
    ensure(p?.kind === 'group', 422, 'Rodzicem wariantu musi być grupa z tej firmy');
    await assertProductCatalogInTx(c, [b.parent_id], b.catalog_id);
  }
  if (!options.preserveComponents)
    ensure(
      b.kind === 'bundle' || b.components.length === 0,
      422,
      'Składniki dostępne tylko dla zestawu',
    );
  if (b.kind === 'bundle' && !options.preserveComponents) {
    ensure(b.components.length > 0, 422, 'Zestaw wymaga składników');
    const ids = b.components.map((r: any) => r.product_id);
    ensure(
      new Set(ids).size === ids.length && !ids.includes(id),
      422,
      'Powtórzony składnik lub zestaw wskazujący siebie',
    );
    const rows = (
      await c.query('SELECT id,kind,active FROM products WHERE id=ANY($1::uuid[])', [ids])
    ).rows;
    ensure(
      rows.length === ids.length &&
        rows.every((p) => p.active && ['simple', 'variant'].includes(p.kind)),
      422,
      'Składniki muszą być aktywnymi produktami fizycznymi tej firmy',
    );
    await assertProductCatalogInTx(c, ids, b.catalog_id);
  }
  for (const image of b.images)
    if (image.startsWith('/api/')) {
      ensure(
        (await c.query('SELECT id FROM product_images WHERE id=$1', [image.split('/').at(-1)]))
          .rowCount,
        422,
        'Zdjęcie nie należy do tej firmy',
      );
    }
}
async function writeComponents(c: PoolClient, a: Actor, id: string, rows: any[]) {
  await c.query('DELETE FROM bundle_components WHERE bundle_id=$1', [id]);
  for (const r of rows)
    await c.query(
      'INSERT INTO bundle_components(tenant_id,bundle_id,product_id,quantity) VALUES($1,$2,$3,$4)',
      [a.tenantId, id, r.product_id, r.quantity],
    );
}
export async function createProduct(
  c: PoolClient,
  a: Actor,
  b: ProductInput,
  options: { deferProductRules?: true; id?: string; birthScopes?: readonly string[] } = {},
) {
  await assertCatalogAttributesWriteInTx(c,b.attributes);
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`catalog:${a.tenantId}`]);
  const catalog = await resolveProductCatalogInTx(c, b.catalog_id);
  const strictCatalog = await catalogStockControlStrictCatalogInTx(c, a, catalog?.id ?? null,
    {scopes:options.birthScopes ?? ['products:write']});
  ensure(!strictCatalog || b.quantity === 0, 422,
    'Utwórz produkt ze stanem 0, a następnie przyjmij towar dokumentem PZ');
  if (b.quantity > 0) await assertWmsLegacyQuantityWriteInTx(c, a);
  await assertProductCatalogWarehouseInTx(c, catalog?.id ?? null, b.warehouse_id);
  await ensureProductLogisticsWriteAvailable(c, b);
  ensure(
    (await c.query('SELECT id FROM warehouses WHERE id=$1', [b.warehouse_id])).rowCount,
    404,
    'Nie znaleziono magazynu',
  );
  ensure(
    ['simple', 'variant'].includes(b.kind) || b.quantity === 0,
    422,
    'Grupa i zestaw nie mają własnego stanu',
  );
  await validateDefinition(c, { ...b, catalog_id: catalog?.id });
  if (b.tags !== undefined) await assertProductRulePriceTagsInTx(c);
  const sku = productSkuSchema.parse(b.sku);
  // Internal frozen import plans allocate their own UUID before any product write.
  const id = options.id === undefined ? randomUUID() : z.uuid().parse(options.id).toLowerCase();
  const p = (
    await c.query(
      `INSERT INTO products(id,tenant_id,sku,name,ean,price,vat,category,kind,parent_id,description,attributes,images,active${catalog ? ',catalog_id' : ''}${b.tags === undefined ? '' : ',tags'}) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14${catalog ? ',$15' : ''}${b.tags === undefined ? '' : catalog ? ',$16' : ',$15'}) RETURNING *`,
      [
        id,
        a.tenantId,
        sku,
        b.name,
        b.ean,
        b.price,
        b.vat,
        b.category,
        b.kind,
        b.parent_id ?? null,
        b.description,
        JSON.stringify(b.attributes),
        JSON.stringify(b.images),
        b.active,
        ...(catalog ? [catalog.id] : []),
        ...(b.tags === undefined ? [] : [b.tags]),
      ],
    )
  ).rows[0];
  if (['simple', 'variant'].includes(b.kind)) {
    await c.query(
      'INSERT INTO stock(tenant_id,warehouse_id,product_id,on_hand,location) VALUES($1,$2,$3,$4,$5)',
      [a.tenantId, b.warehouse_id, id, b.quantity, b.location],
    );
    if (!strictCatalog) await c.query(
      'INSERT INTO stock_movements(id,tenant_id,product_id,warehouse_id,delta,kind,note) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [randomUUID(), a.tenantId, id, b.warehouse_id, b.quantity, 'initial', 'Stan początkowy'],
    );
  }
  await writeComponents(c, a, id, b.components);
  await writeProductLogisticsInTx(c, a, id, b);
  await audit(c, a, 'product.create', id, { kind: b.kind });
  if (!options.deferProductRules) await emitCatalogProductEvent(c, a, id, 'product.created');
  return (await attachProductSkuCapability(c, await attachProductLogistics(c, [p])))[0];
}
export async function editProduct(
  c: PoolClient,
  a: Actor,
  id: string,
  input: z.infer<typeof editSchema>,
  options: { deferProductRules?: true; preserveComponents?: true } = {},
) {
  await assertCatalogAttributesWriteInTx(c,input.attributes);
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`catalog:${a.tenantId}`]);
  const p = (await c.query('SELECT * FROM products WHERE id=$1 FOR UPDATE', [id])).rows[0];
  ensure(p, 404, 'Nie znaleziono produktu');
  // 225: a deleted product is never edited (the delete command edits before its row exists).
  ensure(!(await deletedProductIdsInTx(c, [id])).has(id), 409, 'Produkt został usunięty');
  ensure(p.version === input.version, 409, 'Produkt zmieniono w innym oknie. Odśwież kartę.');
  await ensureProductLogisticsWriteAvailable(c, input);
  const sku = input.sku === undefined ? undefined : productSkuSchema.parse(input.sku);
  if (sku !== undefined) {
    await assertProductSkuAvailable(c);
    const claimed = await resolveProductSkus(c, [sku]);
    ensure(
      claimed.every((code) => code.id === id),
      409,
      'SKU jest zarezerwowane dla innego produktu',
    );
  }
  await validateDefinition(c, { ...p, ...input }, id, options);
  if (input.tags !== undefined) await assertProductRulePriceTagsInTx(c);
  const saved = (
    await c.query(
      'UPDATE products SET name=$1,ean=$2,price=$3,vat=$4,category=$5,description=$6,attributes=$7,images=$8,active=$9,version=version+1' +
        (sku === undefined ? '' : ',sku=$11') +
        (input.tags === undefined ? '' : sku === undefined ? ',tags=$11' : ',tags=$12') +
        ' WHERE id=$10 RETURNING *',
      [
        input.name,
        input.ean,
        input.price,
        input.vat,
        input.category,
        input.description,
        JSON.stringify(input.attributes),
        JSON.stringify(input.images),
        input.active,
        id,
        ...(sku === undefined ? [] : [sku]),
        ...(input.tags === undefined ? [] : [input.tags]),
      ],
    )
  ).rows[0];
  if (!options.preserveComponents) await writeComponents(c, a, id, input.components);
  await writeProductLogisticsInTx(c, a, id, input);
  if (sku !== undefined) await requireProductSkuAdminInTx(c, a);
  await audit(c, a, 'product.update', id, {
    version: saved.version,
    ...(p.sku === saved.sku ? {} : { sku_before: p.sku, sku_after: saved.sku }),
  });
  if (!options.deferProductRules) await emitCatalogProductEvent(c, a, id, 'product.updated');
  return (await attachProductSkuCapability(c, await attachProductLogistics(c, [saved])))[0];
}
export async function productDetail(c: PoolClient, id: string, readOnly = false) {
  const row = (await c.query('SELECT * FROM products WHERE id=$1' + (readOnly ? '' : ' FOR SHARE'), [id])).rows[0];
  ensure(row, 404, 'Nie znaleziono produktu');
  // 225: the card of a deleted product is gone (orders and documents keep their snapshot).
  const deletions = await productDeletionsAvailable(c);
  ensure(!(await deletedProductIdsInTx(c, [id])).has(id), 404, 'Produkt został usunięty');
  const p = (await attachProductSkuCapability(c, await attachProductLogistics(c, [row])))[0];
  return {
    ...p,
    components: (
      await c.query(
        'SELECT b.product_id,b.quantity,p.sku,p.name FROM bundle_components b JOIN products p ON p.tenant_id=b.tenant_id AND p.id=b.product_id WHERE b.bundle_id=$1 ORDER BY p.sku',
        [id],
      )
    ).rows,
    variants: (
      await c.query(
        `SELECT id,sku,name,attributes,active FROM products p WHERE parent_id=$1 AND ${productNotDeletedSQL(deletions)} ORDER BY sku`,
        [id],
      )
    ).rows,
    stock: (
      await c.query(
        'SELECT s.*,w.name AS warehouse_name FROM stock s JOIN warehouses w ON w.id=s.warehouse_id AND w.tenant_id=s.tenant_id WHERE product_id=$1 ORDER BY w.name',
        [id],
      )
    ).rows,
  };
}
export async function listProducts(
  c: PoolClient,
  q: { search: string; warehouse_id?: string; catalog_id?: string; limit: number; after?: string; sellable?: boolean },
  readOnly = false,
) {
  const skuAvailable = await productSkuAvailable(c);
  const catalogsAvailable = await productCatalogsAvailable(c);
  const warehousePolicies = await warehouseInventoryPoliciesAvailable(c);
  const deletions = await productDeletionsAvailable(c);
  const saleStock = warehousePolicySellableQuantitySQL('wp.policy', 'st.available');
  const saleComponent = warehousePolicySellableQuantitySQL('w.policy', 'cs.available');
  if (q.catalog_id) {
    ensure(catalogsAvailable, 503, 'Kopia nie obsługuje katalogów produktów');
    ensure((await productCatalogOptionsInTx(c))?.catalogs.some(p => p.id === q.catalog_id), 404, 'Nie znaleziono katalogu');
  }
  const data = (
    await c.query(
      `${warehousePolicyMapSQL(warehousePolicies, {warehouseParam: 2})} SELECT p.*,CASE WHEN p.kind='bundle' THEN coalesce(b.available,0) ELSE coalesce(s.available,0) END::int AS available,coalesce(s.on_hand,0)::int AS on_hand,coalesce(s.reserved,0)::int AS reserved
  FROM products p
  LEFT JOIN LATERAL(SELECT sum(st.on_hand) AS on_hand,sum(st.reserved) AS reserved,sum(${saleStock}) AS available FROM stock st JOIN warehouse_policy_map wp ON (wp.tenant_id,wp.id)=(st.tenant_id,st.warehouse_id) WHERE st.product_id=p.id AND ($2::uuid IS NULL OR st.warehouse_id=$2))s ON true
  LEFT JOIN LATERAL(SELECT sum(v.available) AS available FROM (SELECT w.id,CASE WHEN bool_and(coalesce(cp.active,false)) THEN min(floor(${saleComponent}::numeric/bc.quantity)) ELSE 0 END AS available FROM warehouse_policy_map w CROSS JOIN bundle_components bc JOIN products cp ON cp.id=bc.product_id AND cp.tenant_id=bc.tenant_id LEFT JOIN stock cs ON cs.product_id=bc.product_id AND cs.warehouse_id=w.id AND cs.tenant_id=bc.tenant_id WHERE bc.bundle_id=p.id AND ($2::uuid IS NULL OR w.id=$2) GROUP BY w.id)v)b ON p.kind='bundle'
  WHERE (p.name ILIKE $1 OR p.sku ILIKE $1 OR coalesce(p.ean,'') ILIKE $1 ${skuAvailable ? 'OR EXISTS(SELECT 1 FROM product_sku_aliases a WHERE (a.tenant_id,a.product_id)=(p.tenant_id,p.id) AND a.sku ILIKE $1)' : ''}) AND ($3::uuid IS NULL OR p.id>$3) AND (NOT $5::boolean OR (p.active AND p.kind<>'group')) AND ${productNotDeletedSQL(deletions)} ${catalogsAvailable ? 'AND ($6::uuid IS NULL OR p.catalog_id=$6)' : ''} ORDER BY p.id LIMIT $4${readOnly ? '' : ' FOR SHARE OF p'}`,
      [`%${q.search}%`, q.warehouse_id ?? null, q.after ?? null, q.limit + 1, q.sellable ?? false, ...(catalogsAvailable ? [q.catalog_id ?? null] : [])],
    )
  ).rows;
  const more = data.length > q.limit;
  if (more) data.pop();
  const attached = await attachProductSkuCapability(c, await attachProductLogistics(c, data));
  const available =
    attached[0]?.product_logistics_available ?? (await productLogisticsAvailable(c));
  return {
    data: attached,
    meta: {
      has_more: more,
      cursor: more ? data.at(-1).id : null,
      product_logistics_available: available,
      product_sku_edit_available: attached[0]?.product_sku_edit_available ?? skuAvailable,
    },
  };
}
export function parseCsv(text: string): Record<string, string>[] {
  ensure(text.length <= 500000, 422, 'CSV przekracza 500 kB');
  const first = text.replace(/^\uFEFF/, '').split(/\r?\n/, 1)[0],
    delim = first.includes(';') ? ';' : ',';
  const rows: string[][] = [];
  let row: string[] = [],
    value = '',
    quoted = false,
    closed = false;
  text = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          value += '"';
          i++;
        } else {
          quoted = false;
          closed = true;
        }
      } else value += ch;
      continue;
    }
    if (ch === '"') {
      ensure(value.length === 0 && !closed, 422, 'Nieprawidłowy cudzysłów CSV');
      quoted = true;
    } else if (ch === delim) {
      row.push(value);
      value = '';
      closed = false;
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(value);
      if (row.some(Boolean)) rows.push(row);
      row = [];
      value = '';
      closed = false;
    } else {
      ensure(!closed, 422, 'Tekst po zamknięciu pola CSV');
      value += ch;
    }
  }
  ensure(!quoted, 422, 'Niezamknięte pole CSV');
  row.push(value);
  if (row.some(Boolean)) rows.push(row);
  const header = rows.shift()?.map((s) => s.trim());
  ensure(
    header &&
      new Set(header).size === header.length &&
      ['sku', 'name', 'price'].every((k) => header.includes(k)),
    422,
    'CSV wymaga unikalnych nagłówków sku, name, price',
  );
  const allowed = [
    'sku',
    'name',
    'price',
    'vat',
    'category',
    'ean',
    'kind',
    'parent_sku',
    'attributes',
    'components',
    'description',
    'images',
    'quantity',
    'location',
    'active',
  ];
  ensure(
    header.every((h) => allowed.includes(h)),
    422,
    'CSV zawiera nieznaną kolumnę',
  );
  ensure(rows.length > 0 && rows.length <= 500, 422, 'CSV wymaga od 1 do 500 produktów');
  return rows.map((r, i) => {
    ensure(r.length === header.length, 422, `Wiersz ${i + 2}: błędna liczba kolumn`);
    return Object.fromEntries(header.map((k, j) => [k, r[j]]));
  });
}
export function csvMoney(s: string) {
  ensure(
    /^\d+(?:[.,]\d{1,2})?$/.test(s),
    422,
    'Cena wymaga kwoty brutto z maksymalnie dwoma miejscami',
  );
  const [a, b = ''] = s.replace(',', '.').split('.');
  const n = Number(a) * 100 + Number(b.padEnd(2, '0'));
  ensure(Number.isSafeInteger(n) && n <= 100000000, 422, 'Cena poza zakresem');
  return n;
}
export async function previewCsv(c: PoolClient, a: Actor, warehouse: string, text: string, catalogId?: string) {
  await c.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))', [
    `catalog:${a.tenantId}`,
  ]);
  const catalog = await resolveProductCatalogInTx(c, catalogId);
  await assertProductCatalogWarehouseInTx(c, catalog?.id ?? null, warehouse);
  ensure(
    (await c.query('SELECT id FROM warehouses WHERE id=$1', [warehouse])).rowCount,
    404,
    'Nie znaleziono magazynu',
  );
  const raw = parseCsv(text).map<Record<string, string>>((r) => ({
      ...r,
      sku: r.sku.trim(),
      parent_sku: r.parent_sku?.trim(),
      price: r.price.trim(),
    })),
    errors: { row: number; message: string }[] = [],
    rows: any[] = [];
  const existing = await resolveProductSkus(
    c,
    raw.flatMap((r) => [
      r.sku,
      r.parent_sku ?? '',
      ...(() => {
        try {
          return JSON.parse(r.components || '[]').map((v: any) => v.sku);
        } catch {
          return [];
        }
      })(),
    ]),
  );
  const recipes = (
    await c.query(
      'SELECT b.bundle_id,p.sku,b.product_id,b.quantity FROM bundle_components b JOIN products p ON p.id=b.product_id AND p.tenant_id=b.tenant_id WHERE b.bundle_id=ANY($1::uuid[])',
      [existing.filter((p) => raw.some((r) => r.sku === p.matched_sku)).map((p) => p.id)],
    )
  ).rows;
  const relatedIds = [
    ...new Set([
      ...existing.map((p) => p.parent_id).filter(Boolean),
      ...recipes.map((p) => p.product_id),
    ]),
  ];
  const related = (await c.query('SELECT * FROM products WHERE id=ANY($1::uuid[])', [relatedIds]))
    .rows;
  for (const p of related)
    if (!existing.some((v) => v.id === p.id)) existing.push({ ...p, matched_sku: p.sku });
  for (const p of existing)
    if (p.parent_id) p.parent_sku = existing.find((v) => v.id === p.parent_id)?.sku ?? null;
  if (catalog) await assertProductCatalogInTx(c, [...new Set(existing.map(p => p.id))], catalog.id);
  const seen = new Set<string>();
  const seenProducts = new Set<string>();
  const deleted = await deletedProductIdsInTx(c, existing.map((p) => p.id));
  for (const [i, r] of raw.entries())
    try {
      ensure(['', 'true', 'false'].includes(r.active ?? ''), 422, 'active wymaga true lub false');
      ensure(/^\d*$/.test(r.quantity ?? ''), 422, 'quantity wymaga nieujemnej liczby całkowitej');
      const old = existing.find((p) => p.matched_sku === r.sku),
        kind = r.kind || old?.kind || 'simple',
        parentSku = r.parent_sku ?? old?.parent_sku ?? null;
      ensure(!old || !deleted.has(old.id), 409, 'Produkt został usunięty; jego SKU pozostaje zarezerwowane');
      const components =
        r.components === undefined
          ? recipes
              .filter((p) => p.bundle_id === old?.id)
              .map((p) => ({ sku: p.sku, quantity: p.quantity }))
          : JSON.parse(r.components || '[]');
      ensure(Array.isArray(components) && components.length <= 100, 422, 'Nieprawidłowe składniki');
      const symbols = z
        .array(
          z.object({
            sku: z.string().min(1).max(80),
            quantity: z.number().int().min(1).max(100000),
          }),
        )
        .parse(components);
      const values = {
        ...old,
        ...r,
        ean: r.ean ?? old?.ean ?? '',
        price: csvMoney(r.price),
        vat: Number(r.vat ?? old?.vat ?? 23),
        quantity: Number(r.quantity || 0),
        kind,
        warehouse_id: warehouse,
        ...(catalog ? { catalog_id: catalog.id } : {}),
        attributes:
          r.attributes === undefined ? (old?.attributes ?? {}) : JSON.parse(r.attributes || '{}'),
        images: r.images === undefined ? (old?.images ?? []) : JSON.parse(r.images || '[]'),
        active: r.active === undefined ? (old?.active ?? true) : r.active !== 'false',
        parent_id: kind === 'variant' ? randomUUID() : undefined,
        components: symbols.map((v) => ({ product_id: randomUUID(), quantity: v.quantity })),
      };
      // An existing code is import identity, not a request to rewrite a legacy SKU.
      const b = old
        ? { ...productSchema.omit({ sku: true }).parse(values), sku: r.sku }
        : productSchema.parse(values);
      ensure(!seen.has(b.sku), 422, 'Powtórzony SKU w pliku');
      seen.add(b.sku);
      ensure(
        !old || !seenProducts.has(old.id),
        422,
        'Kilka kodów w pliku wskazuje ten sam produkt; pozostaw jeden wiersz',
      );
      if (old) seenProducts.add(old.id);
      ensure(!old || old.kind === b.kind, 422, 'Nie można zmienić typu istniejącego SKU');
      ensure(
        !old || b.quantity === 0,
        422,
        'Stan początkowy tylko dla nowych SKU; użyj korekty magazynowej',
      );
      ensure(
        ['simple', 'variant'].includes(b.kind) || b.quantity === 0,
        422,
        'Grupa i zestaw nie mają własnego stanu',
      );
      if (old && b.kind === 'variant')
        ensure(
          existing.some(
            (p) => p.id === old.parent_id && (p.matched_sku === parentSku || p.sku === parentSku),
          ),
          422,
          'Nie można zmienić rodzica wariantu',
        );
      rows.push({
        ...b,
        parent_sku: parentSku || null,
        component_skus: symbols,
        operation: old ? 'update' : 'create',
        ...(old
          ? {
              resolved_product_id: old.id,
              current_sku: old.sku,
              matched_historical_sku: old.sku !== b.sku,
            }
          : {}),
        row: i + 2,
      });
    } catch (e) {
      errors.push({
        row: i + 2,
        message:
          e instanceof Problem
            ? e.message
            : e instanceof z.ZodError
              ? e.issues.map((v) => `${v.path.join('.')}: ${v.message}`).join(';')
              : 'Nieprawidłowy JSON',
      });
    }
  const all = new Map<string, any>();
  for (const p of existing) {
    all.set(p.sku, p);
    all.set(p.matched_sku, p);
  }
  for (const r of rows) all.set(r.sku, r);
  for (const r of rows)
    try {
      ensure(
        (r.kind === 'variant') === Boolean(r.parent_sku),
        422,
        'Wariant wymaga parent_sku; pozostałe typy nie mają rodzica',
      );
      if (r.parent_sku)
        ensure(all.get(r.parent_sku)?.kind === 'group', 422, 'Nie znaleziono grupy rodzica');
      ensure(
        r.kind === 'bundle' || r.component_skus.length === 0,
        422,
        'Składniki tylko w zestawie',
      );
      if (r.kind === 'bundle')
        ensure(
          r.component_skus.length > 0 &&
            new Set(
              r.component_skus.map(
                (v: any) => all.get(v.sku)?.id ?? all.get(v.sku)?.resolved_product_id ?? v.sku,
              ),
            ).size === r.component_skus.length &&
            r.component_skus.every(
              (v: any) =>
                ['simple', 'variant'].includes(all.get(v.sku)?.kind) && all.get(v.sku)?.active,
            ),
          422,
          'Nieznany, powtórzony lub niefizyczny składnik',
        );
      for (const image of r.images)
        if (image.startsWith('/api/'))
          ensure(
            (await c.query('SELECT id FROM product_images WHERE id=$1', [image.split('/').at(-1)]))
              .rowCount,
            422,
            'Nieznane zdjęcie tej firmy',
          );
    } catch (e) {
      errors.push({ row: r.row, message: (e as Error).message });
    }
  if (errors.length)
    return {
      valid: false,
      errors,
      rows: rows.map((r) => ({
        sku: r.sku,
        name: r.name,
        kind: r.kind,
        operation: r.operation,
        current_sku: r.current_sku,
        matched_historical_sku: r.matched_historical_sku ?? false,
        price: r.price,
        row: r.row,
      })),
      id: null,
    };
  const id = randomUUID(),
    observed = Object.fromEntries(
      existing.flatMap((p) =>
        [...new Set([p.sku, p.matched_sku])].map((code) => [
          code,
          { id: p.id, version: p.version },
        ]),
      ),
    );
  await c.query(
    "INSERT INTO catalog_imports(id,tenant_id,warehouse_id,status,rows,observed) VALUES($1,$2,$3,'preview',$4,$5)",
    [id, a.tenantId, warehouse, JSON.stringify(rows), JSON.stringify(observed)],
  );
  await audit(c, a, 'catalog.import.preview', id, { rows: rows.length });
  return {
    valid: true,
    errors: [],
    id,
    rows: rows.map((r) => ({
      sku: r.sku,
      name: r.name,
      kind: r.kind,
      operation: r.operation,
      current_sku: r.current_sku,
      matched_historical_sku: r.matched_historical_sku ?? false,
      price: r.price,
      row: r.row,
    })),
  };
}
export async function applyCsv(c: PoolClient, a: Actor, id: string) {
  const batch = (await c.query('SELECT * FROM catalog_imports WHERE id=$1 FOR UPDATE', [id]))
    .rows[0];
  ensure(batch, 404, 'Nie znaleziono podglądu');
  if (batch.status === 'applied') return { applied: true, reused: true, count: batch.rows.length };
  // Catalog writers serialize per tenant; orders hold a shared lock and remain concurrent.
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`catalog:${a.tenantId}`]);
  const catalog = await resolveProductCatalogInTx(c, batch.rows[0]?.catalog_id);
  await assertProductCatalogWarehouseInTx(c, catalog?.id ?? null, batch.warehouse_id);
  const skus = [
    ...new Set<string>(
      batch.rows.flatMap((r: any) => [
        r.sku,
        r.parent_sku ?? '',
        ...r.component_skus.map((v: any) => v.sku),
      ]),
    ),
  ].sort();
  const resolved = await resolveProductSkus(c, skus);
  const locked = (
    await c.query('SELECT * FROM products WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE', [
      [...new Set(resolved.map((p) => p.id))],
    ])
  ).rows;
  const existing = resolved.map((p) => ({
    ...locked.find((v) => v.id === p.id),
    matched_sku: p.matched_sku,
  }));
  if (catalog) {
    ensure(batch.rows.every((r: any) => !r.catalog_id || r.catalog_id === catalog.id), 409, 'Podgląd wskazuje różne katalogi');
    await assertProductCatalogInTx(c, [...new Set(existing.map(p => p.id))], catalog.id);
  }
  for (const sku of skus) {
    const observed = batch.observed[sku],
      now = existing.find((p) => p.matched_sku === sku);
    ensure(
      observed ? now?.id === observed.id && now?.version === observed.version : !now,
      409,
      'Katalog zmienił się od podglądu. Wczytaj CSV ponownie.',
    );
  }
  const bySku = new Map<string, any>();
  for (const p of existing) {
    bySku.set(p.sku, p);
    bySku.set(p.matched_sku, p);
  }
  const productEvents: CatalogProductEvent[] = [];
  let created = 0,
    updated = 0;
  const rank: Record<string, number> = { group: 0, simple: 1, variant: 2, bundle: 3 };
  for (const row of [...batch.rows].sort(
    (a, b) => rank[a.kind] - rank[b.kind] || a.sku.localeCompare(b.sku),
  )) {
    const old = bySku.get(row.sku);
    const values = {
      ...row,
      ...(catalog ? { catalog_id: catalog.id } : {}),
      parent_id: row.parent_sku ? bySku.get(row.parent_sku)?.id : undefined,
      components: row.component_skus.map((v: any) => ({
        product_id: bySku.get(v.sku)?.id,
        quantity: v.quantity,
      })),
    };
    const b = old
      ? { ...productSchema.omit({ sku: true }).parse(values), sku: row.sku }
      : productSchema.parse(values);
    let p;
    if (old) {
      // Import identity follows the claimed alias. The file is not a request to rename SKU.
      const { sku: _incomingSku, ...values } = b;
      p = await editProduct(c, a, old.id, editSchema.parse({ ...values, version: old.version }), {
        deferProductRules: true,
      });
      updated++;
    } else {
      p = await createProduct(c, a, b, { deferProductRules: true });
      created++;
    }
    bySku.set(b.sku, p);
    productEvents.push({
      product_id: p.id,
      event: old ? 'product.updated' : 'product.created',
      cause_id: randomUUID(),
    });
  }
  await emitCatalogProductEvents(c, a, productEvents);
  await c.query("UPDATE catalog_imports SET status='applied',applied_at=now() WHERE id=$1", [id]);
  await audit(c, a, 'catalog.import.apply', id, { created, updated });
  return { applied: true, reused: false, count: batch.rows.length, created, updated };
}
