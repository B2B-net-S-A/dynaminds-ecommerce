import { automationOnlyEvent } from './automation-v2-triggers';
import { assertB2bDropshipDispatchInTx, assertB2bDropshipParcelReceiverInTx } from './b2b-dropship-guards';
import { consumeWholeOrderStockInTx, type WholeOrderIssueWriter } from './warehouse-automatic-wz-physical';
import { enlistWmsActorInTx } from './wms-lots-transaction';
import { enlistDispatchActorInTx } from './dispatch-transaction';
import { lockWarehouseInventoryPoliciesInTx } from './warehouse-inventory-policies';
import { prepareAutomaticWzInTx, finishAutomaticWzInTx } from './warehouse-wz-issuer';
import { randomUUID } from 'node:crypto';
import { assertNoOrderParcelPlanInTx } from './order-parcel-guards';
import pg, { type PoolClient } from 'pg';
import { holdingDbLock, lockDbClient } from './db-lock-holder';
import { z } from 'zod';
import { fulfillmentPayment } from './payments';
import { pool, tenantTx, localConfig } from './db';
import { deliveryBindingInTx } from './buyer-address';
import { ensure, Problem } from './errors';
import { newLabelTargetInTx, writeLabelShipmentInTx } from './shipment-cancelled';
import { CANCELLED_SHIPMENT } from './order-stage';
import { audit, event, getOrder, type Actor } from './domain';
import { loadChannel, channelRead, type IntegrationContext } from './channel-access';
import { InPost } from './integrations';
import { encrypt } from './security';
import type { PackingActor } from './packing-workstation-schema';
import {
  packingShippingBindingInput,
  packingShippingSnapshotInTx,
  assertPackingShippingPlanInTx,
  pinPackingShippingActorInTx,
  packingShippingJobActor,
} from './packing-shipping-binding';
const idNumber = z.string().regex(/^[1-9]\d{0,17}$/);
const phone = z
  .string()
  .trim()
  .regex(/^\+?[0-9]{9,15}$/);
const address = z.object({
  street: z.string().trim().min(1).max(100),
  building_number: z.string().trim().min(1).max(30),
  city: z.string().trim().min(1).max(100),
  post_code: z.string().regex(/^\d{2}-\d{3}$/),
  country_code: z.literal('PL').default('PL'),
});
const parcelDimensions = z.object({
  length: z.number().int().min(1).max(1200),
  width: z.number().int().min(1).max(1200),
  height: z.number().int().min(1).max(1200),
});
const parcelWeight = z.number().positive().max(25);
const perimeter = (d: z.infer<typeof parcelDimensions>) => d.length + d.width + d.height;
export const shippingInput = z
  .object({
    channel_id: z.uuid(),
    service: z.enum(['inpost_locker_standard', 'inpost_courier_standard']),
    receiver: z.object({
      first_name: z.string().trim().min(1).max(60),
      last_name: z.string().trim().min(1).max(60),
      email: z.email(),
      phone,
      address: address.optional(),
    }),
    target_point: z
      .string()
      .trim()
      .regex(/^[A-Z0-9_-]{3,30}$/)
      .optional(),
    template: z.enum(['small', 'medium', 'large']).default('small'),
    dimensions: parcelDimensions.optional(),
    weight: parcelWeight.default(1),
    // One ShipX courier shipment may carry several parcels; the first one is `dimensions`/`weight`.
    additional_parcels: z
      .array(z.object({ dimensions: parcelDimensions, weight: parcelWeight }))
      .max(9, 'Jedna przesyłka kurierska może mieć najwyżej 10 paczek')
      .default([]),
    cod: z.number().int().min(0).max(1000000).default(0),
    insurance: z.number().int().min(0).max(10000000).default(0),
    packing: packingShippingBindingInput.optional(),
    packing_snapshot: z.never().optional(),
  })
  .superRefine((b, c) => {
    if (b.service === 'inpost_locker_standard' && !b.target_point)
      c.addIssue({ code: 'custom', message: 'Wybierz punkt odbioru', path: ['target_point'] });
    if (b.service === 'inpost_courier_standard' && (!b.receiver.address || !b.dimensions))
      c.addIssue({
        code: 'custom',
        message: 'Kurier wymaga adresu i wymiarów paczki',
        path: ['receiver'],
      });
    if (b.dimensions && Object.values(b.dimensions).reduce((a, b) => a + b, 0) > 2200)
      c.addIssue({
        code: 'custom',
        message: 'Suma wymiarów nie może przekraczać 220 cm',
        path: ['dimensions'],
      });
    b.additional_parcels.forEach((x, i) => {
      if (perimeter(x.dimensions) > 2200)
        c.addIssue({
          code: 'custom',
          message: 'Suma wymiarów paczki ' + (i + 2) + ' nie może przekraczać 220 cm',
          path: ['additional_parcels', i, 'dimensions'],
        });
    });
    if (b.additional_parcels.length && b.service !== 'inpost_courier_standard')
      c.addIssue({
        code: 'custom',
        message: 'Paczkomat przyjmuje jedną paczkę; kilka paczek wyślij kurierem',
        path: ['additional_parcels'],
      });
    if (b.additional_parcels.length && b.packing)
      c.addIssue({
        code: 'custom',
        message: 'Pomiar ze stanowiska pakowania dotyczy jednej paczki; odłącz pomiar, aby dodać paczki',
        path: ['additional_parcels'],
      });
    if (b.cod > 0 && b.insurance < b.cod)
      c.addIssue({
        code: 'custom',
        message: 'Ubezpieczenie musi obejmować kwotę pobrania',
        path: ['insurance'],
      });
  });
