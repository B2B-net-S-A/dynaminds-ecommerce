import { smsLiveRequestAuthority, requireSmsLiveAuthority } from './sms-live-authority';
import { pool } from './db';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { tenantTx } from './db';
import { ensure } from './errors';
import { audit } from './domain';
import {
  smsTemplate,
  smsTemplatePreview,
  previewSmsTemplate,
  smsPreview,
  smsHash,
  validateSmsBody,
  smsPrepare,
  smsQueue,
  smsBatch,
} from './sms';
export function registerSmsRoutes(app: FastifyInstance, sessionName: string) {
  const id = (p: unknown) => z.object({ id: z.uuid() }).parse(p).id;
  const write = (req: any, admin = false) =>
    ensure(
      admin ? req.actor.role === 'admin' : req.actor.role !== 'viewer',
      403,
      admin ? 'Wymagana rola administratora' : 'Brak prawa obsługi komunikacji',
    );
  app.get('/api/sms/templates', (req) =>
    tenantTx(req.actor.tenantId, async (c) => ({
      data: (await c.query('SELECT * FROM sms_templates ORDER BY name,id LIMIT 100')).rows,
    })),
  );
  app.post('/api/sms/templates', (req) => {
    write(req, true);
    const { client_key, ...b } = smsTemplate.extend({ client_key: z.uuid() }).parse(req.body);
    validateSmsBody(b.body);
    return tenantTx(req.actor.tenantId, async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        'sms-template:' + req.actor.tenantId,
      ]);
      const old = (await c.query('SELECT * FROM sms_templates WHERE client_key=$1', [client_key]))
          .rows[0],
        hash = smsHash(b);
      if (old) {
        ensure(old.creation_hash === hash, 409, 'Klucz szablonu ma inną treść');
        return old;
      }
      ensure(
        (await c.query('SELECT count(*)::int AS n FROM sms_templates')).rows[0].n < 100,
        422,
        'Limit 100 szablonów SMS',
      );
      const t = (
        await c.query(
          'INSERT INTO sms_templates(id,tenant_id,name,body,max_parts,active,client_key,creation_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
          [
            randomUUID(),
            req.actor.tenantId,
            b.name,
            b.body,
            b.max_parts,
            b.active,
            client_key,
            hash,
          ],
        )
      ).rows[0];
      await audit(c, req.actor, 'sms.template.create', t.id, { active: t.active });
      return t;
    });
  });
  app.patch('/api/sms/templates/:id', (req) => {
    write(req, true);
    const b = smsTemplate.extend({ version: z.string().regex(/^\d+$/) }).parse(req.body);
    validateSmsBody(b.body);
    return tenantTx(req.actor.tenantId, async (c) => {
      const t = (
        await c.query('SELECT * FROM sms_templates WHERE id=$1 FOR UPDATE', [id(req.params)])
      ).rows[0];
      ensure(t, 404, 'Nie znaleziono szablonu');
      ensure(t.version === b.version, 409, 'Szablon zmienił się; odśwież dane');
      const r = (
        await c.query(
          'UPDATE sms_templates SET name=$2,body=$3,max_parts=$4,active=$5,version=version+1 WHERE id=$1 RETURNING *',
          [t.id, b.name, b.body, b.max_parts, b.active],
        )
      ).rows[0];
      await audit(c, req.actor, 'sms.template.update', t.id, {
        version: r.version,
        active: r.active,
      });
      return r;
    });
  });
  // Live preview in the template editor: render only, nothing is saved or queued.
  app.post('/api/sms/templates/preview', (req) => {
    write(req);
    const input = smsTemplatePreview.parse(req.body);
    return tenantTx(req.actor.tenantId, (c) => previewSmsTemplate(c, input));
  });
  app.post('/api/sms/preview', async (req) => {
    write(req);
    if((req.body as any)?.mode==='provider_live')await requireSmsLiveAuthority(pool,smsLiveRequestAuthority(req,sessionName));
    return tenantTx(req.actor.tenantId, (c) =>
      smsPrepare(c, req.actor, smsPreview.parse(req.body)),
    );
  });
  app.get('/api/sms/batches/:id', (req) =>
    tenantTx(req.actor.tenantId, (c) => smsBatch(c, id(req.params))),
  );
  app.post('/api/sms/batches/:id/queue', async (req) => {
    write(req);
    const b=z.object({ confirmed:z.literal(true),confirm_external:z.literal(true).optional() }).strict().parse(req.body);
    const live=b.confirm_external?smsLiveRequestAuthority(req,sessionName):undefined;
    return tenantTx(req.actor.tenantId, (c) => smsQueue(c, req.actor, id(req.params),live));
  });
  app.post('/api/sms/batches/:id/cancel', (req) => {
    write(req);
    z.object({ confirmed: z.literal(true) })
      .strict()
      .parse(req.body);
    return tenantTx(req.actor.tenantId, async (c) => {
      const batchId = id(req.params);
      // Jobs before batch/messages: same order as worker. Never cancel an attempted POST.
      const jobs = (
        await c.query(
          'SELECT j.id FROM jobs j JOIN sms_messages m ON (m.tenant_id,m.job_id)=(j.tenant_id,j.id) WHERE m.batch_id=$1 ORDER BY j.id FOR UPDATE OF j',
          [batchId],
        )
      ).rows;
      const b = (await c.query('SELECT * FROM sms_batches WHERE id=$1 FOR UPDATE', [batchId]))
        .rows[0];
      ensure(b, 404, 'Nie znaleziono partii SMS');
      ensure(
        ['preview', 'queued', 'cancelled'].includes(b.state),
        409,
        'Partia została zakończona',
      );
      ensure(
        b.actor_id === req.actor.userId || req.actor.role === 'admin',
        403,
        'Anuluje autor lub administrator',
      );
      const pending = (
        await c.query("SELECT id FROM jobs WHERE id=ANY($1::uuid[]) AND state='pending'", [
          jobs.map((j) => j.id),
        ])
      ).rows.map((j) => j.id);
      await c.query(
        "UPDATE sms_messages SET state='cancelled',updated_at=now() WHERE batch_id=$1 AND (state='draft' OR (state='queued' AND attempted_at IS NULL AND job_id=ANY($2::uuid[])))",
        [batchId, pending],
      );
      await c.query("UPDATE jobs SET state='done',lease_token=NULL WHERE id=ANY($1::uuid[])", [
        pending,
      ]);
      await c.query(
        "UPDATE sms_batches SET state='cancelled' WHERE id=$1 AND NOT EXISTS(SELECT 1 FROM sms_messages WHERE batch_id=$1 AND state='queued')",
        [batchId],
      );
      await audit(c, req.actor, 'sms.cancel', batchId);
      return smsBatch(c, batchId);
    });
  });
  app.get('/api/sms/messages', (req) => {
    const q = z
      .object({ after: z.uuid().optional(), order_id: z.uuid().optional() })
      .parse(req.query);
    return tenantTx(req.actor.tenantId, async (c) => {
      const rows = (
        await c.query(
          `SELECT m.*,b.mode,CASE WHEN b.mode='provider_live' THEN jsonb_build_object('status_code',s.status_code,'needs_reconciliation',coalesce(s.needs_reconciliation,false)) ELSE NULL END AS delivery FROM sms_messages m JOIN sms_batches b ON (b.tenant_id,b.id)=(m.tenant_id,m.batch_id) LEFT JOIN sms_delivery_submissions s ON(s.tenant_id,s.message_id)=(m.tenant_id,m.id)
        WHERE ($1::uuid IS NULL OR m.order_id=$1) AND ($2::uuid IS NULL OR (m.created_at,m.id)<(SELECT created_at,id FROM sms_messages WHERE id=$2)) ORDER BY m.created_at DESC,m.id DESC LIMIT 26`,
          [q.order_id ?? null, q.after ?? null],
        )
      ).rows;
      return { data: rows.slice(0, 25), meta: { cursor: rows.length > 25 ? rows[24].id : null } };
    });
  });
}
