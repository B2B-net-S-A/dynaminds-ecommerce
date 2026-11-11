import type { PoolClient } from 'pg';
import { localConfig } from './db';
import { ensure } from './errors';
import { effectiveDeliveryInTx } from './buyer-address';

// Fixed local origin of the buyer portal. Never derived from Host, Origin or client input,
// the same rule as the password-recovery link (server/password-recovery.ts).
export const PORTAL_ORIGIN = 'http://127.0.0.1:4100';
export const portalLink = (token: string) => PORTAL_ORIGIN + '/api/public/orders/' + token;
export const isPortalLink = (href: string) =>
  /^http:\/\/127\.0\.0\.1:4100\/api\/public\/orders\/[a-f0-9]{48}$/.test(href);

// Tags read from the order row itself; always available.
export const rowVariables = ['order_number', 'customer_name', 'total', 'currency', 'status', 'source'];
// Tags that need extra reads; computed only when the template uses them.
export const orderVariables = [
  'tracking_number',
  'portal_link',
  'products',
  'delivery_address',
  'delivery_method',
  'invoice_number',
];
export const messageVariableLabels: Record<string, string> = {
  order_number: 'numer zamówienia',
  customer_name: 'kupujący',
  total: 'wartość',
  currency: 'waluta',
  status: 'status',
  source: 'źródło',
  tracking_number: 'numer przesyłki',
  portal_link: 'link do strony zamówienia',
  products: 'produkty i ilości',
  delivery_address: 'adres dostawy',
  delivery_method: 'sposób dostawy',
  invoice_number: 'numer faktury',
};

export function usedVariables(texts: string[]): Set<string> {
  const used = new Set<string>();
  for (const text of texts) for (const m of text.matchAll(/\{\{([a-z_]+)\}\}/g)) used.add(m[1]);
  return used;
}

export function rowValues(o: any): Record<string, string> {
  return {
    order_number: o.number,
    customer_name: o.customer_name,
    total: (o.total / 100).toFixed(2),
    currency: o.currency,
    status: o.status,
    source: o.source,
  };
}

const joined = (parts: unknown[], separator = ', ') =>
  parts
    .map((p) => String(p ?? '').trim())
    .filter(Boolean)
    .join(separator);

/** Values for every tag in `used`. Throws 422 with a reason the operator can act on
 * (inactive portal link, no invoice). Reads run in the caller's tenant transaction. */
export async function orderMessageValues(
  c: PoolClient,
  o: any,
  used: Set<string>,
): Promise<Record<string, string>> {
  const values = rowValues(o);
  const need = (key: string) => used.has(key);
  if (need('tracking_number') || need('delivery_method')) {
    const shipments = (
      await c.query('SELECT carrier,tracking_number FROM shipments WHERE order_id=$1 ORDER BY created_at,id', [o.id])
    ).rows;
    values.tracking_number = shipments.map((s) => s.tracking_number).join(', ');
    const locker = String(o.address?.locker_code ?? '').trim();
    values.delivery_method = shipments.length
      ? [...new Set(shipments.map((s) => s.carrier))].join(', ')
      : locker
        ? 'Punkt odbioru'
        : 'Dostawa pod adres';
  }
  if (need('portal_link')) {
    ensure(
      o.portal_enabled !== false &&
        (!o.portal_expires_at || new Date(o.portal_expires_at) > new Date()) &&
        /^[a-f0-9]{48}$/.test(o.portal_token ?? ''),
      422,
      'Link do strony zamówienia jest wyłączony lub wygasł; odnów go w karcie zamówienia',
    );
    values.portal_link = portalLink(o.portal_token);
  }
  if (need('products')) {
    const items = (
      await c.query('SELECT name,quantity FROM order_items WHERE order_id=$1 ORDER BY name,id', [o.id])
    ).rows;
    values.products = items.map((i) => i.quantity + ' × ' + i.name).join(', ');
  }
  if (need('delivery_address')) {
    const a = o.address ?? {};
    const locker = String(a.locker_code ?? '').trim();
    if (locker) values.delivery_address = 'Punkt odbioru ' + locker;
    else {
      const e: any = await effectiveDeliveryInTx(c, o.tenant_id, o.id, localConfig.encryptionKey);
      const d = e?.kind === 'address' && e.delivery ? e.delivery : a;
      values.delivery_address = joined([d.street, joined([d.postal_code, d.city], ' '), d.country]);
    }
    ensure(values.delivery_address, 422, 'Zamówienie nie ma adresu dostawy');
  }
  if (need('invoice_number')) {
    const d = (
      await c.query(
        "SELECT number FROM documents WHERE order_id=$1 AND kind='invoice' ORDER BY created_at DESC,id DESC LIMIT 1",
        [o.id],
      )
    ).rows[0];
    ensure(d, 422, 'Zamówienie nie ma jeszcze faktury');
    values.invoice_number = d.number;
  }
  return values;
}

/** Sample data for the live editor preview when no order is chosen. */
export const sampleMessageValues: Record<string, string> = {
  order_number: 'ZAM/2026/0001',
  customer_name: 'Anna Przykładowa',
  total: '249.00',
  currency: 'PLN',
  status: 'shipped',
  source: 'manual',
  tracking_number: '520000011395200025754311',
  portal_link: portalLink('0'.repeat(48)),
  products: '2 × Kubek ceramiczny, 1 × Podkładka',
  delivery_address: 'ul. Przykładowa 1, 00-001 Warszawa, PL',
  delivery_method: 'InPost ShipX',
  invoice_number: 'FV/2026/10/0001',
};
