/** Synthetic HTTP/process protocol tests of the ENTIRE actual runner.
 * Real private files and fsync; NO app, listener, worker, SMTP service or PG.
 * Import seams exist only here, never as product callbacks/authority flags. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {createRequire} from 'node:module';
import {randomUUID,createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {transformSync} from 'esbuild';
import {validateStackProfile} from '../tools/local/stack.mjs';
import {prepareWorkerSmtpAckAcceptance,assertWorkerFixtureRule} from '../tools/parity/worker-smtp-ack-acceptance.mjs';
const require=createRequire(import.meta.url),sourceURL=new URL('../tools/parity/worker-smtp-ack-acceptance.mjs',import.meta.url),source=readFileSync(sourceURL,'utf8');
const sha=b=>createHash('sha256').update(b).digest('hex');
const json=async file=>JSON.parse(await fs.readFile(file,'utf8'));
const save=async(file,value)=>{const b=typeof value==='string'?value:JSON.stringify(value);const tmp=file+'.tmp-'+randomUUID();await fs.writeFile(tmp,b,{mode:0o600,flag:'wx'});await fs.rename(tmp,file);return{path:file,sha256:sha(b)};};
function rule(f){return{id:f.rule_id,actor_id:f.actor_id,enabled:true,config:{},definition:{trigger:'order.note_added',match:'all',delay_seconds:0,conditions:[{field:'tag',op:'contains',value:f.tag}],actions:[{type:'email',mode:'smtp',channel_id:f.channel_id,template_id:f.template_id,confirm_external:false}]}};}
async function fixture(t){
 const dir=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'wsa-')));await fs.chmod(dir,0o700);t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const release=path.join(dir,'release'),smtp=path.join(dir,'smtp');await fs.mkdir(path.join(release,'runtime','server'),{recursive:true,mode:0o700});await fs.mkdir(smtp,{mode:0o700});
 const manifest=await save(path.join(release,'release.json'),{synthetic_protocol_fixture:true}),entry=await save(path.join(release,'runtime/server/ordinary-local-cli.mjs'),'/* synthetic; must never execute */');
 const revision=manifest.sha256,config=await save(path.join(dir,'config.json'),{dbPassword:'synthetic-secret',encryptionKey:'a'.repeat(64),localSmtpPort:31025});
 const ordinary={releaseDirectory:release,manifestSha:revision,expectedOwner:'postgres',databaseUrl:'postgres://postgres:synthetic-secret@127.0.0.1:57084/dynaminds_worker_acceptance_1792310000000',localConfigurationPath:config.path,revision};
 const ordinaryRef=await save(path.join(dir,'ordinary.json'),ordinary),profile={schema:'dynaminds-local-stack/v1',startupMs:1000,shutdownMs:1000,logBytes:4096,services:[{id:'app',entry,imports:[],args:[ordinaryRef.path,ordinaryRef.sha256,'4143','--verified-stock-writers','--scoped-automation'],cwd:dir,envPaths:{},files:[],ports:[4143],ready:{kind:'http',port:4143,path:'/api/health',status:200,json:{revision,schema_revision:'210_synthetic_protocol',restore_preview:false,scoped_automation_enabled:true,background_workers_enabled:false},ca:null}}]};
 const profileRef=await save(path.join(dir,'profile.json'),profile),auth=[];
 for(let i=0;i<2;i++)auth.push(await save(path.join(dir,'auth'+i+'.json'),{schema:'dynaminds-worker-acceptance-auth/v1',email:'actor'+i+'@fixture.test',password:'synthetic-password'}));
 await save(path.join(smtp,'state.json'),{schema:'dynaminds-smtp-ack-service/v1',status:'READY',pid:process.pid,address:{host:'127.0.0.1',port:31025}});
 await save(path.join(smtp,'owner.lock'),{schema:'dynaminds-smtp-ack-service-owner/v1',pid:process.pid,nonce:randomUUID()});
 const fixtures=[0,1].map(i=>Object.fromEntries([...['tenant_id','actor_id','rule_id','channel_id','template_id','accepted_order_id','lost_order_id','paused_order_id'].map(k=>[k,randomUUID()]),['recipient','buyer'+i+'@fixture.test'],['tag','worker-1234567'+i]]));
 const selection={schema:'dynaminds-worker-smtp-ack-acceptance/v1',revision,expectedSchema:'210_synthetic_protocol',apiPort:4143,stackProfile:profileRef,smtpDirectory:smtp,auth,fixtures,observationMs:13000},selectionRef=await save(path.join(dir,'selection.json'),selection);
 return{dir,profile,ordinary,config,selection,selectionRef,out:path.join(dir,'attempt'),async resave(){this.selectionRef=await save(path.join(dir,'selection.json'),this.selection);},async profileSave(){this.selection.stackProfile=await save(profileRef.path,this.profile);await this.resave();},async ordinarySave(){const r=await save(ordinaryRef.path,this.ordinary);this.profile.services[0].args[1]=r.sha256;await this.profileSave();}};
}
async function harness(t,options={}){
 const f=await fixture(t),calls=[],posts=[],spawns=[],commands=[],effects=[],messages=new Map(),orders=new Map(),activations=[null,null],versions=['1','1'],syncs=[];let now=0,active,stopWaiting,requestChunks=0,drainPending=null,delayedObservations=0;
 for(const x of f.selection.fixtures)for(const key of ['accepted_order_id','lost_order_id','paused_order_id'])orders.set(x[key],{id:x[key],tenant_id:x.tenant_id,source:'manual',status:'new',warehouse_id:randomUUID(),email:x.recipient,address:{country:'PL'},effective_delivery:{enabled:false},total:100,shipping_cost:0,items:[],picking_items:[],tags:[x.tag],shipments:[],documents:[],note:''});
 const mockFs={...fs,async open(file,...args){const h=await fs.open(file,...args),original=h.sync.bind(h);h.sync=async()=>{syncs.push(file);if(options.failSync&&file.endsWith('.intent.json'))throw Error('synthetic durable intent failure');return original();};return h;}};
 const recentIntent=async()=>{const files=(await fs.readdir(f.out)).filter(n=>/^\d{4}\./.test(n)).sort();return{file:files.at(-1),value:await json(path.join(f.out,files.at(-1)))};};
 const completeStop=async(failed=false)=>{if(!stopWaiting)return;const{child,state,owner}=stopWaiting;stopWaiting=null;await save(state,{profile_sha256:f.selection.stackProfile.sha256,status:options.badClose?'close-unconfirmed':'closed',error:null,cleanup:[]});owner.emit('close',failed||options.noDraining?1:0,null);child.emit('close',failed||options.noDraining?1:0,null);active=null;};
 function spawn(executable,args,settings){
  assert.equal(executable,process.execPath);assert(args[0].endsWith('/tools/local/stack.mjs'));assert(['start','stop'].includes(args[1]));assert.equal(args[2],f.selection.stackProfile.path);assert.equal(path.dirname(args[3]),f.out);assert.deepEqual(settings.stdio,['ignore','pipe','pipe']);spawns.push(args.slice(1));
  const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.kill=()=>assert.fail('no real process or escalation allowed');
  if(args[1]==='start'){active=child;queueMicrotask(()=>{void save(args[3],{profile_sha256:f.selection.stackProfile.sha256,status:'ready'});});}
  else{stopWaiting={child,state:args[3],owner:active};setTimeout(()=>{if(stopWaiting?.child===child)void completeStop(true);},1000);/* referenced on purpose: the 1 s timer models the stop process exiting by itself; when nothing else is pending (noDraining) an unref'd timer let Node end the event loop first */if(effects.some(e=>e.decision===null)&&!options.noDraining){const mark=()=>save(args[3],{profile_sha256:f.selection.stackProfile.sha256,status:'draining'});if(options.delayedDrain)drainPending=mark;else queueMicrotask(()=>{void mark();});}if(!effects.some(e=>e.decision===null)||options.prematureClose||options.lostNote)queueMicrotask(()=>{void completeStop();});}
  return child;
 }
 const smtp=async({command,id,output})=>{
  commands.push({command,id});if(command==='release'){assert.equal((await json(stopWaiting.state)).status,'draining');}const intent=await recentIntent();assert.equal(intent.value.command,command);if(id)assert.equal(intent.value.id,id);assert(syncs.includes(path.join(f.out,intent.file))&&syncs.includes(f.out));
  let result;if(command==='inspect')result={stored:effects.length,pending_ack_ids:effects.filter(e=>!e.decision).map(e=>e.id)};
  else if(command==='list')result=effects.map(({raw_base64,message,...e})=>e);
  else if(command==='read')result={raw_base64:effects.find(e=>e.id===id).raw_base64};
  else{const e=effects.find(e=>e.id===id);assert(e&&!e.decision);e.decision=command==='release'?'RELEASE_250_REQUESTED':'DROP_CONNECTION_WITHOUT_ACK';e.message.state=command==='release'?'smtp_accepted':'uncertain';if(command==='drop'&&options.lostControl){await save(output,{status:'CONTROL_REQUEST_INTENT',request:{command,id}});throw Error('synthetic control ACK lost');}await completeStop();result={id,action:e.decision};}
  await save(output,{ok:true,result});return{ok:true};
 };
 const fetcher=async(url,init)=>{
  const u=new URL(url);assert.equal(u.origin,'http://127.0.0.1:4143');const body=init.body?JSON.parse(init.body):null;calls.push({path:u.pathname,method:init.method,body});
  const i=body?.email?Number(body.email[5]):body?.tenant_id?f.selection.fixtures.findIndex(x=>x.tenant_id===body.tenant_id):Number((init.headers.cookie??'session=0').split('=').at(-1)),x=f.selection.fixtures[i];assert(x);
  if(init.method==='POST'){
   const intent=await recentIntent();assert.equal(intent.value.path,u.pathname);assert(syncs.includes(path.join(f.out,intent.file))&&syncs.includes(f.out),'file and directory fsync precede dispatch');assert.equal((await fs.stat(path.join(f.out,intent.file))).mode&0o777,0o600);
   if(body.client_key){assert.equal(intent.value.client_key,body.client_key);assert.deepEqual(intent.value.body,body);}else if(u.pathname.endsWith('/operations'))assert.deepEqual(intent.value.body,body);
   else{assert.equal(intent.value.body,undefined);assert.equal(intent.value.body_sha256,sha(init.body));assert.equal(intent.value.auth_locator.path,f.selection.auth[i].path);}
   posts.push({path:u.pathname,body});
  }
  if(u.pathname==='/api/health'){
   if(options.oversize)return{status:200,headers:new Headers(),body:(async function*(){try{for(let n=0;n<10;n++){requestChunks++;yield Buffer.alloc(1048576);}}finally{options.streamClosed=true;}})()};
   return Response.json({status:'ok',...f.profile.services[0].ready.json,email_available:true,...(options.badHealth?{revision:'b'.repeat(64)}:{})});
  }
  if(u.pathname==='/api/auth/login'||u.pathname==='/api/workspaces/switch')return Response.json({ok:true},{headers:{'set-cookie':'session='+i+'; Path=/'}});
  if(u.pathname==='/api/auth/me')return Response.json({user:{id:x.actor_id,tenant_id:x.tenant_id,role:options.badIam?'viewer':'admin'},restore_preview:false});
  if(u.pathname==='/api/automations')return Response.json({data:[rule(x)]});
  if(u.pathname==='/api/automations/local-effects/options')return Response.json({smtp_channels:[{id:x.channel_id}]});
  if(u.pathname.endsWith('/local-worker')){
   if(!u.pathname.includes(x.rule_id))return Response.json({denied:true},{status:options.crossAllowed?200:404});
   if(init.method==='POST'){versions[i]=String(BigInt(versions[i])+1n);activations[i]={enabled:body.enabled,owner_id:x.actor_id,client_key:body.client_key,rule_version:versions[i]};if(options.lostBusiness)throw Error('synthetic configuration ACK lost');return Response.json({status:'AUTOMATIC_RULE_CONFIGURATION_ACKNOWLEDGED',rule_id:x.rule_id,version:versions[i],activation:activations[i]});}
   const unknown=[...messages.values()].filter(m=>m.state==='uncertain'&&orders.get(m.order).tenant_id===x.tenant_id).map(m=>({message_id:m.id,job_id:m.job_id,reconciliation_required:true}));
   return Response.json({version:versions[i],activation:activations[i],jobs:options.dirtyJobs?[{state:'running',attempts:1}]:[],child_effects:[],unresolved_effects:{data:unknown,has_more:false,next_cursor:null},reconciliation_required:unknown.length>0,runtime:{pause_scope:'RULE_CONFIGURATION_ONLY_NOT_DRAIN_ACK',state:'RUNNING',started:true,draining:false,last_cycle:{finished_at:new Date(now).toISOString()}},automatic_retry:false});
  }
  if(u.pathname==='/api/email/messages'){const m=messages.get(u.searchParams.get('order_id'));return Response.json({data:m?[m]:[],has_more:false,next_cursor:null});}
  if(u.pathname.startsWith('/api/orders/')){
   const oid=u.pathname.split('/')[3],o=orders.get(oid);assert(o);if(o.tenant_id!==x.tenant_id)return Response.json({denied:true},{status:options.crossAllowed?200:404});
   if(init.method==='POST'){
    assert.equal(body.type,'add_note');assert(!o.note);o.note=body.note;
    if(activations[i]?.enabled){const m={id:randomUUID(),job_id:randomUUID(),order:oid,payload:{recipient:x.recipient},attempted_at:'2026-10-18T00:00:00.000Z',state:'sending'};messages.set(oid,m);effects.push({id:randomUUID(),envelope:{to:[x.recipient]},decision:null,raw_base64:Buffer.from('X-Dynaminds-Message: '+m.id+'\r\n\r\nsynthetic').toString('base64'),message:m});}
    if(options.lostNote)throw Error('synthetic note ACK lost');return Response.json(o);
   }return Response.json(o);
  }assert.fail('unmodeled actual runner route '+u.pathname);
 };
 const ports=id=>{
  if(id==='node:child_process')return{spawn};if(id==='node:fs/promises')return{...mockFs,default:mockFs};
  if(id==='node:timers/promises')return{setTimeout:async ms=>{now+=ms;if(drainPending&&++delayedObservations>=3){const mark=drainPending;drainPending=null;await mark();}if(options.noDraining&&stopWaiting&&now>=6000)await completeStop();await new Promise(r=>setImmediate(r));}};
  if(id==='../local/stack.mjs')return{validateStackProfile};if(id==='../local/smtp-ack-fixture-service.mjs')return{requestSmtpAckFixtureService:smtp};
  assert(['node:assert/strict','node:fs','node:path','node:url','node:crypto'].includes(id),'unexpected dependency');return require(id);
 };
 const module={exports:{}};class Clock extends Date{static now(){return now;}}
 // Whole source transformed; only import.meta URL and dependency ports controlled.
 const transformed=transformSync(source,{format:'cjs',target:'node22',define:{'import.meta.url':JSON.stringify(sourceURL.href)}}).code;
 Function('require','module','exports','fetch','Date',transformed)(ports,module,module.exports,fetcher,Clock);
 return{...f,calls,posts,spawns,commands,effects,syncs,get chunks(){return requestChunks;},get delayedObservations(){return delayedObservations;},run:()=>module.exports.runWorkerSmtpAckAcceptance({selection:f.selectionRef,outputDirectory:f.out})};
}
test('actual prepare is file-only, private and unaccepted; rule scope is closed',async t=>{
 const f=await fixture(t),r=await prepareWorkerSmtpAckAcceptance(f.selectionRef);assert.equal(r.status,'PREPARED_NOT_EXECUTED');assert.deepEqual(r.claims,{app_started:false,business_writes:0,worker_acceptance:false,external_delivery:false});assert.equal(r.configuration_port,31025);
 const x=f.selection.fixtures[0];assertWorkerFixtureRule(rule(x),x);
 for(const change of [r=>r.actor_id=randomUUID(),r=>r.definition.actions.push({type:'set_status'}),r=>r.definition.actions[0].channel_id=randomUUID(),r=>r.definition.delay_seconds=1,r=>r.definition.conditions=[]]){const wrong=rule(x);change(wrong);assert.throws(()=>assertWorkerFixtureRule(wrong,x));}
});
test('private provenance, APP16, other tenant reuse, external/main DB and broad flags refuse',async t=>{
 const f=await fixture(t),original=structuredClone(f.selection);
 for(const change of [p=>p.revision='691a7cb5e943e1474411906e9f5b9e69143761bf6e74676f6415dea4b41b7fac',p=>p.apiPort=4103,p=>p.apiPort=4100,p=>p.fixtures[1].tenant_id=p.fixtures[0].tenant_id,p=>p.fixtures[1].lost_order_id=p.fixtures[0].accepted_order_id,p=>p.auth[0].sha256='0'.repeat(64)]){f.selection=structuredClone(original);change(f.selection);await f.resave();await assert.rejects(prepareWorkerSmtpAckAcceptance(f.selectionRef));}
 f.selection=structuredClone(original);await f.resave();await fs.chmod(f.selection.auth[0].path,0o644);await assert.rejects(prepareWorkerSmtpAckAcceptance(f.selectionRef));await fs.chmod(f.selection.auth[0].path,0o600);
 const before=f.ordinary.databaseUrl;for(const url of ['postgres://postgres:synthetic-secret@external.invalid/dynaminds_worker_acceptance_1792310000000','postgres://postgres:synthetic-secret@127.0.0.1/main']){f.ordinary.databaseUrl=url;await f.ordinarySave();await assert.rejects(prepareWorkerSmtpAckAcceptance(f.selectionRef));}f.ordinary.databaseUrl=before;await f.ordinarySave();f.profile.services[0].args.push('--connector-jobs-sandbox');await f.profileSave();await assert.rejects(prepareWorkerSmtpAckAcceptance(f.selectionRef));
});
test('entire synthetic protocol checks both tenants, held drain and restart; does NOT prove app acceptance',async t=>{
 const m=await harness(t),r=await m.run();assert.equal(r.status,'PASS_LOCAL_API_WORKER_SMTP_LIFECYCLE_ONLY',JSON.stringify({result:r,paths:m.calls.map(x=>x.path),commands:m.commands,spawns:m.spawns.map(s=>s[0])}));assert.equal(r.worker_acceptance,true);assert.equal(r.ui_acceptance,false);assert.equal(r.external_delivery,false);assert.equal(m.effects.length,4);assert.equal(m.commands.filter(c=>c.command==='release').length,2);assert.equal(m.commands.filter(c=>c.command==='drop').length,2);assert.equal(m.spawns.filter(s=>s[0]==='start').length,5);assert.equal(m.spawns.filter(s=>s[0]==='stop').length,5);assert.equal(m.posts.filter(p=>p.path.endsWith('/operations')).length,6);
 assert.equal((await fs.stat(m.out)).mode&0o777,0o700);const saved=await fs.readFile(path.join(m.out,'result.json'),'utf8');assert(!saved.includes('synthetic-password')&&!saved.includes('session='));await assert.rejects(m.run());assert.equal(m.effects.length,4);
});
for(const mode of ['lostBusiness','lostNote','lostControl'])test(mode+' preserves exact original intent and sends no replacement mutation',async t=>{
 const m=await harness(t,{[mode]:true}),r=await m.run();assert.equal(r.status,'FAILED_OR_UNCERTAIN_NO_RETRY');assert.equal(r.worker_acceptance,false);assert.equal(r.automatic_retry,false);const files=(await fs.readdir(m.out)).filter(f=>f.endsWith('.intent.json'));assert(files.length>=5);
 if(mode==='lostControl'){assert.equal(m.commands.filter(c=>c.command==='drop').length,1);const outputs=await Promise.all((await fs.readdir(m.out)).filter(n=>n.startsWith('smtp-')).map(n=>json(path.join(m.out,n))));assert(outputs.some(v=>v.status==='CONTROL_REQUEST_INTENT'&&v.request.command==='drop'&&v.request.id===m.effects.at(-1).id));}
 else{assert.equal(r.pending.length,1);const intent=await json(path.join(m.out,r.pending[0].file));assert(intent.body);if(mode==='lostBusiness'){assert.equal(intent.body.client_key,intent.client_key);assert.equal(m.posts.filter(p=>p.path.endsWith('/local-worker')).length,1);}else{assert.equal(intent.body.type,'add_note');assert.equal(m.posts.filter(p=>p.path.endsWith('/operations')).length,1);assert(m.effects.length===1);}}
});
test('failed intent fsync refuses before auth or business POST',async t=>{const m=await harness(t,{failSync:true}),r=await m.run();assert.equal(r.worker_acceptance,false);assert.equal(m.posts.length,0);assert.equal(r.status,'FAILED_OR_UNCERTAIN_NO_RETRY');});
test('private manifest/entry byte drift and over-limit private data refuse before transport',async t=>{const f=await fixture(t);await fs.appendFile(f.profile.services[0].entry.path,' changed');await assert.rejects(prepareWorkerSmtpAckAcceptance(f.selectionRef));await save(f.profile.services[0].entry.path,'/* synthetic; must never execute */');await fs.appendFile(f.selection.auth[0].path,' '.repeat(4097));await assert.rejects(prepareWorkerSmtpAckAcceptance(f.selectionRef));});
test('bounded streaming stops on third chunk without consuming/truncating oversized response',async t=>{const options={oversize:true},m=await harness(t,options),r=await m.run();assert.equal(r.worker_acceptance,false);assert.equal(m.chunks,3);assert.equal(options.streamClosed,true);assert.equal(m.posts.length,0);});
for(const option of ['badHealth','badIam','crossAllowed','dirtyJobs'])test(option+' refuses before first business POST',async t=>{const m=await harness(t,{[option]:true}),r=await m.run();assert.equal(r.worker_acceptance,false);assert.equal(m.posts.filter(p=>!['/api/auth/login','/api/workspaces/switch'].includes(p.path)).length,0);});
for(const option of ['prematureClose','badClose'])test(option+' never substitutes configuration ACK for actual clean drain',async t=>{const m=await harness(t,{[option]:true}),r=await m.run();assert.equal(r.worker_acceptance,false);assert.equal(r.status,'FAILED_OR_UNCERTAIN_NO_RETRY');});

test('delayed stop command must visibly enter owned draining before release',async t=>{const m=await harness(t,{delayedDrain:true}),r=await m.run();assert.equal(r.status,'PASS_LOCAL_API_WORKER_SMTP_LIFECYCLE_ONLY');assert(m.delayedObservations>=3);assert.equal(m.commands.filter(c=>c.command==='release').length,2);});
test('stop command never reaching draining refuses without release',async t=>{const m=await harness(t,{noDraining:true}),r=await m.run();assert.equal(r.worker_acceptance,false);assert.equal(r.status,'FAILED_OR_UNCERTAIN_NO_RETRY');assert.equal(m.commands.filter(c=>c.command==='release').length,0);assert.equal(r.owner_close_unconfirmed,true);});
