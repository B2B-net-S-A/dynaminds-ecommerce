/** Base "invoices" family on connector.php: getSeries, addInvoice, getInvoices,
 * getInvoiceFile over the native local invoices (local_invoice_series, preview +
 * issue with the native continuous numbering per series and year) with the 220
 * numeric identities.
 * Source: docs/parity/base-api-document-contracts.v1.json (Orders / Invoices).
 * Field mapping and every local choice: docs/parity/BASE-WIRE-INVOICES220-20261023.md.
 * No database/runtime import: the native port is supplied at startup.
 */
import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { Actor } from './domain';
import { Problem, ensure } from './errors';
import type { BaseWireJson } from './base-wire-codec';
import type { BaseWireFamily } from './base-wire-routes';

export const BASE_WIRE_INVOICES_METHODS = ['getSeries','addInvoice','getInvoices','getInvoiceFile'] as const;
type Method = typeof BASE_WIRE_INVOICES_METHODS[number];
function method(value: string): asserts value is Method {
  ensure(BASE_WIRE_INVOICES_METHODS.includes(value as Method), 400, 'Nieznana metoda Base faktur');
}
export function isBaseWireInvoicesWrite(value: string) { method(value); return value === 'addInvoice'; }
/** documents:write also requires documents:read (authenticateBaseWireApiKey); the
 * native invoice gate additionally requires orders:read on the key. */
export function baseWireInvoicesScope(value: string) {
  return isBaseWireInvoicesWrite(value) ? 'documents:write' as const : 'documents:read' as const;
}
/** Base getInvoices result cap (contract: "A maximum of 100 invoices"). */
export const BASE_WIRE_INVOICES_PAGE = 100;
/** Native local invoices are consumer sales only; these are their VAT rates. */
const NATIVE_VAT = [0, 5, 8, 23];

export type BaseWireInvoiceSeries = { id: string; public_id: number; name: string; prefix: string };
export type BaseWireInvoiceLine = { kind: 'item'|'shipping'; name: string; sku: string; quantity: number; vat_rate: number; gross_minor: string; net_minor: string };
/** One native local invoice (documents mode local_invoice + its receipt). */
export type BaseWireInvoice = {
  public_id: number; order_public_id: number; series_public_id: number; number: string; year: number; sequence: number; created: number;
  sell_date: string; due_date: string; currency: string; gross_minor: string; net_minor: string; notes: string;
  seller: { name: string; street: string; postal_code: string; city: string; tax_id: string };
  buyer: { name: string; street: string; postal_code: string; city: string; country: string };
  lines: BaseWireInvoiceLine[];
};
export type BaseWireInvoicesFilter = { public_id?: number; order_public_id?: number; series_public_id?: number; date_from?: number; id_from?: number; limit: number };
/** Facts of an own order needed for the native preview body. */
export type BaseWireInvoiceOrder = { version: string; customer_name: string; address: Record<string, unknown>; shipping_cost: number; vats: number[]; shipped_on: string|null };
export type BaseWireNativeInvoiceInput = {
  series_id: string; order_version: string; shipping_vat: number; sell_date: string;
  buyer: { kind: 'consumer'; name: string; street: string; postal_code: string; city: string; country: 'PL' };
};
/** One native port per transaction (already inside the native invoice identity
 * frame); every lookup is the current tenant only. */
