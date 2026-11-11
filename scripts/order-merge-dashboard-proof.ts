/** SELECT/GET-only acceptance on the existing QA122 firm. Never rewrite its checkpoints. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { pool } from '../server/db';

const phase = process.argv[2];
assert(phase === 'before' || phase === 'after');
const revision = process.env.QA_EXPECTED_REVISION;
assert(revision && /^[a-f0-9]{7,40}$/.test(revision));
const file = 'data/order-merges-stage122.json';
const stat = await lstat(file);
assert(stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0);
const bytes = await readFile(file);
const saved = JSON.parse(bytes.toString('utf8'));
assert(saved.fulfilment_verified && saved.fulfilment_checkpoint && saved.cookie);
assert.equal(saved.tenant, 'db39585d-844e-4876-8a58-2ee877fcecd7');
const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const bytesSha = (value: Buffer) => createHash('sha256').update(value).digest('hex');

async function exactCheckpoint() {
  const c = await pool.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await c.query("SET LOCAL TIME ZONE 'UTC'");
    assert.equal(
      (await c.query("SELECT current_setting('transaction_read_only') v")).rows[0].v,
      'on',
    );
    assert.equal(
      (await c.query('SELECT name FROM migrations ORDER BY name DESC LIMIT 1')).rows[0].name,
      '105_order_merge_guards',
    );
    const names = (
      await c.query(`SELECT t.table_name FROM information_schema.tables t
      JOIN information_schema.columns k USING(table_schema,table_name)
      WHERE t.table_schema='public' AND t.table_type='BASE TABLE' AND k.column_name='tenant_id'
      AND t.table_name<>'sessions' ORDER BY t.table_name`)
    ).rows.map((r) => r.table_name as string);
    const current: Record<string, { count: number; sha256: string }> = {};
    for (const name of names) {
      assert(/^[a-z_][a-z0-9_]*$/.test(name));
      const rows = (
        await c.query(`SELECT to_jsonb(t) row FROM "${name}" t WHERE tenant_id=$1 ORDER BY 1`, [
          saved.tenant,
        ])
      ).rows.map((r) => r.row);
      current[name] = { count: rows.length, sha256: sha(rows) };
    }
    for (const name of ['tenants', 'users']) {
      const rows = (
        await c.query(`SELECT to_jsonb(t) row FROM ${name} t WHERE id=$1 ORDER BY 1`, [
          name === 'users' ? saved.user : saved.tenant,
        ])
      ).rows;
      current[name] = { count: rows.length, sha256: sha(rows) };
    }
    assert.equal(Object.keys(current).length, 275);
    assert.deepEqual(
      current,
      saved.fulfilment_checkpoint,
      'Original fulfilment checkpoint remains exact',
    );
    assert.equal(sha(current), '95bc714f1683a52a1162554024b3d7e573e93baac1ac0962bb0fe47ed59252ce');
    await c.query('COMMIT');
    return sha(current);
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}
async function get(path: string) {
  const response = await fetch('http://127.0.0.1:4100/api' + path, {
    signal: AbortSignal.timeout(15000),
    headers: { cookie: saved.cookie, 'X-Workspace-ID': saved.tenant },
  });
  assert.equal(response.status, 200, path + ': HTTP' + response.status);
  return response.json();
}
try {
  if (phase === 'after') {
    const baseline = JSON.parse(
      await readFile('docs/order-merge-dashboard-before-qa.json', 'utf8'),
    );
    assert.equal(baseline.status, 'PASS');
    assert.equal(baseline.phase, 'before');
    assert.equal(
      baseline.private_fixture_sha256,
      bytesSha(bytes),
      'Original private fixture unchanged across product restart',
    );
    assert.equal(baseline.original_business_checkpoint_sha256, sha(saved.fulfilment_checkpoint));
  }
  const before = await exactCheckpoint();
  const health = await get('/health');
  assert.equal(health.revision, revision);
  assert.equal(health.schema_revision, '105_order_merge_guards');
  assert.equal(health.restore_preview, false);
  const me = (await get('/auth/me')).user;
  assert.equal(me.id, saved.user);
  assert.equal(me.tenant_id, saved.tenant);
  const dashboard = await get('/dashboard');
  const list = await get('/orders?limit=100');
  const activeIds = [
    'd519f305-00b4-41bf-83a9-26dc9303d6ce',
    'e965fbe8-22c0-4fef-8d40-8a22d75b85cd',
  ].sort();
  assert.deepEqual(list.data.map((r: any) => r.id).sort(), activeIds);
  assert.equal(dashboard.currency, 'PLN');
  assert.equal(Number(dashboard.stock.on_hand), 39);
  assert.equal(Number(dashboard.stock.reserved), 3);
  const count = dashboard.orders.reduce((n: number, r: any) => n + r.count, 0);
  const gross = dashboard.sources.reduce((n: number, r: any) => n + Number(r.total), 0);
  const valueAfterReturns = dashboard.orders
    .filter((r: any) => !['cancelled', 'new'].includes(r.status))
    .reduce((n: number, r: any) => n + Number(r.total) - Number(r.refund_total), 0);
  const ready = dashboard.orders
    .filter((r: any) => ['paid', 'picking', 'packed'].includes(r.status))
    .reduce((n: number, r: any) => n + r.count, 0);
  assert.equal(count, phase === 'before' ? 5 : 2);
  assert.equal(gross, phase === 'before' ? 11700 : 6800);
  assert.equal(valueAfterReturns, phase === 'before' ? 4300 : 1300);
  assert.equal(ready, phase === 'before' ? 2 : 0);
  if (phase === 'after') {
    assert.deepEqual(dashboard.recent.map((r: any) => r.id).sort(), activeIds);
    assert.deepEqual(
      dashboard.sources.map((r: any) => ({
        source: r.source,
        currency: r.currency,
        count: r.count,
        total: Number(r.total),
      })),
      [
        { source: 'manual', currency: 'PLN', count: 1, total: 3800 },
        { source: 'order_merge', currency: 'PLN', count: 1, total: 3000 },
      ],
    );
  }
  const after = await exactCheckpoint();
  assert.equal(before, after);
  assert.deepEqual(await readFile(file), bytes, 'Original private fixture is never rewritten');
  const report = {
    status: 'PASS',
    phase,
    observed_at: new Date().toISOString(),
    runtime_revision: revision,
    schema_revision: health.schema_revision,
    tenant_id: saved.tenant,
    private_fixture_sha256: bytesSha(bytes),
    original_business_checkpoint_sha256: after,
    exact_business_tables: 275,
    get_only: true,
    no_checkpoint_rebase: true,
    operational_list_order_ids: activeIds,
    dashboard_order_count: count,
    gross_before_returns_minor: gross,
    value_after_returns_excluding_new_cancelled_minor: valueAfterReturns,
    ready_count: ready,
    stock: { on_hand: 39, reserved: 3 },
    sources: dashboard.sources.map((r: any) => ({
      source: r.source,
      currency: r.currency,
      count: r.count,
      total_minor: Number(r.total),
    })),
    recent_order_ids: dashboard.recent.map((r: any) => r.id),
    provider_operations: false,
    docker_used: false,
  };
  const output = `docs/order-merge-dashboard-${phase}-qa.json`;
  await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(
    JSON.stringify({
      status: report.status,
      phase,
      output,
      revision,
      count,
      valueAfterReturns,
      exact_business_tables: 275,
    }),
  );
} finally {
  await pool.end();
}
