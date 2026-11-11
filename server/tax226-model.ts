/** Pure rules of the 226 tax model (no IO): product tax profile input, OSS input,
 * the tax category of a document line and the split payment (MPP) requirement.
 * Design: docs/parity/TAX-MODEL226-20261023.md. Invoice math stays in 157. */
import { z } from 'zod';

export const TAX_CATEGORIES = ['standard', 'zw', 'np', 'oo'] as const;
export const EXEMPTION_BASIS_KINDS = ['P_19A', 'P_19B', 'P_19C'] as const;
export const NP_KINDS = ['np_i', 'np_ii'] as const;
export const GTU_CODES = Array.from({ length: 13 }, (_, i) => 'GTU_' + String(i + 1).padStart(2, '0')) as readonly string[];
export const OSS_RATE_CLASSES = ['standard', 'reduced_1', 'reduced_2', 'super_reduced', 'zero'] as const;
/** EU member states other than PL (ISO 3166 codes; Greece = GR). */
export const OSS_COUNTRIES = ['AT', 'BE', 'BG', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI', 'FR', 'GR', 'HR', 'HU', 'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PT', 'RO', 'SE', 'SI', 'SK'] as const;
/** Art. 108a ust. 1a: MPP when the total due exceeds 15 000 PLN (minor units). */
export const MPP_THRESHOLD_MINOR = 1_500_000n;

export type TaxCategory = (typeof TAX_CATEGORIES)[number];
export type OssRateClass = (typeof OSS_RATE_CLASSES)[number];
export type TaxProfile = {
  version: number | null;
  category: TaxCategory;
  exemption_basis_kind: (typeof EXEMPTION_BASIS_KINDS)[number] | null;
  exemption_basis: string | null;
  np_kind: (typeof NP_KINDS)[number] | null;
  gtu: string | null;
  annex15: boolean;
  oss_rate_class: OssRateClass;
};
/** No 226 row: ordinary rate of the product, no GTU, not in annex 15. */
export const DEFAULT_TAX_PROFILE: TaxProfile = Object.freeze({
  version: null, category: 'standard', exemption_basis_kind: null, exemption_basis: null, np_kind: null, gtu: null, annex15: false, oss_rate_class: 'standard',
});

const basisText = z.string().trim().min(1, 'Podaj podstawę prawną zwolnienia').max(256, 'Podstawa prawna może mieć najwyżej 256 znaków');
export const taxProfileInput = z.strictObject({
  version: z.number().int().positive().nullable(),
  category: z.enum(TAX_CATEGORIES),
  exemption_basis_kind: z.enum(EXEMPTION_BASIS_KINDS).nullable().default(null),
  exemption_basis: basisText.nullable().default(null),
  np_kind: z.enum(NP_KINDS).nullable().default(null),
  gtu: z.enum(GTU_CODES as [string, ...string[]]).nullable(),
  annex15: z.boolean(),
  oss_rate_class: z.enum(OSS_RATE_CLASSES).default('standard'),
}).superRefine((v, ctx) => {
  const issue = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message });
  if (v.category === 'zw') {
    if (!v.exemption_basis_kind) issue('exemption_basis_kind', 'Zwolnienie wymaga wskazania rodzaju podstawy (P_19A, P_19B lub P_19C)');
    if (!v.exemption_basis) issue('exemption_basis', 'Zwolnienie wymaga podstawy prawnej');
  } else if (v.exemption_basis_kind || v.exemption_basis) issue('exemption_basis', 'Podstawę zwolnienia podaje się tylko dla kategorii ZW');
  if (v.category === 'np' && !v.np_kind) issue('np_kind', 'Wybierz rodzaj NP: NP I (poza krajem, bez art. 100 ust. 1 pkt 4 i OSS) albo NP II (usługi z art. 100 ust. 1 pkt 4 dla podatnika z UE)');
  if (v.category !== 'np' && v.np_kind) issue('np_kind', 'Rodzaj NP podaje się tylko dla kategorii NP');
});
export type TaxProfileInput = z.infer<typeof taxProfileInput>;

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => new Date(v + 'T00:00:00Z').toISOString().slice(0, 10) === v, 'Niepoprawna data');
export const ossSettingsInput = z.strictObject({
  version: z.number().int().positive().nullable(),
  registered: z.boolean(),
  registered_from: day.nullable(),
  rates: z.array(z.strictObject({
    country: z.enum(OSS_COUNTRIES),
    rate_class: z.enum(OSS_RATE_CLASSES),
    rate: z.number().min(0).max(30).refine(v => Math.round(v * 100) === v * 100, 'Stawka ma najwyżej dwa miejsca po przecinku'),
  })).max(OSS_COUNTRIES.length * OSS_RATE_CLASSES.length),
}).superRefine((v, ctx) => {
  if (v.registered !== (v.registered_from !== null)) ctx.addIssue({ code: 'custom', path: ['registered_from'], message: 'Rejestracja OSS wymaga daty początku (i tylko wtedy)' });
  const seen = new Set<string>();
  for (const [i, r] of v.rates.entries()) {
    const k = r.country + ':' + r.rate_class;
    if (seen.has(k)) ctx.addIssue({ code: 'custom', path: ['rates', i], message: `Stawka ${r.country} / ${r.rate_class} występuje dwa razy` });
    seen.add(k);
  }
});
export type OssSettingsInput = z.infer<typeof ossSettingsInput>;
export type OssState = { registered: boolean; registered_from: string | null; rates: { country: string; rate_class: string; rate: string }[] };

