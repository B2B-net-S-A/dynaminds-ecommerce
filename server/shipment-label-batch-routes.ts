import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from './db';
import { ensure } from './errors';
import { printUuid, type PrintActor } from './print-job-values';
import * as B from './shipment-label-batches';
import * as V from './shipment-label-batch-values';
import { validateShipmentLabelBatchContent } from './shipment-label-batch-pdf';

export function registerShipmentLabelBatchRoutes(
  app: FastifyInstance,
  opts: { available: boolean; readOnly: boolean },
) {
  const root = '/api/print-jobs/label-batches';
  const actor = (req: any): PrintActor => ({
    ...req.actor,
    apiKeyId: req.actor.apiKeyId ?? req.apiKeyId,
  });
  const id = (req: any) => z.strictObject({ id: printUuid }).parse(req.params).id;
  const emptyQuery = (req: any) => z.strictObject({}).parse(req.query);
  const flags = (value: any) => ({
    ...value,
    read_only: opts.readOnly,
    ...(opts.readOnly
      ? {
          can_write: false,
          can_manage: false,
          ...(value.preview ? { preview: { ...value.preview, can_queue: false } } : {}),
          ...(Array.isArray(value.data)
            ? {
                data: value.data.map((v: any) => ({
                  ...v,
                  ...(v.kind === 'preview' ? { can_queue: false } : {}),
                })),
              }
            : {}),
        }
      : {}),
  });
  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0].replace(/^\/api\/v1\//, '/api/');
    if (!path.startsWith(root + '/')) return;
    reply.header('Cache-Control', 'no-store');
    const bytes = ['GET', 'HEAD'].includes(req.method) && /\/(?:content|pdf)$/.test(path);
    const write = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
    if (bytes || write) {
      ensure(!opts.readOnly, 423, 'Kopia jest tylko do odczytu');
      ensure(
        opts.available && (await B.shipmentLabelBatchesAvailable(pool)),
        503,
        'Kopia nie zawiera partii etykiet',
      );
    }
    if (req.apiScopes)
      ensure(
        req.apiScopes.includes('orders:read') &&
          (!(bytes || write) ||
            (req.apiScopes.includes('orders:write') && req.apiScopes.includes('documents:read'))),
        403,
        'Klucz API nie ma zakresów partii etykiet',
      );
  });
  app.get(root + '/options', async (req) => {
    emptyQuery(req);
    if (!opts.available) {
      await B.shipmentLabelBatchesAvailable(pool);
      return {
        available: false,
        batch_available: false,
        read_only: opts.readOnly,
        can_read: false,
        can_write: false,
        can_manage: false,
        current_role: null,
        stations: [],
        printers: [],
        limits: V.SHIPMENT_LABEL_BATCH_LIMITS,
      };
    }
    return flags(await B.shipmentLabelBatchOptions(actor(req)));
  });
  app.post(root + '/previews', async (req, reply) => {
    emptyQuery(req);
    const result = await B.createShipmentLabelBatchPreview(
      actor(req),
      V.shipmentLabelBatchPreviewInput.parse(req.body),
    );
    reply.code(result.reused ? 200 : 201);
    return flags(result);
  });
  app.get(root + '/previews/:id', async (req) => {
    emptyQuery(req);
    return flags(await B.shipmentLabelBatchPreviewDetail(actor(req), id(req)));
  });
  app.get(root + '/previews/:id/content', async (req) => {
    emptyQuery(req);
    return flags(await B.shipmentLabelBatchContent(actor(req), id(req)));
  });
  app.get(root + '/previews/:id/pdf', async (req, reply) => {
    const query = z.strictObject({ workspace_id: printUuid }).parse(req.query);
    ensure(
      query.workspace_id === req.actor.tenantId,
      409,
      'Zmieniono aktywną firmę; otwórz partię ponownie',
    );
    const content = await B.shipmentLabelBatchContent(actor(req), id(req));
    const verified = await validateShipmentLabelBatchContent(
      content.content_base64,
      content.content_sha256,
      content.content_bytes,
    );
    reply.header('Content-Type', 'application/pdf');
    reply.header('Content-Disposition', 'attachment; filename="shipment-label-batch-review.pdf"');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header(
      'Content-Security-Policy',
      "default-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    );
    return reply.send(Buffer.from(verified.content_base64, 'base64'));
  });
  app.post(root + '/previews/:id/queue', async (req, reply) => {
    emptyQuery(req);
    const result = await B.queueShipmentLabelBatch(
      actor(req),
      id(req),
      V.shipmentLabelBatchQueueInput.parse(req.body),
    );
    reply.code(result.reused ? 200 : 201);
    return flags(result);
  });
  app.get(root + '/executions/:id', async (req) => {
    emptyQuery(req);
    return flags(await B.shipmentLabelBatchExecutionDetail(actor(req), id(req)));
  });
  app.get(root + '/history', async (req) =>
    flags(
      await B.shipmentLabelBatchHistory(
        actor(req),
        V.shipmentLabelBatchHistoryInput.parse(req.query),
      ),
    ),
  );
}
