import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  OdooSales,
  normalizeOdooOrder,
  parseOdooCursor,
  odooWindowSchema,
} from '../server/odoo-orders';
import { normalizeOrder, importSourceHash } from '../server/imports';
import { demoOdooOrder } from '../server/odoo-order-example';
import { odooOrderFixture, odooSettings, odooCredentials } from './odoo-order-fixture';
const settings = { simulation: true, company_id: '1', warehouse_id: '1', unit_id: '1' };
test('Odoo confirmed sale imports ERP line totals, carrier charge and only done payment transactions', () => {
  const r = demoOdooOrder(),
    o = normalizeOrder('odoo', r, settings);
  assert.equal(o.total, 10109);
  assert.equal(o.items[0].line_total, 8610);
  assert.equal(o.items[0].external_id, '101');
  assert.equal(o.shipping_cost, 1499);
  assert.equal(o.paid_amount, 10109);
  assert.equal(o.paid, true);
  assert.equal(o.blockers.length, 0);
  r._dyna.transactions[0].state = 'authorized';
  assert.equal(normalizeOrder('odoo', r, settings).paid_amount, 0);
  assert.equal(normalizeOrder('odoo', r, settings).paid, false);
  r.transaction_ids = [];
  r._dyna.transactions = [];
  assert.equal(normalizeOrder('odoo', r, settings).paid, false);
});
test('Odoo blocks shared transactions, child captures, refunds, shipped orders, services and source cancellation', () => {
  const mutations = [
    (r: any) => r._dyna.transactions[0].sale_order_ids.push(999),
    (r: any) => r._dyna.transactions[0].child_transaction_ids.push(99),
    (r: any) => (r._dyna.transactions[0].operation = 'refund'),
    (r: any) => (r._dyna.transactions[0].source_transaction_id = [99, 'Original']),
    (r: any) => (r._dyna.lines[0].qty_delivered = 1),
    (r: any) => (r._dyna.pickings[0].state = 'done'),
    (r: any) => (r.delivery_status = 'partial'),
    (r: any) => (r.state = 'cancel'),
    (r: any) => (r._dyna.products[0].is_storable = false),
  ];
  for (const mutate of mutations) {
    const r = demoOdooOrder();
    mutate(r);
    assert(normalizeOrder('odoo', r, settings).blockers.length > 0);
  }
});
test('Odoo rejects cross-company/warehouse/units, incomplete related records, foreign buyer and inconsistent amounts', () => {
  const mutations = [
    (r: any) => (r.company_id = [2, 'Other']),
    (r: any) => (r.warehouse_id = [2, 'Other']),
    (r: any) => (r._dyna.lines[0].product_uom_id = [2, 'kg']),
    (r: any) => (r._dyna.lines[0].product_uom_qty = 0.5),
    (r: any) => r._dyna.lines.pop(),
    (r: any) => r._dyna.transactions.pop(),
    (r: any) => r._dyna.pickings.pop(),
    (r: any) => (r._dyna.address = { ...r._dyna.address, commercial_partner_id: [2, 'Other'] }),
    (r: any) => r.amount_total++,
    (r: any) => (r._dyna.transactions[0].currency_id = [2, 'EUR']),
  ];
  for (const mutate of mutations) {
    const r = demoOdooOrder();
    mutate(r);
    assert.throws(() => normalizeOrder('odoo', r, settings));
  }
});
test('Odoo keyset pages retain stable window and ties, with complete related rereads and bounded requests', async () => {
  const f = odooOrderFixture(21),
    c = new OdooSales(odooSettings, odooCredentials, f.transport);
  let cursor: string | null = null,
    ids: number[] = [];
  let pages = 0;
  do {
    const r = await c.orders(cursor);
    ids.push(...r.data.map((o) => o.id));
    cursor = r.next_cursor;
    pages++;
    for (const o of r.data) {
      assert.equal(normalizeOrder('odoo', o, odooSettings).blockers.length, 0);
    }
  } while (cursor);
  assert.equal(pages, 3);
  assert.equal(ids.length, 21);
  assert.equal(new Set(ids).size, 21);
  assert(f.calls.every((c) => ['read', 'search_read', 'fields_get'].includes(c.method)));
});
test('Odoo changes during enriched reads reject page before local staging', async () => {
  const f = odooOrderFixture();
  let changed = false;
  f.state.hook = async (call) => {
    if (call.model === 'payment.transaction' && !changed) {
      changed = true;
      f.orders[0]._dyna.transactions[0].state = 'authorized';
    }
  };
  await assert.rejects(
    () => new OdooSales(odooSettings, odooCredentials, f.transport).orders(),
    /zmieniły/,
  );
});
test('Odoo retries each read with fencing; revocation prevents subsequent RPC', async () => {
  const f = odooOrderFixture();
  let attempts = 0,
    fences = 0;
  const c = new OdooSales(odooSettings, odooCredentials, async (u, i) => {
    attempts++;
    if (attempts === 1)
      return new Response('private', { status: 429, headers: { 'retry-after': '0' } });
    return f.transport(u, i);
  });
  await c.orders(undefined, undefined, async () => {
    fences++;
  });
  assert.equal(fences, attempts);
  let calls = 0;
  await assert.rejects(
    () =>
      new OdooSales(odooSettings, odooCredentials, async (u, i) => {
        calls++;
        return f.transport(u, i);
      }).orders(undefined, undefined, async () => {
        if (calls) throw Error('revoked');
      }),
    /revoked/,
  );
  assert.equal(calls, 1);
});
test('Odoo cursors validate calendar dates, bounds and malformed input; empty page still validates ERP scope', async () => {
  for (const v of ['garbage', 'e30', 'abcd']) assert.throws(() => parseOdooCursor(v));
  assert.throws(() =>
    odooWindowSchema.parse({ from: null, to: '2026-02-30 00:00:00', after: null }),
  );
  const f = odooOrderFixture(0);
  f.state.edit = (m, _method, data) => {
    if (m === 'stock.warehouse') data[0].company_id = [2, 'Other'];
  };
  await assert.rejects(
    () => new OdooSales(odooSettings, odooCredentials, f.transport).orders(),
    /firmy/,
  );
});
test('Odoo optional delivery field supports installations without delivery addon for physical orders', async () => {
  const f = odooOrderFixture();
  f.state.delivery = false;
  const r = f.orders[0];
  r.order_line.pop();
  r._dyna.lines.pop();
  r.amount_total = 86.1;
  r.amount_untaxed = 70;
  r.amount_tax = 16.1;
  r._dyna.transactions[0].amount = 86.1;
  const page = await new OdooSales(odooSettings, odooCredentials, f.transport).orders();
  assert.equal(normalizeOrder('odoo', page.data[0], odooSettings).shipping_cost, 0);
});

test('Odoo preview and individual revalidation keep the same hash despite related read ordering', async () => {
  const f = odooOrderFixture(2),
    c = new OdooSales(odooSettings, odooCredentials, f.transport);
  f.state.edit = (_model, method, data) => {
    if (method === 'read') data.reverse();
  };
  const page = await c.orders();
  f.state.edit = undefined;
  for (const raw of page.data)
    assert.equal(importSourceHash(raw), importSourceHash(await c.order(raw.id)));
});
