/** Real service child processes + Unix control + loopback TCP + durable files.
 * Synthetic .test messages only; no app/worker/PG/provider acceptance. */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
const entry=fileURLToPath(new URL('../tools/local/smtp-ack-fixture-service.mjs',import.meta.url));
const body='From: sender@fixture.test\r\nTo: buyer@fixture.test\r\nSubject: synthetic private body\r\n\r\nDO_NOT_PRINT_SYNTHETIC_MAIL_BODY\r\n';
async function setup(t){
 const base=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'ack-svc-'))),directory=path.join(base,'service'),children=[];let seq=0;
 t.after(async()=>{for(const p of children)if(p.exitCode===null&&p.signalCode===null){p.kill('SIGTERM');await p.terminal;}await fs.rm(base,{recursive:true,force:true});});
 function launch(args,selectedEntry=entry){
  const child=spawn(process.execPath,[selectedEntry,...args],{stdio:['ignore','pipe','pipe']});children.push(child);let out='',err='';
  child.stdout.on('data',b=>{out+=b;assert(out.length<8192);});child.stderr.on('data',b=>{err+=b;assert(err.length<8192);});
  child.terminal=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal,out,err}));});return child;
 }
 async function start(){
  const child=launch(['start',directory]);
  for(let i=0;i<300;i++){
   try{const state=JSON.parse(await fs.readFile(path.join(directory,'state.json'),'utf8'));if(state.status==='READY'&&state.pid===child.pid)return{child,address:state.address};}catch(e){if(e.code!=='ENOENT'&&!(e instanceof SyntaxError))throw e;}
   if(child.exitCode!==null)assert.fail('service start refused');await delay(10);
  }assert.fail('service readiness deadline');
 }
 async function command(command,id,{expect=0,output}={}){
  output??=path.join(base,'result-'+(++seq)+'.json');const child=launch(['command',directory,command,output,...(id?[id]:[])]),r=await child.terminal;
  assert.equal(r.code,expect,r.err);assert.equal(r.signal,null);assert(!r.out.includes('DO_NOT_PRINT_SYNTHETIC_MAIL_BODY'));
  if(expect)return{...r,output};const stats=await fs.stat(output);assert.equal(stats.mode&0o777,0o600);return{...r,output,value:JSON.parse(await fs.readFile(output,'utf8'))};
 }
 async function until(fn){for(let i=0;i<200;i++){const x=await fn();if(x)return x;await delay(10);}assert.fail('condition deadline');}
 return{base,directory,start,command,launch,until};
}
async function smtp(t,address){
 const socket=net.createConnection(address.port,address.host),lines=[],waiters=[];let buffer='',closed=false;
 socket.on('error',()=>{});socket.on('data',b=>{buffer+=b;while(buffer.includes('\r\n')){const at=buffer.indexOf('\r\n');lines.push(buffer.slice(0,at));buffer=buffer.slice(at+2);}drain();});
 function drain(){while(waiters.length&&(lines.length||closed)){const w=waiters.shift();clearTimeout(w.timer);closed&&!lines.length?w.reject(Error('SMTP socket closed')):w.resolve(lines.shift());}}
 const ended=new Promise(resolve=>socket.once('close',()=>{closed=true;drain();resolve();}));
 const next=()=>new Promise((resolve,reject)=>{const w={resolve,reject,timer:setTimeout(()=>reject(Error('SMTP deadline')),5000)};waiters.push(w);drain();});
 const send=async(text,code)=>{socket.write(text+'\r\n');assert.equal((await next()).slice(0,3),String(code));};
 t.after(()=>socket.destroy());assert.equal((await next()).slice(0,3),'220');await send('HELO fixture.test',250);await send('MAIL FROM:<sender@fixture.test>',250);await send('RCPT TO:<buyer@fixture.test>',250);await send('DATA',354);socket.write(body+'.\r\n');return{socket,next,ended,lines};
}
async function stored(q){return q.until(async()=>{const r=await q.command('inspect');return r.value.result.pending_ack_ids[0];});}
async function rawControl(directory,bytes){
 return new Promise((resolve,reject)=>{const socket=net.createConnection(path.join(directory,'control.sock'));let value='';socket.setTimeout(5000,()=>{socket.destroy();reject(Error('control deadline'));});socket.once('error',reject);socket.once('connect',()=>socket.write(bytes));socket.on('data',b=>value+=b);socket.once('end',()=>{socket.destroy();resolve(JSON.parse(value));});});
}

