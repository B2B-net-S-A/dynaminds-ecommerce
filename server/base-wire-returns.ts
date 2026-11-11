/** Base "returns" family on connector.php: getOrderReturnStatusList, addOrderReturn,
 * getOrderReturns, setOrderReturnStatus, setOrderReturnRefund,
 * getOrderReturnPaymentsHistory over the native RMA (return_cases, requestReturn,
 * decideReturn, recordRefund, payment_entries) with the 220 order/product/warehouse IDs.
 * Source: docs/parity/base-api-return-contracts.v1.json. getOrderReturnReasonsList and
 * return_reason_id use the native 223 reason dictionary (return_reasons223).
 * Field mapping and every local choice: docs/parity/BASE-WIRE-RETURNS-20261023.md.
 * No database/runtime import: the native port is supplied at startup.
 */
import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { Actor } from './domain';
import { Problem, ensure } from './errors';
import type { BaseWireJson } from './base-wire-codec';
import type { BaseWireFamily } from './base-wire-routes';
import { BASE_WIRE_RESERVED_STATUS_IDS } from './base-wire-orders';

export const BASE_WIRE_RETURNS_METHODS = ['getOrderReturnStatusList','addOrderReturn','getOrderReturns','setOrderReturnStatus',
  'setOrderReturnRefund','getOrderReturnPaymentsHistory','getOrderReturnReasonsList'] as const;
type Method = typeof BASE_WIRE_RETURNS_METHODS[number];
function method(value: string): asserts value is Method {
  ensure(BASE_WIRE_RETURNS_METHODS.includes(value as Method), 400, 'Nieznana metoda Base zwrotów');
}
const WRITES: readonly string[] = ['addOrderReturn', 'setOrderReturnStatus', 'setOrderReturnRefund'];
export function isBaseWireReturnsWrite(value: string) { method(value); return WRITES.includes(value); }
/** LOCAL: no returns read/write scope exists (returns:configure is status configuration).
 * Reads orders:read, writes orders:write, which also requires orders:read. */
export function baseWireReturnsScope(value: string) {
  return isBaseWireReturnsWrite(value) ? 'orders:write' as const : 'orders:read' as const;
}
/** Base getOrderReturns result cap (contract: maximum 100 returns). */
export const BASE_WIRE_RETURNS_PAGE = 100;
/** Fixed native return_cases states as Base return statuses, inside the reserved
 * range of base-wire-orders.ts. Never renumber; append only. */
export const BASE_WIRE_RETURN_STATUSES = Object.freeze([
  ['requested', 2147483101, 'Do rozpatrzenia'], ['refund_pending', 2147483102, 'Uznane — do rozliczenia'],
  ['closed', 2147483103, 'Zamknięte'], ['rejected', 2147483104, 'Odrzucone'], ['cancelled', 2147483105, 'Anulowane'],
].map(([state, id, name]) => Object.freeze({ state: state as string, id: id as number, name: name as string })));
const STATUS_COLOR = '#3455db';
/** Base fulfillment_status: 0 active, 5 accepted, 1 done, 2 canceled. */
const FULFILLMENT: Record<string, number> = { requested: 0, refund_pending: 5, closed: 1, rejected: 2, cancelled: 2 };
export function baseWireReturnStatusId(state: string): number {
  const found = BASE_WIRE_RETURN_STATUSES.find(s => s.state === state);
  ensure(found, 503, 'Nieznany stan zwrotu');
  return found.id;
}
for (const s of BASE_WIRE_RETURN_STATUSES) ensure(s.id >= BASE_WIRE_RESERVED_STATUS_IDS.from && s.id <= BASE_WIRE_RESERVED_STATUS_IDS.to, 503, 'Status zwrotu poza zakresem');

/** LOCAL (no migration): return cases have no 220 sidecar. The Base return_id is
 * derived from the immutable return_cases UUID exactly like pick_list_id: hex digits
 * 1–12 and 14 (the 52 random bits of a v4 UUID) + 1, i.e. 1..2^52. A collision with
 * another case of the same company fails the call (503 LOCAL_BASE_WIRE_RETURN_ID). */
