import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { migrate, pool } from '../server/db';

assert.equal(process.env.DYNA_TEST, 'true');
const database = new URL(process.env.DATABASE_URL ?? '');
assert(['localhost', '127.0.0.1', '[::1]'].includes(database.hostname));
assert.match(database.pathname, /^\/dynaminds_test_\d+$/);

before(async () => {
  await migrate();
});
after(async () => {
  await pool.end();
});

const cases = [
  {
    column: 'location',
    type: 'text',
    valid: ['A', 'A'.repeat(80), '😀'.repeat(80), 'BIN 01'],
    invalid: ['', 'A'.repeat(81), '😀'.repeat(81), ' A', 'A ', 'A\nB', 'A\tB', 'A\u007fB'],
  },
  {
    column: 'code',
    type: 'text',
    valid: ['0', '001130000007', 'A'.repeat(80), '😀'.repeat(80), 'SKU 01'],
    invalid: ['', 'A'.repeat(81), '😀'.repeat(81), ' A', 'A ', 'A\nB', 'A\tB', 'A\u007fB'],
  },
  {
    column: 'matched_by',
    type: 'jsonb',
    valid: [
      '["ean"]',
      '["ean","current_sku"]',
      '["ean","current_sku","historical_sku"]',
      '["ean","current_sku","historical_sku","frozen_sku"]',
    ],
    invalid: ['[]', '["a","b","c","d","e"]', '{}', '"ean"', 'null'],
  },
] as const;

for (const fixture of cases) {
  test(`095 ${fixture.column} CHECK restores byte-exact and preserves NOT NULL and validation bounds`, async () => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const metadata = (
        await c.query(
          `SELECT pg_get_constraintdef(k.oid) definition, a.attnotnull
           FROM pg_constraint k JOIN pg_attribute a ON a.attrelid=k.conrelid AND a.attname=$2
           WHERE k.conrelid='public.stocktake_scan_receipts'::regclass AND k.conname=$1`,
          ['stocktake_scan_receipts_' + fixture.column + '_check', fixture.column],
        )
      ).rows;
      assert.equal(metadata.length, 1);
      assert.equal(metadata[0].attnotnull, true, 'Recovery must preserve rejection of SQL NULL');
      const definition: string = metadata[0].definition;
      assert.equal(typeof definition, 'string');
      if (fixture.column === 'matched_by') {
        // This 094 CHECK was already stable; 095 must preserve it unchanged.
        await c.query(`CREATE TEMP TABLE original094_matched_by(matched_by jsonb NOT NULL
          CHECK(jsonb_typeof(matched_by)='array' AND jsonb_array_length(matched_by) BETWEEN 1 AND 4)) ON COMMIT DROP`);
        const original = (
          await c.query(`SELECT pg_get_constraintdef(oid) definition FROM pg_constraint
            WHERE conrelid='pg_temp.original094_matched_by'::regclass AND contype='c'`)
        ).rows[0].definition;
        assert.equal(definition, original, '095 must not change the already stable 094 matched_by CHECK');
      }
      const table = 'stocktake_scan_roundtrip_' + fixture.column;
      // Identifiers/types are fixed test literals; CHECK text is trusted PostgreSQL metadata.
      await c.query(
        `CREATE TEMP TABLE ${table}(${fixture.column} ${fixture.type} NOT NULL) ON COMMIT DROP`,
      );
      await c.query(`ALTER TABLE ${table} ADD CONSTRAINT roundtrip_check ` + definition);
      const reparsed = (
        await c.query(
          `SELECT pg_get_constraintdef(oid) definition FROM pg_constraint
           WHERE conrelid=$1::regclass AND conname='roundtrip_check'`,
          ['pg_temp.' + table],
        )
      ).rows[0].definition;
      assert.equal(
        reparsed,
        definition,
        'pg_dump CHECK restore must not change the schema fingerprint',
      );
      for (const value of fixture.valid)
        await c.query(`INSERT INTO ${table}(${fixture.column}) VALUES($1)`, [value]);
      for (const value of [...fixture.invalid, null]) {
        await c.query('SAVEPOINT rejected_value');
        await assert.rejects(
          c.query(`INSERT INTO ${table}(${fixture.column}) VALUES($1)`, [value]),
          (error: any) =>
            value === null
              ? error.code === '23502'
              : error.code === '23514' || (fixture.type === 'jsonb' && error.code === '22023'),
        );
        await c.query('ROLLBACK TO SAVEPOINT rejected_value');
        await c.query('RELEASE SAVEPOINT rejected_value');
      }
      assert.equal(
        (await c.query(`SELECT count(*)::integer n FROM ${table}`)).rows[0].n,
        fixture.valid.length,
      );
    } finally {
      try {
        await c.query('ROLLBACK');
      } finally {
        c.release();
      }
    }
  });
}

test('all nineteen scan receipt CHECKs retain exact definitions after text restore', async () => {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const checks = (
      await c.query(`SELECT conname,pg_get_constraintdef(oid) definition FROM pg_constraint
        WHERE conrelid='public.stocktake_scan_receipts'::regclass AND contype='c' ORDER BY conname`)
    ).rows as { conname: string; definition: string }[];
    assert.equal(checks.length, 19, 'The full receipt CHECK inventory must remain covered');
    await c.query('CREATE TEMP TABLE all_scan_checks_roundtrip (LIKE public.stocktake_scan_receipts) ON COMMIT DROP');
    for (const check of checks) {
      // Constraint names and definitions are trusted database metadata, never user input.
      const name = '"' + check.conname.replaceAll('"', '""') + '"';
      await c.query('ALTER TABLE all_scan_checks_roundtrip ADD CONSTRAINT ' + name + ' ' + check.definition);
    }
    const restored = (
      await c.query(`SELECT conname,pg_get_constraintdef(oid) definition FROM pg_constraint
        WHERE conrelid='pg_temp.all_scan_checks_roundtrip'::regclass AND contype='c' ORDER BY conname`)
    ).rows;
    assert.deepEqual(restored, checks, 'All CHECK definitions must survive the exact pg_dump text roundtrip');
  } finally {
    try {
      await c.query('ROLLBACK');
    } finally {
      c.release();
    }
  }
});
