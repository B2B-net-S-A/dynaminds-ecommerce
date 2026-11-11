/** Base "inventory" family, PIM part: getInventoryPriceGroups,
 * getInventoryProductsStock, getInventoryProductsPrices,
 * updateInventoryProductsPrices and addInventoryProduct over native price lists,
 * products.price and the native product writers (createProduct/editProduct);
 * deleteInventoryProduct over the native 225 deleted state (deleteProductInTx).
 * Sources: base-api-inventory-products-contracts.v1.json and
 * base-api-inventory-other-configuration-contracts-20261018.md (price groups).
 * Mapping, skipped methods and every local choice:
 * docs/parity/BASE-WIRE-INVENTORY220-20261023.md.
 * No database/runtime import: the native port is supplied at startup.
 */
import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { Actor } from './domain';
import { Problem, ensure } from './errors';
import type { BaseWireJson } from './base-wire-codec';
import { BASE_WIRE_BASE_PRICE_GROUP_ID, BASE_WIRE_INVENTORY_LIST_PAGE, BASE_WIRE_INVENTORY_PIM_METHODS,
  type BaseWireInventoryNative, type BaseWireInventoryProduct } from './base-wire-inventory';

type Method = typeof BASE_WIRE_INVENTORY_PIM_METHODS[number];
/** One native price list (= Base price group); amounts in integer minor units. */
export type BaseWireInventoryPriceGroup = { public_id: number; name: string; currency: string; active: boolean;
  fallback: boolean; adjustment_bps: number; adjustment_amount: number };
/** products.price and the stored SKU prices (price_list_items) of one product. */
export type BaseWireInventoryPriceRow = { product_id: string; price: number; overrides: { group_public_id: number; price: number }[] };
/** Native product fields; only present fields change on update. */
export type BaseWireInventoryProductWrite = {
  kind?: 'simple'|'variant'|'bundle'; parent_id?: string; sku?: string; ean?: string; tags?: string[]; vat?: number;
  name?: string; description?: string; price?: number; images?: string[];
  components?: { product_id: string; quantity: number }[]; warehouse_id?: string; quantity?: number;
};
export type BaseWireInventoryPimNative = BaseWireInventoryNative & {
  currency(): Promise<string>;
  /** Every own price list ordered by public ID. */
  priceGroups(): Promise<BaseWireInventoryPriceGroup[]>;
  prices(productIds: string[]): Promise<BaseWireInventoryPriceRow[]>;
  /** Native price-list item writer (PUT /api/price-lists/:id/items). */
  writePrices(groupPublicId: number, items: { product_id: string; price: number }[]): Promise<void>;
  /** createProduct (productId null) or editProduct merged over the current row; returns the local ID. */
  saveProduct(catalogId: string, productId: string|null, write: BaseWireInventoryProductWrite): Promise<string>;
  productPublicId(localId: string): Promise<number>;
  /** Native 225 deletion of the current tenant's product with that public ID; false = no such (non-deleted) product. */
  deleteProduct(publicId: number): Promise<boolean>;
};
export type BaseWireInventoryPimPorts = {
  transaction<T>(actor: Actor, writing: boolean, work: (c: PoolClient) => Promise<T>): Promise<T>;
  native(c: PoolClient, actor: Actor, credential?: string): BaseWireInventoryPimNative;
  /** Startup decision: the 225 deleted state is installed (default false). */
  deletions?: boolean;
};

