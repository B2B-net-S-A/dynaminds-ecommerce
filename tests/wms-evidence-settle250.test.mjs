/** Migration 250_wms_evidence_settle_unlocked (docs/parity/WMS-LOCK250-20261028.md; prepared as placeholder 257,
 * registered after 249): the 235 wms_evidence_usage_settle() without row locks on settled rows of other transactions,
 * which the shared WMS operations fence (server/wms-lots-transaction.ts) needs, or two open writers deadlock (40P01).
 * Replaces that one body and nothing else. The manifest row pins the exact bytes after 249. No database; the behaviour
 * is pinned by tests/wms-operations-concurrency250.test.ts. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { RELEASE_MIGRATIONS } from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/migration-manifest.mjs';

const file = new URL('../server/250_wms_evidence_settle_unlocked.sql', import.meta.url);
const code = () => readFileSync(file, 'utf8').replace(/--.*$/gm, '');

test('250 follows 249 in the release list and pins the exact SQL bytes', () => {
  assert(existsSync(file), 'server/250_wms_evidence_settle_unlocked.sql exists');
  const i = RELEASE_MIGRATIONS.findIndex((m) => m.number === 250), row = RELEASE_MIGRATIONS[i], b = readFileSync(file);
  assert(row, 'manifest row 250');
  assert.equal(row.name, '250_wms_evidence_settle_unlocked');
  assert.equal(row.file, '250_wms_evidence_settle_unlocked.sql');
  assert.equal(row.native_id, 'wms_evidence_settle250');
  assert.equal(row.cold.contract, 'wms-evidence-settle250');
  assert.equal(row.cold.project, 'projectCompiledWmsEvidenceSettle250Catalogue');
  assert.equal(row.bytes, b.length);
  assert.equal(row.sha256, createHash('sha256').update(b).digest('hex'));
  assert.equal(row.bytes, 3035);
  assert.equal(row.sha256, 'd796ac513d89ee2412c89451ceac1451c39f2e52ca47953a761a79f604d41ed5');
  assert.equal(RELEASE_MIGRATIONS[i - 1].name, '249_catalog_ai');
  assert.equal(RELEASE_MIGRATIONS[i + 1]?.name, '251_b2b_network_lifecycle', '251 follows 250');
});

test('only the body of wms_evidence_usage_settle() is replaced: same signature and headers, no other object, no grant', () => {
  const s = code();
  assert.deepEqual([...s.matchAll(/\b(CREATE|ALTER|DROP|GRANT|REVOKE|COMMENT)\b[^;(]*/gi)].map((m) => m[0].replace(/\s+/g, ' ').trim()),
    ['CREATE OR REPLACE FUNCTION wms_evidence_usage_settle'], 'one statement, the replaced function');
  assert.match(s, /CREATE OR REPLACE FUNCTION wms_evidence_usage_settle\(\) RETURNS void\s+LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS \$\$/);
  assert.doesNotMatch(s, /\bFOR\s+(?:UPDATE|SHARE|NO KEY UPDATE|KEY SHARE)\b/i, 'no row lock');
  assert.doesNotMatch(s, /pg_advisory/i, 'no advisory lock');
  // A row is updated only while it still holds the values read; a concurrent insert of the same row is not counted twice.
  assert.match(s, /UPDATE wms_evidence_settled SET layers=r\.layers,bytes=r\.b\s+WHERE \(tenant_id,operation_id\)=\(t,r\.id\) AND \(layers,bytes\)=\(old\.layers,old\.bytes\);\s+IF FOUND THEN/);
  assert.match(s, /INSERT INTO wms_evidence_settled VALUES\(t,r\.id,r\.layers,r\.b\) ON CONFLICT DO NOTHING;\s+IF FOUND THEN/);
  assert.match(s, /PERFORM wms_evidence_usage_add\(t,dops,dlay,0,db\);/);
});
