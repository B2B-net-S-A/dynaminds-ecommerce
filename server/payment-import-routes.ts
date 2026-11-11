import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { tenantTx } from './db';
import { ensure } from './errors';
import {
  paymentImportAdmin,
  paymentImportNamespaces,
  createPaymentImportNamespace,
  updatePaymentImportNamespace,
  paymentImportProfiles,
  createPaymentImportProfile,
  updatePaymentImportProfile,
  uploadPaymentImport,
  previewPaymentImport,
  resolvePaymentImport,
  queuePaymentImport,
  previewPaymentImportCorrection,
  queuePaymentImportCorrection,
  cancelPaymentImport,
  paymentImportHistory,
  paymentImportPreviewDetail,
  paymentImportExecutionDetail,
  paymentImportReceipts,
} from './payment-imports';
export function registerPaymentImportRoutes(
  app: FastifyInstance,
  opts: { available: boolean; readOnly: boolean },
) {
  const id = (p: unknown) => z.strictObject({ id: z.uuid() }).parse(p).id;
  const cursor = (q: unknown) => z.strictObject({ cursor: z.uuid().optional() }).parse(q).cursor;
  const writable = () => {
    ensure(!opts.readOnly, 423, 'Kopia jest tylko do odczytu');
    ensure(opts.available, 503, 'Kopia nie zawiera importu płatności');
  };
  const get = async (req: any, reply: any, run: () => Promise<any>) => {
    reply.header('cache-control', 'no-store');
    if (!opts.available) {
      await tenantTx(req.actor.tenantId, (c) => paymentImportAdmin(c, req.actor));
      return {
        available: false,
        read_only: opts.readOnly,
        current_role: 'admin',
        can_write: false,
        data: [],
        meta: { cursor: null },
      };
    }
    return {
      available: true,
      read_only: opts.readOnly,
      ...(await run()),
      can_write: !opts.readOnly,
    };
  };
  app.get('/api/payment-imports/namespaces', (req, reply) =>
    get(req, reply, () => paymentImportNamespaces(req.actor)),
  );
  app.post('/api/payment-imports/namespaces', (req) => {
    writable();
    return createPaymentImportNamespace(req.actor, req.body as any);
  });
  app.put('/api/payment-imports/namespaces/:id', (req) => {
    writable();
    return updatePaymentImportNamespace(req.actor, id(req.params), req.body as any);
  });
  app.get('/api/payment-imports/profiles', (req, reply) =>
    get(req, reply, () => paymentImportProfiles(req.actor, cursor(req.query))),
  );
  app.post('/api/payment-imports/profiles', (req) => {
    writable();
    return createPaymentImportProfile(req.actor, req.body as any);
  });
  app.put('/api/payment-imports/profiles/:id', (req) => {
    writable();
    return updatePaymentImportProfile(req.actor, id(req.params), req.body as any);
  });
  app.delete('/api/payment-imports/profiles/:id', (req) => {
    writable();
    return updatePaymentImportProfile(req.actor, id(req.params), req.body as any, true);
  });
  app.post(
    '/api/payment-imports/uploads',
    { bodyLimit: 7100000, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    (req) => {
      writable();
      return uploadPaymentImport(req.actor, req.body as any);
    },
  );
  app.get('/api/payment-imports/previews', (req, reply) =>
    get(req, reply, () => paymentImportHistory(req.actor, 'previews', cursor(req.query))),
  );
  app.post('/api/payment-imports/previews', (req) => {
    writable();
    return previewPaymentImport(req.actor, req.body as any);
  });
  app.get('/api/payment-imports/previews/:id', (req, reply) =>
    get(req, reply, () => paymentImportPreviewDetail(req.actor, id(req.params), cursor(req.query))),
  );
  app.post('/api/payment-imports/previews/:id/resolve', (req) => {
    writable();
    return resolvePaymentImport(req.actor, id(req.params), req.body as any);
  });
  app.post('/api/payment-imports/previews/:id/queue', (req) => {
    writable();
    return queuePaymentImport(req.actor, id(req.params), req.body as any);
  });
  app.get('/api/payment-imports/executions', (req, reply) =>
    get(req, reply, () => paymentImportHistory(req.actor, 'executions', cursor(req.query))),
  );
  app.get('/api/payment-imports/executions/:id', (req, reply) =>
    get(req, reply, () =>
      paymentImportExecutionDetail(req.actor, id(req.params), cursor(req.query)),
    ),
  );
  app.post('/api/payment-imports/executions/:id/cancel', (req) => {
    writable();
    return cancelPaymentImport(
      req.actor,
      id(req.params),
      z.strictObject({ client_key: z.uuid() }).parse(req.body).client_key,
    );
  });
  app.get('/api/payment-imports/receipts', (req, reply) =>
    get(req, reply, () => {
      const q = z
        .strictObject({ cursor: z.uuid().optional(), order_id: z.uuid().optional() })
        .parse(req.query);
      return paymentImportReceipts(req.actor, q.cursor, q.order_id);
    }),
  );
  app.post('/api/payment-imports/corrections/preview', (req) => {
    writable();
    return previewPaymentImportCorrection(req.actor, req.body as any);
  });
  app.post('/api/payment-imports/corrections/:id/queue', (req) => {
    writable();
    return queuePaymentImportCorrection(req.actor, id(req.params), req.body as any);
  });
}
