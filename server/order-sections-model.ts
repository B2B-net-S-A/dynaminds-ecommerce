/** Per-section order editing (Uwagi v3 §6) without a database: input validation of each section, the Polish
 * field labels of the history and the diff of a save. The HTTP contract is shared/order-sections.ts. */
import { z } from 'zod';
import type { SectionChange, SectionValues } from '../shared/order-sections';

export const EDITABLE_SECTIONS = ['customer', 'delivery_address', 'invoice', 'delivery_method', 'payment', 'extra'] as const;
export type EditableSection = (typeof EDITABLE_SECTIONS)[number];
export const isEditableSection = (s: string): s is EditableSection => (EDITABLE_SECTIONS as readonly string[]).includes(s);

export const DELIVERY_METHODS = ['parcel_locker', 'pickup_point', 'courier', 'post', 'personal_pickup', 'digital', 'other'] as const;
export const DELIVERY_METHOD_LABELS: Record<string, string> = {
  parcel_locker: 'Paczkomat / automat paczkowy',
  pickup_point: 'Punkt odbioru',
  courier: 'Kurier',
  post: 'Poczta',
  personal_pickup: 'Odbiór osobisty',
  digital: 'Dostawa elektroniczna',
  other: 'Inny',
};
export const PAYMENT_METHODS = ['transfer', 'online', 'cod', 'card', 'cash', 'marketplace', 'other'] as const;
export const PAYMENT_METHOD_LABELS: Record<string, string> = {
  transfer: 'Przelew',
  online: 'Płatność online',
  cod: 'Za pobraniem',
  card: 'Karta',
  cash: 'Gotówka',
  marketplace: 'Płatność w serwisie sprzedażowym',
  other: 'Inna',
};
export const PAYMENT_STATES = ['unpaid', 'paid', 'partial', 'cod'] as const;
export const PAYMENT_STATE_LABELS: Record<string, string> = {
  unpaid: 'Nieopłacone',
  paid: 'Opłacone',
  partial: 'Częściowo opłacone',
  cod: 'Pobranie',
};

/** Field labels of the history, per section. */
export const FIELD_LABELS: { [S in EditableSection]: Record<keyof SectionValues[S], string> } = {
  customer: { name: 'Imię i nazwisko', company: 'Firma', email: 'E-mail', phone: 'Telefon' },
  delivery_address: {
    recipient: 'Odbiorca',
    street: 'Ulica i numer',
    postal_code: 'Kod pocztowy',
    city: 'Miejscowość',
    country: 'Kraj',
    pickup_point: 'Punkt odbioru',
  },
  invoice: {
    wants_invoice: 'Faktura',
    buyer: 'Nabywca',
    nip: 'NIP',
    street: 'Ulica i numer',
    postal_code: 'Kod pocztowy',
    city: 'Miejscowość',
    country: 'Kraj',
  },
  delivery_method: { method: 'Sposób dostawy', carrier: 'Przewoźnik', cost: 'Koszt dostawy' },
  payment: { state: 'Status płatności', amount: 'Kwota', paid_at: 'Data wpłaty', reference: 'Tytuł / numer transakcji', method: 'Metoda płatności' },
  extra: { note: 'Notatka' },
};

/** Polish NIP: 10 digits, the last is the weighted checksum mod 11. */
export function validPolishNip(nip: string) {
  if (!/^\d{10}$/.test(nip)) return false;
  const w = [6, 5, 7, 2, 3, 4, 5, 6, 7];
  const sum = w.reduce((s, x, i) => s + x * Number(nip[i]), 0) % 11;
  return sum !== 10 && sum === Number(nip[9]);
}
/** Loose postal code shape per country; unknown countries only get a sane character set. */
const POSTAL: Record<string, RegExp> = {
  PL: /^\d{2}-\d{3}$/,
  DE: /^\d{5}$/,
  FR: /^\d{5}$/,
  IT: /^\d{5}$/,
  ES: /^\d{5}$/,
  CZ: /^\d{3} ?\d{2}$/,
  SK: /^\d{3} ?\d{2}$/,
  AT: /^\d{4}$/,
  NL: /^\d{4} ?[A-Z]{2}$/i,
  GB: /^[A-Z0-9]{2,4} ?[A-Z0-9]{3}$/i,
  US: /^\d{5}(-\d{4})?$/,
};
export function validPostalCode(code: string, country: string) {
  if (code === '') return true;
  return (POSTAL[country] ?? /^[A-Za-z0-9][A-Za-z0-9 -]{1,9}$/).test(code);
}

