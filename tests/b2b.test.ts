import { legacySerialOrderStatusPayload } from './order-status-cas-helper';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../server/app';
import { pool, tenantTx, migrate } from '../server/db';
import { seed, DEMO_TENANT, SECOND_TENANT } from './fixtures';
assert.equal(process.env.DYNA_TEST, 'true');
let app: any,
  admin: string,
  viewer: string,
  operator: string,
  other: string,
  warehouse: string,
  ip = 1;
const req = (path: string, method: any = 'GET', payload?: any, cookie = admin) =>
  app.inject({
    url: '/api' + path,
    method,
    payload,
    headers: { cookie },
    remoteAddress: '127.0.0.' + ((ip % 250) + 1),
  });
async function api(path: string, method: any = 'GET', body?: any, cookie = admin) {
  const r = await req(path, method, body, cookie);
  assert(r.statusCode < 300, r.body);
  return r.json();
}
before(async () => {
  await migrate();
  await seed();
  app = await buildApp();
  for (const [email, set] of [
    ['admin@demo.local', (c: string) => (admin = c)],
    ['viewer@demo.local', (c: string) => (viewer = c)],
    ['operator@demo.local', (c: string) => (operator = c)],
    ['other@demo.local', (c: string) => (other = c)],
  ] as const) {
    const r = await req('/auth/login', 'POST', { email, password: 'DynaDemo!2026' }, '');
    set(r.headers['set-cookie'].toString().split(';')[0]);
  }
  warehouse = (await api('/warehouses')).data[0].id;
});
after(async () => {
  await app?.close();
  await pool.end();
});
const address = {
  street: 'Hurtowa 1',
  city: 'Warszawa',
  postal_code: '00-001',
  country: 'PL',
  phone: '500600700',
};
const password = 'BuyerDemo!2026';
async function fixture(extra: any = {}) {
  ip++;
  const product = await api('/products', 'POST', {
    name: 'Produkt B2B',
    sku: 'B2B-' + randomUUID().slice(0, 10),
    price: 20000,
    vat: 23,
    warehouse_id: warehouse,
    quantity: extra.stock ?? 12,
  });
  const list = await api('/price-lists', 'POST', {
    name: 'Cennik kontrahenta ' + randomUUID().slice(0, 6),
    currency: extra.currency ?? 'PLN',
  });
  const updated = await api('/price-lists/' + list.id + '/items', 'PUT', {
    version: list.version,
    items: [{ product_id: product.id, price: 12345 }],
  });
  const body = {
    name: 'Kontrahent ' + randomUUID().slice(0, 6),
    email: randomUUID() + '@example.test',
    warehouse_id: warehouse,
    price_list_id: list.id,
    address,
    min_total: 20000,
    min_quantity: 2,
    quantity_step: 2,
    shipping_cost: 500,
    payment_mode: 'prepaid',
    ...extra.account,
  };
  const account = await api('/b2b/accounts', 'POST', body);
  const approved = await api('/b2b/accounts/' + account.id, 'PATCH', {
    ...body,
    version: account.version,
    active: true,
    confirmed: true,
  });
  const invite = await api('/b2b/accounts/' + account.id + '/invite', 'POST', {
    version: approved.version,
    confirmed: true,
  });
  const base = '/public/b2b/' + account.id;
  const token = invite.invitation.split('#invite=')[1];
  await api(base + '/activate', 'POST', { token, password }, '');
  const login = await req(base + '/login', 'POST', { email: body.email, password }, '');
  assert.equal(login.statusCode, 200, login.body);
  const cookie = login.headers['set-cookie'].toString().split(';')[0];
  return {
    product,
    list: { ...list, version: updated.version },
    body,
    account,
    base,
    cookie,
    token,
  };
}
const cart = (f: any, qty = 2, key = randomUUID()) => ({
  client_key: key,
  items: [{ product_id: f.product.id, quantity: qty }],
});
const quote = (f: any, qty = 2) => api(f.base + '/quotes', 'POST', cart(f, qty), f.cookie);
const checkout = (f: any, q: any) =>
  api(f.base + '/quotes/' + q.id + '/checkout', 'POST', { confirmed: true }, f.cookie);
const stock = (f: any) =>
  pool
    .query('SELECT on_hand,reserved FROM stock WHERE product_id=$1', [f.product.id])
    .then((r) => r.rows[0]);
