/** Migration 241_verdict_gates (docs/parity/VERDICT-GATES241-20261027.md): registered after 240, adds only the owner-only
 * verdict241_ddl_intact() and replaces buyer_available236() (240 text) and wz_issuer239_verdict() (239 text) with two
 * calls of it each; no sealed-family object, the 236/239 privileges kept. No database; the behaviour is pinned by
 * tests/verdict-gates241.test.ts. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { RELEASE_MIGRATIONS } from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/migration-manifest.mjs';

const file = new URL('../server/241_verdict_gates.sql', import.meta.url);
const read = (n) => readFileSync(new URL('../server/' + n, import.meta.url), 'utf8');
const code = () => readFileSync(file, 'utf8').replace(/--.*$/gm, '');
const fn = (s, create, head) => { const a = s.indexOf(create + ' ' + head), b = s.indexOf('END $$;', a); assert(a >= 0 && b > a, create + ' ' + head); return s.slice(a, b); };
const GATE = ' IF public.verdict241_ddl_intact() IS DISTINCT FROM true THEN\n  RETURN ';
const RECORD = '\n  -- 241: and the 182 machinery is still intact now that the guard has run.\n  AND public.verdict241_ddl_intact() THEN';

test('241 follows 240 in the release list and pins the exact SQL bytes', () => {
  assert(existsSync(file), 'server/241_verdict_gates.sql exists');
  const i = RELEASE_MIGRATIONS.findIndex((m) => m.number === 241), row = RELEASE_MIGRATIONS[i], b = readFileSync(file);
  assert(i > 0, '241 is registered');
  assert.equal(row.name, '241_verdict_gates');
  assert.equal(row.file, '241_verdict_gates.sql');
  assert.equal(row.cold.contract, 'verdict-gates241');
  assert.equal(row.bytes, b.length);
  assert.equal(row.sha256, createHash('sha256').update(b).digest('hex'));
  assert.equal(RELEASE_MIGRATIONS[i - 1].name, '240_buyer_available_events');
});

test('one owner-only addition, the two verdicts and the WZ basis replaced; nothing named like a sealed family, no event trigger, no data write', () => {
  const s = code();
  assert.deepEqual([...s.matchAll(/\b(CREATE|ALTER|DROP)\s+(?:OR\s+REPLACE\s+)?([A-Z ]*?)(FUNCTION|TABLE|TRIGGER|POLICY|INDEX|VIEW|SEQUENCE|TYPE|DOMAIN|ROLE|SCHEMA|RULE)\s+([a-z0-9_.]+)/gi)].map((m) => m[0]),
    ['CREATE FUNCTION verdict241_ddl_intact', 'CREATE OR REPLACE FUNCTION buyer_available236', 'CREATE OR REPLACE FUNCTION wz_issuer239_basis', 'CREATE OR REPLACE FUNCTION wz_issuer239_verdict']);
  assert.doesNotMatch(s, /EVENT\s+TRIGGER/i);
  assert.doesNotMatch(s, /\b(?:INSERT\s+INTO|DELETE\s+FROM|TRUNCATE|UPDATE\s+(?:public\.)?(?!buyer_available236_verdict\b|wz_issuer239_verdict\b)[a-z_]+\s+SET)\b/i);
  // 151 matches its own functions with LIKE 'warehouse_wz_issuer_%' (_ is any character); 236 seals buyer_address_.
  for (const name of ['verdict241_ddl_intact']) {
    for (const like of ['warehouse_wz_issuer_%', 'warehouse_automatic_wz_%', 'buyer_address_%'])
      assert.doesNotMatch(name, new RegExp('^' + like.replaceAll('_', '.').replace('%', '.*') + '$'), name + ' vs ' + like);
    assert(!/^(?:ordinary1[0-9]{2}_|parcel_physical_wz_|buyer_available236_|wz_issuer239_)/.test(name), name);
  }
  assert.deepEqual([...s.matchAll(/\b(GRANT|REVOKE)\s+([^;]+);/g)].map((m) => m[0]), [
    'REVOKE ALL ON FUNCTION verdict241_ddl_intact() FROM PUBLIC,dyna_app;',
    'REVOKE ALL ON FUNCTION buyer_available236() FROM PUBLIC;', 'GRANT EXECUTE ON FUNCTION buyer_available236() TO dyna_app;',
    'REVOKE ALL ON FUNCTION wz_issuer239_basis() FROM PUBLIC,dyna_app;', 'REVOKE ALL ON FUNCTION wz_issuer239_verdict() FROM PUBLIC,dyna_app;']);
});

test('the gate pins the three event-trigger functions and the TEMP classifier exactly as ordinary182_valid() does', () => {
  const s = readFileSync(file, 'utf8'), gate = s.slice(s.indexOf('CREATE FUNCTION verdict241_ddl_intact()'), s.indexOf('$$;', s.indexOf('AS $$')) + 3);
  const s182 = read('182_cold_schema_runtime_admission.sql');
  for (const f of ['ordinary182_invalidate()', 'ordinary182_temp_ddl_end()', 'ordinary182_temp_drop()', 'ordinary182_is_temp_object(oid,oid)']) {
    const key = `SELECT FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang WHERE p.oid=to_regprocedure('public.${f}')`;
    const a = s182.indexOf('IF NOT EXISTS(' + key), b = s182.indexOf(') THEN RETURN false;END IF;', a);
    assert(a > 0 && b > a && s182.indexOf('IF NOT EXISTS(' + key, a + 1) < 0, f + ': one 182 pin');
    const pin = s182.slice(a + 'IF NOT EXISTS('.length, b);
    assert(gate.includes('\n  AND EXISTS(' + pin + ')\n'), f + ': the 182 predicate verbatim');
    assert.match(pin, /encode\(sha256\(convert_to\(p\.prosrc,'UTF8'\)\),'hex'\)='[a-f0-9]{64}'/);
    assert.match(pin, /p\.proconfig=ARRAY\['search_path=pg_catalog, public','TimeZone=UTC'\]/);
  }
  for (const [h, f] of [['36e95a42', 'ordinary182_invalidate'], ['1287fd20', 'ordinary182_temp_ddl_end'], ['53308234', 'ordinary182_temp_drop']])
    assert.match(gate, new RegExp(`'public\\.${f}\\(\\)'\\) AND encode\\(sha256\\(convert_to\\(p\\.prosrc,'UTF8'\\)\\),'hex'\\)='${h}`), f);
  for (const part of ["current_setting('event_triggers',true) IS DISTINCT FROM 'off' AND current_setting('session_replication_role')='origin'",
    'FROM pg_catalog.pg_db_role_setting s CROSS JOIN LATERAL unnest(s.setconfig) c(v)', "strpos(lower(c.v),'event_triggers')>0 OR strpos(lower(c.v),'session_replication_role')>0",
    'AND (SELECT count(*) FROM pg_catalog.pg_event_trigger)=3', "pg_catalog.pg_get_userbyid(e.evtowner)='postgres'",
    "NOT EXISTS(SELECT FROM pg_catalog.pg_rewrite WHERE ev_class=pg_catalog.to_regclass('public.ordinary182_runtime_generation'))",
    "NOT EXISTS(SELECT FROM pg_catalog.pg_policy WHERE polrelid=pg_catalog.to_regclass('public.ordinary182_runtime_generation'))",
    "NOT EXISTS(SELECT FROM pg_catalog.pg_trigger WHERE tgrelid=pg_catalog.to_regclass('public.ordinary182_runtime_generation') AND NOT tgisinternal)",
    // Security review of 241: no public overload of a pg_catalog function, no public comparison operator (qualified operators only).
    "AND NOT EXISTS(SELECT FROM pg_catalog.pg_proc p WHERE p.pronamespace OPERATOR(pg_catalog.=) 'public'::regnamespace::oid\n   AND EXISTS(SELECT FROM pg_catalog.pg_proc c WHERE c.pronamespace OPERATOR(pg_catalog.=) 'pg_catalog'::regnamespace::oid AND c.proname OPERATOR(pg_catalog.=) p.proname))",
    "AND NOT EXISTS(SELECT FROM pg_catalog.pg_operator o WHERE o.oprnamespace OPERATOR(pg_catalog.=) 'public'::regnamespace::oid\n   AND o.oprname OPERATOR(pg_catalog.=) ANY(ARRAY['=','<>','<','>','<=','>=','||','~','!~','~~','!~~','+','-']::name[]))\n$$;"])
    assert(gate.includes(part), part);
  assert.match(gate, /^CREATE FUNCTION verdict241_ddl_intact\(\) RETURNS boolean\n LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS \$\$/);
});

/** `now` must be `old` (CREATE OR REPLACE for CREATE) plus exactly the 241 pre-check before `anchor` and the record line. */
function insertions(old, now, anchor, full) {
  const start = now.indexOf(' -- 241: the content behind those three triggers'), end = now.indexOf(anchor);
  assert(start > 0 && end > start, 'the pre-check sits right before ' + anchor);
  const pre = now.slice(start, end);
  assert(pre.endsWith(GATE + full + ';\n END IF;\n'), 'false or NULL: the full guard, nothing recorded');
  assert.equal(pre.split('\n').filter((l) => !l.startsWith(' --')).join('\n'), GATE + full + ';\n END IF;\n');
  const rec = now.indexOf(RECORD);
  assert(rec > end, 'the record gate is on the miss path');
  const rebuilt = now.slice(0, start) + now.slice(end, rec) + ' THEN' + now.slice(rec + RECORD.length);
  assert.equal(rebuilt, old, 'everything else is the predecessor text unchanged');
  const hit = now.indexOf('IF seen.generation=v.generation AND seen.basis_sha256=b THEN RETURN true;END IF;');
  assert(end < hit && start > now.indexOf("OR v.contract_id IS DISTINCT FROM 'ordinary182-cold-schema-runtime/v1'"), 'after the fenced generation re-check, before the hit');
  assert(start > now.indexOf(")))<>3 THEN"), 'after the 239/240 event-trigger pre-check');
}

