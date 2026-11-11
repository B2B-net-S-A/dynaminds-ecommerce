import { z } from 'zod';
import type { Pool,PoolClient } from 'pg';
import { pool,tenantTx,localConfig } from './db';
import { deliveryBindingInTx } from './buyer-address';
import { ensure,Problem } from './errors';
import { audit,type Actor } from './domain';
import { createShipmentLabelPrintPreviewInTx,queueShipmentLabelPrintInTx } from './shipment-label-print';
import { printUuid,printVersion } from './print-job-values';
import { captureOperationalPackedWorkerInTx,operationalDeliveryConsumersAvailable } from './operational-delivery-consumers';
export const packedPrintSettings=z.strictObject({station_id:printUuid,station_version:printVersion,printer_id:printUuid,printer_version:printVersion,copies:z.number().int().min(1).max(10),enabled:z.boolean()});
export const packedPrintPreview=z.strictObject({client_key:printUuid,expected_version:z.string().regex(/^(0|[1-9][0-9]{0,18})$/).refine(v=>BigInt(v)<=9223372036854775806n),settings:packedPrintSettings});
export const packedPrintApproval=z.strictObject({client_key:printUuid,scope_hash:z.string().regex(/^[a-f0-9]{64}$/),confirmed:z.literal(true)});
const query=z.strictObject({cursor:printUuid.optional(),order_id:printUuid.optional(),limit:z.coerce.number().int().min(1).max(50).default(50)});
export async function packedLabelPrintAvailable(c:Pool|PoolClient):Promise<boolean>{
 const p=(await c.query(`SELECT EXISTS(SELECT 1 FROM migrations WHERE name='156_packed_label_print') installed,EXISTS(SELECT 1 FROM pg_class WHERE relnamespace='public'::regnamespace AND relname LIKE 'packed_label_print_%') OR EXISTS(SELECT 1 FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'packed_label_print_%') remnants`)).rows[0];
 if(!p.installed){ensure(!p.remnants,503,'Automatyczny druk jest niekompletny');return false;}
 ensure((await c.query("SELECT to_regprocedure('public.packed_label_print_guards()') IS NOT NULL ok")).rows[0].ok,503,'Automatyczny druk jest niekompletny');
 ensure((await c.query('SELECT packed_label_print_guards() ok')).rows[0].ok===true,503,'Automatyczny druk jest niekompletny');return true;
}
// tx() validates availability with the owner pool and checks guarded authority inside
// this transaction before and after flags; dyna_app cannot read the migration ledger.
async function flags(c:PoolClient,a:Actor){const g=(await c.query('SELECT print_job_access($1,NULL,false,false) g',[a.userId])).rows[0].g;ensure(g.allowed,403,'Brak dostępu do drukowania');return {available:true,can_read:true,can_write:g.role==='admin',can_manage:g.role==='admin',current_role:g.role};}
async function tx<T>(a:Actor,write:boolean,fn:(c:PoolClient)=>Promise<T>){ensure(await packedLabelPrintAvailable(pool),503,'Automatyczny druk nie jest dostępny');try{return await tenantTx(a.tenantId,async c=>{await c.query('SELECT packed_label_print_require($1,$2,false)',[a.userId,write]);const result=await fn(c);await c.query('SET CONSTRAINTS ALL IMMEDIATE');await c.query('SELECT packed_label_print_require($1,$2,true)',[a.userId,write]);return result;});}catch(e){const code=(e as {code?:string}).code;if(code==='55000')throw new Problem(503,'Automatyczny druk jest niekompletny');if(code==='42501')throw new Problem(403,'Wymagany bieżący administrator drukowania');if(code==='P0002')throw new Problem(404,'Nie znaleziono wydruku');if(code==='23514'||code==='23505')throw new Problem(409,'Zgoda, źródło lub wersja druku zmieniły się');throw e;}}
export async function packedLabelPrintOptions(a:Actor){if(!await packedLabelPrintAvailable(pool))return {available:false,can_read:false,can_write:false,can_manage:false,current_role:null,stations:[],printers:[],configurations:[]};return tx(a,false,async c=>{
 const stations=(await c.query('SELECT id,version::text,code,label,enabled FROM packing_stations ORDER BY id LIMIT 101')).rows;
 const printers=(await c.query('SELECT id,version::text,station_id,name,format,output_mode,cups_queue,enabled FROM print_printers ORDER BY id LIMIT 101')).rows;
 ensure(stations.length<=100&&printers.length<=100,413,'Za dużo konfiguracji druku');
 const configurations=(await c.query(`SELECT DISTINCT ON(station_id) id,station_id,version::text,enabled,settings,snapshot,created_at FROM packed_label_print_configurations ORDER BY station_id,version DESC`)).rows;
 return {stations,printers,configurations,...await flags(c,a)};});}