const accountEdit = async (f: any, extra: any = {}) => {
  const a = (await api('/b2b/accounts?search=' + encodeURIComponent(f.body.email))).data.find(
    (a: any) => a.id === f.account.id,
  );
  return api('/b2b/accounts/' + a.id, 'PATCH', {
    ...f.body,
    version: a.version,
    active: true,
    confirmed: true,
    ...extra,
  });
};

test('staff roles and RLS protect account configuration and secrets are never returned', async () => {
  const f = await fixture();
  for (const cookie of [viewer, operator])
    assert.equal(
      (
        await req(
          '/b2b/accounts/' + f.account.id,
          'PATCH',
          { ...f.body, version: 4, active: false, confirmed: true },
          cookie,
        )
      ).statusCode,
      403,
    );
  const rows = await api('/b2b/accounts');
  const a = rows.data.find((a: any) => a.id === f.account.id);
  assert.equal(a.activated, true);
  assert.equal(a.password_hash, undefined);
  assert.equal(a.invite_hash, undefined);
  assert.equal(
    (
      await req(
        '/b2b/accounts/' + a.id + '/invite',
        'POST',
        { version: a.version, confirmed: true },
        other,
      )
    ).statusCode,
    404,
  );
  await tenantTx(SECOND_TENANT, async (c) => {
    for (const t of ['b2b_accounts', 'b2b_sessions', 'b2b_quotes'])
      assert.equal(
        (await c.query('SELECT * FROM ' + t + ' WHERE tenant_id=$1', [DEMO_TENANT])).rowCount,
        0,
      );
  });
});
test('one-use invitation and separate cookie cannot grant staff access or another partner identity', async () => {
  const f = await fixture(),
    g = await fixture();
  assert.equal(
    (await req(f.base + '/activate', 'POST', { token: f.token, password }, '')).statusCode,
    404,
  );
  assert.equal((await req('/products', 'GET', undefined, f.cookie)).statusCode, 401);
  assert.equal((await req(f.base + '/me', 'GET', undefined, admin)).statusCode, 401);
  assert.equal((await req(g.base + '/me', 'GET', undefined, f.cookie)).statusCode, 401);
  const bad = await req(
    f.base + '/login',
    'POST',
    { email: f.body.email, password: 'incorrect' },
    '',
  );
  assert.equal(bad.statusCode, 401);
  const m = await api(f.base + '/me', 'GET', undefined, f.cookie);
  assert.equal(m.account.name, f.body.name);
  assert.equal(m.account.password_hash, undefined);
});
test('catalog contains only explicit assigned prices and does not disclose staff stock or other catalog', async () => {
  const f = await fixture();
  const hidden = await api('/products', 'POST', {
    name: 'Private SKU',
    sku: 'PRIVATE-' + randomUUID(),
    price: 9999,
    quantity: 10,
    warehouse_id: warehouse,
  });
  const d = await api(f.base + '/catalog', 'GET', undefined, f.cookie);
  assert.equal(d.data.length, 1);
  assert.equal(d.data[0].price, 12345);
  assert.equal(d.data[0].available, 12);
  assert.equal(d.data[0].reserved, undefined);
  assert.equal(d.data[0].cost, undefined);
  assert.equal(
    (
      await req(
        f.base + '/quotes',
        'POST',
        { client_key: randomUUID(), items: [{ product_id: hidden.id, quantity: 2 }] },
        f.cookie,
      )
    ).statusCode,
    404,
  );
});
test('quote checks packaging and minimum value, freezes price and performs no stock mutation', async () => {
  const f = await fixture();
  assert.equal((await req(f.base + '/quotes', 'POST', cart(f, 1), f.cookie)).statusCode, 422);
  assert.equal((await req(f.base + '/quotes', 'POST', cart(f, 3), f.cookie)).statusCode, 422);
  const q = await quote(f);
  assert.equal(q.total, 25190);
  assert.deepEqual(await stock(f), { on_hand: 12, reserved: 0 });
  const replay = await api(f.base + '/quotes', 'POST', cart(f, 2, q.client_key), f.cookie);
  assert.equal(replay.id, q.id);
  assert.equal(
    (await req(f.base + '/quotes', 'POST', cart(f, 4, q.client_key), f.cookie)).statusCode,
    409,
  );
  assert.equal(
    (await req(f.base + '/quotes/' + q.id + '/checkout', 'POST', {}, f.cookie)).statusCode,
    422,
  );
});
test('parallel checkout replay creates one B2B order and one physical reservation', async () => {
  const f = await fixture(),
    q = await quote(f);
  const out = await Promise.all(Array.from({ length: 8 }, () => checkout(f, q)));
  assert.equal(new Set(out.map((o) => o.id)).size, 1);
  assert.equal(out[0].total, 25190);
  assert.deepEqual(await stock(f), { on_hand: 12, reserved: 2 });
  const o = await api('/orders/' + out[0].id);
  assert.equal(o.source, 'b2b');
  assert.equal(o.b2b_account_id, f.account.id);
  assert.equal(o.pricing_snapshot.list.id, f.list.id);
  assert.equal(o.b2b_snapshot.quote_id, q.id);
  const audits = (
    await pool.query(
      "SELECT user_id FROM audit_events WHERE entity_id=$1 AND action='b2b.checkout'",
      [o.id],
    )
  ).rows;
  assert.deepEqual(audits, [{ user_id: null }]);
});
test('two partner accounts racing for the last stock cannot oversell or save a partial order', async () => {
  const f = await fixture({ stock: 2 });
  const body = { ...f.body, email: randomUUID() + '@example.test' };
  const a = await api('/b2b/accounts', 'POST', body);
  await api('/b2b/accounts/' + a.id, 'PATCH', {
    ...body,
    active: true,
    version: 1,
    confirmed: true,
  });
  const inv = await api('/b2b/accounts/' + a.id + '/invite', 'POST', {
    version: 2,
    confirmed: true,
  });
  const base = '/public/b2b/' + a.id;
  await api(
    base + '/activate',
    'POST',
    { token: inv.invitation.split('#invite=')[1], password },
    '',
  );
  const l = await req(base + '/login', 'POST', { email: body.email, password }, '');
  assert.equal(l.statusCode, 200);
  const g = { ...f, base, cookie: l.headers['set-cookie'].toString().split(';')[0] };
  const [q, r] = await Promise.all([quote(f), quote(g)]);
  const results = await Promise.all([
    req(f.base + '/quotes/' + q.id + '/checkout', 'POST', { confirmed: true }, f.cookie),
    req(g.base + '/quotes/' + r.id + '/checkout', 'POST', { confirmed: true }, g.cookie),
  ]);
  assert.deepEqual(results.map((r: any) => r.statusCode).sort(), [200, 409]);
  assert.deepEqual(await stock(f), { on_hand: 2, reserved: 2 });
});
test('price or product changes require new quote while historical order prices remain immutable', async () => {
  const f = await fixture(),
    q = await quote(f),
    o = await checkout(f, q),
    stale = await quote(f);
  await api('/price-lists/' + f.list.id + '/items', 'PUT', {
    version: f.list.version,
    items: [{ product_id: f.product.id, price: 13000 }],
  });
  assert.equal(
    (await req(f.base + '/quotes/' + stale.id + '/checkout', 'POST', { confirmed: true }, f.cookie))
      .statusCode,
    409,
  );
  assert.equal((await checkout(f, q)).id, o.id);
  assert.equal((await api('/orders/' + o.id)).total, 25190);
  const fresh = await quote(f);
  assert.equal(fresh.total, 26500);
});
test('expired quotes and disabled accounts cannot checkout and existing sessions are revoked', async () => {
  const f = await fixture(),
    q = await quote(f);
  await pool.query("UPDATE b2b_quotes SET expires_at=now()-interval '1 second' WHERE id=$1", [
    q.id,
  ]);
  assert.equal(
    (await req(f.base + '/quotes/' + q.id + '/checkout', 'POST', { confirmed: true }, f.cookie))
      .statusCode,
    409,
  );
  await accountEdit(f, { active: false });
  assert.equal((await req(f.base + '/me', 'GET', undefined, f.cookie)).statusCode, 401);
  assert.equal(
    (await req(f.base + '/login', 'POST', { email: f.body.email, password }, '')).statusCode,
    401,
  );
  assert.deepEqual(await stock(f), { on_hand: 12, reserved: 0 });
});
test('reissued invitation revokes the old password and sessions and requires new activation', async () => {
  const f = await fixture(),
    a = (await api('/b2b/accounts')).data.find((a: any) => a.id === f.account.id);
  const inv = await api('/b2b/accounts/' + a.id + '/invite', 'POST', {
    version: a.version,
    confirmed: true,
  });
  assert(inv.invitation.includes('#invite='));
  assert.equal((await req(f.base + '/me', 'GET', undefined, f.cookie)).statusCode, 401);
  assert.equal(
    (await req(f.base + '/login', 'POST', { email: f.body.email, password }, '')).statusCode,
    401,
  );
});
test('B2B order history, details and return intake cannot cross partner account boundaries', async () => {
  const f = await fixture(),
    g = await fixture(),
    o = await checkout(f, await quote(f));
  assert.equal((await api(g.base + '/orders', 'GET', undefined, g.cookie)).data.length, 0);
  assert.equal((await req(g.base + '/orders/' + o.id, 'GET', undefined, g.cookie)).statusCode, 404);
  const d = await api(f.base + '/orders/' + o.id, 'GET', undefined, f.cookie);
  assert.equal(d.portal_token, undefined);
  assert.equal(d.note, undefined);
  assert.equal(d.payment.amount_due, 25190);
  assert.equal(
    (
      await req(
        g.base + '/orders/' + o.id + '/returns',
        'POST',
        {
          client_key: randomUUID(),
          reason: 'Zgłoszenie',
          items: [{ item_id: d.items[0].id, quantity: 1 }],
        },
        g.cookie,
      )
    ).statusCode,
    404,
  );
});
test('buyer process reaches shipment, printable invoice, partial return and seller settlement locally', async () => {
  const f = await fixture(),
    o = await checkout(f, await quote(f));
  await api('/orders/' + o.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => api(orderPath, 'GET', undefined), '/orders/' + o.id + '/status', { status: 'paid' }));
  await api('/orders/' + o.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => api(orderPath, 'GET', undefined), '/orders/' + o.id + '/status', { status: 'picking' }));
  for (let n = 0; n < 2; n++)
    await api('/orders/' + o.id + '/scan', 'POST', { code: f.product.sku });
  await api('/orders/' + o.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => api(orderPath, 'GET', undefined), '/orders/' + o.id + '/status', { status: 'packed' }));
  await api('/orders/' + o.id + '/ship-demo', 'POST', {});
  await api('/orders/' + o.id + '/documents', 'POST', { kind: 'invoice' });
  const d = await api(f.base + '/orders/' + o.id, 'GET', undefined, f.cookie);
  assert.equal(d.shipments.length, 1);
  assert.equal(d.documents.length, 1);
  const printed = await req(
    f.base + '/orders/' + o.id + '/documents/' + d.documents[0].id + '/print',
    'GET',
    undefined,
    f.cookie,
  );
  assert.equal(printed.statusCode, 200);
  assert.match(printed.body, /246,90/);
  assert.match(printed.body, /251,90/);
  const r = await api(
    f.base + '/orders/' + o.id + '/returns',
    'POST',
    {
      client_key: randomUUID(),
      kind: 'return',
      reason: 'Syntetyczny zwrot B2B',
      items: [{ item_id: d.items[0].id, quantity: 1 }],
    },
    f.cookie,
  );
  const stored = (await api('/orders/' + o.id)).returns.cases.find((x: any) => x.id === r.id);
  assert.equal(stored.submitted_by, 'buyer');
  const received = await api('/returns/' + r.id + '/receive', 'POST', {
    version: stored.version,
    note: 'QA odebrane',
    items: [{ item_id: d.items[0].id, accepted: 1, restocked: 1 }],
  });
  assert.equal(received.refund_amount, 12345);
  assert.deepEqual(await stock(f), { on_hand: 11, reserved: 0 });
  await api('/returns/' + r.id + '/refund', 'POST', {
    version: received.version,
    amount: 12345,
    reference: 'B2B QA refund declaration',
    confirmed: true,
  });
  assert.equal(
    (await api(f.base + '/orders/' + o.id, 'GET', undefined, f.cookie)).cases[0].state,
    'closed',
  );
});
test('foreign origins and read-only restore block buyer mutations while scoped login and history work', async () => {
  const f = await fixture();
  const bad = await app.inject({
    url: '/api' + f.base + '/quotes',
    method: 'POST',
    payload: cart(f),
    headers: { cookie: f.cookie, origin: 'https://invalid.example' },
  });
  assert.equal(bad.statusCode, 403);
  const restored = await buildApp({ readOnly: true, previewPort: 4199 });
  try {
    const login = await restored.inject({
      url: '/api' + f.base + '/login',
      method: 'POST',
      payload: { email: f.body.email, password },
      remoteAddress: '127.0.0.240',
    });
    assert.equal(login.statusCode, 200);
    const cookie = login.headers['set-cookie']!.toString().split(';')[0];
    assert(cookie.startsWith('dyna_b2b_preview_4199='));
    assert.equal(
      (await restored.inject({ url: '/api' + f.base + '/catalog', headers: { cookie } }))
        .statusCode,
      200,
    );
    for (const path of ['/quotes', '/activate'])
      assert.equal(
        (
          await restored.inject({
            url: '/api' + f.base + path,
            method: 'POST',
            payload: {},
            headers: { cookie },
          })
        ).statusCode,
        423,
      );
  } finally {
    await restored.close();
  }
});

