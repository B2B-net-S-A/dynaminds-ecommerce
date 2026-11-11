import type { PoolClient } from 'pg';
import { z } from 'zod';
import { ensure } from './errors';
import { productCatalogsAvailable, productCatalogOptionsInTx } from './product-catalogs';
import { warehouseInventoryPoliciesAvailable } from './warehouse-inventory-policies';
import { warehousePolicyMapSQL, warehousePolicySellableQuantitySQL } from './warehouse-sellability';

export type CatalogExportSourceDefinition = {
  catalog_id?: string;
  catalog_version?: string;
  columns: readonly string[];
  warehouse_ids?: readonly string[];
  price_list_ids?: readonly string[];
};
export type CatalogExportSourceWarehouse = { id: string; name: string; code: string };
export type CatalogExportSourcePriceList = {
  id: string;
  name: string;
  currency: string;
  version: number;
  active: boolean;
  fallback: boolean;
};
type FramedPriceList = CatalogExportSourcePriceList & {
  adjustment_bps: number;
  adjustment_amount: number;
};
export type CatalogExportSourceFrame = {
  tenant_id: string;
  warehouses: CatalogExportSourceWarehouse[];
  price_lists: FramedPriceList[];
  catalog?: CatalogExportCatalog;
};
export type CatalogExportCatalog = {
  id: string; name: string; active: boolean; is_default: boolean; version: string;
  warehouse_ids: string[]; price_list_ids: string[];
};
export async function catalogExportCatalogsAvailable(c: PoolClient): Promise<boolean> {
  const catalogsAvailable = await productCatalogsAvailable(c);
  const marker = (await c.query("SELECT to_regprocedure('public.catalog_export_catalogs_installed()') marker, EXISTS(SELECT 1 FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'catalog_export_catalogs_%') partial")).rows[0];
  if (!marker.marker) { ensure(!marker.partial, 503, 'Niekompletny zakres katalogów eksportu'); return false; }
  ensure(catalogsAvailable, 503, 'Niekompletne katalogi produktów');
  try { ensure((await c.query('SELECT catalog_export_catalogs_guards() ok')).rows[0]?.ok, 503, 'Niekompletny zakres katalogów eksportu'); }
  catch (e: any) { if (['42P01', '42703', '42883'].includes(e.code)) ensure(false, 503, 'Niekompletny zakres katalogów eksportu'); throw e; }
  return true;
}
export async function catalogExportCatalogOptions(c: PoolClient) {
  if (!await catalogExportCatalogsAvailable(c)) return { catalog_available: false, catalogs: [] as CatalogExportCatalog[] };
  const options = await productCatalogOptionsInTx(c);
  ensure(options, 503, 'Niekompletne katalogi produktów');
  const catalogs = options.catalogs.map(p => ({ id: p.id, name: p.name, active: p.active, is_default: p.is_default,
    version: p.version, warehouse_ids: p.warehouse_ids, price_list_ids: p.price_list_ids } as CatalogExportCatalog));
  return { catalog_available: true, catalogs };
}
/** Read-only RR projection; no FOR UPDATE or public private-table SELECT. */
export async function catalogExportCatalogFrame(c: PoolClient, d: { catalog_id?: string; catalog_version?: string; warehouse_ids?: readonly string[]; price_list_ids?: readonly string[] }): Promise<CatalogExportCatalog | undefined> {
  if (!d.catalog_id) return undefined;
  const options = await catalogExportCatalogOptions(c);
  ensure(options.catalog_available, 503, 'Kopia nie obsługuje eksportu jawnego katalogu');
  const catalog = options.catalogs.find(p => p.id === d.catalog_id);
  ensure(catalog, 404, 'Nie znaleziono katalogu eksportu');
  ensure(catalog.active, 409, 'Katalog eksportu jest nieaktywny');
  ensure(d.catalog_version === undefined || catalog.version === d.catalog_version, 409, 'Konfiguracja katalogu zmieniła się; odczytaj nowy podgląd');
  ensure((d.warehouse_ids ?? []).every(id => catalog.warehouse_ids.includes(id)), 409, 'Magazyn eksportu nie jest przypisany do katalogu');
  ensure((d.price_list_ids ?? []).every(id => catalog.price_list_ids.includes(id)), 409, 'Cennik eksportu nie jest przypisany do katalogu');
  return catalog;
}
export type CatalogExportInventoryRow = {
  warehouse_id: string;
  warehouse_name: string;
  warehouse_code: string;
  status: 'available' | 'missing' | 'not_applicable' | 'unavailable';
  source: 'stock' | 'components' | null;
  on_hand: number | null;
  reserved: number | null;
  available: number | null;
};
export type CatalogExportPriceRow = {
  price_list_id: string;
  price_list_name: string;
  currency: string;
  version: number;
  own_price_minor: number | null;
  effective_price_minor: number | null;
  source: 'override' | 'rule' | null;
  status: 'available' | 'missing' | 'invalid_out_of_range' | 'not_applicable';
};
export type CatalogExportSourceValues = {
  inventory_json: CatalogExportInventoryRow[];
  prices_json: CatalogExportPriceRow[];
};
const uuid = z.uuid().transform((v) => v.toLowerCase());
const sourceIds = z
  .array(uuid)
  .min(1)
  .max(10)
  .refine((v) => new Set(v).size === v.length);
