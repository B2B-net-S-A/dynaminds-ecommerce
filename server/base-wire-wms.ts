/** Base "WMS" family on connector.php: inventory documents (PZ/WZ/MM), purchase orders,
 * suppliers and stocktake reads over the native warehouse/purchasing/stocktake modules
 * with the 220 warehouse/product/catalog IDs.
 * Sources: base-api-document-contracts.v1.json (Documents), base-api-purchase-order-contracts.v1.json,
 * base-api-inventory-other-configuration-contracts-20261018.md (Suppliers), base-api-stocktake-contracts.v1.json.
 * Field mapping, skipped methods and every local choice: docs/parity/BASE-WIRE-WMS-20261023.md.
 * No database/runtime import: the native port is supplied at startup.
 */
import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { Actor } from './domain';
import { Problem, ensure } from './errors';
import type { BaseWireJson } from './base-wire-codec';
import type { BaseWireFamily } from './base-wire-routes';

export const BASE_WIRE_WMS_METHODS = ['getInventoryDocuments','getInventoryDocumentItems','addInventoryDocument','addInventoryDocumentItems',
  'setInventoryDocumentStatusConfirmed','getInventoryPurchaseOrders','getInventoryPurchaseOrderItems','addInventoryPurchaseOrder',
  'addInventoryPurchaseOrderItems','setInventoryPurchaseOrderStatus','getInventorySuppliers','addInventorySupplier',
  'getInventoryStocktakes','getInventoryStocktakeItems'] as const;
type Method = typeof BASE_WIRE_WMS_METHODS[number];
function method(value: string): asserts value is Method {
  ensure(BASE_WIRE_WMS_METHODS.includes(value as Method), 400, 'Nieznana metoda Base WMS');
}
const WRITES: readonly string[] = ['addInventoryDocument','addInventoryDocumentItems','setInventoryDocumentStatusConfirmed',
  'addInventoryPurchaseOrder','addInventoryPurchaseOrderItems','setInventoryPurchaseOrderStatus','addInventorySupplier'];
const PURCHASING: readonly string[] = ['getInventoryPurchaseOrders','getInventoryPurchaseOrderItems','addInventoryPurchaseOrder',
  'addInventoryPurchaseOrderItems','setInventoryPurchaseOrderStatus','getInventorySuppliers','addInventorySupplier'];
export function isBaseWireWmsWrite(value: string) { method(value); return WRITES.includes(value); }
/** Same scopes as the native REST routes: documents/stocktakes inventory:*, purchase orders/suppliers
 * purchasing:*. Every write also requires the read scope (baseWireRequiredScopes). */
export function baseWireWmsScope(value: string) {
  const write = isBaseWireWmsWrite(value);
  return PURCHASING.includes(value) ? (write ? 'purchasing:write' as const : 'purchasing:read' as const)
    : (write ? 'inventory:write' as const : 'inventory:read' as const);
}
/** Base page size of every paged method (contract: 100 per page, pages from 1). */
export const BASE_WIRE_WMS_PAGE = 100;
/** LOCAL ceiling of the unpaged getInventorySuppliers (more matches → 422, never a silent cut). */
export const BASE_WIRE_WMS_SUPPLIERS_LIMIT = 1000;

/** LOCAL (no migration): warehouse documents, purchase orders, suppliers and stocktakes (and
 * stocktake lines) have no 220 sidecar. The Base ID is derived from the immutable native UUID
 * exactly like pick_list_id/return_id: hex digits 1–12 and 14 (the 52 random bits of a v4 UUID)
 * + 1, i.e. 1..2^52. A collision inside the same company and kind fails the call (503). */
export function baseWireWmsKey(uuid: string) {
  const hex = z.uuid().parse(uuid).replace(/-/g, '');
  return hex.slice(0, 12) + hex.slice(13, 14);
}
export function baseWireWmsId(uuid: string) { return parseInt(baseWireWmsKey(uuid), 16) + 1; }

/** Base document_type ↔ native warehouse_documents.kind. 1 IGR, 3 IGI, 5 OB and the native count
 * (INW) have no counterpart. */
export const BASE_WIRE_DOCUMENT_TYPES = Object.freeze({ receipt: 0, issue: 2, transfer: 4 } as const);
export type BaseWireWmsKind = keyof typeof BASE_WIRE_DOCUMENT_TYPES;
const kindOf = (type: number) => (Object.entries(BASE_WIRE_DOCUMENT_TYPES).find(([, t]) => t === type)?.[0]) as BaseWireWmsKind|undefined;
/** Native purchase_orders.state → Base status (0 draft, 1 sent, 3 completed, 4 completed partially, 5 canceled). */
export const BASE_WIRE_PURCHASE_STATUS: Readonly<Record<string, number>> = Object.freeze({ draft: 0, ordered: 1, partial: 4, received: 3, closed: 3, cancelled: 5 });
/** Native stocktakes.state → Base stocktake_status (2 in progress, 4 counted, 3 completed, 5 rejected). */
export const BASE_WIRE_STOCKTAKE_STATUS: Readonly<Record<string, number>> = Object.freeze({ counting: 2, review: 4, posted: 3, cancelled: 5 });
/** LOCAL reasons of native close/cancel made through setInventoryPurchaseOrderStatus. */
export const BASE_WIRE_PURCHASE_CANCEL_REASON = 'Anulowane przez Base API';
export const BASE_WIRE_PURCHASE_CLOSE_REASON = 'Zakończone przez Base API';

export type BaseWireWmsEntity = 'document'|'purchase'|'supplier'|'stocktake';
export type BaseWireWmsDocument = { id: string; kind: BaseWireWmsKind; status: 'draft'|'posted'|'cancelled'; number: string; created: number; posted: number;
  warehouse_public_id: number; destination_public_id: number|null; note: string; items: number; quantity: number; purchase_id: string|null;
  /** Sum of line quantity × purchase order unit cost (minor units) of a PZ of a purchase receipt; null = no native cost. */
  cost: number|null };
