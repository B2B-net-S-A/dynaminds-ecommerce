/** Source-only successor tests: no DB, Native, business or release acceptance. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {deriveOrderSplit210OrdinaryFinancialSuccessor as derive,ORDER_SPLIT210_ORDINARY_FINANCIAL_SOURCE as pins} from '../tools/parity/order-split210-ordinary-financial-successor.mjs';
import {PACKING204_SOURCE_CONTRACT as e204} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/packing204-source-contract.mjs';
import {orderMergeDelivery209HistorySqlSpans as spans} from '../tools/parity/order-merge-delivery209-history-closure.mjs';
import {deriveOrderSplit210TriggerRoster} from '../tools/parity/order-split210-external-triggers.mjs';
const source204=readFileSync(new URL('../server/204_partial_commercial_sale_scope.sql',import.meta.url),'utf8'),source210=readFileSync(new URL('../tools/parity/order-split210-business.sql',import.meta.url),'utf8'),r=derive({source204,source210});
const sha=s=>createHash('sha256').update(s).digest('hex');
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const digest=v=>sha(JSON.stringify(canonical(v)));
const executable=s=>spans(s).map(p=>p.executable?p.text:p.text.replace(/[^\n]/g,' ')).join('');
const withoutBody=v=>Object.fromEntries(Object.entries(v).filter(([k])=>!['source','definition'].includes(k)));

test('complete24 BEFORE equals literal204 declaration AND acceptedE204.after, including all independent headers/ACL',()=>{
 assert.equal(Buffer.byteLength(source204),13279659);assert.equal(sha(source204),pins.source204_sha256);const marker='CREATE OR REPLACE FUNCTION '+pins.key+'\n',starts=[...source204.matchAll(/^CREATE OR REPLACE FUNCTION public\.ordinary181_financial_valid\(manual_basis jsonb\)\n/gm)];assert.equal(starts.length,1);const at=starts[0].index,open=source204.indexOf('AS $function$',at)+'AS $function$'.length,end=source204.indexOf('$function$;',open);
 assert.equal(source204.slice(at,at+marker.length),marker);assert.equal(r.change.before.source,source204.slice(open,end));assert.equal(r.change.before.definition,source204.slice(at,end+'$function$'.length)+'\n');
 const change=e204.changes.find(c=>c.kind==='function'&&c.key===pins.key);assert(change);assert.deepEqual(change.after,r.change.before);assert.deepEqual(change.before,r.before204);assert.equal(digest(change.after),pins.before_full24_value_sha256);assert.equal(digest({kind:'function',key:pins.key,value:change.after}),pins.before_full24_record_sha256);assert.equal(Object.keys(r.change.before).length,24);
});
test('partial204 family is the exact strictCASE original and independently equals actual Source189, not a guessed181 body',()=>{
 const source189=readFileSync(new URL('../server/189_packing_required_order_fields.sql',import.meta.url),'utf8');assert.equal(Buffer.byteLength(source189),5601904);assert.equal(sha(source189),'6f0c071852c68a40c545e3d08fbcb60578bb7b43616439f1d1e8585fb150cbc2');
 const matches=[...source189.matchAll(/^CREATE OR REPLACE FUNCTION public\.ordinary181_financial_valid\(manual_basis jsonb\)\n/gm)];assert.equal(matches.length,1);const at=matches[0].index,open=source189.indexOf('AS $function$',at)+'AS $function$'.length,end=source189.indexOf('$function$;',open);
 assert.deepEqual(Object.keys(r.families.partial204),[pins.key]);assert.equal(r.families.partial204[pins.key],source189.slice(at,end+'$function$'.length)+'\n');assert.equal(r.before204.source,source189.slice(open,end));assert.equal(Buffer.byteLength(r.before204.source),57433);assert.equal(sha(r.before204.source),'fd006bb71a55d60fcc83feb0fa2e86f4d68064660c3f48e4b44b1d6d7e4f7bc4');assert.equal(digest(r.before204),'8dcc5f0d6bddd5de66eeb947eaeb8f6e88e49c085fc1e52a2cd849e815fd5653');
 const omit=v=>Object.fromEntries(Object.entries(v).filter(([k])=>!['source','definition'].includes(k)));assert.deepEqual(omit(r.before204),omit(r.change.before));
});
test('manual169 excludes this routine from both four-entry branches and preserves the complete current204 definition',()=>{
 assert.deepEqual(Object.keys(r.families.manual169),[pins.key]);assert.equal(r.families.manual169[pins.key],r.change.before.definition);assert.notEqual(r.families.manual169[pins.key],r.families.partial204[pins.key]);assert.deepEqual(r.family_source_proofs.manual169_four_delegates,['local_invoice_frame','local_invoice_fingerprint','fa3_draft_fingerprint','b2b_invoice_fingerprint']);assert.equal(r.family_source_proofs.manual169_other_name_count,4);assert.equal(r.family_source_proofs.manual169_identity_source_sha256,pins.before_source_sha256);
 assert(Object.isFrozen(r.families.manual169));assert.throws(()=>{r.families.partial204[pins.key]='spoof';});
});
test('PIM signatures are the two closed regprocedure type-only variants; named descriptor identity is separate',()=>{
 const source170=readFileSync(new URL('../server/170_pim_dictionaries.sql',import.meta.url),'utf8');assert(source170.includes("SELECT jsonb_build_object('signature',p.oid::regprocedure::text,'definition',pg_get_functiondef(p.oid)"));
 assert.deepEqual(pins.metadata_signatures,['public.ordinary181_financial_valid(jsonb)','ordinary181_financial_valid(jsonb)']);assert.equal(r.change.key,'public.ordinary181_financial_valid(manual_basis jsonb)');assert.equal(r.change.before.arguments,'manual_basis jsonb');assert(!pins.metadata_signatures.includes(r.change.key));assert(pins.metadata_signatures.every(s=>!s.includes('manual_basis')));
});
test('all8 disjoint executable edits reverse the ENTIRE source/definition including all quoted history',()=>{
 const old=r.change.before.source;let inverse=r.change.after.source;assert.equal(r.edits.length,8);let end=-1;const code=executable(old);
 for(const edit of r.edits){assert(edit.beforeStart>=end);end=edit.beforeStart+edit.before.length;assert.equal(old.slice(edit.beforeStart,end),edit.before);assert.notEqual(code[edit.beforeStart],' ');}
 for(const edit of [...r.edits].reverse()){assert.equal(inverse.slice(edit.afterStart,edit.afterStart+edit.after.length),edit.after);inverse=inverse.slice(0,edit.afterStart)+edit.before+inverse.slice(edit.afterStart+edit.after.length);}
 assert.equal(inverse,old);assert.equal(r.change.after.definition.replace(r.change.after.source,()=>inverse),r.change.before.definition);assert.equal(r.whole_source_inverse_verified,true);
 assert.equal(Buffer.byteLength(old),57589);assert.equal(sha(old),'984dd5ab7e4a0312c55c32db348f05f272330f38eec5bf71df41d24eb04917c6');assert.equal(Buffer.byteLength(r.change.after.source),59065);assert.equal(sha(r.change.after.source),'c8ed42eaf96711e9d1068548291dc53a29d91255362eccdc40cc1dcb80b54fff');
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
 assert.deepEqual(r.projection_counts,{raw_financial_source_hash:2,statement_local_bound_classification:2,financial_table_trigger_selector:2,financial_trigger_function_membership:2});
});
test('entire later financial319 body, source/header checks, packing/migration branches and handler remain literal',()=>{
 const marker=' SELECT public.partial_sale204_predecessor_definition(p.oid) INTO STRICT financial319_definition',oldAt=r.change.before.source.indexOf(marker),nowAt=r.change.after.source.indexOf(marker);assert(oldAt>r.edits.at(-1).beforeStart&&nowAt>0);assert.equal(r.change.before.source.slice(oldAt),r.change.after.source.slice(nowAt));
 const oldCode=executable(r.change.before.source),newCode=executable(r.change.after.source);assert.equal((newCode.match(/EXCEPTION WHEN/g)||[]).length,(oldCode.match(/EXCEPTION WHEN/g)||[]).length);assert(!/CREATE\s+(?:TEMP|TABLE)|GRANT\s|ALTER\s|DROP\s/.test(executable(r.sql)));
 const beforeOwn=r.change.before.source.slice(0,r.edits[0].beforeStart);assert.equal(r.change.after.source.slice(0,r.edits[0].afterStart),beforeOwn,'every earlier buyer319 and certificate check stays exact');
});
test('source drift, getters, extra descriptors/frames and nonplain inputs fail closed without invoking supplied authority',()=>{
 assert.throws(()=>derive({source204:source204+'\n',source210}),/source|13279660/);assert.throws(()=>derive({source204,source210:source210+'\n'}),/literal frozen Native210 source/);assert.throws(()=>derive({source204,source210:source210.replace('order_split210_bound','spoof210_bound')}));
 for(const name of ['source209','before','after','schemaValid','expectedHash','frame','nativeAcceptance'])assert.throws(()=>derive({source204,source210,[name]:true}),/closed source204\/source210 inputs/);
 let invoked=false;assert.throws(()=>derive({source204,get source210(){invoked=true;return source210;}}),/source data properties/);assert.equal(invoked,false);assert.throws(()=>derive(Object.assign(Object.create({}),{source204,source210})),/plain source inputs/);assert.throws(()=>derive({source204,source210,[Symbol('hidden')]:true}));
 assert(Object.isFrozen(r)&&Object.isFrozen(r.change.before.acl)&&Object.isFrozen(r.edits[0]));assert.throws(()=>{r.change.after.source='poison';});for(const flag of ['target_metadata_adopted','assembled','source_compilation_performed','native_certification','application_activation'])assert.equal(r[flag],false);
});
