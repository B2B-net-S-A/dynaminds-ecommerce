import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ensure } from './errors';
import * as A from './replenishment-automations';
const params = z.strictObject({ id: z.uuid().transform((v) => v.toLowerCase()) });
const empty = z.strictObject({});
export function registerReplenishmentAutomationRoutes(
  app: FastifyInstance,
  opts: { available: boolean; readOnly: boolean },
) {
  const prefix = '/api/replenishment/automations';
  const actor = (req: FastifyRequest, write = false) => {
    const scopes = [
      'products:read',
      'inventory:read',
      'purchasing:read',
      ...(write ? ['purchasing:write'] : []),
    ];
    ensure(
      !req.apiScopes || scopes.every((s) => req.apiScopes!.includes(s)),
      403,
      'Wymagane scope: ' + scopes.join(', '),
    );
    const key = req.currentUser?.api_key_id;
    ensure(!req.apiScopes || typeof key === 'string', 401, 'Brak kontekstu klucza');
    return { ...req.actor, ...(req.apiScopes ? { apiKeyId: key } : {}) };
  };
  const writable = (req: FastifyRequest) => {
    ensure(!opts.readOnly, 423, 'Ta kopia jest tylko do odczytu');
    ensure(opts.available, 503, 'Automatyczne uzupełnianie nie jest dostępne');
    return actor(req, true);
  };
  const readable = () => ensure(opts.available, 503, 'Automatyczne uzupełnianie nie jest dostępne');
  const view = (r: Record<string, any>) => ({
    ...r,
    available: opts.available && r.available !== false,
    read_only: opts.readOnly,
    can_manage: !opts.readOnly && r.can_manage === true,
    ...(r.run
      ? { run: { ...r.run, can_cancel: !opts.readOnly && r.run.can_cancel === true } }
      : {}),
    ...(r.data
      ? {
          data: r.data.map((x: Record<string, any>) =>
            Object.hasOwn(x, 'can_cancel')
              ? { ...x, can_cancel: !opts.readOnly && x.can_cancel === true }
              : x,
          ),
        }
      : {}),
  });
  const write = {
    bodyLimit: A.REPLENISHMENT_AUTOMATION_LIMITS.request_bytes,
    onRequest: async (req: FastifyRequest) => {
      writable(req);
    },
  };
  app.get(prefix + '/options', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    empty.parse(req.query);
    return view(await A.replenishmentAutomationOptions(actor(req)));
  });
  app.get(prefix + '/rules', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    readable();
    return view(
      await A.replenishmentAutomationRules(
        actor(req),
        A.replenishmentAutomationPageQuery.parse(req.query),
      ),
    );
  });
  app.get(prefix + '/rules/:id', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    readable();
    empty.parse(req.query);
    return view(await A.replenishmentAutomationRuleDetail(actor(req), params.parse(req.params).id));
  });
  app.post(prefix + '/rules', write, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    empty.parse(req.query);
    const r = await A.createReplenishmentAutomation(
      writable(req),
      A.replenishmentAutomationCreateInput.parse(req.body),
    );
    return reply.code(r.reused ? 200 : 201).send(view(r));
  });
  app.patch(prefix + '/rules/:id', write, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    empty.parse(req.query);
    return view(
      await A.patchReplenishmentAutomation(
        writable(req),
        params.parse(req.params).id,
        A.replenishmentAutomationPatchInput.parse(req.body),
      ),
    );
  });
  app.get(prefix + '/runs', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    readable();
    return view(
      await A.replenishmentAutomationRuns(
        actor(req),
        A.replenishmentAutomationRunsQuery.parse(req.query),
      ),
    );
  });
  app.get(prefix + '/runs/:id', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    readable();
    empty.parse(req.query);
    return view(await A.replenishmentAutomationRunDetail(actor(req), params.parse(req.params).id));
  });
  app.post(prefix + '/runs/:id/cancel', write, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    empty.parse(req.query);
    return view(
      await A.cancelReplenishmentAutomationRun(
        writable(req),
        params.parse(req.params).id,
        A.replenishmentAutomationCancelInput.parse(req.body),
      ),
    );
  });
}
