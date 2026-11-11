import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { tenantTx } from './db';
import { ensure } from './errors';
import { enqueueOfferSync } from './offer-sync';
import { offerSyncInput, configureOfferSyncInTx } from './offer-sync-configuration';
import { createOfferSyncCommands } from './offer-sync-commands';
export { offerSyncInput } from './offer-sync-configuration';
export function registerOfferSyncRoutes(app: FastifyInstance, options: {readOnly: boolean; sessionName: string}) {
  const admin = (req: any) =>
    ensure(req.actor.role === 'admin', 403, 'Wymagana rola administratora');
  const id = (p: unknown) => z.object({ id: z.uuid() }).parse(p).id;
  app.get('/api/integrations/:id/offer-sync', (req) => {
    admin(req);
    const channelId = id(req.params);
    const q = z
      .object({
        limit: z.coerce.number().int().min(1).max(100).default(25),
        after: z.uuid().optional(),
        search: z.string().trim().max(100).default(''),
      })
      .parse(req.query);
    return tenantTx(req.actor.tenantId, async (c) => {
      const ch = (
        await c.query('SELECT id,name,provider,mode,settings FROM channels WHERE id=$1', [
          channelId,
        ])
      ).rows[0];
      ensure(
        ch &&
          ['woocommerce', 'allegro', 'prestashop', 'shopify', 'ebay', 'amazon'].includes(
            ch.provider,
          ),
        404,
        'Nie znaleziono kanału ofert',
      );
      const config =
        (await c.query('SELECT * FROM offer_sync_configs WHERE channel_id=$1', [channelId]))
          .rows[0] ?? null;
      const rows = (
        await c.query(
          `SELECT i.*,p.sku,p.name,l.external_id,op.state AS plan_state,op.phase AS plan_phase,op.completed_at AS plan_completed_at,op.result FROM offer_sync_items i JOIN listings l ON (l.tenant_id,l.id)=(i.tenant_id,i.listing_id) JOIN products p ON (p.tenant_id,p.id)=(l.tenant_id,l.product_id) LEFT JOIN offer_plans op ON (op.tenant_id,op.id)=(i.tenant_id,i.plan_id) WHERE i.channel_id=$1 AND ($2::uuid IS NULL OR i.listing_id>$2) AND ($3='' OR strpos(lower(p.sku||' '||p.name||' '||l.external_id),lower($3))>0) ORDER BY i.listing_id LIMIT $4`,
          [channelId, q.after ?? null, q.search, q.limit + 1],
        )
      ).rows;
      const jobs = (
        await c.query(
          "SELECT id,state,attempts,run_at,error,created_at,payload->'stats' AS stats,payload->>'after' AS cursor,payload->>'version' AS config_version FROM jobs WHERE kind='offer.sync' AND payload->>'channel_id'=$1 ORDER BY created_at DESC,id DESC LIMIT 20",
          [channelId],
        )
      ).rows;
      return {
        channel: ch,
        config,
        price_list: config?.price_list_id
          ? (
              await c.query('SELECT id,name,currency,active FROM price_lists WHERE id=$1', [
                config.price_list_id,
              ])
            ).rows[0]
          : null,
        data: rows.slice(0, q.limit),
        meta: { cursor: rows.length > q.limit ? rows[q.limit - 1].listing_id : null },
        jobs,
      };
    });
  });
  app.patch('/api/integrations/:id/offer-sync', (req) => {
    admin(req);
    const channelId = id(req.params),
      b = offerSyncInput.parse(req.body);
    ensure(!options.readOnly, 423, 'Zapis jest wyłączony w podglądzie');
    return tenantTx(req.actor.tenantId, c => configureOfferSyncInTx(c, req.actor, channelId, b));
  });
  // Ordinary session commands preserve the original result when the HTTP ACK is lost.
  const commands = createOfferSyncCommands();
  const sessionActor = (req: FastifyRequest) => {
    ensure(!req.headers.authorization && !!req.cookies[options.sessionName] && !req.actor.apiKeyId && req.apiScopes === undefined && req.actor.source !== 'api', 403, 'Wymagana zwykła sesja administratora');
    ensure(req.actor.role === 'admin' && req.currentUser?.id === req.actor.userId && req.currentUser.tenant_id === req.actor.tenantId && req.currentUser.role === 'admin' && !req.currentUser.api_key_id, 403, 'Wymagana aktualna sesja tej firmy');
    return req.actor;
  };
  const empty = z.strictObject({});
  app.post('/api/integrations/:id/offer-sync/commands', async (req, reply) => {
    ensure(!options.readOnly, 423, 'Zapis jest wyłączony w podglądzie');
    empty.parse(req.query);
    return reply.code(201).send(await commands.configure(sessionActor(req), id(req.params), req.body));
  });
  app.post('/api/integrations/:id/offer-sync/commands/observe', req => {
    empty.parse(req.query);
    return commands.observe(sessionActor(req), id(req.params), req.body);
  });
  app.post('/api/integrations/:id/offer-sync/commands/cancel', req => {
    ensure(!options.readOnly, 423, 'Zapis jest wyłączony w podglądzie');
    empty.parse(req.query);
    return commands.cancel(sessionActor(req), id(req.params), req.body);
  });
  app.post('/api/integrations/:id/offer-sync', (req) => {
    admin(req);
    return tenantTx(req.actor.tenantId, async (c) => {
      const cfg = (
        await c.query('SELECT actor_id FROM offer_sync_configs WHERE channel_id=$1', [
          id(req.params),
        ])
      ).rows[0];
      ensure(cfg, 404, 'Nie znaleziono konfiguracji');
      ensure(
        cfg.actor_id === req.actor.userId,
        403,
        'Uruchamia administrator konfigurujący harmonogram',
      );
      return enqueueOfferSync(c, req.actor, id(req.params));
    });
  });
}
