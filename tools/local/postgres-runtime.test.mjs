/** Actual operator, controlled process/client ports only. Never starts or
 * connects to PostgreSQL. Synthetic pg_control bytes are NOT a Native proof. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {validatePostgresProfile,postgresCommand,preparePostgresProfile,runPostgres,postgresStatus,stopPostgres,main} from './postgres-runtime.mjs';

const sha=b=>createHash('sha256').update(b).digest('hex');
function fixture(t){
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'dyna-pg-runtime-')));fs.chmodSync(root,0o700);t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const data=root+'/data',runtime=root+'/runtime';for(const dir of[data,data+'/global',runtime,runtime+'/bin',runtime+'/lib'])fs.mkdirSync(dir,{mode:0o700});
 const write=(name,bytes)=>{fs.writeFileSync(name,bytes,{mode:0o600});fs.chmodSync(name,0o600);return{path:name,bytes:Buffer.byteLength(bytes),sha256:sha(bytes)};};
 const json=(name,value)=>write(name,JSON.stringify(value)+'\n');
 const control=Buffer.alloc(8192);control.writeBigUInt64LE(7519375123456789123n);control.writeUInt32LE(1800,8);control.writeUInt32LE(1,16);write(data+'/global/pg_control',control);write(data+'/PG_VERSION','18\n');
 const initialization=json(root+'/intent.private.json',{schema:'dynaminds-owned-postgres-initialization/v1',root,uid:process.getuid(),port:57089,own_cluster_only:true,existing_cluster_mutation:false});
 const s=fs.statSync(data,{bigint:true});
 const ownerMarker=json(root+'/ownership.private.json',{schema:'dynaminds-owned-initialized-postgres/v1',uid:process.getuid(),dataDirectory:data,dataDev:String(s.dev),dataIno:String(s.ino),systemIdentifier:'7519375123456789123',major:'18',initialization});
 const credentials=json(root+'/credentials.private.json',{user:'postgres',database:'postgres',password:'SYNTHETIC-SECRET-DO-NOT-PRINT'});
 const configuration=['postgresql.conf','postgresql.auto.conf','pg_hba.conf','pg_ident.conf'].map(name=>write(data+'/'+name,name==='postgresql.conf'?"listen_addresses = '127.0.0.1'\n":'# synthetic fixture only\n'));
 const file=(name)=>{const ref=write(runtime+'/'+name,'not executable; never spawned: '+name);return{...ref,realPath:ref.path,loaded:true};};
 const p={schema:'dynaminds-owned-postgres-runtime/v1',uid:process.getuid(),platform:'darwin',arch:'arm64',root,dataDirectory:data,port:57089,systemIdentifier:'7519375123456789123',version:'18.4',ownerMarker,credentials,configuration,runtime:{directory:runtime,libraryDirectory:runtime+'/lib',manifest:json(runtime+'/runtime-manifest.private.json',{schema:'synthetic-controlled-runtime/v1'}),postgres:file('bin/postgres'),files:[file('lib/libcrypto.3.dylib'),file('lib/libssl.3.dylib')]},startupMs:200,shutdownMs:100,logBytes:1024};
 let profile=json(root+'/profile.private.json',p);
 const refresh=()=>{profile=json(profile.path,p);return profile;};
 return{root,data,p,write,json,refresh,get profile(){return profile;},state:root+'/state.private.json',readState:()=>JSON.parse(fs.readFileSync(root+'/state.private.json','utf8')),controlState:n=>{const b=fs.readFileSync(data+'/global/pg_control');b.writeUInt32LE(n,16);write(data+'/global/pg_control',b);}};
}
function controller(f,options={}){
 const events=new EventEmitter(),calls={spawn:0,connect:0,query:0,end:0,signals:[],reports:[],loaded:0,supervisorSignals:[]};let now=0,child,closing=false;
 const selfPid=910001,childPid=910002;
 const birth=pid=>({pid,uid:process.getuid(),started:'controlled-start-'+pid,command_sha256:sha('controlled-command-'+pid)});
 const identity={database:'postgres',owner:'postgres',address:'127.0.0.1',port:f.p.port,version:f.p.version,data_directory:f.data,jit:'off',toast:'lz4',system_identifier:f.p.systemIdentifier};
 function finish(code=0,signal=null){if(closing)return;closing=true;f.controlState(1);fs.rmSync(f.data+'/postmaster.pid',{force:true});child.stderr.write('database system is shut down\n');child.emit('close',code,signal);child.stdout.end();child.stderr.end();}
 const ports={platform:'darwin',arch:'arm64',uid:process.getuid(),selfPid,now:()=>now,on:(s,fn)=>events.on(s,fn),off:(s,fn)=>events.off(s,fn),birth,
  wait:async ms=>{now+=ms;options.wait?.({now,child,calls,finish,events});await Promise.resolve();},
  portFree:async()=>{options.portFree?.({events,calls});},
  spawn:(profile,env)=>{calls.spawn++;assert.deepEqual(profile,f.p);assert.equal(env.DYLD_LIBRARY_PATH,f.p.runtime.libraryDirectory);assert.equal(env.PATH,'/usr/bin:/bin');assert.equal(env.LC_MESSAGES,'C');assert.equal(env.PGPASSWORD,undefined);assert.equal(env.DYLD_INSERT_LIBRARIES,undefined);
   child=new EventEmitter();child.pid=childPid;child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=signal=>{calls.signals.push(signal);if(options.closeOnKill!==false)queueMicrotask(()=>finish());return true;};
   queueMicrotask(()=>{if(options.spawnError){child.emit('error',options.spawnError);finish(-2,null);return;}
    f.controlState(6);f.write(f.data+'/postmaster.pid',[String(childPid),f.data,'1234567890',String(f.p.port),'','127.0.0.1','', 'ready',''].join('\n'));child.emit('spawn');
    if(options.ready!==false)child.stderr.write('database system is ready to accept connections\n');options.afterSpawn?.({child,calls,events,finish});
   });return child;},
  client:()=>({connect:async()=>{calls.connect++;await options.connect?.({calls,events,child,finish});},query:async sql=>{calls.query++;assert(sql.startsWith('SELECT current_database()')&&sql.endsWith('FROM pg_control_system()'));if(options.queryError)throw options.queryError;return{rows:[{...identity,...options.identity}]};},end:async()=>{calls.end++;if(options.endError)throw options.endError;}}),
  loadedPaths:()=>{calls.loaded++;return new Set([...f.p.runtime.files,f.p.runtime.postgres].map(r=>r.realPath).concat(options.extraLoaded??[]));},
  report:async value=>{calls.reports.push(value);if(options.reportError)throw options.reportError;events.emit('SIGTERM');},
  signalSupervisor:pid=>{calls.supervisorSignals.push(pid);options.signalSupervisor?.({pid,events,calls});},
 };
 if(options.birth)ports.birth=pid=>options.birth(pid,birth(pid));
 return{ports,calls,events,finish,birth,get child(){return child;}};
}
const run=(f,c)=>runPostgres(f.profile.path,f.profile.sha256,f.state,c.ports);

test('profile is strict, finite, local-only and copied; no freeform flags or adoption',t=>{
 const f=fixture(t);assert.deepEqual(validatePostgresProfile(f.p),f.p);
 for(const patch of[{port:0},{root:f.root+'/../other'},{dataDirectory:f.root+'/other'},{systemIdentifier:'0'},{systemIdentifier:'18446744073709551616'},{platform:'linux'},{arch:'x64'},{startupMs:120001},{shutdownMs:60001},{logBytes:1048577},{initdb:true},{options:'-c arbitrary=on'}])assert.throws(()=>validatePostgresProfile({...f.p,...patch}));
 const copy=validatePostgresProfile(f.p);f.p.runtime.files[0].sha256='a'.repeat(64);assert.notEqual(copy.runtime.files[0].sha256,f.p.runtime.files[0].sha256);
 assert.throws(()=>validatePostgresProfile({...copy,runtime:{...copy.runtime,files:[copy.runtime.files[0],copy.runtime.files[0]]}}));
});
test('actual spawn command is direct pinned postgres, IPv4 loopback, no Unix socket or freeform options',t=>{
 const f=fixture(t),command=postgresCommand(f.p);assert.equal(command.command,f.p.runtime.postgres.path);assert.equal(command.cwd,f.root);
 assert.deepEqual(command.args,['-D',f.data,'-p','57089','-h','127.0.0.1','-k','','-c','data_directory='+f.data,'-c','config_file='+f.data+'/postgresql.conf','-c','hba_file='+f.data+'/pg_hba.conf','-c','ident_file='+f.data+'/pg_ident.conf','-c','jit=off','-c','default_toast_compression=lz4','-c','timezone=UTC','-c','lc_messages=C','-c','logging_collector=off','-c','log_destination=stderr']);
 assert.throws(()=>postgresCommand({...f.p,options:'-h 0.0.0.0'}));
});
test('localized pinned cluster config cannot override the explicit English message command setting',async t=>{
 const f=fixture(t);f.p.configuration[0]=f.write(f.p.configuration[0].path,"lc_messages = 'pl_PL.UTF-8'\n");f.refresh();
 const command=postgresCommand(f.p);assert(command.args.indexOf('lc_messages=C')>command.args.indexOf('config_file='+f.data+'/postgresql.conf'));
 const c=controller(f);await run(f,c);assert.equal(c.calls.reports.length,1);assert.equal(f.readState().normal_stop,true);
});
test('prepare persists a fresh pinned profile, never creates ownership or initializes data',async t=>{
 const f=fixture(t);if(process.platform!=='darwin'||process.arch!=='arm64'){t.skip('reviewed platform is Darwin arm64');return;}
 const before=fs.readFileSync(f.p.ownerMarker.path),output=f.root+'/prepared.private.json';
 const result=await preparePostgresProfile(f.profile.path,f.profile.sha256,output);assert.equal(result.status,'OWNED_POSTGRES_PROFILE_PREPARED_NOT_STARTED');assert.equal(result.ownership_created,false);assert.equal(result.cluster_initialized,false);assert.equal(fs.statSync(output).mode&0o777,0o600);assert.deepEqual(fs.readFileSync(f.p.ownerMarker.path),before);
 await assert.rejects(preparePostgresProfile(f.profile.path,f.profile.sha256,output));
 fs.unlinkSync(f.p.ownerMarker.path);await assert.rejects(preparePostgresProfile(f.profile.path,f.profile.sha256,f.root+'/another.private.json'));assert(!fs.existsSync(f.root+'/another.private.json'));
});
test('actual foreground lifecycle binds client/PID/runtime, keeps global environment and closes normally',async t=>{
 const environmentDigest=()=>sha(JSON.stringify(Object.entries(process.env).sort(([a],[b])=>a.localeCompare(b))));
 const f=fixture(t),c=controller(f),environment=environmentDigest();const result=await run(f,c);
 assert.equal(environmentDigest(),environment);assert.deepEqual(result,{status:'OWNED_POSTGRES_CLOSED',normal_stop:true,postgres_started:true,native_acceptance:false});
 assert.deepEqual(c.calls.signals,['SIGINT']);assert.equal(c.calls.spawn,1);assert.equal(c.calls.connect,1);assert.equal(c.calls.query,1);assert.equal(c.calls.end,1);assert.equal(c.calls.reports.length,1);assert.equal(c.events.eventNames().length,0);
 const state=f.readState();assert.equal(state.status,'closed');assert.equal(state.normal_stop,true);assert.equal(state.control_verified,true);assert.equal(state.controlled_ports,true);assert.equal(state.logs.retained_bytes_max,4096);assert.equal(state.exit_code,0);
 assert(!JSON.stringify(state).includes('SYNTHETIC-SECRET'));assert(!JSON.stringify(c.calls.reports).includes('password'));
 assert.equal((await postgresStatus(f.profile.path,f.profile.sha256,f.state,c.ports)).status,'CLOSED');assert.equal((await stopPostgres(f.profile.path,f.profile.sha256,f.state,c.ports)).already_closed,true);assert.equal(c.calls.supervisorSignals.length,0);
 await assert.rejects(run(f,c));assert.equal(c.calls.spawn,1,'same durable attempt never restarts');
});
test('early signal before spawn, after spawn and during connect is retained, with no ready report',async t=>{
 for(const stage of ['port','spawn','connect'])await t.test(stage,async t=>{
  const f=fixture(t),options=stage==='port'?{portFree:({events})=>events.emit('SIGTERM')}:stage==='spawn'?{afterSpawn:({events})=>events.emit('SIGINT')}:{connect:({events})=>events.emit('SIGHUP')};
  const c=controller(f,options),r=await run(f,c);assert.equal(r.normal_stop,true);assert.equal(c.calls.reports.length,0);assert.equal(c.calls.query,0);assert.equal(c.calls.spawn,stage==='port'?0:1);assert.equal(c.calls.connect,stage==='connect'?1:0);assert.equal(c.calls.end,stage==='connect'?1:0);assert.deepEqual(c.calls.signals,stage==='port'?[]:['SIGINT']);
 });
});
test('readiness timeout preserves first failure, requests one normal stop and never reconnects',async t=>{
 const f=fixture(t),c=controller(f,{ready:false});let error;try{await run(f,c);}catch(e){error=e;}
 assert.equal(error.code,'OWNED_POSTGRES_RUNTIME_FAILED');assert.equal(error.detail.message_sha256,sha('postgres-readiness-timeout'));assert.deepEqual(c.calls.signals,['SIGINT']);assert.equal(c.calls.connect,0);assert.equal(c.calls.reports.length,0);assert.equal(f.readState().normal_stop,false);assert.equal(f.readState().control_verified,true);
});
test('identity, actual PID and loaded dependency failures stop only the spawned child',async t=>{
 const scenarios=[{identity:{system_identifier:'1'}},{extraLoaded:['/unowned/libwrong.dylib']},{connect:()=>{fRef.write(fRef.data+'/postmaster.pid','999999\nforeign\n');}}];let fRef;
 for(let i=0;i<scenarios.length;i++)await t.test(String(i),async t=>{const f=fixture(t);fRef=f;const c=controller(f,scenarios[i]);await assert.rejects(run(f,c),{code:'OWNED_POSTGRES_RUNTIME_FAILED'});assert.deepEqual(c.calls.signals,['SIGINT']);assert.equal(c.calls.reports.length,0);assert.equal(c.calls.spawn,1);assert.equal(f.readState().normal_stop,false);});
});
test('unpinned PostgreSQL preload modules are refused for both .so and .bundle library forms',async t=>{
 for(const suffix of ['so','bundle'])await t.test(suffix,async t=>{
  const f=fixture(t),c=controller(f,{extraLoaded:[f.root+'/unreviewed-preload.'+suffix]});
  await assert.rejects(run(f,c),{code:'OWNED_POSTGRES_RUNTIME_FAILED'});assert.equal(c.calls.reports.length,0);assert.deepEqual(c.calls.signals,['SIGINT']);assert.equal(f.readState().normal_stop,false);
 });
});
test('private preflight rejects config/runtime/ownership/control drift before any process or client',async t=>{
 const changes=[f=>f.write(f.p.configuration[0].path,'changed'),f=>f.write(f.p.runtime.files[0].path,'changed'),f=>{fs.chmodSync(f.p.credentials.path,0o644);},f=>f.controlState(6),f=>{const b=fs.readFileSync(f.data+'/global/pg_control');b.writeBigUInt64LE(1n);f.write(f.data+'/global/pg_control',b);},f=>f.write(f.data+'/postmaster.pid','1'),f=>{fs.unlinkSync(f.p.ownerMarker.path);},f=>{f.p.configuration[0]=f.write(f.p.configuration[0].path,"include = '/unreviewed/config'\n");f.refresh();}];
 for(let i=0;i<changes.length;i++)await t.test(String(i),async t=>{const f=fixture(t),c=controller(f);changes[i](f);await assert.rejects(run(f,c),{code:'OWNED_POSTGRES_RUNTIME_FAILED'});assert.equal(c.calls.spawn,0);assert.equal(c.calls.connect,0);assert(!fs.existsSync(f.state));});
});
test('profile loader validates the same bounded bytes it hashes and public errors contain no private JSON',async t=>{
 const f=fixture(t),c=controller(f);f.write(f.profile.path,'{"password":"SYNTHETIC-SECRET-DO-NOT-PRINT",');
 await assert.rejects(runPostgres(f.profile.path,sha(fs.readFileSync(f.profile.path)),f.state,c.ports),e=>{assert.equal(e.code,'OWNED_POSTGRES_RUNTIME_FAILED');assert.equal(e.detail.code,'PRIVATE_PROFILE_INVALID');assert(!JSON.stringify(e).includes('SYNTHETIC'));assert.equal(e.cause,undefined);return true;});assert.equal(c.calls.spawn,0);
});
test('bounded actual profile reader refuses growth, closes its FD and never allocates the grown payload',async t=>{
 const f=fixture(t),c=controller(f),original={open:fs.openSync,read:fs.readSync,close:fs.closeSync};let target,grew=false,closed=false,maxRead=0;
 fs.openSync=function(file,...args){const fd=original.open.call(this,file,...args);if(file===f.profile.path)target=fd;return fd;};
 fs.readSync=function(fd,buffer,offset,length,position){if(fd===target){maxRead=Math.max(maxRead,length);if(!grew){grew=true;fs.appendFileSync(f.profile.path,Buffer.alloc(65536,65));}}return original.read.call(this,fd,buffer,offset,length,position);};
 fs.closeSync=function(fd){if(fd===target)closed=true;return original.close.call(this,fd);};
 try{await assert.rejects(run(f,c),{code:'OWNED_POSTGRES_RUNTIME_FAILED'});}finally{fs.openSync=original.open;fs.readSync=original.read;fs.closeSync=original.close;}
 assert(grew&&closed);assert(maxRead<=f.profile.bytes+1);assert.equal(c.calls.spawn,0);assert.equal(c.calls.connect,0);
});
test('failed connect remains the primary error when closing the client also fails',async t=>{
 const f=fixture(t),primary=Object.assign(new Error('synthetic connection failure'),{code:'ECONNREFUSED'}),c=controller(f,{connect:()=>{throw primary;},endError:new Error('secondary close failure')});
 await assert.rejects(run(f,c),e=>{assert.equal(e.detail.code,'ECONNREFUSED');assert.equal(e.detail.message_sha256,sha(primary.message));return true;});assert.equal(c.calls.connect,1);assert.equal(c.calls.end,1);assert.equal(c.calls.query,0);assert.equal(c.calls.reports.length,0);assert.deepEqual(c.calls.signals,['SIGINT']);assert.equal(f.readState().normal_stop,false);
});
test('broken public readiness sink fails closed and preserves the original error across cleanup',async t=>{
 const f=fixture(t),primary=Object.assign(new Error('primary synthetic sink error'),{code:'EPIPE'}),c=controller(f,{reportError:primary,endError:null});
 await assert.rejects(run(f,c),e=>{assert.equal(e.detail.code,'EPIPE');assert.equal(e.detail.message_sha256,sha(primary.message));return true;});assert.deepEqual(c.calls.signals,['SIGINT']);assert.equal(f.readState().normal_stop,false);
});
test('close deadline never escalates or reports clean after a late actual child close',async t=>{
 const f=fixture(t),c=controller(f,{closeOnKill:false});const pending=run(f,c);let witnessed=false;
 const late=new Promise((resolve,reject)=>setImmediate(()=>{try{assert.equal(f.readState().status,'close-unconfirmed');assert.deepEqual(c.calls.signals,['SIGINT']);witnessed=true;c.finish();resolve();}catch(e){c.finish();reject(e);}}));
 await assert.rejects(pending,e=>{assert.equal(e.detail.code,'POSTGRES_CLOSE_UNCONFIRMED');return true;});await late;assert(witnessed);assert.equal(f.readState().normal_stop,false);assert.equal(f.readState().control_verified,true);assert.equal(f.readState().status,'closed');assert.deepEqual(c.calls.signals,['SIGINT']);
});
test('changed process birth refuses every signal even during finalization',async t=>{
 const f=fixture(t);let childReads=0;const c=controller(f,{closeOnKill:false,birth:(pid,b)=>pid===910002&&++childReads>1?{...b,started:'reused-pid'}:b});
 const pending=run(f,c),late=new Promise((resolve,reject)=>setImmediate(()=>{try{assert.equal(f.readState().status,'close-unconfirmed');assert.deepEqual(c.calls.signals,[]);c.finish();resolve();}catch(e){c.finish();reject(e);}}));
 await assert.rejects(pending,e=>{assert.equal(e.detail.code,'OWNED_PROCESS_BIRTH_MISMATCH');return true;});await late;assert.equal(f.readState().normal_stop,false);
});
test('bounded private logs drain large child data while retaining four finite owned slots',async t=>{
 const f=fixture(t),c=controller(f,{afterSpawn:({child})=>{child.stdout.write(Buffer.alloc(20000,65));child.stderr.write(Buffer.alloc(20000,66));child.stderr.write('\ndatabase system is ready to accept connections\n');}});await run(f,c);
 const logs=f.readState().logs;assert(logs.stdout.bytes===20000&&logs.stderr.bytes>20000);assert(logs.stdout.retained_bytes<=2048&&logs.stderr.retained_bytes<=2048);for(const name of fs.readdirSync(f.state+'.logs'))assert(fs.statSync(f.state+'.logs/'+name).size<=1024);
});
test('status reauthenticates actual backend and stop targets only exact recorded supervisor birth',async t=>{
 const f=fixture(t),c=controller(f);await run(f,c);const state=f.readState();state.status='ready';state.normal_stop=false;state.error=null;f.json(f.state,state);f.controlState(6);f.write(f.data+'/postmaster.pid',['910002',f.data,'0',String(f.p.port),'','127.0.0.1',''].join('\n'));
 assert.equal((await postgresStatus(f.profile.path,f.profile.sha256,f.state,c.ports)).status,'READY');
 let signalled=false;const stopPorts={...c.ports,signalSupervisor:pid=>{assert.equal(pid,910001);signalled=true;},wait:async()=>{state.status='closed';state.normal_stop=true;f.json(f.state,state);f.controlState(1);fs.unlinkSync(f.data+'/postmaster.pid');}};
 assert.equal((await stopPostgres(f.profile.path,f.profile.sha256,f.state,stopPorts)).status,'CLOSED');assert(signalled);
 state.status='ready';f.json(f.state,state);signalled=false;await assert.rejects(stopPostgres(f.profile.path,f.profile.sha256,f.state,{...stopPorts,birth:pid=>({...c.birth(pid),started:'wrong-birth'})}));assert.equal(signalled,false);
});
test('dispatcher rejects missing/unknown modes without reading a profile or starting a process',async()=>{
 await assert.rejects(main(['--run']));await assert.rejects(main(['initdb','/unowned/profile','a'.repeat(64),'/unowned/state']));
});
test('fresh actual module import installs no hooks and opens no configuration, credentials or PG client',async()=>{
 const hooks=['exit','beforeExit','SIGINT','SIGTERM','SIGHUP'],before=hooks.map(k=>process.listenerCount(k)),open=fs.openSync;let opened=0;
 const sourcePath=fileURLToPath(new URL('./postgres-runtime.mjs',import.meta.url));
 fs.openSync=function(file,...args){if((file instanceof URL?fileURLToPath(file):String(file))===sourcePath)return open.call(this,file,...args);opened++;throw new Error('import must not open local inputs');};
 try{const module=await import(new URL('./postgres-runtime.mjs?controlled-import-inert',import.meta.url));assert.equal(typeof module.runPostgres,'function');}
 finally{fs.openSync=open;}
 assert.equal(opened,0);assert.deepEqual(hooks.map(k=>process.listenerCount(k)),before);
});
