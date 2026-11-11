/** Native port of the Base inventory family: 220 sidecars + the existing
 * warehouse/product/stock domain, 224 category IDs over the native PIM categories
 * (read through the owner functions of 224 only). Writes use the legacy delta writer and the
 * native correction duty (credential custody re-verified at COMMIT); the PIM
 * methods use the native product and price-list writers. */
import type { Pool, PoolClient } from 'pg';
import type { Actor } from './domain';
import { Problem, ensure } from './errors';
import { tenantTx, tenantReadTx } from './db';
import { parseBaseWireId, type BaseWireJson } from './base-wire-codec';
import { adjustLegacyStockInTx } from './inventory';
import { captureInventoryCorrectionActor, enlistInventoryLegacyAdjustmentInTx } from './inventory-correction';
import { assertWmsLegacyQuantityWriteInTx, wmsLotsPolicyInTx } from './wms-lots';
import { catalogStockControlStrictCatalogInTx } from './catalog-stock-control';
import { productCatalogOptionsInTx } from './product-catalogs';
import { createProduct, editProduct, editSchema } from './catalog';
import { productNotDeletedSQL } from './product-deletions';
import { deleteProductInTx } from './product-deletion-command';
import { productSchema } from './domain';
import { writePriceListItemsInTx } from './pricing-routes';
import { createBaseWireInventoryService, BASE_WIRE_BASE_PRICE_GROUP_ID, BASE_WIRE_INVENTORY_PIM_METHODS, type BaseWireInventoryNative, type BaseWireInventoryProduct, type BaseWireInventoryStock, type BaseWireInventoryListRow } from './base-wire-inventory';
import { createBaseWireInventoryPimService, type BaseWireInventoryPimNative } from './base-wire-inventory-pim';

function publicNumber(raw: unknown): number {
  ensure(typeof raw === 'string' && /^[1-9][0-9]*$/.test(raw) && BigInt(raw) <= BigInt(Number.MAX_SAFE_INTEGER), 503, 'Brak trwałej tożsamości Base; wymagany poprawny bootstrap 220');
  return parseBaseWireId(Number(raw), false);
}
/** Current native category ($2 = catalog) through the 224 owner reader; without 224 an empty join. */
const categoryJoin = (categories: boolean) => categories ? 'LEFT JOIN public.base_wire224_product_categories($2) pc ON pc.product_id=p.id'
  : 'LEFT JOIN (SELECT NULL::uuid AS product_id,NULL::bigint AS category_public_id) pc ON false';
const productSql = (where: string, categories: boolean, deletions: boolean) => `SELECT p.id,s.public_id::text AS public_id,p.kind,p.parent_id,ps.public_id::text AS parent_public_id,p.sku,p.ean,p.vat,p.tags,p.name,p.description,p.images,pc.category_public_id::text AS category_public_id,
 coalesce((SELECT jsonb_agg(jsonb_build_object('warehouse_public_id',ws.public_id::text,'on_hand',st.on_hand,'reserved',st.reserved,'location',st.location) ORDER BY ws.public_id,st.warehouse_id)
  FROM stock st LEFT JOIN base_wire220_warehouse_ids ws ON(ws.tenant_id,ws.local_id)=(st.tenant_id,st.warehouse_id) WHERE(st.tenant_id,st.product_id)=(p.tenant_id,p.id)),'[]') AS stock,
 coalesce((SELECT jsonb_agg(jsonb_build_object('public_id',bs.public_id::text,'quantity',b.quantity) ORDER BY bs.public_id,b.product_id)
  FROM bundle_components b LEFT JOIN base_wire220_product_ids bs ON(bs.tenant_id,bs.local_id)=(b.tenant_id,b.product_id) WHERE(b.tenant_id,b.bundle_id)=(p.tenant_id,p.id)),'[]') AS bundle,
 coalesce((SELECT jsonb_agg(jsonb_build_object('locale',t.locale,'name',t.name,'description',t.description) ORDER BY t.locale)
  FROM product_translations t WHERE(t.tenant_id,t.product_id)=(p.tenant_id,p.id)),'[]') AS translations
 FROM base_wire220_product_ids s JOIN products p ON(p.tenant_id,p.id)=(s.tenant_id,s.local_id)
 LEFT JOIN base_wire220_product_ids ps ON(ps.tenant_id,ps.local_id)=(p.tenant_id,p.parent_id)
 ${categoryJoin(categories)}
 WHERE s.tenant_id=$1 AND p.catalog_id=$2 AND ${productNotDeletedSQL(deletions)} AND ${where} ORDER BY s.public_id`;
