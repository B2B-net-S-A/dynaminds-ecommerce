import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { tenantTx } from './db';
import { ensure } from './errors';
import { audit } from './domain';
import { productSkuAvailable, resolveProductSkus } from './product-sku';
import { resolveProductCatalogInTx } from './product-catalogs';
import {
  catalogSourceInput,
  catalogConnectionMatches,
  catalogApplyInput,
  startCatalog,
  enqueueCatalog,
  applyCatalog,
} from './catalog-source';
export function registerCatalogSourceRoutes(app: FastifyInstance) {
  const admin = (r: any) => ensure(r.actor.role === 'admin', 403, 'Wymagana rola administratora');
  const id = (p: any) => z.object({ id: z.uuid() }).parse(p).id;
  app.get('/api/integrations/:id/catalog-source-runs', (req) => {
    admin(req);
    return tenantTx(req.actor.tenantId, async (c) => {
      const ch = (
        await c.query(
          "SELECT id,name,provider,mode,settings FROM channels WHERE id=$1 AND provider IN ('woocommerce','shopify','odoo','ebay','amazon')",
          [id(req.params)],
        )
      ).rows[0];
      ensure(ch, 404, 'Nie znaleziono kanału katalogu');
      const rows = (
        await c.query(
          'SELECT r.*,j.state AS job_state,j.attempts FROM catalog_source_runs r LEFT JOIN jobs j ON j.id=r.job_id WHERE r.channel_id=$1 ORDER BY r.created_at DESC,r.id DESC LIMIT 20',
          [ch.id],
        )
      ).rows;
      return { channel: ch, data: rows };
    });
  });
  app.post('/api/integrations/:id/catalog-source-runs', (req) => {
    admin(req);
    const b = catalogSourceInput.parse(req.body);
    return tenantTx(req.actor.tenantId, (c) => startCatalog(c, req.actor, id(req.params), b));
  });
  app.get('/api/catalog-source-runs/:id', (req) => {
    admin(req);
    const q = z
      .object({
        limit: z.coerce.number().int().min(1).max(100).default(25),
        after: z.uuid().optional(),
        search: z.string().trim().max(100).default(''),
        kind: z.enum(['simple', 'group', 'variant', 'unsupported']).optional(),
        state: z.enum(['staged', 'applied']).optional(),
        catalog_id: z.uuid().optional(),
      })
      .parse(req.query);
    return tenantTx(req.actor.tenantId, async (c) => {
      const run = (
        await c.query(
          'SELECT r.*,j.state AS job_state,j.attempts,j.run_at FROM catalog_source_runs r LEFT JOIN jobs j ON j.id=r.job_id WHERE r.id=$1',
          [id(req.params)],
        )
      ).rows[0];
      ensure(run, 404, 'Nie znaleziono importu katalogu');
      const catalog = await resolveProductCatalogInTx(c, q.catalog_id);
      const aliases = await productSkuAvailable(c);
      const rows = (
        await c.query(
          `SELECT i.*,p.id AS candidate_id,p.sku AS candidate_sku,p.version AS candidate_version,p.kind AS candidate_kind,p.parent_id AS candidate_parent_id,p.price AS candidate_price,s.on_hand AS candidate_on_hand,s.reserved AS candidate_reserved,parent.id AS parent_entry_id,parent.state AS parent_state FROM catalog_source_items i ${aliases ? "LEFT JOIN product_sku_aliases codes ON codes.tenant_id=i.tenant_id AND codes.sku=(i.source->>'sku')" : ''} LEFT JOIN products p ON p.tenant_id=i.tenant_id AND ${aliases ? 'p.id=codes.product_id' : "p.sku=(i.source->>'sku')"} ${catalog ? 'AND p.catalog_id=$8' : ''} LEFT JOIN stock s ON (s.tenant_id,s.product_id,s.warehouse_id)=(i.tenant_id,p.id,$2) LEFT JOIN catalog_source_items parent ON (parent.tenant_id,parent.run_id,parent.external_id)=(i.tenant_id,i.run_id,i.parent_external_id) WHERE i.run_id=$1 AND ($3::uuid IS NULL OR i.id>$3) AND ($4='' OR strpos(lower((i.source->>'sku')||' '||(i.source->>'name')||' '||i.external_id),lower($4))>0) AND ($5::text IS NULL OR i.kind=$5) AND ($6::text IS NULL OR i.state=$6) ORDER BY i.id LIMIT $7`,
          [
            run.id,
            run.warehouse_id,
            q.after ?? null,
            q.search,
            q.kind ?? null,
            q.state ?? null,
            q.limit + 1,
            ...(catalog ? [catalog.id] : []),
          ],
        )
      ).rows;
      const counts = (
        await c.query(
          'SELECT kind,state,count(*)::int AS count FROM catalog_source_items WHERE run_id=$1 GROUP BY kind,state ORDER BY kind,state',
          [run.id],
        )
      ).rows;
      const tenant = (
        await c.query('SELECT currency FROM tenants WHERE id=$1', [req.actor.tenantId])
      ).rows[0];
      return {
        run,
        data: rows.slice(0, q.limit),
        counts,
        currency: tenant.currency,
        ...(catalog ? { catalog_id: catalog.id } : {}),
        meta: { cursor: rows.length > q.limit ? rows[q.limit - 1].id : null },
      };
    });
  });
  app.get('/api/catalog-source-runs/:id/candidate', (req) => {
    admin(req);
    const q = z.object({ sku: z.string().trim().min(1).max(80), catalog_id: z.uuid().optional() }).parse(req.query);
    return tenantTx(req.actor.tenantId, async (c) => {
      ensure(
        (await c.query('SELECT id FROM catalog_source_runs WHERE id=$1', [id(req.params)]))
          .rowCount,
        404,
        'Nie znaleziono importu katalogu',
      );
      const catalog = await resolveProductCatalogInTx(c, q.catalog_id);
      const product = (await resolveProductSkus(c, [q.sku]))[0];
      const conflict = Boolean(catalog && product && product.catalog_id !== catalog.id);
      return { product: conflict ? null : product ?? null, catalog_conflict: conflict };
    });
  });
  app.post('/api/catalog-source-runs/:id/apply', (req) => {
    admin(req);
    const b = catalogApplyInput.parse(req.body);
    return tenantTx(req.actor.tenantId, (c) => applyCatalog(c, req.actor, id(req.params), b));
  });
  app.post('/api/catalog-source-runs/:id/retry', (req) => {
    admin(req);
    return tenantTx(req.actor.tenantId, async (c) => {
      const r = (
        await c.query('SELECT * FROM catalog_source_runs WHERE id=$1 FOR UPDATE', [id(req.params)])
      ).rows[0];
      ensure(r, 404, 'Nie znaleziono importu katalogu');
      ensure(r.actor_id === req.actor.userId, 403, 'Wznawia administrator, który rozpoczął import');
      ensure(r.state === 'failed', 409, 'Wznowić można nieudane pobieranie');
      const ch = (await c.query('SELECT * FROM channels WHERE id=$1', [r.channel_id])).rows[0];
      ensure(
        catalogConnectionMatches(ch, r),
        409,
        'Połączenie zmieniono; rozpocznij nowy przegląd',
      );
      const job = await enqueueCatalog(c, req.actor, r);
      await audit(c, req.actor, 'catalog.source.retry', r.id, { job_id: job });
      return { id: r.id, job_id: job };
    });
  });
  app.post('/api/catalog-source-runs/:id/cancel', (req) => {
    admin(req);
    return tenantTx(req.actor.tenantId, async (c) => {
      const r = (
        await c.query('SELECT * FROM catalog_source_runs WHERE id=$1 FOR UPDATE', [id(req.params)])
      ).rows[0];
      ensure(r, 404, 'Nie znaleziono importu katalogu');
      ensure(['queued', 'failed'].includes(r.state), 409, 'Import nie jest w trakcie pobierania');
      await c.query(
        "UPDATE jobs SET state='failed',error='Pobieranie anulowano',lease_token=NULL,locked_at=NULL WHERE id=$1 AND state IN('pending','running')",
        [r.job_id],
      );
      await c.query(
        "UPDATE catalog_source_runs SET state='cancelled',error=NULL,updated_at=now() WHERE id=$1",
        [r.id],
      );
      await audit(c, req.actor, 'catalog.source.cancel', r.id);
      return { id: r.id, state: 'cancelled' };
    });
  });
}
