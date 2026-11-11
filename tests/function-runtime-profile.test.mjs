import test from 'node:test';
import assert from 'node:assert/strict';
import {diffFunctionRuntimeProfile as profile} from '../tools/parity/function-runtime-profile.mjs';

const row = (funcid, calls = '0', total_time = 0, self_time = 0) => ({funcid, calls, total_time, self_time});

test('incremental costs separate a slow parent from costly children without adding inclusive totals', () => {
  const before = [row(12, '4', 80, 10), row(11, '20', 30, 20), row(13)];
  const after = [row(13, '0', 0.5, 0.5), row(11, '27', 80, 60), row(12, '5', 180, 15)];
  const result = profile(before, after, {top: 2});
  assert.deepEqual(result.rows.map(r => [r.funcid, r.delta]), [
    [11, {calls: '7', total_time: 50, self_time: 40}],
    [12, {calls: '1', total_time: 100, self_time: 5}],
    [13, {calls: '0', total_time: 0.5, self_time: 0.5}],
  ]);
  assert.deepEqual(result.top_self.map(r => r.funcid), [11, 12]);
  assert.deepEqual(result.top_total.map(r => r.funcid), [12, 11]);
  assert.equal(result.flags.total_time_is_inclusive, true);
  assert.equal(result.flags.rankings_are_not_additive, true);
  assert.equal(result.flags.performance_acceptance, false);
  assert.equal(result.flags.native_acceptance, false);
});

test('row absence stays unknown while a present zero row stays measured zero after cancellation', () => {
  const result = profile([row(1), row(2, '7', 2, 1)], [row(3, '11', 3, 2), row(1)], {cancelled: true});
  assert.deepEqual(result.rows.map(r => [r.funcid, r.presence, r.delta]), [
    [1, 'both', {calls: '0', total_time: 0, self_time: 0}], [2, 'before_only', null], [3, 'after_only', null],
  ]);
  assert.deepEqual(result.rows[2].before, {present: false, calls: null, total_time: null, self_time: null});
  assert.equal(result.rows[1].after.present, false);
  assert.equal(result.rows[2].after.calls, '11');
  assert.deepEqual(result.counts, {observed_oids: 3, comparable_oids: 1, unknown_delta_oids: 2});
  assert.deepEqual(result.top_self.map(r => r.funcid), [1]);
  assert.equal(result.flags.cancelled_result_unknown, true);
  assert.equal(result.flags.incomplete, true);
  assert.equal(result.flags.complete_call_tree, false);
  assert.equal(result.flags.missing_rows_are_not_zero, true);
});

test('calls beyond Number precision retain exact differences and JSON-safe strings', () => {
  const result = profile([row(42, '9007199254740993')], [row(42, '9007199254741000', 1, 1)]);
  assert.equal(result.rows[0].before.calls, '9007199254740993');
  assert.equal(result.rows[0].delta.calls, '7');
  assert.equal(result.top_total[0].calls, '7');
  assert.doesNotThrow(() => JSON.stringify(result));
  assert.equal(profile([row(1, '9223372036854775806')], [row(1, '9223372036854775807')]).rows[0].delta.calls, '1');
});

test('initially untracked baseline can rank observed completed children without inventing incremental costs', () => {
  const result = profile([], [row(50, '1', 100, 4), row(51, '11', 65, 60), row(52, '0', 0, 0)], {
    cancelled: true, identities: [{funcid: 51, identity: 'public.completed_leaf()'}],
  });
  assert.deepEqual(result.top_self, []);
  assert.deepEqual(result.top_total, []);
  assert.deepEqual(result.observed_after_top_self.map(r => r.funcid), [51, 50, 52]);
  assert.deepEqual(result.observed_after_top_total.map(r => r.funcid), [50, 51, 52]);
  assert.deepEqual(result.observed_after_top_self[0], {funcid: 51, identity: 'public.completed_leaf()',
    before_present: false, delta: null, calls: '11', total_time: 65, self_time: 60});
  assert(result.rows.every(r => r.delta === null));
  assert.equal(result.observed_after_top_self[2].calls, '0');
  assert.equal(result.flags.after_rankings_are_cumulative_observations, true);
  assert.equal(result.flags.after_rankings_are_incremental, false);
  assert.equal(result.flags.incomplete, true);
  assert.equal(result.flags.performance_acceptance, false);
});

test('cumulative observations rank earlier work separately from the measured interval', () => {
  const result = profile([row(1, '100', 1000, 900), row(2)], [row(2, '1', 30, 20), row(1, '101', 1005, 901)], {top: 1});
  assert.deepEqual(result.top_self.map(r => r.funcid), [2]);
  assert.deepEqual(result.top_total.map(r => r.funcid), [2]);
  assert.deepEqual(result.observed_after_top_self.map(r => r.funcid), [1]);
  assert.deepEqual(result.observed_after_top_total.map(r => r.funcid), [1]);
  assert.deepEqual(result.observed_after_top_self[0], {funcid: 1, identity: null, before_present: true,
    delta: {calls: '1', total_time: 5, self_time: 1}, calls: '101', total_time: 1005, self_time: 901});
  assert.deepEqual(profile([], [row(1)], {top: 0}).observed_after_top_self, []);
});

