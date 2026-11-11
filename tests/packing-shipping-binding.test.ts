import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { buildApp } from '../server/app';
import { migrate, pool, tenantTx } from '../server/db';
import { seed } from './fixtures';
import { legacySerialOrderStatusPayload } from './order-status-cas-helper';
import { encrypt } from '../server/security';
import { Problem } from '../server/errors';
import { processShipping, failShipping } from '../server/shipping';
import { processDpd } from '../server/dpd-shipping';

assert.equal(process.env.DYNA_TEST, 'true');
const db = new URL(process.env.DATABASE_URL ?? '');
assert(['localhost', '127.0.0.1', '[::1]'].includes(db.hostname));
assert.match(db.pathname, /^\/dynaminds_test_\d+$/);
type Carrier = 'inpost' | 'dpd';
let app: Awaited<ReturnType<typeof buildApp>>,
  cookie = '',
  tenant = '',
  warehouse = '',
  user = '',
  ip = 1,
  next = 110000,
  loseResponse = false;
const calls: { carrier: Carrier; operation: string; method: string; body: any }[] = [];
const shipx = new Map<string, any>(),
  dpd = new Map<string, string>();
const measurements = { weight_grams: 1370, length_mm: 380, width_mm: 200, height_mm: 100 };
const pdf = Buffer.from('%PDF-1.4\ncontrolled-packing-binding').toString('base64');
const json = (body: any, status = 200) => new Response(JSON.stringify(body), { status });
// Entirely controlled HTTP. No transport delegates to fetch or any real account.
const transport = async (url: string, init: RequestInit) => {
  const u = new URL(url),
    method = init.method ?? 'GET',
    body = init.body ? JSON.parse(String(init.body)) : null;
  const operation = u.pathname.split('/').at(-1)!;
  if (['postalCode', 'generatePackagesNumbers', 'generateSpedLabels'].includes(operation)) {
    calls.push({ carrier: 'dpd', operation, method, body });
    if (operation === 'postalCode') return json({ status: 'OK', traceId: randomUUID() });
    if (operation === 'generatePackagesNumbers') {
      assert.equal(method, 'POST');
      const reference = body.packages[0].reference,
        waybill = '00008891' + String(next++) + 'Q';
      dpd.set(reference, waybill);
      if (loseResponse) {
        loseResponse = false;
        throw new Problem(502, 'Controlled lost DPD create response');
      }
      return json({
        status: 'OK',
        sessionId: next++,
        packages: [{ status: 'OK', reference, parcels: [{ status: 'OK', reference, waybill }] }],
      });
    }
    const reference = body.labelSearchParams.session.packages[0].parcels[0].reference;
    assert(dpd.has(reference), 'Readback must identify the exact created reference');
    return json({
      status: 'OK',
      documentData: pdf,
      traceId: randomUUID(),
      session: {
        statusInfo: { status: 'OK' },
        packages: [
          {
            statusInfo: { status: 'OK' },
            parcels: [{ statusInfo: { status: 'OK' }, reference, waybill: dpd.get(reference) }],
          },
        ],
      },
    });
  }
  assert(
    u.pathname.includes('/organizations/') || u.pathname.includes('/shipments/'),
    'Unexpected provider path',
  );
  calls.push({
    carrier: 'inpost',
    operation: u.pathname.includes('/organizations/') ? 'organization' : 'shipment',
    method,
    body,
  });
  if (u.pathname.includes('/organizations/')) {
    if (method === 'GET') return json({ items: [...shipx.values()], count: shipx.size });
    assert.equal(method, 'POST');
    assert.equal(body.only_choice_of_offer, true);
    const id = String(next++),
      r = {
        ...body,
        id,
        status: 'offers_prepared',
        tracking_number: null,
        cod: body.cod ?? null,
        insurance: body.insurance ?? null,
        selected_offer: null,
        offers: [
          {
            id: next++,
            service: {
              id: body.parcels[0].template ? 'inpost_locker_standard' : 'inpost_courier_standard',
            },
            status: 'available',
            rate: '12.99',
            currency: 'PLN',
            expires_at: new Date(Date.now() + 300000).toISOString(),
          },
        ],
      };
    shipx.set(id, r);
    if (loseResponse) {
      loseResponse = false;
      throw new Problem(502, 'Controlled lost InPost create response');
    }
    return json({ ...r, offers: [] }, 201);
  }
  assert.equal(method, 'GET', 'Readback must not mutate an existing remote shipment');
  const r = shipx.get(u.pathname.split('/').at(-1)!);
  return r ? json(r) : json({}, 404);
};
const req = (path: string, method: any = 'GET', payload?: any, lease?: string) =>
  app.inject({
    url: '/api' + path,
    method,
    payload,
    headers: { cookie, ...(lease ? { 'x-packing-lease': lease } : {}) },
    remoteAddress: '127.1.110.' + ip,
  });
