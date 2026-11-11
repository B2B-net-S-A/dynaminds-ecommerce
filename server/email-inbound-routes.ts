import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ensure } from './errors';
import * as S from './email-inbound';
import * as V from './email-inbound-schema';
import * as A from './inbound-auto253';
export function registerEmailInboundRoutes(
  app: FastifyInstance,
  config: { available: boolean; readOnly: boolean },
) {
  const actor = (req: any): V.EmailInboundActor => ({
    ...req.actor,
    ...(req.apiScopes ? { apiKeyId: req.currentUser?.api_key_id, source: 'api' as const } : {}),
  });
  const id = (req: any) => z.strictObject({ id: z.uuid() }).parse(req.params).id;
  const empty = (req: any) => z.strictObject({}).parse(req.query);
  const mask = (r: any) => ({
    ...r,
    read_only: config.readOnly,
    can_write: !config.readOnly && r.can_write,
    can_manage_accounts: !config.readOnly && r.can_manage_accounts,
    ...(r.acquisition
      ? {
          acquisition: {
            ...r.acquisition,
            can_reconcile: !config.readOnly && r.acquisition.can_reconcile,
          },
        }
      : {}),
    ...(r.preview
      ? { preview: { ...r.preview, can_import: !config.readOnly && r.preview.can_import } }
      : {}),
    ...(r.message
      ? {
          message: {
            ...r.message,
            can_bind: !config.readOnly && r.message.can_bind,
            can_reply: !config.readOnly && r.message.can_reply,
          },
        }
      : {}),
    ...(r.reply_preview
      ? {
          reply_preview: {
            ...r.reply_preview,
            can_queue: !config.readOnly && r.reply_preview.can_queue,
          },
        }
      : {}),
    ...(config.readOnly && Array.isArray(r.data)
      ? {
          data: r.data.map((x: any) => ({
            ...x,
            ...('can_reconcile' in x ? { can_reconcile: false } : {}),
            ...('can_bind' in x ? { can_bind: false, can_reply: false } : {}),
          })),
        }
      : {}),
  });
  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0].replace(/^\/api\/v1\//, '/api/');
    const prefix = '/api/email-inbound';
    if (path !== prefix && !path.startsWith(prefix + '/')) return;
    reply.header('Cache-Control', 'no-store');
    const writing = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
    if (writing) ensure(!config.readOnly, 423, 'Odtworzona kopia jest tylko do odczytu');
    const available = await S.inboundAvailable();
    if (writing || !['/options', '/accounts'].some((p) => path === prefix + p))
      ensure(config.available && available, 503, 'Kopia nie zawiera kompletnego odbioru email');
    if (req.apiScopes) {
      ensure(
        req.apiScopes.includes('communications:read') &&
          (!writing || req.apiScopes.includes('communications:write')),
        403,
        'Klucz API nie ma zakresów komunikacji',
      );
      if (writing && /^\/api\/email-inbound\/accounts(?:\/[^/]+)?$/.test(path))
        ensure(
          req.apiScopes.includes('integrations:write'),
          403,
          'Klucz API nie ma zakresu konfiguracji konta',
        );
      if (/\/(?:bind|reply-previews)$/.test(path) || /\/reply-previews\/[^/]+\/queue$/.test(path))
        ensure(req.apiScopes.includes('orders:read'), 403, 'Klucz API nie ma zakresu zamówień');
    }
  });
  const mutation = async (reply: any, result: Promise<any>, created = true) => {
    const r = await result;
    return reply.code(created && !r.reused ? 201 : 200).send(mask(r));
  };
  app.get('/api/email-inbound/options', async (req) => {
    empty(req);
    return mask(await S.inboundOptions(actor(req)));
  });
  app.get('/api/email-inbound/accounts', async (req) => {
    empty(req);
    return mask(await S.inboundAccounts(actor(req)));
  });
  app.post('/api/email-inbound/accounts', { bodyLimit: 16384 }, async (req, reply) => {
    empty(req);
    return mutation(
      reply,
      S.createInboundAccount(actor(req), V.inboundAccountCreateInput.parse(req.body)),
    );
  });
  app.patch('/api/email-inbound/accounts/:id', { bodyLimit: 16384 }, async (req, reply) => {
    empty(req);
    return mutation(
      reply,
      S.updateInboundAccount(actor(req), id(req), V.inboundAccountUpdateInput.parse(req.body)),
      false,
    );
  });
  app.post('/api/email-inbound/accounts/:id/previews', { bodyLimit: 16384 }, async (req, reply) => {
    empty(req);
    return mutation(
      reply,
      S.prepareInboundEmail(actor(req), id(req), V.inboundFetchInput.parse(req.body)),
    );
  });
  app.get('/api/email-inbound/acquisitions', async (req) =>
    mask(await S.inboundAcquisitions(actor(req), V.inboundHistoryInput.parse(req.query))),
  );
  app.get('/api/email-inbound/acquisitions/:id', async (req) => {
    empty(req);
    return mask(await S.inboundAcquisition(actor(req), id(req)));
  });
  app.post(
    '/api/email-inbound/acquisitions/:id/reconcile',
    { bodyLimit: 16384 },
    async (req, reply) => {
      empty(req);
      return mutation(
        reply,
        S.reconcileInboundAcquisition(actor(req), id(req), V.inboundReconcileInput.parse(req.body)),
        false,
      );
    },
  );
  app.get('/api/email-inbound/previews', async (req) =>
    mask(await S.inboundPreviews(actor(req), V.inboundHistoryInput.parse(req.query))),
  );
  app.get('/api/email-inbound/previews/:id', async (req) => {
    empty(req);
    return mask(await S.inboundPreview(actor(req), id(req)));
  });
  app.post('/api/email-inbound/previews/:id/import', { bodyLimit: 16384 }, async (req, reply) => {
    empty(req);
    return mutation(
      reply,
      S.importInboundEmail(actor(req), id(req), V.inboundImportInput.parse(req.body)),
    );
  });
  app.get('/api/email-inbound/imports/:id', async (req) => {
    empty(req);
    return mask(await S.inboundImport(actor(req), id(req)));
  });
  app.get('/api/email-inbound/messages', async (req) =>
    mask(await S.inboundMessages(actor(req), V.inboundListInput.parse(req.query))),
  );
  app.get('/api/email-inbound/messages/:id', async (req) => {
    empty(req);
    return mask(await S.inboundMessage(actor(req), id(req)));
  });
  app.post('/api/email-inbound/messages/:id/bind', { bodyLimit: 16384 }, async (req, reply) => {
    empty(req);
    return mutation(
      reply,
      S.bindInboundEmail(actor(req), id(req), V.inboundBindInput.parse(req.body)),
    );
  });
  app.post(
    '/api/email-inbound/messages/:id/reply-previews',
    { bodyLimit: 131072 },
    async (req, reply) => {
      empty(req);
      return mutation(
        reply,
        S.previewInboundReply(actor(req), id(req), V.inboundReplyPreviewInput.parse(req.body)),
      );
    },
  );
  app.get('/api/email-inbound/reply-previews/:id', async (req) => {
    empty(req);
    return mask(await S.inboundReplyPreview(actor(req), id(req)));
  });
  app.post(
    '/api/email-inbound/reply-previews/:id/queue',
    { bodyLimit: 16384 },
    async (req, reply) => {
      empty(req);
      return mutation(
        reply,
        S.queueInboundReply(actor(req), id(req), V.inboundReplyQueueInput.parse(req.body)),
      );
    },
  );
  app.get('/api/email-inbound/replies', async (req) =>
    mask(await S.inboundReplies(actor(req), V.inboundRepliesInput.parse(req.query))),
  );
  app.get('/api/email-inbound/replies/:id', async (req) => {
    empty(req);
    return mask(await S.inboundReply(actor(req), id(req)));
  });
  app.get('/api/email-inbound/messages/:id/attachments/:index/content', async (req) => {
    const p = z
      .strictObject({ id: z.uuid(), index: z.coerce.number().int().min(0).max(9) })
      .parse(req.params);
    const q = V.inboundContentQuery.parse(req.query),
      a = actor(req);
    ensure(q.workspace_id === a.tenantId, 404, 'Załącznik nie należy do obszaru');
    return mask(await S.inboundAttachmentContent(a, p.id, p.index));
  });
  // 245 (COM-005): periodic reading and automatic assignment, administrator session only.
  app.get('/api/email-inbound/schedules', async (req) => {
    empty(req);
    return A.inboundSchedules(actor(req));
  });
  app.put('/api/email-inbound/schedules/:id', { bodyLimit: 4096 }, async (req) => A.saveInboundSchedule(actor(req), id(req), req.body));
  app.get('/api/email-inbound/matches', async (req) => {
    empty(req);
    return A.inboundMatches(actor(req));
  });
}
