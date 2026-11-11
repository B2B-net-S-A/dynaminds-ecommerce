import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { tenantTx, tenantReadTx } from './db';
import { pickingPdfSnapshot, renderPickingWavePdf } from './picking-wave-pdf';
import { decodePage, encodePage } from './inventory';
import { ensure } from './errors';
import {
  waveSelection,
  waveCreateInput,
  waveScanInput,
  waveVersion,
  previewWave,
  createWave,
  waveDetail,
  scanWave,
  closeWave,
} from './picking-waves';

const page = z.strictObject({
  warehouse_id: z.uuid().optional(),
  state: z.enum(['picking', 'completed', 'cancelled', 'all']).default('picking'),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  after: z.string().min(1).max(500).optional(),
});
const candidates = z.strictObject({
  warehouse_id: z.uuid(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  after: z.string().min(1).max(500).optional(),
});
const cursor = z.strictObject({
  tenant: z.uuid(),
  filter: z.string().regex(/^[a-f0-9]{64}$/),
  time: z.iso.datetime({ precision: 6 }),
  id: z.uuid(),
});
const idOf = (params: unknown) => z.object({ id: z.uuid() }).parse(params).id;
function context(req: any, q: { after?: string }, filters: unknown) {
  const filter = createHash('sha256').update(JSON.stringify(filters)).digest('hex'),
    after = decodePage(q.after, cursor);
  ensure(
    !after || (after.tenant === req.actor.tenantId && after.filter === filter),
    422,
    'Kursor należy do innej firmy lub innych filtrów',
  );
  return { filter, after };
}
function response(rows: any[], q: { limit: number }, tenant: string, filter: string) {
  const data = rows.slice(0, q.limit),
    last = data.at(-1);
  return {
    data: data.map(({ page_time, ...row }) => row),
    next:
      rows.length > q.limit && last
        ? encodePage({ tenant, filter, time: last.page_time, id: last.id })
        : null,
  };
}
export function registerPickingWaveRoutes(app: FastifyInstance, available = true) {
  const scoped = <T>(req: any, run: (c: PoolClient) => Promise<T>) => {
    ensure(available, 404, 'Partie kompletacji są niedostępne w tej wersji kopii zapasowej');
    return tenantTx(req.actor.tenantId, run);
  };
  app.get('/api/picking-waves/candidates', async (req) => {
    const q = candidates.parse(req.query),
      { filter, after } = context(req, q, ['candidates', q.warehouse_id]);
    return scoped(req, async (c) => {
      const rows = (
        await c.query(
          `WITH picked AS (SELECT o.id,o.number,o.status,o.payment_mode,o.total,o.currency,o.created_at,
        to_char(o.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') page_time
        FROM orders o WHERE o.warehouse_id=$1 AND o.status IN ('paid','picking')
        AND NOT EXISTS(SELECT 1 FROM picking_wave_orders w WHERE w.order_id=o.id AND w.active)
        AND EXISTS(SELECT 1 FROM reservations r WHERE r.order_id=o.id AND r.state='active')
        AND EXISTS(SELECT 1 FROM order_pick_items i WHERE i.order_id=o.id AND i.scanned<i.quantity)
        AND ($2::timestamptz IS NULL OR (o.created_at,o.id)>($2::timestamptz,$3::uuid))
        ORDER BY o.created_at,o.id LIMIT $4)
        SELECT p.*,coalesce(i.quantity,0)::int quantity,coalesce(i.scanned,0)::int scanned FROM picked p
        LEFT JOIN LATERAL(SELECT sum(quantity) quantity,sum(scanned) scanned FROM order_pick_items WHERE order_id=p.id) i ON true
        ORDER BY p.created_at,p.id`,
          [q.warehouse_id, after?.time ?? null, after?.id ?? null, q.limit + 1],
        )
      ).rows;
      return response(rows, q, req.actor.tenantId, filter);
    });
  });
  app.get('/api/picking-waves', async (req) => {
    const q = page.parse(req.query),
      { filter, after } = context(req, q, ['waves', q.warehouse_id ?? null, q.state]);
    return scoped(req, async (c) => {
      const rows = (
        await c.query(
          `SELECT p.id,p.name,p.state,p.version,p.warehouse_id,w.name AS warehouse_name,p.created_at,p.finished_at,
        to_char(p.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') page_time,
        (SELECT count(*)::int FROM picking_wave_orders x WHERE x.wave_id=p.id) order_count
        FROM picking_waves p JOIN warehouses w ON (w.tenant_id,w.id)=(p.tenant_id,p.warehouse_id)
        WHERE ($1::uuid IS NULL OR p.warehouse_id=$1) AND ($2='all' OR p.state=$2)
        AND ($3::timestamptz IS NULL OR (p.created_at,p.id)<($3::timestamptz,$4::uuid))
        ORDER BY p.created_at DESC,p.id DESC LIMIT $5`,
          [q.warehouse_id ?? null, q.state, after?.time ?? null, after?.id ?? null, q.limit + 1],
        )
      ).rows;
      return response(rows, q, req.actor.tenantId, filter);
    });
  });
  app.get('/api/picking-waves/:id/scan-result', (req) =>
    scoped(req, async (c) => {
      const id = idOf(req.params),
        key = z.strictObject({ client_key: z.uuid() }).parse(req.query).client_key;
      // Wait for any in-flight scan holding this wave, including a response lost by the client.
      const row = (
        await c.query('SELECT version,state FROM picking_waves WHERE id=$1 FOR SHARE', [id])
      ).rows[0];
      ensure(row, 404, 'Nie znaleziono partii kompletacji');
      // A separate statement gets a fresh READ COMMITTED snapshot after waiting for the wave lock.
      const scan = (
        await c.query('SELECT result FROM picking_wave_scans WHERE wave_id=$1 AND client_key=$2', [
          id,
          key,
        ])
      ).rows[0];
      return { ...row, scan: scan?.result ?? null };
    }),
  );
  app.post('/api/picking-waves/preview', (req) =>
    scoped(req, (c) => previewWave(c, req.actor, waveSelection.parse(req.body))),
  );
  app.post('/api/picking-waves', async (req, reply) => {
    const result = await scoped(req, (c) =>
      createWave(c, req.actor, waveCreateInput.parse(req.body)),
    );
    return reply.code(result.reused ? 200 : 201).send(result);
  });
  app.get('/api/picking-waves/:id/pdf', async (req, reply) => {
    ensure(available, 404, 'Partie kompletacji są niedostępne w tej wersji kopii zapasowej');
    ensure(['admin', 'operator', 'viewer'].includes(req.actor.role), 403, 'Brak uprawnień do odczytu partii');
    z.strictObject({}).parse(req.query);
    const id = idOf(req.params);
    const snapshot = await tenantReadTx(req.actor.tenantId, async c => {
      const time = (await c.query('SELECT transaction_timestamp() AS captured_at')).rows[0].captured_at;
      return pickingPdfSnapshot(await waveDetail(c, id), req.actor.tenantId, id, new Date(time).toISOString());
    });
    const bytes = await renderPickingWavePdf(snapshot);
    return reply.header('Cache-Control', 'private, no-store').send({
      wave_id: id, version: snapshot.wave.version, snapshot_sha256: createHash('sha256').update(JSON.stringify(snapshot)).digest('hex'),
      mime: 'application/pdf', filename: 'lista-kompletacyjna-' + id + '-v' + snapshot.wave.version + '.pdf',
      byte_count: bytes.length, content_sha256: createHash('sha256').update(bytes).digest('hex'), content_base64: bytes.toString('base64'),
    });
  });
  app.get('/api/picking-waves/:id', (req) => scoped(req, (c) => waveDetail(c, idOf(req.params))));
  app.post('/api/picking-waves/:id/scans', (req) =>
    scoped(req, (c) => scanWave(c, req.actor, idOf(req.params), waveScanInput.parse(req.body))),
  );
  for (const [path, state] of [
    ['complete', 'completed'],
    ['cancel', 'cancelled'],
  ] as const)
    app.post('/api/picking-waves/:id/' + path, (req) =>
      scoped(req, (c) =>
        closeWave(c, req.actor, idOf(req.params), waveVersion.parse(req.body), state),
      ),
    );
}
