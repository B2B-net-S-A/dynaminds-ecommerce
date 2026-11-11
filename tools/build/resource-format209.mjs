/** Exact Source22b physical representation only. Not Native, Startup, or migration authority.
 * Gzip bytes measured with Node24.17.0/zlib1.3.1-e00f703. The earlier Python
 * inventory gzip c8f75... is a different representation and is not accepted. */
import assert from 'node:assert/strict';
import {RELEASE_MIGRATIONS} from './migration-manifest.mjs';
export const RESOURCE209_DEFINITION=Object.freeze({id:'sql:server/209_order_merge_delivery_inheritance.sql',source:'server/209_order_merge_delivery_inheritance.sql',path:'resources/server/209_order_merge_delivery_inheritance.sql',consumer:'server/db.ts'});
export const RESOURCE209_SQL=Object.freeze({bytes:28449419,sha256:'0e03d091e3ccb1b9f42c0890215f70e78055403a5451ff040428b96f152c024a',path:RESOURCE209_DEFINITION.path+'.gz',stored_bytes:3855468,stored_sha256:'0dd7ab6630f760d1b62847918ff84e1cde92209da2a90d74da35d09f50c73c28'});
export const RESOURCE209_ALIASES=Object.freeze([
 Object.freeze({id:'sql:server/178_large_import_wave_print_compatibility.sql',path:'resources/server/178_large_import_wave_print_compatibility.sql',native_path:'native/178_large_import_wave_print_compatibility.sql',native_id:'ordinary178_compatibility',bytes:3991821,sha256:'078ef0fd47ff756ffbac18c0f965698fc912c8fd739aba11a945d9c72e4f0faa'}),
 Object.freeze({id:'sql:server/201_complete_history_empty_bootstrap.sql',path:'resources/server/201_complete_history_empty_bootstrap.sql',native_path:'native/201_complete_history_empty_bootstrap.sql',native_id:'ordinary187_complete_history_and_empty_bootstrap',bytes:1624973,sha256:'fa3e6ad5fa8d7c534aa2fcd181accf94a25b0f191c293dafeefbd2fc97b7547f'}),
 Object.freeze({id:'sql:server/202_owned_business_quota_expiry_renewal.sql',path:'resources/server/202_owned_business_quota_expiry_renewal.sql',native_path:'native/202_owned_business_quota_expiry_renewal.sql',native_id:'ordinary202_quota_renewal',bytes:1646496,sha256:'ee3f8a51957b00e8e9c0da721480e4aabe9189a058dd04c07bbed86e90e26ad0'}),
]);
/** Optional187 reuses its existing Native bytes. Older v2 manifests may retain
 * the original physical resource; this is never a new required legacy alias. */
export const RESOURCE187_ALIAS=Object.freeze({id:'sql:server/187_durable_original_writer_epoch.sql',path:'resources/server/187_durable_original_writer_epoch.sql',native_path:'native/187_durable_original_writer_epoch.sql',native_id:'ordinary187_durable_original_writer_epoch',bytes:1590107,sha256:'4e5b45aadf79c3c0b0613715b0e17ece2a5e61dbe2df44936ef83d81ad37bb63'});
export function hasResource187AliasEdge(nativeContract){
 assert(nativeContract&&Array.isArray(nativeContract.sql_graph));const a=RESOURCE187_ALIAS,edges=nativeContract.sql_graph.filter(e=>e.id===a.native_id||e.path===a.native_path);
 return edges.length===1&&edges[0].id===a.native_id&&edges[0].path===a.native_path&&edges[0].sha256===a.sha256&&Object.keys(edges[0]).sort().join('|')==='id|path|sha256';
}
/** Release resources 211.. are derived from the one release migration list: an exact identity Native alias
 * each, selected only by its literal Native edge and requiring the previous row's edge. Order is ledger order. */
