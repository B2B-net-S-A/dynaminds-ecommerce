/** Read-only QA118: original gates and accepted QA116/117 checkpoints. */
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
    replenishmentPlans: phase === 'after',
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
      phase === 'before' ? '098_catalog_file_imports' : '099_replenishment_plans',
    );
    for (const file of [
      'data/catalog-export-sources-stage116.json',
      'data/catalog-file-import-stage117.json',
    ]) {
      const raw = await readFile(file, 'utf8'),
        s = JSON.parse(raw);
      assert(s.accepted_checkpoint, 'Missing earlier accepted checkpoint');
      for (const [name, expected] of Object.entries(s.accepted_checkpoint)) {
        assert(/^[a-z][a-z0-9_]*$/.test(name));
        const field = ['tenants', 'users'].includes(name) ? 'id' : 'tenant_id';
        const rows = (
          await c.query(`SELECT to_jsonb(t) row FROM "${name}" t WHERE ${field}=$1 ORDER BY 1`, [
            name === 'users' ? s.user : s.tenant,
          ])
        ).rows;
        assert.deepEqual(
          { count: rows.length, sha256: hash(rows) },
          expected,
          'Accepted checkpoint changed: ' + file + ':' + name,
        );
      }
      checkpoints.push({
        stage: s.stage,
        tables: Object.keys(s.accepted_checkpoint).length,
        exact: true,
        checkpoint_sha256: hash(s.accepted_checkpoint),
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
      additive_purchase_columns:
        phase === 'after'
          ? 'Two nullable linkage fields are projected only after proving NULL in every earlier PO.'
          : 'not present',
      full_goal_complete: false,
    };
    await writeFile(
      `docs/replenishment-preservation-${phase}-qa.json`,
      JSON.stringify(report, null, 2),
      phase === 'before' ? { flag: 'wx' } : {},
    );
    console.log(
      JSON.stringify({ status: report.status, phase, prior_status: prior.status, checkpoints }),
    );
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    c.release();
  }
} finally {
  await pool.end();
}
