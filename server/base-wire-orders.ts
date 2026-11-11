/** Base "orders" family on connector.php: getOrderStatusList, addOrder,
 * getOrders, setOrderStatus, getOrdersByEmail/Phone, getOrderExtraFields,
 * setOrderFields, setOrderPayment, getOrderPaymentsHistory, setOrdersMerge,
 * addOrderBySplit over the native OMS (orders, workflow statuses, order fields,
 * payments, merges, the 222 split) with the 220 numeric identities.
 * Sources: docs/parity/base-api-orders-contracts.v1.json (addOrder, getOrders,
 * setOrderFields, setOrdersMerge, addOrderBySplit), base-api-order-configuration-contracts.v1.json
 * (getOrderStatusList, setOrderStatus, setOrderPayment, getOrderPaymentsHistory) and
 * base-api-orders-next-contracts-20261018.md (getOrdersByEmail/Phone, getOrderExtraFields).
 * Field mapping and every local choice: docs/parity/BASE-WIRE-ORDERS220-20261023.md
 * (addOrderBySplit: docs/parity/ORDER-SPLIT222-20261023.md).
 * No database/runtime import: the native port is supplied at startup.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { Actor } from './domain';
import { Problem, ensure } from './errors';
import type { BaseWireJson } from './base-wire-codec';
import type { BaseWireFamily } from './base-wire-routes';

export const BASE_WIRE_ORDERS_METHODS = ['getOrderStatusList','addOrder','getOrders','setOrderStatus',
  'getOrdersByEmail','getOrdersByPhone','getOrderExtraFields','setOrderFields','setOrderPayment','getOrderPaymentsHistory','setOrdersMerge','addOrderBySplit'] as const;
type Method = typeof BASE_WIRE_ORDERS_METHODS[number];
function method(value: string): asserts value is Method {
  ensure(BASE_WIRE_ORDERS_METHODS.includes(value as Method), 400, 'Nieznana metoda Base zamówień');
}
const WRITES: readonly string[] = ['addOrder', 'setOrderStatus', 'setOrderFields', 'setOrderPayment', 'setOrdersMerge', 'addOrderBySplit'];
export function isBaseWireOrdersWrite(value: string) { method(value); return WRITES.includes(value); }
/** orders:write also requires orders:read (authenticateBaseWireApiKey). Order extra
 * fields use the native order-fields scopes (GET/PATCH /api/orders/:id/fields). */
export function baseWireOrdersScope(value: string) {
  if (value === 'getOrderExtraFields') return 'order-fields:read' as const;
  if (value === 'setOrderFields') return 'order-fields:write' as const;
  return isBaseWireOrdersWrite(value) ? 'orders:write' as const : 'orders:read' as const;
}
/** LOCAL: order field definitions have no 220 sidecar and no migration is added. The
 * Base extra_field_id is derived from the immutable definition UUID like pick_list_id:
 * hex digits 1–12 and 14 (the 52 random bits of a v4 UUID) + 1, i.e. 1..2^52. Two
 * definitions of one company with the same derived ID fail closed (503). */
export function baseWireExtraFieldId(fieldId: string) {
  const hex = z.uuid().parse(fieldId).replace(/-/g, '');
  return parseInt(hex.slice(0, 12) + hex.slice(13, 14), 16) + 1;
}
/** LOCAL: order lines have no 220 sidecar. getOrders order_product_id is derived from the
 * immutable order item UUID exactly like extra_field_id (52 random bits + 1). Two lines of
 * one order with the same derived ID fail addOrderBySplit closed (503). */
export function baseWireOrderProductId(itemId: string) { return baseWireExtraFieldId(itemId); }
/** Native order-field type → Base editor_type (multi_select is Base checkbox). */
const EDITOR_TYPES: Record<string, string> = { text: 'text', number: 'number', select: 'select', radio: 'radio', multi_select: 'checkbox', date: 'date', file: 'file' };
/** Reference of a setOrderPayment receipt; `PAYMENT_REFERENCE + ' ' + external_payment_id` when given. */
export const BASE_WIRE_PAYMENT_REFERENCE = 'Base API setOrderPayment';
/** Base getOrders result cap (contract: "A maximum of 100 orders"). */
export const BASE_WIRE_ORDERS_PAGE = 100;
/** LOCAL policy: numeric IDs 2147483000..2147483647 (the top of int32) are reserved
 * for fixed native statuses (no migration). The global 220 workflow-status identity
 * would reach this range only after ~2.1 billion statuses; a workflow status found
 * there fails the call (503 LOCAL_BASE_WIRE_STATUS_ID_RANGE) instead of colliding. */
export const BASE_WIRE_RESERVED_STATUS_IDS = { from: 2147483000, to: 2147483647 } as const;
/** Fixed order-stage statuses: stage → numeric ID. Never renumber; append only. */
export const BASE_WIRE_STAGE_STATUSES = Object.freeze([
  ['new', 2147483001, 'Nieopłacone'], ['paid', 2147483002, 'Nowe'], ['picking', 2147483003, 'W kompletacji'],
  ['packed', 2147483004, 'Spakowane'], ['shipped', 2147483005, 'Nadane'], ['delivered', 2147483006, 'Dostarczone'],
  ['completed', 2147483007, 'Zakończone'], ['cancelled', 2147483008, 'Anulowane'], ['return_initiated', 2147483009, 'Zwrot zgłoszony'],
  ['return_received', 2147483010, 'Zwrot przyjęty'], ['return_completed', 2147483011, 'Zwrot zakończony'],
].map(([stage, id, name]) => Object.freeze({ stage: stage as string, id: id as number, name: name as string })));
/** Same default colour as a new native workflow status. */
const STAGE_COLOR = '#3455db';
export function baseWireStageStatusId(stage: string): number {
  const found = BASE_WIRE_STAGE_STATUSES.find(s => s.stage === stage);
  ensure(found, 503, 'Nieznany etap zamówienia');
  return found.id;
}
const reserved = (value: number) => value >= BASE_WIRE_RESERVED_STATUS_IDS.from && value <= BASE_WIRE_RESERVED_STATUS_IDS.to;
function ownStatusId(value: number) {
  if (reserved(value)) throw new Problem(503, 'Identyfikator statusu w zakresie zastrzeżonym', 'LOCAL_BASE_WIRE_STATUS_ID_RANGE');
  return value;
}

