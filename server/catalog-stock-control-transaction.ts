import {inspectActiveManagedInstallation} from './db';
import { drainPublicConstraintsInTx } from './public-constraint-drain';
import {assertNoFinancialReturn162AdmissionInTx} from './financial-return-completion';
import { assertNoAllegroAuthorityInTx } from './allegro-oauth-authority';
import type { Pool,PoolClient } from 'pg';
import { ensure, Problem } from './errors';
import type { CatalogStockControlActor } from './catalog-stock-control-schema';
import type { CatalogStockCountSource } from './catalog-stock-count-effects';
import { freezeWmsActorsForCountInTx } from './wms-lots-transaction';
import { freezeDispatchActorsForCountInTx } from './dispatch-transaction';

export type CatalogStockControlAdmission={tenantId:string;mode:'shared'|'activation';installed:boolean};
type Enlisted=CatalogStockControlActor & {adminOnly:boolean;scopes:Set<string>};
type CountTerminal={actor:Readonly<CatalogStockControlActor>;source:string};
type State={admissions:Map<string,CatalogStockControlAdmission>;actors:Map<string,Enlisted>;
  countTerminals:Map<string,CountTerminal>;terminalFrozen:boolean};
const contexts=new WeakMap<PoolClient,State>();
/** Presence only; never authorization, admission or transaction readiness. */
export function hasCatalogStockControlTransactionDuty(c:PoolClient){return Boolean(contexts.get(c)?.actors.size || contexts.get(c)?.countTerminals.size);}
export function beginCatalogStockControlTransaction(c:PoolClient){contexts.set(c,{admissions:new Map(),actors:new Map(),countTerminals:new Map(),terminalFrozen:false});}
export function endCatalogStockControlTransaction(c:PoolClient){contexts.delete(c);}
export type CatalogStockControlAvailability = 'absent' | 'available' | 'unavailable';
// 264: a READ ONLY REPEATABLE READ/SERIALIZABLE transaction keeps one snapshot, cannot write or create TEMP objects and
// (with the ordinary schema gate) holds the shared 982376 fence against owner DDL, so a later full guard's catalogue
// scans read what the first one read. Its syscache lookups (privileges, roles) see role and grant changes, which no fence
// stops; reuse leaves them stale for at most this read transaction, as any guard already is. Only 'available' is reused, keyed by a random transaction-local marker (reverted by COMMIT,
// ROLLBACK and ROLLBACK TO) and the session state the guard depends on; READ COMMITTED (248 verdict), read-write
// transactions, sessions with own TEMP objects and the Pool never reuse.
const SNAPSHOT264=`SELECT current_setting('transaction_isolation') IN('repeatable read','serializable')
  AND current_setting('transaction_read_only')='on' AND (pg_my_temp_schema()=0 OR NOT EXISTS(SELECT FROM pg_class
   WHERE relnamespace=pg_my_temp_schema()) AND NOT EXISTS(SELECT FROM pg_type WHERE typnamespace=pg_my_temp_schema())) snapshot,
  current_setting('app.catalog_stock_control_tx',true) marker,concat_ws('|',session_user,current_user,(SELECT
   string_agg(n||'='||coalesce(current_setting(n,true),'-'),'|' ORDER BY n) FROM unnest(ARRAY['session_replication_role',
   'TimeZone','DateStyle','IntervalStyle','extra_float_digits','bytea_output','lc_monetary','lc_numeric','lc_time',
   'quote_all_identifiers','standard_conforming_strings','transform_null_equals','array_nulls','backslash_quote','row_security',
   'default_text_search_config','xmlbinary','xmloption','jit','plpgsql.variable_conflict','plpgsql.extra_errors',
   'plpgsql.check_asserts','event_triggers','search_path','role']) n)) session`;
