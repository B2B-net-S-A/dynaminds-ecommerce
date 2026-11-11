// Migration 252_mirakl_operations (L4 Mirakl; prepared as 262, registered after 251; docs/parity/MIRAKL252-20261028.md):
// shape of the SQL and the manifest pin. Own tables only, tenant RLS on each, no foreign key to or change of any core
// table, no DELETE/TRUNCATE for dyna_app, the webhook event log append-only, no secret column.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { RELEASE_MIGRATIONS } from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/migration-manifest.mjs';

const file = new URL('../server/252_mirakl_operations.sql', import.meta.url);
const sql = readFileSync(file, 'utf8');
const code = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
const tables = ['mirakl262_schedules', 'mirakl262_operations', 'mirakl262_webhook_endpoints', 'mirakl262_webhook_events'];

test('252 creates exactly its four own tables and touches nothing else', () => {
  assert.deepEqual([...code.matchAll(/CREATE TABLE (\w+)/g)].map((m) => m[1]), tables);
  for (const m of code.matchAll(/^(?:ALTER|DROP|UPDATE|INSERT INTO|DELETE FROM|TRUNCATE)\s+(?:TABLE\s+)?(\w+)/gm))
    assert(tables.includes(m[1]), 'statement on a foreign object: ' + m[0]);
  assert.doesNotMatch(code, /REFERENCES/i, 'no foreign key: no RI trigger lands on a core table');
  assert.doesNotMatch(code, /CREATE (?:OR REPLACE )?(?:FUNCTION|TRIGGER|VIEW)/i);
});

test('252: tenant RLS policy on every table and no DELETE for the application role', () => {
  for (const t of tables) {
    assert.match(code, new RegExp(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`));
    assert.match(code, new RegExp(`CREATE POLICY tenant_scope ON ${t} USING \\(tenant_id=NULLIF\\(current_setting\\('app\\.tenant_id',true\\),''\\)::uuid\\) WITH CHECK`));
    assert.match(code, new RegExp(`tenant_id uuid NOT NULL`));
  }
  assert.match(code, /REVOKE ALL ON TABLE mirakl262_schedules, mirakl262_operations, mirakl262_webhook_endpoints, mirakl262_webhook_events FROM PUBLIC,dyna_app;/);
  assert.doesNotMatch(code, /GRANT[^;]*(DELETE|TRUNCATE)/);
  assert.match(code, /GRANT SELECT,INSERT ON TABLE mirakl262_webhook_events TO dyna_app;/, 'append-only event log');
});

test('252: idempotency and one open write per target are database constraints; no token or key column', () => {
  assert.match(code, /UNIQUE \(tenant_id, client_key\)/);
  assert.match(code, /CREATE UNIQUE INDEX mirakl262_operations_open ON mirakl262_operations\(tenant_id, channel_id, kind, target\) WHERE state IN \('queued','sending','sent','uncertain'\)/);
  assert.match(code, /UNIQUE \(tenant_id, endpoint_id, event_id\)/);
  assert.match(code, /token_sha256 text NOT NULL CHECK \(token_sha256 ~ '\^\[0-9a-f\]\{64\}\$'\)/);
  assert.doesNotMatch(code, /\b(?:api_key|credentials|token)\s+text/);
  assert.match(sql, /^-- Migration 252_mirakl_operations \(prepared as 262, registered after 251_b2b_network_lifecycle; object names keep the\n-- mirakl262_ prefix; docs\/parity\/MIRAKL252-20261028\.md\):\n/);
  assert.doesNotMatch(sql, /PREPARED|placeholder|INTEGRATION\.md/);
});

test('252 follows 251 in the release list and pins the exact SQL bytes', () => {
  const i = RELEASE_MIGRATIONS.findIndex((m) => m.number === 252), row = RELEASE_MIGRATIONS[i];
  const b = readFileSync(file);
  assert(row, 'manifest row 252');
  assert.equal(row.name, '252_mirakl_operations');
  assert.equal(row.file, '252_mirakl_operations.sql');
  assert.equal(row.native_id, 'mirakl_operations252');
  assert.equal(row.cold.contract, 'mirakl-operations252');
  assert.equal(row.cold.project, 'projectCompiledMiraklOperations252Catalogue');
  assert.equal(row.bytes, b.length);
  assert.equal(row.sha256, createHash('sha256').update(b).digest('hex'));
  assert.equal(row.bytes, 7427);
  assert.equal(row.sha256, '98cbc9ea9ec2d5b6e5e154e2ac33fce485bbbb05a35fcef3438bc52fcd5c639d');
  assert.equal(RELEASE_MIGRATIONS[i - 1].name, '251_b2b_network_lifecycle');
  assert.equal(RELEASE_MIGRATIONS[i + 1]?.name, '253_mirakl_webhook_retention', '253 follows 252');
  assert.doesNotMatch(readFileSync(new URL('../server/db.ts', import.meta.url), 'utf8'), /mirakl_operations/, 'db.ts takes 252 from the manifest, not a literal pair');
});
