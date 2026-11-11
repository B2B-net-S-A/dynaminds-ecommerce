/** Owned temporary files and real controlled Node children only. No app/PG/Main. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {createBoundedPrivateLogs,validateProfile,main} from './operator.mjs';
const operator=fileURLToPath(new URL('./operator.mjs',import.meta.url)),hash=b=>createHash('sha256').update(b).digest('hex');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function temp(t){const p=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'dyna-log208-'));await fs.chmod(p,0o700);t.after(()=>fs.rm(p,{recursive:true,force:true}));return p;}
async function until(fn){const end=Date.now()+10000;while(Date.now()<end){const result=await fn();if(result)return result;await wait(20);}throw Error('controlled log test deadline');}
async function freePort(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
async function absent(pid){try{process.kill(pid,0);return false;}catch(e){assert.equal(e.code,'ESRCH');return true;}}
async function verifyRing(snapshot,name,payload){
 const stream=snapshot[name];assert(stream.retained_bytes<=2*snapshot.segment_bytes);assert.equal(stream.bytes,payload.length);assert.equal(stream.sha256,hash(payload));
 const chunks=[];for(const slot of stream.slots.filter(s=>s.epoch!==null).sort((a,b)=>a.epoch-b.epoch)){
  const p=path.join(snapshot.directory,slot.file),b=await fs.readFile(p),s=await fs.lstat(p);
  assert.equal(s.mode&0o777,0o600);assert.equal(s.nlink,1);assert(!s.isSymbolicLink());assert.equal(b.length,slot.bytes);assert(b.length<=snapshot.segment_bytes);assert.equal(hash(b),slot.sha256);chunks.push(b);
 }
 const retained=Buffer.concat(chunks);assert.equal(retained.length,stream.retained_bytes);assert.deepEqual(retained,payload.subarray(payload.length-retained.length));
}
test('fixed inode ring caps both byte streams, preserves exact UTF8/binary suffix and never creates extra rotations',async t=>{
 const root=await temp(t),directory=path.join(root,'private.logs'),logs=createBoundedPrivateLogs(directory,1024);
 const out=Buffer.from(('PRIVATE_CONTROLLED_PAYLOAD:ą😀\0').repeat(570)),err=Buffer.from('Żółć💾'.repeat(420));
 logs.write('stdout',out.subarray(0,28));logs.write('stdout',out.subarray(28,29));logs.write('stdout',out.subarray(29));logs.write('stderr',err);logs.close();
 const s=logs.snapshot();assert.equal((await fs.lstat(directory)).mode&0o777,0o700);assert.equal(s.retained_bytes_max,4096);assert.deepEqual((await fs.readdir(directory)).sort(),['stderr.0.log','stderr.1.log','stdout.0.log','stdout.1.log']);
 await verifyRing(s,'stdout',out);await verifyRing(s,'stderr',err);assert.equal(s.error,null);assert.equal(s.close_unconfirmed,false);assert.throws(()=>logs.write('stdout',Buffer.from('late')),/already-closed/);logs.close();
});
test('existing/symlink log directories refuse without truncating any foreign member',async t=>{
 const root=await temp(t),existing=path.join(root,'foreign'),target=path.join(root,'alias');await fs.mkdir(existing,{mode:0o700});await fs.writeFile(path.join(existing,'stdout.0.log'),'KEEP',{mode:0o600});await fs.symlink(existing,target);
 for(const p of[existing,target])assert.throws(()=>createBoundedPrivateLogs(p,1024),{code:'EEXIST'});
 assert.equal(await fs.readFile(path.join(existing,'stdout.0.log'),'utf8'),'KEEP');assert.deepEqual(await fs.readdir(existing),['stdout.0.log']);
});
test('unsafe limit or writable parent refuses before creating logs',async t=>{
 const root=await temp(t);for(const n of[0,1023,1048577,Infinity,NaN,'1024'])assert.throws(()=>createBoundedPrivateLogs(path.join(root,'bad'),n));
 await fs.chmod(root,0o777);assert.throws(()=>createBoundedPrivateLogs(path.join(root,'bad'),1024),/owned-log-parent/);await fs.chmod(root,0o700);assert.deepEqual(await fs.readdir(root),[]);
});
async function model(t,{mode='burst',fault=false,stateFault=false,chmodFault=false}={}){
 const root=await temp(t),release=path.join(root,'release'),runtime=path.join(release,'runtime/server'),images=path.join(root,'images');await fs.mkdir(runtime,{recursive:true,mode:0o700});await fs.mkdir(images,{mode:0o700});
 const manifest=Buffer.from('{"controlled_fixture_only":true}'),revision=hash(manifest),configuration=path.join(root,'config.private.json'),selection=path.join(root,'selection.private.json'),profile=path.join(root,'profile.private.json'),state=path.join(root,'state.private.json'),trace=path.join(root,'trace.private.json');
 await fs.writeFile(path.join(release,'release.json'),manifest);await fs.writeFile(configuration,'{}',{mode:0o600});const port=await freePort();
 const selected={releaseDirectory:release,manifestSha:revision,revision,expectedOwner:'postgres',localConfigurationPath:configuration,databaseUrl:'postgres://postgres@127.0.0.1:57001/controlled_no_connection'};const selectedBytes=Buffer.from(JSON.stringify(selected));await fs.writeFile(selection,selectedBytes,{mode:0o600});
 const value={schema:'dynaminds-local-operator/v1',selectionPath:selection,selectionSha:hash(selectedBytes),releaseDirectory:release,manifestSha:revision,revision,configurationPath:configuration,database:'controlled_no_connection',pgPort:57001,httpPort:port,cwd:root,imageDirectory:images,flags:['--verified-stock-writers'],logBytes:1024};await fs.writeFile(profile,JSON.stringify(value),{mode:0o600});assert.deepEqual(validateProfile(value),value);
 const payload=Buffer.from('PRIVATE_CONTROLLED_PAYLOAD:ą😀\0'.repeat(2500)),errorPayload=Buffer.from('PRIVATE_CONTROLLED_STDERR:💾'.repeat(2400));
 const code=`import fs from'node:fs';import http from'node:http';
const selected=JSON.parse(fs.readFileSync(process.argv[2])),trace=${JSON.stringify(trace)},mode=${JSON.stringify(mode)};
const out=Buffer.from(${JSON.stringify(payload.toString('base64'))},'base64'),err=Buffer.from(${JSON.stringify(errorPayload.toString('base64'))},'base64');
let stops=0,closing=false;const server=http.createServer((q,r)=>r.end(JSON.stringify({status:'ok',revision:selected.revision})));
const event=(phase)=>fs.writeFileSync(trace,JSON.stringify({phase,pid:process.pid,stops}),{mode:0o600});
process.on('SIGTERM',()=>{stops++;if(closing)return;closing=true;event('stopping');setTimeout(()=>server.close(()=>process.stdout.write('TERMINAL_CLOSE\\n',()=>process.exit(0))),mode==='delayed-stop'?1500:0);});
server.listen(Number(process.argv[4]),'127.0.0.1',async()=>{event('listening');if(mode==='quiet'){event('ready');return;}
 await new Promise((r,j)=>process.stdout.write(out.subarray(0,29),e=>e?j(e):r()));
 await new Promise((r,j)=>process.stdout.write(out.subarray(29),e=>e?j(e):r()));
 await new Promise((r,j)=>process.stderr.write(err,e=>e?j(e):r()));event('ready');if(mode==='exit7')setTimeout(()=>server.close(()=>process.exit(7)),100);
});`;
 await fs.writeFile(path.join(runtime,'ordinary-local-cli.mjs'),code,{mode:0o600});
 let command=[operator,'start',profile,state];
 if(fault){
  const bootstrap=path.join(root,'fault.mjs');await fs.writeFile(bootstrap,`import fs from'node:fs';const write=fs.writeSync,close=fs.closeSync,open=fs.openSync,writeFile=fs.writeFileSync,chmod=fs.fchmodSync;let failed=false,closeFailed=false,stateFailed=false;const logs=new Set();
fs.openSync=function(p,...args){const fd=open.call(this,p,...args);if(typeof p==='string'&&/\\.logs\\/(?:stdout|stderr)\\.[01]\\.log$/.test(p))logs.add(fd);return fd;};
fs.writeSync=function(fd,...args){if(logs.has(fd)&&!failed){failed=true;throw Object.assign(Error('controlled disk full'),{code:'ENOSPC'});}return write.call(this,fd,...args);};
fs.closeSync=function(fd){const result=close.call(this,fd);if(logs.has(fd)&&!closeFailed){closeFailed=true;throw Object.assign(Error('controlled close uncertainty'),{code:'EIO'});}return result;};
fs.writeFileSync=function(p,data,...args){if(${stateFault}&&!stateFailed&&typeof p==='string'&&/\\.closed-\\d+-draining$/.test(p)){stateFailed=true;writeFile.call(this,p,'{',...args);throw Object.assign(Error('controlled state disk full'),{code:'ENOSPC'});}return writeFile.call(this,p,data,...args);};
fs.fchmodSync=function(fd,mode){if(${chmodFault}&&mode===0o400)throw Object.assign(Error('controlled metadata disk full'),{code:'ENOSPC'});return chmod.call(this,fd,mode);};
const{main}=await import(${JSON.stringify(new URL('./operator.mjs',import.meta.url).href)});try{await main(${JSON.stringify(['start',profile,state])});process.exitCode=99;}catch(e){process.stderr.write(JSON.stringify({code:e.code})+'\\n');process.exitCode=1;}`);
  command=[bootstrap];
 }
 const child=spawn(process.execPath,command,{cwd:root,env:{PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR},stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);const done=new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal,stdout,stderr})));
 t.after(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');await done;});
 return{root,child,done,state,profile,trace,port,payload,errorPayload,async readState(){try{return JSON.parse(await fs.readFile(state,'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}},async ready(){return until(async()=>{try{const x=JSON.parse(await fs.readFile(trace,'utf8'));return x.phase==='ready'&&x;}catch(e){if(e.code==='ENOENT')return false;throw e;}});}};
}
test('real operator rotates noisy children without stopping them and forwards only bounded lifecycle JSON',async t=>{
 const m=await model(t),trace=await m.ready();assert.equal(await absent(trace.pid),false);m.child.kill('SIGTERM');const result=await m.done;assert.equal(result.code,0);assert.equal(result.signal,null);assert(!result.stdout.includes('PRIVATE_CONTROLLED')&&!result.stderr.includes('PRIVATE_CONTROLLED'));assert(result.stdout.length<8192);
 const s=await m.readState();assert.equal(s.status,'closed');assert.equal(s.exit_code,0);assert.equal(s.signal,null);assert.equal(s.error,null);assert.equal(s.logs.close_unconfirmed,false);assert.equal((await fs.lstat(m.state)).mode&0o777,0o600);
 await verifyRing(s.logs,'stdout',Buffer.concat([m.payload,Buffer.from('TERMINAL_CLOSE\n')]));await verifyRing(s.logs,'stderr',m.errorPayload);assert(await absent(trace.pid));
 const server=net.createServer();await new Promise((r,j)=>{server.once('error',j);server.listen(m.port,'127.0.0.1',r);});await new Promise(r=>server.close(r));assert.equal(JSON.parse(await fs.readFile(m.trace,'utf8')).stops,1);
});
test('actual nonzero child exit remains visible after bounded log capture',async t=>{
 const m=await model(t,{mode:'exit7'});const result=await m.done;assert.equal(result.code,1);assert.equal(result.signal,null);const s=await m.readState();assert.equal(s.status,'closed');assert.equal(s.exit_code,7);assert.equal(s.signal,null);assert(s.logs.stdout.bytes>2*s.logs.segment_bytes);assert(await absent(s.birth.pid));
});
test('real log ENOSPC plus close failure preserves first error and drains/joins the owned child',async t=>{
 const m=await model(t,{fault:true}),result=await m.done;assert.equal(result.code,1);assert.equal(result.signal,null);assert(result.stderr.includes('ENOSPC'));assert(!result.stdout.includes('PRIVATE_CONTROLLED')&&!result.stderr.includes('PRIVATE_CONTROLLED'));
 const s=await m.readState();assert.equal(s.status,'closed');assert.equal(s.exit_code,0);assert.equal(s.signal,null);assert.equal(s.error.code,'ENOSPC');assert.equal(s.logs.error.code,'ENOSPC');assert.equal(s.logs.close_unconfirmed,true);assert(await absent(s.birth.pid));assert.equal(JSON.parse(await fs.readFile(m.trace,'utf8')).stops,1);
});
test('closed supervisor output preserves EPIPE and cannot orphan its owned child',async t=>{
 const m=await model(t,{mode:'quiet'});m.child.stdout.destroy();const result=await m.done;assert.equal(result.code,1);assert.equal(result.signal,null);assert(!result.stderr.includes('Unhandled'));
 const s=await m.readState();assert.equal(s.status,'closed');assert.equal(s.error.code,'EPIPE');assert(await absent(s.birth.pid));
});
test('log failure revokes readiness during live drain and keeps exact primary error until close',async t=>{
 const m=await model(t,{mode:'delayed-stop',fault:true});
 const draining=await until(async()=>{const s=await m.readState();return s?.status==='draining'&&s;});
 assert.equal(draining.error.code,'ENOSPC');assert.equal(await absent(draining.birth.pid),false);
 const status=await main(['status',m.profile,m.state]);assert.equal(status.status,'DRAINING');assert.equal(status.error.code,'ENOSPC');assert.equal(status.pid,draining.birth.pid);assert(!Object.hasOwn(status,'revision'));
 const stopping=main(['stop',m.profile,m.state]);await assert.rejects(stopping,/owned-child-exited-without-clean-close/);
 const result=await m.done;assert.equal(result.code,1);const s=await m.readState();assert.equal(s.status,'closed');assert.equal(s.error.code,'ENOSPC');assert.equal(s.exit_code,0);assert(await absent(s.birth.pid));assert.equal(JSON.parse(await fs.readFile(m.trace,'utf8')).stops,1);
});
test('operator stop joins the real owned child cleanly while bounded logs remain private',async t=>{
 const m=await model(t,{mode:'quiet'}),trace=await m.ready();
 const stopped=await main(['stop',m.profile,m.state]);assert.equal(stopped.status,'OWNED_APP_CLOSED');assert.equal(stopped.postgres_stopped,false);
 const result=await m.done;assert.equal(result.code,0);const s=await m.readState();assert.equal(s.status,'closed');assert.equal(s.error,null);assert.equal(s.logs.error,null);assert(await absent(trace.pid));assert.equal(JSON.parse(await fs.readFile(m.trace,'utf8')).stops,1);
});
test('state-temp ENOSPC makes ordinary readers refuse before delayed healthy child closes, then records exact closure',async t=>{
 const m=await model(t,{mode:'delayed-stop',fault:true,stateFault:true});
 await until(async()=>{try{return((await fs.lstat(m.state)).mode&0o777)===0o400;}catch(e){if(e.code==='ENOENT')return false;throw e;}});
 const invalidated=await m.readState();assert.equal(invalidated.status,'starting-or-running');assert.equal(await absent(invalidated.birth.pid),false);
 // The child is intentionally still healthy; rejection must come from state
 // invalidation rather than a coincidentally closed socket or process.
 const response=await fetch('http://127.0.0.1:'+m.port+'/api/health');assert.equal(response.status,200);await response.arrayBuffer();
 await assert.rejects(main(['status',m.profile,m.state]),/private-owned-regular-file-required/);
 const result=await m.done;assert.equal(result.code,1);const s=await m.readState();assert.equal(s.status,'closed');assert.equal(s.exit_code,0);assert.equal(s.signal,null);assert.equal(s.error.code,'ENOSPC');assert.equal(s.logs.error.code,'ENOSPC');assert(await absent(s.birth.pid));assert.equal((await fs.lstat(m.state)).mode&0o777,0o600);
 const temporary=(await fs.readdir(m.root)).filter(n=>n.startsWith('state.private.json.closed-'));assert.equal(temporary.length,1);assert(temporary[0].endsWith('-draining'));assert.equal(await fs.readFile(path.join(m.root,temporary[0]),'utf8'),'{');
});
test('failure of state allocation and metadata fallback remains explicit uncertainty without escalation',async t=>{
 const m=await model(t,{mode:'delayed-stop',fault:true,stateFault:true,chmodFault:true}),result=await m.done;
 assert.equal(result.code,1);const s=await m.readState();assert.equal(s.status,'closed');assert.equal(s.error.code,'ENOSPC');assert.equal(s.error.state_close_unconfirmed.code,'ENOSPC');assert.equal(s.exit_code,0);assert(await absent(s.birth.pid));assert.equal(JSON.parse(await fs.readFile(m.trace,'utf8')).stops,1);
});
test('final close refuses replacement of the explicitly invalidated state inode even with identical private JSON',async t=>{
 const m=await model(t,{mode:'delayed-stop',fault:true,stateFault:true});
 await until(async()=>{try{return((await fs.lstat(m.state)).mode&0o777)===0o400;}catch(e){if(e.code==='ENOENT')return false;throw e;}});
 const bytes=await fs.readFile(m.state),original=await fs.lstat(m.state),prior=JSON.parse(bytes);
 await fs.rename(m.state,m.state+'.held-original');await fs.writeFile(m.state,bytes,{mode:0o400,flag:'wx'});const replacement=await fs.lstat(m.state);assert.notEqual(replacement.ino,original.ino);
 const result=await m.done;assert.equal(result.code,1);assert(await absent(prior.birth.pid));
 assert.deepEqual(await fs.readFile(m.state),bytes);assert.equal((await fs.lstat(m.state)).ino,replacement.ino);assert.equal((await fs.lstat(m.state)).mode&0o777,0o400);
 assert.deepEqual(await fs.readFile(m.state+'.held-original'),bytes);await assert.rejects(main(['status',m.profile,m.state]),/private-owned-regular-file-required/);
});
