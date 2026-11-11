/**
 * Channel data of an order in one normalized shape (lane L, Uwagi v3 automation conditions): buyer comment,
 * marketplace site, marketplace flags, ship-by date, payment operator, delivery method and parcel size.
 * Codes and Polish labels shared by the server projection (server/channel-projection.ts), the rule catalog,
 * the order list filter and the order card.
 */

/** Delivery groups of the order card section `delivery_method` and of order_sales_dimensions. */
export const DELIVERY_GROUPS = ['parcel_locker', 'pickup_point', 'courier', 'post', 'personal_pickup', 'digital', 'other', 'unknown'] as const;
export const DELIVERY_GROUP_LABELS: Record<string, string> = {
  parcel_locker: 'Paczkomat / automat paczkowy',
  pickup_point: 'Punkt odbioru',
  courier: 'Kurier',
  post: 'Poczta',
  personal_pickup: 'Odbiór osobisty',
  digital: 'Dostawa elektroniczna',
  other: 'Inny sposób dostawy',
  unknown: 'Brak danych o dostawie',
};
export const COD_SUFFIX = '_cod';

/** Delivery methods of Allegro as the buyer sees them; each code is `allegro:<slug of the name>`. */
export const ALLEGRO_DELIVERY_METHODS = [
  'Allegro Paczkomaty InPost',
  'Allegro Paczkomaty InPost pobranie',
  'Allegro Kurier24 InPost',
  'Allegro Kurier24 InPost pobranie',
  'Allegro One Box',
  'Allegro One Punkt',
  'Allegro One Kurier',
  'Allegro Kurier DPD',
  'Allegro Kurier DPD pobranie',
  'Allegro Odbiór w Punkcie DPD Pickup',
  'Allegro Kurier DHL',
  'Allegro Kurier DHL pobranie',
  'Allegro Odbiór w Punkcie DHL',
  'Allegro Automat ORLEN Paczka',
  'Allegro Odbiór w Punkcie ORLEN Paczka',
  'Allegro Kurier Pocztex',
  'Allegro Kurier Pocztex pobranie',
  'Allegro Odbiór w Punkcie Pocztex',
  'Allegro Przesyłka polecona',
  'Odbiór osobisty',
] as const;

