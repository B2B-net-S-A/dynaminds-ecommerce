/** Pure rules of the 227 NBP rates (no IO): the tax point of a document, the choice of
 * the NBP table A rate for it (art. 31a ust. 1 ustawy o VAT: mid rate of the last table
 * published before the tax point), coverage of NBP publications proven by a range read,
 * conversion to PLN with half-up rounding to a grosz, and the text shown on documents.
 * Design: docs/parity/NBP-RATES227-20261023.md. */
import { z } from 'zod';

export const NBP227_CURRENCIES = ['EUR'] as const;
/** Days a fetch for a tax point looks back; the longest NBP gap (Christmas, Easter) is far shorter. */
export const NBP227_LOOKBACK_DAYS = 14;
export const NBP227_MAX_RANGE_DAYS = 31;
const DAY = 86_400_000;

export const isDay = (v: unknown): v is string =>
  typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v + 'T00:00:00Z')) && new Date(v + 'T00:00:00Z').toISOString().slice(0, 10) === v;
export function addDays(day: string, n: number): string {
  if (!isDay(day) || !Number.isSafeInteger(n)) throw new Error('Niepoprawna data');
  return new Date(Date.parse(day + 'T00:00:00Z') + n * DAY).toISOString().slice(0, 10);
}
export const daysBetween = (from: string, to: string) => Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / DAY);
/** Calendar day in Warsaw, where NBP publishes its tables. */
export function warsawDay(now: Date): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(now).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

/** Mid rate text with at most 4 decimals (NBP table A for EUR) as an integer of 1/10000 PLN. */
export function midScaled(mid: string): bigint {
  const m = /^(0|[1-9]\d{0,5})(?:\.(\d{1,4}))?$/.exec(mid);
  if (!m) throw new Error('Kurs średni musi być liczbą dodatnią z najwyżej 4 miejscami po przecinku');
  const v = BigInt(m[1]!) * 10_000n + BigInt((m[2] ?? '').padEnd(4, '0'));
  if (v <= 0n) throw new Error('Kurs średni musi być dodatni');
  return v;
}
export const midText = (scaled: bigint) => `${scaled / 10_000n}.${(scaled % 10_000n).toString().padStart(4, '0')}`;
/** Amount in minor units of the currency times the mid rate, rounded half up to a grosz. */
export function toPlnMinor(minor: bigint, mid: bigint): bigint {
  if (minor < 0n || mid <= 0n) throw new Error('Przeliczenie obsługuje tylko kwoty nieujemne');
  return (minor * mid + 5_000n) / 10_000n;
}

export type TaxPoint = { date: string; basis: 'sell_date' | 'issue_date' };
/** Art. 19a ust. 1 (delivery = sell date) and art. 31a ust. 2 (an invoice issued before the
 * tax point uses the day before its issue): the earlier of the two dates. */
export function taxPointOf(d: { sell_date: string; issue_date: string }): TaxPoint {
  if (!isDay(d.sell_date) || !isDay(d.issue_date)) throw new Error('Dokument nie ma poprawnej daty sprzedaży i wystawienia');
  return d.issue_date < d.sell_date ? { date: d.issue_date, basis: 'issue_date' } : { date: d.sell_date, basis: 'sell_date' };
}

export type NbpPublication = { effective_date: string; table_no: string; mid: string };
export type StoredRate = NbpPublication & { covered_through: string; source: 'fetched' | 'manual' };
const TABLE = /^\d{3}\/A\/NBP\/(\d{4})$/;
export function validPublication(p: NbpPublication): boolean {
  const t = TABLE.exec(p.table_no);
  try { return isDay(p.effective_date) && !!t && t[1] === p.effective_date.slice(0, 4) && midScaled(p.mid) > 0n; } catch { return false; }
}

/** Rows proven by one NBP range read [start,end]: each publication is the last one up to
 * the day before the next; the last one up to the end, but never past yesterday in Warsaw
 * (today's table may still be published). */
export function coverRange(pubs: readonly NbpPublication[], start: string, end: string, today: string): StoredRate[] {
  if (!isDay(start) || !isDay(end) || !isDay(today) || start > end || daysBetween(start, end) >= NBP227_MAX_RANGE_DAYS || end > today) throw new Error('Niepoprawny zakres dat odczytu NBP');
  const lastFinal = addDays(today, -1);
  return pubs.map((p, i) => {
    if (!validPublication(p) || p.effective_date < start || p.effective_date > end || (i > 0 && pubs[i - 1]!.effective_date >= p.effective_date))
      throw new Error('Odpowiedź NBP zawiera tabelę spoza zakresu lub w złej kolejności');
    const next = pubs[i + 1];
    const through = next ? addDays(next.effective_date, -1) : (end < lastFinal ? end : lastFinal);
    return { ...p, covered_through: through < p.effective_date ? p.effective_date : through, source: 'fetched' as const };
  });
}

export type RateChoice = { rate: StoredRate } | { refusal: string };
/** The latest stored rate before the tax point counts only when its coverage reaches the
 * day before the tax point: no later publication can be missing in between. */
