import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { tenantTx } from './db';
import { ensure } from './errors';
import { audit } from './domain';
import { channelRead, type IntegrationContext } from './channel-access';
import { Fakturownia } from './integrations';
import {
  invoiceInput,
  previewInvoice,
  queueInvoice,
  lockedInvoice,
  invoiceJob,
  invoiceExample,
  verifiedInvoice,
} from './invoices';
export async function invoicePdf(tenant: string, id: string, ctx: IntegrationContext) {
  const doc = await tenantTx(
    tenant,
    async (c) => (await c.query('SELECT * FROM documents WHERE id=$1', [id])).rows[0],
  );
  ensure(
    doc?.mode === 'external' && doc.channel_id && doc.external_id,
    404,
    'Nie znaleziono dokumentu dostawcy',
  );
  return channelRead(
    tenant,
    doc.channel_id,
    (client) => {
      ensure(client instanceof Fakturownia, 422, 'Wymagana Fakturownia');
      return client.invoicePdf(doc.external_id);
    },
    ctx,
  );
}
export function registerInvoiceRoutes(app: FastifyInstance, ctx: IntegrationContext = {}) {
  const id = (p: unknown) => z.object({ id: z.uuid() }).parse(p).id;
  const write = (req: any) =>
    ensure(
      ['admin', 'operator'].includes(req.actor.role),
      403,
      'Brak prawa wystawiania dokumentów',
    );
  app.get('/api/invoicing/channels', (req) =>
    tenantTx(req.actor.tenantId, async (c) => ({
      data: (
        await c.query(
          "SELECT id,name,mode,settings,status FROM channels WHERE provider='fakturownia' ORDER BY name",
        )
      ).rows,
    })),
  );
  app.post('/api/invoicing/example', (req) => {
    ensure(req.actor.role === 'admin', 403, 'Wymagana rola administratora');
    return invoiceExample(req.actor);
  });
  app.get('/api/orders/:id/invoicing', (req) =>
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
          `SELECT p.*,ch.name AS channel_name,ch.mode AS channel_mode,ch.settings->>'simulation' AS simulation,j.state AS job_state,j.attempts FROM invoice_plans p JOIN channels ch ON (ch.tenant_id,ch.id)=(p.tenant_id,p.channel_id) LEFT JOIN jobs j ON j.id=p.job_id WHERE p.order_id=$1 AND ($2::uuid IS NULL OR (p.created_at,p.id)<(SELECT created_at,id FROM invoice_plans WHERE id=$2 AND order_id=$1)) ORDER BY p.created_at DESC,p.id DESC LIMIT 26`,
          [order, q.after ?? null],
        )
      ).rows;
      return { data: rows.slice(0, 25), meta: { cursor: rows.length > 25 ? rows[24].id : null } };
    }),
  );
  app.post('/api/orders/:id/invoicing/preview', (req) => {
    write(req);
    return previewInvoice(req.actor, id(req.params), invoiceInput.parse(req.body));
  });
  app.post('/api/invoice-plans/:id/queue', (req) => {
    write(req);
    const b = z
      .object({
        confirm_external: z.boolean().default(false),
        confirm_data: z.boolean().default(false),
      })
      .parse(req.body ?? {});
    return tenantTx(req.actor.tenantId, (c) =>
      queueInvoice(c, req.actor, id(req.params), b.confirm_external, b.confirm_data),
    );
  });
  app.post('/api/invoice-plans/:id/cancel', (req) => {
    write(req);
    return tenantTx(req.actor.tenantId, async (c) => {
      const { p } = await lockedInvoice(c, id(req.params));
      ensure(p.actor_id === req.actor.userId, 403, 'Plan obsługuje autor');
      if (p.state === 'cancelled') return { id: p.id };
      ensure(
        (p.state === 'preview' || p.state === 'failed') && p.phase === 'ready',
        409,
        'Nie można anulować niepewnego lub wystawionego dokumentu',
      );
      await c.query("UPDATE invoice_plans SET state='cancelled',updated_at=now() WHERE id=$1", [
        p.id,
      ]);
      await audit(c, req.actor, 'invoice.cancel.local', p.id);
      return { id: p.id };
    });
  });
  app.post('/api/invoice-plans/:id/reconcile', (req) => {
    write(req);
    return tenantTx(req.actor.tenantId, async (c) => {
      const { p } = await lockedInvoice(c, id(req.params));
      ensure(p.actor_id === req.actor.userId, 403, 'Plan obsługuje autor');
      ensure(p.state === 'failed', 409, 'Uzgodnienie dostępne po błędzie zadania');
      await audit(c, req.actor, 'invoice.reconcile', p.id, { phase: p.phase });
      return invoiceJob(c, req.actor, p);
    });
  });
  app.post('/api/documents/:id/provider-status', async (req) => {
    write(req);
    const docId = id(req.params);
    const p = await tenantTx(
      req.actor.tenantId,
      async (c) =>
        (
          await c.query(
            "SELECT p.*,d.mode AS document_mode FROM invoice_plans p JOIN documents d ON (d.tenant_id,d.id)=(p.tenant_id,p.document_id) WHERE p.document_id=$1 AND p.state='done'",
            [docId],
          )
        ).rows[0],
    );
    ensure(p, 404, 'Nie znaleziono faktury Fakturownia');
    if (p.document_mode === 'simulation') return { ...p.result, refreshed: false };
    const r = await channelRead(
      req.actor.tenantId,
      p.channel_id,
      (client) => {
        ensure(client instanceof Fakturownia, 422, 'Wymagana Fakturownia');
        return client.invoice(p.remote_id);
      },
      ctx,
    );
    const result = {
      ...verifiedInvoice(p, r),
      scope: 'external_api_verified',
      checked_at: new Date().toISOString(),
    };
    await tenantTx(req.actor.tenantId, async (c) => {
      await c.query('UPDATE invoice_plans SET result=$2,updated_at=now() WHERE id=$1', [
        p.id,
        JSON.stringify(result),
      ]);
      await c.query("UPDATE documents SET data=jsonb_set(data,'{result}',$2::jsonb) WHERE id=$1", [
        docId,
        JSON.stringify(result),
      ]);
      await audit(c, req.actor, 'invoice.status', docId, {
        status: result.status,
        gov_status: result.gov_status,
        gov_id: result.gov_id,
      });
    });
    return result;
  });
}
