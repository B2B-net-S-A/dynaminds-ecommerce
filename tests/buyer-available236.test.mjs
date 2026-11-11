/** Migration 236_buyer_available_verdict (docs/parity/BUYER-ADDRESS236-20261027.md): registered as the next
 * release migration, creates and changes no buyer_address_ object (the buyer fingerprint stays sealed), falls
 * back to the full buyer_address_available() outside a cold-approved generation, and is what the application's
 * availability check calls. No database; the behaviour is pinned by tests/buyer-available236.test.ts. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { RELEASE_MIGRATIONS } from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/migration-manifest.mjs';

const file = new URL('../server/236_buyer_available_verdict.sql', import.meta.url);
const code = () => readFileSync(file, 'utf8').replace(/--.*$/gm, '');

test('236 follows 235 in the release list and pins the exact SQL bytes', () => {
  assert(existsSync(file), 'server/236_buyer_available_verdict.sql exists');
  const i = RELEASE_MIGRATIONS.findIndex((m) => m.number === 236), row = RELEASE_MIGRATIONS[i], b = readFileSync(file);
  assert.equal(row.number, 236);
  assert.equal(row.name, '236_buyer_available_verdict');
  assert.equal(row.file, '236_buyer_available_verdict.sql');
  assert.equal(row.cold.contract, 'buyer-available236');
  assert.equal(row.bytes, b.length);
  assert.equal(row.sha256, createHash('sha256').update(b).digest('hex'));
  assert.equal(RELEASE_MIGRATIONS[i - 1].name, '235_wms_evidence_usage');
});

test('no buyer_address_ object is created, replaced, altered or granted', () => {
  const s = code();
  assert.doesNotMatch(s, /(?:CREATE|ALTER|DROP)\s+(?:OR\s+REPLACE\s+)?[A-Z ]*?(?:FUNCTION|TABLE|TRIGGER|POLICY|INDEX|VIEW|SEQUENCE|TYPE)\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?(?:public\.)?buyer_address_/i);
  assert.doesNotMatch(s, /\bON\s+(?:TABLE\s+|FUNCTION\s+)?(?:public\.)?buyer_address_/i, 'no GRANT/REVOKE/COMMENT/trigger/policy on a buyer_address_ object');
  assert.deepEqual([...s.matchAll(/CREATE\s+(TABLE|FUNCTION)\s+([a-z0-9_]+)/g)].map((m) => m[2]),
    ['buyer_available236_verdict', 'buyer_available236_basis', 'buyer_available236']);
  assert.doesNotMatch(s, /\bINSERT\s+INTO\s+(?:public\.)?(?!buyer_available236_verdict\b)/i, 'only the own verdict row is written');
  assert.doesNotMatch(s, /\bUPDATE\s+(?:public\.)?(?!buyer_available236_verdict\b)[a-z_]+\s+SET\b/i);
  assert.doesNotMatch(s, /EVENT\s+TRIGGER|CREATE\s+TRIGGER/i);
});

test('outside a cold-approved generation the full guard answers; dyna_app may only call the entry point', () => {
  const s = code(), body = s.slice(s.indexOf('CREATE FUNCTION buyer_available236()'));
  const first = body.indexOf('RETURN public.buyer_address_available()'), lock = body.indexOf('pg_advisory_xact_lock_shared(982376)');
  assert(first > 0 && lock > first, 'unapproved generation returns the full guard before anything else');
  assert.match(body, /IF NOT FOUND OR v\.dirty OR v\.validated_generation IS DISTINCT FROM v\.generation THEN\s+RETURN public\.buyer_address_available\(\);/);
  assert.match(body, /PERFORM public\.buyer_address_available\(\);/, 'a basis miss runs the full guard (raises 55000)');
  const shadow = body.indexOf('pg_catalog.pg_my_temp_schema()<>0'), basis = body.indexOf('b:=public.buyer_available236_basis()');
  assert(shadow > lock && basis > shadow, 'the session TEMP shadow check precedes the basis and the verdict hit');
  assert.match(body, /JOIN pg_catalog\.pg_class p ON p\.relname=t\.relname\s+AND p\.relnamespace IN\('pg_catalog'::regnamespace,'public'::regnamespace\)/);
  assert.match(body, /JOIN pg_catalog\.pg_type p ON p\.typname=t\.typname\s+AND p\.typnamespace IN\('pg_catalog'::regnamespace,'public'::regnamespace\)/);
  assert.match(body.slice(shadow, basis), /THEN\s+RETURN public\.buyer_address_available\(\);/);
  assert.match(s, /REVOKE ALL ON TABLE buyer_available236_verdict FROM PUBLIC;/);
  assert.match(s, /REVOKE ALL ON FUNCTION buyer_available236_basis\(\) FROM PUBLIC;/);
  assert.match(s, /REVOKE ALL ON FUNCTION buyer_available236\(\) FROM PUBLIC;/);
  assert.deepEqual([...s.matchAll(/GRANT\s+([^;]+);/g)].map((m) => m[1]), ['EXECUTE ON FUNCTION buyer_available236() TO dyna_app']);
});

test('the application availability check calls buyer_available236() when it is installed', () => {
  const ts = readFileSync(new URL('../server/buyer-address.ts', import.meta.url), 'utf8');
  const a = ts.indexOf('async function available(c: PoolClient)'), b = ts.indexOf('\n}', a);
  assert(a > 0 && b > a);
  const fn = ts.slice(a, b);
  assert.match(fn, /to_regprocedure\('public\.buyer_available236\(\)'\) verdict/);
  assert.match(fn, /p\.verdict \? 'SELECT buyer_available236\(\) ok' : 'SELECT buyer_address_available\(\) ok'/);
});
