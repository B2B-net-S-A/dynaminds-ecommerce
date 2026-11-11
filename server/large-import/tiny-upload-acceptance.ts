/** Private LOCAL acceptance only. Import registers/runs nothing; Root owns the normal app. */
import assert from 'node:assert/strict';
import {createHash}from'node:crypto';
import{constants,mkdirSync,lstatSync,realpathSync,openSync,writeSync,fsyncSync,closeSync}from'node:fs';
import{join,dirname,resolve}from'node:path';
import type{FastifyInstance}from'fastify';
import{z}from'zod';
import{validateSpec}from'../../shared/large-import-dependencies/pim-large-import-core-native-head-codec-backend/state-codec';
import{observeNativeAdmissions}from'../../shared/large-import-dependencies/pim-large-import173-composed-runtime-backend/authority';
import{createInstalledOriginalUploadStream}from'../../shared/large-import-dependencies/pim-large-import-write-hook-registry-backend/installed-checker';
import{inspectRegisteredUpload}from'./registered-filesystem';
import type{createOrdinaryInstalledProducer}from'./ordinary-producer';
import{assertOwnedProducerRoots}from'./ordinary-installed-ports';
import{provisionFreshAcceptanceQuota,type FreshQuotaInput}from'./fresh-quota-genesis';
type Candidate=Awaited<ReturnType<typeof createOrdinaryInstalledProducer>>['candidate'];
const hash=(b:string|Uint8Array)=>createHash('sha256').update(b).digest('hex'),uuid=z.uuid();
const PREFIX='/api/local-acceptance/tiny262';
export const TINY_SPEC=validateSpec({format:'csv',delimiter:',',limits:{maxFileBytes:4096,maxRecords:1,batchRows:1,batchBytes:4096,maxRecordBytes:4096,maxTokenBytes:4096,maxColumns:8,xmlDepth:16,xmlNodes:1000}});
export function tinyCsv262(sku:string){assert(/^PRIVATE-[a-f0-9-]{36}$/.test(sku));const row=(name:string)=>'sku,name,category,attributes_json\n'+[sku,name,'','{}'].map(x=>'"'+x.replaceAll('"','""')+'"').join(',')+'\n';const padding=262-Buffer.byteLength(row(''));assert(padding>0);const bytes=Buffer.from(row('n'.repeat(padding)));assert(bytes.length===262);return bytes;}
function directory(p:string){assert(p===resolve(p)&&realpathSync(p)===p);const s=lstatSync(p);assert(s.isDirectory()&&!s.isSymbolicLink()&&(s.mode&511)===448&&s.uid===process.getuid!());}
function sync(p:string){const f=openSync(p,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);let first:unknown;try{fsyncSync(f);}catch(e){first=e;}try{closeSync(f);}catch(e){first??=e;}if(first)throw first;}
function journal(root:string){directory(dirname(root));mkdirSync(root,{mode:0o700});directory(root);sync(dirname(root));let n=0;return(kind:string,value:unknown)=>{assert(/^[a-z-]+$/.test(kind));const path=join(root,String(++n).padStart(4,'0')+'-'+kind+'.private.json'),b=Buffer.from(JSON.stringify(value)+'\n');assert(b.length<=65536);const f=openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);let first:unknown;try{let at=0;while(at<b.length)at+=writeSync(f,b,at,b.length-at);fsyncSync(f);}catch(e){first=e;}try{closeSync(f);}catch(e){first??=e;}if(first)throw first;sync(root);return{path,sha256:hash(b)};};}
const safe=(e:unknown)=>{const x=e as{name?:unknown;code?:unknown};return{name:typeof x?.name==='string'?x.name:'Error',code:typeof x?.code==='string'?x.code:null};};
/** Mount BEFORE app.ready/first inject, on the separately owned normal auth test app. */
export async function installTinyUploadAcceptance(app:FastifyInstance,input:{candidate:Candidate;genesis:Omit<FreshQuotaInput,'original'>;catalogId:string;uploadKey:string;expectedCsvSha256:string;outputDirectory:string}){
 const candidate=input.candidate,genesis={...input.genesis,profile:structuredClone(input.genesis.profile),roots:{...input.genesis.roots}},catalogId=uuid.parse(input.catalogId),uploadKey=uuid.parse(input.uploadKey),expectedSha=z.string().regex(/^[a-f0-9]{64}$/).parse(input.expectedCsvSha256);
 assert(candidate.startup===genesis.startup);assertOwnedProducerRoots(candidate,genesis.startup,genesis.roots.raw,genesis.roots.controlPlane);const save=journal(input.outputDirectory);let genesisAttempted=false,enrolled=false,uploadAttempted=false;
 await app.register(async child=>{
  child.addContentTypeParser('application/octet-stream',(_req,payload,done)=>done(null,payload));
  child.post(PREFIX+'/quota',async req=>{assert(!genesisAttempted&&!enrolled);genesisAttempted=true;assertOwnedProducerRoots(candidate,genesis.startup,genesis.roots.raw,genesis.roots.controlPlane);save('quota-intent',{tenant_id:genesis.profile.tenant_id,user_id:genesis.profile.user_id});try{const result=await provisionFreshAcceptanceQuota({...genesis,original:req});enrolled=true;save('quota-ack',{receipt:result.receipt});return{scope:'private_fresh_quota',committed:true,public_available:false};}catch(e){try{save('quota-failure',{error:safe(e),original_attempted:true});}catch{}throw e;}});
  child.post(PREFIX+'/product-catalogs/:catalog_id/large-import/uploads',{bodyLimit:4096},async req=>{
   assert(enrolled&&!uploadAttempted,'tiny-one-enrolled-original-only');uploadAttempted=true;
   const p=z.strictObject({catalog_id:uuid}).parse(req.params),q=z.strictObject({upload_key:uuid,spec:z.string().max(8192)}).parse(req.query);assert(p.catalog_id===catalogId&&q.upload_key===uploadKey);const spec=validateSpec(JSON.parse(q.spec));assert.deepEqual(spec,TINY_SPEC);
   assert(req.body&&typeof(req.body as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]==='function');const abort=new AbortController();req.raw.once('aborted',()=>abort.abort());if(req.raw.aborted)abort.abort();
   save('upload-intent',{catalog_id:catalogId,upload_key:uploadKey,bytes:262,source_sha256:expectedSha});const start=performance.now();
   try{const observed=await observeNativeAdmissions(async()=>{
    const bound=await candidate.bindOriginal(req);assert(bound.registration.startup===candidate.startup&&bound.actor.role==='admin'&&!bound.actor.apiKeyId&&bound.actor.tenantId===genesis.profile.tenant_id&&bound.actor.userId===genesis.profile.user_id);
    const b=inspectRegisteredUpload(bound.services.upload,bound.services.uploads,bound.registration.filesystem,bound.actor,req);assert(b.requestId===uploadKey&&b.catalogId===catalogId);
    const chunks=createInstalledOriginalUploadStream(bound.registration.startup,req,abort.signal);
    return bound.services.uploads.once(b.requestId,b.catalogId,()=>bound.services.upload.retain(bound.actor,{spec},chunks,abort.signal));
   });
   if(observed.failed)throw observed.error;assert(observed.value);const elapsed=performance.now()-start,value=observed.value;
   assert(value.schema==='retained-large-import-upload/v1'&&value.status==='UPLOAD_RETAINED_READY_NOT_NATIVE_APPROVED'&&value.raw.byte_count===262&&value.raw.sha256===expectedSha&&value.manifest.records===1&&value.manifest.total_batches===1);
   for(const a of observed.results)assert(a.original===req&&a.tenantId===genesis.profile.tenant_id&&a.userId===genesis.profile.user_id&&a.apiKeyId===null&&a.writing===true);
   const timing={engine_request_ms:elapsed,successful_direct_admissions:observed.results.length,admission_scope:'successful actual admitLargeImport173 calls in SAME async request; excludes nestedSQL/failedcalls/rootcounts',measured_target_claim:false};
   save('upload-ack',{status:value.status,raw:value.raw,manifest_records:1,timing});return{scope:'private_tiny262',public_available:false,result:value,timing};
   }catch(e){try{save('upload-failure',{error:safe(e),engine_request_ms:performance.now()-start,acknowledged:false,no_retry:true});}catch{}throw e;}
  });
 });return Object.freeze({inspect:()=>({genesisAttempted,enrolled,uploadAttempted,public_available:false as const})});
}
/** Credentials remain RAM-only. Root supplies NEW genuine signup/catalog ACK IDs, normal app and mounted plugin. */
export async function runTinyUpload262(input:{app:Pick<FastifyInstance,'inject'>;credentials:{email:string;password:string};tenantId:string;userId:string;catalogId:string;uploadKey:string;sku:string;outputDirectory:string}){
 const app={inject:input.app.inject.bind(input.app)},credentials=structuredClone(input.credentials),ids={tenantId:uuid.parse(input.tenantId),userId:uuid.parse(input.userId),catalogId:uuid.parse(input.catalogId),uploadKey:uuid.parse(input.uploadKey)},bytes=tinyCsv262(input.sku),save=journal(input.outputDirectory);assert(credentials.password.length>=12);let cookie:string|undefined,first:unknown,uploadAck:unknown,loginAttempted=false,loginResponseObserved=false,logoutAcknowledged=false;const cleanup:ReturnType<typeof safe>[]=[];
 const send=async(label:string,url:string,payload:unknown,contentType='application/json')=>{save('request-intent',{label,method:'POST',path:url.split('?')[0]});const start=performance.now();if(label==='login')loginAttempted=true;const r=await app.inject({method:'POST',url,headers:{...(cookie?{cookie}:{}),'content-type':contentType},payload:payload as any});const duration=performance.now()-start;if(label==='login'){loginResponseObserved=true;const headers=r.headers['set-cookie'];const selected=(Array.isArray(headers)?headers:[headers]).find(x=>typeof x==='string'&&x.startsWith('dyna_session='));if(typeof selected==='string')cookie=selected.split(';')[0];}save('request-ack',{label,status:r.statusCode,whole_inject_request_ms:duration});assert(r.statusCode===200||r.statusCode===201,'tiny-normal-request-refused');return{response:r,value:r.json(),duration};};
 try{
  await send('login','/api/auth/login',credentials);assert(cookie,'tiny-normal-login-cookie-missing');
  const me=await app.inject({method:'GET',url:'/api/auth/me',headers:{cookie}});assert(me.statusCode===200);const who=me.json();assert(who.user?.id===ids.userId&&who.user?.tenant_id===ids.tenantId&&who.restore_preview===false);
  const enrolled=await send('fresh-quota',PREFIX+'/quota',{});assert(enrolled.value.committed===true&&enrolled.value.public_available===false);
  const path=PREFIX+'/product-catalogs/'+ids.catalogId+'/large-import/uploads?upload_key='+ids.uploadKey+'&spec='+encodeURIComponent(JSON.stringify(TINY_SPEC));
  const upload=await send('tiny262',path,bytes,'application/octet-stream');assert(upload.value.scope==='private_tiny262'&&upload.value.result.raw.sha256===hash(bytes)&&upload.value.result.raw.byte_count===262);uploadAck={source_sha256:hash(bytes),byte_count:262,whole_inject_request_ms:upload.duration,engine_timing:upload.value.timing};
 }catch(e){first=e;}finally{bytes.fill(0);credentials.password='';if(cookie)try{save('logout-intent',{method:'POST',path:'/api/auth/logout'});const r=await app.inject({method:'POST',url:'/api/auth/logout',headers:{cookie},payload:{}});assert(r.statusCode===200);logoutAcknowledged=true;save('logout-ack',{status:r.statusCode});}catch(e){cleanup.push(safe(e));first??=e;}cookie=undefined;}
 let receipt:ReturnType<typeof save>|undefined;try{receipt=save('result',{status:first?'FAILED':'TINY262_RETAINED_OBSERVED',upload_ack:uploadAck??null,first_error:first?safe(first):null,cleanup,auth_cleanup_unavailable:loginAttempted&&!logoutAcknowledged,unknown_login_result:loginAttempted&&!loginResponseObserved,public_available:false,no_retry:true});}catch(e){first??=e;}if(first)throw Object.assign(new Error('tiny262-driver-failed'),{cause:first,receipt});return{receipt,uploadAck,public_available:false as const};
}
