import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ensure, Problem } from './errors';
import { invalidDhl } from './carrier-dhl-xml';
// Field limits marked "unverified" come from public DHL24 WebAPI2 documentation and need a sandbox check
// (docs/parity/CARRIER-DHL-20261025.md, "Otwarte pytania").
export const DHL_MAX_WEIGHT_KG = 31.5;
export const DHL_MAX_COD_GROSZE = 1_100_000; // unverified: 11 000 PLN domestic COD limit
export const DHL_MAX_INSURANCE_GROSZE = 5_000_000; // unverified: 50 000 PLN declared value
export const DHL_PICKUP_MIN_WINDOW_MINUTES = 120; // unverified: minimum courier window
export const DHL_PICKUP_MAX_DAYS = 14;
const noControl = (v: string) => !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(v);
const line = (min: number, max: number) => z.string().trim().min(min).max(max).refine(noControl);
export const dhlPostcode = z
  .string()
  .trim()
  .regex(/^\d{2}-?\d{3}$/, 'Wymagany polski kod pocztowy (00-000)')
  .transform((v) => v.replace('-', ''));
// Same keys as the DPD address so later wiring reuses the buyer/sender forms unchanged.
const address = z.object({
  name: line(2, 60),
  address: line(3, 100),
  houseNumber: line(1, 10).optional(),
  apartmentNumber: line(1, 10).optional(),
  city: line(2, 50),
  postalCode: dhlPostcode,
  countryCode: z.literal('PL').default('PL'),
  phone: z.string().regex(/^\+?\d{9,15}$/, 'Nieprawidłowy telefon'),
  email: z.email().max(100),
});
export type DhlAddress = z.infer<typeof address>;
// NRB: 26 digits, ISO 13616 mod-97 checksum with country PL.
export function validNrb(v: string): boolean {
  const n = v.replace(/[\s-]/g, '').replace(/^PL/i, '');
  if (!/^\d{26}$/.test(n)) return false;
  const rearranged = n.slice(2) + '2521' + n.slice(0, 2); // P=25, L=21
  let rest = 0;
  for (const d of rearranged) rest = (rest * 10 + Number(d)) % 97;
  return rest === 1;
}
export const dhlInput = z
  .object({
    channel_id: z.uuid(),
    sender: address,
    receiver: address,
    weight: z.number().min(0.01).max(DHL_MAX_WEIGHT_KG).multipleOf(0.01),
    dimensions: z.object({
      length: z.number().int().min(1).max(175),
      width: z.number().int().min(1).max(175),
      height: z.number().int().min(1).max(175),
    }),
    content: line(2, 30),
    cod: z.number().int().min(0).max(DHL_MAX_COD_GROSZE).default(0),
    cod_bank_account: z.string().trim().optional(),
    insurance: z.number().int().min(0).max(DHL_MAX_INSURANCE_GROSZE).default(0),
    shipment_date: z.iso.date().optional(),
    comment: line(1, 100).optional(),
  })
  .refine((b) => b.insurance >= b.cod, 'Deklarowana wartość musi obejmować pobranie')
  .refine(
    (b) => !b.cod || (b.cod_bank_account !== undefined && validNrb(b.cod_bank_account)),
    'Pobranie wymaga poprawnego rachunku bankowego (NRB)',
  );
export type DhlInput = z.infer<typeof dhlInput>;
export function parseDhlInput(body: unknown): DhlInput {
  const r = dhlInput.safeParse(body);
  if (!r.success)
    throw new Problem(422, 'Nieprawidłowe dane przesyłki DHL: ' + r.error.issues[0].message, 'DHL_VALIDATION');
  return r.data;
}
// DHL24 wants street and house number separately; split "Prosta 5/12" when no explicit number is given.
export function splitStreet(a: DhlAddress): { street: string; houseNumber: string; apartmentNumber?: string } {
  if (a.houseNumber) return { street: a.address, houseNumber: a.houseNumber, apartmentNumber: a.apartmentNumber };
  const m = /^(.*\S)\s+(\d+[A-Za-z]?)(?:\s*(?:\/|m\.?|lok\.?)\s*(\d+[A-Za-z]?))?$/.exec(a.address);
  ensure(m, 422, 'Podaj ulicę z numerem domu (np. „Prosta 5/12”) albo osobny numer domu');
  return { street: m[1], houseNumber: m[2], ...(m[3] ? { apartmentNumber: m[3] } : {}) };
}
export const dhlFingerprint = (v: unknown): string =>
  createHash('sha256').update(JSON.stringify(v)).digest('hex');