export function chooseRate(latestBefore: StoredRate | null, taxPoint: string, currency: string): RateChoice {
  const day = addDays(taxPoint, -1), when = plDate(taxPoint);
  if (!latestBefore) return { refusal: `Brak kursu NBP (tabela A, ${currency}) sprzed daty obowiązku podatkowego ${when}. Pobierz kurs z NBP albo wpisz go ręcznie w Dokumenty → Kursy NBP.` };
  if (latestBefore.effective_date >= taxPoint) throw new Error('Kurs musi pochodzić sprzed daty obowiązku podatkowego');
  if (latestBefore.covered_through < day)
    return { refusal: `Kurs NBP z dnia ${plDate(latestBefore.effective_date)} nie jest potwierdzony jako ostatni przed ${when} (brak odczytu tabel do ${plDate(day)}). Pobierz kurs z NBP albo wpisz go ręcznie w Dokumenty → Kursy NBP.` };
  return { rate: latestBefore };
}

export type VatBucket = { vat_rate: number; net_minor: string; vat_minor: string; gross_minor: string };
export type PlnBucket = { vat_rate: number; net_minor: string; vat_minor: string; gross_minor: string; net_pln_minor: string; vat_pln_minor: string; gross_pln_minor: string };
/** Each VAT rate converted on its own (net and VAT rounded, gross = their sum); totals are sums. */
export function plnAmounts(buckets: readonly VatBucket[], mid: string) {
  const m = midScaled(mid), seen = new Set<number>();
  let net = 0n, vat = 0n, netPln = 0n, vatPln = 0n;
  const rows: PlnBucket[] = buckets.map(b => {
    if (![0, 5, 8, 23].includes(b.vat_rate) || seen.has(b.vat_rate)) throw new Error('Niepoprawny podział według stawek VAT');
    seen.add(b.vat_rate);
    const n = BigInt(b.net_minor), v = BigInt(b.vat_minor);
    if (n < 0n || v < 0n || n + v !== BigInt(b.gross_minor)) throw new Error('Kwoty stawki VAT nie sumują się');
    const np = toPlnMinor(n, m), vp = toPlnMinor(v, m);
    net += n; vat += v; netPln += np; vatPln += vp;
    return { vat_rate: b.vat_rate, net_minor: String(n), vat_minor: String(v), gross_minor: String(n + v), net_pln_minor: String(np), vat_pln_minor: String(vp), gross_pln_minor: String(np + vp) };
  });
  if (!rows.length) throw new Error('Dokument nie ma kwot VAT');
  return { rows, totals: { net_minor: String(net), vat_minor: String(vat), gross_minor: String(net + vat), net_pln_minor: String(netPln), vat_pln_minor: String(vatPln), gross_pln_minor: String(netPln + vatPln) } };
}

export const plDate = (day: string) => `${day.slice(8, 10)}.${day.slice(5, 7)}.${day.slice(0, 4)}`;
export function plMoney(minor: string): string {
  const v = BigInt(minor), abs = v < 0n ? -v : v, whole = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${v < 0n ? '-' : ''}${whole},${(abs % 100n).toString().padStart(2, '0')}`;
}
/** The line printed on a foreign-currency document. */
export function nbpRateLine(r: { currency: string; rate_date: string; table_no: string; mid: string; vat_pln_minor: string }): string {
  return `Kurs NBP z dnia ${plDate(r.rate_date)}, tabela ${r.table_no}, 1 ${r.currency} = ${r.mid.replace('.', ',')} PLN; VAT w PLN: ${plMoney(r.vat_pln_minor)} zł`;
}

const day = z.string().refine(isDay, 'Niepoprawna data (RRRR-MM-DD)');
const currency = z.enum(NBP227_CURRENCIES, 'Obsługiwana waluta: EUR');
export const nbpFetchInput = z.strictObject({ currency, start: day, end: day })
  .refine(v => v.start <= v.end && daysBetween(v.start, v.end) < NBP227_MAX_RANGE_DAYS, `Zakres odczytu: od 1 do ${NBP227_MAX_RANGE_DAYS} dni`);
export const nbpManualInput = z.strictObject({
  currency,
  effective_date: day,
  table_no: z.string().regex(TABLE, 'Numer tabeli w formacie 123/A/NBP/2026'),
  mid: z.string().refine(v => { try { return midScaled(v) > 0n; } catch { return false; } }, 'Kurs średni: liczba dodatnia z najwyżej 4 miejscami po przecinku, np. 4.3685'),
  covered_through: day,
}).superRefine((v, ctx) => {
  if (TABLE.exec(v.table_no)?.[1] !== v.effective_date.slice(0, 4)) ctx.addIssue({ code: 'custom', path: ['table_no'], message: 'Rok w numerze tabeli musi zgadzać się z datą tabeli' });
  if (v.covered_through < v.effective_date || daysBetween(v.effective_date, v.covered_through) > 31)
    ctx.addIssue({ code: 'custom', path: ['covered_through'], message: 'Kurs obowiązuje od dnia tabeli do najwyżej 31 dni później' });
});
export const nbpRateForQuery = z.strictObject({ currency, tax_point: day, vat_minor: z.string().regex(/^(0|[1-9]\d{0,15})$/, 'Kwota VAT w groszach/centach').optional() });
export type NbpManualInput = z.infer<typeof nbpManualInput>;