const BASE = BASE_WIRE_BASE_PRICE_GROUP_ID;
const id = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const numericKey = /^[1-9][0-9]{0,15}$/;
const blank = (v: unknown) => v === null || v === '' ? undefined : v;
const optional = <T extends z.ZodTypeAny>(schema: T) => z.preprocess(blank, schema.optional());
const absent = <T extends z.ZodTypeAny>(schema: T) => z.preprocess(v => v === null ? undefined : v, schema.optional());
// Native prices are integer minor units 0..100000000 (catalogFields.price): Base
// gross prices are accepted only when that conversion is exact.
const grossPrice = z.number().min(0).max(1000000).refine(v => Math.round(v * 100) / 100 === v, 'Cena wymaga najwyżej 2 miejsc po przecinku');
const priceMap = z.record(z.string().regex(numericKey), grossPrice);
const minor = (v: number) => Math.round(v * 100);
const major = (v: number) => v / 100;
const warehouseKey = (publicId: number) => 'bl_' + publicId;
const stockBound = z.number().int().min(-2147483648).max(2147483647);
const stockUnsupported = ['filter_category_id', 'filter_asin', 'filter_locations'] as const;
const stockInput = z.object({
  inventory_id: id, filter_id: optional(id), filter_ean: optional(z.string().max(32)), filter_sku: optional(z.string().max(50)),
  filter_name: optional(z.string().max(200)), filter_stock_from: optional(stockBound), filter_stock_to: optional(stockBound),
  page: optional(id), filter_sort: optional(z.enum(['id ASC', 'id DESC'])),
  ...Object.fromEntries(stockUnsupported.map(f => [f, z.unknown().optional()])) as Record<typeof stockUnsupported[number], z.ZodOptional<z.ZodUnknown>>,
}).strict();
const pricesInput = z.object({ inventory_id: id, page: optional(id) }).strict();
// Base deletes by product_id only (no inventory_id); any own catalog.
const deleteInput = z.object({ product_id: id }).strict();
const updatePricesInput = z.object({
  inventory_id: id,
  products: z.record(z.string().regex(numericKey), priceMap).refine(v => Object.keys(v).length <= 1000, 'Najwyżej 1000 produktów'),
}).strict();
// LOCAL: fields without a reviewed exact native mapping. An empty value
// (null, '', 0, [] or {}) is ignored because Base clients send every key.
const unsupportedFields = ['ean_additional','asin','weight','height','width','length','average_cost','star','manufacturer_id','category_id',
  'thresholds','locations','videos','media_options','links','suppliers','relations','shipping_template'] as const;
const productInput = z.object({
  inventory_id: id,
  product_id: optional(z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)),
  parent_id: optional(z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)),
  is_bundle: absent(z.boolean()),
  sku: absent(z.string().max(50)),
  ean: absent(z.string().max(32)),
  tags: absent(z.array(z.string())),
  tax_rate: absent(z.number()),
  text_fields: absent(z.record(z.string().max(100), z.string())),
  prices: absent(priceMap),
  stock: absent(z.record(z.string().max(64), z.number().int().min(0).max(10000000))),
  images: absent(z.record(z.string().max(32), z.string().max(1010))),
  bundle_products: absent(z.record(z.string().regex(numericKey), z.number().int().min(1).max(2147483647))),
  ...Object.fromEntries(unsupportedFields.map(f => [f, z.unknown().optional()])) as Record<typeof unsupportedFields[number], z.ZodOptional<z.ZodUnknown>>,
}).strict();
const empty = (v: unknown) => v === undefined || v === null || v === '' || v === 0 || (Array.isArray(v) && v.length === 0)
  || (typeof v === 'object' && v !== null && !Array.isArray(v) && Object.keys(v).length === 0);
const NATIVE_VAT = [0, 5, 8, 23];
const unsupported = (message: string) => new Problem(422, message, 'LOCAL_BASE_WIRE_UNSUPPORTED_FIELD');

function groupDto(g: BaseWireInventoryPriceGroup): Record<string, BaseWireJson> {
  // Native rule (pricing.ts prices()): no SKU price + fallback list => base price
  // * (1 + bps/10000) rounded half up to minor units, then + adjustment_amount.
  return { price_group_id: g.public_id, name: g.name, description: '', currency: g.currency, is_default: false,
    price_group_type: g.fallback ? 'dependent_on_price_group' : 'standard', source_price_group_id: g.fallback ? BASE : 0,
    price_multiplier: g.fallback ? (10000 + g.adjustment_bps) / 10000 : 1, price_addition: g.fallback ? major(g.adjustment_amount) : 0,
    is_bundle_price_calculated: false, bundle_price_multiplier: 1, bundle_price_addition: 0 };
}
/** Same result as the native quote: SKU price, else the fallback rule (active
 * list in the company currency), else no price in that group. */
function effectivePrices(kind: BaseWireInventoryProduct['kind'], row: BaseWireInventoryPriceRow|undefined, groups: BaseWireInventoryPriceGroup[], currency: string) {
  const out: Record<string, BaseWireJson> = {};
  if (kind === 'group' || !row) return out;
  const fixed = new Map(row.overrides.map(o => [o.group_public_id, o.price]));
  for (const g of groups) {
    const rule = g.active && g.fallback && g.currency === currency ? Math.floor((row.price * (10000 + g.adjustment_bps) + 5000) / 10000) + g.adjustment_amount : undefined;
    const value = fixed.get(g.public_id) ?? rule;
    if (value !== undefined && Number.isSafeInteger(value) && value >= 0 && value <= 100000000) out[String(g.public_id)] = major(value);
  }
  out[String(BASE)] = major(row.price);
  return out;
}

