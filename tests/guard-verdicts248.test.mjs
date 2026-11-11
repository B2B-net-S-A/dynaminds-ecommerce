/** Migration 248_guard_verdicts (docs/parity/GUARD-VERDICTS248-20261027.md; prepared as placeholder 256, registered
 * after 247): one cached verdict for three integrity guards the TS writers ask inside their write transactions.
 * Creates and changes no object of a sealed family, falls back to the full guard outside a cold-approved READ COMMITTED
 * call, takes the 239/240/241 gates from the start, grants nothing, and is what the three TS call sites use.
 * The manifest row pins the exact bytes after 247. No database; the behaviour is pinned by tests/guard-verdicts248.test.ts. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { RELEASE_MIGRATIONS } from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/migration-manifest.mjs';

const file = new URL('../server/248_guard_verdicts.sql', import.meta.url);
const code = () => readFileSync(file, 'utf8').replace(/--.*$/gm, '');
const fn = (s, name) => { const a = s.indexOf('CREATE FUNCTION ' + name + '('), b = s.indexOf('$$;', a); assert(a >= 0 && b > a, name); return s.slice(a, b); };
const GUARDS = ['catalog_stock_control_guards', 'financial_return_guards', 'fa3_draft_guards'];

test('248 follows 247 in the release list and pins the exact SQL bytes', () => {
  assert(existsSync(file), 'server/248_guard_verdicts.sql exists');
  const i = RELEASE_MIGRATIONS.findIndex((m) => m.number === 248), row = RELEASE_MIGRATIONS[i], b = readFileSync(file);
  assert(row, 'manifest row 248');
  assert.equal(row.name, '248_guard_verdicts');
  assert.equal(row.file, '248_guard_verdicts.sql');
  assert.equal(row.native_id, 'guard_verdicts248');
  assert.equal(row.cold.contract, 'guard-verdicts248');
  assert.equal(row.cold.project, 'projectCompiledGuardVerdicts248Catalogue');
  assert.equal(row.bytes, b.length);
  assert.equal(row.sha256, createHash('sha256').update(b).digest('hex'));
  assert.equal(row.bytes, 17084);
  assert.equal(row.sha256, '5dd54b8a2b405375d8ff2b18b8999c061fa077111d28d1a42d467efb08776b85');
  assert.equal(RELEASE_MIGRATIONS[i - 1].name, '247_sales_dimensions_repricing');
  assert.equal(RELEASE_MIGRATIONS[i + 1]?.name, '249_catalog_ai', '249 follows 248');
});

test('only own guard_verdict objects; no sealed object is created, replaced, altered or granted; no GRANT at all', () => {
  assert(existsSync(file), 'server/248_guard_verdicts.sql exists');
  const s = code();
  assert.deepEqual([...s.matchAll(/CREATE\s+(TABLE|FUNCTION)\s+([a-z0-9_]+)/g)].map((m) => m[2]),
    ['guard_verdicts', 'guard_verdict_basis', 'guard_verdict_full', 'guard_verdict']);
  // The sealed fingerprints match their families with LIKE (where _ is any character): no own name may fall in one.
  for (const m of s.matchAll(/CREATE\s+(?:TABLE|FUNCTION)\s+([a-z0-9_]+)/g))
    for (const family of [/^catalog.stock./, /^financial.return./, /^fa3.draft./, /^local.invoice./, /^buyer.address./, /^warehouse./, /^parcel.physical.wz./, /^ordinary18/, /^verdict241/])
      assert.doesNotMatch(m[1], family, m[1]);
  assert.doesNotMatch(s, /(?:CREATE|ALTER|DROP)\s+(?:OR\s+REPLACE\s+)?[A-Z ]*?(?:FUNCTION|TABLE|TRIGGER|POLICY|INDEX|VIEW|SEQUENCE|TYPE)\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?(?:public\.)?(?!guard_verdict)[a-z]/i);
  assert.doesNotMatch(s, /CREATE\s+OR\s+REPLACE/i, 'nothing is replaced');
  assert.doesNotMatch(s, /\bGRANT\b/i, 'nothing is granted; every caller is the owner');
  for (const o of ['TABLE guard_verdicts', 'FUNCTION guard_verdict_basis()', 'FUNCTION guard_verdict_full(text)', 'FUNCTION guard_verdict(text)'])
    assert(s.includes(`REVOKE ALL ON ${o} FROM PUBLIC,dyna_app;`), o);
  assert.doesNotMatch(s, /\bINSERT\s+INTO\s+(?:public\.)?(?!guard_verdicts\b)/i, 'only the own verdict rows are written');
  assert.doesNotMatch(s, /\bUPDATE\s+(?:public\.)?(?!guard_verdicts\b)[a-z_]+\s+SET\b/i);
  assert.doesNotMatch(s, /EVENT\s+TRIGGER|CREATE\s+TRIGGER|\bEXECUTE\s+(?:format|'|\$)/i, 'no trigger and no dynamic SQL');
  for (const f of ['guard_verdict_basis', 'guard_verdict_full', 'guard_verdict'])
    assert.match(fn(s, f), /SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp/, f + ': pg_temp explicitly last');
  assert.match(s, /ENABLE ROW LEVEL SECURITY;[\s\S]*FORCE ROW LEVEL SECURITY;/);
});

test('the full guard comes from a fixed list of exactly the three guards; anything else is refused', () => {
  const s = code(), full = fn(s, 'guard_verdict_full');
  assert.deepEqual([...full.matchAll(/WHEN '([a-z0-9_]+)' THEN RETURN public\.([a-z0-9_]+)\(\);/g)].map((m) => [m[1], m[2]]), GUARDS.map((g) => [g, g]));
  assert.match(full, /ELSE RAISE EXCEPTION USING ERRCODE='22023'/);
  const table = s.slice(s.indexOf('CREATE TABLE guard_verdicts'), s.indexOf(');\n', s.indexOf('CREATE TABLE guard_verdicts')));
  assert(table.includes(`CHECK(guard IN(${GUARDS.map((g) => `'${g}'`).join(',')}))`), 'the table admits only the three');
  assert(fn(s, 'guard_verdict').includes(`IF g IS NULL OR g NOT IN(${GUARDS.map((g) => `'${g}'`).join(',')}) THEN`));
});

test('the verdict: RC only, approved generation, fence, event triggers, 241 gate, TEMP, basis; record RW + unchanged basis + 240 + 241 + SKIP LOCKED', () => {
  const body = fn(code(), 'guard_verdict');
  const at = (x, from = 0) => { const i = body.indexOf(x, from); assert(i > 0, x); return i; };
  const rc = at("IF current_setting('transaction_isolation')<>'read committed' THEN RETURN public.guard_verdict_full(g);END IF;");
  const gate = at('IF NOT FOUND OR v.dirty OR v.validated_generation IS DISTINCT FROM v.generation THEN\n  RETURN public.guard_verdict_full(g);');
  const lock = at('PERFORM pg_advisory_xact_lock_shared(982376);');
  const recheck = at("OR v.contract_id IS DISTINCT FROM 'ordinary182-cold-schema-runtime/v1'");
  const events = at("IF current_setting('event_triggers',true) IS NOT DISTINCT FROM 'off' OR (SELECT count(*) FROM pg_catalog.pg_event_trigger e");
  const intact = at('IF public.verdict241_ddl_intact() IS DISTINCT FROM true THEN\n  RETURN public.guard_verdict_full(g);');
  const temp = at('pg_catalog.pg_my_temp_schema()<>0');
  for (const t of ['ordinary182_schema_ddl', 'ordinary182_temp_ddl_end', 'ordinary182_temp_drop']) assert(body.slice(events, intact).includes(`e.evtname='${t}'`), t);
  assert.match(body.slice(events, intact), /e\.evtenabled='O'[\s\S]*\)<>3 THEN\s+RETURN public\.guard_verdict_full\(g\);/, 'all three enabled in origin mode, else the full guard');
  const basis = at('b:=public.guard_verdict_basis();');
  const hit = at('IF seen.generation=v.generation AND seen.basis_sha256=b THEN RETURN true;END IF;');
  const full = at('ok:=public.guard_verdict_full(g);');
  assert(rc < gate && gate < lock && lock < recheck && recheck < events && events < intact && intact < temp && temp < basis && basis < hit && hit < full, 'order');
  assert.match(body.slice(temp, basis), /relnamespace=pg_catalog\.pg_my_temp_schema\(\)[\s\S]*typnamespace=pg_catalog\.pg_my_temp_schema\(\)[\s\S]*RETURN public\.guard_verdict_full\(g\);/, 'any TEMP relation or type of this session');
  const record = body.slice(full);
  assert.match(record, /^ok:=public\.guard_verdict_full\(g\);\s+IF ok AND current_setting\('transaction_read_only'\)='off' AND public\.guard_verdict_basis\(\)=b\s/);
  const xmin = at("starts_with(proname,'ordinary182_')", full), intact2 = at('AND public.verdict241_ddl_intact() THEN', full);
  const skip = at('PERFORM 1 FROM public.guard_verdicts WHERE guard=g FOR UPDATE SKIP LOCKED;', full);
  assert(xmin < intact2 && intact2 < skip, '240 record guard, then 241 again, then SKIP LOCKED');
  assert.equal(body.split('public.verdict241_ddl_intact()').length - 1, 2, 'pre-check and record gate');
  assert.match(record, /IF FOUND THEN\s+UPDATE public\.guard_verdicts SET generation=v\.generation,basis_sha256=b,verified_at=clock_timestamp\(\) WHERE guard=g;/);
  assert.match(record, /RETURN ok;\s*END\s*$/);
  assert.equal((body.match(/RETURN true;/g) ?? []).length, 1, 'true without the full guard only on a hit');
});

test('the basis covers every table the guards read, the shared catalogues, TEMP rows, session state and 240 row versions', () => {
  const b = fn(code(), 'guard_verdict_basis');
  for (const t of ['b2b_credit_upgrade', 'b2b_invoice_upgrade', 'buyer_address_manifest', 'catalog_stock_control_manifest', 'catalog_stock_count_manifest',
    'catalog_stock_legacy_group_manifest', 'catalog_stock_return_manifest', 'competitor_observation_manifest', 'credit_source_upgrade_certificate',
    'fa3_draft_manifest', 'financial_return_upgrade_certificate', 'local_invoice_manifest', 'manual_inventory_off_certificate', 'migrations',
    'order_merge_delivery209_manifest', 'order_merge_delivery209_projection_basis'])
    assert(b.includes(`'${t}',(SELECT jsonb_agg(jsonb_build_array(ctid::text,xmin::text) ORDER BY ctid) FROM public.${t})`), t);
  for (const t of ['pg_authid', 'pg_auth_members', 'pg_db_role_setting', 'pg_tablespace', 'pg_event_trigger']) assert(b.includes(`FROM pg_catalog.${t})`), t);
  assert.match(b, /'generation',\(SELECT to_jsonb\(g\)\|\|jsonb_build_object\('ctid',g\.ctid::text,'xmin',g\.xmin::text\) FROM public\.ordinary182_runtime_generation g\)/);
  assert.match(b, /FROM pg_catalog\.pg_class WHERE relpersistence='t'/, 'every session\'s TEMP relations');
  assert.match(b, /'session',jsonb_build_object\('session_user',session_user::text,'role',current_setting\('role'\)/);
  for (const s of ['session_replication_role', 'TimeZone', 'DateStyle', 'extra_float_digits', 'bytea_output', 'event_triggers']) assert(b.includes(`'${s}'`), s);
  assert.match(b, /'public_functions',\(SELECT jsonb_agg\(jsonb_build_array\(oid::text,xmin::text\) ORDER BY oid\) FROM pg_catalog\.pg_proc WHERE pronamespace='public'::regnamespace\)/);
  assert.match(b, /'generation_relation',jsonb_build_array\(/);
});

test('the three TS call sites ask the verdict when it is installed; Pool callers keep the full guard', () => {
  const read = (f) => readFileSync(new URL('../server/' + f, import.meta.url), 'utf8');
  const sites = [
    ['catalog-stock-control-transaction.ts', 'catalog_stock_control_guards', /p\.verdict&&'release' in c\?"SELECT public\.guard_verdict\('catalog_stock_control_guards'\) ok":'SELECT public\.catalog_stock_control_guards\(\) ok'/],
    ['financial-return-completion.ts', 'financial_return_guards', /p\.verdict\?"SELECT public\.guard_verdict\('financial_return_guards'\) ok":'SELECT public\.financial_return_guards\(\) ok'/],
    ['fa3-draft-access.ts', 'fa3_draft_guards', /p\.verdict\?"SELECT public\.guard_verdict\('fa3_draft_guards'\) ok":'SELECT public\.fa3_draft_guards\(\) ok'/],
  ];
  for (const [f, g, re] of sites) {
    const s = read(f);
    assert.match(s, /to_regprocedure\('public\.guard_verdict\(text\)'\) verdict/, f + ': probes for 248');
    assert.match(s, re, f + ': ' + g);
  }
  // local_invoice_guards stays on its full guard (server/local-invoices.ts is hash-pinned by the scale HTTP bindings).
  assert.doesNotMatch(read('local-invoices.ts'), /guard_verdict/);
  // The construction probe on the Pool (fa3-drafts.ts fa3DraftModuleAvailable) keeps the full guard.
  assert.match(read('fa3-drafts.ts'), /await pool\.query\('SELECT public\.fa3_draft_guards\(\) ok'\)/);
});
