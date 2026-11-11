/** Compare the immutable stage111 baseline; never overwrite or rebase it. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pool } from '../server/db';

const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const label = process.argv[2];
assert(label && /^[a-z0-9-]+$/.test(label), 'Provide an evidence label');
const baseline = JSON.parse(await readFile('data/wms-lots-stage111-baseline.json', 'utf8'));
try {
  const c = await pool.connect();
  const changed: Array<{ table: string; before_count: number; after_count: number }> = [];
  let exact = 0;
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await c.query("SET LOCAL TIME ZONE 'UTC'");
    const firms = (await c.query('SELECT id FROM tenants ORDER BY id')).rows.map((r) => r.id);
    const users = (await c.query('SELECT id FROM users ORDER BY id')).rows.map((r) => r.id);
    const databases = (await c.query('SELECT datname FROM pg_database ORDER BY datname')).rows.map(
      (r) => r.datname,
    );
    assert(
      baseline.firms.every((id: string) => firms.includes(id)),
      'A prior firm is missing',
    );
    assert(
      baseline.users.every((id: string) => users.includes(id)),
      'A prior user is missing',
    );
    assert.deepEqual(
      databases,
      baseline.databases,
      'Prior databases or temporary test cleanup changed',
    );
    for (const name of baseline.names) {
      assert(/^[a-z][a-z0-9_]*$/.test(name));
      const rows = (
        await c.query(`SELECT to_jsonb(t) row FROM "${name}" t
        ${name === 'migrations' ? "WHERE name NOT IN ('090_wms_lots','091_wms_lot_packing')" : ''}
        ORDER BY 1`)
      ).rows;
      if (
        rows.length === baseline.before[name].count &&
        hash(rows) === baseline.before[name].sha256
      )
        exact++;
      else
        changed.push({
          table: name,
          before_count: baseline.before[name].count,
          after_count: rows.length,
        });
    }
    await c.query('COMMIT');
    const report = {
      stage: 111,
      label,
      recorded_at: new Date().toISOString(),
      status: changed.length ? 'RAW_DRIFT_REQUIRES_EXPLANATION' : 'RAW_PRIOR_TABLES_EXACT',
      prior_firms_preserved: baseline.firms.length,
      current_firms: firms.length,
      prior_users_preserved: baseline.users.length,
      current_users: users.length,
      prior_databases_preserved: baseline.databases.length,
      prior_table_count: baseline.names.length,
      exact_prior_tables: exact,
      changed,
      baseline_rebased: false,
      goal_complete: false,
    };
    await writeFile(
      'docs/wms-lots-preservation-' + label + '.json',
      JSON.stringify(report, null, 2) + '\n',
      { flag: 'wx' },
    );
    console.log(report);
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    c.release();
  }
} finally {
  await pool.end();
}
