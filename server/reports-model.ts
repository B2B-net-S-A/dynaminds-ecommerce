/** Analytics reports (S7) — query parameters, personal-data masking, per-SKU
 * aggregation and CSV. Pure: no database. Money is integer minor units (grosze)
 * carried as decimal strings and summed as bigint. */
import { z } from 'zod';
import { Problem } from './errors';
import { periodBuckets, type CurrencySeries, type Granularity } from './reports-period';

export const REPORT_DAYS = 366;
export const reportCurrencies = ['PLN', 'EUR', 'USD', 'GBP', 'CZK'] as const;
/** Cancelled orders are not sales; the economic order set of the sales report excludes them. */
export const reportStatuses = ['new', 'paid', 'picking', 'packed', 'shipped', 'delivered', 'completed', 'return_initiated', 'return_received', 'return_completed'] as const;
export const DEFAULT_PRICE_EDGES = [5000n, 10000n, 20000n, 50000n] as const;

const calendarDate = (label: string, name: string) =>
  z
    .string({ error: `Podaj ${label} w formacie RRRR-MM-DD` })
    .regex(/^\d{4}-\d{2}-\d{2}$/, `Podaj ${label} w formacie RRRR-MM-DD`)
    .refine((v) => {
      const d = new Date(v + 'T00:00:00Z');
      return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === v;
    }, `Data ${name} nie istnieje w kalendarzu`);
const list = (label: string, allowed?: readonly string[]) =>
  z
    .string()
    .regex(/^[a-z0-9_]{1,40}(,[a-z0-9_]{1,40}){0,19}$/, `Niepoprawna lista: ${label}`)
    .transform((v) => [...new Set(v.split(','))].sort())
    .refine((v) => !allowed || v.every((x) => allowed.includes(x)), `Nieobsługiwana wartość: ${label}`)
    .optional();
const period = {
  from: calendarDate('datę od', 'od'),
  to: calendarDate('datę do', 'do'),
};
const scope = {
  ...period,
  warehouse_id: z
    .uuid({ error: 'Niepoprawny identyfikator magazynu' })
    .transform((v) => v.toLowerCase())
    .optional(),
  currency: z.enum(reportCurrencies, { error: 'Nieobsługiwana waluta' }).optional(),
  sources: list('źródła'),
  statuses: list('statusy', reportStatuses),
};
/** Shared scope of the analytics reports (also the grouped report, ANALYTICS-002). */
export const reportScope = scope;
const days = (q: { from: string; to: string }) => {
  const n = (Date.parse(q.to) - Date.parse(q.from)) / 86400000 + 1;
  return n >= 1 && n <= REPORT_DAYS;
};
const range = 'Zakres wymaga od 1 do 366 dni (data od nie może być późniejsza niż data do)';
const safe = z
  .enum(['true', 'false'], { error: 'spreadsheet_safe przyjmuje true albo false' })
  .default('true')
  .transform((v) => v === 'true');
const granularity = z.enum(['day', 'week', 'month'], { error: 'Podział: day, week albo month' }).default('day');
const edges = z
  .string()
  .regex(/^\d{1,9}(,\d{1,9}){0,9}$/, 'Progi cen: do 10 liczb groszy rozdzielonych przecinkami')
  .transform((v) => v.split(',').map((x) => BigInt(x)))
  .refine((v) => v.every((x, i) => x > 0n && (i === 0 || x > v[i - 1])), 'Progi cen muszą być dodatnie i rosnące')
  .optional();

export const periodQuery = z.strictObject({ ...scope, granularity }).refine(days, range);
export const periodFileQuery = z.strictObject({ ...scope, granularity, spreadsheet_safe: safe }).refine(days, range);
export const productQuery = z.strictObject({ ...scope, price_edges: edges }).refine(days, range);
export const productFileQuery = z.strictObject({ ...scope, price_edges: edges, spreadsheet_safe: safe }).refine(days, range);
export const customerQuery = z.strictObject(scope).refine(days, range);
export const employeeQuery = z.strictObject(period).refine(days, range);
export type ScopeQuery = z.infer<typeof customerQuery>;
export type PeriodQuery = z.infer<typeof periodQuery>;
export type ProductQuery = z.infer<typeof productQuery>;

