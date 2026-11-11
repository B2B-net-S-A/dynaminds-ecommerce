/** ROOT ONLY: verify explicitly selected real Chrome files, never enumerate
 * Downloads, call a browser/API/DB, log in or alter any original evidence.
 * Mandatory QA166_API_REPORT_PATH/SHA256, QA166_DOWNLOAD_MANIFEST_PATH/SHA256,
 * QA166_CONFIRM=VERIFY_CHROME_FILES_166. One exclusive invocation per scope.
 * Manifest: {stage:166,scope,api_report_sha256,downloads:[{actor,origin,kind,
 * document_id,format,requested_values,values_included,filename,after:<UTC Z>}]}.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT='<workspace>/app';
const DOWNLOADS='<home>/Downloads';
const HASH=/^[a-f0-9]{64}$/,REV=/^[a-f0-9]{40}$/,UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const scopes=['primary','copy164','copy166'] as const;
type Scope=typeof scopes[number];
type Entry={actor:'qa166'|'off'|'on';origin:'warehouse'|'stocktake_adjustment';kind:'PZ'|'MM'|'WZ'|'count'|'PW'|'RW';document_id:string;format:'csv'|'xml';requested_values:boolean;values_included:boolean;filename:string;after:string};
type ApiExport=Omit<Entry,'after'> & {rows:number;bytes:number;sha256:string;artifact:string};
type RecordJson=Record<string,any>;
const json=(v:unknown)=>JSON.stringify(v,null,2)+'\n';
const sha=(b:Buffer|string)=>createHash('sha256').update(b).digest('hex');
function utc(v:unknown):number {assert.equal(typeof v,'string');assert.match(v as string,/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/);const n=Date.parse(v as string);assert(Number.isFinite(n));return n;}
function exactKeys(v:RecordJson,names:string[]){assert(v&&typeof v==='object'&&!Array.isArray(v));assert.deepEqual(Object.keys(v).sort(),[...names].sort());}
function tuple(e:Omit<Entry,'filename'|'after'>){return [e.actor,e.origin,e.kind,e.document_id,e.format,e.requested_values,e.values_included].join(':');}
function checkEntry(e:RecordJson){
  assert(['qa166','off','on'].includes(e.actor));assert(['warehouse','stocktake_adjustment'].includes(e.origin));assert(['PZ','MM','WZ','count','PW','RW'].includes(e.kind));assert.match(e.document_id,UUID);assert(['csv','xml'].includes(e.format));assert.equal(typeof e.requested_values,'boolean');assert.equal(typeof e.values_included,'boolean');
  assert.equal(e.origin==='warehouse',['PZ','MM','WZ','count'].includes(e.kind));
  assert(!e.values_included||e.requested_values);if(e.origin==='warehouse'||e.actor==='off')assert.equal(e.values_included,false);
  assert.equal(typeof e.filename,'string');assert.equal(basename(e.filename),e.filename);assert.match(e.filename,/^[A-Za-z0-9_. ()-]{1,220}$/);
}
function stable(a:Stats,b:Stats){for(const k of['dev','ino','uid','gid','mode','size','mtimeMs','ctimeMs'] as const)assert.equal(a[k],b[k]);}
async function dir(path:string){const s=await lstat(path);assert(s.isDirectory()&&!s.isSymbolicLink());assert.equal(await realpath(path),path);}
async function bytes(path:string,{privateFile=false,max=512*1024*1024}:{privateFile?:boolean;max?:number}={}){
  assert.equal(resolve(path),path);await dir(dirname(path));const s=await lstat(path);assert(s.isFile()&&!s.isSymbolicLink());assert.equal(await realpath(path),path);assert(s.size>0&&s.size<=max);if(privateFile)assert.equal(s.mode&0o777,0o600);if(process.getuid)assert.equal(s.uid,process.getuid());
  const f=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{stable(s,await f.stat());const b=await f.readFile();stable(s,await f.stat());stable(s,await lstat(path));assert.equal(b.length,s.size);return {b,stat:s};}finally{await f.close();}
}
async function absent(path:string){try{await lstat(path);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return;throw e;}throw Error('Exclusive output already exists');}
async function wx(path:string,b:Buffer|string,mode:number){await dir(dirname(path));const f=await open(path,'wx',mode);try{await f.writeFile(b);await f.sync();}finally{await f.close();}const fd=await open(dirname(path),'r');try{await fd.sync();}finally{await fd.close();}return sha(b);}
async function main(){
  let step='preflight';
  try{
    assert.equal(process.cwd(),ROOT);assert.equal(await realpath(ROOT),ROOT);assert.equal(process.env.QA166_CONFIRM,'VERIFY_CHROME_FILES_166');
    const apiPath=process.env.QA166_API_REPORT_PATH??'',apiSha=process.env.QA166_API_REPORT_SHA256??'',manifestPath=process.env.QA166_DOWNLOAD_MANIFEST_PATH??'',manifestSha=process.env.QA166_DOWNLOAD_MANIFEST_SHA256??'';
    assert.match(apiSha,HASH);assert.match(manifestSha,HASH);assert.equal(dirname(apiPath),resolve(ROOT,'docs'));assert.match(basename(apiPath),/^warehouse-document-register-native166-(primary|copy164|copy166)-after(?:-attempt[2-9])?\.json$/);
    assert.equal(dirname(manifestPath),resolve(ROOT,'data'));assert.match(basename(manifestPath),/^warehouse-document-register-native166-download-manifest-(primary|copy164|copy166)\.json$/);
    const apiInput=await bytes(apiPath,{max:16*1024*1024});assert.equal(sha(apiInput.b),apiSha);const api=JSON.parse(apiInput.b.toString()) as RecordJson;
    const manifestInput=await bytes(manifestPath,{privateFile:true,max:1024*1024});assert.equal(sha(manifestInput.b),manifestSha);const manifest=JSON.parse(manifestInput.b.toString()) as RecordJson;
    exactKeys(manifest,['stage','scope','api_report_sha256','downloads']);assert.equal(manifest.stage,166);assert.equal(manifest.api_report_sha256,apiSha);assert(scopes.includes(manifest.scope));const scope=manifest.scope as Scope;
    assert.match(basename(apiPath),new RegExp(`^warehouse-document-register-native166-${scope}-after(?:-attempt[2-9])?\\.json$`));assert.equal(basename(manifestPath),`warehouse-document-register-native166-download-manifest-${scope}.json`);
    assert.equal(api.stage,166);assert.equal(api.phase,'after');assert.equal(api.scope,scope);assert.equal(api.status,'REGISTER166_AFTER_READ_ONLY_PASS');assert.equal(api.schema,'149_stocktake_adjustments');assert.match(api.runtime_revision,REV);assert.equal(api.tables,464);assert.equal(api.all_baseline_rows_exact,true);assert.equal(api.portable_metadata_exact,true);assert.equal(api.receipt_graph_exact,true);assert.equal(api.business_mutations,0);assert.equal(api.login_calls,0);assert.equal(api.worker_calls,0);assert.equal(api.chrome_verified_here,false);
    assert.equal(dirname(api.before_path),resolve(ROOT,'data'));assert.match(basename(api.before_path),new RegExp(`^warehouse-document-register-native166-${scope}-before\\.json$`));assert.match(api.before_sha256,HASH);const beforeInput=await bytes(api.before_path,{privateFile:true});assert.equal(sha(beforeInput.b),api.before_sha256);const before=JSON.parse(beforeInput.b.toString()) as RecordJson;
    assert.equal(before.stage,166);assert.equal(before.scope,scope);assert.equal(before.phase,'before');assert.equal(before.status,'REGISTER166_BEFORE_EXACT_PASS');assert.equal(before.schema,api.schema);assert.equal(before.created_at,api.before_created_at);const beforeAt=utc(api.before_created_at);assert(utc(api.created_at)>=beforeAt);
    assert(Array.isArray(api.exports)&&api.exports.length>0&&api.exports.length<=500);const exports=new Map<string,ApiExport>();
    for(const e of api.exports){checkEntry(e);assert.equal(e.filename,`${e.kind}-${e.origin}-${e.document_id}.${e.format}`);assert(Number.isInteger(e.rows)&&e.rows>0&&e.rows<=10000);assert(Number.isInteger(e.bytes)&&e.bytes>0&&e.bytes<=5*1024*1024);assert.match(e.sha256,HASH);assert.equal(dirname(e.artifact),resolve(ROOT,'data'));assert.match(basename(e.artifact),new RegExp(`^warehouse-document-register-native166-${scope}-[A-Za-z0-9_.-]+\\.${e.format}$`));const t=tuple(e);assert(!exports.has(t));exports.set(t,e);}
    assert(Array.isArray(manifest.downloads)&&manifest.downloads.length>0&&manifest.downloads.length<=100);const selected=new Set<string>(),names=new Set<string>(),prepared:{entry:Entry;api:ApiExport;data:Buffer;stat:Stats;target:string}[]=[];
    const output=resolve(ROOT,`data/warehouse-document-register-native166-downloads-${scope}.json`),publicOutput=resolve(ROOT,`docs/warehouse-document-register-native166-downloads-${scope}.json`),intent=output+'.intent.json';
    await absent(output);await absent(publicOutput);await absent(intent);await dir(DOWNLOADS);
    step='read-selected-files';
    for(const e of manifest.downloads){
      exactKeys(e,['actor','origin','kind','document_id','format','requested_values','values_included','filename','after']);checkEntry(e);const t=tuple(e);assert(!selected.has(t)&&!names.has(e.filename));selected.add(t);names.add(e.filename);const a=exports.get(t);assert(a,'No independently proven exact API export');
      const after=utc(e.after);assert(after>=beforeAt&&after<=Date.now());const serverBase=a.filename.slice(0,-(e.format.length+1));const tail=e.filename.slice(serverBase.length);assert(e.filename.startsWith(serverBase)&&(tail===`.${e.format}`||new RegExp(`^ \\([1-9]\\d{0,3}\\)\\.${e.format}$`).test(tail)));
      const actual=await bytes(resolve(DOWNLOADS,e.filename),{max:5*1024*1024});assert(actual.stat.mtimeMs>after,'Download predates pinned click cutoff');assert(actual.stat.mtimeMs<=Date.now()+30000);assert.equal(actual.b.length,a.bytes);assert.equal(sha(actual.b),a.sha256);
      const independent=await bytes(a.artifact,{privateFile:true,max:5*1024*1024});assert.equal(independent.b.length,a.bytes);assert.equal(sha(independent.b),a.sha256);assert(actual.b.equals(independent.b));
      const target=resolve(ROOT,`data/warehouse-document-register-native166-chrome-${scope}-${e.actor}-${e.origin}-${e.document_id}-${e.requested_values?'values':'quantity'}.${e.format}`);await absent(target);prepared.push({entry:e,api:a,data:actual.b,stat:actual.stat,target});
    }
    // Read every selected file successfully before creating custody. No retries
    // or partial-resume option: any existing intent/output is a hard stop.
    step='exclusive-intent';await wx(intent,json({stage:166,scope,status:'SELECTED_FILES_VERIFIED_BEFORE_CUSTODY',api_report_sha256:apiSha,manifest_sha256:manifestSha,before_sha256:api.before_sha256,created_at:new Date().toISOString(),targets:prepared.map(p=>p.target)}),0o600);
    const matched:RecordJson[]=[];step='copy-actual-bytes';
    for(const p of prepared){
      const again=await bytes(resolve(DOWNLOADS,p.entry.filename),{max:5*1024*1024});stable(p.stat,again.stat);assert(again.b.equals(p.data));const independent=await bytes(p.api.artifact,{privateFile:true,max:5*1024*1024});assert.equal(sha(independent.b),p.api.sha256);assert(independent.b.equals(p.data));assert.equal(await wx(p.target,p.data,0o600),p.api.sha256);
      matched.push({scope,actor:p.entry.actor,origin:p.entry.origin,kind:p.entry.kind,document_id:p.entry.document_id,format:p.entry.format,requested_values:p.entry.requested_values,values_included:p.entry.values_included,filename:p.entry.filename,rows:p.api.rows,bytes:p.data.length,sha256:p.api.sha256,mtime:new Date(p.stat.mtimeMs).toISOString(),after:p.entry.after,exact_api_bytes:true,source:'REAL_CHROME_DOWNLOAD',artifact:p.target});
    }
    step='final-custody';const apiFinal=await bytes(apiPath,{max:16*1024*1024}),manifestFinal=await bytes(manifestPath,{privateFile:true,max:1024*1024}),beforeFinal=await bytes(api.before_path,{privateFile:true});stable(apiInput.stat,apiFinal.stat);assert.equal(sha(apiFinal.b),apiSha);stable(manifestInput.stat,manifestFinal.stat);assert.equal(sha(manifestFinal.b),manifestSha);stable(beforeInput.stat,beforeFinal.stat);assert.equal(sha(beforeFinal.b),api.before_sha256);
    for(const p of prepared){const original=await bytes(resolve(DOWNLOADS,p.entry.filename),{max:5*1024*1024});stable(p.stat,original.stat);assert(original.b.equals(p.data));const copied=await bytes(p.target,{privateFile:true,max:5*1024*1024});assert(copied.b.equals(p.data));const independent=await bytes(p.api.artifact,{privateFile:true,max:5*1024*1024});assert.equal(sha(independent.b),p.api.sha256);assert(independent.b.equals(p.data));}
    const common={stage:166,scope,status:'NATIVE_DOWNLOADS166_EXACT_API_PASS',schema:api.schema,runtime_revision:api.runtime_revision,api_report_sha256:apiSha,download_manifest_sha256:manifestSha,before_sha256:api.before_sha256,download_count:matched.length,mutations:0,api_calls:0,login_calls:0,worker_calls:0,download_bytes_verified:true,serialized_semantics_from_independent_api_report:true,provider_verified:false,full_goal_complete:false,automatic_resume:false,created_at:new Date().toISOString()};
    const privateSha=await wx(output,json({...common,downloads:matched}),0o600);await wx(publicOutput,json({...common,private_sha256:privateSha,downloads:matched.map(({artifact,...safe})=>safe)}),0o644);
    console.log(json({...common,private_sha256:privateSha,download_count:matched.length}));
  }catch(e){const line=e instanceof Error?e.stack?.match(/warehouse-document-register-native166-downloads\.ts:(\d+)/)?.[1]:undefined;console.error(json({stage:166,status:'FAILED_NO_RESUME',step,source_line:line?Number(line):null,private_details_withheld:true,automatic_resume:false}));process.exitCode=1;}
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)void main();
