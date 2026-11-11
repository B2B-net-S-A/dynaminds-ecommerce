/** Pure logic of the order card (Uwagi v3 §4, §6): stage and payment fallbacks, section values,
 * form drafts, changes "pole: było → jest", locks, one-section-at-a-time editing, scan progress,
 * list neighbours and history filtering. No React, no HTTP. */
import {
  SECTION_LABELS,
  type OrderSection,
  type SectionChange,
  type SectionLock,
  type SectionLocks,
  type SectionValues,
} from '../shared/order-sections';
import { isFulfilmentStage, paymentLabels, type FulfilmentStage, type PaymentState } from './order-stage';
import { money } from './api';

export type Row = Record<string, any>;
export type EditableSection = Exclude<OrderSection, 'products'>;
export type FieldKind = 'text' | 'email' | 'tel' | 'money' | 'date' | 'select' | 'checkbox' | 'textarea';
export interface FieldOption {
  value: string;
  label: string;
}
export interface SectionField {
  field: string;
  label: string;
  kind: FieldKind;
  max?: number;
  options?: FieldOption[];
}
export type Draft = Record<string, string | boolean>;

export const PAYMENT_STATE_OPTIONS: FieldOption[] = (['unpaid', 'paid', 'partial', 'cod'] as const).map((value) => ({
  value,
  label: paymentLabels[value],
}));
// Same values as the server's zod enums (server/order-sections-model.ts DELIVERY_METHODS / PAYMENT_METHODS).
export const PAYMENT_METHOD_OPTIONS: FieldOption[] = [
  { value: 'transfer', label: 'Przelew' },
  { value: 'online', label: 'Płatność online' },
  { value: 'cod', label: 'Za pobraniem' },
  { value: 'card', label: 'Karta' },
  { value: 'cash', label: 'Gotówka' },
  { value: 'marketplace', label: 'Płatność w serwisie sprzedażowym' },
  { value: 'other', label: 'Inna' },
];
export const DELIVERY_METHOD_OPTIONS: FieldOption[] = [
  { value: 'parcel_locker', label: 'Paczkomat / automat paczkowy' },
  { value: 'pickup_point', label: 'Punkt odbioru' },
  { value: 'courier', label: 'Kurier' },
  { value: 'post', label: 'Poczta' },
  { value: 'personal_pickup', label: 'Odbiór osobisty' },
  { value: 'digital', label: 'Dostawa elektroniczna' },
  { value: 'other', label: 'Inny' },
];
/** Polish label of a delivery method code; free text from older data is shown as it is. */
export const deliveryMethodLabel = (value: string): string =>
  DELIVERY_METHOD_OPTIONS.find((m) => m.value === value)?.label ?? value;

export const SECTION_FIELDS: Record<EditableSection, SectionField[]> = {
  customer: [
    { field: 'name', label: 'Imię i nazwisko', kind: 'text', max: 200 },
    { field: 'company', label: 'Firma', kind: 'text', max: 200 },
    { field: 'email', label: 'E-mail', kind: 'email', max: 254 },
    { field: 'phone', label: 'Telefon', kind: 'tel', max: 30 },
  ],
  delivery_address: [
    { field: 'recipient', label: 'Odbiorca', kind: 'text', max: 200 },
    { field: 'street', label: 'Ulica i numer', kind: 'text', max: 200 },
    { field: 'postal_code', label: 'Kod pocztowy', kind: 'text', max: 20 },
    { field: 'city', label: 'Miejscowość', kind: 'text', max: 100 },
    { field: 'country', label: 'Kraj', kind: 'text', max: 2 },
    { field: 'pickup_point', label: 'Punkt odbioru', kind: 'text', max: 30 },
  ],
  invoice: [
    { field: 'wants_invoice', label: 'Klient chce fakturę', kind: 'checkbox' },
    { field: 'buyer', label: 'Nabywca', kind: 'text', max: 200 },
    { field: 'nip', label: 'NIP', kind: 'text', max: 20 },
    { field: 'street', label: 'Ulica i numer', kind: 'text', max: 200 },
    { field: 'postal_code', label: 'Kod pocztowy', kind: 'text', max: 20 },
    { field: 'city', label: 'Miejscowość', kind: 'text', max: 100 },
    { field: 'country', label: 'Kraj', kind: 'text', max: 2 },
  ],
  delivery_method: [
    { field: 'method', label: 'Sposób dostawy', kind: 'select', options: DELIVERY_METHOD_OPTIONS },
    { field: 'carrier', label: 'Przewoźnik', kind: 'text', max: 120 },
    { field: 'cost', label: 'Koszt dostawy', kind: 'money' },
  ],
  payment: [
    { field: 'state', label: 'Status płatności', kind: 'select', options: PAYMENT_STATE_OPTIONS },
    { field: 'amount', label: 'Kwota wpłaty', kind: 'money' },
    { field: 'paid_at', label: 'Data wpłaty', kind: 'date' },
    { field: 'reference', label: 'Nr transakcji', kind: 'text', max: 120 },
    { field: 'method', label: 'Forma płatności', kind: 'select', options: PAYMENT_METHOD_OPTIONS },
  ],
  extra: [{ field: 'note', label: 'Notatka zamówienia', kind: 'textarea', max: 2000 }],
};

