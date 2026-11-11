import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { tenantTx } from './db';
import { ensure } from './errors';
import {
  supplierInput,
  supplierSave,
  purchaseInput,
  purchaseVersion,
  purchaseFinish,
  purchaseReceive,
  purchaseDetail,
  purchaseSave,
  purchaseAction,
  purchaseReceipt,
} from './purchasing';
export function registerPurchasingRoutes(app: FastifyInstance) {
  const admin = (r: any) => ensure(r.actor.role === 'admin', 403, 'Wymagana rola administratora');
  const id = (p: any) => z.object({ id: z.uuid() }).parse(p).id;
  const page = z.object({
    search: z.string().trim().max(200).default(''),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    after: z.uuid().optional(),
  });
  app.get('/api/suppliers', (r) => {
    const q = page.extend({ active: z.enum(['true', 'false']).optional() }).parse(r.query);
    return tenantTx(r.actor.tenantId, async (c) => {
      const rows = (
        await c.query(
          `SELECT * FROM suppliers WHERE ($1='' OR name ILIKE '%'||$1||'%' OR code ILIKE '%'||$1||'%') AND ($2::boolean IS NULL OR active=$2) AND ($3::uuid IS NULL OR (created_at,id)<(SELECT created_at,id FROM suppliers WHERE id=$3)) ORDER BY created_at DESC,id DESC LIMIT $4`,
          [q.search, q.active ?? null, q.after ?? null, q.limit + 1],
        )
      ).rows;
      const data = rows.slice(0, q.limit);
      return { data, meta: { cursor: rows.length > q.limit ? data.at(-1).id : null } };
    });
  });
  app.post('/api/suppliers', async (r, reply) => {
    admin(r);
    const b = supplierInput.parse(r.body);
    return reply
      .code(201)
      .send(await tenantTx(r.actor.tenantId, (c) => supplierSave(c, r.actor, b)));
  });
  app.patch('/api/suppliers/:id', (r) => {
    admin(r);
    const b = supplierInput.extend(purchaseVersion.shape).parse(r.body);
    return tenantTx(r.actor.tenantId, (c) => supplierSave(c, r.actor, b, id(r.params), b.version));
  });
  app.get('/api/purchase-orders', (r) => {
    const q = page
      .extend({
        state: z
          .enum(['draft', 'ordered', 'partial', 'received', 'closed', 'cancelled'])
          .optional(),
      })
      .parse(r.query);
    return tenantTx(r.actor.tenantId, async (c) => {
      const rows = (
        await c.query(
          `SELECT p.*,p.expected_date::text AS expected_date,w.name AS warehouse_name,(SELECT sum(l.quantity::bigint*l.unit_cost) FROM purchase_order_lines l WHERE l.order_id=p.id) AS total_net FROM purchase_orders p JOIN warehouses w ON (w.tenant_id,w.id)=(p.tenant_id,p.warehouse_id) WHERE ($1='' OR p.number ILIKE '%'||$1||'%' OR p.reference ILIKE '%'||$1||'%' OR p.supplier_snapshot->>'name' ILIKE '%'||$1||'%') AND ($2::text IS NULL OR p.state=$2) AND ($3::uuid IS NULL OR (p.created_at,p.id)<(SELECT created_at,id FROM purchase_orders WHERE id=$3)) ORDER BY p.created_at DESC,p.id DESC LIMIT $4`,
          [q.search, q.state ?? null, q.after ?? null, q.limit + 1],
        )
      ).rows;
      const data = rows.slice(0, q.limit).map((d) => ({ ...d, total_net: Number(d.total_net) }));
      return { data, meta: { cursor: rows.length > q.limit ? data.at(-1).id : null } };
    });
  });
  app.get('/api/purchase-orders/:id', (r) =>
    tenantTx(r.actor.tenantId, (c) => purchaseDetail(c, id(r.params))),
  );
  app.post('/api/purchase-orders', async (r, reply) => {
    admin(r);
    const b = purchaseInput.parse(r.body);
    return reply
      .code(201)
      .send(
        await tenantTx(r.actor.tenantId, (c) => purchaseSave(c, r.actor, b), {
          purchasingAdmission: true,
        }),
      );
  });
  app.patch('/api/purchase-orders/:id', (r) => {
    admin(r);
    const b = purchaseInput.extend(purchaseVersion.shape).parse(r.body);
    return tenantTx(r.actor.tenantId, (c) => purchaseSave(c, r.actor, b, id(r.params), b.version), {
      purchasingAdmission: true,
    });
  });
  for (const action of ['place', 'close', 'cancel'] as const)
    app.post('/api/purchase-orders/:id/' + action, (r) => {
      admin(r);
      const b = (action === 'place' ? purchaseVersion : purchaseFinish).parse(r.body);
      return tenantTx(
        r.actor.tenantId,
        (c) => purchaseAction(c, r.actor, id(r.params), action, b),
        { purchasingAdmission: true },
      );
    });
  app.post('/api/purchase-orders/:id/receive', (r) => {
    admin(r);
    const b = purchaseReceive.parse(r.body);
    return tenantTx(r.actor.tenantId, (c) => purchaseReceipt(c, r.actor, id(r.params), b), {
      purchasingAdmission: true,
    });
  });
}
