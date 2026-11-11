import { randomUUID, createHash } from 'node:crypto';
import pg from 'pg';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { pool, tenantTx } from './db';
import { audit, type Actor } from './domain';
import { ensure, Problem } from './errors';
import { channelRead, type IntegrationContext } from './channel-access';
import { Dpd, InPost } from './integrations';
import { dpdConnection, dpdPdf, verifiedDpdLabel } from './dpd-shipping';
import { rateMinor } from './shipping';
import { renderDemoShipmentLabel } from './demo-shipment-label-pdf';

// Return labels (L3, migration 254_carrier_returns, prepared as 261): a dispatched DPD or InPost shipment gets a separate
// carrier shipment from the buyer back to the merchant, kept in carrier261_returns and never in
// public.shipments (no new parcel after dispatch, no stock effect). Every external write is preceded
// by a durable phase: a lost answer is resolved by reading (DPD label by reference, ShipX history by
// reference), never by a second create or a second purchase.
export const CARRIER_RETURN_JOB = 'shipping.return';
const CARRIERS = { 'DPD Polska': 'dpd', 'InPost ShipX': 'inpost' } as const;
const dpdAddress = z.object({
  name: z.string().trim().min(2).max(100),
  address: z.string().trim().min(3).max(100),
  city: z.string().trim().min(2).max(50),
  postalCode: z.string().regex(/^\d{2}-?\d{3}$/).transform((v) => v.replace('-', '')),
  countryCode: z.literal('PL').default('PL'),
  phone: z.string().regex(/^\+?\d{9,15}$/),
  email: z.email().max(100),
});
const inpostParty = z.object({
  first_name: z.string().trim().min(1).max(60),
  last_name: z.string().trim().min(1).max(60),
  email: z.email(),
  phone: z.string().trim().regex(/^\+?[0-9]{9,15}$/),
});
export const dpdReturnInput = z
  .object({
    client_key: z.uuid(),
    sender: dpdAddress, // the buyer
    receiver: dpdAddress, // the merchant's return address
    weight: z.number().min(0.01).max(31.5).multipleOf(0.01),
    dimensions: z.object({
      length: z.number().int().min(1).max(175),
      width: z.number().int().min(1).max(175),
      height: z.number().int().min(1).max(175),
    }),
    content: z.string().trim().min(2).max(300),
  })
  .strict();
export const inpostReturnInput = z
  .object({
    client_key: z.uuid(),
    sender: inpostParty, // the buyer drops the parcel at any locker
    receiver: inpostParty, // the merchant
    target_point: z.string().trim().regex(/^[A-Z0-9_-]{3,30}$/),
    template: z.enum(['small', 'medium', 'large']).default('small'),
    weight: z.number().positive().max(25).default(1),
    // The operator approves the highest price in the preview; a dearer offer is never bought.
    max_rate_minor: z.number().int().min(1).max(100000),
  })
  .strict();
const publicRow = (r: any) => (r ? { ...r, connection_hash: undefined, fingerprint: undefined, label_base64: undefined } : r);
const fingerprint = (shipmentId: string, input: Record<string, unknown>) =>
  createHash('sha256').update(JSON.stringify({ shipment_id: shipmentId, ...input, client_key: undefined })).digest('hex');
