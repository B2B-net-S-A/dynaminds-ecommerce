/** Migration 263_manual_off_verdict (prepared as 281, registered after 262_revoke_public_temporary;
 * docs/parity/MANUAL-OFF-GEN281-20261030.md "Integracja jako 263"). A new owner-only generation of the manual OFF PW/RW correction functions (169): each
 * manual_off_verdict_ copy is the sealed original's body with only its guard calls swapped for manual_off_verdict_require()
 * / _frame() and the 255 stock_verdict_ adapters; manual_off_verdict_valid() answers true from the 248 verdict of
 * catalog_stock_control_guards() (whose only true exit is manual_inventory_off_valid()) and is the full manual OFF guard
 * otherwise. The sealed functions are neither replaced nor altered; TS calls the copies when installed and the sealed
 * functions otherwise. No database; the copies are compared with the sealed bodies by tests/manual-off-verdict263.test.ts. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { RELEASE_MIGRATIONS } from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/migration-manifest.mjs';
import { SCALE_HTTP_PORT_SOURCE_PINS } from '../scripts/full-base-scale-http-ports.mjs';

const file = new URL('../server/263_manual_off_verdict.sql', import.meta.url);
const sql = () => readFileSync(file, 'utf8');
/** The SQL outside function bodies (bodies are copies of sealed code and are checked against it on a clone). */
const outside = () => sql().replace(/--.*$/gm, '').split('$function$').filter((_, i) => i % 2 === 0).join('$function$');
const body = (name) => { const s = sql(), a = s.indexOf('CREATE FUNCTION public.' + name + '('); assert(a >= 0, name);
  const b = s.indexOf('$function$', a), e = s.indexOf('$function$', b + 1); assert(b > a && e > b, name); return s.slice(b, e); };