const batchIds = z
  .array(uuid)
  .max(100)
  .refine((v) => new Set(v).size === v.length);
async function modules(c: PoolClient) {
  const validator = (
    await c.query<{ available: boolean }>(
      "SELECT to_regprocedure('public.catalog_export_profile_definition_valid(jsonb)') IS NOT NULL AS available",
    )
  ).rows[0].available;
  // Probe actual schema semantics, not a migration ledger or the existence of
  // legacy stock/pricing tables (both also exist in copies with the old validator).
  const supported =
    validator &&
    (
      await c.query<{ supported: boolean }>(`SELECT catalog_export_profile_definition_valid(
   '{"format":"csv","columns":["inventory_json"],"headers":{},"spreadsheet_safe":true,"warehouse_ids":["00000000-0000-0000-0000-000000000000"]}'::jsonb
  ) IS TRUE AS supported`)
    ).rows[0].supported;
  if (!supported) return { inventory: false, prices: false };
  return (
    await c.query<{ inventory: boolean; prices: boolean }>(`SELECT
  to_regclass('public.warehouses') IS NOT NULL AND to_regclass('public.stock') IS NOT NULL
  AND to_regclass('public.bundle_components') IS NOT NULL AS inventory,
  to_regclass('public.price_lists') IS NOT NULL AND to_regclass('public.price_list_items') IS NOT NULL AS prices`)
  ).rows[0];
}
/** Own metadata only. Caller supplies current inventory-read permission; a denied
 * reader gets no warehouse names or counts, while table availability stays factual. */
export async function catalogExportSourceOptions(c: PoolClient, allowInventory: boolean, catalog?: CatalogExportCatalog) {
  const caps = await modules(c);
  const wh =
    caps.inventory && allowInventory
      ? (
          await c.query<CatalogExportSourceWarehouse>(
            "SELECT id,name,code FROM warehouses WHERE tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND ($1::uuid[] IS NULL OR id=ANY($1)) ORDER BY id LIMIT 201",
            [catalog?.warehouse_ids ?? null],
          )
        ).rows
      : [];
  const lists = caps.prices
    ? (
        await c.query<CatalogExportSourcePriceList>(
          "SELECT id,name,currency,version,active,fallback FROM price_lists WHERE tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND ($1::uuid[] IS NULL OR id=ANY($1)) ORDER BY id LIMIT 201",
          [catalog?.price_list_ids ?? null],
        )
      ).rows
    : [];
  return {
    warehouses: { available: caps.inventory, data: wh.slice(0, 200), capped: wh.length > 200 },
    price_lists: { available: caps.prices, data: lists.slice(0, 200), capped: lists.length > 200 },
  };
}
function selectors(
  d: CatalogExportSourceDefinition,
  key: 'warehouse_ids' | 'price_list_ids',
  field: string,
) {
  const selected = d.columns.includes(field),
    input = d[key];
  ensure(
    selected === (input !== undefined),
    422,
    selected ? `Wybierz źródła dla pola ${field}` : `Źródła ${key} wymagają pola ${field}`,
  );
  if (!selected) return [];
  const parsed = sourceIds.safeParse(input);
  ensure(parsed.success, 422, `Źródła ${key} wymagają od 1 do 10 różnych UUID`);
  return parsed.data;
}
/** No new locks or transactions. All reads belong to the export's existing RR
 * snapshot; provider calls, live quotes and read-committed pricing helpers are excluded. */
