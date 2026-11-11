import { legacySerialOrderStatusPayload } from './order-status-cas-helper';
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../server/app';
import { pool, migrate, tenantTx } from '../server/db';
import { seed, DEMO_TENANT, SECOND_TENANT } from './fixtures';
import { encrypt } from '../server/security';
import { demoPrestaOrder } from '../server/prestashop-example';
import { PrestaShop, type Transport } from '../server/integrations';
import { psStatusMapSchema } from '../server/prestashop-status';
import {
  processStatusWrite,
  failStatusJob,
  processStatusScan,
  scheduleStatusesDue,
} from '../server/order-status';
assert.equal(process.env.DYNA_TEST, 'true');
const mappings = {
  paid: '2',
  picking: '2',
  packed: '3',
  shipped: '4',
  delivered: '5',
  completed: '5',
  cancelled: '6',
};
const states = new Map<string, any>();
const store = new Map<string, any>();
const calls: { url: URL; method: string; body: string; headers: Headers }[] = [];
let lose = false,
  noApply = false,
  denied = false,
  readFail = false,
  getHook: (() => Promise<void>) | undefined;
const json = (d: any, status = 200) => new Response(JSON.stringify(d), { status });
const settings = { store_url: 'https://shop.example', shop_id: '1', order_state_ids: '2,3' };
const transport: Transport = async (url, init) => {
  const u = new URL(url),
    method = init.method ?? 'GET',
    resource = u.pathname.split('/').at(-1)!;
  calls.push({ url: u, method, body: String(init.body ?? ''), headers: new Headers(init.headers) });
  assert.equal(u.searchParams.get('id_shop'), '1');
  if (denied) return json({ api_key: 'NEVER_EXPOSE' }, 401);
  if (method === 'POST') {
    assert.equal(resource, 'order_histories');
    assert.equal(u.searchParams.get('sendemail'), '0');
    assert.equal(new Headers(init.headers).get('Content-Type'), 'application/xml');
    const id = String(init.body).match(/<id_order>(\d+)<\/id_order>/)![1],
      state = String(init.body).match(/<id_order_state>(\d+)<\/id_order_state>/)![1],
      o = store.get(id);
    assert(o);
    if (!noApply) {
      o.current_state = state;
      o._dyna.state = structuredClone(states.get(state));
      o.date_upd = String(Number(o.date_upd) + 1);
    }
    if (lose) {
      lose = false;
      throw Error('lost response');
    }
    return new Response('<prestashop><order_history><id>701</id></order_history></prestashop>', {
      status: 201,
    });
  }
  assert.equal(method, 'GET');
  if (readFail) return json({}, 503);
  let data: any[] = [];
  if (resource === 'orders') {
    data = [...store.values()].map((o) => ({ ...o, _dyna: undefined }));
  } else if (resource === 'order_states') data = [...states.values()];
  else {
    const key: Record<string, string> = {
      customers: 'customer',
      addresses: 'address',
      countries: 'country',
      currencies: 'currency',
      order_details: 'details',
      order_cart_rules: 'cart_rules',
    };
    data = [...store.values()].flatMap((o) => o._dyna[key[resource]] ?? []);
  }
  data = [...new Map(data.map((d) => [d.id, d])).values()];
  for (const field of ['id', 'id_shop', 'id_order']) {
    const f = u.searchParams.get('filter[' + field + ']');
    if (f) data = data.filter((d) => f.slice(1, -1).split('|').includes(String(d[field])));
  }
  if (resource === 'orders') {
    const hook = getHook;
    getHook = undefined;
    await hook?.();
  }
  return json({ [resource]: data });
};
let app: Awaited<ReturnType<typeof buildApp>>,
  cookie: string,
  other: string,
  viewer: string,
  warehouse: string,
  otherWarehouse: string,
  counter = 180000;
const req = (p: string, m: any = 'GET', b?: any, auth = cookie) =>
  app.inject({ url: '/api' + p, method: m, payload: b, headers: { cookie: auth } });
