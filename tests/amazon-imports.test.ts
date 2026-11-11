import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pool, migrate, tenantTx } from '../server/db';
import { buildApp } from '../server/app';
import { seed, DEMO_TENANT } from './fixtures';
import { amazonFixture, amazonSecrets, amazonConfig } from './amazon-fixture';
import { processIntegrationJob } from '../server/sync';
import { deferAmazonApiJob, AmazonApiWait, amazonApiTransport } from '../server/amazon-api-limits';
import { encrypt, decrypt } from '../server/security';
assert.equal(process.env.DYNA_TEST, 'true');
let app: Awaited<ReturnType<typeof buildApp>>,
  cookie: string,
  other: string,
  viewer: string,
  warehouse: string,
  user: string,
  f = amazonFixture();
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
  f = amazonFixture();
  await pool.query('DELETE FROM amazon_api_buckets');
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
    name: 'Amazon local QA',
    sku: 'AMZ-' + randomUUID().slice(0, 8),
    warehouse_id: warehouse,
    quantity: stock,
    price: 9999,
    vat: 23,
  });
  assert.equal(p.statusCode, 201, p.body);
  const c = await req('/integrations', 'POST', {
    provider: 'amazon',
    name: 'Amazon contract test',
    mode: 'sandbox',
    credentials: { ...amazonSecrets, access_token: 'ignored' },
    settings: { ...amazonConfig, simulation: 'true' },
  });
  assert.equal(c.statusCode, 200, c.body);
  const ch = c.json().id;
  const m = await req(`/integrations/${ch}/mappings`, 'POST', {
    external_id: 'AMAZON-DEMO-SKU',
    sku: p.json().sku,
  });
  assert.equal(m.statusCode, 200, m.body);
  return { ch, product: p.json().id };
}
async function pull(ch: string, cursor?: string, page = 1) {
  const r = await req(`/integrations/${ch}/fetch-orders`, 'POST', {
    page,
    ...(cursor ? { cursor } : {}),
  });
  assert.equal(r.statusCode, 200, r.body);
  return r.json();
}
async function rows(ch: string) {
  return (await req(`/integrations/${ch}/imports`)).json().data;
}
async function commit(ch: string, row?: any) {
  const r = row ?? (await rows(ch))[0];
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
test('Amazon LWA → stage → exact totals → real reservation; no synthetic email or payment, idempotent replay', async () => {
  const x = await fixture();
  await pull(x.ch);
  const r = await commit(x.ch);
  assert.equal(r.statusCode, 200, r.body);
  const o = r.json();
  assert.equal(o.source, 'amazon');
  assert.equal(o.total, 24690);
  assert.equal(o.shipping_cost, 90);
  assert.equal(o.email, '');
  assert.equal(o.status, 'new');
  const count = Number(
    (await pool.query('SELECT count(*) FROM payment_entries WHERE order_id=$1', [o.id])).rows[0]
      .count,
  );
  assert.equal(count, 0);
  const stock = (await pool.query('SELECT * FROM stock WHERE product_id=$1', [x.product])).rows[0];
  assert.equal(stock.reserved, 2);
  const before = f.calls.length;
  assert.equal((await commit(x.ch)).json().id, o.id);
  assert.equal(f.calls.length, before);
  assert.equal(
    (await pool.query('SELECT reserved FROM stock WHERE product_id=$1', [x.product])).rows[0]
      .reserved,
    2,
  );
  const ch = (await pool.query('SELECT * FROM channels WHERE id=$1', [x.ch])).rows[0];
  assert.deepEqual(decrypt(ch.credentials), amazonSecrets);
  assert(!JSON.stringify(ch).includes('DEMO-amazon-refresh'));
  assert.equal(ch.settings.simulation, undefined);
  assert(!JSON.stringify((await req('/integrations')).json()).includes('DEMO-amazon-secret'));
});
test('Amazon source reread fences price and cancellation changes before commit, then requires new preview hash', async () => {
  const x = await fixture();
  await pull(x.ch);
  const row = (await rows(x.ch))[0];
  f.orders[0].fulfillment.fulfillmentStatus = 'CANCELLED';
  const r = await commit(x.ch, row);
  assert.equal(r.statusCode, 409, r.body);
  const changed = (await rows(x.ch))[0];
  assert.notEqual(changed.source_hash, row.source_hash);
  assert.equal((await commit(x.ch, row)).statusCode, 409);
  assert.equal((await commit(x.ch, changed)).statusCode, 422);
  assert.equal(
    (await pool.query('SELECT reserved FROM stock WHERE product_id=$1', [x.product])).rows[0]
      .reserved,
    0,
  );
});
test('Amazon tenant isolation, viewer denial and required preview hash prevent unauthorized import', async () => {
  const x = await fixture();
  await pull(x.ch);
  const row = (await rows(x.ch))[0];
  assert.equal(
    (await req(`/integrations/${x.ch}/imports`, 'GET', undefined, other)).statusCode,
    404,
  );
  assert.equal(
    (await req(`/integrations/${x.ch}/fetch-orders`, 'POST', {}, viewer)).statusCode,
    403,
  );
  assert.equal(
    (await req(`/imports/${row.id}/commit`, 'POST', { warehouse_id: warehouse })).statusCode,
    422,
  );
  assert.equal(
    (
      await req(
        `/imports/${row.id}/commit`,
        'POST',
        { warehouse_id: warehouse, expected_hash: row.source_hash },
        other,
      )
    ).statusCode,
    404,
  );
});
test('Amazon concurrent imports are atomic and reserve once; insufficient stock rolls back', async () => {
  const x = await fixture();
  await pull(x.ch);
  const row = (await rows(x.ch))[0];
  const rs = await Promise.all([commit(x.ch, row), commit(x.ch, row)]);
  rs.forEach((r) => assert.equal(r.statusCode, 200, r.body));
  assert.equal(rs[0].json().id, rs[1].json().id);
  assert.equal(
    (await pool.query('SELECT reserved FROM stock WHERE product_id=$1', [x.product])).rows[0]
      .reserved,
    2,
  );
  const y = await fixture(1);
  await pull(y.ch);
  const r = await commit(y.ch);
  assert.equal(r.statusCode, 409, r.body);
  assert.equal(
    (await pool.query('SELECT reserved FROM stock WHERE product_id=$1', [y.product])).rows[0]
      .reserved,
    0,
  );
});
test('Amazon source mutation during HTTP and revoked admin are rejected after provider response', async () => {
  const x = await fixture();
  f.state.hook = async (u) => {
    if (u.pathname.endsWith('/orders'))
      await pool.query("UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2", [
        DEMO_TENANT,
        user,
      ]);
  };
  const r = await req(`/integrations/${x.ch}/fetch-orders`, 'POST', {});
  assert.equal(r.statusCode, 403, r.body);
  assert.equal(
    (await pool.query('SELECT count(*) FROM inbound_orders WHERE channel_id=$1', [x.ch])).rows[0]
      .count,
    '0',
  );
});
test('Amazon worker checkpoint advances only at full window and resumes identical query after page restart', async () => {
  const x = await fixture();
  f = amazonFixture(51);
  const r = await req(`/integrations/${x.ch}/sync`, 'POST', {});
  assert.equal(r.statusCode, 200, r.body);
  const j1 = await runSync(r.json().id);
  assert.equal(j1.state, 'pending');
  assert.equal(j1.payload.amazon_window.token, '50');
  assert.equal(
    (await pool.query('SELECT bootstrap_done FROM channels WHERE id=$1', [x.ch])).rows[0]
      .bootstrap_done,
    false,
  );
  const j2 = await runSync(j1.id);
  assert.equal(j2.state, 'done');
  const ch = (await pool.query('SELECT * FROM channels WHERE id=$1', [x.ch])).rows[0];
  assert.equal(ch.event_cursor, j1.payload.amazon_window.to);
  assert.equal(ch.bootstrap_done, true);
  assert.equal(
    (await pool.query('SELECT count(*) FROM inbound_orders WHERE channel_id=$1', [x.ch])).rows[0]
      .count,
    '51',
  );
  const calls = f.calls.filter((c) => c.url.includes('/orders?')).map((c) => new URL(c.url));
  assert.equal(
    calls[0].searchParams.get('lastUpdatedAfter'),
    calls[1].searchParams.get('lastUpdatedAfter'),
  );
  assert.equal(
    calls[0].searchParams.get('lastUpdatedBefore'),
    calls[1].searchParams.get('lastUpdatedBefore'),
  );
});
test('Amazon worker configuration change and lost lease stop HTTP and staging', async () => {
  const x = await fixture();
  const id = (await req(`/integrations/${x.ch}/sync`, 'POST', {})).json().id;
  await pool.query("UPDATE channels SET name=name||' changed',credentials=$2 WHERE id=$1", [
    x.ch,
    encrypt({ ...amazonSecrets, refresh_token: 'DEMO-new-grant' }),
  ]);
  assert.equal((await runSync(id)).state, 'done');
  assert.equal(f.calls.length, 0);
});
test('Amazon 429 cooldown shared across channels, survives connector reload and defers job without burning attempts', async () => {
  const x = await fixture();
  f.state.fail429 = true;
  const id = (await req(`/integrations/${x.ch}/sync`, 'POST', {})).json().id;
  const j = (
    await pool.query(
      "UPDATE jobs SET state='running',attempts=1,lease_token=$2 WHERE id=$1 RETURNING *",
      [id, randomUUID()],
    )
  ).rows[0];
  let e: unknown;
  try {
    await processIntegrationJob(j, { transport: f.transport });
  } catch (err) {
    e = err;
  }
  assert(e instanceof AmazonApiWait);
  assert.equal(await deferAmazonApiJob(j, e), true);
  const deferred = (await pool.query('SELECT * FROM jobs WHERE id=$1', [id])).rows[0];
  assert.equal(deferred.state, 'pending');
  assert.equal(deferred.attempts, 0);
  assert.match(deferred.provider_wait_reason, /amazon.search.cooldown/);
  const calls = f.calls.length;
  const y = await fixture();
  const r = await req(`/integrations/${y.ch}/fetch-orders`, 'POST', {});
  assert.equal(r.statusCode, 429, r.body);
  assert.equal(f.calls.filter((c) => c.url.includes('/orders?')).length, 1);
  assert.equal(f.calls.length, calls + 1);
  assert.equal(
    (await pool.query('SELECT count(*) FROM inbound_orders WHERE channel_id=$1', [x.ch])).rows[0]
      .count,
    '0',
  );
});
test('Amazon budget atomically admits 20 search requests, never follows arbitrary endpoints; service-only table inaccessible to tenant SQL', async () => {
  let calls = 0;
  const transport = amazonApiTransport('sandbox', 'eu', amazonSecrets.client_id, async () => {
    calls++;
    return new Response('{}');
  });
  const url = 'https://sandbox.sellingpartnerapi-eu.amazon.com/orders/2026-01-01/orders';
  const results = await Promise.allSettled(
    Array.from({ length: 21 }, () => transport(url, { method: 'GET' })),
  );
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 20);
  assert.equal(calls, 20);
  await assert.rejects(
    transport('https://attacker.test/orders/2026-01-01/orders', { method: 'GET' }),
  );
  await assert.rejects(
    tenantTx(DEMO_TENANT, (c) => c.query('SELECT * FROM amazon_api_buckets')),
    /permission denied/,
  );
});
test('Amazon manual payload is reread before real import; no provider forgery bypass, local example explicitly synthetic', async () => {
  const x = await fixture();
  const fake = structuredClone(f.orders[0]);
  fake.recipient.deliveryAddress.name = 'Forged buyer';
  const staged = await req(`/integrations/${x.ch}/stage-orders`, 'POST', { data: [fake] });
  assert.equal(staged.statusCode, 200, staged.body);
  assert.equal((await commit(x.ch)).statusCode, 409);
  assert.equal(
    (await pool.query('SELECT reserved FROM stock WHERE product_id=$1', [x.product])).rows[0]
      .reserved,
    0,
  );
  const ex = await req('/integrations/amazon-example', 'POST', {});
  assert.equal(ex.statusCode, 200, ex.body);
  assert.equal(ex.json().scope, 'local_simulation');
  assert.equal(
    (await req(`/integrations/${ex.json().channel_id}/sync`, 'POST', {})).statusCode,
    422,
  );
});
test('Amazon losing the job lease during read discards that response and leaves watermark unchanged', async () => {
  const x = await fixture(),
    id = (await req(`/integrations/${x.ch}/sync`, 'POST', {})).json().id;
  f.state.hook = async (u) => {
    if (u.pathname.endsWith('/orders'))
      await pool.query(
        "UPDATE jobs SET state='pending',lease_token=NULL,locked_at=NULL WHERE id=$1",
        [id],
      );
  };
  const job = await runSync(id);
  assert.equal(job.state, 'pending');
  assert.equal(
    (await pool.query('SELECT count(*) FROM inbound_orders WHERE channel_id=$1', [x.ch])).rows[0]
      .count,
    '0',
  );
  assert.equal(
    (await pool.query('SELECT bootstrap_done FROM channels WHERE id=$1', [x.ch])).rows[0]
      .bootstrap_done,
    false,
  );
});
test('Amazon configuration changes after OAuth stop Orders HTTP before sending old grant token', async () => {
  const x = await fixture();
  f.state.hook = async (u) => {
    if (u.pathname === '/auth/o2/token')
      await pool.query('UPDATE channels SET settings=$2 WHERE id=$1', [
        x.ch,
        JSON.stringify({ ...amazonConfig, marketplace_id: 'A1PA6795UKMFR9' }),
      ]);
  };
  const r = await req(`/integrations/${x.ch}/fetch-orders`, 'POST', {});
  assert.equal(r.statusCode, 409, r.body);
  assert.equal(f.calls.length, 1);
  assert.equal(
    (await pool.query('SELECT count(*) FROM inbound_orders WHERE channel_id=$1', [x.ch])).rows[0]
      .count,
    '0',
  );
});
