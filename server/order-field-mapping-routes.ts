import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ensure } from './errors';
import type { IntegrationContext } from './channel-access';
import {
  orderFieldMappingProfileSchema,
  orderFieldMappingProfilePatchSchema,
  orderFieldMappingPreviewSchema,
  orderFieldMappingImportSchema,
  orderFieldMappingQueueSchema,
  orderFieldMappingHistorySchema,
  orderFieldMappingSourcesQuerySchema,
  orderFieldMappingCancelSchema,
} from './order-field-mappings-schema';
import {
  orderFieldMappingMetadata,
  saveOrderFieldMappingProfile,
  orderFieldMappingProfiles,
  orderFieldMappingProfileDetail,
  orderFieldMappingSources,
  orderFieldMappingSourceDetail,
  createOrderFieldMappingPreview,
  orderFieldMappingPreviewDetail,
  orderFieldMappingHistory,
  queueOrderFieldMapping,
  orderFieldMappingExecutionDetail,
  cancelOrderFieldMapping,
} from './order-field-mappings';
import { importMappedOrder } from './order-field-mappings-initial';
export function registerOrderFieldMappingRoutes(
  app: FastifyInstance,
  opts: { available: boolean; readOnly: boolean; context?: IntegrationContext },
) {
  const prefix = '/api/order-field-mappings',
    flags = { available: opts.available, read_only: opts.readOnly };
  const response = (data: any, req?: FastifyRequest) => {
    const s = req?.apiScopes;
    return {
      ...flags,
      ...data,
      can_admin:
        !opts.readOnly &&
        !!data.can_admin &&
        (!s || (s.includes('order-fields:read') && s.includes('order-fields:admin'))),
      can_import:
        !opts.readOnly &&
        !!data.can_import &&
        (!s ||
          (s.includes('order-fields:read') &&
            s.includes('order-fields:write') &&
            s.includes('orders:write'))),
      can_reconcile:
        !opts.readOnly &&
        !!data.can_reconcile &&
        (!s || (s.includes('order-fields:read') && s.includes('order-fields:write'))),
    };
  };
  const missing = () => ({
    ...flags,
    can_admin: false,
    can_import: false,
    can_reconcile: false,
    data: [],
    meta: { cursor: null },
  });
  const scopes = (r: FastifyRequest, kind: 'read' | 'write' | 'admin' | 'import' = 'read') =>
    ensure(
      !r.apiScopes ||
        (r.apiScopes.includes('order-fields:read') &&
          (kind === 'read' ||
            r.apiScopes.includes(kind === 'admin' ? 'order-fields:admin' : 'order-fields:write')) &&
          (kind !== 'import' || r.apiScopes.includes('orders:write'))),
      403,
      'Wymagane scopes pól i właściwej operacji',
    );
  const write = (r: FastifyRequest, kind: 'write' | 'admin' | 'import' = 'write') => {
    ensure(!opts.readOnly, 423, 'Kopia jest tylko do odczytu');
    ensure(opts.available, 503, 'Kopia nie zawiera mapowań pól');
    scopes(r, kind);
  };
  const id = (params: unknown) => z.strictObject({ id: z.uuid() }).parse(params).id;
  app.get(prefix + '/metadata', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    scopes(req);
    return opts.available ? response(await orderFieldMappingMetadata(req.actor), req) : missing();
  });
  app.get(prefix + '/profiles', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    scopes(req);
    return opts.available
      ? response(
          await orderFieldMappingProfiles(
            req.actor,
            orderFieldMappingHistorySchema.parse(req.query).cursor,
          ),
          req,
        )
      : missing();
  });
  app.post(prefix + '/profiles', async (req, reply) => {
    write(req, 'admin');
    reply.header('Cache-Control', 'no-store');
    const result = await saveOrderFieldMappingProfile(
      req.actor,
      orderFieldMappingProfileSchema.parse(req.body),
    );
    return reply.code(result.reused ? 200 : 201).send(response(result, req));
  });
  app.get(prefix + '/profiles/:id', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    scopes(req);
    return opts.available
      ? response(await orderFieldMappingProfileDetail(req.actor, id(req.params)), req)
      : missing();
  });
  app.patch(prefix + '/profiles/:id', async (req, reply) => {
    write(req, 'admin');
    reply.header('Cache-Control', 'no-store');
    return response(
      await saveOrderFieldMappingProfile(
        req.actor,
        orderFieldMappingProfilePatchSchema.parse(req.body),
        id(req.params),
      ),
      req,
    );
  });
  app.get(prefix + '/profiles/:id/revisions', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    scopes(req);
    return opts.available
      ? response(
          await orderFieldMappingProfiles(
            req.actor,
            orderFieldMappingHistorySchema.parse(req.query).cursor,
            id(req.params),
          ),
          req,
        )
      : missing();
  });
  app.get(prefix + '/sources', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    scopes(req);
    if (!opts.available) return missing();
    const q = orderFieldMappingSourcesQuerySchema.parse(req.query);
    return response(await orderFieldMappingSources(req.actor, q.channel_id, q.cursor), req);
  });
  app.get(prefix + '/sources/:id', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    scopes(req);
    return opts.available
      ? response(await orderFieldMappingSourceDetail(req.actor, id(req.params)), req)
      : missing();
  });
  for (const kind of ['previews', 'executions'] as const)
    app.get(prefix + '/' + kind, async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      scopes(req);
      return opts.available
        ? response(
            await orderFieldMappingHistory(
              req.actor,
              kind,
              orderFieldMappingHistorySchema.parse(req.query).cursor,
            ),
            req,
          )
        : missing();
    });
  app.post(
    prefix + '/previews',
    { bodyLimit: 1048576, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req, reply) => {
      write(req);
      reply.header('Cache-Control', 'no-store');
      const result = await createOrderFieldMappingPreview(
        req.actor,
        orderFieldMappingPreviewSchema.parse(req.body),
        req.apiScopes ? 'api' : 'manual',
      );
      return reply.code(result.reused ? 200 : 201).send(response(result, req));
    },
  );
  app.get(prefix + '/previews/:id', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    scopes(req);
    return opts.available
      ? response(
          await orderFieldMappingPreviewDetail(
            req.actor,
            id(req.params),
            orderFieldMappingHistorySchema.parse(req.query).cursor,
          ),
          req,
        )
      : missing();
  });
  app.post(
    prefix + '/previews/:id/import',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req, reply) => {
      write(req, 'import');
      reply.header('Cache-Control', 'no-store');
      const result = await importMappedOrder(
        req.actor,
        id(req.params),
        orderFieldMappingImportSchema.parse(req.body),
        req.apiScopes ? 'api' : 'manual',
        opts.context,
      );
      return reply
        .code(result.reused ? 200 : 201)
        .send(
          response(
            {
              ...result,
              current_role: 'admin',
              can_admin: true,
              can_import: true,
              can_reconcile: true,
            },
            req,
          ),
        );
    },
  );
  app.post(
    prefix + '/previews/:id/queue',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req, reply) => {
      write(req);
      reply.header('Cache-Control', 'no-store');
      const result = await queueOrderFieldMapping(
        req.actor,
        id(req.params),
        orderFieldMappingQueueSchema.parse(req.body),
        req.apiScopes ? 'api' : 'manual',
      );
      return reply.code(result.reused ? 200 : 201).send(response(result, req));
    },
  );
  app.get(prefix + '/executions/:id', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    scopes(req);
    return opts.available
      ? response(await orderFieldMappingExecutionDetail(req.actor, id(req.params)), req)
      : missing();
  });
  app.post(prefix + '/executions/:id/cancel', async (req, reply) => {
    write(req);
    reply.header('Cache-Control', 'no-store');
    orderFieldMappingCancelSchema.parse(req.body);
    return response(await cancelOrderFieldMapping(req.actor, id(req.params)), req);
  });
}
