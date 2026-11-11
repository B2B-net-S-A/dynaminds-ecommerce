/** Pure S9 repricing rules (no IO): rounding to a grosz step with an ending, conversion of
 * minor amounts with dated NBP table A mid rates (nbp227_rates, PLN as the pivot), the
 * choice of a rate for a pricing day, the base price-list chain and the history cursor.
 * Design: docs/parity/REPRICING-S9-20261026.md. */
import { Problem } from './errors';
import { daysBetween, isDay, midScaled, plDate } from './nbp227-model';

export const REPRICING_MAX_AMOUNT = 100000000;
export const REPRICING_BASE_DEPTH = 5;
export const REPRICING_RATE_AGE_DAYS = 7;
export const REPRICING_ROUNDING_STEPS = [5, 10, 50, 100, 500, 1000] as const;
export type RepricingRounding = { step: (typeof REPRICING_ROUNDING_STEPS)[number]; ending: number };
export type RepricingRate = { currency: string; effective_date: string; table_no: string; mid: string };
export type RepricingFx = {
  cost_currency: string;
  list_currency: string;
  net_cost_original: number;
  net_cost: number;
  rates: RepricingRate[];
};
type Refusal = { refusal: string };

/** Smallest price >= candidate ending with `ending` within `step`; above max it takes the
 * previous one. With prefer 'down' (competitor strategies: the undercut is a ceiling) the
 * largest such price <= candidate wins when it still reaches the floor. A result below the
 * floor (or below zero) is null: the SKU is blocked. */
export function roundPrice(candidate: number, floor: number, max: number, rounding: RepricingRounding | null, prefer: 'up' | 'down' = 'up'): number | null {
  if (!rounding) return candidate >= floor && candidate <= max ? candidate : null;
  const { step, ending } = rounding;
  if (prefer === 'down') {
    const down = Math.floor((candidate - ending) / step) * step + ending;
    if (down >= floor && down >= 0 && down <= max) return down;
  }
  const up = Math.ceil((candidate - ending) / step) * step + ending + 0;
  const price = up > max ? up - step : up;
  return price < floor || price < 0 || price > max ? null : price;
}

const PLN = 10_000n;
/** Mid of a currency in 1/10000 PLN; PLN itself is 1.0000. */
function mid(currency: string, rates: ReadonlyMap<string, RepricingRate>): bigint {
  if (currency === 'PLN') return PLN;
  const rate = rates.get(currency);
  if (!rate) throw new Error('Brak kursu ' + currency);
  return midScaled(rate.mid);
}
/** amount (minor units of `from`) in minor units of `to` through PLN, one rounding at the
 * end: 'ceil' for costs (the floor never falls below the real cost), 'half_up' for prices.
 * Null when the result leaves the price range. */
export function convertMinor(amount: number, from: string, to: string, rates: ReadonlyMap<string, RepricingRate>, mode: 'ceil' | 'half_up'): number | null {
  if (!Number.isSafeInteger(amount) || amount < 0) throw new Error('Przeliczenie obsługuje tylko kwoty nieujemne');
  if (from === to) return amount;
  const n = BigInt(amount) * mid(from, rates), d = mid(to, rates);
  const out = mode === 'ceil' ? (n + d - 1n) / d : (2n * n + d) / (2n * d);
  return out > BigInt(REPRICING_MAX_AMOUNT) ? null : Number(out);
}

/** The latest stored table A rate on or before the pricing day counts while it is at most
 * maxAgeDays old; otherwise (or without any) the SKU is blocked with the reason. */
export function pickRepricingRate(latest: RepricingRate | undefined, currency: string, today: string, maxAgeDays: number): { rate: RepricingRate } | Refusal {
  if (!latest) return { refusal: `Brak kursu NBP (tabela A, ${currency}) do przeliczenia; pobierz kurs albo wpisz go w Dokumenty → Kursy NBP.` };
  if (!isDay(latest.effective_date) || !isDay(today) || latest.effective_date > today) throw new Error('Kurs NBP musi pochodzić najpóźniej z dnia wyceny');
  if (daysBetween(latest.effective_date, today) > maxAgeDays)
    return { refusal: `Kurs NBP (${currency}) z dnia ${plDate(latest.effective_date)} jest starszy niż ${maxAgeDays} dni; pobierz aktualny kurs w Dokumenty → Kursy NBP.` };
  return { rate: latest };
}

