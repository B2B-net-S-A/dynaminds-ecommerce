import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ensure } from './errors';
import {
  priceFileImportOptions,
  createPriceFileImportPreview,
  executePriceFileImport,
  priceFileImportPreviewDetail,
  priceFileImportExecutionDetail,
  priceFileImportRows,
  priceFileImportHistory,
  priceFileImportProfiles,
  priceFileImportProfileDetail,
  savePriceFileImportProfile,
} from './price-file-import';
import {
  priceFileImportOptionsQuery,
  priceFileImportPreviewInput,
  priceFileImportExecuteInput,
  priceFileImportProfileInput,
  priceFileImportProfileUpdateInput,
  priceFileImportPageQuery,
  priceFileImportRowsQuery,
  PRICE_FILE_IMPORT_LIMITS as L,
} from './price-file-import-schema';
export * from './price-file-import-schema';
export function registerPriceFileImportRoutes(
  app: FastifyInstance,
  opts: { available: boolean; readOnly: boolean },
) {
  const root = '/api/price-file-imports',
    flags = { available: opts.available, read_only: opts.readOnly };
  const actor = (r: FastifyRequest) => {
    const kid = (r.currentUser as typeof r.currentUser & { api_key_id?: string }).api_key_id;
    ensure(!r.apiScopes || kid, 401, 'Brak kontekstu klucza API');
    return { ...r.actor, ...(r.apiScopes ? { apiKeyId: kid } : {}) };
  };
  const gate = (r: FastifyRequest, write = false) => {
    if (write) ensure(!opts.readOnly, 423, 'Kopia jest tylko do odczytu');
    ensure(opts.available, 503, 'Kopia nie zawiera importu pliku cen');
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
    const q = priceFileImportOptionsQuery.parse(r.query);
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
    return send(r, await priceFileImportOptions(actor(r), q));
  });
  get('/profiles', (r) =>
    priceFileImportProfiles(actor(r), priceFileImportPageQuery.parse(r.query)),
  );
  get('/profiles/:id', (r) => {
    emptyQuery(r);
    return priceFileImportProfileDetail(actor(r), id(r.params));
  });
  post('/profiles', (r) =>
    savePriceFileImportProfile(actor(r), priceFileImportProfileInput.parse(r.body)),
  );
  post(
    '/profiles/:id',
    (r) =>
      savePriceFileImportProfile(
        actor(r),
        priceFileImportProfileUpdateInput.parse(r.body),
        id(r.params),
      ),
    'patch',
  );
  get('/previews', (r) =>
    priceFileImportHistory(actor(r), priceFileImportPageQuery.parse(r.query), 'preview'),
  );
  post('/previews', (r) =>
    createPriceFileImportPreview(actor(r), priceFileImportPreviewInput.parse(r.body)),
  );
  get('/previews/:id', (r) => {
    emptyQuery(r);
    return priceFileImportPreviewDetail(actor(r), id(r.params));
  });
  get('/previews/:id/rows', (r) =>
    priceFileImportRows(actor(r), id(r.params), priceFileImportRowsQuery.parse(r.query)),
  );
  post('/previews/:id/execute', (r) =>
    executePriceFileImport(actor(r), id(r.params), priceFileImportExecuteInput.parse(r.body)),
  );
  get('/executions', (r) =>
    priceFileImportHistory(actor(r), priceFileImportPageQuery.parse(r.query), 'execution'),
  );
  get('/executions/:id', (r) => {
    emptyQuery(r);
    return priceFileImportExecutionDetail(actor(r), id(r.params));
  });
  get('/executions/:id/rows', (r) =>
    priceFileImportRows(
      actor(r),
      id(r.params),
      priceFileImportRowsQuery.parse(r.query),
      'execution',
    ),
  );
}
