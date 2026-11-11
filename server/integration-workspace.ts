import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { tenantTx, tenantReadTx } from './db';
import { registry } from './integrations';
import { decodePage, encodePage } from './inventory';
import { ensure } from './errors';

export const connectionQuery = z.strictObject({
  search: z.string().trim().max(100).default(''),
  provider: z
    .string()
    .refine((id) => registry.some((p) => p.id === id))
    .optional(),
  mode: z.enum(['sandbox', 'live']).optional(),
  status: z
    .enum(['attention', 'simulation', 'verified_read', 'authorized_read', 'not_verified'])
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  after: z.string().min(1).max(500).optional(),
});
const attention = ['error', 'awaiting_oauth', 'amazon_oauth_pending', 'ebay_oauth_pending'];
const cursorSchema = z.strictObject({
  tenant: z.uuid(),
  filter: z.string().regex(/^[a-f0-9]{64}$/),
  time: z.iso.datetime({ precision: 6 }),
  id: z.uuid(),
});

export const verificationHistoryQuery = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  after: z.string().min(1).max(500).optional(),
});
const verificationHistoryCursor = z.strictObject({
  tenant: z.uuid(), channel: z.uuid(), limit: z.number().int().min(1).max(100),
  time: z.iso.datetime({precision: 6}), id: z.uuid(),
});

export function registerIntegrationWorkspaceRoutes(app: FastifyInstance) {
  app.get('/api/integrations/:id/verification-history', async (req, reply) => {
    const {id} = z.strictObject({id: z.uuid()}).parse(req.params);
    const q = verificationHistoryQuery.parse(req.query);
    const cursor = decodePage(q.after, verificationHistoryCursor);
    ensure(!cursor || (cursor.tenant === req.actor.tenantId && cursor.channel === id && cursor.limit === q.limit),
      422, 'Kursor należy do innej firmy, połączenia lub rozmiaru strony');
    reply.header('Cache-Control', 'no-store');
    return tenantReadTx(req.actor.tenantId, async c => {
      const channel = (await c.query('SELECT id,name,provider FROM channels WHERE tenant_id=$1 AND id=$2',
        [req.actor.tenantId, id])).rows[0];
      ensure(channel, 404, 'Nie znaleziono integracji');
      const rows = (await c.query(`SELECT id,operation,status,created_at,detail->>'scope' AS scope,
        to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') page_time
        FROM integration_runs WHERE tenant_id=$1 AND channel_id=$2
          AND ($3::timestamptz IS NULL OR (created_at,id)<($3::timestamptz,$4::uuid))
        ORDER BY created_at DESC,id DESC LIMIT $5`,
        [req.actor.tenantId, id, cursor?.time ?? null, cursor?.id ?? null, q.limit + 1])).rows;
      const page = rows.slice(0, q.limit), last = page.at(-1);
      return {channel: {id: channel.id, name: channel.name, provider: channel.provider},
        data: page.map(r => ({id: r.id, operation: r.operation, status: r.status, created_at: r.created_at,
          scope: r.scope === 'read_only' ? 'read_only' : null})),
        next: rows.length > q.limit && last
          ? encodePage({tenant: req.actor.tenantId, channel: id, limit: q.limit, time: last.page_time, id: last.id}) : null};
    });
  });

  app.get('/api/integrations/workspace', async (req) =>
    tenantTx(req.actor.tenantId, async (c) => ({
      registry,
      summary: (
        await c.query(
          `SELECT count(*)::int total,
      count(*) FILTER (WHERE status=ANY($1::text[]))::int attention,
      count(*) FILTER (WHERE status='simulation' OR settings->>'simulation'='true')::int simulation,
      count(*) FILTER (WHERE status='verified_read' AND coalesce(settings->>'simulation','false') <> 'true')::int verified_read
      FROM channels`,
          [attention],
        )
      ).rows[0],
      runs: (
        await c.query('SELECT * FROM integration_runs ORDER BY created_at DESC,id DESC LIMIT 30')
      ).rows,
    })),
  );
  app.get('/api/integrations/connections', async (req) => {
    const q = connectionQuery.parse(req.query);
    const filter = createHash('sha256')
      .update(JSON.stringify([q.search, q.provider ?? '', q.mode ?? '', q.status ?? '']))
      .digest('hex');
    const cursor = decodePage(q.after, cursorSchema);
    ensure(
      !cursor || (cursor.tenant === req.actor.tenantId && cursor.filter === filter),
      422,
      'Kursor należy do innej firmy lub innych filtrów',
    );
    const names = registry
      .filter((p) => p.name.toLocaleLowerCase('pl').includes(q.search.toLocaleLowerCase('pl')))
      .map((p) => p.id);
    const pattern = '%' + q.search.replace(/[\\%_]/g, '\\$&') + '%';
    return tenantTx(req.actor.tenantId, async (c) => {
      const values = [
        q.search,
        pattern,
        names,
        q.provider ?? null,
        q.mode ?? null,
        q.status ?? null,
        attention,
      ];
      const where = `WHERE ($1='' OR name ILIKE $2 OR provider ILIKE $2 OR provider=ANY($3::text[]))
        AND ($4::text IS NULL OR provider=$4) AND ($5::text IS NULL OR mode=$5)
        AND ($6::text IS NULL OR ($6='attention' AND status=ANY($7::text[]))
          OR ($6='simulation' AND (status='simulation' OR settings->>'simulation'='true'))
          OR ($6 NOT IN ('attention','simulation') AND status=$6 AND coalesce(settings->>'simulation','false') <> 'true'))`;
      const result = (
        await c.query(
          `WITH filtered AS NOT MATERIALIZED (
        SELECT id,provider,name,mode,settings,status,created_at,sync_enabled,last_sync_at,oauth_scopes FROM channels ${where}
        ), page AS (SELECT *,
        to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') page_time
        FROM filtered WHERE ($8::timestamptz IS NULL OR (created_at,id)<($8::timestamptz,$9::uuid))
        ORDER BY created_at DESC,id DESC LIMIT $10)
        SELECT (SELECT count(*)::int FROM filtered) total,
        coalesce((SELECT jsonb_agg(page ORDER BY created_at DESC,id DESC) FROM page),'[]'::jsonb) rows`,
          [...values, cursor?.time ?? null, cursor?.id ?? null, q.limit + 1],
        )
      ).rows[0];
      const { total, rows } = result;
      const page = rows.slice(0, q.limit),
        last = page.at(-1);
      return {
        data: page.map(({ page_time, ...ch }: any) => ch),
        total,
        next:
          rows.length > q.limit && last
            ? encodePage({ tenant: req.actor.tenantId, filter, time: last.page_time, id: last.id })
            : null,
      };
    });
  });
}
