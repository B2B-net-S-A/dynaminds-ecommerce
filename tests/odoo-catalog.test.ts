import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../server/app';
import { pool, migrate, tenantTx } from '../server/db';
import { seed, DEMO_TENANT } from './fixtures';
import { encrypt } from '../server/security';
import { processCatalogSource, failCatalogSource } from '../server/catalog-source';
import { odooSettings, odooCredentials, odooFixture } from './odoo-fixtures';
assert.equal(process.env.DYNA_TEST, 'true');
let app: Awaited<ReturnType<typeof buildApp>>,
  cookie: string,
  warehouse: string,
  fixture: ReturnType<typeof odooFixture>;
const req = (p: string, method: any = 'GET', body?: any, auth = cookie) =>
  app.inject({ url: '/api' + p, method, payload: body, headers: { cookie: auth } });
const ok = async (p: string, method: any = 'GET', body?: any) => {
  const r = await req(p, method, body);
  assert(r.statusCode < 300, r.body);
  return r.json();
};
before(async () => {
  await migrate();
  await seed();
});
after(async () => {
  await pool.end();
});
beforeEach(async () => {
  fixture = odooFixture();
  app = await buildApp({ integrationTransport: fixture.transport });
  const login = await req(
    '/auth/login',
    'POST',
    { email: 'admin@demo.local', password: 'DynaDemo!2026' },
    '',
  );
  cookie = String(login.headers['set-cookie']).split(';')[0];
  const switched = await req('/workspaces/switch', 'POST', { tenant_id: DEMO_TENANT });
  cookie = String(switched.headers['set-cookie'] ?? cookie).split(';')[0];
  warehouse = (await ok('/warehouses')).data[0].id;
});
afterEach(async () => {
  await app.close();
});
async function channel() {
  const id = randomUUID();
  await tenantTx(DEMO_TENANT, (c) =>
    c.query(
      "INSERT INTO channels(id,tenant_id,provider,name,mode,credentials,settings) VALUES($1,$2,'odoo','Odoo QA','sandbox',$3,$4)",
      [id, DEMO_TENANT, encrypt(odooCredentials), JSON.stringify(odooSettings)],
    ),
  );
  return id;
}
const start = (id: string, x: any = {}) =>
  ok(`/integrations/${id}/catalog-source-runs`, 'POST', {
    client_key: randomUUID(),
    warehouse_id: warehouse,
    vat: 23,
    import_stock: false,
    ...x,
  });
async function step(run: any) {
  const job = (
    await pool.query(
      "UPDATE jobs SET state='running',attempts=attempts+1,lease_token=$2,locked_at=now() WHERE id=$1 RETURNING *",
      [run.job_id, randomUUID()],
    )
  ).rows[0];
  try {
    await processCatalogSource(job, { transport: fixture.transport });
  } catch (e) {
    await failCatalogSource(job, e);
  }
  return (await pool.query('SELECT * FROM catalog_source_runs WHERE id=$1', [run.id])).rows[0];
}
const view = (r: any) => ok(`/catalog-source-runs/${r.id}?limit=100`);
const inputs = (data: any[]) =>
  data.map((r) => ({
    id: r.id,
    source_hash: r.source_hash,
    expected_product_id: r.candidate_id ?? null,
    expected_version: r.candidate_version ?? null,
  }));
const apply = (r: any, data: any[]) =>
  req(`/catalog-source-runs/${r.id}/apply`, 'POST', { items: inputs(data) });
