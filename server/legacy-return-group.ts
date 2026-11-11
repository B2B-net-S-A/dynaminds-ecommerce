// SUCCESSOR AUTHORED_ONLY. Companion to exact native63234 receive→close phase.
// AUTHORED_ONLY. Future server/legacy-return-group.ts; never registered/applied.
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { Actor } from './domain';
import { ensure, Problem } from './errors';
import { prepareLegacyOnReturnCommandInTx, claimLegacyOnReturnCommandInTx, discardLegacyOnReturnCommandInTx, type LegacyOnReturnCommand } from './legacy-return-on-command';
import { prepareLegacyReturnCompletionInTx } from './returns';
import { completeReturnCompletionInTx, pinReturnCompletionInTx } from './return-completion';

export type LegacyReturnGroup = Readonly<{ id: string; order_id: string; return_id: string; wms_enabled:boolean }>;
type Prepared = Awaited<ReturnType<typeof prepareLegacyReturnCompletionInTx>>;
type State = { client: PoolClient; actor: string; token: string; prepared: Prepared | undefined; on: LegacyOnReturnCommand|null;
  phase: 'prepared' | 'receiving' | 'received' | 'closing' | 'sealed' };
const custody = new WeakMap<LegacyReturnGroup, State>();
const actorKey = (a: Actor) => JSON.stringify([a.tenantId,a.userId,a.apiKeyId??null,a.source??'manual']);
const parsed = z.object({ id:z.uuid(),order_id:z.uuid(),return_id:z.uuid(),wms_enabled:z.boolean() }).strict();
function state(c:PoolClient,a:Actor,t:LegacyReturnGroup) {
  const s=custody.get(t);
  ensure(s&&s.client===c&&s.actor===actorKey(a)&&s.token===JSON.stringify(t),403,'Obca faza grupy zwrotu');
  return s;
}
export async function groupOwnerInTx<T>(c:PoolClient,a:Actor,fn:()=>Promise<T>):Promise<T>{
  const p=(await c.query("SELECT current_user role,session_user owner,current_setting('app.tenant_id',true) tenant")).rows[0];
  ensure(p.owner==='postgres'&&['postgres','dyna_app'].includes(p.role)&&p.tenant===a.tenantId&&!a.apiKeyId,403,'Obcy kontekst grupy reguły');
  if(p.role==='dyna_app')await c.query('RESET ROLE');let failed=false;
  try{return await fn();}catch(e){failed=true;if(e instanceof Problem)throw e;
    const code=(e as{code?:string}).code;
    if(['55000','42P01','42883','42703'].includes(code??''))throw new Problem(503,'Niekompletna authority grupy zwrotu');
    if(code==='42501')throw new Problem(403,'Cofnięto authority autora grupy');
    if(['23514','23503','23505'].includes(code??''))throw new Problem(409,'Źródło lub faza grupy zwrotu zmieniły się');
    throw e;
  }finally{if(p.role==='dyna_app'){if(failed)await c.query('SET LOCAL ROLE dyna_app').catch(()=>{});else await c.query('SET LOCAL ROLE dyna_app');}}
}
/** Whole absence is neutral; present/torn metadata never selects old fallback. */
export async function legacyReturnGroupAvailableInTx(c:PoolClient,a:Actor){
  return groupOwnerInTx(c,a,async()=>{
    const p=(await c.query(`SELECT to_regprocedure('public.catalog_stock_legacy_group_require()') marker,
      EXISTS(SELECT FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'catalog_stock_legacy_group_%')
      OR EXISTS(SELECT FROM pg_class WHERE relnamespace='public'::regnamespace AND relname LIKE 'catalog_stock_legacy_group_%') partial`)).rows[0];
    if(!p.marker){ensure(!p.partial,503,'Niepełna authority grupy zwrotu');return false;}
    await c.query('SELECT public.catalog_stock_legacy_group_require()');return true;
  });
}
/** BEFORE job/run/rule/order locks. SQL derives actual parent and actor. */
export async function prepareLegacyReturnGroupInTx(c:PoolClient,a:Actor,runId:string,lease:string):Promise<LegacyReturnGroup|null>{
  const raw=await groupOwnerInTx(c,a,async()=>(await c.query('SELECT public.catalog_stock_legacy_group_prepare($1,$2,$3) admission',[a.userId,runId,lease])).rows[0].admission);
  if(raw===null)return null;
  const t=Object.freeze(parsed.parse(raw));
  let on:LegacyOnReturnCommand|null=null;
  try {
    const prepared=t.wms_enabled?undefined:await prepareLegacyReturnCompletionInTx(c,a,t.order_id);
    if(prepared)ensure(prepared.id===t.return_id,409,'Źródło RMA zmieniło się od admisji grupy');
    if(t.wms_enabled){
      on=await prepareLegacyOnReturnCommandInTx(c,a,{order_id:t.order_id,return_id:t.return_id});
      await groupOwnerInTx(c,a,async()=>{await c.query('SELECT public.catalog_stock_legacy_group_bind_on($1,$2)',[a.userId,t.id]);});
    }
    custody.set(t,{client:c,actor:actorKey(a),token:JSON.stringify(t),prepared,on,phase:'prepared'});return t;
  }catch(e){discardLegacyOnReturnCommandInTx(c,a,on);throw e;}
}
/** Domain invokes this only for its new opaque seventh internal argument.
 * Neither a UUID nor a caller-supplied boolean can authorize postponement. */
