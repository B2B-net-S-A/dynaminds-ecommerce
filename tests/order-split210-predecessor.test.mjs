/** Fresh literal derivation, not SQL parsing/Native or whole210 closure proof. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {ORDER_SPLIT210_OBSERVER_SOURCES as P,deriveOrderSplit210Predecessor,projectOrderSplit210ObserverSource,orderSplit210ObserverSpans} from '../tools/parity/order-split210-predecessor.mjs';
import {ORDER_SPLIT210_WMS_BRANCH} from '../tools/parity/order-split210-wms-successor.mjs';
const files={source104:'104_order_merge_custody.sql',source108:'108_b2b_dropshipping.sql',source160:'160_b2b_credit.sql',source169:'169_manual_inventory_off.sql',source204:'204_partial_commercial_sale_scope.sql'};
const inputs=Object.fromEntries(Object.entries(files).map(([k,f])=>[k,readFileSync(new URL('../server/'+f,import.meta.url),'utf8')]));
const result=deriveOrderSplit210Predecessor(inputs);
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const digest=v=>createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
const headers=v=>Object.fromEntries(Object.entries(v).filter(([k])=>!['source','definition'].includes(k)));

test('three exact full observer predecessors are freshly derived from literal204/169 with complete headers/private ACL',()=>{
 const expected={
  'public.fa3_draft_fingerprint()':'277834d629070c855204dce2747a6057d79bb105d09982816a153247dc7f4644',
  'public.b2b_invoice_fingerprint()':'d6ee3ec5a57f420bdd9fd8d7124ea9d583b0fba0a961c04af4a86e0604bf7dbc',
  'public.b2b_credit_fingerprint()':'21d9498657ffe7d2ecefa261e28c573dd33b9acfb17f9b710dc44f1b4267966b',
 };
 assert.deepEqual(P.before_records,expected);assert.equal(result.changes.length,4);
 for(const c of result.changes.slice(0,3)){
  assert.equal(digest({kind:c.kind,key:c.key,value:c.before}),expected[c.key]);
  const unit=c.key.includes('b2b_credit_')?inputs.source169:inputs.source204;
  assert(unit.includes(c.before.source),'entire body is present in actual literal source');
  assert.equal(c.before.language,'sql');assert.equal(c.before.volatility,'v');assert.equal(c.before.security_definer,true);
  assert.deepEqual(c.before.config,['search_path=pg_catalog, public']);assert.equal(c.before.acl_null,false);
  assert.deepEqual(c.before.acl,[{grantor:'postgres',grantee:'postgres',privilege:'EXECUTE',grantable:false}]);
  assert(c.before.definition.startsWith('CREATE OR REPLACE FUNCTION '+c.key+'\n RETURNS text\n LANGUAGE sql\n SECURITY DEFINER\n'));
 }
});

test('four source units and104+108 input pins reject actual body/header/ACL or unrelated source drift without expected adoption',()=>{
 for(const field of Object.keys(files)){
  assert.throws(()=>deriveOrderSplit210Predecessor({...inputs,[field]:inputs[field]+'\n-- changed'}));
 }
 assert.throws(()=>deriveOrderSplit210Predecessor({...inputs,source204:inputs.source204.replace('LANGUAGE sql','LANGUAGE plpgsql')}));
 assert.throws(()=>deriveOrderSplit210Predecessor({...inputs,source160:inputs.source160.replace('REVOKE ALL ON FUNCTION','GRANT ALL ON FUNCTION')}));
 assert.throws(()=>deriveOrderSplit210Predecessor({...inputs,source169:null}));
});

test('exact three observer deltas preserve every other byte, full headers and old quoted SQL',()=>{
 for(const [index,c]of result.changes.slice(0,3).entries()){
  const family=index===2?'manual169':'partial204',old=index===2?'public.manual_inventory_off_projected_definition':'public.partial_sale204_predecessor_definition';
  assert.deepEqual(headers(c.after),headers(c.before));
  assert(c.after.source.startsWith('\n SELECT public.order_split210_require();'));
  assert.deepEqual(result.projection_sites[index],{key:c.key,trigger_filters:2,function_filters:1,predecessor_definitions:1,legacy_definition_function:old});
  let restored=c.after.source.slice('\n SELECT public.order_split210_require();'.length)
   .replaceAll(' AND NOT public.order_split210_is_added_trigger(tr.oid)','')
   .replaceAll('NOT public.order_split210_is_added_trigger_function(p.oid) AND ','')
   .replaceAll("public.order_split210_predecessor_definition(p.oid,'"+family+"')",old+'(p.oid)');
  assert.equal(restored,c.before.source,'only four narrowly identified query-site edits and upfront real require');
  assert.equal(c.after.definition,c.before.definition.replace(c.before.source,()=>c.after.source));
  assert.equal((c.after.source.match(/order_split210_is_added_trigger\(tr\.oid\)/g)||[]).length,2);
  assert.equal((c.after.source.match(/order_split210_is_added_trigger_function\(p\.oid\)/g)||[]).length,1);
  assert(c.after.source.includes('md5(jsonb_build_object('),'computes the real projected fingerprint, no hardcoded historical digest');
  assert(!c.after.source.includes('public.public.'),'exactly one schema qualifier');
  assert.equal(c.after.source.split("public.order_split210_predecessor_definition(p.oid,'"+family+"')").length-1,1,'one exactly qualified predecessor call');
 }
});

test('manual169 replacement consumes actual public qualification and also supports the unqualified executable spelling',()=>{
 const original=result.changes[2].before.source;
 assert(original.includes('public.manual_inventory_off_projected_definition(p.oid)'),'literal169 qualification');
 for(const prior of ['public.manual_inventory_off_projected_definition(p.oid)','manual_inventory_off_projected_definition(p.oid)']){
  const input=original.replace('public.manual_inventory_off_projected_definition(p.oid)',prior);
  const output=projectOrderSplit210ObserverSource(input,'manual169').source;
  assert(!output.includes('public.public.'));
  const call="public.order_split210_predecessor_definition(p.oid,'manual169')";
  assert.equal(output.split(call).length-1,1);
  assert(!output.includes('manual_inventory_off_projected_definition(p.oid)'));
  const restored=output.slice('\n SELECT public.order_split210_require();'.length)
   .replaceAll(' AND NOT public.order_split210_is_added_trigger(tr.oid)','')
   .replaceAll('NOT public.order_split210_is_added_trigger_function(p.oid) AND ','')
   .replace(call,prior);
  assert.equal(restored,input,'exact original qualification preserved in the independently chosen inverse');
 }
});

test('WMS fourth delta remains exact existing104+108 owner/private proof derivation, no broad invoker or ACL change',()=>{
 const c=result.changes[3];assert.equal(c.key,'public.wms_row_guard()');
 assert.equal(digest({kind:c.kind,key:c.key,value:c.before}),'c2b12caaf79c2347e1a06557ac62dae1963647edb9527d8fa313e96c85d07669');
 assert.equal(digest({kind:c.kind,key:c.key,value:c.after}),'f573804fc6f47b5d36e0a451448db22e461a50e718d6bff08114284654b1f556');
 assert.equal(c.after.source.replace(ORDER_SPLIT210_WMS_BRANCH,''),c.before.source);
 assert.deepEqual(headers(c.after),headers(c.before));assert.equal(c.after.security_definer,false);
});

test('quoted/comment/dollar examples do not become executable trigger filters or authority',()=>{
 const decoys="\n-- AND NOT tr.tgisinternal manual_inventory_off_projected_definition(p.oid)\n/* outer /* AND NOT tr.tgisinternal */ end */\n SELECT 'AND NOT tr.tgisinternal', E'quoted\\\'text', \"tr.tgisinternal\", $example$public.partial_sale204_predecessor_definition(p.oid)$example$;\n";
 for(const [index,c]of result.changes.slice(0,3).entries()){
  const projected=projectOrderSplit210ObserverSource(decoys+c.before.source,index===2?'manual169':'partial204');
  assert(projected.source.includes(decoys),'all decoy bytes survive');
  assert.deepEqual(projected.sites,{trigger_filters:2,function_filters:1,predecessor_definitions:1});
 }
 const spans=orderSplit210ObserverSpans(decoys);assert.equal(spans.map(s=>s.text).join(''),decoys);
 assert(spans.filter(s=>s.executable).every(s=>!s.text.includes('AND NOT tr.tgisinternal')));
});

