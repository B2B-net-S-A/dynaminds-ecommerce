import type { Readable } from 'node:stream';
import { constants } from 'node:fs';
import { mkdir, lstat, open, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { pool } from './db';
import type { Actor } from './domain';
import { ensure } from './errors';
import {
  catalogExportSourceOptions,
  catalogExportSourceFrame,
  catalogExportSourceRows,
  catalogExportCatalogFrame,
  catalogExportCatalogOptions,
  type CatalogExportCatalog,
} from './catalog-export-sources';
import { catalogExportCatalogFields, catalogExportCatalogScopeFields, validCatalogExportScope } from './catalog-export-schema';
import { productNotDeletedSQL } from './product-deletions';

export const CATALOG_EXPORT_LIMITS = {
  products: 100000,
  selected_products: 500,
  batch_products: 100,
  request_bytes: 65536,
  file_bytes: 67108864,
  parallel_exports: 3,
  parallel_exports_per_tenant: 1,
} as const;
export const CATALOG_EXPORT_COLUMNS = [
  { key: 'id', label: 'Identyfikator produktu', type: 'text' },
  { key: 'sku', label: 'SKU', type: 'text' },
  { key: 'ean', label: 'EAN', type: 'text' },
  { key: 'name', label: 'Nazwa', type: 'text' },
  { key: 'description', label: 'Opis', type: 'text' },
  { key: 'price_minor', label: 'Cena bazowa brutto', type: 'integer', unit: 'minor' },
  { key: 'vat_rate', label: 'VAT', type: 'integer', unit: 'percent' },
  { key: 'category', label: 'Kategoria', type: 'text' },
  { key: 'active', label: 'Aktywny', type: 'boolean' },
  { key: 'kind', label: 'Typ produktu', type: 'text' },
  { key: 'weight_g', label: 'Masa', type: 'integer', unit: 'g' },
  { key: 'length_mm', label: 'Długość', type: 'integer', unit: 'mm' },
  { key: 'width_mm', label: 'Szerokość', type: 'integer', unit: 'mm' },
  { key: 'height_mm', label: 'Wysokość', type: 'integer', unit: 'mm' },
  { key: 'manufacturer', label: 'Producent', type: 'text' },
  { key: 'attributes_json', label: 'Parametry (JSON)', type: 'json' },
  { key: 'images_json', label: 'Adresy zdjęć (JSON)', type: 'json' },
  { key: 'variants_json', label: 'Warianty (JSON)', type: 'json' },
  { key: 'bundle_components_json', label: 'Składniki zestawu (JSON)', type: 'json' },
  { key: 'translations_json', label: 'Wersje językowe (JSON)', type: 'json' },
  { key: 'inventory_json', label: 'Stany wybranych magazynów (JSON)', type: 'json' },
  { key: 'prices_json', label: 'Ceny wybranych cenników (JSON)', type: 'json' },
] as const;
export type CatalogExportColumn = (typeof CATALOG_EXPORT_COLUMNS)[number]['key'];
const column = z.enum(CATALOG_EXPORT_COLUMNS.map((c) => c.key));
const uuid = z.uuid().transform((v) => v.toLowerCase());
const ids = z
  .array(uuid)
  .min(1)
  .max(CATALOG_EXPORT_LIMITS.selected_products)
  .refine((v) => new Set(v).size === v.length, 'Powtórzone identyfikatory produktów');
const columns = z
  .array(column)
  .min(1)
  .max(CATALOG_EXPORT_COLUMNS.length)
  .refine((v) => new Set(v).size === v.length, 'Powtórzone kolumny');
const defaults: CatalogExportColumn[] = ['sku', 'ean', 'name', 'price_minor', 'vat_rate', 'active'];
const selectionFields = {
  ...catalogExportCatalogFields,
  selection: z.enum(['filtered', 'selected']).default('filtered'),
  ids: ids.optional(),
  search: z
    .string()
    .max(200)
    .refine((v) => !v.includes('\0'), 'Nieprawidłowe wyszukiwanie')
    .default(''),
  active: z.enum(['all', 'yes', 'no']).default('all'),
};
const headerNames = z.partialRecord(
  column,
  z
    .string()
    .trim()
    .refine(
      (v) => Array.from(v).length >= 1 && Array.from(v).length <= 80,
      'Nazwa pola musi zawierać od 1 do 80 znaków',
    )
    .refine(
      (v) => !/[\u0000-\u001f\u007f-\u009f\ud800-\udfff\ufffe\uffff]/u.test(v),
      'Nazwa pola zawiera niedozwolony znak',
    ),
);
const definitionFields = {
  ...catalogExportCatalogFields,
  format: z.enum(['csv', 'xml']).default('csv'),
  columns: columns.default(defaults),
  headers: headerNames.default({}),
  spreadsheet_safe: z.boolean().default(true),
  warehouse_ids: z
    .array(uuid)
    .min(1)
    .max(10)
    .refine((v) => new Set(v).size === v.length, 'Powtórzone magazyny')
    .optional(),
  price_list_ids: z
    .array(uuid)
    .min(1)
    .max(10)
    .refine((v) => new Set(v).size === v.length, 'Powtórzone cenniki')
    .optional(),
};
type Definition = {
  format: 'csv' | 'xml';
  columns: CatalogExportColumn[];
  headers: Partial<Record<CatalogExportColumn, string>>;
  warehouse_ids?: string[];
  price_list_ids?: string[];
};
const validDefinition = (v: Definition, ctx: z.RefinementCtx) => {
  for (const [field, source] of [
    ['inventory_json', 'warehouse_ids'],
    ['prices_json', 'price_list_ids'],
  ] as const) {
    if (v.columns.includes(field) !== (v[source] !== undefined))
      ctx.addIssue({
        code: 'custom',
        path: [source],
        message: 'Wybrane pole wymaga jawnego wyboru źródeł; źródła bez pola są niedozwolone',
      });
  }
  for (const key of Object.keys(v.headers)) {
    if (!v.columns.includes(key as CatalogExportColumn))
      ctx.addIssue({
        code: 'custom',
        path: ['headers', key],
        message: 'Nazwa dotyczy niewybranego pola',
      });
  }
  const names = new Set<string>();
  for (const key of v.columns) {
    const name = v.headers[key] ?? key;
    if (names.has(name.toLowerCase()))
      ctx.addIssue({
        code: 'custom',
        path: ['headers', key],
        message: 'Nazwy pól muszą być różne',
      });
    names.add(name.toLowerCase());
    if (v.format === 'xml' && (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(name) || /^xml/i.test(name)))
      ctx.addIssue({
        code: 'custom',
        path: ['headers', key],
        message: 'Nazwa XML musi być poprawną nazwą elementu bez prefiksu xml',
      });
  }
};
export const catalogExportDefinitionInput = z
  .strictObject(definitionFields)
  .superRefine(validDefinition);
export type CatalogExportDefinition = z.infer<typeof catalogExportDefinitionInput>;
const configurationFields = { ...selectionFields, ...definitionFields, ...catalogExportCatalogScopeFields };
const validSelection = (v: { selection: string; ids?: string[] }, ctx: z.RefinementCtx) => {
  if (v.selection === 'selected' && !v.ids)
    ctx.addIssue({ code: 'custom', path: ['ids'], message: 'Wybierz produkty do eksportu' });
  if (v.selection === 'filtered' && v.ids)
    ctx.addIssue({
      code: 'custom',
      path: ['ids'],
      message: 'Identyfikatory są dostępne dla zaznaczonych produktów',
    });
};
const queryIds = z
  .string()
  .max(19000)
  .transform((v) => v.split(','))
  .pipe(ids)
  .optional();
export const catalogExportOptionsQuery = z
  .strictObject({ ...selectionFields, ids: queryIds })
  .superRefine(validSelection);
export const catalogExportFileInput = z
  .strictObject(configurationFields)
  .superRefine(validSelection)
  .superRefine(validDefinition)
  .superRefine(validCatalogExportScope);
export const catalogExportFileQuery = z
  .strictObject({
    ...configurationFields,
    ids: queryIds,
    headers: z
      .string()
      .max(8192)
      .default('{}')
      .transform((v, ctx) => {
        try {
          return JSON.parse(v) as unknown;
        } catch {
          ctx.addIssue({ code: 'custom', message: 'Nazwy pól muszą być obiektem JSON' });
          return z.NEVER;
        }
      })
      .pipe(headerNames),
    warehouse_ids: queryIds
      .pipe(
        z
          .array(uuid)
          .min(1)
          .max(10)
          .refine((v) => new Set(v).size === v.length),
      )
      .optional(),
    price_list_ids: queryIds
      .pipe(
        z
          .array(uuid)
          .min(1)
          .max(10)
          .refine((v) => new Set(v).size === v.length),
      )
      .optional(),
    columns: z
      .string()
      .max(1000)
      .default(defaults.join(','))
      .transform((v) => v.split(','))
      .pipe(columns),
    spreadsheet_safe: z
      .enum(['true', 'false'])
      .default('true')
      .transform((v) => v === 'true'),
  })
  .superRefine(validSelection)
  .superRefine(validDefinition)
  .superRefine(validCatalogExportScope);
export type CatalogExportInput = z.infer<typeof catalogExportFileInput>;
type Selection = z.infer<typeof catalogExportOptionsQuery>;
type ExportActor = Actor & { apiKeyId?: string };
type Capabilities = { logistics: boolean; translations: boolean; aliases: boolean; deletions: boolean };
type BaseRow = { id: string } & Partial<Record<CatalogExportColumn, unknown>>;

/** Fresh owner-client IAM reads; caller holds its transaction through both pins.
 * Explicit catalogue finalization holds catalogue SHARED before member -> key.
 */
async function catalogExportAccessInTx(
  c: PoolClient,
  a: ExportActor,
  requiredScopes: readonly string[],
) {
    const role = (
      await c.query<{ role: string }>(
        'SELECT role FROM memberships WHERE tenant_id=$1 AND user_id=$2 FOR SHARE',
        [a.tenantId, a.userId],
      )
    ).rows[0]?.role;
    ensure(
      role && ['admin', 'operator', 'viewer'].includes(role),
      403,
      'Brak aktualnego dostępu do katalogu',
    );
    if (a.apiKeyId) {
      const key = (
        await c.query<{ valid: boolean; can_read: boolean }>(
          `SELECT revoked_at IS NULL AND expires_at>clock_timestamp() AS valid,
        scopes @> $4::text[] AS can_read FROM api_keys
        WHERE tenant_id=$1 AND user_id=$2 AND id=$3 FOR SHARE`,
          [a.tenantId, a.userId, a.apiKeyId, [...new Set(['products:read', ...requiredScopes])]],
        )
      ).rows[0];
      ensure(key?.valid, 401, 'Klucz API został cofnięty lub wygasł');
      ensure(
        key.can_read,
        403,
        'Klucz API nie ma aktualnych scope products:read' +
          (requiredScopes.includes('inventory:read') ? ' i inventory:read' : ''),
      );
    }
    return role;
}
export async function assertCatalogExportAccess(
  a: ExportActor,
  requiredScopes: readonly string[] = [],
) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query("SET LOCAL statement_timeout='8s'");
    const role = await catalogExportAccessInTx(c, a, requiredScopes);
    await c.query('COMMIT');
    return role;
  } catch (error) {
    await c.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    c.release();
  }
}

