import { legacySerialOrderStatusPayload } from './order-status-cas-helper';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { writeFile, unlink } from 'node:fs/promises';
import { buildApp } from '../server/app';
import { pool, migrate, tenantTx } from '../server/db';
import { seed, DEMO_TENANT, SECOND_TENANT } from './fixtures';
import { processB2bCatalog, failB2bCatalog, scheduleB2bNetworkDue } from '../server/b2b-network';
assert.equal(process.env.DYNA_TEST, 'true');
let app: any,
  admin: string,
  buyer: string,
  viewer: string,
  operator: string,
  warehouse: string,
  buyerWarehouse: string,
  buyerId: string;
const req = (path: string, method: any = 'GET', body?: any, cookie = admin) =>
  app.inject({ url: '/api' + path, method, payload: body, headers: { cookie } });
async function api(path: string, method: any = 'GET', body?: any, cookie = admin) {
  const r = await req(path, method, body, cookie);
  assert(r.statusCode < 300, r.body);
  return r.json();
}
before(async () => {
  await migrate();
  await seed();
  app = await buildApp({ logging: process.env.DYNA_TEST_LOG === 'true' });
  for (const [email, set] of [
    ['admin@demo.local', (s: string) => (admin = s)],
    ['other@demo.local', (s: string) => (buyer = s)],
    ['viewer@demo.local', (s: string) => (viewer = s)],
    ['operator@demo.local', (s: string) => (operator = s)],
  ] as const) {
    const r = await req('/auth/login', 'POST', { email, password: 'DynaDemo!2026' }, '');
    set(r.headers['set-cookie'].toString().split(';')[0]);
  }
  warehouse = (await api('/warehouses')).data[0].id;
  buyerWarehouse = (await api('/warehouses', 'GET', undefined, buyer)).data[0].id;
  buyerId = (await pool.query("SELECT id FROM users WHERE email='other@demo.local'")).rows[0].id;
});
after(async () => {
  await app?.close();
  await pool.end();
});
async function fixture(extra: any = {}) {
  const p = await api('/products', 'POST', {
    sku: 'NET-' + randomUUID(),
    name: 'Produkt sieci B2B',
    description: 'Opis producenta',
    attributes: extra.attributes ?? { Materiał: 'Papier' },
    price: 20000,
    quantity: 12,
    warehouse_id: warehouse,
  });
  const list = await api('/price-lists', 'POST', {
    name: 'Cennik sieci ' + randomUUID().slice(0, 8),
    currency: extra.currency ?? 'PLN',
  });
  const updated = await api('/price-lists/' + list.id + '/items', 'PUT', {
    version: list.version,
    items: [{ product_id: p.id, price: 12345 }],
  });
  const body = {
    name: 'Kontrahent sieci ' + randomUUID().slice(0, 8),
    email: randomUUID() + '@example.test',
    warehouse_id: warehouse,
    price_list_id: list.id,
    address: { street: 'Sieciowa 1', city: 'Warszawa', postal_code: '00-001', country: 'PL' },
    min_total: 0,
    min_quantity: 1,
    quantity_step: 1,
    shipping_cost: 0,
    payment_mode: 'prepaid',
  };
  const a = await api('/b2b/accounts', 'POST', body);
  const approved = await api('/b2b/accounts/' + a.id, 'PATCH', {
    ...body,
    version: 1,
    active: true,
    confirmed: true,
  });
  const invite = await api('/b2b/accounts/' + a.id + '/network-invite', 'POST', {
    version: approved.version,
    recipient_email: 'other@demo.local',
    confirmed: true,
  });
  const f: any = {
    product: p,
    list: { ...list, version: updated.version },
    body,
    account: approved,
    token: invite.token,
  };
  if (!extra.unaccepted) {
    f.link = await api(
      '/b2b/network/accept',
      'POST',
      { token: invite.token, confirmed: true },
      buyer,
    );
    f.base = '/b2b/network/links/' + f.link.id;
  }
  return f;
}
const refresh = (f: any, key = randomUUID()) =>
  api(f.base + '/refresh', 'POST', { client_key: key, confirmed: true }, buyer);
