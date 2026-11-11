import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { pool } from './db';
import { insertAuditEvent } from './audit-log';
import { ensure, Problem } from './errors';
import * as V from './b2b-catalog-scope-schema';

export type B2BCatalogScopeActor = V.B2BCatalogScopeActor;
export type B2BCatalogScopeContext = { readOnly?: boolean };
type Side = 'supplier' | 'buyer';
type Row = Record<string, any>;
type Grant = { role: B2BCatalogScopeActor['role']; manage: boolean; inventory: boolean };
const sideInput = z.enum(['supplier', 'buyer']);
const uuid = z.uuid().transform(value => value.toLowerCase());
const tables = ['b2b_supplier_catalog_scopes', 'b2b_buyer_catalog_scopes', 'b2b_catalog_scope_previews', 'b2b_catalog_scope_operations', 'b2b_catalog_scope_admissions', 'b2b_catalog_bindings'];
const capabilities = { protocol: 'catalog_scope_v1', first_configuration_only: true, publication_available: true, import_available: true } as const;
const incomplete = () => new Problem(503, 'Niekompletny zakres katalogów B2B');

export async function b2bCatalogScopeAvailable(c: Pool | PoolClient = pool): Promise<boolean> {
  const probe = (await c.query(`SELECT to_regprocedure('public.b2b_catalog_scope_installed()') marker,
    EXISTS(SELECT 1 FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'b2b_catalog_scope_%')
    OR EXISTS(SELECT 1 FROM pg_class WHERE relnamespace='public'::regnamespace AND relname=ANY($1::text[]))
    OR EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('public.b2b_catalog_runs') AND attname IN('catalog_scope','catalog_scope_hash','api_key_id') AND NOT attisdropped) partial`, [tables])).rows[0];
  if (!probe.marker) { if (probe.partial) throw incomplete(); return false; }
  try { ensure((await c.query('SELECT public.b2b_catalog_scope_guards() ok')).rows[0]?.ok, 503, 'Niekompletny zakres katalogów B2B'); return true; }
  catch (error: any) { if (['42P01', '42703', '42883'].includes(error.code)) throw incomplete(); throw error; }
}
function mapError(error: any): never {
  if (error instanceof Problem) throw error;
  if (error.code === '55000') throw incomplete();
  if (error.code === '28000') throw new Problem(401, 'Klucz API został cofnięty lub wygasł');
  if (error.code === '42501') throw new Problem(403, 'Brak aktualnego uprawnienia do zakresu B2B');
  if (error.code === 'P0002') throw new Problem(404, 'Nie znaleziono własnego zakresu B2B');
  if (['23514', '23505', '23503'].includes(error.code)) throw new Problem(409, error.message);
  if (error.code === '54000') throw new Problem(413, 'Limit historii zakresu B2B');
  throw error;
}
/** Owner client is trusted server infrastructure; supplied UID is not a DB session identity. */
async function access(c: PoolClient, a: B2BCatalogScopeActor, side: Side, writing: boolean, pin: boolean): Promise<Grant> {
  const role = (await c.query('SELECT role FROM memberships WHERE tenant_id=$1 AND user_id=$2' + (pin ? ' FOR SHARE' : ''), [a.tenantId, a.userId])).rows[0]?.role;
  let scopes: string[] | null = null;
  if (a.apiKeyId) {
    const key = (await c.query('SELECT user_id,scopes,revoked_at,expires_at FROM api_keys WHERE tenant_id=$1 AND id=$2' + (pin ? ' FOR SHARE' : ''), [a.tenantId, a.apiKeyId])).rows[0];
    // Evaluate expiry after any real membership/key wait, against DB clock.
    const now = (await c.query('SELECT clock_timestamp() now')).rows[0].now;
    ensure(key && key.user_id === a.userId && !key.revoked_at && (!key.expires_at || key.expires_at > now), 401, 'Klucz API został cofnięty lub wygasł');
    scopes = key.scopes;
  }
  const has = (needed: string[]) => !scopes || needed.every(scope => scopes!.includes(scope));
  const read = side === 'buyer' ? ['products:read', 'purchasing:read'] : ['products:read'];
  const write = side === 'buyer' ? [...read, 'products:write', 'purchasing:write'] : [...read, 'products:write', 'inventory:read'];
  ensure(['admin', 'operator', 'viewer'].includes(role) && has(read), 403, 'Brak aktualnego uprawnienia do zakresu B2B');
  const manage = role === 'admin' && has(write);
  ensure(!writing || manage, 403, 'Brak aktualnego uprawnienia do zakresu B2B');
  return { role, manage, inventory: has(['inventory:read']) };
}
function flags(g: Grant, ctx: B2BCatalogScopeContext) {
  return { available: true, read_only: !!ctx.readOnly, current_role: g.role, can_read: true, can_manage: g.manage && !ctx.readOnly, can_read_inventory: g.inventory };
}
async function tx(a: B2BCatalogScopeActor, side: Side, writing: boolean, ctx: B2BCatalogScopeContext, body: (c: PoolClient) => Promise<(g: Grant) => Row>): Promise<Row> {
  ensure(!writing || !ctx.readOnly, 423, 'Kopia jest tylko do odczytu');
  uuid.parse(a.tenantId); uuid.parse(a.userId); if (a.apiKeyId) uuid.parse(a.apiKeyId);
  const c = await pool.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    await c.query('RESET ROLE');
    await c.query("SET LOCAL statement_timeout='8s'");
    await c.query("SET LOCAL TimeZone='UTC'");
    await c.query("SELECT set_config('app.tenant_id',$1,true)", [a.tenantId]);
    ensure(await b2bCatalogScopeAvailable(c), 503, 'Kopia nie zawiera zakresów katalogów B2B');
    await access(c, a, side, writing, false);
    // Issuers take their quota before exclusive catalog. Reads need only a
    // shared catalog lock; never acquire it before a writer's quota lock.
    if (!writing) await c.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))', ['catalog:' + a.tenantId]);
    const project = await body(c);
    await c.query('SET CONSTRAINTS ALL IMMEDIATE');
    const g = await access(c, a, side, writing, true);
    const result = { ...project(g), ...flags(g, ctx) };
    // No DB query/hydration follows the terminal owner IAM locks, except COMMIT.
    await c.query('COMMIT');
    return result;
  } catch (error) { await c.query('ROLLBACK').catch(() => {}); return mapError(error); }
  finally { c.release(); }
}
async function entity(c: PoolClient, a: B2BCatalogScopeActor, side: Side, id: string) {
  const sql = side === 'supplier'
    ? 'SELECT id,name,version,active,warehouse_id,price_list_id FROM b2b_accounts WHERE tenant_id=$1 AND id=$2 FOR SHARE'
    : 'SELECT id,version,supplier_name,account_id,paused,schedule_minutes FROM b2b_links WHERE tenant_id=$1 AND id=$2 FOR SHARE';
  const row = (await c.query(sql, [a.tenantId, id])).rows[0];
  ensure(row, 404, 'Nie znaleziono własnego zakresu B2B');
  return { ...row, version: String(row.version) };
}
const fields = (row: Row, keys: string[]): Row => Object.fromEntries(keys.map(key => [key, row[key]]));
function catalog(row: Row, inventory: boolean) {
  return { ...fields(row, ['id', 'name', 'version', 'active', 'is_default', 'default_language', 'languages', 'price_list_ids']), warehouse_ids: inventory ? row.warehouse_ids : [] };
}
function scope(row: Row | null, inventory: boolean): Row | null {
  if (!row) return null;
  const common = fields(row, ['protocol', 'kind', 'version', 'operation_id', 'created_at']); common.version = String(row.version);
  return row.kind === 'supplier'
    ? { ...common, ...fields(row, ['account_id', 'catalog_id', 'price_list_id', 'language']), warehouse_id: inventory ? row.warehouse_id : null }
    : { ...common, ...fields(row, ['link_id', 'target_catalog_id']) };
}
function before(row: Row, side: Side, inventory: boolean) {
  return side === 'supplier' ? { ...fields(row, ['id', 'version', 'price_list_id', 'active']), warehouse_id: inventory ? row.warehouse_id : null }
    : fields(row, ['id', 'version', 'account_id', 'paused', 'schedule_minutes']);
}
function snapshot(row: Row, side: Side, inventory: boolean) {
  return { ...fields(row, ['protocol', 'kind', 'entity_id', 'scope_before']), before: before(row.before, side, inventory), catalog: catalog(row.catalog, inventory),
    resources: side === 'supplier' ? { warehouse: inventory ? row.resources.warehouse : null, price_list: row.resources.price_list, language: row.resources.language }
      : { supplier: { name: row.resources.supplier_name, account_id: row.resources.account_id } } };
}
function request(row: Row, side: Side, inventory: boolean) { return side === 'supplier' && !inventory ? { ...row, warehouse_id: null } : row; }
async function rawScope(c: PoolClient, tenant: string, side: Side, id: string) {
  const table = side === 'supplier' ? 'b2b_supplier_catalog_scopes' : 'b2b_buyer_catalog_scopes';
  return (await c.query(`SELECT * FROM ${table} WHERE tenant_id=$1 AND ${side === 'supplier' ? 'account_id' : 'link_id'}=$2`, [tenant, id])).rows[0] ?? null;
}
async function previewProject(c: PoolClient, a: B2BCatalogScopeActor, id: string, ctx: B2BCatalogScopeContext) {
  const p = (await c.query('SELECT * FROM b2b_catalog_scope_previews WHERE tenant_id=$1 AND id=$2', [a.tenantId, id])).rows[0];
  ensure(p, 404, 'Nie znaleziono własnego podglądu B2B');
  await entity(c, a, p.kind, p.entity_id);
  const committed = (await c.query('SELECT id FROM b2b_catalog_scope_operations WHERE tenant_id=$1 AND preview_id=$2', [a.tenantId, id])).rows[0]?.id ?? null;
  return (g: Grant) => ({ ...fields(p, ['id', 'kind', 'entity_id', 'catalog_id', 'scope_hash', 'created_at', 'expires_at']),
    request: request(p.request, p.kind, g.inventory), snapshot: snapshot(p.payload, p.kind, g.inventory), ready: true, committed_operation_id: committed,
    can_commit: g.manage && !ctx.readOnly && !committed && p.actor_id === a.userId && (p.api_key_id ?? null) === (a.apiKeyId ?? null) && Date.parse(p.expires_at) > Date.now() });
}
async function operationProject(c: PoolClient, a: B2BCatalogScopeActor, id: string) {
  const op = (await c.query('SELECT * FROM b2b_catalog_scope_operations WHERE tenant_id=$1 AND id=$2', [a.tenantId, id])).rows[0];
  ensure(op, 404, 'Nie znaleziono własnego wykonania B2B');
  await entity(c, a, op.kind, op.entity_id);
  return (g: Grant) => ({ ...fields(op, ['id', 'preview_id', 'kind', 'entity_id', 'request', 'created_at']), scope_hash: op.payload.scope_hash,
    snapshot: snapshot(op.payload.snapshot, op.kind, g.inventory), before: before(op.payload.before, op.kind, g.inventory),
    after: before(op.payload.after, op.kind, g.inventory), scope: scope(op.payload.scope, g.inventory) });
}
async function storedSide(c: PoolClient, a: B2BCatalogScopeActor, id: string, table: 'b2b_catalog_scope_previews' | 'b2b_catalog_scope_operations'): Promise<Side> {
  const p = (await c.query(`SELECT kind FROM ${table} WHERE tenant_id=$1 AND id=$2`, [a.tenantId, id])).rows[0];
  ensure(p, 404, 'Nie znaleziono własnego dowodu B2B'); return sideInput.parse(p.kind);
}
// Determine receipt kind using an own-tenant owner lookup; tx rechecks current IAM.
async function receiptSide(a: B2BCatalogScopeActor, id: string, table: 'b2b_catalog_scope_previews' | 'b2b_catalog_scope_operations') {
  ensure(await b2bCatalogScopeAvailable(), 503, 'Kopia nie zawiera zakresów katalogów B2B');
  const c = await pool.connect(); try { return await storedSide(c, a, id, table); } finally { c.release(); }
}
export async function b2bCatalogScopeOptions(a: B2BCatalogScopeActor, kind: Side, entityId: string, ctx: B2BCatalogScopeContext = {}): Promise<Row> {
  const side = sideInput.parse(kind), id = uuid.parse(entityId);
  if (!await b2bCatalogScopeAvailable()) return { available: false, read_only: !!ctx.readOnly, current_role: null, can_read: false, can_manage: false, can_read_inventory: false, source: null, scope: null, resources: { catalogs: [], warehouses: [], price_lists: [], languages: [] }, capabilities: { ...capabilities,publication_available:false,import_available:false }, limits: V.B2B_CATALOG_SCOPE_LIMITS };
  return tx(a, side, false, ctx, async c => {
    const e = await entity(c, a, side, id), s = await rawScope(c, a.tenantId, side, id);
    const options = (await c.query('SELECT public.product_catalog_options_in_tx() r')).rows[0].r;
    return g => ({ source: { kind: side, entity_id: id, [side === 'supplier' ? 'account' : 'link']: side === 'supplier' ? { ...e, warehouse_id: g.inventory ? e.warehouse_id : null } : e, scope: scope(s, g.inventory) }, scope: scope(s, g.inventory),
      resources: { catalogs: options.catalogs.map((p: Row) => catalog(p, g.inventory)), warehouses: g.inventory ? options.warehouses : [], price_lists: options.price_lists, languages: options.languages },
      capabilities, limits: V.B2B_CATALOG_SCOPE_LIMITS, can_preview: g.manage && !ctx.readOnly && !s });
  });
}
export async function b2bCatalogScopePreview(a: B2BCatalogScopeActor, id: string, ctx: B2BCatalogScopeContext = {}) {
  id = uuid.parse(id); const side = await receiptSide(a, id, 'b2b_catalog_scope_previews');
  return tx(a, side, false, ctx, async c => { const project = await previewProject(c, a, id, ctx); return g => ({ preview: project(g) }); });
}
export async function b2bCatalogScopeOperation(a: B2BCatalogScopeActor, id: string, ctx: B2BCatalogScopeContext = {}) {
  id = uuid.parse(id); const side = await receiptSide(a, id, 'b2b_catalog_scope_operations');
  return tx(a, side, false, ctx, async c => { const project = await operationProject(c, a, id); return g => ({ operation: project(g) }); });
}
export async function b2bCatalogScopeHistory(a: B2BCatalogScopeActor, kind: Side, entityId: string, query: unknown = {}, ctx: B2BCatalogScopeContext = {}) {
  const side = sideInput.parse(kind), id = uuid.parse(entityId), q = V.b2bCatalogScopeHistoryQuery.parse(query);
  return tx(a, side, false, ctx, async c => {
    await entity(c, a, side, id);
    const table = q.kind === 'preview' ? 'b2b_catalog_scope_previews' : 'b2b_catalog_scope_operations';
    const projection = q.kind === 'preview' ? 'p.id,p.kind,p.entity_id,p.catalog_id,p.scope_hash,p.created_at,p.expires_at,(SELECT o.id FROM b2b_catalog_scope_operations o WHERE o.tenant_id=p.tenant_id AND o.preview_id=p.id) committed_operation_id'
      : "p.id,p.preview_id,p.kind,p.entity_id,p.payload->>'scope_hash' scope_hash,p.created_at";
    const rows = (await c.query(`SELECT ${projection} FROM ${table} p WHERE p.tenant_id=$1 AND p.kind=$2 AND p.entity_id=$3 AND($4::uuid IS NULL OR p.id>$4) ORDER BY p.id LIMIT $5`, [a.tenantId, side, id, q.cursor ?? null, q.limit + 1])).rows;
    const data = rows.slice(0, q.limit), next_cursor = rows.length > q.limit ? data.at(-1)!.id : null;
    return () => ({ data, next_cursor });
  });
}
async function preview(a: B2BCatalogScopeActor, side: Side, id: string, input: unknown, ctx: B2BCatalogScopeContext) {
  ensure(!ctx.readOnly, 423, 'Kopia jest tylko do odczytu');
  ensure(await b2bCatalogScopeAvailable(), 503, 'Kopia nie zawiera zakresów katalogów B2B');
  const b = (side === 'supplier' ? V.b2bSupplierCatalogScopePreviewInput : V.b2bBuyerCatalogScopePreviewInput).parse(input);
  id = uuid.parse(id);
  return tx(a, side, true, ctx, async c => {
    const r = (await c.query('SELECT public.b2b_catalog_scope_preview($1,$2,$3,$4,$5::jsonb) r', [a.userId, a.apiKeyId ?? null, side, id, JSON.stringify(b)])).rows[0].r;
    if (!r.reused) await insertAuditEvent(c, a, 'b2b.catalog_scope.previewed', r.preview.id, { kind: side, entity_id: id });
    const project = await previewProject(c, a, r.preview.id, ctx);
    return g => ({ preview: project(g), reused: r.reused });
  });
}
export const previewB2BSupplierCatalogScope = (a: B2BCatalogScopeActor, id: string, input: unknown, ctx: B2BCatalogScopeContext = {}) => preview(a, 'supplier', id, input, ctx);
export const previewB2BBuyerCatalogScope = (a: B2BCatalogScopeActor, id: string, input: unknown, ctx: B2BCatalogScopeContext = {}) => preview(a, 'buyer', id, input, ctx);
export async function commitB2BCatalogScope(a: B2BCatalogScopeActor, id: string, input: unknown, ctx: B2BCatalogScopeContext = {}) {
  ensure(!ctx.readOnly, 423, 'Kopia jest tylko do odczytu');
  ensure(await b2bCatalogScopeAvailable(), 503, 'Kopia nie zawiera zakresów katalogów B2B');
  const b = V.b2bCatalogScopeCommitInput.parse(input); id = uuid.parse(id);
  const side = await receiptSide(a, id, 'b2b_catalog_scope_previews');
  return tx(a, side, true, ctx, async c => {
    const r = (await c.query('SELECT public.b2b_catalog_scope_commit($1,$2,$3,$4::jsonb) r', [a.userId, a.apiKeyId ?? null, id, JSON.stringify(b)])).rows[0].r;
    if (!r.reused) await insertAuditEvent(c, a, 'b2b.catalog_scope.committed', r.operation.id, { preview_id: id });
    const project = await operationProject(c, a, r.operation.id);
    return g => { const operation = project(g); return { operation, scope: operation.scope, reused: r.reused }; };
  });
}
