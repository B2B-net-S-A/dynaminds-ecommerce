import test from 'node:test';
import assert from 'node:assert/strict';
import {deriveCommercialParcelProducts,mapCommercialIssueFragments,type CommercialLine} from '../server/order-parcel-commercial-values';
import {orderParcelPreviewInput} from '../server/order-parcels-values';
const uid=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const line=(id:number,quantity:number,components:CommercialLine['components'],line_total=1001):CommercialLine=>({item_id:uid(id),product_id:uid(10),name:'Historyczna pozycja',sku:'SAME-SKU',quantity,line_total,vat:23,currency:'PLN',components});
test('two same-SKU lines retain separate historic UUIDs and amounts while sharing physical product',()=>{
 const lines=[line(1,2,[{product_id:uid(10),quantity:1}],1001),line(2,1,[{product_id:uid(10),quantity:1}],1700)];
 const result=deriveCommercialParcelProducts(lines,[{items:[{item_id:uid(1),quantity:1},{item_id:uid(2),quantity:1}]},{items:[{item_id:uid(1),quantity:1}]}]);
 assert.deepEqual(result[0].products,[{product_id:uid(10),quantity:2}]);
 assert.deepEqual(result[0].items.map(i=>[i.item_id,i.line_total]),[[uid(1),1001],[uid(2),1700]]);
 assert.equal(result[1].items[0].original_quantity,2);
});
test('complete frozen bundle units derive all components; over/under coverage and unknown UUID fail',()=>{
 const lines=[line(1,2,[{product_id:uid(10),quantity:1},{product_id:uid(11),quantity:2}])];
 assert.deepEqual(deriveCommercialParcelProducts(lines,[{items:[{item_id:uid(1),quantity:1}]},{items:[{item_id:uid(1),quantity:1}]}])[0].products,[{product_id:uid(10),quantity:1},{product_id:uid(11),quantity:2}]);
 for(const rows of [[{item_id:uid(1),quantity:1}],[{item_id:uid(1),quantity:3}],[{item_id:uid(99),quantity:2}]])assert.throws(()=>deriveCommercialParcelProducts(lines,[{items:rows}]));
 assert.throws(()=>deriveCommercialParcelProducts(lines,[{items:[{item_id:uid(1),quantity:1},{item_id:uid(1),quantity:1}]}]));
});
test('shared actual FIFO fragments are split once at dispatch independent of array order',()=>{
 const origins=[{origin_id:uid(101),item_id:uid(1),quantity:1,components:[{product_id:uid(10),quantity:2}]},{origin_id:uid(102),item_id:uid(2),quantity:1,components:[{product_id:uid(10),quantity:1}]}];
 const fragments=[{fragment_id:uid(202),product_id:uid(10),quantity:2},{fragment_id:uid(201),product_id:uid(10),quantity:1}];
 const expected=[{origin_id:uid(101),fragment_id:uid(201),product_id:uid(10),quantity:1},{origin_id:uid(101),fragment_id:uid(202),product_id:uid(10),quantity:1},{origin_id:uid(102),fragment_id:uid(202),product_id:uid(10),quantity:1}];
 assert.deepEqual(mapCommercialIssueFragments(origins,fragments),expected);
 assert.deepEqual(mapCommercialIssueFragments([...origins].reverse(),[...fragments].reverse()),expected);
 assert.throws(()=>mapCommercialIssueFragments(origins,[...fragments,{fragment_id:uid(203),product_id:uid(10),quantity:1}]));
 assert.throws(()=>mapCommercialIssueFragments(origins,fragments.slice(1)));
});
test('commercial schema rejects client physical components and partial/fractional units; legacy body remains literal',()=>{
 const base={client_key:uid(301),order_version:'1',protocol:'commercial_v1',parcels:[{source_kind:'demo',cod_minor:0,items:[{item_id:uid(1),quantity:1}]},{source_kind:'demo',cod_minor:0,items:[{item_id:uid(1),quantity:1}]}]};
 assert.deepEqual(orderParcelPreviewInput.parse(base),base);
 assert.equal(orderParcelPreviewInput.safeParse({...base,parcels:base.parcels.map(p=>({...p,products:[{product_id:uid(10),quantity:1}]}))}).success,false);
 assert.equal(orderParcelPreviewInput.safeParse({...base,parcels:base.parcels.map(p=>({...p,items:[{item_id:uid(1),quantity:0.5}]}))}).success,false);
 const legacy={client_key:uid(301),order_version:'1',parcels:base.parcels.map(p=>({source_kind:p.source_kind,cod_minor:p.cod_minor,products:[{product_id:uid(10),quantity:1}]}))};assert.deepEqual(orderParcelPreviewInput.parse(legacy),legacy);
});
test('invalid duplicate recipe and physical overflow fail without mutating historic source',()=>{
 const lines=[line(1,2,[{product_id:uid(10),quantity:1},{product_id:uid(10),quantity:1}])];const before=structuredClone(lines);assert.throws(()=>deriveCommercialParcelProducts(lines,[{items:[{item_id:uid(1),quantity:2}]}]));assert.deepEqual(lines,before);
 assert.throws(()=>deriveCommercialParcelProducts([line(1,2,[{product_id:uid(10),quantity:1000000}])],[{items:[{item_id:uid(1),quantity:2}]}]));
});
