import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { pool, tenantTx } from './db';
import { audit, type Actor } from './domain';
import { ensure, Problem } from './errors';
import { channelRead, type IntegrationContext } from './channel-access';
import {
  Dhl,
  dhlConnection,
  dhlFingerprint,
  dhlPickupWindow,
  dhlTime,
  type DhlIdempotencyStore,
  type DhlPickupBooked,
} from './carrier-dhl';
import { CARRIER_NAMES, fenceTx } from './carrier-shipping';

// DHL courier booking (bookCourier / cancelCourierBooking) on the own table dhl234_pickups (234).
// One booking: a set of label-ready DHL shipments of one channel and a pickup window. The booking
// is sent once; a lost answer leaves the row 'uncertain' for a check in DHL24, never a resend.
export const DHL_PICKUP_JOB = 'dhl.pickup';
export const dhlPickupInput = z
  .object({
    client_key: z.uuid(),
    shipment_ids: z
      .array(z.uuid())
      .min(1)
      .max(200)
      .refine((v) => new Set(v).size === v.length, 'Przesyłki muszą być różne'),
    date: z.iso.date(),
    from: dhlTime,
    to: dhlTime,
    postcode: z.string().regex(/^\d{2}-?\d{3}$/).transform((v) => v.replace('-', '')).optional(),
    info: z.string().trim().min(1).max(50).regex(/^[^\x00-\x1f]*$/).optional(),
  })
  .strict();
