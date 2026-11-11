/** Migration 256_return_receipt_verdicts (prepared as 272, registered after 255_stock_verdict; docs/parity/RETURN-RECEIPT-GEN272-20261029.md
 * "Integracja jako 256"): one owner-only front door for the sealed financial_return_capture() of
 * the ordinary return receipt (the catalog side, catalog_stock_return_prepare, belongs to the 255 stock_verdict_
 * generation). It asks guard_verdict() (248) first, answers NULL only where the sealed function would, and otherwise IS
 * the sealed function (it returns the sealed call). No sealed object is created, replaced, altered or granted. No
 * database; the behaviour is pinned by tests/return-receipt256.database.test.ts. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { RELEASE_MIGRATIONS } from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/migration-manifest.mjs';

const file = new URL('../server/256_return_receipt_verdicts.sql', import.meta.url);
const read = (f) => readFileSync(new URL('../server/' + f, import.meta.url), 'utf8');
const code = () => { assert(existsSync(file), 'server/256_return_receipt_verdicts.sql exists'); return readFileSync(file, 'utf8').replace(/--.*$/gm, ''); };
const fn = (s, name) => { const a = s.indexOf('CREATE FUNCTION ' + name + '('), b = s.indexOf('END$$;', a); assert(a >= 0 && b > a, name); return s.slice(a, b); };
const FRONTS = [
  { name: 'return_receipt272_financial_capture', args: '(uid uuid,kid uuid,h text,rid uuid,q jsonb)', sig: '(uuid,uuid,text,uuid,jsonb)', guard: 'financial_return_guards',
    sealed: 'public.financial_return_capture(uid,kid,h,rid,q)' },
];

test('256 follows 255 in the release list and pins the exact SQL bytes', () => {
  const i = RELEASE_MIGRATIONS.findIndex((m) => m.number === 256), row = RELEASE_MIGRATIONS[i];
  const b = readFileSync(file);
  assert(row, 'manifest row 256');
  assert.equal(row.name, '256_return_receipt_verdicts');
  assert.equal(row.file, '256_return_receipt_verdicts.sql');
  assert.equal(row.native_id, 'return_receipt_verdicts256');
  assert.equal(row.cold.contract, 'return-receipt-verdicts256');
  assert.equal(row.cold.project, 'projectCompiledReturnReceiptVerdicts256Catalogue');
  assert.equal(row.bytes, b.length);
  assert.equal(row.sha256, createHash('sha256').update(b).digest('hex'));
  assert.equal(row.bytes, 4362);
  assert.equal(row.sha256, '6ce76ac9f8af8d1900a620ee4e37e96802101b106193a0cd8d2513945d81319c');
  assert.equal(RELEASE_MIGRATIONS[i - 1].name, '255_stock_verdict');
  assert.equal(RELEASE_MIGRATIONS[i + 1]?.name, '257_order_merge_snapshot_index_paths', '257 follows 256');
  assert.match(readFileSync(file, 'utf8'), /^-- Migration 256_return_receipt_verdicts \(prepared as 272; the object name keeps the return_receipt272_ prefix\)\.\n/);
  assert.doesNotMatch(read('db.ts'), /return_receipt_verdicts/, 'db.ts takes 256 from the manifest, not a literal pair');
});

test('only the one own return_receipt272_ function; nothing sealed, no table, write, trigger, dynamic SQL or GRANT', () => {
  const s = code();
  assert.deepEqual([...s.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?(TABLE|FUNCTION|VIEW|TRIGGER|TYPE|SEQUENCE|INDEX)\s+([a-z0-9_.]+)/gi)].map((m) => m[1] + ' ' + m[2]),
    FRONTS.map((f) => 'FUNCTION ' + f.name));
  // The sealed fingerprints match their families with LIKE/starts_with: no own name may fall in one.
  for (const f of FRONTS) for (const family of [/^catalog.stock./, /^financial.return./, /^b2b./, /^fa3.draft./, /^local.invoice./, /^buyer.address./, /^warehouse./,
    /^parcel.physical.wz./, /^ordinary18/, /^verdict241/, /^guard.verdict/, /^return.credit/, /^return.assistant/, /^return.destination/, /^return.exchange/, /^manual.inventory/])
    assert.doesNotMatch(f.name, family, f.name);
  assert.doesNotMatch(s, /CREATE\s+OR\s+REPLACE/i, 'nothing is replaced');
  assert.doesNotMatch(s, /\b(?:ALTER|DROP)\s+[A-Z]/i, 'nothing is altered or dropped');
  assert.doesNotMatch(s, /\bGRANT\b/i, 'nothing is granted; every caller is the owner');
  assert.doesNotMatch(s, /\bINSERT\s+INTO\b|\bUPDATE\s+[a-z_.]+\s+SET\b|\bDELETE\s+FROM\b|\bTRUNCATE\b/i, 'no write of its own');
  assert.doesNotMatch(s, /EVENT\s+TRIGGER|\bEXECUTE\b|\bFOR\s+UPDATE\b|\bFOR\s+SHARE\b/i, 'no trigger, dynamic SQL or row lock of its own');
  for (const f of FRONTS) {
    assert(s.includes(`REVOKE ALL ON FUNCTION ${f.name}${f.sig} FROM PUBLIC,dyna_app;`), f.name + ' revoked');
    assert.match(fn(s, f.name), new RegExp('^CREATE FUNCTION ' + f.name + f.args.replace(/[()]/g, '\\$&') +
      ' RETURNS jsonb\\s+LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET "TimeZone"=\'UTC\' AS \\$\\$'), f.name + ': definer, pg_temp last, UTC like the sealed function');
  }
});

test('each front door asks the verdict first and otherwise only returns NULL or the sealed function itself', () => {
  const s = code();
  for (const f of FRONTS) {
    const body = fn(s, f.name).slice(fn(s, f.name).indexOf('BEGIN'));
    const verdict = body.indexOf(`public.guard_verdict('${f.guard}') IS DISTINCT FROM true THEN`), first = body.indexOf(`RETURN ${f.sealed};`);
    assert(verdict > 0 && first > verdict, f.name + ': not exactly true -> the sealed function');
    // the verdict is the first database read: before it only the arguments and app.tenant_id are inspected
    assert.doesNotMatch(body.slice(0, verdict), /\bFROM\s+public\.|PERFORM|SELECT\s+\*/i, f.name + ': nothing read before the verdict');
    const returns = [...body.matchAll(/RETURN\s+([^;]+);/g)].map((m) => m[1].trim());
    assert(returns.length >= 3, f.name);
    for (const r of returns) assert(r === 'NULL' || r === f.sealed, f.name + ': unexpected RETURN ' + r);
    // the full guard is never called directly: only through the verdict or inside the sealed function
    assert.doesNotMatch(body, new RegExp('public\\.' + f.guard + '\\(|catalog_stock_return_require|catalog_stock_control_require|financial_return_frame\\(|catalog_stock_return_frame\\(|catalog_stock_control_effect_prepare\\('),
      f.name + ': no sealed guard-bearing helper');
  }
});