export type TaxBuyer = { kind: 'consumer' | 'business'; country: string; eu_vat_id?: boolean; pl_vat_payer?: boolean };
export type TaxLineInput = { kind: 'item' | 'shipping'; vat_rate: number; profile: TaxProfile };
export type TaxLineFacts = {
  category: TaxCategory; rate: string | null; rate_code: string;
  exemption_basis_kind: TaxProfile['exemption_basis_kind']; exemption_basis: string | null; np_kind: TaxProfile['np_kind'];
  gtu: string | null; annex15: boolean; profile_version: number | null;
};
export type TaxDecision = { facts: TaxLineFacts } | { refusal: string };
const rateText = (v: number) => v.toFixed(2);

/** Tax facts of one line, or the reason this sale cannot be documented that way. */
export function deriveLineTax(line: TaxLineInput, buyer: TaxBuyer, oss: OssState | null, sellDate: string): TaxDecision {
  const p = line.kind === 'shipping' ? DEFAULT_TAX_PROFILE : line.profile;
  const base = { exemption_basis_kind: null, exemption_basis: null, np_kind: null, gtu: line.kind === 'item' ? p.gtu : null,
    annex15: line.kind === 'item' && p.annex15, profile_version: line.kind === 'item' ? p.version : null };
  const domestic = buyer.country === 'PL', eu = (OSS_COUNTRIES as readonly string[]).includes(buyer.country);
  if (p.category === 'zw')
    return { facts: { ...base, category: 'zw', rate: null, rate_code: 'zw', exemption_basis_kind: p.exemption_basis_kind, exemption_basis: p.exemption_basis } };
  if (p.category === 'oo') {
    if (buyer.kind !== 'business' || !domestic || !buyer.pl_vat_payer)
      return { refusal: 'Odwrotne obciążenie (OO) wymaga nabywcy będącego czynnym podatnikiem VAT w Polsce' };
    return { facts: { ...base, category: 'oo', rate: null, rate_code: 'oo' } };
  }
  // FA(3) P_12: np I = outside PL except art. 100 ust. 1 pkt 4 and OSS; np II = art. 100 ust. 1 pkt 4 (art. 28b, buyer settles VAT).
  if (p.category === 'np') {
    if (p.np_kind === 'np_ii' && (buyer.kind !== 'business' || !eu || !buyer.eu_vat_id))
      return { refusal: 'NP II (usługi z art. 100 ust. 1 pkt 4) wymaga nabywcy będącego podatnikiem z numerem VAT UE spoza Polski' };
    if (p.np_kind === 'np_i' && domestic)
      return { refusal: 'NP I oznacza miejsce dostawy lub świadczenia poza Polską; nabywca z Polski wymaga zwykłej stawki lub zwolnienia' };
    return { facts: { ...base, category: 'np', rate: null, rate_code: p.np_kind === 'np_i' ? 'np I' : 'np II', np_kind: p.np_kind } };
  }
  if (buyer.kind === 'consumer' && eu) {
    if (!oss?.registered || !oss.registered_from || oss.registered_from > sellDate)
      return { refusal: `Sprzedaż wysyłkowa do konsumenta w ${buyer.country} wymaga rejestracji OSS ważnej w dniu sprzedaży` };
    const rateClass = line.kind === 'shipping' ? 'standard' : p.oss_rate_class, r = oss.rates.find(x => x.country === buyer.country && x.rate_class === rateClass);
    if (!r) return { refusal: `Brak stawki OSS dla ${buyer.country} (${rateClass}). Uzupełnij stawki kraju przeznaczenia` };
    return { facts: { ...base, category: 'standard', rate: rateText(Number(r.rate)), rate_code: 'oss' } };
  }
  if (!domestic) return { refusal: 'Sprzedaż poza Polskę (WDT, eksport) nie jest jeszcze obsługiwana' };
  return { facts: { ...base, category: 'standard', rate: rateText(line.vat_rate), rate_code: line.vat_rate === 0 ? '0 KR' : String(line.vat_rate) } };
}

/** Mandatory split payment: B2B, total gross over 15 000 PLN and at least one annex-15 line. */
export function mppRequirement(buyer: TaxBuyer, grossMinor: bigint, annex15GrossMinor: bigint): { required: boolean; reason: string } {
  if (annex15GrossMinor === 0n) return { required: false, reason: 'Brak towarów i usług z załącznika nr 15' };
  if (buyer.kind !== 'business') return { required: false, reason: 'Nabywca nie jest podatnikiem — MPP nie dotyczy' };
  if (grossMinor <= MPP_THRESHOLD_MINOR) return { required: false, reason: 'Kwota należności ogółem nie przekracza 15 000 zł' };
  return { required: true, reason: 'Obowiązkowy mechanizm podzielonej płatności (załącznik nr 15, ponad 15 000 zł, nabywca podatnik)' };
}
