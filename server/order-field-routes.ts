import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ensure } from './errors';
import {
  orderFieldDefinitionSchema,
  orderFieldDefinitionPatchSchema,
  orderFieldDisableSchema,
  orderFieldPatchSchema,
  orderFieldFileSchema,
  orderFieldHistorySchema,
} from './order-fields-schema';
import {
  listOrderFields,
  createOrderField,
  editOrderField,
  disableOrderField,
  getOrderFields,
  patchOrderFields,
  orderFieldHistory,
  uploadOrderFieldFile,
  downloadOrderFieldFile,
} from './order-fields';
export function registerOrderFieldRoutes(
  app: FastifyInstance,
  opts: { available: boolean; readOnly: boolean },
) {
  const scope = (req: FastifyRequest, kind: 'read' | 'write' | 'admin') => {
    const scopes = (req as FastifyRequest & { apiScopes?: string[] }).apiScopes;
    ensure(
      !scopes || scopes.includes('order-fields:' + kind),
      403,
      'Brak scope order-fields:' + kind,
    );
  };
  const id = (value: unknown) => z.strictObject({ id: z.uuid() }).parse(value).id;
  const flags = { available: opts.available, read_only: opts.readOnly };
  const missing = () => ({
    ...flags,
    data: [],
    meta: { cursor: null },
    can_admin: false,
    can_write: false,
  });
  const readResult = (result: any) => ({
    ...flags,
    ...result,
    can_write: !opts.readOnly && ['admin', 'operator'].includes(result.current_role),
    ...(Object.hasOwn(result, 'can_admin')
      ? { can_admin: !opts.readOnly && result.can_admin }
      : {}),
    ...(opts.readOnly
      ? {
          data: result.data?.map((item: any) =>
            item.definition
              ? { ...item, definition: { ...item.definition, can_write: false } }
              : Object.hasOwn(item, 'can_write')
                ? { ...item, can_write: false }
                : item,
          ),
        }
      : {}),
  });
  const write = (req: FastifyRequest, kind: 'write' | 'admin') => {
    ensure(!opts.readOnly, 423, 'Kopia jest tylko do odczytu');
    ensure(opts.available, 503, 'Kopia nie zawiera dodatkowych pól zamówień');
    scope(req, kind);
  };
  app.get('/api/order-fields', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    scope(req, 'read');
    if (!opts.available) return missing();
    return readResult(await listOrderFields(req.actor));
  });
  app.post(
    '/api/order-fields',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req, reply) => {
      write(req, 'admin');
      const result = await createOrderField(req.actor, orderFieldDefinitionSchema.parse(req.body));
      return reply.code(result.reused ? 200 : 201).send({ ...flags, ...result });
    },
  );
  app.patch('/api/order-fields/:id', async (req) => {
    write(req, 'admin');
    return {
      ...flags,
      ...(await editOrderField(
        req.actor,
        id(req.params),
        orderFieldDefinitionPatchSchema.parse(req.body),
      )),
    };
  });
  app.delete('/api/order-fields/:id', async (req) => {
    write(req, 'admin');
    return {
      ...flags,
      ...(await disableOrderField(
        req.actor,
        id(req.params),
        orderFieldDisableSchema.parse(req.body).version,
      )),
    };
  });
  app.get('/api/orders/:id/fields', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    scope(req, 'read');
    if (!opts.available) return missing();
    return readResult(await getOrderFields(req.actor, id(req.params)));
  });
  app.patch(
    '/api/orders/:id/fields',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (req) => {
      write(req, 'write');
      const result = await patchOrderFields(
        req.actor,
        id(req.params),
        orderFieldPatchSchema.parse(req.body),
        req.apiScopes ? 'api' : 'manual',
      );
      if (req.apiScopes && !req.apiScopes.includes('order-fields:read')) {
        const { data, ...head } = result;
        return { ...flags, ...head };
      }
      return { ...flags, ...result };
    },
  );
  app.get('/api/orders/:id/fields/history', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    scope(req, 'read');
    if (!opts.available) return missing();
    return readResult(
      await orderFieldHistory(
        req.actor,
        id(req.params),
        orderFieldHistorySchema.parse(req.query).cursor,
      ),
    );
  });
  app.post(
    '/api/order-field-files',
    { bodyLimit: 7100000, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      write(req, 'write');
      const result = await uploadOrderFieldFile(req.actor, orderFieldFileSchema.parse(req.body));
      return reply.code(result.reused ? 200 : 201).send({ ...flags, ...result });
    },
  );
  app.get(
    '/api/order-field-files/:id/download',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (req, reply) => {
      scope(req, 'read');
      ensure(opts.available, 503, 'Kopia nie zawiera dodatkowych pól zamówień');
      const file = await downloadOrderFieldFile(req.actor, id(req.params));
      return reply
        .header('Cache-Control', 'no-store')
        .header('X-Content-Type-Options', 'nosniff')
        .header('Content-Type', file.mime_type)
        .header(
          'Content-Disposition',
          `attachment; filename="attachment"; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
        )
        .send(file.bytes);
    },
  );
}
