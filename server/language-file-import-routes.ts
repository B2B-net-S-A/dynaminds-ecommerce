import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ensure } from './errors';
import { pool } from './db';
import {
  languageFileImportOptions,
  createLanguageFileImportPreview,
  executeLanguageFileImport,
  languageFileImportPreviewDetail,
  languageFileImportExecutionDetail,
  languageFileImportRows,
  languageFileImportHistory,
  languageFileImportProfiles,
  languageFileImportProfileDetail,
  saveLanguageFileImportProfile,
} from './language-file-import';
import {
  languageFileImportOptionsQuery,
  languageFileImportPreviewInput,
  languageFileImportExecuteInput,
  languageFileImportProfileInput,
  languageFileImportProfileUpdateInput,
  languageFileImportPageQuery,
  languageFileImportRowsQuery,
  LANGUAGE_FILE_IMPORT_LIMITS as L,
} from './language-file-import-schema';
export * from './language-file-import-schema';
export function registerLanguageFileImportRoutes(
  app: FastifyInstance,
  opts: { available: boolean; readOnly: boolean },
) {
  const root = '/api/language-file-imports',
    flags = { available: opts.available, read_only: opts.readOnly };
  const actor = (r: FastifyRequest) => {
    const kid = (r.currentUser as typeof r.currentUser & { api_key_id?: string }).api_key_id;
    ensure(!r.apiScopes || kid, 401, 'Brak kontekstu klucza API');
    return { ...r.actor, ...(r.apiScopes ? { apiKeyId: kid } : {}) };
  };
  const gate = (r: FastifyRequest, write = false) => {
    if (write) ensure(!opts.readOnly, 423, 'Kopia jest tylko do odczytu');
    ensure(opts.available, 503, 'Kopia nie zawiera importu tłumaczeń');
    ensure(
      !r.apiScopes ||
        (r.apiScopes.includes('products:read') &&
          (!write || r.apiScopes.includes('products:write'))),
      403,
      'Wymagane scopes products:read' + (write ? ' i products:write' : ''),
    );
  };
  const emptyQuery = (r: FastifyRequest) => z.strictObject({}).parse(r.query);
  const id = (v: unknown) => z.strictObject({ id: z.uuid() }).parse(v).id.toLowerCase();
  const send = (r: FastifyRequest, v: any) => ({
    ...v,
    ...flags,
    can_write: !opts.readOnly && Boolean(v.can_write),
    ...(Array.isArray(v.data)
      ? {
          data: v.data.map((entry: any) =>
            entry && typeof entry === 'object' && 'can_execute' in entry
              ? {
                  ...entry,
                  can_execute: !opts.readOnly && Boolean(v.can_write) && Boolean(entry.can_execute),
                }
              : entry,
          ),
        }
      : {}),
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
    const q = languageFileImportOptionsQuery.parse(r.query);
    if (!opts.available) {
      const ledger = await pool.query(
        "SELECT 1 FROM migrations WHERE name='117_language_file_imports'",
      );
      ensure(!ledger.rowCount, 503, 'Niekompletny moduł importu tłumaczeń');
      const installed = (
        await pool.query("SELECT to_regprocedure('language_file_import_installed()') present")
      ).rows[0].present;
      if (installed)
        ensure(
          !(await pool.query('SELECT language_file_import_installed() installed')).rows[0]
            .installed,
          503,
          'Niekompletny moduł importu tłumaczeń',
        );
      return {
        ...flags,
        current_role: r.actor.role,
        can_read: true,
        can_write: false,
        locales: [],
        can_use_custom_locale: true,
        modes: ['columns', 'translations_json'],
        meta: { cursor: null },
        limits: L,
      };
    }
    return send(r, await languageFileImportOptions(actor(r), q));
  });
  get('/profiles', (r) =>
    languageFileImportProfiles(actor(r), languageFileImportPageQuery.parse(r.query)),
  );
  get('/profiles/:id', (r) => {
    emptyQuery(r);
    return languageFileImportProfileDetail(actor(r), id(r.params));
  });
  post('/profiles', (r) =>
    saveLanguageFileImportProfile(actor(r), languageFileImportProfileInput.parse(r.body)),
  );
  post(
    '/profiles/:id',
    (r) =>
      saveLanguageFileImportProfile(
        actor(r),
        languageFileImportProfileUpdateInput.parse(r.body),
        id(r.params),
      ),
    'patch',
  );
  get('/previews', (r) =>
    languageFileImportHistory(actor(r), languageFileImportPageQuery.parse(r.query), 'preview'),
  );
  post('/previews', (r) => {
    const raw = r.body as { content?: unknown } | null;
    if (raw && typeof raw.content === 'string')
      ensure(Buffer.byteLength(raw.content, 'utf8') <= L.file_bytes, 413, 'Plik przekracza 2 MiB');
    return createLanguageFileImportPreview(actor(r), languageFileImportPreviewInput.parse(r.body));
  });
  get('/previews/:id', (r) => {
    emptyQuery(r);
    return languageFileImportPreviewDetail(actor(r), id(r.params));
  });
  get('/previews/:id/rows', (r) =>
    languageFileImportRows(actor(r), id(r.params), languageFileImportRowsQuery.parse(r.query)),
  );
  post('/previews/:id/execute', (r) =>
    executeLanguageFileImport(actor(r), id(r.params), languageFileImportExecuteInput.parse(r.body)),
  );
  get('/executions', (r) =>
    languageFileImportHistory(actor(r), languageFileImportPageQuery.parse(r.query), 'execution'),
  );
  get('/executions/:id', (r) => {
    emptyQuery(r);
    return languageFileImportExecutionDetail(actor(r), id(r.params));
  });
  get('/executions/:id/rows', (r) =>
    languageFileImportRows(
      actor(r),
      id(r.params),
      languageFileImportRowsQuery.parse(r.query),
      'execution',
    ),
  );
}
