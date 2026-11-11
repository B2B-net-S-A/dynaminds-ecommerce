import { PRODUCT_TRANSLATION_BULK_LIMITS } from './product-translation-bulk-edit-schema';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ensure } from './errors';
import {
  productTranslationBulkEditMetadataQuery,
  productTranslationBulkEditSelectionQuery,
  productTranslationBulkEditPreviewInput,
  productTranslationBulkEditExecuteInput,
  productTranslationBulkEditRowsQuery,
  productTranslationBulkEditHistoryQuery,
} from './product-translation-bulk-edit-schema';
import {
  productTranslationBulkEditMetadata,
  productTranslationBulkEditSelection,
  createProductTranslationBulkEditPreview,
  productTranslationBulkEditPreviewDetail,
  productTranslationBulkEditPreviewRows,
  executeProductTranslationBulkEdit,
  productTranslationBulkEditHistory,
  productTranslationBulkEditExecutionDetail,
  productTranslationBulkEditExecutionRows,
} from './product-translation-bulk-edit';
export {
  productTranslationBulkEditMetadataQuery,
  productTranslationBulkEditSelectionQuery,
  productTranslationBulkEditPreviewInput,
  productTranslationBulkEditExecuteInput,
  productTranslationBulkEditRowsQuery,
  productTranslationBulkEditHistoryQuery,
} from './product-translation-bulk-edit-schema';
export function registerProductTranslationBulkEditRoutes(
  app: FastifyInstance,
  opts: { available: boolean; readOnly: boolean },
) {
  const flags = { available: opts.available, read_only: opts.readOnly };
  const scopes = (req: FastifyRequest, write = false) =>
    ensure(
      !req.apiScopes ||
        (req.apiScopes.includes('products:read') &&
          (!write || req.apiScopes.includes('products:write'))),
      403,
      'Wymagane scopes products:read' + (write ? ' i products:write' : ''),
    );
  const response = (req: FastifyRequest, result: any) => ({
    ...flags,
    ...result,
    can_write:
      !opts.readOnly &&
      result.current_role === 'admin' &&
      (!req.apiScopes || req.apiScopes.includes('products:write')),
  });
  const missing = (req: FastifyRequest) => ({
    ...flags,
    current_role: req.actor.role,
    can_read: true,
    can_write: false,
    locales: [],
    limits: PRODUCT_TRANSLATION_BULK_LIMITS,
    data: [],
    meta: { cursor: null },
  });
  const write = (req: FastifyRequest) => {
    ensure(!opts.readOnly, 423, 'Kopia jest tylko do odczytu');
    ensure(opts.available, 503, 'Kopia nie zawiera arkusza wersji językowych');
    scopes(req, true);
  };
  const actor = (req: FastifyRequest) => {
    const apiKeyId = (req.currentUser as typeof req.currentUser & { api_key_id?: string })
      .api_key_id;
    ensure(
      !req.apiScopes || typeof apiKeyId === 'string',
      401,
      'Brak aktualnego kontekstu klucza API',
    );
    return { ...req.actor, ...(req.apiScopes ? { apiKeyId } : {}) };
  };
  const id = (params: unknown) => z.strictObject({ id: z.uuid() }).parse(params).id;
  app.get('/api/product-translation-bulk-edit', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    scopes(req);
    if (!opts.available) return missing(req);
    return response(
      req,
      await productTranslationBulkEditMetadata(
        req.actor,
        productTranslationBulkEditMetadataQuery.parse(req.query).cursor,
      ),
    );
  });
  app.get('/api/product-translation-bulk-edit/selection', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    scopes(req);
    if (!opts.available) return missing(req);
    return response(
      req,
      await productTranslationBulkEditSelection(
        req.actor,
        productTranslationBulkEditSelectionQuery.parse(req.query),
      ),
    );
  });
  app.post(
    '/api/product-translation-bulk-edit/previews',
    {
      bodyLimit: 2097152,
      onRequest: async (req) => write(req),
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      write(req);
      const result = await createProductTranslationBulkEditPreview(
        actor(req),
        productTranslationBulkEditPreviewInput.parse(req.body),
        req.apiScopes ? 'api' : 'manual',
      );
      return reply.code(result.reused ? 200 : 201).send(response(req, result));
    },
  );
  app.get('/api/product-translation-bulk-edit/previews/:id', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    scopes(req);
    if (!opts.available) return missing(req);
    return response(req, await productTranslationBulkEditPreviewDetail(req.actor, id(req.params)));
  });
  app.get('/api/product-translation-bulk-edit/previews/:id/rows', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    scopes(req);
    if (!opts.available) return missing(req);
    return response(
      req,
      await productTranslationBulkEditPreviewRows(
        req.actor,
        id(req.params),
        productTranslationBulkEditRowsQuery.parse(req.query).cursor,
      ),
    );
  });
  app.post(
    '/api/product-translation-bulk-edit/previews/:id/execute',
    {
      bodyLimit: 2097152,
      onRequest: async (req) => write(req),
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      write(req);
      const result = await executeProductTranslationBulkEdit(
        actor(req),
        id(req.params),
        productTranslationBulkEditExecuteInput.parse(req.body),
        req.apiScopes ? 'api' : 'manual',
      );
      return reply.code(result.reused ? 200 : 201).send(response(req, result));
    },
  );
  app.get('/api/product-translation-bulk-edit/executions', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    scopes(req);
    if (!opts.available) return missing(req);
    return response(
      req,
      await productTranslationBulkEditHistory(
        req.actor,
        productTranslationBulkEditHistoryQuery.parse(req.query).cursor,
      ),
    );
  });
  app.get('/api/product-translation-bulk-edit/executions/:id', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    scopes(req);
    if (!opts.available) return missing(req);
    return response(
      req,
      await productTranslationBulkEditExecutionDetail(req.actor, id(req.params)),
    );
  });
  app.get('/api/product-translation-bulk-edit/executions/:id/rows', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    scopes(req);
    if (!opts.available) return missing(req);
    return response(
      req,
      await productTranslationBulkEditExecutionRows(
        req.actor,
        id(req.params),
        productTranslationBulkEditRowsQuery.parse(req.query).cursor,
      ),
    );
  });
}
