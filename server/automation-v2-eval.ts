/**
 * Automation rules v2: pure condition evaluation and Europe/Warsaw time helpers (shared/automation-v2.ts).
 * No database access here; server/automation-v2-context.ts builds the OrderContext.
 */
import type {
  ConditionGroup,
  ConditionLeaf,
  ConditionValue,
  Operator,
  RunSettings,
  ValueType,
} from '../shared/automation-v2';

export const ZONE = 'Europe/Warsaw';

/** Field values of one order. Per-line fields live in `lines` (one record per order line). */
export interface OrderContext {
  order_id: string;
  number: string;
  values: Record<string, unknown>;
  lines: Array<Record<string, unknown>>;
  /** Value types of dynamic fields (order.extra_field.<key>). */
  types?: Record<string, ValueType>;
}

export interface FieldMeta {
  type: ValueType;
  per_line?: boolean;
}

export interface LeafResult {
  path: string;
  field: string;
  ok: boolean;
  actual: unknown;
}

export interface EvalResult {
  matched: boolean;
  conditions: LeafResult[];
}

const isGroup = (item: ConditionLeaf | ConditionGroup): item is ConditionGroup =>
  typeof (item as ConditionGroup).match === 'string' && Array.isArray((item as ConditionGroup).items);

const UNIT_MS = { minutes: 60_000, hours: 3_600_000, days: 86_400_000 } as const;

type Relative = { amount: number; unit: 'minutes' | 'hours' | 'days' };
const isRelative = (v: unknown): v is Relative =>
  !!v && typeof v === 'object' && !Array.isArray(v) && typeof (v as Relative).amount === 'number' &&
  (v as Relative).unit in UNIT_MS;

const empty = (v: unknown) =>
  v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);

const fold = (v: unknown) => String(v ?? '').trim().toLocaleLowerCase('pl-PL');

