/** Explicit local operator only. Import does not read config, connect, start or stop anything. */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawn,execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const sha=b=>createHash('sha256').update(b).digest('hex');
const absolute=s=>{assert(typeof s==='string'&&path.isAbsolute(s)&&path.resolve(s)===s,'absolute-canonical-path-required');return s;};
const safeError=e=>({status:'LOCAL_OPERATOR_FAILED',name:e?.name??'Error',code:typeof e?.code==='string'?e.code:null,message_sha256:sha(String(e?.message??'')),...(e?.log_close_unconfirmed?{log_close_unconfirmed:true}:{}),...(e?.close_unconfirmed?{close_unconfirmed:e.close_unconfirmed}:{}),...(e?.state_close_unconfirmed?{state_close_unconfirmed:e.state_close_unconfirmed}:{})});
const logFailure=code=>Object.assign(new Error(code),{code});
const logLimit=n=>Number.isSafeInteger(n)&&n>=1024&&n<=1048576;
/** Private binary ring: two fixed owned inodes per stream, no unlink/rename or
 * forwarding child payload into launchd's unbounded StandardOut/StandardError. */
export function createBoundedPrivateLogs(directory,segmentBytes=1048576){
 absolute(directory);assert(logLimit(segmentBytes),'bounded-log-segment-required');
 const parent=path.dirname(directory);assert.equal(fs.realpathSync(parent),parent);
 const parentStat=fs.lstatSync(parent);assert(parentStat.isDirectory()&&!parentStat.isSymbolicLink()&&parentStat.uid===process.getuid()&&(parentStat.mode&0o022)===0,'owned-log-parent-required');
 fs.mkdirSync(directory,{mode:0o700});
 const directoryStat=fs.lstatSync(directory,{bigint:true}),same=(a,b)=>a.dev===b.dev&&a.ino===b.ino;
 const streams={},opened=[];let directoryFd,closed=false,firstError,closeUnconfirmed=false;
 const remember=e=>{firstError??=e;};
 const checkDirectory=()=>{
  assert.equal(fs.realpathSync(directory),directory,'log-directory-symlink-refused');
  const s=fs.lstatSync(directory,{bigint:true}),fd=fs.fstatSync(directoryFd,{bigint:true});
  for(const v of[s,fd])assert(v.isDirectory()&&same(v,directoryStat)&&v.uid===BigInt(process.getuid())&&(v.mode&0o777n)===0o700n,'owned-log-directory-changed');
 };
 const checkSlot=slot=>{
  checkDirectory();const linked=fs.lstatSync(slot.path,{bigint:true}),held=fs.fstatSync(slot.fd,{bigint:true});
  for(const s of[linked,held])assert(s.isFile()&&!s.isSymbolicLink()&&same(s,slot.identity)&&s.uid===BigInt(process.getuid())&&s.nlink===1n&&(s.mode&0o777n)===0o600n&&s.size===BigInt(slot.bytes),'owned-log-slot-changed');
 };
 try{
  directoryFd=fs.openSync(directory,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);opened.push(directoryFd);checkDirectory();
  for(const name of['stdout','stderr']){
   const stream={bytes:0,sha:createHash('sha256'),current:0,epoch:0,slots:[]};streams[name]=stream;
   for(let i=0;i<2;i++){
    const file=path.join(directory,name+'.'+i+'.log');checkDirectory();
    const fd=fs.openSync(file,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);opened.push(fd);
    const slot={path:file,fd,identity:fs.fstatSync(fd,{bigint:true}),bytes:0,epoch:i===0?0:null,sha:createHash('sha256')};checkSlot(slot);stream.slots.push(slot);
   }
  }
 }catch(e){for(const fd of opened.reverse())try{fs.closeSync(fd);}catch{e.log_close_unconfirmed=true;}throw e;}
 return Object.freeze({
  write(name,buffer){
   assert(!closed,'log-capture-already-closed');if(firstError)throw firstError;assert(Object.hasOwn(streams,name)&&Buffer.isBuffer(buffer),'binary-owned-log-stream-required');
   try{
    const stream=streams[name];assert(Number.isSafeInteger(stream.bytes+buffer.length),'bounded-log-byte-counter');stream.bytes+=buffer.length;stream.sha.update(buffer);
    let offset=0;while(offset<buffer.length){
     let slot=stream.slots[stream.current];checkSlot(slot);
     if(slot.bytes===segmentBytes){
      stream.current=1-stream.current;slot=stream.slots[stream.current];checkSlot(slot);
      assert(Number.isSafeInteger(stream.epoch+1),'bounded-log-rotation-counter');
      fs.ftruncateSync(slot.fd,0);slot.bytes=0;slot.sha=createHash('sha256');slot.epoch=++stream.epoch;checkSlot(slot);
     }
     const length=Math.min(segmentBytes-slot.bytes,buffer.length-offset);
     const written=fs.writeSync(slot.fd,buffer,offset,length,slot.bytes);
     if(!Number.isInteger(written)||written<=0||written>length)throw logFailure('LOCAL_LOG_WRITE_UNCONFIRMED');
     slot.sha.update(buffer.subarray(offset,offset+written));slot.bytes+=written;offset+=written;checkSlot(slot);
    }
   }catch(e){remember(e);throw firstError;}
  },
  snapshot(){return{schema:'dynaminds-bounded-private-logs/v1',directory,encoding:'binary; UTF-8 may span segment boundaries',segment_bytes:segmentBytes,slots_per_stream:2,retained_bytes_max:4*segmentBytes,close_unconfirmed:closeUnconfirmed,error:firstError?safeError(firstError):null,
   ...Object.fromEntries(Object.entries(streams).map(([name,s])=>[name,{bytes:s.bytes,sha256:s.sha.copy().digest('hex'),current_slot:s.current,retained_bytes:s.slots.reduce((n,v)=>n+v.bytes,0),slots:s.slots.map(v=>({file:path.basename(v.path),bytes:v.bytes,epoch:v.epoch,sha256:v.sha.copy().digest('hex')}))}]))};},
  close(){
   if(!closed){closed=true;for(const fd of opened.reverse())try{fs.closeSync(fd);}catch(e){closeUnconfirmed=true;remember(e);}}
   if(firstError)throw firstError;
  },
 });
}
function privateBytes(file,max=65536,mode=0o600,identity){
 absolute(file);assert.equal(fs.realpathSync(file),file);const before=fs.lstatSync(file,{bigint:true});
 if(identity)assert(before.dev===identity.dev&&before.ino===identity.ino,'invalidated-owned-state-inode-changed');
 assert(before.isFile()&&!before.isSymbolicLink()&&before.nlink===1n&&before.uid===BigInt(process.getuid())&&(before.mode&0o777n)===BigInt(mode)&&before.size<=BigInt(max),'private-owned-regular-file-required');
 const cut=s=>[s.dev,s.ino,s.uid,s.mode,s.nlink,s.size,s.mtimeNs,s.ctimeNs].join(':');const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
 try{assert.equal(cut(fs.fstatSync(fd,{bigint:true})),cut(before));const b=fs.readFileSync(fd);assert.equal(BigInt(b.length),before.size);assert.equal(cut(fs.fstatSync(fd,{bigint:true})),cut(before));assert.equal(cut(fs.lstatSync(file,{bigint:true})),cut(before));return b;}finally{fs.closeSync(fd);}
}
export function validateProfile(value){
 assert(value&&typeof value==='object'&&!Array.isArray(value));
 const required=['schema','selectionPath','selectionSha','releaseDirectory','manifestSha','revision','configurationPath','database','pgPort','httpPort','cwd','imageDirectory','flags'],optional=['installedLargeImportSelection','connectorAccessSelection','localWooSelection','miraklReadState','logBytes'];
 assert(required.every(k=>Object.hasOwn(value,k))&&Object.keys(value).every(k=>required.includes(k)||optional.includes(k)));
 const p=structuredClone(value);assert.equal(p.schema,'dynaminds-local-operator/v1');
 if(Object.hasOwn(p,'logBytes'))assert(logLimit(p.logBytes),'bounded-log-segment-required');
 for(const k of['selectionPath','releaseDirectory','configurationPath','cwd','imageDirectory'])absolute(p[k]);
 for(const k of['selectionSha','manifestSha','revision'])assert(/^[a-f0-9]{64}$/.test(p[k]),'exact-sha-required');
 for(const k of['pgPort','httpPort'])assert(Number.isInteger(p[k])&&p[k]>=1024&&p[k]<=65535,'bounded-local-port-required');assert.notEqual(p.pgPort,p.httpPort);
 assert(/^[a-z][a-z0-9_]*$/.test(p.database));assert(Array.isArray(p.flags)&&p.flags.includes('--verified-stock-writers')&&new Set(p.flags).size===p.flags.length);
 assert(p.flags.every(f=>['--verified-stock-writers','--amazon-mcf-sandbox-eu','--nbp-eur','--scoped-automation','--connector-jobs-sandbox','--local-woo-reads','--local-woo-stock'].includes(f)),'only-reviewed-ordinary-flags');
 for(const[key,pathKey,shaKey]of[['installedLargeImportSelection','path','sha256'],['connectorAccessSelection','file','digest'],['localWooSelection','file','digest']])if(Object.hasOwn(p,key)){const ref=p[key];assert(ref&&typeof ref==='object'&&!Array.isArray(ref));assert.deepEqual(Object.keys(ref).sort(),[pathKey,shaKey].sort());absolute(ref[pathKey]);assert(/^[a-f0-9]{64}$/.test(ref[shaKey]),'exact-private-metadata-pin-required');}
 if(Object.hasOwn(p,'miraklReadState')){const state=p.miraklReadState;assert(state&&typeof state==='object'&&!Array.isArray(state));assert.deepEqual(Object.keys(state),['database']);assert(typeof state.database==='string'&&/^dynaminds_connector_state(?:_test_[0-9]{13})?$/.test(state.database),'mirakl-control-database-required');assert(p.connectorAccessSelection,'mirakl-read-state-requires-connector-access');}
 assert(!p.flags.includes('--local-woo-stock')||p.localWooSelection,'local-Woo-stock-require-selection');
 assert(!p.flags.includes('--local-woo-reads')||p.localWooSelection,'local-Woo-reads-require-selection');
 assert(!p.flags.includes('--connector-jobs-sandbox')||p.connectorAccessSelection,'manual-jobs-require-connector-access');
 return p;
}
export function commandFor(profile){const p=validateProfile(profile);const args=[p.releaseDirectory+'/runtime/server/ordinary-local-cli.mjs',p.selectionPath,p.selectionSha,String(p.httpPort),...p.flags,...(p.installedLargeImportSelection?['--installed-importer-selection='+p.installedLargeImportSelection.sha256+':'+p.installedLargeImportSelection.path]:[]),...(p.connectorAccessSelection?['--connector-access',p.connectorAccessSelection.file,p.connectorAccessSelection.digest]:[]),...(p.localWooSelection?['--local-woo-stores',p.localWooSelection.file,p.localWooSelection.digest]:[]),...(p.miraklReadState?['--mirakl-read-state='+p.miraklReadState.database]:[])];assert(args.length-1<=18||args.length-1===19&&p.flags.includes('--local-woo-stock'),'bounded-ordinary-cli-arguments');return{executable:process.execPath,args,cwd:p.cwd};}
function loadProfile(file){const b=privateBytes(file);try{return{profile:validateProfile(JSON.parse(b)),profile_sha256:sha(b)};}finally{b.fill(0);}}
function preflight(profile){
 const p=validateProfile(profile);for(const name of[p.cwd,p.imageDirectory,p.releaseDirectory])assert(fs.lstatSync(name).isDirectory()&&!fs.lstatSync(name).isSymbolicLink()&&fs.realpathSync(name)===name);
 const selected=privateBytes(p.selectionPath);try{assert.equal(sha(selected),p.selectionSha);const x=JSON.parse(selected);assert.equal(x.releaseDirectory,p.releaseDirectory);assert.equal(x.manifestSha,p.manifestSha);assert.equal(x.revision,p.revision);assert.equal(x.expectedOwner,'postgres');assert.equal(x.localConfigurationPath,p.configurationPath);const u=new URL(x.databaseUrl);assert(['postgres:','postgresql:'].includes(u.protocol)&&['127.0.0.1','localhost','[::1]'].includes(u.hostname)&&u.username==='postgres'&&u.search===''&&u.hash==='');assert.equal(Number(u.port),p.pgPort);assert.equal(u.pathname,'/'+p.database);u.password='';}finally{selected.fill(0);}
 for(const[key,pathKey,shaKey,max]of[['installedLargeImportSelection','path','sha256',65536],['connectorAccessSelection','file','digest',16384],['localWooSelection','file','digest',16384]])if(p[key]){const ref=p[key],bytes=privateBytes(ref[pathKey],max);try{assert.equal(sha(bytes),ref[shaKey]);if(key==='connectorAccessSelection'&&p.miraklReadState){const selected=JSON.parse(bytes);assert(Array.isArray(selected.providers)&&selected.providers.some(v=>v?.provider==='mirakl'),'mirakl-read-state-requires-selected-connector');}}finally{bytes.fill(0);}}
 const cfg=fs.lstatSync(p.configurationPath);assert(cfg.isFile()&&!cfg.isSymbolicLink()&&cfg.uid===process.getuid()&&cfg.nlink===1&&(cfg.mode&0o777)===0o600);assert.equal(fs.realpathSync(p.configurationPath),p.configurationPath);
 const release=fs.readFileSync(p.releaseDirectory+'/release.json');assert.equal(sha(release),p.manifestSha);return commandFor(p);
}
function birth(pid){
 assert(Number.isInteger(pid)&&pid>1);const uid=execFileSync('/bin/ps',['-p',String(pid),'-o','uid='],{encoding:'utf8',timeout:3000,maxBuffer:4096}).trim();assert.equal(Number(uid),process.getuid());
 const started=execFileSync('/bin/ps',['-p',String(pid),'-o','lstart='],{encoding:'utf8',timeout:3000,maxBuffer:4096}).trim();const command=execFileSync('/bin/ps',['-p',String(pid),'-o','command='],{encoding:'utf8',timeout:3000,maxBuffer:8192}).trim();assert(started&&command);return{pid,uid:Number(uid),started,command_sha256:sha(command)};
}
export function assertSameBirth(expected,current){assert.deepEqual(current,expected,'operator-owned-process-birth-mismatch');}
const stateRead=file=>JSON.parse(privateBytes(file));
async function health(p){const r=await fetch('http://127.0.0.1:'+p.httpPort+'/api/health',{signal:AbortSignal.timeout(5000),redirect:'error'});assert.equal(r.status,200);const x=await r.json();assert.equal(x.status,'ok');assert.equal(x.revision,p.revision);if(p.flags.includes('--local-woo-reads')){assert.equal(x.local_woo_reads_enabled,true,'selected-local-Woo-reads-not-enabled');assert.equal(x.local_woo_read_processor_running,true,'selected-local-Woo-read-processor-not-running');}if(p.flags.includes('--local-woo-stock')){assert.equal(x.local_woo_stock_enabled,true,'selected-local-Woo-stock-not-enabled');assert.equal(x.local_woo_stock_processor_running,true,'selected-local-Woo-stock-processor-not-running');assert(Number.isInteger(x.local_woo_stock_blocked_channels)&&x.local_woo_stock_blocked_channels>=0&&x.local_woo_stock_blocked_channels<=5,'selected-local-Woo-stock-health-invalid');}return{status:x.status,revision:x.revision,schema_revision:x.schema_revision,large_import_available:x.large_import_available,...(p.flags.includes('--local-woo-stock')?{local_woo_stock_enabled:true,local_woo_stock_processor_running:true,local_woo_stock_blocked_channels:x.local_woo_stock_blocked_channels}:{}),...(p.flags.includes('--local-woo-reads')?{local_woo_reads_enabled:true,local_woo_read_processor_running:true}:{})};}
function writeInitial(file,state){absolute(file);assert.equal(fs.realpathSync(path.dirname(file)),path.dirname(file));fs.writeFileSync(file,JSON.stringify(state,null,2)+'\n',{mode:0o600,flag:'wx'});}
function writeClosed(file,state,invalidated){
 const prior=JSON.parse(privateBytes(file,65536,invalidated?0o400:0o600,invalidated));assert.equal(prior.profile_sha256,state.profile_sha256);assertSameBirth(prior.birth,state.birth);
 const tmp=file+'.closed-'+process.pid+'-'+state.status;fs.writeFileSync(tmp,JSON.stringify(state,null,2)+'\n',{mode:0o600,flag:'wx'});fs.renameSync(tmp,file);
}
/** If atomic state replacement cannot allocate, revoke ordinary reader access
 * through the existing inode. This is best effort if the filesystem also
 * refuses fchmod; no universal readiness guarantee is possible in that case. */
