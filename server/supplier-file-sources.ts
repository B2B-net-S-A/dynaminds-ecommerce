import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { Actor } from './domain';
import { audit } from './domain';
import { ensure, Problem } from './errors';
import { encrypt } from './security';
import { wmsLotsHash } from './wms-lots';
import { supplierConnection, supplierSourceConnection } from './supplier-catalog';
import { parseSupplierFileSource } from './supplier-file-source-parse';
import {
  sourceCreateInput,
  configUpdateInput,
  previewInput,
  applyInput,
  pageInput,
  type SupplierFileSourceCreateInput,
  type SupplierFileSourceConfigUpdateInput,
  type SupplierFileSourcePreviewInput,
  type SupplierFileSourceApplyInput,
  type SupplierFileSourcePageInput,
} from './supplier-file-source-schema';

export type SupplierFileSourceActor = Actor & { apiKeyId?: string; canReadValue?: boolean };
export const SUPPLIER_FILE_SOURCE_SERVICE_LIMITS = {
  file_bytes: 2097152,
  rows: 500,
  source_items: 10000,
  sources: 100,
  previews: 200,
  retained_raw_bytes: 33554432,
  retained_evidence_bytes: 33554432,
  preview_bytes: 8388608,
} as const;
const tables = [
  'supplier_file_source_configs',
  'supplier_file_source_revisions',
  'supplier_file_previews',
  'supplier_file_preview_rows',
  'supplier_file_runs',
  'supplier_file_run_rows',
];
const functions = [
  'supplier_file_installed()',
  'supplier_file_access(uuid,uuid,boolean,boolean)',
  'supplier_file_source_create(jsonb,uuid,uuid)',
  'supplier_file_source_update(uuid,jsonb,uuid,uuid)',
  'supplier_file_store_preview(jsonb,uuid,uuid)',
  'supplier_file_apply(uuid,uuid,text,jsonb,uuid,uuid)',
  'supplier_file_require(uuid,uuid,boolean)',
  'supplier_file_immutable()',
  'supplier_file_catalog_guard()',
  'supplier_file_run_complete()',
  'supplier_file_quota(uuid)',
  'supplier_file_config_valid(jsonb)',
  'language_file_import_hash(jsonb)',
  'supplier_file_source_identity()',
];
export async function supplierFileSourcesAvailable(c: Pool | PoolClient) {
  const r = (
    await c.query(
      `SELECT
    (SELECT count(*) FROM unnest($1::text[]) n JOIN pg_class p ON p.oid=to_regclass(n) WHERE p.relrowsecurity AND p.relforcerowsecurity)=$2 AS tables,
    (SELECT count(*) FROM unnest($3::text[]) n WHERE to_regprocedure(n) IS NOT NULL)=$4 AS functions,
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='supplier_sources'::regclass AND attname='kind' AND NOT attisdropped) AS kind,
    (SELECT count(*) FROM unnest($1::text[]) n JOIN pg_trigger t ON t.tgrelid=to_regclass(n) AND t.tgname='supplier_file_immutable' AND t.tgenabled='O' AND t.tgfoid=to_regprocedure('supplier_file_immutable()'))=$2 AS immutable,
    EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='supplier_catalog_items'::regclass AND tgname='supplier_file_catalog_guard' AND tgenabled='O' AND tgfoid=to_regprocedure('supplier_file_catalog_guard()')) AS guard,
    EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('supplier_file_runs') AND tgname='supplier_file_run_complete' AND tgdeferrable AND tginitdeferred AND tgenabled='O' AND tgfoid=to_regprocedure('supplier_file_run_complete()')) AS complete,
    EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='supplier_sources'::regclass AND tgname='supplier_file_source_identity' AND tgenabled='O' AND tgfoid=to_regprocedure('supplier_file_source_identity()')) AS source_guard`,
      [tables, tables.length, functions, functions.length],
    )
  ).rows[0];
  return !!(
    r?.tables &&
    r.functions &&
    r.kind &&
    r.immutable &&
    r.guard &&
    r.complete &&
    r.source_guard
  );
}
const businessConflicts = new Set([
  'Klucz konfiguracji użyto z innymi danymi',
  'Źródło zmieniło wersję',
  'Klucz wykonania użyto z innymi danymi',
  'Źródło zmieniło wersję lub jest nieaktywne',
  'Katalog dostawcy zmienił się po podglądzie',
  'Pozycja dostawcy zmieniła się po podglądzie',
  'Podgląd należy do innego aktora lub klucza',
  'Wymagane potwierdzenie wycofania brakujących pozycji',
]);
async function businessQuery(c: PoolClient, sql: string, values: unknown[] = []) {
  try {
    return await c.query(sql, values);
  } catch (error) {
    const e = error as { code?: string; message?: string };
    if (e.code === '23514' && e.message && businessConflicts.has(e.message))
      throw new Problem(409, e.message);
    if (e.code === '42501' && e.message === 'Klucz API wygasł lub został wycofany')
      throw new Problem(401, e.message);
    if (e.code === '42501' && e.message === 'Brak aktualnych uprawnień purchasing')
      throw new Problem(403, e.message);
    throw error;
  }
}
const hash = (v: unknown) => wmsLotsHash(v);
const previewColumns =
  'id,tenant_id,source_id,source_version,actor_id,api_key_id,client_key,request_hash,scope_hash,raw_hash,raw_bytes,payload,created_at';
