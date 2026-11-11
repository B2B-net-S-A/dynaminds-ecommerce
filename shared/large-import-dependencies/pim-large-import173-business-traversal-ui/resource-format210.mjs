/** Closed Source210 candidate representation DATA only. No Native, migration,
 * Startup, or installed admission. Legacy v1/v2 readers remain unchanged.
 * Node24.17.0/zlib1.3.1-e00f703 gzip9 measured from authored unsealed 685c16 SQL.
 * Budgets count physical manifest members once; release.json is excluded. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {gzipSync,gunzipSync} from 'node:zlib';
import {RESOURCE209_DEFINITION,RESOURCE209_SQL,RESOURCE209_ALIASES,definitions209,storage209} from "./resource-format209.mjs";

export const EMITTED210_SCHEMA='dynaminds-emitted-local-release/v3';
export const RESOURCES210_SCHEMA='dynaminds-fixed-runtime-resources/v3';
export const RESOURCE210_LIMITS=Object.freeze({member_bytes:16*1024*1024,total_bytes:128*1024*1024,manifest_included:false});
export const RESOURCE210_ORIGIN=Object.freeze({status:'SOURCE_CANDIDATE_REPRESENTATION_ONLY',native_acceptance:false,application_activation:false,installed_admission:false});
export const RESOURCE210_DEFINITION=Object.freeze({id:'sql:server/210_order_split.sql',source:'server/210_order_split.sql',path:'resources/server/210_order_split.sql',consumer:'server/db.ts'});
export const RESOURCE210_SQL=Object.freeze({bytes:4525572,sha256:'685c16fbf6fdf35f1b95752e7672e6df484ec865d0fa2cf5a20da5801da3dc73',path:RESOURCE210_DEFINITION.path+'.gz',stored_bytes:531426,stored_sha256:'488c2e2836f4e2c2fad8c6ce3dec4cf7f55cd5a7eddef182a1dc9212836eb0f2'});
export const RESOURCE210_NATIVE_ALIASES=Object.freeze([
 Object.freeze({id:'sql:server/177_picking_wave_print.sql',path:'resources/server/177_picking_wave_print.sql',native_path:'native/177_picking_wave_print.sql',native_id:'wave177_predecessor',bytes:185831,sha256:'025d3bbf7d1cb0938366b5075b63ba348361755890f40282ff229932fb791e19'}),
 Object.freeze({id:'sql:server/182_cold_schema_runtime_admission.sql',path:'resources/server/182_cold_schema_runtime_admission.sql',native_path:'native/182_cold_schema_runtime_admission.sql',native_id:'ordinary182_cold_runtime_admission',bytes:1447850,sha256:'a95276dbdf02f00a50ca97c84a6aa242d493dbbfe50b085f60936e649a0bb7da'}),
]);
export const RESOURCE210_ALIASES=Object.freeze([...RESOURCE209_ALIASES,...RESOURCE210_NATIVE_ALIASES]);
const oldIds=new Set([RESOURCE209_DEFINITION.id,...RESOURCE209_ALIASES.map(a=>a.id)]);
const storageIds=Object.freeze([...oldIds,...RESOURCE210_NATIVE_ALIASES.map(a=>a.id),RESOURCE210_DEFINITION.id]);
const exact=(v,keys)=>{assert(v&&typeof v==='object'&&!Array.isArray(v));assert.deepEqual(Object.keys(v).sort(),[...keys].sort());};
const sha=b=>createHash('sha256').update(b).digest('hex');

/** Base definitions still contain177/182. Append exactly209 then210, no registry mutation. */
export function definitions210(base){
 assert(Array.isArray(base)&&base.every(d=>d&&typeof d.id==='string'));
 assert.equal(new Set(base.map(d=>d.id)).size,base.length,'resource210-base-unique');
 assert(!base.some(d=>d.id===RESOURCE210_DEFINITION.id),'resource210-definition-not-already-present');
 for(const a of RESOURCE210_NATIVE_ALIASES){const ds=base.filter(d=>d.id===a.id);assert.equal(ds.length,1,'resource210-base-native-definition');assert.deepEqual(ds[0],{id:a.id,source:a.id.slice(4),path:a.path,consumer:'server/db.ts'});}
 return Object.freeze([...definitions209(base),RESOURCE210_DEFINITION]);
}

