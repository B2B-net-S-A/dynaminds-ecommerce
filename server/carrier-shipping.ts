import { automationOnlyEvent } from './automation-v2-triggers';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import pg from 'pg';
import { assertDbLocksHeldInTx, holdingDbLock, lockDbClient } from './db-lock-holder';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { pool, tenantTx, localConfig } from './db';
import { deliveryBindingInTx } from './buyer-address';
import { audit, type Actor } from './domain';
import { ensure } from './errors';
import { newLabelTargetInTx, writeLabelShipmentInTx } from './shipment-cancelled';
import { encrypt } from './security';
import { fulfillmentPayment } from './payments';
import { channelRead, type IntegrationContext } from './channel-access';
import { lockedShipping, dispatchShipping, assertWholeOrderShippingInTx } from './shipping';
import type { PackingActor } from './packing-workstation-schema';
import {
  assertPackingShippingPlanInTx,
  pinPackingShippingActorInTx,
  packingShippingJobActor,
  packingShippingActor,
} from './packing-shipping-binding';

// Shared plan machinery of the carriers added by migration 234 (DHL Parcel Polska, Poczta Polska).
// It follows server/dpd-shipping.ts: preview → queue (job shipping.<provider>) → create under the
// plan lock with the phases ready → create_started → numbers_ready → confirmed → dispatch. The
// SQL guard order_shipments_guard() (234) admits exactly these shipments.
export type CarrierProvider = 'dhl' | 'pocztapolska';
export const CARRIER_NAMES = { dhl: 'DHL Parcel Polska', pocztapolska: 'Poczta Polska' } as const;
/** Carriers whose label bytes are stored in shipping_plans.result at creation (no provider read later). */
export const STORED_LABEL_PROVIDERS: Record<string, 'dpd' | CarrierProvider> = {
  'DPD Polska': 'dpd',
  [CARRIER_NAMES.dhl]: 'dhl',
  [CARRIER_NAMES.pocztapolska]: 'pocztapolska',
};
export interface CarrierSpec {
  provider: CarrierProvider;
  /** Short name in Polish messages. */
  label: string;
  demoPrefix: 'DEMO-DHL-' | 'DEMO-PP-';
  connection: (ch: any) => string;
  pdf: (base64: unknown) => Buffer;
  exampleSettings: Record<string, string | boolean>;
}
/** What a provider step returns for the accepted shipment (label bytes are verified by the caller). */
export interface CarrierLabel {
  waybill: string;
  label_base64: string | null;
  trace_id: string | null;
  [extra: string]: unknown;
}
/** Plan row access for a running job; every call re-checks the job lease and the plan. */
export interface CarrierPlanPort {
  current(): Promise<any>;
  update(phase: string, remoteId?: string | null): Promise<void>;
}
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
export async function carrierDeliverySnapshot(c: pg.PoolClient, o: any) {
  const binding = await deliveryBindingInTx(c, o.tenant_id, o.id, localConfig.encryptionKey);
  return { ...snapshot(o), ...(binding ? { buyer_delivery: binding } : {}) };
}
export async function carrierExample(a: Actor, spec: CarrierSpec) {
  return tenantTx(a.tenantId, async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      spec.provider + '-example:' + a.tenantId,
    ]);
    const old = (
      await c.query(
        "SELECT id FROM channels WHERE provider=$1 AND settings->>'simulation'='true' ORDER BY created_at LIMIT 1",
        [spec.provider],
      )
    ).rows[0];
    if (old) return { channel_id: old.id };
    const id = randomUUID();
    await c.query(
      "INSERT INTO channels(id,tenant_id,provider,name,mode,credentials,settings,status) VALUES($1,$2,$3,$4,'sandbox',$5,$6,'local_simulation')",
      [
        id,
        a.tenantId,
        spec.provider,
        spec.label + ' — przykład lokalny',
        encrypt({}),
        JSON.stringify({ simulation: true, ...spec.exampleSettings }),
      ],
    );
    await audit(c, a, spec.provider + '.example', id);
    return { channel_id: id };
  });
}
/** Locks the order (and channel) of a preview; the caller validates the provider's settings. */
export async function carrierPreviewScope(
  c: pg.PoolClient,
  spec: CarrierSpec,
  orderId: string,
  input: { channel_id: string; packing?: unknown; cod: number },
) {
  const boundOrder = input.packing
    ? (await c.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE', [orderId])).rows[0]
    : undefined;
  if (input.packing) ensure(boundOrder, 404, 'Nie znaleziono zamówienia');
  const ch = (await c.query('SELECT * FROM channels WHERE id=$1 FOR SHARE', [input.channel_id]))
    .rows[0];
  ensure(ch?.provider === spec.provider, 422, `Wymagane połączenie ${spec.label}`);
  const o =
    boundOrder ?? (await c.query('SELECT * FROM orders WHERE id=$1 FOR SHARE', [orderId])).rows[0];
  ensure(o, 404, 'Nie znaleziono zamówienia');
  ensure(o.status === 'packed' && o.currency === 'PLN', 409, 'Wymagane spakowane zamówienie w PLN');
  await fulfillmentPayment(c, o, input.cod);
  return { ch, o };
}
export async function insertCarrierPlan(
  c: pg.PoolClient,
  a: PackingActor,
  spec: CarrierSpec,
  plan: { id: string; o: any; ch: any; input: any; payload: unknown; packingSnapshot: unknown },
) {
  const { id, o, ch, input, payload, packingSnapshot } = plan;
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
        provider: spec.provider,
        connection_hash: spec.connection(ch),
        ...(packingSnapshot ? { packing_snapshot: packingSnapshot } : {}),
      }),
      JSON.stringify(payload),
      JSON.stringify(await carrierDeliverySnapshot(c, o)),
    ],
  );
  await audit(c, a, spec.provider + '.preview', id);
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
async function carrierJob(c: pg.PoolClient, a: PackingActor, spec: CarrierSpec, p: any) {
  const id = randomUUID();
  await c.query('INSERT INTO jobs(id,tenant_id,kind,payload,dedup_key) VALUES($1,$2,$3,$4,$5)', [
    id,
    a.tenantId,
    // Literal kinds keep the static job-kind coverage (tests/failure-job-kinds.test.ts) resolvable.
    spec.provider === 'dhl' ? 'shipping.dhl' : 'shipping.pocztapolska',
    JSON.stringify({
      plan_id: p.id,
      actor_id: a.userId,
      channel_id: p.channel_id,
      ...(p.input.packing_snapshot && a.apiKeyId ? { packing_api_key_id: a.apiKeyId } : {}),
    }),
    spec.provider + ':' + p.id + ':' + id,
  ]);
  await c.query(
    "UPDATE shipping_plans SET state='queued',job_id=$2,error=NULL,updated_at=now() WHERE id=$1",
    [p.id, id],
  );
  return { id: p.id, job_id: id };
}
async function carrierGuard(c: pg.PoolClient, spec: CarrierSpec, job: any, renew = false) {
  const { p, o } = await lockedShipping(c, job.payload.plan_id);
  const ch = (await c.query('SELECT * FROM channels WHERE id=$1 FOR SHARE', [p.channel_id])).rows[0];
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
    p.input.provider === spec.provider &&
      p.state === 'queued' &&
      p.job_id === job.id &&
      p.channel_id === job.payload.channel_id &&
      ch?.provider === spec.provider &&
      spec.connection(ch) === p.input.connection_hash,
    409,
    `Plan lub połączenie ${spec.label} zmieniło się`,
  );
  const lease = await c.query(
    "UPDATE jobs SET locked_at=CASE WHEN $3 THEN now() ELSE locked_at END WHERE id=$1 AND lease_token=$2 AND state='running' AND locked_at>now()-interval '2 minutes' RETURNING id",
    [job.id, job.lease_token, renew],
  );
  ensure(lease.rowCount, 409, `Dzierżawa przesyłki ${spec.label} wygasła`);
  ensure(o.status === 'packed', 409, 'Zamówienie nie jest spakowane');
  await assertWholeOrderShippingInTx(c, o.id, p.shipment_id ?? null);
  await fulfillmentPayment(c, o, p.input.cod);
  if (p.phase === 'ready') {
    ensure(
      isDeepStrictEqual(await carrierDeliverySnapshot(c, o), p.order_snapshot),
      409,
      'Zamówienie zmieniło się od podglądu',
    );
    const actor = packingShippingJobActor(job, role);
    await assertPackingShippingPlanInTx(c, actor, o, p);
    await pinPackingShippingActorInTx(c, actor, Boolean(p.input.packing_snapshot));
  }
  return { p, ch, actor: { tenantId: job.tenant_id, userId: job.payload.actor_id, role } as Actor };
}
/** A short tenant-scoped transaction (role dyna_app, RLS) without the full tenantTx admission work,
 * used only for the fence inside a provider request whose timeout must stay the provider's. */
