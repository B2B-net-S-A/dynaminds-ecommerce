import { beginCatalogStockControlTransaction, endCatalogStockControlTransaction,
  catalogStockControlAdmissionInTx, finalizeCatalogStockControlActorsInTx, finalizeCatalogStockCountTerminalInTx } from './catalog-stock-control-transaction';
import { beginWmsTransaction, endWmsTransaction, wmsLotsAdmissionInTx, finalizeWmsActorsInTx } from './wms-lots-transaction';
import { beginPurchasingTransaction, endPurchasingTransaction, purchasingStockAdmissionInTx } from './purchasing-transaction';
import type { Pool, PoolClient } from 'pg';
import { isDeepStrictEqual } from 'node:util';
import { pool } from './db';
import { ensure, Problem } from './errors';
import { issuedWzAvailable } from './warehouse-wz-issued';
import * as V from './warehouse-automatic-wz-schema';

type Row = Record<string, any>;
type Context = { readOnly?: boolean };
type Grant = { current_role: string; can_manage: boolean };
const family = ['warehouse_automatic_wz_configurations','warehouse_automatic_wz_revisions','warehouse_automatic_wz_previews','warehouse_automatic_wz_operations','warehouse_automatic_wz_admissions','warehouse_automatic_wz_manifest'];
const incomplete = () => new Problem(503, 'Niekompletny moduł automatycznych WZ');
function mapError(e: unknown): never {
  if (e instanceof Problem) throw e;
  const err = e as { code?: string; message?: string };
  if (['55000','42P01','42703','42883'].includes(err.code ?? '')) throw incomplete();
  if (err.code === '28000') throw new Problem(401, 'Klucz API został cofnięty lub wygasł');
  if (err.code === '42501') throw new Problem(403, 'Brak aktualnego uprawnienia automatycznych WZ');
  if (err.code === 'P0002') throw new Problem(404, 'Nie znaleziono własnego magazynu lub dowodu WZ');
  if (['23514','23505','23503','40001','40P01'].includes(err.code ?? '')) throw new Problem(409, err.code === '23514' ? err.message ?? 'Konflikt konfiguracji WZ' : 'Zakres konfiguracji WZ zmienił się');
  if (err.code === '54000') throw new Problem(413, 'Limit konfiguracji lub historii WZ');
  throw e;
}
export async function warehouseAutomaticWzAvailable(c: Pool | PoolClient = pool): Promise<boolean> {
  try {
    const p = (await c.query(`SELECT to_regprocedure('public.warehouse_automatic_wz_installed()') marker,
      EXISTS(SELECT 1 FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'warehouse_automatic_wz_%')
      OR EXISTS(SELECT 1 FROM pg_class WHERE relnamespace='public'::regnamespace AND relname=ANY($1::text[])) partial,
      to_regclass('public.migrations') ledger`, [family])).rows[0];
    const ledger = p.ledger && (await c.query("SELECT EXISTS(SELECT 1 FROM public.migrations WHERE name='150_warehouse_automatic_wz') installed")).rows[0].installed;
    if (!p.marker) { if (p.partial || ledger) throw incomplete(); return false; }
    ensure((await c.query('SELECT public.warehouse_automatic_wz_guards() ok')).rows[0].ok, 503, 'Niekompletny moduł automatycznych WZ');
    return true;
  } catch (e) { return mapError(e); }
}
async function access(c: PoolClient, a: V.AutomaticWzActor, installed: boolean, writing: boolean, pin: boolean): Promise<Grant> {
  if (installed) return (await c.query('SELECT public.warehouse_automatic_wz_access($1,$2,$3,$4) AS access_flags', [a.userId,a.apiKeyId ?? null,writing,pin])).rows[0].access_flags;
  const role = (await c.query('SELECT role FROM public.memberships WHERE tenant_id=$1 AND user_id=$2'+(pin ? ' FOR SHARE' : ''), [a.tenantId,a.userId])).rows[0]?.role;
  ensure(['admin','operator','viewer'].includes(role), 403, 'Brak aktualnego dostępu do magazynu');
  if (a.apiKeyId) {
    const k = (await c.query('SELECT * FROM public.api_keys WHERE tenant_id=$1 AND id=$2'+(pin ? ' FOR SHARE' : ''), [a.tenantId,a.apiKeyId])).rows[0];
    ensure(k && k.user_id === a.userId && !k.revoked_at && (await c.query('SELECT $1::timestamptz IS NULL OR $1::timestamptz>clock_timestamp() alive', [k.expires_at])).rows[0].alive, 401, 'Klucz API został cofnięty lub wygasł');
    ensure(k.scopes.includes('inventory:read'), 403, 'Brak zakresu odczytu magazynu');
  }
  return { current_role: role, can_manage: false };
}
function publicFlags(installed: boolean, issuer: boolean, g: Grant, ctx: Context): V.AutomaticWzFlags {
  return { available: installed, configuration_available: installed, issuer_available: issuer, current_role: g.current_role, can_read: true, can_manage: installed && g.can_manage && !ctx.readOnly, read_only: !!ctx.readOnly };
}
/** Trusted HTTP actor boundary. Private owner functions do not establish a
 * cryptographic SQL caller principal; the SaaS hardening scope remains open.
 * No query or hydration follows the final current membership/key PIN. */
