import {financialReturn162RequestActor} from './financial-return-completion';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { tenantTx } from './db';
import { ensure } from './errors';
import { returnExchangeInput, returnExchangePreviewInput } from './return-exchanges-schema';
import { previewReturnExchange, executeReturnExchange } from './return-exchanges';
import { returnPage, returnQuery } from './return-query';
import {
  returnInput,
  receiveInput,
  decisionInput,
  refundInput,
  returnOverview,
  getReturn,
  requestReturn,
  receiveReturn,
  decideReturn,
  recordRefund,
  returnDocument,
} from './returns';
export function registerReturnRoutes(app: FastifyInstance,options:{sessionName:string}) {
  const id = (params: unknown) => z.object({ id: z.uuid() }).parse(params).id;
  const write = (req: any) =>
    ensure(req.actor.role !== 'viewer', 403, 'Konto ma uprawnienia tylko do odczytu');
  const exchangeActor = (req: any) => ({
    ...req.actor,
    ...(req.apiScopes ? { apiKeyId: req.currentUser?.api_key_id, source: 'api' as const } : {}),
  });
  app.post('/api/returns/:id/exchange-preview', async (req, reply) => {
    z.strictObject({}).parse(req.query);
    reply.header('Cache-Control', 'no-store');
    return tenantTx(
      req.actor.tenantId,
      (c) =>
        previewReturnExchange(
          c,
          exchangeActor(req),
          id(req.params).toLowerCase(),
          returnExchangePreviewInput.parse(req.body),
        ),
      { purchasingAdmission: true },
    );
  });
  app.post('/api/returns/:id/exchange', async (req, reply) => {
    z.strictObject({}).parse(req.query);
    reply.header('Cache-Control', 'no-store');
    const result = await tenantTx(
      req.actor.tenantId,
      (c) =>
        executeReturnExchange(
          c,
          exchangeActor(req),
          id(req.params).toLowerCase(),
          returnExchangeInput.parse(req.body),
        ),
      { purchasingAdmission: true },
    );
    return reply.code(result.reused ? 200 : 201).send(result);
  });
  app.get('/api/returns', (req) =>
    tenantTx(req.actor.tenantId, (c) => returnPage(c, returnQuery.parse(req.query))),
  );
  app.get('/api/orders/:id/returns', (req) =>
    tenantTx(req.actor.tenantId, async (c) => {
      ensure(
        (await c.query('SELECT id FROM orders WHERE id=$1', [id(req.params)])).rowCount,
        404,
        'Nie znaleziono zamówienia',
      );
      return returnOverview(c, id(req.params), returnQuery.parse(req.query));
    }),
  );
  app.get('/api/returns/:id', (req) =>
    tenantTx(req.actor.tenantId, (c) => getReturn(c, id(req.params))),
  );
  app.post('/api/orders/:id/returns', async (req, reply) => {
    write(req);
    const r = await tenantTx(req.actor.tenantId, (c) =>
      requestReturn(c, req.actor, id(req.params), returnInput.parse(req.body)),
    );
    return reply.code(201).send(r);
  });
  app.post('/api/returns/:id/receive', async (req) => {
    write(req);
    const actor=await financialReturn162RequestActor(req,options.sessionName);
    return tenantTx(actor.tenantId, (c) =>
      receiveReturn(c, actor, id(req.params), receiveInput.parse(req.body)),
    );
  });
  app.post('/api/returns/:id/decision', (req) => {
    write(req);
    return tenantTx(req.actor.tenantId, (c) =>
      decideReturn(c, req.actor, id(req.params), decisionInput.parse(req.body)),
    );
  });
  app.post('/api/returns/:id/refund', (req) => {
    write(req);
    return tenantTx(req.actor.tenantId, (c) =>
      recordRefund(c, req.actor, id(req.params), refundInput.parse(req.body)),
    );
  });
  app.post('/api/returns/:id/document', (req) => {
    write(req);
    return tenantTx(req.actor.tenantId, (c) => returnDocument(c, req.actor, id(req.params)));
  });
}
