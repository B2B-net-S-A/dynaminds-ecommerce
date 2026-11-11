import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../server/app';
import { migrate, pool, tenantTx } from '../server/db';
import { seed, SECOND_TENANT } from './fixtures';
import {
  scheduleAutomationsDue,
  processSchedule,
  failSchedule,
} from '../server/automation-schedules';
import { tick } from '../server/worker';
assert.equal(process.env.DYNA_TEST, 'true');
let app: FastifyInstance,
  admin: string,
  operator: string,
  viewer: string,
  other: string,
  adminId: string,
  tenant: string,
  warehouse: string,
  product: string;
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
  adminId = (await pool.query("SELECT id FROM users WHERE email='admin@demo.local'")).rows[0].id;
});
beforeEach(async () => {
  await pool.query('UPDATE automation_schedules SET enabled=false');
  await pool.query("UPDATE jobs SET state='done',lease_token=NULL");
  await pool.query("UPDATE automation_schedule_runs SET state='cancelled' WHERE state='queued'");
  tenant = randomUUID();
  await pool.query("INSERT INTO tenants(id,name,plan) VALUES($1,$2,'enterprise')", [
    tenant,
    'QA schedules ' + tenant,
  ]);
  await pool.query(
    "INSERT INTO memberships(tenant_id,user_id,role) SELECT $1,id,CASE email WHEN 'admin@demo.local' THEN 'admin' WHEN 'operator@demo.local' THEN 'operator' ELSE 'viewer' END FROM users WHERE email=ANY($2::text[])",
    [tenant, ['admin@demo.local', 'operator@demo.local', 'viewer@demo.local']],
  );
  async function switchWorkspace(cookie: string) {
    const r = await app.inject({
      url: '/api/workspaces/switch',
      method: 'POST',
      payload: { tenant_id: tenant },
      headers: { cookie },
    });
    assert.equal(r.statusCode, 200, r.body);
    return r.headers['set-cookie']!.toString().split(';')[0];
  }
  admin = await switchWorkspace(admin);
  operator = await switchWorkspace(operator);
  viewer = await switchWorkspace(viewer);
  warehouse = randomUUID();
  await pool.query("INSERT INTO warehouses(id,tenant_id,name,code) VALUES($1,$2,$3,'QA')", [
    warehouse,
    tenant,
    'QA harmonogram',
  ]);
  product = (
    await ok('/api/products', 'POST', {
      sku: 'SCHEDULE-' + randomUUID(),
      name: 'QA',
      price: 1200,
      warehouse_id: warehouse,
      quantity: 10000,
    })
  ).id;
});
after(async () => {
  await app.close();
  await pool.end();
});
async function order(extra: any = {}) {
  return ok('/api/orders', 'POST', {
    customer_name: 'QA schedules',
    email: 'qa@example.test',
    warehouse_id: warehouse,
    items: [{ product_id: product, quantity: 1 }],
    address: { country: 'PL' },
    ...extra,
  });
}
async function datedOrder(created: string) {
  const id = randomUUID();
  return (
    await pool.query(
      `INSERT INTO orders(id,tenant_id,number,customer_name,email,address,total,warehouse_id,portal_token,created_at)
    VALUES($1,$2,$3,'QA timestamp','qa@example.test','{"country":"PL"}',0,$4,$5,$6) RETURNING id`,
      [id, tenant, 'QA-' + id, warehouse, randomUUID(), created],
    )
  ).rows[0];
}
const input = (extra: any = {}) => ({
  name: 'QA cykl',
  enabled: true,
  frequency: { kind: 'interval', seconds: 3600 },
  statuses: ['new'],
  min_age_seconds: 0,
  actions: [{ type: 'add_tag', tag: 'stare' }],
  ...extra,
});
const schedule = (extra: any = {}) =>
  ok('/api/automation-schedules', 'POST', { ...input(extra), client_key: randomUUID() });