export function createBaseWireInventoryPimService(ports: BaseWireInventoryPimPorts) {
  const tx = <T>(actor: Actor, writing: boolean, credential: string|undefined, work: (n: BaseWireInventoryPimNative) => Promise<T>) =>
    ports.transaction(actor, writing, c => work(ports.native(c, actor, credential)));
  async function head(n: BaseWireInventoryPimNative, inventoryId: number) {
    const catalog = await n.catalog(inventoryId);
    ensure(catalog, 404, 'Nie znaleziono własnego katalogu');
    const settings = (await n.catalogs()).find(c => c.public_id === inventoryId);
    ensure(settings, 503, 'Niespójna mapa katalogów Base');
    return { catalog, settings };
  }
  /** Writes only changed SKU prices, one native list write per group. */
  async function writeGroupPrices(n: BaseWireInventoryPimNative, entries: { product_id: string; group: number; price: number }[]) {
    if (!entries.length) return;
    const current = new Map((await n.prices([...new Set(entries.map(e => e.product_id))])).map(r => [r.product_id, new Map(r.overrides.map(o => [o.group_public_id, o.price]))]));
    const groups = [...new Set(entries.map(e => e.group))].sort((x, y) => x - y);
    for (const g of groups) {
      const items = entries.filter(e => e.group === g && current.get(e.product_id)?.get(g) !== e.price).map(e => ({ product_id: e.product_id, price: e.price }));
      if (items.length) await n.writePrices(g, items);
    }
  }
  function commandHash(actor: Actor, selected: Method, parameters: Record<string, BaseWireJson>) {
    return createHash('sha256').update(JSON.stringify({ api_key_id: actor.apiKeyId, method: selected, parameters })).digest('hex');
  }
  function command(actor: Actor, options: { clientKey?: string; credential?: string }) {
    ensure(actor.source === 'api' && !!actor.apiKeyId && typeof options.credential === 'string', 503, 'Brak natywnej kustodii klucza API');
    return options.clientKey === undefined ? undefined : z.uuid().parse(options.clientKey);
  }

  async function updatePrices(actor: Actor, parameters: Record<string, BaseWireJson>, options: { clientKey?: string; credential?: string }) {
    const b = updatePricesInput.parse(parameters);
    const clientKey = command(actor, options);
    // Native roles: SKU prices role != viewer, the base price (product edit) admin.
    ensure(actor.role !== 'viewer', 403, 'Konto ma uprawnienia tylko do odczytu');
    ensure(actor.role === 'admin' || !Object.values(b.products).some(p => Object.hasOwn(p, String(BASE))), 403, 'Wymagana rola administratora');
    const requestHash = commandHash(actor, 'updateInventoryProductsPrices', parameters);
    return tx(actor, true, options.credential, async n => {
      if (clientKey) { const retained = await n.replay(clientKey, requestHash); if (retained) return retained; }
      const { catalog, settings } = await head(n, b.inventory_id);
      const assigned = new Set(settings.price_group_public_ids);
      const keys = Object.keys(b.products).sort((x, y) => Number(x) - Number(y));
      const found = new Map((await n.products(catalog, keys.map(Number))).map(p => [p.public_id, p]));
      const warnings: Record<string, BaseWireJson> = {}, accepted: { product: BaseWireInventoryProduct; prices: [number, number][] }[] = [];
      for (const key of keys) {
        const product = found.get(Number(key));
        const prices = Object.entries(b.products[key]).map(([g, v]) => [Number(g), minor(v)] as [number, number]);
        if (!product) warnings[key] = 'Nie znaleziono produktu w katalogu';
        else if (product.kind === 'group') warnings[key] = 'Grupa wariantów nie ma ceny sprzedaży';
        else if (prices.some(([g]) => g !== BASE && !assigned.has(g))) warnings[key] = 'Nie znaleziono grupy cenowej katalogu';
        else accepted.push({ product, prices });
      }
      // Base price edits first: editProduct takes the exclusive catalogue lock
      // before the price-list writer's shared one (never an upgrade).
      const base = accepted.flatMap(a => a.prices.filter(([g]) => g === BASE).map(([, price]) => ({ product: a.product, price })));
      if (base.length) {
        const current = new Map((await n.prices(base.map(x => x.product.id))).map(r => [r.product_id, r.price]));
        for (const x of base) if (current.get(x.product.id) !== x.price) await n.saveProduct(catalog, x.product.id, { price: x.price });
      }
      await writeGroupPrices(n, accepted.flatMap(a => a.prices.filter(([g]) => g !== BASE).map(([group, price]) => ({ product_id: a.product.id, group, price }))));
      const response = { counter: accepted.length, warnings };
      if (clientKey) await n.remember(clientKey, response);
      return response;
    });
  }

  async function saveProduct(actor: Actor, parameters: Record<string, BaseWireJson>, options: { clientKey?: string; credential?: string }) {
    const b = productInput.parse(parameters);
    for (const f of unsupportedFields) if (!empty(b[f])) throw unsupported('Pole produktu nie jest obsługiwane lokalnie');
    const clientKey = command(actor, options);
    ensure(actor.role === 'admin', 403, 'Wymagana rola administratora');
    if (b.tax_rate !== undefined) ensure(NATIVE_VAT.includes(b.tax_rate), 422, 'Stawka VAT nie jest obsługiwana lokalnie');
    const requestHash = commandHash(actor, 'addInventoryProduct', parameters);
    return tx(actor, true, options.credential, async n => {
      if (clientKey) { const retained = await n.replay(clientKey, requestHash); if (retained) return retained; }
      const { catalog, settings } = await head(n, b.inventory_id);
      const write: BaseWireInventoryProductWrite = {};
      // text_fields: only name/description in the catalogue's default language. LOCAL: a native
      // translation exists only with provenance (AI/DeepL draft or a bulk-edit receipt, CHECK
      // product_translations_provenance), so other languages are refused, never written loosely.
      for (const [key, value] of Object.entries(b.text_fields ?? {})) {
        const m = /^(name|description)(?:\|([a-z]{2}(?:_[A-Z]{2})?))?$/.exec(key);
        if (!m) throw unsupported('Pole tekstowe nie jest obsługiwane lokalnie');
        if (m[2] !== undefined && m[2] !== settings.default_language) throw unsupported('Tłumaczenia zapisuje natywna edycja tłumaczeń (podgląd i wykonanie), nie Base API');
        ensure(write[m[1] as 'name'|'description'] === undefined, 422, 'Powtórzone pole tekstowe');
        write[m[1] as 'name'|'description'] = value;
      }
      if (b.sku !== undefined) write.sku = b.sku;
      if (b.ean !== undefined) write.ean = b.ean;
      if (b.tags !== undefined) write.tags = b.tags;
      if (b.tax_rate !== undefined) write.vat = b.tax_rate;
      const current = b.product_id ? (await n.products(catalog, [b.product_id]))[0] : undefined;
      if (b.product_id) ensure(current, 404, 'Nie znaleziono produktu w katalogu');
      const kind = current?.kind ?? (b.parent_id ? 'variant' : b.is_bundle ? 'bundle' : 'simple');
      if (current) {
        // Native PATCH keeps kind and parent; stock has its own Base method.
        ensure(b.parent_id === undefined || b.parent_id === (current.parent_public_id ?? 0), 422, 'Rodzica produktu nie można zmienić');
        ensure(b.is_bundle === undefined || b.is_bundle === (current.kind === 'bundle'), 422, 'Typu produktu nie można zmienić');
        if (!empty(b.stock)) throw unsupported('Stan zmieniaj metodą updateInventoryProductsStock');
      } else {
        ensure(!(b.parent_id && b.is_bundle), 422, 'Wariant nie może być zestawem');
        write.kind = kind as BaseWireInventoryProductWrite['kind'];
        if (b.parent_id) {
          const parent = (await n.products(catalog, [b.parent_id]))[0];
          ensure(parent, 422, 'Nie znaleziono produktu nadrzędnego w katalogu');
          write.parent_id = parent.id;
        }
        // LOCAL: the native birth places the product in one warehouse of the catalogue. Without
        // `stock` (Base: a product without stock) it is born with 0 in the catalogue warehouse with
        // the lowest Base warehouse ID (no native default warehouse exists).
        const stock = Object.entries(b.stock ?? {});
        ensure(stock.length <= 1, 422, 'Podaj stan najwyżej w jednym magazynie katalogu');
        const m = stock.length ? /^bl_([1-9][0-9]{0,15})$/.exec(stock[0][0]) : null, publicWarehouse = stock.length ? (m ? Number(m[1]) : 0) : Math.min(...settings.warehouse_public_ids);
        ensure(settings.warehouse_public_ids.includes(publicWarehouse), 422, 'Magazyn nie jest przypisany do katalogu');
        write.warehouse_id = (await n.warehouses()).find(w => w.public_id === publicWarehouse)?.id;
        ensure(write.warehouse_id, 503, 'Niespójna mapa magazynów Base');
        write.quantity = stock.length ? stock[0][1] : 0;
      }
      if (b.bundle_products !== undefined) {
        ensure(kind === 'bundle', 422, 'Składniki dostępne tylko dla zestawu');
        const ids = Object.keys(b.bundle_products).map(Number), parts = new Map((await n.products(catalog, ids)).map(p => [p.public_id, p.id]));
        ensure(ids.every(x => parts.has(x)), 422, 'Składnik zestawu spoza katalogu');
        write.components = ids.map(x => ({ product_id: parts.get(x)!, quantity: b.bundle_products![String(x)] }));
      }
      if (b.images !== undefined) {
        // Positions 0..15 change only the given entries; no native gap or delete.
        const images = [...(current?.images ?? [])];
        for (const [key, value] of Object.entries(b.images).sort(([x], [y]) => Number(x) - Number(y))) {
          const pos = /^(0|[1-9][0-9]?)$/.test(key) ? Number(key) : 16;
          if (pos > 15 || !value.startsWith('url:') || value.length === 4) throw unsupported('Zdjęcie wymaga pozycji 0–15 i adresu url:');
          ensure(pos <= images.length, 422, 'Zdjęcia muszą tworzyć ciągłą galerię');
          images[pos] = value.slice(4);
        }
        write.images = images;
      }
      const groups: { group: number; price: number }[] = [];
      for (const [g, v] of Object.entries(b.prices ?? {})) {
        ensure(kind !== 'group', 422, 'Grupa wariantów nie ma ceny sprzedaży');
        if (Number(g) === BASE) write.price = minor(v);
        else { ensure(settings.price_group_public_ids.includes(Number(g)), 422, 'Grupa cenowa nie jest przypisana do katalogu'); groups.push({ group: Number(g), price: minor(v) }); }
      }
      // LOCAL: products.price is required natively; Base has no "no price" product.
      ensure(current || write.price !== undefined, 422, 'Podaj cenę w grupie podstawowej ' + BASE);
      const local = current && !Object.keys(write).length ? current.id : await n.saveProduct(catalog, current?.id ?? null, write);
      await writeGroupPrices(n, groups.map(x => ({ product_id: local, ...x })));
      const response = { product_id: current ? current.public_id : await n.productPublicId(local), warnings: {} };
      if (clientKey) await n.remember(clientKey, response);
      return response;
    });
  }

  /** Native deleted state (225), never a physical delete: refusals are the native
   * 409 reasons; an already deleted product is absent (404) unless the request
   * is replayed with the same Idempotency-Key. */
  async function deleteProduct(actor: Actor, parameters: Record<string, BaseWireJson>, options: { clientKey?: string; credential?: string }) {
    const b = deleteInput.parse(parameters);
    ensure(ports.deletions === true, 503, 'Usuwanie produktów wymaga migracji 225');
    const clientKey = command(actor, options);
    ensure(actor.role === 'admin', 403, 'Wymagana rola administratora');
    const requestHash = commandHash(actor, 'deleteInventoryProduct', parameters);
    return tx(actor, true, options.credential, async n => {
      if (clientKey) { const retained = await n.replay(clientKey, requestHash); if (retained) return retained; }
      ensure(await n.deleteProduct(b.product_id), 404, 'Nie znaleziono produktu');
      const response: Record<string, BaseWireJson> = {};
      if (clientKey) await n.remember(clientKey, response);
      return response;
    });
  }

  return {
    async execute(actor: Actor, selected: string, parameters: Record<string, BaseWireJson>, options: { clientKey?: string; credential?: string } = {}): Promise<Record<string, BaseWireJson>> {
      ensure((BASE_WIRE_INVENTORY_PIM_METHODS as readonly string[]).includes(selected), 400, 'Nieznana metoda Base magazynu');
      const m = selected as Method;
      if (m === 'updateInventoryProductsPrices') return updatePrices(actor, parameters, options);
      if (m === 'addInventoryProduct') return saveProduct(actor, parameters, options);
      if (m === 'deleteInventoryProduct') return deleteProduct(actor, parameters, options);
      if (m === 'getInventoryPriceGroups') {
        z.object({}).strict().parse(parameters);
        return tx(actor, false, undefined, async n => {
          const currency = await n.currency();
          // LOCAL: inactive lists are listed too (Base has no such state); the base group is last by ID.
          return { price_groups: [...(await n.priceGroups()).map(groupDto), { price_group_id: BASE, name: 'Cena podstawowa', description: '', currency, is_default: true,
            price_group_type: 'standard', source_price_group_id: 0, price_multiplier: 1, price_addition: 0, is_bundle_price_calculated: false, bundle_price_multiplier: 1, bundle_price_addition: 0 }] };
        });
      }
      if (m === 'getInventoryProductsStock') {
        const b = stockInput.parse(parameters);
        for (const f of stockUnsupported) if (blank(b[f]) !== undefined) throw new Problem(422, 'Filtr nie jest obsługiwany lokalnie', 'LOCAL_BASE_WIRE_UNSUPPORTED_FILTER');
        return tx(actor, false, undefined, async n => {
          const { catalog } = await head(n, b.inventory_id);
          const rows = await n.productList(catalog, { id: b.filter_id ?? null, ean: b.filter_ean ?? null, sku: b.filter_sku ?? null, name: b.filter_name ?? null,
            stock_from: b.filter_stock_from ?? null, stock_to: b.filter_stock_to ?? null, category: null, include_variants: false, descending: b.filter_sort === 'id DESC',
            page: b.page ?? 1, page_size: BASE_WIRE_INVENTORY_LIST_PAGE });
          ensure(rows.length <= BASE_WIRE_INVENTORY_LIST_PAGE, 500, 'Natywna strona produktów przekracza limit');
          const mains = rows.length ? await n.products(catalog, rows.map(r => r.public_id)) : [];
          const variants = mains.length ? await n.variants(catalog, mains.map(p => p.id)) : [];
          const map = (p: BaseWireInventoryProduct, field: 'on_hand'|'reserved', nonzero = false) =>
            Object.fromEntries(p.stock.filter(s => !nonzero || s[field] !== 0).map(s => [warehouseKey(s.warehouse_public_id), s[field]]));
          const products: Record<string, BaseWireJson> = {};
          for (const p of mains) {
            const own = variants.filter(v => v.parent_public_id === p.public_id);
            // LOCAL: reservations are always native; variant_reservations only for
            // products with variants, only variants/warehouses with a nonzero reservation.
            products[String(p.public_id)] = { product_id: p.public_id, stock: map(p, 'on_hand'), reservations: map(p, 'reserved'),
              variants: Object.fromEntries(own.map(v => [String(v.public_id), map(v, 'on_hand')])),
              ...(own.length ? { variant_reservations: Object.fromEntries(own.filter(v => v.stock.some(s => s.reserved !== 0)).map(v => [String(v.public_id), map(v, 'reserved', true)])) } : {}) };
          }
          return { products };
        });
      }
      const b = pricesInput.parse(parameters);
      return tx(actor, false, undefined, async n => {
        const { catalog, settings } = await head(n, b.inventory_id);
        const rows = await n.productList(catalog, { id: null, ean: null, sku: null, name: null, stock_from: null, stock_to: null, category: null, include_variants: false,
          descending: false, page: b.page ?? 1, page_size: BASE_WIRE_INVENTORY_LIST_PAGE });
        ensure(rows.length <= BASE_WIRE_INVENTORY_LIST_PAGE, 500, 'Natywna strona produktów przekracza limit');
        const mains = rows.length ? await n.products(catalog, rows.map(r => r.public_id)) : [];
        const variants = mains.length ? await n.variants(catalog, mains.map(p => p.id)) : [];
        const all = [...mains, ...variants], rowsById = new Map(all.length ? (await n.prices(all.map(p => p.id))).map(r => [r.product_id, r]) : []);
        const assigned = new Set(settings.price_group_public_ids), groups = (await n.priceGroups()).filter(g => assigned.has(g.public_id)), currency = await n.currency();
        const products: Record<string, BaseWireJson> = {};
        for (const p of mains) products[String(p.public_id)] = { product_id: p.public_id, prices: effectivePrices(p.kind, rowsById.get(p.id), groups, currency),
          variants: Object.fromEntries(variants.filter(v => v.parent_public_id === p.public_id).map(v => [String(v.public_id), effectivePrices(v.kind, rowsById.get(v.id), groups, currency)])) };
        return { products };
      });
    },
  };
}
export type BaseWireInventoryPimService = ReturnType<typeof createBaseWireInventoryPimService>;
