/** Pure Source209 inverse for the actual Source173 28-entry predecessor map.
 * REQUIRED expectation is separately authenticated source-compiler output, never
 * inferred from observed metadata. No DB, giant contract import, cached verdict,
 * Native installation proof or runtime admission. The default checks TWO live
 * descriptors. Explicit Source22 checks six additional current28-map members;
 * its public wave root and private helper are absent from that map.
 */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {assertOrderMergeDelivery209ConstraintChanges} from './order-merge-delivery209-constraints.mjs';
import {ORDER_MERGE_DELIVERY209_STARTUP_KEYS,assertOrderMergeDelivery209StartupBeforeRecords} from './order-merge-delivery209-startup-roster.mjs';

const functionKeys=Object.freeze([
 'public.buyer_address_preview_guard()','public.buyer_address_state_guard()',
 'public.buyer_address_guards()','public.buyer_address_fingerprint()',
 'public.manual_inventory_off_valid()','public.manual_inventory_off_projection_valid()',
 'public.partial_sale204_predecessor_definition(fn oid)','public.ordinary187_valid()',
 'public.partial_sale204_valid()','public.catalog_header205_valid()',
]);
const roster=Object.freeze(['allegro_oauth_recovery_guards','b2b_credit_guards','b2b_invoice_guards','buyer_address_guards','catalog_stock_control_guards','catalog_stock_count_guards','catalog_stock_legacy_group_guards','catalog_stock_return_guards','competitor_observation_guards','cooperation171_valid','credit_source_upgrade_valid','fa3_draft_guards','financial_return_guards','financial_return_upgrade_valid','label_print_guards','local_invoice_guards','manual_inventory_off_valid','nested172_valid','operative_delivery_valid','packed_label_print_guards','parcel_physical_wz_valid','pim_dictionary_valid','print_job_guards','product_rule_price_tags_guards','product_rule_schedule_guards','stocktake_adjustment_guards','warehouse_automatic_wz_guards','warehouse_wz_issuer_guards']);
const copied=Object.freeze(['cost','kind','rows','owner','result','strict','defaults','language','parallel','arguments','leakproof','definition','volatility','returns_set','argument_modes','argument_names','security_definer']);
const metadataKeys=Object.freeze([...copied,'signature','configuration','acl'].sort());
const fullKeys=Object.freeze(['owner','language','kind','cost','rows','security_definer','leakproof','strict','returns_set','volatility','parallel','support','variadic','argument_names','argument_modes','arguments','result','defaults','source','binary','config','definition','acl_null','acl'].sort());
const selected=Object.freeze(['buyer_address_guards','manual_inventory_off_valid']);
const sha=text=>createHash('sha256').update(text,'utf8').digest('hex');
function dataDescriptors(v,array=false){
 const descriptors=Object.getOwnPropertyDescriptors(v),keys=Reflect.ownKeys(v);
 assert(keys.every(k=>typeof k==='string'),'no symbol metadata keys');
 if(array){
  assert.equal(keys.length,v.length+1,'dense array without extra keys');
  for(let i=0;i<v.length;i++)assert(Object.hasOwn(descriptors,String(i)),'dense metadata array');
 }
 for(const key of keys){
  const d=descriptors[key];assert(Object.hasOwn(d,'value')&&!Object.hasOwn(d,'get')&&!Object.hasOwn(d,'set'),'data metadata values only');
  assert(d.enumerable||(array&&key==='length'),'no hidden metadata values');
 }
 return descriptors;
}
function object(v){assert(v&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v)),'plain metadata object');dataDescriptors(v);}
function exact(v,keys){object(v);assert.deepEqual(Object.keys(v).sort(),[...keys].sort(),'exact metadata keys');}
function same(a,b){
 if(a===b)return true;if(a===null||b===null||typeof a!=='object'||typeof b!=='object'||Array.isArray(a)!==Array.isArray(b))return false;
 const ak=Object.keys(a),bk=Object.keys(b);return ak.length===bk.length&&ak.every(k=>Object.hasOwn(b,k)&&same(a[k],b[k]));
}
function json(v,depth=0,budget={nodes:0,bytes:0},limits={nodes:100000,array:1024}){
 assert(depth<=64&&++budget.nodes<=limits.nodes,'bounded metadata JSON');
 if(typeof v==='string'){assert(v.isWellFormed(),'UTF8 scalar string');budget.bytes+=Buffer.byteLength(v);assert(budget.bytes<=134217728,'metadata bytes');return;}
 if(v===null||typeof v==='boolean')return;
 if(typeof v==='number'){assert(Number.isFinite(v));return;}
 if(Array.isArray(v)){assert(v.length<=limits.array);const descriptors=dataDescriptors(v,true);for(let i=0;i<v.length;i++)json(descriptors[i].value,depth+1,budget,limits);return;}
 object(v);const descriptors=Object.getOwnPropertyDescriptors(v);for(const k of Object.keys(descriptors)){json(k,depth+1,budget,limits);json(descriptors[k].value,depth+1,budget,limits);}
}
function metadata(name,v){
 exact(v,fullKeys);assert(typeof v.source==='string'&&v.source.length>0&&typeof v.definition==='string','complete source texts');
 assert.equal(v.definition.split(v.source).length,2,'whole source occurs exactly once in full definition');
 assert(Array.isArray(v.acl));const acl=v.acl.map(a=>{exact(a,['grantor','grantee','privilege','grantable']);assert(['grantor','grantee','privilege'].every(k=>typeof a[k]==='string')&&typeof a.grantable==='boolean');return[a.grantor,a.grantee,a.privilege,a.grantable];});
 acl.sort((a,b)=>{for(let i=0;i<3;i++){if(a[i]<b[i])return-1;if(a[i]>b[i])return 1;}return Number(a[3])-Number(b[3]);});
 assert.equal(new Set(acl.map(v=>JSON.stringify(v))).size,acl.length,'no duplicate ACL');
 const result=Object.fromEntries(copied.map(k=>[k,structuredClone(v[k])]));
 result.signature=name+(name==='partial_sale204_predecessor_definition'?'(oid)':'()');
 result.configuration=structuredClone(v.config);result.acl=acl;return result;
}
function expectation(e){
 exact(e,['schema','additions','changes','removed']);json(e);assert.equal(e.schema,'source209-order-merge-delivery-exact-inverse/v1');
 assert(Array.isArray(e.additions)&&Array.isArray(e.removed)&&e.removed.length===0);assert(Array.isArray(e.changes)&&e.changes.length===14,'source-compiled exact14 changes required');
 const changes=new Map(),constraints=[];
 for(const c of e.changes){
  exact(c,['kind','key','before','after']);assert(typeof c.key==='string');
  if(c.kind==='constraint'){constraints.push(c);continue;}
  assert.equal(c.kind,'function');assert(functionKeys.includes(c.key)&&!changes.has(c.key),'exact ten authored function keys, no overload/duplicate');
  const name=c.key.slice(7,c.key.indexOf('('));
  const before=metadata(name,c.before),after=metadata(name,c.after);
  const {source:beforeSource,definition:beforeDefinition,...beforeHeader}=c.before;
  const {source:afterSource,definition:afterDefinition,...afterHeader}=c.after;
  assert(same(beforeHeader,afterHeader),'all authored function headers remain literal');
  assert.equal(afterDefinition,beforeDefinition.replace(beforeSource,()=>afterSource),'only complete source body changes in expected definition');
  assert(c.before.source!==c.after.source&&!same(before,after),'real complete source successor');
  changes.set(c.key,{before,after,before_source_sha256:sha(c.before.source),after_source_sha256:sha(c.after.source)});
 }
 assert.equal(changes.size,10);assertOrderMergeDelivery209ConstraintChanges(constraints);return changes;
}
function observed(name,value){exact(value,metadataKeys);assert.equal(value.signature,name+'()','exact no-argument predecessor signature');}
/** Output remains subject to the parent's complete28 comparison and exact
 * source209 catalogue inverse. Unknown predecessor facts are retained, not blessed.
 */
