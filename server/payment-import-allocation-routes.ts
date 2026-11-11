import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ensure } from './errors';
import {
  paymentImportAllocationsAvailable,
  paymentImportAllocationOptions,
  createPaymentImportAllocationPreview,
  executePaymentImportAllocation,
  paymentImportAllocationPreviewDetail,
  paymentImportAllocationExecutionDetail,
  paymentImportAllocationHistory,
  allocationOptionsQuery,
  allocationPageQuery,
  allocationPreviewInput,
  allocationExecuteInput,
} from './payment-import-allocations';
import { pool } from './db';
export function registerPaymentImportAllocationRoutes(
  app: FastifyInstance,
  opts: { available: boolean; readOnly: boolean },
) {
  const root = '/api/payment-import-allocations';
  const id = (p: unknown) =>
    z.strictObject({ id: z.uuid().transform((v) => v.toLowerCase()) }).parse(p).id;
  const actor = (req: any) => ({ ...req.actor, apiKeyId: req.apiKeyId ?? req.actor.apiKeyId });
  const send = (v: any) => ({
    ...v,
    read_only: opts.readOnly,
    can_write: !opts.readOnly && v.can_write,
    ...(v.preview
      ? { preview: { ...v.preview, can_execute: !opts.readOnly && v.preview.can_execute } }
      : {}),
  });
  const writable = async () => {
    ensure(!opts.readOnly, 423, 'Kopia jest tylko do odczytu');
    ensure(
      opts.available && (await paymentImportAllocationsAvailable(pool)),
      503,
      'Kopia nie zawiera pełnego podziału wpłat',
    );
  };
  const noQuery = (q: unknown) => z.strictObject({}).parse(q);
  // Reject write attempts before parsing a malformed body in recovery previews.
  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0].replace(/^\/api\/v1\//, '/api/');
    if (path === root || path.startsWith(root + '/')) {
      reply.header('cache-control', 'no-store');
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) await writable();
    }
  });
  app.get(root + '/options', async (req) =>
    send(await paymentImportAllocationOptions(actor(req), allocationOptionsQuery.parse(req.query))),
  );
  app.post(root + '/previews', async (req, reply) => {
    noQuery(req.query);
    const v = await createPaymentImportAllocationPreview(
      actor(req),
      allocationPreviewInput.parse(req.body),
    );
    reply.code(v.reused ? 200 : 201);
    return send(v);
  });
  app.get(root + '/previews/:id', async (req) => {
    noQuery(req.query);
    return send(await paymentImportAllocationPreviewDetail(actor(req), id(req.params)));
  });
  app.post(root + '/previews/:id/execute', async (req, reply) => {
    noQuery(req.query);
    const v = await executePaymentImportAllocation(
      actor(req),
      id(req.params),
      allocationExecuteInput.parse(req.body),
    );
    reply.code(v.reused ? 200 : 201);
    return send(v);
  });
  app.get(root + '/executions/:id', async (req) => {
    noQuery(req.query);
    return send(await paymentImportAllocationExecutionDetail(actor(req), id(req.params)));
  });
  app.get(root + '/history', async (req) =>
    send(await paymentImportAllocationHistory(actor(req), allocationPageQuery.parse(req.query))),
  );
}