export type BaseWireInvoicesNative = {
  /** base_wire220_allocate_pending(kind) for the current tenant (writing transaction only). */
  allocate(kind: 'order'|'invoice'|'invoice_series'): Promise<void>;
  series(): Promise<BaseWireInvoiceSeries[]>;
  /** Own order UUID for a numeric order_id, or null. */
  order(publicId: number): Promise<string|null>;
  orderFacts(orderId: string): Promise<BaseWireInvoiceOrder>;
  /** Native preview + issue (POST /api/local-invoices/orders/:id/previews, then
   * /previews/:id/issue) in this transaction; returns the document UUID. */
  issue(orderId: string, input: BaseWireNativeInvoiceInput): Promise<string>;
  /** LOCAL: number and Polish note of an invoice issued in the FV-S (230) sub-series because the
   * company's 157 local invoice budget is exhausted; null for a 157 invoice. */
  issuedNote?(documentId: string): Promise<{ invoice_number: string; local_note: string }|null>;
  invoicePublicId(documentId: string): Promise<number>;
  invoices(filter: BaseWireInvoicesFilter): Promise<BaseWireInvoice[]>;
  /** Native print file (GET /api/local-invoices/documents/:id/print), or null. */
  file(publicId: number): Promise<{ number: string; content: string }|null>;
  replay(clientKey: string, requestHash: string): Promise<Record<string, BaseWireJson>|null>;
  remember(clientKey: string, response: Record<string, BaseWireJson>): Promise<void>;
};
export type BaseWireInvoicesTxMode = 'read'|'allocate'|'write';
export type BaseWireInvoicesPorts = {
  /** Runs the native local-invoice identity/access gate of this key first: 'read' is a
   * read-only transaction with the read gate, 'allocate' a writing transaction with the
   * read gate (identity bookkeeping before a read), 'write' the native issue gate. */
  transaction<T>(actor: Actor, mode: BaseWireInvoicesTxMode, credential: string, work: (c: PoolClient) => Promise<T>): Promise<T>;
  native(c: PoolClient, actor: Actor): BaseWireInvoicesNative;
  /** Startup decision: a read-only copy never allocates identities. */
  allocateOnRead: boolean;
};

const id = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const unix = z.number().int().min(0).max(253402300799);
// Base documents bool, examples use 0/1 and "0"/"1". Anything else is refused.
const flag = z.union([z.boolean(), z.literal(0), z.literal(1), z.literal('0'), z.literal('1')]).transform(v => v === true || v === 1 || v === '1');
const seriesInput = z.object({}).strict();
// LOCAL: only DEFAULT and ITEM (both the frozen catalog rate of each order line;
// native series carry no VAT setting). Exemptions, NP, OO and a forced rate are refused.
const addInput = z.object({ order_id: id, series_id: id, vat_rate: z.union([z.string().max(10), z.number()]).optional() }).strict();
const listInput = z.object({
  invoice_id: id.optional(), order_id: id.optional(), date_from: unix.optional(), id_from: id.optional(), series_id: id.optional(),
  get_external_invoices: flag.optional(), get_government_data: flag.optional(),
}).strict();
const fileInput = z.object({ invoice_id: id, get_external: flag.optional() }).strict();

const major = (minor: string) => Number(BigInt(minor)) / 100;
const unit = (minor: string, quantity: number) => Math.round(Number(BigInt(minor)) / quantity * 100) / 10000;
const day = (iso: string) => Math.floor(Date.parse(iso + 'T00:00:00Z') / 1000);
const str = (value: unknown) => typeof value === 'string' ? value.trim() : '';

