import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pool, migrate, tenantTx } from '../server/db';
import { buildApp } from '../server/app';
import { seed, DEMO_TENANT } from './fixtures';
import { encrypt, decrypt } from '../server/security';
import { processIntegrationJob } from '../server/sync';
import { channelRead } from '../server/channel-access';
import { Ebay } from '../server/ebay';
import { ebayFixture, ebaySecrets } from './ebay-fixture';
assert.equal(process.env.DYNA_TEST, 'true');
let app: Awaited<ReturnType<typeof buildApp>>,
  cookie: string,
  other: string,
  viewer: string,
  warehouse: string,
  user: string,
  f = ebayFixture();
const req = (p: string, method: any = 'GET', payload?: any, auth = cookie) =>
  app.inject({ url: '/api' + p, method, payload, headers: { cookie: auth } });
before(async () => {
  await migrate();
  await seed();
  app = await buildApp({ integrationTransport: (u, i) => f.transport(u, i) });
  const login = async (email: string) =>
    (
      await app.inject({
        url: '/api/auth/login',
        method: 'POST',
        payload: { email, password: 'DynaDemo!2026' },
      })
    ).headers['set-cookie']!.toString().split(';')[0];
  cookie = await login('admin@demo.local');
  other = await login('other@demo.local');
  viewer = await login('viewer@demo.local');
  warehouse = (await req('/warehouses')).json().data[0].id;
  user = (await pool.query("SELECT id FROM users WHERE email='admin@demo.local'")).rows[0].id;
});
after(async () => {
  await app.close();
  await pool.end();
});
beforeEach(async () => {
  f = ebayFixture();
  await pool.query("UPDATE jobs SET state='done',lease_token=NULL,locked_at=NULL");
  await pool.query("UPDATE memberships SET role='admin' WHERE tenant_id=$1 AND user_id=$2", [
    DEMO_TENANT,
    user,
  ]);
});
afterEach(async () => {
  await pool.query("UPDATE memberships SET role='admin' WHERE tenant_id=$1 AND user_id=$2", [
    DEMO_TENANT,
    user,
  ]);
});
async function fixture(stock = 100) {
  const p = await req('/products', 'POST', {
    name: 'Local eBay product',
    sku: 'EB-' + randomUUID().slice(0, 8),
    warehouse_id: warehouse,
    quantity: stock,
    price: 9999,
    vat: 23,
  });
  assert.equal(p.statusCode, 201, p.body);
  const c = await req('/integrations', 'POST', {
    provider: 'ebay',
    name: 'eBay test',
    mode: 'sandbox',
    credentials: ebaySecrets,
    settings: { simulation: 'true' },
  });
  assert.equal(c.statusCode, 200, c.body);
  const ch = c.json().id;
  const link = await req(`/integrations/${ch}/mappings`, 'POST', {
    external_id: 'EBAY-DEMO-SKU',
    sku: p.json().sku,
  });
  assert.equal(link.statusCode, 200, link.body);
  return { ch, product: p.json().id };
}
async function pull(ch: string, cursor?: string) {
  const r = await req(`/integrations/${ch}/fetch-orders`, 'POST', {
    page: 1,
    ...(cursor ? { cursor } : {}),
  });
  assert.equal(r.statusCode, 200, r.body);
  return r.json();
}
async function rows(ch: string) {
  const r = await req(`/integrations/${ch}/imports`);
  assert.equal(r.statusCode, 200, r.body);
  return r.json().data;
}
async function commit(ch: string, record?: any) {
  const r = record ?? (await rows(ch))[0];
  return req(`/imports/${r.id}/commit`, 'POST', {
    warehouse_id: warehouse,
    expected_hash: r.source_hash,
  });
}
async function runSync(id: string) {
  const j = (
    await pool.query(
      "UPDATE jobs SET state='running',attempts=attempts+1,locked_at=now(),lease_token=$2 WHERE id=$1 RETURNING *",
      [id, randomUUID()],
    )
  ).rows[0];
  await processIntegrationJob(j, { transport: (u, i) => f.transport(u, i) });
  return (await pool.query('SELECT * FROM jobs WHERE id=$1', [id])).rows[0];
}
test('eBay native API contract: encrypted OAuth → stage → exact totals → single payment and atomic reservation, replay', async () => {
  const x = await fixture();
  await pull(x.ch);
  const r = await commit(x.ch);
  assert.equal(r.statusCode, 200, r.body);
  const o = r.json();
  assert.equal(o.source, 'ebay');
  assert.equal(o.total, 10001);
  assert.equal(o.shipping_cost, 1000);
  assert.equal(o.items[0].line_total, 9001);
  assert.equal(o.status, 'paid');
  assert.equal(o.source_snapshot.ebay.field_groups, 'TAX_BREAKDOWN');
  assert.equal(
    (await pool.query('SELECT reserved FROM stock WHERE product_id=$1', [x.product])).rows[0]
      .reserved,
    2,
  );
  const again = await commit(x.ch);
  assert.equal(again.statusCode, 200, again.body);
  assert.equal(again.json().id, o.id);
  assert.deepEqual(
    (await pool.query('SELECT amount FROM payment_entries WHERE order_id=$1', [o.id])).rows,
    [{ amount: 10001 }],
  );
  const ch = (await pool.query('SELECT * FROM channels WHERE id=$1', [x.ch])).rows[0];
  assert(!JSON.stringify(ch.credentials).includes('DEMO'));
  assert.equal(decrypt(ch.credentials).refresh_token, 'DEMO-refresh');
  assert.equal(f.state.token, 1);
  assert.equal(ch.settings.simulation, undefined);
  const list = await req('/integrations');
  assert(!list.body.includes('DEMO-secret'));
  assert(!list.body.includes('DEMO-access'));
});
test('eBay re-read changes preview and denies obsolete approval before reserving any stock', async () => {
  const x = await fixture();
  await pull(x.ch);
  const old = (await rows(x.ch))[0];
  f.orders[0].cancelStatus.cancelState = 'CANCEL_REQUESTED';
  const r = await commit(x.ch, old);
  assert.equal(r.statusCode, 409, r.body);
  const next = (await rows(x.ch))[0];
  assert.notEqual(next.source_hash, old.source_hash);
  assert(next.issues.length);
  assert.equal((await commit(x.ch, old)).statusCode, 409);
  assert.equal((await commit(x.ch, next)).statusCode, 422);
  assert.equal(
    (await pool.query('SELECT reserved FROM stock WHERE product_id=$1', [x.product])).rows[0]
      .reserved,
    0,
  );
});
test('eBay insufficient stock rolls back order and source payment, and already imported data is preserved', async () => {
  const x = await fixture(1);
  await pull(x.ch);
  const before = (
    await pool.query('SELECT count(*)::int n FROM orders WHERE tenant_id=$1', [DEMO_TENANT])
  ).rows[0].n;
  const r = await commit(x.ch);
  assert.equal(r.statusCode, 409, r.body);
  assert.equal(
    (await pool.query('SELECT count(*)::int n FROM orders WHERE tenant_id=$1', [DEMO_TENANT]))
      .rows[0].n,
    before,
  );
  const y = await fixture();
  await pull(y.ch);
  const made = await commit(y.ch);
  assert.equal(made.statusCode, 200, made.body);
  f.orders[0].lineItems[0].total.value = '110.01';
  f.orders[0].pricingSummary.total.value = '110.01';
  f.orders[0].paymentSummary.payments[0].amount.value = '110.01';
  await pull(y.ch);
  assert.equal((await commit(y.ch)).statusCode, 409);
  assert.equal((await req(`/orders/${made.json().id}`)).json().total, 10001);
});
test('eBay tenant/role boundaries and missing preview hash cannot access another import', async () => {
  const x = await fixture();
  await pull(x.ch);
  const r = (await rows(x.ch))[0];
  assert.equal(
    (await req(`/imports/${r.id}/commit`, 'POST', { warehouse_id: warehouse })).statusCode,
    422,
  );
  assert.equal(
    (await req(`/integrations/${x.ch}/imports`, 'GET', undefined, other)).statusCode,
    404,
  );
  assert.equal(
    (
      await req(
        `/imports/${r.id}/commit`,
        'POST',
        { warehouse_id: warehouse, expected_hash: r.source_hash },
        other,
      )
    ).statusCode,
    404,
  );
  assert.equal(
    (await req(`/integrations/${x.ch}/fetch-orders`, 'POST', {}, viewer)).statusCode,
    403,
  );
});
test('eBay losing admin rights during provider response prevents staging and token commit', async () => {
  for (const phase of ['oauth', 'read']) {
    await pool.query("UPDATE memberships SET role='admin' WHERE tenant_id=$1 AND user_id=$2", [
      DEMO_TENANT,
      user,
    ]);
    const x = await fixture();
    f.state.hook = async (u) => {
      if (phase === 'oauth' ? u.pathname.includes('oauth2') : u.pathname.endsWith('/order'))
        await pool.query("UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2", [
          DEMO_TENANT,
          user,
        ]);
    };
    const r = await req(`/integrations/${x.ch}/fetch-orders`, 'POST', {});
    assert.equal(r.statusCode, 403, r.body);
    assert.equal(
      (await pool.query('SELECT count(*)::int n FROM inbound_orders WHERE channel_id=$1', [x.ch]))
        .rows[0].n,
      0,
    );
    if (phase === 'oauth')
      assert(
        !decrypt(
          (await pool.query('SELECT credentials FROM channels WHERE id=$1', [x.ch])).rows[0]
            .credentials,
        ).access_token,
      );
    f.state.hook = undefined;
  }
});
test('eBay concurrent refresh uses one token, retains refresh credential and safely replays only a read on 401', async () => {
  const x = await fixture();
  const read = () =>
    channelRead(DEMO_TENANT, x.ch, (c) => (c as Ebay).orders(), { transport: f.transport });
  await Promise.all([read(), read()]);
  assert.equal(f.state.token, 1);
  let rejected = false;
  await channelRead(DEMO_TENANT, x.ch, (c) => (c as Ebay).orders(), {
    transport: async (u, i) => {
      if (!u.includes('oauth2') && !rejected) {
        rejected = true;
        return new Response('secret', { status: 401 });
      }
      return f.transport(u, i);
    },
  });
  assert.equal(f.state.token, 2);
});
test('eBay sync paginates checkpointed window, retries same page after failure and commits watermark only at end', async () => {
  f = ebayFixture(51);
  const x = await fixture();
  const queued = await req(`/integrations/${x.ch}/sync`, 'POST', {});
  assert.equal(queued.statusCode, 200, queued.body);
  const id = queued.json().id,
    initial = (await pool.query('SELECT payload FROM jobs WHERE id=$1', [id])).rows[0].payload;
  const first = await runSync(id);
  assert.equal(first.state, 'pending');
  assert.equal(first.payload.ebay_window.offset, 50);
  assert.equal(first.payload.ebay_window.to, initial.ebay_window.to);
  assert.equal(
    (await pool.query('SELECT event_cursor FROM channels WHERE id=$1', [x.ch])).rows[0]
      .event_cursor,
    null,
  );
  f.state.edit = (v) => {
    if (v.orders) v.warnings = [{ message: 'private' }];
  };
  await assert.rejects(() => runSync(id), /ostrzeżenie/);
  assert.equal(
    (await pool.query('SELECT payload FROM jobs WHERE id=$1', [id])).rows[0].payload.ebay_window
      .offset,
    50,
  );
  f.state.edit = undefined;
  const last = await runSync(id);
  assert.equal(last.state, 'done');
  const ch = (await pool.query('SELECT * FROM channels WHERE id=$1', [x.ch])).rows[0];
  assert.equal(ch.event_cursor, initial.ebay_window.to);
  assert.equal(ch.bootstrap_done, true);
  assert.equal(
    (await pool.query('SELECT count(*)::int n FROM inbound_orders WHERE channel_id=$1', [x.ch]))
      .rows[0].n,
    51,
  );
  assert.equal(
    (await pool.query('SELECT reserved FROM stock WHERE product_id=$1', [x.product])).rows[0]
      .reserved,
    0,
  );
  const next = await req(`/integrations/${x.ch}/sync`, 'POST', {});
  const payload = (await pool.query('SELECT payload FROM jobs WHERE id=$1', [next.json().id]))
    .rows[0].payload;
  assert.equal(Date.parse(payload.ebay_window.from), Date.parse(ch.event_cursor) - 600000);
});
test('eBay worker pause, changed credentials and lost lease fence writes after response', async () => {
  for (const mutation of ['pause', 'credentials', 'lease']) {
    f = ebayFixture();
    const x = await fixture();
    assert.equal(
      (await req(`/integrations/${x.ch}/sync`, 'PATCH', { enabled: true, interval: 300 }))
        .statusCode,
      200,
    );
    const id = (await req(`/integrations/${x.ch}/sync`, 'POST', {})).json().id;
    f.state.hook = async (u) => {
      if (!u.pathname.endsWith('/order')) return;
      if (mutation === 'pause')
        await pool.query('UPDATE channels SET sync_enabled=false WHERE id=$1', [x.ch]);
      if (mutation === 'credentials')
        await pool.query('UPDATE channels SET credentials=$1 WHERE id=$2', [
          encrypt({ ...ebaySecrets, client_secret: 'changed' }),
          x.ch,
        ]);
      if (mutation === 'lease')
        await pool.query('UPDATE jobs SET lease_token=$1 WHERE id=$2', [randomUUID(), id]);
    };
    const result = await runSync(id);
    assert(result.state === 'done' || mutation === 'lease');
    assert.equal(
      (await pool.query('SELECT count(*)::int n FROM inbound_orders WHERE channel_id=$1', [x.ch]))
        .rows[0].n,
      0,
    );
    assert.equal(
      (await pool.query('SELECT event_cursor FROM channels WHERE id=$1', [x.ch])).rows[0]
        .event_cursor,
      null,
    );
  }
});
test('eBay local example supports complete import without HTTP and cannot enable external scheduler', async () => {
  const c = await req('/integrations/ebay-example', 'POST', {});
  assert.equal(c.statusCode, 200, c.body);
  const ch = c.json().channel_id;
  const p = await req('/products', 'POST', {
    name: 'eBay demo product',
    sku: 'EBD-' + randomUUID().slice(0, 8),
    price: 50000,
    vat: 23,
    warehouse_id: warehouse,
    quantity: 12,
  });
  await req(`/integrations/${ch}/mappings`, 'POST', {
    external_id: 'EBAY-DEMO-SKU',
    sku: p.json().sku,
  });
  const r = await commit(ch);
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().total, 10001);
  assert.equal(f.calls.length, 0);
  assert.equal(
    (await req(`/integrations/${ch}/sync`, 'PATCH', { enabled: true, interval: 300 })).statusCode,
    422,
  );
});
test('eBay different currency cannot be silently priced as local PLN and pending payment reserves without recording receipt', async () => {
  const x = await fixture();
  const convert = (v: any): void => {
    if (!v || typeof v !== 'object') return;
    if (v.currency === 'PLN') v.currency = 'EUR';
    for (const value of Object.values(v)) convert(value);
  };
  convert(f.orders[0]);
  await pull(x.ch);
  const foreign = await commit(x.ch);
  assert.equal(foreign.statusCode, 422, foreign.body);
  assert.equal(
    (await pool.query('SELECT reserved FROM stock WHERE product_id=$1', [x.product])).rows[0]
      .reserved,
    0,
  );
  f = ebayFixture();
  f.orders[0].orderPaymentStatus = 'PENDING';
  f.orders[0].paymentSummary.payments = [];
  const y = await fixture();
  await pull(y.ch);
  const pending = await commit(y.ch);
  assert.equal(pending.statusCode, 200, pending.body);
  assert.equal(pending.json().status, 'new');
  assert.equal(
    (
      await pool.query('SELECT count(*)::int n FROM payment_entries WHERE order_id=$1', [
        pending.json().id,
      ])
    ).rows[0].n,
    0,
  );
});
test('eBay protected test and preview use current membership and cannot expose credentials on refresh failure', async () => {
  const x = await fixture();
  const p = await req(`/integrations/${x.ch}/preview?resource=orders`);
  assert.equal(p.statusCode, 200, p.body);
  assert.equal(p.json().data.length, 1);
  assert.equal((await req(`/integrations/${x.ch}/preview?resource=products`)).statusCode, 422);
  await pool.query('UPDATE channels SET token_expires_at=now() WHERE id=$1', [x.ch]);
  f.state.hook = async (u) => {
    if (u.pathname.includes('oauth2'))
      await pool.query("UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2", [
        DEMO_TENANT,
        user,
      ]);
  };
  const failed = await req(`/integrations/${x.ch}/test`, 'POST', {});
  assert.equal(failed.statusCode, 403, failed.body);
  assert(!failed.body.includes('DEMO-secret'));
  const creds = decrypt(
    (await pool.query('SELECT credentials FROM channels WHERE id=$1', [x.ch])).rows[0].credentials,
  );
  assert.equal(creds.access_token, 'DEMO-access-1');
});