const availableInTx=new WeakMap<PoolClient,Readonly<{marker:string;session:string}>>();
/** Diagnostic only: unavailable must never be treated as absent by a writer. */
export async function catalogStockControlAvailabilityInTx(c:Pool|PoolClient):Promise<CatalogStockControlAvailability>{
  if(!('release' in c))return availabilityByGuard(c);
  const s=(await c.query(SNAPSHOT264)).rows[0],session:string|undefined=s.snapshot===true?s.session:undefined,seen=availableInTx.get(c);
  if(session&&seen&&s.marker&&seen.marker===s.marker&&seen.session===session)return 'available';
  const availability=await availabilityByGuard(c);
  if(session&&availability==='available'){
    const marker=crypto.randomUUID();
    await c.query("SELECT set_config('app.catalog_stock_control_tx',$1,true)",[marker]);
    availableInTx.set(c,Object.freeze({marker,session}));
  }
  return availability;
}
async function availabilityByGuard(c:Pool|PoolClient):Promise<CatalogStockControlAvailability>{
  const prior=(await c.query('SELECT current_user role,session_user owner')).rows[0];
  ensure(prior.owner==='postgres'&&['postgres','dyna_app'].includes(prior.role),403,'Nieprawidłowy kontekst metadanych katalogu');
  ensure(prior.role!=='dyna_app'||'release' in c,403,'Metadane wymagają tego samego klienta transakcji');
  if(prior.role==='dyna_app')await c.query('RESET ROLE');let failed=false;
  try{const p=(await c.query(`SELECT to_regprocedure('public.catalog_stock_control_installed()') marker,
    EXISTS(SELECT FROM pg_proc WHERE pronamespace='public'::regnamespace AND
      (proname LIKE 'catalog_stock_control_%' OR proname LIKE 'catalog_stock_count_%' OR proname LIKE 'catalog_stock_return_%'))
    OR EXISTS(SELECT FROM pg_class WHERE relnamespace='public'::regnamespace AND
      (relname LIKE 'catalog_stock_control_%' OR relname LIKE 'catalog_stock_count_%' OR relname LIKE 'catalog_stock_return_%')) partial,
    EXISTS(SELECT FROM public.migrations WHERE name='152_catalog_stock_control') ledger,
    to_regprocedure('public.guard_verdict(text)') verdict`)).rows[0];
  if(!p.marker)return p.partial||p.ledger?'unavailable':'absent';
  // 248: inside a transaction the same verdict, reused while the cold-approved schema and the guard's basis are
  // unchanged; the Pool (startup, outside any transaction) keeps the full guard.
  const guard=p.verdict&&'release' in c?"SELECT public.guard_verdict('catalog_stock_control_guards') ok":'SELECT public.catalog_stock_control_guards() ok';
  return p.ledger&&(await c.query(guard)).rows[0].ok?'available':'unavailable';
  }catch(e){failed=true;throw e;}finally{if(prior.role==='dyna_app'){if(failed)await c.query('SET LOCAL ROLE dyna_app').catch(()=>{});else await c.query('SET LOCAL ROLE dyna_app');}}
}
export async function catalogStockControlInstalledInTx(c:Pool|PoolClient):Promise<boolean>{
  const availability=await catalogStockControlAvailabilityInTx(c);
  ensure(availability!=='unavailable',503,'Niekompletny moduł ścisłej kontroli katalogu');
  return availability==='available';
}
/** Before source/header locks, after existing WMS and purchasing admissions. */
export async function catalogStockControlAdmissionInTx(c:PoolClient,a:{tenantId:string},mode:'shared'|'activation'='shared'):Promise<CatalogStockControlAdmission>{
  const state=contexts.get(c);ensure(state,500,'Brak zarządzanej transakcji katalogu');
  ensure(!state.terminalFrozen,500,'Nie można dodać admisji po końcowej kontroli katalogu');
  const prior=state.admissions.get(a.tenantId);
  if(prior){ensure(prior.mode==='activation'||mode==='shared',409,'Nie można podnieść blokady ścisłego katalogu');return prior;}
  const installation=await inspectActiveManagedInstallation(c,a.tenantId);
  const installed=installation?.catalog??await catalogStockControlInstalledInTx(c);
  if(installed)await c.query(`SELECT ${mode==='activation'?'pg_advisory_xact_lock':'pg_advisory_xact_lock_shared'}(hashtextextended('catalog.strict.lifecycle:'||$1,0))`,[a.tenantId]);
  const admission={tenantId:a.tenantId,mode,installed};state.admissions.set(a.tenantId,admission);return admission;
}
export function enlistCatalogStockControlActorInTx<T extends CatalogStockControlActor>(c:PoolClient,a:T,requirements:{adminOnly?:boolean;scopes?:readonly string[]}={}):T{
  const state=contexts.get(c);ensure(state,500,'Brak zarządzanej transakcji katalogu');
  ensure(!state.terminalFrozen,500,'Nie można dodać aktora po końcowej kontroli katalogu');
  const key=JSON.stringify([a.tenantId,a.userId,a.apiKeyId??null]),prior=state.actors.get(key);
  state.actors.set(key,{...a,adminOnly:!!requirements.adminOnly||!!prior?.adminOnly,scopes:new Set([...(prior?.scopes??[]),...(requirements.scopes??['inventory:read','inventory:write'])])});return a;
}

