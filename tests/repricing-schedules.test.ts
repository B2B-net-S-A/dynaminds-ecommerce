import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../server/app';
import { pool, migrate, tenantTx } from '../server/db';
import { seed, SECOND_TENANT } from './fixtures';
import { tick } from '../server/worker';
import {
  scheduleRepricingDue,
  processRepricing,
  failRepricing,
} from '../server/repricing-schedules';
assert.equal(process.env.DYNA_TEST, 'true');
let app: Awaited<ReturnType<typeof buildApp>>,
  cookie = '',
  viewer = '',
  other = '',
  tenant = '',
  actor = '';
const req = (path: string, method: any = 'GET', payload?: any, auth = cookie, extra: any = {}) =>
  app.inject({ url: '/api' + path, method, payload, headers: { cookie: auth, ...extra } });
async function ok(path: string, method: any = 'GET', payload?: any) {
  const r = await req(path, method, payload);
  assert(r.statusCode < 300, r.body);
  return r.json();
}
before(async () => {
  await migrate();
  await seed();
  app = await buildApp();
  cookie = (
    await req('/auth/signup', 'POST', {
      email: 'repricing-schedule-test@demo.local',
      password: 'DynaDemo!2026',
      name: 'Auto Repricing QA',
      organization: { name: 'Auto Repricing QA' },
    })
  ).headers['set-cookie']!.toString().split(';')[0];
  const me = (await ok('/auth/me')).user;
  tenant = me.tenant_id;
  actor = me.id;
  await ok('/workspaces/plan', 'PATCH', { plan: 'enterprise' });
  for (const email of ['viewer@demo.local', 'other@demo.local']) {
    const r = await req('/auth/login', 'POST', { email, password: 'DynaDemo!2026' });
    if (email.startsWith('viewer')) viewer = r.headers['set-cookie']!.toString().split(';')[0];
    else other = r.headers['set-cookie']!.toString().split(';')[0];
  }
});
after(async () => {
  await app.close();
  await pool.end();
});
async function fixture(count = 3, extra: any = {}) {
  const list = await ok('/price-lists', 'POST', {
      name: 'Auto ' + randomUUID(),
      currency: 'PLN',
      fallback: true,
    }),
    root = '/price-lists/' + list.id + '/repricing';
  let rule = await ok(root, 'PUT', { version: 0, config: { fee_bps: 500, ...extra } });
  const products = await tenantTx(tenant, async (c) =>
    (
      await c.query(
        "INSERT INTO products(id,tenant_id,sku,name,price) SELECT gen_random_uuid(),$1,$2||g,'Auto repricing',20000 FROM generate_series(1,$3::int) g RETURNING id,sku",
        [tenant, 'RPA-' + randomUUID() + '-', count],
      )
    ).rows.sort((a, b) => a.id.localeCompare(b.id)),
  );
  for (let offset = 0; offset < products.length; offset += 500)
    rule = await ok(root + '/inputs', 'PUT', {
      version: rule.version,
      items: products
        .slice(offset, offset + 500)
        .map((p) => ({ product_id: p.id, net_cost: 10000, source: 'Synthetic cost QA' })),
    });
  return { list, root, rule, products, cfg: null as any };
}
async function configure(f: any, extra: any = {}) {
  f.cfg = (
    await ok(f.root + '/schedule', 'PUT', {
      version: f.cfg?.version ?? 0,
      enabled: true,
      rule_config_version: f.rule.config_version,
      interval_minutes: 5,
      batch_size: 2,
      confirmed: true,
      ...extra,
    })
  ).schedule;
  return f.cfg;
}
const runNow = (f: any, key = randomUUID()) =>
  ok(f.root + '/schedule/run', 'POST', { version: f.cfg.version, client_key: key });
const detail = async (id: string) => (await ok('/repricing-runs/' + id)).run;
async function step(id: string) {
  await pool.query(
    "UPDATE jobs SET run_at=CASE WHEN payload->>'run_id'=$1 THEN now() ELSE '2100-01-01'::timestamptz END WHERE state='pending'",
    [id],
  );
  return tick({
    transport: async () => {
      throw Error('No provider HTTP authorized in test');
    },
  });
}
async function drain(id: string) {
  for (let n = 0; n < 500; n++) {
    const r = await detail(id);
    if (r.state !== 'queued') return r;
    await step(id);
  }
  throw Error('drain limit');
}
const cfg = async (f: any) => (await ok(f.root + '/schedule')).schedule;
const due = async (f: any) =>
  pool.query(
    "UPDATE repricing_schedules SET next_at=now()-interval '1 second' WHERE price_list_id=$1",
    [f.list.id],
  );
