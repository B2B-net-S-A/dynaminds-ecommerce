import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { tenantTx } from './db';
import { ensure } from './errors';
import {
  createSupplierFileSource,
  updateSupplierFileSource,
  previewSupplierFileSource,
  applySupplierFileSource,
  fileSourceDetail,
  filePreviewDetail,
  fileSourceHistory,
  supplierFileSourcesAvailable,
} from './supplier-file-sources';
import {
  sourceCreateInput,
  configUpdateInput,
  previewInput,
  applyInput,
  pageInput,
} from './supplier-file-source-schema';

export function registerSupplierFileSourceRoutes(
  app: FastifyInstance,
  opts: { available: boolean; readOnly: boolean },
) {
  const actor = (r: FastifyRequest) => {
    const key = r.currentUser.api_key_id;
    ensure(!r.apiScopes || key, 401, 'Brak kontekstu klucza API');
    return { ...r.actor, ...(r.apiScopes ? { apiKeyId: key } : {}) };
  };
  const gate = (r: FastifyRequest, write = false, options = false) => {
    if (write) ensure(!opts.readOnly, 423, 'Kopia jest tylko do odczytu');
    if (!options) ensure(opts.available, 503, 'Kopia nie zawiera źródeł plikowych hurtowni');
    ensure(
      !r.apiScopes ||
        (r.apiScopes.includes('purchasing:read') &&
          (!write || r.apiScopes.includes('purchasing:write'))),
      403,
      'Wymagane scopes purchasing:read' + (write ? ' i purchasing:write' : ''),
    );
  };
  const flags = { available: opts.available, read_only: opts.readOnly };
  const send = (v: any) => ({
    ...v,
    ...flags,
    can_write: !opts.readOnly && Boolean(v.can_write),
    ...(v.can_manage !== undefined ? { can_manage: !opts.readOnly && Boolean(v.can_manage) } : {}),
    ...(v.preview
      ? { preview: { ...v.preview, can_apply: !opts.readOnly && Boolean(v.preview.can_apply) } }
      : {}),
  });
  const id = (r: FastifyRequest) =>
    z.strictObject({ id: z.uuid() }).parse(r.params).id.toLowerCase();
  const empty = (r: FastifyRequest) => z.strictObject({}).parse(r.query);
  const read = (path: string, work: (r: FastifyRequest) => Promise<any>) =>
    app.get(path, async (r, reply) => {
      reply.header('Cache-Control', 'no-store');
      gate(r);
      return send(await work(r));
    });
  const write = (
    path: string,
    work: (r: FastifyRequest) => Promise<any>,
    method: 'post' | 'patch' = 'post',
    status = 200,
  ) =>
    app[method](
      path,
      {
        bodyLimit: 6 * 2097152 + 65536,
        onRequest: async (r, reply) => {
          reply.header('Cache-Control', 'no-store');
          gate(r, true);
        },
      },
      async (r, reply) => {
        empty(r);
        return reply.code(status).send(send(await work(r)));
      },
    );
  app.get('/api/supplier-file-sources/options', async (r, reply) => {
    reply.header('Cache-Control', 'no-store');
    empty(r);
    gate(r, false, true);
    const access = opts.available
      ? await tenantTx(r.actor.tenantId, async (c) => {
          ensure(
            await supplierFileSourcesAvailable(c),
            503,
            'Moduł źródeł plikowych jest niekompletny',
          );
          const v = (
            await c.query('SELECT supplier_file_access($1,$2,false,false) result', [
              r.actor.userId,
              actor(r).apiKeyId ?? null,
            ])
          ).rows[0].result;
          ensure(v?.key_valid !== false, 401, 'Klucz API wygasł lub został wycofany');
          ensure(v?.allowed, 403, 'Brak aktualnej roli lub scopes zakupów');
          return { current_role: v.role, can_read: true, can_write: Boolean(v.can_write) };
        })
      : { current_role: r.actor.role, can_read: false, can_write: false };
    return send({
      ...access,
      limits: {
        file_bytes: 2097152,
        rows: 500,
        source_items: 10000,
        preview_bytes: 8388608,
        retained_evidence_bytes: 33554432,
      },
    });
  });
  write(
    '/api/supplier-file-sources',
    (r) =>
      tenantTx(r.actor.tenantId, (c) =>
        createSupplierFileSource(c, actor(r), sourceCreateInput.parse(r.body)),
      ),
    'post',
    201,
  );
  read('/api/supplier-file-sources/:id', (r) => {
    empty(r);
    return tenantTx(r.actor.tenantId, (c) => fileSourceDetail(c, actor(r), id(r)));
  });
  write(
    '/api/supplier-file-sources/:id',
    (r) =>
      tenantTx(r.actor.tenantId, (c) =>
        updateSupplierFileSource(c, actor(r), id(r), configUpdateInput.parse(r.body)),
      ),
    'patch',
  );
  write(
    '/api/supplier-file-sources/:id/previews',
    (r) =>
      tenantTx(r.actor.tenantId, (c) =>
        previewSupplierFileSource(c, actor(r), id(r), previewInput.parse(r.body)),
      ),
    'post',
    201,
  );
  read('/api/supplier-file-previews/:id', (r) => {
    empty(r);
    return tenantTx(r.actor.tenantId, (c) => filePreviewDetail(c, actor(r), id(r)));
  });
  write('/api/supplier-file-previews/:id/apply', (r) =>
    tenantTx(r.actor.tenantId, (c) =>
      applySupplierFileSource(c, actor(r), id(r), applyInput.parse(r.body)),
    ),
  );
  read('/api/supplier-file-sources/:id/history', (r) =>
    tenantTx(r.actor.tenantId, (c) =>
      fileSourceHistory(c, actor(r), id(r), pageInput.parse(r.query)),
    ),
  );
}