const PL_FROM = 'ĄĆĘŁŃÓŚŹŻąćęłńóśźż';
const PL_TO = 'ACELNOSZZacelnoszz';
/** URL-safe code of a channel's delivery method name. The SQL twin is slugSql() in server/channel-projection.ts. */
export function methodSlug(label: string): string {
  let s = '';
  for (const ch of label) {
    const i = PL_FROM.indexOf(ch);
    s += i >= 0 ? PL_TO[i] : ch;
  }
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
export const SLUG_FROM = PL_FROM;
export const SLUG_TO = PL_TO;

/** True when the name already says cash on delivery ("… pobranie"). */
export const namesCod = (label: string) => /pobrani|za pobraniem|\bcod\b|cash on delivery/i.test(label);
/** Channel delivery method code; the cash on delivery variant carries "pobranie" in its name. */
export function channelMethodCode(provider: string, label: string, cod: boolean): { value: string; label: string } {
  const name = cod && !namesCod(label) ? label + ' pobranie' : label;
  return { value: provider + ':' + methodSlug(name), label: name };
}

/** A value of the order list filter "Sposób wysyłki": a group, a group with "_cod", or `<provider>:<slug>`. */
export function isDeliveryFilterCode(code: string): boolean {
  if ((DELIVERY_GROUPS as readonly string[]).includes(code)) return true;
  if (code.endsWith(COD_SUFFIX)) {
    const g = code.slice(0, -COD_SUFFIX.length);
    return g !== 'unknown' && (DELIVERY_GROUPS as readonly string[]).includes(g);
  }
  return /^[a-z0-9_]{1,40}:[a-z0-9]+(-[a-z0-9]+)*$/.test(code) && code.length <= 160;
}

export interface Option {
  group?: string;
  value: string;
  label: string;
}

/** Combined list of delivery methods: the shop's groups with their cash on delivery variants, then Allegro. */
export function deliveryMethodOptions(channelMethods: Array<{ provider: string; label: string }> = []): Option[] {
  const out: Option[] = [];
  for (const g of DELIVERY_GROUPS) {
    out.push({ group: 'Sklep i zamówienia ręczne', value: g, label: DELIVERY_GROUP_LABELS[g] });
    if (g !== 'unknown') out.push({ group: 'Sklep i zamówienia ręczne', value: g + COD_SUFFIX, label: DELIVERY_GROUP_LABELS[g] + ' — pobranie' });
  }
  const seen = new Set(out.map((o) => o.value));
  const add = (provider: string, label: string) => {
    for (const cod of [false, true]) {
      if (cod && namesCod(label)) continue;
      const m = channelMethodCode(provider, label, cod);
      if (!m.value.endsWith(':') && !seen.has(m.value)) {
        seen.add(m.value);
        out.push({ group: providerLabel(provider), value: m.value, label: m.label });
      }
    }
  };
  for (const name of ALLEGRO_DELIVERY_METHODS) add('allegro', name);
  for (const m of channelMethods) if (m.label) add(m.provider, m.label);
  return out;
}

export const PROVIDER_LABELS: Record<string, string> = {
  allegro: 'Allegro',
  woocommerce: 'WooCommerce',
  shopify: 'Shopify',
  prestashop: 'PrestaShop',
  amazon: 'Amazon',
  ebay: 'eBay',
  mirakl: 'Mirakl',
  odoo: 'Odoo',
  manual: 'Ręczne',
  demo: 'DEMO',
};
export const providerLabel = (p: string) => PROVIDER_LABELS[p] ?? p;

/** Marketplace sites ("Kraj / wersja serwisu"). Shop sites (the shop's own address) come from the channels. */
export const SITE_OPTIONS: Option[] = [
  ...['pl', 'cz', 'sk', 'hu'].map((c) => ({ group: 'Allegro', value: 'allegro.' + c, label: 'allegro.' + c })),
  ...['pl', 'de', 'fr', 'it', 'es', 'nl', 'se', 'com.be', 'co.uk', 'ie', 'com'].map((c) => ({ group: 'Amazon', value: 'amazon.' + c, label: 'amazon.' + c })),
  ...['pl', 'de', 'fr', 'it', 'es', 'at', 'co.uk', 'com'].map((c) => ({ group: 'eBay', value: 'ebay.' + c, label: 'ebay.' + c })),
];

export const FLAG_OPTIONS: Option[] = [
  { value: 'smart', label: 'Allegro Smart' },
  { value: 'express', label: 'Dostawa ekspresowa' },
  { value: 'business', label: 'Zamówienie firmowe' },
  { value: 'invoice', label: 'Kupujący chce fakturę' },
  { value: 'guest', label: 'Zakup bez konta' },
  { value: 'prime', label: 'Amazon Prime' },
  { value: 'fba', label: 'Realizacja Amazon (FBA)' },
  { value: 'b2b', label: 'Zamówienie B2B' },
  { value: 'replacement', label: 'Wysyłka zastępcza' },
];

export const OPERATOR_OPTIONS: Option[] = [
  { group: 'Operatorzy płatności', value: 'payu', label: 'PayU' },
  { group: 'Operatorzy płatności', value: 'przelewy24', label: 'Przelewy24' },
  { group: 'Operatorzy płatności', value: 'allegro_finance', label: 'Allegro Finanse' },
  { group: 'Operatorzy płatności', value: 'stripe', label: 'Stripe' },
  { group: 'Operatorzy płatności', value: 'paypal', label: 'PayPal' },
  { group: 'Operatorzy płatności', value: 'tpay', label: 'Tpay' },
  { group: 'Operatorzy płatności', value: 'blik', label: 'BLIK' },
  { group: 'Operatorzy płatności', value: 'imoje', label: 'imoje' },
  { group: 'Operatorzy płatności', value: 'autopay', label: 'Autopay (Blue Media)' },
  { group: 'Operatorzy płatności', value: 'paynow', label: 'Paynow' },
  { group: 'Operatorzy płatności', value: 'dotpay', label: 'Dotpay' },
  { group: 'Operatorzy płatności', value: 'klarna', label: 'Klarna' },
  { group: 'Operatorzy płatności', value: 'revolut', label: 'Revolut Pay' },
  { group: 'Operatorzy płatności', value: 'shopify_payments', label: 'Shopify Payments' },
  { group: 'Płatność w serwisie', value: 'amazon_pay', label: 'Amazon (płatność w serwisie)' },
  { group: 'Płatność w serwisie', value: 'ebay_payments', label: 'eBay (płatność w serwisie)' },
  { group: 'Płatność w serwisie', value: 'marketplace', label: 'Płatność w serwisie sprzedaży (operator nieznany)' },
  { group: 'Bez operatora', value: 'bank_transfer', label: 'Przelew na rachunek' },
  { group: 'Bez operatora', value: 'card', label: 'Karta (terminal)' },
  { group: 'Bez operatora', value: 'cash', label: 'Gotówka' },
  { group: 'Bez operatora', value: 'cod', label: 'Pobranie u przewoźnika' },
  { group: 'Bez operatora', value: 'other', label: 'Inny / nierozpoznany operator' },
];

/** InPost parcel locker sizes (gabaryt A/B/C, max 25 kg); "over" does not fit a locker. */
export const PARCEL_SIZES = [
  { value: 'A', label: 'Gabaryt A (8 × 38 × 64 cm)', heightCm: 8 },
  { value: 'B', label: 'Gabaryt B (19 × 38 × 64 cm)', heightCm: 19 },
  { value: 'C', label: 'Gabaryt C (41 × 38 × 64 cm)', heightCm: 41 },
] as const;
export const PARCEL_SIZE_OPTIONS: Option[] = [
  ...PARCEL_SIZES.map(({ value, label }) => ({ value, label })),
  { value: 'over', label: 'Większa niż gabaryt C (poza paczkomatem)' },
];

/** The projection returned to the order card (GET /api/orders/:id/channel-data). */
export interface ChannelDataField {
  key: string;
  label: string;
  /** Human value, '' when there is no data. */
  value: string;
  /** Where the value comes from, in Polish. */
  source: string;
}
export interface ChannelData {
  order_id: string;
  provider: string;
  fields: ChannelDataField[];
}
