import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AmazonMcf,
  AMAZON_MCF_VERSION,
  mcfPreviewInput,
  parseMcfPreview,
  parseMcfOrder,
  parseMcfPage,
  mcfPackageTracking,
  mcfMoney,
  type McfAuth,
} from '../server/amazon-mcf-api';
import { amazonSettings } from '../server/amazon';
import { Problem } from '../server/errors';

const value = (n: string) => ({ unit: 'EACHES', value: n });
const identifier = (sku = 'SKU/ą+1') => ({ amazonSku: sku });
const address = {
  name: 'Klient QA',
  addressLine1: 'Testowa 1',
  city: 'Warszawa',
  postalCode: '00-001',
  countryCode: 'PL',
};
const input = () => ({
  channel: 'SHOPIFY',
  origin: { countryCode: 'DE' },
  destination: { deliveryAddress: address },
  lineItems: [
    {
      product: {
        productIdentifier: identifier(),
        perUnitDeclaredValue: { currencyCode: 'PLN', amount: '39.9900' },
      },
      amount: value('2.0'),
    },
  ],
  fulfillmentConfiguration: { serviceLevel: { serviceTiers: ['STANDARD', 'EXPEDITED'] } },
});
const offer = () => ({
  fulfillmentConfiguration: {
    serviceLevel: {
      serviceTier: 'STANDARD',
      deliveryInterval: { startTime: '2026-10-06T10:00:00Z', endTime: '2026-10-07T10:00:00Z' },
    },
  },
  estimatedPrice: {
    rollupPrices: [
      { type: 'MCFTransportationFee', value: { currencyCode: 'EUR', amount: '4.2500' } },
    ],
    totalPrice: { currencyCode: 'EUR', amount: '4.2500' },
  },
});
const preview = () => ({
  plannedShipments: [
    { items: [{ productIdentifier: identifier(), amount: value('2.0') }], offers: [offer()] },
  ],
});
const order = (id = 'MCF-095/QA') => ({
  orderId: id,
  receiveTime: '2026-10-05T10:00:00Z',
  status: 'COMPLETE_PARTIAL',
  statusUpdateTime: '2026-10-05T11:00:00Z',
  origin: { countryCode: 'DE' },
  destination: { deliveryAddress: address },
  lineItems: [
    {
      lineItemId: 'LINE-1',
      product: { productIdentifier: identifier() },
      amount: value('2'),
      cancelledAmount: value('1'),
      unfulfillableAmount: value('0'),
    },
  ],
  shipments: [
    {
      amazonShipmentId: 'SH-1',
      amazonFacility: { facilityId: 'FC-1' },
      status: 'SHIPPED',
      items: [
        {
          shipmentItemId: 'SI-1',
          lineItemId: 'LINE-1',
          productIdentifier: identifier(),
          amount: value('1'),
          packageId: 'PKG-1',
        },
      ],
      packages: [
        {
          packageId: 'PKG-1',
          status: 'DELIVERED',
          shipmentItemIds: ['SI-1'],
          tracking: {
            carrier: {
              carrierCode: 'DPD',
              trackingNumber: '123456789',
              trackingUrl: 'https://track.example.test/123456789',
            },
            amazon: { trackingNumber: 'AMZ-1' },
            proofOfDelivery: { deliveryPhotoUrl: 'https://proof.example.test/photo.jpg' },
          },
        },
      ],
    },
  ],
});
const response = (raw: unknown, status = 200, service?: string) =>
  new Response(JSON.stringify(raw), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...(service ? { 'x-amzn-fulfillment-service-id': service } : {}),
    },
  });
