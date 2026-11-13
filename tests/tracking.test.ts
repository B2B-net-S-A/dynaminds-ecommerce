import { legacySerialOrderStatusPayload } from './order-status-cas-helper';
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { rewriteShipmentFixture } from './shipment-identity-fixture';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../server/app';
import { pool, migrate, tenantTx } from '../server/db';
import { seed, DEMO_TENANT, SECOND_TENANT } from './fixtures';
import { encrypt } from '../server/security';
import {
  processTracking,
  failTracking,
  scheduleTrackingDue,
  readShipmentTracking,
  TRACKING_BATCH,
  TRACKING_BACKLOG,
} from '../server/tracking';
import { tick } from '../server/worker';
import type { IntegrationContext } from '../server/channel-access';
assert.equal(process.env.DYNA_TEST, 'true');
let app: Awaited<ReturnType<typeof buildApp>>,
  cookie: string,
  viewer: string,
  other: string,
  operator: string,
  warehouse: string,
  actorId: string;
const responses = new Map<string, any>(),
  calls: { url: string; method: string }[] = [];
let hook: (() => Promise<void>) | undefined,
  failure = 0;
const ctx: IntegrationContext = {
  transport: async (url, init) => {
    calls.push({ url, method: init.method ?? 'GET' });
    assert.equal(new URL(url).origin, 'https://api-shipx-pl.easypack24.net');
    assert.equal(new Headers(init.headers).has('authorization'), false);
    const current = hook;
    hook = undefined;
    await current?.();
    if (failure)
      return new Response(JSON.stringify({ secret: 'DO_NOT_EXPOSE' }), { status: failure });
    return new Response(JSON.stringify(responses.get(new URL(url).pathname.split('/').at(-1)!)), {
      status: 200,
    });
  },
};
const req = (p: string, m: any = 'GET', b?: any, auth = cookie) =>
  app.inject({
    url: '/api' + p,
    method: m,
    payload: b,
    headers: { cookie: auth, ...(p === '/orders' ? { 'idempotency-key': randomUUID() } : {}) },
  });
async function ok(p: string, m: any = 'GET', b?: any, auth = cookie) {
  const r = await req(p, m, b, auth);
  assert(r.statusCode < 300, r.body);
  return r.json();
}
before(async () => {
  await migrate();
  await seed();
  app = await buildApp({ integrationTransport: ctx.transport });
  for (const [email, set] of [
    ['admin@demo.local', (v: string) => (cookie = v)],
    ['viewer@demo.local', (v: string) => (viewer = v)],
    ['other@demo.local', (v: string) => (other = v)],
    ['operator@demo.local', (v: string) => (operator = v)],
  ] as const) {
    const r = await req('/auth/login', 'POST', { email, password: 'DynaDemo!2026' }, '');
    set(r.headers['set-cookie']!.toString().split(';')[0]);
  }
  warehouse = (await ok('/warehouses')).data[0].id;
  actorId = (await ok('/auth/me')).user.id;
});
after(async () => {
  await app.close();
  await pool.end();
});
beforeEach(() => {
  calls.length = 0;
  hook = undefined;
  failure = 0;
});
const read = (sql: string, args: any[] = []) =>
  tenantTx(DEMO_TENANT, async (c) => (await c.query(sql, args)).rows);
const rewriteRows = async (sql: string, args: any[] = []) =>
  (await rewriteShipmentFixture(sql, args)).rows;
