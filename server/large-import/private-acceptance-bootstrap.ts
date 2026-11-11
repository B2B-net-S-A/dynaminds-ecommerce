/** Acceptance-only private plugin. Export/import never creates an app, database or listener. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdirSync,lstatSync,realpathSync,openSync,writeSync,fsyncSync,closeSync,constants} from 'node:fs';
import {resolve,join} from 'node:path';
import type {FastifyInstance,FastifyRequest} from 'fastify';
import {z} from 'zod';
import {validateSpec} from '../../shared/large-import-dependencies/pim-large-import-core-native-head-codec-backend/state-codec';
import {largeImportCoreConfig} from '../../shared/large-import-dependencies/pim-large-import-http-binding-ui/public-contract';
import {createInstalledOriginalUploadStream} from '../../shared/large-import-dependencies/pim-large-import-write-hook-registry-backend/installed-checker';
import type {createOrdinaryInstalledProducer} from './ordinary-producer';

type Producer=Awaited<ReturnType<typeof createOrdinaryInstalledProducer>>;
type Bound=Awaited<ReturnType<Producer['candidate']['bindOriginal']>>;
type Coordinator=Bound['services']['coordinator'];
type Commands=({[K in Exclude<keyof Coordinator,'prepare'>]:{method:K;args:Parameters<Coordinator[K]> extends [unknown,...infer A]?A:never}}[Exclude<keyof Coordinator,'prepare'>])|{method:'prepare';args:[{jobId:string;config:z.infer<typeof largeImportCoreConfig>}]}|{method:'retainUpload';args:[{spec:ReturnType<typeof validateSpec>},AsyncIterable<Uint8Array>,AbortSignal?]};
export type FixedChecker<H extends object>={registerCandidate(registration:Bound['registration']):Promise<H>;command(handle:H,input:Commands):Promise<unknown>};
const uuid=z.uuid(),hex=z.string().regex(/^[a-f0-9]{64}$/),empty=z.strictObject({}),yes=z.literal(true);
const catalog=z.strictObject({catalog_id:uuid}),job=z.strictObject({catalog_id:uuid,id:uuid}),batch=z.strictObject({catalog_id:uuid,id:uuid,batch:z.string().regex(/^(0|[1-9][0-9]{0,4})$/).transform(Number)});
const prefix='/api/local-acceptance/product-catalogs/:catalog_id/large-import';
const sha=(x:string|Uint8Array)=>createHash('sha256').update(x).digest('hex');
function journal(root:string){assert(resolve(root)===root);mkdirSync(root,{mode:0o700});const st=lstatSync(root);assert(st.isDirectory()&&!st.isSymbolicLink()&&realpathSync(root)===root&&(st.mode&0o777)===0o700&&st.uid===process.getuid!());let n=0;
 return(kind:string,value:unknown)=>{const file=join(root,String(++n).padStart(5,'0')+'-'+kind+'.private.json'),bytes=Buffer.from(JSON.stringify(value)+'\n');assert(bytes.length<=65536,'bootstrap-safe-receipt-bound');const fd=openSync(file,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);let first:unknown;try{let offset=0;while(offset<bytes.length)offset+=writeSync(fd,bytes,offset,bytes.length-offset);fsyncSync(fd);}catch(e){first=e;}try{closeSync(fd);}catch(e){first??=e;}if(first)throw first;return{path:file,sha256:sha(bytes)};};
}
/** Root must mount before app.ready, only on its retained local verification app with normal global auth.
 * No public route/alias is registered or changed. This is private engine acceptance, never public success.
 */