export function baseWireReturnKey(returnId: string) {
  const hex = z.uuid().parse(returnId).replace(/-/g, '');
  return hex.slice(0, 12) + hex.slice(13, 14);
}
export function baseWireReturnId(returnId: string) { return parseInt(baseWireReturnKey(returnId), 16) + 1; }

export type BaseWireReturnOrderLine = { item_id: string; product_public_id: number; parent_public_id: number|null; catalog_public_id: number;
  sku: string; ean: string|null; quantity: number; line_total: number; vat: number };
export type BaseWireReturnOrder = { id: string; currency: string; email: string; customer_name: string; address: Record<string, unknown>;
  warehouse_id: string; lines: BaseWireReturnOrderLine[] };
export type BaseWireReturnLine = BaseWireReturnOrderLine & { name: string; requested: number };
export type BaseWireReturn = {
  id: string; order_public_id: number; external_id: string|null; number: string; state: string; created: number; in_status: number;
  currency: string; refunded: number; email: string; customer_name: string; address: Record<string, unknown>; shipping: number;
  reason: string; reason_public_id: number|null; warehouse_public_id: number; lines: BaseWireReturnLine[];
};
/** Bounds are inclusive; `date_from` and `id_from` together form one keyset tuple.
 * `id_from` alone orders by return_id, otherwise by (creation second, return_id). */
export type BaseWireReturnsFilter = { order_public_id?: number; return_ids?: string[]; date_from?: number; id_from?: number; state?: string; limit: number };
export type BaseWireNativeReturnInput = { kind: 'return'; reason: string; warehouse_id: string; shipping_refund: number;
  items: { item_id: string; quantity: number }[]; reason_public_id?: number };
export type BaseWireReturnState = { id: string; state: string; version: number; settlement: { amount: number; reference: string }|null };
export type BaseWireReturnPayment = { amount: number; currency: string; reference: string; date: number };
/** One native port per transaction; every lookup is the current tenant only. */
export type BaseWireReturnsNative = {
  /** base_wire220_allocate_pending('order') for the current tenant (writing transaction only). */
  allocate(): Promise<void>;
  /** Own order UUID for a numeric order_id (220), or null. */
  order(publicId: number): Promise<string|null>;
  snapshot(orderId: string): Promise<BaseWireReturnOrder>;
  warehouses(): Promise<{ id: string; public_id: number }[]>;
  /** Own return-case UUIDs whose derived return_id equals the given one (normally 0 or 1). */
  find(publicId: number): Promise<string[]>;
  /** Another case of the company maps to the same derived return_id. */
  taken(returnId: string, key: string): Promise<boolean>;
  returns(filter: BaseWireReturnsFilter): Promise<BaseWireReturn[]>;
  state(returnId: string): Promise<BaseWireReturnState>;
  payments(returnId: string): Promise<{ total: number; entries: BaseWireReturnPayment[] }>;
  replay(clientKey: string, requestHash: string): Promise<Record<string, BaseWireJson>|null>;
  remember(clientKey: string, response: Record<string, BaseWireJson>): Promise<void>;
  /** Active 223 dictionary reasons by position, then public ID. */
  reasons(): Promise<{ public_id: number; name: string }[]>;
  /** Native requestReturn (POST /api/orders/:id/returns semantics; a fresh native client_key);
   * reason_public_id → the own 223 reason (unknown 404, inactive 422). */
  request(orderId: string, input: BaseWireNativeReturnInput): Promise<string>;
  /** Native decideReturn (POST /api/returns/:id/decision). */
  decide(returnId: string, input: { version: number; decision: 'reject'|'cancel'; note: string }): Promise<void>;
  /** Native recordRefund (POST /api/returns/:id/refund). */
  refund(returnId: string, input: { version: number; amount: number; reference: string; confirmed: true }): Promise<void>;
};
export type BaseWireReturnsPorts = {
  transaction<T>(actor: Actor, writing: boolean, work: (c: PoolClient) => Promise<T>): Promise<T>;
  native(c: PoolClient, actor: Actor): BaseWireReturnsNative;
  /** Startup decision: a read-only copy never allocates identities. */
  allocateOnRead: boolean;
  /** Startup decision: the 223 reason dictionary is installed. */
  reasons?: boolean;
};

