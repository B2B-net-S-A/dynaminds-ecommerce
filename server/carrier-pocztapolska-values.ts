import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ensure } from './errors';

// Poczta Polska (eNadawca) input, limits and the stored shipment payload. Pure values:
// no database, no network. Limits marked "verify" come from public price lists and
// documentation and must be confirmed against the sandbox WSDL before live use.

export const PP_SERVICES = ['pocztex_kurier', 'paczka_pocztowa', 'pocztex_punkt'] as const;
export type PocztaPolskaService = (typeof PP_SERVICES)[number];
/** COD ceiling in grosze (verify: Pocztex pobranie limit per contract). */
export const PP_COD_MAX = 500000;
/** Declared value ceiling in grosze (verify). */
export const PP_INSURANCE_MAX = 5000000;
/** Max weight per service in kg (verify: Pocztex 2.0 30 kg, Paczka pocztowa 20 kg). */
export const PP_MAX_WEIGHT: Record<PocztaPolskaService, number> = {
  pocztex_kurier: 30,
  pocztex_punkt: 30,
  paczka_pocztowa: 20,
};
/** Pocztex 2.0 size classes, sorted dimensions in cm, longest first (verify). */
const POCZTEX_FORMATS: [string, [number, number, number]][] = [
  ['S', [65, 40, 9]],
  ['M', [65, 40, 20]],
  ['L', [65, 42, 40]],
  ['XL', [70, 60, 60]],
];
/** Field lengths in the eNadawca adresType (verify). */
export const PP_LIMITS = { name: 60, street: 60, house: 10, apartment: 10, city: 60, content: 100 };

const phone = z.string().regex(/^\+?\d{9,15}$/, 'Nieprawidłowy numer telefonu');
export const pocztaPolskaAddress = z.object({
  name: z.string().trim().min(2).max(PP_LIMITS.name),
  // Street with the house number ("Długa 5/3") or the street alone when houseNumber is given.
  address: z.string().trim().min(3).max(PP_LIMITS.street + PP_LIMITS.house + PP_LIMITS.apartment),
  houseNumber: z.string().trim().min(1).max(PP_LIMITS.house).optional(),
  apartment: z.string().trim().min(1).max(PP_LIMITS.apartment).optional(),
  city: z.string().trim().min(2).max(PP_LIMITS.city),
  postalCode: z
    .string()
    .regex(/^\d{2}-?\d{3}$/, 'Wymagany polski kod pocztowy')
    .transform((v) => v.replace('-', '')),
  countryCode: z.literal('PL').default('PL'),
  phone,
  email: z.email().max(100),
});
export type PocztaPolskaAddress = z.infer<typeof pocztaPolskaAddress>;

/** Unrefined fields, so wiring can `.extend({ packing })` before applying the checks. */
export const pocztaPolskaFields = z.object({
  channel_id: z.uuid(),
  service: z.enum(PP_SERVICES),
  sender: pocztaPolskaAddress,
  receiver: pocztaPolskaAddress,
  weight: z.number().min(0.01).max(30).multipleOf(0.01),
  dimensions: z.object({
    length: z.number().int().min(1).max(150),
    width: z.number().int().min(1).max(150),
    height: z.number().int().min(1).max(150),
  }),
  content: z.string().trim().min(2).max(PP_LIMITS.content),
  cod: z.number().int().min(0).max(PP_COD_MAX).default(0),
  cod_account: z.string().trim().optional(),
  insurance: z.number().int().min(0).max(PP_INSURANCE_MAX).default(0),
  pickup_point_id: z.string().regex(/^\d{1,10}$/, 'Nieprawidłowy identyfikator punktu').optional(),
  category: z.enum(['EKONOMICZNA', 'PRIORYTETOWA']).default('EKONOMICZNA'),
});
export type PocztaPolskaInput = z.infer<typeof pocztaPolskaFields>;

/** Polish NRB (26 digits, IBAN checksum with the PL prefix). Returns digits or null. */
export function polishNrb(v: string): string | null {
  const digits = v.replace(/^PL/i, '').replace(/[\s-]/g, '');
  if (!/^\d{26}$/.test(digits)) return null;
  const rearranged = digits.slice(2) + '2521' + digits.slice(0, 2);
  let rest = 0;
  for (const d of rearranged) rest = (rest * 10 + Number(d)) % 97;
  return rest === 1 ? digits : null;
}

const sorted = (d: PocztaPolskaInput['dimensions']) =>
  [d.length, d.width, d.height].sort((a, b) => b - a) as [number, number, number];