test('Odoo catalog preview/apply groups variants, preserves physical zero, maps products and replays once', async () => {
  const ch = await channel(),
    r = await step(await start(ch));
  assert.equal(r.state, 'ready');
  assert.equal(r.fetched, 3);
  const data = (await view(r)).data;
  assert.equal(data.filter((i: any) => i.kind === 'group').length, 1);
  const first = await apply(r, data);
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(first.json().created, 3);
  const second = await apply(r, data);
  assert.equal(second.statusCode, 200);
  assert(second.json().data.every((v: any) => v.reused));
  const saved = await tenantTx(DEMO_TENANT, (c) =>
    c.query(
      'SELECT p.*,s.on_hand,s.reserved FROM products p LEFT JOIN stock s ON s.product_id=p.id WHERE p.id=ANY($1::uuid[])',
      [first.json().data.map((v: any) => v.product_id)],
    ),
  );
  assert(saved.rows.every((p) => p.kind === 'group' || (p.on_hand === 0 && p.reserved === 0)));
  const group = saved.rows.find((p) => p.kind === 'group');
  assert(saved.rows.filter((p) => p.kind === 'variant').every((p) => p.parent_id === group.id));
  const listing = await tenantTx(DEMO_TENANT, (c) =>
    c.query('SELECT * FROM listings WHERE channel_id=$1', [ch]),
  );
  assert.equal(listing.rowCount, 2);
  assert(
    listing.rows.every(
      (l) => l.parent_external_id === null && l.last_result.stock_scope === 'external_availability',
    ),
  );
  assert.equal(listing.rows[0].last_result.erp.warehouse_id, 1);
});
test('Odoo ERP stock cannot be accepted through catalog import', async () => {
  const ch = await channel();
  const r = await req(`/integrations/${ch}/catalog-source-runs`, 'POST', {
    client_key: randomUUID(),
    warehouse_id: warehouse,
    import_stock: true,
    vat: 23,
  });
  assert.equal(r.statusCode, 422);
  assert.equal(fixture.calls.length, 0);
});
test('Odoo keyset checkpoints 50 rows and resumes without duplicate groups', async () => {
  fixture = odooFixture(51);
  await app.close();
  app = await buildApp({ integrationTransport: fixture.transport });
  const r = await start(await channel()),
    page1 = await step(r);
  assert.equal(page1.state, 'queued');
  assert.equal(page1.cursor.after, 150);
  assert.equal(page1.fetched, 51);
  const page2 = await step(page1);
  assert.equal(page2.state, 'ready', page2.error);
  assert.equal(page2.fetched, 52);
  assert.equal(page2.cursor.pages, 2);
});
test('Odoo credential rotation prevents another network request and local apply', async () => {
  const ch = await channel(),
    r = await start(ch);
  await tenantTx(DEMO_TENANT, (c) =>
    c.query('UPDATE channels SET credentials=$2 WHERE id=$1', [
      ch,
      encrypt({ api_key: 'rotated_' + 'b'.repeat(32) }),
    ]),
  );
  const failed = await step(r);
  assert.equal(failed.state, 'failed');
  assert.equal(fixture.calls.length, 0);
});
test('Odoo cancellation during HTTP fences the next RPC and discards page', async () => {
  const r = await start(await channel());
  fixture.state.hook = async () => {
    assert.equal((await req(`/catalog-source-runs/${r.id}/cancel`, 'POST', {})).statusCode, 200);
  };
  const stopped = await step(r);
  assert.equal(stopped.state, 'cancelled');
  assert.equal(stopped.fetched, 0);
  assert.equal(fixture.calls.length, 1);
});
test('Odoo connection change after HTTP discards page and refuses stale apply', async () => {
  const ch = await channel(),
    r = await start(ch);
  fixture.state.hook = async () => {
    await tenantTx(DEMO_TENANT, (c) =>
      c.query('UPDATE channels SET settings=settings || $2::jsonb WHERE id=$1', [
        ch,
        JSON.stringify({ company_id: '2' }),
      ]),
    );
  };
  const failed = await step(r);
  assert.equal(failed.state, 'failed');
  assert.equal(failed.fetched, 0);
  assert.equal(fixture.calls.length, 1);
});
test('Odoo current membership is checked before each RPC', async () => {
  const r = await start(await channel());
  const actorId = r.actor_id;
  fixture.state.hook = async () => {
    await pool.query("UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2", [
      DEMO_TENANT,
      actorId,
    ]);
  };
  try {
    const failed = await step(r);
    assert.equal(failed.state, 'failed');
    assert.equal(failed.fetched, 0);
    assert.equal(fixture.calls.length, 1);
  } finally {
    await pool.query("UPDATE memberships SET role='admin' WHERE tenant_id=$1 AND user_id=$2", [
      DEMO_TENANT,
      actorId,
    ]);
  }
});
test('Odoo cross-page template changes and currency changes do not yield a ready catalog', async () => {
  fixture = odooFixture(51);
  await app.close();
  app = await buildApp({ integrationTransport: fixture.transport });
  const r = await step(await start(await channel()));
  for (const row of fixture.rows) row.template.name = 'Changed template';
  const failed = await step(r);
  assert.equal(failed.state, 'failed');
  assert.equal(failed.fetched, 51);
  const second = await start(await channel());
  const staged = await step(second);
  fixture.state.currency = 'EUR';
  const mismatched = await step(staged);
  assert.equal(mismatched.state, 'failed');
});
test('Odoo import is atomic on unsupported units; foreign currency needs explicit local price', async () => {
  fixture.rows[1].uom_id = [2, 'kg'];
  const r = await step(await start(await channel())),
    data = (await view(r)).data;
  const result = await apply(r, data);
  assert.equal(result.statusCode, 422);
  assert.equal((await view(r)).data.filter((i: any) => i.state === 'applied').length, 0);
  fixture.rows[1].uom_id = [1, 'Units'];
  fixture.state.currency = 'EUR';
  const r2 = await step(await start(await channel())),
    d2 = (await view(r2)).data;
  assert.equal((await apply(r2, d2)).statusCode, 422);
  const override = await req(`/catalog-source-runs/${r2.id}/apply`, 'POST', {
    items: inputs(d2).map((i) => ({ ...i, price_override: 1234 })),
  });
  assert.equal(override.statusCode, 200, override.body);
});
test('Odoo viewer and another organization cannot inspect or start a catalog', async () => {
  const ch = await channel(),
    r = await step(await start(ch));
  for (const email of ['viewer@demo.local', 'other@demo.local']) {
    const login = await req('/auth/login', 'POST', { email, password: 'DynaDemo!2026' }, '');
    const auth = String(login.headers['set-cookie']).split(';')[0];
    const response = await req(`/catalog-source-runs/${r.id}`, 'GET', undefined, auth);
    assert([403, 404].includes(response.statusCode));
  }
});
test('Odoo example is explicitly synthetic, has no HTTP and creates no products until approval', async () => {
  const ch = await ok('/integrations/odoo-example', 'POST', {}),
    again = await ok('/integrations/odoo-example', 'POST', {});
  assert.equal(ch.channel_id, again.channel_id);
  assert.equal(ch.scope, 'local_simulation');
  const r = await step(await start(ch.channel_id));
  assert.equal(r.state, 'ready');
  assert.equal(fixture.calls.length, 0);
  assert.equal(r.fetched, 3);
  const peek = await req(`/integrations/${ch.channel_id}/preview?resource=products`);
  assert.equal(peek.statusCode, 422);
});

