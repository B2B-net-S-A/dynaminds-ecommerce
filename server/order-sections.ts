/** Per-section order editing (Uwagi v3 §6): current values, locks and the save of one section.
 *
 * Storage without a migration (the `orders` table is sealed):
 *  - customer: customer_name, email, address.phone, address.company;
 *  - delivery_address: address.recipient/street/postal_code/city/country, address.locker_code (pickup point);
 *  - invoice and the delivery method/carrier and descriptive payment method: the `values` snapshot of the latest
 *    order_events row 'order.section_edited' of that section (order_events has no trigger or CHECK on detail);
 *  - delivery cost: orders.shipping_cost (the total follows, as in createOrder);
 *  - payment state: the payments ledger (receipts and reversals) and orders.payment_mode;
 *  - extra: orders.note.
 * Every save bumps the order version (order_revision trigger) and records the values before and after. */
import type { PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { Problem, ensure } from './errors';
import { audit, event, getOrder, lockedOrder, type Actor } from './domain';
import { paymentBalance, appendPayment, reversalEntry } from './payments';
import { orderFulfillmentKind } from './order-fulfillment-kind';
import { salesDimensionsAvailable } from './sales-dimensions';
import { paymentState } from './order-stage';
import {
  DELIVERY_BLOCKERS,
  LINE_BLOCKERS,
  ORDER_EDIT_CONFLICT,
  ORDER_LINE_EDIT_STATUSES,
  blockers,
  buyerDeliveryChanged,
  settlePaymentStage,
  type Blocker,
} from './order-edit';
import { DELIVERY_METHODS, PAYMENT_METHODS, checkMerged, sectionBody, sectionChanges, type EditableSection } from './order-sections-model';
import type { OrderSection, SectionLock, SectionLocks, SectionValues } from '../shared/order-sections';

type Row = Record<string, any>;
export const SECTION_EDITED = 'order.section_edited';
export const PAYMENT_CHANGED = 'payment.changed';
const SHIPPED_ON = ['shipped', 'delivered', 'completed', 'return_initiated', 'return_received', 'return_completed'];

/** Payment has two independent parts: the descriptive method and the state kept by the ledger. */
export interface PaymentEdit {
  state: SectionLock;
  method: SectionLock;
}
export interface OrderSectionsPayload {
  section_locks: SectionLocks;
  section_values: SectionValues;
  payment_edit: PaymentEdit;
}

const OPEN: SectionLock = { locked: false };
const lock = (reason: string, action?: SectionLock['action']): SectionLock => ({ locked: true, reason, ...(action ? { action } : {}) });
const CORRECTION = lock('Zmiana tylko przez korektę', 'correction');
const CANCELLED = lock('Zamówienie jest anulowane');
const SHIPPED = lock('Przesyłka została nadana — tej sekcji nie można już zmienić');
const CANCEL_LABEL = lock('Najpierw anuluj etykietę u przewoźnika', 'cancel_label');
export const READ_ONLY = lock('Konto ma uprawnienia tylko do odczytu');
export const ADMIN_PAYMENT = lock('Status płatności zmienia administrator');

/** Relationship tags (never shown) followed by the reasons of the line edit, checked in one query. */
const TAGGED: readonly Blocker[] = [
  // A cancelled label (shipment.status 'canceled', see shipment-cancel.ts) no longer locks the sections.
  ['shipments', 'order_id', '#label', "status<>'canceled'"],
  ['shipping_plans', 'order_id', '#label', "state NOT IN ('preview','cancelled')"],
  ['order_parcel_plans', 'order_id', '#parcel'],
  ['b2b_dropship_supplier_orders', 'order_id', '#dropship'],
  ['b2b_dropship_orders', 'customer_order_id', '#dropship', "state='ordered'"],
  ['documents', 'order_id', '#invoice', "kind IN ('invoice','correction')"],
  ['invoice_plans', 'order_id', '#invoice', "state NOT IN ('preview','cancelled')"],
  ['odoo_invoice_exports', 'order_id', '#invoice', "state NOT IN ('preview','cancelled')"],
  ...['local_invoice_receipts', 'local_consumer_credit_documents', 'receipt233_receipts'].map((t) => [t, 'order_id', '#invoice'] as const),
];
interface OrderFacts {
  tags: Set<string>;
  lineReasons: string[];
  buyerChanged: boolean;
}
async function orderFacts(c: PoolClient, id: string): Promise<OrderFacts> {
  const hits = await blockers(c, id, [...TAGGED, ...LINE_BLOCKERS]);
  return {
    tags: new Set(hits.filter((h) => h.startsWith('#')).map((h) => h.slice(1))),
    lineReasons: hits.filter((h) => !h.startsWith('#')),
    buyerChanged: await buyerDeliveryChanged(c, id),
  };
}

/** Locks that follow from the order itself; the person's role is applied by sectionLocksForActor. */
export function stateLocks(o: Row, f: OrderFacts): { section_locks: SectionLocks; payment_edit: PaymentEdit } {
  if (orderFulfillmentKind(o) !== 'sale') {
    const r = lock('Zamówienie wymiany reklamacyjnej — dane prowadzi reklamacja');
    return {
      section_locks: { customer: r, delivery_address: r, invoice: r, products: r, delivery_method: r, payment: r, extra: r },
      payment_edit: { state: r, method: r },
    };
  }
  const cancelled = o.status === 'cancelled', shipped = SHIPPED_ON.includes(o.status);
  const invoiced = f.tags.has('invoice'), label = f.tags.has('label') || f.tags.has('parcel'), dropship = f.tags.has('dropship');
  const customer = dropship
    ? lock('Dane odbiorcy są przekazane dostawcy w zleceniu dropshippingu')
    : f.tags.has('parcel')
      ? lock('Dane odbiorcy są zamrożone w planie paczek. Najpierw anuluj etykietę u przewoźnika', 'cancel_label')
      : OPEN;
  const delivery = cancelled
    ? CANCELLED
    : shipped
      ? SHIPPED
      : label
        ? CANCEL_LABEL
        : dropship
          ? lock('Dostawa jest przekazana dostawcy w zleceniu dropshippingu')
          : OPEN;
  const products = invoiced
    ? CORRECTION
    : cancelled
      ? CANCELLED
      : shipped
        ? SHIPPED
        : !ORDER_LINE_EDIT_STATUSES.includes(o.status)
          ? lock('Pozycje można zmieniać tylko przed rozpoczęciem kompletacji')
          : ['order_split', 'order_merge'].includes(o.source)
            ? lock('Pozycji zamówienia powstałego z podziału lub łączenia nie można edytować')
            : f.lineReasons.length
              ? lock('Nie można zmienić pozycji, bo zamówienie ma ' + f.lineReasons.join(', '))
              : OPEN;
  const payment_edit: PaymentEdit = {
    state: cancelled ? CANCELLED : OPEN,
    method: cancelled ? CANCELLED : invoiced ? CORRECTION : OPEN,
  };
  return {
    section_locks: {
      customer,
      delivery_address:
        !delivery.locked && f.buyerChanged
          ? lock('Kupujący zmienił adres dostawy w portalu. Zmienisz go w panelu adresu dostawy kupującego.')
          : delivery,
      invoice: invoiced ? CORRECTION : cancelled ? CANCELLED : OPEN,
      products,
      delivery_method: delivery,
      payment: payment_edit.state.locked && payment_edit.method.locked ? payment_edit.state : OPEN,
      extra: OPEN,
    },
    payment_edit,
  };
}

/** Role layer: a viewer (or a key without orders:write) reads only; only an administrator and the accountant
 * "Księgowa" (a session viewer with the 266 grant) change the payment state. The accountant edits the payment
 * section by the administrator's rules and reads every other section. */
export function sectionLocksForActor<T extends { section_locks: SectionLocks; payment_edit: PaymentEdit }>(
  p: T,
  actor: Pick<Actor, 'role' | 'accountant'>,
  apiScopes?: string[],
): T {
  if (actor.role === 'viewer' && actor.accountant === true && !apiScopes) {
    const all = Object.fromEntries(Object.keys(p.section_locks).map((k) => [k, READ_ONLY])) as SectionLocks;
    return { ...p, section_locks: { ...all, payment: p.section_locks.payment } };
  }
  if (actor.role === 'viewer' || (apiScopes && !apiScopes.includes('orders:write'))) {
    const all = Object.fromEntries(Object.keys(p.section_locks).map((k) => [k, READ_ONLY])) as SectionLocks;
    return { ...p, section_locks: all, payment_edit: { state: READ_ONLY, method: READ_ONLY } };
  }
  if (actor.role === 'admin') return p;
  const payment_edit = { ...p.payment_edit, state: p.payment_edit.state.locked ? p.payment_edit.state : ADMIN_PAYMENT };
  return {
    ...p,
    payment_edit,
    section_locks: { ...p.section_locks, payment: payment_edit.method.locked ? payment_edit.state : p.section_locks.payment },
  };
}

const latestValues = (events: Row[], section: OrderSection): Row | undefined =>
  [...events].reverse().find((e) => e.kind === SECTION_EDITED && e.detail?.section === section && e.detail?.values)?.detail.values;
const str = (v: unknown) => (typeof v === 'string' ? v : '');

async function salesDimensions(c: PoolClient, id: string): Promise<Row | undefined> {
  if (!(await salesDimensionsAvailable(c))) return undefined;
  return (await c.query('SELECT delivery_method,delivery_label,payment_method FROM order_sales_dimensions WHERE order_id=$1', [id])).rows[0];
}
/** The latest money received and not reversed (receipt or courier collection). */
async function lastReceipt(c: PoolClient, id: string): Promise<Row | undefined> {
  return (
    await c.query(
      `SELECT p.* FROM payment_entries p WHERE p.order_id=$1 AND p.kind IN ('receipt','courier_collection')
        AND NOT EXISTS(SELECT 1 FROM payment_entries r WHERE r.reversal_of=p.id) ORDER BY p.created_at DESC,p.id DESC LIMIT 1`,
      [id],
    )
  ).rows[0];
}
const warsawDay = (d: Date) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);

