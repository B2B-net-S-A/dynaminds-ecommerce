/** Shared pure parts of the JPK files (JPK_V7M/JPK_V7K and JPK_FA): the taxpayer given by the
 * request, the document facts taken from the FA(3) adapters, amounts and XML text helpers.
 * No IO. Amounts are integer grosze until rendered. */
import { z } from 'zod';
import { b2bFa3XmlTextValid } from './fa3-draft-model';
import { FA3_UNTAXED, type Fa3Document, type Fa3RateCode } from './fa3-render';
import type { Fa3DocumentRate } from './fa3-adapters';
import { midScaled } from './nbp227-model';

export const JPK_SYSTEM_NAME = 'DYNAMINDS lokalny eksport JPK';
/** Most documents one file reads (each through the native detail read of its module). */
export const JPK_MAX_DOCUMENTS = 5000;
export const JPK_MAX_BYTES = 50_000_000;

/** Refusal of a whole file; `documents` lists what cannot be expressed (route answers 409). */
export class JpkError extends Error {
  constructor(public readonly status: 400 | 409 | 413 | 422, message: string, public readonly documents: JpkRefusal[] = []) { super(message); this.name = 'JpkError'; }
}
export type JpkRefusal = { number: string; reason: string };

/** One issued document of the period: FA(3) facts plus the date that places it in a JPK_V7 period. */
/** `ksef`: the 229 KSeF number of the document, or offline = issued offline and not yet numbered. */
export type JpkDocument = { id: string; model: Fa3Document; rate: Fa3DocumentRate | null; tax_date: string; ksef?: { number: string | null; offline: boolean } };

const nipValid = (v: string) => /^[0-9]{10}$/.test(v) && v !== '0000000000' && [6, 5, 7, 2, 3, 4, 5, 6, 7].reduce((n, w, i) => n + w * Number(v[i]), 0) % 11 === Number(v[9]);
const text = (max: number) => z.string().trim().min(1).max(max).refine(b2bFa3XmlTextValid, 'Niedozwolone znaki');
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => !Number.isNaN(Date.parse(v + 'T12:00:00Z')) && new Date(v + 'T12:00:00Z').toISOString().slice(0, 10) === v);
const blankToUndefined = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);
const opt = <T extends z.ZodTypeAny>(s: T) => z.preprocess(blankToUndefined, s.optional());

/** Taxpayer data the app does not store (tax office code, e-mail, natural person) comes with the request.
 * NIP and full name are taken from the issued documents when not given. */
