import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { SMTPServer } from 'smtp-server';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../server/app';
import { pool, migrate, tenantTx } from '../server/db';
import { seed, SECOND_TENANT } from './fixtures';
import { processEmail, emailTemplate, validateEmailTemplate } from '../server/email';
import { SmtpClient, localSmtpPassword, smtpSettings } from '../server/smtp';
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
let received: string[] = [],
  rejectData = false,
  authenticated = 0;
const smtp = new SMTPServer({
  secure: false,
  disabledCommands: ['STARTTLS'],
  allowInsecureAuth: true,
  logger: false,
  onAuth(auth, _s, cb) {
    if (auth.username === 'dyna-local' && auth.password === localSmtpPassword()) {
      authenticated++;
      cb(null, { user: 'qa' });
    } else cb(new Error('Auth refused'));
  },
  onRcptTo(a, _s, cb) {
    cb(a.address.endsWith('.test') ? undefined : new Error('Only .test'));
  },
  onData(stream, _s, cb) {
    const b: Buffer[] = [];
    stream.on('data', (c) => b.push(c));
    stream.on('end', () => {
      received.push(Buffer.concat(b).toString('utf8'));
      cb(rejectData ? new Error('QA no final acceptance') : undefined);
    });
  },
});
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
  app = await buildApp();
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
  await new Promise<void>((resolve, reject) => {
    smtp.once('error', reject);
    smtp.listen(1025, '127.0.0.1', resolve);
  });
});
beforeEach(async () => {
  await pool.query("UPDATE jobs SET state='done',lease_token=NULL");
  tenant = randomUUID();
  await pool.query("INSERT INTO tenants(id,name,plan) VALUES($1,'Email QA','enterprise')", [
    tenant,
  ]);
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
  await pool.query("INSERT INTO warehouses(id,tenant_id,name,code) VALUES($1,$2,'Email','EMAIL')", [
    warehouse,
    tenant,
  ]);
  product = (
    await ok('/api/products', 'POST', {
      sku: 'EMAIL-' + randomUUID(),
      name: 'Email QA',
      price: 12345,
      warehouse_id: warehouse,
      quantity: 10000,
    })
  ).id;
  received = [];
  rejectData = false;
  authenticated = 0;
});
after(async () => {
  await new Promise<void>((resolve) => smtp.close(resolve));
  await app.close();
  await pool.end();
});
const template = (extra: any = {}, cookie = admin) =>
  ok(
    '/api/email/templates',
    'POST',
    {
      name: 'Informacja o zamówieniu',
      subject: 'Zamówienie {{order_number}}',
      body: 'Dzień dobry {{customer_name}}, {{total}} {{currency}}, {{status}}. Śledzenie {{tracking_number}}.',
      html: '<p>Dzień dobry <strong>{{customer_name}}</strong></p>',
      client_key: randomUUID(),
      ...extra,
    },
    cookie,
  );
const order = (extra: any = {}) =>
  ok('/api/orders', 'POST', {
    customer_name: 'QA Email',
    email: 'buyer@example.test',
    warehouse_id: warehouse,
    address: { country: 'PL' },
    items: [{ product_id: product, quantity: 2 }],
    ...extra,
  });