const publicRow = (r: any) => ({ ...r, connection_hash: undefined, fingerprint: undefined });
async function locked(c: pg.PoolClient, id: string) {
  const r = (await c.query('SELECT tenant_id,channel_id FROM dhl234_pickups WHERE id=$1', [id])).rows[0];
  ensure(r, 404, 'Nie znaleziono zlecenia odbioru DHL');
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    'dhl-pickups:' + r.tenant_id + ':' + r.channel_id,
  ]);
  return (await c.query('SELECT * FROM dhl234_pickups WHERE id=$1 FOR UPDATE', [id])).rows[0];
}
async function account(c: pg.PoolClient, channelId: string, hash?: string) {
  const ch = (await c.query('SELECT * FROM channels WHERE id=$1 FOR SHARE', [channelId])).rows[0];
  ensure(ch?.provider === 'dhl', 404, 'Nie znaleziono konta DHL');
  if (hash) ensure(dhlConnection(ch) === hash, 409, 'Połączenie DHL zmieniło się od podglądu');
  return ch;
}
/** Label-ready, not yet handed over DHL shipments of this channel, each in at most one active booking. */
async function waybillsOf(c: pg.PoolClient, ch: any, ids: string[], pickupId: string | null) {
  const rows = (
    await c.query(
      'SELECT id,tracking_number,mode,dispatched_at FROM shipments WHERE id=ANY($1::uuid[]) AND channel_id=$2 AND carrier=$3 ORDER BY id',
      [ids, ch.id, CARRIER_NAMES.dhl],
    )
  ).rows;
  ensure(rows.length === ids.length, 404, 'Wybierz przesyłki DHL tego połączenia');
  ensure(rows.every((s) => !s.dispatched_at), 409, 'Przesyłka została już przekazana kurierowi');
  const waybills = rows.map((s) => s.tracking_number as string).sort();
  const busy = (
    await c.query(
      "SELECT id FROM dhl234_pickups WHERE channel_id=$1 AND waybills && $2::text[] AND state IN ('queued','booked','uncertain','cancel_queued') AND ($3::uuid IS NULL OR id<>$3)",
      [ch.id, waybills, pickupId],
    )
  ).rowCount;
  ensure(!busy, 409, 'Co najmniej jedna przesyłka ma już aktywne lub niepewne zlecenie odbioru');
  return waybills;
}
export async function previewDhlPickup(a: Actor, channelId: string, body: unknown) {
  const b = dhlPickupInput.parse(body);
  return tenantTx(a.tenantId, async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['dhl-pickups:' + a.tenantId + ':' + channelId]);
    const ch = await account(c, channelId);
    dhlPickupWindow(b.date, b.from, b.to);
    const waybills = await waybillsOf(c, ch, b.shipment_ids, null);
    const payload = { date: b.date, from: b.from, to: b.to, waybills, postcode: b.postcode, info: b.info };
    const fingerprint = dhlFingerprint({ date: b.date, from: b.from, to: b.to, waybills, postcode: b.postcode ?? null, info: b.info ?? null });
    const old = (await c.query('SELECT * FROM dhl234_pickups WHERE client_key=$1', [b.client_key])).rows[0];
    if (old) {
      ensure(old.fingerprint === fingerprint && old.actor_id === a.userId && old.channel_id === ch.id, 409, 'Klucz zlecenia użyto z innymi danymi');
      return publicRow(old);
    }
    const id = randomUUID();
    const row = (
      await c.query(
        'INSERT INTO dhl234_pickups(id,tenant_id,channel_id,actor_id,client_key,fingerprint,input,payload,connection_hash,waybills,requested_number) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *',
        [id, a.tenantId, ch.id, a.userId, b.client_key, fingerprint, JSON.stringify(b), JSON.stringify(payload), dhlConnection(ch), waybills, 'DHL-' + id.replace(/-/g, '').slice(0, 16).toUpperCase()],
      )
    ).rows[0];
    await audit(c, a, 'dhl.pickup.preview', id, { waybills: waybills.length });
    return publicRow(row);
  });
}
async function enqueue(c: pg.PoolClient, a: Actor, r: any, action: 'book' | 'cancel') {
  const id = randomUUID();
  await c.query('INSERT INTO jobs(id,tenant_id,kind,payload,dedup_key,max_attempts) VALUES($1,$2,$3,$4,$5,3)', [
    id,
    a.tenantId,
    DHL_PICKUP_JOB,
    JSON.stringify({ pickup_id: r.id, channel_id: r.channel_id, actor_id: a.userId, action }),
    'dhl-pickup:' + r.id + ':' + id,
  ]);
  await c.query('UPDATE dhl234_pickups SET state=$2,job_id=$3,error=NULL,updated_at=now() WHERE id=$1', [
    r.id,
    action === 'cancel' ? 'cancel_queued' : 'queued',
    id,
  ]);
  return { id: r.id, job_id: id };
}
export async function queueDhlPickup(a: Actor, id: string, confirm: boolean) {
  return tenantTx(a.tenantId, async (c) => {
    const r = await locked(c, id);
    ensure(r.actor_id === a.userId, 403, 'Zatwierdza autor podglądu');
    if (r.state === 'queued') return { id: r.id, job_id: r.job_id };
    ensure(r.state === 'preview' && Date.now() - new Date(r.created_at).getTime() < 1800000, 409, 'Podgląd wygasł lub został zatwierdzony');
    const ch = await account(c, r.channel_id, r.connection_hash);
    ensure(ch.settings.simulation || confirm, 422, 'Potwierdź przekazanie danych i zamówienie kuriera DHL według umowy');
    dhlPickupWindow(r.payload.date, r.payload.from, r.payload.to);
    const current = await waybillsOf(c, ch, r.input.shipment_ids, r.id);
    ensure(JSON.stringify(current) === JSON.stringify(r.waybills), 409, 'Przesyłki zmieniły się od podglądu');
    await audit(c, a, 'dhl.pickup.queue', r.id, { confirmed: confirm });
    return enqueue(c, a, r, 'book');
  });
}
export async function cancelDhlPickup(a: Actor, id: string) {
  return tenantTx(a.tenantId, async (c) => {
    const r = await locked(c, id);
    ensure(r.actor_id === a.userId || a.role === 'admin', 403, 'Anuluje autor zlecenia albo administrator');
    if (['cancelled', 'cancel_queued'].includes(r.state)) return { id: r.id, job_id: r.job_id };
    if (r.state === 'preview' || (r.state === 'failed' && r.phase === 'rejected')) {
      await c.query("UPDATE dhl234_pickups SET state='cancelled',updated_at=now() WHERE id=$1", [r.id]);
      await audit(c, a, 'dhl.pickup.cancel.local', r.id);
      return { id: r.id };
    }
    ensure(r.state === 'booked', 409, 'Niepewne zlecenie odbioru sprawdź w DHL24; anulować można zlecenie potwierdzone');
    await account(c, r.channel_id, r.connection_hash);
    await audit(c, a, 'dhl.pickup.cancel.queue', r.id);
    return enqueue(c, a, r, 'cancel');
  });
}
async function guard(c: pg.PoolClient, job: any, renew = false) {
  const r = await locked(c, job.payload.pickup_id);
  const ch = await account(c, r.channel_id, r.connection_hash);
  const role = (
    await pool.query('SELECT role FROM memberships WHERE tenant_id=$1 AND user_id=$2', [job.tenant_id, job.payload.actor_id])
  ).rows[0]?.role;
  ensure(['admin', 'operator'].includes(role), 403, 'Autor nie ma uprawnień do zlecenia DHL');
  ensure(
    r.job_id === job.id && r.state === (job.payload.action === 'cancel' ? 'cancel_queued' : 'queued'),
    409,
    'Zlecenie odbioru DHL zmieniło się',
  );
  const lease = await c.query(
    "UPDATE jobs SET locked_at=CASE WHEN $3 THEN now() ELSE locked_at END WHERE id=$1 AND lease_token=$2 AND state='running' AND locked_at>now()-interval '2 minutes' RETURNING id",
    [job.id, job.lease_token, renew],
  );
  ensure(lease.rowCount, 409, 'Dzierżawa zlecenia DHL wygasła');
  return { r, ch, actor: { tenantId: job.tenant_id, userId: job.payload.actor_id, role } as Actor };
}
/** Lease, row state and approved account before each DHL request (outside the DHL timeout budget). */
async function fence(c: pg.PoolClient, job: any) {
  const lease = await c.query(
    "UPDATE jobs SET locked_at=now() WHERE id=$1 AND lease_token=$2 AND state='running' AND locked_at>now()-interval '2 minutes' RETURNING id",
    [job.id, job.lease_token],
  );
  ensure(lease.rowCount, 409, 'Dzierżawa zlecenia DHL wygasła');
  const r = (
    await c.query('SELECT r.state,r.job_id,r.connection_hash,ch.provider,ch.mode,ch.settings,ch.credentials FROM dhl234_pickups r JOIN channels ch ON (ch.tenant_id,ch.id)=(r.tenant_id,r.channel_id) WHERE r.id=$1', [job.payload.pickup_id])
  ).rows[0];
  ensure(
    r?.job_id === job.id && r.state === (job.payload.action === 'cancel' ? 'cancel_queued' : 'queued') && r.provider === 'dhl' && dhlConnection(r) === r.connection_hash,
    409,
    'Zlecenie odbioru DHL lub połączenie zmieniło się',
  );
}
const phase = (job: any, values: Record<string, unknown>) =>
  tenantTx(job.tenant_id, async (c) => {
    await guard(c, job, true);
    const keys = Object.keys(values);
    await c.query(
      `UPDATE dhl234_pickups SET ${keys.map((k, i) => `${k}=$${i + 2}`).join(',')},updated_at=now() WHERE id=$1`,
      [job.payload.pickup_id, ...keys.map((k) => values[k])],
    );
  });
