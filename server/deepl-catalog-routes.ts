import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { tenantTx } from './db';
import { encrypt } from './security';
import { ensure } from './errors';
import { audit } from './domain';
import type { IntegrationContext } from './channel-access';
import {
  deeplAdmin,
  deeplMetadata,
  deeplPrepare,
  prepareDeepL,
  queueDeepL,
  applyDeepL,
  cancelDeepL,
} from './deepl-catalog';
export function registerDeepLRoutes(
  app: FastifyInstance,
  ctx: IntegrationContext,
  options: { available: boolean; readOnly: boolean; batchesAvailable?: boolean },
) {
  const id = (req: any) => z.object({ id: z.uuid() }).parse(req.params).id;
  const available = () => ensure(options.available, 503, 'Kopia nie zawiera modułu DeepL');
  app.get('/api/products/:id/deepl', async (req) => {
    ensure(req.actor.role === 'admin', 403, 'Wymagany administrator');
    if (!options.available)
      return {
        available: false,
        read_only: options.readOnly,
        data: [],
        channels: [],
        translations: [],
      };
    return tenantTx(req.actor.tenantId, async (c) => {
      await deeplAdmin(c, req.actor);
      ensure(
        (await c.query('SELECT id FROM products WHERE id=$1', [id(req)])).rowCount,
        404,
        'Nie znaleziono produktu',
      );
      return {
        available: true,
        read_only: options.readOnly,
        data: (
          await c.query(
            'SELECT * FROM deepl_catalog_drafts WHERE product_id=$1' +
              (options.batchesAvailable ? ' AND batch_id IS NULL' : '') +
              ' ORDER BY created_at DESC,id DESC LIMIT 30',
            [id(req)],
          )
        ).rows,
        channels: (
          await c.query(
            "SELECT id,name,settings->>'api_plan' api_plan,settings->>'simulation'='true' simulation FROM channels WHERE provider='deepl' ORDER BY created_at DESC,id LIMIT 100",
          )
        ).rows,
        translations: (
          await c.query('SELECT * FROM product_translations WHERE product_id=$1 ORDER BY locale', [
            id(req),
          ])
        ).rows,
      };
    });
  });
  app.get('/api/integrations/:id/deepl', async (req) => {
    available();
    if (options.readOnly) {
      await tenantTx(req.actor.tenantId, async (c) => {
        await deeplAdmin(c, req.actor);
        ensure(
          (await c.query("SELECT id FROM channels WHERE id=$1 AND provider='deepl'", [id(req)]))
            .rowCount,
          404,
          'Nie znaleziono połączenia DeepL',
        );
      });
      return {
        read_only: true,
        languages: [],
        usage: null,
        notice: 'Odczyt dostawcy wyłączony w podglądzie kopii',
      };
    }
    return deeplMetadata(req.actor, id(req), ctx);
  });
  app.post('/api/products/:id/deepl/preview', async (req, reply) => {
    available();
    return reply
      .code(201)
      .send(await prepareDeepL(req.actor, id(req), deeplPrepare.parse(req.body), ctx));
  });
  app.post('/api/deepl/drafts/:id/queue', (req) => {
    available();
    return queueDeepL(req.actor, id(req), req.body);
  });
  app.post('/api/deepl/drafts/:id/apply', (req) => {
    available();
    return applyDeepL(req.actor, id(req), req.body);
  });
  app.post('/api/deepl/drafts/:id/cancel', (req) => {
    available();
    return cancelDeepL(req.actor, id(req));
  });
  app.post('/api/integrations/deepl-example', async (req) => {
    available();
    return tenantTx(req.actor.tenantId, async (c) => {
      await deeplAdmin(c, req.actor);
      await c.query('SELECT id FROM tenants WHERE id=$1 FOR UPDATE', [req.actor.tenantId]);
      let ch = (
        await c.query(
          "SELECT id FROM channels WHERE provider='deepl' AND settings->>'simulation'='true' ORDER BY created_at LIMIT 1",
        )
      ).rows[0];
      if (!ch) {
        ch = (
          await c.query(
            "INSERT INTO channels(id,tenant_id,provider,name,mode,credentials,settings,status) VALUES($1,$2,'deepl','DeepL — przykład lokalny','sandbox',$3,$4,'simulation') RETURNING id",
            [
              randomUUID(),
              req.actor.tenantId,
              encrypt({ api_key: 'local-deepl-example:fx' }),
              JSON.stringify({ api_plan: 'free', simulation: true }),
            ],
          )
        ).rows[0];
        await audit(c, req.actor, 'integration.deepl.example', ch.id, { simulation: true });
      }
      return { channel_id: ch.id, simulation: true };
    });
  });
}
