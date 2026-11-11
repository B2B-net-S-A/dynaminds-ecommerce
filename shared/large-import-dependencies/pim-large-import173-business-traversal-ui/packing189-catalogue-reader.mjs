/** Import-inert, metadata only; not a restore constructor/admission capability. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {Socket} from 'node:net';
import pg from 'pg';
import {SOURCE_SELECTION} from './packing189-source-selection.mjs';
import {SCOPE,CONTEXT_SQL,COUNT_SQL,LENGTH_SQL,PAYLOAD_SQL} from './packing189-catalogue-sql.mjs';
const capturedContexts=new WeakMap();
// Representation only: keys are created below from owned, normalized JSON and
// deeply frozen. Foreign objects, hashes and Object.freeze are never cache keys.
// This does not replace any fresh Client/context/catalogue or native/IAM check.
const normalizedSnapshots=new WeakMap();
function cacheSnapshot(value,readerRoot=false){
 // Normalization must not acquire the private reader-result identity/custody.
 const snapshot=readerRoot?Object.freeze({...value}):value;
 normalizedSnapshots.set(value,snapshot);normalizedSnapshots.set(snapshot,snapshot);return value;
}
export function inspectPackingCatalogueContext(value){assert(capturedContexts.has(value),'packing-code-owned-catalogue-required');return capturedContexts.get(value);}
const hash=x=>createHash('sha256').update(x).digest('hex');
export const SCHEMA_VERSION='packing189-full-catalogue-compartment/v1';
export const LIMITS=Object.freeze({records:100000,rows_per_catalogue:50000,encoded_bytes:134217728,record_bytes:8388608,json_nodes:1000000,json_depth:64});
export const SQL_SHA256=hash([CONTEXT_SQL,COUNT_SQL,LENGTH_SQL,PAYLOAD_SQL].join('\n')+JSON.stringify(SOURCE_SELECTION));
const KINDS=new Set(['schema','relation','column','constraint','index','policy','trigger','function','type','sequence','inheritance','rule','event_trigger','default_acl','role','role_membership','extension','operator','operator_class','operator_family','family_operator','family_procedure','access_method','language','extension_member']);
const FIELDS={"schema":["owner","acl_null","acl"],"relation":["owner","kind","persistence","access_method","row_security","force_row_security","replica_identity","partition","partition_bound","partition_key","options","tablespace","acl_null","acl","view"],"column":["position","type","not_null","generated","identity","storage","compression","statistics","options","foreign_options","collation","default","acl_null","acl"],"constraint":["kind","deferrable","deferred","validated","local","inheritance_count","no_inherit","definition"],"index":["table","unique","primary","exclusion","immediate","clustered","valid","ready","live","replica_identity","nulls_not_distinct","definition"],"policy":["command","permissive","roles","using","check"],"trigger":["internal","name","enabled","type","function","attributes","arguments","constraint","constraint_relation","deferrable","deferred","has_when","old_table","new_table","definition"],"function":["owner","language","kind","cost","rows","security_definer","leakproof","strict","returns_set","volatility","parallel","support","variadic","argument_names","argument_modes","arguments","result","defaults","source","binary","config","definition","acl_null","acl"],"type":["owner","kind","category","defined","not_null","base","element","default","collation","enum_labels","acl_null","acl","default_expression","length","by_value","preferred","delimiter","relation","subscript","array","input","output","receive","send","modifier_input","modifier_output","analyze","alignment","storage","modifier","dimensions"],"sequence":["type","start","increment","minimum","maximum","cache","cycle","owned_by"],"inheritance":["parent","detach_pending"],"rule":["enabled","instead","event_type","definition"],"event_trigger":["owner","event","enabled","function","tags"],"default_acl":["acl"],"role":["superuser","inherit","create_role","create_database","login","replication","bypass_rls","connection_limit","valid_until"],"role_membership":["admin","inherit","set"],"extension":["owner","schema","version","relocatable","config_tables","condition"],"operator":["owner","kind","merge","hash","left_type","right_type","result_type","procedure","commutator","negator","restriction","join"],"operator_class":["owner","method","family","input_type","default","key_type"],"operator_family":["owner","method"],"family_operator":["family","method","left_type","right_type","strategy","purpose","operator","operator_method","sort_family"],"family_procedure":["family","method","left_type","right_type","number","procedure"],"access_method":["type","handler"],"language":["owner","procedural","trusted","handler","inline","validator","acl_null","acl"],"extension_member":["extension","dependency","type","schema","name","identity"]};
const COUNTS=['relations','indexes','sequences','inheritance','columns','constraints','policies','triggers','unsupported_internal_trigger_when','functions','types','event_triggers','default_acl','roles','role_memberships','extensions','rules','unsupported_relations','unsupported_routines','operators','operator_classes','operator_families','operator_family_operators','operator_family_procedures','access_methods','languages','extension_members','unsupported_ranges','unsupported_operator_shells','unsupported_statistics','unsupported_publications','unsupported_subscriptions','unsupported_collations','unsupported_foreign_servers','unsupported_languages'];
const exact=(v,keys)=>{assert(v&&typeof v==='object'&&!Array.isArray(v));assert.deepEqual(Object.keys(v).sort(),[...keys].sort());};
function canonical(v,depth=0,state={nodes:0}){assert(++state.nodes<=LIMITS.json_nodes&&depth<=LIMITS.json_depth,'recovery-json-bounds');if(depth>state.deepest)state.deepest=depth;if(v===null||typeof v==='string'||typeof v==='boolean')return v;if(typeof v==='number'){assert(Number.isFinite(v),'recovery-json-number');return v;}if(Array.isArray(v)){const length=v.length;assert(Number.isInteger(length)&&length<=LIMITS.json_nodes,'recovery-json-array-bound');const out=[];for(let i=0;i<length;i++){assert(Object.hasOwn(v,i),'recovery-dense-json-array');out.push(canonical(v[i],depth+1,state));}return out;}assert(v&&typeof v==='object'&&(Object.getPrototypeOf(v)===Object.prototype||Object.getPrototypeOf(v)===null),'recovery-plain-json-only');const out=Object.create(null);for(const k of Object.keys(v).sort())out[k]=canonical(v[k],depth+1,state);return out;}
const canonicalText=v=>JSON.stringify(canonical(v));
const freeze=v=>{if(v&&typeof v==='object'&&!deepFrozen.has(v)){for(const x of Object.values(v))freeze(x);Object.freeze(v);}return v;};
// Cold start reuse: a record this reader normalized (its own canonical copy, every field check passed) and then
// deeply froze cannot change. Its canonical text and its JSON budget (nodes, depth) are kept, so a later
// catalogue sharing it (every release cold projector rebuilds the full body around the same records) neither
// re-copies nor re-serializes it. Order, duplicate, field, membership, budget and digest checks still run for
// every catalogue; the digest is the sha256 of the same canonical bytes as canonicalText of the whole value.
// Only objects sealed here are keys; foreign objects, hashes and Object.isFrozen never are.
const deepFrozen=new WeakSet(),sealedRecords=new WeakMap();
/** Canonical text of a record sealed by this reader (undefined for any other value). */
export function sealedRecordText(v){return sealedRecords.get(v)?.text;}
/** True only for a catalogue, records array or record this reader deeply froze itself. */
export function isSealedCatalogueValue(v){return deepFrozen.has(v);}
function sealCatalogue(value,held){
 freeze(value);
 for(let i=0;i<value.records.length;i++){const r=value.records[i];if(!sealedRecords.has(r)){sealedRecords.set(r,held[i]);deepFrozen.add(r);}}
 deepFrozen.add(value.records);deepFrozen.add(value);return value;
}
// Same bytes and the same bounds as Buffer.byteLength(canonicalText(value)) and hash(canonicalText(value)) for a
// value whose records came from records(): the records sit two levels below the root, the array is one node.
function catalogueDigest(value,held){
 const {records:list,...top}=value,state={nodes:0,deepest:0},head=canonical(top,0,state);
 let nodes=state.nodes+1,deepest=0;for(const r of held){nodes+=r.nodes;if(r.deepest>deepest)deepest=r.deepest;}
 assert(nodes<=LIMITS.json_nodes&&deepest+2<=LIMITS.json_depth,'recovery-json-bounds');assert.equal(list.length,held.length);
 const keys=[...Object.keys(head),'records'].sort(),h=createHash('sha256');let bytes=0;const put=t=>{bytes+=Buffer.byteLength(t);h.update(t);};
 put('{');keys.forEach((k,i)=>{put((i?',':'')+JSON.stringify(k)+':');if(k!=='records'){put(JSON.stringify(head[k]));return;}
  put('[');for(let j=0;j<held.length;j++){if(j)put(',');bytes+=held[j].bytes;h.update(held[j].text);}put(']');});put('}');
 return {bytes,digest:h.digest('hex')};
}
function selected(x){exact(x,['database','data_directory','port','native_start_epoch']);assert(/^[a-zA-Z0-9_]{1,63}$/.test(x.database));assert(typeof x.data_directory==='string'&&x.data_directory.startsWith('/')&&x.data_directory.length<=4096&&!x.data_directory.includes('\0'));assert(Number.isInteger(x.port)&&x.port>=1024&&x.port<=65535);assert(typeof x.native_start_epoch==='string'&&/^[1-9][0-9]{0,15}$/.test(x.native_start_epoch));return freeze(structuredClone(x));}
function timeout(v){assert(typeof v==='string');const m=/^([0-9]+)(ms|s|min)?$/.exec(v);assert(m,'recovery-native-timeout-shape');const n=Number(m[1])*(m[2]==='s'?1000:m[2]==='min'?60000:1);assert(n>0&&n<=8000,'recovery-native-finite-timeout');}
function context(c,row,s){
 assert(row&&row.database===s.database&&row.data_directory===s.data_directory&&row.port===s.port&&row.native_start_epoch===s.native_start_epoch,'recovery-selected-database');
 assert(row.owner==='postgres'&&row.role==='postgres'&&['127.0.0.1','::1'].includes(row.address),'recovery-genuine-owner-loopback');assert.equal(row.backend_pid,c.processID,'recovery-same-owner-session');
 assert(/^18[0-9]{4}$/.test(row.server_version_num),'recovery-supported-PG18');assert(row.read_only==='off'&&row.isolation==='read committed'&&row.timezone==='UTC'&&row.jit==='off'&&row.search_path==='pg_catalog, public','packing-held-cold-owner-context');assert.equal(row.schema_lock,1,'recovery-held-982376');timeout(row.statement_timeout);timeout(row.lock_timeout);assert(typeof row.transaction_started_at==='string'&&typeof row.snapshot==='string');return row;
}
function counts(row){
 exact(row,['schemas',...COUNTS]);const descriptors=Object.getOwnPropertyDescriptors(row);
 // A frozen accessor can still change its result. Snapshot only own data values,
 // never retain or freeze caller counts/schemas as part of a validated catalogue.
 for(const k of ['schemas',...COUNTS])assert(descriptors[k]&&Object.hasOwn(descriptors[k],'value'),'recovery-count-own-data');
 const inputSchemas=descriptors.schemas.value;assert(Array.isArray(inputSchemas),'recovery-count-schemas-array');
 const schemaDescriptors=Object.getOwnPropertyDescriptors(inputSchemas),schemas=[];
 const schemaLength=schemaDescriptors.length?.value;assert.equal(schemaLength,SCOPE.length,'recovery-count-schemas-size');
 assert.deepEqual(Object.getOwnPropertyNames(inputSchemas).sort(),['length',...Array.from({length:schemaLength},(_,i)=>String(i))].sort(),'recovery-count-schemas-dense');
 for(let i=0;i<schemaLength;i++){const d=schemaDescriptors[String(i)];assert(d&&Object.hasOwn(d,'value')&&typeof d.value==='string','recovery-count-schema-own-data');schemas.push(d.value);}
 assert.deepEqual(schemas,[...SCOPE].sort(),'recovery-exact-application-schemas');const snapshot={schemas};
 for(const k of COUNTS){const value=descriptors[k].value;assert(Number.isInteger(value)&&value>=0&&value<=LIMITS.rows_per_catalogue,'recovery-bounded-'+k);snapshot[k]=value;}
 for(const k of COUNTS.filter(k=>k.startsWith('unsupported_')))assert.equal(snapshot[k],0,'recovery-refuse-'+k);
 assert(snapshot.relations>0&&snapshot.functions>0,'recovery-not-empty');return snapshot;
}
function lengths(row){exact(row,['records','encoded_bytes','largest_record']);assert(Number.isInteger(row.records)&&row.records>0&&row.records<=LIMITS.records,'recovery-record-count');for(const k of ['encoded_bytes','largest_record'])assert(typeof row[k]==='string'&&/^[0-9]{1,18}$/.test(row[k]));assert(BigInt(row.largest_record)<=BigInt(LIMITS.record_bytes),'recovery-per-record-prepayload-bound');assert(BigInt(row.encoded_bytes)+BigInt(row.records*2+4096)<=BigInt(LIMITS.encoded_bytes),'recovery-aggregate-prepayload-bound');return row;}
function records(rows,held=[]){
 assert(Array.isArray(rows)&&rows.length>0&&rows.length<=LIMITS.records);const length=rows.length,seen=new Set(),normalized=[];let previous='';const state={nodes:0,deepest:0};
 // Build native dense arrays ourselves; caller Array.map/species may return a
 // foreign array/proxy and is unsuitable for an owned immutable snapshot.
 // Capture each record once BEFORE checking its fields; frozen getters on an
 // input record must not substitute unchecked data after the shape check.
 for(let i=0;i<length;i++){
  assert(Object.hasOwn(rows,i),'recovery-dense-record-array');const row=rows[i],sealed=sealedRecords.get(row);let r; // one read: an accessor index cannot swap the record after the lookup
  if(sealed){state.nodes+=sealed.nodes;assert(state.nodes<=LIMITS.json_nodes,'recovery-json-bounds');r=row;held.push(sealed);}
  else{const nodes=state.nodes;state.deepest=0;r=canonical(row,0,state);const text=JSON.stringify(r);held.push(Object.freeze({text,bytes:Buffer.byteLength(text),nodes:state.nodes-nodes,deepest:state.deepest}));}
  if(!sealed){exact(r,['kind','key','value']);assert(KINDS.has(r.kind)&&typeof r.key==='string'&&r.key.length>0&&!r.key.includes('\0'));}const id=r.kind+'\0'+r.key;assert(!seen.has(id),'recovery-duplicate-object');assert(id>previous,'recovery-canonical-order');previous=id;seen.add(id);if(sealed){normalized.push(r);continue;}exact(r.value,FIELDS[r.kind]);if(r.kind==='trigger')assert(typeof r.value.has_when==='boolean','recovery-trigger-when-presence');if('acl'in r.value){assert(Array.isArray(r.value.acl));for(const grant of r.value.acl){exact(grant,['grantor','grantee','privilege','grantable']);assert(typeof grant.grantable==='boolean');}}normalized.push(r);
 }
 return normalized;
}
function membership(rs,cs){const identities=new Set(rs.map(r=>r.kind+'\0'+r.key));for(const key of SOURCE_SELECTION.required_tables)assert(identities.has('relation\0'+key),'recovery-required187188-table');for(const key of SOURCE_SELECTION.required_functions)assert(identities.has('function\0'+key),'recovery-required188-function');const names={schema:null,relation:'relations',index:'indexes',sequence:'sequences',inheritance:'inheritance',column:'columns',constraint:'constraints',policy:'policies',trigger:'triggers',function:'functions',type:'types',event_trigger:'event_triggers',default_acl:'default_acl',role:'roles',role_membership:'role_memberships',extension:'extensions',rule:'rules',operator:'operators',operator_class:'operator_classes',operator_family:'operator_families',family_operator:'operator_family_operators',family_procedure:'operator_family_procedures',access_method:'access_methods',language:'languages',extension_member:'extension_members'};const perKind=new Map(),schemaKeys=[];for(const r of rs){perKind.set(r.kind,(perKind.get(r.kind)??0)+1);if(r.kind==='schema')schemaKeys.push(r.key);}for(const[k,c]of Object.entries(names)){assert.equal(perKind.get(k)??0,c===null?SCOPE.length:cs[c],'recovery-full-membership-'+k);if(k==='schema')assert.deepEqual(schemaKeys.sort(),[...SCOPE].sort());}}
/** Requires an already-connected native pg.Client under caller-held982376 cold owner RC TX.
 * Does not BEGIN/SET/LOCK/COMMIT/ROLLBACK/end or dispatch validity routines.
 * Presence of a native lock is not proof of global writer participation, nor
 * can pg_locks distinguish session vs transaction lifetime: caller owns that.
 * Reads only pg_catalog. Selected identity and root XID are checked before and after. RC snapshots themselves may advance; DDL participation remains a separate native prerequisite. */
