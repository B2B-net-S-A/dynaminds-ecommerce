import type { PoolClient } from 'pg';
import type { AuditActor } from './domain';
import { ensure, Problem } from './errors';
import { PACKING_FIELD_ROUTINES } from './packing-order-field-contract';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA=/^[a-f0-9]{64}$/;
export type PackingFieldCut={schema:'packing-required-order-fields/v1';order_id:string;fields:{field_id:string;definition_version:number;definition_sha256:string;value_sha256:string;complete:boolean}[];complete:boolean};
const CONTEXT_SQL=`SELECT session_user owner,current_user role,current_setting('app.tenant_id',true) tenant,current_setting('transaction_isolation') isolation`;
// Catalogue-only, before dispatch. Fixed expected bodies/headers generated from our literal SQL, never caller flags.
const DESCRIPTOR_SQL=`WITH expected AS (SELECT * FROM jsonb_to_recordset($1::jsonb) e(identity text,body_sha256 text,returns text,volatility text,app_execute boolean,argument_names text[])),
 routines AS (SELECT e.*,p.*,pg_get_userbyid(p.proowner) owner FROM expected e LEFT JOIN pg_proc p ON p.oid=to_regprocedure(e.identity))
 SELECT count(*)::int n,count(oid)::int present,coalesce(bool_and(oid IS NOT NULL AND owner=session_user AND prokind='f' AND NOT prosecdef AND NOT proisstrict AND NOT proretset AND proparallel='u'
 AND proargnames IS NOT DISTINCT FROM argument_names AND pronargdefaults=0 AND provariadic=0 AND proargmodes IS NULL AND proallargtypes IS NULL AND prosupport=0 AND probin IS NULL AND prosqlbody IS NULL AND NOT proleakproof AND procost=100 AND prorows=0
 AND provolatile=volatility::"char" AND prorettype::regtype::text=returns AND prolang=(SELECT oid FROM pg_language WHERE lanname='plpgsql')
 AND proconfig=ARRAY['search_path=pg_catalog, public']::text[] AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')=body_sha256
 AND (SELECT jsonb_agg(jsonb_build_object('role',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,'privilege',a.privilege_type,'grantable',a.is_grantable,'grantor',pg_get_userbyid(a.grantor)) ORDER BY a.grantee=0,pg_get_userbyid(a.grantee)) FROM aclexplode(coalesce(proacl,acldefault('f',proowner))) a)
 =CASE WHEN app_execute THEN jsonb_build_array(jsonb_build_object('role','dyna_app','privilege','EXECUTE','grantable',false,'grantor',session_user),jsonb_build_object('role',session_user,'privilege','EXECUTE','grantable',false,'grantor',session_user)) ELSE jsonb_build_array(jsonb_build_object('role',session_user,'privilege','EXECUTE','grantable',false,'grantor',session_user)) END),false) routines_valid,
 (SELECT count(t.oid)=3 AND bool_and(t.tgenabled='O' AND NOT t.tgisinternal AND t.tgparentid=0 AND NOT t.tgdeferrable AND NOT t.tginitdeferred AND t.tgqual IS NULL AND octet_length(t.tgargs)=0
 AND t.tgfoid=to_regprocedure('public.packing_required_fields_guard()') AND t.tgtype=own_trigger.kind
 AND (SELECT coalesce(array_agg(a.attname::text ORDER BY a.attnum),'{}'::text[]) FROM pg_attribute a WHERE a.attrelid=t.tgrelid AND a.attnum=ANY(t.tgattr::smallint[]))=own_trigger.columns)
 FROM (VALUES('packing_required_fields_status','public.orders',19,ARRAY['status']::text[]),('packing_required_fields_preview','public.packing_previews',7,'{}'::text[]),('packing_required_fields_receipt','public.packing_receipts',7,'{}'::text[])) own_trigger(name,relation,kind,columns)
 LEFT JOIN pg_trigger t ON t.tgname=own_trigger.name AND t.tgrelid=to_regclass(own_trigger.relation)) triggers_valid,
 EXISTS(SELECT FROM migrations WHERE name='189_packing_required_order_fields') migration_present FROM routines`;
