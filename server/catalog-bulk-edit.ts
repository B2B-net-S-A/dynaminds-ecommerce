import {
  attachProductLogistics,
  ensureProductLogisticsWriteAvailable,
  productLogisticsAvailable,
  lockProductLogisticsInTx,
} from './product-logistics';
import { PRODUCT_LOGISTICS_FIELDS } from './product-logistics-schema';
import {
  productSkuAvailable,
  assertProductSkuAvailable,
  attachProductSkuCapability,
  resolveProductSkus,
  productSkuReserveInTx,
} from './product-sku';
import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { tenantTx } from './db';
import { type Actor } from './domain';
import { editProduct } from './catalog';
import { emitCatalogProductEvents, type CatalogProductEvent } from './product-rule-events';
import { ensure } from './errors';
import { productDeletionsAvailable, productNotDeletedSQL } from './product-deletions';
import {
  CATALOG_BULK_EDIT_FIELDS,
  catalogBulkEditPreviewInput,
  catalogBulkEditExecuteInput,
  catalogBulkEditValues,
  type CatalogBulkEditInput,
  type CatalogBulkEditExecute,
} from './catalog-bulk-edit-schema';

export type CatalogBulkEditActor = Actor & { apiKeyId?: string };
const REQUEST_BYTES = 786432;
const stable = (v: any): any =>
  Array.isArray(v)
    ? v.map(stable)
    : v && typeof v === 'object'
      ? Object.fromEntries(
          Object.entries(v)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([k, x]) => [k, stable(x)]),
        )
      : v;
export const catalogBulkEditHash = (v: unknown) =>
  createHash('sha256')
    .update(JSON.stringify(stable(v)))
    .digest('hex');
function safeJson(v: any, depth = 0): void {
  ensure(depth <= 8, 422, 'Dane arkusza mają zbyt głęboką strukturę');
  if (typeof v === 'string')
    ensure(
      !v.includes('\0') && Buffer.from(v, 'utf8').toString('utf8') === v,
      422,
      'Dane arkusza wymagają poprawnego Unicode bez NUL',
    );
  else if (Array.isArray(v)) for (const x of v) safeJson(x, depth + 1);
  else if (v && typeof v === 'object')
    for (const [k, x] of Object.entries(v)) {
      safeJson(k, depth + 1);
      safeJson(x, depth + 1);
    }
}
function requestHash(v: unknown, source: string) {
  ensure(
    Buffer.byteLength(JSON.stringify(v), 'utf8') <= REQUEST_BYTES,
    413,
    'Żądanie przekracza 786432 bajty',
  );
  safeJson(v);
  return catalogBulkEditHash({ source, request: v });
}
async function lock(c: PoolClient, a: Actor) {
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`catalog:${a.tenantId}`]);
  // Same admission as rule create/update and its automatic scheduler.
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    `product.rules:${a.tenantId}`,
  ]);
}
async function role(c: PoolClient, a: CatalogBulkEditActor, write = false) {
  const r = (await c.query('SELECT catalog_bulk_edit_current_role($1) role', [a.userId])).rows[0]
    ?.role;
  ensure(['admin', 'operator', 'viewer'].includes(r), 403, 'Utracono dostęp do katalogu tej firmy');
  ensure(!write || r === 'admin', 403, 'Wymagany aktualny administrator');
  if (write && a.apiKeyId) {
    const key = (
      await c.query('SELECT catalog_bulk_edit_key_grant($1,$2) AS grant_result', [
        a.userId,
        a.apiKeyId,
      ])
    ).rows[0]?.grant_result;
    ensure(key !== 'invalid', 401, 'Klucz API został cofnięty lub wygasł');
    ensure(key === 'ok', 403, 'Klucz API nie ma aktualnych scopes products:read i products:write');
  }
  return r as Actor['role'];
}
async function activeRules(c: PoolClient) {
  if (!(await c.query("SELECT to_regclass('public.product_rules') present")).rows[0].present)
    return [];
  const data = (
    await c.query(`SELECT id,version,event,definition,approved_by,
    to_char(approved_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') approved_at
    FROM product_rules WHERE enabled AND deleted_at IS NULL ORDER BY id FOR SHARE`)
  ).rows;
  ensure(data.length <= 100, 409, 'Przekroczono limit aktywnych reguł produktów');
  return data;
}
const valuesOf = (p: any, fields: readonly string[] = CATALOG_BULK_EDIT_FIELDS) =>
  Object.fromEntries(fields.map((k) => [k, p[k]]));
