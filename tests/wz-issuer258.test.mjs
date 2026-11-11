/** Migration 258_wz_issuer_refresh (prepared as 273, registered after 257_order_merge_snapshot_index_paths;
 * docs/parity/WZ-ISSUER-GEN273-20261029.md "Integracja jako 258"); object names keep 273. Creates only wz_issuer273_refresh() and
 * replaces only wz_issuer239_verdict() (the 241 body plus the 240 record guard of buyer_available236()); no sealed WZ
 * object. The TS callers record the verdict outside the request statement budget. No database; the behaviour is pinned
 * by tests/wz-issuer258.test.ts. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { RELEASE_MIGRATIONS } from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/migration-manifest.mjs';

const file = new URL('../server/258_wz_issuer_refresh.sql', import.meta.url);
const strip = (s) => s.replace(/--.*$/gm, '');
const code = () => strip(readFileSync(file, 'utf8'));
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const fn = (s, head) => { const a = s.indexOf(head), b = s.indexOf('$$;', a); assert(a >= 0 && b > a, head); return s.slice(a, b); };
const squash = (s) => s.replace(/\s+/g, ' ').trim();
const VERDICT = 'CREATE OR REPLACE FUNCTION wz_issuer239_verdict() RETURNS boolean';
/** The 240 record guard of buyer_available236(), verbatim (241 text), and the 273 relhasrules check, inserted into the WZ
 * record condition (comments are stripped before comparing). */
const XMIN_GUARD = `AND (SELECT pg_catalog.age(g.xmin) FROM public.ordinary182_runtime_generation g WHERE g.singleton) BETWEEN 0 AND 1000000000
  AND NOT EXISTS(SELECT FROM (SELECT xmin FROM pg_catalog.pg_event_trigger
    UNION ALL SELECT xmin FROM pg_catalog.pg_proc WHERE pronamespace='public'::regnamespace AND starts_with(proname,'ordinary182_')
    UNION ALL SELECT xmin FROM pg_catalog.pg_class WHERE oid='public.ordinary182_runtime_generation'::regclass
    UNION ALL SELECT xmin FROM pg_catalog.pg_trigger WHERE tgrelid='public.ordinary182_runtime_generation'::regclass
    UNION ALL SELECT xmin FROM pg_catalog.pg_rewrite WHERE ev_class='public.ordinary182_runtime_generation'::regclass) w
   WHERE pg_catalog.age(w.xmin) BETWEEN 0 AND (SELECT pg_catalog.age(g.xmin) FROM public.ordinary182_runtime_generation g WHERE g.singleton)-1)
  AND NOT (SELECT c.relhasrules FROM pg_catalog.pg_class c WHERE c.oid='public.ordinary182_runtime_generation'::regclass)`;

test('258 follows 257 in the release list and pins the exact SQL bytes', () => {
  const i = RELEASE_MIGRATIONS.findIndex((m) => m.number === 258), row = RELEASE_MIGRATIONS[i];
  const b = readFileSync(file);
  assert(row, 'manifest row 258');
  assert.equal(row.name, '258_wz_issuer_refresh');
  assert.equal(row.file, '258_wz_issuer_refresh.sql');
  assert.equal(row.native_id, 'wz_issuer258');
  assert.equal(row.cold.contract, 'wz-issuer258');
  assert.equal(row.cold.project, 'projectCompiledWzIssuer258Catalogue');
  assert.equal(row.bytes, b.length);
  assert.equal(row.sha256, createHash('sha256').update(b).digest('hex'));
  assert.equal(row.bytes, 9195);
  assert.equal(row.sha256, 'fc7c3fdc08eb455afcc76d23ed10b38419c7d3efc1dd4c46c976944e72ff68bc');
  assert.equal(RELEASE_MIGRATIONS[i - 1].name, '257_order_merge_snapshot_index_paths');
  assert.equal(RELEASE_MIGRATIONS[i + 1]?.name, '259_jobs_running_lease', '259 follows 258');
  assert.doesNotMatch(read('server/db.ts'), /wz_issuer_refresh/, 'db.ts takes 258 from the manifest, not a literal pair');
});