/** Private writer obligation survives NULL/replay and consumed COUNT admission custody. */
export function registerCatalogStockCountTerminalInTx(c:PoolClient,a:CatalogStockControlActor,source:CatalogStockCountSource){
  const state=contexts.get(c);ensure(state&&!state.terminalFrozen,500,'Brak otwartej końcowej transakcji COUNT');
  assertNoAllegroAuthorityInTx(c);
  assertNoFinancialReturn162AdmissionInTx(c);
  const key=JSON.stringify([a.tenantId,a.userId,a.apiKeyId??null,source.protocol,source.source_id]);
  state.countTerminals.set(key,Object.freeze({actor:Object.freeze({...a}),source:JSON.stringify(source)}));
}
export type CatalogStockCountTerminalGrant={actor:CatalogStockControlActor;roles:readonly string[];scopes:readonly string[]};

/** Last writer phase: all sibling waits -> every PIN -> fresh schema -> native grants -> one DB-clock batch.
 * No source hydration, DML or further finalizer follows. Nonparticipants are neutral, including pre152. */
export async function finalizeCatalogStockCountTerminalInTx(c:PoolClient,extra:readonly CatalogStockCountTerminalGrant[]=[]){
  const state=contexts.get(c);if(!state?.countTerminals.size)return;
  ensure(!state.terminalFrozen,500,'Końcowa kontrola COUNT została już wykonana');state.terminalFrozen=true;
  const wms=freezeWmsActorsForCountInTx(c),dispatch=freezeDispatchActorsForCountInTx(c);
  type Required={tenant_id:string;user_id:string|null;key_id:string|null;roles:string[];scopes:string[];system:boolean};
  const required=new Map<string,Required>();
  const add=(a:CatalogStockControlActor,roles:readonly string[],scopes:readonly string[])=>{
    const key=JSON.stringify([a.tenantId,a.userId,a.apiKeyId??null]),prior=required.get(key);
    ensure(roles.length>0&&roles.every(r=>['admin','operator','viewer'].includes(r)),500,'Nieprawidłowy kontrakt roli końcowej');
    const merged=prior?prior.roles.filter(r=>roles.includes(r)):[...roles];ensure(merged.length,403,'Sprzeczne wymagania roli końcowej');
    if(a.userId===null)ensure(a.source==='system'&&!a.apiKeyId&&roles.includes('operator'),403,'Brak certyfikowanego kontekstu systemowego');
    required.set(key,{tenant_id:a.tenantId,user_id:a.userId,key_id:a.apiKeyId??null,roles:merged,
      scopes:[...new Set([...(prior?.scopes??[]),...scopes])].sort(),system:a.userId===null&&a.source==='system'});
  };
  for(const a of state.actors.values())add(a,a.adminOnly?['admin']:['admin','operator'],[...a.scopes]);
  for(const a of wms)add(a,a.adminOnly||a.cost?['admin']:['admin','operator'],[
    'inventory:read','inventory:write',...(a.cost?['purchasing:read','purchasing:write']:[]),...(a.orders?['orders:read','orders:write']:[])]);
  for(const a of dispatch)add(a,['admin','operator'],a.scopes);
  for(const e of extra)add(e.actor,e.roles,e.scopes);
  const duties=[...state.countTerminals.values()];
  ensure(duties.every(d=>required.has(JSON.stringify([d.actor.tenantId,d.actor.userId,d.actor.apiKeyId??null]))),500,'Brak bieżącego kontraktu aktora COUNT');
  const actors=[...required.values()].sort((a,b)=>JSON.stringify([a.tenant_id,a.user_id,a.key_id]).localeCompare(JSON.stringify([b.tenant_id,b.user_id,b.key_id])));
  await drainPublicConstraintsInTx(c);
  const prior=(await c.query("SELECT current_user role,session_user owner,current_setting('app.tenant_id',true) tenant")).rows[0];
  ensure(prior.owner==='postgres'&&['postgres','dyna_app'].includes(prior.role),403,'Obcy kontekst końcowej kontroli COUNT');
  if(prior.role==='dyna_app')await c.query('RESET ROLE');
  let failed=false;
  try{
    // Pin the entire immutable set before the possibly expensive schema check.
    for(const a of actors){
      if(a.user_id===null)continue;
      const m=(await c.query('SELECT role FROM public.memberships WHERE tenant_id=$1 AND user_id=$2 FOR SHARE',[a.tenant_id,a.user_id])).rows[0];
      ensure(m&&a.roles.includes(m.role),403,'Bieżąca rola nie pozwala zatwierdzić COUNT');
      if(a.key_id){const k=(await c.query('SELECT user_id,revoked_at FROM public.api_keys WHERE tenant_id=$1 AND id=$2 FOR SHARE',[a.tenant_id,a.key_id])).rows[0];
        ensure(k&&k.user_id===a.user_id&&!k.revoked_at,401,'Klucz API został cofnięty lub wygasł');}
    }
    await c.query('SELECT public.catalog_stock_count_terminal_require()');
    // Source-specific COUNT and WMS predicates retain actual native authority.
    for(const d of duties){await c.query("SELECT set_config('app.tenant_id',$1,true)",[d.actor.tenantId]);
      const grant=(await c.query('SELECT public.catalog_stock_count_access($1,$2,$3::jsonb) requirements',[d.actor.userId,d.actor.apiKeyId??null,d.source])).rows[0].requirements;
      const r=required.get(JSON.stringify([d.actor.tenantId,d.actor.userId,d.actor.apiKeyId??null]))!;
      ensure(typeof grant.admin_only==='boolean'&&Array.isArray(grant.scopes)&&grant.scopes.every((s:unknown)=>typeof s==='string'&&r.scopes.includes(s))
        &&(!grant.admin_only||r.roles.length===1&&r.roles[0]==='admin'),409,'Bieżący kontrakt COUNT wymaga nowego zakresu');
    }
    for(const a of wms){if(a.userId===null)continue;await c.query("SELECT set_config('app.tenant_id',$1,true)",[a.tenantId]);
      const role=(await c.query('SELECT public.wms_current_role($1,false) role',[a.userId])).rows[0].role;
      ensure(role==='admin'||!a.adminOnly&&!a.cost&&role==='operator',403,'Cofnięto rolę WMS');
      if(a.apiKeyId){const grant=(await c.query('SELECT public.wms_key_grant($1,$2,$3) result',[a.userId,a.apiKeyId,a.cost])).rows[0].result;
        ensure(grant!=='invalid',401,'Klucz WMS został cofnięty lub wygasł');ensure(grant==='ok',403,'Cofnięto zakresy WMS');
        if(a.orders){const order=(await c.query('SELECT public.wms_key_order_grant($1,$2) result',[a.userId,a.apiKeyId])).rows[0].result;
          ensure(order!=='invalid',401,'Klucz WMS został cofnięty lub wygasł');ensure(order==='ok',403,'Cofnięto zakresy zamówień WMS');}}
    }
    // One fresh current-state batch after every potentially costly native/schema operation.
    const rows=(await c.query(`SELECT a.*,m.role,k.id actual_key_id,k.user_id key_user,k.revoked_at,
      k.scopes key_scopes,(k.expires_at IS NULL OR k.expires_at>clock_timestamp()) alive
      FROM jsonb_to_recordset($1::jsonb) a(tenant_id uuid,user_id uuid,key_id uuid,roles text[],scopes text[],system boolean)
      LEFT JOIN public.memberships m ON(m.tenant_id,m.user_id)=(a.tenant_id,a.user_id)
      LEFT JOIN public.api_keys k ON(k.tenant_id,k.id)=(a.tenant_id,a.key_id)`,[JSON.stringify(actors)])).rows;
    ensure(rows.length===actors.length,403,'Zmienił się pełny zakres aktorów COUNT');
    for(const a of rows){if(a.user_id===null){ensure(a.system&&!a.key_id,403,'Obcy aktor systemowy');continue;}
      ensure(a.roles.includes(a.role),403,'Cofnięto rolę przed zatwierdzeniem COUNT');
      if(a.key_id){ensure(a.actual_key_id===a.key_id&&a.key_user===a.user_id&&!a.revoked_at&&a.alive,401,'Klucz API został cofnięty lub wygasł');
        ensure(a.scopes.every((s:string)=>a.key_scopes.includes(s)),403,'Cofnięto zakresy przed zatwierdzeniem COUNT');}}
  }catch(e){failed=true;const code=(e as {code?:string}).code;
    if(['55000','42P01','42703','42883'].includes(code??''))throw new Problem(503,'Niekompletny końcowy publisher COUNT');
    if(code==='28000')throw new Problem(401,'Klucz COUNT został cofnięty lub wygasł');
    if(code==='42501')throw new Problem(403,'Cofnięto uprawnienia COUNT');throw e;
  }finally{
    const restore=async()=>{await c.query("SELECT set_config('app.tenant_id',$1,true)",[prior.tenant??'']);if(prior.role==='dyna_app')await c.query('SET LOCAL ROLE dyna_app');};
    if(failed)await restore().catch(()=>{});else await restore();
  }
}
/** Fresh RC current membership/key PIN after hydration and deferred checks, also OFF.
 * Restores original role/tenant so sibling finalizers retain their own context. */