const queue = (s: any, key = randomUUID()) =>
  ok('/api/automation-schedules/' + s.id + '/run', 'POST', {
    version: s.version,
    client_key: key,
    confirmed: true,
  });
const get = (r: any, after = '') =>
  ok('/api/automation-schedule-runs/' + r.id + (after ? '?after=' + after : ''));
async function claim(r: any) {
  const j = (
    await pool.query(
      "UPDATE jobs SET state='running',attempts=attempts+1,locked_at=now(),lease_token=$2 WHERE id=$1 AND state='pending' RETURNING *",
      [r.job_id, randomUUID()],
    )
  ).rows[0];
  assert.ok(j);
  return j;
}
async function processPart(r: any) {
  await processSchedule(await claim(r));
  return get(r);
}
async function finish(r: any) {
  for (let i = 0; i < 100; i++) {
    const state = await get(r);
    if (state.state !== 'queued') return state;
    await processPart(r);
  }
  assert.fail('Nie zakończono harmonogramu');
}
const note = (o: any) => ok('/api/orders/' + o.id);
test('walidacja, role, izolacja firm, FK i niezmienna historia', async () => {
  const s = await schedule();
  await order();
  const r = await queue(s);
  await finish(r);
  for (const cookie of [operator, viewer])
    assert.equal(
      (
        await req(
          '/api/automation-schedules',
          'POST',
          { ...input(), client_key: randomUUID() },
          cookie,
        )
      ).statusCode,
      403,
    );
  assert.equal(
    (await req('/api/automation-schedules/' + s.id + '/preview', 'POST', {}, operator)).statusCode,
    403,
  );
  assert.equal(
    (await req('/api/automation-schedule-runs/' + r.id, 'GET', undefined, other)).statusCode,
    404,
  );
  assert.equal(
    (await ok('/api/automation-schedules', 'GET', undefined, other)).data.some(
      (v: any) => v.id === s.id,
    ),
    false,
  );
  assert.equal(
    (
      await req('/api/automation-schedules', 'POST', {
        ...input({
          frequency: { kind: 'daily', time: '25:00', timezone: 'Europe/Warsaw', weekdays: [1] },
        }),
        client_key: randomUUID(),
      })
    ).statusCode,
    422,
  );
  assert.equal(
    (
      await req('/api/automation-schedules', 'POST', {
        ...input({
          frequency: { kind: 'daily', time: '09:00', timezone: 'wrong/Zone', weekdays: [1] },
        }),
        client_key: randomUUID(),
      })
    ).statusCode,
    422,
  );
  assert.equal(
    (
      await req('/api/automation-schedules', 'POST', {
        ...input({ conditions: [{ field: 'warehouse_id', op: 'eq', value: randomUUID() }] }),
        client_key: randomUUID(),
      })
    ).statusCode,
    422,
  );
  await tenantTx(SECOND_TENANT, async (c) =>
    assert.equal(
      (await c.query('SELECT * FROM automation_schedule_items WHERE run_id=$1', [r.id])).rowCount,
      0,
    ),
  );
  await assert.rejects(
    tenantTx(tenant, (c) =>
      c.query("UPDATE automation_schedule_items SET state='failed' WHERE run_id=$1", [r.id]),
    ),
    (e: any) => e.code === '42501',
  );
  await assert.rejects(
    tenantTx(tenant, (c) =>
      c.query('DELETE FROM automation_schedule_receipts WHERE schedule_id=$1', [s.id]),
    ),
    (e: any) => e.code === '42501',
  );
});
test('interwał, dni tygodnia, północ i zmiana czasu Europe/Warsaw', async () => {
  async function next(f: any, after: string) {
    return (
      await pool.query('SELECT automation_next_at($1,$2) AS at', [JSON.stringify(f), after])
    ).rows[0].at.toISOString();
  }
  const daily = {
    kind: 'daily',
    time: '02:30',
    timezone: 'Europe/Warsaw',
    weekdays: [1, 2, 3, 4, 5, 6, 7],
  };
  assert.equal(
    await next({ kind: 'interval', seconds: 60 }, '2026-10-04T00:00:00Z'),
    '2026-10-04T00:01:00.000Z',
  );
  assert.equal(await next(daily, '2026-03-28T23:00:00Z'), '2026-03-29T01:30:00.000Z');
  assert.equal(await next(daily, '2026-03-29T01:45:00Z'), '2026-03-30T00:30:00.000Z');
  assert.equal(await next(daily, '2026-10-24T23:00:00Z'), '2026-10-25T01:30:00.000Z');
  assert.equal(await next(daily, '2026-10-25T01:45:00Z'), '2026-10-26T01:30:00.000Z');
  assert.equal(
    await next({ ...daily, time: '09:00', weekdays: [1] }, '2026-10-05T07:00:00Z'),
    '2026-10-12T07:00:00.000Z',
  );
  assert.equal(
    await next({ ...daily, time: '00:00' }, '2026-10-04T21:00:00Z'),
    '2026-10-04T22:00:00.000Z',
  );
});
test('podgląd wycofuje akcje/zdarzenia/ruchy, wiek i AND/OR', async () => {
  const older = await datedOrder(new Date(Date.now() - 172800000).toISOString()),
    young = await order();
  const s = await schedule({
    min_age_seconds: 86400,
    conditions: [
      { field: 'country', op: 'eq', value: 'PL' },
      { field: 'total', op: 'gte', value: 5000 },
    ],
    match: 'any',
    actions: [
      { type: 'add_note', note: 'qa' },
      { type: 'set_status', status: 'cancelled' },
    ],
  });
  const before = (
    await pool.query('SELECT count(*) AS n FROM order_events WHERE tenant_id=$1', [tenant])
  ).rows[0].n;
  const preview = await ok('/api/automation-schedules/' + s.id + '/preview', 'POST', {});
  assert.equal(preview.data.length, 1);
  assert.equal(preview.data[0].order_id, older.id);
  assert.equal(preview.data[0].allowed, true);
  assert.equal((await note(older)).note, '');
  assert.equal((await note(older)).status, 'new');
  assert.equal(
    (await pool.query('SELECT count(*) AS n FROM order_events WHERE tenant_id=$1', [tenant]))
      .rows[0].n,
    before,
  );
  const r = await finish(await queue(s));
  assert.equal(r.done, 1);
  assert.equal((await note(older)).status, 'cancelled');
  assert.equal((await note(young)).status, 'new');
});
test('idempotencja tworzenia i uruchomienia, konflikt zakresu i wersji', async () => {
  const payload = { ...input(), client_key: randomUUID() },
    s = await ok('/api/automation-schedules', 'POST', payload);
  assert.equal((await ok('/api/automation-schedules', 'POST', payload)).id, s.id);
  assert.equal(
    (await req('/api/automation-schedules', 'POST', { ...payload, name: 'inna' })).statusCode,
    409,
  );
  const key = randomUUID(),
    r = await queue(s, key);
  assert.equal((await queue(s, key)).id, r.id);
  assert.equal(
    (
      await req('/api/automation-schedules/' + s.id + '/run', 'POST', {
        version: s.version,
        client_key: randomUUID(),
        confirmed: true,
      })
    ).statusCode,
    409,
  );
  await finish(r);
  const otherS = await schedule();
  assert.equal(
    (
      await req('/api/automation-schedules/' + otherS.id + '/run', 'POST', {
        version: otherS.version,
        client_key: key,
        confirmed: true,
      })
    ).statusCode,
    409,
  );
  const updated = await ok('/api/automation-schedules/' + s.id, 'PATCH', {
    version: s.version,
    enabled: false,
  });
  assert.equal((await queue(s, key)).id, r.id);
  assert.equal(
    (await req('/api/automation-schedules/' + s.id, 'PATCH', { version: s.version, enabled: true }))
      .statusCode,
    409,
  );
  assert.equal(updated.definition_version, s.definition_version);
});
test('25-elementowe partie, dokładny cursor, wznowienie i strony wyników', async () => {
  const ids = [];
  for (let i = 0; i < 61; i++) ids.push((await datedOrder('2026-10-01T00:00:00.123456Z')).id);
  const s = await schedule({ actions: [{ type: 'add_note', note: 'jednorazowo' }] }),
    r = await queue(s);
  assert.equal((await processPart(r)).done, 25);
  const stale = await claim(r);
  await pool.query("UPDATE jobs SET state='pending',lease_token=NULL WHERE id=$1", [stale.id]);
  await processSchedule(stale);
  assert.equal((await get(r)).done, 25);
  const final = await finish(r);
  assert.equal(final.done, 61);
  assert.equal(final.failed, 0);
  assert.equal(final.scanned, 61);
  const seen = new Set<string>();
  let page = final;
  for (;;) {
    for (const i of page.items) {
      assert(!seen.has(i.order_id));
      seen.add(i.order_id);
    }
    if (!page.meta.cursor) break;
    page = await get(r, page.meta.cursor);
  }
  assert.equal(seen.size, 61);
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM orders WHERE tenant_id=$1 AND note='jednorazowo'",
        [tenant],
      )
    ).rows[0].n,
    61,
  );
  const second = await finish(await queue(s));
  assert.equal(second.scanned, 0);
});
test('wyłączenie w połowie zachowuje wyniki i odcina stary worker, wznowienie bez powtórek', async () => {
  for (let i = 0; i < 30; i++) await order();
  const s = await schedule({ actions: [{ type: 'add_note', note: 'raz' }] }),
    r = await queue(s);
  await processPart(r);
  const old = await claim(r);
  const paused = await ok('/api/automation-schedules/' + s.id, 'PATCH', {
    version: s.version,
    enabled: false,
  });
  await processSchedule(old);
  assert.equal((await get(r)).state, 'cancelled');
  assert.equal((await get(r)).done, 25);
  const enabled = await ok('/api/automation-schedules/' + s.id, 'PATCH', {
    version: paused.version,
    enabled: true,
  });
  assert.equal(enabled.definition_version, s.definition_version);
  assert.equal((await finish(await queue(enabled))).done, 5);
  assert.equal(
    (
      await pool.query("SELECT count(*)::int AS n FROM orders WHERE tenant_id=$1 AND note='raz'", [
        tenant,
      ])
    ).rows[0].n,
    30,
  );
});
test('zmiana definicji jest nową selekcją, each_run powtarza jawnie', async () => {
  const o = await order(),
    s = await schedule({ actions: [{ type: 'add_note', note: 'A' }] });
  await finish(await queue(s));
  const full = { ...s.definition, actions: [{ type: 'add_note', note: 'B' }], version: s.version };
  const edited = await ok('/api/automation-schedules/' + s.id, 'PATCH', full);
  assert.equal(Number(edited.definition_version), 2);
  await finish(await queue(edited));
  assert.equal((await note(o)).note, 'A\nB');
  const repeating = await schedule({
    repetition: 'each_run',
    actions: [{ type: 'add_note', note: 'R' }],
  });
  await finish(await queue(repeating));
  await finish(await queue(repeating));
  assert.equal((await note(o)).note, 'A\nB\nR\nR');
});
test('ponowna ocena warunków i atomowy błąd zestawu akcji', async () => {
  const o = await order(),
    s = await schedule({
      conditions: [{ field: 'tag', op: 'not_contains', value: 'stop' }],
      actions: [
        { type: 'add_note', note: 'nie zostaje' },
        { type: 'set_status', status: 'shipped' },
      ],
    }),
    r = await queue(s);
  const result = await finish(r);
  assert.equal(result.failed, 1);
  assert.equal((await note(o)).note, '');
  assert.equal((await note(o)).status, 'new');
  const retry = await queue(s);
  await ok('/api/orders/' + o.id + '/operations', 'POST', { type: 'add_tag', tag: 'stop' });
  assert.equal((await finish(retry)).skipped, 1);
  assert.equal(
    (
      await pool.query(
        'SELECT count(*)::int AS n FROM automation_schedule_receipts WHERE schedule_id=$1',
        [s.id],
      )
    ).rows[0].n,
    0,
  );
});
test('dwa schedulery, zaległe terminy scalone i odebrane uprawnienia', async () => {
  await order();
  const s = await schedule();
  await pool.query("UPDATE automation_schedules SET next_at=now()-interval '20 days' WHERE id=$1", [
    s.id,
  ]);
  await Promise.all([scheduleAutomationsDue(), scheduleAutomationsDue()]);
  const runs = (await ok('/api/automation-schedules/' + s.id + '/runs')).data;
  assert.equal(runs.length, 1);
  await finish(runs[0]);
  assert(
    (
      await pool.query('SELECT next_at>now() AS future FROM automation_schedules WHERE id=$1', [
        s.id,
      ])
    ).rows[0].future,
  );
  const r = await queue(s);
  await pool.query("UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2", [
    tenant,
    adminId,
  ]);
  // Read is allowed; processing checks the owner again.
  assert.equal((await finish(r)).state, 'cancelled');
  await pool.query("UPDATE automation_schedules SET next_at=now()-interval '1 day' WHERE id=$1", [
    s.id,
  ]);
  await scheduleAutomationsDue();
  assert.equal(
    (await pool.query('SELECT enabled FROM automation_schedules WHERE id=$1', [s.id])).rows[0]
      .enabled,
    false,
  );
});
test('backpressure zachowuje cursor, retry po rollbacku i końcowy błąd widoczny', async () => {
  await order();
  const s = await schedule(),
    r = await queue(s);
  await pool.query(
    "INSERT INTO jobs(id,tenant_id,kind,payload,dedup_key) SELECT gen_random_uuid(),$1,'qa','{}','qa:'||n FROM generate_series(1,500)n",
    [tenant],
  );
  assert.equal((await processPart(r)).scanned, 0);
  assert.equal(
    (await pool.query('SELECT state,attempts FROM jobs WHERE id=$1', [r.job_id])).rows[0].attempts,
    0,
  );
  await pool.query("UPDATE jobs SET state='done' WHERE tenant_id=$1 AND kind='qa'", [tenant]);
  const failedClaim = await claim(r);
  await failSchedule(failedClaim, new Error('synthetic'));
  assert.equal((await get(r)).state, 'queued');
  assert.equal((await finish(r)).done, 1);
  const next = await queue(s);
  const fatal = await claim(next);
  fatal.attempts = 5;
  await pool.query('UPDATE jobs SET attempts=5 WHERE id=$1', [fatal.id]);
  await failSchedule(fatal, new Error('synthetic'));
  assert.equal((await get(next)).state, 'failed');
});
test('worker tick odzyskuje wygasłą dzierżawę z checkpointu', async () => {
  await order();
  const s = await schedule(),
    r = await queue(s);
  await claim(r);
  await pool.query("UPDATE jobs SET locked_at=now()-interval '3 minutes' WHERE id=$1", [r.job_id]);
  await pool.query("UPDATE jobs SET state='done',lease_token=NULL WHERE id<>$1", [r.job_id]);
  assert.equal(await tick(), true);
  assert.equal((await get(r)).done, 1);
});
test('waluta ogranicza kwoty, dwa workery i opóźnione nowe zamówienie', async () => {
  const o = await order(),
    s = await schedule({
      conditions: [{ field: 'currency', op: 'eq', value: 'PLN' }],
      actions: [{ type: 'add_note', note: 'waluta' }],
    });
  const r = await queue(s),
    j = await claim(r);
  await Promise.all([processSchedule(j), processSchedule(j)]);
  assert.equal((await get(r)).done, 1);
  assert.equal((await note(o)).note, 'waluta');
  const nextRun = await queue(s),
    late = await order();
  assert.equal((await finish(nextRun)).done, 0);
  assert.equal((await note(late)).note, '');
  assert.equal((await finish(await queue(s))).done, 1);
});
test('publiczne API ma osobne zakresy, bieżącą rolę i OpenAPI', async () => {
  const k = await ok('/api/developer/keys', 'POST', {
    name: 'QA harmonogramy',
    scopes: ['automations:read', 'automations:write'],
    expires_days: 1,
  });
  const key = k.token ?? k.key;
  assert.equal(typeof key, 'string');
  const call = (url: string, method: any = 'GET', payload?: any) =>
    app.inject({ url, method, payload, headers: { authorization: 'Bearer ' + key } });
  const r = await call('/api/v1/automation-schedules', 'POST', {
    ...input(),
    client_key: randomUUID(),
  });
  assert.equal(r.statusCode, 200, r.body);
  const s = r.json();
  assert.equal((await call('/api/v1/orders')).statusCode, 403);
  const readKey = await ok('/api/developer/keys', 'POST', {
    name: 'QA odczyt',
    scopes: ['automations:read'],
    expires_days: 1,
  });
  assert.equal(
    (
      await app.inject({
        url: '/api/v1/automation-schedules/' + s.id + '/run',
        method: 'POST',
        payload: { version: s.version, client_key: randomUUID(), confirmed: true },
        headers: { authorization: 'Bearer ' + (readKey.token ?? readKey.key) },
      })
    ).statusCode,
    403,
  );
  const spec = (await call('/api/v1/openapi')).json();
  assert(spec.paths['/automation-schedules/{id}/run']);
  await pool.query("UPDATE memberships SET role='operator' WHERE tenant_id=$1 AND user_id=$2", [
    tenant,
    adminId,
  ]);
  assert.equal(
    (await call('/api/v1/automation-schedules/' + s.id + '/preview', 'POST', {})).statusCode,
    401,
  );
});
test('awaria po akcjach przed checkpointem wycofuje wszystko i retry nie powiela notatki', async () => {
  const o = await order(),
    s = await schedule({ actions: [{ type: 'add_note', note: 'atomowo' }] }),
    r = await queue(s),
    j = await claim(r);
  await pool.query(
    `CREATE FUNCTION qa_schedule_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='automation.schedule.batch' THEN RAISE EXCEPTION 'synthetic failure before commit'; END IF; RETURN NEW; END $$; CREATE TRIGGER qa_schedule_failure BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION qa_schedule_failure()`,
  );
  try {
    await assert.rejects(processSchedule(j), /synthetic failure/);
  } finally {
    await pool.query(
      'DROP TRIGGER qa_schedule_failure ON audit_events; DROP FUNCTION qa_schedule_failure()',
    );
  }
  assert.equal((await note(o)).note, '');
  assert.equal((await get(r)).scanned, 0);
  assert.equal((await get(r)).items.length, 0);
  await failSchedule(j, new Error('synthetic retry'));
  assert.equal((await finish(r)).done, 1);
  assert.equal((await note(o)).note, 'atomowo');
});

test('pełny zapis bez zmian zachowuje definicję, usunięty cel nie blokuje wyłączenia', async () => {
  const s = await schedule();
  const unchanged = await ok('/api/automation-schedules/' + s.id, 'PATCH', {
    ...s.definition,
    version: s.version,
  });
  assert.equal(unchanged.definition_version, s.definition_version);
  const target = await ok('/api/workflow-statuses', 'POST', {
    name: 'QA cel',
    stage: 'new',
    color: '#2563eb',
  });
  const bad = await schedule({ actions: [{ type: 'set_workflow', status_id: target.id }] });
  await pool.query('DELETE FROM workflow_statuses WHERE id=$1', [target.id]);
  const paused = await ok('/api/automation-schedules/' + bad.id, 'PATCH', {
    version: bad.version,
    enabled: false,
  });
  assert.equal(paused.enabled, false);
});
