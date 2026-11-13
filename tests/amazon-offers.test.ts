import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pool, migrate, tenantTx } from '../server/db';
import { buildApp } from '../server/app';
import { seed, DEMO_TENANT, SECOND_TENANT } from './fixtures';
import { encrypt } from '../server/security';
import { processOfferJob, failOffer } from '../server/offers';
import { processOfferSync, failOfferSync } from '../server/offer-sync';
import { amazonOfferFixture, offerConfig } from './amazon-offer-fixture';
import { amazonSecrets } from './amazon-fixture';
import { tenantScopedOwnerQuery } from './tenant-scoped-owner-write';
assert.equal(process.env.DYNA_TEST, 'true');
let app: Awaited<ReturnType<typeof buildApp>>,
  cookie: string,
  other: string,
  viewer: string,
  warehouse: string,
  user: string,
  f = amazonOfferFixture();
const req = (p: string, method: any = 'GET', payload?: any, auth = cookie) =>
  app.inject({ url: '/api' + p, method, payload, headers: { cookie: auth } });
async function ok(p: string, method: any = 'GET', payload?: any, auth = cookie) {
  const r = await req(p, method, payload, auth);
  assert(r.statusCode < 300, r.body);
  return r.json();
}
before(async () => {
  await migrate();
  await seed();
  app = await buildApp({ integrationTransport: (u, i) => f.transport(u, i) });
  const login = async (email: string) =>
    (await req('/auth/login', 'POST', { email, password: 'DynaDemo!2026' }, '')).headers[
      'set-cookie'
    ]!.toString().split(';')[0];
  cookie = await login('admin@demo.local');
  other = await login('other@demo.local');
  viewer = await login('viewer@demo.local');
  warehouse = (await ok('/warehouses')).data[0].id;
  user = (await ok('/auth/me')).user.id;
});
after(async () => {
  await app.close();
  await pool.end();
});
beforeEach(async () => {
  f = amazonOfferFixture();
  await pool.query('DELETE FROM amazon_offer_scopes');
  await pool.query('DELETE FROM amazon_api_buckets');
  await pool.query("UPDATE jobs SET state='done',lease_token=NULL,locked_at=NULL");
  await pool.query('UPDATE offer_sync_configs SET enabled=false');
});
afterEach(async () => {
  await pool.query("UPDATE memberships SET role='admin' WHERE tenant_id=$1 AND user_id=$2", [
    DEMO_TENANT,
    user,
  ]);
});
async function fixture(extra: any = {}, auth = cookie, sku = 'QA075-' + randomUUID()) {
  const wh =
    auth === cookie ? warehouse : (await ok('/warehouses', 'GET', undefined, auth)).data[0].id;
  const ch = await ok(
    '/integrations',
    'POST',
    {
      provider: 'amazon',
      name: 'Amazon offer QA075',
      mode: 'sandbox',
      settings: { ...offerConfig, ...extra },
      credentials: amazonSecrets,
    },
    auth,
  );
  const p = await ok(
    '/products',
    'POST',
    { sku, name: 'Amazon offer QA075', price: 15001, vat: 23, quantity: 10, warehouse_id: wh },
    auth,
  );
  const l = await ok(`/integrations/${ch.id}/mappings`, 'POST', { external_id: sku, sku }, auth);
  if (!f.store.has(sku)) f.store.set(sku, f.item(sku));
  return { ch, p, l, wh, sku, auth };
}
async function preview(x: any, extra: any = {}) {
  return ok(
    `/integrations/${x.ch.id}/offers/preview`,
    'POST',
    {
      product_id: x.p.id,
      listing_id: x.l.id,
      warehouse_id: x.wh,
      operation: 'sync',
      stock: true,
      price: true,
      ...extra,
    },
    x.auth,
  );
}
const queue = (p: any, confirm = true, auth = cookie) =>
  ok(`/offer-plans/${p.id}/queue`, 'POST', { confirm_live: confirm }, auth);
