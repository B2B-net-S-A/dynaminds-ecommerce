import{projectHeaderMetadata205Catalogue,projectHeaderMetadata205Predecessors}from'./header205-source-compatibility.mjs';
/** Exact Source204 inverse. Source-derived descriptor equality precedes removal.
 * No Native calls, descriptor observations, ignored records, or admission cache. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {PACKING204_SOURCE_CONTRACT as E} from './packing204-source-contract.mjs';
import {validateRecoverySchema} from './packing189-catalogue-reader.mjs';
const canonical=x=>Array.isArray(x)?x.map(canonical):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
const sha=x=>createHash('sha256').update(x).digest('hex');
assert(E.schema==='source204-partial-commercial-sale-exact-inverse/v1'&&E.old_certificate_rows_not_updated===true&&E.additions.length===3&&E.changes.length===33);
const names=new Set(E.additions.map(r=>r.key.slice(0,r.key.indexOf('('))));
function freeze(x){if(x&&typeof x==='object'){for(const y of Object.values(x))freeze(y);Object.freeze(x);}return x;}freeze(E);
// Pure representation reuse only; key is a validator-owned deeply frozen snapshot.
const projectionSnapshots=new WeakMap();
function retainProjection(owned,result){if(Object.hasOwn(result,'removed_counts'))Object.freeze(result.removed_counts);const output=Object.freeze(result);projectionSnapshots.set(owned,output);return output;}
export function projectPartialCommercial204Catalogue(value){
 const owned=validateRecoverySchema(value),cached=projectionSnapshots.get(owned);if(cached)return cached;
 const retain=result=>retainProjection(owned,result);

 const header205=projectHeaderMetadata205Catalogue(owned);
 // Every205 return is already normalized and deeply frozen by its own validator.
 const x=header205.catalogue,selected=x.records.filter(r=>r.kind==='function'&&names.has(r.key.slice(0,r.key.indexOf('('))));
 for(const e of E.changes){const name=e.key.slice(0,e.key.indexOf('('));assert.deepEqual(x.records.filter(r=>r.kind==='function'&&r.key.slice(0,r.key.indexOf('('))===name).map(r=>r.key),[e.key],'partial204-exact-changed-function-no-overload');}
 if(!selected.length){for(const e of E.changes){const r=x.records.find(r=>r.kind===e.kind&&r.key===e.key);assert(r);assert.deepEqual(canonical(r.value),canonical(e.before),'partial204-absent-successor-keeps-entire-predecessor');}return retain({catalogue:x,removed_functions:header205.removed_functions,changed_functions:0,active:false});}
 assert.deepEqual(selected.map(r=>r.key).sort(),E.additions.map(r=>r.key).sort(),'partial204-exact-three-added-function-roster');
 const records=new Map(x.records.map(r=>[r.kind+'\0'+r.key,r]));
 for(const e of E.additions)assert.deepEqual(canonical(records.get(e.kind+'\0'+e.key)),canonical(e),'partial204-entire-added-descriptor');
 for(const e of E.changes){const r=records.get(e.kind+'\0'+e.key);assert(r);assert.deepEqual(canonical(r.value),canonical(e.after),'partial204-entire-changed-descriptor');}
 const added=new Set(E.additions.map(r=>r.kind+'\0'+r.key)),changed=new Map(E.changes.map(r=>[r.kind+'\0'+r.key,r]));
 const remaining=x.records.filter(r=>!added.has(r.kind+'\0'+r.key)).map(r=>{const e=changed.get(r.kind+'\0'+r.key);return e?{...r,value:e.before}:r;});
 const projected={schema:x.schema,postgres_major:x.postgres_major,scope:[...x.scope],sql_sha256:x.sql_sha256,counts:{...x.counts,functions:x.counts.functions-3},records:remaining};
 const catalogue=validateRecoverySchema({...projected,sha256:sha(JSON.stringify(canonical(projected)))});
 return retain({catalogue,removed_functions:3+header205.removed_functions,changed_functions:33,active:true});
}

/** Exact current metadata, not a guard result or installation authority.
 * Root admission still requires the genuine whole catalogue and Native guards.
 * All nine members must be coherently Source203-before OR Source204-after.
 * The other nineteen members remain untouched for caller full28 equality. */
const predecessorRoster=["allegro_oauth_recovery_guards","b2b_credit_guards","b2b_invoice_guards","buyer_address_guards","catalog_stock_control_guards","catalog_stock_count_guards","catalog_stock_legacy_group_guards","catalog_stock_return_guards","competitor_observation_guards","cooperation171_valid","credit_source_upgrade_valid","fa3_draft_guards","financial_return_guards","financial_return_upgrade_valid","label_print_guards","local_invoice_guards","manual_inventory_off_valid","nested172_valid","operative_delivery_valid","packed_label_print_guards","parcel_physical_wz_valid","pim_dictionary_valid","print_job_guards","product_rule_price_tags_guards","product_rule_schedule_guards","stocktake_adjustment_guards","warehouse_automatic_wz_guards","warehouse_wz_issuer_guards"];
const changedPredecessors=["manual_inventory_off_valid","pim_dictionary_valid","cooperation171_valid","parcel_physical_wz_valid","operative_delivery_valid","nested172_valid","packed_label_print_guards","buyer_address_guards","financial_return_upgrade_valid"];
function predecessorMetadata(name,v){
 const result=Object.fromEntries(["cost","kind","rows","owner","result","strict","defaults","language","parallel","arguments","leakproof","definition","volatility","returns_set","argument_modes","argument_names","security_definer"].map(k=>[k,structuredClone(v[k])]));
 result.signature=name+'()';result.configuration=structuredClone(v.config);
 result.acl=v.acl.map(a=>[a.grantor,a.grantee,a.privilege,a.grantable]).sort((a,b)=>{for(let i=0;i<3;i++){if(a[i]<b[i])return-1;if(a[i]>b[i])return 1;}return Number(a[3])-Number(b[3]);});return result;
}
export function projectPartialCommercial204Predecessors(value){
 value=projectHeaderMetadata205Predecessors(value);
 assert(value&&typeof value==='object'&&!Array.isArray(value),'partial204-predecessor-object');
 assert.deepEqual(Object.keys(value).sort(),predecessorRoster,'partial204-exact28-predecessors-no-overload');
 const targets=changedPredecessors.map(name=>{const entries=E.changes.filter(r=>r.key==='public.'+name+'()');assert.equal(entries.length,1,'partial204-exact9-Source-targets');const e=entries[0];return{name,before:predecessorMetadata(name,e.before),after:predecessorMetadata(name,e.after)};});
 const matches=(side)=>targets.every(t=>JSON.stringify(canonical(value[t.name]))===JSON.stringify(canonical(t[side])));
 const before=matches('before'),after=matches('after');assert(before||after,'partial204-nine-current-full-metadata-not-mixed');
 const result=structuredClone(value);if(after)for(const t of targets)result[t.name]=structuredClone(t.before);return result;
}
