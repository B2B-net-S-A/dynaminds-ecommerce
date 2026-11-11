/** Migration 242_payu_sessions (docs/parity/PAYU242-20261027.md): registered as the next release migration after
 * 241; only own payu242_ tables, no foreign key to and no change of a core table, the application role without
 * DELETE/TRUNCATE and append-only on the notification log, RLS per tenant. No database; the behaviour is pinned by
 * tests/payu242.test.ts. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { RELEASE_MIGRATIONS } from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/migration-manifest.mjs';

const file = new URL('../server/242_payu_sessions.sql', import.meta.url);
const code = () => readFileSync(file, 'utf8').replace(/--.*$/gm, '');
const TABLES = ['payu242_configs', 'payu242_sessions', 'payu242_notifications', 'payu242_refunds'];

test('242 follows 241 in the release list and pins the exact SQL bytes', () => {
  assert(existsSync(file), 'server/242_payu_sessions.sql exists');
  const i = RELEASE_MIGRATIONS.findIndex((m) => m.number === 242), row = RELEASE_MIGRATIONS[i], b = readFileSync(file);
  assert.equal(row.name, '242_payu_sessions');
  assert.equal(row.file, '242_payu_sessions.sql');
  assert.equal(row.native_id, 'payu_sessions242');
  assert.equal(row.cold.contract, 'payu-sessions242');
  assert.equal(row.bytes, b.length);
  assert.equal(row.sha256, createHash('sha256').update(b).digest('hex'));
  assert.equal(RELEASE_MIGRATIONS[i - 1].name, '241_verdict_gates');
});

test('only own payu242_ objects; no core table is altered, referenced or written', () => {
  const s = code();
  assert.deepEqual([...s.matchAll(/CREATE\s+TABLE\s+([a-z0-9_]+)/g)].map((m) => m[1]), TABLES);
  for (const m of s.matchAll(/(?:CREATE|ALTER|DROP)\s+(?:UNIQUE\s+)?(?:TABLE|INDEX|FUNCTION|TRIGGER|VIEW|TYPE|SEQUENCE)\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?(?:public\.)?([a-z0-9_]+)/gi))
    assert.match(m[1], /^payu242_/, m[0]);
  for (const m of s.matchAll(/\bON\s+(?!CONFLICT\b)(?:TABLE\s+|FUNCTION\s+)?(?:public\.)?([a-z0-9_]+)/gi)) assert.match(m[1], /^payu242_/, m[0]);
  assert.doesNotMatch(s, /\bREFERENCES\b/i, 'no foreign key: no RI trigger lands on orders or payment_entries');
  assert.doesNotMatch(s, /\b(?:INSERT\s+INTO|UPDATE\s+[a-z_.]+\s+SET|DELETE\s+FROM)\b/i, 'the migration writes no rows');
  assert.doesNotMatch(s, /SECURITY\s+DEFINER|EVENT\s+TRIGGER|CREATE\s+TRIGGER|CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION/i);
  assert.doesNotMatch(s, /\b(?:orders|payment_entries|channels)\b/, 'core payment tables are not named');
});

test('the status machine, amounts and keys are constrained in the table itself', () => {
  const s = code();
  assert.match(s, /status text NOT NULL DEFAULT 'NEW' CHECK \(status IN \('NEW','PENDING','WAITING_FOR_CONFIRMATION','COMPLETED','CANCELED','REJECTED'\)\)/);
  assert.match(s, /amount integer NOT NULL CHECK \(amount > 0\)/);
  assert.match(s, /UNIQUE \(tenant_id, client_key\)/);
  assert.match(s, /UNIQUE \(tenant_id, ext_order_id\)/);
  assert.match(s, /UNIQUE \(tenant_id, provider_order_id\)/);
  assert.match(s, /receipt_entry_id uuid UNIQUE/);
  assert.match(s, /CHECK \(receipt_entry_id IS NULL OR status = 'COMPLETED'\)/);
  assert.match(s, /CREATE UNIQUE INDEX payu242_sessions_open ON payu242_sessions\(tenant_id, order_id\) WHERE status IN \('NEW','PENDING','WAITING_FOR_CONFIRMATION'\);/);
  assert.match(s, /signature_valid boolean NOT NULL/);
  assert.doesNotMatch(s, /\b(?:email|customer_ip|buyer|phone)\b/i, 'no personal data column');
});

test('dyna_app works under a tenant policy, never deletes, and only appends to the notification log', () => {
  const s = code();
  for (const t of TABLES) {
    assert.match(s, new RegExp(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY;`));
    assert.match(s, new RegExp(`CREATE POLICY tenant_scope ON ${t} USING \\(tenant_id=NULLIF\\(current_setting\\('app\\.tenant_id',true\\),''\\)::uuid\\) WITH CHECK \\(tenant_id=NULLIF\\(current_setting\\('app\\.tenant_id',true\\),''\\)::uuid\\);`));
  }
  assert.match(s, /REVOKE ALL ON TABLE payu242_configs, payu242_sessions, payu242_notifications, payu242_refunds FROM PUBLIC,dyna_app;/);
  assert.deepEqual([...s.matchAll(/\bGRANT\s+([A-Z, ]+)\s+ON\s+TABLE\s+(\S+)\s+TO\s+(\S+);/g)].map((m) => [m[1].trim(), m[2], m[3]]), [
    ['SELECT,INSERT,UPDATE', 'payu242_configs', 'dyna_app'],
    ['SELECT,INSERT,UPDATE', 'payu242_sessions', 'dyna_app'],
    ['SELECT,INSERT', 'payu242_notifications', 'dyna_app'],
    ['SELECT,INSERT,UPDATE', 'payu242_refunds', 'dyna_app'],
  ]);
});
