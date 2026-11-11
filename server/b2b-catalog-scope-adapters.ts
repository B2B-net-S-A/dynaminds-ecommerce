import type { Pool, PoolClient } from 'pg';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { ensure } from './errors';
import { b2bCatalogScopeAvailable } from './b2b-catalog-scope';
import { warehouseInventoryPoliciesAvailable } from './warehouse-inventory-policies';
import { warehousePolicyMapSQL, warehousePolicySellableQuantitySQL } from './warehouse-sellability';

// INTERNAL server adapters, not routes or a DB session-principal protocol.
// Callers admit WMS/purchasing first, then obtain catalog locks BEFORE their
// account/link/product/stock row locks. They retain their own terminal IAM.
const uuid = z.uuid().transform(v => v.toLowerCase());
const selection = z.array(uuid).min(1).max(500).refine(v => new Set(v).size === v.length, 'Powtórzony produkt');
const pageInput = z.strictObject({ after: uuid.optional(), search: z.string().trim().max(100).default(''),
  ids: selection.optional(), limit: z.number().int().min(1).max(500).default(50) });
type Mode = 'legacy_default' | 'catalog_scope_v1';
export type B2BSupplierCatalogFrame = Readonly<{ mode: Mode; tenant_id: string; account_id: string; account_version: string;
  catalog_id: string; catalog_version: string; operation_id: string | null; scope_version: string | null;
  warehouse_id: string; price_list_id: string; price_list_version: string; currency: string; language: string }>;
export type B2BBuyerCatalogFrame = Readonly<{ mode: Mode; tenant_id: string; link_id: string; link_version: string;
  supplier_tenant_id: string; account_id: string; target_catalog_id: string; target_catalog_version: string;
  operation_id: string | null; scope_version: string | null }>;
export type B2BCatalogPair = Readonly<{ buyer: B2BBuyerCatalogFrame; supplier: B2BSupplierCatalogFrame }>;
type Frame = B2BSupplierCatalogFrame | B2BBuyerCatalogFrame;
type Binding = { client: PoolClient; txid: string };
const frames = new WeakMap<object, Binding>();
const pairs = new WeakMap<object, Binding>();

/** Metadata only: callable under app on genuinely older copies; no private
 * function EXECUTE. Any surviving artifact closes the unrestricted fallback. */
export async function b2bCatalogScopeMetadataPresent(c: Pool | PoolClient): Promise<boolean> {
  return (await c.query(`SELECT EXISTS(SELECT 1 FROM pg_proc WHERE pronamespace='public'::regnamespace
      AND proname LIKE 'b2b_catalog_scope_%')
    OR EXISTS(SELECT 1 FROM pg_class WHERE relnamespace='public'::regnamespace
      AND(relname LIKE 'b2b_catalog_scope_%' OR relname LIKE 'b2b_catalog_bindings%'
        OR relname IN('b2b_supplier_catalog_scopes','b2b_buyer_catalog_scopes')))
    OR EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('public.b2b_catalog_runs') AND NOT attisdropped
      AND attname IN('catalog_scope','catalog_scope_hash')) present`)).rows[0].present;
}

