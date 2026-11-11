/** Migration 244_custom_events_checksums (docs/parity/CUSTOM-EVENTS244-20261027.md): registered as the next release
 * migration after 243.
 * AUTO-07: own custom-event definitions and the append-only call history. MIG-2: the owner-only checksum register of
 * applied migration files. Only own objects; no foreign key to and no change of a core table; dyna_app without DELETE,
 * append-only on the call history and no access at all to the checksum register. No database; behaviour is pinned by
 * tests/custom-events244.database.test.ts and tests/migration-checksums244.database.test.ts. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { RELEASE_MIGRATIONS } from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/migration-manifest.mjs';

const file = new URL('../server/244_custom_events_checksums.sql', import.meta.url);
const code = () => readFileSync(file, 'utf8').replace(/--.*$/gm, '');
const TABLES = ['custom_event_defs', 'custom_event_calls', 'migration_checksums'];
const OWN = /^(?:custom_event_|migration_checksums)/;

test('244 follows 243 in the release list and pins the exact SQL bytes', () => {
  assert(existsSync(file), 'server/244_custom_events_checksums.sql exists');
  const i = RELEASE_MIGRATIONS.findIndex((m) => m.number === 244), row = RELEASE_MIGRATIONS[i], b = readFileSync(file);
  assert(row, 'manifest row 244');
  assert.equal(row.name, '244_custom_events_checksums');
  assert.equal(row.file, '244_custom_events_checksums.sql');
  assert.equal(row.native_id, 'custom_events_checksums244');
  assert.equal(row.cold.contract, 'custom-events-checksums244');
  assert.equal(row.bytes, b.length);
  assert.equal(row.sha256, createHash('sha256').update(b).digest('hex'));
  assert.equal(RELEASE_MIGRATIONS[i - 1].name, '243_ksef_purchase');
});

test('the SQL exists and creates exactly the three own tables', () => {
  assert(existsSync(file), 'server/244_custom_events_checksums.sql exists');
  assert.deepEqual([...code().matchAll(/CREATE\s+TABLE\s+([a-z0-9_]+)/g)].map((m) => m[1]), TABLES);
});

test('only own objects; no core table is altered, referenced or written; no sealed family name', () => {
  const s = code();
  for (const m of s.matchAll(/(?:CREATE|ALTER|DROP)\s+(?:UNIQUE\s+)?(?:TABLE|INDEX|FUNCTION|TRIGGER|VIEW|TYPE|SEQUENCE)\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?(?:public\.)?([a-z0-9_]+)/gi))
    assert.match(m[1], OWN, m[0]);
  for (const m of s.matchAll(/\bON\s+(?!CONFLICT\b)(?:TABLE\s+|FUNCTION\s+)?(?:public\.)?([a-z0-9_]+)/gi)) assert.match(m[1], OWN, m[0]);
  // The only foreign key is between the two own custom-event tables (no RI trigger lands on orders or order_events).
  assert.deepEqual([...s.matchAll(/\bREFERENCES\s+([a-z0-9_]+)/gi)].map((m) => m[1]), ['custom_event_defs']);
  assert.doesNotMatch(s, /\b(?:INSERT\s+INTO|UPDATE\s+[a-z_.]+\s+SET|DELETE\s+FROM)\b/i, 'the migration writes no rows');
  assert.doesNotMatch(s, /SECURITY\s+DEFINER|EVENT\s+TRIGGER|CREATE\s+TRIGGER|CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION/i);
  assert.doesNotMatch(s, /\b(?:orders|order_events|automation_rules|automation_runs|jobs|migrations)\b/, 'core tables are not named');
  // Sealed fingerprints match by LIKE prefix with `_` as a wildcard (docs/parity/WZ-ISSUER239-20261027.md).
  for (const m of s.matchAll(/(?:TABLE|INDEX|POLICY)\s+([a-z0-9_]+)/g))
    for (const sealed of ['buyer.address.', 'warehouse.wz.issuer.', 'catalog.stock.', 'return.', 'order.parcel.', 'competitor.observation'])
      assert.doesNotMatch(m[1], new RegExp('^' + sealed), m[1]);
});

test('AUTO-07: keys, sources and the idempotency key are constrained in the tables themselves', () => {
  const s = code();
  assert.match(s, /key text NOT NULL CHECK \(key ~ '\^\[a-z\]\[a-z0-9_\]\{1,39\}\$'\)/);
  assert.match(s, /UNIQUE \(tenant_id, key\)/);
  assert.match(s, /source text NOT NULL CHECK \(source IN \('ui','api','rule','schedule','batch'\)\)/);
  assert.match(s, /client_key text NOT NULL CHECK \(client_key ~ '\^\[A-Za-z0-9\._:-\]\{8,200\}\$'\)/);
  assert.match(s, /UNIQUE \(tenant_id, client_key\)/);
  assert.match(s, /order_event_id uuid NOT NULL UNIQUE/);
  assert.match(s, /FOREIGN KEY \(tenant_id, definition_id\) REFERENCES custom_event_defs\(tenant_id, id\)/);
  assert.match(s, /CHECK \(\(source IN \('rule','schedule','batch'\)\) = \(operation_id IS NOT NULL\)\)/);
  assert.doesNotMatch(s, /\b(?:email|phone|address|customer_name)\b/i, 'no personal data column');
});

test('AUTO-07: dyna_app works under a tenant policy, never deletes, and only appends to the call history', () => {
  const s = code();
  for (const t of ['custom_event_defs', 'custom_event_calls']) {
    assert.match(s, new RegExp(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY;`));
    assert.match(s, new RegExp(`CREATE POLICY tenant_scope ON ${t} USING \\(tenant_id=NULLIF\\(current_setting\\('app\\.tenant_id',true\\),''\\)::uuid\\) WITH CHECK \\(tenant_id=NULLIF\\(current_setting\\('app\\.tenant_id',true\\),''\\)::uuid\\);`));
  }
  assert.match(s, /REVOKE ALL ON TABLE custom_event_defs, custom_event_calls, migration_checksums FROM PUBLIC,dyna_app;/);
  assert.deepEqual([...s.matchAll(/\bGRANT\s+([A-Z, ]+)\s+ON\s+TABLE\s+(\S+)\s+TO\s+(\S+);/g)].map((m) => [m[1].trim(), m[2], m[3]]), [
    ['SELECT,INSERT,UPDATE', 'custom_event_defs', 'dyna_app'],
    ['SELECT,INSERT', 'custom_event_calls', 'dyna_app'],
  ]);
});

test('MIG-2: the checksum register is keyed by migration and file, owner-only, without RLS or grant', () => {
  const s = code();
  assert.match(s, /name text NOT NULL CHECK \(name ~ '\^\[0-9\]\{3\}_\[a-z0-9_\]\+\$'\)/);
  assert.match(s, /file text NOT NULL CHECK \(file ~ '\^\[A-Za-z0-9_-\]\+\\\.sql\$'\)/);
  assert.match(s, /sha256 text NOT NULL CHECK \(sha256 ~ '\^\[0-9a-f\]\{64\}\$'\)/);
  assert.match(s, /origin text NOT NULL CHECK \(origin IN \('applied','baseline'\)\)/);
  assert.match(s, /PRIMARY KEY \(name, file\)/);
  assert.doesNotMatch(s, /migration_checksums ENABLE ROW LEVEL SECURITY|POLICY \w+ ON migration_checksums|GRANT [A-Z, ]+ ON TABLE migration_checksums/);
});
