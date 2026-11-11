import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { tenantTx } from './db';
import { ensure } from './errors';
import {
  startVariantBatch,
  approveVariantBatch,
  variantBatchAction,
  variantBatchInput,
} from './variant-offer-batches';
export function registerVariantOfferRoutes(app: FastifyInstance) {
  const admin = (r: any) => ensure(r.actor.role === 'admin', 403, 'Wymagana rola administratora');
  const id = (p: any) => z.object({ id: z.uuid() }).parse(p).id;
  app.get('/api/integrations/:id/variant-batches', (req) => {
    admin(req);
    return tenantTx(req.actor.tenantId, async (c) => {
      const channel = (
        await c.query(
          "SELECT id,name,mode,settings FROM channels WHERE id=$1 AND provider='woocommerce'",
          [id(req.params)],
        )
      ).rows[0];
      ensure(channel, 404, 'Nie znaleziono kanału WooCommerce');
      const data = (
        await c.query(
          'SELECT b.*,p.sku,p.name FROM variant_offer_batches b JOIN products p ON p.id=b.group_id WHERE b.channel_id=$1 ORDER BY b.created_at DESC,b.id DESC LIMIT 20',
          [channel.id],
        )
      ).rows;
      return { channel, data };
    });
  });
  app.post('/api/integrations/:id/variant-batches', (req, reply) => {
    admin(req);
    const b = variantBatchInput.parse(req.body);
    reply.code(201);
    return tenantTx(req.actor.tenantId, (c) => startVariantBatch(c, req.actor, id(req.params), b));
  });
  app.get('/api/variant-batches/:id', (req) => {
    admin(req);
    const q = z
      .object({
        after: z.uuid().optional(),
        limit: z.coerce.number().int().min(1).max(100).default(25),
        search: z.string().trim().max(100).default(''),
      })
      .parse(req.query);
    return tenantTx(req.actor.tenantId, async (c) => {
      const batch = (
        await c.query(
          'SELECT b.*,p.sku,p.name FROM variant_offer_batches b JOIN products p ON p.id=b.group_id WHERE b.id=$1',
          [id(req.params)],
        )
      ).rows[0];
      ensure(batch, 404, 'Nie znaleziono operacji wariantów');
      const counts = (
        await c.query(
          'SELECT state,count(*)::int AS count FROM variant_offer_batch_items WHERE batch_id=$1 GROUP BY state',
          [batch.id],
        )
      ).rows;
      const rows = (
        await c.query(
          `SELECT i.*,p.sku,p.name,o.state AS plan_state,o.phase,o.payload,o.remote_id,o.error AS plan_error,o.local_snapshot->>'currency' AS price_currency,o.remote_snapshot->>'prices_include_tax' AS prices_include_tax FROM variant_offer_batch_items i JOIN products p ON p.id=i.product_id LEFT JOIN offer_plans o ON o.id=i.plan_id WHERE i.batch_id=$1 AND ($2::uuid IS NULL OR i.id>$2) AND ($3='' OR strpos(lower(p.sku||' '||p.name),lower($3))>0) ORDER BY i.id LIMIT $4`,
          [batch.id, q.after ?? null, q.search, q.limit + 1],
        )
      ).rows;
      const data = rows.slice(0, q.limit);
      return {
        batch,
        counts: Object.fromEntries(counts.map((v) => [v.state, v.count])),
        data,
        meta: { cursor: rows.length > q.limit ? data.at(-1).id : null },
      };
    });
  });
  app.post('/api/variant-batches/:id/queue', (req) => {
    admin(req);
    const b = z
      .object({
        version: z.number().int().positive(),
        confirm_external: z.boolean().default(false),
      })
      .parse(req.body);
    return tenantTx(req.actor.tenantId, (c) =>
      approveVariantBatch(c, req.actor, id(req.params), b.version, b.confirm_external),
    );
  });
  for (const action of ['cancel', 'retry', 'recheck'] as const)
    app.post('/api/variant-batches/:id/' + action, (req) => {
      admin(req);
      const b = z.object({ version: z.number().int().positive() }).parse(req.body);
      return tenantTx(req.actor.tenantId, (c) =>
        variantBatchAction(c, req.actor, id(req.params), b.version, action),
      );
    });
}
