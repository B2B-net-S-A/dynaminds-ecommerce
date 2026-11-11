import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {EventEmitter} from 'node:events';
import {execFileSync,spawn} from 'node:child_process';
import net from 'node:net';
import {createHash} from 'node:crypto';
import {prepareService,prepareStackService,validateService,renderServicePlist,startService,serviceStatus,stopService,runService,registrationIsInactive,systemPort} from './service.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
const save=(p,v)=>fs.writeFileSync(p,JSON.stringify(v),{mode:0o600});
const read=p=>JSON.parse(fs.readFileSync(p));
const identity=pid=>({pid,uid:process.getuid(),started:'Controlled birth '+pid,command_sha256:sha('Controlled command '+pid)});
function fixture(t){
 const directory=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'dyna-service-test-')));fs.chmodSync(directory,0o700);t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const profilePath=path.join(directory,'profile.private.json'),profile={schema:'dynaminds-local-operator/v1',selectionPath:path.join(directory,'selection.private.json'),selectionSha:'a'.repeat(64),releaseDirectory:path.join(directory,'release'),manifestSha:'b'.repeat(64),revision:'b'.repeat(64),configurationPath:path.join(directory,'configuration.private.json'),database:'dynaminds_synthetic_test',pgPort:57081,httpPort:4109,cwd:directory,imageDirectory:directory,flags:['--verified-stock-writers']};
 save(profilePath,profile);const prepared=prepareService(profilePath,directory,'pl.dynaminds.ecommerce.controlled-test'),d=read(prepared.descriptor),digest=sha(fs.readFileSync(d.descriptorPath));
 const events=[],live=new Set(),supervisor=identity(800001),operator=identity(800002),app=identity(800003);let now=0,ready=false,observed='\tpath = '+d.plist.path+'\n\tstate = not running\n',bootstrapCode=0;
 const writeApp=(closed=false)=>save(d.operatorStatePath,{schema:'dynaminds-local-operator-owned-process/v1',profile_sha256:d.profile.sha256,status:closed?'closed':'starting-or-running',birth:app,exit_code:closed?0:null,signal:null,PG_managed:false});
 const writeService=(closed=false)=>save(d.statePath,{schema:'dynaminds-local-macos-service-state/v1',descriptor_sha256:digest,status:closed?'closed':'starting',supervisor,operator,exit_code:closed?0:null,signal:null,app_clean_close:closed,PG_managed:false});
 const port={platform:'darwin',now:()=>now,async wait(ms){now+=ms;},live(expected){assert.deepEqual(expected,identity(expected.pid),'a fabricated process birth cannot become authority');return live.has(expected.pid);},async probe(p){events.push('probe');assert.equal(p.revision,profile.revision);return ready;},async launchctl(args){events.push(args[0]);if(args[0]==='print')return{code:0,stdout:observed};return{code:args[0]==='bootstrap'?bootstrapCode:0,stdout:''};},async invokeOperator(received,mode){events.push('operator:'+mode);assert.equal(mode,'stop');assert.deepEqual(received,d);writeApp(true);writeService(true);live.clear();}};
 return{directory,profilePath,profile,d,digest,events,live,port,supervisor,operator,app,writeApp,writeService,seed(){writeApp();writeService();for(const b of [supervisor,operator,app])live.add(b.pid);},ready(v){ready=v;},observed(v){observed=v;},bootstrapCode(v){bootstrapCode=v;}};
}
test('prepare only writes private metadata/plist/logs; generated job has explicit no-restart and graceful-stop policy, no credentials or PG process',t=>{
 const f=fixture(t);assert.equal(f.events.length,0);const xml=fs.readFileSync(f.d.plist.path,'utf8');
 assert.match(xml,/<key>RunAtLoad<\/key><true\/>/);assert.match(xml,/<key>KeepAlive<\/key><false\/>/);assert.match(xml,/<key>ExitTimeOut<\/key><integer>120<\/integer>/);assert.match(xml,/<key>Umask<\/key><string>077<\/string>/);
 assert(!xml.includes('postgres://'));assert(!xml.includes('kickstart'));assert(!xml.includes('StartInterval'));assert(!xml.includes('WatchPaths'));assert(!xml.includes('Sockets'));
 assert(xml.includes('<string>run</string>'));assert(!fs.existsSync(f.d.statePath));assert(!fs.existsSync(f.d.operatorStatePath));
 for(const p of [f.d.descriptorPath,f.d.plist.path,f.d.stdoutPath,f.d.stderrPath])assert.equal(fs.statSync(p).mode&0o777,0o600);
 if(process.platform==='darwin')execFileSync('/usr/bin/plutil',['-lint',f.d.plist.path],{stdio:'pipe'});
 assert.equal(sha(xml),f.d.plist.sha256);assert.equal(renderServicePlist(f.d),xml);
 assert.throws(()=>prepareService(f.profilePath,f.directory,f.d.label),/fresh-service-directory/);
});
test('service descriptor rejects arbitrary keys, labels, foreign user/domain, alias paths and unsafe shared artifacts',t=>{
 const f=fixture(t);assert.deepEqual(validateService(f.d),f.d);
 for(const patch of [{extra:true},{uid:process.getuid()+1},{domain:'system'},{label:'com.apple.unrelated'},{descriptorPath:'relative'},{cwd:'/tmp/../private'},{statePath:f.d.operatorStatePath},{operator:{...f.d.operator,token:'private'}},{profile:{...f.d.profile,sha256:'bad'}}])assert.throws(()=>validateService({...f.d,...patch}));
});
test('one bootstrap request is recorded before launchctl; acknowledgement loss never causes automatic bootstrap retry',async t=>{
 const f=fixture(t);f.bootstrapCode(null);assert.equal((await startService(f.d.descriptorPath,f.port)).status,'START_UNCONFIRMED');assert.deepEqual(f.events,['bootstrap']);assert.equal(read(f.d.statePath).status,'requested');
 assert.equal((await serviceStatus(f.d.descriptorPath,f.port)).status,'START_UNCONFIRMED');await assert.rejects(()=>startService(f.d.descriptorPath,f.port),/fresh-service-state/);assert.deepEqual(f.events,['bootstrap']);
});
test('profile/plist/descriptor permissions and pins are checked before bootstrap',async t=>{
 for(const changed of ['profile','plist','mode']){
  const f=fixture(t);if(changed==='mode')fs.chmodSync(f.d.descriptorPath,0o644);else fs.appendFileSync(f.d[changed].path,'\n');
  await assert.rejects(()=>startService(f.d.descriptorPath,f.port));assert.equal(f.events.length,0);assert(!fs.existsSync(f.d.statePath));
 }
 const f=fixture(t);await assert.rejects(()=>startService(f.d.descriptorPath,{...f.port,platform:'linux'}),/macos-required/);assert.equal(f.events.length,0);
});
test('STARTING remains distinct from READY; health observation requires live matching supervisor/operator/app births',async t=>{
 const f=fixture(t);f.seed();assert.equal((await serviceStatus(f.d.descriptorPath,f.port)).status,'STARTING');f.ready(true);assert.equal((await serviceStatus(f.d.descriptorPath,f.port)).status,'READY');
 assert.equal(f.events.filter(v=>v==='probe').length,2);f.live.delete(f.app.pid);await assert.rejects(()=>serviceStatus(f.d.descriptorPath,f.port),/owned-app-not-live/);assert.equal(f.events.filter(v=>v==='probe').length,2);
 const s=read(f.d.statePath);s.supervisor.started='Different birth';save(f.d.statePath,s);await assert.rejects(()=>stopService(f.d.descriptorPath,f.port),/fabricated/);assert(!f.events.includes('operator:stop'));
});
test('stop delegates graceful close to existing operator before checking closed births and removing inactive registration',async t=>{
 const f=fixture(t);f.seed();const result=await stopService(f.d.descriptorPath,f.port);assert.equal(result.status,'CLOSED_AND_UNREGISTERED');assert.equal(result.PG_managed,false);assert.deepEqual(f.events,['operator:stop','print','bootout']);assert.equal((await serviceStatus(f.d.descriptorPath,f.port)).status,'CLOSED');
});
test('failed/unknown graceful close, live original process and unknown launchctl text prohibit bootout or forced signals',async t=>{
 const failed=fixture(t);failed.seed();await assert.rejects(()=>stopService(failed.d.descriptorPath,{...failed.port,async invokeOperator(){failed.events.push('unknown-stop');throw Error('unconfirmed');}}),/unconfirmed/);assert.deepEqual(failed.events,['unknown-stop']);
 const live=fixture(t);live.seed();await assert.rejects(()=>stopService(live.d.descriptorPath,{...live.port,async invokeOperator(){live.writeApp(true);}}),/service-close-unconfirmed/);assert(!live.events.includes('bootout'));
 for(const output of ['unknown new macOS format','\tstate = running\n\tpid = 999\n','\tstate = not running\n\tpid = 999\n']){const f=fixture(t);f.seed();f.observed(output);await assert.rejects(()=>stopService(f.d.descriptorPath,f.port),/registration-not-proven-inactive/);assert(!f.events.includes('bootout'));}
 assert.equal(registrationIsInactive('\tpath = /private/ours.plist\n\tstate = not running\n','/private/ours.plist'),true);assert.equal(registrationIsInactive('\tpath = /private/another.plist\n\tstate = not running\n','/private/ours.plist'),false);
});
test('closed operator alone is insufficient: unexpected wrapper exit or unconfirmed app shutdown is never CLOSED',async t=>{
 const f=fixture(t);f.seed();f.writeApp(true);f.writeService(true);f.live.clear();const s=read(f.d.statePath);s.app_clean_close=false;save(f.d.statePath,s);
 assert.equal((await serviceStatus(f.d.descriptorPath,f.port)).status,'CLOSE_UNCONFIRMED');await assert.rejects(()=>stopService(f.d.descriptorPath,f.port),/service-clean-close-not-confirmed/);assert.equal(f.events.length,0);
});
test('injected foreground process lifecycle records exact births, consumes the launch once claim and closes without restart',async t=>{
 const f=fixture(t);await startService(f.d.descriptorPath,f.port);const child=new EventEmitter();Object.assign(child,{pid:f.operator.pid,exitCode:null,signalCode:null,kill(signal){f.events.push('signal:'+signal);return true;}});const signals=new EventEmitter();
 let spawned=0;const run=runService(f.d.descriptorPath,{...f.port,selfPid:f.supervisor.pid,birth:identity,onSignal:(s,fn)=>signals.on(s,fn),offSignal:(s,fn)=>signals.off(s,fn),spawnOperator(d){spawned++;assert.deepEqual(d,f.d);queueMicrotask(()=>{child.emit('spawn');setImmediate(()=>{f.writeApp(true);child.exitCode=0;child.emit('close',0,null);});});return child;}});
 assert.equal((await run).status,'CLOSED');assert.equal(spawned,1);assert.equal(read(f.d.statePath).app_clean_close,true);assert.equal(read(f.d.statePath).supervisor.pid,f.supervisor.pid);assert(fs.existsSync(f.d.claimPath));assert.equal(signals.listenerCount('SIGTERM'),0);
 await assert.rejects(()=>runService(f.d.descriptorPath,{...f.port}),/requested/);assert.equal(spawned,1);assert(!f.events.some(e=>e.startsWith('signal:')));
});
test('failure while capturing process birth drains only the owned child once, with no restart or forced escalation',async t=>{
 const f=fixture(t);await startService(f.d.descriptorPath,f.port);const child=new EventEmitter();let kills=0,spawned=0;const signals=new EventEmitter();
 Object.assign(child,{pid:f.operator.pid,exitCode:null,signalCode:null,kill(signal){assert.equal(signal,'SIGTERM');kills++;queueMicrotask(()=>{child.exitCode=0;child.emit('close',0,null);});return true;}});
 await assert.rejects(()=>runService(f.d.descriptorPath,{...f.port,selfPid:f.supervisor.pid,birth(){throw Error('controlled process identity observation failed');},onSignal:(s,fn)=>signals.on(s,fn),offSignal:(s,fn)=>signals.off(s,fn),spawnOperator(){spawned++;queueMicrotask(()=>child.emit('spawn'));return child;}}),/controlled process identity/);
 assert.equal(kills,1);assert.equal(spawned,1);assert.equal(signals.listenerCount('SIGTERM'),0);assert.equal(read(f.d.statePath).status,'requested');assert(fs.existsSync(f.d.claimPath));
});
test('actual bounded loopback health probe confirms exact revision; a reachable wrong release cannot become READY',async t=>{
 let wrong=false;const server=http.createServer((_req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({status:'ok',revision:(wrong?'c':'b').repeat(64)}));});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const p={httpPort:server.address().port,revision:'b'.repeat(64)};assert.equal(await systemPort.probe(p),true);wrong=true;await assert.rejects(()=>systemPort.probe(p),/unexpected-health-revision/);
});