export function projectOrderMergeDelivery209Predecessors(value,expected,options){
 let startup;if(options!==undefined){exact(options,['source22']);startup=startupExpectation(options.source22);}
 const changes=expectation(expected);exact(value,roster);json(value);
 for(const name of roster)observed(name,value[name]);
 const states=selected.map(name=>{const e=changes.get('public.'+name+'()');if(same(value[name],e.before))return false;assert(same(value[name],e.after),'entire current20-field successor metadata required');return true;});
 assert(states.every(active=>active===states[0]),'mixed current BEFORE/AFTER predecessor metadata refused');
 const startupNames=startup?ORDER_MERGE_DELIVERY209_STARTUP_KEYS.map(key=>key.slice(7,key.indexOf('('))).filter(name=>roster.includes(name)):[];
 const startupStates=startupNames.map(name=>{const e=startup.changes.get('public.'+name+'()');if(same(value[name],e.beforeMetadata))return false;assert(same(value[name],e.afterMetadata),'entire current startup20-field successor required');return true;});
 if(startup){assert.equal(startupStates.length,6,'wave and private helper are absent from the actual28 map');assert(startupStates.every(active=>active===startupStates[0]),'mixed startup BEFORE/AFTER refused');if(startupStates[0])assert(states[0],'Source22 startup cannot precede its Source21 predecessor changes');}
 const result=structuredClone(value);
 if(startupStates[0])for(const name of startupNames)result[name]=structuredClone(startup.changes.get('public.'+name+'()').beforeMetadata);
 if(states[0])for(const name of selected)result[name]=structuredClone(changes.get('public.'+name+'()').before);
 return{value:result,active:states[0],...(startup?{startup_active:startupStates[0],startup_current_metadata_checked:6,startup_wave_observed:false,startup_helper_observed:false}:{}),authority:false,native_acceptance:false,full_catalogue_checked:false,current_metadata_checked:startup?8:2,authored_expected_functions:startup?17:10,unselected_predecessors_checked:false};
}