/** Definitions use exclusive at the same key. Call before order/session locks. */
export async function acquirePackingFieldAdmissionInTx(c:PoolClient,a:AuditActor){
 ensure(a.userId,403,'Wymagany aktualny użytkownik');
 const ctx=(await c.query(CONTEXT_SQL)).rows[0];
 ensure(ctx?.owner==='postgres'&&['postgres','dyna_app'].includes(ctx.role)&&ctx.tenant===a.tenantId&&['read committed','repeatable read'].includes(ctx.isolation),403,'Pola pakowania wymagają własnego managed tenant TX');
 await c.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))',[`order-fields:${a.tenantId}`]);
}
export async function packingFieldsAvailableInTx(c:PoolClient):Promise<boolean>{
 const ctx=(await c.query(CONTEXT_SQL)).rows[0];
 ensure(ctx?.owner==='postgres'&&['postgres','dyna_app'].includes(ctx.role)&&UUID.test(ctx.tenant??'')&&['read committed','repeatable read'].includes(ctx.isolation),403,'Nieprawidłowy kontekst metadanych pól pakowania');
 ensure(ctx.role!=='dyna_app'||'release' in c,403,'Metadane pól wymagają tego samego klienta transakcji');
 const restore=ctx.role==='dyna_app';let failed=false;
 try{
  // Fixed catalogue/marker read on the same owner-managed transaction; no business rows.
  if(restore)await c.query('RESET ROLE');
  const row=(await c.query(DESCRIPTOR_SQL,[JSON.stringify(PACKING_FIELD_ROUTINES)])).rows[0];
  ensure(row?.n===4&&Number.isInteger(row.present)&&row.present>=0&&row.present<=4,503,'Niekompletny descriptor pól pakowania');
  if(row.present===0&&!row.migration_present)return false;
  ensure(row.present===4&&row.routines_valid===true&&row.triggers_valid===true&&row.migration_present===true,503,'Zmieniona lub częściowa instalacja pól pakowania');
  return true;
 }catch(error){failed=true;throw error;}
 finally{if(restore)try{await c.query('SET LOCAL ROLE dyna_app');}catch(error){if(!failed)throw error;}}
}
export function decodePackingFieldCut(value:unknown,orderId:string):PackingFieldCut{
 ensure(value!==null&&typeof value==='object'&&!Array.isArray(value),503,'Nieprawidłowy snapshot pól pakowania');
 const x=value as PackingFieldCut;ensure(Object.keys(x).sort().join(',')==='complete,fields,order_id,schema'&&x.schema==='packing-required-order-fields/v1'&&x.order_id===orderId&&UUID.test(orderId)&&Array.isArray(x.fields)&&x.fields.length<=100&&typeof x.complete==='boolean',503,'Nieprawidłowy scope pól pakowania');
 let prior='';const fields=x.fields.map(f=>{ensure(f&&Object.keys(f).sort().join(',')==='complete,definition_sha256,definition_version,field_id,value_sha256'&&UUID.test(f.field_id)&&f.field_id>prior&&Number.isSafeInteger(f.definition_version)&&f.definition_version>0&&SHA.test(f.definition_sha256)&&SHA.test(f.value_sha256)&&typeof f.complete==='boolean',503,'Nieprawidłowy roster pól pakowania');prior=f.field_id;return Object.freeze({...f});});
 ensure(x.complete===fields.every(f=>f.complete),503,'Nieprawidłowy wynik wymagalności');
 return Object.freeze({...x,fields:Object.freeze(fields)}) as unknown as PackingFieldCut;
}
/** Caller has acquired field admission BEFORE the own order lock; no plaintext is projected. */
export async function capturePackingFieldRequirementsInTx(c:PoolClient,a:AuditActor,orderId:string):Promise<PackingFieldCut|null>{
 ensure(UUID.test(orderId)&&a.userId,403,'Brak własnego scope pól pakowania');
 if(!await packingFieldsAvailableInTx(c)){
  const existing=(await c.query("SELECT count(*)::int n FROM order_field_definitions WHERE enabled AND 'pack_complete'=ANY(required_on)")).rows[0];
  ensure(existing?.n===0,503,'Wymagania pól potrzebują kompletnej instalacji');return null;
 }
 const current=(await c.query('SELECT packing_current_role($1,false) role',[a.userId])).rows[0]?.role;
 ensure(['admin','operator'].includes(current),403,'Brak aktualnego prawa do zakończenia pakowania');
 const result=(await c.query('SELECT public.packing_required_fields_snapshot($1) cut',[orderId])).rows[0];
 return decodePackingFieldCut(result?.cut,orderId);
}
/** Integrate at central domain packed gate, not only workstation. No caller-ready authority. */
export async function assertPackingFieldsCompleteInTx(c:PoolClient,a:AuditActor,orderId:string){
 const cut=await capturePackingFieldRequirementsInTx(c,a,orderId);
 if(cut&&!cut.complete)throw new Problem(409,'Uzupełnij wymagane pola przed zakończeniem pakowania');
}
