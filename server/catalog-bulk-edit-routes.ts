import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ensure } from './errors';
import {
  catalogBulkEditSelectionQuery,
  catalogBulkEditPreviewInput,
  catalogBulkEditExecuteInput,
  catalogBulkEditRowsQuery,
  catalogBulkEditHistoryQuery,
} from './catalog-bulk-edit-schema';
import {
  catalogBulkEditMetadata,
  catalogBulkEditSelection,
  createCatalogBulkEditPreview,
  catalogBulkEditPreviewDetail,
  catalogBulkEditPreviewRows,
  executeCatalogBulkEdit,
  catalogBulkEditHistory,
  catalogBulkEditExecutionDetail,
  catalogBulkEditExecutionRows,
} from './catalog-bulk-edit';
export {
  catalogBulkEditSelectionQuery,
  catalogBulkEditPreviewInput,
  catalogBulkEditExecuteInput,
  catalogBulkEditRowsQuery,
  catalogBulkEditHistoryQuery,
} from './catalog-bulk-edit-schema';
export function registerCatalogBulkEditRoutes(
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
    data: [],
    meta: { cursor: null },
  });
  const write = (req: FastifyRequest) => {
    ensure(!opts.readOnly, 423, 'Kopia jest tylko do odczytu');
    ensure(opts.available, 503, 'Kopia nie zawiera arkusza PIM');
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
  app.get('/api/catalog-bulk-edit', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    scopes(req);
    if (!opts.available) return missing(req);
    return response(req, await catalogBulkEditMetadata(req.actor));
  });
  app.get('/api/catalog-bulk-edit/selection', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    scopes(req);
    if (!opts.available) return missing(req);
    return response(
      req,
      await catalogBulkEditSelection(req.actor, catalogBulkEditSelectionQuery.parse(req.query).ids),
    );
  });
  app.post(
    '/api/catalog-bulk-edit/previews',
    {
      bodyLimit: 786432,
      onRequest: async (req) => write(req),
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      write(req);
      const result = await createCatalogBulkEditPreview(
        actor(req),
        catalogBulkEditPreviewInput.parse(req.body),
        req.apiScopes ? 'api' : 'manual',
      );
      return reply.code(result.reused ? 200 : 201).send(response(req, result));
    },
  );
  app.get('/api/catalog-bulk-edit/previews/:id', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    scopes(req);
    if (!opts.available) return missing(req);
    return response(req, await catalogBulkEditPreviewDetail(req.actor, id(req.params)));
  });
  app.get('/api/catalog-bulk-edit/previews/:id/rows', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    scopes(req);
    if (!opts.available) return missing(req);
    return response(
      req,
      await catalogBulkEditPreviewRows(
        req.actor,
        id(req.params),
        catalogBulkEditRowsQuery.parse(req.query).cursor,
      ),
    );
  });
  app.post(
    '/api/catalog-bulk-edit/previews/:id/execute',
    {
      bodyLimit: 786432,
      onRequest: async (req) => write(req),
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      write(req);
      const result = await executeCatalogBulkEdit(
        actor(req),
        id(req.params),
        catalogBulkEditExecuteInput.parse(req.body),
        req.apiScopes ? 'api' : 'manual',
      );
      return reply.code(result.reused ? 200 : 201).send(response(req, result));
    },
  );
  app.get('/api/catalog-bulk-edit/executions', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    scopes(req);
    if (!opts.available) return missing(req);
    return response(
      req,
      await catalogBulkEditHistory(req.actor, catalogBulkEditHistoryQuery.parse(req.query).cursor),
    );
  });
  app.get('/api/catalog-bulk-edit/executions/:id', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    scopes(req);
    if (!opts.available) return missing(req);
    return response(req, await catalogBulkEditExecutionDetail(req.actor, id(req.params)));
  });
  app.get('/api/catalog-bulk-edit/executions/:id/rows', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    scopes(req);
    if (!opts.available) return missing(req);
    return response(
      req,
      await catalogBulkEditExecutionRows(
        req.actor,
        id(req.params),
        catalogBulkEditRowsQuery.parse(req.query).cursor,
      ),
    );
  });
}