async function channel(sim = false, mode = 'live') {
  const id = randomUUID();
  await read(
    "INSERT INTO channels(id,tenant_id,provider,name,mode,credentials,settings) VALUES($1,$2,'inpost','Tracking QA',$3,$4,$5)",
    [
      id,
      DEMO_TENANT,
      mode,
      encrypt({ access_token: 'fixture' }),
      JSON.stringify({ simulation: sim, organization_id: '1' }),
    ],
  );
  return id;
}
async function shipment(ch: string) {
  const p = await ok('/products', 'POST', {
    sku: 'TRACK-' + randomUUID(),
    name: 'Tracking fixture',
    price: 10000,
    vat: 23,
    warehouse_id: warehouse,
    quantity: 2,
  });
  const o = await ok('/orders', 'POST', {
    customer_name: 'Tracking QA',
    email: 'tracking@example.test',
    warehouse_id: warehouse,
    address: {
      street: 'Testowa 1',
      city: 'Warszawa',
      postal_code: '00-001',
      country: 'PL',
      phone: '500600700',
    },
    items: [{ product_id: p.id, quantity: 1 }],
  });
  for (const status of ['paid', 'picking'])
    await ok('/orders/' + o.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => ok(orderPath, 'GET', undefined), '/orders/' + o.id + '/status', { status }));
  await ok('/orders/' + o.id + '/scan', 'POST', { code: p.sku });
  await ok('/orders/' + o.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => ok(orderPath, 'GET', undefined), '/orders/' + o.id + '/status', { status: 'packed' }));
  await ok('/orders/' + o.id + '/ship-demo', 'POST', {});
  const s = (
    await rewriteRows(
      "UPDATE shipments SET channel_id=$2,external_id='QA-'||id::text,status='confirmed',dispatched_at=now() WHERE order_id=$1 RETURNING *",
      [o.id, ch],
    )
  )[0];
  responses.set(s.tracking_number, {
    tracking_number: s.tracking_number,
    status: 'out_for_delivery',
    updated_at: new Date().toISOString(),
    tracking_details: [{ status: 'out_for_delivery', datetime: new Date().toISOString() }],
  });
  return { s, o, p };
}
async function configure(ch: string, patch: any = {}) {
  const d = await ok('/integrations/' + ch + '/tracking');
  return ok('/integrations/' + ch + '/tracking', 'PATCH', {
    version: d.config?.version ?? 0,
    enabled: true,
    interval_seconds: 60,
    mark_delivered: true,
    confirm_external: true,
    ...patch,
  });
}
async function queue(ch: string) {
  await ok('/integrations/' + ch + '/tracking', 'POST');
  return await read(
    "SELECT * FROM jobs WHERE kind='shipping.tracking' AND payload->>'channel_id'=$1 AND state='pending' ORDER BY created_at,id",
    [ch],
  );
}
async function run(id: string, catchError = true) {
  const j = (
    await read(
      "UPDATE jobs SET state='running',attempts=attempts+1,locked_at=now(),lease_token=$2 WHERE id=$1 RETURNING *",
      [id, randomUUID()],
    )
  )[0];
  try {
    await processTracking(j, ctx);
  } catch (e) {
    if (!catchError) throw e;
    await failTracking(j, e);
  }
  return j;
}
async function state(id: string) {
  return (await read('SELECT * FROM shipments WHERE id=$1', [id]))[0];
}
test('live GET tracking, physical order delivery and event are applied once without additional stock movements', async () => {
  const ch = await channel(),
    { s, o, p } = await shipment(ch);
  await configure(ch);
  responses.get(s.tracking_number).status = 'delivered';
  responses.get(s.tracking_number).tracking_details[0].status = 'delivered';
  const stock = await read('SELECT on_hand,reserved FROM stock WHERE product_id=$1', [p.id]);
  const [j] = await queue(ch);
  await run(j.id, false);
  assert.equal((await state(s.id)).tracking_data.scope, 'external_api_verified');
  assert.equal((await ok('/orders/' + o.id)).status, 'delivered');
  assert.deepEqual(
    await read('SELECT on_hand,reserved FROM stock WHERE product_id=$1', [p.id]),
    stock,
  );
  assert.equal((await ok('/integrations/' + ch + '/tracking', 'POST')).queued, 0);
  assert.equal(
    (
      await read(
        "SELECT count(*)::int AS n FROM order_events WHERE order_id=$1 AND kind='order.delivered'",
        [o.id],
      )
    )[0].n,
    1,
  );
  assert.equal(calls.length, 1);
  assert(calls.every((x) => x.method === 'GET'));
});
test('opt-out records carrier delivery but retains shipped order', async () => {
  const ch = await channel(),
    { s, o } = await shipment(ch);
  await configure(ch, { mark_delivered: false });
  responses.get(s.tracking_number).status = 'delivered';
  await run((await queue(ch))[0].id);
  assert.equal((await ok('/orders/' + o.id)).status, 'shipped');
  assert.equal((await state(s.id)).status, 'delivered');
});
test('tracking never overwrites return workflow or completed order', async () => {
  for (const status of ['return_initiated', 'completed']) {
    const ch = await channel(),
      { s, o } = await shipment(ch);
    await configure(ch);
    await read('UPDATE orders SET status=$2 WHERE id=$1', [o.id, status]);
    responses.get(s.tracking_number).status = 'delivered';
    await run((await queue(ch))[0].id);
    assert.equal((await ok('/orders/' + o.id)).status, status);
  }
});
test('sandbox, provider/tenant access, viewer and operator configuration gates', async () => {
  const ch = await channel(false, 'sandbox');
  assert.equal(
    (
      await req('/integrations/' + ch + '/tracking', 'PATCH', {
        version: 0,
        enabled: true,
        interval_seconds: 60,
        mark_delivered: false,
        confirm_external: true,
      })
    ).statusCode,
    422,
  );
  for (const auth of [viewer, operator])
    assert.equal(
      (await req('/integrations/' + ch + '/tracking', 'GET', undefined, auth)).statusCode,
      403,
    );
  assert.equal(
    (await req('/integrations/' + ch + '/tracking', 'GET', undefined, other)).statusCode,
    404,
  );
  await configure(ch, { enabled: false });
  assert.equal((await read('SELECT * FROM tracking_configs WHERE channel_id=$1', [ch])).length, 1);
  assert.equal(
    (
      await tenantTx(SECOND_TENANT, (c) =>
        c.query('SELECT * FROM tracking_configs WHERE channel_id=$1', [ch]),
      )
    ).rowCount,
    0,
  );
  const live = await channel();
  assert.equal(
    (
      await req('/integrations/' + live + '/tracking', 'PATCH', {
        version: 0,
        enabled: true,
        interval_seconds: 60,
        mark_delivered: false,
      })
    ).statusCode,
    422,
  );
});
test('config version conflicts and per-shipment dedup under concurrent enqueue', async () => {
  const ch = await channel(),
    { s } = await shipment(ch);
  await configure(ch);
  const r = await Promise.all([queue(ch), queue(ch), queue(ch)]);
  assert(r.every((x) => x.length === 1));
  assert.equal(
    (
      await read(
        "SELECT count(*)::int AS n FROM jobs WHERE kind='shipping.tracking' AND payload->>'shipment_id'=$1 AND state='pending'",
        [s.id],
      )
    )[0].n,
    1,
  );
  assert.equal(
    (
      await req('/integrations/' + ch + '/tracking', 'PATCH', {
        version: 0,
        enabled: false,
        interval_seconds: 60,
        mark_delivered: false,
      })
    ).statusCode,
    409,
  );
});
test('pause before transport fences leased task and makes no external call', async () => {
  const ch = await channel(),
    { s } = await shipment(ch);
  await configure(ch);
  const [j] = await queue(ch);
  await configure(ch, { enabled: false });
  await run(j.id);
  assert.equal(calls.length, 0);
  assert.equal((await state(s.id)).tracking_at, null);
});
test('pause during response discards result and order transition', async () => {
  const ch = await channel(),
    { s, o } = await shipment(ch);
  await configure(ch);
  responses.get(s.tracking_number).status = 'delivered';
  hook = async () => {
    await configure(ch, { enabled: false });
  };
  await run((await queue(ch))[0].id);
  assert.equal(calls.length, 1);
  assert.equal((await state(s.id)).tracking_at, null);
  assert.equal((await ok('/orders/' + o.id)).status, 'shipped');
});
test('role revoked before read prevents calls and scheduler disables unauthorized configuration', async () => {
  const ch = await channel(),
    { s } = await shipment(ch);
  await configure(ch);
  const [j] = await queue(ch);
  await pool.query("UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2", [
    DEMO_TENANT,
    actorId,
  ]);
  try {
    await run(j.id);
    assert.equal(calls.length, 0);
    await read('UPDATE shipments SET tracking_next_at=now() WHERE id=$1', [s.id]);
    await scheduleTrackingDue();
    assert.equal(
      (await read('SELECT enabled FROM tracking_configs WHERE channel_id=$1', [ch]))[0].enabled,
      false,
    );
  } finally {
    await pool.query("UPDATE memberships SET role='admin' WHERE tenant_id=$1 AND user_id=$2", [
      DEMO_TENANT,
      actorId,
    ]);
  }
});
test('connection change before or during GET prevents saving response', async () => {
  for (const during of [false, true]) {
    const ch = await channel(),
      { s } = await shipment(ch);
    await configure(ch);
    const [j] = await queue(ch);
    const change = () =>
      read(
        "UPDATE channels SET settings=jsonb_set(settings,'{organization_id}','\"2\"') WHERE id=$1",
        [ch],
      ).then(() => {});
    if (during) hook = change;
    else await change();
    await run(j.id);
    assert.equal((await state(s.id)).tracking_at, null);
  }
});
test('mismatched number and malformed dates are rejected without poisoning previous data', async () => {
  for (const patch of [
    { tracking_number: 'wrong' },
    { updated_at: 'wrong' },
    { tracking_details: [{ status: 'delivered', datetime: 'wrong' }] },
  ]) {
    const ch = await channel(),
      { s } = await shipment(ch);
    await configure(ch);
    Object.assign(responses.get(s.tracking_number), patch);
    await run((await queue(ch))[0].id);
    assert.equal((await state(s.id)).tracking_at, null);
    assert.match((await state(s.id)).tracking_error, /Nieprawidłowy tracking/);
  }
});
test('transient provider failure retries the same GET job and clears safe error on success', async () => {
  const ch = await channel(),
    { s } = await shipment(ch);
  await configure(ch);
  const [j] = await queue(ch);
  failure = 503;
  await run(j.id);
  assert.equal((await read('SELECT state FROM jobs WHERE id=$1', [j.id]))[0].state, 'pending');
  assert(!JSON.stringify(await state(s.id)).includes('DO_NOT_EXPOSE'));
  failure = 0;
  await run(j.id);
  assert.equal((await state(s.id)).tracking_error, null);
  assert.equal((await read('SELECT state FROM jobs WHERE id=$1', [j.id]))[0].state, 'done');
});
test('last failure is visible and next scheduled cycle can retry later', async () => {
  const ch = await channel(),
    { s } = await shipment(ch);
  await configure(ch);
  const [j] = await queue(ch);
  await read('UPDATE jobs SET attempts=max_attempts-1 WHERE id=$1', [j.id]);
  failure = 400;
  await run(j.id);
  assert.equal((await read('SELECT state FROM jobs WHERE id=$1', [j.id]))[0].state, 'failed');
  assert((await state(s.id)).tracking_error);
  assert.equal((await ok('/integrations/' + ch + '/tracking')).stats.errors, 1);
  failure = 0;
  const [next] = await queue(ch);
  assert.notEqual(next.id, j.id);
  await run(next.id);
  assert.equal((await state(s.id)).tracking_error, null);
});
test('scheduler excludes undispatched, terminal and expired shipments', async () => {
  const ch = await channel();
  await configure(ch);
  const a = await shipment(ch),
    b = await shipment(ch),
    c = await shipment(ch),
    d = await shipment(ch);
  await rewriteRows('UPDATE shipments SET dispatched_at=NULL WHERE id=$1', [a.s.id]);
  await read(
    "UPDATE shipments SET tracking_data='{" + '"status":"returned_to_sender"' + "}' WHERE id=$1",
    [b.s.id],
  );
  await read("UPDATE shipments SET created_at=now()-interval '46 days' WHERE id=$1", [c.s.id]);
  await scheduleTrackingDue();
  const jobs = await read(
    "SELECT payload->>'shipment_id' AS sid FROM jobs WHERE kind='shipping.tracking' AND payload->>'channel_id'=$1",
    [ch],
  );
  assert.deepEqual(
    jobs.map((x) => x.sid),
    [d.s.id],
  );
});
test('provider creation window older than local creation is respected after first read', async () => {
  const ch = await channel(),
    { s } = await shipment(ch);
  await configure(ch);
  responses.get(s.tracking_number).created_at = new Date(Date.now() - 46 * 86400000).toISOString();
  await run((await queue(ch))[0].id);
  assert.equal((await ok('/integrations/' + ch + '/tracking', 'POST')).queued, 0);
  assert.equal((await ok('/integrations/' + ch + '/tracking')).data[0].expired, true);
});
test('manual read wins concurrent automatic result, old provider data cannot regress terminal status', async () => {
  const ch = await channel(),
    { s } = await shipment(ch);
  await configure(ch);
  const [j] = await queue(ch);
  const old = { ...responses.get(s.tracking_number) };
  hook = async () => {
    responses.set(s.tracking_number, {
      ...old,
      status: 'delivered',
      updated_at: new Date(Date.now() + 1000).toISOString(),
    });
    await ok('/shipments/' + s.id + '/tracking', 'POST', {});
    responses.set(s.tracking_number, old);
  };
  await run(j.id);
  assert.equal((await state(s.id)).status, 'delivered');
  const r = await ok('/shipments/' + s.id + '/tracking', 'POST', {});
  assert.equal(r.applied, false);
  assert.equal((await state(s.id)).status, 'delivered');
});
test('DEMO automatic transport has no network and explicit simulator delivery drives configured order change', async () => {
  const ch = await channel(true, 'sandbox'),
    { s, o } = await shipment(ch);
  await configure(ch);
  await ok('/shipments/' + s.id + '/tracking-example', 'POST', { status: 'out_for_delivery' });
  await run((await queue(ch))[0].id);
  assert.equal((await state(s.id)).tracking_data.scope, 'local_simulation');
  assert.equal((await ok('/orders/' + o.id)).status, 'shipped');
  await ok('/shipments/' + s.id + '/tracking-example', 'POST', { status: 'delivered' });
  await run((await queue(ch))[0].id);
  assert.equal((await ok('/orders/' + o.id)).status, 'delivered');
  assert.equal(calls.length, 0);
  assert.equal(
    (await req('/shipments/' + s.id + '/tracking-example', 'POST', { status: 'confirmed' }))
      .statusCode,
    409,
  );
});
test('live simulator request is refused and does not mutate carrier/local state', async () => {
  const ch = await channel(),
    { s } = await shipment(ch);
  await configure(ch);
  assert.equal(
    (await req('/shipments/' + s.id + '/tracking-example', 'POST', { status: 'delivered' }))
      .statusCode,
    422,
  );
  assert.equal((await state(s.id)).tracking_demo_status, null);
});
async function cloneShipments(ch: string, base: any, count: number) {
  // Pagination-only synthetic records; normal tracking cases above exercise the OMS flow.
  for (let n = 1; n < count; n++) {
    const oid = randomUUID(),
      sid = randomUUID();
    await read(
      `INSERT INTO orders(id,tenant_id,number,customer_name,email,address,currency,status,total,warehouse_id,portal_token)
      SELECT $2,tenant_id,$3,customer_name,email,address,currency,'shipped',total,warehouse_id,$4 FROM orders WHERE id=$1`,
      [base.o.id, oid, 'TRACK-PAGE-' + oid, randomUUID() + randomUUID()],
    );
    await rewriteRows(
      `INSERT INTO shipments(id,tenant_id,order_id,carrier,tracking_number,mode,status,channel_id,dispatched_at)
      VALUES($1,$2,$3,'InPost fixture',$4,'live','confirmed',$5,now())`,
      [sid, DEMO_TENANT, oid, 'TRACK-' + sid, ch],
    );
  }
}
test('batch limit and UUID pagination cover every shipment without duplicate jobs', async () => {
  const ch = await channel();
  await configure(ch);
  const base = await shipment(ch);
  await cloneShipments(ch, base, TRACKING_BATCH + 3);
  await scheduleTrackingDue();
  assert.equal(
    (
      await read(
        "SELECT count(*)::int AS n FROM jobs WHERE kind='shipping.tracking' AND payload->>'channel_id'=$1",
        [ch],
      )
    )[0].n,
    TRACKING_BATCH,
  );
  await scheduleTrackingDue();
  assert.equal(
    (
      await read(
        "SELECT count(*)::int AS n FROM jobs WHERE kind='shipping.tracking' AND payload->>'channel_id'=$1",
        [ch],
      )
    )[0].n,
    TRACKING_BATCH + 3,
  );
  let after: string | undefined;
  const ids = new Set<string>();
  do {
    const page = await ok(
      '/integrations/' + ch + '/tracking?limit=7' + (after ? '&after=' + after : ''),
    );
    for (const x of page.data) {
      assert(!ids.has(x.id));
      ids.add(x.id);
    }
    after = page.meta.cursor;
  } while (after);
  assert.equal(ids.size, TRACKING_BATCH + 3);
});
test('worker recovers expired lease on GET-only tracking', async () => {
  const ch = await channel(true, 'sandbox'),
    { s } = await shipment(ch);
  await configure(ch);
  const [j] = await queue(ch);
  await read(
    "UPDATE jobs SET state='running',lease_token=$2,locked_at=now()-interval '3 minutes' WHERE id=$1",
    [j.id, randomUUID()],
  );
  // Isolate the selected worker job from other intentionally queued fixture cases.
  await read("UPDATE jobs SET run_at=now()+interval '1 day' WHERE state='pending' AND id<>$1", [
    j.id,
  ]);
  await tick(ctx);
  assert.equal((await state(s.id)).tracking_data.scope, 'local_simulation');
  assert.equal(calls.length, 0);
});