async function installed(c: pg.PoolClient) {
  const r = (await c.query("SELECT to_regclass('public.carrier261_returns') AS t")).rows[0];
  ensure(r?.t, 503, 'Etykiety zwrotne nie są zainstalowane w tej bazie');
}
/** The dispatched original shipment of a DPD/InPost account, read under the tenant policy. */
async function original(c: pg.PoolClient, shipmentId: string) {
  const s = (await c.query('SELECT * FROM shipments WHERE id=$1 FOR SHARE', [shipmentId])).rows[0];
  ensure(s, 404, 'Nie znaleziono przesyłki');
  const provider = CARRIERS[s.carrier as keyof typeof CARRIERS];
  ensure(provider && s.channel_id, 422, 'Etykietę zwrotną tworzy się dla przesyłek DPD i InPost z połączenia');
  ensure(s.dispatched_at, 409, 'Etykietę zwrotną tworzy się po wydaniu przesyłki');
  const ch = (await c.query('SELECT * FROM channels WHERE id=$1 FOR SHARE', [s.channel_id])).rows[0];
  ensure(ch?.provider === provider, 409, 'Połączenie przewoźnika przesyłki zmieniło się');
  return { s, ch, provider };
}
async function locked(c: pg.PoolClient, id: string) {
  await installed(c);
  const r = (await c.query('SELECT id FROM carrier261_returns WHERE id=$1', [id])).rows[0];
  ensure(r, 404, 'Nie znaleziono etykiety zwrotnej');
  return (await c.query('SELECT * FROM carrier261_returns WHERE id=$1 FOR UPDATE', [id])).rows[0];
}
function returnPayload(provider: 'dpd' | 'inpost', b: any, ch: any, reference: string) {
  if (provider === 'dpd')
    return {
      generationPolicy: 'STOP_ON_FIRST_ERROR',
      packages: [
        {
          reference,
          sender: b.sender,
          receiver: b.receiver,
          payerFID: Number(ch.settings.master_fid),
          services: [],
          parcels: [
            {
              reference,
              weight: b.weight,
              sizeX: b.dimensions.length,
              sizeY: b.dimensions.width,
              sizeZ: b.dimensions.height,
              content: b.content,
            },
          ],
        },
      ],
    };
  return {
    sender: b.sender,
    receiver: b.receiver,
    parcels: [{ template: b.template, weight: { amount: b.weight, unit: 'kg' } }],
    custom_attributes: { sending_method: 'any_point', target_point: b.target_point },
    service: 'inpost_locker_standard',
    reference,
    only_choice_of_offer: true,
  };
}
export async function previewCarrierReturn(a: Actor, shipmentId: string, body: unknown) {
  return tenantTx(a.tenantId, async (c) => {
    await installed(c);
    // Serialises previews of one shipment, so a repeated client key returns the stored row.
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['carrier-return:' + a.tenantId + ':' + shipmentId]);
    const { s, ch, provider } = await original(c, shipmentId);
    const b: any = (provider === 'dpd' ? dpdReturnInput : inpostReturnInput).parse(body);
    if (provider === 'dpd') ensure(/^[1-9]\d{0,9}$/.test(ch.settings.master_fid), 422, 'Wymagane połączenie DPD z Master FID');
    else ensure(/^[1-9]\d{0,17}$/.test(String(ch.settings.organization_id)), 422, 'Wymagane połączenie InPost z organizacją');
    const print = fingerprint(s.id, b);
    const old = (await c.query('SELECT * FROM carrier261_returns WHERE client_key=$1', [b.client_key])).rows[0];
    if (old) {
      ensure(old.fingerprint === print && old.actor_id === a.userId && old.shipment_id === s.id, 409, 'Klucz etykiety zwrotnej użyto z innymi danymi');
      return publicRow(old);
    }
    const id = randomUUID(),
      reference = 'DYNA-' + id;
    const row = (
      await c.query(
        'INSERT INTO carrier261_returns(id,tenant_id,order_id,shipment_id,channel_id,actor_id,provider,client_key,fingerprint,input,payload,connection_hash,reference) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *',
        [id, a.tenantId, s.order_id, s.id, ch.id, a.userId, provider, b.client_key, print, JSON.stringify(b),
          JSON.stringify(returnPayload(provider, b, ch, reference)), dpdConnection(ch), reference],
      )
    ).rows[0];
    await audit(c, a, 'carrier.return.preview', id, { provider });
    return { ...publicRow(row), scope: ch.settings.simulation ? 'local_simulation' : 'external_pending' };
  });
}
async function enqueue(c: pg.PoolClient, a: Actor, r: any) {
  const id = randomUUID();
  await c.query("INSERT INTO jobs(id,tenant_id,kind,payload,dedup_key) VALUES($1,$2,'shipping.return',$3,$4)", [
    id,
    a.tenantId,
    JSON.stringify({ return_id: r.id, channel_id: r.channel_id, actor_id: a.userId }),
    'shipping-return:' + r.id + ':' + id,
  ]);
  await c.query("UPDATE carrier261_returns SET state='queued',job_id=$2,error=NULL,updated_at=now() WHERE id=$1", [r.id, id]);
  return { id: r.id, job_id: id };
}
export async function queueCarrierReturn(a: Actor, id: string, confirm: boolean) {
  return tenantTx(a.tenantId, async (c) => {
    const r = await locked(c, id);
    ensure(r.actor_id === a.userId, 403, 'Zatwierdza autor podglądu');
    if (r.state === 'queued') return { id: r.id, job_id: r.job_id };
    ensure(r.state === 'preview' && Date.now() - new Date(r.created_at).getTime() < 1800000, 409, 'Podgląd wygasł lub został zatwierdzony');
    const { ch } = await original(c, r.shipment_id);
    ensure(ch.id === r.channel_id && dpdConnection(ch) === r.connection_hash, 409, 'Połączenie przewoźnika zmieniło się od podglądu');
    ensure(ch.settings.simulation || confirm, 422, 'Potwierdź przekazanie danych i utworzenie przesyłki zwrotnej według umowy');
    const live = (await c.query("SELECT id FROM carrier261_returns WHERE shipment_id=$1 AND state IN ('queued','label_ready','uncertain') AND id<>$2", [r.shipment_id, r.id])).rowCount;
    ensure(!live, 409, 'Przesyłka ma już etykietę zwrotną w toku lub gotową');
    await audit(c, a, 'carrier.return.queue', r.id, { confirmed: confirm });
    return enqueue(c, a, r);
  });
}
/** Re-reads an uncertain result; the worker never repeats a create or a purchase. */
export async function reconcileCarrierReturn(a: Actor, id: string) {
  return tenantTx(a.tenantId, async (c) => {
    const r = await locked(c, id);
    ensure(r.actor_id === a.userId || a.role === 'admin', 403, 'Uzgadnia autor albo administrator');
    ensure(
      ['uncertain', 'failed'].includes(r.state) && ['create_started', 'created', 'buy_started', 'numbers_ready'].includes(r.phase),
      409,
      'Brak niepewnego wyniku etykiety zwrotnej do uzgodnienia',
    );
    await audit(c, a, 'carrier.return.reconcile', r.id);
    return enqueue(c, a, r);
  });
}
export async function cancelCarrierReturn(a: Actor, id: string) {
  return tenantTx(a.tenantId, async (c) => {
    const r = await locked(c, id);
    ensure(r.actor_id === a.userId || a.role === 'admin', 403, 'Anuluje autor albo administrator');
    if (r.state === 'cancelled') return publicRow(r);
    // A request with no carrier effect (never sent, rejected, or an InPost shipment created but not bought)
    // is withdrawn by its author; an uncertain one only by an administrator after checking the carrier panel.
    ensure(
      r.state === 'preview' ||
        (r.state === 'failed' && ['ready', 'rejected', 'created'].includes(r.phase)) ||
        (r.state === 'uncertain' && a.role === 'admin'),
      409,
      'Etykietę przekazaną przewoźnikowi anuluj u przewoźnika; niepewną wycofuje administrator',
    );
    const row = (await c.query("UPDATE carrier261_returns SET state='cancelled',updated_at=now() WHERE id=$1 RETURNING *", [r.id])).rows[0];
    await audit(c, a, 'carrier.return.cancel', r.id);
    return publicRow(row);
  });
}
export async function carrierReturnLabel(tenant: string, id: string) {
  return tenantTx(tenant, async (c) => {
    await installed(c);
    const r = (await c.query("SELECT label_base64 FROM carrier261_returns WHERE id=$1 AND state='label_ready'", [id])).rows[0];
    ensure(r?.label_base64, 404, 'Nie znaleziono etykiety zwrotnej');
    return dpdPdf(r.label_base64);
  });
}
async function guard(c: pg.PoolClient, job: any, renew = false) {
  const r = await locked(c, job.payload.return_id);
  const ch = (await c.query('SELECT * FROM channels WHERE id=$1 FOR SHARE', [r.channel_id])).rows[0];
  const role = (
    await pool.query('SELECT role FROM memberships WHERE tenant_id=$1 AND user_id=$2', [job.tenant_id, job.payload.actor_id])
  ).rows[0]?.role;
  ensure(['admin', 'operator'].includes(role), 403, 'Autor nie ma prawa realizacji przesyłek');
  ensure(
    r.job_id === job.id && r.state === 'queued' && ch?.provider === r.provider && dpdConnection(ch) === r.connection_hash,
    409,
    'Etykieta zwrotna lub połączenie przewoźnika zmieniło się',
  );
  const lease = await c.query(
    "UPDATE jobs SET locked_at=CASE WHEN $3 THEN now() ELSE locked_at END WHERE id=$1 AND lease_token=$2 AND state='running' AND locked_at>now()-interval '2 minutes' RETURNING id",
    [job.id, job.lease_token, renew],
  );
  ensure(lease.rowCount, 409, 'Dzierżawa etykiety zwrotnej wygasła');
  return { r, ch, actor: { tenantId: job.tenant_id, userId: job.payload.actor_id, role } as Actor };
}
function dpdCreated(raw: any, reference: string) {
  const p = raw?.packages?.[0],
    s = p?.parcels?.[0];
  if (
    raw?.status === 'INCORRECT_DATA' && raw.packages?.length === 1 && p?.reference === reference &&
    (p.parcels ?? []).every((x: any) => !x?.waybill)
  )
    return null;
  ensure(
    raw?.status === 'OK' && raw.packages.length === 1 && p.status === 'OK' && p.reference === reference &&
      p.parcels?.length === 1 && s.status === 'OK' && s.reference === reference &&
      typeof s.waybill === 'string' && /^[A-Za-z0-9]{8,40}$/.test(s.waybill),
    502,
    'DPD nie potwierdziło numeru paczki zwrotnej; uzgodnij wynik',
  );
  return s.waybill as string;
}
const INPOST_BOUGHT = ['confirmed', 'dispatched_by_sender', 'collected_from_sender', 'taken_by_courier', 'adopted_at_source_branch', 'sent_from_source_branch', 'adopted_at_sorting_center', 'sent_from_sorting_center', 'adopted_at_target_branch', 'out_for_delivery', 'ready_to_pickup', 'delivered'];
function inpostOwn(r: any, row: any) {
  ensure(r && r.reference === row.reference, 409, 'Przesyłka InPost nie należy do tej etykiety zwrotnej');
  ensure(
    r.receiver?.email === row.payload.receiver.email && r.custom_attributes?.target_point === row.payload.custom_attributes.target_point &&
      Array.isArray(r.parcels) && r.parcels.length === 1,
    409,
    'Przesyłka zwrotna InPost różni się od podglądu',
  );
  return r;
}
async function inpostReturn(client: InPost, row: any, ch: any, step: (values: Record<string, unknown>) => Promise<void>) {
  let phase = row.phase,
    remote = row.remote_id as string | null;
  if (phase === 'ready') {
    await step({ phase: 'create_started' });
    const created = inpostOwn(await client.createShipment(ch.settings.organization_id, row.payload), row);
    ensure(/^[1-9]\d{0,17}$/.test(String(created.id)), 502, 'InPost nie podał numeru przesyłki zwrotnej');
    remote = String(created.id);
    await step({ phase: 'created', remote_id: remote });
    phase = 'created';
  } else if (phase === 'create_started') {
    // Lost create answer: find the one shipment of this reference; never POST again.
    const list = await client.shipments(ch.settings.organization_id, {
      created_at_gteq: new Date(new Date(row.created_at).getTime() - 300000).toISOString(),
      page: 1,
      per_page: 100,
    });
    const found = (Array.isArray(list?.items) ? list.items : []).filter((x: any) => x.reference === row.reference);
    ensure(found.length === 1, 502, found.length ? 'Niejednoznaczny wynik InPost; uzgodnij ręcznie' : 'Brak potwierdzenia utworzenia zwrotu; nie ponawiam POST');
    remote = String(found[0].id);
    await step({ phase: 'created', remote_id: remote });
    phase = 'created';
  }
  let r = inpostOwn(await client.shipment(remote!), row);
  if (phase === 'created') {
    const offers = (Array.isArray(r.offers) ? r.offers : []).filter(
      (o: any) => o.service?.id === 'inpost_locker_standard' && ['available', 'selected'].includes(o.status),
    );
    ensure(offers.length, 503, 'InPost nie przygotował jeszcze oferty zwrotu');
    ensure(offers.length === 1, 422, 'InPost zwrócił kilka ofert zwrotu; wybierz ręcznie');
    const rate = rateMinor(offers[0].rate);
    ensure(rate !== null && rate <= row.input.max_rate_minor, 422,
      `Cena zwrotu InPost ${((rate ?? 0) / 100).toFixed(2)} zł przekracza zatwierdzony limit; nie kupiono`);
    await step({ phase: 'buy_started', result: JSON.stringify({ offer_id: String(offers[0].id), rate_minor: rate }) });
    await client.buyShipment(remote!, Number(offers[0].id));
    r = inpostOwn(await client.shipment(remote!), row);
  }
  // After buy_started the purchase is only read back, never repeated.
  ensure(
    INPOST_BOUGHT.includes(r.status) && typeof r.tracking_number === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(r.tracking_number),
    502,
    'Brak potwierdzenia zakupu zwrotu InPost; nie ponawiam płatności',
  );
  const pdf = await client.label(remote!);
  return { remote_id: remote!, tracking_number: r.tracking_number as string, label_base64: pdf.toString('base64'), rate_minor: rateMinor(r.selected_offer?.rate) };
}
async function dpdReturn(client: Dpd, row: any, step: (values: Record<string, unknown>) => Promise<void>) {
  let waybill = row.remote_id as string | null;
  if (row.phase === 'ready') {
    await step({ phase: 'create_started' });
    const created = dpdCreated(await client.create(row.payload), row.reference);
    if (!created) {
      await step({ phase: 'rejected' });
      ensure(false, 422, 'DPD odrzuciło dane zwrotu bez numeru; anuluj i popraw dane');
    }
    waybill = created;
    await step({ phase: 'numbers_ready', remote_id: waybill, tracking_number: waybill });
  }
  // A lost create answer is resolved by the exact reference; never repeat create.
  const label = verifiedDpdLabel(await client.labels(row.reference), row.reference, waybill);
  return { remote_id: label.waybill, tracking_number: label.waybill, label_base64: label.label_base64, rate_minor: null };
}
export async function processCarrierReturn(job: any, ctx: IntegrationContext = {}) {
  const { r, ch } = await tenantTx(job.tenant_id, (c) => guard(c, job, true));
  const step = (values: Record<string, unknown>) =>
    tenantTx(job.tenant_id, async (c) => {
      await guard(c, job, true);
      const keys = Object.keys(values);
      await c.query(`UPDATE carrier261_returns SET ${keys.map((k, i) => `${k}=$${i + 2}`).join(',')},updated_at=now() WHERE id=$1`,
        [r.id, ...keys.map((k) => values[k])]);
    });
  let done: { remote_id: string; tracking_number: string; label_base64: string; rate_minor: number | null };
  if (ch.settings.simulation) {
    if (r.phase === 'ready') await step({ phase: 'create_started' });
    const tracking = 'DEMO-RET-' + r.id.slice(0, 12);
    const party = r.input.receiver;
    const pdf = await renderDemoShipmentLabel({
      order_number: 'Zwrot ' + r.reference.slice(5, 13),
      tracking_number: tracking,
      carrier: r.provider === 'dpd' ? 'DPD Polska (zwrot)' : 'InPost (zwrot)',
      recipient: {
        name: party.name ?? `${party.first_name} ${party.last_name}`,
        address: r.provider === 'dpd'
          ? { street: party.address, postal_code: party.postalCode, city: party.city, country: 'PL' }
          : { street: 'Paczkomat ' + r.input.target_point, postal_code: '-', city: '-', country: 'PL' },
      },
    });
    done = { remote_id: tracking, tracking_number: tracking, label_base64: pdf.toString('base64'), rate_minor: null };
  } else
    done = await channelRead(
      job.tenant_id,
      ch.id,
      async (client) => {
        if (r.provider === 'dpd') {
          ensure(client instanceof Dpd, 422, 'Wymagane DPD');
          return dpdReturn(client, r, step);
        }
        ensure(client instanceof InPost, 422, 'Wymagany InPost');
        return inpostReturn(client, r, ch, step);
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
    );
  dpdPdf(done.label_base64);
  await tenantTx(job.tenant_id, async (c) => {
    const { r: current, actor } = await guard(c, job);
    const scope = ch.settings.simulation ? 'local_simulation' : ch.mode === 'sandbox' ? 'external_sandbox_verified' : 'external_api_verified';
    await c.query(
      "UPDATE carrier261_returns SET state='label_ready',phase='confirmed',remote_id=$2,tracking_number=$3,label_base64=$4,result=$5,error=NULL,updated_at=now() WHERE id=$1",
      [current.id, done.remote_id, done.tracking_number, done.label_base64,
        JSON.stringify({ ...(current.result ?? {}), scope, tracking_number: done.tracking_number, rate_minor: done.rate_minor })],
    );
    await c.query("UPDATE jobs SET state='done',lease_token=NULL,locked_at=NULL,error=NULL WHERE id=$1", [job.id]);
    await audit(c, actor, 'carrier.return.label', current.id, { scope });
  });
}
export async function failCarrierReturn(job: any, e: unknown) {
  return tenantTx(job.tenant_id, async (c) => {
    const terminal = (e instanceof Problem && [403, 404, 409, 422].includes(e.status)) || job.attempts >= job.max_attempts;
    const message = e instanceof Problem ? e.message : 'Błąd etykiety zwrotnej';
    const changed = await c.query(
      'UPDATE jobs SET state=$3,error=$4,lease_token=NULL,locked_at=NULL,run_at=now()+make_interval(secs=>least(300,power(2,attempts)::int)) WHERE id=$1 AND lease_token=$2 RETURNING id',
      [job.id, job.lease_token, terminal ? 'failed' : 'pending', message],
    );
    if (!changed.rowCount || !(await c.query("SELECT to_regclass('public.carrier261_returns') t")).rows[0].t) return;
    // A started external step without a read-back confirmation stays uncertain, never failed. An InPost
    // shipment created but not bought ('created': price ceiling, several offers) cost nothing: failed.
    await c.query(
      `UPDATE carrier261_returns SET state=CASE WHEN NOT $3 THEN state WHEN phase IN ('create_started','buy_started','numbers_ready') THEN 'uncertain' ELSE 'failed' END,
       error=$2,updated_at=now() WHERE id=$1 AND job_id=$4 AND state='queued'`,
      [job.payload.return_id, message.slice(0, 500), terminal, job.id],
    );
  });
}
export function registerCarrierReturnRoutes(app: FastifyInstance) {
  const id = (p: any) => z.object({ id: z.uuid() }).parse(p).id;
  const write = (req: any) => ensure(['admin', 'operator'].includes(req.actor.role), 403, 'Brak prawa realizacji przesyłek');
  app.get('/api/shipments/:id/returns', (req) =>
    tenantTx(req.actor.tenantId, async (c) => {
      await installed(c);
      const s = (await c.query('SELECT id,carrier,dispatched_at FROM shipments WHERE id=$1', [id(req.params)])).rows[0];
      ensure(s, 404, 'Nie znaleziono przesyłki');
      const rows = (await c.query('SELECT r.*,j.state AS job_state FROM carrier261_returns r LEFT JOIN jobs j ON j.id=r.job_id WHERE r.shipment_id=$1 ORDER BY r.created_at DESC,r.id DESC LIMIT 25', [s.id])).rows;
      return { shipment: s, provider: CARRIERS[s.carrier as keyof typeof CARRIERS] ?? null, data: rows.map(publicRow) };
    }),
  );
  app.post('/api/shipments/:id/returns/preview', (req) => {
    write(req);
    return previewCarrierReturn(req.actor, id(req.params), req.body);
  });
  app.post('/api/carrier-returns/:id/queue', (req) => {
    write(req);
    const b = z.object({ confirm_external: z.boolean().default(false) }).parse(req.body ?? {});
    return queueCarrierReturn(req.actor, id(req.params), b.confirm_external);
  });
  app.post('/api/carrier-returns/:id/reconcile', (req) => {
    write(req);
    return reconcileCarrierReturn(req.actor, id(req.params));
  });
  app.post('/api/carrier-returns/:id/cancel', (req) => {
    write(req);
    return cancelCarrierReturn(req.actor, id(req.params));
  });
  app.get('/api/carrier-returns/:id/label', async (req, reply) => {
    const pdf = await carrierReturnLabel(req.actor.tenantId, id(req.params));
    return reply.type('application/pdf').header('Cache-Control', 'no-store').send(pdf);
  });
}
