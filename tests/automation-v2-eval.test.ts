import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compare, evaluate, inWindow, nextOpening, warsawClock, type OrderContext } from '../server/automation-v2-eval';
import { fieldMeta } from '../server/automation-v2-fields';
import { parseRuleV2, leafProblem } from '../server/automation-v2-schema';
import { DEFAULT_RUN, type ConditionGroup } from '../shared/automation-v2';

// 2026-11-09 is a Monday; 12:00 UTC = 13:00 in Warsaw (CET).
const NOW = Date.parse('2026-11-09T12:00:00Z');
const ctx: OrderContext = {
  order_id: 'o1',
  number: 'N-1',
  values: {
    'order.status': 'paid',
    'order.total': 12500,
    'order.tags': ['VIP', 'Allegro'],
    'order.customer_comment': 'Proszę o szybką wysyłkę',
    'order.internal_note': '',
    'order.created_at': '2026-11-07T12:00:00Z',
    'payment.cod': true,
    'customer.wants_invoice': false,
    'time.now': new Date(NOW).toISOString(),
    'payment.unpaid_for': null,
  },
  lines: [
    { 'product.sku': 'ABC-1', 'product.quantity': 2, 'product.stock_sufficient': true },
    { 'product.sku': 'XYZ-9', 'product.quantity': 5, 'product.stock_sufficient': false },
  ],
  types: { 'order.extra_field.gift': 'text' },
};
const run = (g: ConditionGroup) => evaluate(g, ctx, fieldMeta, NOW);
const leaf = (field: string, op: any, value?: any, quantifier?: 'any' | 'all') => ({ field, op, value, quantifier });

test('list operators in / not_in on scalar and array values', () => {
  assert.equal(compare('list', 'in', 'paid', ['paid', 'new'], NOW), true);
  assert.equal(compare('list', 'in', 'picking', ['paid'], NOW), false);
  assert.equal(compare('list', 'not_in', 'picking', ['paid'], NOW), true);
  assert.equal(compare('list', 'in', ['VIP', 'B2B'], ['B2B'], NOW), true);
  assert.equal(compare('list', 'not_in', ['VIP'], ['B2B'], NOW), true);
  assert.equal(compare('list', 'in', null, ['x'], NOW), false);
  assert.equal(compare('list', 'not_in', null, ['x'], NOW), true);
});

test('text operators are case-insensitive and handle empty values', () => {
  assert.equal(compare('text', 'eq', 'Kurier', 'kurier', NOW), true);
  assert.equal(compare('text', 'neq', 'Kurier', 'poczta', NOW), true);
  assert.equal(compare('text', 'contains', 'Proszę o szybką wysyłkę', 'SZYBK', NOW), true);
  assert.equal(compare('text', 'not_contains', 'Proszę', 'faktura', NOW), true);
  assert.equal(compare('text', 'starts_with', 'ABC-1', 'abc', NOW), true);
  assert.equal(compare('text', 'ends_with', 'ABC-1', '-1', NOW), true);
  assert.equal(compare('text', 'empty', '', undefined, NOW), true);
  assert.equal(compare('text', 'empty', null, undefined, NOW), true);
  assert.equal(compare('text', 'not_empty', 'x', undefined, NOW), true);
  assert.equal(compare('text', 'eq', null, '', NOW), false);
  assert.equal(compare('text', 'contains', null, 'a', NOW), false);
  assert.equal(compare('text', 'neq', null, 'a', NOW), true);
  // An array matches when any element matches; a negation needs all elements to pass.
  assert.equal(compare('text', 'eq', ['a', 'B'], 'b', NOW), true);
  assert.equal(compare('text', 'neq', ['a', 'b'], 'b', NOW), false);
});

test('number operators incl. between and missing values', () => {
  assert.equal(compare('number', 'eq', 100, 100, NOW), true);
  assert.equal(compare('number', 'neq', 100, 99, NOW), true);
  assert.equal(compare('number', 'gt', 100, 99, NOW), true);
  assert.equal(compare('number', 'gte', 100, 100, NOW), true);
  assert.equal(compare('number', 'lt', 100, 101, NOW), true);
  assert.equal(compare('number', 'lte', 100, 100, NOW), true);
  assert.equal(compare('number', 'between', 100, [50, 150], NOW), true);
  assert.equal(compare('number', 'between', 100, [150, 50], NOW), true);
  assert.equal(compare('number', 'between', 200, [50, 150], NOW), false);
  assert.equal(compare('number', 'gt', null, 1, NOW), false);
  assert.equal(compare('number', 'neq', null, 1, NOW), true);
  assert.equal(compare('number', 'eq', '42', 42, NOW), true);
});