export const sectionLabel = (section: OrderSection): string => SECTION_LABELS[section] ?? section;

/** Stage shown on the card: lane B's `fulfilment_stage`, else orders.status with the client-side
 * "Gotowe do nadania" rule (packed with a label that is not dispatched yet). */
export function cardStage(o: Row): FulfilmentStage | string {
  if (typeof o.fulfilment_stage === 'string' && isFulfilmentStage(o.fulfilment_stage)) return o.fulfilment_stage;
  const undispatched = (o.shipments ?? []).some((s: Row) => !s.dispatched_at);
  if (o.status === 'packed' && (o.shipping_active === true || undispatched)) return 'ready_to_ship';
  return String(o.status);
}

const PAYMENT_STATES: PaymentState[] = ['unpaid', 'paid', 'partial', 'overpaid', 'cod'];
/** Payment state: lane B's `payment_state`, else the server rule (server/order-stage.ts) on the
 * ledger balance in the payload. A replacement order has no payment. */
export function cardPaymentState(o: Row): PaymentState | null {
  if (o.fulfillment_kind === 'replacement') return null;
  if (PAYMENT_STATES.includes(o.payment_state)) return o.payment_state;
  const nominal = o.status === 'cancelled' ? 0 : Number(o.total ?? 0);
  const net = Number(o.payment?.net ?? o.payment?.received ?? 0);
  if (net > nominal) return 'overpaid';
  if (net >= nominal) return 'paid';
  if (o.payment_mode === 'cod') return 'cod';
  return net > 0 ? 'partial' : 'unpaid';
}

export const SOURCE_NAMES: Record<string, string> = {
  manual: 'Dodane ręcznie',
  demo: 'Dane demonstracyjne',
  allegro: 'Allegro',
  woocommerce: 'WooCommerce',
  b2b: 'Kontrahenci B2B',
  order_merge: 'Połączone zamówienia',
  prestashop: 'PrestaShop',
  shopify: 'Shopify',
  ebay: 'eBay',
  amazon: 'Amazon',
  mirakl: 'Mirakl',
  odoo: 'Odoo',
};
export const sourceName = (source: string): string => SOURCE_NAMES[source] ?? source;
const MARKETPLACES = new Set(['allegro', 'amazon', 'ebay', 'mirakl', 'woocommerce', 'prestashop', 'shopify']);
/** Client decision: an edit of a channel order stays local and is not sent to the channel. */
export function channelNote(o: Row): string | null {
  return MARKETPLACES.has(o.source)
    ? `Zmiana zostanie zapisana tylko w tym systemie — nie trafi do kanału ${sourceName(o.source)}.`
    : null;
}