export async function fenceTx<T>(tenantId: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE dyna_app');
    await c.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
    await c.query("SET LOCAL statement_timeout='5s'");
    const out = await fn(c);
    await assertDbLocksHeldInTx(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}
async function carrierFence(c: pg.PoolClient, spec: CarrierSpec, job: any) {
  const lease = await c.query(
    "UPDATE jobs SET locked_at=now() WHERE id=$1 AND lease_token=$2 AND state='running' AND locked_at>now()-interval '2 minutes' RETURNING id",
    [job.id, job.lease_token],
  );
  ensure(lease.rowCount, 409, `Dzierżawa przesyłki ${spec.label} wygasła`);
  const role = (
    await pool.query('SELECT role FROM memberships WHERE user_id=$1 AND tenant_id=$2', [job.payload.actor_id, job.tenant_id])
  ).rows[0]?.role;
  ensure(['admin', 'operator'].includes(role), 403, 'Autor nie ma prawa realizacji przesyłki');
  const row = (
    await c.query(
      'SELECT p.state,p.job_id,p.actor_id,p.input,ch.provider,ch.mode,ch.settings,ch.credentials FROM shipping_plans p JOIN channels ch ON (ch.tenant_id,ch.id)=(p.tenant_id,p.channel_id) WHERE p.id=$1',
      [job.payload.plan_id],
    )
  ).rows[0];
  ensure(
    row?.state === 'queued' &&
      row.job_id === job.id &&
      row.actor_id === job.payload.actor_id &&
      row.provider === spec.provider &&
      spec.connection(row) === row.input.connection_hash,
    409,
    `Plan lub połączenie ${spec.label} zmieniło się`,
  );
}
/**
 * Runs one creation job under the order's session lock. The provider step creates at most once:
 * its idempotency store is the plan row (phase/remote_id), so a retry after a lost answer
 * reconciles instead of creating again.
 */
export async function processCarrier(
  spec: CarrierSpec,
  job: any,
  ctx: IntegrationContext,
  remote: (client: unknown, p: any, port: CarrierPlanPort) => Promise<CarrierLabel>,
) {
  const lock = lockDbClient(new pg.Client({ connectionString: pool.options.connectionString }), 'carrier-shipping');
  await lock.connect();
  try {
    return await holdingDbLock(lock, async () => {
    const first = await tenantTx(job.tenant_id, (c) => carrierGuard(c, spec, job));
    await lock.query("SET statement_timeout='20s'");
    await lock.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [
      'shipping:' + job.tenant_id + ':' + first.p.order_id,
    ]);
    const { p, ch } = await tenantTx(job.tenant_id, (c) => carrierGuard(c, spec, job, true));
    const port: CarrierPlanPort = {
      current: async () => (await tenantTx(job.tenant_id, (c) => carrierGuard(c, spec, job, true))).p,
      update: (phase, remoteId) =>
        tenantTx(job.tenant_id, async (c) => {
          await carrierGuard(c, spec, job, true);
          await c.query(
            'UPDATE shipping_plans SET phase=$2,remote_id=coalesce($3,remote_id),updated_at=now() WHERE id=$1',
            [p.id, phase, remoteId ?? null],
          );
        }),
    };
    let label: CarrierLabel;
    if (ch.settings.simulation) {
      await port.update('create_started');
      label = { waybill: spec.demoPrefix + p.id.slice(0, 12), label_base64: null, trace_id: null };
    } else {
      label = await channelRead(
        job.tenant_id,
        ch.id,
        (client) => remote(client, p, port),
        {
          ...ctx,
          transport: async (url, init) => {
            // Before each provider request: the lease, the queued plan and the approved account. The
            // business checks ran under the plan lock in the phase write that preceded the request; a
            // light fence here keeps the provider timeout for the provider.
            await fenceTx(job.tenant_id, (c) => carrierFence(c, spec, job));
            const { safeFetch } = await import('./integrations');
            return (ctx.transport ?? safeFetch)(url, init);
          },
        },
        false,
        (current) =>
          ensure(
            spec.connection(current) === p.input.connection_hash,
            409,
            `Połączenie ${spec.label} zmieniło się`,
          ),
      );
      spec.pdf(label.label_base64);
    }
    await tenantTx(job.tenant_id, async (c) => {
      const { p: current, actor } = await carrierGuard(c, spec, job);
      // A reconciled number is persisted in this acceptance transaction before the shipment
      // guard checks the active plan; creation is never repeated.
      if (!ch.settings.simulation && current.phase !== 'numbers_ready') {
        ensure(current.phase === 'create_started', 409, `Plan ${spec.label} nie ma numeru przesyłki`);
        await c.query(
          "UPDATE shipping_plans SET phase='numbers_ready',remote_id=$2,updated_at=now() WHERE id=$1",
          [current.id, label.waybill],
        );
      } else if (!ch.settings.simulation)
        ensure(current.remote_id === label.waybill, 409, `Numer przesyłki ${spec.label} różni się od zapisanego`);
      // A label cancelled with "Anuluj etykietę" is taken over by this one (migration 268).
      const target = await newLabelTargetInTx(c, current.order_id, 'Zamówienie ma już przesyłkę');
      const sid = target ?? randomUUID();
      await automationOnlyEvent(c, job.tenant_id, current.order_id, 'shipment.created', { shipment_id: sid, carrier: CARRIER_NAMES[spec.provider] });
      await writeLabelShipmentInTx(c, target, sid, {
        tenantId: job.tenant_id,
        orderId: current.order_id,
        carrier: CARRIER_NAMES[spec.provider],
        trackingNumber: label.waybill,
        mode: ch.settings.simulation ? 'demo' : ch.mode,
        status: 'label_ready',
        channelId: ch.id,
        externalId: ch.settings.simulation ? null : label.waybill,
        codExpected: current.input.cod,
      });
      const result = {
        ...label,
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
      await audit(c, actor, spec.provider + '.created', p.id, {
        scope: result.scope,
        trace_id: label.trace_id,
      });
    });
    });
  } finally {
    await lock.end();
  }
}
/** The label stored with the plan at creation; never a provider request. */
export async function cachedCarrierLabel(tenant: string, shipment: string, provider: 'dpd' | CarrierProvider, pdf: (b: unknown) => Buffer) {
  return tenantTx(tenant, async (c) => {
    const p = (
      await c.query(
        "SELECT p.* FROM shipping_plans p JOIN shipments s ON (s.tenant_id,s.id)=(p.tenant_id,p.shipment_id) WHERE s.id=$1 AND p.input->>'provider'=$2 AND p.state IN ('ready','dispatched') AND s.tracking_number=p.result->>'tracking_number'",
        [shipment, provider],
      )
    ).rows[0];
    ensure(p?.result?.label_base64, 404, 'Nie znaleziono zapisanej etykiety przesyłki');
    return pdf(p.result.label_base64);
  });
}
/** Routes /api/<provider>-shipping/* on the DPD pattern; preview is the provider's own. */
export function registerCarrierRoutes(
  app: FastifyInstance,
  spec: CarrierSpec,
  preview: (a: PackingActor, orderId: string, body: unknown) => Promise<unknown>,
) {
  const base = '/api/' + spec.provider + '-shipping';
  const id = (p: any) => z.object({ id: z.uuid() }).parse(p).id;
  const write = (req: any) =>
    ensure(['admin', 'operator'].includes(req.actor.role), 403, 'Brak prawa realizacji przesyłek');
  const author = (req: any, p: any) =>
    ensure(
      p.actor_id === req.actor.userId && p.input.provider === spec.provider,
      403,
      `Wymagany autor planu ${spec.label}`,
    );
  app.post(base + '/example', (req) => {
    ensure(req.actor.role === 'admin', 403, 'Wymagany administrator');
    return carrierExample(req.actor, spec);
  });
  app.post('/api/orders/:id/' + spec.provider + '-shipping/preview', (req) => {
    write(req);
    return preview(packingShippingActor(req), id(req.params), req.body);
  });
  app.post(base + '/:id/queue', (req) => {
    write(req);
    const b = z
      .object({
        confirm_external: z.boolean().default(false),
        ack_contract_rate: z.boolean().default(false),
      })
      .parse(req.body ?? {});
    return tenantTx(req.actor.tenantId, async (c) => {
      const { p, o } = await lockedShipping(c, id(req.params));
      author(req, p);
      if (p.state === 'queued') return { id: p.id, job_id: p.job_id };
      ensure(
        p.state === 'preview' &&
          Date.now() - new Date(p.created_at).getTime() < 1800000 &&
          isDeepStrictEqual(await carrierDeliverySnapshot(c, o), p.order_snapshot),
        409,
        'Podgląd wygasł lub zamówienie zmieniło się',
      );
      const ch = (await c.query('SELECT * FROM channels WHERE id=$1 FOR SHARE', [p.channel_id])).rows[0];
      ensure(spec.connection(ch) === p.input.connection_hash, 409, `Połączenie ${spec.label} zmieniło się`);
      ensure(
        ch.settings.simulation || (b.confirm_external && b.ack_contract_rate),
        422,
        'Potwierdź przekazanie danych, utworzenie przesyłki i cenę według umowy',
      );
      await fulfillmentPayment(c, o, p.input.cod);
      const packingActor = packingShippingActor(req);
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
      await newLabelTargetInTx(c, o.id, 'Zamówienie ma już aktywną przesyłkę');
      await audit(c, req.actor, spec.provider + '.queue', p.id, b);
      const result = await carrierJob(c, packingActor, spec, p);
      await pinPackingShippingActorInTx(c, packingActor, Boolean(p.input.packing_snapshot));
      return result;
    });
  });
  app.post(base + '/:id/reconcile', (req) => {
    write(req);
    return tenantTx(req.actor.tenantId, async (c) => {
      const { p } = await lockedShipping(c, id(req.params));
      author(req, p);
      ensure(
        p.state === 'failed' && ['create_started', 'numbers_ready'].includes(p.phase),
        409,
        `Brak niepewnego wyniku ${spec.label} do uzgodnienia`,
      );
      await audit(c, req.actor, spec.provider + '.reconcile', p.id);
      return carrierJob(c, req.actor, spec, p);
    });
  });
  app.post(base + '/:id/dispatch', (req) => {
    write(req);
    return tenantTx(req.actor.tenantId, (c) =>
      dispatchShipping(c, req.actor, id(req.params), undefined, spec.provider),
    );
  });
}
