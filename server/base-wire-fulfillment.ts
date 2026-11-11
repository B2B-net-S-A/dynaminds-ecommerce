/** Base "fulfillment" family on connector.php: getOrderSources, addOrderPickList,
 * createPackage, getLabel, getOrderPackages, getPackageDetails,
 * getCourierPackagesStatusHistory, getCouriersList over the native OMS/WMS/shipping
 * code (channels, picking waves, the local demo shipment, native shipments, their
 * shipping plans and stored tracking, native shipment labels) with the 220 identities.
 * Sources: docs/parity/base-api-orders-next-contracts-20261018.md (getOrderSources,
 * addOrderPickList) and base-api-courier-contracts.v1.json (the courier methods).
 * Field mapping and every local choice: docs/parity/BASE-WIRE-FULFILLMENT220-20261023.md.
 * No database/runtime import: the native port is supplied at startup.
 */
import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { Actor } from './domain';
import { Problem, ensure } from './errors';
import type { BaseWireJson } from './base-wire-codec';
import type { BaseWireFamily } from './base-wire-routes';

export const BASE_WIRE_FULFILLMENT_METHODS = ['getOrderSources','addOrderPickList','createPackage','getLabel',
  'getOrderPackages','getPackageDetails','getCourierPackagesStatusHistory','getCouriersList'] as const;
type Method = typeof BASE_WIRE_FULFILLMENT_METHODS[number];
function method(value: string): asserts value is Method {
  ensure(BASE_WIRE_FULFILLMENT_METHODS.includes(value as Method), 400, 'Nieznana metoda Base realizacji');
}
export function isBaseWireFulfillmentWrite(value: string) { method(value); return value === 'addOrderPickList' || value === 'createPackage'; }
/** LOCAL: there is no shipping scope; pick lists and packages are order fulfilment,
 * so orders:write (which also requires orders:read) / orders:read. */
export function baseWireFulfillmentScope(value: string) {
  return isBaseWireFulfillmentWrite(value) ? 'orders:write' as const : 'orders:read' as const;
}
/** LOCAL courier codes: only the native local simulator creates a package synchronously. */
export const BASE_WIRE_DEMO_COURIER = 'demo';
/** Native couriers whose shipment is a quoted/queued plan finished by a worker. */
const ASYNC_COURIERS = ['inpost', 'dpd', 'dhl', 'pocztapolska'];
/** Native carrier names (shipments.carrier) of the courier codes. */
const COURIER_NAMES: Record<string, string> = { demo: 'Symulator lokalny', dpd: 'DPD Polska', inpost: 'InPost ShipX', dhl: 'DHL Parcel Polska', pocztapolska: 'Poczta Polska' };
/** Couriers whose label PDF is stored with the plan at creation (never a provider request). */
const STORED_LABEL_COURIERS = ['dpd', 'dhl', 'pocztapolska'];
/** LOCAL: native shipment/tracking status → Base tracking_status. Native values: shipment
 * creation (created, label_ready), the local tracking example, dpdStatus() and InPost ShipX
 * statuses stored verbatim. Any other value is 0 (unknown); the native value itself stays
 * in courier_status_code. 13 (transferred_abroad) has no native status. */
export const BASE_WIRE_TRACKING_STATUS: ReadonlyMap<string, number> = new Map(Object.entries({
  created: 1, label_ready: 1, offers_prepared: 1, offer_selected: 1, confirmed: 1,
  dispatched_by_sender: 2, dispatched_by_sender_to_pok: 2, collected_from_sender: 2, taken_by_courier: 2, taken_by_courier_from_pok: 2,
  delivery_failed: 3, undelivered: 3, rejected_by_receiver: 3, undelivered_wrong_address: 3, undelivered_incomplete_address: 3,
  undelivered_unknown_receiver: 3, pickup_time_expired: 3,
  out_for_delivery: 4, out_for_delivery_to_address: 4,
  delivered: 5,
  returned_to_sender: 6, return_in_transit: 6,
  avizo: 7,
  ready_to_pickup: 8, ready_to_pickup_from_pok: 8, ready_to_pickup_from_branch: 8, pickup_reminder_sent: 8,
  lost: 9,
  canceled: 10,
  adopted_at_source_branch: 11, sent_from_source_branch: 11, adopted_at_sorting_center: 11, sent_from_sorting_center: 11,
  adopted_at_target_branch: 11, in_transit: 11, redirected: 11,
  claimed: 12,
}));
export const baseWireTrackingStatus = (status: string|null) => (status !== null && BASE_WIRE_TRACKING_STATUS.get(status)) || 0;

