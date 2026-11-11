/** Optional reciprocal preflight, with true absence neutral and torn family503. */
import type {PoolClient} from 'pg';
import {ensure} from './errors';
export async function fa3DraftOwnerInTx<T>(c:PoolClient,fn:()=>Promise<T>):Promise<T>{
 const before=(await c.query(`SELECT current_user role,session_user owner,current_setting('app.tenant_id',true) tenant,
 pg_current_xact_id()::text root,transaction_timestamp()::text started,pg_get_userbyid(relowner) relation_owner
 FROM pg_class WHERE oid='public.orders'::regclass`)).rows[0];
 ensure(before&&before.tenant&&before.owner!=='dyna_app'&&before.owner===before.relation_owner&&[before.owner,'dyna_app'].includes(before.role),403,'Brak własnego kontekstu odczytu B2B');
 let failed=false;try{if(before.role==='dyna_app')await c.query('RESET ROLE');return await fn();}
 catch(e){failed=true;throw e;}finally{try{
  await c.query("SELECT set_config('app.tenant_id',$1,true)",[before.tenant]);
  if(before.role==='dyna_app')await c.query('SET LOCAL ROLE dyna_app');
 }catch(e){if(!failed)throw e;}}
}
export async function fa3DraftAvailableInTx(c:PoolClient){
 return fa3DraftOwnerInTx(c,async()=>{
  const p=(await c.query(`SELECT EXISTS(SELECT FROM migrations WHERE name='158_fa3_draft_native') installed,
  to_regprocedure('public.fa3_draft_guards()') IS NOT NULL helper,
  (EXISTS(SELECT FROM pg_class WHERE relnamespace='public'::regnamespace AND relname LIKE 'fa3\\_draft\\_%' ESCAPE '\\')
   OR EXISTS(SELECT FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'fa3\\_draft\\_%' ESCAPE '\\')) artifacts,
  to_regprocedure('public.guard_verdict(text)') verdict`)).rows[0];
  if(!p.installed&&!p.helper&&!p.artifacts)return false;
  ensure(p.installed&&p.helper,503,'Niepełny moduł projektów B2B');
  // 248: the same verdict, reused while the cold-approved schema and the guard's basis are unchanged.
  ensure((await c.query(p.verdict?"SELECT public.guard_verdict('fa3_draft_guards') ok":'SELECT public.fa3_draft_guards() ok')).rows[0].ok===true,503,'Uszkodzone metadane projektu B2B');return true;
 });
}
/** Caller holds genuine native order lock. No provider request before this gate. */
export async function assertNoFa3DraftProjectInTx(c:PoolClient,orderId:string){
 if(!await fa3DraftAvailableInTx(c))return;
 const exists=await fa3DraftOwnerInTx(c,()=>c.query(`SELECT 1 FROM fa3_draft_projects
 WHERE tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND order_id=$1`,[orderId]));
 ensure(!exists.rowCount,409,'Zamówienie ma zatwierdzony projekt B2B; wystawienie wymaga odrębnego procesu');
}
