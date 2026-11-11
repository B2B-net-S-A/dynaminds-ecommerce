import assert from 'node:assert/strict';
import { amazonFixture } from './amazon-fixture';
import type { Transport } from '../server/integrations';
export function amazonFulfillmentFixture() {
  const base = amazonFixture(),
    packages: any[] = [];
  const calls: { url: string; init: RequestInit }[] = [];
  const state = {
    post: 204,
    apply: true,
    lose: false,
    hide: false,
    getError: 0,
    retryAfter: '0',
    hook: undefined as undefined | ((url: URL, init: RequestInit) => Promise<void>),
    edit: undefined as undefined | ((raw: any) => void),
  };
  const transport: Transport = async (url, init) => {
    const u = new URL(url);
    calls.push({ url, init });
    await state.hook?.(u, init);
    if (u.pathname.endsWith('/shipmentConfirmation')) {
      assert.equal(init.method, 'POST');
      assert.equal(init.redirect, 'error');
      assert.equal(u.search, '');
      assert.equal(u.origin, 'https://sandbox.sellingpartnerapi-eu.amazon.com');
      assert.equal(
        (init.headers as any)['x-amz-access-token'],
        'DEMO-amazon-access-' + base.state.token,
      );
      const b = JSON.parse(init.body as string),
        d = b.packageDetail;
      assert.deepEqual(Object.keys(b).sort(), ['marketplaceId', 'packageDetail']);
      if (state.apply) {
        packages.push({
          packageReferenceId: d.packageReferenceId,
          carrier: d.carrierCode === 'Other' ? d.carrierName : d.carrierCode,
          trackingNumber: d.trackingNumber,
          shipTime: d.shipDate,
          packageItems: d.orderItems,
          ...(d.shippingMethod ? { shippingService: d.shippingMethod } : {}),
          packageStatus: { status: 'SHIPPED' },
        });
      }
      if (state.lose) throw Error('LOST PRIVATE SECRET');
      return new Response(state.post === 204 ? null : '{}', {
        status: state.post,
        headers: { 'retry-after': state.retryAfter },
      });
    }
    if (u.pathname.startsWith('/orders/2026-01-01/orders/') && state.getError)
      return new Response('{}', {
        status: state.getError,
        headers: { 'retry-after': state.retryAfter },
      });
    const r = await base.transport(url, init);
    if (u.pathname.startsWith('/orders/2026-01-01/orders/') && r.ok) {
      const raw = (await r.json()) as any;
      if (packages.length) raw.packages = state.hide ? [] : structuredClone(packages);
      if (raw.packages?.length) {
        raw.fulfillment.fulfillmentStatus = 'SHIPPED';
        for (const i of raw.orderItems) {
          i.fulfillment.quantityFulfilled = i.quantityOrdered;
          i.fulfillment.quantityUnfulfilled = 0;
        }
      }
      state.edit?.(raw);
      return new Response(JSON.stringify(raw));
    }
    return r;
  };
  return { base, packages, calls, state, transport };
}
