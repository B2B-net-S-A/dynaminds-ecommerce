import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { tenantTx } from './db';
import { ensure } from './errors';
import {
  warehouseSchema,
  versionSchema,
  warehouseDetail,
  createWarehouseDocument,
  editWarehouseDocument,
  postWarehouseDocument,
  cancelWarehouseDocument,
} from './warehouse';
export function registerWarehouseRoutes(app: FastifyInstance) {
  const admin = (req: any) =>
    ensure(req.actor.role === 'admin', 403, 'Wymagana rola administratora');
  const id = (params: any) => z.object({ id: z.uuid() }).parse(params).id;
  app.get('/api/warehouse-documents', (req) => {
    const q = z
      .object({
        kind: z.enum(['receipt', 'transfer', 'count', 'issue']).optional(),
        status: z.enum(['draft', 'posted', 'cancelled']).optional(),
        limit: z.coerce.number().int().min(1).max(100).default(25),
        after: z.uuid().optional(),
      })
      .parse(req.query);
    return tenantTx(req.actor.tenantId, async (c) => {
      const result = await c.query(
        `SELECT d.*,w.name AS warehouse_name,t.name AS destination_name
        FROM warehouse_documents d JOIN warehouses w ON (w.tenant_id,w.id)=(d.tenant_id,d.warehouse_id)
        LEFT JOIN warehouses t ON (t.tenant_id,t.id)=(d.tenant_id,d.destination_id)
        WHERE ($1::text IS NULL OR d.kind=$1) AND ($2::text IS NULL OR d.status=$2)
        AND ($3::uuid IS NULL OR (d.created_at,d.id)<(SELECT created_at,id FROM warehouse_documents WHERE id=$3))
        ORDER BY d.created_at DESC,d.id DESC LIMIT $4`,
        [q.kind ?? null, q.status ?? null, q.after ?? null, q.limit + 1],
      );
      const more = result.rows.length > q.limit,
        data = result.rows.slice(0, q.limit);
      return { data, meta: { cursor: more ? data.at(-1).id : null } };
    });
  });
  app.get('/api/warehouse-documents/:id', (req) =>
    tenantTx(req.actor.tenantId, (c) => warehouseDetail(c, id(req.params))),
  );
  app.post('/api/warehouse-documents', async (req, reply) => {
    admin(req);
    const b = warehouseSchema.parse(req.body);
    const d = await tenantTx(req.actor.tenantId, (c) => createWarehouseDocument(c, req.actor, b));
    return reply.code(201).send(d);
  });
  app.patch('/api/warehouse-documents/:id', (req) => {
    admin(req);
    const b = warehouseSchema.extend(versionSchema.shape).parse(req.body);
    return tenantTx(req.actor.tenantId, (c) =>
      editWarehouseDocument(c, req.actor, id(req.params), b),
    );
  });
  for (const action of ['post', 'cancel'] as const)
    app.post('/api/warehouse-documents/:id/' + action, (req) => {
      admin(req);
      const b = versionSchema.parse(req.body);
      return tenantTx(req.actor.tenantId, (c) =>
        (action === 'post' ? postWarehouseDocument : cancelWarehouseDocument)(
          c,
          req.actor,
          id(req.params),
          b.version,
        ),
      );
    });
}
