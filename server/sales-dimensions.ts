/** ANALYTICS-002 (migration 247): delivery and payment group of an imported order.
 * The channel's own names (Woo shipping line, Allegro delivery method, …) are kept as a label and
 * classified into fixed groups; the importer records one row per order in its own transaction.
 * The classifier never throws: an unreadable source is "unknown", never a refused import. */
import type { PoolClient } from 'pg';

export const DELIVERY_METHODS = ['parcel_locker', 'pickup_point', 'courier', 'post', 'personal_pickup', 'digital', 'other', 'unknown'] as const;
export const PAYMENT_METHODS = ['cod', 'transfer', 'card', 'online', 'cash', 'marketplace', 'other', 'unknown'] as const;
export type DeliveryMethod = (typeof DELIVERY_METHODS)[number];
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
export interface SalesDimensions {
  delivery_method: DeliveryMethod;
  delivery_label: string;
  payment_method: PaymentMethod;
  payment_label: string;
}
export const DELIVERY_LABELS: Record<DeliveryMethod, string> = {
  parcel_locker: 'Automat paczkowy', pickup_point: 'Punkt odbioru', courier: 'Kurier', post: 'Poczta',
  personal_pickup: 'Odbiór osobisty', digital: 'Dostawa elektroniczna', other: 'Inna dostawa', unknown: 'Brak danych o dostawie',
};
export const PAYMENT_LABELS: Record<PaymentMethod, string> = {
  cod: 'Za pobraniem', transfer: 'Przelew', card: 'Karta', online: 'Płatność online', cash: 'Gotówka',
  marketplace: 'Płatność w serwisie sprzedaży', other: 'Inna płatność', unknown: 'Brak danych o płatności',
};

const LABEL_MAX = 120;
/** Single line, no control characters, at most 120 characters. */
export function cleanLabel(v: unknown): string {
  if (typeof v !== 'string') return '';
  return [...v.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()].slice(0, LABEL_MAX).join('').trim();
}
const fold = (v: string) => v.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ł/g, 'l').replace(/Ł/g, 'L').toLowerCase();

const DELIVERY_RULES: [DeliveryMethod, RegExp][] = [
  ['digital', /elektroniczn|e-?mail|digital|download|cyfrow|wirtualn/],
  ['personal_pickup', /odbior (osobisty|wlasny)|osobisty|local.?pickup|w sklepie|click.?(and|&|n)?.?collect|pickup in store/],
  ['parcel_locker', /paczkomat|locker|automat|one ?box|z-?box|parcel ?station/],
  ['pickup_point', /punkt|pickup|pick.?up|orlen paczka|zabka|parcel ?shop|ruch/],
  ['courier', /kurier|courier|dpd|dhl|ups|fedex|gls|geis|raben|express|ekspres|inpost/],
  ['post', /poczta|pocztex|polecony|\blist\b|post/],
];
export function classifyDelivery(label: string | null | undefined, hints: { pickupPoint?: boolean } = {}): DeliveryMethod {
  const v = fold(String(label ?? '').trim());
  if (!v) return hints.pickupPoint ? 'pickup_point' : 'unknown';
  for (const [key, re] of DELIVERY_RULES) if (re.test(v)) return key;
  return hints.pickupPoint ? 'pickup_point' : 'other';
}

const PAYMENT_RULES: [PaymentMethod, RegExp][] = [
  ['cod', /pobrani|\bcod\b|cash.?on.?delivery|przy odbiorze|cashondelivery/],
  ['transfer', /przelew(?!y24)|bacs|transfer|bank|wire/],
  ['card', /karta|card|stripe|visa|mastercard|apple ?pay|google ?pay|shopify_payments/],
  ['online', /payu|przelewy24|\bp24\b|tpay|blik|paypal|online|dotpay|imoje|autopay|blue ?media|paynow|revolut/],
  ['cash', /gotowk|cash/],
];
export function classifyPayment(label: string | null | undefined, hints: { cod: boolean }): PaymentMethod {
  if (hints.cod) return 'cod';
  const v = fold(String(label ?? '').trim());
  if (!v) return 'unknown';
  for (const [key, re] of PAYMENT_RULES) if (re.test(v)) return key;
  return 'other';
}

const obj = (v: unknown): Record<string, any> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : {});
const first = (v: unknown): Record<string, any> => (Array.isArray(v) ? obj(v[0]) : {});
const str = (v: unknown) => (typeof v === 'string' ? v : '');

