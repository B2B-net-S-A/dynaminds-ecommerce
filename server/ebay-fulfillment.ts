import { assertB2bWholeParcelAckInTx } from './b2b-dropship-ack-guard';
import { deferEbayApiJob, reserveEbaySimulation, releaseEbayApi } from './ebay-api-limits';
import { createHash, randomUUID } from 'node:crypto';
import pg, { type PoolClient } from 'pg';
import { holdingDbLock, lockDbClient } from './db-lock-holder';
import { z } from 'zod';
import { pool, tenantTx } from './db';
import { audit, type Actor } from './domain';
import { ensure, Problem } from './errors';
import { channelRead, loadChannel, type IntegrationContext } from './channel-access';
import {
  Ebay,
  ebayId,
  ebayConnectionHash,
  EBAY_FULFILLMENT_WRITE_SCOPE,
  normalizeEbay,
} from './ebay';
import { commerceHash } from './order-status';
import { fenceSync } from './offer-sync';
import { fulfillmentAutoPolicy, type FulfillmentAuto } from './ebay-fulfillment-schedules';
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
export const ebayFulfillmentInput = z
  .object({ shipping_carrier_code: z.string().regex(/^[A-Za-z0-9_]{1,64}$/) })
  .strict();
const refsSchema = z
  .array(
    z.object({
      lineItemId: z
        .string()
        .min(1)
        .max(160)
        .regex(/^[A-Za-z0-9_-]+$/),
      quantity: z.number().int().min(1).max(1000000),
    }),
  )
  .min(1)
  .max(1000);