export const supplierFileRequestHash = (
  a: SupplierFileSourceActor,
  kind: string,
  parent: string | null,
  request: unknown,
) =>
  hash({
    tenant_id: a.tenantId,
    actor_id: a.userId,
    api_key_id: a.apiKeyId ?? null,
    kind,
    parent_id: parent,
    request,
  });
async function access(c: PoolClient, a: SupplierFileSourceActor, write = false, pin = false) {
  const ctx = (
    await c.query("SELECT current_user role,current_setting('app.tenant_id',true) tenant")
  ).rows[0];
  ensure(
    ctx.role === 'dyna_app' && ctx.tenant === a.tenantId,
    403,
    'Niezgodny kontekst źródła plikowego',
  );
  ensure(await supplierFileSourcesAvailable(c), 503, 'Moduł źródeł plikowych jest niekompletny');
  const g = (
    await c.query('SELECT supplier_file_access($1,$2,$3,$4) g', [
      a.userId,
      a.apiKeyId ?? null,
      write,
      pin,
    ])
  ).rows[0].g;
  ensure(g.key_valid, 401, 'Klucz API wygasł lub został wycofany');
  ensure(g.allowed, 403, 'Brak aktualnych uprawnień purchasing do źródła plikowego');
  return {
    available: true,
    read_only: false,
    current_role: g.role,
    can_read: true,
    can_manage: g.can_write,
    can_write: g.can_write,
    can_read_value: a.canReadValue ?? true,
  };
}
/** Internal composition only: the outer transaction must finalize its complete graph and principal. */
export type SupplierFileSourceFinalizationOptions = {
  deferConstraintFinalization?: boolean;
  deferPrincipalPin?: boolean;
};
async function finalize(
  c: PoolClient,
  a: SupplierFileSourceActor,
  write: boolean,
  options: SupplierFileSourceFinalizationOptions = {},
) {
  ensure(
    Boolean(options.deferConstraintFinalization) === Boolean(options.deferPrincipalPin),
    500,
    'Niezgodna finalizacja transakcji źródła plikowego',
  );
  if (write && !options.deferConstraintFinalization)
    await businessQuery(c, 'SET CONSTRAINTS ALL IMMEDIATE');
  return access(c, a, write, !options.deferPrincipalPin);
}
function project(v: unknown, values: boolean): any {
  if (Array.isArray(v)) return v.map((x) => project(x, values));
  if (v instanceof Date) return v.toISOString();
  if (v && typeof v === 'object')
    return Object.fromEntries(
      Object.entries(v)
        .filter(
          ([k]) =>
            ![
              'raw_content',
              'request_hash',
              'top_xid',
              'transaction_started_at',
              'expected_items',
            ].includes(k) &&
            (values || !['unit_cost', 'tiers', 'currency'].includes(k)),
        )
        .map(([k, x]) => [k, project(x, values)]),
    );
  return v;
}
async function lockTenant(c: PoolClient, a: SupplierFileSourceActor) {
  await c.query("SELECT pg_advisory_xact_lock(hashtextextended('supplier-file:'||$1,0))", [
    a.tenantId,
  ]);
}
async function source(c: PoolClient, id: string, locked = false) {
  const s = (
    await c.query(
      `SELECT s.*,cfg.config,p.name supplier_name FROM supplier_sources s JOIN supplier_file_source_configs cfg ON (cfg.tenant_id,cfg.source_id)=(s.tenant_id,s.id) JOIN suppliers p ON(p.tenant_id,p.id)=(s.tenant_id,s.supplier_id) WHERE s.id=$1 AND s.kind='file'${locked ? ' FOR UPDATE OF s' : ''}`,
      [id],
    )
  ).rows[0];
  ensure(s, 404, 'Nie znaleziono plikowego źródła dostawcy');
  return s;
}
const identity = (r: { remote_product_id: string; remote_variant_id?: string | null }) =>
  JSON.stringify([r.remote_product_id, r.remote_variant_id ?? '']);
