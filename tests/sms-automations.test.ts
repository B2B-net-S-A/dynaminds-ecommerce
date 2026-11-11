import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../server/app';
import { pool, migrate, tenantTx } from '../server/db';
import { seed, SECOND_TENANT } from './fixtures';
import { smsLength, smsRecipient, renderSms, processSms } from '../server/sms';
import { SmsApi, SmsRejected } from '../server/smsapi';
import { scheduleAutomationsDue } from '../server/automation-schedules';
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
  for (let i = 0; i < 300; i++) if (!(await tick({ transport }))) return;
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
const action = (t: any, extra: any = {}) => ({
  type: 'sms',
  template_id: t.id,
  mode: 'local',
  ...extra,
});
const rule = (actions: any[], extra: any = {}) =>
  ok('/api/automations', 'POST', {
    name: 'QA SMS rule',
    trigger: 'order.created',
    actions,
    ...extra,
  });
async function smsRows() {
  return (
    await pool.query(
      'SELECT m.*,b.automation_run_id,b.automation_schedule_run_id,b.order_batch_id,b.order_guard FROM sms_messages m JOIN sms_batches b ON (b.tenant_id,b.id)=(m.tenant_id,m.batch_id) WHERE m.tenant_id=$1 ORDER BY m.id',
      [tenant],
    )
  ).rows;
}
async function pendingMessages() {
  for (let n = 0; n < 100; n++) {
    const rows = await smsRows();
    if (rows.length) return rows;
    assert(await tick({ transport }));
  }
  throw new Error('No SMS intent');
}
async function createSchedule(t: any, extra: any = {}) {
  return ok('/api/automation-schedules', 'POST', {
    name: 'QA SMS schedule',
    enabled: true,
    frequency: { kind: 'interval', seconds: 3600 },
    statuses: ['new'],
    min_age_seconds: 0,
    actions: [action(t)],
    client_key: randomUUID(),
    ...extra,
  });
}
const runSchedule = (s: any) =>
  ok('/api/automation-schedules/' + s.id + '/run', 'POST', {
    version: s.version,
    client_key: randomUUID(),
    confirmed: true,
  });