const refs = (v: unknown) => {
  const lines = refsSchema.parse(v).sort((a, b) => a.lineItemId.localeCompare(b.lineItemId));
  ensure(
    new Set(lines.map((i) => i.lineItemId)).size === lines.length,
    502,
    'Powtórzone ID pozycji realizacji eBay',
  );
  return lines;
};
export function requireEbayFulfillment(ch: any) {
  ensure(ch?.provider === 'ebay', 422, 'Wymagane połączenie eBay');
  ensure(
    ch.settings.simulation ||
      (ch.settings.fulfillment_write === true &&
        (ch.oauth_scopes ?? '').split(' ').includes(EBAY_FULFILLMENT_WRITE_SCOPE)),
    403,
    'Połącz eBay ze zgodą sell.fulfillment na przekazanie wysyłki',
  );
}
async function admin(c: PoolClient, actor: Actor) {
  ensure(
    (await c.query('SELECT offer_sync_is_admin($1) ok', [actor.userId])).rows[0]?.ok,
    403,
    'Wymagana aktualna rola administratora',
  );
}
export async function fulfillmentLocal(c: PoolClient, orderId: string, lock = false) {
  const o = (
    await c.query('SELECT * FROM orders WHERE id=$1' + (lock ? ' FOR SHARE' : ''), [orderId])
  ).rows[0];
  ensure(o, 404, 'Nie znaleziono zamówienia');
  await assertB2bWholeParcelAckInTx(c, orderId);
  ensure(
    o.source === 'ebay' &&
      o.channel_id &&
      o.external_id &&
      o.source_snapshot?.ebay?.field_groups === 'TAX_BREAKDOWN',
    422,
    'Wymagane zaimportowane zamówienie eBay',
  );
  const ch = (
    await c.query('SELECT * FROM channels WHERE id=$1' + (lock ? ' FOR SHARE' : ''), [o.channel_id])
  ).rows[0];
  ensure(ch?.provider === 'ebay', 422, 'Brak połączenia eBay');
  const shipments = (
    await c.query('SELECT * FROM shipments WHERE order_id=$1' + (lock ? ' FOR SHARE' : ''), [o.id])
  ).rows;
  ensure(
    shipments.length === 1,
    409,
    'Potwierdzenie całego zamówienia eBay wymaga dokładnie jednej przesyłki',
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
    'Przesyłka DEMO lub innego środowiska nie może trafić na konto eBay',
  );
  ensure(
    typeof s.tracking_number === 'string' &&
      (ch.settings.simulation ? /^[A-Za-z0-9-]{1,100}$/ : /^[A-Za-z0-9]{1,100}$/).test(
        s.tracking_number,
      ),
    422,
    'eBay wymaga numeru śledzenia bez spacji, myślników i znaków specjalnych',
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
  ensure(inbound, 409, 'Brak pierwotnego powiązania importu eBay');
  const original = normalizeEbay(inbound.raw);
  ensure(
    !original.blockers.length &&
      original.paid &&
      commerceHash(original) === commerceHash(o, o.source_snapshot.items),
    409,
    'Lokalne dane nie odpowiadają potwierdzonemu importowi eBay',
  );
  const lineItems = refs(
    inbound.raw.lineItems.map((i: any) => ({ lineItemId: i.lineItemId, quantity: i.quantity })),
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
  requireEbayFulfillment(ch);
  if (writing)
    ensure(
      !(
        await c.query(
          'SELECT 1 FROM oauth_states WHERE channel_id=$1 AND consumed_at IS NULL AND expires_at>now() LIMIT 1',
          [ch.id],
        )
      ).rowCount,
      409,
      'Dokończ lub anuluj rozpoczętą zgodę OAuth eBay',
    );
}
export function fulfillmentCollection(v: any) {
  ensure(
    v && typeof v === 'object' && !Array.isArray(v),
    502,
    'Nieprawidłowa kolekcja realizacji eBay',
  );
  ensure(
    Number.isInteger(v.total) &&
      v.total >= 0 &&
      v.total <= 500 &&
      Array.isArray(v.fulfillments ?? []) &&
      v.total === (v.fulfillments ?? []).length &&
      !v.next,
    502,
    'Niepełna kolekcja realizacji eBay',
  );
  const values = (v.fulfillments ?? [])
    .map((f: any) => {
      const checked = z
        .object({
          fulfillmentId: z.string().min(1).max(160),
          shippingCarrierCode: z.string().max(64).optional(),
          shipmentTrackingNumber: z.string().max(160).optional(),
          shippedDate: z.iso.datetime().optional(),
        })
        .safeParse(f);
      ensure(checked.success, 502, 'Nieprawidłowe dane realizacji eBay');
      let lineItems;
      try {
        lineItems = refs(f.lineItems);
      } catch {
        throw new Problem(502, 'Nieprawidłowe pozycje realizacji eBay');
      }
      return { ...checked.data, lineItems };
    })
    .sort((a: any, b: any) => a.fulfillmentId.localeCompare(b.fulfillmentId));
  ensure(
    new Set(values.map((f: any) => f.fulfillmentId)).size === values.length,
    502,
    'Powtórzone ID realizacji eBay',
  );
  return values;
}
const matches = (f: any, payload: any) =>
  f.shippingCarrierCode === payload.shippingCarrierCode &&
  f.shipmentTrackingNumber === payload.trackingNumber &&
  hash(f.lineItems) === hash(payload.lineItems) &&
  f.shippedDate &&
  Math.abs(Date.parse(f.shippedDate) - Date.parse(payload.shippedDate)) <= 1000;
function matching(values: any[], payload: any) {
  const found = values.filter((f) => matches(f, payload));
  ensure(found.length <= 1, 409, 'Powtórzony wynik wysyłki u eBay; uzgodnij konto');
  if (found.length) {
    ensure(
      values.length === 1,
      409,
      'Inna realizacja obejmuje ten sam pełny pakiet zamówienia; uzgodnij konto',
    );
  }
  return found[0] ?? null;
}
async function readCollection(
  actor: Actor,
  ch: any,
  orderId: string,
  externalId: string,
  ctx: IntegrationContext,
  fence?: () => Promise<void>,
) {
  await fence?.();
  if (ch.settings.simulation)
    return tenantTx(actor.tenantId, async (c) => {
      const r = (
        await c.query('SELECT fulfillments FROM ebay_fulfillment_simulations WHERE order_id=$1', [
          orderId,
        ])
      ).rows[0];
      return fulfillmentCollection({
        total: r?.fulfillments.length ?? 0,
        fulfillments: r?.fulfillments ?? [],
      });
    });
  return channelRead(
    actor.tenantId,
    ch.id,
    async (client) =>
      fulfillmentCollection(await (client as Ebay).shippingFulfillments(externalId, fence)),
    ctx,
    true,
    async (current) => {
      ensure(
        ebayConnectionHash(current) === ebayConnectionHash(ch),
        409,
        'Połączenie eBay zmieniono',
      );
      await fence?.();
    },
  );
}
async function observed(
  actor: Actor,
  x: Awaited<ReturnType<typeof fulfillmentLocal>>,
  payload: any,
  ctx: IntegrationContext,
  fence?: () => Promise<void>,
) {
  await fence?.();
  const raw = x.ch.settings.simulation
    ? structuredClone(x.raw)
    : await channelRead(
        actor.tenantId,
        x.ch.id,
        (client) => (client as Ebay).order(x.o.external_id, fence),
        ctx,
        true,
        async (current) => {
          ensure(
            ebayConnectionHash(current) === ebayConnectionHash(x.ch),
            409,
            'Połączenie eBay zmieniono',
          );
          await fence?.();
        },
      );
  ensure(
    raw.orderId === x.o.external_id &&
      ['NOT_STARTED', 'IN_PROGRESS', 'FULFILLED'].includes(raw.orderFulfillmentStatus),
    409,
    'Nieprawidłowa realizacja zamówienia eBay',
  );
  const copied = structuredClone(raw);
  copied.orderFulfillmentStatus = 'NOT_STARTED';
  copied.fulfillmentHrefs = [];
  ensure(Array.isArray(copied.lineItems), 502, 'Brak pozycji zamówienia eBay');
  for (const i of copied.lineItems) {
    ensure(
      ['NOT_STARTED', 'IN_PROGRESS', 'FULFILLED'].includes(i.lineItemFulfillmentStatus),
      409,
      'Nieprawidłowy status pozycji eBay',
    );
    i.lineItemFulfillmentStatus = 'NOT_STARTED';
  }
  const normalized = normalizeEbay(copied);
  ensure(
    !normalized.blockers.length &&
      normalized.paid &&
      commerceHash(normalized) === commerceHash(x.o, x.o.source_snapshot.items),
    409,
    'Dane odbiorcy, płatności, kwoty lub pozycje eBay zmieniły się',
  );
  const lineIdentity = (v: any) =>
    v.lineItems
      .map((i: any) => [i.lineItemId, i.sku, i.quantity])
      .sort((a: any, b: any) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  ensure(
    hash(lineIdentity(raw)) === hash(lineIdentity(x.raw)),
    409,
    'ID pozycji, SKU lub ilości eBay zmieniły się',
  );
  const values = await readCollection(actor, x.ch, x.o.id, x.o.external_id, ctx, fence);
  const existing = matching(values, payload);
  if (!existing) {
    ensure(
      raw.orderFulfillmentStatus === 'NOT_STARTED' &&
        raw.lineItems.every((i: any) => i.lineItemFulfillmentStatus === 'NOT_STARTED') &&
        !(raw.fulfillmentHrefs ?? []).length &&
        !values.length,
      409,
      'eBay ma rozpoczętą lub inną wysyłkę; uzgodnij realizację',
    );
  }
  return {
    external_id: x.o.external_id,
    local_version: String(x.o.version),
    fulfillments: values,
    existing: existing?.fulfillmentId ?? null,
    commercial_hash: commerceHash(normalized),
  };
}
export async function previewEbayFulfillment(
  actor: Actor,
  orderId: string,
  input: z.infer<typeof ebayFulfillmentInput>,
  ctx: IntegrationContext = {},
  auto?: FulfillmentAuto,
) {
  const x = await tenantTx(actor.tenantId, async (c) => {
    const x = await fulfillmentLocal(c, orderId);
    await policy(c, actor, x.ch, true);
    await fulfillmentAutoPolicy(c, actor, x.ch, auto, x.s, input.shipping_carrier_code);
    return x;
  });
  const payload = {
    lineItems: x.lineItems,
    shippedDate: new Date(x.s.dispatched_at).toISOString(),
    shippingCarrierCode: input.shipping_carrier_code,
    trackingNumber: x.s.tracking_number,
  };
  const fence = () =>
    tenantTx(actor.tenantId, async (c) => {
      const current = await fulfillmentLocal(c, orderId, true);
      await policy(c, actor, current.ch, true);
      await fulfillmentAutoPolicy(
        c,
        actor,
        current.ch,
        auto,
        current.s,
        input.shipping_carrier_code,
      );
      ensure(
        current.localHash === x.localHash &&
          ebayConnectionHash(current.ch) === ebayConnectionHash(x.ch),
        409,
        'Zamówienie, przesyłkę lub połączenie zmieniono',
      );
    });
  const remote = await observed(actor, x, payload, ctx, fence);
  return tenantTx(actor.tenantId, async (c) => {
    const current = await fulfillmentLocal(c, orderId, true);
    await policy(c, actor, current.ch, true);
    await fulfillmentAutoPolicy(c, actor, current.ch, auto, current.s, input.shipping_carrier_code);
    ensure(
      current.localHash === x.localHash &&
        ebayConnectionHash(current.ch) === ebayConnectionHash(x.ch),
      409,
      'Zamówienie, przesyłkę lub połączenie zmieniono',
    );
    const p = (
      await c.query(
        'INSERT INTO ebay_fulfillment_plans(id,tenant_id,order_id,shipment_id,channel_id,actor_id,local_hash,connection_hash,payload,remote,config_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *',
        [
          randomUUID(),
          actor.tenantId,
          x.o.id,
          x.s.id,
          x.ch.id,
          actor.userId,
          x.localHash,
          ebayConnectionHash(x.ch),
          JSON.stringify(payload),
          JSON.stringify(remote),
          auto?.version ?? null,
        ],
      )
    ).rows[0];
    await audit(c, actor, 'ebay.fulfillment.preview', p.id, {
      order_id: x.o.id,
      simulation: Boolean(x.ch.settings.simulation),
    });
    return p;
  });
}
async function plan(c: PoolClient, id: string, lock = false) {
  const p = (
    await c.query(
      'SELECT * FROM ebay_fulfillment_plans WHERE id=$1' + (lock ? ' FOR UPDATE' : ''),
      [id],
    )
  ).rows[0];
  ensure(p, 404, 'Nie znaleziono podglądu wysyłki eBay');
  return p;
}
export async function queueEbayFulfillment(
  actor: Actor,
  id: string,
  confirm = false,
  auto?: FulfillmentAuto,
) {
  return tenantTx(actor.tenantId, async (c) => {
    let p = await plan(c, id);
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      `ebay-fulfillment-queue:${actor.tenantId}:${p.order_id}`,
    ]);
    const x = await fulfillmentLocal(c, p.order_id, true);
    await policy(c, actor, x.ch, true);
    await fulfillmentAutoPolicy(
      c,
      actor,
      x.ch,
      auto ?? (p.config_version != null ? { version: p.config_version } : undefined),
      x.s,
      p.payload.shippingCarrierCode,
    );
    p = await plan(c, id, true);
    if (['queued', 'done'].includes(p.state)) return p;
    ensure(
      p.state === 'preview' && new Date(p.created_at).getTime() > Date.now() - 30 * 60000,
      409,
      'Podgląd wykorzystano lub wygasł; przygotuj nowy',
    );
    ensure(
      x.localHash === p.local_hash && ebayConnectionHash(x.ch) === p.connection_hash,
      409,
      'Zamówienie, przesyłkę lub połączenie zmieniono',
    );
    ensure(
      x.ch.settings.simulation || confirm,
      422,
      'Potwierdź przekazanie wysyłki do eBay; dostawca może powiadomić kupującego',
    );
    ensure(
      !(
        await c.query(
          "SELECT 1 FROM ebay_fulfillment_plans WHERE order_id=$1 AND (state='queued' OR (state IN ('failed','conflict') AND phase IN ('write_started','verify'))) LIMIT 1",
          [p.order_id],
        )
      ).rowCount,
      409,
      'Trwa lub wymaga uzgodnienia wcześniejsze zgłoszenie wysyłki',
    );
    const job = randomUUID();
    await c.query(
      "INSERT INTO jobs(id,tenant_id,kind,payload,dedup_key) VALUES($1,$2,'ebay.fulfillment',$3,$4)",
      [
        job,
        actor.tenantId,
        JSON.stringify({ plan_id: p.id, channel_id: p.channel_id, actor_id: actor.userId }),
        'ebay.fulfillment:' + p.id,
      ],
    );
    p = (
      await c.query(
        "UPDATE ebay_fulfillment_plans SET state='queued',actor_id=$2,job_id=$3,updated_at=now() WHERE id=$1 RETURNING *",
        [id, actor.userId, job],
      )
    ).rows[0];
    await audit(c, actor, 'ebay.fulfillment.queue', p.id, {
      order_id: p.order_id,
      simulation: Boolean(x.ch.settings.simulation),
    });
    return p;
  });
}
async function resourceLock<T>(tenant: string, orderId: string, fn: () => Promise<T>) {
  const c = lockDbClient(new pg.Client({ connectionString: pool.options.connectionString }), 'ebay-fulfillment');
  await c.connect();
  try {
    return await holdingDbLock(c, async () => {
    await c.query("SET statement_timeout='20s'");
    await c.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [
      `ebay-fulfillment:${tenant}:${orderId}`,
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
    const x = writing ? await fulfillmentLocal(c, p.order_id, true) : null;
    const current =
      x?.ch ??
      (await c.query('SELECT * FROM channels WHERE id=$1 FOR SHARE', [p.channel_id])).rows[0];
    ensure(
      current && ebayConnectionHash(current) === p.connection_hash,
      409,
      'Połączenie eBay zmieniono; uzgodnij pierwotne konto',
    );
    await policy(
      c,
      { tenantId: job.tenant_id, userId: p.actor_id, role: 'admin' },
      current,
      writing,
    );
    if (x) {
      await fulfillmentAutoPolicy(
        c,
        { tenantId: job.tenant_id, userId: p.actor_id, role: 'admin' },
        current,
        p.config_version == null ? undefined : { version: p.config_version },
        x.s,
        p.payload.shippingCarrierCode,
      );
      ensure(x.localHash === p.local_hash, 409, 'Zamówienie lub przesyłkę zmieniono przed zapisem');
    }
    const latest = await plan(c, p.id, true);
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
    current && ebayConnectionHash(current) === p.connection_hash,
    409,
    'Połączenie eBay zmieniono',
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
    "UPDATE ebay_fulfillment_plans SET state='done',phase='done',remote_id=$2,result=$3,error=NULL,updated_at=now() WHERE id=$1",
    [
      p.id,
      found.fulfillmentId,
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
  await audit(c, actor, 'ebay.fulfillment.verified', p.id, {
    order_id: p.order_id,
    remote_id: found.fulfillmentId,
    unchanged,
  });
}
export async function processEbayFulfillment(job: any, ctx: IntegrationContext = {}) {
  const initial = await tenantTx(job.tenant_id, (c) => plan(c, job.payload.plan_id));
  return resourceLock(job.tenant_id, initial.order_id, async () => {
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
      const x = await tenantTx(job.tenant_id, (c) => fulfillmentLocal(c, p.order_id)),
        remote = await observed(actor, x, p.payload, ctx, fence);
      if (remote.existing)
        return tenantTx(job.tenant_id, async (c) => {
          await fenceSyncOrThrow(c, job);
          await admin(c, actor);
          await complete(
            c,
            actor,
            p,
            remote.fulfillments.find((f: any) => f.fulfillmentId === remote.existing),
            true,
            job,
          );
        });
      ensure(hash(remote) === hash(p.remote), 409, 'Realizacja eBay zmieniła się od podglądu');
      const beginWrite = () =>
        tenantTx(job.tenant_id, async (c) => {
          ensure(await fenceSync(c, job, true), 409, 'Wygasła dzierżawa');
          const x = await fulfillmentLocal(c, p.order_id, true);
          await policy(c, actor, x.ch, true);
          await fulfillmentAutoPolicy(
            c,
            actor,
            x.ch,
            p.config_version == null ? undefined : { version: p.config_version },
            x.s,
            p.payload.shippingCarrierCode,
          );
          ensure(
            x.localHash === p.local_hash && ebayConnectionHash(x.ch) === p.connection_hash,
            409,
            'Zmieniono dane przed zapisem',
          );
          const latest = await plan(c, p.id, true);
          ensure(latest.state === 'queued' && latest.phase === 'ready', 409, 'Plan zatrzymano');
          await c.query(
            "UPDATE ebay_fulfillment_plans SET phase='write_started',updated_at=now() WHERE id=$1",
            [p.id],
          );
          return true;
        });
      const writeFence = () => checkpoint(job, p, ch, true);
      let remoteId: string;
      if (ch.settings.simulation) {
        const permit = await reserveEbaySimulation(job.tenant_id, ch.mode, 'fulfillment');
        try {
          await beginWrite();
          await writeFence();
          remoteId = p.payload.trackingNumber;
          await tenantTx(job.tenant_id, async (c) => {
            await fenceSyncOrThrow(c, job);
            const x = await fulfillmentLocal(c, p.order_id, true);
            await policy(c, actor, x.ch, true);
            await fulfillmentAutoPolicy(
              c,
              actor,
              x.ch,
              p.config_version == null ? undefined : { version: p.config_version },
              x.s,
              p.payload.shippingCarrierCode,
            );
            ensure(
              x.localHash === p.local_hash && ebayConnectionHash(x.ch) === p.connection_hash,
              409,
              'Zmieniono dane przed zapisem symulacji',
            );
            const latest = await plan(c, p.id, true);
            ensure(
              latest.state === 'queued' && latest.phase === 'write_started',
              409,
              'Plan zatrzymano',
            );
            const value = {
              fulfillmentId: remoteId,
              lineItems: p.payload.lineItems,
              shippedDate: p.payload.shippedDate,
              shippingCarrierCode: p.payload.shippingCarrierCode,
              shipmentTrackingNumber: p.payload.trackingNumber,
            };
            await c.query(
              'INSERT INTO ebay_fulfillment_simulations(tenant_id,order_id,fulfillments) VALUES($1,$2,$3) ON CONFLICT(tenant_id,order_id) DO UPDATE SET fulfillments=ebay_fulfillment_simulations.fulfillments||excluded.fulfillments',
              [job.tenant_id, p.order_id, JSON.stringify([value])],
            );
          });
        } finally {
          await releaseEbayApi(permit);
        }
      } else
        remoteId = await channelRead(
          job.tenant_id,
          ch.id,
          async (client) => {
            const ebay = client as Ebay;
            if (
              !(await ebay.mutationCheckpoint(
                '/sell/fulfillment/v1/order/' +
                  encodeURIComponent(ebayId(x.o.external_id)) +
                  '/shipping_fulfillment',
                'POST',
                beginWrite,
              ))
            )
              throw new Problem(409, 'Zapis wysyłki zatrzymano przed API');
            return ebay.createShippingFulfillment(ebayId(x.o.external_id), p.payload, writeFence);
          },
          ctx,
          false,
          async (current) => {
            ensure(
              ebayConnectionHash(current) === p.connection_hash,
              409,
              'Połączenie eBay zmieniono',
            );
            await writeFence();
          },
        );
      await tenantTx(job.tenant_id, async (c) => {
        await fenceSyncOrThrow(c, job);
        await c.query(
          "UPDATE ebay_fulfillment_plans SET phase='verify',remote_id=$2,updated_at=now() WHERE id=$1 AND state='queued'",
          [p.id, remoteId],
        );
      });
    }
    const readFence = () => checkpoint(job, p, ch, false);
    const o = await tenantTx(
      job.tenant_id,
      async (c) =>
        (await c.query('SELECT external_id FROM orders WHERE id=$1', [p.order_id])).rows[0],
    );
    const values = await readCollection(
        actor,
        ch,
        p.order_id,
        p.remote.external_id,
        ctx,
        readFence,
      ),
      found = matching(values, p.payload);
    ensure(found, 502, 'eBay nie potwierdził wysyłki; kolejne próby wykonają tylko odczyt');
    await readFence();
    await tenantTx(job.tenant_id, async (c) => {
      await fenceSyncOrThrow(c, job);
      await admin(c, actor);
      const current = (
        await c.query('SELECT * FROM channels WHERE id=$1 FOR SHARE', [p.channel_id])
      ).rows[0];
      ensure(
        current && ebayConnectionHash(current) === p.connection_hash,
        409,
        'Połączenie eBay zmieniono',
      );
      const latest = await plan(c, p.id, true);
      ensure(latest.state === 'queued' && latest.job_id === job.id, 409, 'Plan zatrzymano');
      await complete(c, actor, p, found, false, job);
    });
  });
}
async function fenceSyncOrThrow(c: PoolClient, job: any) {
  ensure(await fenceSync(c, job), 409, 'Wygasła dzierżawa wysyłki eBay');
}
export async function failEbayFulfillment(job: any, e: unknown) {
  if (await deferEbayApiJob(job, e)) return;
  await tenantTx(job.tenant_id, async (c) => {
    if (!(await fenceSync(c, job))) return;
    const p = await plan(c, job.payload.plan_id, true),
      message = e instanceof Problem ? e.message : 'Błąd zgłoszenia wysyłki eBay';
    const terminal =
      (e instanceof Problem && [403, 404, 409, 422].includes(e.status)) ||
      job.attempts >= job.max_attempts;
    await c.query(
      'UPDATE jobs SET state=$2,lease_token=NULL,locked_at=NULL,error=$3,run_at=now()+make_interval(secs=>least(300,power(2,attempts)::int)) WHERE id=$1',
      [job.id, terminal ? 'failed' : 'pending', message],
    );
    if (terminal)
      await c.query(
        "UPDATE ebay_fulfillment_plans SET state=$2,error=$3,updated_at=now() WHERE id=$1 AND state='queued'",
        [p.id, p.phase === 'ready' ? 'conflict' : 'failed', message],
      );
  });
}
export async function cancelEbayFulfillment(actor: Actor, id: string) {
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
      'Wysyłka mogła trafić do eBay; odczytaj wynik',
    );
    if (p.job_id)
      await c.query(
        "UPDATE jobs SET state='failed',lease_token=NULL,locked_at=NULL,error='Anulowano przed zapisem' WHERE id=$1 AND state IN ('pending','running')",
        [p.job_id],
      );
    const saved = (
      await c.query(
        "UPDATE ebay_fulfillment_plans SET state='cancelled',updated_at=now() WHERE id=$1 RETURNING *",
        [id],
      )
    ).rows[0];
    await audit(c, actor, 'ebay.fulfillment.cancel', id, {});
    return saved;
  });
}
export async function reconcileEbayFulfillment(
  actor: Actor,
  id: string,
  ctx: IntegrationContext = {},
  ack = false,
) {
  const initial = await tenantTx(actor.tenantId, (c) => plan(c, id));
  return resourceLock(actor.tenantId, initial.order_id, async () => {
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
      ebayConnectionHash(ch) === p.connection_hash,
      409,
      'Połączenie eBay zmieniono; uzgodnij pierwotne konto',
    );
    const o = await tenantTx(
      actor.tenantId,
      async (c) =>
        (await c.query('SELECT external_id FROM orders WHERE id=$1', [p.order_id])).rows[0],
    );
    const fence = () =>
      tenantTx(actor.tenantId, async (c) => {
        await admin(c, actor);
        const current = (await c.query('SELECT * FROM channels WHERE id=$1 FOR SHARE', [ch.id]))
          .rows[0];
        ensure(
          current && ebayConnectionHash(current) === p.connection_hash,
          409,
          'Połączenie eBay zmieniono',
        );
      });
    const values = await readCollection(actor, ch, p.order_id, p.remote.external_id, ctx, fence),
      found = matching(values, p.payload);
    ensure(
      found || ack,
      409,
      'Odczyt nie potwierdził wysyłki. Uzgodnij ją na koncie eBay; POST nie będzie ponowiony',
    );
    return tenantTx(actor.tenantId, async (c) => {
      await admin(c, actor);
      const current = (await c.query('SELECT * FROM channels WHERE id=$1 FOR SHARE', [ch.id]))
        .rows[0];
      ensure(
        current && ebayConnectionHash(current) === p.connection_hash,
        409,
        'Połączenie eBay zmieniono',
      );
      const latest = await plan(c, id, true);
      ensure(latest.state === p.state && latest.phase === p.phase, 409, 'Plan zmieniono');
      if (found) await complete(c, actor, p, found, false);
      else {
        await c.query(
          "UPDATE ebay_fulfillment_plans SET state='conflict',phase='done',result=$2,error='Rozbieżność uzgodniona ręcznie; brak potwierdzenia zapisu',updated_at=now() WHERE id=$1",
          [id, JSON.stringify({ matched: false, acknowledged: true, fulfillments: values })],
        );
        await audit(c, actor, 'ebay.fulfillment.resolve', id, { matched: false });
      }
      return plan(c, id);
    });
  });
}