function harness(
  handler: (url: URL, init: RequestInit) => Response | Promise<Response>,
  service?: string,
) {
  const calls: { url: URL; init: RequestInit }[] = [];
  let tokens = 0;
  const auth: McfAuth = {
    mode: 'sandbox',
    settings: amazonSettings.parse({ region: 'eu', marketplace_id: 'A1C3SOZRARQ6R3' }),
    async token(fence) {
      tokens++;
      await fence?.();
      return 'QA-LWA-TOKEN';
    },
  };
  const client = new AmazonMcf(
    auth,
    async (u, init) => {
      const url = new URL(u);
      calls.push({ url, init });
      return handler(url, init);
    },
    { originCountry: 'DE', ...(service ? { fulfillmentServiceId: service } : {}) },
  );
  return { client, calls, tokenCalls: () => tokens, auth };
}
const status = (n: number) => (e: unknown) => e instanceof Problem && e.status === n;

test('current2026 preview reuses supplied LWA and fixed EU endpoint; PL marketplace is not silently used as stock country', async () => {
  const h = harness(() => response(preview()));
  let fences = 0;
  const p = await h.client.preview(input(), async () => {
    fences++;
  });
  assert.equal(AMAZON_MCF_VERSION, '2026-07-04');
  assert.equal(h.calls[0].url.origin, 'https://sandbox.sellingpartnerapi-eu.amazon.com');
  assert.equal(h.calls[0].url.pathname, '/fulfillment/outbound/2026-07-04/previews');
  assert.equal(h.calls[0].init.method, 'POST');
  assert.equal(h.calls[0].init.redirect, 'error');
  const headers = new Headers(h.calls[0].init.headers);
  assert.equal(headers.get('x-amz-access-token'), 'QA-LWA-TOKEN');
  assert.match(headers.get('x-amz-date')!, /^\d{8}T\d{6}Z$/);
  const sent = JSON.parse(String(h.calls[0].init.body));
  assert.equal(sent.origin.countryCode, 'DE');
  assert.equal(sent.marketplaceId, undefined);
  assert.equal(sent.lineItems[0].amount.value, '2.0');
  assert.equal(sent.excludeEstimatedFees, false);
  assert.equal(p.hasConstraints, false);
  assert.equal(p.completeQuantityCoverage, true);
  assert.equal(p.plannedShipments[0].offers![0].estimatedPrice!.totalPrice.amount, '4.2500');
  assert.equal(fences, 3);
  assert.equal(h.tokenCalls(), 1);
});
test('strict preview rejects invented write fields, malformed quantities/SKU, duplicateSKU, missingorigin and invalid prices before token or HTTP', async () => {
  const cases: ((v: any) => void)[] = [
    (v) => (v.orderId = 'MUTATION'),
    (v) => (v.marketplaceId = 'A1C3SOZRARQ6R3'),
    (v) => delete v.origin,
    (v) => (v.origin.countryCode = 'PL'),
    (v) => (v.lineItems[0].amount.value = 2),
    (v) => (v.lineItems[0].amount.value = '1.5'),
    (v) => (v.lineItems[0].amount.value = '0'),
    (v) => (v.lineItems[0].amount.value = '1000001'),
    (v) => (v.lineItems[0].product.productIdentifier.amazonSku = 'bad\nSKU'),
    (v) => v.lineItems.push(structuredClone(v.lineItems[0])),
    (v) => (v.lineItems[0].product.perUnitDeclaredValue.amount = '1e3'),
    (v) => (v.lineItems[0].product.perUnitDeclaredValue.currencyCode = 'ZZZ'),
    (v) => (v.includePaymentOnDelivery = true),
    (v) => (v.fulfillmentConfiguration.action = 'SHIP'),
    (v) => (v.lineItems[0].product.productIdentifier.orderId = 'injected'),
  ];
  for (const mutate of cases) {
    const h = harness(() => response(preview())),
      v: any = input();
    mutate(v);
    await assert.rejects(h.client.preview(v));
    assert.equal(h.calls.length, 0);
    assert.equal(h.tokenCalls(), 0);
  }
});
test('region/marketplace pairing and regional service tiers cannot become arbitrary hosts or unsupported capabilities', async () => {
  const h = harness(() => response(preview()));
  assert.throws(
    () =>
      new AmazonMcf(
        { ...h.auth, settings: { ...h.auth.settings, region: 'na' } },
        async () => response({}),
        { originCountry: 'DE' },
      ),
  );
  for (const tier of ['PRIORITY', 'SCHEDULED']) {
    const v: any = input();
    v.fulfillmentConfiguration.serviceLevel.serviceTiers = [tier];
    await assert.rejects(h.client.preview(v), status(422));
  }
  assert.equal(h.calls.length, 0);
});
test('partial/split previews preserve explicit constraints and missing offers instead of declaring fulfillment', () => {
  const req = mcfPreviewInput.parse(input()),
    p: any = preview();
  p.plannedShipments[0].items[0].amount = value('1');
  p.constraints = [
    {
      type: 'ValidationError',
      code: 'ItemQuantityNotAvailable',
      message: 'Brak jednej sztuki',
      details: [{ type: 'SKU', value: 'SKU/ą+1' }],
    },
  ];
  let result = parseMcfPreview(p, req);
  assert.equal(result.completeQuantityCoverage, false);
  assert.equal(result.hasConstraints, true);
  p.plannedShipments.push(structuredClone(p.plannedShipments[0]));
  result = parseMcfPreview(p, req);
  assert.equal(result.completeQuantityCoverage, true);
  assert.equal(result.hasConstraints, true);
  p.plannedShipments[1].offers = [];
  assert.equal(parseMcfPreview(p, req).hasOffersForEveryShipment, false);
  delete p.plannedShipments[0].offers[0].estimatedPrice;
  assert.equal(parseMcfPreview(p, req).hasPricesForEveryOffer, false);
});
test('response preview identities, requested tier, excess quantities, currency consistency and date windows are checked', () => {
  for (const mutate of [
    (p: any) => (p.plannedShipments[0].items[0].productIdentifier.amazonSku = 'OTHER'),
    (p: any) => (p.plannedShipments[0].items[0].amount = value('3')),
    (p: any) => p.plannedShipments[0].items.push(structuredClone(p.plannedShipments[0].items[0])),
    (p: any) =>
      (p.plannedShipments[0].offers[0].fulfillmentConfiguration.serviceLevel.serviceTier =
        'PRIORITY'),
    (p: any) =>
      (p.plannedShipments[0].offers[0].fulfillmentConfiguration.serviceLevel.deliveryInterval.endTime =
        '2026-10-01T00:00:00Z'),
    (p: any) =>
      (p.plannedShipments[0].offers[0].estimatedPrice.rollupPrices[0].value.currencyCode = 'PLN'),
  ]) {
    const p = preview();
    mutate(p);
    assert.throws(() => parseMcfPreview(p, mcfPreviewInput.parse(input())), status(502));
  }
  assert.throws(
    () => parseMcfPreview({ payload: preview() }, mcfPreviewInput.parse(input())),
    status(502),
  );
});
test('exact money bytes beyond JS integer precision are preserved; noncurrency/float/negative is rejected', () => {
  assert.equal(
    mcfMoney.parse({ currencyCode: 'PLN', amount: '9007199254740993.123456789012' }).amount,
    '9007199254740993.123456789012',
  );
  for (const amount of [-1, 'NaN', '-1', '01', '1e3', '0.0000000000001'])
    assert.throws(() => mcfMoney.parse({ currencyCode: 'PLN', amount }));
});
test('getOrder requests only encoded frozenID and INCLUDE shipment data; tracking links are returned without HTTP downloads', async () => {
  const h = harness(() => response({ order: order() }));
  const o = await h.client.order('MCF-095/QA');
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].init.method, 'GET');
  assert.equal(h.calls[0].url.pathname, '/fulfillment/outbound/2026-07-04/orders/MCF-095%2FQA');
  assert.equal(h.calls[0].url.searchParams.get('shipments'), 'INCLUDE');
  const t = mcfPackageTracking(o);
  assert.equal(t.length, 1);
  assert.equal(t[0].packageStatus, 'DELIVERED');
  assert.equal(t[0].orderStatus, 'COMPLETE_PARTIAL');
  assert.equal(t[0].tracking!.carrier!.trackingNumber, '123456789');
  assert.equal(h.calls.length, 1);
  const x = harness(() => response({ order: order('OTHER') }));
  await assert.rejects(x.client.order('EXPECTED'), status(502));
  for (const id of ['', '..', 'bad\nID', 'a'.repeat(41)]) await assert.rejects(x.client.order(id));
});
test('malformed order/package states, SKU relations, identities and quantities fail closed', () => {
  for (const mutate of [
    (o: any) => (o.status = 'Complete'),
    (o: any) => (o.shipments[0].status = 'DELIVERED'),
    (o: any) => (o.shipments[0].packages[0].status = 'UNKNOWN_NEW_STATUS'),
    (o: any) => o.lineItems.push(structuredClone(o.lineItems[0])),
    (o: any) => (o.lineItems[0].cancelledAmount = value('3')),
    (o: any) => (o.shipments[0].items[0].lineItemId = 'OTHER'),
    (o: any) => (o.shipments[0].items[0].productIdentifier.amazonSku = 'OTHER'),
    (o: any) => (o.shipments[0].items[0].amount = value('3')),
    (o: any) => (o.shipments[0].items[0].packageId = 'OTHER'),
    (o: any) => (o.shipments[0].packages[0].shipmentItemIds = ['OTHER']),
    (o: any) => o.shipments[0].packages.push(structuredClone(o.shipments[0].packages[0])),
    (o: any) => (o.shipments[0].packages[0].tracking.carrier.trackingUrl = 'javascript:alert(1)'),
  ]) {
    const o = order();
    mutate(o);
    assert.throws(() => parseMcfOrder(o), status(502));
  }
});
test('cancelled shipment followed by replacement is not counted as duplicate fulfillment; absent optional states remain unknown', () => {
  const o: any = order();
  const old = structuredClone(o.shipments[0]);
  old.amazonShipmentId = 'CANCELLED';
  old.status = 'CANCELLED';
  old.packages[0].packageId = 'CANCELLED-PKG';
  old.items[0].packageId = 'CANCELLED-PKG';
  old.items[0].amount = value('2');
  o.shipments.push(old);
  assert.equal(parseMcfOrder(o).shipments!.length, 2);
  delete o.status;
  delete o.shipments[0].packages[0].status;
  const t = mcfPackageTracking(parseMcfOrder(o));
  assert.equal(t[0].orderStatus, null);
  assert.equal(t[0].packageStatus, null);
  delete o.lineItems[0].amount.unit;
  assert.equal(parseMcfOrder(o).lineItems[0].amount.unit, undefined);
});
test('list pagination preserves filters on everypage and opaque query tokens, returning explicit complete result', async () => {
  const token = 'https://attacker.test/?token=secret+&';
  const h = harness((u) =>
    u.searchParams.has('pageToken')
      ? response({ orders: [order('TWO')], pagination: { nextToken: null } })
      : response({ orders: [order('ONE')], pagination: { nextToken: token } }),
  );
  const p = await h.client.orders({
    updatedAfter: '2026-10-01T00:00:00+02:00',
    shipments: 'EXCLUDE',
  });
  assert.equal(p.complete, true);
  assert.equal(p.pages, 2);
  assert.equal(p.orders.length, 2);
  for (const c of h.calls) {
    assert.equal(c.url.origin, 'https://sandbox.sellingpartnerapi-eu.amazon.com');
    assert.equal(c.url.searchParams.get('updatedAfter'), '2026-10-01T00:00:00+02:00');
    assert.equal(c.url.searchParams.get('shipments'), 'EXCLUDE');
  }
  assert.equal(h.calls[1].url.searchParams.get('pageToken'), token);
});
test('same-page/cross-page duplicate orders, cycling tokens, malformedtokens, page/order caps never yield a truncated complete result', async () => {
  assert.throws(() => parseMcfPage({ orders: [order('DUP'), order('DUP')] }), status(502));
  for (const token of ['', 123, 'bad\nToken'])
    assert.throws(
      () => parseMcfPage({ orders: [], pagination: { nextToken: token } }),
      status(502),
    );
  const duplicate = harness(() =>
    response({ orders: [order('DUP')], pagination: { nextToken: 'NEXT' } }),
  );
  await assert.rejects(
    duplicate.client.orders({ updatedAfter: '2026-10-01T00:00:00Z' }),
    status(502),
  );
  let n = 0;
  const cycle = harness(() =>
    response({ orders: [order('ORDER-' + ++n)], pagination: { nextToken: 'NEXT' } }),
  );
  await assert.rejects(cycle.client.orders({ updatedAfter: '2026-10-01T00:00:00Z' }), status(502));
  assert.equal(cycle.calls.length, 2);
  const capped = harness(() => response({ orders: [], pagination: { nextToken: 'NEXT' } }));
  await assert.rejects(
    capped.client.orders({ updatedAfter: '2026-10-01T00:00:00Z' }, undefined, {
      maxPages: 1,
      maxOrders: 10,
    }),
    status(502),
  );
  const over = harness(() => response({ orders: [order('ONE'), order('TWO')] }));
  await assert.rejects(
    over.client.orders({ updatedAfter: '2026-10-01T00:00:00Z' }, undefined, {
      maxPages: 2,
      maxOrders: 1,
    }),
    status(502),
  );
});
test('configured fulfillmentServiceId is sent and response scope is mandatory and exact', async () => {
  const h = harness(() => response(preview(), 200, 'FS-ONE'), 'FS-ONE');
  await h.client.preview(input());
  assert.equal(new Headers(h.calls[0].init.headers).get('x-amzn-fulfillment-service-id'), 'FS-ONE');
  for (const service of [undefined, 'FS-OTHER']) {
    const bad = harness(() => response(preview(), 200, service), 'FS-ONE');
    await assert.rejects(bad.client.preview(input()), status(502));
  }
});
test('HTTP errors, provider error envelope, lost/malformed/oversized response never retry or leak provider messages', async () => {
  for (const code of [400, 401, 403, 404, 413, 415, 429, 500, 503, 202]) {
    const h = harness(() => response({ errors: [{ code: 'X', message: 'PRIVATE_TOKEN' }] }, code));
    await assert.rejects(
      h.client.preview(input()),
      (e: unknown) => e instanceof Problem && !e.message.includes('PRIVATE_TOKEN'),
    );
    assert.equal(h.calls.length, 1);
  }
  const errors = harness(() =>
    response({ errors: [{ code: 'Unauthorized', message: 'PRIVATE_TOKEN' }], ...preview() }),
  );
  await assert.rejects(errors.client.preview(input()), status(502));
  const lost = harness(() => {
    throw new Error('PRIVATE_TOKEN');
  });
  const safeError = (e: unknown) =>
    e instanceof Problem && e.status === 502 && !e.message.includes('PRIVATE_TOKEN');
  await assert.rejects(lost.client.preview(input()), safeError);
  assert.equal(lost.calls.length, 1);
  const failedAuth = harness(() => response(preview()));
  failedAuth.auth.token = async () => {
    throw new Error('PRIVATE_TOKEN');
  };
  await assert.rejects(failedAuth.client.preview(input()), safeError);
  assert.equal(failedAuth.calls.length, 0);
  const malformed = harness(() => new Response('{broken'));
  await assert.rejects(malformed.client.preview(input()), status(502));
  const oversized = harness(() => new Response(' '.repeat(5 * 1024 * 1024 + 1)));
  await assert.rejects(oversized.client.preview(input()), status(502));
});
test('fence revocation before provider dispatch and after response prevents returning stale approved evidence', async () => {
  const h = harness(() => response(preview()));
  let n = 0;
  await assert.rejects(
    h.client.preview(input(), async () => {
      if (++n === 2) throw new Problem(403, 'Role revoked');
    }),
    status(403),
  );
  assert.equal(h.calls.length, 0);
  const after = harness(() => response(preview()));
  n = 0;
  await assert.rejects(
    after.client.preview(input(), async () => {
      if (++n === 3) throw new Problem(409, 'Grant changed');
    }),
    status(409),
  );
  assert.equal(after.calls.length, 1);
});
