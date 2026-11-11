import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from './db';
import { ensure } from './errors';
import type { IntegrationContext } from './channel-access';
import { printUuid, validatePrintContent, type PrintActor } from './print-job-values';
import * as C from './shipment-label-cache';
import * as V from './shipment-label-cache-values';

export function registerShipmentLabelCacheRoutes(
  app: FastifyInstance,
  opts: { available: boolean; readOnly: boolean },
  context: IntegrationContext = {},
) {
  const root = '/api/print-jobs';
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
          can_acquire: false,
          can_queue: false,
          ...(value.acquisition
            ? { acquisition: { ...value.acquisition, can_reconcile: false } }
            : {}),
          ...(value.latest_acquisition
            ? { latest_acquisition: { ...value.latest_acquisition, can_reconcile: false } }
            : {}),
          ...(Array.isArray(value.data)
            ? { data: value.data.map((a: any) => ({ ...a, can_reconcile: false })) }
            : {}),
        }
      : {}),
  });
  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0].replace(/^\/api\/v1\//, '/api/');
    const matches =
      /^\/api\/print-jobs\/shipments\/[^/]+\/label-cache(?:\/history)?$/.test(path) ||
      /^\/api\/print-jobs\/label-cache\/[^/]+(?:\/(?:content|pdf))?$/.test(path) ||
      /^\/api\/print-jobs\/label-cache\/acquisitions\/[^/]+\/reconcile$/.test(path);
    if (!matches) return;
    reply.header('Cache-Control', 'no-store');
    const bytes = ['GET', 'HEAD'].includes(req.method) && /\/(content|pdf)$/.test(path);
    const writing = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
    if (bytes || writing) {
      ensure(!opts.readOnly, 423, 'Kopia jest tylko do odczytu');
      ensure(
        opts.available && (await C.shipmentLabelCacheAvailable(pool)),
        503,
        'Kopia nie zawiera cache etykiet przesyłek',
      );
    }
    if (req.apiScopes)
      ensure(
        req.apiScopes.includes('orders:read') &&
          (!(bytes || writing) ||
            (req.apiScopes.includes('orders:write') && req.apiScopes.includes('documents:read'))),
        403,
        'Klucz API nie ma zakresów cache etykiet',
      );
  });
  app.get(root + '/shipments/:id/label-cache', async (req) => {
    emptyQuery(req);
    return flags(await C.shipmentLabelCacheMetadata(actor(req), id(req)));
  });
  app.post(root + '/shipments/:id/label-cache', async (req, reply) => {
    emptyQuery(req);
    const result = await C.acquireShipmentLabelCache(
      actor(req),
      id(req),
      V.shipmentLabelCacheAcquireInput.parse(req.body),
      context,
    );
    reply.code(result.reused ? 200 : 201);
    return flags(result);
  });
  app.get(root + '/shipments/:id/label-cache/history', async (req) =>
    flags(
      await C.shipmentLabelCacheHistory(
        actor(req),
        id(req),
        V.shipmentLabelCachePageInput.parse(req.query),
      ),
    ),
  );
  app.get(root + '/label-cache/:id', async (req) => {
    emptyQuery(req);
    return flags(await C.shipmentLabelCacheDetail(actor(req), id(req)));
  });
  app.get(root + '/label-cache/:id/content', async (req) => {
    emptyQuery(req);
    return flags(await C.shipmentLabelCacheContent(actor(req), id(req)));
  });
  app.get(root + '/label-cache/:id/pdf', async (req, reply) => {
    const query = z.strictObject({ workspace_id: printUuid }).parse(req.query);
    ensure(
      query.workspace_id === req.actor.tenantId,
      409,
      'Zmieniono aktywną firmę; otwórz etykietę ponownie',
    );
    const content = await C.shipmentLabelCacheContent(actor(req), id(req));
    const verified = validatePrintContent(content.content_base64, 'pdf');
    ensure(
      verified.content_sha256 === content.content_sha256 &&
        verified.content_bytes === content.content_bytes,
      409,
      'Plik nie zgadza się z zapisanym skrótem',
    );
    reply.header('Content-Type', 'application/pdf');
    reply.header('Content-Disposition', 'attachment; filename="shipment-label.pdf"');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header(
      'Content-Security-Policy',
      "default-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    );
    return reply.send(Buffer.from(content.content_base64, 'base64'));
  });
  app.post(root + '/label-cache/acquisitions/:id/reconcile', async (req) => {
    emptyQuery(req);
    return flags(
      await C.reconcileShipmentLabelCache(
        actor(req),
        id(req),
        V.shipmentLabelCacheReconcileInput.parse(req.body),
      ),
    );
  });
}
