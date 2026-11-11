/** Explicit --run driver for an existing owned local app. No seed, DB or app factory. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {runFullBaseScaleExecutor,validateScaleOperationPorts,SCALE_OPERATIONS,SCALE_SLOTS} from './full-base-scale-executor.mjs';
export const FULL_BASE_SCALE_PROFILE_SHA256='83c76d8373a5eadcb7b733dacb8a9616c2ce848bf49bea7ead9011504a74e873';
export const FULL_BASE_SCALE_CONFIG_SHA256='1ab65a9256b67be9c50fd1ff964a8072d4ce1c4340b6c07900345b8c4926b8a7';
const sha=b=>createHash('sha256').update(b).digest('hex'),digest=s=>typeof s==='string'&&/^[a-f0-9]{64}$/.test(s),uuid=s=>typeof s==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(s);
const PRIVATE_LEDGER_BYTES_MAX=134217728;
const WRITE_KEYS_MAX=Math.floor(PRIVATE_LEDGER_BYTES_MAX/256);
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const keys=(x,list)=>assert(x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).sort().join(',')===[...list].sort().join(','),'exact-input-fields-required');
const absolute=s=>{assert(typeof s==='string'&&path.isAbsolute(s)&&path.resolve(s)===s,'canonical-owned-file-required');return s;};
function ownedBytes(file,limit,privateFile=false){
 absolute(file);assert.equal(fs.realpathSync(file),file);const a=fs.lstatSync(file,{bigint:true});assert(a.isFile()&&!a.isSymbolicLink()&&a.nlink===1n&&a.uid===BigInt(process.getuid())&&a.size<=BigInt(limit));assert(privateFile?(a.mode&0o777n)===0o600n:(a.mode&0o022n)===0n);
 const id=s=>[s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs,s.mode,s.uid,s.nlink].join(':');const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);let failed=false;try{assert.equal(id(fs.fstatSync(fd,{bigint:true})),id(a));const size=Number(a.size),buffer=Buffer.alloc(size+1);let used=0;while(used<buffer.length){const remaining=buffer.length-used,n=fs.readSync(fd,buffer,used,remaining,null);assert(Number.isSafeInteger(n)&&n>=0&&n<=remaining,'scale-input-read-byte-count');if(n===0)break;used+=n;assert(used<=size,'scale-input-grew-during-bounded-read');}assert.equal(used,size,'scale-input-read-size-drift');const b=buffer.subarray(0,used);assert.equal(id(fs.fstatSync(fd,{bigint:true})),id(a));assert.equal(id(fs.lstatSync(file,{bigint:true})),id(a));assert.equal(fs.realpathSync(file),file);return b;}catch(error){failed=true;throw error;}finally{try{fs.closeSync(fd);}catch(error){if(!failed)throw error;}}
}
export function validateFullBaseScalePlan(p){
 keys(p,['schema','run_id','origin','expected_revision','expected_schema','profile','operation_module','bindings','context']);assert.equal(p.schema,'dynaminds-full-base-scale-http-plan/v1');assert(uuid(p.run_id));
 const u=new URL(p.origin);assert(u.protocol==='http:'&&u.hostname==='127.0.0.1'&&!u.username&&!u.password&&!u.search&&!u.hash&&u.pathname==='/'&&String(u.origin)===p.origin&&Number(u.port)>=4101&&Number(u.port)<=4199,'owned-loopback-preview-only-no-Main');assert(digest(p.expected_revision)&&/^\d{3}_[a-z0-9_]+$/.test(p.expected_schema));
 for(const ref of[p.profile,p.operation_module]){keys(ref,['path','bytes','sha256']);absolute(ref.path);assert(Number.isSafeInteger(ref.bytes)&&ref.bytes>0&&digest(ref.sha256));}
 assert.equal(p.profile.sha256,FULL_BASE_SCALE_PROFILE_SHA256);assert(p.profile.bytes<=65536&&p.operation_module.bytes<=262144&&p.operation_module.path.endsWith('.mjs'));
 assert(Array.isArray(p.bindings)&&p.bindings.length===5);assert.deepEqual(p.bindings.map(b=>b.slot),SCALE_SLOTS);for(const b of p.bindings){keys(b,['slot','tenant_id','user_id']);assert(uuid(b.tenant_id)&&uuid(b.user_id));}assert.equal(new Set(p.bindings.map(b=>b.tenant_id)).size,5);assert.equal(new Set(p.bindings.map(b=>b.user_id)).size,5);assert(p.context&&typeof p.context==='object'&&!Array.isArray(p.context));return structuredClone(p);
}
export function validateScaleHttpRequest(value,task,origin){
 keys(value,['method','path','headers','body','client_key']);const r=structuredClone(value);assert(['GET','POST','PATCH','PUT','DELETE'].includes(r.method));assert(typeof r.path==='string'&&r.path.startsWith('/api/')&&r.path.length<=8192&&!r.path.includes('#'));
 const u=new URL(r.path,origin);assert.equal(u.origin,origin);assert(u.pathname.startsWith('/api/')&&!u.username&&!u.password&&!/\/(?:auth|workspaces)(?:\/|$)/.test(u.pathname),'business-route-only');assert(r.path===u.pathname+u.search,'canonical-http-path-required');
 assert(r.headers&&typeof r.headers==='object'&&!Array.isArray(r.headers));for(const[k,v]of Object.entries(r.headers)){assert(['cookie','content-type','idempotency-key','x-request-id'].includes(k)&&typeof v==='string'&&v.length<=8192&&!/[\r\n]/.test(v));}
 assert(typeof r.headers.cookie==='string'&&r.headers.cookie.length>0,'ordinary-session-cookie-required');
 const write=SCALE_OPERATIONS[task.operation]==='write';assert(write?r.method!=='GET':r.method==='GET','actual-operation-class-must-match-request');
 if(write){assert(uuid(r.client_key)&&r.body&&typeof r.body==='object'&&!Array.isArray(r.body));const header=Object.hasOwn(r.headers,'idempotency-key'),body=Object.hasOwn(r.body,'client_key');assert(header||body,'original-client-key-required');if(header)assert.equal(r.headers['idempotency-key'],r.client_key,'header-client-key-conflict');if(body)assert.equal(r.body.client_key,r.client_key,'body-client-key-conflict');assert(r.headers['content-type']==='application/json');}
 else assert(r.client_key===null&&r.body===null);
 const forbidden=(v)=>{if(!v||typeof v!=='object')return;for(const[k,x]of Object.entries(v)){assert(!/(?:password|secret|token|cookie|credential|authorization)/i.test(k),'credential-fields-forbidden-in-business-ledger');forbidden(x);}};forbidden(r.body);
 assert(Buffer.byteLength(JSON.stringify(r.body))<=65536);return r;
}
async function cancelResponseBody(response){try{if(response?.body&&!response.body.locked)await response.body.cancel();}catch{/* Preserve the primary protocol/read failure. */}}
async function bodyBytes(response,limit){
 const parts=[];let n=0,failed=false;assert(response.body&&typeof response.body.getReader==='function','streaming-http-body-required');const reader=response.body.getReader();
 try{for(;;){const {value,done}=await reader.read();if(done)break;n+=value.byteLength;if(n>limit)throw new Error('SCALE_RESPONSE_BYTE_LIMIT');parts.push(Buffer.from(value));}return Buffer.concat(parts,n);}
 catch(first){failed=true;try{await reader.cancel();}catch{}throw first;}
 finally{try{reader.releaseLock();}catch(error){if(!failed)throw error;}}
}
async function jsonResponse(response,onRefusal=()=>{}){
 try{assert((response.headers.get('content-type')??'').toLowerCase().startsWith('application/json'),'json-response-required');const b=await bodyBytes(response,1048576);return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(b));}
 catch(first){try{onRefusal();}catch{}await cancelResponseBody(response);throw first;}
}
function privateWriter(directory){
 absolute(directory);const parent=path.dirname(directory),stat=fs.lstatSync(parent);assert(stat.isDirectory()&&!stat.isSymbolicLink()&&stat.uid===process.getuid()&&(stat.mode&0o022)===0&&fs.realpathSync(parent)===parent);fs.mkdirSync(directory,{mode:0o700});let bytes=0;
 const write=(name,value)=>{const b=Buffer.from(JSON.stringify(value)+'\n');assert(b.length<=8388608&&bytes+b.length<=PRIVATE_LEDGER_BYTES_MAX,'bounded-private-report-required');const fd=fs.openSync(path.join(directory,name),fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);try{fs.writeFileSync(fd,b);fs.fsyncSync(fd);bytes+=b.length;}finally{fs.closeSync(fd);}};
 const fd=fs.openSync(path.join(directory,'events.private.jsonl'),fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);let closed=false,seq=0;
 return{write,event:async event=>{assert(!closed);const b=Buffer.from(JSON.stringify({sequence:++seq,...event})+'\n');assert(b.length<=131072&&bytes+b.length<=PRIVATE_LEDGER_BYTES_MAX,'bounded-private-ledger-required');fs.writeFileSync(fd,b);fs.fsyncSync(fd);bytes+=b.length;},close(){if(!closed){closed=true;fs.closeSync(fd);}}};
}
/** No args is a genuinely inert NOT_RUN. --run is explicit; missing business ports cannot become a read-only substitute. */
export async function runFullBaseScaleDriver(args,{fetcher=globalThis.fetch,loadModule=async(_file,bytes)=>import('data:text/javascript;base64,'+bytes.toString('base64')),clock}={}){
 if(args.length===0)return{status:'PREPARED_NOT_RUN',network_requests:0,scale_acceptance:false,reason:'complete-pinned-local-plan-and-eight-operation-ports-for-five-tenants-required'};
 assert(args.length===4&&args[0]==='--run','usage: --run PLAN_PRIVATE_JSON PLAN_SHA256 NEW_PRIVATE_OUTPUT_DIRECTORY');const[,planFile,planSha,output]=args;assert(digest(planSha));const bytes=ownedBytes(planFile,65536,true);assert.equal(sha(bytes),planSha);const p=validateFullBaseScalePlan(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)));
 const profileBytes=ownedBytes(p.profile.path,65536);assert.equal(profileBytes.length,p.profile.bytes);assert.equal(sha(profileBytes),p.profile.sha256);const profile=JSON.parse(profileBytes);assert.equal(profile.config_sha256,FULL_BASE_SCALE_CONFIG_SHA256);assert.equal(sha(JSON.stringify(canonical(profile.config))),FULL_BASE_SCALE_CONFIG_SHA256);
 const moduleBytes=ownedBytes(p.operation_module.path,262144);assert.equal(moduleBytes.length,p.operation_module.bytes);assert.equal(sha(moduleBytes),p.operation_module.sha256);
 const module=await loadModule(p.operation_module.path,moduleBytes);let ports;try{assert.equal(typeof module.createFullBaseScaleOperations,'function');ports=validateScaleOperationPorts(module.createFullBaseScaleOperations(Object.freeze(structuredClone({origin:p.origin,bindings:p.bindings,context:p.context}))));}catch{return{status:'NOT_RUN_INCOMPLETE_OPERATION_PORTS',network_requests:0,scale_acceptance:false,reason:'all-eight-source-pinned-synchronous-ordinary-operation-ports-for-five-tenants-required'};}
 // This gate is a once-per-plan custody marker, not an approval prompt or native authority.
 const attempt=fs.openSync(planFile+'.attempt.private.json',fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);try{fs.writeFileSync(attempt,JSON.stringify({schema:'full-base-scale-http-attempt/v1',run_id:p.run_id,plan_sha256:planSha,status:'ATTEMPT_STARTED_NO_AUTORETRY'})+'\n');fs.fsyncSync(attempt);}finally{fs.closeSync(attempt);}
 const writer=privateWriter(output),controller=new AbortController(),writeKeys=new Set();const tenantBySlot=new Map(p.bindings.map(b=>[b.slot,b.tenant_id]));let network=0,failed=false;
 const stop=()=>controller.abort(new Error('scale-driver-stop'));process.on('SIGINT',stop);process.on('SIGTERM',stop);
 try{
  writer.write('manifest.private.json',{schema:'full-base-scale-http-executor-manifest/v1',run_id:p.run_id,plan_sha256:planSha,profile_sha256:p.profile.sha256,config_sha256:FULL_BASE_SCALE_CONFIG_SHA256,operation_module_sha256:p.operation_module.sha256,revision:p.expected_revision,schema_revision:p.expected_schema,scope:'http-executor-only',tenant_identity_proof:'OPEN_NOT_VERIFIED_BY_EXECUTOR',dataset_acceptance:false,background_acceptance:false,full_scale_acceptance:false});
  const healthLifetime=new AbortController();try{network++;const healthResponse=await fetcher(p.origin+'/api/health',{redirect:'error',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(10000),healthLifetime.signal])});const health=await jsonResponse(healthResponse,()=>healthLifetime.abort());assert(healthResponse.status===200&&health.status==='ok'&&health.mode==='local'&&health.revision===p.expected_revision&&health.schema_revision===p.expected_schema&&health.restore_preview===false&&health.background_workers_enabled===false&&health.scoped_automation_enabled===true,'exact-local-runtime-health-required');}finally{healthLifetime.abort();}
  const result=await runFullBaseScaleExecutor({config:profile.config,runId:p.run_id,signal:controller.signal,...(clock?{clock}:{}),
   prepare:task=>{const request=validateScaleHttpRequest(ports[task.tenant_slot][task.operation].prepare(task),task,p.origin);if(SCALE_OPERATIONS[task.operation]==='write'){const key=tenantBySlot.get(task.tenant_slot)+':'+request.client_key;assert(!writeKeys.has(key),'fresh-write-client-key-already-used-in-this-tenant');assert(writeKeys.size<WRITE_KEYS_MAX,'bounded-write-key-registry-full');writeKeys.add(key);}return request;},
   onIntent:async(task,request)=>writer.event({event:'intent_before_http',...task,method:request.method,path:request.path,client_key:request.client_key,body:request.body,body_sha256:sha(JSON.stringify(request.body)),headers_redacted:true}),
   execute:async(task,request,signal)=>{const lifetime=new AbortController();let response;try{network++;response=await fetcher(p.origin+request.path,{method:request.method,headers:{...request.headers,'x-request-id':task.request_id},...(request.body===null?{}:{body:JSON.stringify(request.body)}),redirect:'error',signal:AbortSignal.any([signal,lifetime.signal])});await writer.event({event:'http_ack_before_dto',...task,http_status:response.status});let data;try{data=await jsonResponse(response,()=>lifetime.abort());}catch{return{outcome:'failure',reason:'HTTP_PROTOCOL_INVALID',http_status:response.status};}let outcome;try{outcome=ports[task.tenant_slot][task.operation].complete(Object.freeze({task,http_status:response.status,data}));assert(outcome&&typeof outcome.then!=='function','synchronous-complete-no-hidden-http-required');keys(outcome,['outcome','reason']);if(outcome.outcome==='expected_refusal')assert(response.status===409&&typeof outcome.reason==='string'&&outcome.reason.length>0);}catch{return{outcome:'failure',reason:'HTTP_DTO_INVALID',http_status:response.status};}return{...outcome,http_status:response.status};}finally{lifetime.abort();await cancelResponseBody(response);}},
   onSample:async sample=>writer.event({event:'http_terminal',...sample})});
  writer.write('result.private.json',{...result,network_requests:network,tenant_identity_proof:'OPEN_NOT_VERIFIED_BY_EXECUTOR'});return{status:result.status,network_requests:network,tenant_identity_proof:'OPEN_NOT_VERIFIED_BY_EXECUTOR',scale_acceptance:false,report_directory:output};
 }catch(error){failed=true;const report=error?.scaleReport??null;try{writer.write('failure.private.json',{status:'FAILED_HTTP_EXECUTOR_NOT_SCALE_ACCEPTANCE',network_requests:network,cause_name:error instanceof Error?error.name:typeof error,cause_sha256:sha(String(error?.message??'')),report,scale_acceptance:false});}catch{/* Missing receipt remains unconfirmed; preserve the original transport/ledger cause. */}throw error;}
 finally{process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);try{writer.close();}catch(error){if(!failed)throw error;}}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 runFullBaseScaleDriver(process.argv.slice(2)).then(result=>process.stdout.write(JSON.stringify(result)+'\n')).catch(error=>{process.stderr.write(JSON.stringify({status:'FULL_BASE_SCALE_DRIVER_FAILED',name:error instanceof Error?error.name:typeof error,scale_acceptance:false})+'\n');process.exitCode=1;});
}
