/** Pure 222 split plan: exact grosze, physical recipes and the plan refusals.
 * The real SQL/RLS/native rows are covered by order-split222.database.test.ts. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { orderSplit222Plan, orderSplit222PreviewInput, type OrderSplit222Snapshot } from '../server/order-split222';

const id = (n: number) => `22200000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function snapshot(): OrderSplit222Snapshot {
  return {
    order: { id: id(1), total: 3 * 1999 + 1000 + 1500, shipping_cost: 1500, status: 'new' },
    items: [
      { id: id(11), product_id: id(21), sku: 'A', name: 'Kubek', quantity: 3, price: 1999, line_total: 5997, components: [{ product_id: id(21), quantity: 1 }] },
      // Imported line whose total is not price×quantity (3 units for 1000 grosze).
      { id: id(12), product_id: id(22), sku: 'B', name: 'Zestaw', quantity: 3, price: 333, line_total: 1000, components: [{ product_id: id(23), quantity: 2 }, { product_id: id(21), quantity: 1 }] },
    ],
    picks: [{ product_id: id(21), quantity: 6 }, { product_id: id(23), quantity: 6 }],
    reservations: [], locations: [],
  };
}
const input = (items: { item_id: string; quantity: number }[], shipping?: number) =>
  orderSplit222PreviewInput.parse({ client_key: id(99), items, ...(shipping === undefined ? {} : { shipping_cost_to_child: shipping }) });

test('exact lines move price×quantity; other lines move floor(total×moved/quantity) and the parent keeps the remainder', () => {
  const p = orderSplit222Plan(snapshot(), input([{ item_id: id(11), quantity: 1 }, { item_id: id(12), quantity: 1 }], 700));
  assert.deepEqual(p.lines.map(l => [l.item_id, l.child_line_total, l.parent_line_total_after, l.child_price, l.parent_price_after, l.parent_quantity_after]),
    [[id(11), 1999, 3998, 1999, 1999, 2], [id(12), 333, 667, 333, 333, 2]]);
  assert.deepEqual(p.totals, { parent_before: 8497, parent_after: 8497 - (1999 + 333 + 700), child: 1999 + 333 + 700 });
  assert.equal(p.totals.parent_after + p.totals.child, p.totals.parent_before);
  assert.deepEqual(p.shipping, { parent_after: 800, child: 700 });
  // Recipe units: A×1 plus the bundle's A×1 and C×2.
  assert.deepEqual(p.physical, [{ product_id: id(21), parent_after: 4, child: 2 }, { product_id: id(23), parent_after: 4, child: 2 }]);
  assert.equal(orderSplit222Plan(snapshot(), input([{ item_id: id(12), quantity: 2 }])).lines[0].child_line_total, 666);
});
test('plan refusals: empty parent, too many units, foreign line, too much shipping, duplicates', () => {
  const s = snapshot();
  assert.throws(() => orderSplit222Plan(s, input([{ item_id: id(11), quantity: 3 }, { item_id: id(12), quantity: 3 }])), (e: any) => e.status === 422 && /co najmniej jedną/.test(e.message));
  assert.throws(() => orderSplit222Plan(s, input([{ item_id: id(11), quantity: 4 }])), (e: any) => e.status === 422);
  assert.throws(() => orderSplit222Plan(s, input([{ item_id: id(13), quantity: 1 }])), (e: any) => e.status === 404);
  assert.throws(() => orderSplit222Plan(s, input([{ item_id: id(11), quantity: 1 }], 1501)), (e: any) => e.status === 422);
  assert.throws(() => input([{ item_id: id(11), quantity: 1 }, { item_id: id(11), quantity: 1 }]), (e: any) => e.name === 'ZodError');
  assert.throws(() => input([{ item_id: id(11), quantity: 0 }]), (e: any) => e.name === 'ZodError');
  assert.throws(() => input([]), (e: any) => e.name === 'ZodError');
  // A recipe needing more physical units than the order's picks is refused (inconsistent custody).
  const short = { ...s, picks: [{ product_id: id(21), quantity: 1 }, { product_id: id(23), quantity: 6 }] };
  assert.throws(() => orderSplit222Plan(short, input([{ item_id: id(11), quantity: 2 }])), (e: any) => e.status === 409);
  // A full move of one line with another remaining is allowed; the moved line leaves the parent.
  assert.equal(orderSplit222Plan(s, input([{ item_id: id(11), quantity: 3 }])).lines[0].parent_quantity_after, 0);
});
