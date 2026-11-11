import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { tenantTx } from './db';
import { ensure } from './errors';
import { orderSnapshot } from './events';
import { ruleInput, normalizedRule, matchesRule } from './operation-schema';
import { previewAction } from './order-operations';
import { validateReferences } from './operation-routes';
import { customerWorkflowAction, customerWorkflowPage } from './customer-message-workflow-schema';
import {
  customerMessageWorkflowMetadata,
  customerMessageWorkflowRoleInTx,
  customerMessageWorkflowRules,
  saveCustomerMessageWorkflowRule,
  customerMessageWorkflowRuns,
} from './customer-message-workflows';
export const customerMessageWorkflowRuleInput = ruleInput
  .safeExtend({
    client_key: z.uuid(),
    trigger: z.literal('customer_message.received'),
    actions: z.array(customerWorkflowAction).min(1).max(5),
  })
  .strict();
export const customerMessageWorkflowRulePatch = z.union([
  customerMessageWorkflowRuleInput.safeExtend({ version: z.string().regex(/^[1-9]\d*$/) }),
  z.strictObject({
    client_key: z.uuid(),
    version: z.string().regex(/^[1-9]\d*$/),
    enabled: z.boolean(),
  }),
]);
export const customerMessageWorkflowPreview = z.strictObject({ order_id: z.uuid() });
export function registerCustomerMessageWorkflowRoutes(
  app: FastifyInstance,
  opts: { available: boolean; readOnly: boolean },
) {
  const disabled = () => ({
    available: false,
    read_only: opts.readOnly,
    current_role: null,
    can_read: false,
    can_admin: false,
    data: [],
    meta: { cursor: null },
  });
  const available = () => ensure(opts.available, 503, 'Kopia nie zawiera workflow wiadomości');
  const scope = (req: any, write = false) => {
    if (req.apiScopes)
      ensure(
        req.apiScopes.includes(write ? 'automations:write' : 'automations:read') &&
          req.apiScopes.includes(write ? 'communications:write' : 'communications:read') &&
          (!write ||
            (req.apiScopes.includes('automations:read') &&
              req.apiScopes.includes('communications:read'))),
        403,
        'Klucz API nie ma zakresów workflow wiadomości',
      );
  };
  const response = (req: any, data: any) => ({
    ...data,
    available: true,
    read_only: opts.readOnly,
    can_read:
      Boolean(data.can_read) &&
      (!req.apiScopes ||
        (req.apiScopes.includes('automations:read') &&
          req.apiScopes.includes('communications:read'))),
    can_admin:
      !opts.readOnly &&
      Boolean(data.can_admin) &&
      (!req.apiScopes ||
        (req.apiScopes.includes('automations:write') &&
          req.apiScopes.includes('communications:write'))),
  });
  const write = (req: any) => {
    ensure(!opts.readOnly, 423, 'Podgląd kopii: workflow wiadomości jest wyłączony');
    available();
    scope(req, true);
  };
  const id = (req: any) => z.strictObject({ id: z.uuid() }).parse(req.params).id;
  app.get('/api/customer-message-workflows', async (req) => {
    if (!opts.available) return disabled();
    scope(req);
    return response(req, await customerMessageWorkflowMetadata(req.actor));
  });
  app.get('/api/customer-message-workflows/rules', async (req) => {
    if (!opts.available) return disabled();
    scope(req);
    const q = z.strictObject({ cursor: z.string().max(300).optional() }).parse(req.query);
    return response(req, await customerMessageWorkflowRules(req.actor, q.cursor));
  });
  app.post('/api/customer-message-workflows/rules', async (req, reply) => {
    write(req);
    const result = await saveCustomerMessageWorkflowRule(
      req.actor,
      null,
      customerMessageWorkflowRuleInput.parse(req.body),
    );
    return reply.code(result.reused ? 200 : 201).send(response(req, result));
  });
  app.patch('/api/customer-message-workflows/rules/:id', async (req) => {
    write(req);
    return response(
      req,
      await saveCustomerMessageWorkflowRule(
        req.actor,
        id(req),
        customerMessageWorkflowRulePatch.parse(req.body),
      ),
    );
  });
  app.post('/api/customer-message-workflows/rules/:id/preview', async (req) => {
    write(req);
    const input = customerMessageWorkflowPreview.parse(req.body);
    return tenantTx(req.actor.tenantId, async (c) => {
      const row = (
        await c.query(
          "SELECT * FROM automation_rules WHERE id=$1 AND trigger='customer_message.received'",
          [id(req)],
        )
      ).rows[0];
      ensure(row, 404, 'Nie znaleziono workflow wiadomości');
      const snapshot = await orderSnapshot(c, input.order_id);
      ensure(snapshot, 404, 'Nie znaleziono zamówienia');
      const rule = normalizedRule(row),
        matched = matchesRule(rule, snapshot);
      // Preview actions acquire order/thread before final membership locks.
      const preview = matched
        ? await previewAction(c, req.actor, input.order_id, rule.actions, true)
        : { allowed: false, error: 'Warunki nie są spełnione' };
      const role = await customerMessageWorkflowRoleInTx(c, req.actor);
      ensure(role === 'admin', 403, 'Wymagana aktualna rola administratora');
      return response(req, {
        current_role: role,
        can_read: true,
        can_admin: true,
        snapshot,
        matched,
        ...preview,
      });
    });
  });
  app.get('/api/customer-message-workflows/runs', async (req) => {
    if (!opts.available) return disabled();
    scope(req);
    return response(
      req,
      await customerMessageWorkflowRuns(req.actor, customerWorkflowPage.parse(req.query)),
    );
  });
  app.get('/api/customer-message-workflows/runs/:id', async (req) => {
    if (!opts.available) return disabled();
    scope(req);
    return response(req, await customerMessageWorkflowRuns(req.actor, {}, id(req)));
  });
}
