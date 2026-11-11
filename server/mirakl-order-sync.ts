/** One ordinary Mirakl OR11 page. No IO/worker/pool/clock on import.
 * Repository methods below must use the existing job lease and an acknowledged
 * durable transaction. This port is not evidence that a PostgreSQL adapter is installed. */
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {ensure,Problem} from './errors';
import {MiraklReadDeferred,type MiraklOrder} from './mirakl';
import type {MiraklChannelReader} from './mirakl-channel';

export const MIRAKL_ORDER_CHECKPOINT_SCHEMA='mirakl-order-sync-checkpoint/v1' as const;
const uuid=z.uuid(),digest=z.string().regex(/^[a-f0-9]{64}$/),instant=z.iso.datetime({offset:true});
const identifier=z.string().min(1).max(160).refine(v=>!/[\x00-\x1f\x7f]/.test(v));
const currencies=z.enum(['PLN','EUR','USD','GBP','CZK']);
const windowSchema=z.strictObject({start_update_date:instant,end_update_date:instant}).refine(v=>{
 const span=Date.parse(v.end_update_date)-Date.parse(v.start_update_date);return span>0&&span<=31*86400000;
});
const jobSchema=z.strictObject({tenantId:uuid,jobId:uuid,leaseToken:uuid});
const bindingSchema=z.strictObject({tenantId:uuid,channelId:uuid,actorId:uuid,connectionHash:digest,currency:currencies,requireEnabled:z.boolean()});
export type MiraklOrderSyncJob=z.infer<typeof jobSchema>;
export type MiraklOrderSyncBinding=z.infer<typeof bindingSchema>;
const checkpointSchema=z.strictObject({schema:z.literal(MIRAKL_ORDER_CHECKPOINT_SCHEMA),connectionHash:digest,
 revision:z.number().int().min(0).max(10001),window:windowSchema,max:z.number().int().min(1).max(100),
 offset:z.number().int().min(0).max(10000),totalCount:z.number().int().min(0).max(10000).nullable(),
 seenIds:z.array(identifier).max(10000),finished:z.boolean(),watermark:instant.nullable()}).superRefine((v,c)=>{
 const bad=()=>c.addIssue({code:'custom',message:'Inconsistent durable OR11 checkpoint'});
 if(new Set(v.seenIds).size!==v.seenIds.length||v.seenIds.length!==v.offset)bad();
 if(v.revision===0){if(v.offset!==0||v.totalCount!==null||v.finished||v.watermark!==null)bad();}
 else if(v.totalCount===null||v.offset>v.totalCount||v.finished!==(v.offset===v.totalCount))bad();
 if(v.finished?v.watermark!==v.window.end_update_date:v.watermark!==null)bad();
});
export type MiraklOrderSyncCheckpoint=z.infer<typeof checkpointSchema>;
export type MiraklOrderSyncClaim={job:MiraklOrderSyncJob;binding:MiraklOrderSyncBinding;checkpoint:MiraklOrderSyncCheckpoint};
export type MiraklStagedOrder={source:MiraklOrder&{id:string};sourceHash:string};
/** All operations are bound to one existing tenant/job/lease/config version.
 * claim/guard: latest admin, tenant/channel, enabled policy, connection generation,
 * existing running lease, exact namespaced checkpoint. No expired-write reclaim.
 * commitPage: repeat those checks and atomically stage by channel+external ID,
 * CAS checkpoint revision, finish/requeue the same job and advance channel's
 * watermark ONLY on the final page. Never commit staging independently.
 * defer: preserve checkpoint and persist run_at using DB-now + retryAfterSeconds
 * and the provider repository's durable not_before; never sleep in a transaction.
 * fail: CAS the same lease/revision only, store this fixed diagnostic, no raw error.
 */