async function context(c: PoolClient, tenant: string) {
  const row = (await c.query(`SELECT current_user role,session_user login,
    current_setting('app.tenant_id',true) tenant,pg_current_xact_id()::text txid,
    pg_get_userbyid(relowner) owner FROM pg_class WHERE oid='public.b2b_accounts'::regclass`)).rows[0];
  ensure(row && row.tenant === tenant && row.login === row.owner && [row.owner, 'dyna_app'].includes(row.role),
    403, 'Niezgodny kontekst adaptera katalogu B2B');
  return row as { role: string; tenant: string; txid: string; owner: string; login: string };
}
async function ownerRead<T>(c: PoolClient, tenant: string, body: () => Promise<T>): Promise<T> {
  const original = await context(c, tenant); let failed = false;
  try {
    if (original.role === 'dyna_app') await c.query('RESET ROLE');
    const value = await body();
    ensure((await context(c, tenant)).txid === original.txid, 409, 'Adapter wymaga jednej otwartej transakcji');
    return value;
  } catch (error) { failed = true; throw error; }
  finally {
    try {
      await c.query("SELECT set_config('app.tenant_id',$1,true)", [original.tenant]);
      if (original.role === 'dyna_app') await c.query('SET LOCAL ROLE dyna_app');
    } catch (error) { if (!failed) throw error; /* SQL-aborted caller must ROLLBACK. */ }
  }
}
async function shared(c: PoolClient, tenant: string) {
  await c.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))', ['catalog:' + tenant]);
}
async function catalogHead(c: PoolClient, tenant: string, id?: string) {
  ensure((await c.query('SELECT public.product_catalog_guards() ok')).rows[0]?.ok, 503, 'Niekompletne katalogi B2B');
  const row = (await c.query(`SELECT id FROM product_catalogs WHERE tenant_id=$1
    AND ${id ? 'id=$2' : 'is_default'} FOR SHARE`, id ? [tenant, id] : [tenant])).rows[0];
  ensure(row, 404, 'Nie znaleziono własnego katalogu B2B');
  const head = (await c.query('SELECT public.product_catalog_head($1) head', [row.id])).rows[0].head;
  ensure(head?.active, 409, 'Katalog B2B jest nieaktywny');
  return head;
}
async function bind<T extends Frame>(c: PoolClient, value: T): Promise<T> {
  const ctx = await context(c, value.tenant_id);
  const frame = Object.freeze(value); frames.set(frame, { client: c, txid: ctx.txid }); return frame;
}
async function bound(c: PoolClient, frame: Frame) {
  const binding = frames.get(frame);
  ensure(binding?.client === c && binding.txid === (await context(c, frame.tenant_id)).txid,
    409, 'Ramka B2B nie należy do bieżącej transakcji');
}

/** Authenticated account ID or persisted link account only; never request tenant. */
export async function guardSupplierB2BCatalogScopeInTx(c: PoolClient,
  input: { tenantId: string; accountId: string; expected?: B2BSupplierCatalogFrame }): Promise<B2BSupplierCatalogFrame> {
  const tenant = uuid.parse(input.tenantId), id = uuid.parse(input.accountId);
  await context(c, tenant); await shared(c, tenant);
  const value = await ownerRead(c, tenant, async () => {
    const installed = await b2bCatalogScopeAvailable(c);
    const a = (await c.query('SELECT id,version,active,warehouse_id,price_list_id FROM b2b_accounts WHERE tenant_id=$1 AND id=$2 FOR SHARE', [tenant, id])).rows[0];
    ensure(a, 404, 'Nie znaleziono własnego konta B2B'); ensure(a.active, 409, 'Konto B2B jest nieaktywne');
    const s = installed ? (await c.query('SELECT * FROM b2b_supplier_catalog_scopes WHERE tenant_id=$1 AND account_id=$2', [tenant, id])).rows[0] : null;
    const head = await catalogHead(c, tenant, s?.catalog_id);
    ensure(!s || (s.warehouse_id === a.warehouse_id && s.price_list_id === a.price_list_id), 409, 'Konto nie odpowiada zakresowi katalogu B2B');
    const wh = (await c.query('SELECT id FROM warehouses WHERE tenant_id=$1 AND id=$2 FOR SHARE', [tenant, a.warehouse_id])).rows[0];
    const list = (await c.query('SELECT id,version,currency,active FROM price_lists WHERE tenant_id=$1 AND id=$2 FOR SHARE', [tenant, a.price_list_id])).rows[0];
    const language = s?.language ?? head.default_language;
    ensure(wh && list?.active && head.warehouse_ids.includes(wh.id) && head.price_list_ids.includes(list.id)
      && head.languages.includes(language), 409, 'Magazyn, cennik lub język nie należą do katalogu B2B');
    return { mode: s ? 'catalog_scope_v1' as const : 'legacy_default' as const, tenant_id: tenant, account_id: id,
      account_version: String(a.version), catalog_id: head.id, catalog_version: String(head.version),
      operation_id: s?.operation_id ?? null, scope_version: s ? String(s.version) : null,
      warehouse_id: wh.id, price_list_id: list.id, price_list_version: String(list.version), currency: list.currency, language };
  });
  ensure(!input.expected || isDeepStrictEqual(value, input.expected), 409, 'Zakres dostawcy B2B zmienił się');
  return bind(c, value);
}

