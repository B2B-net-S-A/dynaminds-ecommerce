import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ensure } from './errors';
import {
  orderFieldBatchPreviewSchema,
  orderFieldBatchQueueSchema,
  orderFieldBatchCancelSchema,
  orderFieldBatchHistorySchema,
  orderFieldBatchRowsPageSchema,
  orderFieldBatchExportSchema,
} from './order-field-batches-schema';
import {
  orderFieldBatchMetadata,
  createOrderFieldBatchPreview,
  orderFieldBatchPreviewDetail,
  orderFieldBatchHistory,
  queueOrderFieldBatch,
  orderFieldBatchExecutionDetail,
  cancelOrderFieldBatch,
  exportOrderFieldBatch,
} from './order-field-batches';
export function registerOrderFieldBatchRoutes(
  app: FastifyInstance,
  opts: { available: boolean; readOnly: boolean },
) {
  const scopes = (req: FastifyRequest, write = false) =>
    ensure(
      !req.apiScopes ||
        (req.apiScopes.includes('order-fields:read') &&
          (!write || req.apiScopes.includes('order-fields:write'))),
      403,
      'Wymagane scopes order-fields:read' + (write ? ' i order-fields:write' : ''),
    );
  const flags = { available: opts.available, read_only: opts.readOnly };
  const response = (result: any) => ({
    ...flags,
    ...result,
    can_write:
      !opts.readOnly &&
      result.can_write !== false &&
      ['admin', 'operator'].includes(result.current_role),
  });
  const missing = () => ({ ...flags, can_write: false, data: [], meta: { cursor: null } });
  const write = (req: FastifyRequest) => {
    ensure(!opts.readOnly, 423, 'Kopia jest tylko do odczytu');
    ensure(opts.available, 503, 'Kopia nie zawiera zbiorczych pól zamówień');
    scopes(req, true);
  };
  const id = (params: unknown) => z.strictObject({ id: z.uuid() }).parse(params).id;
  app.get('/api/order-field-batches', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    scopes(req);
    if (!opts.available) return missing();
    return response(await orderFieldBatchMetadata(req.actor));
  });
  for (const kind of ['previews', 'executions'] as const)
    app.get('/api/order-field-batches/' + kind, async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      scopes(req);
      if (!opts.available) return missing();
      return response(
        await orderFieldBatchHistory(
          req.actor,
          kind,
          orderFieldBatchHistorySchema.parse(req.query).cursor,
        ),
      );
    });
  app.post(
    '/api/order-field-batches/previews',
    { bodyLimit: 7100000, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req, reply) => {
      write(req);
      const result = await createOrderFieldBatchPreview(
        req.actor,
        orderFieldBatchPreviewSchema.parse(req.body),
        req.apiScopes ? 'api' : 'manual',
      );
      return reply.code(result.reused ? 200 : 201).send(response(result));
    },
  );
  app.get('/api/order-field-batches/previews/:id', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    scopes(req);
    if (!opts.available) return missing();
    return response(
      await orderFieldBatchPreviewDetail(
        req.actor,
        id(req.params),
        orderFieldBatchRowsPageSchema.parse(req.query).cursor,
      ),
    );
  });
  app.post(
    '/api/order-field-batches/previews/:id/queue',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req, reply) => {
      write(req);
      const result = await queueOrderFieldBatch(
        req.actor,
        id(req.params),
        orderFieldBatchQueueSchema.parse(req.body),
        req.apiScopes ? 'api' : 'manual',
      );
      return reply.code(result.reused ? 200 : 201).send({ ...flags, ...result });
    },
  );
  app.get('/api/order-field-batches/executions/:id', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    scopes(req);
    if (!opts.available) return missing();
    return response(await orderFieldBatchExecutionDetail(req.actor, id(req.params)));
  });
  app.post('/api/order-field-batches/executions/:id/cancel', async (req) => {
    write(req);
    orderFieldBatchCancelSchema.parse(req.body);
    return { ...flags, ...(await cancelOrderFieldBatch(req.actor, id(req.params))) };
  });
  app.get('/api/order-field-batches/export', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    scopes(req);
    ensure(opts.available, 503, 'Kopia nie zawiera zbiorczych pól zamówień');
    return response(
      await exportOrderFieldBatch(req.actor, orderFieldBatchExportSchema.parse(req.query)),
    );
  });
}