// Historical/imported rows may lack an email; manual order API correctly requires one.
async function orderWithoutEmail() {
  const o = await order();
  await pool.query("UPDATE orders SET email='' WHERE id=$1", [o.id]);
  return o;
}
const preview = (t: any, orders: any[], extra: any = {}, cookie = admin) =>
  ok(
    '/api/email/preview',
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
const queue = (b: any, cookie = admin) =>
  ok('/api/email/batches/' + b.id + '/queue', 'POST', { confirmed: true }, cookie);
const localChannel = async () =>
  (await ok('/api/integrations/smtp-example', 'POST', {})).channel_id;
async function drain() {
  for (let i = 0; i < 260; i++) if (!(await tick())) return;
  throw new Error('Worker did not drain');
}
const action = (t: any, extra: any = {}) => ({
  type: 'email',
  template_id: t.id,
  mode: 'local',
  ...extra,
});
const rule = (actions: any[], extra: any = {}) =>
  ok('/api/automations', 'POST', {
    name: 'QA Email rule',
    trigger: 'order.created',
    actions,
    ...extra,
  });
async function emailRows() {
  return (
    await pool.query(
      'SELECT m.*,b.automation_run_id,b.automation_schedule_run_id,b.order_batch_id,b.order_guard FROM email_messages m JOIN email_batches b ON (b.tenant_id,b.id)=(m.tenant_id,m.batch_id) WHERE m.tenant_id=$1 ORDER BY m.id',
      [tenant],
    )
  ).rows;
}
async function pendingMessages() {
  for (let n = 0; n < 100; n++) {
    const rows = await emailRows();
    if (rows.length) return rows;
    assert(await tick());
  }
  throw new Error('No Email intent');
}
async function createSchedule(t: any, extra: any = {}) {
  return ok('/api/automation-schedules', 'POST', {
    name: 'QA Email schedule',
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
test('pojedynczy email ma podgląd bez zapisów, potwierdzenie i idempotencję', async () => {
  const t = await template(),
    o = await order(),
    input = action(t, { template_version: t.version, client_key: randomUUID() });
  const p = await ok('/api/orders/' + o.id + '/operations/preview', 'POST', input);
  assert.equal(p.allowed, true);
  Object.assign(input, p.actions[0], { order_version: p.order_version });
  assert.match(p.result[0].email.payload.text, /QA Email/);
  assert.equal((await emailRows()).length, 0);
  assert.equal((await req('/api/orders/' + o.id + '/operations', 'POST', input)).statusCode, 422);
  const [a, b] = await Promise.all([
    ok('/api/orders/' + o.id + '/operations', 'POST', { ...input, confirmed: true }),
    ok('/api/orders/' + o.id + '/operations', 'POST', { ...input, confirmed: true }),
  ]);
  assert.equal(a.email.message_id, b.email.message_id);
  assert.equal((await emailRows()).length, 1);
  await drain();
  assert.equal((await emailRows())[0].state, 'simulated');
  assert.equal(received.length, 0);
});
test('reguła zapisuje email atomowo z notatką; późniejsza notatka nie blokuje treści', async () => {
  const t = await template(),
    r = await rule([action(t), { type: 'add_note', note: 'Dalsza notatka' }]),
    o = await order();
  await drain();
  const m = (await emailRows())[0];
  assert.equal(m.state, 'simulated');
  assert.equal(m.order_guard, 'content');
  assert.ok(m.automation_run_id);
  assert.equal((await ok('/api/orders/' + o.id)).note, 'Dalsza notatka');
  const run = (await pool.query('SELECT * FROM automation_runs WHERE rule_id=$1', [r.id])).rows[0];
  assert.equal(run.state, 'done');
  assert.equal(run.result.actions[0].email.state, 'queued');
  assert.equal(received.length, 0);
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
  assert.equal((await emailRows()).length, 0);
  assert.equal((await ok('/api/orders/' + o.id)).note, '');
  assert.equal(
    (await pool.query('SELECT state FROM automation_runs WHERE rule_id=$1', [r.id])).rows[0].state,
    'failed',
  );
});
test('brak adresu email i nieaktywny szablon nie blokują utworzenia zamówienia', async () => {
  const t = await template(),
    r = await rule([action(t)]),
    o = await orderWithoutEmail();
  await drain();
  assert.ok(o.id);
  assert.equal((await emailRows()).length, 0);
  await pool.query('UPDATE email_templates SET active=false WHERE id=$1', [t.id]);
  const o2 = await order();
  await drain();
  assert.ok(o2.id);
  assert.equal((await emailRows()).length, 0);
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
  await ok('/api/email/templates/' + t.id, 'PATCH', {
    name: t.name,
    body: 'Nowa treść',
    subject: t.subject,
    html: t.html,
    active: true,
    version: t.version,
  });
  await drain();
  assert.equal((await emailRows()).length, 0);
  const run = (await pool.query('SELECT * FROM automation_runs WHERE rule_id=$1', [r.id])).rows[0];
  assert.equal(run.definition.actions[0].template_version, '1');
  assert.equal(run.state, 'failed');
  assert.match(run.error, /zmienił/);
});
test('wyłączenie reguły po utworzeniu intencji zatrzymuje email przed testem', async () => {
  const t = await template(),
    r = await rule([action(t)]);
  await order();
  const pending = await pendingMessages();
  assert.equal(pending[0].state, 'queued');
  await ok('/api/automations/' + r.id, 'PATCH', { enabled: false, version: r.version });
  await drain();
  const m = (await emailRows())[0];
  assert.equal(m.state, 'failed');
  assert.equal(m.attempted_at, null);
  assert.equal(m.attempted_at, null);
  assert.equal(received.length, 0);
});
test('zmiana adresu email po intencji zatrzymuje wiadomość', async () => {
  const t = await template();
  await rule([action(t)]);
  const o = await order();
  await pendingMessages();
  await pool.query("UPDATE orders SET email='changed@example.test' WHERE id=$1", [o.id]);
  await drain();
  assert.equal((await emailRows())[0].state, 'failed');
  assert.equal((await emailRows())[0].attempted_at, null);
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
        actions: [action(t, { mode: 'smtp', channel_id: randomUUID() })],
        client_key: randomUUID(),
      })
    ).statusCode,
    422,
  );
});
test('operacja masowa ma podgląd bez intencji i atomowy wynik każdej pozycji', async () => {
  const t = await template(),
    good = await order(),
    bad = await orderWithoutEmail(),
    p = await ok('/api/orders/batches/preview', 'POST', {
      order_ids: [good.id, bad.id],
      action: action(t),
    });
  assert.equal((await emailRows()).length, 0);
  assert.equal(p.items.filter((i: any) => i.allowed).length, 1);
  await ok('/api/order-batches/' + p.id + '/queue', 'POST', { confirmed: true });
  await drain();
  const m = (await emailRows())[0];
  assert.equal(m.state, 'simulated');
  assert.equal(m.order_batch_id, p.id);
  const b = await ok('/api/order-batches/' + p.id);
  assert.equal(b.state, 'done');
  assert.deepEqual(b.items.map((i: any) => i.state).sort(), ['done', 'skipped']);
});