/** Polish 422 instead of raw zod messages; unknown parameters are named as such. */
export function parseReportQuery<S extends z.ZodType>(schema: S, input: unknown): z.infer<S> {
  const r = schema.safeParse(input ?? {});
  if (r.success) return r.data;
  const unknown = r.error.issues.some((i) => i.code === 'unrecognized_keys');
  throw new Problem(422, unknown ? 'Nieobsługiwany parametr raportu' : [...new Set(r.error.issues.map((i) => i.message))].join('; '));
}

/** "jan.kowalski@gmail.com" → "j***@g***.com". Never returns the full local part or domain. */
export function maskEmail(email: string | null | undefined): string {
  const v = String(email ?? '').trim();
  if (!v) return '';
  const at = v.lastIndexOf('@');
  if (at < 1) return v[0] + '***';
  const domain = v.slice(at + 1),
    dot = domain.lastIndexOf('.');
  const tld = dot > 0 ? domain.slice(dot) : '';
  return `${v[0]}***@${domain ? domain[0] + '***' : '***'}${tld}`;
}
/** "Jan Kowalski" → "J. K." */
export function maskName(name: string | null | undefined): string {
  return String(name ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => [...w][0].toUpperCase() + '.')
    .join(' ');
}

const big = (v: unknown) => {
  const s = String(v ?? '0');
  if (!/^-?\d+$/.test(s)) throw new Error('Niepoprawna dokładna liczba raportu');
  return BigInt(s);
};

/** One database row per (SKU, currency, rounded gross unit price). */
export type SkuPriceRow = {
  sku: string;
  name: string;
  currency: string;
  unit_price_minor: string;
  lines: string | number;
  quantity: string;
  gross_minor: string;
  net_minor: string;
  returned_quantity: string;
  returned_gross_minor: string;
  returned_net_minor: string;
  latest_at: string;
};
export type PriceBand = { from_minor: string; to_minor: string | null; quantity: string };
export type SkuStat = {
  sku: string;
  name: string;
  currency: string;
  lines: string;
  quantity: string;
  returned_quantity: string;
  net_quantity: string;
  gross_minor: string;
  returned_gross_minor: string;
  gross_after_returns_minor: string;
  net_minor: string;
  returned_net_minor: string;
  min_unit_price_minor: string;
  max_unit_price_minor: string;
  avg_unit_price_minor: string;
  price_bands: PriceBand[];
};

/** Exact per-SKU statistics. Returns are negative (cohort: returns accepted until the
 * read for sales in the period). The average is the quantity-weighted gross unit price
 * rounded half up; min/max come from the rounded unit price of each line. */
export function aggregateSkuStats(rows: readonly SkuPriceRow[], priceEdges: readonly bigint[] = DEFAULT_PRICE_EDGES): SkuStat[] {
  type Acc = { sku: string; currency: string; name: string; latest: string; lines: bigint; q: bigint; rq: bigint; g: bigint; rg: bigint; n: bigint; rn: bigint; min: bigint | null; max: bigint | null; bands: bigint[] };
  const by = new Map<string, Acc>();
  for (const r of rows) {
    const key = JSON.stringify([r.currency, r.sku]);
    const a: Acc = by.get(key) ?? { sku: r.sku, currency: r.currency, name: r.name, latest: r.latest_at, lines: 0n, q: 0n, rq: 0n, g: 0n, rg: 0n, n: 0n, rn: 0n, min: null, max: null, bands: Array(priceEdges.length + 1).fill(0n) };
    const price = big(r.unit_price_minor),
      q = big(r.quantity);
    if (q <= 0n) throw new Error('Pozycja bez ilości nie może trafić do statystyki cen');
    a.lines += big(r.lines);
    a.q += q;
    a.rq += big(r.returned_quantity);
    a.g += big(r.gross_minor);
    a.rg += big(r.returned_gross_minor);
    a.n += big(r.net_minor);
    a.rn += big(r.returned_net_minor);
    a.min = a.min === null || price < a.min ? price : a.min;
    a.max = a.max === null || price > a.max ? price : a.max;
    let band = priceEdges.findIndex((e) => price < e);
    if (band < 0) band = priceEdges.length;
    a.bands[band] += q;
    if (r.latest_at > a.latest || (r.latest_at === a.latest && r.name > a.name)) {
      a.latest = r.latest_at;
      a.name = r.name;
    }
    by.set(key, a);
  }
  return [...by.values()]
    .map((a) => ({
      sku: a.sku,
      name: a.name,
      currency: a.currency,
      lines: a.lines.toString(),
      quantity: a.q.toString(),
      returned_quantity: (-a.rq).toString(),
      net_quantity: (a.q - a.rq).toString(),
      gross_minor: a.g.toString(),
      returned_gross_minor: (-a.rg).toString(),
      gross_after_returns_minor: (a.g - a.rg).toString(),
      net_minor: a.n.toString(),
      returned_net_minor: (-a.rn).toString(),
      min_unit_price_minor: String(a.min),
      max_unit_price_minor: String(a.max),
      avg_unit_price_minor: ((2n * a.g + a.q) / (2n * a.q)).toString(),
      price_bands: a.bands.map((quantity, i) => ({
        from_minor: (i === 0 ? 0n : priceEdges[i - 1]).toString(),
        to_minor: i < priceEdges.length ? priceEdges[i].toString() : null,
        quantity: quantity.toString(),
      })),
    }))
    .sort((x, y) => (x.currency < y.currency ? -1 : x.currency > y.currency ? 1 : Number(BigInt(y.gross_minor) - BigInt(x.gross_minor)) || (x.sku < y.sku ? -1 : x.sku > y.sku ? 1 : 0)));
}