const id = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const optionalId = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const unix = z.number().int().min(0).max(253402300799);
const flag = z.union([z.boolean(), z.literal(0), z.literal(1), z.literal('0'), z.literal('1')]).transform(v => v === true || v === 1 || v === '1');
const text = (max: number) => z.string().max(max);
const looseId = z.union([optionalId, z.literal(''), z.string().regex(/^(0|[1-9][0-9]{0,15})$/).transform(Number)]).transform(v => v === '' ? 0 : v);
const decimal = z.union([z.number(), z.string().regex(/^[0-9]{1,8}(\.[0-9]{1,6})?$/).transform(Number)]);
/** Base float major units → native integer minor units; more than two decimals is refused. */
function minor(value: number) {
  const cents = Math.round(value * 100);
  if (!Number.isFinite(value) || value < 0 || Math.abs(value * 100 - cents) > 1e-6 || cents > 2147483647)
    throw new Problem(422, 'Nieprawidłowa kwota', 'LOCAL_BASE_WIRE_AMOUNT');
  return cents;
}
const major = (value: number) => Math.round(value) / 100;
const unitPrice = (l: { line_total: number; quantity: number }) => major(l.line_total / l.quantity);
const str = (value: unknown) => typeof value === 'string' ? value : '';
const local = (status: number, message: string, code: string): never => { throw new Problem(status, message, code); };
const unsupported = () => local(422, 'Pole nie jest obsługiwane lokalnie', 'LOCAL_BASE_WIRE_UNSUPPORTED_FIELD');
const empty = (v: unknown) => v === undefined || v === '' || v === 0 || v === false;

const productLine = z.object({
  order_product_id: looseId.optional(), storage: z.literal('db').optional(), storage_id: looseId.optional(),
  product_id: z.union([z.literal(''), z.string().regex(/^[1-9][0-9]{0,15}$/), id]).optional(), variant_id: looseId.optional(),
  name: text(200).optional(), sku: text(200).optional(), ean: text(32).optional(), location: text(200).optional(),
  warehouse_id: looseId.optional(), attributes: text(350).optional(), price_brutto: decimal.optional(), tax_rate: decimal.optional(),
  quantity: z.number().int().min(1).max(100000), weight: decimal.optional(), status_id: looseId.optional(), return_reason_id: looseId.optional(),
}).strict();
const addInput = z.object({
  // LOCAL: a native return case always belongs to an own order.
  order_id: id, status_id: looseId.optional(), custom_source_id: looseId.optional(), reference_number: text(100).optional(),
  date_add: unix.optional(), currency: z.string().regex(/^[A-Z]{3}$/).optional(), refunded: flag.optional(), admin_comments: text(200).optional(),
  email: text(150).optional(), phone: text(100).optional(), user_login: text(30).optional(), delivery_price: decimal.optional(),
  delivery_fullname: text(100).optional(), delivery_company: text(100).optional(), delivery_address: text(100).optional(),
  delivery_postcode: text(100).optional(), delivery_city: text(100).optional(), delivery_state: text(20).optional(),
  delivery_country_code: z.union([z.literal(''), z.string().regex(/^[A-Za-z]{2}$/)]).optional(),
  extra_field_1: text(50).optional(), extra_field_2: text(50).optional(),
  custom_extra_fields: z.union([z.array(z.never()).max(0), z.record(z.string(), z.never())]).optional(),
  // LOCAL ceiling: the native return holds at most 100 lines.
  products: z.array(productLine).min(1).max(100),
  refund_account_number: text(50).optional(), refund_iban: text(34).optional(), refund_swift: text(11).optional(),
}).strict();
// LOCAL: return fields with no native column are refused when non-empty, never silently dropped.
const unmapped = ['custom_source_id','reference_number','refunded','user_login','delivery_company','delivery_state',
  'extra_field_1','extra_field_2','refund_account_number','refund_iban','refund_swift'] as const;
