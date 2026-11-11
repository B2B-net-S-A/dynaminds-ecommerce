/** Exact additive source207 inverse. Metadata only; no Native validity/IAM cache,
 * admission, migration registration, certificate change or runtime authority. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {RETURN_CREDIT207_SOURCE_CONTRACT as E} from './return-credit207-source-contract.mjs';
import {validateRecoverySchema} from './packing189-catalogue-reader.mjs';
const canonical=x=>Array.isArray(x)?x.map(canonical):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
const hash=x=>createHash('sha256').update(x).digest('hex'),identity=r=>r.kind+'\0'+r.key;
assert.equal(E.schema,'source207-consumer-return-exact-inverse/v1');
assert(E.source_compilation_proven&&E.independent_empty_source_database&&E.source205_baseline_equal&&E.old_certificate_rows_not_updated);
assert(E.native_certification===false&&E.application_activation===false&&E.changes.length===0&&E.removed.length===0);
assert.equal(E.compiler_receipt_sha256,'3f7eacd45694ebfaedac6033602c324b4e32faa435f8af8390f9fcae5d60e5a9');
assert.equal(E.source_program_sha256,'e327e6d39960ecf89b1a39412aa295f0de309b49157c60e97d419b32bed686e3');
assert.equal(E.migrations[1].files[0].sha256,'8abe73aec97e294860f918c7285c016444fce15322bf03148926f41041076172');
assert.equal(E.additions.length,539);
const expected=new Map(E.additions.map(r=>[identity(r),r]));assert.equal(expected.size,E.additions.length);
assert(E.additions.every(r=>r.key.includes('return_credit206_')),'source207 complete named namespace');
const removedCounts=Object.fromEntries(Object.entries(E.counts_after).filter(([,v])=>typeof v==='number').map(([k,v])=>{const n=v-E.counts_before[k];assert(Number.isInteger(n)&&n>=0);return[k,n];}));
assert.equal(Object.values(removedCounts).reduce((n,v)=>n+v,0),E.additions.length);

// Pure representation reuse only; key is a validator-owned deeply frozen snapshot.
const projectionSnapshots=new WeakMap();
function retainProjection(owned,result){if(Object.hasOwn(result,'removed_counts'))Object.freeze(result.removed_counts);const output=Object.freeze(result);projectionSnapshots.set(owned,output);return output;}
export function projectReturnCredit207Catalogue(value){
 const owned=validateRecoverySchema(value),cached=projectionSnapshots.get(owned);if(cached)return cached;
 const retain=result=>retainProjection(owned,result);

 const x=owned,selected=x.records.filter(r=>r.key.includes('return_credit206_'));
 if(selected.length===0)return retain({catalogue:x,active:false,removed_records:0,removed_counts:Object.fromEntries(Object.keys(removedCounts).map(k=>[k,0]))});
 assert.deepEqual(selected.map(identity),E.additions.map(identity),'source207 exact complete206+207 roster');
 for(const record of selected)assert.deepEqual(canonical(record),canonical(expected.get(identity(record))),'source207 entire source-compiled descriptor');
 const records=x.records.filter(r=>!expected.has(identity(r))),counts={...x.counts};
 for(const[k,n]of Object.entries(removedCounts)){assert(counts[k]>=n,'source207 count subtraction');counts[k]-=n;}
 const body={schema:x.schema,postgres_major:x.postgres_major,scope:[...x.scope],sql_sha256:x.sql_sha256,counts,records};
 const catalogue=validateRecoverySchema({...body,sha256:hash(JSON.stringify(canonical(body)))});
 return retain({catalogue,active:true,removed_records:E.additions.length,removed_counts:{...removedCounts}});
}
