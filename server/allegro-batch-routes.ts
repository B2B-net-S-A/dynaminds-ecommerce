import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { tenantTx } from './db';
import { ensure } from './errors';
import {
  startAllegroBatch,
  allegroBatchInput,
  allegroBatchActionInput,
  allegroBatchApproveInput,
} from './allegro-batches';
import { approveVariantBatch, variantBatchAction } from './variant-offer-batches';
export function registerAllegroBatchRoutes(app: FastifyInstance) {
  const id = (p: any) => z.object({ id: z.uuid() }).parse(p).id;
  const admin = (r: any) => ensure(r.actor.role === 'admin', 403, 'Wymagana rola administratora');
  const page = z.object({
    after: z.uuid().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    search: z.string().trim().max(100).default(''),
  });
  app.get('/api/integrations/:id/allegro-batches', (req) => {
    admin(req);
    const q = page.parse(req.query);
    return tenantTx(req.actor.tenantId, async (c) => {
      const channel = (
        await c.query(
          "SELECT id,name,mode,settings FROM channels WHERE id=$1 AND provider='allegro'",
          [id(req.params)],
        )
      ).rows[0];
      ensure(channel, 404, 'Nie znaleziono kanału Allegro');
      const rows = (
        await c.query(
          "SELECT * FROM variant_offer_batches WHERE channel_id=$1 AND kind='allegro_catalog' AND ($2::uuid IS NULL OR id>$2) AND ($3='' OR strpos(lower(input->>'name'),lower($3))>0) ORDER BY id LIMIT $4",
          [channel.id, q.after ?? null, q.search, q.limit + 1],
        )
      ).rows;
      const data = rows.slice(0, q.limit);
      return { channel, data, meta: { cursor: rows.length > q.limit ? data.at(-1).id : null } };
    });
  });
  app.post('/api/integrations/:id/allegro-batches', (req, reply) => {
    admin(req);
    const b = allegroBatchInput.parse(req.body);
    reply.code(201);
    return tenantTx(req.actor.tenantId, (c) => startAllegroBatch(c, req.actor, id(req.params), b));
  });
  app.get('/api/allegro-batches/:id', (req) => {
    admin(req);
    const q = page.parse(req.query);
    return tenantTx(req.actor.tenantId, async (c) => {
      const batch = (
        await c.query(
          "SELECT * FROM variant_offer_batches WHERE id=$1 AND kind='allegro_catalog'",
          [id(req.params)],
        )
      ).rows[0];
      ensure(batch, 404, 'Nie znaleziono partii Allegro');
      const counts = (
        await c.query(
          'SELECT state,count(*)::int AS count FROM variant_offer_batch_items WHERE batch_id=$1 GROUP BY state',
          [batch.id],
        )
      ).rows;
      const rows = (
        await c.query(
          "SELECT i.*,p.sku,p.name,o.state AS plan_state,o.phase,o.payload,o.remote_id,o.error AS plan_error,o.result AS plan_result,o.remote_snapshot->'allegro_creation' AS creation_context,o.remote_snapshot AS remote_snapshot FROM variant_offer_batch_items i JOIN products p ON p.id=i.product_id LEFT JOIN offer_plans o ON o.id=i.plan_id WHERE i.batch_id=$1 AND ($2::uuid IS NULL OR i.id>$2) AND ($3='' OR strpos(lower(p.sku||' '||p.name),lower($3))>0) ORDER BY i.id LIMIT $4",
          [batch.id, q.after ?? null, q.search, q.limit + 1],
        )
      ).rows;
      const data = rows.slice(0, q.limit);
      return {
        batch,
        counts: Object.fromEntries(counts.map((r) => [r.state, r.count])),
        data,
        meta: { cursor: rows.length > q.limit ? data.at(-1).id : null },
      };
    });
  });
  for (const action of ['queue', 'cancel', 'retry', 'recheck'] as const)
    app.post('/api/allegro-batches/:id/' + action, (req) => {
      admin(req);
      const b = (action === 'queue' ? allegroBatchApproveInput : allegroBatchActionInput).parse(
        req.body,
      );
      return tenantTx(req.actor.tenantId, async (c) => {
        ensure(
          (
            await c.query(
              "SELECT id FROM variant_offer_batches WHERE id=$1 AND kind='allegro_catalog'",
              [id(req.params)],
            )
          ).rowCount,
          404,
          'Nie znaleziono partii Allegro',
        );
        return action === 'queue'
          ? approveVariantBatch(
              c,
              req.actor,
              id(req.params),
              b.version,
              'confirm_external' in b && b.confirm_external === true,
            )
          : variantBatchAction(c, req.actor, id(req.params), b.version, action);
      });
    });
}
