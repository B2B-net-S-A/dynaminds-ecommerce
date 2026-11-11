/** Base "inventory" family on connector.php: getInventoryWarehouses,
 * getInventories, getInventoryProductsList, getInventoryProductsData,
 * updateInventoryProductsStock over the native catalog/warehouse/product/stock
 * domain with the 220 numeric identities, and getInventoryCategories over the
 * native PIM categories with the 224 numeric identities (read-only). The PIM
 * methods of this family (and deleteInventoryProduct over the native 225
 * deleted state) are in base-wire-inventory-pim.ts. Products deleted natively
 * (225) are absent from every read of this family.
 * Sources: docs/parity/base-api-inventory-configuration-contracts.v1.json and
 * base-api-inventory-products-contracts.v1.json. Field mapping and every local
 * choice: docs/parity/BASE-WIRE-INVENTORY220-20261023.md.
 * No database/runtime import: the native port is supplied at startup.
 */
import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { Actor } from './domain';
import { Problem, ensure } from './errors';
import type { BaseWireJson } from './base-wire-codec';
import type { BaseWireFamily } from './base-wire-routes';

const BASE_WIRE_INVENTORY_CORE_METHODS = ['getInventoryWarehouses','getInventories','getInventoryProductsList','getInventoryProductsData','updateInventoryProductsStock','getInventoryCategories'] as const;
/** Served by server/base-wire-inventory-pim.ts on the same family. */
export const BASE_WIRE_INVENTORY_PIM_METHODS = ['getInventoryPriceGroups','getInventoryProductsStock','getInventoryProductsPrices','updateInventoryProductsPrices','addInventoryProduct','deleteInventoryProduct'] as const;
export const BASE_WIRE_INVENTORY_METHODS = [...BASE_WIRE_INVENTORY_CORE_METHODS, ...BASE_WIRE_INVENTORY_PIM_METHODS] as const;
type Method = typeof BASE_WIRE_INVENTORY_METHODS[number];
function method(value: string): asserts value is Method {
  ensure(BASE_WIRE_INVENTORY_METHODS.includes(value as Method), 400, 'Nieznana metoda Base magazynu');
}
const writes: readonly string[] = ['updateInventoryProductsStock', 'updateInventoryProductsPrices', 'addInventoryProduct', 'deleteInventoryProduct'];
export function isBaseWireInventoryWrite(value: string) { method(value); return writes.includes(value); }
/** Reads inventory:read (family precedent). The stock write is inventory:write;
 * product and price writes are products:write like the native writers
 * (POST/PATCH /products, PUT /price-lists/:id/items). Every write also requires
 * its read scope (authenticateBaseWireApiKey). */
export function baseWireInventoryScope(value: string) {
  if (!isBaseWireInventoryWrite(value)) return 'inventory:read' as const;
  return value === 'updateInventoryProductsStock' ? 'inventory:write' as const : 'products:write' as const;
}
/** LOCAL derived Base price group of the native base price (products.price),
 * which has no 220 sidecar row. Price lists keep their 220 IDs; one that ever
 * receives this value refuses the price methods (503), it is never renumbered. */
export const BASE_WIRE_BASE_PRICE_GROUP_ID = 2147483647;

export type BaseWireInventoryWarehouse = { id: string; public_id: number; name: string; code: string };
export type BaseWireInventoryStock = { warehouse_public_id: number; on_hand: number; reserved: number; location: string };
export type BaseWireInventoryProduct = {
  id: string; public_id: number; kind: 'simple'|'group'|'variant'|'bundle'; parent_public_id: number|null;
  sku: string; ean: string|null; vat: number; tags: string[]; name: string; description: string; images: string[];
  stock: BaseWireInventoryStock[]; bundle: { public_id: number; quantity: number }[];
  /** 224 ID of the current native PIM category; null = none (or no ID yet). */
  category_public_id: number|null;
  /** Native product_translations rows (any locale, ordered by locale). */
  translations: { locale: string; name: string; description: string }[];
};
/** One native PIM category of a catalog with its 224 ID; parent null = root (or no ID yet). */
export type BaseWireInventoryCategory = { public_id: number; parent_public_id: number|null; name: string };
export type BaseWireInventoryCell = { product_id: string; warehouse_id: string };
export type BaseWireInventoryCatalog = { public_id: number; name: string; is_default: boolean; languages: string[]; default_language: string;
  warehouse_public_ids: number[]; price_group_public_ids: number[] };
