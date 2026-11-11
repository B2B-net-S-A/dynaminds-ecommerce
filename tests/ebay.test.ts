import { test, before, beforeEach, after } from 'node:test';
import { migrate, pool } from '../server/db';
assert.equal(process.env.DYNA_TEST, 'true');
before(async () => {
  await migrate();
});
beforeEach(async () => {
  await pool.query('DELETE FROM ebay_api_leases; DELETE FROM ebay_api_buckets');
});
after(async () => {
  await pool.end();
});
import assert from 'node:assert/strict';
import { normalizeOrder } from '../server/imports';
import { Ebay, refreshEbay, parseEbayCursor, ebayWindowSchema } from '../server/ebay';
import { demoEbayOrder } from '../server/ebay-example';
import { ebayFixture, ebaySecrets } from './ebay-fixture';
test('eBay exact cents: item and shipping discounts without multiplying extended totals or duplicating tax', () => {
  const raw = demoEbayOrder(),
    o = normalizeOrder('ebay', raw);
  assert.equal(o.items[0].line_total, 9001);
  assert.equal(o.shipping_cost, 1000);
  assert.equal(o.total, 10001);
  assert.equal(o.paid_amount, 10001);
  assert.equal(o.blockers.length, 0);
  const a = { value: '20.01', currency: 'PLN' };
  (raw as any).ebayCollectAndRemitTax = true;
  (raw.lineItems[0] as any).taxes = [{ taxType: 'VAT', amount: a }];
  (raw.lineItems[0] as any).ebayCollectAndRemitTaxes = [
    { taxType: 'VAT', amount: a, collectionMethod: 'NET' },
  ];
  raw.lineItems[0].total.value = '120.02';
  raw.pricingSummary.total.value = '120.02';
  raw.paymentSummary.payments[0].amount.value = '120.02';
  const tax = normalizeOrder('ebay', raw);
  assert.equal(tax.items[0].line_total, 11002);
  assert.equal(tax.total, 12002);
  assert.equal(tax.blockers.length, 0);
});
test('eBay rejects hidden fees, GSP, cancellation, fulfillment, refunds and partial payment', () => {
  for (const edit of [
    (r: any) => (r.cancelStatus.cancelState = 'CANCEL_REQUESTED'),
    (r: any) => r.cancelStatus.cancelRequests.push({ cancelReason: 'BUYER' }),
    (r: any) => (r.orderFulfillmentStatus = 'IN_PROGRESS'),
    (r: any) => r.fulfillmentHrefs.push('https://api.ebay.com/fulfillment'),
    (r: any) => (r.fulfillmentStartInstructions[0].ebaySupportedFulfillment = true),
    (r: any) => r.paymentSummary.refunds.push({ refundStatus: 'REFUNDED' }),
    (r: any) => (r.pricingSummary.fee = { value: '1.00', currency: 'PLN' }),
    (r: any) => (r.lineItems[0].deliveryCost.importCharges = { value: '1.00', currency: 'PLN' }),
    (r: any) =>
      (r.lineItems[0].ebayCollectedCharges = { charges: [{ chargeType: 'BUYER_PROTECTION' }] }),
    (r: any) => (r.paymentSummary.payments[0].amount.value = '50.00'),
    (r: any) => (r.orderPaymentStatus = 'PARTIALLY_REFUNDED'),
  ]) {
    const r = demoEbayOrder();
    edit(r);
    assert(normalizeOrder('ebay', r).blockers.length);
  }
});
test('eBay missing email, SKU, precise currency, line identity and total reject instead of guessing', () => {
  for (const edit of [
    (r: any) => delete r.fulfillmentStartInstructions[0].shippingStep.shipTo.email,
    (r: any) => delete r.lineItems[0].sku,
    (r: any) => (r.lineItems[0].total.currency = 'EUR'),
    (r: any) => (r.lineItems[0].total.value = '100.001'),
    (r: any) => (r.pricingSummary.total.value = '101.00'),
    (r: any) => r.lineItems.push(r.lineItems[0]),
    (r: any) => delete r._dyna,
  ]) {
    const r = demoEbayOrder();
    edit(r);
    assert.throws(() => normalizeOrder('ebay', r));
  }
  const pending = demoEbayOrder();
  pending.orderPaymentStatus = 'PENDING';
  pending.paymentSummary.payments = [];
  assert.equal(normalizeOrder('ebay', pending).paid_amount, 0);
});
test('eBay OAuth form uses sandbox, user scope, Basic credentials and preserves consent refresh token', async () => {
  const f = ebayFixture();
  const tokens = await refreshEbay('sandbox', ebaySecrets, f.transport);
  assert.equal(tokens.access_token, 'DEMO-access-1');
  assert.equal(f.state.token, 1);
});
test('eBay durable cursor traverses 101 orders with same window, fixed paths and never follows remote URLs', async () => {
  const f = ebayFixture(101);
  await refreshEbay('sandbox', ebaySecrets, f.transport);
  const client = new Ebay('sandbox', { access_token: 'DEMO-access-1' }, f.transport);
  let cursor: string | null = null,
    ids: string[] = [],
    windows: any[] = [];
  do {
    const r = await client.orders(cursor);
    ids.push(...r.data.map((o) => o.id));
    windows.push(r.window);
    cursor = r.next_cursor;
  } while (cursor);
  assert.equal(ids.length, 101);
  assert.equal(new Set(ids).size, 101);
  assert.equal(windows.length, 3);
  assert(windows.every((w) => w.to === windows[0].to && w.from === windows[0].from));
  f.state.edit = (v) => {
    if (v.next) v.next = 'https://evil.example/steal';
  };
  await assert.rejects(() => client.orders(), /następna strona/);
});
test('eBay invalid pagination, duplicate records, malformed JSON and warnings cannot stage a partial page', async () => {
  for (const edit of [
    (v: any) => (v.offset = 1),
    (v: any) => (v.orders[0].lastModifiedDate = new Date(Date.now() + 86400000).toISOString()),
    (v: any) => (v.total = 1000001),
    (v: any) => v.orders.push(v.orders[0]),
    (v: any) => (v.warnings = [{ message: 'secret' }]),
  ]) {
    const f = ebayFixture();
    await refreshEbay('sandbox', ebaySecrets, f.transport);
    f.state.edit = edit;
    await assert.rejects(() =>
      new Ebay('sandbox', { access_token: 'DEMO-access-1' }, f.transport).orders(),
    );
  }
  await assert.rejects(
    () =>
      new Ebay(
        'sandbox',
        { access_token: 'a' },
        async () => new Response('private secret'),
      ).orders(),
    /Nieprawidłowy JSON/,
  );
  await assert.rejects(
    () =>
      new Ebay(
        'sandbox',
        { access_token: 'a' },
        async () => new Response('x'.repeat(4 * 1024 * 1024 + 1)),
      ).orders(),
    /limit/,
  );
});
test('eBay retries 429 with authority check each time and sanitizes credential/provider errors', async () => {
  const f = ebayFixture();
  await refreshEbay('sandbox', ebaySecrets, f.transport);
  let calls = 0,
    checks = 0;
  const c = new Ebay('sandbox', { access_token: 'DEMO-access-1' }, async (u, i) =>
    ++calls === 1
      ? new Response('private', { status: 429, headers: { 'retry-after': '0' } })
      : f.transport(u, i),
  );
  await c.orders(undefined, undefined, async () => {
    checks++;
  });
  assert.equal(calls, 2);
  assert.equal(checks, 2);
  calls = 0;
  await assert.rejects(
    () =>
      c.orders(undefined, undefined, async () => {
        if (calls) throw Error('revoked');
      }),
    /revoked/,
  );
  assert.equal(calls, 1);
  await assert.rejects(
    () =>
      new Ebay(
        'live',
        { access_token: 'secret' },
        async () => new Response('private secret', { status: 403 }),
      ).orders(),
    (e) => !String(e).includes('private secret'),
  );
  for (const cursor of ['garbage', 'e30', 'abcd']) assert.throws(() => parseEbayCursor(cursor));
  assert.throws(() =>
    ebayWindowSchema.parse({
      from: '2026-02-30T00:00:00.000Z',
      to: new Date().toISOString(),
      offset: 0,
    }),
  );
});