/** Current values of every section. `payment` is the paymentBalance of the order. */
export async function sectionValuesInTx(c: PoolClient, o: Row, events: Row[], payment: Row): Promise<SectionValues> {
  const a: Row = o.address ?? {};
  const dims = await salesDimensions(c, o.id);
  const firstCarrier = (await c.query('SELECT carrier FROM shipments WHERE order_id=$1 ORDER BY created_at,id LIMIT 1', [o.id])).rows[0]?.carrier;
  const invoice = latestValues(events, 'invoice'), method = latestValues(events, 'delivery_method'), pay = latestValues(events, 'payment');
  const dimDelivery = (DELIVERY_METHODS as readonly string[]).includes(dims?.delivery_method) ? dims!.delivery_method : undefined;
  const dimPayment = (PAYMENT_METHODS as readonly string[]).includes(dims?.payment_method) ? dims!.payment_method : undefined;
  const state = paymentState({ payment_mode: o.payment_mode, net: Number(payment.net), nominal: Number(payment.nominal) });
  const receipt = Number(payment.net) > 0 ? await lastReceipt(c, o.id) : undefined;
  return {
    customer: { name: o.customer_name, company: str(a.company), email: o.email, phone: str(a.phone) },
    delivery_address: {
      recipient: str(a.recipient) || o.customer_name,
      street: str(a.street),
      postal_code: str(a.postal_code),
      city: str(a.city),
      country: str(a.country) || 'PL',
      pickup_point: str(a.locker_code),
    },
    invoice: {
      wants_invoice: invoice?.wants_invoice === true,
      buyer: str(invoice?.buyer),
      nip: str(invoice?.nip),
      street: str(invoice?.street),
      postal_code: str(invoice?.postal_code),
      city: str(invoice?.city),
      country: str(invoice?.country) || str(a.country) || 'PL',
    },
    products: {},
    delivery_method: {
      method: str(method?.method) || (a.locker_code ? 'parcel_locker' : dimDelivery ?? 'courier'),
      carrier: method ? str(method.carrier) : str(firstCarrier),
      cost: Number(o.shipping_cost),
    },
    payment: {
      state: state === 'overpaid' ? 'paid' : state,
      amount: Number(payment.net),
      paid_at: receipt ? str(receipt.request?.paid_at) || warsawDay(new Date(receipt.created_at)) : '',
      reference: receipt ? str(receipt.request?.reference) || str(receipt.reference) : '',
      method: str(pay?.method) || (o.payment_mode === 'cod' ? 'cod' : dimPayment ?? 'transfer'),
    },
    extra: { note: o.note ?? '' },
  };
}

