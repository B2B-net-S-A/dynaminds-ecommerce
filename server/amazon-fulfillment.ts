import { assertB2bWholeParcelAckInTx } from './b2b-dropship-ack-guard';
import { deferAmazonApiJob } from './amazon-api-limits';
import { amazonAccountPolicy } from './amazon-account';
import { amazonOfferIdentity } from './amazon-offers';
import { createHash, randomUUID } from 'node:crypto';
import pg, { type PoolClient } from 'pg';
import { holdingDbLock, lockDbClient } from './db-lock-holder';
import { z } from 'zod';
import { pool, tenantTx } from './db';
import { audit, type Actor } from './domain';
import { ensure, Problem } from './errors';
import { channelRead, loadChannel, type IntegrationContext } from './channel-access';
import { Amazon, amazonOrderId, normalizeAmazon, amazonShipmentBody } from './amazon';
import { commerceHash } from './order-status';
import { fenceSync } from './offer-sync';
const hash = (v: unknown) =>
  createHash('sha256')
    .update(
      JSON.stringify(v, (_key, value) =>
        value && typeof value === 'object' && !Array.isArray(value)
          ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
          : value,
      ),
    )
    .digest('hex');
export const amazonFulfillmentInput = z
  .object({
    carrier_code: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9_-]{1,64}$/),
    carrier_name: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(/^[^\x00-\x1f\x7f]+$/)
      .optional(),
    shipping_method: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(/^[^\x00-\x1f\x7f]+$/)
      .optional(),
    cod_collection_method: z.literal('DirectPayment').optional(),
  })
  .strict();