export type BaseWireInventoryListRow = { public_id: number; parent_public_id: number|null; sku: string; ean: string|null; name: string;
  stock: { warehouse_public_id: number; on_hand: number }[] };
/** Supported getInventoryProductsList filters; null = not filtered. */
export type BaseWireInventoryListQuery = { id: number|null; ean: string|null; sku: string|null; name: string|null;
  stock_from: number|null; stock_to: number|null; category: number|null; include_variants: boolean; descending: boolean; page: number; page_size: number };
/** One native port per transaction; every lookup is the current tenant only. */
export type BaseWireInventoryNative = {
  warehouses(): Promise<BaseWireInventoryWarehouse[]>;
  stockEditable(): Promise<boolean>;
  /** Every own catalog, ordered by public ID. */
  catalogs(): Promise<BaseWireInventoryCatalog[]>;
  /** One page (at most page_size rows) of that catalog, ordered by public ID. */
  productList(catalogId: string, query: BaseWireInventoryListQuery): Promise<BaseWireInventoryListRow[]>;
  /** Own catalog UUID for a Base inventory_id, or null. */
  catalog(publicId: number): Promise<string|null>;
  /** Requested products of that catalog (foreign/other-catalog IDs are absent). */
  products(catalogId: string, publicIds: number[]): Promise<BaseWireInventoryProduct[]>;
  variants(catalogId: string, parentIds: string[]): Promise<BaseWireInventoryProduct[]>;
  /** base_wire224_allocate_categories() for the current tenant (writing transaction only). */
  allocateCategories(): Promise<void>;
  /** Categories of that catalog that have a 224 ID, ordered by it. */
  categories(catalogId: string): Promise<BaseWireInventoryCategory[]>;
  replay(clientKey: string, requestHash: string): Promise<Record<string, BaseWireJson>|null>;
  remember(clientKey: string, response: Record<string, BaseWireJson>): Promise<void>;
  /** Refuses active WMS / strict / inactive catalogs; returns assigned warehouses. */
  writableCatalog(catalogId: string): Promise<{ warehouseIds: string[] }>;
  lockStock(cells: BaseWireInventoryCell[]): Promise<Map<string, { on_hand: number; reserved: number }>>;
  enlist(productId: string): Promise<void>;
  adjust(cell: BaseWireInventoryCell & { delta: number; note: string }): Promise<void>;
};
export type BaseWireInventoryPorts = {
  transaction<T>(actor: Actor, writing: boolean, work: (c: PoolClient) => Promise<T>): Promise<T>;
  native(c: PoolClient, actor: Actor, credential?: string): BaseWireInventoryNative;
  /** Startup decision: 224 category identities are installed (default false). */
  categories?: boolean;
  /** Startup decision: a read-only copy never allocates identities (default false). */
  allocateOnRead?: boolean;
};

