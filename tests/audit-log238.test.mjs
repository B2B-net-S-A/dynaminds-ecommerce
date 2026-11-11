/** Migration 238_audit_log (docs/parity/AUDIT-LOG238-20261027.md): registered as the next release migration;
 * one own side table keyed by the audit event id, so the core audit_events is not altered. dyna_app may only
 * read and insert it (the key attribution is append-only for the application role), RLS per tenant. No
 * database; the behaviour is pinned by tests/audit-log238.test.ts. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { RELEASE_MIGRATIONS } from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/migration-manifest.mjs';

const file = new URL('../server/238_audit_log.sql', import.meta.url);
const code = () => readFileSync(file, 'utf8').replace(/--.*$/gm, '');

test('238 follows 237 in the release list and pins the exact SQL bytes', () => {
  assert(existsSync(file), 'server/238_audit_log.sql exists');
  const i = RELEASE_MIGRATIONS.findIndex((m) => m.number === 238), row = RELEASE_MIGRATIONS[i], b = readFileSync(file);
  assert.equal(row.number, 238);
  assert.equal(row.name, '238_audit_log');
  assert.equal(row.file, '238_audit_log.sql');
  assert.equal(row.cold.contract, 'audit-log238');
  assert.equal(row.bytes, b.length);
  assert.equal(row.sha256, createHash('sha256').update(b).digest('hex'));
  assert.equal(RELEASE_MIGRATIONS[i - 1].name, '237_auth_security');
});

test('only the own audit238_event_keys; audit_events and every other core table stay untouched', () => {
  const s = code();
  assert.deepEqual([...s.matchAll(/CREATE\s+(?:TABLE|FUNCTION)\s+([a-z0-9_]+)/g)].map((m) => m[1]), ['audit238_event_keys']);
  // A policy name is per table (tenant_scope like every core table); its table is checked by the ON rule below.
  for (const m of s.matchAll(/(?:CREATE|ALTER|DROP)\s+(?:UNIQUE\s+)?(?:TABLE|INDEX|FUNCTION|TRIGGER|VIEW|TYPE|SEQUENCE)\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?(?:public\.)?([a-z0-9_]+)/gi))
    assert.match(m[1], /^audit238_/, m[0]);
  for (const m of s.matchAll(/\bON\s+(?!CONFLICT\b)(?:TABLE\s+|FUNCTION\s+)?(?:public\.)?([a-z0-9_]+)/gi)) assert.match(m[1], /^audit238_/, m[0]);
  assert.doesNotMatch(s, /\baudit_events\b/, 'the core audit table is neither altered nor referenced');
  assert.doesNotMatch(s, /\bREFERENCES\b/i, 'no foreign key: no RI trigger lands on audit_events or api_keys');
  assert.doesNotMatch(s, /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+[a-z_.]+/i, 'the migration writes no rows');
  assert.doesNotMatch(s, /SECURITY\s+DEFINER|EVENT\s+TRIGGER|CREATE\s+TRIGGER/i);
});

test('dyna_app reads and inserts only, under a tenant policy', () => {
  const s = code();
  assert.match(s, /ALTER TABLE audit238_event_keys ENABLE ROW LEVEL SECURITY;/);
  assert.match(s, /CREATE POLICY tenant_scope ON audit238_event_keys USING \(tenant_id=NULLIF\(current_setting\('app\.tenant_id',true\),''\)::uuid\) WITH CHECK \(tenant_id=NULLIF\(current_setting\('app\.tenant_id',true\),''\)::uuid\);/);
  assert.match(s, /REVOKE ALL ON TABLE audit238_event_keys FROM PUBLIC,dyna_app;/);
  assert.deepEqual([...s.matchAll(/\bGRANT\s+([A-Z, ]+)\s+ON\s+TABLE\s+(\S+)\s+TO\s+(\S+);/g)].map((m) => [m[1].trim(), m[2], m[3]]),
    [['SELECT,INSERT', 'audit238_event_keys', 'dyna_app']], 'no UPDATE, DELETE or TRUNCATE for the application role');
});