/** LOCAL: picking waves have no 220 sidecar and no migration is added. The Base
 * pick_list_id is derived from the immutable wave UUID: hex digits 1–12 and 14 (the
 * 52 random bits of a v4 UUID; digit 13 is the version) + 1, i.e. 1..2^52. A
 * collision with another wave of the same company is refused at creation. */
export function baseWirePickListKey(waveId: string) {
  const hex = z.uuid().parse(waveId).replace(/-/g, '');
  return hex.slice(0, 12) + hex.slice(13, 14);
}
export function baseWirePickListId(waveId: string) { return parseInt(baseWirePickListKey(waveId), 16) + 1; }

export type BaseWireOrderSource = { code: string; names: string[] };
export type BaseWireShipment = { id: string; public_id: number; tracking_number: string; mode: string; carrier: string };
export type BaseWireNativePackage = { id: string; public_id: number; tracking_number: string };
/** One stored native tracking event (shipments.tracking_data.tracking_details). */
export type BaseWireTrackingEvent = { at: string; status: string|null; code: string|null };
/** The InPost/DPD shipping plan that created the shipment (shipping_plans.input/selected_offer). */
export type BaseWirePackagePlan = { provider: 'inpost'|'dpd'|'dhl'|'pocztapolska'; service: string|null; template: string|null; weight: number|null;
  dimensions: { length: number; width: number; height: number; unit: 'mm'|'cm' }|null; insurance_minor: number;
  cost: { minor: number; currency: string }|null };
/** Own native shipment with the native rows that describe its parcel and tracking. */
export type BaseWirePackageRecord = BaseWireShipment & { external_id: string|null; status: string; status_at: string;
  cod_minor: number; currency: string; events: BaseWireTrackingEvent[]; plan: BaseWirePackagePlan|null;
  /** createPackage parcel recorded in base_wire.package.created of the shipment's own transaction. */
  recorded: { weight: number; size_length?: number; size_width?: number; size_height?: number }|null };
/** One native port per transaction; every lookup is the current tenant only. */
export type BaseWireFulfillmentNative = {
  /** Own order UUID for a numeric order_id (220), or null. */
  order(publicId: number): Promise<string|null>;
  /** Native order-source channels grouped by provider, plus B2B when the company has B2B accounts. */
  sources(): Promise<BaseWireOrderSource[]>;
  /** Native picking-wave preview + create (POST /api/picking-waves) for these own orders. */
  createPickList(orderIds: string[]): Promise<string>;
  /** Another wave of the company maps to the same derived pick_list_id. */
  pickListTaken(waveId: string, key: string): Promise<boolean>;
  /** Native shipDemo (POST /api/orders/:id/ship-demo); returns the one shipment it created. */
  shipDemo(orderId: string): Promise<BaseWireNativePackage>;
  /** Base package data without a native column, recorded in the audit trail. */
  recordPackage(shipmentId: string, detail: Record<string, BaseWireJson>): Promise<void>;
  /** Own shipments by numeric package_id and/or tracking number. */
  shipments(by: { public_id?: number; number?: string }): Promise<BaseWireShipment[]>;
  /** Own order UUID for a numeric order_id under the getOrders operational predicate
   * (a merged source order is hidden), or null. */
  operationalOrder(publicId: number): Promise<string|null>;
  /** Own operational shipments of one order, or by package_ids; ordered by package_id. */
  packages(by: { order_id: string } | { public_ids: number[] }): Promise<BaseWirePackageRecord[]>;
  /** Providers (inpost, dpd) with at least one native shipping channel (GET /api/shipping/channels). */
  courierChannels(): Promise<string[]>;
  /** Native demo label page (same bytes as GET /api/shipments/:id/label). */
  demoLabel(shipmentId: string): Promise<string>;
  replay(clientKey: string, requestHash: string): Promise<Record<string, BaseWireJson>|null>;
  remember(clientKey: string, response: Record<string, BaseWireJson>): Promise<void>;
};
export type BaseWireFulfillmentPorts = {
  transaction<T>(actor: Actor, writing: boolean, work: (c: PoolClient) => Promise<T>): Promise<T>;
  native(c: PoolClient, actor: Actor): BaseWireFulfillmentNative;
  /** Stored DPD label PDF (cachedDpdLabel); never a provider request. */
  dpdLabel(tenantId: string, shipmentId: string): Promise<Buffer>;
  /** Stored DHL / Poczta Polska label PDF (plan result); never a provider request. */
  carrierLabel?(tenantId: string, shipmentId: string, courier: 'dhl'|'pocztapolska'): Promise<Buffer>;
};

