/** Pure interpretation of two same-backend pg_stat_xact function observations.
 * No SQL, IO, database access, or inference that a missing row means zero.
 * Identities are optional display labels, never keys or measurement evidence.
 */

const COUNTER_MAX = 9223372036854775807n;
const ROW_KEYS = ['funcid', 'calls', 'total_time', 'self_time'];

function object(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new TypeError(`${label}: plain object required`);
  }
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string' || !keys.includes(key))) {
    throw new TypeError(`${label}: unexpected field`);
  }
}

function oid(value, label) {
  if (!Number.isInteger(value) || value < 1 || value > 4294967295) {
    throw new TypeError(`${label}: positive PostgreSQL OID required`);
  }
  return value;
}

function time(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || Object.is(value, -0)) {
    throw new TypeError(`${label}: finite nonnegative numeric milliseconds required`);
  }
  return value;
}

function observations(rows, label) {
  if (!Array.isArray(rows)) throw new TypeError(`${label}: array required`);
  const result = new Map();
  for (const row of rows) {
    object(row, ROW_KEYS, label);
    const id = oid(row.funcid, `${label}.funcid`);
    if (result.has(id)) throw new TypeError(`${label}: duplicate OID ${id}`);
    if (typeof row.calls !== 'string' || !/^(0|[1-9][0-9]*)$/.test(row.calls)) {
      throw new TypeError(`${label}.calls: canonical nonnegative decimal text required`);
    }
    const calls = BigInt(row.calls);
    if (calls > COUNTER_MAX) throw new RangeError(`${label}.calls: PostgreSQL int8 overflow`);
    result.set(id, {
      calls,
      total_time: time(row.total_time, `${label}.total_time`),
      self_time: time(row.self_time, `${label}.self_time`),
    });
  }
  return result;
}

function presence(row) {
  return row ? {present: true, calls: row.calls.toString(), total_time: row.total_time, self_time: row.self_time}
    : {present: false, calls: null, total_time: null, self_time: null};
}

function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * Inputs must be observations from one surviving transaction/backend, in time
 * order. This helper cannot prove that provenance. PostgreSQL counts finalized
 * calls, not attempts; failed active frames can be missing, and a partially
 * consumed set-returning function can have time with no finalized call.
 *
 * Options: cancelled:boolean; top:nonnegative safe integer; identities: separate
 * [{funcid, identity:string}] labels resolved after the measurement read.
 * For either missing observation delta is null, not a zero-based estimate.
 */
export function diffFunctionRuntimeProfile(before, after, options = {}) {
  object(options, ['cancelled', 'top', 'identities'], 'options');
  const {cancelled = false, top = 10, identities = []} = options;
  if (typeof cancelled !== 'boolean') throw new TypeError('cancelled: boolean required');
  if (!Number.isSafeInteger(top) || top < 0) throw new TypeError('top: nonnegative safe integer required');
  const first = observations(before, 'before');
  const last = observations(after, 'after');
  const rows = [...new Set([...first.keys(), ...last.keys()])].sort((a, b) => a - b).map(funcid => {
    const a = first.get(funcid);
    const b = last.get(funcid);
    let delta = null;
    if (a && b) {
      if (b.calls < a.calls || b.total_time < a.total_time || b.self_time < a.self_time) {
        throw new RangeError(`OID ${funcid}: counter moved backwards`);
      }
      delta = {calls: (b.calls - a.calls).toString(), total_time: b.total_time - a.total_time,
        self_time: b.self_time - a.self_time};
    }
    return {funcid, identity: null, presence: a ? (b ? 'both' : 'before_only') : 'after_only',
      before: presence(a), after: presence(b), delta};
  });

  // Attach labels only after observation validation and OID-qualified diff.
  if (!Array.isArray(identities)) throw new TypeError('identities: array required');
  const labels = new Map();
  for (const label of identities) {
    object(label, ['funcid', 'identity'], 'identity');
    const id = oid(label.funcid, 'identity.funcid');
    if (labels.has(id)) throw new TypeError(`identity: duplicate OID ${id}`);
    if (typeof label.identity !== 'string' || label.identity.trim() !== label.identity || !label.identity
        || /[\u0000-\u001f\u007f]/u.test(label.identity)) {
      throw new TypeError('identity: nonempty single-line display text required');
    }
    labels.set(id, label.identity);
  }
  for (const row of rows) row.identity = labels.get(row.funcid) ?? null;
  const ranked = key => rows.filter(row => row.delta !== null)
    .sort((a, b) => b.delta[key] - a.delta[key] || a.funcid - b.funcid)
    .slice(0, top)
    .map(row => ({funcid: row.funcid, identity: row.identity, ...row.delta}));
  // These are reported AFTER observations, not inferred increments. They can
  // include earlier work in the transaction; missing before stays unknown.
  const observedAfter = key => rows.filter(row => row.after.present)
    .sort((a, b) => b.after[key] - a.after[key] || a.funcid - b.funcid)
    .slice(0, top)
    .map(row => ({funcid: row.funcid, identity: row.identity, before_present: row.before.present,
      delta: row.delta, calls: row.after.calls, total_time: row.after.total_time, self_time: row.after.self_time}));
  const unknown = rows.filter(row => row.delta === null).length;
  return freeze({
    schema: 'function-runtime-profile/v1',
    units: {time: 'milliseconds', calls: 'decimal_string'},
    flags: {cancelled, cancelled_result_unknown: cancelled, incomplete: cancelled || unknown > 0,
      tracked_function_usage_only: true, complete_call_tree: false,
      missing_rows_are_not_zero: true, calls_are_not_attempts: true,
      total_time_is_inclusive: true, rankings_are_not_additive: true,
      after_rankings_are_cumulative_observations: true, after_rankings_are_incremental: false,
      performance_acceptance: false, native_acceptance: false},
    counts: {observed_oids: rows.length, comparable_oids: rows.length - unknown, unknown_delta_oids: unknown},
    rows, top_self: ranked('self_time'), top_total: ranked('total_time'),
    observed_after_top_self: observedAfter('self_time'), observed_after_top_total: observedAfter('total_time'),
    limitations: [
      'Same transaction/backend provenance and before/after ordering must be established by the caller.',
      'Absent observations do not prove zero calls or no execution; their deltas remain unknown.',
      'Calls count finalized invocations, not attempts; active failed/cancelled frames can be unreported.',
      'Set-returning partial invocations can accrue time without a finalized call.',
      'Inlined or otherwise untracked functions are absent; tracking itself adds overhead.',
      'Inclusive total times overlap; neither ranking is a complete wall-clock accounting.',
      'Observed-after rankings report cumulative observations, including earlier transaction work; they are not deltas.',
      'A cancelled invocation has unknown logical result; these measurements certify no acceptance gate.',
    ],
  });
}
