/** Migration 243_ksef_purchase (docs/parity/KSEF-PURCHASE243-20261027.md): registered as the next release migration
 * after 242; only own ksef243_ objects, foreign keys only between them, nothing references or alters a core or a
 * 229 table; the FA(3) file's hashes, the KSeF number dedup key and the retention floor are constraints; dyna_app
 * never deletes or truncates and updates only the workflow columns of an invoice; the purge is the only delete.
 * No database; the behaviour is pinned by tests/ksef243.test.ts. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { RELEASE_MIGRATIONS } from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/migration-manifest.mjs';

const file = new URL('../server/243_ksef_purchase.sql', import.meta.url);
const code = () => readFileSync(file, 'utf8').replace(/--.*$/gm, '');
const TABLES = ['ksef243_purchase_sync', 'ksef243_purchase_invoices', 'ksef243_purchase_rates', 'ksef243_purchase_corrections', 'ksef243_purchase_rejects', 'ksef243_purchase_events'];

test('243 follows 242 in the release list and pins the exact SQL bytes', () => {
  assert(existsSync(file), 'server/243_ksef_purchase.sql exists');
  const i = RELEASE_MIGRATIONS.findIndex((m) => m.number === 243), row = RELEASE_MIGRATIONS[i], b = readFileSync(file);
  assert(row, 'manifest row 243');
  assert.equal(row.name, '243_ksef_purchase');
  assert.equal(row.file, '243_ksef_purchase.sql');
  assert.equal(row.native_id, 'ksef_purchase243');
  assert.equal(row.cold.contract, 'ksef-purchase243');
  assert.equal(row.bytes, b.length);
  assert.equal(row.sha256, createHash('sha256').update(b).digest('hex'));
  assert.equal(RELEASE_MIGRATIONS[i - 1].name, '242_payu_sessions');
});

test('only own ksef243_ objects; foreign keys only between them; no core or 229 table is altered, referenced or written', () => {
  const s = code();
  assert.deepEqual([...s.matchAll(/CREATE\s+TABLE\s+(?:public\.)?([a-z0-9_]+)/g)].map((m) => m[1]), TABLES);
  for (const m of s.matchAll(/(?:CREATE|ALTER|DROP)\s+(?:UNIQUE\s+)?(?:TABLE|INDEX|FUNCTION|TRIGGER|VIEW|TYPE|SEQUENCE|POLICY\s+\w+\s+ON)\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?(?:public\.)?([a-z0-9_]+)(?![.\w])/gi))
    assert.match(m[1], /^ksef243_/, m[0]);
  for (const m of s.matchAll(/\bREFERENCES\s+(?:public\.)?([a-z0-9_]+)/gi)) assert.match(m[1], /^ksef243_purchase_(?:sync|invoices)$/, m[0]);
  for (const m of s.matchAll(/\bON\s+(?:TABLE\s+|FUNCTION\s+)?(?:public\.)?([a-z0-9_]+)\s*(?:\(|FOR|TO|FROM|USING|,)/gi)) assert.match(m[1], /^ksef243_/, m[0]);
  assert.doesNotMatch(s, /\b(?:INSERT\s+INTO|UPDATE\s+[a-z_.]+\s+SET)\b/i, 'the migration writes no rows');
  assert.doesNotMatch(s, /EVENT\s+TRIGGER|CREATE\s+OR\s+REPLACE/i);
  assert.equal([...s.matchAll(/SECURITY\s+DEFINER/g)].length, 1, 'only the purge runs as the owner');
  assert.doesNotMatch(s, /\b(?:orders|documents|payment_entries|crm_clients|jobs)\b/, 'core tables are not named');
  assert.match(s, /to_regclass\('public\.ksef229_configs'\) IS NULL/, 'requires 229');
});

test('the file, the dedup key and the retention floor are constraints of the table itself', () => {
  const s = code();
  assert.match(s, /UNIQUE\(tenant_id,ksef_number\)/);
  assert.match(s, /CHECK\(xml_bytes=octet_length\(xml\) AND xml_sha256=encode\(sha256\(xml\),'hex'\) AND invoice_hash=encode\(sha256\(xml\),'base64'\)\)/);
  assert.match(s, /xml_bytes integer NOT NULL CHECK\(xml_bytes BETWEEN 1 AND 3145728\)/, '3 MiB like the reader');
  assert.match(s, /CHECK\(retain_until>=make_date\(extract\(year FROM issue_date\)::integer\+6,12,31\)\)/);
  assert.match(s, /checkpoint->>'nip'=nip/);
  assert.match(s, /CHECK\(\(lease_token IS NULL\)=\(leased_until IS NULL\)\)/);
  assert.doesNotMatch(s.slice(s.indexOf('CREATE TABLE public.ksef243_purchase_rejects'), s.indexOf('CREATE TABLE public.ksef243_purchase_events')), /\b(?:xml|bytea)\b/, 'a refused file keeps no content');
});

test('dyna_app works under a forced tenant policy, never deletes or truncates, and updates only workflow columns', () => {
  const s = code();
  assert.match(s, /FOREACH t IN ARRAY ARRAY\['ksef243_purchase_sync','ksef243_purchase_invoices','ksef243_purchase_rates','ksef243_purchase_corrections','ksef243_purchase_rejects','ksef243_purchase_events'\] LOOP/);
  assert.match(s, /FORCE ROW LEVEL SECURITY/);
  assert.match(s, /CREATE POLICY tenant_scope ON public\.%I TO dyna_app USING\(tenant_id=nullif\(current_setting\('app\.tenant_id',true\),''\)::uuid\) WITH CHECK/);
  assert.doesNotMatch(s, /GRANT[^;]*\b(?:DELETE|TRUNCATE|ALL)\b[^;]*TO dyna_app/i);
  assert.match(s, /GRANT UPDATE\(status,status_by,status_at,accounting_ref,note,version,legal_hold,retain_until\) ON public\.ksef243_purchase_invoices TO dyna_app;/);
  assert.doesNotMatch(s, /GRANT UPDATE[^;]*ON public\.ksef243_purchase_(?:rates|events)/, 'rates and events are insert-only');
  for (const t of TABLES) assert.match(s, new RegExp(`BEFORE TRUNCATE ON public\\.${t} FOR EACH STATEMENT`), t + ' never truncated');
  assert.match(s, /GRANT EXECUTE ON FUNCTION public\.ksef243_purchase_purge\(\) TO dyna_app;/);
  assert.match(s, /REVOKE ALL ON FUNCTION public\.ksef243_keep_guard\(\),public\.ksef243_invoice_guard\(\),public\.ksef243_correction_guard\(\) FROM PUBLIC,dyna_app;/);
  assert.match(s, /OLD\.retain_until<current_date AND NOT OLD\.legal_hold THEN RETURN OLD/, 'the guard itself refuses to delete a retained or held invoice');
});
