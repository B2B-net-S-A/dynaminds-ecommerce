/** Documentation integrity only: no application, network, DB or account client. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {readRetainedRevision} from '../tools/parity/base-api-retained-revisions.mjs';
const stagedRoot=fileURLToPath(new URL('../',import.meta.url));
const sourceRoot=process.env.DYNA_DOC_SOURCE_ROOT??stagedRoot;
const {JSDOM}=createRequire(path.join(sourceRoot,'package.json'))('jsdom');
const sha=b=>createHash('sha256').update(b).digest('hex');
const bytes=fs.readFileSync(stagedRoot+'docs/parity/base-api-purchase-order-contracts.v1.json');
const c=JSON.parse(bytes),read=n=>fs.readFileSync(path.join(sourceRoot,'docs/parity',n));
const method=n=>{const m=c.methods.find(m=>m.method===n);assert(m,n);return m;};
const field=(m,d,p)=>{const f=method(m)[d][d==='input'?'parameters':'fields'].find(f=>(f.name??f.path)===p);assert(f,m+':'+p);return f;};
const names=['addInventoryPurchaseOrder','addInventoryPurchaseOrderFile','addInventoryPurchaseOrderItems','getInventoryPurchaseOrderFile','getInventoryPurchaseOrderItems','getInventoryPurchaseOrderLogs','getInventoryPurchaseOrderSeries','getInventoryPurchaseOrders','setInventoryPurchaseOrderStatus'];
const source=JSON.parse(gunzipSync(read(c.source_snapshot.path),{maxOutputLength:2*1024*1024}));
test('complete Purchase orders9 matches the independently frozen index, excluding Transfers6',()=>{
 assert.equal(sha(read(c.method_inventory_ref)),'7e6b10f8fd105973ec99926372fcc7ae3ec6a2496514d3d45d2cc59af4c7d992');
 const index=JSON.parse(read(c.method_inventory_ref));assert.deepEqual(c.methods.map(m=>m.method),names);
 assert.deepEqual(names,index.methods.filter(m=>m.family==='Product catalog'&&m.group==='Purchase orders').map(m=>m.method));
 assert.equal(c.method_count,9);assert.equal(source.documents.length,15);
 assert.equal(sha(read(c.source_snapshot.path)),'401288efad4ec411e73545b123ea041fcb19ac7a0dcc422d891c25b0920a77bc');
});
test('all124 table rows retain exact archived names/types/descriptions, hierarchy and row provenance',()=>{
 const totals={input:0,output:0};
 for(const m of c.methods){const s=source.documents.find(s=>s.method===m.method);assert.equal(sha(Buffer.from(s.html_utf8)),m.source.sha256);assert.equal(Buffer.byteLength(s.html_utf8),m.source.bytes);const dom=new JSDOM(s.html_utf8);try{
  const headers=[...dom.window.document.querySelectorAll('div.header')];const range=dom.window.document.createRange();range.setStartAfter(headers.find(h=>h.textContent.trim()===m.method));range.setEndBefore(headers.find(h=>h.textContent.trim()==='Input parameters'));assert.equal(range.toString().replace(/\s+/g,' ').trim(),m.documented_intro);
  for(const [direction,title]of[['input','Input parameters'],['output','Output data']]){const h=[...dom.window.document.querySelectorAll('div.header')].find(h=>h.textContent.trim()===title);assert(h);const rows=[...h.nextElementSibling.querySelectorAll('tr')],fields=m[direction][direction==='input'?'parameters':'fields'];assert.equal(rows.length,fields.length);let parent=null;
   for(const [i,row]of rows.entries()){const [name,type,desc]=[...row.children].map(n=>n.textContent.replace(/\s+/g,' ').trim());const child=name.startsWith('| - '),expectedPath=child?parent+'[].'+name.slice(4):name;if(!child)parent=type==='array'?name:null;
    const f=fields[i];assert.equal(f.documented_name,name);assert.equal(f.documented_type,type);assert.equal(f.documented_description,desc);assert.equal(f.source_table_row,i+1);assert.equal(f.source_kind,'table_row');assert.equal(f.name??f.path,expectedPath);totals[direction]++;
    for(const nested of m[direction].embedded_documented_fields.filter(n=>n.source_table_row===i+1)){const compact=s=>s.replace(/\s+/g,'');assert(compact(desc).includes(compact(nested.documented_description)));assert(compact(desc).includes(compact(nested.documented_name+' ('+nested.documented_type+') -')));}
   }
  }
 }finally{dom.window.close();}}
 assert.deepEqual(totals,{input:53,output:71});assert.deepEqual(c.field_inventory,{input_table_rows:53,output_table_rows:71,embedded_input_prose_fields:0,embedded_output_prose_fields:13});
});
test('requiredness is not inferred from IDs, should-contain prose or examples; conditional requirement stays conditional',()=>{
 const unknown=[['addInventoryPurchaseOrder','warehouse_id'],['addInventoryPurchaseOrder','supplier_id'],['addInventoryPurchaseOrder','payer_id'],['addInventoryPurchaseOrder','currency'],['addInventoryPurchaseOrder','additional_costs[].name'],['addInventoryPurchaseOrderItems','items[].product_id'],['addInventoryPurchaseOrderItems','items[].quantity'],['setInventoryPurchaseOrderStatus','completed_items[].item_id'],['setInventoryPurchaseOrderStatus','completed_items[].completed_quantity']];
 for(const [m,p]of unknown){const f=field(m,'input',p);assert.equal(f.required,null);assert.equal(f.requiredness_source,'not_explicitly_marked');}
 for(const m of c.methods)for(const f of m.input.parameters){assert.equal(f.required,f.documented_description.startsWith('(optional)')?false:null);assert.equal(f.requiredness_source,f.required===false?'explicit_optional':'not_explicitly_marked');}
 const conditional=field('addInventoryPurchaseOrder','input','packages[].courier_other_name');assert.equal(conditional.required,false);assert.deepEqual(conditional.required_when,{parameter:'packages[].courier_code',equals:'other',source_text:'Required when courier_code is "other".'});
 assert.equal(field('getInventoryPurchaseOrderSeries','input','warehouse_id').required,false);
});
test('golden nested fields preserve deliberate type/identifier asymmetries and no invented defaults',()=>{
 assert.equal(field('addInventoryPurchaseOrder','output','order_id').documented_type,'int');assert.equal(field('addInventoryPurchaseOrderFile','input','purchase_order_id').documented_type,'int');
 assert.equal(field('addInventoryPurchaseOrderItems','input','items[].location').documented_type,'varchar(255)');assert.equal(field('getInventoryPurchaseOrderItems','output','items[].location').documented_type,'varchar(2550)');
 assert.equal(field('addInventoryPurchaseOrderItems','input','items[].expiry_date').documented_type,'text');assert.equal(field('getInventoryPurchaseOrderItems','output','items[].expiry_date').documented_type,'varchar(10)');
 assert.equal(field('addInventoryPurchaseOrder','input','additional_costs[].cost').documented_type,'decimal(10,2)');assert.equal(field('addInventoryPurchaseOrder','input','additional_costs[].cost').minimum,'0.01');
 assert.deepEqual(method('getInventoryPurchaseOrderItems').pagination,{kind:'page',input:'page',page_size:100,unit:'items',first_page:1,default_page:'not_documented',ordering:'not_documented',completeness_guarantee:'not_documented'});
 assert.equal(method('getInventoryPurchaseOrderLogs').pagination.first_page,null);assert.equal(method('getInventoryPurchaseOrders').pagination.first_page,null);
 const sort=field('getInventoryPurchaseOrderLogs','input','sort');assert.equal(sort.default,'ASC');assert.equal(sort.default_status,'documented');
 const defaults=c.methods.flatMap(m=>m.input.parameters.filter(f=>f.default_status==='documented').map(f=>[m.method,f.name,f.default]));assert.deepEqual(defaults,[['getInventoryPurchaseOrderLogs','sort','ASC']]);
});
test('all13 prose fields have explicit golden names, types and conditional log bindings',()=>{
 const log=method('getInventoryPurchaseOrderLogs').output.embedded_documented_fields,po=method('getInventoryPurchaseOrders').output.embedded_documented_fields;
 const types=[['log_type','text'],['status_key','text'],['field_key','text'],['previous_value','text'],['email_recipient','text'],['items_changes_count','int'],['landed_costs_changes_count','int'],['packages_changes_count','int'],['item_negotiations_count','int'],['related_purchase_order_id','int'],['related_purchase_order_full_number','text']];
 assert.deepEqual(log.map(f=>[f.path,f.documented_type]),types.map(([n,t])=>['logs[].entries[].'+n,t]));
 assert.deepEqual(po.map(f=>[f.path,f.documented_type]),[['purchase_orders[].additional_cost[].name','varchar(30)'],['purchase_orders[].additional_cost[].cost','decimal(10,2)']]);
 for(const f of log){assert.equal(f.source_table_row,5);assert.equal(f.source_kind,'output_table_row_description');if(!f.path.endsWith('.log_type'))assert(f.returned_only_when?.values.length);}
 assert.deepEqual(log.find(f=>f.path.endsWith('.related_purchase_order_id')).returned_only_when,{field:'logs[].entries[].log_type',values:['purchase_order_merge','purchase_order_split']});
 assert.deepEqual(log.find(f=>f.path.endsWith('.status_key')).documented_values,['draft','sent','received_not_started','received','completed','completed_partially','canceled']);
 assert.deepEqual(field('getInventoryPurchaseOrderLogs','input','log_type').documented_item_values,[0,1,2,3,4,5,6,7,8,9,10,11]);
});
test('setter and getter status enums remain distinct; files retain data-prefix encoding without invented limits',()=>{
 assert.deepEqual(field('setInventoryPurchaseOrderStatus','input','status').documented_values,[0,1,2,3,4,5,6]);assert.deepEqual(field('getInventoryPurchaseOrders','output','purchase_orders[].status').documented_values,[0,1,2,3,4,5]);
 for(const [m,d]of[['addInventoryPurchaseOrderFile','input'],['getInventoryPurchaseOrderFile','output']]){const f=field(m,d,'file');assert.equal(f.documented_prefix,'data:');assert.equal(f.documented_encoding,'base64');assert.equal(f.documented_media_type,'PDF');assert.equal(f.max_bytes,undefined);}
 const itemIssues=method('addInventoryPurchaseOrderItems').open_contract_issues.join(' ');assert.match(itemIssues,/replaced or incremented/);assert.match(itemIssues,/atomicity/);
});
test('existing v1 conventions and source transport are reused without granting runtime, wire or provider acceptance',()=>{
 assert.equal(sha(read(c.normalization_basis.model)),c.normalization_basis.sha256);const basis=JSON.parse(read(c.normalization_basis.model));assert.deepEqual(c.requiredness_policy,basis.requiredness_policy);assert.deepEqual(c.common_error,basis.common_error);
 assert.equal(c.shared_transport_ref.pointer,'/shared_transport');assert.equal(c.shared_transport_ref.sha256,c.normalization_basis.sha256);
 for(const name of['official_account_requests_performed','implementation_coverage_measured','acceptance_granted','scope_mutated','operational_contract_fully_resolved'])assert.equal(c[name],false);
 for(const m of c.methods){assert.equal(m.implementation_verified,false);assert.equal(m.acceptance_granted,false);assert.equal(m.operational_contract_fully_resolved,false);assert.equal(m.mutation_idempotency,'not_documented');assert.equal(m.errors.permission_matrix,'not_documented');assert(m.open_contract_issues.length);}
});
test('current registry links exactly nine normalized JSON records and retains secondary Markdown provenance without changing204 sources or acceptance',()=>{
 const registry=JSON.parse(fs.readFileSync(stagedRoot+'docs/parity/base-api-contract-traceability-20261018.json'));
 const index=JSON.parse(read('base-api-methods.v1.json'));
 assert.equal(registry.methods.length,204);assert.deepEqual(registry.methods.map(m=>m.id),index.methods.map(m=>m.id));assert.equal(new Set(registry.methods.map(m=>m.id)).size,204);
 assert.equal(registry.summary.linked_methods,204);assert.equal(registry.summary.unlinked_methods,0);assert.equal(registry.summary.structured_json_contracts,registry.methods.filter(m=>m.contract.format==='structured_json').length);assert.equal(registry.summary.markdown_only_contracts,registry.methods.filter(m=>m.contract.format==='markdown_tables_and_prose').length);
 assert.equal(registry.summary.individual_sources_captured_20261017,111);assert.equal(registry.summary.individual_sources_captured_20261018,93);
 assert(registry.methods.every(m=>['structured_json','markdown_tables_and_prose'].includes(m.contract.format)));assert.equal(registry.summary.structured_json_contracts+registry.summary.markdown_only_contracts,204);
 const preservedFields=['id','method','index_family','index_group','source','documentation_link_verified','operational_contract_fully_resolved','local_route_mapping','local_route_mapping_status','implementation','wire','provider_account','acceptance_granted','acceptance_requirements'];
 const projection=registry.methods.map(m=>Object.fromEntries(preservedFields.map(k=>[k,m[k]])));
 assert.equal(sha(JSON.stringify(projection)),'2e8c3d124251230a0faba09e2c330b48e1c3a969ff761bf990a575f6e0a0f4b6');
 assert.equal(sha(JSON.stringify(registry.contract_documents.slice(0,15))),'8f377b4374fb45070e859a3db38af6b4f3560568fa196266c6b4ce0732c302ed');
 assert.equal(sha(JSON.stringify(registry.source_bundles)),'e23ccf97c1f152d575c3467a01a129e6feb729aa3eee832a2f09de90a0e58cd9');
 assert.equal(new Set(registry.contract_documents.map(r=>r.path)).size,registry.contract_documents.length);const documentPaths=new Set(registry.contract_documents.map(r=>r.path));for(const m of registry.methods)for(const link of[m.contract,...(m.secondary_contracts??[])])assert(documentPaths.has(link.document));
 for(const ref of registry.contract_documents){const b=readRetainedRevision(sourceRoot,ref.path);assert.equal(b.length,ref.bytes);assert.equal(sha(b),ref.sha256);}
 const supplemented=registry.methods.filter(m=>names.includes(m.method)&&m.secondary_contracts);assert.deepEqual(supplemented.map(m=>m.method),names);
 for(const [i,m]of c.methods.entries()){
  const link=registry.methods.find(r=>r.method===m.method);assert.deepEqual(link.contract,{document:'docs/parity/base-api-purchase-order-contracts.v1.json',document_sha256:sha(bytes),format:'structured_json',json_pointer:'/methods/'+i});assert.equal(link.secondary_contracts.length,1);
  const md=link.secondary_contracts[0];assert.equal(md.format,'markdown_tables_and_prose');assert.equal(md.document,'docs/parity/base-api-purchase-transfer-contracts-20261018.md');assert.equal(md.heading,m.method);assert.equal(md.anchor,'#'+m.method.toLowerCase());
  const raw=fs.readFileSync(path.join(sourceRoot,md.document)),txt=raw.toString('utf8');assert.equal(sha(raw),md.document_sha256);const start=txt.indexOf('### '+m.method+'\n');assert(start>=0);assert.equal(txt.slice(0,start).split('\n').length,md.line);
  const tail=txt.slice(start),next=[...tail.matchAll(/^#{2,3} /gm)].find(h=>h.index>0)?.index;const section=next===undefined?tail:tail.slice(0,next);assert.equal(sha(section),md.section_sha256);
 }
 for(const m of registry.methods){assert.equal(m.operational_contract_fully_resolved,'UNKNOWN');assert.equal(m.local_route_mapping,null);for(const k of['implementation','wire','provider_account']){assert.equal(m[k].status,'UNKNOWN');assert.equal(m[k].verified,false);assert.deepEqual(m[k].evidence,[]);}assert.equal(m.acceptance_granted,false);assert.equal(m.acceptance_requirements.status,'NOT_RUN');assert(m.acceptance_requirements.plans.every(p=>p.status==='NOT_RUN'));}
 assert.equal(registry.methods.flatMap(m=>m.acceptance_requirements.plans).length,612);
 for(const k of['implementation_coverage_measured','wire_acceptance','provider_account_acceptance','acceptance_granted','scope_mutated'])assert.equal(registry[k],false);
 // 1a0af6d reconciled the live coverage to 204 and retained these exact 145/59 bytes as its historical snapshot.
 const coverage=JSON.parse(read('base-api-source-coverage-20261018.json'));assert.equal(coverage.historical_snapshot.path,'base-api-source-coverage-145-historical-20261018.json');
 assert.equal(coverage.historical_snapshot.sha256,'e8f63888ec977a01ebba06ecbb297b2db83d1732fff430ff9c9a98fc4968ca45');assert.equal(registry.historical_source_coverage.sha256,coverage.historical_snapshot.sha256);
 assert.equal(sha(read(coverage.historical_snapshot.path)),'e8f63888ec977a01ebba06ecbb297b2db83d1732fff430ff9c9a98fc4968ca45');
});