test('date operators: absolute, relative, between, within_last, weekday, hour (Europe/Warsaw)', () => {
  const twoDaysAgo = '2026-11-07T12:00:00Z';
  assert.equal(compare('date', 'older_than', twoDaysAgo, { amount: 1, unit: 'days' }, NOW), true);
  assert.equal(compare('date', 'older_than', twoDaysAgo, { amount: 3, unit: 'days' }, NOW), false);
  assert.equal(compare('date', 'newer_than', twoDaysAgo, { amount: 3, unit: 'days' }, NOW), true);
  assert.equal(compare('date', 'newer_than', twoDaysAgo, '2026-11-01T00:00:00Z', NOW), true);
  assert.equal(compare('date', 'older_than', twoDaysAgo, '2026-11-08T00:00:00Z', NOW), true);
  assert.equal(compare('date', 'between', twoDaysAgo, ['2026-11-01T00:00:00Z', '2026-11-08T00:00:00Z'], NOW), true);
  assert.equal(compare('date', 'within_last', twoDaysAgo, { amount: 72, unit: 'hours' }, NOW), true);
  assert.equal(compare('date', 'within_last', twoDaysAgo, { amount: 30, unit: 'minutes' }, NOW), false);
  assert.equal(compare('date', 'weekday_in', new Date(NOW).toISOString(), [1], NOW), true);
  assert.equal(compare('date', 'weekday_in', twoDaysAgo, [6], NOW), true); // Saturday
  assert.equal(compare('date', 'hour_between', new Date(NOW).toISOString(), ['13:00', '14:00'], NOW), true);
  assert.equal(compare('date', 'hour_between', new Date(NOW).toISOString(), ['12:00', '13:00'], NOW), false);
  // Overnight window wraps past midnight: 23:30 Warsaw.
  assert.equal(compare('date', 'hour_between', '2026-11-09T22:30:00Z', ['22:00', '06:00'], NOW), true);
  assert.equal(compare('date', 'older_than', null, { amount: 1, unit: 'days' }, NOW), false);
  assert.equal(compare('date', 'within_last', 'not a date', { amount: 1, unit: 'days' }, NOW), false);
  // Summer time: 2026-07-01 10:30 UTC = 12:30 CEST.
  assert.deepEqual(warsawClock(Date.parse('2026-07-01T10:30:00Z')), { weekday: 3, minutes: 12 * 60 + 30 });
});

test('bool operators', () => {
  assert.equal(compare('bool', 'is_true', true, undefined, NOW), true);
  assert.equal(compare('bool', 'is_false', false, undefined, NOW), true);
  assert.equal(compare('bool', 'is_false', null, undefined, NOW), true);
  assert.equal(compare('bool', 'is_true', null, undefined, NOW), false);
});

test('per-line quantifier any / all', () => {
  assert.equal(run({ match: 'all', items: [leaf('product.sku', 'starts_with', 'ABC')] }).matched, true);
  assert.equal(run({ match: 'all', items: [leaf('product.sku', 'starts_with', 'ABC', 'all')] }).matched, false);
  assert.equal(run({ match: 'all', items: [leaf('product.quantity', 'gte', 2, 'all')] }).matched, true);
  assert.equal(run({ match: 'all', items: [leaf('product.stock_sufficient', 'is_true', undefined, 'all')] }).matched, false);
  assert.equal(run({ match: 'all', items: [leaf('product.stock_sufficient', 'is_false')] }).matched, true);
  const noLines = evaluate({ match: 'all', items: [leaf('product.sku', 'eq', 'A', 'all')] }, { ...ctx, lines: [] }, fieldMeta, NOW);
  assert.equal(noLines.matched, false);
});

test('groups: all / any / negate / nested and per-leaf results', () => {
  const g: ConditionGroup = {
    match: 'all',
    items: [
      leaf('order.status', 'in', ['paid']),
      {
        match: 'any',
        items: [leaf('order.total', 'gt', 100000), leaf('order.tags', 'in', ['VIP'])],
      },
      { match: 'all', negate: true, items: [leaf('payment.cod', 'is_false')] },
    ],
  };
  const r = run(g);
  assert.equal(r.matched, true);
  assert.deepEqual(
    r.conditions.map((c) => [c.path, c.ok]),
    [
      ['root.0', true],
      ['root.1.0', false],
      ['root.1.1', true],
      ['root.2.0', false],
    ],
  );
  assert.equal(run({ ...g, negate: true }).matched, false);
  assert.equal(run({ match: 'any', items: [] }).matched, true);
  assert.equal(run({ match: 'all', items: [leaf('unknown.field', 'eq', 'x')] }).matched, false);
  // Dynamic extra field type from the context.
  const extra = evaluate(
    { match: 'all', items: [leaf('order.extra_field.gift', 'empty')] },
    { ...ctx, values: { ...ctx.values, 'order.extra_field.gift': '' } },
    fieldMeta,
    NOW,
  );
  assert.equal(extra.matched, true);
  // Deep nesting: any(all(negate(any(x)))).
  const deep = run({
    match: 'any',
    items: [{ match: 'all', items: [{ match: 'any', negate: true, items: [leaf('order.status', 'in', ['new'])] }] }],
  });
  assert.equal(deep.matched, true);
});