async function ok(path: string, method: any = 'GET', payload?: any, lease?: string) {
  const r = await req(path, method, payload, lease);
  assert(r.statusCode >= 200 && r.statusCode < 300, `${method} ${path}: HTTP ${r.statusCode}`);
  return r.json() as any;
}
before(async () => {
  await migrate();
  await seed();
  app = await buildApp({ integrationTransport: transport });
  const r = await req('/auth/login', 'POST', {
    email: 'admin@demo.local',
    password: 'DynaDemo!2026',
  });
  assert.equal(r.statusCode, 200);
  cookie = String(r.headers['set-cookie']).split(';')[0];
  user = (await pool.query("SELECT id FROM users WHERE email='admin@demo.local'")).rows[0].id;
});
beforeEach(async () => {
  ++ip;
  calls.length = 0;
  shipx.clear();
  dpd.clear();
  loseResponse = false;
  tenant = randomUUID();
  warehouse = randomUUID();
  await pool.query("INSERT INTO tenants(id,name,plan) VALUES($1,'Packing binding','enterprise')", [
    tenant,
  ]);
  await pool.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'admin')", [
    tenant,
    user,
  ]);
  const r = await req('/workspaces/switch', 'POST', { tenant_id: tenant });
  assert.equal(r.statusCode, 200);
  cookie = String(r.headers['set-cookie']).split(';')[0];
  await pool.query(
    "INSERT INTO warehouses(id,tenant_id,name,code) VALUES($1,$2,'Binding','BIND')",
    [warehouse, tenant],
  );
});
after(async () => {
  try {
    await app?.close();
  } finally {
    await pool.end();
  }
});

