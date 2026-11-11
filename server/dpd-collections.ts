import { createHash, randomUUID, randomInt } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import pg from 'pg';
import { holdingDbLock, lockDbClient } from './db-lock-holder';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { pool, tenantTx } from './db';
import { audit, type Actor } from './domain';
import { ensure, Problem } from './errors';
import { channelRead, type IntegrationContext } from './channel-access';
import { Dpd } from './integrations';
import { dpdConnection, dpdPdf } from './dpd-shipping';
import { registerDhlPointRoutes } from './dhl-points';
const time = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const base = {
  client_key: z.uuid(),
  plan_ids: z
    .array(z.uuid())
    .min(1)
    .max(200)
    .refine((v) => new Set(v).size === v.length, 'Paczki muszą być różne'),
};
export const collectionInput = z.discriminatedUnion('kind', [
  z.object({ ...base, kind: z.literal('protocol') }).strict(),
  z
    .object({ ...base, kind: z.literal('pickup'), date: z.iso.date(), from: time, to: time })
    .strict(),
]);
export function pickupDate(date: string, from: string, to: string, now = new Date()) {
  const p = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Warsaw',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(now);
  const today = p.slice(0, 10),
    clock = p.slice(11, 16);
  const days = (Date.parse(date + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')) / 86400000;
  ensure(
    Number.isInteger(days) && days >= 0 && days <= 14 && from < to && (days > 0 || from > clock),
    422,
    'Odbiór musi być w przyszłości, do 14 dni, z poprawnymi godzinami czasu polskiego',
  );
}
function snapshot(p: any) {
  return {
    id: p.id,
    channel_id: p.channel_id,
    shipment_id: p.shipment_id,
    tracking_number: p.tracking_number,
    external_id: p.external_id,
    input: p.input,
    reference: p.payload.packages[0].reference,
  };
}
async function plans(
  c: pg.PoolClient,
  ids: string[],
  channel: string,
  kind: string,
  beforeWrite = true,
) {
  const rows = (
    await c.query(
      'SELECT p.*,s.tracking_number,s.external_id,s.carrier FROM shipping_plans p JOIN shipments s ON (s.tenant_id,s.id)=(p.tenant_id,p.shipment_id) WHERE p.id=ANY($1::uuid[]) ORDER BY p.id FOR SHARE OF p,s',
      [ids],
    )
  ).rows;
  ensure(rows.length === ids.length, 404, 'Nie znaleziono wszystkich paczek własnej firmy');
  for (const p of rows)
    ensure(
      p.channel_id === channel &&
        p.input.provider === 'dpd' &&
        p.carrier === 'DPD Polska' &&
        ['ready', 'dispatched'].includes(p.state) &&
        (!(kind === 'pickup' && beforeWrite) || p.state === 'ready'),
      409,
      'Wybierz gotowe paczki DPD z tego konta; odbiór dotyczy paczek jeszcze nieprzekazanych',
    );
  const sender = rows[0].input.sender;
  ensure(
    rows.every((p) => isDeepStrictEqual(p.input.sender, sender)),
    422,
    'Paczki muszą mieć ten sam adres i kontakt nadawcy',
  );
  return rows;
}
const publicRow = (r: any) => {
  const { checksum, ...rest } = r;
  return {
    ...rest,
    result: r.result
      ? Object.fromEntries(Object.entries(r.result).filter(([k]) => k !== 'document_base64'))
      : null,
  };
};
export async function previewCollection(
  a: Actor,
  channel: string,
  b: z.infer<typeof collectionInput>,
) {
  return tenantTx(a.tenantId, (c) => previewCollectionTx(c, a, channel, b));
}
export async function previewCollectionTx(
  c: pg.PoolClient,
  a: Actor,
  channel: string,
  b: z.infer<typeof collectionInput>,
) {
  if (b.kind === 'pickup') pickupDate(b.date, b.from, b.to);
  const normalized = { ...b, plan_ids: [...b.plan_ids].sort() };
  const fingerprint = createHash('sha256')
    .update(JSON.stringify({ channel, normalized }))
    .digest('hex');
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    'dpd-collections:' + a.tenantId + ':' + channel,
  ]);
  const old = (await c.query('SELECT * FROM dpd_collections WHERE client_key=$1', [b.client_key]))
    .rows[0];
  if (old) {
    ensure(old.fingerprint === fingerprint, 409, 'Klucz użyto z innymi paczkami lub terminem');
    return publicRow(old);
  }
  const ch = (await c.query('SELECT * FROM channels WHERE id=$1 FOR SHARE', [channel])).rows[0];
  ensure(ch?.provider === 'dpd', 422, 'Wymagane połączenie DPD');
  const rows = await plans(c, b.plan_ids, channel, b.kind),
    sender = rows[0].input.sender;
  const count = rows.length,
    weight = Math.round(rows.reduce((n, p) => n + p.input.weight, 0) * 100) / 100;
  const id = randomUUID(),
    requested = 'AD1' + randomInt(10000000000, 100000000000);
  const payload =
    b.kind === 'protocol'
      ? {
          protocolSearchParams: {
            policy: 'STOP_ON_FIRST_ERROR',
            session: {
              type: 'DOMESTIC',
              packages: rows.map((p) => ({
                parcels: [
                  { reference: p.payload.packages[0].reference, waybill: p.tracking_number },
                ],
              })),
            },
            pickupAddress: {
              ...sender,
              name: sender.name,
              company: sender.name,
              fid: Number(ch.settings.master_fid),
            },
          },
          outputDocFormat: 'PDF',
        }
      : {
          orderType: 'DOMESTIC',
          orderNumber: requested,
          waybillsReady: true,
          pickupDate: b.date,
          pickupTimeFrom: b.from,
          pickupTimeTo: b.to,
          packagesForCollection: {
            payer: { number: Number(ch.settings.master_fid), name: sender.name },
            orderer: { name: sender.name, fullName: sender.name, phone: sender.phone },
            sender: {
              name: sender.name,
              fullName: sender.name,
              address: sender.address,
              city: sender.city,
              postalCode: sender.postalCode,
              phone: sender.phone,
            },
            packagesParams: {
              doxCount: 0,
              parcel: {
                count,
                weight,
                maxWeight: Math.max(...rows.map((p) => p.input.weight)),
                maxHeight: Math.max(...rows.map((p) => p.input.dimensions.height)),
                maxWidth: Math.max(...rows.map((p) => p.input.dimensions.width)),
                maxDepth: Math.max(...rows.map((p) => p.input.dimensions.length)),
              },
            },
          },
        };
  const input = {
    ...normalized,
    sender,
    count,
    weight,
    mode: ch.mode,
    simulation: !!ch.settings.simulation,
  };
  const r = (
    await c.query(
      'INSERT INTO dpd_collections(id,tenant_id,channel_id,actor_id,kind,client_key,fingerprint,input,payload,connection_hash,requested_number) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *',
      [
        id,
        a.tenantId,
        channel,
        a.userId,
        b.kind,
        b.client_key,
        fingerprint,
        JSON.stringify(input),
        JSON.stringify(payload),
        dpdConnection(ch),
        requested,
      ],
    )
  ).rows[0];
  for (const p of rows)
    await c.query(
      'INSERT INTO dpd_collection_items(tenant_id,collection_id,plan_id,snapshot) VALUES($1,$2,$3,$4)',
      [a.tenantId, id, p.id, JSON.stringify(snapshot(p))],
    );
  await audit(c, a, 'dpd.collection.preview', id, { kind: b.kind, count });
  return publicRow(r);
}
async function locked(c: pg.PoolClient, id: string) {
  const p = (await c.query('SELECT tenant_id,channel_id FROM dpd_collections WHERE id=$1', [id]))
    .rows[0];
  ensure(p, 404, 'Nie znaleziono zlecenia DPD');
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    'dpd-collections:' + p.tenant_id + ':' + p.channel_id,
  ]);
  return (await c.query('SELECT * FROM dpd_collections WHERE id=$1 FOR UPDATE', [id])).rows[0];
}
async function account(c: pg.PoolClient, r: any) {
  const ch = (await c.query('SELECT * FROM channels WHERE id=$1 FOR SHARE', [r.channel_id]))
    .rows[0];
  ensure(
    ch?.provider === 'dpd' && dpdConnection(ch) === r.connection_hash,
    409,
    'Połączenie DPD zmieniło się od podglądu',
  );
  return ch;
}
async function checkItems(c: pg.PoolClient, r: any, beforeWrite: boolean) {
  const items = (
    await c.query('SELECT * FROM dpd_collection_items WHERE collection_id=$1 ORDER BY plan_id', [
      r.id,
    ])
  ).rows;
  const rows = await plans(
    c,
    items.map((i) => i.plan_id),
    r.channel_id,
    r.kind,
    beforeWrite,
  );
  ensure(
    rows.every((p) =>
      isDeepStrictEqual(snapshot(p), items.find((i) => i.plan_id === p.id).snapshot),
    ),
    409,
    'Paczki zmieniły się od podglądu',
  );
  return rows;
}
async function enqueue(c: pg.PoolClient, a: Actor, r: any, action: string) {
  const id = randomUUID();
  await c.query(
    "INSERT INTO jobs(id,tenant_id,kind,payload,dedup_key,max_attempts) VALUES($1,$2,'dpd.collection',$3,$4,3)",
    [
      id,
      a.tenantId,
      JSON.stringify({ collection_id: r.id, channel_id: r.channel_id, actor_id: a.userId, action }),
      'dpd-collection:' + r.id + ':' + id,
    ],
  );
  await c.query(
    'UPDATE dpd_collections SET state=$2,job_id=$3,error=NULL,updated_at=now() WHERE id=$1',
    [r.id, action === 'cancel' ? 'cancel_queued' : 'queued', id],
  );
  return { id: r.id, job_id: id };
}
export async function queueCollection(a: Actor, id: string, confirm: boolean) {
  return tenantTx(a.tenantId, (c) => queueCollectionTx(c, a, id, confirm));
}
export async function queueCollectionTx(c: pg.PoolClient, a: Actor, id: string, confirm: boolean) {
  const r = await locked(c, id);
  ensure(r.actor_id === a.userId, 403, 'Zatwierdza autor podglądu');
  if (r.state === 'queued') return { id: r.id, job_id: r.job_id };
  ensure(
    r.state === 'preview' && Date.now() - new Date(r.created_at).getTime() < 1800000,
    409,
    'Podgląd wygasł lub został zatwierdzony',
  );
  const ch = await account(c, r);
  ensure(
    ch.settings.simulation || confirm,
    422,
    'Potwierdź przekazanie danych i zlecenie DPD według umowy',
  );
  await checkItems(c, r, true);
  if (r.kind === 'pickup') {
    pickupDate(r.input.date, r.input.from, r.input.to);
    ensure(
      !(
        await c.query('SELECT 1 FROM dpd_pickup_claims WHERE plan_id=ANY($1::uuid[])', [
          r.input.plan_ids,
        ])
      ).rowCount,
      409,
      'Co najmniej jedna paczka ma już aktywne lub niepewne zlecenie odbioru',
    );
    for (const pid of r.input.plan_ids)
      await c.query(
        'INSERT INTO dpd_pickup_claims(tenant_id,plan_id,collection_id) VALUES($1,$2,$3)',
        [a.tenantId, pid, r.id],
      );
  }
  await audit(c, a, 'dpd.collection.queue', r.id, { confirmed: confirm, kind: r.kind });
  return enqueue(c, a, r, 'create');
}
async function guard(c: pg.PoolClient, job: any, renew = false) {
  const r = await locked(c, job.payload.collection_id),
    ch = await account(c, r);
  const role = (
    await pool.query('SELECT role FROM memberships WHERE tenant_id=$1 AND user_id=$2', [
      job.tenant_id,
      job.payload.actor_id,
    ])
  ).rows[0]?.role;
  ensure(
    ['admin', 'operator'].includes(role) && r.actor_id === job.payload.actor_id,
    403,
    'Autor nie ma uprawnień do zlecenia DPD',
  );
  ensure(
    r.job_id === job.id &&
      r.channel_id === job.payload.channel_id &&
      r.state === (job.payload.action === 'cancel' ? 'cancel_queued' : 'queued'),
    409,
    'Zlecenie DPD zmieniło się',
  );
  ensure(
    (
      await c.query(
        "UPDATE jobs SET locked_at=CASE WHEN $3 THEN now() ELSE locked_at END WHERE id=$1 AND lease_token=$2 AND state='running' AND locked_at>now()-interval '2 minutes' RETURNING id",
        [job.id, job.lease_token, renew],
      )
    ).rowCount,
    409,
    'Dzierżawa DPD wygasła',
  );
  if (job.payload.action === 'create' && r.schedule_run_id) {
    const scheduled = (
      await c.query(
        `SELECT s.enabled,s.version,s.actor_id,s.connection_hash
      FROM dpd_pickup_schedules s JOIN dpd_pickup_runs x ON (x.tenant_id,x.channel_id)=(s.tenant_id,s.channel_id)
      WHERE x.id=$1 FOR SHARE OF s`,
        [r.schedule_run_id],
      )
    ).rows[0];
    ensure(
      role === 'admin' &&
        scheduled?.enabled &&
        scheduled.version === r.schedule_version &&
        scheduled.actor_id === r.actor_id &&
        scheduled.connection_hash === r.connection_hash,
      409,
      'Harmonogram DPD wyłączono lub zmieniono',
    );
  }
  if (job.payload.action === 'create') {
    await checkItems(c, r, r.phase === 'ready');
    if (r.kind === 'pickup' && r.phase === 'ready')
      pickupDate(r.input.date, r.input.from, r.input.to);
  }
  return { r, ch, actor: { tenantId: job.tenant_id, userId: job.payload.actor_id, role } as Actor };
}
export function verifiedProtocol(raw: any, expected: any[]) {
  ensure(
    raw?.status === 'OK' &&
      raw.session?.statusInfo?.status === 'OK' &&
      Array.isArray(raw.session.packages),
    502,
    'DPD nie potwierdziło protokołu',
  );
  const parcels = raw.session.packages.flatMap((p: any) => {
    ensure(
      p.statusInfo?.status === 'OK' && Array.isArray(p.parcels),
      502,
      'Błędna paczka protokołu DPD',
    );
    return p.parcels;
  });
  ensure(
    parcels.length === expected.length &&
      new Set(parcels.map((p: any) => p.reference)).size === expected.length,
    502,
    'Protokół DPD ma inny zestaw paczek',
  );
  for (const p of parcels) {
    const e = expected.find((e) => e.reference === p.reference);
    ensure(
      p.statusInfo?.status === 'OK' && e && p.waybill === e.waybill,
      502,
      'Protokół DPD nie potwierdza właściwych numerów',
    );
  }
  dpdPdf(raw.documentData);
  return {
    document_base64: raw.documentData,
    document_id: typeof raw.documentId === 'string' ? raw.documentId.slice(0, 100) : null,
  };
}
export function pickupResult(raw: any) {
  ensure(
    raw?.status?.status === 'OK' &&
      typeof raw.orderNumber === 'string' &&
      /^[A-Za-z0-9]{1,40}$/.test(raw.orderNumber) &&
      typeof raw.checkSum === 'string' &&
      /^[A-Za-z0-9-]{8,36}$/.test(raw.checkSum),
    502,
    'DPD nie potwierdziło numeru i sumy zlecenia odbioru',
  );
  return { remote_id: raw.orderNumber, checksum: raw.checkSum };
}
export async function processCollection(job: any, ctx: IntegrationContext = {}) {
  const lock = lockDbClient(new pg.Client({ connectionString: pool.options.connectionString }), 'dpd-collections');
  await lock.connect();
  try {
    return await holdingDbLock(lock, async () => {
    await lock.query("SET statement_timeout='20s'");
    await lock.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [
      'dpd-collection-worker:' + job.tenant_id + ':' + job.payload.channel_id,
    ]);
    let { r, ch } = await tenantTx(job.tenant_id, (c) => guard(c, job, true));
    const action = job.payload.action;
    ensure(
      !(r.kind === 'pickup' && ['create_started', 'cancel_started'].includes(r.phase)),
      409,
      'DPD ma niepewny zapis; potwierdź wynik u dostawcy, bez powtarzania zlecenia',
    );
    const phase =
      action === 'cancel'
        ? 'cancel_started'
        : r.kind === 'pickup'
          ? 'create_started'
          : 'protocol_started';
    // Persist possible write before the transport. A restarted worker never creates another pickup.
    await tenantTx(job.tenant_id, async (c) => {
      await guard(c, job, true);
      await c.query('UPDATE dpd_collections SET phase=$2,updated_at=now() WHERE id=$1', [
        r.id,
        phase,
      ]);
    });
    r = { ...r, phase };
    let raw: any, result: any, proof: any;
    if (ch.settings.simulation) {
      if (action === 'cancel') raw = { status: { status: 'OK' } };
      else if (r.kind === 'pickup')
        raw = {
          status: { status: 'OK' },
          orderNumber: r.requested_number,
          checkSum: 'DEMO-' + r.id.slice(0, 12),
        };
      else result = { local_document: true };
    } else {
      raw = await channelRead(
        job.tenant_id,
        ch.id,
        async (client) => {
          ensure(client instanceof Dpd, 422, 'Wymagane DPD');
          return action === 'cancel'
            ? client.cancelPickup(r.remote_id, r.checksum)
            : r.kind === 'pickup'
              ? client.pickup(r.payload)
              : client.protocol(r.payload);
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
          ensure(dpdConnection(current) === r.connection_hash, 409, 'Połączenie DPD zmieniło się'),
      );
    }
    if (action === 'cancel')
      ensure(
        raw?.status?.status === 'OK' && (!raw.orderNumber || raw.orderNumber === r.remote_id),
        502,
        'DPD nie potwierdziło anulowania odbioru',
      );
    else if (r.kind === 'pickup') proof = pickupResult(raw);
    else if (!result)
      result = verifiedProtocol(
        raw,
        r.payload.protocolSearchParams.session.packages.flatMap((p: any) => p.parcels),
      );
    await tenantTx(job.tenant_id, async (c) => {
      const current = await guard(c, job);
      const scope = ch.settings.simulation
        ? 'local_simulation'
        : ch.mode === 'sandbox'
          ? 'external_sandbox_verified'
          : 'external_api_verified';
      const out = {
        ...r.result,
        ...result,
        scope,
        trace_id: typeof raw?.traceId === 'string' ? raw.traceId.slice(0, 100) : null,
      };
      await c.query(
        "UPDATE dpd_collections SET state=$2,phase='confirmed',remote_id=coalesce($3,remote_id),checksum=coalesce($4,checksum),result=$5,error=NULL,updated_at=now() WHERE id=$1",
        [
          r.id,
          action === 'cancel' ? 'cancelled' : 'ready',
          proof?.remote_id ?? null,
          proof?.checksum ?? null,
          JSON.stringify(out),
        ],
      );
      if (action === 'cancel')
        await c.query('DELETE FROM dpd_pickup_claims WHERE collection_id=$1', [r.id]);
      await c.query(
        "UPDATE jobs SET state='done',lease_token=NULL,locked_at=NULL,error=NULL WHERE id=$1 AND lease_token=$2",
        [job.id, job.lease_token],
      );
      await audit(c, current.actor, 'dpd.collection.' + action, r.id, {
        scope,
        kind: r.kind,
        count: r.input.count,
      });
    });
    });
  } finally {
    await lock.end();
  }
}
export async function failCollection(job: any, e: unknown) {
  return tenantTx(job.tenant_id, async (c) => {
    const changed = await c.query(
      "UPDATE jobs SET state='failed',lease_token=NULL,locked_at=NULL,error=$3 WHERE id=$1 AND lease_token=$2 RETURNING id",
      [job.id, job.lease_token, e instanceof Problem ? e.message : 'Błąd zlecenia DPD'],
    );
    if (!changed.rowCount) return;
    await c.query(
      "UPDATE dpd_collections SET state=CASE WHEN phase IN ('create_started','cancel_started') THEN 'uncertain' ELSE 'failed' END,error=$2,updated_at=now() WHERE id=$1 AND job_id=$3",
      [job.payload.collection_id, e instanceof Problem ? e.message : 'Błąd zlecenia DPD', job.id],
    );
  });
}
export function registerCollectionRoutes(
  app: FastifyInstance,
  ctx: IntegrationContext = {},
  readOnly = false,
) {
  // DHL points.search needs the request IntegrationContext (fake/egress-bound transport, 423 in a
  // read-only copy); the DHL-owned registrations in app.ts receive none, and app.ts is pinned.
  registerDhlPointRoutes(app, ctx);
  const id = (p: any) => z.object({ id: z.uuid() }).parse(p).id;
  const write = (req: any) =>
    ensure(['admin', 'operator'].includes(req.actor.role), 403, 'Brak uprawnień do zleceń DPD');
  app.get('/api/integrations/:id/dpd-collections', async (req) =>
    tenantTx(req.actor.tenantId, async (c) => {
      const channel = id(req.params);
      const q = z.object({ after: z.uuid().optional() }).parse(req.query);
      const ch = (
        await c.query("SELECT id,name,mode,settings FROM channels WHERE id=$1 AND provider='dpd'", [
          channel,
        ])
      ).rows[0];
      ensure(ch, 404, 'Nie znaleziono konta DPD');
      const rows = (
        await c.query(
          "SELECT *,result-'document_base64' AS result FROM dpd_collections WHERE channel_id=$1 AND ($2::uuid IS NULL OR (created_at,id)<(SELECT created_at,id FROM dpd_collections WHERE id=$2 AND channel_id=$1)) ORDER BY created_at DESC,id DESC LIMIT 26",
          [channel, q.after ?? null],
        )
      ).rows;
      return {
        channel: ch,
        data: rows.slice(0, 25).map(publicRow),
        next: rows.length > 25 ? rows[24].id : null,
      };
    }),
  );
  app.get('/api/integrations/:id/dpd-parcels', (req) =>
    tenantTx(req.actor.tenantId, async (c) => {
      const channel = id(req.params),
        q = z
          .object({ after: z.uuid().optional(), q: z.string().max(100).default('') })
          .parse(req.query);
      ensure(
        (await c.query("SELECT id FROM channels WHERE id=$1 AND provider='dpd'", [channel]))
          .rowCount,
        404,
        'Nie znaleziono konta DPD',
      );
      const rows = (
        await c.query(
          "SELECT p.id,p.state,p.created_at,p.input->'sender' sender,p.input->'dimensions' dimensions,p.input->'weight' weight,s.tracking_number,o.number,cl.collection_id AS pickup_id FROM shipping_plans p JOIN shipments s ON (s.tenant_id,s.id)=(p.tenant_id,p.shipment_id) JOIN orders o ON (o.tenant_id,o.id)=(p.tenant_id,p.order_id) LEFT JOIN dpd_pickup_claims cl ON (cl.tenant_id,cl.plan_id)=(p.tenant_id,p.id) WHERE p.channel_id=$1 AND p.state IN ('ready','dispatched') AND p.input->>'provider'='dpd' AND (o.number ILIKE $3 OR s.tracking_number ILIKE $3) AND ($2::uuid IS NULL OR (p.created_at,p.id)<(SELECT created_at,id FROM shipping_plans WHERE id=$2 AND channel_id=$1)) ORDER BY p.created_at DESC,p.id DESC LIMIT 51",
          [channel, q.after ?? null, '%' + q.q + '%'],
        )
      ).rows;
      return { data: rows.slice(0, 50), next: rows.length > 50 ? rows[49].id : null };
    }),
  );
  app.get('/api/integrations/:id/dpd-availability', async (req) => {
    // Calls DPD with the tenant's credentials, so it needs the same role as booking a pickup.
    write(req);
    const channel = id(req.params),
      q = z
        .object({
          postal_code: z
            .string()
            .regex(/^\d{2}-?\d{3}$/)
            .transform((v) => v.replace('-', '')),
        })
        .parse(req.query);
    const ch = await tenantTx(
      req.actor.tenantId,
      async (c) =>
        (await c.query("SELECT * FROM channels WHERE id=$1 AND provider='dpd'", [channel])).rows[0],
    );
    ensure(ch, 404, 'Nie znaleziono konta DPD');
    if (ch.settings.simulation)
      return { scope: 'local_simulation', ranges: [{ range: '09:00-17:00', offset: 0 }] };
    ensure(!readOnly, 423, 'Odczyt dostawcy wyłączony w podglądzie kopii');
    return channelRead(
      req.actor.tenantId,
      channel,
      async (client) => {
        ensure(client instanceof Dpd, 422, 'Wymagane DPD');
        const raw = await client.availability(q.postal_code);
        ensure(
          raw?.status === 'OK' && Array.isArray(raw.ranges),
          502,
          'DPD nie potwierdziło dostępności',
        );
        return {
          scope: ch.mode === 'sandbox' ? 'external_sandbox_verified' : 'external_api_verified',
          ranges: z
            .array(
              z.object({ range: z.string().max(30), offset: z.number().int().min(0).max(100000) }),
            )
            .max(100)
            .parse(raw.ranges),
        };
      },
      ctx,
      true,
    );
  });
  app.post('/api/integrations/:id/dpd-collections', (req) => {
    write(req);
    return previewCollection(req.actor, id(req.params), collectionInput.parse(req.body));
  });
  app.post('/api/dpd-collections/:id/queue', (req) => {
    write(req);
    const b = z.object({ confirm_external: z.boolean().default(false) }).parse(req.body ?? {});
    return queueCollection(req.actor, id(req.params), b.confirm_external);
  });
  app.post('/api/dpd-collections/:id/cancel', (req) => {
    write(req);
    const b = z.object({ confirm_external: z.boolean().default(false) }).parse(req.body ?? {});
    return tenantTx(req.actor.tenantId, async (c) => {
      const r = await locked(c, id(req.params));
      ensure(r.actor_id === req.actor.userId, 403, 'Zlecenie obsługuje autor');
      if (r.state === 'cancelled' || r.state === 'cancel_queued')
        return { id: r.id, job_id: r.job_id };
      if (r.state === 'preview' || (r.state === 'failed' && r.phase === 'ready')) {
        await c.query("UPDATE dpd_collections SET state='cancelled',updated_at=now() WHERE id=$1", [
          r.id,
        ]);
        await c.query('DELETE FROM dpd_pickup_claims WHERE collection_id=$1', [r.id]);
        await audit(c, req.actor, 'dpd.collection.cancel.local', r.id);
        return { id: r.id };
      }
      ensure(
        r.kind === 'pickup' && r.state === 'ready' && r.phase === 'confirmed',
        409,
        'Niepewne zlecenie wymaga potwierdzenia wyniku u DPD',
      );
      const ch = await account(c, r);
      ensure(
        ch.settings.simulation || b.confirm_external,
        422,
        'Potwierdź anulowanie odbioru w DPD',
      );
      return enqueue(c, req.actor, r, 'cancel');
    });
  });
  app.post('/api/dpd-collections/:id/retry', (req) => {
    write(req);
    const b = z.object({ confirm_external: z.boolean().default(false) }).parse(req.body ?? {});
    return tenantTx(req.actor.tenantId, async (c) => {
      const r = await locked(c, id(req.params));
      ensure(
        r.actor_id === req.actor.userId && r.kind === 'protocol' && r.state === 'failed',
        409,
        'Można ponowić tylko nieudany protokół',
      );
      const ch = await account(c, r);
      ensure(
        ch.settings.simulation || b.confirm_external,
        422,
        'Potwierdź ponowne generowanie protokołu',
      );
      await checkItems(c, r, false);
      await audit(c, req.actor, 'dpd.collection.retry', r.id);
      return enqueue(c, req.actor, r, 'create');
    });
  });
  app.post('/api/dpd-collections/:id/resolve', (req) => {
    ensure(req.actor.role === 'admin', 403, 'Potwierdzenia ręcznego dokonuje administrator');
    const b = z
      .object({
        outcome: z.enum(['created', 'not_created', 'cancelled', 'still_active']),
        evidence: z.string().trim().min(10).max(500),
        confirmed: z.literal(true),
        order_number: z
          .string()
          .regex(/^[A-Za-z0-9]{1,40}$/)
          .optional(),
        checksum: z
          .string()
          .regex(/^[A-Za-z0-9-]{8,36}$/)
          .optional(),
      })
      .parse(req.body);
    return tenantTx(req.actor.tenantId, async (c) => {
      const r = await locked(c, id(req.params));
      ensure(
        r.kind === 'pickup' && r.state === 'uncertain',
        409,
        'Brak niepewnego odbioru do potwierdzenia',
      );
      await account(c, r);
      const creating = r.phase === 'create_started';
      ensure(
        creating
          ? ['created', 'not_created'].includes(b.outcome)
          : ['cancelled', 'still_active'].includes(b.outcome),
        422,
        'Wynik nie odpowiada niepewnej operacji',
      );
      if (b.outcome === 'created')
        ensure(b.order_number && b.checksum, 422, 'Podaj numer i sumę potwierdzone u DPD');
      else
        ensure(
          !b.order_number && !b.checksum,
          422,
          'Nie zmieniaj danych wcześniej potwierdzonego zlecenia',
        );
      const active = ['created', 'still_active'].includes(b.outcome);
      await c.query(
        "UPDATE dpd_collections SET state=$2,phase='confirmed',remote_id=coalesce($3,remote_id),checksum=coalesce($4,checksum),actor_id=$5,result=coalesce(result,'{}')||$6::jsonb,error=NULL,updated_at=now() WHERE id=$1",
        [
          r.id,
          active ? 'ready' : 'cancelled',
          b.order_number ?? null,
          b.checksum ?? null,
          req.actor.userId,
          JSON.stringify({
            scope: 'manual_confirmation',
            resolution: b.outcome,
            evidence: b.evidence,
          }),
        ],
      );
      if (!active) await c.query('DELETE FROM dpd_pickup_claims WHERE collection_id=$1', [r.id]);
      await audit(c, req.actor, 'dpd.collection.resolve.manual', r.id, {
        outcome: b.outcome,
        evidence: b.evidence,
      });
      return { id: r.id, scope: 'manual_confirmation' };
    });
  });
  app.get('/api/dpd-collections/:id/document', async (req, reply) => {
    const r = await tenantTx(
      req.actor.tenantId,
      async (c) =>
        (
          await c.query(
            "SELECT * FROM dpd_collections WHERE id=$1 AND kind='protocol' AND state='ready'",
            [id(req.params)],
          )
        ).rows[0],
    );
    ensure(r, 404, 'Nie znaleziono gotowego protokołu');
    reply.header('Cache-Control', 'no-store');
    if (r.input.simulation) {
      const esc = (v: string) =>
        v.replace(
          /[&<>"']/g,
          (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
        );
      return reply
        .type('text/html')
        .send(
          '<!doctype html><html lang="pl"><meta charset="utf-8"><title>Protokół DPD DEMO</title><h1>PROTOKÓŁ TESTOWY — DPD lokalne</h1><p>Lokalna symulacja bez dokumentu dostawcy.</p><p>' +
            r.input.count +
            ' paczek; ' +
            r.input.weight +
            ' kg</p><pre>' +
            esc(JSON.stringify(r.payload.protocolSearchParams.session.packages, null, 2)) +
            '</pre></html>',
        );
    }
    return reply.type('application/pdf').send(dpdPdf(r.result?.document_base64));
  });
}