export const jpkTaxpayerQuery = z.strictObject({
  kod_urzedu: z.string().regex(/^[0-9]{4}$/, 'Kod urzędu skarbowego to 4 cyfry'),
  email: opt(z.string().trim().max(255).regex(/^[^\s@<>&"]+@[^\s@<>&"]+\.[^\s@<>&"]+$/, 'Niepoprawny adres e-mail')),
  telefon: opt(z.string().trim().max(16).regex(/^\+?[0-9 -]{6,16}$/, 'Niepoprawny numer telefonu')),
  nip: opt(z.string().regex(/^[0-9]{10}$/).refine(nipValid, 'Niepoprawny NIP')),
  nazwa: opt(text(240)),
  cel: z.preprocess(blankToUndefined, z.enum(['1', '2']).default('1')),
  osoba: z.preprocess(blankToUndefined, z.enum(['niefizyczna', 'fizyczna']).default('niefizyczna')),
  imie: opt(text(30)), nazwisko: opt(text(81)), data_urodzenia: opt(day),
});
export const jpkAddressQuery = z.strictObject({
  wojewodztwo: text(36), powiat: text(36), gmina: text(36), ulica: opt(text(65)), nr_domu: text(9), nr_lokalu: opt(text(10)),
  miejscowosc: text(56), kod_pocztowy: z.string().trim().regex(/^[0-9]{2}-[0-9]{3}$/, 'Kod pocztowy w formacie NN-NNN'),
});
export type JpkTaxpayerQuery = z.infer<typeof jpkTaxpayerQuery>;
export type JpkAddress = z.infer<typeof jpkAddressQuery>;
/** Resolved taxpayer: NIP and name known. */
export type JpkTaxpayer = { nip: string; name: string; office: string; email: string | null; phone: string | null; purpose: 1 | 2;
  person: { first_name: string; last_name: string; birth_date: string } | null };

/** NIP and name: from the request, else from the documents; every document must belong to that NIP. */
export function resolveTaxpayer(q: JpkTaxpayerQuery, docs: readonly JpkDocument[]): JpkTaxpayer {
  let person: JpkTaxpayer['person'] = null;
  if (q.osoba === 'fizyczna') {
    if (!q.imie || !q.nazwisko || !q.data_urodzenia) throw new JpkError(400, 'Dla osoby fizycznej podaj imię, nazwisko i datę urodzenia');
    person = { first_name: q.imie, last_name: q.nazwisko, birth_date: q.data_urodzenia };
  }
  const sellers = docs.map(d => d.model.seller);
  const nip = q.nip ?? sellers[sellers.length - 1]?.nip ?? null;
  if (!nip) throw new JpkError(400, 'W okresie nie ma dokumentów — podaj NIP i pełną nazwę podatnika');
  const other = docs.filter(d => d.model.seller.nip !== nip);
  if (other.length) throw new JpkError(409, `Dokumenty okresu mają innego sprzedawcę niż NIP ${nip}`, other.map(d => ({ number: d.model.number, reason: `NIP sprzedawcy ${d.model.seller.nip ?? 'brak'}` })));
  const name = q.nazwa ?? [...docs].reverse().find(d => d.model.seller.nip === nip)?.model.seller.name;
  if (!name) throw new JpkError(400, 'Podaj pełną nazwę podatnika');
  return { nip, name, office: q.kod_urzedu, email: q.email ?? null, phone: q.telefon ?? null, purpose: q.cel === '2' ? 2 : 1, person };
}

export const xmlEscape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/\r/g, '&#13;');
export const xmlTag = (name: string, value: string) => `<${name}>${xmlEscape(value)}</${name}>`;
/** Two decimals from signed integer grosze. */
export function jpkMoney(value: bigint): string {
  const abs = value < 0n ? -value : value;
  if (abs > 999999999999999999n) throw new JpkError(409, 'Kwota przekracza zakres pola kwotowego JPK');
  return `${value < 0n ? '-' : ''}${abs / 100n}.${(abs % 100n).toString().padStart(2, '0')}`;
}
/** Whole złoty per art. 63 § 1 Ordynacji podatkowej: under 50 gr dropped, 50 gr and more rounded up (symmetric for negatives). */
export function jpkWholeZloty(minor: bigint): bigint {
  const abs = minor < 0n ? -minor : minor, r = (abs + 50n) / 100n;
  return minor < 0n ? -r : r;
}
/** Generation time: canonical UTC with up to 6 fractional digits. */
export function jpkGenerationTime(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.[0-9]{1,6})?Z$/.test(value) || Number.isNaN(Date.parse(value))) throw new JpkError(422, 'Niepoprawny czas wytworzenia pliku JPK');
  return value;
}

/** Net and VAT in PLN per FA(3) rate code; foreign documents use the 227 record (VAT and net per
 * rate as stored at issue) and the document mid rate for untaxed codes. */
export type PlnBucket = { code: Fa3RateCode; net: bigint; vat: bigint };
export function plnBuckets(d: JpkDocument): PlnBucket[] {
  const m = d.model;
  if (m.currency === 'PLN') return m.buckets.map(b => ({ code: b.code, net: b.net_minor, vat: b.vat_minor }));
  const rate = d.rate;
  if (!rate || rate.currency !== m.currency) throw new JpkError(409, 'Brak kursu NBP dokumentu');
  const mid = midScaled(rate.mid);
  const convert = (v: bigint) => { if (v < 0n) throw new JpkError(409, 'Korekta w walucie obcej nie jest obsługiwana'); return (v * mid + 5_000n) / 10_000n; };
  return m.buckets.map(b => {
    if (FA3_UNTAXED.has(b.code) || b.code === 'oss') {
      const stored = rate.untaxed_pln?.find(x => x.code === b.code);
      return { code: b.code, net: stored ? stored.net_pln_minor : convert(b.net_minor), vat: 0n };
    }
    const r = rate.vat.find(x => String(x.vat_rate) === b.code);
    if (!r || b.vat_pln_minor === null) throw new JpkError(409, 'Rekord kursu NBP nie obejmuje stawki ' + b.code);
    return { code: b.code, net: r.net_pln_minor ?? convert(b.net_minor), vat: b.vat_pln_minor };
  });
}