export async function claimLegacyReturnGroupTransitionInTx(c:PoolClient,a:Actor,t:LegacyReturnGroup,id:string,status:string):Promise<Prepared|undefined>{
  const s=state(c,a,t);ensure(id===t.order_id,403,'Grupa ma inne zamówienie');
  if(status==='return_received'){
    ensure(s.phase==='prepared',409,'Przyjęcie grupy jest już rozpoczęte');
    if(s.on){const claimed=await claimLegacyOnReturnCommandInTx(c,a,s.on);s.prepared={id:t.return_id,...claimed};}
    ensure(s.prepared,409,'Brak prawdziwego completion grupy');s.phase='receiving';return s.prepared;
  }
  ensure(status==='return_completed'&&s.phase==='received',409,'Brak zapisanego intermediate receive');
  s.phase='closing';return undefined;
}
export async function captureLegacyReturnGroupInTx(c:PoolClient,a:Actor,t:LegacyReturnGroup){
  const s=state(c,a,t);ensure(s.phase==='receiving'&&s.prepared,409,'Brak rzeczywistej fazy receive');
  // Original112/138 helpers are retained; this minimal admission excludes their
  // eligible native sources, so they return NULL. There is no fake substitute.
  await completeReturnCompletionInTx(c,a,s.prepared.completion);
  await groupOwnerInTx(c,a,async()=>{await c.query('SELECT public.catalog_stock_legacy_group_capture($1,$2)',[a.userId,t.id]);});
  s.phase='received';
}
export async function finishLegacyReturnGroupInTx(c:PoolClient,a:Actor,t:LegacyReturnGroup){
  const s=state(c,a,t);ensure(s.phase==='closing',409,'Brak rzeczywistej końcowej akcji');
  await groupOwnerInTx(c,a,async()=>{await c.query('SELECT public.catalog_stock_legacy_group_finish($1,$2)',[a.userId,t.id]);});
  s.phase='sealed';
}
export async function pinLegacyReturnGroupNativeInTx(c:PoolClient,a:Actor,t:LegacyReturnGroup){
  const s=state(c,a,t);ensure(s.phase==='sealed'&&s.prepared,409,'Nieukończona grupa');
  await pinReturnCompletionInTx(c,a,s.prepared.completion);
}
/** No SQL, no consumed-child authority check: whole-TX rollback/finally only.
 * Tombstone revocation is idempotent and never permits reuse after consumption. */
export function discardLegacyReturnGroupInTx(c:PoolClient,a:Actor,t:LegacyReturnGroup|null){
  if(!t)return;const s=custody.get(t);if(!s)return;
  ensure(s.client===c&&s.actor===actorKey(a),403,'Obcy rollback grupy');discardLegacyOnReturnCommandInTx(c,a,s.on);custody.delete(t);
}