const linesUnmapped = ['order_product_id','location','attributes','status_id'] as const;
const statusInput = z.object({ return_id: id, status_id: id }).strict();
const refundInput = z.object({
  return_id: id, order_refund_done: decimal, refund_date: unix.optional(), refund_comment: text(50).optional(), external_refund_id: text(50).optional(),
}).strict();
const historyInput = z.object({ return_id: id, show_full_history: flag.optional() }).strict();
const listInput = z.object({}).strict();
const returnsInput = z.object({
  order_id: id.optional(), return_id: id.optional(), date_from: unix.optional(), id_from: id.optional(), status_id: id.optional(),
  filter_order_return_source: text(20).optional(), filter_order_return_source_id: optionalId.optional(),
  include_custom_extra_fields: z.boolean().optional(), include_connect_data: z.boolean().optional(),
}).strict()
  .refine(v => v.filter_order_return_source_id === undefined || v.filter_order_return_source !== undefined, 'filter_order_return_source_id wymaga filter_order_return_source');
const unsupportedFlags = ['include_custom_extra_fields','include_connect_data'] as const;
/** LOCAL default when Base sends no admin_comments (the native reason is required, 3–2000 characters). */
export const BASE_WIRE_RETURN_REASON = 'Zwrot zgłoszony przez Base API';
/** LOCAL note of a native decision made through setOrderReturnStatus. */
export const BASE_WIRE_RETURN_DECISION_NOTE = 'Status zmieniony przez Base API';

function returnDto(r: BaseWireReturn): Record<string, BaseWireJson> {
  const a = r.address;
  return {
    return_id: baseWireReturnId(r.id), order_id: r.order_public_id, shop_order_id: 0, external_order_id: r.external_id ?? '',
    reference_number: r.number, order_return_source: 'personal', order_return_source_id: 0, status_id: baseWireReturnStatusId(r.state),
    date_add: r.created, date_in_status: r.in_status, user_login: '', currency: r.currency, refunded: major(r.refunded),
    email: r.email, phone: str(a.phone), delivery_price: major(r.shipping), delivery_fullname: r.customer_name, delivery_company: '',
    delivery_address: str(a.street), delivery_postcode: str(a.postal_code), delivery_city: str(a.city), delivery_state: '', delivery_country: '',
    delivery_country_code: str(a.country), extra_field_1: '', extra_field_2: '', admin_comments: r.reason,
    delivery_package_module: '', delivery_package_nr: '',
    // The contract table and its example name the refund account fields differently: both are sent (LOCAL).
    order_return_account_number: '', order_return_iban: '', order_return_swift: '', refund_account_number: '', refund_iban: '', refund_swift: '',
    fulfillment_status: FULFILLMENT[r.state],
    products: r.lines.map(l => ({
      storage: 'db', storage_id: l.catalog_public_id, order_return_product_id: 0, order_product_id: 0,
      product_id: String(l.parent_public_id ?? l.product_public_id), variant_id: l.parent_public_id === null ? '0' : String(l.product_public_id),
      name: l.name, sku: l.sku, ean: l.ean ?? '', location: '', warehouse_id: r.warehouse_public_id, auction_id: '', attributes: '',
      price_brutto: unitPrice(l), tax_rate: l.vat, quantity: l.requested, weight: 0, bundle_id: 0, status_id: 0,
      // LOCAL: the native reason belongs to the case, so every line carries the case's 223 reason (0 = other).
      return_reason_id: r.reason_public_id ?? 0, return_reason_comment: '',
    })),
  };
}
const same = (given: string|undefined, actual: string, fold = (v: string) => v.trim()) => given === undefined || given === '' || fold(given) === fold(actual);

