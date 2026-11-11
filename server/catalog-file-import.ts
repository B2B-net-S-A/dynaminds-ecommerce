import {createCoreEligibilityInspector} from './catalog-file-import-eligibility';
import { assertCatalogAttributesWriteInTx } from './catalog-attributes-transaction';
import { drainPublicConstraintsInTx } from './public-constraint-drain';
import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { pool, tenantTx } from './db';
import { ensure } from './errors';
import { deletedProductIdsInTx } from './product-deletions';
import { audit, catalogFields, productSchema, type Actor } from './domain';
import { createProduct, editProduct } from './catalog';
import { productCatalogOptionsInTx, resolveProductCatalogInTx, assertProductCatalogInTx, assertProductCatalogWarehouseInTx } from './product-catalogs';
import { assertCatalogExportAccess } from './catalog-export';
import {
  attachProductLogistics,
  ensureProductLogisticsWriteAvailable,
  lockProductLogisticsInTx,
} from './product-logistics';
import { PRODUCT_LOGISTICS_FIELDS, productLogisticsPatchSchema } from './product-logistics-schema';
import { productSkuSchema, resolveProductSkus, assertProductSkuAvailable } from './product-sku';
import type { CatalogProductEvent } from './product-rule-events';
import { scheduleProductRuleBatchAndFinalizeInTx } from './product-rules';
import {
  CATALOG_FILE_IMPORT_FIELDS,
  CATALOG_FILE_IMPORT_READONLY_FIELDS,
  CATALOG_FILE_IMPORT_LIMITS as LIMITS,
  catalogFileImportPreviewInput,
  catalogFileImportExecuteInput,
  type CatalogFileImportActor,
  type CatalogFileImportInput,
} from './catalog-file-import-schema';
import {
  parseCatalogFileImport,
  assertCatalogImportJson,
  type ParsedCatalogImport,
} from './catalog-file-import-parse';

type Json = Record<string, any>;
type Operation = 'create' | 'update' | 'unchanged' | 'invalid';
export type CatalogFileImportRow = {
  index: number;
  product_id: string;
  resolved_product_id: string | null;
  operation: Operation;
  identity_value: string | null;
  sku: string | null;
  current_sku: string | null;
  matched_historical_sku: boolean;
  input: Json;
  before: Json | null;
  after: Json | null;
  changed_fields: string[];
  errors: string[];
};
const stable = (value: any): any =>
  Array.isArray(value)
    ? value.map(stable)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([k, v]) => [k, stable(v)]),
        )
      : value;
export const catalogFileImportHash = (value: unknown) =>
  createHash('sha256')
    .update(JSON.stringify(stable(value)) ?? 'undefined')
    .digest('hex');
const uuid = z.uuid().transform((v) => v.toLowerCase());
const fields = [
  'sku',
  'name',
  'ean',
  'price',
  'vat',
  'category',
  'description',
  'active',
  'kind',
  'parent_id',
  'attributes',
  'images',
  'components',
  ...PRODUCT_LOGISTICS_FIELDS,
] as const;
const table = (kind: 'previews' | 'executions') => `catalog_file_import_${kind}`;
async function available(c: PoolClient) {
  return Boolean(
    (
      await c.query(`SELECT to_regclass('public.catalog_file_import_previews') IS NOT NULL
    AND to_regclass('public.catalog_file_import_rows') IS NOT NULL
    AND to_regclass('public.catalog_file_import_executions') IS NOT NULL
    AND to_regclass('public.catalog_file_import_execution_rows') IS NOT NULL AS present`)
    ).rows[0].present,
  );
}
const readAccess = async (a: CatalogFileImportActor) =>
  z.enum(['admin', 'operator', 'viewer']).parse(await assertCatalogExportAccess(a));
async function requireModule(c: PoolClient) {
  ensure(await available(c), 503, 'Kopia nie zawiera importu pliku katalogu');
}
async function admission(c: PoolClient, a: CatalogFileImportActor) {
  // Budget trigger takes this same lock; acquire it before any catalogue/product wait.
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    `catalog.file.import:${a.tenantId}`,
  ]);
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`catalog:${a.tenantId}`]);
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    `product.rules:${a.tenantId}`,
  ]);
}
async function finalGrant(c: PoolClient, a: CatalogFileImportActor) {
  const role = (await c.query('SELECT catalog_bulk_edit_current_role($1) AS role', [a.userId]))
    .rows[0]?.role;
  ensure(role === 'admin', 403, 'Wymagany aktualny administrator importu katalogu');
  if (a.apiKeyId) {
    const result = (
      await c.query('SELECT catalog_bulk_edit_key_grant($1,$2) AS grant_result', [
        a.userId,
        a.apiKeyId,
      ])
    ).rows[0]?.grant_result;
    ensure(result !== 'invalid', 401, 'Klucz API został cofnięty lub wygasł');
    ensure(result === 'ok', 403, 'Wymagane aktualne scopes products:read i products:write');
  }
  return role as Actor['role'];
}
async function access(a: CatalogFileImportActor, role: Actor['role']) {
  let canWrite = role === 'admin';
  if (canWrite && a.apiKeyId) {
    const key = (
      await pool.query(
        `SELECT revoked_at IS NULL AND expires_at>clock_timestamp()
      AND scopes @> ARRAY['products:read','products:write']::text[] AS allowed
      FROM api_keys WHERE (tenant_id,user_id,id)=($1,$2,$3)`,
        [a.tenantId, a.userId, a.apiKeyId],
      )
    ).rows[0];
    canWrite = key?.allowed === true;
  }
  return {
    available: true,
    current_role: role,
    can_read: true,
    can_write: canWrite,
    read_only: false,
  };
}
function configOf(q: CatalogFileImportInput) {
  const { content: _content, client_key: _key, ...config } = q;
  return config;
}
function body(input: unknown) {
  ensure(
    Buffer.byteLength(JSON.stringify(input), 'utf8') <= LIMITS.request_bytes,
    413,
    'Żądanie przekracza 4 MiB',
  );
  assertCatalogImportJson(input);
  const q = catalogFileImportPreviewInput.parse(input);
  return {
    ...q,
    client_key: q.client_key.toLowerCase(),
    warehouse_id: q.warehouse_id.toLowerCase(),
    ...(q.catalog_id ? { catalog_id: q.catalog_id.toLowerCase() } : {}),
  };
}
const scope = (actor: string, rows: CatalogFileImportRow[], related: Json, rules: Json[]) =>
  catalogFileImportHash({ actor, rows, related, rules });