test('pojedynczy SMS ma podgląd bez zapisów, potwierdzenie i idempotencję', async () => {
  const t = await template(),
    o = await order(),
    input = action(t, { template_version: t.version, client_key: randomUUID() });
  const p = await ok('/api/orders/' + o.id + '/operations/preview', 'POST', input);
  assert.equal(p.allowed, true);
  Object.assign(input, p.actions[0], { order_version: p.order_version });
  assert.match(p.result[0].sms.payload, /QA SMS/);
  assert.equal((await smsRows()).length, 0);
  assert.equal((await req('/api/orders/' + o.id + '/operations', 'POST', input)).statusCode, 422);
  const [a, b] = await Promise.all([
    ok('/api/orders/' + o.id + '/operations', 'POST', { ...input, confirmed: true }),
    ok('/api/orders/' + o.id + '/operations', 'POST', { ...input, confirmed: true }),
  ]);
  assert.equal(a.sms.message_id, b.sms.message_id);
  assert.equal((await smsRows()).length, 1);
  await drain();
  assert.equal((await smsRows())[0].state, 'simulated');
  assert.equal(providerCalls.length, 0);
});
test('reguła zapisuje SMS atomowo z notatką; późniejsza notatka nie blokuje treści', async () => {
  const t = await template(),
    r = await rule([action(t), { type: 'add_note', note: 'Dalsza notatka' }]),
    o = await order();
  await drain();
  const m = (await smsRows())[0];
  assert.equal(m.state, 'simulated');
  assert.equal(m.order_guard, 'content');
  assert.ok(m.automation_run_id);
  assert.equal((await ok('/api/orders/' + o.id)).note, 'Dalsza notatka');
  const run = (await pool.query('SELECT * FROM automation_runs WHERE rule_id=$1', [r.id])).rows[0];
  assert.equal(run.state, 'done');
  assert.equal(run.result.actions[0].sms.state, 'queued');
  assert.equal(providerCalls.length, 0);
});
test('późniejsza niepoprawna akcja cofa wiadomość i notatkę', async () => {
  const t = await template(),
    r = await rule([
      action(t),
      { type: 'add_note', note: 'Nie zapisz' },
      { type: 'set_status', status: 'shipped' },
    ]),
    o = await order();
  await drain();
  assert.equal((await smsRows()).length, 0);
  assert.equal((await ok('/api/orders/' + o.id)).note, '');
  assert.equal(
    (await pool.query('SELECT state FROM automation_runs WHERE rule_id=$1', [r.id])).rows[0].state,
    'failed',
  );
});
test('brak telefonu i nieaktywny szablon nie blokują utworzenia zamówienia', async () => {
  const t = await template(),
    r = await rule([action(t)]),
    o = await order('');
  await drain();
  assert.ok(o.id);
  assert.equal((await smsRows()).length, 0);
  await pool.query('UPDATE sms_templates SET active=false WHERE id=$1', [t.id]);
  const o2 = await order();
  await drain();
  assert.ok(o2.id);
  assert.equal((await smsRows()).length, 0);
  assert(
    (await pool.query('SELECT state FROM automation_runs WHERE rule_id=$1', [r.id])).rows.every(
      (r) => r.state === 'failed',
    ),
  );
});
test('zdarzenie zamraża wersję szablonu; późniejsza edycja nie podmienia treści', async () => {
  const t = await template(),
    r = await rule([action(t)]);
  await order();
  await ok('/api/sms/templates/' + t.id, 'PATCH', {
    name: t.name,
    body: 'Nowa treść',
    max_parts: 3,
    active: true,
    version: t.version,
  });
  await drain();
  assert.equal((await smsRows()).length, 0);
  const run = (await pool.query('SELECT * FROM automation_runs WHERE rule_id=$1', [r.id])).rows[0];
  assert.equal(run.definition.actions[0].template_version, '1');
  assert.equal(run.state, 'failed');
  assert.match(run.error, /zmienił/);
});
test('wyłączenie reguły po utworzeniu intencji zatrzymuje SMS przed testem', async () => {
  const t = await template(),
    r = await rule([action(t)]);
  await order();
  const pending = await pendingMessages();
  assert.equal(pending[0].state, 'queued');
  await ok('/api/automations/' + r.id, 'PATCH', { enabled: false, version: r.version });
  await drain();
  const m = (await smsRows())[0];
  assert.equal(m.state, 'failed');
  assert.match(m.error, /reguła/);
  assert.equal(m.attempted_at, null);
  assert.equal(providerCalls.length, 0);
});
test('zmiana telefonu po intencji zatrzymuje wiadomość', async () => {
  const t = await template();
  await rule([action(t)]);
  const o = await order();
  await pendingMessages();
  await pool.query(
    'UPDATE orders SET address=address||\'{"phone":"600600600"}\'::jsonb WHERE id=$1',
    [o.id],
  );
  await drain();
  assert.equal((await smsRows())[0].state, 'failed');
  assert.match((await smsRows())[0].error, /Zamówienie/);
});
test('SMSAPI automatyzacji wykorzystuje ten sam test=1 i trwały wynik, bez doręczenia', async () => {
  const t = await template(),
    ch = await channel();
  await rule([action(t, { mode: 'provider_test', channel_id: ch.id })]);
  await order();
  await drain();
  const m = (await smsRows())[0];
  assert.equal(m.state, 'tested');
  assert.equal(m.result.delivered, false);
  assert.equal(providerCalls.length, 1);
  assert.equal(new URLSearchParams(String(providerCalls[0].init.body)).get('test'), '1');
});
test('obce i nieaktywne referencje są odrzucane również w wyłączonej definicji', async () => {
  const t = await template();
  assert.equal(
    (
      await req('/api/automations', 'POST', {
        name: 'QA invalid',
        trigger: 'order.created',
        enabled: false,
        actions: [action({ id: randomUUID() })],
      })
    ).statusCode,
    422,
  );
  assert.equal(
    (
      await req('/api/automation-schedules', 'POST', {
        name: 'QA invalid',
        enabled: false,
        frequency: { kind: 'interval', seconds: 60 },
        statuses: ['new'],
        actions: [action(t, { mode: 'provider_test', channel_id: randomUUID() })],
        client_key: randomUUID(),
      })
    ).statusCode,
    422,
  );
});
test('operacja masowa ma podgląd bez intencji i atomowy wynik każdej pozycji', async () => {
  const t = await template(),
    good = await order(),
    bad = await order(''),
    p = await ok('/api/orders/batches/preview', 'POST', {
      order_ids: [good.id, bad.id],
      action: action(t),
    });
  assert.equal((await smsRows()).length, 0);
  assert.equal(p.items.filter((i: any) => i.allowed).length, 1);
  await ok('/api/order-batches/' + p.id + '/queue', 'POST', { confirmed: true });
  await drain();
  const m = (await smsRows())[0];
  assert.equal(m.state, 'simulated');
  assert.equal(m.order_batch_id, p.id);
  const b = await ok('/api/order-batches/' + p.id);
  assert.equal(b.state, 'done');
  assert.deepEqual(b.items.map((i: any) => i.state).sort(), ['done', 'skipped']);
});
test('operator nie kolejkuje testu SMSAPI przez akcję pojedynczą ani bulk', async () => {
  const t = await template(),
    o = await order(),
    ch = await channel(),
    a = action(t, {
      mode: 'provider_test',
      channel_id: ch.id,
      client_key: randomUUID(),
      confirmed: true,
    });
  assert.equal(
    (await req('/api/orders/' + o.id + '/operations', 'POST', a, operator)).statusCode,
    403,
  );
  const p = await ok(
    '/api/orders/batches/preview',
    'POST',
    { order_ids: [o.id], action: a },
    operator,
  );
  assert.equal(p.items[0].allowed, false);
  assert.equal((await smsRows()).length, 0);
});
test('harmonogram kolejkuje raz na definicję, kolejne wykonanie nie dubluje SMS', async () => {
  const t = await template();
  await order();
  const s = await createSchedule(t),
    r = await runSchedule(s);
  await drain();
  assert.equal((await smsRows()).length, 1);
  assert.equal((await smsRows())[0].state, 'simulated');
  assert.equal((await smsRows())[0].automation_schedule_run_id, r.id);
  const second = await runSchedule(s);
  await drain();
  const result = await ok('/api/automation-schedule-runs/' + second.id);
  assert.equal(result.scanned, 0);
  assert.equal((await smsRows()).length, 1);
});
test('harmonogram each_run wykonuje kolejne intencje, pauza zatrzymuje oczekujące', async () => {
  const t = await template();
  await order();
  const s = await createSchedule(t, { repetition: 'each_run' });
  await runSchedule(s);
  await drain();
  await runSchedule(s);
  await pendingMessages();
  // Wait specifically for the new queued message, not the already completed first cycle.
  for (let n = 0; n < 30 && !(await smsRows()).some((m) => m.state === 'queued'); n++)
    await tick({ transport });
  await ok('/api/automation-schedules/' + s.id, 'PATCH', { enabled: false, version: s.version });
  await drain();
  const rows = await smsRows();
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((m) => m.state).sort(), ['failed', 'simulated']);
  assert.match(rows.find((m) => m.state === 'failed').error, /harmonogram/);
});
test('harmonogram freeze blokuje edycję szablonu między enqueue a wykonaniem', async () => {
  const t = await template();
  await order();
  const s = await createSchedule(t),
    r = await runSchedule(s);
  await ok('/api/sms/templates/' + t.id, 'PATCH', {
    name: t.name,
    body: 'inna',
    max_parts: 3,
    active: true,
    version: t.version,
  });
  await drain();
  assert.equal((await smsRows()).length, 0);
  const run = await ok('/api/automation-schedule-runs/' + r.id);
  assert.equal(run.failed, 1);
  assert.equal(run.definition.actions[0].template_version, t.version);
});
test('edytowana treść użyta przez następne zdarzenie ma nową zamrożoną wersję', async () => {
  const t = await template();
  await rule([action(t)]);
  await order();
  await drain();
  await ok('/api/sms/templates/' + t.id, 'PATCH', {
    name: t.name,
    body: 'Nowy {{order_number}}',
    max_parts: 3,
    active: true,
    version: t.version,
  });
  await order();
  await drain();
  const rows = await smsRows();
  assert.equal(rows.length, 2);
  assert(rows.every((m) => m.state === 'simulated'));
  assert(rows.some((m) => m.payload.startsWith('Nowy ')));
});
test('reguła z dwoma SMS ma odrębne identyfikatory akcji i bez replay duplikatów', async () => {
  const t = await template();
  await rule([action(t), action(t)]);
  await order();
  await drain();
  const rows = await smsRows();
  assert.equal(rows.length, 2);
  assert.equal(new Set(rows.map((m) => m.id)).size, 2);
  assert(rows.every((m) => m.state === 'simulated'));
});
test('podgląd API v1 korzysta z orders:write, historia nadal wymaga communications:read', async () => {
  const t = await template(),
    o = await order(),
    k = (await ok('/api/developer/keys', 'POST', { name: 'QA actions', scopes: ['orders:write'] }))
      .token;
  const r = await app.inject({
    url: '/api/v1/orders/' + o.id + '/operations/preview',
    method: 'POST',
    payload: action(t),
    headers: { authorization: 'Bearer ' + k },
  });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().allowed, true);
  assert.equal((await smsRows()).length, 0);
  const denied = await app.inject({
    url: '/api/v1/sms/messages',
    headers: { authorization: 'Bearer ' + k },
  });
  assert.equal(denied.statusCode, 403);
});
test('zmiana zamówienia po pojedynczym podglądzie wymaga nowego potwierdzenia', async () => {
  const t = await template(),
    o = await order(),
    input = action(t, { client_key: randomUUID() });
  const p = await ok('/api/orders/' + o.id + '/operations/preview', 'POST', input);
  await ok('/api/orders/' + o.id + '/operations', 'POST', {
    type: 'add_note',
    note: 'Zmiana po podglądzie',
  });
  const r = await req('/api/orders/' + o.id + '/operations', 'POST', {
    ...p.actions[0],
    confirmed: true,
    order_version: p.order_version,
  });
  assert.equal(r.statusCode, 409, r.body);
  assert.equal((await smsRows()).length, 0);
});
test('odebrane uprawnienia autora po intencji blokują SMS reguły', async () => {
  const t = await template();
  await rule([action(t)]);
  await order();
  await pendingMessages();
  await pool.query(
    "UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=(SELECT id FROM users WHERE email='admin@demo.local')",
    [tenant],
  );
  await drain();
  const m = (await smsRows())[0];
  assert.equal(m.state, 'failed');
  assert.equal(m.attempted_at, null);
  assert.equal(providerCalls.length, 0);
});
test('zmiana poświadczeń po zdarzeniu blokuje zamrożony kanał reguły', async () => {
  const t = await template(),
    ch = await channel();
  await rule([action(t, { mode: 'provider_test', channel_id: ch.id })]);
  await order();
  await pool.query(
    'UPDATE channels SET settings=settings||\'{"sender":"Changed"}\'::jsonb WHERE id=$1',
    [ch.id],
  );
  await drain();
  assert.equal((await smsRows()).length, 0);
  assert.equal(providerCalls.length, 0);
  const run = (await pool.query('SELECT * FROM automation_runs WHERE tenant_id=$1', [tenant]))
    .rows[0];
  assert.equal(run.state, 'failed');
  assert.match(run.error, /Połączenie/);
});
test('kolejkowana partia SMS nie pozwala przepisać pochodzenia ani ochrony zamówienia', async () => {
  const t = await template();
  await rule([action(t)]);
  await order();
  await pendingMessages();
  const m = (await smsRows())[0];
  await assert.rejects(
    pool.query("UPDATE sms_batches SET automation_run_id=NULL,order_guard='version' WHERE id=$1", [
      m.batch_id,
    ]),
    /niezmienne/,
  );
  await drain();
  assert.equal((await smsRows())[0].state, 'simulated');
});
test('podgląd pojedynczy zamraża szablon i kanał przed potwierdzeniem', async () => {
  const t = await template(),
    ch = await channel(),
    o = await order();
  const input = action(t, { mode: 'provider_test', channel_id: ch.id, client_key: randomUUID() });
  const p = await ok('/api/orders/' + o.id + '/operations/preview', 'POST', input);
  assert.equal(p.actions[0].template_version, t.version);
  assert.match(p.actions[0].channel_hash, /^[a-f0-9]{64}$/);
  await ok('/api/sms/templates/' + t.id, 'PATCH', {
    name: t.name,
    body: 'Nowa treść',
    max_parts: 3,
    active: true,
    version: t.version,
  });
  assert.equal(
    (
      await req('/api/orders/' + o.id + '/operations', 'POST', {
        ...p.actions[0],
        confirmed: true,
        order_version: p.order_version,
      })
    ).statusCode,
    409,
  );
  const fresh = await ok('/api/orders/' + o.id + '/operations/preview', 'POST', input);
  await pool.query(
    'UPDATE channels SET settings=settings||\'{"sender":"Changed"}\'::jsonb WHERE id=$1',
    [ch.id],
  );
  assert.equal(
    (
      await req('/api/orders/' + o.id + '/operations', 'POST', {
        ...fresh.actions[0],
        confirmed: true,
        order_version: fresh.order_version,
      })
    ).statusCode,
    409,
  );
  assert.equal((await smsRows()).length, 0);
  assert.equal(providerCalls.length, 0);
});