export type BaseWireWmsDocumentHead = { id: string; kind: BaseWireWmsKind; status: string; version: number; warehouse_id: string; destination_id: string|null;
  reference: string; note: string; lines:{ product_id: string; quantity: number; location: string }[] };
/** One native line per product: `item_id` is the line's 220 product ID (LOCAL). */
export type BaseWireWmsLine = { product_id: string; product_public_id: number; catalog_public_id: number; name: string; sku: string; ean: string|null; quantity: number };
/** `unit_cost`: the purchase order line's unit cost (minor units) of a PZ of a purchase receipt; null = no native cost. */
export type BaseWireWmsDocumentLine = BaseWireWmsLine & { location: string; unit_cost: number|null };
export type BaseWireWmsPurchaseLine = BaseWireWmsLine & { received: number; closed: number; unit_cost: number; supplier_sku: string; locations: string[] };
export type BaseWireWmsPurchase = { id: string; state: string; number: string; reference: string; note: string; currency: string; created: number; sent: number;
  received: number; completed: number; expected: number; warehouse_public_id: number; supplier_id: string; quantity: number; received_quantity: number;
  cost: number; received_cost: number; items: number; received_items: number };
export type BaseWireWmsPurchaseHead = { id: string; state: string; version: number; supplier_id: string; warehouse_id: string; currency: string; reference: string;
  note: string; expected_date: string|null; lines: BaseWireWmsPurchaseLine[] };
export type BaseWireWmsSupplier = { id: string; name: string; code: string; contact_name: string; email: string; phone: string; address: string; tax_id: string;
  country: string; active: boolean; version: number };
export type BaseWireWmsStocktake = { id: string; name: string; state: string; warehouse_public_id: number; blind: boolean; created: number; posted: number;
  items: number; counted_items: number; quantity: number; counted_quantity: number; compliant: number; not_compliant: number; missing: number };
export type BaseWireWmsStocktakeLine = BaseWireWmsLine & { id: string; location: string; counted: number|null };
type Page = { offset: number; limit: number };
export type BaseWireWmsDocumentsFilter = Page & { ids?: string[]; kinds: BaseWireWmsKind[]; status?: 'draft'|'posted'; warehouse_id?: string;
  date_from?: number; date_to?: number; purchase_ids?: string[]; sourced?: boolean };
export type BaseWireWmsPurchasesFilter = Page & { warehouse_id?: string; supplier_ids?: string[]; date_from?: number; date_to?: number; number?: string; product_id?: string };
export type BaseWireWmsStocktakesFilter = Page & { ids?: string[]; warehouse_id?: string; state?: string; date_from?: number; date_to?: number };
export type BaseWireWmsSupplierInput = Omit<BaseWireWmsSupplier, 'id'|'version'>;
export type BaseWireWmsPurchaseInput = { supplier_id: string; warehouse_id: string; currency: string; reference: string; note: string; expected_date: string|null;
  lines: { product_id: string; quantity: number; unit_cost: number; supplier_sku: string }[] };

/** One native port per transaction; every lookup is the current tenant only. */
export type BaseWireWmsNative = {
  /** Own warehouses with their 220 IDs. */
  warehouses(): Promise<{ id: string; public_id: number }[]>;
  /** Own live products for the given 220 product IDs (missing ones are absent). */
  products(publicIds: number[]): Promise<{ id: string; public_id: number }[]>;
  /** Own native UUIDs whose derived ID equals the given one (normally 0 or 1); documents: PZ/WZ/MM only. */
  find(entity: BaseWireWmsEntity, publicId: number): Promise<string[]>;
  /** Another row of the same company and entity maps to the same derived ID. */
  taken(entity: BaseWireWmsEntity, id: string, key: string): Promise<boolean>;
  documents(filter: BaseWireWmsDocumentsFilter): Promise<BaseWireWmsDocument[]>;
  document(id: string): Promise<BaseWireWmsDocumentHead>;
  documentLines(id: string): Promise<BaseWireWmsDocumentLine[]>;
  /** The authenticated key also holds purchasing:read (the scope of the native purchase costs). */
  costReadable(): Promise<boolean>;
  /** Native createWarehouseDocument with an empty line list (the Base draft starts empty). */
  createDocument(input: { kind: BaseWireWmsKind; warehouse_id: string; destination_id: string|null; reference: string; note: string }): Promise<{ id: string; number: string }>;
  /** Native editWarehouseDocument with the complete new line list. */
  editDocument(head: BaseWireWmsDocumentHead, lines: { product_id: string; quantity: number; location: string }[]): Promise<void>;
  /** Native postWarehouseDocument (stock effect). */
  postDocument(id: string, version: number): Promise<void>;
  purchases(filter: BaseWireWmsPurchasesFilter): Promise<BaseWireWmsPurchase[]>;
  purchase(id: string): Promise<BaseWireWmsPurchaseHead>;
  /** Native purchaseSave (create without id, full replace of a draft with id). */
  savePurchase(input: BaseWireWmsPurchaseInput, id?: string, version?: number): Promise<{ id: string; number: string }>;
  /** Native purchaseAction. */
  actPurchase(id: string, action: 'place'|'close'|'cancel', input: { version: number; reason?: string }): Promise<void>;
  /** Native purchaseReceipt (PZ posted in the same transaction). */
  receivePurchase(id: string, input: { version: number; lines: { product_id: string; quantity: number }[] }): Promise<void>;
  suppliers(filter: { ids?: string[]; name?: string; limit: number }): Promise<BaseWireWmsSupplier[]>;
  /** Native supplierSave. */
  saveSupplier(input: BaseWireWmsSupplierInput, id?: string, version?: number): Promise<string>;
  stocktakes(filter: BaseWireWmsStocktakesFilter): Promise<BaseWireWmsStocktake[]>;
  stocktakeLines(id: string): Promise<BaseWireWmsStocktakeLine[]>;
  replay(clientKey: string, requestHash: string): Promise<Record<string, BaseWireJson>|null>;
  remember(clientKey: string, response: Record<string, BaseWireJson>): Promise<void>;
};
export type BaseWireWmsPorts = {
  /** `purchasing` selects the native purchasing source admission (same as the native PO routes). */
  transaction<T>(actor: Actor, writing: boolean, purchasing: boolean, work: (c: PoolClient) => Promise<T>): Promise<T>;
  native(c: PoolClient, actor: Actor): BaseWireWmsNative;
  /** LOCAL code of a supplier created through Base (native code is required and unique). */
  supplierCode(): string;
};

