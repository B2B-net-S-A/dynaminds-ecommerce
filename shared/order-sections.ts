/**
 * Per-section editing of an order (Uwagi v3 §6). Contract shared by the server (server/order-sections*.ts)
 * and the order card (web/order-card*.tsx).
 *
 * HTTP:
 *   PATCH /api/orders/:id/sections/:section   body { expected_version: number, values: SectionValues[section] }
 *         -> 200 { order } (the full card payload) | 409 stale version | 423 { lock: SectionLock } | 422 validation
 *   GET   /api/orders/:id                     -> card payload gains `section_locks` and `section_values`
 *   History: order_events kind 'order.section_edited',
 *            detail { section, actor_id, actor_name, changes: SectionChange[] } (values included; RODO export and
 *            anonymisation cover them). The card filters history by section.
 * Every successful save also raises the automation event 'order.section_edited' (payment: also 'payment.changed').
 */

export type OrderSection =
  | 'customer'
  | 'delivery_address'
  | 'invoice'
  | 'products'
  | 'delivery_method'
  | 'payment'
  | 'extra';

export const SECTION_LABELS: Record<OrderSection, string> = {
  customer: 'Dane klienta',
  delivery_address: 'Adres dostawy',
  invoice: 'Dane do faktury',
  products: 'Produkty',
  delivery_method: 'Sposób dostawy',
  payment: 'Płatność',
  extra: 'Pola dodatkowe i notatki',
};

export interface SectionValues {
  customer: { name: string; company: string; email: string; phone: string };
  delivery_address: {
    recipient: string;
    street: string;
    postal_code: string;
    city: string;
    country: string;
    pickup_point: string;
  };
  invoice: { wants_invoice: boolean; buyer: string; nip: string; street: string; postal_code: string; city: string; country: string };
  /** Products keep the existing line endpoints (POST/PATCH/DELETE /api/orders/:id/items); listed for locks only. */
  products: Record<string, never>;
  delivery_method: { method: string; carrier: string; cost: number };
  /** state: manual payment status; amount in grosze; paid_at ISO date; method e.g. 'transfer', 'online', 'cod'. */
  payment: { state: 'unpaid' | 'paid' | 'partial' | 'cod'; amount: number; paid_at: string; reference: string; method: string };
  extra: { note: string };
}

export interface SectionChange {
  field: string;
  label: string;
  before: string;
  after: string;
}

export interface SectionLock {
  locked: boolean;
  /** Shown next to the padlock, e.g. "Najpierw anuluj etykietę u przewoźnika". */
  reason?: string;
  /** What the person can do instead. */
  action?: 'cancel_label' | 'correction';
}

export type SectionLocks = Record<OrderSection, SectionLock>;