export function deliveryMethodText(o: Row): string {
  const address = o.address ?? {};
  if (address.locker_code) return 'Punkt odbioru ' + address.locker_code;
  if (o.shipments?.[0]?.carrier) return 'Przesyłka ' + o.shipments[0].carrier;
  return 'Dostawa pod adres';
}

/** Initial values of a section: lane E's `section_values`, else derived from the order payload. */
export function sectionValuesOf<S extends EditableSection>(o: Row, section: S): SectionValues[S] {
  const given = o.section_values?.[section];
  if (given && typeof given === 'object') return given as SectionValues[S];
  const a = o.address ?? {};
  const derived: { [K in EditableSection]: SectionValues[K] } = {
    customer: { name: o.customer_name ?? '', company: o.company ?? a.company ?? '', email: o.email ?? '', phone: a.phone ?? '' },
    delivery_address: {
      recipient: a.recipient_name ?? a.recipient ?? o.customer_name ?? '',
      street: a.street ?? '',
      postal_code: a.postal_code ?? '',
      city: a.city ?? '',
      country: a.country ?? 'PL',
      pickup_point: a.locker_code ?? '',
    },
    invoice: {
      wants_invoice: Boolean(o.invoice?.wants_invoice),
      buyer: o.invoice?.buyer ?? o.customer_name ?? '',
      nip: o.invoice?.nip ?? '',
      street: o.invoice?.street ?? a.street ?? '',
      postal_code: o.invoice?.postal_code ?? a.postal_code ?? '',
      city: o.invoice?.city ?? a.city ?? '',
      country: o.invoice?.country ?? a.country ?? 'PL',
    },
    delivery_method: { method: o.address?.locker_code ? 'parcel_locker' : 'courier', carrier: o.shipments?.[0]?.carrier ?? '', cost: Number(o.shipping_cost ?? 0) },
    payment: {
      state: ((s) => (s === 'overpaid' || s === null ? 'paid' : s))(cardPaymentState(o)),
      amount: Number(o.payment?.received ?? 0),
      paid_at: '',
      reference: '',
      method: o.payment_mode === 'cod' ? 'cod' : 'transfer',
    },
    extra: { note: o.note ?? '' },
  };
  return derived[section] as SectionValues[S];
}

const grosze = (n: number): string => (Number(n) / 100).toFixed(2).replace('.', ',');
/** Form draft: strings for inputs (money as "12,50"), booleans for checkboxes. */
export function toDraft(section: EditableSection, values: Row): Draft {
  return Object.fromEntries(
    SECTION_FIELDS[section].map((f) => [
      f.field,
      f.kind === 'checkbox' ? Boolean(values[f.field]) : f.kind === 'money' ? grosze(values[f.field] ?? 0) : String(values[f.field] ?? ''),
    ]),
  );
}

