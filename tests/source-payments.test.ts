import { legacySerialOrderStatusPayload } from './order-status-cas-helper';
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../server/app';
import { pool, migrate, tenantTx } from '../server/db';
import { seed, DEMO_TENANT, SECOND_TENANT } from './fixtures';
import { encrypt } from '../server/security';
import { demoWooOrder } from '../server/import-routes';
import { demoAllegroOrder } from '../server/allegro-example';
import { demoPrestaOrder } from '../server/prestashop-example';
import {
  processSourceRead,
  scheduleSourcePaymentsDue,
  failSourceRead,
} from '../server/source-payments';
import { normalizeOrder } from '../server/imports';
import { type IntegrationContext } from '../server/channel-access';
import { tick } from '../server/worker';
assert.equal(process.env.DYNA_TEST, 'true');
let app: Awaited<ReturnType<typeof buildApp>>,
  cookie: string,
  other: string,
  viewer: string,
  operator: string,
  warehouse: string,
  counter = 99300;
const remotes = new Map<string, any>(),
  calls: { url: URL; method: string }[] = [];
let hook: (() => Promise<void>) | undefined,
  deny = false;
const json = (d: any, status = 200) => new Response(JSON.stringify(d), { status });
const ctx: IntegrationContext = {
  transport: async (url, init) => {
    const u = new URL(url),
      method = init.method ?? 'GET';
    calls.push({ url: u, method });
    assert.equal(method, 'GET');
    const h = hook;
    hook = undefined;
    await h?.();
    if (deny) return json({ secret: 'NEVER_EXPOSE_PROVIDER_SECRET' }, 401);
    if (u.pathname.includes('/wp-json/')) return json(remotes.get(u.pathname.split('/').at(-1)!));
    if (u.pathname.startsWith('/order/')) return json(remotes.get(u.pathname.split('/').at(-1)!));
    const resource = u.pathname.split('/').at(-1)!;
    const raw = [...remotes.values()].filter((x) => x._dyna).at(-1);
    assert(raw, 'Missing Presta fixture');
    if (resource === 'orders') {
      assert.equal(u.searchParams.get('filter[id]'), '[' + raw.id + ']');
      assert.equal(u.searchParams.get('id_shop'), '1');
      return json({
        orders: [{ ...raw, _dyna: undefined, secure_key: 'NEVER_EXPOSE_PROVIDER_SECRET' }],
      });
    }
    const keys: Record<string, string> = {
      customers: 'customer',
      addresses: 'address',
      currencies: 'currency',
      order_states: 'state',
      order_details: 'details',
      order_cart_rules: 'cart_rules',
      countries: 'country',
    };
    const value = raw._dyna[keys[resource]];
    return json({ [resource]: Array.isArray(value) ? value : [value] });
  },
};
const req = (p: string, m: any = 'GET', b?: any, auth = cookie) =>
  app.inject({ url: '/api' + p, method: m, payload: b, headers: { cookie: auth } });