const count = (s, part) => s.split(part).length - 1;
const FAMILY = [
  ['manual_off_verdict_valid', ''],
  ['manual_off_verdict_require', ''],
  ['manual_off_verdict_frame', 'pid uuid, wh uuid, locking boolean'],
  ['manual_off_verdict_preview', 'u uuid, k uuid, b jsonb'],
  ['manual_off_verdict_preview_can_apply', 'pid uuid'],
  ['manual_off_verdict_apply', 'u uuid, k uuid, pid uuid, b jsonb'],
];
const SEALED_GUARDS = /manual_inventory_off_valid\(\)|manual_inventory_off_require\(|manual_inventory_off_frame\(|catalog_stock_control_require\(|catalog_stock_control_guards\(\)|catalog_stock_control_effect_prepare\(|catalog_stock_control_effect_finish\(/;
const ts = () => readFileSync(new URL('../server/manual-inventory-off.ts', import.meta.url));

test('263 follows 262 in the release list and pins the exact SQL bytes', () => {
  const i = RELEASE_MIGRATIONS.findIndex((m) => m.number === 263), row = RELEASE_MIGRATIONS[i];
  const b = readFileSync(file);
  assert(row, 'manifest row 263');
  assert.equal(row.name, '263_manual_off_verdict');
  assert.equal(row.file, '263_manual_off_verdict.sql');
  assert.equal(row.native_id, 'manual_off_verdict263');
  assert.equal(row.cold.contract, 'manual-off-verdict263');
  assert.equal(row.cold.project, 'projectCompiledManualOffVerdict263Catalogue');
  assert.equal(row.bytes, b.length);
  assert.equal(row.sha256, createHash('sha256').update(b).digest('hex'));
  assert.equal(row.bytes, 18915);
  assert.equal(row.sha256, '5588862afd2e689b12934875b73fa4117f18f4a352405c120f0f7012b9dc11c9');
  assert.equal(RELEASE_MIGRATIONS[i - 1].name, '262_revoke_public_temporary');
  // 263 was the last release migration when it was registered; 264_order_status_labels and later follow it.
  assert.equal(RELEASE_MIGRATIONS[i + 1]?.name, '264_order_status_labels', '264 is the next release migration');
  assert.match(sql(), /^-- Migration 263_manual_off_verdict \(prepared as 281, registered after 262_revoke_public_temporary; no object name contains\n/);
  assert.doesNotMatch(sql(), /PREPARED|placeholder|INTEGRATION-p281/, 'no placeholder wording left');
  assert.equal(RELEASE_MIGRATIONS.find((m) => m.number === 281), undefined, 'no row for the placeholder number');
  assert.doesNotMatch(readFileSync(new URL('../server/db.ts', import.meta.url), 'utf8'), /manual_off_verdict/, 'db.ts takes 263 from the manifest, not a literal pair');
});

test('only the six own manual_off_verdict_ functions are created; nothing is replaced, altered, dropped or granted', () => {
  const s = outside();
  assert.deepEqual([...s.matchAll(/CREATE\s+FUNCTION\s+public\.([a-z0-9_]+)\(([^)]*)\)/g)].map((m) => [m[1], m[2]]), FAMILY);
  assert.doesNotMatch(s, /CREATE\s+OR\s+REPLACE/i, 'no sealed function is replaced');
  assert.doesNotMatch(s, /\b(?:ALTER|DROP|GRANT|COMMENT|INSERT|UPDATE|DELETE|TRUNCATE)\b/i, 'no other statement outside the bodies');
  assert.doesNotMatch(s, /CREATE\s+(?!FUNCTION\s+public\.manual_off_verdict_)/i, 'no table, trigger, index or other object');
  for (const [name, args] of FAMILY) assert(s.includes(`REVOKE ALL ON FUNCTION public.${name}(${args}) FROM PUBLIC,dyna_app;`), name + ' owner-only');
  // The sealed fingerprints scan families with LIKE (_ is any character) and starts_with: no own name may fall in one.
  for (const [name] of FAMILY)
    for (const family of [/^manual.inventory.off./, /^catalog.stock./, /^stock.verdict/, /^return./, /^financial.return./, /^warehouse./, /^guard.verdict/, /^ordinary1/, /^b2b./, /^local./])
      assert.doesNotMatch(name, family, name);
});

test('the copies keep the sealed declarations: SECURITY DEFINER, the same search_path and TimeZone', () => {
  const s = sql();
  for (const [name] of FAMILY.slice(1)) {
    const at = s.indexOf('CREATE FUNCTION public.' + name + '('), head = s.slice(at, s.indexOf('$function$', at));
    assert.match(head, /\n LANGUAGE plpgsql\n SECURITY DEFINER\n SET search_path TO 'pg_catalog', 'public'\n/, name);
    assert.equal(head.includes(` SET "TimeZone" TO 'UTC'`), name !== 'manual_off_verdict_require', name + ' TimeZone as the sealed original');
  }
  const at = s.indexOf('CREATE FUNCTION public.manual_off_verdict_valid('), head = s.slice(at, s.indexOf('$function$', at));
  assert.match(head, /RETURNS boolean\n LANGUAGE plpgsql\n SECURITY DEFINER\n SET search_path TO 'pg_catalog', 'public', 'pg_temp'\n/);
});

test('manual_off_verdict_valid: the verdict only in READ COMMITTED with the pinned catalog guard body, the full manual OFF guard otherwise', () => {
  const v = body('manual_off_verdict_valid').replace(/--.*$/gm, '');
  // Exactly two exits: true after a true 248 verdict, and the sealed full guard.
  assert.deepEqual([...v.matchAll(/RETURN\s+([^;]+);/g)].map((m) => m[1].trim()), ['true', 'public.manual_inventory_off_valid()']);
  const iso = v.indexOf("pg_catalog.current_setting('transaction_isolation')='read committed'"), pin = v.indexOf("pg_catalog.to_regprocedure('public.catalog_stock_control_guards()')");
  const verdict = v.indexOf("public.guard_verdict('catalog_stock_control_guards') IS TRUE THEN RETURN true;");
  assert(iso > 0 && pin > iso && verdict > pin, 'isolation and pin are checked before the verdict is asked');
  assert.equal(count(v, 'guard_verdict('), 1);
  assert.match(v, /p\.prolang=\(SELECT l\.oid FROM pg_catalog\.pg_language l WHERE l\.lanname='plpgsql'\)\)\n\s+='([a-f0-9]{64})' THEN/);
  // The pin is the sealed catalog guard whose last statement is RETURN public.manual_inventory_off_valid() (169/152).
  assert.equal(/='([a-f0-9]{64})' THEN/.exec(v)[1], 'ef9c31fbabca36776256efe76dcd16265c9f742ce4a64cbd7cc000c056baf225');
  assert.doesNotMatch(v, /EXCEPTION|EXECUTE|INSERT|UPDATE|DELETE|PERFORM/i, 'no handler, dynamic SQL or write in the guard');
});

test('every manual OFF guard in a copy goes through manual_off_verdict_; no sealed guard, require, frame or catalog adapter is left', () => {
  assert.match(body('manual_off_verdict_require'), /^\$function\$BEGIN IF NOT manual_off_verdict_valid\(\) THEN RAISE EXCEPTION 'Incomplete manual OFF family' USING ERRCODE='55000';END IF;END$/);
  for (const [name, require, frame] of [['manual_off_verdict_frame', 1, 0], ['manual_off_verdict_preview', 1, 1], ['manual_off_verdict_preview_can_apply', 0, 1], ['manual_off_verdict_apply', 1, 1]]) {
    assert.equal(count(body(name), 'PERFORM manual_off_verdict_require();'), require, name + ' require');
    assert.equal(count(body(name), 'manual_off_verdict_frame(('), frame, name + ' frame');
  }
  const a = body('manual_off_verdict_apply');
  assert.equal(count(a, 'effect:=stock_verdict_effect_prepare(u,k,'), 1);
  assert.equal(count(a, 'PERFORM stock_verdict_effect_finish(u,k,'), 1);
  for (const [name] of FAMILY.slice(1)) assert.doesNotMatch(body(name), SEALED_GUARDS, name);
});

test('TS asks for the copies when the whole family is installed and calls the sealed functions otherwise', () => {
  const s = ts().toString('utf8');
  for (const sig of FAMILY.map(([n]) => n)) assert.match(s, new RegExp(`to_regprocedure\\('public\\.${sig}\\(`), sig + ' probed');
  for (const dep of ['guard_verdict(text)', 'stock_verdict_effect_prepare(uuid,uuid,jsonb)', 'stock_verdict_effect_finish(uuid,uuid,uuid,jsonb)'])
    assert(s.includes(`to_regprocedure('public.${dep}') IS NOT NULL`), dep + ' (248/255, called by the copies) probed too');
  for (const [copy, sealed] of [
    ['manual_off_verdict_valid() ok', 'manual_inventory_off_valid() ok'],
    ['manual_off_verdict_frame($1,$2,false) f', 'manual_inventory_off_frame($1,$2,false) f'],
    ['manual_off_verdict_preview($1,$2,$3::jsonb) r', 'manual_inventory_off_preview($1,$2,$3::jsonb) r'],
    ['manual_off_verdict_preview_can_apply($1) ok', 'manual_inventory_off_preview_can_apply($1) ok'],
    ['manual_off_verdict_apply($1,$2,$3,$4::jsonb) r', 'manual_inventory_off_apply($1,$2,$3,$4::jsonb) r']])
    assert(s.includes(`'SELECT ${copy}':'SELECT ${sealed}'`), copy + ' or ' + sealed);
  // Every guarded call chooses; no sealed guarded call is left unconditional.
  for (const sealed of ['manual_inventory_off_valid()', 'manual_inventory_off_frame(', 'manual_inventory_off_preview(', 'manual_inventory_off_preview_can_apply(', 'manual_inventory_off_apply('])
    assert.equal(count(s, "'SELECT " + sealed), count(s, "':'SELECT " + sealed), sealed + ' only as the fallback of a choice');
  // Unchanged: the restore validator, the live receipt validator and the receipt check stay on the sealed validate.
  assert.equal(count(s, "SELECT manual_inventory_off_validate($1,false)"), 2);
  assert.equal(count(s, "SELECT manual_inventory_off_validate($1,true)"), 1);
});

test('the scale HTTP bindings re-pin manual-inventory-off.ts with a ManualOff281 review note', () => {
  assert.equal(SCALE_HTTP_PORT_SOURCE_PINS['server/manual-inventory-off.ts'], createHash('sha256').update(ts()).digest('hex'));
  assert.match(readFileSync(new URL('../scripts/full-base-scale-http-ports.mjs', import.meta.url), 'utf8'), /\/\/ ManualOff281 re-pins server\/manual-inventory-off\.ts after review:/);
});
