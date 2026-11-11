/** Pure rules for invoices beyond the plain PLN consumer invoice of 157 (no IO):
 * B2B buyer data (NIP, EU VAT ID), the amounts of ZW/NP I/NP II/OO/OSS/0 KR lines,
 * the summary per FA(3) category, the PLN conversion of a foreign-currency invoice
 * and the MPP threshold compared in PLN. Line tax categories come from 226
 * (tax226-model.ts deriveLineTax); rounding is the 157 rule (per line, from the
 * gross amount, half up to a grosz/cent). Design: docs/parity/INVOICES230-20261023.md. */
import { z } from 'zod';
import { DEFAULT_TAX_PROFILE, OSS_COUNTRIES, deriveLineTax, mppRequirement, type OssState, type TaxBuyer, type TaxLineFacts, type TaxProfile } from './tax226-model';
import { midScaled, toPlnMinor } from './nbp227-model';

/** VAT-number prefix of each EU state other than PL (Greece uses EL, not its ISO code GR). */
export const EU_VAT_PREFIX: Readonly<Record<string, string>> = Object.freeze(Object.fromEntries(OSS_COUNTRIES.map(c => [c, c === 'GR' ? 'EL' : c])));
/** Format of the national part of a VAT number (VIES formats); no checksum and no VIES call. */
const EU_VAT_FORMAT: Readonly<Record<string, RegExp>> = Object.freeze({
  AT: /^U\d{8}$/, BE: /^[01]\d{9}$/, BG: /^\d{9,10}$/, CY: /^\d{8}[A-Z]$/, CZ: /^\d{8,10}$/, DE: /^\d{9}$/, DK: /^\d{8}$/, EE: /^\d{9}$/,
  EL: /^\d{9}$/, ES: /^[A-Z0-9]\d{7}[A-Z0-9]$/, FI: /^\d{8}$/, FR: /^[A-HJ-NP-Z0-9]{2}\d{9}$/, HR: /^\d{11}$/, HU: /^\d{8}$/,
  IE: /^(\d{7}[A-W][A-IW]?|\d[A-Z+*]\d{5}[A-W])$/, IT: /^\d{11}$/, LT: /^(\d{9}|\d{12})$/, LU: /^\d{8}$/, LV: /^\d{11}$/, MT: /^\d{8}$/,
  NL: /^\d{9}B\d{2}$/, PT: /^\d{9}$/, RO: /^[1-9]\d{1,9}$/, SE: /^\d{10}01$/, SI: /^\d{8}$/, SK: /^\d{10}$/,
});

/** NIP: 10 digits, weights 6,5,7,2,3,4,5,6,7, sum mod 11 equals the last digit (same rule as SQL local_invoice_nip). */
export function nipValid(v: string): boolean {
  if (!/^\d{10}$/.test(v) || v === '0000000000') return false;
  const w = [6, 5, 7, 2, 3, 4, 5, 6, 7], sum = w.reduce((s, x, i) => s + x * Number(v[i]), 0);
  return sum % 11 === Number(v[9]);
}
/** Accepts "PL 123-456-32-18", "1234563218"; returns the 10 digits or null. */
export function normalizeNip(input: string): string | null {
  const v = input.replace(/[\s-]/g, '').toUpperCase().replace(/^PL/, '');
  return nipValid(v) ? v : null;
}
export type VatIdCheck = { ok: true; value: string } | { ok: false; reason: string };
/** EU VAT ID with its country prefix for a buyer in `country` (ISO code). */
export function checkEuVatId(country: string, input: string): VatIdCheck {
  const prefix = EU_VAT_PREFIX[country];
  if (!prefix) return { ok: false, reason: country === 'PL' ? 'Nabywca z Polski podaje NIP, nie numer VAT UE' : `${country} nie jest państwem UE — numer VAT UE nie dotyczy` };
  const v = input.replace(/[\s.-]/g, '').toUpperCase();
  if (!v.startsWith(prefix)) return { ok: false, reason: `Numer VAT UE nabywcy z ${country} zaczyna się od ${prefix}` };
  if (!EU_VAT_FORMAT[prefix]!.test(v.slice(prefix.length))) return { ok: false, reason: `Numer ${v} nie ma formatu numeru VAT ${prefix}` };
  return { ok: true, value: v };
}