export function parseMoney(text: string): number | null {
  const clean = text.replace(/\s/g, '').replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(clean)) return null;
  return Math.round(Number(clean) * 100);
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Values from a draft plus the person-facing problems; the server stays the authority. */
export function fromDraft(section: EditableSection, draft: Draft, o: Row = {}): { values: Row; errors: string[] } {
  const values: Row = {};
  const errors: string[] = [];
  for (const f of SECTION_FIELDS[section]) {
    const raw = draft[f.field];
    if (f.kind === 'checkbox') {
      values[f.field] = Boolean(raw);
      continue;
    }
    const text = String(raw ?? '').trim();
    if (f.max && text.length > f.max) errors.push(`${f.label}: najwyżej ${f.max} znaków.`);
    if (f.kind === 'money') {
      const amount = parseMoney(text || '0');
      if (amount === null) errors.push(`${f.label}: podaj kwotę, np. 12,50.`);
      values[f.field] = amount ?? 0;
    } else values[f.field] = text;
  }
  if (section === 'customer') {
    if (values.name.length < 2) errors.push('Imię i nazwisko: co najmniej 2 znaki.');
    if (!values.email && o.source !== 'amazon') errors.push('Podaj adres e-mail klienta.');
    if (values.email && !EMAIL.test(values.email)) errors.push('Nieprawidłowy adres e-mail.');
    if (!/^[0-9+()\s-]*$/.test(values.phone)) errors.push('Telefon może zawierać tylko cyfry, spacje oraz znaki + - ( ).');
  }
  if ((section === 'delivery_address' || section === 'invoice') && values.country && !/^[A-Za-z]{2}$/.test(values.country))
    errors.push('Kraj: dwuliterowy kod, np. PL.');
  if (section === 'delivery_address' && values.recipient.length < 2) errors.push('Odbiorca: co najmniej 2 znaki.');
  if (section === 'invoice' && values.wants_invoice) {
    if (values.buyer.length < 2) errors.push('Nabywca: co najmniej 2 znaki.');
    const nip = values.nip.replace(/[\s-]/g, '');
    if (nip && (values.country || 'PL').toUpperCase() === 'PL' && !/^\d{10}$/.test(nip)) errors.push('NIP: 10 cyfr.');
  }
  if (section === 'payment') {
    if (values.state === 'partial' && values.amount <= 0) errors.push('Przy częściowej płatności podaj wpłaconą kwotę.');
    if (values.paid_at && !/^\d{4}-\d{2}-\d{2}$/.test(values.paid_at)) errors.push('Data wpłaty: wybierz datę.');
  }
  if (values.country) values.country = String(values.country).toUpperCase();
  return { values, errors };
}

export function formatValue(f: SectionField, value: unknown, currency = 'PLN'): string {
  if (f.kind === 'checkbox') return value ? 'Tak' : 'Nie';
  if (f.kind === 'money') return money(Number(value ?? 0), currency);
  const text = String(value ?? '').trim();
  if (!text) return '—';
  if (f.options) return f.options.find((x) => x.value === text)?.label ?? text;
  return text;
}

const same = (f: SectionField, a: unknown, b: unknown): boolean =>
  f.kind === 'checkbox' ? Boolean(a) === Boolean(b) : f.kind === 'money' ? Number(a ?? 0) === Number(b ?? 0) : String(a ?? '').trim() === String(b ?? '').trim();
/** Only this section's changed fields, formatted for "pole: było → jest". */
export function sectionChanges(section: EditableSection, before: Row, after: Row, currency = 'PLN'): SectionChange[] {
  return SECTION_FIELDS[section]
    .filter((f) => !same(f, before[f.field], after[f.field]))
    .map((f) => ({ field: f.field, label: f.label, before: formatValue(f, before[f.field], currency), after: formatValue(f, after[f.field], currency) }));
}

export interface EditState {
  section: OrderSection;
  initial: Row;
  draft: Draft;
}
export function startEdit(o: Row, section: OrderSection): EditState {
  if (section === 'products') return { section, initial: {}, draft: {} };
  const initial = sectionValuesOf(o, section);
  return { section, initial, draft: toDraft(section, initial) };
}
/** A draft differs from its initial values (products save line by line, so never dirty). */
export function isDirty(edit: EditState | null): boolean {
  if (!edit || edit.section === 'products') return false;
  const initial = toDraft(edit.section, edit.initial);
  return SECTION_FIELDS[edit.section].some((f) => initial[f.field] !== edit.draft[f.field]);
}
/** Only one section is edited at a time: a dirty section first asks "Zapisz" / "Porzuć zmiany". */
export function requestEdit(current: EditState | null, target: OrderSection): 'open' | 'ask' | 'same' {
  if (current?.section === target) return 'same';
  return isDirty(current) ? 'ask' : 'open';
}

const unlocked: SectionLock = { locked: false };
/** Locks: lane E's `section_locks`, else the card's existing rules (lines before picking without an
 * invoice or shipment; buyer data until a label exists; invoice data until an invoice is issued). */