function snapshot(o: any) {
  return {
    status: o.status,
    updated_at: new Date(o.updated_at).toISOString(),
    total: o.total,
    currency: o.currency,
    warehouse_id: o.warehouse_id,
    address: o.address,
    email: o.email,
    customer_name: o.customer_name,
  };
}
async function deliverySnapshot(c: PoolClient, o: any) {
  const binding = await deliveryBindingInTx(c, o.tenant_id, o.id, localConfig.encryptionKey);
  // Preserve old plans when there is no correction. A corrected receiver binds
  // new plans to the canonical address and revision, independently of billing.
  return { ...snapshot(o), ...(binding ? { buyer_delivery: binding } : {}) };
}
function same(a: any, b: any) {
  const normalize = (x: any): any =>
    Array.isArray(x)
      ? x.map(normalize)
      : x && typeof x === 'object'
        ? Object.fromEntries(
            Object.keys(x)
              .sort()
              .map((k) => [k, normalize(x[k])]),
          )
        : x;
  return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
}
export function rateMinor(rate: any) {
  if (rate === null || rate === undefined) return null;
  const s = String(rate);
  ensure(/^\d{1,7}(\.\d{1,2})?$/.test(s), 502, 'Nieprawidłowa cena oferty InPost');
  const [whole, fraction = ''] = s.split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
}
export async function shippingExample(actor: Actor) {
  return tenantTx(actor.tenantId, async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      'shipping-example:' + actor.tenantId,
    ]);
    const existing = (
      await c.query(
        "SELECT id FROM channels WHERE provider='inpost' AND settings->>'simulation'='true'",
      )
    ).rows[0];
    if (existing) return existing;
    const id = randomUUID();
    await c.query(
      "INSERT INTO channels(id,tenant_id,provider,name,mode,credentials,settings,status) VALUES($1,$2,'inpost','InPost — przykład lokalny','sandbox',$3,$4,'local_simulation')",
      [id, actor.tenantId, encrypt({}), JSON.stringify({ simulation: true, organization_id: '1' })],
    );
    await audit(c, actor, 'shipping.example', id);
    return { id };
  });
}
export async function previewShipping(
  actor: PackingActor,
  orderId: string,
  b: z.infer<typeof shippingInput>,
) {
  const ch = await loadChannel(actor.tenantId, b.channel_id);
  ensure(ch.provider === 'inpost', 422, 'Wymagane połączenie InPost');
  idNumber.parse(ch.settings.organization_id);
  return tenantTx(actor.tenantId, (c) => previewShippingInTx(c, actor, ch, orderId, b));
}
/** The preview on the caller's transaction (automation effects); `ch` is the plan's channel row. */
export async function previewShippingInTx(
  c: PoolClient,
  actor: PackingActor,
  ch: any,
  orderId: string,
  b: z.infer<typeof shippingInput>,
) {
  ensure(ch?.provider === 'inpost' && ch.id === b.channel_id, 422, 'Wymagane połączenie InPost');
  idNumber.parse(ch.settings.organization_id);
  {
    const o = (
      await c.query(`SELECT * FROM orders WHERE id=$1 ${b.packing ? 'FOR UPDATE' : 'FOR SHARE'}`, [
        orderId,
      ])
    ).rows[0];
    ensure(o, 404, 'Nie znaleziono zamówienia');
    ensure(o.status === 'packed', 409, 'Najpierw skompletuj i spakuj zamówienie');
    ensure(o.currency === 'PLN', 422, 'Przesyłki krajowe wymagają PLN');
    await fulfillmentPayment(c, o, b.cod);
    const packingSnapshot = await packingShippingSnapshotInTx(c, actor, o, b, 'inpost');
    const id = randomUUID(),
      payload = {
        receiver: b.receiver,
        parcels:
          b.service === 'inpost_locker_standard'
            ? [{ template: b.template, weight: { amount: b.weight, unit: 'kg' } }]
            : [{ dimensions: b.dimensions!, weight: b.weight }, ...b.additional_parcels].map((x) => ({
                dimensions: { ...x.dimensions, unit: 'mm' },
                weight: { amount: x.weight, unit: 'kg' },
                is_non_standard: false,
              })),
        custom_attributes: {
          sending_method: b.service === 'inpost_locker_standard' ? 'any_point' : 'dispatch_order',
          ...(b.target_point ? { target_point: b.target_point } : {}),
        },
        only_choice_of_offer: true,
        reference: 'DYNA-' + id,
        ...(b.cod ? { cod: { amount: b.cod / 100, currency: 'PLN' } } : {}),
        ...(b.insurance ? { insurance: { amount: b.insurance / 100, currency: 'PLN' } } : {}),
      };
    await assertB2bDropshipParcelReceiverInTx(c, o.id, b, payload);
    await c.query(
      'INSERT INTO shipping_plans(id,tenant_id,order_id,channel_id,actor_id,input,payload,order_snapshot) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [
        id,
        actor.tenantId,
        o.id,
        ch.id,
        actor.userId,
        JSON.stringify({ ...b, ...(packingSnapshot ? { packing_snapshot: packingSnapshot } : {}) }),
        JSON.stringify(payload),
        JSON.stringify(await deliverySnapshot(c, o)),
      ],
    );
    await audit(c, actor, 'shipping.preview', id, { mode: ch.mode });
    await pinPackingShippingActorInTx(c, actor, Boolean(packingSnapshot));
    return {
      id,
      payload,
      scope: ch.settings.simulation ? 'local_simulation' : 'external_pending',
      mode: ch.mode,
    };
  }
}
async function shippingWarehouseIds(c: PoolClient, orderId: string) {
  const head = (await c.query('SELECT warehouse_id FROM orders WHERE id=$1', [orderId])).rows[0];
  ensure(head, 404, 'Nie znaleziono zamówienia przesyłki');
  const holds = (await c.query<{warehouse_id:string}>(
    'SELECT DISTINCT warehouse_id FROM reservations WHERE order_id=$1 ORDER BY warehouse_id', [orderId],
  )).rows;
  return [...new Set([head.warehouse_id as string, ...holds.map(r => r.warehouse_id)])].sort();
}
export async function admitShippingWarehousesInTx(c: PoolClient, orderId: string) {
  const ids = await shippingWarehouseIds(c, orderId);
  await lockWarehouseInventoryPoliciesInTx(c, ids);
  return ids;
}
export async function lockedShipping(c: PoolClient, id: string) {
  const found = (await c.query('SELECT * FROM shipping_plans WHERE id=$1', [id])).rows[0];
  ensure(found, 404, 'Nie znaleziono planu przesyłki');
  // Configuration and warehouse policy writers take warehouse locks before
  // order/plan locks. Admit the same sorted own-scope set before this source lock.
  const warehouses = await admitShippingWarehousesInTx(c, found.order_id);
  const o = (await c.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE', [found.order_id]))
    .rows[0];
  const p = (await c.query('SELECT * FROM shipping_plans WHERE id=$1 FOR UPDATE', [id])).rows[0];
  ensure(o && p && p.order_id === found.order_id, 409, 'Zakres planu przesyłki zmienił się');
  ensure((await shippingWarehouseIds(c, o.id)).join(',') === warehouses.join(','),
    409, 'Magazyny przesyłki zmieniły się przed blokadą');
  await assertB2bDropshipParcelReceiverInTx(c, o.id, p.input, p.payload);
  return { p, o };
}
export async function shippingJob(c: PoolClient, a: PackingActor, p: any, action: string) {
  const job = randomUUID();
  await c.query(
    "INSERT INTO jobs(id,tenant_id,kind,payload,dedup_key) VALUES($1,$2,'shipping',$3,$4)",
    [
      job,
      a.tenantId,
      JSON.stringify({
        plan_id: p.id,
        actor_id: a.userId,
        channel_id: p.channel_id,
        action,
        ...(p.input.packing_snapshot && a.apiKeyId ? { packing_api_key_id: a.apiKeyId } : {}),
      }),
      `shipping:${p.id}:${action}:${job}`,
    ],
  );
  await c.query('UPDATE shipping_plans SET job_id=$2,error=NULL,updated_at=now() WHERE id=$1', [
    p.id,
    job,
  ]);
  return { id: p.id, job_id: job };
}
/** InPost plans predate the provider key; any other provider has its own process (DPD, DHL, Poczta Polska). */
export const isInPostPlan = (p: { input?: { provider?: string } }) => (p.input?.provider ?? 'inpost') === 'inpost';
export type OwnProcessProvider = 'dpd' | 'dhl' | 'pocztapolska';
export async function queueShipping(c: PoolClient, a: PackingActor, id: string, confirm: boolean) {
  const { p, o } = await lockedShipping(c, id);
  ensure(isInPostPlan(p), 422, 'Użyj procesu przewoźnika tego planu');
  ensure(p.actor_id === a.userId, 403, 'Plan zatwierdza jego autor');
  if (p.state === 'queued') return { id, job_id: p.job_id };
  ensure(p.state === 'preview', 409, 'Plan został już zlecony');
  const ch = (await c.query('SELECT * FROM channels WHERE id=$1', [p.channel_id])).rows[0];
  ensure(
    ch.settings.simulation || ch.mode !== 'live' || confirm,
    422,
    'Potwierdź przekazanie danych do InPost',
  );
  ensure(Date.now() - new Date(p.created_at).getTime() < 1800000, 409, 'Podgląd wygasł');
  ensure(same(await deliverySnapshot(c, o), p.order_snapshot), 409, 'Zamówienie zmieniło się od podglądu');
  await assertPackingShippingPlanInTx(c, a, o, p);
  ensure(
    !(
      await c.query(
        "SELECT id FROM shipping_plans WHERE order_id=$1 AND state NOT IN ('preview','cancelled','dispatched')",
        [o.id],
      )
    ).rowCount,
    409,
    'Zamówienie ma już aktywny plan przesyłki',
  );
  await newLabelTargetInTx(c, o.id, 'Zamówienie ma już przesyłkę');
  await c.query("UPDATE shipping_plans SET state='queued' WHERE id=$1", [id]);
  await audit(c, a, 'shipping.queue', id, { confirm_live: confirm });
  const result = await shippingJob(c, a, p, 'create');
  await pinPackingShippingActorInTx(c, a, Boolean(p.input.packing_snapshot));
  return result;
}
export type ShippingBuyInput = { offer_id: string; confirm_cost: boolean; ack_unknown_rate: boolean };
/** Queues the purchase of one quoted InPost offer (POST /api/shipping-plans/:id/buy). */
export async function queueShippingBuyInTx(c: PoolClient, a: PackingActor, id: string, b: ShippingBuyInput) {
  const { p, o } = await lockedShipping(c, id);
  ensure(isInPostPlan(p), 422, 'Ten przewoźnik używa osobnego procesu tworzenia');
  ensure(p.actor_id === a.userId, 403, 'Zakup zatwierdza autor planu');
  if (p.state === 'buy_queued') {
    ensure(p.selected_offer?.id === b.offer_id, 409, 'Zlecono już inną ofertę');
    return { id: p.id, job_id: p.job_id };
  }
  ensure(p.state === 'quoted' && o.status === 'packed', 409, 'Najpierw przygotuj wycenę');
  await fulfillmentPayment(c, o, p.input.cod);
  const offer = p.offers.find((x: any) => x.id === b.offer_id);
  ensure(offer && offer.currency === 'PLN', 422, 'Brak oferty w PLN');
  ensure(
    offer.expires_at &&
      Number.isFinite(new Date(offer.expires_at).getTime()) &&
      new Date(offer.expires_at).getTime() > Date.now(),
    409,
    'Oferta wygasła; odśwież wycenę',
  );
  const ch = (await c.query('SELECT mode,settings FROM channels WHERE id=$1', [p.channel_id]))
    .rows[0];
  ensure(
    ch.settings.simulation || ch.mode === 'sandbox' || b.confirm_cost,
    422,
    'Potwierdź zakup etykiety i koszt',
  );
  ensure(
    offer.rate !== null || b.ack_unknown_rate,
    422,
    'Cena API nie jest dostępna; potwierdź rozliczenie według umowy',
  );
  await c.query(
    "UPDATE shipping_plans SET state='buy_queued',phase='buy_ready',selected_offer=$2 WHERE id=$1",
    [p.id, JSON.stringify(offer)],
  );
  await audit(c, a, 'shipping.buy.queue', p.id, {
    offer,
    confirm_cost: b.confirm_cost,
    ack_unknown_rate: b.ack_unknown_rate,
  });
  return shippingJob(c, a, p, 'buy');
}
/**
 * A plan created by an automation rule (input.automation_buy) buys its cheapest PLN offer as soon as
 * the quote is accepted, through the same checks as the buy route. A refusal leaves the plan quoted
 * with the reason in `error`; the accepted quote is never rolled back.
 */
async function automationBuyInTx(c: PoolClient, a: Actor, p: any) {
  const flags = p.input.automation_buy;
  await c.query('SAVEPOINT shipping_automation_buy');
  try {
    const plan = (await c.query('SELECT offers FROM shipping_plans WHERE id=$1', [p.id])).rows[0];
    const offer = [...(plan?.offers ?? [])]
      .filter((x: any) => x.currency === 'PLN')
      .sort((x: any, y: any) => (x.rate ?? Infinity) - (y.rate ?? Infinity))[0];
    ensure(offer, 422, 'Brak oferty InPost w PLN do zakupu');
    await queueShippingBuyInTx(c, a, p.id, {
      offer_id: offer.id,
      confirm_cost: flags.confirm_cost === true,
      ack_unknown_rate: flags.confirm_cost === true,
    });
    await c.query('RELEASE SAVEPOINT shipping_automation_buy');
  } catch (e) {
    await c.query('ROLLBACK TO SAVEPOINT shipping_automation_buy');
    await c.query('RELEASE SAVEPOINT shipping_automation_buy');
    if (!(e instanceof Problem)) throw e;
    await c.query('UPDATE shipping_plans SET error=$2 WHERE id=$1', [p.id, ('Automatyczny zakup etykiety: ' + e.message).slice(0, 500)]);
  }
}
function offers(r: any, service: string) {
  return (Array.isArray(r.offers) ? r.offers : [])
    .filter((o: any) => o.service?.id === service && ['available', 'selected'].includes(o.status))
    .map((o: any) => ({
      id: idNumber.refine((s) => Number.isSafeInteger(Number(s))).parse(String(o.id)),
      service: o.service.id,
      status: o.status,
      rate: rateMinor(o.rate),
      currency: o.currency ?? 'PLN',
      expires_at: o.expires_at ?? null,
    }));
}
function verified(p: any, r: any) {
  ensure(String(r.id) === p.remote_id || !p.remote_id, 502, 'InPost zwrócił inną przesyłkę');
  ensure(r.reference === p.payload.reference, 409, 'Przesyłka InPost nie należy do tego planu');
  const normalizePhone = (v: any) => String(v ?? '').replace(/[^0-9]/g, '');
  ensure(
    r.receiver?.email === p.payload.receiver.email &&
      normalizePhone(r.receiver?.phone) === normalizePhone(p.payload.receiver.phone),
    409,
    'Dane odbiorcy InPost różnią się od planu',
  );
  for (const field of ['first_name', 'last_name'])
    ensure(
      r.receiver?.[field] === p.payload.receiver[field],
      409,
      'Odbiorca InPost różni się od planu',
    );
  for (const [key, value] of Object.entries(p.payload.receiver.address ?? {}))
    ensure(r.receiver?.address?.[key] === value, 409, 'Adres InPost różni się od planu');
  ensure(
    !p.input.target_point || r.custom_attributes?.target_point === p.input.target_point,
    409,
    'Punkt InPost różni się od planu',
  );
  ensure(
    r.custom_attributes?.sending_method === p.payload.custom_attributes.sending_method,
    409,
    'Sposób nadania różni się od planu',
  );
  ensure(
    Array.isArray(r.parcels) && r.parcels.length === p.payload.parcels.length,
    409,
    'Liczba paczek różni się od planu',
  );
  // ShipX keeps request order; parcels are compared position by position.
  p.payload.parcels.forEach((expected: any, i: number) => {
    const parcel = r.parcels[i];
    ensure(
      Number(parcel?.weight?.amount) === Number(expected.weight.amount) &&
        parcel?.weight?.unit === 'kg',
      409,
      'Waga paczki różni się od planu',
    );
    if (expected.template)
      ensure(parcel.template === expected.template, 409, 'Gabaryt różni się od planu');
    else
      for (const key of ['length', 'width', 'height'])
        ensure(
          Number(parcel.dimensions?.[key]) === expected.dimensions[key] &&
            parcel.dimensions?.unit === 'mm',
          409,
          'Wymiary różnią się od planu',
        );
  });
  for (const field of ['cod', 'insurance'])
    ensure(
      rateMinor(r[field]?.amount ?? 0) === rateMinor(p.payload[field]?.amount ?? 0) &&
        (!p.payload[field] || r[field]?.currency === 'PLN'),
      409,
      'Pobranie lub ubezpieczenie różni się od planu',
    );
}
async function fence(c: PoolClient, job: any) {
  return Boolean(
    (
      await c.query(
        "SELECT id FROM jobs WHERE id=$1 AND state='running' AND lease_token=$2 FOR UPDATE",
        [job.id, job.lease_token],
      )
    ).rowCount,
  );
}
/** Caller holds the order lock; existing whole-order carrier flow owns at most its single parcel. */
export async function assertWholeOrderShippingInTx(c: PoolClient, orderId: string, shipmentId: string | null = null) {
  await assertNoOrderParcelPlanInTx(c, orderId);
  const capability=(await c.query('SELECT order_shipments_guards() ok,order_shipments_installed() installed')).rows[0];
  ensure(capability?.ok && capability?.installed,503,'Moduł wielu przesyłek jest niekompletny');
  // A label cancelled before hand-over is no shipment of the plan: the new label takes over its row (migration 268).
  // The plan's own shipment always counts, whatever its status.
  const rows = (await c.query('SELECT id FROM shipments WHERE order_id=$1 AND (id=$2::uuid OR dispatched_at IS NOT NULL OR status<>$3) ORDER BY id', [orderId, shipmentId, CANCELLED_SHIPMENT])).rows;
  ensure(shipmentId ? rows.length === 1 && rows[0].id === shipmentId : rows.length === 0,
    409, 'Wiele paczek wymaga osobnego przypisania towaru i pobrania; nie zlecaj ponownie całego zamówienia');
}
async function savePhase(job: any, phase: string, remote?: string) {
  return tenantTx(job.tenant_id, async (c) => {
    const { p, o } = await lockedShipping(c, job.payload.plan_id);
    if (!(await fence(c, job))) return false;
    const firstCreate = phase === 'create_started' && p.phase === 'ready';
    const packingActor = packingShippingJobActor(job, 'operator');
    if (['create_started', 'buy_started', 'refresh_started'].includes(phase)) await assertWholeOrderShippingInTx(c, o.id, p.shipment_id ?? null);
    if (firstCreate) await assertPackingShippingPlanInTx(c, packingActor, o, p);
    if (['create_started', 'buy_started', 'refresh_started'].includes(phase)) {
      ensure(o.status === 'packed', 409, 'Zamówienie nie jest spakowane');
      await fulfillmentPayment(c, o, p.input.cod);
      if (phase === 'create_started')
        ensure(
          same(await deliverySnapshot(c, o), p.order_snapshot),
          409,
          'Zamówienie zmieniło się przed utworzeniem przesyłki',
        );
    }
    const changed = await c.query(
      'UPDATE shipping_plans SET phase=$2,remote_id=coalesce($3,remote_id),updated_at=now() WHERE id=$1 AND job_id=$4',
      [job.payload.plan_id, phase, remote ?? null, job.id],
    );
    await pinPackingShippingActorInTx(
      c,
      packingActor,
      firstCreate && Boolean(p.input.packing_snapshot),
    );
    return Boolean(changed.rowCount);
  });
}
async function pending(job: any) {
  return tenantTx(job.tenant_id, async (c) => {
    if (!(await fence(c, job))) return;
    await c.query(
      "UPDATE jobs SET state='pending',attempts=0,lease_token=NULL,locked_at=NULL,run_at=now()+interval '5 seconds' WHERE id=$1",
      [job.id],
    );
  });
}
function simulation(p: any, buy = false) {
  const option = {
    id: '1',
    service: { id: p.input.service },
    status: buy ? 'selected' : 'available',
    rate: '12.99',
    currency: 'PLN',
    expires_at: new Date(Date.now() + 300000).toISOString(),
  };
  return {
    id: p.remote_id ?? 'DEMO-' + p.id,
    reference: p.payload.reference,
    receiver: p.payload.receiver,
    custom_attributes: p.payload.custom_attributes,
    parcels: p.payload.parcels.map((x: any, k: number) => ({
      ...x,
      tracking_number: buy ? 'DEMO-' + p.id.slice(0, 12) + '-' + (k + 1) : null,
    })),
    cod: p.payload.cod ?? null,
    insurance: p.payload.insurance ?? null,
    status: buy ? 'confirmed' : 'offers_prepared',
    tracking_number: buy ? 'DEMO-' + p.id.slice(0, 12) : null,
    offers: [option],
    selected_offer: buy ? option : null,
  };
}
/** Per-parcel ids and tracking numbers of a multiparcel shipment (already verified against the plan). */
function parcelResult(r: any) {
  return r.parcels.map((x: any, index: number) => {
    const tracking = x.tracking_number ?? null;
    ensure(
      tracking === null || (typeof tracking === 'string' && tracking.length > 0 && tracking.length <= 64),
      502,
      'Nieprawidłowy numer śledzenia paczki InPost',
    );
    return { index, id: x.id === undefined || x.id === null ? null : String(x.id).slice(0, 64), tracking_number: tracking };
  });
}
const shippingCloseFailures = new WeakMap<object,{name:string;code:string|null}>();
/** Safe secondary cleanup fact; the original first error remains the thrown value. */
export function shippingCloseFailure(error:unknown) {
  return error && typeof error==='object' ? shippingCloseFailures.get(error) ?? null : null;
}
export async function processShipping(job: any, ctx: IntegrationContext = {}) {
  const membership = (
    await pool.query('SELECT role FROM memberships WHERE user_id=$1 AND tenant_id=$2', [
      job.payload.actor_id,
      job.tenant_id,
    ])
  ).rows[0];
  ensure(
    membership && ['admin', 'operator'].includes(membership.role),
    403,
    'Autor nie ma już prawa realizacji przesyłek',
  );
  const actor: Actor = {
    tenantId: job.tenant_id,
    userId: job.payload.actor_id,
    role: membership.role,
  };
  const lock = lockDbClient(new pg.Client({ connectionString: pool.options.connectionString }), 'shipping');
  let operationFailed=false, firstOperationError:unknown;
  try {
    return await holdingDbLock(lock, async () => {
    await lock.connect();
    const initial = await tenantTx(
      actor.tenantId,
      async (c) =>
        (await c.query('SELECT * FROM shipping_plans WHERE id=$1', [job.payload.plan_id])).rows[0],
    );
    ensure(initial, 404, 'Nie znaleziono planu');
    await lock.query("SET statement_timeout='20s'");
    await lock.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [
      'shipping:' + actor.tenantId + ':' + initial.order_id,
    ]);
    if (!(await tenantTx(actor.tenantId, (c) => fence(c, job)))) return;
    const p = await tenantTx(
      actor.tenantId,
      async (c) =>
        (await c.query('SELECT * FROM shipping_plans WHERE id=$1', [initial.id])).rows[0],
    );
    ensure(p.job_id === job.id, 409, 'Nieaktualne zadanie przesyłki');
    const ch = await loadChannel(actor.tenantId, p.channel_id),
      action = job.payload.action;
    const orderRead = await tenantTx(
      actor.tenantId,
      async (c) => {
        const order = (await c.query('SELECT * FROM orders WHERE id=$1', [p.order_id])).rows[0];
        ensure(order, 404, 'Nie znaleziono zamówienia');
        return { order, snapshot: await deliverySnapshot(c, order) };
      },
    );
    const order = orderRead.order;
    if (['create', 'buy'].includes(action))
      ensure(order.status === 'packed', 409, 'Zamówienie nie jest spakowane');
    if (action === 'create' && p.phase === 'ready')
      ensure(
        same(orderRead.snapshot, p.order_snapshot),
        409,
        'Zamówienie zmieniło się przed utworzeniem przesyłki',
      );
    if (['create', 'buy', 'refresh'].includes(action)) await tenantTx(actor.tenantId, async c => {
      const {p: current, o} = await lockedShipping(c, p.id);
      await assertWholeOrderShippingInTx(c, o.id, current.shipment_id ?? null);
    });
    let r: any;
    if (ch.settings.simulation) {
      if (action === 'cancel') r = { ...simulation(p), status: 'cancelled' };
      else {
        if (!(await savePhase(job, action === 'buy' ? 'buy_started' : 'create_started'))) return;
        r = simulation(p, action === 'buy');
      }
    } else
      r = await channelRead(
        actor.tenantId,
        ch.id,
        async (client) => {
          ensure(client instanceof InPost, 422, 'Wymagany InPost');
          let r: any;
          if (p.remote_id) r = await client.shipment(p.remote_id);
          else if (p.phase !== 'ready') {
            const found: any[] = [];
            for (let page = 1; page <= 20; page++) {
              const list = await client.shipments(ch.settings.organization_id, {
                created_at_gteq: new Date(new Date(p.created_at).getTime() - 300000).toISOString(),
                page,
                per_page: 100,
              });
              ensure(Array.isArray(list.items), 502, 'Nieprawidłowa lista InPost');
              found.push(...list.items.filter((x: any) => x.reference === p.payload.reference));
              if (
                Number.isFinite(Number(list.total_pages)) && list.total_pages > 0
                  ? page >= Number(list.total_pages)
                  : typeof list.count === 'number'
                    ? page * 100 >= list.count
                    : list.items.length < 100
              )
                break;
              ensure(
                page < 20,
                422,
                'Zbyt wiele wyników uzgodnienia; sprawdź przesyłkę u dostawcy',
              );
            }
            ensure(
              found.length === 1,
              422,
              found.length
                ? 'Niejednoznaczny wynik InPost; uzgodnij ręcznie'
                : 'Brak potwierdzenia utworzenia. Nie ponawiam POST; odczytaj wynik ponownie',
            );
            r = await client.shipment(String(found[0].id));
          }
          if (r) verified(p, r);
          if (action === 'cancel') {
            ensure(
              r && ['created', 'offers_prepared', 'offer_selected', 'cancelled'].includes(r.status),
              409,
              'Przesyłki opłaconej nie można anulować w ShipX',
            );
            if (r.status !== 'cancelled') {
              await client.cancelShipment(String(r.id));
            }
            return { ...r, status: 'cancelled' };
          }
          if (action === 'refresh' && p.phase === 'refresh_ready') {
            ensure(
              r && ['created', 'offers_prepared', 'offer_selected'].includes(r.status),
              409,
              'Nie można odświeżyć opłaconej przesyłki',
            );
            if (!(await savePhase(job, 'refresh_started'))) return null;
            await client.refreshShipment(String(r.id), p.payload);
            return client.shipment(String(r.id));
          }
          if (action === 'refresh') return r;
          if (action === 'create') {
            if (!r) {
              if (!(await savePhase(job, 'create_started'))) return null;
              r = await client.createShipment(ch.settings.organization_id, p.payload);
              idNumber.parse(String(r?.id));
              verified(p, r);
            }
            if (!(await savePhase(job, 'created', String(r.id)))) return null;
            return client.shipment(String(r.id));
          }
          ensure(action === 'buy' && p.remote_id, 422, 'Nieobsługiwana operacja');
          if (p.phase === 'buy_ready') {
            const current = offers(r, p.input.service).find(
              (x: any) => x.id === p.selected_offer.id,
            );
            ensure(
              current && same(current, p.selected_offer),
              409,
              'Oferta lub cena InPost zmieniła się; odśwież wycenę',
            );
            ensure(
              !current.expires_at || new Date(current.expires_at).getTime() > Date.now(),
              409,
              'Oferta InPost wygasła',
            );
            if (!(await savePhase(job, 'buy_started'))) return null;
            await client.buyShipment(p.remote_id, Number(current.id));
          }
          return client.shipment(p.remote_id);
        },
        ctx,
        false,
      );
    if (!r) return;
    verified({ ...p, remote_id: p.remote_id ?? String(r.id) }, r);
    if (['create', 'refresh'].includes(action) && !offers(r, p.input.service).length) {
      ensure(
        Date.now() - new Date(p.created_at).getTime() < 3600000,
        422,
        'Brak ofert InPost po godzinie; uzgodnij wynik',
      );
      await pending(job);
      return;
    }
    if (
      action === 'buy' &&
      (typeof r.tracking_number !== 'string' ||
        !r.tracking_number ||
        r.tracking_number.length > 64 ||
        ![
          'confirmed',
          'dispatched_by_sender',
          'collected_from_sender',
          'taken_by_courier',
          'adopted_at_source_branch',
          'adopted_at_sorting_center',
          'sent_from_sorting_center',
          'adopted_at_target_branch',
          'out_for_delivery',
          'pickup_reminder_sent',
          'returned_to_sender',
          'sent_from_source_branch',
          'ready_to_pickup',
          'delivered',
        ].includes(r.status))
    ) {
      ensure(
        Date.now() - new Date(p.updated_at).getTime() < 3600000,
        422,
        'Brak potwierdzenia zakupu InPost; nie ponawiam płatności',
      );
      await pending(job);
      return;
    }
    await tenantTx(actor.tenantId, async (c) => {
      if (!(await fence(c, job))) return;
      const { p: current, o } = await lockedShipping(c, p.id);
      ensure(current.job_id === job.id, 409, 'Nieaktualne zadanie');
      let shipment = current.shipment_id;
      if (action === 'buy') {
        await assertWholeOrderShippingInTx(c, o.id, shipment ?? null);
        ensure(o.status === 'packed', 409, 'Zamówienie nie jest spakowane');
        ensure(
          String(r.selected_offer?.id) === p.selected_offer.id &&
            (!r.service || r.service === p.input.service) &&
            r.selected_offer?.service?.id === p.input.service,
          502,
          'InPost nie potwierdziło wybranej usługi',
        );
        ensure(
          rateMinor(r.selected_offer?.rate) === p.selected_offer.rate &&
            r.selected_offer?.currency === p.selected_offer.currency,
          409,
          'Cena wybranej oferty po zakupie różni się od zatwierdzonej; sprawdź rozliczenie w InPost',
        );
        if (!shipment) {
          // A label cancelled with "Anuluj etykietę" is taken over by this one (migration 268).
          const target = await newLabelTargetInTx(c, p.order_id, 'Zamówienie ma już przesyłkę');
          shipment = target ?? randomUUID();
          await automationOnlyEvent(c, actor.tenantId, p.order_id, 'shipment.created', { shipment_id: shipment, carrier: 'InPost ShipX' });
          await writeLabelShipmentInTx(c, target, shipment, {
            tenantId: actor.tenantId,
            orderId: p.order_id,
            carrier: 'InPost ShipX',
            trackingNumber: r.tracking_number,
            mode: ch.settings.simulation ? 'demo' : ch.mode,
            status: r.status,
            channelId: ch.id,
            externalId: String(r.id),
            codExpected: p.input.cod,
          });
        }
      }
      await c.query(
        'UPDATE shipping_plans SET state=$2,phase=$3,remote_id=$4,offers=$5,result=$6,shipment_id=$7,error=NULL,updated_at=now() WHERE id=$1',
        [
          p.id,
          action === 'cancel' ? 'cancelled' : action === 'buy' ? 'ready' : 'quoted',
          action === 'cancel' ? 'cancelled' : action === 'buy' ? 'confirmed' : 'created',
          String(r.id),
          JSON.stringify(offers(r, p.input.service)),
          JSON.stringify({
            scope: ch.settings.simulation ? 'local_simulation' : 'external_api_verified',
            status: r.status,
            tracking_number: r.tracking_number ?? null,
            ...(p.payload.parcels.length > 1 ? { parcels: parcelResult(r) } : {}),
          }),
          shipment,
        ],
      );
      await c.query(
        "UPDATE jobs SET state='done',lease_token=NULL,locked_at=NULL,error=NULL WHERE id=$1",
        [job.id],
      );
      await audit(c, actor, 'shipping.' + action, p.id, {
        scope: ch.settings.simulation ? 'local_simulation' : 'external_api_verified',
      });
      if (action === 'create' && current.input.automation_buy) await automationBuyInTx(c, actor, current);
    });
    });
  } catch(error) {
    operationFailed=true;firstOperationError=error;throw error;
  } finally {
    try { await lock.end(); }
    catch(closeError) {
      if(!operationFailed)throw closeError;
      if(firstOperationError && typeof firstOperationError==='object')
        shippingCloseFailures.set(firstOperationError,{name:closeError instanceof Error?closeError.name:typeof closeError,
          code:closeError && typeof closeError==='object' && 'code' in closeError && typeof closeError.code==='string'?closeError.code:null});
    }
  }
}
export async function failShipping(job: any, e: unknown) {
  await tenantTx(job.tenant_id, async (c) => {
    if (!(await fence(c, job))) return;
    const terminal =
      (e instanceof Problem && [403, 404, 409, 422].includes(e.status)) ||
      job.attempts >= job.max_attempts;
    const message = e instanceof Problem ? e.message : 'Błąd integracji przesyłki';
    await c.query(
      'UPDATE jobs SET state=$2,error=$3,lease_token=NULL,locked_at=NULL,run_at=now()+make_interval(secs=>least(300,power(2,attempts)::int)) WHERE id=$1',
      [job.id, terminal ? 'failed' : 'pending', message],
    );
    await c.query(
      "UPDATE shipping_plans SET state=CASE WHEN $2 THEN 'failed' ELSE state END,error=$3 WHERE id=$1 AND job_id=$4",
      [job.payload.plan_id, terminal, message, job.id],
    );
  });
}
export async function dispatchShipping(c: PoolClient, a: Actor, id: string, onPhysical?:WholeOrderIssueWriter, expectedProvider?: OwnProcessProvider) {
  a = enlistDispatchActorInTx(c, a);
  a = enlistWmsActorInTx(c, a, { orders: true });
  const head = (await c.query('SELECT * FROM shipping_plans WHERE id=$1', [id])).rows[0];
  ensure(head, 404, 'Nie znaleziono planu przesyłki');
  ensure(!expectedProvider || head.input.provider === expectedProvider, 422, 'Wymagany plan przewoźnika tej trasy');
  await admitShippingWarehousesInTx(c, head.order_id);
  const source = head.state === 'ready' && head.shipment_id
    ? { kind: 'shipping_plan' as const, order_id: head.order_id as string, plan_id: id, shipment_id: head.shipment_id as string }
    : null;
  const wz = source ? await prepareAutomaticWzInTx(c, a, source) : null;
  const { p, o } = await lockedShipping(c, id);
  ensure(p.order_id === head.order_id && (!expectedProvider || p.input.provider === expectedProvider),
    409, 'Zakres planu przesyłki zmienił się');
  if (p.state === 'dispatched') return getOrder(c, o.id);
  ensure(
    p.state === 'ready' && o.status === 'packed',
    409,
    'Najpierw potwierdź zakup etykiety i spakowanie',
  );
  const s = (await c.query('SELECT * FROM shipments WHERE id=$1 FOR UPDATE', [p.shipment_id]))
    .rows[0];
  ensure(s && !s.dispatched_at, 409, 'Przesyłka została już przekazana');
  ensure(source && wz && source.shipment_id === s.id, 409, 'Źródło wystawienia WZ zmieniło się');
  await assertWholeOrderShippingInTx(c, o.id, s.id);
  await assertB2bDropshipDispatchInTx(c,o.id);
  await fulfillmentPayment(c, o, p.input.cod);
  const rs = (
    await c.query(
      "SELECT * FROM reservations WHERE order_id=$1 AND state='active' ORDER BY product_id",
      [o.id],
    )
  ).rows;
  ensure(rs.length, 409, 'Brak aktywnych rezerwacji');
  const physical=await consumeWholeOrderStockInTx(c,a,{order_id:o.id,reservations:rs});
  await c.query("UPDATE reservations SET state='consumed' WHERE order_id=$1 AND state='active'", [
    o.id,
  ]);
  await c.query("UPDATE orders SET status='shipped',updated_at=now() WHERE id=$1", [o.id]);
  await c.query('UPDATE shipments SET dispatched_at=now() WHERE id=$1', [s.id]);
  await c.query("UPDATE shipping_plans SET state='dispatched',updated_at=now() WHERE id=$1", [id]);
  await event(c, a.tenantId, o.id, 'order.shipped', {
    shipmentId: s.id,
    mode: s.mode,
    provider: p.input.provider ?? 'inpost',
  });
  await audit(c, a, 'shipping.dispatch', id);
  await finishAutomaticWzInTx(c, a, wz, { source, physical });
  if(onPhysical)await onPhysical({source:{kind:'shipping_plan',order_id:o.id,plan_id:id,shipment_id:s.id},physical});
  return getOrder(c, o.id);
}
