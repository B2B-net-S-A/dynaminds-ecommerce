/** Official public-document integrity only; no app/PG/account/lifecycle imports. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {JSDOM} from 'jsdom';
import {baseCaptureSkip} from '../tools/parity/base-captures.mjs';
const dir=fileURLToPath(new URL('../docs/parity/',import.meta.url));
const load=n=>JSON.parse(fs.readFileSync(dir+n));
const sha=b=>createHash('sha256').update(b).digest('hex');
const v=load('base-api-order-configuration-contracts.v1.json');
const skip=baseCaptureSkip(['docs/parity/'+v.source_snapshot.path]);
if(skip)test('Order configuration contracts are re-checked against the archived Base.com documentation capture',{skip},()=>{});
else{
const packed=fs.readFileSync(dir+v.source_snapshot.path),cap=JSON.parse(gunzipSync(packed)),index=load(v.method_inventory_ref),method=n=>v.methods.find(m=>m.method===n),param=(m,n)=>method(m).input.parameters.find(f=>f.name===n),norm=s=>s.replace(/\s+/g,' ').trim();
function prose(cell){const n=cell.cloneNode(true);for(const b of n.querySelectorAll('br'))b.replaceWith('\n');for(const b of n.querySelectorAll('li,p,div')){b.prepend('\n');b.append('\n');}return norm(n.textContent);}
test('exact full Payments2 + Statuses8 classification; no invented fields group',()=>{
 assert.deepEqual(v.selected_index_groups,[{family:'Orders',group:'Payments'},{family:'Orders',group:'Statuses'}]);
 const expected=index.methods.filter(x=>x.family==='Orders'&&['Payments','Statuses'].includes(x.group));
 assert.equal(expected.length,10);assert.equal(v.method_count,10);assert.deepEqual(v.methods.map(x=>x.method),expected.map(x=>x.method));
 assert.equal(index.methods.find(x=>x.method==='getOrderExtraFields').group,'Other');assert(!v.methods.some(x=>x.method==='getOrderExtraFields'));
 assert.equal(v.contract_review_complete_for_selected_groups,true);assert.equal(v.contract_review_complete_for_all_Orders_family,false);
});
test('all ten official sources retain exact URL/status/time/hash/bytes and index pin',()=>{
 assert.equal(sha(fs.readFileSync(dir+v.method_inventory_ref)),v.inventory_sha256);assert.equal(sha(packed),v.source_snapshot.sha256);assert.equal(packed.length,v.source_snapshot.bytes);assert.equal(cap.documents.length,10);
 for(const m of v.methods){const s=cap.documents.find(x=>x.method===m.method);assert.equal(sha(Buffer.from(s.html_utf8)),m.source.sha256);assert.equal(Buffer.byteLength(s.html_utf8),m.source.bytes);assert.equal(s.sha256,m.source.sha256);assert.equal(s.bytes,m.source.bytes);assert.equal(m.source.http_status,200);assert(Number.isFinite(Date.parse(m.source.retrieved_at)));assert.equal(new URL(m.source.url).hostname,'api.baselinker.com');assert.equal(new URL(m.source.url).searchParams.get('method'),m.method);assert.equal(m.source.final_url,s.final_url);}
});
test('24 input/24 output table rows and seven payment prose fields match independent DOM walk',()=>{
 let inputs=0,outputs=0,nested=0;
 for(const m of v.methods){const dom=new JSDOM(cap.documents.find(x=>x.method===m.method).html_utf8);try{
  const d=dom.window.document;assert([...d.querySelectorAll('div.header')].some(x=>x.textContent.trim()===m.method));
  for(const[direction,title,fields]of[['input','Input parameters',m.input.parameters],['output','Output data',m.output.fields]]){
   const h=[...d.querySelectorAll('div.header')].find(h=>h.textContent.trim()===title),rows=h.nextElementSibling?.tagName==='TABLE'?[...h.nextElementSibling.querySelectorAll('tr')]:[];assert.equal(rows.length,fields.length);
   let parent;
   for(const[i,row]of rows.entries()){const c=[...row.children].filter(c=>c.nodeName==='TD'),raw=c.map(x=>norm(x.textContent)),f=fields[i];assert.equal(c.length,3);assert.deepEqual([f.documented_name,f.documented_type,f.documented_description],raw);assert.equal(f.source_table_row,i+1);const sub=raw[0].startsWith('| - ');if(!sub)parent=raw[0];assert.equal(f.name??f.path,sub?parent+'[].'+raw[0].slice(4):raw[0]);
    const text=prose(c[2]),matches=[...text.matchAll(/\b([a-z_][a-z0-9_]*)\s+\(([a-z]+(?:\([0-9, ]+\))?)\)\s*-\s*/g)],actual=m[direction].embedded_documented_fields.filter(f=>f.source_table_row===i+1);assert.deepEqual(actual.map(f=>[(f.name??f.path).split('.').at(-1),f.documented_type]),matches.map(x=>[x[1],x[2]]));
    for(let j=0;j<matches.length;j++)assert.equal(actual[j].documented_description,text.slice(matches[j].index+matches[j][0].length,matches[j+1]?.index).trim().replace(/\s+-$/,''));nested+=actual.length;
   }
  }
 }finally{dom.window.close();}inputs+=m.input.parameters.length;outputs+=m.output.fields.length;}
 assert.equal(inputs,24);assert.equal(outputs,24);assert.equal(nested,7);
 assert.deepEqual(method('getOrderPaymentsHistory').output.embedded_documented_fields.map(x=>x.path),['payments[].paid_before','payments[].paid_after','payments[].total_price','payments[].currency','payments[].external_payment_id','payments[].date','payments[].comment']);
});
test('cumulative payment replacement, subset default and sample-type conflict remain explicit',()=>{
 const p=param('setOrderPayment','payment_done');assert.equal(p.effect,'replace_current_paid_total_not_additive');assert.equal(p.equal_to_order_value,'mark_order_paid');assert.equal(p.required,null);assert.equal(param('setOrderPayment','external_payment_id').required,false);assert.equal(param('setOrderPayment','external_payment_id').uniqueness_and_idempotency,'not_documented');
 const f=param('getOrderPaymentsHistory','show_full_history');assert.equal(f.default,false);assert.equal(f.false_behavior,'only_entries_containing_external_payment_identifier');assert.equal(f.required,false);
 assert.equal(method('getOrderPaymentsHistory').output.example_representation_conflicts.length,2);assert.equal(method('getOrderPaymentsHistory').pagination.result_cap,null);assert.equal(method('setOrderPayment').input.parameters.find(x=>x.name==='currency'),undefined);
});
test('status create/update omission, analytics and both destructive migrations are distinct',()=>{
 assert.equal(param('addOrderStatus','status_id').required,false);assert.equal(param('addOrderStatusGroup','group_id').required,false);assert.equal(param('addOrderStatus','group_id').on_create_omitted,'main_default_group');assert.equal(param('addOrderStatus','group_id').on_update_omitted,'preserve_existing_group');assert.equal(param('addOrderStatus','type').default,0);assert.equal(Object.keys(param('addOrderStatus','type').documented_values).length,7);assert.equal(param('addOrderStatus','name_for_customer').empty_string,'hide_status_from_customer_facing_history');
 assert.equal(method('deleteOrderStatus').documented_destructive_effect.migrate_all_orders_to_parameter,'target_status_id');assert.equal(method('deleteOrderStatus').documented_destructive_effect.delete_primary_status,false);assert.deepEqual(method('deleteOrderStatus').input.cross_field_constraints,[{left:'target_status_id',operator:'must_differ_from',right:'status_id'}]);
 assert.equal(method('deleteOrderStatusGroup').documented_destructive_effect.move_all_group_statuses_to,'main_default_group');assert.equal(method('deleteOrderStatusGroup').documented_destructive_effect.delete_main_group,false);assert.equal(method('deleteOrderStatusGroup').documented_destructive_effect.delete_member_statuses,false);
 assert.equal(method('setOrderStatuses').input.batch.max_items,'not_documented');assert.equal(method('setOrderStatuses').input.batch.all_or_nothing,'not_documented');
});
test('requiredness, source mappings and all acceptance levels stay honest',()=>{
 const all=v.methods.flatMap(x=>x.input.parameters);assert.equal(all.filter(x=>x.required===null).length,18);assert.equal(all.filter(x=>x.required===false).length,6);assert.equal(all.filter(x=>x.required===true).length,0);
 for(const name of['official_account_requests_performed','implementation_coverage_measured','acceptance_granted','scope_mutated'])assert.equal(v[name],false);
 assert.equal(v.current_code_review.anchors.length,7);for(const a of v.current_code_review.anchors)assert.match(a.sha256,/^[a-f0-9]{64}$/);
 for(const m of v.methods){assert.equal(m.implementation_verified,false);assert.equal(m.acceptance_granted,false);assert.equal(m.operational_contract_fully_resolved,false);assert(v.current_code_mappings[m.current_code_mapping_ref]);assert(m.proposed_acceptance.length>=2);assert.equal(m.errors.http_status_mapping,'not_documented');if(m.documented_destructive_effect)assert.equal(m.documented_destructive_effect.execution_performed,false);}
 assert.equal(v.current_code_mappings.status_groups.route_candidates.length,0);assert.equal(v.open_contract_issues.length,10);
});
}