const max = Number.MAX_SAFE_INTEGER;
const looseNumber = (min: number, top: number) => z.union([z.number().int().min(min).max(top), z.string().regex(/^(0|[1-9][0-9]{0,15})$/).transform(Number).pipe(z.number().int().min(min).max(top))]);
const id = looseNumber(1, max);
const optionalId = looseNumber(0, max);
const unix = looseNumber(0, 253402300799);
const page = looseNumber(1, 100000);
const text = (n: number) => z.string().max(n);
const decimal = z.union([z.number(), z.string().regex(/^[0-9]{1,8}(\.[0-9]{1,6})?$/).transform(Number)]);
/** Base float major units → native integer minor units; more than two decimals is refused. */
function minor(value: number) {
  const cents = Math.round(value * 100);
  if (!Number.isFinite(value) || value < 0 || Math.abs(value * 100 - cents) > 1e-6 || cents > 1000000000)
    throw new Problem(422, 'Nieprawidłowa kwota', 'LOCAL_BASE_WIRE_AMOUNT');
  return cents;
}
const major = (value: number) => Math.round(value) / 100;
const local = (status: number, message: string, code: string): never => { throw new Problem(status, message, code); };
const unsupported = () => local(422, 'Pole nie jest obsługiwane lokalnie', 'LOCAL_BASE_WIRE_UNSUPPORTED_FIELD');
const empty = (v: unknown) => v === undefined || v === '' || v === 0 || (Array.isArray(v) && v.length === 0);
function refuseUnmapped<T extends Record<string, unknown>>(value: T, fields: readonly (keyof T)[]) { for (const f of fields) if (!empty(value[f])) unsupported(); }
const offset = (p: number|undefined) => ({ offset: ((p ?? 1) - 1) * BASE_WIRE_WMS_PAGE, limit: BASE_WIRE_WMS_PAGE });
/** UTC calendar date of a Base unix timestamp (native expected_date is a date). */
const isoDate = (seconds: number) => new Date(seconds * 1000).toISOString().slice(0, 10);

const documentsInput = z.object({
  filter_source_object_type: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(7), z.literal(8),
    z.string().regex(/^[1-8]$/).transform(Number).pipe(z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(7), z.literal(8)]))]).optional(),
  filter_source_object_id: optionalId.optional(), filter_document_id: optionalId.optional(), filter_document_type: looseNumber(0, 5).optional(),
  filter_document_status: looseNumber(0, 1).optional(), filter_date_from: unix.optional(), filter_date_to: unix.optional(),
  filter_warehouse_id: optionalId.optional(), page: page.optional(),
}).strict();
const itemsPageInput = (key: string) => z.object({ [key]: id, page: page.optional() }).strict();
const documentInput = z.object({
  warehouse_id: id, document_type: looseNumber(0, 5), target_warehouse_id: optionalId.optional(), date_add: unix.optional(), date_execute: unix.optional(),
  contractor: text(500).optional(), invoice_no: text(50).optional(), notes: text(500).optional(),
}).strict();
const documentItem = z.object({
  product_id: id, quantity: z.number().int().min(1).max(1000000), price: decimal.optional(), location_name: text(255).optional(),
  target_location_name: text(255).optional(), expiry_date: text(10).optional(), batch: text(128).optional(), serial_no: text(128).optional(), comments: text(255).optional(),
}).strict();
const documentItemsInput = z.object({ document_id: id, items: z.array(documentItem).min(1).max(200) }).strict();
const confirmInput = z.object({ document_id: id }).strict();
const purchasesInput = z.object({
  warehouse_id: optionalId.optional(), supplier_id: optionalId.optional(), series_id: optionalId.optional(), date_from: unix.optional(), date_to: unix.optional(),
  filter_document_number: text(50).optional(), filter_product_id: optionalId.optional(), page: page.optional(),
}).strict();
const purchaseInput = z.object({
  warehouse_id: id, supplier_id: id, payer_id: optionalId.optional(), currency: z.string().regex(/^[A-Z]{3}$/), name: text(80).optional(), notes: z.string().optional(),
  invoice_no: text(50).optional(), date_cost_invoice_issue: unix.optional(), date_delivery_expected: unix.optional(),
  additional_costs: z.array(z.object({ name: text(30), cost: decimal }).strict()).max(100).optional(),
  packages: z.array(z.object({ courier_code: text(20), courier_other_name: text(20).optional(), package_number: text(40) }).strict()).max(100).optional(),
}).strict();
const purchaseItem = z.object({
  product_id: id, quantity: z.number().int().min(1).max(1000000), item_cost: decimal.optional(), supplier_code: text(50).optional(), location: text(255).optional(),
  batch: text(128).optional(), expiry_date: text(10).optional(), serial_no: text(128).optional(), comments: text(255).optional(),
}).strict();
const purchaseItemsInput = z.object({ order_id: id, items: z.array(purchaseItem).min(1).max(200) }).strict();
const purchaseStatusInput = z.object({
  order_id: id, status: looseNumber(0, 6),
  completed_items: z.array(z.object({ item_id: id, completed_quantity: z.number().int().min(0).max(1000000) }).strict()).max(200).optional(),
}).strict();
const suppliersInput = z.object({ filter_id: optionalId.optional(), filter_name: text(40).optional() }).strict();
const supplierInput = z.object({
  supplier_id: optionalId.optional(), name: text(40).optional(), take_product_cost_from: text(20).optional(), take_product_code_from: text(20).optional(),
  address: text(200).optional(), postcode: text(20).optional(), city: text(80).optional(), phone: text(40).optional(), email: text(200).optional(),
  email_copy_to: text(200).optional(), currency: z.union([z.literal(''), z.string().regex(/^[A-Z]{3}$/)]).optional(), tax_no: text(16).optional(),
}).strict();
const stocktakesInput = z.object({
  filter_stocktake_id: optionalId.optional(), filter_warehouse_id: optionalId.optional(), filter_stocktake_status: looseNumber(0, 5).optional(),
  filter_series_id: optionalId.optional(), filter_stocktake_number: text(50).optional(), filter_date_from: unix.optional(), filter_date_to: unix.optional(),
  page: page.optional(),
}).strict();