function invoiceDto(i: BaseWireInvoice): Record<string, BaseWireJson> {
  const s = i.seller, b = i.buyer;
  return {
    invoice_id: i.public_id, order_id: i.order_public_id, series_id: i.series_public_id, type: 'normal', number: i.number,
    sub_id: i.sequence, month: 0, year: i.year, postfix: '', date_add: i.created, date_sell: day(i.sell_date), date_pay_to: day(i.due_date),
    currency: i.currency, total_price_brutto: major(i.gross_minor), total_price_netto: major(i.net_minor), payment: '', additional_info: i.notes,
    invoice_fullname: b.name, invoice_company: '', invoice_nip: '', invoice_address: b.street, invoice_postcode: b.postal_code, invoice_city: b.city,
    invoice_country: '', invoice_country_code: b.country, seller: [s.name, s.street, s.postal_code + ' ' + s.city, 'NIP ' + s.tax_id].join('\r\n'), issuer: '',
    correcting_to_invoice_id: 0, correcting_reason: '', correcting_items: false, correcting_data: false, external_invoice_number: '',
    exchange_currency: '', exchange_rate: 0, exchange_date: '', exchange_info: '', external_id: 0,
    items: i.lines.map(l => ({ name: l.name, sku: l.sku, ean: '', price_brutto: unit(l.gross_minor, l.quantity), price_netto: unit(l.net_minor, l.quantity),
      tax_rate: l.vat_rate, quantity: l.quantity, is_shipment: l.kind === 'shipping' ? 1 : 0, order_product_id: 0 })),
  };
}
function unsupported(): never { throw new Problem(422, 'Pole nie jest obsługiwane lokalnie', 'LOCAL_BASE_WIRE_UNSUPPORTED_FIELD'); }
/** LOCAL: delivery VAT. A single item rate is used for delivery; free delivery takes
 * the highest item rate (zero amount); paid delivery with mixed item rates is refused. */
export function baseWireShippingVat(vats: readonly number[], shippingCost: number) {
  const rates = [...new Set(vats)].sort((x, y) => x - y);
  ensure(rates.length > 0 && rates.every(r => NATIVE_VAT.includes(r)), 409, 'Pozycje zamówienia nie mają obsługiwanej stawki VAT');
  if (rates.length > 1 && shippingCost !== 0) throw new Problem(422, 'Mieszane stawki VAT: VAT dostawy wybierz w aplikacji', 'LOCAL_BASE_WIRE_SHIPPING_VAT');
  return rates.at(-1)!;
}

