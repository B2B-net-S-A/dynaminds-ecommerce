import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ensure } from './errors';
import {
  inventoryBulkEditSelectionQuery,
  inventoryBulkEditPreviewInput,
  inventoryBulkEditExecuteInput,
  inventoryBulkEditRowsQuery,
  inventoryBulkEditHistoryQuery,
} from './inventory-bulk-edit-schema';
import {
  inventoryBulkEditMetadata,
  inventoryBulkEditSelection,
  createInventoryBulkEditPreview,
  inventoryBulkEditPreviewDetail,
  inventoryBulkEditPreviewRows,
  executeInventoryBulkEdit,
  inventoryBulkEditHistory,
  inventoryBulkEditExecutionDetail,
  inventoryBulkEditExecutionRows,
} from './inventory-bulk-edit';
export {
  inventoryBulkEditSelectionQuery,
  inventoryBulkEditPreviewInput,
  inventoryBulkEditExecuteInput,
  inventoryBulkEditRowsQuery,
  inventoryBulkEditHistoryQuery,
} from './inventory-bulk-edit-schema';
export function registerInventoryBulkEditRoutes(
  app: FastifyInstance,
  opts: { available: boolean; readOnly: boolean },
) {
  const flags = { available: opts.available, read_only: opts.readOnly };
  const scopes = (req: FastifyRequest, write = false) =>
    ensure(
      !req.apiScopes ||
        (req.apiScopes.includes('products:read') &&
          req.apiScopes.includes('inventory:read') &&
          (!write || req.apiScopes.includes('inventory:write'))),
      403,
      'Wymagane scopes products:read i inventory:read' + (write ? ' i inventory:write' : ''),
    );
  const response = (req: FastifyRequest, result: any) => ({
    ...flags,
    ...result,
    can_write:
      !opts.readOnly &&
      result.current_role === 'admin' &&
      (!req.apiScopes || req.apiScopes.includes('inventory:write')),
  });
  const missing = (req: FastifyRequest) => ({
    ...flags,
    current_role: req.actor.role,
    can_read: true,
    can_write: false,
    warehouses: [],
    limits: { products: 500, selection_products: 50, rows: 500, page: 50, body_bytes: 786432 },
    data: [],
    meta: { cursor: null },
  });
  const write = (req: FastifyRequest) => {
    ensure(!opts.readOnly, 423, 'Kopia jest tylko do odczytu');
    ensure(opts.available, 503, 'Kopia nie zawiera arkusza stanów i lokalizacji');
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
  app.get('/api/inventory-bulk-edit', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    scopes(req);
    if (!opts.available) return missing(req);
    return response(req, await inventoryBulkEditMetadata(req.actor));
  });
  app.get('/api/inventory-bulk-edit/selection', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    scopes(req);
    if (!opts.available) return missing(req);
    return response(
      req,
      await inventoryBulkEditSelection(req.actor, inventoryBulkEditSelectionQuery.parse(req.query)),
    );
  });
  app.post(
    '/api/inventory-bulk-edit/previews',
    {
      bodyLimit: 786432,
      onRequest: async (req) => write(req),
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      write(req);
      const result = await createInventoryBulkEditPreview(
        actor(req),
        inventoryBulkEditPreviewInput.parse(req.body),
        req.apiScopes ? 'api' : 'manual',
      );
      return reply.code(result.reused ? 200 : 201).send(response(req, result));
    },
  );
  app.get('/api/inventory-bulk-edit/previews/:id', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    scopes(req);
    if (!opts.available) return missing(req);
    return response(req, await inventoryBulkEditPreviewDetail(req.actor, id(req.params)));
  });
  app.get('/api/inventory-bulk-edit/previews/:id/rows', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    scopes(req);
    if (!opts.available) return missing(req);
    return response(
      req,
      await inventoryBulkEditPreviewRows(
        req.actor,
        id(req.params),
        inventoryBulkEditRowsQuery.parse(req.query).cursor,
      ),
    );
  });
  app.post(
    '/api/inventory-bulk-edit/previews/:id/execute',
    {
      bodyLimit: 786432,
      onRequest: async (req) => write(req),
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      write(req);
      const result = await executeInventoryBulkEdit(
        actor(req),
        id(req.params),
        inventoryBulkEditExecuteInput.parse(req.body),
        req.apiScopes ? 'api' : 'manual',
      );
      return reply.code(result.reused ? 200 : 201).send(response(req, result));
    },
  );
  app.get('/api/inventory-bulk-edit/executions', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    scopes(req);
    if (!opts.available) return missing(req);
    return response(
      req,
      await inventoryBulkEditHistory(
        req.actor,
        inventoryBulkEditHistoryQuery.parse(req.query).cursor,
      ),
    );
  });
  app.get('/api/inventory-bulk-edit/executions/:id', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    scopes(req);
    if (!opts.available) return missing(req);
    return response(req, await inventoryBulkEditExecutionDetail(req.actor, id(req.params)));
  });
  app.get('/api/inventory-bulk-edit/executions/:id/rows', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    scopes(req);
    if (!opts.available) return missing(req);
    return response(
      req,
      await inventoryBulkEditExecutionRows(
        req.actor,
        id(req.params),
        inventoryBulkEditRowsQuery.parse(req.query).cursor,
      ),
    );
  });
}