async function ok(p: string, m: any = 'GET', b?: any, auth = cookie) {
  const r = await req(p, m, b, auth);
  assert(r.statusCode < 300, r.body);
  return r.json();
}
before(async () => {
  await migrate();
  await seed();
  app = await buildApp({ integrationTransport: transport });
  for (const [email, set] of [
    ['admin@demo.local', (v: string) => (cookie = v)],
    ['other@demo.local', (v: string) => (other = v)],
    ['viewer@demo.local', (v: string) => (viewer = v)],
  ] as const) {
    const r = await req('/auth/login', 'POST', { email, password: 'DynaDemo!2026' }, '');
    set(r.headers['set-cookie']!.toString().split(';')[0]);
  }
  warehouse = (await ok('/warehouses')).data[0].id;
  otherWarehouse = (await ok('/warehouses', 'GET', undefined, other)).data[0].id;
});
after(async () => {
  await app.close();
  await pool.end();
});
beforeEach(async () => {
  lose = false;
  noApply = false;
  denied = false;
  readFail = false;
  getHook = undefined;
  calls.length = 0;
  store.clear();
  states.clear();
  for (const id of ['2', '3', '4', '5', '6'])
    states.set(id, {
      id,
      paid: id === '6' ? '0' : '1',
      shipped: ['4', '5'].includes(id) ? '1' : '0',
      delivery: id === '5' ? '1' : '0',
      deleted: '0',
    });
  await pool.query('UPDATE order_status_configs SET enabled=false');
});
async function fixture(
  auth = cookie,
  remoteId = String(++counter),
  map: any = mappings,
  cod = false,
) {
  const tenant = auth === other ? SECOND_TENANT : DEMO_TENANT,
    wh = auth === other ? otherWarehouse : warehouse,
    ch = randomUUID();
  const raw: any = structuredClone(demoPrestaOrder);
  raw.id = remoteId;
  raw.date_upd = '1';
  if (cod) {
    raw.module = 'ps_cashondelivery';
    raw.total_paid_real = '0.000000';
    raw._dyna.state.paid = '0';
  }
  raw._dyna.details[0].id_order = raw.id;
  raw._dyna.cart_rules[0].id_order = raw.id;
  raw._dyna.details[0].id = String(Number(raw.id) * 10 + 1);
  raw.associations.order_rows[0].id = raw._dyna.details[0].id;
  raw._dyna.cart_rules[0].id = String(Number(raw.id) * 10 + 2);
  const original = store.get(remoteId);
  if (!original) store.set(remoteId, raw);
  await tenantTx(tenant, (c) =>
    c.query(
      "INSERT INTO channels(id,tenant_id,provider,name,mode,credentials,settings) VALUES($1,$2,'prestashop','QA status Presta','sandbox',$3,$4)",
      [
        ch,
        tenant,
        encrypt({ api_key: 'A'.repeat(32) }),
        JSON.stringify({ ...settings, ...(map ? { status_mappings: map } : {}) }),
      ],
    ),
  );
  const product = await ok(
    '/products',
    'POST',
    {
      sku: 'PS-STATUS-' + randomUUID(),
      name: 'Produkt statusu',
      price: 1500,
      quantity: 10,
      warehouse_id: wh,
    },
    auth,
  );
  const staged = (await ok('/integrations/' + ch + '/stage-orders', 'POST', { data: [raw] }, auth))
    .data[0];
  await ok(
    '/integrations/' + ch + '/mappings',
    'POST',
    { external_id: '701:0', sku: product.sku },
    auth,
  );
  const imported = await ok(
    '/imports/' + staged.id + '/commit',
    'POST',
    { warehouse_id: wh },
    auth,
  );
  const o = imported.order ?? imported;
  assert(o.id);
  return { ch, o, raw: original ?? raw, product, tenant, auth, wh };
}
async function ship(f: any) {
  await ok('/orders/' + f.o.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => ok(orderPath, 'GET', undefined, f.auth), '/orders/' + f.o.id + '/status', { status: 'picking' }), f.auth);
  for (let n = 0; n < 2; n++)
    await ok('/orders/' + f.o.id + '/scan', 'POST', { code: f.product.sku }, f.auth);
  await ok('/orders/' + f.o.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => ok(orderPath, 'GET', undefined, f.auth), '/orders/' + f.o.id + '/status', { status: 'packed' }), f.auth);
  await ok('/orders/' + f.o.id + '/ship-demo', 'POST', {}, f.auth);
}
const preview = (f: any) => ok('/orders/' + f.o.id + '/channel-status/preview', 'POST', {}, f.auth);
const queue = (f: any, p: any) =>
  ok('/channel-status-plans/' + p.id + '/queue', 'POST', { confirm_external: true }, f.auth);