/** The card payload block: values and order-state locks (no role; GET and PATCH apply sectionLocksForActor). */
export async function orderSectionsInTx(c: PoolClient, o: Row, events: Row[], payment?: Row): Promise<OrderSectionsPayload> {
  const facts = await orderFacts(c, o.id);
  return { ...stateLocks(o, facts), section_values: await sectionValuesInTx(c, o, events, payment ?? (await paymentBalance(c, o.id))) };
}

export class SectionLockedError extends Problem {
  constructor(public lock: SectionLock) {
    super(423, lock.reason ?? 'Sekcja jest zablokowana', 'section_locked');
  }
}
const assertOpen = (l: SectionLock) => {
  if (l.locked) throw new SectionLockedError(l);
};
/** A write refused by a sealed guard of the database becomes a 409 with its Polish message. */
async function guardedWrite(c: PoolClient, sql: string, params: unknown[]) {
  await c.query('SAVEPOINT order_section');
  try {
    const r = await c.query(sql, params);
    await c.query('RELEASE SAVEPOINT order_section');
    return r;
  } catch (e: any) {
    await c.query('ROLLBACK TO SAVEPOINT order_section');
    await c.query('RELEASE SAVEPOINT order_section');
    if (['23514', 'P0001', '55000'].includes(e?.code)) throw new Problem(409, 'Zmiana odrzucona: ' + String(e.message).slice(0, 300));
    throw e;
  }
}

