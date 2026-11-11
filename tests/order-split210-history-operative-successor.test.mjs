/** Source-only successor tests: no DB, Native, business or release acceptance. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {deriveOrderSplit210HistoryOperativeSuccessor as derive,ORDER_SPLIT210_HISTORY_OPERATIVE_SOURCE as pins} from '../tools/parity/order-split210-history-operative-successor.mjs';
import {deriveOrderMergeDelivery209WaveClosure} from '../tools/parity/order-merge-delivery209-wave-closure.mjs';
import {orderMergeDelivery209HistorySqlSpans as spans} from '../tools/parity/order-merge-delivery209-history-closure.mjs';
import {deriveOrderSplit210TriggerRoster} from '../tools/parity/order-split210-external-triggers.mjs';
const source210=readFileSync(new URL('../tools/parity/order-split210-business.sql',import.meta.url),'utf8'),r=derive({source210});
const sha=s=>createHash('sha256').update(s).digest('hex');
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const digest=v=>sha(JSON.stringify(canonical(v)));
const executable=s=>spans(s).map(p=>p.executable?p.text:p.text.replace(/[^\n]/g,' ')).join('');
const withoutBody=v=>Object.fromEntries(Object.entries(v).filter(([k])=>!['source','definition'].includes(k)));

test('complete24 BEFORE equals pinned literal209 declaration and independent literal204 own-helper derivation',()=>{
 const sql=readFileSync(new URL('../server/209_order_merge_delivery_inheritance.sql',import.meta.url),'utf8');assert.equal(Buffer.byteLength(sql),28449419);assert.equal(sha(sql),pins.source209_sha256);
 const marker='CREATE OR REPLACE FUNCTION '+pins.key+'\n',starts=[...sql.matchAll(/^CREATE OR REPLACE FUNCTION public\.order_merge_delivery209_history_operative_valid\(manual_basis jsonb\)\n/gm)];assert.equal(starts.length,1);const at=starts[0].index,open=sql.indexOf('AS $function$',at)+'AS $function$'.length,end=sql.indexOf('$function$;',open);
 assert.equal(sql.slice(at,at+marker.length),marker);assert.equal(r.change.before.source,sql.slice(open,end));assert.equal(r.change.before.definition,sql.slice(at,end+'$function$'.length)+'\n');assert(sql.slice(end).startsWith('$function$;\nREVOKE ALL ON FUNCTION public.order_merge_delivery209_history_operative_valid(jsonb) FROM PUBLIC,dyna_app;'));
 const source204=readFileSync(new URL('../server/204_partial_commercial_sale_scope.sql',import.meta.url),'utf8'),closure=deriveOrderMergeDelivery209WaveClosure({source204}),original=closure.helpers.find(v=>v.key===pins.key);assert.deepEqual(original,{kind:'function',key:pins.key,value:r.change.before});
 assert.equal(digest(r.change.before),pins.before_full24_value_sha256);assert.equal(digest(original),pins.before_full24_record_sha256);assert.equal(Object.keys(r.change.before).length,24);
});
test('all14 disjoint executable edits reverse the ENTIRE source/definition including all quoted history',()=>{
 const old=r.change.before.source;let inverse=r.change.after.source;assert.equal(r.edits.length,14);let end=-1;const code=executable(old);
 for(const edit of r.edits){assert(edit.beforeStart>=end);end=edit.beforeStart+edit.before.length;assert.equal(old.slice(edit.beforeStart,end),edit.before);assert.notEqual(code[edit.beforeStart],' ');}
 for(const edit of [...r.edits].reverse()){assert.equal(inverse.slice(edit.afterStart,edit.afterStart+edit.after.length),edit.after);inverse=inverse.slice(0,edit.afterStart)+edit.before+inverse.slice(edit.afterStart+edit.after.length);}
 assert.equal(inverse,old);assert.equal(r.change.after.definition.replace(r.change.after.source,()=>inverse),r.change.before.definition);assert.equal(r.whole_source_inverse_verified,true);
 assert.equal(Buffer.byteLength(old),74098);assert.equal(sha(old),'77829cd0bc0a36c9ed55e7bf8c16771dee116a6132410a16b37ef0d4db24a05a');assert.equal(Buffer.byteLength(r.change.after.source),75646);assert.equal(sha(r.change.after.source),'fe25f9cf360a90180caa80c7528fd9fa88ef399ea300859631828ba904b197d5');
 assert.deepEqual(withoutBody(r.change.before),withoutBody(r.change.after));assert.equal(r.change.after.volatility,'s');assert.equal(r.change.after.security_definer,true);assert.deepEqual(r.change.after.acl,[{grantor:'postgres',grantee:'postgres',privilege:'EXECUTE',grantable:false}]);
});
test('six exact executable family ports preserve arguments and reverse to the historical Source20 successor bytes',()=>{
 const ports=r.edits.filter(e=>e.kind==='partial204_family_definition');assert.equal(ports.length,6);
 assert.deepEqual(ports.map(e=>e.beforeStart),[2545,17204,28090,34784,38644,69142]);
 for(const e of ports){assert.equal(e.before,'public.partial_sale204_predecessor_definition(p.oid)');assert.equal(e.after,"public.order_split210_predecessor_definition(p.oid,'partial204')");assert.equal(executable(r.change.before.source).slice(e.beforeStart,e.beforeStart+e.before.length),e.before);}
 const now=executable(r.change.after.source);assert.equal((now.match(/public\.order_split210_predecessor_definition\(/g)||[]).length,6);assert(!now.includes('public.partial_sale204_predecessor_definition('));
 let historical=r.change.after.source;for(const e of [...ports].reverse()){assert.equal(historical.slice(e.afterStart,e.afterStart+e.after.length),e.after);historical=historical.slice(0,e.afterStart)+e.before+historical.slice(e.afterStart+e.after.length);}
 assert.equal(Buffer.byteLength(historical),75574);assert.equal(sha(historical),'c25d6c7f29e3492766ffa368b8aebc01df902ff7c2ab603debb512de7c2e2ddc','all quoted history and the original8 changes remain byteexact');
 assert.equal(r.projection_counts.partial204_family_definition,6);
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
 assert.deepEqual(r.projection_counts,{raw_financial_source_hash:2,statement_local_bound_classification:2,financial_table_trigger_selector:2,financial_trigger_function_membership:2,partial204_family_definition:6});
});
test('later financial319 body retains every source/header/NULL/packing/handler check around the exact family ports',()=>{
 const marker=' SELECT public.partial_sale204_predecessor_definition(p.oid) INTO STRICT financial319_definition',oldAt=r.change.before.source.indexOf(marker);assert(oldAt>0);
 let historical=r.change.after.source;for(const e of r.edits.filter(e=>e.kind==='partial204_family_definition').reverse())historical=historical.slice(0,e.afterStart)+e.before+historical.slice(e.afterStart+e.after.length);
 const nowAt=historical.indexOf(marker);assert(nowAt>0);assert.equal(r.change.before.source.slice(oldAt),historical.slice(nowAt));
 const oldCode=executable(r.change.before.source),newCode=executable(r.change.after.source);assert.equal((newCode.match(/EXCEPTION WHEN/g)||[]).length,(oldCode.match(/EXCEPTION WHEN/g)||[]).length);assert(!/CREATE\s+(?:TEMP|TABLE)|GRANT\s|ALTER\s|DROP\s/.test(executable(r.sql)));
 const beforeOwn=r.change.before.source.slice(0,r.edits[0].beforeStart);assert.equal(r.change.after.source.slice(0,r.edits[0].afterStart),beforeOwn,'every earlier buyer319 and certificate check stays exact');
});
test('source drift, getters, extra descriptors/frames and nonplain inputs fail closed without invoking supplied authority',()=>{
 assert.throws(()=>derive({source210:source210+'\n'}),/literal frozen Native210 source/);assert.throws(()=>derive({source210:source210.replace('order_split210_bound','spoof210_bound')}));
 for(const name of ['source209','before','after','schemaValid','expectedHash','frame','nativeAcceptance'])assert.throws(()=>derive({source210,[name]:true}),/closed source210 input/);
 let invoked=false;assert.throws(()=>derive({get source210(){invoked=true;return source210;}}),/source data property/);assert.equal(invoked,false);assert.throws(()=>derive(Object.assign(Object.create({}),{source210})),/plain source inputs/);assert.throws(()=>derive({source210,[Symbol('hidden')]:true}));
 assert(Object.isFrozen(r)&&Object.isFrozen(r.change.before.acl)&&Object.isFrozen(r.edits[0]));assert.throws(()=>{r.change.after.source='poison';});for(const flag of ['target_metadata_adopted','assembled','source_compilation_performed','native_certification','application_activation'])assert.equal(r[flag],false);
});