/** The documented delivery and payment fields of each importer's raw order. */
export function orderSalesDimensions(provider: string, raw: unknown, order: { payment_mode: string }): SalesDimensions {
  const r = obj(raw),
    cod = order.payment_mode === 'cod';
  let delivery = '',
    deliveryKey = '',
    payment = '',
    paymentKey = '',
    pickupPoint = false,
    marketplace = false;
  if (provider === 'woocommerce') {
    const line = first(r.shipping_lines);
    delivery = str(line.method_title);
    deliveryKey = [str(line.method_id), delivery].join(' ');
    payment = str(r.payment_method_title) || str(r.payment_method);
    paymentKey = [str(r.payment_method), payment].join(' ');
  } else if (provider === 'allegro') {
    delivery = str(obj(obj(r.delivery).method).name);
    pickupPoint = Boolean(str(obj(obj(r.delivery).pickupPoint).id));
    const p = obj(r.payment);
    if (p.type === 'CASH_ON_DELIVERY') payment = 'Za pobraniem';
    else if (p.type === 'ONLINE') payment = 'Allegro online' + (str(p.provider) ? ` (${str(p.provider)})` : '');
    paymentKey = p.type === 'ONLINE' ? 'online' : p.type === 'CASH_ON_DELIVERY' ? 'cod' : '';
  } else if (provider === 'shopify') {
    const line = first(r.shipping_lines);
    delivery = str(line.title);
    deliveryKey = [delivery, str(line.code)].join(' ');
    payment = Array.isArray(r.payment_gateway_names) ? r.payment_gateway_names.filter((g: unknown) => typeof g === 'string').join(', ') : '';
  } else if (provider === 'prestashop') {
    payment = str(r.payment);
    paymentKey = [str(r.module), payment].join(' ');
  } else if (provider === 'ebay') {
    delivery = str(obj(first(r.fulfillmentStartInstructions).shippingStep).shippingServiceCode);
    marketplace = true;
  } else if (provider === 'amazon') {
    delivery = str(r.shipmentServiceLevelCategory) || str(obj(r.fulfillment).fulfillmentServiceLevel);
    marketplace = true;
  } else if (provider === 'mirakl') {
    delivery = str(r.shipping_type_label) || str(r.shipping_type_code);
    marketplace = true;
  }
  const delivery_label = cleanLabel(delivery.replace(/_/g, ' ')),
    payment_label = cleanLabel(payment);
  const payment_method: PaymentMethod = cod ? 'cod' : marketplace ? 'marketplace' : classifyPayment(paymentKey || payment, { cod: false });
  return {
    delivery_method: classifyDelivery((deliveryKey || delivery).replace(/_/g, ' '), { pickupPoint }),
    delivery_label,
    payment_method,
    payment_label: marketplace && !payment_label ? '' : payment_label,
  };
}

/** True when the prepared migration (order_sales_dimensions) is installed in this copy. */
export async function salesDimensionsAvailable(c: PoolClient): Promise<boolean> {
  return (await c.query("SELECT to_regclass('public.order_sales_dimensions') IS NOT NULL AS ok")).rows[0].ok === true;
}

/** Importer hook, inside the import transaction. Without the migration nothing is written (the
 * report then shows "Brak danych o dostawie"); a repeated import keeps the first record. */
export async function recordOrderSalesDimensionsInTx(c: PoolClient, tenantId: string, orderId: string, provider: string,
  raw: unknown, order: { payment_mode: string }, origin: 'import' | 'backfill' = 'import'): Promise<boolean> {
  if (!/^[a-z0-9_]{2,40}$/.test(provider) || !(await salesDimensionsAvailable(c))) return false;
  const d = orderSalesDimensions(provider, raw, order);
  const r = await c.query(
    `INSERT INTO order_sales_dimensions(tenant_id,order_id,delivery_method,delivery_label,payment_method,payment_label,provider,origin)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (tenant_id,order_id) DO NOTHING`,
    [tenantId, orderId, d.delivery_method, d.delivery_label, d.payment_method, d.payment_label, provider, origin],
  );
  return r.rowCount === 1;
}

export const BACKFILL_BATCH = 500;
/** Administrator backfill for orders imported before the migration: the stored inbound order
 * (raw source document) of each imported order without a record. Bounded per call. */
export async function backfillOrderSalesDimensionsInTx(c: PoolClient, tenantId: string): Promise<{ recorded: number; remaining: number }> {
  const rows = (
    await c.query(
      `SELECT i.order_id,i.raw,ch.provider,o.payment_mode FROM inbound_orders i
       JOIN channels ch ON (ch.tenant_id,ch.id)=(i.tenant_id,i.channel_id)
       JOIN orders o ON (o.tenant_id,o.id)=(i.tenant_id,i.order_id)
       WHERE i.state='imported' AND i.order_id IS NOT NULL
         AND NOT EXISTS(SELECT 1 FROM order_sales_dimensions d WHERE (d.tenant_id,d.order_id)=(i.tenant_id,i.order_id))
       ORDER BY i.order_id LIMIT $1`,
      [BACKFILL_BATCH],
    )
  ).rows;
  let recorded = 0;
  for (const r of rows)
    if (await recordOrderSalesDimensionsInTx(c, tenantId, r.order_id, r.provider, r.raw, r, 'backfill')) recorded++;
  const remaining = Number(
    (
      await c.query(
        `SELECT count(*)::int n FROM inbound_orders i WHERE i.state='imported' AND i.order_id IS NOT NULL
         AND NOT EXISTS(SELECT 1 FROM order_sales_dimensions d WHERE (d.tenant_id,d.order_id)=(i.tenant_id,i.order_id))`,
      )
    ).rows[0].n,
  );
  return { recorded, remaining };
}
