/** Migration 240_buyer_available_events (docs/parity/BUYER-ADDRESS240-20261027.md): registered after 239, replaces
 * only buyer_available236() and its basis with the 236 text plus the 239 event-trigger pre-check and the round-trip checks, creates and changes no
 * buyer_address_ object and keeps the 236 privileges; buyer_available236_basis() gains row versions. No database; the behaviour is pinned by
 * tests/buyer-available240.test.ts. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { RELEASE_MIGRATIONS } from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/migration-manifest.mjs';

const file = new URL('../server/240_buyer_available_events.sql', import.meta.url);
const code = () => readFileSync(file, 'utf8').replace(/--.*$/gm, '');
const body = (s, create) => { const a = s.indexOf(create + ' buyer_available236() RETURNS boolean'), b = s.indexOf('END $$;', a); assert(a >= 0 && b > a, create); return s.slice(a, b); };
const basisOf = (s, create) => { const a = s.indexOf(create + ' buyer_available236_basis() RETURNS text'), b = s.indexOf('$$;', s.indexOf('AS $$', a) + 5); assert(a >= 0 && b > a, create); return s.slice(a, b); };

test('240 follows 239 in the release list and pins the exact SQL bytes', () => {
  assert(existsSync(file), 'server/240_buyer_available_events.sql exists');
  const i = RELEASE_MIGRATIONS.findIndex((m) => m.number === 240), row = RELEASE_MIGRATIONS[i], b = readFileSync(file);
  assert(i > 0, '240 is registered');
  assert.equal(row.name, '240_buyer_available_events');
  assert.equal(row.file, '240_buyer_available_events.sql');
  assert.equal(row.cold.contract, 'buyer-available240');
  assert.equal(row.bytes, b.length);
  assert.equal(row.sha256, createHash('sha256').update(b).digest('hex'));
  assert.equal(RELEASE_MIGRATIONS[i - 1].name, '239_wz_issuer_verdict');
});

test('only buyer_available236() and its basis are replaced; no buyer_address_ object, no event trigger, no other object', () => {
  const s = code();
  assert.deepEqual([...s.matchAll(/\b(CREATE|ALTER|DROP)\s+(?:OR\s+REPLACE\s+)?([A-Z ]*?)(FUNCTION|TABLE|TRIGGER|POLICY|INDEX|VIEW|SEQUENCE|TYPE|DOMAIN|ROLE|SCHEMA)\s+([a-z0-9_.]+)/gi)].map((m) => m[0]),
    ['CREATE OR REPLACE FUNCTION buyer_available236_basis', 'CREATE OR REPLACE FUNCTION buyer_available236']);
  assert.doesNotMatch(s, /EVENT\s+TRIGGER/i);
  assert.doesNotMatch(s, /\b(?:INSERT\s+INTO|DELETE\s+FROM|TRUNCATE)\b/i);
  assert.doesNotMatch(s, /\bON\s+(?:TABLE\s+|FUNCTION\s+)?(?:public\.)?buyer_address_/i, 'no GRANT/REVOKE/COMMENT on a buyer_address_ object');
  assert.deepEqual([...s.matchAll(/\b(GRANT|REVOKE)\s+([^;]+);/g)].map((m) => m[0]),
    ['REVOKE ALL ON FUNCTION buyer_available236_basis() FROM PUBLIC;', 'REVOKE ALL ON FUNCTION buyer_available236() FROM PUBLIC;', 'GRANT EXECUTE ON FUNCTION buyer_available236() TO dyna_app;']);
});

test('the 240 body is the 236 body plus the event-trigger pre-check, between the generation re-check and the TEMP check', () => {
  const old = body(readFileSync(new URL('../server/236_buyer_available_verdict.sql', import.meta.url), 'utf8'), 'CREATE FUNCTION');
  const now = body(readFileSync(file, 'utf8'), 'CREATE OR REPLACE FUNCTION');
  const start = now.indexOf(' -- 240: '), end = now.indexOf(' -- Runtime TEMP DDL (admitted by 182');
  assert(start > 0 && end > start);
  const events = now.slice(start, end);
  const rec = now.indexOf('  -- 240: and no event trigger'), recEnd = now.indexOf(' THEN\n  PERFORM 1 FROM public.buyer_available236_verdict', rec);
  assert(rec > end && recEnd > rec, 'the record guard is on the miss path');
  const record = now.slice(rec, recEnd);
  assert.equal('CREATE FUNCTION' + now.slice('CREATE OR REPLACE FUNCTION'.length, start) + now.slice(end, rec).replace(/\n$/, '') + now.slice(recEnd), old, 'everything else is the 236 text unchanged');
  assert.match(record, /BETWEEN 0 AND 1000000000\n  AND NOT EXISTS\(SELECT FROM \(SELECT xmin FROM pg_catalog\.pg_event_trigger\n/);
  for (const part of ["pg_catalog.pg_proc WHERE pronamespace='public'::regnamespace AND starts_with(proname,'ordinary182_')", "pg_catalog.pg_class WHERE oid='public.ordinary182_runtime_generation'::regclass",
    "pg_catalog.pg_trigger WHERE tgrelid='public.ordinary182_runtime_generation'::regclass", "pg_catalog.pg_rewrite WHERE ev_class='public.ordinary182_runtime_generation'::regclass",
    "WHERE pg_catalog.age(w.xmin) BETWEEN 0 AND (SELECT pg_catalog.age(g.xmin) FROM public.ordinary182_runtime_generation g WHERE g.singleton)-1"]) assert(record.includes(part), part);
  assert(now.slice(recEnd).startsWith(' THEN\n  PERFORM 1 FROM public.buyer_available236_verdict WHERE singleton FOR UPDATE SKIP LOCKED;'), 'before the SKIP LOCKED record');
  assert(now.slice(0, start).includes("OR v.contract_id IS DISTINCT FROM 'ordinary182-cold-schema-runtime/v1'"), 'after the generation re-check under the fence');
  assert.match(events, /^ -- 240: [\s\S]*\n IF current_setting\('event_triggers',true\) IS NOT DISTINCT FROM 'off' OR \(SELECT count\(\*\) FROM pg_catalog\.pg_event_trigger e\n  WHERE e\.evtenabled='O' AND e\.evttags IS NULL AND \(/);
  for (const [name, event, fn] of [['ordinary182_schema_ddl', 'ddl_command_start', 'ordinary182_invalidate'], ['ordinary182_temp_ddl_end', 'ddl_command_end', 'ordinary182_temp_ddl_end'], ['ordinary182_temp_drop', 'sql_drop', 'ordinary182_temp_drop']])
    assert(events.includes(`(e.evtname='${name}' AND e.evtevent='${event}' AND e.evtfoid=pg_catalog.to_regprocedure('public.${fn}()'))`), name);
  assert.match(events, /\)\)\)<>3 THEN\n  RETURN public\.buyer_address_available\(\);\n END IF;\n$/, 'all three, else the full guard and nothing recorded');
  const hit = now.indexOf('IF seen.generation=v.generation AND seen.basis_sha256=b THEN RETURN true;END IF;');
  assert(end < now.indexOf('b:=public.buyer_available236_basis();') && end < hit, 'before the basis and the verdict hit');
  assert.match(now, /SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS \$\$/);
});

test('the 240 basis is the 236 basis plus event trigger, public function and generation-table row versions', () => {
  const old = basisOf(readFileSync(new URL('../server/236_buyer_available_verdict.sql', import.meta.url), 'utf8'), 'CREATE FUNCTION');
  const now = basisOf(readFileSync(file, 'utf8'), 'CREATE OR REPLACE FUNCTION');
  const a = now.indexOf(",\n  -- 240: row versions too."), b = now.indexOf('\n )::text,', a);
  assert(a > 0 && b > a);
  assert.equal('CREATE FUNCTION' + now.slice('CREATE OR REPLACE FUNCTION'.length, a) + now.slice(b), old, 'everything else is the 236 basis text');
  const added = now.slice(a, b);
  assert(added.includes("'event_trigger_rows',(SELECT jsonb_agg(jsonb_build_array(ctid::text,xmin::text) ORDER BY ctid) FROM pg_catalog.pg_event_trigger)"));
  assert(added.includes("'public_functions',(SELECT jsonb_agg(jsonb_build_array(oid::text,xmin::text) ORDER BY oid) FROM pg_catalog.pg_proc WHERE pronamespace='public'::regnamespace)"));
  for (const c of ["pg_catalog.pg_class WHERE oid=", "pg_catalog.pg_trigger WHERE tgrelid=", "pg_catalog.pg_rewrite WHERE ev_class="]) assert(added.includes(c + "'public.ordinary182_runtime_generation'::regclass"), c);
  assert.match(now, /LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS \$\$/);
});
