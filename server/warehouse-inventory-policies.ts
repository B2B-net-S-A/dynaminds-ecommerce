import { beginCatalogStockControlTransaction, endCatalogStockControlTransaction,
  catalogStockControlAdmissionInTx, finalizeCatalogStockControlActorsInTx, finalizeCatalogStockCountTerminalInTx } from './catalog-stock-control-transaction';
import { beginWmsTransaction, endWmsTransaction, wmsLotsAdmissionInTx, finalizeWmsActorsInTx } from './wms-lots-transaction';
import { beginPurchasingTransaction, endPurchasingTransaction, purchasingStockAdmissionInTx } from './purchasing-transaction';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { pool } from './db';
import { ensure, Problem } from './errors';
import * as V from './warehouse-inventory-policies-schema';

const tables = ['warehouse_inventory_policies', 'warehouse_inventory_policy_revisions', 'warehouse_inventory_policy_previews', 'warehouse_inventory_policy_operations', 'warehouse_inventory_policy_admissions'];
const uuid = z.uuid().transform(v => v.toLowerCase());
const incomplete = () => new Problem(503, 'Niekompletna polityka magazynów');
type Row = Record<string, any>;
type Context = { readOnly?: boolean };
function mapError(e: any): never {
  if (e instanceof Problem) throw e;
  if (e.code === '55000') throw incomplete();
  if (e.code === '28000') throw new Problem(401, 'Klucz API został cofnięty lub wygasł');
  if (e.code === '42501') throw new Problem(403, 'Brak aktualnego uprawnienia do polityki magazynu');
  if (e.code === 'P0002') throw new Problem(404, 'Nie znaleziono własnego magazynu lub dowodu');
  if (['23514', '23505', '23503'].includes(e.code)) throw new Problem(409, e.message);
  if (e.code === '54000') throw new Problem(413, 'Limit historii polityki magazynu');
  throw e;
}
/** Same-client owner bridge is trusted server infrastructure, not raw SQL principal hardening. */
async function ownerRead<T>(c: PoolClient, fn: () => Promise<T>): Promise<T> {
  const context = (await c.query("SELECT current_user role,session_user owner,current_setting('app.tenant_id',true) tenant")).rows[0];
  ensure(context.role === 'dyna_app' || context.role === context.owner, 403, 'Nieprawidłowy kontekst magazynu');
  ensure(context.owner === 'postgres', 403, 'Nieprawidłowy właściciel połączenia magazynu');
  const wasApp = context.role === 'dyna_app';
  let failed = false;
  try { if (wasApp) await c.query('RESET ROLE'); return await fn(); }
  catch (e) { failed = true; throw e; }
  finally {
    // A failed SQL query aborts the transaction; restoration must not mask it.
    if (wasApp) {
      try { await c.query('SET LOCAL ROLE dyna_app'); }
      catch (e) { if (!failed) throw e; }
    }
  }
}
async function availableOwner(c: Pool | PoolClient): Promise<boolean> {
  const p = (await c.query(`SELECT to_regprocedure('public.warehouse_inventory_policy_installed()') marker,
    EXISTS(SELECT 1 FROM pg_proc WHERE pronamespace='public'::regnamespace AND(proname LIKE 'warehouse_inventory_policy_%' OR proname='warehouse_inventory_policy'))
    OR EXISTS(SELECT 1 FROM pg_class WHERE relnamespace='public'::regnamespace AND relname=ANY($1::text[])) partial,
    to_regclass('public.migrations') migration_table`, [tables])).rows[0];
  const ledger = p.migration_table && (await c.query("SELECT EXISTS(SELECT 1 FROM migrations WHERE name='146_warehouse_inventory_policies') installed")).rows[0].installed;
  if (!p.marker) { if (p.partial || ledger) throw incomplete(); return false; }
  try { ensure((await c.query('SELECT public.warehouse_inventory_policy_guards() ok')).rows[0]?.ok, 503, 'Niekompletna polityka magazynów'); return true; }
  catch (e: any) { if (['42P01', '42703', '42883'].includes(e.code)) throw incomplete(); throw e; }
}
export async function warehouseInventoryPoliciesAvailable(c: Pool | PoolClient = pool): Promise<boolean> {
  return 'release' in c ? ownerRead(c as PoolClient, () => availableOwner(c)) : availableOwner(c);
}
export async function lockWarehouseInventoryPoliciesInTx(c: PoolClient, warehouseIds: string[], options: { sellable?: boolean } = {}): Promise<Array<V.WarehouseInventoryPolicy & { warehouse_id: string }>> {
  const ids = z.array(uuid).min(1).max(200).parse(warehouseIds);
  ensure(new Set(ids).size === ids.length, 422, 'Magazyn występuje więcej niż raz');
  return ownerRead(c, async () => {
    const tenant = (await c.query("SELECT nullif(current_setting('app.tenant_id',true),'')::uuid id")).rows[0].id;
    ensure(tenant, 403, 'Brak własnej firmy magazynu');
    const installed = await availableOwner(c);
    await c.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))', ['catalog:' + tenant]);
    const rows: Array<V.WarehouseInventoryPolicy & { warehouse_id: string }> = [];
    for (const id of [...ids].sort()) {
      let policy: V.WarehouseInventoryPolicy;
      if (installed) policy = (await c.query('SELECT public.warehouse_inventory_policy_lock($1,$2) policy', [tenant, id])).rows[0].policy;
      else {
        ensure((await c.query('SELECT id FROM warehouses WHERE tenant_id=$1 AND id=$2 FOR SHARE', [tenant, id])).rowCount, 404, 'Nie znaleziono własnego magazynu');
        policy = { usage: 'sale', enabled: true, version: '0' };
      }
      ensure(!options.sellable || (policy.usage === 'sale' && policy.enabled), 409, 'Magazyn nie jest źródłem sprzedaży');
      rows.push({ warehouse_id: id, ...policy });
    }
    return rows;
  }).catch(mapError);
}
export async function warehouseInventoryPolicyInTx(c: PoolClient, warehouseId: string): Promise<V.WarehouseInventoryPolicy> {
  const [p] = await lockWarehouseInventoryPoliciesInTx(c, [warehouseId]);
  return { usage: p.usage, enabled: p.enabled, version: p.version };
}
/** Preserve physical available; explicit sellable quantity is zero for custody/disabled. */
export function warehouseInventoryAvailability(physicalAvailable: number, policy: V.WarehouseInventoryPolicy) {
  ensure(Number.isSafeInteger(physicalAvailable) && physicalAvailable >= 0, 409, 'Niepoprawna dostępność magazynu');
  return { physical_available: physicalAvailable, sellable_available: policy.usage === 'sale' && policy.enabled ? physicalAvailable : 0 };
}
async function fallbackAccess(c: PoolClient, a: V.WarehouseInventoryPolicyActor, pin: boolean) {
  const role = (await c.query('SELECT role FROM memberships WHERE tenant_id=$1 AND user_id=$2' + (pin ? ' FOR SHARE' : ''), [a.tenantId, a.userId])).rows[0]?.role;
  ensure(['admin', 'operator', 'viewer'].includes(role), 403, 'Brak dostępu do magazynu');
  let scopes: string[] | null = null;
  if (a.apiKeyId) {
    const key = (await c.query('SELECT *, (expires_at IS NULL OR expires_at>clock_timestamp()) alive FROM api_keys WHERE tenant_id=$1 AND id=$2' + (pin ? ' FOR SHARE' : ''), [a.tenantId, a.apiKeyId])).rows[0];
    // A fresh DB clock query follows the potentially blocking row lock.
    ensure(key && key.user_id === a.userId && !key.revoked_at && (await c.query('SELECT $1::timestamptz IS NULL OR $1::timestamptz>clock_timestamp() alive', [key.expires_at])).rows[0].alive, 401, 'Klucz API został cofnięty lub wygasł');
    ensure(key.scopes.includes('inventory:read'), 403, 'Brak dostępu do magazynu'); scopes = key.scopes;
  }
  return { current_role: role, can_manage: role === 'admin' && (!scopes || scopes.includes('inventory:write')) };
}
async function tx<T extends Row>(a: V.WarehouseInventoryPolicyActor, writing: boolean, ctx: Context, body: (c: PoolClient, available: boolean) => Promise<T>): Promise<T & { available: boolean; current_role: string; can_read: boolean; can_manage: boolean; read_only: boolean }> {
  ensure(!writing || !ctx.readOnly, 423, 'Odtworzona kopia jest tylko do odczytu');
  uuid.parse(a.tenantId); uuid.parse(a.userId); if (a.apiKeyId) uuid.parse(a.apiKeyId);
  const c = await pool.connect();
  beginWmsTransaction(c); beginPurchasingTransaction(c); beginCatalogStockControlTransaction(c);
  try {
    await c.query('BEGIN ISOLATION LEVEL READ COMMITTED'); await c.query('RESET ROLE');
    await c.query("SET LOCAL TimeZone='UTC'"); await c.query("SET LOCAL statement_timeout='8s'");
    await c.query("SELECT set_config('app.tenant_id',$1,true)", [a.tenantId]);
    if(writing) {
      await wmsLotsAdmissionInTx(c,a,'shared');
      await purchasingStockAdmissionInTx(c,a);
      await catalogStockControlAdmissionInTx(c,a,'shared');
    }
    const available = await availableOwner(c); ensure(!writing || available, 503, 'Kopia nie zawiera polityki magazynów');
    if (available) await c.query('SELECT public.warehouse_inventory_policy_access($1,$2,$3,false)', [a.userId, a.apiKeyId ?? null, writing]);
    else await fallbackAccess(c, a, false);
    const result = await body(c, available);
    await finalizeWmsActorsInTx(c);
    await finalizeCatalogStockControlActorsInTx(c);
    await c.query('SET CONSTRAINTS ALL IMMEDIATE');
    const g = available ? (await c.query('SELECT public.warehouse_inventory_policy_access($1,$2,$3,true) AS access_flags', [a.userId, a.apiKeyId ?? null, writing])).rows[0].access_flags : await fallbackAccess(c, a, true);
    const reply = { ...result, available, current_role: g.current_role, can_read: true, can_manage: available && g.can_manage && !ctx.readOnly, read_only: !!ctx.readOnly };
    if (writing) await finalizeCatalogStockCountTerminalInTx(c, [{ actor: a,
      roles: ['admin'], scopes: ['inventory:read','inventory:write'],
    }]);
    await c.query('COMMIT'); return reply;
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); return mapError(e); }
  finally { endCatalogStockControlTransaction(c); endPurchasingTransaction(c); endWmsTransaction(c); c.release(); }
}
const pick = (r: Row, keys: string[]) => Object.fromEntries(keys.map(k => [k, r[k]]));
function preview(r: Row): V.WarehouseInventoryPolicyPreview {
  return { ...pick(r, ['id', 'warehouse_id', 'client_key', 'request', 'scope_hash', 'snapshot', 'created_at', 'expires_at']), ready: r.snapshot.blockers.length === 0 } as V.WarehouseInventoryPolicyPreview;
}
function operation(r: Row): V.WarehouseInventoryPolicyOperation {
  return { ...pick(r, ['id', 'warehouse_id', 'preview_id', 'client_key', 'scope_hash', 'revision_id', 'created_at']), before: r.before_policy, after: r.after_policy } as V.WarehouseInventoryPolicyOperation;
}
export async function warehouseInventoryPolicyOptions(a: V.WarehouseInventoryPolicyActor, query: { cursor?: string; limit?: number } = {}, ctx: Context = {}) {
  const q = V.warehouseInventoryPolicyHistoryQuery.parse({ ...query, kind: 'preview' });
  return tx(a, false, ctx, async (c, installed) => {
    const rows = (await c.query('SELECT id,name,code FROM warehouses WHERE tenant_id=$1 AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT $3', [a.tenantId, q.cursor ?? null, q.limit + 1])).rows;
    const data = [];
    for (const w of rows.slice(0, q.limit)) data.push({ ...w, policy: installed ? (await c.query('SELECT public.warehouse_inventory_policy($1,$2) policy', [a.tenantId, w.id])).rows[0].policy : { usage: 'sale', enabled: true, version: '0' } });
    return { warehouses: data, next_cursor: rows.length > q.limit ? data.at(-1)?.id : null };
  });
}
export async function previewWarehouseInventoryPolicy(a: V.WarehouseInventoryPolicyActor, warehouseId: string, input: unknown, ctx: Context = {}) {
  const b = V.warehouseInventoryPolicyPreviewInput.parse(input), wh = uuid.parse(warehouseId);
  return tx(a, true, ctx, async c => { const r = (await c.query('SELECT public.warehouse_inventory_policy_preview($1,$2,$3,$4::jsonb) result', [a.userId, a.apiKeyId ?? null, wh, JSON.stringify(b)])).rows[0].result; return { preview: preview(r.preview), reused: r.reused }; });
}
export async function commitWarehouseInventoryPolicy(a: V.WarehouseInventoryPolicyActor, previewId: string, input: unknown, ctx: Context = {}) {
  const b = V.warehouseInventoryPolicyCommitInput.parse(input), id = uuid.parse(previewId);
  return tx(a, true, ctx, async c => { const r = (await c.query('SELECT public.warehouse_inventory_policy_commit($1,$2,$3,$4::jsonb) result', [a.userId, a.apiKeyId ?? null, id, JSON.stringify(b)])).rows[0].result; return { operation: operation(r.operation), reused: r.reused }; });
}
export async function warehouseInventoryPolicyDetail(a: V.WarehouseInventoryPolicyActor, kind: 'preview' | 'operation', id: string, ctx: Context = {}) {
  uuid.parse(id);
  return tx(a, false, ctx, async (c, installed) => {
    ensure(installed, 503, 'Kopia nie zawiera polityki magazynów');
    const table = kind === 'preview' ? 'warehouse_inventory_policy_previews' : 'warehouse_inventory_policy_operations';
    const r = (await c.query(`SELECT * FROM ${table} WHERE tenant_id=$1 AND id=$2`, [a.tenantId, id])).rows[0];
    ensure(r, 404, 'Nie znaleziono własnego dowodu polityki'); return kind === 'preview' ? { preview: preview(r) } : { operation: operation(r) };
  });
}
export async function warehouseInventoryPolicyHistory(a: V.WarehouseInventoryPolicyActor, input: unknown, ctx: Context = {}) {
  const q = V.warehouseInventoryPolicyHistoryQuery.parse(input);
  return tx(a, false, ctx, async (c, installed) => {
    ensure(installed, 503, 'Kopia nie zawiera polityki magazynów');
    const table = q.kind === 'preview' ? 'warehouse_inventory_policy_previews' : 'warehouse_inventory_policy_operations';
    const rows = (await c.query(`SELECT id,warehouse_id,client_key,created_at FROM ${table} WHERE tenant_id=$1 AND ($2::uuid IS NULL OR id<$2) ORDER BY id DESC LIMIT $3`, [a.tenantId, q.cursor ?? null, q.limit + 1])).rows;
    const data = rows.slice(0, q.limit); return { kind: q.kind, data, next_cursor: rows.length > q.limit ? data.at(-1)?.id : null };
  });
}
