/** Migration 237_auth_security (docs/parity/AUTH-SECURITY237-20261027.md): registered as the next release
 * migration; only own auth237_ objects (no core table is altered, referenced by a foreign key or granted), all
 * owner-only. No database; the behaviour is pinned by tests/auth-security237.test.ts. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { RELEASE_MIGRATIONS } from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/migration-manifest.mjs';

const file = new URL('../server/237_auth_security.sql', import.meta.url);
const code = () => readFileSync(file, 'utf8').replace(/--.*$/gm, '');

test('237 follows 236 in the release list and pins the exact SQL bytes', () => {
  assert(existsSync(file), 'server/237_auth_security.sql exists');
  const i = RELEASE_MIGRATIONS.findIndex((m) => m.number === 237), row = RELEASE_MIGRATIONS[i], b = readFileSync(file);
  assert.equal(row.number, 237);
  assert.equal(row.name, '237_auth_security');
  assert.equal(row.file, '237_auth_security.sql');
  assert.equal(row.cold.contract, 'auth-security237');
  assert.equal(row.bytes, b.length);
  assert.equal(row.sha256, createHash('sha256').update(b).digest('hex'));
  assert.equal(RELEASE_MIGRATIONS[i - 1].name, '236_buyer_available_verdict');
});

test('only own auth237_ objects; no core table is altered, referenced or written', () => {
  const s = code();
  assert.deepEqual([...s.matchAll(/CREATE\s+(TABLE|FUNCTION)\s+([a-z0-9_]+)/g)].map((m) => m[2]),
    ['auth237_login_events', 'auth237_login_throttle', 'auth237_api_key_state', 'auth237_login_attempt', 'auth237_record_login']);
  for (const m of s.matchAll(/(?:CREATE|ALTER|DROP)\s+(?:UNIQUE\s+)?(?:TABLE|INDEX|FUNCTION|TRIGGER|POLICY|VIEW|TYPE|SEQUENCE)\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?(?:public\.)?([a-z0-9_]+)/gi))
    assert.match(m[1], /^auth237_/, m[0]);
  for (const m of s.matchAll(/\bON\s+(?!CONFLICT\b)(?:TABLE\s+|FUNCTION\s+)?(?:public\.)?([a-z0-9_]+)/gi)) assert.match(m[1], /^auth237_/, m[0]);
  assert.doesNotMatch(s, /\bREFERENCES\b/i, 'no foreign key to a core table (no RI trigger on users or api_keys)');
  assert.doesNotMatch(s, /\b(?:INSERT\s+INTO|(?<!DO\s)UPDATE|DELETE\s+FROM)\s+(?!(?:public\.)?auth237_|SET\b)[a-z_.]+/i);
  assert.doesNotMatch(s, /\bGRANT\b|SECURITY\s+DEFINER|EVENT\s+TRIGGER|CREATE\s+TRIGGER/i, 'owner-only, nothing for dyna_app');
  for (const t of ['auth237_login_events', 'auth237_login_throttle', 'auth237_api_key_state']) {
    assert.match(s, new RegExp(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY;`));
    assert.match(s, new RegExp(`REVOKE ALL ON TABLE ${t} FROM PUBLIC,dyna_app;`));
  }
  assert.match(s, /REVOKE ALL ON FUNCTION auth237_login_attempt\(text\) FROM PUBLIC,dyna_app;/);
});

test('retention: 90 days of login events, idle counters after one day, bounded per call', () => {
  const s = code(), body = s.slice(s.indexOf('CREATE FUNCTION auth237_record_login'));
  assert.match(body, /created_at<clock_timestamp\(\)-interval '90 days' ORDER BY created_at LIMIT 200/);
  assert.match(body, /updated_at<clock_timestamp\(\)-interval '1 day' AND \(locked_until IS NULL OR locked_until<clock_timestamp\(\)\) ORDER BY updated_at LIMIT 200/);
});