const claim = async (id: string) =>
  (
    await pool.query(
      "UPDATE jobs SET state='running',attempts=attempts+1,locked_at=now(),lease_token=$2 WHERE id=$1 RETURNING *",
      [id, randomUUID()],
    )
  ).rows[0];
async function work(f: any, p: any) {
  const j = await claim(p.job_id);
  try {
    await processStatusWrite(j, { transport });
  } catch (e) {
    await failStatusJob(j, e);
  }
  return (await ok('/orders/' + f.o.id + '/channel-status', 'GET', undefined, f.auth)).data.find(
    (x: any) => x.id === p.id,
  );
}
const posts = () => calls.filter((c) => c.method === 'POST');
test('Adapter sends minimal XML history, shop scope and email OFF, no token in URL', async () => {
  const f = await fixture();
  const client = new PrestaShop(settings, { api_key: 'A'.repeat(32) }, transport);
  await client.updateOrderStatus(f.raw.id, '4');
  assert.equal(posts().length, 1);
  const p = posts()[0];
  assert.equal(
    p.headers.get('Authorization'),
    'Basic ' + Buffer.from('A'.repeat(32) + ':').toString('base64'),
  );
  assert(!p.url.toString().includes('A'.repeat(32)));
  assert(!p.body.includes('date_add'));
  assert(!p.body.includes('id_employee'));
});
test('Status mapping rejects mixed cancellation/logistics and malformed IDs', () => {
  assert(!psStatusMapSchema.safeParse({ ...mappings, cancelled: '4' }).success);
  assert(!psStatusMapSchema.safeParse({ ...mappings, packed: '4' }).success);
  assert(!psStatusMapSchema.safeParse({ ...mappings, shipped: '0' }).success);
});
test('Imported order → local shipping → remote history once → verified GET; local OMS/stock exact', async () => {
  const f = await fixture();
  await ship(f);
  const before = await ok('/orders/' + f.o.id),
    stock = await ok('/inventory');
  const p = await preview(f);
  assert.equal(p.target, '4');
  assert.equal(p.remote.status, '2');
  assert.equal(posts().length, 0);
  const done = await work(f, await queue(f, p));
  assert.equal(done.state, 'done');
  assert.equal(done.result.status, '4');
  assert.equal(posts().length, 1);
  assert.deepEqual(await ok('/orders/' + f.o.id), before);
  assert.deepEqual(await ok('/inventory'), stock);
});
test('Matching paid stage performs only reads', async () => {
  const f = await fixture();
  const done = await work(f, await queue(f, await preview(f)));
  assert(done.result.unchanged);
  assert.equal(posts().length, 0);
});
test('Existing channels remain unconfigured; administrator sets map with CAS', async () => {
  const f = await fixture(cookie, undefined, null);
  const r = await ok('/orders/' + f.o.id + '/channel-status');
  assert.equal(r.target, null);
  assert.match(r.reason, /mapowanie/);
  let cfg = await ok('/integrations/' + f.ch + '/order-status', 'PATCH', {
    version: 0,
    enabled: false,
    mappings,
  });
  assert.equal(cfg.version, 1);
  assert.equal(
    (
      await req('/integrations/' + f.ch + '/order-status', 'PATCH', {
        version: 0,
        enabled: false,
        mappings,
      })
    ).statusCode,
    409,
  );
  assert.equal((await preview(f)).target, '2');
});
test('Queue requires explicit external consent even in sandbox', async () => {
  const f = await fixture();
  const p = await preview(f);
  assert.equal((await req('/channel-status-plans/' + p.id + '/queue', 'POST', {})).statusCode, 422);
  assert.equal(posts().length, 0);
});
test('Fresh target flag change blocks POST before dispatch', async () => {
  const f = await fixture();
  await ship(f);
  const p = await queue(f, await preview(f));
  states.get('4').delivery = '1';
  const done = await work(f, p);
  assert.equal(done.state, 'conflict');
  assert.equal(posts().length, 0);
});
test('Changed local order version prevents dispatch', async () => {
  const f = await fixture();
  await ship(f);
  const p = await queue(f, await preview(f));
  await tenantTx(f.tenant, (c) =>
    c.query("UPDATE orders SET note='changed' WHERE id=$1", [f.o.id]),
  );
  assert.equal((await work(f, p)).state, 'conflict');
  assert.equal(posts().length, 0);
});
test('Remote date revision and buyer content changes prevent dispatch', async () => {
  const f = await fixture();
  await ship(f);
  const p = await queue(f, await preview(f));
  f.raw.date_upd = '2';
  assert.equal((await work(f, p)).state, 'conflict');
  assert.equal(posts().length, 0);
  const p2 = await queue(f, await preview(f));
  f.raw._dyna.address.address1 = 'Changed';
  assert.equal((await work(f, p2)).state, 'conflict');
  assert.equal(posts().length, 0);
});
test('Lost response after applied history retries only GET', async () => {
  const f = await fixture();
  await ship(f);
  const p = await queue(f, await preview(f));
  lose = true;
  let r = await work(f, p);
  assert.equal(r.phase, 'write_started');
  assert.equal(posts().length, 1);
  r = await work(f, p);
  assert.equal(r.state, 'done');
  assert.equal(posts().length, 1);
});
test('Uncertain non-applied write blocks changes to mapping; reconciliation stays read-only', async () => {
  const f = await fixture();
  await ship(f);
  const p = await queue(f, await preview(f));
  lose = true;
  noApply = true;
  await work(f, p);
  await pool.query('UPDATE jobs SET attempts=max_attempts WHERE id=$1', [p.job_id]);
  const failed = await work(f, p);
  assert.equal(failed.state, 'failed');
  assert.equal(
    (
      await req('/integrations/' + f.ch + '/order-status', 'PATCH', {
        version: 0,
        enabled: false,
        mappings: { ...mappings, packed: '7' },
      })
    ).statusCode,
    409,
  );
  assert.equal(
    (await req('/channel-status-plans/' + p.id + '/reconcile', 'POST', {})).statusCode,
    409,
  );
  await ok('/channel-status-plans/' + p.id + '/reconcile', 'POST', { acknowledge_mismatch: true });
  assert.equal(posts().length, 1);
});
test('A shipped source may not be moved back to paid', async () => {
  const f = await fixture();
  f.raw.current_state = '4';
  f.raw._dyna.state = structuredClone(states.get('4'));
  assert.equal(
    (await req('/orders/' + f.o.id + '/channel-status/preview', 'POST', {})).statusCode,
    409,
  );
  assert.equal(posts().length, 0);
});
test('Source refund or customization prevents writes', async () => {
  const f = await fixture();
  await ship(f);
  f.raw._dyna.details[0].product_quantity_refunded = '1';
  assert.equal(
    (await req('/orders/' + f.o.id + '/channel-status/preview', 'POST', {})).statusCode,
    409,
  );
  assert.equal(posts().length, 0);
});
test('Another firm cannot write same shop/order while its first result is uncertain', async () => {
  const f = await fixture();
  await ship(f);
  const p = await queue(f, await preview(f));
  lose = true;
  noApply = true;
  await work(f, p);
  const g = await fixture(other, f.raw.id);
  await ship(g);
  const q = await queue(g, await preview(g));
  assert.equal((await work(g, q)).state, 'conflict');
  assert.equal(posts().length, 1);
  assert.equal(
    (await req('/channel-status-plans/' + p.id + '/reconcile', 'POST', {}, other)).statusCode,
    409,
  );
});
test('Claims use FORCE RLS with SELECT-only role; readonly APIs reject writes', async () => {
  const f = await fixture();
  await ship(f);
  await work(f, await queue(f, await preview(f)));
  assert.equal(
    (
      await tenantTx(SECOND_TENANT, (c) =>
        c.query('SELECT * FROM prestashop_status_claims WHERE tenant_id=$1', [f.tenant]),
      )
    ).rowCount,
    0,
  );
  for (const k of ['INSERT', 'UPDATE', 'DELETE'])
    assert.equal(
      (
        await pool.query(
          "SELECT has_table_privilege('dyna_app','prestashop_status_claims',$1) allowed",
          [k],
        )
      ).rows[0].allowed,
      false,
    );
  assert.equal(
    (await req('/orders/' + f.o.id + '/channel-status/preview', 'POST', {}, viewer)).statusCode,
    403,
  );
  const ro = await buildApp({ readOnly: true, integrationTransport: transport });
  try {
    assert.equal(
      (
        await ro.inject({
          url: '/api/integrations/' + f.ch + '/order-status',
          method: 'PATCH',
          payload: { version: 0, enabled: false, mappings },
          headers: { cookie },
        })
      ).statusCode,
      423,
    );
  } finally {
    await ro.close();
  }
});
test('Automatic catch-up uses same mapped target and single write path', async () => {
  const f = await fixture();
  await ship(f);
  await ok('/integrations/' + f.ch + '/order-status', 'PATCH', {
    version: 0,
    enabled: true,
    mappings,
    confirm_external: true,
  });
  await scheduleStatusesDue();
  const scan = (
    await pool.query(
      "SELECT id FROM jobs WHERE kind='order.status.scan' AND payload->>'channel_id'=$1 AND state='pending' ORDER BY created_at DESC LIMIT 1",
      [f.ch],
    )
  ).rows[0];
  assert(scan);
  await processStatusScan(await claim(scan.id), { transport });
  const p = (await ok('/orders/' + f.o.id + '/channel-status')).data.find(
    (p: any) => p.state === 'queued',
  );
  assert(p);
  assert.equal((await work(f, p)).state, 'done');
  assert.equal(posts().length, 1);
});

