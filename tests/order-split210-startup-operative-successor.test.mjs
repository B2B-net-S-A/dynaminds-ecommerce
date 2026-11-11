/** Pure source derivation only. No PG, Native, business or release acceptance. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {deriveOrderSplit210StartupOperativeSuccessor as derive,ORDER_SPLIT210_STARTUP_OPERATIVE_SOURCE as pins} from '../tools/parity/order-split210-startup-operative-successor.mjs';
import {ORDER_MERGE_DELIVERY209_SOURCE_CONTRACT as e209,ORDER_MERGE_DELIVERY209_SOURCE_ORIGIN as origin} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/order-merge-delivery209-source-contract.mjs';
import {orderMergeDelivery209HistorySqlSpans as spans} from '../tools/parity/order-merge-delivery209-history-closure.mjs';
import {deriveOrderSplit210TriggerRoster} from '../tools/parity/order-split210-external-triggers.mjs';
const source210=readFileSync(new URL('../tools/parity/order-split210-business.sql',import.meta.url),'utf8'),r=derive({source210});
const sha=s=>createHash('sha256').update(s).digest('hex');
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const digest=v=>sha(JSON.stringify(canonical(v)));
const executable=s=>spans(s).map(p=>p.executable?p.text:p.text.replace(/[^\n]/g,' ')).join('');
const head=v=>Object.fromEntries(Object.entries(v).filter(([k])=>!['source','definition'].includes(k)));

test('entire24 BEFORE is exact literal209 declaration AND acceptedE209 addition, including all headers and owner-only ACL',()=>{
 const sql=readFileSync(new URL('../server/209_order_merge_delivery_inheritance.sql',import.meta.url),'utf8');assert.equal(Buffer.byteLength(sql),28449419);assert.equal(sha(sql),pins.source209_sha256);
 const starts=[...sql.matchAll(/^CREATE OR REPLACE FUNCTION public\.order_merge_delivery209_startup_operative_valid\(entries jsonb\)\n/gm)];assert.equal(starts.length,1);const at=starts[0].index,open=sql.indexOf('AS $function$',at)+'AS $function$'.length,end=sql.indexOf('$function$;',open);
 assert.equal(r.change.before.source,sql.slice(open,end));assert.equal(r.change.before.definition,sql.slice(at,end+'$function$'.length)+'\n');assert(sql.slice(end).startsWith('$function$;\nREVOKE ALL ON FUNCTION public.order_merge_delivery209_startup_operative_valid(jsonb) FROM PUBLIC,dyna_app;'));
 assert.equal(origin.decoded_sha256,'121abfe5df79f03f9d3acd38e566bbcf53c18ec0b4bf418c316632138cd37070');const record=e209.additions.find(v=>v.kind==='function'&&v.key===pins.key);assert(record);assert.deepEqual(record.value,r.change.before);
 assert.equal(digest(record),'f5082d2bae4acef908387ed1b425a490738d64cd78cc7490d4a2157abe0a7e24');assert.equal(digest(r.change.before),'53bbd21fed89d2e45d439e58fff05cf5f721be878a2128ca6af25503f28b2871');assert.equal(Object.keys(r.change.before).length,24);
});
test('16 disjoint executable edits reverse the whole85671 body and definition; every unchanged historical literal/header/ACL is preserved',()=>{
 const old=r.change.before.source,code=executable(old);let reversed=r.change.after.source,end=-1;assert.equal(r.edits.length,16);
 for(const e of r.edits){assert(e.beforeStart>=end);end=e.beforeStart+e.before.length;assert.equal(old.slice(e.beforeStart,end),e.before);assert.notEqual(code[e.beforeStart],' ');}
 for(const e of [...r.edits].reverse()){assert.equal(reversed.slice(e.afterStart,e.afterStart+e.after.length),e.after);reversed=reversed.slice(0,e.afterStart)+e.before+reversed.slice(e.afterStart+e.after.length);}
 assert.equal(reversed,old);assert.equal(r.change.after.definition.replace(r.change.after.source,()=>reversed),r.change.before.definition);assert.equal(r.whole_source_inverse_verified,true);
 assert.equal(Buffer.byteLength(old),85671);assert.equal(sha(old),'1f95703d74fd4a8c3233e819396eac9f1d3c34037dc0db3cc82b55d3cad66551');assert.equal(Buffer.byteLength(r.change.after.source),87278);assert.equal(sha(r.change.after.source),'bfada7b6a08b85aa8c6aebd539c53491886922c57c688604366561d40fc317b7');
 assert.deepEqual(head(r.change.before),head(r.change.after));assert.equal(r.change.after.volatility,'s');assert.equal(r.change.after.arguments,'entries jsonb');assert.deepEqual(r.change.after.config,['search_path=pg_catalog, public','TimeZone=UTC']);assert.equal(r.change.after.acl_null,false);assert.deepEqual(r.change.after.acl,[{grantor:'postgres',grantee:'postgres',privilege:'EXECUTE',grantable:false}]);
});
test('ONE rawhash selector still covers all3 fixed family IDs/hashes and LEFT JOIN/NULL refusal, using fresh210-layered209 SHA port without caller frame',()=>{
 const edits=r.edits.filter(e=>e.kind==='raw_three_family_hash');assert.equal(edits.length,1);const e=edits[0];
 assert.equal(e.before,"WHERE p.oid IS NULL OR encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') IS DISTINCT FROM expected.body_sha) THEN RETURN false;END IF;");assert.equal(e.after,'WHERE p.oid IS NULL OR public.order_merge_delivery209_predecessor_source_sha(p.oid,NULL::jsonb) IS DISTINCT FROM expected.body_sha) THEN RETURN false;END IF;');
 const a=r.change.before.source.indexOf(' IF EXISTS(SELECT FROM (VALUES'),originalPrefix=r.change.before.source.slice(a,e.beforeStart);assert.equal(r.change.after.source.slice(a,e.afterStart),originalPrefix);assert(originalPrefix.trimEnd().endsWith('LEFT JOIN pg_proc p ON p.oid=to_regprocedure(expected.identity)'));
 for(const [family,key,hash]of [['158','public.fa3_draft_fingerprint()','98e864adebce59dc7da7f1e46cecddcf5028bc1de05db5dea1e0d0800ca56a30'],['159','public.b2b_invoice_fingerprint()','b3dff2ee8934549828eb4c029298375802022e618d42027b57f3dea3ea4f57d3'],['160','public.b2b_credit_fingerprint()','9e3766d47014f65190e470b4aa4ac70d54bc96ce094493408480a41026564a0b']])assert(originalPrefix.includes("('"+family+"','"+key+"','"+hash+"')"));
 assert.equal((executable(r.change.after.source).match(/order_merge_delivery209_predecessor_source_sha\(/g)||[]).length,1);assert.equal((executable(r.change.after.source).match(/RETURN false/g)||[]).length,(executable(r.change.before.source).match(/RETURN false/g)||[]).length);
});
test('one MATERIALIZED classification shape in actual3-family loop binds2/2/5 targets, each selector shares verified OIDs within that statement only',()=>{
 const ctes=r.edits.filter(e=>e.kind==='statement_local_bound_classification');assert.equal(ctes.length,1);const cte=ctes[0];assert.equal(cte.before,'SELECT CASE family214');assert.equal((cte.after.match(/AS MATERIALIZED\(/g)||[]).length,2);assert(cte.after.includes('declared.family_code=family214 AND declared.table_name=rel.relname AND declared.trigger_name=t.tgname'));assert(cte.after.includes('SELECT oid FROM split210_bound_candidates WHERE public.order_split210_is_added_trigger(oid)'));
 const expected=[{family:'158',table_targets:['order_items','orders'],function_targets:['order_items','orders'],targets:['order_items','orders']},{family:'159',table_targets:['order_items','orders'],function_targets:['order_items','orders'],targets:['order_items','orders']},{family:'160',table_targets:['order_items','orders','stock_location_movements','stock_movements','wms_layer_movements'],function_targets:['order_items','orders'],targets:['order_items','orders','stock_location_movements','stock_movements','wms_layer_movements']}];assert.deepEqual(r.statement_local_bound_targets,expected);assert.deepEqual(r.strict_bound_classifications,{per_family:[2,2,5],three_statement_total:9,maximum_per_statement:5,cross_statement_cache:false});
 const values=[...cte.after.matchAll(/\('(158|159|160)','([a-z_]+)','order_split210_bound'\)/g)].map(m=>[m[1],m[2]]);assert.deepEqual(values,expected.flatMap(g=>g.targets.map(t=>[g.family,t])));assert.equal(values.length,9);const allowed=new Set(expected.flatMap(g=>g.targets));for(const key of deriveOrderSplit210TriggerRoster({source210}).groups.external_bound){const table=key.split('.')[1];if(!allowed.has(table))assert(!cte.after.includes("'"+table+"'"));}
 const start=r.change.before.source.indexOf(" FOREACH family214 IN ARRAY ARRAY['158','159','160'] LOOP"),end=r.change.before.source.indexOf('\n END LOOP;',start);assert(cte.beforeStart>start&&cte.beforeStart<end);for(const e of r.edits.filter(e=>!['raw_three_family_hash','partial204_definition_port'].includes(e.kind)))assert(e.beforeStart>start&&e.beforeStart<end);
 assert(!/set_config|current_setting|INSERT|UPDATE|DELETE|EXECUTE|CREATE/i.test(executable(cte.after)),'no persisted/GUC/cache verdict or side effects');
});
test('6 selector exclusions bind only exact verified OIDs and retain NOT-internal plus full table/function membership predicates',()=>{
 const table=r.edits.filter(e=>e.kind==='financial_table_trigger_selector'),membership=r.edits.filter(e=>e.kind==='financial_trigger_function_membership');assert.equal(table.length,3);assert.equal(membership.length,3);
 for(const e of [...table,...membership]){assert.equal(e.after,e.before+' AND NOT EXISTS(SELECT FROM split210_bound_verified verified WHERE verified.oid=tr.oid)');assert(e.before.endsWith('AND NOT tr.tgisinternal'));assert(!/tgname|LIKE|starts_with/.test(e.after.slice(e.before.length)),'no name-only hiding');}
 assert.equal((executable(r.change.after.source).match(/NOT EXISTS\(SELECT FROM split210_bound_verified verified WHERE verified\.oid=tr\.oid\)/g)||[]).length,6);assert.deepEqual(r.projection_counts,{raw_three_family_hash:1,statement_local_bound_classification:1,financial_table_trigger_selector:3,financial_trigger_function_membership:3,partial204_definition_port:8});
});
test('entire source219 financialside and later buyer/self/certificate checks remain literal except exact family-port expressions, with no new SQL side effects',()=>{
 let prior=r.change.after.source;for(const e of [...r.edits].reverse())if(e.kind==='partial204_definition_port'){assert.equal(prior.slice(e.afterStart,e.afterStart+e.after.length),e.after);prior=prior.slice(0,e.afterStart)+e.before+prior.slice(e.afterStart+e.after.length);}
 const marker=' -- Exact current219 financial guard descriptor, not a stored fingerprint substitution.',a=r.change.before.source.indexOf(marker),b=prior.indexOf(marker);assert(a>r.edits.filter(e=>e.kind!=='partial204_definition_port').at(-1).beforeStart&&b>0);assert.equal(r.change.before.source.slice(a),prior.slice(b));
 const old=executable(r.change.before.source),now=executable(r.change.after.source);assert.equal((now.match(/EXCEPTION WHEN/g)||[]).length,(old.match(/EXCEPTION WHEN/g)||[]).length);assert.equal(r.change.after.source.slice(0,r.edits[0].afterStart),r.change.before.source.slice(0,r.edits[0].beforeStart));assert(!/CREATE\s+(?:TEMP|TABLE)|GRANT\s|ALTER\s|DROP\s/.test(executable(r.sql)));
});
test('eight whole executable partial204 calls preserve exact arguments and source20 inverse; historical strings and every refusal stay literal',()=>{
 const ports=r.edits.filter(e=>e.kind==='partial204_definition_port');assert.equal(ports.length,8);
 const expressions=new Map([["p.oid",4],["'public.financial_return_upgrade_valid()'::regprocedure",2],["'public.buyer_address_guards()'::regprocedure",2]]);
 for(const [arg,n]of expressions){const rows=ports.filter(e=>e.before==='public.partial_sale204_predecessor_definition('+arg+')');assert.equal(rows.length,n);for(const e of rows)assert.equal(e.after,"public.order_split210_predecessor_definition("+arg+",'partial204')");}
 assert.equal((executable(r.change.before.source).match(/public\.partial_sale204_predecessor_definition\(/g)||[]).length,8);
 assert.equal((executable(r.change.after.source).match(/public\.partial_sale204_predecessor_definition\(/g)||[]).length,0);
 assert.equal((executable(r.change.after.source).match(/public\.order_split210_predecessor_definition\(/g)||[]).length,8);
 // Remove exactly the new ports while preserving all original eight Source20
 // edits. This is the genuinely captured historical candidate, not its acceptance.
 let prior=r.change.after.source;
 for(const e of [...ports].reverse()){assert.equal(prior.slice(e.afterStart,e.afterStart+e.after.length),e.after);prior=prior.slice(0,e.afterStart)+e.before+prior.slice(e.afterStart+e.after.length);}
 assert.equal(Buffer.byteLength(prior),87182);assert.equal(sha(prior),'caad4a67b91347e9157cd253bf3fcc304a4fe36a09f8befad60cc972ce0d81df');
 const quoted=s=>spans(s).filter(p=>!p.executable).map(p=>p.text);
 // The new family literals occur in executable call arguments. All previous
 // quoted tokens remain in order, without rewriting a historical SQL body.
 const original=quoted(prior),current=quoted(r.change.after.source);assert(!original.includes("'partial204'"));assert.equal(current.filter(t=>t==="'partial204'").length,8);assert.deepEqual(current.filter(t=>t!=="'partial204'"),original,'every preexisting quoted token stays literal and ordered');
 assert.equal((executable(prior).match(/RETURN false/g)||[]).length,(executable(r.change.after.source).match(/RETURN false/g)||[]).length);
 assert.equal((executable(r.change.after.source).match(/EXCEPTION WHEN/g)||[]).length,(executable(prior).match(/EXCEPTION WHEN/g)||[]).length);
});

test('mutatedsource, descriptor/verdict/frame injection and getters refuse; all execution/acceptance flags stay false',()=>{
 assert.throws(()=>derive({source210:source210+'\n'}),/literal frozen Native210 source/);assert.throws(()=>derive({source210:source210.replace('order_split210_bound','fake210_bound')}));
 for(const key of ['source209','before','after','expectedHash','frame','schemaValid','nativeAcceptance'])assert.throws(()=>derive({source210,[key]:true}),/closed source210 input/);let invoked=false;assert.throws(()=>derive({get source210(){invoked=true;return source210;}}),/source data property/);assert.equal(invoked,false);assert.throws(()=>derive(Object.assign(Object.create({}),{source210})),/plain source inputs/);assert.throws(()=>derive({source210,[Symbol('hidden')]:true}));
 assert(Object.isFrozen(r)&&Object.isFrozen(r.change.before.acl)&&Object.isFrozen(r.edits[0]));assert.throws(()=>{r.change.after.source='spoof';});for(const flag of ['target_metadata_adopted','assembled','source_compilation_performed','native_certification','application_activation'])assert.equal(r[flag],false);
});