export async function guardBuyerB2BCatalogScopeInTx(c: PoolClient,
  input: { tenantId: string; linkId: string; expected?: B2BBuyerCatalogFrame }): Promise<B2BBuyerCatalogFrame> {
  const tenant = uuid.parse(input.tenantId), id = uuid.parse(input.linkId);
  await context(c, tenant); await shared(c, tenant);
  const value = await ownerRead(c, tenant, async () => {
    const installed = await b2bCatalogScopeAvailable(c);
    const l = (await c.query('SELECT id,version,supplier_tenant_id,account_id,paused FROM b2b_links WHERE tenant_id=$1 AND id=$2 FOR SHARE', [tenant, id])).rows[0];
    ensure(l, 404, 'Nie znaleziono własnego powiązania B2B'); ensure(!l.paused, 409, 'Powiązanie B2B jest wstrzymane');
    const s = installed ? (await c.query('SELECT * FROM b2b_buyer_catalog_scopes WHERE tenant_id=$1 AND link_id=$2', [tenant, id])).rows[0] : null;
    const head = await catalogHead(c, tenant, s?.target_catalog_id);
    ensure(!(await c.query(`SELECT 1 FROM b2b_catalog_items i JOIN products p ON(p.tenant_id,p.id)=(i.tenant_id,i.product_id)
      WHERE i.tenant_id=$1 AND i.link_id=$2 AND p.catalog_id<>$3 LIMIT 1`, [tenant, id, head.id])).rowCount,
      409, 'Powiązany produkt pochodzi z innego katalogu B2B');
    return { mode: s ? 'catalog_scope_v1' as const : 'legacy_default' as const, tenant_id: tenant, link_id: id,
      link_version: String(l.version), supplier_tenant_id: l.supplier_tenant_id, account_id: l.account_id,
      target_catalog_id: head.id, target_catalog_version: String(head.version), operation_id: s?.operation_id ?? null,
      scope_version: s ? String(s.version) : null };
  });
  ensure(!input.expected || isDeepStrictEqual(value, input.expected), 409, 'Zakres odbiorcy B2B zmienił się');
  return bind(c, value);
}

/** Must precede ownLink/account FOR UPDATE; supplier is derived, not supplied. */
export async function guardB2BCatalogPairInTx(c: PoolClient,
  input: { tenantId: string; linkId: string; expected?: B2BCatalogPair;
    purpose?: 'read' | 'create_product' | 'bind_product'; readOnly?: boolean }): Promise<B2BCatalogPair> {
  const writing = input.purpose === 'create_product' || input.purpose === 'bind_product';
  ensure(!writing || !input.readOnly, 423, 'Kopia jest tylko do odczytu');
  const tenant = uuid.parse(input.tenantId), id = uuid.parse(input.linkId), start = await context(c, tenant);
  const ref = (await c.query('SELECT supplier_tenant_id,account_id FROM b2b_links WHERE tenant_id=$1 AND id=$2', [tenant, id])).rows[0];
  ensure(ref, 404, 'Nie znaleziono własnego powiązania B2B');
  const supplierTenant = uuid.parse(ref.supplier_tenant_id);
  ensure(supplierTenant !== tenant, 409, 'Niepoprawna para firm B2B');
  for (const t of [tenant, supplierTenant].sort()) {
    if (t === tenant && writing) await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['catalog:' + t]);
    else await shared(c, t);
  }
  const buyer = await guardBuyerB2BCatalogScopeInTx(c, { tenantId: tenant, linkId: id, expected: input.expected?.buyer });
  ensure(buyer.supplier_tenant_id === supplierTenant && buyer.account_id === ref.account_id, 409, 'Dostawca B2B zmienił się podczas blokowania');
  let supplier: B2BSupplierCatalogFrame;
  try {
    await c.query("SELECT set_config('app.tenant_id',$1,true)", [supplierTenant]);
    supplier = await guardSupplierB2BCatalogScopeInTx(c, { tenantId: supplierTenant, accountId: buyer.account_id, expected: input.expected?.supplier });
  } finally { await c.query("SELECT set_config('app.tenant_id',$1,true)", [tenant]).catch(() => undefined); }
  ensure((await context(c, tenant)).txid === start.txid, 409, 'Para B2B wymaga jednej transakcji');
  const pair = Object.freeze({ buyer, supplier }); pairs.set(pair, { client: c, txid: start.txid }); return pair;
}
export async function assertB2BCatalogFrameFreshInTx(c: PoolClient, frame: Frame) {
  await bound(c, frame);
  if ('account_version' in frame) await guardSupplierB2BCatalogScopeInTx(c, { tenantId: frame.tenant_id, accountId: frame.account_id, expected: frame });
  else await guardBuyerB2BCatalogScopeInTx(c, { tenantId: frame.tenant_id, linkId: frame.link_id, expected: frame });
}