export function createBaseWireReturnsService(ports: BaseWireReturnsPorts) {
  const tx = <T>(actor: Actor, writing: boolean, work: (n: BaseWireReturnsNative) => Promise<T>) =>
    ports.transaction(actor, writing, c => work(ports.native(c, actor)));
  const hash = (actor: Actor, selected: Method, parameters: Record<string, BaseWireJson>) =>
    createHash('sha256').update(JSON.stringify({ api_key_id: actor.apiKeyId, method: selected, parameters })).digest('hex');
  function writer(actor: Actor, options: { clientKey?: string }) {
    ensure(actor.source === 'api' && !!actor.apiKeyId, 503, 'Brak klucza API');
    // Same role gate as the native return routes (viewer refused).
    ensure(actor.role === 'admin' || actor.role === 'operator', 403, 'Konto ma uprawnienia tylko do odczytu');
    return options.clientKey === undefined ? undefined : z.uuid().parse(options.clientKey);
  }
  /** Replay inside the effect's transaction; the response is stored before COMMIT. */
  function once(actor: Actor, selected: Method, parameters: Record<string, BaseWireJson>, clientKey: string|undefined,
    work: (n: BaseWireReturnsNative) => Promise<Record<string, BaseWireJson>>) {
    const requestHash = hash(actor, selected, parameters);
    return tx(actor, true, async n => {
      if (clientKey) { const retained = await n.replay(clientKey, requestHash); if (retained) return retained; }
      const response = await work(n);
      if (clientKey) await n.remember(clientKey, response);
      return response;
    });
  }
  async function own(n: BaseWireReturnsNative, publicId: number) {
    const found = await n.find(publicId);
    ensure(found.length <= 1, 503, 'Niejednoznaczny identyfikator zwrotu Base');
    ensure(found.length === 1, 404, 'Nie znaleziono zwrotu');
    return found[0];
  }
  async function add(actor: Actor, parameters: Record<string, BaseWireJson>, options: { clientKey?: string }) {
    const b = addInput.parse(parameters);
    for (const field of unmapped) if (!empty(b[field])) unsupported();
    for (const line of b.products) for (const field of linesUnmapped) if (!empty(line[field])) unsupported();
    // LOCAL: one native reason per case; all non-zero line reasons must agree (0/omitted = other).
    const reasonIds = [...new Set(b.products.map(l => l.return_reason_id ?? 0).filter(x => x !== 0))];
    if (reasonIds.length && ports.reasons !== true) unsupported();
    ensure(reasonIds.length <= 1, 422, 'Pozycje jednego zwrotu muszą wskazywać ten sam powód');
    if (b.status_id) {
      const target = BASE_WIRE_RETURN_STATUSES.find(s => s.id === b.status_id);
      ensure(target, 404, 'Nie znaleziono statusu zwrotu');
      // LOCAL: a new native case always starts as requested.
      if (target.state !== 'requested') local(422, 'Nowy zwrot ma zawsze status do rozpatrzenia', 'LOCAL_BASE_WIRE_RETURN_STATUS');
    }
    const clientKey = writer(actor, options);
    const shipping = minor(b.delivery_price ?? 0);
    const reason = (b.admin_comments ?? '').trim() || BASE_WIRE_RETURN_REASON;
    return once(actor, 'addOrderReturn', parameters, clientKey, async n => {
      const orderId = await n.order(b.order_id);
      ensure(orderId, 404, 'Nie znaleziono zamówienia');
      const o = await n.snapshot(orderId);
      ensure(b.currency === undefined || b.currency === o.currency, 422, 'Waluta zwrotu musi być walutą zamówienia');
      // LOCAL: the native case has no own buyer data; it is the order's buyer, so Base values must match it.
      const a = o.address;
      ensure(same(b.email, o.email, v => v.trim().toLowerCase()) && same(b.phone, str(a.phone)) && same(b.delivery_fullname, o.customer_name)
        && same(b.delivery_address, str(a.street)) && same(b.delivery_postcode, str(a.postal_code)) && same(b.delivery_city, str(a.city))
        && same(b.delivery_country_code, str(a.country), v => v.trim().toUpperCase()), 422, 'Dane kupującego nie odpowiadają zamówieniu');
      const chosen = [...new Set(b.products.map(l => l.warehouse_id ?? 0).filter(w => w !== 0))];
      ensure(chosen.length <= 1, 422, 'Pozycje jednego zwrotu muszą wskazywać ten sam magazyn');
      let warehouse = o.warehouse_id;
      if (chosen.length) {
        const w = (await n.warehouses()).find(x => x.public_id === chosen[0]);
        ensure(w, 404, 'Nie znaleziono własnego magazynu Base');
        warehouse = w.id;
      }
      const items: BaseWireNativeReturnInput['items'] = [];
      for (const l of b.products) {
        const product = l.product_id === undefined || l.product_id === '' ? 0 : Number(l.product_id), variant = l.variant_id ?? 0;
        let candidates = o.lines.filter(x => variant ? x.product_public_id === variant && (!product || x.parent_public_id === product)
          : product ? x.parent_public_id === null && x.product_public_id === product : l.sku ? x.sku === l.sku : !!l.ean && x.ean === l.ean);
        if (l.price_brutto !== undefined) { const price = minor(l.price_brutto); candidates = candidates.filter(x => Math.round(x.line_total / x.quantity) === price); }
        if (l.tax_rate !== undefined) candidates = candidates.filter(x => x.vat === l.tax_rate);
        if (l.storage_id) candidates = candidates.filter(x => x.catalog_public_id === l.storage_id);
        if (l.sku && (product || variant)) candidates = candidates.filter(x => x.sku === l.sku);
        ensure(candidates.length, 404, 'Pozycja nie należy do zamówienia');
        // LOCAL: order lines have no Base identity; several lines of one product need price_brutto to tell them apart.
        ensure(candidates.length === 1, 422, 'Pozycja wskazuje więcej niż jedną linię zamówienia; podaj price_brutto');
        ensure(!items.some(i => i.item_id === candidates[0].item_id), 422, 'Pozycje zwrotu nie mogą się powtarzać');
        items.push({ item_id: candidates[0].item_id, quantity: l.quantity });
      }
      // Native rules decide: order released, quantities available, shipping not yet claimed, sale warehouse.
      const created = await n.request(orderId, { kind: 'return', reason, warehouse_id: warehouse, shipping_refund: shipping, items,
        ...(reasonIds.length ? { reason_public_id: reasonIds[0] } : {}) });
      if (await n.taken(created, baseWireReturnKey(created))) local(503, 'Kolizja identyfikatora zwrotu Base', 'LOCAL_BASE_WIRE_RETURN_ID');
      return { return_id: baseWireReturnId(created) };
    });
  }
  async function setStatus(actor: Actor, parameters: Record<string, BaseWireJson>, options: { clientKey?: string }) {
    const b = statusInput.parse(parameters);
    const clientKey = writer(actor, options);
    return once(actor, 'setOrderReturnStatus', parameters, clientKey, async n => {
      const r = await n.state(await own(n, b.return_id));
      const target = BASE_WIRE_RETURN_STATUSES.find(s => s.id === b.status_id);
      ensure(target, 404, 'Nie znaleziono statusu zwrotu');
      if (r.state === target.state) return {};
      // LOCAL: acceptance needs per-line quantities and stock decisions (native receive),
      // closing needs a refund confirmation (setOrderReturnRefund); a bare status never implies them.
      if (target.state !== 'rejected' && target.state !== 'cancelled')
        local(409, 'Ten status ustawia natywne przyjęcie lub rozliczenie zwrotu', 'LOCAL_BASE_WIRE_RETURN_TRANSITION');
      await n.decide(r.id, { version: r.version, decision: target.state === 'rejected' ? 'reject' : 'cancel', note: BASE_WIRE_RETURN_DECISION_NOTE });
      return {};
    });
  }
  async function refund(actor: Actor, parameters: Record<string, BaseWireJson>, options: { clientKey?: string }) {
    const b = refundInput.parse(parameters);
    const clientKey = writer(actor, options);
    const amount = minor(b.order_refund_done);
    // The native confirmation needs a reference (3–200 characters): the external ID and/or the comment.
    const reference = [b.external_refund_id?.trim(), b.refund_comment?.trim()].filter(Boolean).join(' · ');
    ensure(reference.length >= 3, 422, 'Podaj external_refund_id lub refund_comment (min. 3 znaki)');
    return once(actor, 'setOrderReturnRefund', parameters, clientKey, async n => {
      const r = await n.state(await own(n, b.return_id));
      if (r.settlement) {
        // Native refunds are final: a replay (lost ACK) is a no-op, never a second payment;
        // Base "replace the amount" semantics are refused.
        if (r.settlement.amount === amount && r.settlement.reference === reference) return {};
        local(409, 'Zwrot jest już rozliczony inną kwotą lub referencją', 'LOCAL_BASE_WIRE_RETURN_REFUNDED');
      }
      // Native rules: state refund_pending, amount = exactly the funds available to give back (else 422).
      await n.refund(r.id, { version: r.version, amount, reference, confirmed: true });
      return {};
    });
  }
  async function history(actor: Actor, parameters: Record<string, BaseWireJson>) {
    const b = historyInput.parse(parameters);
    return tx(actor, false, async n => {
      const r = await own(n, b.return_id);
      const { total, entries } = await n.payments(r);
      // LOCAL: every native entry is a refund confirmation with a reference, so show_full_history changes nothing.
      let paid = 0;
      return { payments: entries.map(e => {
        const before = paid; paid += e.amount;
        return { paid_before: major(before), paid_after: major(paid), total_price: major(total), currency: e.currency,
          external_payment_id: e.reference, date: e.date };
      }) };
    });
  }
  async function list(actor: Actor, parameters: Record<string, BaseWireJson>) {
    const b = returnsInput.parse(parameters);
    for (const f of unsupportedFlags) if (b[f] === true) throw new Problem(422, 'Flaga nie jest obsługiwana lokalnie', 'LOCAL_BASE_WIRE_UNSUPPORTED_FLAG');
    // Natively created orders get their numeric ID first (as getOrders), before the read snapshot.
    if (ports.allocateOnRead) await tx(actor, true, n => n.allocate());
    // LOCAL: every native case is source "personal" with source ID 0.
    const sourceless = (b.filter_order_return_source !== undefined && b.filter_order_return_source !== 'personal') || !!b.filter_order_return_source_id;
    const state = b.status_id === undefined ? undefined : BASE_WIRE_RETURN_STATUSES.find(s => s.id === b.status_id)?.state;
    if (sourceless || (b.status_id !== undefined && !state)) return { returns: [] };
    return tx(actor, false, async n => {
      const ids = b.return_id === undefined ? undefined : await n.find(b.return_id);
      if (ids?.length === 0) return { returns: [] };
      const rows = (await n.returns({ order_public_id: b.order_id, return_ids: ids, date_from: b.date_from, id_from: b.id_from, state,
        limit: BASE_WIRE_RETURNS_PAGE })).slice(0, BASE_WIRE_RETURNS_PAGE);
      const seen = new Set<number>();
      for (const r of rows) {
        const publicId = baseWireReturnId(r.id);
        ensure(!seen.has(publicId), 503, 'Niejednoznaczny identyfikator zwrotu Base');
        seen.add(publicId);
      }
      ensure(b.return_id === undefined || rows.length <= 1, 503, 'Niejednoznaczny identyfikator zwrotu Base');
      return { returns: rows.map(returnDto) };
    });
  }
  return {
    async execute(actor: Actor, selected: string, parameters: Record<string, BaseWireJson>, options: { clientKey?: string; credential?: string } = {}): Promise<Record<string, BaseWireJson>> {
      method(selected);
      if (selected === 'addOrderReturn') return add(actor, parameters, options);
      if (selected === 'setOrderReturnStatus') return setStatus(actor, parameters, options);
      if (selected === 'setOrderReturnRefund') return refund(actor, parameters, options);
      if (selected === 'getOrderReturnPaymentsHistory') return history(actor, parameters);
      if (selected === 'getOrderReturns') return list(actor, parameters);
      listInput.parse(parameters);
      if (selected === 'getOrderReturnReasonsList') {
        if (ports.reasons !== true) local(503, 'Słownik powodów zwrotu jest niedostępny', 'LOCAL_BASE_WIRE_RETURN_REASONS');
        // LOCAL: only active reasons are offered; deactivated ones stay on earlier returns.
        return tx(actor, false, async n => ({ return_reasons: (await n.reasons()).map(r => ({ return_reason_id: r.public_id, name: r.name })) }));
      }
      // LOCAL: fixed native states, no groups or primary status; name_for_customer = name.
      return { statuses: BASE_WIRE_RETURN_STATUSES.map(s => ({ id: s.id, name: s.name, color: STATUS_COLOR, group_id: 0, is_primary: 0, name_for_customer: s.name })) };
    },
  };
}
export type BaseWireReturnsService = ReturnType<typeof createBaseWireReturnsService>;

/** Seventh connector.php family. Only startup capability selects availability. */
export function createBaseWireReturnsFamily(opts: { service: Pick<BaseWireReturnsService, 'execute'>; available: boolean }): BaseWireFamily {
  return Object.freeze({ label: 'zwrotów', methods: BASE_WIRE_RETURNS_METHODS, scope: baseWireReturnsScope, isWrite: isBaseWireReturnsWrite,
    available: opts.available === true, service: opts.service });
}
