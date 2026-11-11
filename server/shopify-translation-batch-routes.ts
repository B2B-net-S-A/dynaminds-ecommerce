import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { IntegrationContext } from './channel-access';
import { ensure } from './errors';
import { translationConsent } from './shopify-translations';
import {
  translationBatchInput,
  translationBatchHistory,
  translationBatchDetail,
  translationBatchSelection,
  previewTranslationBatch,
  queueTranslationBatch,
  cancelTranslationBatch,
  resumeTranslationBatch,
} from './shopify-translation-batches';
export function registerShopifyTranslationBatchRoutes(
  app: FastifyInstance,
  ctx: IntegrationContext,
  opts: { available: boolean; readOnly: boolean },
) {
  const available = () => ensure(opts.available, 503, 'Kopia nie zawiera partii tłumaczeń Shopify');
  const write = () => {
    available();
    ensure(!opts.readOnly, 423, 'Publikacja i odczyty dostawcy są wyłączone w podglądzie kopii');
  };
  const id = (p: unknown) => z.object({ id: z.uuid() }).parse(p).id;
  app.get('/api/shopify-translation-batches', async (req) => {
    ensure(req.actor.role === 'admin', 403, 'Wymagany administrator');
    const q = z.strictObject({ cursor: z.string().max(300).optional() }).parse(req.query);
    if (!opts.available)
      return {
        available: false,
        read_only: opts.readOnly,
        data: [],
        channels: [],
        local_locales: [],
        meta: { cursor: null },
      };
    return {
      available: true,
      read_only: opts.readOnly,
      ...(await translationBatchHistory(req.actor, q.cursor)),
    };
  });
  app.get('/api/shopify-translation-batches/selection', async (req) => {
    available();
    const q = z.strictObject({ product_ids: z.string().min(1).max(3700) }).parse(req.query);
    const ids = z.array(z.uuid()).min(1).max(100).parse(q.product_ids.split(','));
    ensure(new Set(ids).size === ids.length, 422, 'Powtórzone produkty');
    return {
      available: true,
      read_only: opts.readOnly,
      ...(await translationBatchSelection(req.actor, ids)),
    };
  });
  app.get('/api/shopify-translation-batches/:id', async (req) => {
    available();
    return {
      read_only: opts.readOnly,
      ...(await translationBatchDetail(req.actor, id(req.params))),
    };
  });
  app.post('/api/shopify-translation-batches/preview', async (req) => {
    write();
    return {
      read_only: opts.readOnly,
      ...(await previewTranslationBatch(req.actor, translationBatchInput.parse(req.body), ctx)),
    };
  });
  app.post('/api/shopify-translation-batches/:id/resume', async (req) => {
    write();
    z.strictObject({}).parse(req.body ?? {});
    return {
      read_only: opts.readOnly,
      ...(await resumeTranslationBatch(req.actor, id(req.params), ctx)),
    };
  });
  app.post('/api/shopify-translation-batches/:id/queue', async (req) => {
    write();
    return {
      read_only: opts.readOnly,
      ...(await queueTranslationBatch(
        req.actor,
        id(req.params),
        translationConsent.parse(req.body ?? {}),
      )),
    };
  });
  app.post('/api/shopify-translation-batches/:id/cancel', async (req) => {
    write();
    z.strictObject({}).parse(req.body ?? {});
    return {
      read_only: opts.readOnly,
      ...(await cancelTranslationBatch(req.actor, id(req.params))),
    };
  });
}
