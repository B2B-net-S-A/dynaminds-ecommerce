/** Exact source-compiled208 metadata inverse. No Native, migration, IAM,
 * startup, transaction, validity cache or business authority. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {RETURN_CREDIT208_SOURCE_CONTRACT as E} from './return-credit208-source-contract.mjs';
import {RETURN_CREDIT207_SOURCE_CONTRACT as E207} from './return-credit207-source-contract.mjs';
import {validateRecoverySchema} from './packing189-catalogue-reader.mjs';
const keys=['public.return_credit206_guards()','public.return_credit206_require(uid uuid, kid uuid, writing boolean, pin boolean)'];
const id=r=>r.kind+'\0'+r.key;
function canonical(v,depth=0,budget={nodes:0}){
 assert(++budget.nodes<=1000000&&depth<=64,'208-json-bounds');
 if(v===null||typeof v==='string'||typeof v==='boolean')return v;
 if(typeof v==='number'){assert(Number.isFinite(v));return v;}
 if(Array.isArray(v)){assert(v.length<=100000);return Array.from({length:v.length},(_,i)=>{assert(Object.hasOwn(v,i),'208-dense-array');return canonical(v[i],depth+1,budget);});}
 assert(v&&typeof v==='object'&&[Object.prototype,null].includes(Object.getPrototypeOf(v)),'208-plain-json');
 return Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k],depth+1,budget)]));
}
function exact(v,fields){assert(v&&typeof v==='object'&&!Array.isArray(v));assert.deepEqual(Object.keys(v).sort(),fields.slice().sort());}
function records(input){
 assert(Array.isArray(input)&&input.length<=100000);const captured=canonical(structuredClone(input)),seen=new Set();let previous='';
 for(const r of captured){exact(r,['kind','key','value']);assert(typeof r.kind==='string'&&typeof r.key==='string'&&r.key.length>0&&!r.key.includes('\0'));assert(r.value&&typeof r.value==='object'&&!Array.isArray(r.value));const identity=id(r);assert(!seen.has(identity),'208-duplicate-record');assert(identity>previous,'208-record-order');seen.add(identity);previous=identity;}
 return captured;
}
/** Input must later come from a separately pinned/reviewed source compiler.
 * A JSON digest alone is not authentication. No default/fallback expectation. */
function expectation(expected){
 const e=canonical(structuredClone(expected));exact(e,['schema','additions','changes','removed']);
 assert.equal(e.schema,'source208-consumer-return-exact-inverse/v1');assert.deepEqual(e.removed,[]);assert.equal(e.changes.length,2);
 assert.deepEqual(e.changes.map(c=>c.key),keys);
 const additions=records(e.additions);assert(additions.length>0);assert(additions.every(r=>r.key.includes('return_credit208_')),'208-exact-namespace-only');
 for(const c of e.changes){exact(c,['kind','key','before','after']);assert.equal(c.kind,'function');assert.notDeepEqual(c.before,c.after);assert(c.before&&c.after&&typeof c.before==='object'&&typeof c.after==='object');}
 return{...e,additions};
}
function projectOwnedRecords(rows,e){
 const additions=e.additions;
 const one=c=>{const name=c.key.slice(0,c.key.indexOf('('));const found=rows.filter(r=>r.kind==='function'&&r.key.slice(0,r.key.indexOf('('))===name);assert.deepEqual(found.map(r=>r.key),[c.key],'208-no-overload-missing-or-duplicate');return found[0];};
 const selected=rows.filter(r=>r.key.includes('return_credit208_'));
 if(!selected.length){for(const c of e.changes)assert.deepEqual(canonical(one(c).value),c.before,'208-absent-requires-exact207-before');return{records:rows,active:false,removed_records:0,changed_records:0,authority:false};}
 assert.deepEqual(selected.map(id),additions.map(id),'208-complete-exact-addition-roster');
 assert.deepEqual(canonical(selected),additions,'208-complete-source-descriptors');
 for(const c of e.changes)assert.deepEqual(canonical(one(c).value),c.after,'208-complete-current-changed-descriptor');
 const removed=new Set(additions.map(id));
 const output=rows.filter(r=>!removed.has(id(r))).map(r=>{const c=e.changes.find(c=>c.kind===r.kind&&c.key===r.key);return c?{kind:r.kind,key:r.key,value:structuredClone(c.before)}:r;});
 return{records:output,active:true,removed_records:additions.length,changed_records:2,authority:false};
}
export function projectReturnCredit208RecordSet(input,expected){return projectOwnedRecords(records(input),expectation(expected));}

