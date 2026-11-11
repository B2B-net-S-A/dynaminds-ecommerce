import assert from 'node:assert/strict';
import test from 'node:test';
import * as m from './automation-v2-model.ts';
import { code128Modules, code128Symbols, CODE128_PATTERNS } from './automation-v2-barcode.ts';
import { catalog } from './automation-v2-fixture.mjs';

const fields = new Map(catalog.fields.map((f) => [f.key, f]));
const F = (k) => fields.get(k);
const leafA = { field: 'order.status', op: 'in', value: ['paid'] };
const leafB = { field: 'shipping.method', op: 'in', value: ['inpost'] };
const leafC = { field: 'order.total', op: 'gte', value: 10000 };
const tree = () => ({ match: 'any', items: [{ match: 'all', items: [leafA, leafB] }, leafC] });

test('condition tree: get/update/remove/append are immutable and path based', () => {
  const t = tree();
  assert.deepEqual(m.getAt(t, [0, 1]), leafB);
  assert.equal(m.getAt(t, [5]), undefined);
  const u = m.updateAt(t, [0, 1], (n) => ({ ...n, value: ['dpd'] }));
  assert.deepEqual(u.items[0].items[1].value, ['dpd']);
  assert.deepEqual(t.items[0].items[1].value, ['inpost'], 'original untouched');
  assert.equal(u.items[1], t.items[1], 'untouched branches shared');
  const r = m.removeAt(t, [0, 0]);
  assert.equal(r.items[0].items.length, 1);
  assert.throws(() => m.removeAt(t, []), /korzenia/);
  const a = m.appendAt(t, [0], leafC);
  assert.equal(a.items[0].items.length, 3);
  assert.throws(() => m.appendAt(t, [1], leafC), /grupy/);
  const g = m.appendAt(t, [], m.newGroup());
  assert.deepEqual(g.items[2], { match: 'all', items: [] });
});

test('condition tree: match toggle, negate and leaf count; prune drops empty nested groups', () => {
  const t = tree();
  assert.equal(m.setMatch(t, [0], 'any').items[0].match, 'any');
  assert.equal(m.toggleNegate(t, [0]).items[0].negate, true);
  assert.equal(m.toggleNegate(m.toggleNegate(t, [0]), [0]).items[0].negate, undefined);
  assert.equal(m.countLeaves(t), 3);
  const withEmpty = { match: 'all', items: [{ match: 'any', items: [{ match: 'all', items: [] }] }, leafA] };
  assert.deepEqual(m.pruneEmptyGroups(withEmpty), { match: 'all', items: [leafA] });
  assert.deepEqual(m.pruneEmptyGroups({ match: 'all', items: [] }), { match: 'all', items: [] }, 'root kept');
});

