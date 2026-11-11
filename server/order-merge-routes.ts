import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ensure } from './errors';
import * as M from './order-merges';
import { captureOrderMergeBuyerAddressActor } from './buyer-address';
const params = z.strictObject({ id: z.uuid().transform((v) => v.toLowerCase()) });
const empty = z.strictObject({});
export function registerOrderMergeRoutes(
  app: FastifyInstance,
  opts: { available: boolean; readOnly: boolean; sessionName: string; service?: typeof M },
) {
  const service = opts.service ?? M;
  const actor = (req: FastifyRequest, write = false) => {
    const scopes = [
      'orders:read',
      'inventory:read',
      ...(write ? ['orders:write', 'inventory:write'] : []),
    ];
    ensure(
      !req.apiScopes || scopes.every((s) => req.apiScopes!.includes(s)),
      403,
      'Wymagane scope: ' + scopes.join(', '),
    );
    const key = req.currentUser?.api_key_id;
    ensure(!req.apiScopes || typeof key === 'string', 401, 'Brak kontekstu klucza API');
    const current = { ...req.actor, ...(req.apiScopes ? { apiKeyId: key } : {}) };
    return write
      ? captureOrderMergeBuyerAddressActor({
          actor: current,
          currentUser: req.currentUser,
          headers: req.headers,
          cookies: req.cookies,
        }, opts.sessionName)
      : current;
  };
  const write = (req: FastifyRequest) => {
    ensure(!opts.readOnly, 423, 'Ta kopia jest tylko do odczytu');
    ensure(opts.available, 503, 'Łączenie zamówień jest niedostępne w tej kopii');
    return actor(req, true);
  };
  const readable = () =>
    ensure(opts.available, 503, 'Łączenie zamówień jest niedostępne w tej kopii');
  const response = (r: Record<string, any>) => ({
    ...r,
    read_only: opts.readOnly,
    can_preview: !opts.readOnly && r.can_preview === true,
    can_execute: !opts.readOnly && r.can_execute === true,
  });
  const p = '/api/order-merges';
  app.get(p + '/commands/:id', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    readable();
    const {operation} = z.strictObject({operation: z.enum(['preview', 'execute'])}).parse(req.query);
    return response(await service.orderMergeOriginalCommand(actor(req), params.parse(req.params).id, operation));
  });
  app.get(p + '/options', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    empty.parse(req.query);
    return response(await M.orderMergeOptions(actor(req)));
  });
  const writeOptions = {
    bodyLimit: M.ORDER_MERGE_LIMITS.request_bytes,
    onRequest: async (req: FastifyRequest) => {
      write(req);
    },
  };
  app.post(p + '/previews', writeOptions, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    empty.parse(req.query);
    const r = await M.createOrderMergePreview(write(req), M.orderMergePreviewInput.parse(req.body));
    return reply.code(r.reused ? 200 : 201).send(response(r));
  });
  app.post(p + '/execute', writeOptions, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    empty.parse(req.query);
    const r = await M.executeOrderMerge(write(req), M.orderMergeExecuteInput.parse(req.body));
    return reply.code(r.reused ? 200 : 201).send(response(r));
  });
  for (const kind of ['previews', 'executions'] as const) {
    app.get(p + '/' + kind + '/:id', async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      readable();
      empty.parse(req.query);
      const id = params.parse(req.params).id;
      return response(
        await (kind === 'previews' ? M.orderMergePreviewDetail : M.orderMergeExecutionDetail)(
          actor(req),
          id,
        ),
      );
    });
    for (const type of ['rows', 'sources', 'physical'] as const) {
      const fn =
        kind === 'previews'
          ? type === 'rows'
            ? M.orderMergePreviewRows
            : type === 'sources'
              ? M.orderMergePreviewSources
              : M.orderMergePreviewPhysical
          : type === 'rows'
            ? M.orderMergeExecutionRows
            : type === 'sources'
              ? M.orderMergeExecutionSources
              : M.orderMergeExecutionPhysical;
      app.get(p + '/' + kind + '/:id/' + type, async (req, reply) => {
        reply.header('Cache-Control', 'no-store');
        readable();
        return response(
          await fn(actor(req), params.parse(req.params).id, M.orderMergePageQuery.parse(req.query)),
        );
      });
    }
  }
  app.get(p + '/history', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    readable();
    return response(
      await M.orderMergeHistory(actor(req), M.orderMergeHistoryQuery.parse(req.query)),
    );
  });
  app.get(p + '/orders/:id/lineage', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    readable();
    empty.parse(req.query);
    return response(await M.orderMergeLineage(actor(req), params.parse(req.params).id));
  });
}
