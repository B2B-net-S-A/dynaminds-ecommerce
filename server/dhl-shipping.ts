import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { tenantTx } from './db';
import { ensure } from './errors';
import { assertB2bDropshipParcelReceiverInTx } from './b2b-dropship-guards';
import type { IntegrationContext } from './channel-access';
import { Dhl, dhlConnection, dhlPdf, dhlReference, parseDhlInput, type DhlCreated, type DhlIdempotencyStore } from './carrier-dhl';
import { packingShippingBindingInput, packingShippingSnapshotInTx } from './packing-shipping-binding';
import type { PackingActor } from './packing-workstation-schema';
import {
  carrierPreviewScope,
  insertCarrierPlan,
  processCarrier,
  registerCarrierRoutes,
  cachedCarrierLabel,
  type CarrierPlanPort,
  type CarrierSpec,
} from './carrier-shipping';

// DHL Parcel Polska (WebAPI2) wiring of the pure client server/carrier-dhl.ts.
export const DHL_SPEC: CarrierSpec = {
  provider: 'dhl',
  label: 'DHL',
  demoPrefix: 'DEMO-DHL-',
  connection: dhlConnection,
  pdf: dhlPdf,
  exampleSettings: { sap_account: '1234567' },
};
export async function previewDhl(a: PackingActor, orderId: string, body: unknown) {
  const raw = (body ?? {}) as Record<string, unknown>;
  const packing = packingShippingBindingInput.optional().parse(raw.packing);
  ensure(raw.packing_snapshot === undefined, 422, 'Nieprawidłowe dane przesyłki DHL');
  const shipment = parseDhlInput(body);
  const input = { ...shipment, ...(packing ? { packing } : {}) };
  return tenantTx(a.tenantId, async (c) => {
    const { ch, o } = await carrierPreviewScope(c, DHL_SPEC, orderId, input);
    ensure(/^\d{4,10}$/.test(ch.settings.sap_account ?? ''), 422, 'Wymagane połączenie DHL z numerem klienta SAP');
    const packingSnapshot = await packingShippingSnapshotInTx(c, a, o, input, 'dhl');
    const id = randomUUID();
    const { channel_id: _channel, ...data } = shipment;
    const payload = { reference: dhlReference(id), shipment: data };
    await assertB2bDropshipParcelReceiverInTx(c, o.id, { provider: 'dhl', receiver: shipment.receiver }, payload);
    return insertCarrierPlan(c, a, DHL_SPEC, { id, o, ch, input, payload, packingSnapshot });
  });
}
/** DhlIdempotencyStore backed by the plan row: ready → create_started → numbers_ready | rejected. */
function planStore(p: any, port: CarrierPlanPort): DhlIdempotencyStore {
  const key = 'shipment:' + p.id;
  const cod = p.input.cod
    ? { amount: p.input.cod, currency: 'PLN' as const, bank_account: String(p.input.cod_bank_account).replace(/[\s-]/g, '').replace(/^PL/i, '') }
    : null;
  return {
    async claim(k) {
      ensure(k === key, 409, 'Klucz przesyłki DHL nie należy do planu');
      const current = await port.current();
      if (current.phase === 'ready') {
        await port.update('create_started');
        return { state: 'new' };
      }
      if (current.phase === 'create_started') return { state: 'started' };
      ensure(current.phase === 'numbers_ready' && current.remote_id, 409, 'DHL odrzuciło dane paczki; anuluj plan i popraw dane');
      const done: DhlCreated = { waybill: current.remote_id, reference: p.payload.reference, trace_id: null, cod, replayed: false };
      return { state: 'done', result: done };
    },
    async finish(_k, result) {
      await port.update('numbers_ready', (result as DhlCreated).waybill);
    },
    async release() {
      await port.update('rejected');
    },
  };
}
export async function processDhl(job: any, ctx: IntegrationContext = {}) {
  return processCarrier(DHL_SPEC, job, ctx, async (client, p, port) => {
    ensure(client instanceof Dhl, 422, 'Wymagane DHL');
    const dhl = client.withStore(planStore(p, port));
    ensure(dhlReference(p.id) === p.payload.reference, 409, 'Referencja planu DHL zmieniła się');
    // A lost createShipments answer is resolved by the plan's reference (getMyShipments); never repeated.
    const created = await dhl.create({ ...p.payload.shipment, channel_id: p.channel_id }, p.id);
    const label = await dhl.labels(created.waybill, 'BLP');
    return {
      waybill: created.waybill,
      reference: created.reference,
      label_base64: label.label_base64,
      label_type: label.label_type,
      trace_id: created.trace_id,
      cod: created.cod,
      reconciled: created.replayed,
    };
  });
}
export const cachedDhlLabel = (tenant: string, shipment: string) =>
  cachedCarrierLabel(tenant, shipment, 'dhl', dhlPdf);
export function registerDhlShippingRoutes(app: FastifyInstance) {
  registerCarrierRoutes(app, DHL_SPEC, previewDhl);
}