const id = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const looseId = z.union([z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), z.literal(''), z.string().regex(/^(0|[1-9][0-9]{0,15})$/).transform(Number)])
  .transform(v => v === '' ? 0 : v);
// Base examples send dimensions as numbers and as numeric text (COURIER-DOC-008).
const measure = z.union([z.number(), z.string().regex(/^[0-9]{1,6}(\.[0-9]{1,3})?$/).transform(Number)]).pipe(z.number().min(0).max(100000));
const sourcesInput = z.object({}).strict();
const pickListInput = z.object({
  order_ids: z.array(id).min(1).max(100).refine(ids => new Set(ids).size === ids.length, 'Zamówienia nie mogą się powtarzać'),
}).strict();
// LOCAL package_fields of the demo courier (no getCourierFields locally): weight in kg
// (required, > 0) and size_* in cm. Other keys are refused, never dropped.
const packageInput = z.object({ weight: measure.refine(v => v > 0, 'Podaj wagę paczki'),
  size_length: measure.optional(), size_width: measure.optional(), size_height: measure.optional() }).strict();
const packageCreateInput = z.object({
  order_id: id, courier_code: z.string().trim().min(1).max(20), account_id: looseId.optional(),
  fields: z.array(z.object({ id: z.string().max(50), value: z.union([z.string().max(2000), z.number()]) }).strict()).max(100).optional(),
  packages: z.array(z.unknown()).min(1).max(100),
}).strict();
const orderPackagesInput = z.object({ order_id: id }).strict();
const packageDetailsInput = z.object({ package_id: id }).strict();
const historyInput = z.object({
  package_ids: z.array(id).min(1).max(100).refine(ids => new Set(ids).size === ids.length, 'Przesyłki nie mogą się powtarzać'),
}).strict();
const couriersInput = z.object({}).strict();
const labelInput = z.object({
  courier_code: z.string().trim().min(1).max(20), package_id: id.optional(), package_number: z.string().trim().min(1).max(40).optional(),
}).strict().refine(v => v.package_id !== undefined || v.package_number !== undefined, 'Podaj package_id albo package_number');
/** LOCAL: one personal source with key 0, like getOrders (order_source_id is always 0). */
const PERSONAL = 'Osobiście / telefonicznie';
const courierOf = (s: BaseWireShipment) => s.mode === 'demo' ? BASE_WIRE_DEMO_COURIER : Object.keys(COURIER_NAMES).find(code => code !== BASE_WIRE_DEMO_COURIER && COURIER_NAMES[code] === s.carrier) ?? null;
function local(status: number, message: string, code: string): never { throw new Problem(status, message, code); }
function seconds(at: string) {
  const ms = Date.parse(at);
  ensure(Number.isFinite(ms), 503, 'Niespójna data trackingu przesyłki');
  return Math.floor(ms / 1000);
}
const major = (minor: number) => Math.round(minor) / 100;
/** Base packages[] entry of a native shipment (getOrderPackages). */
function packageEntry(p: BaseWirePackageRecord): Record<string, BaseWireJson> {
  const code = courierOf(p);
  return { package_id: p.public_id, courier_package_nr: p.tracking_number,
    // LOCAL: the provider's own shipment id (InPost) when it differs from the tracking number.
    courier_inner_number: p.external_id && p.external_id !== p.tracking_number ? p.external_id : '',
    courier_code: code ?? '', courier_other_name: code ? '' : p.carrier.slice(0, 20),
    // LOCAL: courier accounts (channels) have no Base numeric identity; createPackage accepts 0 only.
    account_id: 0, tracking_status_date: seconds(p.status_at),
    // LOCAL: no native delivery-days count (weekend/holiday rules undocumented).
    tracking_delivery_days: 0, tracking_status: baseWireTrackingStatus(p.status),
    // LOCAL: native shipments are outbound dispatches; returns are return cases, not shipments.
    package_type: 0, tracking_url: '', is_return: false };
}
/** Base package_details[] entry: only values a native column/record holds; the rest ''/0. */
function packageDetail(p: BaseWirePackageRecord): Record<string, BaseWireJson> {
  const plan = p.plan, recorded = p.recorded;
  const cm = (v: number) => plan?.dimensions?.unit === 'mm' ? v / 10 : v;
  const size = plan ? (plan.dimensions ? { length: cm(plan.dimensions.length), width: cm(plan.dimensions.width), height: cm(plan.dimensions.height) } : null)
    : recorded && (recorded.size_length !== undefined || recorded.size_width !== undefined || recorded.size_height !== undefined)
      ? { length: recorded.size_length ?? 0, width: recorded.size_width ?? 0, height: recorded.size_height ?? 0 } : null;
  const weight = plan ? plan.weight : recorded?.weight ?? null;
  return { weight: weight ?? 0, weight_unit: weight === null ? '' : 'kg',
    length: size?.length ?? 0, width: size?.width ?? 0, height: size?.height ?? 0, size_unit: size ? 'cm' : '',
    size_template: plan?.template ?? '', is_custom: size !== null,
    cod_value: major(p.cod_minor), cod_currency: p.currency,
    // InPost/DPD plans send insurance in PLN; the demo courier has none.
    insurance_value: major(plan?.insurance_minor ?? 0), insurance_currency: plan ? 'PLN' : '',
    cost_value: plan?.cost ? major(plan.cost.minor) : 0, cost_currency: plan?.cost?.currency ?? '',
    type: '', pickup_date: 0, service: plan?.service ?? '', additional_services: [], courier_packaging_type: '' };
}

