import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { tenantTx } from './db';
import { audit } from './domain';
import { ensure } from './errors';
import { randomUUID } from 'node:crypto';
import { encrypt } from './security';
import {
  supplierSourceInput,
  supplierStateInput,
  supplierLinkInput,
  supplierProductInput,
  supplierReadInput,
  supplierPurchaseInput,
  saveSupplierSource,
  startSupplierRead,
  linkSupplierItem,
  createSupplierProduct,
  purchaseFromSupplier,
} from './supplier-catalog';
const id = (r: any) => z.object({ id: z.uuid() }).parse(r.params).id;
const page = z.object({
  source_id: z.uuid().optional(),
  search: z.string().trim().max(100).default(''),
  after: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
const canWrite = (a: { role: string }, _admin: boolean) =>
  ensure(a.role === 'admin', 403, 'Wymagana rola administratora');
export function registerSupplierCatalogRoutes(
  app: FastifyInstance,
  { fileSourcesAvailable = false } = {},
) {
  const sourceSelect = fileSourcesAvailable
    ? "SELECT s.*,p.name AS supplier_name,coalesce(ch.name,s.name) AS channel_name,coalesce(ch.mode,'file') AS mode,ch.settings->>'simulation' AS simulation FROM supplier_sources s JOIN suppliers p ON(p.tenant_id,p.id)=(s.tenant_id,s.supplier_id) LEFT JOIN channels ch ON(ch.tenant_id,ch.id)=(s.tenant_id,s.channel_id)"
    : "SELECT s.*,p.name AS supplier_name,ch.name AS channel_name,ch.mode,ch.settings->>'simulation' AS simulation FROM supplier_sources s JOIN suppliers p ON(p.tenant_id,p.id)=(s.tenant_id,s.supplier_id) JOIN channels ch ON(ch.tenant_id,ch.id)=(s.tenant_id,s.channel_id)";
  app.get('/api/supplier-sources/:id', (r) =>
    tenantTx(r.actor.tenantId, async (c) => {
      const row = (await c.query(sourceSelect + ' WHERE s.id=$1', [id(r)])).rows[0];
      ensure(row, 404, 'Nie znaleziono źródła');
      return row;
    }),
  );
  app.get('/api/supplier-sources', (r) => {
    const q = page.parse(r.query);
    return tenantTx(r.actor.tenantId, async (c) => {
      const rows = (
        await c.query(
          sourceSelect + ' WHERE ($1::uuid IS NULL OR s.id>$1) ORDER BY s.id LIMIT $2',
          [q.after ?? null, q.limit + 1],
        )
      ).rows;
      return {
        data: rows.slice(0, q.limit),
        meta: {
          has_more: rows.length > q.limit,
          cursor: rows.length > q.limit ? rows[q.limit - 1].id : null,
        },
      };
    });
  });
  app.post('/api/supplier-sources', (r) => {
    canWrite(r.actor, true);
    const b = supplierSourceInput.parse(r.body);
    return tenantTx(r.actor.tenantId, (c) => saveSupplierSource(c, r.actor, b));
  });
  app.patch('/api/supplier-sources/:id/state', (r) => {
    canWrite(r.actor, true);
    const b = supplierStateInput.parse(r.body),
      key = id(r);
    return tenantTx(r.actor.tenantId, async (c) => {
      const s = (await c.query('SELECT * FROM supplier_sources WHERE id=$1 FOR UPDATE', [key]))
        .rows[0];
      ensure(s, 404, 'Nie znaleziono źródła');
      ensure(s.version === b.version, 409, 'Źródło zmieniło się');
      await c.query('UPDATE supplier_sources SET paused=$2,version=version+1 WHERE id=$1', [
        key,
        b.paused,
      ]);
      if (b.paused) {
        await c.query(
          "UPDATE supplier_schedules SET enabled=false,version=version+1,next_at=NULL,error='Źródło wstrzymane',updated_at=now() WHERE source_id=$1 AND enabled",
          [key],
        );
        const bulk = (
          await c.query(
            "UPDATE supplier_bulk_runs SET state='cancelled',error='Źródło wstrzymane',finished_at=now(),version=version+1 WHERE source_id=$1 AND state='queued' RETURNING job_id",
            [key],
          )
        ).rows;
        await c.query(
          "UPDATE jobs SET state='done',lease_token=NULL,locked_at=NULL,error='Źródło wstrzymane' WHERE id=ANY($1::uuid[])",
          [bulk.map((r) => r.job_id)],
        );
        const cancelled = (
          await c.query(
            "UPDATE supplier_catalog_reads SET state='cancelled',error='Źródło wstrzymane',finished_at=now() WHERE source_id=$1 AND state='queued' RETURNING job_id",
            [key],
          )
        ).rows;
        await c.query(
          "UPDATE jobs SET state='done',lease_token=NULL,locked_at=NULL,error='Źródło wstrzymane' WHERE id=ANY($1::uuid[])",
          [cancelled.map((r) => r.job_id)],
        );
      }
      await audit(c, r.actor, 'supplier.source.state', key, { paused: b.paused });
      return { ok: true };
    });
  });
  app.post('/api/supplier-sources/:id/reads', (r) => {
    canWrite(r.actor, true);
    const b = supplierReadInput.parse(r.body);
    return tenantTx(r.actor.tenantId, (c) => startSupplierRead(c, r.actor, id(r), b));
  });
  app.get('/api/supplier-reads', (r) => {
    const q = page.parse(r.query);
    return tenantTx(r.actor.tenantId, async (c) => {
      const rows = (
        await c.query(
          'SELECT id,source_id,remote_product_id,remote_variant_id,state,phase,error,created_at,finished_at FROM supplier_catalog_reads WHERE ($1::uuid IS NULL OR source_id=$1) AND ($2::uuid IS NULL OR (created_at,id)<(SELECT created_at,id FROM supplier_catalog_reads WHERE id=$2 AND ($1::uuid IS NULL OR source_id=$1))) ORDER BY created_at DESC,id DESC LIMIT $3',
          [q.source_id ?? null, q.after ?? null, q.limit + 1],
        )
      ).rows;
      return {
        data: rows.slice(0, q.limit),
        meta: {
          has_more: rows.length > q.limit,
          cursor: rows.length > q.limit ? rows[q.limit - 1].id : null,
        },
      };
    });
  });
  app.get('/api/supplier-catalog', (r) => {
    const q = page.parse(r.query);
    return tenantTx(r.actor.tenantId, async (c) => {
      const rows = (
        await c.query(
          "SELECT i.*,p.sku AS local_sku,p.name AS local_name,s.currency,s.paused,s.max_handling_days FROM supplier_catalog_items i JOIN supplier_sources s ON(s.tenant_id,s.id)=(i.tenant_id,i.source_id) LEFT JOIN products p ON(p.tenant_id,p.id)=(i.tenant_id,i.product_id) WHERE ($1::uuid IS NULL OR i.source_id=$1) AND ($2='' OR i.sku ILIKE $3 OR i.name ILIKE $3) AND ($4::uuid IS NULL OR i.id>$4) ORDER BY i.id LIMIT $5",
          [q.source_id ?? null, q.search, '%' + q.search + '%', q.after ?? null, q.limit + 1],
        )
      ).rows;
      return {
        data: rows.slice(0, q.limit),
        meta: {
          has_more: rows.length > q.limit,
          cursor: rows.length > q.limit ? rows[q.limit - 1].id : null,
        },
      };
    });
  });
  app.patch('/api/supplier-catalog/:id/link', (r) => {
    canWrite(r.actor, true);
    const b = supplierLinkInput.parse(r.body);
    return tenantTx(r.actor.tenantId, (c) =>
      linkSupplierItem(c, r.actor, id(r), b.version, b.product_id),
    );
  });
  app.post('/api/supplier-catalog/:id/product', (r) => {
    canWrite(r.actor, true);
    const b = supplierProductInput.parse(r.body);
    return tenantTx(r.actor.tenantId, (c) => createSupplierProduct(c, r.actor, id(r), b));
  });
  app.post('/api/supplier-sources/:id/purchase', (r) => {
    canWrite(r.actor, true);
    const b = supplierPurchaseInput.parse(r.body);
    ensure(!r.apiScopes || r.currentUser.api_key_id, 401, 'Brak kontekstu klucza API');
    const actor = { ...r.actor, ...(r.apiScopes ? { apiKeyId: r.currentUser.api_key_id } : {}) };
    return tenantTx(r.actor.tenantId, (c) => purchaseFromSupplier(c, actor, id(r), b), {
      purchasingAdmission: true,
    });
  });
  app.post('/api/supplier-sources/demo', (r) => {
    canWrite(r.actor, true);
    const b = z.object({ supplier_id: z.uuid() }).strict().parse(r.body);
    return tenantTx(r.actor.tenantId, async (c) => {
      const ch = randomUUID();
      await c.query(
        "INSERT INTO channels(id,tenant_id,provider,name,mode,credentials,settings) VALUES($1,$2,'bigbuy','BigBuy — przykład lokalny','sandbox',$3,'{\"simulation\":true}')",
        [ch, r.actor.tenantId, encrypt({})],
      );
      return saveSupplierSource(
        c,
        r.actor,
        supplierSourceInput.parse({ channel_id: ch, supplier_id: b.supplier_id, currency: 'EUR' }),
      );
    });
  });
}
