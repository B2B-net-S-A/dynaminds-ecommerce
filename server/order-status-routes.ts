import { psStatusMap, psStatusMapSchema } from './prestashop-status';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { tenantTx, tenantReadTx } from './db';
import { audit } from './domain';
import { ensure } from './errors';
import { withAllegroRequestContext, type IntegrationContext } from './channel-access';
import {
  previewStatus,
  queueStatus,
  reconcileStatus,
  statusOrder,
  statusTarget,
  statusMappings,
  mappingsFor,
  statusConnection,
  requireStatusScope,
} from './order-status';
export function registerOrderStatusRoutes(app: FastifyInstance, ctx: IntegrationContext = {}) {
  const admin = (req: any) =>
    ensure(req.actor.role === 'admin', 403, 'Wymagana rola administratora');
  const id = (p: unknown) => z.object({ id: z.uuid() }).parse(p).id;
  app.get('/api/orders/:id/channel-status', (req) => {
    admin(req);
    return tenantReadTx(req.actor.tenantId, async (c) => {
      const o = await statusOrder(c, id(req.params));
      const ch = (
        await c.query('SELECT id,name,provider,mode,settings FROM channels WHERE id=$1', [
          o.channel_id,
        ])
      ).rows[0];
      let target: string | null = null,
        reason: string | null = null;
      try {
        target = statusTarget(ch, o);
      } catch (e) {
        reason = (e as Error).message;
      }
      return {
        channel: ch ?? null,
        target,
        reason,
        local_status: o.status,
        local_version: o.version,
        config:
          (await c.query('SELECT * FROM order_status_configs WHERE channel_id=$1', [o.channel_id]))
            .rows[0] ?? null,
        data: (
          await c.query(
            'SELECT * FROM order_status_plans WHERE order_id=$1 ORDER BY created_at DESC,id DESC LIMIT 25',
            [o.id],
          )
        ).rows,
      };
    });
  });
  app.post('/api/orders/:id/channel-status/preview', (req) => {
    admin(req);
    return previewStatus(req.actor, id(req.params), withAllegroRequestContext(ctx, req));
  });
  app.post('/api/channel-status-plans/:id/queue', (req) => {
    admin(req);
    const b = z
      .object({ confirm_external: z.boolean().default(false) })
      .strict()
      .parse(req.body ?? {});
    return queueStatus(req.actor, id(req.params), b.confirm_external);
  });
  app.post('/api/channel-status-plans/:id/reconcile', (req) => {
    admin(req);
    const b = z
      .object({ acknowledge_mismatch: z.boolean().default(false) })
      .strict()
      .parse(req.body ?? {});
    return reconcileStatus(req.actor, id(req.params), withAllegroRequestContext(ctx, req), b.acknowledge_mismatch);
  });
  app.post('/api/channel-status-plans/:id/cancel', (req) => {
    admin(req);
    return tenantTx(req.actor.tenantId, async (c) => {
      const initial = (
        await c.query('SELECT * FROM order_status_plans WHERE id=$1', [id(req.params)])
      ).rows[0];
      ensure(initial, 404, 'Nie znaleziono podglądu');
      if (initial.job_id)
        await c.query('SELECT id FROM jobs WHERE id=$1 FOR UPDATE', [initial.job_id]);
      const p = (
        await c.query('SELECT * FROM order_status_plans WHERE id=$1 FOR UPDATE', [initial.id])
      ).rows[0];
      if (p.state === 'cancelled') return p;
      ensure(
        ['preview', 'queued'].includes(p.state) && p.phase === 'ready',
        409,
        'Żądanie mogło już trafić do kanału; sprawdź wynik odczytem',
      );
      if (p.job_id)
        await c.query(
          "UPDATE jobs SET state='failed',lease_token=NULL,locked_at=NULL,error='Anulowano przed zapisem' WHERE id=$1 AND state IN ('pending','running')",
          [p.job_id],
        );
      const result = (
        await c.query(
          "UPDATE order_status_plans SET state='cancelled',updated_at=now() WHERE id=$1 RETURNING *",
          [p.id],
        )
      ).rows[0];
      await audit(c, req.actor, 'order.channel-status.cancel', p.id, {});
      return result;
    });
  });
  app.get('/api/integrations/:id/order-status', (req) => {
    admin(req);
    return tenantReadTx(req.actor.tenantId, async (c) => {
      const ch = (
        await c.query(
          'SELECT id,name,provider,mode,settings,oauth_scopes FROM channels WHERE id=$1',
          [id(req.params)],
        )
      ).rows[0];
      ensure(
        ch && statusMappings[ch.provider],
        404,
        'Nie znaleziono kanału synchronizacji statusów',
      );
      return {
        channel: ch,
        mappings: ch.provider === 'prestashop' ? psStatusMap(ch, false) : mappingsFor(ch),
        config:
          (await c.query('SELECT * FROM order_status_configs WHERE channel_id=$1', [ch.id]))
            .rows[0] ?? null,
        jobs: (
          await c.query(
            "SELECT id,state,error,attempts,payload->'stats' AS stats,created_at FROM jobs WHERE kind='order.status.scan' AND payload->>'channel_id'=$1 ORDER BY created_at DESC,id DESC LIMIT 10",
            [ch.id],
          )
        ).rows,
        data: (
          await c.query(
            'SELECT p.*,o.number FROM order_status_plans p JOIN orders o ON (o.tenant_id,o.id)=(p.tenant_id,p.order_id) WHERE p.channel_id=$1 ORDER BY p.created_at DESC,p.id DESC LIMIT 25',
            [ch.id],
          )
        ).rows,
      };
    });
  });
  app.patch('/api/integrations/:id/order-status', (req) => {
    admin(req);
    const b = z
      .object({
        version: z.number().int().min(0),
        enabled: z.boolean(),
        mappings: psStatusMapSchema.optional(),
        confirm_external: z.boolean().default(false),
      })
      .strict()
      .parse(req.body);
    return tenantTx(req.actor.tenantId, async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        'order-status-config:' + req.actor.tenantId + ':' + id(req.params),
      ]);
      const previous = (
        await c.query('SELECT * FROM order_status_configs WHERE channel_id=$1', [id(req.params)])
      ).rows[0];
      const ch = (await c.query('SELECT * FROM channels WHERE id=$1 FOR UPDATE', [id(req.params)]))
        .rows[0];
      ensure(
        ch && statusMappings[ch.provider],
        404,
        'Nie znaleziono kanału synchronizacji statusów',
      );
      ensure((previous?.version ?? 0) === b.version, 409, 'Konfigurację zmieniono; odśwież dane');
      ensure(
        !b.enabled || ch.settings.simulation || b.confirm_external,
        422,
        'Potwierdź automatyczny zapis statusów; kanał może powiadamiać kupujących',
      );
      if (ch.provider === 'prestashop') {
        if (b.mappings && JSON.stringify(b.mappings) !== JSON.stringify(psStatusMap(ch, false))) {
          ensure(
            !(
              await c.query(
                "SELECT id FROM order_status_plans WHERE channel_id=$1 AND state IN ('queued','failed') AND phase IN ('write_started','verify')",
                [ch.id],
              )
            ).rowCount,
            409,
            'Najpierw uzgodnij niepewny wynik na dotychczasowym mapowaniu',
          );
          ch.settings = { ...ch.settings, status_mappings: b.mappings };
          await c.query('UPDATE channels SET settings=$2 WHERE id=$1', [
            ch.id,
            JSON.stringify(ch.settings),
          ]);
        }
        if (b.enabled) psStatusMap(ch);
      } else ensure(!b.mappings, 422, 'Mapowanie ID dotyczy PrestaShop');
      if (b.enabled) requireStatusScope(ch);
      const cfg = (
        await c.query(
          `INSERT INTO order_status_configs(tenant_id,channel_id,actor_id,enabled,external_authorized,connection_hash,next_run_at) VALUES($1,$2,$3,$4,$5,$6,now()) ON CONFLICT(channel_id) DO UPDATE SET actor_id=excluded.actor_id,enabled=excluded.enabled,external_authorized=excluded.external_authorized,connection_hash=excluded.connection_hash,next_run_at=now(),version=order_status_configs.version+1,error=NULL,updated_at=now() RETURNING *`,
          [
            req.actor.tenantId,
            ch.id,
            req.actor.userId,
            b.enabled,
            b.enabled && b.confirm_external,
            statusConnection(ch),
          ],
        )
      ).rows[0];
      // Only ready plans are fenced off. Dispatched plans retain their GET-only verification.
      await c.query(
        `UPDATE jobs SET state='failed',lease_token=NULL,locked_at=NULL,error='Konfigurację statusów zmieniono' WHERE state IN ('pending','running') AND ((kind='order.status.scan' AND payload->>'channel_id'=$1) OR (kind='order.status.write' AND id IN (SELECT job_id FROM order_status_plans WHERE channel_id=$1::uuid AND config_version IS NOT NULL AND state='queued' AND phase='ready')))`,
        [ch.id],
      );
      await c.query(
        "UPDATE order_status_plans SET state='conflict',error='Konfigurację statusów zmieniono',updated_at=now() WHERE channel_id=$1 AND config_version IS NOT NULL AND state='queued' AND phase='ready'",
        [ch.id],
      );
      await audit(c, req.actor, 'order.channel-status.configure', ch.id, {
        enabled: cfg.enabled,
        version: cfg.version,
        external_authorized: cfg.external_authorized,
      });
      return cfg;
    });
  });
}
