/** Calendar periods of the analytics reports (S7), always in Europe/Warsaw.
 * The database groups facts by the Warsaw calendar day (`created_at AT TIME ZONE
 * 'Europe/Warsaw'`); this module folds those days into day/week/month buckets and
 * gives every bucket its exact UTC boundaries, so a 23-hour (last Sunday of March)
 * or 25-hour (last Sunday of October) day is one bucket with correct instants.
 * Pure: no database, no clock. */

export type Granularity = 'day' | 'week' | 'month';
export const REPORT_TIME_ZONE = 'Europe/Warsaw';

const dayPattern = /^\d{4}-\d{2}-\d{2}$/;
const wall = new Intl.DateTimeFormat('en-CA', {
  timeZone: REPORT_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});
function wallParts(t: number) {
  const p = Object.fromEntries(wall.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return {
    day: `${p.year}-${p.month}-${p.day}`,
    utc: Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second),
  };
}
const offsetAt = (t: number) => wallParts(t).utc - (t - (t % 1000));

/** Warsaw calendar day of an instant (YYYY-MM-DD). */
export function warsawDay(instant: Date | string): string {
  const t = new Date(instant).getTime();
  if (!Number.isFinite(t)) throw new Error('Niepoprawna chwila');
  return wallParts(t).day;
}

function assertDay(day: string) {
  if (!dayPattern.test(day) || new Date(day + 'T00:00:00Z').toISOString().slice(0, 10) !== day)
    throw new Error('Niepoprawna data kalendarzowa');
}

/** UTC instant (ISO) of 00:00 Warsaw time on the given day. Midnight never falls into
 * the DST gap in Poland (changes at 02:00/03:00), so the result is always unique. */
export function warsawMidnightUtc(day: string): string {
  assertDay(day);
  const guess = Date.parse(day + 'T00:00:00Z');
  let t = guess - offsetAt(guess);
  t = guess - offsetAt(t);
  return new Date(t).toISOString();
}

export function addDays(day: string, n: number): string {
  assertDay(day);
  const d = new Date(day + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** First day of the bucket containing `day`: itself, ISO Monday or the 1st of the month. */
export function bucketStart(day: string, g: Granularity): string {
  assertDay(day);
  if (g === 'day') return day;
  if (g === 'month') return day.slice(0, 8) + '01';
  const dow = new Date(day + 'T00:00:00Z').getUTCDay();
  return addDays(day, -((dow + 6) % 7));
}
function nextBucket(start: string, g: Granularity): string {
  if (g === 'day') return addDays(start, 1);
  if (g === 'week') return addDays(start, 7);
  const [y, m] = start.split('-').map(Number);
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
}

const months = ['styczeń', 'luty', 'marzec', 'kwiecień', 'maj', 'czerwiec', 'lipiec', 'sierpień', 'wrzesień', 'październik', 'listopad', 'grudzień'];
const pl = (day: string) => `${day.slice(8, 10)}.${day.slice(5, 7)}.${day.slice(0, 4)}`;

export type PeriodBucket = {
  key: string;
  label: string;
  /** Clipped to the requested period. */
  from: string;
  to: string;
  from_at: string;
  to_exclusive_at: string;
  hours: number;
};

/** All buckets of [from, to] in order, including empty ones, clipped to the period. */
export function periodBuckets(from: string, to: string, g: Granularity): PeriodBucket[] {
  assertDay(from);
  assertDay(to);
  if (from > to) throw new Error('Data od jest późniejsza niż data do');
  const out: PeriodBucket[] = [];
  for (let start = bucketStart(from, g); start <= to; start = nextBucket(start, g)) {
    const end = addDays(nextBucket(start, g), -1);
    const a = start < from ? from : start,
      b = end > to ? to : end;
    const fromAt = warsawMidnightUtc(a),
      toAt = warsawMidnightUtc(addDays(b, 1));
    const label =
      g === 'day'
        ? pl(a)
        : g === 'month'
          ? `${months[Number(a.slice(5, 7)) - 1]} ${a.slice(0, 4)}`
          : a === b
            ? pl(a)
            : `${pl(a).slice(0, 5)}–${pl(b)}`;
    out.push({
      key: start,
      label,
      from: a,
      to: b,
      from_at: fromAt,
      to_exclusive_at: toAt,
      hours: (Date.parse(toAt) - Date.parse(fromAt)) / 3600000,
    });
  }
  return out;
}

export type DayRow = { day: string; currency: string } & Record<string, unknown>;
export type SeriesPoint = { key: string } & Record<string, string>;
export type CurrencySeries = { currency: string; points: SeriesPoint[]; totals: Record<string, string> };

const big = (v: unknown) => {
  const s = String(v ?? '0');
  if (!/^-?\d+$/.test(s)) throw new Error('Niepoprawna dokładna liczba raportu');
  return BigInt(s);
};

/** Folds per-day database rows into one continuous series per currency (empty buckets
 * are zeros). Sums are exact (bigint); the totals are the sum of the points. */
export function foldSeries(rows: DayRow[], buckets: PeriodBucket[], g: Granularity, metrics: readonly string[]): CurrencySeries[] {
  const keys = new Set(buckets.map((b) => b.key));
  const by = new Map<string, Map<string, Record<string, bigint>>>();
  for (const r of rows) {
    const key = bucketStart(r.day, g);
    if (!keys.has(key)) throw new Error('Dzień spoza zakresu raportu: ' + r.day);
    const currency = by.get(r.currency) ?? new Map<string, Record<string, bigint>>();
    by.set(r.currency, currency);
    const acc = currency.get(key) ?? Object.fromEntries(metrics.map((m) => [m, 0n]));
    for (const m of metrics) acc[m] += big(r[m]);
    currency.set(key, acc);
  }
  return [...by.keys()].sort().map((currency) => {
    const m = by.get(currency)!;
    const totals = Object.fromEntries(metrics.map((k) => [k, 0n]));
    const points = buckets.map((b) => {
      const acc = m.get(b.key);
      const point: SeriesPoint = { key: b.key };
      for (const k of metrics) {
        const v = acc?.[k] ?? 0n;
        totals[k] += v;
        point[k] = v.toString();
      }
      return point;
    });
    return { currency, points, totals: Object.fromEntries(metrics.map((k) => [k, totals[k].toString()])) };
  });
}
