/**
 * Invoice party and delivery recipient of an order (Uwagi v3 §6 follow-up). Pure and import-free, so the
 * server (server/order-invoice-party.ts) and the web document and label forms apply the same rule.
 *
 * - Invoice party: the values of the order card section „Dane do faktury” (the latest order_events row
 *   'order.section_edited' of section 'invoice', or `section_values.invoice` of the card payload) when a
 *   buyer or a NIP was entered; otherwise the customer of the order (customer_name, email, address).
 * - Delivery recipient: `address.recipient` (section „Adres dostawy”) when present, otherwise customer_name.
 *   The pickup point is `address.locker_code`.
 */

export interface InvoicePartyAddress {
  street: string;
  postal_code: string;
  city: string;
  country: string;
}
export interface InvoiceParty {
  /** 'invoice_section': entered on the order card; 'order': the customer of the order (nothing was entered). */
  source: 'invoice_section' | 'order';
  name: string;
  /** NIP (or another tax id) from the card; '' when none. */
  tax_id: string;
  email: string;
  address: InvoicePartyAddress;
}
export type InvoicePartyOrder = {
  customer_name?: string | null;
  email?: string | null;
  address?: Record<string, unknown> | null;
};
export type InvoiceSectionValues = Partial<Record<'buyer' | 'nip' | 'street' | 'postal_code' | 'city' | 'country', unknown>>;

const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

/** The delivery recipient of the label: address.recipient, otherwise the customer name (unchanged). */
export function orderRecipientName(o: InvoicePartyOrder): string {
  return text(o.address?.recipient) || (o.customer_name ?? '');
}
/** The pickup point code entered for the order ('' when none). */
export function orderPickupPoint(o: InvoicePartyOrder): string {
  return text(o.address?.locker_code);
}

/** The buyer of documents issued from the order. */
export function invoicePartyOf(o: InvoicePartyOrder, invoice?: InvoiceSectionValues | null): InvoiceParty {
  const a = o.address ?? {};
  const own: InvoicePartyAddress = {
    street: text(a.street),
    postal_code: text(a.postal_code),
    city: text(a.city),
    country: text(a.country).toUpperCase() || 'PL',
  };
  const buyer = text(invoice?.buyer), nip = text(invoice?.nip);
  if (!buyer && !nip) return { source: 'order', name: o.customer_name ?? '', tax_id: '', email: o.email ?? '', address: own };
  // Only a NIP was entered: the company of the customer, otherwise the customer, is the buyer.
  const name = buyer || text(a.company) || (o.customer_name ?? '');
  // The section's address is used as a whole when it was entered; otherwise the order's address.
  const address = text(invoice?.street)
    ? { street: text(invoice?.street), postal_code: text(invoice?.postal_code), city: text(invoice?.city), country: text(invoice?.country).toUpperCase() || own.country }
    : own;
  return { source: 'invoice_section', name, tax_id: nip, email: o.email ?? '', address };
}

/** A Polish NIP of the party (10 digits, 'PL' prefix dropped), or '' when the party has none or a foreign id. */
export function invoicePartyPolishNip(p: InvoiceParty): string {
  if (p.address.country !== 'PL') return '';
  const nip = p.tax_id.replace(/[\s-]/g, '').toUpperCase().replace(/^PL/, '');
  return /^\d{10}$/.test(nip) ? nip : '';
}