const startupHelperKey='public.order_merge_delivery209_startup_operative_valid(entries jsonb)';
// Complete Source204-derived clone with only its buyer251 constraint projection.
const startupHelperRecordSha256='f5082d2bae4acef908387ed1b425a490738d64cd78cc7490d4a2157abe0a7e24';
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
/** Expectations must be authenticated from the final compiled source by the
 * caller. The independently pinned seven BEFORE records additionally prevent
 * observing the current catalogue and calling it a new historical baseline.
 * Preprojection generator output is not a compiled AFTER authority.
 */
function startupExpectation(e){
 exact(e,['changes','additions']);json(e);
 assert(Array.isArray(e.changes)&&e.changes.length===7&&Array.isArray(e.additions)&&e.additions.length===1,'fixed seven startup changes and one helper');
 const changes=new Map();
 for(const c of e.changes){
  exact(c,['kind','key','before','after']);assert.equal(c.kind,'function');assert(ORDER_MERGE_DELIVERY209_STARTUP_KEYS.includes(c.key)&&!changes.has(c.key),'fixed startup keys, no duplicate/overload');
  const name=c.key.slice(7,c.key.indexOf('(')),beforeMetadata=metadata(name,c.before),afterMetadata=metadata(name,c.after);
  const {source:beforeSource,definition:beforeDefinition,...beforeHeader}=c.before;
  const {source:afterSource,definition:afterDefinition,...afterHeader}=c.after;
  assert(same(beforeHeader,afterHeader),'startup header and complete ACL remain literal');
  assert.notEqual(beforeSource,afterSource,'real startup source successor');
  assert.equal(afterDefinition,beforeDefinition.replace(beforeSource,()=>afterSource),'only entire startup body changes');
  changes.set(c.key,{...c,beforeMetadata,afterMetadata});
 }
 assert.equal(changes.size,7);
 assertOrderMergeDelivery209StartupBeforeRecords(ORDER_MERGE_DELIVERY209_STARTUP_KEYS.map(key=>({kind:'function',key,value:changes.get(key).before})));
 const helper=e.additions[0];exact(helper,['kind','key','value']);assert.equal(helper.kind,'function');assert.equal(helper.key,startupHelperKey);
 metadata('order_merge_delivery209_startup_operative_valid',helper.value);
 const v=helper.value;assert.equal(v.owner,'postgres');assert.equal(v.language,'plpgsql');assert.equal(v.kind,'f');assert.equal(v.security_definer,true);
 assert.equal(v.volatility,'s');assert.equal(v.arguments,'entries jsonb');assert.deepEqual(v.argument_names,['entries']);assert.equal(v.result,'boolean');
 assert.deepEqual(v.config,['search_path=pg_catalog, public','TimeZone=UTC']);assert.equal(v.acl_null,false);
 assert.deepEqual(v.acl,[{grantor:'postgres',grantee:'postgres',privilege:'EXECUTE',grantable:false}],'startup helper remains owner-only');
 assert.equal(sha(JSON.stringify(canonical(helper))),startupHelperRecordSha256,'complete independently pinned source-authored startup helper');
 return{changes,helper};
}

