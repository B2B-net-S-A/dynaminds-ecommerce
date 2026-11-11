import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { tenantTx } from './db';
import { ensure } from './errors';
import { audit } from './domain';
import { trackingConnection, trackingReady } from './tracking-connection';
import { encrypt, decrypt } from './security';
import { enqueueTracking, trackingEligible } from './tracking';
export function registerTrackingRoutes(app: FastifyInstance) {
  const admin = (req: any) =>
    ensure(req.actor.role === 'admin', 403, 'Wymagana rola administratora');
  const id = (p: unknown) => z.object({ id: z.uuid() }).parse(p).id;
  app.get('/api/integrations/:id/tracking', (req) => {
    admin(req);
    const q = z
      .object({
        after: z.uuid().optional(),
        search: z.string().trim().max(100).default(''),
        limit: z.coerce.number().int().min(1).max(100).default(25),
      })
      .parse(req.query);
    return tenantTx(req.actor.tenantId, async (c) => {
      const ch = (
        await c.query(
          "SELECT id,name,provider,mode,settings,credentials FROM channels WHERE id=$1 AND provider IN ('inpost','dpd','dhl','pocztapolska')",
          [id(req.params)],
        )
      ).rows[0];
      ensure(ch, 404, 'Nie znaleziono integracji trackingu');
      const cfg =
        (await c.query('SELECT * FROM tracking_configs WHERE channel_id=$1', [ch.id])).rows[0] ??
        null;
      const rows = (
        await c.query(
          `SELECT s.id,s.order_id,s.tracking_number,s.status,s.dispatched_at,s.tracking_data,s.tracking_at,s.tracking_error,s.tracking_next_at,s.tracking_demo_status,s.created_at,
        o.number AS order_number,o.status AS order_status,j.state AS job_state,j.error AS job_error,j.attempts,
        least(s.created_at,coalesce(s.tracking_provider_created_at,s.created_at))<=now()-interval '45 days' AS expired
        FROM shipments s JOIN orders o ON (o.tenant_id,o.id)=(s.tenant_id,s.order_id)
        LEFT JOIN jobs j ON j.id=s.tracking_job_id WHERE s.channel_id=$1 AND ($2::uuid IS NULL OR s.id>$2)
        AND ($3='' OR strpos(lower(s.tracking_number||' '||o.number),lower($3))>0) ORDER BY s.id LIMIT $4`,
          [ch.id, q.after ?? null, q.search, q.limit + 1],
        )
      ).rows;
      const stats = (
        await c.query(
          `SELECT count(*)::int AS total,
        count(*) FILTER(WHERE ${trackingEligible})::int AS active,
        count(*) FILTER(WHERE s.tracking_data->>'status' IN ('delivered','returned_to_sender','canceled'))::int AS terminal,
        count(*) FILTER(WHERE s.tracking_error IS NOT NULL)::int AS errors FROM shipments s WHERE s.channel_id=$1`,
          [ch.id],
        )
      ).rows[0];
      return {
        channel: {
          id: ch.id,
          name: ch.name,
          provider: ch.provider,
          mode: ch.mode,
          settings: ch.settings,
          info_configured:
            ch.provider === 'dpd'
              ? Boolean(decrypt(ch.credentials).info_login && decrypt(ch.credentials).info_password)
              : undefined,
        },
        config: cfg,
        data: rows.slice(0, q.limit),
        meta: { cursor: rows.length > q.limit ? rows[q.limit - 1].id : null },
        stats,
      };
    });
  });
  app.patch('/api/integrations/:id/tracking', (req) => {
    admin(req);
    const b = z
      .object({
        version: z.number().int().min(0),
        enabled: z.boolean(),
        interval_seconds: z.number().int().min(60).max(86400),
        mark_delivered: z.boolean(),
        confirm_external: z.boolean().default(false),
      })
      .strict()
      .parse(req.body);
    return tenantTx(req.actor.tenantId, async (c) => {
      const channelId = id(req.params);
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        'tracking-config:' + req.actor.tenantId + ':' + channelId,
      ]);
      const old = (
        await c.query('SELECT * FROM tracking_configs WHERE channel_id=$1 FOR UPDATE', [channelId])
      ).rows[0];
      const ch = (
        await c.query(
          "SELECT provider,mode,settings,credentials FROM channels WHERE id=$1 AND provider IN ('inpost','dpd','dhl','pocztapolska')",
          [channelId],
        )
      ).rows[0];
      ensure(ch, 404, 'Nie znaleziono integracji trackingu');
      ensure((old?.version ?? 0) === b.version, 409, 'Konfigurację zmieniono; odśwież dane');
      ensure(
        !b.enabled || trackingReady(ch),
        422,
        'Tracking wymaga trybu live oraz danych dostępowych przewoźnika; sandbox obsługuje tylko przykład lokalny',
      );
      ensure(
        !b.enabled || ch.settings.simulation || b.confirm_external,
        422,
        'Potwierdź cykliczny odczyt numerów przesyłek z API przewoźnika',
      );
      const cfg = (
        await c.query(
          `INSERT INTO tracking_configs(tenant_id,channel_id,actor_id,enabled,interval_seconds,mark_delivered,external_authorized,connection_hash)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(channel_id) DO UPDATE SET actor_id=excluded.actor_id,enabled=excluded.enabled,
        interval_seconds=excluded.interval_seconds,mark_delivered=excluded.mark_delivered,external_authorized=excluded.external_authorized,
        connection_hash=excluded.connection_hash,version=tracking_configs.version+1,error=NULL,updated_at=now() RETURNING *`,
          [
            req.actor.tenantId,
            channelId,
            req.actor.userId,
            b.enabled,
            b.interval_seconds,
            b.mark_delivered,
            b.enabled && !ch.settings.simulation && b.confirm_external,
            trackingConnection(ch),
          ],
        )
      ).rows[0];
      await c.query(
        "UPDATE jobs SET state='failed',lease_token=NULL,locked_at=NULL,error='Harmonogram trackingu wyłączono lub zmieniono' WHERE kind='shipping.tracking' AND state IN ('pending','running') AND payload->>'channel_id'=$1",
        [channelId],
      );
      await c.query('UPDATE shipments SET tracking_next_at=now() WHERE channel_id=$1', [channelId]);
      await audit(c, req.actor, 'tracking.configure', channelId, {
        version: cfg.version,
        enabled: b.enabled,
        mark_delivered: b.mark_delivered,
      });
      return cfg;
    });
  });
  app.patch('/api/integrations/:id/tracking-credentials', (req) => {
    admin(req);
    const b = z
      .object({
        info_login: z.string().min(1).max(500),
        info_password: z.string().min(1).max(500),
        info_channel: z.string().max(500).default(''),
      })
      .strict()
      .parse(req.body);
    ensure(
      Object.values(b).every((v) => !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(v)),
      422,
      'Nieprawidłowe dane dostępowe DPD',
    );
    return tenantTx(req.actor.tenantId, async (c) => {
      const channelId = id(req.params);
      // Same lock order as configuration / worker: config before channel.
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        'tracking-config:' + req.actor.tenantId + ':' + channelId,
      ]);
      await c.query('SELECT channel_id FROM tracking_configs WHERE channel_id=$1 FOR UPDATE', [
        channelId,
      ]);
      const ch = (
        await c.query("SELECT * FROM channels WHERE id=$1 AND provider='dpd' FOR UPDATE", [
          channelId,
        ])
      ).rows[0];
      ensure(ch, 404, 'Nie znaleziono DPD');
      await c.query('UPDATE channels SET credentials=$2 WHERE id=$1', [
        channelId,
        encrypt({ ...decrypt(ch.credentials), ...b }),
      ]);
      await c.query(
        "UPDATE tracking_configs SET enabled=false,version=version+1,error='Dane dostępowe zmieniono; zatwierdź harmonogram',updated_at=now() WHERE channel_id=$1",
        [channelId],
      );
      await c.query(
        "UPDATE jobs SET state='failed',lease_token=NULL,locked_at=NULL,error='Dane dostępowe trackingu zmieniono' WHERE kind='shipping.tracking' AND state IN ('pending','running') AND payload->>'channel_id'=$1",
        [channelId],
      );
      await audit(c, req.actor, 'tracking.credentials', channelId, {
        provider: 'dpd',
        configured: true,
      });
      return { configured: true };
    });
  });
  app.post('/api/integrations/:id/tracking', (req) => {
    admin(req);
    return tenantTx(req.actor.tenantId, async (c) => {
      const result = await enqueueTracking(c, req.actor, id(req.params), true);
      await audit(c, req.actor, 'tracking.enqueue', id(req.params), result);
      return result;
    });
  });
  app.post('/api/shipments/:id/tracking-example', (req) => {
    admin(req);
    const b = z
      .object({
        status: z.enum(['confirmed', 'out_for_delivery', 'delivered', 'returned_to_sender']),
      })
      .strict()
      .parse(req.body);
    return tenantTx(req.actor.tenantId, async (c) => {
      const found = (
        await c.query('SELECT channel_id FROM shipments WHERE id=$1', [id(req.params)])
      ).rows[0];
      ensure(found, 404, 'Nie znaleziono przesyłki');
      const cfg = (
        await c.query('SELECT * FROM tracking_configs WHERE channel_id=$1 FOR UPDATE', [
          found.channel_id,
        ])
      ).rows[0];
      const ch = (await c.query('SELECT settings FROM channels WHERE id=$1', [found.channel_id]))
        .rows[0];
      ensure(
        ch?.settings.simulation === true,
        422,
        'Symulacja jest dostępna tylko w przykładzie lokalnym',
      );
      ensure(cfg?.enabled, 409, 'Włącz harmonogram przykładu lokalnego');
      const s = (await c.query('SELECT * FROM shipments WHERE id=$1 FOR UPDATE', [id(req.params)]))
        .rows[0];
      ensure(
        s.dispatched_at &&
          !['delivered', 'returned_to_sender', 'canceled'].includes(s.tracking_data?.status),
        409,
        'Przykład wymaga przekazanej, niezakończonej przesyłki',
      );
      await c.query(
        'UPDATE shipments SET tracking_demo_status=$2,tracking_next_at=now() WHERE id=$1',
        [s.id, b.status],
      );
      await audit(c, req.actor, 'tracking.example', s.id, {
        status: b.status,
        scope: 'local_simulation',
      });
      return { id: s.id, status: b.status, scope: 'local_simulation' };
    });
  });
}
