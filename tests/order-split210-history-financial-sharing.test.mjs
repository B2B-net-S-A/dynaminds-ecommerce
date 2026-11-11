/** Controlled source equations only. No PG, timing, Native or admission proof. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {deriveOrderSplit210HistoryFinancialSharing as derive,ORDER_SPLIT210_HISTORY_FINANCIAL_SHARING_SOURCE as pins} from '../tools/parity/order-split210-history-financial-sharing.mjs';
import {deriveOrderSplit210HistoryOperativeSuccessor} from '../tools/parity/order-split210-history-operative-successor.mjs';
import {orderMergeDelivery209HistorySqlSpans as spans} from '../tools/parity/order-merge-delivery209-history-closure.mjs';
const source210=readFileSync(new URL('../tools/parity/order-split210-business.sql',import.meta.url),'utf8');
const parent=deriveOrderSplit210HistoryOperativeSuccessor({source210}),r=derive({source210});
const sha=s=>createHash('sha256').update(s).digest('hex');
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const digest=v=>sha(JSON.stringify(canonical(v)));
const code=s=>spans(s).map(p=>p.executable?p.text:p.text.replace(/[^\n]/g,' ')).join('');
const inverse=(source,edits)=>{for(const e of [...edits].reverse()){assert.equal(source.slice(e.afterStart,e.afterStart+e.after.length),e.after);source=source.slice(0,e.afterStart)+e.before+source.slice(e.afterStart+e.after.length);}return source;};

test('independent current Source23 source/full24 and original209 BEFORE are fixed; no header/ACL changes',()=>{
 assert.deepEqual(r.source23_change,parent.change);assert.deepEqual(r.change.before,parent.change.before);
 assert.equal(digest(parent.change.after),pins.source23_after_full24_sha256);assert.equal(sha(parent.change.after.source),pins.source23_after_source_sha256);
 assert.equal(digest(r.change.before),pins.original209_before_full24_sha256);
 const omit=v=>Object.fromEntries(Object.entries(v).filter(([k])=>!['source','definition'].includes(k)));
 assert.deepEqual(omit(r.change.after),omit(parent.change.after));assert.equal(Object.keys(r.change.after).length,24);
 assert.deepEqual(r.change.after.config,['search_path=pg_catalog, public','TimeZone=UTC']);assert.deepEqual(r.change.after.acl,[{grantor:'postgres',grantee:'postgres',privilege:'EXECUTE',grantable:false}]);
});
test('exact two whole-statement edits reverse current Source23 then the entire original209 source and definition',()=>{
 assert.equal(r.edits.length,2);assert.deepEqual(r.edits.map(e=>e.family),['158','159']);
 const old=inverse(r.change.after.source,r.edits);assert.equal(old,parent.change.after.source);
 assert.equal(inverse(old,parent.edits),parent.change.before.source);
 assert.equal(r.change.after.definition.replace(r.change.after.source,()=>old),parent.change.after.definition);
 assert.equal(code(parent.change.after.source).slice(r.edits[0].beforeStart,r.edits[0].beforeStart+4),'WITH');
 const oldLiterals=spans(parent.change.after.source).filter(p=>!p.executable).map(p=>p.text);
 const newLiterals=spans(r.change.after.source).filter(p=>!p.executable).map(p=>p.text);
 // The two query replacements add fixed SQL literals, but every other byte,
 // including the large quoted buyer/financial historical definitions, reverses.
 assert(oldLiterals.some(s=>s.length>10000));assert(newLiterals.some(s=>s.length>10000));
 assert.equal(r.whole_source23_inverse_verified,true);assert.equal(r.whole_original209_inverse_verified,true);
});
test('each statement guarantees fresh require before both MATERIALIZED maps; no per-trigger require or trust API',()=>{
 for(const e of r.edits){
  assert(e.after.startsWith('PERFORM public.order_split210_require();\n WITH '));
  assert.equal((code(e.after).match(/order_split210_require\(/g)||[]).length,1);
  assert.equal((e.after.match(/AS MATERIALIZED\(/g)||[]).length,2);
  assert(e.after.includes("SELECT payload_jsonb#>'{families,partial204}' defs FROM public.order_split210_projection_basis WHERE id"));
  assert(!code(e.after).includes('order_split210_is_added_trigger('));
  assert(!/current_setting|set_config|CREATE\s|INSERT\s|UPDATE\s|DELETE\s/.test(code(e.after)));
 }
 assert.deepEqual(r.sharing,{statements:2,fresh_whole_guards:2,per_statement_bound_oids:2,per_statement_family_keys:2,cross_statement_cache:false,unknown_fallback_preserved:true});
});
test('all source tuples/order/NULL/table/membership selectors stay byteexact outside the closed prefix and family expression',()=>{
 for(const e of r.edits){
  const parentPrefix=parent.edits.filter(x=>x.kind==='statement_local_bound_classification')[0].after;
  const from=e.before.slice(parentPrefix.length),to=e.after.slice(e.after.indexOf('SELECT jsonb_build_object(')+'SELECT jsonb_build_object('.length);
  const port="public.order_split210_predecessor_definition(p.oid,'partial204')";
  const caseStart=to.indexOf('CASE WHEN p.oid IN('),caseEnd=to.indexOf(' ELSE '+port+' END',caseStart)+' ELSE '.length+port.length+' END'.length;
  assert(caseStart>=0&&caseEnd>caseStart);
  assert.equal(to.slice(0,caseStart)+port+to.slice(caseEnd),from);
  assert.equal((e.after.match(/NOT EXISTS\(SELECT FROM split210_bound_verified verified WHERE verified\.oid=tr\.oid\)/g)||[]).length,2);
 }
 const tail=parent.change.after.source.slice(parent.change.after.source.indexOf(' -- C26 fullNativeV7',parent.change.after.source.indexOf("'{fingerprints,159}'")));
 assert(tail.length>1000);assert(r.change.after.source.endsWith(tail));
});
test('strict three NULL properties and overload refusal are the exact complement of authored204; fallback keeps original55000',()=>{
 const source204=readFileSync(new URL('../server/204_partial_commercial_sale_scope.sql',import.meta.url),'utf8');
 const at=source204.indexOf('CREATE FUNCTION public.partial_sale204_predecessor_definition(fn oid)\n');assert(at>=0);
 const prefix=source204.slice(at,at+6000);
 assert(prefix.includes("IF p.proallargtypes IS NOT NULL OR p.protrftypes IS NOT NULL OR p.prosqlbody IS NOT NULL OR (SELECT count(*) FROM pg_proc q WHERE q.pronamespace='public'::regnamespace AND q.proname=p.proname)<>1 THEN RAISE EXCEPTION '204 exact scoped descriptor required' USING ERRCODE='55000';END IF;"));
 for(const e of r.edits){
  assert(e.after.includes("p.proallargtypes IS NULL AND p.protrftypes IS NULL AND p.prosqlbody IS NULL AND(SELECT count(*) FROM pg_proc q WHERE q.pronamespace='public'::regnamespace AND q.proname=p.proname)=1"));
  assert(e.after.includes("ELSE public.order_split210_predecessor_definition(p.oid,'partial204') END"));
 }
 const closure=readFileSync(new URL('../tools/parity/order-split210-closure.mjs',import.meta.url),'utf8');
 assert(closure.includes("const strictRefusal=\"RAISE EXCEPTION '204 exact scoped descriptor required' USING ERRCODE='55000';\""));
 // Controlled equivalence of strict routing, not a fabricated DB execution.
 let fallbackCalls=0;
 const fold=(selected,properties,overloads)=>{
  if(selected&&properties.every(x=>x===null)&&overloads===1)return 'literal family definition';
  fallbackCalls++;if(selected&&(properties.some(x=>x!==null)||overloads!==1))throw Object.assign(new Error('204 exact scoped descriptor required'),{code:'55000'});return 'unchanged foreign definition';
 };
 assert.equal(fold(true,[null,null,null],1),'literal family definition');assert.equal(fallbackCalls,0);
 for(let i=0;i<3;i++){const v=[null,null,null];v[i]=[];assert.throws(()=>fold(true,v,1),e=>e.code==='55000');}
 for(const n of [0,2])assert.throws(()=>fold(true,[null,null,null],n),e=>e.code==='55000');
 assert.equal(fold(false,[null,[],null],2),'unchanged foreign definition');assert.equal(fallbackCalls,6);
});
test('foreign trigger/function scopes remain included; a fresh whole guard fails before any family DATA can be used',()=>{
 for(const e of r.edits){
  assert(e.after.includes("JOIN(VALUES ('order_items','order_split210_bound'),('orders','order_split210_bound'))"));
  assert(e.after.includes("declared.table_name=rel.relname AND declared.trigger_name=t.tgname"));assert(e.after.includes("WHERE n.nspname='public'"));
  assert(e.after.includes("CASE WHEN p.oid IN('public.fa3_draft_fingerprint()'::regprocedure,'public.b2b_invoice_fingerprint()'::regprocedure)"));
 }
 const excluded=t=>t.schema==='public'&&['orders','order_items'].includes(t.table)&&t.name==='order_split210_bound';
 assert(excluded({schema:'public',table:'orders',name:'order_split210_bound'}));
 for(const t of [{schema:'other',table:'orders',name:'order_split210_bound'},{schema:'public',table:'stock',name:'order_split210_bound'},{schema:'public',table:'orders',name:'foreign_trigger'}])assert(!excluded(t));
 let read=false;const controlled=(fresh)=>{if(!fresh)throw new Error('fresh whole210 refusal');read=true;return 'source DATA';};
 assert.throws(()=>controlled(false),/fresh whole210/);assert.equal(read,false);assert.equal(controlled(true),'source DATA');
});
test('actual canonical payload delta fits unchanged4MiB cap including both source copies and both tagged checks',()=>{
 const tag=v=>({...v,source:['sha256-utf8-text/v1',sha(v.source)],definition:['sha256-utf8-text/v1',sha(v.definition)]});
 const wrap=v=>({kind:'function',key:r.change.key,before:r.change.before,after:v,before_check:tag(r.change.before),after_check:tag(v)});
 const size=v=>Buffer.byteLength(JSON.stringify(canonical(wrap(v))));
 assert.equal(r.budget.canonical_change_delta_bytes,size(r.change.after)-size(parent.change.after));
 assert.equal(r.budget.predicted_data_bytes,4192139+r.budget.canonical_change_delta_bytes);assert.equal(r.budget.cap_bytes,4194304);
 assert(r.budget.remaining_bytes>=0);assert(r.budget.remaining_bytes<2165);
 assert.equal(Buffer.byteLength(r.change.after.source),76496);assert.equal(r.source_after_sha256,'ce881dd28b5b4427ebee48241dd3503b311e5d8c97a089d5150bdcc969ecd277');
});
test('frozen authored input only: drift/getters/extra frame or verdict fail closed without invoking authority',()=>{
 assert.throws(()=>derive({source210:source210+'\n'}));
 for(const key of ['frame','before','after','expectedDefinitions','guardPassed'])assert.throws(()=>derive({source210,[key]:true}));
 let invoked=false;assert.throws(()=>derive({get source210(){invoked=true;return source210;}}));assert.equal(invoked,false);
 assert.throws(()=>derive(Object.assign(Object.create({}),{source210})));assert.throws(()=>derive({source210,[Symbol('frame')]:true}));
 assert(Object.isFrozen(r.change.after.acl));for(const flag of ['target_metadata_adopted','assembled','source_compilation_performed','native_certification','application_activation','business_acceptance'])assert.equal(r[flag],false);
});
