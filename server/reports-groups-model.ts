/** ANALYTICS-002: sales grouped by source, delivery or payment, with an optional comparison period.
 * Pure: query schema and the exact (bigint) comparison of two grouped periods. */
import { z } from 'zod';
import { reportScope, REPORT_DAYS } from './reports-model';

export const GROUP_DIMENSIONS = ['source', 'delivery', 'payment'] as const;
export type GroupDimension = (typeof GROUP_DIMENSIONS)[number];

const day = /^\d{4}-\d{2}-\d{2}$/;
const valid = (v: string) => day.test(v) && new Date(v + 'T00:00:00Z').toISOString().slice(0, 10) === v;
const span = (from: string, to: string) => {
  const n = (Date.parse(to) - Date.parse(from)) / 86400000 + 1;
  return n >= 1 && n <= REPORT_DAYS;
};

/** The scope of the other analytics reports plus group_by and compare_from/compare_to (both or none). */
export const groupQuery = z
  .strictObject({
    ...reportScope,
    group_by: z.enum(GROUP_DIMENSIONS, { error: 'Grupowanie: source, delivery albo payment' }).default('source'),
    compare_from: z.string().refine(valid, 'Podaj datę porównania od w formacie RRRR-MM-DD').optional(),
    compare_to: z.string().refine(valid, 'Podaj datę porównania do w formacie RRRR-MM-DD').optional(),
  })
  .refine((q: any) => span(q.from, q.to), 'Zakres wymaga od 1 do 366 dni (data od nie może być późniejsza niż data do)')
  .refine((q: any) => (q.compare_from === undefined) === (q.compare_to === undefined), 'Podaj obie daty okresu porównania albo żadnej')
  .refine((q: any) => q.compare_from === undefined || span(q.compare_from, q.compare_to), 'Okres porównania wymaga od 1 do 366 dni');
export type GroupQuery = z.infer<typeof groupQuery> & { from: string; to: string; group_by: GroupDimension };

export interface GroupRow {
  currency: string;
  group: string;
  orders: number;
  total_gross_minor: string;
  delivery_gross_minor: string;
}
export interface ComparedGroup {
  currency: string;
  group: string;
  orders: number;
  compare_orders: number | null;
  orders_delta?: number;
  total_gross_minor: string;
  compare_total_gross_minor?: string;
  total_delta_minor?: string;
  /** Change against the comparison period in basis points (1 % = 100), rounded half away from zero; null without a base. */
  total_change_bps?: number | null;
  delivery_gross_minor: string;
  compare_delivery_gross_minor?: string;
  /** Share of the group in the currency's current value, basis points. */
  share_bps: number | null;
}

const ratio = (num: bigint, den: bigint): number => {
  const neg = num < 0n !== den < 0n;
  const a = num < 0n ? -num : num,
    b = den < 0n ? -den : den;
  const q = (a * 20000n + b) / (2n * b);
  return Number(neg ? -q : q);
};

export function compareGroups(current: readonly GroupRow[], previous: readonly GroupRow[] | null): ComparedGroup[] {
  const key = (r: GroupRow) => JSON.stringify([r.currency, r.group]);
  const prev = new Map((previous ?? []).map((r) => [key(r), r]));
  const keys = new Map(current.map((r) => [key(r), r]));
  for (const r of previous ?? []) if (!keys.has(key(r))) keys.set(key(r), { ...r, orders: 0, total_gross_minor: '0', delivery_gross_minor: '0' });
  const totals = new Map<string, bigint>();
  for (const r of current) totals.set(r.currency, (totals.get(r.currency) ?? 0n) + BigInt(r.total_gross_minor));
  const rows = [...keys.entries()].map(([k, r]): ComparedGroup => {
    const now = BigInt(r.total_gross_minor),
      all = totals.get(r.currency) ?? 0n;
    const share_bps = all > 0n ? ratio(now, all) : null;
    if (previous === null)
      return { currency: r.currency, group: r.group, orders: r.orders, compare_orders: null, total_gross_minor: r.total_gross_minor, delivery_gross_minor: r.delivery_gross_minor, share_bps };
    const p = prev.get(k),
      before = BigInt(p?.total_gross_minor ?? '0');
    return {
      currency: r.currency,
      group: r.group,
      orders: r.orders,
      compare_orders: p?.orders ?? 0,
      orders_delta: r.orders - (p?.orders ?? 0),
      total_gross_minor: r.total_gross_minor,
      compare_total_gross_minor: before.toString(),
      total_delta_minor: (now - before).toString(),
      total_change_bps: before > 0n ? ratio(now - before, before) : null,
      delivery_gross_minor: r.delivery_gross_minor,
      compare_delivery_gross_minor: p?.delivery_gross_minor ?? '0',
      share_bps,
    };
  });
  return rows.sort((x, y) =>
    x.currency < y.currency ? -1 : x.currency > y.currency ? 1
      : Number(BigInt(y.total_gross_minor) - BigInt(x.total_gross_minor)) || Number(BigInt(y.compare_total_gross_minor ?? '0') - BigInt(x.compare_total_gross_minor ?? '0')) || (x.group < y.group ? -1 : 1));
}
