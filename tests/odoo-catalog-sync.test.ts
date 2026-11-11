import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pool, migrate, tenantTx } from '../server/db';
import { buildApp } from '../server/app';
import { seed, DEMO_TENANT } from './fixtures';
import { encrypt } from '../server/security';
import { Odoo } from '../server/odoo';
import {
  processOdooCatalogSync,
  failOdooCatalogSync,
  scheduleOdooCatalogDue,
} from '../server/odoo-catalog-sync';
import { odooFixture, odooSettings, odooCredentials } from './odoo-fixtures';
assert.equal(process.env.DYNA_TEST, 'true');
let app: Awaited<ReturnType<typeof buildApp>>,
  cookie: string,
  other: string,
  viewer: string,
  warehouse: string,
  f = odooFixture();
const req = (p: string, method: any = 'GET', payload?: any, auth = cookie) =>
  app.inject({ url: '/api' + p, method, payload, headers: { cookie: auth } });
const ok = async (p: string, method: any = 'GET', payload?: any) => {
  const r = await req(p, method, payload);
  assert(r.statusCode < 300, r.body);
  return r.json();
};
before(async () => {
  await migrate();
  await seed();
  app = await buildApp({ integrationTransport: (u, i) => f.transport(u, i) });
  const login = async (email: string) =>
    String(
      (await req('/auth/login', 'POST', { email, password: 'DynaDemo!2026' }, '')).headers[
        'set-cookie'
      ],
    ).split(';')[0];
  cookie = await login('admin@demo.local');
  other = await login('other@demo.local');
  viewer = await login('viewer@demo.local');
  cookie = String(
    (await req('/workspaces/switch', 'POST', { tenant_id: DEMO_TENANT })).headers['set-cookie'],
  ).split(';')[0];
  warehouse = (await ok('/warehouses')).data[0].id;
});
after(async () => {
  await app.close();
  await pool.end();
});
beforeEach(async () => {
  f = odooFixture();
  await pool.query('UPDATE odoo_catalog_schedules SET enabled=false,next_at=NULL');
});
async function fixture(count = 2, simulation = false) {
  f = odooFixture(count);
  const ch = randomUUID();
  await tenantTx(DEMO_TENANT, (c) =>
    c.query(
      "INSERT INTO channels(id,tenant_id,provider,name,mode,credentials,settings) VALUES($1,$2,'odoo','ERP Sync QA','sandbox',$3,$4)",
      [
        ch,
        DEMO_TENANT,
        encrypt(odooCredentials),
        JSON.stringify(
          simulation
            ? {
                simulation: true,
                company_id: '1',
                warehouse_id: '1',
                unit_id: '1',
                price_mode: 'net',
              }
            : odooSettings,
        ),
      ],
    ),
  );
  const products: any[] = [];
  for (const raw of f.rows) {
    const p = await ok('/products', 'POST', {
      name: 'ERP sync ' + raw.id,
      sku: 'SYNC-' + randomUUID(),
      price: 9999,
      vat: 23,
      quantity: 12,
      warehouse_id: warehouse,
    });
    products.push(p.id);
    const sku = (await pool.query('SELECT sku FROM products WHERE id=$1', [p.id])).rows[0].sku;
    await ok(`/integrations/${ch}/mappings`, 'POST', { external_id: String(raw.id), sku });
  }
  return { ch, products };
}
const config = (ch: string, x: any = {}) =>
  ok(`/integrations/${ch}/odoo-catalog-sync`, 'PUT', {
    version: 0,
    enabled: true,
    prices: true,
    interval_minutes: 60,
    confirmed: true,
    ...x,
  });
const start = (ch: string, version = 1, key = randomUUID()) =>
  ok(`/integrations/${ch}/odoo-catalog-sync`, 'POST', { version, client_key: key });