test('real service process holds durable DATA, private read never prints body, release and close confirm lifecycle',{timeout:15000},async t=>{
 const q=await setup(t),s=await q.start();assert.equal(s.address.host,'127.0.0.1');assert(s.address.port>=1024&&s.address.port!==1025);
 assert.equal((await fs.stat(path.join(q.directory,'control.sock'))).mode&0o777,0o600);
 const c=await smtp(t,s.address),id=await stored(q);await delay(30);assert.deepEqual(c.lines,[]);
 const read=await q.command('read',id);assert(Buffer.from(read.value.result.raw_base64,'base64').toString('utf8').includes('DO_NOT_PRINT_SYNTHETIC_MAIL_BODY'));assert(!read.out.includes('raw_base64'));
 assert.equal((await fs.stat(path.join(q.directory,'mailbox','effect-'+id+'.json'))).mode&0o777,0o600);
 await q.command('release',id);assert.equal((await c.next()).slice(0,3),'250');c.socket.destroy();await c.ended;
 const list=await q.command('list');assert.equal(list.value.result[0].decision,'RELEASE_250_REQUESTED');
 const close=await q.command('close');assert.equal(close.value.result.final_state_requires_process_exit,true);const terminal=await s.child.terminal;assert.equal(terminal.code,0);assert.equal(terminal.signal,null);
 const state=JSON.parse(await fs.readFile(path.join(q.directory,'state.json'),'utf8'));assert.equal(state.status,'CLOSED');assert.equal(state.control_closed,true);assert.equal(state.fixture_closed,true);
 await assert.rejects(fs.lstat(path.join(q.directory,'control.sock')),{code:'ENOENT'});await assert.rejects(fs.lstat(path.join(q.directory,'owner.lock')),{code:'ENOENT'});
});

test('dropACK retained across clean process restart; no replay or receiver dedupe is invented',{timeout:15000},async t=>{
 const q=await setup(t),first=await q.start(),c=await smtp(t,first.address),id=await stored(q);await q.command('drop',id);await c.ended;assert.deepEqual(c.lines,[]);
 await q.command('close');assert.equal((await first.child.terminal).code,0);
 const second=await q.start(),list=await q.command('list');assert.equal(list.value.result.length,1);assert.equal(list.value.result[0].id,id);assert.equal(list.value.result[0].decision,'DROP_CONNECTION_WITHOUT_ACK');
 const inspect=await q.command('inspect');assert.equal(inspect.value.result.stored,1);assert.deepEqual(inspect.value.result.pending_ack_ids,[]);assert.equal(inspect.value.result.dedupe,false);
 await q.command('release',id,{expect:1});assert.equal((await q.command('list')).value.result.length,1);await q.command('close');assert.equal((await second.child.terminal).code,0);
});

test('one owner, closed protocol, request bounds and exclusive output refuse without a repeated decision',{timeout:15000},async t=>{
 const q=await setup(t),s=await q.start(),duplicate=q.launch(['start',q.directory]);assert.equal((await duplicate.terminal).code,1);assert.equal((await q.command('inspect')).value.result.closed,false);
 assert.deepEqual(await rawControl(q.directory,'{"command":"unknown"}\n'),{ok:false,error:'CONTROL_REFUSED'});
 assert.deepEqual(await rawControl(q.directory,'{"command":"inspect","extra":true}\n'),{ok:false,error:'CONTROL_REFUSED'});
 assert.deepEqual(await rawControl(q.directory,'x'.repeat(4097)),{ok:false,error:'REQUEST_TOO_LARGE'});
 const c=await smtp(t,s.address),id=await stored(q),output=path.join(q.base,'existing.json');await fs.writeFile(output,'PRESERVE',{mode:0o600});
 await q.command('drop',id,{expect:1,output});assert.equal(await fs.readFile(output,'utf8'),'PRESERVE');assert.deepEqual(c.lines,[]);assert.equal((await q.command('list')).value.result[0].decision,null);
 await q.command('drop',id);await c.ended;await q.command('close');assert.equal((await s.child.terminal).code,0);
});

test('SIGTERM with held ACK closes only owned sockets and preserves one durable effect for restart',{timeout:15000},async t=>{
 const q=await setup(t),s=await q.start(),c=await smtp(t,s.address),id=await stored(q);s.child.kill('SIGTERM');const terminal=await s.child.terminal;await c.ended;assert.equal(terminal.code,0);assert.equal(terminal.signal,null);assert.deepEqual(c.lines,[]);
 const next=await q.start();assert.equal((await q.command('read',id)).value.result.id,id);assert.equal((await q.command('list')).value.result[0].decision,null);assert.deepEqual((await q.command('inspect')).value.result.pending_ack_ids,[]);await q.command('close');assert.equal((await next.child.terminal).code,0);
});