test('258: the file is the registered migration and names no sealed family', () => {
  assert(existsSync(file), 'server/258_wz_issuer_refresh.sql exists');
  assert.match(readFileSync(file, 'utf8').split('\n')[0], /^-- Migration 258_wz_issuer_refresh \(prepared as 273, registered after 257_order_merge_snapshot_index_paths;/);
  const s = code();
  assert.deepEqual([...s.matchAll(/CREATE\s+(OR\s+REPLACE\s+)?FUNCTION\s+([a-z0-9_]+)\(/g)].map((m) => [Boolean(m[1]), m[2]]),
    [[true, 'wz_issuer239_verdict'], [false, 'wz_issuer273_refresh']]);
  // LIKE 'warehouse_wz_issuer_%' (151 fingerprint) treats _ as any character; wz_issuer273_ matches none of the sealed families.
  assert.doesNotMatch('wz_issuer273_refresh', /^warehouse.wz.issuer.|^warehouse.automatic.wz.|^parcel_physical_wz_|^ordinary18/);
  assert.doesNotMatch(s, /\b(?:CREATE|ALTER|DROP)\s+(?!OR\s+REPLACE\s+FUNCTION\s+wz_issuer239_verdict\(|FUNCTION\s+wz_issuer273_refresh\()/i, 'no other DDL');
  assert.doesNotMatch(s, /\bGRANT\b/i, 'nothing is granted; every caller is the owner');
  assert(s.includes('REVOKE ALL ON FUNCTION wz_issuer239_verdict() FROM PUBLIC,dyna_app;'));
  assert(s.includes('REVOKE ALL ON FUNCTION wz_issuer273_refresh() FROM PUBLIC,dyna_app;'));
  assert.doesNotMatch(s, /\bINSERT\s+INTO\b|\bDELETE\s+FROM\b/i);
  assert.deepEqual([...s.matchAll(/\bUPDATE\s+(?:public\.)?([a-z0-9_]+)\s+SET\b/gi)].map((m) => m[1]), ['wz_issuer239_verdict'], 'only the own verdict row is written');
});

test('the verdict is exactly the 241 body plus the 240 record guard and the relhasrules check, just before the second 241 gate', () => {
  const v241 = squash(fn(strip(read('server/241_verdict_gates.sql')), VERDICT)), v273 = squash(fn(code(), VERDICT)), guard = squash(XMIN_GUARD);
  assert(v273.includes(guard), 'the guard text of buyer_available236(), verbatim, then the relhasrules check');
  assert.equal(v273.split(guard).length, 2, 'once');
  assert.equal(v273.replace(guard + ' ', ''), v241, 'nothing else changes');
  const rec = v273.slice(v273.indexOf('ok:=public.warehouse_wz_issuer_guards();'));
  const at = (x) => { const i = rec.indexOf(x); assert(i > 0, x); return i; };
  assert(at('public.wz_issuer239_basis()=b') < at(guard) && at(guard) < at('AND public.verdict241_ddl_intact() THEN') &&
    at('AND public.verdict241_ddl_intact() THEN') < at('FOR UPDATE SKIP LOCKED'), 'record condition order');
});

test('the refresh: only READ COMMITTED READ WRITE, a lock it never waits for, then exactly the verdict; definer with the prepare_skip TimeZone', () => {
  const body = fn(code(), 'CREATE FUNCTION wz_issuer273_refresh()');
  assert.match(body, /^CREATE FUNCTION wz_issuer273_refresh\(\) RETURNS boolean\s+LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS \$\$/);
  const at = (x) => { const i = body.indexOf(x); assert(i > 0, x); return i; };
  const rc = at("IF current_setting('transaction_isolation')<>'read committed' OR current_setting('transaction_read_only')<>'off' THEN RETURN NULL;END IF;");
  const lock = at('IF NOT pg_catalog.pg_try_advisory_xact_lock(273,239) THEN RETURN NULL;END IF;');
  const verdict = at('RETURN public.wz_issuer239_verdict();');
  assert(rc < lock && lock < verdict, 'order');
  assert.deepEqual([...body.matchAll(/public\.([a-z0-9_]+)\(/g)].map((m) => m[1]), ['wz_issuer239_verdict'], 'no other function: never the full guard directly');
  assert.doesNotMatch(body, /RAISE|INSERT|UPDATE |DELETE|FOR (?:UPDATE|SHARE)|pg_advisory_xact_lock\(|pg_advisory_lock/i, 'no own refusal, write or waiting lock');
});

test('TS: startup refreshes on the Pool when 273 is installed; a request miss cut by 57014 schedules one background refresh', () => {
  const issued = read('server/warehouse-wz-issued.ts');
  assert.match(issued, /to_regprocedure\('public\.wz_issuer273_refresh\(\)'\) refresh/);
  assert.match(issued, /p\.verdict && 'release' in c \? 'SELECT public\.wz_issuer239_verdict\(\) ok' : 'SELECT public\.warehouse_wz_issuer_guards\(\) ok'/, 'the 239 choice is kept');
  assert.match(issued, /p\.refresh && !\('release' in c\) \? await refreshWzIssuerVerdict\(c\)\.catch\(/, 'only the Pool (startup) refreshes');
  assert.match(issued, /ensure\(ok \?\? \(await c\.query\(sql\)\.catch\(refreshAfterTimeout\)\)\.rows\[0\]\.ok, 503/, 'no answer from the refresh: the 239 query, as before');
  const issuer = read('server/warehouse-wz-issuer.ts');
  const a = issuer.indexOf('export async function prepareAutomaticWzInTx'), b = issuer.indexOf('export async function finishAutomaticWzInTx');
  assert.match(issuer.slice(a, b), /c\.query\('SELECT public\.wz_issuer239_prepare_skip\(\$1,\$2,\$3::jsonb\) skip',args\)\.catch\(refreshAfterTimeout\)\)\.rows\[0\]\.skip===true\)return null;/);
  assert.equal(issuer.slice(b).includes('refreshAfterTimeout'), false, 'finish and the terminal pin keep their sealed full require');
  for (const src of [issued, issuer]) {
    assert.match(src, /const refreshAfterTimeout=\(e:unknown\):never=>\{if\(typeof e==='object'&&e!==null&&\(e as \{code\?:unknown\}\)\.code==='57014'\)void scheduleWzIssuerRefresh\(pool\);throw e;\};/,
      'only a statement timeout schedules, and the error still propagates');
  }
  const refresher = read('server/wz-issuer273-refresh.ts');
  assert.doesNotMatch(refresher, /from '\.\/db'/, 'the refresher takes the pool; no import cycle');
});
