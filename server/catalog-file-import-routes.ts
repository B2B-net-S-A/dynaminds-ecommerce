import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ensure } from './errors';
import {
  CATALOG_FILE_IMPORT_LIMITS,
  catalogFileImportPreviewInput,
  catalogFileImportExecuteInput,
  catalogFileImportRowsQuery,
  catalogFileImportHistoryQuery,
} from './catalog-file-import-schema';
import {
  catalogFileImportOptions,
  createCatalogFileImportPreview,
  catalogFileImportPreviewDetail,
  executeCatalogFileImport,
  catalogFileImportExecutionDetail,
  catalogFileImportHistory,
} from './catalog-file-import';

const empty = z.strictObject({});
const params = z.strictObject({ id: z.uuid().transform((value) => value.toLowerCase()) });

export function registerCatalogFileImportRoutes(
  app: FastifyInstance,
  opts: { available: boolean; readOnly: boolean },
) {
  const actor = (req: FastifyRequest, write = false) => {
    ensure(
      !req.apiScopes ||
        (req.apiScopes.includes('products:read') &&
          (!write || req.apiScopes.includes('products:write'))),
      403,
      'Wymagany scope products:read' + (write ? ' i products:write' : ''),
    );
    const apiKeyId = req.currentUser?.api_key_id;
    ensure(!req.apiScopes || typeof apiKeyId === 'string', 401, 'Brak kontekstu klucza API');
    return { ...req.actor, ...(req.apiScopes ? { apiKeyId } : {}) };
  };
  const writable = (req: FastifyRequest) => {
    ensure(!opts.readOnly, 423, 'Ta kopia jest tylko do odczytu');
    ensure(opts.available, 503, 'Ta kopia nie obsługuje importu plików CSV/XML');
    return actor(req, true);
  };
  const available = () =>
    ensure(opts.available, 503, 'Ta kopia nie obsługuje historii importu CSV/XML');
  const response = (req: FastifyRequest, result: any) => ({
    ...result,
    available: opts.available && result.available !== false,
    read_only: opts.readOnly,
    can_write:
      opts.available &&
      result.can_write !== false &&
      !opts.readOnly &&
      result.current_role === 'admin' &&
      (!req.apiScopes || req.apiScopes.includes('products:write')),
  });
  app.get('/api/catalog/file-imports/options', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    empty.parse(req.query);
    return response(req, await catalogFileImportOptions(actor(req)));
  });
  app.post(
    '/api/catalog/file-imports/preview',
    {
      bodyLimit: CATALOG_FILE_IMPORT_LIMITS.request_bytes,
      onRequest: async (req) => {
        writable(req);
      },
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      const a = writable(req);
      empty.parse(req.query);
      const result = await createCatalogFileImportPreview(
        a,
        catalogFileImportPreviewInput.parse(req.body),
      );
      return reply.code(result.reused ? 200 : 201).send(response(req, result));
    },
  );
  app.get('/api/catalog/file-imports/previews/:id', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const a = actor(req);
    available();
    return response(
      req,
      await catalogFileImportPreviewDetail(
        a,
        params.parse(req.params).id,
        catalogFileImportRowsQuery.parse(req.query).cursor,
      ),
    );
  });
  app.post(
    '/api/catalog/file-imports/previews/:id/execute',
    {
      bodyLimit: 65536,
      onRequest: async (req) => {
        writable(req);
      },
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      const a = writable(req);
      empty.parse(req.query);
      const result = await executeCatalogFileImport(
        a,
        params.parse(req.params).id,
        catalogFileImportExecuteInput.parse(req.body),
      );
      return reply.code(result.reused ? 200 : 201).send(response(req, result));
    },
  );
  app.get('/api/catalog/file-imports/executions/:id', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const a = actor(req);
    available();
    return response(
      req,
      await catalogFileImportExecutionDetail(
        a,
        params.parse(req.params).id,
        catalogFileImportRowsQuery.parse(req.query).cursor,
      ),
    );
  });
  app.get('/api/catalog/file-imports/history', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const a = actor(req);
    available();
    return response(
      req,
      await catalogFileImportHistory(a, catalogFileImportHistoryQuery.parse(req.query).cursor),
    );
  });
}