assert(E.source_compilation_proven&&E.independent_empty_source_database&&E.source205_baseline_equal&&E.old_certificate_rows_not_updated&&E.source_reviewed);
assert.equal(E.compiler_receipt_sha256,'b52b3ab3d28b5dca944a7a14936d1118dd724510e23911dcc7d4e6fe44064381');
assert.equal(E.root_review_receipt_sha256,'bb8f0c73f18281c941f8a378323016ada241e49e7d106586dbaa09ba7fb816f4');
assert.equal(E.source_program_sha256,'89baeaf2156e4df5909d848e0b0fd2e3c022d2718ad3ecc67c9107baac7dd5f0');
assert(E.application_activation===false&&E.native_certification===false);
assert.equal(E.additions.length,28);assert.equal(E.changes.length,2);
for(const c of E.changes){const predecessor=E207.additions.find(r=>r.kind===c.kind&&r.key===c.key);assert(predecessor);assert.deepEqual(canonical(c.before),canonical(predecessor.value),'208 exact literal207 predecessor');}
const compiled=expectation({schema:E.schema,additions:E.additions,changes:E.changes,removed:E.removed});
const removedCounts=Object.fromEntries(Object.entries(E.counts_after).filter(([,v])=>typeof v==='number').map(([k,v])=>{const n=v-E.counts_before[k];assert(Number.isInteger(n)&&n>=0);return[k,n];}));
assert.equal(Object.values(removedCounts).reduce((a,b)=>a+b,0),E.additions.length);
const zeros=()=>Object.fromEntries(Object.keys(removedCounts).map(k=>[k,0]));
// Pure representation reuse only; key is a validator-owned deeply frozen snapshot.
const projectionSnapshots=new WeakMap();
function retainProjection(owned,result){if(Object.hasOwn(result,'removed_counts'))Object.freeze(result.removed_counts);const output=Object.freeze(result);projectionSnapshots.set(owned,output);return output;}
export function projectReturnCredit208Catalogue(value){
 const owned=validateRecoverySchema(value),cached=projectionSnapshots.get(owned);if(cached)return cached;
 const retain=result=>retainProjection(owned,result);

 const x=owned,has208=x.records.some(r=>r.key.includes('return_credit208_')),has206=x.records.some(r=>r.key.includes('return_credit206_'));
 // A full205 comparison legitimately visits this layer before206/207 exist,
 // and again after composing207->205. This is inactive metadata, never READY.
 if(!has208&&!has206)return retain({catalogue:x,active:false,removed_records:0,changed_records:0,removed_counts:zeros(),authority:false});
 // validateRecoverySchema created/froze these records. Reuse unchanged owned
 // values; do not deep-clone an already validated60MB catalogue a second time.
 const p=projectOwnedRecords(x.records,compiled);
 if(!p.active)return retain({catalogue:x,...p,removed_counts:zeros()});
 const counts={...x.counts};for(const[k,n]of Object.entries(removedCounts)){assert(counts[k]>=n,'208 count subtraction');counts[k]-=n;}
 const body={schema:x.schema,postgres_major:x.postgres_major,scope:[...x.scope],sql_sha256:x.sql_sha256,counts,records:p.records};
 const sha256=createHash('sha256').update(JSON.stringify(canonical(body))).digest('hex');
 return retain({catalogue:validateRecoverySchema({...body,sha256}),active:true,removed_records:p.removed_records,changed_records:2,removed_counts:{...removedCounts},authority:false});
}
