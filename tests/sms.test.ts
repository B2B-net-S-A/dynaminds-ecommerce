import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../server/app';
import { pool, migrate, tenantTx } from '../server/db';
import { seed, SECOND_TENANT } from './fixtures';
import { smsLength, smsRecipient, renderSms, processSms } from '../server/sms';
import { SmsApi, SmsRejected } from '../server/smsapi';
import { tick } from '../server/worker';
assert.equal(process.env.DYNA_TEST, 'true');
let app: FastifyInstance,
  admin: string,
  operator: string,
  viewer: string,
  other: string,
  tenant: string,
  warehouse: string,
  product: string;
let providerCalls: { url: string; init: RequestInit }[] = [],
  response: any;
const transport = async (url: string, init: RequestInit) => {
  providerCalls.push({ url, init });
  if (url.endsWith('/profile')) return Response.json({ points: 14.5, payment_type: 'prepaid' });
  if (response instanceof Error) throw response;
  return (
    response ??
    Response.json({
      count: 1,
      list: [{ id: '1460969715572091219', points: 0.16, number: '48500500500', status: 'QUEUE' }],
    })
  );
};
const req = (url: string, method: any = 'GET', payload?: any, cookie = admin) =>
  app.inject({
    url,
    method,
    payload,
    headers: { cookie, 'x-workspace-id': cookie === other ? SECOND_TENANT : tenant },
  });
async function ok(url: string, method: any = 'GET', payload?: any, cookie = admin) {
  const r = await req(url, method, payload, cookie);
  assert.ok(r.statusCode < 300, r.body);
  return r.json();
}
before(async () => {
  await migrate();
  await seed();
  app = await buildApp({ integrationTransport: transport });
  async function login(email: string) {
    const r = await app.inject({
      url: '/api/auth/login',
      method: 'POST',
      payload: { email, password: 'DynaDemo!2026' },
    });
    assert.equal(r.statusCode, 200, r.body);
    return r.headers['set-cookie']!.toString().split(';')[0];
  }
  admin = await login('admin@demo.local');
  operator = await login('operator@demo.local');
  viewer = await login('viewer@demo.local');
  other = await login('other@demo.local');
});
beforeEach(async () => {
  await pool.query("UPDATE jobs SET state='done',lease_token=NULL");
  tenant = randomUUID();
  await pool.query("INSERT INTO tenants(id,name,plan) VALUES($1,'SMS QA','enterprise')", [tenant]);
  await pool.query(
    "INSERT INTO memberships(tenant_id,user_id,role) SELECT $1,id,CASE email WHEN 'admin@demo.local' THEN 'admin' WHEN 'operator@demo.local' THEN 'operator' ELSE 'viewer' END FROM users WHERE email=ANY($2::text[])",
    [tenant, ['admin@demo.local', 'operator@demo.local', 'viewer@demo.local']],
  );
  async function switchOrg(cookie: string) {
    const r = await app.inject({
      url: '/api/workspaces/switch',
      method: 'POST',
      payload: { tenant_id: tenant },
      headers: { cookie },
    });
    assert.equal(r.statusCode, 200, r.body);
    return r.headers['set-cookie']!.toString().split(';')[0];
  }
  admin = await switchOrg(admin);
  operator = await switchOrg(operator);
  viewer = await switchOrg(viewer);
  warehouse = randomUUID();
  await pool.query("INSERT INTO warehouses(id,tenant_id,name,code) VALUES($1,$2,'SMS','SMS')", [
    warehouse,
    tenant,
  ]);
  product = (
    await ok('/api/products', 'POST', {
      sku: 'SMS-' + randomUUID(),
      name: 'SMS test',
      price: 1299,
      warehouse_id: warehouse,
      quantity: 10000,
    })
  ).id;
  providerCalls = [];
  response = null;
});
after(async () => {
  await app.close();
  await pool.end();
});
const template = (extra: any = {}, cookie = admin) =>
  ok(
    '/api/sms/templates',
    'POST',
    {
      name: 'SMS status',
      body: '{{customer_name}}, zamowienie {{order_number}}: {{total}} {{currency}}.',
      max_parts: 3,
      client_key: randomUUID(),
      ...extra,
    },
    cookie,
  );
