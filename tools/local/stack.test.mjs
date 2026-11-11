import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn,execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {validateStackProfile,stackStatus,stopStack,awaitStackReadiness} from './stack.mjs';

const entry=fileURLToPath(new URL('./stack.mjs',import.meta.url));
const sha=b=>createHash('sha256').update(b).digest('hex');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,ms=6000){const end=Date.now()+ms;while(Date.now()<end){const x=await fn();if(x)return x;await delay(20);}throw Error('controlled wait timeout');}
async function port(){const server=net.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const p=server.address().port;await new Promise(r=>server.close(r));return p;}
async function available(p){const server=net.createServer();try{await new Promise((r,j)=>{server.once('error',j);server.listen(p,'127.0.0.1',r);});return true;}catch{return false;}finally{if(server.listening)await new Promise(r=>server.close(r));}}
async function read(p){try{return JSON.parse(await fs.readFile(p,'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}}
const fixture=`import fs from 'node:fs';import http from 'node:http';import https from 'node:https';
const [id,p,mode,trace]=process.argv.slice(2);const event=k=>fs.appendFileSync(trace,id+':'+k+'\\n');
if(process.env.DATABASE_URL||process.env.NODE_OPTIONS||process.env.DYNA_SECRET_TEST){process.exit(66);}
event('start');let closing=false,timer;const handler=(req,res)=>{if(mode==='slow-body'){res.writeHead(200);timer=setInterval(()=>res.write(' '),100);return;}if(mode==='late-success'){setTimeout(()=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({status:'ok'}));},450);return;}res.writeHead(mode==='wrong-status'?503:200,{'content-type':'application/json'});res.end(JSON.stringify({status:'ok',revision:'synthetic'}));};const server=process.env.DYNA_TEST_TLS_KEY?https.createServer({key:fs.readFileSync(process.env.DYNA_TEST_TLS_KEY),cert:fs.readFileSync(process.env.DYNA_TEST_TLS_CA)},handler):http.createServer(handler);
const close=()=>{if(closing)return;closing=true;event('stop');clearInterval(timer);if(mode==='late-exit'){setTimeout(()=>{server.close();process.exit(0);},700);return;}if(server.listening)server.close(()=>process.exit(0));else process.exit(0);};
process.on('SIGTERM',close);process.on('SIGINT',close);
if(mode==='exit'){event('exit');process.exit(0);}else if(mode==='never')setInterval(()=>{},1000);else if(mode==='delayed')setTimeout(()=>{if(!closing)server.listen(Number(p),'127.0.0.1');},1000);else server.listen(Number(p),'127.0.0.1');
if(mode==='spam')setTimeout(()=>process.stderr.write('PRIVATE_SYNTHETIC_SECRET'.repeat(200)),10);
if(mode==='crash-later')setTimeout(()=>process.exit(7),450);
`;
async function model(t,modes=['normal']){
 const dir=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'dyna-stack-'));await fs.chmod(dir,0o700);
 const script=path.join(dir,'service.mjs'),trace=path.join(dir,'trace.txt'),profile=path.join(dir,'profile.json'),state=path.join(dir,'state.json');await fs.writeFile(script,fixture,{mode:0o600});
 const services=[];for(let i=0;i<modes.length;i++){const p=await port();services.push({id:'service-'+i,entry:{path:script,sha256:sha(fixture)},imports:[],args:['service-'+i,String(p),modes[i],trace],cwd:dir,envPaths:{},files:[],ports:[p],ready:{kind:'http',port:p,path:'/health',status:200,json:{status:'ok'},ca:null}});}
 const value={schema:'dynaminds-local-stack/v1',services,startupMs:1300,shutdownMs:1500,logBytes:4096};
 const save=()=>fs.writeFile(profile,JSON.stringify(value),{mode:0o600});await save();
 const executions=[];const run=()=>{const child=spawn(process.execPath,[entry,'start',profile,state],{env:{...process.env,DATABASE_URL:'postgres://SYNTHETIC_ONLY',DYNA_SECRET_TEST:'PRIVATE_SYNTHETIC_SECRET',NODE_OPTIONS:''},stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);const done=new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal,stdout,stderr})));executions.push({child,done});return{child,done};};
 t.after(async()=>{for(const x of executions){if(x.child.exitCode===null&&x.child.signalCode===null)x.child.kill('SIGTERM');await x.done;}await fs.rm(dir,{recursive:true,force:true});});
 return{dir,script,trace,profile,state,value,save,run,async ready(){return until(async()=>{const s=await read(state);return s?.status==='ready'&&s;});},async events(){return(await fs.readFile(trace,'utf8')).trim().split('\n');}};
}
test('profile grammar is inert and rejects unknown keys, duplicate ports, remote readiness and env injection',()=>{
 const base={schema:'dynaminds-local-stack/v1',services:[{id:'app',entry:{path:'/synthetic/app.mjs',sha256:'a'.repeat(64)},imports:[],args:[],cwd:'/synthetic',envPaths:{},files:[],ports:[4100],ready:{kind:'http',port:4100,path:'/health',status:200,json:{status:'ok'},ca:null}}],startupMs:1000,shutdownMs:1000,logBytes:1024};
 assert.deepEqual(validateStackProfile(base),base);
 assert.equal(validateStackProfile({...base,startupMs:900000}).startupMs,900000);assert.throws(()=>validateStackProfile({...base,startupMs:900001}));
 for(const mutate of [x=>x.extra=true,x=>x.services.push({...x.services[0],id:'other'}),x=>x.services[0].ready.host='example.com',x=>x.services[0].ready.path='//example.com',x=>x.services[0].envPaths.DATABASE_URL={path:'/secret',sha256:'a'.repeat(64)},x=>x.services[0].args=['postgres://user:secret@remote/db']]){const x=structuredClone(base);mutate(x);assert.throws(()=>validateStackProfile(x));}
});
test('real two-service readiness/status/reverse clean stop, clean env, one owned state and idempotent stop',async t=>{
 const m=await model(t,['normal','normal']);const x=m.run();await m.ready();const status=await stackStatus(m.profile,m.state);assert.equal(status.status,'ready');assert(status.services.every(v=>v.live&&v.ready));
 assert.equal((await fs.stat(m.state)).mode&0o777,0o600);const closed=await stopStack(m.profile,m.state);assert.equal(closed.status,'LOCAL_STACK_CLOSED');assert.equal((await x.done).code,0);assert.equal((await stopStack(m.profile,m.state)).already_closed,true);
 assert.deepEqual((await m.events()).filter(v=>v.endsWith(':stop')),['service-1:stop','service-0:stop']);for(const s of m.value.services)assert(await available(s.ports[0]));assert.equal((await read(m.state)).PG_managed,false);
});
test('duplicate occupied port is detected before ANY child, no retry or foreign process signal',async t=>{
 const m=await model(t,['normal','normal']);const server=net.createServer();await new Promise(r=>server.listen(m.value.services[1].ports[0],'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const x=m.run();assert.equal((await x.done).code,1);assert.equal((await read(m.state)).error.code,'PORT_OCCUPIED');await assert.rejects(fs.stat(m.trace),{code:'ENOENT'});assert(server.listening);
});
test('later readiness timeout drains already-ready plus starting service in reverse order',async t=>{
 const m=await model(t,['normal','never']);m.value.startupMs=1300;await m.save();const x=m.run();const out=await x.done;assert.equal(out.code,1);const s=await read(m.state);assert.equal(s.error.code,'READINESS_TIMEOUT');assert.equal(s.status,'closed');assert.equal(s.services.length,2);assert(s.services.every(v=>v.exit_code===0&&v.signal===null));assert.deepEqual((await m.events()).filter(v=>v.endsWith(':stop')),['service-1:stop','service-0:stop']);assert(!out.stderr.includes('PRIVATE_SYNTHETIC_SECRET'));
});
test('early child exit stops the stack and closes previous dependencies without spawning subsequent services',async t=>{
 const m=await model(t,['normal','exit','normal']);const x=m.run();assert.equal((await x.done).code,1);const s=await read(m.state);assert(s.error);assert(s.services.every(v=>v.status==='closed'));const ev=await m.events();assert(!ev.includes('service-2:start'));assert(ev.includes('service-0:stop'));
});
test('SIGTERM received during readiness is remembered; no next service or restart',async t=>{
 const m=await model(t,['delayed','normal']);const x=m.run();await until(async()=>{try{return(await m.events()).includes('service-0:start');}catch{return false;}});x.child.kill('SIGTERM');assert.equal((await x.done).code,0);const ev=await m.events();assert.deepEqual(ev,['service-0:start','service-0:stop']);assert.equal((await read(m.state)).status,'closed');
});
test('log overflow is hashed/capped without exposing child payload and cleanly drains service',async t=>{
 const m=await model(t,['spam']);m.value.logBytes=1024;await m.save();const x=m.run();const out=await x.done;assert.equal(out.code,1);assert(!out.stdout.includes('PRIVATE_SYNTHETIC_SECRET')&&!out.stderr.includes('PRIVATE_SYNTHETIC_SECRET'));const s=await read(m.state);assert.equal(s.error.code,'CHILD_LOG_LIMIT');assert.equal(s.services[0].stderr.hashed_bytes,1024);assert(s.services[0].stderr.bytes>1024);assert.equal(s.services[0].exit_code,0);
});
test('profile drift refuses stop before signalling; authentic original profile remains usable',async t=>{
 const m=await model(t);const x=m.run();await m.ready();m.value.logBytes++;await m.save();await assert.rejects(()=>stopStack(m.profile,m.state));assert.equal((await read(m.state)).status,'ready');m.value.logBytes--;await m.save();await stopStack(m.profile,m.state);assert.equal((await x.done).code,0);
});
test('changed supervisor birth refuses signals; restoring the exact original state permits normal stop',async t=>{
 const m=await model(t);const x=m.run();await m.ready();const bytes=await fs.readFile(m.state);const changed=JSON.parse(bytes);changed.supervisor.command_sha256='0'.repeat(64);await fs.writeFile(m.state,JSON.stringify(changed));await assert.rejects(()=>stopStack(m.profile,m.state));assert.equal((await read(m.state)).status,'ready');await fs.writeFile(m.state,bytes);await stopStack(m.profile,m.state);assert.equal((await x.done).code,0);
});
test('acknowledged nonzero child close preserves its failure without claiming unconfirmed cleanup',async t=>{
 const m=await model(t,['normal','crash-later']);const x=m.run();await m.ready();assert.equal((await x.done).code,1);const s=await read(m.state);assert.equal(s.error.code,'CHILD_EXITED');assert.equal(s.services[1].exit_code,7);assert.equal(s.services[0].exit_code,0);assert((await m.events()).includes('service-0:stop'));
 assert.equal(s.status,'closed');assert.deepEqual(s.cleanup,[]);assert(s.services.every(v=>v.status==='closed'&&v.signal===null));
 const observed=await stackStatus(m.profile,m.state);assert.equal(observed.status,'CLOSED');assert.equal(observed.error.code,'CHILD_EXITED');assert.deepEqual(observed.cleanup,[]);
 await assert.rejects(()=>stopStack(m.profile,m.state),/previous-close-was-not-clean/,'acknowledged failure must not become successful idempotent stop');
 for(const service of s.services){let gone=false;try{process.kill(service.birth.pid,0);}catch(e){if(e.code==='ESRCH')gone=true;else throw e;}assert(gone,'close ACK must correspond to an absent owned child');}
});
test('late drain is NOT clean and no forced kill is sent',async t=>{
 const m=await model(t,['late-exit']);m.value.shutdownMs=100;await m.save();const x=m.run();await m.ready();x.child.kill('SIGTERM');await until(async()=>{const s=await read(m.state);return s?.status==='close-unconfirmed';});const out=await x.done;assert.equal(out.code,1);const s=await read(m.state);assert.equal(s.error.code,'SHUTDOWN_UNCONFIRMED');assert.equal(s.services[0].signal,null);assert.equal((await m.events()).filter(v=>v==='service-0:stop').length,1);
});
test('HTTP probe has a whole-response deadline even when a fixture continuously sends bytes',async t=>{
 const m=await model(t,['slow-body']);m.value.startupMs=100;await m.save();const x=m.run();const out=await x.done;assert.equal(out.code,1);assert.equal((await read(m.state)).error.code,'READINESS_TIMEOUT');
});
test('pinned entry/config verification precedes all child creation; envPaths contain only file/directory paths',async t=>{
 const m=await model(t);const cfg=path.join(m.dir,'private-config.json');await fs.writeFile(cfg,'{"synthetic":true}',{mode:0o600});m.value.services[0].envPaths={DYNA_LOCAL_CONFIG_PATH:{path:cfg,sha256:sha('{"synthetic":true}')},DYNA_IMAGE_DIR:{path:m.dir,kind:'directory'}};await m.save();const x=m.run();await m.ready();await stopStack(m.profile,m.state);assert.equal((await x.done).code,0);
 const bad=await model(t);bad.value.services[0].entry.sha256='0'.repeat(64);await bad.save();assert.equal((await bad.run().done).code,1);await assert.rejects(fs.stat(bad.trace),{code:'ENOENT'});
});
test('public profile permissions and a reused owned state refuse without a second child start',async t=>{
 const bad=await model(t);await fs.chmod(bad.profile,0o644);assert.equal((await bad.run().done).code,1);await assert.rejects(fs.stat(bad.trace),{code:'ENOENT'});await assert.rejects(fs.stat(bad.state),{code:'ENOENT'});
 const m=await model(t);const x=m.run();await m.ready();await stopStack(m.profile,m.state);assert.equal((await x.done).code,0);const prior=await fs.readFile(m.state,'utf8');assert.equal((await m.run().done).code,1);assert.equal(await fs.readFile(m.state,'utf8'),prior);assert.equal((await m.events()).filter(v=>v==='service-0:start').length,1);
});
test('successful HTTP response after startup deadline cannot announce ready',async t=>{
 const m=await model(t,['late-success']);m.value.startupMs=300;await m.save();const x=m.run();const out=await x.done;
 assert.equal(out.code,1);assert(!out.stdout.includes('LOCAL_STACK_READY'));const state=await read(m.state);
 assert.equal(state.error.code,'READINESS_TIMEOUT');assert.equal(state.status,'closed');
 // SIGTERM may precede the fixture's JS handler on a loaded host. Its observed
 // close still confirms cleanup; READINESS_TIMEOUT remains the primary failure.
 assert.deepEqual(state.cleanup,[]);assert(state.services.every(v=>v.status==='closed'));
});
test('HTTPS status uses the pinned CA bytes and refuses later content or symlink drift',async t=>{
 const m=await model(t);const config=path.join(m.dir,'tls.cnf'),key=path.join(m.dir,'key.pem'),cert=path.join(m.dir,'ca.pem');
 await fs.writeFile(config,'[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=v3\n[dn]\nCN=localhost\n[v3]\nbasicConstraints=critical,CA:TRUE\nsubjectAltName=DNS:localhost\nkeyUsage=critical,digitalSignature,keyEncipherment,keyCertSign\nextendedKeyUsage=serverAuth\n',{mode:0o600});
 execFileSync('/usr/bin/openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-config',config,'-keyout',key,'-out',cert],{stdio:'ignore'});
 await fs.chmod(key,0o600);await fs.chmod(cert,0o600);const bytes=await fs.readFile(cert),keyBytes=await fs.readFile(key),ca={path:cert,sha256:sha(bytes)};
 const service=m.value.services[0];service.envPaths={DYNA_TEST_TLS_KEY:{path:key,sha256:sha(keyBytes)},DYNA_TEST_TLS_CA:ca};keyBytes.fill(0);service.ready.kind='https';service.ready.ca=ca;await m.save();const x=m.run();await m.ready();assert((await stackStatus(m.profile,m.state)).services[0].ready);
 await fs.writeFile(cert,'changed certificate');await assert.rejects(()=>stackStatus(m.profile,m.state),/pinned-file-changed/);await fs.writeFile(cert,bytes);
 const retained=path.join(m.dir,'retained-ca.pem');await fs.rename(cert,retained);await fs.symlink(retained,cert);await assert.rejects(()=>stackStatus(m.profile,m.state));await fs.unlink(cert);await fs.rename(retained,cert);
 assert((await stackStatus(m.profile,m.state)).services[0].ready);await stopStack(m.profile,m.state);assert.equal((await x.done).code,0);
});
test('closed supervisor stdout drains owned children, preserves EPIPE and leaves no orphan',async t=>{
 const m=await model(t,['normal','normal']);const x=m.run();x.child.stdout.destroy();
 const out=await x.done;assert.equal(out.code,1);assert.equal(out.signal,null);assert(!out.stderr.includes('Unhandled'));
 const s=await read(m.state);assert.equal(s.status,'closed');assert.equal(s.error.code,'EPIPE');assert.deepEqual(s.cleanup,[]);
 assert.equal(s.services.length,2);assert(s.services.every(v=>v.status==='closed'&&v.exit_code===0&&v.signal===null));
 assert.deepEqual((await m.events()).filter(v=>v.endsWith(':stop')),['service-1:stop','service-0:stop']);
 for(const service of m.value.services)assert(await available(service.ports[0]));
 for(const service of s.services){let gone=false;try{process.kill(service.birth.pid,0);}catch(e){if(e.code==='ESRCH')gone=true;else throw e;}assert(gone,'owned child must be absent after supervisor exit');}
});

test('successful probe completing beyond its whole startup budget is rejected deterministically',async()=>{
 let time=0,calls=0;
 await assert.rejects(()=>awaitStackReadiness({startupMs:300,now:()=>time,stopped:()=>false,probe:async()=>{calls++;time=450;return true;},wait:async()=>assert.fail('no second probe')}),{code:'READINESS_TIMEOUT'});
 assert.equal(calls,1);
 time=0;calls=0;
 await awaitStackReadiness({startupMs:300,now:()=>time,stopped:()=>false,probe:async()=>{calls++;time=250;return true;},wait:async()=>assert.fail('ready requires no wait')});assert.equal(calls,1);
});
test('owned atomic state replacement is read again, while repeated replacement remains bounded',async t=>{
 const m=await model(t);const x=m.run();await m.ready();
 const original=fsSync.readFileSync;let replacements=0,limit=1;
 fsSync.readFileSync=function(file,...args){
  if(typeof file==='number'){
   const open=fsSync.fstatSync(file),live=fsSync.lstatSync(m.state);
   if(open.ino===live.ino&&replacements<limit){
    const bytes=original.call(fsSync,file),tmp=m.state+'.controlled-replacement';
    fsSync.writeFileSync(tmp,bytes,{mode:0o600,flag:'wx'});fsSync.renameSync(tmp,m.state);replacements++;return bytes;
   }
  }
  return original.call(fsSync,file,...args);
 };
 try{
  assert.equal((await stackStatus(m.profile,m.state)).status,'ready');assert.equal(replacements,1);
  replacements=0;limit=10;await assert.rejects(()=>stackStatus(m.profile,m.state));assert.equal(replacements,4,'state read must stop after four snapshots');
 }finally{fsSync.readFileSync=original;}
 assert.equal((await stackStatus(m.profile,m.state)).status,'ready');await stopStack(m.profile,m.state);assert.equal((await x.done).code,0);
});
