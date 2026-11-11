import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ensure } from './errors';
import * as M from './b2b-dropshipping-returns';
export function registerB2bDropshippingReturnRoutes(
  app: FastifyInstance,
  opts: { available: boolean; readOnly: boolean },
) {
  const prefix = '/api/b2b/dropshipping-returns';
  const id = (p: unknown) => z.object({ id: z.uuid() }).parse(p).id;
  const actor = (r: any) => {
    const key = r.currentUser.api_key_id;
    ensure(!r.apiScopes || typeof key === 'string', 401, 'Brak bieżącego klucza API');
    return { ...r.actor, ...(r.apiScopes ? { apiKeyId: key } : {}) };
  };
  const scopes = ['orders:read', 'inventory:read'];
  const reads: Array<[string, (req: any) => Promise<any>]> = [
    ['/options', (r) => M.b2bDropshipReturnOptions(actor(r))],
    [
      '/settings/:account_id',
      (r) =>
        M.b2bDropshipReturnSettings(
          actor(r),
          z.object({ account_id: z.uuid() }).parse(r.params).account_id,
        ),
    ],
    ['/returns/:id/context', (r) => M.b2bDropshipReturnContext(actor(r), id(r.params))],
    ['/returns/:id/sources', (r) => M.b2bDropshipReturnSources(actor(r), id(r.params), r.query)],
    ['/previews/:id', (r) => M.b2bDropshipReturnPreview(actor(r), id(r.params))],
    ['/previews/:id/rows', (r) => M.b2bDropshipReturnPreviewRows(actor(r), id(r.params), r.query)],
    ['/cases', (r) => M.b2bDropshipReturnCases(actor(r), r.query)],
    ['/cases/:id', (r) => M.b2bDropshipReturnCase(actor(r), id(r.params))],
    ['/cases/:id/rows', (r) => M.b2bDropshipReturnCaseRows(actor(r), id(r.params), r.query)],
    ['/cases/:id/events', (r) => M.b2bDropshipReturnCaseEvents(actor(r), id(r.params), r.query)],
  ];
  for (const [path, fn] of reads)
    app.get(prefix + path, async (r, reply) => {
      ensure(
        !r.apiScopes || scopes.every((s) => r.apiScopes!.includes(s)),
        403,
        'Brak wymaganych zakresów klucza API',
      );
      reply.header('Cache-Control', 'no-store');
      const b = await fn(r);
      if (opts.readOnly) {
        for (const head of [b.case, b.preview, b.context, ...(b.data ?? [])].filter(Boolean))
          for (const k of [
            'can_receive',
            'can_reject',
            'can_withdraw',
            'can_reconcile',
            'can_preview',
            'can_submit',
            'can_select_local_origin',
            'can_receive_locally',
          ])
            if (k in head) head[k] = false;
      }
      return { ...b, read_only: opts.readOnly, can_manage: b.can_manage && !opts.readOnly };
    });
  const writes: Array<[string, string, (req: any) => Promise<any>, number]> = [
    [
      'POST',
      '/returns/:id/local-origin',
      (r) => M.selectB2bReturnLocalOrigin(actor(r), id(r.params), r.body),
      201,
    ],
    [
      'PATCH',
      '/settings/:account_id',
      (r) =>
        M.updateB2bDropshipReturnSettings(
          actor(r),
          z.object({ account_id: z.uuid() }).parse(r.params).account_id,
          r.body,
        ),
      200,
    ],
    [
      'POST',
      '/returns/:id/previews',
      (r) => M.createB2bDropshipReturnPreview(actor(r), id(r.params), r.body),
      201,
    ],
    [
      'POST',
      '/previews/:id/submit',
      (r) => M.submitB2bDropshipReturn(actor(r), id(r.params), r.body),
      201,
    ],
    [
      'POST',
      '/cases/:id/receive',
      (r) => M.receiveB2bDropshipReturn(actor(r), id(r.params), r.body),
      200,
    ],
    [
      'POST',
      '/cases/:id/decision',
      (r) => M.decideB2bDropshipReturn(actor(r), id(r.params), r.body),
      200,
    ],
    [
      'POST',
      '/cases/:id/withdraw',
      (r) => M.withdrawB2bDropshipReturn(actor(r), id(r.params), r.body),
      200,
    ],
    [
      'POST',
      '/returns/:id/reconcile',
      (r) => M.reconcileB2bDropshipReturn(actor(r), id(r.params), r.body),
      200,
    ],
  ];
  for (const [method, path, fn, status] of writes)
    app.route({
      method: method as 'POST' | 'PATCH',
      url: prefix + path,
      handler: async (r, reply) => {
        ensure(!opts.readOnly, 423, 'Kopia tylko do odczytu');
        ensure(
          !r.apiScopes ||
            [...scopes, 'orders:write', 'inventory:write', 'purchasing:write'].every((s) =>
              r.apiScopes!.includes(s),
            ),
          403,
          'Brak wymaganych zakresów klucza API',
        );
        reply.header('Cache-Control', 'no-store');
        ensure(opts.available, 503, 'Ta kopia nie obsługuje koordynowanych zwrotów');
        const b = await fn(r);
        return reply.code(b.reused ? 200 : status).send(b);
      },
    });
}