test('EUR variants and bundles expose only assigned prices and reserve physical components', async () => {
  const f = await fixture({
    currency: 'EUR',
    account: { min_total: 0, min_quantity: 1, quantity_step: 1 },
  });
  const group = await api('/products', 'POST', {
    name: 'Grupa B2B',
    sku: 'GROUP-' + randomUUID(),
    price: 0,
    kind: 'group',
    warehouse_id: warehouse,
  });
  const variant = await api('/products', 'POST', {
    name: 'Wariant B2B',
    sku: 'VAR-' + randomUUID(),
    price: 9900,
    kind: 'variant',
    parent_id: group.id,
    warehouse_id: warehouse,
    quantity: 5,
  });
  const bundle = await api('/products', 'POST', {
    name: 'Zestaw B2B',
    sku: 'BUNDLE-' + randomUUID(),
    price: 9900,
    kind: 'bundle',
    warehouse_id: warehouse,
    components: [
      { product_id: f.product.id, quantity: 2 },
      { product_id: variant.id, quantity: 1 },
    ],
  });
  await api('/price-lists/' + f.list.id + '/items', 'PUT', {
    version: f.list.version,
    items: [
      { product_id: bundle.id, price: 1500 },
      { product_id: variant.id, price: 300 },
    ],
  });
  const catalog = await api(f.base + '/catalog', 'GET', undefined, f.cookie);
  assert.equal(catalog.currency, 'EUR');
  assert(!catalog.data.some((p: any) => p.id === group.id));
  assert.equal(catalog.data.find((p: any) => p.id === bundle.id).available, 5);
  const q = await api(
    f.base + '/quotes',
    'POST',
    {
      client_key: randomUUID(),
      items: [
        { product_id: bundle.id, quantity: 2 },
        { product_id: variant.id, quantity: 1 },
      ],
    },
    f.cookie,
  );
  assert.equal(q.total, 3800);
  const o = await checkout(f, q),
    d = await api('/orders/' + o.id);
  assert.equal(d.currency, 'EUR');
  assert.equal(d.total, 3800);
  assert.equal((await stock(f)).reserved, 4);
  assert.equal((await stock({ product: variant })).reserved, 3);
  assert.equal(
    (await api(f.base + '/catalog', 'GET', undefined, f.cookie)).data.find(
      (p: any) => p.id === bundle.id,
    ).available,
    2,
  );
  await api('/orders/' + o.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => api(orderPath, 'GET', undefined), '/orders/' + o.id + '/status', { status: 'cancelled' }));
  assert.equal((await stock(f)).reserved, 0);
  assert.equal((await stock({ product: variant })).reserved, 0);
});