function product(row: Record<string, any>): BaseWireInventoryProduct {
  ensure(row.parent_id === null || row.parent_public_id !== null, 503, 'Brak trwałej tożsamości Base; wymagany poprawny bootstrap 220');
  return { id: row.id, public_id: publicNumber(row.public_id), kind: row.kind, parent_public_id: row.parent_id === null ? null : publicNumber(row.parent_public_id),
    sku: row.sku, ean: row.ean, vat: row.vat, tags: row.tags ?? [], name: row.name, description: row.description,
    images: (Array.isArray(row.images) ? row.images : []).filter((x: unknown): x is string => typeof x === 'string'),
    stock: row.stock.map((s: Record<string, any>): BaseWireInventoryStock => ({ warehouse_public_id: publicNumber(s.warehouse_public_id), on_hand: s.on_hand, reserved: s.reserved, location: s.location })),
    bundle: row.bundle.map((b: Record<string, any>) => ({ public_id: publicNumber(b.public_id), quantity: b.quantity })),
    category_public_id: row.category_public_id === null ? null : publicNumber(row.category_public_id),
    translations: row.translations.map((t: Record<string, any>) => ({ locale: t.locale, name: t.name, description: t.description })) };
}
const stockTotal = `(SELECT coalesce(sum(st.on_hand),0) FROM stock st WHERE(st.tenant_id,st.product_id)=(p.tenant_id,p.id))`;
const listSql = (descending: boolean, categories: boolean, deletions: boolean) => `SELECT s.public_id::text AS public_id,p.parent_id,ps.public_id::text AS parent_public_id,p.sku,p.ean,p.name,
 coalesce((SELECT jsonb_agg(jsonb_build_object('warehouse_public_id',ws.public_id::text,'on_hand',st.on_hand) ORDER BY ws.public_id,st.warehouse_id)
  FROM stock st LEFT JOIN base_wire220_warehouse_ids ws ON(ws.tenant_id,ws.local_id)=(st.tenant_id,st.warehouse_id) WHERE(st.tenant_id,st.product_id)=(p.tenant_id,p.id)),'[]') AS stock
 FROM base_wire220_product_ids s JOIN products p ON(p.tenant_id,p.id)=(s.tenant_id,s.local_id)
 LEFT JOIN base_wire220_product_ids ps ON(ps.tenant_id,ps.local_id)=(p.tenant_id,p.parent_id)
 ${categoryJoin(categories)}
 WHERE s.tenant_id=$1 AND p.catalog_id=$2 AND ${productNotDeletedSQL(deletions)} AND($3::bigint IS NULL OR s.public_id=$3) AND($4::text IS NULL OR p.ean=$4) AND($5::text IS NULL OR p.sku=$5)
  AND($6::text IS NULL OR strpos(lower(p.name),lower($6))>0) AND($7::boolean OR p.kind<>'variant')
  AND($8::bigint IS NULL OR ${stockTotal}>=$8) AND($9::bigint IS NULL OR ${stockTotal}<=$9) AND($12::bigint IS NULL OR pc.category_public_id=$12)
 ORDER BY s.public_id ${descending ? 'DESC' : 'ASC'} LIMIT $10::bigint OFFSET($11::bigint-1)*$10::bigint`;
function listRow(row: Record<string, any>): BaseWireInventoryListRow {
  ensure(row.parent_id === null || row.parent_public_id !== null, 503, 'Brak trwałej tożsamości Base; wymagany poprawny bootstrap 220');
  return { public_id: publicNumber(row.public_id), parent_public_id: row.parent_id === null ? null : publicNumber(row.parent_public_id), sku: row.sku, ean: row.ean, name: row.name,
    stock: row.stock.map((s: Record<string, any>) => ({ warehouse_public_id: publicNumber(s.warehouse_public_id), on_hand: s.on_hand })) };
}
async function publicIds(c: PoolClient, table: string, tenantId: string, locals: string[]) {
  const rows = (await c.query(`SELECT local_id,public_id::text AS public_id FROM ${table} WHERE tenant_id=$1 AND local_id=ANY($2::uuid[])`, [tenantId, locals])).rows;
  return new Map(rows.map(r => [r.local_id as string, publicNumber(r.public_id)]));
}
const idempotencyKey = (clientKey: string) => 'base_wire220:' + clientKey;