test('GET retry rechecks pause before the second transport attempt', async () => {
  const ch = await channel(),
    { s } = await shipment(ch);
  await configure(ch);
  hook = async () => {
    await configure(ch, { enabled: false });
  };
  failure = 503;
  await run((await queue(ch))[0].id);
  assert.equal(calls.length, 1);
  assert.equal((await state(s.id)).tracking_at, null);
});
test('replaced lease during GET fences the old result and does not clobber replacement job', async () => {
  const ch = await channel(),
    { s } = await shipment(ch);
  await configure(ch);
  const [j] = await queue(ch);
  const replacement = randomUUID();
  hook = async () => {
    await read('UPDATE jobs SET lease_token=$2 WHERE id=$1', [j.id, replacement]);
  };
  await run(j.id);
  assert.equal((await state(s.id)).tracking_at, null);
  const saved = (await read('SELECT state,lease_token FROM jobs WHERE id=$1', [j.id]))[0];
  assert.equal(saved.state, 'running');
  assert.equal(saved.lease_token, replacement);
});
test('revoked administrator during GET prevents carrier result and order delivery', async () => {
  const ch = await channel(),
    { s, o } = await shipment(ch);
  await configure(ch);
  responses.get(s.tracking_number).status = 'delivered';
  hook = async () => {
    await pool.query("UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2", [
      DEMO_TENANT,
      actorId,
    ]);
  };
  try {
    await run((await queue(ch))[0].id);
    assert.equal((await state(s.id)).tracking_at, null);
    assert.equal(
      (await read('SELECT status FROM orders WHERE id=$1', [o.id]))[0].status,
      'shipped',
    );
  } finally {
    await pool.query("UPDATE memberships SET role='admin' WHERE tenant_id=$1 AND user_id=$2", [
      DEMO_TENANT,
      actorId,
    ]);
  }
});