const expectedVersion = z.union([
  z.number({ error: 'Brak wersji zamówienia. Odśwież kartę zamówienia.' }).int().nonnegative().transform(String),
  z.string({ error: 'Brak wersji zamówienia. Odśwież kartę zamówienia.' }).regex(/^\d{1,30}$/, 'Nieprawidłowa wersja zamówienia'),
], { error: 'Brak wersji zamówienia. Odśwież kartę zamówienia.' });
const text = (max: number, label: string) =>
  z.string({ error: `${label}: podaj tekst` }).trim().max(max, `${label} może mieć najwyżej ${max} znaków`);
const country = z
  .string({ error: 'Podaj kod kraju' })
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{2}$/, 'Kraj podaj jako dwuliterowy kod, np. PL');
const phone = text(30, 'Telefon').regex(/^[0-9+()\s-]*$/, 'Telefon może zawierać tylko cyfry, spacje oraz znaki + - ( )');
const money = z
  .number({ error: 'Kwotę podaj jako liczbę groszy' })
  .int('Kwotę podaj w groszach (liczba całkowita)')
  .min(0, 'Kwota nie może być ujemna')
  .max(100000000, 'Za duża kwota');
const day = z
  .string()
  .trim()
  .refine((v) => v === '' || (/^\d{4}-\d{2}-\d{2}/.test(v) && !Number.isNaN(Date.parse(v))), 'Nieprawidłowa data wpłaty')
  .transform((v) => v.slice(0, 10));

/** Each section accepts any subset of its fields; the rest keeps the current value. */
const sectionInputs = {
  customer: z.strictObject({
    name: text(200, 'Imię i nazwisko'),
    company: text(200, 'Firma'),
    email: text(254, 'Adres e-mail').pipe(z.email('Nieprawidłowy adres e-mail').or(z.literal(''))),
    phone,
  }),
  delivery_address: z.strictObject({
    recipient: text(200, 'Odbiorca'),
    street: text(200, 'Ulica'),
    postal_code: text(20, 'Kod pocztowy'),
    city: text(100, 'Miejscowość'),
    country,
    pickup_point: text(30, 'Punkt odbioru').regex(/^[A-Za-z0-9_-]*$/, 'Kod punktu odbioru może zawierać tylko litery, cyfry, - i _'),
  }),
  invoice: z.strictObject({
    wants_invoice: z.boolean({ error: 'Faktura: podaj tak lub nie' }),
    buyer: text(200, 'Nabywca'),
    nip: text(20, 'NIP').transform((v) => v.replace(/[\s-]/g, '').toUpperCase()),
    street: text(200, 'Ulica'),
    postal_code: text(20, 'Kod pocztowy'),
    city: text(100, 'Miejscowość'),
    country,
  }),
  delivery_method: z.strictObject({
    method: z.enum(DELIVERY_METHODS, { error: 'Wybierz sposób dostawy z listy' }),
    carrier: text(80, 'Przewoźnik'),
    cost: money,
  }),
  payment: z.strictObject({
    state: z.enum(PAYMENT_STATES, { error: 'Wybierz status płatności z listy' }),
    amount: money,
    paid_at: day,
    reference: text(200, 'Tytuł / numer transakcji'),
    method: z.enum(PAYMENT_METHODS, { error: 'Wybierz metodę płatności z listy' }),
  }),
  extra: z.strictObject({ note: text(2000, 'Notatka') }),
} satisfies { [S in EditableSection]: z.ZodType };

export function sectionBody<S extends EditableSection>(section: S) {
  return z.strictObject({
    expected_version: expectedVersion,
    values: (sectionInputs[section] as unknown as z.ZodObject).partial(),
  }, { error: 'Podaj expected_version i values' });
}
export type SectionBody<S extends EditableSection> = { expected_version: string; values: Partial<SectionValues[S]> };