export function sectionLocks(o: Row): SectionLocks {
  const given = o.section_locks;
  const replacement = o.fulfillment_kind === 'replacement';
  const labelled = Boolean(o.shipping_active) || (o.shipments ?? []).length > 0;
  const open = ['new', 'paid', 'picking', 'packed'].includes(o.status);
  const buyer: SectionLock = labelled
    ? { locked: true, reason: 'Najpierw anuluj etykietę u przewoźnika', action: 'cancel_label' }
    : !open
      ? { locked: true, reason: 'Zamówienie jest już wysłane lub zamknięte' }
      : replacement
        ? { locked: true, reason: 'Dane wymiany reklamacyjnej zmienia się w zgłoszeniu' }
        : unlocked;
  const linesEditable = !replacement && ['new', 'paid'].includes(o.status) && !o.invoice_committed && !labelled;
  const invoiced = Boolean(o.invoice_committed) || (o.documents ?? []).some((d: Row) => (d.kind ?? 'invoice') === 'invoice');
  const fallback: SectionLocks = {
    customer: buyer,
    delivery_address: buyer,
    delivery_method: buyer,
    products: linesEditable ? unlocked : { locked: true, reason: 'Pozycje można zmieniać przed kompletacją, bez faktury i przesyłki' },
    invoice: invoiced ? { locked: true, reason: 'Zmiana tylko przez korektę', action: 'correction' } : unlocked,
    payment: replacement ? { locked: true, reason: 'Wymiana reklamacyjna nie ma płatności' } : unlocked,
    extra: unlocked,
  };
  if (!given || typeof given !== 'object') return fallback;
  return Object.fromEntries(
    (Object.keys(fallback) as OrderSection[]).map((k) => [k, given[k] && typeof given[k].locked === 'boolean' ? given[k] : fallback[k]]),
  ) as SectionLocks;
}

export interface ScanProgress {
  scanned: number;
  total: number;
  percent: number;
}
export function scanProgress(o: Row): ScanProgress {
  const rows: Row[] = o.picking_items ?? [];
  const scanned = rows.reduce((n, i) => n + Number(i.scanned ?? 0), 0);
  const total = rows.reduce((n, i) => n + Number(i.quantity ?? 0), 0);
  return { scanned, total, percent: total ? Math.round((scanned / total) * 100) : 0 };
}
/** Scan and bin locations of one order line (a set's components have their own picking rows). */
export function lineScan(o: Row, item: Row): { scanned: number; quantity: number; locations: string[] } | null {
  const rows = (o.picking_items ?? []).filter((p: Row) => p.product_id && p.product_id === item.product_id);
  if (!rows.length) return null;
  const locations = [...new Set<string>(rows.flatMap((p: Row) => (p.locations ?? []).map((b: Row) => String(b.location))))];
  return {
    scanned: rows.reduce((n: number, p: Row) => n + Number(p.scanned ?? 0), 0),
    quantity: rows.reduce((n: number, p: Row) => n + Number(p.quantity ?? 0), 0),
    locations,
  };
}

/** "1 POZYCJA", "2 POZYCJE", "5 POZYCJI". */
export function positionsLabel(n: number): string {
  const word = n === 1 ? 'POZYCJA' : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? 'POZYCJE' : 'POZYCJI';
  return `${n} ${word}`;
}

export function neighbours(ids: readonly string[] | undefined, id: string): { prev?: string; next?: string } {
  const i = ids ? ids.indexOf(id) : -1;
  if (!ids || i < 0) return {};
  return { prev: ids[i - 1], next: ids[i + 1] };
}

export type HistoryFilter = 'all' | OrderSection;
/** History newest first; a section filter keeps only that section's edits. */
export function historyEvents(events: Row[] | undefined, filter: HistoryFilter): Row[] {
  const list = [...(events ?? [])].reverse();
  return filter === 'all' ? list : list.filter((e) => e.kind === 'order.section_edited' && e.detail?.section === filter);
}
/** Sections that have at least one edit, for the "Sekcja" filter. */
export function editedSections(events: Row[] | undefined): OrderSection[] {
  const found = new Set<OrderSection>();
  for (const e of events ?? []) if (e.kind === 'order.section_edited' && e.detail?.section in SECTION_LABELS) found.add(e.detail.section);
  return [...found];
}