export async function installAuthenticatedBootstrap<H extends object>(app:FastifyInstance,input:{candidate:Producer['candidate'];checker:FixedChecker<H>;outputDirectory:string;tenantId:string;userId:string}){
 const selected={...input,tenantId:uuid.parse(input.tenantId),userId:uuid.parse(input.userId)},save=journal(input.outputDirectory);let busy=false,blocked=false;let lastAcknowledged:{intent:{path:string;sha256:string};result:unknown;sha256:string;bytes:number}|undefined;
 await app.register(async child=>{
  child.addContentTypeParser('application/octet-stream',(_req,payload,done)=>done(null,payload));
  async function execute(req:FastifyRequest,command:(req:FastifyRequest)=>Commands){
   assert(!busy&&!blocked,'bootstrap-busy-or-original-unknown');
   assert(req.currentUser&&req.actor&&req.currentUser.id===req.actor.userId&&req.currentUser.tenant_id===req.actor.tenantId&&req.currentUser.role===req.actor.role,'bootstrap-normal-auth-required');
   assert(req.actor.role==='admin'&&req.actor.tenantId===selected.tenantId&&req.actor.userId===selected.userId,'bootstrap-exact-normal-admin');
   assert(!req.apiScopes||(req.apiScopes.includes('products:read')&&req.apiScopes.includes('products:write')&&req.currentUser.api_key_id===req.actor.apiKeyId),'bootstrap-original-scopes');
   assert(req.url.startsWith('/api/local-acceptance/')&&req.routeOptions.url?.startsWith('/api/local-acceptance/'),'bootstrap-private-route-only');
   const parsed=command(req),safeBody=req.headers['content-type']?.startsWith('application/octet-stream')?{kind:'original-stream-not-materialized'}:{sha256:sha(JSON.stringify(req.body??null))};
   const intent=save('intent',{scope:'private_installed_acceptance',method:req.method,url:req.url,params:req.params,query:req.query,body:safeBody,actor:{tenantId:req.actor.tenantId,userId:req.actor.userId,role:req.actor.role,apiKeyId:req.actor.apiKeyId??null},command:parsed.method});
   busy=true;try{
    const bound=await selected.candidate.bindOriginal(req),handle=await selected.checker.registerCandidate(bound.registration);
    if(parsed.method==='retainUpload')parsed.args[1]=createInstalledOriginalUploadStream(bound.registration.startup,req,parsed.args[2]);
    const value=await selected.checker.command(handle,parsed);
    // Capture known ACK synchronously BEFORE any next await/presentation. No credentials or raw source are serialized.
    const text=JSON.stringify(value)??'null';lastAcknowledged={intent,result:value,sha256:sha(text),bytes:Buffer.byteLength(text)};const ack=save('ack',{scope:'private_installed_acceptance',intent,result_sha256:sha(text),result_bytes:Buffer.byteLength(text),command:parsed.method});
    return{scope:'private_installed_acceptance',public_available:false,ack,result:value};
   }catch(first){blocked=true;try{save('unknown',{intent,command:parsed.method,original_no_repeat:true,ack_received:lastAcknowledged?.intent.path===intent.path,result_sha256:lastAcknowledged?.intent.path===intent.path?lastAcknowledged.sha256:null});}catch{/* Preserve the first real failure; stop further work. */}throw first;}finally{busy=false;}
  }
  const post=(suffix:string,derive:(r:FastifyRequest)=>Commands,bodyLimit=65536)=>child.post(prefix+suffix,{bodyLimit},async(req,reply)=>{reply.header('Cache-Control','no-store');return execute(req,derive);});
  post('/uploads',req=>{catalog.parse(req.params);const q=z.strictObject({upload_key:uuid,spec:z.string().max(8192)}).parse(req.query),spec=validateSpec(JSON.parse(q.spec)),max=spec.format==='csv'?5_000_000:30_000_000;assert((spec.limits?.maxFileBytes??0)>0&&spec.limits!.maxFileBytes!<=max);assert(req.body&&typeof (req.body as any)[Symbol.asyncIterator]==='function','bootstrap-original-upload-stream');const abort=new AbortController();req.raw.once('aborted',()=>abort.abort());if(req.raw.aborted)abort.abort();return{method:'retainUpload',args:[{spec},req.body as AsyncIterable<Uint8Array>,abort.signal]};},30_000_000);
  post('/jobs',req=>{const p=catalog.parse(req.params);empty.parse(req.query);const b=z.strictObject({blob_id:uuid,job_id:uuid,config:largeImportCoreConfig}).parse(req.body);assert(b.config.catalog_id===p.catalog_id);return{method:'prepare',args:[{jobId:b.job_id,config:b.config}]};});
  post('/jobs/:id/file-consent',req=>{const p=job.parse(req.params);empty.parse(req.query);const b=z.strictObject({plan_hash:hex,confirmed:yes}).parse(req.body);return{method:'approve',args:[p.id,b.plan_hash]};});
  post('/jobs/:id/core-review/refresh',req=>{const p=job.parse(req.params);empty.parse(req.query);empty.parse(req.body);return{method:'reviewCoreFile',args:[p.id]};});
  post('/jobs/:id/core-review/consent',req=>{const p=job.parse(req.params);empty.parse(req.query);const b=z.strictObject({scope_hash:hex,confirmed:yes}).parse(req.body);return{method:'consentCoreFile',args:[p.id,b.scope_hash]};});
  for(const phase of ['preview','consent','execute'] as const)post('/jobs/:id/core/:batch/'+phase,req=>{const p=batch.parse(req.params);empty.parse(req.query);if(phase==='preview'){empty.parse(req.body);return{method:'previewCore',args:[p.id,p.batch]};}if(phase==='execute'){z.strictObject({confirmed:yes}).parse(req.body);return{method:'executeCore',args:[p.id,p.batch]};}const b=z.strictObject({preview_id:uuid,scope_hash:hex,confirmed:yes}).parse(req.body);return{method:'consentCore',args:[p.id,p.batch,b.preview_id,b.scope_hash]};});
  post('/jobs/:id/pim/:batch/attempt',req=>{const p=batch.parse(req.params);empty.parse(req.query);const b=z.strictObject({mapping:z.unknown()}).parse(req.body);assert(b.mapping!==undefined);return{method:'newPimAttempt',args:[p.id,p.batch,b.mapping]};});
  for(const phase of ['stage','preview','apply'] as const)post('/jobs/:id/pim/:batch/'+phase,req=>{const p=batch.parse(req.params);empty.parse(req.query);if(phase==='apply')z.strictObject({confirmed:yes}).parse(req.body);else empty.parse(req.body);return{method:phase==='stage'?'stagePim':phase==='preview'?'previewPim':'applyPim',args:[p.id,p.batch]};});
  post('/jobs/:id/pim/:batch/consent',req=>{const p=batch.parse(req.params);empty.parse(req.query);const b=z.strictObject({preview_id:uuid,scope_hash:hex,confirmed:yes}).parse(req.body);return{method:'consentPim',args:[p.id,p.batch,b.preview_id,b.scope_hash]};});
  child.get(prefix+'/jobs/:id',async(req,reply)=>{reply.header('Cache-Control','no-store');const p=job.parse(req.params);empty.parse(req.query);return execute(req,()=>({method:'inspect',args:[p.id]}));});
 });
 return Object.freeze({scope:'private_installed_acceptance' as const,inspect:()=>({busy,blocked,public_available:false as const,ack_received:!!lastAcknowledged}),readLastAcknowledged:()=>lastAcknowledged});
}
