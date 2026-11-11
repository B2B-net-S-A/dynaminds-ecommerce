import assert from 'node:assert/strict';
import { demoEbayOrder } from '../server/ebay-example';
import { ebayBase, EBAY_FULFILLMENT_WRITE_SCOPE, EBAY_TRADING_SCOPE } from '../server/ebay';
import type { Transport } from '../server/integrations';
export function ebayFulfillmentFixture() {
  const order = demoEbayOrder(),
    calls: { url: string; init: RequestInit }[] = [],
    fulfillments: any[] = [];
  const state = {
    token: 0,
    post: 201,
    retryAfter: '0',
    lose: false,
    apply: true,
    badLocation: false,
    getError: 0,
    collectionEdit: undefined as undefined | ((v: any) => void),
    hook: undefined as undefined | ((url: URL, init: RequestInit) => Promise<void>),
  };
  const transport: Transport = async (url, init) => {
    calls.push({ url, init });
    const u = new URL(url);
    assert.equal(u.origin, ebayBase('sandbox'));
    assert.equal(init.redirect, 'error');
    assert(init.signal);
    await state.hook?.(u, init);
    if (u.pathname === '/identity/v1/oauth2/token') {
      const b = new URLSearchParams(init.body as string);
      assert([EBAY_FULFILLMENT_WRITE_SCOPE, EBAY_TRADING_SCOPE].includes(b.get('scope')!));
      assert.equal(b.get('grant_type'), 'refresh_token');
      if (b.get('scope') === EBAY_TRADING_SCOPE)
        return new Response(
          JSON.stringify({
            access_token: 'ACCOUNT-ACCESS',
            expires_in: 7200,
            token_type: 'User Access Token',
          }),
        );
      state.token++;
      return new Response(
        JSON.stringify({
          access_token: 'FULFILLMENT-ACCESS-' + state.token,
          expires_in: 7200,
          token_type: 'User Access Token',
        }),
      );
    }
    if (u.pathname === '/ws/api.dll') {
      assert.equal((init.headers as any)['X-EBAY-API-IAF-TOKEN'], 'ACCOUNT-ACCESS');
      return new Response(
        '<GetUserResponse xmlns="urn:ebay:apis:eBLBaseComponents"><Ack>Success</Ack><User><EIASToken>FULFILLMENT-EIAS</EIASToken><UserID>fixture-seller</UserID></User></GetUserResponse>',
      );
    }
    assert.equal((init.headers as any).Authorization, 'Bearer FULFILLMENT-ACCESS-' + state.token);
    if (u.pathname.endsWith('/shipping_fulfillment')) {
      if (init.method === 'POST') {
        assert.equal((init.headers as any)['Content-Type'], 'application/json');
        const p = JSON.parse(init.body as string);
        assert.deepEqual(Object.keys(p).sort(), [
          'lineItems',
          'shippedDate',
          'shippingCarrierCode',
          'trackingNumber',
        ]);
        if (state.apply) {
          fulfillments.push({
            fulfillmentId: p.trackingNumber,
            shippingCarrierCode: p.shippingCarrierCode,
            shipmentTrackingNumber: p.trackingNumber,
            shippedDate: p.shippedDate,
            lineItems: p.lineItems,
          });
          order.orderFulfillmentStatus = 'FULFILLED';
          order.lineItems.forEach((i) => (i.lineItemFulfillmentStatus = 'FULFILLED'));
        }
        if (state.lose) throw Error('lost SECRET DO-NOT-LEAK');
        return new Response(null, {
          status: state.post,
          headers: {
            'retry-after': state.retryAfter,
            location: state.badLocation
              ? 'https://evil.invalid/secret'
              : u.toString() + '/' + p.trackingNumber,
          },
        });
      }
      assert.equal(init.method, 'GET');
      if (state.getError)
        return new Response('{}', {
          status: state.getError,
          headers: { 'retry-after': state.retryAfter },
        });
      const v: any = { total: fulfillments.length, fulfillments: structuredClone(fulfillments) };
      state.collectionEdit?.(v);
      return new Response(JSON.stringify(v));
    }
    assert.equal(init.method, 'GET');
    assert.equal(u.searchParams.get('fieldGroups'), 'TAX_BREAKDOWN');
    const { id, _dyna, ...raw } = order;
    if (u.pathname === '/sell/fulfillment/v1/order')
      return new Response(JSON.stringify({ orders: [raw], total: 1, offset: 0, limit: 50 }));
    assert.equal(u.pathname, '/sell/fulfillment/v1/order/' + order.orderId);
    return new Response(JSON.stringify(raw));
  };
  return { order, calls, fulfillments, state, transport };
}