export type BaseWireOrderStatus = { id: string; public_id: number; name: string; color: string; active: boolean };
export type BaseWireOrderProduct = { id: string; public_id: number; kind: 'simple'|'group'|'variant'|'bundle'; parent_public_id: number|null;
  catalog_public_id: number; sku: string; ean: string|null; vat: number };
export type BaseWireOrderLine = { item_id: string; product_public_id: number; parent_public_id: number|null; catalog_public_id: number;
  name: string; sku: string; ean: string|null; quantity: number; line_total: number; vat: number };
export type BaseWireOrder = {
  public_id: number; source: string; external_id: string|null; status_public_id: number|null;
  created: number; in_status: number; currency: string; payment_mode: string; paid: number; note: string;
  email: string; customer_name: string; address: Record<string, unknown>; shipping_cost: number;
  carrier: string|null; tracking: string|null; picked: boolean; status: string; warehouse_public_id: number;
  lines: BaseWireOrderLine[];
};
/** Bounds are inclusive; `confirmed` and `id` together form one keyset tuple.
 * `id_from` alone orders by order_id, otherwise by (confirmation second, order_id). */
export type BaseWireOrdersFilter = {
  public_id?: number; date_from?: number; confirmed_from?: number; id_from?: number; status_public_id?: number;
  /** Stage status: native stage and no workflow status. */ stage?: string;
  email?: string; sources?: string[]; external_id?: string; limit: number;
  /** Exact native buyer phone (orders.address.phone). */ phone?: string;
  /** Newest first (getOrdersByEmail/Phone). */ descending?: boolean;
};
export type BaseWireExtraField = { id: string; key: string; label: string; type: string; version: number; enabled: boolean;
  options: { id: string; label: string; enabled: boolean }[] };
/** One native order-field change (PATCH /api/orders/:id/fields `changes[]`). */
export type BaseWireFieldChange = { field_id: string; definition_version: number } & ({ type: string; value: string|string[] } | { operation: 'clear' });
/** Native payment ledger entry; `kind` is the effective kind (a reversal carries the reversed kind). */
export type BaseWirePaymentEntry = { kind: string; reversal: boolean; amount: number; method: string; reference: string; note: string; created: number };
export type BaseWireMergeInput = { preview_key: string; execute_key: string; main_order_id: string; order_ids: string[];
  merge_mode: 'technical_merge'|'into_main_order'; sum_delivery_costs: boolean };
/** addOrderBySplit for the native 222 split: lines by their derived Base order_product_id. */
export type BaseWireSplitInput = { preview_key: string; execute_key: string; order_id: string;
  items: { order_product_id: number; quantity: number }[]; shipping_cost_to_child: number };
export type BaseWireNativeOrderInput = {
  customer_name: string; email: string; warehouse_id: string; source: 'manual'; currency: string; payment_mode: 'prepaid'|'cod';
  address: { street: string; city: string; postal_code: string; country: string; phone: string; locker_code?: string };
  shipping_cost: number; items: { product_id: string; quantity: number }[];
  manual_lines: { product_id: string; quantity: number; line_total: number }[]; note: string;
};
/** One native port per transaction; every lookup is the current tenant only. */
export type BaseWireOrdersNative = {
  statuses(): Promise<BaseWireOrderStatus[]>;
  warehouses(): Promise<{ id: string; public_id: number }[]>;
  /** Own products by numeric ID, SKU or EAN (foreign/unknown ones are absent). */
  products(by: { public_ids: number[]; skus: string[]; eans: string[] }): Promise<BaseWireOrderProduct[]>;
  /** base_wire220_allocate_pending('order') for the current tenant (writing transaction only). */
  allocate(): Promise<void>;
  /** Own order UUID for a numeric order_id, or null. */
  order(publicId: number): Promise<string|null>;
  publicId(orderId: string): Promise<number>;
  orders(filter: BaseWireOrdersFilter): Promise<BaseWireOrder[]>;
  replay(clientKey: string, requestHash: string): Promise<Record<string, BaseWireJson>|null>;
  remember(clientKey: string, response: Record<string, BaseWireJson>): Promise<void>;
  /** Native createOrder (POST /api/orders semantics: pricing, reservations, events). */
  create(input: BaseWireNativeOrderInput): Promise<string>;
  /** One receipt for the whole amount due, then the native paid promotion. */
  payInFull(orderId: string): Promise<void>;
  /** Native set_workflow order operation (stage transition rules apply). */
  setStatus(orderId: string, statusId: string): Promise<void>;
  /** Native set_status order operation (transition rules; clears the workflow status).
   * `kept_workflow`: the order was already in the stage under a workflow status (no change). */
  setStage(orderId: string, stage: string): Promise<{ kept_workflow: boolean }>;
  /** Order field definitions readable by the current member (GET /api/order-fields). */
  extraFields(): Promise<BaseWireExtraField[]>;
  /** Native patchOrderFields (source api) at the order's current version. */
  patchFields(orderId: string, changes: BaseWireFieldChange[]): Promise<void>;
  /** Locks the payment owner, then the merge-aware net paid (paymentBalance) and the order version. */
  paymentState(orderId: string): Promise<{ net: number; currency: string; version: number }>;
  /** Native recordPayment: one confirmed receipt (then the native paid promotion). */
  receipt(orderId: string, entry: { amount: number; currency: string; version: number; reference: string; note: string }): Promise<void>;
  /** The order's ledger as GET /api/orders/:id/payments (merge-aware sources), oldest first, unpaged. */
  payments(orderId: string): Promise<{ total: number; currency: string; entries: BaseWirePaymentEntry[] }>;
};
export type BaseWireOrdersPorts = {
  transaction<T>(actor: Actor, writing: boolean, work: (c: PoolClient) => Promise<T>): Promise<T>;
  native(c: PoolClient, actor: Actor): BaseWireOrdersNative;
  /** Startup decision: a read-only copy never allocates identities. */
  allocateOnRead: boolean;
  /** Native order merge: createOrderMergePreview + executeOrderMerge (each its own native
   * transaction, replayed by its client key) under the API key's credential custody. */
  merge?(actor: Actor, credential: string, input: BaseWireMergeInput): Promise<string>;
  /** Native 222 order split: createOrderSplit222Preview + executeOrderSplit222 (each its own
   * native transaction, replayed by its client key) under the API key's credential custody.
   * Returns the child order UUID. */
  split?(actor: Actor, credential: string, input: BaseWireSplitInput): Promise<string>;
};

