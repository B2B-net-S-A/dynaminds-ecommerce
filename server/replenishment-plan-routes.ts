import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ensure } from './errors';
import * as P from './replenishment-plans';
const uuid = z.uuid().transform((v) => v.toLowerCase());
const params = z.strictObject({ id: uuid });
const rowParams = z.strictObject({ id: uuid, row_id: uuid });
const empty = z.strictObject({});
export function registerReplenishmentPlanRoutes(
  app: FastifyInstance,
  opts: { available: boolean; readOnly: boolean },
) {
  const actor = (req: FastifyRequest, write = false) => {
    const required = [
      'products:read',
      'inventory:read',
      'purchasing:read',
      ...(write ? ['purchasing:write'] : []),
    ];
    ensure(
      !req.apiScopes || required.every((s) => req.apiScopes!.includes(s)),
      403,
      'Wymagane scope: ' + required.join(', '),
    );
    const apiKeyId = req.currentUser?.api_key_id;
    ensure(!req.apiScopes || typeof apiKeyId === 'string', 401, 'Brak kontekstu klucza API');
    return { ...req.actor, ...(req.apiScopes ? { apiKeyId } : {}) };
  };
  const writable = (req: FastifyRequest) => {
    ensure(!opts.readOnly, 423, 'Ta kopia jest tylko do odczytu');
    ensure(opts.available, 503, 'Planowanie zakupów nie jest dostępne w tej kopii');
    return actor(req, true);
  };
  const readable = () =>
    ensure(opts.available, 503, 'Planowanie zakupów nie jest dostępne w tej kopii');
  const response = (r: Record<string, any>) => ({
    ...r,
    available: opts.available && r.available !== false,
    read_only: opts.readOnly,
    can_manage: !opts.readOnly && r.can_manage === true,
    can_preview: !opts.readOnly && r.can_preview === true,
    can_execute: !opts.readOnly && r.can_execute === true,
  });
  const prefix = '/api/replenishment';
  app.get(prefix + '/options', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    empty.parse(req.query);
    return response(await P.replenishmentOptions(actor(req)));
  });
  app.get(prefix + '/drafts', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    readable();
    return response(
      await P.replenishmentDrafts(actor(req), P.replenishmentDraftsQuery.parse(req.query)),
    );
  });
  app.get(prefix + '/selection', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    readable();
    return response(
      await P.replenishmentSelection(actor(req), P.replenishmentSelectionQuery.parse(req.query)),
    );
  });
  app.get(prefix + '/policies', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    readable();
    return response(
      await P.replenishmentPolicies(actor(req), P.replenishmentPoliciesQuery.parse(req.query)),
    );
  });
  app.get(prefix + '/policies/:id', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    readable();
    empty.parse(req.query);
    return response(await P.replenishmentPolicyDetail(actor(req), params.parse(req.params).id));
  });
  const writeOptions = {
    bodyLimit: P.REPLENISHMENT_LIMITS.request_bytes,
    onRequest: async (req: FastifyRequest) => {
      writable(req);
    },
  };
  app.post(prefix + '/policies', writeOptions, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    empty.parse(req.query);
    const r = await P.createReplenishmentPolicy(
      writable(req),
      P.replenishmentPolicyCreateInput.parse(req.body),
    );
    return reply.code(r.reused ? 200 : 201).send(response(r));
  });
  app.patch(prefix + '/policies/:id', writeOptions, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    empty.parse(req.query);
    return response(
      await P.patchReplenishmentPolicy(
        writable(req),
        params.parse(req.params).id,
        P.replenishmentPolicyPatchInput.parse(req.body),
      ),
    );
  });
  app.post(prefix + '/previews', writeOptions, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    empty.parse(req.query);
    const r = await P.createReplenishmentPreview(
      writable(req),
      P.replenishmentPreviewInput.parse(req.body),
    );
    return reply.code(r.reused ? 200 : 201).send(response(r));
  });
  app.get(prefix + '/previews/:id', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    readable();
    empty.parse(req.query);
    return response(await P.replenishmentPreviewDetail(actor(req), params.parse(req.params).id));
  });
  app.get(prefix + '/previews/:id/rows', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    readable();
    return response(
      await P.replenishmentPreviewRows(
        actor(req),
        params.parse(req.params).id,
        P.replenishmentPageQuery.parse(req.query),
      ),
    );
  });
  app.get(prefix + '/previews/:id/rows/:row_id/contributors', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    readable();
    const p = rowParams.parse(req.params);
    return response(
      await P.replenishmentContributors(
        actor(req),
        p.id,
        p.row_id,
        P.replenishmentPageQuery.parse(req.query),
      ),
    );
  });
  app.post(prefix + '/previews/:id/execute', writeOptions, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    empty.parse(req.query);
    const r = await P.executeReplenishmentPlan(
      writable(req),
      params.parse(req.params).id,
      P.replenishmentExecuteInput.parse(req.body),
    );
    return reply.code(r.reused ? 200 : 201).send(response(r));
  });
  app.get(prefix + '/executions', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    readable();
    return response(
      await P.replenishmentExecutions(actor(req), P.replenishmentExecutionsQuery.parse(req.query)),
    );
  });
  app.get(prefix + '/executions/:id', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    readable();
    empty.parse(req.query);
    return response(await P.replenishmentExecutionDetail(actor(req), params.parse(req.params).id));
  });
  app.get(prefix + '/executions/:id/rows', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    readable();
    return response(
      await P.replenishmentExecutionRows(
        actor(req),
        params.parse(req.params).id,
        P.replenishmentPageQuery.parse(req.query),
      ),
    );
  });
}
