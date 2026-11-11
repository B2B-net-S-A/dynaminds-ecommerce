/**
 * Filter panel of the order list (Uwagi v3 §3): the values a person types, their conversion to the
 * GET /api/orders parameters and to the page URL, and per-user storage of panel visibility and filter
 * templates. Pure, so it is tested without a browser.
 */
import { fulfilmentLabels, paymentLabels, type FulfilmentStage, type PaymentState } from './order-stage';
import { isDeliveryFilterCode } from '../shared/channel-projection';

/** Sposób wysyłki (order_sales_dimensions.delivery_method). */
export const deliveryLabels: Record<string, string> = {
  parcel_locker: 'Paczkomat',
  pickup_point: 'Punkt odbioru',
  courier: 'Kurier',
  post: 'Poczta',
  personal_pickup: 'Odbiór osobisty',
  digital: 'Wysyłka elektroniczna',
  other: 'Inny',
  unknown: 'Nieznany',
};

export type YesNo = '' | 'yes' | 'no';
export type SaleDocument = '' | 'invoice' | 'receipt' | 'none';

/** What the person typed; amounts in złote as typed ("12,50"), dates YYYY-MM-DD. */
export interface OrderFilters {
  number: string;
  external_id: string;
  channel: string[];
  status: FulfilmentStage[];
  customer: string;
  phone: string;
  email: string;
  allegro_login: string;
  city: string;
  postal_code: string;
  country: string;
  created_from: string;
  created_to: string;
  status_changed_from: string;
  status_changed_to: string;
  delivered_from: string;
  delivered_to: string;
  ean: string;
  sku: string;
  delivery: string[];
  shipping_from: string;
  shipping_to: string;
  payment: PaymentState[];
  total_from: string;
  total_to: string;
  currency: string;
  has_note: YesNo;
  has_comment: YesNo;
  sale_document: SaleDocument;
  has_return: YesNo;
}

export const emptyFilters: OrderFilters = Object.freeze({
  number: '',
  external_id: '',
  channel: [],
  status: [],
  customer: '',
  phone: '',
  email: '',
  allegro_login: '',
  city: '',
  postal_code: '',
  country: '',
  created_from: '',
  created_to: '',
  status_changed_from: '',
  status_changed_to: '',
  delivered_from: '',
  delivered_to: '',
  ean: '',
  sku: '',
  delivery: [],
  shipping_from: '',
  shipping_to: '',
  payment: [],
  total_from: '',
  total_to: '',
  currency: '',
  has_note: '',
  has_comment: '',
  sale_document: '',
  has_return: '',
}) as OrderFilters;

type Key = keyof OrderFilters;
const LIST_KEYS = ['channel', 'status', 'delivery', 'payment'] as const satisfies readonly Key[];
const MONEY_KEYS = ['shipping_from', 'shipping_to', 'total_from', 'total_to'] as const satisfies readonly Key[];
const CHOICES: Partial<Record<Key, readonly string[]>> = {
  status: Object.keys(fulfilmentLabels),
  payment: Object.keys(paymentLabels),
  delivery: Object.keys(deliveryLabels),
  has_note: ['yes', 'no'],
  has_comment: ['yes', 'no'],
  has_return: ['yes', 'no'],
  sale_document: ['invoice', 'receipt', 'none'],
};
const FILTER_KEYS = Object.keys(emptyFilters) as Key[];
const isList = (k: Key): k is (typeof LIST_KEYS)[number] => (LIST_KEYS as readonly Key[]).includes(k);
const isMoney = (k: Key) => (MONEY_KEYS as readonly Key[]).includes(k);

/** "12,50" / "12.5" / "1 200" → grosze; '' → undefined; anything else → null. */
export function parseMoney(value: string): number | null | undefined {
  const v = value.replace(/[\s ]/g, '').replace(',', '.');
  if (!v) return undefined;
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(v)) return null;
  return Math.round(Number(v) * 100);
}

const RANGES: [Key, Key, string][] = [
  ['created_from', 'created_to', 'Dodane'],
  ['status_changed_from', 'status_changed_to', 'Ost. zmiana statusu'],
  ['delivered_from', 'delivered_to', 'Data dostarczenia'],
  ['shipping_from', 'shipping_to', 'Koszt wysyłki'],
  ['total_from', 'total_to', 'Kwota'],
];

/** Problems to show before filtering; an empty list means the filters can be sent. */
export function filterProblems(f: OrderFilters): string[] {
  const problems: string[] = [];
  for (const k of MONEY_KEYS)
    if (parseMoney(f[k]) === null) problems.push(`${k.startsWith('total') ? 'Kwota' : 'Koszt wysyłki'}: wpisz kwotę, np. 12,50`);
  for (const [from, to, label] of RANGES) {
    const money = isMoney(from);
    const a = money ? parseMoney(f[from] as string) : (f[from] as string) || undefined;
    const b = money ? parseMoney(f[to] as string) : (f[to] as string) || undefined;
    if (a !== undefined && a !== null && b !== undefined && b !== null && a > b)
      problems.push(`${label}: wartość „od” jest większa niż „do”`);
  }
  return [...new Set(problems)];
}