export interface MiraklOrderSyncRepository {
 claim(job:MiraklOrderSyncJob,binding:MiraklOrderSyncBinding):Promise<{state:'stopped'}|{state:'claimed';checkpoint:unknown}>;
 guard(claim:MiraklOrderSyncClaim):Promise<void>;
 commitPage(claim:MiraklOrderSyncClaim,page:{orders:readonly MiraklStagedOrder[];next:MiraklOrderSyncCheckpoint}):Promise<void>;
 defer(claim:MiraklOrderSyncClaim,input:{retryAfterSeconds:number;reason:'PROVIDER_COOLDOWN'}):Promise<{notBefore:string}>;
 fail(claim:MiraklOrderSyncClaim,input:{reason:'READ_FAILED'|'PAGE_REJECTED'}):Promise<void>;
}
/** Factory must return the channel-bound reader with mandatory durable A01 cache
 * and shared instance×operation read budget. No in-memory budget fallback.
 * The reader invokes guard after budget reservation immediately before HTTP.
 */
export type MiraklOrderReaderFactory=(guard:()=>Promise<void>)=>Pick<MiraklChannelReader,'connectionHash'|'readOrderPage'>|Promise<Pick<MiraklChannelReader,'connectionHash'|'readOrderPage'>>;
export type MiraklOrderSyncResult={status:'stopped'|'already_complete'|'page_committed'|'complete'|'failed';staged?:number;reason?:'READ_FAILED'|'PAGE_REJECTED'}|{status:'deferred';notBefore:string};
function parse<T extends z.ZodType>(schema:T,input:unknown):z.output<T>{
 const result=schema.safeParse(input);ensure(result.success,422,'Mirakl: nieprawidłowy checkpoint lub powiązanie synchronizacji');return result.data;
}
export function initialMiraklOrderCheckpoint(input:{connectionHash:string;window:MiraklOrderSyncCheckpoint['window'];max?:number}):MiraklOrderSyncCheckpoint{
 return parse(checkpointSchema,{schema:MIRAKL_ORDER_CHECKPOINT_SCHEMA,connectionHash:input.connectionHash,revision:0,
  window:input.window,max:input.max??50,offset:0,totalCount:null,seenIds:[],finished:false,watermark:null});
}
const canonical=(v:unknown):unknown=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical((v as Record<string,unknown>)[k])])):v;
const pageSchema=z.strictObject({offset:z.number().int().min(0).max(10000),total_count:z.number().int().min(0).max(10000),has_more:z.boolean(),
 data:z.array(z.object({id:identifier,order_id:identifier,currency_iso_code:currencies,last_updated_date:instant}).passthrough()).max(100)});
function pageCut(raw:unknown,claim:MiraklOrderSyncClaim):{orders:MiraklStagedOrder[];next:MiraklOrderSyncCheckpoint}{
 const page=pageSchema.safeParse(raw);ensure(page.success,502,'Mirakl: strona OR11 wymaga uzgodnienia lub mniejszego okna');
 const p=page.data,c=claim.checkpoint;
 ensure(p.offset===c.offset&&p.data.length<=c.max&&(c.totalCount===null||c.totalCount===p.total_count),502,'Mirakl: zmieniona paginacja OR11');
 const offset=c.offset+p.data.length;
 ensure(offset<=p.total_count&&p.has_more===(offset<p.total_count)&&(p.data.length>0||offset===p.total_count),502,'Mirakl: brak zgodnego postępu OR11');
 const seen=new Set(c.seenIds),orders=p.data.map(row=>{
  ensure(row.id===row.order_id&&!seen.has(row.id)&&row.currency_iso_code===claim.binding.currency&&Date.parse(row.last_updated_date)<=Date.parse(c.window.end_update_date),502,'Mirakl: obcy lub powtórzony rekord OR11');
  seen.add(row.id);
  return {source:row as MiraklOrder&{id:string},sourceHash:createHash('sha256').update(JSON.stringify(canonical(row))).digest('hex')};
 });
 const next=parse(checkpointSchema,{...c,revision:c.revision+1,offset,totalCount:p.total_count,seenIds:[...seen],finished:!p.has_more,watermark:p.has_more?null:c.window.end_update_date});
 return{orders,next};
}
/** Executes at most one provider page. A process restart creates a new reader and
 * resumes the persisted numeric offset; no branded cursor is serialized/adopted. */