function unique<T>(rows: T[], idOf: (row: T) => string) {
  const seen = new Set<number>();
  for (const r of rows) {
    const n = baseWireWmsId(idOf(r));
    ensure(!seen.has(n), 503, 'Niejednoznaczny identyfikator Base');
    seen.add(n);
  }
  return rows;
}
/** LOCAL: a document value exists natively only for a PZ of a purchase receipt (purchase order
 * unit cost); it is shown to keys that may read purchase costs (purchasing:read), else 0. */
const value = (minorUnits: number|null, readable: boolean) => readable && minorUnits !== null ? major(minorUnits) : 0;
function documentDto(d: BaseWireWmsDocument, readable: boolean): Record<string, BaseWireJson> {
  const source = d.purchase_id ? baseWireWmsId(d.purchase_id) : 0, type = d.purchase_id ? 2 : 0;
  return {
    document_id: baseWireWmsId(d.id), document_type: BASE_WIRE_DOCUMENT_TYPES[d.kind], document_status: d.status === 'posted' ? 1 : 0,
    direction: d.kind === 'receipt' ? 0 : 1, document_series_id: 0, full_number: d.number, date_created: d.created, date_confirmed: d.posted,
    warehouse_id: d.warehouse_public_id, warehouse_id2: d.destination_public_id ?? 0, items_count: d.items, total_quantity: d.quantity, total_price: value(d.cost, readable),
    // LOCAL: the only native document source is a purchase receipt; connection_* repeats it.
    connection_type: type, connection_id: source, notes: d.note, source_object_type: type, source_object_id: source,
  };
}
const linePart = (l: BaseWireWmsLine, position: number) => ({
  item_id: l.product_public_id, position, product_id: l.product_public_id, product_name: l.name, product_ean: l.ean ?? '', product_sku: l.sku,
  inventory_id: l.catalog_public_id, quantity: l.quantity, expiry_date: '', batch: '', serial_no: '',
});
const pageOf = <T>(rows: T[], p: number|undefined) => rows.slice(((p ?? 1) - 1) * BASE_WIRE_WMS_PAGE, (p ?? 1) * BASE_WIRE_WMS_PAGE);
function purchaseDto(p: BaseWireWmsPurchase): Record<string, BaseWireJson> {
  return {
    id: baseWireWmsId(p.id), name: p.reference, series_id: 0, document_number: p.number, date_created: p.created, date_sent: p.sent, date_received: p.received,
    date_completed: p.completed, date_expected_delivery: p.expected, warehouse_id: p.warehouse_public_id, assigned_to: 0, supplier_id: baseWireWmsId(p.supplier_id),
    payer_id: 0, currency: p.currency, total_quantity: p.quantity, completed_total_quantity: p.received_quantity, total_cost: major(p.cost), additional_cost: [],
    completed_total_cost: major(p.received_cost), items_count: p.items, completed_items_count: p.received_items, cost_invoice_no: '', date_cost_invoice_issue: 0,
    cost_invoice_file: '', notes: p.note, status: BASE_WIRE_PURCHASE_STATUS[p.state] ?? local(503, 'Nieznany stan zamówienia zakupowego', 'LOCAL_BASE_WIRE_PURCHASE_STATE'),
  };
}
const supplierDto = (s: BaseWireWmsSupplier): Record<string, BaseWireJson> => ({
  supplier_id: baseWireWmsId(s.id), name: s.name, address: s.address, postcode: '', city: '', phone: s.phone, email: s.email, email_copy_to: '', currency: '', tax_no: s.tax_id,
});
/** Native blind count: expected quantities stay hidden from non-admins while counting/review. */
const hidden = (t: { blind: boolean; state: string }, actor: Actor) => t.blind && actor.role !== 'admin' && ['counting', 'review'].includes(t.state);
function stocktakeDto(t: BaseWireWmsStocktake, actor: Actor): Record<string, BaseWireJson> {
  const h = hidden(t, actor);
  return {
    stocktake_id: baseWireWmsId(t.id), stocktake_number: '', name: t.name,
    stocktake_status: BASE_WIRE_STOCKTAKE_STATUS[t.state] ?? local(503, 'Nieznany stan spisu', 'LOCAL_BASE_WIRE_STOCKTAKE_STATE'),
    series_id: 0, warehouse_id: t.warehouse_public_id, priority: 0, assigned_to: 0, items_count: t.items, verified_items_count: t.counted_items,
    total_quantity: h ? 0 : t.quantity, verified_total_quantity: t.counted_quantity, compliant_items_count: h ? 0 : t.compliant,
    not_compliant_items_count: h ? 0 : t.not_compliant, missing_items_count: h ? 0 : t.missing, date_created: t.created, date_completed: t.posted,
    date_scheduled: 0, date_due: 0, notes: '', items_preparation_status: 'ready',
  };
}

