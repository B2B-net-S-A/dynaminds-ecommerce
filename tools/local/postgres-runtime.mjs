/** Owned existing PostgreSQL18 runtime. Import-inert; no initdb, adoption,
 * embedded-postgres hooks, automatic restart, SQL writes or kill escalation.
 * CLI: prepare DRAFT SHA FRESH_PROFILE | start/status/stop PROFILE SHA STATE.
 * An independently created ownership marker is mandatory, including the actual
 * system identifier and the original own-initialization receipt. Prepare does
 * not mint that evidence and cannot turn an arbitrary data directory into one.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {spawn,execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {createBoundedPrivateLogs} from './operator.mjs';

const require=createRequire(import.meta.url),hash=b=>createHash('sha256').update(b).digest('hex');
const fault=code=>Object.assign(new Error(code),{code});
const canonical=p=>typeof p==='string'&&path.isAbsolute(p)&&path.resolve(p)===p&&!/[\x00-\x1f\x7f]/.test(p);
const digest=s=>typeof s==='string'&&/^[a-f0-9]{64}$/.test(s);
const exact=(x,keys)=>assert(x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).sort().join('|')===[...keys].sort().join('|'),'exact-object-required');
const bounded=(x,min,max)=>Number.isSafeInteger(x)&&x>=min&&x<=max;
const cut=s=>[s.dev,s.ino,s.mode,s.uid,s.nlink,s.size,s.mtimeNs,s.ctimeNs].join(':');
const safe=e=>{try{return{code:typeof e?.code==='string'&&/^[A-Z0-9_]{1,50}$/.test(e.code)?e.code:null,message_sha256:hash(String(e?.message??e))};}catch{return{code:null,message_sha256:hash('unreadable-error')};}};
function ownedDirectory(p,privateOnly=false){
 assert(canonical(p)&&fs.realpathSync(p)===p,'canonical-owned-directory');const s=fs.lstatSync(p,{bigint:true});
 assert(s.isDirectory()&&!s.isSymbolicLink()&&s.uid===BigInt(process.getuid())&&(privateOnly?(s.mode&0o777n)===0o700n:(s.mode&0o022n)===0n),'owned-directory-mode');return s;
}
function readFile(file,max,{privateOnly=false,expected,alias=false}={}){
 assert(canonical(file),'canonical-file');const resolved=fs.realpathSync(file);if(!alias)assert.equal(resolved,file,'file-alias-refused');
 const before=fs.lstatSync(resolved,{bigint:true});assert(before.isFile()&&!before.isSymbolicLink()&&before.nlink===1n&&before.uid===BigInt(process.getuid())&&before.size<=BigInt(max)&&(privateOnly?(before.mode&0o777n)===0o600n:(before.mode&0o022n)===0n),'owned-bounded-file');
 const fd=fs.openSync(resolved,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);let failed=false;
 try{
  assert.equal(cut(fs.fstatSync(fd,{bigint:true})),cut(before));const b=Buffer.alloc(Number(before.size)+1);let n=0;
  while(n<b.length){const k=fs.readSync(fd,b,n,b.length-n,n);if(!k)break;n+=k;assert(n<=Number(before.size),'file-grew');}
  assert.equal(BigInt(n),before.size);assert.equal(cut(fs.fstatSync(fd,{bigint:true})),cut(before));assert.equal(cut(fs.lstatSync(resolved,{bigint:true})),cut(before));assert.equal(fs.realpathSync(file),resolved);
  const bytes=b.subarray(0,n);if(expected){assert.equal(bytes.length,expected.bytes);assert.equal(hash(bytes),expected.sha256,'file-pin-drift');}return bytes;
 }catch(error){failed=true;throw error;}finally{try{fs.closeSync(fd);}catch(error){if(!failed)throw error;}}
}
function jsonFile(file,max=65536,expected){
 let bytes;try{bytes=readFile(file,max,{privateOnly:true,expected});return JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(bytes));}
 catch{throw fault('PRIVATE_INPUT_INVALID');}finally{bytes?.fill(0);}
}
function pin(r){exact(r,['path','sha256','bytes']);assert(canonical(r.path)&&digest(r.sha256)&&bounded(r.bytes,1,65536),'private-pin-required');}
export function validatePostgresProfile(input){
 exact(input,['schema','uid','platform','arch','root','dataDirectory','port','systemIdentifier','version','ownerMarker','credentials','configuration','runtime','startupMs','shutdownMs','logBytes']);
 const p=structuredClone(input);assert.equal(p.schema,'dynaminds-owned-postgres-runtime/v1');assert(p.platform==='darwin'&&p.arch==='arm64','reviewed-platform-required');
 assert(bounded(p.uid,1,2147483647)&&canonical(p.root)&&p.dataDirectory===p.root+'/data'&&bounded(p.port,1024,65535));
 assert(typeof p.systemIdentifier==='string'&&/^[1-9][0-9]{0,19}$/.test(p.systemIdentifier)&&BigInt(p.systemIdentifier)<=18446744073709551615n&&/^18\.[0-9]+$/.test(p.version));
 assert(bounded(p.startupMs,100,120000)&&bounded(p.shutdownMs,100,60000)&&bounded(p.logBytes,1024,1048576));
 pin(p.ownerMarker);pin(p.credentials);assert.equal(p.ownerMarker.path,p.root+'/ownership.private.json');assert.equal(p.credentials.path,p.root+'/credentials.private.json');
 assert(Array.isArray(p.configuration)&&p.configuration.length===4);p.configuration.forEach(pin);
 assert.deepEqual(p.configuration.map(r=>r.path).sort(),['postgresql.conf','postgresql.auto.conf','pg_hba.conf','pg_ident.conf'].map(n=>p.dataDirectory+'/'+n).sort());
 exact(p.runtime,['directory','libraryDirectory','manifest','postgres','files']);assert(canonical(p.runtime.directory)&&p.runtime.libraryDirectory===p.runtime.directory+'/lib');pin(p.runtime.manifest);
 assert(Array.isArray(p.runtime.files)&&p.runtime.files.length>=2&&p.runtime.files.length<=128);const names=new Set();let total=0;
 for(const f of [p.runtime.postgres,...p.runtime.files]){
  exact(f,['path','realPath','bytes','sha256','loaded']);assert(canonical(f.path)&&canonical(f.realPath)&&f.path.startsWith(p.runtime.directory+'/')&&digest(f.sha256)&&bounded(f.bytes,1,64*1024*1024)&&typeof f.loaded==='boolean'&&!names.has(f.path));names.add(f.path);total+=f.bytes;
 }
 assert(total<=256*1024*1024,'bounded-external-runtime');assert.equal(p.runtime.postgres.path,p.runtime.directory+'/bin/postgres');assert(p.runtime.postgres.loaded);
 for(const name of ['libcrypto.3.dylib','libssl.3.dylib'])assert(p.runtime.files.some(f=>f.path===p.runtime.libraryDirectory+'/'+name&&f.loaded),'required-crypto-runtime-pin');
 return p;
}
function runtimeFiles(p){
 ownedDirectory(p.runtime.directory);ownedDirectory(p.runtime.libraryDirectory);readFile(p.runtime.manifest.path,65536,{privateOnly:true,expected:p.runtime.manifest});
 for(const f of [p.runtime.postgres,...p.runtime.files]){
  assert.equal(fs.realpathSync(f.path),f.realPath,'runtime-link-target-drift');const linked=fs.lstatSync(f.path,{bigint:true});assert(linked.uid===BigInt(process.getuid())&&(linked.mode&0o022n)===0n||linked.isSymbolicLink()&&linked.uid===BigInt(process.getuid()),'owned-runtime-link');
  // Stream real dependency targets, including shared libraries larger than the
  // app's16MiB resource limit. This separate256MiB closure never changes it.
  const before=fs.lstatSync(f.realPath,{bigint:true});assert(before.isFile()&&!before.isSymbolicLink()&&before.uid===BigInt(process.getuid())&&(before.mode&0o022n)===0n&&before.size===BigInt(f.bytes),'runtime-file-metadata');
  const fd=fs.openSync(f.realPath,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);let failed=false;
  try{assert.equal(cut(fs.fstatSync(fd,{bigint:true})),cut(before));const buffer=Buffer.alloc(65536),h=createHash('sha256');let count=0;
   for(;;){const n=fs.readSync(fd,buffer,0,Math.min(buffer.length,f.bytes-count+1),count);if(!n)break;count+=n;assert(count<=f.bytes,'runtime-file-grew');h.update(buffer.subarray(0,n));}
   assert.equal(count,f.bytes);assert.equal(h.digest('hex'),f.sha256);assert.equal(cut(fs.fstatSync(fd,{bigint:true})),cut(before));assert.equal(cut(fs.lstatSync(f.realPath,{bigint:true})),cut(before));assert.equal(fs.realpathSync(f.path),f.realPath);
  }catch(error){failed=true;throw error;}finally{try{fs.closeSync(fd);}catch(error){if(!failed)throw error;}}
 }
}
function dataIdentity(p,{stopped=false}={}){
 const root=ownedDirectory(p.root,true),data=ownedDirectory(p.dataDirectory,true);assert.equal(root.uid,data.uid);
 const marker=jsonFile(p.ownerMarker.path,65536,p.ownerMarker);
 exact(marker,['schema','uid','dataDirectory','dataDev','dataIno','systemIdentifier','major','initialization']);pin(marker.initialization);
 assert(marker.schema==='dynaminds-owned-initialized-postgres/v1'&&marker.uid===p.uid&&marker.dataDirectory===p.dataDirectory&&marker.dataDev===String(data.dev)&&marker.dataIno===String(data.ino)&&marker.systemIdentifier===p.systemIdentifier&&marker.major==='18','independent-owner-marker-required');
 assert.equal(marker.initialization.path,p.root+'/intent.private.json');const intent=jsonFile(marker.initialization.path,65536,marker.initialization);
 assert(['dynaminds-owned-accelerated-pg209-bootstrap/v1','dynaminds-owned-postgres-initialization/v1'].includes(intent.schema)&&intent.root===p.root&&intent.uid===p.uid&&intent.port===p.port&&intent.own_cluster_only===true&&intent.existing_cluster_mutation===false,'own-initialization-receipt-required');
 assert.equal(readFile(p.dataDirectory+'/PG_VERSION',16,{privateOnly:true}).toString(),'18\n');
 // PG18 ControlFileData starts uint64 SID,uint32 version,uint32 catalog,
 // DBState. Darwinarm64 is little endian; PostgreSQL itself checks its CRC.
 // Official source: postgres/REL_18_STABLE/src/include/catalog/pg_control.h.
 const control=readFile(p.dataDirectory+'/global/pg_control',8192,{privateOnly:true});assert.equal(control.length,8192);assert.equal(control.readUInt32LE(8),1800);assert.equal(control.readBigUInt64LE(0).toString(),p.systemIdentifier,'offline-system-identifier');
 if(stopped){assert.equal(control.readUInt32LE(16),1,'confirmed-clean-shutdown-required');assert(!fs.existsSync(p.dataDirectory+'/postmaster.pid'),'existing-postmaster-refused');}
 return marker;
}
function verifyProfileFiles(p,{stopped=false}={}){
 assert.equal(p.uid,process.getuid());dataIdentity(p,{stopped});runtimeFiles(p);
 for(const r of p.configuration){const b=readFile(r.path,65536,{privateOnly:true,expected:r}),text=new TextDecoder('utf8',{fatal:true}).decode(b);assert(!/^\s*include(?:_if_exists|_dir)?(?:\s|=)/mi.test(text),'unpinned-config-include-refused');}
 const credentials=jsonFile(p.credentials.path,16384,p.credentials);exact(credentials,['user','database','password']);assert(credentials.user==='postgres'&&credentials.database==='postgres'&&typeof credentials.password==='string'&&credentials.password.length>=16&&credentials.password.length<=4096,'private-existing-credentials-required');return credentials;
}
function loadProfile(file,sha){
 assert(digest(sha));let bytes;
 try{bytes=readFile(file,65536,{privateOnly:true});assert.equal(hash(bytes),sha,'profile-drift');return validatePostgresProfile(JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(bytes)));}
 catch{throw fault('PRIVATE_PROFILE_INVALID');}finally{bytes?.fill(0);}
}
function syncDirectory(dir){const fd=fs.openSync(dir,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);let failed=false;try{fs.fsyncSync(fd);}catch(error){failed=true;throw error;}finally{try{fs.closeSync(fd);}catch(error){if(!failed)throw error;}}}
function durable(file,value,fresh=false){
 ownedDirectory(path.dirname(file),true);const target=fresh?file:file+'.tmp-'+process.pid;let fd,first;
 const bytes=Buffer.from(JSON.stringify(value,null,2)+'\n');assert(bytes.length<=131072,'bounded-private-state');
 try{fd=fs.openSync(target,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}catch(error){first=error;}
 if(fd!==undefined)try{fs.closeSync(fd);}catch(error){first??=error;}if(first)throw first;
 if(!fresh)fs.renameSync(target,file);syncDirectory(path.dirname(file));
}
function birth(pid){
 const field=name=>execFileSync('/bin/ps',['-p',String(pid),'-o',name+'='],{encoding:'utf8',timeout:2000,maxBuffer:8192}).trim();
 const uid=Number(field('uid')),started=field('lstart'),command=field('command');assert(uid===process.getuid()&&started&&command);return{pid,uid,started,command_sha256:hash(command)};
}
function sameBirth(a,b){
 if(!a||!b||['pid','uid','started','command_sha256'].some(k=>a[k]!==b[k])||Object.keys(a).length!==4||Object.keys(b).length!==4)throw fault('OWNED_PROCESS_BIRTH_MISMATCH');
}
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export function postgresCommand(input){
 const p=validatePostgresProfile(input);return{command:p.runtime.postgres.path,args:['-D',p.dataDirectory,'-p',String(p.port),'-h','127.0.0.1','-k','',
  '-c','data_directory='+p.dataDirectory,'-c','config_file='+p.dataDirectory+'/postgresql.conf','-c','hba_file='+p.dataDirectory+'/pg_hba.conf','-c','ident_file='+p.dataDirectory+'/pg_ident.conf',
  '-c','jit=off','-c','default_toast_compression=lz4','-c','timezone=UTC','-c','lc_messages=C','-c','logging_collector=off','-c','log_destination=stderr'],cwd:p.root};
}
function writePublic(stream,value){return new Promise((resolve,reject)=>{
 const onError=error=>reject(error);stream.once('error',onError);
 try{stream.write(JSON.stringify(value)+'\n',error=>{if(error)reject(error);else{stream.removeListener('error',onError);resolve();}});}
 catch(error){stream.removeListener('error',onError);reject(error);}
});}
const system={platform:process.platform,arch:process.arch,uid:process.getuid?.(),selfPid:process.pid,now:()=>performance.now(),wait,
 on:(event,fn)=>process.on(event,fn),off:(event,fn)=>process.removeListener(event,fn),birth,
 signalSupervisor:pid=>process.kill(pid,'SIGTERM'),
 portFree:port=>new Promise((resolve,reject)=>{const s=net.createServer();s.once('error',reject);s.listen({host:'127.0.0.1',port,exclusive:true},()=>s.close(error=>error?reject(error):resolve()));}),
 spawn:(p,env)=>{const command=postgresCommand(p);return spawn(command.command,command.args,{cwd:command.cwd,env,stdio:['ignore','pipe','pipe']});},
 client:(p,credentials)=>new(require('pg').Client)({host:'127.0.0.1',port:p.port,user:credentials.user,database:credentials.database,password:credentials.password,connectionTimeoutMillis:5000,options:'-c jit=off -c statement_timeout=8000 -c lock_timeout=8000 -c timezone=UTC',application_name:'dynaminds-owned-pg-runtime'}),
 loadedPaths:pid=>new Set(execFileSync('/usr/sbin/lsof',['-p',String(pid),'-Fn'],{encoding:'utf8',timeout:3000,maxBuffer:4194304}).split('\n').filter(l=>l.startsWith('n')).map(l=>l.slice(1))),
 report:value=>writePublic(process.stdout,value),
};
const portsFor=ports=>({...system,...ports});
function stateLocation(p,file){assert(canonical(file)&&path.dirname(file)===p.root&&!['ownership.private.json','credentials.private.json','intent.private.json'].includes(path.basename(file)),'private-state-under-owned-root-required');}
async function identity(client,p){
 const row=(await client.query("SELECT current_database() database,current_user owner,host(inet_server_addr()) address,inet_server_port() port,current_setting('server_version') version,current_setting('data_directory') data_directory,current_setting('jit') jit,current_setting('default_toast_compression') toast,system_identifier::text system_identifier FROM pg_control_system()")).rows[0];
 assert(row&&row.database==='postgres'&&row.owner==='postgres'&&row.address==='127.0.0.1'&&row.port===p.port&&row.version===p.version&&row.data_directory===p.dataDirectory&&row.jit==='off'&&row.toast==='lz4'&&row.system_identifier===p.systemIdentifier,'actual-postgres-identity-required');return row;
}
function postmasterIdentity(p,pid){
 const lines=readFile(p.dataDirectory+'/postmaster.pid',4096,{privateOnly:true}).toString('utf8').split('\n');
 assert(lines[0]===String(pid)&&lines[1]===p.dataDirectory&&lines[3]===String(p.port)&&lines[5]==='127.0.0.1','owned-postmaster-pid-required');
}
function loadedRuntime(p,paths){
 for(const f of [p.runtime.postgres,...p.runtime.files].filter(f=>f.loaded))assert(paths.has(f.realPath)||paths.has(f.path),'actual-loaded-runtime-pin-required');
 const permitted=new Set([p.runtime.postgres,...p.runtime.files].flatMap(f=>[f.path,f.realPath]));
 for(const file of paths)if(/\.(?:dylib|so|bundle)$/.test(file)&&!file.startsWith('/usr/lib/')&&!file.startsWith('/System/Library/'))assert(permitted.has(file),'unreviewed-loaded-library');
}

export async function preparePostgresProfile(draft,digest,output){
 assert(canonical(output)&&!fs.existsSync(output),'fresh-prepared-profile-required');const p=loadProfile(draft,digest);assert(process.platform===p.platform&&process.arch===p.arch,'reviewed-local-platform');assert.equal(path.dirname(output),p.root,'prepared-profile-under-owned-root');verifyProfileFiles(p,{stopped:true});durable(output,p,true);
 return{status:'OWNED_POSTGRES_PROFILE_PREPARED_NOT_STARTED',profile_sha256:hash(readFile(output,65536,{privateOnly:true})),cluster_initialized:false,ownership_created:false};
}
export async function runPostgres(profileFile,profileSha,stateFile,ports={}){
 const io=portsFor(ports);let stopRequested=false,first,failed=false,child,childBirth,closed,client,logs,state,logTail='',sawReady=false,sawShutdown=false,signalSent=false;
 const remember=error=>{if(!failed){failed=true;first=error;}};
 const requestStop=()=>{stopRequested=true;};
 for(const sig of ['SIGINT','SIGTERM','SIGHUP'])io.on(sig,requestStop);
 let p,closeResult,stateCreated=false,stateSha;
 const save=()=>{assert.equal(hash(readFile(stateFile,131072,{privateOnly:true})),stateSha,'owned-state-drift');state.error=failed?safe(first):null;durable(stateFile,state);stateSha=hash(readFile(stateFile,131072,{privateOnly:true}));};
 const recordLog=(stream,b)=>{try{logs.write(stream,Buffer.from(b));}catch(error){remember(error);stopRequested=true;}
  if(stream==='stderr'){logTail=(logTail+Buffer.from(b).toString('utf8')).slice(-8192);sawReady ||=logTail.includes('database system is ready to accept connections');sawShutdown ||=logTail.includes('database system is shut down');}
 };
 try{
  p=loadProfile(profileFile,profileSha);assert(io.platform===p.platform&&io.arch===p.arch&&io.uid===p.uid,'reviewed-local-platform');stateLocation(p,stateFile);assert(!fs.existsSync(stateFile),'fresh-state-required');
  const credentials=verifyProfileFiles(p,{stopped:true});
  state={schema:'dynaminds-owned-postgres-state/v1',profile_sha256:profileSha,supervisor:io.birth(io.selfPid),child:null,status:'starting',system_identifier:p.systemIdentifier,port:p.port,error:null,exit_code:null,signal:null,normal_stop:false,control_verified:false,controlled_ports:Object.keys(ports).length>0};
  durable(stateFile,state,true);stateSha=hash(readFile(stateFile,131072,{privateOnly:true}));stateCreated=true;await io.portFree(p.port);
  if(!stopRequested){
   // The loader environment belongs only to this child. Never modify process.env.
   const env=Object.fromEntries(['HOME','TMPDIR','LANG','LC_ALL','LC_CTYPE'].filter(k=>process.env[k]!==undefined).map(k=>[k,process.env[k]]));Object.assign(env,{PATH:'/usr/bin:/bin',LC_MESSAGES:'C',DYLD_LIBRARY_PATH:p.runtime.libraryDirectory});
   logs=createBoundedPrivateLogs(stateFile+'.logs',p.logBytes);const end=io.now()+p.startupMs;
   child=io.spawn(p,env);closed=new Promise(resolve=>{child.once('error',error=>{remember(error);stopRequested=true;});child.once('close',(exit_code,signal)=>{closeResult={exit_code,signal};resolve(closeResult);});});
   child.stdout.on('data',b=>recordLog('stdout',b));child.stderr.on('data',b=>recordLog('stderr',b));
   await new Promise(resolve=>{child.once('spawn',resolve);child.once('error',resolve);child.once('close',resolve);});
   if(child.pid&&closeResult===undefined){childBirth=io.birth(child.pid);state.child=childBirth;save();}
   while(!stopRequested&&!sawReady&&closeResult===undefined&&io.now()<end)await io.wait(10);
   if(!stopRequested){
    assert(closeResult===undefined&&childBirth,'postgres-exited-before-readiness');assert(sawReady&&io.now()<end,'postgres-readiness-timeout');
    client=io.client(p,credentials);await client.connect();
    if(!stopRequested){await identity(client,p);if(!stopRequested){postmasterIdentity(p,child.pid);loadedRuntime(p,await io.loadedPaths(child.pid));}}
    await client.end();client=undefined;
    if(!stopRequested){assert(closeResult===undefined&&io.now()<end,'postgres-startup-deadline');verifyProfileFiles(p);state.status='ready';save();await io.report({status:'OWNED_POSTGRES_READY',port:p.port,profile_sha256:profileSha,native_acceptance:false});}
   }
   while(!stopRequested&&closeResult===undefined)await io.wait(25);
   if(!stopRequested&&closeResult!==undefined)throw fault('POSTGRES_EXITED_UNEXPECTEDLY');
  }
 }catch(error){remember(error);stopRequested=true;}
 finally{
  if(client)try{await client.end();}catch(error){remember(error);}
  if(stateCreated){state.status='draining';try{save();}catch(error){remember(error);}}
  if(child&&closeResult===undefined){
   try{assert(childBirth,'unconfirmed-child-birth-no-signal');sameBirth(childBirth,io.birth(child.pid));if(!signalSent){signalSent=true;child.kill('SIGINT');}}
   catch(error){remember(error);}
   const end=io.now()+(p?.shutdownMs??1000);while(closeResult===undefined&&io.now()<end)await io.wait(10);
   if(closeResult===undefined){remember(fault('POSTGRES_CLOSE_UNCONFIRMED'));state.status='close-unconfirmed';try{save();}catch(error){remember(error);}
    // Never call a still-live child closed, drop its files, or escalate. Keep
    // this foreground owner and private pipes until the actual close arrives.
    await closed;
   }
  }
  if(child){
   if(closeResult?.exit_code!==0||closeResult?.signal!==null||!sawShutdown)remember(fault('POSTGRES_STOP_NOT_CONFIRMED'));
   if(sawShutdown&&closeResult?.exit_code===0&&closeResult?.signal===null)try{dataIdentity(p,{stopped:true});state.control_verified=true;}catch(error){remember(error);}
  }
  if(logs)try{state.logs=logs.snapshot();logs.close();}catch(error){remember(error);}
  if(stateCreated){state.status='closed';state.exit_code=closeResult?.exit_code??null;state.signal=closeResult?.signal??null;state.normal_stop=!failed&&(!child||state.control_verified);try{save();}catch(error){remember(error);}}
  for(const sig of ['SIGINT','SIGTERM','SIGHUP'])io.off(sig,requestStop);
 }
 if(failed)throw Object.assign(fault('OWNED_POSTGRES_RUNTIME_FAILED'),{detail:safe(first)});
 return{status:'OWNED_POSTGRES_CLOSED',normal_stop:state.normal_stop,postgres_started:!!child,native_acceptance:false};
}
export async function postgresStatus(profileFile,profileSha,stateFile,ports={}){
 const io=portsFor(ports),p=loadProfile(profileFile,profileSha);assert(io.platform===p.platform&&io.arch===p.arch&&io.uid===p.uid,'reviewed-local-platform');stateLocation(p,stateFile);const state=jsonFile(stateFile,131072);assert(state.schema==='dynaminds-owned-postgres-state/v1'&&state.profile_sha256===profileSha,'owned-state-profile');
 if(state.status==='closed')return{status:state.normal_stop&&!state.error?'CLOSED':'CLOSE_UNCONFIRMED',native_acceptance:false};
 sameBirth(state.supervisor,io.birth(state.supervisor.pid));if(state.child)sameBirth(state.child,io.birth(state.child.pid));
 if(state.status!=='ready')return{status:state.status.toUpperCase(),native_acceptance:false};
 const credentials=verifyProfileFiles(p),client=io.client(p,credentials);let first;
 try{await client.connect();await identity(client,p);postmasterIdentity(p,state.child.pid);loadedRuntime(p,await io.loadedPaths(state.child.pid));}catch(error){first=error;}finally{try{await client.end();}catch(error){first??=error;}}
 if(first)throw first;return{status:'READY',port:p.port,native_acceptance:false};
}
export async function stopPostgres(profileFile,profileSha,stateFile,ports={}){
 const io=portsFor(ports),p=loadProfile(profileFile,profileSha);assert(io.platform===p.platform&&io.arch===p.arch&&io.uid===p.uid,'reviewed-local-platform');stateLocation(p,stateFile);const state=jsonFile(stateFile,131072);assert(state.schema==='dynaminds-owned-postgres-state/v1'&&state.profile_sha256===profileSha,'owned-state-profile');dataIdentity(p);
 if(state.status==='closed'){assert(state.normal_stop&&!state.error,'prior-close-unconfirmed');return{status:'CLOSED',already_closed:true,native_acceptance:false};}
 sameBirth(state.supervisor,io.birth(state.supervisor.pid));if(state.child)sameBirth(state.child,io.birth(state.child.pid));io.signalSupervisor(state.supervisor.pid);
 const end=io.now()+p.shutdownMs+1000;while(io.now()<end){await io.wait(25);const next=jsonFile(stateFile,131072);assert.equal(next.profile_sha256,profileSha);sameBirth(next.supervisor,state.supervisor);if(next.status==='close-unconfirmed')throw fault('POSTGRES_CLOSE_UNCONFIRMED');if(next.status==='closed'){assert(next.normal_stop&&!next.error,'postgres-close-not-clean');return{status:'CLOSED',already_closed:false,native_acceptance:false};}}
 throw fault('POSTGRES_CLOSE_UNCONFIRMED');
}
export async function main(args,ports={}){
 assert(args.length===4&&['prepare','start','status','stop'].includes(args[0]),'usage-mode-profile-sha-state');const[mode,profile,sha,last]=args;
 return mode==='prepare'?preparePostgresProfile(profile,sha,last):mode==='start'?runPostgres(profile,sha,last,ports):mode==='status'?postgresStatus(profile,sha,last,ports):stopPostgres(profile,sha,last,ports);
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main(process.argv.slice(2)).then(value=>writePublic(process.stdout,value)).catch(async error=>{process.exitCode=1;try{await writePublic(process.stderr,{status:'OWNED_POSTGRES_OPERATOR_FAILED',...safe(error),...(error?.detail?{detail:error.detail}:{})});}catch{/* A broken public sink never prints private causes or restarts PostgreSQL. */}});