/** The pickup row as the client's idempotency store: ready → book_started → booked | rejected. */
function rowStore(job: any): DhlIdempotencyStore {
  return {
    async claim() {
      const current = (await tenantTx(job.tenant_id, (c) => guard(c, job, true))).r;
      if (current.phase === 'ready') {
        await phase(job, { phase: 'book_started' });
        return { state: 'new' };
      }
      if (current.phase === 'booked') return { state: 'done', result: current.result };
      return { state: 'started' };
    },
    async finish(_key, result) {
      await phase(job, { phase: 'booked', state: 'booked', order_ids: (result as DhlPickupBooked).order_ids, result: JSON.stringify(result) });
    },
    async release() {
      await phase(job, { phase: 'rejected' });
    },
  };
}
export async function processDhlPickup(job: any, ctx: IntegrationContext = {}) {
  const { r, ch } = await tenantTx(job.tenant_id, (c) => guard(c, job, true));
  const cancel = job.payload.action === 'cancel';
  if (ch.settings.simulation) {
    if (cancel) await phase(job, { phase: 'cancelled', state: 'cancelled' });
    else {
      if (r.phase === 'ready') await phase(job, { phase: 'book_started' });
      const result = { order_ids: ['DEMO-' + r.id.slice(0, 8).toUpperCase()], date: r.payload.date, from: r.payload.from, to: r.payload.to, waybills: r.waybills, replayed: false, scope: 'local_simulation' };
      await phase(job, { phase: 'booked', state: 'booked', order_ids: result.order_ids, result: JSON.stringify(result) });
    }
  } else
    await channelRead(
      job.tenant_id,
      ch.id,
      async (client) => {
        ensure(client instanceof Dhl, 422, 'Wymagane DHL');
        if (cancel) {
          if (r.phase === 'booked') await phase(job, { phase: 'cancel_started' });
          for (const orderId of r.order_ids) await client.cancelPickup(orderId);
          await phase(job, { phase: 'cancelled', state: 'cancelled' });
          return;
        }
        const booked = await client.withStore(rowStore(job)).bookPickup(
          { date: r.payload.date, from: r.payload.from, to: r.payload.to, waybills: r.waybills, postcode: r.payload.postcode, info: r.payload.info },
          r.id,
        );
        ensure(booked.waybills.join(',') === [...r.waybills].sort().join(','), 409, 'DHL potwierdził inne przesyłki niż w zleceniu');
      },
      {
        ...ctx,
        transport: async (url, init) => {
          await fenceTx(job.tenant_id, (c) => fence(c, job));
          const { safeFetch } = await import('./integrations');
          return (ctx.transport ?? safeFetch)(url, init);
        },
      },
      false,
      (current) => ensure(dhlConnection(current) === r.connection_hash, 409, 'Połączenie DHL zmieniło się'),
    );
  await tenantTx(job.tenant_id, async (c) => {
    const { actor } = await guard(c, job).catch((e) => {
      // The row already left the queued state (booked/cancelled): only the job is closed.
      if (e instanceof Problem && e.status === 409) return { actor: null };
      throw e;
    });
    await c.query("UPDATE jobs SET state='done',lease_token=NULL,locked_at=NULL,error=NULL WHERE id=$1 AND lease_token=$2", [job.id, job.lease_token]);
    if (actor) await audit(c, actor, cancel ? 'dhl.pickup.cancelled' : 'dhl.pickup.booked', r.id);
  });
}
export async function failDhlPickup(job: any, e: unknown) {
  return tenantTx(job.tenant_id, async (c) => {
    const message = e instanceof Problem ? e.message : 'Błąd zlecenia odbioru DHL';
    const changed = await c.query(
      "UPDATE jobs SET state='failed',lease_token=NULL,locked_at=NULL,error=$3 WHERE id=$1 AND lease_token=$2 RETURNING id",
      [job.id, job.lease_token, message],
    );
    if (!changed.rowCount) return;
    await c.query(
      "UPDATE dhl234_pickups SET state=CASE WHEN phase IN ('book_started','cancel_started') THEN 'uncertain' WHEN phase='booked' THEN 'booked' ELSE 'failed' END,error=$2,updated_at=now() WHERE id=$1 AND job_id=$3 AND state IN ('queued','cancel_queued')",
      [job.payload.pickup_id, message.slice(0, 500), job.id],
    );
  });
}
export function registerDhlPickupRoutes(app: FastifyInstance) {
  const id = (p: any) => z.object({ id: z.uuid() }).parse(p).id;
  const write = (req: any) =>
    ensure(['admin', 'operator'].includes(req.actor.role), 403, 'Brak uprawnień do zleceń DHL');
  app.get('/api/integrations/:id/dhl-pickups', (req) =>
    tenantTx(req.actor.tenantId, async (c) => {
      const channel = id(req.params);
      const ch = (await c.query("SELECT id,name,mode,settings FROM channels WHERE id=$1 AND provider='dhl'", [channel])).rows[0];
      ensure(ch, 404, 'Nie znaleziono konta DHL');
      const rows = (
        await c.query('SELECT * FROM dhl234_pickups WHERE channel_id=$1 ORDER BY created_at DESC,id DESC LIMIT 25', [channel])
      ).rows;
      const parcels = (
        await c.query(
          'SELECT s.id,s.tracking_number,s.mode,o.number FROM shipments s JOIN orders o ON (o.tenant_id,o.id)=(s.tenant_id,s.order_id) WHERE s.channel_id=$1 AND s.carrier=$2 AND s.dispatched_at IS NULL ORDER BY s.created_at DESC,s.id DESC LIMIT 50',
          [channel, CARRIER_NAMES.dhl],
        )
      ).rows;
      return { channel: ch, data: rows.map(publicRow), parcels };
    }),
  );
  app.post('/api/integrations/:id/dhl-pickups/preview', (req) => {
    write(req);
    return previewDhlPickup(req.actor, id(req.params), req.body);
  });
  app.post('/api/dhl-pickups/:id/queue', (req) => {
    write(req);
    const b = z.object({ confirm_external: z.boolean().default(false) }).parse(req.body ?? {});
    return queueDhlPickup(req.actor, id(req.params), b.confirm_external);
  });
  app.post('/api/dhl-pickups/:id/cancel', (req) => {
    write(req);
    return cancelDhlPickup(req.actor, id(req.params));
  });
}
