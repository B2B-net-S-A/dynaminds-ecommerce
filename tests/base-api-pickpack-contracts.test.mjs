/** Archived documentation/DOM integrity only. No app, API, PG or account client. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {readRetainedRevision} from '../tools/parity/base-api-retained-revisions.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),sourceRoot=process.env.DYNA_DOC_SOURCE_ROOT??root;
const {JSDOM}=createRequire(path.join(sourceRoot,'package.json'))('jsdom'),sha=b=>createHash('sha256').update(b).digest('hex');
const read=n=>fs.readFileSync(path.join(sourceRoot,'docs/parity',n)),c=JSON.parse(fs.readFileSync(path.join(root,'docs/parity/base-api-pickpack-contracts.v1.json')));
const methods=['addPickPackCart','addPickPackOrdersToCart','deletePickPackCart','deletePickPackCartOrders','deletePickPackOrderFromCart','getPickPackCartOrders','getPickPackCarts','getPickPackOrderCart'];
const packed=read(c.source_snapshot.path),raw=gunzipSync(packed,{maxOutputLength:1048576}),source=JSON.parse(raw),norm=v=>v.replace(/\s+/g,' ').trim();
const method=n=>{const m=c.methods.find(m=>m.method===n);assert(m,n);return m;};
const field=(n,d,p)=>{const f=method(n)[d][d==='input'?'parameters':'fields'].find(f=>(f.name??f.path)===p);assert(f,n+':'+p);return f;};
test('PickPack contains exactly the eight indexed methods and frozen18.10 pages without backdating17.10 content',()=>{
 assert.equal(c.schema,'dynaminds-base-api-pickpack-contracts/v1');assert.equal(c.method_count,8);assert.deepEqual(c.methods.map(m=>m.method),methods);
 assert.equal(sha(read(c.method_inventory_ref)),c.inventory_sha256);assert.equal(c.inventory_sha256,'7e6b10f8fd105973ec99926372fcc7ae3ec6a2496514d3d45d2cc59af4c7d992');
 const index=JSON.parse(read(c.method_inventory_ref));assert.deepEqual(index.methods.filter(m=>m.family==='Orders'&&m.group==='PickPack carts').map(m=>m.method),methods);
 assert.equal(packed.length,79498);assert.equal(sha(packed),'e1c35ce403578f0fbd54fe20e323653cc73bdfd45dc83675aae3a59bfedcb647');assert.equal(raw.length,451973);assert.equal(sha(raw),'149a3d06fea3030467b543486be7b9d391714be670fb1699268e664358dd4593');assert.equal(source.documents.length,8);
 assert.equal(c.source_snapshot.decoded_sha256,sha(raw));assert.equal(c.source_snapshot.sha256,sha(packed));assert.equal(c.source_content_date,'2026-10-18');assert.equal(c.index_membership_date,'2026-10-17');
 assert.equal(sha(read(c.secondary_markdown_ref.path)),c.secondary_markdown_ref.sha256);
});
test('all31 table fields and eight intros match actual archived DOM, including three nested cart output fields',()=>{
 let inputs=0,outputs=0,nested=0;
 for(const m of c.methods){const s=source.documents.find(s=>s.method===m.method);assert.equal(sha(Buffer.from(s.html_utf8)),m.source.sha256);assert.equal(Buffer.byteLength(s.html_utf8),m.source.bytes);for(const k of ['url','final_url','retrieved_at','http_status'])assert.equal(m.source[k],s[k]);assert.equal(new URL(s.final_url).hostname,'api.baselinker.com');assert.equal(s.http_status,200);assert(s.retrieved_at.startsWith('2026-10-18T00:50:41.'));
  const dom=new JSDOM(s.html_utf8);try{const headers=[...dom.window.document.querySelectorAll('div.header')],range=dom.window.document.createRange();range.setStartAfter(headers.find(h=>h.textContent.trim()===m.method));range.setEndBefore(headers.find(h=>h.textContent.trim()==='Input parameters'));assert.equal(norm(range.toString()),m.documented_intro);
   for(const[d,title]of[['input','Input parameters'],['output','Output data']]){const rows=[...headers.find(h=>h.textContent.trim()===title).nextElementSibling.querySelectorAll('tr')],fields=m[d][d==='input'?'parameters':'fields'];assert.equal(fields.length,rows.length);let parent=null;
    for(const[i,row]of rows.entries()){const cells=[...row.children].map(n=>norm(n.textContent));assert.equal(cells.length,3);const[name,type,desc]=cells,child=name.startsWith('| - ');assert(!child||parent);const key=child?parent+'[].'+name.slice(4):name;if(!child)parent=type==='array'?name:null;const f=fields[i];assert.equal(f.name??f.path,key);assert.equal(f.documented_name,name);assert.equal(f.documented_type,type);assert.equal(f.documented_description,desc);assert.equal(f.source_kind,'table_row');assert.equal(f.source_table_row,i+1);if(d==='input')inputs++;else outputs++;if(child)nested++;}
   }
  }finally{dom.window.close();}
 }
 assert.deepEqual([inputs,outputs,nested],[10,21,3]);assert.deepEqual(c.field_inventory,{input_table_rows:10,output_table_rows:21,nested_output_table_rows:3,embedded_input_prose_fields:0,embedded_output_prose_fields:16});
});
test('create/update requiredness is conditional; unmarked IDs and array element types remain unknown',()=>{
 for(const m of c.methods)for(const f of m.input.parameters){assert.equal(f.default_status,'not_documented');assert.equal(f.required,m.method==='addPickPackCart'?false:null);assert.equal(f.requiredness_source,m.method==='addPickPackCart'?'explicit_optional':'not_explicitly_marked');}
 assert.deepEqual(field('addPickPackCart','input','cart_id').required_when,{operation:'update',source_text:'When updating a cart, you must provide the cart_id and can optionally update the name and/or color.'});
 assert.deepEqual(field('addPickPackCart','input','name').required_when,{operation:'create',source_text:'When creating a cart, you must provide a name, and optionally a color.'});assert.equal(field('addPickPackCart','input','color').required_when,undefined);
 const cart=method('addPickPackCart');for(const f of cart.input.parameters)if(f.required_when)assert(cart.documented_intro.includes(f.required_when.source_text));
 assert.deepEqual(cart.documented_modes,{create:{condition:'cart_id not provided',required:['name'],optional:['color']},update:{condition:'cart_id provided',required:['cart_id'],optional:['name','color']}});
 assert.equal(field('addPickPackCart','input','name').max_characters,5);assert.equal(field('addPickPackCart','input','color').documented_format,'hex color');assert.equal(field('addPickPackCart','input','color').documented_example,'#FF0000');assert.deepEqual(field('addPickPackCart','input','color').omission_behavior,{operation:'create',value:'random color generated automatically'});
 for(const[n,d,p]of[['addPickPackOrdersToCart','input','order_ids'],['addPickPackOrdersToCart','output','orders_failed'],['getPickPackCartOrders','output','orders']])assert.equal(field(n,d,p).element_type,null);
});
test('assignment limit and moving carts preserve partial-result uncertainty rather than inventing atomicity',()=>{
 const m=method('addPickPackOrdersToCart');assert.equal(field(m.method,'input','order_ids').max_items,20);assert.match(m.documented_intro,/up to 20 orders/);assert.deepEqual(m.documented_effects,{already_assigned_order:'moved to requested cart',maximum_assignments_per_order:1,partial_results:{success_count:'orders_assigned',failed_ids:'orders_failed'}});
 assert.equal(field(m.method,'output','orders_assigned').documented_type,'int');assert.equal(field(m.method,'output','orders_failed').documented_type,'array');assert.match(m.open_contract_issues.join(' '),/atomicity/);assert.match(m.open_contract_issues.join(' '),/21 IDs/);assert.equal(m.atomic,undefined);
 assert.deepEqual(method('addPickPackCart').documented_effects,{new_cart_owner:'current user',new_cart_position:'end of current user cart list'});
});
test('delete, clear, remove assignment and user-ownership boundaries remain distinct',()=>{
 assert.deepEqual(method('deletePickPackCart').documented_effects,{cart:'deleted',all_assigned_orders:'unassigned'});assert.deepEqual(method('deletePickPackCartOrders').documented_effects,{cart:'remains active',all_assigned_orders:'unassigned',removed_count:'orders_removed'});
 assert.deepEqual(method('deletePickPackOrderFromCart').documented_effects,{order_cart_assignment:'removed',order_deletion:'not_documented'});
 for(const n of ['deletePickPackCart','deletePickPackCartOrders']){assert.deepEqual(method(n).documented_preconditions,[{subject:'cart_id',requirement:'belongs_to_authenticated_user'}]);assert.match(method(n).documented_intro,/authenticated user/);}
 assert.deepEqual(method('deletePickPackOrderFromCart').documented_preconditions,[{subject:'order_id',requirement:'belongs_to_authenticated_user'}]);assert.deepEqual(method('getPickPackCarts').documented_preconditions,[{subject:'returned carts',requirement:'belong_to_authenticated_user'}]);
});
test('unrestricted cart-order read is not transferred to cart-list pagination; unassigned triple is exact0/empty/empty',()=>{
 assert.deepEqual(method('getPickPackCartOrders').pagination,{kind:'explicitly_unrestricted',parameters:[],result_cap:null,ordering:'most recently assigned first',completeness_guarantee:'all order IDs assigned to cart'});assert.match(method('getPickPackCartOrders').documented_intro,/without any pagination restrictions/);
 assert.deepEqual(method('getPickPackCarts').input.parameters,[]);assert.deepEqual(method('getPickPackCarts').pagination,{kind:'no_pagination_parameters_documented',result_cap:null,ordering:'not_documented',completeness_guarantee:'not_documented'});
 assert.deepEqual(method('getPickPackOrderCart').documented_unassigned_result,{cart_id:0,cart_name:'',cart_color:''});assert.match(field('getPickPackOrderCart','output','cart_id').documented_description,/0 if order is not assigned/);for(const p of ['cart_name','cart_color'])assert.match(field('getPickPackOrderCart','output',p).documented_description,/empty string if not assigned/);
});
test('all16 prose error occurrences have no invented type or table row and preserve original status description',()=>{
 let total=0;for(const m of c.methods){assert.deepEqual(m.input.embedded_documented_fields,[]);assert.deepEqual(m.output.embedded_documented_fields.map(f=>f.path),['error_message','error_code']);const status=field(m.method,'output','status');assert.equal(status.documented_type,'varchar(30)');
  for(const f of m.output.embedded_documented_fields){assert.equal(f.documented_type,null);assert.equal(f.source_kind,'output_table_row_description');assert.equal(f.source_table_row,1);assert.equal(f.documented_description,status.documented_description);assert.equal(f.presence_condition,'status=ERROR');assert(status.documented_description.includes(f.path));total++;}assert.equal(m.output.success_fields_on_error,'not_documented');
 }assert.equal(total,16);assert.deepEqual(c.common_error.status.values,['SUCCESS','ERROR']);assert.equal(c.common_error.error_field_types,'not_documented');assert.deepEqual(c.common_error.specific_error_codes,[]);assert.equal(c.common_error.http_statuses,'not_documented');
});
test('transport/source references are pinned and documentation grants no implementation, wire, provider or WMS acceptance',()=>{
 assert.equal(sha(read(c.normalization_basis.model)),c.normalization_basis.sha256);assert.equal(sha(read(c.shared_transport_ref.path)),c.shared_transport_ref.sha256);assert.equal(c.shared_transport_ref.pointer,'/shared_transport');
 assert.equal(c.documentation_only,true);assert.equal(c.operational_contract_fully_resolved,false);for(const k of ['official_account_requests_performed','implementation_coverage_measured','implementation_verified','wire_acceptance','provider_account_acceptance','acceptance_granted','scope_mutated'])assert.equal(c[k],false);
 for(const m of c.methods){assert.equal(m.contract_reviewed,true);for(const k of ['operational_contract_fully_resolved','implementation_verified','wire_acceptance','provider_account_acceptance','acceptance_granted'])assert.equal(m[k],false);assert(m.open_contract_issues.length>=2);}
 assert.match(c.boundary,/No automatic retry/);assert.match(c.boundary,/stock\/WMS, split\/merge/);assert.match(c.boundary,/do not establish page content17/);
});
test('registry resolves all204 primary contracts, preserves23 secondary sections and leaves all source/status612 plans unchanged',()=>{
 const registry=JSON.parse(read('base-api-contract-traceability-20261018.json'));
 const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v,digest=v=>sha(JSON.stringify(canonical(v))),selected=new Set(methods);
 assert.equal(registry.methods.length,204);assert.equal(new Set(registry.methods.map(m=>m.method)).size,204);assert.equal(new Set(registry.methods.map(m=>m.id)).size,204);
 assert.equal(digest(registry.methods.map(({contract,secondary_contracts,...rest})=>rest)),'82b316b68005f00ddb95e6019b2848c49baa2a0430c461cc725b8769a87e1fe1');
 assert.equal(digest(registry.methods.filter(m=>!selected.has(m.method))),'d32426fc7ae99d43d68d1f3020547295f53c588d1a3dcf2dedccabfb7239ab77');
 assert.equal(digest(registry.historical_source_coverage),'a7a2cfea457ba26c5663240716b6c999c728f55c6a7511b5959f6d8ec2a6a1d7');assert.equal(digest(registry.source_bundles),'56800651dbc58fdefedeeac00ddaf83fcf99c274d9af9ad73fe61949548b5e65');
 assert.equal(registry.summary.structured_json_contracts,134);assert.equal(registry.summary.markdown_only_contracts,70);assert.equal(registry.summary.linked_methods,204);assert.equal(registry.summary.unlinked_methods,0);assert.equal(registry.summary.individual_sources_captured_20261017,111);assert.equal(registry.summary.individual_sources_captured_20261018,93);
 const plans=registry.methods.flatMap(m=>m.acceptance_requirements.plans);assert.equal(plans.length,612);assert(plans.every(p=>p.status==='NOT_RUN'));
 assert.equal(registry.contract_documents.length,18);assert.equal(new Set(registry.contract_documents.map(r=>r.path)).size,18);
 const docBytes=new Map(registry.contract_documents.map(ref=>{const b=readRetainedRevision(sourceRoot,ref.path);assert.equal(b.length,ref.bytes);assert.equal(sha(b),ref.sha256);return[ref.path,b];}));
 const pointer=(value,p)=>p.split('/').slice(1).reduce((v,k)=>{k=k.replace(/~1/g,'/').replace(/~0/g,'~');assert(Object.hasOwn(v,k),'JSON pointer exists');return v[k];},value);
 let primaryJson=0,primaryMd=0,secondary=0;
 const markdown=link=>{const bytes=docBytes.get(link.document);assert(bytes);assert.equal(sha(bytes),link.document_sha256);const text=bytes.toString('utf8'),start=text.indexOf('### '+link.heading+'\n');assert(start>=0);assert.equal(text.slice(0,start).split('\n').length,link.line);const tail=text.slice(start),next=[...tail.matchAll(/^#{2,3} /gm)].find(h=>h.index>0)?.index;assert.equal(sha(next===undefined?tail:tail.slice(0,next)),link.section_sha256);};
 for(const row of registry.methods){const link=row.contract,bytes=docBytes.get(link.document);assert(bytes);assert.equal(sha(bytes),link.document_sha256);
  if(link.format==='structured_json'){const resolved=pointer(JSON.parse(bytes),link.json_pointer);assert.equal(resolved.method,row.method);assert.equal(resolved.id,row.id);primaryJson++;}else{assert.equal(link.format,'markdown_tables_and_prose');markdown(link);primaryMd++;}
  for(const link of row.secondary_contracts??[]){markdown(link);secondary++;}
 }
 assert.deepEqual([primaryJson,primaryMd,secondary],[134,70,23]);
 for(const[i,m]of c.methods.entries()){const row=registry.methods.find(r=>r.method===m.method);assert.deepEqual(row.contract,{document:'docs/parity/base-api-pickpack-contracts.v1.json',document_sha256:sha(fs.readFileSync(path.join(root,'docs/parity/base-api-pickpack-contracts.v1.json'))),format:'structured_json',json_pointer:'/methods/'+i});assert.equal(row.secondary_contracts.length,1);assert.equal(row.secondary_contracts[0].document,'docs/parity/base-api-pickpack-contracts-20261018.md');assert.equal(row.secondary_contracts[0].heading,m.method);
  const s=source.documents[i];assert.equal(row.source.bundle_document_pointer,'/documents/'+i);assert.equal(row.source.html_pointer,'/documents/'+i+'/html_utf8');assert.equal(row.source.bundle_sha256,c.source_snapshot.sha256);assert.equal(row.source.html_sha256,s.sha256);assert.equal(row.source.html_bytes,s.bytes);assert.equal(row.source.retrieved_at,s.retrieved_at);assert.equal(row.source.url,s.url);assert.equal(row.source.final_url,s.final_url);
 }
});