/** Quote/publication IDs and create/link products must all belong to one pool. */
export async function assertB2BCatalogProductsInTx(c: PoolClient, frame: Frame, productIds: unknown) {
  const ids = selection.parse(productIds); await assertB2BCatalogFrameFreshInTx(c, frame);
  const catalogId = 'catalog_id' in frame ? frame.catalog_id : frame.target_catalog_id;
  const rows = (await c.query(`SELECT p.id,p.kind FROM products p WHERE p.tenant_id=$1 AND p.id=ANY($2::uuid[])
    AND p.catalog_id=$3 AND p.active AND p.kind<>'group' ORDER BY p.id FOR SHARE`, [frame.tenant_id, ids, catalogId])).rows;
  ensure(rows.length === ids.length, 404, 'Produkt nie należy do wybranego katalogu B2B');
  ensure(!(await c.query(`SELECT 1 FROM bundle_components b JOIN products p ON(p.tenant_id,p.id)=(b.tenant_id,b.product_id)
    WHERE b.tenant_id=$1 AND b.bundle_id=ANY($2::uuid[]) AND (p.catalog_id<>$3 OR NOT p.active) LIMIT 1`, [frame.tenant_id, ids, catalogId])).rowCount,
    409, 'Składnik zestawu nie należy do aktywnego katalogu B2B');
  return ids;
}
export async function assertB2BBuyerCatalogWarehouseInTx(c: PoolClient, frame: B2BBuyerCatalogFrame, warehouseId: string, readOnly = false) {
  ensure(!readOnly, 423, 'Kopia jest tylko do odczytu');
  const id = uuid.parse(warehouseId); await assertB2BCatalogFrameFreshInTx(c, frame);
  ensure((await c.query('SELECT 1 FROM warehouses WHERE tenant_id=$1 AND id=$2', [frame.tenant_id, id])).rowCount,
    404, 'Nie znaleziono własnego magazynu B2B');
  const assigned = await ownerRead(c, frame.tenant_id, () => c.query(
    'SELECT 1 FROM product_catalog_warehouses WHERE tenant_id=$1 AND catalog_id=$2 AND warehouse_id=$3',
    [frame.tenant_id, frame.target_catalog_id, id]));
  ensure(assigned.rowCount, 409, 'Magazyn nie należy do katalogu odbiorcy B2B');
}

