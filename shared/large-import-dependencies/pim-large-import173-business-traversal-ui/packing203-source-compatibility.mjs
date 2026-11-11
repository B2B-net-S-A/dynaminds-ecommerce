import{projectPartialCommercial204Catalogue}from'./packing204-source-compatibility.mjs';
/** Exact Source203 inverse. Source-derived descriptor equality precedes removal.
 * No Native calls, descriptor observations, ignored records, or admission cache. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {PACKING203_SOURCE_CONTRACT as E} from './packing203-source-contract.mjs';
import {validateRecoverySchema} from './packing189-catalogue-reader.mjs';
const canonical=x=>Array.isArray(x)?x.map(canonical):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
const sha=x=>createHash('sha256').update(x).digest('hex');
assert(E.schema==='source203-known-partial-core-quota-exact-inverse/v1'&&E.old_certificate_rows_not_updated===true&&E.only_expiry_business_delta===true&&E.additions.length===3&&E.changes.length===0);
const names=new Set(E.additions.map(r=>r.key.slice(0,r.key.indexOf('('))));
function freeze(x){if(x&&typeof x==='object'){for(const y of Object.values(x))freeze(y);Object.freeze(x);}return x;}freeze(E);
// Pure representation reuse only; key is a validator-owned deeply frozen snapshot.
const projectionSnapshots=new WeakMap();
function retainProjection(owned,result){if(Object.hasOwn(result,'removed_counts'))Object.freeze(result.removed_counts);const output=Object.freeze(result);projectionSnapshots.set(owned,output);return output;}
export function projectKnownPartialCore203Catalogue(value){
 const owned=validateRecoverySchema(value),cached=projectionSnapshots.get(owned);if(cached)return cached;
 const retain=result=>retainProjection(owned,result);

 const successor=projectPartialCommercial204Catalogue(owned),x=successor.catalogue,selected=x.records.filter(r=>r.kind==='function'&&names.has(r.key.slice(0,r.key.indexOf('('))));
 if(!selected.length)return retain({catalogue:x,removed_functions:successor.removed_functions,changed_functions:successor.changed_functions,active:false});
 assert.deepEqual(selected.map(r=>r.key).sort(),E.additions.map(r=>r.key).sort(),'partial203-exact-three-function-roster');
 const records=new Map(x.records.map(r=>[r.kind+'\0'+r.key,r]));
 for(const e of E.additions)assert.deepEqual(canonical(records.get(e.kind+'\0'+e.key)),canonical(e),'partial203-entire-added-descriptor');
 for(const e of E.changes){const r=records.get(e.kind+'\0'+e.key);assert(r);assert.deepEqual(canonical(r.value),canonical(e.after),'partial203-entire-changed-descriptor');}
 const added=new Set(E.additions.map(r=>r.kind+'\0'+r.key)),changed=new Map(E.changes.map(r=>[r.kind+'\0'+r.key,r]));
 const remaining=x.records.filter(r=>!added.has(r.kind+'\0'+r.key)).map(r=>{const e=changed.get(r.kind+'\0'+r.key);return e?{...r,value:e.before}:r;});
 const projected={schema:x.schema,postgres_major:x.postgres_major,scope:[...x.scope],sql_sha256:x.sql_sha256,counts:{...x.counts,functions:x.counts.functions-3},records:remaining};
 const catalogue=validateRecoverySchema({...projected,sha256:sha(JSON.stringify(canonical(projected)))});
 return retain({catalogue,removed_functions:3+successor.removed_functions,changed_functions:successor.changed_functions,active:true});
}
