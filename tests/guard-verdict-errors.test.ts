import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { incompleteModuleGuardError } from '../server/guard-verdict-errors';

const where = (fn: string) =>
  `PL/pgSQL function ${fn} line 14 at RAISE\nPL/pgSQL function guard_verdict_full(text) line 4 at RETURN\nPL/pgSQL function guard_verdict(text) line 11 at RETURN`;

test('55000 and 42883 raised inside guard_verdict() are an incomplete module', () => {
  assert.equal(incompleteModuleGuardError({ code: '55000', where: where('order_merge_delivery209_checked_projection_map(oid)') }), true);
  assert.equal(incompleteModuleGuardError({ code: '42883', where: where('catalog_stock_control_guards()') }), true);
});

test('other codes, errors outside guard_verdict() and malformed input keep the 500 fallback', () => {
  assert.equal(incompleteModuleGuardError({ code: '23514', where: where('x()') }), false);
  assert.equal(incompleteModuleGuardError({ code: '55000', where: 'PL/pgSQL function order_merge_delivery209_inherit(uuid) line 3 at RAISE' }), false);
  assert.equal(incompleteModuleGuardError({ code: '42883' }), false);
  assert.equal(incompleteModuleGuardError(new Error('function public.product_catalog_guards() does not exist')), false);
  assert.equal(incompleteModuleGuardError(null), false);
  assert.equal(incompleteModuleGuardError('55000'), false);
  const hostile = new Proxy({}, { get() { throw new Error('boom'); } });
  assert.equal(incompleteModuleGuardError(hostile), false);
});

test('server/app.ts error handler maps the incomplete-module guard error before the 500 fallback', () => {
  const src = readFileSync(new URL('../server/app.ts', import.meta.url), 'utf8');
  const handler = src.slice(src.indexOf('app.setErrorHandler('), src.indexOf("app.addHook('onRequest'"));
  const use = handler.indexOf('incompleteModuleGuardError(err)');
  assert.ok(use > 0, 'handler does not call incompleteModuleGuardError');
  assert.ok(use < handler.indexOf("'Request failed'"), 'mapping must precede the 500 fallback');
});
