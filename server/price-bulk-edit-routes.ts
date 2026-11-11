import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ensure } from './errors';
import {
  priceBulkEditMetadataQuery,
  priceBulkEditSelectionQuery,
  priceBulkEditPreviewInput,
  priceBulkEditExecuteInput,
  priceBulkEditRowsQuery,
  priceBulkEditHistoryQuery,
} from './price-bulk-edit-schema';
import {
  priceBulkEditMetadata,
  priceBulkEditSelection,
  createPriceBulkEditPreview,
  priceBulkEditPreviewDetail,
  priceBulkEditPreviewRows,
  executePriceBulkEdit,
  priceBulkEditHistory,
  priceBulkEditExecutionDetail,
  priceBulkEditExecutionRows,
} from './price-bulk-edit';
export {
  priceBulkEditMetadataQuery,
  priceBulkEditSelectionQuery,
  priceBulkEditPreviewInput,
  priceBulkEditExecuteInput,
  priceBulkEditRowsQuery,
  priceBulkEditHistoryQuery,
} from './price-bulk-edit-schema';
export function registerPriceBulkEditRoutes(
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
    catalog_currency: null,
    price_lists: [],
    limits: { products: 500, selection_products: 50, rows: 500, page: 50, body_bytes: 786432 },
    data: [],
    meta: { cursor: null },
  });
  const write = (req: FastifyRequest) => {
    ensure(!opts.readOnly, 423, 'Kopia jest tylko do odczytu');
    ensure(opts.available, 503, 'Kopia nie zawiera arkusza cen');
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
  app.get('/api/price-bulk-edit', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    scopes(req);
    if (!opts.available) return missing(req);
    return response(
      req,
      await priceBulkEditMetadata(req.actor, priceBulkEditMetadataQuery.parse(req.query)),
    );
  });
  app.get('/api/price-bulk-edit/selection', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    scopes(req);
    if (!opts.available) return missing(req);
    return response(
      req,
      await priceBulkEditSelection(req.actor, priceBulkEditSelectionQuery.parse(req.query)),
    );
  });
  app.post(
    '/api/price-bulk-edit/previews',
    {
      bodyLimit: 786432,
      onRequest: async (req) => write(req),
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      write(req);
      const result = await createPriceBulkEditPreview(
        actor(req),
        priceBulkEditPreviewInput.parse(req.body),
        req.apiScopes ? 'api' : 'manual',
      );
      return reply.code(result.reused ? 200 : 201).send(response(req, result));
    },
  );
  app.get('/api/price-bulk-edit/previews/:id', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    scopes(req);
    if (!opts.available) return missing(req);
    return response(req, await priceBulkEditPreviewDetail(req.actor, id(req.params)));
  });
  app.get('/api/price-bulk-edit/previews/:id/rows', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    scopes(req);
    if (!opts.available) return missing(req);
    return response(
      req,
      await priceBulkEditPreviewRows(
        req.actor,
        id(req.params),
        priceBulkEditRowsQuery.parse(req.query).cursor,
      ),
    );
  });
  app.post(
    '/api/price-bulk-edit/previews/:id/execute',
    {
      bodyLimit: 786432,
      onRequest: async (req) => write(req),
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      write(req);
      const result = await executePriceBulkEdit(
        actor(req),
        id(req.params),
        priceBulkEditExecuteInput.parse(req.body),
        req.apiScopes ? 'api' : 'manual',
      );
      return reply.code(result.reused ? 200 : 201).send(response(req, result));
    },
  );
  app.get('/api/price-bulk-edit/executions', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    scopes(req);
    if (!opts.available) return missing(req);
    return response(
      req,
      await priceBulkEditHistory(req.actor, priceBulkEditHistoryQuery.parse(req.query).cursor),
    );
  });
  app.get('/api/price-bulk-edit/executions/:id', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    scopes(req);
    if (!opts.available) return missing(req);
    return response(req, await priceBulkEditExecutionDetail(req.actor, id(req.params)));
  });
  app.get('/api/price-bulk-edit/executions/:id/rows', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    scopes(req);
    if (!opts.available) return missing(req);
    return response(
      req,
      await priceBulkEditExecutionRows(
        req.actor,
        id(req.params),
        priceBulkEditRowsQuery.parse(req.query).cursor,
      ),
    );
  });
}