test('harmonogram kolejkuje raz na definicję, kolejne wykonanie nie dubluje email', async () => {
  const t = await template();
  await order();
  const s = await createSchedule(t),
    r = await runSchedule(s);
  await drain();
  assert.equal((await emailRows()).length, 1);
  assert.equal((await emailRows())[0].state, 'simulated');
  assert.equal((await emailRows())[0].automation_schedule_run_id, r.id);
  const second = await runSchedule(s);
  await drain();
  const result = await ok('/api/automation-schedule-runs/' + second.id);
  assert.equal(result.scanned, 0);
  assert.equal((await emailRows()).length, 1);
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
  for (let n = 0; n < 30 && !(await emailRows()).some((m) => m.state === 'queued'); n++)
    await tick();
  await ok('/api/automation-schedules/' + s.id, 'PATCH', { enabled: false, version: s.version });
  await drain();
  const rows = await emailRows();
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((m) => m.state).sort(), ['failed', 'simulated']);
  assert.equal(rows.find((m) => m.state === 'failed').attempted_at, null);
});
test('harmonogram freeze blokuje edycję szablonu między enqueue a wykonaniem', async () => {
  const t = await template();
  await order();
  const s = await createSchedule(t),
    r = await runSchedule(s);
  await ok('/api/email/templates/' + t.id, 'PATCH', {
    name: t.name,
    body: 'inna',
    subject: t.subject,
    html: t.html,
    active: true,
    version: t.version,
  });
  await drain();
  assert.equal((await emailRows()).length, 0);
  const run = await ok('/api/automation-schedule-runs/' + r.id);
  assert.equal(run.failed, 1);
  assert.equal(run.definition.actions[0].template_version, t.version);
});
test('edytowana treść użyta przez następne zdarzenie ma nową zamrożoną wersję', async () => {
  const t = await template();
  await rule([action(t)]);
  await order();
  await drain();
  await ok('/api/email/templates/' + t.id, 'PATCH', {
    name: t.name,
    body: 'Nowy {{order_number}}',
    subject: t.subject,
    html: t.html,
    active: true,
    version: t.version,
  });
  await order();
  await drain();
  const rows = await emailRows();
  assert.equal(rows.length, 2);
  assert(rows.every((m) => m.state === 'simulated'));
  assert(rows.some((m) => m.payload.text.startsWith('Nowy ')));
});
test('reguła z dwoma email ma odrębne identyfikatory akcji i bez replay duplikatów', async () => {
  const t = await template();
  await rule([action(t), action(t)]);
  await order();
  await drain();
  const rows = await emailRows();
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
  assert.equal((await emailRows()).length, 0);
  const denied = await app.inject({
    url: '/api/v1/email/messages',
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
  assert.equal((await emailRows()).length, 0);
});
test('odebrane uprawnienia autora po intencji blokują email reguły', async () => {
  const t = await template();
  await rule([action(t)]);
  await order();
  await pendingMessages();
  await pool.query(
    "UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=(SELECT id FROM users WHERE email='admin@demo.local')",
    [tenant],
  );
  await drain();
  const m = (await emailRows())[0];
  assert.equal(m.state, 'failed');
  assert.equal(m.attempted_at, null);
  assert.equal(received.length, 0);
});
test('zmiana poświadczeń po zdarzeniu blokuje zamrożony kanał reguły', async () => {
  const t = await template(),
    ch = { id: await localChannel() };
  await rule([action(t, { mode: 'smtp', channel_id: ch.id })]);
  await order();
  await pool.query(
    'UPDATE channels SET settings=settings||\'{"from_name":"Changed"}\'::jsonb WHERE id=$1',
    [ch.id],
  );
  await drain();
  assert.equal((await emailRows()).length, 0);
  assert.equal(received.length, 0);
  const run = (await pool.query('SELECT * FROM automation_runs WHERE tenant_id=$1', [tenant]))
    .rows[0];
  assert.equal(run.state, 'failed');
  assert.match(run.error, /Połączenie/);
});
test('kolejkowana partia email nie pozwala przepisać pochodzenia ani ochrony zamówienia', async () => {
  const t = await template();
  await rule([action(t)]);
  await order();
  await pendingMessages();
  const m = (await emailRows())[0];
  await assert.rejects(
    pool.query(
      "UPDATE email_batches SET automation_run_id=NULL,order_guard='version' WHERE id=$1",
      [m.batch_id],
    ),
    /niezmienne/,
  );
  await drain();
  assert.equal((await emailRows())[0].state, 'simulated');
});
test('podgląd pojedynczy zamraża szablon i kanał przed potwierdzeniem', async () => {
  const t = await template(),
    ch = { id: await localChannel() },
    o = await order();
  const input = action(t, { mode: 'smtp', channel_id: ch.id, client_key: randomUUID() });
  const p = await ok('/api/orders/' + o.id + '/operations/preview', 'POST', input);
  assert.equal(p.actions[0].template_version, t.version);
  assert.match(p.actions[0].channel_hash, /^[a-f0-9]{64}$/);
  await ok('/api/email/templates/' + t.id, 'PATCH', {
    name: t.name,
    body: 'Nowa treść',
    subject: t.subject,
    html: t.html,
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
    'UPDATE channels SET settings=settings||\'{"from_name":"Changed"}\'::jsonb WHERE id=$1',
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
  assert.equal((await emailRows()).length, 0);
  assert.equal(received.length, 0);
});
test('reguła SMTP zapisuje jedną akceptację i Message-ID, replay nie ponawia', async () => {
  const t = await template(),
    ch = await localChannel();
  await rule([
    action(t, { mode: 'smtp', channel_id: ch }),
    { type: 'add_note', note: 'Po intencji' },
  ]);
  const o = await order();
  await drain();
  const [m] = await emailRows();
  assert.equal(m.state, 'smtp_accepted');
  assert.equal(m.result.delivered, false);
  assert.equal(received.length, 1);
  assert.match(received[0], new RegExp('Message-ID: <' + m.id + '@dynaminds.local>', 'i'));
  assert.match(received[0], /multipart\/alternative/);
  assert.match(received[0], /buyer@example.test/);
  const dispatch = (
    await pool.query(
      "SELECT * FROM jobs WHERE tenant_id=$1 AND kind='automation' AND payload->>'orderId'=$2 ORDER BY created_at LIMIT 1",
      [tenant, o.id],
    )
  ).rows[0];
  assert(dispatch);
  await pool.query("UPDATE jobs SET state='pending',lease_token=NULL,locked_at=NULL WHERE id=$1", [
    dispatch.id,
  ]);
  await drain();
  assert.equal((await emailRows()).length, 1);
  assert.equal(received.length, 1);
  const history = await ok('/api/email/messages');
  assert.equal(history.data[0].automation_run_id, m.automation_run_id);
});
test('operator może zatwierdzić lokalny SMTP; viewer nie wykonuje akcji', async () => {
  const t = await template(),
    o = await order(),
    ch = await localChannel(),
    input = action(t, { mode: 'smtp', channel_id: ch, client_key: randomUUID() });
  const p = await ok('/api/orders/' + o.id + '/operations/preview', 'POST', input, operator);
  assert(p.allowed);
  assert.equal(received.length, 0);
  assert.equal((await emailRows()).length, 0);
  const r = await ok(
    '/api/orders/' + o.id + '/operations',
    'POST',
    { ...p.actions[0], order_version: p.order_version, confirmed: true },
    operator,
  );
  assert(r.changed);
  await drain();
  assert.equal(received.length, 1);
  assert.equal((await emailRows())[0].state, 'smtp_accepted');
  assert.equal(
    (await req('/api/orders/' + o.id + '/operations/preview', 'POST', input, viewer)).statusCode,
    403,
  );
});
test('niepewna próba SMTP akcji nie jest ponawiana po odtworzeniu zadania', async () => {
  const t = await template(),
    ch = await localChannel();
  await rule([action(t, { mode: 'smtp', channel_id: ch })]);
  rejectData = true;
  await order();
  await drain();
  const [m] = await emailRows();
  assert.equal(m.state, 'uncertain');
  assert(m.attempted_at);
  assert.equal(received.length, 1);
  // Crash recovery: the message was still queued when SMTP had already begun.
  await pool.query("UPDATE email_messages SET state='queued' WHERE id=$1", [m.id]);
  await pool.query("UPDATE jobs SET state='pending',lease_token=NULL,locked_at=NULL WHERE id=$1", [
    m.job_id,
  ]);
  rejectData = false;
  await drain();
  assert.equal((await emailRows())[0].state, 'uncertain');
  assert.equal(received.length, 1);
});
test('zewnętrzny email wymaga zgody akcji i autoryzacji serwera przed siecią', async () => {
  const t = await template();
  const ch = await ok('/api/integrations', 'POST', {
    provider: 'smtp',
    name: 'QA bez poświadczeń dostawcy',
    mode: 'live',
    credentials: { username: 'qa-only', password: 'QA-ONLY-NOT-A-PROVIDER-SECRET' },
    settings: {
      delivery: 'external',
      host: 'smtp.example.com',
      port: '587',
      from_email: 'sender@example.test',
      from_name: 'QA',
    },
  });
  const a = action(t, { mode: 'smtp', channel_id: ch.id });
  assert.equal(
    (
      await req('/api/automations', 'POST', {
        name: 'QA external',
        trigger: 'order.created',
        actions: [a],
      })
    ).statusCode,
    403,
  );
  assert.notEqual(process.env.DYNA_ALLOW_EXTERNAL_EMAIL, 'true');
  await rule([{ ...a, confirm_external: true }]);
  await order();
  await drain();
  assert.equal((await emailRows()).length, 0);
  assert.equal(received.length, 0);
  const run = (await pool.query('SELECT * FROM automation_runs WHERE tenant_id=$1', [tenant]))
    .rows[0];
  assert.equal(run.state, 'failed');
  assert.match(run.error, /autoryzacji/);
});
test('100 emaili bulk ma 10 porcji i 100 odrębnych intencji, bez sieci', async () => {
  const t = await template(),
    orders = [];
  for (let n = 0; n < 100; n++) orders.push(await order());
  await drain();
  const started = performance.now();
  const p = await ok('/api/orders/batches/preview', 'POST', {
    order_ids: orders.map((o) => o.id),
    action: action(t),
  });
  assert.equal((await emailRows()).length, 0);
  assert.equal(p.items.filter((i: any) => i.allowed).length, 100);
  await ok('/api/order-batches/' + p.id + '/queue', 'POST', { confirmed: true });
  await drain();
  const b = await ok('/api/order-batches/' + p.id),
    rows = await emailRows();
  assert.equal(b.state, 'done');
  assert.equal(b.items.filter((i: any) => i.state === 'done').length, 100);
  assert.equal(rows.length, 100);
  assert(rows.every((m) => m.state === 'simulated' && m.order_batch_id === p.id));
  assert.equal(new Set(rows.map((m) => m.batch_id)).size, 100);
  assert.equal(received.length, 0);
  console.log('EMAIL_ACTIONS_BULK_100_MS', Math.round(performance.now() - started));
});
test('harmonogram 30 zamówień przechodzi przez dwie porcje, bez duplikacji', async () => {
  const t = await template();
  for (let n = 0; n < 30; n++) await order();
  await drain();
  const s = await createSchedule(t),
    r = await runSchedule(s);
  for (let n = 0; n < 100; n++) {
    await pool.query(
      "UPDATE jobs SET run_at=now() WHERE tenant_id=$1 AND kind='automation.schedule' AND state='pending'",
      [tenant],
    );
    if (!(await tick())) break;
  }
  const result = await ok('/api/automation-schedule-runs/' + r.id);
  assert.equal(result.done, 30);
  assert.equal(result.state, 'done');
  assert.equal((await emailRows()).length, 30);
  assert((await emailRows()).every((m) => m.state === 'simulated'));
  await runSchedule(s);
  await drain();
  assert.equal((await emailRows()).length, 30);
});
test('reguła mieszana email, SMS i notatka zapisuje dwa niezależne wyniki', async () => {
  const t = await template(),
    s = await ok('/api/sms/templates', 'POST', {
      name: 'QA SMS mixed',
      body: 'Order {{order_number}}',
      max_parts: 1,
      client_key: randomUUID(),
    });
  await rule([
    action(t),
    { type: 'sms', template_id: s.id, mode: 'local' },
    { type: 'add_note', note: 'Obie komunikacje' },
  ]);
  const o = await order({ address: { country: 'PL', phone: '500500500' } });
  await drain();
  assert.equal((await emailRows())[0].state, 'simulated');
  assert.equal(
    (await pool.query('SELECT state FROM sms_messages WHERE tenant_id=$1', [tenant])).rows[0].state,
    'simulated',
  );
  assert.equal((await ok('/api/orders/' + o.id)).note, 'Obie komunikacje');
  assert.equal(received.length, 0);
});
test('origin FK, RLS i zgoda są chronione również w bezpośrednim SQL', async () => {
  const t = await template(),
    o = await order(),
    p = await preview(t, [o]);
  await assert.rejects(
    pool.query('UPDATE email_batches SET automation_run_id=$2 WHERE id=$1', [p.id, randomUUID()]),
    /foreign key/,
  );
  await queue(p);
  await assert.rejects(
    pool.query('UPDATE email_batches SET external_allowed=true WHERE id=$1', [p.id]),
    /niezmienne/,
  );
  await tenantTx(SECOND_TENANT, async (c) =>
    assert.equal((await c.query('SELECT id FROM email_batches WHERE id=$1', [p.id])).rowCount, 0),
  );
  await drain();
});
test(
  'równoległa intencja reguły i ręczny email kończą się bez zakleszczenia',
  { timeout: 15000 },
  async () => {
    const t = await template();
    await rule([action(t)]);
    const o = await order();
    const p = await preview(t, [o]);
    await Promise.all([queue(p), drain()]);
    await drain();
    const rows = await emailRows();
    assert.equal(rows.length, 2);
    assert(rows.every((m) => m.state === 'simulated'));
  },
);
test('schemat sprzed akcji email zachowuje historię, zgłasza brak funkcji i blokuje nowe definicje', async () => {
  const legacy = await pool.connect();
  let oldApp: FastifyInstance | undefined;
  try {
    // Only the disposable test database is altered; buildApp needs a committed column rename.
    await legacy.query(
      'ALTER TABLE email_batches RENAME COLUMN automation_run_id TO stage083_legacy_column',
    );
    oldApp = await buildApp();
    const h = (await oldApp.inject('/api/health')).json();
    assert.equal(h.email_actions_available, false);
    assert.equal(h.email_available, true);
    const r = await oldApp.inject({
      url: '/api/automations',
      method: 'POST',
      headers: { cookie: admin },
      payload: {
        name: 'QA unavailable',
        enabled: false,
        trigger: 'order.created',
        actions: [action({ id: randomUUID() })],
      },
    });
    assert.equal(r.statusCode, 404, r.body);
    assert.equal(
      (await oldApp.inject({ url: '/api/email/messages', headers: { cookie: admin } })).statusCode,
      200,
    );
  } finally {
    await oldApp?.close();
    await legacy.query(
      'ALTER TABLE email_batches RENAME COLUMN stage083_legacy_column TO automation_run_id',
    );
    legacy.release();
  }
});
