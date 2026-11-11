import assert from 'node:assert/strict';
import { demoEbayOrder } from '../server/ebay-example';
import { ebayBase, EBAY_READ_SCOPE } from '../server/ebay';
import type { Transport } from '../server/integrations';
export const ebaySecrets = {
  client_id: 'DEMO-client',
  client_secret: 'DEMO-secret',
  refresh_token: 'DEMO-refresh',
};
export function ebayFixture(count = 1) {
  const orders = Array.from({ length: count }, (_, n) => ({
    ...demoEbayOrder(),
    lastModifiedDate: new Date(Date.now() - 60000).toISOString(),
    id: `DEMO-EBAY-${n + 1}`,
    orderId: `DEMO-EBAY-${n + 1}`,
  }));
  const calls: { url: string; method: string }[] = [];
  const state = {
    token: 0,
    hook: undefined as undefined | ((url: URL, init: RequestInit) => Promise<void>),
    edit: undefined as undefined | ((v: any) => void),
  };
  const transport: Transport = async (url, init) => {
    const u = new URL(url);
    calls.push({ url, method: String(init.method) });
    assert.equal(u.origin, ebayBase('sandbox'));
    assert.equal(init.redirect, 'error');
    await state.hook?.(u, init);
    let result: any;
    if (u.pathname === '/identity/v1/oauth2/token') {
      assert.equal(init.method, 'POST');
      assert.equal(
        (init.headers as any).Authorization,
        'Basic ' + Buffer.from('DEMO-client:DEMO-secret').toString('base64'),
      );
      const b = new URLSearchParams(init.body as string);
      assert.equal(b.get('grant_type'), 'refresh_token');
      assert.equal(b.get('refresh_token'), 'DEMO-refresh');
      assert.equal(b.get('scope'), EBAY_READ_SCOPE);
      result = {
        access_token: 'DEMO-access-' + ++state.token,
        expires_in: 7200,
        token_type: 'User Access Token',
      };
    } else {
      assert.equal(init.method, 'GET');
      assert.equal((init.headers as any).Authorization, 'Bearer DEMO-access-' + state.token);
      assert.equal(u.searchParams.get('fieldGroups'), 'TAX_BREAKDOWN');
      if (u.pathname === '/sell/fulfillment/v1/order') {
        const offset = Number(u.searchParams.get('offset'));
        assert.equal(u.searchParams.get('limit'), '50');
        assert.match(u.searchParams.get('filter')!, /^lastmodifieddate:\[.+\.\..+\]$/);
        const next = new URL(u);
        next.searchParams.set('offset', String(offset + 50));
        result = {
          orders: orders.slice(offset, offset + 50).map((o) => {
            const { id, _dyna, ...raw } = o;
            return raw;
          }),
          total: orders.length,
          offset,
          limit: 50,
          ...(offset + 50 < orders.length ? { next: next.toString() } : {}),
        };
      } else {
        result = orders.find(
          (o) => o.orderId === decodeURIComponent(u.pathname.split('/').at(-1)!),
        );
        assert(result);
        const { id, _dyna, ...raw } = result;
        result = raw;
      }
    }
    result = structuredClone(result);
    state.edit?.(result);
    return new Response(JSON.stringify(result), {
      headers: { 'content-type': 'application/json' },
    });
  };
  return { orders, calls, state, transport };
}
