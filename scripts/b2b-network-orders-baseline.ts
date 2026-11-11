import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pool } from '../server/db';
const path = 'data/b2b-network-orders-stage050.json',
  phase = process.argv[2];
let state: any;
const save = () => writeFile(path, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
async function fingerprint(table: string, columns: string[], tenants: string[]) {
  assert(/^[a-z_][a-z_0-9]*$/.test(table) && columns.every((c) => /^[a-z_][a-z_0-9]*$/.test(c)));
  const rows = (
    await pool.query(
      'SELECT to_jsonb(t)::text row FROM (SELECT ' +
        columns.join(',') +
        ' FROM ' +
        table +
        ' WHERE tenant_id=ANY($1::uuid[])) t ORDER BY 1',
      [tenants],
    )
  ).rows;
  return {
    count: rows.length,
    sha256: createHash('sha256').update(JSON.stringify(rows)).digest('hex'),
  };
}
try {
  if (phase === 'baseline') {
    await assert.rejects(readFile(path), 'Do not replace an existing baseline');
    const tenants = (await pool.query('SELECT id FROM tenants ORDER BY id')).rows.map((r) => r.id);
    const columns = (
      await pool.query(
        "SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name,ordinal_position",
      )
    ).rows;
    const all: Record<string, string[]> = {};
    for (const c of columns) (all[c.table_name] ??= []).push(c.column_name);
    const before: Record<string, any> = {};
    const excluded = [
      'sessions',
      'b2b_sessions',
      'jobs',
      'job_attempts',
      'webhook_deliveries',
      'order_status_configs',
    ];
    for (const [table, cols] of Object.entries(all))
      if (cols.includes('tenant_id') && !excluded.includes(table))
        before[table] = { columns: cols, ...(await fingerprint(table, cols, tenants)) };
    state = { tenants, before, excluded };
    await save();
    console.log({ previous_tenants: tenants.length, tables: Object.keys(before).length });
  }
} finally {
  await pool.end();
}
