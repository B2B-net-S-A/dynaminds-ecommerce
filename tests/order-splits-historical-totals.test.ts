/** Independent tiny-cent oracle against the actual pure production calculator.
 * Synthetic source frames only: no source capture, Native/API/UI or invoice issuance acceptance. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {calculateOrderSplit, OrderSplitError} from '../server/order-splits-values';
import {localInvoiceLineAmounts} from '../server/local-invoice-values';
import type {OrderSplitSourceFrame} from '../server/order-splits-schema';

const id = (n: number) => `${n.toString(16).padStart(8, '0')}-c000-4000-8000-000000000001`;
const order = id(1), tenant = id(2), warehouse = id(3), product = id(4), line = id(5);
const copy = <T>(value: T): T => structuredClone(value);
function source(price: number, quantity: number, gross: number, vat: 0|5|8|23 = 23, shipping = 0): OrderSplitSourceFrame {
  const total = gross + shipping;
  return {schema: 'order-split-source/v1',
    order: {id: order, tenant_id: tenant, warehouse_id: warehouse, version: '9223372036854775807', source: 'manual', fulfillment_kind: 'sale', status: 'new', currency: 'PLN', payment_mode: 'prepaid', shipping_cost: shipping, total, channel_id: null, external_id: null, b2b_account_id: null, unsupported_business_fields: false},
    items: [{id: line, order_id: order, product_id: product, product_kind: 'simple', quantity, price, vat, line_total: gross, components: [{product_id: product, quantity: 1}], scanned: 0, consumed_quantity: 0, released_quantity: 0}],
    financial: {payment_entries: 0, source_payment_checks: 0, import_allocations: 0, payment_import_receipts: 0, source_payment_jobs: 0, payment_import_attempts: 0,
      balance: {currency: 'PLN', payment_mode: 'prepaid', received: 0, refunded: 0, credit: 0, return_credit: 0, cancelled_credit: 0, net: 0, overpayment: 0, collected: 0, remitted: 0, fees: 0, courier_due: 0, nominal: total, amount_due: total}},
    blockers: {documents: 0, invoice_plans: 0, corrections: 0, returns: 0, exchanges: 0, shipments: 0, provider_attempts: 0, parcel_plans: 0, active_picking_waves: 0, active_packing_sessions: 0, merge_lineage: 0, split_lineage: 0, external_intents: 0, non_active_reservations: 0, physical_scans: 0, consumed_quantity: 0, released_quantity: 0}};
}
function request(quantities: number[], delivery: number[] = []) {
  return {client_key: id(10), source_order_id: order, expected_source_version: '9223372036854775807',
    children: quantities.map((quantity, n) => ({slot_id: id(20 + n), name: 'Wynik ' + n, delivery_minor: delivery[n] ?? 0, items: [{source_item_id: line, quantity}]}))};
}
const totals = (rows: any[]) => rows.map(r => [r.gross_minor, r.net_minor, r.vat_minor]);
function totalCheck(value: any, s: OrderSplitSourceFrame) {
  const rows = value.results.flatMap((r: any) => r.items);
  const sum = (field: string) => rows.reduce((n: number, r: any) => n + r[field], 0);
  assert.equal(sum('quantity'), s.items.reduce((n, r) => n + r.quantity, 0));
  assert.equal(sum('gross_minor'), s.items.reduce((n, r) => n + r.line_total, 0));
  assert.equal(sum('net_minor') + sum('vat_minor'), sum('gross_minor'));
  assert.equal(value.results.reduce((n: number, r: any) => n + r.totals.delivery_minor, 0), s.order.shipping_cost);
  assert.equal(value.results.reduce((n: number, r: any) => n + r.totals.total_minor, 0), s.order.total);
  for (const row of rows) assert(row.net_minor >= 0 && row.vat_minor >= 0 && row.net_minor + row.vat_minor === row.gross_minor);
  assert.equal(value.shipping_tax, 'not_allocated'); assert.equal(value.financial_scope, 'unpaid_only_no_ledger_copy');
}

test('literal historical3401 preserves price1701, one-cent source discrepancy, actual VAT and retained source identity', () => {
  const s = source(1701, 2, 3401, 23, 7), r = request([1], [3]), before = copy(s), v = calculateOrderSplit(s, r);
  const rows = v.results.flatMap(x => x.items);
  assert.deepEqual(totals(rows), [[1700, 1382, 318], [1701, 1383, 318]]);
  assert.deepEqual(rows.map(x => x.price), [1701, 1701]); assert.deepEqual(rows.map(x => x.vat), [23, 23]);
  assert.deepEqual(rows.map(x => x.price_adjustment_minor), [-1, 0]);
  assert(rows.every(x => x.provenance.original_discount_gross_minor === null && x.provenance.original_price_adjustment_minor === -1));
  assert.deepEqual(rows[0].provenance.original_amounts, {gross_minor: 3401, net_minor: 2765, vat_minor: 636});
  assert.equal(v.results[1].kind, 'retained_source'); assert.equal(v.results[1].source_order_id, order);
  assert.deepEqual(v.results.map(x => x.totals.total_minor), [1703, 1705]);
  assert.equal(v.ready, true); assert.deepEqual(s, before); totalCheck(v, s);
  assert.equal(v.rounding_method, 'cumulative_source_gross_then_net_by_gross_floor_children_then_remainder/v2');
  assert.deepEqual(v.remaining_quantities, [{source_item_id: line, original_quantity: 2, moved_quantity: 1, remaining_quantity: 1}]);
});

test('multiple unequal children and retained quantity conserve8503 and explicit shipping11 without repricing', () => {
  const s = source(1701, 5, 8503, 23, 11), r = request([1, 2], [3, 4]), v = calculateOrderSplit(s, r);
  assert.deepEqual(totals(v.results.flatMap(x => x.items)), [[1700, 1382, 318], [3401, 2765, 636], [3402, 2766, 636]]);
  assert.deepEqual(v.results.map(x => x.items[0].quantity), [1, 2, 2]);
  assert.deepEqual(v.results.map(x => x.totals.delivery_minor), [3, 4, 4]);
  assert.deepEqual(v.results.map(x => x.totals.total_minor), [1703, 3405, 3406]);
  assert.equal(v.ready, true); totalCheck(v, s);
  const reversed = copy(r); reversed.children.reverse(); assert.deepEqual(calculateOrderSplit(s, reversed).results, v.results);
});

test('explicit discount is separately conserved; an omitted discount is never inferred from historical gross', () => {
  const s = source(100, 4, 397, 0), r = request([1, 1]);
  const opaque = calculateOrderSplit(s, r), explicit = copy(s);
  explicit.items[0].discount_gross_minor = 3;
  const declared = calculateOrderSplit(explicit, r);
  assert.deepEqual(totals(declared.results.flatMap(x => x.items)), [[99, 99, 0], [99, 99, 0], [199, 199, 0]]);
  assert.deepEqual(declared.results.flatMap(x => x.items).map(x => x.discount_gross_minor), [1, 1, 1]);
  assert(opaque.results.flatMap(x => x.items).every(x => x.discount_gross_minor === null));
  assert(opaque.results.flatMap(x => x.items).every(x => x.provenance.original_discount_gross_minor === null));
  assert(declared.results.flatMap(x => x.items).every(x => x.provenance.original_discount_gross_minor === 3));
  assert.equal(declared.ready, true); assert.equal(opaque.ready, true); totalCheck(declared, explicit); totalCheck(opaque, s);
  const wrong = copy(explicit); wrong.items[0].discount_gross_minor = 2;
  assert.throws(() => calculateOrderSplit(wrong, r), e => e instanceof OrderSplitError);
});

test('a zero-cent allocated row retains physical quantity and genuine zero-price orders conserve without disappearing', () => {
  const s = source(1, 3, 2, 23), v = calculateOrderSplit(s, request([1, 1]));
  assert.deepEqual(totals(v.results.flatMap(x => x.items)), [[0, 0, 0], [1, 1, 0], [1, 1, 0]]);
  assert(v.results.every(x => x.items[0].quantity === 1)); assert.equal(v.ready, true); totalCheck(v, s);
  const free = source(0, 4, 0, 23, 1), f = calculateOrderSplit(free, request([1, 1], [1, 0]));
  assert.equal(f.results.length, 3); assert(f.results.flatMap(x => x.items).every(x => x.gross_minor === 0 && x.quantity > 0));
  totalCheck(f, free);
});

test('net tax is assigned to gross cents so deep discounts never create negative VAT; incompatible invoices still block', () => {
  const s = source(1, 5, 3, 23), v = calculateOrderSplit(s, request([1, 1, 1, 1]));
  assert.deepEqual(totals(v.results.flatMap(x => x.items)), [[0, 0, 0], [1, 0, 1], [0, 0, 0], [1, 1, 0], [1, 1, 0]]);
  assert.equal(v.ready, false); assert(v.blockers.some(x => x.code === 'VAT_ROUNDING_CONFLICT'));
  totalCheck(v, s);
});

test('current invoice157 commercial rounding rule blocks positive rounding even when every VAT helper result agrees', () => {
  const s = source(0, 3, 1, 0), v = calculateOrderSplit(s, request([1, 1]));
  assert.deepEqual(totals(v.results.flatMap(x => x.items)), [[0, 0, 0], [0, 0, 0], [1, 1, 0]]);
  assert.equal(v.ready, false); assert(v.blockers.some(x => x.code === 'INVOICE_LINE_ROUNDING_CONFLICT'));
  assert(v.blockers.every(x => x.code !== 'VAT_ROUNDING_CONFLICT'));
  const s2 = source(1700, 3, 5102, 0), v2 = calculateOrderSplit(s2, request([1, 1]));
  assert.deepEqual(v2.results.flatMap(x => x.items).map(x => x.gross_minor), [1700, 1701, 1701]);
  assert.equal(v2.ready, false); totalCheck(v2, s2);
});

/** Intentionally slow oracle: place indivisible gross cents into physical units,
 * then label exactly N of those G cents as net. It never evaluates the production
 * per-result floor-difference formula and is bounded to tiny synthetic money. */
