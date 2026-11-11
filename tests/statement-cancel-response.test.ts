/** PostgreSQL 57014 (query_canceled) is a transient refusal, not an unexpected server error.
 * Load run full-20261028-01: a statement timeout in prepareAutomaticWzInTx
 * (wz_issuer239_prepare_skip) came back as 500 "Nieoczekiwany błąd serwera".
 * The transaction rolled back, so the response is 503 with a Polish retry hint and no SQL.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { statementCancelResponse } from '../server/statement-cancel';

const pgError = (message: string, extra: Record<string, unknown> = {}) =>
  Object.assign(new Error(message), { code: '57014', ...extra });

test('statement timeout maps to 503 with a retry hint and without SQL', () => {
  const r = statementCancelResponse(pgError('canceling statement due to statement timeout', {
    where: 'SQL statement "SELECT wz_issuer239_prepare_skip($1)"' }));
  assert.deepEqual(r, { status: 503, reason: 'statement_timeout',
    detail: 'Operacja trwała zbyt długo. Spróbuj ponownie za chwilę.' });
  assert.doesNotMatch(r!.detail, /SELECT|wz_issuer|statement/i);
});

test('cancel request (pg_cancel_backend) is also 503 but says the operation was interrupted', () => {
  const r = statementCancelResponse(pgError('canceling statement due to user request'));
  assert.deepEqual(r, { status: 503, reason: 'cancel_request',
    detail: 'Operacja została przerwana na serwerze. Spróbuj ponownie za chwilę.' });
});

test('other errors and odd values are not classified', () => {
  assert.equal(statementCancelResponse(Object.assign(new Error('x'), { code: '23505' })), null);
  assert.equal(statementCancelResponse(new Error('canceling statement due to statement timeout')), null);
  assert.equal(statementCancelResponse(null), null);
  assert.equal(statementCancelResponse('57014'), null);
  const hostile = new Proxy({}, { get() { throw new Error('boom'); } });
  assert.equal(statementCancelResponse(hostile), null);
});

test('server/app.ts error handler uses the 57014 mapping before the 500 fallback', () => {
  const src = readFileSync(new URL('../server/app.ts', import.meta.url), 'utf8');
  const handler = src.slice(src.indexOf('app.setErrorHandler('), src.indexOf("app.addHook('onRequest'"));
  const use = handler.indexOf('statementCancelResponse(err)');
  assert.ok(use > 0, 'handler does not call statementCancelResponse');
  assert.ok(use < handler.indexOf("'Request failed'"), 'mapping must precede the 500 fallback');
});
