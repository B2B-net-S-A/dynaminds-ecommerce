import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { tenantTx } from './db';
import { ensure, Problem } from './errors';
import { assertB2bDropshipParcelReceiverInTx } from './b2b-dropship-guards';
import type { IntegrationContext } from './channel-access';
import { PocztaPolska } from './carrier-pocztapolska';
import {
  pocztaPolskaBodyHash,
  pocztaPolskaConnection,
  pocztaPolskaInput,
  pocztaPolskaPdf,
  pocztaPolskaShipment,
  type PocztaPolskaShipment,
} from './carrier-pocztapolska-values';
import {
  createPocztaPolskaShipment,
  type PocztaPolskaCreateRecord,
  type PocztaPolskaCreateState,
  type PocztaPolskaJournal,
} from './carrier-pocztapolska-shipments';
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

// Poczta Polska (eNadawca) wiring of the pure client server/carrier-pocztapolska*.ts.
export const POCZTAPOLSKA_SPEC: CarrierSpec = {
  provider: 'pocztapolska',
  label: 'Poczta Polska',
  demoPrefix: 'DEMO-PP-',
  connection: pocztaPolskaConnection,
  pdf: pocztaPolskaPdf,
  exampleSettings: { urzad_nadania: '123456' },
};
export async function previewPocztaPolska(a: PackingActor, orderId: string, body: unknown) {
  const raw = (body ?? {}) as Record<string, unknown>;
  const packing = packingShippingBindingInput.optional().parse(raw.packing);
  ensure(raw.packing_snapshot === undefined, 422, 'Nieprawidłowe dane przesyłki Poczty Polskiej');
  const parsed = pocztaPolskaInput.safeParse(body);
  if (!parsed.success)
    throw new Problem(422, 'Nieprawidłowe dane przesyłki Poczty Polskiej: ' + parsed.error.issues[0].message, 'PP_VALIDATION');
  const input = { ...parsed.data, ...(packing ? { packing } : {}) };
  return tenantTx(a.tenantId, async (c) => {
    const { ch, o } = await carrierPreviewScope(c, POCZTAPOLSKA_SPEC, orderId, input);
    ensure(/^[1-9]\d{0,9}$/.test(ch.settings.urzad_nadania ?? ''), 422, 'Wymagane połączenie Poczty Polskiej z urzędem nadania');
    const packingSnapshot = await packingShippingSnapshotInTx(c, a, o, input, 'pocztapolska');
    const id = randomUUID();
    const payload = pocztaPolskaShipment(id, parsed.data);
    await assertB2bDropshipParcelReceiverInTx(
      c,
      o.id,
      { provider: 'pocztapolska', service: parsed.data.service, receiver: parsed.data.receiver },
      payload,
    );
    return insertCarrierPlan(c, a, POCZTAPOLSKA_SPEC, { id, o, ch, input, payload, packingSnapshot });
  });
}
// Journal states ↔ plan phases. 'uncertain' stays create_started: both are resolved by reading the
// buffer by guid, never by a second addShipment. 'absent' needs an operator decision (new plan).
const PHASE: Record<PocztaPolskaCreateState, string> = {
  started: 'create_started',
  uncertain: 'create_started',
  created: 'numbers_ready',
  rejected: 'rejected',
  absent: 'absent',
};
const STATE: Record<string, PocztaPolskaCreateState> = {
  create_started: 'started',
  numbers_ready: 'created',
  rejected: 'rejected',
  absent: 'absent',
};
function planJournal(p: any, port: CarrierPlanPort): PocztaPolskaJournal {
  const shipment = p.payload as PocztaPolskaShipment;
  const body_hash = pocztaPolskaBodyHash(shipment);
  const read = async () => {
    const current = await port.current();
    return { current, state: STATE[current.phase] as PocztaPolskaCreateState | undefined };
  };
  const same = (a: PocztaPolskaCreateState | undefined, b: PocztaPolskaCreateState) =>
    a !== undefined && PHASE[a] === PHASE[b];
  return {
    async get(key) {
      ensure(key === shipment.guid, 409, 'Identyfikator przesyłki nie należy do planu');
      const { current, state } = await read();
      if (!state) return undefined;
      return {
        key,
        body_hash,
        state,
        tracking_number: state === 'created' ? current.remote_id : null,
        error: current.error ?? null,
      } satisfies PocztaPolskaCreateRecord;
    },
    async insert(rec) {
      const { current } = await read();
      if (rec.key !== shipment.guid || current.phase !== 'ready') return false;
      await port.update('create_started');
      return true;
    },
    async replace(key, from, rec) {
      const { state } = await read();
      if (key !== shipment.guid || !same(state, from)) return false;
      await port.update(PHASE[rec.state], rec.state === 'created' ? rec.tracking_number : null);
      return true;
    },
  };
}
export async function processPocztaPolska(job: any, ctx: IntegrationContext = {}) {
  return processCarrier(POCZTAPOLSKA_SPEC, job, ctx, async (client, p, port) => {
    ensure(client instanceof PocztaPolska, 422, 'Wymagana Poczta Polska');
    const shipment = p.payload as PocztaPolskaShipment;
    ensure(
      pocztaPolskaBodyHash(pocztaPolskaShipment(p.id, p.input)) === pocztaPolskaBodyHash(shipment),
      409,
      'Dane przesyłki Poczty Polskiej różnią się od zatwierdzonego planu',
    );
    // A lost addShipment answer is resolved by reading the buffer by guid; never repeated.
    const created = await createPocztaPolskaShipment(client, shipment, planJournal(p, port));
    const label = await client.labels(created.guid);
    return {
      waybill: created.tracking_number,
      guid: created.guid,
      label_base64: label.label_base64,
      trace_id: null,
      cod: shipment.pobranie
        ? { amount: shipment.pobranie.kwotaPobrania, currency: 'PLN', bank_account: shipment.pobranie.nrb }
        : null,
      reconciled: created.replayed,
    };
  });
}
export const cachedPocztaPolskaLabel = (tenant: string, shipment: string) =>
  cachedCarrierLabel(tenant, shipment, 'pocztapolska', pocztaPolskaPdf);
export function registerPocztaPolskaShippingRoutes(app: FastifyInstance) {
  registerCarrierRoutes(app, POCZTAPOLSKA_SPEC, previewPocztaPolska);
}