export async function derivePackingColdIdentity(c){
 assert(c instanceof pg.Client,'packing-native-Client-required');const stream=c.connection?.stream;
 assert(stream instanceof Socket&&!stream.destroyed&&['127.0.0.1','::1'].includes(stream.remoteAddress)&&stream.remotePort===c.port,'packing-native-loopback-owner');
 let lost=false,first,status;const poison=e=>{if(!lost){lost=true;first=e??Error('packing owner ended');}},onEnd=()=>poison(),ready=m=>{status=m.status;};
 c.on('error',poison);c.on('end',onEnd);c.connection.on('readyForQuery',ready);
 try{const rows=(await c.query(CONTEXT_SQL)).rows;if(lost)throw first;assert.equal(status,'T','packing-caller-held-cold-TX');assert.equal(rows.length,1);
 const row=rows[0],s=selected({database:c.database,data_directory:row.data_directory,port:c.port,native_start_epoch:row.native_start_epoch});context(c,row,s);return s;
 }catch(e){throw lost?first:e;}finally{c.removeListener('error',poison);c.removeListener('end',onEnd);c.connection.removeListener('readyForQuery',ready);}
}
export async function readPackingCatalogue(c,input){
 const s=selected(input);assert(c instanceof pg.Client,'recovery-native-Client-required');const stream=c.connection?.stream;assert(stream instanceof Socket&&!stream.destroyed&&['127.0.0.1','::1'].includes(stream.remoteAddress)&&stream.remotePort===s.port,'recovery-selected-native-socket');
 let lost=false,first;const poison=e=>{if(!lost){lost=true;first=e??Object.assign(Error('owner connection ended'),{code:'RECOVERY_OWNER_ENDED'});}};const onError=e=>poison(e),onEnd=()=>poison();c.on('error',onError);c.on('end',onEnd);
 const q=async sql=>{if(lost)throw first;let status;const ready=m=>{status=m.status;};c.connection.on('readyForQuery',ready);let result,failed=false,cause;try{result=await c.query(sql);assert.equal(status,'T','recovery-caller-held-transaction');if(lost)throw first;}catch(e){failed=true;cause=lost?first:e;}finally{c.connection.removeListener('readyForQuery',ready);}if(failed)throw cause;return result;};
 try{
  const open=(await q(CONTEXT_SQL)).rows;assert.equal(open.length,1);const before=context(c,open[0],s);
  const cr=(await q(COUNT_SQL)).rows;assert.equal(cr.length,1);const count=counts(cr[0]);
  const lr=(await q(LENGTH_SQL)).rows;assert.equal(lr.length,1);const length=lengths(lr[0]);
  const payload=(await q(PAYLOAD_SQL)).rows;assert.equal(payload.length,length.records);let byteCount=0;const decoded=[];
  for(const r of payload){exact(r,['record']);assert(typeof r.record==='string');const n=Buffer.byteLength(r.record);assert(n<=LIMITS.record_bytes);byteCount+=n;assert(byteCount+payload.length*2+4096<=LIMITS.encoded_bytes,'recovery-postpayload-bound');decoded.push(JSON.parse(r.record));}
  assert.equal(String(byteCount),length.encoded_bytes,'recovery-exact-premeasured-payload');const held=[],normalized=records(decoded,held);membership(normalized,count);
  const closingCounts=(await q(COUNT_SQL)).rows;assert.equal(closingCounts.length,1);assert.deepEqual(counts(closingCounts[0]),count,'recovery-closing-catalogue-count');
  const close=(await q(CONTEXT_SQL)).rows;assert.equal(close.length,1);const after=context(c,close[0],s);const stable=({snapshot,...other})=>other;assert.deepEqual(stable(after),stable(before),'packing-same-owner-cold-TX');if(lost)throw first;
  const value={schema:SCHEMA_VERSION,postgres_major:18,scope:[...SCOPE],sql_sha256:SQL_SHA256,counts:count,records:normalized};const {bytes,digest}=catalogueDigest(value,held);assert(bytes<=LIMITS.encoded_bytes,'recovery-serialized-bound');const result=sealCatalogue({...value,sha256:digest},held);capturedContexts.set(result,freeze(structuredClone(before)));return cacheSnapshot(result,true);
 }finally{c.removeListener('error',onError);c.removeListener('end',onEnd);}
}
/** For an already authenticated archive's metadata or an actual reader result.
 * Digest is integrity only, never authentication/Startup/cold/IAM authority. */
