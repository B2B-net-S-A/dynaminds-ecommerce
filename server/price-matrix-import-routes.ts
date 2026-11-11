import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ensure } from './errors';
import {
  priceMatrixImportOptions,
  createPriceMatrixImportPreview,
  executePriceMatrixImport,
  priceMatrixImportPreviewDetail,
  priceMatrixImportExecutionDetail,
  priceMatrixImportRows,
  priceMatrixImportHistory,
  priceMatrixImportProfiles,
  priceMatrixImportProfileDetail,
  savePriceMatrixImportProfile,
} from './price-matrix-import';
import {
  priceMatrixImportOptionsQuery,
  priceMatrixImportPreviewInput,
  priceMatrixImportExecuteInput,
  priceMatrixImportProfileInput,
  priceMatrixImportProfileUpdateInput,
  priceMatrixImportPageQuery,
  priceMatrixImportRowsQuery,
  PRICE_MATRIX_IMPORT_LIMITS as L,
} from './price-matrix-import-schema';
export * from './price-matrix-import-schema';
export function registerPriceMatrixImportRoutes(
  app: FastifyInstance,
  opts: { available: boolean; readOnly: boolean },
) {
  const root = '/api/price-matrix-imports',
    flags = { available: opts.available, read_only: opts.readOnly };
  const actor = (r: FastifyRequest) => {
    const kid = (r.currentUser as typeof r.currentUser & { api_key_id?: string }).api_key_id;
    ensure(!r.apiScopes || kid, 401, 'Brak kontekstu klucza API');
    return { ...r.actor, ...(r.apiScopes ? { apiKeyId: kid } : {}) };
  };
  const gate = (r: FastifyRequest, write = false) => {
    if (write) ensure(!opts.readOnly, 423, 'Kopia jest tylko do odczytu');
    ensure(opts.available, 503, 'Kopia nie zawiera importu macierzy cen');
    ensure(
      !r.apiScopes ||
        (r.apiScopes.includes('products:read') &&
          (!write || r.apiScopes.includes('products:write'))),
      403,
      'Wymagane scopes products:read' + (write ? ' i products:write' : ''),
    );
  };
  const emptyQuery = (r: FastifyRequest) => z.strictObject({}).parse(r.query);
  const id = (v: unknown) => z.strictObject({ id: z.uuid() }).parse(v).id;
  const send = (r: FastifyRequest, v: any) => ({
    ...flags,
    ...v,
    can_write: !opts.readOnly && v.can_write,
    ...(v.preview
      ? {
          preview: {
            ...v.preview,
            can_execute: !opts.readOnly && v.can_write && v.preview.can_execute,
          },
        }
      : {}),
  });
  const get = (path: string, fn: (r: FastifyRequest) => Promise<unknown>) =>
    app.get(root + path, async (r, reply) => {
      reply.header('Cache-Control', 'no-store');
      gate(r);
      return send(r, await fn(r));
    });
  const post = (
    path: string,
    fn: (r: FastifyRequest) => Promise<any>,
    method: 'post' | 'patch' = 'post',
  ) =>
    app[method](
      root + path,
      {
        bodyLimit: L.request_bytes,
        onRequest: async (r, reply) => {
          reply.header('Cache-Control', 'no-store');
          gate(r, true);
        },
        config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      },
      async (r, reply) => {
        gate(r, true);
        emptyQuery(r);
        const v = await fn(r);
        return reply.code(v.reused ? 200 : method === 'patch' ? 200 : 201).send(send(r, v));
      },
    );
  app.get(root + '/options', async (r, reply) => {
    reply.header('Cache-Control', 'no-store');
    ensure(
      !r.apiScopes || r.apiScopes.includes('products:read'),
      403,
      'Wymagane scopes products:read',
    );
    const q = priceMatrixImportOptionsQuery.parse(r.query);
    if (!opts.available)
      return {
        ...flags,
        current_role: r.actor.role,
        can_read: true,
        can_write: false,
        catalog_currency: null,
        price_lists: [],
        meta: { cursor: null },
        limits: L,
      };
    return send(r, await priceMatrixImportOptions(actor(r), q));
  });
  get('/profiles', (r) =>
    priceMatrixImportProfiles(actor(r), priceMatrixImportPageQuery.parse(r.query)),
  );
  get('/profiles/:id', (r) => {
    emptyQuery(r);
    return priceMatrixImportProfileDetail(actor(r), id(r.params));
  });
  post('/profiles', (r) =>
    savePriceMatrixImportProfile(actor(r), priceMatrixImportProfileInput.parse(r.body)),
  );
  post(
    '/profiles/:id',
    (r) =>
      savePriceMatrixImportProfile(
        actor(r),
        priceMatrixImportProfileUpdateInput.parse(r.body),
        id(r.params),
      ),
    'patch',
  );
  get('/previews', (r) =>
    priceMatrixImportHistory(actor(r), priceMatrixImportPageQuery.parse(r.query), 'preview'),
  );
  post('/previews', (r) =>
    createPriceMatrixImportPreview(actor(r), priceMatrixImportPreviewInput.parse(r.body)),
  );
  get('/previews/:id', (r) => {
    emptyQuery(r);
    return priceMatrixImportPreviewDetail(actor(r), id(r.params));
  });
  get('/previews/:id/rows', (r) =>
    priceMatrixImportRows(actor(r), id(r.params), priceMatrixImportRowsQuery.parse(r.query)),
  );
  post('/previews/:id/execute', (r) =>
    executePriceMatrixImport(actor(r), id(r.params), priceMatrixImportExecuteInput.parse(r.body)),
  );
  get('/executions', (r) =>
    priceMatrixImportHistory(actor(r), priceMatrixImportPageQuery.parse(r.query), 'execution'),
  );
  get('/executions/:id', (r) => {
    emptyQuery(r);
    return priceMatrixImportExecutionDetail(actor(r), id(r.params));
  });
  get('/executions/:id/rows', (r) =>
    priceMatrixImportRows(
      actor(r),
      id(r.params),
      priceMatrixImportRowsQuery.parse(r.query),
      'execution',
    ),
  );
}