test('Cancelled local order writes configured cancellation without refunding money', async () => {
  const f = await fixture();
  await ok('/orders/' + f.o.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => ok(orderPath, 'GET', undefined), '/orders/' + f.o.id + '/status', { status: 'cancelled' }));
  const before = await ok('/orders/' + f.o.id);
  const done = await work(f, await queue(f, await preview(f)));
  assert.equal(done.state, 'done');
  assert.equal(done.result.status, '6');
  assert.equal(posts().length, 1);
  assert.deepEqual(await ok('/orders/' + f.o.id), before);
});
test('COD rejects paid target and accepts explicitly unpaid shipping states', async () => {
  states.get('2').paid = '0';
  states.get('3').paid = '0';
  states.set('8', { id: '8', paid: '0', shipped: '1', delivery: '0', deleted: '0' });
  states.set('9', { id: '9', paid: '0', shipped: '1', delivery: '1', deleted: '0' });
  const f = await fixture(cookie, undefined, mappings, true);
  await ship(f);
  assert.equal(
    (await req('/orders/' + f.o.id + '/channel-status/preview', 'POST', {})).statusCode,
    409,
  );
  assert.equal(posts().length, 0);
  await ok('/integrations/' + f.ch + '/order-status', 'PATCH', {
    version: 0,
    enabled: false,
    mappings: { ...mappings, shipped: '8', delivered: '9', completed: '9' },
  });
  const done = await work(f, await queue(f, await preview(f)));
  assert.equal(done.state, 'done');
  assert.equal(done.result.status, '8');
  assert.equal(posts().length, 1);
});
test('Changed meaning after dispatch cannot be falsely confirmed during reconciliation', async () => {
  const f = await fixture();
  await ship(f);
  const p = await queue(f, await preview(f));
  lose = true;
  await work(f, p);
  states.get('4').delivery = '1';
  await pool.query('UPDATE jobs SET attempts=max_attempts WHERE id=$1', [p.job_id]);
  assert.equal((await work(f, p)).state, 'failed');
  assert.equal(
    (await req('/channel-status-plans/' + p.id + '/reconcile', 'POST', {})).statusCode,
    409,
  );
  const ack = await ok('/channel-status-plans/' + p.id + '/reconcile', 'POST', {
    acknowledge_mismatch: true,
  });
  assert.equal(ack.state, 'conflict');
  assert.equal(posts().length, 1);
});

test('Exhausted GET before dispatch becomes conflict and permits a fresh preview without a POST replay', async () => {
  const f = await fixture();
  await ship(f);
  const p = await queue(f, await preview(f));
  readFail = true;
  await pool.query('UPDATE jobs SET attempts=max_attempts-1 WHERE id=$1', [p.job_id]);
  const failed = await work(f, p);
  assert.equal(failed.state, 'conflict');
  assert.equal(failed.phase, 'ready');
  assert.equal(posts().length, 0);
  readFail = false;
  const done = await work(f, await queue(f, await preview(f)));
  assert.equal(done.state, 'done');
  assert.equal(posts().length, 1);
});