async function step(p: any, error?: RegExp) {
  const plan = (await pool.query('SELECT * FROM offer_plans WHERE id=$1', [p.id])).rows[0];
  const job = (
    await pool.query(
      "UPDATE jobs SET state='running',attempts=attempts+1,lease_token=$2,locked_at=now() WHERE id=$1 RETURNING *",
      [plan.job_id, randomUUID()],
    )
  ).rows[0];
  try {
    await processOfferJob(job, { transport: f.transport });
    assert(!error, 'Expected failure');
  } catch (e) {
    if (!error) throw e;
    assert.match((e as Error).message, error);
    await failOffer(job, e);
  }
  return (await pool.query('SELECT * FROM offer_plans WHERE id=$1', [p.id])).rows[0];
}
const patches = () => f.calls.filter((c) => c.method === 'PATCH');
test('granular base-price and regional FBM write preserves sale, B2B, other market, lead time, restock and FBA; current sale price remains different', async () => {
  const x = await fixture(),
    remote = f.store.get(x.sku),
    before = structuredClone(remote);
  const p = await preview(x);
  assert.deepEqual(p.before.regional_markets, f.markets.slice().sort());
  assert.equal(p.before.current_b2c_price_minor, 10000);
  assert.equal(p.before.base_price_minor, 12345);
  await queue(p);
  const r = await step(p);
  assert.equal(r.state, 'done');
  assert.equal(r.result.desired_applied, true);
  assert.equal(r.result.actual_snapshot.base_price_minor, 15001);
  assert.equal(r.result.actual_snapshot.current_b2c_price_minor, 10000);
  assert.equal(remote.attributes.fulfillment_availability[0].quantity, 10);
  assert.equal(remote.fulfillmentAvailability[1].quantity, 12);
  assert.deepEqual(
    remote.attributes.purchasable_offer.slice(1),
    before.attributes.purchasable_offer.slice(1),
  );
  assert.deepEqual(
    remote.attributes.purchasable_offer[0].discounted_price,
    before.attributes.purchasable_offer[0].discounted_price,
  );
  assert.equal(remote.attributes.fulfillment_availability[0].restock_date, '2026-10-10');
  assert.equal(patches().length, 1);
  assert.equal((await pool.query('SELECT count(*)::int n FROM amazon_offer_scopes')).rows[0].n, 0);
  const stock = await tenantTx(DEMO_TENANT, (c) =>
    c.query('SELECT on_hand,reserved FROM stock WHERE product_id=$1', [x.p.id]),
  );
  assert.deepEqual(stock.rows[0], { on_hand: 10, reserved: 0 });
});
test('ACCEPTED persists verification, defers without consuming attempts and never repeats PATCH', async () => {
  const x = await fixture(),
    p = await preview(x);
  f.state.delay = true;
  await queue(p);
  let r = await step(p, /przetwarza/);
  assert.equal(r.phase, 'verify');
  assert.equal(r.result.amazon_ack, 'ACCEPTED');
  assert.equal(
    (await pool.query('SELECT attempts,state FROM jobs WHERE id=$1', [r.job_id])).rows[0].attempts,
    0,
  );
  await step(p, /przetwarza/);
  assert.equal(patches().length, 1);
  f.state.pending!();
  r = await step(p);
  assert.equal(r.state, 'done');
  assert.equal(patches().length, 1);
});
test('lost PATCH response reloads durable write_started and reconciles by GET only', async () => {
  const x = await fixture(),
    p = await preview(x);
  await queue(p);
  f.state.lost = true;
  let r = await step(p, /Lost PATCH/);
  assert.equal(r.phase, 'write_started');
  r = await step(p);
  assert.equal(r.state, 'done');
  assert.equal(patches().length, 1);
});
test('PATCH 401 is never replayed by OAuth; subsequent worker only reads', async () => {
  const x = await fixture(),
    p = await preview(x);
  await queue(p);
  f.state.unauthorized = true;
  let r = await step(p, /HTTP 401/);
  assert.equal(r.phase, 'write_started');
  r = await step(p, /przetwarza/);
  assert.equal(r.state, 'queued');
  assert.equal(patches().length, 1);
});
test('PATCH 429 records cooldown and uncertain phase; no automatic duplicate mutation', async () => {
  const x = await fixture(),
    p = await preview(x);
  await queue(p);
  f.state.fail429 = true;
  let r = await step(p, /limit API/);
  assert.equal(r.phase, 'write_started');
  await step(p, /przetwarza/);
  assert.equal(patches().length, 1);
  assert.equal(
    (
      await pool.query(
        "SELECT limited_responses::int n FROM amazon_api_buckets WHERE family='listing_write'",
      )
    ).rows[0].n,
    1,
  );
});
test('exhausted PATCH budget waits before durable write checkpoint', async () => {
  const x = await fixture(),
    p = await preview(x);
  await queue(p);
  // The account-independent application bucket is shared across tenants; fill it through five actual fixture PATCH calls in a separate connector test below is unnecessary here: precreate matching family scope.
  const { createHash } = await import('node:crypto');
  const scope = createHash('sha256')
    .update(
      JSON.stringify({
        mode: 'sandbox',
        region: 'eu',
        clientId: amazonSecrets.client_id,
        family: 'listing_write',
      }),
    )
    .digest('hex');
  await pool.query(
    "INSERT INTO amazon_api_buckets(scope_hash,family,tokens,cooldown_until) VALUES($1,'listing_write',0,now()+interval '1 minute')",
    [scope],
  );
  const r = await step(p, /limit API/);
  assert.equal(r.phase, 'ready');
  assert.equal(patches().length, 0);
});
test('explicit INVALID is a terminal rejected request and releases regional scope', async () => {
  const x = await fixture(),
    p = await preview(x);
  await queue(p);
  f.state.status = 'INVALID';
  const r = await step(p);
  assert.equal(r.state, 'failed');
  assert.equal(r.phase, 'ready');
  assert.equal(r.result.amazon_ack, 'INVALID');
  await queue(await preview(x));
});
test('price-only touches selected B2C base; stock-only zero sends no price and preserves FBA', async () => {
  let x = await fixture(),
    p = await preview(x, { stock: false });
  await queue(p);
  await step(p);
  assert.equal(patches()[0].body.patches.length, 1);
  assert.equal(patches()[0].body.patches[0].path, '/attributes/purchasable_offer');
  x = await fixture();
  await tenantScopedOwnerQuery(DEMO_TENANT, 'UPDATE stock SET on_hand=0 WHERE product_id=$1', [x.p.id]);
  p = await preview(x, { price: false });
  await queue(p);
  await step(p);
  assert.equal(patches()[1].body.patches[0].value[0].quantity, 0);
  assert.equal(patches()[1].body.patches.length, 1);
});
test('comma, slash and spaces in SKU use encoded single item path without CSV ambiguity', async () => {
  const x = await fixture({}, cookie, 'a,b / QA075'),
    p = await preview(x);
  await queue(p);
  assert.equal((await step(p)).state, 'done');
  assert(patches()[0].path.endsWith('a%2Cb%20%2F%20QA075'));
});
test('sandbox requires explicit confirmation, write flag; read-only preview still works', async () => {
  const x = await fixture({ listing_write: 'false' }),
    p = await preview(x);
  assert.equal(
    (await req(`/offer-plans/${p.id}/queue`, 'POST', { confirm_live: true })).statusCode,
    422,
  );
  const y = await fixture(),
    q = await preview(y);
  assert.equal(
    (await req(`/offer-plans/${q.id}/queue`, 'POST', { confirm_live: false })).statusCode,
    422,
  );
});
test('RLS and author roles protect preview, queue and result', async () => {
  const x = await fixture(),
    p = await preview(x);
  assert.equal(
    (await req(`/integrations/${x.ch.id}/offers/preview`, 'POST', {}, viewer)).statusCode,
    403,
  );
  assert.equal(
    (await req(`/offer-plans/${p.id}/queue`, 'POST', { confirm_live: true }, other)).statusCode,
    404,
  );
  await queue(p);
  await pool.query("UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2", [
    DEMO_TENANT,
    user,
  ]);
  await step(p, /[Aa]dministrator/);
  assert.equal(patches().length, 0);
});
test('credential rotation after preview blocks queue and rotated grant cannot reconcile uncertain writes', async () => {
  const x = await fixture(),
    p = await preview(x);
  await pool.query('UPDATE channels SET credentials=$2 WHERE id=$1', [
    x.ch.id,
    encrypt({ ...amazonSecrets, refresh_token: 'ROTATED-QA' }),
  ]);
  assert.equal(
    (await req(`/offer-plans/${p.id}/queue`, 'POST', { confirm_live: true })).statusCode,
    409,
  );
  assert.equal(patches().length, 0);
});
test('local or provider changes after preview stop before PATCH', async () => {
  const x = await fixture(),
    p = await preview(x);
  await queue(p);
  f.store.get(x.sku).attributes.color[0].value = 'White';
  assert.equal((await step(p, /zmieniła się/)).state, 'conflict');
  assert.equal(patches().length, 0);
  const y = await fixture(),
    q = await preview(y);
  await queue(q);
  await tenantScopedOwnerQuery(DEMO_TENANT, 'UPDATE stock SET on_hand=9 WHERE product_id=$1', [y.p.id]);
  await step(q, /lokalny/);
  assert.equal(patches().length, 0);
});
test('same regional seller/SKU cannot be dispatched through different tenants or markets while uncertain', async () => {
  const x = await fixture(),
    p = await preview(x);
  await queue(p);
  f.state.lost = true;
  f.state.delay = true;
  await step(p, /Lost PATCH/);
  const y = await fixture({}, other, x.sku),
    q = await preview(y);
  const blocked = await req(`/offer-plans/${q.id}/queue`, 'POST', { confirm_live: true }, other);
  assert.equal(blocked.statusCode, 409);
  assert.match(blocked.body, /regionalnego SKU/);
  await tenantTx(SECOND_TENANT, async (c) => {
    await assert.rejects(c.query('SELECT * FROM amazon_offer_scopes'), /permission denied/);
  });
});
test('partial application never reports complete; explicit read-only close releases uncertainty', async () => {
  const x = await fixture(),
    p = await preview(x);
  await queue(p);
  f.state.delay = true;
  let r = await step(p, /przetwarza/);
  f.store.get(x.sku).attributes.purchasable_offer[0].our_price = [
    { schedule: [{ value_with_tax: 150.01 }] },
  ];
  await step(p, /przetwarza/);
  await pool.query(
    "UPDATE offer_plans SET result=result||jsonb_build_object('write_started_at',(now()-interval '2 hours')::text) WHERE id=$1",
    [p.id],
  );
  r = await step(p, /godziny/);
  assert.equal(r.state, 'failed');
  await ok(`/offer-plans/${p.id}/reconcile`, 'POST', { accept_observed: true });
  r = await step(p);
  assert.equal(r.state, 'done');
  assert.equal(r.result.desired_applied, false);
  assert.equal(r.result.scope, 'external_api_observed');
  assert.equal(r.result.verified_payload, null);
  assert.equal(patches().length, 1);
});
test('changing unrelated attributes during async apply requires reconciliation instead of silent completion', async () => {
  const x = await fixture(),
    p = await preview(x);
  await queue(p);
  f.state.delay = true;
  await step(p, /przetwarza/);
  f.state.pending!();
  f.store.get(x.sku).attributes.fulfillment_availability[0].lead_time_to_ship_max_days = 3;
  const r = await step(p, /Pozostałe atrybuty/);
  assert.equal(r.state, 'failed');
  assert.equal(patches().length, 1);
});
test('lease loss during preflight blocks network mutation', async () => {
  const x = await fixture(),
    p = await preview(x);
  await queue(p);
  f.state.hook = async (u, m) => {
    if (m === 'GET' && u.pathname.startsWith('/listings/'))
      await pool.query(
        'UPDATE jobs SET lease_token=$2 WHERE id=(SELECT job_id FROM offer_plans WHERE id=$1)',
        [p.id, randomUUID()],
      );
  };
  await step(p, /Dzierżawa/);
  assert.equal(patches().length, 0);
});
test('timed base schedules, FBA-only stock and unsupported market scope fail explicitly', async () => {
  const x = await fixture();
  f.store.get(x.sku).attributes.purchasable_offer[0].our_price[0].schedule[0].start_at =
    '2026-10-05';
  assert.equal(
    (
      await req(`/integrations/${x.ch.id}/offers/preview`, 'POST', {
        product_id: x.p.id,
        listing_id: x.l.id,
        warehouse_id: x.wh,
        operation: 'sync',
        stock: false,
        price: true,
      })
    ).statusCode,
    422,
  );
  f.store.get(x.sku).fulfillmentAvailability.shift();
  const r = await req(`/integrations/${x.ch.id}/offers/preview`, 'POST', {
    product_id: x.p.id,
    listing_id: x.l.id,
    warehouse_id: x.wh,
    operation: 'sync',
    stock: true,
    price: false,
  });
  assert.equal(r.statusCode, 422);
});
test('schedule queues once, acknowledges verified result and grant rotation stops dispatch', async () => {
  const x = await fixture();
  await ok(`/integrations/${x.ch.id}/offer-sync`, 'PATCH', {
    version: 0,
    enabled: true,
    warehouse_id: x.wh,
    stock: true,
    price: true,
    interval_seconds: 30,
    verify_seconds: 60,
    confirm_external: true,
  });
  const run = async () => {
    const r = await ok(`/integrations/${x.ch.id}/offer-sync`, 'POST', {});
    const j = (
      await pool.query(
        "UPDATE jobs SET state='running',attempts=attempts+1,lease_token=$2,locked_at=now() WHERE id=$1 RETURNING *",
        [r.id, randomUUID()],
      )
    ).rows[0];
    try {
      await processOfferSync(j, { transport: f.transport });
    } catch (e) {
      await failOfferSync(j, e);
      throw e;
    }
  };
  await run();
  const p = (await pool.query('SELECT id FROM offer_plans WHERE channel_id=$1', [x.ch.id])).rows[0];
  await step(p);
  await run();
  assert.equal(patches().length, 1);
  const cfg = await ok(`/integrations/${x.ch.id}/offer-sync`);
  assert.equal(cfg.data[0].state, 'verified');
  await pool.query('UPDATE channels SET credentials=$2 WHERE id=$1', [
    x.ch.id,
    encrypt({ ...amazonSecrets, refresh_token: 'ROTATED' }),
  ]);
  assert.equal((await req(`/integrations/${x.ch.id}/offer-sync`, 'POST', {})).statusCode, 409);
});