export const RELEASE_RESOURCES=Object.freeze(RELEASE_MIGRATIONS.map(m=>{
 const definition=Object.freeze({id:'sql:server/'+m.file,source:'server/'+m.file,path:'resources/server/'+m.file,consumer:'server/db.ts'});
 return Object.freeze({number:m.number,name:m.name,file:m.file,definition,alias:Object.freeze({id:definition.id,path:definition.path,native_path:'native/'+m.file,native_id:m.native_id,bytes:m.bytes,sha256:m.sha256})});
}));
const releaseIndex=number=>{const i=RELEASE_RESOURCES.findIndex(r=>r.number===number);assert(i>=0,'release-resource-unknown-number');return i;};
export function releaseResource(number){return RELEASE_RESOURCES[releaseIndex(number)];}
export function hasReleaseResourceEdge(number,nativeContract){
 assert(nativeContract&&Array.isArray(nativeContract.sql_graph));const i=releaseIndex(number),a=RELEASE_RESOURCES[i].alias,edges=nativeContract.sql_graph.filter(e=>e.id===a.native_id||e.path===a.native_path);
 if(!edges.length)return false;assert.deepEqual(edges,[{id:a.native_id,path:a.native_path,sha256:a.sha256}],'resource'+number+'-literal-source-native-edge');
 if(i>0){const previous=RELEASE_RESOURCES[i-1].number;assert(hasReleaseResourceEdge(previous,nativeContract),'resource'+number+'-requires'+previous);}
 return true;
}
/** {include211:boolean,...} for every release row, as definitions209 accepts it. */
export function releaseResourceSelection(nativeContract){return Object.fromEntries(RELEASE_RESOURCES.map(r=>['include'+r.number,hasReleaseResourceEdge(r.number,nativeContract)]));}
/** Legacy names kept for the 210/211 format readers. */
export const RESOURCE211_DEFINITION=releaseResource(211).definition,RESOURCE211_ALIAS=releaseResource(211).alias;
export function hasResource211Edge(nativeContract){return hasReleaseResourceEdge(211,nativeContract);}
export const EMITTED209_SCHEMA='dynaminds-emitted-local-release/v2';
export const RESOURCES209_SCHEMA='dynaminds-fixed-runtime-resources/v2';
export function definitions209(base,options={include211:false}){
 const names=RELEASE_RESOURCES.map(r=>'include'+r.number);
 assert(names.map((_,i)=>names.slice(0,i+1).join('|')).includes(Object.keys(options).sort().join('|')));assert.equal(typeof options[names[0]],'boolean');
 const selected=names.map(n=>Object.hasOwn(options,n)?options[n]:false);for(const s of selected)assert.equal(typeof s,'boolean');
 selected.forEach((s,i)=>{if(i>0)assert(!s||selected[i-1],'resource'+RELEASE_RESOURCES[i].number+'-requires'+RELEASE_RESOURCES[i-1].number);});
 assert(Array.isArray(base)&&!base.some(d=>[RESOURCE209_DEFINITION.id,...RELEASE_RESOURCES.map(r=>r.definition.id)].includes(d.id)));
 return Object.freeze([...base,RESOURCE209_DEFINITION,...RELEASE_RESOURCES.filter((_,i)=>selected[i]).map(r=>r.definition)]);
}
/** Four legacy rows plus the explicitly selected release rows have fixed physical storage. */
export function storage209(row){
 const a=[...RESOURCE209_ALIASES,RESOURCE187_ALIAS,...RELEASE_RESOURCES.map(r=>r.alias)].find(a=>a.id===row?.id),sql=row?.id===RESOURCE209_DEFINITION.id;
 assert(a||sql,'resource209-no-generic-storage-mapping');
 assert.deepEqual(Object.keys(row).sort(),['id','path','bytes','sha256','role','storage'].sort());
 assert.equal(row.role,'runtime-resource');assert.equal(row.path,sql?RESOURCE209_DEFINITION.path:a.path);
 assert.equal(row.bytes,sql?RESOURCE209_SQL.bytes:a.bytes);assert.equal(row.sha256,sql?RESOURCE209_SQL.sha256:a.sha256);
 const expected=sql?{path:RESOURCE209_SQL.path,bytes:RESOURCE209_SQL.stored_bytes,sha256:RESOURCE209_SQL.stored_sha256,encoding:'gzip209'}:{path:a.native_path,bytes:a.bytes,sha256:a.sha256,encoding:'identity'};
 assert.deepEqual(row.storage,expected,'resource209-fixed-physical-storage');
 return Object.freeze({...expected,role:sql?'runtime-resource-gzip209':'native-sql'});
}
export function assertStorage209Partition(contract,nativeContract){
 assert.equal(contract.schema,RESOURCES209_SCHEMA);
 const included=[];
 for(const r of RELEASE_RESOURCES){const n=r.number,d=r.definition,include=hasReleaseResourceEdge(n,nativeContract);if(include)included.push(r.alias);
  if(include||Object.hasOwn(contract,'definitions'))assert.deepEqual(contract.definitions.filter(x=>x.id===d.id),include?[d]:[],'resource'+n+'-definition-native-edge-parity');assert.equal(contract.members.filter(x=>x.id===d.id).length,include?1:0,'resource'+n+'-member-native-edge-parity');assert(!contract.missing.includes(d.id),'resource'+n+'-never-missing');}
 const include187=contract.members.some(r=>r.id===RESOURCE187_ALIAS.id&&Object.hasOwn(r,'storage'));
 const aliases=[...RESOURCE209_ALIASES,...(include187 ? [RESOURCE187_ALIAS] : []),...included],ids=[RESOURCE209_DEFINITION.id,...aliases.map(a=>a.id)];
 for(const id of ids){const rows=contract.members.filter(r=>r.id===id);assert.equal(rows.length,1,'resource209-complete-fixed-member-partition');assert(!contract.missing.includes(id));storage209(rows[0]);}
 assert.deepEqual(contract.members.filter(r=>Object.hasOwn(r,'storage')).map(r=>r.id).sort(),ids.slice().sort());
 for(const a of aliases){const edges=nativeContract.sql_graph.filter(e=>e.id===a.native_id||e.path===a.native_path);assert.deepEqual(edges,[{id:a.native_id,path:a.native_path,sha256:a.sha256}],'resource209-literal-source-native-edge');}
}