function centLedger(gross: number, net: number, quantity: number) {
  const netTags = Array(gross).fill(false);
  for (let n = 1; n <= net; n++) netTags[Number((BigInt(n) * BigInt(gross) + BigInt(net) - 1n) / BigInt(net)) - 1] = true;
  const units = Array.from({length: quantity}, () => ({gross_minor: 0, net_minor: 0, vat_minor: 0}));
  for (let c = 1; c <= gross; c++) {
    const unit = units[Number((BigInt(c) * BigInt(quantity) + BigInt(gross) - 1n) / BigInt(gross)) - 1];
    unit.gross_minor++; if (netTags[c - 1]) unit.net_minor++; else unit.vat_minor++;
  }
  return units;
}

test('1080 tiny historical totals match the independent indivisible-cent oracle and preserve explicit invoice blockers', () => {
  let cases = 0;
  for (const vat of [0, 5, 8, 23] as const) for (let q = 3; q <= 6; q++) for (let p = 0; p <= 4; p++) for (let g = 0; g < p * q + q; g++) {
    const s = source(p, q, g, vat, 1), r = request(Array(q - 1).fill(1)), original = localInvoiceLineAmounts(g, vat);
    const expected = centLedger(g, Number(original.net_minor), q), v = calculateOrderSplit(s, r), actual = v.results.flatMap(x => x.items);
    assert.deepEqual(totals(actual), totals(expected), `cent ledger p=${p},q=${q},g=${g},vat=${vat}`);
    assert.equal(actual.reduce((n, x) => n + x.net_minor, 0), Number(original.net_minor));
    assert.equal(actual.reduce((n, x) => n + x.vat_minor, 0), Number(original.vat_minor));
    const taxMismatch = actual.some(x => Number(localInvoiceLineAmounts(x.gross_minor, vat).vat_minor) !== x.vat_minor);
    const invoiceRoundingMismatch = actual.some(x => x.gross_minor - x.price * x.quantity >= x.quantity);
    assert.equal(v.ready, !taxMismatch && !invoiceRoundingMismatch);
    if (taxMismatch) assert(v.blockers.some(x => x.code === 'VAT_ROUNDING_CONFLICT'));
    if (invoiceRoundingMismatch) assert(v.blockers.some(x => x.code === 'INVOICE_LINE_ROUNDING_CONFLICT'));
    totalCheck(v, s); cases++;
  }
  assert.equal(cases, 1080);
});

