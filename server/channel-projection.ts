/**
 * One normalized projection of the channel data of an order (shared/channel-projection.ts): buyer comment, site,
 * marketplace flags, ship-by date, payment operator, delivery method and parcel size.
 *
 * Read only from existing data (the orders table is sealed, no migration): the imported source document
 * (inbound_orders.raw), the delivery/payment labels of order_sales_dimensions (migration 247, optional), the order
 * card section edits (order_events 'order.section_edited'), the payments ledger, the latest shipping plan and the
 * product logistics of the lines. Manual and shop orders get the fallbacks: comment from the order note, operator
 * from the recorded payment or the payment form, delivery method from the card section with a cash on delivery
 * variant, parcel size from the dimensions and weight of the lines (InPost A/B/C).
 */
import type { PoolClient } from 'pg';
import {
  COD_SUFFIX,
  DELIVERY_GROUP_LABELS,
  FLAG_OPTIONS,
  OPERATOR_OPTIONS,
  PARCEL_SIZES,
  PARCEL_SIZE_OPTIONS,
  SLUG_FROM,
  SLUG_TO,
  channelMethodCode,
  providerLabel,
  type ChannelData,
} from '../shared/channel-projection';
import { orderSalesDimensions, type SalesDimensions } from './sales-dimensions';

type Row = Record<string, any>;
const obj = (v: unknown): Row => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Row) : {});
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const firstOf = (v: unknown): Row => obj(arr(v)[0]);
const MARKETPLACES = new Set(['allegro', 'amazon', 'ebay', 'mirakl']);
const SHOPS = new Set(['woocommerce', 'shopify', 'prestashop', 'odoo']);