async function packed(bound = true, measured = measurements) {
  const product = await ok('/products', 'POST', {
    sku: 'PACK-BIND-' + randomUUID(),
    name: 'Parcel contents',
    price: 2500,
    quantity: 10,
    warehouse_id: warehouse,
  });
  const o = await ok('/orders', 'POST', {
    customer_name: 'Binding recipient',
    payment_mode: 'cod',
    email: 'binding@example.test',
    warehouse_id: warehouse,
    items: [{ product_id: product.id, quantity: 1 }],
  });
  await ok('/orders/' + o.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => ok(orderPath), '/orders/' + o.id + '/status', { status: 'picking' }));
  let receipt: any;
  if (bound) {
    const station = (
      await ok('/packing/stations', 'POST', {
        client_key: randomUUID(),
        code: 'B-' + randomUUID().slice(0, 8),
        label: 'Binding station',
        enabled: true,
      })
    ).station;
    const token = randomUUID(),
      current = await ok('/orders/' + o.id);
    let session = (
      await ok('/packing/sessions', 'POST', {
        client_key: randomUUID(),
        order_id: o.id,
        order_version: String(current.version),
        station_id: station.id,
        station_version: String(station.version),
        lease_token: token,
      })
    ).session;
    await ok(
      '/packing/sessions/' + session.id + '/scans',
      'POST',
      {
        client_key: randomUUID(),
        session_version: String(session.version),
        order_version: String(current.version),
        code: product.sku,
      },
      token,
    );
    session = (await ok('/packing/sessions/' + session.id)).session;
    const p = (
      await ok(
        '/packing/previews',
        'POST',
        {
          client_key: randomUUID(),
          kind: 'finish',
          session_id: session.id,
          session_version: String(session.version),
          order_version: String(current.version),
          station_version: String(station.version),
          packaging: {
            kind: 'custom',
            label: 'Measured box',
            reason: 'Operator measured a complete parcel',
          },
          measurements: measured,
          include_product_estimate: false,
        },
        token,
      )
    ).preview;
    assert.equal(p.ready, true);
    receipt = (
      await ok(
        '/packing/previews/' + p.id + '/finish',
        'POST',
        {
          client_key: randomUUID(),
          scope_hash: p.scope_hash,
          confirmed: true,
          confirm_measured: true,
        },
        token,
      )
    ).receipt;
  } else {
    await ok('/orders/' + o.id + '/scan', 'POST', { code: product.sku });
    await ok('/orders/' + o.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => ok(orderPath), '/orders/' + o.id + '/status', { status: 'packed' }));
  }
  return { product, order: await ok('/orders/' + o.id), receipt };
}
async function channel(carrier: Carrier) {
  const id = randomUUID();
  await tenantTx(tenant, (c) =>
    c.query(
      `INSERT INTO channels(id,tenant_id,provider,name,mode,credentials,settings)
    VALUES($1,$2,$3,'Controlled packing provider','sandbox',$4,$5)`,
      [
        id,
        tenant,
        carrier,
        encrypt(
          carrier === 'inpost'
            ? { access_token: 'fixture' }
            : { username: 'fixture', password: 'fixture-password' },
        ),
        JSON.stringify(
          carrier === 'inpost'
            ? { organization_id: '1', simulation: false }
            : { master_fid: '1495', simulation: false },
        ),
      ],
    ),
  );
  return id;
}
const party = {
  name: 'Packing recipient',
  address: 'Testowa 1',
  city: 'Warszawa',
  postalCode: '01-354',
  countryCode: 'PL',
  phone: '500600700',
  email: 'binding@example.test',
};
function input(carrier: Carrier, ch: string, receipt?: any) {
  const common = {
    channel_id: ch,
    weight: 1.37,
    cod: 2500,
    insurance: 2500,
    ...(receipt
      ? {
          packing: {
            receipt_id: receipt.id,
            scope_hash: receipt.scope_hash,
            profile_revision: String(receipt.profile_revision),
          },
        }
      : {}),
  };
  return carrier === 'dpd'
    ? {
        ...common,
        sender: party,
        receiver: party,
        content: 'Parcel contents',
        dimensions: { length: 38, width: 20, height: 10 },
      }
    : {
        ...common,
        service: 'inpost_courier_standard',
        receiver: {
          first_name: 'Packing',
          last_name: 'Recipient',
          email: party.email,
          phone: party.phone,
          address: {
            street: 'Testowa',
            building_number: '1',
            city: 'Warszawa',
            post_code: '01-354',
            country_code: 'PL',
          },
        },
        dimensions: { length: 380, width: 200, height: 100 },
      };
}
const previewPath = (carrier: Carrier, order: string) =>
  '/orders/' + order + (carrier === 'dpd' ? '/dpd-shipping/preview' : '/shipping/preview');
const queuePath = (carrier: Carrier, id: string) =>
  carrier === 'dpd' ? '/dpd-shipping/' + id + '/queue' : '/shipping-plans/' + id + '/queue';
const queueBody = (carrier: Carrier) =>
  carrier === 'dpd' ? { confirm_external: true, ack_contract_rate: true } : {};
const reconcilePath = (carrier: Carrier, id: string) =>
  carrier === 'dpd' ? '/dpd-shipping/' + id + '/reconcile' : '/shipping-plans/' + id + '/reconcile';
