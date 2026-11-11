// Migration 253_mirakl_webhook_retention (prepared as 263, registered after 252; docs/parity/MIRAKL252-20261028.md):
// retention of the Mirakl webhook event log mirakl262_webhook_events (252). Shape of the SQL: the log stays append-only, also for the
// owner; a row leaves only through the SECURITY DEFINER purge of the caller's tenant, only after 90 days and at most
// 1000 rows per call (the rodo228/ksef243 pattern). No table, no change of another object, dyna_app gets no DELETE.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { RELEASE_MIGRATIONS } from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/migration-manifest.mjs';

const file = new URL('../server/253_mirakl_webhook_retention.sql', import.meta.url);
const sql = readFileSync(file, 'utf8');
const code = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');

test('253 adds only the guard, the purge, one index and the triggers on the 252 event log', () => {
  assert.match(sql, /^-- Migration 253_mirakl_webhook_retention \(prepared as 263, registered after 252_mirakl_operations; object names keep the\n-- mirakl263_ prefix; docs\/parity\/MIRAKL252-20261028\.md\):\n/);
  assert.doesNotMatch(sql, /PREPARED|placeholder|INTEGRATION\.md/);
  assert.doesNotMatch(code, /CREATE TABLE|ALTER TABLE|DROP |REFERENCES|CREATE (?:OR REPLACE )?VIEW|CREATE POLICY/i);
  assert.deepEqual([...code.matchAll(/CREATE FUNCTION public\.(\w+)\(/g)].map((m) => m[1]),
    ['mirakl263_webhook_events_guard', 'mirakl263_purge_webhook_events']);
  assert.deepEqual([...code.matchAll(/CREATE TRIGGER (\w+) BEFORE ([A-Z ]+) ON public\.(\w+) FOR EACH (ROW|STATEMENT)/g)].map((m) => [m[1], m[2], m[3], m[4]]), [
    ['mirakl263_webhook_events_append_only', 'UPDATE OR DELETE', 'mirakl262_webhook_events', 'ROW'],
    ['mirakl263_webhook_events_no_truncate', 'TRUNCATE', 'mirakl262_webhook_events', 'STATEMENT'],
  ]);
  assert.deepEqual([...code.matchAll(/CREATE INDEX (\w+) ON public\.(\w+)\(([^)]*)\)/g)].map((m) => [m[1], m[2], m[3]]),
    [['mirakl263_webhook_events_received', 'mirakl262_webhook_events', 'received_at']]);
  for (const m of code.matchAll(/^(?:UPDATE|INSERT INTO|DELETE FROM|TRUNCATE)\s+(?:public\.)?(\w+)/gm))
    assert.equal(m[1], 'mirakl262_webhook_events', 'statement on a foreign object: ' + m[0]);
});

test('253: one retention rule in the guard and the purge, bounded, tenant-scoped, executable by dyna_app only', () => {
  assert.equal([...code.matchAll(/interval '90 days'/g)].length, 2, 'guard and purge use the same 90 days');
  assert.match(code, /IF t IS NULL THEN RAISE EXCEPTION 'Tenant scope required' USING ERRCODE='42501'/);
  assert.match(code, /WHERE e\.tenant_id=t AND e\.received_at<clock_timestamp\(\)-interval '90 days' ORDER BY e\.received_at LIMIT 1000/);
  assert.match(code, /LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS \$purge263\$/);
  assert.match(code, /RAISE EXCEPTION 'Dziennik powiadomień Mirakl jest nienaruszalny' USING ERRCODE='55000'/);
  assert.match(code, /REVOKE ALL ON FUNCTION public\.mirakl263_webhook_events_guard\(\) FROM PUBLIC,dyna_app;/);
  assert.match(code, /REVOKE ALL ON FUNCTION public\.mirakl263_purge_webhook_events\(\) FROM PUBLIC;\nGRANT EXECUTE ON FUNCTION public\.mirakl263_purge_webhook_events\(\) TO dyna_app;/);
  assert.doesNotMatch(code, /GRANT[^;]*(DELETE|TRUNCATE|UPDATE)/);
});

test('253 follows 252 in the release list and pins the exact SQL bytes', () => {
  const i = RELEASE_MIGRATIONS.findIndex((m) => m.number === 253), row = RELEASE_MIGRATIONS[i];
  const b = readFileSync(file);
  assert(row, 'manifest row 253');
  assert.equal(row.name, '253_mirakl_webhook_retention');
  assert.equal(row.file, '253_mirakl_webhook_retention.sql');
  assert.equal(row.native_id, 'mirakl_webhook_retention253');
  assert.equal(row.cold.contract, 'mirakl-webhook-retention253');
  assert.equal(row.cold.project, 'projectCompiledMiraklWebhookRetention253Catalogue');
  assert.equal(row.bytes, b.length);
  assert.equal(row.sha256, createHash('sha256').update(b).digest('hex'));
  assert.equal(row.bytes, 3138);
  assert.equal(row.sha256, '10b8eed286cf7141def6ca80d2903f89446536e6dce4d64e800e9741f405ca03');
  assert.equal(RELEASE_MIGRATIONS[i - 1].name, '252_mirakl_operations');
  assert.equal(RELEASE_MIGRATIONS[i + 1]?.name, '254_carrier_returns', '254 follows 253');
  assert.doesNotMatch(readFileSync(new URL('../server/db.ts', import.meta.url), 'utf8'), /mirakl_webhook_retention/, 'db.ts takes 253 from the manifest, not a literal pair');
});