export function createBaseWireFulfillmentService(ports: BaseWireFulfillmentPorts) {
  const tx = <T>(actor: Actor, writing: boolean, work: (n: BaseWireFulfillmentNative) => Promise<T>) =>
    ports.transaction(actor, writing, c => work(ports.native(c, actor)));
  const hash = (actor: Actor, selected: Method, parameters: Record<string, BaseWireJson>) =>
    createHash('sha256').update(JSON.stringify({ api_key_id: actor.apiKeyId, method: selected, parameters })).digest('hex');
  function writer(actor: Actor, options: { clientKey?: string }) {
    ensure(actor.source === 'api' && !!actor.apiKeyId, 503, 'Brak klucza API');
    // Same role gate as the native shipping routes (admin/operator).
    ensure(actor.role === 'admin' || actor.role === 'operator', 403, 'Konto ma uprawnienia tylko do odczytu');
    return options.clientKey === undefined ? undefined : z.uuid().parse(options.clientKey);
  }
  /** Replay inside the effect's transaction; the response is stored before COMMIT. */
  function once(actor: Actor, selected: Method, parameters: Record<string, BaseWireJson>, clientKey: string|undefined,
    work: (n: BaseWireFulfillmentNative) => Promise<Record<string, BaseWireJson>>) {
    const requestHash = hash(actor, selected, parameters);
    return tx(actor, true, async n => {
      if (clientKey) { const retained = await n.replay(clientKey, requestHash); if (retained) return retained; }
      const response = await work(n);
      if (clientKey) await n.remember(clientKey, response);
      return response;
    });
  }
  async function pickList(actor: Actor, parameters: Record<string, BaseWireJson>, options: { clientKey?: string }) {
    const b = pickListInput.parse(parameters);
    const clientKey = writer(actor, options);
    return once(actor, 'addOrderPickList', parameters, clientKey, async n => {
      const orders: string[] = [];
      for (const publicId of b.order_ids) {
        const order = await n.order(publicId);
        ensure(order, 404, 'Nie znaleziono zamówienia');
        orders.push(order);
      }
      // Native rules decide: one warehouse, eligible status, reservations, no open wave.
      const wave = await n.createPickList(orders);
      if (await n.pickListTaken(wave, baseWirePickListKey(wave))) local(503, 'Kolizja identyfikatora listy Base', 'LOCAL_BASE_WIRE_PICK_LIST_ID');
      return { pick_list_id: baseWirePickListId(wave) };
    });
  }
  async function createPackage(actor: Actor, parameters: Record<string, BaseWireJson>, options: { clientKey?: string }) {
    const b = packageCreateInput.parse(parameters);
    // LOCAL: InPost/DPD natively create a quoted/queued plan finished by a worker; there
    // is no package to return synchronously, so nothing is queued and nothing is claimed.
    if (ASYNC_COURIERS.includes(b.courier_code))
      local(422, 'Przesyłkę tego kuriera utwórz w natywnym procesie wysyłki', 'LOCAL_BASE_WIRE_COURIER_ASYNC');
    ensure(b.courier_code === BASE_WIRE_DEMO_COURIER, 404, 'Nie znaleziono kuriera');
    ensure(!b.account_id, 404, 'Nie znaleziono konta kuriera');
    // LOCAL: the demo courier has no form fields and one parcel per whole order.
    if (b.fields?.length) local(422, 'Pole nie jest obsługiwane lokalnie', 'LOCAL_BASE_WIRE_UNSUPPORTED_FIELD');
    if (b.packages.length !== 1) local(422, 'Kurier lokalny tworzy jedną paczkę na zamówienie', 'LOCAL_BASE_WIRE_UNSUPPORTED_FIELD');
    const parcel = packageInput.parse(b.packages[0]);
    const clientKey = writer(actor, options);
    return once(actor, 'createPackage', parameters, clientKey, async n => {
      const order = await n.order(b.order_id);
      ensure(order, 404, 'Nie znaleziono zamówienia');
      // Native shipDemo: packed order, stock consumption, shipment row (220 package_id trigger), status shipped.
      const shipment = await n.shipDemo(order);
      await n.recordPackage(shipment.id, { courier_code: b.courier_code, packages: [parcel] });
      const pkg = { package_id: shipment.public_id, package_number: shipment.tracking_number, courier_inner_number: '' };
      return { ...pkg, packages: [pkg] };
    });
  }
  async function label(actor: Actor, parameters: Record<string, BaseWireJson>) {
    const b = labelInput.parse(parameters);
    // Same transaction kind as GET /api/shipments/:id/label (effective delivery address).
    const found = await tx(actor, true, async n => {
      const rows = await n.shipments({ public_id: b.package_id, number: b.package_number });
      // LOCAL: with both selectors they must name the same shipment; a number shared by
      // several own shipments of the courier is ambiguous.
      const own = rows.filter(s => courierOf(s) === b.courier_code);
      ensure(own.length > 0, 404, 'Nie znaleziono przesyłki');
      ensure(own.length === 1, 409, 'Numer przesyłki wskazuje kilka przesyłek; użyj package_id');
      const s = own[0];
      return s.mode === 'demo' ? { s, html: await n.demoLabel(s.id) } : { s, html: null };
    });
    if (found.html !== null) return { extension: 'html', label: Buffer.from(found.html, 'utf8').toString('base64') };
    const courier = courierOf(found.s);
    if (courier === 'dpd') return { extension: 'pdf', label: (await ports.dpdLabel(actor.tenantId, found.s.id)).toString('base64') };
    if ((courier === 'dhl' || courier === 'pocztapolska') && ports.carrierLabel && STORED_LABEL_COURIERS.includes(courier))
      return { extension: 'pdf', label: (await ports.carrierLabel(actor.tenantId, found.s.id, courier)).toString('base64') };
    // LOCAL: the InPost label is a provider request in the native route; it is not issued from connector.php.
    return local(422, 'Etykietę tego kuriera pobierz w panelu', 'LOCAL_BASE_WIRE_LABEL_PROVIDER');
  }
  async function orderPackages(actor: Actor, parameters: Record<string, BaseWireJson>) {
    const b = orderPackagesInput.parse(parameters);
    return tx(actor, false, async n => {
      const order = await n.operationalOrder(b.order_id);
      ensure(order, 404, 'Nie znaleziono zamówienia');
      return { packages: (await n.packages({ order_id: order })).map(packageEntry) };
    });
  }
  async function ownPackages(n: BaseWireFulfillmentNative, ids: number[]) {
    const rows = await n.packages({ public_ids: ids });
    // All-or-nothing: an unknown or foreign package_id refuses the whole read.
    ensure(rows.length === ids.length && ids.every(i => rows.some(r => r.public_id === i)), 404, 'Nie znaleziono przesyłki');
    return rows;
  }
  async function packageDetails(actor: Actor, parameters: Record<string, BaseWireJson>) {
    const b = packageDetailsInput.parse(parameters);
    return tx(actor, false, async n => {
      const [p] = await ownPackages(n, [b.package_id]);
      // LOCAL: one native shipment is one parcel; no courier-specific additional fields.
      return { package_details: [packageDetail(p)], additional_fields: [] };
    });
  }
  async function history(actor: Actor, parameters: Record<string, BaseWireJson>) {
    const b = historyInput.parse(parameters);
    return tx(actor, false, async n => {
      const rows = await ownPackages(n, b.package_ids);
      const out: Record<string, BaseWireJson> = {};
      for (const i of b.package_ids) {
        const p = rows.find(r => r.public_id === i)!;
        // Stored native events only (no provider request), oldest first; stable for equal dates.
        out[String(i)] = p.events.map(e => ({ e, at: seconds(e.at) })).sort((x, y) => x.at - y.at)
          .map(({ e, at }) => ({ tracking_status_date: at, courier_status_code: (e.code ?? e.status ?? '').slice(0, 100), tracking_status: baseWireTrackingStatus(e.status) }));
      }
      return { packages_history: out };
    });
  }
  async function couriers(actor: Actor, parameters: Record<string, BaseWireJson>) {
    couriersInput.parse(parameters);
    return tx(actor, false, async n => {
      // LOCAL: the local simulator always; DPD/InPost/DHL/Poczta Polska when the company has a native shipping channel.
      const configured = new Set(await n.courierChannels());
      return { couriers: [BASE_WIRE_DEMO_COURIER, ...ASYNC_COURIERS.filter(c => configured.has(c)).sort()].map(code => ({ code, name: COURIER_NAMES[code] })) };
    });
  }
  async function sources(actor: Actor, parameters: Record<string, BaseWireJson>) {
    sourcesInput.parse(parameters);
    return tx(actor, false, async n => {
      const out: Record<string, BaseWireJson> = { personal: { '0': PERSONAL } };
      for (const s of await n.sources()) out[s.code] = { '0': s.names.length ? s.names.join(', ') : s.code };
      return { sources: out };
    });
  }
  return {
    async execute(actor: Actor, selected: string, parameters: Record<string, BaseWireJson>, options: { clientKey?: string; credential?: string } = {}): Promise<Record<string, BaseWireJson>> {
      method(selected);
      if (selected === 'addOrderPickList') return pickList(actor, parameters, options);
      if (selected === 'createPackage') return createPackage(actor, parameters, options);
      if (selected === 'getLabel') return label(actor, parameters);
      if (selected === 'getOrderPackages') return orderPackages(actor, parameters);
      if (selected === 'getPackageDetails') return packageDetails(actor, parameters);
      if (selected === 'getCourierPackagesStatusHistory') return history(actor, parameters);
      if (selected === 'getCouriersList') return couriers(actor, parameters);
      return sources(actor, parameters);
    },
  };
}
export type BaseWireFulfillmentService = ReturnType<typeof createBaseWireFulfillmentService>;

/** Fourth connector.php family. Only startup capability selects availability;
 * pick lists additionally need the native picking-wave tables. */
export function createBaseWireFulfillmentFamily(opts: { service: Pick<BaseWireFulfillmentService, 'execute'>; available: boolean; pickListsAvailable: boolean }): BaseWireFamily {
  const pickLists = opts.pickListsAvailable === true;
  return Object.freeze({ label: 'realizacji', methods: BASE_WIRE_FULFILLMENT_METHODS, scope: baseWireFulfillmentScope, isWrite: isBaseWireFulfillmentWrite,
    available: opts.available === true, service: opts.service,
    admit(selected: string) { method(selected); ensure(selected !== 'addOrderPickList' || pickLists, 503, 'Listy kompletacji są niedostępne'); } });
}
