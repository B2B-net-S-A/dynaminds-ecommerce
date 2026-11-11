/** Migration 255_stock_verdict (prepared as 270, registered after 254_carrier_returns; docs/parity/CATALOG-STOCK-GEN270-20261029.md
 * "Integracja jako 255"). A new owner-only generation of the catalog stock control adapters: each stock_verdict_ function
 * is the sealed original's body with only its catalog guard call routed through the 248 verdict (same answer or error).
 * The sealed functions are neither replaced nor altered; TS calls the copies when installed and the sealed functions
 * otherwise. No database; the copies are compared with the sealed bodies by tests/stock-verdict255.test.ts. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { RELEASE_MIGRATIONS } from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/migration-manifest.mjs';

const file = new URL('../server/255_stock_verdict.sql', import.meta.url);
const sql = () => readFileSync(file, 'utf8');
/** The SQL outside function bodies (bodies are copies of sealed code and are checked against it on a clone). */
const outside = () => sql().replace(/--.*$/gm, '').split('$function$').filter((_, i) => i % 2 === 0).join('$function$');
const body = (name) => { const s = sql(), a = s.indexOf('CREATE FUNCTION public.' + name + '('); assert(a >= 0, name);
  const b = s.indexOf('$function$', a), e = s.indexOf('$function$', b + 1); assert(b > a && e > b, name); return s.slice(b, e); };
const FAMILY = [
  ['stock_verdict_require', ''],
  ['stock_verdict_return_require', ''],
  ['stock_verdict_return_frame', 'uid uuid, kid uuid, b jsonb'],
  ['stock_verdict_effect_prepare', 'uid uuid, kid uuid, b jsonb'],
  ['stock_verdict_effect_finish', 'uid uuid, kid uuid, eid uuid, b jsonb'],
  ['stock_verdict_return_prepare', 'uid uuid, kid uuid, b jsonb'],
];
const read = (f) => readFileSync(new URL('../server/' + f, import.meta.url), 'utf8');

test('255 follows 254 in the release list and pins the exact SQL bytes', () => {
  const i = RELEASE_MIGRATIONS.findIndex((m) => m.number === 255), row = RELEASE_MIGRATIONS[i];
  const b = readFileSync(file);
  assert(row, 'manifest row 255');
  assert.equal(row.name, '255_stock_verdict');
  assert.equal(row.file, '255_stock_verdict.sql');
  assert.equal(row.native_id, 'stock_verdict255');
  assert.equal(row.cold.contract, 'stock-verdict255');
  assert.equal(row.cold.project, 'projectCompiledStockVerdict255Catalogue');
  assert.equal(row.bytes, b.length);
  assert.equal(row.sha256, createHash('sha256').update(b).digest('hex'));
  assert.equal(row.bytes, 22347);
  assert.equal(row.sha256, '90137a151d1524681eb57fdd8f088a2272727d00b23e359d33b7d1510c0e4902');
  assert.equal(RELEASE_MIGRATIONS[i - 1].name, '254_carrier_returns');
  assert.equal(RELEASE_MIGRATIONS[i + 1]?.name, '256_return_receipt_verdicts', '256 follows 255');
  assert.match(sql(), /^-- Migration 255_stock_verdict \(prepared as 270, registered after 254_carrier_returns\)\. No object name/);
  assert.doesNotMatch(sql(), /PREPARED|placeholder/, 'no placeholder wording left');
  assert.doesNotMatch(readFileSync(new URL('../server/db.ts', import.meta.url), 'utf8'), /stock_verdict/, 'db.ts takes 255 from the manifest, not a literal pair');
});

test('only the six own stock_verdict_ functions are created; nothing is replaced, altered, dropped or granted', () => {
  const s = outside();
  assert.deepEqual([...s.matchAll(/CREATE\s+FUNCTION\s+public\.([a-z0-9_]+)\(([^)]*)\)/g)].map((m) => [m[1], m[2]]), FAMILY);
  assert.doesNotMatch(s, /CREATE\s+OR\s+REPLACE/i, 'no sealed function is replaced');
  assert.doesNotMatch(s, /\b(?:ALTER|DROP|GRANT|COMMENT|INSERT|UPDATE|DELETE|TRUNCATE)\b/i, 'no other statement outside the bodies');
  assert.doesNotMatch(s, /CREATE\s+(?!FUNCTION\s+public\.stock_verdict_)/i, 'no table, trigger, index or other object');
  for (const [name, args] of FAMILY) assert(s.includes(`REVOKE ALL ON FUNCTION public.${name}(${args}) FROM PUBLIC,dyna_app;`), name + ' owner-only');
  // The sealed fingerprints scan families with LIKE (_ is any character) and starts_with: no own name may fall in one.
  for (const [name] of FAMILY)
    for (const family of [/^catalog.stock./, /^manual.inventory.off./, /^return./, /^financial.return./, /^warehouse./, /^guard.verdict/, /^ordinary1/, /^b2b./, /^local./])
      assert.doesNotMatch(name, family, name);
});

