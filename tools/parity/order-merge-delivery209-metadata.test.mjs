/** Independent20-field Source170/173 fixtures and literal pinned Source204 startup records.
 * No generated209 SQL, PG or compiled Source22 acceptance. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {projectOrderMergeDelivery209Predecessors as project,projectOrderMergeDelivery209StartupCatalogueRecords as projectStartup} from './order-merge-delivery209-metadata.mjs';
import {PACKING204_SOURCE_CONTRACT as E204} from '../../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/packing204-source-contract.mjs';
import {ORDER_MERGE_DELIVERY209_STARTUP_KEYS as startupKeys} from './order-merge-delivery209-startup-roster.mjs';
import {deriveOrderMergeDelivery209StartupClosure} from './order-merge-delivery209-startup-capability-closure.mjs';
import {ORDER_MERGE_DELIVERY209_CHECK_EXPRESSIONS as checks} from './order-merge-delivery209-constraints.mjs';
const sql170=readFileSync(new URL('../../server/170_pim_dictionaries.sql',import.meta.url),'utf8');
const sql173=readFileSync(new URL('../../server/173_large_catalog_import_birth.sql',import.meta.url),'utf8');
const fn170=sql170.split('CREATE FUNCTION pim_dictionary_function_metadata(function_oid oid)')[1].split('$$;')[0];
const build=fn170.slice(fn170.indexOf('SELECT jsonb_build_object(')+'SELECT jsonb_build_object('.length,fn170.indexOf(' FROM pg_proc'));
const parts=[];let depth=0,quoted=false,start=0;
for(let i=0;i<build.length;i++){
 const c=build[i];if(c==="'"){if(quoted&&build[i+1]==="'"){i++;continue;}quoted=!quoted;}
 if(quoted)continue;if(c==='(')depth++;if(c===')'){if(depth===0){parts.push(build.slice(start,i));break;}depth--;}
 if(c===','&&depth===0){parts.push(build.slice(start,i));start=i+1;}
}
const actualFields=parts.filter((_,i)=>i%2===0).map(s=>{const m=/^\s*'([a-z_0-9]+)'\s*$/.exec(s);assert(m);return m[1];});
const parent170=sql170.split('CREATE FUNCTION pim_dictionary_predecessor_metadata()')[1].split('$$;')[0];
const names=[...parent170.match(/ARRAY\[([^\]]+)\]/)[1].matchAll(/'([a-z_0-9]+)'/g)].map(m=>m[1]);
const parent173=sql173.split('CREATE FUNCTION public.large_import173_predecessor_map()')[1].split('$parents173$;')[0];
const extra=[...parent173.matchAll(/'([a-z_0-9]+)',public.pim_dictionary_function_metadata/g)].map(m=>m[1]);
const roster=[...names,...extra].sort();
const keys=['buyer_address_preview_guard','buyer_address_state_guard','buyer_address_guards','buyer_address_fingerprint','manual_inventory_off_valid','manual_inventory_off_projection_valid','partial_sale204_predecessor_definition','ordinary187_valid','partial_sale204_valid','catalog_header205_valid'];
const full=(name,after=false)=>{
 const source='BEGIN RETURN '+(after?'true':'false')+'; -- '+name+' Łódź 😀 \\123\nEND';
 return{owner:'postgres',language:'plpgsql',kind:'f',cost:100,rows:0,security_definer:true,leakproof:false,strict:false,returns_set:false,volatility:'s',parallel:'u',support:null,variadic:null,argument_names:name==='partial_sale204_predecessor_definition'?['fn']:null,argument_modes:null,arguments:name==='partial_sale204_predecessor_definition'?'fn oid':'',result:'boolean',defaults:null,source,binary:null,config:['search_path=pg_catalog, public','TimeZone=UTC'],definition:'CREATE OR REPLACE FUNCTION public.'+name+'() RETURNS boolean AS $$'+source+'$$ LANGUAGE plpgsql;',acl_null:false,acl:[{grantor:'postgres',grantee:'postgres',privilege:'EXECUTE',grantable:false}]};
};
// Independent projection by the actual SQL's twenty field names, not the helper's constants.
const metadata=(name,v)=>Object.fromEntries(actualFields.map(field=>[field,field==='signature'?name+'()':field==='configuration'?structuredClone(v.config):field==='acl'?v.acl.map(a=>[a.grantor,a.grantee,a.privilege,a.grantable]):structuredClone(v[field])]));
const changes=keys.map(name=>({kind:'function',key:'public.'+name+(name==='partial_sale204_predecessor_definition'?'(fn oid)':'()'),before:full(name),after:full(name,true)}));
for(const table of ['buyer_address_previews','buyer_address_receipts'])for(const role of ['kind','actor'])changes.push({kind:'constraint',key:'public.'+table+'.test_'+role,before:{kind:'c',validated:true,definition:checks[role+'_before']},after:{kind:'c',validated:true,definition:checks[role+'_after']}});
const expected={schema:'source209-order-merge-delivery-exact-inverse/v1',additions:[],changes,removed:[]};
const frame=after=>Object.fromEntries(roster.map(name=>[name,metadata(name,full(name,after&&['buyer_address_guards','manual_inventory_off_valid'].includes(name)))]));
const clone=structuredClone;

test('source173 real28 roster and source170 exact20 fields match independent fixtures; module imports no default giant expectation',()=>{
 assert.equal(names.length,25);assert.deepEqual(extra,['pim_dictionary_valid','cooperation171_valid','nested172_valid']);assert.equal(roster.length,28);assert.equal(new Set(roster).size,28);assert.equal(actualFields.length,20);assert.equal(new Set(actualFields).size,20);
 const source=readFileSync(new URL('./order-merge-delivery209-metadata.mjs',import.meta.url),'utf8');
 for(const token of ['source-contract.mjs','header205-source','packing204-source','pg\'','readFile','WeakMap','process.env'])assert(!source.includes(token));
 assert.throws(()=>project(frame(false)));assert.throws(()=>project(frame(false),{}));
});

test('whole active20-field pair projects exact literal BEFORE and inactive pair remains equal without mutation/authority',()=>{
 for(const active of [false,true]){
  const input=frame(active),before=clone(input),proof=project(input,expected);
  assert.equal(proof.active,active);assert.deepEqual(proof.value,frame(false));assert.deepEqual(input,before);
  assert.equal(proof.authority,false);assert.equal(proof.native_acceptance,false);assert.equal(proof.full_catalogue_checked,false);assert.equal(proof.current_metadata_checked,2);assert.equal(proof.authored_expected_functions,10);assert.equal(proof.unselected_predecessors_checked,false);
  proof.value.buyer_address_guards.owner='changed clone';assert.deepEqual(input,before);
 }
});

test('each of all20 current selected metadata fields and full definition UTF8/body bytes is fail-closed',()=>{
 for(const name of ['buyer_address_guards','manual_inventory_off_valid'])for(const field of actualFields){
  const input=frame(true);input[name][field]=['tampered',field];assert.throws(()=>project(input,expected),name+':'+field);
  const missing=frame(true);delete missing[name][field];assert.throws(()=>project(missing,expected));
 }
 for(const mutate of [s=>s+' ',s=>s.replace('Łódź','Lodz'),s=>s.replace('\\123','\\124'),s=>s.replace('true','false')]){
  const input=frame(true);input.buyer_address_guards.definition=mutate(input.buyer_address_guards.definition);assert.throws(()=>project(input,expected));
 }
});

test('mixed pair, missing target, overload, unexpected map key and NULL cannot become an inactive or active success',()=>{
 const mixed=frame(true);mixed.manual_inventory_off_valid=frame(false).manual_inventory_off_valid;assert.throws(()=>project(mixed,expected));
 const missing=frame(true);delete missing.buyer_address_guards;assert.throws(()=>project(missing,expected));
 const overload=frame(true);overload.buyer_address_guards.signature='buyer_address_guards(integer)';assert.throws(()=>project(overload,expected));
 const extra=frame(true);extra['buyer_address_guards(integer)']=clone(extra.buyer_address_guards);assert.throws(()=>project(extra,expected));
 for(const input of [null,[],{},Object.assign(frame(true),{buyer_address_guards:null})])assert.throws(()=>project(input,expected));
});

test('all ten expected full function shapes/framing plus exact14 roster and four authored constraint semantics are validated',()=>{
 for(let i=0;i<10;i++){
  const wrong=clone(expected);wrong.changes[i].after.source+=' outside definition';assert.throws(()=>project(frame(true),wrong));
  const missing=clone(expected);delete missing.changes[i].before.support;assert.throws(()=>project(frame(true),missing));
  const drift=clone(expected);drift.changes[i].after.cost++;assert.throws(()=>project(frame(true),drift));
  const header=clone(expected);header.changes[i].after.definition+='; -- unrelated header';assert.throws(()=>project(frame(true),header));
 }
 for(const alter of [e=>e.changes.pop(),e=>e.changes.push(clone(e.changes[0])),e=>e.changes[1]=clone(e.changes[0]),e=>e.changes[6].key='public.partial_sale204_predecessor_definition(text)',e=>e.changes[10].after.definition="CHECK(kind IN('access','delivery','anything'))",e=>e.changes[10].after.validated=false,e=>e.removed.push({}),e=>e.schema='observed-runtime-metadata']){
  const wrong=clone(expected);alter(wrong);assert.throws(()=>project(frame(true),wrong));
 }
});

test('unknown unselected predecessor facts are retained verbatim for the parent comparison, never normalized or asserted valid',()=>{
 const input=frame(true);input.b2b_invoice_guards.definition='independent current unknown bytes';input.b2b_invoice_guards.owner='different-owner';const proof=project(input,expected);
 assert.deepEqual(proof.value.b2b_invoice_guards,input.b2b_invoice_guards);assert.equal(proof.unselected_predecessors_checked,false);
 const nullProto=Object.assign(Object.create(null),input);for(const name of roster)nullProto[name]=Object.assign(Object.create(null),input[name]);assert.deepEqual(project(nullProto,expected).value,proof.value);
});


test('JSON data inspection rejects accessors without invocation, symbols, hidden keys and extra array keys',()=>{
 let reads=0;
 for(const target of ['root','metadata','nestedAcl','expectedRoot','expectedDescriptor','array']){
  const input=frame(true),e=clone(expected);
  const owner=target==='root'?input:target==='metadata'?input.buyer_address_guards:target==='nestedAcl'?input.buyer_address_guards.acl[0]:target==='expectedRoot'?e:target==='expectedDescriptor'?e.changes[0].after:e.changes;
  const key=target==='root'?'buyer_address_guards':target==='metadata'?'owner':target==='nestedAcl'?'0':target==='expectedRoot'?'schema':target==='expectedDescriptor'?'source':'0';
  Object.defineProperty(owner,key,{enumerable:true,configurable:true,get(){reads++;throw new Error('getter must not execute');}});
  assert.throws(()=>project(input,e));assert.equal(reads,0,target);
 }
 for(const property of ['symbol','hidden','arrayExtra','arraySymbol','arrayHidden']){
  const input=frame(true);let target=property.startsWith('array')?input.buyer_address_guards.acl:input.buyer_address_guards;
  const key=property.includes('Symbol')||property==='symbol'?Symbol('hidden authority'):'unexpected';
  Object.defineProperty(target,key,{value:'rejected',enumerable:!property.toLowerCase().includes('hidden'),configurable:true});
  assert.throws(()=>project(input,expected),property);
 }
 const immutable=frame(true);for(const v of Object.values(immutable)){Object.freeze(v.acl[0]);Object.freeze(v.acl);Object.freeze(v);}Object.freeze(immutable);
 assert.equal(project(immutable,expected).active,true,'readonly data descriptors remain accepted');
});


// Complete literal Source204 BEFORE records. The body-only controlled AFTER
// fixtures exercise projection mechanics, not a compiled Source22 expectation,
// Native execution or permission to treat observed descriptors as authority.
const startupChanges=startupKeys.map(key=>{
 const before=clone(E204.changes.find(c=>c.key===key).after),source=before.source+'\n-- controlled source22 complete-body successor';
 return{kind:'function',key,before,after:{...clone(before),source,definition:before.definition.replace(before.source,()=>source)}};
});
const helperName='order_merge_delivery209_startup_operative_valid';
const source204=readFileSync(new URL('../../server/204_partial_commercial_sale_scope.sql',import.meta.url),'utf8');
const startupClosure=deriveOrderMergeDelivery209StartupClosure({source204});
const startup={changes:startupChanges,additions:clone(startupClosure.helpers)};
const startupFrame=(legacyActive,startupActive)=>{
 const input=frame(legacyActive);
 for(const c of startup.changes){const name=c.key.slice(7,c.key.indexOf('('));if(roster.includes(name))input[name]=metadata(name,c[startupActive?'after':'before']);}
 return input;
};
const unrelated={kind:'function',key:'public.unrelated_current_fact()',value:{unknown:'unselected bytes retained'}};
const startupRecords=active=>[...startup.changes.map(c=>({kind:'function',key:c.key,value:clone(c[active?'after':'before'])})),...(active?clone(startup.additions):[]),clone(unrelated)];

test('Source22 independently pinned seven BEFORE descriptors project all current six28-map roots then legacy pair; wave/helper are not falsely observed',()=>{
 for(const [legacyActive,startupActive]of [[false,false],[true,false],[true,true]]){
  const input=startupFrame(legacyActive,startupActive),original=clone(input),result=project(input,expected,{source22:startup});
  assert.deepEqual(result.value,startupFrame(false,false));assert.deepEqual(input,original);
  assert.equal(result.active,legacyActive);assert.equal(result.startup_active,startupActive);assert.equal(result.current_metadata_checked,8);assert.equal(result.authored_expected_functions,17);
  assert.equal(result.startup_current_metadata_checked,6);assert.equal(result.startup_wave_observed,false);assert.equal(result.startup_helper_observed,false);assert.equal(result.authority,false);assert.equal(result.full_catalogue_checked,false);
 }
 assert.throws(()=>project(startupFrame(false,true),expected,{source22:startup}),'no Source22 startup without Source21 changes');
 assert.deepEqual(project(frame(true),expected),project(frame(true),expected,undefined),'default Source18–21 output remains literal');
});

test('Source22 records inverse authenticates all seven full AFTERs plus exact private helper before restoring/removing, preserving unknown facts',()=>{
 for(const active of [false,true]){
  const input=startupRecords(active),original=clone(input),result=projectStartup(input,startup);
  assert.deepEqual(result.records,startupRecords(false));assert.deepEqual(input,original);assert.equal(result.active,active);assert.equal(result.removed_functions,active?1:0);assert.equal(result.changed_functions,active?7:0);
  assert.equal(result.current_function_records_checked,active?8:7);assert.equal(result.unselected_records_checked,false);assert.equal(result.full_catalogue_checked,false);assert.equal(result.native_acceptance,false);
 }
 const input=startupRecords(true);input.at(-1).value.unknown='different current unknown';assert.deepEqual(projectStartup(input,startup).records.at(-1),input.at(-1));
});

test('Source22 rejects every current root field drift, mixed state, missing/overloaded roots and absent/wrong/overloaded helper',()=>{
 for(let i=0;i<7;i++)for(const field of Object.keys(startup.changes[i].after)){
  const input=startupRecords(true);input[i].value[field]=['drift',field];assert.throws(()=>projectStartup(input,startup),startupKeys[i]+':'+field);
 }
 for(const field of Object.keys(startup.additions[0].value)){const input=startupRecords(true);input[7].value[field]=['helper drift',field];assert.throws(()=>projectStartup(input,startup),'helper:'+field);}
 const negatives=[
  r=>r.splice(0,1),r=>r.splice(7,1),r=>r[0].value=clone(startup.changes[0].before),
  r=>r[0].key='public.pim_dictionary_valid(integer)',r=>r[0].kind='constraint',r=>r[7].kind='constraint',r=>r.push(clone(r[0])),
  r=>r.push({...clone(r[0]),key:'public.pim_dictionary_valid(integer)'}),
  r=>r[7].value.acl.push({grantor:'postgres',grantee:'dyna_app',privilege:'EXECUTE',grantable:false}),
  r=>r.push({...clone(r[7]),key:'public.'+helperName+'(integer)'}),
 ];
 for(const change of negatives){const records=startupRecords(true);change(records);assert.throws(()=>projectStartup(records,startup));}
 const unexpected=startupRecords(false);unexpected.push(clone(startup.additions[0]));assert.throws(()=>projectStartup(unexpected,startup));
 for(const name of startupKeys.map(key=>key.slice(7,key.indexOf('('))).filter(name=>roster.includes(name)))for(const field of actualFields){const input=startupFrame(true,true);input[name][field]=['wrong',field];assert.throws(()=>project(input,expected,{source22:startup}));}
 const mixed=startupFrame(true,true);mixed.pim_dictionary_valid=metadata('pim_dictionary_valid',startup.changes[0].before);assert.throws(()=>project(mixed,expected,{source22:startup}));
});

test('Source22 expectations reject observed baseline adoption, all-header/ACL edits, wrong fixed roster and non-private helper',()=>{
 for(let i=0;i<7;i++){
  const adopted=clone(startup);adopted.changes[i].before=clone(adopted.changes[i].after);adopted.changes[i].after.source+='\n-- new claimed successor';adopted.changes[i].after.definition=adopted.changes[i].before.definition.replace(adopted.changes[i].before.source,()=>adopted.changes[i].after.source);assert.throws(()=>projectStartup(startupRecords(true),adopted));
  for(const field of ['owner','cost','acl','acl_null','config']){const wrong=clone(startup);wrong.changes[i].after[field]=field==='acl'?[]:field==='config'?[]:field==='acl_null'?true:'wrong';assert.throws(()=>projectStartup(startupRecords(true),wrong));}
 }
 for(const mutate of [e=>e.changes.pop(),e=>e.changes[1]=clone(e.changes[0]),e=>e.changes[0].key='public.pim_dictionary_valid(integer)',e=>e.additions.push(clone(e.additions[0])),e=>e.additions[0].key='public.fake_helper(entries jsonb)',e=>e.additions[0].value.acl.push({grantor:'postgres',grantee:'dyna_app',privilege:'EXECUTE',grantable:false}),e=>e.additions[0].value.argument_names=null]){const wrong=clone(startup);mutate(wrong);assert.throws(()=>projectStartup(startupRecords(true),wrong));}
 const adoptedHelper=clone(startup),adoptedRecords=startupRecords(true),helper=adoptedHelper.additions[0].value,oldSource=helper.source;
 helper.source+='\n-- untrusted same-current helper';helper.definition=helper.definition.replace(oldSource,()=>helper.source);adoptedRecords[7].value=clone(helper);
 assert.throws(()=>projectStartup(adoptedRecords,adoptedHelper),'matching observed helper cannot redefine source-owned expectation');
 assert.throws(()=>project(startupFrame(true,true),expected,{source22:startup,caller_ready:true}));
});

test('Source22 retains wave/operative application ACLs, bounds records, and rejects getters/symbols without evaluating them',()=>{
 for(const key of ['public.wave_print177_valid()','public.operative_delivery_valid()']){const c=startup.changes.find(c=>c.key===key);assert(c.before.acl.some(a=>a.grantee==='dyna_app'&&a.privilege==='EXECUTE'));assert.deepEqual(c.after.acl,c.before.acl);}
 let accessed=0;for(const point of ['expected','records','value']){
  const e=clone(startup),r=startupRecords(true),object=point==='expected'?e:point==='records'?r:r[0].value,key=point==='expected'?'changes':point==='records'?'0':'source';
  Object.defineProperty(object,key,{enumerable:true,configurable:true,get(){accessed++;throw Error('getter must not execute');}});assert.throws(()=>projectStartup(r,e));assert.equal(accessed,0);
 }
 const extra=startupRecords(true);extra[0].value[Symbol('hidden')]='no';assert.throws(()=>projectStartup(extra,startup));
 const huge=startupRecords(true);huge.at(-1).value.unknown='x'.repeat(8388608);assert.throws(()=>projectStartup(huge,startup),/per-record/);
 const nullProto=startupRecords(true).map(r=>Object.assign(Object.create(null),r));assert.deepEqual(projectStartup(nullProto,startup).records,startupRecords(false));
});
