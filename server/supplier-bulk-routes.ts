import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { tenantTx } from './db';
import { ensure } from './errors';
import { audit } from './domain';
import { bulkInput, startSupplierBulk } from './supplier-bulk';
const id = (r: any) => z.object({ id: z.uuid() }).parse(r.params).id;
const page = z.object({
  source_id: z.uuid().optional(),
  after: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export const bulkCancelInput = z.object({ version: z.number().int().positive() }).strict();
export function registerSupplierBulkRoutes(app: FastifyInstance) {
  app.post('/api/supplier-sources/:id/bulk-runs', (r) => {
    ensure(r.actor.role === 'admin', 403, 'Wymagana rola administratora');
    const b = bulkInput.parse(r.body);
    return tenantTx(r.actor.tenantId, (c) => startSupplierBulk(c, r.actor, id(r), b));
  });
  app.get('/api/supplier-bulk-runs', (r) => {
    const q = page.parse(r.query);
    return tenantTx(r.actor.tenantId, async (c) => {
      const rows = (
        await c.query(
          'SELECT r.*,j.run_at AS next_attempt_at,j.state AS job_state FROM supplier_bulk_runs r LEFT JOIN jobs j ON(r.tenant_id,r.job_id)=(j.tenant_id,j.id) WHERE ($1::uuid IS NULL OR r.source_id=$1) AND ($2::uuid IS NULL OR (r.created_at,r.id)<(SELECT created_at,id FROM supplier_bulk_runs WHERE id=$2 AND ($1::uuid IS NULL OR source_id=$1))) ORDER BY r.created_at DESC,r.id DESC LIMIT $3',
          [q.source_id ?? null, q.after ?? null, q.limit + 1],
        )
      ).rows;
      return {
        data: rows.slice(0, q.limit),
        meta: {
          cursor: rows.length > q.limit ? rows[q.limit - 1].id : null,
          has_more: rows.length > q.limit,
        },
      };
    });
  });
  app.get('/api/supplier-bulk-runs/:id', (r) => {
    const key = id(r),
      q = page.parse(r.query);
    return tenantTx(r.actor.tenantId, async (c) => {
      const run = (
        await c.query(
          'SELECT r.*,j.run_at AS next_attempt_at,j.state AS job_state FROM supplier_bulk_runs r LEFT JOIN jobs j ON(r.tenant_id,r.job_id)=(j.tenant_id,j.id) WHERE r.id=$1',
          [key],
        )
      ).rows[0];
      ensure(run, 404, 'Nie znaleziono masowego odczytu');
      const issues = (
        await c.query(
          'SELECT id,remote_product_id,remote_variant_id,error FROM supplier_bulk_issues WHERE run_id=$1 AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT $3',
          [key, q.after ?? null, q.limit + 1],
        )
      ).rows;
      return {
        run,
        data: issues.slice(0, q.limit),
        meta: {
          cursor: issues.length > q.limit ? issues[q.limit - 1].id : null,
          has_more: issues.length > q.limit,
        },
      };
    });
  });
  app.post('/api/supplier-bulk-runs/:id/cancel', (r) => {
    ensure(r.actor.role === 'admin', 403, 'Wymagana rola administratora');
    const key = id(r),
      b = bulkCancelInput.parse(r.body);
    return tenantTx(r.actor.tenantId, async (c) => {
      const peek = (await c.query('SELECT source_id FROM supplier_bulk_runs WHERE id=$1', [key]))
        .rows[0];
      ensure(peek, 404, 'Nie znaleziono masowego odczytu');
      await c.query('SELECT id FROM supplier_sources WHERE id=$1 FOR UPDATE', [peek.source_id]);
      const run = (await c.query('SELECT * FROM supplier_bulk_runs WHERE id=$1 FOR UPDATE', [key]))
        .rows[0];
      ensure(
        run.version === b.version && run.state === 'queued',
        409,
        'Masowy odczyt zmienił się lub jest zakończony',
      );
      await c.query(
        "UPDATE supplier_bulk_runs SET state='cancelled',finished_at=now(),version=version+1,error='Odczyt anulowany' WHERE id=$1",
        [key],
      );
      await c.query(
        "UPDATE jobs SET state='done',locked_at=NULL,lease_token=NULL,error='Odczyt anulowany' WHERE id=$1",
        [run.job_id],
      );
      await audit(c, r.actor, 'supplier.bulk.cancelled', key, {});
      return { ok: true };
    });
  });
}