export function validateRecoverySchema(value){
 const snapshot=normalizedSnapshots.get(value);if(snapshot)return snapshot;
 exact(value,['schema','postgres_major','scope','sql_sha256','counts','records','sha256']);
 // Freeze does not stabilize an accessor. Capture the same own primitive digest
 // before reading other fields; validate and return only this immutable value.
 const digestDescriptor=Object.getOwnPropertyDescriptor(value,'sha256');assert(digestDescriptor&&Object.hasOwn(digestDescriptor,'value'),'recovery-sha-own-data');
 const digest=digestDescriptor.value;assert(typeof digest==='string'&&/^[a-f0-9]{64}$/.test(digest),'recovery-sha-shape');
 assert.equal(value.schema,SCHEMA_VERSION,'recovery-version-mismatch');assert.equal(value.postgres_major,18);assert.deepEqual(value.scope,[...SCOPE]);assert.equal(value.sql_sha256,SQL_SHA256,'recovery-query-contract');
 const held=[],normalized={schema:SCHEMA_VERSION,postgres_major:18,scope:[...SCOPE],sql_sha256:SQL_SHA256,counts:counts(value.counts),records:records(value.records,held)};membership(normalized.records,normalized.counts);const text=catalogueDigest(normalized,held);assert(text.bytes<=LIMITS.encoded_bytes,'recovery-serialized-bound');assert.equal(text.digest,digest,'recovery-snapshot-integrity');return cacheSnapshot(sealCatalogue({...normalized,sha256:digest},held));
}
/** Exact ALL supported metadata. No ignore list, readiness bool or cold issuance.
 * Returns only digest/kind/hashed object keys on drift, not SQL/default/body values. */
export function compareRecoverySchemas(source,restored){
 const a=validateRecoverySchema(source),b=validateRecoverySchema(restored);if(a.sha256===b.sha256)return freeze({equal:true,version:SCHEMA_VERSION,source_sha256:a.sha256,restored_sha256:b.sha256,records:a.records.length});
 const left=new Map(a.records.map(r=>[r.kind+'\0'+r.key,r])),right=new Map(b.records.map(r=>[r.kind+'\0'+r.key,r])),changed=[];let changesTotal=0;
 for(const id of [...new Set([...left.keys(),...right.keys()])].sort()){const x=left.get(id),y=right.get(id);if(!x||!y||canonicalText(x)!==canonicalText(y)){changesTotal++;if(changed.length<100)changed.push({kind:(x??y).kind,identity_sha256:hash(id),change:!x?'added':!y?'removed':'changed'});}}
 return freeze({equal:false,version:SCHEMA_VERSION,source_sha256:a.sha256,restored_sha256:b.sha256,counts_equal:canonicalText(a.counts)===canonicalText(b.counts),changed,changes_total:changesTotal,changes_truncated:changesTotal>100});
}