/** GET /api/orders parameters of the filters (status excluded: it comes from the status panel). */
export function filtersToApiParams(f: OrderFilters): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of FILTER_KEYS) {
    if (k === 'status') continue;
    const v = f[k];
    if (isList(k)) {
      if ((v as string[]).length) out[k] = (v as string[]).join(',');
    } else if (isMoney(k)) {
      const grosze = parseMoney(v as string);
      if (typeof grosze === 'number') out[k] = String(grosze);
    } else if ((v as string).trim()) out[k] = (v as string).trim();
  }
  return out;
}

/** Number of filters that narrow the list (status included). */
export const activeFilterCount = (f: OrderFilters) =>
  FILTER_KEYS.filter((k) => (isList(k) ? (f[k] as string[]).length > 0 : (f[k] as string).trim() !== '')).length;

/** URL form: the same keys as the API, amounts as typed. Keys of other features are left alone. */
export function filtersToQuery(f: OrderFilters, base: URLSearchParams): URLSearchParams {
  const out = new URLSearchParams(base);
  for (const k of FILTER_KEYS) {
    out.delete(k);
    const v = f[k];
    if (isList(k)) {
      if ((v as string[]).length) out.set(k, (v as string[]).join(','));
    } else if ((v as string).trim()) out.set(k, (v as string).trim());
  }
  return out;
}

/** Filters read back from the URL or a stored template; unknown or malformed values are dropped. */
export function filtersFromQuery(q: URLSearchParams | Record<string, unknown>): OrderFilters {
  const get = (k: string): unknown => (q instanceof URLSearchParams ? q.get(k) : q[k]);
  const out: Record<string, unknown> = { ...emptyFilters };
  for (const k of FILTER_KEYS) {
    const raw = get(k);
    if (isList(k)) {
      const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : [];
      const choices = CHOICES[k];
      out[k] = [
        ...new Set(
          list.filter(
            (x): x is string =>
              typeof x === 'string' &&
              // Sposób wysyłki also takes cash on delivery variants and channel methods ("allegro:allegro-one-box").
              (k === 'delivery'
                ? isDeliveryFilterCode(x)
                : /^[a-z0-9_]{1,40}$/.test(x) && (!choices || choices.includes(x))),
          ),
        ),
      ].slice(0, 20);
    } else if (typeof raw === 'string') {
      const v = raw.slice(0, 120);
      const choices = CHOICES[k];
      if (!choices || choices.includes(v)) out[k] = v;
    }
  }
  return out as unknown as OrderFilters;
}

export const sameFilters = (a: OrderFilters, b: OrderFilters) =>
  JSON.stringify(filtersToQuery(a, new URLSearchParams()).toString()) ===
  JSON.stringify(filtersToQuery(b, new URLSearchParams()).toString());

// ── per-user storage ─────────────────────────────────────────────────────────────────────────────

/** contextKey = "tenant:user:role" → "dyna.orders.<tenant>.<user>.<name>". */
export function ordersStorageKey(contextKey: string, name: string) {
  const [tenant = '', user = ''] = contextKey.split(':');
  return `dyna.orders.${tenant}.${user}.${name}`;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}
const storage = (): StorageLike | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
};
export function readStored(key: string, s: StorageLike | null = storage()): string | null {
  try {
    return s?.getItem(key) ?? null;
  } catch {
    return null;
  }
}
/** False when the browser refused to store (private mode, quota). */
export function writeStored(key: string, value: string, s: StorageLike | null = storage()): boolean {
  try {
    if (!s) return false;
    s.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export interface FilterTemplate {
  id: string;
  name: string;
  filters: OrderFilters;
}
export const MAX_TEMPLATES = 30;

export function parseTemplates(raw: string | null): FilterTemplate[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value
      .filter((t) => t && typeof t.id === 'string' && typeof t.name === 'string' && t.filters && typeof t.filters === 'object')
      .slice(0, MAX_TEMPLATES)
      .map((t) => ({ id: t.id.slice(0, 60), name: t.name.slice(0, 60), filters: filtersFromQuery(t.filters) }));
  } catch {
    return [];
  }
}

/** Adds a template; a template with the same name (case-insensitive) is replaced. */
export function addTemplate(list: FilterTemplate[], name: string, filters: OrderFilters, id: string): FilterTemplate[] {
  const clean = name.trim().slice(0, 60);
  const rest = list.filter((t) => t.name.toLocaleLowerCase('pl') !== clean.toLocaleLowerCase('pl'));
  return [...rest, { id, name: clean, filters }].slice(-MAX_TEMPLATES);
}
export const removeTemplate = (list: FilterTemplate[], id: string) => list.filter((t) => t.id !== id);