const view = (r: any) => ok(`/odoo-catalog-sync-runs/${r.id}?limit=100`);
async function step(r: any) {
  const j = (
    await pool.query(
      "UPDATE jobs SET state='running',attempts=attempts+1,lease_token=$2,locked_at=now() WHERE id=$1 RETURNING *",
      [r.job_id, randomUUID()],
    )
  ).rows[0];
  try {
    await processOdooCatalogSync(j, { transport: f.transport });
  } catch (e) {
    await failOdooCatalogSync(j, e);
  }
  return (await pool.query('SELECT * FROM odoo_catalog_sync_runs WHERE id=$1', [r.id])).rows[0];
}
test('explicit price approval, version and replay, scope of availability and unchanged physical stock', async () => {
  const x = await fixture();
  assert.equal(
    (
      await req(`/integrations/${x.ch}/odoo-catalog-sync`, 'PUT', {
        version: 0,
        enabled: true,
        prices: true,
        interval_minutes: 60,
      })
    ).statusCode,
    422,
  );
  await config(x.ch);
  const key = randomUUID(),
    r = await start(x.ch, 1, key),
    done = await step(r);
  assert.equal(done.state, 'success');
  assert.equal(done.applied, 2);
  assert.equal((await start(x.ch, 1, key)).id, r.id);
  assert.equal((await start(x.ch, 1, key)).replayed, true);
  const p = (
    await pool.query('SELECT price,version FROM products WHERE id=ANY($1::uuid[]) ORDER BY price', [
      x.products,
    ])
  ).rows;
  assert.deepEqual(p, [
    { price: 4305, version: 2 },
    { price: 4920, version: 2 },
  ]);
  assert(
    (
      await pool.query('SELECT on_hand,reserved FROM stock WHERE product_id=ANY($1::uuid[])', [
        x.products,
      ])
    ).rows.every((s) => s.on_hand === 12 && s.reserved === 0),
  );
  assert.equal(
    (
      await pool.query(
        'SELECT count(*)::int n FROM stock_movements WHERE product_id=ANY($1::uuid[])',
        [x.products],
      )
    ).rows[0].n,
    2,
  );
  const v = await view(r);
  assert(v.data.every((i: any) => i.result.physical_stock_changed === false));
  assert(f.calls.every((c) => c.method === 'read'));
  assert.equal(
    f.calls.filter((c) => c.model === 'product.product' && c.args.fields.includes('free_qty'))
      .length,
    2,
  );
});
test('availability-only refresh retains local price and version, and records observed ERP price', async () => {
  const x = await fixture();
  await config(x.ch, { prices: false, confirmed: false });
  const r = await start(x.ch);
  await step(r);
  assert(
    (
      await pool.query('SELECT price,version FROM products WHERE id=ANY($1::uuid[])', [x.products])
    ).rows.every((p) => p.price === 9999 && p.version === 1),
  );
  const listings = (
    await pool.query('SELECT last_result FROM listings WHERE channel_id=$1', [x.ch])
  ).rows;
  assert(
    listings.every(
      (l) =>
        l.last_result.odoo_catalog_sync.availability >= 12 &&
        l.last_result.stock_quantity === l.last_result.odoo_catalog_sync.availability,
    ),
  );
});
test('archived/incomplete foreign ERP rows do not silently update observed availability or local prices', async () => {
  const x = await fixture();
  await config(x.ch);
  f.rows[0].active = false;
  const r = await start(x.ch);
  const done = await step(r);
  assert.equal(done.state, 'failed');
  assert.equal(done.applied, 0);
  assert(
    (
      await pool.query('SELECT price FROM products WHERE id=ANY($1::uuid[])', [x.products])
    ).rows.every((p) => p.price === 9999),
  );
});
test('foreign currency skips local price without FX but permits separate availability-only observations', async () => {
  const x = await fixture();
  f.state.currency = 'EUR';
  await config(x.ch);
  const r = await start(x.ch),
    done = await step(r);
  assert.equal(done.state, 'partial');
  assert.equal(done.skipped, 2);
  await config(x.ch, { version: 1, prices: false, confirmed: false });
  const second = await step(await start(x.ch, 2));
  assert.equal(second.state, 'success');
  assert(
    (
      await pool.query('SELECT price FROM products WHERE id=ANY($1::uuid[])', [x.products])
    ).rows.every((p) => p.price === 9999),
  );
});
test('concurrent product/VAT edits skip affected item and retain other page results', async () => {
  const x = await fixture();
  await config(x.ch);
  const r = await start(x.ch);
  f.state.hook = async () => {
    await pool.query('UPDATE products SET price=8888,vat=8,version=version+1 WHERE id=$1', [
      x.products[0],
    ]);
  };
  const done = await step(r);
  assert.equal(done.state, 'partial');
  assert.equal(done.applied, 1);
  assert.equal(done.skipped, 1);
  assert.equal(
    (await pool.query('SELECT price FROM products WHERE id=$1', [x.products[0]])).rows[0].price,
    8888,
  );
});
test('remapping during read is rejected without writing another local SKU', async () => {
  const x = await fixture();
  await config(x.ch);
  const r = await start(x.ch);
  f.state.hook = async () => {
    await pool.query(
      "UPDATE listings SET product_id=$2 WHERE channel_id=$1 AND external_id='101'",
      [x.ch, x.products[1]],
    );
  };
  const done = await step(r);
  assert.equal(done.skipped, 1);
  assert.equal(
    (await pool.query('SELECT price FROM products WHERE id=$1', [x.products[0]])).rows[0].price,
    9999,
  );
});
test('fractional/negative availability and unsupported units are skipped with explicit item errors', async () => {
  const x = await fixture();
  f.rows[0].free_qty = -1;
  f.rows[1].uom_id = [2, 'kg'];
  await config(x.ch);
  const r = await start(x.ch),
    done = await step(r);
  assert.equal(done.state, 'partial');
  assert.equal(done.applied, 0);
  assert.equal(done.skipped, 2);
  assert((await view(r)).data.every((i: any) => !!i.error));
});
test('pause cancels pending run and fences provider reads before starting', async () => {
  const x = await fixture();
  await config(x.ch);
  const r = await start(x.ch);
  await config(x.ch, { version: 1, enabled: false, confirmed: false });
  const done = await step(r);
  assert.equal(done.state, 'cancelled');
  assert.equal(f.calls.length, 0);
  assert((await view(r)).data.every((i: any) => i.state === 'pending'));
});
test('credential rotation between RPCs stops next request and all local persistence', async () => {
  const x = await fixture();
  await config(x.ch);
  const r = await start(x.ch);
  f.state.hook = async () => {
    await pool.query('UPDATE channels SET credentials=$2 WHERE id=$1', [
      x.ch,
      encrypt({ api_key: 'rotated_' + randomUUID() }),
    ]);
  };
  const done = await step(r);
  assert.equal(done.state, 'cancelled');
  assert.equal(f.calls.length, 1);
  assert.equal(done.applied, 0);
});
test('revoking actor role stops queued provider read, with no partial page writes', async () => {
  const x = await fixture();
  await config(x.ch);
  const r = await start(x.ch);
  f.state.hook = async () => {
    await pool.query("UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2", [
      DEMO_TENANT,
      r.actor_id,
    ]);
  };
  try {
    const done = await step(r);
    assert.equal(done.state, 'cancelled');
    assert.equal(f.calls.length, 1);
    assert.equal(done.applied, 0);
  } finally {
    await pool.query("UPDATE memberships SET role='admin' WHERE tenant_id=$1 AND user_id=$2", [
      DEMO_TENANT,
      r.actor_id,
    ]);
  }
});
test('lost lease does not persist observed page; reclaimer resumes the same immutable item scope', async () => {
  const x = await fixture();
  await config(x.ch);
  const r = await start(x.ch);
  f.state.hook = async () => {
    await pool.query("UPDATE jobs SET state='pending',lease_token=NULL WHERE id=$1", [r.job_id]);
  };
  const first = await step(r);
  assert.equal(first.state, 'queued');
  assert.equal(first.applied, 0);
  assert.equal(f.calls.length, 1);
  assert.equal((await step(r)).state, 'success');
});
test('stock changes without write_date invalidate full variant read and retry unchanged checkpoint', async () => {
  const x = await fixture();
  await config(x.ch);
  const r = await start(x.ch);
  let reads = 0;
  f.state.edit = (model, _method, _data, args) => {
    if (model === 'product.product' && args.fields.includes('free_qty') && ++reads === 1)
      f.rows[0].free_qty = 20;
  };
  const first = await step(r);
  assert.equal(first.state, 'queued');
  assert.equal(first.applied, 0);
  f.state.edit = undefined;
  const done = await step(r);
  assert.equal(done.state, 'success');
  assert.equal(
    (await view(r)).data.find((i: any) => i.external_id === '101').result.availability,
    20,
  );
});
test('151 mapped variants use four durable pages and never rescan completed items after retry', async () => {
  const x = await fixture(151);
  await config(x.ch);
  const r = await start(x.ch);
  let done: any;
  for (let n = 0; n < 4; n++) {
    done = await step(r);
    assert.equal(done.applied, Math.min((n + 1) * 50, 151));
    assert.equal(done.state, n < 3 ? 'queued' : 'success');
  }
  const calls = f.calls.length;
  await step(r);
  assert.equal(f.calls.length, calls);
  assert.equal(done.total, 151);
  assert(
    f.calls
      .filter((c) => c.model === 'product.product' && c.args.fields.includes('free_qty'))
      .every((c) => c.args.ids.length <= 50),
  );
});
test('scheduler starts once, reconciles terminal state and suspends changed connections', async () => {
  const x = await fixture();
  await config(x.ch);
  await scheduleOdooCatalogDue();
  await scheduleOdooCatalogDue();
  const runs = (
    await pool.query('SELECT * FROM odoo_catalog_sync_runs WHERE channel_id=$1', [x.ch])
  ).rows;
  assert.equal(runs.length, 1);
  await step(runs[0]);
  await pool.query(
    "UPDATE odoo_catalog_schedules SET next_at=now()-interval '1 minute',last_finished_at=NULL WHERE channel_id=$1",
    [x.ch],
  );
  await scheduleOdooCatalogDue();
  assert.equal(
    (
      await pool.query('SELECT count(*)::int n FROM odoo_catalog_sync_runs WHERE channel_id=$1', [
        x.ch,
      ])
    ).rows[0].n,
    1,
  );
  await pool.query('UPDATE channels SET credentials=$2 WHERE id=$1', [
    x.ch,
    encrypt({ api_key: 'rotated' }),
  ]);
  await pool.query(
    "UPDATE odoo_catalog_schedules SET next_at=now()-interval '1 minute' WHERE channel_id=$1",
    [x.ch],
  );
  await scheduleOdooCatalogDue();
  assert.equal(
    (await pool.query('SELECT enabled FROM odoo_catalog_schedules WHERE channel_id=$1', [x.ch]))
      .rows[0].enabled,
    false,
  );
});
test('tenant RLS, viewer authorization, stale versions and bounded result pagination', async () => {
  const x = await fixture();
  await config(x.ch);
  const r = await start(x.ch);
  assert.equal(
    (await req(`/integrations/${x.ch}/odoo-catalog-sync`, 'GET', undefined, other)).statusCode,
    404,
  );
  assert.equal(
    (await req(`/odoo-catalog-sync-runs/${r.id}`, 'GET', undefined, other)).statusCode,
    404,
  );
  assert.equal(
    (await req(`/integrations/${x.ch}/odoo-catalog-sync`, 'GET', undefined, viewer)).statusCode,
    403,
  );
  assert.equal(
    (
      await req(`/integrations/${x.ch}/odoo-catalog-sync`, 'PUT', {
        version: 0,
        enabled: false,
        prices: false,
        interval_minutes: 60,
      })
    ).statusCode,
    409,
  );
  const first = await ok(`/odoo-catalog-sync-runs/${r.id}?limit=1`),
    second = await ok(`/odoo-catalog-sync-runs/${r.id}?limit=1&after=${first.next_cursor}`);
  assert.notEqual(first.data[0].id, second.data[0].id);
  assert.equal(second.next_cursor, null);
  assert.equal((await req(`/odoo-catalog-sync-runs/${r.id}?limit=101`)).statusCode, 422);
});
test('local DEMO scheduler changes only mapped local prices, with zero provider calls', async () => {
  const x = await fixture(2, true);
  await config(x.ch);
  const done = await step(await start(x.ch));
  assert.equal(done.state, 'success');
  assert.equal(f.calls.length, 0);
  assert((await view(done)).data.every((i: any) => i.result.scope === 'local_simulation'));
});
test('catalogVariants limits IDs, verifies both full reads and rejects changed ERP scope', async () => {
  const x = odooFixture();
  const c = new Odoo(odooSettings, odooCredentials, x.transport);
  await assert.rejects(() => c.catalogVariants([]));
  await assert.rejects(() => c.catalogVariants(Array.from({ length: 51 }, (_, i) => i + 1)));
  x.state.foreignWarehouse = true;
  await assert.rejects(() => c.catalogVariants([101]));
});

test('exhausted provider read retries mark run failed without partial local writes', async () => {
  const x = await fixture();
  await config(x.ch);
  const r = await start(x.ch);
  f.transport = async () => new Response('{}', { status: 503 });
  await pool.query('UPDATE jobs SET attempts=max_attempts-1 WHERE id=$1', [r.job_id]);
  const done = await step(r);
  assert.equal(done.state, 'failed');
  assert.equal(done.applied, 0);
  assert((await view(r)).data.every((i: any) => i.state === 'pending'));
});