/** Only these seven complete logical rows may name alternate physical storage. */
export function storage210(row){
 if(oldIds.has(row?.id))return storage209(row);
 const a=RESOURCE210_NATIVE_ALIASES.find(a=>a.id===row?.id),sql=row?.id===RESOURCE210_DEFINITION.id;
 assert(a||sql,'resource210-no-generic-storage-mapping');
 exact(row,['id','path','bytes','sha256','role','storage']);
 assert.equal(row.role,'runtime-resource');assert.equal(row.path,sql?RESOURCE210_DEFINITION.path:a.path);
 assert.equal(row.bytes,sql?RESOURCE210_SQL.bytes:a.bytes);assert.equal(row.sha256,sql?RESOURCE210_SQL.sha256:a.sha256);
 const expected=sql?{path:RESOURCE210_SQL.path,bytes:RESOURCE210_SQL.stored_bytes,sha256:RESOURCE210_SQL.stored_sha256,encoding:'gzip210'}:{path:a.native_path,bytes:a.bytes,sha256:a.sha256,encoding:'identity'};
 assert.deepEqual(row.storage,expected,'resource210-fixed-physical-storage');
 assert(expected.bytes<=RESOURCE210_LIMITS.member_bytes);
 return Object.freeze({...expected,role:sql?'runtime-resource-gzip210':'native-sql'});
}

export function assertStorage210Partition(contract,nativeContract){
 assert.equal(contract.schema,RESOURCES210_SCHEMA);
 assert(Array.isArray(contract.members)&&Array.isArray(contract.missing));
 for(const id of storageIds){const rows=contract.members.filter(r=>r.id===id);assert.equal(rows.length,1,'resource210-complete-seven-member-partition');assert(!contract.missing.includes(id),'resource210-required-member-not-missing');storage210(rows[0]);}
 assert.deepEqual(contract.members.filter(r=>Object.hasOwn(r,'storage')).map(r=>r.id).sort(),[...storageIds].sort(),'resource210-closed-seven-storage-rows');
 assert(Array.isArray(nativeContract.sql_graph));
 for(const a of RESOURCE210_ALIASES){const edges=nativeContract.sql_graph.filter(e=>e.id===a.native_id||e.path===a.native_path);assert.deepEqual(edges,[{id:a.native_id,path:a.native_path,sha256:a.sha256}],'resource210-literal-source-native-edge');}
}

/** Structural manifest check only. Existing bounded readers must verify actual
 * file bytes. No logical duplicate copies and no role substitution are allowed. */
export function assertStorage210PhysicalMembers(contract,nativeContract,files){
 assertStorage210Partition(contract,nativeContract);assert(Array.isArray(files)&&files.length>0&&files.length<=4096);
 const physical=new Map();let total=0;
 for(const f of files){
  exact(f,['path','bytes','sha256','role']);assert(typeof f.path==='string'&&f.path.length>0&&f.path.length<=500&&!/[\\\0:]/.test(f.path)&&f.path.split('/').every(p=>p&&p!=='.'&&p!=='..'),'resource210-canonical-relative-member');assert(f.path!=='release.json','resource210-manifest-excluded');
  assert(!physical.has(f.path),'resource210-physical-path-unique');assert(Number.isSafeInteger(f.bytes)&&f.bytes>=0&&f.bytes<=RESOURCE210_LIMITS.member_bytes,'resource210-member-16MiB');
  assert(/^[a-f0-9]{64}$/.test(f.sha256)&&typeof f.role==='string');total+=f.bytes;assert(total<=RESOURCE210_LIMITS.total_bytes,'resource210-total-128MiB');physical.set(f.path,f);
 }
 for(const id of storageIds){const row=contract.members.find(r=>r.id===id),stored=storage210(row);assert(!physical.has(row.path),'resource210-no-logical-copy');assert.deepEqual(physical.get(stored.path),{path:stored.path,bytes:stored.bytes,sha256:stored.sha256,role:stored.role},'resource210-physical-role-and-bytes');}
 return Object.freeze({file_count:files.length,bytes:total,manifest_included:false,native_acceptance:false});
}

function decoded210(bytes){assert(Buffer.isBuffer(bytes)&&bytes.length===RESOURCE210_SQL.bytes,'resource210-decoded-exact-length');assert.equal(sha(bytes),RESOURCE210_SQL.sha256,'resource210-decoded-source-sha');new TextDecoder('utf-8',{fatal:true}).decode(bytes);return bytes;}
export function encodeResource210(bytes){decoded210(bytes);const packed=gzipSync(bytes,{level:9});assert.equal(packed.length,RESOURCE210_SQL.stored_bytes,'resource210-fixed-gzip-length');assert.equal(sha(packed),RESOURCE210_SQL.stored_sha256,'resource210-fixed-gzip-sha');return packed;}
export function decodeResource210(packed){assert(Buffer.isBuffer(packed)&&packed.length===RESOURCE210_SQL.stored_bytes,'resource210-fixed-gzip-length');assert.equal(sha(packed),RESOURCE210_SQL.stored_sha256,'resource210-fixed-gzip-sha');return decoded210(gunzipSync(packed,{maxOutputLength:RESOURCE210_SQL.bytes}));}
