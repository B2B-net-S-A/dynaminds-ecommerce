import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pool } from '../server/db';
import type { Transport } from '../server/integrations';
import { ebayFixture, ebaySecrets } from './ebay-fixture';
import {
  freshSourceIntentFixture,
  makeProviderHarness,
} from './source-order-intents-provider-fixture';

// Controlled provider HTTP contracts; this does not prove live marketplace access.
type Provider = 'allegro' | 'ebay';
type Row = Record<string, any>;
const allegroToken = 'own-source-intent-allegro-controlled-token';
function allegroRaw() {
  return {
    id: randomUUID(), revision: 'own-revision-1', status: 'READY_FOR_PROCESSING',
    fulfillment: { status: 'NEW' }, buyer: { email: 'own-marketplace@example.test' },
    payment: { id: randomUUID(), type: 'ONLINE',
      paidAmount: { amount: '10.00', currency: 'PLN' } },
    delivery: {
      address: { firstName: 'Own', lastName: 'Marketplace buyer', street: 'Own receiver 1',
        city: 'Poznań', zipCode: '60-001', countryCode: 'PL' },
      cost: { amount: '5.00', currency: 'PLN' },
    },
    summary: { totalToPay: { amount: '42.00', currency: 'PLN' } },
    lineItems: [
      { id: randomUUID(), offer: { id: '127001', name: 'Own shared offer',
        external: { id: 'OWN-SHARED-MARKETPLACE-SKU' } }, quantity: 2,
        price: { amount: '10.00', currency: 'PLN' } },
      { id: randomUUID(), offer: { id: '127001', name: 'Own shared offer',
        external: { id: 'OWN-SHARED-MARKETPLACE-SKU' } }, quantity: 1,
        price: { amount: '17.00', currency: 'PLN' } },
    ],
  };
}
const ebayMoney = (value: string) => ({ value, currency: 'PLN' });
function prepareEbay(f: ReturnType<typeof ebayFixture>) {
  const raw = f.orders[0], first = structuredClone(raw.lineItems[0]);
  raw.lineItems = [
    { ...first, quantity: 2, lineItemCost: ebayMoney('20.00'),
      discountedLineItemCost: ebayMoney('20.00'),
      deliveryCost: { shippingCost: ebayMoney('5.00'), discountAmount: ebayMoney('0.00') }, total: ebayMoney('25.00') },
    { ...structuredClone(first), lineItemId: '6001002', quantity: 1,
      lineItemCost: ebayMoney('17.00'), discountedLineItemCost: ebayMoney('17.00'),
      deliveryCost: { shippingCost: ebayMoney('0.00'), discountAmount: ebayMoney('0.00') }, total: ebayMoney('17.00') },
  ];
  raw.pricingSummary = { priceSubtotal: ebayMoney('37.00'), priceDiscount: ebayMoney('0.00'),
    deliveryCost: ebayMoney('5.00'), deliveryDiscount: ebayMoney('0.00'), total: ebayMoney('42.00') };
  raw.paymentSummary = { payments: [{ paymentMethod: 'EBAY', paymentStatus: 'PAID', amount: ebayMoney('42.00') }],
    refunds: [], totalDueSeller: ebayMoney('42.00') };
  return raw;
}
let ebay = ebayFixture(), allegro = allegroRaw();
let allegroReads = 0;
let harness: Awaited<ReturnType<typeof makeProviderHarness>>;
const transport: Transport = async (url, init) => {
  const u = new URL(url);
  if (u.origin === 'https://api.sandbox.ebay.com') return ebay.transport(url, init);
  assert.equal(u.origin, 'https://api.allegro.pl.allegrosandbox.pl');
  assert.equal(init.method, 'GET', 'Import may only read the controlled Allegro source');
  assert.equal((init.headers as Record<string, string>).Authorization, 'Bearer ' + allegroToken);
  assert.equal((init.headers as Record<string, string>).Accept, 'application/vnd.allegro.public.v1+json');
  assert.equal(u.pathname, '/order/checkout-forms/' + allegro.id);
  ++allegroReads;
  return new Response(JSON.stringify(allegro), { headers: { 'content-type': 'application/json' } });
};
before(async () => { harness = await makeProviderHarness({ transport }); });
beforeEach(() => { ebay = ebayFixture(); prepareEbay(ebay); allegro = allegroRaw(); allegroReads = 0; });
after(async () => { await harness?.close(); });

async function fixture(provider: Provider) {
  const raw = provider === 'allegro' ? allegro : ebay.orders[0];
  return freshSourceIntentFixture(harness, {
    provider, raw, mode: 'sandbox', settings: {},
    credentials: provider === 'allegro' ? { access_token: allegroToken } : ebaySecrets,
    external_product_id: provider === 'allegro' ? '127001' : 'EBAY-DEMO-SKU',
    remote_line_ids: raw.lineItems.map((line: Row) => provider === 'allegro' ? line.id : line.lineItemId),
    prepareChannel: async (f) => {
      if (provider === 'allegro') await pool.query(
        "UPDATE channels SET oauth_scopes='allegro:api:orders:read allegro:api:sale:offers:read',token_expires_at=now()+interval '1 hour' WHERE tenant_id=$1 AND id=$2",
        [f.buyer.tenant, f.channel.id],
      );
    },
  });
}
const sourceReads = (provider: Provider) => provider === 'allegro' ? allegroReads :
  ebay.calls.filter((call) => call.method === 'GET' && new URL(call.url).pathname.startsWith('/sell/fulfillment/v1/order/')).length;

