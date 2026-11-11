import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from './db';
import { ensure } from './errors';
import { printUuid, validatePrintContent, type PrintActor } from './print-job-values';
import * as P from './shipment-label-print';
import { captureOperationalDeliveryAuthority } from './operational-delivery-consumers';
import * as V from './shipment-label-print-values';

export function registerShipmentLabelPrintRoutes(
  app: FastifyInstance,
  opts: { available: boolean; readOnly: boolean; sessionName: string },
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
    ...(typeof value.can_write === 'boolean'
      ? { can_write: !opts.readOnly && value.can_write }
      : {}),
    ...(typeof value.can_manage === 'boolean'
      ? { can_manage: !opts.readOnly && value.can_manage }
      : {}),
    ...(opts.readOnly && value.preview ? { preview: { ...value.preview, can_queue: false } } : {}),
    ...(opts.readOnly && value.job
      ? { job: { ...value.job, can_claim: false, can_reconcile: false } }
      : {}),
  });
  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0].replace(/^\/api\/v1\//, '/api/');
    const matches =
      path === root + '/shipment-labels/options' ||
      /^\/api\/print-jobs\/shipments\/[^/]+\/label-previews$/.test(path) ||
      /^\/api\/print-jobs\/label-previews\/[^/]+(?:\/(?:content|pdf|queue))?$/.test(path);
    if (!matches) return;
    reply.header('Cache-Control', 'no-store');
    const bytes = ['GET', 'HEAD'].includes(req.method) && /\/(content|pdf)$/.test(path);
    const write = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
    if (bytes || write) ensure(!opts.readOnly, 423, 'Kopia jest tylko do odczytu');
    if (write || bytes)
      ensure(
        opts.available && (await P.shipmentLabelPrintAvailable(pool)),
        503,
        'Kopia nie zawiera wydruków etykiet przesyłek',
      );
    if (req.apiScopes)
      ensure(
        req.apiScopes.includes('orders:read') &&
          (!(bytes || write) || req.apiScopes.includes('orders:write')),
        403,
        'Klucz API nie ma zakresów wydruków etykiet',
      );
  });
  app.get(root + '/shipment-labels/options', async (req) => {
    emptyQuery(req);
    if (!opts.available) {
      await P.shipmentLabelPrintAvailable(pool);
      return {
        available: false,
        read_only: opts.readOnly,
        can_read: false,
        can_write: false,
        can_manage: false,
        current_role: null,
        stations: [],
        printers: [],
      };
    }
    return flags(await P.shipmentLabelPrintMetadata(actor(req)));
  });
  app.post(root + '/shipments/:id/label-previews', async (req, reply) => {
    emptyQuery(req);
    const result = await P.createShipmentLabelPrintPreview(
      captureOperationalDeliveryAuthority(req, opts.sessionName),
      id(req),
      V.shipmentLabelPrintPreviewInput.parse(req.body),
    );
    reply.code(result.reused ? 200 : 201);
    return flags(result);
  });
  app.get(root + '/label-previews/:id', async (req) => {
    emptyQuery(req);
    return flags(await P.shipmentLabelPrintDetail(actor(req), id(req)));
  });
  app.get(root + '/label-previews/:id/content', async (req) => {
    emptyQuery(req);
    return flags(await P.shipmentLabelPrintContent(actor(req), id(req)));
  });
  app.get(root + '/label-previews/:id/pdf', async (req, reply) => {
    // A stale browser tab must not follow a later session workspace switch.
    // This public UUID is only a context guard, never an authorization token.
    const query = z.strictObject({ workspace_id: printUuid }).parse(req.query);
    ensure(
      query.workspace_id === req.actor.tenantId,
      409,
      'Zmieniono aktywną firmę; otwórz podgląd ponownie',
    );
    const content = await P.shipmentLabelPrintContent(actor(req), id(req));
    const verified = validatePrintContent(content.content_base64, 'pdf');
    ensure(
      verified.content_sha256 === content.content_sha256 &&
        verified.content_bytes === content.content_bytes,
      409,
      'Plik podglądu nie zgadza się z zapisanym skrótem',
    );
    reply.header('Content-Type', 'application/pdf');
    reply.header('Content-Disposition', 'attachment; filename="shipment-label.pdf"');
    reply.header('X-Content-Type-Options', 'nosniff');
    // Review is rendered from the verified bytes inside the application;
    // this route exports the same frozen PDF as a download.
    reply.header(
      'Content-Security-Policy',
      "default-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    );
    return reply.send(Buffer.from(content.content_base64, 'base64'));
  });
  app.post(root + '/label-previews/:id/queue', async (req, reply) => {
    emptyQuery(req);
    const result = await P.queueShipmentLabelPrint(
      captureOperationalDeliveryAuthority(req, opts.sessionName),
      id(req),
      V.shipmentLabelPrintQueueInput.parse(req.body),
    );
    reply.code(result.reused ? 200 : 201);
    return flags(result);
  });
}