async function setupSnapshot(c: PoolClient, a: ExportActor) {
  // This reader owns no WMS/quantity writes. A separate READ ONLY transaction
  // avoids tenantTx's mutable-writer admission while still forcing tenant RLS.
  await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await c.query('SET LOCAL ROLE dyna_app');
  await c.query("SELECT set_config('app.tenant_id',$1,true)", [a.tenantId]);
  await c.query("SET LOCAL statement_timeout='8s'");
  await c.query("SET LOCAL idle_in_transaction_session_timeout='30s'");
}
async function capabilities(c: PoolClient): Promise<Capabilities> {
  return (
    await c.query<Capabilities>(`SELECT to_regclass('public.product_logistics') IS NOT NULL AS logistics,
    to_regclass('public.product_translations') IS NOT NULL AS translations,
    to_regclass('public.product_sku_aliases') IS NOT NULL AS aliases,
    to_regclass('public.product_deletions225') IS NOT NULL AS deletions`)
  ).rows[0];
}
function filter(q: Selection, caps: Capabilities) {
  const result = q.selection === 'selected' ? { sql: 'p.id=ANY($1::uuid[])', params: [q.ids!] as unknown[] } : {
    sql: `(p.name ILIKE $1 OR p.sku ILIKE $1 OR coalesce(p.ean,'') ILIKE $1
    ${caps.aliases ? 'OR EXISTS(SELECT 1 FROM product_sku_aliases a WHERE (a.tenant_id,a.product_id)=(p.tenant_id,p.id) AND a.sku ILIKE $1)' : ''})
    AND ($2::text='all' OR p.active=($2='yes'))`,
    params: [`%${q.search}%`, q.active] as unknown[],
  };
  if (q.catalog_id) {
    result.params.push(q.catalog_id);
    result.sql += ` AND p.catalog_id=$${result.params.length}::uuid`;
  }
  // A deleted product (225) leaves every export; a selected one is refused as missing.
  result.sql += ` AND ${productNotDeletedSQL(caps.deletions)}`;
  return result;
}
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([, value]) => value !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, value]) => [key, canonical(value)]));
  return v;
}
/** Configuration/filter hash, deliberately excludes live product/count facts. */
export function catalogExportScopeHash(q: CatalogExportInput, catalog: CatalogExportCatalog, sourceFrame?: unknown) {
  const { catalog_version, scope_hash, ...request } = q;
  return createHash('sha256').update(JSON.stringify(canonical({ request, catalog, ...(sourceFrame ? { sourceFrame } : {}) }))).digest('hex');
}
/** The internal frame remains complete for hashing; inventory metadata is scoped separately. */
function publicExportCatalog(catalog: CatalogExportCatalog, allowInventory: boolean): CatalogExportCatalog {
  return allowInventory ? catalog : { ...catalog, warehouse_ids: [] };
}
async function finalCatalogAccess(a: ExportActor, q: CatalogExportInput, expected: string | undefined, requiredScopes: readonly string[]) {
  if (!q.catalog_id) return assertCatalogExportAccess(a, requiredScopes);
  const c = await pool.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    await c.query("SET LOCAL statement_timeout='8s'");
    await c.query('SET LOCAL ROLE dyna_app');
    await c.query("SELECT set_config('app.tenant_id',$1,true)", [a.tenantId]);
    await c.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))', ['catalog:' + a.tenantId]);
    // Assignment writers use the catalogue exclusive lock. Resource metadata
    // writers may share it, so pin only the explicitly selected resource rows.
    if (q.warehouse_ids) await c.query('SELECT id FROM warehouses WHERE tenant_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR SHARE', [a.tenantId, q.warehouse_ids]);
    if (q.price_list_ids) await c.query('SELECT id FROM price_lists WHERE tenant_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR SHARE', [a.tenantId, q.price_list_ids]);
    const catalog = await catalogExportCatalogFrame(c, q);
    const sourceFrame = q.columns.some(k => k === 'inventory_json' || k === 'prices_json') ? await catalogExportSourceFrame(c, q, a.tenantId) : undefined;
    ensure(catalog && catalogExportScopeHash(q, catalog, sourceFrame) === expected, 409, 'Zakres katalogu zmienił się; odczytaj nowy podgląd');
    // Only the trusted owner client may read IAM tables. Resetting its local role
    // retains the catalogue locks while fresh membership/key waits finish.
    await c.query('RESET ROLE');
    const role = await catalogExportAccessInTx(c, a, requiredScopes);
    await c.query('COMMIT');
    return role;
  } catch (error) {
    await c.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    c.release();
  }
}
async function matchedCount(c: PoolClient, q: Selection, caps: Capabilities) {
  const f = filter(q, caps);
  const count = Number(
    (
      await c.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM (SELECT p.id FROM products p WHERE ${f.sql} LIMIT ${CATALOG_EXPORT_LIMITS.products + 1}) scope`,
        f.params,
      )
    ).rows[0].count,
  );
  if (q.selection === 'selected')
    ensure(
      count === q.ids!.length,
      q.catalog_id ? 409 : 422,
      q.catalog_id ? 'Wybrany produkt nie należy do jawnego katalogu' : 'Wybrany produkt nie istnieje lub nie należy do tej firmy',
    );
  return { matched_products: count, capped: count > CATALOG_EXPORT_LIMITS.products };
}
export async function catalogExportOptions(a: ExportActor, input: unknown) {
  const q = catalogExportOptionsQuery.parse(input),
    c = await pool.connect();
  try {
    await assertCatalogExportAccess(a);
    const allowInventory =
      !a.apiKeyId ||
      Boolean(
        (
          await pool.query(
            "SELECT scopes @> ARRAY['inventory:read']::text[] AS allowed FROM api_keys WHERE id=$1 AND tenant_id=$2 AND user_id=$3 AND revoked_at IS NULL AND expires_at>clock_timestamp()",
            [a.apiKeyId, a.tenantId, a.userId],
          )
        ).rows[0]?.allowed,
      );
    await setupSnapshot(c, a);
    const catalogOptions = await catalogExportCatalogOptions(c);
    const catalog = await catalogExportCatalogFrame(c, q);
    const caps = await capabilities(c),
      count = await matchedCount(c, q, caps);
    const currency = (
      await c.query<{ currency: string }>('SELECT currency FROM tenants WHERE id=$1', [a.tenantId])
    ).rows[0]?.currency;
    ensure(currency, 403, 'Brak firmy');
    const sources = await catalogExportSourceOptions(c, allowInventory, catalog);
    await c.query('COMMIT');
    const role = await assertCatalogExportAccess(a, allowInventory ? ['inventory:read'] : []);
    return {
      available: true,
      current_role: role,
      can_read: true,
      ...catalogOptions,
      catalogs: catalogOptions.catalogs.map(head => publicExportCatalog(head, allowInventory)),
      catalog: catalog ? publicExportCatalog(catalog, allowInventory) : null,
      formats: ['csv', 'xml'],
      columns: CATALOG_EXPORT_COLUMNS,
      default_columns: defaults,
      defaults: { format: 'csv', selection: 'filtered', active: 'all', spreadsheet_safe: true },
      limits: CATALOG_EXPORT_LIMITS,
      count,
      catalog_currency: currency,
      price_source: 'catalog',
      product_logistics_available: caps.logistics,
      product_translations_available: caps.translations,
      sources: { ...sources, allow_inventory: allowInventory },
    };
  } catch (error) {
    await c.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    c.release();
  }
}

/** A sample and the later file are independent consistent reads, never a price/stock reservation. */
export async function catalogExportPreview(a: ExportActor, input: unknown) {
  const q = catalogExportFileInput.parse(input);
  const requiredScopes = q.columns.includes('inventory_json') ? ['inventory:read'] : [];
  await assertCatalogExportAccess(a, requiredScopes);
  const c = await pool.connect();
  try {
    await setupSnapshot(c, a);
    const catalog = await catalogExportCatalogFrame(c, q);
    const caps = await capabilities(c),
      count = await matchedCount(c, q, caps);
    ensure(!count.capped, 422, 'Eksport przekracza 100000 produktów. Zawęź zakres.');
    const currency = (
      await c.query<{ currency: string }>('SELECT currency FROM tenants WHERE id=$1', [a.tenantId])
    ).rows[0]?.currency;
    ensure(currency, 403, 'Brak firmy');
    const sourceFrame = q.columns.some((k) => k === 'inventory_json' || k === 'prices_json')
      ? await catalogExportSourceFrame(c, q, a.tenantId)
      : undefined;
    const scopeHash = catalog ? catalogExportScopeHash(q, catalog, sourceFrame) : undefined;
    ensure(q.scope_hash === undefined || q.scope_hash === scopeHash, 409, 'Zakres katalogu zmienił się; odczytaj nowy podgląd');
    const f = filter(q, caps);
    const rows = (
      await c.query<{ product_id: string; sku: string; name: string }>(
        `SELECT p.id AS product_id,p.sku,p.name FROM products p WHERE ${f.sql} ORDER BY p.id LIMIT 3`,
        f.params,
      )
    ).rows;
    const matrices =
      sourceFrame && rows.length
        ? await catalogExportSourceRows(
            c,
            rows.map((row) => row.product_id),
            sourceFrame,
            currency,
          )
        : null;
    const sample = rows.map((row) => ({
      ...row,
      ...(q.columns.includes('inventory_json')
        ? { inventory_json: matrices?.get(row.product_id)?.inventory_json }
        : {}),
      ...(q.columns.includes('prices_json')
        ? { prices_json: matrices?.get(row.product_id)?.prices_json }
        : {}),
    }));
    await c.query('COMMIT');
    await finalCatalogAccess(a, q, scopeHash, requiredScopes);
    return { count, catalog_currency: currency, sample, sample_limit: 3, read_only: true,
      // A product-only key preview never returns warehouse assignments. Stock
      // previews pin inventory:read in the final coordinator before projection.
      ...(catalog ? { catalog: publicExportCatalog(catalog, !a.apiKeyId || requiredScopes.includes('inventory:read')), catalog_version: catalog.version, scope_hash: scopeHash } : {}) };
  } catch (error) {
    await c.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    c.release();
  }
}

/** Apostrophe is a deliberate spreadsheet representation; raw mode is lossless.
 * Quotes alone do not prevent formula evaluation or EAN numeric coercion.
 */
export function catalogCsvText(value: string, key: CatalogExportColumn, safe: boolean) {
  if (
    safe &&
    value &&
    (['id', 'sku', 'ean'].includes(key) ||
      /^[\s]*[=+\-@]/u.test(value) ||
      /^[\t\r\n]/u.test(value) ||
      (CATALOG_EXPORT_COLUMNS.find((c) => c.key === key)?.type === 'text' &&
        /^[\s]*[+-]?\d+(?:[.,]\d+)?(?:[eE][+-]?\d+)?[\s]*$/u.test(value)))
  )
    return "'" + value;
  return value;
}
export const catalogCsvEscape = (text: string) => text.replace(/"/g, '""');
export function catalogXmlEscape(text: string) {
  ensure(
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ud800-\udfff\ufffe\uffff]/u.test(text),
    422,
    'Tekst katalogu zawiera znak niedozwolony w XML 1.0',
  );
  return text.replace(
    /[&<>"'\r]/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;', '\r': '&#13;' })[c]!,
  );
}
const scalarSql: Record<CatalogExportColumn, string | null> = {
  id: 'p.id',
  sku: 'p.sku',
  ean: 'p.ean',
  name: 'p.name',
  description: 'p.description',
  price_minor: 'p.price',
  vat_rate: 'p.vat',
  category: 'p.category',
  active: 'p.active',
  kind: 'p.kind',
  weight_g: 'l.weight_grams',
  length_mm: 'l.length_mm',
  width_mm: 'l.width_mm',
  height_mm: 'l.height_mm',
  manufacturer: 'l.manufacturer',
  attributes_json: 'p.attributes',
  images_json: 'p.images',
  variants_json: null,
  bundle_components_json: null,
  translations_json: null,
  inventory_json: null,
  prices_json: null,
};
const logistics = new Set<CatalogExportColumn>([
  'weight_g',
  'length_mm',
  'width_mm',
  'height_mm',
  'manufacturer',
]);

async function* relation(c: PoolClient, id: string, key: CatalogExportColumn, caps: Capabilities) {
  if (key === 'translations_json' && !caps.translations) return;
  let after: string | null = null;
  do {
    // Keyset relation pages never materialize a 100000-variant group in RAM.
    const sql =
      key === 'variants_json'
        ? `SELECT v.id cursor,jsonb_build_object('id',v.id,'sku',v.sku,'name',v.name,'attributes',v.attributes,'active',v.active) AS value
        FROM products v WHERE v.parent_id=$1 AND ${productNotDeletedSQL(caps.deletions, 'v')} AND ($2::uuid IS NULL OR v.id>$2::uuid) ORDER BY v.id LIMIT 100`
        : key === 'bundle_components_json'
          ? `SELECT b.product_id cursor,jsonb_build_object('product_id',b.product_id,'quantity',b.quantity,'sku',p.sku,'name',p.name) AS value
          FROM bundle_components b JOIN products p ON (p.tenant_id,p.id)=(b.tenant_id,b.product_id)
          WHERE b.bundle_id=$1 AND ($2::uuid IS NULL OR b.product_id>$2::uuid) ORDER BY b.product_id LIMIT 100`
          : `SELECT t.locale cursor,jsonb_build_object('locale',t.locale,'name',t.name,'description',t.description,'version',t.version) AS value
          FROM product_translations t WHERE t.product_id=$1 AND ($2::text IS NULL OR t.locale COLLATE "C">$2::text COLLATE "C")
          ORDER BY t.locale COLLATE "C" LIMIT 100`;
    const rows: { cursor: string; value: unknown }[] = (
      await c.query<{ cursor: string; value: unknown }>(sql, [id, after])
    ).rows;
    for (const row of rows) yield row.value;
    after = rows.length === 100 ? rows.at(-1)!.cursor : null;
  } while (after);
}

export type CatalogExportFile = {
  stream: Readable;
  count: number;
  currency: string;
  format: 'csv' | 'xml';
  bytes: number;
  catalog_id?: string;
  catalog_version?: string;
  scope_hash?: string;
  abort: () => void;
  dispose: () => Promise<void>;
};

/** XML arbitrary object keys are attributes, never names or unescaped markup. */
export function* catalogXmlValue(
  tag: string,
  value: unknown,
  depth = 0,
  key?: string,
): Generator<string> {
  ensure(depth <= 64, 422, 'Struktura parametrów przekracza 64 poziomy');
  const attribute = key === undefined ? '' : ` key="${catalogXmlEscape(key)}"`;
  if (value == null) {
    yield `<${tag}${attribute} nil="true"/>`;
    return;
  }
  const type = Array.isArray(value) ? 'array' : typeof value;
  yield `<${tag}${attribute} type="${type}">`;
  if (Array.isArray(value)) {
    for (const item of value) yield* catalogXmlValue('item', item, depth + 1);
  } else if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) yield* catalogXmlValue('entry', v, depth + 1, k);
  } else yield catalogXmlEscape(String(value));
  yield `</${tag}>`;
}

export const CATALOG_EXPORT_TEMP_DIR = resolve('data/catalog-export-temp');
/** Real production spool adapter, fixed byte limit (including BOM/escaping).
 * Private files have random names and are never reused or enumerated for cleanup.
 */
export async function spoolCatalogExport(
  chunks: AsyncIterable<string | Buffer>,
  signal?: AbortSignal,
) {
  await mkdir(CATALOG_EXPORT_TEMP_DIR, { recursive: true, mode: 0o700 });
  const directory = await lstat(CATALOG_EXPORT_TEMP_DIR);
  ensure(
    directory.isDirectory() && !directory.isSymbolicLink() && (directory.mode & 0o777) === 0o700,
    503,
    'Katalog tymczasowy eksportu wymaga praw 0700',
  );
  ensure(
    process.getuid === undefined || directory.uid === process.getuid(),
    503,
    'Katalog tymczasowy eksportu ma innego właściciela',
  );
  const path = resolve(CATALOG_EXPORT_TEMP_DIR, `${randomUUID()}.tmp`);
  const fd = await open(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  let disposed = false,
    bytes = 0;
  const dispose = async () => {
    if (!disposed) {
      disposed = true;
      await unlink(path);
    }
  };
  const write = async (data: Buffer) => {
    let offset = 0;
    while (offset < data.length) {
      ensure(!signal?.aborted, 499, 'Pobieranie zostało przerwane');
      const written = (await fd.write(data, offset, data.length - offset)).bytesWritten;
      ensure(written > 0, 503, 'Nie można zapisać pliku eksportu');
      offset += written;
    }
  };
  try {
    let pending: Buffer[] = [],
      pendingBytes = 0;
    const flush = async () => {
      if (pendingBytes) await write(Buffer.concat(pending, pendingBytes));
      pending = [];
      pendingBytes = 0;
    };
    for await (const chunk of chunks) {
      ensure(!signal?.aborted, 499, 'Pobieranie zostało przerwane');
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
      bytes += data.length;
      ensure(
        bytes <= CATALOG_EXPORT_LIMITS.file_bytes,
        413,
        'Eksport przekracza 64 MiB. Zawęź zakres.',
      );
      if (pendingBytes + data.length > 65536) await flush();
      if (data.length >= 65536) await write(data);
      else {
        pending.push(data);
        pendingBytes += data.length;
      }
    }
    await flush();
    ensure(!signal?.aborted, 499, 'Pobieranie zostało przerwane');
    await fd.close();
    return { path, bytes, dispose };
  } catch (error) {
    await fd.close().catch(() => {});
    await dispose();
    throw error;
  }
}

const exportingTenants = new Set<string>();
const disposingExports = new Map<string, Promise<void>>();
export async function openCatalogExport(
  a: ExportActor,
  input: unknown,
  signal?: AbortSignal,
): Promise<CatalogExportFile> {
  const q = catalogExportFileInput.parse(input);
  ensure(!q.catalog_id || (q.catalog_version !== undefined && q.scope_hash !== undefined), 422, 'Jawny katalog wymaga wersji i hash zakresu z podglądu');
  const requiredScopes = q.columns.includes('inventory_json') ? ['inventory:read'] : [];
  // A fully consumed response can reach its client before the asynchronous file
  // cleanup hook finishes. Wait for that owned cleanup only, never queue behind
  // another live export or preparation.
  const finishing = disposingExports.get(a.tenantId);
  if (finishing) await finishing;
  ensure(!signal?.aborted, 499, 'Pobieranie zostało przerwane');
  ensure(
    !exportingTenants.has(a.tenantId) &&
      exportingTenants.size < CATALOG_EXPORT_LIMITS.parallel_exports,
    429,
    'Eksport jest już wykonywany. Poczekaj na zakończenie pobierania.',
  );
  exportingTenants.add(a.tenantId);
  let c: PoolClient | undefined,
    released = false;
  let spool: Awaited<ReturnType<typeof spoolCatalogExport>> | undefined;
  let stream: Readable | undefined;
  let cleanupPromise: Promise<void> | undefined;
  const close = (destroy = false) => {
    if (c && !released) {
      released = true;
      c.release(destroy);
    }
  };
  const dispose = () => {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = Promise.resolve().then(async () => {
      if (stream && !stream.closed) {
        const closed = new Promise<void>((resolve) => stream!.once('close', resolve));
        stream.destroy();
        await closed;
      }
      try {
        if (spool) await spool.dispose();
      } finally {
        exportingTenants.delete(a.tenantId);
        disposingExports.delete(a.tenantId);
        signal?.removeEventListener('abort', abort);
      }
    });
    disposingExports.set(a.tenantId, cleanupPromise);
    return cleanupPromise;
  };
  const abort = () => {
    close(true);
    stream?.destroy();
  };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    ensure(!signal?.aborted, 499, 'Pobieranie zostało przerwane');
    await assertCatalogExportAccess(a, requiredScopes);
    c = await pool.connect();
    const reader = c;
    ensure(!signal?.aborted, 499, 'Pobieranie zostało przerwane');
    await setupSnapshot(c, a);
    const catalog = await catalogExportCatalogFrame(c, q);
    const caps = await capabilities(c),
      count = await matchedCount(c, q, caps);
    ensure(!count.capped, 422, 'Eksport przekracza 100000 produktów. Zawęź zakres.');
    const currency = (
      await c.query<{ currency: string }>('SELECT currency FROM tenants WHERE id=$1', [a.tenantId])
    ).rows[0]?.currency;
    ensure(currency, 403, 'Brak firmy');
    const sourceFrame = q.columns.some((k) => k === 'inventory_json' || k === 'prices_json')
      ? await catalogExportSourceFrame(c, q, a.tenantId)
      : undefined;
    const scopeHash = catalog ? catalogExportScopeHash(q, catalog, sourceFrame) : undefined;
    ensure(q.scope_hash === undefined || q.scope_hash === scopeHash, 409, 'Zakres katalogu zmienił się; odczytaj nowy podgląd');
    const f = filter(q, caps),
      chosen = q.columns.filter((k) => scalarSql[k] && k !== 'id');
    const projection = [
      'p.id',
      ...chosen.map(
        (k) => `${logistics.has(k) && !caps.logistics ? 'NULL' : scalarSql[k]} AS ${k}`,
      ),
    ].join(',');
    const join =
      caps.logistics && chosen.some((k) => logistics.has(k))
        ? 'LEFT JOIN product_logistics l ON (l.tenant_id,l.product_id)=(p.tenant_id,p.id)'
        : '';
    const readBatch = async (after: string | null) =>
      (
        await reader.query<BaseRow>(
          `SELECT ${projection} FROM products p ${join} WHERE ${f.sql} AND ($${f.params.length + 1}::uuid IS NULL OR p.id>$${f.params.length + 1}::uuid)
       ORDER BY p.id LIMIT ${CATALOG_EXPORT_LIMITS.batch_products}`,
          [...f.params, after],
        )
      ).rows;
    const first = await readBatch(null);
    async function* content() {
      let emitted = 0;
      if (q.format === 'csv')
        yield (q.spreadsheet_safe ? '\ufeff' : '') +
          q.columns
            .map(
              (k) =>
                `"${catalogCsvEscape(catalogCsvText(q.headers[k] ?? k, 'name', q.spreadsheet_safe))}"`,
            )
            .join(',') +
          '\r\n';
      else
        yield `<?xml version="1.0" encoding="UTF-8"?>\n<catalog currency="${catalogXmlEscape(currency)}" price_source="catalog">\n`;
      let batch = first;
      while (batch.length) {
        ensure(!signal?.aborted, 499, 'Pobieranie zostało przerwane');
        if (sourceFrame) {
          const matrices = await catalogExportSourceRows(
            reader,
            batch.map((row) => row.id),
            sourceFrame,
            currency,
          );
          for (const row of batch) Object.assign(row, matrices.get(row.id));
        }
        for (const row of batch) {
          if (q.format === 'xml') yield '<product>';
          for (let i = 0; i < q.columns.length; i++) {
            const key = q.columns[i],
              tag = q.headers[key] ?? key,
              isRelation =
                scalarSql[key] === null && key !== 'inventory_json' && key !== 'prices_json';
            const value = isRelation ? null : row[key];
            if (q.format === 'xml' && !isRelation) {
              yield* catalogXmlValue(tag, value);
              continue;
            }
            yield q.format === 'csv' ? (i ? ',"' : '"') : `<${tag} type="array">`;
            if (isRelation) {
              if (q.format === 'csv') yield '[';
              let comma = false;
              for await (const part of relation(reader, row.id, key, caps)) {
                if (q.format === 'xml') yield* catalogXmlValue('item', part);
                else {
                  if (comma) yield ',';
                  yield catalogCsvEscape(JSON.stringify(part));
                  comma = true;
                }
              }
              if (q.format === 'csv') yield ']';
            } else {
              const text =
                value == null
                  ? ''
                  : typeof value === 'object'
                    ? JSON.stringify(value)
                    : String(value);
              yield catalogCsvEscape(catalogCsvText(text, key, q.spreadsheet_safe));
            }
            yield q.format === 'csv' ? '"' : `</${tag}>`;
          }
          yield q.format === 'csv' ? '\r\n' : '</product>\n';
          emitted++;
        }
        batch = await readBatch(batch.at(-1)!.id);
      }
      ensure(emitted === count.matched_products, 500, 'Niekompletny zakres eksportu');
      if (q.format === 'xml') yield '</catalog>\n';
    }
    spool = await spoolCatalogExport(content(), signal);
    await reader.query('COMMIT');
    close(); // Release the RR reader before fresh finalization; no DB lock during HTTP download.
    await finalCatalogAccess(a, q, scopeHash, requiredScopes);
    ensure(!signal?.aborted, 499, 'Pobieranie zostało przerwane');
    const downloadHandle = await open(spool.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    stream = downloadHandle.createReadStream({
      autoClose: true,
      highWaterMark: 65536,
    });
    stream.once('close', () => {
      void dispose().catch(() => {});
    });
    ensure(!signal?.aborted, 499, 'Pobieranie zostało przerwane');
    return {
      stream,
      count: count.matched_products,
      currency,
      format: q.format,
      bytes: spool.bytes,
      ...(catalog ? { catalog_id: catalog.id, catalog_version: catalog.version, scope_hash: scopeHash } : {}),
      abort,
      dispose,
    };
  } catch (error) {
    if (c && !released) {
      await c.query('ROLLBACK').catch(() => {});
      close();
    }
    await dispose();
    throw error;
  }
}