// The idempotency key becomes the DHL reference, so a lost createShipments response is found by reference.
export function dhlReference(idempotencyKey: string): string {
  ensure(/^[A-Za-z0-9._:-]{8,100}$/.test(idempotencyKey), 422, 'Nieprawidłowy klucz idempotencji DHL');
  return 'DY' + createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 20).toUpperCase();
}
export function dhlConnection(ch: { provider: string; mode: string; settings: unknown; credentials: unknown }): string {
  return dhlFingerprint({ provider: ch.provider, mode: ch.mode, settings: ch.settings, credentials: ch.credentials });
}
export function dhlPdf(base64: unknown): Buffer {
  ensure(
    typeof base64 === 'string' &&
      base64.length > 0 &&
      base64.length <= 6 * 1024 * 1024 &&
      /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64),
    502,
    'Nieprawidłowa etykieta PDF DHL',
  );
  const pdf = Buffer.from(base64, 'base64');
  ensure(
    pdf.length > 0 &&
      pdf.length <= 4 * 1024 * 1024 &&
      pdf.subarray(0, 5).toString() === '%PDF-' &&
      pdf.toString('base64') === base64,
    502,
    'Nieprawidłowa etykieta PDF DHL',
  );
  return pdf;
}
const warsawFormat = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Europe/Warsaw',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});
export function warsawNow(now = new Date()): { date: string; clock: string } {
  const p = warsawFormat.format(now);
  return { date: p.slice(0, 10), clock: p.slice(11, 16) };
}
// DHL24 timestamps are Polish local time without an offset. The spring gap is rejected; the autumn overlap takes the later instant.
export function dhlEventTime(v: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(v.trim());
  if (!m) invalidDhl();
  const [, y, mo, d, h, mi, se = '00'] = m;
  const local = `${y}-${mo}-${d} ${h}:${mi}:${se}`;
  const base = Date.UTC(+y, +mo - 1, +d, +h, +mi, +se);
  if (new Date(base).toISOString().slice(0, 19) !== `${y}-${mo}-${d}T${h}:${mi}:${se}`) invalidDhl();
  const matches = [120, 60]
    .map((offset) => base - offset * 60000)
    .filter((t) => warsawFormat.format(new Date(t)) === local);
  if (!matches.length) invalidDhl();
  return new Date(Math.max(...matches)).toISOString();
}
const minutes = (hhmm: string) => +hhmm.slice(0, 2) * 60 + +hhmm.slice(3, 5);
export const dhlTime = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
export interface DhlPickupWindow {
  from: string;
  to: string;
  saturday: boolean;
}
// Courier booking: future, within 14 days, Mon–Fri (Saturday only when the postcode allows it),
// at least the minimum window, and inside the postcode's pickup hours when DHL24 returned them.
export function dhlPickupWindow(
  date: string,
  from: string,
  to: string,
  allowed?: DhlPickupWindow,
  now = new Date(),
): void {
  ensure(
    /^\d{4}-\d{2}-\d{2}$/.test(date) && dhlTime.safeParse(from).success && dhlTime.safeParse(to).success,
    422,
    'Podaj datę RRRR-MM-DD i godziny GG:MM odbioru DHL',
  );
  const { date: today, clock } = warsawNow(now);
  const day = Date.parse(date + 'T00:00:00Z');
  const days = (day - Date.parse(today + 'T00:00:00Z')) / 86400000;
  const weekday = new Date(day).getUTCDay();
  ensure(
    Number.isInteger(days) && days >= 0 && days <= DHL_PICKUP_MAX_DAYS && (days > 0 || from > clock),
    422,
    'Odbiór DHL musi być w przyszłości, najpóźniej za 14 dni, w czasie polskim',
  );
  ensure(
    weekday !== 0 && (weekday !== 6 || allowed?.saturday === true),
    422,
    'DHL odbiera przesyłki od poniedziałku do piątku (sobota tylko, gdy kod pocztowy na to pozwala)',
  );
  ensure(
    minutes(to) - minutes(from) >= DHL_PICKUP_MIN_WINDOW_MINUTES,
    422,
    `Okno odbioru DHL musi trwać co najmniej ${DHL_PICKUP_MIN_WINDOW_MINUTES / 60} godziny`,
  );
  if (allowed)
    ensure(
      from >= allowed.from && to <= allowed.to,
      422,
      `Kurier DHL odbiera pod tym kodem w godzinach ${allowed.from}–${allowed.to}`,
    );
}
// Provisional mapping of DHL24 track-and-trace codes to the app's tracking statuses (server/dpd-info.ts dpdStatus).
// The code list is unverified; unknown codes return null and never change the physical status.
const statuses: Record<string, string> = {
  PNO: 'confirmed',
  PODJ: 'collected_from_sender',
  SORT: 'in_transit',
  LP: 'in_transit',
  LK: 'in_transit',
  DWP: 'out_for_delivery',
  POP: 'ready_to_pickup',
  AWI: 'delivery_failed',
  BRG: 'delivery_failed',
  DOR: 'delivered',
  ZWN: 'return_in_transit',
  ZWD: 'returned_to_sender',
  ANUL: 'canceled',
};
export function dhlStatus(code: string): string | null {
  return statuses[code] ?? null;
}
export const dhlTerminal = ['delivered', 'returned_to_sender', 'canceled'];
