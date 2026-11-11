import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { tenantTx } from './db';
import { ensure } from './errors';
import {
  getSupplierRemote,
  updateSupplierRemote,
  queueSupplierRemoteFetch,
  supplierRemoteFetchHistory,
  supplierRemoteFetchDetail,
  getSupplierFeedSchedule,
  updateSupplierFeedSchedule,
} from './supplier-remote-feeds';
import {
  supplierRemoteUpdateInput,
  supplierRemoteFetchInput,
  supplierFeedScheduleInput,
  supplierRemotePageInput,
} from './supplier-remote-schema';

export function registerSupplierRemoteRoutes(
  app: FastifyInstance,
  opts: { available: boolean; readOnly: boolean },
) {
  const actor = (r: FastifyRequest) => {
    const key = r.currentUser.api_key_id;
    ensure(!r.apiScopes || key, 401, 'Brak kontekstu klucza API');
    return { ...r.actor, ...(r.apiScopes ? { apiKeyId: key } : {}) };
  };
  const gate = (r: FastifyRequest, write = false, legacyRemote = false) => {
    if (write) ensure(!opts.readOnly, 423, 'Kopia jest tylko do odczytu');
    if (!legacyRemote) ensure(opts.available, 503, 'Kopia nie zawiera zdalnych feedów hurtowni');
    ensure(
      !r.apiScopes ||
        (r.apiScopes.includes('purchasing:read') &&
          (!write || r.apiScopes.includes('purchasing:write'))),
      403,
      'Wymagane scopes purchasing:read' + (write ? ' i purchasing:write' : ''),
    );
  };
  const send = (v: any) => ({
    ...v,
    read_only: opts.readOnly,
    can_manage: !opts.readOnly && Boolean(v.can_manage),
    can_fetch: !opts.readOnly && Boolean(v.can_fetch),
    can_enable_schedule: !opts.readOnly && Boolean(v.can_enable_schedule),
  });
  const id = (r: FastifyRequest) =>
    z.strictObject({ id: z.uuid() }).parse(r.params).id.toLowerCase();
  const empty = (r: FastifyRequest) => z.strictObject({}).parse(r.query);
  const read = (
    path: string,
    work: (r: FastifyRequest) => Promise<unknown>,
    legacyRemote = false,
  ) =>
    app.get(
      path,
      {
        onRequest: async (r, reply) => {
          reply.header('Cache-Control', 'no-store');
          gate(r, false, legacyRemote);
        },
      },
      async (r) => send(await work(r)),
    );
  const write = (
    method: 'POST' | 'PATCH',
    path: string,
    work: (r: FastifyRequest) => Promise<unknown>,
  ) =>
    app.route({
      method,
      url: path,
      onRequest: async (r, reply) => {
        reply.header('Cache-Control', 'no-store');
        gate(r, true);
      },
      handler: async (r) => send(await work(r)),
    });
  read(
    '/api/supplier-file-sources/:id/remote',
    async (r) => {
      empty(r);
      return tenantTx(r.actor.tenantId, (c) => getSupplierRemote(c, actor(r), id(r)));
    },
    true,
  );
  write('PATCH', '/api/supplier-file-sources/:id/remote', async (r) => {
    empty(r);
    const b = supplierRemoteUpdateInput.parse(r.body);
    return tenantTx(r.actor.tenantId, (c) => updateSupplierRemote(c, actor(r), id(r), b));
  });
  write('POST', '/api/supplier-file-sources/:id/fetches', async (r) => {
    empty(r);
    const b = supplierRemoteFetchInput.parse(r.body);
    return tenantTx(r.actor.tenantId, (c) => queueSupplierRemoteFetch(c, actor(r), id(r), b));
  });
  read('/api/supplier-file-sources/:id/fetches', (r) => {
    const page = supplierRemotePageInput.parse(r.query);
    return tenantTx(r.actor.tenantId, (c) => supplierRemoteFetchHistory(c, actor(r), id(r), page));
  });
  read('/api/supplier-file-fetches/:id', async (r) => {
    empty(r);
    return tenantTx(r.actor.tenantId, (c) => supplierRemoteFetchDetail(c, actor(r), id(r)));
  });
  read('/api/supplier-file-sources/:id/feed-schedule', async (r) => {
    empty(r);
    return tenantTx(r.actor.tenantId, (c) => getSupplierFeedSchedule(c, actor(r), id(r)));
  });
  write('PATCH', '/api/supplier-file-sources/:id/feed-schedule', async (r) => {
    empty(r);
    const b = supplierFeedScheduleInput.parse(r.body);
    return tenantTx(r.actor.tenantId, (c) => updateSupplierFeedSchedule(c, actor(r), id(r), b));
  });
}