test('grant rotation after uncertain response blocks even GET reconciliation with the new identity', async () => {
  const x = await fixture(),
    p = await preview(x);
  await queue(p);
  f.state.lost = true;
  await step(p, /Lost PATCH/);
  const prior = (await pool.query('SELECT credentials FROM channels WHERE id=$1', [x.ch.id]))
    .rows[0].credentials;
  await pool.query('UPDATE channels SET credentials=$2 WHERE id=$1', [
    x.ch.id,
    encrypt({ ...amazonSecrets, refresh_token: 'ROTATED-QA' }),
  ]);
  const reads = f.calls.length;
  await step(p, /dane dostępu/);
  assert.equal(f.calls.length, reads);
  assert.equal(patches().length, 1);
  await pool.query('UPDATE channels SET credentials=$2 WHERE id=$1', [x.ch.id, prior]);
  await ok(`/offer-plans/${p.id}/reconcile`, 'POST', {});
  assert.equal((await step(p)).state, 'done');
  assert.equal(patches().length, 1);
});
test('write flag disabled after dispatch still permits read-only confirmation; before dispatch it blocks', async () => {
  const x = await fixture(),
    p = await preview(x);
  await queue(p);
  f.state.delay = true;
  await step(p, /przetwarza/);
  await pool.query(
    "UPDATE channels SET settings=jsonb_set(settings,'{listing_write}','false') WHERE id=$1",
    [x.ch.id],
  );
  f.state.pending!();
  assert.equal((await step(p)).state, 'done');
  assert.equal(patches().length, 1);
  const y = await fixture(),
    q = await preview(y);
  await queue(q);
  await pool.query(
    "UPDATE channels SET settings=jsonb_set(settings,'{listing_write}','false') WHERE id=$1",
    [y.ch.id],
  );
  await step(q, /Włącz zapis/);
  assert.equal(patches().length, 1);
});
test('unknown participant and region mismatch cannot silently narrow shared inventory scope', async () => {
  const x = await fixture();
  f.markets.push('UNKNOWN-MARKET');
  const r = await req(`/integrations/${x.ch.id}/offers/preview`, 'POST', {
    product_id: x.p.id,
    listing_id: x.l.id,
    warehouse_id: x.wh,
    operation: 'sync',
    stock: true,
    price: false,
  });
  assert.equal(r.statusCode, 422);
  assert.match(r.body, /nieobsługiwany rynek/);
});
test('cross-market price-only request also respects regional SKU uncertainty', async () => {
  const x = await fixture(),
    p = await preview(x);
  await queue(p);
  f.state.delay = true;
  await step(p, /przetwarza/);
  const y = await fixture({ marketplace_id: 'A1PA6795UKMFR9' }, other, x.sku),
    q = await preview(y, { price: false });
  assert.equal(
    (await req(`/offer-plans/${q.id}/queue`, 'POST', { confirm_live: true }, other)).statusCode,
    409,
  );
  assert.equal(patches().length, 1);
});
test('schedule paused during preflight performs no PATCH; after dispatch it can finish verification', async () => {
  const x = await fixture();
  let cfg = await ok(`/integrations/${x.ch.id}/offer-sync`, 'PATCH', {
    version: 0,
    enabled: true,
    warehouse_id: x.wh,
    stock: true,
    price: true,
    interval_seconds: 30,
    verify_seconds: 60,
    confirm_external: true,
  });
  const run = await ok(`/integrations/${x.ch.id}/offer-sync`, 'POST', {});
  const j = (
    await pool.query(
      "UPDATE jobs SET state='running',lease_token=$2,locked_at=now() WHERE id=$1 RETURNING *",
      [run.id, randomUUID()],
    )
  ).rows[0];
  await processOfferSync(j, { transport: f.transport });
  const p = (await pool.query('SELECT * FROM offer_plans WHERE channel_id=$1', [x.ch.id])).rows[0];
  f.state.hook = async (u, m) => {
    if (m === 'GET' && u.pathname.startsWith('/listings/')) {
      f.state.hook = undefined;
      await ok(`/integrations/${x.ch.id}/offer-sync`, 'PATCH', {
        version: cfg.version,
        enabled: false,
        warehouse_id: x.wh,
        stock: true,
        price: true,
        interval_seconds: 30,
        verify_seconds: 60,
      });
    }
  };
  await step(p, /Harmonogram|Dzierżawa|aktywny/);
  assert.equal(patches().length, 0);
});

test('official ACCEPTED response may omit optional issues', async () => {
  const x = await fixture(),
    p = await preview(x);
  await queue(p);
  f.state.omitIssues = true;
  assert.equal((await step(p)).state, 'done');
  assert.equal(patches().length, 1);
});
test('stock changed after dispatch is reported separately from verified remote write', async () => {
  const x = await fixture(),
    p = await preview(x);
  await queue(p);
  f.state.hook = async (u, m) => {
    if (m === 'PATCH') {
      f.state.hook = undefined;
      await tenantScopedOwnerQuery(DEMO_TENANT, 'UPDATE stock SET on_hand=9 WHERE product_id=$1', [x.p.id]);
    }
  };
  const r = await step(p);
  assert.equal(r.state, 'done');
  assert.equal(r.result.desired_applied, true);
  assert.equal(r.result.local_changed, true);
  assert.equal(r.result.actual_snapshot.stock_quantity, 10);
  assert.equal(patches().length, 1);
});