test('per-channel backlog is bounded and saturated channel yields scheduler capacity', async () => {
  const ch = await channel(),
    base = await shipment(ch);
  await configure(ch);
  await cloneShipments(ch, base, TRACKING_BACKLOG + 3);
  for (let n = 0; n < 6; n++) await ok('/integrations/' + ch + '/tracking', 'POST');
  assert.equal(
    (
      await read(
        "SELECT count(*)::int AS n FROM jobs WHERE kind='shipping.tracking' AND payload->>'channel_id'=$1 AND state='pending'",
        [ch],
      )
    )[0].n,
    TRACKING_BACKLOG,
  );
  const next = await channel();
  const second = await shipment(next);
  await configure(next);
  await scheduleTrackingDue();
  assert.equal(
    (
      await read(
        "SELECT count(*)::int AS n FROM jobs WHERE kind='shipping.tracking' AND payload->>'shipment_id'=$1",
        [second.s.id],
      )
    )[0].n,
    1,
  );
});

test('carrier result, delivery and job checkpoint commit atomically before caller continuation', async () => {
  const ch = await channel(),
    { s, o } = await shipment(ch);
  await configure(ch);
  responses.get(s.tracking_number).status = 'delivered';
  const [j] = await queue(ch);
  const leased = (
    await read(
      "UPDATE jobs SET state='running',attempts=attempts+1,lease_token=$2,locked_at=now() WHERE id=$1 RETURNING *",
      [j.id, randomUUID()],
    )
  )[0];
  await readShipmentTracking(
    { tenantId: DEMO_TENANT, userId: actorId, role: 'admin' },
    s.id,
    ctx,
    undefined,
    leased,
  );
  assert.equal((await read('SELECT state FROM jobs WHERE id=$1', [j.id]))[0].state, 'done');
  await failTracking(leased, new Error('Lost caller after committed checkpoint'));
  assert.equal((await state(s.id)).tracking_error, null);
  assert.equal((await ok('/orders/' + o.id)).status, 'delivered');
});
test('manual terminal result before queued automatic task completes job without read or false error', async () => {
  const ch = await channel(),
    { s } = await shipment(ch);
  await configure(ch);
  const [j] = await queue(ch);
  responses.get(s.tracking_number).status = 'delivered';
  await ok('/shipments/' + s.id + '/tracking', 'POST', {});
  calls.length = 0;
  await run(j.id);
  assert.equal(calls.length, 0);
  assert.equal((await state(s.id)).tracking_error, null);
  assert.equal((await read('SELECT state FROM jobs WHERE id=$1', [j.id]))[0].state, 'done');
});
test('tracking window expiring while queued finishes job without provider request', async () => {
  const ch = await channel(),
    { s } = await shipment(ch);
  await configure(ch);
  const [j] = await queue(ch);
  await read("UPDATE shipments SET created_at=now()-interval '46 days' WHERE id=$1", [s.id]);
  await run(j.id);
  assert.equal(calls.length, 0);
  assert.equal((await state(s.id)).tracking_error, null);
  assert.equal((await read('SELECT state FROM jobs WHERE id=$1', [j.id]))[0].state, 'done');
});