async function tx<T extends Row>(a: V.AutomaticWzActor, writing: boolean, ctx: Context, body: (c: PoolClient, installed: boolean) => Promise<T>, project: (v: T, f: V.AutomaticWzFlags) => T = v => v): Promise<T & V.AutomaticWzFlags> {
  ensure(!writing || !ctx.readOnly, 423, 'Odtworzona kopia jest tylko do odczytu');
  V.automaticWzUuid.parse(a.tenantId); V.automaticWzUuid.parse(a.userId); if (a.apiKeyId) V.automaticWzUuid.parse(a.apiKeyId);
  const c = await pool.connect();
  beginWmsTransaction(c); beginPurchasingTransaction(c); beginCatalogStockControlTransaction(c);
  try {
    ensure((await c.query('SELECT session_user AS owner')).rows[0].owner === 'postgres', 403, 'Nieprawidłowy właściciel połączenia WZ');
    await c.query(writing ? 'BEGIN ISOLATION LEVEL READ COMMITTED' : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await c.query('RESET ROLE'); await c.query("SET LOCAL TimeZone='UTC'"); await c.query("SET LOCAL statement_timeout='10s'");
    await c.query("SELECT set_config('app.tenant_id',$1,true)", [a.tenantId]);
    if(writing) {
      await wmsLotsAdmissionInTx(c,a,'shared');
      await purchasingStockAdmissionInTx(c,a);
      await catalogStockControlAdmissionInTx(c,a,'shared');
    }
    const installed = await warehouseAutomaticWzAvailable(c); ensure(!writing || installed, 503, 'Kopia nie zawiera automatycznych WZ');
    await access(c,a,installed,writing,false);
    const value = await body(c,installed);
    if (writing) {
      await finalizeWmsActorsInTx(c);
      await finalizeCatalogStockControlActorsInTx(c);
      await c.query('SET CONSTRAINTS ALL IMMEDIATE');
    }
    else {
      await c.query('COMMIT'); await c.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      await c.query('RESET ROLE'); await c.query("SET LOCAL TimeZone='UTC'"); await c.query("SET LOCAL statement_timeout='10s'");
      await c.query("SELECT set_config('app.tenant_id',$1,true)",[a.tenantId]);
    }
    ensure(await warehouseAutomaticWzAvailable(c) === installed, 503, 'Zakres modułu automatycznych WZ zmienił się');
    const issuer = await issuedWzAvailable(c);
    const flags = publicFlags(installed,issuer,await access(c,a,installed,writing,true),ctx);
    const reply = { ...project(value,flags), ...flags };
    if (writing) await finalizeCatalogStockCountTerminalInTx(c, [{ actor: a,
      roles: ['admin'], scopes: ['inventory:read','inventory:write'],
    }]);
    await c.query('COMMIT'); return reply;
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); return mapError(e); }
  finally { endCatalogStockControlTransaction(c); endPurchasingTransaction(c); endWmsTransaction(c); c.release(); }
}
function preview(r: Row, operationId: string|null): V.AutomaticWzPreview {
  return { id:r.id,warehouse_id:r.warehouse_id,client_key:r.client_key,request:r.request,scope_hash:r.scope_hash,snapshot:r.snapshot,created_at:r.created_at,expires_at:r.expires_at,ready:true,operation_id:operationId,can_commit:false };
}
function operation(r: Row): V.AutomaticWzOperation {
  return { id:r.id,warehouse_id:r.warehouse_id,preview_id:r.preview_id,client_key:r.client_key,request:r.request,scope_hash:r.scope_hash,snapshot:r.snapshot,before:r.snapshot.before,after:r.snapshot.after,revision_id:r.revision_id,created_at:r.created_at };
}
async function previewView(c: PoolClient, a: V.AutomaticWzActor, r: Row) {
  const o = (await c.query('SELECT id FROM public.warehouse_automatic_wz_operations WHERE tenant_id=$1 AND preview_id=$2',[a.tenantId,r.id])).rows[0];
  const p=preview(r,o?.id ?? null);
  const current=(await c.query('SELECT public.warehouse_automatic_wz_current($1,$2) AS configuration',[a.tenantId,r.warehouse_id])).rows[0].configuration;
  p.can_commit=r.actor_id===a.userId && r.api_key_id===(a.apiKeyId ?? null) && isDeepStrictEqual(current,p.snapshot.before);
  return p;
}
function eligible(p: V.AutomaticWzPreview, f: V.AutomaticWzFlags) { return { ...p, can_commit:p.can_commit && f.can_manage && p.operation_id === null && Date.parse(p.expires_at)>Date.now() }; }
export async function warehouseAutomaticWzOptions(a: V.AutomaticWzActor, input: unknown = {}, ctx: Context = {}) {
  const q = V.automaticWzPageQuery.parse(input);
  return tx(a,false,ctx,async(c,installed) => {
    if (q.cursor) ensure((await c.query('SELECT id FROM public.warehouses WHERE tenant_id=$1 AND id=$2',[a.tenantId,q.cursor])).rowCount,404,'Nie znaleziono własnego kursora magazynu');
    const data = (await c.query('SELECT id,name,code FROM public.warehouses WHERE tenant_id=$1 AND($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT $3',[a.tenantId,q.cursor ?? null,q.limit+1])).rows;
    const warehouses = [];
    for (const w of data.slice(0,q.limit)) warehouses.push({ ...w, configuration:installed ? (await c.query('SELECT public.warehouse_automatic_wz_current($1,$2) AS configuration',[a.tenantId,w.id])).rows[0].configuration as V.AutomaticWzConfiguration : {warehouse_id:w.id,version:'0',series_id:null,settings:null} });
    return { warehouses,next_cursor:data.length>q.limit ? warehouses.at(-1)?.id ?? null : null,limits:V.AUTOMATIC_WZ_LIMITS };
  });
}
export async function previewWarehouseAutomaticWz(a: V.AutomaticWzActor, warehouseId: string, input: unknown, ctx: Context = {}) {
  ensure(!ctx.readOnly,423,'Odtworzona kopia jest tylko do odczytu');
  const wh = V.automaticWzUuid.parse(warehouseId), b = V.automaticWzPreviewInput.parse(input);
  return tx(a,true,ctx,async c => {
    const r = (await c.query('SELECT public.warehouse_automatic_wz_preview($1,$2,$3,$4::jsonb) AS result',[a.userId,a.apiKeyId ?? null,wh,JSON.stringify(b)])).rows[0].result;
    return { preview:await previewView(c,a,r.preview),reused:r.reused as boolean };
  },(v,f) => ({ ...v,preview:eligible(v.preview,f) }));
}
export async function commitWarehouseAutomaticWz(a: V.AutomaticWzActor, previewId: string, input: unknown, ctx: Context = {}) {
  ensure(!ctx.readOnly,423,'Odtworzona kopia jest tylko do odczytu');
  const id = V.automaticWzUuid.parse(previewId), b = V.automaticWzCommitInput.parse(input);
  return tx(a,true,ctx,async c => {
    const r = (await c.query('SELECT public.warehouse_automatic_wz_commit($1,$2,$3,$4::jsonb) AS result',[a.userId,a.apiKeyId ?? null,id,JSON.stringify(b)])).rows[0].result;
    return { operation:operation(r.operation),reused:r.reused as boolean };
  });
}
export async function warehouseAutomaticWzDetail(a: V.AutomaticWzActor, kind: 'preview'|'operation', id: string, ctx: Context = {}) {
  id = V.automaticWzUuid.parse(id);
  return tx(a,false,ctx,async(c,installed) => {
    ensure(installed,503,'Kopia nie zawiera automatycznych WZ');
    const table = kind === 'preview' ? 'warehouse_automatic_wz_previews' : 'warehouse_automatic_wz_operations';
    const r = (await c.query(`SELECT to_jsonb(r) AS row FROM public.${table} r WHERE tenant_id=$1 AND id=$2`,[a.tenantId,id])).rows[0]?.row;
    ensure(r,404,'Nie znaleziono własnego dowodu WZ');
    return kind === 'preview' ? { preview:await previewView(c,a,r) } : { operation:operation(r) };
  },(v,f) => v.preview ? { ...v,preview:eligible(v.preview,f) } : v);
}
export async function warehouseAutomaticWzHistory(a: V.AutomaticWzActor, input: unknown, ctx: Context = {}) {
  const q = V.automaticWzHistoryQuery.parse(input);
  return tx(a,false,ctx,async(c,installed) => {
    ensure(installed,503,'Kopia nie zawiera automatycznych WZ');
    if (q.warehouse_id) ensure((await c.query('SELECT id FROM public.warehouses WHERE tenant_id=$1 AND id=$2',[a.tenantId,q.warehouse_id])).rowCount,404,'Nie znaleziono własnego magazynu');
    const table = q.kind === 'preview' ? 'warehouse_automatic_wz_previews' : 'warehouse_automatic_wz_operations';
    if (q.cursor) ensure((await c.query(`SELECT id FROM public.${table} WHERE tenant_id=$1 AND id=$2 AND($3::uuid IS NULL OR warehouse_id=$3)`,[a.tenantId,q.cursor,q.warehouse_id ?? null])).rowCount,404,'Nie znaleziono własnego kursora historii');
    const rows: Row[] = (await c.query(`SELECT to_jsonb(r) AS row FROM public.${table} r WHERE tenant_id=$1 AND($2::uuid IS NULL OR id<$2) AND($3::uuid IS NULL OR warehouse_id=$3) ORDER BY id DESC LIMIT $4`,[a.tenantId,q.cursor ?? null,q.warehouse_id ?? null,q.limit+1])).rows.map(r=>r.row);
    const data: Array<V.AutomaticWzPreview|V.AutomaticWzOperation> = [];
    for (const r of rows.slice(0,q.limit)) data.push(q.kind === 'preview' ? await previewView(c,a,r) : operation(r));
    return { kind:q.kind,data,next_cursor:rows.length>q.limit ? data.at(-1)?.id ?? null : null };
  },(v,f) => ({ ...v,data:v.data.map(r => 'can_commit' in r ? eligible(r,f) : r) }));
}
