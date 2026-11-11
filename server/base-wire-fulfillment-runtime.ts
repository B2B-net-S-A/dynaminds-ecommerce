/** Native port of the Base fulfillment family: 220 sidecars + the existing
 * channels, picking waves (previewWave/createWave), shipDemo, shipments with their
 * shipping plans and stored tracking, and shipment labels. */
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { audit, shipDemo, type Actor } from './domain';
import { ensure } from './errors';
import { tenantTx, tenantReadTx } from './db';
import { parseBaseWireId } from './base-wire-codec';
import { createBaseWireOrdersNative } from './base-wire-orders-runtime';
import { createWave, previewWave } from './picking-waves';
import { cachedDpdLabel } from './dpd-shipping';
import { cachedDhlLabel } from './dhl-shipping';
import { cachedPocztaPolskaLabel } from './pocztapolska-shipping';
import { createBaseWireFulfillmentService, type BaseWireFulfillmentNative, type BaseWirePackagePlan } from './base-wire-fulfillment';

function publicNumber(raw: unknown): number {
  ensure(typeof raw === 'string' && /^[1-9][0-9]*$/.test(raw) && BigInt(raw) <= BigInt(Number.MAX_SAFE_INTEGER), 503, 'Brak trwałej tożsamości Base; wymagany poprawny bootstrap 220');
  return parseBaseWireId(Number(raw), false);
}
/** Native channel providers that are order sources (orderSchema.source), as getOrders returns them. */
const ORDER_SOURCE_PROVIDERS = ['allegro', 'woocommerce', 'prestashop', 'shopify', 'odoo', 'ebay', 'amazon', 'mirakl'];
/** LOCAL: Base sends no pick-list name; the native wave requires one. */
const PICK_LIST_NAME = 'Lista Base API';
const WAVE_KEY = "substr(replace(id::text,'-',''),1,12)||substr(replace(id::text,'-',''),14,1)";

export type BaseWireDemoLabel = (c: PoolClient, tenantId: string, shipmentId: string) => Promise<string>;
const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? v : null;
const iso = (v: unknown) => v instanceof Date ? v.toISOString() : String(v);
/** shipping_plans.input as written by previewShipping (InPost: dimensions in mm, sent only for the
 * courier service; the locker service sends the template) and previewDpdShipping (cm). */
function planOf(input: any, offer: any): BaseWirePackagePlan|null {
  if (!input || typeof input !== 'object') return null;
  const provider = (['dpd', 'dhl', 'pocztapolska'] as const).find(p => p === input.provider) ?? 'inpost' as const, locker = provider === 'inpost' && input.service === 'inpost_locker_standard';
  const d = input.dimensions, length = num(d?.length), width = num(d?.width), height = num(d?.height);
  return { provider, service: provider === 'inpost' && typeof input.service === 'string' ? input.service : null,
    template: locker && typeof input.template === 'string' ? input.template : null, weight: num(input.weight),
    dimensions: !locker && length !== null && width !== null && height !== null ? { length, width, height, unit: provider === 'inpost' ? 'mm' : 'cm' } : null,
    insurance_minor: Number.isSafeInteger(input.insurance) ? input.insurance : 0,
    cost: offer && Number.isSafeInteger(offer.rate) ? { minor: offer.rate, currency: typeof offer.currency === 'string' ? offer.currency : 'PLN' } : null };
}
function recordedOf(detail: any) {
  const p = detail?.packages?.[0], weight = num(p?.weight);
  if (weight === null) return null;
  const out: { weight: number; size_length?: number; size_width?: number; size_height?: number } = { weight };
  for (const k of ['size_length', 'size_width', 'size_height'] as const) { const v = num(p[k]); if (v !== null) out[k] = v; }
  return out;
}