/** Pocztex 2.0 format or 2XL (longest ≤ 150, sum ≤ 300 cm); null above that. */
export function pocztexFormat(d: PocztaPolskaInput['dimensions']): string | null {
  const s = sorted(d);
  const found = POCZTEX_FORMATS.find(([, max]) => s.every((v, i) => v <= max[i]));
  if (found) return found[0];
  return s[0] <= 150 && s[0] + s[1] + s[2] <= 300 ? '2XL' : null;
}

/** Paczka pocztowa: gabaryt A ≤ 60×50×30, B: longest ≤ 150 and length + girth ≤ 300 cm. */
export function paczkaGabaryt(d: PocztaPolskaInput['dimensions']): string | null {
  const s = sorted(d);
  if (s[0] <= 60 && s[1] <= 50 && s[2] <= 30) return 'GABARYT_A';
  return s[0] <= 150 && s[0] + 2 * (s[1] + s[2]) <= 300 ? 'GABARYT_B' : null;
}

const STREET = /^(.+?)\s+(\d+[A-Za-z]?(?:-\d+[A-Za-z]?)?)(?:\s*(?:\/|m\.?\s*|lok\.?\s*)([0-9A-Za-z]{1,10}))?$/;
export type SplitStreet = { street: string; house: string; apartment: string | null };
/** eNadawca needs ulica, numerDomu and numerLokalu separately; never guess beyond a strict pattern. */
export function splitStreet(a: PocztaPolskaAddress): SplitStreet | null {
  if (a.houseNumber)
    return { street: a.address, house: a.houseNumber, apartment: a.apartment ?? null };
  const m = STREET.exec(a.address);
  if (!m) return null;
  const apartment = a.apartment ?? m[3] ?? null;
  if (m[1].length > PP_LIMITS.street || (apartment && apartment.length > PP_LIMITS.apartment))
    return null;
  return { street: m[1], house: m[2], apartment };
}

export function pocztaPolskaChecks(b: PocztaPolskaInput, ctx: z.RefinementCtx): void {
  const issue = (path: string, message: string) =>
    ctx.addIssue({ code: 'custom', path: path.split('.'), message });
  if (b.insurance < b.cod) issue('insurance', 'Deklarowana wartość musi obejmować pobranie');
  if (b.weight > PP_MAX_WEIGHT[b.service])
    issue('weight', `Masa przekracza ${PP_MAX_WEIGHT[b.service]} kg dla wybranej usługi`);
  if ((b.service === 'paczka_pocztowa' ? paczkaGabaryt : pocztexFormat)(b.dimensions) === null)
    issue('dimensions', 'Wymiary przekraczają gabaryt wybranej usługi Poczty Polskiej');
  if (b.cod > 0) {
    if (b.service === 'paczka_pocztowa')
      issue('cod', 'Pobranie jest dostępne tylko w usługach Pocztex');
    if (!b.cod_account || !polishNrb(b.cod_account))
      issue('cod_account', 'Pobranie wymaga prawidłowego numeru rachunku (NRB, 26 cyfr)');
  } else if (b.cod_account) issue('cod_account', 'Rachunek pobrania podano bez kwoty pobrania');
  if (b.service === 'pocztex_punkt' && !b.pickup_point_id)
    issue('pickup_point_id', 'Doręczenie do punktu wymaga wskazania punktu odbioru');
  if (b.service !== 'pocztex_punkt' && b.pickup_point_id)
    issue('pickup_point_id', 'Punkt odbioru dotyczy tylko usługi doręczenia do punktu');
  for (const side of ['sender', 'receiver'] as const)
    if (!splitStreet(b[side]))
      issue(`${side}.address`, 'Podaj ulicę i numer domu (np. „Długa 5/3”) albo numer domu osobno');
}
export const pocztaPolskaInput = pocztaPolskaFields.superRefine(pocztaPolskaChecks);

/** eNadawca guid (32 hex) derived from the plan id: the idempotency key of one creation. */
export function pocztaPolskaGuid(planId: string): string {
  ensure(z.uuid().safeParse(planId).success, 422, 'Nieprawidłowy identyfikator planu');
  return planId.replace(/-/g, '').toUpperCase();
}
export const PP_GUID = /^[0-9A-F]{32}$/;
export const PP_TRACKING_NUMBER = /^[A-Z0-9]{10,40}$/;

