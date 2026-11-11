import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { tenantTx } from './db';
import { authTx, lockAdmin } from './workspace-routes';
import { audit } from './domain';
import { encrypt } from './security';
import { ensure } from './errors';
import { validateRemoteUrl } from './integrations';
import { receiveLocalWebhook, webhookTypes } from './outbound-webhooks';
const idOf = (v: unknown) => z.object({ id: z.uuid() }).parse(v).id;
export function registerOutboundRoutes(app: FastifyInstance) {
  app.get('/api/developer/webhooks', async (req) => {
    ensure(req.actor.role === 'admin', 403, 'Wymagana rola administratora');
    return tenantTx(req.actor.tenantId, async (c) => ({
      subscriptions: (
        await c.query(
          'SELECT id,name,mode,url,events,enabled,approved_at,revoked_at,created_at FROM outbound_subscriptions ORDER BY created_at DESC LIMIT 100',
        )
      ).rows,
      deliveries: (
        await c.query(
          'SELECT d.id,d.subscription_id,d.event_id,d.state,d.response_status,d.error,d.delivered_at,d.created_at,j.attempts,s.name,e.event_type FROM outbound_deliveries d JOIN jobs j ON (j.tenant_id,j.id)=(d.tenant_id,d.job_id) JOIN outbound_subscriptions s ON (s.tenant_id,s.id)=(d.tenant_id,d.subscription_id) JOIN outbound_events e ON (e.tenant_id,e.id)=(d.tenant_id,d.event_id) ORDER BY d.created_at DESC,d.id DESC LIMIT 50',
        )
      ).rows,
      inbox: (
        await c.query(
          'SELECT delivery_id,payload,received_at FROM local_webhook_inbox ORDER BY received_at DESC LIMIT 20',
        )
      ).rows,
      events: webhookTypes,
    }));
  });
  app.post('/api/developer/webhooks', async (req, reply) => {
    const b = z
      .object({
        name: z.string().trim().min(2).max(100),
        mode: z.enum(['local', 'https']).default('local'),
        url: z.string().max(2000).optional(),
        events: z
          .array(z.enum(webhookTypes))
          .min(1)
          .max(4)
          .transform((v) => [...new Set(v)]),
      })
      .parse(req.body);
    ensure(req.actor.role === 'admin', 403, 'Wymagana rola administratora');
    const url = b.mode === 'https' ? await validateRemoteUrl(z.string().min(1).parse(b.url)) : null;
    ensure(b.mode !== 'local' || !b.url, 422, 'Skrzynka lokalna nie przyjmuje adresu URL');
    const id = randomUUID(),
      secret = 'whsec_' + randomBytes(32).toString('hex');
    const result = await authTx(async (c) => {
      await lockAdmin(c, req.actor);
      const count = Number(
        (
          await c.query(
            'SELECT count(*) FROM outbound_subscriptions WHERE tenant_id=$1 AND revoked_at IS NULL',
            [req.actor.tenantId],
          )
        ).rows[0].count,
      );
      ensure(count < 20, 409, 'Organizacja może mieć maksymalnie 20 konfiguracji webhooków');
      const r = (
        await c.query(
          'INSERT INTO outbound_subscriptions(id,tenant_id,actor_id,name,mode,url,secret,events) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,name,mode,url,events,enabled',
          [
            id,
            req.actor.tenantId,
            req.actor.userId,
            b.name,
            b.mode,
            url,
            encrypt({ secret }),
            b.events,
          ],
        )
      ).rows[0];
      await audit(c, req.actor, 'outbound.created', id, {
        name: b.name,
        mode: b.mode,
        events: b.events,
      });
      return r;
    });
    return reply.code(201).send({ ...result, secret });
  });
  app.post('/api/developer/webhooks/:id/enable', async (req) => {
    const id = idOf(req.params),
      b = z.object({ confirm_destination: z.string().min(1).max(2000) }).parse(req.body);
    return authTx(async (c) => {
      await lockAdmin(c, req.actor);
      const sub = (
        await c.query(
          'SELECT * FROM outbound_subscriptions WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
          [req.actor.tenantId, id],
        )
      ).rows[0];
      ensure(sub && !sub.revoked_at, 404, 'Nie znaleziono aktywnego webhooka');
      ensure(
        b.confirm_destination === (sub.mode === 'local' ? 'local' : sub.url),
        422,
        'Potwierdź dokładny adres odbiorcy webhooków',
      );
      const current = (
        await c.query('SELECT role FROM memberships WHERE tenant_id=$1 AND user_id=$2', [
          req.actor.tenantId,
          sub.actor_id,
        ])
      ).rows[0];
      ensure(
        current?.role === 'admin',
        409,
        'Właściciel webhooka utracił uprawnienia; utwórz nową konfigurację',
      );
      await c.query(
        'UPDATE outbound_subscriptions SET enabled=true,approved_at=now() WHERE id=$1',
        [id],
      );
      await audit(c, req.actor, 'outbound.enabled', id, {
        mode: sub.mode,
        destination: sub.mode === 'local' ? 'local' : sub.url,
      });
      return { ok: true };
    });
  });
  for (const action of ['disable', 'revoke'] as const)
    app.post('/api/developer/webhooks/:id/' + action, async (req) =>
      authTx(async (c) => {
        await lockAdmin(c, req.actor);
        const id = idOf(req.params);
        const r = await c.query(
          'UPDATE outbound_subscriptions SET enabled=false,revoked_at=CASE WHEN $3 THEN coalesce(revoked_at,now()) ELSE revoked_at END WHERE tenant_id=$1 AND id=$2 RETURNING id',
          [req.actor.tenantId, id, action === 'revoke'],
        );
        ensure(r.rowCount, 404, 'Nie znaleziono webhooka');
        await audit(c, req.actor, 'outbound.' + action, id);
        return { ok: true };
      }),
    );
  app.post('/api/developer/deliveries/:id/retry', async (req) =>
    authTx(async (c) => {
      await lockAdmin(c, req.actor);
      const id = idOf(req.params);
      const d = (
        await c.query(
          'SELECT d.*,s.enabled,s.revoked_at FROM outbound_deliveries d JOIN outbound_subscriptions s ON (s.tenant_id,s.id)=(d.tenant_id,d.subscription_id) WHERE d.tenant_id=$1 AND d.id=$2 FOR UPDATE OF d',
          [req.actor.tenantId, id],
        )
      ).rows[0];
      ensure(d, 404, 'Nie znaleziono dostawy');
      ensure(
        ['failed', 'cancelled'].includes(d.state),
        409,
        'Można ponowić tylko nieudaną lub anulowaną dostawę',
      );
      ensure(d.enabled && !d.revoked_at, 409, 'Webhook musi być zatwierdzony i włączony');
      const j = (
        await c.query(
          "UPDATE jobs SET state='pending',attempts=0,error=NULL,lease_token=NULL,locked_at=NULL,run_at=now() WHERE tenant_id=$1 AND id=$2 AND state IN ('failed','done') RETURNING id",
          [req.actor.tenantId, d.job_id],
        )
      ).rows[0];
      ensure(j, 409, 'Zadanie dostawy nadal trwa');
      await c.query(
        "UPDATE outbound_deliveries SET state='queued',error=NULL,response_status=NULL WHERE id=$1",
        [id],
      );
      await audit(c, req.actor, 'outbound.retry', id);
      return { ok: true };
    }),
  );
  app.register(async (receiver) => {
    receiver.removeContentTypeParser('application/json');
    receiver.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer', bodyLimit: 65536 },
      (_req, body, done) => done(null, body),
    );
    receiver.post('/api/local-webhooks/:id', async (req, reply) =>
      reply
        .code(202)
        .send(await receiveLocalWebhook(idOf(req.params), req.body as Buffer, req.headers)),
    );
  });
}
