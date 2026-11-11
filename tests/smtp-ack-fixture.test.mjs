/** Real loopback TCP/files only. No app, worker, PG or provider acceptance. */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {createSmtpAckFixture} from '../tools/local/smtp-ack-fixture.mjs';

const message='From: sender@fixture.test\r\nTo: buyer@fixture.test\r\nSubject: repeated test effect\r\n\r\nfixture payload\r\n';
async function setup(t,options={}){
 const base=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'dyna-smtp-ack-'))),directory=path.join(base,'mailbox');let current;
 t.after(async()=>{try{await current?.close();}finally{await fs.rm(base,{recursive:true,force:true});}});
 return{directory,async start(){current=await createSmtpAckFixture({directory,...options});return current;}};
}
async function until(fn){for(let i=0;i<250;i++){const x=await fn();if(x)return x;await delay(10);}assert.fail('Fixture condition not observed');}
async function client(t,address){
 const socket=net.createConnection({host:address.host,port:address.port}),lines=[],waiters=[];let partial='',closed=false;
 const drain=()=>{while(waiters.length&&(lines.length||closed)){const w=waiters.shift();clearTimeout(w.timer);if(lines.length)w.resolve(lines.shift());else w.reject(Error('SMTP connection closed'));}};
 const ended=new Promise(resolve=>socket.once('close',()=>{closed=true;drain();resolve();}));
 socket.on('error',()=>{});socket.on('data',data=>{partial+=data.toString('utf8');let at;while((at=partial.indexOf('\r\n'))>=0){lines.push(partial.slice(0,at));partial=partial.slice(at+2);}drain();});
 const next=()=>new Promise((resolve,reject)=>{const w={resolve,reject,timer:setTimeout(()=>{const at=waiters.indexOf(w);if(at>=0)waiters.splice(at,1);reject(Error('SMTP response deadline'));},5000)};waiters.push(w);drain();});
 const send=async(command,code)=>{socket.write(command+'\r\n');const response=await next();assert.equal(response.slice(0,3),String(code));return response;};
 t.after(()=>socket.destroy());assert.equal((await next()).slice(0,3),'220');await send('HELO fixture.test',250);
 return{socket,lines,next,send,ended,get closed(){return closed;}};
}
async function data(t,f,body=message){const c=await client(t,f.address);await c.send('MAIL FROM:<sender@fixture.test>',250);await c.send('RCPT TO:<buyer@fixture.test>',250);await c.send('DATA',354);c.socket.write(body+'.\r\n');return c;}

test('effect is durable while sender waits; explicit owner release is the first DATA250',async t=>{
 const q=await setup(t),f=await q.start(),c=await data(t,f);
 const id=await until(()=>f.inspect().pending_ack_ids[0]);await delay(30);assert.deepEqual(c.lines,[]);assert.equal(c.closed,false);
 const row=await f.read(id);assert.equal(row.envelope.to[0],'buyer@fixture.test');const bytes=Buffer.from(row.raw_base64,'base64');assert.equal(row.sha256,createHash('sha256').update(bytes).digest('hex'));
 assert.equal((await fs.stat(q.directory)).mode&0o777,0o700);assert.equal((await fs.stat(path.join(q.directory,'effect-'+id+'.json'))).mode&0o777,0o600);
 // A separate file read sees the accepted effect before any owner release.
 assert.deepEqual(JSON.parse(await fs.readFile(path.join(q.directory,'effect-'+id+'.json'),'utf8')),row);
 const decision=await f.release(id);assert.equal(decision.action,'RELEASE_250_REQUESTED');assert.equal((await c.next()).slice(0,3),'250');assert.equal((await f.list())[0].decision,'RELEASE_250_REQUESTED');
 await assert.rejects(f.release(id),/already decided/);await c.send('QUIT',221);
});

test('dropACK retains durable receipt and decision through clean restart; no sender success is invented',async t=>{
 const q=await setup(t),f=await q.start(),c=await data(t,f),id=await until(()=>f.inspect().pending_ack_ids[0]),stored=await f.read(id);
 await f.drop(id);await c.ended;assert(!c.lines.some(x=>x.startsWith('250')));assert.equal((await f.list())[0].decision,'DROP_CONNECTION_WITHOUT_ACK');
 const close=f.close();assert.equal(f.close(),close);await close;const next=await q.start();assert.equal(next.inspect().pending_ack_ids.length,0);assert.deepEqual(await next.read(id),stored);assert.equal((await next.list())[0].decision,'DROP_CONNECTION_WITHOUT_ACK');
 await assert.rejects(next.release(id),/already decided/);
});