function safeIso(v: unknown): string | null {
  if (typeof v !== 'string' || !v.trim()) return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

export interface ProjectionLine {
  quantity: number;
  weight_grams?: number | null;
  length_mm?: number | null;
  width_mm?: number | null;
  height_mm?: number | null;
}
export interface PaymentEntryFact {
  kind: string;
  method: string | null;
  reference: string | null;
}
export interface ProjectionInput {
  /** Channel provider of the order, or orders.source for manual orders. */
  provider: string;
  /** The imported source document; null for manual orders and orders without an inbound record. */
  raw: Row | null;
  order: { note?: string | null; address?: unknown; payment_mode: string; b2b_account_id?: string | null; fulfillment_kind?: string | null };
  channelSettings?: Row | null;
  /** order_sales_dimensions row, when the migration and the row exist. */
  dimensions?: SalesDimensions | null;
  edited?: { delivery_method?: Row; payment?: Row; invoice?: Row };
  /** Receipts of the ledger, newest first. */
  payments?: PaymentEntryFact[];
  /** Input of the latest shipping plan (carrier template). */
  planInput?: Row | null;
  lines?: ProjectionLine[];
}
export interface Projection {
  customer_comment: string;
  site: string;
  flags: string[];
  ship_by: string | null;
  payment_operator: string;
  /** Delivery group, its cash on delivery variant and the channel's own method code (list condition values). */
  shipping_method: string[];
  shipping_method_label: string;
  parcel_size: string;
  sources: Record<
    'customer_comment' | 'site' | 'flags' | 'ship_by' | 'payment_operator' | 'shipping_method' | 'parcel_size',
    string
  >;
}

// ── comment ──────────────────────────────────────────────────────────────────────────────────────

/** Buyer comment of the source document (Allegro, WooCommerce, Shopify, eBay, PrestaShop, Odoo). */
export function rawComment(raw: Row): string {
  return (
    str(raw.messageToSeller) ||
    str(raw.customer_note) ||
    str(raw.note) ||
    str(raw.buyerCheckoutNotes) ||
    str(firstOf(raw.messages).message) ||
    ''
  );
}

function comment(i: ProjectionInput, address: Row): [string, string] {
  const own = str(address.customer_comment);
  if (own) return [own, 'Komentarz kupującego zapisany w zamówieniu'];
  if (i.raw) {
    const c = rawComment(i.raw);
    return [c, c ? `Wiadomość kupującego z kanału ${providerLabel(i.provider)}` : `Kanał ${providerLabel(i.provider)} nie przekazał komentarza`];
  }
  const note = str(i.order.note);
  return [note, note ? 'Notatka zamówienia (zamówienie ręczne)' : 'Brak notatki zamówienia'];
}

// ── site ─────────────────────────────────────────────────────────────────────────────────────────

const AMAZON_SITES: Record<string, string> = {
  A1C3SOZRARQ6R3: 'amazon.pl', A1PA6795UKMFR9: 'amazon.de', A13V1IB3VIYZZH: 'amazon.fr', APJ6JRA9NG5V4: 'amazon.it',
  A1RKKUPIHCS9HS: 'amazon.es', A1805IZSGTT6HS: 'amazon.nl', A2NODRKZP88ZB9: 'amazon.se', AMEN7PMS3EDWL: 'amazon.com.be',
  A1F83G8C2ARO7P: 'amazon.co.uk', A28R8C7NBKEWEA: 'amazon.ie', ATVPDKIKX0DER: 'amazon.com',
};
const EBAY_SITES: Record<string, string> = { GB: 'ebay.co.uk', US: 'ebay.com', MOTORS: 'ebay.com' };

function host(url: unknown): string {
  try {
    return new URL(str(url)).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

function site(i: ProjectionInput, raw: Row): [string, string] {
  const p = i.provider;
  if (p === 'allegro') {
    const id = str(obj(raw.marketplace).id).toLowerCase();
    if (/^allegro-[a-z]{2}$/.test(id)) return ['allegro.' + id.slice(8), 'Serwis Allegro z zamówienia'];
    return ['allegro.pl', 'Allegro bez wskazania serwisu: allegro.pl'];
  }
  if (p === 'amazon') {
    const id = str(obj(raw.salesChannel).marketplaceId) || str(raw.MarketplaceId) || str(raw.marketplaceId);
    if (AMAZON_SITES[id]) return [AMAZON_SITES[id], 'Rynek Amazon z zamówienia'];
    const name = str(obj(raw.salesChannel).marketplaceName).toLowerCase();
    return [name || 'amazon', name ? 'Rynek Amazon z zamówienia' : 'Amazon nie wskazał rynku'];
  }
  if (p === 'ebay') {
    const id = str(firstOf(raw.lineItems).purchaseMarketplaceId) || str(firstOf(raw.lineItems).listingMarketplaceId) || str(raw.salesMarketplaceId);
    const cc = /^EBAY_([A-Z]+)$/.exec(id)?.[1];
    if (cc) return [EBAY_SITES[cc] ?? 'ebay.' + cc.toLowerCase(), 'Rynek eBay z zamówienia'];
    return ['ebay', 'eBay nie wskazał rynku'];
  }
  if (p === 'mirakl') {
    const h = host(i.channelSettings?.instance_url), code = str(obj(raw.channel).code).toLowerCase();
    return [[h || 'mirakl', code].filter(Boolean).join('/'), 'Operator Mirakl z ustawień kanału i kanał z zamówienia'];
  }
  if (SHOPS.has(p)) {
    const h = host(i.channelSettings?.store_url);
    return [h || p, h ? 'Adres sklepu z ustawień kanału' : 'Kanał bez adresu sklepu'];
  }
  return ['', 'Zamówienie ręczne — bez serwisu sprzedaży'];
}

// ── flags ────────────────────────────────────────────────────────────────────────────────────────

const EXPRESS = /ekspres|express|expedited|next ?day|same ?day|priority|nazajutrz|24 ?h\b/i;

function invoiceFacts(i: ProjectionInput, raw: Row, address: Row) {
  const edited = i.edited?.invoice ? obj(i.edited.invoice) : null;
  const inv = edited ?? obj(address.invoice);
  const allegroCompany = obj(obj(obj(raw.invoice).address).company);
  const nip = str(inv.nip) || str(address.nip) || str(address.tax_id) || str(allegroCompany.taxId) || str(obj(raw.billing).nip);
  const company =
    str(inv.buyer && nip ? inv.buyer : '') || str(address.company) || str(allegroCompany.name) || str(obj(raw.buyer).companyName) ||
    str(obj(raw.billing).company) || str(obj(raw.billing_address).company);
  const wants =
    typeof inv.wants_invoice === 'boolean' ? inv.wants_invoice
      : typeof address.wants_invoice === 'boolean' ? address.wants_invoice
        : obj(raw.invoice).required === true || Boolean(nip);
  return { nip, company, wants };
}

function flags(i: ProjectionInput, raw: Row, address: Row, deliveryLabel: string): [string[], string] {
  const out = new Set<string>();
  const from: string[] = [];
  const p = i.provider;
  if (p === 'allegro') {
    if (obj(raw.delivery).smart === true) out.add('smart');
    if (obj(raw.buyer).guest === true) out.add('guest');
    if (obj(raw.buyer).company === true || str(obj(raw.buyer).companyName) || str(obj(obj(obj(raw.invoice).address).company).taxId)) out.add('business');
    from.push('dane Allegro (Smart, firma, faktura)');
  } else if (p === 'amazon') {
    const programs = arr(raw.programs).map(String);
    if (raw.IsPrime === true || raw.isPrime === true || programs.includes('PRIME')) out.add('prime');
    if (raw.IsBusinessOrder === true || raw.isBusinessOrder === true || programs.includes('AMAZON_BUSINESS')) out.add('business');
    if (str(raw.FulfillmentChannel) === 'AFN' || str(obj(raw.fulfillment).fulfilledBy) === 'AMAZON') out.add('fba');
    const level = str(raw.ShipmentServiceLevelCategory) || str(raw.shipmentServiceLevelCategory) || str(obj(raw.fulfillment).fulfillmentServiceLevel);
    if (/expedited|nextday|next_day|sameday|same_day|priority/i.test(level)) out.add('express');
    from.push('dane Amazon (Prime, Business, FBA)');
  } else if (p === 'mirakl') {
    if (EXPRESS.test(str(raw.shipping_type_code))) out.add('express');
  }
  if (EXPRESS.test(deliveryLabel)) out.add('express');
  const inv = invoiceFacts(i, raw, address);
  if (inv.wants) out.add('invoice');
  if (inv.nip || inv.company) out.add('business');
  if (i.order.b2b_account_id) out.add('b2b');
  if (i.order.fulfillment_kind === 'replacement') out.add('replacement');
  from.push('sposób dostawy (ekspres), dane do faktury (NIP, firma)');
  const order = FLAG_OPTIONS.map((f) => f.value);
  const source = from.join('; ');
  return [[...out].sort((a, b) => order.indexOf(a) - order.indexOf(b)), source.charAt(0).toUpperCase() + source.slice(1)];
}

// ── ship by ──────────────────────────────────────────────────────────────────────────────────────

function shipBy(i: ProjectionInput, raw: Row): [string | null, string] {
  const p = i.provider;
  let v: string | null = null;
  if (p === 'allegro') v = safeIso(obj(obj(obj(raw.delivery).time).dispatch).to);
  else if (p === 'amazon')
    v = safeIso(raw.LatestShipDate) ?? safeIso(raw.latestShipDate) ?? safeIso(obj(obj(raw.fulfillment).shipByWindow).latestDateTime);
  else if (p === 'ebay') {
    const all = arr(raw.lineItems).map((l) => safeIso(obj(obj(l).lineItemFulfillmentInstructions).shipByDate)).filter((x): x is string => !!x);
    v = all.sort()[0] ?? null;
  } else if (p === 'mirakl') v = safeIso(raw.shipping_deadline);
  if (v) return [v, `Termin „wyślij do” z kanału ${providerLabel(p)}`];
  return [null, MARKETPLACES.has(p) ? `Kanał ${providerLabel(p)} nie przekazał terminu wysyłki` : 'Termin wysyłki podają tylko serwisy sprzedaży'];
}

// ── payment operator ─────────────────────────────────────────────────────────────────────────────

const OPERATOR_RULES: [string, RegExp][] = [
  ['allegro_finance', /allegro ?financ|allegro ?finans/],
  ['przelewy24', /przelewy ?24|\bp24\b/],
  ['payu', /payu/],
  ['stripe', /stripe/],
  ['paypal', /paypal|ppcp/],
  ['tpay', /tpay|transferuj/],
  ['imoje', /imoje|ing ?pay/],
  ['autopay', /autopay|blue ?media|bluemedia/],
  ['paynow', /paynow/],
  ['dotpay', /dotpay/],
  ['klarna', /klarna/],
  ['revolut', /revolut/],
  ['shopify_payments', /shopify[_ ]payments/],
  ['blik', /blik/],
  ['cod', /pobrani|\bcod\b|cash ?on ?delivery|cashondelivery|przy odbiorze/],
  ['bank_transfer', /\bbacs\b|wirepayment|przelew trad|przelew bank|bank ?transfer|przelew na (konto|rachunek)/],
  ['cash', /gotowk|gotówk|\bcash\b/],
];
const fold = (v: string) => v.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ł/g, 'l').toLowerCase();
/** Operator code named in a payment label or reference; '' when none is recognised. */
export function detectOperator(text: string): string {
  const v = fold(text);
  if (!v.trim()) return '';
  for (const [code, re] of OPERATOR_RULES) if (re.test(v)) return code;
  return '';
}
const ALLEGRO_PROVIDERS: Record<string, string> = { P24: 'przelewy24', PAYU: 'payu', AF: 'allegro_finance', AF_P24: 'allegro_finance', AF_PAYU: 'allegro_finance' };
const ENTRY_METHODS: Record<string, string> = {
  payu: 'payu', bank_transfer: 'bank_transfer', bank_csv: 'bank_transfer', cash: 'cash', card: 'card', courier_csv: 'cod', bank_csv_cod: 'cod',
};
const FORM_OPERATORS: Record<string, string> = { transfer: 'bank_transfer', cash: 'cash', card: 'card', cod: 'cod', marketplace: 'marketplace', online: 'other', other: 'other' };

function operator(i: ProjectionInput, raw: Row): [string, string] {
  const p = i.provider;
  if (i.raw) {
    let code = '', label = '';
    if (p === 'allegro') {
      const pay = obj(raw.payment);
      if (pay.type === 'CASH_ON_DELIVERY') code = 'cod';
      else code = ALLEGRO_PROVIDERS[str(pay.provider).toUpperCase()] ?? '';
      label = str(pay.provider);
      // An online payment without a named provider is still collected by Allegro.
      if (!code && !label && pay.type === 'ONLINE') return ['marketplace', 'Płatność online w Allegro bez wskazania operatora'];
    } else if (p === 'amazon') code = 'amazon_pay';
    else if (p === 'ebay') code = 'ebay_payments';
    else if (p === 'mirakl') code = 'marketplace';
    else if (p === 'woocommerce') {
      label = [str(raw.payment_method), str(raw.payment_method_title)].join(' ');
      code = detectOperator(label);
    } else if (p === 'shopify') {
      label = arr(raw.payment_gateway_names).map(String).join(', ');
      code = detectOperator(label);
    } else if (p === 'prestashop') {
      label = [str(raw.module), str(raw.payment)].join(' ');
      code = detectOperator(label);
    }
    if (code) return [code, `Operator z danych kanału ${providerLabel(p)}`];
    if (label.trim() && !i.dimensions?.payment_label) return ['other', `Nierozpoznany operator z kanału: ${label.trim().slice(0, 80)}`];
  }
  const dl = str(i.dimensions?.payment_label);
  const fromLabel = detectOperator(dl);
  if (fromLabel) return [fromLabel, 'Opis płatności z importu zamówienia'];
  for (const e of i.payments ?? []) {
    const m = str(e.method);
    if (['source_import', 'source_sync', 'status_confirmation', 'correction'].includes(m)) continue;
    const code = detectOperator(str(e.reference)) || (e.kind === 'courier_collection' ? 'cod' : ENTRY_METHODS[m] ?? '');
    if (code) return [code, 'Zarejestrowana wpłata'];
    if (m === 'other') return ['other', 'Zarejestrowana wpłata (inna forma)'];
  }
  if (i.order.payment_mode === 'cod') return ['cod', 'Zamówienie za pobraniem'];
  const form = str(obj(i.edited?.payment).method) || str(i.dimensions?.payment_method);
  if (FORM_OPERATORS[form]) return [FORM_OPERATORS[form], 'Forma płatności zamówienia'];
  if (dl) return ['other', `Nierozpoznany operator: ${dl.slice(0, 80)}`];
  return ['', 'Brak wpłaty i formy płatności'];
}

// ── delivery method ──────────────────────────────────────────────────────────────────────────────

/** InPost parcel locker code (e.g. KRA01M, WAW123A); other pickup point codes are a pickup point. */
export const LOCKER_CODE = /^[A-Z]{3}\d{2,3}[A-Z]{1,2}$/i;

function method(i: ProjectionInput, address: Row): { values: string[]; label: string; source: string } {
  const cod = i.order.payment_mode === 'cod';
  const edited = str(obj(i.edited?.delivery_method).method);
  const dims = i.dimensions ?? (i.raw && i.provider ? orderSalesDimensions(i.provider, i.raw, i.order) : null);
  const locker = str(address.locker_code) || str(address.pickup_point);
  let group = edited || (dims && dims.delivery_method !== 'unknown' ? dims.delivery_method : '');
  let source = edited ? 'Sekcja „Sposób dostawy” karty zamówienia' : group ? `Sposób dostawy z kanału ${providerLabel(i.provider)}` : '';
  if (!group && locker) {
    group = LOCKER_CODE.test(locker) ? 'parcel_locker' : 'pickup_point';
    source = 'Punkt odbioru w adresie dostawy';
  }
  if (!group) {
    group = 'unknown';
    source = 'Brak danych o sposobie dostawy';
  }
  const values = [group, ...(cod && group !== 'unknown' ? [group + COD_SUFFIX] : [])];
  const channelLabel = !edited ? str(dims?.delivery_label) : '';
  if (channelLabel && i.provider) {
    const m = channelMethodCode(i.provider, channelLabel, cod);
    values.push(m.value);
    return { values, label: m.label, source: source + ' (nazwa metody z kanału)' };
  }
  const label = DELIVERY_GROUP_LABELS[group] + (cod && group !== 'unknown' ? ' — pobranie' : '');
  return { values, label, source: source + (cod ? '; pobranie z formy płatności' : '') };
}

// ── parcel size ──────────────────────────────────────────────────────────────────────────────────

const TEMPLATE_SIZES: Record<string, string> = { small: 'A', medium: 'B', large: 'C', a: 'A', b: 'B', c: 'C', xlarge: 'over' };
const MAX_LOCKER_GRAMS = 25000;

/**
 * Parcel size of the lines stacked flat: the longest and middle sides are the largest of any unit, the heights add
 * up. Fits the smallest InPost size whose box (64 × 38 × 8/19/41 cm) holds it, up to 25 kg. '' without dimensions.
 */
export function parcelSizeOf(lines: ProjectionLine[]): string {
  if (!lines.length) return '';
  const weights = lines.map((l) => (l.weight_grams ? l.weight_grams * l.quantity : null));
  const weight = weights.every((w) => w !== null) ? weights.reduce((s, w) => s + (w as number), 0) : null;
  if (weight !== null && weight > MAX_LOCKER_GRAMS) return 'over';
  if (lines.some((l) => !l.length_mm || !l.width_mm || !l.height_mm)) return '';
  let long = 0, mid = 0, height = 0;
  for (const l of lines) {
    const [a, b, c] = [l.length_mm!, l.width_mm!, l.height_mm!].sort((x, y) => y - x);
    long = Math.max(long, a);
    mid = Math.max(mid, b);
    height += c * l.quantity;
  }
  const [x, y, z] = [long, mid, height].sort((p, q) => q - p);
  for (const s of PARCEL_SIZES) {
    const box = [640, 380, s.heightCm * 10].sort((p, q) => q - p);
    if (x <= box[0] && y <= box[1] && z <= box[2]) return s.value;
  }
  return 'over';
}

function parcel(i: ProjectionInput): [string, string] {
  const plan = obj(i.planInput);
  const template = (str(plan.template) || str(plan.size) || str(obj(plan.parcel).template)).toLowerCase();
  if (TEMPLATE_SIZES[template]) return [TEMPLATE_SIZES[template], 'Gabaryt z przesyłki u przewoźnika'];
  const lines = i.lines ?? [];
  const size = parcelSizeOf(lines);
  if (size) return [size, 'Wyliczony z wymiarów i wagi produktów (progi InPost A/B/C)'];
  return ['', lines.length ? 'Brak wymiarów produktów w logistyce' : 'Zamówienie bez pozycji'];
}

// ── projection ───────────────────────────────────────────────────────────────────────────────────

export function projectChannelData(i: ProjectionInput): Projection {
  const raw = i.raw ?? {};
  const address = obj(i.order.address);
  const [customer_comment, sComment] = comment(i, address);
  const [siteValue, sSite] = site(i, raw);
  const m = method(i, address);
  const [flagValues, sFlags] = flags(i, raw, address, m.label);
  const [ship_by, sShip] = shipBy(i, raw);
  const [payment_operator, sOperator] = operator(i, raw);
  const [parcel_size, sParcel] = parcel(i);
  return {
    customer_comment: customer_comment.slice(0, 4000),
    site: siteValue,
    flags: flagValues,
    ship_by,
    payment_operator,
    shipping_method: m.values,
    shipping_method_label: m.label,
    parcel_size,
    sources: {
      customer_comment: sComment,
      site: sSite,
      flags: sFlags,
      ship_by: sShip,
      payment_operator: sOperator,
      shipping_method: m.source,
      parcel_size: sParcel,
    },
  };
}

// ── database ─────────────────────────────────────────────────────────────────────────────────────

async function present(c: PoolClient, names: string[]): Promise<Set<string>> {
  const r = await c.query("SELECT n FROM unnest($1::text[]) n WHERE to_regclass('public.'||n) IS NOT NULL", [names]);
  return new Set(r.rows.map((x) => x.n));
}
const byOrder = (rows: Row[]) => {
  const m = new Map<string, Row[]>();
  for (const r of rows) m.set(r.order_id, [...(m.get(r.order_id) ?? []), r]);
  return m;
};

/** Projections of up to 500 orders of the current tenant (RLS of the caller's transaction). */
export async function loadChannelProjections(c: PoolClient, orderIds: string[]): Promise<Map<string, Projection>> {
  const ids = [...new Set(orderIds)].slice(0, 500);
  const out = new Map<string, Projection>();
  if (!ids.length) return out;
  const has = await present(c, ['order_sales_dimensions', 'product_logistics', 'inbound_orders', 'shipping_plans']);
  const q = async (sql: string) => (await c.query(sql, [ids])).rows;
  const orders = await q(
    `SELECT o.id,o.source,o.note,o.address,o.payment_mode,o.b2b_account_id,o.fulfillment_kind,ch.provider,ch.settings
     FROM orders o LEFT JOIN channels ch ON (ch.tenant_id,ch.id)=(o.tenant_id,o.channel_id) WHERE o.id=ANY($1::uuid[])`,
  );
  if (!orders.length) return out;
  const raws = new Map(
    has.has('inbound_orders')
      ? (await q('SELECT DISTINCT ON (order_id) order_id,raw FROM inbound_orders WHERE order_id=ANY($1::uuid[]) ORDER BY order_id,created_at DESC,id')).map(
          (r) => [r.order_id, obj(r.raw)],
        )
      : [],
  );
  const dims = new Map(
    has.has('order_sales_dimensions')
      ? (await q('SELECT order_id,delivery_method,delivery_label,payment_method,payment_label FROM order_sales_dimensions WHERE order_id=ANY($1::uuid[])')).map(
          (r) => [r.order_id, r as SalesDimensions],
        )
      : [],
  );
  const edited = new Map<string, Row>();
  for (const r of await q(
    "SELECT DISTINCT ON (order_id,detail->>'section') order_id,detail->>'section' AS section,detail->'values' AS v FROM order_events WHERE order_id=ANY($1::uuid[]) AND kind='order.section_edited' AND detail->>'section' IN ('invoice','delivery_method','payment') ORDER BY order_id,detail->>'section',created_at DESC,id DESC",
  ))
    edited.set(r.order_id + ':' + r.section, obj(r.v));
  const payments = byOrder(
    await q("SELECT order_id,kind,method,reference FROM payment_entries WHERE order_id=ANY($1::uuid[]) AND kind IN ('receipt','courier_collection') ORDER BY order_id,created_at DESC,id DESC"),
  );
  const plans = new Map(
    has.has('shipping_plans')
      ? (await q("SELECT DISTINCT ON (order_id) order_id,input FROM shipping_plans WHERE order_id=ANY($1::uuid[]) AND state NOT IN ('cancelled') ORDER BY order_id,created_at DESC,id DESC")).map(
          (r) => [r.order_id, obj(r.input)],
        )
      : [],
  );
  const lines = byOrder(
    await q(
      `SELECT i.order_id,i.quantity,${has.has('product_logistics') ? 'pl.weight_grams,pl.length_mm,pl.width_mm,pl.height_mm' : 'NULL::int weight_grams,NULL::int length_mm,NULL::int width_mm,NULL::int height_mm'}
       FROM order_items i ${has.has('product_logistics') ? 'LEFT JOIN product_logistics pl ON (pl.tenant_id,pl.product_id)=(i.tenant_id,i.product_id)' : ''}
       WHERE i.order_id=ANY($1::uuid[]) AND i.quantity>0`,
    ),
  );
  for (const o of orders) {
    const raw = raws.get(o.id) ?? null;
    out.set(
      o.id,
      projectChannelData({
        provider: str(o.provider) || str(o.source),
        raw,
        order: o as ProjectionInput['order'],
        channelSettings: obj(o.settings),
        dimensions: dims.get(o.id) ?? null,
        edited: {
          delivery_method: edited.get(o.id + ':delivery_method'),
          payment: edited.get(o.id + ':payment'),
          invoice: edited.get(o.id + ':invoice'),
        },
        payments: (payments.get(o.id) ?? []) as PaymentEntryFact[],
        planInput: plans.get(o.id) ?? null,
        lines: (lines.get(o.id) ?? []) as ProjectionLine[],
      }),
    );
  }
  return out;
}

const labelOf = (options: Array<{ value: string; label: string }>, v: string) => options.find((o) => o.value === v)?.label ?? v;
const WARSAW = new Intl.DateTimeFormat('pl-PL', { timeZone: 'Europe/Warsaw', dateStyle: 'medium', timeStyle: 'short' });

/** The order card view (tab "Kanał sprzedaży"): one row per field with its human value and source. */
export function channelDataView(orderId: string, provider: string, p: Projection): ChannelData {
  return {
    order_id: orderId,
    provider,
    fields: [
      { key: 'order.customer_comment', label: 'Komentarz klienta', value: p.customer_comment, source: p.sources.customer_comment },
      { key: 'source.site', label: 'Kraj / wersja serwisu', value: p.site, source: p.sources.site },
      { key: 'source.flags', label: 'Oznaczenia z serwisu', value: p.flags.map((f) => labelOf(FLAG_OPTIONS, f)).join(', '), source: p.sources.flags },
      { key: 'source.ship_by', label: 'Wyślij do (termin z serwisu)', value: p.ship_by ? WARSAW.format(new Date(p.ship_by)) : '', source: p.sources.ship_by },
      { key: 'payment.operator', label: 'Operator płatności', value: p.payment_operator ? labelOf(OPERATOR_OPTIONS, p.payment_operator) : '', source: p.sources.payment_operator },
      { key: 'shipping.method', label: 'Sposób wysyłki', value: p.shipping_method_label, source: p.sources.shipping_method },
      { key: 'shipping.parcel_size', label: 'Gabaryt paczki', value: p.parcel_size ? labelOf(PARCEL_SIZE_OPTIONS, p.parcel_size) : '', source: p.sources.parcel_size },
    ],
  };
}

/** One order's card view; null when the order is not visible to the tenant. */
export async function orderChannelData(c: PoolClient, orderId: string): Promise<ChannelData | null> {
  const p = (await loadChannelProjections(c, [orderId])).get(orderId);
  if (!p) return null;
  const r = (await c.query('SELECT coalesce(ch.provider,o.source) p FROM orders o LEFT JOIN channels ch ON (ch.tenant_id,ch.id)=(o.tenant_id,o.channel_id) WHERE o.id=$1', [orderId])).rows[0];
  return channelDataView(orderId, r?.p ?? '', p);
}

// ── SQL twins for the order list ─────────────────────────────────────────────────────────────────

/** SQL of methodSlug() over a text expression. */
export const slugSql = (expr: string) =>
  `btrim(regexp_replace(lower(translate(${expr},'${SLUG_FROM}','${SLUG_TO}')),'[^a-z0-9]+','-','g'),'-')`;

/**
 * SQL boolean: the order's delivery method (projection: card section edit, then order_sales_dimensions, then the
 * pickup point of the address) is one of the codes bound in `codes` (text[]): groups, "<group>_cod" for cash on
 * delivery, or the channel's own method "<provider>:<slug>".
 */
export function deliveryMethodSql(o: string, codes: string): string {
  const point = "coalesce(nullif(btrim(o2.address->>'locker_code'),''),nullif(btrim(o2.address->>'pickup_point'),''),'')";
  const name = `CASE WHEN o2.payment_mode='cod' AND dm.delivery_label !~* '(pobrani|\\mcod\\M|cash on delivery)' THEN dm.delivery_label||' pobranie' ELSE dm.delivery_label END`;
  return `EXISTS(SELECT 1 FROM (SELECT ${o}.payment_mode,${o}.address,(SELECT e.detail->'values'->>'method' FROM order_events e WHERE e.tenant_id=${o}.tenant_id AND e.order_id=${o}.id AND e.kind='order.section_edited' AND e.detail->>'section'='delivery_method' ORDER BY e.created_at DESC,e.id DESC LIMIT 1) AS edited) o2
    LEFT JOIN order_sales_dimensions dm ON dm.tenant_id=${o}.tenant_id AND dm.order_id=${o}.id
    CROSS JOIN LATERAL (SELECT coalesce(nullif(o2.edited,''),nullif(dm.delivery_method,'unknown'),
      CASE WHEN ${point} ~* '^[A-Z]{3}[0-9]{2,3}[A-Z]{1,2}$' THEN 'parcel_locker' WHEN ${point}<>'' THEN 'pickup_point' END,'unknown') AS g,
      CASE WHEN nullif(o2.edited,'') IS NULL AND coalesce(dm.delivery_label,'')<>'' THEN dm.provider||':'||${slugSql(name)} END AS ch) x
    WHERE x.g=ANY(${codes}::text[]) OR (o2.payment_mode='cod' AND x.g<>'unknown' AND x.g||'${COD_SUFFIX}'=ANY(${codes}::text[])) OR x.ch=ANY(${codes}::text[]))`;
}

/** SQL boolean: the order has a buyer comment (projection: address comment, channel message, or the note of a manual order). */
export function customerCommentSql(o: string): string {
  const rawText = "coalesce(btrim(ib.raw->>'messageToSeller'),'')||coalesce(btrim(ib.raw->>'customer_note'),'')||coalesce(btrim(ib.raw->>'note'),'')||coalesce(btrim(ib.raw->>'buyerCheckoutNotes'),'')||coalesce(btrim(ib.raw->'messages'->0->>'message'),'')";
  return `(coalesce(btrim(${o}.address->>'customer_comment'),'')<>''
    OR EXISTS(SELECT 1 FROM inbound_orders ib WHERE ib.tenant_id=${o}.tenant_id AND ib.order_id=${o}.id AND ${rawText}<>'')
    OR (NOT EXISTS(SELECT 1 FROM inbound_orders ib WHERE ib.tenant_id=${o}.tenant_id AND ib.order_id=${o}.id) AND btrim(coalesce(${o}.note,''))<>''))`;
}