/** Finite representation stage BEFORE the existing ten-function/four-CHECK
 * inverse. No full-catalogue authority: unselected records are retained exactly
 * for the parent's complete membership/header/count/digest comparison.
 * Presence of the helper requires all seven complete AFTER descriptors; absence
 * requires all seven literal BEFORE descriptors. No mixed/adopted state.
 */
export function projectOrderMergeDelivery209StartupCatalogueRecords(records,source22){
 const expected=startupExpectation(source22);
 assert(Array.isArray(records)&&records.length>0&&records.length<=100000,'bounded source catalogue records');
 json(records,0,{nodes:0,bytes:0},{nodes:1000000,array:100000});
 const identities=new Set(),byName=new Map();let encoded=0;
 const selectedKeys=[...ORDER_MERGE_DELIVERY209_STARTUP_KEYS,startupHelperKey],names=new Set(selectedKeys.map(key=>key.slice(0,key.indexOf('('))));
 for(const r of records){
  exact(r,['kind','key','value']);assert(typeof r.kind==='string'&&typeof r.key==='string'&&r.key.length>0&&!r.key.includes('\0'));
  const id=r.kind+'\0'+r.key;assert(!identities.has(id),'no duplicate catalogue records');identities.add(id);
  const bytes=Buffer.byteLength(JSON.stringify(r));assert(bytes<=8388608,'per-record source catalogue bound');encoded+=bytes+2;assert(encoded+4096<=134217728,'aggregate source catalogue bound');
  const name=r.key.slice(0,r.key.indexOf('('));if(names.has(name))assert.equal(r.kind,'function','startup identity must remain a function record');
  if(r.kind==='function'){
   if(names.has(name)){assert(!byName.has(name),'startup function overload refused');byName.set(name,r);}
  }
 }
 const helper=byName.get(startupHelperKey.slice(0,startupHelperKey.indexOf('('))),active=!!helper;
 if(active)assert(same(helper,expected.helper),'entire source-authored private helper descriptor required');
 for(const key of ORDER_MERGE_DELIVERY209_STARTUP_KEYS){const r=byName.get(key.slice(0,key.indexOf('(')));assert(r&&r.key===key,'missing startup root or changed signature');assert(same(r.value,expected.changes.get(key)[active?'after':'before']),'entire coherent startup BEFORE/AFTER descriptor required');}
 const output=[];
 for(const r of records){if(r===helper)continue;const change=r.kind==='function'?expected.changes.get(r.key):undefined;output.push(change&&active?{kind:r.kind,key:r.key,value:structuredClone(change.before)}:structuredClone(r));}
 return{records:output,active,removed_functions:active?1:0,changed_functions:active?7:0,authority:false,native_acceptance:false,full_catalogue_checked:false,current_function_records_checked:active?8:7,unselected_records_checked:false};
}