/** Read-only bounded page, exact supplier resources and language, no rescale or write. */
export async function readB2BSupplierCatalogPageInTx(c: PoolClient, frame: B2BSupplierCatalogFrame, input: unknown = {}) {
  const q = pageInput.parse(input); await assertB2BCatalogFrameFreshInTx(c, frame);
  ensure(!q.ids || q.ids.length <= q.limit, 422, 'Wybrane produkty wymagają pełnej strony B2B');
  if (q.ids) await assertB2BCatalogProductsInTx(c, frame, q.ids);
  const warehousePolicies = await warehouseInventoryPoliciesAvailable(c);
  const saleStock = warehousePolicySellableQuantitySQL('wp.policy', 's.available');
  const saleComponent = warehousePolicySellableQuantitySQL('wp.policy', 'bs.available');
  const rows = (await c.query(`${warehousePolicyMapSQL(warehousePolicies, {warehouseParam: 2})} SELECT p.id,p.sku,coalesce(tr.name,p.name) name,p.vat,
    coalesce(tr.description,p.description) description,p.attributes,p.images,p.kind,i.price,
    CASE WHEN p.kind='bundle' THEN coalesce((SELECT min(CASE WHEN x.active THEN floor(${saleComponent}::numeric/b.quantity) ELSE 0 END)::int
      FROM bundle_components b JOIN products x ON(x.tenant_id,x.id)=(b.tenant_id,b.product_id)
      LEFT JOIN stock bs ON(bs.tenant_id,bs.product_id,bs.warehouse_id)=(b.tenant_id,b.product_id,$2) WHERE b.tenant_id=p.tenant_id AND b.bundle_id=p.id),0)
      ELSE ${saleStock} END available
    FROM price_list_items i JOIN products p ON(p.tenant_id,p.id)=(i.tenant_id,i.product_id)
    JOIN warehouse_policy_map wp ON wp.tenant_id=p.tenant_id AND wp.id=$2
    LEFT JOIN stock s ON(s.tenant_id,s.product_id,s.warehouse_id)=(p.tenant_id,p.id,$2)
    LEFT JOIN product_translations tr ON(tr.tenant_id,tr.product_id,tr.locale)=(p.tenant_id,p.id,$7)
    WHERE p.tenant_id=$8 AND p.catalog_id=$9 AND i.price_list_id=$1 AND p.active AND p.kind<>'group'
      AND ($3::uuid IS NULL OR p.id>$3) AND ($4='' OR strpos(lower(p.sku||' '||coalesce(tr.name,p.name)),lower($4))>0)
      AND ($5::uuid[] IS NULL OR p.id=ANY($5)) ORDER BY p.id LIMIT $6`,
  [frame.price_list_id, frame.warehouse_id, q.after ?? null, q.search, q.ids ?? null, q.limit + 1, frame.language, frame.tenant_id, frame.catalog_id])).rows;
  if (rows.length) await assertB2BCatalogProductsInTx(c, frame, rows.slice(0, q.limit).map(row => row.id));
  if (q.ids) ensure(rows.length === q.ids.length, 404, 'Produkt nie jest opublikowany w cenniku katalogu B2B');
  return { data: rows.slice(0, q.limit), next: rows.length > q.limit ? rows[q.limit - 1].id : null,
    currency: frame.currency, list_version: Number(frame.price_list_version), scope: frame };
}

/** Provenance for staging/items. Persist it; don't expose internal frames as DTO. */
export async function b2bCatalogSourceSnapshotInTx(c: PoolClient, pair: B2BCatalogPair, sourceProductId: string) {
  const binding = pairs.get(pair), current = await context(c, pair.buyer.tenant_id);
  ensure(binding?.client === c && binding.txid === current.txid, 409, 'Para B2B nie należy do bieżącej transakcji');
  await assertB2BCatalogFrameFreshInTx(c, pair.buyer);
  try {
    await c.query("SELECT set_config('app.tenant_id',$1,true)", [pair.supplier.tenant_id]);
    const page = await readB2BSupplierCatalogPageInTx(c, pair.supplier, { ids: [sourceProductId], limit: 1 });
    ensure(page.data.length === 1, 404, 'Dostawca wycofał produkt');
    return { ...page.data[0], currency: page.currency, catalog_scope: { protocol: 'b2b_catalog_snapshot_v1', buyer: pair.buyer, supplier: pair.supplier } };
  } finally { await c.query("SELECT set_config('app.tenant_id',$1,true)", [pair.buyer.tenant_id]).catch(() => undefined); }
}
export async function assertB2BCatalogSourceSnapshotInTx(c: PoolClient, pair: B2BCatalogPair, sourceProductId: string, snapshot: unknown) {
  const actual = await b2bCatalogSourceSnapshotInTx(c, pair, sourceProductId);
  ensure(snapshotMatches(pair, actual, snapshot), 409, 'Oferta lub zakres katalogu B2B zmieniły się');
}

function snapshotMatches(pair: B2BCatalogPair, actual: Record<string, unknown>, snapshot: unknown) {
  if (isDeepStrictEqual(actual, snapshot)) return true;
  // Existing unconfigured activity may have the original unstamped shape.
  // Neither configured side may adopt it as evidence of a new scoped source.
  if (pair.buyer.mode !== 'legacy_default' || pair.supplier.mode !== 'legacy_default'
    || !snapshot || typeof snapshot !== 'object' || Object.hasOwn(snapshot, 'catalog_scope')) return false;
  const { catalog_scope: _scope, ...legacy } = actual;
  return isDeepStrictEqual(legacy, snapshot);
}

/** Current persisted buyer items, exact remote source facts, and local pool.
 * One bounded supplier page validates the whole selection; no per-row reframe. */
