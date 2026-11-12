/** Documentation integrity only. Imports no application, DB, credentials or account client. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {JSDOM} from 'jsdom';
import {baseCaptureSkip} from '../tools/parity/base-captures.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),dir=root+'docs/parity/',sha=b=>createHash('sha256').update(b).digest('hex');
const read=n=>JSON.parse(fs.readFileSync(dir+n));
const docs=read('base-api-document-contracts.v1.json'),products=read('base-api-inventory-products-contracts.v1.json');
function semanticText(node){
 if(node.nodeType===3)return node.textContent;
 const block=/^(BR|LI|P|DIV)$/.test(node.nodeName);
 return(block?'\n':'')+[...node.childNodes].map(semanticText).join('')+(block?'\n':'');
}
function embeddedFromCell(cell){const text=semanticText(cell).replace(/\s+/g,' ').trim(),matches=[...text.matchAll(/\b([a-z_]+) \((string|text|varchar|float|int|mixed|array)\) - /g)];return matches.map((m,i)=>({name:m[1],type:m[2],description:text.slice(m.index+m[0].length,matches[i+1]?.index).trim().replace(/\s+-$/,'')}));}
const expectedDocument={getInvoices:['name','sku','ean','price_brutto','price_netto','tax_rate','quantity','is_shipment','order_product_id'],getNewReceipts:['name','price_brutto','tax_rate','quantity','sku','ean'],getReceipt:['name','sku','ean','price_brutto','tax_rate','quantity'],getReceipts:['name','price_brutto','tax_rate','quantity','sku','ean']};
const expectedProducts={
 getInventoryParameters:['parameters[].options[].option_id','parameters[].options[].value_translations'],
 getInventoryProductLogs:['logs[].entries[].type','logs[].entries[].from','logs[].entries[].to','logs[].entries[].info'],
 getInventoryProductsData:[...['ean','quantity'].map(n=>'products{product_id}.ean_additional[].'+n),...['product_id','variant_id'].map(n=>'products{product_id}.links{storage_id}.'+n),...['name','sku','ean','asin','prices','stock','locations'].map(n=>'products{product_id}.variants{variant_id}.'+n),...['quantity','purchase_cost','expiry_date'].map(n=>'products{product_id}.stock_erp_units{warehouse_id}[].'+n),...['quantity','location','expiry_date','batch','serial_no'].map(n=>'products{product_id}.stock_wms_units{warehouse_id}[].'+n),...['id','product_code','cost'].map(n=>'products{product_id}.suppliers[].'+n),...['product_id','relation_type'].map(n=>'products{product_id}.relations[].'+n)]
};
test('DOM separators prevent prior-description words from entering typed names',()=>{
 const dom=new JSDOM('<table><tr><td>name (varchar) - item name<br>sku (varchar) - product SKU number<br>ean (varchar) - product EAN number<ul><li>quantity (int) - pieces</li><li>tax_rate (float) - tax</li></ul><p>from (mixed) - previous</p><div>to (mixed) - current</div></td></tr></table>');
 const fields=embeddedFromCell(dom.window.document.querySelector('td'));
 assert.deepEqual(fields.map(f=>f.name),['name','sku','ean','quantity','tax_rate','from','to']);assert.equal(fields[1].description,'product SKU number');assert.equal(fields[2].description,'product EAN number');dom.window.close();
});
test('document nested field names are explicit golden schemas, not prose tokens',()=>{
 for(const [method,names] of Object.entries(expectedDocument)){const m=docs.methods.find(x=>x.method===method);assert.deepEqual(m.output.embedded_documented_fields.filter(x=>x.source_kind==='output_table_row_description').map(f=>f.path.split('.').at(-1)),names);}
 assert.equal(docs.methods.flatMap(m=>m.output.embedded_documented_fields).length,30);
 assert.deepEqual(docs.methods.find(m=>m.method==='getInvoices').output.embedded_documented_fields.filter(f=>f.source_kind==='input_table_row_description').map(f=>f.path),['invoices[].gov_id','invoices[].gov_date','invoices[].gov_status']);
});
test('products nested fields retain map, unit-array, supplier and relationship identities',()=>{
 for(const [method,paths]of Object.entries(expectedProducts))assert.deepEqual(products.methods.find(m=>m.method===method).output.embedded_documented_fields.map(f=>f.path),paths);
 assert.deepEqual(products.methods.find(m=>m.method==='addInventoryProduct').input.embedded_documented_fields.map(f=>f.name),['ean_additional[].ean','ean_additional[].quantity']);
 assert.equal(products.field_inventory.embedded_output_prose_fields,30);
});
for(const contract of [docs,products])test(contract.schema+': exact captured HTML rows and independently walked prose',{skip:baseCaptureSkip(['docs/parity/'+contract.source_snapshot.path])},()=>{
 const bytes=fs.readFileSync(dir+contract.source_snapshot.path),capture=JSON.parse(gunzipSync(bytes));assert.equal(sha(bytes),contract.source_snapshot.sha256);assert.equal(capture.documents.length,contract.methods.length);
 for(const m of contract.methods){const s=capture.documents.find(x=>x.method===m.method);assert.equal(sha(Buffer.from(s.html_utf8)),m.source.sha256);assert.equal(Buffer.byteLength(s.html_utf8),m.source.bytes);const dom=new JSDOM(s.html_utf8),document=dom.window.document;try{
  for(const [direction,title,list]of[['input','Input parameters',m.input.parameters],['output','Output data',m.output.fields]]){const h=[...document.querySelectorAll('div.header')].find(x=>x.textContent.trim()===title);assert(h);const rows=h.nextElementSibling?.tagName==='TABLE'?[...h.nextElementSibling.querySelectorAll('tr')]:[];assert.equal(rows.length,list.length);for(const [i,row]of rows.entries()){const cells=[...row.children].filter(n=>n.nodeName==='TD'),a=cells.map(c=>c.textContent.replace(/\s+/g,' ').trim()),f=list[i],path=f.path??f.name;assert.equal(a.length,3);assert.equal(f.documented_type,a[1]);assert.equal(f.documented_description,a[2]);assert.equal(f.source_table_row,i+1);assert.equal(path.split('.').at(-1),a[0].replace(/^\| - /,''));const actual=[...(m.input.embedded_documented_fields??[]),...(m.output.embedded_documented_fields??[])].filter(f=>f.source_kind===direction+'_table_row_description'&&f.source_table_row===i+1);const expected=embeddedFromCell(cells[2]);assert.deepEqual(actual.map(f=>({name:(f.path??f.name).split('.').at(-1),type:f.documented_type,description:f.documented_description})),expected);}}
 }finally{dom.window.close();}}
});
test('selected groups stay exact and documentation never grants operational acceptance',()=>{
 const index=read('base-api-methods.v1.json');for(const c of[docs,products]){assert.equal(sha(fs.readFileSync(dir+c.method_inventory_ref)),c.inventory_sha256);assert.deepEqual(c.methods.map(m=>m.method).sort(),index.methods.filter(m=>c.selected_index_groups.some(g=>g.family===m.family&&g.group===m.group)).map(m=>m.method).sort());assert.equal(c.official_account_requests_performed,false);assert.equal(c.acceptance_granted,false);assert.equal(c.scope_mutated,false);for(const m of c.methods){assert.equal(m.acceptance_granted,false);assert.equal(m.implementation_verified,false);assert(c.current_code_mappings[m.current_code_mapping_ref]);assert(m.proposed_acceptance.length);}}
});
test('document snapshot and rows remain independent of corrected prose aliases',()=>{
 assert.equal(docs.source_snapshot.sha256,'bc78d68758a8a990fdddd3134d3d0676ae75765fee9f75d3d54b91c4cbbb9fe7');assert.equal(docs.field_inventory.input_table_rows,89);assert.equal(docs.field_inventory.output_table_rows,156);
 const names=[docs,products].flatMap(c=>c.methods.flatMap(m=>[...(m.input.embedded_documented_fields??[]),...m.output.embedded_documented_fields].map(f=>(f.name??f.path).split('.').at(-1))));for(const wrong of['namesku','numberean','pricetax_rate','piecesis_shipment','productsfrom','priceinfo','unitpurchase_cost'])assert(!names.includes(wrong));
});
