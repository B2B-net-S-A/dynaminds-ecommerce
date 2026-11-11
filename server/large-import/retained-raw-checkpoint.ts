/** Complete sealed source readback for current cookie/API-key checkpoint scope; no Native permission. */
import assert from 'node:assert/strict';
import {createHash}from'node:crypto';
import{lstat,readdir,realpath}from'node:fs/promises';
import{join,resolve}from'node:path';
import{readPrivate}from'../../shared/large-import-dependencies/pim-large-import173-fs-hooks-backend2/publisher';
import type{Client}from'../../shared/large-import-dependencies/pim-large-import173-runtime-fs-integration-backend2/storage';
import type{Scope}from'./quota-renewal-inspection';
export const sha=(v:string|Uint8Array)=>createHash('sha256').update(v).digest('hex');
const uuid=(v:string)=>assert(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v),'owned-uuid');
const keys=(v:unknown,k:string[])=>assert(v&&typeof v==='object'&&!Array.isArray(v)&&JSON.stringify(Object.keys(v).sort())===JSON.stringify([...k].sort()),'owned-closed-shape');
async function directory(path:string){const s=await lstat(path);assert(s.isDirectory()&&!s.isSymbolicLink()&&(s.mode&0o777)===0o700&&await realpath(path)===path&&(!process.getuid||s.uid===process.getuid()),'owned-private-dir');return {dev:s.dev,ino:s.ino};}
export async function inspectRetainedRawCheckpoint(c:Client,root:string,scope:Scope,blobId:string,catalogId:string,uploadKey:string,ready:import('../../shared/large-import-dependencies/pim-large-import173-runtime-fs-integration-backend2/upload').ReadyUpload){
 uuid(scope.tenantId);uuid(scope.actorId);if(scope.apiKeyId!==null)uuid(scope.apiKeyId);uuid(blobId);uuid(catalogId);uuid(uploadKey);assert(root===resolve(root)&&ready.blob_id===blobId&&ready.raw.id===`large-import-raw/v1:${blobId}`,'renewal-retained-raw-original');
 const args=[scope.tenantId,scope.actorId,scope.apiKeyId,blobId];
 const row=(await c.query('SELECT * FROM public.large_import_blobs173 WHERE tenant_id=$1 AND actor_id=$2 AND api_key_id IS NOT DISTINCT FROM $3::uuid AND id=$4 FOR SHARE',args)).rows[0];
 assert(row&&row.completed_eof===true&&row.parse_valid===true&&row.storage_id===`large-import-raw-file/v1:${scope.tenantId}:${blobId}`&&row.raw_sha256===ready.raw.sha256&&Number(row.raw_bytes)===ready.raw.byte_count&&row.manifest_text===JSON.stringify(ready.manifest)&&row.manifest_sha256===sha(row.manifest_text)&&row.spec_text===JSON.stringify(ready.spec),'renewal-native-retained-blob-whole');
 const parts=(await c.query('SELECT * FROM public.large_import_parts173 WHERE tenant_id=$1 AND blob_id=$2 ORDER BY offset_bytes FOR SHARE',[scope.tenantId,blobId])).rows;
 const prefix=join(root,scope.tenantId,scope.actorId,scope.apiKeyId===null?'sessions':'key-'+scope.apiKeyId),path=join(prefix,'blobs',blobId),partsPath=join(path,'parts'),parents=[root,join(root,scope.tenantId),join(root,scope.tenantId,scope.actorId),prefix,join(prefix,'blobs'),path,partsPath],before=await Promise.all(parents.map(directory)),names=(await readdir(path)).sort();
 assert.deepEqual(names,['claim.json','owner.json','parts','seal.json'],'renewal-retained-raw-no-quarantine-lock-or-unknown-files');
 const partNames=(await readdir(partsPath)).sort();assert(partNames.length>0&&partNames.length<=1024&&partNames.every(n=>/^\d{16}\.part$/.test(n)),'renewal-retained-parts-no-quarantine-lock-or-unknown-files');
 const ownerBytes=await readPrivate(join(path,'owner.json')),claimBytes=await readPrivate(join(path,'claim.json')),sealBytes=await readPrivate(join(path,'seal.json')),owner=JSON.parse(Buffer.from(ownerBytes).toString()),claim=JSON.parse(Buffer.from(claimBytes).toString()),seal=JSON.parse(Buffer.from(sealBytes).toString());
 keys(owner,['schema','scope','blob_id','catalog_id','max_bytes']);assert(owner.schema==='private-import-owner/v2'&&owner.blob_id===blobId&&owner.catalog_id===catalogId&&JSON.stringify(owner.scope)===JSON.stringify(scope)&&Number.isSafeInteger(owner.max_bytes)&&owner.max_bytes>0&&owner.max_bytes<=30000000&&Number(row.max_bytes)===owner.max_bytes,'renewal-retained-raw-owner');
 assert.deepEqual(claim,{schema:'private-upload-attachment/v1',blob_id:blobId,catalog_id:catalogId,upload_key:uploadKey});assert.deepEqual(seal,{schema:'private-import-seal/v2',blob_id:blobId,sha256:ready.raw.sha256,byte_count:ready.raw.byte_count});
 const digest=createHash('sha256');assert(parts.length===partNames.length&&parts.length>0);let count=0;const hashes:string[]=[];
 for(const [i,n]of partNames.entries()){assert(Number(n.slice(0,16))===count);const bytes=await readPrivate(join(partsPath,n)),h=sha(bytes),p=parts[i];assert(bytes.length>0&&bytes.length<=65536&&p.tenant_id===scope.tenantId&&p.blob_id===blobId&&Number(p.offset_bytes)===count&&Number(p.byte_count)===bytes.length&&p.sha256===h,'renewal-retained-native-part');digest.update(bytes);hashes.push(h);count+=bytes.length;}
 assert(count===ready.raw.byte_count&&count<=owner.max_bytes&&digest.digest('hex')===ready.raw.sha256,'renewal-complete-retained-raw-integrity');
 assert.deepEqual(await Promise.all(parents.map(directory)),before);assert.deepEqual((await readdir(path)).sort(),names);assert.deepEqual((await readdir(partsPath)).sort(),partNames);
 for(const [i,n]of partNames.entries())assert(sha(await readPrivate(join(partsPath,n)))===hashes[i],'renewal-retained-part-second-cut');
 for(const [n,b]of [['owner.json',ownerBytes],['claim.json',claimBytes],['seal.json',sealBytes]] as const)assert(Buffer.from(await readPrivate(join(path,n))).equals(Buffer.from(b)),'renewal-retained-control-second-cut');
 return {schema:'retained-raw-renewal-inspection/v1',blob_id:blobId,sha256:ready.raw.sha256,byte_count:count,parts:parts.length};
}
