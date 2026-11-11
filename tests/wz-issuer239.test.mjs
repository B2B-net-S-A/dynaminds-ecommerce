/** Migration 239_wz_issuer_verdict (docs/parity/WZ-ISSUER239-20261027.md): registered as the next release
 * migration, creates and changes no object of a sealed WZ family (warehouse_wz_issuer_, warehouse_automatic_wz_,
 * parcel_physical_wz_ fingerprints stay as they are), falls back to the full warehouse_wz_issuer_guards()
 * outside a cold-approved READ COMMITTED call, grants nothing, and is what the TS call sites use.
 * No database; the behaviour is pinned by tests/wz-issuer239.test.ts. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { RELEASE_MIGRATIONS } from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/migration-manifest.mjs';

const file = new URL('../server/239_wz_issuer_verdict.sql', import.meta.url);
const code = () => readFileSync(file, 'utf8').replace(/--.*$/gm, '');
const fn = (s, name) => { const a = s.indexOf('CREATE FUNCTION ' + name + '('), b = s.indexOf('$$;', a); assert(a >= 0 && b > a, name); return s.slice(a, b); };

test('239 follows 238 in the release list and pins the exact SQL bytes', () => {
  assert(existsSync(file), 'server/239_wz_issuer_verdict.sql exists');
  const i = RELEASE_MIGRATIONS.findIndex((m) => m.number === 239), row = RELEASE_MIGRATIONS[i], b = readFileSync(file);
  assert.equal(row.name, '239_wz_issuer_verdict');
  assert.equal(row.file, '239_wz_issuer_verdict.sql');
  assert.equal(row.cold.contract, 'wz-issuer239');
  assert.equal(row.bytes, b.length);
  assert.equal(row.sha256, createHash('sha256').update(b).digest('hex'));
  assert.equal(RELEASE_MIGRATIONS[i - 1].name, '238_audit_log');
});

test('only own wz_issuer239_ objects; no sealed WZ object is created, replaced, altered or granted; no GRANT at all', () => {
  const s = code();
  assert.deepEqual([...s.matchAll(/CREATE\s+(TABLE|FUNCTION)\s+([a-z0-9_]+)/g)].map((m) => m[2]),
    ['wz_issuer239_verdict', 'wz_issuer239_basis', 'wz_issuer239_verdict', 'wz_issuer239_prepare_skip']);
  // LIKE 'warehouse_wz_issuer_%' (the 151 fingerprint and ACL checks) treats _ as any character.
  for (const m of s.matchAll(/CREATE\s+(?:TABLE|FUNCTION)\s+([a-z0-9_]+)/g)) {
    assert.doesNotMatch(m[1], /^warehouse.wz.issuer./, m[1]);
    assert.doesNotMatch(m[1], /^warehouse.automatic.wz./, m[1]);
    assert(!m[1].startsWith('parcel_physical_wz_'), m[1]);
  }
  assert.doesNotMatch(s, /(?:CREATE|ALTER|DROP)\s+(?:OR\s+REPLACE\s+)?[A-Z ]*?(?:FUNCTION|TABLE|TRIGGER|POLICY|INDEX|VIEW|SEQUENCE|TYPE)\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?(?:public\.)?(?!wz_issuer239_)[a-z]/i);
  assert.doesNotMatch(s, /\bGRANT\b/i, 'nothing is granted; every caller is the owner');
  for (const o of ['TABLE wz_issuer239_verdict', 'FUNCTION wz_issuer239_basis()', 'FUNCTION wz_issuer239_verdict()', 'FUNCTION wz_issuer239_prepare_skip(uuid,uuid,jsonb)'])
    assert(s.includes(`REVOKE ALL ON ${o} FROM PUBLIC,dyna_app;`), o);
  assert.doesNotMatch(s, /\bINSERT\s+INTO\s+(?:public\.)?(?!wz_issuer239_verdict\b)/i, 'only the own verdict row is written');
  assert.doesNotMatch(s, /\bUPDATE\s+(?:public\.)?(?!wz_issuer239_verdict\b)[a-z_]+\s+SET\b/i);
  assert.doesNotMatch(s, /EVENT\s+TRIGGER|CREATE\s+TRIGGER/i);
  for (const f of ['wz_issuer239_basis', 'wz_issuer239_verdict', 'wz_issuer239_prepare_skip'])
    assert.match(fn(s, f), /SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp/, f + ': pg_temp explicitly last');
});

test('the verdict: RC only, unapproved generation -> full guard, fence, TEMP check, basis, record only RW with SKIP LOCKED', () => {
  const body = fn(code(), 'wz_issuer239_verdict');
  const at = (x) => { const i = body.indexOf(x); assert(i > 0, x); return i; };
  const rc = at("IF current_setting('transaction_isolation')<>'read committed' THEN RETURN public.warehouse_wz_issuer_guards();END IF;");
  const gate = at('IF NOT FOUND OR v.dirty OR v.validated_generation IS DISTINCT FROM v.generation THEN\n  RETURN public.warehouse_wz_issuer_guards();');
  const lock = at('PERFORM pg_advisory_xact_lock_shared(982376);');
  const recheck = at("OR v.contract_id IS DISTINCT FROM 'ordinary182-cold-schema-runtime/v1'");
  const events = at("IF current_setting('event_triggers',true) IS NOT DISTINCT FROM 'off' OR (SELECT count(*) FROM pg_catalog.pg_event_trigger e");
  const temp = at('pg_catalog.pg_my_temp_schema()<>0');
  for (const t of ['ordinary182_schema_ddl', 'ordinary182_temp_ddl_end', 'ordinary182_temp_drop']) assert(body.slice(events, temp).includes(`e.evtname='${t}'`), t);
  assert.match(body.slice(events, temp), /e\.evtenabled='O'[\s\S]*\)<>3 THEN\s+RETURN public\.warehouse_wz_issuer_guards\(\);/, 'all three enabled in origin mode, else the full guard');
  const basis = at('b:=public.wz_issuer239_basis();');
  const hit = at('IF seen.generation=v.generation AND seen.basis_sha256=b THEN RETURN true;END IF;');
  const full = at('ok:=public.warehouse_wz_issuer_guards();');
  assert(rc < gate && gate < lock && lock < recheck && recheck < events && events < temp && temp < basis && basis < hit && hit < full, 'order');
  assert.match(body.slice(temp, basis), /relnamespace=pg_catalog\.pg_my_temp_schema\(\)[\s\S]*typnamespace=pg_catalog\.pg_my_temp_schema\(\)[\s\S]*RETURN public\.warehouse_wz_issuer_guards\(\);/);
  assert.match(body.slice(full), /IF ok AND current_setting\('transaction_read_only'\)='off' AND public\.wz_issuer239_basis\(\)=b THEN\s+PERFORM 1 FROM public\.wz_issuer239_verdict WHERE singleton FOR UPDATE SKIP LOCKED;\s+IF FOUND THEN\s+UPDATE public\.wz_issuer239_verdict SET/);
  assert.match(body.slice(full), /RETURN ok;/);
});

test('prepare_skip: the reused verdict, then only the NULL outcomes of the sealed prepare; never its own refusal', () => {
  const body = fn(code(), 'wz_issuer239_prepare_skip');
  assert.match(body, /IF NOT public\.wz_issuer239_verdict\(\) THEN RETURN false;END IF;\s+g:=public\.warehouse_wz_issuer_access\(uid,kid,false\);/);
  assert.doesNotMatch(body, /RAISE/, 'refusals stay with the sealed prepare');
  assert.doesNotMatch(body, /FOR (?:UPDATE|SHARE)|INSERT|UPDATE |DELETE|pg_advisory/i, 'no lock and no write');
  assert.equal((body.match(/RETURN true;/g) ?? []).length, 1, 'only the dispatched shipment returns true directly');
  assert.match(body, /RETURN NOT EXISTS\(SELECT 1 FROM public\.warehouse_automatic_wz_configurations c WHERE c\.tenant_id=t AND c\.settings->>'enabled'='true'/);
});

test('the TS call sites: issued availability inside a transaction and the automatic prepare use 239 when installed', () => {
  const issued = readFileSync(new URL('../server/warehouse-wz-issued.ts', import.meta.url), 'utf8');
  assert.match(issued, /to_regprocedure\('public\.wz_issuer239_verdict\(\)'\) verdict/);
  assert.match(issued, /p\.verdict && 'release' in c \? 'SELECT public\.wz_issuer239_verdict\(\) ok' : 'SELECT public\.warehouse_wz_issuer_guards\(\) ok'/);
  const issuer = readFileSync(new URL('../server/warehouse-wz-issuer.ts', import.meta.url), 'utf8');
  const a = issuer.indexOf('export async function prepareAutomaticWzInTx'), b = issuer.indexOf('export async function finishAutomaticWzInTx');
  const prepare = issuer.slice(a, b);
  assert.match(prepare, /to_regprocedure\('public\.wz_issuer239_prepare_skip\(uuid,uuid,jsonb\)'\) skip/);
  const skip = prepare.indexOf("SELECT public.wz_issuer239_prepare_skip($1,$2,$3::jsonb) skip"), sealed = prepare.indexOf("SELECT public.warehouse_wz_issuer_prepare($1,$2,$3::jsonb) id");
  assert(skip > 0 && sealed > skip, 'the skip is asked before the sealed prepare');
  assert.match(prepare, /\.rows\[0\]\.skip===true\)return null;/);
  assert.match(issuer.slice(b), /SELECT public\.warehouse_wz_issuer_finish\(/, 'finish stays sealed');
  assert.match(issuer.slice(b), /SELECT public\.warehouse_wz_issuer_require\(\)/, 'the terminal pin keeps the full require');
});