/** Rates used for a conversion between two currencies, each checked for age. */
export function ratesFor(currencies: readonly string[], latest: ReadonlyMap<string, RepricingRate>, today: string, maxAgeDays: number): { rates: RepricingRate[] } | Refusal {
  const used: RepricingRate[] = [];
  for (const currency of [...new Set(currencies)].filter((c) => c !== 'PLN')) {
    const choice = pickRepricingRate(latest.get(currency), currency, today, maxAgeDays);
    if ('refusal' in choice) return choice;
    const r = choice.rate;
    used.push({ currency: r.currency, effective_date: r.effective_date, table_no: r.table_no, mid: r.mid });
  }
  return { rates: used };
}

type CostConfig = { cost_currency?: string | undefined; max_rate_age_days?: number | undefined };
/** The operator's net cost in the configured cost currency, converted to the list currency
 * (rounded up to a grosz). Same currency (or none configured) passes through unchanged. */
export function costInListCurrency<T extends { net_cost: number }>(input: T, config: CostConfig, listCurrency: string,
  latest: ReadonlyMap<string, RepricingRate>, today: string): { input: T; fx: RepricingFx | null } | Refusal {
  const from = config.cost_currency ?? listCurrency;
  if (from === listCurrency) return { input, fx: null };
  const chosen = ratesFor([from, listCurrency], latest, today, config.max_rate_age_days ?? REPRICING_RATE_AGE_DAYS);
  if ('refusal' in chosen) return chosen;
  const net = convertMinor(input.net_cost, from, listCurrency, new Map(chosen.rates.map((r) => [r.currency, r])), 'ceil');
  if (net === null) return { refusal: 'Przeliczony koszt netto przekracza zakres ceny' };
  return {
    input: { ...input, net_cost: net },
    fx: { cost_currency: from, list_currency: listCurrency, net_cost_original: input.net_cost, net_cost: net, rates: chosen.rates },
  };
}

/** Base lists reachable from `start` (without it). A list met twice is a cycle; more than
 * REPRICING_BASE_DEPTH links is refused, so the walk always ends. */
export function walkBaseChain(start: string, next: (id: string) => string | null, max = REPRICING_BASE_DEPTH): { chain: string[] } | Refusal {
  const seen = new Set([start]), chain: string[] = [];
  for (let id = next(start); id !== null; id = next(id)) {
    if (seen.has(id)) return { refusal: 'Cenniki bazowe tworzą cykl; wybierz inny cennik bazowy' };
    if (chain.length >= max) return { refusal: `Łańcuch cenników bazowych jest zbyt długi (najwyżej ${max})` };
    seen.add(id);
    chain.push(id);
  }
  return { chain };
}

const CURSOR = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z)\|([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
/** Keyset cursor of a history ordered by created_at DESC, id DESC (microsecond UTC text). */
export const historyCursor = (at: string, id: string): string => `${at}|${id}`;
export function parseHistoryCursor(raw: string): { at: string; id: string } {
  const m = CURSOR.exec(raw);
  if (!m || !Number.isFinite(Date.parse(m[1]!))) throw new Error('Niepoprawny kursor historii');
  return { at: m[1]!, id: m[2]! };
}
/** Optional `after` query value as a cursor; anything else is a 422 for the caller. */
export function historyAfter(after: string | undefined): { at: string | null; id: string | null } {
  if (after === undefined) return { at: null, id: null };
  try {
    return parseHistoryCursor(after);
  } catch {
    throw new Problem(422, 'Niepoprawny kursor historii');
  }
}