async function rules(c: PoolClient) {
  if (
    !(await c.query("SELECT to_regclass('public.product_rules') IS NOT NULL AS present")).rows[0]
      .present
  )
    return [];
  const rows = (
    await c.query(`SELECT id,version,event,definition,approved_by,
    to_char(approved_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') approved_at
    FROM product_rules WHERE enabled AND deleted_at IS NULL ORDER BY id FOR SHARE`)
  ).rows;
  ensure(rows.length <= 100, 409, 'Przekroczono limit aktywnych reguł produktów');
  return rows;
}
function projected(p: Json, components: Json[]): Json {
  return {
    id: p.id,
    version: p.version,
    ...Object.fromEntries(
      fields.map((k) => [
        k,
        k === 'components'
          ? components
          : k === 'parent_id'
            ? (p.parent_id ?? null)
            : (p[k] ?? (PRODUCT_LOGISTICS_FIELDS.includes(k as any) ? null : p[k])),
      ]),
    ),
  };
}
async function loadProducts(c: PoolClient, ids: string[]): Promise<Json[]> {
  if (!ids.length) return [];
  const products = await attachProductLogistics(
    c,
    (await c.query('SELECT * FROM products WHERE id=ANY($1::uuid[]) ORDER BY id', [ids])).rows,
  );
  const components = (
    await c.query(
      'SELECT bundle_id,product_id,quantity FROM bundle_components WHERE bundle_id=ANY($1::uuid[]) ORDER BY bundle_id,product_id',
      [ids],
    )
  ).rows;
  const byId = new Map<string, Json[]>();
  for (const component of components) {
    const list = byId.get(component.bundle_id) ?? [];
    list.push({ product_id: component.product_id, quantity: component.quantity });
    byId.set(component.bundle_id, list);
  }
  return products.map((p) => projected(p, byId.get(p.id) ?? []));
}
function scalar(value: unknown, key: string) {
  ensure(typeof value === 'string', 422, `Pole ${key} wymaga tekstu`);
  return value.trim();
}
function integer(value: unknown, key: string) {
  if (typeof value === 'number') {
    ensure(Number.isSafeInteger(value), 422, `Pole ${key} wymaga liczby całkowitej`);
    return value;
  }
  ensure(
    typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value.trim()),
    422,
    `Pole ${key} wymaga nieujemnej liczby całkowitej`,
  );
  const number = Number(value.trim());
  ensure(Number.isSafeInteger(number), 422, `Pole ${key} przekracza zakres liczby`);
  return number;
}
function objectValue(value: unknown, key: string) {
  if (typeof value !== 'string') return value;
  try {
    const parsed: unknown = JSON.parse(value);
    assertCatalogImportJson(parsed);
    return parsed;
  } catch {
    ensure(false, 422, `Pole ${key} wymaga poprawnego JSON`);
  }
}
type Normalized = {
  patch: Json;
  identity: string | null;
  explicitId: string | null;
  parentRef: Json | null;
  components: Json[] | null;
  errors: string[];
};
function normalize(
  record: ParsedCatalogImport['rows'][number],
  q: CatalogFileImportInput,
): Normalized {
  const r: Normalized = {
    patch: {},
    identity: null,
    explicitId: null,
    parentRef: null,
    components: null,
    errors: [...record.errors],
  };
  try {
    const value = record.fields[q.identity];
    r.identity = q.identity === 'id' ? uuid.parse(value) : scalar(value, q.identity);
    ensure(Boolean(r.identity), 422, 'Brak jawnej wartości tożsamości');
  } catch {
    r.errors.push(`Brak lub niepoprawna tożsamość ${q.identity}`);
  }
  for (const [key, original] of Object.entries(record.fields)) {
    if (CATALOG_FILE_IMPORT_READONLY_FIELDS.includes(key as any)) {
      if (!q.ignore_readonly_fields)
        r.errors.push(`Pole tylko do odczytu: ${key}; wymagane jawne pominięcie`);
      continue;
    }
    try {
      if (key === 'id') {
        r.explicitId = uuid.parse(original);
        continue;
      }
      let value = original;
      const empty = value === null || value === '';
      if (empty && q.empty_policy === 'skip') continue;
      if (key === 'parent_id' || key === 'parent_sku') {
        if (!r.parentRef) r.parentRef = {};
        r.parentRef[key] = key === 'parent_id' ? uuid.parse(value) : productSkuSchema.parse(value);
        continue;
      }
      if (key === 'bundle_components_json') {
        const refs = objectValue(value, key);
        const schema = z
          .array(
            z
              .strictObject({
                product_id: uuid.optional(),
                sku: productSkuSchema.optional(),
                name: z.string().optional(),
                quantity: z.number().int().min(1).max(100000),
              })
              .refine((v) => Boolean(v.product_id || v.sku), 'Składnik wymaga id lub SKU'),
          )
          .max(100);
        r.components = schema.parse(refs);
        continue;
      }
      const mapped =
        (
          {
            price_minor: 'price',
            vat_rate: 'vat',
            weight_g: 'weight_grams',
            attributes_json: 'attributes',
            images_json: 'images',
          } as Record<string, string>
        )[key] ?? key;
      if (['price', 'vat', 'weight_grams', 'length_mm', 'width_mm', 'height_mm'].includes(mapped))
        value = empty ? null : integer(value, key);
      else if (mapped === 'active') {
        ensure(
          typeof value === 'boolean' || value === 'true' || value === 'false',
          422,
          'Aktywność wymaga true lub false',
        );
        value = value === true || value === 'true';
      } else if (mapped === 'attributes' || mapped === 'images')
        value = empty ? (mapped === 'attributes' ? {} : []) : objectValue(value, key);
      else if (mapped === 'manufacturer') value = empty ? null : scalar(value, key);
      else if (mapped === 'description' || mapped === 'category') {
        ensure(empty || typeof value === 'string', 422, `Pole ${key} wymaga tekstu`);
        value = empty ? '' : value;
      } else value = empty ? '' : scalar(value, key);
      if (mapped === 'sku')
        value = q.identity === 'sku' ? scalar(value, key) : productSkuSchema.parse(value);
      else if (mapped === 'kind') value = productSchema.shape.kind.parse(value);
      else {
        const validator = (catalogFields.shape as Record<string, z.ZodType>)[mapped];
        ensure(validator, 422, `Nieobsługiwane pole: ${key}`);
        value = validator.parse(value);
      }
      r.patch[mapped] = value;
    } catch {
      r.errors.push(`Niepoprawna wartość pola: ${key}`);
    }
  }
  return r;
}
async function identityMatches(c: PoolClient, inputs: Normalized[], config: Json) {
  const values = [...new Set(inputs.map((r) => r.identity).filter((v): v is string => v !== null))];
  const kind = config.identity as CatalogFileImportInput['identity'];
  if (kind === 'sku') {
    const result = await resolveProductSkus(c, values);
    ensure(result.length <= 10000, 422, 'Tożsamość pliku pasuje do zbyt wielu produktów');
    return result.map((p) => ({ id: p.id, value: p.matched_sku }));
  }
  const result = (
    await c.query(
      `SELECT id,${kind} AS value FROM products WHERE ${kind}=ANY($1::${kind === 'id' ? 'uuid' : 'text'}[]) ${config.catalog_id && kind !== 'id' ? 'AND catalog_id=$2' : ''} ORDER BY id LIMIT 10001`,
      [values, ...(config.catalog_id && kind !== 'id' ? [config.catalog_id] : [])],
    )
  ).rows;
  ensure(result.length <= 10000, 422, 'Tożsamość pliku pasuje do zbyt wielu produktów');
  return result as Array<{ id: string; value: string }>;
}
async function sourceFrame(c: PoolClient, inputs: Normalized[], q: Json, lock: boolean) {
  const catalog = await resolveProductCatalogInTx(c, q.catalog_id);
  await assertProductCatalogWarehouseInTx(c, catalog?.id ?? null, q.warehouse_id);
  const identityScope = catalog ? { ...q, catalog_id: catalog.id } : q;
  const matches = await identityMatches(c, inputs, identityScope);
  const refIds = inputs
    .flatMap((r) => [
      r.explicitId,
      r.parentRef?.parent_id,
      ...(r.components ?? []).map((x) => x.product_id),
    ])
    .filter(Boolean) as string[];
  const refSkus = inputs
    .flatMap((r) => [
      r.patch.sku,
      r.parentRef?.parent_sku,
      ...(r.components ?? []).map((x) => x.sku),
    ])
    .filter(Boolean) as string[];
  const aliases = (await resolveProductSkus(c, refSkus)).map((p) => ({
    sku: p.matched_sku,
    product_id: p.id,
  }));
  let ids = [
    ...new Set([...matches.map((p) => p.id), ...refIds, ...aliases.map((p) => p.product_id)]),
  ];
  const first = await loadProducts(c, ids);
  ids = [
    ...new Set([
      ...ids,
      ...first
        .flatMap((p) => [p.parent_id, ...p.components.map((x: Json) => x.product_id)])
        .filter(Boolean),
    ]),
  ].sort();
  ensure(ids.length <= 10000, 422, 'Zakres zależności pliku przekracza 10000 produktów');
  if (lock && ids.length) {
    await c.query('SELECT id FROM products WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE', [ids]);
    await lockProductLogisticsInTx(c, ids);
    const fresh = await identityMatches(c, inputs, identityScope);
    ensure(
      catalogFileImportHash(fresh) === catalogFileImportHash(matches),
      409,
      'Zestaw produktów pasujących do pliku zmienił się podczas oczekiwania',
    );
  }
  const products = await loadProducts(c, ids);
  // Unknown or foreign UUIDs remain ordinary invalid preview rows. Only
  // products visible in this tenant can establish a cross-catalog conflict.
  if (catalog) await assertProductCatalogInTx(c, products.map((p) => p.id), catalog.id);
  const warehouse = (
    await c.query('SELECT id,name,code FROM warehouses WHERE id=$1 FOR SHARE', [q.warehouse_id])
  ).rows[0];
  ensure(warehouse, 422, 'Magazyn nie istnieje w tej firmie');
  const currency = (
    await c.query(
      "SELECT currency FROM tenants WHERE id=nullif(current_setting('app.tenant_id',true),'')::uuid",
    )
  ).rows[0]?.currency;
  return {
    products,
    matches,
    aliases: aliases.sort((a, b) =>
      a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : a.product_id.localeCompare(b.product_id),
    ),
    warehouse,
    currency,
    ...(q.catalog_id && catalog ? { catalog: { id: catalog.id, version: catalog.version } } : {}),
  };
}
function createAfter(id: string, patch: Json, warehouse: string) {
  const parsed = productSchema.parse({ ...patch, warehouse_id: warehouse, quantity: 0 });
  return projected(
    {
      ...parsed,
      id,
      version: 1,
      ...Object.fromEntries(PRODUCT_LOGISTICS_FIELDS.map((k) => [k, parsed[k] ?? null])),
    },
    parsed.components,
  );
}
async function makePlan(c: PoolClient, q: CatalogFileImportInput, parsed: ParsedCatalogImport) {
  const inputs = parsed.rows.map((r) => normalize(r, q)),
    frame = await sourceFrame(c, inputs, q, true);
  const products = new Map(frame.products.map((p) => [p.id, p]));
  // A deleted product (225) keeps its identity and SKU: a row matching it is refused, never recreated.
  const deleted = await deletedProductIdsInTx(c, [...products.keys()]);
  const rows: CatalogFileImportRow[] = inputs.map((input, index) => {
    const matched = frame.matches.filter((m) => m.value === input.identity);
    const current = matched.length === 1 ? products.get(matched[0].id) : undefined;
    const errors = [...input.errors];
    if (matched.length > 1)
      errors.push('Tożsamość jest niejednoznaczna; wybierz jawny id produktu');
    if (q.identity === 'id' && !current)
      errors.push('Id nie wskazuje istniejącego produktu tej firmy');
    if (input.explicitId && (!current || current.id !== input.explicitId))
      errors.push('Id nie zgadza się z własnym produktem dopasowanym przez tożsamość');
    if (q.mode === 'create' && current)
      errors.push('Tryb create nie zastępuje istniejącego produktu');
    if (q.mode === 'update' && !current) errors.push('Tryb update wymaga istniejącego produktu');
    if (current && deleted.has(current.id)) errors.push('Produkt został usunięty');
    if (
      Object.hasOwn(input.patch, 'price') &&
      (q.currency !== frame.currency ||
        (parsed.currency !== null && parsed.currency !== q.currency))
    )
      errors.push('Cena ma inną walutę niż plik, żądanie lub katalog firmy; brak konwersji FX');
    const historical = q.identity === 'sku' && !!current && current.sku !== input.identity;
    const patch = { ...input.patch };
    // An identity alias locates its UUID; importing it must not rename the card back.
    if (q.identity === 'sku' && current) delete patch.sku;
    return {
      index,
      product_id: current?.id ?? randomUUID(),
      resolved_product_id: current?.id ?? null,
      operation: 'invalid',
      identity_value: input.identity,
      sku: patch.sku ?? current?.sku ?? null,
      current_sku: current?.sku ?? null,
      matched_historical_sku: historical,
      input: patch,
      before: current ?? null,
      after: null,
      changed_fields: [],
      errors,
    };
  });
  const batchBySku = new Map<string, CatalogFileImportRow[]>();
  for (const row of rows)
    if (row.sku) {
      const same = batchBySku.get(row.sku) ?? [];
      same.push(row);
      batchBySku.set(row.sku, same);
    }
  const ref = (value: Json) => {
    const byId = value.product_id || value.parent_id;
    const bySku = value.sku || value.parent_sku;
    const batch = bySku ? (batchBySku.get(bySku) ?? []) : [];
    const alias = bySku ? frame.aliases.filter((a) => a.sku === bySku) : [];
    const found = [
      ...new Set([
        ...(byId && products.has(byId) ? [byId] : []),
        ...batch.map((r) => r.product_id),
        ...alias.map((a) => a.product_id),
      ]),
    ];
    ensure(
      found.length === 1 && (!byId || found[0] === byId),
      422,
      'Zależność nie istnieje lub jest niejednoznaczna',
    );
    ensure(!deleted.has(found[0]), 422, 'Zależność wskazuje usunięty produkt');
    return found[0];
  };
  for (const row of rows) {
    const input = inputs[row.index];
    try {
      if (input.parentRef) row.input.parent_id = ref(input.parentRef);
      if (input.components)
        row.input.components = input.components
          .map((r) => ({ product_id: ref(r), quantity: r.quantity }))
          .sort((a, b) => a.product_id.localeCompare(b.product_id));
      if (row.before) {
        ensure(
          row.input.kind === undefined || row.input.kind === row.before.kind,
          422,
          'Typ istniejącego produktu jest stały',
        );
        ensure(
          row.input.parent_id === undefined || row.input.parent_id === row.before.parent_id,
          422,
          'Rodzic istniejącego wariantu jest stały',
        );
        row.after = { ...row.before, ...row.input };
        row.changed_fields = fields.filter(
          (k) => catalogFileImportHash(row.before![k]) !== catalogFileImportHash(row.after![k]),
        );
        ensure(
          !row.changed_fields.length || row.before.version < 2147483647,
          422,
          'Wersja produktu osiągnęła maksymalny zakres',
        );
        row.after.version = row.before.version + (row.changed_fields.length ? 1 : 0);
      } else {
        row.after = createAfter(row.product_id, row.input, q.warehouse_id);
        row.changed_fields = fields.filter((k) => Object.hasOwn(row.input, k));
      }
      row.sku = row.after.sku;
      const repeated = rows.filter(
        (other) => other.product_id === row.product_id || (other.sku && other.sku === row.sku),
      );
      ensure(repeated.length === 1, 422, 'Powtórzony produkt lub docelowe SKU w partii');
      ensure(
        frame.aliases.every((a) => a.sku !== row.sku || a.product_id === row.product_id),
        422,
        'SKU jest zarezerwowane dla innego produktu',
      );
      await ensureProductLogisticsWriteAvailable(c, row.input);
    } catch (error) {
      row.errors.push(error instanceof Error ? error.message : 'Niepoprawny produkt');
    }
  }
  const projectedProducts = new Map<string, Json>(frame.products.map((p) => [p.id, p]));
  for (const row of rows) if (row.after) projectedProducts.set(row.product_id, row.after);
  for (const row of rows) {
    const after = row.after;
    if (after) {
      if (after.kind === 'variant' && projectedProducts.get(after.parent_id)?.kind !== 'group')
        row.errors.push('Wariant wymaga własnej grupy nadrzędnej');
      if (after.kind !== 'variant' && after.parent_id)
        row.errors.push('Rodzic jest dostępny tylko dla wariantu');
      if (after.kind !== 'bundle' && after.components.length)
        row.errors.push('Składniki są dostępne tylko dla zestawu');
      if (
        after.kind === 'bundle' &&
        (!after.components.length ||
          new Set(after.components.map((x: Json) => x.product_id)).size !==
            after.components.length ||
          after.components.some((x: Json) => {
            const p = projectedProducts.get(x.product_id);
            return !p?.active || !['simple', 'variant'].includes(p.kind) || p.id === row.product_id;
          }))
      )
        row.errors.push('Zestaw wymaga różnych aktywnych składników fizycznych tej firmy');
      for (const image of after.images as string[])
        if (image.startsWith('/api/')) {
          const id = image.split('/').at(-1);
          if (
            !(await c.query('SELECT id FROM product_images WHERE id=$1 FOR SHARE', [id])).rowCount
          )
            row.errors.push('Zdjęcie nie należy do tej firmy');
        }
    }
    row.operation =
      row.errors.length || !after
        ? 'invalid'
        : !row.before
          ? 'create'
          : row.changed_fields.length
            ? 'update'
            : 'unchanged';
  }
  const related = {
    ...frame,
    identity_inputs: inputs
      .map((r) => ({
        identity: r.identity,
        explicitId: r.explicitId,
        patch: { sku: r.patch.sku },
        parentRef: r.parentRef,
        components: r.components,
      }))
      .map((r) => JSON.parse(JSON.stringify(r))),
  };
  return { rows, related };
}
function counts(rows: CatalogFileImportRow[]) {
  return {
    total: rows.length,
    created: rows.filter((r) => r.operation === 'create').length,
    updated: rows.filter((r) => r.operation === 'update').length,
    unchanged: rows.filter((r) => r.operation === 'unchanged').length,
    invalid: rows.filter((r) => r.operation === 'invalid').length,
  };
}
function head(p: Json, execution = false, preview?: Json) {
  return {
    id: p.id,
    ...(execution ? { preview_id: p.preview_id, state: p.state } : {}),
    actor_id: p.actor_id,
    scope_hash: p.scope_hash,
    total: p.total,
    created: p.created,
    updated: p.updated,
    unchanged: p.unchanged,
    invalid: p.invalid ?? 0,
    ready: p.ready ?? true,
    created_at: p.created_at,
    config: p.config ?? preview?.config,
    active_product_rules: (p.rules_snapshot ?? preview?.rules_snapshot ?? []).length,
  };
}
function publicRow(r: Json) {
  const {
    tenant_id: _tenant,
    preview_id: _preview,
    execution_id: _execution,
    byte_count: _bytes,
    ...row
  } = r;
  return { ...row, changes: row.input };
}
async function page(c: PoolClient, id: string, execution: boolean, cursor?: string) {
  const start = cursor === undefined ? 0 : Number(cursor);
  ensure(Number.isInteger(start) && start >= 0 && start <= 499, 422, 'Niepoprawny kursor wierszy');
  const rows = (
    await c.query(
      `SELECT * FROM catalog_file_import_${execution ? 'execution_rows' : 'rows'}
    WHERE ${execution ? 'execution_id' : 'preview_id'}=$1 AND index>=$2 ORDER BY index LIMIT 101`,
      [id, start],
    )
  ).rows;
  return {
    rows: rows.slice(0, 100).map(publicRow),
    meta: { cursor: rows.length > 100 ? String(rows[99].index + 1) : null },
  };
}
async function quota(c: PoolClient, kind: 'previews' | 'executions') {
  ensure(
    (await c.query(`SELECT count(*)::integer n FROM ${table(kind)}`)).rows[0].n <
      LIMITS.history_per_tenant,
    409,
    'Limit 2000 podglądów lub wykonań importu; historia nie jest usuwana',
  );
}
async function bytes(c: PoolClient, previewId?: string) {
  const result = (
    await c.query(`SELECT coalesce(sum(byte_count),0)::text AS bytes FROM (
    SELECT byte_count FROM catalog_file_import_previews UNION ALL SELECT byte_count FROM catalog_file_import_rows
    UNION ALL SELECT byte_count FROM catalog_file_import_executions UNION ALL SELECT byte_count FROM catalog_file_import_execution_rows) t`)
  ).rows[0];
  ensure(
    BigInt(result.bytes) <= BigInt(LIMITS.history_bytes),
    409,
    'Limit 128 MiB historii importów firmy',
  );
  if (previewId) {
    const current = (
      await c.query(
        `SELECT p.byte_count+coalesce(sum(r.byte_count),0) AS bytes FROM catalog_file_import_previews p
      LEFT JOIN catalog_file_import_rows r ON (r.tenant_id,r.preview_id)=(p.tenant_id,p.id) WHERE p.id=$1 GROUP BY p.byte_count`,
        [previewId],
      )
    ).rows[0];
    ensure(BigInt(current.bytes) <= BigInt(LIMITS.preview_bytes), 422, 'Podgląd przekracza 8 MiB');
  }
}
async function getHead(c: PoolClient, id: string, execution = false) {
  const p = (
    await c.query(`SELECT * FROM ${table(execution ? 'executions' : 'previews')} WHERE id=$1`, [
      uuid.parse(id),
    ])
  ).rows[0];
  ensure(p, 404, 'Nie znaleziono dowodu importu katalogu');
  return p;
}
async function insertRows(c: PoolClient, id: string, rows: CatalogFileImportRow[]) {
  await c.query(
    `INSERT INTO catalog_file_import_rows(tenant_id,preview_id,index,product_id,resolved_product_id,operation,
    identity_value,sku,current_sku,matched_historical_sku,input,before,after,changed_fields,errors)
    SELECT nullif(current_setting('app.tenant_id',true),'')::uuid,$1,index,product_id,resolved_product_id,operation,
    identity_value,sku,current_sku,matched_historical_sku,input,before,after,changed_fields,errors
    FROM jsonb_to_recordset($2::jsonb) AS r(index integer,product_id uuid,resolved_product_id uuid,operation text,
    identity_value text,sku text,current_sku text,matched_historical_sku boolean,input jsonb,before jsonb,after jsonb,changed_fields jsonb,errors jsonb)`,
    [id, JSON.stringify(rows)],
  );
}
export async function catalogFileImportOptions(a: CatalogFileImportActor) {
  let role = await readAccess(a);
  const result = await tenantTx(
    a.tenantId,
    async (c) => {
      const present = await available(c);
      const warehouses = (
        await c.query('SELECT id,name,code FROM warehouses ORDER BY id LIMIT 201')
      ).rows;
      const catalogCurrency = (
        await c.query('SELECT currency FROM tenants WHERE id=$1', [a.tenantId])
      ).rows[0]?.currency;
      const catalogOptions = await productCatalogOptionsInTx(c);
      const catalogsAvailable = catalogOptions !== null;
      const catalogs = (catalogOptions?.catalogs ?? []).filter(p => p.active).map(p => ({ id: p.id, name: p.name, is_default: p.is_default, warehouse_ids: p.warehouse_ids }));
      return {
        available: present,
        limits: LIMITS,
        fields: CATALOG_FILE_IMPORT_FIELDS.map((key) => ({
          key,
          label: key,
          readonly: CATALOG_FILE_IMPORT_READONLY_FIELDS.includes(key as any),
        })),
        formats: ['csv', 'xml'],
        xml_mapping_supported: true,
        xml_value_types: ['text', 'integer', 'decimal_money', 'boolean'],
        modes: ['create', 'update', 'upsert'],
        identities: ['id', 'sku', 'ean', 'name'],
        catalog_currency: catalogCurrency,
        product_catalogs_available: catalogsAvailable,
        catalogs: { data: catalogs.slice(0, 200), capped: catalogs.length > 200 },
        warehouses: { data: warehouses.slice(0, 200), capped: warehouses.length > 200 },
      };
    },
    { wmsAdmission: 'read' },
  );
  role = await readAccess(a);
  const flags = await access(a, role);
  return { ...flags, ...result, can_write: flags.can_write && result.available };
}
export async function createCatalogFileImportPreview(a: CatalogFileImportActor, input: unknown) {
  const entry = await assertCatalogExportAccess(a);
  ensure(entry === 'admin', 403, 'Wymagany administrator podglądu importu');
  const q = body(input),
    parsed = parseCatalogFileImport(q),
    config = configOf(q),
    requestHash = catalogFileImportHash({
      actor: a.userId,
      source: a.apiKeyId ? 'api' : 'manual',
      config,
      rows: parsed,
    });
  return tenantTx(
    a.tenantId,
    async (c) => {
      await requireModule(c);
      await admission(c, a);
      const previous = (
        await c.query('SELECT * FROM catalog_file_import_previews WHERE client_key=$1', [
          q.client_key,
        ])
      ).rows[0];
      if (previous) {
        ensure(
          previous.actor_id === a.userId && previous.request_hash === requestHash,
          409,
          'Klucz podglądu należy do innego żądania lub autora',
        );
        const rows = await page(c, previous.id, false);
        const role = await finalGrant(c, a);
        return {
          available: true,
          current_role: role,
          can_read: true,
          can_write: true,
          read_only: false,
          preview: head(previous),
          ...rows,
          reused: true,
        };
      }
      await quota(c, 'previews');
      const { rows, related } = await makePlan(c, q, parsed),
        active = await rules(c),
        n = counts(rows),
        id = randomUUID(),
        scopeHash = scope(a.userId, rows, related, active);
      for (const row of rows) if (row.after) await assertCatalogAttributesWriteInTx(c,row.after.attributes);
      ensure(
        Buffer.byteLength(JSON.stringify({ rows, related, active, config }), 'utf8') <=
          LIMITS.preview_bytes,
        422,
        'Podgląd przekracza 8 MiB',
      );
      const p = (
        await c.query(
          `INSERT INTO catalog_file_import_previews(id,tenant_id,actor_id,client_key,request_hash,scope_hash,source,
      config,rules_snapshot,related_snapshot,total,created,updated,unchanged,invalid,ready)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
          [
            id,
            a.tenantId,
            a.userId,
            q.client_key,
            requestHash,
            scopeHash,
            a.apiKeyId ? 'api' : 'manual',
            JSON.stringify(config),
            JSON.stringify(active),
            JSON.stringify(related),
            n.total,
            n.created,
            n.updated,
            n.unchanged,
            n.invalid,
            n.invalid === 0,
          ],
        )
      ).rows[0];
      await insertRows(c, id, rows);
      await audit(c, a, 'catalog.file_import.preview', id, { scope_hash: scopeHash, ...n });
      await bytes(c, id);
      const response = await page(c, id, false);
      await drainPublicConstraintsInTx(c);
      const role = await finalGrant(c, a);
      return {
        available: true,
        current_role: role,
        can_read: true,
        can_write: true,
        read_only: false,
        preview: head(p),
        ...response,
        reused: false,
      };
    },
    { wmsAdmission: 'read' },
  );
}
export async function catalogFileImportPreviewDetail(
  a: CatalogFileImportActor,
  id: string,
  cursor?: string,
) {
  await assertCatalogExportAccess(a);
  const result = await tenantTx(
    a.tenantId,
    async (c) => {
      await requireModule(c);
      const p = await getHead(c, id);
      return { preview: head(p), ...(await page(c, p.id, false, cursor)) };
    },
    { wmsAdmission: 'read' },
  );
  return { ...(await access(a, await readAccess(a))), ...result };
}
async function applyLogistics(c: PoolClient, a: CatalogFileImportActor, row: CatalogFileImportRow) {
  if (!PRODUCT_LOGISTICS_FIELDS.some((k) => Object.hasOwn(row.input, k))) return;
  if (PRODUCT_LOGISTICS_FIELDS.every((k) => (row.before?.[k] ?? null) === row.after![k])) return;
  await ensureProductLogisticsWriteAvailable(c, row.input);
  productLogisticsPatchSchema.parse(
    Object.fromEntries(
      PRODUCT_LOGISTICS_FIELDS.filter((k) => Object.hasOwn(row.input, k)).map((k) => [
        k,
        row.input[k],
      ]),
    ),
  );
  const after = row.after!;
  // Same validated values and column operation as the shared helper, with the
  // actor check intentionally deferred until all import effects/constraints.
  await c.query(
    `INSERT INTO product_logistics(tenant_id,product_id,weight_grams,length_mm,width_mm,height_mm,manufacturer)
    VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(tenant_id,product_id) DO UPDATE SET
    weight_grams=excluded.weight_grams,length_mm=excluded.length_mm,width_mm=excluded.width_mm,height_mm=excluded.height_mm,
    manufacturer=excluded.manufacturer,updated_at=now()`,
    [a.tenantId, row.product_id, ...PRODUCT_LOGISTICS_FIELDS.map((k) => after[k])],
  );
}
function ordered(rows: CatalogFileImportRow[]) {
  const result: CatalogFileImportRow[] = [],
    pending = new Map(rows.map((r) => [r.product_id, r])),
    visiting = new Set<string>();
  const visit = (r: CatalogFileImportRow) => {
    if (!pending.has(r.product_id)) return;
    ensure(!visiting.has(r.product_id), 409, 'Cykliczne zależności w zamrożonej partii');
    visiting.add(r.product_id);
    const refs = [
      r.after?.parent_id,
      ...(r.after?.components ?? []).map((x: Json) => x.product_id),
    ].filter(Boolean);
    for (const id of refs) {
      const dependency = pending.get(id);
      if (dependency?.operation === 'create') visit(dependency);
    }
    visiting.delete(r.product_id);
    pending.delete(r.product_id);
    result.push(r);
  };
  for (const row of rows) visit(row);
  return result;
}
export async function executeCatalogFileImport(
  a: CatalogFileImportActor,
  id: string,
  input: unknown,
) {
  const entry = await assertCatalogExportAccess(a);
  ensure(entry === 'admin', 403, 'Wymagany administrator wykonania importu');
  assertCatalogImportJson(input);
  const raw = catalogFileImportExecuteInput.parse(input),
    b = { ...raw, client_key: raw.client_key.toLowerCase() },
    previewId = uuid.parse(id),
    requestHash = catalogFileImportHash({
      actor: a.userId,
      source: a.apiKeyId ? 'api' : 'manual',
      preview_id: previewId,
      request: b,
    });
  return tenantTx(
    a.tenantId,
    async (c) => {
      await requireModule(c);
      await admission(c, a);
      const previous = (
        await c.query('SELECT * FROM catalog_file_import_executions WHERE client_key=$1', [
          b.client_key,
        ])
      ).rows[0];
      if (previous) {
        ensure(
          previous.actor_id === a.userId && previous.request_hash === requestHash,
          409,
          'Klucz wykonania należy do innego żądania lub autora',
        );
        const p = await getHead(c, previous.preview_id),
          response = await page(c, previous.id, true),
          role = await finalGrant(c, a);
        return {
          available: true,
          current_role: role,
          can_read: true,
          can_write: true,
          read_only: false,
          execution: head(previous, true, p),
          ...response,
          reused: true,
        };
      }
      const p = await getHead(c, previewId);
      ensure(p.actor_id === a.userId, 403, 'Podgląd może wykonać wyłącznie jego autor');
      ensure(
        p.ready && p.scope_hash === b.scope_hash,
        409,
        'Podgląd nie jest gotowy lub zgoda wskazuje inny zakres',
      );
      ensure(
        !(
          await c.query('SELECT id FROM catalog_file_import_executions WHERE preview_id=$1', [
            previewId,
          ])
        ).rowCount,
        409,
        'Podgląd został już wykonany z innym kluczem',
      );
      await quota(c, 'executions');
      const stored = (
        await c.query('SELECT * FROM catalog_file_import_rows WHERE preview_id=$1 ORDER BY index', [
          previewId,
        ])
      ).rows;
      const rows = stored.map((r) => ({
        index: r.index,
        product_id: r.product_id,
        resolved_product_id: r.resolved_product_id,
        operation: r.operation,
        identity_value: r.identity_value,
        sku: r.sku,
        current_sku: r.current_sku,
        matched_historical_sku: r.matched_historical_sku,
        input: r.input,
        before: r.before,
        after: r.after,
        changed_fields: r.changed_fields,
        errors: r.errors,
      })) as CatalogFileImportRow[];
      ensure(
        rows.length === p.total &&
          rows.every((r, i) => r.index === i && r.operation !== 'invalid') &&
          scope(p.actor_id, rows, p.related_snapshot, p.rules_snapshot) === p.scope_hash,
        409,
        'Niezgodny zamrożony dowód podglądu',
      );
      const sourceInputs: Normalized[] = (p.related_snapshot.identity_inputs as Json[]).map(
        (r) => ({
          identity: r.identity,
          explicitId: r.explicitId,
          patch: r.patch ?? {},
          parentRef: r.parentRef,
          components: r.components,
          errors: [],
        }),
      );
      const frame = await sourceFrame(c, sourceInputs, p.config, true);
      const expectedFrame = { ...p.related_snapshot };
      delete expectedFrame.identity_inputs;
      ensure(
        catalogFileImportHash(frame) === catalogFileImportHash(expectedFrame),
        409,
        'Co najmniej jeden produkt, alias lub zależność zmieniły się po podglądzie',
      );
      const active = await rules(c);
      ensure(
        catalogFileImportHash(active) === catalogFileImportHash(p.rules_snapshot),
        409,
        'Aktywne reguły produktów zmieniły się po podglądzie',
      );
      const allocated = rows.filter((r) => r.operation === 'create').map((r) => r.product_id);
      if (allocated.length)
        ensure(
          !(
            await c.query(
              'SELECT id FROM products WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',
              [allocated],
            )
          ).rowCount,
          409,
          'Przydzielony id nowego produktu został już wykorzystany',
        );
      for (const row of rows)
        for (const image of row.after!.images as string[])
          if (image.startsWith('/api/'))
            ensure(
              (
                await c.query('SELECT id FROM product_images WHERE id=$1 FOR SHARE', [
                  image.split('/').at(-1),
                ])
              ).rowCount,
              409,
              'Zdjęcie zatwierdzone w podglądzie nie jest już dostępne w tej firmie',
            );
      const events: CatalogProductEvent[] = [];
      for (const row of ordered(rows)) {
        if (row.operation === 'unchanged') continue;
        const after = row.after!;
        const core = Object.fromEntries(
          fields
            .filter((k) => !PRODUCT_LOGISTICS_FIELDS.includes(k as any) && k !== 'sku')
            .map((k) => [k, after[k]]),
        );
        if (row.operation === 'create') {
          await createProduct(
            c,
            a,
            productSchema.parse({
              ...core,
              parent_id: core.parent_id ?? undefined,
              sku: after.sku,
              warehouse_id: p.config.warehouse_id,
              ...(p.config.catalog_id ? { catalog_id: p.config.catalog_id } : {}),
              quantity: 0,
            }),
            { id: row.product_id, deferProductRules: true },
          );
        } else {
          const rename = row.before!.sku !== after.sku;
          if (rename) {
            await assertProductSkuAvailable(c);
            const aliases = await resolveProductSkus(c, [after.sku]);
            ensure(
              aliases.every((x) => x.id === row.product_id),
              409,
              'Docelowe SKU zostało zarezerwowane dla innego produktu',
            );
          }
          await editProduct(
            c,
            a,
            row.product_id,
            { ...core, version: row.before!.version } as any,
            {
              deferProductRules: true,
              ...(!Object.hasOwn(row.input, 'components')
                ? { preserveComponents: true as const }
                : {}),
            },
          );
          if (rename)
            await c.query('UPDATE products SET sku=$2 WHERE id=$1', [
              row.product_id,
              productSkuSchema.parse(after.sku),
            ]);
        }
        await applyLogistics(c, a, row);
        events.push({
          product_id: row.product_id,
          event: row.operation === 'create' ? 'product.created' : 'product.updated',
          cause_id: randomUUID(),
        });
      }
      const saved = new Map(
        (
          await loadProducts(
            c,
            rows.map((r) => r.product_id),
          )
        ).map((x) => [x.id, x]),
      );
      ensure(
        rows.every(
          (r) => catalogFileImportHash(saved.get(r.product_id)) === catalogFileImportHash(r.after),
        ),
        409,
        'Zapisane produkty nie odpowiadają pełnemu zatwierdzonemu podglądowi',
      );
      const finalized = await scheduleProductRuleBatchAndFinalizeInTx(c, a, events, async () => {
        const executionId = randomUUID();
        const e = (
          await c.query(
            `INSERT INTO catalog_file_import_executions(id,tenant_id,preview_id,actor_id,client_key,request_hash,scope_hash,total,created,updated,unchanged)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
            [
              executionId,
              a.tenantId,
              previewId,
              a.userId,
              b.client_key,
              requestHash,
              p.scope_hash,
              p.total,
              p.created,
              p.updated,
              p.unchanged,
            ],
          )
        ).rows[0];
        const receipts = rows.map((r) => ({
          ...r,
          before_version: r.before?.version ?? null,
          after_version: r.after!.version,
        }));
        await c.query(
          `INSERT INTO catalog_file_import_execution_rows(tenant_id,execution_id,preview_id,index,product_id,operation,
      identity_value,sku,current_sku,matched_historical_sku,input,before,after,changed_fields,errors,before_version,after_version)
      SELECT $1::uuid,$2::uuid,$3::uuid,index,product_id,operation,identity_value,sku,current_sku,matched_historical_sku,input,before,after,changed_fields,errors,before_version,after_version
      FROM jsonb_to_recordset($4::jsonb) AS r(index integer,product_id uuid,operation text,identity_value text,sku text,current_sku text,
      matched_historical_sku boolean,input jsonb,before jsonb,after jsonb,changed_fields jsonb,errors jsonb,before_version integer,after_version integer)`,
          [a.tenantId, executionId, previewId, JSON.stringify(receipts)],
        );
        await audit(c, a, 'catalog.file_import.execute', executionId, {
          preview_id: previewId,
          scope_hash: p.scope_hash,
          created: p.created,
          updated: p.updated,
          unchanged: p.unchanged,
          sku_changes: rows
            .filter((r) => r.before && r.before.sku !== r.after!.sku)
            .map((r) => ({ product_id: r.product_id, before: r.before!.sku, after: r.after!.sku })),
        });
        await bytes(c);
        const response = await page(c, executionId, true);
        await drainPublicConstraintsInTx(c);
        return { execution: head(e, true, p), ...response };
      });
      const role = await finalGrant(c, a);
      return {
        available: true,
        current_role: role,
        can_read: true,
        can_write: true,
        read_only: false,
        ...finalized,
        reused: false,
      };
    },
    { wmsAdmission: 'read' },
  );
}
export async function catalogFileImportExecutionDetail(
  a: CatalogFileImportActor,
  id: string,
  cursor?: string,
) {
  await assertCatalogExportAccess(a);
  const result = await tenantTx(
    a.tenantId,
    async (c) => {
      await requireModule(c);
      const e = await getHead(c, id, true),
        p = await getHead(c, e.preview_id);
      return { execution: head(e, true, p), ...(await page(c, e.id, true, cursor)) };
    },
    { wmsAdmission: 'read' },
  );
  return { ...(await access(a, await readAccess(a))), ...result };
}
export async function catalogFileImportHistory(a: CatalogFileImportActor, cursor?: string) {
  await assertCatalogExportAccess(a);
  let seek: { created_at: string; id: string; kind: string } | null = null;
  if (cursor) {
    try {
      seek = JSON.parse(Buffer.from(cursor, 'base64url').toString());
      ensure(
        seek &&
          typeof seek.created_at === 'string' &&
          !Number.isNaN(Date.parse(seek.created_at)) &&
          uuid.safeParse(seek.id).success &&
          ['preview', 'execution'].includes(seek.kind),
        422,
        'Niepoprawny kursor historii',
      );
    } catch {
      ensure(false, 422, 'Niepoprawny kursor historii');
    }
  }
  const result = await tenantTx(
    a.tenantId,
    async (c) => {
      await requireModule(c);
      const rows = (
        await c.query(
          `WITH heads AS (
      SELECT 'preview'::text kind,p.id,p.created_at,p.actor_id,p.scope_hash,p.total,p.created,p.updated,p.unchanged,
      p.invalid,p.ready,p.config,jsonb_array_length(p.rules_snapshot) AS active_product_rules,NULL::uuid AS preview_id,NULL::text AS state
      FROM catalog_file_import_previews p
      UNION ALL SELECT 'execution',e.id,e.created_at,e.actor_id,e.scope_hash,e.total,e.created,e.updated,e.unchanged,
      0,true,p.config,jsonb_array_length(p.rules_snapshot),e.preview_id,e.state FROM catalog_file_import_executions e
      JOIN catalog_file_import_previews p ON (p.tenant_id,p.id)=(e.tenant_id,e.preview_id))
      SELECT *,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') precise_created_at
      FROM heads WHERE ($1::timestamptz IS NULL OR (created_at,id,kind)<($1::timestamptz,$2::uuid,$3::text))
      ORDER BY created_at DESC,id DESC,kind DESC LIMIT 26`,
          [seek?.created_at ?? null, seek?.id ?? null, seek?.kind ?? null],
        )
      ).rows;
      const data = rows.slice(0, 25),
        last = data.at(-1);
      return {
        data: data.map((r) => ({
          kind: r.kind,
          ...head(r, r.kind === 'execution'),
          active_product_rules: r.active_product_rules,
        })),
        meta: {
          cursor:
            rows.length > 25 && last
              ? Buffer.from(
                  JSON.stringify({
                    created_at: last.precise_created_at,
                    id: last.id,
                    kind: last.kind,
                  }),
                ).toString('base64url')
              : null,
        },
      };
    },
    { wmsAdmission: 'read' },
  );
  return { ...(await access(a, await readAccess(a))), ...result };
}