export function createBaseWireInventoryNative(c: PoolClient, actor: Actor, credential?: string, opts: { categories?: boolean; deletions?: boolean } = {}): BaseWireInventoryNative {
  const categories = opts.categories === true;
  // 225 deleted products are absent from every Base inventory read (startup capability).
  const deletions = opts.deletions === true;
  let custody: ReturnType<typeof captureInventoryCorrectionActor> | undefined;
  // Same custody as the native /api/v1 Bearer route; legacy=true like POST /inventory/adjust.
  const correctionActor = () => custody ??= captureInventoryCorrectionActor({
    actor: { tenantId: actor.tenantId, userId: actor.userId, role: actor.role, apiKeyId: actor.apiKeyId },
    currentUser: { api_key_id: actor.apiKeyId }, apiScopes: [], headers: { authorization: 'Bearer ' + credential }, cookies: {},
  }, '', true);
  return {
    async warehouses() {
      const rows = (await c.query('SELECT w.id,w.name,w.code,s.public_id::text AS public_id FROM warehouses w LEFT JOIN base_wire220_warehouse_ids s ON(s.tenant_id,s.local_id)=(w.tenant_id,w.id) WHERE w.tenant_id=$1 ORDER BY s.public_id,w.id', [actor.tenantId])).rows;
      return rows.map(r => ({ id: r.id, public_id: publicNumber(r.public_id), name: r.name, code: r.code }));
    },
    async stockEditable() { return !(await wmsLotsPolicyInTx(c)).enabled; },
    async catalogs() {
      // Same heads as GET /api/product-catalogs/options.
      const options = await productCatalogOptionsInTx(c);
      ensure(options, 503, 'Kopia nie zawiera katalogów produktów');
      const heads = options.catalogs;
      const ids = await publicIds(c, 'base_wire220_catalog_ids', actor.tenantId, heads.map(h => h.id));
      const warehouses = await publicIds(c, 'base_wire220_warehouse_ids', actor.tenantId, heads.flatMap(h => h.warehouse_ids ?? []));
      const groups = await publicIds(c, 'base_wire220_price_group_ids', actor.tenantId, heads.flatMap(h => h.price_list_ids ?? []));
      ensure(![...groups.values()].includes(BASE_WIRE_BASE_PRICE_GROUP_ID), 503, 'Cennik ma identyfikator grupy podstawowej Base');
      const known = (map: Map<string, number>, local: string) => { const n = map.get(local); ensure(n !== undefined, 503, 'Brak trwałej tożsamości Base; wymagany poprawny bootstrap 220'); return n; };
      const sorted = (xs: number[]) => [...xs].sort((x, y) => x - y);
      return heads.map(h => ({ public_id: known(ids, h.id), name: h.name, is_default: h.is_default === true, languages: [...(h.languages ?? [])], default_language: h.default_language,
        warehouse_public_ids: sorted((h.warehouse_ids ?? []).map((w: string) => known(warehouses, w))), price_group_public_ids: sorted((h.price_list_ids ?? []).map((g: string) => known(groups, g))) }))
        .sort((x, y) => x.public_id - y.public_id);
    },
    async productList(catalogId, q) {
      ensure(categories || q.category === null, 503, 'Kategorie Base wymagają migracji 224');
      return (await c.query(listSql(q.descending, categories, deletions), [actor.tenantId, catalogId, q.id, q.ean, q.sku, q.name, q.include_variants, q.stock_from, q.stock_to, q.page_size, q.page, q.category])).rows.map(listRow);
    },
    async catalog(publicId) {
      const rows = (await c.query('SELECT local_id FROM base_wire220_catalog_ids WHERE tenant_id=$1 AND public_id=$2::bigint AND local_id IS NOT NULL', [actor.tenantId, publicId])).rows;
      ensure(rows.length <= 1, 503, 'Niespójna mapa katalogów Base');
      return rows[0]?.local_id ?? null;
    },
    async products(catalogId, publicIds) {
      return (await c.query(productSql('s.public_id=ANY($3::bigint[])', categories, deletions), [actor.tenantId, catalogId, publicIds])).rows.map(product);
    },
    async variants(catalogId, parentIds) {
      return (await c.query(productSql("p.kind='variant' AND p.parent_id=ANY($3::uuid[])", categories, deletions), [actor.tenantId, catalogId, parentIds])).rows.map(product);
    },
    async allocateCategories() {
      ensure(categories, 503, 'Kategorie Base wymagają migracji 224');
      await c.query('SELECT public.base_wire224_allocate_categories()');
    },
    async categories(catalogId) {
      ensure(categories, 503, 'Kategorie Base wymagają migracji 224');
      const rows = (await c.query('SELECT public_id::text AS public_id,parent_id,parent_public_id::text AS parent_public_id,name FROM public.base_wire224_categories($1) ORDER BY public_id', [catalogId])).rows;
      // A parent without an ID yet (read-only copy) is shown as a root.
      return rows.map(r => ({ public_id: publicNumber(r.public_id), parent_public_id: r.parent_public_id === null ? null : publicNumber(r.parent_public_id), name: r.name }));
    },
    async replay(clientKey, requestHash) {
      await c.query('INSERT INTO idempotency_keys(tenant_id,key,request_hash) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [actor.tenantId, idempotencyKey(clientKey), requestHash]);
      const prior = (await c.query('SELECT request_hash,response FROM idempotency_keys WHERE tenant_id=$1 AND key=$2 FOR UPDATE', [actor.tenantId, idempotencyKey(clientKey)])).rows[0];
      ensure(prior?.request_hash === requestHash, 409, 'Klucz polecenia wskazuje inną treść lub klucz API');
      return (prior.response ?? null) as Record<string, BaseWireJson> | null;
    },
    async remember(clientKey, response) {
      await c.query('UPDATE idempotency_keys SET response=$3 WHERE tenant_id=$1 AND key=$2', [actor.tenantId, idempotencyKey(clientKey), JSON.stringify(response)]);
    },
    async writableCatalog(catalogId) {
      ensure(typeof credential === 'string', 503, 'Brak natywnej kustodii klucza API');
      await assertWmsLegacyQuantityWriteInTx(c, actor);
      ensure(!await catalogStockControlStrictCatalogInTx(c, correctionActor(), catalogId, { scopes: ['inventory:read', 'inventory:write'] }), 409,
        'Ścisła korekta bez WMS wymaga odrębnego natywnego protokołu PW/RW');
      const options = await productCatalogOptionsInTx(c);
      ensure(options, 503, 'Kopia nie zawiera katalogów produktów');
      const head = options.catalogs.find(x => x.id === catalogId);
      ensure(head, 404, 'Nie znaleziono własnego katalogu');
      ensure(head.active === true, 409, 'Katalog jest nieaktywny');
      return { warehouseIds: Array.isArray(head.warehouse_ids) ? head.warehouse_ids : [] };
    },
    async lockStock(cells) {
      const out = new Map<string, { on_hand: number; reserved: number }>();
      if (!cells.length) return out;
      const sorted = [...cells].sort((x, y) => (x.warehouse_id + x.product_id).localeCompare(y.warehouse_id + y.product_id));
      const rows = (await c.query(`SELECT s.product_id,s.warehouse_id,s.on_hand,s.reserved FROM stock s JOIN unnest($1::uuid[],$2::uuid[]) x(p,w) ON(s.product_id,s.warehouse_id)=(x.p,x.w)
        WHERE s.tenant_id=$3 ORDER BY s.warehouse_id,s.product_id FOR UPDATE OF s`, [sorted.map(x => x.product_id), sorted.map(x => x.warehouse_id), actor.tenantId])).rows;
      for (const r of rows) out.set(r.product_id + ':' + r.warehouse_id, { on_hand: r.on_hand, reserved: r.reserved });
      return out;
    },
    async enlist(productId) { await enlistInventoryLegacyAdjustmentInTx(c, correctionActor(), productId); },
    async adjust(cell) { await adjustLegacyStockInTx(c, actor, cell); },
  };
}
/** Same mapping as the native REST error handler (app.ts) for the product
 * writers: a refused constraint is a definite, rolled-back outcome. */
async function nativeConstraint<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); } catch (error) {
    const code = (error as { code?: unknown })?.code;
    if (code === '23505') throw new Problem(409, 'Rekord już istnieje');
    if (code === '23503') throw new Problem(422, 'Nieprawidłowe powiązanie danych');
    throw error;
  }
}
/** PIM extension of the same port: native price lists, products.price and the
 * native product writers (same functions as POST /api/products, PATCH
 * /api/products/:id and PUT /api/price-lists/:id/items). */
