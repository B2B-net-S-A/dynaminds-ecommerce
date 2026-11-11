import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { parcelReturnOrigins, decideParcelReturnClaims, allocateParcelReturnFragments, type ParcelReturnClaim } from '../server/order-parcel-return-values';
const item = randomUUID(), product = randomUUID(), first = randomUUID(), second = randomUUID();
const claim = (id: string, fragments: { fragment_id: string; available: number }[], quantity = 1): ParcelReturnClaim => ({ origin_id: id, item_id: item, dispatch_id: randomUUID(), quantity, components: [{ product_id: product, quantity: 1 }], fragments: fragments.map(f => ({ ...f, product_id: product })) });
test('RMA wire requires a unique immutable item/dispatch pair and positive commercial quantities', () => {
 const x = { item_id: item, dispatch_id: randomUUID(), quantity: 1 };
 assert(parcelReturnOrigins.safeParse([x]).success);
 assert(!parcelReturnOrigins.safeParse([x,x]).success);
 assert(!parcelReturnOrigins.safeParse([{ ...x, quantity: 0 }]).success);
 assert(!parcelReturnOrigins.safeParse([{ ...x, price: 1000 }]).success);
});
test('partial receipt spends only original selected sources in immutable order; damaged units spend capacity without restock', () => {
 const claims = [claim(first, [], 2), claim(second, [], 2)];
 const d = decideParcelReturnClaims(claims, [{ item_id: item, accepted: 3, restocked: 1 }]);
 assert.deepEqual(d.map(d => [d.origin_id,d.accepted,d.restocked]), [[first,2,1],[second,1,0]]);
 assert.throws(() => decideParcelReturnClaims(claims,[{ item_id: item,accepted:5,restocked:0 }]));
 assert.throws(() => decideParcelReturnClaims(claims,[{ item_id:randomUUID(),accepted:1,restocked:0 }]));
});
test('duplicate SKU sales retain independent UUID ceilings even when their component is shared', () => {
 const other = randomUUID(), claims = [claim(first, []), { ...claim(second, []),item_id:other }];
 const d = decideParcelReturnClaims(claims,[{ item_id:item,accepted:1,restocked:0 },{ item_id:other,accepted:0,restocked:0 }]);
 assert.equal(d[0].accepted,1);assert.equal(d[1].accepted,0);
 assert.throws(() => decideParcelReturnClaims(claims,[{ item_id:item,accepted:2,restocked:0 },{ item_id:other,accepted:0,restocked:0 }]));
});
test('fragment matching reroutes a shared pick when greedy assignment would steal another origin only fragment', () => {
 const f1 = 'a', f2 = 'b', claims = [claim(first,[{fragment_id:f1,available:1},{fragment_id:f2,available:1}]),claim(second,[{fragment_id:f1,available:1}])];
 const d = decideParcelReturnClaims(claims,[{item_id:item,accepted:2,restocked:2}]);
 const map = allocateParcelReturnFragments(claims,d,[{issue_fragment_id:f1,quantity:1},{issue_fragment_id:f2,quantity:1}]);
 assert.deepEqual(map,[{origin_id:first,fragment_id:f2,product_id:product,quantity:1},{origin_id:second,fragment_id:f1,product_id:product,quantity:1}]);
});
test('same order fragment outside the chosen dispatch and overspent origin mapping are rejected', () => {
 const c = [claim(first,[{fragment_id:'own',available:1}])], d = decideParcelReturnClaims(c,[{item_id:item,accepted:1,restocked:1}]);
 assert.throws(() => allocateParcelReturnFragments(c,d,[{issue_fragment_id:'other',quantity:1}]));
 assert.throws(() => allocateParcelReturnFragments(c,d,[{issue_fragment_id:'own',quantity:2}]));
 assert.throws(() => allocateParcelReturnFragments(c.map(x=>({...x,fragments:x.fragments.map(f=>({...f,available:0}))})),d,[{issue_fragment_id:'own',quantity:1}]));
});
test('whole bundle receipt requires both original components, and zero restock creates no physical map', () => {
 const b = randomUUID(), c = [{...claim(first,[{fragment_id:'a',available:1}]),components:[{product_id:product,quantity:1},{product_id:b,quantity:2}],fragments:[{fragment_id:'a',product_id:product,available:1},{fragment_id:'b',product_id:b,available:2}]}];
 const d = decideParcelReturnClaims(c,[{item_id:item,accepted:1,restocked:1}]);
 assert.throws(() => allocateParcelReturnFragments(c,d,[{issue_fragment_id:'a',quantity:1}]));
 assert.equal(allocateParcelReturnFragments(c,d,[{issue_fragment_id:'a',quantity:1},{issue_fragment_id:'b',quantity:2}]).reduce((n,f)=>n+f.quantity,0),3);
 assert.deepEqual(allocateParcelReturnFragments(c,decideParcelReturnClaims(c,[{item_id:item,accepted:1,restocked:0}]),[]),[]);
});
