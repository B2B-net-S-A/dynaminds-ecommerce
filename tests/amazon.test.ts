import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Amazon, amazonSettings, initialAmazonWindow, amazonBase } from '../server/amazon';
import { demoAmazonOrder } from '../server/amazon-example';
import { normalizeOrder } from '../server/imports';
import { amazonFixture, amazonSecrets, amazonConfig } from './amazon-fixture';
import { orderSchema } from '../server/domain';
const hash = 'a'.repeat(64);
test('Amazon 2026: extended item totals and shipping tax; authorization does not invent a receipt, optional email stays empty', () => {
  const o = normalizeOrder('amazon', demoAmazonOrder(), amazonConfig);
  assert.equal(o.items[0].line_total, 24600);
  assert.equal(o.shipping_cost, 90);
  assert.equal(o.total, 24690);
  assert.equal(o.paid, false);
  assert.equal(o.paid_amount, 0);
  assert.equal(o.email, '');
  assert.deepEqual(o.blockers, []);
  const raw = demoAmazonOrder();
  raw.orderItems[0].quantityOrdered = 3;
  raw.orderItems[0].fulfillment.quantityUnfulfilled = 3;
  assert.equal(normalizeOrder('amazon', raw, amazonConfig).items[0].line_total, 24600);
  assert.equal(
    orderSchema.safeParse({
      ...o,
      source: 'manual',
      warehouse_id: '00000000-0000-4000-8000-000000000001',
      items: [{ product_id: '00000000-0000-4000-8000-000000000002', quantity: 1 }],
    }).success,
    false,
  );
});
test('Amazon rejects missing PII, currencies, totals, malformed cents, source identity, repeated lines and missing SKUs', () => {
  const edits: ((r: any) => void)[] = [
    (r) => delete r.recipient.deliveryAddress.name,
    (r) => (r.orderItems[0].proceeds.proceedsTotal.amount = '246.91'),
    (r) => (r.proceeds.grandTotal.currencyCode = 'EUR'),
    (r) => (r.orderItems[0].proceeds.breakdowns[0].subtotal.amount = '200.001'),
    (r) => (r.id = '111-1111111-1111111'),
    (r) => r.orderItems.push(structuredClone(r.orderItems[0])),
    (r) => delete r.orderItems[0].product.sellerSku,
    (r) => delete r.orderItems[0].proceeds.breakdowns[2].detailedBreakdowns,
    (r) => (r.salesChannel.marketplaceId = 'A1PA6795UKMFR9'),
  ];
  for (const edit of edits) {
    const r = demoAmazonOrder();
    edit(r);
    assert.throws(() => normalizeOrder('amazon', r, amazonConfig));
  }
});
test('Amazon FBA, cancellation, partial shipment, special programs and withheld tax cannot reserve FBM stock', () => {
  const edits: ((r: any) => void)[] = [
    (r) => (r.fulfillment.fulfilledBy = 'AMAZON'),
    (r) => (r.fulfillment.fulfillmentStatus = 'CANCELLED'),
    (r) => (r.orderItems[0].cancellation = { cancellationRequest: { requester: 'BUYER' } }),
    (r) => (r.orderItems[0].fulfillment.quantityFulfilled = 1),
    (r) => (r.orderItems[0].tax = { taxCollections: [{ model: 'MARKETPLACE_FACILITATOR' }] }),
    (r) => (r.programs = ['IN_STORE_PICK_UP']),
  ];
  for (const edit of edits) {
    const r = demoAmazonOrder();
    edit(r);
    assert(normalizeOrder('amazon', r, amazonConfig).blockers.length);
  }
});
test('Amazon official regional endpoints and strict marketplace pairing discard arbitrary hosts and synthetic flags', () => {
  assert.equal(amazonBase('live', 'eu'), 'https://sellingpartnerapi-eu.amazon.com');
  assert.equal(amazonBase('sandbox', 'na'), 'https://sandbox.sellingpartnerapi-na.amazon.com');
  assert.equal(amazonBase('live', 'fe'), 'https://sellingpartnerapi-fe.amazon.com');
  assert.throws(() => amazonSettings.parse({ region: 'na', marketplace_id: 'A1C3SOZRARQ6R3' }));
  assert.deepEqual(
    amazonSettings.parse({ ...amazonConfig, simulation: 'true', server_url: 'http://localhost' }),
    {
      ...amazonConfig,
      selling_partner_id: '',
      listing_write: false,
      shipment_write: false,
      application_id: '',
      oauth_redirect_uri: 'http://127.0.0.1:4100/api/oauth/amazon/callback',
      oauth_beta: true,
    },
  );
});
test('Amazon LWA/2026 contract, same window pagination, refresh-on-401 once, role fence every HTTP', async () => {
  const f = amazonFixture(51),
    c = new Amazon('sandbox', amazonConfig, amazonSecrets, f.transport);
  f.state.fail401 = true;
  let fences = 0;
  const guard = async () => {
    fences++;
  };
  const a = await c.orders(undefined, undefined, guard, hash);
  assert.equal(f.state.token, 2);
  assert(a.has_more);
  const b = await c.orders(a.next_cursor!, undefined, guard, hash);
  assert.equal(b.data.length, 1);
  assert(!b.has_more);
  assert.equal(f.state.token, 2);
  const searches = f.calls.filter((c) => c.url.includes('/orders?')).map((c) => new URL(c.url));
  assert.equal(
    searches[0].searchParams.get('lastUpdatedAfter'),
    searches[2].searchParams.get('lastUpdatedAfter'),
  );
  assert.equal(
    searches[0].searchParams.get('lastUpdatedBefore'),
    searches[2].searchParams.get('lastUpdatedBefore'),
  );
  assert.equal(fences, f.calls.length);
  const o = await c.order(f.orders[0].id);
  assert.equal(o.id, f.orders[0].id);
});
test('Amazon checkpoints reject stale, changed connection and token cycles before duplicate staging', async () => {
  const f = amazonFixture(101),
    c = new Amazon('sandbox', amazonConfig, amazonSecrets, f.transport),
    a = await c.orders(undefined, undefined, undefined, hash);
  await assert.rejects(
    c.orders(a.next_cursor!, undefined, undefined, 'b'.repeat(64)),
    /innego połączenia/,
  );
  const w = JSON.parse(Buffer.from(a.next_cursor!, 'base64url').toString());
  w.started_at = new Date(Date.now() - 25 * 3600000).toISOString();
  await assert.rejects(
    c.orders(Buffer.from(JSON.stringify(w)).toString('base64url'), undefined, undefined, hash),
    /wygasł/,
  );
  f.state.loop = true;
  await assert.rejects(c.orders(a.next_cursor!, undefined, undefined, hash), /token strony/);
});
test('Amazon search window starts at 90 days and subsequent overlap is ten minutes; endpoint never follows token URL', async () => {
  const w = initialAmazonWindow();
  assert(Date.now() - Date.parse(w.to) >= 120000);
  assert(Math.abs(Date.now() - Date.parse(w.from) - 90 * 86400000) < 1000);
  const watermark = new Date(Date.now() - 3600000).toISOString();
  assert.equal(Date.parse(initialAmazonWindow(watermark).from), Date.parse(watermark) - 600000);
  const f = amazonFixture(51),
    c = new Amazon('sandbox', amazonConfig, amazonSecrets, f.transport);
  f.state.edit = (v) => {
    if (v.orders) v.pagination = { nextToken: 'https://attacker.test/token?secret=value' };
  };
  const a = await c.orders(undefined, undefined, undefined, hash);
  f.state.edit = undefined;
  await c.orders(a.next_cursor!, undefined, undefined, hash);
  assert(f.calls.every((c) => new URL(c.url).hostname !== 'attacker.test'));
});
test('Amazon PRIME metadata is retained without blocking FBM; COD does not invent collection, signed discounts reconcile exactly', () => {
  const raw: any = demoAmazonOrder();
  raw.programs = ['PRIME'];
  raw.payment.paymentExecutions = [
    { paymentMethod: 'CashOnDelivery', paymentAmount: { amount: '246.90', currencyCode: 'PLN' } },
  ];
  const o = normalizeOrder('amazon', raw, amazonConfig);
  assert.deepEqual(o.blockers, []);
  assert.equal(o.payment_mode, 'cod');
  assert.equal(o.paid_amount, 0);
  const item = raw.orderItems[0];
  item.proceeds.breakdowns.push({
    type: 'DISCOUNT',
    subtotal: { amount: '-1.00', currencyCode: 'PLN' },
    detailedBreakdowns: [{ subtype: 'ITEM', value: { amount: '-1.00', currencyCode: 'PLN' } }],
  });
  item.proceeds.proceedsTotal.amount = '245.90';
  raw.proceeds.grandTotal.amount = '245.90';
  raw.payment.paymentExecutions[0].paymentAmount.amount = '245.90';
  assert.equal(normalizeOrder('amazon', raw, amazonConfig).items[0].line_total, 24500);
});
