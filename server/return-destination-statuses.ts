import { beginCatalogStockControlTransaction, endCatalogStockControlTransaction,
  catalogStockControlAdmissionInTx, finalizeCatalogStockControlActorsInTx, finalizeCatalogStockCountTerminalInTx } from './catalog-stock-control-transaction';
import { beginWmsTransaction, endWmsTransaction, wmsLotsAdmissionInTx, finalizeWmsActorsInTx } from './wms-lots-transaction';
import { beginPurchasingTransaction, endPurchasingTransaction, purchasingStockAdmissionInTx } from './purchasing-transaction';
import type { Pool, PoolClient } from 'pg';
import { pool } from './db';
import { audit } from './domain';
import { ensure, Problem } from './errors';
import * as V from './return-destination-statuses-schema';

export type ReturnDestinationStatusActor = V.ReturnDestinationStatusActor;
export type ReturnDestinationStatusContext = { readOnly?: boolean; intakeAvailable?: boolean };
export type ReturnDestinationWarehouse = {
  id: string; name: string; code: string;
  policy: { usage: 'sale' | 'custody'; enabled: boolean; version: string };
};
export type ReturnDestinationStatus = {
  id: string; version: string; revision_id: string;
  settings: V.ReturnDestinationStatusSettings; created_at: string; updated_at: string;
};
type Row = Record<string, any>;
type Grant = { current_role: 'admin' | 'operator' | 'viewer'; can_read: boolean; can_manage: boolean };
export type ReturnDestinationStatusResult = Row & { reused?: boolean };
const tables = ['return_destination_statuses', 'return_destination_status_revisions',
  'return_destination_status_previews', 'return_destination_status_operations', 'return_destination_status_admissions'];
const incomplete = () => new Problem(503, 'Niekompletna konfiguracja statusów zwrotu');

