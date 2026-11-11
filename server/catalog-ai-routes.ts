import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { tenantTx } from './db';
import { ensure } from './errors';
import type { Transport } from './integrations';
import type { Pool } from 'pg';
import type { Actor } from './domain';
import type { PimRouteService } from './pim-dictionaries/routes';
import type { IntegrationContext } from './channel-access';
import { aiModels, aiRequest, queueAi, applyAi, cancelAi } from './catalog-ai';
import {
  queueCatalogAiBatch,
  readCatalogAiBatch,
  listCatalogAiBatches,
  applyCatalogAiBatch,
  cancelCatalogAiBatch,
} from './catalog-ai-batches';
import {
  queueCatalogAiAttributes,
  listCatalogAiAttributes,
  applyCatalogAiAttributes,
  cancelCatalogAiAttributes,
} from './catalog-ai-attributes';
import { registerImageBackgroundRoutes } from './image-background-routes';
import { registerCatalogAiMatchRoutes } from './catalog-ai-matching-routes';
/** Which parts of migration 249 this database has (each family is checked on its own table). */
export type CatalogAiExtensions = { batches: boolean; attributes: boolean; images: boolean; matches: boolean };
export async function catalogAiExtensionsAvailable(pool: Pool): Promise<CatalogAiExtensions> {
  const r = (
    await pool.query(
      "SELECT to_regclass('public.catalog_ai_batch_items') IS NOT NULL b,to_regclass('public.catalog_ai_attribute_proposals') IS NOT NULL a,to_regclass('public.catalog_ai_image_jobs') IS NOT NULL i,to_regclass('public.catalog_ai_match_proposals') IS NOT NULL m",
    )
  ).rows[0];
  return { batches: r.b, attributes: r.a, images: r.i, matches: r.m };
}
const none: CatalogAiExtensions = { batches: false, attributes: false, images: false, matches: false };
export function registerCatalogAiRoutes(
  app: FastifyInstance,
  options: {
    available: boolean;
    readOnly: boolean;
    transport?: Transport;
    /** Migration 249 families; omitted = none (older copy). */
    extensions?: CatalogAiExtensions;
    /** PIM service of the app; DOM-AI-002 reads and writes typed values through it with the request's authority. */
    pim?: Pick<PimRouteService, 'editorSource' | 'preview' | 'apply'> & { captureActor(req: any): Actor };
    pimAvailable?: boolean;
    context?: IntegrationContext;
  },
) {
  const ext = options.extensions ?? none;
  const admin = (req: any) =>
    ensure(req.actor.role === 'admin', 403, 'AI katalogu jest dostępne dla administratora');
  const id = (req: any) => z.object({ id: z.uuid() }).parse(req.params).id;
  const available = () => ensure(options.available, 503, 'Kopia nie zawiera modułu AI katalogu');
  app.get('/api/ai/catalog/runtime', async (req) => {
    admin(req);
    if (!options.available || options.readOnly)
      return {
        available: options.available,
        generation_allowed: false,
        read_only: options.readOnly,
        models: [],
        local_only: true,
        notice: 'Generowanie wyłączone w podglądzie kopii',
      };
    try {
      return {
        available: true,
        generation_allowed: true,
        read_only: false,
        models: await aiModels(options.transport),
        local_only: true,
        notice: null,
      };
    } catch {
      return {
        available: true,
        generation_allowed: false,
        read_only: options.readOnly,
        models: [],
        local_only: true,
        notice: 'Uruchom lokalny silnik Ollama i zainstaluj model GGUF do 8 GiB',
      };
    }
  });
  app.get('/api/products/:id/ai', async (req) => {
    admin(req);
    available();
    const product = id(req);
    return tenantTx(req.actor.tenantId, async (c) => {
      ensure(
        (await c.query('SELECT id FROM products WHERE id=$1', [product])).rowCount,
        404,
        'Nie znaleziono produktu',
      );
      return {
        data: (
          await c.query(
            'SELECT * FROM ai_catalog_drafts WHERE product_id=$1 ORDER BY created_at DESC,id DESC LIMIT 30',
            [product],
          )
        ).rows,
        translations: (
          await c.query('SELECT * FROM product_translations WHERE product_id=$1 ORDER BY locale', [
            product,
          ])
        ).rows,
        history_limit: 30,
      };
    });
  });
  app.post('/api/products/:id/ai', async (req, reply) => {
    admin(req);
    available();
    return reply
      .code(201)
      .send(await queueAi(req.actor, id(req), aiRequest.parse(req.body), options.transport));
  });
  app.post('/api/ai/catalog/drafts/:id/apply', (req) => {
    admin(req);
    available();
    return applyAi(req.actor, id(req), req.body);
  });
  app.post('/api/ai/catalog/drafts/:id/cancel', (req) => {
    admin(req);
    available();
    return cancelAi(req.actor, id(req));
  });
  // Migration 249 (DOM-AI-001 needs nothing here: the style travels in aiRequest).
  const write = (req: any, present: boolean) => {
    admin(req);
    available();
    ensure(!options.readOnly, 423, 'Podgląd odtworzonej kopii jest tylko do odczytu. Operacja nie została wykonana.');
    ensure(present, 503, 'Kopia nie zawiera tej funkcji AI katalogu');
  };
  // DOM-AI-003 batches.
  app.get('/api/ai/catalog/batches', async (req) => {
    admin(req);
    if (!ext.batches) return { available: false, data: [] };
    return listCatalogAiBatches(req.actor);
  });
  app.get('/api/ai/catalog/batches/:id', async (req) => {
    admin(req);
    ensure(ext.batches, 503, 'Kopia nie zawiera partii AI katalogu');
    return readCatalogAiBatch(req.actor, id(req));
  });
  app.post('/api/ai/catalog/batches', async (req, reply) => {
    write(req, ext.batches);
    const r = await queueCatalogAiBatch(req.actor, req.body, options.transport);
    return reply.code(r.replayed ? 200 : 201).send(r.batch);
  });
  app.post('/api/ai/catalog/batches/:id/apply', async (req) => {
    write(req, ext.batches);
    return applyCatalogAiBatch(req.actor, id(req), req.body);
  });
  app.post('/api/ai/catalog/batches/:id/cancel', async (req) => {
    write(req, ext.batches);
    return cancelCatalogAiBatch(req.actor, id(req));
  });
  // DOM-AI-002 typed PIM parameters.
  const pim = () => {
    ensure(options.pim && options.pimAvailable, 503, 'Słowniki parametrów PIM nie są dostępne w tej bazie');
    return options.pim!;
  };
  app.get('/api/products/:id/ai/attributes', async (req) => {
    admin(req);
    if (!ext.attributes) return { available: false, pim_available: options.pimAvailable === true, data: [], history_limit: 30 };
    return { ...(await listCatalogAiAttributes(req.actor, id(req))), pim_available: options.pimAvailable === true };
  });
  app.post('/api/products/:id/ai/attributes', async (req, reply) => {
    write(req, ext.attributes);
    const service = pim();
    return reply
      .code(201)
      .send(await queueCatalogAiAttributes(req.actor, service.captureActor(req), service, id(req), req.body, options.transport));
  });
  app.post('/api/ai/catalog/attributes/:id/apply', async (req) => {
    write(req, ext.attributes);
    const service = pim();
    return applyCatalogAiAttributes(req.actor, service.captureActor(req), service, id(req), req.body);
  });
  app.post('/api/ai/catalog/attributes/:id/cancel', async (req) => {
    write(req, ext.attributes);
    return cancelCatalogAiAttributes(req.actor, id(req));
  });
  // DOM-AI-004 and DOM-AI-005 register their own routes.
  registerImageBackgroundRoutes(app, { available: options.available && ext.images, readOnly: options.readOnly, transport: options.transport });
  registerCatalogAiMatchRoutes(app, { available: options.available && ext.matches, readOnly: options.readOnly, transport: options.transport, context: options.context });
}