const id = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const numericKey = /^[1-9][0-9]{0,15}$/;
// LOCAL: these flags select data without a native source. Refuse instead of
// silently returning an incomplete Base shape.
const unsupportedFlags = ['include_erp_units','include_wms_units','include_additional_eans','include_suppliers','include_relations','include_marketplace_categories','include_shipping_templates','include_channels_media'] as const;
const warehousesInput = z.object({}).strict();
const productsInput = z.object({
  inventory_id: id,
  // LOCAL ceiling: the contract declares no batch limit for this read.
  products: z.array(id).max(1000),
  ...Object.fromEntries(unsupportedFlags.map(flag => [flag, z.boolean().optional()])) as Record<typeof unsupportedFlags[number], z.ZodOptional<z.ZodBoolean>>,
}).strict();
const inventoriesInput = z.object({}).strict();
// Absent, null and '' all mean "no filter" (Base clients often send every key).
const blank = (v: unknown) => v === null || v === '' ? undefined : v;
const optional = <T extends z.ZodTypeAny>(schema: T) => z.preprocess(blank, schema.optional());
// LOCAL: no reviewed native source (tags have no IDs, prices are price-list
// derived, location-name matching is undocumented). filter_category_id needs 224.
const unsupportedFilters = ['filter_tag','filter_price_from','filter_price_to','filter_locations'] as const;
const stockBound = z.number().int().min(-2147483648).max(2147483647);
const listInput = z.object({
  inventory_id: id,
  filter_id: optional(id),
  filter_ean: optional(z.string().max(32)),
  filter_sku: optional(z.string().max(50)),
  filter_name: optional(z.string().max(200)),
  filter_stock_from: optional(stockBound),
  filter_stock_to: optional(stockBound),
  // Checked after the startup capability: without 224 any value is LOCAL-refused.
  filter_category_id: z.unknown().optional(),
  page: optional(id),
  filter_sort: optional(z.enum(['id ASC', 'id DESC'])),
  include_variants: optional(z.boolean()),
  ...Object.fromEntries(unsupportedFilters.map(f => [f, z.unknown().optional()])) as Record<typeof unsupportedFilters[number], z.ZodOptional<z.ZodUnknown>>,
}).strict();
/** Base documents 1000 products per page for the Base warehouse. */
export const BASE_WIRE_INVENTORY_LIST_PAGE = 1000;
const stockInput = z.object({
  inventory_id: id,
  products: z.record(z.string().regex(numericKey), z.record(z.string().max(64), z.number().int().min(0).max(2147483647)))
    .refine(v => Object.keys(v).length <= 1000, 'Najwyżej 1000 produktów'),
}).strict();
// Omitted inventory_id = Base shared categories; natively every category belongs to one catalog.
const categoriesInput = z.object({ inventory_id: optional(id) }).strict();
const warehouseKey = (publicId: number) => 'bl_' + publicId;
const STOCK_NOTE = 'Base API updateInventoryProductsStock';

function stockMaps(rows: BaseWireInventoryStock[]) {
  const stock: Record<string, BaseWireJson> = {}, reservations: Record<string, BaseWireJson> = {}, locations: Record<string, BaseWireJson> = {};
  for (const s of rows) { const k = warehouseKey(s.warehouse_public_id); stock[k] = s.on_hand; reservations[k] = s.reserved; locations[k] = s.location; }
  return { stock, reservations, locations };
}
/** Base text_fields: unqualified name/description = the native product (catalog default language);
 * `name|xx`/`description|xx` = the native translation of another two-letter locale. LOCAL: a
 * translation row in the default language and region/script locales (e.g. `en-gb`) are not returned
 * (Base [lang] is a two-letter code; the default language is the unqualified key). */