export function createBaseWireInventoryPimNative(c: PoolClient, actor: Actor, credential?: string, opts: { categories?: boolean; deletions?: boolean } = {}): BaseWireInventoryPimNative {
  const deletions = opts.deletions === true;
  const base = createBaseWireInventoryNative(c, actor, credential, { deletions });
  return {
    ...base,
    async currency() {
      const row = (await c.query('SELECT currency FROM tenants WHERE id=$1', [actor.tenantId])).rows[0];
      ensure(row, 404, 'Nie znaleziono organizacji');
      return row.currency;
    },
    async priceGroups() {
      const rows = (await c.query(`SELECT s.public_id::text AS public_id,l.name,l.currency,l.active,l.fallback,l.adjustment_bps,l.adjustment_amount FROM price_lists l
        LEFT JOIN base_wire220_price_group_ids s ON(s.tenant_id,s.local_id)=(l.tenant_id,l.id) WHERE l.tenant_id=$1 ORDER BY s.public_id,l.id`, [actor.tenantId])).rows;
      return rows.map(r => {
        const public_id = publicNumber(r.public_id);
        ensure(public_id !== BASE_WIRE_BASE_PRICE_GROUP_ID, 503, 'Cennik ma identyfikator grupy podstawowej Base');
        return { public_id, name: r.name, currency: r.currency, active: r.active, fallback: r.fallback, adjustment_bps: r.adjustment_bps, adjustment_amount: r.adjustment_amount };
      });
    },
    async prices(productIds) {
      const rows = (await c.query(`SELECT p.id,p.price,coalesce((SELECT jsonb_agg(jsonb_build_object('group_public_id',s.public_id::text,'price',i.price) ORDER BY s.public_id)
        FROM price_list_items i LEFT JOIN base_wire220_price_group_ids s ON(s.tenant_id,s.local_id)=(i.tenant_id,i.price_list_id) WHERE(i.tenant_id,i.product_id)=(p.tenant_id,p.id)),'[]') AS overrides
        FROM products p WHERE p.tenant_id=$1 AND p.id=ANY($2::uuid[]) ORDER BY p.id`, [actor.tenantId, productIds])).rows;
      return rows.map(r => ({ product_id: r.id, price: r.price, overrides: r.overrides.map((o: Record<string, any>) => ({ group_public_id: publicNumber(o.group_public_id), price: o.price })) }));
    },
    async writePrices(groupPublicId, items) {
      const rows = (await c.query('SELECT local_id FROM base_wire220_price_group_ids WHERE tenant_id=$1 AND public_id=$2::bigint AND local_id IS NOT NULL', [actor.tenantId, groupPublicId])).rows;
      ensure(rows.length === 1, 404, 'Nie znaleziono grupy cenowej');
      await writePriceListItemsInTx(c, actor, rows[0].local_id, items, null);
    },
    saveProduct: (catalogId, productId, w) => nativeConstraint(async () => {
      if (productId === null) {
        const p = await createProduct(c, actor, productSchema.parse({ name: w.name, sku: w.sku, ean: w.ean, price: w.price, vat: w.vat, description: w.description,
          images: w.images, tags: w.tags, kind: w.kind, parent_id: w.parent_id, components: w.components, catalog_id: catalogId, warehouse_id: w.warehouse_id, quantity: w.quantity }),
          { birthScopes: ['products:read', 'products:write'] });
        return p.id as string;
      }
      // Native lock order: exclusive catalogue lock, then the product row (editProduct re-enters both).
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`catalog:${actor.tenantId}`]);
      const row = (await c.query('SELECT * FROM products WHERE id=$1 AND catalog_id=$2 FOR UPDATE', [productId, catalogId])).rows[0];
      ensure(row, 404, 'Nie znaleziono produktu w katalogu');
      // Same full body a PATCH /api/products/:id client sends: current values + the given fields.
      const input = editSchema.parse({ name: w.name ?? row.name, ean: w.ean ?? row.ean ?? '', price: w.price ?? row.price, vat: w.vat ?? row.vat, category: row.category,
        description: w.description ?? row.description, attributes: row.attributes, images: w.images ?? row.images, active: row.active, version: row.version,
        ...(w.tags === undefined ? {} : { tags: w.tags }), ...(w.sku === undefined || w.sku === row.sku ? {} : { sku: w.sku }), components: w.components ?? [] });
      await editProduct(c, actor, productId, input, w.components === undefined ? { preserveComponents: true } : {});
      return productId;
    }),
    async productPublicId(localId) {
      const rows = (await c.query('SELECT public_id::text AS public_id FROM base_wire220_product_ids WHERE tenant_id=$1 AND local_id=$2', [actor.tenantId, localId])).rows;
      return publicNumber(rows[0]?.public_id);
    },
    async deleteProduct(publicId) {
      ensure(deletions, 503, 'Usuwanie produktów wymaga migracji 225');
      const rows = (await c.query(`SELECT p.id,p.version FROM base_wire220_product_ids s JOIN products p ON(p.tenant_id,p.id)=(s.tenant_id,s.local_id)
        WHERE s.tenant_id=$1 AND s.public_id=$2::bigint AND ${productNotDeletedSQL(true)}`, [actor.tenantId, publicId])).rows;
      ensure(rows.length <= 1, 503, 'Niespójna mapa produktów Base');
      if (!rows.length) return false;
      // Same command as POST /api/products/:id/deletion; the version is the current one.
      await deleteProductInTx(c, actor, rows[0].id, { version: rows[0].version, reason: 'Base API deleteInventoryProduct' });
      return true;
    },
  };
}
/** Startup capability: the 225 deleted state is installed. */
export async function productDeletions225Available(pool: Pool): Promise<boolean> {
  return (await pool.query("SELECT to_regclass('public.product_deletions225') IS NOT NULL AS present")).rows[0]?.present === true;
}
/** Startup capability: the 224 sidecar and its owner functions are installed. */
export async function baseWireCategories224Available(pool: Pool): Promise<boolean> {
  return (await pool.query(`SELECT to_regclass('public.base_wire224_category_ids') IS NOT NULL
    AND to_regprocedure('public.base_wire224_allocate_categories()') IS NOT NULL
    AND to_regprocedure('public.base_wire224_categories(uuid)') IS NOT NULL
    AND to_regprocedure('public.base_wire224_product_categories(uuid)') IS NOT NULL AS present`)).rows[0]?.present === true;
}
export function createDefaultBaseWireInventoryService(opts: { readOnly?: boolean; categories?: boolean; deletions?: boolean } = {}) {
  const transaction = <T>(actor: Actor, writing: boolean, work: (c: PoolClient) => Promise<T>) => (writing ? tenantTx : tenantReadTx)(actor.tenantId, work);
  const categories = opts.categories === true, deletions = opts.deletions === true;
  const core = createBaseWireInventoryService({ transaction, categories, allocateOnRead: opts.readOnly !== true,
    native: (c, actor, credential) => createBaseWireInventoryNative(c, actor, credential, { categories, deletions }) });
  const pim = createBaseWireInventoryPimService({ transaction, deletions,
    native: (c, actor, credential) => createBaseWireInventoryPimNative(c, actor, credential, { deletions }) });
  return {
    execute: (actor: Actor, method: string, parameters: Record<string, BaseWireJson>, options: { clientKey?: string; credential?: string } = {}) =>
      ((BASE_WIRE_INVENTORY_PIM_METHODS as readonly string[]).includes(method) ? pim : core).execute(actor, method, parameters, options),
  };
}
