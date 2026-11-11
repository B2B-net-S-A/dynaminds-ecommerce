import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {HISTORY206_PREVIEW_REVISION,HISTORY206_PREVIEW06_REVISION,validateHistory206PreviewLocator,readHistory206PreviewLocator,
 createHistory206PreviewTransport,assertHistory206PreviewReady,prepareHistory206Cases,prepareHistory206CasesFromPreview,assertHistory206CasesFileFresh} from './return-credit206-api-fixture.mjs';
const locator=()=>({schema:'dynaminds-return-credit206-preview-locator/v1',baseUrl:'http://127.0.0.1:4103',
 databaseUrl:'postgres://postgres:CONTROLLED_NOT_REAL@127.0.0.1:55432/dynaminds_full_base_preview_20261017',
 expectedRevision:HISTORY206_PREVIEW_REVISION,casesFile:'/private/controlled-cases.json',
 login:{email:'controlled@example.test',password:'CONTROLLED_NOT_REAL'}});
const reply=(body,status=200,headers={})=>new Response(JSON.stringify(body),{status,headers});
test('preview locator accepts only exact synthetic copy, loopback4103 and revision05',()=>{
 const valid=validateHistory206PreviewLocator(locator());assert(Object.isFrozen(valid)&&Object.isFrozen(valid.login));
 for(const patch of [
  {baseUrl:'http://127.0.0.1:4100'},{baseUrl:'http://localhost:4103'},{baseUrl:'http://127.0.0.1:4103/'},
  {expectedRevision:'a'.repeat(64)},{casesFile:'relative.json'},
  {databaseUrl:locator().databaseUrl.replace('dynaminds_full_base_preview_20261017','dynaminds_main')},
  {databaseUrl:locator().databaseUrl.replace('127.0.0.1','remote.example.test')},
  {databaseUrl:locator().databaseUrl+'?options=controlled'},{extra:true},
 ])assert.throws(()=>validateHistory206PreviewLocator({...locator(),...patch}));
});
test('explicit preview06 admission pins its exact revision while default05 and arbitrary profiles still refuse',()=>{
 const six={...locator(),expectedRevision:HISTORY206_PREVIEW06_REVISION};
 assert.throws(()=>validateHistory206PreviewLocator(six));assert.equal(validateHistory206PreviewLocator(six,'preview06').expectedRevision,HISTORY206_PREVIEW06_REVISION);
 assert.throws(()=>validateHistory206PreviewLocator(locator(),'preview06'));
 for(const profile of ['preview07','a'.repeat(64),null,{}])assert.throws(()=>validateHistory206PreviewLocator(six,profile));
 for(const patch of [{expectedRevision:'a'.repeat(64)},{baseUrl:'http://127.0.0.1:4100'},{databaseUrl:six.databaseUrl.replace('dynaminds_full_base_preview_20261017','dynaminds_main')}])assert.throws(()=>validateHistory206PreviewLocator({...six,...patch},'preview06'));
});
test('preview06 secure reader and transport require explicit profile and actual matching writable health',async()=>{
 const dir=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'history206-preview06-'))),six={...locator(),expectedRevision:HISTORY206_PREVIEW06_REVISION};
 try{const file=path.join(dir,'locator.json');await fs.writeFile(file,JSON.stringify(six),{mode:0o600});await assert.rejects(readHistory206PreviewLocator(file));assert.equal((await readHistory206PreviewLocator(file,'preview06')).expectedRevision,HISTORY206_PREVIEW06_REVISION);
  let calls=0;assert.throws(()=>createHistory206PreviewTransport(six,async()=>{calls++;return reply({});}));assert.equal(calls,0);
  for(const patch of [{revision:HISTORY206_PREVIEW_REVISION},{restore_preview:true},{status:'failed'}]){const app=createHistory206PreviewTransport(six,async()=>reply({status:'ok',revision:HISTORY206_PREVIEW06_REVISION,restore_preview:false,...patch}),'preview06');await assert.rejects(assertHistory206PreviewReady(app,six,'preview06'));}
  const app=createHistory206PreviewTransport(six,async()=>reply({status:'ok',revision:HISTORY206_PREVIEW06_REVISION,restore_preview:false}),'preview06');await assertHistory206PreviewReady(app,six,'preview06');await assert.rejects(assertHistory206PreviewReady(app,six));
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('private locator requires literal0600 and one hardlink; symlinks and malformed JSON refuse',async()=>{
 const dir=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'history206-locator-')));
 try{const file=path.join(dir,'locator.json');await fs.writeFile(file,JSON.stringify(locator()),{mode:0o600});
  assert.equal((await readHistory206PreviewLocator(file)).expectedRevision,HISTORY206_PREVIEW_REVISION);
  for(const mode of [0o400,0o644,0o700]){await fs.chmod(file,mode);await assert.rejects(readHistory206PreviewLocator(file));}await fs.chmod(file,0o600);
  const hardlink=path.join(dir,'hardlink.json');await fs.link(file,hardlink);await assert.rejects(readHistory206PreviewLocator(hardlink));await fs.unlink(hardlink);
  const link=path.join(dir,'symlink.json');await fs.symlink(file,link);await assert.rejects(readHistory206PreviewLocator(link));
  await fs.writeFile(file,'{"password":"CONTROLLED_SECRET"');await assert.rejects(readHistory206PreviewLocator(file),e=>e.message==='Invalid private locator JSON');
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('HTTP adapter sends actual local JSON/cookie once and never forwards remoteAddress or accepts arbitrary targets',async()=>{
 const calls=[],app=createHistory206PreviewTransport(locator(),async(url,options)=>{calls.push({url,options});return reply({own:true},201,{'set-cookie':'dyna_session=CONTROLLED; Path=/; HttpOnly'});});
 const result=await app.inject({url:'/api/orders?own=1',method:'POST',payload:{quantity:1},headers:{cookie:'dyna_session=CONTROLLED'},remoteAddress:'127.165.0.2'});
 assert.equal(result.statusCode,201);assert.deepEqual(result.json(),{own:true});assert.match(result.headers['set-cookie'],/^dyna_session=CONTROLLED/);
 assert.equal(calls.length,1);assert.equal(calls[0].url,'http://127.0.0.1:4103/api/orders?own=1');
 assert.equal(calls[0].options.redirect,'error');assert.equal(calls[0].options.headers.cookie,'dyna_session=CONTROLLED');
 assert.equal(calls[0].options.body,'{"quantity":1}');assert.equal(calls[0].options.remoteAddress,undefined);
 for(const request of [{url:'https://external.test/api/x'},{url:'//external.test/api/x'},{url:'/api/../health'},
  {url:'/api/%2e%2e/health'},{url:'/api/x',method:'DELETE'},{url:'/api/x',headers:{authorization:'controlled'}},
  {url:'/api/x',headers:{cookie:'bad\r\nheader'}},{url:'/api/x',method:'GET',payload:{x:1}}])
  await assert.rejects(app.inject(request));
 assert.equal(calls.length,1);
});
test('lost HTTP acknowledgement never retries or leaks transport diagnostics; bounded malformed JSON refuses',async()=>{
 let calls=0;const app=createHistory206PreviewTransport(locator(),async()=>{calls++;throw Error('CONTROLLED_PRIVATE_DIAGNOSTIC');});
 await assert.rejects(app.inject({url:'/api/orders',method:'POST',payload:{x:1}}),e=>e.message==='Local fixture HTTP result unconfirmed; inspect own tenant before retry');assert.equal(calls,1);
 for(const response of [new Response('not-json'),new Response(' '.repeat(4*1024*1024+1))]){
  const client=createHistory206PreviewTransport(locator(),async()=>response);await assert.rejects(client.inject({url:'/api/health'}));
 }
});
test('readiness must confirm writable preview05 before allowing fixture work',async()=>{
 for(const health of [{ok:true,revision:HISTORY206_PREVIEW_REVISION,restore_preview:false},{status:'failed',revision:HISTORY206_PREVIEW_REVISION,restore_preview:false},
  {status:'ok',revision:'previous',restore_preview:false},{status:'ok',revision:HISTORY206_PREVIEW_REVISION,restore_preview:true},
  {status:'ok',revision:HISTORY206_PREVIEW_REVISION}]){
  const app=createHistory206PreviewTransport(locator(),async()=>reply(health));await assert.rejects(assertHistory206PreviewReady(app,locator()));
 }
 const app=createHistory206PreviewTransport(locator(),async()=>reply({status:'ok',revision:HISTORY206_PREVIEW_REVISION,restore_preview:false}));await assertHistory206PreviewReady(app,locator());
});
test('public scratch fixture cannot admit Main or the preview copy with a forged flag/token and performs no IO',async()=>{
 for(const databaseUrl of [locator().databaseUrl,locator().databaseUrl.replace('dynaminds_full_base_preview_20261017','dynaminds_main')]){
  let called=0;await assert.rejects(prepareHistory206Cases({app:{inject:async()=>{called++;throw Error('Unexpected HTTP');}},databaseUrl,casesFile:'/private/never-written',previewAdmission:{}}));
  assert.equal(called,0);
 }
});

test('fresh cases destination is checked before driver HTTP and SQL; existing file/symlink and public or aliased parent refuse without writes',async()=>{
 const dir=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'history206-cases-preflight-'))),oldFetch=globalThis.fetch;
 let calls=0;globalThis.fetch=async()=>{calls++;throw Error('Controlled transport must not be reached');};
 try{
  await fs.chmod(dir,0o700);const file=path.join(dir,'locator.json'),destination=path.join(dir,'cases.json');
  const configure=async casesFile=>fs.writeFile(file,JSON.stringify({...locator(),casesFile}),{mode:0o600});
  await configure(destination);assert.equal((await assertHistory206CasesFileFresh(destination)).parent,dir);await assert.rejects(fs.stat(destination),{code:'ENOENT'});
  await fs.writeFile(destination,'OWN_PRESERVED_CASES',{mode:0o600});await assert.rejects(prepareHistory206CasesFromPreview(file),/Fresh cases file required/);assert.equal(await fs.readFile(destination,'utf8'),'OWN_PRESERVED_CASES');assert.equal(calls,0);
  await fs.unlink(destination);const target=path.join(dir,'own-target.json');await fs.writeFile(target,'OWN_PRESERVED_TARGET',{mode:0o600});await fs.symlink(target,destination);
  await assert.rejects(prepareHistory206CasesFromPreview(file),/Fresh cases file required/);assert.equal(await fs.readFile(target,'utf8'),'OWN_PRESERVED_TARGET');assert.equal(calls,0);await fs.unlink(destination);
  await fs.chmod(dir,0o755);await assert.rejects(prepareHistory206CasesFromPreview(file),/0700 cases parent/);assert.equal(calls,0);await fs.chmod(dir,0o700);
  const real=path.join(dir,'real-private'),alias=path.join(dir,'aliased-private');await fs.mkdir(real,{mode:0o700});await fs.symlink(real,alias);await configure(path.join(alias,'cases.json'));
  await assert.rejects(prepareHistory206CasesFromPreview(file),/Canonical cases parent/);assert.equal(calls,0);await assert.rejects(fs.stat(path.join(real,'cases.json')),{code:'ENOENT'});
 }finally{globalThis.fetch=oldFetch;await fs.rm(dir,{recursive:true,force:true});}
});
test('locator snapshot refuses inode replacement or permission changes during a bounded FD read',async()=>{
 const dir=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'history206-locator-cut-'))),open=fs.open;
 try{
  const file=path.join(dir,'locator.json'),original=JSON.stringify(locator());
  for(const change of ['replace','chmod']){
   await fs.writeFile(file,original,{mode:0o600});await fs.chmod(file,0o600);let injected=false;
   fs.open=async(...args)=>{const fd=await open(...args);return new Proxy(fd,{get(target,key){if(key==='read')return async(...readArgs)=>{const result=await target.read(...readArgs);if(!injected){injected=true;if(change==='replace'){await fs.rename(file,path.join(dir,'previous.json'));await fs.writeFile(file,original,{mode:0o600});}else await fs.chmod(file,0o644);}return result;};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});};
   await assert.rejects(readHistory206PreviewLocator(file),/Locator changed during read/);assert.equal(injected,true);fs.open=open;
  }
 }finally{fs.open=open;await fs.rm(dir,{recursive:true,force:true});}
});
