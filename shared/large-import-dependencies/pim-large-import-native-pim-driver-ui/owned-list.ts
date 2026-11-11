/** Native173 SELECT-only summary, ordinary RR allows genuine IAM FOR SHARE. No lease/advisory/CAS/DML. */
import {createHash} from 'node:crypto';
import type {FastifyRequest} from 'fastify';
import {ensure} from '../../../server/errors';
import type {ReadPorts} from '../pim-large-import-http-binding-ui/readonly-store';
import type {DoneCorePage,DoneCoreJob} from './list-contract';
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const sha=/^[a-f0-9]{64}$/;
const digest=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
export const LIST_SQL=`SELECT id,revision,state_sha256,plan_hash,created_at,
 (state_text::jsonb#>>'{manifest,records}')::bigint records,
 jsonb_array_length(state_text::jsonb->'core') batches,
 (SELECT jsonb_agg(jsonb_build_object('batch',ordinality-1,'id',b#>>'{execution,ack,head,id}','preview_id',b#>>'{execution,ack,head,preview_id}','scope_hash',b#>>'{execution,ack,head,scope_hash}','total',(b#>>'{execution,ack,head,total}')::bigint) ORDER BY ordinality)
 FROM jsonb_array_elements(state_text::jsonb->'core') WITH ORDINALITY x(b,ordinality)) executions
 FROM public.large_import_jobs173
 WHERE tenant_id=$1 AND actor_id=$2 AND api_key_id IS NOT DISTINCT FROM $3::uuid AND ($5::uuid IS NULL OR id>$5::uuid)
 AND state_text::jsonb->>'approved'='true' AND jsonb_array_length(state_text::jsonb->'core')>0
 AND NOT EXISTS(SELECT FROM jsonb_array_elements(state_text::jsonb->'core') b
 WHERE b#>>'{request,catalog_id}' IS DISTINCT FROM $4 OR b#>>'{execution,ack,head,state}' IS DISTINCT FROM 'done')
 ORDER BY id LIMIT $6`;
/** Cursor binds current owner+key+catalog/page size. UUID keyset; no cross-page snapshot/CAS promise. */
export function createOwnedDoneCoreList(input:ReadPorts){const ports={...input},used=new WeakSet<object>();return {async list(req:FastifyRequest,catalog:string,limit=20,cursor?:string):Promise<DoneCorePage>{
 ensure(uuid.test(catalog)&&Number.isSafeInteger(limit)&&limit>=1&&limit<=25,422,'Nieprawidłowy zakres listy');const actor=ports.capture(req);ensure(actor.role==='admin',403,'Wymagana rola administratora');
 const binding=digest([actor.tenantId,actor.userId,actor.apiKeyId??null,catalog,limit]);let last:string|null=null;
 if(cursor){ensure(cursor.length<=256,422,'Nieprawidłowy kursor');const match=/^([a-f0-9-]{36}):([a-f0-9]{64})$/.exec(cursor);ensure(match&&uuid.test(match[1])&&match[2]===binding,422,'Kursor należy do innego zakresu');last=match[1];}
 let owned=false;let c:Awaited<ReturnType<ReadPorts['connect']>>['c']|undefined,started=false,failed=false,first:unknown,value:DoneCorePage|undefined;
 const report=(phase:'rollback'|'close')=>{try{ports.cleanupFailure(phase);}catch{}};
 try{const connection=await ports.connect(actor);c=connection.c;ensure(!used.has(c),503,'Wymagane świeże połączenie');used.add(c);owned=true;const p=connection.scope;ensure(p.tenantId===actor.tenantId&&p.userId===actor.userId&&p.apiKeyId===(actor.apiKeyId??null),403,'Inny właściciel odczytu');
  await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ');started=true;await ports.admit(c,actor,false);
  const state=(await c.query("SELECT current_user role,current_setting('app.tenant_id',true) tenant")).rows[0];ensure(state?.role==='dyna_app'&&state.tenant===p.tenantId,403,'Inna rola lub firma');
  const rows=(await c.query(LIST_SQL,[p.tenantId,p.userId,p.apiKeyId,catalog,last,limit+1])).rows;ensure(rows.length<=limit+1,503,'Nadmierna strona');
  const items:DoneCoreJob[]=rows.slice(0,limit).map((r,i)=>{ensure(uuid.test(r.id)&&(i?r.id>rows[i-1].id:last===null||r.id>last)&&sha.test(r.state_sha256)&&sha.test(r.plan_hash),503,'Nieprawidłowy natywny porządek');
   const revision=Number(r.revision),records=Number(r.records),batches=Number(r.batches);ensure(Number.isSafeInteger(revision)&&revision>=0&&Number.isSafeInteger(records)&&records>0&&records<=100000&&Number.isSafeInteger(batches)&&batches>=1&&batches<=100000&&Array.isArray(r.executions)&&r.executions.length===batches,503,'Niepełny natywny opis');
   let total=0;for(const [n,e]of r.executions.entries()){ensure(e.batch===n&&uuid.test(e.id)&&uuid.test(e.preview_id)&&sha.test(e.scope_hash)&&Number.isSafeInteger(e.total)&&e.total>=1&&e.total<=500,503,'Niepełne trwałe wykonanie');total+=e.total;}ensure(total===records,503,'Inna liczba zapisanych produktów');
   const created_at=r.created_at instanceof Date?r.created_at.toISOString():r.created_at;ensure(typeof created_at==='string'&&Number.isFinite(Date.parse(created_at)),503,'Nieprawidłowa data');
   return{id:r.id,revision,state_sha256:r.state_sha256,plan_hash:r.plan_hash,created_at,catalog_id:catalog,records,batches,executions:structuredClone(r.executions)};});
  value={schema:'large-import-owned-done-core-list/v1',catalog_id:catalog,items,next:rows.length>limit?items.at(-1)!.id+':'+binding:null};ensure(Buffer.byteLength(JSON.stringify(value))<=1048576,413,'Pełna strona listy przekracza limit');
  await ports.admit(c,actor,false);await c.query('COMMIT');started=false;
 }catch(e){failed=true;first=e;if(c&&started)try{await c.query('ROLLBACK');}catch{report('rollback');}}
 finally{if(c&&owned)try{await c.end();}catch(e){report('close');if(!failed){failed=true;first=e;}}}if(failed)throw first;return value!;
 }};}
