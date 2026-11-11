import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from './db';
import { ensure } from './errors';
import {
  proformaBatchesAvailable,
  previewProformaBatch,
  issueProformaBatch,
  proformaBatchPreviewDetail,
  proformaBatchExecutionDetail,
  proformaBatchHistory,
} from './proforma-batches';
import {
  proformaBatchPreviewInput,
  proformaBatchIssueInput,
  proformaBatchHistoryQuery,
} from './proforma-batch-values';

export function registerProformaBatchRoutes(
  app: FastifyInstance,
  opts: { available: boolean; readOnly: boolean },
) {
  const root = '/api/proformas/batches';
  const id = (p: unknown) =>
    z.strictObject({ id: z.uuid().transform((v) => v.toLowerCase()) }).parse(p).id;
  const noQuery = (q: unknown) => z.strictObject({}).parse(q);
  const actor = (req: any) => ({ ...req.actor, apiKeyId: req.apiKeyId ?? req.actor.apiKeyId });
  const send = (v: any) => ({
    ...v,
    read_only: opts.readOnly,
    ...(typeof v.can_write === 'boolean' ? { can_write: !opts.readOnly && v.can_write } : {}),
    ...(v.preview
      ? { preview: { ...v.preview, can_issue: !opts.readOnly && v.preview.can_issue } }
      : {}),
  });
  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0].replace(/^\/api\/v1\//, '/api/');
    if (!path.startsWith(root + '/')) return;
    reply.header('Cache-Control', 'no-store');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      ensure(!opts.readOnly, 423, 'Kopia jest tylko do odczytu');
      ensure(
        opts.available && (await proformaBatchesAvailable(pool)),
        503,
        'Kopia nie zawiera modułu masowych proform',
      );
    }
  });
  app.post(root + '/previews', async (req, reply) => {
    noQuery(req.query);
    const result = await previewProformaBatch(
      actor(req),
      proformaBatchPreviewInput.parse(req.body),
    );
    reply.code(result.reused ? 200 : 201);
    return send(result);
  });
  app.get(root + '/previews/:id', async (req) => {
    noQuery(req.query);
    return send(await proformaBatchPreviewDetail(actor(req), id(req.params)));
  });
  app.post(root + '/previews/:id/issue', async (req, reply) => {
    noQuery(req.query);
    const result = await issueProformaBatch(
      actor(req),
      id(req.params),
      proformaBatchIssueInput.parse(req.body),
    );
    reply.code(result.reused ? 200 : 201);
    return send(result);
  });
  app.get(root + '/executions/:id', async (req) => {
    noQuery(req.query);
    return send(await proformaBatchExecutionDetail(actor(req), id(req.params)));
  });
  app.get(root + '/history', async (req) =>
    send(await proformaBatchHistory(actor(req), proformaBatchHistoryQuery.parse(req.query))),
  );
}
