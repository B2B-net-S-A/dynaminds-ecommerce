/** B2B-007 trade credit (migration 246): pure rules shared by the server and the UI. Money is in integer minor
 * units (grosze). The exposure of an account is the sum of the open balances (paymentBalance().amount_due, as on
 * the order card and in the settlement report) of its orders placed on credit; nothing here reads the database. */
import { z } from 'zod';

export const TRADE_CREDIT_MAX_MINOR = 100_000_000_000;
export const tradeCreditCurrencies = ['PLN', 'EUR', 'USD', 'GBP', 'CZK'] as const;
export type TradeCreditCurrency = (typeof tradeCreditCurrencies)[number];

export const tradeCreditLineInput = z
  .strictObject({
    currency: z.enum(tradeCreditCurrencies),
    limit_minor: z.number().int().min(0).max(TRADE_CREDIT_MAX_MINOR),
    term_days: z.number().int().min(1).max(365),
    active: z.boolean(),
    // 0 creates the line; otherwise the version the administrator saw.
    version: z.number().int().min(0),
    confirmed: z.literal(true),
  });
export type TradeCreditLineInput = z.infer<typeof tradeCreditLineInput>;

export interface TradeCreditLine {
  currency: string;
  limit_minor: number;
  term_days: number;
  active: boolean;
}
export type TradeCreditDecision =
  | { ok: true; charge: boolean; available_after: number }
  | { ok: false; status: 409; code: 'TRADE_CREDIT_CURRENCY' | 'TRADE_CREDIT_OVERDUE' | 'TRADE_CREDIT_LIMIT'; message: string };

const minor = (n: number, what: string) => {
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError(what + ' must be a non-negative integer of minor units');
  return n;
};
/** 123456 → "1234,56" (no grouping, the exact grosze). */
export function formatMinor(n: number): string {
  minor(n, 'amount');
  return Math.floor(n / 100) + ',' + String(n % 100).padStart(2, '0');
}

/** Admission of one order of `amount` against the line: overdue first, then the currency, then the limit. */
export function tradeCreditDecision(i: { line: TradeCreditLine; exposure: number; overdue: number; amount: number; currency: string }): TradeCreditDecision {
  const exposure = minor(i.exposure, 'exposure'), overdue = minor(i.overdue, 'overdue'), amount = minor(i.amount, 'amount');
  const limit = minor(i.line.limit_minor, 'limit');
  if (overdue > 0)
    return { ok: false, status: 409, code: 'TRADE_CREDIT_OVERDUE', message: `Konto ma należności po terminie (${formatMinor(overdue)} ${i.line.currency}). Zamówienie na kredyt kupiecki jest wstrzymane do ich spłaty.` };
  if (i.currency !== i.line.currency)
    return { ok: false, status: 409, code: 'TRADE_CREDIT_CURRENCY', message: `Kredyt kupiecki jest w ${i.line.currency}, a zamówienie w ${i.currency}. Zamówienie nie zostało złożone.` };
  const free = limit > exposure ? limit - exposure : 0;
  if (amount > free)
    return { ok: false, status: 409, code: 'TRADE_CREDIT_LIMIT', message: `Zamówienie (${formatMinor(amount)} ${i.line.currency}) przekracza wolny limit kredytu kupieckiego: ${formatMinor(free)} ${i.line.currency}. Zamówienie nie zostało złożone.` };
  return { ok: true, charge: amount > 0, available_after: free - amount };
}

/** The payment term ends exactly `days` × 24 h after the checkout instant. */
export function tradeCreditDueAt(at: Date, days: number): Date {
  if (!Number.isInteger(days) || days < 1 || days > 365) throw new RangeError('term_days');
  return new Date(at.getTime() + days * 86_400_000);
}

export interface TradeCreditOpenCharge {
  order_id: string;
  amount_due: number;
  due_at: Date;
}
export interface TradeCreditSummary {
  currency: string;
  limit_minor: number;
  term_days: number;
  active: boolean;
  exposure_minor: number;
  available_minor: number;
  overdue_minor: number;
  overdue_orders: number;
  open_orders: number;
}
/** Overdue = still open strictly after its due instant. */
export function tradeCreditSummary(line: TradeCreditLine, charges: TradeCreditOpenCharge[], now: Date): TradeCreditSummary {
  let exposure = 0, overdue = 0, overdueOrders = 0, open = 0;
  for (const c of charges) {
    const due = minor(c.amount_due, 'amount_due');
    if (due === 0) continue;
    open++;
    exposure += due;
    if (c.due_at.getTime() < now.getTime()) {
      overdue += due;
      overdueOrders++;
    }
  }
  minor(exposure, 'exposure');
  const limit = minor(line.limit_minor, 'limit');
  return {
    currency: line.currency, limit_minor: limit, term_days: line.term_days, active: line.active,
    exposure_minor: exposure, available_minor: limit > exposure ? limit - exposure : 0,
    overdue_minor: overdue, overdue_orders: overdueOrders, open_orders: open,
  };
}

/** "12 345,67" / "12345.67" → 1234567; at most two decimals, never negative or above the maximum line. */
export function parseMinorAmount(text: string): number {
  const s = String(text).trim().replace(/[\s ]/g, '');
  const m = /^(\d{1,12})(?:[.,](\d{1,2}))?$/.exec(s);
  if (!m) throw new RangeError('Podaj kwotę w złotych z najwyżej dwoma miejscami po przecinku');
  const value = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
  if (!Number.isSafeInteger(value) || value > TRADE_CREDIT_MAX_MINOR) throw new RangeError('Kwota przekracza najwyższy limit 1 000 000 000,00');
  return value;
}