export function createBaseWireFulfillmentNative(c: PoolClient, actor: Actor, opts: { demoLabel: BaseWireDemoLabel; mergeClaims?: boolean }): BaseWireFulfillmentNative {
  // Only order(), replay() and remember() are used: no merge-aware order list here.
  const orders = createBaseWireOrdersNative(c, actor, { mergeClaims: false });
  // Same operational predicate as getOrders / GET /api/orders: merged source orders are hidden.
  const operational = opts.mergeClaims === true ? 'AND NOT EXISTS(SELECT 1 FROM order_merge_claims m WHERE m.tenant_id=o.tenant_id AND m.source_order_id=o.id)' : '';
  return {
    order: publicId => orders.order(publicId),
    async sources() {
      const rows = (await c.query(`SELECT provider,array_agg(name ORDER BY name,id) AS names FROM channels
        WHERE tenant_id=$1 AND provider=ANY($2::text[]) GROUP BY provider ORDER BY provider`, [actor.tenantId, ORDER_SOURCE_PROVIDERS])).rows;
      const out = rows.map(r => ({ code: r.provider as string, names: r.names as string[] }));
      if ((await c.query('SELECT 1 FROM b2b_accounts WHERE tenant_id=$1 LIMIT 1', [actor.tenantId])).rowCount) out.push({ code: 'b2b', names: ['B2B'] });
      return out;
    },
    async createPickList(orderIds) {
      const head = (await c.query('SELECT warehouse_id FROM orders WHERE tenant_id=$1 AND id=$2', [actor.tenantId, orderIds[0]])).rows[0];
      ensure(head, 404, 'Nie znaleziono zamówienia');
      // Same preview + optimistic hash as the UI (POST /api/picking-waves/preview, then POST /api/picking-waves).
      const selection = { warehouse_id: head.warehouse_id as string, order_ids: orderIds };
      const preview = await previewWave(c, actor, selection);
      const wave = await createWave(c, actor, { ...selection, name: PICK_LIST_NAME, preview_hash: preview.preview_hash, client_key: randomUUID() });
      return wave.wave.id as string;
    },
    async pickListTaken(waveId, key) {
      return !!(await c.query(`SELECT 1 FROM picking_waves WHERE tenant_id=$1 AND id<>$2 AND ${WAVE_KEY}=$3 LIMIT 1`, [actor.tenantId, waveId, key])).rowCount;
    },
    async shipDemo(orderId) {
      await shipDemo(c, actor, orderId);
      // shipDemo refuses an order that already has a shipment, so exactly one exists now.
      const rows = (await c.query(`SELECT s.id,s.tracking_number,p.public_id::text AS public_id FROM shipments s
        LEFT JOIN base_wire220_package_ids p ON(p.tenant_id,p.local_id)=(s.tenant_id,s.id) WHERE s.tenant_id=$1 AND s.order_id=$2`, [actor.tenantId, orderId])).rows;
      ensure(rows.length === 1, 503, 'Niespójna przesyłka zamówienia');
      return { id: rows[0].id, public_id: publicNumber(rows[0].public_id), tracking_number: rows[0].tracking_number };
    },
    async recordPackage(shipmentId, detail) { await audit(c, actor, 'base_wire.package.created', shipmentId, detail); },
    async shipments(by) {
      const rows = (await c.query(`SELECT s.id,p.public_id::text AS public_id,s.tracking_number,s.mode,s.carrier FROM base_wire220_package_ids p
        JOIN shipments s ON(s.tenant_id,s.id)=(p.tenant_id,p.local_id)
        WHERE p.tenant_id=$1 AND ($2::bigint IS NULL OR p.public_id=$2) AND ($3::text IS NULL OR s.tracking_number=$3) ORDER BY p.public_id LIMIT 100`,
      [actor.tenantId, by.public_id ?? null, by.number ?? null])).rows;
      return rows.map(r => ({ id: r.id, public_id: publicNumber(r.public_id), tracking_number: r.tracking_number, mode: r.mode, carrier: r.carrier }));
    },
    async operationalOrder(publicId) {
      const rows = (await c.query(`SELECT o.id FROM base_wire220_order_ids s JOIN orders o ON(o.tenant_id,o.id)=(s.tenant_id,s.local_id)
        WHERE s.tenant_id=$1 AND s.public_id=$2::bigint ${operational}`, [actor.tenantId, publicId])).rows;
      ensure(rows.length <= 1, 503, 'Niespójna mapa zamówień Base');
      return rows[0]?.id ?? null;
    },
    async packages(by) {
      const orderId = 'order_id' in by ? by.order_id : null, ids = 'public_ids' in by ? by.public_ids : null;
      // The plan is the InPost/DPD shipping plan that created the shipment; the recorded parcel
      // is the createPackage audit written in the shipment's own transaction (same now()).
      const rows = (await c.query(`SELECT s.id,p.public_id::text AS public_id,s.tracking_number,s.mode,s.carrier,s.external_id,s.status,s.cod_expected,o.currency,
          coalesce((s.tracking_data->>'provider_updated_at')::timestamptz,s.tracking_at,s.created_at) AS status_at,
          coalesce(s.tracking_data->'tracking_details','[]'::jsonb) AS events,pl.input AS plan_input,pl.selected_offer AS plan_offer,
          (SELECT e.detail FROM audit_events e WHERE e.tenant_id=s.tenant_id AND e.created_at=s.created_at AND e.action='base_wire.package.created'
            AND e.entity_id=s.id ORDER BY e.id LIMIT 1) AS recorded
        FROM base_wire220_package_ids p JOIN shipments s ON(s.tenant_id,s.id)=(p.tenant_id,p.local_id)
        JOIN orders o ON(o.tenant_id,o.id)=(s.tenant_id,s.order_id)
        LEFT JOIN LATERAL(SELECT x.input,x.selected_offer FROM shipping_plans x WHERE x.tenant_id=s.tenant_id AND x.order_id=s.order_id AND x.shipment_id=s.id
          ORDER BY x.created_at DESC,x.id DESC LIMIT 1) pl ON true
        WHERE p.tenant_id=$1 AND ($2::uuid IS NULL OR s.order_id=$2) AND ($3::bigint[] IS NULL OR p.public_id=ANY($3::bigint[])) ${operational}
        ORDER BY p.public_id LIMIT 100`, [actor.tenantId, orderId, ids])).rows;
      return rows.map(r => ({ id: r.id, public_id: publicNumber(r.public_id), tracking_number: r.tracking_number, mode: r.mode, carrier: r.carrier,
        external_id: r.external_id, status: r.status, status_at: iso(r.status_at), cod_minor: Number(r.cod_expected), currency: r.currency,
        events: (Array.isArray(r.events) ? r.events : []).map((e: any) => ({ at: String(e?.datetime), status: typeof e?.status === 'string' ? e.status : null,
          code: typeof e?.code === 'string' ? e.code : null })),
        plan: planOf(r.plan_input, r.plan_offer), recorded: recordedOf(r.recorded) }));
    },
    async courierChannels() {
      return (await c.query("SELECT DISTINCT provider FROM channels WHERE tenant_id=$1 AND provider IN('inpost','dpd','dhl','pocztapolska') ORDER BY provider", [actor.tenantId])).rows.map(r => r.provider as string);
    },
    demoLabel: shipmentId => opts.demoLabel(c, actor.tenantId, shipmentId),
    replay: (clientKey, requestHash) => orders.replay(clientKey, requestHash),
    remember: (clientKey, response) => orders.remember(clientKey, response),
  };
}
export function createDefaultBaseWireFulfillmentService(opts: { demoLabel: BaseWireDemoLabel; mergeClaims?: boolean }) {
  return createBaseWireFulfillmentService({
    transaction: (actor, writing, work) => (writing ? tenantTx : tenantReadTx)(actor.tenantId, work),
    native: (c, actor) => createBaseWireFulfillmentNative(c, actor, opts),
    dpdLabel: (tenantId, shipmentId) => cachedDpdLabel(tenantId, shipmentId),
    carrierLabel: (tenantId, shipmentId, courier) => courier === 'dhl' ? cachedDhlLabel(tenantId, shipmentId) : cachedPocztaPolskaLabel(tenantId, shipmentId),
  });
}