const text = (max: number, what: string) => z.string().trim().min(1, `Podaj ${what}`).max(max, `${what[0]!.toUpperCase() + what.slice(1)}: najwyżej ${max} znaków`);
const address = z.strictObject({
  street: text(200, 'ulicę i numer'), postal_code: text(30, 'kod pocztowy'), city: text(100, 'miejscowość'),
  country: z.string().regex(/^[A-Z]{2}$/, 'Kraj: dwuliterowy kod ISO'),
});
/** Buyer of the invoice. Consumer = the 157 bill-to; business = company with NIP (PL), EU VAT ID (EU) or none (outside the EU). */
export const buyerInput = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('consumer'), name: text(200, 'imię i nazwisko'), address }),
  z.strictObject({ kind: z.literal('business'), name: text(200, 'nazwę firmy'), address, tax_id: z.string().max(40).default(''), pl_vat_payer: z.boolean().default(false) }),
]).superRefine((b, ctx) => {
  if (b.kind !== 'business') return;
  const c = b.address.country, issue = (message: string) => ctx.addIssue({ code: 'custom', path: ['tax_id'], message });
  if (c === 'PL') { if (!normalizeNip(b.tax_id)) issue('Niepoprawny NIP nabywcy (10 cyfr z cyfrą kontrolną)'); }
  else if (EU_VAT_PREFIX[c]) { if (b.tax_id.trim()) { const r = checkEuVatId(c, b.tax_id); if (!r.ok) issue(r.reason); } }
  else if (b.tax_id.trim()) issue('Nabywca spoza UE nie podaje NIP ani numeru VAT UE');
  if (b.pl_vat_payer && c !== 'PL') ctx.addIssue({ code: 'custom', path: ['pl_vat_payer'], message: 'Status czynnego podatnika VAT w Polsce dotyczy tylko nabywcy z Polski' });
});
export type BuyerInput = z.infer<typeof buyerInput>;
/** Stored buyer: the tax id normalized (NIP digits or prefixed VAT ID); `tax_id_kind` tells FA(3) Podmiot2 which element to use. */
export type Buyer = { kind: 'consumer' | 'business'; name: string; address: BuyerInput['address']; tax_id: string; tax_id_kind: 'nip' | 'eu_vat' | 'none'; pl_vat_payer: boolean };
export function normalizeBuyer(b: BuyerInput): Buyer {
  if (b.kind === 'consumer') return { kind: 'consumer', name: b.name, address: b.address, tax_id: '', tax_id_kind: 'none', pl_vat_payer: false };
  const c = b.address.country;
  if (c === 'PL') return { kind: 'business', name: b.name, address: b.address, tax_id: normalizeNip(b.tax_id)!, tax_id_kind: 'nip', pl_vat_payer: b.pl_vat_payer };
  const vat = EU_VAT_PREFIX[c] && b.tax_id.trim() ? checkEuVatId(c, b.tax_id) : null;
  return { kind: 'business', name: b.name, address: b.address, tax_id: vat?.ok ? vat.value : '', tax_id_kind: vat?.ok ? 'eu_vat' : 'none', pl_vat_payer: false };
}
/** What the 226 line rules need to know about the buyer. */
export const taxBuyerOf = (b: Buyer): TaxBuyer => ({ kind: b.kind, country: b.address.country, eu_vat_id: b.tax_id_kind === 'eu_vat', pl_vat_payer: b.pl_vat_payer });

/** Rate in hundredths of a percent ("19.00" → 1900, "5.5" → 550). */
export function rateHundredths(rate: string): bigint {
  const m = /^(\d{1,2})(?:\.(\d{1,2}))?$/.exec(rate);
  if (!m) throw new Error('Niepoprawna stawka VAT');
  return BigInt(m[1]!) * 100n + BigInt((m[2] ?? '').padEnd(2, '0'));
}
/** The 157 rule generalized to fractional rates: VAT = gross × r / (100 + r) rounded half up, net = gross − VAT. */
export function grossLineAmounts(grossMinor: bigint, rate: string | null): { net: bigint; vat: bigint } {
  if (grossMinor < 0n) throw new Error('Kwota pozycji nie może być ujemna');
  if (rate === null) return { net: grossMinor, vat: 0n };
  const r = rateHundredths(rate), vat = (2n * grossMinor * r + (10_000n + r)) / (2n * (10_000n + r));
  return { net: grossMinor - vat, vat };
}

/** FA(3) summary fields of each rate code (P_13_x net, P_14_x VAT). */
export const FA3_SUMMARY_FIELD: Readonly<Record<string, { net: string; vat: string | null; label: string }>> = Object.freeze({
  '23': { net: 'P_13_1', vat: 'P_14_1', label: '23%' }, '8': { net: 'P_13_2', vat: 'P_14_2', label: '8%' }, '5': { net: 'P_13_3', vat: 'P_14_3', label: '5%' },
  oss: { net: 'P_13_5', vat: 'P_14_5', label: 'OSS (stawka kraju nabywcy)' }, '0 KR': { net: 'P_13_6_1', vat: null, label: '0% (kraj)' },
  zw: { net: 'P_13_7', vat: null, label: 'zwolnione (zw)' }, 'np I': { net: 'P_13_8', vat: null, label: 'NP I — poza krajem' },
  'np II': { net: 'P_13_9', vat: null, label: 'NP II — art. 100 ust. 1 pkt 4' }, oo: { net: 'P_13_10', vat: null, label: 'odwrotne obciążenie (oo)' },
});

