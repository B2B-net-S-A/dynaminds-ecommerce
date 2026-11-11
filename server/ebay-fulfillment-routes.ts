import { fulfillmentConfigInput, configureFulfillment } from './ebay-fulfillment-schedules';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { tenantTx } from './db';
import { ensure } from './errors';
import type { IntegrationContext } from './channel-access';
import {
  ebayFulfillmentInput,
  previewEbayFulfillment,
  queueEbayFulfillment,
  cancelEbayFulfillment,
  reconcileEbayFulfillment,
  fulfillmentLocal,
} from './ebay-fulfillment';
export function registerEbayFulfillmentRoutes(app: FastifyInstance, ctx: IntegrationContext = {}) {
  const admin = (req: any) =>
    ensure(req.actor.role === 'admin', 403, 'Wymagana rola administratora');
  const id = (p: unknown) => z.object({ id: z.uuid() }).parse(p).id;
  app.get('/api/integrations/:id/ebay-fulfillment', (req) => {
    admin(req);
    return tenantTx(req.actor.tenantId, async (c) => {
      const ch = (
        await c.query('SELECT id,name,provider,mode,settings FROM channels WHERE id=$1', [
          id(req.params),
        ])
      ).rows[0];
      ensure(ch?.provider === 'ebay', 404, 'Nie znaleziono eBay');
      return {
        channel: ch,
        config:
          (await c.query('SELECT * FROM ebay_fulfillment_configs WHERE channel_id=$1', [ch.id]))
            .rows[0] ?? null,
        receipts: (
          await c.query(
            'SELECT r.*,o.number,p.state plan_state,p.phase FROM ebay_fulfillment_receipts r JOIN orders o ON (o.tenant_id,o.id)=(r.tenant_id,r.order_id) LEFT JOIN ebay_fulfillment_plans p ON (p.tenant_id,p.id)=(r.tenant_id,r.plan_id) WHERE r.channel_id=$1 ORDER BY r.created_at DESC,r.order_id DESC LIMIT 50',
            [ch.id],
          )
        ).rows,
        jobs: (
          await c.query(
            "SELECT id,state,error,payload->'stats' stats,created_at FROM jobs WHERE kind='ebay.fulfillment.scan' AND payload->>'channel_id'=$1 ORDER BY created_at DESC,id DESC LIMIT 10",
            [ch.id],
          )
        ).rows,
      };
    });
  });
  app.patch('/api/integrations/:id/ebay-fulfillment', (req) => {
    admin(req);
    return configureFulfillment(req.actor, id(req.params), fulfillmentConfigInput.parse(req.body));
  });
  app.get('/api/orders/:id/ebay-fulfillment', (req) => {
    admin(req);
    return tenantTx(req.actor.tenantId, async (c) => {
      const o = (await c.query('SELECT * FROM orders WHERE id=$1', [id(req.params)])).rows[0];
      ensure(o && o.source === 'ebay', 404, 'Nie znaleziono zamówienia eBay');
      const ch = (
        await c.query('SELECT id,name,mode,settings,oauth_scopes FROM channels WHERE id=$1', [
          o.channel_id,
        ])
      ).rows[0];
      let ready = false,
        reason = '';
      try {
        await fulfillmentLocal(c, o.id);
        ready = true;
      } catch (e) {
        reason = (e as Error).message;
      }
      return {
        channel: ch,
        ready,
        reason,
        data: (
          await c.query(
            'SELECT p.*,j.state job_state,j.provider_wait_until,j.provider_wait_reason FROM ebay_fulfillment_plans p LEFT JOIN jobs j ON (j.tenant_id,j.id)=(p.tenant_id,p.job_id) WHERE p.order_id=$1 ORDER BY p.created_at DESC,p.id DESC LIMIT 25',
            [o.id],
          )
        ).rows,
      };
    });
  });
  app.post('/api/orders/:id/ebay-fulfillment/preview', (req) => {
    admin(req);
    return previewEbayFulfillment(
      req.actor,
      id(req.params),
      ebayFulfillmentInput.parse(req.body),
      ctx,
    );
  });
  app.post('/api/ebay-fulfillment-plans/:id/queue', (req) => {
    admin(req);
    const b = z
      .object({ confirm_external: z.boolean().default(false) })
      .strict()
      .parse(req.body ?? {});
    return queueEbayFulfillment(req.actor, id(req.params), b.confirm_external);
  });
  app.post('/api/ebay-fulfillment-plans/:id/cancel', (req) => {
    admin(req);
    return cancelEbayFulfillment(req.actor, id(req.params));
  });
  app.post('/api/ebay-fulfillment-plans/:id/reconcile', (req) => {
    admin(req);
    const b = z
      .object({ acknowledge_mismatch: z.boolean().default(false) })
      .strict()
      .parse(req.body ?? {});
    return reconcileEbayFulfillment(req.actor, id(req.params), ctx, b.acknowledge_mismatch);
  });
}