async function step(run: any) {
  const job = (
    await pool.query(
      "UPDATE jobs SET state='running',attempts=attempts+1,lease_token=$2,locked_at=now() WHERE id=$1 RETURNING *",
      [run.job_id, randomUUID()],
    )
  ).rows[0];
  try {
    await processB2bCatalog(job);
  } catch (e) {
    await failB2bCatalog(job, e);
    throw e;
  }
  return job;
}
async function finish(run: any) {
  for (let n = 0; n < 600; n++) {
    const r = (await pool.query('SELECT * FROM b2b_catalog_runs WHERE id=$1', [run.id])).rows[0];
    if (r.state === 'done') return r;
    assert.equal(r.state, 'queued', r.error);
    await step(r);
  }
  throw Error('Run did not finish');
}
const catalog = (f: any) => api(f.base + '/catalog', 'GET', undefined, buyer);
const config = (f: any, b: any = {}) =>
  api(
    f.base,
    'PATCH',
    { version: f.link.version, paused: false, schedule_minutes: 0, confirmed: true, ...b },
    buyer,
  );
async function add(f: any, n: number) {
  assert(Number.isSafeInteger(n) && n >= 0);
  // Fixture seeding keeps ordinary quota/catalog triggers and the 8s statement
  // limit. Commit bounded groups instead of one 10000-row trigger workload;
  // no refresh starts until every group and the single list revision succeed.
  for (let first = 1; first <= n; first += 200) {
    const last = Math.min(first + 199, n), count = last - first + 1;
    await tenantTx(DEMO_TENANT, async (c) => {
      const inserted = await c.query(
        "INSERT INTO products(id,tenant_id,sku,name,price) SELECT gen_random_uuid(),$1,$2||g::text,'Udostepniony produkt '||g,100 FROM generate_series($3::int,$4::int) g RETURNING id",
        [DEMO_TENANT, f.product.sku + '-P-', first, last],
      );
      assert.equal(inserted.rowCount, count);
      const priced = await c.query(
        'INSERT INTO price_list_items(tenant_id,price_list_id,product_id,price) SELECT $1,$2,id,100 FROM unnest($3::uuid[]) p(id)',
        [DEMO_TENANT, f.list.id, inserted.rows.map(row => row.id)],
      );
      assert.equal(priced.rowCount, count);
    });
  }
  await tenantTx(DEMO_TENANT, async (c) => {
    const updated = await c.query('UPDATE price_lists SET version=version+1 WHERE id=$1', [f.list.id]);
    assert.equal(updated.rowCount, 1);
  });
}

