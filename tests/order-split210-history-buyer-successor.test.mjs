/** Source-only successor tests: no DB, Native, business or release acceptance. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {deriveOrderSplit210HistoryBuyerSuccessor as derive,ORDER_SPLIT210_HISTORY_BUYER_SOURCE as pins,ORDER_SPLIT210_HISTORY_BUYER_SOURCE20 as historical20} from '../tools/parity/order-split210-history-buyer-successor.mjs';
import {deriveOrderMergeDelivery209BuyerClosure} from '../tools/parity/order-merge-delivery209-buyer-closure.mjs';
import {orderMergeDelivery209HistorySqlSpans as spans} from '../tools/parity/order-merge-delivery209-history-closure.mjs';
import {deriveOrderSplit210TriggerRoster} from '../tools/parity/order-split210-external-triggers.mjs';
import {ORDER_MERGE_DELIVERY209_SOURCE_CONTRACT as accepted209} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/order-merge-delivery209-source-contract.mjs';
const source210=readFileSync(new URL('../tools/parity/order-split210-business.sql',import.meta.url),'utf8'),r=derive({source210});
const sha=s=>createHash('sha256').update(s).digest('hex');
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const digest=v=>sha(JSON.stringify(canonical(v)));
const executable=s=>spans(s).map(p=>p.executable?p.text:p.text.replace(/[^\n]/g,' ')).join('');
const withoutBody=v=>Object.fromEntries(Object.entries(v).filter(([k])=>!['source','definition'].includes(k)));

test('complete24 BEFORE equals pinned literal209 declaration and independent literal204 own-helper derivation',()=>{
 const sql=readFileSync(new URL('../server/209_order_merge_delivery_inheritance.sql',import.meta.url),'utf8');assert.equal(Buffer.byteLength(sql),28449419);assert.equal(sha(sql),pins.source209_sha256);
 const marker='CREATE OR REPLACE FUNCTION '+pins.key+'\n',starts=[...sql.matchAll(/^CREATE OR REPLACE FUNCTION public\.order_merge_delivery209_buyer_guards\(manual_basis jsonb\)\n/gm)];assert.equal(starts.length,1);const at=starts[0].index,open=sql.indexOf('AS $function$',at)+'AS $function$'.length,end=sql.indexOf('$function$;',open);
 assert.equal(sql.slice(at,at+marker.length),marker);assert.equal(r.change.before.source,sql.slice(open,end));assert.equal(r.change.before.definition,sql.slice(at,end+'$function$'.length)+'\n');assert(sql.slice(end).startsWith('$function$;\nREVOKE ALL ON FUNCTION public.order_merge_delivery209_buyer_guards(jsonb) FROM PUBLIC,dyna_app;'));
 const source204=readFileSync(new URL('../server/204_partial_commercial_sale_scope.sql',import.meta.url),'utf8'),source181=readFileSync(new URL('../server/181_same_root_guard_observations.sql',import.meta.url),'utf8'),closure=deriveOrderMergeDelivery209BuyerClosure({source204,source181}),original=closure.helpers.find(v=>v.key===pins.key);assert.deepEqual(original,{kind:'function',key:pins.key,value:r.change.before});
 assert.deepEqual(accepted209.additions.find(v=>v.kind==='function'&&v.key===pins.key),{kind:'function',key:pins.key,value:r.change.before},'independently acceptedE209 entire24-field source record');
 assert.equal(digest(r.change.before),pins.before_full24_value_sha256);assert.equal(digest(original),pins.before_full24_record_sha256);assert.equal(Object.keys(r.change.before).length,24);
});
test('all14 disjoint executable edits reverse the ENTIRE source/definition including all quoted history',()=>{
 const old=r.change.before.source;let inverse=r.change.after.source;assert.equal(r.edits.length,14);let end=-1;const code=executable(old);
 for(const edit of r.edits){assert(edit.beforeStart>=end);end=edit.beforeStart+edit.before.length;assert.equal(old.slice(edit.beforeStart,end),edit.before);assert.notEqual(code[edit.beforeStart],' ');}
 for(const edit of [...r.edits].reverse()){assert.equal(inverse.slice(edit.afterStart,edit.afterStart+edit.after.length),edit.after);inverse=inverse.slice(0,edit.afterStart)+edit.before+inverse.slice(edit.afterStart+edit.after.length);}
 assert.equal(inverse,old);assert.equal(r.change.after.definition.replace(r.change.after.source,()=>inverse),r.change.before.definition);assert.equal(r.whole_source_inverse_verified,true);
 assert.equal(Buffer.byteLength(old),72954);assert.equal(sha(old),'e5d3649746d3bc755b4b5b6424015f81ad1a170f014a5f4268405a5331e7d9fd');assert.equal(Buffer.byteLength(r.change.after.source),74502);assert.equal(sha(r.change.after.source),'7251b24b8a72c5b1a87542858cb6f238ed1b64fe93983ac198108dfc99028617');
 assert.deepEqual(withoutBody(r.change.before),withoutBody(r.change.after));assert.equal(r.change.after.volatility,'s');assert.equal(r.change.after.security_definer,true);assert.deepEqual(r.change.after.acl,[{grantor:'postgres',grantee:'postgres',privilege:'EXECUTE',grantable:false}]);
});
test('both original raw hashes use strict existing209 source port with no frame while exact expected hashes/NULL refusals stay literal',()=>{
 const edits=r.edits.filter(e=>e.kind==='raw_financial_source_hash');assert.equal(edits.length,2);
 for(const [i,key]of ['public.fa3_draft_fingerprint()','public.b2b_invoice_fingerprint()'].entries()){
  const edit=edits[i];assert.equal(edit.before,"encode(sha256(convert_to((SELECT prosrc FROM pg_proc WHERE oid='"+key+"'::regprocedure),'UTF8')),'hex')");assert.equal(edit.after,"public.order_merge_delivery209_predecessor_source_sha('"+key+"'::regprocedure,NULL::jsonb)");
  const old=r.change.before.source.slice(edit.beforeStart+edit.before.length, r.change.before.source.indexOf('\n',edit.beforeStart)),now=r.change.after.source.slice(edit.afterStart+edit.after.length,r.change.after.source.indexOf('\n',edit.afterStart));assert.equal(now,old);assert(old.endsWith('THEN RETURN false;END IF;'));assert.equal(r.change.after.source.slice(edit.afterStart-4,edit.afterStart),' IF ');
 }
 assert.equal((executable(r.change.after.source).match(/order_merge_delivery209_predecessor_source_sha\(/g)||[]).length,2);
 // The closed nonlegacy entry point freshly authenticates the whole current
 // descriptor. This test deliberately does not claim executable PG proof.
 assert.equal((executable(r.change.after.source).match(/RETURN false/g)||[]).length,(executable(r.change.before.source).match(/RETURN false/g)||[]).length);
});
test('one closed statement-local CTE shape is installed twice with2+2 independent classifications, not a cross-statement verdict cache',()=>{
 const ctes=r.edits.filter(e=>e.kind==='statement_local_bound_classification');assert.equal(ctes.length,2);assert.equal(ctes[0].after,ctes[1].after);
 for(const cte of ctes){assert.equal(cte.before,'SELECT jsonb_build_object(');assert.equal((cte.after.match(/AS MATERIALIZED\(/g)||[]).length,2);assert(cte.after.includes("JOIN(VALUES ('order_items','order_split210_bound'),('orders','order_split210_bound')) declared(table_name,trigger_name)"));assert(cte.after.includes('declared.table_name=rel.relname AND declared.trigger_name=t.tgname'));assert(cte.after.includes('SELECT oid FROM split210_bound_candidates WHERE public.order_split210_is_added_trigger(oid)'));assert(!/set_config|current_setting|INSERT|UPDATE|DELETE|EXECUTE|CREATE/i.test(executable(cte.after)));}
 const roster=deriveOrderSplit210TriggerRoster({source210});for(const key of roster.groups.external_bound){const table=key.split('.')[1];if(!['orders','order_items'].includes(table))assert(!ctes[0].after.includes("'"+table+"'"),'unrelated bound table is not classified');}
 assert.deepEqual(r.statement_local_bound_targets,[{family:'158',table_targets:['order_items','orders'],function_targets:['order_items','orders'],targets:['order_items','orders']},{family:'159',table_targets:['order_items','orders'],function_targets:['order_items','orders'],targets:['order_items','orders']}]);
 assert.deepEqual(r.strict_bound_classifications,{per_statement:[2,2],two_statement_total:4,maximum_per_statement:2,cross_statement_cache:false});
 const between=r.change.before.source.slice(ctes[0].beforeStart,ctes[1].beforeStart);assert(between.includes("'{fingerprints,158}'"));assert(between.includes("'public.b2b_invoice_fingerprint()'::regprocedure"));assert(between.includes('IF financial214 IS NULL OR '));assert(!r.change.after.source.slice(0,r.edits[0].afterStart).includes('split210_bound_'));
});
test('all4 source selectors exclude only verified exact OIDs; schema/name/NULL table/function predicates remain',()=>{
 const selectors=r.edits.filter(e=>['financial_table_trigger_selector','financial_trigger_function_membership'].includes(e.kind));assert.equal(selectors.length,4);
 for(const edit of selectors){assert.equal(edit.after,edit.before+' AND NOT EXISTS(SELECT FROM split210_bound_verified verified WHERE verified.oid=tr.oid)');assert(!/tgname|LIKE|starts_with|prefix/.test(edit.after.slice(edit.before.length)));assert(edit.before.endsWith('AND NOT tr.tgisinternal'));}
 assert.equal((executable(r.change.after.source).match(/NOT EXISTS\(SELECT FROM split210_bound_verified verified WHERE verified\.oid=tr\.oid\)/g)||[]).length,4);
 assert.deepEqual(r.projection_counts,{raw_financial_source_hash:2,statement_local_bound_classification:2,financial_table_trigger_selector:2,financial_trigger_function_membership:2,partial204_predecessor_definition_port:6});
});
test('entire later financial319 body stays literal after undoing only its explicit scoped-definition ports',()=>{
 const oldMarker=' SELECT public.partial_sale204_predecessor_definition(p.oid) INTO STRICT financial319_definition',newMarker=" SELECT public.order_split210_predecessor_definition(p.oid,'partial204') INTO STRICT financial319_definition";
 const oldAt=r.change.before.source.indexOf(oldMarker),nowAt=r.change.after.source.indexOf(newMarker);assert(oldAt>0&&nowAt>0);
 let tail=r.change.after.source.slice(nowAt);for(const e of [...r.edits].reverse().filter(e=>e.beforeStart>=oldAt)){assert.equal(e.kind,'partial204_predecessor_definition_port');const at=e.afterStart-nowAt;assert.equal(tail.slice(at,at+e.after.length),e.after);tail=tail.slice(0,at)+e.before+tail.slice(at+e.after.length);}assert.equal(tail,r.change.before.source.slice(oldAt));
 const oldCode=executable(r.change.before.source),newCode=executable(r.change.after.source);assert.equal((newCode.match(/EXCEPTION WHEN/g)||[]).length,(oldCode.match(/EXCEPTION WHEN/g)||[]).length);assert(!/CREATE\s+(?:TEMP|TABLE)|GRANT\s|ALTER\s|DROP\s/.test(executable(r.sql)));
 const beforeOwn=r.change.before.source.slice(0,r.edits[0].beforeStart);assert.equal(r.change.after.source.slice(0,r.edits[0].afterStart),beforeOwn,'every earlier buyer/packing and certificate check stays exact');
});
test('source drift, getters, extra descriptors/frames and nonplain inputs fail closed without invoking supplied authority',()=>{
 assert.throws(()=>derive({source210:source210+'\n'}),/literal frozen Native210 source/);assert.throws(()=>derive({source210:source210.replace('order_split210_bound','spoof210_bound')}));
 for(const name of ['source209','before','after','schemaValid','expectedHash','frame','nativeAcceptance'])assert.throws(()=>derive({source210,[name]:true}),/closed source210 input/);
 let invoked=false;assert.throws(()=>derive({get source210(){invoked=true;return source210;}}),/source data property/);assert.equal(invoked,false);assert.throws(()=>derive(Object.assign(Object.create({}),{source210})),/plain source inputs/);assert.throws(()=>derive({source210,[Symbol('hidden')]:true}));
 assert(Object.isFrozen(r)&&Object.isFrozen(r.change.before.acl)&&Object.isFrozen(r.edits[0]));assert.throws(()=>{r.change.after.source='poison';});for(const flag of ['target_metadata_adopted','assembled','source_compilation_performed','native_certification','application_activation'])assert.equal(r[flag],false);
});

test('six executable definition ports retain exact arguments, source selection and quoted historical DATA',()=>{
 const ports=r.edits.filter(e=>e.kind==='partial204_predecessor_definition_port');assert.equal(ports.length,6);
 const args=["'public.buyer_address_guards()'::regprocedure",'p.oid','p.oid','p.oid','p.oid','p.oid'];
 for(const [i,e]of ports.entries()){
  assert.equal(e.before,'public.partial_sale204_predecessor_definition('+args[i]+')');
  assert.equal(e.after,"public.order_split210_predecessor_definition("+args[i]+",'partial204')");
  assert.equal(r.change.before.source.slice(e.beforeStart,e.beforeStart+e.before.length),e.before);
  assert.equal(r.change.after.source.slice(e.afterStart,e.afterStart+e.after.length),e.after);
 }
 assert.equal((executable(r.change.before.source).match(/\bpublic\.partial_sale204_predecessor_definition\(/g)||[]).length,6);
 assert.equal((executable(r.change.after.source).match(/\bpublic\.partial_sale204_predecessor_definition\(/g)||[]).length,0);
 assert.equal((executable(r.change.after.source).match(/\bpublic\.order_split210_predecessor_definition\(/g)||[]).length,6);
 const historical=s=>spans(s).filter(v=>!v.executable&&v.text.length>200).map(v=>v.text);
 assert.deepEqual(historical(r.change.after.source),historical(r.change.before.source));
});
test('undoing ONLY six new ports reconstructs the entire immutable historical Source20 eight-edit output',()=>{
 let old=r.change.after.source;for(const e of [...r.edits].reverse().filter(e=>e.kind==='partial204_predecessor_definition_port')){
  const at=old.indexOf(e.after);assert(at>=0,'one current scoped call');
  // The first call is unique; the five p.oid calls share text. Process original
  // source positions after accounting for already reverted later ports.
  assert.equal(old.slice(e.afterStart,e.afterStart+e.after.length),e.after);
  old=old.slice(0,e.afterStart)+e.before+old.slice(e.afterStart+e.after.length);
 }
 const value={...r.change.after,source:old,definition:r.change.after.definition.replace(r.change.after.source,()=>old)};
 assert.equal(Buffer.byteLength(old),historical20.source_bytes);assert.equal(sha(old),historical20.source_sha256);
 assert.equal(sha(value.definition),historical20.definition_sha256);assert.equal(digest(value),historical20.full24_value_sha256);
 assert.equal(digest({kind:'function',key:r.change.key,value}),historical20.full24_record_sha256);assert(Object.isFrozen(historical20));
 assert.notEqual(sha(old),r.source_after_sha256);assert.equal(r.native_certification,false);
});