export type PocztaPolskaAddressPayload = {
  nazwa: string;
  ulica: string;
  numerDomu: string;
  numerLokalu: string | null;
  miejscowosc: string;
  kodPocztowy: string;
  kraj: 'Polska';
  telefon: string;
  email: string;
};
/** Stored plan payload; the client serialises exactly this to SOAP. */
export type PocztaPolskaShipment = {
  guid: string;
  reference: string;
  service: PocztaPolskaService;
  xsiType: 'pocztex2021KurierType' | 'paczkaPocztowaType';
  adres: PocztaPolskaAddressPayload;
  adresDlaZwrotu: PocztaPolskaAddressPayload;
  masa: number;
  format: string | null;
  gabaryt: string | null;
  kategoria: 'EKONOMICZNA' | 'PRIORYTETOWA' | null;
  wartosc: number | null;
  opis: string;
  pobranie: {
    sposobPobrania: 'RACHUNEK_BANKOWY';
    kwotaPobrania: number;
    nrb: string;
    tytulem: string;
  } | null;
  punktOdbioru: string | null;
};

function addressPayload(a: PocztaPolskaAddress): PocztaPolskaAddressPayload {
  const s = splitStreet(a);
  ensure(s, 422, 'Podaj ulicę i numer domu osobno');
  return {
    nazwa: a.name,
    ulica: s.street,
    numerDomu: s.house,
    numerLokalu: s.apartment,
    miejscowosc: a.city,
    kodPocztowy: a.postalCode,
    kraj: 'Polska',
    telefon: a.phone,
    email: a.email,
  };
}

/** Normalised input → eNadawca shipment. Call with already parsed input. */
export function pocztaPolskaShipment(planId: string, b: PocztaPolskaInput): PocztaPolskaShipment {
  const parsed = pocztaPolskaInput.parse(b);
  const guid = pocztaPolskaGuid(planId),
    reference = 'DYNA-' + planId;
  const paczka = parsed.service === 'paczka_pocztowa';
  return {
    guid,
    reference,
    service: parsed.service,
    xsiType: paczka ? 'paczkaPocztowaType' : 'pocztex2021KurierType',
    adres: addressPayload(parsed.receiver),
    adresDlaZwrotu: addressPayload(parsed.sender),
    masa: Math.round(parsed.weight * 1000),
    format: paczka ? null : pocztexFormat(parsed.dimensions),
    gabaryt: paczka ? paczkaGabaryt(parsed.dimensions) : null,
    kategoria: paczka ? parsed.category : null,
    wartosc: parsed.insurance || null,
    opis: parsed.content,
    pobranie: parsed.cod
      ? {
          sposobPobrania: 'RACHUNEK_BANKOWY',
          kwotaPobrania: parsed.cod,
          nrb: polishNrb(parsed.cod_account!)!,
          tytulem: reference.slice(0, 50),
        }
      : null,
    punktOdbioru: parsed.pickup_point_id ?? null,
  };
}

/** Digest of the approved account (credentials included); only the digest is stored in plans. */
export function pocztaPolskaConnection(ch: {
  provider: string;
  mode: string;
  settings: unknown;
  credentials: unknown;
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        provider: ch.provider,
        mode: ch.mode,
        settings: ch.settings,
        credentials: ch.credentials,
      }),
    )
    .digest('hex');
}

/** Canonical body hash: the same idempotency key must always carry the same shipment. */
export function pocztaPolskaBodyHash(s: PocztaPolskaShipment): string {
  const canon = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(canon)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((k) => [k, canon((v as Record<string, unknown>)[k])]),
          )
        : v;
  return createHash('sha256').update(JSON.stringify(canon(s))).digest('hex');
}

/** Base64 label → PDF bytes; same bounds as dpdPdf. */
export function pocztaPolskaPdf(base64: unknown): Buffer {
  const clean = typeof base64 === 'string' ? base64.replace(/\s+/g, '') : '';
  ensure(
    clean.length > 0 &&
      clean.length <= 6 * 1024 * 1024 &&
      /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(clean),
    502,
    'Nieprawidłowa etykieta PDF Poczty Polskiej',
  );
  const pdf = Buffer.from(clean, 'base64');
  ensure(
    pdf.length > 0 &&
      pdf.length <= 4 * 1024 * 1024 &&
      pdf.subarray(0, 5).toString() === '%PDF-' &&
      pdf.toString('base64') === clean,
    502,
    'Nieprawidłowa etykieta PDF Poczty Polskiej',
  );
  return pdf;
}
