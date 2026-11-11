import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { tenantTx } from './db';
import { ensure } from './errors';
import { deeplAdmin } from './deepl-catalog';
import { batch, prepareBatch, queueBatch, cancelBatch, applyBatchProduct } from './deepl-batches';
import type { IntegrationContext } from './channel-access';
export function registerDeepLBatchRoutes(
  app: FastifyInstance,
  ctx: IntegrationContext,
  options: { available: boolean; readOnly: boolean },
) {
  const available = () => ensure(options.available, 503, 'Kopia nie zawiera masowych tłumaczeń'),
    id = (req: any) => z.object({ id: z.uuid() }).parse(req.params).id;
  app.get('/api/deepl/batches', async (req) => {
    ensure(req.actor.role === 'admin', 403, 'Wymagany administrator');
    if (!options.available)
      return {
        available: false,
        read_only: options.readOnly,
        data: [],
        channels: [],
        cursor: null,
      };
    const q = z.object({ after: z.uuid().optional() }).strict().parse(req.query);
    return tenantTx(req.actor.tenantId, async (c) => {
      await deeplAdmin(c, req.actor);
      if (q.after) await batch(c, q.after);
      const rows = (
        await c.query(
          "SELECT b.*,COALESCE((SELECT jsonb_object_agg(s.state,s.n) FROM (SELECT state,count(*)::int n FROM deepl_catalog_drafts WHERE batch_id=b.id GROUP BY state)s),'{}'::jsonb) counts FROM deepl_catalog_batches b WHERE ($1::uuid IS NULL OR (b.created_at,b.id)<(SELECT created_at,id FROM deepl_catalog_batches WHERE id=$1)) ORDER BY b.created_at DESC,b.id DESC LIMIT 21",
          [q.after ?? null],
        )
      ).rows;
      return {
        available: true,
        read_only: options.readOnly,
        data: rows.slice(0, 20),
        cursor: rows.length > 20 ? rows[19].id : null,
        channels: (
          await c.query(
            "SELECT id,name,settings->>'api_plan' api_plan,settings->>'simulation'='true' simulation FROM channels WHERE provider='deepl' ORDER BY created_at DESC,id LIMIT 100",
          )
        ).rows,
      };
    });
  });
  app.get('/api/deepl/batches/:id', async (req) => {
    available();
    const q = z
      .object({ page: z.coerce.number().int().min(1).max(100).default(1) })
      .strict()
      .parse(req.query);
    return tenantTx(req.actor.tenantId, async (c) => {
      await deeplAdmin(c, req.actor);
      const b = await batch(c, id(req));
      const products = (
        await c.query(
          'SELECT product_id,min(batch_ordinal)::int ordinal,min(batch_sku) sku,min(source_version) source_version FROM deepl_catalog_drafts WHERE batch_id=$1 GROUP BY product_id ORDER BY min(batch_ordinal) LIMIT 5 OFFSET $2',
          [b.id, (q.page - 1) * 5],
        )
      ).rows;
      const drafts = (
        await c.query(
          'SELECT d.*,p.version current_version FROM deepl_catalog_drafts d JOIN products p ON (p.tenant_id,p.id)=(d.tenant_id,d.product_id) WHERE batch_id=$1 AND product_id=ANY($2::uuid[]) ORDER BY batch_ordinal',
          [b.id, products.map((p) => p.product_id)],
        )
      ).rows;
      const counts = Object.fromEntries(
        (
          await c.query(
            'SELECT state,count(*)::int n FROM deepl_catalog_drafts WHERE batch_id=$1 GROUP BY state',
            [b.id],
          )
        ).rows.map((r) => [r.state, r.n]),
      );
      return {
        batch: b,
        counts,
        products: products.map((p) => ({
          ...p,
          drafts: drafts.filter((d) => d.product_id === p.product_id),
        })),
        page: q.page,
        pages: Math.ceil(b.product_count / 5),
        read_only: options.readOnly,
      };
    });
  });
  app.post('/api/deepl/batches/preview', async (req, reply) => {
    available();
    return reply.code(201).send(await prepareBatch(req.actor, req.body, ctx));
  });
  app.post('/api/deepl/batches/:id/queue', (req) => {
    available();
    return queueBatch(req.actor, id(req), req.body);
  });
  app.post('/api/deepl/batches/:id/cancel', (req) => {
    available();
    return cancelBatch(req.actor, id(req));
  });
  app.post('/api/deepl/batches/:id/products/:product/apply', (req) => {
    available();
    const p = z.object({ id: z.uuid(), product: z.uuid() }).parse(req.params);
    return applyBatchProduct(req.actor, p.id, p.product, req.body);
  });
}