test('stale durable owner and permissive or symlink control paths refuse without cleanup guesses',{timeout:15000},async t=>{
 const q=await setup(t);await fs.mkdir(q.directory,{mode:0o700});const stale={schema:'dynaminds-smtp-ack-service-owner/v1',pid:999999,nonce:'12345678-1234-4234-8234-123456789abc'};await fs.writeFile(path.join(q.directory,'owner.lock'),JSON.stringify(stale),{mode:0o600});
 assert.equal((await q.launch(['start',q.directory]).terminal).code,1);assert.deepEqual(JSON.parse(await fs.readFile(path.join(q.directory,'owner.lock'),'utf8')),stale);
 await fs.unlink(path.join(q.directory,'owner.lock'));const s=await q.start();await fs.chmod(q.directory,0o755);await q.command('inspect',undefined,{expect:1});await fs.chmod(q.directory,0o700);
 const socketPath=path.join(q.directory,'control.sock'),savedSocket=path.join(q.base,'owned-socket');await fs.rename(socketPath,savedSocket);await fs.symlink(savedSocket,socketPath);await q.command('inspect',undefined,{expect:1});await fs.unlink(socketPath);await fs.rename(savedSocket,socketPath);assert.equal((await q.command('inspect')).value.result.closed,false);
 const out=path.join(q.base,'symlink-out.json'),target=path.join(q.base,'target.json');await fs.writeFile(target,'KEEP',{mode:0o600});await fs.symlink(target,out);await q.command('inspect',undefined,{expect:1,output:out});assert.equal(await fs.readFile(target,'utf8'),'KEEP');
 await q.command('close');assert.equal((await s.child.terminal).code,0);
});


test('interrupted atomic control ACK publication retains complete drop intent and never retries the mutation',{timeout:15000},async t=>{
 const q=await setup(t),s=await q.start(),c=await smtp(t,s.address),id=await stored(q);
 const output=path.join(q.base,'uncertain.json'),barrier=path.join(q.base,'before-rename.json');
 // Test-only IO fault seam: whole actual CLI module, only fs promise import and
 // its relative fixture import relocated. No runtime flag or production hook.
 const original=await fs.readFile(entry,'utf8'),fixtureUrl=new URL('../tools/local/smtp-ack-fixture.mjs',import.meta.url).href;
 const relocated=original.replace("import * as fs from 'node:fs/promises';","import * as fs from './fault-io.mjs';").replace("from './smtp-ack-fixture.mjs';","from '"+fixtureUrl+"';");
 assert.equal(relocated.replace("import * as fs from './fault-io.mjs';","import * as fs from 'node:fs/promises';").replace("from '"+fixtureUrl+"';","from './smtp-ack-fixture.mjs';"),original,'whole source inverse of test import seams');
 const shim=`import * as real from 'node:fs/promises';
export * from 'node:fs/promises';
const synced=new Set();
export async function open(file,...args){const handle=await real.open(file,...args);return new Proxy(handle,{get(target,key){if(key==='sync')return async()=>{await target.sync();synced.add(file);};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});}
export async function rename(from,to){if(to===${JSON.stringify(output)}){const intent=JSON.parse(await real.readFile(to,'utf8')),reply=JSON.parse(await real.readFile(from,'utf8'));const proof={intent,reply,temporary:from,reply_file_fsynced:synced.has(from),parent_directory_fsynced:synced.has(${JSON.stringify(q.base)})};const h=await real.open(${JSON.stringify(barrier)},'wx',0o600);try{await h.writeFile(JSON.stringify(proof));await h.sync();}finally{await h.close();}await new Promise(()=>{setInterval(()=>{},1000);});}return real.rename(from,to);}
`;
 const alteredEntry=path.join(q.base,'fault-client.mjs');await fs.writeFile(alteredEntry,relocated,{mode:0o600});await fs.writeFile(path.join(q.base,'fault-io.mjs'),shim,{mode:0o600});
 const client=q.launch(['command',q.directory,'drop',output,id],alteredEntry);
 const proof=await q.until(async()=>{try{return JSON.parse(await fs.readFile(barrier,'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}});
 assert.deepEqual(proof.intent,{status:'CONTROL_REQUEST_INTENT',request:{command:'drop',id}});
 assert.equal(proof.reply.ok,true);assert.equal(proof.reply.command,'drop');assert.equal(proof.reply.result.action,'DROP_CONNECTION_WITHOUT_ACK');
 assert.equal(proof.reply_file_fsynced,true);assert.equal(proof.parent_directory_fsynced,true);
 assert.equal((await fs.stat(proof.temporary)).mode&0o777,0o600);
 await c.ended;client.kill('SIGKILL');const terminal=await client.terminal;assert.equal(terminal.signal,'SIGKILL');assert.equal(terminal.code,null);assert.equal(terminal.out,'');
 assert.deepEqual(JSON.parse(await fs.readFile(output,'utf8')),proof.intent,'original full request survives interruption before atomic rename');
 assert.deepEqual(JSON.parse(await fs.readFile(proof.temporary,'utf8')),proof.reply,'only complete fsynced ACK is in the sibling');
 await delay(100);const readback=await q.command('list');assert.equal(readback.value.result.length,1);assert.equal(readback.value.result[0].decision,'DROP_CONNECTION_WITHOUT_ACK');
 const decisions=(await fs.readdir(path.join(q.directory,'mailbox'))).filter(n=>n.startsWith('decision-'));assert.deepEqual(decisions,['decision-'+id+'.json']);
 // The uncertain original client is never invoked again; reconciliation above
 // is list-only, not a second drop/release/send.
 await q.command('close');assert.equal((await s.child.terminal).code,0);
});
