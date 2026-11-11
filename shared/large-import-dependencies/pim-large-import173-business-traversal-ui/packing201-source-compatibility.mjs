import{projectOwnedQuotaRenewal202Catalogue}from'./packing202-source-compatibility.mjs';
/** Exact Source201 metadata inverse. No Native calls, observed whitelist or ignored records. */
import assert from 'node:assert/strict';import{createHash}from'node:crypto';
import{PACKING201_SOURCE_CONTRACT as E}from'./packing201-source-contract.mjs';
import{validateRecoverySchema}from'./packing189-catalogue-reader.mjs';
const canonical=x=>Array.isArray(x)?x.map(canonical):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
const sha=x=>createHash('sha256').update(x).digest('hex');
assert.equal(sha(JSON.stringify(E)),'6e739646c7acb506e82d0217bfee00b30d90bfd22c8c504733c3d1f4cd54dcda');
assert(E.schema==='source201-packing-exact-inverse/v1'&&E.old_certificate_rows_not_updated===true&&E.additions.length===12&&E.changes.length===2);
const names=new Set(E.additions.filter(r=>r.kind==='function').map(r=>r.key.slice(0,r.key.indexOf('(')))),indexKey=E.additions.find(r=>r.kind==='index').key;
function freezes(x){if(x&&typeof x==='object'){for(const y of Object.values(x))freezes(y);Object.freeze(x);}return x;}freezes(E);
// Pure representation reuse only; key is a validator-owned deeply frozen snapshot.
const projectionSnapshots=new WeakMap();
function retainProjection(owned,result){if(Object.hasOwn(result,'removed_counts'))Object.freeze(result.removed_counts);const output=Object.freeze(result);projectionSnapshots.set(owned,output);return output;}
export function projectPackingComplete201Catalogue(value){
 const owned=validateRecoverySchema(value),cached=projectionSnapshots.get(owned);if(cached)return cached;
 const retain=result=>retainProjection(owned,result);

 const renewal=projectOwnedQuotaRenewal202Catalogue(owned),x=renewal.catalogue,selected=x.records.filter(r=>r.kind==='function'&&names.has(r.key.slice(0,r.key.indexOf('(')))||['index','relation'].includes(r.kind)&&r.key===indexKey||r.kind==='column'&&r.key.startsWith(indexKey+'.'));
 if(!selected.length)return retain({catalogue:x,removed_functions:renewal.removed_functions,removed_indexes:0,removed_relations:0,removed_columns:0,changed_functions:renewal.changed_functions,active:renewal.active});
 assert.deepEqual(selected.map(r=>r.kind+'\0'+r.key).sort(),E.additions.map(r=>r.kind+'\0'+r.key).sort(),'packing201-exact-six-functions-index-relation-four-column-roster');
 const records=new Map(x.records.map(r=>[r.kind+'\0'+r.key,r]));
 for(const e of E.additions)assert.deepEqual(canonical(records.get(e.kind+'\0'+e.key)),canonical(e),'packing201-entire-source-added-descriptor');
 for(const e of E.changes){const r=records.get(e.kind+'\0'+e.key);assert(r);assert.deepEqual(canonical(r.value),canonical(e.after),'packing201-entire-source-changed-descriptor');}
 const added=new Set(E.additions.map(r=>r.kind+'\0'+r.key)),changed=new Map(E.changes.map(r=>[r.kind+'\0'+r.key,r]));
 const remaining=x.records.filter(r=>!added.has(r.kind+'\0'+r.key)).map(r=>{const e=changed.get(r.kind+'\0'+r.key);return e?{...r,value:e.before}:r;});
 const projected={schema:x.schema,postgres_major:x.postgres_major,scope:[...x.scope],sql_sha256:x.sql_sha256,counts:{...x.counts,functions:x.counts.functions-6,indexes:x.counts.indexes-1,relations:x.counts.relations-1,columns:x.counts.columns-4},records:remaining};
 const catalogue=validateRecoverySchema({...projected,sha256:sha(JSON.stringify(canonical(projected)))});
 return retain({catalogue,removed_functions:6+renewal.removed_functions,removed_indexes:1,removed_relations:1,removed_columns:4,changed_functions:2+renewal.changed_functions,active:true});
}