const LEDGER_METHOD: Record<string, string> = { transfer: 'bank_transfer', card: 'card', cash: 'cash' };
async function receipt(c: PoolClient, a: Actor, o: Row, amount: number, v: SectionValues['payment']) {
  const request = { source: 'order_section', paid_at: v.paid_at, reference: v.reference, method: v.method };
  await appendPayment(c, a, o.id, randomUUID(), request, {
    kind: 'receipt',
    amount,
    currency: o.currency,
    method: LEDGER_METHOD[v.method] ?? 'other',
    reference: v.reference || 'Ręczne oznaczenie płatności na karcie zamówienia',
    note: v.paid_at ? 'Data wpłaty: ' + v.paid_at : '',
  });
}
/** Payment state through the ledger; the stage follows as after a line edit (decision 6.11.2026). */
async function applyPaymentState(c: PoolClient, a: Actor, o: Row, cur: SectionValues['payment'], next: SectionValues['payment'], facts: OrderFacts) {
  const mode = next.state === 'cod' ? 'cod' : 'prepaid';
  if (mode !== o.payment_mode) {
    ensure(!SHIPPED_ON.includes(o.status), 409, 'Po nadaniu przesyłki nie można zmienić płatności za pobraniem');
    if (facts.tags.has('label') || facts.tags.has('parcel')) throw new SectionLockedError(CANCEL_LABEL);
    await guardedWrite(c, 'UPDATE orders SET payment_mode=$2,updated_at=now() WHERE id=$1', [o.id, mode]);
  }
  let balance = await paymentBalance(c, o.id);
  const net = Number(balance.net), nominal = Number(balance.nominal), due = Number(balance.amount_due);
  if (next.state === 'paid') {
    ensure(due > 0 || mode !== o.payment_mode, 409, 'Zamówienie jest już opłacone');
    if (due > 0) await receipt(c, a, o, due, next);
  } else if (next.state === 'partial') {
    ensure(
      next.amount > net && next.amount < nominal,
      422,
      `values.amount: Kwota po częściowej wpłacie musi być większa od dotychczas wpłaconej (${(net / 100).toFixed(2)}) i mniejsza od należności (${(nominal / 100).toFixed(2)})`,
    );
    await receipt(c, a, o, next.amount - net, next);
  } else if (next.state === 'unpaid' && net > 0) {
    const entries = (
      await c.query(
        `SELECT p.id,p.kind FROM payment_entries p WHERE p.order_id=$1 AND p.kind<>'reversal'
          AND NOT EXISTS(SELECT 1 FROM payment_entries r WHERE r.reversal_of=p.id) ORDER BY p.created_at,p.id`,
        [o.id],
      )
    ).rows;
    ensure(
      entries.every((e) => e.kind === 'receipt'),
      409,
      'Zamówienie ma pobranie kuriera lub zwrot środków. Skoryguj te wpisy w historii płatności, zanim oznaczysz zamówienie jako nieopłacone.',
    );
    for (const e of entries) {
      const entry = await reversalEntry(c, o.id, e.id);
      await appendPayment(c, a, o.id, randomUUID(), { source: 'order_section', reverses: e.id }, { ...entry, note: 'Oznaczono jako nieopłacone na karcie zamówienia' });
    }
  }
  const fresh = (await c.query('SELECT * FROM orders WHERE id=$1', [o.id])).rows[0];
  if (fresh.payment_mode === 'cod' && fresh.status === 'new') {
    await guardedWrite(c, "UPDATE orders SET status='paid',updated_at=now() WHERE id=$1 AND status='new'", [o.id]);
    await event(c, a.tenantId, o.id, 'order.paid', { from: 'new', to: 'paid', scope: 'cod' });
  } else await settlePaymentStage(c, a, fresh);
  balance = await paymentBalance(c, o.id);
  return balance;
}