export async function returnDestinationStatusesAvailable(c: Pool | PoolClient = pool): Promise<boolean> {
  const probe = (await c.query(`SELECT to_regprocedure('public.return_destination_status_installed()') marker,
    EXISTS(SELECT 1 FROM pg_class WHERE relnamespace='public'::regnamespace AND relname=ANY($1::text[]))
    OR EXISTS(SELECT 1 FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'return_destination_status_%')
    OR EXISTS(SELECT 1 FROM pg_trigger WHERE NOT tgisinternal AND tgname LIKE 'return_destination_status_%') partial,
    to_regclass('public.migrations') migration_table`, [tables])).rows[0];
  const ledger = probe.migration_table && (await c.query("SELECT EXISTS(SELECT 1 FROM public.migrations WHERE name='147_return_destination_statuses') installed")).rows[0].installed;
  if (!probe.marker) { if (probe.partial || ledger) throw incomplete(); return false; }
  try {
    ensure((await c.query('SELECT public.return_destination_status_guards() ok')).rows[0]?.ok, 503, 'Niekompletna konfiguracja statusów zwrotu');
    return true;
  } catch (error: any) {
    if (['42P01', '42703', '42883'].includes(error.code)) throw incomplete();
    throw error;
  }
}
function mapped(error: any): never {
  if (error instanceof Problem) throw error;
  if (error.code === '55000') throw incomplete();
  if (error.code === '28000') throw new Problem(401, 'Klucz API został cofnięty lub wygasł');
  if (error.code === '42501') throw new Problem(403, 'Brak aktualnego uprawnienia statusów zwrotu');
  if (error.code === 'P0002') throw new Problem(404, 'Nie znaleziono własnej konfiguracji statusu');
  if (error.code === '54000') throw new Problem(413, 'Limit konfiguracji statusów zwrotu');
  if (['23514', '23505', '23503'].includes(error.code)) throw new Problem(409, error.message);
  throw error;
}
const flags = (g: Grant, ctx: ReturnDestinationStatusContext) => ({
  available: true, read_only: !!ctx.readOnly, current_role: g.current_role,
  can_read: g.can_read, can_manage: g.can_manage && !ctx.readOnly, intake_available: ctx.intakeAvailable === true,
});
function controls(value: Row, g: Grant, ctx: ReturnDestinationStatusContext): ReturnDestinationStatusResult {
  if (value.preview) value = { ...value, preview: { ...value.preview,
    can_commit: g.can_manage && !ctx.readOnly && !value.preview.operation_id
      && Date.parse(value.preview.expires_at) > Date.now(),
  } };
  return { ...value, ...flags(g, ctx) };
}
/** Owner infrastructure remains a trusted boundary; UID is not a SQL-session identity. */
async function transaction(a: ReturnDestinationStatusActor, writing: boolean,
  ctx: ReturnDestinationStatusContext, work: (c: PoolClient) => Promise<Row>): Promise<ReturnDestinationStatusResult> {
  ensure(!writing || !ctx.readOnly, 423, 'Odtworzona kopia jest tylko do odczytu');
  V.returnDestinationStatusUuid.parse(a.tenantId); V.returnDestinationStatusUuid.parse(a.userId);
  if (a.apiKeyId) V.returnDestinationStatusUuid.parse(a.apiKeyId);
  const c = await pool.connect();
  beginWmsTransaction(c); beginPurchasingTransaction(c); beginCatalogStockControlTransaction(c);
  try {
    await c.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    await c.query('RESET ROLE');
    await c.query("SET LOCAL statement_timeout='8s'");
    await c.query("SET LOCAL TimeZone='UTC'");
    await c.query("SELECT set_config('app.tenant_id',$1,true)", [a.tenantId]);
    if(writing) {
      await wmsLotsAdmissionInTx(c,a,'shared');
      await purchasingStockAdmissionInTx(c,a);
      await catalogStockControlAdmissionInTx(c,a,'shared');
    }
    ensure(await returnDestinationStatusesAvailable(c), 503, 'Kopia nie zawiera konfiguracji statusów zwrotu');
    await c.query('SELECT return_destination_status_require($1,$2,$3,false)', [a.userId, a.apiKeyId ?? null, writing]);
    const value = await work(c);
    await finalizeWmsActorsInTx(c);
    await finalizeCatalogStockControlActorsInTx(c);
    await c.query('SET CONSTRAINTS ALL IMMEDIATE');
    // Work includes every output hydration/audit/FK wait. This final current
    // member/key check holds locks through the COUNT terminal gate and COMMIT.
    const grant: Grant = (await c.query('SELECT return_destination_status_require($1,$2,$3,true) AS access_flags',
      [a.userId, a.apiKeyId ?? null, writing])).rows[0].access_flags;
    const result = controls(value, grant, ctx);
    if (writing) await finalizeCatalogStockCountTerminalInTx(c, [{ actor: a,
      roles: ['admin'], scopes: ['orders:read','inventory:read','returns:configure'],
    }]);
    await c.query('COMMIT');
    return result;
  } catch (error) { await c.query('ROLLBACK').catch(() => undefined); return mapped(error); }
  finally { endCatalogStockControlTransaction(c); endPurchasingTransaction(c); endWmsTransaction(c); c.release(); }
}
const fields = (value: Row, names: string[]) => Object.fromEntries(names.map(name => [name, value[name]]));
const previewSnapshot = (value: Row) => ({
  ...fields(value, ['id', 'kind', 'status_id', 'request', 'scope_hash', 'created_at', 'expires_at']),
  before: value.payload.before, after: value.payload.after, resources: value.payload.resources, ready: true,
});
async function previewView(c: PoolClient, id: string): Promise<Row> {
  const value = (await c.query(`SELECT p.*,to_jsonb(p)->>'created_at' created_at,to_jsonb(p)->>'expires_at' expires_at,o.id operation_id FROM return_destination_status_previews p
    LEFT JOIN return_destination_status_operations o ON(o.tenant_id,o.preview_id)=(p.tenant_id,p.id)
    WHERE p.tenant_id=current_setting('app.tenant_id')::uuid AND p.id=$1`, [id])).rows[0];
  ensure(value, 404, 'Nie znaleziono własnego podglądu statusu');
  return { ...previewSnapshot(value), operation_id: value.operation_id ?? null, can_commit: false };
}
function operationView(value: Row): Row {
  return { ...fields(value, ['id', 'preview_id', 'status_id', 'kind', 'request', 'created_at']),
    scope_hash: value.payload.snapshot.scope_hash, before: value.payload.before,
    after: value.payload.after, snapshot: value.payload.snapshot };
}
async function operation(c: PoolClient, id: string): Promise<Row> {
  const value = (await c.query('SELECT o.*,to_jsonb(o)->>\'created_at\' created_at FROM return_destination_status_operations o WHERE tenant_id=current_setting(\'app.tenant_id\')::uuid AND id=$1', [id])).rows[0];
  ensure(value, 404, 'Nie znaleziono własnego zapisu statusu');
  return operationView(value);
}
async function status(c: PoolClient, id: string): Promise<ReturnDestinationStatus> {
  const value = (await c.query('SELECT return_destination_status_head($1) status', [id])).rows[0].status;
  ensure(value, 404, 'Nie znaleziono własnego statusu'); return value;
}
export async function returnDestinationStatusOptions(a: ReturnDestinationStatusActor, ctx: ReturnDestinationStatusContext = {}) {
  if (!await returnDestinationStatusesAvailable()) return {
    available: false, read_only: !!ctx.readOnly, can_read: false, can_manage: false,
    current_role: null, intake_available: false, warehouses: [], limits: V.RETURN_DESTINATION_STATUS_LIMITS,
  };
  return transaction(a, false, ctx, async c => {
    const rows = (await c.query('SELECT id,name,code FROM warehouses WHERE tenant_id=$1 ORDER BY id LIMIT 501', [a.tenantId])).rows;
    ensure(rows.length <= 500, 413, 'Za dużo magazynów konfiguracji statusu');
    const warehouses: ReturnDestinationWarehouse[] = [];
    for (const row of rows) {
      const policy = (await c.query('SELECT warehouse_inventory_policy($1,$2) policy', [a.tenantId, row.id])).rows[0].policy;
      warehouses.push({ ...row, policy } as ReturnDestinationWarehouse);
    }
    return { warehouses, limits: V.RETURN_DESTINATION_STATUS_LIMITS };
  });
}
export function returnDestinationStatusList(a: ReturnDestinationStatusActor, input: unknown = {}, ctx: ReturnDestinationStatusContext = {}) {
  const query = V.returnDestinationStatusListQuery.parse(input);
  return transaction(a, false, ctx, async c => {
    const rows = (await c.query(`SELECT return_destination_status_head(id) status FROM return_destination_statuses
      WHERE tenant_id=$1 AND($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT $3`, [a.tenantId, query.cursor ?? null, query.limit + 1])).rows;
    return { data: rows.slice(0, query.limit).map(row => row.status),
      next_cursor: rows.length > query.limit ? rows[query.limit - 1].status.id : null };
  });
}
export const returnDestinationStatusDetail = (a: ReturnDestinationStatusActor, id: string, ctx: ReturnDestinationStatusContext = {}) =>
  transaction(a, false, ctx, async c => ({ status: await status(c, V.returnDestinationStatusUuid.parse(id)) }));