async function ok(p: string, m: any = 'GET', b?: any) {
  const r = await req(p, m, b);
  assert(r.statusCode < 300, r.body);
  return r.json();
}
before(async () => {
  await migrate();
  await seed();
  app = await buildApp({ integrationTransport: ctx.transport });
  async function login(email: string) {
    const r = await req('/auth/login', 'POST', { email, password: 'DynaDemo!2026' }, '');
    assert.equal(r.statusCode, 200);
    return r.headers['set-cookie']!.toString().split(';')[0];
  }
  cookie = await login('admin@demo.local');
  other = await login('other@demo.local');
  viewer = await login('viewer@demo.local');
  operator = await login('operator@demo.local');
  warehouse = (await ok('/warehouses')).data[0].id;
});
beforeEach(async () => {
  calls.length = 0;
  hook = undefined;
  deny = false;
  await pool.query('UPDATE source_payment_configs SET enabled=false');
  await pool.query("UPDATE jobs SET state='done',lease_token=NULL");
});
after(async () => {
  await app.close();
  await pool.end();
});
async function fixture(provider = 'woocommerce', amount = 0, simulation = false) {
  const raw: any = structuredClone(
    provider === 'allegro'
      ? demoAllegroOrder
      : provider === 'prestashop'
        ? demoPrestaOrder
        : demoWooOrder,
  );
  raw.id =
    provider === 'allegro'
      ? 'source-' + randomUUID()
      : provider === 'prestashop'
        ? String(++counter)
        : ++counter;
  if (provider === 'woocommerce') {
    raw.date_paid = amount ? '2026-10-04T10:00:00' : null;
    raw.status = amount ? 'processing' : 'on-hold';
  } else if (provider === 'allegro')
    raw.payment = {
      ...raw.payment,
      paidAmount: { amount: (amount / 100).toFixed(2), currency: 'PLN' },
    };
  else {
    raw.total_paid_real = (amount / 100).toFixed(6);
    raw._dyna.state.paid = amount ? '1' : '0';
    raw._dyna.details[0].id_order = raw.id;
    raw._dyna.cart_rules[0].id_order = raw.id;
  }
  const channel = randomUUID(),
    settings =
      provider === 'allegro'
        ? {}
        : provider === 'prestashop'
          ? { store_url: 'https://shop.example', shop_id: '1', order_state_ids: '2,3' }
          : { store_url: 'https://shop.example' };
  await tenantTx(DEMO_TENANT, (c) =>
    c.query(
      'INSERT INTO channels(id,tenant_id,provider,name,mode,settings,credentials,oauth_scopes) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [
        channel,
        DEMO_TENANT,
        provider,
        'Płatność ' + provider,
        'sandbox',
        JSON.stringify({ ...settings, simulation }),
        encrypt(
          provider === 'allegro'
            ? { access_token: 'test-access-token', refresh_token: 'test-refresh-token' }
            : provider === 'prestashop'
              ? { api_key: 'A'.repeat(32) }
              : { consumer_key: 'test-key', consumer_secret: 'test-secret' },
        ),
        'allegro:api:orders:read',
      ],
    ),
  );
  remotes.set(String(raw.id), raw);
  const n = normalizeOrder(provider, raw, settings),
    p = await ok('/products', 'POST', {
      name: 'Późne wpłaty',
      sku: 'SRC-' + randomUUID().slice(0, 8),
      price: 10000,
      warehouse_id: warehouse,
      quantity: 1000,
    });
  for (const i of n.items)
    await ok('/integrations/' + channel + '/mappings', 'POST', {
      external_id: i.external_id,
      sku: p.sku,
    });
  const staged = (await ok('/integrations/' + channel + '/stage-orders', 'POST', { data: [raw] }))
    .data[0];
  const o = await ok('/imports/' + staged.id + '/commit', 'POST', { warehouse_id: warehouse });
  return { raw, channel, o, staged, p, provider };
}
async function claim(id: string) {
  return (
    await pool.query(
      "UPDATE jobs SET state='running',lease_token=$2,locked_at=now(),attempts=attempts+1 WHERE id=$1 RETURNING *",
      [id, randomUUID()],
    )
  ).rows[0];
}
async function read(f: any) {
  const q = await ok('/orders/' + f.o.id + '/source-payments/read', 'POST', {}),
    j = await claim(q.job_id);
  await processSourceRead(j, ctx);
  return (await ok('/orders/' + f.o.id + '/source-payments')).data[0];
}
const get = (f: any) => ok('/orders/' + f.o.id);
const apply = (p: any) =>
  ok('/source-payment-checks/' + p.id + '/apply', 'POST', {
    version: Number(p.order_version),
    confirmed: true,
  });