function time(v: unknown): number | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.getTime();
  if (typeof v === 'string' || typeof v === 'number') {
    const t = new Date(v).getTime();
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

const parts = new Intl.DateTimeFormat('en-GB', {
  timeZone: ZONE,
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});
const WEEKDAYS: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

/** Weekday (Monday = 1) and minutes after local midnight in Europe/Warsaw. */
export function warsawClock(t: number): { weekday: number; minutes: number } {
  const p = Object.fromEntries(parts.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return { weekday: WEEKDAYS[p.weekday], minutes: Number(p.hour) * 60 + Number(p.minute) };
}

export function hhmm(v: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(v);
  if (!m) return NaN;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** from inclusive, to exclusive; from > to wraps past midnight. */
function minutesBetween(minutes: number, from: number, to: number) {
  return from <= to ? minutes >= from && minutes < to : minutes >= from || minutes < to;
}

function compareNumber(op: Operator, actual: unknown, value: ConditionValue | undefined): boolean {
  const a = typeof actual === 'number' ? actual : typeof actual === 'string' && actual !== '' ? Number(actual) : NaN;
  if (op === 'neq') return Number.isNaN(a) || a !== Number(value);
  if (Number.isNaN(a)) return false;
  if (op === 'between') {
    if (!Array.isArray(value) || value.length !== 2) return false;
    const [lo, hi] = (value as number[]).map(Number);
    return a >= Math.min(lo, hi) && a <= Math.max(lo, hi);
  }
  const v = Number(value);
  if (Number.isNaN(v)) return false;
  return op === 'eq' ? a === v : op === 'gt' ? a > v : op === 'gte' ? a >= v : op === 'lt' ? a < v : op === 'lte' ? a <= v : false;
}

function compareText(op: Operator, actual: unknown, value: ConditionValue | undefined): boolean {
  if (op === 'empty') return empty(actual);
  if (op === 'not_empty') return !empty(actual);
  // A list value (tags, SKUs) matches when any element matches; negations need every element to pass.
  if (Array.isArray(actual)) {
    if (['neq', 'not_contains'].includes(op)) return actual.every((x) => compareText(op, x, value));
    return actual.some((x) => compareText(op, x, value));
  }
  const a = fold(actual),
    v = fold(value);
  if (op === 'eq') return !empty(actual) && a === v;
  if (op === 'neq') return a !== v;
  if (op === 'contains') return !empty(actual) && a.includes(v);
  if (op === 'not_contains') return !a.includes(v) || v === '';
  if (op === 'starts_with') return !empty(actual) && a.startsWith(v);
  if (op === 'ends_with') return !empty(actual) && a.endsWith(v);
  return false;
}

function compareList(op: Operator, actual: unknown, value: ConditionValue | undefined): boolean {
  const wanted = new Set((Array.isArray(value) ? value : value === null || value === undefined ? [] : [value]).map(String));
  const have = (Array.isArray(actual) ? actual : empty(actual) ? [] : [actual]).map(String);
  const hit = have.some((x) => wanted.has(x));
  return op === 'in' ? hit : op === 'not_in' ? !hit : false;
}

function compareDate(op: Operator, actual: unknown, value: ConditionValue | undefined, now: number): boolean {
  const a = time(actual);
  if (a === null) return false;
  if (op === 'weekday_in')
    return Array.isArray(value) && (value as unknown[]).map(Number).includes(warsawClock(a).weekday);
  if (op === 'hour_between') {
    if (!Array.isArray(value) || value.length !== 2) return false;
    const from = hhmm(String(value[0])),
      to = hhmm(String(value[1]));
    if (Number.isNaN(from) || Number.isNaN(to)) return false;
    return minutesBetween(warsawClock(a).minutes, from, to);
  }
  if (op === 'between') {
    if (!Array.isArray(value) || value.length !== 2) return false;
    const lo = time(value[0]),
      hi = time(value[1]);
    if (lo === null || hi === null) return false;
    return a >= Math.min(lo, hi) && a <= Math.max(lo, hi);
  }
  if (op === 'within_last') {
    if (!isRelative(value)) return false;
    return a >= now - value.amount * UNIT_MS[value.unit] && a <= now;
  }
  if (op === 'newer_than' || op === 'older_than') {
    // Relative age ("starsza niż 2 dni") or an absolute moment.
    const bound = isRelative(value) ? now - value.amount * UNIT_MS[value.unit] : time(value);
    if (bound === null) return false;
    return op === 'newer_than' ? a > bound : a < bound;
  }
  return false;
}

export function compare(type: ValueType, op: Operator, actual: unknown, value: ConditionValue | undefined, now: number): boolean {
  if (type === 'bool') return op === 'is_true' ? actual === true : op === 'is_false' ? actual !== true : false;
  // A rule saved while the field was text (site, operator, parcel size) keeps its text operator.
  if (type === 'list') return op === 'in' || op === 'not_in' ? compareList(op, actual, value) : compareText(op, actual, value);
  if (type === 'number') return compareNumber(op, actual, value);
  if (type === 'date') return compareDate(op, actual, value, now);
  return compareText(op, actual, value);
}

/**
 * Evaluates a condition tree. Every leaf is evaluated (no short-circuit) so the test view can show each result.
 * Unknown fields never match.
 */
export function evaluate(
  group: ConditionGroup,
  ctx: OrderContext,
  meta: (key: string) => FieldMeta | undefined,
  now: number = Date.now(),
): EvalResult {
  const conditions: LeafResult[] = [];
  const walk = (g: ConditionGroup, path: string): boolean => {
    const results = g.items.map((item, i) => {
      const p = `${path}.${i}`;
      if (isGroup(item)) return walk(item, p);
      const m = meta(item.field) ?? (ctx.types?.[item.field] ? { type: ctx.types[item.field] } : undefined);
      if (!m) {
        conditions.push({ path: p, field: item.field, ok: false, actual: null });
        return false;
      }
      if (m.per_line) {
        const values = ctx.lines.map((l) => l[item.field]);
        const each = values.map((v) => compare(m.type, item.op, v, item.value, now));
        const ok = item.quantifier === 'all' ? each.length > 0 && each.every(Boolean) : each.some(Boolean);
        conditions.push({ path: p, field: item.field, ok, actual: values });
        return ok;
      }
      const actual = ctx.values[item.field];
      const ok = compare(m.type, item.op, actual, item.value, now);
      conditions.push({ path: p, field: item.field, ok, actual: actual === undefined ? null : actual });
      return ok;
    });
    // An empty group places no restriction.
    const raw = results.length === 0 ? true : g.match === 'any' ? results.some(Boolean) : results.every(Boolean);
    return g.negate ? !raw : raw;
  };
  const matched = walk(group, 'root');
  return { matched, conditions };
}

/** True when `t` lies in the working-hours window (Europe/Warsaw). */
export function inWindow(t: number, hours: RunSettings['hours']): boolean {
  if (!hours) return true;
  const c = warsawClock(t);
  return hours.days.includes(c.weekday) && minutesBetween(c.minutes, hhmm(hours.from), hhmm(hours.to));
}

/** The first moment at or after `t` inside the working-hours window; `t` itself when there is no window. */
export function nextOpening(t: number, hours: RunSettings['hours']): number {
  if (!hours || !hours.days.length) return t;
  const from = hhmm(hours.from);
  let at = t;
  for (let i = 0; i < 40; i++) {
    if (inWindow(at, hours)) return at;
    const c = warsawClock(at);
    const step = hours.days.includes(c.weekday) && c.minutes < from ? from - c.minutes : 1440 - c.minutes;
    // Align to the whole minute, then jump; a DST change is corrected by the next iteration.
    at = Math.floor(at / 60_000) * 60_000 + step * 60_000;
  }
  return at;
}