test('working hours window and next opening (Europe/Warsaw)', () => {
  const hours = { days: [1, 2, 3, 4, 5], from: '08:00', to: '16:00' };
  assert.equal(inWindow(NOW, hours), true);
  assert.equal(inWindow(NOW, null), true);
  // Friday 2026-11-13 17:00 Warsaw -> Monday 2026-11-16 08:00 Warsaw (07:00 UTC).
  const friday = Date.parse('2026-11-13T16:00:00Z');
  assert.equal(new Date(nextOpening(friday, hours)).toISOString(), '2026-11-16T07:00:00.000Z');
  // Monday 06:30 Warsaw -> same day 08:00.
  assert.equal(new Date(nextOpening(Date.parse('2026-11-09T05:30:00Z'), hours)).toISOString(), '2026-11-09T07:00:00.000Z');
  assert.equal(nextOpening(NOW, hours), NOW);
  // Overnight window 22:00-06:00 on Monday: Monday 13:00 -> Monday 22:00 Warsaw (21:00 UTC).
  assert.equal(
    new Date(nextOpening(NOW, { days: [1], from: '22:00', to: '06:00' })).toISOString(),
    '2026-11-09T21:00:00.000Z',
  );
});

test('rule validation: operators per type, values, unknown fields, effects and triggers', () => {
  const base = {
    name: 'Test',
    trigger: 'order.matches',
    enabled: true,
    config: {
      version: 2,
      group: 'Ogólne',
      scope: 'orders',
      run: DEFAULT_RUN,
      conditions: { match: 'all', items: [leaf('order.status', 'in', ['paid'])] },
      effects: [{ type: 'add_tag', params: { tag: 'X' } }],
      stop_further: false,
    },
  };
  assert.ok(parseRuleV2(base, {}).rule);
  const bad = (patch: any) => parseRuleV2({ ...base, config: { ...base.config, ...patch } }, {}).error;
  assert.match(bad({ conditions: { match: 'all', items: [leaf('order.status', 'gt', 1)] } })!, /Operator/);
  assert.match(bad({ conditions: { match: 'all', items: [leaf('order.status', 'in', [])] } })!, /co najmniej jedną/);
  assert.match(bad({ conditions: { match: 'all', items: [leaf('order.nope', 'eq', 'x')] } })!, /Nieznane pole/);
  assert.match(bad({ conditions: { match: 'all', items: [leaf('order.total', 'gt', 'x')] } })!, /liczbę/);
  assert.match(bad({ conditions: { match: 'all', items: [leaf('order.status', 'in', ['paid'], 'all')] } })!, /Kwantyfikator/);
  assert.match(bad({ effects: [] })!, /co najmniej jeden efekt/);
  assert.match(bad({ effects: [{ type: 'teleport', params: {} }] })!, /Nieznany efekt/);
  assert.match(bad({ effects: [{ type: 'assign_warehouse', params: {} }] })!, /niedostępny/);
  assert.match(bad({ run: { ...DEFAULT_RUN, hours: { days: [1], from: '10:00', to: '10:00' } } })!, /różnić/);
  assert.match(bad({ run: { ...DEFAULT_RUN, auto: false } })!, /Włącz/);
  assert.match(parseRuleV2({ ...base, trigger: 'order.teleported' }, {}).error!, /Nieznany wyzwalacz/);
  const deep = { match: 'all', items: [{ match: 'all', items: [{ match: 'all', items: [{ match: 'all', items: [{ match: 'all', items: [] }] }] }] }] };
  assert.match(bad({ conditions: deep })!, /zagnieżdżenia/);
  assert.equal(leafProblem('date', leaf('order.created_at', 'within_last', { amount: 2, unit: 'days' })), null);
  assert.equal(leafProblem('date', leaf('order.created_at', 'hour_between', ['08:00', '25:00'])) !== null, true);
  assert.equal(leafProblem('date', leaf('order.created_at', 'weekday_in', [0])) !== null, true);
  assert.ok(parseRuleV2({ ...base, config: { ...base.config, conditions: { match: 'all', items: [leaf('order.extra_field.gift', 'eq', 'x')] } } }, { 'order.extra_field.gift': 'text' }).rule);
});