/** Order of the FA(3) summary (P_13_1 … P_13_10); a plain object would list the numeric keys first. */
const FA3_ORDER = ['23', '8', '5', 'oss', '0 KR', 'zw', 'np I', 'np II', 'oo'];

export type SourceLine = { kind: 'item' | 'shipping'; sku: string; name: string; vat_rate: number; gross_minor: string; profile: TaxProfile | null };
export type InvoiceSource = { buyer: Buyer; currency: 'PLN' | 'EUR'; sell_date: string; lines: readonly SourceLine[]; oss: OssState | null };
export type InvoiceLine = TaxLineFacts & { line_no: number; source_index: number; kind: SourceLine['kind']; sku: string; name: string; gross_minor: string; net_minor: string; vat_minor: string };
export type CategoryTotal = { key: string; rate_code: string; rate: string | null; fa3_net: string; fa3_vat: string | null; label: string; net_minor: string; vat_minor: string; gross_minor: string };
export type InvoiceMath = {
  lines: InvoiceLine[]; categories: CategoryTotal[]; totals: { net_minor: string; vat_minor: string; gross_minor: string };
  annex15_gross_minor: string; procedure: 'domestic' | 'oss'; reverse_charge: boolean; exemption: { kind: string; basis: string } | null;
};
export type InvoiceDecision = { math: InvoiceMath; blockers: string[] };

/** Shipping is ancillary to the goods: when every item line has the same special category (ZW/NP/OO),
 * the shipping line takes it; otherwise it is an ordinary line at the shipping rate (or OSS for an EU consumer). */
function shippingProfile(items: readonly TaxLineFacts[]): TaxProfile {
  const first = items[0];
  if (!first || first.category === 'standard' || !items.every(f => f.category === first.category && f.np_kind === first.np_kind && f.exemption_basis === first.exemption_basis)) return DEFAULT_TAX_PROFILE;
  return { ...DEFAULT_TAX_PROFILE, category: first.category, np_kind: first.np_kind, exemption_basis_kind: first.exemption_basis_kind, exemption_basis: first.exemption_basis };
}