test('the copies keep the sealed declarations: SECURITY DEFINER, the same search_path and TimeZone', () => {
  const s = sql();
  for (const [name] of FAMILY) {
    const head = s.slice(s.indexOf('CREATE FUNCTION public.' + name + '('), s.indexOf('$function$', s.indexOf('CREATE FUNCTION public.' + name + '(')));
    assert.match(head, /\n LANGUAGE plpgsql\n SECURITY DEFINER\n SET search_path TO 'pg_catalog', 'public'\n/, name);
    assert.equal(head.includes(` SET "TimeZone" TO 'UTC'`), !/_require$/.test(name), name + ' TimeZone as the sealed original');
  }
});

test('the catalog guard is asked only through the 248 verdict; no sealed require or full guard is left in a copy', () => {
  assert.match(body('stock_verdict_require'), /^\$function\$ BEGIN IF NOT public\.guard_verdict\('catalog_stock_control_guards'\) THEN RAISE EXCEPTION 'Niekompletny moduł ścisłej kontroli katalogu' USING ERRCODE='55000';END IF;END $/);
  assert.match(body('stock_verdict_return_require'), /PERFORM public\.stock_verdict_require\(\);IF NOT public\.catalog_stock_return_guards\(\) THEN RAISE EXCEPTION 'Niekompletny certyfikowany adapter PZ zwrotu' USING ERRCODE='55000'/);
  for (const name of ['stock_verdict_return_frame', 'stock_verdict_effect_prepare', 'stock_verdict_effect_finish'])
    assert.equal(body(name).split('PERFORM public.stock_verdict_require();').length - 1, 1, name);
  const p = body('stock_verdict_return_prepare');
  assert.equal(p.split('public.stock_verdict_return_require()').length - 1, 1);
  assert.equal(p.split('public.stock_verdict_return_frame(uid,kid,b)').length - 1, 2);
  assert.equal(p.split('public.stock_verdict_effect_prepare(uid,kid,descriptor)').length - 1, 1);
  for (const [name] of FAMILY)
    assert.doesNotMatch(body(name), /catalog_stock_control_require\(|catalog_stock_return_require\(|catalog_stock_control_guards\(\)|catalog_stock_return_frame\(|catalog_stock_control_effect_prepare\(/, name);
});

test('TS asks for the copies when installed and calls the sealed adapters otherwise; other adapters stay sealed', () => {
  const control = read('catalog-stock-control.ts'), ret = read('catalog-stock-return-effects.ts');
  for (const [s, copy, sig, sealed] of [
    [control, 'stock_verdict_effect_prepare', 'uuid,uuid,jsonb', 'catalog_stock_control_effect_prepare'],
    [control, 'stock_verdict_effect_finish', 'uuid,uuid,uuid,jsonb', 'catalog_stock_control_effect_finish'],
    [ret, 'stock_verdict_return_prepare', 'uuid,uuid,jsonb', 'catalog_stock_return_prepare']]) {
    assert(s.includes(`'public.${copy}(${sig})'`), copy + ' probed by its exact signature');
    assert(s.includes(`'${copy}':'${sealed}'`), copy + ' or ' + sealed);
  }
  assert.match(control, /to_regprocedure\(\$1\) IS NOT NULL installed/);
  assert.match(ret, /to_regprocedure\(\$1\) IS NOT NULL installed/);
  // Unchanged: abandon, return finish/abandon (financial return lane), count and manual-off adapters.
  assert.match(control, /SELECT public\.catalog_stock_control_effect_abandon\(\$1,\$2,\$3\)/);
  assert.match(ret, /SELECT public\.catalog_stock_return_finish\(\$1,\$2,\$3,\$4::jsonb\) receipt/);
  assert.match(ret, /SELECT public\.catalog_stock_return_abandon\(\$1,\$2,\$3\)/);
  for (const f of ['catalog-stock-count-effects.ts', 'b2b-credit-physical.ts', 'b2b-credit-source.ts', 'legacy-return-on-command.ts'])
    assert.doesNotMatch(read(f), /stock_verdict_/, f);
});