async function plan(id: string) {
  return (
    await pool.query('SELECT * FROM shipping_plans WHERE id=$1 AND tenant_id=$2', [id, tenant])
  ).rows[0];
}
async function setup(carrier: Carrier, bound = true) {
  const f = await packed(bound),
    ch = await channel(carrier),
    body = input(carrier, ch, f.receipt);
  const p = await ok(previewPath(carrier, f.order.id), 'POST', body);
  const q = await ok(queuePath(carrier, p.id), 'POST', queueBody(carrier));
  return { ...f, ch, body, p, q };
}
async function claim(id: string) {
  const j = (
    await pool.query(
      `UPDATE jobs SET state='running',lease_token=$2,attempts=attempts+1,
    locked_at=now() WHERE id=$1 AND tenant_id=$3 AND state='pending' RETURNING *`,
      [id, randomUUID(), tenant],
    )
  ).rows[0];
  assert(j, 'Expected owned pending shipping job');
  return j;
}
async function run(carrier: Carrier, job: any) {
  try {
    await (carrier === 'dpd'
      ? processDpd(job, { transport })
      : processShipping(job, { transport }));
    return null;
  } catch (error) {
    await failShipping(job, error);
    return error;
  }
}
const creates = (carrier: Carrier) =>
  calls.filter(
    (c) =>
      c.carrier === carrier &&
      (carrier === 'dpd'
        ? c.operation === 'generatePackagesNumbers'
        : c.operation === 'organization' && c.method === 'POST'),
  );
async function evidence() {
  const result: Record<string, unknown> = {};
  for (const table of [
    'orders',
    'order_items',
    'order_pick_items',
    'stock',
    'stock_locations',
    'reservations',
    'reservation_locations',
    'payment_entries',
    'packing_receipts',
    'order_packing_profiles',
  ])
    result[table] = (
      await pool.query(`SELECT to_jsonb(t) row FROM ${table} t WHERE tenant_id=$1 ORDER BY 1`, [
        tenant,
      ])
    ).rows;
  return result;
}
async function waitOrder(c: PoolClient) {
  // The worker reaches the order lock only after tenantTx's schema preflight (server/db.ts, up to 120 s),
  // which takes longer than 3 s on a fresh test database; the loop still returns as soon as it waits.
  const pid = (await c.query('SELECT pg_backend_pid() pid')).rows[0].pid,
    end = Date.now() + 120_000;
  while (Date.now() < end) {
    const rows = (
      await pool.query(
        `SELECT query FROM pg_stat_activity WHERE datname=current_database()
      AND wait_event_type='Lock' AND $1=ANY(pg_blocking_pids(pid))`,
        [pid],
      )
    ).rows;
    if (rows.some((r) => /orders/i.test(r.query))) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('Actual carrier worker never waited on the held order lock');
}
async function changeGrant(sql: string, args: unknown[]) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query("SET LOCAL statement_timeout='1500ms'");
    await c.query(sql, args);
    await c.query('COMMIT');
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
}