for (const provider of ['allegro', 'ebay'] as const) {
  test(`genuine ${provider} source-intent import retains two same-SKU original prices, supported payments, zero-stock custody and exact replay`, async () => {
    const f = await fixture(provider);
    const physicalBefore = await f.snapshot({ physicalOnly: true });
    assert.equal(Object.keys(physicalBefore).length, 19);
    assert.deepEqual((await pool.query(
      'SELECT on_hand,reserved FROM stock WHERE tenant_id=$1 AND warehouse_id=$2 AND product_id=$3',
      [f.buyer.tenant, f.buyer.warehouse, f.product.id],
    )).rows, [{ on_hand: 0, reserved: 0 }]);
    const supplierBefore = await f.snapshot({ tenants: [f.supplier.tenant] });
    const p = await f.preview();
    assert.equal(p.rows.length, 2);
    assert.equal(new Set(p.rows.map((row: Row) => row.customer_item_id)).size, 2);
    assert.deepEqual(p.rows.map((row: Row) => [row.quantity, row.price, row.line_total, row.vat]),
      [[2, 1000, 2000, 23], [1, 1700, 1700, 23]]);
    assert.equal(p.source.total, 4200);
    assert.equal(p.source.shipping_cost, 500);
    assert.equal(p.source.payment.declaration_only, true);
    assert.deepEqual(await f.snapshot({ physicalOnly: true }), physicalBefore);
    const body = f.executeBody(p), beforeReads = sourceReads(provider);
    const r = await f.execute(p, body);
    assert.equal(r.statusCode, 201, r.body);
    assert.equal(sourceReads(provider), beforeReads + 1, 'Execution must re-read the actual provider order');
    const result = r.json(), order = result.order;
    assert.equal(order.source, provider);
    assert.equal(order.source_snapshot.vat_source, 'local_catalog');
    if (provider === 'ebay') assert.equal(order.source_snapshot.ebay.field_groups, 'TAX_BREAKDOWN');
    assert.equal(order.total, 4200);
    assert.equal(order.shipping_cost, 500);
    assert.equal(order.items.length, 2);
    const received = provider === 'allegro' ? 1000 : 4200;
    assert.equal(order.payment.received, received);
    assert.equal(order.payment.amount_due, 4200 - received);
    assert.equal(order.status, provider === 'allegro' ? 'new' : 'paid');
    const bindings = (await pool.query(
      'SELECT remote_line_id,source_item_id,product_id,quantity,line_total,source_hash,inbound_id,channel_id FROM order_source_lines WHERE tenant_id=$1 AND source_order_id=$2',
      [f.buyer.tenant, order.id],
    )).rows;
    assert.equal(bindings.length, 2);
    for (const planned of p.rows) {
      const binding = bindings.find((row: Row) => row.remote_line_id === planned.remote_line_id);
      assert(binding);
      assert.equal(binding.source_item_id, planned.customer_item_id);
      assert.equal(binding.product_id, f.product.id);
      assert.equal(binding.quantity, planned.quantity);
      assert.equal(binding.line_total, planned.line_total);
      assert.equal(binding.source_hash, f.inbound.source_hash);
      assert.equal(binding.inbound_id, f.inbound.id);
      assert.equal(binding.channel_id, f.channel.id);
      const item = order.items.find((row: Row) => row.id === binding.source_item_id);
      assert(item);
      assert.equal(item.sku, f.product.sku);
      assert.equal(item.price, planned.price);
      assert.equal(item.line_total, planned.line_total);
      assert.equal(item.quantity, planned.quantity);
      assert.equal(item.vat, 23);
      assert.deepEqual(item.components, [{ product_id: f.product.id, quantity: 1 }]);
      const allocation = result.intent.items.find((row: Row) => row.customer_item_id === item.id);
      assert(allocation);
      assert.equal(allocation.local_quantity, 0);
      assert.equal(allocation.external_quantity, planned.quantity);
      assert.equal(allocation.unassigned_quantity, 0);
      assert.equal(allocation.link_id, f.link.id);
    }
    assert.deepEqual((await pool.query(
      'SELECT kind,amount,method FROM payment_entries WHERE tenant_id=$1 AND order_id=$2',
      [f.buyer.tenant, order.id],
    )).rows, [{ kind: 'receipt', amount: received, method: 'source_import' }]);
    assert.equal(order.picking_items.length, 0);
    assert.deepEqual((await pool.query(
      `SELECT c.state,c.actual_order_id,c.intent_id FROM b2b_external_import_certificates c
       JOIN b2b_external_import_executions e ON e.tenant_id=c.tenant_id AND e.certificate_id=c.id
       WHERE c.tenant_id=$1 AND c.preview_id=$2 AND e.order_id=$3 AND e.intent_id=$4`,
      [f.buyer.tenant, p.id, order.id, result.intent.id],
    )).rows, [{ state: 'complete', actual_order_id: order.id, intent_id: result.intent.id }]);
    assert.deepEqual(await f.snapshot({ physicalOnly: true }), physicalBefore);
    assert.deepEqual(await f.snapshot({ tenants: [f.supplier.tenant] }), supplierBefore);
    const beforeReplay = await f.snapshot(), readsBeforeReplay = sourceReads(provider);
    const replay = await f.execute(p, body);
    assert.equal(replay.statusCode, 200, replay.body);
    assert.equal(replay.json().reused, true);
    assert.equal(replay.json().order.id, order.id);
    assert.equal(sourceReads(provider), readsBeforeReplay, 'Exact replay must not fetch/create a second provider order');
    assert.deepEqual(await f.snapshot(), beforeReplay);
    assert(ebay.calls.every((call) => call.method === 'GET' ||
      new URL(call.url).pathname === '/identity/v1/oauth2/token'), 'No eBay commerce/fulfillment mutation is permitted');
  });

  test(`genuine ${provider} source-intent execution refuses fresh provider price drift before any order, receipt, certificate or custody effect`, async () => {
    const f = await fixture(provider), p = await f.preview();
    const frozenBefore = (await f.ok('/import-external-intent-previews/' + p.id)).preview;
    const physicalBefore = await f.snapshot({ physicalOnly: true });
    const supplierBefore = await f.snapshot({ tenants: [f.supplier.tenant] });
    const beforeReads = sourceReads(provider);
    if (provider === 'allegro') {
      allegro.lineItems[1].price.amount = '18.00';
      allegro.summary.totalToPay.amount = '43.00';
      allegro.revision = 'own-revision-2';
    } else {
      ebay.orders[0].lineItems[1].total = ebayMoney('18.00');
      ebay.orders[0].lineItems[1].lineItemCost = ebayMoney('18.00');
      ebay.orders[0].lineItems[1].discountedLineItemCost = ebayMoney('18.00');
      ebay.orders[0].pricingSummary.priceSubtotal = ebayMoney('38.00');
      ebay.orders[0].pricingSummary.total = ebayMoney('43.00');
      ebay.orders[0].paymentSummary.payments[0].amount = ebayMoney('43.00');
      ebay.orders[0].paymentSummary.totalDueSeller = ebayMoney('43.00');
    }
    const r = await f.execute(p, f.executeBody(p));
    assert.equal(r.statusCode, 409, r.body);
    assert.equal(sourceReads(provider), beforeReads + 1);
    for (const table of ['orders', 'payment_entries', 'order_source_lines', 'b2b_external_order_intents',
      'b2b_external_import_certificates', 'b2b_external_import_executions']) {
      assert.equal((await pool.query(`SELECT count(*)::int n FROM ${table} WHERE tenant_id=$1`,
        [f.buyer.tenant])).rows[0].n, 0, table + ' must remain empty after rejected execution');
    }
    const current = (await pool.query('SELECT source_hash,order_id,imported_hash,raw FROM inbound_orders WHERE tenant_id=$1 AND id=$2',
      [f.buyer.tenant, f.inbound.id])).rows[0];
    assert.notEqual(current.source_hash, f.inbound.source_hash);
    assert.equal(current.order_id, null);
    assert.equal(current.imported_hash, null);
    assert.equal(provider === 'allegro' ? current.raw.summary.totalToPay.amount : current.raw.pricingSummary.total.value, '43.00');
    const frozenAfter = (await f.ok('/import-external-intent-previews/' + p.id)).preview;
    assert.equal(frozenAfter.scope_hash, frozenBefore.scope_hash);
    assert.deepEqual(frozenAfter.source, frozenBefore.source);
    assert.deepEqual(frozenAfter.rows, frozenBefore.rows);
    assert.deepEqual(await f.snapshot({ physicalOnly: true }), physicalBefore);
    assert.deepEqual(await f.snapshot({ tenants: [f.supplier.tenant] }), supplierBefore);
  });
}

test('genuine eBay source-intent path rejects unsupported partial cash rather than inventing an imported receipt', async () => {
  ebay.orders[0].orderPaymentStatus = 'PENDING';
  ebay.orders[0].paymentSummary.payments[0].amount = ebayMoney('10.00');
  const f = await fixture('ebay'), before = await f.snapshot();
  const response = await f.request('/imports/' + f.inbound.id + '/external-intent-previews', 'POST', f.previewBody);
  assert.equal(response.statusCode, 422, response.body);
  assert.match(response.body, /Częściowa wpłata eBay wymaga uzgodnienia/);
  assert.deepEqual(await f.snapshot(), before);
});
