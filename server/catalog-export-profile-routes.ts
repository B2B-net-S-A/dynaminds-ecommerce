import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ensure } from './errors';
import {
  catalogExportProfileCreateInput,
  catalogExportProfilePatchInput,
  catalogExportProfileVersionInput,
  catalogExportProfiles,
  catalogExportProfileDetail,
  createCatalogExportProfile,
  patchCatalogExportProfile,
  setCatalogExportProfileArchived,
} from './catalog-export-profiles';
export {
  catalogExportProfileCreateInput,
  catalogExportProfilePatchInput,
  catalogExportProfileVersionInput,
} from './catalog-export-profiles';
const empty = z.strictObject({});
const params = z.strictObject({ id: z.uuid().transform((v) => v.toLowerCase()) });
export function registerCatalogExportProfileRoutes(
  app: FastifyInstance,
  opts: { available: boolean; readOnly: boolean },
) {
  const actor = (req: FastifyRequest, write = false) => {
    ensure(
      !req.apiScopes || req.apiScopes.includes('products:read'),
      403,
      'Wymagany scope products:read',
    );
    ensure(
      !write || !req.apiScopes || req.apiScopes.includes('products:write'),
      403,
      'Wymagany scope products:write',
    );
    const apiKeyId = req.currentUser?.api_key_id;
    ensure(
      !req.apiScopes || typeof apiKeyId === 'string',
      401,
      'Brak aktualnego kontekstu klucza API',
    );
    return { ...req.actor, ...(req.apiScopes ? { apiKeyId } : {}) };
  };
  const writable = (req: FastifyRequest) => {
    ensure(!opts.readOnly, 423, 'Ta kopia jest tylko do odczytu');
    ensure(opts.available, 503, 'Profile eksportu nie są dostępne w tej kopii');
    return actor(req, true);
  };
  const response = <T extends { can_manage: boolean }>(req: FastifyRequest, data: T) => ({
    ...data,
    read_only: opts.readOnly,
    can_manage:
      data.can_manage &&
      !opts.readOnly &&
      (!req.apiScopes || req.apiScopes.includes('products:write')),
  });
  app.get('/api/catalog/export-profiles', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    empty.parse(req.query);
    return response(req, await catalogExportProfiles(actor(req)));
  });
  app.get('/api/catalog/export-profiles/:id', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    empty.parse(req.query);
    return response(req, await catalogExportProfileDetail(actor(req), params.parse(req.params).id));
  });
  app.post('/api/catalog/export-profiles', { bodyLimit: 65536 }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const a = writable(req);
    empty.parse(req.query);
    const result = await createCatalogExportProfile(
      a,
      catalogExportProfileCreateInput.parse(req.body),
    );
    reply.code(result.reused ? 200 : 201);
    return response(req, result);
  });
  app.patch('/api/catalog/export-profiles/:id', { bodyLimit: 65536 }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const a = writable(req);
    empty.parse(req.query);
    return response(
      req,
      await patchCatalogExportProfile(
        a,
        params.parse(req.params).id,
        catalogExportProfilePatchInput.parse(req.body),
      ),
    );
  });
  for (const operation of ['archive', 'restore'] as const)
    app.post(
      '/api/catalog/export-profiles/:id/' + operation,
      { bodyLimit: 65536 },
      async (req, reply) => {
        reply.header('Cache-Control', 'no-store');
        const a = writable(req);
        empty.parse(req.query);
        return response(
          req,
          await setCatalogExportProfileArchived(
            a,
            params.parse(req.params).id,
            catalogExportProfileVersionInput.parse(req.body),
            operation === 'archive',
          ),
        );
      },
    );
}
