/** File-only successor proof; no Native/SQL/business execution. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {deriveOrderSplit210FinancialSuccessor as derive,ORDER_SPLIT210_FINANCIAL_SOURCE as pins} from '../tools/parity/order-split210-financial-successor.mjs';
import {PACKING204_SOURCE_CONTRACT as e204} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/packing204-source-contract.mjs';
import {orderMergeDelivery209HistorySqlSpans as spans} from '../tools/parity/order-merge-delivery209-history-closure.mjs';
import {deriveOrderSplit210TriggerRoster} from '../tools/parity/order-split210-external-triggers.mjs';
const source204=readFileSync(new URL('../server/204_partial_commercial_sale_scope.sql',import.meta.url),'utf8');
const source210=readFileSync(new URL('../tools/parity/order-split210-business.sql',import.meta.url),'utf8');
const input={source204,source210},sha=s=>createHash('sha256').update(s).digest('hex');
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const digest=v=>sha(JSON.stringify(canonical(v)));
const code=s=>spans(s).map(x=>x.executable?x.text:x.text.replace(/[^\n]/g,' ')).join('');
const deriveCurrent=()=>derive(input);

test('complete Source204 literal independently equals E204.after full24; AFTER preserves the entire header, ACL and single function identity',()=>{
 const r=deriveCurrent(),expected=e204.changes.find(c=>c.key===pins.key);assert(expected);
 assert.deepEqual(r.change.before,expected.after);assert.equal(Object.keys(r.change.before).length,24);
 assert.equal(Buffer.byteLength(r.change.before.source),67979);assert.equal(sha(r.change.before.source),pins.body_sha256);
 assert.equal(digest(r.change.before),pins.full24_value_sha256);assert.equal(digest({kind:'function',key:pins.key,value:expected.after}),pins.full_record_sha256);
 const headers=v=>Object.fromEntries(Object.entries(v).filter(([key])=>!['source','definition'].includes(key)));
 assert.deepEqual(headers(r.change.after),headers(expected.after));assert.equal(r.change.key,'public.financial_return_upgrade_valid()');assert.equal(r.change.kind,'function');
 assert.deepEqual(r.change.after.config,['search_path=pg_catalog, public','TimeZone=UTC']);assert.equal(r.change.after.volatility,'v');assert.equal(r.change.after.security_definer,true);
 assert.deepEqual(r.change.after.acl,[{grantor:'postgres',grantee:'postgres',privilege:'EXECUTE',grantable:false}]);assert.equal(r.change.after.acl_null,false);
 assert.equal(r.sql,r.change.after.definition+';\n');assert.equal((r.sql.match(/^CREATE OR REPLACE FUNCTION /gm)||[]).length,1);
});

test('all eight disjoint executable edits invert the WHOLE source and definition, including every quoted historical body',()=>{
 const r=deriveCurrent(),before=r.change.before.source;assert.equal(r.edits.length,8);
 let inverse=r.change.after.source,previous=-1;
 for(const edit of r.edits){assert(edit.beforeStart>previous);previous=edit.beforeStart;assert.equal(before.slice(edit.beforeStart,edit.beforeStart+edit.before.length),edit.before);assert.notEqual(code(before)[edit.beforeStart],' ');}
 for(const edit of [...r.edits].reverse()){assert.equal(inverse.slice(edit.afterStart,edit.afterStart+edit.after.length),edit.after);inverse=inverse.slice(0,edit.afterStart)+edit.before+inverse.slice(edit.afterStart+edit.after.length);}
 assert.equal(inverse,before);assert.equal(r.change.after.definition.replace(r.change.after.source,()=>before),expectedDefinition());assert.equal(r.whole_source_inverse_verified,true);
 const cte=r.edits.find(e=>e.kind==='statement_local_bound_classification');assert(cte);
 const quoted=s=>spans(s).filter(x=>!x.executable).map(x=>x.text),old=quoted(before),now=quoted(r.change.after.source.replace(cte.after,cte.before));
 const at=now.findIndex((x,i)=>x!==old[i]);assert.equal(now[at],"'source'");now.splice(at,1);assert.deepEqual(now,old,'all pre-existing quoted data and historical source definitions are byte-exact');
 assert(!/\b(?:INSERT|UPDATE|DELETE|ALTER|DROP|GRANT|REVOKE|set_config|current_setting)\b/i.test(code(cte.after)));
});
function expectedDefinition(){return e204.changes.find(c=>c.key===pins.key).after.definition;}

test('raw three-SHA refusal keeps exact source-authored expected values, NULL refusal and all inherited refusal sites',()=>{
 const r=deriveCurrent(),edit=r.edits.find(e=>e.kind==='raw_three_family_hash');assert(edit);
 assert.equal(edit.before,"WHERE p.oid IS NULL OR encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') IS DISTINCT FROM expected.body_sha) THEN RETURN false;END IF;");
 assert.equal(edit.after,"WHERE p.oid IS NULL OR encode(sha256(convert_to(public.order_split210_try_function_projection(p.oid)->>'source','UTF8')),'hex') IS DISTINCT FROM expected.body_sha) THEN RETURN false;END IF;");
 for(const [family,key,hash]of [['158','fa3_draft_fingerprint','98e864adebce59dc7da7f1e46cecddcf5028bc1de05db5dea1e0d0800ca56a30'],['159','b2b_invoice_fingerprint','b3dff2ee8934549828eb4c029298375802022e618d42027b57f3dea3ea4f57d3'],['160','b2b_credit_fingerprint','9e3766d47014f65190e470b4aa4ac70d54bc96ce094493408480a41026564a0b']]){
  const tuple="('"+family+"','public."+key+"()','"+hash+"')";assert(r.change.before.source.includes(tuple));assert(r.change.after.source.includes(tuple));
 }
 assert.equal((code(r.change.after.source).match(/order_split210_try_function_projection\(/g)||[]).length,1);
 assert.equal((code(r.change.after.source).match(/RETURN false/g)||[]).length,(code(r.change.before.source).match(/RETURN false/g)||[]).length);
 assert(!r.change.after.source.includes('order_split210_try_metadata_projection'),'no whole-JSON wrapping or self-descriptor projection');
});

test('one statement-local MATERIALIZED classification covers only genuine2/2/5 bound triggers and all six inherited selectors',()=>{
 const r=deriveCurrent(),cte=r.edits.find(e=>e.kind==='statement_local_bound_classification');
 assert.deepEqual(r.statement_local_bound_targets,[
  {family:'158',table_targets:['order_items','orders'],function_targets:['order_items','orders'],targets:['order_items','orders']},
  {family:'159',table_targets:['order_items','orders'],function_targets:['order_items','orders'],targets:['order_items','orders']},
  {family:'160',table_targets:['order_items','orders','stock_location_movements','stock_movements','wms_layer_movements'],function_targets:['order_items','orders'],targets:['order_items','orders','stock_location_movements','stock_movements','wms_layer_movements']},
 ]);
 assert.deepEqual(r.strict_bound_classifications,{per_family:[2,2,5],three_statement_total:9,maximum_per_statement:5,cross_statement_cache:false});
 assert.equal((cte.after.match(/AS MATERIALIZED\(/g)||[]).length,2);assert.equal((code(r.change.after.source).match(/order_split210_is_added_trigger\(/g)||[]).length,1);
 assert(cte.after.includes('WHERE n.nspname=\'public\''));assert(cte.after.includes('declared.family_code=family214 AND declared.table_name=rel.relname AND declared.trigger_name=t.tgname'));
 assert(cte.after.includes('SELECT oid FROM split210_financial_bound_candidates WHERE public.order_split210_is_added_trigger(oid)'));
 const selectors=r.edits.filter(e=>e.kind==='financial_table_trigger_selector'||e.kind==='financial_trigger_function_membership');assert.equal(selectors.length,6);
 for(const edit of selectors){assert.equal(edit.after,edit.before+' AND NOT EXISTS(SELECT FROM split210_financial_bound_verified verified WHERE verified.oid=tr.oid)');assert(edit.before.includes('NOT tr.tgisinternal'));assert(!/LIKE|starts_with|tgname/.test(edit.after.slice(edit.before.length)));}
 const used=new Set(r.statement_local_bound_targets.flatMap(g=>g.targets));
 const unselected=deriveOrderSplit210TriggerRoster({source210}).groups.external_bound.map(key=>key.split('.')[1]).filter(table=>!used.has(table));assert.equal(unselected.length,7);
 for(const table of unselected)assert(!cte.after.includes("'"+table+"'"),'no classification/hiding of unselected '+table);
});

test('source-backed selectors exclude rawbuyer branches; active financial self and entire original162 normalization stay current/raw on both sides',()=>{
 const r=deriveCurrent(),audit=r.raw_boolean_selector_audit;
 assert.deepEqual(audit.families.map(f=>[f.family,f.raw_case_count,f.raw_boolean_names_selected_by_prefix]),[['158',1,[]],['159',1,[]],['160',0,[]]]);
 for(const family of audit.families){assert(family.function_prefixes.length>=3);assert(family.other_membership.includes('returns trigger, not boolean'));for(const name of ['buyer_address_guards','financial_return_upgrade_valid'])assert(!family.function_prefixes.some(prefix=>name.startsWith(prefix)));}
 assert.equal(audit.buyer_projection_required_in_raw_cases,false);assert.equal(audit.financial162.buyer_selected,false);assert.deepEqual(audit.financial162.raw_boolean_names_selected,['financial_return_upgrade_valid']);
 // Independently authenticate the two relevant metadata result types from E204,
 // rather than treating arbitrary pg_proc OIDs as genuine trigger functions.
 assert.equal(e204.changes.find(c=>c.key==='public.buyer_address_guards()').after.result,'boolean');assert.equal(r.change.before.result,'boolean');
 const rawSelf="SELECT prosrc INTO STRICT source219 FROM pg_proc WHERE oid='public.financial_return_upgrade_valid()'::regprocedure;";
 const a=r.change.before.source.indexOf(rawSelf),b=r.change.after.source.indexOf(rawSelf);assert(a>0&&b>a);
 assert.equal(r.change.after.source.slice(b),r.change.before.source.slice(a),'selfdefinition normalization, original162 JSON and final certificates remain exact');
 assert(!r.edits.some(edit=>edit.beforeStart>=a));assert(!code(r.change.before.source.slice(a)).includes('order_split210_'));
 const rawCase="CASE WHEN p.oid IN('public.financial_return_upgrade_valid()'::regprocedure,'public.buyer_address_guards()'::regprocedure) THEN pg_get_functiondef(p.oid) ELSE public.partial_sale204_predecessor_definition(p.oid) END";
 assert.equal((r.change.before.source.split(rawCase).length-1),3);assert.equal((r.change.after.source.split(rawCase).length-1),3);
});

test('source/header/history/trigger drift and caller-supplied descriptor or verdict are rejected before derivation; getters never execute',()=>{
 for(const poisoned of [source204+'\n',source204.replace('CREATE OR REPLACE FUNCTION public.financial_return_upgrade_valid()\n RETURNS boolean','CREATE OR REPLACE FUNCTION public.financial_return_upgrade_valid()\n RETURNS text'),source204.replace(' SET "TimeZone" TO \'UTC\'',' SET "TimeZone" TO \'Europe/Warsaw\'')])assert.throws(()=>derive({source204:poisoned,source210}),/literal204/);
 assert.throws(()=>derive({source204,source210:source210+'\n'}),/literal frozen Native210 source/);
 for(const key of ['before','sourceSeal','expectedFingerprint','nativeAcceptance','source_compilation_performed'])assert.throws(()=>derive({...input,[key]:true}),/closed source-only/);
 assert.throws(()=>derive({...input,[Symbol('extra')]:true}),/closed source-only/);
 for(const key of ['source204','source210']){let called=false;const options={...input};Object.defineProperty(options,key,{enumerable:true,get(){called=true;throw new Error('getter executed');}});assert.throws(()=>derive(options),/data properties/);assert.equal(called,false);}
});

test('immutable builder-only output never upgrades source proof into compiled, Native or application acceptance',()=>{
 const r=deriveCurrent();assert.equal(r.schema,'order-split210-financial-successor-candidate/v1');assert.equal(r.source_proofs.runtime_reproduction_performed,false);assert.equal(r.source_proofs.native_verified,false);
 for(const key of ['target_metadata_adopted','assembled','source_compilation_performed','native_certification','application_activation'])assert.equal(r[key],false);
 assert.equal(r.source_after_sha256,sha(r.change.after.source));assert.equal(r.source_bytes_after,Buffer.byteLength(r.change.after.source));assert(Object.isFrozen(r)&&Object.isFrozen(r.change.after.acl[0])&&Object.isFrozen(r.edits[0]));assert.throws(()=>{r.change.after.source='poison';});
});
