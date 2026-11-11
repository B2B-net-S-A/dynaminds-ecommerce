import type { PoolClient } from 'pg';
import { amazonAccountPolicy } from './amazon-account';
import type { FastifyInstance } from 'fastify';
import { randomUUID, createHmac, createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { pool, tenantTx } from './db';
import { ensure, Problem } from './errors';
import { audit } from './domain';
import { decrypt, encrypt, tokenHash } from './security';
import { loadChannel, beginOAuth, finishOAuth, withAllegroRequestContext, type IntegrationContext } from './channel-access';
import { enqueueSync } from './sync';
import { readEbayProviderQuota } from './ebay-provider-quota';
import { demoWooOrder } from './import-routes';
import {
  beginEbayOAuth,
  finishEbayOAuth,
  ebayOAuthStartInput,
  ebayOAuthCallback,
  ebayCallbackPath,
  cachedEbayAccount,
  cachedEbayApiLimits,
  verifyEbayAccount,
} from './ebay-oauth';
function parseWooWebhook(ch: any, body: Buffer, headers: Record<string, unknown>) {
  const secret = ch && decrypt(ch.credentials).webhook_secret;
  ensure(ch && secret, 401, 'Nieprawidłowy podpis webhooka');
  const signature = String(headers['x-wc-webhook-signature'] ?? '');
  ensure(/^[A-Za-z0-9+/]{43}=$/.test(signature), 401, 'Nieprawidłowy podpis webhooka');
  const expected = createHmac('sha256', secret).update(body).digest(),
    actual = Buffer.from(signature, 'base64');
  ensure(
    actual.length === expected.length && timingSafeEqual(expected, actual),
    401,
    'Nieprawidłowy podpis webhooka',
  );
  const topic = z.enum(['order.created', 'order.updated']).parse(headers['x-wc-webhook-topic']);
  const deliveryId = z.string().min(1).max(160).parse(headers['x-wc-webhook-delivery-id']);
  let payload: any;
  try {
    payload = JSON.parse(body.toString('utf8'));
  } catch {
    throw new Problem(400, 'Nieprawidłowy JSON webhooka');
  }
  ensure(
    payload && Number.isSafeInteger(payload.id) && payload.id > 0,
    422,
    'Brak identyfikatora zamówienia',
  );
  const hash = createHash('sha256').update(body).digest('hex');
  return { secret, topic, deliveryId, payload, hash };
}
async function storeWooWebhookInTx(c: PoolClient, ch: any, id: string, parsed: ReturnType<typeof parseWooWebhook>) {
  const {secret,topic,deliveryId,payload,hash}=parsed;
  const current = (await c.query('SELECT credentials FROM channels WHERE id=$1 FOR UPDATE', [id]))
    .rows[0];
  ensure(
    current && decrypt(current.credentials).webhook_secret === secret,
    401,
    'Sekret webhooka został zmieniony',
  );
  const previous = (
    await c.query(
      'SELECT body_hash,topic,job_id FROM webhook_deliveries WHERE channel_id=$1 AND delivery_id=$2',
      [id, deliveryId],
    )
  ).rows[0];
  if (previous) {
    ensure(
      previous.body_hash === hash && previous.topic === topic,
      409,
      'Identyfikator dostawy został już użyty z inną treścią',
    );
    return { accepted: true, duplicate: true, job_id: previous.job_id };
  }
  ensure(ch.sync_actor_id, 422, 'Webhook wymaga konfiguracji administratora');
  const jobId = randomUUID(),
    delivery = randomUUID();
  await c.query(
    "INSERT INTO jobs(id,tenant_id,kind,payload,dedup_key) VALUES($1,$2,'webhook.stage',$3,$4)",
    [
      jobId,
      ch.tenant_id,
      JSON.stringify({ channel_id: id, actor_id: ch.sync_actor_id, delivery_id: delivery }),
      `webhook:${id}:${deliveryId}`,
    ],
  );
  await c.query(
    'INSERT INTO webhook_deliveries(id,tenant_id,channel_id,delivery_id,body_hash,topic,payload,job_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
    [delivery, ch.tenant_id, id, deliveryId, hash, topic, JSON.stringify(payload), jobId],
  );
  return { accepted: true, duplicate: false, job_id: jobId };
}
export async function receiveWebhook(id: string, body: Buffer, headers: Record<string, unknown>) {
  const ch = (await pool.query("SELECT * FROM channels WHERE id=$1 AND provider='woocommerce'", [id])).rows[0];
  const parsed = parseWooWebhook(ch, body, headers);
  return tenantTx(ch.tenant_id, c => storeWooWebhookInTx(c, ch, id, parsed));
}
/** Internal admission: full original signature/parser/storage checks, no caller verdict. */
export async function receiveWooWebhookInTx(c: PoolClient, id: string, body: Buffer, headers: Record<string, unknown>) {
  const ch = (await c.query("SELECT * FROM channels WHERE id=$1 AND provider='woocommerce' FOR UPDATE", [id])).rows[0];
  return storeWooWebhookInTx(c, ch, id, parseWooWebhook(ch, body, headers));
}

export function registerSyncRoutes(
  app: FastifyInstance,
  ctx: IntegrationContext = {},
  sessionName = 'dyna_session',
  shopifyWebhooksAvailable = false,
  shopifySubscriptionsAvailable = false,
) {
  const admin = (req: any) =>
    ensure(req.actor.role === 'admin', 403, 'Wymagana rola administratora');
  const idOf = (p: unknown) => z.object({ id: z.uuid() }).parse(p).id;
  app.get('/api/integrations/:id/ebay/api-limits', async (req) => {
    admin(req);
    return cachedEbayApiLimits(
      req.actor,
      tokenHash(req.cookies[sessionName] ?? ''),
      idOf(req.params),
    );
  });
  // Explicit read action mints an app token; POST also keeps it disabled in restore previews.
  app.post('/api/integrations/:id/ebay/provider-quota/read', async (req) => {
    admin(req);
    z.object({}).strict().parse(req.body ?? {});
    return readEbayProviderQuota(req.actor, tokenHash(req.cookies[sessionName] ?? ''),
      idOf(req.params), ctx);
  });
  app.get('/api/integrations/:id/ebay-account', async (req) => {
    admin(req);
    return cachedEbayAccount(
      req.actor,
      tokenHash(req.cookies[sessionName] ?? ''),
      idOf(req.params),
    );
  });
  app.post('/api/integrations/:id/ebay-account/verify', async (req) => {
    admin(req);
    z.object({})
      .strict()
      .parse(req.body ?? {});
    return verifyEbayAccount(
      req.actor,
      tokenHash(req.cookies[sessionName] ?? ''),
      idOf(req.params),
      ctx,
    );
  });
  app.post('/api/integrations/:id/oauth/start', async (req, reply) => {
    admin(req);
    const ch = await loadChannel(req.actor.tenantId, idOf(req.params));
    const permissions = z
      .object({
        offers_write: z.boolean().default(false),
        orders_write: z.boolean().default(false),
      })
      .parse(req.body ?? {});
    const result =
      ch.provider === 'ebay'
        ? await beginEbayOAuth(
            req.actor,
            ch.id,
            tokenHash(req.cookies[sessionName] ?? ''),
            ebayOAuthStartInput.parse(req.body ?? {}),
          )
        : await beginOAuth(
            req.actor,
            idOf(req.params),
            withAllegroRequestContext(ctx, req, sessionName),
            permissions.offers_write,
            permissions.orders_write,
          );
    if (req.cookies[sessionName]) {
      const session = (
        await pool.query('SELECT expires_at FROM sessions WHERE token_hash=$1', [
          tokenHash(req.cookies[sessionName]),
        ])
      ).rows[0];
      if (session)
        reply.setCookie(sessionName, req.cookies[sessionName], {
          path: '/',
          httpOnly: true,
          sameSite: 'lax',
          // Same rule as sessionCookie (workspace-routes.ts, SR4-M5): never downgrade a Secure session cookie.
          secure: reply.request.protocol === 'https' || /^https:\/\//i.test(process.env.DYNA_PUBLIC_ORIGIN?.trim() ?? ''),
          maxAge: Math.max(
            1,
            Math.floor((new Date(session.expires_at).getTime() - Date.now()) / 1000),
          ),
        });
    }
    return result;
  });
  app.get('/api/oauth/allegro/callback', async (req, reply) => {
    admin(req);
    const q = z
      .object({ state: z.string().min(20).max(200), code: z.string().min(1).max(5000) })
      .parse(req.query);
    await finishOAuth(req.actor, q.state, q.code, withAllegroRequestContext(ctx, req, sessionName));
    return reply.redirect('/?integration=connected');
  });
  app.get(ebayCallbackPath, async (req, reply) => {
    admin(req);
    const result = await finishEbayOAuth(
      req.actor,
      tokenHash(req.cookies[sessionName] ?? ''),
      ebayOAuthCallback.parse(req.query),
      ctx,
    );
    return reply.redirect(
      '/?integration=' + (result.status === 'denied' ? 'ebay_denied' : 'connected'),
    );
  });
  app.post('/api/oauth/ebay/finish', async (req) => {
    admin(req);
    return finishEbayOAuth(
      req.actor,
      tokenHash(req.cookies[sessionName] ?? ''),
      ebayOAuthCallback.parse(req.body),
      ctx,
    );
  });
  app.get('/api/integrations/:id/sync', async (req) => {
    admin(req);
    const ch = await loadChannel(req.actor.tenantId, idOf(req.params));
    return tenantTx(req.actor.tenantId, async (c) => ({
      channel: {
        id: ch.id,
        name: ch.name,
        provider: ch.provider,
        sync_enabled: ch.sync_enabled,
        sync_interval: ch.sync_interval,
        last_sync_at: ch.last_sync_at,
        next_sync_at: ch.next_sync_at,
        event_cursor: ch.event_cursor,
        bootstrap_done: ch.bootstrap_done,
        token_expires_at: ch.token_expires_at,
        webhook_configured: Boolean(decrypt(ch.credentials).webhook_secret),
        simulation: Boolean(ch.settings.simulation),
      },
      shopify_webhooks_available: shopifyWebhooksAvailable,
      shopify_subscriptions_available: shopifySubscriptionsAvailable,
      jobs: (
        await c.query(
          "SELECT id,kind,state,attempts,max_attempts,run_at,error,created_at,payload->>'page' AS page,payload->>'phase' AS phase FROM jobs WHERE payload->>'channel_id'=$1 ORDER BY created_at DESC LIMIT 30",
          [ch.id],
        )
      ).rows,
      deliveries: (
        await c.query(
          'SELECT delivery_id,topic,received_at,job_id FROM webhook_deliveries WHERE channel_id=$1 ORDER BY received_at DESC LIMIT 20',
          [ch.id],
        )
      ).rows,
      webhook_url:
        ch.provider === 'woocommerce'
          ? `http://127.0.0.1:4100/api/webhooks/woocommerce/${ch.id}`
          : null,
    }));
  });
  app.patch('/api/integrations/:id/sync', async (req) => {
    admin(req);
    const id = idOf(req.params),
      b = z
        .object({ enabled: z.boolean(), interval: z.number().int().min(60).max(86400) })
        .parse(req.body);
    return tenantTx(req.actor.tenantId, async (c) => {
      const ch = (await c.query('SELECT * FROM channels WHERE id=$1 FOR UPDATE', [id])).rows[0];
      ensure(
        ch &&
          ['woocommerce', 'allegro', 'prestashop', 'shopify', 'odoo', 'ebay', 'amazon'].includes(
            ch.provider,
          ) &&
          !ch.settings.simulation,
        422,
        'Wymagane rzeczywiste połączenie sklepu lub marketplace',
      );
      if (ch.provider === 'amazon' && b.enabled) await amazonAccountPolicy(c, ch);
      await c.query(
        'UPDATE channels SET sync_enabled=$1,sync_interval=$2,sync_actor_id=$3,next_sync_at=now() WHERE id=$4',
        [b.enabled, b.interval, req.actor.userId, id],
      );
      await audit(c, req.actor, 'integration.schedule', id, b);
      return { ok: true };
    });
  });
  app.post('/api/integrations/:id/sync', async (req) => {
    admin(req);
    return tenantTx(req.actor.tenantId, (c) => enqueueSync(c, req.actor, idOf(req.params)));
  });
  app.post('/api/integrations/:id/webhook', async (req) => {
    admin(req);
    const ch = await loadChannel(req.actor.tenantId, idOf(req.params));
    ensure(ch.provider === 'woocommerce', 422, 'Webhook dostępny dla WooCommerce');
    const b = z.object({ secret: z.string().min(16).max(256) }).parse(req.body);
    await tenantTx(req.actor.tenantId, async (c) => {
      const locked = (
        await c.query('SELECT credentials FROM channels WHERE id=$1 FOR UPDATE', [ch.id])
      ).rows[0];
      await c.query('UPDATE channels SET credentials=$1,sync_actor_id=$2 WHERE id=$3', [
        encrypt({ ...decrypt(locked.credentials), webhook_secret: b.secret }),
        req.actor.userId,
        ch.id,
      ]);
      await audit(c, req.actor, 'webhook.configure', ch.id);
    });
    return { ok: true };
  });
  app.post('/api/integrations/:id/demo-webhook', async (req) => {
    admin(req);
    const ch = await loadChannel(req.actor.tenantId, idOf(req.params));
    ensure(
      ch.settings.simulation && ch.provider === 'woocommerce',
      422,
      'Wymagany lokalny przykład WooCommerce',
    );
    const secret = decrypt(ch.credentials).webhook_secret;
    ensure(secret, 422, 'Najpierw ustaw sekret podpisu');
    const body = Buffer.from(JSON.stringify(demoWooOrder));
    return {
      ...(await receiveWebhook(ch.id, body, {
        'x-wc-webhook-signature': createHmac('sha256', secret).update(body).digest('base64'),
        'x-wc-webhook-topic': 'order.updated',
        'x-wc-webhook-delivery-id': `demo-${randomUUID()}`,
      })),
      scope: 'local_simulation',
    };
  });
  app.post('/api/integration-jobs/:id/retry', async (req) => {
    admin(req);
    return tenantTx(req.actor.tenantId, async (c) => {
      const job = (
        await c.query(
          "SELECT * FROM jobs WHERE id=$1 AND kind IN ('orders.sync','webhook.stage') FOR UPDATE",
          [idOf(req.params)],
        )
      ).rows[0];
      ensure(job, 404, 'Nie znaleziono zadania');
      const laneSchema=(await c.query("SELECT to_regclass('public.local_woo_read_occurrences')::text AS relation")).rows;
      ensure(laneSchema.length===1&&Object.hasOwn(laneSchema[0],'relation')&&(laneSchema[0].relation===null||typeof laneSchema[0].relation==='string'&&laneSchema[0].relation.length>0),503,'Nie potwierdzono schematu automatycznych odczytów');
      if(laneSchema[0].relation!==null)ensure(!(await c.query('SELECT id FROM public.local_woo_read_occurrences WHERE tenant_id=$1 AND job_id=$2 LIMIT 1',[req.actor.tenantId,job.id])).rows.length,409,'Zadanie automatycznego odczytu wymaga uzgodnienia w jego historii; ręczne ponowienie jest wyłączone');
      ensure(job.state === 'failed', 409, 'Ponowienie dostępne dla nieudanych zadań');
      if (job.kind === 'orders.sync')
        await c.query('SELECT id FROM channels WHERE id=$1 FOR UPDATE', [job.payload.channel_id]);
      await c.query(
        "UPDATE jobs SET state='pending',attempts=0,error=NULL,run_at=now(),payload=jsonb_set(payload,'{actor_id}',to_jsonb($2::text)) WHERE id=$1",
        [job.id, req.actor.userId],
      );
      await audit(c, req.actor, 'integration.job.retry', job.id);
      return { ok: true };
    });
  });
  app.register(async (webhookApp) => {
    webhookApp.removeContentTypeParser('application/json');
    webhookApp.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) =>
      done(null, body),
    );
    webhookApp.post('/api/webhooks/woocommerce/:id', async (req, reply) => {
      const result = await receiveWebhook(idOf(req.params), req.body as Buffer, req.headers);
      return reply.code(202).send(result);
    });
  });
}
