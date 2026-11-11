import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { tenantTx, tenantReadTx } from './db';
import { ensure } from './errors';
import { audit } from './domain';
import { statusConnection } from './order-status';
import { stageOrders } from './imports';
import {
  sourceProviders,
  queueSourceRead,
  sourceHistory,
  applySourceCheck,
} from './source-payments';
export const sourceApplyInput = z
  .object({ version: z.number().int().positive(), confirmed: z.literal(true) })
  .strict();
export function registerSourcePaymentRoutes(app: FastifyInstance) {
  const id = (p: unknown) => z.object({ id: z.uuid() }).parse(p).id;
  const admin = (req: any) =>
    ensure(req.actor.role === 'admin', 403, 'Wymagana rola administratora');
  app.get('/api/orders/:id/source-payments', (req) => {
    admin(req);
    return tenantReadTx(req.actor.tenantId, (c) => sourceHistory(c, id(req.params)));
  });
  app.post('/api/orders/:id/source-payments/read', (req) => {
    admin(req);
    z.object({})
      .strict()
      .parse(req.body ?? {});
    return tenantTx(req.actor.tenantId, async (c) => {
      const ref = (await c.query('SELECT channel_id FROM orders WHERE id=$1', [id(req.params)]))
        .rows[0];
      ensure(ref, 404, 'Nie znaleziono zamówienia');
      await c.query('SELECT channel_id FROM source_payment_configs WHERE channel_id=$1 FOR SHARE', [
        ref.channel_id,
      ]);
      const ch = (await c.query('SELECT * FROM channels WHERE id=$1', [ref.channel_id])).rows[0];
      ensure(ch, 422, 'Zamówienie nie ma kanału importu');
      return queueSourceRead(c, req.actor, id(req.params), ch);
    });
  });
  app.post('/api/orders/:id/source-payments/example', (req) => {
    admin(req);
    const b = z
      .object({ amount: z.number().int().min(0).max(2147483647) })
      .strict()
      .parse(req.body);
    return tenantTx(req.actor.tenantId, async (c) => {
      const o = (await c.query('SELECT * FROM orders WHERE id=$1 FOR SHARE', [id(req.params)]))
        .rows[0];
      ensure(o, 404, 'Nie znaleziono zamówienia');
      const ch = (await c.query('SELECT * FROM channels WHERE id=$1', [o.channel_id])).rows[0];
      ensure(
        ch?.settings.simulation && sourceProviders.includes(ch.provider),
        422,
        'Wymagany jawny przykład lokalny',
      );
      ensure(o.payment_mode === 'prepaid', 422, 'Przykład dotyczy przedpłaty');
      const inbound = (await c.query('SELECT raw FROM inbound_orders WHERE order_id=$1', [o.id]))
        .rows[0];
      ensure(inbound, 409, 'Brak danych przykładu');
      const raw = structuredClone(inbound.raw);
      if (ch.provider === 'woocommerce') {
        ensure(
          b.amount === 0 || b.amount === o.total,
          422,
          'WooCommerce date_paid deklaruje wyłącznie pełną wpłatę',
        );
        raw.date_paid = b.amount ? new Date().toISOString() : null;
      } else if (ch.provider === 'allegro') {
        raw.payment = {
          ...raw.payment,
          type: 'ONLINE',
          paidAmount: { amount: (b.amount / 100).toFixed(2), currency: o.currency },
        };
        raw.surcharges = [];
      } else {
        raw.total_paid_real = (b.amount / 100).toFixed(6);
        raw._dyna.state.paid = b.amount >= o.total ? '1' : '0';
      }
      await stageOrders(c, req.actor, ch, [raw]);
      await audit(c, req.actor, 'payment.source.example', o.id, {
        amount: b.amount,
        scope: 'local_demo_no_external_call',
      });
      return { amount: b.amount, mode: 'local_demo_no_external_call' };
    });
  });
  app.post('/api/source-payment-checks/:id/apply', (req) => {
    admin(req);
    const b = sourceApplyInput.parse(req.body);
    return tenantTx(req.actor.tenantId, (c) =>
      applySourceCheck(c, req.actor, id(req.params), b.version),
    );
  });
  app.get('/api/integrations/:id/payment-sync', (req) => {
    admin(req);
    return tenantReadTx(req.actor.tenantId, async (c) => {
      const ch = (await c.query('SELECT id,provider FROM channels WHERE id=$1', [id(req.params)]))
        .rows[0];
      ensure(ch && sourceProviders.includes(ch.provider), 404, 'Nie znaleziono kanału płatności');
      return {
        config:
          (
            await c.query(
              'SELECT enabled,interval_seconds,version,cursor,next_at,error FROM source_payment_configs WHERE channel_id=$1',
              [ch.id],
            )
          ).rows[0] ?? null,
      };
    });
  });
  app.patch('/api/integrations/:id/payment-sync', (req) => {
    admin(req);
    const b = z
      .object({
        version: z.number().int().min(0),
        enabled: z.boolean(),
        interval_seconds: z.number().int().min(60).max(86400),
        confirm_external: z.boolean().default(false),
      })
      .strict()
      .parse(req.body);
    return tenantTx(req.actor.tenantId, async (c) => {
      const channel = id(req.params);
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        'source-payments-config:' + req.actor.tenantId + ':' + channel,
      ]);
      const old = (
          await c.query('SELECT * FROM source_payment_configs WHERE channel_id=$1 FOR UPDATE', [
            channel,
          ])
        ).rows[0],
        ch = (await c.query('SELECT * FROM channels WHERE id=$1', [channel])).rows[0];
      ensure(ch && sourceProviders.includes(ch.provider), 404, 'Nie znaleziono kanału płatności');
      ensure((old?.version ?? 0) === b.version, 409, 'Konfiguracja zmieniła się; odśwież dane');
      ensure(
        !b.enabled || ch.settings.simulation || b.confirm_external,
        422,
        'Potwierdź cykliczny odczyt API i zapisy deklaracji wpłat',
      );
      const cfg = (
        await c.query(
          `INSERT INTO source_payment_configs(tenant_id,channel_id,actor_id,enabled,interval_seconds,connection_hash,external_authorized)
        VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(channel_id) DO UPDATE SET actor_id=excluded.actor_id,enabled=excluded.enabled,interval_seconds=excluded.interval_seconds,connection_hash=excluded.connection_hash,external_authorized=excluded.external_authorized,
        version=source_payment_configs.version+1,cursor=NULL,next_at=now(),error=NULL,updated_at=now() RETURNING enabled,interval_seconds,version,cursor,next_at,error`,
          [
            req.actor.tenantId,
            channel,
            req.actor.userId,
            b.enabled,
            b.interval_seconds,
            statusConnection(ch),
            b.enabled && !ch.settings.simulation && b.confirm_external,
          ],
        )
      ).rows[0];
      await c.query(
        "UPDATE jobs SET state='failed',lease_token=NULL,locked_at=NULL,error='Harmonogram płatności wyłączono lub zmieniono' WHERE kind='payment.source.read' AND state IN ('pending','running') AND payload->>'channel_id'=$1 AND payload->>'automatic'='true'",
        [channel],
      );
      await audit(c, req.actor, 'payment.source.configure', channel, {
        enabled: b.enabled,
        version: cfg.version,
      });
      return { config: cfg };
    });
  });
}
