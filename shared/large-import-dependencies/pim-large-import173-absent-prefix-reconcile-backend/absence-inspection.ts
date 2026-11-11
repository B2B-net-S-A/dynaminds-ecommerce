/** SAME-owner-client terminal cut only. No default database, writer, mkdir, unlink or synthetic settlement. */
import assert from 'node:assert/strict';
import {lstat,readdir,realpath} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
type Scope={tenantId:string;actorId:string;apiKeyId:string|null};
const uuid=(x:string)=>assert(/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(x),'absence-canonical-uuid');
const sha=(x:string)=>createHash('sha256').update(x).digest('hex');
const names=['resource_key','kind','byte_count','sha256','state','payload_text'] as const;
export function absentPaths(scope:Scope,requestId:string){for(const x of [scope.tenantId,scope.actorId,requestId])uuid(x);if(scope.apiKeyId!==null)uuid(scope.apiKeyId);const prefix=`${scope.tenantId}/${scope.actorId}/${scope.apiKeyId===null?'sessions':'key-'+scope.apiKeyId}`;return[scope.tenantId,`${scope.tenantId}/${scope.actorId}`,prefix,`${prefix}/uploads`,`${prefix}/uploads/${requestId}`];}
export function originalDirectories(scope:Scope,fact:any){
 assert(fact?.reused===false&&fact.reservation?.state==='unknown'&&fact.reservation.kind==='upload','absence-committed-unknown-fence');const b=fact.reservation;assert(b.tenant_id===scope.tenantId&&b.actor_id===scope.actorId&&b.api_key_id===scope.apiKeyId,'absence-original-owner');uuid(b.id);uuid(b.request_id);
 const paths=absentPaths(scope,b.request_id);assert.deepEqual(fact.expected_paths,paths,'absence-native-paths');assert(Array.isArray(fact.resources)&&fact.resources.length===5,'absence-exact-prefix');const seen=new Set<string>();
 const resources=fact.resources.map((x:any)=>{assert(x.tenant_id===scope.tenantId&&x.reservation_id===b.id&&x.kind==='blob'&&x.state==='intent'&&typeof x.payload_text==='string','absence-native-original-intent');const payload=JSON.parse(x.payload_text);assert.deepEqual(Object.keys(payload).sort(),['mode','path','schema']);assert(payload.schema==='private-directory-allocation/v1'&&payload.mode===448&&paths.includes(payload.path)&&!seen.has(payload.path),'absence-original-path');seen.add(payload.path);assert(x.resource_key===`blob:fs:directory:${sha(payload.path)}`&&Number(x.byte_count)===Buffer.byteLength(x.payload_text)&&x.sha256===sha(x.payload_text),'absence-original-count-hash-payload');return Object.fromEntries(names.map(k=>[k,k==='byte_count'?Number(x[k]):x[k]]));});assert(seen.size===5);resources.sort((a:any,b:any)=>a.resource_key<b.resource_key?-1:a.resource_key>b.resource_key?1:0);return{paths,resources};
}
/** Native begin has already retained reservation UPDATE and global/tenant policy locks through this cut. */
export async function inspectAbsentPrefix(root:string,scope0:Scope,fact0:any){
 const scope=structuredClone(scope0),fact=structuredClone(fact0);assert(root===resolve(root)&&await realpath(root)===root,'absence-canonical-root');const {paths,resources}=originalDirectories(scope,fact);
 const first=await lstat(root,{bigint:true});assert(first.isDirectory()&&!first.isSymbolicLink()&&(first.mode&0o777n)===0o700n,'absence-private-root');if(process.getuid)assert(first.uid===BigInt(process.getuid()),'absence-os-owner');
 const stamp=(x:typeof first)=>[x.dev,x.ino,x.uid,x.gid,x.mode,x.nlink,x.mtimeNs,x.ctimeNs].map(String).join(':');const rootNames=(await readdir(root)).sort();
 async function absence(){for(const path of paths){try{await lstat(join(root,path));}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')continue;throw e;}throw Error('absence-prefix-directory-present');}}
 await absence();assert.equal(await realpath(root),root,'absence-root-alias-changed');assert.equal(stamp(await lstat(root,{bigint:true})),stamp(first),'absence-root-changed');assert.deepEqual((await readdir(root)).sort(),rootNames,'absence-root-inventory-changed');await absence();
 return{schema:'private-upload-absent-close/v1',scope,reservation_id:fact.reservation.id,request_id:fact.reservation.request_id,resources,fs_cut:[{path:'.',state:'present',kind:'directory',mode:448,dev:String(first.dev),ino:String(first.ino),uid:String(first.uid),gid:String(first.gid),ctime_ns:String(first.ctimeNs),mtime_ns:String(first.mtimeNs),names:rootNames},...paths.map(path=>({path,state:'absent'}))],metadata_cut:{blobs:0,jobs:0,reviews:0}};
}
