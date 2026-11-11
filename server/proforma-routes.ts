import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ensure } from './errors';
import { pool } from './db';
import { PROFORMA_BATCH_LIMITS } from './proforma-batch-values';
import { assertStandaloneProformaPreview } from './proforma-batches';
import {
  proformasAvailable,
  proformaOptions,
  listProformaSeries,
  createProformaSeries,
  previewProforma,
  issueProforma,
  proformaPreviewDetail,
  proformaDetail,
} from './proformas';
import {
  proformaSeriesInput,
  proformaPreviewInput,
  proformaIssueInput,
  proformaPageQuery,
} from './proforma-values';

export function registerProformaRoutes(
  app: FastifyInstance,
  opts: { available: boolean; readOnly: boolean; batchesAvailable?: boolean },
) {
  const root = '/api/proformas';
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
        opts.available && (await proformasAvailable(pool)),
        503,
        'Kopia nie zawiera modułu proform',
      );
    }
  });
  app.get(root + '/options', async (req) => {
    noQuery(req.query);
    return send({
      ...(await proformaOptions(actor(req))),
      batch_available: Boolean(opts.batchesAvailable),
      batch_limits: PROFORMA_BATCH_LIMITS,
    });
  });
  app.get(root + '/series', async (req) =>
    send(await listProformaSeries(actor(req), proformaPageQuery.parse(req.query))),
  );
  app.post(root + '/series', async (req, reply) => {
    noQuery(req.query);
    const v = await createProformaSeries(actor(req), proformaSeriesInput.parse(req.body));
    reply.code(v.reused ? 200 : 201);
    return send(v);
  });
  app.post(root + '/orders/:id/previews', async (req, reply) => {
    noQuery(req.query);
    const v = await previewProforma(
      actor(req),
      id(req.params),
      proformaPreviewInput.parse(req.body),
    );
    reply.code(v.reused ? 200 : 201);
    return send(v);
  });
  app.get(root + '/previews/:id', async (req) => {
    noQuery(req.query);
    return send(await proformaPreviewDetail(actor(req), id(req.params)));
  });
  app.post(root + '/previews/:id/issue', async (req, reply) => {
    noQuery(req.query);
    const previewId = id(req.params);
    const body = proformaIssueInput.parse(req.body);
    await assertStandaloneProformaPreview(actor(req), previewId);
    const v = await issueProforma(actor(req), previewId, body);
    reply.code(v.reused ? 200 : 201);
    return send(v);
  });
  app.get(root + '/documents/:id', async (req) => {
    noQuery(req.query);
    return send(await proformaDetail(actor(req), id(req.params)));
  });
}
