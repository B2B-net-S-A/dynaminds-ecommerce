import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Shopify, shopifyId, demoShopifyPublication } from './shopify';
import { channelRead, loadChannel, type IntegrationContext } from './channel-access';
import { connectionHash } from './offer-sync-policy';
import { tenantTx } from './db';
import { audit } from './domain';
import { ensure } from './errors';

export const demoShopifyLocation = {
  id: 'gid://shopify/Location/1',
  name: 'Magazyn demonstracyjny Shopify',
  isActive: true,
  fulfillsOnlineOrders: true,
};
export function registerShopifyOfferRoutes(app: FastifyInstance, ctx: IntegrationContext) {
  const admin = (req: any) =>
    ensure(req.actor.role === 'admin', 403, 'Wymagana rola administratora');
  const id = (p: unknown) => z.object({ id: z.uuid() }).parse(p).id;
  app.get('/api/integrations/:id/shopify-publications', async (req) => {
    admin(req);
    const ch = await loadChannel(req.actor.tenantId, id(req.params));
    ensure(ch.provider === 'shopify', 404, 'Nie znaleziono Shopify');
    const q = z.object({ cursor: z.string().max(2048).optional() }).parse(req.query);
    const page = ch.settings.simulation
      ? { data: [demoShopifyPublication], has_more: false, next_cursor: null }
      : await channelRead(
          req.actor.tenantId,
          ch.id,
          async (client) => {
            ensure(client instanceof Shopify, 422, 'Wymagany Shopify');
            return client.publications(q.cursor);
          },
          ctx,
        );
    return { ...page, scope: ch.settings.simulation ? 'local_simulation' : 'external_read' };
  });
  app.get('/api/integrations/:id/shopify-locations', async (req) => {
    admin(req);
    const ch = await loadChannel(req.actor.tenantId, id(req.params));
    ensure(ch.provider === 'shopify', 404, 'Nie znaleziono Shopify');
    const q = z.object({ cursor: z.string().max(2048).optional() }).parse(req.query);
    const page = ch.settings.simulation
      ? { data: [demoShopifyLocation], has_more: false, next_cursor: null }
      : await channelRead(
          req.actor.tenantId,
          ch.id,
          async (client) => {
            ensure(client instanceof Shopify, 422, 'Wymagany Shopify');
            return client.locations(q.cursor);
          },
          ctx,
        );
    return {
      ...page,
      inventory_location_id: ch.settings.inventory_location_id ?? null,
      scope: ch.settings.simulation ? 'local_simulation' : 'external_read',
    };
  });
  app.patch('/api/integrations/:id/shopify-location', async (req) => {
    admin(req);
    const ch = await loadChannel(req.actor.tenantId, id(req.params));
    ensure(ch.provider === 'shopify', 404, 'Nie znaleziono Shopify');
    const b = z
      .object({ location_id: z.string(), expected_location_id: z.string().nullable() })
      .strict()
      .parse(req.body);
    shopifyId(b.location_id, 'Location');
    const location = ch.settings.simulation
      ? demoShopifyLocation
      : await channelRead(
          req.actor.tenantId,
          ch.id,
          async (client) => {
            ensure(client instanceof Shopify, 422, 'Wymagany Shopify');
            return client.location(b.location_id);
          },
          ctx,
        );
    ensure(
      location.id === b.location_id && location.isActive && location.fulfillsOnlineOrders,
      422,
      'Wybierz aktywną lokalizację obsługującą zamówienia online',
    );
    return tenantTx(req.actor.tenantId, async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        'offer-sync-config:' + req.actor.tenantId + ':' + ch.id,
      ]);
      const cfg = (
        await c.query('SELECT enabled FROM offer_sync_configs WHERE channel_id=$1 FOR UPDATE', [
          ch.id,
        ])
      ).rows[0];
      const current = (await c.query('SELECT * FROM channels WHERE id=$1 FOR UPDATE', [ch.id]))
        .rows[0];
      ensure(
        current &&
          connectionHash(current) === connectionHash(ch) &&
          current.credentials === ch.credentials,
        409,
        'Połączenie zmieniło się podczas odczytu lokalizacji',
      );
      ensure(
        (current.settings.inventory_location_id ?? null) === b.expected_location_id,
        409,
        'Lokalizację zmieniono; odśwież dane',
      );
      if (b.location_id !== b.expected_location_id) {
        ensure(!cfg?.enabled, 409, 'Najpierw wstrzymaj harmonogram ofert');
        ensure(
          !(
            await c.query(
              "SELECT id FROM offer_plans WHERE channel_id=$1 AND (state='queued' OR (state='failed' AND phase IN ('write_started','verify'))) LIMIT 1",
              [ch.id],
            )
          ).rowCount,
          409,
          'Najpierw uzgodnij trwające lub niepewne zapisy Shopify',
        );
        await c.query('UPDATE channels SET settings=$2 WHERE id=$1', [
          ch.id,
          JSON.stringify({ ...current.settings, inventory_location_id: b.location_id }),
        ]);
        await audit(c, req.actor, 'shopify.location.configure', ch.id, {
          previous: b.expected_location_id,
          location_id: b.location_id,
        });
      }
      return { inventory_location_id: b.location_id, location, scope: 'local_configuration' };
    });
  });
}