const previewHead = (p: any) => ({
  id: p.id,
  actor_id: p.actor_id,
  created_at: p.created_at,
  scope_hash: p.scope_hash,
  ready: p.ready,
  total: p.total,
  changed: p.changed,
  unchanged: p.unchanged,
  invalid: p.invalid,
  conflicts: p.conflicts,
  active_product_rules: p.rules_snapshot.length,
});
const executionHead = (e: any) => ({
  id: e.id,
  preview_id: e.preview_id,
  actor_id: e.actor_id,
  state: e.state,
  total: e.total,
  changed: e.changed,
  unchanged: e.unchanged,
  scope_hash: e.scope_hash,
  created_at: e.created_at,
});
const access = (r: string) => ({ current_role: r, can_read: true, can_write: r === 'admin' });
async function quota(c: PoolClient, kind: 'previews' | 'executions') {
  const table = kind === 'previews' ? 'catalog_bulk_edit_previews' : 'catalog_bulk_edit_executions';
  ensure(
    (await c.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n < 2000,
    409,
    `Limit 2000 ${kind === 'previews' ? 'podglądów' : 'wykonań'} arkusza; historia nie jest automatycznie usuwana`,
  );
}
async function preview(c: PoolClient, id: string) {
  const p = (await c.query('SELECT * FROM catalog_bulk_edit_previews WHERE id=$1', [id])).rows[0];
  ensure(p, 404, 'Nie znaleziono podglądu arkusza');
  return p;
}
async function execution(c: PoolClient, id: string) {
  const e = (await c.query('SELECT * FROM catalog_bulk_edit_executions WHERE id=$1', [id])).rows[0];
  ensure(e, 404, 'Nie znaleziono wykonania arkusza');
  return e;
}
type FrozenRow = {
  index: number;
  product_id: string;
  resolved_product_id: string | null;
  sku: string | null;
  expected_version: number;
  current_version: number | null;
  status: 'changed' | 'unchanged' | 'invalid' | 'conflict' | 'missing';
  changes: Record<string, unknown>;
  before: any;
  after: any;
  changed_fields: string[];
  errors: string[];
};
function frozenRow(
  input: CatalogBulkEditInput['rows'][number],
  p: any,
  index: number,
  fields: readonly string[] = CATALOG_BULK_EDIT_FIELDS,
): FrozenRow {
  const r: FrozenRow = {
    index,
    product_id: input.product_id,
    resolved_product_id: p?.id ?? null,
    sku: p?.sku ?? null,
    expected_version: input.version,
    current_version: p?.version ?? null,
    status: 'missing',
    changes: input.changes,
    before: p ? valuesOf(p, fields) : null,
    after: null,
    changed_fields: [],
    errors: [],
  };
  if (!p) {
    r.errors.push('Produkt nie istnieje w tej firmie');
    return r;
  }
  // EAN was historically nullable. An absent patch must preserve that exact value.
  const candidate = { ...r.before, ...input.changes };
  const preserveNullEan = p.ean === null && !Object.hasOwn(input.changes, 'ean');
  // Legacy Zod SKU limits counted code points. Omission must preserve an existing
  // code even when it exceeds the new explicit UTF-16 limit.
  const preserveSku = !Object.hasOwn(input.changes, 'sku');
  const parsed = catalogBulkEditValues.safeParse({
    ...candidate,
    ...(preserveNullEan ? { ean: '' } : {}),
    ...(preserveSku ? { sku: undefined } : {}),
  });
  if (parsed.success) {
    r.after = valuesOf(
      {
        ...parsed.data,
        ...(preserveNullEan ? { ean: null } : {}),
        ...(preserveSku ? { sku: p.sku } : {}),
      },
      fields,
    );
    r.changed_fields = CATALOG_BULK_EDIT_FIELDS.filter(
      (k) =>
        fields.includes(k) && catalogBulkEditHash(r.before[k]) !== catalogBulkEditHash(r.after[k]),
    );
  } else
    r.errors = parsed.error.issues
      .slice(0, 20)
      .map((x) => `${x.path.join('.') || 'changes'}: ${x.message}`);
  if (p.version !== input.version) {
    r.status = 'conflict';
    r.errors.unshift('Wersja produktu zmieniła się od wyboru');
  } else
    r.status = parsed.success ? (r.changed_fields.length ? 'changed' : 'unchanged') : 'invalid';
  return r;
}
async function imageOwnership(c: PoolClient, rows: FrozenRow[]) {
  const ids = [
    ...new Set(
      rows
        .flatMap((r) => r.after?.images ?? [])
        .filter((v: string) => v.startsWith('/api/'))
        .map((v: string) => v.split('/').at(-1)),
    ),
  ];
  const own = new Set(
    (ids.length
      ? (
          await c.query(
            'SELECT id FROM product_images WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE',
            [ids],
          )
        ).rows
      : []
    ).map((x) => x.id),
  );
  for (const r of rows)
    if (
      (r.after?.images ?? []).some(
        (v: string) => v.startsWith('/api/') && !own.has(v.split('/').at(-1)),
      )
    ) {
      r.errors.push('Zdjęcie nie należy do tej firmy lub jest niedostępne');
      if (r.status === 'changed' || r.status === 'unchanged') r.status = 'invalid';
    }
}
async function skuOwnership(c: PoolClient, rows: FrozenRow[]) {
  // Historic plans without before/after.sku retain their original validation scope.
  const targets = rows.filter((r) => typeof r.after?.sku === 'string');
  const codes = [...new Set<string>(targets.map((r) => r.after.sku))];
  const owners = new Map((await resolveProductSkus(c, codes)).map((p) => [p.matched_sku, p.id]));
  const counts = new Map<string, number>();
  for (const row of targets) counts.set(row.after.sku, (counts.get(row.after.sku) ?? 0) + 1);
  for (const row of targets) {
    if ((counts.get(row.after.sku) ?? 0) > 1) row.errors.push('Docelowe SKU powtarza się w partii');
    if (owners.has(row.after.sku) && owners.get(row.after.sku) !== row.product_id)
      row.errors.push('Docelowe SKU jest bieżącym lub historycznym kodem innego produktu');
    if (row.errors.length && ['changed', 'unchanged'].includes(row.status)) row.status = 'invalid';
  }
}
const scope = (actor: string, rows: FrozenRow[], rules: any[]) =>
  catalogBulkEditHash({ actor_id: actor, rows, rules_snapshot: rules });
async function allRows(c: PoolClient, id: string): Promise<FrozenRow[]> {
  return (
    await c.query(
      'SELECT index,product_id,resolved_product_id,sku,expected_version,current_version,status,changes,before,after,changed_fields,errors FROM catalog_bulk_edit_rows WHERE preview_id=$1 ORDER BY index LIMIT 501',
      [id],
    )
  ).rows;
}
export async function catalogBulkEditMetadata(a: Actor) {
  return tenantTx(a.tenantId, async (c) => {
    const rules = (await c.query("SELECT to_regclass('public.product_rules') present")).rows[0]
      .present
      ? (
          await c.query(
            'SELECT count(*)::int n FROM product_rules WHERE enabled AND deleted_at IS NULL',
          )
        ).rows[0].n
      : 0;
    const r = await role(c, a);
    return {
      ...access(r),
      limits: {
        products: 500,
        page: 50,
        request_bytes: REQUEST_BYTES,
        previews: 2000,
        executions: 2000,
      },
      active_product_rules: rules,
      product_logistics_available: await productLogisticsAvailable(c),
      product_sku_edit_available: await productSkuAvailable(c),
    };
  });
}
export async function catalogBulkEditSelection(a: Actor, ids: string[]) {
  return tenantTx(a.tenantId, async (c) => {
    // A deleted product (225) is not a bulk-edit target: it counts as missing.
    const deletions = await productDeletionsAvailable(c);
    const data = (
      await c.query(
        `SELECT id,version,sku,kind,parent_id,name,ean,price,vat,category,description,attributes,images,active FROM products WHERE id=ANY($1::uuid[]) AND ${productNotDeletedSQL(deletions, 'products')} ORDER BY id FOR SHARE`,
        [ids],
      )
    ).rows;
    ensure(data.length === ids.length, 404, 'Co najmniej jeden produkt nie istnieje w tej firmie');
    const attached = await attachProductSkuCapability(c, await attachProductLogistics(c, data));
    return {
      ...access(await role(c, a)),
      data: attached,
      product_logistics_available: attached[0].product_logistics_available,
      product_sku_edit_available: attached[0].product_sku_edit_available,
    };
  });
}
export async function createCatalogBulkEditPreview(
  a: CatalogBulkEditActor,
  input: CatalogBulkEditInput,
  source: 'manual' | 'api' = 'manual',
) {
  const b = catalogBulkEditPreviewInput.parse(input),
    hash = requestHash(b, source);
  return tenantTx(a.tenantId, async (c) => {
    await lock(c, a);
    const old = (
      await c.query('SELECT * FROM catalog_bulk_edit_previews WHERE client_key=$1', [b.client_key])
    ).rows[0];
    if (old) {
      const r = await role(c, a, true);
      ensure(
        old.actor_id === a.userId && old.request_hash === hash,
        409,
        'Klucz podglądu jest związany z innym aktorem lub treścią',
      );
      return { ...access(r), preview: previewHead(old), reused: true };
    }
    await quota(c, 'previews');
    for (const row of b.rows) {
      await ensureProductLogisticsWriteAvailable(c, row.changes);
      if (row.changes.sku !== undefined) await assertProductSkuAvailable(c);
    }
    // A deleted product (225) previews as a missing row.
    const deletions = await productDeletionsAvailable(c);
    const products = (
      await c.query(`SELECT * FROM products WHERE id=ANY($1::uuid[]) AND ${productNotDeletedSQL(deletions, 'products')} ORDER BY id FOR UPDATE`, [
        b.rows.map((r) => r.product_id),
      ])
    ).rows;
    const attached = await attachProductLogistics(c, products);
    const byId = new Map(attached.map((p) => [p.id, p]));
    const rows = b.rows.map((r, i) => frozenRow(r, byId.get(r.product_id), i));
    await imageOwnership(c, rows);
    await skuOwnership(c, rows);
    const rules = await activeRules(c),
      r = await role(c, a, true),
      id = randomUUID();
    const summary = {
      total: rows.length,
      changed: rows.filter((x) => x.status === 'changed').length,
      unchanged: rows.filter((x) => x.status === 'unchanged').length,
      invalid: rows.filter((x) => x.status === 'invalid').length,
      conflicts: rows.filter((x) => x.status === 'conflict' || x.status === 'missing').length,
    };
    const scopeHash = scope(a.userId, rows, rules);
    const p = (
      await c.query(
        `INSERT INTO catalog_bulk_edit_previews(id,tenant_id,actor_id,client_key,request_hash,scope_hash,source,rules_snapshot,total,changed,unchanged,invalid,conflicts,ready)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
        [
          id,
          a.tenantId,
          a.userId,
          b.client_key,
          hash,
          scopeHash,
          source,
          JSON.stringify(rules),
          summary.total,
          summary.changed,
          summary.unchanged,
          summary.invalid,
          summary.conflicts,
          !summary.invalid && !summary.conflicts,
        ],
      )
    ).rows[0];
    await c.query(
      `INSERT INTO catalog_bulk_edit_rows(tenant_id,preview_id,index,product_id,resolved_product_id,sku,expected_version,current_version,status,changes,before,after,changed_fields,errors)
      SELECT $1,$2,index,product_id,resolved_product_id,sku,expected_version,current_version,status,changes,before,after,changed_fields,errors
      FROM jsonb_to_recordset($3::jsonb) x(index integer,product_id uuid,resolved_product_id uuid,sku text,expected_version integer,current_version integer,status text,changes jsonb,before jsonb,after jsonb,changed_fields jsonb,errors jsonb)`,
      [a.tenantId, id, JSON.stringify(rows)],
    );
    return { ...access(r), preview: previewHead(p), reused: false };
  });
}
export async function catalogBulkEditPreviewDetail(a: Actor, id: string) {
  return tenantTx(a.tenantId, async (c) => ({
    ...access(await role(c, a)),
    preview: previewHead(await preview(c, id)),
  }));
}
function pageIndex(cursor?: string) {
  const n = cursor === undefined ? 0 : Number(cursor);
  ensure(Number.isSafeInteger(n) && n >= 0 && n <= 499, 422, 'Nieprawidłowy kursor wierszy');
  return n;
}
export async function catalogBulkEditPreviewRows(a: Actor, id: string, cursor?: string) {
  return tenantTx(a.tenantId, async (c) => {
    await preview(c, id);
    const data = (
      await c.query(
        'SELECT index,product_id,sku,expected_version,current_version,status,before,after,changed_fields,errors FROM catalog_bulk_edit_rows WHERE preview_id=$1 AND index>=$2 ORDER BY index LIMIT 51',
        [id, pageIndex(cursor)],
      )
    ).rows;
    const more = data.length > 50;
    if (more) data.pop();
    return {
      ...access(await role(c, a)),
      data,
      meta: { cursor: more ? String(data.at(-1).index + 1) : null },
    };
  });
}
export async function executeCatalogBulkEdit(
  a: CatalogBulkEditActor,
  id: string,
  input: CatalogBulkEditExecute,
  source: 'manual' | 'api' = 'manual',
) {
  const b = catalogBulkEditExecuteInput.parse(input),
    hash = requestHash({ preview_id: id, ...b }, source);
  return tenantTx(a.tenantId, async (c) => {
    await lock(c, a);
    const old = (
      await c.query('SELECT * FROM catalog_bulk_edit_executions WHERE client_key=$1', [
        b.client_key,
      ])
    ).rows[0];
    if (old) {
      const r = await role(c, a, true);
      ensure(
        old.actor_id === a.userId && old.request_hash === hash,
        409,
        'Klucz wykonania jest związany z innym aktorem lub treścią',
      );
      return { ...access(r), execution: executionHead(old), reused: true };
    }
    const p = await preview(c, id);
    ensure(p.actor_id === a.userId, 403, 'Wykonać podgląd może tylko jego autor');
    ensure(
      p.ready && p.scope_hash === b.scope_hash,
      409,
      'Podgląd nie jest gotowy lub zgoda dotyczy innego zakresu',
    );
    ensure(
      !(await c.query('SELECT id FROM catalog_bulk_edit_executions WHERE preview_id=$1', [id]))
        .rowCount,
      409,
      'Podgląd został już wykonany; użyj pierwotnego klucza',
    );
    await quota(c, 'executions');
    const rows = await allRows(c, id);
    ensure(
      rows.length === p.total &&
        rows.every((r, i) => r.index === i && ['changed', 'unchanged'].includes(r.status)) &&
        scope(p.actor_id, rows, p.rules_snapshot) === p.scope_hash,
      409,
      'Niezgodny zamrożony zakres podglądu',
    );
    const products = (
      await c.query('SELECT * FROM products WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE', [
        rows.map((r) => r.product_id),
      ])
    ).rows;
    await lockProductLogisticsInTx(
      c,
      rows.map((r) => r.product_id),
    );
    const attached = await attachProductLogistics(c, products);
    const byId = new Map(attached.map((x) => [x.id, x]));
    for (const row of rows) {
      const current = byId.get(row.product_id);
      const frozenFields = CATALOG_BULK_EDIT_FIELDS.filter((k) => Object.hasOwn(row.before, k));
      ensure(
        current &&
          current.version === row.expected_version &&
          catalogBulkEditHash(valuesOf(current, frozenFields)) === catalogBulkEditHash(row.before),
        409,
        'Co najmniej jeden produkt zmienił się po podglądzie; cała partia odrzucona',
      );
      const projected = frozenRow(
        { product_id: row.product_id, version: row.expected_version, changes: row.changes },
        current,
        row.index,
        frozenFields,
      );
      ensure(
        projected.status === row.status &&
          catalogBulkEditHash(projected.after) === catalogBulkEditHash(row.after) &&
          catalogBulkEditHash(projected.changed_fields) === catalogBulkEditHash(row.changed_fields),
        409,
        'Niezgodna walidacja zamrożonego wiersza',
      );
    }
    const validated = rows.map((x) => ({ ...x, errors: [...x.errors] }));
    await imageOwnership(c, validated);
    for (const row of validated)
      if (row.changes.sku !== undefined) await assertProductSkuAvailable(c);
    await skuOwnership(c, validated);
    ensure(
      validated.every((x) => x.status === 'changed' || x.status === 'unchanged'),
      409,
      'Zdjęcia lub docelowe SKU podglądu nie są już dostępne w tej firmie',
    );
    const rules = await activeRules(c);
    ensure(
      catalogBulkEditHash(rules) === catalogBulkEditHash(p.rules_snapshot),
      409,
      'Aktywne reguły produktów zmieniły się; wymagany nowy podgląd i zgoda',
    );
    await productSkuReserveInTx(
      c,
      rows
        .filter((row) => row.changes.sku !== undefined)
        .map((row) => ({ product_id: row.product_id, sku: row.after.sku })),
    );
    const currentRole = await role(c, a, true),
      actor = { ...a, role: currentRole };
    const events: CatalogProductEvent[] = [],
      results: any[] = [];
    for (const row of rows) {
      const saved =
        row.status === 'changed'
          ? await editProduct(
              c,
              actor,
              row.product_id,
              {
                ...Object.fromEntries(
                  Object.entries(row.after).filter(
                    ([k]) => k !== 'sku' && !PRODUCT_LOGISTICS_FIELDS.includes(k as any),
                  ),
                ),
                ...Object.fromEntries(
                  PRODUCT_LOGISTICS_FIELDS.filter((k) => row.changes[k] !== undefined).map((k) => [
                    k,
                    row.after[k],
                  ]),
                ),
                version: row.expected_version,
                ...(row.changes.sku === undefined ? {} : { sku: row.after.sku }),
                components: [],
              } as any,
              { preserveComponents: true, deferProductRules: true },
            )
          : byId.get(row.product_id);
      results.push({
        index: row.index,
        product_id: row.product_id,
        sku: row.sku,
        status: row.status,
        before_version: row.expected_version,
        after_version: saved.version,
        changed_fields: row.changed_fields,
      });
      if (row.status === 'changed')
        events.push({
          product_id: row.product_id,
          event: 'product.updated',
          cause_id: randomUUID(),
        });
    }
    // One scheduler call in this same transaction: quota/owner/rule conflicts roll back every product and receipt.
    await emitCatalogProductEvents(c, actor, events);
    const e = (
      await c.query(
        `INSERT INTO catalog_bulk_edit_executions(id,tenant_id,preview_id,actor_id,client_key,request_hash,scope_hash,total,changed,unchanged)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [
          randomUUID(),
          a.tenantId,
          id,
          a.userId,
          b.client_key,
          hash,
          p.scope_hash,
          p.total,
          p.changed,
          p.unchanged,
        ],
      )
    ).rows[0];
    await c.query(
      `INSERT INTO catalog_bulk_edit_execution_rows(tenant_id,execution_id,preview_id,index,product_id,sku,status,before_version,after_version,changed_fields)
      SELECT $1,$2,$3,index,product_id,sku,status,before_version,after_version,changed_fields
      FROM jsonb_to_recordset($4::jsonb) x(index integer,product_id uuid,sku text,status text,before_version integer,after_version integer,changed_fields jsonb)`,
      [a.tenantId, e.id, id, JSON.stringify(results)],
    );
    return { ...access(currentRole), execution: executionHead(e), reused: false };
  });
}
export async function catalogBulkEditExecutionDetail(a: Actor, id: string) {
  return tenantTx(a.tenantId, async (c) => ({
    ...access(await role(c, a)),
    execution: executionHead(await execution(c, id)),
  }));
}
export async function catalogBulkEditExecutionRows(a: Actor, id: string, cursor?: string) {
  return tenantTx(a.tenantId, async (c) => {
    await execution(c, id);
    const data = (
      await c.query(
        'SELECT index,product_id,sku,status,before_version,after_version,changed_fields FROM catalog_bulk_edit_execution_rows WHERE execution_id=$1 AND index>=$2 ORDER BY index LIMIT 51',
        [id, pageIndex(cursor)],
      )
    ).rows;
    const more = data.length > 50;
    if (more) data.pop();
    return {
      ...access(await role(c, a)),
      data,
      meta: { cursor: more ? String(data.at(-1).index + 1) : null },
    };
  });
}
function historyCursor(v?: string): [string | null, string | null] {
  if (!v) return [null, null];
  try {
    const decoded = Buffer.from(v, 'base64url').toString('utf8');
    const a = z.tuple([z.iso.datetime({ precision: 6 }), z.uuid()]).parse(JSON.parse(decoded));
    ensure(Buffer.from(decoded).toString('base64url') === v, 422, 'Nieprawidłowy kursor historii');
    return a;
  } catch {
    ensure(false, 422, 'Nieprawidłowy kursor historii');
  }
}
export async function catalogBulkEditHistory(a: Actor, cursor?: string) {
  const [date, id] = historyCursor(cursor);
  return tenantTx(a.tenantId, async (c) => {
    const rows = (
      await c.query(
        `SELECT *,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') cursor_time FROM catalog_bulk_edit_executions
      WHERE ($1::timestamptz IS NULL OR (created_at,id)<($1::timestamptz,$2::uuid)) ORDER BY created_at DESC,id DESC LIMIT 21`,
        [date, id],
      )
    ).rows;
    const more = rows.length > 20;
    if (more) rows.pop();
    return {
      ...access(await role(c, a)),
      data: rows.map(executionHead),
      meta: {
        cursor: more
          ? Buffer.from(JSON.stringify([rows.at(-1).cursor_time, rows.at(-1).id])).toString(
              'base64url',
            )
          : null,
      },
    };
  });
}
