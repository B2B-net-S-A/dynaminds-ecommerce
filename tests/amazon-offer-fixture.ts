import assert from 'node:assert/strict';
import type { Transport } from '../server/integrations';
import { AMAZON_OFFER_DATA } from '../server/amazon-offers';
import { amazonSecrets } from './amazon-fixture';
export const offerConfig = {
  region: 'eu',
  marketplace_id: 'A1C3SOZRARQ6R3',
  selling_partner_id: 'ADEMO075',
  listing_write: 'true',
};
export function amazonOfferFixture() {
  const market = offerConfig.marketplace_id;
  const store = new Map<string, any>(),
    calls: { path: string; method: string; body: any }[] = [];
  const state = {
    omitIssues: false,
    delay: false,
    lost: false,
    status: 'ACCEPTED',
    fail429: false,
    unauthorized: false,
    hook: undefined as undefined | ((u: URL, method: string) => Promise<void>),
    pending: undefined as undefined | (() => void),
  };
  const markets = [market, 'A1PA6795UKMFR9'];
  const item = (sku: string) => ({
    sku,
    summaries: markets.map((m) => ({ marketplaceId: m, productType: 'SHIRT' })),
    attributes: {
      color: [{ value: 'Black', marketplace_id: market }],
      fulfillment_availability: [
        {
          fulfillment_channel_code: 'DEFAULT',
          quantity: 8,
          lead_time_to_ship_max_days: 2,
          restock_date: '2026-10-10',
        },
      ],
      purchasable_offer: [
        {
          marketplace_id: market,
          currency: 'PLN',
          audience: 'ALL',
          our_price: [{ schedule: [{ value_with_tax: 123.45 }] }],
          discounted_price: [
            { schedule: [{ value_with_tax: 100, start_at: '2026-10-01', end_at: '2026-10-10' }] },
          ],
          minimum_seller_allowed_price: [{ schedule: [{ value_with_tax: 50 }] }],
          automated_pricing_merchandising_rule_plan: [{ value: 'KEEP' }],
        },
        {
          marketplace_id: market,
          currency: 'PLN',
          audience: 'B2B',
          our_price: [{ schedule: [{ value_with_tax: 90 }] }],
          quantity_discount_plan: [{ value: 'KEEP' }],
        },
        {
          marketplace_id: markets[1],
          currency: 'EUR',
          audience: 'ALL',
          our_price: [{ schedule: [{ value_with_tax: 25 }] }],
        },
      ],
    },
    offers: [
      { marketplaceId: market, offerType: 'B2C', price: { currencyCode: 'PLN', amount: '100.00' } },
    ],
    fulfillmentAvailability: [
      { fulfillmentChannelCode: 'DEFAULT', quantity: 8 },
      { fulfillmentChannelCode: 'AMAZON_EU', quantity: 12 },
    ],
    relationships: [],
  });
  const json = (p: any, status = 200, headers?: Record<string, string>) =>
    new Response(JSON.stringify(p), { status, headers });
  const transport: Transport = async (url, init) => {
    const u = new URL(url),
      method = String(init.method),
      body = method === 'PATCH' ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path: u.pathname, method, body });
    assert.equal(init.redirect, 'error');
    await state.hook?.(u, method);
    if (u.hostname === 'api.amazon.com') {
      assert.equal(
        new URLSearchParams(String(init.body)).get('refresh_token'),
        amazonSecrets.refresh_token,
      );
      return json({ access_token: 'OFFER-QA', token_type: 'bearer', expires_in: 3600 });
    }
    assert.equal(u.origin, 'https://sandbox.sellingpartnerapi-eu.amazon.com');
    assert.equal((init.headers as any)['x-amz-access-token'], 'OFFER-QA');
    if (u.pathname === '/sellers/v1/marketplaceParticipations')
      return json({
        payload: markets.map((id) => ({
          marketplace: { id },
          participation: { isParticipating: true, hasSuspendedListings: false },
        })),
      });
    assert(u.pathname.startsWith('/listings/2021-08-01/items/ADEMO075/'));
    const sku = decodeURIComponent(u.pathname.split('/').at(-1)!);
    const r = store.get(sku);
    assert(r);
    if (method === 'GET') {
      assert.equal(u.searchParams.get('includedData'), AMAZON_OFFER_DATA);
      return json(r);
    }
    assert.equal(method, 'PATCH');
    assert.equal(u.searchParams.get('marketplaceIds'), market);
    assert.equal(body.productType, 'SHIRT');
    if (state.fail429) {
      state.fail429 = false;
      return json({}, 429, { 'retry-after': '30' });
    }
    if (state.unauthorized) {
      state.unauthorized = false;
      return json({}, 401);
    }
    if (state.status === 'INVALID')
      return json({
        sku,
        status: 'INVALID',
        submissionId: 'QA-INVALID',
        issues: [{ code: 'ERROR075', message: 'Rejected QA value', severity: 'ERROR' }],
      });
    const apply = () => {
      for (const patch of body.patches) {
        assert.equal(patch.op, 'merge');
        assert.equal(patch.value.length, 1);
        const v = patch.value[0];
        if (patch.path === '/attributes/fulfillment_availability') {
          assert.deepEqual(Object.keys(v).sort(), ['fulfillment_channel_code', 'quantity']);
          assert.equal(v.fulfillment_channel_code, 'DEFAULT');
          r.attributes.fulfillment_availability[0].quantity = v.quantity;
          r.fulfillmentAvailability[0].quantity = v.quantity;
        } else {
          assert.equal(patch.path, '/attributes/purchasable_offer');
          assert.equal(v.audience, 'ALL');
          assert.equal(v.marketplace_id, market);
          assert.equal(v.currency, 'PLN');
          assert.deepEqual(Object.keys(v).sort(), [
            'audience',
            'currency',
            'marketplace_id',
            'our_price',
          ]);
          r.attributes.purchasable_offer[0].our_price = structuredClone(v.our_price);
        }
      }
    };
    if (state.delay) state.pending = apply;
    else apply();
    if (state.lost) {
      state.lost = false;
      throw new Error('Lost PATCH response QA');
    }
    return json({
      sku,
      status: 'ACCEPTED',
      submissionId: 'QA-SUBMISSION075',
      ...(state.omitIssues ? {} : { issues: [] }),
    });
  };
  return { store, calls, state, item, transport, markets };
}
