/** Read-only focused121 gate. Original accepted files are never rewritten. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pool } from '../server/db';
const phase = process.argv[2];
assert(phase === 'before' || phase === 'after');
const sha = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const checkpoints: Record<string, unknown>[] = [];
const c = await pool.connect();
try {
  await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await c.query("SET LOCAL TIME ZONE 'UTC'");
  const schema = (await c.query('SELECT name FROM migrations ORDER BY name DESC LIMIT 1')).rows[0]
    .name;
  assert.equal(
    schema,
    phase === 'before' ? '101_replenishment_append' : '102_replenishment_automations',
  );
  for (const file of [
    'data/catalog-export-sources-stage116.json',
    'data/catalog-file-import-stage117.json',
    'data/replenishment-stage118.json',
    'data/replenishment-ack-stage118.json',
    'data/replenishment-forecast-stage119.json',
    'data/replenishment-append-stage120.json',
  ]) {
    const raw = await readFile(file, 'utf8');
    const s = JSON.parse(raw);
    const expected = file.includes('-ack-') ? s.final_business_checkpoint : s.accepted_checkpoint;
    assert(expected, 'Missing accepted checkpoint: ' + file);
    for (const [name, value] of Object.entries(expected)) {
      assert(/^[a-z][a-z0-9_]*$/.test(name));
      const field = ['tenants', 'users'].includes(name) ? 'id' : 'tenant_id';
      const rows = (
        await c.query(`SELECT to_jsonb(t) row FROM "${name}" t WHERE ${field}=$1 ORDER BY 1`, [
          name === 'users' ? s.user : s.tenant,
        ])
      ).rows;
      assert.deepEqual({ count: rows.length, sha256: sha(rows) }, value, file + ':' + name);
    }
    checkpoints.push({
      stage: s.stage,
      tables: Object.keys(expected).length,
      exact: true,
      checkpoint_sha256: sha(expected),
      private_state_sha256: createHash('sha256').update(raw).digest('hex'),
    });
  }
  if (phase === 'after') {
    assert.equal(
      Number(
        (await c.query('SELECT count(*) FROM replenishment_append_preparations')).rows[0].count,
      ),
      0,
    );
  }
  await c.query('COMMIT');
  const report = {
    status: 'PASS',
    phase,
    schema_revision: schema,
    checkpoints,
    collector_empty: phase === 'after' ? true : null,
    baseline_rebased: false,
    scope: 'Six original accepted own-firm checkpoints, not all historic tenants or all databases',
    full_goal_complete: false,
  };
  await writeFile(
    `docs/replenishment-automations-preservation-${phase}-qa.json`,
    JSON.stringify(report, null, 2) + '\n',
    phase === 'before' ? { flag: 'wx' } : {},
  );
  console.log(JSON.stringify(report));
} finally {
  await c.query('ROLLBACK').catch(() => {});
  c.release();
  await pool.end();
}
