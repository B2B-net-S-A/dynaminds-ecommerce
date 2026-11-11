import {
  customerMessageAssignment,
  customerWorkflowAssigneePage,
} from './customer-message-workflow-schema';
import { changeCustomerMessageAssignment, customerMessageAssignees } from './customer-messages';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ensure } from './errors';
import { orderCommunication, orderCommunicationQuery } from './order-communication';
import {
  addChannelMessage,
  changeChannelThread,
  channelInbox,
  channelThread,
  channelThreads,
  createChannelConnection,
  ingestChannelMessages,
  orderChannelThreads,
} from './channel-inbox253';
import {
  customerMessageInput,
  customerMessageStatus,
  customerMessageQuery,
  customerMessagePage,
  customerMessageToken,
  customerMessageHistory,
  customerMessageDetail,
  writeCustomerMessage,
  changeCustomerMessageStatus,
  resolveCustomerMessageToken,
  publicCustomerMessageRead,
  publicCustomerMessageWrite,
} from './customer-messages';
export function registerCustomerMessageRoutes(
  app: FastifyInstance,
  opts: { available: boolean; readOnly: boolean; workflowAvailable?: boolean },
) {
  const available = () => ensure(opts.available, 503, 'Kopia nie zawiera wiadomości klientów');
  const write = (req: any, requireRead = false) => {
    ensure(!opts.readOnly, 423, 'Podgląd kopii: wiadomości i zmiany statusu są wyłączone');
    available();
    if (req.apiScopes)
      ensure(
        req.apiScopes.includes('communications:write') &&
          (!requireRead || req.apiScopes.includes('communications:read')),
        403,
        'Klucz API nie ma zakresów zapisu wiadomości',
      );
  };
  const id = (p: unknown) => z.object({ id: z.uuid() }).parse(p).id;
  const disabled = () => ({
    available: false,
    read_only: opts.readOnly,
    data: [],
    meta: { cursor: null },
    can_reply: false,
    can_note: false,
    can_status: false,
    can_assign: false,
    workflow_available: Boolean(opts.workflowAvailable),
  });
  const response = (req: any, data: any) => {
    const writable =
      !opts.readOnly && (!req.apiScopes || req.apiScopes.includes('communications:write'));
    return {
      ...data,
      workflow_available: Boolean(opts.workflowAvailable),
      can_reply: Boolean(data.can_reply) && writable,
      can_note: Boolean(data.can_note) && writable,
      can_status:
        Boolean(data.can_status) &&
        writable &&
        (!req.apiScopes || req.apiScopes.includes('communications:read')),
      can_assign:
        Boolean(data.can_assign) &&
        Boolean(opts.workflowAvailable) &&
        writable &&
        (!req.apiScopes || req.apiScopes.includes('communications:read')),
    };
  };
  app.get('/api/customer-messages/assignees', async (req) => {
    if (!opts.available || !opts.workflowAvailable) return disabled();
    if (req.apiScopes)
      ensure(
        req.apiScopes.includes('communications:read'),
        403,
        'Klucz API nie ma zakresu wiadomości',
      );
    return response(req, {
      available: true,
      read_only: opts.readOnly,
      ...(await customerMessageAssignees(
        req.actor,
        customerWorkflowAssigneePage.parse(req.query).cursor,
      )),
    });
  });
  app.patch('/api/customer-messages/:id/assignment', async (req) => {
    write(req, true);
    ensure(opts.workflowAvailable, 503, 'Kopia nie zawiera przypisania wiadomości');
    if (req.apiScopes)
      ensure(
        req.apiScopes.includes('communications:read') &&
          req.apiScopes.includes('communications:write'),
        403,
        'Klucz API nie ma zakresów przypisania wiadomości',
      );
    return response(req, {
      available: true,
      read_only: opts.readOnly,
      ...(await changeCustomerMessageAssignment(
        req.actor,
        id(req.params),
        customerMessageAssignment.parse(req.body),
      )),
    });
  });
  // Order card timeline: email, SMS, portal and inbound email of this order or of the buyer.
  app.get('/api/orders/:id/communication', async (req) => {
    if (req.apiScopes)
      ensure(
        req.apiScopes.includes('communications:read'),
        403,
        'Klucz API nie ma zakresu wiadomości',
      );
    return orderCommunication(
      req.actor,
      id(req.params),
      orderCommunicationQuery.parse(req.query),
      opts.available,
      // A read-only copy keeps no register (as the CRM card hooks); a writable one records buyer reads.
      !opts.readOnly,
    );
  });
  app.get('/api/customer-messages', async (req) => {
    if (!opts.available) return disabled();
    return response(req, {
      available: true,
      read_only: opts.readOnly,
      ...(await customerMessageHistory(req.actor, customerMessageQuery.parse(req.query))),
    });
  });
  app.get('/api/customer-messages/:id', async (req) => {
    if (!opts.available) return disabled();
    return response(req, {
      available: true,
      read_only: opts.readOnly,
      ...(await customerMessageDetail(
        req.actor,
        id(req.params),
        customerMessagePage.parse(req.query),
      )),
    });
  });
  for (const kind of ['reply', 'note'] as const)
    app.post(
      '/api/customer-messages/:id/' + kind,
      { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
      async (req, reply) => {
        write(req);
        const result = await writeCustomerMessage(
          req.actor,
          id(req.params),
          kind,
          customerMessageInput.parse(req.body),
        );
        return reply
          .code(result.reused ? 200 : 201)
          .send({ ...result.message, reused: result.reused });
      },
    );
  app.patch('/api/customer-messages/:id', async (req) => {
    write(req, true);
    return response(req, {
      available: true,
      read_only: opts.readOnly,
      ...(await changeCustomerMessageStatus(
        req.actor,
        id(req.params),
        customerMessageStatus.parse(req.body),
      )),
    });
  });
  app.get(
    '/api/public/orders/:token/messages',
    { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (req, reply) => {
      reply
        .header('Cache-Control', 'no-store')
        .header('X-Robots-Tag', 'noindex, nofollow')
        .header('X-Content-Type-Options', 'nosniff');
      if (!opts.available)
        return {
          available: false,
          read_only: opts.readOnly,
          status: null,
          data: [],
          meta: { cursor: null },
        };
      const { token } = customerMessageToken.parse(req.params),
        ref = await resolveCustomerMessageToken(token);
      return {
        available: true,
        read_only: opts.readOnly,
        ...(await publicCustomerMessageRead(ref, token, customerMessagePage.parse(req.query))),
      };
    },
  );
  app.post(
    '/api/public/orders/:token/messages',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req, reply) => {
      reply.header('Cache-Control', 'no-store').header('X-Robots-Tag', 'noindex, nofollow');
      write(req);
      const { token } = customerMessageToken.parse(req.params),
        ref = await resolveCustomerMessageToken(token),
        result = await publicCustomerMessageWrite(ref, token, customerMessageInput.parse(req.body));
      return reply
        .code(result.reused ? 200 : 201)
        .send({ ...result.message, reused: result.reused, status: result.status });
    },
  );
  // 245 (COM-008): marketplace and helpdesk conversations in the same inbox; API keys need the communication scopes.
  const scoped = (req: any, writing: boolean) => {
    if (writing) ensure(!opts.readOnly, 423, 'Podgląd kopii: wiadomości i zmiany statusu są wyłączone');
    if (req.apiScopes)
      ensure(
        req.apiScopes.includes('communications:read') && (!writing || req.apiScopes.includes('communications:write')),
        403,
        'Klucz API nie ma zakresów komunikacji',
      );
  };
  app.get('/api/channel-inbox', (req) => (scoped(req, false), channelInbox(req.actor)));
  app.post('/api/channel-inbox/connections', async (req, reply) => {
    scoped(req, true);
    return reply.code(201).send(await createChannelConnection(req.actor, req.body));
  });
  app.post('/api/channel-inbox/connections/:id/messages', { bodyLimit: 262144 }, (req) => (scoped(req, true), ingestChannelMessages(req.actor, id(req.params), req.body)));
  app.get('/api/channel-inbox/threads', (req) => (scoped(req, false), channelThreads(req.actor, req.query)));
  app.get('/api/channel-inbox/threads/:id', (req) => (scoped(req, false), channelThread(req.actor, id(req.params))));
  app.patch('/api/channel-inbox/threads/:id', (req) => (scoped(req, true), changeChannelThread(req.actor, id(req.params), req.body)));
  app.post('/api/channel-inbox/threads/:id/messages', async (req, reply) => {
    scoped(req, true);
    const r = await addChannelMessage(req.actor, id(req.params), req.body);
    return reply.code(r.reused ? 200 : 201).send(r);
  });
  app.get('/api/orders/:id/channel-threads', (req) => (scoped(req, false), orderChannelThreads(req.actor, id(req.params))));
}