function stackFixture(t,autoCleanup=true){
 const directory=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'dyna-stack-service-test-')));fs.chmodSync(directory,0o700);if(autoCleanup)t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const script=path.join(directory,'controlled-health.mjs');fs.writeFileSync(script,"import http from 'node:http';const server=http.createServer((q,r)=>{r.setHeader('Content-Type','application/json');r.end(JSON.stringify({status:'ok'}));});server.listen(Number(process.argv[2]),'127.0.0.1');process.on('SIGTERM',()=>server.close(()=>process.exit(0)));",{mode:0o600});
 const profile={schema:'dynaminds-local-stack/v1',startupMs:4000,shutdownMs:4000,logBytes:4096,services:[0,1].map(n=>({id:'controlled-'+n,entry:{path:script,sha256:sha(fs.readFileSync(script))},imports:[],args:[String(19001+n)],cwd:directory,envPaths:{},files:[],ports:[19001+n],ready:{kind:'http',port:19001+n,path:'/health',status:200,json:{status:'ok'},ca:null}}))};
 const profilePath=path.join(directory,'stack-profile.private.json');save(profilePath,profile);const prepared=prepareStackService(profilePath,directory,'pl.dynaminds.ecommerce.controlled-stack'),d=read(prepared.descriptor),digest=sha(fs.readFileSync(d.descriptorPath));
 const supervisor=identity(800011),controller=identity(800012),children=[identity(800013),identity(800014)],live=new Set([supervisor.pid,controller.pid,...children.map(b=>b.pid)]),events=[];let observedReady=true,clock=0;
 const native=(closed=false)=>({schema:'dynaminds-local-stack-state/v1',profile_sha256:d.profile.sha256,supervisor:controller,status:closed?'closed':'ready',services:children.map((birth,n)=>({id:profile.services[n].id,birth,status:closed?'closed':'ready',exit_code:closed?0:null,signal:null})),error:null,cleanup:[],PG_managed:false});
 const wrapper=(closed=false)=>({schema:'dynaminds-local-macos-service-state/v2',kind:'stack',descriptor_sha256:digest,status:closed?'closed':'starting',supervisor,controller,exit_code:closed?0:null,signal:null,stack_clean_close:closed,PG_managed:false});
 const writeNative=(closed=false)=>save(d.stackStatePath,native(closed)),writeWrapper=(closed=false)=>save(d.statePath,wrapper(closed));
 const port={platform:'darwin',now:()=>clock,async wait(ms){clock+=ms;},live(expected){assert.deepEqual(expected,identity(expected.pid),'fabricated stack process identity');return live.has(expected.pid);},async launchctl(args){events.push(args[0]);return{code:0,stdout:'\tpath = '+d.plist.path+'\n\tstate = not running\n'};},async stackStatus(p,s){events.push('stack:status');assert.equal(p,profilePath);assert.equal(s,d.stackStatePath);return{status:'ready',PG_managed:false,services:profile.services.map(v=>({id:v.id,status:'ready',live:true,ready:observedReady}))};},async stopStack(p,s){events.push('stack:stop');assert.equal(p,profilePath);assert.equal(s,d.stackStatePath);writeNative(true);writeWrapper(true);live.clear();},async invokeOperator(){assert.fail('stack mode must not invoke operator stop');},async spawnOperator(){assert.fail('stack mode must not spawn operator controller');}};
 return{directory,script,profile,profilePath,d,digest,supervisor,controller,children,events,live,port,native,wrapper,writeNative,writeWrapper,seed(){writeNative();writeWrapper();},ready(value){observedReady=value;}};
}
test('explicit stack preparation has exact kind/schema and pinned stack dependency while legacy preparation stays v1',t=>{
 const f=stackFixture(t);assert.equal(f.d.schema,'dynaminds-local-macos-service/v2');assert.equal(f.d.kind,'stack');assert(f.d.stack.path.endsWith('/tools/local/stack.mjs'));assert.equal(f.d.operatorStatePath,undefined);assert.equal(f.d.stackStatePath,path.join(f.directory,'stack-state.private.json'));assert.equal(f.events.length,0);
 assert.deepEqual(validateService(f.d),f.d);for(const patch of [{kind:'operator'},{stack:{...f.d.stack,path:'/private/arbitrary-stack.mjs'}},{operatorStatePath:'/private/other.json'},{stackStatePath:f.d.statePath}])assert.throws(()=>validateService({...f.d,...patch}));
 const old=fixture(t);assert.equal(old.d.schema,'dynaminds-local-macos-service/v1');assert.equal(old.d.kind,undefined);
});
test('stack READY requires every original child and every existing stackStatus readiness result; partial or malformed sets never pass',async t=>{
 const f=stackFixture(t);f.seed();assert.equal((await serviceStatus(f.d.descriptorPath,f.port)).status,'READY');f.ready(false);assert.equal((await serviceStatus(f.d.descriptorPath,f.port)).status,'STARTING');f.ready(true);
 f.live.delete(f.children[1].pid);assert.equal((await serviceStatus(f.d.descriptorPath,f.port)).status,'STARTING');f.live.add(f.children[1].pid);
 const partial=f.native();partial.status='starting';partial.services.pop();save(f.d.stackStatePath,partial);assert.equal((await serviceStatus(f.d.descriptorPath,f.port)).status,'STARTING');
 f.writeNative();await assert.rejects(()=>serviceStatus(f.d.descriptorPath,{...f.port,async stackStatus(){return{status:'ready',PG_managed:true,services:[]};}}));
 const malformed=f.native();malformed.services[1].id=malformed.services[0].id;save(f.d.stackStatePath,malformed);await assert.rejects(()=>serviceStatus(f.d.descriptorPath,f.port),/unknown-or-duplicate/);
 const duplicated=f.native();duplicated.services[1].birth=duplicated.services[0].birth;save(f.d.stackStatePath,duplicated);await assert.rejects(()=>serviceStatus(f.d.descriptorPath,f.port),/duplicate-or-controller/);
 const foreign=f.native();foreign.supervisor.started='changed';save(f.d.stackStatePath,foreign);await assert.rejects(()=>serviceStatus(f.d.descriptorPath,f.port),/birth-mismatch/);
});
test('stack stop calls existing stopStack, confirms every child closed and absent, then removes inactive registration',async t=>{
 const f=stackFixture(t);f.seed();assert.equal((await stopService(f.d.descriptorPath,f.port)).status,'CLOSED_AND_UNREGISTERED');assert.deepEqual(f.events,['stack:stop','print','bootout']);assert.equal((await serviceStatus(f.d.descriptorPath,f.port)).status,'CLOSED');
});
test('stack unknown cleanup or surviving child refuses bootout even when wrapper reports EXIT0',async t=>{
 for(const failure of ['unknown_cleanup','surviving_child','callback_failure']){
  const f=stackFixture(t);f.seed();const port={...f.port,async stopStack(){f.events.push('stack:stop');if(failure==='callback_failure')throw Error('Controlled unconfirmed drain');f.writeNative(true);f.writeWrapper(true);f.live.clear();if(failure==='unknown_cleanup'){const n=read(f.d.stackStatePath);n.cleanup=[{service:'controlled-1',code:'SHUTDOWN_UNCONFIRMED'}];save(f.d.stackStatePath,n);}else f.live.add(f.children[1].pid);}};
  await assert.rejects(()=>stopService(f.d.descriptorPath,port));assert(!f.events.includes('bootout'));assert(!f.events.some(x=>x.startsWith('signal:')));
  if(failure==='unknown_cleanup')assert.equal((await serviceStatus(f.d.descriptorPath,port)).status,'CLOSE_UNCONFIRMED');
 }
});
test('stack pins and mixed descriptor/controller state refuse before any launchctl or signal',async t=>{
 const f=stackFixture(t);fs.appendFileSync(f.profilePath,'\n');await assert.rejects(()=>startService(f.d.descriptorPath,f.port),/pinned-file-changed/);assert.equal(f.events.length,0);
 const other=stackFixture(t);other.seed();const n=other.native();n.profile_sha256='0'.repeat(64);save(other.d.stackStatePath,n);await assert.rejects(()=>stopService(other.d.descriptorPath,other.port));assert.equal(other.events.length,0);
});
async function freePort(){const server=net.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const value=server.address().port;await new Promise(r=>server.close(r));return value;}
test('real controlled two-service stack runs under foreground wrapper, reaches complete READY and drains without launchd mutation',async t=>{
 const f=stackFixture(t,false);let proc,done,finished=false;t.after(async()=>{if(proc&&!finished)proc.kill('SIGTERM');if(done)await done;fs.rmSync(f.directory,{recursive:true,force:true});});for(const spec of f.profile.services){const port=await freePort();spec.args=[String(port)];spec.ports=[port];spec.ready.port=port;}
 // Prepare a second fresh descriptor after choosing ephemeral ports; no binary/DB/dependency copies.
 const second=path.join(f.directory,'real-wrapper');fs.mkdirSync(second,{mode:0o700});save(f.profilePath,f.profile);const d=read(prepareStackService(f.profilePath,second,'pl.dynaminds.ecommerce.real-controlled-stack').descriptor),calls=[];
 const controlledLaunchctl=async args=>{calls.push(args[0]);return{code:0,stdout:'\tpath = '+d.plist.path+'\n\tstate = not running\n'};};
 await startService(d.descriptorPath,{platform:'darwin',launchctl:controlledLaunchctl});
 proc=spawn(process.execPath,[d.service.path,'run',d.descriptorPath],{env:{HOME:os.homedir(),PATH:'/usr/bin:/bin:/usr/sbin:/sbin'},stdio:['ignore','pipe','pipe']});let stderr='';proc.stderr.on('data',b=>stderr+=b);proc.stdout.resume();done=new Promise(resolve=>proc.once('close',(code,signal)=>resolve({code,signal})));done.then(()=>{finished=true;});
 let ready=false;const deadline=Date.now()+10000;while(Date.now()<deadline&&!finished){try{if((await serviceStatus(d.descriptorPath)).status==='READY'){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,40));}
 assert(ready,'controlled complete stack failed readiness: '+stderr);const owned=read(d.stackStatePath);assert.equal(owned.services.length,2);assert(owned.services.every(c=>c.birth&&c.status==='ready'));
 assert.equal((await stopService(d.descriptorPath,{platform:'darwin',launchctl:controlledLaunchctl})).status,'CLOSED_AND_UNREGISTERED');assert.deepEqual(await done,{code:0,signal:null});assert.deepEqual(calls,['bootstrap','print','bootout']);assert.equal((await serviceStatus(d.descriptorPath)).status,'CLOSED');
});