test('OID ordering and tied rankings are deterministic independent of input or labels', () => {
  const before = [row(30), row(2), row(17)];
  const after = [row(17, '1', 4, 4), row(30, '1', 4, 4), row(2, '1', 4, 4)];
  const a = profile(before, after);
  const b = profile([...before].reverse(), [...after].reverse(), {identities: [
    {funcid: 30, identity: 'z.same(integer)'}, {funcid: 2, identity: 'z.same(text)'},
    {funcid: 17, identity: 'a.same()'}, {funcid: 99, identity: 'unused.function()'},
  ]});
  assert.deepEqual(a.rows.map(r => r.funcid), [2, 17, 30]);
  for (const key of ['top_self', 'top_total']) assert.deepEqual(b[key].map(r => r.funcid), [2, 17, 30]);
  assert.equal(b.rows[0].identity, 'z.same(text)');
  assert.deepEqual(b.rows.map(r => r.delta), a.rows.map(r => r.delta));
  assert.deepEqual(profile(before, after, {top: 0}).top_total, []);
});

test('frozen inputs are unchanged and returned labels and observations are detached', () => {
  const before = [row(1)];
  const after = [row(1, '2', 3, 1)];
  const options = {identities: [{funcid: 1, identity: 'public.f()'}]};
  const snapshot = structuredClone({before, after, options});
  for (const list of [before, after, options.identities]) {for (const r of list) Object.freeze(r); Object.freeze(list);}
  Object.freeze(options);
  const result = profile(before, after, options);
  assert.deepEqual({before, after, options}, snapshot);
  assert(Object.isFrozen(result));
  assert(Object.isFrozen(result.rows[0].delta));
  assert.throws(() => {result.rows[0].after.calls = '9';}, TypeError);
  assert.equal(after[0].calls, '2');
});

test('counter regression rejects reset, wrong backend or reversed observations instead of fabricating deltas', () => {
  for (const after of [row(1, '6', 10, 8), row(1, '7', 9, 8), row(1, '7', 10, 7)]) {
    assert.throws(() => profile([row(1, '7', 10, 8)], [after]), /counter moved backwards/);
  }
});

test('reject malformed observations, duplicate OIDs and unsafe numeric counters', () => {
  const invalid = [null, {}, [], row(0), row(-1), row(1.5), row(4294967296), row('1'),
    row(1, 1), row(1, 1n), row(1, ''), row(1, '-1'), row(1, '+1'), row(1, '01'), row(1, '1.0'),
    row(1, '1e3'), row(1, ' 1'), row(1, '9223372036854775808'),
    row(1, '0', NaN), row(1, '0', Infinity), row(1, '0', -1), row(1, '0', -0),
    row(1, '0', '1'), row(1, '0', 1, -1), row(1, '0', 1, null), {...row(1), extra: true}];
  for (const candidate of invalid) {
    assert.throws(() => profile([candidate], []));
    assert.throws(() => profile([], [candidate]));
  }
  for (const invalidArray of [null, {}, '[]']) assert.throws(() => profile(invalidArray, []));
  assert.throws(() => profile([row(1), row(1)], []), /duplicate OID/);
  assert.throws(() => profile([], [row(1), row(1)]), /duplicate OID/);
});

test('labels and options are validated separately and cannot silently change measurement interpretation', () => {
  const badOptions = [null, [], {cancelled: 'true'}, {top: -1}, {top: 1.5}, {top: Infinity}, {top: '1'},
    {extra: true}, {identities: {}}, {identities: [null]}, {identities: [{funcid: 1, identity: ''}]},
    {identities: [{funcid: 1, identity: ' f()'}]}, {identities: [{funcid: 1, identity: 'f()\n'}]},
    {identities: [{funcid: 1, identity: 1}]}, {identities: [{funcid: 0, identity: 'f()'}]},
    {identities: [{funcid: 1, identity: 'f()'}, {funcid: 1, identity: 'g()'}]},
    {identities: [{funcid: 1, identity: 'f()', calls: '999'}]}];
  for (const options of badOptions) assert.throws(() => profile([], [], options));
  // Unknown labels do not invent observations; a known label is not a new key.
  assert.deepEqual(profile([], [], {identities: [{funcid: 9, identity: 'public.f()'}]}).rows, []);
});

test('empty observations remain a bounded report, never a logical result or acceptance', () => {
  const result = profile([], [], {cancelled: true});
  assert.deepEqual(result.rows, []);
  assert.deepEqual(result.top_self, []);
  assert.deepEqual(result.top_total, []);
  assert.deepEqual(result.observed_after_top_self, []);
  assert.deepEqual(result.observed_after_top_total, []);
  assert.equal(result.flags.incomplete, true);
  assert.equal(result.flags.cancelled_result_unknown, true);
  assert.equal(result.flags.native_acceptance, false);
});
