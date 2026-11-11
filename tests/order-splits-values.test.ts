/** Small real pure modules only: no app/DB/HTTP/factory or registration. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { calculateOrderSplit, OrderSplitError } from '../server/order-splits-values';
import { ORDER_SPLIT_LIMITS as L, orderSplitPreviewInput, orderSplitExecuteInput, orderSplitVersion, type OrderSplitSourceFrame } from '../server/order-splits-schema';
import { localInvoiceLineAmounts } from '../server/local-invoice-values';

const id = (n: number) => `${n.toString(16).padStart(8, '0')}-a000-4000-8000-000000000001`;
const orderId = id(1), tenant = id(2), warehouse = id(3), product = id(4), lineId = id(5);
function source(price = 123, quantity = 3, shipping = 1): OrderSplitSourceFrame {
  const total = price * quantity + shipping;
  return {
    schema: 'order-split-source/v1',
    order: { id: orderId, tenant_id: tenant, warehouse_id: warehouse, version: '17', source: 'manual', fulfillment_kind: 'sale', status: 'new', currency: 'PLN', payment_mode: 'prepaid', shipping_cost: shipping, total, channel_id: null, external_id: null, b2b_account_id: null, unsupported_business_fields: false },
    items: [{ id: lineId, order_id: orderId, product_id: product, product_kind: 'simple', quantity, price, vat: 23, line_total: price * quantity, components: [{product_id: product, quantity: 1}], scanned: 0, consumed_quantity: 0, released_quantity: 0 }],
    financial: {
      payment_entries: 0, source_payment_checks: 0, import_allocations: 0, payment_import_receipts: 0, source_payment_jobs: 0, payment_import_attempts: 0,
      balance: {currency: 'PLN', payment_mode: 'prepaid', received: 0, refunded: 0, credit: 0, return_credit: 0, cancelled_credit: 0, net: 0, overpayment: 0, collected: 0, remitted: 0, fees: 0, courier_due: 0, nominal: total, amount_due: total},
    },
    blockers: {documents: 0, invoice_plans: 0, corrections: 0, returns: 0, exchanges: 0, shipments: 0, provider_attempts: 0, parcel_plans: 0, active_picking_waves: 0, active_packing_sessions: 0, merge_lineage: 0, split_lineage: 0, external_intents: 0, non_active_reservations: 0, physical_scans: 0, consumed_quantity: 0, released_quantity: 0},
  };
}
function request() {
  return { client_key: id(10), source_order_id: orderId, expected_source_version: '17', children: [
    {slot_id: id(11), name: 'Pierwsze zamówienie', delivery_minor: 1, items: [{source_item_id: lineId, quantity: 1}]},
    {slot_id: id(12), name: 'Drugie zamówienie', delivery_minor: 0, items: [{source_item_id: lineId, quantity: 1}]},
  ] };
}
const clone = <T>(v: T): T => structuredClone(v);
const refused = (s: unknown, r: unknown, code: string) => assert.throws(() => calculateOrderSplit(s, r), e => e instanceof OrderSplitError && e.code === code);
const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);

test('canonical 1→3 conserves original amounts, quantities, price/VAT and the explicit shipping cent', () => {
  const s = source(), r = request(), sb = clone(s), rb = clone(r), v = calculateOrderSplit(s, r);
  assert.equal(v.ready, true); assert.deepEqual(v.blockers, []);
  assert.equal(v.financial_scope, 'unpaid_only_no_ledger_copy'); assert.equal(v.shipping_tax, 'not_allocated');
  assert.deepEqual(v.results.map(x => x.kind), ['child', 'child', 'retained_source']);
  assert.deepEqual(v.results.map(x => x.totals), [
    {items_gross_minor: 123, items_net_minor: 100, items_vat_minor: 23, delivery_minor: 1, total_minor: 124},
    {items_gross_minor: 123, items_net_minor: 100, items_vat_minor: 23, delivery_minor: 0, total_minor: 123},
    {items_gross_minor: 123, items_net_minor: 100, items_vat_minor: 23, delivery_minor: 0, total_minor: 123},
  ]);
  const rows = v.results.flatMap(x => x.items);
  assert.deepEqual(rows.map(x => [x.from_quantity, x.to_quantity]), [[0, 1], [1, 2], [2, 3]]);
  assert.equal(sum(rows.map(x => x.quantity)), 3); assert.equal(sum(v.results.map(x => x.totals.total_minor)), 370);
  for (const row of rows) {
    assert.equal(row.price, 123); assert.equal(row.vat, 23); assert.equal(row.product_id, product);
    assert.deepEqual(row.provenance, {source_order_id: orderId, source_version: '17', source_item_id: lineId, original_quantity: 3, original_price: 123, original_vat: 23, original_amounts: {gross_minor: 369, net_minor: 300, vat_minor: 69}, original_discount_gross_minor: null, original_price_adjustment_minor: 0});
  }
  assert.deepEqual(s, sb); assert.deepEqual(r, rb);
});

test('one-cent VAT residue is conserved but explicitly blocks current invoice rerounding', () => {
  const v = calculateOrderSplit(source(1), request()), rows = v.results.flatMap(x => x.items);
  assert.equal(v.ready, false);
  assert.deepEqual(rows.map(x => [x.gross_minor, x.net_minor, x.vat_minor]), [[1, 0, 1], [1, 1, 0], [1, 1, 0]]);
  assert.equal(sum(rows.map(x => x.net_minor)), 2); assert.equal(sum(rows.map(x => x.vat_minor)), 1);
  assert.deepEqual(v.blockers, [{code: 'VAT_ROUNDING_CONFLICT', slot_id: id(11), source_item_id: lineId, allocated: {gross_minor: 1, net_minor: 0, vat_minor: 1}, current_invoice_amounts: {gross_minor: 1, net_minor: 1, vat_minor: 0}}]);
  assert.deepEqual(localInvoiceLineAmounts(1n, 23), {gross_minor: '1', net_minor: '1', vat_minor: '0'});
  const r = request(); r.children = [{...r.children[0], items: [{source_item_id: lineId, quantity: 2}]}];
  const two = calculateOrderSplit(source(1), r);
  assert.deepEqual(two.results.map(x => x.items.map(i => [i.gross_minor, i.net_minor, i.vat_minor])), [[[2, 1, 1]], [[1, 1, 0]]]);
  assert.equal(two.ready, false); assert.equal(two.blockers[0].code, 'VAT_ROUNDING_CONFLICT');
});

test('1→2 and source-retained shipping are exact; the source keeps its identity and a real nonzero row', () => {
  const r = request(); r.children = [{...r.children[0], delivery_minor: 0}];
  const v = calculateOrderSplit(source(), r);
  assert.equal(v.ready, true); assert.equal(v.results[1].kind, 'retained_source');
  assert.equal(v.results[1].source_order_id, orderId); assert.equal(v.results[1].slot_id, null);
  assert.equal(v.results[1].items[0].quantity, 2); assert.equal(v.results[1].totals.delivery_minor, 1);
  assert.equal(v.results[0].totals.total_minor, 123); assert.equal(v.results[1].totals.total_minor, 247);
});

test('same SKU in two original rows retains distinct line provenance and permits moving one complete row', () => {
  const s = source(123, 3, 0); s.items.push({...clone(s.items[0]), id: id(6), price: 246, line_total: 738});
  s.order.total += 738; s.financial.balance.nominal = s.financial.balance.amount_due = s.order.total;
  const r = request(); r.children = [{...r.children[0], delivery_minor: 0, items: [{source_item_id: id(6), quantity: 3}]}];
  const v = calculateOrderSplit(s, r);
  assert.equal(v.ready, true); assert.equal(v.results[0].items[0].source_item_id, id(6));
  assert.equal(v.results[1].items[0].source_item_id, lineId); assert.equal(v.allocation_rows, 2);
  assert.equal(v.results[0].items[0].price, 246); assert.equal(v.results[1].items[0].price, 123);
  assert.equal(sum(v.results.map(x => x.totals.total_minor)), 1107);
});

test('slot UUID ordering is deterministic, names and caller intent are immutable, no new IDs are invented', () => {
  const s = source(), r = request(); r.children[0].name = '  Nazwa bez zmiany  ';
  const v = calculateOrderSplit(s, r), reversed = clone(r); reversed.children.reverse();
  const other = calculateOrderSplit(s, reversed); assert.deepEqual(v.results, other.results); assert.deepEqual(v.blockers, other.blockers);
  assert.deepEqual(v.request.children.map(c => c.slot_id), r.children.map(c => c.slot_id));
  assert.equal(v.results[0].name, '  Nazwa bez zmiany  '); assert(Object.isFrozen(v));
  assert(Object.isFrozen(v.request.children[0].items)); assert(Object.isFrozen(v.results[0].items[0].provenance.original_amounts));
  assert.throws(() => {v.results[0].items[0].price = 999;}); assert.throws(() => {v.blockers.push({} as never);});
  assert.deepEqual(calculateOrderSplit(s, r), v);
});

test('UUID/version/nested strict schemas refuse caller authority, new IDs, fractional money and extra fields', () => {
  const base = request();
  for (const version of ['0', '01', '+1', '1.0', 'abc', '9223372036854775808', 1, null]) assert.equal(orderSplitVersion.safeParse(version).success, false);
  assert(orderSplitVersion.safeParse('9223372036854775807').success);
  for (const mutate of [
    (r: any) => r.tenant_id = tenant, (r: any) => r.skip_stock = true,
    (r: any) => r.expected_source_version = '0', (r: any) => r.client_key = 'not-an-id',
    (r: any) => r.children[0].order_id = id(99), (r: any) => r.children[0].name = ' \t ',
    (r: any) => r.children[0].items[0].product_id = product,
    (r: any) => r.children[0].items[0].quantity = '1',
    (r: any) => r.children[0].delivery_minor = 0.1,
  ]) {const r = clone(base); mutate(r); assert.equal(orderSplitPreviewInput.safeParse(r).success, false); refused(source(), r, 'INVALID_REQUEST');}
  const e = {client_key: id(10), preview_id: id(11), scope_hash: 'a'.repeat(64), confirmed: true};
  assert(orderSplitExecuteInput.safeParse(e).success); assert(!orderSplitExecuteInput.safeParse({...e, confirmed: false}).success);
  assert(!orderSplitExecuteInput.safeParse({...e, source: source()}).success);
  const upper = clone(base); upper.source_order_id = orderId.toUpperCase(); upper.children[0].items[0].source_item_id = lineId.toUpperCase();
  assert.equal(calculateOrderSplit(source(), upper).source_order_id, orderId);
});

test('duplicate slots/rows, foreign or missing row IDs, over-allocation and empty source/results fail closed', () => {
  const base = request();
  const invalid: [any, string][] = [];
  let r: any = clone(base); r.children[1].slot_id = r.children[0].slot_id.toUpperCase(); invalid.push([r, 'INVALID_REQUEST']);
  r = clone(base); r.children[0].items.push(clone(r.children[0].items[0])); invalid.push([r, 'INVALID_REQUEST']);
  r = clone(base); r.children[0].items[0].source_item_id = id(99); invalid.push([r, 'UNKNOWN_SOURCE_ITEM']);
  r = clone(base); delete r.children[0].items[0].source_item_id; invalid.push([r, 'INVALID_REQUEST']);
  r = clone(base); r.children[0].items[0].quantity = 3; invalid.push([r, 'OVER_ALLOCATION']);
  r = clone(base); r.children[0].items[0].quantity = 2; invalid.push([r, 'EMPTY_RETAINED_SOURCE']);
  r = clone(base); r.children[0].items = []; invalid.push([r, 'INVALID_REQUEST']);
  r = clone(base); r.children = []; invalid.push([r, 'INVALID_REQUEST']);
  for (const quantity of [0, -1, 0.5, 100001, Number.NaN, Infinity]) {r = clone(base); r.children[0].items[0].quantity = quantity; invalid.push([r, 'INVALID_REQUEST']);}
  for (const [r, code] of invalid) refused(source(), r, code);
  const s = source(); s.items.push(clone(s.items[0])); refused(s, base, 'DUPLICATE_SOURCE_ITEM');
  const foreign = source(); foreign.items[0].order_id = id(99); refused(foreign, base, 'FOREIGN_SOURCE_ITEM');
});

test('shipping has no inferred allocation or default and cannot move more than the exact original cost', () => {
  let r: any = request(); r.children[1].delivery_minor = 1; refused(source(), r, 'DELIVERY_OVER_ALLOCATION');
  r = request(); delete r.children[0].delivery_minor; refused(source(), r, 'INVALID_REQUEST');
  for (const value of [-1, 0.5, '1', 1000001]) {r = request(); r.children[0].delivery_minor = value; refused(source(), r, 'INVALID_REQUEST');}
});

test('noncanonical historical gross is authoritative and never silently repriced', () => {
  const s = source(1133); s.items[0].line_total = 3401; s.order.total = 3402; s.financial.balance.nominal = s.financial.balance.amount_due = 3402;
  const v = calculateOrderSplit(s, request()), rows = v.results.flatMap(r => r.items);
  assert.deepEqual(rows.map(r => [r.price, r.gross_minor, r.price_adjustment_minor]), [[1133,1133,0],[1133,1134,1],[1133,1134,1]]);
  assert.equal(sum(rows.map(r => r.gross_minor)), 3401);assert(rows.every(r => r.discount_gross_minor === null));
  assert.equal(v.ready,false);assert(v.blockers.some(b => b.code==='INVOICE_LINE_ROUNDING_CONFLICT'));
  const wrong = source(); wrong.order.total++; wrong.financial.balance.amount_due++; wrong.financial.balance.nominal++;
  refused(wrong, request(), 'SOURCE_TOTAL_MISMATCH');
});

test('qty2 price1701 total3401 preserves exact gross/net/VAT and separately explicit one-cent discount', () => {
  const s=source(1701,2,7);s.items[0].line_total=3401;s.order.total=3408;s.financial.balance.nominal=s.financial.balance.amount_due=3408;
  const r=request();r.children=[{...r.children[0],delivery_minor:3}];
  const v=calculateOrderSplit(s,r),rows=v.results.flatMap(x=>x.items);
  assert.deepEqual(rows.map(i=>[i.quantity,i.price,i.gross_minor,i.net_minor,i.vat_minor,i.price_adjustment_minor,i.discount_gross_minor]),[[1,1701,1700,1382,318,-1,null],[1,1701,1701,1383,318,0,null]]);
  const original=localInvoiceLineAmounts(3401n,23);
  assert.equal(sum(rows.map(i=>i.net_minor)),Number(original.net_minor));assert.equal(sum(rows.map(i=>i.vat_minor)),Number(original.vat_minor));
  assert.deepEqual(v.results.map(x=>x.totals.delivery_minor),[3,4]);assert.equal(sum(v.results.map(x=>x.totals.total_minor)),3408);
  assert.deepEqual(v.remaining_quantities,[{source_item_id:lineId,original_quantity:2,moved_quantity:1,remaining_quantity:1}]);
  assert.equal(v.ready,true);assert.deepEqual(v.blockers,[]);
  s.items[0].discount_gross_minor=1;const discounted=calculateOrderSplit(s,r).results.flatMap(x=>x.items);
  assert.deepEqual(discounted.map(i=>i.discount_gross_minor),[1,0]);assert(discounted.every(i=>i.provenance.original_discount_gross_minor===1));
  assert(discounted.every(i=>i.price*i.quantity - i.discount_gross_minor! === i.gross_minor));
  s.items[0].discount_gross_minor=2;refused(s,r,'EXPLICIT_DISCOUNT_MISMATCH');
});

test('tiny historical discounted gross never allocates negative tax and retains original totals',()=>{
  const s=source(1,5,0);s.items[0].line_total=3;s.items[0].discount_gross_minor=2;s.order.total=3;s.financial.balance.nominal=s.financial.balance.amount_due=3;
  const r=request();r.children=Array.from({length:4},(_,n)=>({slot_id:id(11+n),name:'Fragment '+n,delivery_minor:0,items:[{source_item_id:lineId,quantity:1}]}));
  const v=calculateOrderSplit(s,r),rows=v.results.flatMap(x=>x.items);
  assert.deepEqual(rows.map(x=>[x.gross_minor,x.net_minor,x.vat_minor]),[[0,0,0],[1,0,1],[0,0,0],[1,1,0],[1,1,0]]);
  assert.equal(sum(rows.map(x=>x.gross_minor)),3);assert.equal(sum(rows.map(x=>x.net_minor)),2);assert.equal(sum(rows.map(x=>x.vat_minor)),1);
  assert.equal(sum(rows.map(x=>x.discount_gross_minor!)),2);assert(rows.every(x=>x.net_minor>=0&&x.net_minor<=x.gross_minor&&x.vat_minor>=0));
  assert.equal(v.ready,false);assert(v.blockers.some(b=>b.code==='VAT_ROUNDING_CONFLICT'));
});

test('foreign headers, currencies, incomplete frames, RMA/partial facts and previous split/merge cannot be admitted', () => {
  const base = source();
  for (const patch of [{source: 'shopify'}, {status: 'paid'}, {fulfillment_kind: 'replacement'}, {channel_id: id(99)}, {external_id: 'ext-1'}, {b2b_account_id: id(99)}, {unsupported_business_fields: true}]) {
    const s = clone(base); Object.assign(s.order, patch); assert.throws(() => calculateOrderSplit(s, request()));
  }
  refused(base, {...request(), source_order_id: id(99)}, 'SOURCE_ID_OR_VERSION_MISMATCH');
  refused(base, {...request(), expected_source_version: '18'}, 'SOURCE_ID_OR_VERSION_MISMATCH');
  for (const key of Object.keys(base.blockers) as (keyof typeof base.blockers)[]) {const s = clone(base); s.blockers[key] = 1; refused(s, request(), 'SOURCE_HISTORY_OR_PARTIAL_FULFILLMENT');}
  for (const key of ['scanned', 'consumed_quantity', 'released_quantity'] as const) {const s = clone(base); s.items[0][key] = 1; refused(s, request(), 'SOURCE_HISTORY_OR_PARTIAL_FULFILLMENT');}
  for (const key of ['currency', 'payment_mode'] as const) {const s = clone(base); if (key === 'currency') s.financial.balance.currency = 'EUR'; else s.financial.balance.payment_mode = 'cod'; refused(s, request(), 'FINANCIAL_HEADER_MISMATCH');}
  const missing: any = clone(base); delete missing.blockers.returns; refused(missing, request(), 'INVALID_SOURCE');
  const extra: any = clone(base); extra.order.actor_id = id(99); refused(extra, request(), 'INVALID_SOURCE');
  const bundle = clone(base); bundle.items[0].product_kind = 'bundle'; refused(bundle, request(), 'UNSUPPORTED_PRODUCT_KIND');
});

test('zero net is insufficient: reversed entries, source/import/link/attempt facts and every balance effect refuse', () => {
  const base = source();
  for (const key of ['payment_entries', 'source_payment_checks', 'import_allocations', 'payment_import_receipts', 'source_payment_jobs', 'payment_import_attempts'] as const) {
    const s = clone(base); s.financial[key] = 1; assert.equal(s.financial.balance.net, 0); refused(s, request(), 'FINANCIAL_HISTORY_UNSUPPORTED');
  }
  for (const key of ['received', 'refunded', 'credit', 'return_credit', 'cancelled_credit', 'net', 'overpayment', 'collected', 'remitted', 'fees', 'courier_due', 'nominal', 'amount_due'] as const) {
    const s = clone(base); s.financial.balance[key]++; refused(s, request(), 'UNPAID_FRAME_REQUIRED');
  }
});

test('100 result boundary and integer/budget limits reject overflow without allocating or omitting rows', () => {
  const s = source(123, 100, 0), r = request(); r.children = Array.from({length: 99}, (_, n) => ({slot_id: id(100 + n), name: 'Wynik '+n, delivery_minor: 0, items: [{source_item_id: lineId, quantity: 1}]}));
  const v = calculateOrderSplit(s, r); assert.equal(v.ready, true); assert.equal(v.results.length, 100); assert.equal(v.allocation_rows, 100); assert.equal(sum(v.results.map(x => x.totals.total_minor)), 12300);
  r.children.push({...clone(r.children[0]), slot_id: id(999)}); refused(s, r, 'INVALID_REQUEST');
  const huge = source(100000000, 100000, 0); huge.items[0].line_total = L.money_minor; huge.order.total = L.money_minor; huge.financial.balance.nominal = huge.financial.balance.amount_due = L.money_minor;
  const hugeRequest=request();hugeRequest.children[0].delivery_minor=0;const preserved=calculateOrderSplit(huge,hugeRequest);assert.equal(sum(preserved.results.map(x=>x.totals.total_minor)),L.money_minor);assert(preserved.results.flatMap(x=>x.items).every(i=>i.price===100000000&&Number.isSafeInteger(i.price_adjustment_minor)));
  const overflow: any = source(); overflow.items[0].line_total = 2147483648; refused(overflow, request(), 'INVALID_SOURCE');
  const oversized: any = request(); oversized.unknown = 'a'.repeat(L.request_bytes); refused(source(), oversized, 'REQUEST_BYTES');
});

test('source plus children share one allocation-row budget; product aggregates and int32 totals cannot wrap', () => {
  const many = source(0, 2, 0), r = request();
  many.items = Array.from({length: L.source_lines}, (_, n) => ({...clone(many.items[0]), id: id(1000 + n)}));
  r.children = [{...r.children[0], delivery_minor: 0, items: [{source_item_id: many.items[0].id, quantity: 1}]}];
  refused(many, r, 'ALLOCATION_ROW_BOUND');
  const physical = source(0, 100000, 0);
  physical.items = Array.from({length: 101}, (_, n) => ({...clone(physical.items[0]), id: n === 0 ? lineId : id(1000 + n)}));
  const small = request(); small.children = [{...small.children[0], delivery_minor: 0}];
  refused(physical, small, 'PRODUCT_QUANTITY_OVERFLOW');
  const aggregate = source(100000000, 21, 0);
  aggregate.items.push({...clone(aggregate.items[0]), id: id(6)});
  refused(aggregate, small, 'SOURCE_TOTAL_MISMATCH');
});

test('ordinary simple ORDER recipe is one self unit; catalogue-empty/foreign/multi/component quantities cannot masquerade as it', async () => {
  // Golden from domain.createOrder's simple branch: components=[{product_id:p.id,quantity:1}],
  // persisted unchanged in order_items. This is distinct from GET product.components=[].
  // Execute that actual small conditional expression with query forbidden: no
  // domain import, app, DB or synthetic reimplementation of its branch.
  const domain = readFileSync(new URL('../server/domain.ts', import.meta.url), 'utf8');
  const expression = domain.match(/\bconst components =([\s\S]*?);\n    ensure\(components.length > 0,/);
  assert(expression, 'Reviewed ordinary order recipe branch must remain present');
  const ordinaryRecipe = await new Function('p', 'productId', 'c', 'return (async () => (' + expression[1] + '))();')(
    {kind: 'simple'}, product, {query() {throw Error('No DB access allowed in pure recipe golden');}},
  );
  assert.deepEqual(ordinaryRecipe, [{product_id: product, quantity: 1}]);
  const s = source();
  s.items[0].components = ordinaryRecipe;
  const actual = calculateOrderSplit(s, request());
  assert.equal(actual.ready, true);
  assert.deepEqual(actual.results.map(r => r.items.map(i => [i.product_id, i.quantity])), [[[product, 1]], [[product, 1]], [[product, 1]]]);
  for (const recipe of [
    [],
    [{product_id: id(999), quantity: 1}],
    [{product_id: product, quantity: 2}],
    [{product_id: product, quantity: 1}, {product_id: id(999), quantity: 1}],
    [{product_id: product, quantity: 1}, {product_id: product, quantity: 1}],
  ]) {
    const invalid = clone(s); invalid.items[0].components = recipe;
    refused(invalid, request(), 'UNSUPPORTED_PRODUCT_RECIPE');
  }
  const missing: any = clone(s); delete missing.items[0].components;
  refused(missing, request(), 'INVALID_SOURCE');
  const zero: any = clone(s); zero.items[0].components[0].quantity = 0;
  refused(zero, request(), 'INVALID_SOURCE');
  const noncanonical: any = clone(s); noncanonical.items[0].components[0].warehouse_id = warehouse;
  refused(noncanonical, request(), 'INVALID_SOURCE');
});