test('catalog and own history cursors page without duplicates or another account records', async () => {
  const f = await fixture({
    stock: 100,
    account: { min_total: 0, min_quantity: 1, quantity_step: 1 },
  });
  const prefix = 'PAGE-' + randomUUID().slice(0, 8),
    items = [];
  for (let n = 0; n < 51; n++) {
    const p = await api('/products', 'POST', {
      name: 'Strona B2B ' + n,
      sku: prefix + '-' + n,
      price: 100,
      warehouse_id: warehouse,
      quantity: 0,
    });
    items.push({ product_id: p.id, price: 100 });
  }
  await api('/price-lists/' + f.list.id + '/items', 'PUT', { version: f.list.version, items });
  const first = await api(f.base + '/catalog?search=' + prefix, 'GET', undefined, f.cookie);
  assert.equal(first.data.length, 50);
  assert(first.next);
  const second = await api(
    f.base + '/catalog?search=' + prefix + '&after=' + first.next,
    'GET',
    undefined,
    f.cookie,
  );
  assert.equal(second.data.length, 1);
  assert.equal(second.next, null);
  assert.equal(new Set([...first.data, ...second.data].map((p: any) => p.id)).size, 51);
  for (let n = 0; n < 26; n++) await checkout(f, await quote(f, 1));
  const page = await api(f.base + '/orders', 'GET', undefined, f.cookie);
  assert.equal(page.data.length, 25);
  assert(page.next);
  const more = await api(f.base + '/orders?after=' + page.next, 'GET', undefined, f.cookie);
  assert.equal(more.data.length, 1);
  assert.equal(more.next, null);
  assert.equal(new Set([...page.data, ...more.data].map((o: any) => o.id)).size, 26);
  const g = await fixture();
  assert.equal(
    (await api(g.base + '/orders?after=' + page.next, 'GET', undefined, g.cookie)).data.length,
    0,
  );
});

