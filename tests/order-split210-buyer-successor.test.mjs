/** Actual source derivation tests only. No Native/PG/business acceptance. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {deriveOrderSplit210BuyerSuccessor as derive,ORDER_SPLIT210_BUYER_SOURCE as pins} from '../tools/parity/order-split210-buyer-successor.mjs';
import {ORDER_MERGE_DELIVERY209_SOURCE_CONTRACT as e209} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/order-merge-delivery209-source-contract.mjs';
import {orderMergeDelivery209HistorySqlSpans as spans} from '../tools/parity/order-merge-delivery209-history-closure.mjs';
import {deriveOrderSplit210TriggerRoster} from '../tools/parity/order-split210-external-triggers.mjs';
const source210=readFileSync(new URL('../tools/parity/order-split210-business.sql',import.meta.url),'utf8');
const sha=s=>createHash('sha256').update(s).digest('hex');
const code=source=>spans(source).map(s=>s.executable?s.text:s.text.replace(/[^\n]/g,' ')).join('');
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const digest=v=>sha(JSON.stringify(canonical(v)));

test('entire accepted22b buyer and208 ancestor are independently pinned complete24-field descriptors',()=>{
 const r=derive({source210}),c=e209.changes.find(c=>c.key===pins.key);
 assert.equal(r.change.kind,'function');assert.equal(r.change.key,'public.buyer_address_guards()');assert.deepEqual(r.change.before,c.after);assert.deepEqual(r.before208,c.before);
 assert.equal(digest(r.change.before),'a7fcbb15ba9b5bae29886c346db8ce8e3407acf46413185b996f87b6268e28a5');assert.equal(digest(r.before208),'49c63177a92fe4bff983abf62bd0326a4d9cb47e56ba75c1fac2a6d0df893ed3');
 assert.equal(sha(r.change.before.source),'7f7a8a2a79b19b85b7f28f51b440173816b83a8146f11a4d383d9d161ed51c38');assert.equal(Buffer.byteLength(r.change.before.source),83182);
 const omit=v=>Object.fromEntries(Object.entries(v).filter(([k])=>!['source','definition'].includes(k)));assert.deepEqual(omit(r.change.before),omit(r.change.after));
 assert.equal(Object.keys(r.change.after).length,24);assert.deepEqual(r.change.after.acl,[{grantable:false,grantee:'postgres',grantor:'postgres',privilege:'EXECUTE'}]);
});
test('eight disjoint executable edits reverse WHOLE source and definition to literal accepted209, including every quoted historical body',()=>{
 const r=derive(),before=r.change.before.source;let reversed=r.change.after.source;
 assert.equal(r.edits.length,8);let previous=-1;const originalCode=code(before);
 for(const edit of r.edits){assert(edit.beforeStart>previous);previous=edit.beforeStart;assert.equal(before.slice(edit.beforeStart,edit.beforeStart+edit.before.length),edit.before);assert.notEqual(originalCode[edit.beforeStart],' ');}
 for(const edit of [...r.edits].reverse()){assert.equal(reversed.slice(edit.afterStart,edit.afterStart+edit.after.length),edit.after);reversed=reversed.slice(0,edit.afterStart)+edit.before+reversed.slice(edit.afterStart+edit.after.length);}
 assert.equal(reversed,before);assert.equal(r.whole_source_inverse_verified,true);
 assert.equal(r.change.after.definition.replace(r.change.after.source,()=>before),r.change.before.definition);
 const shared=r.edits.find(e=>e.kind==='statement_local_bound_classification');assert(shared);
 const literals=s=>spans(s).filter(s=>!s.executable).map(s=>s.text);const old=literals(before),now=literals(r.change.after.source.replace(shared.after,shared.before));
 // The only added quoted token names the projected descriptor's source field.
 const added=now.findIndex((s,i)=>s!==old[i]);assert.equal(now[added],"'source'");now.splice(added,1);assert.deepEqual(now,old);
 assert(!/CREATE\s+(?:TEMP|TABLE)|GRANT\s|ALTER\s|DROP\s/i.test(code(r.sql)),'only one replacement function declaration, no privileges/schema mutation');
});
test('actual failed three-family hash predicate retains exactexpected family IDs/hashes and fail-closed comparison; current source now goes through strict210 port',()=>{
 const r=derive(),edit=r.edits.find(e=>e.kind==='raw_three_family_hash');assert(edit);
 assert(edit.before.includes("encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') IS DISTINCT FROM expected.body_sha"));
 assert(edit.after.includes("encode(sha256(convert_to(public.order_split210_try_function_projection(p.oid)->>'source','UTF8')),'hex') IS DISTINCT FROM expected.body_sha"));
 assert(edit.after.startsWith('WHERE p.oid IS NULL OR '));assert(edit.after.endsWith('THEN RETURN false;END IF;'));
 for(const hash of ['98e864adebce59dc7da7f1e46cecddcf5028bc1de05db5dea1e0d0800ca56a30','b3dff2ee8934549828eb4c029298375802022e618d42027b57f3dea3ea4f57d3','9e3766d47014f65190e470b4aa4ac70d54bc96ce094493408480a41026564a0b'])assert(r.change.after.source.includes(hash));
 const masked=code(r.change.after.source);assert.equal((masked.match(/public\.order_split210_try_function_projection\(/g)||[]).length,1);
 assert.equal((code(r.change.before.source).match(/RETURN false/g)||[]).length,(masked.match(/RETURN false/g)||[]).length,'every inherited refusal remains');
});
test('allthree financial families share statement-local verified OIDs for BOTH selectors, with source-derived2/2/5 classification bounds',()=>{
 const r=derive({source210}),table=r.edits.filter(e=>e.kind==='financial_table_trigger_selector'),membership=r.edits.filter(e=>e.kind==='financial_trigger_function_membership');assert.equal(table.length,3);assert.equal(membership.length,3);
 const start=r.change.before.source.indexOf(" FOREACH family214 IN ARRAY ARRAY['158','159','160'] LOOP"),end=r.change.before.source.indexOf('\n END LOOP;',start);
 for(const edit of [...table,...membership]){assert(edit.beforeStart>start&&edit.beforeStart<end);assert.equal(edit.after,edit.before+' AND NOT EXISTS(SELECT FROM split210_bound_verified verified WHERE verified.oid=tr.oid)');}
 const roster=deriveOrderSplit210TriggerRoster({source210});assert.equal(roster.groups.external_bound.length,12);assert(roster.groups.external_bound.includes('public.orders.order_split210_bound'));assert(roster.groups.external_bound.includes('public.order_items.order_split210_bound'));
 for(const edit of [...table,...membership])assert(!/LIKE|starts_with|tgname/.test(edit.after.slice(edit.before.length)),'selectors do not hide names/prefixes');
 const cte=r.edits.find(e=>e.kind==='statement_local_bound_classification');assert(cte&&cte.beforeStart>start&&cte.beforeStart<end);assert.equal(cte.before,'SELECT CASE family214');
 assert.equal((cte.after.match(/AS MATERIALIZED\(/g)||[]).length,2);assert(cte.after.includes('SELECT oid FROM split210_bound_candidates WHERE public.order_split210_is_added_trigger(oid)'));
 assert(cte.after.includes('declared.family_code=family214 AND declared.table_name=rel.relname AND declared.trigger_name=t.tgname'));
 assert.equal((code(r.change.after.source).match(/order_split210_is_added_trigger\(/g)||[]).length,1,'only verified CTE invokes strict unchanged full210 helper');
 assert.equal((code(r.change.after.source).match(/NOT EXISTS\(SELECT FROM split210_bound_verified verified WHERE verified\.oid=tr\.oid\)/g)||[]).length,6);
 assert.deepEqual(r.statement_local_bound_targets,[
  {family:'158',table_targets:['order_items','orders'],function_targets:['order_items','orders'],targets:['order_items','orders']},
  {family:'159',table_targets:['order_items','orders'],function_targets:['order_items','orders'],targets:['order_items','orders']},
  {family:'160',table_targets:['order_items','orders','stock_location_movements','stock_movements','wms_layer_movements'],function_targets:['order_items','orders'],targets:['order_items','orders','stock_location_movements','stock_movements','wms_layer_movements']},
 ]);
 assert.deepEqual(r.strict_bound_classifications,{per_family:[2,2,5],three_statement_total:9,maximum_per_statement:5,cross_statement_cache:false});
 const used=new Set(r.statement_local_bound_targets.flatMap(g=>g.targets)),unselected=roster.groups.external_bound.map(k=>k.split('.')[1]).filter(t=>!used.has(t));assert.equal(unselected.length,7);
 for(const table of unselected)assert(!cte.after.includes("'"+table+"'"),'cannot classify or hide unrelated bound table '+table);
 assert(!/set_config|current_setting|CREATE|INSERT|UPDATE|DELETE|\bEXECUTE\b/i.test(code(cte.after)),'no stored state, GUC, helper cloning or dispatch');
});
test('selfbuyer rawcurrentbody and rawcurrentdefinition stay on same side; guarded literal166 normalization is byte-exact',()=>{
 const r=derive(),old=r.change.before.source,now=r.change.after.source;
 const raw="SELECT prosrc INTO STRICT buyer_source251 FROM pg_proc WHERE oid='public.buyer_address_guards()'::regprocedure;";
 assert(old.includes(raw)&&now.includes(raw));
 const a=old.indexOf(raw),section=old.slice(a);assert.equal(now.slice(now.indexOf(raw)),section,'entire self-normalization and final seal/ledger/basis tail remains literal');
 assert(!code(section).includes('order_split210_'));
 assert(!r.edits.some(e=>e.beforeStart>=a));assert(!/order_split210_try_metadata_projection\(buyer_meta251\)/.test(now));
});
test('authoredsource drift, caller descriptor/verdict injection and getters are refused; default performs same pinned derivation without filesystem inputs',()=>{
 const r=derive();assert.deepEqual(r.change,derive({source210}).change);
 assert.throws(()=>derive({source210:source210+'\n'}),/literal frozen Native210 source/);
 for(const key of ['before','parent','descriptor','schemaValid','nativeAcceptance','frame'])assert.throws(()=>derive({[key]:true}),/closed source-only/);
 let invoked=false;const options={};Object.defineProperty(options,'source210',{enumerable:true,get(){invoked=true;return source210;}});assert.throws(()=>derive(options),/data property/);assert.equal(invoked,false);
 assert(Object.isFrozen(r.change.after)&&Object.isFrozen(r.edits[0]));assert.throws(()=>{r.change.after.source='poison';});
 assert.equal(r.assembled,false);assert.equal(r.source_compilation_performed,false);assert.equal(r.native_certification,false);assert.equal(r.application_activation,false);assert.equal(r.target_metadata_adopted,false);
 assert.equal(r.source_proofs.later_trigger_path_native_verified,false);
});
