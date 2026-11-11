/** B2B-007 (migration 246, prepared as placeholder 254): the pure trade-credit rules. Exact to the grosz, refusals before any charge.
 * No database; the transactional behaviour is in tests/b2b-trade-credit246.database.test.ts. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  tradeCreditLineInput,
  tradeCreditDecision,
  tradeCreditDueAt,
  tradeCreditSummary,
  parseMinorAmount,
} from '../server/b2b-trade-credit-model';

const line = { currency: 'PLN', limit_minor: 100000, term_days: 14, active: true };

test('a line: currency, limit in grosze, term in days, version for a change, explicit confirmation', () => {
  const ok = tradeCreditLineInput.parse({ currency: 'PLN', limit_minor: 100000, term_days: 30, active: true, version: 0, confirmed: true });
  assert.deepEqual(ok, { currency: 'PLN', limit_minor: 100000, term_days: 30, active: true, version: 0, confirmed: true });
  assert.equal(tradeCreditLineInput.parse({ ...ok, limit_minor: 0 }).limit_minor, 0, 'a zero limit is a valid stop');
  assert.equal(tradeCreditLineInput.parse({ ...ok, limit_minor: 100000000000 }).limit_minor, 100000000000);
  for (const bad of [
    { limit_minor: -1 }, { limit_minor: 100000000001 }, { limit_minor: 10.5 }, { limit_minor: '1000' },
    { term_days: 0 }, { term_days: 366 }, { term_days: 1.5 }, { currency: 'pln' }, { currency: 'JPY' },
    { confirmed: false }, { version: -1 }, { extra: 1 },
  ]) assert.equal(tradeCreditLineInput.safeParse({ ...ok, ...bad }).success, false, JSON.stringify(bad));
});

test('the decision admits exactly up to the limit and refuses one grosz more', () => {
  assert.deepEqual(tradeCreditDecision({ line, exposure: 60000, overdue: 0, amount: 40000, currency: 'PLN' }), { ok: true, charge: true, available_after: 0 });
  const over = tradeCreditDecision({ line, exposure: 60000, overdue: 0, amount: 40001, currency: 'PLN' });
  assert.equal(over.ok, false);
  assert.equal(over.ok === false && over.status, 409);
  assert.equal(over.ok === false && over.code, 'TRADE_CREDIT_LIMIT');
  assert.match(over.ok === false ? over.message : '', /400,00/, 'the free amount is shown in złoty');
  assert.deepEqual(tradeCreditDecision({ line, exposure: 0, overdue: 0, amount: 1, currency: 'PLN' }), { ok: true, charge: true, available_after: 99999 });
});

test('refusals: other currency, an overdue balance, a zero limit; nothing to charge for a zero order', () => {
  const currency = tradeCreditDecision({ line, exposure: 0, overdue: 0, amount: 100, currency: 'EUR' });
  assert.equal(currency.ok === false && currency.code, 'TRADE_CREDIT_CURRENCY');
  const overdue = tradeCreditDecision({ line, exposure: 5000, overdue: 1, amount: 100, currency: 'PLN' });
  assert.equal(overdue.ok === false && overdue.code, 'TRADE_CREDIT_OVERDUE', 'one grosz after the term blocks');
  const zero = tradeCreditDecision({ line: { ...line, limit_minor: 0 }, exposure: 0, overdue: 0, amount: 1, currency: 'PLN' });
  assert.equal(zero.ok === false && zero.code, 'TRADE_CREDIT_LIMIT');
  assert.deepEqual(tradeCreditDecision({ line, exposure: 100000, overdue: 0, amount: 0, currency: 'PLN' }), { ok: true, charge: false, available_after: 0 });
  // The overdue check precedes the limit: an account over its term is refused even for a small order.
  const both = tradeCreditDecision({ line, exposure: 100000, overdue: 100, amount: 1, currency: 'PLN' });
  assert.equal(both.ok === false && both.code, 'TRADE_CREDIT_OVERDUE');
  assert.throws(() => tradeCreditDecision({ line, exposure: -1, overdue: 0, amount: 1, currency: 'PLN' }));
  assert.throws(() => tradeCreditDecision({ line, exposure: 0.5, overdue: 0, amount: 1, currency: 'PLN' }));
});

test('the due date is the checkout instant plus whole days; overdue only after it', () => {
  const at = new Date('2026-10-27T23:30:00.000Z');
  assert.equal(tradeCreditDueAt(at, 14).toISOString(), '2026-11-10T23:30:00.000Z');
  assert.equal(tradeCreditDueAt(new Date('2026-03-28T12:00:00.000Z'), 1).toISOString(), '2026-03-29T12:00:00.000Z', 'DST does not move the instant');
  assert.throws(() => tradeCreditDueAt(at, 0));
});

test('the summary: exposure is the sum of open balances, available never negative, overdue after the due instant', () => {
  const now = new Date('2026-11-01T00:00:00.000Z');
  const s = tradeCreditSummary(line, [
    { order_id: 'a', amount_due: 30000, due_at: new Date('2026-10-31T23:59:59.999Z') },
    { order_id: 'b', amount_due: 0, due_at: new Date('2026-10-01T00:00:00.000Z') },
    { order_id: 'c', amount_due: 12345, due_at: new Date('2026-11-01T00:00:00.000Z') },
  ], now);
  assert.deepEqual(s, {
    currency: 'PLN', limit_minor: 100000, term_days: 14, active: true,
    exposure_minor: 42345, available_minor: 57655, overdue_minor: 30000, overdue_orders: 1, open_orders: 2,
  });
  const over = tradeCreditSummary({ ...line, limit_minor: 40000 }, [{ order_id: 'a', amount_due: 42345, due_at: new Date('2026-12-01T00:00:00Z') }], now);
  assert.equal(over.available_minor, 0);
  assert.equal(over.exposure_minor, 42345);
});

test('amounts typed in złoty become grosze exactly (UI and API share the parser)', () => {
  assert.equal(parseMinorAmount('1000'), 100000);
  assert.equal(parseMinorAmount('1000,5'), 100050);
  assert.equal(parseMinorAmount('0.01'), 1);
  assert.equal(parseMinorAmount(' 12 345,67 '), 1234567);
  assert.equal(parseMinorAmount('1000000000'), 100000000000);
  for (const bad of ['', '-1', '1,234', '1.2.3', 'abc', '1e3', '1000000000,01']) assert.throws(() => parseMinorAmount(bad), bad);
});