test('bound courier and DPD create exact projected units while preserving the complete legacy order snapshot', async () => {
  for (const carrier of ['inpost', 'dpd'] as const) {
    const f = await setup(carrier),
      stored = await plan(f.p.id);
    assert.deepEqual(stored.order_snapshot, {
      status: f.order.status,
      updated_at: new Date(f.order.updated_at).toISOString(),
      total: f.order.total,
      currency: f.order.currency,
      warehouse_id: f.order.warehouse_id,
      address: f.order.address,
      email: f.order.email,
      customer_name: f.order.customer_name,
    });
    assert.deepEqual(stored.input.packing_snapshot.measurements, measurements);
    const before = await evidence();
    assert.equal(await run(carrier, await claim(f.q.job_id)), null);
    assert.equal(
      creates(carrier).filter((c) =>
        carrier === 'inpost'
          ? c.body.reference === stored.payload.reference
          : c.body.packages[0].reference === stored.payload.packages[0].reference,
      ).length,
      1,
    );
    const created = creates(carrier).at(-1)!.body;
    if (carrier === 'inpost')
      assert.deepEqual(created.parcels[0], {
        dimensions: { length: 380, width: 200, height: 100, unit: 'mm' },
        weight: { amount: 1.37, unit: 'kg' },
        is_non_standard: false,
      });
    else {
      const parcel = created.packages[0].parcels[0];
      assert.equal(parcel.weight, 1.37);
      assert.equal(parcel.sizeX, 38);
      assert.equal(parcel.sizeY, 20);
      assert.equal(parcel.sizeZ, 10);
    }
    assert.deepEqual(await evidence(), before);
  }
});
test('stale packing after queue blocks the first carrier read or create with zero HTTP and no physical effects', async () => {
  for (const carrier of ['inpost', 'dpd'] as const) {
    const f = await setup(carrier);
    await ok('/orders/' + f.order.id + '/operations', 'POST', {
      type: 'add_note',
      note: 'Stale profile before first create',
    });
    const before = await evidence(),
      count = calls.length,
      frozen = await plan(f.p.id);
    const error = await run(carrier, await claim(f.q.job_id));
    assert(error instanceof Problem && error.status === 409);
    assert.equal(calls.length, count);
    assert.deepEqual(await evidence(), before);
    const after = await plan(f.p.id);
    assert.equal(after.phase, 'ready');
    assert.deepEqual(after.payload, frozen.payload);
    assert.deepEqual(after.input, frozen.input);
  }
});
test(
  'a real worker order wait permits committed role or API-key withdrawal and denies first create',
  // Hang guard only: every wait inside is bounded (waitOrder 3 s, lock/statement timeouts 8 s). Four
  // packed orders with their carrier plans take minutes on a fresh test database (10.11: the other
  // tests in this file ran 6-19 min each), so 30 s cut the test off half-way.
  { timeout: 30 * 60_000 },
  async () => {
    for (const carrier of ['inpost', 'dpd'] as const)
      for (const mode of ['role', 'key']) {
        await pool.query("UPDATE memberships SET role='admin' WHERE tenant_id=$1 AND user_id=$2", [
          tenant,
          user,
        ]);
        const f = await packed(),
          ch = await channel(carrier);
        let queued: any, key: any;
        if (mode === 'key') {
          key = await ok('/developer/keys', 'POST', {
            name: 'Bound carrier late key',
            scopes: ['orders:read', 'orders:write'],
          });
          const headers = { authorization: 'Bearer ' + key.token };
          const p = await app.inject({
            url: '/api/v1' + previewPath(carrier, f.order.id),
            method: 'POST',
            payload: input(carrier, ch, f.receipt),
            headers,
          });
          assert.equal(p.statusCode, 200);
          const q = await app.inject({
            url: '/api/v1' + queuePath(carrier, p.json().id),
            method: 'POST',
            payload: queueBody(carrier),
            headers,
          });
          assert.equal(q.statusCode, 200);
          queued = q.json();
        } else {
          const p = await ok(
            previewPath(carrier, f.order.id),
            'POST',
            input(carrier, ch, f.receipt),
          );
          queued = await ok(queuePath(carrier, p.id), 'POST', queueBody(carrier));
        }
        const job = await claim(queued.job_id),
          before = await evidence(),
          count = calls.length,
          c = await pool.connect();
        let pending: ReturnType<typeof run> | undefined;
        try {
          await c.query('BEGIN');
          await c.query('SELECT id FROM orders WHERE id=$1 FOR UPDATE', [f.order.id]);
          pending = run(carrier, job);
          await waitOrder(c);
          await changeGrant(
            mode === 'role'
              ? "UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2"
              : 'UPDATE api_keys SET revoked_at=now() WHERE id=$1',
            mode === 'role' ? [tenant, user] : [key.id],
          );
          await c.query('COMMIT');
          const error = await pending;
          assert(error instanceof Problem && error.status === (mode === 'role' ? 403 : 401));
        } finally {
          await c.query('ROLLBACK');
          c.release();
          await pending;
        }
        assert.equal(calls.length, count);
        assert.deepEqual(await evidence(), before);
      }
  },
);
test('lost create is reconciled against its old frozen payload after the measured profile becomes stale, without a second mutation', async () => {
  for (const carrier of ['inpost', 'dpd'] as const) {
    const f = await setup(carrier),
      frozen = await plan(f.p.id),
      start = creates(carrier).length;
    // A controlled last-attempt fixture reaches the established failed-plan reconcile route.
    // The actual worker and failure handler still record the attempted create and its uncertainty.
    await pool.query(
      "UPDATE jobs SET attempts=max_attempts-1 WHERE id=$1 AND tenant_id=$2 AND state='pending'",
      [f.q.job_id, tenant],
    );
    loseResponse = true;
    const error = await run(carrier, await claim(f.q.job_id));
    assert(error instanceof Problem && error.status === 502);
    assert.equal(creates(carrier).length, start + 1);
    assert.equal((await plan(f.p.id)).phase, 'create_started');
    await ok('/orders/' + f.order.id + '/operations', 'POST', {
      type: 'add_note',
      note: 'Order changed after external create',
    });
    assert.equal((await ok('/packing/orders/' + f.order.id + '/profile')).profile.current, false);
    const physical = await evidence(),
      priorCalls = calls.length;
    const reconcile = await ok(reconcilePath(carrier, f.p.id), 'POST', {});
    assert.equal(await run(carrier, await claim(reconcile.job_id)), null);
    assert.equal(creates(carrier).length, start + 1);
    const reads = calls.slice(priorCalls);
    assert(reads.length > 0);
    assert(
      reads.every((c) =>
        carrier === 'inpost' ? c.method === 'GET' : c.operation === 'generateSpedLabels',
      ),
    );
    const after = await plan(f.p.id);
    assert.deepEqual(after.payload, frozen.payload);
    assert.deepEqual(after.input, frozen.input);
    assert.deepEqual(after.order_snapshot, frozen.order_snapshot);
    assert.equal(after.state, carrier === 'dpd' ? 'ready' : 'quoted');
    assert.deepEqual(await evidence(), physical);
  }
});
test('DPD nonrepresentable measurements and a client-supplied packing snapshot are rejected without HTTP or plans', async () => {
  const f = await packed(true, { ...measurements, weight_grams: 1375, length_mm: 382 }),
    ch = await channel('dpd');
  const before = await evidence(),
    count = (
      await pool.query('SELECT count(*)::int n FROM shipping_plans WHERE tenant_id=$1', [tenant])
    ).rows[0].n;
  const r = await req(previewPath('dpd', f.order.id), 'POST', input('dpd', ch, f.receipt));
  assert.equal(r.statusCode, 422);
  const valid = await packed(),
    inpost = await channel('inpost');
  const spoof = await req(previewPath('inpost', valid.order.id), 'POST', {
    ...input('inpost', inpost, valid.receipt),
    packing_snapshot: {
      receipt_id: randomUUID(),
      measurements,
      after_fulfillment_hash: 'a'.repeat(64),
    },
  });
  assert.equal(spoof.statusCode, 422);
  assert.equal(calls.length, 0);
  assert.equal(
    (await pool.query('SELECT count(*)::int n FROM shipping_plans WHERE tenant_id=$1', [tenant]))
      .rows[0].n,
    count,
  );
  // The refusal did not rewrite the original parcel's historical measurement.
  const after = await evidence();
  assert.deepEqual(
    (after.packing_receipts as any[]).filter((r) => r.row.order_id === f.order.id),
    (before.packing_receipts as any[]).filter((r) => r.row.order_id === f.order.id),
  );
});
test('legacy unbound courier and DPD remain usable without adding a nullable packing key or synthetic receipt', async () => {
  for (const carrier of ['inpost', 'dpd'] as const) {
    const f = await setup(carrier, false),
      frozen = await plan(f.p.id),
      before = await evidence();
    assert.equal(Object.hasOwn(frozen.input, 'packing'), false);
    assert.equal(Object.hasOwn(frozen.input, 'packing_snapshot'), false);
    assert.equal(await run(carrier, await claim(f.q.job_id)), null);
    assert.equal(Object.hasOwn((await plan(f.p.id)).input, 'packing_snapshot'), false);
    assert.deepEqual(await evidence(), before);
  }
});
test('actual provider payload tampering is rejected at queue and first worker create despite unchanged packing input', async () => {
  for (const carrier of ['inpost', 'dpd'] as const)
    for (const mutation of ['weight', 'dimensions', 'extra-parcel'] as const) {
      const f = await packed(),
        ch = await channel(carrier);
      const preview = await ok(
        previewPath(carrier, f.order.id),
        'POST',
        input(carrier, ch, f.receipt),
      );
      // Cardinality tampering occurs after actual queue acceptance. Weight/unit tampering
      // occurs before queue, so both independent first-write gates are exercised.
      const queued =
        mutation === 'extra-parcel'
          ? await ok(queuePath(carrier, preview.id), 'POST', queueBody(carrier))
          : null;
      const original = await plan(preview.id),
        payload = structuredClone(original.payload);
      const parcel = carrier === 'inpost' ? payload.parcels[0] : payload.packages[0].parcels[0];
      if (mutation === 'weight') {
        if (carrier === 'inpost') parcel.weight.amount += 0.01;
        else parcel.weight += 0.01;
      } else if (mutation === 'dimensions') {
        if (carrier === 'inpost') parcel.dimensions.unit = 'cm';
        else parcel.sizeX += 1;
      } else if (carrier === 'inpost') payload.parcels.push(structuredClone(parcel));
      else payload.packages[0].parcels.push(structuredClone(parcel));
      await pool.query('UPDATE shipping_plans SET payload=$3::jsonb WHERE id=$1 AND tenant_id=$2', [
        preview.id,
        tenant,
        JSON.stringify(payload),
      ]);
      const forged = await plan(preview.id),
        before = await evidence(),
        priorCalls = calls.length;
      assert.deepEqual(forged.input, original.input);
      assert.deepEqual(forged.order_snapshot, original.order_snapshot);
      assert.notDeepEqual(forged.payload, original.payload);
      if (queued) {
        const error = await run(carrier, await claim(queued.job_id));
        assert(error instanceof Problem && error.status === 409);
        assert.equal((await plan(preview.id)).phase, 'ready');
      } else {
        const localBefore = (
          await pool.query(
            `SELECT 'jobs' AS kind,to_jsonb(j) AS row FROM jobs j WHERE tenant_id=$1
          UNION ALL SELECT 'audit',to_jsonb(a) FROM audit_events a WHERE tenant_id=$1 ORDER BY 1,2`,
            [tenant],
          )
        ).rows;
        assert.equal(
          (await req(queuePath(carrier, preview.id), 'POST', queueBody(carrier))).statusCode,
          409,
        );
        assert.deepEqual(await plan(preview.id), forged);
        assert.deepEqual(
          (
            await pool.query(
              `SELECT 'jobs' AS kind,to_jsonb(j) AS row FROM jobs j WHERE tenant_id=$1
          UNION ALL SELECT 'audit',to_jsonb(a) FROM audit_events a WHERE tenant_id=$1 ORDER BY 1,2`,
              [tenant],
            )
          ).rows,
          localBefore,
        );
      }
      assert.equal(
        calls.length,
        priorCalls,
        'No HTTP may receive a parcel that disagrees with the receipt',
      );
      assert.deepEqual(await evidence(), before);
      const final = await plan(preview.id);
      assert.deepEqual(final.payload, payload);
      assert.deepEqual(final.input, original.input);
      assert.deepEqual(final.order_snapshot, original.order_snapshot);
    }
});
