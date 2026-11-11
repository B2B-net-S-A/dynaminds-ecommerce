import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { tenantTx } from './db';
import { ensure } from './errors';
import type { IntegrationContext } from './channel-access';
import { fetchOdooInvoiceFile, cachedOdooInvoiceFile } from './odoo-invoice-files';
import {
  odooExportInput,
  previewOdooExport,
  queueOdooExport,
  controlOdooExport,
} from './odoo-exports';
export function registerOdooExportRoutes(app: FastifyInstance, ctx: IntegrationContext = {}) {
  const id = (p: any) => z.object({ id: z.uuid() }).parse(p).id;
  const write = (r: any) =>
    ensure(['admin', 'operator'].includes(r.actor.role), 403, 'Brak prawa eksportu dokumentów');
  app.get('/api/odoo-invoicing/channels', (req) =>
    tenantTx(req.actor.tenantId, async (c) => ({
      data: (
        await c.query(
          "SELECT id,name,mode,settings,status FROM channels WHERE provider='odoo' ORDER BY name",
        )
      ).rows,
    })),
  );
  app.get('/api/orders/:id/odoo-invoices', (req) =>
    tenantTx(req.actor.tenantId, async (c) => {
      const order = id(req.params),
        q = z.object({ after: z.uuid().optional() }).parse(req.query);
      ensure(
        (await c.query('SELECT id FROM orders WHERE id=$1', [order])).rowCount,
        404,
        'Nie znaleziono zamówienia',
      );
      const rows = (
        await c.query(
          "SELECT p.*,ch.name AS channel_name,j.state AS job_state,CASE WHEN f.export_id IS NULL THEN NULL ELSE jsonb_build_object('filename',f.filename,'size',f.size,'sha256',f.sha256,'created_at',f.created_at,'mode',f.mode) END AS pdf FROM odoo_invoice_exports p JOIN channels ch ON (ch.tenant_id,ch.id)=(p.tenant_id,p.channel_id) LEFT JOIN jobs j ON j.id=p.job_id LEFT JOIN odoo_invoice_files f ON(f.tenant_id,f.export_id)=(p.tenant_id,p.id) WHERE p.order_id=$1 AND ($2::uuid IS NULL OR (p.created_at,p.id)<(SELECT created_at,id FROM odoo_invoice_exports WHERE id=$2 AND order_id=$1)) ORDER BY p.created_at DESC,p.id DESC LIMIT 26",
          [order, q.after ?? null],
        )
      ).rows;
      return {
        data: rows
          .slice(0, 25)
          .map((p) => ({ ...p, can_control: p.actor_id === req.actor.userId })),
        meta: { cursor: rows.length > 25 ? rows[24].id : null },
      };
    }),
  );
  app.post('/api/odoo-invoice-exports/:id/pdf', (req) => {
    write(req);
    z.object({})
      .strict()
      .parse(req.body ?? {});
    return fetchOdooInvoiceFile(req.actor, id(req.params), ctx);
  });
  app.get('/api/odoo-invoice-exports/:id/pdf', async (req, reply) => {
    const f = await cachedOdooInvoiceFile(req.actor, id(req.params));
    return reply
      .type('application/pdf')
      .header('Cache-Control', 'no-store')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Disposition', 'attachment; filename=' + f.filename)
      .send(f.pdf);
  });
  app.post('/api/documents/:id/odoo-export/preview', (req) => {
    write(req);
    return previewOdooExport(req.actor, id(req.params), odooExportInput.parse(req.body), ctx);
  });
  app.post('/api/odoo-invoice-exports/:id/queue', (req) => {
    write(req);
    const b = z
      .object({ confirm_data: z.boolean(), confirm_post: z.boolean().default(false) })
      .strict()
      .parse(req.body);
    return tenantTx(req.actor.tenantId, (c) =>
      queueOdooExport(c, req.actor, id(req.params), b.confirm_data, b.confirm_post),
    );
  });
  for (const action of ['cancel', 'reconcile'] as const)
    app.post('/api/odoo-invoice-exports/:id/' + action, (req) => {
      write(req);
      return tenantTx(req.actor.tenantId, (c) =>
        controlOdooExport(c, req.actor, id(req.params), action),
      );
    });
}
