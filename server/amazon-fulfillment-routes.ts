import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { tenantTx } from './db';
import { ensure } from './errors';
import type { IntegrationContext } from './channel-access';
import {
  amazonFulfillmentInput,
  previewAmazonFulfillment,
  queueAmazonFulfillment,
  cancelAmazonFulfillment,
  reconcileAmazonFulfillment,
  amazonFulfillmentLocal,
  requireAmazonFulfillment,
} from './amazon-fulfillment';
import { amazonAccountPolicy } from './amazon-account';
export function registerAmazonFulfillmentRoutes(
  app: FastifyInstance,
  ctx: IntegrationContext = {},
  available = true,
) {
  const admin = (req: any) => {
    ensure(available, 404, 'Potwierdzanie wysyłek Amazon jest niedostępne w tej kopii');
    ensure(req.actor.role === 'admin', 403, 'Wymagana rola administratora');
  };
  const id = (p: unknown) => z.object({ id: z.uuid() }).parse(p).id;
  app.get('/api/orders/:id/amazon-fulfillment', (req) => {
    admin(req);
    return tenantTx(req.actor.tenantId, async (c) => {
      const o = (await c.query('SELECT * FROM orders WHERE id=$1', [id(req.params)])).rows[0];
      ensure(o && o.source === 'amazon', 404, 'Nie znaleziono zamówienia Amazon');
      const ch = (
        await c.query(
          'SELECT id,name,provider,mode,settings,oauth_scopes FROM channels WHERE id=$1',
          [o.channel_id],
        )
      ).rows[0];
      let ready = false,
        reason = '';
      try {
        await amazonFulfillmentLocal(c, o.id);
        requireAmazonFulfillment(ch);
        const full = (await c.query('SELECT * FROM channels WHERE id=$1', [ch.id])).rows[0];
        await amazonAccountPolicy(c, full);
        ensure(
          !(
            await c.query(
              "SELECT 1 FROM amazon_fulfillment_plans WHERE order_id=$1 AND (state IN ('queued','done') OR phase IN ('write_started','verify') OR (phase='done' AND state='conflict')) LIMIT 1",
              [o.id],
            )
          ).rowCount,
          409,
          'Zgłoszenie wysyłki trwa, zostało potwierdzone albo wymaga uzgodnienia',
        );
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
            'SELECT p.*,j.state job_state,j.provider_wait_until,j.provider_wait_reason FROM amazon_fulfillment_plans p LEFT JOIN jobs j ON (j.tenant_id,j.id)=(p.tenant_id,p.job_id) WHERE p.order_id=$1 ORDER BY p.created_at DESC,p.id DESC LIMIT 25',
            [o.id],
          )
        ).rows,
      };
    });
  });
  app.post('/api/orders/:id/amazon-fulfillment/preview', (req) => {
    admin(req);
    return previewAmazonFulfillment(
      req.actor,
      id(req.params),
      amazonFulfillmentInput.parse(req.body),
      ctx,
    );
  });
  app.post('/api/amazon-fulfillment-plans/:id/queue', (req) => {
    admin(req);
    const b = z
      .object({ confirm_external: z.boolean().default(false) })
      .strict()
      .parse(req.body ?? {});
    return queueAmazonFulfillment(req.actor, id(req.params), b.confirm_external);
  });
  app.post('/api/amazon-fulfillment-plans/:id/cancel', (req) => {
    admin(req);
    return cancelAmazonFulfillment(req.actor, id(req.params));
  });
  app.post('/api/amazon-fulfillment-plans/:id/reconcile', (req) => {
    admin(req);
    const b = z
      .object({ acknowledge_mismatch: z.boolean().default(false) })
      .strict()
      .parse(req.body ?? {});
    return reconcileAmazonFulfillment(req.actor, id(req.params), ctx, b.acknowledge_mismatch);
  });
}