test('Odoo stale lease after HTTP prevents the next request and checkpoint', async () => {
  const r = await start(await channel());
  fixture.state.hook = async () => {
    await pool.query('UPDATE jobs SET lease_token=$2 WHERE id=$1', [r.job_id, randomUUID()]);
  };
  const stopped = await step(r);
  assert.equal(stopped.state, 'queued');
  assert.equal(stopped.fetched, 0);
  assert.equal(fixture.calls.length, 1);
});
test('Odoo credential rotation after preview blocks local approval', async () => {
  const ch = await channel(),
    r = await step(await start(ch)),
    data = (await view(r)).data;
  await tenantTx(DEMO_TENANT, (c) =>
    c.query('UPDATE channels SET credentials=$2 WHERE id=$1', [
      ch,
      encrypt({ api_key: 'rotated_' + 'b'.repeat(32) }),
    ]),
  );
  assert.equal((await apply(r, data)).statusCode, 409);
  assert.equal((await view(r)).data.filter((i: any) => i.state === 'applied').length, 0);
});

test('Odoo 1001 variants checkpoint 21 pages and expose bounded staff pagination', async () => {
  fixture = odooFixture(1001);
  for (const row of fixture.rows) row.template.product_variant_count = 1001;
  await app.close();
  app = await buildApp({ integrationTransport: fixture.transport });
  const began = performance.now(),
    initial = await start(await channel());
  let r = initial;
  for (let page = 0; page < 22 && r.state === 'queued'; page++) r = await step(r);
  assert.equal(r.state, 'ready', r.error);
  assert.equal(r.fetched, 1002);
  assert.equal(r.cursor.pages, 21);
  const first = await ok(`/catalog-source-runs/${r.id}?limit=25`);
  assert.equal(first.data.length, 25);
  assert(first.meta.cursor);
  console.log(
    JSON.stringify({
      scope: 'isolated_local_Odoo_contract_fixture',
      variants: 1001,
      pages: 21,
      staged_entries: 1002,
      elapsed_ms: Math.round(performance.now() - began),
      provider_throughput_proven: false,
    }),
  );
});