export function baseWireTextFields(p: Pick<BaseWireInventoryProduct, 'name'|'description'|'translations'>, defaultLanguage: string): Record<string, BaseWireJson> {
  const out: Record<string, BaseWireJson> = { name: p.name, description: p.description };
  for (const t of [...p.translations].sort((x, y) => x.locale < y.locale ? -1 : x.locale > y.locale ? 1 : 0)) {
    if (t.locale === defaultLanguage || !/^[a-z]{2}$/.test(t.locale)) continue;
    out['name|' + t.locale] = t.name;
    out['description|' + t.locale] = t.description;
  }
  return out;
}
function productDto(p: BaseWireInventoryProduct, variants: BaseWireInventoryProduct[], categories: boolean, defaultLanguage: string): Record<string, BaseWireJson> {
  const { stock, reservations, locations } = stockMaps(p.stock);
  const images: Record<string, BaseWireJson> = {};
  p.images.slice(0, 16).forEach((url, n) => { images[String(n + 1)] = url; });
  const out: Record<string, BaseWireJson> = {
    is_bundle: p.kind === 'bundle', parent_id: p.parent_public_id ?? 0, sku: p.sku, ean: p.ean ?? '', tags: [...p.tags],
    tax_rate: p.vat, text_fields: baseWireTextFields(p, defaultLanguage), stock, reservations, locations, images,
    variants: Object.fromEntries(variants.map(v => { const m = stockMaps(v.stock); return [String(v.public_id), { name: v.name, sku: v.sku, ean: v.ean ?? '', stock: m.stock, locations: m.locations }]; })),
  };
  if (p.kind === 'bundle') out.bundle_products = Object.fromEntries(p.bundle.map(b => [String(b.public_id), b.quantity]));
  // 0 = no native category (Base: a product without a category).
  if (categories) out.category_id = p.category_public_id ?? 0;
  return out;
}

