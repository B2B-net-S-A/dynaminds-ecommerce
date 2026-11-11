import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../server/app';
import { pool, migrate, tenantTx } from '../server/db';
import { seed } from './fixtures';
import { tick } from '../server/worker';
import { scheduleSuppliersDue } from '../server/supplier-schedules';
import { bulkDemoPage } from '../server/supplier-bulk';
import { encrypt } from '../server/security';
assert.equal(process.env.DYNA_TEST, 'true');
let app: Awaited<ReturnType<typeof buildApp>>,
  cookie = '',
  other = '',
  viewer = '',
  tenant = '',
  user = '',
  supplier: any;
const req = (path: string, method: any = 'GET', payload?: any, auth = cookie) =>
  app.inject({ url: '/api' + path, method, payload, headers: { cookie: auth } });
const ok = async (path: string, method: any = 'GET', payload?: any) => {
  const r = await req(path, method, payload);
  assert([200, 201].includes(r.statusCode), r.body);
  return r.json();
};
const login = async (email: string) =>
  (await req('/auth/login', 'POST', { email, password: 'DynaDemo!2026' })).headers[
    'set-cookie'
  ]!.toString().split(';')[0];
before(async () => {
  await migrate();
  await seed();
  app = await buildApp();
  cookie = (
    await req('/auth/signup', 'POST', {
      email: 'supplier-schedule-test@demo.local',
      password: 'DynaDemo!2026',
      name: 'Harmonogram QA',
      organization: { name: 'Harmonogram QA' },
    })
  ).headers['set-cookie']!.toString().split(';')[0];
  other = await login('other@demo.local');
  viewer = await login('viewer@demo.local');
  const me = (await ok('/auth/me')).user;
  tenant = me.tenant_id;
  user = me.id;
  await ok('/workspaces/plan', 'PATCH', { plan: 'enterprise' });
  supplier = await ok('/suppliers', 'POST', { name: 'BigBuy harmonogram', code: 'BB-SCHEDULE' });
});
after(async () => {
  await app.close();
  await pool.end();
});
const base = { enabled: true, interval_minutes: 30, page_size: 50, taxonomy: null };
const path = (s: any) => '/supplier-sources/' + s.id + '/schedule';
const cfg = async (s: any) => (await ok(path(s))).schedule;
const save = (s: any, version = 0, extra: any = {}) =>
  ok(path(s), 'PUT', { ...base, version, ...extra });
const runNow = (s: any, version = 1, key = randomUUID()) =>
  ok(path(s) + '/run', 'POST', { version, client_key: key });