export async function processMiraklOrderSync(input:{job:MiraklOrderSyncJob;binding:MiraklOrderSyncBinding;repository:MiraklOrderSyncRepository;createReader:MiraklOrderReaderFactory}):Promise<MiraklOrderSyncResult>{
 const job=parse(jobSchema,structuredClone(input.job)),binding=parse(bindingSchema,structuredClone(input.binding));
 ensure(job.tenantId===binding.tenantId,403,'Mirakl: obca firma zadania');
 const repository=input.repository;let held:Awaited<ReturnType<MiraklOrderSyncRepository['claim']>>;
 try{held=await repository.claim(job,binding);}catch{throw new Problem(502,'Mirakl: nie potwierdzono przyjęcia zadania; odczytaj trwały checkpoint','MIRAKL_SYNC_CLAIM_UNCONFIRMED');}
 if(held.state==='stopped')return{status:'stopped'};
 ensure(held.state==='claimed',502,'Mirakl: niepotwierdzone przyjęcie zadania');
 const checkpoint=parse(checkpointSchema,structuredClone(held.checkpoint));
 ensure(checkpoint.connectionHash===binding.connectionHash,409,'Mirakl: połączenie checkpointu zmieniło się');
 // Keep the same captured job/config/checkpoint facts through every await.
 const freeze=<T>(v:T):T=>{if(v&&typeof v==='object'){for(const x of Object.values(v))freeze(x);Object.freeze(v);}return v;};
 const claim=freeze({job,binding,checkpoint});
 if(checkpoint.finished)return{status:'already_complete'};
 let commitStarted=false,readFinished=false;
 try{
  await repository.guard(claim);
  const reader=await input.createReader(()=>repository.guard(claim));
  ensure(reader.connectionHash===binding.connectionHash,409,'Mirakl: odczyt nie należy do połączenia zadania');
  const raw=await reader.readOrderPage({window:structuredClone(checkpoint.window),max:checkpoint.max,offset:checkpoint.offset});
  readFinished=true;
  await repository.guard(claim);
  const cut=pageCut(structuredClone(raw),claim);
  commitStarted=true;await repository.commitPage(claim,cut);
  return{status:cut.next.finished?'complete':'page_committed',staged:cut.orders.length};
 }catch(error){
  // A page COMMIT can have succeeded despite a lost acknowledgement. Do not
  // overwrite its checkpoint/job or stage again; the next claim reads durable truth.
  if(commitStarted)throw new Problem(502,'Mirakl: nie potwierdzono zapisu strony; odczytaj trwały checkpoint','MIRAKL_SYNC_COMMIT_UNCONFIRMED');
  if(error instanceof MiraklReadDeferred&&Number.isSafeInteger(error.seconds)&&error.seconds>=1&&error.seconds<=2147483647){
   try{const receipt=await repository.defer(claim,{retryAfterSeconds:error.seconds,reason:'PROVIDER_COOLDOWN'});
    const notBefore=parse(instant,receipt.notBefore);return{status:'deferred',notBefore};
   }catch{throw new Problem(502,'Mirakl: nie potwierdzono trwałego odroczenia; odczytaj zadanie','MIRAKL_SYNC_STATE_UNCONFIRMED');}
  }
  const reason=readFinished?'PAGE_REJECTED':'READ_FAILED';
  try{await repository.fail(claim,{reason});}catch{throw new Problem(502,'Mirakl: nie potwierdzono zatrzymania synchronizacji; odczytaj zadanie','MIRAKL_SYNC_STATE_UNCONFIRMED');}
  return{status:'failed',reason};
 }
}