async function items(c: PoolClient, id: string, lock = false) {
  const rows = (
    await c.query(
      `SELECT id,remote_product_id,remote_variant_id,sku,name,product_id,version,snapshot,encode(sha256(convert_to(snapshot::text,'UTF8')),'hex') snapshot_hash FROM supplier_catalog_items WHERE source_id=$1 ORDER BY id${lock ? ' FOR UPDATE' : ''}`,
      [id],
    )
  ).rows;
  ensure(rows.length <= 10000, 413, 'Źródło przekracza 10000 zachowanych pozycji');
  return rows;
}
function sourceView(s: any) {
  const { tenant_id, ...v } = s;
  return v;
}
async function previewView(c: PoolClient, p: any, a: SupplierFileSourceActor) {
  const s = await source(c, p.source_id);
  const run = (await c.query('SELECT id FROM supplier_file_runs WHERE preview_id=$1', [p.id]))
    .rows[0];
  return {
    ...p.payload,
    id: p.id,
    scope_hash: p.scope_hash,
    created_at: p.created_at,
    executed_run_id: run?.id ?? null,
    can_apply:
      p.actor_id === a.userId &&
      p.api_key_id === (a.apiKeyId ?? null) &&
      !run &&
      !s.paused &&
      s.version === p.source_version &&
      p.payload.summary.invalid === 0,
  };
}
async function runView(c: PoolClient, id: string) {
  const r = (
    await c.query(
      `SELECT r.*,p.scope_hash FROM supplier_file_runs r
       JOIN supplier_file_previews p ON (p.tenant_id,p.id)=(r.tenant_id,r.preview_id)
       WHERE r.id=$1`,
      [id],
    )
  ).rows[0];
  ensure(r, 404, 'Nie znaleziono wykonania źródła');
  const receipt = (
    await c.query('SELECT payload FROM supplier_file_run_rows WHERE run_id=$1 ORDER BY index', [id])
  ).rows;
  const n = r.payload.rows.length;
  return {
    ...r.payload,
    id: r.id,
    scope_hash: r.scope_hash,
    created_at: r.created_at,
    rows: receipt.slice(0, n).map((x: any, i: number) => ({
      ...r.payload.rows[i],
      item_id: x.payload.item_id,
      after: x.payload.after,
    })),
    missing: receipt.slice(n).map((x: any, i: number) => ({
      ...r.payload.missing[i],
      item_id: x.payload.item_id,
      after: x.payload.after,
    })),
  };
}
export async function createSupplierFileSource(
  c: PoolClient,
  a: SupplierFileSourceActor,
  input: SupplierFileSourceCreateInput,
) {
  await access(c, a, true);
  const b = sourceCreateInput.parse(input);
  await lockTenant(c, a);
  await access(c, a, true);
  const v = { ...b, id: randomUUID(), request_hash: supplierFileRequestHash(a, 'create', null, b) };
  const result = (
    await businessQuery(c, 'SELECT supplier_file_source_create($1,$2,$3) v', [
      JSON.stringify(v),
      a.userId,
      a.apiKeyId ?? null,
    ])
  ).rows[0].v;
  if (!result.reused)
    await audit(c, a, 'supplier.file.source.created', result.id, {
      supplier_id: b.supplier_id,
      name: b.name,
    });
  const flags = await finalize(c, a, true);
  return {
    source: project(sourceView(await source(c, result.id)), flags.can_read_value),
    reused: !!result.reused,
    ...flags,
  };
}
export async function updateSupplierFileSource(
  c: PoolClient,
  a: SupplierFileSourceActor,
  id: string,
  input: SupplierFileSourceConfigUpdateInput,
  options: SupplierFileSourceFinalizationOptions = {},
) {
  await access(c, a, true);
  const b = configUpdateInput.parse(input);
  await lockTenant(c, a);
  await source(c, id, true);
  await access(c, a, true);
  const v = { ...b, request_hash: supplierFileRequestHash(a, 'config', id, b) };
  const result = (
    await businessQuery(c, 'SELECT supplier_file_source_update($1,$2,$3,$4) v', [
      id,
      JSON.stringify(v),
      a.userId,
      a.apiKeyId ?? null,
    ])
  ).rows[0].v;
  if (!result.reused)
    await audit(c, a, 'supplier.file.source.updated', id, { version: result.version });
  const flags = await finalize(c, a, true, options);
  return {
    source: project(sourceView(await source(c, id)), flags.can_read_value),
    reused: !!result.reused,
    ...flags,
  };
}
export async function previewSupplierFileSource(
  c: PoolClient,
  a: SupplierFileSourceActor,
  id: string,
  input: SupplierFileSourcePreviewInput,
  options: SupplierFileSourceFinalizationOptions = {},
) {
  await access(c, a, true);
  const b = previewInput.parse(input);
  await lockTenant(c, a);
  const s = await source(c, id, true);
  await access(c, a, true);
  const request_hash = supplierFileRequestHash(a, 'preview', id, b);
  const old = (
    await c.query(
      `SELECT ${previewColumns} FROM supplier_file_previews WHERE source_id=$1 AND client_key=$2`,
      [id, b.client_key],
    )
  ).rows[0];
  if (old) {
    ensure(
      old.request_hash === request_hash &&
        old.actor_id === a.userId &&
        old.api_key_id === (a.apiKeyId ?? null),
      409,
      'Klucz podglądu użyto z innymi danymi lub aktorem',
    );
    const flags = await finalize(c, a, true, options),
      preview = project(await previewView(c, old, a), flags.can_read_value);
    return { preview, rows: preview.rows, missing: preview.missing, reused: true, ...flags };
  }
  ensure(s.version === b.version, 409, 'Źródło zmieniło wersję');
  const ch = await supplierSourceConnection(c, s),
    connection_hash = supplierConnection(s, ch);
  const parsed = parseSupplierFileSource(b.content, s.config, s.currency, s.max_handling_days);
  const existing = await items(c, id, true),
    map = new Map(existing.map((r) => [identity(r), r]));
  const rows = parsed.map((r) => {
    const prev = map.get(identity(r)),
      snapshot = r.snapshot ? { ...r.snapshot, connection_hash, source_version: s.version } : null;
    return {
      ...r,
      remote_variant_id: r.remote_variant_id ?? '',
      snapshot,
      before: prev?.snapshot ?? null,
      item_id: prev?.id ?? null,
      expected_version: prev?.version ?? null,
      status: r.errors.length
        ? 'invalid'
        : !prev
          ? 'new'
          : hash(snapshot) !== hash(cleanSnapshot(prev.snapshot))
            ? 'changed'
            : 'unchanged',
    };
  });
  const seen = new Set(rows.map(identity));
  const missing = b.scope === 'full' ? existing.filter((r) => !seen.has(identity(r))) : [];
  ensure(
    existing.length + rows.filter((r) => r.status === 'new').length <= 10000,
    413,
    'Źródło przekracza 10000 zachowanych pozycji',
  );
  const summary = {
    total: rows.length,
    valid: rows.filter((r) => !r.errors.length).length,
    invalid: rows.filter((r) => r.errors.length).length,
    new: rows.filter((r) => r.status === 'new').length,
    changed: rows.filter((r) => r.status === 'changed').length,
    unchanged: rows.filter((r) => r.status === 'unchanged').length,
    missing: missing.length,
  };
  const pid = randomUUID(),
    raw_hash = createHash('sha256').update(b.content, 'utf8').digest('hex');
  const payload = JSON.parse(
    JSON.stringify({
      id: pid,
      source_id: id,
      source_version: s.version,
      client_key: b.client_key,
      raw_hash,
      filename: b.filename,
      scope: b.scope,
      source_snapshot: sourceView(s),
      config_snapshot: s.config,
      connection_hash,
      summary,
      rows,
      missing,
      expected_items: existing.map(({ id, version, product_id, snapshot_hash }) => ({
        id,
        version,
        product_id,
        snapshot_hash,
      })),
    }),
  );
  ensure(
    Buffer.byteLength(JSON.stringify(payload), 'utf8') <= 8388608,
    413,
    'Pełny podgląd przekracza 8 MiB',
  );
  const scope_hash = hash(payload);
  await businessQuery(c, 'SELECT supplier_file_store_preview($1,$2,$3)', [
    JSON.stringify({
      id: pid,
      source_id: id,
      source_version: s.version,
      client_key: b.client_key,
      request_hash,
      scope_hash,
      raw_hash,
      raw_bytes: Buffer.byteLength(b.content, 'utf8'),
      raw_content: encrypt({ content: b.content }),
      payload,
    }),
    a.userId,
    a.apiKeyId ?? null,
  ]);
  await audit(c, a, 'supplier.file.preview', pid, {
    source_id: id,
    raw_hash,
    summary,
    scope: b.scope,
  });
  const flags = await finalize(c, a, true, options);
  const preview = project(
    {
      ...payload,
      scope_hash,
      created_at: (
        await c.query('SELECT created_at FROM supplier_file_previews WHERE id=$1', [pid])
      ).rows[0].created_at,
      can_apply: summary.invalid === 0,
      executed_run_id: null,
    },
    flags.can_read_value,
  );
  return { preview, rows: preview.rows, missing: preview.missing, ...flags };
}
function cleanSnapshot(s: any) {
  const { file_preview_id, file_run_id, raw_hash, withdrawn_by_file_run_id, ...rest } = s;
  return rest;
}
export async function applySupplierFileSource(
  c: PoolClient,
  a: SupplierFileSourceActor,
  previewId: string,
  input: SupplierFileSourceApplyInput,
  options: SupplierFileSourceFinalizationOptions = {},
) {
  await access(c, a, true);
  const b = applyInput.parse(input);
  await lockTenant(c, a);
  const p = (
    await c.query(`SELECT ${previewColumns} FROM supplier_file_previews WHERE id=$1`, [previewId])
  ).rows[0];
  ensure(p, 404, 'Nie znaleziono podglądu');
  await source(c, p.source_id, true);
  await access(c, a, true);
  ensure(
    p.actor_id === a.userId && p.api_key_id === (a.apiKeyId ?? null),
    409,
    'Podgląd należy do innego aktora lub klucza',
  );
  ensure(b.confirm_rows === p.payload.rows.length, 422, 'Zgoda wymaga pełnej liczby wierszy');
  ensure(!p.payload.summary.invalid, 422, 'Podgląd zawiera niepoprawne wiersze');
  ensure(
    p.payload.scope !== 'full' || !p.payload.missing.length || b.confirm_missing,
    409,
    'Wymagane potwierdzenie wycofania brakujących pozycji',
  );
  const request_hash = supplierFileRequestHash(a, 'apply', previewId, b);
  const result = (
    await businessQuery(c, 'SELECT supplier_file_apply($1,$2,$3,$4,$5,$6) v', [
      previewId,
      randomUUID(),
      request_hash,
      JSON.stringify(b),
      a.userId,
      a.apiKeyId ?? null,
    ])
  ).rows[0].v;
  if (!result.reused)
    await audit(c, a, 'supplier.file.applied', result.id, {
      preview_id: previewId,
      source_id: p.source_id,
      raw_hash: p.raw_hash,
      summary: result.summary,
    });
  const flags = await finalize(c, a, true, options);
  const run = project(await runView(c, result.id), flags.can_read_value);
  return { run, rows: run.rows, missing: run.missing, reused: !!result.reused, ...flags };
}
export async function fileSourceDetail(c: PoolClient, a: SupplierFileSourceActor, id: string) {
  await access(c, a);
  const s = await source(c, id);
  const flags = await finalize(c, a, false);
  return { source: project(sourceView(s), flags.can_read_value), ...flags };
}
export async function filePreviewDetail(c: PoolClient, a: SupplierFileSourceActor, id: string) {
  await access(c, a);
  const p = (
    await c.query(`SELECT ${previewColumns} FROM supplier_file_previews WHERE id=$1`, [id])
  ).rows[0];
  ensure(p, 404, 'Nie znaleziono podglądu');
  const v = await previewView(c, p, a),
    flags = await finalize(c, a, false),
    preview = project({ ...v, can_apply: v.can_apply && flags.can_manage }, flags.can_read_value);
  return { preview, rows: preview.rows, missing: preview.missing, ...flags };
}
export async function fileSourceHistory(
  c: PoolClient,
  a: SupplierFileSourceActor,
  id: string,
  input: SupplierFileSourcePageInput,
) {
  await access(c, a);
  await source(c, id);
  const q = pageInput.parse(input);
  if (q.after)
    ensure(
      (
        await c.query('SELECT id FROM supplier_file_runs WHERE source_id=$1 AND id=$2', [
          id,
          q.after,
        ])
      ).rowCount,
      404,
      'Nie znaleziono kursora źródła',
    );
  const rows = (
    await c.query(
      'SELECT * FROM supplier_file_runs WHERE source_id=$1 AND ($2::uuid IS NULL OR (created_at,id)<(SELECT created_at,id FROM supplier_file_runs WHERE id=$2 AND source_id=$1)) ORDER BY created_at DESC,id DESC LIMIT $3',
      [id, q.after ?? null, q.limit + 1],
    )
  ).rows;
  const total = (
    await c.query('SELECT count(*)::int n FROM supplier_file_runs WHERE source_id=$1', [id])
  ).rows[0].n;
  const data = [];
  for (const r of rows.slice(0, q.limit)) data.push(await runView(c, r.id));
  const flags = await finalize(c, a, false);
  return {
    data: project(data, flags.can_read_value),
    meta: {
      total,
      has_more: rows.length > q.limit,
      cursor: rows.length > q.limit ? rows[q.limit - 1].id : null,
    },
    ...flags,
  };
}
export const supplierFileSourceAvailable = supplierFileSourcesAvailable;