export async function assertB2BBuyerCatalogItemsInTx(c: PoolClient, pair: B2BCatalogPair, itemIds: unknown, requireLinked = true, allowLiveLegacyQuote = false) {
  const ids = selection.parse(itemIds), binding = pairs.get(pair);
  ensure(binding?.client === c && binding.txid === (await context(c, pair.buyer.tenant_id)).txid,
    409, 'Para B2B nie należy do bieżącej transakcji');
  await assertB2BCatalogFrameFreshInTx(c, pair.buyer);
  const items = (await c.query(`SELECT id,source_product_id,product_id,snapshot,version,fingerprint,published FROM b2b_catalog_items
    WHERE tenant_id=$1 AND link_id=$2 AND id=ANY($3::uuid[]) AND published ORDER BY id FOR SHARE`,
  [pair.buyer.tenant_id, pair.buyer.link_id, ids])).rows;
  ensure(items.length === ids.length && (!requireLinked || items.every(item => item.product_id)),
    404, 'Nie znaleziono aktualnej powiązanej oferty B2B');
  const local = items.filter(item => item.product_id).map(item => item.product_id);
  if (local.length) await assertB2BCatalogProductsInTx(c, pair.buyer, [...new Set(local)]);
  try {
    await c.query("SELECT set_config('app.tenant_id',$1,true)", [pair.supplier.tenant_id]);
    const page = await readB2BSupplierCatalogPageInTx(c, pair.supplier, { ids: items.map(item => item.source_product_id), limit: items.length });
    for (const item of items) {
      const product = page.data.find(product => product.id === item.source_product_id);
      const actual = { ...product, currency: page.currency,
        catalog_scope: { protocol: 'b2b_catalog_snapshot_v1', buyer: pair.buyer, supplier: pair.supplier } };
      const liveLegacyQuote = allowLiveLegacyQuote && pair.buyer.mode === 'legacy_default' && pair.supplier.mode === 'legacy_default';
      ensure(product && (liveLegacyQuote || snapshotMatches(pair, actual, item.snapshot)), 409, 'Oferta lub zakres katalogu B2B zmieniły się');
    }
  } finally { await c.query("SELECT set_config('app.tenant_id',$1,true)", [pair.buyer.tenant_id]).catch(() => undefined); }
  return items;
}

/** Saved GET snapshots retain their recorded price/availability even after
 * source changes. Validate only persisted identities and both current pools;
 * publication, activity and commercial freshness belong to write guards. */
export async function assertB2BBuyerCatalogItemPoolsInTx(c: PoolClient, pair: B2BCatalogPair, itemIds: unknown) {
  const ids = selection.parse(itemIds), binding = pairs.get(pair);
  ensure(binding?.client === c && binding.txid === (await context(c, pair.buyer.tenant_id)).txid,
    409, 'Para B2B nie należy do bieżącej transakcji');
  const items = (await c.query(`SELECT id,source_product_id,product_id,snapshot,version,fingerprint,published FROM b2b_catalog_items
    WHERE tenant_id=$1 AND link_id=$2 AND id=ANY($3::uuid[]) ORDER BY id FOR SHARE`,
  [pair.buyer.tenant_id, pair.buyer.link_id, ids])).rows;
  ensure(items.length === ids.length, 404, 'Nie znaleziono własnej zapisanej oferty B2B');
  const localIds = [...new Set(items.filter(item => item.product_id).map(item => item.product_id))];
  if (localIds.length) ensure((await c.query(`SELECT id FROM products WHERE tenant_id=$1 AND id=ANY($2::uuid[])
    AND catalog_id=$3 ORDER BY id FOR SHARE`, [pair.buyer.tenant_id, localIds, pair.buyer.target_catalog_id])).rowCount === localIds.length,
    404, 'Produkt nie należy do wybranego katalogu odbiorcy B2B');
  const sourceIds = [...new Set(items.map(item => item.source_product_id))];
  try {
    await c.query("SELECT set_config('app.tenant_id',$1,true)", [pair.supplier.tenant_id]);
    ensure((await c.query(`SELECT id FROM products WHERE tenant_id=$1 AND id=ANY($2::uuid[])
      AND catalog_id=$3 ORDER BY id FOR SHARE`, [pair.supplier.tenant_id, sourceIds, pair.supplier.catalog_id])).rowCount === sourceIds.length,
      404, 'Produkt nie należy do wybranego katalogu dostawcy B2B');
  } finally { await c.query("SELECT set_config('app.tenant_id',$1,true)", [pair.buyer.tenant_id]).catch(() => undefined); }
  return items;
}
