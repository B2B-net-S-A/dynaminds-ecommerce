/** TEST ONLY foreground ACK fixture owner. Import is inert. No app/PG/providers.
 * Unix control is private; CLI payloads go exclusively to fresh0600 files. */
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {randomUUID,createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {createSmtpAckFixture} from './smtp-ack-fixture.mjs';
const MAX_REQUEST=4096,MAX_RESPONSE=524288;
const sha=b=>createHash('sha256').update(b).digest('hex');
const absolute=p=>typeof p==='string'&&path.isAbsolute(p)&&path.resolve(p)===p&&!/[\x00-\x1f\x7f]/.test(p);
const commands=new Set(['inspect','list','read','release','drop','close']);
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const cut=s=>[s.dev,s.ino,s.uid,s.mode,s.nlink,s.size,s.mtimeNs,s.ctimeNs].join(':');
function request(v){
 assert(v&&Object.getPrototypeOf(v)===Object.prototype&&commands.has(v.command));
 const hasId=['read','release','drop'].includes(v.command);
 assert.deepEqual(Object.keys(v).sort(),hasId?['command','id']:['command']);
 if(hasId)assert(typeof v.id==='string'&&uuid.test(v.id));return v;
}
async function ownerDirectory(directory){
 assert(absolute(directory));assert.equal(await fs.realpath(directory),directory);
 const s=await fs.lstat(directory);assert(s.isDirectory()&&!s.isSymbolicLink()&&s.uid===process.getuid()&&(s.mode&0o777)===0o700,'private owned0700 directory required');return s;
}
async function syncDirectory(directory){const h=await fs.open(directory,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);try{await h.sync();}finally{await h.close();}}
async function readPrivate(file,max=4096){
 const s=await fs.lstat(file,{bigint:true});assert(s.isFile()&&!s.isSymbolicLink()&&s.uid===BigInt(process.getuid())&&s.nlink===1n&&(s.mode&0o777n)===0o600n&&s.size>0n&&s.size<=BigInt(max));
 const h=await fs.open(file,constants.O_RDONLY|constants.O_NOFOLLOW);try{assert.equal(cut(await h.stat({bigint:true})),cut(s));const bytes=Buffer.alloc(Number(s.size)+1);let used=0;while(used<bytes.length){const r=await h.read(bytes,used,bytes.length-used,used);if(!r.bytesRead)break;used+=r.bytesRead;}assert.equal(BigInt(used),s.size);const b=bytes.subarray(0,used);assert.equal(cut(await h.stat({bigint:true})),cut(s));assert.equal(cut(await fs.lstat(file,{bigint:true})),cut(s));return b;}finally{await h.close();}
}
async function exclusive(file,bytes){
 const h=await fs.open(file,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{await h.writeFile(bytes);await h.sync();}finally{await h.close();}await syncDirectory(path.dirname(file));
}
async function state(directory,value){
 const file=path.join(directory,'state.json');try{await readPrivate(file);}catch(e){if(e.code!=='ENOENT')throw e;}
 const temporary=file+'.tmp-'+randomUUID();await exclusive(temporary,Buffer.from(JSON.stringify(value)+'\n'));await fs.rename(temporary,file);await syncDirectory(directory);
}
function packet(value){const b=Buffer.from(JSON.stringify(value)+'\n');if(b.length>MAX_RESPONSE)return Buffer.from('{"ok":false,"error":"RESPONSE_TOO_LARGE"}\n');return b;}
async function checkSocket(directory){
 await ownerDirectory(directory);const socket=path.join(directory,'control.sock');assert(Buffer.byteLength(socket)<=100,'control Unixsocket path too long; choose a short private directory');
 const s=await fs.lstat(socket);assert(s.isSocket()&&!s.isSymbolicLink()&&s.uid===process.getuid()&&(s.mode&0o777)===0o600,'private owned control socket required');
 const lock=JSON.parse((await readPrivate(path.join(directory,'owner.lock'))).toString('utf8'));assert.equal(lock.schema,'dynaminds-smtp-ack-service-owner/v1');assert(uuid.test(lock.nonce)&&Number.isSafeInteger(lock.pid)&&lock.pid>0);return socket;
}
export async function startSmtpAckFixtureService({directory,port=0}){
 assert(absolute(directory));assert(Number.isInteger(port)&&(port===0||port>=1024&&port<=65535));
 await ownerDirectory(path.dirname(directory));
 try{await fs.mkdir(directory,{mode:0o700});await syncDirectory(path.dirname(directory));}catch(e){if(e.code!=='EEXIST')throw e;}
 await ownerDirectory(directory);const socketPath=path.join(directory,'control.sock');assert(Buffer.byteLength(socketPath)<=100,'control Unixsocket path too long; choose a short private directory');
 const names=await fs.readdir(directory);assert(names.every(n=>['settings.json','state.json','mailbox','owner.lock','control.sock'].includes(n)),'foreign service artifact');
 // Existing lock/socket is preserved even after a crash; never infer it stale.
 assert(!names.includes('owner.lock')&&!names.includes('control.sock'),'existing owner requires explicit review; no automatic recovery');
 const settings={schema:'dynaminds-smtp-ack-service/v1',port};
 if(names.includes('settings.json')){assert.deepEqual(JSON.parse((await readPrivate(path.join(directory,'settings.json'))).toString('utf8')),settings);const old=JSON.parse((await readPrivate(path.join(directory,'state.json'))).toString('utf8'));assert.equal(old.status,'CLOSED');}
 const lock={schema:'dynaminds-smtp-ack-service-owner/v1',pid:process.pid,nonce:randomUUID()};
 await exclusive(path.join(directory,'owner.lock'),Buffer.from(JSON.stringify(lock)+'\n'));
 if(!names.includes('settings.json'))await exclusive(path.join(directory,'settings.json'),Buffer.from(JSON.stringify(settings)+'\n'));
 await state(directory,{schema:settings.schema,status:'STARTING',pid:process.pid});
 let fixture,server,closing=false,queue=Promise.resolve(),socketIdentity;
 const clients=new Set();let resolveClosed,rejectClosed;const closed=new Promise((yes,no)=>{resolveClosed=yes;rejectClosed=no;});closed.catch(()=>{});
 const enqueue=fn=>{const q=queue.then(fn);queue=q.catch(()=>{});return q;};
 const removeSocket=async()=>{try{const s=await fs.lstat(socketPath);assert(socketIdentity&&s.isSocket()&&s.dev===socketIdentity.dev&&s.ino===socketIdentity.ino,'control socket identity changed');await fs.unlink(socketPath);}catch(e){if(e.code!=='ENOENT')throw e;}};
 const close=async(answerSocket)=>{
  if(closing)return;closing=true;
  try{
   await state(directory,{schema:settings.schema,status:'DRAINING',pid:process.pid});
   const stopped=server?.listening?new Promise((yes,no)=>server.close(e=>e?no(e):yes())):Promise.resolve();
   for(const client of clients)if(client!==answerSocket)client.destroy();
   const result=await fixture?.close();
   if(answerSocket)answerSocket.end(packet({ok:true,command:'close',result:{close_requested:true,fixture_closed:result?.closed===true,final_state_requires_process_exit:true}}));
   await stopped;await removeSocket();
   await state(directory,{schema:settings.schema,status:'CLOSED',pid:process.pid,fixture_closed:result?.closed===true,control_closed:true});
   assert.deepEqual(JSON.parse((await readPrivate(path.join(directory,'owner.lock'))).toString('utf8')),lock);
   await fs.unlink(path.join(directory,'owner.lock'));await syncDirectory(directory);resolveClosed({closed:true});
  }catch(e){for(const client of clients)client.destroy();rejectClosed(e);throw e;}
 };
 try{
  fixture=await createSmtpAckFixture({directory:path.join(directory,'mailbox'),port});
  server=net.createServer(client=>{
   if(closing||clients.size>=4){client.destroy();return;}clients.add(client);client.setTimeout(3000,()=>client.destroy());client.on('error',()=>{});client.once('close',()=>clients.delete(client));
   let bytes=Buffer.alloc(0),handled=false;
   client.on('data',chunk=>{
    if(handled){client.destroy();return;}
    if(bytes.length+chunk.length>MAX_REQUEST){handled=true;client.end(packet({ok:false,error:'REQUEST_TOO_LARGE'}));return;}bytes=Buffer.concat([bytes,chunk]);
    const newline=bytes.indexOf(10);if(newline<0)return;handled=true;
    if(newline!==bytes.length-1){client.end(packet({ok:false,error:'ONE_REQUEST_REQUIRED'}));return;}
    void enqueue(async()=>{
     try{
      assert(!closing);await checkSocket(directory);
      const q=request(JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(bytes.subarray(0,newline))));
      if(q.command==='close'){await close(client);return;}
      const result=q.command==='inspect'?fixture.inspect():q.command==='list'?await fixture.list():await fixture[q.command](q.id);
      client.end(packet({ok:true,command:q.command,result}));
     }catch{if(!client.destroyed)client.end(packet({ok:false,error:'CONTROL_REFUSED'}));}
    });
   });
  });
  await new Promise((yes,no)=>{server.once('error',no);server.listen(socketPath,()=>{server.off('error',no);yes();});});
  await fs.chmod(socketPath,0o600);socketIdentity=await fs.lstat(socketPath);await syncDirectory(directory);await checkSocket(directory);
  server.on('error',()=>{void enqueue(()=>close()).catch(()=>{});});
  await state(directory,{schema:settings.schema,status:'READY',pid:process.pid,address:fixture.address});
  return Object.freeze({address:fixture.address,closed,close:()=>enqueue(()=>close())});
 }catch(first){
  // Failed births retain durable intent. Release only resources started here;
  // the directory/lock must be explicitly reviewed, never guessed reusable.
  for(const client of clients)client.destroy();try{await fixture?.close();}catch{}
  if(server?.listening)await new Promise(r=>server.close(r));try{await removeSocket();}catch{}
  try{await state(directory,{schema:settings.schema,status:'FAILED',pid:process.pid});}catch{}
  throw first;
 }
}
export async function requestSmtpAckFixtureService({directory,command,id,output}){
 const q=request(id===undefined?{command}:{command,id}),socketPath=await checkSocket(directory);
 assert(absolute(output));await ownerDirectory(path.dirname(output));
 // Reserve/fsync the exclusive0600 output BEFORE issuing a mutating control
 // command. Lost control ACK never leads to an automatic release/drop retry.
 await exclusive(output,Buffer.from(JSON.stringify({status:'CONTROL_REQUEST_INTENT',request:q})+'\n'));
 const h=await fs.open(output,constants.O_RDONLY|constants.O_NOFOLLOW);const before=await h.stat({bigint:true});assert(before.isFile()&&before.uid===BigInt(process.getuid())&&before.nlink===1n&&(before.mode&0o777n)===0o600n);
 assert.equal(cut(await fs.lstat(output,{bigint:true})),cut(before));
 try{
  const reply=await new Promise((yes,no)=>{
   const socket=net.createConnection(socketPath);let bytes=Buffer.alloc(0),finished=false;
   const finish=(error,value)=>{if(finished)return;finished=true;socket.destroy();error?no(error):yes(value);};
   socket.setTimeout(5000,()=>finish(Error('control acknowledgement unconfirmed')));socket.on('error',()=>finish(Error('control acknowledgement unconfirmed')));socket.once('close',()=>finish(Error('control acknowledgement unconfirmed')));
   socket.once('connect',()=>socket.write(JSON.stringify(q)+'\n'));
   socket.on('data',chunk=>{bytes=Buffer.concat([bytes,chunk]);if(bytes.length>MAX_RESPONSE)finish(Error('control response exceeds bound'));});
   socket.once('end',()=>{try{assert(bytes.length>0&&bytes.length<=MAX_RESPONSE);const text=new TextDecoder('utf8',{fatal:true}).decode(bytes);assert(text.endsWith('\n')&&text.indexOf('\n')===text.length-1);const value=JSON.parse(text);assert(typeof value.ok==='boolean');finish(null,{bytes,value});}catch{finish(Error('control response invalid or incomplete'));}});
  });
  // Never truncate the only durable request. A failed/terminated client leaves
  // that complete intent or the complete ACK, plus an optional private temp.
  const temporary=output+'.ack-'+randomUUID();await ownerDirectory(path.dirname(output));
  await exclusive(temporary,reply.bytes);
  assert.equal(cut(await h.stat({bigint:true})),cut(before));assert.equal(cut(await fs.lstat(output,{bigint:true})),cut(before));
  await ownerDirectory(path.dirname(output));await fs.rename(temporary,output);await syncDirectory(path.dirname(output));
  return{ok:reply.value.ok,command,output_bytes:reply.bytes.length,output_sha256:sha(reply.bytes)};
 }finally{await h.close();}
}
export async function main(args){
 if(args[0]==='start'){
  assert(args.length===2||args.length===3,'start PRIVATE0700_DIRECTORY [PORT0_OR_UNPRIVILEGED]');
  const port=args[2]===undefined?0:Number(args[2]);assert(args[2]===undefined||/^(0|[1-9][0-9]{3,4})$/.test(args[2]));
  let service,requested=false;const stop=()=>{requested=true;if(service)void service.close().catch(()=>{process.exitCode=1;});};
  process.on('SIGINT',stop);process.on('SIGTERM',stop);
  try{service=await startSmtpAckFixtureService({directory:args[1],port});process.stdout.write(JSON.stringify({status:'TEST_SMTP_ACK_SERVICE_READY',address:service.address})+'\n');if(requested)await service.close();await service.closed;return{status:'TEST_SMTP_ACK_SERVICE_CLOSED'};}
  finally{process.off('SIGINT',stop);process.off('SIGTERM',stop);}
 }
 assert(args[0]==='command'&&(args.length===4||args.length===5),'command PRIVATE_DIRECTORY COMMAND FRESH_PRIVATE_OUTPUT [EFFECT_UUID]');
 return requestSmtpAckFixtureService({directory:args[1],command:args[2],output:args[3],...(args[4]===undefined?{}:{id:args[4]})});
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main(process.argv.slice(2)).then(result=>{process.stdout.write(JSON.stringify(result)+'\n');if(result.ok===false)process.exitCode=1;}).catch(()=>{process.exitCode=1;process.stderr.write('{"status":"TEST_SMTP_ACK_SERVICE_REFUSED_NO_REPLAY"}\n');});
