// Native local QA only. Deadline advance touches only this synthetic fixture.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pool } from '../server/db';
const file = 'data/repricing-schedules-stage041.json',
  email = 'qa-repricing-auto@demo.local',
  password = 'DynaDemo!2026';
const tables = [
  ...Object.keys(JSON.parse(await readFile('data/repricing-stage040.json', 'utf8')).before),
  'repricing_rules',
  'repricing_inputs',
  'repricing_previews',
];
let state: any,
  cookie = '';
async function fingerprint(tenants: string[]) {
  const out: any = {};
  for (const table of tables) {
    assert(/^[a-z_]+$/.test(table));
    const projection =
      table === 'repricing_rules'
        ? "to_jsonb(t)-'config_version'"
        : table === 'repricing_previews'
          ? "to_jsonb(t)-'schedule_run_id'"
          : 'to_jsonb(t)';
    const rows = (
      await pool.query(
        'SELECT (' +
          projection +
          ')::text row FROM ' +
          table +
          ' t WHERE tenant_id=ANY($1::uuid[]) ORDER BY 1',
        [tenants],
      )
    ).rows;
    out[table] = {
      count: rows.length,
      sha256: createHash('sha256').update(JSON.stringify(rows)).digest('hex'),
    };
  }
  return out;
}
async function api(path: string, method = 'GET', body?: any, expected = 200) {
  const r = await fetch('http://127.0.0.1:4100/api' + path, {
    method,
    headers: {
      cookie,
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(path === '/orders' ? { 'idempotency-key': randomUUID() } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (r.headers.get('set-cookie')) cookie = r.headers.get('set-cookie')!.split(';')[0];
  const d = await r.json();
  assert.equal(r.status, expected, path + ': ' + JSON.stringify(d));
  return d;
}
const save = () => writeFile(file, JSON.stringify(state), { mode: 0o600 });
try {
  const phase = process.argv[2];
  if (phase === 'baseline') {
    assert(
      !(await pool.query("SELECT 1 FROM migrations WHERE name='034_repricing_schedules'")).rowCount,
    );
    const tenants = (await pool.query('SELECT id FROM tenants ORDER BY id')).rows.map((r) => r.id);
    state = { tenants, before: await fingerprint(tenants) };
    await save();
    console.log(JSON.stringify({ old_tenants: tenants.length, business_tables: tables.length }));
  } else {
    state = JSON.parse(await readFile(file, 'utf8'));
    if (phase === 'setup' && !state.fixture) {
      await api(
        '/auth/signup',
        'POST',
        {
          email,
          password,
          name: 'QA Automat repricingu',
          organization: { name: 'QA Automat repricingu 20261004' },
        },
        201,
      );
      state.fixture = { tenant: (await api('/auth/me')).user.tenant_id };
      await save();
    } else await api('/auth/login', 'POST', { email, password });
    const f = state.fixture,
      health = await api('/health');
    assert.equal(health.schema_revision, '034_repricing_schedules');
    if (phase === 'setup') {
      await api('/workspaces/plan', 'PATCH', { plan: 'enterprise' });
      f.warehouse = (await api('/warehouses')).data[0].id;
      f.products = [];
      for (let n = 1; n <= 6; n++) {
        const p = await api(
          '/products',
          'POST',
          {
            name: 'Produkt automatu ' + n,
            sku: 'AUTO-RP-' + n,
            price: 20000,
            vat: 23,
            quantity: 12,
            warehouse_id: f.warehouse,
          },
          201,
        );
        f.products.push(p);
      }
      f.list = await api(
        '/price-lists',
        'POST',
        { name: 'Automat • sklep PLN', currency: 'PLN', fallback: true },
        201,
      );
      const root = '/price-lists/' + f.list.id + '/repricing';
      f.rule = await api(root, 'PUT', { version: 0, config: { fee_bps: 500, ending: 99 } });
      f.rule = await api(root + '/inputs', 'PUT', {
        version: f.rule.version,
        items: f.products.map((p: any) => ({
          product_id: p.id,
          net_cost: 10000,
          source: 'Koszt demonstracyjny QA',
        })),
      });
      f.old_order = await api(
        '/orders',
        'POST',
        {
          customer_name: 'QA Automat przed zmianą',
          email: 'buyer@example.test',
          warehouse_id: f.warehouse,
          price_list_id: f.list.id,
          items: [{ product_id: f.products[0].id, quantity: 1 }],
        },
        201,
      );
      await api('/orders/' + f.old_order.id + '/status', 'PATCH', { status: 'cancelled' });
      await save();
      console.log(
        JSON.stringify({
          tenant: f.tenant,
          list: f.list.id,
          sku: f.products.map((p: any) => p.sku),
        }),
      );
    }
    if (phase === 'due') {
      const cfg = (await api('/price-lists/' + f.list.id + '/repricing/schedule')).schedule;
      assert(cfg.enabled);
      assert.equal(cfg.version, 1);
      assert.equal(cfg.interval_minutes, 5);
      assert.equal(cfg.batch_size, 2);
      assert.equal(cfg.last_run_id, null);
      await pool.query(
        "UPDATE repricing_schedules SET next_at=now()-interval '1 second' WHERE tenant_id=$1 AND price_list_id=$2",
        [f.tenant, f.list.id],
      );
      state.clock_advanced_for_own_qa = true;
      await save();
      console.log('Own fixture deadline advanced; native worker must enqueue and process it.');
    }
    if (phase === 'verify' || phase === 'runtime') {
      const cfg = (await api('/price-lists/' + f.list.id + '/repricing/schedule')).schedule;
      assert.equal(cfg.enabled, false);
      assert.equal(cfg.next_at, null);
      assert.equal(cfg.version, 2);
      const runs = (await api('/price-lists/' + f.list.id + '/repricing/runs')).data;
      assert.equal(runs.length, 2);
      assert(
        runs.every(
          (r: any) =>
            r.state === 'success' &&
            r.total === 6 &&
            r.scanned === 6 &&
            r.blocked === 0 &&
            r.skipped === 0,
        ),
      );
      assert.deepEqual(
        runs.map((r: any) => r.changed).sort((a: number, b: number) => a - b),
        [0, 6],
      );
      assert.deepEqual(
        runs.map((r: any) => r.unchanged).sort((a: number, b: number) => a - b),
        [0, 6],
      );
      const pages: any[] = [];
      for (const r of runs) {
        const d = await api('/repricing-runs/' + r.id);
        assert.equal(d.data.length, 3);
        pages.push(...d.data);
      }
      assert.equal(pages.length, 6);
      assert(pages.every((p) => p.state === 'applied'));
      const q = await api('/pricing/quote', 'POST', {
        price_list_id: f.list.id,
        product_ids: f.products.map((p: any) => p.id),
      });
      assert(q.items.every((p: any) => p.price === 16499));
      assert.equal(q.list.version, 4);
      const old = await api('/orders/' + f.old_order.id);
      assert.equal(old.total, f.old_order.total);
      assert.deepEqual(old.pricing_snapshot, f.old_order.pricing_snapshot);
      if (!f.order) {
        f.order = await api(
          '/orders',
          'POST',
          {
            customer_name: 'QA Automat po zmianie',
            email: 'buyer@example.test',
            warehouse_id: f.warehouse,
            price_list_id: f.list.id,
            items: [{ product_id: f.products[0].id, quantity: 2 }],
          },
          201,
        );
        await api('/orders/' + f.order.id + '/status', 'PATCH', { status: 'cancelled' });
        await save();
      }
      const order = await api('/orders/' + f.order.id);
      assert.equal(order.total, 32998);
      assert.equal(order.items[0].price, 16499);
      const stock = (
        await pool.query('SELECT on_hand,reserved FROM stock WHERE tenant_id=$1', [f.tenant])
      ).rows;
      assert.equal(stock.length, 6);
      assert(stock.every((i) => i.on_hand === 12 && i.reserved === 0));
      assert(
        (await pool.query('SELECT price FROM products WHERE tenant_id=$1', [f.tenant])).rows.every(
          (p) => p.price === 20000,
        ),
      );
      assert.deepEqual(await fingerprint(state.tenants), state.before);
      assert.equal(
        (
          await pool.query(
            'SELECT 1 FROM repricing_previews WHERE tenant_id=ANY($1::uuid[]) AND schedule_run_id IS NOT NULL',
            [state.tenants],
          )
        ).rowCount,
        0,
      );
      const h = await api('/health');
      const proof = {
        checked_at: new Date().toISOString(),
        scope: 'native_local_worker_chrome_synthetic',
        schema_revision: h.schema_revision,
        runtime_revision: h.revision,
        old_tenants_preserved: state.tenants.length,
        business_tables_unchanged: tables.length,
        clock_advanced_for_own_qa: state.clock_advanced_for_own_qa,
        success_runs: 2,
        batches: 6,
        changed: 6,
        unchanged: 6,
        list_version: 4,
        price: 16499,
        historical_order_unchanged: true,
        new_order_total: 32998,
        stock_unchanged: true,
        disabled_after_qa: true,
        provider_requests: 0,
      };
      await writeFile(
        phase === 'runtime'
          ? 'data/repricing-schedules-stage041-runtime.json'
          : 'docs/repricing-schedules-qa.json',
        JSON.stringify(proof, null, 2) + '\n',
      );
      console.log(JSON.stringify(proof));
    }
  }
} finally {
  await pool.end();
}