// ---------------------------------------------------------------- CSV
const cell = (v: unknown, spreadsheetSafe: boolean) => {
  let text = v == null ? '' : String(v);
  if (spreadsheetSafe && (/^[\s]*[=+\-@]/u.test(text) || /^0\d+$/u.test(text))) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
};
/** Amount columns (…_minor) stay integers in grosze so the file reconciles with the JSON;
 * negative amounts are only prefixed when the caller asks for spreadsheet safety. */
function csv(header: readonly string[], rows: readonly (readonly unknown[])[], spreadsheetSafe: boolean) {
  return '﻿' + [header.map((h) => cell(h, false)).join(','), ...rows.map((r) => r.map((v) => cell(v, spreadsheetSafe)).join(','))].join('\r\n') + '\r\n';
}

export const SERIES_METRICS = ['orders', 'commercial_quantity', 'goods_gross_minor', 'goods_net_minor', 'delivery_gross_minor', 'total_gross_minor'] as const;
export const SERIES_QUANTITY_METRICS = ['orders', 'commercial_quantity'] as const;

/** Chart CSV: one row per bucket and currency, then a total row per currency
 * (sum of the rows = the totals of the JSON = the sales summary for the same scope). */
export function seriesCsv(from: string, to: string, g: Granularity, series: readonly CurrencySeries[], financial: boolean, spreadsheetSafe: boolean) {
  const metrics = financial ? SERIES_METRICS : SERIES_QUANTITY_METRICS;
  const buckets = new Map(periodBuckets(from, to, g).map((b) => [b.key, b]));
  const rows: unknown[][] = [];
  for (const s of series) {
    for (const p of s.points) {
      const b = buckets.get(p.key)!;
      rows.push(['okres', s.currency, b.key, b.from, b.to, b.label, ...metrics.map((m) => p[m])]);
    }
    rows.push(['razem', s.currency, '', from, to, 'Razem', ...metrics.map((m) => s.totals[m])]);
  }
  return csv(['wiersz', 'currency', 'bucket', 'from', 'to', 'label', ...metrics], rows, spreadsheetSafe);
}

/** Per-SKU CSV; the price columns and bands are present only for value readers. */
export function skuCsv(stats: readonly SkuStat[], priceEdges: readonly bigint[], financial: boolean, spreadsheetSafe: boolean) {
  const bands = [...priceEdges.map((e, i) => `band_${i === 0 ? 0n : priceEdges[i - 1]}_${e}_quantity`), `band_${priceEdges.at(-1) ?? 0n}_up_quantity`];
  const money = ['gross_minor', 'returned_gross_minor', 'gross_after_returns_minor', 'net_minor', 'returned_net_minor', 'min_unit_price_minor', 'max_unit_price_minor', 'avg_unit_price_minor'] as const;
  const base = ['sku', 'name', 'currency', 'lines', 'quantity', 'returned_quantity', 'net_quantity'] as const;
  const header = [...base, ...(financial ? [...money, ...bands] : [])];
  const rows = stats.map((s) => [...base.map((k) => s[k]), ...(financial ? [...money.map((k) => s[k]), ...s.price_bands.map((b) => b.quantity)] : [])]);
  return csv(header, rows, spreadsheetSafe);
}