async function source(real = false) {
  if (!real) return ok('/supplier-sources/demo', 'POST', { supplier_id: supplier.id });
  const ch = await ok('/integrations', 'POST', {
    provider: 'bigbuy',
    name: 'BigBuy harmonogram kontrakt',
    mode: 'sandbox',
    credentials: { api_key: 'schedule-' + randomUUID() },
    settings: {},
  });
  return ok('/supplier-sources', 'POST', {
    channel_id: ch.id,
    supplier_id: supplier.id,
    currency: 'EUR',
  });
}
const detail = async (id: string) => (await ok('/supplier-bulk-runs/' + id)).run;
async function step(id: string, ctx: any = {}) {
  await pool.query(
    "UPDATE jobs SET run_at=CASE WHEN payload->>'bulk_id'=$1 THEN now() ELSE '2100-01-01'::timestamptz END WHERE state='pending'",
    [id],
  );
  return tick(ctx);
}
async function drain(id: string, ctx: any = {}) {
  for (let n = 0; n < 1000; n++) {
    const r = await detail(id);
    if (r.state !== 'queued') return r;
    if (ctx.transport) await pool.query('UPDATE supplier_api_limits SET next_at=now()');
    await step(id, ctx);
  }
  throw Error('drain limit');
}
async function due(s: any) {
  await pool.query(
    "UPDATE supplier_schedules SET next_at=now()-interval '1 second' WHERE source_id=$1",
    [s.id],
  );
}
const fake = (url: string) => {
  const u = new URL(url);
  return bulkDemoPage(
    u.pathname.split('/')[3].split('.')[0] as any,
    Number(u.searchParams.get('page')),
    Number(u.searchParams.get('pageSize')),
  );
};
test('konfiguracja ma wersję, granice i izolację firmy; viewer nie może pisać', async () => {
  const s = await source();
  assert.equal(await cfg(s), null);
  assert.equal((await req(path(s), 'GET', undefined, other)).statusCode, 404);
  assert.equal((await req(path(s), 'PUT', { ...base, version: 0 }, viewer)).statusCode, 403);
  for (const extra of [
    { interval_minutes: 29 },
    { interval_minutes: 10081 },
    { page_size: 10001 },
    { taxonomy: '0' },
    { version: -1 },
  ])
    assert.equal((await req(path(s), 'PUT', { ...base, version: 0, ...extra })).statusCode, 422);
  const c = await save(s);
  assert.equal(c.schedule.version, 1);
  assert.equal(c.schedule.enabled, true);
  assert.equal((await req(path(s), 'PUT', { ...base, version: 0 })).statusCode, 409);
  await tenantTx(tenant, async (c) =>
    assert.equal(
      (await c.query('SELECT DISTINCT tenant_id FROM supplier_schedules')).rows[0].tenant_id,
      tenant,
    ),
  );
  const next = await save(s, 1, { enabled: false });
  assert.equal(next.schedule.next_at, null);
});
test('równoległa edycja tej samej wersji zapisuje dokładnie jedną konfigurację', async () => {
  const s = await source();
  const results = await Promise.all([
    req(path(s), 'PUT', { ...base, version: 0 }),
    req(path(s), 'PUT', { ...base, version: 0, interval_minutes: 60 }),
  ]);
  assert.deepEqual(results.map((r) => r.statusCode).sort(), [200, 409]);
  assert.equal((await cfg(s)).version, 1);
});
test('równoległe schedulery kolejkują raz; następny termin liczony od końca, bez nadrabiania', async () => {
  const s = await source();
  await save(s);
  await due(s);
  const stock = (await ok('/inventory')).data;
  await Promise.all([scheduleSuppliersDue(), scheduleSuppliersDue(), scheduleSuppliersDue()]);
  let c = await cfg(s);
  assert(c.last_bulk_id);
  assert.equal((await detail(c.last_bulk_id)).schedule_version, 1);
  assert.equal((await ok('/supplier-bulk-runs?source_id=' + s.id)).data.length, 1);
  await due(s);
  await scheduleSuppliersDue();
  assert.equal((await ok('/supplier-bulk-runs?source_id=' + s.id)).data.length, 1);
  const r = await drain(c.last_bulk_id);
  assert.equal(r.state, 'success');
  assert.equal(r.published, 107);
  await scheduleSuppliersDue();
  c = await cfg(s);
  assert.equal(new Date(c.next_at).getTime() - new Date(c.last_finished_at).getTime(), 1800000);
  await scheduleSuppliersDue();
  assert.equal((await ok('/supplier-bulk-runs?source_id=' + s.id)).data.length, 1);
  assert.deepEqual((await ok('/inventory')).data, stock);
});
test('aktywny ręczny bulk blokuje harmonogram; edycja harmonogramu nie anuluje ręcznej pracy', async () => {
  const s = await source();
  await save(s);
  const r = await ok('/supplier-sources/' + s.id + '/bulk-runs', 'POST', {
    client_key: randomUUID(),
  });
  await due(s);
  await scheduleSuppliersDue();
  assert.equal((await cfg(s)).last_bulk_id, null);
  await save(s, 1, { enabled: false });
  assert.equal((await detail(r.id)).state, 'queued');
  await drain(r.id);
});
test('uruchom teraz ma replay, konflikt równoległej pracy i fence wersji', async () => {
  const s = await source();
  await save(s);
  const key = randomUUID(),
    r = await runNow(s, 1, key);
  assert.equal((await runNow(s, 1, key)).id, r.id);
  assert.equal(
    (await req(path(s) + '/run', 'POST', { version: 1, client_key: randomUUID() })).statusCode,
    409,
  );
  await save(s, 1, { enabled: false });
  assert.equal((await detail(r.id)).state, 'cancelled');
  assert.equal(
    (await req(path(s) + '/run', 'POST', { version: 1, client_key: key })).statusCode,
    409,
  );
  assert.equal(
    (await req(path(s) + '/run', 'POST', { version: 2, client_key: randomUUID() })).statusCode,
    409,
  );
});
test('wyłączenie podczas HTTP odrzuca późną stronę i dzierżawę', async () => {
  const s = await source(true);
  await save(s);
  const r = await runNow(s);
  let calls = 0;
  await step(r.id, {
    transport: async (url: string) => {
      calls++;
      await save(s, 1, { enabled: false });
      return new Response(JSON.stringify(fake(url)));
    },
  });
  const d = await detail(r.id);
  assert.equal(calls, 1);
  assert.equal(d.state, 'cancelled');
  assert.equal(Number(d.fetched_rows), 0);
  assert.deepEqual(d.cursors, {});
  const j = (await pool.query('SELECT state,lease_token FROM jobs WHERE id=$1', [d.job_id]))
    .rows[0];
  assert.equal(j.state, 'done');
  assert.equal(j.lease_token, null);
});
test('edycja aktywnego harmonogramu podczas HTTP anuluje poprzednią definicję', async () => {
  const s = await source(true);
  await save(s);
  const r = await runNow(s);
  await step(r.id, {
    transport: async (url: string) => {
      await save(s, 1, { interval_minutes: 90, taxonomy: '12' });
      return new Response(JSON.stringify(fake(url)));
    },
  });
  assert.equal((await detail(r.id)).state, 'cancelled');
  assert.equal(Number((await detail(r.id)).fetched_rows), 0);
  assert.equal((await cfg(s)).version, 2);
  await due(s);
  await scheduleSuppliersDue();
  const d = await detail((await cfg(s)).last_bulk_id);
  assert.equal(d.taxonomy, '12');
  assert.equal(d.schedule_version, 2);
  await save(s, 2, { enabled: false });
});
test('zmiana klucza przed cyklem wstrzymuje harmonogram do ponownego zapisu', async () => {
  const s = await source(true);
  await save(s);
  await pool.query('UPDATE channels SET credentials=$2 WHERE id=$1', [
    s.channel_id,
    encrypt({ api_key: 'changed-schedule-key' }),
  ]);
  await due(s);
  await scheduleSuppliersDue();
  let c = await cfg(s);
  assert.equal(c.enabled, false);
  assert.match(c.error, /Połączenie/);
  assert.equal(c.next_at, null);
  c = (await save(s, c.version)).schedule;
  await due(s);
  await scheduleSuppliersDue();
  assert((await cfg(s)).last_bulk_id);
  await save(s, c.version, { enabled: false });
});
test('utrata roli autora blokuje automatyczne uruchomienie', async () => {
  const s = await source();
  await save(s);
  await due(s);
  await pool.query("UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2", [
    tenant,
    user,
  ]);
  try {
    await scheduleSuppliersDue();
    const c = (await pool.query('SELECT * FROM supplier_schedules WHERE source_id=$1', [s.id]))
      .rows[0];
    assert.equal(c.enabled, false);
    assert.equal(c.last_bulk_id, null);
    assert.match(c.error, /rolę administratora/);
  } finally {
    await pool.query("UPDATE memberships SET role='admin' WHERE tenant_id=$1 AND user_id=$2", [
      tenant,
      user,
    ]);
  }
});
test('pauza źródła wyłącza harmonogram i wznawianie źródła nie włącza go automatycznie', async () => {
  const s = await source();
  await save(s);
  const r = await runNow(s);
  await ok('/supplier-sources/' + s.id + '/state', 'PATCH', { version: s.version, paused: true });
  assert.equal((await cfg(s)).enabled, false);
  assert.equal((await detail(r.id)).state, 'cancelled');
  await ok('/supplier-sources/' + s.id + '/state', 'PATCH', {
    version: s.version + 1,
    paused: false,
  });
  assert.equal((await cfg(s)).enabled, false);
});
test('ostatnia wygasła dzierżawa zostaje uzgodniona z harmonogramem i kolejnym terminem', async () => {
  const s = await source();
  await save(s);
  const r = await runNow(s),
    d = await detail(r.id);
  await pool.query(
    "UPDATE jobs SET state='running',attempts=max_attempts,lease_token=$2,locked_at=now()-interval '3 minutes' WHERE id=$1",
    [d.job_id, randomUUID()],
  );
  await step(r.id);
  await scheduleSuppliersDue();
  const c = await cfg(s);
  assert.equal(c.last_state, 'failed');
  assert.match(c.error, /Dzierżawa/);
  assert(c.last_finished_at);
  assert(new Date(c.next_at).getTime() > Date.now() + 1700000);
});
test('pełna kolejka odkłada termin bez tworzenia kolejnych odczytów', async () => {
  const s = await source();
  await save(s);
  const ids = Array.from({ length: 1000 }, () => randomUUID());
  await pool.query(
    "INSERT INTO jobs(id,tenant_id,kind,payload,run_at,dedup_key) SELECT x,$1,'fixture.backpressure','{}'::jsonb,'2100-01-01'::timestamptz,'fixture:'||x::text FROM unnest($2::uuid[])x",
    [tenant, ids],
  );
  try {
    await due(s);
    await scheduleSuppliersDue();
    const c = await cfg(s);
    assert.equal(c.enabled, true);
    assert.equal(c.last_bulk_id, null);
    assert.match(c.error, /Kolejka firmy/);
    assert(new Date(c.next_at).getTime() > Date.now() + 55000);
  } finally {
    await pool.query("UPDATE jobs SET state='done' WHERE id=ANY($1::uuid[])", [ids]);
    await save(s, 1, { enabled: false });
  }
});
test('częściowe odrzucenia SKU są widoczne w ostatnim wyniku harmonogramu', async () => {
  const s = await source(true);
  await save(s, 0, { page_size: 10000 });
  const r = await runNow(s);
  await drain(r.id, {
    transport: async (url: string) =>
      new Response(
        JSON.stringify(
          fake(url).filter((p: any) => !url.includes('productsinformation') || p.id !== 1000),
        ),
      ),
  });
  await scheduleSuppliersDue();
  const c = await cfg(s);
  assert.equal(c.last_state, 'success');
  assert.equal(c.last_rejected, 1);
  assert.match(c.error, /odrzuconymi/);
  assert.equal(c.last_published, 106);
});
test('publiczny OpenAPI i zakres purchasing chronią konfigurację i run-now', async () => {
  const s = await source();
  await save(s);
  const key = await ok('/developer/keys', 'POST', {
    name: 'Harmonogram read',
    scopes: ['purchasing:read'],
  });
  const token = key.token ?? key.key;
  const doc = (await app.inject({ url: '/api/v1/openapi' })).json();
  assert(doc.paths['/supplier-sources/{id}/schedule'].put.requestBody);
  const headers = { authorization: 'Bearer ' + token };
  const read = await app.inject({ url: '/api/v1' + path(s), headers });
  assert.equal(read.statusCode, 200, read.body);
  const write = await app.inject({
    url: '/api/v1' + path(s),
    method: 'PUT',
    payload: { ...base, version: 1 },
    headers,
  });
  assert.equal(write.statusCode, 403);
});
test('nieaktywny dostawca wyłącza należny harmonogram bez minutowej pętli', async () => {
  const s = await source();
  await save(s);
  await due(s);
  await pool.query('UPDATE suppliers SET active=false WHERE id=$1', [supplier.id]);
  try {
    await scheduleSuppliersDue();
    const c = await cfg(s);
    assert.equal(c.enabled, false);
    assert.equal(c.next_at, null);
    assert.equal(c.last_bulk_id, null);
    assert.match(c.error, /Dostawca jest nieaktywny/);
  } finally {
    await pool.query('UPDATE suppliers SET active=true WHERE id=$1', [supplier.id]);
  }
});
