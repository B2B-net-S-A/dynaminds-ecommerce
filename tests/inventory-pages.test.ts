import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../server/app';
import { pool, migrate } from '../server/db';
import { seed, SECOND_TENANT } from './fixtures';
import { tenantScopedOwnerQuery } from './tenant-scoped-owner-write';
assert.equal(process.env.DYNA_TEST, 'true');
let app: Awaited<ReturnType<typeof buildApp>>,
  cookie: string,
  other: string,
  viewer: string,
  tenant: string,
  w: string,
  w2: string,
  readKey: string;
const products: any[] = [];
const req = (url: string, method: any = 'GET', payload?: any, auth = cookie) =>
  app.inject({ url, method, payload, headers: auth ? { cookie: auth } : {} });
const cookieOf = (r: any) => r.headers['set-cookie'].toString().split(';')[0];
before(async () => {
  await migrate();
  await seed();
  app = await buildApp();
  const registered = await req('/api/auth/signup', 'POST', {
    name: 'Paginacja magazynu',
    email: randomUUID() + '@example.test',
    password: 'PaginationLocal!2026',
    organization: { name: 'Paginacja magazynu' },
  });
  assert.equal(registered.statusCode, 201, registered.body);
  cookie = cookieOf(registered);
  tenant = registered.json().user.tenant_id;
  const upgraded = await req('/api/workspaces/plan', 'PATCH', { plan: 'enterprise' });
  assert.equal(upgraded.statusCode, 200, upgraded.body);
  w = (await req('/api/warehouses')).json().data[0].id;
  const secondWarehouse = await req('/api/warehouses', 'POST', {
    name: 'Magazyn stron',
    code: 'PAGE2',
  });
  assert.equal(secondWarehouse.statusCode, 200, secondWarehouse.body);
  w2 = secondWarehouse.json().id;
  for (let i = 0; i < 205; i++) {
    const r = await req('/api/products', 'POST', {
      name: 'Produkt stron ' + i,
      sku: 'INV-PAGE-' + String(i).padStart(4, '0'),
      ean: 'PAGE-EAN-' + i,
      price: 1000,
      warehouse_id: w,
      quantity: 10,
      active: i !== 137,
    });
    assert.equal(r.statusCode, 201, r.body);
    products.push(r.json());
  }
  for (const p of products.slice(0, 10))
    await tenantScopedOwnerQuery(
      tenant,
      'INSERT INTO stock(tenant_id,warehouse_id,product_id,on_hand) VALUES($1,$2,$3,3)',
      [tenant, w2, p.id],
    );
  other = cookieOf(
    await req('/api/auth/login', 'POST', { email: 'other@demo.local', password: 'DynaDemo!2026' }),
  );
  const viewerId = (await pool.query("SELECT id FROM users WHERE email='viewer@demo.local'"))
    .rows[0].id;
  await pool.query("INSERT INTO memberships(user_id,tenant_id,role) VALUES($1,$2,'viewer')", [
    viewerId,
    tenant,
  ]);
  const v = await req('/api/auth/login', 'POST', {
    email: 'viewer@demo.local',
    password: 'DynaDemo!2026',
  });
  const switched = await req('/api/workspaces/switch', 'POST', { tenant_id: tenant }, cookieOf(v));
  assert.equal(switched.statusCode, 200, switched.body);
  viewer = cookieOf(switched);
  const key = await req('/api/developer/keys', 'POST', {
    name: 'Odczyt magazynu',
    scopes: ['inventory:read'],
  });
  assert.equal(key.statusCode, 201, key.body);
  readKey = key.json().token;
});
after(async () => {
  app.server.closeAllConnections();
  await app.close();
  await pool.end();
});
async function all(path: string, auth = cookie, firstCursor = '') {
  let after = firstCursor,
    pages = 0;
  const rows: any[] = [];
  do {
    const r = await req(
      path + (after ? '&after=' + encodeURIComponent(after) : ''),
      'GET',
      undefined,
      auth,
    );
    assert.equal(r.statusCode, 200, r.body);
    const p = r.json();
    rows.push(...p.data);
    after = p.meta.cursor ?? '';
    assert.equal(p.meta.has_more, !!after);
    assert(++pages < 40);
  } while (after);
  return rows;
}
test('215 stanów w dwóch magazynach: ograniczony domyślny odczyt i wszystkie unikalne strony', async () => {
  const first = await req('/api/inventory');
  assert.equal(first.statusCode, 200);
  assert.equal(first.json().data.length, 50);
  assert(first.json().meta.has_more);
  const rows = await all('/api/inventory?limit=17');
  assert.equal(rows.length, 215);
  const expected = (
    await pool.query(
      'SELECT warehouse_id,product_id FROM stock WHERE tenant_id=$1 ORDER BY warehouse_id,product_id',
      [tenant],
    )
  ).rows.map((s) => s.warehouse_id + ':' + s.product_id);
  assert.deepEqual(
    rows.map((s) => s.warehouse_id + ':' + s.product_id),
    expected,
  );
  assert(
    rows.every(
      (s) => s.tenant_id === tenant && Number(s.on_hand) - Number(s.reserved) === s.available,
    ),
  );
  const filtered = await all('/api/inventory?limit=19&warehouse_id=' + w);
  assert.equal(filtered.length, 205);
  assert(filtered.every((s) => s.warehouse_id === w));
});
test('wyszukiwanie nazwy, SKU, EAN, nieaktywnego stanu i dokładnego produktu nie zależy od strony', async () => {
  for (const search of ['INV-PAGE-0137', 'PAGE-EAN-137', 'Produkt stron 137']) {
    const r = await req('/api/inventory?search=' + encodeURIComponent(search));
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().data.length, 1);
    assert.equal(r.json().data[0].product_id, products[137].id);
  }
  const rows = await all('/api/inventory?limit=1&product_id=' + products[0].id);
  assert.equal(rows.length, 2);
  const r = await req('/api/inventory?product_id=' + products[0].id + '&warehouse_id=' + w2);
  assert.equal(r.json().data[0].on_hand, 3);
});
test('snapshot ma dokładne wersje 200 pozycji; rzeczywisty HTTP przy maksymalnym URL', async () => {
  const ids = products.slice(0, 200).map((p) => p.id);
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  assert(address && typeof address === 'object');
  const response = await fetch(
    'http://127.0.0.1:' +
      address.port +
      '/api/inventory/snapshot?' +
      new URLSearchParams({ warehouse_id: w, product_ids: ids.join(',') }),
    { headers: { cookie }, signal: AbortSignal.timeout(10000) },
  );
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.data.length, 200);
  assert.deepEqual(data.meta, { requested: 200, found: 200 });
  const actual = (
    await pool.query(
      'SELECT product_id,version FROM stock WHERE tenant_id=$1 AND warehouse_id=$2 AND product_id=ANY($3::uuid[])',
      [tenant, w, ids],
    )
  ).rows;
  for (const s of data.data)
    assert.equal(s.version, actual.find((a) => a.product_id === s.product_id)!.version);
  const duplicate = await req(
    '/api/inventory/snapshot?warehouse_id=' + w + '&product_ids=' + ids[0] + ',' + ids[0],
  );
  assert.deepEqual(duplicate.json().meta, { requested: 1, found: 1 });
});
test('RLS, odczyt widza i scope publicznego API obejmują strony oraz snapshoty', async () => {
  for (const path of [
    '/api/inventory?limit=1&warehouse_id=' + w,
    '/api/inventory/snapshot?warehouse_id=' + w + '&product_ids=' + products[0].id,
  ]) {
    const denied = await req(path, 'GET', undefined, other);
    assert.equal(denied.statusCode, 200, denied.body);
    assert.deepEqual(denied.json().data, []);
    const allowed = await req(path, 'GET', undefined, viewer);
    assert.equal(allowed.statusCode, 200, allowed.body);
    assert.equal(allowed.json().data.length, 1);
    const pub = await app.inject({
      url: path.replace('/api/', '/api/v1/'),
      headers: { authorization: 'Bearer ' + readKey },
    });
    assert.equal(pub.statusCode, 200, pub.body);
    assert.equal(pub.json().data[0].tenant_id, tenant);
  }
  assert.equal(
    (
      await req(
        '/api/inventory/adjust',
        'POST',
        { product_id: products[0].id, warehouse_id: w, delta: 1, note: 'Odmowa widza' },
        viewer,
      )
    ).statusCode,
    403,
  );
  const noRead = await req('/api/developer/keys', 'POST', {
    name: 'Tylko zamówienia',
    scopes: ['orders:read'],
  });
  assert.equal(
    (
      await app.inject({
        url: '/api/v1/inventory',
        headers: { authorization: 'Bearer ' + noRead.json().token },
      })
    ).statusCode,
    403,
  );
  const foreign = (
    await pool.query('SELECT product_id FROM stock WHERE tenant_id=$1 LIMIT 1', [SECOND_TENANT])
  ).rows[0].product_id;
  const mixed = await req(
    '/api/inventory/snapshot?warehouse_id=' + w + '&product_ids=' + products[0].id + ',' + foreign,
  );
  assert.deepEqual(mixed.json().meta, { requested: 2, found: 1 });
});
test('błędne limity, UUID, kursory i nadmiar pozycji snapshotu są odrzucane', async () => {
  for (const q of [
    'limit=0',
    'limit=201',
    'limit=2.5',
    'warehouse_id=bad',
    'product_id=bad',
    'after=bad',
    'after=' + Buffer.from(JSON.stringify(['bad', 'bad'])).toString('base64url'),
    'search=' + 'a'.repeat(101),
  ])
    assert.equal((await req('/api/inventory?' + q)).statusCode, 422, q);
  for (const ids of ['', products.map((p) => p.id).join(','), 'bad', products[0].id + ','])
    assert.equal(
      (await req('/api/inventory/snapshot?warehouse_id=' + w + '&product_ids=' + ids)).statusCode,
      422,
    );
  assert.equal((await req('/api/inventory/movements?after=bad')).statusCode, 422);
  assert.equal((await req('/api/inventory/movements?limit=201')).statusCode, 422);
});
test('snapshot służy inwentaryzacji i nie omija konfliktu rezerwacji po pomiarze', async () => {
  const p = products[200];
  const snapshot = (
    await req('/api/inventory/snapshot?warehouse_id=' + w + '&product_ids=' + p.id)
  ).json().data[0];
  const body = {
    kind: 'count',
    warehouse_id: w,
    lines: [{ product_id: p.id, quantity: 9, expected_version: snapshot.version }],
  };
  const order = await req('/api/orders', 'POST', {
    customer_name: 'Rezerwacja stron',
    email: 'page@example.test',
    warehouse_id: w,
    items: [{ product_id: p.id, quantity: 1 }],
  });
  assert.equal(order.statusCode, 201, order.body);
  assert.equal((await req('/api/warehouse-documents', 'POST', body)).statusCode, 409);
  const fresh = (
    await req('/api/inventory/snapshot?warehouse_id=' + w + '&product_ids=' + p.id)
  ).json().data[0];
  assert.notEqual(fresh.version, snapshot.version);
  const draft = await req('/api/warehouse-documents', 'POST', {
    ...body,
    lines: [{ ...body.lines[0], expected_version: fresh.version }],
  });
  assert.equal(draft.statusCode, 201, draft.body);
  const posted = await req('/api/warehouse-documents/' + draft.json().id + '/post', 'POST', {
    version: draft.json().version,
  });
  assert.equal(posted.statusCode, 200, posted.body);
  const final = (await req('/api/inventory?warehouse_id=' + w + '&product_id=' + p.id)).json()
    .data[0];
  assert.equal(final.on_hand, 9);
  assert.equal(final.reserved, 1);
});
test('ruchy o równej dacie i mikrosekundach nie giną, również po usunięciu wiersza kursora', async () => {
  for (let i = 0; i < 7; i++)
    await tenantScopedOwnerQuery(
      tenant,
      "INSERT INTO stock_movements(id,tenant_id,warehouse_id,product_id,delta,kind,note,created_at) VALUES($1,$2,$3,$4,1,'page-fixture','Mikro historia',$5)",
      [
        randomUUID(),
        tenant,
        w,
        products[0].id,
        '2026-01-01T10:00:00.123' + String(450 + Math.floor(i / 2)).padStart(3, '0') + 'Z',
      ],
    );
  const expected = (
    await pool.query(
      "SELECT id FROM stock_movements WHERE tenant_id=$1 AND kind='page-fixture' ORDER BY created_at DESC,id DESC",
      [tenant],
    )
  ).rows.map((r) => r.id);
  const rows = await all('/api/inventory/movements?kind=page-fixture&limit=1');
  assert.deepEqual(
    rows.map((r) => r.id),
    expected,
  );
  assert(rows.every((r) => !('cursor_time' in r)));
  const first = (await req('/api/inventory/movements?kind=page-fixture&limit=1')).json();
  await pool.query('DELETE FROM stock_movements WHERE id=$1', [first.data[0].id]);
  const rest = await all(
    '/api/inventory/movements?kind=page-fixture&limit=2',
    cookie,
    first.meta.cursor,
  );
  assert.deepEqual(
    rest.map((r) => r.id),
    expected.slice(1),
  );
  assert.deepEqual(
    (
      await req(
        '/api/inventory/movements?warehouse_id=' + w + '&kind=page-fixture',
        'GET',
        undefined,
        other,
      )
    ).json().data,
    [],
  );
});
test('lista zamówień zachowuje mikrosekundy i wszystkie ID przy remisie czasu', async () => {
  for (let i = 0; i < 6; i++)
    await pool.query(
      "INSERT INTO orders(id,tenant_id,number,customer_name,email,status,total,warehouse_id,portal_token,created_at) VALUES($1,$2,$3,'Mikro OMS','micro@example.test','cancelled',0,$4,$5,$6)",
      [
        randomUUID(),
        tenant,
        'MICRO-PAGE-' + i,
        w,
        randomUUID().replaceAll('-', ''),
        '2026-01-01T10:00:00.123' + String(450 + Math.floor(i / 2)).padStart(3, '0') + 'Z',
      ],
    );
  const expected = (
    await pool.query(
      "SELECT id FROM orders WHERE tenant_id=$1 AND number LIKE 'MICRO-PAGE-%' ORDER BY created_at DESC,id DESC",
      [tenant],
    )
  ).rows.map((r) => r.id);
  const rows = await all('/api/orders?limit=1&search=MICRO-PAGE-');
  assert.deepEqual(
    rows.map((r) => r.id),
    expected,
  );
  assert(rows.every((r) => !('cursor_time' in r)));
});
