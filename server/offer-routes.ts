import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { tenantTx } from './db';
import { audit } from './domain';
import { ensure } from './errors';
import { type IntegrationContext, loadChannel, channelRead, withAllegroRequestContext } from './channel-access';
import { Allegro } from './integrations';
import { allegroSettingsReadScope } from './allegro-creation';
import { previewOffer, queueOffer, offerInput } from './offers';
import { ebaySellerAccess } from './ebay-seller-access';
import {
  readEbaySellerOptions,
  readEbayCategorySuggestions,
  readEbayCategory,
  demoEbaySellerOptions,
  demoEbayCategory,
} from './ebay-seller-settings';
export function registerOfferRoutes(app: FastifyInstance, ctx: IntegrationContext = {}) {
  const admin = (req: any) =>
    ensure(req.actor.role === 'admin', 403, 'Wymagana rola administratora');
  const id = (params: any) => z.object({ id: z.uuid() }).parse(params).id;
  app.get('/api/integrations/:id/ebay/seller-settings', async (req) => {
    admin(req);
    const q = z
      .object({
        language: z
          .string()
          .regex(/^[a-z]{2}-[A-Z]{2}$/)
          .default('pl-PL'),
      })
      .parse(req.query);
    return ebaySellerAccess(
      req.actor,
      id(req.params),
      true,
      (client, ch, fence) =>
        readEbaySellerOptions(client, ch.settings.marketplace_id, q.language, fence),
      (ch) => demoEbaySellerOptions(ch.settings.marketplace_id, q.language),
      ctx,
    );
  });
  app.get('/api/integrations/:id/ebay/categories', async (req) => {
    admin(req);
    const q = z.object({ phrase: z.string().trim().min(1).max(200) }).parse(req.query);
    return ebaySellerAccess(
      req.actor,
      id(req.params),
      false,
      (client, ch, fence) =>
        readEbayCategorySuggestions(client, ch.settings.marketplace_id, q.phrase, fence),
      (ch) => ({
        marketplace: ch.settings.marketplace_id,
        tree: demoEbayCategory(ch.settings.marketplace_id).tree,
        data: [{ id: '123', name: 'Akcesoria DEMO', path: 'Akcesoria DEMO' }],
      }),
      ctx,
    );
  });
  app.get('/api/integrations/:id/ebay/category', async (req) => {
    admin(req);
    const q = z.object({ category_id: z.string().regex(/^[1-9]\d{0,14}$/) }).parse(req.query);
    return ebaySellerAccess(
      req.actor,
      id(req.params),
      false,
      (client, ch, fence) =>
        readEbayCategory(client, ch.settings.marketplace_id, q.category_id, fence),
      (ch) => demoEbayCategory(ch.settings.marketplace_id, q.category_id),
      ctx,
    );
  });
  app.get('/api/integrations/:id/allegro/catalog', async (req) => {
    admin(req);
    const q = z
      .object({
        phrase: z.string().trim().min(1).max(200),
        after: z.string().min(1).max(1000).optional(),
      })
      .parse(req.query);
    const ch = await loadChannel(req.actor.tenantId, id(req.params));
    ensure(ch.provider === 'allegro', 422, 'Wymagana integracja Allegro');
    if (ch.settings.simulation)
      return {
        data: [
          {
            id: '10000000-0000-4000-8000-000000000001',
            name: 'Demonstracyjny produkt katalogu Allegro',
            category: { id: '123' },
          },
        ],
        meta: { cursor: null },
        scope: 'local_simulation',
      };
    return channelRead(
      req.actor.tenantId,
      ch.id,
      async (client) => {
        ensure(client instanceof Allegro, 422, 'Wymagana integracja Allegro');
        return client.catalogSearch(q.phrase, q.after);
      },
      withAllegroRequestContext(ctx, req),
    );
  });
  app.get('/api/integrations/:id/allegro/offer-parameters', async (req) => {
    admin(req);
    const q = z.object({ product_id: z.uuid() }).parse(req.query);
    const ch = await loadChannel(req.actor.tenantId, id(req.params));
    ensure(ch.provider === 'allegro', 422, 'Wymagana integracja Allegro');
    if (ch.settings.simulation)
      return {
        data: [
          {
            id: '11323',
            name: 'Stan',
            type: 'dictionary',
            required: true,
            options: { describesProduct: false },
            restrictions: { multipleChoices: false },
            dictionary: [
              { id: '11323_1', value: 'Nowy' },
              { id: '11323_2', value: 'Używany' },
            ],
          },
        ],
        scope: 'local_simulation',
      };
    return channelRead(
      req.actor.tenantId,
      ch.id,
      async (client) => {
        ensure(client instanceof Allegro, 422, 'Wymagana integracja Allegro');
        const p = await client.catalogProduct(q.product_id);
        ensure(p.id === q.product_id, 502, 'Inny produkt katalogu');
        return { data: await client.categoryOfferParameters(p.category?.id) };
      },
      withAllegroRequestContext(ctx, req),
    );
  });
  app.get('/api/integrations/:id/allegro/creation-options', async (req) => {
    admin(req);
    const q = z
      .object({
        resource: z.enum(['shipping', 'returns', 'warranties', 'producers']),
        offset: z.coerce.number().int().min(0).max(50000).default(0),
      })
      .parse(req.query);
    const ch = await loadChannel(req.actor.tenantId, id(req.params));
    ensure(ch.provider === 'allegro', 422, 'Wymagana integracja Allegro');
    if (ch.settings.simulation) {
      const index = ['shipping', 'returns', 'warranties', 'producers'].indexOf(q.resource) + 2;
      return {
        data: [
          {
            id: '10000000-0000-4000-8000-00000000000' + index,
            name: {
              shipping: 'Dostawa demonstracyjna',
              returns: 'Zwroty demonstracyjne',
              warranties: 'Reklamacje demonstracyjne',
              producers: 'Producent demonstracyjny',
            }[q.resource],
          },
        ],
        meta: { cursor: null },
        scope: 'local_simulation',
      };
    }
    ensure(
      ch.oauth_scopes.split(' ').includes(allegroSettingsReadScope),
      422,
      'Połącz Allegro ponownie z odczytem ustawień sprzedawcy',
    );
    return channelRead(
      req.actor.tenantId,
      ch.id,
      async (client) => {
        ensure(client instanceof Allegro, 422, 'Wymagana integracja Allegro');
        return client.creationOptions(q.resource, q.offset);
      },
      withAllegroRequestContext(ctx, req),
    );
  });
  app.get('/api/integrations/:id/offers', (req) => {
    admin(req);
    const ch = id(req.params),
      q = z
        .object({
          after: z.uuid().optional(),
          limit: z.coerce.number().int().min(1).max(100).default(25),
        })
        .parse(req.query);
    return tenantTx(req.actor.tenantId, async (c) => {
      const channel = (
        await c.query('SELECT id,name,provider,mode,settings FROM channels WHERE id=$1', [ch])
      ).rows[0];
      ensure(channel, 404, 'Nie znaleziono integracji');
      const plans = (
        await c.query(
          `SELECT o.*,p.sku,p.name,j.state AS job_state,j.attempts,j.run_at AS job_run_at,j.provider_wait_until,j.provider_wait_reason,j.error AS job_error FROM offer_plans o
        JOIN products p ON (p.tenant_id,p.id)=(o.tenant_id,o.product_id) LEFT JOIN jobs j ON j.id=o.job_id
        WHERE o.channel_id=$1 AND ($2::uuid IS NULL OR (o.created_at,o.id)<(SELECT created_at,id FROM offer_plans WHERE id=$2 AND channel_id=$1))
        ORDER BY o.created_at DESC,o.id DESC LIMIT $3`,
          [ch, q.after ?? null, q.limit + 1],
        )
      ).rows;
      const rows = plans.slice(0, q.limit);
      return {
        channel,
        data: rows,
        meta: { cursor: plans.length > q.limit ? rows.at(-1).id : null },
      };
    });
  });
  app.get('/api/integrations/:id/offer-listings', (req) => {
    admin(req);
    const ch = id(req.params),
      q = z
        .object({
          search: z.string().trim().max(100).default(''),
          after: z.uuid().optional(),
          limit: z.coerce.number().int().min(1).max(100).default(25),
        })
        .parse(req.query);
    return tenantTx(req.actor.tenantId, async (c) => {
      ensure(
        (await c.query('SELECT id FROM channels WHERE id=$1', [ch])).rowCount,
        404,
        'Nie znaleziono integracji',
      );
      const found = (
        await c.query(
          `SELECT l.*,p.sku,p.name,p.kind FROM listings l
        JOIN products p ON (p.tenant_id,p.id)=(l.tenant_id,l.product_id)
        WHERE l.channel_id=$1 AND ($2::uuid IS NULL OR (l.created_at,l.id)<(SELECT created_at,id FROM listings WHERE id=$2 AND channel_id=$1))
        AND ($3='' OR strpos(lower(p.sku || ' ' || p.name || ' ' || l.external_id),lower($3))>0)
        ORDER BY l.created_at DESC,l.id DESC LIMIT $4`,
          [ch, q.after ?? null, q.search, q.limit + 1],
        )
      ).rows;
      const rows = found.slice(0, q.limit);
      return { data: rows, meta: { cursor: found.length > q.limit ? rows.at(-1).id : null } };
    });
  });
  app.post('/api/integrations/:id/offers/preview', (req) => {
    admin(req);
    return previewOffer(req.actor, id(req.params), offerInput.parse(req.body), withAllegroRequestContext(ctx, req));
  });
  app.post('/api/offer-plans/:id/queue', (req) => {
    admin(req);
    const b = z.object({ confirm_live: z.boolean().default(false) }).parse(req.body ?? {});
    return tenantTx(req.actor.tenantId, (c) =>
      queueOffer(c, req.actor, id(req.params), b.confirm_live),
    );
  });
  app.post('/api/offer-plans/:id/reconcile', (req) => {
    admin(req);
    const b = z.object({ accept_observed: z.boolean().default(false) }).parse(req.body ?? {});
    return tenantTx(req.actor.tenantId, async (c) => {
      const p = (
        await c.query('SELECT * FROM offer_plans WHERE id=$1 FOR UPDATE', [id(req.params)])
      ).rows[0];
      ensure(p, 404, 'Nie znaleziono planu');
      ensure(
        p.actor_id === req.actor.userId &&
          p.state === 'failed' &&
          ['write_started', 'verify'].includes(p.phase),
        409,
        'Tylko autor może uzgodnić niepewny wynik zapisu',
      );
      const job = randomUUID();
      await c.query(
        "INSERT INTO jobs(id,tenant_id,kind,payload,dedup_key) VALUES($1,$2,'offer.write',$3,$4)",
        [
          job,
          req.actor.tenantId,
          JSON.stringify({
            plan_id: p.id,
            actor_id: req.actor.userId,
            channel_id: p.channel_id,
            accept_observed: b.accept_observed,
          }),
          `offer:reconcile:${p.id}:${job}`,
        ],
      );
      await c.query("UPDATE offer_plans SET state='queued',job_id=$2,error=NULL WHERE id=$1", [
        p.id,
        job,
      ]);
      await audit(c, req.actor, 'offer.reconcile', p.id, { accept_observed: b.accept_observed });
      return { id: p.id, job_id: job };
    });
  });
  app.post('/api/offer-plans/:id/cancel-wait', (req) => {
    admin(req);
    return tenantTx(req.actor.tenantId, async (c) => {
      const planId = id(req.params);
      const initial = (await c.query('SELECT job_id FROM offer_plans WHERE id=$1', [planId]))
        .rows[0];
      ensure(initial, 404, 'Nie znaleziono planu');
      const job = (
        await c.query('SELECT state,provider_wait_until FROM jobs WHERE id=$1 FOR UPDATE', [
          initial.job_id,
        ])
      ).rows[0];
      ensure(job?.state === 'pending', 409, 'Zadanie jest już wykonywane');
      const p = (await c.query('SELECT * FROM offer_plans WHERE id=$1 FOR UPDATE', [planId]))
        .rows[0];
      ensure(
        p.actor_id === req.actor.userId &&
          p.job_id === initial.job_id &&
          p.state === 'queued' &&
          p.phase === 'ready' &&
          (p.result?.ebay_revision_wait_until || job.provider_wait_until) &&
          job?.state === 'pending',
        409,
        'Można anulować tylko własny plan oczekujący przed zapisem',
      );
      await c.query(
        "UPDATE jobs SET state='failed',error='Anulowano oczekiwanie na limit eBay',lease_token=NULL,locked_at=NULL WHERE id=$1",
        [p.job_id],
      );
      await c.query(
        "UPDATE offer_plans SET state='failed',error='Anulowano oczekiwanie na limit eBay' WHERE id=$1",
        [p.id],
      );
      await audit(c, req.actor, 'offer.cancel_wait', p.id, {});
      return { id: p.id, state: 'failed' };
    });
  });
}
