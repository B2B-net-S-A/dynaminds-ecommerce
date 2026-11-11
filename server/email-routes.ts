import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { tenantTx } from './db';
import { audit } from './domain';
import { ensure } from './errors';
import { cacheInvoiceEmailFile, savedEmailFile } from './email-attachments';
import type { IntegrationContext } from './channel-access';
import {
  emailTemplate,
  emailTemplatePreview,
  previewEmailTemplate,
  emailPreview,
  emailHash,
  emailConfirmation,
  validateEmailTemplate,
  prepareEmail,
  queueEmail,
  emailBatch,
  finishEmailBatch,
} from './email';
export const emailHistoryQuery = z
  .object({
    after: z.uuid().optional(),
    order_id: z.uuid().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();
export function registerEmailRoutes(
  app: FastifyInstance,
  available: boolean,
  attachmentsAvailable = false,
  ctx: IntegrationContext = {},
) {
  const id = (p: unknown) => z.object({ id: z.uuid() }).parse(p).id;
  const write = (req: any, admin = false) => {
    ensure(available, 404, 'Email nie jest dostępny w tym schemacie');
    ensure(
      admin ? req.actor.role === 'admin' : req.actor.role !== 'viewer',
      403,
      'Brak prawa komunikacji email',
    );
  };
  const read = () => ensure(available, 404, 'Email nie jest dostępny w tym schemacie');
  app.get('/api/email/templates', (req) => {
    read();
    return tenantTx(req.actor.tenantId, async (c) => ({
      data: (await c.query('SELECT * FROM email_templates ORDER BY name,id LIMIT 100')).rows,
    }));
  });
  app.post('/api/email/templates', (req) => {
    write(req, true);
    const { client_key, ...raw } = emailTemplate.extend({ client_key: z.uuid() }).parse(req.body),
      b = validateEmailTemplate(raw);
    ensure(
      attachmentsAvailable || b.attachment === 'none',
      404,
      'Załączniki email niedostępne w tym schemacie',
    );
    return tenantTx(req.actor.tenantId, async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        'email-template:' + req.actor.tenantId,
      ]);
      const hash = emailHash(b),
        old = (await c.query('SELECT * FROM email_templates WHERE client_key=$1', [client_key]))
          .rows[0];
      if (old) {
        ensure(old.creation_hash === hash, 409, 'Klucz szablonu ma inną treść');
        return old;
      }
      ensure(
        (await c.query('SELECT count(*)::int n FROM email_templates')).rows[0].n < 100,
        422,
        'Limit100 szablonów email',
      );
      const t = (
        await c.query(
          `INSERT INTO email_templates(id,tenant_id,name,subject,body,html,active,client_key,creation_hash${attachmentsAvailable ? ',attachment' : ''}) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9${attachmentsAvailable ? ',$10' : ''}) RETURNING *`,
          [
            randomUUID(),
            req.actor.tenantId,
            b.name,
            b.subject,
            b.body,
            b.html,
            b.active,
            client_key,
            hash,
            ...(attachmentsAvailable ? [b.attachment] : []),
          ],
        )
      ).rows[0];
      await audit(c, req.actor, 'email.template.create', t.id, { active: t.active });
      return t;
    });
  });
  app.patch('/api/email/templates/:id', (req) => {
    write(req, true);
    const { version, ...raw } = emailTemplate
        .extend({ version: z.string().regex(/^\d+$/) })
        .parse(req.body),
      b = validateEmailTemplate(raw);
    ensure(
      attachmentsAvailable || b.attachment === 'none',
      404,
      'Załączniki email niedostępne w tym schemacie',
    );
    return tenantTx(req.actor.tenantId, async (c) => {
      const t = (
        await c.query('SELECT * FROM email_templates WHERE id=$1 FOR UPDATE', [id(req.params)])
      ).rows[0];
      ensure(t, 404, 'Brak szablonu');
      ensure(t.version === version, 409, 'Szablon zmienił się');
      const result = (
        await c.query(
          `UPDATE email_templates SET name=$2,subject=$3,body=$4,html=$5,active=$6${attachmentsAvailable ? ',attachment=$7' : ''},version=version+1 WHERE id=$1 RETURNING *`,
          [
            t.id,
            b.name,
            b.subject,
            b.body,
            b.html,
            b.active,
            ...(attachmentsAvailable ? [b.attachment] : []),
          ],
        )
      ).rows[0];
      await audit(c, req.actor, 'email.template.update', t.id, { version: result.version });
      return result;
    });
  });
  // Live preview in the template editor: render only, nothing is saved or queued.
  app.post('/api/email/templates/preview', (req) => {
    write(req);
    const input = emailTemplatePreview.parse(req.body);
    return tenantTx(req.actor.tenantId, (c) => previewEmailTemplate(c, input));
  });
  app.post('/api/email/preview', (req) => {
    write(req);
    return tenantTx(req.actor.tenantId, (c) =>
      prepareEmail(c, req.actor, emailPreview.parse(req.body)),
    );
  });
  app.post('/api/documents/:id/email-file', (req) => {
    write(req);
    ensure(attachmentsAvailable, 404, 'Załączniki email niedostępne w tym schemacie');
    z.object({ confirmed: z.literal(true) })
      .strict()
      .parse(req.body);
    return cacheInvoiceEmailFile(req.actor, id(req.params), ctx);
  });
  app.get('/api/email/messages/:id/attachment', async (req, reply) => {
    read();
    ensure(attachmentsAvailable, 404, 'Załączniki email niedostępne w tym schemacie');
    const f = await tenantTx(req.actor.tenantId, async (c) => {
      const m = (await c.query('SELECT payload FROM email_messages WHERE id=$1', [id(req.params)]))
        .rows[0];
      ensure(m?.payload?.attachment, 404, 'Brak załącznika wiadomości');
      return savedEmailFile(c, id(req.params), m.payload.attachment);
    });
    return reply
      .type(f.content_type)
      .header('Cache-Control', 'no-store')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Disposition', `attachment; filename="${f.filename}"`)
      .send(f.bytes);
  });
  app.get('/api/email/batches/:id', (req) => {
    read();
    return tenantTx(req.actor.tenantId, (c) => emailBatch(c, id(req.params)));
  });
  app.post('/api/email/batches/:id/queue', (req) => {
    write(req);
    const input = emailConfirmation.parse(req.body);
    return tenantTx(req.actor.tenantId, (c) => queueEmail(c, req.actor, id(req.params), input));
  });
  app.post('/api/email/batches/:id/cancel', (req) => {
    write(req);
    z.object({ confirmed: z.literal(true) })
      .strict()
      .parse(req.body);
    return tenantTx(req.actor.tenantId, async (c) => {
      const batchId = id(req.params);
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        'email-queue:' + req.actor.tenantId,
      ]);
      // Job locks before messages, same order as worker. Batch rows are changed last.
      const jobs = (
        await c.query(
          'SELECT j.id,j.state FROM jobs j JOIN email_messages m ON (m.tenant_id,m.job_id)=(j.tenant_id,j.id) WHERE m.batch_id=$1 ORDER BY j.id FOR UPDATE OF j',
          [batchId],
        )
      ).rows;
      const b = (await c.query('SELECT * FROM email_batches WHERE id=$1', [batchId])).rows[0];
      ensure(b, 404, 'Brak partii');
      ensure(['preview', 'queued', 'cancelled'].includes(b.state), 409, 'Partia zakończona');
      ensure(
        b.actor_id === req.actor.userId || req.actor.role === 'admin',
        403,
        'Anuluje autor lub administrator',
      );
      const pending = jobs.filter((j) => j.state === 'pending').map((j) => j.id);
      await c.query(
        "UPDATE email_messages SET state='cancelled',updated_at=now() WHERE batch_id=$1 AND (state='draft' OR(state='queued' AND attempted_at IS NULL AND job_id=ANY($2::uuid[])))",
        [batchId, pending],
      );
      await c.query("UPDATE jobs SET state='done',lease_token=NULL WHERE id=ANY($1::uuid[])", [
        pending,
      ]);
      await c.query(
        "UPDATE email_batches SET state='cancelled' WHERE id=$1 AND NOT EXISTS(SELECT 1 FROM email_messages WHERE batch_id=$1 AND state='queued')",
        [batchId],
      );
      await audit(c, req.actor, 'email.cancel', batchId);
      return emailBatch(c, batchId);
    });
  });
  app.get('/api/email/messages', (req) => {
    read();
    const q = emailHistoryQuery.parse(req.query);
    return tenantTx(req.actor.tenantId, async (c) => {
      if (q.after)
        ensure(
          (
            await c.query(
              'SELECT id FROM email_messages WHERE id=$1 AND ($2::uuid IS NULL OR order_id=$2)',
              [q.after, q.order_id ?? null],
            )
          ).rowCount,
          422,
          'Nieprawidłowy kursor historii',
        );
      const rows = (
        await c.query(
          "SELECT m.*,to_jsonb(b)->>'automation_run_id' AS automation_run_id,to_jsonb(b)->>'automation_schedule_run_id' AS automation_schedule_run_id,to_jsonb(b)->>'order_batch_id' AS order_batch_id FROM email_messages m JOIN email_batches b ON (b.tenant_id,b.id)=(m.tenant_id,m.batch_id) WHERE ($1::uuid IS NULL OR m.order_id=$1) AND ($2::uuid IS NULL OR (m.created_at,m.id)<(SELECT created_at,id FROM email_messages WHERE id=$2)) ORDER BY m.created_at DESC,m.id DESC LIMIT $3",
          [q.order_id ?? null, q.after ?? null, q.limit + 1],
        )
      ).rows;
      const more = rows.length > q.limit,
        data = rows.slice(0, q.limit);
      return { data, has_more: more, next_cursor: more ? data.at(-1).id : null };
    });
  });
}