const id = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const optionalId = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const unix = z.number().int().min(0).max(253402300799);
// Base documents bool, examples use 0/1 and "0"/"1". Anything else is refused.
const flag = z.union([z.boolean(), z.literal(0), z.literal(1), z.literal('0'), z.literal('1')]).transform(v => v === true || v === 1 || v === '1');
const text = (max: number) => z.string().max(max);
// Optional numeric ID that Base may send as int, digit string or blank.
const looseId = z.union([optionalId, z.literal(''), z.string().regex(/^(0|[1-9][0-9]{0,15})$/).transform(Number)]).transform(v => v === '' ? 0 : v);
const decimal = z.union([z.number(), z.string().regex(/^[0-9]{1,8}(\.[0-9]{1,6})?$/).transform(Number)]);
/** Base float major units → native integer minor units; more than two decimals is refused. */
function minor(value: number) {
  const cents = Math.round(value * 100);
  if (!Number.isFinite(value) || value < 0 || Math.abs(value * 100 - cents) > 1e-6 || cents > 2147483647)
    throw new Problem(422, 'Nieprawidłowa kwota', 'LOCAL_BASE_WIRE_AMOUNT');
  return cents;
}
const productLine = z.object({
  storage: z.literal('db').optional(), storage_id: looseId.optional(),
  product_id: z.union([z.literal(''), z.string().regex(/^[1-9][0-9]{0,15}$/), id]).optional(), variant_id: looseId.optional(),
  name: text(200).optional(), sku: text(200).optional(), ean: text(32).optional(), location: text(200).optional(),
    // LOCAL: price_brutto is required (an omitted price would silently create a free line).
  warehouse_id: looseId.optional(), attributes: text(350).optional(), price_brutto: decimal, tax_rate: decimal.optional(),
  quantity: z.number().int().min(1).max(100000), weight: decimal.optional(),
}).strict();
const addInput = z.object({
  order_status_id: looseId.optional(), custom_source_id: looseId.optional(), date_add: unix.optional(),
  currency: z.string().regex(/^[A-Z]{3}$/).optional(), payment_method: text(30).optional(), payment_method_cod: flag.optional(), paid: flag.optional(),
  user_comments: text(510).optional(), admin_comments: text(2000).optional(), email: text(150).optional(), phone: text(100).optional(),
  user_login: text(30).optional(), delivery_method: text(30).optional(), delivery_price: decimal.optional(),
  delivery_fullname: text(156).optional(), delivery_company: text(156).optional(), delivery_address: text(156).optional(),
  delivery_postcode: text(100).optional(), delivery_city: text(100).optional(), delivery_state: text(35).optional(),
  delivery_country_code: z.union([z.literal(''), z.string().regex(/^[A-Za-z]{2}$/)]).optional(),
  delivery_point_id: text(40).optional(), delivery_point_name: text(100).optional(), delivery_point_address: text(100).optional(),
  delivery_point_postcode: text(100).optional(), delivery_point_city: text(100).optional(),
  invoice_fullname: text(500).optional(), invoice_company: text(500).optional(), invoice_nip: text(100).optional(),
  invoice_address: text(500).optional(), invoice_postcode: text(20).optional(), invoice_city: text(100).optional(),
  invoice_state: text(35).optional(), invoice_country_code: text(2).optional(), want_invoice: flag.optional(),
  extra_field_1: text(50).optional(), extra_field_2: text(50).optional(),
  custom_extra_fields: z.union([z.array(z.never()).max(0), z.record(z.string(), z.never())]).optional(),
  // LOCAL: only an empty custom_extra_fields is accepted (no native mapping).
  // LOCAL ceiling: the native order holds at most 100 lines.
  products: z.array(productLine).min(1).max(100),
}).strict();
// LOCAL: order fields with no native column are refused when non-empty instead
// of being silently dropped (see the parity doc for the exact list).
const unmapped = ['custom_source_id','payment_method','user_comments','user_login','delivery_method','delivery_company','delivery_state',
  'delivery_point_name','delivery_point_address','delivery_point_postcode','delivery_point_city','invoice_fullname','invoice_company',
  'invoice_nip','invoice_address','invoice_postcode','invoice_city','invoice_state','invoice_country_code','want_invoice',
  'extra_field_1','extra_field_2'] as const;
