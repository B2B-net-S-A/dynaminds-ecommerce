/** Explicit restored-copy preview. Import is inert; no migration or ordinary factory. */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
const sha=b=>createHash('sha256').update(b).digest('hex');
const keys=(v,k)=>assert(v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join()===k.sort().join());
const absolute=p=>assert(typeof p==='string'&&path.isAbsolute(p)&&path.resolve(p)===p);
const flags={restore_preview:true,background_workers_enabled:false,scoped_automation_enabled:false,local_woo_reads_enabled:false,local_woo_stock_enabled:false,local_woo_order_import_available:false,provider_registry_enabled:false};
function read(r,privateFile=false,max=2097152){
 keys(r,['path','sha256']);absolute(r.path);assert(/^[a-f0-9]{64}$/.test(r.sha256));assert.equal(fs.realpathSync(r.path),r.path);
 const s=fs.lstatSync(r.path,{bigint:true});assert(s.isFile()&&!s.isSymbolicLink()&&s.uid===BigInt(process.getuid())&&s.nlink===1n&&s.size<=BigInt(max));assert(privateFile?(s.mode&511n)===384n:(s.mode&18n)===0n);
 const cut=x=>[x.dev,x.ino,x.mode,x.uid,x.nlink,x.size,x.mtimeNs,x.ctimeNs].join();const fd=fs.openSync(r.path,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
 try{assert.equal(cut(fs.fstatSync(fd,{bigint:true})),cut(s));const b=fs.readFileSync(fd);assert.equal(sha(b),r.sha256);assert.equal(cut(fs.fstatSync(fd,{bigint:true})),cut(s));assert.equal(cut(fs.lstatSync(r.path,{bigint:true})),cut(s));return b;}finally{fs.closeSync(fd);}
}
const prepared=new WeakSet();
export function loadPreview(profilePath,profileSha){
 const p=JSON.parse(read({path:profilePath,sha256:profileSha},true,16384));keys(p,['schema','selection','restore','config','port','modules','flags']);assert.equal(p.schema,'dynaminds-restored-preview/v1');assert.equal(p.port,4106);assert.deepEqual(p.flags,flags);keys(p.modules,['app','db','resources']);
 const s=JSON.parse(read(p.selection,true,16384)),r=JSON.parse(read(p.restore,true,65536));keys(s,['releaseDirectory','manifestSha','expectedOwner','databaseUrl','localConfigurationPath','revision']);
 assert.equal(r.status,'verified');assert(r.preview_only===true&&r.worker_enabled===false&&r.row_fingerprints_match===true&&r.schema_fingerprint_match===true);assert(/^dynaminds_restore_[a-f0-9]{16}$/.test(r.database));absolute(r.directory);assert.equal(fs.realpathSync(r.directory),r.directory);
 const u=new URL(s.databaseUrl);assert(['postgres:','postgresql:'].includes(u.protocol));assert.equal(u.hostname,'127.0.0.1');assert.equal(u.port,'57084');assert.equal(u.username,'postgres');assert.equal(u.pathname,'/'+r.database);assert.equal(u.search,'');assert.equal(u.hash,'');assert.equal(s.expectedOwner,'postgres');assert.equal(s.revision,r.revision);assert.equal(s.manifestSha,r.revision);
 assert.equal(p.restore.path,path.join(r.directory,'result.json'));assert.equal(r.config,path.join(r.directory,'local-config.json'));assert.equal(s.localConfigurationPath,r.config);assert.equal(p.config.path,r.config);assert.equal(r.images,path.join(r.directory,'images'));assert.equal(fs.realpathSync(r.images),r.images);assert(fs.lstatSync(r.images).isDirectory());
 const cfg=JSON.parse(read(p.config,true,16384));assert.equal(decodeURIComponent(u.password),cfg.dbPassword);assert(/^[a-f0-9]{64}$/.test(cfg.encryptionKey));
 absolute(s.releaseDirectory);const manifest=JSON.parse(read({path:path.join(s.releaseDirectory,'release.json'),sha256:s.manifestSha}));
 const modules={};for(const [k,name]of Object.entries(p.modules)){assert(/^runtime\/chunks\/[a-zA-Z0-9_-]+\.mjs$/.test(name));const matches=manifest.files.filter(f=>f.path===name);assert.equal(matches.length,1);const f=matches[0];assert.equal(f.role,'emitted-runtime');read({path:path.join(s.releaseDirectory,name),sha256:f.sha256},false,16777216);modules[k]=pathToFileURL(path.join(s.releaseDirectory,name)).href;}
 const x=Object.freeze({selection:Object.freeze(s),restore:Object.freeze(r),port:p.port,modules:Object.freeze(modules)});prepared.add(x);return x;
}
export function previewOptions(x){assert(prepared.has(x));return{readOnly:true,previewPort:x.port,logging:false,backgroundWorkersEnabled:false,scopedAutomationEnabled:false,trustedLocalUiOrigin:'http://127.0.0.1:'+x.port,staticRoot:path.join(x.selection.releaseDirectory,'dist'),integrationTransport:async()=>{throw new Error('RESTORED_PREVIEW_PROVIDER_DISABLED');}};}
export async function startPreview(x,load=u=>import(u)){
 assert(prepared.has(x));Object.assign(process.env,{DATABASE_URL:x.selection.databaseUrl,DYNA_LOCAL_CONFIG_PATH:x.restore.config,DYNA_IMAGE_DIR:x.restore.images,APP_REVISION:x.selection.revision});
 let app,pool,closing;const close=()=>closing??=(async()=>{try{await app?.close();}finally{await pool?.end();}})();
 try{const resources=await load(x.modules.resources);await resources.installRuntimeResources({releaseDirectory:x.selection.releaseDirectory,manifestSha:x.selection.manifestSha});pool=(await load(x.modules.db)).pool;app=await(await load(x.modules.app)).buildApp(previewOptions(x));await app.listen({host:'127.0.0.1',port:x.port});return{close};}catch(e){await close().catch(()=>{});throw e;}
}
export async function main(args){assert.equal(args.length,2);const runtime=await startPreview(loadPreview(...args));const stop=()=>void runtime.close().then(()=>{process.exitCode=0;},()=>{process.exitCode=1;});process.once('SIGTERM',stop);process.once('SIGINT',stop);process.stdout.write('RESTORED_PREVIEW_LISTENING\n');}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))void main(process.argv.slice(2)).catch(()=>{process.stderr.write('RESTORED_PREVIEW_FAILED\n');process.exitCode=1;});
