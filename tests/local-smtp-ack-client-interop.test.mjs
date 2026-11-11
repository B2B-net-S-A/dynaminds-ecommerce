/** Actual SmtpClient + nodemailer + real loopback TCP/files. Historical default
 * cases use an explicit port adapter; owner-selected port case has NO adapter. Synthetic key only;
 * no app, database, worker, provider account or durable worker acceptance. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import * as net from 'node:net';
import {readFileSync} from 'node:fs';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {transformSync} from 'esbuild';
import {createSmtpAckFixture} from '../tools/local/smtp-ack-fixture.mjs';
import {requestSmtpAckFixtureService} from '../tools/local/smtp-ack-fixture-service.mjs';

const require=createRequire(import.meta.url);
const source=readFileSync(new URL('../server/smtp.ts',import.meta.url),'utf8');
const errors=readFileSync(new URL('../server/errors.ts',import.meta.url),'utf8');
const syntheticKey='27'.repeat(32);
let databaseImports=0,externalDnsCalls=0,fixturePort=0;
const connectTargets=[];
function loadActualClient(configuration={encryptionKey:syntheticKey},portAdapter=true){
 const problem={exports:{}};
 Function('module','exports',transformSync(errors,{loader:'ts',format:'cjs',target:'node22'}).code)(problem,problem.exports);
 const module={exports:{}};
 const allowed=new Set(['nodemailer','node:net','node:tls','node:crypto','zod']);
 const ports=id=>{
  if(id==='./db'){databaseImports++;return{localConfig:Object.freeze({...configuration})};}
  if(id==='./integrations')return{publicAddresses:async()=>{externalDnsCalls++;throw Error('External DNS forbidden in local SMTP interoperability test');}};
  if(id==='./errors')return problem.exports;
  if(id==='node:net'&&portAdapter)return{connect(options){
   assert.deepEqual(options,{host:'127.0.0.1',family:4,port:1025},'Actual client retains its exact local_sink target');
   assert(Number.isInteger(fixturePort)&&fixturePort>=1024&&fixturePort<=65535&&fixturePort!==1025);
   connectTargets.push({...options});
   return net.connect({...options,port:fixturePort});
  }};
  assert(allowed.has(id),'Unexpected import refused: '+id);return require(id);
 };
 // Entire actual class/schema/transport/send implementation is unchanged. Only
 // imports with app/PG side effects are controlled. Explicit net-port adapter
 // changes only the physical listener port; nodemailer/socket/SMTP protocol stay real.
 Function('require','module','exports',transformSync(source,{loader:'ts',format:'cjs',target:'node22'}).code)(ports,module,module.exports);
 return module.exports;
}
const actual=loadActualClient();
const settings={delivery:'local_sink',host:'127.0.0.1',port:1025,from_email:'sender@fixture.test',from_name:'Synthetic interop'};
const message=()=>({id:randomUUID(),recipient:'buyer@fixture.test',subject:'Synthetic local ACK boundary',text:'Synthetic fixture content',html:'<p>Synthetic fixture content</p>'});
async function start(t){
 const base=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'dyna-smtp-client-interop-')));
 let fixture;
 t.after(async()=>{try{await fixture?.close();}finally{fixturePort=0;await fs.rm(base,{recursive:true,force:true});}});
 // Never touch the existing port1025 service. App config stays1025; the explicit
 // harness adapter asserts that exact original target before mapping real TCP.
 fixture=await createSmtpAckFixture({directory:path.join(base,'mailbox'),port:0});
 fixturePort=fixture.address.port;
 return fixture;
}
async function held(fixture,attempt){
 for(let i=0;i<300;i++){
  const ids=fixture.inspect().pending_ack_ids;
  if(ids.length){assert.equal(ids.length,1);return ids[0];}
  if(attempt.settled)assert.fail('Actual SmtpClient settled before durable held DATA: '+(attempt.error?.code??'no-code'));
  await delay(10);
 }
 assert.fail('Actual SmtpClient did not reach durable held DATA');
}
function send(client,m){
 const attempt={settled:false,result:undefined,error:undefined};
 attempt.done=client.send(m).then(result=>{attempt.result=result;attempt.settled=true;},error=>{attempt.error=error;attempt.settled=true;});
 return attempt;
}
async function assertDurableHeld(fixture,id,m,attempt){
 const stored=await fixture.read(id);
 assert.equal(stored.envelope.from,settings.from_email);
 assert.deepEqual(stored.envelope.to,[m.recipient]);
 const raw=Buffer.from(stored.raw_base64,'base64');
 assert.equal(createHash('sha256').update(raw).digest('hex'),stored.sha256);
 const text=raw.toString('utf8');
 assert(text.includes('Message-ID: <'+m.id+'@dynaminds.local>'));
 assert(text.includes('X-Dynaminds-Message: '+m.id));
 assert.equal(fixture.inspect().stored,1);
 await delay(40);assert.equal(attempt.settled,false,'Durable DATA must not be reported as sender acceptance');
 return stored;
}

test('port-adapted actual local SmtpClient reaches durable held DATA without AUTH; release250 yields SMTP acceptance only',{concurrency:false,timeout:10000},async t=>{
 const fixture=await start(t),client=new actual.SmtpClient(settings,{}),m=message();
 assert.equal(client.credentials.username,'dyna-local');
 assert.equal(client.credentials.password,actual.localSmtpPassword());
 assert.equal(client.credentials.password.length,64);
 const attempt=send(client,m),id=await held(fixture,attempt);
 await assertDurableHeld(fixture,id,m,attempt);
 assert.equal((await fixture.list())[0].decision,null);
 await fixture.release(id);await attempt.done;
 assert.equal(attempt.error,undefined);
 assert.deepEqual(attempt.result,{accepted_by_smtp:true,delivered:false,local_sink:true,message_id:'<'+m.id+'@dynaminds.local>'});
 assert.equal((await fixture.list())[0].decision,'RELEASE_250_REQUESTED');
 await delay(150);assert.equal(fixture.inspect().stored,1);
 assert.equal(externalDnsCalls,0);assert.equal(databaseImports,1);
 assert.deepEqual(connectTargets,[{host:'127.0.0.1',family:4,port:1025}]);
});

test('port-adapted actual local SmtpClient dropACK rejects with unknown outcome and performs no automatic transport replay',{concurrency:false,timeout:10000},async t=>{
 const fixture=await start(t),client=new actual.SmtpClient(settings,{}),m=message(),attempt=send(client,m);
 const id=await held(fixture,attempt),stored=await assertDurableHeld(fixture,id,m,attempt);
 await fixture.drop(id);await attempt.done;
 assert(attempt.error instanceof Error,'Lost ACK must reject, not manufacture sender success');
 assert.equal(attempt.result,undefined);
 assert(['ECONNECTION','ESOCKET'].includes(attempt.error.code),'Actual nodemailer disconnect classification');
 assert.deepEqual(await fixture.read(id),stored);
 assert.equal((await fixture.list())[0].decision,'DROP_CONNECTION_WITHOUT_ACK');
 await delay(350);
 assert.equal(fixture.inspect().stored,1,'Receiver does not dedupe; another transport send would create another durable effect');
 assert.equal(fixture.inspect().pending_ack_ids.length,0);
 assert.equal(fixture.inspect().dedupe,false);
 assert.equal(connectTargets.length,2,'Exactly one physical connection per actual send');
 assert.equal(externalDnsCalls,0);
 // No processEmail/worker is invoked: durable uncertain/jobs/lease/restart
 // no-replay remain a separate ordinary application acceptance requirement.
});

test('actual client refuses a non-test recipient before connecting to the local fixture',{concurrency:false,timeout:10000},async t=>{
 const fixture=await start(t),client=new actual.SmtpClient(settings,{});
 await assert.rejects(client.send({...message(),recipient:'buyer@example.com'}),error=>error.status===422);
 assert.equal(fixture.inspect().stored,0);assert.equal(fixture.inspect().connections,0);
 assert.equal(externalDnsCalls,0);
 assert.equal(connectTargets.length,2,'Rejected recipient never opens a physical connection');
});


test('owner-private SMTP port is strict, default1025 preserved, other-profile ports/hosts/senders refuse before transport',()=>{
 const defaults=loadActualClient({encryptionKey:syntheticKey},false);assert.equal(defaults.localSmtpPort(),1025);assert.equal(new defaults.SmtpClient(settings,{}).settings.port,1025);
 const selected=loadActualClient({encryptionKey:syntheticKey,localSmtpPort:2525},false);assert.equal(selected.localSmtpPort(),2525);assert.equal(new selected.SmtpClient({...settings,port:2525},{}).settings.port,2525);
 for(const change of [{port:1025},{port:2526},{host:'localhost'},{host:'127.0.0.2'},{host:'smtp.example.com'},{from_email:'sender@example.com'}])assert.throws(()=>new selected.SmtpClient({...settings,port:2525,...change},{}));
 for(const localSmtpPort of [null,true,'2525',0,25,1023,65536,1.5,NaN,Infinity]){const mod=loadActualClient({encryptionKey:syntheticKey,localSmtpPort},false);assert.throws(()=>mod.localSmtpPort(),error=>error.status===500);assert.throws(()=>new mod.SmtpClient({...settings,port:2525},{}));}
 for(const localSmtpPort of [1024,65535])assert.equal(loadActualClient({encryptionKey:syntheticKey,localSmtpPort},false).localSmtpPort(),localSmtpPort);
 assert.equal(externalDnsCalls,0);
});

test('actual unadapted SmtpClient uses owner-selected real ACK service port: held/release/drop, no external DNS',{timeout:15000},async t=>{
 const base=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'ack-owner-'))),directory=path.join(base,'service');
 const entry=fileURLToPath(new URL('../tools/local/smtp-ack-fixture-service.mjs',import.meta.url));
 const child=spawn(process.execPath,[entry,'start',directory],{stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
 const terminal=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));});
 t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');await terminal;}await fs.rm(base,{recursive:true,force:true});});
 let address;for(let i=0;i<300;i++){try{const state=JSON.parse(await fs.readFile(path.join(directory,'state.json'),'utf8'));if(state.status==='READY'){address=state.address;break;}}catch(e){if(e.code!=='ENOENT')throw e;}assert.equal(child.exitCode,null);await delay(10);}assert(address);assert.notEqual(address.port,1025);
 const mod=loadActualClient({encryptionKey:syntheticKey,localSmtpPort:address.port},false),client=new mod.SmtpClient({...settings,port:address.port},{});let n=0;
 async function command(command,id){const output=path.join(base,'out-'+(++n)+'.json'),summary=await requestSmtpAckFixtureService({directory,command,output,...(id?{id}:{})});assert.equal(summary.ok,true);return JSON.parse(await fs.readFile(output,'utf8')).result;}
 async function pending(){for(let i=0;i<300;i++){const value=await command('inspect');if(value.pending_ack_ids.length)return value.pending_ack_ids[0];await delay(10);}assert.fail('Actual client did not reach real service DATA');}
 const accepted=send(client,message()),a=await pending();await delay(30);assert.equal(accepted.settled,false);await command('release',a);await accepted.done;assert.equal(accepted.result.accepted_by_smtp,true);assert.equal(accepted.result.delivered,false);
 const unknown=send(client,message()),b=await pending();assert.notEqual(a,b);await command('drop',b);await unknown.done;assert(unknown.error instanceof Error);assert.equal(unknown.result,undefined);await delay(100);
 const list=await command('list');assert.equal(list.length,2);assert.deepEqual(list.map(x=>x.decision),['RELEASE_250_REQUESTED','DROP_CONNECTION_WITHOUT_ACK']);
 assert.equal(externalDnsCalls,0);assert(!stdout.includes('Synthetic fixture content'));assert.equal(stderr,'');await command('close');assert.deepEqual(await terminal,{code:0,signal:null});
});
