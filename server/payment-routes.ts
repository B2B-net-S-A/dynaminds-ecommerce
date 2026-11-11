import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { tenantTx, tenantReadTx } from './db';
import {
  paymentInput,
  reversalInput,
  paymentHistory,
  recordPayment,
  reversePayment,
} from './payments';
export function registerPaymentRoutes(app: FastifyInstance) {
  const id = (params: unknown) => z.object({ id: z.uuid() }).parse(params).id;
  app.get('/api/orders/:id/payments', (req) =>
    tenantReadTx(req.actor.tenantId, (c) =>
      paymentHistory(
        c,
        id(req.params),
        z.object({ before: z.uuid().optional() }).strict().parse(req.query).before,
      ),
    ),
  );
  app.post('/api/orders/:id/payments', (req) =>
    tenantTx(req.actor.tenantId, (c) =>
      recordPayment(c, req.actor, id(req.params), paymentInput.parse(req.body)),
    ),
  );
  app.post('/api/orders/:id/payments/reverse', (req) =>
    tenantTx(req.actor.tenantId, (c) =>
      reversePayment(c, req.actor, id(req.params), reversalInput.parse(req.body)),
    ),
  );
}
