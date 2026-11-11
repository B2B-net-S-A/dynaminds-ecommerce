/** Documentation integrity only. No application, network, DB or account client. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
const stagedRoot=fileURLToPath(new URL('../',import.meta.url)),sourceRoot=process.env.DYNA_DOC_SOURCE_ROOT??stagedRoot;
const {JSDOM}=createRequire(path.join(sourceRoot,'package.json'))('jsdom'),sha=b=>createHash('sha256').update(b).digest('hex');
const read=n=>fs.readFileSync(path.join(sourceRoot,'docs/parity',n));
const bytes=fs.readFileSync(stagedRoot+'docs/parity/base-api-transfer-contracts.v1.json'),c=JSON.parse(bytes);
const methods=['addInventoryTransfer','addInventoryTransferItems','getInventoryTransferItems','getInventoryTransferSeries','getInventoryTransfers','setInventoryTransferStatus'];
const method=n=>{const m=c.methods.find(m=>m.method===n);assert(m,n);return m;};
const field=(m,d,p)=>{const f=method(m)[d][d==='input'?'parameters':'fields'].find(f=>(f.name??f.path)===p);assert(f,m+':'+p);return f;};
const source=JSON.parse(gunzipSync(read(c.source_snapshot.path),{maxOutputLength:2*1024*1024}));
test('Transfers is the complete frozen six-method group from the original15-page archive; Purchase orders9 is unchanged',()=>{
 assert.equal(sha(read(c.method_inventory_ref)),'7e6b10f8fd105973ec99926372fcc7ae3ec6a2496514d3d45d2cc59af4c7d992');
 const index=JSON.parse(read(c.method_inventory_ref));assert.deepEqual(c.methods.map(m=>m.method),methods);assert.deepEqual(methods,index.methods.filter(m=>m.family==='Product catalog'&&m.group==='Transfers').map(m=>m.method));
 assert.equal(c.method_count,6);assert.equal(source.documents.length,15);assert.equal(sha(read(c.source_snapshot.path)),'401288efad4ec411e73545b123ea041fcb19ac7a0dcc422d891c25b0920a77bc');
 assert.equal(sha(read('base-api-purchase-order-contracts.v1.json')),'cffea36515949cc001c74a2483571b482acb4ffc7662655d22bb3cdee58c09fd');
});
test('all92 fields and every intro exactly match archived DOM including nested arrays, types and row provenance',()=>{
 let input=0,output=0;
 for(const m of c.methods){const s=source.documents.find(s=>s.method===m.method);assert.equal(sha(Buffer.from(s.html_utf8)),m.source.sha256);assert.equal(Buffer.byteLength(s.html_utf8),m.source.bytes);assert.equal(m.source.url,s.url);assert.equal(m.source.final_url,s.final_url);assert.equal(m.source.retrieved_at,s.retrieved_at);assert.equal(m.source.http_status,s.http_status);const dom=new JSDOM(s.html_utf8);try{
  const headers=[...dom.window.document.querySelectorAll('div.header')],range=dom.window.document.createRange();range.setStartAfter(headers.find(h=>h.textContent.trim()===m.method));range.setEndBefore(headers.find(h=>h.textContent.trim()==='Input parameters'));assert.equal(range.toString().replace(/\s+/g,' ').trim(),m.documented_intro);
  for(const[d,title]of[['input','Input parameters'],['output','Output data']]){const rows=[...headers.find(h=>h.textContent.trim()===title).nextElementSibling.querySelectorAll('tr')],fields=m[d][d==='input'?'parameters':'fields'];assert.equal(fields.length,rows.length);let parent=null;assert.deepEqual(m[d].embedded_documented_fields,[]);
   for(const[i,row]of rows.entries()){const cells=[...row.children].map(n=>n.textContent.replace(/\s+/g,' ').trim());assert.equal(cells.length,3);const[name,type,desc]=cells,child=name.startsWith('| - ');assert(!child||parent);const expected=child?parent+'[].'+name.slice(4):name;if(!child)parent=type==='array'?name:null;const f=fields[i];assert.equal(f.name??f.path,expected);assert.equal(f.documented_name,name);assert.equal(f.documented_type,type);assert.equal(f.documented_description,desc);assert.equal(f.source_table_row,i+1);assert.equal(f.source_kind,'table_row');assert(!/\b[a-z_]+ \((?:int|text|varchar\(\d+\))\) - /.test(desc),'No unnormalized prose-only field');if(d==='input')input++;else output++;}
  }
 }finally{dom.window.close();}}
 assert.equal(input,36);assert.equal(output,56);assert.deepEqual(c.field_inventory,{input_table_rows:36,output_table_rows:56,embedded_input_prose_fields:0,embedded_output_prose_fields:0});
});
test('explicit optional/default constraints do not turn unmarked IDs or nested quantity into invented required fields',()=>{
 for(const m of c.methods)for(const f of m.input.parameters){assert.equal(f.required,f.documented_description.startsWith('(optional)')?false:null);assert.equal(f.requiredness_source,f.required===false?'explicit_optional':'not_explicitly_marked');}
 for(const p of['warehouse_id','target_warehouse_id'])assert.equal(field('addInventoryTransfer','input',p).required,null);
 for(const p of['transfer_id','items','items[].product_id','items[].quantity'])assert.equal(field('addInventoryTransferItems','input',p).required,null);
 assert.equal(field('setInventoryTransferStatus','input','completed_items').required,false);assert.equal(field('setInventoryTransferStatus','input','completed_items[].item_id').required,null);
 const defaults=c.methods.flatMap(m=>m.input.parameters.filter(f=>f.default_status==='documented').map(f=>[m.method,f.name,f.default]));assert.deepEqual(defaults,[['addInventoryTransfer','transfer_type',0],['addInventoryTransfer','priority',0]]);
 assert.deepEqual(field('addInventoryTransfer','input','transfer_type').documented_values,[0,1,2]);assert.deepEqual(field('addInventoryTransfer','input','priority').documented_values,[0,1,2,3]);
 assert.deepEqual(method('addInventoryTransfer').input.cross_field_constraints,[{parameter:'date_due',operator:'>=',other_parameter:'date_scheduled',source_text:'Must be later than or equal to date_scheduled.'}]);
 assert.equal(field('addInventoryTransfer','input','date_due').required,false);
});
test('creation and item matching keep advanced-WMS, same-warehouse, positive-quantity and source-unit boundaries',()=>{
 const create=method('addInventoryTransfer'),add=method('addInventoryTransferItems');
 assert.deepEqual(create.documented_preconditions,[{subject:'warehouse_id',requirement:'belongs_to_inventory_with_advanced_WMS_enabled'},{subject:'target_warehouse_id',requirement:'belongs_to_inventory_with_advanced_WMS_enabled'}]);
 assert.deepEqual(create.documented_effects,{created_status:'draft',same_source_and_target_warehouse:{allowed:true,documented_context:'intra-warehouse location transfers',transfer_type_restriction:'not_documented'}});assert.deepEqual(add.documented_preconditions,[{subject:'transfer_id',requirement:'draft_status'}]);
 const quantity=field('addInventoryTransferItems','input','items[].quantity');assert.equal(quantity.documented_type,'int');assert.equal(quantity.minimum,1);assert.equal(quantity.documented_constraint,'positive integer');
 assert.equal(field('addInventoryTransferItems','input','items[].location_name').documented_reference,'existing WMS stock unit location');
 assert.deepEqual(add.documented_effects,{matching_product_and_all_other_parameters:'updates_existing_position',any_parameter_differs:'creates_new_position',wms_matching_fields:['items[].location_name','items[].expiry_date','items[].batch','items[].serial_no']});
 for(const p of['items[].location_name','items[].target_location_name'])assert.equal(field('addInventoryTransferItems','input',p).documented_type,'varchar(20)');
 assert.equal(field('addInventoryTransferItems','input','items[].expiry_date').documented_type,'varchar(10)');assert.match(add.open_contract_issues.join(' '),/replaces or increments/);assert.match(add.open_contract_issues.join(' '),/atomicity/);
});
test('completion marks only omitted unverified goods missing; transfer statuses, readback metrics and page rules stay distinct',()=>{
 const done=method('setInventoryTransferStatus');assert.deepEqual(field('setInventoryTransferStatus','input','status').documented_values,[0,1,2,3]);
 assert.deepEqual(done.documented_effects.on_completion,{unlisted_unverified_items:'marked_as_missing_goods',source_text:'When completing it, unverified items omitted from completed_items are marked as missing goods.'});
 assert.equal(field('setInventoryTransferStatus','input','completed_items').required,false);assert.equal(field('setInventoryTransferStatus','input','completed_items[].completed_quantity').minimum,undefined);
 for(const n of['getInventoryTransferItems','getInventoryTransfers'])assert.deepEqual(method(n).pagination,{kind:'page',input:'page',page_size:100,unit:n.endsWith('Items')?'items':'transfers',first_page:1,default_page:'not_documented',ordering:'not_documented',completeness_guarantee:'not_documented'});
 assert.deepEqual(field('getInventoryTransfers','input','filter_transfer_status').documented_values,[0,1,2,3]);assert.deepEqual(field('getInventoryTransfers','output','transfers[].transfer_status').documented_values,[0,1,2,3]);
 assert.equal(field('getInventoryTransferItems','output','items[].is_completed').documented_type,'bool');assert.equal(field('getInventoryTransferItems','output','items[].completed_quantity').documented_type,'int');
 for(const p of['compliant_items_count','not_compliant_items_count','missing_items_count'])assert.equal(field('getInventoryTransfers','output','transfers[].'+p).documented_type,'int');
 for(const[p,meaning]of[['assigned_to','not assigned'],['date_scheduled','not set'],['date_due','not set'],['date_status_change','no status change']])assert.equal(field('getInventoryTransfers','output','transfers[].'+p).documented_zero_meaning,meaning);
 assert.equal(field('addInventoryTransfer','input','assigned_to').default,undefined);
});
test('six current JSON pointers retain all original Markdown provenance and have independently valid source bindings',()=>{
 const registry=JSON.parse(fs.readFileSync(stagedRoot+'docs/parity/base-api-contract-traceability-20261018.json'));assert.equal(registry.methods.length,204);assert.equal(registry.summary.structured_json_contracts,registry.methods.filter(m=>m.contract.format==='structured_json').length);assert.equal(registry.summary.markdown_only_contracts,registry.methods.filter(m=>m.contract.format==='markdown_tables_and_prose').length);
 for(const[i,m]of c.methods.entries()){
  const link=registry.methods.find(r=>r.method===m.method);assert.deepEqual(link.contract,{document:'docs/parity/base-api-transfer-contracts.v1.json',document_sha256:sha(bytes),format:'structured_json',json_pointer:'/methods/'+i});assert.equal(link.secondary_contracts.length,1);const md=link.secondary_contracts[0];assert.equal(md.document,'docs/parity/base-api-purchase-transfer-contracts-20261018.md');assert.equal(md.format,'markdown_tables_and_prose');assert.equal(md.heading,m.method);assert.equal(md.anchor,'#'+m.method.toLowerCase());const raw=read('base-api-purchase-transfer-contracts-20261018.md'),txt=raw.toString();assert.equal(sha(raw),md.document_sha256);const start=txt.indexOf('### '+m.method+'\n');assert(start>=0);assert.equal(txt.slice(0,start).split('\n').length,md.line);const tail=txt.slice(start),next=[...tail.matchAll(/^#{2,3} /gm)].find(h=>h.index>0)?.index;assert.equal(sha(next===undefined?tail:tail.slice(0,next)),md.section_sha256);
  const archived=source.documents.find(s=>s.method===m.method);assert.equal(link.source.html_sha256,archived.sha256);assert.equal(link.source.html_bytes,archived.bytes);assert.equal(link.source.retrieved_at,archived.retrieved_at);assert.equal(link.source.bundle_sha256,c.source_snapshot.sha256);
  for(const k of['implementation','wire','provider_account']){assert.equal(link[k].status,'UNKNOWN');assert.equal(link[k].verified,false);assert.deepEqual(link[k].evidence,[]);}assert.equal(link.acceptance_requirements.status,'NOT_RUN');assert.equal(link.acceptance_granted,false);
 }
});
test('accepted v1 conventions are reused while role, replay, transition and stock effects remain unresolved',()=>{
 assert.equal(c.normalization_basis.model,'base-api-purchase-order-contracts.v1.json');assert.equal(sha(read(c.normalization_basis.model)),c.normalization_basis.sha256);const basis=JSON.parse(read(c.normalization_basis.model));assert.deepEqual(c.requiredness_policy,basis.requiredness_policy);assert.deepEqual(c.shared_transport_ref,basis.shared_transport_ref);assert.deepEqual(c.common_error,basis.common_error);
 for(const k of['official_account_requests_performed','implementation_coverage_measured','acceptance_granted','scope_mutated','operational_contract_fully_resolved'])assert.equal(c[k],false);
 for(const m of c.methods){assert.equal(m.implementation_verified,false);assert.equal(m.acceptance_granted,false);assert.equal(m.operational_contract_fully_resolved,false);assert.equal(m.mutation_idempotency,'not_documented');assert.equal(m.errors.permission_matrix,'not_documented');assert.equal(m.input.null_handling,'not_documented');assert(m.open_contract_issues.length);}
});
