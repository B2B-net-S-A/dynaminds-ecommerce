import{projectKnownPartialCore203Catalogue}from'./packing203-source-compatibility.mjs';
/** Exact Source202 inverse. Source-derived descriptor equality precedes removal.
 * No Native calls, descriptor observations, ignored records, or admission cache. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {PACKING202_SOURCE_CONTRACT as E} from './packing202-source-contract.mjs';
import {validateRecoverySchema} from './packing189-catalogue-reader.mjs';
const canonical=x=>Array.isArray(x)?x.map(canonical):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
const sha=x=>createHash('sha256').update(x).digest('hex');
assert(E.schema==='source202-owned-quota-expiry-exact-inverse/v1'&&E.old_certificate_rows_not_updated===true&&E.only_expiry_business_delta===true&&E.additions.length===5&&E.changes.length===4);
const names=new Set(E.additions.map(r=>r.key.slice(0,r.key.indexOf('('))));
function freeze(x){if(x&&typeof x==='object'){for(const y of Object.values(x))freeze(y);Object.freeze(x);}return x;}freeze(E);
// Pure representation reuse only; key is a validator-owned deeply frozen snapshot.
const projectionSnapshots=new WeakMap();
function retainProjection(owned,result){if(Object.hasOwn(result,'removed_counts'))Object.freeze(result.removed_counts);const output=Object.freeze(result);projectionSnapshots.set(owned,output);return output;}
export function projectOwnedQuotaRenewal202Catalogue(value){
 const owned=validateRecoverySchema(value),cached=projectionSnapshots.get(owned);if(cached)return cached;
 const retain=result=>retainProjection(owned,result);

 const successor=projectKnownPartialCore203Catalogue(owned),x=successor.catalogue,selected=x.records.filter(r=>r.kind==='function'&&names.has(r.key.slice(0,r.key.indexOf('('))));
 if(!selected.length)return retain({catalogue:x,removed_functions:successor.removed_functions,changed_functions:successor.changed_functions,active:successor.active});
 assert.deepEqual(selected.map(r=>r.key).sort(),E.additions.map(r=>r.key).sort(),'renewal202-exact-five-function-roster');
 const records=new Map(x.records.map(r=>[r.kind+'\0'+r.key,r]));
 for(const e of E.additions)assert.deepEqual(canonical(records.get(e.kind+'\0'+e.key)),canonical(e),'renewal202-entire-added-descriptor');
 for(const e of E.changes){const r=records.get(e.kind+'\0'+e.key);assert(r);assert.deepEqual(canonical(r.value),canonical(e.after),'renewal202-entire-changed-descriptor');}
 const added=new Set(E.additions.map(r=>r.kind+'\0'+r.key)),changed=new Map(E.changes.map(r=>[r.kind+'\0'+r.key,r]));
 const remaining=x.records.filter(r=>!added.has(r.kind+'\0'+r.key)).map(r=>{const e=changed.get(r.kind+'\0'+r.key);return e?{...r,value:e.before}:r;});
 const projected={schema:x.schema,postgres_major:x.postgres_major,scope:[...x.scope],sql_sha256:x.sql_sha256,counts:{...x.counts,functions:x.counts.functions-5},records:remaining};
 const catalogue=validateRecoverySchema({...projected,sha256:sha(JSON.stringify(canonical(projected)))});
 return retain({catalogue,removed_functions:5+successor.removed_functions,changed_functions:4+successor.changed_functions,active:true});
}