async function configure(f: any, enabled = true) {
  const c = await ok('/integrations/' + f.channel + '/payment-sync');
  return ok('/integrations/' + f.channel + '/payment-sync', 'PATCH', {
    version: c.config?.version ?? 0,
    enabled,
    interval_seconds: 60,
    confirm_external: true,
  });
}
async function manual(f: any, amount: number) {
  const o = await get(f);
  return ok('/orders/' + o.id + '/payments', 'POST', {
    client_key: randomUUID(),
    version: Number(o.version),
    kind: 'receipt',
    amount,
    currency: o.currency,
    reference: 'Wpłata lokalna QA',
    confirmed: true,
  });
}
test('WooCommerce późne date_paid: podgląd, potwierdzenie różnicy, replay bez drugiej wpłaty', async () => {
  const f = await fixture();
  f.raw.date_paid = '2026-10-04T12:00:00';
  f.raw.status = 'completed';
  const before = await get(f),
    p = await read(f);
  assert.equal(p.state, 'review');
  assert.equal(p.delta, f.o.total);
  assert.equal((await get(f)).payment.received, 0);
  const v = await apply(p);
  assert.equal(v.changed, true);
  assert.equal((await get(f)).status, 'paid');
  assert.equal((await apply(p)).changed, false);
  assert.equal((await read(f)).state, 'unchanged');
  const o = await get(f);
  assert.equal(o.payment.received, o.total);
  assert.deepEqual(o.items, before.items);
  assert.deepEqual(o.picking_items, before.picking_items);
  assert(calls.every((x) => x.method === 'GET'));
  assert.equal((await ok('/orders/' + o.id + '/payments')).data.length, 1);
});
test('Allegro częściowa wpłata i dwie zakończone dopłaty; niezakończona dopłata pominięta', async () => {
  const f = await fixture('allegro', 2000);
  f.raw.surcharges = [
    { id: 'pending', type: 'ONLINE', paidAmount: { amount: '80.00', currency: 'PLN' } },
  ];
  assert.equal((await read(f)).state, 'unchanged');
  f.raw.surcharges.push({
    id: 'done1',
    type: 'ONLINE',
    finishedAt: '2026-10-04T12:00:00',
    paidAmount: { amount: '10.00', currency: 'PLN' },
  });
  let p = await read(f);
  assert.equal(p.delta, 1000);
  await apply(p);
  assert.equal((await get(f)).payment.received, 3000);
  f.raw.surcharges.push({
    id: 'done2',
    type: 'ONLINE',
    finishedAt: '2026-10-04T12:01:00',
    paidAmount: { amount: ((f.o.total - 3000) / 100).toFixed(2), currency: 'PLN' },
  });
  p = await read(f);
  assert.equal(p.delta, f.o.total - 3000);
  await apply(p);
  assert.equal((await get(f)).payment.amount_due, 0);
  assert.equal((await read(f)).state, 'unchanged');
});
test('zakończone surcharges są uwzględnione już podczas pierwszego importu', async () => {
  const raw: any = structuredClone(demoAllegroOrder);
  raw.payment.paidAmount.amount = '1.00';
  raw.surcharges = [
    {
      id: 'charge',
      type: 'ONLINE',
      finishedAt: '2026-10-04T12:00:00',
      paidAmount: { amount: '2.00', currency: 'PLN' },
    },
  ];
  assert.equal(normalizeOrder('allegro', raw).paid_amount, 300);
  raw.surcharges.push({ ...raw.surcharges[0] });
  assert.match(normalizeOrder('allegro', raw).blockers.join(' '), /Powtórzona/);
});
test('PrestaShop konkretne ID i relacje: późna wpłata częściowa nie jest pełnym paid', async () => {
  const f = await fixture('prestashop');
  f.raw.total_paid_real = '10.000000';
  const p = await read(f);
  assert.equal(p.delta, 1000);
  await apply(p);
  let o = await get(f);
  assert.equal(o.status, 'new');
  assert.equal(o.payment.received, 1000);
  f.raw.total_paid_real = (o.total / 100).toFixed(6);
  f.raw._dyna.state.paid = '1';
  await apply(await read(f));
  o = await get(f);
  assert.equal(o.status, 'paid');
  assert.equal(o.payment.amount_due, 0);
  assert(
    calls.some(
      (x) =>
        x.url.pathname === '/api/orders' &&
        x.url.searchParams.get('filter[id]') === '[' + f.raw.id + ']',
    ),
  );
  assert(
    !JSON.stringify(await ok('/orders/' + o.id + '/source-payments')).includes('NEVER_EXPOSE'),
  );
});
test('ręczna wpłata blokuje dopisanie tej samej kwoty ze źródła', async () => {
  const f = await fixture();
  await manual(f, 1000);
  f.raw.date_paid = '2026-10-04T12:00:00';
  const p = await read(f);
  assert.equal(p.state, 'blocked');
  assert.match(p.reason, /Ręczne wpłaty/);
  assert.equal((await get(f)).payment.received, 1000);
});
test('spadek wpłaty źródłowej nie wykonuje automatycznej refundacji', async () => {
  const f = await fixture('allegro', 2000);
  f.raw.payment.paidAmount.amount = '10.00';
  const p = await read(f);
  assert.equal(p.state, 'blocked');
  assert.equal(p.delta, -1000);
  assert.match(p.reason, /spadła/);
  assert.equal((await get(f)).payment.received, 2000);
});
test('korekta źródłowej wpłaty wymaga uzgodnienia, bez samoczynnego odtworzenia', async () => {
  const f = await fixture('allegro', 1000);
  let o = await get(f);
  const e = (await ok('/orders/' + o.id + '/payments')).data[0];
  await ok('/orders/' + o.id + '/payments/reverse', 'POST', {
    client_key: randomUUID(),
    version: Number(o.version),
    entry_id: e.id,
    reason: 'Nieprawidłowa deklaracja źródła',
    confirmed: true,
  });
  const p = await read(f);
  assert.equal(p.state, 'blocked');
  assert.match(p.reason, /korekty źródła/);
  assert.equal((await get(f)).payment.received, 0);
});
test('zmiany kwot, odbiorcy, trybu, refundacje i walut blokują wpłatę', async () => {
  for (const mutate of [
    (r: any) => (r.total = '99.00'),
    (r: any) => (r.billing.city = 'Kraków'),
    (r: any) => (r.payment_method = 'cod'),
    (r: any) => (r.refunds = [{ id: 1 }]),
    (r: any) => (r.currency = 'EUR'),
  ]) {
    const f = await fixture();
    f.raw.date_paid = '2026-10-04T12:00:00';
    mutate(f.raw);
    const p = await read(f);
    assert.equal(p.state, 'blocked');
    assert.equal((await get(f)).payment.received, 0);
  }
});
test('Allegro waluta dopłaty, split i wyrównania finansowane przez platformę wymagają uzgodnienia', async () => {
  for (const mutate of [
    (r: any) =>
      (r.surcharges = [
        {
          id: 'x',
          type: 'ONLINE',
          finishedAt: 'now',
          paidAmount: { amount: '10.00', currency: 'EUR' },
        },
      ]),
    (r: any) => (r.payment.type = 'SPLIT_PAYMENT'),
    (r: any) => (r.payment.reconciliation = { amount: '1.00', currency: 'PLN' }),
  ]) {
    const f = await fixture('allegro');
    mutate(f.raw);
    assert.equal((await read(f)).state, 'blocked');
  }
});
test('nieaktualny, wygasły i zastąpiony podgląd nie zapisuje pieniędzy', async () => {
  const f = await fixture();
  f.raw.date_paid = '2026-10-04T12:00:00';
  let p = await read(f),
    newer = await read(f);
  assert.equal(
    (
      await req('/source-payment-checks/' + p.id + '/apply', 'POST', {
        version: Number(p.order_version),
        confirmed: true,
      })
    ).statusCode,
    409,
  );
  await pool.query(
    "UPDATE source_payment_checks SET created_at=now()-interval '11 minutes' WHERE id=$1",
    [newer.id],
  );
  p = await read(f);
  await pool.query(
    "UPDATE source_payment_checks SET created_at=now()-interval '12 minutes' WHERE order_id=$1",
    [f.o.id],
  );
  assert.equal(
    (
      await req('/source-payment-checks/' + p.id + '/apply', 'POST', {
        version: Number(p.order_version),
        confirmed: true,
      })
    ).statusCode,
    409,
  );
  p = await read(f);
  await manual(f, 100);
  assert.equal(
    (
      await req('/source-payment-checks/' + p.id + '/apply', 'POST', {
        version: Number(p.order_version),
        confirmed: true,
      })
    ).statusCode,
    409,
  );
  assert.equal((await get(f)).payment.received, 100);
});
test('równoległe odczyty i potwierdzenia mają jeden wpis i jedną aktywną pracę', async () => {
  const f = await fixture();
  f.raw.date_paid = '2026-10-04T12:00:00';
  const q = await Promise.all(
    Array.from({ length: 6 }, () => ok('/orders/' + f.o.id + '/source-payments/read', 'POST', {})),
  );
  assert.equal(new Set(q.map((x) => x.job_id)).size, 1);
  await processSourceRead(await claim(q[0].job_id), ctx);
  const p = (await ok('/orders/' + f.o.id + '/source-payments')).data[0];
  const out = await Promise.all(Array.from({ length: 6 }, () => apply(p)));
  assert.equal(out.filter((x) => x.changed).length, 1);
  assert.equal((await ok('/orders/' + f.o.id + '/payments')).data.length, 1);
});
test('konfiguracja i dane: role, obca firma i FORCE RLS', async () => {
  const f = await fixture();
  for (const auth of [viewer, operator]) {
    assert.equal(
      (await req('/orders/' + f.o.id + '/source-payments', 'GET', undefined, auth)).statusCode,
      403,
    );
    assert.equal(
      (await req('/orders/' + f.o.id + '/source-payments/read', 'POST', {}, auth)).statusCode,
      403,
    );
    assert.equal(
      (await req('/integrations/' + f.channel + '/payment-sync', 'GET', undefined, auth))
        .statusCode,
      403,
    );
  }
  assert.equal(
    (await req('/orders/' + f.o.id + '/source-payments', 'GET', undefined, other)).statusCode,
    404,
  );
  await configure(f);
  await read(f);
  await tenantTx(SECOND_TENANT, async (c) => {
    assert.equal(
      (await c.query('SELECT * FROM source_payment_configs WHERE channel_id=$1', [f.channel]))
        .rowCount,
      0,
    );
    assert.equal(
      (await c.query('SELECT * FROM source_payment_checks WHERE order_id=$1', [f.o.id])).rowCount,
      0,
    );
  });
});
test('harmonogram cyklicznie zapisuje różnicę i pauza zatrzymuje nowe zapisy', async () => {
  const f = await fixture('allegro', 1000);
  await configure(f);
  f.raw.payment.paidAmount.amount = '20.00';
  await scheduleSourcePaymentsDue();
  let j = (
    await pool.query(
      "SELECT id FROM jobs WHERE kind='payment.source.read' AND state='pending' AND payload->>'channel_id'=$1",
      [f.channel],
    )
  ).rows[0];
  assert(j);
  await processSourceRead(await claim(j.id), ctx);
  assert.equal((await get(f)).payment.received, 2000);
  await configure(f, false);
  f.raw.payment.paidAmount.amount = '30.00';
  await scheduleSourcePaymentsDue();
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM jobs WHERE kind='payment.source.read' AND state='pending' AND payload->>'channel_id'=$1",
        [f.channel],
      )
    ).rows[0].n,
    0,
  );
});
test('pauza podczas GET i odebranie dzierżawy nie zapisują odczytu ani wpłaty', async () => {
  for (const kind of ['pause', 'lease']) {
    const f = await fixture();
    await configure(f);
    f.raw.date_paid = '2026-10-04T12:00:00';
    await scheduleSourcePaymentsDue();
    const j = await claim(
      (
        await pool.query(
          "SELECT id FROM jobs WHERE kind='payment.source.read' AND state='pending' AND payload->>'channel_id'=$1",
          [f.channel],
        )
      ).rows[0].id,
    );
    hook = async () => {
      if (kind === 'pause') await configure(f, false);
      else await pool.query('UPDATE jobs SET lease_token=$2 WHERE id=$1', [j.id, randomUUID()]);
    };
    if (kind === 'pause') await assert.rejects(() => processSourceRead(j, ctx), /wyłączono/);
    else await processSourceRead(j, ctx);
    assert.equal((await get(f)).payment.received, 0);
    assert.equal((await ok('/orders/' + f.o.id + '/source-payments')).data.length, 0);
    await configure(f, false);
  }
});
test('zmiana połączenia i uprawnień blokuje worker przed GET', async () => {
  const f = await fixture(),
    q = await ok('/orders/' + f.o.id + '/source-payments/read', 'POST', {}),
    j = await claim(q.job_id);
  await pool.query(
    'UPDATE channels SET settings=settings||\'{"store_url":"https://other.example"}\'::jsonb WHERE id=$1',
    [f.channel],
  );
  await assert.rejects(() => processSourceRead(j, ctx), /połączenie/);
  assert.equal(calls.length, 0);
  const g = await fixture(),
    v = await ok('/orders/' + g.o.id + '/source-payments/read', 'POST', {}),
    k = await claim(v.job_id);
  const user = (await pool.query("SELECT id FROM users WHERE email='admin@demo.local'")).rows[0].id;
  await pool.query("UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2", [
    DEMO_TENANT,
    user,
  ]);
  try {
    await assert.rejects(() => processSourceRead(k, ctx), /uprawnień/);
  } finally {
    await pool.query("UPDATE memberships SET role='admin' WHERE tenant_id=$1 AND user_id=$2", [
      DEMO_TENANT,
      user,
    ]);
  }
  assert.equal(calls.length, 0);
});
test('błąd GET ma retry bez ujawniania odpowiedzi; terminalna konfiguracja nie ponawia', async () => {
  const f = await fixture(),
    q = await ok('/orders/' + f.o.id + '/source-payments/read', 'POST', {}),
    j = await claim(q.job_id);
  deny = true;
  let error;
  try {
    await processSourceRead(j, ctx);
  } catch (e) {
    error = e;
  }
  assert(error);
  await failSourceRead(j, error);
  const v = (await pool.query('SELECT state,error FROM jobs WHERE id=$1', [j.id])).rows[0];
  assert.equal(v.state, 'pending');
  assert(!v.error.includes('NEVER_EXPOSE'));
  assert.equal((await get(f)).payment.received, 0);
});
test('edytor przykładu nie zmienia rzeczywistego kanału, salda ani uprawnień', async () => {
  const actual = await fixture();
  const before = (
    await pool.query('SELECT raw FROM inbound_orders WHERE id=$1', [actual.staged.id])
  ).rows[0];
  assert.equal(
    (
      await req('/orders/' + actual.o.id + '/source-payments/example', 'POST', {
        amount: actual.o.total,
      })
    ).statusCode,
    422,
  );
  assert.deepEqual(
    (await pool.query('SELECT raw FROM inbound_orders WHERE id=$1', [actual.staged.id])).rows[0],
    before,
  );
  const local = await fixture('woocommerce', 0, true);
  const path = '/orders/' + local.o.id + '/source-payments/example';
  assert.equal((await req(path, 'POST', { amount: 1 })).statusCode, 422);
  assert.equal((await req(path, 'POST', { amount: local.o.total }, operator)).statusCode, 403);
  assert.equal((await req(path, 'POST', { amount: local.o.total }, other)).statusCode, 404);
  await ok(path, 'POST', { amount: local.o.total });
  assert.equal((await get(local)).payment.received, 0);
  assert.equal(calls.length, 0);
  await apply(await read(local));
  assert.equal((await get(local)).payment.received, local.o.total);
});
test('symulator jest lokalny i pełne pokrycie uruchamia zwykłe zdarzenie order.paid', async () => {
  const f = await fixture('woocommerce', 0, true);
  f.raw.date_paid = '2026-10-04T12:00:00';
  await pool.query('UPDATE inbound_orders SET raw=$2 WHERE id=$1', [
    f.staged.id,
    JSON.stringify(f.raw),
  ]);
  const p = await read(f);
  await apply(p);
  assert.equal(calls.length, 0);
  assert.equal((await get(f)).status, 'paid');
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM order_events WHERE order_id=$1 AND kind='order.paid'",
        [f.o.id],
      )
    ).rows[0].n,
    1,
  );
});
test('worker tick uruchamia zarejestrowany odczyt', async () => {
  const f = await fixture();
  f.raw.date_paid = '2026-10-04T12:00:00';
  const q = await ok('/orders/' + f.o.id + '/source-payments/read', 'POST', {});
  for (let i = 0; i < 30; i++) {
    if (
      (await pool.query('SELECT state FROM jobs WHERE id=$1', [q.job_id])).rows[0].state === 'done'
    )
      break;
    await tick(ctx);
  }
  assert.equal((await ok('/orders/' + f.o.id + '/source-payments')).data[0].state, 'review');
});