test('buyer_available236() is the 240 text plus the 241 pre-check before the TEMP check and the 241 record line', () => {
  const old = fn(read('240_buyer_available_events.sql'), 'CREATE OR REPLACE FUNCTION', 'buyer_available236() RETURNS boolean');
  const now = fn(readFileSync(file, 'utf8'), 'CREATE OR REPLACE FUNCTION', 'buyer_available236() RETURNS boolean');
  insertions(old, now, ' -- Runtime TEMP DDL (admitted by 182', 'public.buyer_address_available()');
  assert(now.includes("WHERE g.singleton)-1)" + RECORD + '\n  PERFORM 1 FROM public.buyer_available236_verdict WHERE singleton FOR UPDATE SKIP LOCKED;'), 'after the 240 xmin guard, before SKIP LOCKED');
  assert.match(now, /SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS \$\$/);
});

test('wz_issuer239_verdict() is the 239 text plus the 241 pre-check before the TEMP check and the 241 record line', () => {
  const old = fn(read('239_wz_issuer_verdict.sql'), 'CREATE FUNCTION', 'wz_issuer239_verdict() RETURNS boolean').replace(/^CREATE FUNCTION/, 'CREATE OR REPLACE FUNCTION');
  const now = fn(readFileSync(file, 'utf8'), 'CREATE OR REPLACE FUNCTION', 'wz_issuer239_verdict() RETURNS boolean');
  insertions(old, now, ' -- The guard functions do not list pg_temp', 'public.warehouse_wz_issuer_guards()');
  assert(now.includes("IF ok AND current_setting('transaction_read_only')='off' AND public.wz_issuer239_basis()=b" + RECORD + '\n  PERFORM 1 FROM public.wz_issuer239_verdict'));
  assert.match(now, /SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS \$\$/);
});