const order = (phone = '500500500', extra: any = {}) =>
  ok('/api/orders', 'POST', {
    customer_name: 'QA SMS',
    email: 'sms@example.test',
    warehouse_id: warehouse,
    address: { country: 'PL', phone },
    items: [{ product_id: product, quantity: 1 }],
    ...extra,
  });
async function preview(t: any, orders: any[], extra: any = {}, cookie = admin) {
  return ok(
    '/api/sms/preview',
    'POST',
    {
      template_id: t.id,
      template_version: t.version,
      order_ids: orders.map((o) => o.id),
      mode: 'local',
      client_key: randomUUID(),
      ...extra,
    },
    cookie,
  );
}
const queue = (b: any, cookie = admin) =>
  ok('/api/sms/batches/' + b.id + '/queue', 'POST', { confirmed: true }, cookie);
async function drain() {
  for (let i = 0; i < 100; i++) if (!(await tick({ transport }))) return;
  throw new Error('Worker did not drain');
}
const channel = () =>
  ok('/api/integrations', 'POST', {
    provider: 'smsapi',
    name: 'QA SMSAPI',
    mode: 'sandbox',
    credentials: { access_token: 'fixture-token' },
    settings: { sender: 'Test' },
  });
test('GSM-7, znaki rozszerzenia, polskie litery i emoji liczą jednostki i części', () => {
  assert.deepEqual(smsLength('a'.repeat(160)), { encoding: 'GSM-7', units: 160, parts: 1 });
  assert.equal(smsLength('a'.repeat(161)).parts, 2);
  assert.equal(smsLength('^'.repeat(80)).units, 160);
  assert.equal(smsLength('^'.repeat(81)).parts, 2);
  assert.deepEqual(smsLength('ą'.repeat(70)), { encoding: 'UTF-16', units: 70, parts: 1 });
  assert.equal(smsLength('ą'.repeat(71)).parts, 2);
  assert.equal(smsLength('😀'.repeat(67)).parts, 3);
});
test('normalizacja PL/E164 nie zgaduje zagranicznych numerów i odrzuca listy', () => {
  for (const p of ['500500500', '+48 500-500-500', '0048500500500', '48500500500'])
    assert.equal(smsRecipient(p, 'PL'), '48500500500');
  assert.equal(smsRecipient('+420123456789', 'CZ'), '420123456789');
  for (const p of ['', '500500500,600600600', 'abcdefgh', '500500500 ext 4'])
    assert.throws(() => smsRecipient(p, 'PL'));
  assert.throws(() => smsRecipient('123456789', 'CZ'));
});
test('szablon zna tylko jawne zmienne; limit liczony po rozwinięciu danych', async () => {
  assert.equal(
    (
      await req('/api/sms/templates', 'POST', {
        name: 'QA',
        body: '{{secret}}',
        client_key: randomUUID(),
      })
    ).statusCode,
    422,
  );
  const t = await template({ body: '{{customer_name}}', max_parts: 1 });
  const o = await order('500500500', { customer_name: 'ą'.repeat(80) });
  const b = await preview(t, [o]);
  assert.equal(b.items[0].state, 'invalid');
  assert.match(b.items[0].error, /limit/);
});
test('idempotencja tworzenia i optymistyczna edycja szablonu', async () => {
  const key = randomUUID(),
    t = await template({ client_key: key });
  assert.equal((await template({ client_key: key })).id, t.id);
  assert.equal(
    (await req('/api/sms/templates', 'POST', { name: 'inne', body: 'inna', client_key: key }))
      .statusCode,
    409,
  );
  const input = { name: t.name, body: 'zmiana', active: true, max_parts: 2, version: t.version };
  const changed = await ok('/api/sms/templates/' + t.id, 'PATCH', input);
  assert.equal(changed.version, '2');
  assert.equal((await req('/api/sms/templates/' + t.id, 'PATCH', input)).statusCode, 409);
});
test('role: admin szablony/test, operator lokalnie, viewer tylko odczyt', async () => {
  const t = await template(),
    o = await order();
  assert.equal(
    (
      await req(
        '/api/sms/templates',
        'POST',
        { name: 'QA', body: 'test', client_key: randomUUID() },
        operator,
      )
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await req(
        '/api/sms/preview',
        'POST',
        {
          template_id: t.id,
          template_version: t.version,
          order_ids: [o.id],
          client_key: randomUUID(),
        },
        viewer,
      )
    ).statusCode,
    403,
  );
  const b = await preview(t, [o], {}, operator);
  await queue(b, operator);
  const ch = await channel();
  assert.equal(
    (
      await req(
        '/api/sms/preview',
        'POST',
        {
          template_id: t.id,
          template_version: t.version,
          order_ids: [o.id],
          mode: 'provider_test',
          channel_id: ch.id,
          client_key: randomUUID(),
        },
        operator,
      )
    ).statusCode,
    403,
  );
});
test('RLS izoluje szablony, partie i historię oraz odrzuca obcy wybór atomowo', async () => {
  const t = await template(),
    o = await order(),
    b = await preview(t, [o]);
  assert.equal((await req('/api/sms/batches/' + b.id, 'GET', undefined, other)).statusCode, 404);
  assert.equal(
    (await ok('/api/sms/templates', 'GET', undefined, other)).data.some((x: any) => x.id === t.id),
    false,
  );
  assert.equal(
    (
      await req('/api/sms/preview', 'POST', {
        template_id: t.id,
        template_version: t.version,
        order_ids: [o.id, randomUUID()],
        client_key: randomUUID(),
      })
    ).statusCode,
    404,
  );
  assert.equal(
    (
      await tenantTx(SECOND_TENANT, (c) =>
        c.query('SELECT * FROM sms_messages WHERE id=$1', [b.items[0].id]),
      )
    ).rowCount,
    0,
  );
});
test('podgląd mieszany, ponowny podgląd i kolejka nie dublują wiadomości', async () => {
  const t = await template(),
    o = await order(),
    bad = await order(''),
    key = randomUUID(),
    b = await preview(t, [o, bad], { client_key: key });
  assert.deepEqual(b.items.map((m: any) => m.state).sort(), ['draft', 'invalid']);
  assert.equal((await preview(t, [bad, o], { client_key: key })).id, b.id);
  await queue(b);
  await queue(b);
  await Promise.all([tick({ transport }), tick({ transport })]);
  await drain();
  const done = await ok('/api/sms/batches/' + b.id);
  assert.equal(done.state, 'done');
  assert.ok(!done.items.find((m: any) => m.state === 'failed'), JSON.stringify(done.items));
  assert.deepEqual(done.items.map((m: any) => m.state).sort(), ['invalid', 'simulated']);
  assert.equal(providerCalls.length, 0);
  assert.equal(
    (
      await pool.query("SELECT count(*)::int n FROM jobs WHERE tenant_id=$1 AND kind='sms.test'", [
        tenant,
      ])
    ).rows[0].n,
    1,
  );
});
test('niepotwierdzone queue i inny autor są odrzuceni', async () => {
  const b = await preview(await template(), [await order()]);
  assert.equal(
    (await req('/api/sms/batches/' + b.id + '/queue', 'POST', { confirmed: false })).statusCode,
    422,
  );
  assert.equal(
    (await req('/api/sms/batches/' + b.id + '/queue', 'POST', { confirmed: true }, operator))
      .statusCode,
    403,
  );
});
test('zmiana zamówienia przed kolejką odrzuca cały podgląd', async () => {
  const b = await preview(await template(), [await order()]);
  await pool.query(
    'UPDATE orders SET address=address||\'{"phone":"600600600"}\'::jsonb WHERE id=$1',
    [b.items[0].order_id],
  );
  assert.equal(
    (await req('/api/sms/batches/' + b.id + '/queue', 'POST', { confirmed: true })).statusCode,
    409,
  );
  assert.equal((await ok('/api/sms/batches/' + b.id)).items[0].job_id, null);
});
test('edycja szablonu przed kolejką wymaga nowego podglądu', async () => {
  const t = await template(),
    b = await preview(t, [await order()]);
  await ok('/api/sms/templates/' + t.id, 'PATCH', {
    name: t.name,
    body: t.body,
    max_parts: 2,
    active: true,
    version: t.version,
  });
  assert.equal(
    (await req('/api/sms/batches/' + b.id + '/queue', 'POST', { confirmed: true })).statusCode,
    409,
  );
});
test('zmiana zamówienia po kolejce blokuje wykonanie', async () => {
  const b = await preview(await template(), [await order()]);
  await queue(b);
  await pool.query("UPDATE orders SET customer_name='zmieniony' WHERE id=$1", [
    b.items[0].order_id,
  ]);
  await drain();
  const m = (await ok('/api/sms/batches/' + b.id)).items[0];
  assert.equal(m.state, 'failed');
  assert.equal(m.attempted_at, null);
  assert.equal(providerCalls.length, 0);
});
test('utrata roli lub wyłączenie szablonu zatrzymuje kolejkę', async () => {
  const t = await template(),
    b = await preview(t, [await order()], {}, operator);
  await queue(b, operator);
  await pool.query(
    "UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=(SELECT id FROM users WHERE email='operator@demo.local')",
    [tenant],
  );
  await drain();
  assert.equal((await ok('/api/sms/batches/' + b.id)).items[0].state, 'failed');
  const b2 = await preview(t, [await order()]);
  await queue(b2);
  await pool.query('UPDATE sms_templates SET active=false WHERE id=$1', [t.id]);
  await drain();
  assert.equal((await ok('/api/sms/batches/' + b2.id)).items[0].state, 'failed');
});
test('anulowanie podglądu i oczekujących zadań nie wykonuje testu', async () => {
  const t = await template();
  for (const queued of [false, true]) {
    const b = await preview(t, [await order()]);
    if (queued) await queue(b);
    const cancelled = await ok('/api/sms/batches/' + b.id + '/cancel', 'POST', { confirmed: true });
    assert.equal(cancelled.state, 'cancelled');
    assert.equal(cancelled.items[0].state, 'cancelled');
    assert.equal(
      (await req('/api/sms/batches/' + b.id + '/queue', 'POST', { confirmed: true })).statusCode,
      409,
    );
  }
  await drain();
  assert.equal(providerCalls.length, 0);
});
test('SMSAPI profil i test używają stałego hosta, Bearer, POST/test=1/check_idx i utf8', async () => {
  const ch = await channel();
  const connection = await ok('/api/integrations/' + ch.id + '/test', 'POST', {});
  assert.equal(connection.status, 'verified_read');
  const b = await preview(await template(), [await order()], {
    mode: 'provider_test',
    channel_id: ch.id,
  });
  await queue(b);
  await drain();
  const m = (await ok('/api/sms/batches/' + b.id)).items[0];
  assert.equal(m.state, 'tested');
  assert.equal(m.result.delivered, false);
  const call = providerCalls.find((x) => x.url.endsWith('/sms.do'))!;
  assert.equal(call.url, 'https://api.smsapi.pl/sms.do');
  assert.equal(call.init.method, 'POST');
  assert.equal((call.init.headers as any).Authorization, 'Bearer fixture-token');
  const body = new URLSearchParams(String(call.init.body));
  for (const [k, v] of [
    ['test', '1'],
    ['check_idx', '1'],
    ['encoding', 'utf-8'],
    ['format', 'json'],
    ['idx', m.id.replaceAll('-', '')],
  ])
    assert.equal(body.get(k), v);
  assert.equal(body.get('to'), '48500500500');
});
test('live i sender spoza zakresu są odrzucane, token nie wycieka do rejestru', async () => {
  const base = {
    provider: 'smsapi',
    name: 'QA SMS',
    mode: 'live',
    credentials: { access_token: 'fixture-token' },
    settings: { sender: 'Test' },
  };
  assert.equal((await req('/api/integrations', 'POST', base)).statusCode, 422);
  assert.equal(
    (
      await req('/api/integrations', 'POST', {
        ...base,
        mode: 'sandbox',
        settings: { sender: 'abcdefghijkl' },
      })
    ).statusCode,
    422,
  );
  const ch = await channel();
  const c = (await ok('/api/integrations')).channels.find((x: any) => x.id === ch.id);
  assert.equal(c.credentials, undefined);
  assert.equal(JSON.stringify(c).includes('fixture-token'), false);
});
test('timeout i niejednoznaczny JSON pozostają niepewne bez ponowienia POST', async () => {
  for (const failure of [
    new Error('timeout'),
    new Response('{bad'),
    Response.json({
      count: 1,
      list: [{ id: 'x', points: 0.16, number: '48600600600', status: 'QUEUE' }],
    }),
  ]) {
    response = failure;
    const b = await preview(await template(), [await order()], {
      mode: 'provider_test',
      channel_id: (await channel()).id,
    });
    await queue(b);
    await drain();
    assert.equal((await ok('/api/sms/batches/' + b.id)).items[0].state, 'uncertain');
  }
  assert.equal(providerCalls.length, 3);
});
test('odrzucenie kodem i duplikat53 nie są traktowane jako doręczenie', async () => {
  for (const [code, state] of [
    [13, 'failed'],
    [53, 'uncertain'],
  ]) {
    response = Response.json({ error: code });
    const b = await preview(await template(), [await order()], {
      mode: 'provider_test',
      channel_id: (await channel()).id,
    });
    await queue(b);
    await drain();
    assert.equal((await ok('/api/sms/batches/' + b.id)).items[0].state, state);
  }
  assert.equal(providerCalls.length, 2);
});
test('wygasła dzierżawa po rozpoczęciu próby nie powtarza testu', async () => {
  const b = await preview(await template(), [await order()], {
    mode: 'provider_test',
    channel_id: (await channel()).id,
  });
  await queue(b);
  const m = (await ok('/api/sms/batches/' + b.id)).items[0];
  await pool.query('UPDATE sms_messages SET attempted_at=now() WHERE id=$1', [m.id]);
  await pool.query(
    "UPDATE jobs SET state='running',attempts=1,lease_token=$2,locked_at=now()-interval '3 minutes' WHERE id=$1",
    [m.job_id, randomUUID()],
  );
  await drain();
  assert.equal((await ok('/api/sms/batches/' + b.id)).items[0].state, 'uncertain');
  assert.equal(providerCalls.length, 0);
});
test('stary token dzierżawy nie zapisuje wyniku i nie kontaktuje się z API', async () => {
  const b = await preview(await template(), [await order()], {
    mode: 'provider_test',
    channel_id: (await channel()).id,
  });
  await queue(b);
  const m = (await ok('/api/sms/batches/' + b.id)).items[0],
    j = (
      await pool.query("UPDATE jobs SET state='running',lease_token=$2 WHERE id=$1 RETURNING *", [
        m.job_id,
        randomUUID(),
      ])
    ).rows[0];
  await processSms({ ...j, lease_token: randomUUID() }, { transport });
  assert.equal(providerCalls.length, 0);
  assert.equal((await ok('/api/sms/batches/' + b.id)).items[0].attempted_at, null);
});
test('limit250 i duplikaty wyboru są jawnie odrzucone', async () => {
  const t = await template(),
    o = await order();
  for (const ids of [[o.id, o.id], Array.from({ length: 251 }, () => randomUUID())])
    assert.equal(
      (
        await req('/api/sms/preview', 'POST', {
          template_id: t.id,
          template_version: t.version,
          order_ids: ids,
          client_key: randomUUID(),
        })
      ).statusCode,
      422,
    );
});
test('historia stronicuje bez powtórek i filtruje zamówienie', async () => {
  const t = await template(),
    orders = [];
  for (let i = 0; i < 27; i++) orders.push(await order());
  await queue(await preview(t, orders));
  await drain();
  const first = await ok('/api/sms/messages');
  assert.equal(first.data.length, 25);
  assert.ok(first.meta.cursor);
  const second = await ok('/api/sms/messages?after=' + first.meta.cursor);
  assert.equal(second.data.length, 2);
  assert.equal(new Set([...first.data, ...second.data].map((m) => m.id)).size, 27);
  assert.equal((await ok('/api/sms/messages?order_id=' + orders[0].id)).data.length, 1);
});
test('komunikacja API v1 wymaga zakresu, klucze nie ujawniają tokenu kanału', async () => {
  const t = await template(),
    o = await order(),
    read = (
      await ok('/api/developer/keys', 'POST', {
        name: 'QA SMS read',
        scopes: ['communications:read'],
      })
    ).token,
    writeKey = (
      await ok('/api/developer/keys', 'POST', {
        name: 'QA SMS write',
        scopes: ['communications:read', 'communications:write'],
      })
    ).token;
  assert.ok(read && writeKey);
  const call = (token: string, url: string, method: any = 'GET', payload?: any) =>
    app.inject({
      url: '/api/v1' + url,
      method,
      payload,
      headers: { authorization: 'Bearer ' + token },
    });
  assert.equal((await call(read, '/sms/templates')).statusCode, 200);
  const input = {
    template_id: t.id,
    template_version: t.version,
    order_ids: [o.id],
    client_key: randomUUID(),
  };
  assert.equal((await call(read, '/sms/preview', 'POST', input)).statusCode, 403);
  const p = await call(writeKey, '/sms/preview', 'POST', input);
  assert.equal(p.statusCode, 200, p.body);
  assert.equal(
    (await call(writeKey, '/sms/batches/' + p.json().id + '/queue', 'POST', { confirmed: true }))
      .statusCode,
    200,
  );
  const schema = (await ok('/api/developer/openapi')).paths;
  assert.ok(schema['/sms/preview']);
});
test('baza chroni treść podglądu i znacznik rozpoczętej próby', async () => {
  const b = await preview(await template(), [await order()]),
    m = b.items[0];
  await assert.rejects(
    tenantTx(tenant, (c) =>
      c.query("UPDATE sms_messages SET payload='zmiana' WHERE id=$1", [m.id]),
    ),
    /niezmienne/,
  );
  await queue(b);
  await drain();
  await assert.rejects(
    tenantTx(tenant, (c) =>
      c.query('UPDATE sms_messages SET attempted_at=NULL WHERE id=$1', [m.id]),
    ),
    /rozpoczętej/,
  );
  await assert.rejects(
    tenantTx(tenant, (c) => c.query('DELETE FROM sms_messages WHERE id=$1', [m.id])),
    /permission denied/,
  );
});
test('zmiana poświadczeń po kolejce zatrzymuje test przed POST', async () => {
  const ch = await channel(),
    b = await preview(await template(), [await order()], {
      mode: 'provider_test',
      channel_id: ch.id,
    });
  await queue(b);
  await pool.query(
    'UPDATE channels SET settings=settings||\'{"sender":"Zmiana"}\'::jsonb WHERE id=$1',
    [ch.id],
  );
  await drain();
  const m = (await ok('/api/sms/batches/' + b.id)).items[0];
  assert.equal(m.state, 'failed');
  assert.match(m.error, /Połączenie/);
  assert.equal(providerCalls.length, 0);
});
test('współbieżne zatwierdzenie tej samej partii tworzy jedną pracę na wiadomość', async () => {
  const b = await preview(await template(), [await order()]);
  const [a, c] = await Promise.all([queue(b), queue(b)]);
  assert.equal(a.id, c.id);
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM jobs WHERE tenant_id=$1 AND kind='sms.test'",
        [tenant],
      )
    ).rows[0].n,
    1,
  );
  await drain();
  assert.equal((await ok('/api/sms/batches/' + b.id)).items[0].state, 'simulated');
});
test('backpressure odrzuca całą partię bez częściowego zapisu zadań', async () => {
  const b = await preview(await template(), [await order(), await order(), await order()]);
  await pool.query(
    "INSERT INTO jobs(id,tenant_id,kind,payload,dedup_key,run_at) SELECT gen_random_uuid(),$1,'qa.capacity','{}','capacity:'||n,now()+interval '1 day' FROM generate_series(1,998)n",
    [tenant],
  );
  const rejected = await req('/api/sms/batches/' + b.id + '/queue', 'POST', { confirmed: true });
  assert.equal(rejected.statusCode, 409, rejected.body);
  assert.match(rejected.json().detail, /pełna/);
  assert(
    (await ok('/api/sms/batches/' + b.id)).items.every(
      (m: any) => m.state === 'draft' && !m.job_id,
    ),
  );
});
test('pełna partia250 jest trwała i przetwarzana bez sieci', async () => {
  const t = await template(),
    orders = [];
  for (let n = 0; n < 250; n++) orders.push(await order());
  const start = performance.now(),
    b = await preview(t, orders);
  await queue(b);
  // Creating orders also enqueues their event dispatcher; drain both queues.
  for (let n = 0; n < 600; n++) if (!(await tick({ transport }))) break;
  const done = await ok('/api/sms/batches/' + b.id);
  assert.equal(done.items.length, 250);
  assert(done.items.every((m: any) => m.state === 'simulated'));
  assert.equal(done.state, 'done');
  assert.equal(providerCalls.length, 0);
  console.log(
    JSON.stringify({
      sms_local_batch: 250,
      preview_queue_worker_ms: Math.round(performance.now() - start),
      scope: 'synthetic fixture; no target-scale claim',
    }),
  );
});
