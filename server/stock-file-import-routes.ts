import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ensure } from './errors';
import * as S from './stock-file-import-schema';
import * as M from './stock-file-import';
export * from './stock-file-import-schema';
export function registerStockFileImportRoutes(
  app: FastifyInstance,
  opts: { available: boolean; readOnly: boolean },
) {
  const root = '/api/stock-file-imports';
  const actor = (r: FastifyRequest) => ({
    ...r.actor,
    ...(r.apiScopes
      ? {
          apiKeyId: (r.currentUser as typeof r.currentUser & { api_key_id?: string }).api_key_id,
          source: 'api' as const,
        }
      : { source: 'manual' as const }),
  });
  const gate = (r: FastifyRequest, write = false) => {
    if (write) ensure(!opts.readOnly, 423, 'Kopia jest tylko do odczytu');
    ensure(opts.available, 503, 'Niekompletny moduł importu stanów');
    ensure(
      !r.apiScopes ||
        (r.apiScopes.includes('products:read') &&
          r.apiScopes.includes('inventory:read') &&
          (!write || r.apiScopes.includes('inventory:write'))),
      403,
      'Brak wymaganych scopes importu stanów',
    );
  };
  const empty = (r: FastifyRequest) => z.strictObject({}).parse(r.query);
  const id = (r: FastifyRequest) => z.strictObject({ id: z.uuid() }).parse(r.params).id;
  const send = (v: any) => ({
    ...v,
    available: opts.available,
    read_only: opts.readOnly,
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
  const get = (path: string, fn: (r: FastifyRequest) => Promise<any>) =>
    app.get(root + path, async (r, reply) => {
      reply.header('Cache-Control', 'no-store');
      gate(r);
      return send(await fn(r));
    });
  const write = (
    path: string,
    fn: (r: FastifyRequest) => Promise<any>,
    method: 'post' | 'patch' = 'post',
  ) =>
    app[method](
      root + path,
      {
        bodyLimit: S.STOCK_FILE_IMPORT_LIMITS.request_bytes,
        onRequest: async (r, reply) => {
          reply.header('Cache-Control', 'no-store');
          gate(r, true);
        },
        config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      },
      async (r, reply) => {
        gate(r, true);
        empty(r);
        const v = await fn(r);
        return reply.code(v.reused || method === 'patch' ? 200 : 201).send(send(v));
      },
    );
  app.get(root + '/options', async (r, reply) => {
    reply.header('Cache-Control', 'no-store');
    const q = S.stockFileImportOptionsQuery.parse(r.query);
    ensure(
      !r.apiScopes ||
        (r.apiScopes.includes('products:read') && r.apiScopes.includes('inventory:read')),
      403,
      'Brak scopes odczytu stanów',
    );
    if (!opts.available) {
      const probe = await M.stockFileImportLegacyOptions(actor(r));
      return {
        ...probe,
        available: false,
        read_only: opts.readOnly,
        can_write: false,
        limits: S.STOCK_FILE_IMPORT_LIMITS,
        warehouses: [],
        next_cursor: null,
      };
    }
    return send(await M.stockFileImportOptions(actor(r), q));
  });
  get('/profiles', (r) =>
    M.stockFileImportProfiles(actor(r), S.stockFileImportPageQuery.parse(r.query)),
  );
  get('/profiles/:id', (r) => {
    empty(r);
    return M.stockFileImportProfileDetail(actor(r), id(r));
  });
  write('/profiles', (r) =>
    M.saveStockFileImportProfile(actor(r), S.stockFileImportProfileInput.parse(r.body)),
  );
  write(
    '/profiles/:id',
    (r) =>
      M.saveStockFileImportProfile(
        actor(r),
        S.stockFileImportProfileUpdateInput.parse(r.body),
        id(r),
      ),
    'patch',
  );
  write('/previews', (r) =>
    M.createStockFileImportPreview(actor(r), S.stockFileImportPreviewInput.parse(r.body)),
  );
  get('/previews', (r) =>
    M.stockFileImportHistory(actor(r), 'previews', S.stockFileImportPageQuery.parse(r.query)),
  );
  get('/previews/:id', (r) => {
    empty(r);
    return M.stockFileImportPreviewDetail(actor(r), id(r));
  });
  get('/previews/:id/rows', (r) =>
    M.stockFileImportRows(actor(r), 'previews', id(r), S.stockFileImportRowsQuery.parse(r.query)),
  );
  write('/previews/:id/execute', (r) =>
    M.executeStockFileImport(actor(r), id(r), S.stockFileImportExecuteInput.parse(r.body)),
  );
  get('/executions', (r) =>
    M.stockFileImportHistory(actor(r), 'executions', S.stockFileImportPageQuery.parse(r.query)),
  );
  get('/executions/:id', (r) => {
    empty(r);
    return M.stockFileImportExecutionDetail(actor(r), id(r));
  });
  get('/executions/:id/rows', (r) =>
    M.stockFileImportRows(actor(r), 'executions', id(r), S.stockFileImportRowsQuery.parse(r.query)),
  );
}