export function createBaseWireInventoryService(ports: BaseWireInventoryPorts) {
  const tx = <T>(actor: Actor, writing: boolean, credential: string|undefined, work: (n: BaseWireInventoryNative) => Promise<T>) =>
    ports.transaction(actor, writing, c => work(ports.native(c, actor, credential)));
  const categories = ports.categories === true;
  // Natively created categories get their numeric ID here, before the read snapshot.
  const allocate = async (actor: Actor) => { if (categories && ports.allocateOnRead === true) await tx(actor, true, undefined, n => n.allocateCategories()); };
  async function update(actor: Actor, parameters: Record<string, BaseWireJson>, options: { clientKey?: string; credential?: string }) {
    const b = stockInput.parse(parameters);
    ensure(actor.source === 'api' && !!actor.apiKeyId && typeof options.credential === 'string', 503, 'Brak natywnej kustodii klucza API');
    const clientKey = options.clientKey === undefined ? undefined : z.uuid().parse(options.clientKey);
    const requestHash = createHash('sha256').update(JSON.stringify({ api_key_id: actor.apiKeyId, method: 'updateInventoryProductsStock', parameters })).digest('hex');
    return tx(actor, true, options.credential, async n => {
      if (clientKey) { const retained = await n.replay(clientKey, requestHash); if (retained) return retained; }
      const catalog = await n.catalog(b.inventory_id);
      ensure(catalog, 404, 'Nie znaleziono własnego katalogu');
      const assigned = new Set((await n.writableCatalog(catalog)).warehouseIds);
      const warehouses = new Map((await n.warehouses()).map(w => [w.public_id, w.id]));
      const keys = Object.keys(b.products).sort((x, y) => Number(x) - Number(y));
      const found = new Map((await n.products(catalog, keys.map(Number))).map(p => [p.public_id, p]));
      const warnings: Record<string, BaseWireJson> = {}, planned: { key: string; product: BaseWireInventoryProduct; cells: (BaseWireInventoryCell & { target: number })[] }[] = [];
      for (const key of keys) {
        const product = found.get(Number(key));
        if (!product) { warnings[key] = 'Nie znaleziono produktu w katalogu'; continue; }
        if (!['simple', 'variant'].includes(product.kind)) { warnings[key] = 'Grupa i zestaw nie mają własnego stanu'; continue; }
        const cells: (BaseWireInventoryCell & { target: number })[] = [];
        for (const [wkey, target] of Object.entries(b.products[key])) {
          const m = /^bl_([1-9][0-9]{0,15})$/.exec(wkey), warehouse = m ? warehouses.get(Number(m[1])) : undefined;
          // Only own Base-native ("bl") warehouses; no external stock storages exist locally.
          if (!warehouse) { warnings[key] = 'Nie znaleziono własnego magazynu Base'; break; }
          if (!assigned.has(warehouse)) { warnings[key] = 'Magazyn nie jest przypisany do katalogu'; break; }
          cells.push({ product_id: product.id, warehouse_id: warehouse, target });
        }
        if (!Object.hasOwn(warnings, key)) planned.push({ key, product, cells });
      }
      const locked = await n.lockStock(planned.flatMap(p => p.cells.map(({ product_id, warehouse_id }) => ({ product_id, warehouse_id }))));
      const accepted = planned.filter(p => {
        for (const cell of p.cells) {
          const s = locked.get(cell.product_id + ':' + cell.warehouse_id);
          if (!s) { warnings[p.key] = 'Brak stanu produktu w magazynie'; return false; }
          if (cell.target < s.reserved) { warnings[p.key] = 'Stan nie może być niższy niż rezerwacje'; return false; }
        }
        return true;
      });
      if (accepted.length) await n.enlist(accepted[0].product.id);
      for (const p of accepted) for (const cell of p.cells) {
        const delta = cell.target - locked.get(cell.product_id + ':' + cell.warehouse_id)!.on_hand;
        if (delta !== 0) await n.adjust({ product_id: cell.product_id, warehouse_id: cell.warehouse_id, delta, note: STOCK_NOTE });
      }
      // LOCAL: warnings is always an object (Base may encode an empty one as []).
      const response = { counter: accepted.length, warnings };
      if (clientKey) await n.remember(clientKey, response);
      return response;
    });
  }
  return {
    async execute(actor: Actor, selected: string, parameters: Record<string, BaseWireJson>, options: { clientKey?: string; credential?: string } = {}): Promise<Record<string, BaseWireJson>> {
      method(selected);
      ensure((BASE_WIRE_INVENTORY_CORE_METHODS as readonly string[]).includes(selected), 400, 'Nieznana metoda Base magazynu');
      if (selected === 'updateInventoryProductsStock') return update(actor, parameters, options);
      if (selected === 'getInventories') {
        inventoriesInput.parse(parameters);
        // LOCAL: no native description/default warehouse; the default price group is
        // the derived base price group (products.price applies to every catalog);
        // reservations always exist natively.
        return tx(actor, false, undefined, async n => ({ inventories: (await n.catalogs()).map(c => ({ inventory_id: c.public_id, name: c.name, description: '',
          languages: [...c.languages], default_language: c.default_language, price_groups: [...c.price_group_public_ids, BASE_WIRE_BASE_PRICE_GROUP_ID].sort((x, y) => x - y),
          default_price_group: BASE_WIRE_BASE_PRICE_GROUP_ID,
          warehouses: c.warehouse_public_ids.map(warehouseKey), default_warehouse: '', reservations: true, is_default: c.is_default })) }));
      }
      if (selected === 'getInventoryCategories') {
        const b = categoriesInput.parse(parameters);
        ensure(categories, 503, 'Kategorie Base wymagają migracji 224');
        // LOCAL: no native shared categories, so the shared list is empty.
        if (b.inventory_id === undefined) return { categories: [] };
        await allocate(actor);
        // LOCAL: inactive native categories are listed too (Base has no such state); ordered by ID.
        return tx(actor, false, undefined, async n => {
          const catalog = await n.catalog(b.inventory_id!);
          ensure(catalog, 404, 'Nie znaleziono własnego katalogu');
          return { categories: (await n.categories(catalog)).map(c => ({ category_id: c.public_id, name: c.name, parent_id: c.parent_public_id ?? 0 })) };
        });
      }
      if (selected === 'getInventoryProductsList') {
        const b = listInput.parse(parameters);
        for (const f of unsupportedFilters) if (blank(b[f]) !== undefined) throw new Problem(422, 'Filtr nie jest obsługiwany lokalnie', 'LOCAL_BASE_WIRE_UNSUPPORTED_FILTER');
        const category = blank(b.filter_category_id) === undefined ? null : categories ? id.parse(b.filter_category_id) : undefined;
        if (category === undefined) throw new Problem(422, 'Filtr nie jest obsługiwany lokalnie', 'LOCAL_BASE_WIRE_UNSUPPORTED_FILTER');
        if (category !== null) await allocate(actor);
        return tx(actor, false, undefined, async n => {
          const catalog = await n.catalog(b.inventory_id);
          ensure(catalog, 404, 'Nie znaleziono własnego katalogu');
          const rows = await n.productList(catalog, { id: b.filter_id ?? null, ean: b.filter_ean ?? null, sku: b.filter_sku ?? null, name: b.filter_name ?? null,
            stock_from: b.filter_stock_from ?? null, stock_to: b.filter_stock_to ?? null, category, include_variants: b.include_variants === true,
            descending: b.filter_sort === 'id DESC', page: b.page ?? 1, page_size: BASE_WIRE_INVENTORY_LIST_PAGE });
          ensure(rows.length <= BASE_WIRE_INVENTORY_LIST_PAGE, 500, 'Natywna strona produktów przekracza limit');
          // LOCAL: `prices` is not returned (same reason as getInventoryProductsData).
          const products: Record<string, BaseWireJson> = {};
          for (const p of rows) products[String(p.public_id)] = { id: p.public_id, parent_id: p.parent_public_id ?? 0, ean: p.ean ?? '', sku: p.sku, name: p.name,
            stock: Object.fromEntries(p.stock.map(s => [warehouseKey(s.warehouse_public_id), s.on_hand])) };
          return { products };
        });
      }
      if (selected === 'getInventoryWarehouses') {
        warehousesInput.parse(parameters);
        return tx(actor, false, undefined, async n => {
          const editable = await n.stockEditable();
          // LOCAL: no native address/description/default; internal id = public id.
          return { warehouses: (await n.warehouses()).map(w => ({ warehouse_type: 'bl', warehouse_id: w.public_id, internal_warehouse_id: w.public_id, name: w.name,
            description: '', stock_edition: editable, is_default: false, address: '', postcode: '', city: '', country: '' })) };
        });
      }
      const b = productsInput.parse(parameters);
      for (const flag of unsupportedFlags) if (b[flag] === true) throw new Problem(422, 'Flaga nie jest obsługiwana lokalnie', 'LOCAL_BASE_WIRE_UNSUPPORTED_FLAG');
      if (b.products.length) await allocate(actor);
      return tx(actor, false, undefined, async n => {
        const catalog = await n.catalog(b.inventory_id);
        ensure(catalog, 404, 'Nie znaleziono własnego katalogu');
        const rows = b.products.length ? await n.products(catalog, [...new Set(b.products)]) : [];
        const settings = rows.length ? (await n.catalogs()).find(c => c.public_id === b.inventory_id) : undefined;
        ensure(!rows.length || settings, 503, 'Niespójna mapa katalogów Base');
        const mains = rows.filter(p => p.kind !== 'variant');
        const variants = mains.length ? await n.variants(catalog, mains.map(p => p.id)) : [];
        const products: Record<string, BaseWireJson> = {};
        for (const p of rows) products[String(p.public_id)] = productDto(p, p.kind === 'variant' ? [] : variants.filter(v => v.parent_public_id === p.public_id), categories, settings!.default_language);
        return { products };
      });
    },
  };
}
export type BaseWireInventoryService = ReturnType<typeof createBaseWireInventoryService>;

/** Second connector.php family. Only startup capability selects availability. */
export function createBaseWireInventoryFamily(opts: { service: Pick<BaseWireInventoryService, 'execute'>; available: boolean }): BaseWireFamily {
  return Object.freeze({ label: 'magazynu', methods: BASE_WIRE_INVENTORY_METHODS, scope: baseWireInventoryScope, isWrite: isBaseWireInventoryWrite,
    available: opts.available === true, nativeCredentialCustody: true, service: opts.service });
}