/** Lines, category totals and refusals of an invoice. Every refusal is a Polish sentence; an invoice with refusals is not issued. */
export function invoiceMath(s: InvoiceSource): InvoiceDecision {
  const buyer = taxBuyerOf(s.buyer), blockers: string[] = [], lines: InvoiceLine[] = [], itemFacts: TaxLineFacts[] = [];
  const label = (l: SourceLine) => l.sku || l.name;
  const derived = s.lines.map(l => {
    if (l.kind === 'shipping') return null;
    const d = deriveLineTax({ kind: 'item', vat_rate: l.vat_rate, profile: l.profile ?? DEFAULT_TAX_PROFILE }, buyer, s.oss, s.sell_date);
    if ('facts' in d) itemFacts.push(d.facts);
    return d;
  });
  for (const [i, l] of s.lines.entries()) {
    let d = derived[i];
    if (!d) {
      const p = shippingProfile(itemFacts);
      d = p.category === 'standard' ? deriveLineTax({ kind: 'shipping', vat_rate: l.vat_rate, profile: p }, buyer, s.oss, s.sell_date)
        : deriveLineTax({ kind: 'item', vat_rate: l.vat_rate, profile: p }, buyer, s.oss, s.sell_date);
      if ('facts' in d) d = { facts: { ...d.facts, gtu: null, annex15: false, profile_version: null } };
      if ('refusal' in d && BigInt(l.gross_minor) === 0n) continue; // free shipping is left off a cross-border invoice
    }
    if ('refusal' in d) { blockers.push(`${label(l)}: ${d.refusal}`); continue; }
    const a = grossLineAmounts(BigInt(l.gross_minor), d.facts.rate_code === 'zw' || d.facts.rate_code.startsWith('np') || d.facts.rate_code === 'oo' ? null : d.facts.rate);
    lines.push({ ...d.facts, line_no: lines.length + 1, source_index: i, kind: l.kind, sku: l.sku, name: l.name, gross_minor: String(l.gross_minor), net_minor: String(a.net), vat_minor: String(a.vat) });
  }
  if (!lines.length && !blockers.length) blockers.push('Faktura nie ma pozycji');
  const bases = [...new Set(lines.filter(l => l.category === 'zw').map(l => `${l.exemption_basis_kind}|${l.exemption_basis}`))];
  if (bases.length > 1) blockers.push('Pozycje zwolnione mają różne podstawy zwolnienia — FA(3) przyjmuje jedną podstawę na fakturę; wystaw osobne faktury');
  if (lines.some(l => l.category === 'zw' && !l.exemption_basis)) blockers.push('Pozycja zwolniona (ZW) wymaga podstawy prawnej zwolnienia');
  const oss = lines.some(l => l.rate_code === 'oss');
  if (oss && s.currency !== 'PLN') blockers.push('Faktura OSS w walucie obcej nie jest jeszcze obsługiwana (deklaracja OSS przelicza kursem EBC) — wystaw ją w PLN');
  const groups = new Map<string, CategoryTotal>();
  let net = 0n, vat = 0n, annex = 0n;
  for (const l of lines) {
    const key = l.rate_code === 'oss' ? `oss ${l.rate}` : l.rate_code, f = FA3_SUMMARY_FIELD[l.rate_code];
    if (!f) { blockers.push(`${l.sku || l.name}: stawka ${l.rate_code} nie ma pola podsumowania FA(3)`); continue; }
    const g = groups.get(key) ?? { key, rate_code: l.rate_code, rate: l.rate, fa3_net: f.net, fa3_vat: f.vat, label: l.rate_code === 'oss' ? `OSS ${s.buyer.address.country} ${l.rate!.replace('.', ',')}%` : f.label, net_minor: '0', vat_minor: '0', gross_minor: '0' };
    g.net_minor = String(BigInt(g.net_minor) + BigInt(l.net_minor)); g.vat_minor = String(BigInt(g.vat_minor) + BigInt(l.vat_minor)); g.gross_minor = String(BigInt(g.gross_minor) + BigInt(l.gross_minor));
    groups.set(key, g);
    net += BigInt(l.net_minor); vat += BigInt(l.vat_minor);
    if (l.annex15) annex += BigInt(l.gross_minor);
  }
  const order = FA3_ORDER, categories = [...groups.values()].sort((a, b) => order.indexOf(a.rate_code) - order.indexOf(b.rate_code) || a.key.localeCompare(b.key));
  const z = lines.find(l => l.category === 'zw');
  return { blockers, math: { lines, categories, totals: { net_minor: String(net), vat_minor: String(vat), gross_minor: String(net + vat) }, annex15_gross_minor: String(annex),
    procedure: oss ? 'oss' : 'domestic', reverse_charge: lines.some(l => l.rate_code === 'oo' || l.rate_code === 'np II'),
    exemption: z ? { kind: z.exemption_basis_kind!, basis: z.exemption_basis! } : null } };
}

export type PlnCategory = CategoryTotal & { net_pln_minor: string; vat_pln_minor: string; gross_pln_minor: string };
/** 227 conversion applied per FA(3) category: net and VAT of each category rounded half up to a grosz, gross = their sum. */
export function plnCategories(categories: readonly CategoryTotal[], mid: string) {
  const m = midScaled(mid);
  let net = 0n, vat = 0n;
  const rows: PlnCategory[] = categories.map(c => {
    const n = toPlnMinor(BigInt(c.net_minor), m), v = toPlnMinor(BigInt(c.vat_minor), m);
    net += n; vat += v;
    return { ...c, net_pln_minor: String(n), vat_pln_minor: String(v), gross_pln_minor: String(n + v) };
  });
  return { rows, totals: { net_pln_minor: String(net), vat_pln_minor: String(vat), gross_pln_minor: String(net + vat) } };
}

/** MPP (art. 108a ust. 1a): B2B, at least one annex-15 line and the total due strictly over 15 000 zł,
 * a foreign-currency total compared after the 227 conversion. Without a rate the requirement cannot be decided. */
export function mppInPln(b: Buyer, math: InvoiceMath, currency: 'PLN' | 'EUR', mid: string | null): { required: boolean; reason: string; gross_pln_minor: string | null } {
  if (currency === 'PLN') return { ...mppRequirement(taxBuyerOf(b), BigInt(math.totals.gross_minor), BigInt(math.annex15_gross_minor)), gross_pln_minor: math.totals.gross_minor };
  if (mid === null) return { required: false, reason: 'Brak kursu NBP — nie można porównać kwoty z progiem 15 000 zł', gross_pln_minor: null };
  const pln = plnCategories(math.categories, mid).totals.gross_pln_minor;
  return { ...mppRequirement(taxBuyerOf(b), BigInt(pln), BigInt(math.annex15_gross_minor)), gross_pln_minor: pln };
}