const linesUnmapped = ['location','attributes'] as const;
const statusInput = z.object({ order_id: id, status_id: id }).strict();
const listInput = z.object({}).strict();
const ordersInput = z.object({
  order_id: id.optional(), date_confirmed_from: unix.optional(), date_from: unix.optional(), id_from: id.optional(),
  get_unconfirmed_orders: z.boolean().optional(), status_id: id.optional(), filter_email: text(50).optional(),
  filter_order_source: text(20).optional(), filter_order_source_id: optionalId.optional(), filter_shop_order_id: optionalId.optional(),
  filter_external_order_id: text(50).optional(),
  include_custom_extra_fields: z.boolean().optional(), include_commissions: z.boolean().optional(),
  include_connect_data: z.boolean().optional(), include_discounts_data: z.boolean().optional(),
}).strict()
  .refine(v => v.filter_order_source_id === undefined || v.filter_order_source !== undefined, 'filter_order_source_id wymaga filter_order_source')
  .refine(v => v.filter_external_order_id === undefined || v.filter_shop_order_id === undefined, 'Nie łącz filter_external_order_id z filter_shop_order_id');
// LOCAL: these flags select data without a native source.
const unsupportedFlags = ['include_custom_extra_fields','include_commissions','include_connect_data','include_discounts_data'] as const;
const byEmailInput = z.object({ email: z.string().trim().min(1).max(50) }).strict();
const byPhoneInput = z.object({ phone: z.string().trim().min(1).max(50) }).strict();
// LOCAL: the native order header (buyer, address, delivery, payment mode, currency, note,
// pick/pack state) has no edit operation after creation; only custom_extra_fields maps to a
// native write (order fields). Any other given field is refused, even an empty one (Base
// treats a given empty value as an edit).
const headerFields = ['currency','admin_comments','user_comments','payment_method','payment_method_cod','email','phone','user_login',
  'delivery_method','delivery_price','delivery_fullname','delivery_company','delivery_address','delivery_postcode','delivery_city',
  'delivery_state','delivery_country_code','delivery_point_id','delivery_point_name','delivery_point_address','delivery_point_postcode',
  'delivery_point_city','invoice_fullname','invoice_company','invoice_nip','invoice_address','invoice_postcode','invoice_city',
  'invoice_state','invoice_country_code','want_invoice','extra_field_1','extra_field_2','pick_state','pack_state','star'] as const;
const fieldValue = z.union([z.string().max(16384), z.number(), z.array(z.string().max(120)).max(50), z.object({ title: z.string().max(40), file: z.string() }).strict()]);
const fieldsInput = z.object({
  order_id: id, custom_extra_fields: z.union([z.array(z.never()).max(0), z.record(z.string().regex(/^[1-9][0-9]{0,15}$/), fieldValue)]).optional(),
  ...Object.fromEntries(headerFields.map(f => [f, z.unknown().optional()])),
}).strict();
const paymentInput = z.object({
  order_id: id, payment_done: decimal, payment_date: unix.optional(), payment_comment: text(30).optional(), external_payment_id: z.string().trim().max(30).optional(),
}).strict();
const paymentsInput = z.object({ order_id: id, show_full_history: flag.optional() }).strict();
const mergeInput = z.object({
  main_order_id: id, order_ids_to_merge: z.array(id).min(1).max(99), merge_mode: z.enum(['technical_merge', 'into_main_order']), sum_delivery_costs: flag,
}).strict().refine(v => new Set(v.order_ids_to_merge).size === v.order_ids_to_merge.length && !v.order_ids_to_merge.includes(v.main_order_id),
  'Wybierz unikalne zamówienia; główne nie może wystąpić ponownie');
const splitInput = z.object({
  order_id: id,
  items_to_split: z.array(z.object({ order_product_id: z.union([id, z.string().regex(/^[1-9][0-9]{0,15}$/).transform(Number)]).pipe(id),
    quantity: z.number().int().min(1).max(100000) }).strict()).min(1).max(100),
  // LOCAL: the native shipping cost is gross; delivery_cost_to_split is read as gross.
  delivery_cost_to_split: decimal.optional(),
}).strict().refine(v => new Set(v.items_to_split.map(i => i.order_product_id)).size === v.items_to_split.length,
  'Każda pozycja może wystąpić tylko raz');
/** Net paid contribution of a ledger entry, as paymentBalance (received − refunded). */
const netDelta = (e: BaseWirePaymentEntry) => ['receipt', 'courier_collection'].includes(e.kind) ? e.amount : e.kind === 'refund' ? -e.amount : 0;
const externalId = (e: BaseWirePaymentEntry) =>
  !e.reversal && e.method === 'other' && e.reference.startsWith(BASE_WIRE_PAYMENT_REFERENCE + ' ') ? e.reference.slice(BASE_WIRE_PAYMENT_REFERENCE.length + 1) : '';
