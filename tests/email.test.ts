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
async function claim(b: any) {
  const j = (
    await pool.query(
      "UPDATE jobs SET state='running',attempts=attempts+1,locked_at=now(),lease_token=$2 WHERE id=$1 RETURNING *",
      [b.items[0].job_id, randomUUID()],
    )
  ).rows[0];
  return j;
}
const settings = {
  delivery: 'local_sink',
  host: '127.0.0.1',
  port: 1025,
  from_email: 'orders@example.test',
  from_name: 'DYNAMINDS QA',
};
test('SMTP ustawienia: TLS465/STARTTLS587; lokalny odbiornik tylko stały loopback i .test', () => {
  for (const port of [465, 587])
    assert(
      smtpSettings.safeParse({ ...settings, delivery: 'external', host: 'smtp.example.com', port })
        .success,
    );
  for (const x of [
    { host: '127.0.0.1' },
    { host: 'localhost' },
    { port: 25 },
    { host: 'evil.local' },
    { host: 'smtp.example.com\r\nRCPT' },
  ])
    assert(
      !smtpSettings.safeParse({
        ...settings,
        delivery: 'external',
        host: 'smtp.example.com',
        port: 587,
        ...x,
      }).success,
    );
  for (const x of [{ host: '127.0.0.2' }, { port: 25 }, { from_email: 'real@example.com' }])
    assert(!smtpSettings.safeParse({ ...settings, ...x }).success);
});
test('zewnętrzna wysyłka wyłączona przed DNS i połączeniem', async () => {
  delete process.env.DYNA_ALLOW_EXTERNAL_EMAIL;
  const c = new SmtpClient(
    { ...settings, delivery: 'external', host: 'smtp.example.com', port: 587 },
    { username: 'qa', password: 'test-only' },
  );
  await assert.rejects(c.test(), /DYNA_ALLOW_EXTERNAL_EMAIL/);
  assert.equal(received.length, 0);
});
test('szablony: nieznane zmienne, nagłówki CRLF, sanitacja HTML i idempotencja', async () => {
  assert.throws(
    () =>
      validateEmailTemplate(
        emailTemplate.parse({ name: 'QA', subject: 'Hello\r\nBcc: x', body: 'text' }),
      ),
    /jeden wiersz|kontrolny/,
  );
  assert.equal(
    (
      await req('/api/email/templates', 'POST', {
        name: 'QA',
        subject: '{{secret}}',
        body: 'X',
        client_key: randomUUID(),
      })
    ).statusCode,
    422,
  );
  const key = randomUUID(),
    t = await template({
      client_key: key,
      html: '<script>alert(1)</script><img src="https://evil.test/a"><p onclick="bad()">{{customer_name}}</p><a href="javascript:evil()">X</a>',
    });
  assert(!/script|img|onclick|javascript/.test(t.html));
  assert.equal(
    (
      await template({
        client_key: key,
        html: '<script>alert(1)</script><img src="https://evil.test/a"><p onclick="bad()">{{customer_name}}</p><a href="javascript:evil()">X</a>',
      })
    ).id,
    t.id,
  );
  assert.equal(
    (
      await req('/api/email/templates', 'POST', {
        name: 'Inny',
        subject: 'X',
        body: 'X',
        client_key: key,
      })
    ).statusCode,
    409,
  );
});
test('podgląd rozwija kwoty i ucieka HTML klienta; błędny odbiorca nie trafia do kolejki', async () => {
  const t = await template(),
    o = await order({ customer_name: '<img src=x onerror=evil()>' }),
    invalid = await order();
  await pool.query("UPDATE orders SET email='' WHERE id=$1", [invalid.id]);
  const b = await preview(t, [o, invalid]);
  assert.equal(b.items.filter((m: any) => m.state === 'draft').length, 1);
  const m = b.items.find((m: any) => m.order_id === o.id);
  assert.equal(m.payload.recipient, 'buyer@example.test');
  assert.match(m.payload.text, /246.90 PLN/);
  assert.match(m.payload.html, /&lt;img/);
  assert(!m.payload.html.includes('<img'));
  await queue(b);
  await drain();
  const result = await ok('/api/email/batches/' + b.id);
  assert.equal(result.items.find((m: any) => m.order_id === o.id).state, 'simulated');
  assert.equal(result.items.find((m: any) => m.order_id === invalid.id).state, 'invalid');
  assert.equal(received.length, 0);
});
test('role: administrator szablonu, operator podglądu lokalnego, viewer tylko odczyt', async () => {
  assert.equal(
    (
      await req(
        '/api/email/templates',
        'POST',
        { name: 'QA', subject: 'X', body: 'X', client_key: randomUUID() },
        operator,
      )
    ).statusCode,
    403,
  );
  const t = await template(),
    o = await order();
  const b = await preview(t, [o], {}, operator);
  await queue(b, operator);
  await drain();
  assert.equal(
    (
      await req(
        '/api/email/preview',
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
  assert.equal((await req('/api/email/batches/' + b.id, 'GET', undefined, viewer)).statusCode, 200);
});
test('RLS i złożone FK nie pozwalają mieszać firm, szablonów ani historii', async () => {
  const t = await template(),
    o = await order(),
    b = await preview(t, [o]);
  assert.equal((await req('/api/email/batches/' + b.id, 'GET', undefined, other)).statusCode, 404);
  assert.equal(
    (await req('/api/email/messages?after=' + b.items[0].id, 'GET', undefined, other)).statusCode,
    422,
  );
  assert.equal(
    (
      await req(
        '/api/email/preview',
        'POST',
        {
          template_id: t.id,
          template_version: t.version,
          order_ids: [o.id],
          client_key: randomUUID(),
        },
        other,
      )
    ).statusCode,
    409,
  );
  assert.equal(
    (
      await tenantTx(SECOND_TENANT, (c) =>
        c.query('SELECT * FROM email_messages WHERE id=$1', [b.items[0].id]),
      )
    ).rowCount,
    0,
  );
  await assert.rejects(
    tenantTx(SECOND_TENANT, (c) =>
      c.query(
        "INSERT INTO email_batches(id,tenant_id,actor_id,template_id,template_version,mode,client_key,request_hash) VALUES($1,$2,$5,$3,1,'local',$4,'x')",
        [randomUUID(), SECOND_TENANT, t.id, randomUUID(), b.actor_id],
      ),
    ),
    /foreign key/,
  );
});
test('idempotentny podgląd i potwierdzenie tworzą tylko jedno zadanie', async () => {
  const t = await template(),
    o = await order(),
    key = randomUUID();
  const [a, b] = await Promise.all([
    preview(t, [o], { client_key: key }),
    preview(t, [o], { client_key: key }),
  ]);
  assert.equal(a.id, b.id);
  await Promise.all([queue(a), queue(a)]);
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int n FROM jobs WHERE tenant_id=$1 AND kind='email.send'",
        [tenant],
      )
    ).rows[0].n,
    1,
  );
  await drain();
  assert.equal((await queue(a)).state, 'done');
});
test('zmiana zamówienia, szablonu lub konta unieważnia zatwierdzany podgląd', async () => {
  const t = await template(),
    o = await order(),
    b = await preview(t, [o]);
  await pool.query('UPDATE orders SET version=version+1 WHERE id=$1', [o.id]);
  assert.equal(
    (await req('/api/email/batches/' + b.id + '/queue', 'POST', { confirmed: true })).statusCode,
    409,
  );
  const b2 = await preview(t, [await ok('/api/orders/' + o.id)]);
  await template();
  await pool.query('UPDATE email_templates SET version=version+1 WHERE id=$1', [t.id]);
  assert.equal(
    (await req('/api/email/batches/' + b2.id + '/queue', 'POST', { confirmed: true })).statusCode,
    409,
  );
  const t2 = await template(),
    ch = await localChannel(),
    b3 = await preview(t2, [o], { mode: 'smtp', channel_id: ch });
  await pool.query(
    "UPDATE channels SET settings=jsonb_set(settings,'{from_name}','\"Changed\"') WHERE id=$1",
    [ch],
  );
  assert.equal(
    (await req('/api/email/batches/' + b3.id + '/queue', 'POST', { confirmed: true })).statusCode,
    409,
  );
});
test('worker sprawdza dane ponownie przed SMTP', async () => {
  const t = await template(),
    o = await order(),
    b = await queue(await preview(t, [o], { mode: 'smtp', channel_id: await localChannel() }));
  await pool.query('UPDATE orders SET version=version+1 WHERE id=$1', [o.id]);
  await drain();
  const m = (await ok('/api/email/batches/' + b.id)).items[0];
  assert.equal(m.state, 'failed');
  assert.equal(m.attempted_at, null);
  assert.equal(received.length, 0);
});
test('SMTP: prawdziwy protokół loopback, AUTH, DATA, Message-ID i tylko przyjęcie', async () => {
  const ch = await localChannel();
  assert.equal((await ok('/api/integrations/' + ch + '/test', 'POST', {})).status, 'verified_read');
  const t = await template(),
    o = await order(),
    b = await queue(await preview(t, [o], { mode: 'smtp', channel_id: ch }));
  await drain();
  const m = (await ok('/api/email/batches/' + b.id)).items[0];
  assert.equal(m.state, 'smtp_accepted');
  assert.equal(m.result.delivered, false);
  assert.equal(m.result.local_sink, true);
  assert.equal(received.length, 1);
  assert(authenticated >= 2);
  assert.match(received[0], new RegExp('Message-ID: <' + m.id + '@dynaminds.local>'));
  assert.match(received[0], /multipart\/alternative/);
  assert.match(received[0], /To: buyer@example.test/);
  await processEmail(await claim(b));
  assert.equal(received.length, 1);
});
test('SMTP local nie przyjmuje realnych adresów; symulacja nadal bez sieci', async () => {
  const t = await template(),
    o = await order({ email: 'buyer@example.com' }),
    b = await preview(t, [o], { mode: 'smtp', channel_id: await localChannel() });
  assert.equal(b.items[0].state, 'invalid');
  assert.equal(
    (await req('/api/email/batches/' + b.id + '/queue', 'POST', { confirmed: true })).statusCode,
    409,
  );
  assert.equal(received.length, 0);
});
test('utrata potwierdzenia DATA pozostaje uncertain bez automatycznego resend', async () => {
  rejectData = true;
  const t = await template(),
    o = await order(),
    b = await queue(await preview(t, [o], { mode: 'smtp', channel_id: await localChannel() }));
  await drain();
  const m = (await ok('/api/email/batches/' + b.id)).items[0];
  assert.equal(m.state, 'uncertain');
  assert(m.attempted_at);
  assert.equal(received.length, 1);
  await processEmail(await claim(b));
  assert.equal(received.length, 1);
  assert(!JSON.stringify(m).includes(localSmtpPassword()));
});
test('awaria po attempted_at, odzyskanie dzierżawy i stare tokeny nie powodują wysyłki', async () => {
  const t = await template(),
    o = await order(),
    b = await queue(await preview(t, [o], { mode: 'smtp', channel_id: await localChannel() }));
  const j = await claim(b);
  await pool.query('UPDATE email_messages SET attempted_at=now() WHERE id=$1', [b.items[0].id]);
  await pool.query("UPDATE jobs SET locked_at=now()-interval '3 minutes' WHERE id=$1", [j.id]);
  await processEmail(j);
  assert.equal(received.length, 0);
  await drain();
  assert.equal((await ok('/api/email/batches/' + b.id)).items[0].state, 'uncertain');
  assert.equal(received.length, 0);
});
test('wyczerpana dzierżawa kończy partię i nie usuwa znacznika rozpoczęcia', async () => {
  const t = await template(),
    o = await order(),
    b = await queue(await preview(t, [o]));
  const j = await claim(b);
  await pool.query(
    "UPDATE jobs SET attempts=max_attempts,locked_at=now()-interval '3 minutes' WHERE id=$1",
    [j.id],
  );
  await drain();
  assert.equal((await ok('/api/email/batches/' + b.id)).items[0].state, 'failed');
  await pool.query('UPDATE email_messages SET attempted_at=now() WHERE id=$1', [b.items[0].id]);
  await assert.rejects(
    tenantTx(tenant, (c) =>
      c.query('UPDATE email_messages SET attempted_at=NULL WHERE id=$1', [b.items[0].id]),
    ),
    /rozpoczętej/,
  );
});
test('anulowanie partii przed pracą oraz wyścig queue/cancel nie pozostawia sierot', async () => {
  const t = await template(),
    o = await order(),
    b = await preview(t, [o]);
  const result = await Promise.all([
    req('/api/email/batches/' + b.id + '/queue', 'POST', { confirmed: true }),
    req('/api/email/batches/' + b.id + '/cancel', 'POST', { confirmed: true }),
  ]);
  assert(result.every((r) => [200, 409].includes(r.statusCode)));
  await drain();
  const r = await ok('/api/email/batches/' + b.id);
  assert.equal(r.state, 'cancelled');
  assert.equal(r.items[0].state, 'cancelled');
  assert.equal(received.length, 0);
  const b2 = await queue(await preview(t, [o]));
  await drain();
  assert.equal(
    (await req('/api/email/batches/' + b2.id + '/cancel', 'POST', { confirmed: true })).statusCode,
    409,
  );
});
test('utrata roli po potwierdzeniu zatrzymuje worker', async () => {
  const t = await template(),
    o = await order(),
    b = await queue(await preview(t, [o], { mode: 'smtp', channel_id: await localChannel() }));
  await pool.query(
    "UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=(SELECT id FROM users WHERE email='admin@demo.local')",
    [tenant],
  );
  await drain();
  assert.equal(
    (await pool.query('SELECT state FROM email_messages WHERE id=$1', [b.items[0].id])).rows[0]
      .state,
    'failed',
  );
  assert.equal(received.length, 0);
});
test('historia zachowuje precyzję mikrosekund i filtr zamówienia', async () => {
  const t = await template(),
    o = await order(),
    b = await preview(t, [o]),
    b2 = await preview(t, [o]);
  await assert.rejects(
    tenantTx(tenant, (c) =>
      c.query('UPDATE email_messages SET payload=$2 WHERE id=$1', [
        b.items[0].id,
        { recipient: 'other@example.test' },
      ]),
    ),
    /niezmienne/,
  );
  // Immutable created_at: insert separate previews in one transaction, producing a timestamp tie.
  const ids: string[] = [];
  await tenantTx(tenant, async (c) => {
    const rows = (await c.query('SELECT * FROM email_messages WHERE id=$1', [b.items[0].id]))
      .rows[0];
    for (let i = 0; i < 3; i++) {
      const bid = randomUUID(),
        mid = randomUUID();
      await c.query(
        'INSERT INTO email_batches(id,tenant_id,actor_id,template_id,template_version,mode,client_key,request_hash) SELECT $1,tenant_id,actor_id,template_id,template_version,mode,$2,request_hash FROM email_batches WHERE id=$3',
        [bid, randomUUID(), b.id],
      );
      await c.query(
        "INSERT INTO email_messages(id,tenant_id,batch_id,order_id,number,snapshot,payload,state,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,'draft','2027-01-01 00:00:00.000001+00')",
        [mid, tenant, bid, o.id, rows.number, rows.snapshot, rows.payload],
      );
      ids.push(mid);
    }
  });
  const seen: string[] = [];
  let after = '';
  for (let i = 0; i < 10; i++) {
    const r = await ok(
      '/api/email/messages?limit=1&order_id=' + o.id + (after ? '&after=' + after : ''),
    );
    seen.push(...r.data.map((m: any) => m.id));
    if (!r.next_cursor) break;
    after = r.next_cursor;
  }
  assert.equal(seen.length, 5);
  assert.equal(new Set(seen).size, 5);
  assert(ids.every((id) => seen.includes(id)));
  assert(seen.includes(b2.items[0].id));
  const o2 = await order();
  assert.equal(
    (await req('/api/email/messages?after=' + b.items[0].id + '&order_id=' + o2.id)).statusCode,
    422,
  );
});
test('limit kolejki, wygasły podgląd i brak confirmed blokują enqueue', async () => {
  const t = await template(),
    o = await order(),
    b = await preview(t, [o]);
  assert.equal((await req('/api/email/batches/' + b.id + '/queue', 'POST', {})).statusCode, 422);
  await pool.query("UPDATE email_batches SET created_at=now()-interval '31 minutes' WHERE id=$1", [
    b.id,
  ]);
  assert.equal(
    (await req('/api/email/batches/' + b.id + '/queue', 'POST', { confirmed: true })).statusCode,
    409,
  );
  const b2 = await preview(t, [o]);
  await pool.query(
    "INSERT INTO jobs(id,tenant_id,kind,payload,dedup_key) SELECT gen_random_uuid(),$1,'qa.email', '{}'::jsonb, 'qa-'||g FROM generate_series(1,1000)g",
    [tenant],
  );
  assert.equal(
    (await req('/api/email/batches/' + b2.id + '/queue', 'POST', { confirmed: true })).statusCode,
    409,
  );
});
test('200 wiadomości: ograniczona partia, atomowa kolejka i 201 odrzucone', async () => {
  const t = await template(),
    orders = [];
  for (let i = 0; i < 200; i++) orders.push(await order());
  const started = Date.now();
  const b = await preview(t, orders);
  const q = await queue(b);
  assert.equal(q.items.length, 200);
  assert(q.items.every((m: any) => m.state === 'queued'));
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int n FROM jobs WHERE tenant_id=$1 AND kind='email.send'",
        [tenant],
      )
    ).rows[0].n,
    200,
  );
  console.log('EMAIL_BATCH_200_PREVIEW_QUEUE_MS=' + (Date.now() - started));
  assert.equal(
    (
      await req('/api/email/preview', 'POST', {
        template_id: t.id,
        template_version: t.version,
        order_ids: [...orders.map((o) => o.id), randomUUID()],
        client_key: randomUUID(),
      })
    ).statusCode,
    422,
  );
});
test('publiczne API: scopes, HTML w OpenAPI i firmowy kursor', async () => {
  const t = await template(),
    o = await order(),
    b = await preview(t, [o]);
  const key = await ok('/api/developer/keys', 'POST', {
    name: 'Email read QA',
    scopes: ['communications:read'],
  });
  const auth = { authorization: 'Bearer ' + key.token };
  const r = await app.inject({ url: '/api/v1/email/messages?limit=1', headers: auth });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().data[0].id, b.items[0].id);
  assert.equal(
    (
      await app.inject({
        url: '/api/v1/email/preview',
        method: 'POST',
        payload: {
          template_id: t.id,
          template_version: t.version,
          order_ids: [o.id],
          client_key: randomUUID(),
        },
        headers: auth,
      })
    ).statusCode,
    403,
  );
  const spec = await ok('/api/v1/openapi');
  assert(spec.paths['/email/templates']);
  assert(spec.paths['/email/messages'].get.parameters.some((p: any) => p.name === 'limit'));
});