/** Standalone source/current-IAM eligibility read. Caller owns the captured173 admission transaction. */
export const inspectCoreBatchEligibilityInTx=createCoreEligibilityInspector({body,parse:parseCatalogFileImport,hash:catalogFileImportHash,requireModule,admission,finalGrant,getHead,sourceFrame,rules,head,publicRow,quota,bytes,limits:LIMITS});

/** Source-only coordinator capacity observation: no preview/execute allocation or product write. Native098 remains final quota authority. */
export async function inspectCoreImportCapacityInTx(c:PoolClient,a:CatalogFileImportActor,raw:unknown){
 const state=(await c.query("SELECT current_user role,current_setting('app.tenant_id',true) tenant")).rows[0];
 ensure(state?.role==='dyna_app'&&state.tenant===a.tenantId,403,'Inny kontekst importu katalogu');
 const q=body(raw);await requireModule(c);await admission(c,a);await finalGrant(c,a);
 await quota(c,'previews');await bytes(c);
 const native=(await c.query(`SELECT (SELECT count(*)::integer FROM catalog_file_import_previews) previews,(SELECT count(*)::integer FROM catalog_file_import_executions) executions,
 (SELECT coalesce(sum(byte_count),0)::text FROM (SELECT byte_count FROM catalog_file_import_previews UNION ALL SELECT byte_count FROM catalog_file_import_rows UNION ALL SELECT byte_count FROM catalog_file_import_executions UNION ALL SELECT byte_count FROM catalog_file_import_execution_rows) z) history_bytes`)).rows[0];
 await finalGrant(c,a);
 return{schema:'catalog-core-capacity-observation/v1' as const,principal:{tenantId:a.tenantId,userId:a.userId,apiKeyId:a.apiKeyId??null,role:'admin' as const},request_sha256:catalogFileImportHash(q),limits:LIMITS,native,admissible:true as const,reserved:false as const};
}
