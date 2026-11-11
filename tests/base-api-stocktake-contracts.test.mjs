/** Official archived DOM/contracts only. No app, network, PG, account or WMS acceptance. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
const {JSDOM}=createRequire(import.meta.url)('jsdom'),root=new URL('../docs/parity/',import.meta.url),read=n=>fs.readFileSync(new URL(n,root)),sha=b=>createHash('sha256').update(b).digest('hex');
const c=JSON.parse(read('base-api-stocktake-contracts.v1.json')),source=JSON.parse(gunzipSync(read(c.source_snapshot.path),{maxOutputLength:2*1024*1024})),index=JSON.parse(read(c.method_inventory_ref));
const method=n=>{const m=c.methods.find(m=>m.method===n);assert(m,n);return m;},field=(m,d,p)=>{const f=method(m)[d][d==='input'?'parameters':'fields'].find(f=>(f.name??f.path)===p);assert(f,m+':'+p);return f;};
test('all six indexed Stocktakes methods use the existing full official12-page archive without inventing implementation',()=>{
 assert.equal(sha(read(c.method_inventory_ref)),c.inventory_sha256);assert.deepEqual(c.methods.map(m=>m.method),index.methods.filter(m=>m.family==='Product catalog'&&m.group==='Stocktakes').map(m=>m.method));assert.equal(c.method_count,c.methods.length);assert.equal(c.method_count,6);
 const b=read(c.source_snapshot.path);assert.equal(b.length,c.source_snapshot.bytes);assert.equal(sha(b),c.source_snapshot.sha256);assert.equal(source.documents.length,c.source_snapshot.individual_documents);assert.equal(c.source_snapshot.selected_documents,c.methods.length);
});
test('every94 field and intro match original DOM cells, hierarchy, types and source rows exactly',()=>{
 let input=0,output=0;
 for(const m of c.methods){const d=source.documents.find(d=>d.method===m.method);assert(d);assert.equal(Buffer.byteLength(d.html_utf8),m.source.bytes);assert.equal(sha(d.html_utf8),m.source.sha256);for(const k of['url','final_url','retrieved_at','http_status','bytes','sha256'])assert.equal(m.source[k],d[k]);assert.equal(m.source.snapshot_document_method,m.method);
  const dom=new JSDOM(d.html_utf8);try{const headers=[...dom.window.document.querySelectorAll('div.header')],range=dom.window.document.createRange();range.setStartAfter(headers.find(h=>h.textContent.trim()===m.method));range.setEndBefore(headers.find(h=>h.textContent.trim()==='Input parameters'));assert.equal(range.toString().replace(/\s+/g,' ').trim(),m.documented_intro);
   for(const[direction,title]of[['input','Input parameters'],['output','Output data']]){const rows=[...headers.find(h=>h.textContent.trim()===title).nextElementSibling.querySelectorAll('tr')],fields=m[direction][direction==='input'?'parameters':'fields'];assert.equal(fields.length,rows.length);let parent=null;
    for(const[i,row]of rows.entries()){const cells=[...row.children].map(n=>n.textContent.replace(/\s+/g,' ').trim());assert.equal(cells.length,3);const[n,t,desc]=cells,child=n.startsWith('| - ');assert(!child||parent);const full=child?parent+'[].'+n.slice(4):n;if(!child)parent=t==='array'?n:null;const f=fields[i];assert.equal(f.name??f.path,full);assert.equal(f.documented_name,n);assert.equal(f.documented_type,t);assert.equal(f.documented_description,desc);assert.equal(f.source_kind,'table_row');assert.equal(f.source_table_row,i+1);if(t==='array')assert.equal(f.element_type,null);if(direction==='input')input++;else output++;}
    assert.deepEqual(m[direction].embedded_documented_fields,[]);
   }
  }finally{dom.window.close();}
 }assert.equal(input,39);assert.equal(output,55);assert.deepEqual(c.field_inventory,{input_table_rows:input,output_table_rows:output,embedded_input_prose_fields:0,embedded_output_prose_fields:0});
 // Preserve the published type literally, including its unusual2550 length.
 assert.equal(field('getInventoryStocktakeItems','output','items[].location_name').documented_type,'varchar(2550)');
});
test('conditional scope requiredness, defaults and manual override do not become unconditional IDs or guessed scope2',()=>{
 const n='addInventoryStocktake';for(const m of c.methods)for(const f of m.input.parameters){assert.equal(f.required,f.documented_description.startsWith('(optional)')?false:null);assert.equal(f.requiredness_source,f.required===false?'explicit_optional':'not_explicitly_marked');}
 assert.equal(field(n,'input','warehouse_id').required,null);assert.deepEqual(field(n,'input','scope').documented_values,[0,1,3,4,5]);
 for(const[p,v]of[['product_ids',1],['scope_zones',3],['scope_locations_prefix',4],['scope_random_count',5]]){const f=field(n,'input',p);assert.equal(f.required,false);assert.deepEqual(f.required_when,{parameter:'scope',equals:v});assert(f.documented_description.includes('Required when scope is '+v));}
 for(const[p,value]of[['priority',0],['approval_method','immediate'],['blind_count',false],['confirm_location',false],['allow_add_remove_items',false]]){const f=field(n,'input',p);assert.equal(f.default,value);assert.equal(f.default_status,'documented');assert(/default/i.test(f.documented_description));}
 assert.deepEqual(field(n,'input','allow_add_remove_items').scope_override,{scope:1,value:true});assert.match(field(n,'input','allow_add_remove_items').documented_description,/Always true for manual scope/);
 assert.equal(field(n,'input','scope_random_count').minimum,1);assert.equal(field(n,'input','scope_locations_prefix').documented_separator,';');assert.equal(field(n,'input','scope_locations_prefix').documented_example,'A-1;B-2');assert.equal(field(n,'input','date_due').minimum_parameter,'date_scheduled');assert.deepEqual(method(n).input.cross_field_constraints,[{parameter:'date_due',operator:'>=',other_parameter:'date_scheduled',source_text:'Must be later than or equal to date_scheduled.'}]);
 assert.equal(method(n).documented_effects.created_status,'draft');assert.equal(method(n).documented_preconditions,undefined,'no advanced-WMS restriction borrowed from Transfers');
});
test('expected versus counted quantities, draft matching and status effects remain distinct and source-qualified',()=>{
 const add=method('addInventoryStocktakeItems'),done=method('setInventoryStocktakeStatus');assert.deepEqual(add.documented_preconditions,[{subject:'stocktake_id',requirement:'draft_status'}]);assert.match(add.documented_intro,/draft status/);assert.equal(add.documented_effects.matching_product_and_all_other_parameters,'updates_existing_position');assert.equal(add.documented_effects.any_parameter_differs,'creates_new_position');
 for(const[n,p]of[['addInventoryStocktakeItems','items[].quantity'],['setInventoryStocktakeStatus','completed_items[].completed_quantity']]){const f=field(n,'input',p);assert.equal(f.minimum,0);assert.equal(f.required,null);assert.match(f.documented_description,/non-negative|not be negative/);}
 for(const[n,d,p]of[['getInventoryStocktakes','input','filter_stocktake_status'],['getInventoryStocktakes','output','stocktakes[].stocktake_status'],['setInventoryStocktakeStatus','input','status']])assert.deepEqual(field(n,d,p).documented_values,[0,1,2,3,4,5]);
 assert.equal(field('setInventoryStocktakeStatus','input','completed_items').required,false);assert.deepEqual(field('setInventoryStocktakeStatus','input','completed_items').allowed_statuses,[2,4,3]);assert.match(done.documented_intro,/verified quantities are applied to warehouse stock/);assert.equal(done.documented_effects.omitted_unverified_items,'not_documented','Transfers missing-goods rule is not imported');
 assert.deepEqual(field('addInventoryStocktake','output','items_preparation_status').documented_values,['ready','pending']);assert.deepEqual(field('getInventoryStocktakes','output','stocktakes[].items_preparation_status').documented_values,['ready','pending','error']);
});
test('page rules, zero sentinels and unknown replay/transition semantics remain explicit',()=>{
 for(const[n,unit]of[['getInventoryStocktakeItems','items'],['getInventoryStocktakes','stocktakes']]){assert.deepEqual(method(n).pagination,{kind:'page',input:'page',page_size:100,unit,first_page:1,default_page:'not_documented',ordering:'not_documented',completeness_guarantee:'not_documented'});assert(field(n,'input','page').documented_description.includes('100 '+unit+' per page, numbered from 1'));}
 for(const[p,meaning]of[['assigned_to','not assigned'],['date_completed','not completed'],['date_scheduled','not set'],['date_due','not set']]){const f=field('getInventoryStocktakes','output','stocktakes[].'+p);assert.equal(f.documented_zero_meaning,meaning);assert(f.documented_description.includes('0 if '+meaning));}
 for(const m of c.methods){assert.equal(m.mutation_idempotency,'not_documented');assert.equal(m.errors.permission_matrix,'not_documented');assert.equal(m.input.null_handling,'not_documented');assert(m.open_contract_issues.length>=2);}
});
test('normalization reuses source-bound conventions while all implementation/account/stock acceptance stays false',()=>{
 const b=JSON.parse(read(c.normalization_basis.model));assert.equal(sha(read(c.normalization_basis.model)),c.normalization_basis.sha256);assert.deepEqual(c.requiredness_policy,b.requiredness_policy);assert.deepEqual(c.common_error,b.common_error);assert.deepEqual(c.shared_transport_ref,b.shared_transport_ref);assert.equal(sha(read(c.shared_transport_ref.path)),c.shared_transport_ref.sha256);
 assert.equal(c.documentation_only,true);for(const k of['operational_contract_fully_resolved','official_account_requests_performed','implementation_coverage_measured','wire_acceptance','provider_account_acceptance','acceptance_granted','scope_mutated'])assert.equal(c[k],false);
 for(const m of c.methods)for(const k of['operational_contract_fully_resolved','implementation_verified','wire_acceptance','provider_account_acceptance','acceptance_granted'])assert.equal(m[k],false);
});
