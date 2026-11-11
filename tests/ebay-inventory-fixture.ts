import assert from 'node:assert/strict';
import { ebayBase, EBAY_READ_SCOPE, EBAY_INVENTORY_SCOPE } from '../server/ebay';
import { demoEbayCatalog, demoEbayOrder } from '../server/ebay-example';
import type { Transport } from '../server/integrations';
export function ebayInventoryFixture(count = 3) {
  const rows = demoEbayCatalog();
  for (let n = 3; n < count; n++)
    rows.push({
      ...structuredClone(rows[0]),
      item: { ...structuredClone(rows[0].item), sku: 'EBAY-SKU-' + n },
      offers: rows[0].offers.map((o) => ({
        ...structuredClone(o),
        sku: 'EBAY-SKU-' + n,
        offerId: 'OFFER-' + n,
      })),
    });
  const state = {
    token: 0,
    scope: EBAY_READ_SCOPE + ' ' + EBAY_INVENTORY_SCOPE,
    edit: undefined as ((url: URL, v: any) => void) | undefined,
    hook: undefined as ((url: URL) => Promise<void>) | undefined,
    notFound: false,
  };
  const calls: { url: string; method: string }[] = [];
  const transport: Transport = async (url, init) => {
    const u = new URL(url);
    calls.push({ url, method: String(init.method) });
    assert.equal(u.origin, ebayBase('sandbox'));
    assert.equal(init.redirect, 'error');
    await state.hook?.(u);
    let v: any;
    if (u.pathname === '/identity/v1/oauth2/token') {
      assert.equal(init.method, 'POST');
      assert.equal(
        (init.headers as any).Authorization,
        'Basic ' + Buffer.from('DEMO-client:DEMO-secret').toString('base64'),
      );
      const params = new URLSearchParams(init.body as string);
      assert.equal(params.get('scope'), state.scope);
      assert.equal(params.get('grant_type'), 'refresh_token');
      v = {
        access_token: 'INVENTORY-DEMO-' + ++state.token,
        expires_in: 7200,
        token_type: 'User Access Token',
      };
    } else {
      assert.equal(init.method, 'GET');
      assert.equal((init.headers as any).Authorization, 'Bearer INVENTORY-DEMO-' + state.token);
      if (u.pathname === '/sell/inventory/v1/inventory_item') {
        assert.equal(u.searchParams.get('limit'), '25');
        const offset = Number(u.searchParams.get('offset'));
        const next = new URL(u);
        next.searchParams.set('offset', String(offset + 1));
        const data = rows.slice(offset * 25, (offset + 1) * 25).map((r) => r.item);
        v = {
          inventoryItems: data,
          size: data.length,
          total: rows.length,
          limit: 25,
          ...((offset + 1) * 25 < rows.length ? { next: next.toString() } : {}),
        };
      } else if (u.pathname.startsWith('/sell/inventory/v1/inventory_item_group/')) {
        const key = decodeURIComponent(u.pathname.split('/').at(-1)!);
        v = rows.find((r) => r.group?.inventoryItemGroupKey === key)?.group;
        assert(v);
      } else if (u.pathname === '/sell/inventory/v1/offer') {
        assert.equal(u.searchParams.get('marketplace_id'), 'EBAY_DE');
        assert.equal(u.searchParams.get('limit'), '25');
        if (state.notFound)
          return new Response(JSON.stringify({ errors: [{ errorId: 25713 }] }), { status: 404 });
        const sku = u.searchParams.get('sku'),
          data = rows.find((r) => r.item.sku === sku)?.offers;
        assert(data);
        v = { offers: data, size: data.length, total: data.length, limit: 25 };
      } else if (u.pathname.startsWith('/sell/fulfillment/v1/order')) {
        const { id, _dyna, ...o } = demoEbayOrder();
        o.lastModifiedDate = new Date(Date.now() - 60000).toISOString();
        v = u.pathname.endsWith('/order') ? { orders: [o], total: 1, limit: 50, offset: 0 } : o;
      } else throw new Error('Unexpected path ' + u.pathname);
    }
    v = structuredClone(v);
    state.edit?.(u, v);
    return new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json' } });
  };
  return { rows, state, calls, transport };
}