const listVersion = async (f: any) =>
  (await ok('/price-lists/' + f.list.id + '/items')).list.version;
async function editInput(f: any, cost = 10000, extra: any = {}) {
  f.rule = await ok(f.root + '/inputs', 'PUT', {
    version: f.rule.version,
    items: [{ product_id: f.products[0].id, net_cost: cost, source: 'Updated cost QA', ...extra }],
  });
}
test('admin, zgoda, granice, wersje i izolacja konfiguracji', async () => {
  const f = await fixture();
  assert.equal(await cfg(f), null);
  for (const extra of [
    { interval_minutes: 4 },
    { interval_minutes: 10081 },
    { batch_size: 201 },
    { batch_size: 0 },
    { confirmed: false },
  ])
    assert.equal(
      (
        await req(f.root + '/schedule', 'PUT', {
          version: 0,
          enabled: true,
          rule_config_version: f.rule.config_version,
          interval_minutes: 5,
          batch_size: 2,
          confirmed: true,
          ...extra,
        })
      ).statusCode,
      422,
    );
  assert.equal((await req(f.root + '/schedule', 'GET', undefined, other)).statusCode, 404);
  assert.equal((await req(f.root + '/schedule', 'PUT', {}, viewer)).statusCode, 403);
  const body = {
    version: 0,
    enabled: true,
    rule_config_version: f.rule.config_version,
    interval_minutes: 5,
    batch_size: 2,
    confirmed: true,
  };
  const r = await Promise.all([
    req(f.root + '/schedule', 'PUT', body),
    req(f.root + '/schedule', 'PUT', body),
  ]);
  assert.deepEqual(r.map((i) => i.statusCode).sort(), [200, 409]);
  f.cfg = await cfg(f);
  await configure(f, { enabled: false, confirmed: false });
});
test('due deduplikuje scheduler, własne zmiany wersji cennika nie blokują kolejnych partii', async () => {
  const f = await fixture(5);
  await configure(f);
  await due(f);
  await Promise.all([scheduleRepricingDue(), scheduleRepricingDue()]);
  const runs = (await ok(f.root + '/runs')).data;
  assert.equal(runs.length, 1);
  assert.equal((await cfg(f)).next_at, null);
  const r = await drain(runs[0].id);
  assert.equal(r.state, 'success');
  assert.equal(r.scanned, 5);
  assert.equal(r.changed, 5);
  assert.equal(r.expected_list_version, 4);
  const pages = (await ok('/repricing-runs/' + r.id)).data;
  assert.equal(pages.length, 3);
  assert(pages.every((p: any) => p.state === 'applied'));
  const c = await cfg(f);
  assert(new Date(c.next_at).getTime() >= new Date(r.finished_at).getTime() + 5 * 60000);
  assert.equal(await listVersion(f), 4);
  await configure(f, { enabled: false, confirmed: false });
});
test('run-now replay i brak równoległych przebiegów mają jedno trwałe zadanie', async () => {
  const f = await fixture();
  await configure(f);
  const key = randomUUID(),
    [a, b] = await Promise.all([runNow(f, key), runNow(f, key)]);
  assert.equal(a.id, b.id);
  assert.equal(
    (
      await req(f.root + '/schedule/run', 'POST', {
        version: f.cfg.version,
        client_key: randomUUID(),
      })
    ).statusCode,
    409,
  );
  await drain(a.id);
  assert.equal((await runNow(f, key)).id, a.id);
  const g = await fixture();
  await configure(g);
  assert.equal(
    (await req(g.root + '/schedule/run', 'POST', { version: g.cfg.version, client_key: key }))
      .statusCode,
    409,
  );
  await configure(f, { enabled: false });
  await configure(g, { enabled: false });
});
test('nowe koszty zatrzymują bieżący przebieg, następny używa nowych danych bez ponownej zgody', async () => {
  const f = await fixture(5);
  await configure(f);
  const a = await runNow(f);
  await step(a.id);
  await editInput(f, 12000);
  await step(a.id);
  const first = await detail(a.id);
  assert.equal(first.state, 'partial');
  assert.equal(first.changed, 2);
  assert((await cfg(f)).enabled);
  const b = await runNow(f);
  const next = await drain(b.id);
  assert.equal(next.state, 'success');
  assert.equal(next.scanned, 5);
  assert.equal(next.changed, 4);
  assert.equal(next.unchanged, 1);
  await configure(f, { enabled: false });
});
test('zmiana definicji wyłącza automat i nie cofa już zapisanej partii', async () => {
  const f = await fixture(5);
  await configure(f);
  const r = await runNow(f);
  await step(r.id);
  f.rule = await ok(f.root, 'PUT', {
    version: f.rule.version,
    config: { ...f.rule.config, target_margin_bps: 2500 },
  });
  assert.equal(f.rule.config_version, 2);
  const c = await cfg(f);
  f.cfg = c;
  assert.equal(c.enabled, false);
  assert.equal(c.next_at, null);
  assert.equal((await detail(r.id)).state, 'partial');
  assert.equal((await detail(r.id)).changed, 2);
  assert.equal(await step(r.id), false);
  await configure(f);
  const next = await drain((await runNow(f)).id);
  assert.equal(next.state, 'success');
  await configure(f, { enabled: false });
});
test('ręczna edycja cennika między partiami nie jest nadpisana starym wykonaniem', async () => {
  const f = await fixture(5);
  await configure(f);
  const r = await runNow(f);
  await step(r.id);
  await ok('/price-lists/' + f.list.id + '/items', 'PUT', {
    version: 2,
    items: [{ product_id: f.products.at(-1).id, price: 7777 }],
  });
  await step(r.id);
  assert.equal((await detail(r.id)).state, 'partial');
  assert.equal(await listVersion(f), 3);
  const q = await ok('/pricing/quote', 'POST', {
    price_list_id: f.list.id,
    product_ids: [f.products.at(-1).id],
  });
  assert.equal(q.items[0].price, 7777);
  await configure(f, { enabled: false });
});
test('stare obserwacje blokują całą partię, historia zachowuje przyczyny i częściowy wynik', async () => {
  const f = await fixture(5, { strategy: 'competitor', observation_minutes: 1 });
  f.rule = await ok(f.root + '/inputs', 'PUT', {
    version: f.rule.version,
    items: f.products.map((p: any, n: number) => ({
      product_id: p.id,
      net_cost: 10000,
      source: 'QA competitor',
      competitor_price: 18000,
      observed_at: new Date(Date.now() - (n === 3 ? 120000 : 0)).toISOString(),
    })),
  });
  await configure(f);
  const r = await drain((await runNow(f)).id);
  assert.equal(r.state, 'partial');
  assert.equal(r.changed, 2);
  assert.equal(r.scanned, 4);
  assert.equal(r.skipped, 1);
  assert.equal(r.blocked, 1);
  const parts = (await ok('/repricing-runs/' + r.id)).data;
  assert.equal(parts.filter((p: any) => p.state === 'preview').length, 1);
  assert(parts.some((p: any) => p.result.some((i: any) => i.reason.includes('nieaktualna'))));
  await configure(f, { enabled: false });
});
test('wyłączenie i zmiana harmonogramu anulują pozostałe partie; manualny podgląd pozostaje ważny', async () => {
  const f = await fixture(5);
  await configure(f);
  const manual = await ok(f.root + '/previews', 'POST', {
    client_key: randomUUID(),
    product_ids: [f.products[0].id],
  });
  const r = await runNow(f);
  await configure(f, { enabled: false });
  assert.equal((await detail(r.id)).state, 'cancelled');
  assert.equal(await step(r.id), false);
  await ok('/repricing-previews/' + manual.id + '/apply', 'POST', { confirmed: true });
  assert.equal(await listVersion(f), 2);
  await configure(f);
  const a = await runNow(f);
  await step(a.id);
  await configure(f, { batch_size: 1 });
  assert.equal((await detail(a.id)).state, 'partial');
  await configure(f, { enabled: false });
});
test('utrata roli autora przed due i po pierwszej partii wyłącza harmonogram', async () => {
  for (const started of [false, true]) {
    const f = await fixture(5);
    await configure(f);
    let r: any;
    if (started) {
      r = await runNow(f);
      await step(r.id);
    } else await due(f);
    await pool.query("UPDATE memberships SET role='operator' WHERE tenant_id=$1 AND user_id=$2", [
      tenant,
      actor,
    ]);
    try {
      if (started) await step(r.id);
      else await scheduleRepricingDue();
      assert.equal((await cfg(f)).enabled, false);
      if (started) assert.equal((await detail(r.id)).state, 'partial');
      else assert.equal((await ok(f.root + '/runs')).data.length, 0);
    } finally {
      await pool.query("UPDATE memberships SET role='admin' WHERE tenant_id=$1 AND user_id=$2", [
        tenant,
        actor,
      ]);
    }
  }
});
test('nieaktywny cennik lub wyłączona reguła zatrzymuje automat bez zapisu', async () => {
  const f = await fixture();
  await configure(f);
  const r = await runNow(f);
  await pool.query('UPDATE price_lists SET active=false WHERE id=$1', [f.list.id]);
  await step(r.id);
  assert.equal((await detail(r.id)).state, 'failed');
  assert.equal((await cfg(f)).enabled, false);
  assert.equal(await listVersion(f), 1);
});
test('stary lease nie zapisuje ceny ani checkpointu, właściciel nowego lease kontynuuje raz', async () => {
  const f = await fixture();
  await configure(f);
  const r = await runNow(f);
  const j = (
    await pool.query(
      "UPDATE jobs SET state='running',lease_token=$2,locked_at=now(),attempts=1 WHERE id=$1 RETURNING *",
      [r.job_id, randomUUID()],
    )
  ).rows[0];
  const newer = (
    await pool.query('UPDATE jobs SET lease_token=$2 WHERE id=$1 RETURNING *', [j.id, randomUUID()])
  ).rows[0];
  await processRepricing(j);
  assert.equal((await detail(r.id)).scanned, 0);
  assert.equal(await listVersion(f), 1);
  await processRepricing(newer);
  assert.equal((await detail(r.id)).changed, 2);
  await drain(r.id);
  await configure(f, { enabled: false });
});
test('retry i terminalny lease zachowują checkpoint; brak nadrabiania zaległych terminów', async () => {
  const f = await fixture();
  await configure(f);
  const r = await runNow(f),
    j = (
      await pool.query(
        "UPDATE jobs SET state='running',attempts=1,lease_token=$2,locked_at=now() WHERE id=$1 RETURNING *",
        [r.job_id, randomUUID()],
      )
    ).rows[0];
  await failRepricing(j, new Error('QA transient'));
  assert.equal((await detail(r.id)).scanned, 0);
  assert.equal(
    (await pool.query('SELECT state FROM jobs WHERE id=$1', [j.id])).rows[0].state,
    'pending',
  );
  await step(r.id);
  assert.equal((await detail(r.id)).changed, 2);
  await pool.query(
    "UPDATE jobs SET state='running',attempts=max_attempts,lease_token=$2,locked_at=now()-interval '3 minutes' WHERE id=$1",
    [j.id, randomUUID()],
  );
  await step(r.id);
  await scheduleRepricingDue();
  const done = await detail(r.id);
  assert.equal(done.state, 'partial');
  assert.equal(done.changed, 2);
  assert((await cfg(f)).next_at);
  await scheduleRepricingDue();
  assert.equal((await ok(f.root + '/runs')).data.length, 1);
  await configure(f, { enabled: false });
});
test('kolejka pełna odracza due i nie mnoży zadań', async () => {
  const f = await fixture();
  await configure(f);
  await due(f);
  const prefix = 'reprice-full-' + randomUUID();
  await pool.query(
    "INSERT INTO jobs(id,tenant_id,kind,payload,dedup_key) SELECT gen_random_uuid(),$1,'qa.backpressure','{}',$2||g FROM generate_series(1,1000) g",
    [tenant, prefix],
  );
  try {
    await scheduleRepricingDue();
    const c = await cfg(f);
    assert(c.enabled);
    assert(c.error.includes('pełna'));
    assert.equal((await ok(f.root + '/runs')).data.length, 0);
    assert(new Date(c.next_at).getTime() > Date.now());
  } finally {
    await pool.query('DELETE FROM jobs WHERE tenant_id=$1 AND dedup_key LIKE $2', [
      tenant,
      prefix + '%',
    ]);
  }
  await configure(f, { enabled: false });
});
test('1001 SKU przechodzi checkpointy, paginację partii i drugi przebieg bez zmian', async () => {
  const f = await fixture(1001);
  await configure(f, { batch_size: 200 });
  const start = performance.now(),
    r = await drain((await runNow(f)).id);
  assert.equal(r.state, 'success');
  assert.equal(r.scanned, 1001);
  assert.equal(r.changed, 1001);
  assert.equal(r.expected_list_version, 7);
  let cursor: string | null = null,
    parts: any[] = [];
  do {
    const p = await ok('/repricing-runs/' + r.id + '?limit=2' + (cursor ? '&after=' + cursor : ''));
    parts.push(...p.data);
    cursor = p.meta.cursor;
  } while (cursor);
  assert.equal(parts.length, 6);
  assert.equal(new Set(parts.flatMap((p) => p.result.map((i: any) => i.product_id))).size, 1001);
  const n = await drain((await runNow(f)).id);
  assert.equal(n.changed, 0);
  assert.equal(n.unchanged, 1001);
  assert.equal(await listVersion(f), 7);
  await configure(f, { enabled: false });
  console.log(
    'Automatic repricing 1001 SKU, two runs, checkpoint/pages (isolated DB): ' +
      Math.round(performance.now() - start) +
      'ms; not sustained capacity proof',
  );
});
test('RLS, klucze API, anulowanie i read-only restore blokują nieuprawnione zapisy', async () => {
  const f = await fixture();
  await configure(f);
  const r = await runNow(f);
  assert.equal((await req('/repricing-runs/' + r.id, 'GET', undefined, other)).statusCode, 404);
  assert.equal(
    (await req('/repricing-runs/' + r.id + '/cancel', 'POST', { confirmed: true }, viewer))
      .statusCode,
    403,
  );
  await tenantTx(SECOND_TENANT, async (c) => {
    for (const table of ['repricing_schedules', 'repricing_runs'])
      assert.equal((await c.query('SELECT * FROM ' + table)).rowCount, 0);
  });
  await assert.rejects(
    tenantTx(SECOND_TENANT, (c) =>
      c.query(
        'INSERT INTO repricing_schedules(tenant_id,price_list_id,actor_id,rule_config_version,interval_minutes,batch_size) VALUES($1,$2,$3,1,5,1)',
        [tenant, f.list.id, actor],
      ),
    ),
  );
  const k = await ok('/developer/keys', 'POST', {
      name: 'Schedule read',
      scopes: ['products:read'],
    }),
    headers = { authorization: 'Bearer ' + k.token };
  assert.equal(
    (await req('/v1/repricing-runs/' + r.id, 'GET', undefined, '', headers)).statusCode,
    200,
  );
  assert.equal(
    (await req('/v1/repricing-runs/' + r.id + '/cancel', 'POST', { confirmed: true }, '', headers))
      .statusCode,
    403,
  );
  const spec = (await req('/v1/openapi')).json();
  assert(spec.paths['/repricing-runs/{id}']);
  const copy = await buildApp({ readOnly: true });
  try {
    assert.equal(
      (await copy.inject({ url: '/api' + f.root + '/schedule', headers: { cookie } })).statusCode,
      401,
    );
    const login = await copy.inject({
      url: '/api/auth/login', method: 'POST',
      payload: { email: 'repricing-schedule-test@demo.local', password: 'DynaDemo!2026' },
    });
    assert.equal(login.statusCode, 200, login.body);
    const copyCookie = String(login.headers['set-cookie']).split(';')[0];
    assert.equal(
      (await copy.inject({ url: '/api' + f.root + '/schedule', headers: { cookie: copyCookie } })).statusCode,
      200,
    );
    assert.equal(
      (
        await copy.inject({
          url: '/api/repricing-runs/' + r.id + '/cancel',
          method: 'POST',
          payload: { confirmed: true },
          headers: { cookie: copyCookie },
        })
      ).statusCode,
      423,
    );
  } finally {
    await copy.close();
  }
  const cancelled = await ok('/repricing-runs/' + r.id + '/cancel', 'POST', { confirmed: true });
  assert.equal(cancelled.state, 'cancelled');
  assert((await cfg(f)).enabled);
  assert.equal(
    (await ok('/repricing-runs/' + r.id + '/cancel', 'POST', { confirmed: true })).state,
    'cancelled',
  );
  await configure(f, { enabled: false });
});
test('pusty cennik kończy się jawnie bez zmian i bez fikcyjnego podglądu', async () => {
  const f = await fixture(0);
  await configure(f);
  const r = await drain((await runNow(f)).id);
  assert.equal(r.state, 'success');
  assert.equal(r.total, 0);
  assert.equal(r.scanned, 0);
  assert.equal(await listVersion(f), 1);
  assert.equal((await ok('/repricing-runs/' + r.id)).data.length, 0);
  await configure(f, { enabled: false });
});