test('późna dopłata po wysyłce tworzy nadpłatę bez cofania statusu lub ruchu stocku', async () => {
  const f = await fixture('allegro');
  f.raw.payment.paidAmount.amount = (f.o.total / 100).toFixed(2);
  await apply(await read(f));
  await ok('/orders/' + f.o.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => ok(orderPath, 'GET', undefined), '/orders/' + f.o.id + '/status', { status: 'picking' }));
  for (const i of f.o.picking_items)
    for (let n = 0; n < i.quantity; n++)
      await ok('/orders/' + f.o.id + '/scan', 'POST', { code: i.sku });
  await ok('/orders/' + f.o.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => ok(orderPath, 'GET', undefined), '/orders/' + f.o.id + '/status', { status: 'packed' }));
  await ok('/orders/' + f.o.id + '/ship-demo', 'POST');
  const stock = (
    await pool.query('SELECT on_hand,reserved FROM stock WHERE product_id=$1 AND warehouse_id=$2', [
      f.p.id,
      warehouse,
    ])
  ).rows;
  f.raw.surcharges = [
    {
      id: 'late',
      type: 'ONLINE',
      finishedAt: '2026-10-04T13:00:00',
      paidAmount: { amount: '1.00', currency: 'PLN' },
    },
  ];
  const p = await read(f);
  assert.equal(p.delta, 100);
  await apply(p);
  const o = await get(f);
  assert.equal(o.status, 'shipped');
  assert.equal(o.payment.overpayment, 100);
  assert.equal(o.shipments.length, 1);
  assert.deepEqual(
    (
      await pool.query(
        'SELECT on_hand,reserved FROM stock WHERE product_id=$1 AND warehouse_id=$2',
        [f.p.id, warehouse],
      )
    ).rows,
    stock,
  );
});
test('harmonogram ma strony po 25 i nie gubi kursora przy pełnej kolejce', async () => {
  const f = await fixture();
  for (let i = 0; i < 26; i++) {
    const raw = { ...f.raw, id: ++counter };
    const staged = (
      await ok('/integrations/' + f.channel + '/stage-orders', 'POST', { data: [raw] })
    ).data[0];
    await ok('/imports/' + staged.id + '/commit', 'POST', { warehouse_id: warehouse });
  }
  await configure(f);
  await scheduleSourcePaymentsDue();
  let cfg = (await ok('/integrations/' + f.channel + '/payment-sync')).config;
  assert(cfg.cursor);
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM jobs WHERE kind='payment.source.read' AND state='pending' AND payload->>'channel_id'=$1",
        [f.channel],
      )
    ).rows[0].n,
    25,
  );
  await pool.query('UPDATE source_payment_configs SET next_at=now() WHERE channel_id=$1', [
    f.channel,
  ]);
  await scheduleSourcePaymentsDue();
  cfg = (await ok('/integrations/' + f.channel + '/payment-sync')).config;
  assert.equal(cfg.cursor, null);
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM jobs WHERE kind='payment.source.read' AND state='pending' AND payload->>'channel_id'=$1",
        [f.channel],
      )
    ).rows[0].n,
    27,
  );
  const cursor = randomUUID();
  await pool.query(
    'UPDATE source_payment_configs SET cursor=$2,next_at=now() WHERE channel_id=$1',
    [f.channel, cursor],
  );
  for (let i = 0; i < 73; i++) {
    const id = randomUUID();
    await pool.query(
      "INSERT INTO jobs(id,tenant_id,kind,payload,dedup_key) VALUES($1,$2,'payment.source.read',$3,$4)",
      [
        id,
        DEMO_TENANT,
        JSON.stringify({ channel_id: f.channel, order_id: randomUUID() }),
        'source-limit:' + id,
      ],
    );
  }
  await scheduleSourcePaymentsDue();
  assert.equal((await ok('/integrations/' + f.channel + '/payment-sync')).config.cursor, cursor);
  const newRaw = { ...f.raw, id: ++counter },
    staged = (await ok('/integrations/' + f.channel + '/stage-orders', 'POST', { data: [newRaw] }))
      .data[0],
    o = await ok('/imports/' + staged.id + '/commit', 'POST', { warehouse_id: warehouse });
  assert.equal(
    (await req('/orders/' + o.id + '/source-payments/read', 'POST', {})).statusCode,
    429,
  );
});
test('PrestaShop harmonogram: GET Webservice w zakresie sklepu, 429 i obcy sklep, automatyczna wpłata bez duplikatu', async () => {
  const f = await fixture('prestashop');
  const auth = 'Basic ' + Buffer.from('A'.repeat(32) + ':').toString('base64'),
    seen: URL[] = [];
  let current: any,
    limited = false,
    foreignShop = true;
  const presta: IntegrationContext = {
    transport: async (url, init) => {
      const u = new URL(url),
        resource = u.pathname.split('/').at(-1)!;
      assert.equal(init.method ?? 'GET', 'GET');
      assert.equal(u.origin + u.pathname, 'https://shop.example/api/' + resource);
      assert.equal(new Headers(init.headers).get('authorization'), auth);
      assert.equal(u.searchParams.get('output_format'), 'JSON');
      assert.equal(u.searchParams.get('id_shop'), '1');
      seen.push(u);
      if (resource === 'orders') {
        if (!limited) {
          limited = true;
          return new Response('{}', { status: 429, headers: { 'retry-after': '0.01' } });
        }
        assert.equal(u.searchParams.get('filter[id]'), '[' + f.raw.id + ']');
        assert.equal(u.searchParams.get('filter[id_shop]'), '[1]');
        assert.equal(u.searchParams.get('display'), 'full');
        assert.equal(u.searchParams.get('limit'), '0,5');
        current = f.raw;
        return json({
          orders: [{ ...current, _dyna: undefined, id_shop: foreignShop ? '2' : '1' }],
        });
      }
      if (['order_details', 'order_cart_rules'].includes(resource))
        assert.equal(u.searchParams.get('filter[id_order]'), '[' + current.id + ']');
      const keys: Record<string, string> = {
        customers: 'customer',
        addresses: 'address',
        currencies: 'currency',
        order_states: 'state',
        order_details: 'details',
        order_cart_rules: 'cart_rules',
        countries: 'country',
      };
      const value = current._dyna[keys[resource]];
      return json({ [resource]: Array.isArray(value) ? value : [value] });
    },
  };
  const pending = async () =>
    (
      await pool.query(
        "SELECT * FROM jobs WHERE kind='payment.source.read' AND state='pending' AND payload->>'channel_id'=$1",
        [f.channel],
      )
    ).rows;
  const checks = () =>
    tenantTx(
      DEMO_TENANT,
      async (c) =>
        (
          await c.query(
            'SELECT state,delta,seen_count FROM source_payment_checks WHERE order_id=$1 ORDER BY created_at,id',
            [f.o.id],
          )
        ).rows,
    );
  const due = () =>
    pool.query('UPDATE source_payment_configs SET next_at=now() WHERE channel_id=$1', [f.channel]);
  assert.equal((await get(f)).payment.received, 0);
  const cfg = (await configure(f)).config;
  f.raw.total_paid_real = (f.o.total / 100).toFixed(6);
  f.raw._dyna.state.paid = '1';
  await scheduleSourcePaymentsDue();
  let jobs = await pending();
  assert.equal(jobs.length, 1);
  assert.deepEqual(
    [jobs[0].payload.order_id, jobs[0].payload.automatic, jobs[0].payload.config_version],
    [f.o.id, true, cfg.version],
  );
  assert.equal(seen.length, 0);
  // An order from another shop is a provider error: retried later, never recorded as a payment.
  let j = await claim(jobs[0].id);
  let error: unknown;
  try {
    await processSourceRead(j, presta);
  } catch (e) {
    error = e;
  }
  assert.match(String((error as Error)?.message), /innego sklepu/);
  await failSourceRead(j, error);
  const jobState = async (id: string) =>
    (await pool.query('SELECT state FROM jobs WHERE id=$1', [id])).rows[0].state;
  assert.equal(await jobState(j.id), 'pending');
  assert.equal(seen.filter((u) => u.pathname === '/api/orders').length, 2);
  assert.equal(seen.length, 2);
  assert.deepEqual(await checks(), []);
  assert.equal((await get(f)).payment.received, 0);
  // A due tick reuses the active read; the retry applies the payment once.
  foreignShop = false;
  await due();
  await scheduleSourcePaymentsDue();
  jobs = await pending();
  assert.deepEqual(
    jobs.map((x) => x.id),
    [j.id],
  );
  j = await claim(j.id);
  await processSourceRead(j, presta);
  assert.equal(await jobState(j.id), 'done');
  assert.deepEqual(
    seen.slice(2).map((u) => u.pathname.split('/').at(-1)).sort(),
    [
      'addresses',
      'countries',
      'currencies',
      'customers',
      'order_cart_rules',
      'order_details',
      'order_states',
      'orders',
    ],
  );
  assert.deepEqual(await checks(), [{ state: 'applied', delta: f.o.total, seen_count: 1 }]);
  let o = await get(f);
  assert.equal(o.status, 'paid');
  assert.equal(o.payment.received, o.total);
  let payments = (await ok('/orders/' + o.id + '/payments')).data;
  assert.equal(payments.length, 1);
  assert.equal(payments[0].method, 'source_sync');
  assert.equal(Number(payments[0].amount), o.total);
  // Next cycle reads the same declaration again and records no second payment.
  await due();
  await scheduleSourcePaymentsDue();
  // The next cycle is scheduled one interval ahead (this database is too slow to wait it out).
  assert.deepEqual(
    (
      await pool.query(
        "SELECT next_at>now() AS later,next_at<=now()+interval '60 seconds' AS bounded,cursor FROM source_payment_configs WHERE channel_id=$1",
        [f.channel],
      )
    ).rows[0],
    { later: true, bounded: true, cursor: null },
  );
  jobs = await pending();
  assert.equal(jobs.length, 1);
  await processSourceRead(await claim(jobs[0].id), presta);
  assert.equal(seen.length, 18);
  assert.deepEqual(
    (await checks()).map((x: any) => x.state),
    ['applied', 'unchanged'],
  );
  o = await get(f);
  assert.equal(o.payment.received, o.total);
  payments = (await ok('/orders/' + o.id + '/payments')).data;
  assert.equal(payments.length, 1);
  assert(
    !JSON.stringify(await ok('/orders/' + o.id + '/source-payments')).includes('NEVER_EXPOSE'),
  );
});
test('niepewny zapis InPost blokuje automatyczną wpłatę i nie zostawia fałszywej historii', async () => {
  const f = await fixture('allegro', 1000);
  await configure(f);
  f.raw.payment.paidAmount.amount = '20.00';
  const ch = (await ok('/shipping/example', 'POST', {})).id;
  await pool.query(
    "INSERT INTO shipping_plans(id,tenant_id,channel_id,order_id,actor_id,state,input,payload,order_snapshot,phase) VALUES($1,$2,$3,$4,(SELECT id FROM users WHERE email='admin@demo.local'),'failed','{}','{}','{}','buy_started')",
    [randomUUID(), DEMO_TENANT, ch, f.o.id],
  );
  await scheduleSourcePaymentsDue();
  const j = (
    await pool.query(
      "SELECT id FROM jobs WHERE kind='payment.source.read' AND state='pending' AND payload->>'channel_id'=$1",
      [f.channel],
    )
  ).rows[0];
  await processSourceRead(await claim(j.id), ctx);
  const p = (await ok('/orders/' + f.o.id + '/source-payments')).data[0];
  assert.equal(p.state, 'blocked');
  assert.match(p.reason, /niepewny zapis/);
  assert.equal((await get(f)).payment.received, 1000);
  assert.equal((await ok('/orders/' + f.o.id + '/payments')).data.length, 1);
});
test('publiczne API współdzieli podgląd i potwierdzenie, a read-only nie kolejkuje odczytu', async () => {
  const f = await fixture();
  f.raw.date_paid = '2026-10-04T12:00:00';
  const k = await ok('/developer/keys', 'POST', {
      name: 'Source payments QA',
      scopes: ['orders:read', 'orders:write'],
    }),
    r = await ok('/developer/keys', 'POST', {
      name: 'Source payments read',
      scopes: ['orders:read'],
    });
  const api = (path: string, method: any = 'GET', payload?: any, token = k.token) =>
    app.inject({
      url: '/api/v1' + path,
      method,
      payload,
      headers: { authorization: 'Bearer ' + token },
    });
  assert.equal(
    (await api('/orders/' + f.o.id + '/source-payments/read', 'POST', {}, r.token)).statusCode,
    403,
  );
  const q = await api('/orders/' + f.o.id + '/source-payments/read', 'POST', {});
  assert.equal(q.statusCode, 200, q.body);
  await processSourceRead(await claim(q.json().job_id), ctx);
  const p = (await api('/orders/' + f.o.id + '/source-payments')).json().data[0];
  assert.equal(
    (
      await api('/source-payment-checks/' + p.id + '/apply', 'POST', {
        version: Number(p.order_version),
        confirmed: true,
      })
    ).statusCode,
    200,
  );
  const doc = (await app.inject({ url: '/api/v1/openapi' })).json();
  assert(doc.paths['/orders/{id}/source-payments']);
  await ok('/developer/keys/' + k.id, 'DELETE');
  await ok('/developer/keys/' + r.id, 'DELETE');
});