export async function catalogExportSourceFrame(
  c: PoolClient,
  d: CatalogExportSourceDefinition,
  tenantId: string,
): Promise<CatalogExportSourceFrame> {
  const tenant = uuid.parse(tenantId),
    whIds = selectors(d, 'warehouse_ids', 'inventory_json'),
    listIds = selectors(d, 'price_list_ids', 'prices_json'),
    caps = await modules(c);
  const catalog = await catalogExportCatalogFrame(c, d);
  ensure(
    !whIds.length || caps.inventory,
    503,
    'Źródło stanów magazynowych jest niedostępne w tej kopii',
  );
  ensure(!listIds.length || caps.prices, 503, 'Źródło cenników jest niedostępne w tej kopii');
  const warehouses = whIds.length
    ? (
        await c.query<CatalogExportSourceWarehouse>(
          'SELECT id,name,code FROM warehouses WHERE tenant_id=$1 AND id=ANY($2::uuid[])',
          [tenant, whIds],
        )
      ).rows
    : [];
  ensure(
    warehouses.length === whIds.length,
    422,
    'Wybrany magazyn nie istnieje lub nie należy do tej firmy',
  );
  const priceLists = listIds.length
    ? (
        await c.query<FramedPriceList>(
          'SELECT id,name,currency,version,active,fallback,adjustment_bps,adjustment_amount FROM price_lists WHERE tenant_id=$1 AND id=ANY($2::uuid[])',
          [tenant, listIds],
        )
      ).rows
    : [];
  ensure(
    priceLists.length === listIds.length && priceLists.every((p) => p.active),
    422,
    'Wybrany cennik jest nieaktywny, nie istnieje lub nie należy do tej firmy',
  );
  const whById = new Map(warehouses.map((w) => [w.id, w])),
    listById = new Map(priceLists.map((p) => [p.id, p]));
  return {
    tenant_id: tenant,
    warehouses: whIds.map((id) => whById.get(id)!),
    price_lists: listIds.map((id) => listById.get(id)!),
    ...(catalog ? { catalog } : {}),
  };
}
type ProductPrice = { id: string; kind: string; price: number };
type StockProjection = {
  product_id: string;
  warehouse_id: string;
  kind: string;
  on_hand: number | null;
  reserved: number | null;
  available: number | null;
  component_count: number;
  components_active: boolean | null;
  component_available: number | null;
};
/** <=100 product rows, <=10 sources each. Component arithmetic stays in SQL:
 * even a large bundle never materializes every physical component in Node. */
