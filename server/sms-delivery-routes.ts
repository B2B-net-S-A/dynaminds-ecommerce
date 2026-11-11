import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { DeliveryRefusal, parseSmsApiCallback, requireSmsApiCallbackToken, requireSmsApiPeer, SMSAPI_CALLBACK_TOKEN, type DeliveryEvent } from './sms-delivery';
import type { SmsEndpoint as CallbackEndpoint } from './sms-submission-store';
export function registerSmsDeliveryCallbacks(app: FastifyInstance, deps: {
  readOnly: boolean;
  // Trusted server mapping, not tenant supplied by query; default application must NOT register until supplied.
  // callbackToken comes from the channel's encrypted credentials; null = endpoint predates the token.
  resolveEndpoint: (id: string) => Promise<(CallbackEndpoint & { callbackToken: string | null }) | null>;
  // Must atomically commit the entire <=5 report batch in tenantTx before returning.
  reconcile: (endpoint: CallbackEndpoint, events: DeliveryEvent[]) => Promise<void>;
}) {
  app.register(async callback => {
    callback.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: 8192 }, (_req, text, done) => {
      const params = new URLSearchParams(String(text));
      const body = Object.create(null) as Record<string, unknown>;
      for (const name of new Set(params.keys())) {
        const all = params.getAll(name);body[name] = all.length === 1 ? all[0] : all;
      }
      done(null, body);
    });
    const handler = async (req: FastifyRequest, reply: FastifyReply) => {
      reply.header('Cache-Control', 'no-store');
      try {
        if (deps.readOnly) throw new DeliveryRefusal(423);
        requireSmsApiPeer(req.raw.socket.remoteAddress); // Never X-Forwarded-For or caller-controlled req.ip.
        if (req.url.length > 8192) throw new DeliveryRefusal(413);
        const { endpointId: id, token } = req.params as { endpointId: string; token?: string };
        if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(id)) throw new DeliveryRefusal(404);
        // Missing/malformed token: same 404 as an unknown endpoint, before any DB read.
        if (!token || !SMSAPI_CALLBACK_TOKEN.test(token)) throw new DeliveryRefusal(404);
        if (req.method === 'POST' && req.headers['content-type']?.split(';')[0] !== 'application/x-www-form-urlencoded') throw new DeliveryRefusal(415);
        const endpoint = await deps.resolveEndpoint(id);
        if (!endpoint?.enabled) throw new DeliveryRefusal(404);
        requireSmsApiCallbackToken(endpoint.callbackToken, token);
        const reports = parseSmsApiCallback(req.method === 'GET' ? req.query : req.body);
        await deps.reconcile(endpoint, reports);
        return reply.type('text/plain; charset=utf-8').send('OK');
      } catch (error) {
        // No recipient, account, incoming URL, provider body or DB error in responses/logs.
        return reply.code(error instanceof DeliveryRefusal ? error.status : 503).type('text/plain').send('Callback not acknowledged');
      }
    };
    const route = { method: ['GET', 'POST'] as ('GET' | 'POST')[], bodyLimit: 8192, logLevel: 'silent' as const, handler };
    callback.route({ ...route, url: '/callbacks/smsapi/:endpointId/:token' });
    // Pre-token URL stays an explicit refusal (never an SPA fallback page that could look like an ACK).
    callback.route({ ...route, url: '/callbacks/smsapi/:endpointId' });
  });
}