export const returnDestinationStatusPreview = (a: ReturnDestinationStatusActor, id: string, ctx: ReturnDestinationStatusContext = {}) =>
  transaction(a, false, ctx, async c => ({ preview: await previewView(c, V.returnDestinationStatusUuid.parse(id)) }));
export const returnDestinationStatusOperation = (a: ReturnDestinationStatusActor, id: string, ctx: ReturnDestinationStatusContext = {}) =>
  transaction(a, false, ctx, async c => ({ operation: await operation(c, V.returnDestinationStatusUuid.parse(id)) }));
export function returnDestinationStatusHistory(a: ReturnDestinationStatusActor, id: string, input: unknown = {}, ctx: ReturnDestinationStatusContext = {}) {
  const query = V.returnDestinationStatusHistoryQuery.parse(input);
  return transaction(a, false, ctx, async c => {
    const statusId = V.returnDestinationStatusUuid.parse(id); await status(c, statusId);
    const rows = (await c.query(`SELECT id,preview_id,status_id,kind,payload->'after'->>'version' version,to_jsonb(o)->>'created_at' created_at
      FROM return_destination_status_operations o WHERE tenant_id=$1 AND status_id=$2 AND($3::uuid IS NULL OR id>$3)
      ORDER BY id LIMIT $4`, [a.tenantId, statusId, query.cursor ?? null, query.limit + 1])).rows;
    return { data: rows.slice(0, query.limit), next_cursor: rows.length > query.limit ? rows[query.limit - 1].id : null };
  });
}
export function previewReturnDestinationStatus(a: ReturnDestinationStatusActor, input: unknown, ctx: ReturnDestinationStatusContext = {}) {
  ensure(!ctx.readOnly, 423, 'Odtworzona kopia jest tylko do odczytu');
  const body = V.returnDestinationStatusPreviewInput.parse(input);
  return transaction(a, true, ctx, async c => {
    const saved = (await c.query('SELECT return_destination_status_preview($1,$2,$3::jsonb) result', [a.userId, a.apiKeyId ?? null, JSON.stringify(body)])).rows[0].result;
    if (!saved.reused) await audit(c, a, 'return_destination_status.previewed', saved.preview.id, { kind: body.kind });
    return { preview: await previewView(c, saved.preview.id), reused: saved.reused };
  });
}
export function commitReturnDestinationStatus(a: ReturnDestinationStatusActor, id: string, input: unknown, ctx: ReturnDestinationStatusContext = {}) {
  ensure(!ctx.readOnly, 423, 'Odtworzona kopia jest tylko do odczytu');
  const body = V.returnDestinationStatusCommitInput.parse(input), previewId = V.returnDestinationStatusUuid.parse(id);
  return transaction(a, true, ctx, async c => {
    const saved = (await c.query('SELECT return_destination_status_commit($1,$2,$3,$4::jsonb) result', [a.userId, a.apiKeyId ?? null, previewId, JSON.stringify(body)])).rows[0].result;
    if (!saved.reused) await audit(c, a, 'return_destination_status.committed', saved.operation.status_id,
      { operation_id: saved.operation.id, preview_id: previewId });
    const receipt = await operation(c, saved.operation.id);
    // The returned status is the immutable committed revision, including replay.
    return { operation: receipt, status: receipt.after, reused: saved.reused };
  });
}
