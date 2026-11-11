import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  billingInput,
  billingState,
  previewBilling,
  commitBilling,
  configureBilling,
} from './workspace-billing';
export function registerWorkspaceBillingRoutes(app: FastifyInstance) {
  app.get('/api/workspaces/billing', (req) => {
    const q = z
      .object({ before: z.iso.datetime({ offset: true }).optional(), id: z.uuid().optional() })
      .refine((v) => !!v.before === !!v.id)
      .parse(req.query);
    return billingState(req.actor, q.before ? { created_at: q.before, id: q.id! } : undefined);
  });
  app.post('/api/workspaces/billing/preview', (req) =>
    previewBilling(req.actor, billingInput.parse(req.body)),
  );
  app.post('/api/workspaces/billing/previews/:id/commit', (req) => {
    z.object({})
      .strict()
      .parse(req.body ?? {});
    return commitBilling(req.actor, z.object({ id: z.uuid() }).parse(req.params).id);
  });
  app.patch('/api/workspaces/billing', (req) =>
    configureBilling(
      req.actor,
      z
        .object({
          version: z.number().int().positive(),
          auto_renew: z.boolean().optional(),
          cancel_scheduled: z.literal(true).optional(),
        })
        .strict()
        .refine((v) => v.auto_renew !== undefined || v.cancel_scheduled)
        .parse(req.body),
    ),
  );
}