function invalidateOwnedState(file,state){
 const before=fs.lstatSync(file,{bigint:true}),fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
 const cut=s=>[s.dev,s.ino,s.uid,s.mode,s.nlink,s.size,s.mtimeNs,s.ctimeNs].join(':');
 try{
  assert.equal(cut(fs.fstatSync(fd,{bigint:true})),cut(before));
  const prior=stateRead(file);assert.equal(prior.profile_sha256,state.profile_sha256);assertSameBirth(prior.birth,state.birth);
  assert.equal(cut(fs.lstatSync(file,{bigint:true})),cut(before));assert.equal(cut(fs.fstatSync(fd,{bigint:true})),cut(before));
  fs.fchmodSync(fd,0o400);
  const held=fs.fstatSync(fd,{bigint:true}),linked=fs.lstatSync(file,{bigint:true});
  for(const s of[held,linked])assert(s.isFile()&&!s.isSymbolicLink()&&s.dev===before.dev&&s.ino===before.ino&&s.uid===BigInt(process.getuid())&&s.nlink===1n&&(s.mode&0o777n)===0o400n,'owned-state-invalidation-unconfirmed');
  return{dev:held.dev,ino:held.ino};
 }finally{fs.closeSync(fd);}
}
export async function main(args){
 assert.equal(args.length,3,'usage-command-profile-path-fresh-state-path');const[mode,profilePath,statePath]=args;assert(['start','status','stop'].includes(mode));absolute(statePath);const{profile:p,profile_sha256}=loadProfile(profilePath);
 if(mode==='status'){const state=stateRead(statePath);assert.equal(state.profile_sha256,profile_sha256);if(state.status==='closed')return{status:'CLOSED',exit_code:state.exit_code,signal:state.signal,...(state.error?{error:state.error}:{})};assert(['starting-or-running','draining'].includes(state.status),'owned-process-status-required');assertSameBirth(state.birth,birth(state.birth.pid));if(state.status==='draining')return{status:'DRAINING',pid:state.birth.pid,...(state.error?{error:state.error}:{})};return{status:'RUNNING',...await health(p),pid:state.birth.pid};}
 if(mode==='stop'){const state=stateRead(statePath);assert.equal(state.profile_sha256,profile_sha256);assert(['starting-or-running','draining'].includes(state.status),'owned-process-status-required');assertSameBirth(state.birth,birth(state.birth.pid));if(state.status==='starting-or-running')process.kill(state.birth.pid,'SIGTERM');const end=Date.now()+30000;while(Date.now()<end){await new Promise(r=>setTimeout(r,100));const next=stateRead(statePath);if(next.status==='closed'){assertSameBirth(state.birth,next.birth);assert(next.exit_code===0&&next.signal===null&&!next.error,'owned-child-exited-without-clean-close');return{status:'OWNED_APP_CLOSED',exit_code:next.exit_code,signal:next.signal,postgres_stopped:false};}}throw Error('owned-close-unconfirmed-no-escalation-no-PG-stop');}
 assert(!fs.existsSync(statePath),'fresh-state-path-required');const command=preflight(p);try{const r=await fetch('http://127.0.0.1:'+p.httpPort+'/api/health',{signal:AbortSignal.timeout(1000)});void r;throw Error('HTTP-port-already-served');}catch(e){assert(e instanceof TypeError&&e.cause?.code==='ECONNREFUSED','HTTP-port-not-proven-free');}
 const env={};for(const k of['PATH','HOME','TMPDIR','LANG','LC_ALL','LC_CTYPE','ALLEGRO_SANDBOX_CLIENT_ID','ALLEGRO_SANDBOX_CLIENT_SECRET','ALLEGRO_SANDBOX_REDIRECT_URI'])if(process.env[k]!==undefined)env[k]=process.env[k];env.DYNA_IMAGE_DIR=p.imageDirectory;
 const logs=createBoundedPrivateLogs(statePath+'.logs',p.logBytes??1048576);
 let child,ended,state,forwarded=false,requestedStop=false,first,logWriteFailed=false,stateClosed=false,stateInitialized=false,stateInvalidated;
 const remember=e=>{first??=e;};
 const forward=()=>{
  requestedStop=true;
  // Revoke readiness before signalling, including when a child takes time to
  // drain its pipes. Existing service readiness requires starting-or-running.
  if(stateInitialized&&!stateClosed&&!stateInvalidated&&(state.status!=='draining'||first&&!state.error)){
   const next={...state,status:'draining',logs:logs.snapshot(),error:first?safeError(first):null};
   try{writeClosed(statePath,next);state=next;}catch(e){remember(e);try{stateInvalidated=invalidateOwnedState(statePath,state);}catch(revoke){first.state_close_unconfirmed=safeError(revoke);}}
  }
  if(child?.pid&&state&&!forwarded&&child.exitCode===null&&child.signalCode===null){
   try{assertSameBirth(state.birth,birth(child.pid));forwarded=true;child.kill('SIGTERM');}catch(e){remember(e);}
  }
 };
 const outputError=e=>{remember(e);forward();};
 const closeState=exit=>{writeClosed(statePath,{...state,status:'closed',...exit,logs:logs.snapshot(),error:first?safeError(first):null},stateInvalidated);stateClosed=true;};
 for(const sig of['SIGINT','SIGTERM'])process.on(sig,forward);
 process.stdout.on('error',outputError);process.stderr.on('error',outputError);
 try{
  child=spawn(command.executable,command.args,{cwd:command.cwd,env,stdio:['ignore','pipe','pipe']});
  ended=new Promise(resolve=>child.once('close',(exit_code,signal)=>resolve({exit_code,signal})));
  child.on('error',e=>{remember(e);forward();});
  for(const name of['stdout','stderr']){
   child[name].on('data',buffer=>{if(logWriteFailed)return;try{logs.write(name,buffer);}catch(e){logWriteFailed=true;remember(e);forward();}});
   child[name].on('error',e=>{remember(e);forward();});
  }
  await new Promise((ok,no)=>{child.once('spawn',ok);child.once('error',no);});
  state={schema:'dynaminds-local-operator-owned-process/v1',status:'starting-or-running',profile_sha256,birth:birth(child.pid),httpPort:p.httpPort,revision:p.revision,PG_managed:false,logs:logs.snapshot(),error:null};
  writeInitial(statePath,state);stateInitialized=true;
  if(requestedStop||first)forward();
  process.stdout.write(JSON.stringify({status:'OWNED_APP_STARTING',pid:child.pid,statePath,port:p.httpPort,revision:p.revision})+'\n');
  const exit=await ended;
  try{logs.close();}catch(e){remember(e);}
  closeState(exit);if(first)throw first;
  return{status:exit.exit_code===0&&exit.signal===null?'OWNED_APP_CLOSED':'OWNED_APP_EXITED_UNCONFIRMED',...exit,postgres_stopped:false};
 }catch(error){
  remember(error);
  if(child?.pid&&child.exitCode===null&&child.signalCode===null){
   let timer;try{
    if(!state){state={schema:'dynaminds-local-operator-owned-process/v1',status:'starting-or-running',profile_sha256,birth:birth(child.pid),httpPort:p.httpPort,revision:p.revision,PG_managed:false};}
    forward();
    await Promise.race([ended,new Promise((_,no)=>{timer=setTimeout(()=>no(logFailure('OWNED_CHILD_CLOSE_UNCONFIRMED')),30000);})]);
   }catch(cleanup){first.close_unconfirmed=safeError(cleanup);}finally{clearTimeout(timer);}
  }
  try{logs.close();}catch(e){remember(e);}
  if(!stateClosed&&state&&(child?.exitCode!==null||child?.signalCode!==null)){
   // Preserve actual close metadata even when logging or supervisor output failed.
   if(fs.existsSync(statePath))try{closeState(await ended);}catch(e){first.state_close_unconfirmed=safeError(e);}
  }
  throw first;
 }finally{
  for(const sig of['SIGINT','SIGTERM'])process.removeListener(sig,forward);
  process.stdout.removeListener('error',outputError);process.stderr.removeListener('error',outputError);
 }

}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const outputFailed=()=>{process.exitCode=1;};process.stdout.on('error',outputFailed);process.stderr.on('error',outputFailed);
 main(process.argv.slice(2)).then(x=>{console.log(JSON.stringify(x));if(x.exit_code!==undefined&&x.exit_code!==0||x.signal)process.exitCode=1;}).catch(e=>{console.error(JSON.stringify(safeError(e)));process.exitCode=1;});
}
