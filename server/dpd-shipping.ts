import { automationOnlyEvent } from './automation-v2-triggers';
import { assertB2bDropshipParcelReceiverInTx } from './b2b-dropship-guards';
import { randomUUID, createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import pg from 'pg';
import { holdingDbLock, lockDbClient } from './db-lock-holder';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { pool, tenantTx, localConfig } from './db';
import { deliveryBindingInTx } from './buyer-address';
import { audit, type Actor } from './domain';
import { ensure } from './errors';
import { assertNoShipmentForNewLabelInTx } from './shipment-cancelled';
import { encrypt } from './security';
import { fulfillmentPayment } from './payments';
import { loadChannel, channelRead, type IntegrationContext } from './channel-access';
import { Dpd } from './integrations';
import { lockedShipping, dispatchShipping, assertWholeOrderShippingInTx } from './shipping';
import type { PackingActor } from './packing-workstation-schema';
import {
  packingShippingBindingInput,
  packingShippingSnapshotInTx,
  assertPackingShippingPlanInTx,
  pinPackingShippingActorInTx,
  packingShippingJobActor,
  packingShippingActor,
} from './packing-shipping-binding';

const address = z.object({
  name: z.string().trim().min(2).max(100),
  address: z.string().trim().min(3).max(100),
  city: z.string().trim().min(2).max(50),
  postalCode: z
    .string()
    .regex(/^\d{2}-?\d{3}$/)
    .transform((v) => v.replace('-', '')),
  countryCode: z.literal('PL').default('PL'),
  phone: z.string().regex(/^\+?\d{9,15}$/),
  email: z.email().max(100),
});
const weight = z.number().min(0.01).max(31.5).multipleOf(0.01);
const dimensions = z.object({
  length: z.number().int().min(1).max(175),
  width: z.number().int().min(1).max(175),
  height: z.number().int().min(1).max(175),
});
export const dpdInput = z
  .object({
    channel_id: z.uuid(),
    sender: address,
    receiver: address,
    weight,
    dimensions,
    // One consignment, up to 10 parcels sharing the package reference.
    additional_parcels: z.array(z.object({ weight, dimensions })).max(9).default([]),
    content: z.string().trim().min(2).max(300),
    cod: z.number().int().min(0).max(1000000).default(0),
    insurance: z.number().int().min(0).max(10000000).default(0),
    packing: packingShippingBindingInput.optional(),
    packing_snapshot: z.never().optional(),
  })
  .refine((b) => b.insurance >= b.cod, 'Deklarowana wartość musi obejmować pobranie')
  .refine(
    (b) => !(b.packing && b.additional_parcels.length),
    'Pomiar ze stanowiska pakowania potwierdza jedną paczkę; dodatkowe paczki wymagają formularza bez pomiaru',
  );
const snapshot = (o: any) => ({
  status: o.status,
  updated_at: new Date(o.updated_at).toISOString(),
  total: o.total,
  currency: o.currency,
  warehouse_id: o.warehouse_id,
  customer_name: o.customer_name,
  address: o.address,
  email: o.email,
});
const equal = isDeepStrictEqual;
async function deliverySnapshot(c: pg.PoolClient, o: any) {
  const binding = await deliveryBindingInTx(c, o.tenant_id, o.id, localConfig.encryptionKey);
  return { ...snapshot(o), ...(binding ? { buyer_delivery: binding } : {}) };
}
// Credentials belong to the approved account too. Only a digest is persisted in the plan.
export const dpdConnection = (ch: any) =>
  createHash('sha256')
    .update(
      JSON.stringify({
        provider: ch.provider,
        mode: ch.mode,
        settings: ch.settings,
        credentials: ch.credentials,
      }),
    )
    .digest('hex');
export function dpdPdf(base64: unknown) {
  ensure(
    typeof base64 === 'string' &&
      base64.length > 0 &&
      base64.length <= 6 * 1024 * 1024 &&
      /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64),
    502,
    'Nieprawidłowa etykieta PDF DPD',
  );
  const pdf = Buffer.from(base64, 'base64');
  ensure(
    pdf.length <= 4 * 1024 * 1024 &&
      pdf.subarray(0, 5).toString() === '%PDF-' &&
      pdf.toString('base64') === base64,
    502,
    'Nieprawidłowa etykieta PDF DPD',
  );
  return pdf;
}
// Every parcel carries the package reference and its own distinct waybill.
const ownWaybills = (parcels: any[], reference: string) => {
  const waybills = parcels.map((s) =>
    s?.reference === reference && typeof s.waybill === 'string' && /^[A-Za-z0-9]{8,40}$/.test(s.waybill)
      ? (s.waybill as string)
      : null,
  );
  return waybills.every(Boolean) && new Set(waybills).size === waybills.length
    ? (waybills as string[])
    : null;
};
// A partial answer (some parcels without a number) is never accepted: the plan
// stays in create_started and only the label read by reference may resolve it.
function generated(raw: any, reference: string, n: number) {
  const p = raw?.packages?.[0];
  const waybills =
    raw?.status === 'OK' &&
    raw.packages.length === 1 &&
    p.status === 'OK' &&
    p.reference === reference &&
    Array.isArray(p.parcels) &&
    p.parcels.length === n &&
    p.parcels.every((s: any) => s?.status === 'OK')
      ? ownWaybills(p.parcels, reference)
      : null;
  ensure(waybills, 502, 'DPD nie potwierdziło numerów wszystkich paczek; uzgodnij wynik');
  return waybills;
}
function rejected(raw: any, reference: string, n: number) {
  const p = raw?.packages?.[0];
  return (
    raw?.status === 'INCORRECT_DATA' &&
    raw.packages?.length === 1 &&
    p?.reference === reference &&
    p.status === 'INCORRECT_DATA' &&
    Array.isArray(p.parcels) &&
    p.parcels.length <= n &&
    p.parcels.every(
      (s: any) => ['INCORRECT_DATA', 'NOT_PROCESSED'].includes(s?.status) && !s.waybill,
    )
  );
}
// `known` is the stored waybill list (or the legacy single remote_id); without it
// the label must prove exactly `n` parcels of this reference.
export function verifiedDpdLabel(
  raw: any,
  reference: string,
  known?: string | readonly string[] | null,
  n?: number,
) {
  const expected = known ? [known].flat() : null,
    count = n ?? expected?.length ?? 1,
    p = raw?.session?.packages?.[0];
  const waybills =
    raw?.status === 'OK' &&
    raw.session?.statusInfo?.status === 'OK' &&
    raw.session.packages.length === 1 &&
    p.statusInfo?.status === 'OK' &&
    Array.isArray(p.parcels) &&
    p.parcels.length === count &&
    p.parcels.every((s: any) => (s?.statusInfo?.status ?? s?.status) === 'OK')
      ? ownWaybills(p.parcels, reference)
      : null;
  ensure(
    waybills &&
      (!expected ||
        (expected.length === count && expected.every((w) => waybills.includes(w)))),
    502,
    'Brak jednoznacznej etykiety DPD dla tej referencji; sprawdź wynik u dostawcy',
  );
  dpdPdf(raw.documentData);
  const ordered = expected ?? waybills;
  return {
    waybill: ordered[0],
    waybills: ordered,
    label_base64: raw.documentData as string,
    trace_id: typeof raw.traceId === 'string' ? raw.traceId.slice(0, 100) : null,
  };
}
const parcelList = (waybills: string[]) => waybills.map((waybill, i) => ({ index: i + 1, waybill }));
export async function dpdExample(a: Actor) {
  return tenantTx(a.tenantId, async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      'dpd-example:' + a.tenantId,
    ]);
    const old = (
      await c.query(
        "SELECT id FROM channels WHERE provider='dpd' AND settings->>'simulation'='true' ORDER BY created_at LIMIT 1",
      )
    ).rows[0];
    if (old) return { channel_id: old.id };
    const id = randomUUID();
    await c.query(
      "INSERT INTO channels(id,tenant_id,provider,name,mode,credentials,settings,status) VALUES($1,$2,'dpd','DPD — przykład lokalny','sandbox',$3,$4,'local_simulation')",
      [id, a.tenantId, encrypt({}), JSON.stringify({ simulation: true, master_fid: '1495' })],
    );
    await audit(c, a, 'dpd.example', id);
    return { channel_id: id };
  });
}
export async function previewDpd(
  a: PackingActor,
  orderId: string,
  input: z.infer<typeof dpdInput>,
) {
  return tenantTx(a.tenantId, (c) => previewDpdInTx(c, a, orderId, input));
}
/** The preview on the caller's transaction (automation effects). */
export async function previewDpdInTx(
  c: pg.PoolClient,
  a: PackingActor,
  orderId: string,
  input: z.infer<typeof dpdInput>,
) {
  {
    // Bound previews share the worker's order → channel lock order.
    const boundOrder = input.packing
      ? (await c.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE', [orderId])).rows[0]
      : undefined;
    if (input.packing) ensure(boundOrder, 404, 'Nie znaleziono zamówienia');
    const ch = (await c.query('SELECT * FROM channels WHERE id=$1 FOR SHARE', [input.channel_id]))
      .rows[0];
    ensure(
      ch?.provider === 'dpd' && /^[1-9]\d{0,9}$/.test(ch.settings.master_fid),
      422,
      'Wymagane połączenie DPD z Master FID',
    );
    const o =
      boundOrder ??
      (await c.query('SELECT * FROM orders WHERE id=$1 FOR SHARE', [orderId])).rows[0];
    ensure(o, 404, 'Nie znaleziono zamówienia');
    ensure(
      o.status === 'packed' && o.currency === 'PLN',
      409,
      'Wymagane spakowane zamówienie w PLN',
    );
    await fulfillmentPayment(c, o, input.cod);
    const packingSnapshot = await packingShippingSnapshotInTx(c, a, o, input, 'dpd');
    const id = randomUUID(),
      reference = 'DYNA-' + id;
    const services = ['cod', 'insurance'].flatMap((field) => {
      const amount = input[field as 'cod' | 'insurance'];
      return amount
        ? [
            {
              code: field === 'cod' ? 'COD' : 'DECLARED_VALUE',
              attributes: [
                { code: 'AMOUNT', value: (amount / 100).toFixed(2) },
                { code: 'CURRENCY', value: 'PLN' },
              ],
            },
          ]
        : [];
    });
    const payload = {
      generationPolicy: 'STOP_ON_FIRST_ERROR',
      packages: [
        {
          reference,
          receiver: input.receiver,
          sender: input.sender,
          payerFID: Number(ch.settings.master_fid),
          services,
          // Label search is by parcel reference, so every parcel repeats the package one.
          parcels: [input, ...input.additional_parcels].map((parcel) => ({
            reference,
            weight: parcel.weight,
            sizeX: parcel.dimensions.length,
            sizeY: parcel.dimensions.width,
            sizeZ: parcel.dimensions.height,
            content: input.content,
          })),
        },
      ],
    };
    await assertB2bDropshipParcelReceiverInTx(c, o.id, { provider: 'dpd' }, payload);
    await c.query(
      'INSERT INTO shipping_plans(id,tenant_id,order_id,channel_id,actor_id,input,payload,order_snapshot) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [
        id,
        a.tenantId,
        o.id,
        ch.id,
        a.userId,
        JSON.stringify({
          ...input,
          provider: 'dpd',
          connection_hash: dpdConnection(ch),
          ...(packingSnapshot ? { packing_snapshot: packingSnapshot } : {}),
        }),
        JSON.stringify(payload),
        JSON.stringify(await deliverySnapshot(c, o)),
      ],
    );
    await audit(c, a, 'dpd.preview', id);
    await pinPackingShippingActorInTx(c, a, Boolean(packingSnapshot));
    return {
      id,
      payload,
      mode: ch.mode,
      scope: ch.settings.simulation ? 'local_simulation' : 'external_pending',
      rate: null,
      currency: 'PLN',
    };
  }
}
async function dpdJob(c: pg.PoolClient, a: PackingActor, p: any) {
  const id = randomUUID();
  await c.query(
    "INSERT INTO jobs(id,tenant_id,kind,payload,dedup_key) VALUES($1,$2,'shipping.dpd',$3,$4)",
    [
      id,
      a.tenantId,
      JSON.stringify({
        plan_id: p.id,
        actor_id: a.userId,
        channel_id: p.channel_id,
        ...(p.input.packing_snapshot && a.apiKeyId ? { packing_api_key_id: a.apiKeyId } : {}),
      }),
      'dpd:' + p.id + ':' + id,
    ],
  );
  await c.query(
    "UPDATE shipping_plans SET state='queued',job_id=$2,error=NULL,updated_at=now() WHERE id=$1",
    [p.id, id],
  );
  return { id: p.id, job_id: id };
}
export type DpdQueueInput = { confirm_external: boolean; ack_contract_rate: boolean };
/** Queues the creation job of a previewed DPD plan (POST /api/dpd-shipping/:id/queue) on the caller's transaction. */
export async function queueDpdInTx(
  c: pg.PoolClient,
  actor: Actor,
  packingActor: PackingActor,
  planId: string,
  b: DpdQueueInput,
) {
  const { p, o } = await lockedShipping(c, planId);
  ensure(
    p.actor_id === actor.userId && p.input.provider === 'dpd',
    403,
    'Wymagany autor planu DPD',
  );
  if (p.state === 'queued') return { id: p.id, job_id: p.job_id };
  ensure(
    p.state === 'preview' &&
      Date.now() - new Date(p.created_at).getTime() < 1800000 &&
      equal(await deliverySnapshot(c, o), p.order_snapshot),
    409,
    'Podgląd wygasł lub zamówienie zmieniło się',
  );
  const ch = (await c.query('SELECT * FROM channels WHERE id=$1 FOR SHARE', [p.channel_id]))
    .rows[0];
  ensure(dpdConnection(ch) === p.input.connection_hash, 409, 'Połączenie DPD zmieniło się');
  ensure(
    ch.settings.simulation || (b.confirm_external && b.ack_contract_rate),
    422,
    'Potwierdź przekazanie danych, utworzenie przesyłki i cenę według umowy',
  );
  await fulfillmentPayment(c, o, p.input.cod);
  await assertPackingShippingPlanInTx(c, packingActor, o, p);
  ensure(
    !(
      await c.query(
        "SELECT id FROM shipping_plans WHERE order_id=$1 AND state NOT IN ('preview','cancelled','dispatched')",
        [o.id],
      )
    ).rowCount,
    409,
    'Zamówienie ma już aktywną przesyłkę',
  );
  await assertNoShipmentForNewLabelInTx(c, o.id, 'Zamówienie ma już aktywną przesyłkę');
  await audit(c, actor, 'dpd.queue', p.id, b);
  const result = await dpdJob(c, packingActor, p);
  await pinPackingShippingActorInTx(c, packingActor, Boolean(p.input.packing_snapshot));
  return result;
}
async function guard(c: pg.PoolClient, job: any, renew = false) {
  const { p, o } = await lockedShipping(c, job.payload.plan_id);
  const ch = (await c.query('SELECT * FROM channels WHERE id=$1 FOR SHARE', [p.channel_id]))
    .rows[0];
  const role = (
    await pool.query('SELECT role FROM memberships WHERE user_id=$1 AND tenant_id=$2', [
      job.payload.actor_id,
      job.tenant_id,
    ])
  ).rows[0]?.role;
  ensure(
    ['admin', 'operator'].includes(role) && p.actor_id === job.payload.actor_id,
    403,
    'Autor nie ma prawa realizacji przesyłki',
  );
  ensure(
    p.input.provider === 'dpd' &&
      p.state === 'queued' &&
      p.job_id === job.id &&
      p.channel_id === job.payload.channel_id &&
      ch?.provider === 'dpd' &&
      dpdConnection(ch) === p.input.connection_hash,
    409,
    'Plan lub połączenie DPD zmieniło się',
  );
  const lease = await c.query(
    "UPDATE jobs SET locked_at=CASE WHEN $3 THEN now() ELSE locked_at END WHERE id=$1 AND lease_token=$2 AND state='running' AND locked_at>now()-interval '2 minutes' RETURNING id",
    [job.id, job.lease_token, renew],
  );
  ensure(lease.rowCount, 409, 'Dzierżawa przesyłki DPD wygasła');
  ensure(o.status === 'packed', 409, 'Zamówienie nie jest spakowane');
  await assertWholeOrderShippingInTx(c, o.id, p.shipment_id ?? null);
  await fulfillmentPayment(c, o, p.input.cod);
  if (p.phase === 'ready') {
    ensure(equal(await deliverySnapshot(c, o), p.order_snapshot), 409, 'Zamówienie zmieniło się od podglądu');
    const actor = packingShippingJobActor(job, role);
    await assertPackingShippingPlanInTx(c, actor, o, p);
    await pinPackingShippingActorInTx(c, actor, Boolean(p.input.packing_snapshot));
  }
  return {
    p,
    o,
    ch,
    actor: { tenantId: job.tenant_id, userId: job.payload.actor_id, role } as Actor,
  };
}
export async function processDpd(job: any, ctx: IntegrationContext = {}) {
  const lock = lockDbClient(new pg.Client({ connectionString: pool.options.connectionString }), 'dpd-shipping');
  await lock.connect();
  try {
    return await holdingDbLock(lock, async () => {
    const first = await tenantTx(job.tenant_id, (c) => guard(c, job));
    await lock.query("SET statement_timeout='20s'");
    await lock.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [
      'shipping:' + job.tenant_id + ':' + first.p.order_id,
    ]);
    let { p, ch } = await tenantTx(job.tenant_id, (c) => guard(c, job, true));
    // Created numbers are persisted with the phase, so a lost label answer is
    // verified against the full stored set (result.parcels), not only remote_id.
    const update = async (phase: string, waybills?: string[]) => {
      const result = waybills ? { parcels: parcelList(waybills) } : null;
      await tenantTx(job.tenant_id, async (c) => {
        await guard(c, job, true);
        await c.query(
          'UPDATE shipping_plans SET phase=$2,remote_id=coalesce($3,remote_id),result=coalesce($4,result),updated_at=now() WHERE id=$1',
          [p.id, phase, waybills?.[0] ?? null, result && JSON.stringify(result)],
        );
      });
      p = { ...p, phase, remote_id: waybills?.[0] ?? p.remote_id, result: result ?? p.result };
    };
    const reference = p.payload.packages[0].reference,
      count = p.payload.packages[0].parcels.length;
    let label: any;
    if (ch.settings.simulation) {
      await update('create_started');
      const waybill = 'DEMO-DPD-' + p.id.slice(0, 12);
      label = {
        waybill,
        waybills: Array.from({ length: count }, (_, i) => (i ? waybill + '-' + (i + 1) : waybill)),
        trace_id: null,
      };
    } else {
      label = await channelRead(
        job.tenant_id,
        ch.id,
        async (client) => {
          ensure(client instanceof Dpd, 422, 'Wymagane DPD');
          if (p.phase === 'ready') {
            for (const a of [p.input.sender, p.input.receiver]) {
              const routing = await client.postalCode(a.postalCode);
              ensure(routing?.status === 'OK', 422, 'DPD nie obsługuje wskazanego kodu pocztowego');
            }
            await update('create_started');
            const raw = await client.create(p.payload);
            if (rejected(raw, reference, count)) {
              await update('rejected');
              ensure(
                false,
                422,
                'DPD odrzuciło dane paczki bez numeru nadania; anuluj plan i popraw dane',
              );
            }
            await update('numbers_ready', generated(raw, reference, count));
          }
          // A lost create response is resolved by the exact parcel reference. Never repeat create.
          const raw = await client.labels(reference);
          const stored = Array.isArray(p.result?.parcels)
            ? p.result.parcels.map((s: any) => s.waybill as string)
            : p.remote_id;
          return verifiedDpdLabel(raw, reference, stored, count);
        },
        {
          ...ctx,
          transport: async (url, init) => {
            await tenantTx(job.tenant_id, (c) => guard(c, job, true));
            const { safeFetch } = await import('./integrations');
            return (ctx.transport ?? safeFetch)(url, init);
          },
        },
        false,
        (current) =>
          ensure(
            dpdConnection(current) === p.input.connection_hash,
            409,
            'Połączenie DPD zmieniło się',
          ),
      );
    }
    await tenantTx(job.tenant_id, async (c) => {
      const { p: current, actor } = await guard(c, job);
      // Recovery has verified the exact parcel reference and label. Persist its
      // number in this acceptance transaction before the shipment guard checks
      // the active plan; never repeat generation after a lost create response.
      if (!ch.settings.simulation && current.phase === 'create_started') {
        await c.query(
          "UPDATE shipping_plans SET phase='numbers_ready',remote_id=$2,updated_at=now() WHERE id=$1",
          [current.id, label.waybill],
        );
      }
      const sid = randomUUID();
      await automationOnlyEvent(c, job.tenant_id, current.order_id, 'shipment.created', { shipment_id: sid, carrier: 'DPD Polska' });
      await c.query(
        "INSERT INTO shipments(id,tenant_id,order_id,carrier,tracking_number,mode,status,channel_id,external_id,cod_expected) VALUES($1,$2,$3,'DPD Polska',$4,$5,'label_ready',$6,$7,$8)",
        [
          sid,
          job.tenant_id,
          current.order_id,
          label.waybill,
          ch.settings.simulation ? 'demo' : ch.mode,
          ch.id,
          ch.settings.simulation ? null : label.waybill,
          current.input.cod,
        ],
      );
      const { waybills, ...proof } = label;
      const result = {
        ...proof,
        parcels: parcelList(waybills),
        scope: ch.settings.simulation
          ? 'local_simulation'
          : ch.mode === 'sandbox'
            ? 'external_sandbox_verified'
            : 'external_api_verified',
        status: 'label_ready',
        tracking_number: label.waybill,
        rate: null,
        currency: 'PLN',
      };
      await c.query(
        "UPDATE shipping_plans SET state='ready',phase='confirmed',remote_id=$2,shipment_id=$3,result=$4,error=NULL,updated_at=now() WHERE id=$1",
        [p.id, label.waybill, sid, JSON.stringify(result)],
      );
      await c.query(
        "UPDATE jobs SET state='done',lease_token=NULL,locked_at=NULL,error=NULL WHERE id=$1",
        [job.id],
      );
      await audit(c, actor, 'dpd.created', p.id, { scope: result.scope, trace_id: label.trace_id });
    });
    });
  } finally {
    await lock.end();
  }
}
export async function cachedDpdLabel(tenant: string, shipment: string) {
  return tenantTx(tenant, async (c) => {
    const p = (
      await c.query(
        "SELECT p.* FROM shipping_plans p JOIN shipments s ON (s.tenant_id,s.id)=(p.tenant_id,p.shipment_id) WHERE s.id=$1 AND p.input->>'provider'='dpd' AND p.state IN ('ready','dispatched') AND s.tracking_number=p.result->>'tracking_number'",
        [shipment],
      )
    ).rows[0];
    ensure(p?.result?.label_base64, 404, 'Nie znaleziono zapisanej etykiety DPD');
    return dpdPdf(p.result.label_base64);
  });
}
export function registerDpdRoutes(app: FastifyInstance) {
  const id = (p: any) => z.object({ id: z.uuid() }).parse(p).id;
  const write = (req: any) =>
    ensure(['admin', 'operator'].includes(req.actor.role), 403, 'Brak prawa realizacji przesyłek');
  app.post('/api/dpd-shipping/example', (req) => {
    ensure(req.actor.role === 'admin', 403, 'Wymagany administrator');
    return dpdExample(req.actor);
  });
  app.post('/api/orders/:id/dpd-shipping/preview', (req) => {
    write(req);
    return previewDpd(packingShippingActor(req), id(req.params), dpdInput.parse(req.body));
  });
  app.post('/api/dpd-shipping/:id/queue', (req) => {
    write(req);
    const b = z
      .object({
        confirm_external: z.boolean().default(false),
        ack_contract_rate: z.boolean().default(false),
      })
      .parse(req.body ?? {});
    return tenantTx(req.actor.tenantId, (c) =>
      queueDpdInTx(c, req.actor, packingShippingActor(req), id(req.params), b),
    );
  });
  app.post('/api/dpd-shipping/:id/reconcile', (req) => {
    write(req);
    return tenantTx(req.actor.tenantId, async (c) => {
      const { p } = await lockedShipping(c, id(req.params));
      ensure(
        p.actor_id === req.actor.userId && p.input.provider === 'dpd',
        403,
        'Wymagany autor planu DPD',
      );
      ensure(
        p.state === 'failed' && ['create_started', 'numbers_ready'].includes(p.phase),
        409,
        'Brak niepewnego wyniku DPD do uzgodnienia',
      );
      await audit(c, req.actor, 'dpd.reconcile', p.id);
      return dpdJob(c, req.actor, p);
    });
  });
  app.post('/api/dpd-shipping/:id/dispatch', (req) => {
    write(req);
    return tenantTx(req.actor.tenantId, async (c) => {
      return dispatchShipping(c, req.actor, id(req.params), undefined, 'dpd');
    });
  });
}