const refs = (value: unknown) => {
  const result = amazonShipmentBody.shape.packageDetail.shape.orderItems
    .parse(value)
    .sort((a, b) => a.orderItemId.localeCompare(b.orderItemId));
  ensure(
    new Set(result.map((i) => i.orderItemId)).size === result.length,
    502,
    'Powtórzone ID pozycji Amazon',
  );
  return result;
};
export function requireAmazonFulfillment(ch: any) {
  ensure(ch?.provider === 'amazon', 422, 'Wymagane połączenie Amazon');
  ensure(
    ch.settings.simulation ||
      (ch.settings.shipment_write === true && ch.settings.selling_partner_id),
    403,
    'Włącz przekazywanie wysyłek Amazon i podaj sprzedawcę. Aplikacja wymaga roli Inventory and Order Tracking',
  );
}
async function admin(c: PoolClient, actor: Actor) {
  ensure(
    (await c.query('SELECT offer_sync_is_admin($1) ok', [actor.userId])).rows[0]?.ok,
    403,
    'Wymagana aktualna rola administratora',
  );
}
export async function amazonFulfillmentLocal(c: PoolClient, orderId: string, lock = false) {
  const o = (
    await c.query('SELECT * FROM orders WHERE id=$1' + (lock ? ' FOR SHARE' : ''), [orderId])
  ).rows[0];
  ensure(o, 404, 'Nie znaleziono zamówienia');
  await assertB2bWholeParcelAckInTx(c, orderId);
  ensure(
    o.source === 'amazon' &&
      o.channel_id &&
      o.external_id &&
      o.source_snapshot?.amazon?.version === '2026-01-01',
    422,
    'Wymagane zaimportowane zamówienie Amazon',
  );
  const ch = (
    await c.query('SELECT * FROM channels WHERE id=$1' + (lock ? ' FOR SHARE' : ''), [o.channel_id])
  ).rows[0];
  ensure(ch?.provider === 'amazon', 422, 'Brak połączenia Amazon');
  const shipments = (
    await c.query('SELECT * FROM shipments WHERE order_id=$1' + (lock ? ' FOR SHARE' : ''), [o.id])
  ).rows;
  ensure(
    shipments.length === 1,
    409,
    'Potwierdzenie całego zamówienia Amazon wymaga dokładnie jednej przesyłki',
  );
  const s = shipments[0];
  ensure(
    s?.dispatched_at && ['shipped', 'delivered', 'completed'].includes(o.status),
    409,
    'Najpierw przekaż całą przesyłkę kurierowi',
  );
  ensure(
    ch.settings.simulation || s.mode === ch.mode,
    422,
    'Przesyłka DEMO lub innego środowiska nie może trafić na konto Amazon',
  );
  ensure(
    typeof s.tracking_number === 'string' && /^[A-Za-z0-9-]{1,100}$/.test(s.tracking_number),
    422,
    'Amazon wymaga poprawnego numeru śledzenia',
  );
  const shipped = new Date(s.dispatched_at);
  ensure(
    Number.isFinite(shipped.getTime()) && shipped.getTime() <= Date.now() + 60000,
    422,
    'Nieprawidłowy czas przekazania przesyłki',
  );
  const inbound = (
    await c.query(
      "SELECT raw,source_hash FROM inbound_orders WHERE order_id=$1 AND channel_id=$2 AND state='imported'",
      [o.id, ch.id],
    )
  ).rows[0];
  ensure(inbound, 409, 'Brak pierwotnego powiązania importu Amazon');
  const original = normalizeAmazon(inbound.raw, ch.settings);
  ensure(
    !original.blockers.length &&
      commerceHash(original) === commerceHash(o, o.source_snapshot.items),
    409,
    'Lokalne dane nie odpowiadają potwierdzonemu importowi Amazon',
  );
  const lineItems = refs(
    inbound.raw.orderItems.map((i: any) => ({
      orderItemId: i.orderItemId,
      quantity: i.quantityOrdered,
    })),
  );
  const localHash = hash({
    version: o.version,
    status: o.status,
    commerce: commerceHash(o, o.source_snapshot.items),
    source: inbound.source_hash,
    raw: hash(inbound.raw),
    snapshot: o.source_snapshot,
    shipment: [s.id, s.carrier, s.tracking_number, s.mode, shipped.toISOString()],
    lineItems,
  });
  return { o, ch, s, raw: inbound.raw, lineItems, localHash };
}
async function policy(c: PoolClient, actor: Actor, ch: any, writing = false) {
  await admin(c, actor);
  await amazonAccountPolicy(c, ch);
  if (writing) requireAmazonFulfillment(ch);
}
const packageSchema = z.object({
  packageReferenceId: z.string().regex(/^[1-9]\d{0,17}$/),
  packageStatus: z
    .object({
      status: z.enum([
        'PENDING',
        'IN_TRANSIT',
        'SHIPPED',
        'DELIVERED',
        'CANCELLED',
        'UNDELIVERABLE',
      ]),
    })
    .optional(),
  carrier: z.string().max(100).optional(),
  trackingNumber: z.string().max(100).optional(),
  shipTime: z.iso.datetime({ offset: true }).optional(),
  shippingService: z.string().max(100).optional(),
  packageItems: z
    .array(
      z.object({
        orderItemId: z.string().regex(/^[A-Za-z0-9_-]{1,160}$/),
        quantity: z.number().int().min(1).max(1000000),
      }),
    )
    .max(100)
    .optional(),
});
export function amazonPackageCollection(value: unknown) {
  const checked = z.array(packageSchema).max(500).safeParse(value);
  ensure(checked.success, 502, 'Nieprawidłowa kolekcja paczek Amazon');
  const values = checked.data.sort((a, b) =>
    a.packageReferenceId.localeCompare(b.packageReferenceId),
  );
  ensure(
    new Set(values.map((p) => p.packageReferenceId)).size === values.length,
    502,
    'Powtórzone ID paczek Amazon',
  );
  for (const v of values) if (v.packageItems) v.packageItems = refs(v.packageItems);
  return values;
}
function matching(values: ReturnType<typeof amazonPackageCollection>, payload: any) {
  const d = payload.packageDetail;
  const same = values.find((v) => v.packageReferenceId === d.packageReferenceId);
  if (!same) return null;
  ensure(
    same.carrier === (d.carrierCode === 'Other' ? d.carrierName : d.carrierCode) &&
      same.trackingNumber === d.trackingNumber &&
      hash(same.packageItems) === hash(d.orderItems) &&
      (!same.shipTime || Math.abs(Date.parse(same.shipTime) - Date.parse(d.shipDate)) <= 1000) &&
      (!d.shippingMethod || same.shippingService === d.shippingMethod),
    409,
    'Amazon ma inną zawartość pod tym ID paczki; uzgodnij konto',
  );
  ensure(values.length === 1, 409, 'Zamówienie Amazon ma więcej paczek; uzgodnij realizację');
  if (
    !same.packageStatus ||
    !['SHIPPED', 'IN_TRANSIT', 'DELIVERED'].includes(same.packageStatus.status)
  )
    return null;
  return same;
}
async function simulatedRemote(c: PoolClient, ch: any, orderId: string) {
  const raw = (
    await c.query(
      "SELECT raw FROM inbound_orders WHERE order_id=$1 AND channel_id=$2 AND state='imported'",
      [orderId, ch.id],
    )
  ).rows[0]?.raw;
  ensure(raw, 409, 'Brak danych przykładu Amazon');
  const values =
    (
      await c.query('SELECT fulfillments FROM amazon_fulfillment_simulations WHERE order_id=$1', [
        orderId,
      ])
    ).rows[0]?.fulfillments ?? [];
  const copy = structuredClone(raw);
  copy.packages = values;
  if (values.length) {
    copy.fulfillment.fulfillmentStatus = 'SHIPPED';
    for (const i of copy.orderItems) {
      i.fulfillment.quantityFulfilled = i.quantityOrdered;
      i.fulfillment.quantityUnfulfilled = 0;
    }
  }
  return copy;
}
/** `local`: the caller's transaction; only a simulation channel is read through it (no HTTP). */
async function readRemote(
  actor: Actor,
  ch: any,
  orderId: string,
  externalId: string,
  ctx: IntegrationContext,
  fence?: () => Promise<void>,
  local?: PoolClient,
) {
  await fence?.();
  if (ch.settings.simulation)
    return local
      ? simulatedRemote(local, ch, orderId)
      : tenantTx(actor.tenantId, (c) => simulatedRemote(c, ch, orderId));
  ensure(!local, 409, 'Odczyt prawdziwego konta Amazon nie może biec w transakcji wywołującego');
  return channelRead(
    actor.tenantId,
    ch.id,
    (client) => (client as Amazon).order(amazonOrderId(externalId), fence),
    ctx,
    true,
    async (current) => {
      ensure(
        amazonOfferIdentity(current) === amazonOfferIdentity(ch),
        409,
        'Połączenie Amazon zmieniono',
      );
      await fence?.();
    },
  );
}
async function readCollection(
  actor: Actor,
  ch: any,
  orderId: string,
  externalId: string,
  ctx: IntegrationContext,
  fence?: () => Promise<void>,
) {
  const raw = await readRemote(actor, ch, orderId, externalId, ctx, fence);
  ensure(
    raw.orderId === externalId && raw.salesChannel?.marketplaceId === ch.settings.marketplace_id,
    502,
    'Amazon zwrócił inne zamówienie lub rynek',
  );
  return amazonPackageCollection(raw.packages ?? []);
}
async function observed(
  actor: Actor,
  x: Awaited<ReturnType<typeof amazonFulfillmentLocal>>,
  payload: any,
  ctx: IntegrationContext,
  fence?: () => Promise<void>,
  local?: PoolClient,
) {
  const raw = await readRemote(actor, x.ch, x.o.id, x.o.external_id, ctx, fence, local);
  ensure(
    raw.orderId === x.o.external_id &&
      raw.fulfillment?.fulfilledBy === 'MERCHANT' &&
      ['UNSHIPPED', 'PARTIALLY_SHIPPED', 'SHIPPED'].includes(raw.fulfillment?.fulfillmentStatus),
    409,
    'Nieprawidłowa realizacja Amazon',
  );
  const values = amazonPackageCollection(raw.packages ?? []),
    copied = structuredClone(raw);
  copied.fulfillment.fulfillmentStatus = 'UNSHIPPED';
  copied.packages = [];
  ensure(Array.isArray(copied.orderItems), 502, 'Brak pozycji Amazon');
  for (const i of copied.orderItems) {
    const fulfilled = i.fulfillment?.quantityFulfilled ?? 0,
      unfulfilled = i.fulfillment?.quantityUnfulfilled ?? i.quantityOrdered;
    ensure(
      Number.isInteger(fulfilled) &&
        fulfilled >= 0 &&
        Number.isInteger(unfulfilled) &&
        unfulfilled >= 0 &&
        fulfilled + unfulfilled === i.quantityOrdered,
      409,
      'Nieprawidłowa ilość realizacji Amazon',
    );
    i.fulfillment = {
      ...i.fulfillment,
      quantityFulfilled: 0,
      quantityUnfulfilled: i.quantityOrdered,
    };
  }
  const normalized = normalizeAmazon(copied, x.ch.settings);
  ensure(
    !normalized.blockers.length &&
      commerceHash(normalized) === commerceHash(x.o, x.o.source_snapshot.items),
    409,
    'Adres, kwoty lub pozycje Amazon zmieniły się',
  );
  const identity = (v: any) =>
    v.orderItems
      .map((i: any) => [i.orderItemId, i.product?.sellerSku, i.quantityOrdered])
      .sort((a: any, b: any) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  ensure(
    hash(identity(raw)) === hash(identity(x.raw)),
    409,
    'ID pozycji, SKU lub ilości Amazon zmieniły się',
  );
  const existing = matching(values, payload);
  if (!existing)
    ensure(
      raw.fulfillment.fulfillmentStatus === 'UNSHIPPED' &&
        !values.length &&
        raw.orderItems.every((i: any) => (i.fulfillment?.quantityFulfilled ?? 0) === 0),
      409,
      'Amazon ma rozpoczętą albo inną wysyłkę; uzgodnij konto',
    );
  return {
    external_id: x.o.external_id,
    local_version: String(x.o.version),
    fulfillments: values,
    existing: existing?.packageReferenceId ?? null,
    commercial_hash: commerceHash(normalized),
  };
}
export async function previewAmazonFulfillment(
  actor: Actor,
  orderId: string,
  input: z.infer<typeof amazonFulfillmentInput>,
  ctx: IntegrationContext = {},
) {
  const x = await tenantTx(actor.tenantId, async (c) => {
    const x = await amazonFulfillmentLocal(c, orderId);
    await policy(c, actor, x.ch, true);
    return x;
  });
  const { id, payload } = previewDraft(x, input);
  const fence = () =>
    tenantTx(actor.tenantId, async (c) => {
      const current = await amazonFulfillmentLocal(c, orderId, true);
      await policy(c, actor, current.ch, true);
      ensure(
        current.localHash === x.localHash &&
          amazonOfferIdentity(current.ch) === amazonOfferIdentity(x.ch),
        409,
        'Zamówienie, przesyłkę lub połączenie zmieniono',
      );
    });
  const remote = await observed(actor, x, payload, ctx, fence);
  return tenantTx(actor.tenantId, async (c) => {
    const current = await amazonFulfillmentLocal(c, orderId, true);
    await policy(c, actor, current.ch, true);
    ensure(
      current.localHash === x.localHash &&
        amazonOfferIdentity(current.ch) === amazonOfferIdentity(x.ch),
      409,
      'Zamówienie, przesyłkę lub połączenie zmieniono',
    );
    return insertPreviewPlan(c, actor, x, id, payload, remote);
  });
}
type LocalFulfillment = Awaited<ReturnType<typeof amazonFulfillmentLocal>>;
function previewDraft(x: LocalFulfillment, input: z.infer<typeof amazonFulfillmentInput>) {
  const id = randomUUID();
  const reference = (
    (BigInt('0x' + hash(id).slice(0, 16)) % 899999999999999999n) +
    100000000000000000n
  ).toString();
  ensure(
    !input.cod_collection_method || x.o.payment_mode === 'cod',
    422,
    'Metoda pobrania wymaga zamówienia COD',
  );
  const payload = amazonShipmentBody.parse({
    marketplaceId: x.ch.settings.marketplace_id,
    ...(input.cod_collection_method ? { codCollectionMethod: input.cod_collection_method } : {}),
    packageDetail: {
      packageReferenceId: reference,
      carrierCode: input.carrier_code,
      ...(input.carrier_name ? { carrierName: input.carrier_name } : {}),
      ...(input.shipping_method ? { shippingMethod: input.shipping_method } : {}),
      trackingNumber: x.s.tracking_number,
      shipDate: new Date(x.s.dispatched_at).toISOString(),
      orderItems: x.lineItems,
    },
  });
  return { id, payload };
}
async function insertPreviewPlan(
  c: PoolClient,
  actor: Actor,
  x: LocalFulfillment,
  id: string,
  payload: unknown,
  remote: unknown,
) {
  const p = (
    await c.query(
      'INSERT INTO amazon_fulfillment_plans(id,tenant_id,order_id,shipment_id,channel_id,actor_id,local_hash,connection_hash,payload,remote,account_scope) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *',
      [
        id,
        actor.tenantId,
        x.o.id,
        x.s.id,
        x.ch.id,
        actor.userId,
        x.localHash,
        amazonOfferIdentity(x.ch),
        JSON.stringify(payload),
        JSON.stringify(remote),
        JSON.stringify([
          x.ch.mode,
          x.ch.settings.region,
          x.ch.settings.selling_partner_id,
          x.o.external_id,
          x.ch.settings.simulation ? actor.tenantId : '',
        ]),
      ],
    )
  ).rows[0];
  await audit(c, actor, 'amazon.fulfillment.preview', p.id, {
    order_id: x.o.id,
    simulation: Boolean(x.ch.settings.simulation),
  });
  return p;
}
/** Preview in the caller's transaction (automation rules). Only a simulation channel: a real
 * account needs provider HTTP between transactions, which the panel's preview performs. */
export async function previewAmazonFulfillmentInTx(
  c: PoolClient,
  actor: Actor,
  orderId: string,
  input: z.infer<typeof amazonFulfillmentInput>,
) {
  const x = await amazonFulfillmentLocal(c, orderId, true);
  await policy(c, actor, x.ch, true);
  ensure(
    x.ch.settings.simulation,
    409,
    'Automatyczne przekazanie działa tylko dla konta Amazon w trybie symulacji; prawdziwe konto potwierdź w panelu zamówienia',
  );
  const { id, payload } = previewDraft(x, input);
  const remote = await observed(actor, x, payload, {}, undefined, c);
  return insertPreviewPlan(c, actor, x, id, payload, remote);
}
async function plan(c: PoolClient, id: string, lock = false) {
  const p = (
    await c.query(
      'SELECT * FROM amazon_fulfillment_plans WHERE id=$1' + (lock ? ' FOR UPDATE' : ''),
      [id],
    )
  ).rows[0];
  ensure(p, 404, 'Nie znaleziono podglądu wysyłki Amazon');
  return p;
}
export async function queueAmazonFulfillment(actor: Actor, id: string, confirm = false) {
  return tenantTx(actor.tenantId, (c) => queueAmazonFulfillmentInTx(c, actor, id, confirm));
}
export async function queueAmazonFulfillmentInTx(
  c: PoolClient,
  actor: Actor,
  id: string,
  confirm = false,
) {
  {
    let p = await plan(c, id);
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      `amazon-fulfillment-queue:${actor.tenantId}:${p.order_id}`,
    ]);
    const x = await amazonFulfillmentLocal(c, p.order_id, true);
    await policy(c, actor, x.ch, true);
    p = await plan(c, id, true);
    if (['queued', 'done'].includes(p.state)) return p;
    ensure(
      p.state === 'preview' && new Date(p.created_at).getTime() > Date.now() - 30 * 60000,
      409,
      'Podgląd wykorzystano lub wygasł; przygotuj nowy',
    );
    ensure(
      x.localHash === p.local_hash && amazonOfferIdentity(x.ch) === p.connection_hash,
      409,
      'Zamówienie, przesyłkę lub połączenie zmieniono',
    );
    ensure(
      x.ch.settings.simulation || confirm,
      422,
      'Potwierdź przekazanie wysyłki do Amazon; dostawca może powiadomić kupującego',
    );
    ensure(
      !(
        await c.query(
          "SELECT 1 FROM amazon_fulfillment_plans WHERE order_id=$1 AND (state='queued' OR (state IN ('failed','conflict') AND phase IN ('write_started','verify'))) LIMIT 1",
          [p.order_id],
        )
      ).rowCount,
      409,
      'Trwa lub wymaga uzgodnienia wcześniejsze zgłoszenie wysyłki',
    );
    ensure(
      (await c.query('SELECT amazon_fulfillment_claim($1) ok', [p.id])).rows[0].ok,
      409,
      'Trwa lub potwierdzono wcześniejsze zgłoszenie tego zamówienia na koncie Amazon',
    );
    const job = randomUUID();
    await c.query(
      "INSERT INTO jobs(id,tenant_id,kind,payload,dedup_key) VALUES($1,$2,'amazon.fulfillment',$3,$4)",
      [
        job,
        actor.tenantId,
        JSON.stringify({ plan_id: p.id, channel_id: p.channel_id, actor_id: actor.userId }),
        'amazon.fulfillment:' + p.id,
      ],
    );
    p = (
      await c.query(
        "UPDATE amazon_fulfillment_plans SET state='queued',actor_id=$2,job_id=$3,updated_at=now() WHERE id=$1 RETURNING *",
        [id, actor.userId, job],
      )
    ).rows[0];
    await audit(c, actor, 'amazon.fulfillment.queue', p.id, {
      order_id: p.order_id,
      simulation: Boolean(x.ch.settings.simulation),
    });
    return p;
  }
}
async function resourceLock<T>(tenant: string, planId: string, fn: () => Promise<T>) {
  const scope = await tenantTx(
    tenant,
    async (c) =>
      (await c.query('SELECT amazon_fulfillment_scope($1) scope', [planId])).rows[0].scope,
  );
  ensure(scope, 404, 'Nie znaleziono planu Amazon');
  const c = lockDbClient(new pg.Client({ connectionString: pool.options.connectionString }), 'amazon-fulfillment');
  await c.connect();
  try {
    return await holdingDbLock(c, async () => {
    await c.query("SET statement_timeout='20s'");
    await c.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [
      `amazon-fulfillment:${scope}`,
    ]);
    return await fn();
    });
  } finally {
    await c.end();
  }
}
async function checkpoint(job: any, p: any, ch: any, writing = false) {
  return tenantTx(job.tenant_id, async (c) => {
    ensure(await fenceSync(c, job, true), 409, 'Wygasła dzierżawa zgłoszenia wysyłki');
    const x = writing ? await amazonFulfillmentLocal(c, p.order_id, true) : null;
    const current =
      x?.ch ??
      (await c.query('SELECT * FROM channels WHERE id=$1 FOR SHARE', [p.channel_id])).rows[0];
    ensure(
      current && amazonOfferIdentity(current) === p.connection_hash,
      409,
      'Połączenie Amazon zmieniono; uzgodnij pierwotne konto',
    );
    await policy(
      c,
      { tenantId: job.tenant_id, userId: p.actor_id, role: 'admin' },
      current,
      writing,
    );
    if (x) {
      ensure(x.localHash === p.local_hash, 409, 'Zamówienie lub przesyłkę zmieniono przed zapisem');
    }
    const latest = await plan(c, p.id, true);
    ensure(
      (await c.query('SELECT amazon_fulfillment_claim($1) ok', [p.id])).rows[0].ok,
      409,
      'Utracono wyłączność zgłoszenia Amazon',
    );
    ensure(
      latest.state === 'queued' && latest.job_id === job.id,
      409,
      'Zapis wysyłki został zatrzymany',
    );
  });
}
async function complete(
  c: PoolClient,
  actor: Actor,
  p: any,
  found: any,
  unchanged: boolean,
  job?: any,
) {
  await admin(c, actor);
  const current = (await c.query('SELECT * FROM channels WHERE id=$1 FOR SHARE', [p.channel_id]))
    .rows[0];
  ensure(
    current && amazonOfferIdentity(current) === p.connection_hash,
    409,
    'Połączenie Amazon zmieniono',
  );
  const latest = await plan(c, p.id, true);
  ensure(
    job
      ? latest.state === 'queued' && latest.job_id === job.id
      : ['failed', 'conflict'].includes(latest.state),
    409,
    'Plan wysyłki zmieniono',
  );
  const local = (await c.query('SELECT version,status FROM orders WHERE id=$1', [p.order_id]))
    .rows[0];
  await c.query(
    "UPDATE amazon_fulfillment_plans SET state='done',phase='done',remote_id=$2,result=$3,error=NULL,updated_at=now() WHERE id=$1",
    [
      p.id,
      found.packageReferenceId,
      JSON.stringify({
        fulfillment: found,
        unchanged,
        local_status: local.status,
        stale_local: String(local.version) !== p.remote.local_version,
        verified_at: new Date().toISOString(),
      }),
    ],
  );
  if (job)
    await c.query(
      "UPDATE jobs SET state='done',lease_token=NULL,locked_at=NULL,error=NULL WHERE id=$1 AND lease_token=$2",
      [job.id, job.lease_token],
    );
  await audit(c, actor, 'amazon.fulfillment.verified', p.id, {
    order_id: p.order_id,
    remote_id: found.packageReferenceId,
    unchanged,
  });
}
export async function processAmazonFulfillment(job: any, ctx: IntegrationContext = {}) {
  const initial = await tenantTx(job.tenant_id, (c) => plan(c, job.payload.plan_id));
  return resourceLock(job.tenant_id, initial.id, async () => {
    const p = await tenantTx(job.tenant_id, (c) => plan(c, initial.id));
    if (p.state !== 'queued')
      return tenantTx(job.tenant_id, async (c) => {
        if (await fenceSync(c, job))
          await c.query(
            "UPDATE jobs SET state='done',lease_token=NULL,locked_at=NULL WHERE id=$1",
            [job.id],
          );
      });
    const actor: Actor = { tenantId: job.tenant_id, userId: p.actor_id, role: 'admin' },
      ch = await loadChannel(job.tenant_id, p.channel_id);
    const fence = () => checkpoint(job, p, ch, p.phase === 'ready');
    await fence();
    if (p.phase === 'ready') {
      const x = await tenantTx(job.tenant_id, (c) => amazonFulfillmentLocal(c, p.order_id)),
        remote = await observed(actor, x, p.payload, ctx, fence);
      if (remote.existing)
        return tenantTx(job.tenant_id, async (c) => {
          await fenceSyncOrThrow(c, job);
          await admin(c, actor);
          await complete(
            c,
            actor,
            p,
            remote.fulfillments.find((f: any) => f.packageReferenceId === remote.existing),
            true,
            job,
          );
        });
      ensure(hash(remote) === hash(p.remote), 409, 'Realizacja Amazon zmieniła się od podglądu');
      const beginWrite = () =>
        tenantTx(job.tenant_id, async (c) => {
          ensure(await fenceSync(c, job, true), 409, 'Wygasła dzierżawa');
          const x = await amazonFulfillmentLocal(c, p.order_id, true);
          await policy(c, actor, x.ch, true);
          ensure(
            x.localHash === p.local_hash && amazonOfferIdentity(x.ch) === p.connection_hash,
            409,
            'Zmieniono dane przed zapisem',
          );
          const latest = await plan(c, p.id, true);
          ensure(latest.state === 'queued' && latest.phase === 'ready', 409, 'Plan zatrzymano');
          await c.query(
            "UPDATE amazon_fulfillment_plans SET phase='write_started',updated_at=now() WHERE id=$1",
            [p.id],
          );
          return true;
        });
      const writeFence = () => checkpoint(job, p, ch, true);
      let remoteId: string;
      if (ch.settings.simulation) {
        await beginWrite();
        await writeFence();
        remoteId = p.payload.packageDetail.packageReferenceId;
        await tenantTx(job.tenant_id, async (c) => {
          await fenceSyncOrThrow(c, job);
          const x = await amazonFulfillmentLocal(c, p.order_id, true);
          await policy(c, actor, x.ch, true);
          ensure(
            x.localHash === p.local_hash && amazonOfferIdentity(x.ch) === p.connection_hash,
            409,
            'Zmieniono dane przed zapisem symulacji',
          );
          const latest = await plan(c, p.id, true);
          ensure(
            latest.state === 'queued' && latest.phase === 'write_started',
            409,
            'Plan zatrzymano',
          );
          const d = p.payload.packageDetail;
          const value = {
            packageReferenceId: remoteId,
            carrier: d.carrierCode === 'Other' ? d.carrierName : d.carrierCode,
            trackingNumber: d.trackingNumber,
            shipTime: d.shipDate,
            packageItems: d.orderItems,
            ...(d.shippingMethod ? { shippingService: d.shippingMethod } : {}),
            packageStatus: { status: 'SHIPPED' },
          };
          await c.query(
            'INSERT INTO amazon_fulfillment_simulations(tenant_id,order_id,fulfillments) VALUES($1,$2,$3) ON CONFLICT(tenant_id,order_id) DO UPDATE SET fulfillments=amazon_fulfillment_simulations.fulfillments||excluded.fulfillments',
            [job.tenant_id, p.order_id, JSON.stringify([value])],
          );
        });
      } else
        remoteId = await channelRead(
          job.tenant_id,
          ch.id,
          async (client) => {
            ensure(client instanceof Amazon, 422, 'Wymagany konektor Amazon');
            return client.confirmShipment(
              x.o.external_id,
              p.payload,
              async () => {
                await beginWrite();
              },
              writeFence,
            );
          },
          ctx,
          false,
          async (current) => {
            ensure(
              amazonOfferIdentity(current) === p.connection_hash,
              409,
              'Połączenie Amazon zmieniono',
            );
            await writeFence();
          },
        );
      await tenantTx(job.tenant_id, async (c) => {
        await fenceSyncOrThrow(c, job);
        await c.query(
          "UPDATE amazon_fulfillment_plans SET phase='verify',remote_id=$2,updated_at=now() WHERE id=$1 AND state='queued'",
          [p.id, remoteId],
        );
      });
    }
    const readFence = () => checkpoint(job, p, ch, false);
    const values = await readCollection(
        actor,
        ch,
        p.order_id,
        p.remote.external_id,
        ctx,
        readFence,
      ),
      found = matching(values, p.payload);
    ensure(found, 502, 'Amazon nie potwierdził wysyłki; kolejne próby wykonają tylko odczyt');
    await readFence();
    await tenantTx(job.tenant_id, async (c) => {
      await fenceSyncOrThrow(c, job);
      await admin(c, actor);
      const current = (
        await c.query('SELECT * FROM channels WHERE id=$1 FOR SHARE', [p.channel_id])
      ).rows[0];
      ensure(
        current && amazonOfferIdentity(current) === p.connection_hash,
        409,
        'Połączenie Amazon zmieniono',
      );
      const latest = await plan(c, p.id, true);
      ensure(latest.state === 'queued' && latest.job_id === job.id, 409, 'Plan zatrzymano');
      await complete(c, actor, p, found, false, job);
    });
  });
}
async function fenceSyncOrThrow(c: PoolClient, job: any) {
  ensure(await fenceSync(c, job), 409, 'Wygasła dzierżawa wysyłki Amazon');
}
export async function failAmazonFulfillment(job: any, e: unknown) {
  if (await deferAmazonApiJob(job, e)) return;
  await tenantTx(job.tenant_id, async (c) => {
    if (!(await fenceSync(c, job))) return;
    const p = await plan(c, job.payload.plan_id, true),
      message = e instanceof Problem ? e.message : 'Błąd zgłoszenia wysyłki Amazon';
    const terminal =
      (e instanceof Problem && [403, 404, 409, 422].includes(e.status)) ||
      job.attempts >= job.max_attempts;
    await c.query(
      'UPDATE jobs SET state=$2,lease_token=NULL,locked_at=NULL,error=$3,run_at=now()+make_interval(secs=>least(300,power(2,attempts)::int)) WHERE id=$1',
      [job.id, terminal ? 'failed' : 'pending', message],
    );
    if (terminal)
      await c.query(
        "UPDATE amazon_fulfillment_plans SET state=$2,error=$3,updated_at=now() WHERE id=$1 AND state='queued'",
        [p.id, p.phase === 'ready' ? 'conflict' : 'failed', message],
      );
    await c.query('SELECT amazon_fulfillment_release($1)', [p.id]);
  });
}
export async function cancelAmazonFulfillment(actor: Actor, id: string) {
  return tenantTx(actor.tenantId, async (c) => {
    await admin(c, actor);
    const initial = await plan(c, id);
    if (initial.job_id)
      await c.query('SELECT id FROM jobs WHERE id=$1 FOR UPDATE', [initial.job_id]);
    const p = await plan(c, id, true);
    if (p.state === 'cancelled') return p;
    ensure(
      ['preview', 'queued'].includes(p.state) && p.phase === 'ready',
      409,
      'Wysyłka mogła trafić do Amazon; odczytaj wynik',
    );
    if (p.job_id)
      await c.query(
        "UPDATE jobs SET state='failed',lease_token=NULL,locked_at=NULL,error='Anulowano przed zapisem' WHERE id=$1 AND state IN ('pending','running')",
        [p.job_id],
      );
    const saved = (
      await c.query(
        "UPDATE amazon_fulfillment_plans SET state='cancelled',updated_at=now() WHERE id=$1 RETURNING *",
        [id],
      )
    ).rows[0];
    await c.query('SELECT amazon_fulfillment_release($1)', [id]);
    await audit(c, actor, 'amazon.fulfillment.cancel', id, {});
    return saved;
  });
}
export async function reconcileAmazonFulfillment(
  actor: Actor,
  id: string,
  ctx: IntegrationContext = {},
  ack = false,
) {
  const initial = await tenantTx(actor.tenantId, (c) => plan(c, id));
  return resourceLock(actor.tenantId, initial.id, async () => {
    const p = await tenantTx(actor.tenantId, async (c) => {
      await admin(c, actor);
      const p = await plan(c, id);
      ensure(
        ['failed', 'conflict'].includes(p.state) && ['write_started', 'verify'].includes(p.phase),
        409,
        'Ten plan nie wymaga uzgodnienia',
      );
      return p;
    });
    const ch = await loadChannel(actor.tenantId, p.channel_id);
    ensure(
      amazonOfferIdentity(ch) === p.connection_hash,
      409,
      'Połączenie Amazon zmieniono; uzgodnij pierwotne konto',
    );
    const fence = () =>
      tenantTx(actor.tenantId, async (c) => {
        const current = (await c.query('SELECT * FROM channels WHERE id=$1 FOR SHARE', [ch.id]))
          .rows[0];
        ensure(
          current && amazonOfferIdentity(current) === p.connection_hash,
          409,
          'Połączenie Amazon zmieniono',
        );
        await policy(c, actor, current, false);
      });
    const values = await readCollection(actor, ch, p.order_id, p.remote.external_id, ctx, fence);
    let found: ReturnType<typeof matching> = null;
    try {
      found = matching(values, p.payload);
    } catch (error) {
      if (!(ack && error instanceof Problem && error.status === 409)) throw error;
    }
    ensure(
      found || ack,
      409,
      'Odczyt nie potwierdził wysyłki. Uzgodnij ją na koncie Amazon; POST nie będzie ponowiony',
    );
    return tenantTx(actor.tenantId, async (c) => {
      await admin(c, actor);
      const current = (await c.query('SELECT * FROM channels WHERE id=$1 FOR SHARE', [ch.id]))
        .rows[0];
      ensure(
        current && amazonOfferIdentity(current) === p.connection_hash,
        409,
        'Połączenie Amazon zmieniono',
      );
      const latest = await plan(c, id, true);
      ensure(latest.state === p.state && latest.phase === p.phase, 409, 'Plan zmieniono');
      if (found) await complete(c, actor, p, found, false);
      else {
        await c.query(
          "UPDATE amazon_fulfillment_plans SET state='conflict',phase='done',result=$2,error='Rozbieżność uzgodniona ręcznie; brak potwierdzenia zapisu',updated_at=now() WHERE id=$1",
          [id, JSON.stringify({ matched: false, acknowledged: true, fulfillments: values })],
        );
        await audit(c, actor, 'amazon.fulfillment.resolve', id, { matched: false });
      }
      return plan(c, id);
    });
  });
}