/** Deterministic native command key (UUID v4 layout) of one step under a Base Idempotency-Key. */
function stepKey(actor: Actor, clientKey: string, step: string) {
  const h = createHash('sha256').update(['base_wire220', actor.apiKeyId, clientKey, step].join(':')).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${(8 + (parseInt(h[16], 16) & 3)).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
const NATIVE_SOURCES = ['manual','demo','allegro','woocommerce','prestashop','shopify','odoo','ebay','amazon','mirakl','b2b'];
/** LOCAL: own manual/demo orders are Base "personal"; other native source codes pass through. */
const baseSource = (source: string) => ['manual', 'demo'].includes(source) ? 'personal' : source;
const nativeSources = (base: string) => base === 'personal' ? ['manual', 'demo'] : NATIVE_SOURCES.filter(s => s === base && baseSource(s) === s);
const major = (value: number) => Math.round(value) / 100;
const str = (value: unknown) => typeof value === 'string' ? value : '';
const PACKED_STATES = ['packed', 'shipped', 'delivered', 'completed', 'return_initiated', 'return_received', 'return_completed'];

function orderDto(o: BaseWireOrder): Record<string, BaseWireJson> {
  const a = o.address;
  return {
    order_id: o.public_id, shop_order_id: 0, external_order_id: o.external_id ?? '', order_source: baseSource(o.source), order_source_id: 0,
    order_source_info: '', order_status_id: o.status_public_id === null ? baseWireStageStatusId(o.status) : ownStatusId(o.status_public_id), date_add: o.created, date_confirmed: o.created, date_in_status: o.in_status,
    confirmed: true, user_login: '', currency: o.currency, payment_method: '', payment_method_cod: o.payment_mode === 'cod' ? '1' : '0',
    payment_done: major(o.paid), user_comments: '', admin_comments: o.note, email: o.email, phone: str(a.phone),
    delivery_method_id: 0, delivery_method: '', delivery_price: major(o.shipping_cost), delivery_package_module: o.carrier ?? '',
    delivery_package_nr: o.tracking ?? '', delivery_fullname: o.customer_name, delivery_company: '', delivery_address: str(a.street),
    delivery_postcode: str(a.postal_code), delivery_city: str(a.city), delivery_state: '', delivery_country: '', delivery_country_code: str(a.country),
    delivery_point_id: str(a.locker_code), delivery_point_name: '', delivery_point_address: '', delivery_point_postcode: '', delivery_point_city: '',
    invoice_fullname: '', invoice_company: '', invoice_nip: '', invoice_address: '', invoice_postcode: '', invoice_city: '', invoice_state: '',
    invoice_country: '', invoice_country_code: '', want_invoice: '0', extra_field_1: '', extra_field_2: '', order_page: '',
    pick_state: o.picked ? 1 : 0, pack_state: PACKED_STATES.includes(o.status) ? 1 : 0, star: 0, crm_client_id: 0,
    products: o.lines.map(l => ({
      storage: 'db', storage_id: l.catalog_public_id, order_product_id: baseWireOrderProductId(l.item_id),
      product_id: String(l.parent_public_id ?? l.product_public_id), variant_id: l.parent_public_id === null ? '0' : String(l.product_public_id),
      name: l.name, sku: l.sku, ean: l.ean ?? '', location: '', warehouse_id: o.warehouse_public_id, warehouse_type: 'bl', warehouse_source_id: 0,
      auction_id: '', attributes: '', price_brutto: major(l.line_total / l.quantity), tax_rate: l.vat, quantity: l.quantity, weight: 0, bundle_id: 0,
      transaction_id: '', transaction2_id: '',
    })),
  };
}
const empty = (v: unknown) => v === undefined || v === '' || v === 0 || v === false;
function unsupported(): never { throw new Problem(422, 'Pole nie jest obsługiwane lokalnie', 'LOCAL_BASE_WIRE_UNSUPPORTED_FIELD'); }

export function createBaseWireOrdersService(ports: BaseWireOrdersPorts) {
  const tx = <T>(actor: Actor, writing: boolean, work: (n: BaseWireOrdersNative) => Promise<T>) =>
    ports.transaction(actor, writing, c => work(ports.native(c, actor)));
  const hash = (actor: Actor, selected: Method, parameters: Record<string, BaseWireJson>) =>
    createHash('sha256').update(JSON.stringify({ api_key_id: actor.apiKeyId, method: selected, parameters })).digest('hex');
  function writer(actor: Actor, options: { clientKey?: string }) {
    ensure(actor.source === 'api' && !!actor.apiKeyId, 503, 'Brak klucza API');
    // Same role gate as POST /api/orders and the native order operations.
    ensure(actor.role === 'admin' || actor.role === 'operator', 403, 'Konto ma uprawnienia tylko do odczytu');
    return options.clientKey === undefined ? undefined : z.uuid().parse(options.clientKey);
  }
  /** Own workflow status or fixed stage status for a numeric status ID (404 otherwise). */
  async function status(n: BaseWireOrdersNative, publicId: number): Promise<{ workflow?: BaseWireOrderStatus; stage?: string }> {
    const stage = BASE_WIRE_STAGE_STATUSES.find(s => s.id === publicId);
    if (stage) return { stage: stage.stage };
    const workflow = (await n.statuses()).find(s => ownStatusId(s.public_id) === publicId);
    ensure(workflow, 404, 'Nie znaleziono własnego statusu');
    return { workflow };
  }
  async function apply(n: BaseWireOrdersNative, orderId: string, target: { workflow?: BaseWireOrderStatus; stage?: string }) {
    if (target.workflow) return n.setStatus(orderId, target.workflow.id);
    // LOCAL: no native operation drops a workflow status without a stage change.
    if ((await n.setStage(orderId, target.stage!)).kept_workflow)
      throw new Problem(409, 'Zamówienie ma już ten etap z własnym statusem', 'LOCAL_BASE_WIRE_STAGE_STATUS');
  }
  async function add(actor: Actor, parameters: Record<string, BaseWireJson>, options: { clientKey?: string }) {
    const b = addInput.parse(parameters);
    for (const field of unmapped) if (!empty(b[field])) unsupported();
    for (const line of b.products) for (const field of linesUnmapped) if (!empty(line[field])) unsupported();
    const clientKey = writer(actor, options), requestHash = hash(actor, 'addOrder', parameters);
    const lines = b.products.map(l => ({ ...l, line_total: minor(l.price_brutto) * l.quantity,
      product: l.product_id === undefined || l.product_id === '' ? 0 : Number(l.product_id), variant: l.variant_id ?? 0 }));
    for (const l of lines) ensure(Number.isSafeInteger(l.line_total) && l.line_total <= 2147483647, 422, 'Wartość pozycji przekracza limit');
    const shipping = minor(b.delivery_price ?? 0);
    return tx(actor, true, async n => {
      if (clientKey) { const retained = await n.replay(clientKey, requestHash); if (retained) return retained; }
      const target = b.order_status_id ? await status(n, b.order_status_id) : undefined;
      const warehouses = await n.warehouses();
      const chosen = [...new Set(lines.map(l => l.warehouse_id ?? 0).filter(w => w !== 0))];
      ensure(chosen.length <= 1, 422, 'Pozycje jednego zamówienia muszą wskazywać ten sam magazyn');
      // LOCAL: no per-source default warehouse exists; without warehouse_id only a single-warehouse company is unambiguous.
      const warehouse = chosen.length ? warehouses.find(w => w.public_id === chosen[0]) : warehouses.length === 1 ? warehouses[0] : undefined;
      ensure(warehouse || !chosen.length, 404, 'Nie znaleziono własnego magazynu Base');
      ensure(warehouse, 422, 'Wskaż warehouse_id pozycji');
      const found = await n.products({ public_ids: [...new Set(lines.flatMap(l => [l.product, l.variant]).filter(x => x > 0))],
        skus: [...new Set(lines.filter(l => !l.product && l.sku).map(l => l.sku!))], eans: [...new Set(lines.filter(l => !l.product && !l.sku && l.ean).map(l => l.ean!))] });
      const items = new Map<string, number>(), manual: BaseWireNativeOrderInput['manual_lines'] = [];
      for (const l of lines) {
        let p: BaseWireOrderProduct|undefined;
        if (l.variant) {
          p = found.find(x => x.public_id === l.variant);
          ensure(p && p.kind === 'variant' && (!l.product || p.parent_public_id === l.product), 404, 'Nie znaleziono wariantu produktu');
        } else if (l.product) p = found.find(x => x.public_id === l.product);
        else if (l.sku) p = found.find(x => x.sku === l.sku);
        else if (l.ean) { const m = found.filter(x => x.ean === l.ean); ensure(m.length <= 1, 422, 'EAN wskazuje więcej niż jeden produkt'); p = m[0]; }
        // LOCAL: a native order line always references a catalog product; free-text lines are refused.
        ensure(p, 404, 'Nie znaleziono produktu');
        ensure(!l.sku || l.sku === p.sku, 422, 'SKU nie odpowiada produktowi');
        ensure(!l.ean || !(l.product || l.variant) || l.ean === (p.ean ?? ''), 422, 'EAN nie odpowiada produktowi');
        ensure(l.tax_rate === undefined || l.tax_rate === p.vat, 422, 'Stawka VAT nie odpowiada produktowi');
        ensure(!l.storage_id || l.storage_id === p.catalog_public_id, 404, 'Produkt nie należy do wskazanego katalogu');
        items.set(p.id, (items.get(p.id) ?? 0) + l.quantity);
        manual.push({ product_id: p.id, quantity: l.quantity, line_total: l.line_total });
      }
      const local = await n.create({
        customer_name: (b.delivery_fullname ?? '').trim(), email: b.email ?? '', warehouse_id: warehouse.id, source: 'manual',
        currency: b.currency ?? 'PLN', payment_mode: b.payment_method_cod ? 'cod' : 'prepaid',
        address: { street: b.delivery_address ?? '', city: b.delivery_city ?? '', postal_code: b.delivery_postcode ?? '',
          country: (b.delivery_country_code || 'PL').toUpperCase(), phone: b.phone ?? '', ...(b.delivery_point_id ? { locker_code: b.delivery_point_id } : {}) },
        shipping_cost: shipping, items: [...items].map(([product_id, quantity]) => ({ product_id, quantity })), manual_lines: manual,
        note: b.admin_comments ?? '',
      });
      if (b.paid) await n.payInFull(local);
      if (target) await apply(n, local, target);
      await n.allocate();
      const response = { order_id: await n.publicId(local) };
      if (clientKey) await n.remember(clientKey, response);
      return response;
    });
  }
  async function setStatus(actor: Actor, parameters: Record<string, BaseWireJson>, options: { clientKey?: string }) {
    const b = statusInput.parse(parameters);
    const clientKey = writer(actor, options), requestHash = hash(actor, 'setOrderStatus', parameters);
    return tx(actor, true, async n => {
      if (clientKey) { const retained = await n.replay(clientKey, requestHash); if (retained) return retained; }
      const order = await n.order(b.order_id);
      ensure(order, 404, 'Nie znaleziono zamówienia');
      await apply(n, order, await status(n, b.status_id));
      const response = {};
      if (clientKey) await n.remember(clientKey, response);
      return response;
    });
  }
  /** Replay inside the effect's transaction; the response is stored before COMMIT. */
  function once(actor: Actor, selected: Method, parameters: Record<string, BaseWireJson>, clientKey: string|undefined,
    work: (n: BaseWireOrdersNative) => Promise<Record<string, BaseWireJson>>) {
    const requestHash = hash(actor, selected, parameters);
    return tx(actor, true, async n => {
      if (clientKey) { const retained = await n.replay(clientKey, requestHash); if (retained) return retained; }
      const response = await work(n);
      if (clientKey) await n.remember(clientKey, response);
      return response;
    });
  }
  async function own(n: BaseWireOrdersNative, publicId: number) {
    const order = await n.order(publicId);
    ensure(order, 404, 'Nie znaleziono zamówienia');
    return order;
  }
  async function lookup(actor: Actor, filter: { email?: string; phone?: string }) {
    if (ports.allocateOnRead) await tx(actor, true, n => n.allocate());
    // LOCAL: exact match (e-mail case-insensitive, phone as stored); newest 100 first.
    return tx(actor, false, async n => ({ orders: (await n.orders({ ...filter, descending: true, limit: BASE_WIRE_ORDERS_PAGE }))
      .slice(0, BASE_WIRE_ORDERS_PAGE).map(o => ({
        order_id: o.public_id, order_status_id: o.status_public_id === null ? baseWireStageStatusId(o.status) : ownStatusId(o.status_public_id),
        ...(filter.phone !== undefined ? { delivery_fullname: o.customer_name, delivery_company: '' } : {}),
        date_in_status: o.in_status, date_add: o.created,
      })) }));
  }
  /** Definitions with their derived Base IDs; a derived-ID collision fails closed. */
  async function extraFields(n: BaseWireOrdersNative) {
    const fields = (await n.extraFields()).map(f => ({ ...f, public_id: baseWireExtraFieldId(f.id) }));
    if (new Set(fields.map(f => f.public_id)).size !== fields.length) local503();
    return fields;
  }
  function local503(): never { throw new Problem(503, 'Kolizja identyfikatora pola Base', 'LOCAL_BASE_WIRE_EXTRA_FIELD_ID'); }
  async function getExtraFields(actor: Actor, parameters: Record<string, BaseWireJson>) {
    listInput.parse(parameters);
    // LOCAL: enabled definitions readable by the member, in the native display order. Same
    // transaction kind as GET /api/order-fields (order_field_role pins the membership row).
    return tx(actor, true, async n => ({ extra_fields: (await extraFields(n)).filter(f => f.enabled).map(f => ({
      extra_field_id: f.public_id, name: f.label, editor_type: EDITOR_TYPES[f.type] ?? local503(),
      ...(['select', 'radio', 'multi_select'].includes(f.type) ? { options: f.options.filter(o => o.enabled).map(o => o.label) } : {}),
    })) }));
  }
  async function setFields(actor: Actor, parameters: Record<string, BaseWireJson>, options: { clientKey?: string }) {
    const b = fieldsInput.parse(parameters) as z.infer<typeof fieldsInput> & Record<string, unknown>;
    for (const field of headerFields) if (b[field] !== undefined) unsupported();
    const values = Array.isArray(b.custom_extra_fields) ? [] : Object.entries(b.custom_extra_fields ?? {});
    // Native ceiling: 20 changes per PATCH /api/orders/:id/fields.
    ensure(values.length <= 20, 422, 'Najwyżej 20 pól w jednym wywołaniu');
    const clientKey = writer(actor, options);
    return once(actor, 'setOrderFields', parameters, clientKey, async n => {
      const order = await own(n, b.order_id);
      if (!values.length) return {};
      const fields = await extraFields(n);
      const changes = values.map(([key, value]): BaseWireFieldChange => {
        const f = fields.find(x => x.public_id === Number(key));
        ensure(f, 404, 'Nie znaleziono pola');
        const head = { field_id: f.id, definition_version: f.version };
        // Base: an empty string removes the value.
        if (value === '') return { ...head, operation: 'clear' };
        // LOCAL: a Base file value is not uploaded from connector.php (native stored-file command).
        if (typeof value === 'object' && !Array.isArray(value)) unsupported();
        const option = (label: unknown) => {
          const o = f.options.find(x => x.enabled && x.label === label);
          ensure(o, 422, 'Opcja nie istnieje lub jest wycofana');
          return o.id;
        };
        if (f.type === 'select' || f.type === 'radio') return { ...head, type: f.type, value: option(value) };
        if (f.type === 'multi_select') { ensure(Array.isArray(value), 422, 'Pole wielokrotnego wyboru wymaga listy opcji'); return { ...head, type: f.type, value: value.map(option) }; }
        if (f.type === 'number' && typeof value === 'number') return { ...head, type: f.type, value: String(value) };
        ensure(typeof value === 'string' && f.type !== 'file', 422, 'Nieprawidłowa wartość pola');
        return { ...head, type: f.type, value };
      });
      await n.patchFields(order, changes);
      return {};
    });
  }
  async function setPayment(actor: Actor, parameters: Record<string, BaseWireJson>, options: { clientKey?: string }) {
    const b = paymentInput.parse(parameters);
    const total = minor(b.payment_done), clientKey = writer(actor, options);
    return once(actor, 'setOrderPayment', parameters, clientKey, async n => {
      const order = await own(n, b.order_id);
      // Base: payment_done is the new TOTAL paid. The order is locked before the balance
      // is read, so the delta is recorded exactly once; the same total again records nothing.
      const state = await n.paymentState(order), delta = total - state.net;
      // LOCAL: a lower total has no native mapping (corrections reverse one entry, admin only).
      if (delta < 0) throw new Problem(422, 'Nie można obniżyć kwoty wpłaconej; skoryguj wpis w panelu', 'LOCAL_BASE_WIRE_PAYMENT_DECREASE');
      if (delta > 0) await n.receipt(order, { amount: delta, currency: state.currency, version: state.version,
        reference: b.external_payment_id ? BASE_WIRE_PAYMENT_REFERENCE + ' ' + b.external_payment_id : BASE_WIRE_PAYMENT_REFERENCE,
        note: b.payment_comment ?? '' });
      return {};
    });
  }
  async function paymentsHistory(actor: Actor, parameters: Record<string, BaseWireJson>) {
    const b = paymentsInput.parse(parameters);
    return tx(actor, false, async n => {
      const ledger = await n.payments(await own(n, b.order_id));
      let paid = 0;
      const payments: Record<string, BaseWireJson>[] = [];
      for (const e of ledger.entries) {
        const delta = netDelta(e), external = externalId(e);
        // LOCAL: only entries that change the amount paid; courier remittances do not.
        if (delta === 0) continue;
        const before = paid; paid += delta;
        if (b.show_full_history || external) payments.push({ paid_before: major(before), paid_after: major(paid), total_price: major(ledger.total),
          currency: ledger.currency, external_payment_id: external, date: e.created, comment: e.note });
      }
      return { payments };
    });
  }
  async function merge(actor: Actor, parameters: Record<string, BaseWireJson>, options: { clientKey?: string; credential?: string }) {
    const b = mergeInput.parse(parameters);
    const clientKey = writer(actor, options);
    ensure(ports.merge && typeof options.credential === 'string', 503, 'Brak natywnej kustodii klucza API');
    const ids = await tx(actor, false, async n => {
      const out: string[] = [];
      for (const publicId of [b.main_order_id, ...b.order_ids_to_merge]) out.push(await own(n, publicId));
      return out;
    });
    // Native preview + execute, each committed with its own command key. Under an
    // Idempotency-Key both keys are derived from it, so a retry replays both natively.
    const key = (step: string) => clientKey ? stepKey(actor, clientKey, 'setOrdersMerge:' + step) : randomUUID();
    const target = await ports.merge(actor, options.credential, { preview_key: key('preview'), execute_key: key('execute'),
      main_order_id: ids[0], order_ids: ids.slice(1), merge_mode: b.merge_mode, sum_delivery_costs: b.sum_delivery_costs });
    // A technical merge creates a native order: its numeric ID is allocated now (idempotent).
    return tx(actor, true, async n => { await n.allocate(); return { merged_order_id: await n.publicId(target) }; });
  }
  async function split(actor: Actor, parameters: Record<string, BaseWireJson>, options: { clientKey?: string; credential?: string }) {
    const b = splitInput.parse(parameters);
    const clientKey = writer(actor, options), shipping = minor(b.delivery_cost_to_split ?? 0);
    ensure(ports.split && typeof options.credential === 'string', 503, 'Brak natywnej kustodii klucza API');
    const order = await tx(actor, false, n => own(n, b.order_id));
    // Native preview + execute, each committed with its own command key (derived from the
    // Idempotency-Key when given), so a retry replays both natively and returns the same child.
    const key = (step: string) => clientKey ? stepKey(actor, clientKey, 'addOrderBySplit:' + step) : randomUUID();
    const child = await ports.split(actor, options.credential, { preview_key: key('preview'), execute_key: key('execute'), order_id: order,
      items: b.items_to_split, shipping_cost_to_child: shipping });
    return tx(actor, true, async n => { await n.allocate(); return { new_order_id: await n.publicId(child) }; });
  }
  async function orders(actor: Actor, parameters: Record<string, BaseWireJson>) {
    const b = ordersInput.parse(parameters);
    for (const flag of unsupportedFlags) if (b[flag] === true) throw new Problem(422, 'Flaga nie jest obsługiwana lokalnie', 'LOCAL_BASE_WIRE_UNSUPPORTED_FLAG');
    // Natively created orders get their numeric ID here, in creation order, before the read snapshot.
    if (ports.allocateOnRead) await tx(actor, true, n => n.allocate());
    // LOCAL: shop_order_id and order_source_id are always 0, so a non-zero filter matches nothing.
    const none = !!b.filter_shop_order_id || !!b.filter_order_source_id;
    const sources = b.filter_order_source === undefined ? undefined : nativeSources(b.filter_order_source);
    if (none || sources?.length === 0) return { orders: [] };
    const stage = BASE_WIRE_STAGE_STATUSES.find(s => s.id === b.status_id)?.stage;
    return tx(actor, false, async n => ({ orders: (await n.orders({
      public_id: b.order_id, date_from: b.date_from, confirmed_from: b.date_confirmed_from, id_from: b.id_from,
      ...(stage ? { stage } : { status_public_id: b.status_id }),
      email: b.filter_email, sources, external_id: b.filter_external_order_id, limit: BASE_WIRE_ORDERS_PAGE,
    })).slice(0, BASE_WIRE_ORDERS_PAGE).map(orderDto) }));
  }
  return {
    async execute(actor: Actor, selected: string, parameters: Record<string, BaseWireJson>, options: { clientKey?: string; credential?: string } = {}): Promise<Record<string, BaseWireJson>> {
      method(selected);
      if (selected === 'addOrder') return add(actor, parameters, options);
      if (selected === 'setOrderStatus') return setStatus(actor, parameters, options);
      if (selected === 'getOrders') return orders(actor, parameters);
      if (selected === 'getOrdersByEmail') return lookup(actor, { email: byEmailInput.parse(parameters).email });
      if (selected === 'getOrdersByPhone') return lookup(actor, { phone: byPhoneInput.parse(parameters).phone });
      if (selected === 'getOrderExtraFields') return getExtraFields(actor, parameters);
      if (selected === 'setOrderFields') return setFields(actor, parameters, options);
      if (selected === 'setOrderPayment') return setPayment(actor, parameters, options);
      if (selected === 'getOrderPaymentsHistory') return paymentsHistory(actor, parameters);
      if (selected === 'setOrdersMerge') return merge(actor, parameters, options);
      if (selected === 'addOrderBySplit') return split(actor, parameters, options);
      listInput.parse(parameters);
      // LOCAL: no status groups or primary status natively; name_for_customer = name.
      // Own workflow statuses first, then the fixed native stages (reserved IDs).
      return tx(actor, false, async n => ({ statuses: [
        ...(await n.statuses()).map(s => ({ id: ownStatusId(s.public_id), name: s.name, color: s.color })),
        ...BASE_WIRE_STAGE_STATUSES.map(s => ({ id: s.id, name: s.name, color: STAGE_COLOR })),
      ].map(s => ({ ...s, group_id: 0, is_primary: 0, name_for_customer: s.name })) }));
    },
  };
}
export type BaseWireOrdersService = ReturnType<typeof createBaseWireOrdersService>;

/** Third connector.php family. Only startup capability selects availability. */
export function createBaseWireOrdersFamily(opts: { service: Pick<BaseWireOrdersService, 'execute'>; available: boolean }): BaseWireFamily {
  // Credential custody: the native order merge re-verifies the API key (buyer-address identity);
  // the native split re-verifies the presented key's hash inside each split transaction.
  return Object.freeze({ label: 'zamówień', methods: BASE_WIRE_ORDERS_METHODS, scope: baseWireOrdersScope, isWrite: isBaseWireOrdersWrite,
    available: opts.available === true, nativeCredentialCustody: true, service: opts.service });
}