/** Cross-field rules after the merge with the current values; throws a ZodError like the boundary parse. */
export function checkMerged<S extends EditableSection>(
  section: S,
  v: SectionValues[S],
  ctx: { source: string; deliveryMethod?: string },
) {
  const issues: { path: string[]; message: string }[] = [];
  const add = (path: string, message: string) => issues.push({ path: ['values', path], message });
  if (section === 'customer') {
    const c = v as SectionValues['customer'];
    if (c.name.length < 2) add('name', 'Imię i nazwisko musi mieć co najmniej 2 znaki');
    if (c.email === '' && ctx.source !== 'amazon') add('email', 'Podaj adres e-mail klienta');
  }
  if (section === 'delivery_address') {
    const d = v as SectionValues['delivery_address'];
    if (!validPostalCode(d.postal_code, d.country)) add('postal_code', `Nieprawidłowy kod pocztowy dla kraju ${d.country}`);
    // A point on an address delivery makes the label module refuse the order (effectiveDelivery166: pickup_point_delivery).
    if (d.pickup_point && ctx.deliveryMethod && !['parcel_locker', 'pickup_point'].includes(ctx.deliveryMethod))
      add('pickup_point', 'Punkt odbioru wpiszesz przy dostawie do paczkomatu lub punktu odbioru — najpierw zmień sposób dostawy');
  }
  if (section === 'invoice') {
    const i = v as SectionValues['invoice'];
    if (i.nip !== '') {
      const nip = i.nip.startsWith('PL') ? i.nip.slice(2) : i.nip;
      if (i.country === 'PL' && !validPolishNip(nip)) add('nip', 'Nieprawidłowy NIP: podaj 10 cyfr z poprawną sumą kontrolną');
      if (i.country !== 'PL' && !/^[A-Z0-9]{2,20}$/.test(i.nip)) add('nip', 'Nieprawidłowy numer identyfikacji podatkowej');
    }
    if (i.wants_invoice) {
      if (i.buyer.length < 2) add('buyer', 'Podaj nazwę nabywcy faktury');
      if (!i.street) add('street', 'Podaj ulicę nabywcy faktury');
      if (!i.postal_code) add('postal_code', 'Podaj kod pocztowy nabywcy faktury');
      if (!i.city) add('city', 'Podaj miejscowość nabywcy faktury');
    }
    if (!validPostalCode(i.postal_code, i.country)) add('postal_code', `Nieprawidłowy kod pocztowy dla kraju ${i.country}`);
  }
  if (section === 'payment') {
    const p = v as SectionValues['payment'];
    if (p.paid_at && p.paid_at > new Date(Date.now() + 86400000).toISOString().slice(0, 10)) add('paid_at', 'Data wpłaty nie może być z przyszłości');
  }
  if (issues.length) throw new z.ZodError(issues.map((i) => ({ code: 'custom' as const, path: i.path, message: i.message, input: undefined })));
}

const money2 = (n: number, currency: string) => (n / 100).toFixed(2).replace('.', ',') + ' ' + currency;
/** Display text of one value in the history. */
export function displayValue(section: EditableSection, field: string, value: unknown, currency: string): string {
  if (typeof value === 'boolean') return value ? 'tak' : 'nie';
  if (section === 'delivery_method' && field === 'cost') return money2(Number(value), currency);
  if (section === 'payment' && field === 'amount') return money2(Number(value), currency);
  if (section === 'delivery_method' && field === 'method') return DELIVERY_METHOD_LABELS[String(value)] ?? String(value);
  if (section === 'payment' && field === 'method') return PAYMENT_METHOD_LABELS[String(value)] ?? String(value);
  if (section === 'payment' && field === 'state') return PAYMENT_STATE_LABELS[String(value)] ?? String(value);
  return value === null || value === undefined ? '' : String(value);
}
/** Changed fields of a save, in the order of the section's labels. */
export function sectionChanges<S extends EditableSection>(
  section: S,
  before: SectionValues[S],
  after: SectionValues[S],
  currency: string,
): SectionChange[] {
  const labels = FIELD_LABELS[section] as Record<string, string>;
  return Object.keys(labels)
    .filter((f) => (before as any)[f] !== (after as any)[f])
    .map((f) => ({
      field: f,
      label: labels[f]!,
      before: displayValue(section, f, (before as any)[f], currency),
      after: displayValue(section, f, (after as any)[f], currency),
    }));
}