export function createBaseWireWmsService(ports: BaseWireWmsPorts) {
  const tx = <T>(actor: Actor, writing: boolean, purchasing: boolean, work: (n: BaseWireWmsNative) => Promise<T>) =>
    ports.transaction(actor, writing, purchasing, c => work(ports.native(c, actor)));
  const hash = (actor: Actor, selected: Method, parameters: Record<string, BaseWireJson>) =>
    createHash('sha256').update(JSON.stringify({ api_key_id: actor.apiKeyId, method: selected, parameters })).digest('hex');
  function writer(actor: Actor, options: { clientKey?: string }) {
    ensure(actor.source === 'api' && !!actor.apiKeyId, 503, 'Brak klucza API');
    // Same role gate as the native warehouse/purchasing routes.
    ensure(actor.role === 'admin', 403, 'Wymagana rola administratora');
    return options.clientKey === undefined ? undefined : z.uuid().parse(options.clientKey);
  }
  /** Replay inside the effect's transaction; the response is stored before COMMIT. */
  function once(actor: Actor, selected: Method, parameters: Record<string, BaseWireJson>, options: { clientKey?: string }, purchasing: boolean,
    work: (n: BaseWireWmsNative) => Promise<Record<string, BaseWireJson>>) {
    const clientKey = writer(actor, options), requestHash = hash(actor, selected, parameters);
    return tx(actor, true, purchasing, async n => {
      if (clientKey) { const retained = await n.replay(clientKey, requestHash); if (retained) return retained; }
      const response = await work(n);
      if (clientKey) await n.remember(clientKey, response);
      return response;
    });
  }
  async function own(n: BaseWireWmsNative, entity: BaseWireWmsEntity, publicId: number, missing: string) {
    const found = await n.find(entity, publicId);
    ensure(found.length <= 1, 503, 'Niejednoznaczny identyfikator Base');
    ensure(found.length === 1, 404, missing);
    return found[0];
  }
  async function fresh(n: BaseWireWmsNative, entity: BaseWireWmsEntity, created: string) {
    if (await n.taken(entity, created, baseWireWmsKey(created))) local(503, 'Kolizja identyfikatora Base', 'LOCAL_BASE_WIRE_WMS_ID');
    return baseWireWmsId(created);
  }
  async function warehouse(n: BaseWireWmsNative, publicId: number) {
    const w = (await n.warehouses()).find(x => x.public_id === publicId);
    ensure(w, 404, 'Nie znaleziono magazynu');
    return w.id;
  }
  async function products(n: BaseWireWmsNative, publicIds: number[]) {
    ensure(new Set(publicIds).size === publicIds.length, 422, 'Produkt występuje więcej niż raz');
    const found = await n.products(publicIds);
    return publicIds.map(p => { const x = found.find(f => f.public_id === p); ensure(x, 404, 'Nie znaleziono produktu'); return x.id; });
  }
  /** Optional numeric filter → own UUID; unknown own entity means an empty result (undefined = no filter, null = nothing). */
  async function filterIds(n: BaseWireWmsNative, entity: BaseWireWmsEntity, publicId: number|undefined) {
    if (!publicId) return undefined;
    const found = await n.find(entity, publicId);
    ensure(found.length <= 1, 503, 'Niejednoznaczny identyfikator Base');
    return found.length ? found : null;
  }

  async function documents(actor: Actor, parameters: Record<string, BaseWireJson>) {
    const b = documentsInput.parse(parameters);
    return tx(actor, false, false, async n => {
      const none = { documents: [] };
      const kinds = b.filter_document_type === undefined ? (['receipt', 'issue', 'transfer'] as BaseWireWmsKind[]) : [kindOf(b.filter_document_type)].filter(k => !!k) as BaseWireWmsKind[];
      // LOCAL: the only native source object is a purchase order (its receipt PZ).
      if (!kinds.length || (b.filter_source_object_type !== undefined && b.filter_source_object_type !== 2)) return none;
      const ids = await filterIds(n, 'document', b.filter_document_id);
      const purchases = await filterIds(n, 'purchase', b.filter_source_object_id);
      if (ids === null || purchases === null) return none;
      let warehouseId: string|undefined;
      if (b.filter_warehouse_id) { warehouseId = (await n.warehouses()).find(w => w.public_id === b.filter_warehouse_id)?.id; if (!warehouseId) return none; }
      const rows = await n.documents({ ids, kinds, status: b.filter_document_status === undefined ? undefined : b.filter_document_status ? 'posted' : 'draft',
        warehouse_id: warehouseId, date_from: b.filter_date_from, date_to: b.filter_date_to, purchase_ids: purchases,
        sourced: b.filter_source_object_type === 2 || undefined, ...offset(b.page) });
      const readable = rows.some(r => r.cost !== null) && await n.costReadable();
      return { documents: unique(rows.slice(0, BASE_WIRE_WMS_PAGE), r => r.id).map(r => documentDto(r, readable)) };
    });
  }
  async function documentItems(actor: Actor, parameters: Record<string, BaseWireJson>) {
    const b = itemsPageInput('document_id').parse(parameters) as { document_id: number; page?: number };
    return tx(actor, false, false, async n => {
      const docId = await own(n, 'document', b.document_id, 'Nie znaleziono dokumentu magazynowego');
      const head = await n.document(docId), lines = await n.documentLines(docId);
      const readable = lines.some(l => l.unit_cost !== null) && await n.costReadable();
      return { items: pageOf(lines.map((l, i) => ({ ...linePart(l, i + 1), document_id: b.document_id,
        price: value(l.unit_cost, readable), total_price: value(l.unit_cost === null ? null : l.unit_cost * l.quantity, readable),
        // Native line location: put-away location of a PZ, destination location of an MM.
        location_name: head.kind === 'transfer' ? '' : l.location, target_location_name: head.kind === 'transfer' ? l.location : '', comments: '' })), b.page) };
    });
  }
  async function addDocument(actor: Actor, parameters: Record<string, BaseWireJson>, options: { clientKey?: string }) {
    const b = documentInput.parse(parameters);
    const kind = kindOf(b.document_type);
    if (!kind) local(422, 'Ten typ dokumentu nie ma lokalnego odpowiednika', 'LOCAL_BASE_WIRE_DOCUMENT_TYPE');
    ensure((kind === 'transfer') === !!b.target_warehouse_id, 422, 'Magazyn docelowy podaje się tylko dla przesunięcia (typ 4)');
    // LOCAL: the native document dates are the transaction clock; contractor has no column.
    refuseUnmapped(b, ['date_add', 'date_execute', 'contractor']);
    return once(actor, 'addInventoryDocument', parameters, options, false, async n => {
      const warehouseId = await warehouse(n, b.warehouse_id), destination = b.target_warehouse_id ? await warehouse(n, b.target_warehouse_id) : null;
      const created = await n.createDocument({ kind: kind!, warehouse_id: warehouseId, destination_id: destination, reference: b.invoice_no ?? '', note: b.notes ?? '' });
      return { document_id: await fresh(n, 'document', created.id), document_number: created.number };
    });
  }
  async function addDocumentItems(actor: Actor, parameters: Record<string, BaseWireJson>, options: { clientKey?: string }) {
    const b = documentItemsInput.parse(parameters);
    // LOCAL: native lines carry no price, batch, serial, expiry or comment.
    for (const item of b.items) refuseUnmapped(item, ['price', 'expiry_date', 'batch', 'serial_no', 'comments']);
    return once(actor, 'addInventoryDocumentItems', parameters, options, false, async n => {
      const head = await n.document(await own(n, 'document', b.document_id, 'Nie znaleziono dokumentu magazynowego'));
      ensure(head.status === 'draft', 409, 'Można edytować tylko szkic');
      const ids = await products(n, b.items.map(i => i.product_id));
      ensure(!ids.some(p => head.lines.some(l => l.product_id === p)), 409, 'Produkt jest już na dokumencie');
      const added = b.items.map((item, i) => {
        // One native location per line: PZ put-away (location_name), MM destination (target_location_name); a WZ takes no location.
        const location = head.kind === 'transfer' ? item.target_location_name : head.kind === 'receipt' ? item.location_name : undefined;
        if (!empty(head.kind === 'transfer' ? item.location_name : head.kind === 'receipt' ? item.target_location_name : (item.location_name || item.target_location_name))) unsupported();
        return { product_id: ids[i], quantity: item.quantity, location: location || 'A-01' };
      });
      await n.editDocument(head, [...head.lines, ...added]);
      const lines = await n.documentLines(head.id);
      return { items: ids.map(p => { const at = lines.findIndex(l => l.product_id === p); ensure(at >= 0, 503, 'Niespójna pozycja dokumentu');
        return { item_id: lines[at].product_public_id, position: at + 1 }; }) };
    });
  }
  async function confirmDocument(actor: Actor, parameters: Record<string, BaseWireJson>, options: { clientKey?: string }) {
    const b = confirmInput.parse(parameters);
    return once(actor, 'setInventoryDocumentStatusConfirmed', parameters, options, false, async n => {
      const head = await n.document(await own(n, 'document', b.document_id, 'Nie znaleziono dokumentu magazynowego'));
      // Exactly once: a confirmed document is never posted again (the native replay is a no-op as well).
      if (head.status === 'posted') return {};
      ensure(head.lines.length > 0, 422, 'Dokument nie ma pozycji');
      await n.postDocument(head.id, head.version);
      return {};
    });
  }

  async function purchases(actor: Actor, parameters: Record<string, BaseWireJson>) {
    const b = purchasesInput.parse(parameters);
    // LOCAL: native purchase orders have no numbering series (series_id 0).
    if (b.series_id) return { purchase_orders: [] };
    return tx(actor, false, false, async n => {
      const none = { purchase_orders: [] };
      const suppliers = await filterIds(n, 'supplier', b.supplier_id);
      if (suppliers === null) return none;
      let warehouseId: string|undefined, productId: string|undefined;
      if (b.warehouse_id) { warehouseId = (await n.warehouses()).find(w => w.public_id === b.warehouse_id)?.id; if (!warehouseId) return none; }
      if (b.filter_product_id) { productId = (await n.products([b.filter_product_id]))[0]?.id; if (!productId) return none; }
      const rows = await n.purchases({ warehouse_id: warehouseId, supplier_ids: suppliers, date_from: b.date_from, date_to: b.date_to,
        number: b.filter_document_number || undefined, product_id: productId, ...offset(b.page) });
      return { purchase_orders: unique(rows.slice(0, BASE_WIRE_WMS_PAGE), r => r.id).map(purchaseDto) };
    });
  }
  async function purchaseItems(actor: Actor, parameters: Record<string, BaseWireJson>) {
    const b = itemsPageInput('order_id').parse(parameters) as { order_id: number; page?: number };
    return tx(actor, false, false, async n => {
      const head = await n.purchase(await own(n, 'purchase', b.order_id, 'Nie znaleziono zamówienia zakupowego'));
      return { items: pageOf(head.lines.map((l, i) => ({ ...linePart(l, i + 1), order_id: b.order_id, supplier_code: l.supplier_sku,
        completed_quantity: l.received, item_cost: major(l.unit_cost), location: l.locations.join(';'), comments: '' })), b.page) };
    });
  }
  async function addPurchase(actor: Actor, parameters: Record<string, BaseWireJson>, options: { clientKey?: string }) {
    const b = purchaseInput.parse(parameters);
    // LOCAL: no payers, cost invoices, additional costs or packages natively.
    refuseUnmapped(b, ['payer_id', 'invoice_no', 'date_cost_invoice_issue', 'additional_costs', 'packages']);
    return once(actor, 'addInventoryPurchaseOrder', parameters, options, true, async n => {
      const supplierId = await own(n, 'supplier', b.supplier_id, 'Nie znaleziono dostawcy');
      const created = await n.savePurchase({ supplier_id: supplierId, warehouse_id: await warehouse(n, b.warehouse_id), currency: b.currency,
        reference: b.name ?? '', note: b.notes ?? '', expected_date: b.date_delivery_expected ? isoDate(b.date_delivery_expected) : null, lines: [] });
      return { order_id: await fresh(n, 'purchase', created.id), document_number: created.number };
    });
  }
  const purchaseLine = (l: BaseWireWmsPurchaseLine) => ({ product_id: l.product_id, quantity: l.quantity, unit_cost: l.unit_cost, supplier_sku: l.supplier_sku });
  const headInput = (h: BaseWireWmsPurchaseHead): Omit<BaseWireWmsPurchaseInput, 'lines'> =>
    ({ supplier_id: h.supplier_id, warehouse_id: h.warehouse_id, currency: h.currency, reference: h.reference, note: h.note, expected_date: h.expected_date });
  async function addPurchaseItems(actor: Actor, parameters: Record<string, BaseWireJson>, options: { clientKey?: string }) {
    const b = purchaseItemsInput.parse(parameters);
    for (const item of b.items) refuseUnmapped(item, ['location', 'batch', 'expiry_date', 'serial_no', 'comments']);
    return once(actor, 'addInventoryPurchaseOrderItems', parameters, options, true, async n => {
      const head = await n.purchase(await own(n, 'purchase', b.order_id, 'Nie znaleziono zamówienia zakupowego'));
      ensure(head.state === 'draft', 409, 'Edytować można wyłącznie szkic');
      const ids = await products(n, b.items.map(i => i.product_id));
      const lines = head.lines.map(purchaseLine);
      b.items.forEach((item, i) => {
        const line = { product_id: ids[i], quantity: item.quantity, unit_cost: minor(item.item_cost ?? 0), supplier_sku: item.supplier_code ?? '' };
        const existing = lines.find(l => l.product_id === line.product_id);
        if (!existing) { lines.push(line); return; }
        // Base: the same product with the same cost and code updates its position (LOCAL: quantity is added,
        // like the native draft append); another cost or code would be a second position, which the native model refuses.
        ensure(existing.unit_cost === line.unit_cost && existing.supplier_sku === line.supplier_sku, 409, 'Koszt lub kod dostawcy istniejącej pozycji jest inny');
        existing.quantity += line.quantity;
      });
      await n.savePurchase({ ...headInput(head), lines }, head.id, head.version);
      const saved = (await n.purchase(head.id)).lines;
      return { items: ids.map(p => { const at = saved.findIndex(l => l.product_id === p); ensure(at >= 0, 503, 'Niespójna pozycja zamówienia');
        return { item_id: saved[at].product_public_id, position: at + 1 }; }) };
    });
  }
  async function purchaseStatus(actor: Actor, parameters: Record<string, BaseWireJson>, options: { clientKey?: string }) {
    const b = purchaseStatusInput.parse(parameters);
    // LOCAL: 2 received and 6 received (not started) are delivery stages the native model does not have.
    if (b.status === 2 || b.status === 6) local(422, 'Ten status nie ma lokalnego odpowiednika', 'LOCAL_BASE_WIRE_PURCHASE_STATUS');
    const completed = b.completed_items ?? [];
    ensure(!completed.length || b.status === 3 || b.status === 4, 422, 'completed_items podaje się tylko dla statusu 3 lub 4');
    ensure(new Set(completed.map(i => i.item_id)).size === completed.length, 422, 'Pozycja występuje więcej niż raz');
    return once(actor, 'setInventoryPurchaseOrderStatus', parameters, options, true, async n => {
      const orderId = await own(n, 'purchase', b.order_id, 'Nie znaleziono zamówienia zakupowego');
      let head = await n.purchase(orderId);
      const current = BASE_WIRE_PURCHASE_STATUS[head.state];
      if (b.status === 0 || b.status === 1 || b.status === 5) {
        if (current === b.status) return {};
        if (b.status === 0) local(409, 'Wysłanego zamówienia nie można cofnąć do szkicu', 'LOCAL_BASE_WIRE_PURCHASE_TRANSITION');
        if (b.status === 1) {
          ensure(head.state === 'draft', 409, 'Zatwierdzić można wyłącznie szkic');
          ensure(head.lines.length > 0, 422, 'Zamówienie nie ma pozycji');
          await n.actPurchase(orderId, 'place', { version: head.version });
        } else await n.actPurchase(orderId, 'cancel', { version: head.version, reason: BASE_WIRE_PURCHASE_CANCEL_REASON });
        return {};
      }
      // 3/4: completed_quantity is the absolute received total of the line (LOCAL), so a replay receives nothing twice.
      const receipt = completed.map(i => {
        const line = head.lines.find(l => l.product_public_id === i.item_id);
        ensure(line, 404, 'Pozycja nie należy do zamówienia');
        ensure(i.completed_quantity >= line.received, 409, 'Przyjętej ilości nie można zmniejszyć', );
        return { product_id: line.product_id, quantity: i.completed_quantity - line.received };
      }).filter(l => l.quantity > 0);
      const remaining = (h: BaseWireWmsPurchaseHead) => h.lines.some(l => l.quantity - l.received - l.closed > 0);
      if (b.status === 4) {
        if (!receipt.length) { ensure(current === 4, 422, 'Podaj completed_items z przyjmowanymi ilościami'); return {}; }
        // Completing every line is status 3; 4 leaves the order open (native partial).
        const after = head.lines.map(l => ({ ...l, received: l.received + (receipt.find(r => r.product_id === l.product_id)?.quantity ?? 0) }));
        ensure(remaining({ ...head, lines: after }), 409, 'Przyjęcie kończy zamówienie; użyj statusu 3');
      }
      if (b.status === 3 && current === 3 && !receipt.length) return {};
      if (receipt.length) {
        await n.receivePurchase(orderId, { version: head.version, lines: receipt });
        head = await n.purchase(orderId);
      }
      // 3 completed: the open remainder is closed natively (state closed); a fully received order is already completed.
      if (b.status === 3 && remaining(head)) await n.actPurchase(orderId, 'close', { version: head.version, reason: BASE_WIRE_PURCHASE_CLOSE_REASON });
      return {};
    });
  }

  async function suppliers(actor: Actor, parameters: Record<string, BaseWireJson>) {
    const b = suppliersInput.parse(parameters);
    return tx(actor, false, false, async n => {
      const ids = await filterIds(n, 'supplier', b.filter_id);
      if (ids === null) return { suppliers: [] };
      const rows = await n.suppliers({ ids, name: b.filter_name || undefined, limit: BASE_WIRE_WMS_SUPPLIERS_LIMIT + 1 });
      ensure(rows.length <= BASE_WIRE_WMS_SUPPLIERS_LIMIT, 422, 'Za dużo dostawców; zawęź filter_name');
      return { suppliers: unique(rows, r => r.id).map(supplierDto) };
    });
  }
  async function addSupplier(actor: Actor, parameters: Record<string, BaseWireJson>, options: { clientKey?: string }) {
    const b = supplierInput.parse(parameters);
    // LOCAL: the native supplier has one free-text address and no currency, CC address or product cost/code selectors.
    refuseUnmapped(b, ['take_product_cost_from', 'take_product_code_from', 'postcode', 'city', 'email_copy_to', 'currency']);
    return once(actor, 'addInventorySupplier', parameters, options, false, async n => {
      const given = { name: b.name, address: b.address, phone: b.phone, email: b.email, tax_id: b.tax_no };
      if (b.supplier_id) {
        const supplierId = await own(n, 'supplier', b.supplier_id, 'Nie znaleziono dostawcy');
        const old = (await n.suppliers({ ids: [supplierId], limit: 1 }))[0];
        ensure(old, 404, 'Nie znaleziono dostawcy');
        // Omitted fields keep their native value; native-only fields stay unchanged.
        const { id: _id, version, ...rest } = old;
        const merged = { ...rest, ...Object.fromEntries(Object.entries(given).filter(([, v]) => v !== undefined)) } as BaseWireWmsSupplierInput;
        await n.saveSupplier(merged, supplierId, version);
        return { supplier_id: b.supplier_id };
      }
      ensure(b.name !== undefined && b.name.trim().length >= 2, 422, 'Podaj nazwę dostawcy (min. 2 znaki)');
      const created = await n.saveSupplier({ name: b.name!, code: ports.supplierCode(), contact_name: '', email: b.email ?? '', phone: b.phone ?? '',
        address: b.address ?? '', tax_id: b.tax_no ?? '', country: 'PL', active: true });
      return { supplier_id: await fresh(n, 'supplier', created) };
    });
  }

  async function stocktakes(actor: Actor, parameters: Record<string, BaseWireJson>) {
    const b = stocktakesInput.parse(parameters);
    const state = b.filter_stocktake_status === undefined ? undefined : Object.entries(BASE_WIRE_STOCKTAKE_STATUS).find(([, s]) => s === b.filter_stocktake_status)?.[0];
    // LOCAL: no series and no stocktake number natively; draft/commissioned (0/1) do not exist.
    if (b.filter_series_id || b.filter_stocktake_number || (b.filter_stocktake_status !== undefined && !state)) return { stocktakes: [] };
    return tx(actor, false, false, async n => {
      const ids = await filterIds(n, 'stocktake', b.filter_stocktake_id);
      if (ids === null) return { stocktakes: [] };
      let warehouseId: string|undefined;
      if (b.filter_warehouse_id) { warehouseId = (await n.warehouses()).find(w => w.public_id === b.filter_warehouse_id)?.id; if (!warehouseId) return { stocktakes: [] }; }
      const rows = await n.stocktakes({ ids, warehouse_id: warehouseId, state, date_from: b.filter_date_from, date_to: b.filter_date_to, ...offset(b.page) });
      return { stocktakes: unique(rows.slice(0, BASE_WIRE_WMS_PAGE), r => r.id).map(t => stocktakeDto(t, actor)) };
    });
  }
  async function stocktakeItems(actor: Actor, parameters: Record<string, BaseWireJson>) {
    const b = itemsPageInput('stocktake_id').parse(parameters) as { stocktake_id: number; page?: number };
    return tx(actor, false, false, async n => {
      const stocktakeId = await own(n, 'stocktake', b.stocktake_id, 'Nie znaleziono spisu');
      const t = (await n.stocktakes({ ids: [stocktakeId], offset: 0, limit: 1 }))[0];
      ensure(t, 404, 'Nie znaleziono spisu');
      const h = hidden(t, actor), lines = unique(await n.stocktakeLines(stocktakeId), l => l.id);
      return { items: pageOf(lines.map((l, i) => ({ ...linePart(l, i + 1), item_id: baseWireWmsId(l.id), stocktake_id: b.stocktake_id, quantity: h ? 0 : l.quantity,
        verified_quantity: l.counted ?? 0, is_verified: l.counted !== null, location_name: l.location })), b.page) };
    });
  }

  return {
    async execute(actor: Actor, selected: string, parameters: Record<string, BaseWireJson>, options: { clientKey?: string; credential?: string } = {}): Promise<Record<string, BaseWireJson>> {
      method(selected);
      switch (selected) {
        case 'getInventoryDocuments': return documents(actor, parameters);
        case 'getInventoryDocumentItems': return documentItems(actor, parameters);
        case 'addInventoryDocument': return addDocument(actor, parameters, options);
        case 'addInventoryDocumentItems': return addDocumentItems(actor, parameters, options);
        case 'setInventoryDocumentStatusConfirmed': return confirmDocument(actor, parameters, options);
        case 'getInventoryPurchaseOrders': return purchases(actor, parameters);
        case 'getInventoryPurchaseOrderItems': return purchaseItems(actor, parameters);
        case 'addInventoryPurchaseOrder': return addPurchase(actor, parameters, options);
        case 'addInventoryPurchaseOrderItems': return addPurchaseItems(actor, parameters, options);
        case 'setInventoryPurchaseOrderStatus': return purchaseStatus(actor, parameters, options);
        case 'getInventorySuppliers': return suppliers(actor, parameters);
        case 'addInventorySupplier': return addSupplier(actor, parameters, options);
        case 'getInventoryStocktakes': return stocktakes(actor, parameters);
        case 'getInventoryStocktakeItems': return stocktakeItems(actor, parameters);
      }
    },
  };
}
export type BaseWireWmsService = ReturnType<typeof createBaseWireWmsService>;

/** Eighth connector.php family. Only startup capability selects availability. */
export function createBaseWireWmsFamily(opts: { service: Pick<BaseWireWmsService, 'execute'>; available: boolean }): BaseWireFamily {
  return Object.freeze({ label: 'WMS', methods: BASE_WIRE_WMS_METHODS, scope: baseWireWmsScope, isWrite: isBaseWireWmsWrite,
    available: opts.available === true, service: opts.service });
}
