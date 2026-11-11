import test from 'node:test';
import assert from 'node:assert/strict';
import {manualOrderLines,manualOrderLinesIssue,prepareManualOrderLines} from '../server/manual-order-lines-values';
const product='a0000000-0000-4000-8000-000000000001';const other='a0000000-0000-4000-8000-000000000002';
const input={source:'manual',items:[{product_id:product,quantity:3}],manual_lines:[{product_id:product,quantity:1,line_total:1000},{product_id:product,quantity:2,line_total:1701}]};
test('same product retains two commercial totals, physical aggregate and nondivisible cents',()=>{
 const result=prepareManualOrderLines(input)!;assert.equal(result.lines.length,2);assert.deepEqual(result.lines.map(l=>[l.quantity,l.line_total]),[[1,1000],[2,1701]]);assert.equal(result.totals.get(product),2701);assert.equal(Math.floor(result.lines[1].line_total/result.lines[1].quantity),850);assert.equal(result.lines[1].line_total,1701);
 assert.deepEqual(prepareManualOrderLines({...input,source:'demo'})!.lines,result.lines);
});
test('exact aggregate coverage rejects missing, extra and misplaced units',()=>{
 for(const lines of [input.manual_lines.slice(0,1),[...input.manual_lines,{product_id:product,quantity:1,line_total:0}],[...input.manual_lines,{product_id:other,quantity:1,line_total:0}]])assert.throws(()=>prepareManualOrderLines({...input,manual_lines:lines}));
 assert.equal(manualOrderLinesIssue({...input,items:[{product_id:product,quantity:1},{product_id:product,quantity:2}]}),null);
 assert.equal(manualOrderLinesIssue({...input,items:[{product_id:product.toUpperCase(),quantity:3}]}),null);
});
test('no external/replacement/import or price-list escalation through public lines',()=>{
 for(const source of ['shopify','allegro','b2b','amazon'])assert.throws(()=>prepareManualOrderLines({...input,source}));
 assert.throws(()=>prepareManualOrderLines({...input,price_list_id:other}));
 for(const key of ['sourceTotals','importFragments','replacementAdmissionId','externalIntentLines','externalImportIntentLines','mappedInitial'])assert.throws(()=>prepareManualOrderLines(input,{[key]:{}}));
});
test('strict nested source cannot accept client origin, recipe, tax, discount or certificate',()=>{
 for(const field of ['id','components','vat','price','customer_item_id','admission_id','local_quantity'])assert.equal(manualOrderLines.safeParse([{...input.manual_lines[0],[field]:field==='components'?[]:1}]).success,false);
 for(const amount of [-1,0.5,2147483648,NaN])assert.equal(manualOrderLines.safeParse([{...input.manual_lines[0],line_total:amount}]).success,false);
 for(const quantity of [0,0.5,100001])assert.equal(manualOrderLines.safeParse([{...input.manual_lines[0],quantity}]).success,false);
 assert.equal(manualOrderLines.safeParse([]).success,false);assert.equal(manualOrderLines.safeParse(Array.from({length:101},()=>input.manual_lines[0])).success,false);
});
test('omission leaves imported/ordinary callers intact; zero price explicit and aggregate money bounded',()=>{
 assert.equal(prepareManualOrderLines({source:'shopify',items:input.items}, {sourceTotals:new Map()}),null);
 const body={...input,manual_lines:[{product_id:product,quantity:3,line_total:0}]};assert.equal(prepareManualOrderLines(body)!.totals.get(product),0);
 assert.throws(()=>prepareManualOrderLines({...input,manual_lines:[{product_id:product,quantity:1,line_total:2147483647},{product_id:product,quantity:2,line_total:1}]}));
 assert.equal(manualOrderLinesIssue({...input,items:[{product_id:product,quantity:200000}],manual_lines:[{product_id:product,quantity:100000,line_total:1},{product_id:product,quantity:100000,line_total:1}]}),'Za duża ilość produktu');
});