test('describeTree renders (A i B) lub C and NIE', () => {
  const t = tree();
  const s = m.describeTree(t, fields);
  assert.match(s, /^\(Status zamówienia jest jednym z: Nowe i Metoda dostawy jest jednym z: InPost Paczkomat\) lub Wartość zamówienia ≥ 100,00 zł$/);
  const neg = m.toggleNegate(t, [0]);
  assert.match(m.describeTree(neg, fields), /^NIE \(/);
  assert.equal(m.describeTree({ match: 'all', items: [] }, fields), 'Bez warunków');
});

test('newLeaf picks the first operator and a typed default; per-line fields get quantifier any', () => {
  assert.deepEqual(m.newLeaf(F('order.status')), { field: 'order.status', op: 'in', value: [] });
  assert.deepEqual(m.newLeaf(F('order.total')), { field: 'order.total', op: 'eq', value: null });
  assert.deepEqual(m.newLeaf(F('customer.has_phone')), { field: 'customer.has_phone', op: 'is_true' });
  assert.deepEqual(m.newLeaf(F('product.sku')), { field: 'product.sku', op: 'eq', value: '', quantifier: 'any' });
  assert.deepEqual(m.newLeaf(F('order.created_at')).value, { amount: 1, unit: 'days' });
});

test('withOperator keeps compatible values and resets incompatible shapes', () => {
  const total = { field: 'order.total', op: 'gte', value: 500 };
  assert.equal(m.withOperator(total, F('order.total'), 'lt').value, 500);
  assert.deepEqual(m.withOperator(total, F('order.total'), 'between').value, [500, 500]);
  assert.equal(m.withOperator({ ...total, op: 'between', value: [1, 9] }, F('order.total'), 'eq').value, 1);
  const created = m.newLeaf(F('order.created_at'));
  assert.deepEqual(m.withOperator(created, F('order.created_at'), 'weekday_in').value, []);
  assert.deepEqual(m.withOperator(created, F('order.created_at'), 'hour_between').value, ['08:00', '16:00']);
  assert.deepEqual(m.withOperator(created, F('order.created_at'), 'older_than').value, { amount: 1, unit: 'days' });
  const text = { field: 'customer.email', op: 'contains', value: 'x' };
  assert.equal('value' in m.withOperator(text, F('customer.email'), 'empty'), false);
  assert.equal(m.withOperator(text, F('customer.email'), 'eq').value, 'x');
  assert.throws(() => m.withOperator(text, F('customer.email'), 'gt'), /operator/i);
});

test('validateLeaf: per-type value checks and refusal paths', () => {
  assert.equal(m.validateLeaf(leafA, F('order.status')), null);
  assert.match(m.validateLeaf({ ...leafA, value: [] }, F('order.status')), /co najmniej jedną/);
  assert.match(m.validateLeaf({ ...leafA, value: ['nope'] }, F('order.status')), /nieznan/i);
  assert.match(m.validateLeaf({ field: 'x.y', op: 'eq', value: 'a' }, undefined), /Nieznane pole/);
  assert.match(m.validateLeaf({ ...leafA, op: 'gt' }, F('order.status')), /operator/i);
  assert.match(m.validateLeaf({ field: 'customer.email', op: 'eq', value: '  ' }, F('customer.email')), /Wpisz/);
  assert.equal(m.validateLeaf({ field: 'customer.email', op: 'not_empty' }, F('customer.email')), null);
  assert.match(m.validateLeaf({ field: 'order.total', op: 'eq', value: null }, F('order.total')), /liczb/);
  assert.match(m.validateLeaf({ field: 'order.total', op: 'between', value: [900, 100] }, F('order.total')), /od.*do/);
  assert.equal(m.validateLeaf({ field: 'order.total', op: 'between', value: [100, 900] }, F('order.total')), null);
  const d = F('order.created_at');
  assert.equal(m.validateLeaf({ field: d.key, op: 'newer_than', value: '2026-11-01T10:00:00.000Z' }, d), null);
  assert.match(m.validateLeaf({ field: d.key, op: 'newer_than', value: 'jutro' }, d), /datę/);
  assert.match(m.validateLeaf({ field: d.key, op: 'within_last', value: { amount: 0, unit: 'days' } }, d), /większ/);
  assert.match(m.validateLeaf({ field: d.key, op: 'within_last', value: '2026-11-01T10:00:00.000Z' }, d), /okres/);
  assert.match(m.validateLeaf({ field: d.key, op: 'weekday_in', value: [] }, d), /dzień/);
  assert.match(m.validateLeaf({ field: d.key, op: 'weekday_in', value: [8] }, d), /dzień/);
  assert.match(m.validateLeaf({ field: d.key, op: 'hour_between', value: ['25:00', '10:00'] }, d), /godzin/);
  assert.match(m.validateLeaf({ field: d.key, op: 'between', value: ['2026-11-05T00:00:00.000Z', '2026-11-01T00:00:00.000Z'] }, d), /od.*do/);
  assert.match(m.validateLeaf({ field: 'ghost.field', op: 'eq', value: 'a' }, F('ghost.field')), /nieobsługiwane/);
});

test('validateConditions returns paths of invalid leaves inside nested groups', () => {
  const t = { match: 'all', items: [leafA, { match: 'any', items: [{ ...leafB, value: [] }] }] };
  assert.deepEqual(m.validateConditions(t, fields).map((e) => e.path), [[1, 0]]);
});

test('effects: new effect defaults, reorder, validation of required params', () => {
  const tag = catalog.effects.find((e) => e.type === 'add_tag');
  const status = catalog.effects.find((e) => e.type === 'set_status');
  assert.deepEqual(m.newEffect(tag), { type: 'add_tag', params: {} });
  assert.deepEqual(m.newEffect(catalog.effects.find((e) => e.type === 'email')).params, { attach_invoice: false });
  assert.deepEqual(m.moveItem(['a', 'b', 'c'], 0, 2), ['b', 'c', 'a']);
  assert.deepEqual(m.moveItem(['a', 'b', 'c'], 2, 0), ['c', 'a', 'b']);
  assert.deepEqual(m.moveItem(['a', 'b', 'c'], 1, 9), ['a', 'b', 'c'], 'out of range = unchanged');
  assert.match(m.validateEffect({ type: 'add_tag', params: { tag: ' ' } }, tag), /Tag/);
  assert.equal(m.validateEffect({ type: 'add_tag', params: { tag: 'VIP' } }, tag), null);
  assert.match(m.validateEffect({ type: 'set_status', params: { status: 'zzz' } }, status), /Status/);
  assert.match(m.validateEffect({ type: 'nope', params: {} }, undefined), /Nieznany efekt/);
});

test('rule order: move ids before/after a target', () => {
  assert.deepEqual(m.moveRuleId(['a', 'b', 'c', 'd'], 'd', 'b', 'before'), ['a', 'd', 'b', 'c']);
  assert.deepEqual(m.moveRuleId(['a', 'b', 'c', 'd'], 'a', 'c', 'after'), ['b', 'c', 'a', 'd']);
  assert.deepEqual(m.moveRuleId(['a', 'b'], 'a', 'a', 'after'), ['a', 'b']);
  assert.deepEqual(m.moveRuleId(['a', 'b'], 'x', 'a', 'after'), ['a', 'b']);
});

test('draft serialisation to AutomationRuleInput and validation', () => {
  const d = m.emptyDraft('orders', 'Wysyłka');
  assert.equal(d.trigger, 'order.matches');
  assert.equal(d.config.version, 2);
  assert.equal(d.config.scope, 'orders');
  assert.deepEqual(d.config.conditions, { match: 'all', items: [] });
  const errors = m.validateDraft(d, catalog);
  assert.ok(errors.some((e) => /nazw/i.test(e)));
  assert.ok(errors.some((e) => /efekt/i.test(e)));
  const full = {
    ...d,
    id: 'r1',
    version: 3,
    name: '  W realizacji paczkomat ',
    config: {
      ...d.config,
      group: ' Wysyłka ',
      run: { ...d.config.run, delay_minutes: 5.7, hours: { days: [5, 1, 1], from: '08:00', to: '16:00' } },
      conditions: { match: 'all', items: [leafA, { match: 'any', items: [] }] },
      effects: [{ type: 'add_tag', params: { tag: 'Paczkomat', junk: undefined } }],
    },
  };
  assert.deepEqual(m.validateDraft(full, catalog), []);
  const input = m.toRuleInput(full);
  assert.equal(input.name, 'W realizacji paczkomat');
  assert.equal(input.config.group, 'Wysyłka');
  assert.equal(input.config.run.delay_minutes, 5);
  assert.deepEqual(input.config.run.hours.days, [1, 5]);
  assert.deepEqual(input.config.conditions, { match: 'all', items: [leafA] });
  assert.deepEqual(input.config.effects, [{ type: 'add_tag', params: { tag: 'Paczkomat' } }]);
  assert.equal('id' in input || 'version' in input, false);
  const badHours = { ...full, config: { ...full.config, run: { ...full.config.run, hours: { days: [], from: '10:00', to: '10:00' } } } };
  assert.ok(m.validateDraft(badHours, catalog).some((e) => /godzin|dni/i.test(e)));
});

test('grouped search ignores Polish diacritics and keeps catalog group order', () => {
  const groups = m.groupedSearch(catalog.fields, 'zrodlo', (f) => f.label + ' ' + f.group, (f) => f.group, m.FIELD_GROUPS);
  assert.deepEqual(groups.map((g) => g.group), ['Źródło']);
  const all = m.groupedSearch(catalog.fields, '', (f) => f.label, (f) => f.group, m.FIELD_GROUPS);
  assert.deepEqual(all.map((g) => g.group), ['Zamówienie', 'Źródło', 'Wysyłka', 'Klient', 'Produkty', 'Inne']);
  const opts = F('order.status').options;
  const st = m.groupedSearch(opts, 'realiz', (o) => o.label + ' ' + (o.group ?? ''), (o) => o.group ?? '', []);
  assert.deepEqual(st.map((g) => g.group), ['W realizacji']);
  assert.equal(m.normalizeSearch('ŁÓDŹ Żółć'), 'lodz zolc');
});

test('money helpers convert zł to grosze and back', () => {
  assert.equal(m.zlToGrosze('12,50'), 1250);
  assert.equal(m.zlToGrosze('12.5'), 1250);
  assert.equal(m.zlToGrosze('1 234,99 zł'), 123499);
  assert.equal(m.zlToGrosze(''), null);
  assert.equal(m.zlToGrosze('abc'), null);
  assert.equal(m.groszeToZl(1250), '12,50');
  assert.equal(m.groszeToZl(null), '');
  assert.equal(m.isMoneyField(F('order.total')), true);
  assert.equal(m.isMoneyField(F('order.line_count')), false);
});

test('runSummary and groupRules for the list page', () => {
  const rule = { id: '1', name: 'A', trigger: 'order.matches', enabled: true, priority: 1, version: 1, updated_at: '', barcode: 'R1',
    config: { ...m.emptyDraft('orders', 'Wysyłka').config, run: { auto: true, delay_minutes: 15, mode: 'once', hours: { days: [1, 2, 3, 4, 5], from: '08:00', to: '16:00' }, manual_button: true, barcode: true } } };
  const s = m.runSummary(rule, catalog);
  assert.match(s, /Gdy zamówienie spełni warunki/);
  assert.match(s, /po 15 min/);
  assert.match(s, /jednorazowo/);
  assert.match(s, /Pn–Pt 08:00–16:00/);
  assert.match(s, /przycisk/);
  assert.match(s, /kod kreskowy/);
  const manual = { ...rule, config: { ...rule.config, run: { ...rule.config.run, auto: false, barcode: false, manual_button: false } } };
  assert.match(m.runSummary(manual, catalog), /bez uruchamiania samoczynnego/);
  const groups = m.groupRules([{ ...rule, id: 'x', config: { ...rule.config, group: '' } }, rule, { ...rule, id: 'y' }]);
  assert.deepEqual(groups.map((g) => [g.group, g.rules.map((r) => r.id)]), [['Bez grupy', ['x']], ['Wysyłka', ['1', 'y']]]);
});

test('versionDiff lists added and removed conditions and effects', () => {
  const base = m.toRuleInput({ ...m.emptyDraft('orders', 'G'), name: 'Reguła', config: { ...m.emptyDraft('orders', 'G').config, conditions: { match: 'all', items: [leafA] }, effects: [{ type: 'add_tag', params: { tag: 'A' } }] } });
  const next = { ...base, enabled: false, config: { ...base.config, conditions: { match: 'all', items: [leafB] }, effects: [{ type: 'add_tag', params: { tag: 'A' } }, { type: 'set_status', params: { status: 'paid' } }] } };
  const d = m.versionDiff(base, next, catalog);
  assert.deepEqual(d.conditionsAdded, ['Metoda dostawy jest jednym z: InPost Paczkomat']);
  assert.deepEqual(d.conditionsRemoved, ['Status zamówienia jest jednym z: Nowe']);
  assert.deepEqual(d.effectsAdded, ['Zmień status: Nowe']);
  assert.deepEqual(d.effectsRemoved, []);
  assert.ok(d.other.includes('Aktywna: tak → nie'));
  const created = m.versionDiff(null, base, catalog);
  assert.equal(created.created, true);
});

test('Code128-B: table sanity, checksum and module count', () => {
  assert.equal(CODE128_PATTERNS.length, 107);
  assert.equal(new Set(CODE128_PATTERNS).size, 107);
  CODE128_PATTERNS.forEach((p, i) => assert.equal([...p].reduce((s, c) => s + Number(c), 0), i === 106 ? 13 : 11, 'pattern ' + i));
  assert.deepEqual(code128Symbols('A'), [104, 33, 34, 106]);
  assert.deepEqual(code128Symbols('AR-12'), [104, 33, 50, 13, 17, 18, (104 + 33 + 50 * 2 + 13 * 3 + 17 * 4 + 18 * 5) % 103, 106]);
  const mods = code128Modules('AR-12');
  assert.equal(mods.reduce((s, n) => s + n, 0), 11 * 7 + 13);
  assert.throws(() => code128Symbols('zażółć'), /znak/);
  assert.throws(() => code128Symbols(''), /pusty/);
});

test('runResultText summarises manual run results, including errors and an empty result', () => {
  const run = (status, extra = {}) => ({ id: status, rule_id: 'r', rule_name: 'Paczkomat', order_id: 'o', order_number: 'Z1', source: 'manual', status, reason: null, error: null, created_at: '', ...extra });
  assert.deepEqual(m.runResultText('Paczkomat', [run('done'), run('done'), run('queued')]), { text: '„Paczkomat”: wykonano 2, w kolejce 1', error: false });
  const failed = m.runResultText('Paczkomat', [run('done'), run('failed', { error: 'Brak etykiety', order_number: 'Z9' })]);
  assert.equal(failed.error, true);
  assert.match(failed.text, /błąd 1 .*Z9: Brak etykiety/);
  assert.match(m.runResultText('Paczkomat', [run('skipped', { reason: 'Warunki niespełnione' })]).text, /pominięto 1 .*Warunki niespełnione/);
  assert.deepEqual(m.runResultText('Paczkomat', []), { text: '„Paczkomat”: brak zamówień do uruchomienia', error: true });
});
