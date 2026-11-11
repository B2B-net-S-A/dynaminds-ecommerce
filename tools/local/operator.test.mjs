import assert from'node:assert/strict';import test from'node:test';import fs from'node:fs';import vm from'node:vm';import{createHash}from'node:crypto';import{createRequire}from'node:module';
import{validateProfile,commandFor,assertSameBirth}from'./operator.mjs';import{validateBackupProfile,checkRestored}from'./backup-operator.mjs';
const runtime={schema:'dynaminds-local-operator/v1',selectionPath:'/private/selection.json',selectionSha:'a'.repeat(64),releaseDirectory:'/private/release',manifestSha:'b'.repeat(64),revision:'b'.repeat(64),configurationPath:'/private/local-configuration.json',database:'dynaminds_main',pgPort:57081,httpPort:4100,cwd:'/private/Main',imageDirectory:'/private/Main/images',flags:['--verified-stock-writers']};
const backup={schema:'dynaminds-local-backup-operator/v1',selectionPath:'/private/selection.json',selectionSha:'a'.repeat(64),sourceDirectory:'/private/source',cwd:'/private/Main',imageDirectory:'/private/Main/images',keyFile:'/private/key',backupDirectory:'/private/backups',restoreDirectory:'/private/restores',restoreGuard:'/private/operator/one-restore.json',expectedDatabase:'dynaminds_main',expectedPort:57081,expectedRevision:'b'.repeat(64),pgToolsDirectory:'/private/pg18/bin',sourcePins:['scripts/backup.ts','server/recovery.ts','server/recovery-relation-acl.ts','server/recovery-restore-toc.ts','server/test-postgres-port.ts'].map(path=>({path,sha256:'c'.repeat(64),bytes:1}))};
test('automatic local reads require a pinned store selection and a running processor in actual health',async()=>{
 const flags=[...runtime.flags,'--local-woo-reads'];
 assert.throws(()=>validateProfile({...runtime,flags}),/reads-require-selection/);
 const p={...runtime,flags,localWooSelection:{file:'/private/stores.json',digest:'e'.repeat(64)}};
 assert(commandFor(p).args.includes('--local-woo-reads'));
 const source=fs.readFileSync(new URL('./operator.mjs',import.meta.url),'utf8');
 const body=source.slice(source.indexOf('async function health(p){'),source.indexOf('\n',source.indexOf('async function health(p){')));
 let reply={status:'ok',revision:p.revision};
 const health=new Function('assert','fetch','AbortSignal',body+';return health;')(assert,async(url,options)=>{assert.equal(url,'http://127.0.0.1:4100/api/health');assert.equal(options.redirect,'error');return{status:200,json:async()=>reply};},AbortSignal);
 await assert.rejects(health(p),/reads-not-enabled/);
 reply={...reply,local_woo_reads_enabled:true,local_woo_read_processor_running:false};
 await assert.rejects(health(p),/processor-not-running/);
 reply.local_woo_read_processor_running=true;
 assert.equal((await health(p)).local_woo_read_processor_running,true);
 reply={status:'ok',revision:p.revision};assert.equal((await health(runtime)).status,'ok');
});
test('actual operator profile and command reject scope widening and stale process identity',()=>{
 assert.deepEqual(validateProfile(runtime),runtime);assert.deepEqual(commandFor(runtime).args,['/private/release/runtime/server/ordinary-local-cli.mjs','/private/selection.json','a'.repeat(64),'4100','--verified-stock-writers']);
 for(const patch of[{unknown:true},{httpPort:80},{httpPort:57081},{pgPort:0},{cwd:'relative'},{selectionPath:'/tmp/../selection'},{manifestSha:'not-a-sha'},{database:'db;drop'},{flags:[]},{flags:['--verified-stock-writers','--arbitrary-post']},{flags:['--verified-stock-writers','--verified-stock-writers']}])assert.throws(()=>validateProfile({...runtime,...patch}));
 const mutable=structuredClone(runtime),snapshot=validateProfile(mutable);mutable.flags.push('--nbp-eur');assert.deepEqual(snapshot.flags,['--verified-stock-writers']);
 assert.equal(commandFor({...runtime,flags:['--verified-stock-writers','--amazon-mcf-sandbox-eu']}).args.at(-1),'--amazon-mcf-sandbox-eu');
 const identity={pid:900001,uid:501,started:'controlled-birth',command_sha256:'c'.repeat(64)};assertSameBirth(identity,structuredClone(identity));for(const patch of[{pid:900002},{uid:502},{started:'different'},{command_sha256:'d'.repeat(64)}])assert.throws(()=>assertSameBirth(identity,{...identity,...patch}));
});
test('only typed pinned importer and connector references become reviewed CLI syntax',()=>{
 const importer={path:'/private/importer.json',sha256:'e'.repeat(64)},connector={file:'/private/connectors.json',digest:'f'.repeat(64)};
 const p={...runtime,flags:['--verified-stock-writers','--amazon-mcf-sandbox-eu','--nbp-eur','--scoped-automation'],installedLargeImportSelection:importer,connectorAccessSelection:connector};
 const args=commandFor(p).args;assert.deepEqual(args.slice(-4),['--installed-importer-selection='+importer.sha256+':'+importer.path,'--connector-access',connector.file,connector.digest]);assert.equal(args.length-1,11);
 for(const patch of[{installedLargeImportSelection:null},{installedLargeImportSelection:{...importer,ready:true}},{installedLargeImportSelection:{...importer,sha256:'bad'}},{installedLargeImportSelection:{...importer,path:'relative'}},{connectorAccessSelection:null},{connectorAccessSelection:{...connector,token:'forbidden'}},{connectorAccessSelection:{...connector,digest:'bad'}},{connectorAccessSelection:{...connector,file:'/tmp/../file'}},{flags:['--verified-stock-writers','--connector-access /arbitrary sha']},{flags:['--verified-stock-writers','--installed-importer-selection=arbitrary']}])assert.throws(()=>commandFor({...runtime,...patch}));
 const copy=validateProfile(p);importer.path='/changed';connector.file='/changed';assert.equal(copy.installedLargeImportSelection.path,'/private/importer.json');assert.equal(copy.connectorAccessSelection.file,'/private/connectors.json');
});
test('typed local stores selection forwards only its pinned reference and preserves legacy profiles',()=>{
 const localWooSelection={file:'/private/local-stores.json',digest:'9'.repeat(64)};
 const p={...runtime,localWooSelection,installedLargeImportSelection:{path:'/private/importer.json',sha256:'e'.repeat(64)},flags:['--verified-stock-writers','--scoped-automation']};
 assert.deepEqual(commandFor(p).args.slice(-4),['--installed-importer-selection='+p.installedLargeImportSelection.sha256+':'+p.installedLargeImportSelection.path,'--local-woo-stores',localWooSelection.file,localWooSelection.digest]);
 const copy=validateProfile(p);localWooSelection.file='/changed';assert.equal(copy.localWooSelection.file,'/private/local-stores.json');
 for(const ref of[null,{},[],{file:'relative',digest:'9'.repeat(64)},{file:'/private/../stores.json',digest:'9'.repeat(64)},{file:'/private/stores.json',digest:'bad'},{file:'/private/stores.json',digest:'9'.repeat(64),origin:'https://other.example'}])assert.throws(()=>commandFor({...runtime,localWooSelection:ref}));
 assert.doesNotThrow(()=>commandFor({...runtime,localWooSelection:copy.localWooSelection,connectorAccessSelection:{file:'/private/providers.json',digest:'8'.repeat(64)}}));
 assert.throws(()=>commandFor({...runtime,localWooSelection:copy.localWooSelection,flags:['--verified-stock-writers','--connector-jobs-sandbox']}),/manual-jobs-require-connector-access/);
 assert.throws(()=>commandFor({...runtime,flags:['--verified-stock-writers','--local-woo-stores /arbitrary sha']}));
});
test('typed Mirakl control database composes with pinned connector and local stores; no URL/credential/freeform flag',()=>{
 const connectorAccessSelection={file:'/private/connectors.json',digest:'f'.repeat(64)},localWooSelection={file:'/private/stores.json',digest:'e'.repeat(64)};
 const p={...runtime,connectorAccessSelection,localWooSelection,miraklReadState:{database:'dynaminds_connector_state'}};
 assert.deepEqual(commandFor(p).args.slice(-7),['--connector-access',connectorAccessSelection.file,connectorAccessSelection.digest,'--local-woo-stores',localWooSelection.file,localWooSelection.digest,'--mirakl-read-state=dynaminds_connector_state']);
 const copy=validateProfile(p);p.miraklReadState.database='changed';assert.equal(copy.miraklReadState.database,'dynaminds_connector_state');
 for(const state of [null,{},[],{database:'dynaminds_main'},{database:'postgres://private:secret@localhost/db'},{database:'dynaminds_connector_state;drop'},{database:'dynaminds_connector_state',password:'secret'}])assert.throws(()=>commandFor({...runtime,connectorAccessSelection,miraklReadState:state}));
 assert.throws(()=>commandFor({...runtime,miraklReadState:{database:'dynaminds_connector_state'}}),/requires-connector-access/);
 assert.throws(()=>commandFor({...runtime,flags:['--verified-stock-writers','--mirakl-read-state=dynaminds_connector_state']}));
});
test('actual operator preflight hashes the private stores selection before any child can be started',()=>{
 const source=fs.readFileSync(new URL('./operator.mjs',import.meta.url),'utf8');
 const body=source.slice(source.indexOf('function preflight(profile){'),source.indexOf('\nfunction birth('));
 assert(body.length>1000);
 const digest=b=>createHash('sha256').update(b).digest('hex');
 const selection=Buffer.from(JSON.stringify({releaseDirectory:runtime.releaseDirectory,manifestSha:runtime.manifestSha,revision:runtime.revision,expectedOwner:'postgres',localConfigurationPath:runtime.configurationPath,databaseUrl:'postgres://postgres@127.0.0.1:57081/dynaminds_main'}));
 const storeBytes=Buffer.from('[]'),manifest=Buffer.from('controlled manifest only');
 const p={...runtime,selectionSha:digest(selection),manifestSha:digest(manifest),revision:digest(manifest),localWooSelection:{file:'/private/stores.json',digest:digest(storeBytes)}};
 // Keep the selection's exact release binding equal to the modeled selected profile.
 const selected=Buffer.from(JSON.stringify({...JSON.parse(selection),manifestSha:p.manifestSha,revision:p.revision}));p.selectionSha=digest(selected);
 let reads=[],wrongHash=false,privateFailure,connectorBytes=Buffer.from(JSON.stringify({providers:[{provider:'mirakl'}]}));
 const connectorFile='/private/connectors.json';
 const privateBytes=(file,max)=>{reads.push({file,max});if(file===p.selectionPath)return Buffer.from(selected);if(file===connectorFile)return Buffer.from(connectorBytes);assert.equal(file,p.localWooSelection.file);if(privateFailure)throw privateFailure;return Buffer.from(wrongHash?'[{}]':storeBytes);};
 const fakefs={lstatSync:file=>file===p.configurationPath?{uid:process.getuid(),nlink:1,mode:0o100600,isFile:()=>true,isSymbolicLink:()=>false}:{isDirectory:()=>true,isSymbolicLink:()=>false},realpathSync:x=>x,readFileSync:file=>{assert.equal(file,p.releaseDirectory+'/release.json');return manifest;}};
 const preflight=new Function('validateProfile','privateBytes','assert','fs','process','URL','sha','commandFor',body+';return preflight;')(validateProfile,privateBytes,assert,fakefs,process,URL,digest,commandFor);
 assert.deepEqual(preflight(p),commandFor(p));assert.deepEqual(reads,[{file:p.selectionPath,max:undefined},{file:p.localWooSelection.file,max:16384}]);
 wrongHash=true;assert.throws(()=>preflight(p));wrongHash=false;
 privateFailure=Error('modeled private-owned-file refusal');assert.throws(()=>preflight(p),e=>e===privateFailure);
 privateFailure=undefined;
 const mirakl={...p,connectorAccessSelection:{file:connectorFile,digest:digest(connectorBytes)},miraklReadState:{database:'dynaminds_connector_state'}};
 assert.deepEqual(preflight(mirakl),commandFor(mirakl));
 connectorBytes=Buffer.from(JSON.stringify({providers:[{provider:'inpost'}]}));mirakl.connectorAccessSelection.digest=digest(connectorBytes);
 assert.throws(()=>preflight(mirakl),/requires-selected-connector/,'even a correctly pinned selection must actually include Mirakl');
 // The real privateBytes implementation supplies NOFOLLOW/0600/owner/link/
 // before-and-after identity checks; this test models its rejection boundary.
});
test('actual backup profile/receipt refuse a foreign DB, unsafe paths, unverified state and active workers',()=>{
 assert.deepEqual(validateBackupProfile(backup),backup);for(const patch of[{extra:true},{expectedPort:0},{expectedPort:65536},{expectedDatabase:'db;DROP'},{selectionPath:'relative'},{pgToolsDirectory:'/private/../pg'},{expectedRevision:'unknown'},{sourcePins:[]},{sourcePins:backup.sourcePins.filter(x=>x.path!=='server/recovery-relation-acl.ts')},{sourcePins:backup.sourcePins.filter(x=>x.path!=='server/recovery-restore-toc.ts')},{sourcePins:[...backup.sourcePins,{path:'arbitrary.ts',sha256:'d'.repeat(64),bytes:1}]}])assert.throws(()=>validateBackupProfile({...backup,...patch}));
 const id='666deea4081b66c3',r={status:'verified',database:'dynaminds_restore_'+id,id,directory:'/private/restores/'+id,config:'/private/restores/'+id+'/local-config.json',images:'/private/restores/'+id+'/images',source:'dynaminds_main',revision:'b'.repeat(64),preview_only:true,worker_enabled:false,row_fingerprints_match:true,schema_fingerprint_match:true};assert.deepEqual(checkRestored(r,backup),r);
 for(const patch of[{id:'../../escape'},{database:'dynaminds_restore_aaaaaaaaaaaaaaaa'},{database:'dynaminds_main'},{source:'another_main'},{revision:'d'.repeat(64)},{preview_only:false},{worker_enabled:true},{row_fingerprints_match:false},{schema_fingerprint_match:false},{directory:'/private/other'},{config:'/private/other-config'},{images:'/private/other-images'},{status:'partial'}])assert.throws(()=>checkRestored({...r,...patch},backup));
});
test('actual full backup main refuses existing/uncertain restore contents before config, child or mutation',async()=>{
 const require=createRequire(import.meta.url),{transformSync}=require('esbuild'),source=fs.readFileSync(new URL('./backup-operator.mjs',import.meta.url),'utf8');
 const code=transformSync(source,{loader:'js',platform:'node',format:'cjs'}).code;
 for(const entries of[['666deea4081b66c3'],['.decode-unknown']]){
  const bytes=Buffer.from(JSON.stringify(backup)),profileSha=createHash('sha256').update(bytes).digest('hex');let configReads=0,mutations=0,children=0;
  const stat={dev:1n,ino:1n,uid:501n,mode:0o100600n,nlink:1n,size:BigInt(bytes.length),mtimeNs:1n,ctimeNs:1n,isFile:()=>true,isSymbolicLink:()=>false};
  const fakefs={constants:fs.constants,realpathSync:x=>x,lstatSync:(p,opts)=>{if(p==='/fixtures/profile.json')return stat;if(p==='/private/restores')return{uid:501,mode:0o40700,isDirectory:()=>true,isSymbolicLink:()=>false};throw Error('Unexpected stat');},openSync:()=>1,fstatSync:()=>stat,closeSync:()=>{},readFileSync:p=>{if(p===1)return Buffer.from(bytes);configReads++;throw Error('CONFIG_READ_FORBIDDEN');},readdirSync:p=>{assert.equal(p,'/private/restores');return entries;},writeFileSync:()=>{mutations++;throw Error('MUTATION_FORBIDDEN');}};
  const realmAssert=Object.assign((...args)=>assert(...args),assert,{deepEqual:(a,b,...rest)=>assert.deepEqual(JSON.parse(JSON.stringify(a)),JSON.parse(JSON.stringify(b)),...rest)});
  const module={exports:{}};vm.runInNewContext(code,{module,exports:module.exports,URL,Buffer,structuredClone,process:{argv:[],getuid:()=>501},require:name=>name==='node:assert/strict'?realmAssert:name==='node:fs'?fakefs:name==='node:child_process'?{spawn:()=>{children++;throw Error('CHILD_FORBIDDEN');}}:require(name)});
  await assert.rejects(module.exports.main(['restore-one','/fixtures/profile.json',profileSha,'/private/backups/archive.dyna','d'.repeat(64)]),e=>typeof e?.message==='string'&&e.message.includes('existing-restore-or-uncertain-content-no-second-copy'));assert.equal(configReads,0);assert.equal(mutations,0);assert.equal(children,0);
 }
});