test('financial front: the sealed capture/frame order — identity, replay, own RMA, identity again, the NULL conditions, B2B invoice', () => {
  const b = fn(code(), 'return_receipt272_financial_capture');
  const at = (x, from = 0) => { const i = b.indexOf(x, from); assert(i > 0, x); return i; };
  const verdict = at("public.guard_verdict('financial_return_guards')");
  const id1 = at('PERFORM public.financial_return_identity(uid,kid,h,rid,false);');
  const replay = at('FROM public.financial_return_admissions WHERE(tenant_id,return_id)=(tenant,rid)');
  const rma = at('FROM public.return_cases WHERE(tenant_id,id)=(tenant,rid)');
  const id2 = at('PERFORM public.financial_return_identity(uid,kid,h,rid,false);', id1 + 1);
  const accepted = at("WHERE(v->>'accepted')::bigint>0) THEN RETURN NULL;");
  const cond = at("IF rc.legacy OR rc.remedy<>'refund' OR rc.state<>'requested' OR rc.receipt IS NOT NULL OR rc.received_at IS NOT NULL OR rc.receipt_sequence<>0");
  const invoice = at("kind='invoice' AND mode='b2b_invoice') THEN RETURN NULL;");
  assert(verdict < id1 && id1 < replay && replay < rma && rma < id2 && id2 < accepted && accepted < cond && cond < invoice, 'order');
  for (const x of ["(v->>'restocked')::integer<>0", "q ? 'wms_lots' OR q ? 'origin_id'", 'FROM public.b2b_return_local_origins WHERE(tenant_id,return_id)=(tenant,rid)',
    'FROM public.order_parcel_plans WHERE(tenant_id,order_id)=(tenant,rc.order_id)']) assert(b.slice(cond, invoice).includes(x), x);
  assert.match(b.slice(replay, rma), /THEN\s+RETURN public\.financial_return_capture\(uid,kid,h,rid,q\);END IF;/, 'a replay is the sealed capture');
  assert.match(b.slice(invoice), /RETURN NULL;END IF;\s+RETURN public\.financial_return_capture\(uid,kid,h,rid,q\);\s*$/, 'a B2B invoice -> the sealed capture');
});

test('the financial TS call site uses the front door when installed; replay keeps the sealed capture; the catalog side is p270\'s', () => {
  const ret = read('catalog-stock-return-effects.ts'), fin = read('financial-return-completion.ts');
  assert.doesNotMatch(ret, /return_receipt272/, 'catalog_stock_return_prepare is switched by p270 (stock_verdict_return_prepare), not by 272');
  assert.match(fin, /to_regprocedure\('public\.return_receipt272_financial_capture\(uuid,uuid,text,uuid,jsonb\)'\) IS NOT NULL f/);
  assert.match(fin, /front\?'SELECT public\.return_receipt272_financial_capture\(\$1,\$2,\$3,\$4,\$5::jsonb\) frame':'SELECT public\.financial_return_capture\(\$1,\$2,\$3,\$4,\$5::jsonb\) frame'/);
  assert.equal(fin.split('return_receipt272_financial_capture(').length - 1, 2, 'probe + one call (prepare), not the replay');
  assert.match(fin, /replayFinancialReturn162InTx[\s\S]*SELECT public\.financial_return_capture\(\$1,\$2,\$3,\$4,\$5::jsonb\) frame',/, 'replay stays sealed');
  // inside the owner bridge (the verdict and the front door are owner-only)
  assert.match(fin, /const saved=await owner\(c,async\(\)=>\{const front=/);
});
