import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {loadPreview,previewOptions,startPreview} from './restore-preview-operator.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
function fixture(t){
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'restored-preview-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const release=path.join(root,'release'),directory=path.join(root,'restore');fs.mkdirSync(release);fs.mkdirSync(directory);fs.mkdirSync(path.join(directory,'images'));fs.mkdirSync(path.join(release,'runtime/chunks'),{recursive:true});
 const write=(file,value)=>{const bytes=Buffer.from(typeof value==='string'?value:JSON.stringify(value));fs.writeFileSync(file,bytes,{mode:0o600});return{path:file,sha256:sha(bytes)};};
 const modules={app:'runtime/chunks/app-test.mjs',db:'runtime/chunks/db-test.mjs',resources:'runtime/chunks/resources-test.mjs'};
 const files=Object.values(modules).map(p=>{const r=write(path.join(release,p),'export {};');return{path:p,bytes:10,sha256:r.sha256,role:'emitted-runtime'};});
 const manifest=write(path.join(release,'release.json'),{files});
 const config=write(path.join(directory,'local-config.json'),{dbPassword:'controlled-test-only',encryptionKey:'a'.repeat(64)});
 const restored={status:'verified',preview_only:true,worker_enabled:false,row_fingerprints_match:true,schema_fingerprint_match:true,database:'dynaminds_restore_0123456789abcdef',directory,config:config.path,images:path.join(directory,'images'),revision:manifest.sha256};
 const selection={releaseDirectory:release,manifestSha:manifest.sha256,expectedOwner:'postgres',databaseUrl:'postgres://postgres:controlled-test-only@127.0.0.1:57084/'+restored.database,localConfigurationPath:config.path,revision:manifest.sha256};
 const profile={schema:'dynaminds-restored-preview/v1',selection:write(path.join(root,'selection.json'),selection),restore:write(path.join(directory,'result.json'),restored),config,port:4106,modules,flags:{restore_preview:true,background_workers_enabled:false,scoped_automation_enabled:false,local_woo_reads_enabled:false,local_woo_stock_enabled:false,local_woo_order_import_available:false,provider_registry_enabled:false}};
 const load=()=>{const p=write(path.join(root,'profile.json'),profile);return loadPreview(p.path,p.sha256);};
 return{root,write,selection,profile,restored,load};
}
test('exact restored copy has fixed readonly construction and provider denial',async t=>{
 const f=fixture(t),x=f.load(),o=previewOptions(x);assert(Object.isFrozen(x)&&Object.isFrozen(x.selection));
 assert.equal(o.readOnly,true);assert.equal(o.previewPort,4106);assert.equal(o.backgroundWorkersEnabled,false);assert.equal(o.scopedAutomationEnabled,false);
 for(const k of ['localWooRegistry','localWooReadLane','localWooStockLane','localWooOrderImport','stockWriterActivation'])assert.equal(o[k],undefined);
 await assert.rejects(o.integrationTransport(),/PROVIDER_DISABLED/);assert.throws(()=>previewOptions({...x}));
});
test('PG03, source DB, wrong restore paths or unverified restore refuse before imports',t=>{
 for(const change of [s=>s.databaseUrl=s.databaseUrl.replace('57084','57083'),s=>s.databaseUrl=s.databaseUrl.replace('dynaminds_restore_0123456789abcdef','source_main'),s=>s.localConfigurationPath='/wrong/config']){
  const f=fixture(t);change(f.selection);f.profile.selection=f.write(f.profile.selection.path,f.selection);assert.throws(f.load);
 }
 for(const change of [r=>r.worker_enabled=true,r=>r.preview_only=false,r=>r.row_fingerprints_match=false,r=>r.images=r.directory+'/elsewhere']){
  const f=fixture(t);change(f.restored);f.profile.restore=f.write(f.profile.restore.path,f.restored);assert.throws(f.load);
 }
});
test('both genuine PostgreSQL URI schemes retain exactly the same target binding',t=>{
 const f=fixture(t);f.selection.databaseUrl=f.selection.databaseUrl.replace('postgres:','postgresql:');f.profile.selection=f.write(f.profile.selection.path,f.selection);assert.equal(f.load().selection.databaseUrl,f.selection.databaseUrl);
 f.selection.databaseUrl=f.selection.databaseUrl.replace('postgresql:','https:');f.profile.selection=f.write(f.profile.selection.path,f.selection);assert.throws(f.load);
});
test('worker flags, app port, extra options, oversized private input and code drift refuse',t=>{
 for(const change of [p=>p.port=4105,p=>p.flags.local_woo_stock_enabled=true,p=>p.flags.provider_registry_enabled=true,p=>p.flags.restore_preview=false,p=>p.query_timeout=9000]){
  const f=fixture(t);change(f.profile);assert.throws(f.load);
 }
 let f=fixture(t);f.profile.selection=f.write(f.profile.selection.path,' '.repeat(16385));assert.throws(f.load);
 f=fixture(t);fs.appendFileSync(path.join(f.selection.releaseDirectory,f.profile.modules.app),'drift');assert.throws(f.load);
});
test('actual startup path only installs pinned resources, builds readonly, listens loopback and closes once',async t=>{
 const f=fixture(t),x=f.load(),calls=[];const env={...process.env};t.after(()=>{for(const k of Object.keys(process.env))if(!(k in env))delete process.env[k];Object.assign(process.env,env);});
 const runtime=await startPreview(x,async u=>{
  calls.push(u);if(u===x.modules.resources)return{installRuntimeResources:async c=>assert.equal(c.manifestSha,x.selection.manifestSha)};
  if(u===x.modules.db)return{pool:{end:async()=>calls.push('end')}};
  assert.equal(process.env.DATABASE_URL,x.selection.databaseUrl);assert.equal(process.env.DYNA_IMAGE_DIR,x.restore.images);
  return{buildApp:async o=>{assert.equal(o.readOnly,true);return{listen:async v=>assert.deepEqual(v,{host:'127.0.0.1',port:4106}),close:async()=>calls.push('close')}}};
 });
 await runtime.close();await runtime.close();assert.deepEqual(calls,[x.modules.resources,x.modules.db,x.modules.app,'close','end']);
});
test('failed build closes the actual acquired pool without migration, factory or retry',async t=>{
 const f=fixture(t),x=f.load();let ended=0,built=0;const env={...process.env};t.after(()=>{for(const k of Object.keys(process.env))if(!(k in env))delete process.env[k];Object.assign(process.env,env);});
 await assert.rejects(startPreview(x,async u=>u===x.modules.resources?{installRuntimeResources:async()=>{}}:u===x.modules.db?{pool:{end:async()=>ended++}}:{buildApp:async()=>{built++;throw Error('controlled-build');},migrate:()=>assert.fail('migration forbidden')}),/controlled-build/);
 assert.equal(ended,1);assert.equal(built,1);
});