async function applySection(
  c: PoolClient,
  a: Actor,
  o: Row,
  section: EditableSection,
  cur: Row,
  next: Row,
  p: OrderSectionsPayload,
  facts: OrderFacts,
) {
  const address: Row = { ...(o.address ?? {}) };
  if (section === 'customer') {
    address.phone = next.phone;
    if (next.company) address.company = next.company;
    else delete address.company;
    await guardedWrite(c, 'UPDATE orders SET customer_name=$2,email=$3,address=$4,updated_at=now() WHERE id=$1', [
      o.id,
      next.name,
      next.email,
      JSON.stringify(address),
    ]);
  } else if (section === 'delivery_address') {
    Object.assign(address, { street: next.street, postal_code: next.postal_code, city: next.city, country: next.country });
    if (next.recipient && next.recipient !== o.customer_name) address.recipient = next.recipient;
    else delete address.recipient;
    if (next.pickup_point) address.locker_code = next.pickup_point;
    else delete address.locker_code;
    await guardedWrite(c, 'UPDATE orders SET address=$2,updated_at=now() WHERE id=$1', [o.id, JSON.stringify(address)]);
  } else if (section === 'delivery_method' && next.cost !== cur.cost) {
    const total = Number(o.total) + next.cost - cur.cost;
    ensure(Number.isSafeInteger(total) && total >= 0 && total <= 2147483647, 422, 'Wartość zamówienia przekracza limit');
    await guardedWrite(c, 'UPDATE orders SET shipping_cost=$2,total=$3,updated_at=now() WHERE id=$1', [o.id, next.cost, total]);
    await settlePaymentStage(c, a, o);
  } else if (section === 'extra') {
    await guardedWrite(c, 'UPDATE orders SET note=$2,updated_at=now() WHERE id=$1', [o.id, next.note]);
  } else if (section === 'payment') {
    const statePart = (['state', 'amount', 'paid_at', 'reference'] as const).some((f) => cur[f] !== next[f]);
    if (cur.method !== next.method) assertOpen(p.payment_edit.method);
    if (statePart) {
      assertOpen(p.payment_edit.state);
      ensure(
        cur.state !== next.state || (next.state === 'partial' && next.amount !== cur.amount),
        422,
        'Zapisanych wpłat nie zmienia się. Skoryguj wpis w historii płatności.',
      );
      await applyPaymentState(c, a, o, cur as SectionValues['payment'], next as SectionValues['payment'], facts);
    }
  }
  // Values kept only in the history (invoice, delivery method, payment method) still make a new revision.
  await c.query('UPDATE orders SET updated_at=now() WHERE id=$1', [o.id]);
}

