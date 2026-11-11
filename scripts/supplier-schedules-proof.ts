// Local synthetic organization. No external provider requests.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pool } from '../server/db';
const file = 'data/supplier-schedules-stage039.json',
  email = 'qa-supplier-schedule@demo.local',
  password = 'DynaDemo!2026';
const tables = [
  ...Object.keys(JSON.parse(await readFile('data/supplier-bulk-stage038.json', 'utf8')).before),
  'supplier_bulk_runs',
  'supplier_bulk_parts',
  'supplier_bulk_issues',
];
let state: any,
  cookie = '';
async function fingerprint(tenants: string[]) {
  const out: any = {};
  for (const table of tables) {
    assert(/^[a-z_]+$/.test(table));
    const projection =
      table === 'supplier_bulk_runs' ? "to_jsonb(t)-'schedule_version'" : 'to_jsonb(t)';
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
const save = () => writeFile(file, JSON.stringify(state), { mode: 0o600 });
async function api(path: string, method = 'GET', body?: any, expected = 200) {
  const r = await fetch('http://127.0.0.1:4100/api' + path, {
    method,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (r.headers.get('set-cookie')) cookie = r.headers.get('set-cookie')!.split(';')[0];
  const d = await r.json();
  assert.equal(r.status, expected, path + ': ' + JSON.stringify(d));
  return d;
}
try {
  const phase = process.argv[2];
  if (phase === 'baseline') {
    assert(
      !(await pool.query("SELECT 1 FROM migrations WHERE name='032_supplier_schedules'")).rowCount,
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
          name: 'QA Harmonogram hurtowni',
          organization: { name: 'QA Harmonogram hurtowni 20261004' },
        },
        201,
      );
      const me = (await api('/auth/me')).user;
      state.fixture = { tenant: me.tenant_id };
      await save();
    } else await api('/auth/login', 'POST', { email, password });
    const f = state.fixture;
    if (phase === 'setup') {
      await api('/workspaces/plan', 'PATCH', { plan: 'enterprise' });
      if (!f.supplier) {
        f.supplier = (
          await api(
            '/suppliers',
            'POST',
            { name: 'BigBuy harmonogram QA', code: 'BB-AUTO-QA' },
            201,
          )
        ).id;
        await save();
      }
      console.log(JSON.stringify(f));
    }
    if (phase === 'due') {
      f.source = (await api('/supplier-sources')).data[0].id;
      const c = (await api('/supplier-sources/' + f.source + '/schedule')).schedule;
      assert(c.enabled);
      assert.equal(c.interval_minutes, 30);
      assert.equal(c.page_size, 50);
      assert.equal(c.last_bulk_id, null);
      await pool.query(
        "UPDATE supplier_schedules SET next_at=now()-interval '1 second' WHERE tenant_id=$1 AND source_id=$2",
        [f.tenant, f.source],
      );
      state.clock_advanced_for_due_fixture = true;
      await save();
      console.log('Fixture deadline advanced; live worker must dispatch it.');
    }
    if (phase === 'verify' || phase === 'runtime') {
      f.source = (await api('/supplier-sources')).data[0].id;
      const c = (await api('/supplier-sources/' + f.source + '/schedule')).schedule;
      assert(c);
      assert.equal(c.enabled, false);
      assert.equal(c.next_at, null);
      const runs = (await api('/supplier-bulk-runs?source_id=' + f.source)).data;
      assert.equal(runs.length, 2);
      assert(
        runs.every(
          (r: any) =>
            r.state === 'success' &&
            r.schedule_version === 1 &&
            r.published === 107 &&
            r.rejected === 0,
        ),
      );
      assert.notEqual(runs[0].id, runs[1].id);
      const rows: any[] = [];
      let cursor: string | null = null;
      do {
        const p = await api(
          '/supplier-catalog?source_id=' +
            f.source +
            '&limit=25' +
            (cursor ? '&after=' + cursor : ''),
        );
        rows.push(...p.data);
        cursor = p.meta.cursor;
      } while (cursor);
      assert.equal(rows.length, 107);
      assert.equal(new Set(rows.map((r) => r.id)).size, 107);
      assert.equal((await api('/inventory')).data.length, 0);
      assert.deepEqual(await fingerprint(state.tenants), state.before);
      assert.equal(
        (
          await pool.query(
            'SELECT 1 FROM supplier_bulk_runs WHERE tenant_id=ANY($1::uuid[]) AND schedule_version IS NOT NULL',
            [state.tenants],
          )
        ).rowCount,
        0,
      );
      const health = await api('/health');
      assert.equal(health.schema_revision, '032_supplier_schedules');
      const proof = {
        checked_at: new Date().toISOString(),
        scope: 'local_synthetic_automatic_supplier_schedule',
        health,
        old_tenants: state.tenants.length,
        preserved_business_tables: tables.length,
        old_business_rows_unchanged: true,
        source: f.source,
        schedule_version: c.version,
        disabled: true,
        next_at: null,
        runs: runs.map((r: any) => ({
          id: r.id,
          state: r.state,
          schedule_version: r.schedule_version,
          published: r.published,
        })),
        live_worker_dispatched_due_fixture: state.clock_advanced_for_due_fixture === true,
        manual_scheduled_run: true,
        catalog_items: rows.length,
        catalog_pagination_unique: true,
        physical_stock_unchanged: true,
        provider_requests: 0,
        authenticated_provider_confirmed: false,
      };
      await writeFile(
        phase === 'runtime'
          ? 'data/supplier-schedules-stage039-runtime.json'
          : 'docs/supplier-schedules-native-qa.json',
        JSON.stringify(proof, null, 2) + '\n',
      );
      console.log(JSON.stringify(proof));
      await save();
    }
  }
} finally {
  await pool.end();
}
