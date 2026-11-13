import assert from 'node:assert/strict';
import { demoAmazonOrder } from '../server/amazon-example';
import { AMAZON_DATA, amazonBase } from '../server/amazon';
import type { Transport } from '../server/integrations';
export const amazonSecrets = {
  client_id: 'DEMO-amazon-client',
  client_secret: 'DEMO-amazon-secret',
  refresh_token: 'DEMO-amazon-refresh',
};
export const amazonConfig = { region: 'eu', marketplace_id: 'A1C3SOZRARQ6R3' };
export function amazonFixture(count = 1) {
  const orders = Array.from({ length: count }, (_, n) => ({
    ...demoAmazonOrder(),
    id: `123-1234567-${String(n + 1).padStart(7, '0')}`,
    orderId: `123-1234567-${String(n + 1).padStart(7, '0')}`,
  }));
  const calls: { url: string; method: string }[] = [];
  const state = {
    token: 0,
    fail401: false,
    fail429: false,
    retryAfter: '180',
    loop: false,
    edit: undefined as undefined | ((v: any) => void),
    hook: undefined as undefined | ((u: URL, i: RequestInit) => Promise<void>),
  };
  const transport: Transport = async (url, init) => {
    const u = new URL(url);
    calls.push({ url, method: String(init.method) });
    assert.equal(init.redirect, 'error');
    await state.hook?.(u, init);
    let result: any;
    if (u.origin === 'https://api.amazon.com') {
      assert.equal(u.pathname, '/auth/o2/token');
      assert.equal(init.method, 'POST');
      const p = new URLSearchParams(init.body as string);
      assert.equal(p.get('grant_type'), 'refresh_token');
      assert.equal(p.get('client_id'), amazonSecrets.client_id);
      assert.equal(p.get('client_secret'), amazonSecrets.client_secret);
      assert.equal(p.get('refresh_token'), amazonSecrets.refresh_token);
      assert.equal(p.get('scope'), null);
      result = {
        access_token: 'DEMO-amazon-access-' + ++state.token,
        expires_in: 3600,
        token_type: 'bearer',
      };
    } else {
      assert.equal(u.origin, amazonBase('sandbox', 'eu'));
      assert.equal(init.method, 'GET');
      // Any access token issued so far: like LWA, an earlier token stays valid until it expires, and two
      // concurrent requests may each refresh one (amazon-imports: concurrent commits).
      const issued = /^DEMO-amazon-access-(\d+)$/.exec((init.headers as any)['x-amz-access-token']);
      assert(issued && Number(issued[1]) >= 1 && Number(issued[1]) <= state.token, 'Unissued Amazon access token');
      assert.equal((init.headers as any).Authorization, undefined);
      assert.equal(u.searchParams.get('includedData'), AMAZON_DATA);
      if (state.fail401) {
        state.fail401 = false;
        return new Response('{}', { status: 401 });
      }
      if (state.fail429)
        return new Response('{}', { status: 429, headers: { 'retry-after': state.retryAfter } });
      if (u.pathname.endsWith('/orders')) {
        assert.equal(u.searchParams.get('maxResultsPerPage'), '50');
        assert.equal(u.searchParams.get('marketplaceIds'), amazonConfig.marketplace_id);
        assert(u.searchParams.has('lastUpdatedAfter'));
        assert(u.searchParams.has('lastUpdatedBefore'));
        const offset = Number(u.searchParams.get('paginationToken') ?? '0');
        result = {
          orders: orders.slice(offset, offset + 50).map(({ id, ...o }) => o),
          ...(offset + 50 < orders.length
            ? { pagination: { nextToken: String(state.loop ? offset : offset + 50) } }
            : {}),
        };
      } else {
        const o = orders.find((o) => o.id === u.pathname.split('/').at(-1));
        assert(o);
        const { id, ...raw } = o;
        result = raw;
      }
    }
    result = structuredClone(result);
    state.edit?.(result);
    return new Response(JSON.stringify(result), {
      headers: { 'content-type': 'application/json', 'x-amzn-RateLimit-Limit': '5' },
    });
  };
  return { orders, state, calls, transport };
}