const eventsOf = async (c: PoolClient, id: string) =>
  (await c.query('SELECT * FROM order_events WHERE order_id=$1 ORDER BY created_at,id', [id])).rows;

/** Saves one section and returns the card payload with the actor's locks. */
export async function updateOrderSectionInTx(
  c: PoolClient,
  a: Actor,
  actorName: string | null,
  id: string,
  section: EditableSection,
  raw: unknown,
  apiScopes?: string[],
) {
  const body = sectionBody(section).parse(raw);
  const o = await lockedOrder(c, id);
  ensure(String(o.version) === body.expected_version, 409, ORDER_EDIT_CONFLICT);
  const facts = await orderFacts(c, id);
  const p = sectionLocksForActor(
    { ...stateLocks(o, facts), section_values: await sectionValuesInTx(c, o, await eventsOf(c, id), await paymentBalance(c, id)) },
    a,
    apiScopes,
  );
  const cur = p.section_values[section] as Row;
  const next = { ...cur, ...body.values } as Row;
  checkMerged(section, next as any, { source: o.source, deliveryMethod: String(p.section_values.delivery_method?.method ?? '') });
  let changes = sectionChanges(section, cur as any, next as any, o.currency);
  if (!changes.length) return cardPayload(c, a, id, apiScopes);
  // Payment has its own two-part lock (payment_edit), checked per changed part in applySection.
  if (section !== 'payment') assertOpen(p.section_locks[section]);
  await applySection(c, a, o, section, cur, next, p, facts);
  let after = next;
  if (section === 'payment') {
    const fresh = (await c.query('SELECT * FROM orders WHERE id=$1', [id])).rows[0];
    const values = await sectionValuesInTx(c, fresh, await eventsOf(c, id), await paymentBalance(c, id));
    after = { ...values.payment, method: next.method };
    changes = sectionChanges('payment', cur as any, after as any, o.currency);
  }
  const detail = { section, actor_id: a.userId, actor_name: actorName, changes, values: after };
  await event(c, a.tenantId, id, SECTION_EDITED, detail);
  // payment.changed is the ledger/state change; a new descriptive method alone is only a section edit.
  if (section === 'payment' && (after.state !== cur.state || after.amount !== cur.amount))
    await event(c, a.tenantId, id, PAYMENT_CHANGED, {
      from: cur.state,
      to: after.state,
      amount: after.amount,
      method: after.method,
      actor_id: a.userId,
    });
  await audit(c, a, 'order.section_edit', id, { section, fields: changes.map((x) => x.field) });
  return cardPayload(c, a, id, apiScopes);
}

/** The full card payload (GET /api/orders/:id) with the locks of this actor. */
export async function cardPayload(c: PoolClient, a: Pick<Actor, 'role' | 'accountant'>, id: string, apiScopes?: string[]) {
  return sectionLocksForActor(await getOrder(c, id), a, apiScopes);
}