test('identyczne odczyty bez wpłaty scalają obserwacje, a archiwum ma odczyt ręczny', async () => {
  const f = await fixture();
  let p = await read(f);
  assert.equal(p.state, 'unchanged');
  await read(f);
  const data = (await ok('/orders/' + f.o.id + '/source-payments')).data;
  assert.equal(data.length, 1);
  assert.equal(data[0].seen_count, 2);
  // Insert a historical fixture; changing an existing order's billing month is correctly forbidden.
  const original = f.o.id,
    archive = randomUUID(),
    external = String(++counter);
  await pool.query(
    "INSERT INTO orders SELECT (jsonb_populate_record(NULL::orders,to_jsonb(o)||jsonb_build_object('id',$2::uuid,'number',o.number||'-ARCHIVE','external_id',$3::text,'portal_token',substr(replace(gen_random_uuid()::text||gen_random_uuid()::text,'-',''),1,48),'created_at',now()-interval '91 days','status','cancelled'))).* FROM orders o WHERE id=$1",
    [original, archive, external],
  );
  await pool.query(
    "INSERT INTO order_items SELECT (jsonb_populate_record(NULL::order_items,to_jsonb(i)||jsonb_build_object('id',gen_random_uuid(),'order_id',$2::uuid))).* FROM order_items i WHERE order_id=$1",
    [original, archive],
  );
  f.o.id = archive;
  f.raw = { ...f.raw, id: Number(external) };
  remotes.set(external, f.raw);
  await configure(f);
  await scheduleSourcePaymentsDue();
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM jobs WHERE kind='payment.source.read' AND state='pending' AND payload->>'order_id'=$1",
        [archive],
      )
    ).rows[0].n,
    0,
  );
  f.raw.date_paid = '2026-10-04T14:00:00';
  p = await read(f);
  assert.equal(p.state, 'review');
  await apply(p);
  assert.equal((await get(f)).payment.received, f.o.total);
});