test('changed account conditions require a new quote and addresses cannot be empty', async () => {
  const f = await fixture(),
    q = await quote(f);
  assert.equal(
    (
      await req('/b2b/accounts', 'POST', {
        ...f.body,
        email: randomUUID() + '@example.test',
        address: {},
      })
    ).statusCode,
    422,
  );
  await accountEdit(f, { shipping_cost: 700 });
  assert.equal((await req(f.base + '/me', 'GET', undefined, f.cookie)).statusCode, 401);
  const login = await req(f.base + '/login', 'POST', { email: f.body.email, password }, '');
  assert.equal(login.statusCode, 200);
  f.cookie = login.headers['set-cookie'].toString().split(';')[0];
  assert.equal(
    (await req(f.base + '/quotes/' + q.id + '/checkout', 'POST', { confirmed: true }, f.cookie))
      .statusCode,
    409,
  );
  assert.equal((await quote(f)).total, 25390);
  assert.equal((await stock(f)).reserved, 0);
});

test('buyer images require current catalog membership and cannot read private uploads', async () => {
  const f = await fixture(),
    g = await fixture();
  const image = await api('/product-images', 'POST', {
    data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jfN8AAAAASUVORK5CYII=',
  });
  const privateImage = await api('/product-images', 'POST', {
    data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jfN8AAAAASUVORK5CYII=',
  });
  try {
    const p = await api('/products/' + f.product.id);
    await api('/products/' + p.id, 'PATCH', { ...p, images: [image.url] });
    const entry = (await api(f.base + '/catalog', 'GET', undefined, f.cookie)).data.find(
      (p: any) => p.id === f.product.id,
    );
    const url = entry.images[0].slice(4);
    const r = await req(url, 'GET', undefined, f.cookie);
    assert.equal(r.statusCode, 200);
    assert.equal(r.headers['content-type'], 'image/png');
    assert.equal(
      (await req(url.replace(image.id, privateImage.id), 'GET', undefined, f.cookie)).statusCode,
      404,
    );
    assert.equal((await req(url, 'GET', undefined, g.cookie)).statusCode, 401);
    assert.equal(
      (
        await req(
          g.base + '/catalog/' + f.product.id + '/images/' + image.id,
          'GET',
          undefined,
          g.cookie,
        )
      ).statusCode,
      404,
    );
    await api('/price-lists/' + f.list.id + '/items', 'PUT', {
      version: f.list.version,
      items: [{ product_id: f.product.id, price: null }],
    });
    assert.equal((await req(url, 'GET', undefined, f.cookie)).statusCode, 404);
  } finally {
    await tenantTx(DEMO_TENANT, async (c) => {
      await c.query("UPDATE products SET images='[]'::jsonb WHERE id=$1", [f.product.id]);
      await c.query('DELETE FROM product_images WHERE id=ANY($1::uuid[])', [
        [image.id, privateImage.id],
      ]);
    });
    const { unlink } = await import('node:fs/promises');
    for (const img of [image, privateImage])
      await unlink('data/product-images/' + img.id).catch(() => {});
  }
});

test('catalog edit and buyer checkout keep a consistent lock order and reject stale prices', async () => {
  const f = await fixture(),
    q = await quote(f);
  let pending: Promise<any> | undefined;
  await tenantTx(DEMO_TENANT, async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      'catalog:' + DEMO_TENANT,
    ]);
    pending = req(f.base + '/quotes/' + q.id + '/checkout', 'POST', { confirmed: true }, f.cookie);
    let waiting = false;
    for (let n = 0; n < 100; n++) {
      waiting = !!(
        await pool.query(
          "SELECT 1 FROM pg_locks WHERE locktype='advisory' AND NOT granted AND mode='ShareLock'",
        )
      ).rowCount;
      if (waiting) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert(waiting, 'Checkout should wait for the catalog lock');
    await c.query("UPDATE products SET name=name||' edycja',version=version+1 WHERE id=$1", [
      f.product.id,
    ]);
  });
  const r = await pending!;
  assert.equal(r.statusCode, 409, r.body);
  assert.equal((await stock(f)).reserved, 0);
});