test('missing/extra executable observer sites and malformed SQL fail rather than silently reducing the scope',()=>{
 const source=result.changes[0].before.source;
 for(const invalid of [source.replace('AND NOT tr.tgisinternal','AND tr.tgisinternal'),source+' AND NOT tr.tgisinternal',source.replace('public.partial_sale204_predecessor_definition(p.oid)','unknown_reader(p.oid)')]){
  assert.throws(()=>projectOrderSplit210ObserverSource(invalid,'partial204'));
 }
 assert.throws(()=>projectOrderSplit210ObserverSource(source,'unknown'));
 for(const invalid of ["SELECT 'unclosed",'/* unclosed','SELECT $unclosed$'])assert.throws(()=>orderSplit210ObserverSpans(invalid));
});

test('partial204/manual169 composition, missing nine successor ports and uncertified state remain explicit',()=>{
 assert.equal(result.remaining_old_function_keys.length,9);assert.equal(new Set(result.remaining_old_function_keys).size,9);
 assert(result.remaining_old_function_keys.includes('public.order_merge_delivery209_fingerprint()'));
 assert(result.remaining_old_function_keys.includes('public.order_merge_delivery209_predecessor_metadata(value jsonb, entries jsonb)'));
 assert.equal(result.required_private_ports.length,4);
 const port=result.required_private_ports.find(p=>p.key==='public.order_split210_predecessor_definition(fn oid, family text)');
 assert(port.contract.includes('raw parent209 definition alone is insufficient'));
 for(const flag of ['complete_thirteen_change_closure','source_compilation_performed','native_certification','application_activation'])assert.equal(result[flag],false);
 assert(!('sql' in result),'no giant assembled program or placeholder helper implementation');
 const source=readFileSync(new URL('../tools/parity/order-split210-predecessor.mjs',import.meta.url),'utf8');
 assert(!/\bimport.*(?:packing204-source-contract|header205-source-contract|order-merge-delivery209-predecessor)/.test(source));
 assert(!/\b(?:UPDATE|ALTER TABLE|GRANT) public\./.test(source));
});

test('derived representation and source-input pins are deeply immutable, without storing verdicts in caller data',()=>{
 assert(Object.isFrozen(result));assert(Object.isFrozen(result.changes));assert(Object.isFrozen(result.changes[0].after.acl));
 assert.throws(()=>{result.changes[0].after.acl[0].grantee='PUBLIC';});
 assert.throws(()=>{result.source_inputs.before_records[result.changes[0].key]='0'.repeat(64);});
 const next=deriveOrderSplit210Predecessor(inputs);assert.notEqual(next,result);assert.deepEqual(next,result);
});
