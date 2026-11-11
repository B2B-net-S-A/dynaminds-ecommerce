import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { tenantTx } from './db';
import { ensure } from './errors';
import { audit } from './domain';
import { packingShippingActor } from './packing-shipping-binding';
import { channelRead, loadChannel, type IntegrationContext } from './channel-access';
import { InPost } from './integrations';
import { cachedDpdLabel } from './dpd-shipping';
import { cachedDhlLabel } from './dhl-shipping';
import { cachedPocztaPolskaLabel } from './pocztapolska-shipping';
import { readShipmentTracking } from './tracking';
import { registerCarrierReturnRoutes } from './carrier-returns';
import {
  shippingInput,
  previewShipping,
  queueShipping,
  shippingExample,
  lockedShipping,
  shippingJob,
  dispatchShipping,
  isInPostPlan,
  queueShippingBuyInTx,
} from './shipping';
export async function shipmentLabel(tenant: string, id: string, ctx: IntegrationContext) {
  const s = await tenantTx(
    tenant,
    async (c) => (await c.query('SELECT * FROM shipments WHERE id=$1', [id])).rows[0],
  );
  ensure(
    s && s.channel_id && s.external_id && s.mode !== 'demo',
    404,
    'Nie znaleziono etykiety dostawcy',
  );
  const ch = await loadChannel(tenant, s.channel_id);
  if (ch.provider === 'dpd') return cachedDpdLabel(tenant, s.id);
  if (ch.provider === 'dhl') return cachedDhlLabel(tenant, s.id);
  if (ch.provider === 'pocztapolska') return cachedPocztaPolskaLabel(tenant, s.id);
  return channelRead(
    tenant,
    s.channel_id,
    (client) => {
      ensure(client instanceof InPost, 422, 'Wymagany InPost');
      return client.label(s.external_id);
    },
    ctx,
  );
}
export function registerShippingRoutes(app: FastifyInstance, ctx: IntegrationContext = {}) {
  // Return labels for dispatched DPD/InPost shipments (migration 254, prepared as 261).
  registerCarrierReturnRoutes(app);
  const id = (p: any) => z.object({ id: z.uuid() }).parse(p).id;
  const write = (req: any) =>
    ensure(['admin', 'operator'].includes(req.actor.role), 403, 'Brak prawa realizacji przesyłek');
  app.get('/api/shipping/channels', (req) =>
    tenantTx(req.actor.tenantId, async (c) => ({
      data: (
        await c.query(
          "SELECT id,provider,name,mode,settings,status FROM channels WHERE provider IN ('inpost','dpd','dhl','pocztapolska') ORDER BY name",
        )
      ).rows,
    })),
  );
  app.post('/api/shipping/example', (req) => {
    ensure(req.actor.role === 'admin', 403, 'Wymagana rola administratora');
    return shippingExample(req.actor);
  });
  app.get('/api/orders/:id/shipping', (req) =>
    tenantTx(req.actor.tenantId, async (c) => {
      const order = id(req.params);
      ensure(
        (await c.query('SELECT id FROM orders WHERE id=$1', [order])).rowCount,
        404,
        'Nie znaleziono zamówienia',
      );
      const q = z.object({ after: z.uuid().optional() }).parse(req.query);
      const rows = (
        await c.query(
          `SELECT p.*,p.result-'label_base64' AS result,ch.provider,ch.name AS channel_name,ch.mode,ch.settings->>'simulation' AS simulation,j.state AS job_state,j.attempts FROM shipping_plans p JOIN channels ch ON (ch.tenant_id,ch.id)=(p.tenant_id,p.channel_id) LEFT JOIN jobs j ON j.id=p.job_id WHERE p.order_id=$1 AND ($2::uuid IS NULL OR (p.created_at,p.id)<(SELECT created_at,id FROM shipping_plans WHERE id=$2 AND order_id=$1)) ORDER BY p.created_at DESC,p.id DESC LIMIT 26`,
          [order, q.after ?? null],
        )
      ).rows;
      return { data: rows.slice(0, 25), meta: { cursor: rows.length > 25 ? rows[24].id : null } };
    }),
  );
  app.post('/api/orders/:id/shipping/preview', (req) => {
    write(req);
    return previewShipping(
      packingShippingActor(req),
      id(req.params),
      shippingInput.parse(req.body),
    );
  });
  app.post('/api/shipping-plans/:id/queue', (req) => {
    write(req);
    const b = z.object({ confirm_live: z.boolean().default(false) }).parse(req.body ?? {});
    return tenantTx(req.actor.tenantId, (c) =>
      queueShipping(c, packingShippingActor(req), id(req.params), b.confirm_live),
    );
  });
  app.post('/api/shipping-plans/:id/buy', (req) => {
    write(req);
    const b = z
      .object({
        offer_id: z.string().regex(/^[1-9]\d{0,15}$/),
        confirm_cost: z.boolean().default(false),
        ack_unknown_rate: z.boolean().default(false),
      })
      .parse(req.body ?? {});
    return tenantTx(req.actor.tenantId, (c) => queueShippingBuyInTx(c, req.actor, id(req.params), b));
  });
  app.post('/api/shipping-plans/:id/refresh', (req) => {
    write(req);
    return tenantTx(req.actor.tenantId, async (c) => {
      const { p, o } = await lockedShipping(c, id(req.params));
      ensure(isInPostPlan(p), 422, 'Ten przewoźnik nie udostępnia wyceny w tym procesie');
      ensure(p.actor_id === req.actor.userId, 403, 'Plan obsługuje jego autor');
      ensure(
        o.status === 'packed' &&
          p.remote_id &&
          (p.state === 'quoted' ||
            (p.state === 'failed' &&
              ['created', 'buy_ready', 'refresh_started'].includes(p.phase))),
        409,
        'Nie można odświeżyć wyceny podczas zakupu lub wysyłki',
      );
      await c.query(
        "UPDATE shipping_plans SET state='queued',phase='refresh_ready',selected_offer=NULL WHERE id=$1",
        [p.id],
      );
      await audit(c, req.actor, 'shipping.refresh.queue', p.id);
      return shippingJob(c, req.actor, p, 'refresh');
    });
  });
  app.post('/api/shipping-plans/:id/cancel', (req) => {
    write(req);
    return tenantTx(req.actor.tenantId, async (c) => {
      const { p } = await lockedShipping(c, id(req.params));
      ensure(p.actor_id === req.actor.userId, 403, 'Plan obsługuje jego autor');
      if (p.state === 'cancelled') return { id: p.id };
      ensure(
        ['preview', 'quoted', 'failed'].includes(p.state) && !p.shipment_id,
        409,
        'Nie można anulować zadania w trakcie zakupu lub gotowej etykiety',
      );
      if (
        p.state === 'preview' ||
        p.phase === 'ready' ||
        (!isInPostPlan(p) && ['rejected', 'absent'].includes(p.phase))
      ) {
        await c.query("UPDATE shipping_plans SET state='cancelled',phase='cancelled' WHERE id=$1", [
          p.id,
        ]);
        await audit(c, req.actor, 'shipping.cancel.local', p.id);
        return { id: p.id };
      }
      ensure(
        isInPostPlan(p),
        409,
        'Niepewną przesyłkę uzgodnij u przewoźnika planu; anulowanie u dostawcy nie jest wdrożone',
      );
      ensure(
        !['buy_started', 'confirmed'].includes(p.phase),
        409,
        'Najpierw uzgodnij niepewny zakup',
      );
      await c.query("UPDATE shipping_plans SET state='cancel_queued' WHERE id=$1", [p.id]);
      await audit(c, req.actor, 'shipping.cancel.queue', p.id);
      return shippingJob(c, req.actor, p, 'cancel');
    });
  });
  app.post('/api/shipping-plans/:id/reconcile', (req) => {
    write(req);
    return tenantTx(req.actor.tenantId, async (c) => {
      const { p } = await lockedShipping(c, id(req.params));
      ensure(isInPostPlan(p), 422, 'Użyj uzgodnienia przewoźnika tego planu');
      ensure(
        p.state === 'failed' && p.actor_id === req.actor.userId,
        409,
        'Autor może uzgodnić niepewny wynik',
      );
      const previous = (await c.query('SELECT payload FROM jobs WHERE id=$1', [p.job_id])).rows[0];
      ensure(previous, 409, 'Brak zadania do uzgodnienia');
      const action = previous.payload.action;
      ensure(
        action !== 'buy' || p.phase === 'buy_started',
        409,
        'Cena wymaga nowej wyceny i zatwierdzenia',
      );
      await c.query('UPDATE shipping_plans SET state=$2 WHERE id=$1', [
        p.id,
        action === 'buy' ? 'buy_queued' : action === 'cancel' ? 'cancel_queued' : 'queued',
      ]);
      await audit(c, req.actor, 'shipping.reconcile', p.id, { action });
      return shippingJob(c, req.actor, p, action);
    });
  });
  app.post('/api/shipping-plans/:id/dispatch', (req) => {
    write(req);
    return tenantTx(req.actor.tenantId, (c) => dispatchShipping(c, req.actor, id(req.params)));
  });
  app.post('/api/shipments/:id/tracking', async (req) => {
    write(req);
    const b = z
        .object({ demo_status: z.enum(['confirmed', 'delivered']).optional() })
        .parse(req.body ?? {}),
      sid = id(req.params);
    return readShipmentTracking(req.actor, sid, ctx, b.demo_status);
  });
}