test('two rows of the same SKU keep distinct gross, price and tax provenance instead of being merged', () => {
  const s = source(1701, 2, 3401, 23, 3), extra = copy(s.items[0]);
  Object.assign(extra, {id: id(6), quantity: 3, price: 100, vat: 8, line_total: 299}); s.items.push(extra);
  s.order.total += 299; s.financial.balance.nominal = s.financial.balance.amount_due = s.order.total;
  const r = request([1], [1]); r.children[0].items.push({source_item_id: id(6), quantity: 2});
  const v = calculateOrderSplit(s, r);
  for (const input of s.items) {
    const rows = v.results.flatMap(x => x.items).filter(x => x.source_item_id === input.id);
    assert.equal(rows.reduce((n, x) => n + x.quantity, 0), input.quantity);
    assert.equal(rows.reduce((n, x) => n + x.gross_minor, 0), input.line_total);
    assert(rows.every(x => x.price === input.price && x.vat === input.vat && x.provenance.source_item_id === input.id));
  }
  totalCheck(v, s);
});

test('large signed commercial adjustment uses exact safe integers while historical gross and shipping retain money bounds', () => {
  const s = source(100000000, 100000, 0, 0, 1), v = calculateOrderSplit(s, request([50000], [1]));
  const rows = v.results.flatMap(x => x.items);
  assert.deepEqual(rows.map(x => x.price_adjustment_minor), [-5000000000000, -5000000000000]);
  assert(rows.every(x => Number.isSafeInteger(x.price_adjustment_minor) && x.provenance.original_price_adjustment_minor === -10000000000000));
  totalCheck(v, s);
  const overflow = copy(s); overflow.order.total = 2147483648;
  overflow.financial.balance.nominal = overflow.financial.balance.amount_due = overflow.order.total;
  assert.throws(() => calculateOrderSplit(overflow, request([1])), e => e instanceof OrderSplitError);
  assert.throws(() => calculateOrderSplit(s, request([1], [2])), e => e instanceof OrderSplitError && e.code === 'DELIVERY_OVER_ALLOCATION');
  const stale = copy(s); stale.blockers.split_lineage = 1;
  assert.throws(() => calculateOrderSplit(stale, request([1])), e => e instanceof OrderSplitError && e.code === 'SOURCE_HISTORY_OR_PARTIAL_FULFILLMENT');
});