export function createBaseWireInvoicesService(ports: BaseWireInvoicesPorts) {
  const tx = <T>(actor: Actor, mode: BaseWireInvoicesTxMode, credential: string, work: (n: BaseWireInvoicesNative) => Promise<T>) =>
    ports.transaction(actor, mode, credential, c => work(ports.native(c, actor)));
  const hash = (actor: Actor, parameters: Record<string, BaseWireJson>) =>
    createHash('sha256').update(JSON.stringify({ api_key_id: actor.apiKeyId, method: 'addInvoice', parameters })).digest('hex');
  function custody(actor: Actor, options: { credential?: string }) {
    ensure(actor.source === 'api' && !!actor.apiKeyId && typeof options.credential === 'string', 503, 'Brak natywnej kustodii klucza API');
    return options.credential;
  }
  async function add(actor: Actor, parameters: Record<string, BaseWireJson>, options: { clientKey?: string; credential?: string }) {
    const b = addInput.parse(parameters);
    if (b.vat_rate !== undefined && b.vat_rate !== 'DEFAULT' && b.vat_rate !== 'ITEM') unsupported();
    const credential = custody(actor, options);
    // Same role gate as the native issue (local_invoice_access: admin/operator).
    ensure(actor.role === 'admin' || actor.role === 'operator', 403, 'Konto ma uprawnienia tylko do odczytu');
    const clientKey = options.clientKey === undefined ? undefined : z.uuid().parse(options.clientKey), requestHash = hash(actor, parameters);
    return tx(actor, 'write', credential, async n => {
      if (clientKey) { const retained = await n.replay(clientKey, requestHash); if (retained) return retained; }
      const order = await n.order(b.order_id);
      ensure(order, 404, 'Nie znaleziono zamówienia');
      const series = (await n.series()).find(s => s.public_id === b.series_id);
      ensure(series, 404, 'Nie znaleziono własnej serii faktur');
      const o = await n.orderFacts(order), a = o.address;
      // LOCAL: the buyer is the order's consumer and delivery address (native scope:
      // consumer, PL, PLN); the sale date is the native shipment date.
      ensure(a.country === 'PL', 422, 'Lokalna FV obsługuje wyłącznie sprzedaż krajową PL');
      ensure(o.shipped_on, 409, 'Zamówienie nie ma natywnej daty wysyłki');
      const local = await n.issue(order, {
        series_id: series.id, order_version: o.version, shipping_vat: baseWireShippingVat(o.vats, o.shipping_cost), sell_date: o.shipped_on,
        buyer: { kind: 'consumer', name: str(o.customer_name), street: str(a.street), postal_code: str(a.postal_code), city: str(a.city), country: 'PL' },
      });
      await n.allocate('invoice');
      // LOCAL: past the 157 lifetime limit the invoice is FV-S/<prefix>/<year>/<seq>; the response says so.
      const response = { invoice_id: await n.invoicePublicId(local), ...((await n.issuedNote?.(local)) ?? {}) };
      if (clientKey) await n.remember(clientKey, response);
      return response;
    });
  }
  async function invoices(actor: Actor, parameters: Record<string, BaseWireJson>, credential: string) {
    const b = listInput.parse(parameters);
    // LOCAL: local invoices are never sent to KSeF, so there is no government data.
    if (b.get_government_data === true) throw new Problem(422, 'Flaga nie jest obsługiwana lokalnie', 'LOCAL_BASE_WIRE_UNSUPPORTED_FLAG');
    // Natively issued invoices (and their orders/series) get numeric IDs before the read snapshot.
    if (ports.allocateOnRead) await tx(actor, 'allocate', credential, async n => { for (const kind of ['order', 'invoice_series', 'invoice'] as const) await n.allocate(kind); });
    // LOCAL: get_external_invoices has no effect (no external invoice files exist locally).
    return tx(actor, 'read', credential, async n => ({ invoices: (await n.invoices({ public_id: b.invoice_id, order_public_id: b.order_id,
      series_public_id: b.series_id, date_from: b.date_from, id_from: b.id_from, limit: BASE_WIRE_INVOICES_PAGE })).slice(0, BASE_WIRE_INVOICES_PAGE).map(invoiceDto) }));
  }
  return {
    async execute(actor: Actor, selected: string, parameters: Record<string, BaseWireJson>, options: { clientKey?: string; credential?: string } = {}): Promise<Record<string, BaseWireJson>> {
      method(selected);
      if (selected === 'addInvoice') return add(actor, parameters, options);
      const credential = custody(actor, options);
      if (selected === 'getInvoices') return invoices(actor, parameters, credential);
      if (selected === 'getInvoiceFile') {
        const b = fileInput.parse(parameters);
        // get_external=true falls back to the Base (native) file: no external file exists locally.
        const file = await tx(actor, 'read', credential, n => n.file(b.invoice_id));
        ensure(file, 404, 'Nie znaleziono własnej faktury');
        return { invoice: 'data:' + Buffer.from(file.content, 'utf8').toString('base64'), invoice_number: file.number };
      }
      seriesInput.parse(parameters);
      if (ports.allocateOnRead) await tx(actor, 'allocate', credential, n => n.allocate('invoice_series'));
      // LOCAL: native series are yearly-continuous invoice series PREFIX/YYYY/NNNNNN.
      return tx(actor, 'read', credential, async n => ({ series: (await n.series()).map(s => ({ id: s.public_id, type: 'INVOICE', name: s.name, format: s.prefix + '/%Y/%N' })) }));
    },
  };
}
export type BaseWireInvoicesService = ReturnType<typeof createBaseWireInvoicesService>;

/** Fifth connector.php family. Only startup capability selects availability. */
export function createBaseWireInvoicesFamily(opts: { service: Pick<BaseWireInvoicesService, 'execute'>; available: boolean }): BaseWireFamily {
  return Object.freeze({ label: 'faktur', methods: BASE_WIRE_INVOICES_METHODS, scope: baseWireInvoicesScope, isWrite: isBaseWireInvoicesWrite,
    available: opts.available === true, nativeCredentialCustody: true, service: opts.service });
}
