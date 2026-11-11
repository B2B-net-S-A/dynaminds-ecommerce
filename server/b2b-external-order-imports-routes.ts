import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ensure } from './errors';
import { withAllegroRequestContext, type IntegrationContext } from './channel-access';
import * as M from './b2b-external-order-imports';
import * as S from './b2b-external-order-imports-schema';
const params = z.strictObject({ id: z.uuid().transform((v) => v.toLowerCase()) });
export function registerB2bExternalOrderImportRoutes(
  app: FastifyInstance,
  opts: { available: boolean; readOnly: boolean },
  context: IntegrationContext = {},
) {
  const actor = (r: FastifyRequest, write = false) => {
    const scopes = [
      'integrations:read',
      'products:read',
      'inventory:read',
      'orders:read',
      'purchasing:read',
      ...(write
        ? ['integrations:write', 'inventory:write', 'orders:write', 'purchasing:write']
        : []),
    ];
    ensure(
      !r.apiScopes || scopes.every((s) => r.apiScopes!.includes(s)),
      403,
      'Brak wymaganych uprawnień importu',
    );
    const apiKeyId = r.currentUser?.api_key_id;
    ensure(!r.apiScopes || typeof apiKeyId === 'string', 401, 'Brak kontekstu klucza');
    return { ...r.actor, ...(r.apiScopes ? { apiKeyId } : {}) };
  };
  const writable = (r: FastifyRequest) => {
    ensure(!opts.readOnly, 423, 'Ta kopia jest tylko do odczytu');
    ensure(opts.available, 503, 'Źródłowa intencja nie jest dostępna');
    return actor(r, true);
  };
  const send = (p: any, b: any) => {
    p.header('Cache-Control', 'no-store');
    if (b.preview) b.preview.can_execute = b.preview.can_execute && !opts.readOnly;
    if (b.data) for (const h of b.data) h.can_execute = h.can_execute && !opts.readOnly;
    return { ...b, read_only: opts.readOnly, can_manage: b.can_manage && !opts.readOnly };
  };
  app.get('/api/imports/:id/external-intent-source', async (r, p) => {
    z.strictObject({}).parse(r.query);
    return send(p, await M.b2bExternalImportSource(actor(r), params.parse(r.params).id));
  });
  app.post('/api/imports/:id/external-intent-previews', { bodyLimit: 65536 }, async (r, p) => {
    const a = writable(r);
    const result = await M.createB2bExternalImportPreview(
      a,
      params.parse(r.params).id,
      S.b2bExternalImportPreviewInput.parse(r.body),
    );
    p.code(result.reused ? 200 : 201);
    return send(p, result);
  });
  app.get('/api/import-external-intent-previews', async (r, p) =>
    send(
      p,
      await M.b2bExternalImportHistory(actor(r), S.b2bExternalImportPageQuery.parse(r.query)),
    ),
  );
  app.get('/api/import-external-intent-previews/:id', async (r, p) => {
    z.strictObject({}).parse(r.query);
    return send(p, await M.b2bExternalImportPreviewDetail(actor(r), params.parse(r.params).id));
  });
  app.post(
    '/api/import-external-intent-previews/:id/execute',
    { bodyLimit: 65536 },
    async (r, p) => {
      const a = writable(r);
      const result = await M.executeB2bExternalImport(
        a,
        params.parse(r.params).id,
        S.b2bExternalImportExecuteInput.parse(r.body),
        withAllegroRequestContext(context, r),
      );
      p.code(result.reused ? 200 : 201);
      return send(p, result);
    },
  );
}
