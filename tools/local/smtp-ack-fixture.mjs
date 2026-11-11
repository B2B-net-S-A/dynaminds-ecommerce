/** TEST ONLY. Loopback SMTP receiver with an owner-controlled ACK barrier.
 * No app/database/provider integration, forwarding, env configuration or dedupe.
 * Stored means local durable receipt; release250 never proves sender ACK receipt. */
import assert from 'node:assert/strict';
import {constants} from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {SMTPServer} from 'smtp-server';

const sha=b=>createHash('sha256').update(b).digest('hex');
const freeze=v=>{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;};
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const exact=(v,keys)=>{assert(v&&[Object.prototype,null].includes(Object.getPrototypeOf(v)));const d=Object.getOwnPropertyDescriptors(v);assert.deepEqual(Reflect.ownKeys(d).sort(),keys.slice().sort());for(const k of keys)assert(Object.hasOwn(d[k],'value')&&d[k].enumerable);};
const smtpError=()=>Object.assign(Error('Test fixture refused message'),{responseCode:452});

export async function createSmtpAckFixture(options){
 assert(options&&[Object.prototype,null].includes(Object.getPrototypeOf(options)));
 const ds=Object.getOwnPropertyDescriptors(options),allowed=['directory','port','maxMessages','maxConnections','maxMessageBytes','maxTotalBytes'];
 assert(Reflect.ownKeys(ds).every(k=>allowed.includes(k)&&Object.hasOwn(ds[k],'value')&&ds[k].enumerable),'fixture data options only');
 const {directory,port=0,maxMessages=16,maxConnections=4,maxMessageBytes=262144,maxTotalBytes=4194304}=options;
 assert(typeof directory==='string'&&path.isAbsolute(directory)&&path.resolve(directory)===directory,'canonical private directory');
 assert(Number.isInteger(port)&&(port===0||port>=1024&&port<=65535));
 for(const [v,limit] of [[maxMessages,32],[maxConnections,8],[maxMessageBytes,262144],[maxTotalBytes,8388608]])assert(Number.isInteger(v)&&v>=1&&v<=limit,'finite fixture limits');
 assert(maxTotalBytes>=maxMessageBytes);
 assert.equal(await fs.realpath(path.dirname(directory)),path.dirname(directory));
 try{await fs.mkdir(directory,{mode:0o700});}catch(e){if(e.code!=='EEXIST')throw e;}
 const dir=await fs.lstat(directory);assert(dir.isDirectory()&&!dir.isSymbolicLink()&&dir.uid===process.getuid()&&(dir.mode&0o777)===0o700,'private owned directory');
 assert.equal(await fs.realpath(directory),directory);
 const syncDir=async()=>{const h=await fs.open(directory,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);try{await h.sync();}finally{await h.close();}};
 const write=async(name,value)=>{const h=await fs.open(path.join(directory,name),constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{await h.writeFile(JSON.stringify(value)+'\n');await h.sync();}finally{await h.close();}await syncDir();};
 const read=async(name)=>{const file=path.join(directory,name),s=await fs.lstat(file);assert(s.isFile()&&!s.isSymbolicLink()&&s.uid===process.getuid()&&s.nlink===1&&(s.mode&0o777)===0o600&&s.size>0&&s.size<=524288,'bounded private fixture record');
  const h=await fs.open(file,constants.O_RDONLY|constants.O_NOFOLLOW);try{const before=await h.stat();assert.equal(before.ino,s.ino);assert.equal(before.dev,s.dev);const b=Buffer.alloc(s.size+1);let n=0;while(n<b.length){const r=await h.read(b,n,b.length-n,n);if(!r.bytesRead)break;n+=r.bytesRead;}assert.equal(n,s.size);const after=await h.stat();assert.equal(after.size,s.size);assert.equal(after.mtimeMs,s.mtimeMs);assert.equal(after.ctimeMs,s.ctimeMs);return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(b.subarray(0,n)));}finally{await h.close();}};
 const settings={schema:'dynaminds-test-smtp-ack-fixture/v1',maxMessages,maxConnections,maxMessageBytes,maxTotalBytes};
 // EXCL rejects concurrent/replayed ownership. A crashed owner's lock is never
 // guessed stale or removed automatically. Use a new directory after a crash.
 await write('owner.lock',{pid:process.pid,nonce:randomUUID()});
 let server,closed=false,closePromise,fatal=false,serial=Promise.resolve();
 const sockets=new Set(),pending=new Map(),effects=new Map(),decisions=new Map(),flights=new Set();
 const queued=fn=>{const p=serial.then(fn);serial=p.catch(()=>{});flights.add(p);p.then(()=>flights.delete(p),()=>flights.delete(p));return p;};
 let total=0;
 const healthy=()=>assert(!closed&&!fatal,'fixture closed or storage unconfirmed');
 const idCheck=id=>assert(typeof id==='string'&&uuid.test(id)&&effects.has(id),'known fixture effect');
 const effectFile=id=>'effect-'+id+'.json',decisionFile=id=>'decision-'+id+'.json';
 const validateEffect=r=>{exact(r,['schema','id','accepted_at','envelope','bytes','sha256','raw_base64']);assert.equal(r.schema,'dynaminds-test-smtp-effect/v1');assert(uuid.test(r.id));assert(Number.isInteger(r.bytes)&&r.bytes>=0&&r.bytes<=maxMessageBytes);assert(typeof r.raw_base64==='string');const b=Buffer.from(r.raw_base64,'base64');assert.equal(b.toString('base64'),r.raw_base64);assert.equal(b.length,r.bytes);assert.equal(sha(b),r.sha256);exact(r.envelope,['from','to']);assert(typeof r.envelope.from==='string'&&r.envelope.from.length<=254&&r.envelope.from.endsWith('.test'));assert(Array.isArray(r.envelope.to)&&r.envelope.to.length>=1&&r.envelope.to.length<=16&&r.envelope.to.every(v=>typeof v==='string'&&v.length<=254&&v.endsWith('.test')));assert(typeof r.accepted_at==='string'&&Number.isFinite(Date.parse(r.accepted_at)));return freeze(r);};
 try{
  const names=await fs.readdir(directory);assert(names.length<=2+2*maxMessages,'bounded mailbox files');
  assert(names.every(n=>['owner.lock','fixture.json'].includes(n)||/^(?:effect|decision)-[a-f0-9-]{36}\.json$/.test(n)),'foreign mailbox file');
  if(names.includes('fixture.json'))assert.deepEqual(await read('fixture.json'),settings);else{assert.equal(names.length,1,'new mailbox empty');await write('fixture.json',settings);}
  for(const name of names.filter(n=>n.startsWith('effect-'))){const r=validateEffect(await read(name));assert.equal(name,effectFile(r.id));assert(!effects.has(r.id));effects.set(r.id,r);total+=r.bytes;}
  assert(effects.size<=maxMessages&&total<=maxTotalBytes,'durable mailbox limits');
  for(const name of names.filter(n=>n.startsWith('decision-'))){const d=await read(name);exact(d,['schema','id','action']);assert.equal(d.schema,'dynaminds-test-smtp-decision/v1');idCheck(d.id);assert.equal(name,decisionFile(d.id));assert(['RELEASE_250_REQUESTED','DROP_CONNECTION_WITHOUT_ACK'].includes(d.action));decisions.set(d.id,freeze(d));}
  server=new SMTPServer({name:'test-ack.local',secure:false,authOptional:true,disabledCommands:['AUTH','STARTTLS'],hidePIPELINING:true,disableReverseLookup:true,logger:false,
   maxClients:maxConnections,size:maxMessageBytes,socketTimeout:60000,
   onMailFrom(a,_s,cb){cb(!closed&&!fatal&&a.address.length<=254&&a.address.endsWith('.test')?null:smtpError());},
   onRcptTo(a,s,cb){cb(a.address.length<=254&&a.address.endsWith('.test')&&s.envelope.rcptTo.length<16?null:smtpError());},
   onClose(s){for(const [id,p]of pending)if(p.session===s.id)pending.delete(id);},
   onData(stream,session,callback){
    let size=0,ended=false;const parts=[];
    stream.on('data',b=>{size+=b.length;if(size<=maxMessageBytes)parts.push(b);});
    stream.on('error',()=>{if(!ended){ended=true;callback(smtpError());}});
    stream.on('end',()=>{if(ended)return;ended=true;
     const socket=[...sockets].find(s=>s.remotePort===session.remotePort);
     const envelope={from:session.envelope.mailFrom.address,to:session.envelope.rcptTo.map(a=>a.address)};
     void queued(async()=>{
      if(closed||fatal||stream.sizeExceeded||size>maxMessageBytes||effects.size>=maxMessages||total+size>maxTotalBytes||!socket||socket.destroyed){callback(smtpError());return;}
      const raw=Buffer.concat(parts),id=randomUUID(),r=validateEffect({schema:'dynaminds-test-smtp-effect/v1',id,accepted_at:new Date().toISOString(),envelope,bytes:raw.length,sha256:sha(raw),raw_base64:raw.toString('base64')});
      await write(effectFile(id),r);effects.set(id,r);total+=raw.length;
      // Acknowledgement is held only AFTER file AND directory fsync succeed.
      if(!closed&&!socket.destroyed)pending.set(id,{callback,socket,session:session.id});
     }).catch(()=>{fatal=true;callback(smtpError());});
    });
   }});
  server.server.on('connection',socket=>{sockets.add(socket);socket.on('error',()=>{});socket.once('close',()=>sockets.delete(socket));if(closed||sockets.size>maxConnections)socket.destroy();});
  server.on('error',()=>{fatal=true;});
  await new Promise((resolve,reject)=>{const bad=()=>reject(Error('Test SMTP listener unavailable'));server.once('error',bad);server.listen(port,'127.0.0.1',()=>{server.off('error',bad);resolve();});});
 }catch(e){closed=true;for(const s of sockets)s.destroy();if(server?.server.listening)await new Promise(r=>server.server.close(r));await fs.unlink(path.join(directory,'owner.lock'));await syncDir();throw e;}
 const decide=(id,action)=>{healthy();idCheck(id);return queued(async()=>{healthy();assert(!decisions.has(id),'effect already decided');const p=pending.get(id);assert(p&&!p.socket.destroyed,'no live held ACK');const d=freeze({schema:'dynaminds-test-smtp-decision/v1',id,action});try{await write(decisionFile(id),d);}catch{fatal=true;throw Error('Test fixture decision storage unconfirmed');}decisions.set(id,d);pending.delete(id);if(action==='RELEASE_250_REQUESTED')p.callback(null,'test fixture stored '+id);else p.socket.destroy();return d;});};
 const close=()=>closePromise??=(async()=>{closed=true;const stopped=new Promise((resolve,reject)=>server.server.close(e=>e?reject(e):resolve()));for(const s of sockets)s.destroy();pending.clear();await Promise.allSettled([...flights]);await stopped;await fs.unlink(path.join(directory,'owner.lock'));await syncDir();assert(!fatal,'test fixture storage/listener failure');return freeze({closed:true,connections:0,stored:effects.size});})();
 const address=server.server.address();assert(address&&typeof address==='object'&&address.address==='127.0.0.1');
 return Object.freeze({address:freeze({host:'127.0.0.1',port:address.port}),
  inspect(){return freeze({test_only:true,closed,storage_unconfirmed:fatal,connections:sockets.size,stored:effects.size,pending_ack_ids:[...pending.keys()],total_bytes:total,dedupe:false});},
  async list(){healthy();return freeze([...effects.values()].map(({id,accepted_at,envelope,bytes,sha256})=>({id,accepted_at,envelope,bytes,sha256,decision:decisions.get(id)?.action??null})));},
  async read(id){healthy();idCheck(id);const r=validateEffect(await read(effectFile(id)));assert.deepEqual(r,effects.get(id));return r;},
  release:id=>decide(id,'RELEASE_250_REQUESTED'),drop:id=>decide(id,'DROP_CONNECTION_WITHOUT_ACK'),close});
}