test('stock opt-in is independent of read selection and ordinary health verifies the real processor',async()=>{
 const flags=[...runtime.flags,'--local-woo-stock'];assert.throws(()=>validateProfile({...runtime,flags}),/stock-require-selection/);
 const p={...runtime,flags,localWooSelection:{file:'/private/stores.json',digest:'e'.repeat(64)}};assert(commandFor(p).args.includes('--local-woo-stock'));assert(!commandFor(p).args.includes('--local-woo-reads'));
 const source=fs.readFileSync(new URL('./operator.mjs',import.meta.url),'utf8'),start=source.indexOf('async function health(p){'),body=source.slice(start,source.indexOf('\n',start));let reply={status:'ok',revision:p.revision};
 const health=new Function('assert','fetch','AbortSignal',body+';return health;')(assert,async()=>({status:200,json:async()=>reply}),AbortSignal);
 await assert.rejects(health(p),/stock-not-enabled/);reply={...reply,local_woo_stock_enabled:true,local_woo_stock_processor_running:false};await assert.rejects(health(p),/stock-processor-not-running/);
 reply.local_woo_stock_processor_running=true;await assert.rejects(health(p),/stock-health-invalid/);reply.local_woo_stock_blocked_channels=0;assert.equal((await health(p)).local_woo_stock_enabled,true);
});
