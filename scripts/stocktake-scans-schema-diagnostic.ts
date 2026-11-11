/**
 * Root-only diagnostic: reparse every094 CHECK on an empty TEMP clone.
 * No public DDL, data writes, acceptance normalization or baseline replacement.
 * The owner runs this against the actual source database; the entire TX rolls back.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { pool } from '../server/db';

type Check = { name: string; definition: string };
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const label = process.argv[2] ?? 'initial';
let active = false;
const c = await pool.connect();
try {
  assert(/^[a-z0-9-]{1,80}$/.test(label), 'Safe diagnostic label required');
  await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
  active = true;
  await c.query("SET LOCAL statement_timeout='8s'");
  await c.query("SET LOCAL TIME ZONE 'UTC'");
  const checks = (
    await c.query<Check>(
      `SELECT conname AS name,pg_get_constraintdef(oid) AS definition
     FROM pg_constraint WHERE conrelid='public.stocktake_scan_receipts'::regclass
       AND contype='c' ORDER BY conname`,
    )
  ).rows;
  assert(checks.length > 0, 'Actual094 table CHECKs required');
  await c.query(`CREATE TEMP TABLE stocktake_scans_check_roundtrip
    (LIKE public.stocktake_scan_receipts INCLUDING GENERATED) ON COMMIT DROP`);
  const results: {
    name: string;
    exact: boolean;
    source: string;
    reparsed: string;
    source_sha256: string;
    reparsed_sha256: string;
  }[] = [];
  for (const check of checks) {
    // pg_get_constraintdef supplies PostgreSQL's own complete CHECK syntax.
    // Reparse exactly what pg_dump writes, rather than rewriting its expression.
    await c.query(
      'ALTER TABLE pg_temp.stocktake_scans_check_roundtrip ADD CONSTRAINT diagnostic_check ' +
        check.definition,
    );
    const reparsed = (
      await c.query<{ definition: string }>(
        `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
       WHERE conrelid='pg_temp.stocktake_scans_check_roundtrip'::regclass
         AND conname='diagnostic_check'`,
      )
    ).rows;
    assert.equal(reparsed.length, 1);
    results.push({
      name: check.name,
      exact: check.definition === reparsed[0].definition,
      source: check.definition,
      reparsed: reparsed[0].definition,
      source_sha256: sha(check.definition),
      reparsed_sha256: sha(reparsed[0].definition),
    });
    await c.query(
      'ALTER TABLE pg_temp.stocktake_scans_check_roundtrip DROP CONSTRAINT diagnostic_check',
    );
  }
  const schema = (
    await c.query<{ name: string }>('SELECT name FROM migrations ORDER BY name DESC LIMIT 1')
  ).rows[0]?.name;
  await c.query('ROLLBACK');
  active = false;
  const mismatches = results.filter((r) => !r.exact);
  const report = {
    stage: 113,
    schema,
    status: mismatches.length
      ? 'CHECK_DEPARSE_ROUNDTRIP_MISMATCH'
      : 'CHECK_DEPARSE_ROUNDTRIP_EXACT',
    compared_checks: results.length,
    mismatched_checks: mismatches.map((r) => r.name),
    public_mutations: 0,
    source_transaction_rolled_back: true,
    fingerprint_weakened: false,
    limitation:
      'Tests CHECK deparse/reparse only; full backup/restore schema, RLS, ACL and row acceptance remains separate.',
    checks: results,
  };
  await writeFile(
    `docs/stocktake-scans-schema-diagnostic-${label}.json`,
    JSON.stringify(report, null, 2) + '\n',
    { flag: 'wx' },
  );
  console.log({
    status: report.status,
    compared_checks: results.length,
    mismatched_checks: report.mismatched_checks,
    source_transaction_rolled_back: true,
  });
} catch (error) {
  console.error({
    status: 'DIAGNOSTIC_FAILED',
    error_type: error instanceof Error ? error.name : 'Error',
  });
  process.exitCode = 1;
} finally {
  if (active) await c.query('ROLLBACK').catch(() => {});
  c.release();
  await pool.end();
}
