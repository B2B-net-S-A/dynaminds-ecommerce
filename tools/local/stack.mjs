/** Local foreground supervisor. Import is inert; pinned service entrypoints own their business policy. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import {createHash} from 'node:crypto';
import {spawn,execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {assertSameBirth} from './operator.mjs';

const hash=b=>createHash('sha256').update(b).digest('hex');
const own=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===[...keys].sort().join(',');
const canonical=p=>typeof p==='string'&&path.isAbsolute(p)&&path.resolve(p)===p;
const bounded=(n,min,max)=>Number.isSafeInteger(n)&&n>=min&&n<=max;
const ref=r=>own(r,['path','sha256'])&&canonical(r.path)&&/^[a-f0-9]{64}$/.test(r.sha256);
const safe=e=>({code:typeof e?.code==='string'&&/^[A-Z0-9_]{1,50}$/.test(e.code)?e.code:null,message_sha256:hash(String(e?.message??e))});
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const failure=(code)=>Object.assign(new Error(code),{code});
function directory(p){assert(canonical(p)&&fs.realpathSync(p)===p);const s=fs.lstatSync(p);assert(s.isDirectory()&&!s.isSymbolicLink()&&s.uid===process.getuid()&&(s.mode&0o022)===0,'owned-safe-directory-required');}
function privateFile(p,max=65536){
 assert(canonical(p)&&fs.realpathSync(p)===p);const s=fs.lstatSync(p,{bigint:true});
 assert(s.isFile()&&!s.isSymbolicLink()&&s.uid===BigInt(process.getuid())&&s.nlink===1n&&(s.mode&0o777n)===0o600n&&s.size<=BigInt(max),'private-owned-file-required');
 const cut=v=>[v.dev,v.ino,v.mode,v.uid,v.nlink,v.size,v.mtimeNs,v.ctimeNs].join(':');
 const fd=fs.openSync(p,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
 try{assert.equal(cut(fs.fstatSync(fd,{bigint:true})),cut(s));const b=fs.readFileSync(fd);assert.equal(cut(fs.fstatSync(fd,{bigint:true})),cut(s));assert.equal(cut(fs.lstatSync(p,{bigint:true})),cut(s));return b;}finally{fs.closeSync(fd);}
}
function verifyRef(r){
 assert(ref(r));assert.equal(fs.realpathSync(r.path),r.path);const s=fs.lstatSync(r.path,{bigint:true});assert(s.isFile()&&!s.isSymbolicLink()&&s.uid===BigInt(process.getuid())&&(s.mode&0o022n)===0n,'owned-pinned-file-required');
 assert(s.size<=16n*1024n*1024n,'pinned-file-too-large');const cut=v=>[v.dev,v.ino,v.mode,v.uid,v.nlink,v.size,v.mtimeNs,v.ctimeNs].join(':');const fd=fs.openSync(r.path,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
 try{assert.equal(cut(fs.fstatSync(fd,{bigint:true})),cut(s));const bytes=fs.readFileSync(fd);assert.equal(hash(bytes),r.sha256,'pinned-file-changed');assert.equal(cut(fs.fstatSync(fd,{bigint:true})),cut(s));assert.equal(cut(fs.lstatSync(r.path,{bigint:true})),cut(s));return bytes;}finally{fs.closeSync(fd);}
}
const envRef=r=>ref(r)||own(r,['path','kind'])&&canonical(r.path)&&r.kind==='directory';
function verifyEnv(r){if(r.kind==='directory')directory(r.path);else{const bytes=privateFile(r.path);try{assert.equal(hash(bytes),r.sha256);}finally{bytes.fill(0);}}}
export function validateStackProfile(x){
 assert(own(x,['schema','services','startupMs','shutdownMs','logBytes']));assert.equal(x.schema,'dynaminds-local-stack/v1');
 assert(bounded(x.startupMs,100,900000)&&bounded(x.shutdownMs,100,60000)&&bounded(x.logBytes,1024,1048576));
 assert(Array.isArray(x.services)&&x.services.length>=1&&x.services.length<=8);const ids=new Set(),ports=new Set();
 for(const s of x.services){
  assert(own(s,['id','entry','imports','args','cwd','envPaths','files','ports','ready']));assert(typeof s.id==='string'&&/^[a-z][a-z0-9-]{0,31}$/.test(s.id)&&!ids.has(s.id));ids.add(s.id);
  assert(ref(s.entry)&&Array.isArray(s.imports)&&s.imports.length<=2&&s.imports.every(ref));
  assert(Array.isArray(s.args)&&s.args.length<=40&&s.args.every(a=>typeof a==='string'&&a.length<=4096&&!/[\x00\r\n]/.test(a)&&!/^\w+:\/\//.test(a)));
  assert(canonical(s.cwd)&&Array.isArray(s.files)&&s.files.length<=24&&s.files.every(ref));
  assert(own(s.envPaths,Object.keys(s.envPaths))&&Object.keys(s.envPaths).length<=8);
  for(const [key,r] of Object.entries(s.envPaths))assert(/^[A-Z][A-Z0-9_]{0,63}$/.test(key)&&!(/^(?:NODE_|DYLD_|LD_)/.test(key)||['DATABASE_URL','PATH','HOME','TMPDIR'].includes(key))&&envRef(r),'path-environment-only');
  assert(Array.isArray(s.ports)&&s.ports.length>=1&&s.ports.length<=4);
  for(const port of s.ports){assert(bounded(port,1024,65535)&&!ports.has(port),'duplicate-or-invalid-port');ports.add(port);}
  const r=s.ready;assert(own(r,['kind','port','path','status','json','ca']));assert(s.ports.includes(r.port));
  if(r.kind==='tcp')assert(r.path===null&&r.status===null&&r.json===null&&r.ca===null);
  else{assert(['http','https'].includes(r.kind)&&typeof r.path==='string'&&/^\/(?!\/)[^\s#]*$/.test(r.path)&&bounded(r.status,100,599));assert(r.json===null||own(r.json,Object.keys(r.json))&&Object.values(r.json).every(v=>['string','boolean','number'].includes(typeof v)));
   assert(r.kind==='https'?ref(r.ca):r.ca===null);}
 }
 return structuredClone(x);
}
function load(file){const b=privateFile(file);try{return{profile:validateStackProfile(JSON.parse(b)),profile_sha256:hash(b)};}finally{b.fill(0);}}
function birth(pid){
 assert(bounded(pid,2,2147483647));const run=field=>execFileSync('/bin/ps',['-p',String(pid),'-o',field+'='],{encoding:'utf8',timeout:2000,maxBuffer:8192}).trim();
 const uid=Number(run('uid')),started=run('lstart'),command=run('command');assert.equal(uid,process.getuid());assert(started&&command);return{pid,uid,started,command_sha256:hash(command)};
}
function alive(expected){try{assertSameBirth(expected,birth(expected.pid));return true;}catch(e){try{process.kill(expected.pid,0);}catch(gone){if(gone.code==='ESRCH')return false;}throw e;}}
function stateRead(file){
 // State is atomically replaced by this supervisor. Only a replacement of the
 // owned private inode permits another READ; mutable/config errors still refuse.
 for(let attempt=0;attempt<4;attempt++){
  const before=fs.lstatSync(file,{bigint:true});
  try{const b=privateFile(file,131072);try{return JSON.parse(b);}finally{b.fill(0);}}
  catch(first){
   const after=fs.lstatSync(file,{bigint:true});
   const owned=s=>s.isFile()&&!s.isSymbolicLink()&&s.uid===BigInt(process.getuid())&&s.nlink===1n&&(s.mode&0o777n)===0o600n&&s.size<=131072n;
   if(attempt===3||!owned(before)||!owned(after)||(before.dev===after.dev&&before.ino===after.ino))throw first;
  }
 }
 throw failure('STATE_READ_UNCONFIRMED');
}
function writeState(file,value,initial=false){
 const payload=JSON.stringify(value,null,2)+'\n';if(initial){fs.writeFileSync(file,payload,{mode:0o600,flag:'wx'});return;}
 const prior=stateRead(file);assert.equal(prior.profile_sha256,value.profile_sha256);assertSameBirth(prior.supervisor,value.supervisor);
 const tmp=file+'.tmp-'+process.pid;fs.writeFileSync(tmp,payload,{mode:0o600,flag:'wx'});fs.renameSync(tmp,file);
}
function tcp(port){return new Promise(resolve=>{const c=net.connect({host:'127.0.0.1',port});let done=false;const end=ok=>{if(done)return;done=true;c.destroy();resolve(ok);};c.setTimeout(200,()=>end(false));c.once('connect',()=>end(true));c.once('error',()=>end(false));});}
async function portFree(port){
 // Binding, rather than an HTTP404, proves this specific loopback port is available now.
 await new Promise((resolve,reject)=>{const s=net.createServer();s.once('error',()=>reject(failure('PORT_OCCUPIED')));s.listen({host:'127.0.0.1',port,exclusive:true},()=>s.close(e=>e?reject(e):resolve()));});
}
async function probe(r){
 if(r.kind==='tcp')return tcp(r.port);
 const ca=r.kind==='https'?verifyRef(r.ca):undefined;
 return new Promise(resolve=>{let settled=false,timer;const finish=v=>{if(!settled){settled=true;clearTimeout(timer);resolve(v);}};let size=0;const chunks=[];
  const request=(r.kind==='https'?https:http).request({hostname:r.kind==='https'?'localhost':'127.0.0.1',port:r.port,path:r.path,method:'GET',agent:false,...(r.kind==='https'?{ca,servername:'localhost',lookup:(_h,o,cb)=>o?.all?cb(null,[{address:'127.0.0.1',family:4}]):cb(null,'127.0.0.1',4)}:{})},response=>{
   response.on('data',b=>{size+=b.length;if(size>8192){request.destroy();finish(false);}else chunks.push(b);});
   response.once('error',()=>finish(false));response.once('end',()=>{if(response.statusCode!==r.status){finish(false);return;}if(r.json===null){finish(true);return;}try{const x=JSON.parse(Buffer.concat(chunks));finish(Object.entries(r.json).every(([k,v])=>Object.hasOwn(x,k)&&x[k]===v));}catch{finish(false);}});
  });timer=setTimeout(()=>{request.destroy();finish(false);},500);request.once('error',()=>finish(false));request.end();
 });
}
/** Readiness has one whole startup budget, including a successful final probe. */
export async function awaitStackReadiness({probe:once,stopped,startupMs,now=Date.now,wait=pause}){
 const end=now()+startupMs;
 while(!stopped()){
  if(now()>=end)throw failure('READINESS_TIMEOUT');
  const ready=await once();
  if(stopped())return;
  if(now()>end)throw failure('READINESS_TIMEOUT');
  if(ready)return;
  await wait(25);
 }
}
const cleanEnv=()=>Object.fromEntries(['PATH','HOME','TMPDIR','LANG','LC_ALL','LC_CTYPE'].filter(k=>process.env[k]!==undefined).map(k=>[k,process.env[k]]));
export async function startStack(profilePath,statePath){
 assert(canonical(statePath));directory(path.dirname(statePath));assert(!fs.existsSync(statePath),'fresh-state-path-required');
 const {profile:p,profile_sha256}=load(profilePath);const s={schema:'dynaminds-local-stack-state/v1',profile_sha256,supervisor:birth(process.pid),status:'starting',services:[],error:null,cleanup:[],PG_managed:false};
 const children=[];let stopping=false,first,failed=false;
 const remember=e=>{if(!failed){failed=true;first=e;}};
 let wake;const stopped=new Promise(resolve=>{wake=resolve;});const stop=()=>{stopping=true;wake();};
 const outputError=e=>{remember(e);stop();};
 const detach=()=>{process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);process.stdout.removeListener('error',outputError);process.stderr.removeListener('error',outputError);};
 process.on('SIGINT',stop);process.on('SIGTERM',stop);process.stdout.on('error',outputError);process.stderr.on('error',outputError);
 try{writeState(statePath,s,true);}catch(e){detach();throw e;}
 const save=()=>writeState(statePath,s);
 const logs=()=>({bytes:0,hashed_bytes:0,sha:createHash('sha256')});
 const snapshot=c=>({...c.record,stdout:{bytes:c.out.bytes,hashed_bytes:c.out.hashed_bytes,sha256:c.out.sha.copy().digest('hex')},stderr:{bytes:c.err.bytes,hashed_bytes:c.err.hashed_bytes,sha256:c.err.sha.copy().digest('hex')}});
 const update=()=>{s.services=children.map(snapshot);try{save();}catch(e){remember(e);stop();}};
 try{
  // All profiles/refs and all ports are checked before the first child starts.
  for(const service of p.services){directory(service.cwd);for(const r of [service.entry,...service.imports,...service.files,...(service.ready.ca?[service.ready.ca]:[])])verifyRef(r);for(const r of Object.values(service.envPaths))verifyEnv(r);for(const port of service.ports)await portFree(port);}
  for(const service of p.services){
   if(stopping)break;
   const env=cleanEnv();for(const [key,r]of Object.entries(service.envPaths)){verifyEnv(r);env[key]=r.path;}
   for(const r of [service.entry,...service.imports,...service.files])verifyRef(r);for(const port of service.ports)await portFree(port);if(stopping)break;
   const child=spawn(process.execPath,[...service.imports.flatMap(r=>['--import',r.path]),service.entry.path,...service.args],{cwd:service.cwd,env,stdio:['ignore','pipe','pipe']});
   const c={child,record:{id:service.id,birth:null,status:'starting',exit_code:null,signal:null},out:logs(),err:logs(),ended:false,signalled:false};children.push(c);
   const log=(target,b)=>{target.bytes+=b.length;const remaining=p.logBytes-target.hashed_bytes;if(remaining>0){const prefix=b.subarray(0,remaining);target.sha.update(prefix);target.hashed_bytes+=prefix.length;}if(target.bytes>p.logBytes){remember(failure('CHILD_LOG_LIMIT'));stop();}};
   child.stdout.on('data',b=>log(c.out,b));child.stderr.on('data',b=>log(c.err,b));
   for(const stream of [child.stdout,child.stderr])stream.on('error',e=>{remember(e);stop();});
   child.on('error',e=>{remember(e);stop();});
   c.closed=new Promise(resolve=>child.once('close',(code,signal)=>{c.ended=true;c.record.exit_code=code;c.record.signal=signal;c.record.status='closed';if(!stopping){remember(failure('CHILD_EXITED'));stop();}update();resolve();}));
   await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
   c.record.birth=birth(child.pid);update();
   await awaitStackReadiness({probe:()=>probe(service.ready),stopped:()=>stopping||c.ended,startupMs:p.startupMs});
   if(stopping)break;assert(!c.ended,'child-ended-before-readiness');c.record.status='ready';update();
  }
  if(!stopping){s.status='ready';update();process.stdout.write(JSON.stringify({status:'LOCAL_STACK_READY',services:children.map(c=>c.record.id),profile_sha256,statePath})+'\n');await stopped;}
 }catch(e){remember(e);stop();}
 finally{
  stopping=true;s.status='draining';update();const deadline=Date.now()+p.shutdownMs;
  for(const c of [...children].reverse()){
   try{if(!c.ended){if(!c.record.birth)throw failure('CHILD_BIRTH_UNCONFIRMED');if(alive(c.record.birth)&&!c.signalled){c.signalled=true;c.child.kill('SIGTERM');}
    const left=Math.max(0,deadline-Date.now());let timer;try{await Promise.race([c.closed,new Promise((_,reject)=>{timer=setTimeout(()=>reject(failure('SHUTDOWN_UNCONFIRMED')),left);})]);}finally{clearTimeout(timer);}}
    // An observed close ACK confirms cleanup even when execution failed. Keep
    // that failure (and its exit/signal) without inventing a missing close ACK.
    if(c.record.exit_code!==0||c.record.signal!==null)remember(failure('CHILD_EXITED'));
   }catch(e){remember(e);s.cleanup.push({service:c.record.id,...safe(e)});}
  }
  const allClosed=children.every(c=>c.ended);s.status=allClosed?'closed':'close-unconfirmed';s.error=failed?safe(first):null;update();
  detach();
 }
 if(failed)throw first;return{status:'LOCAL_STACK_CLOSED',closed:true,PG_managed:false};
}
export async function stackStatus(profilePath,statePath){
 const {profile:p,profile_sha256}=load(profilePath),s=stateRead(statePath);assert.equal(s.schema,'dynaminds-local-stack-state/v1');assert.equal(s.profile_sha256,profile_sha256);
 if(s.status==='closed')return{status:'CLOSED',error:s.error,cleanup:s.cleanup,PG_managed:false};
 assert(alive(s.supervisor),'stack-supervisor-not-live');const services=[];
 for(const c of s.services){const spec=p.services.find(v=>v.id===c.id);assert(spec,'unknown-state-service');const live=c.birth!==null&&alive(c.birth);services.push({id:c.id,status:c.status,live,ready:live&&await probe(spec.ready)});}
 return{status:s.status,services,PG_managed:false};
}
export async function stopStack(profilePath,statePath){
 const {profile:p,profile_sha256}=load(profilePath),s=stateRead(statePath);assert.equal(s.schema,'dynaminds-local-stack-state/v1');assert.equal(s.profile_sha256,profile_sha256);
 if(s.status==='closed'){assert(!s.error&&s.cleanup.length===0,'previous-close-was-not-clean');return{status:'LOCAL_STACK_CLOSED',already_closed:true,PG_managed:false};}
 assert(alive(s.supervisor),'stack-supervisor-not-live');process.kill(s.supervisor.pid,'SIGTERM');const end=Date.now()+p.shutdownMs+2000;
 while(Date.now()<end){await pause(25);const next=stateRead(statePath);assert.equal(next.profile_sha256,profile_sha256);assertSameBirth(s.supervisor,next.supervisor);if(next.status==='closed'){assert(!next.error&&next.cleanup.length===0,'stack-close-failed');return{status:'LOCAL_STACK_CLOSED',PG_managed:false};}if(next.status==='close-unconfirmed')throw failure('SHUTDOWN_UNCONFIRMED');}
 throw failure('SHUTDOWN_UNCONFIRMED');
}
export async function main(args){assert(args.length===3&&['start','status','stop'].includes(args[0]),'usage-start-status-stop-profile-state');const[mode,file,state]=args;assert(canonical(file)&&canonical(state));return mode==='start'?startStack(file,state):mode==='status'?stackStatus(file,state):stopStack(file,state);}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 // Final CLI writes can also fail after startStack has detached its lifecycle listeners.
 // Retain process-level listeners so an asynchronous EPIPE never bypasses owned cleanup.
 const outputFailed=()=>{process.exitCode=1;};process.stdout.on('error',outputFailed);process.stderr.on('error',outputFailed);
 main(process.argv.slice(2)).then(v=>{process.stdout.write(JSON.stringify(v)+'\n');}).catch(e=>{process.exitCode=1;process.stderr.write(JSON.stringify({status:'LOCAL_STACK_FAILED',...safe(e)})+'\n');});
}
