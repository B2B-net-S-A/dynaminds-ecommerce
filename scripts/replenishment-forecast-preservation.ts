/** Read-only119 gate; original accepted checkpoints must never be rebased. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pool } from '../server/db';
import { verifyStocktakeScansPreservation } from './stocktake-scans-preservation';
const phase = process.argv[2];
assert(['before', 'after'].includes(phase));
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
try {
  const prior = await verifyStocktakeScansPreservation({
    catalogExportProfiles: true,
    catalogExportSources: true,
    catalogFileImports: true,
    replenishmentPlans: true,
    replenishmentForecast: phase === 'after',
  });
  const c = await pool.connect();
  const checkpoints = [];
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await c.query("SET LOCAL TIME ZONE 'UTC'");
    const schema = (await c.query('SELECT name FROM migrations ORDER BY name DESC LIMIT 1')).rows[0]
      .name;
    assert.equal(
      schema,
      phase === 'before' ? '099_replenishment_plans' : '100_replenishment_forecast',
    );
    for (const file of [
      'data/catalog-export-sources-stage116.json',
      'data/catalog-file-import-stage117.json',
      'data/replenishment-stage118.json',
      'data/replenishment-ack-stage118.json',
    ]) {
      const raw = await readFile(file, 'utf8'),
        s = JSON.parse(raw);
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
        assert.deepEqual(
          { count: rows.length, sha256: hash(rows) },
          value,
          'Changed: ' + file + ':' + name,
        );
      }
      checkpoints.push({
        stage: s.stage,
        tables: Object.keys(expected).length,
        exact: true,
        checkpoint_sha256: hash(expected),
        private_state_sha256: createHash('sha256').update(raw).digest('hex'),
      });
    }
    await c.query('COMMIT');
    const report = {
      status: 'PASS',
      phase,
      schema_revision: schema,
      prior,
      checkpoints,
      baseline_rebased: false,
      full_goal_complete: false,
    };
    await writeFile(
      `docs/replenishment-forecast-preservation-${phase}-qa.json`,
      JSON.stringify(report, null, 2) + '\n',
      phase === 'before' ? { flag: 'wx' } : {},
    );
    console.log(JSON.stringify({ status: 'PASS', phase, checkpoints }));
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    c.release();
  }
} finally {
  await pool.end();
}
