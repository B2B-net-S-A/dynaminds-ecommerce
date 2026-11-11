import {trackOrdinaryResponseCleanup} from './ordinary-request-lifetime';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import {
  catalogExportOptions,
  catalogExportPreview,
  catalogExportOptionsQuery,
  catalogExportFileInput,
  catalogExportFileQuery,
  openCatalogExport,
  CATALOG_EXPORT_LIMITS,
} from './catalog-export';
import { ensure } from './errors';
export {
  catalogExportOptionsQuery,
  catalogExportFileInput,
  catalogExportFileQuery,
} from './catalog-export';

export function registerCatalogExportRoutes(app: FastifyInstance, opts: { readOnly: boolean }) {
  const artifacts = new WeakMap<FastifyRequest, Awaited<ReturnType<typeof openCatalogExport>>>();
  app.addHook('onResponse', async (req) => {
    const file = artifacts.get(req);
    if (file) {
      artifacts.delete(req);
      await trackOrdinaryResponseCleanup(app,req,file.dispose);
    }
  });
  const actor = (req: FastifyRequest) => {
    ensure(
      !req.apiScopes || req.apiScopes.includes('products:read'),
      403,
      'Wymagany scope products:read',
    );
    const apiKeyId = req.currentUser?.api_key_id;
    ensure(
      !req.apiScopes || typeof apiKeyId === 'string',
      401,
      'Brak aktualnego kontekstu klucza API',
    );
    return { ...req.actor, ...(req.apiScopes ? { apiKeyId } : {}) };
  };
  app.get('/api/catalog/exports/options', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    return {
      ...(await catalogExportOptions(actor(req), req.query)),
      read_only: opts.readOnly,
    };
  });
  app.post(
    '/api/catalog/exports/preview',
    { bodyLimit: CATALOG_EXPORT_LIMITS.request_bytes },
    async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      return catalogExportPreview(actor(req), req.body);
    },
  );
  const sendFile = async (req: FastifyRequest, reply: FastifyReply, input: unknown) => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    const disconnect = () => {
      if (!reply.raw.writableFinished) abort();
    };
    req.raw.once('aborted', abort);
    reply.raw.once('close', disconnect);
    try {
      const file = await openCatalogExport(actor(req), input, controller.signal);
      artifacts.set(req, file);
      reply.raw.once('finish', () => {
        void trackOrdinaryResponseCleanup(app,req,file.dispose).catch(() => {});
      });
      reply.raw.once('close', () => {
        if (!reply.raw.writableFinished) file.abort();
        void trackOrdinaryResponseCleanup(app,req,file.dispose).catch(() => {});
      });
      reply
        .header('Cache-Control', 'no-store')
        .header('X-Content-Type-Options', 'nosniff')
        .header('Content-Disposition', `attachment; filename="catalog.${file.format}"`)
        .header('Content-Length', file.bytes)
        .header('X-Catalog-Export-Count', file.count)
        .header('X-Catalog-Currency', file.currency)
        .type(file.format === 'csv' ? 'text/csv; charset=utf-8' : 'application/xml; charset=utf-8');
      if (file.catalog_id) reply.header('X-Product-Catalog-ID', file.catalog_id)
        .header('X-Product-Catalog-Version', file.catalog_version!)
        .header('X-Catalog-Export-Scope-Hash', file.scope_hash!);
      return reply.send(file.stream);
    } finally {
      // Response close still owns the controller through its listener until EOF.
      req.raw.off('aborted', abort);
    }
  };
  app.get('/api/catalog/exports/file', async (req, reply) =>
    sendFile(req, reply, catalogExportFileQuery.parse(req.query)),
  );
  // Pure read despite POST transport: 500 UUIDs exceed normal request-line bounds.
  // Root's global readOnly exception and Origin check must preserve this semantics.
  app.post(
    '/api/catalog/exports/file',
    { bodyLimit: CATALOG_EXPORT_LIMITS.request_bytes },
    async (req, reply) => sendFile(req, reply, catalogExportFileInput.parse(req.body)),
  );
}