test('wz_issuer239_basis() is the 239 basis plus the 240 public-function and generation-table row versions', () => {
  const basisOf = (t, create) => { const a = t.indexOf(create + ' wz_issuer239_basis() RETURNS text'), b = t.indexOf('$$;', t.indexOf('AS $$', a) + 5); assert(a >= 0 && b > a, create); return t.slice(a, b); };
  const old = basisOf(read('239_wz_issuer_verdict.sql'), 'CREATE FUNCTION'), now = basisOf(readFileSync(file, 'utf8'), 'CREATE OR REPLACE FUNCTION');
  const a = now.indexOf(",\n  -- 241: the 240 row versions too"), b = now.indexOf('\n )::text,', a);
  assert(a > 0 && b > a);
  assert.equal('CREATE FUNCTION' + now.slice('CREATE OR REPLACE FUNCTION'.length, a) + now.slice(b), old, 'everything else is the 239 basis text');
  const added = now.slice(a, b), b240 = readFileSync(new URL('../server/240_buyer_available_events.sql', import.meta.url), 'utf8');
  for (const line of added.split('\n').filter((l) => /^  '(?:public_functions|generation_relation)'|^   \(SELECT/.test(l))) assert(b240.includes(line), 'the 240 text: ' + line);
  assert.equal(added.split('\n').filter((l) => /^  '(?:public_functions|generation_relation)'|^   \(SELECT/.test(l)).length, 5);
  assert.match(now, /LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS \$\$/);
});