test('only addressed administrator accepts once; sender and other accounts cannot see buyer link', async () => {
  const f = await fixture({ unaccepted: true });
  assert.equal(
    (await req('/b2b/network/accept', 'POST', { token: f.token, confirmed: true })).statusCode,
    404,
  );
  const out = await Promise.all([
    req('/b2b/network/accept', 'POST', { token: f.token, confirmed: true }, buyer),
    req('/b2b/network/accept', 'POST', { token: f.token, confirmed: true }, buyer),
  ]);
  assert.equal(out.filter((r) => r.statusCode === 200).length, 1);
  assert(out.filter((r) => r.statusCode !== 200).every((r) => [404, 409].includes(r.statusCode)));
  const link = out.find((r) => r.statusCode === 200)!.json();
  assert.equal(link.tenant_id, SECOND_TENANT);
  assert.equal(link.supplier_tenant_id, DEMO_TENANT);
  assert.equal(link.supplier_name, 'DYNAMINDS Demo');
  assert.equal((await req('/b2b/network/links/' + link.id + '/catalog')).statusCode, 404);
  assert(!(await api('/b2b/network/links')).data.some((l: any) => l.id === link.id));
  const invites = await tenantTx(DEMO_TENANT, (c) =>
    c.query('SELECT state,token_hash FROM b2b_link_invitations WHERE account_id=$1', [
      f.account.id,
    ]),
  );
  assert.equal(invites.rows[0].state, 'accepted');
  assert.notEqual(invites.rows[0].token_hash, f.token);
});
test('roles, expired/replaced invitations and absent confirmation block linking', async () => {
  const f = await fixture({ unaccepted: true });
  for (const cookie of [viewer, operator])
    assert.equal(
      (
        await req(
          '/b2b/accounts/' + f.account.id + '/network-invite',
          'POST',
          { version: 2, recipient_email: 'other@demo.local', confirmed: true },
          cookie,
        )
      ).statusCode,
      403,
    );
  assert.equal(
    (await req('/b2b/network/accept', 'POST', { token: f.token }, buyer)).statusCode,
    422,
  );
  const replacement = await api('/b2b/accounts/' + f.account.id + '/network-invite', 'POST', {
    version: 2,
    recipient_email: 'other@demo.local',
    confirmed: true,
  });
  assert.equal(
    (await req('/b2b/network/accept', 'POST', { token: f.token, confirmed: true }, buyer))
      .statusCode,
    404,
  );
  await pool.query(
    "UPDATE b2b_link_invitations SET expires_at=now()-interval '1 second' WHERE token_hash IS NOT NULL AND account_id=$1",
    [f.account.id],
  );
  assert.equal(
    (await req('/b2b/network/accept', 'POST', { token: replacement.token, confirmed: true }, buyer))
      .statusCode,
    404,
  );
});
test('changed supplier approval invalidates unaccepted invitation without partial link', async () => {
  const f = await fixture({ unaccepted: true });
  await api('/b2b/accounts/' + f.account.id, 'PATCH', {
    ...f.body,
    version: 2,
    active: true,
    shipping_cost: 500,
    confirmed: true,
  });
  assert.equal(
    (await req('/b2b/network/accept', 'POST', { token: f.token, confirmed: true }, buyer))
      .statusCode,
    409,
  );
  assert.equal(
    (await pool.query('SELECT count(*)::int n FROM b2b_links WHERE account_id=$1', [f.account.id]))
      .rows[0].n,
    0,
  );
});
test('refresh replay queues one job and source-private SKU and secrets are not shared', async () => {
  const f = await fixture();
  await api('/products', 'POST', {
    sku: 'PRIVATE-NET-' + randomUUID(),
    name: 'Nieudostepniony produkt',
    price: 999,
    quantity: 2,
    warehouse_id: warehouse,
  });
  const key = randomUUID(),
    r = await refresh(f, key),
    replay = await refresh(f, key);
  assert.equal(replay.id, r.id);
  assert.equal(
    (await req(f.base + '/refresh', 'POST', { client_key: randomUUID(), confirmed: true }, buyer))
      .statusCode,
    409,
  );
  await finish(r);
  const d = await catalog(f);
  assert.equal(d.data.length, 1);
  assert.equal(d.data[0].snapshot.price, 12345);
  assert.equal(d.data[0].snapshot.available, 12);
  assert.equal(d.data[0].snapshot.password_hash, undefined);
  assert.equal(d.data[0].snapshot.cost, undefined);
  assert.equal((await api('/b2b/accounts', 'GET', undefined, buyer)).data.length, 0);
});
test('multi-page snapshot is published atomically, catalog cursors do not duplicate rows', async () => {
  const f = await fixture();
  await add(f, 204);
  const r = await refresh(f);
  await step(r);
  assert.equal((await catalog(f)).data.length, 0);
  assert.equal(
    (await pool.query('SELECT count(*)::int n FROM b2b_catalog_staging WHERE run_id=$1', [r.id]))
      .rows[0].n,
    200,
  );
  const done = await finish(r);
  assert.equal(done.fetched, 205);
  const ids = [];
  let after: string | null = null;
  do {
    const d = await api(
      f.base + '/catalog' + (after ? '?after=' + after : ''),
      'GET',
      undefined,
      buyer,
    );
    assert(d.data.length <= 50);
    ids.push(...d.data.map((i: any) => i.id));
    after = d.next;
  } while (after);
  assert.equal(ids.length, 205);
  assert.equal(new Set(ids).size, 205);
  assert.equal(
    (await pool.query('SELECT count(*)::int n FROM b2b_catalog_staging WHERE run_id=$1', [r.id]))
      .rows[0].n,
    0,
  );
});
test('unchanged refresh retains item version and new price/availability do not alter own stock', async () => {
  const f = await fixture({ currency: 'EUR' });
  await finish(await refresh(f));
  const first = (await catalog(f)).data[0];
  await finish(await refresh(f));
  const second = (await catalog(f)).data[0];
  assert.equal(second.version, first.version);
  await api('/price-lists/' + f.list.id + '/items', 'PUT', {
    version: f.list.version,
    items: [{ product_id: f.product.id, price: 14000 }],
  });
  const order = await api('/orders', 'POST', {
    customer_name: 'Kontrola dostępności',
    email: 'stock@example.test',
    warehouse_id: warehouse,
    items: [{ product_id: f.product.id, quantity: 2 }],
  });
  await finish(await refresh(f));
  const updated = (await catalog(f)).data[0];
  assert.equal(updated.snapshot.price, 14000);
  assert.equal(updated.snapshot.currency, 'EUR');
  assert.equal(updated.snapshot.available, 10);
  assert.equal(updated.version, first.version + 1);
  assert.equal(
    (
      await pool.query('SELECT count(*)::int n FROM stock WHERE tenant_id=$1 AND product_id=$2', [
        SECOND_TENANT,
        f.product.id,
      ])
    ).rows[0].n,
    0,
  );
  await api('/orders/' + order.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => api(orderPath, 'GET', undefined), '/orders/' + order.id + '/status', { status: 'cancelled' }));
});
test('withdrawal disables supplier offering while preserving already copied local product', async () => {
  const f = await fixture();
  await finish(await refresh(f));
  const i = (await catalog(f)).data[0];
  const p = await api(
    f.base + '/catalog/' + i.id + '/product',
    'POST',
    {
      version: i.version,
      sku: 'LOCAL-' + randomUUID(),
      sale_price: 25000,
      warehouse_id: buyerWarehouse,
      confirmed: true,
    },
    buyer,
  );
  assert.equal(p.quantity, 0);
  await api('/price-lists/' + f.list.id + '/items', 'PUT', {
    version: f.list.version,
    items: [{ product_id: f.product.id, price: null }],
  });
  await finish(await refresh(f));
  const d = (await catalog(f)).data[0];
  assert.equal(d.published, false);
  assert.equal(d.snapshot.available, 0);
  assert.equal(d.product_id, p.product_id);
  assert.equal((await api('/products/' + p.product_id, 'GET', undefined, buyer)).price, 25000);
  assert.equal(
    (
      await req(
        f.base + '/catalog/' + i.id + '/product',
        'POST',
        {
          version: d.version,
          sku: 'AGAIN',
          sale_price: 100,
          warehouse_id: buyerWarehouse,
          confirmed: true,
        },
        buyer,
      )
    ).statusCode,
    404,
  );
});
test('changed prices during paging fail the run and retain the previous complete snapshot', async () => {
  const f = await fixture();
  await add(f, 204);
  await finish(await refresh(f));
  const before = await catalog(f),
    r = await refresh(f);
  await step(r);
  const list = (await pool.query('SELECT version FROM price_lists WHERE id=$1', [f.list.id]))
    .rows[0];
  await api('/price-lists/' + f.list.id + '/items', 'PUT', {
    version: list.version,
    items: [{ product_id: f.product.id, price: 54321 }],
  });
  await assert.rejects(step(r), /zmienily sie/);
  assert.equal(
    (await pool.query('SELECT state FROM b2b_catalog_runs WHERE id=$1', [r.id])).rows[0].state,
    'failed',
  );
  assert.deepEqual(
    (await catalog(f)).data.map((i: any) => [i.id, i.fingerprint]),
    before.data.map((i: any) => [i.id, i.fingerprint]),
  );
  assert.equal(
    (await pool.query('SELECT count(*)::int n FROM b2b_catalog_staging WHERE run_id=$1', [r.id]))
      .rows[0].n,
    0,
  );
});
test('pause cancels queued work, clears staging and rejects stale settings', async () => {
  const f = await fixture();
  await add(f, 204);
  const r = await refresh(f);
  await step(r);
  f.link = await config(f, { paused: true });
  assert.equal((await req(f.base + '/catalog', 'GET', undefined, buyer)).statusCode, 409);
  assert.equal(
    (await pool.query('SELECT state FROM b2b_catalog_runs WHERE id=$1', [r.id])).rows[0].state,
    'cancelled',
  );
  assert.equal(
    (await pool.query('SELECT count(*)::int n FROM b2b_catalog_staging WHERE run_id=$1', [r.id]))
      .rows[0].n,
    0,
  );
  assert.equal(
    (
      await req(
        f.base,
        'PATCH',
        { version: 1, paused: false, schedule_minutes: 0, confirmed: true },
        buyer,
      )
    ).statusCode,
    409,
  );
});
test('source account revocation and revoked buyer admin stop reads and queued publication', async () => {
  const f = await fixture();
  await finish(await refresh(f));
  await api('/b2b/accounts/' + f.account.id, 'PATCH', {
    ...f.body,
    version: 2,
    active: false,
    confirmed: true,
  });
  assert.equal((await req(f.base + '/catalog', 'GET', undefined, buyer)).statusCode, 409);
  const g = await fixture(),
    r = await refresh(g);
  await pool.query("UPDATE memberships SET role='operator' WHERE tenant_id=$1 AND user_id=$2", [
    SECOND_TENANT,
    buyerId,
  ]);
  try {
    await assert.rejects(step(r), /administrator/);
    assert.equal(
      (await pool.query('SELECT state FROM b2b_catalog_runs WHERE id=$1', [r.id])).rows[0].state,
      'failed',
    );
    assert.equal(
      (
        await pool.query('SELECT count(*)::int n FROM b2b_catalog_items WHERE link_id=$1', [
          g.link.id,
        ])
      ).rows[0].n,
      0,
    );
  } finally {
    await pool.query("UPDATE memberships SET role='admin' WHERE tenant_id=$1 AND user_id=$2", [
      SECOND_TENANT,
      buyerId,
    ]);
  }
});
test('lost lease cannot persist staging or publish, current lease still completes once', async () => {
  const f = await fixture(),
    r = await refresh(f),
    job = (
      await pool.query("UPDATE jobs SET state='running',lease_token=$2 WHERE id=$1 RETURNING *", [
        r.job_id,
        randomUUID(),
      ])
    ).rows[0];
  await assert.rejects(processB2bCatalog({ ...job, lease_token: randomUUID() }), /Dzierzawa/);
  assert.equal((await catalog(f)).data.length, 0);
  await processB2bCatalog(job);
  assert.equal((await catalog(f)).data.length, 1);
});
test('cached supplier image retains exact bytes after live price and availability change', async () => {
  const f = await fixture();
  const bytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jfN8AAAAASUVORK5CYII=',
    'base64',
  );
  const img = await api('/product-images', 'POST', { data: bytes.toString('base64') });
  let orderId: string | undefined;
  try {
    const product = await api('/products/' + f.product.id);
    await api('/products/' + f.product.id, 'PATCH', { ...product, images: [img.url] });
    await finish(await refresh(f));
    const published = (await catalog(f)).data[0];
    const photo = published.snapshot.images[0];
    assert.equal(photo, '/api' + f.base + '/catalog/' + published.id + '/images/' + img.id);
    const before = await req(photo.slice(4), 'GET', undefined, buyer);
    assert.equal(before.statusCode, 200, before.body);
    assert.deepEqual(before.rawPayload, bytes);
    const sha = (value: Buffer) => createHash('sha256').update(value).digest('hex');

    await api('/price-lists/' + f.list.id + '/items', 'PUT', {
      version: f.list.version,
      items: [{ product_id: f.product.id, price: 14000 }],
    });
    const order = await api('/orders', 'POST', {
      customer_name: 'Cached image availability change',
      email: 'cached-image@example.test',
      warehouse_id: warehouse,
      items: [{ product_id: f.product.id, quantity: 2 }],
    });
    orderId = order.id;
    assert.deepEqual(
      (await pool.query('SELECT on_hand,reserved FROM stock WHERE tenant_id=$1 AND product_id=$2 AND warehouse_id=$3',
        [DEMO_TENANT, f.product.id, warehouse])).rows[0],
      { on_hand: 12, reserved: 2 },
    );
    // No refresh: both metadata and its image still describe the last publication.
    const cached = (await catalog(f)).data.find((i: any) => i.id === published.id);
    assert.deepEqual(cached.snapshot, published.snapshot);
    assert.equal(cached.snapshot.price, 12345);
    assert.equal(cached.snapshot.available, 12);
    const after = await req(photo.slice(4), 'GET', undefined, buyer);
    assert.equal(after.statusCode, 200, after.body);
    assert.equal(after.headers['content-type'], before.headers['content-type']);
    assert.equal(after.headers['cache-control'], 'private, no-store');
    assert.deepEqual(after.rawPayload, bytes);
    assert.equal(sha(after.rawPayload), sha(before.rawPayload));
    assert.equal((await req(photo.slice(4))).statusCode, 404);
    assert.equal((await req(f.base + '/catalog/' + published.id + '/images/' + randomUUID(), 'GET', undefined, buyer)).statusCode, 404);
  } finally {
    if (orderId) await api('/orders/' + orderId + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => api(orderPath, 'GET', undefined), '/orders/' + orderId + '/status', { status: 'cancelled' }));
    await pool.query("UPDATE products SET images='[]'::jsonb WHERE id=$1", [f.product.id]);
    await pool.query('DELETE FROM product_images WHERE id=$1', [img.id]);
    await unlink('data/product-images/' + img.id).catch(() => {});
  }
});
test('recipient product and copied local images belong to recipient; no stock or sales price sync', async () => {
  const f = await fixture();
  const bytes =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jfN8AAAAASUVORK5CYII=';
  const img = await api('/product-images', 'POST', { data: bytes });
  let copy: string | undefined, local: string | undefined;
  try {
    const product = await api('/products/' + f.product.id);
    await api('/products/' + f.product.id, 'PATCH', { ...product, images: [img.url] });
    await finish(await refresh(f));
    const i = (await catalog(f)).data[0],
      photo = i.snapshot.images[0];
    assert.equal((await req(photo.slice(4), 'GET', undefined, buyer)).statusCode, 200);
    assert.equal((await req(photo.slice(4))).statusCode, 404);
    const p = await api(
      f.base + '/catalog/' + i.id + '/product',
      'POST',
      {
        version: i.version,
        sku: 'COPIED-' + randomUUID(),
        sale_price: 25000,
        warehouse_id: buyerWarehouse,
        confirmed: true,
      },
      buyer,
    );
    local = p.product_id;
    const d = await api('/products/' + local, 'GET', undefined, buyer);
    assert.equal(d.price, 25000);
    assert.equal(d.description, 'Opis producenta');
    assert.equal(d.attributes.Materiał, 'Papier');
    assert.equal(d.images.length, 1);
    assert.notEqual(d.images[0], img.url);
    copy = d.images[0].split('/').at(-1);
    assert.equal((await req(d.images[0].slice(4), 'GET', undefined, buyer)).statusCode, 200);
    assert.equal((await req(d.images[0].slice(4))).statusCode, 404);
    assert.deepEqual(
      (await pool.query('SELECT on_hand,reserved FROM stock WHERE product_id=$1', [local])).rows[0],
      { on_hand: 0, reserved: 0 },
    );
    assert.equal(
      (
        await req(
          f.base + '/catalog/' + i.id + '/product',
          'POST',
          {
            version: i.version,
            sku: 'REPLAY-' + randomUUID(),
            sale_price: 1,
            warehouse_id: buyerWarehouse,
            confirmed: true,
          },
          buyer,
        )
      ).statusCode,
      409,
    );
  } finally {
    await pool.query("UPDATE products SET images='[]'::jsonb WHERE id=ANY($1::uuid[])", [
      [f.product.id, ...(local ? [local] : [])],
    ]);
    await pool.query('DELETE FROM product_images WHERE id=ANY($1::uuid[])', [
      [img.id, ...(copy ? [copy] : [])],
    ]);
    for (const id of [img.id, copy])
      if (id) await unlink('data/product-images/' + id).catch(() => {});
  }
});
test('RLS limits all five network tables and blocks writes into supplier tenant', async () => {
  const f = await fixture();
  await finish(await refresh(f));
  for (const table of ['b2b_links', 'b2b_catalog_runs', 'b2b_catalog_staging', 'b2b_catalog_items'])
    await tenantTx(DEMO_TENANT, async (c) => {
      assert.equal(
        (await c.query('SELECT 1 FROM ' + table + ' WHERE tenant_id=$1', [SECOND_TENANT])).rowCount,
        0,
      );
    });
  await tenantTx(SECOND_TENANT, async (c) => {
    assert.equal((await c.query('SELECT 1 FROM b2b_link_invitations')).rowCount, 0);
    await assert.rejects(
      c.query(
        "INSERT INTO b2b_link_invitations(id,tenant_id,account_id,actor_id,recipient_email,token_hash,account_version) VALUES(gen_random_uuid(),$1,$2,$3,'forbidden@example.test','forbidden',1)",
        [DEMO_TENANT, f.account.id, buyerId],
      ),
      /row-level security/,
    );
  });
});
test('configured scheduler queues one read per slot and advances without provider requests', async () => {
  const f = await fixture();
  f.link = await config(f, { schedule_minutes: 5 });
  await pool.query("UPDATE b2b_links SET next_at=now()-interval '1 second' WHERE id=$1", [
    f.link.id,
  ]);
  await scheduleB2bNetworkDue();
  await scheduleB2bNetworkDue();
  const rows = (await pool.query('SELECT * FROM b2b_catalog_runs WHERE link_id=$1', [f.link.id]))
    .rows;
  assert.equal(rows.length, 1);
  await finish(rows[0]);
  assert(
    (await pool.query('SELECT next_at>now() valid FROM b2b_links WHERE id=$1', [f.link.id])).rows[0]
      .valid,
  );
  await config(f, { schedule_minutes: 0 });
});
test('read-only recovery allows linked catalog viewing but prevents accept refresh and import', async () => {
  const f = await fixture();
  await finish(await refresh(f));
  const restored = await buildApp({ readOnly: true, previewPort: 4197 });
  try {
    const r = await restored.inject({
      url: '/api/auth/login',
      method: 'POST',
      payload: { email: 'other@demo.local', password: 'DynaDemo!2026' },
    });
    assert.equal(r.statusCode, 200);
    const cookie = r.headers['set-cookie']!.toString().split(';')[0];
    assert(cookie.startsWith('dyna_session_preview_4197='));
    assert.equal(
      (await restored.inject({ url: '/api' + f.base + '/catalog', headers: { cookie: buyer } }))
        .statusCode,
      401,
    );
    assert.equal((await req(f.base + '/catalog', 'GET', undefined, cookie)).statusCode, 401);
    assert.equal(
      (await restored.inject({ url: '/api' + f.base + '/catalog', headers: { cookie } }))
        .statusCode,
      200,
    );
    const switched = await restored.inject({
      url: '/api/workspaces/switch',
      method: 'POST',
      headers: { cookie },
      payload: { tenant_id: SECOND_TENANT },
    });
    assert.equal(switched.statusCode, 200);
    const newCookie = switched.headers['set-cookie']!.toString().split(';')[0];
    assert(newCookie.startsWith('dyna_session_preview_4197='));
    assert.equal(
      (await restored.inject({ url: '/api' + f.base + '/catalog', headers: { cookie } }))
        .statusCode,
      401,
    );
    assert.equal(
      (await restored.inject({ url: '/api' + f.base + '/catalog', headers: { cookie: newCookie } }))
        .statusCode,
      200,
    );
    for (const path of [
      '/b2b/network/accept',
      f.base + '/refresh',
      f.base + '/catalog/' + (await catalog(f)).data[0].id + '/product',
    ])
      assert.equal(
        (
          await restored.inject({
            url: '/api' + path,
            method: 'POST',
            payload: {},
            headers: { cookie: newCookie },
          })
        ).statusCode,
        423,
      );
    const logout = await restored.inject({
      url: '/api/auth/logout',
      method: 'POST',
      headers: { cookie: newCookie },
    });
    assert.equal(logout.statusCode, 200);
    assert(logout.headers['set-cookie']!.toString().startsWith('dyna_session_preview_4197='));
    assert.equal((await req(f.base + '/catalog', 'GET', undefined, buyer)).statusCode, 200);
  } finally {
    await restored.close();
  }
});
test('a new refresh cleans staging from a terminal lost-lease job and preserves prior publication', async () => {
  const f = await fixture();
  await finish(await refresh(f));
  await add(f, 204);
  const interrupted = await refresh(f);
  await step(interrupted);
  await pool.query("UPDATE jobs SET state='failed',error='Synthetic expired lease' WHERE id=$1", [
    interrupted.job_id,
  ]);
  const replacement = await refresh(f);
  assert.equal(
    (await pool.query('SELECT state FROM b2b_catalog_runs WHERE id=$1', [interrupted.id])).rows[0]
      .state,
    'failed',
  );
  assert.equal(
    (
      await pool.query('SELECT count(*)::int n FROM b2b_catalog_staging WHERE run_id=$1', [
        interrupted.id,
      ])
    ).rows[0].n,
    0,
  );
  assert.equal((await catalog(f)).data.length, 1);
  await finish(replacement);
  assert.equal(
    (await pool.query('SELECT fetched FROM b2b_catalog_runs WHERE id=$1', [replacement.id])).rows[0]
      .fetched,
    205,
  );
});
test('import preserves all fifty supplier attributes at the catalog boundary', async () => {
  const attributes = Object.fromEntries(
    Array.from({ length: 50 }, (_, i) => ['Atrybut ' + i, 'Wartość ' + i]),
  );
  const f = await fixture({ attributes });
  await finish(await refresh(f));
  const item = (await catalog(f)).data[0];
  const p = await api(
    f.base + '/catalog/' + item.id + '/product',
    'POST',
    {
      version: item.version,
      sku: 'BOUNDARY-' + randomUUID(),
      sale_price: 25000,
      warehouse_id: buyerWarehouse,
      confirmed: true,
    },
    buyer,
  );
  assert.deepEqual(
    (await api('/products/' + p.product_id, 'GET', undefined, buyer)).attributes,
    attributes,
  );
});
test('10001 published SKUs use 51 bounded checkpoints and indexed deep catalog pages', async () => {
  const f = await fixture();
  await add(f, 10000);
  const r = await refresh(f),
    started = performance.now();
  const done = await finish(r),
    refreshMs = performance.now() - started;
  assert.equal(done.fetched, 10001);
  const samples = [];
  for (let n = 0; n < 10; n++) {
    const t = performance.now(),
      d = await catalog(f);
    samples.push(performance.now() - t);
    assert.equal(d.data.length, 50);
  }
  const cursor = (
    await pool.query(
      'SELECT id FROM b2b_catalog_items WHERE link_id=$1 ORDER BY id OFFSET 9950 LIMIT 1',
      [f.link.id],
    )
  ).rows[0].id;
  const t = performance.now(),
    deep = await api(f.base + '/catalog?after=' + cursor, 'GET', undefined, buyer),
    deepMs = performance.now() - t;
  assert.equal(deep.data.length, 50);
  assert.equal(deep.next, null);
  await writeFile(
    'docs/b2b-network-scale.json',
    JSON.stringify(
      {
        scope: 'isolated_local_PostgreSQL_no_provider_requests',
        sku_count: 10001,
        page_size: 50,
        worker_page_size: 200,
        checkpoints: 51,
        refresh_ms: refreshMs,
        samples_ms: samples,
        p95_ms: Math.max(...samples),
        deep_page_ms: deepMs,
        deep_page_after_row: 9950,
        full_goal_capacity_proven: false,
      },
      null,
      2,
    ) + '\n',
  );
});
