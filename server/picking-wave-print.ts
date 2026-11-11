import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {z} from 'zod';
import type {PoolClient} from 'pg';
import {tenantTx,tenantReadTx} from './db';
import {encrypt,decrypt} from './security';
import {audit} from './domain';
import {Problem,ensure} from './errors';
import {printUuid,printVersion,validatePrintContent,type PrintActor} from './print-job-values';
import {waveDetail} from './picking-waves';
import {pickingPdfSnapshot,renderPickingWavePdf} from './picking-wave-pdf';

export const wavePrintPrepareInput=z.strictObject({client_key:printUuid,wave_version:printVersion,
 station_id:printUuid,station_version:printVersion,printer_id:printUuid,printer_version:printVersion,copies:z.number().int().min(1).max(10)});
export const wavePrintQueueInput=z.strictObject({client_key:printUuid,scope_hash:z.string().regex(/^[a-f0-9]{64}$/),confirmed:z.literal(true)});
export type WavePrintPrepare=z.infer<typeof wavePrintPrepareInput>;
export type WavePrintQueue=z.infer<typeof wavePrintQueueInput>;
const missing='Moduł drukowania partii jest niekompletny';
const hash=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
const iso=(v:Date|string)=>v instanceof Date?v.toISOString():v;
async function transaction<T>(a:PrintActor,write:boolean,f:(c:PoolClient)=>Promise<T>):Promise<T>{
 try{return await(write?tenantTx:tenantReadTx)(a.tenantId,async c=>{
  const p=(await c.query(`SELECT to_regclass('public.wave_print177_certificate') IS NOT NULL certificate,
   to_regprocedure('public.wave_print177_valid()') IS NOT NULL validator`)).rows[0];
  ensure(p.certificate&&p.validator,503,missing);
  await c.query('SELECT wave_print177_require($1,$2,$3,false)',[a.userId,a.apiKeyId??null,write]);
  return f(c);
 });}catch(e){if(e instanceof Problem)throw e;const x=e as {code?:string;message?:string};
  if(['42P01','42703','42883','55000'].includes(x.code??''))throw new Problem(503,missing);
  if(x.code==='23514'&&x.message==='Klucz drukowania jest nieaktualny')throw new Problem(401,x.message);
  if(x.code==='23514'&&x.message==='Brak aktualnego uprawnienia do drukowania')throw new Problem(403,x.message);
  if(x.code==='P0002')throw new Problem(404,'Nie znaleziono własnego podglądu partii');
  if(['23514','23505','23503','40001'].includes(x.code??''))throw new Problem(409,'Źródło partii lub konfiguracja drukowania zmieniły się');throw e;
 }
}
async function ownPreview(c:PoolClient,a:PrintActor,waveId:string,selection:{id:string}|{key:string}){
 const column='id' in selection?'p.id':'p.client_key',value='id' in selection?selection.id:selection.key;
 const row=(await c.query(`SELECT p.id,p.payload,p.scope_hash,p.expires_at,s.job_id queued_job_id,
  p.expires_at>clock_timestamp() AND s.job_id IS NULL live,
  (print_job_access($4,$5,true,false)->>'allowed')::boolean permitted
  FROM picking_wave_print_previews p LEFT JOIN print_job_wave_sources s ON(s.tenant_id,s.preview_id)=(p.tenant_id,p.id)
  WHERE p.tenant_id=$1 AND p.wave_id=$2 AND ${column}=$3 AND p.actor_id=$4 AND p.api_key_id IS NOT DISTINCT FROM $5`,
  [a.tenantId,waveId,value,a.userId,a.apiKeyId??null])).rows[0];
 ensure(row,404,'Nie znaleziono własnego podglądu partii');
 return {...row.payload,scope_hash:row.scope_hash,created_at:iso(row.payload.created_at),expires_at:iso(row.expires_at),queued_job_id:row.queued_job_id??null,can_queue:row.live===true&&row.permitted===true};
}
export async function readWavePrintPreview(a:PrintActor,wid:string,id:string){wid=printUuid.parse(wid);id=printUuid.parse(id);return transaction(a,false,async c=>({preview:await ownPreview(c,a,wid,{id})}));}
export async function readWavePrintPreviewByKey(a:PrintActor,wid:string,key:string){wid=printUuid.parse(wid);key=printUuid.parse(key);return transaction(a,false,async c=>({preview:await ownPreview(c,a,wid,{key})}));}
export async function prepareWavePrint(a:PrintActor,wid:string,input:unknown){
 wid=printUuid.parse(wid);const request=wavePrintPrepareInput.parse(input);
 return transaction(a,true,async c=>{
  // Replay lookup is read-only. A matching old key never re-renders/re-encrypts.
  const prior=(await c.query('SELECT id,request FROM picking_wave_print_previews WHERE tenant_id=$1 AND wave_id=$2 AND client_key=$3 AND actor_id=$4 AND api_key_id IS NOT DISTINCT FROM $5',[a.tenantId,wid,request.client_key,a.userId,a.apiKeyId??null])).rows[0];
  if(prior){ensure(isDeepStrictEqual(prior.request,request),409,'Klucz podglądu ma inną treść');return {preview:await ownPreview(c,a,wid,{id:prior.id}),reused:true};}
  const frame=(await c.query('SELECT wave_print177_prepare_frame($1,$2::jsonb,$3,$4) frame',[wid,JSON.stringify(request),a.userId,a.apiKeyId??null])).rows[0].frame;
  ensure(frame.basis.wave.version===request.wave_version,409,'Partia zmieniła się');
  const time=(await c.query('SELECT transaction_timestamp() captured_at')).rows[0].captured_at;
  // The trusted renderer consumes genuine full wave reads in the SAME locked TX.
  const snapshot=pickingPdfSnapshot(await waveDetail(c,wid),a.tenantId,wid,iso(time));
  const bytes=await renderPickingWavePdf(snapshot);
  ensure(bytes.length<=2097152,422,'PDF przekracza limit kolejki 2 MiB; pobierz podgląd bez dodawania do kolejki');
  const b64=bytes.toString('base64');validatePrintContent(b64,'pdf');
  const r=(await c.query('SELECT wave_print177_store($1,$2::jsonb,$3,$4) r',[wid,JSON.stringify({request,basis:frame.basis,render_snapshot:snapshot,content_base64:b64,content_encrypted:encrypt({content_base64:b64})}),a.userId,a.apiKeyId??null])).rows[0].r;
  if(!r.reused)await audit(c,a,'print.wave.preview',r.preview.id,{wave_id:wid,asset_id:r.preview.asset_id,content_sha256:r.preview.content_sha256});
  await c.query('SET CONSTRAINTS ALL IMMEDIATE');
  return {preview:await ownPreview(c,a,wid,{id:r.preview.id}),reused:!!r.reused};
 });
}
async function exactContent(c:PoolClient,a:PrintActor,pid:string){
 const asset=(await c.query('SELECT wave_print177_asset($1,$2,$3) asset',[pid,a.userId,a.apiKeyId??null])).rows[0].asset;
 const b64=decrypt(asset.content_encrypted).content_base64;ensure(typeof b64==='string',409,'Niepoprawny zapis PDF');
 validatePrintContent(b64,'pdf');const bytes=Buffer.from(b64,'base64');ensure(bytes.length===asset.content_bytes&&hash(bytes)===asset.content_sha256,409,'Bajty PDF różnią się od podglądu');
 return {b64,bytes,asset};
}
export async function readWavePrintContent(a:PrintActor,wid:string,pid:string){wid=printUuid.parse(wid);pid=printUuid.parse(pid);
 return transaction(a,false,async c=>{await ownPreview(c,a,wid,{id:pid});const v=await exactContent(c,a,pid);return {preview_id:pid,mime:'application/pdf',byte_count:v.bytes.length,content_sha256:v.asset.content_sha256,content_base64:v.b64};});}
export async function queueWavePrint(a:PrintActor,wid:string,pid:string,input:unknown){wid=printUuid.parse(wid);pid=printUuid.parse(pid);const request=wavePrintQueueInput.parse(input);
 return transaction(a,true,async c=>{
  await ownPreview(c,a,wid,{id:pid});const v=await exactContent(c,a,pid);
  const r=(await c.query('SELECT wave_print177_queue($1,$2::jsonb,$3,$4,$5) r',[pid,JSON.stringify(request),v.b64,a.userId,a.apiKeyId??null])).rows[0].r;
  ensure(r.job?.source_kind==='picking_wave'&&r.job.wave_id===wid&&r.job.order_id===null&&r.job.order_snapshot===null,409,'Niepełne źródło zadania partii');
  if(!r.reused)await audit(c,a,'print.wave.queue',r.job.id,{wave_id:wid,preview_id:pid,content_sha256:r.job.content_sha256,event_id:r.event.id});
  await c.query('SET CONSTRAINTS ALL IMMEDIATE');return {preview:await ownPreview(c,a,wid,{id:pid}),job:r.job,reused:!!r.reused};
 });
}