export async function previewPackedLabelPrint(a:Actor,input:unknown){const b=packedPrintPreview.parse(input);return tx(a,true,async c=>{const preview=(await c.query('SELECT packed_label_print_preview($1::jsonb,$2) p',[JSON.stringify(b),a.userId])).rows[0].p;return {preview,...await flags(c,a)};});}
export async function approvePackedLabelPrint(a:Actor,id:string,input:unknown){id=printUuid.parse(id);const b=packedPrintApproval.parse(input);return tx(a,true,async c=>{const r=(await c.query('SELECT packed_label_print_approve($1,$2::jsonb,$3) r',[id,JSON.stringify(b),a.userId])).rows[0].r;if(!r.reused)await audit(c,a,'print.packed.approve',r.configuration.id,{station_id:r.configuration.station_id,version:r.configuration.version,enabled:r.configuration.enabled});return {...r,...await flags(c,a)};});}
export async function packedLabelPrintIntentions(a:Actor,input:unknown){const q=query.parse(input);if(!await packedLabelPrintAvailable(pool))return {available:false,can_read:false,can_write:false,can_manage:false,current_role:null,data:[],meta:{cursor:null,limit:q.limit}};return tx(a,false,async c=>{
 if(q.cursor)ensure((await c.query('SELECT 1 FROM packed_label_print_intents WHERE id=$1 AND ($2::uuid IS NULL OR order_id=$2)',[q.cursor,q.order_id??null])).rowCount,409,'Cursor nie należy do zakresu');
 const rows=(await c.query(`SELECT i.id,i.receipt_id,i.order_id,o.number::text order_number,i.station_id,i.configuration_id,i.state,i.reason,i.job_id,i.created_at,i.updated_at FROM packed_label_print_intents i JOIN orders o ON(o.tenant_id,o.id)=(i.tenant_id,i.order_id) WHERE ($1::uuid IS NULL OR i.order_id=$1) AND ($2::uuid IS NULL OR (i.created_at,i.id)<(SELECT created_at,id FROM packed_label_print_intents WHERE id=$2)) ORDER BY i.created_at DESC,i.id DESC LIMIT $3`,[q.order_id??null,q.cursor??null,q.limit+1])).rows;
 const data=rows.slice(0,q.limit);return {data,meta:{cursor:rows.length>q.limit?data.at(-1)!.id:null,limit:q.limit},...await flags(c,a)};});}
/** Current approved actor comes only from the real persisted intention, never from a request role. */
export async function resolvePackedLabelPrint(tenantId:string,id:string,requester?:Actor){
 id=printUuid.parse(id);ensure(await packedLabelPrintAvailable(pool),503,'Automatyczny druk nie jest dostępny');
 try{return await tenantTx(tenantId,async c=>{
 if(requester)await c.query('SELECT packed_label_print_require($1,true,false)',[requester.userId]);
 const f=(await c.query('SELECT packed_label_print_resolve_frame($1) f',[id])).rows[0].f;
 if(f.ready){
 // HTTP requester remains separate. Only the actual generated DEMO branch uses
 // the stored156 consent actor captured on this exact managed transaction client.
 const shipment=(await c.query('SELECT order_id,mode FROM shipments WHERE(tenant_id,id)=($1,$2)',[tenantId,f.shipment_id])).rows[0];
 const corrected=shipment?.mode==='demo'&&!f.request.asset_id&&await operationalDeliveryConsumersAvailable(c)
   ? await deliveryBindingInTx(c,tenantId,shipment.order_id,localConfig.encryptionKey) : null;
 // An unchanged receiver retains native156 authority without new worker admission.
 const a:Actor=corrected
   ? await captureOperationalPackedWorkerInTx(c,tenantId,id)
   : {tenantId,userId:f.actor_id,role:'admin'};
 ensure(a.tenantId===tenantId&&a.userId===f.actor_id,409,'Autor zapisanej zgody druku zmienił się');
 // Resolve-frame can wait on the order. Recheck its approving administrator
 // before native preview/rendering; the existing terminal PIN remains below.
 await c.query('SELECT packed_label_print_require($1,true,false)',[a.userId]);
 const h=await createShipmentLabelPrintPreviewInTx(c,a,f.shipment_id,f.request);
 // The native preview flush leaves deferrable constraints immediate. Restore
 // their deferred mode while constructing the admitted parent and native job;
 // the full flush and authority PIN below still precede transaction commit.
 await c.query('SET CONSTRAINTS ALL DEFERRED');
 await c.query('SELECT packed_label_print_admit($1,$2)',[id,h.preview.id]);
 const result=await queueShipmentLabelPrintInTx(c,a,h.preview.id,{client_key:f.queue_key,scope_hash:h.preview.scope_hash,packed_intent_id:id});
 await c.query('SELECT packed_label_print_finish($1,$2)',[id,result.job.id]);
 await audit(c,a,'print.packed.queue',result.job.id,{intent_id:id,preview_id:h.preview.id,content_sha256:result.job.content_sha256});
 }
 await c.query('SET CONSTRAINTS ALL IMMEDIATE');
 if(requester)await c.query('SELECT packed_label_print_require($1,true,true)',[requester.userId]);
 return {resolved:!!f.ready};
 });}catch(e){const code=(e as {code?:string}).code;if(code==='42501')throw new Problem(403,'Autor zgody nie ma aktualnych uprawnień');if(code==='55000')throw new Problem(503,'Automatyczny druk jest niekompletny');if(code==='23514'||code==='23505')throw new Problem(409,'Źródło, zgoda lub konfiguracja druku zmieniły się');if(code==='P0002')throw new Problem(404,'Nie znaleziono oczekiwania');throw e;}
}
export async function resolvePackedLabelsDue(){if(!await packedLabelPrintAvailable(pool))return {checked:0};const tenants=(await pool.query("SELECT DISTINCT tenant_id FROM packed_label_print_intents WHERE state='waiting' ORDER BY tenant_id")).rows;let checked=0;for(const t of tenants){const rows=(await pool.query("SELECT id FROM packed_label_print_intents WHERE tenant_id=$1 AND state='waiting' ORDER BY updated_at,id LIMIT 2001",[t.tenant_id])).rows;ensure(rows.length<=2000,413,'Za dużo oczekiwań druku');for(const r of rows){try{await resolvePackedLabelPrint(t.tenant_id,r.id);checked++;}catch(e){if(!(e instanceof Problem)||![403,409].includes(e.status))throw e;/* Refused source remains pending for explicit review; all own bounded waiting rows are examined, not only oldest100. */}}}return {checked};}