export async function finalizeCatalogStockControlActorsInTx(c:PoolClient){
  const state=contexts.get(c);if(!state?.actors.size)return;
  await drainPublicConstraintsInTx(c);
  const prior=(await c.query("SELECT current_user role,session_user owner,current_setting('app.tenant_id',true) tenant")).rows[0];
  ensure(prior.owner==='postgres'&&['postgres','dyna_app'].includes(prior.role),403,'Nieprawidłowy właściciel transakcji katalogu');
  if(prior.role==='dyna_app')await c.query('RESET ROLE');
  try{
    for(const a of [...state.actors.values()].sort((x,y)=>JSON.stringify([x.tenantId,x.userId,x.apiKeyId]).localeCompare(JSON.stringify([y.tenantId,y.userId,y.apiKeyId])))){
      await c.query("SELECT set_config('app.tenant_id',$1,true)",[a.tenantId]);
      if(a.userId===null){ensure(a.source==='system'&&!a.apiKeyId&&!a.adminOnly,403,'Brak certyfikowanego systemowego kontekstu źródła');continue;}
      const role=(await c.query('SELECT role FROM public.memberships WHERE tenant_id=$1 AND user_id=$2 FOR SHARE',[a.tenantId,a.userId])).rows[0]?.role;
      ensure(a.adminOnly?role==='admin':['admin','operator'].includes(role),403,'Bieżąca rola nie pozwala zmienić ścisłego katalogu');
      if(a.apiKeyId){
        const k=(await c.query('SELECT user_id,revoked_at,expires_at,scopes FROM public.api_keys WHERE tenant_id=$1 AND id=$2 FOR SHARE',[a.tenantId,a.apiKeyId])).rows[0];
        ensure(k&&k.user_id===a.userId&&!k.revoked_at,401,'Klucz API został cofnięty lub wygasł');
        ensure((await c.query('SELECT $1::timestamptz IS NULL OR $1::timestamptz>clock_timestamp() alive',[k.expires_at])).rows[0].alive,401,'Klucz API został cofnięty lub wygasł');
        ensure([...a.scopes].every(s=>k.scopes.includes(s)),403,'Brak aktualnych zakresów ścisłego katalogu');
      }
    }
  }catch(e){throw e instanceof Problem?e:e;}
  await c.query("SELECT set_config('app.tenant_id',$1,true)",[prior.tenant??'']);
  if(prior.role==='dyna_app')await c.query('SET LOCAL ROLE dyna_app');
}

/** Refuse before OAuth state/credential DML; the COUNT clock remains terminal. */
export function assertNoCatalogStockCountTerminalInTx(c: PoolClient) {
  ensure(!contexts.get(c)?.countTerminals.size,409,
    'Allegro i pomiar stanów wymagają odrębnych transakcji');
}
