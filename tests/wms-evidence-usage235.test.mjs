/** Migration 235_wms_evidence_usage (docs/parity/WMS-LIMITS-20261026.md): registered as the next release
 * migration, the same text as the doc's SQL block, and shaped so the guard fingerprints stay intact. No database. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { RELEASE_MIGRATIONS } from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/migration-manifest.mjs';

const file = new URL('../server/235_wms_evidence_usage.sql', import.meta.url);
const fingerprinted = ['wms_operations', 'wms_cost_layers', 'wms_layer_movements', 'wms_issue_fragments', 'wms_return_fragments'];
const tracked = ['wms_previews', 'wms_lots', 'wms_stocktakes', 'wms_stocktake_lines', 'wms_stocktake_scope_layers',
  'wms_stocktake_measurements', 'wms_stocktake_measurement_layers', 'wms_stocktake_reviews', 'wms_stocktake_review_rows',
  'wms_stocktake_postings'];
const sql = () => readFileSync(file, 'utf8');
const code = () => sql().replace(/--.*$/gm, '');

test('235 follows 234 in the release list and pins the exact SQL bytes', () => {
  assert(existsSync(file), 'server/235_wms_evidence_usage.sql exists');
  const i = RELEASE_MIGRATIONS.findIndex((m) => m.number === 235), row = RELEASE_MIGRATIONS[i], b = readFileSync(file);
  assert.equal(row.number, 235);
  assert.equal(row.name, '235_wms_evidence_usage');
  assert.equal(row.file, '235_wms_evidence_usage.sql');
  assert.equal(row.bytes, b.length);
  assert.equal(row.sha256, createHash('sha256').update(b).digest('hex'));
  assert.equal(RELEASE_MIGRATIONS[i - 1].name, '234_carriers');
});

test('the doc SQL block is the migration text (the DB test reads the doc)', () => {
  const doc = readFileSync(new URL('../docs/parity/WMS-LIMITS-20261026.md', import.meta.url), 'utf8');
  const m = /```sql wms-evidence-usage235\n([\s\S]*?)```/.exec(doc);
  assert(m, 'doc carries the 235 SQL block');
  assert.equal(m[1], sql());
});

test('no trigger, column or ALTER on the five fingerprinted tables; triggers only on the ten tracked ones', () => {
  const s = code();
  for (const t of fingerprinted) {
    assert.doesNotMatch(s, new RegExp(`ALTER\\s+TABLE\\s+(?:public\\.)?${t}\\b`, 'i'), t);
    assert.doesNotMatch(s, new RegExp(`TRIGGER[\\s\\S]{0,120}?\\bON\\s+(?:public\\.)?${t}\\b`, 'i'), t);
  }
  const loop = /FOREACH t IN ARRAY ARRAY\[([\s\S]*?)\] LOOP/.exec(s);
  assert(loop, 'trigger loop');
  assert.deepEqual([...loop[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]), tracked);
  assert.equal((s.match(/CREATE TRIGGER/g) ?? []).length, 2, 'only the two templated CREATE TRIGGER statements');
});

test('backfill runs after a SHARE lock on the five settled tables, inside the migration', () => {
  const s = code(), lock = s.indexOf('LOCK TABLE '), settled = s.indexOf('INSERT INTO wms_evidence_settled(');
  assert(lock > 0 && settled > lock, 'LOCK before the backfill');
  const locked = /LOCK TABLE ([a-z_,]+) IN SHARE MODE;/.exec(s);
  assert(locked);
  assert.deepEqual(locked[1].split(','), fingerprinted);
  assert.doesNotMatch(s, /\b(?:BEGIN|COMMIT)\s*;/i, 'migrate() owns the transaction');
});

test('the app role reads the counters and can only call the settle function', () => {
  const s = code();
  assert.match(s, /GRANT SELECT ON wms_evidence_usage,wms_evidence_settled TO dyna_app;/);
  assert.doesNotMatch(s, /GRANT\s+(?:INSERT|UPDATE|DELETE|ALL)[^;]*TO dyna_app/i);
  assert.deepEqual([...s.matchAll(/GRANT EXECUTE ON FUNCTION (\w+)/g)].map((x) => x[1]), ['wms_evidence_usage_settle']);
  for (const f of ['wms_evidence_usage_add', 'wms_evidence_usage_track', 'wms_evidence_usage_track_update', 'wms_evidence_usage_settle'])
    assert.match(s, new RegExp(`REVOKE ALL ON FUNCTION ${f}\\(`), f);
  assert.equal((s.match(/SECURITY DEFINER SET search_path=pg_catalog,public/g) ?? []).length, 4);
  // The TS reader switches to the counter on exactly these names.
  const ts = readFileSync(new URL('../server/wms-lots-limits.ts', import.meta.url), 'utf8');
  assert.match(ts, /to_regclass\('public\.wms_evidence_usage'\)/);
  assert.match(ts, /SELECT wms_evidence_usage_settle\(\)/);
});

test('an INSERT trigger function never names the OLD transition table (it does not exist there)', () => {
  const s = code(), body = (f) => {
    const m = new RegExp(`CREATE FUNCTION ${f}\\(\\) RETURNS trigger[\\s\\S]*?AS \\$\\$([\\s\\S]*?)END \\$\\$;`).exec(s);
    assert(m, f);
    return m[1];
  };
  assert.match(s, /AFTER INSERT ON %I REFERENCING NEW TABLE AS wms_evidence_new FOR EACH STATEMENT EXECUTE FUNCTION wms_evidence_usage_track\(\)/);
  assert.match(s, /AFTER UPDATE ON %I REFERENCING OLD TABLE AS wms_evidence_old NEW TABLE AS wms_evidence_new FOR EACH STATEMENT EXECUTE FUNCTION wms_evidence_usage_track_update\(\)/);
  assert.doesNotMatch(body('wms_evidence_usage_track'), /wms_evidence_old/);
  assert.match(body('wms_evidence_usage_track_update'), /wms_evidence_old/);
});