export async function catalogExportSourceRows(
  c: PoolClient,
  productIDs: string[],
  frame: CatalogExportSourceFrame,
  catalogCurrency: string,
): Promise<Map<string, CatalogExportSourceValues>> {
  const parsed = batchIds.safeParse(productIDs);
  ensure(parsed.success, 422, 'Partia źródeł eksportu dopuszcza najwyżej 100 różnych produktów');
  const ids = parsed.data;
  if (!ids.length) return new Map();
  const products = (
    await c.query<ProductPrice>(
      'SELECT id,kind,price FROM products WHERE tenant_id=$1 AND id=ANY($2::uuid[])',
      [frame.tenant_id, ids],
    )
  ).rows;
  ensure(
    products.length === ids.length,
    422,
    'Produkt źródła eksportu nie istnieje lub nie należy do tej firmy',
  );
  if (frame.catalog) {
    const scoped = (await c.query<{ count: number }>('SELECT count(*)::int count FROM products WHERE tenant_id=$1 AND catalog_id=$2 AND id=ANY($3::uuid[])', [frame.tenant_id, frame.catalog.id, ids])).rows[0].count;
    ensure(scoped === ids.length, 409, 'Partia źródeł zawiera produkt innego katalogu');
  }
  const result = new Map<string, CatalogExportSourceValues>(
      ids.map((id) => [id, { inventory_json: [], prices_json: [] }]),
    ),
    productById = new Map(products.map((p) => [p.id, p]));
  if (frame.warehouses.length) {
    const warehousePolicies = await warehouseInventoryPoliciesAvailable(c);
    const saleStock = warehousePolicySellableQuantitySQL('w.policy', 's.available');
    const saleComponent = warehousePolicySellableQuantitySQL('w.policy', 'cs.available');
    const rows = (
      await c.query<StockProjection>(
        `${warehousePolicyMapSQL(warehousePolicies, {warehouseArrayParam: 3})} SELECT p.id AS product_id,w.id AS warehouse_id,p.kind,
   s.on_hand,s.reserved,${saleStock} AS available,
   coalesce(b.component_count,0)::integer AS component_count,b.components_active,b.component_available::integer
   FROM products p CROSS JOIN warehouse_policy_map w
   LEFT JOIN stock s ON (s.tenant_id,s.product_id,s.warehouse_id)=(p.tenant_id,p.id,w.id)
   LEFT JOIN LATERAL (
    SELECT count(*)::integer AS component_count,bool_and(cp.active AND cp.kind IN ('simple','variant')) AS components_active,
     min(floor(${saleComponent}::numeric/bc.quantity)) AS component_available
    FROM bundle_components bc
    JOIN products cp ON (cp.tenant_id,cp.id)=(bc.tenant_id,bc.product_id)
    LEFT JOIN stock cs ON (cs.tenant_id,cs.product_id,cs.warehouse_id)=(bc.tenant_id,bc.product_id,w.id)
    WHERE (bc.tenant_id,bc.bundle_id)=(p.tenant_id,p.id)
   ) b ON p.kind='bundle'
   WHERE p.tenant_id=$1 AND w.tenant_id=$1 AND p.id=ANY($2::uuid[]) AND w.id=ANY($3::uuid[])`,
        [frame.tenant_id, ids, frame.warehouses.map((w) => w.id)],
      )
    ).rows;
    const byProduct = new Map<string, Map<string, StockProjection>>();
    for (const r of rows) {
      let byWarehouse = byProduct.get(r.product_id);
      if (!byWarehouse) {
        byWarehouse = new Map();
        byProduct.set(r.product_id, byWarehouse);
      }
      byWarehouse.set(r.warehouse_id, r);
    }
    for (const id of ids)
      result.get(id)!.inventory_json = frame.warehouses.map((w) => {
        const r = byProduct.get(id)?.get(w.id);
        ensure(r, 422, 'Niespójny zakres magazynów eksportu');
        const base = { warehouse_id: w.id, warehouse_name: w.name, warehouse_code: w.code };
        if (r.kind === 'group')
          return {
            ...base,
            status: 'not_applicable',
            source: null,
            on_hand: null,
            reserved: null,
            available: null,
          };
        if (r.kind === 'bundle') {
          const valid = r.component_count > 0 && r.components_active === true;
          return {
            ...base,
            status: valid ? 'available' : 'unavailable',
            source: 'components',
            on_hand: null,
            reserved: null,
            available: valid ? (r.component_available ?? 0) : 0,
          };
        }
        if (r.on_hand === null)
          return {
            ...base,
            status: 'missing',
            source: 'stock',
            on_hand: null,
            reserved: null,
            available: null,
          };
        return {
          ...base,
          status: 'available',
          source: 'stock',
          on_hand: r.on_hand,
          reserved: r.reserved,
          available: r.available,
        };
      });
  }
  if (frame.price_lists.length) {
    const entries = (
      await c.query<{ product_id: string; price_list_id: string; price: number }>(
        'SELECT product_id,price_list_id,price FROM price_list_items WHERE tenant_id=$1 AND product_id=ANY($2::uuid[]) AND price_list_id=ANY($3::uuid[])',
        [frame.tenant_id, ids, frame.price_lists.map((p) => p.id)],
      )
    ).rows;
    const byProduct = new Map<string, Map<string, number>>();
    for (const e of entries) {
      let byList = byProduct.get(e.product_id);
      if (!byList) {
        byList = new Map();
        byProduct.set(e.product_id, byList);
      }
      byList.set(e.price_list_id, e.price);
    }
    for (const id of ids)
      result.get(id)!.prices_json = frame.price_lists.map((list) => {
        const p = productById.get(id)!,
          fixed = byProduct.get(id)?.get(list.id);
        const base = {
          price_list_id: list.id,
          price_list_name: list.name,
          currency: list.currency,
          version: list.version,
        };
        if (p.kind === 'group')
          return {
            ...base,
            own_price_minor: null,
            effective_price_minor: null,
            source: null,
            status: 'not_applicable',
          };
        if (fixed === undefined && (!list.fallback || list.currency !== catalogCurrency))
          return {
            ...base,
            own_price_minor: null,
            effective_price_minor: null,
            source: null,
            status: 'missing',
          };
        const gross =
          fixed === undefined
            ? (BigInt(p.price) * BigInt(10000 + list.adjustment_bps) + 5000n) / 10000n +
              BigInt(list.adjustment_amount)
            : BigInt(fixed);
        const source = fixed === undefined ? ('rule' as const) : ('override' as const);
        if (gross < 0n || gross > 100000000n)
          return {
            ...base,
            own_price_minor: fixed ?? null,
            effective_price_minor: null,
            source,
            status: 'invalid_out_of_range',
          };
        return {
          ...base,
          own_price_minor: fixed ?? null,
          effective_price_minor: Number(gross),
          source,
          status: 'available',
        };
      });
  }
  return result;
}