test('identical retries are separately accepted effects, never automatically deduplicated',async t=>{
 const q=await setup(t),f=await q.start(),first=await data(t,f),a=await until(()=>f.inspect().pending_ack_ids[0]);await f.drop(a);await first.ended;
 const second=await data(t,f),b=await until(()=>f.inspect().pending_ack_ids[0]);assert.notEqual(a,b);await f.release(b);assert.equal((await second.next()).slice(0,3),'250');await second.send('QUIT',221);
 const rows=await f.list();assert.equal(rows.length,2);assert.equal(rows[0].sha256,rows[1].sha256);assert.equal(f.inspect().dedupe,false);
});

test('close owns only fixture sockets, drops held ACK and preserves stored proof for restart',async t=>{
 const q=await setup(t),f=await q.start(),c=await data(t,f),id=await until(()=>f.inspect().pending_ack_ids[0]);
 const result=await f.close();await c.ended;assert.deepEqual(result,{closed:true,connections:0,stored:1});assert.equal(c.lines.length,0);
 const restarted=await q.start();assert.equal((await restarted.read(id)).id,id);assert.equal((await restarted.list())[0].decision,null);assert.equal(restarted.inspect().pending_ack_ids.length,0);await assert.rejects(restarted.drop(id),/no live held ACK/);
});

test('message/count/total bounds reject before durable acceptance; bad recipients never enter mailbox',async t=>{
 const q=await setup(t,{maxMessages:1,maxMessageBytes:256,maxTotalBytes:256}),f=await q.start();
 const bad=await client(t,f.address);await bad.send('MAIL FROM:<sender@fixture.test>',250);await bad.send('RCPT TO:<buyer@example.com>',452);bad.socket.destroy();
 const oversize=await data(t,f,'x'.repeat(257)+'\r\n');assert.equal((await oversize.next()).slice(0,3),'452');oversize.socket.destroy();assert.equal((await f.list()).length,0);
 const c=await data(t,f),id=await until(()=>f.inspect().pending_ack_ids[0]);await f.drop(id);await c.ended;
 const tooMany=await data(t,f);assert.equal((await tooMany.next()).slice(0,3),'452');assert.equal((await f.list()).length,1);assert.equal(f.inspect().storage_unconfirmed,false);
});

test('mailbox ownership and persisted limits refuse concurrent owners, foreign files and permissive files',async t=>{
 const q=await setup(t),f=await q.start();await assert.rejects(createSmtpAckFixture({directory:q.directory}));assert.equal(f.inspect().closed,false);await f.close();
 await assert.rejects(createSmtpAckFixture({directory:q.directory,maxMessages:3}));
 await fs.writeFile(path.join(q.directory,'foreign.json'),'{}',{mode:0o600});await assert.rejects(q.start(),/foreign mailbox file/);await fs.unlink(path.join(q.directory,'foreign.json'));
 await fs.chmod(path.join(q.directory,'fixture.json'),0o644);await assert.rejects(q.start(),/bounded private/);await fs.chmod(path.join(q.directory,'fixture.json'),0o600);
 const restarted=await q.start();assert.equal(restarted.address.host,'127.0.0.1');
});

test('connection bound closes only the extra local socket and leaves the held effect controllable',async t=>{
 const q=await setup(t,{maxConnections:1}),f=await q.start(),first=await data(t,f),id=await until(()=>f.inspect().pending_ack_ids[0]);
 const extra=net.createConnection({host:f.address.host,port:f.address.port});extra.on('error',()=>{});t.after(()=>extra.destroy());
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Extra socket was not closed')),5000);extra.once('close',()=>{clearTimeout(timer);resolve();});});
 assert.equal(first.closed,false);assert.equal(f.inspect().connections,1);assert.equal((await f.list()).length,1);
 await f.release(id);assert.equal((await first.next()).slice(0,3),'250');
});

test('only bounded data options are accepted, without reading getters or environment config',async t=>{
 const q=await setup(t);let reads=0;const options={directory:q.directory};Object.defineProperty(options,'port',{enumerable:true,get(){reads++;return 0;}});await assert.rejects(createSmtpAckFixture(options));assert.equal(reads,0);
 for(const change of [{host:'0.0.0.0'},{port:25},{maxMessages:33},{maxConnections:9},{maxMessageBytes:262145},{maxTotalBytes:8388609}])await assert.rejects(createSmtpAckFixture({directory:q.directory,...change}));
});
