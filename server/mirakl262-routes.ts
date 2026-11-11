/** Routes of the Mirakl operations (migration 252, docs/parity/MIRAKL252-20261028.md):
 * - /api/integrations/:id/mirakl262 (state), /schedule, /schedule/run, /offers, /fulfillment, /operations/:op/reconcile,
 *   /webhook (admin session only), /simulation/seed (SYMULACJA, only with DYNA_MIRAKL_FAKE=local);
 * - /callbacks/mirakl/:endpoint/:token (operator notifications: secret path token, JSON only, bounded body, rate limit). */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { Problem } from './errors';
import {
  enqueueMirakl262Fulfillment, enqueueMirakl262Offers, handleMirakl262Webhook, MIRAKL262_WEBHOOK_MAX_BYTES, readMirakl262State,
  reconcileMirakl262Operation, rotateMirakl262Webhook, runMirakl262ScheduleNow, saveMirakl262Schedule, seedMirakl262Simulation,
} from './mirakl262';

const ids = (params: unknown) => z.object({ id: z.string().max(64), op: z.string().max(64).optional() }).parse(params);
const created = (reply: FastifyReply, r: { reused: boolean }) => reply.code(r.reused ? 200 : 201).send(r);
export function registerMirakl262Routes(app: FastifyInstance, { readOnly }: { readOnly: boolean }) {
  const writable = () => { if (readOnly) throw new Problem(423, 'Podgląd kopii — operacje Mirakl są wyłączone'); };
  const path = '/api/integrations/:id/mirakl262';
  app.get(path, { logLevel: 'silent' }, (req) => readMirakl262State(req.actor, ids(req.params).id));
  app.put(path + '/schedule', { logLevel: 'silent' }, (req) => { writable(); return saveMirakl262Schedule(req.actor, ids(req.params).id, req.body); });
  app.post(path + '/schedule/run', { logLevel: 'silent' }, (req) => { writable(); return runMirakl262ScheduleNow(req.actor, ids(req.params).id); });
  app.post(path + '/offers', { logLevel: 'silent' }, async (req, reply) => { writable(); return created(reply, await enqueueMirakl262Offers(req.actor, ids(req.params).id, req.body)); });
  app.post(path + '/fulfillment', { logLevel: 'silent' }, async (req, reply) => { writable(); return created(reply, await enqueueMirakl262Fulfillment(req.actor, ids(req.params).id, req.body)); });
  app.post(path + '/operations/:op/reconcile', { logLevel: 'silent' }, (req) => { writable(); const p = ids(req.params); return reconcileMirakl262Operation(req.actor, p.id, z.uuid().parse(p.op)); });
  app.post(path + '/webhook', { logLevel: 'silent' }, (req) => { writable(); return rotateMirakl262Webhook(req.actor, ids(req.params).id); });
  app.post(path + '/simulation/seed', { logLevel: 'silent' }, (req) => { writable(); return seedMirakl262Simulation(req.actor, ids(req.params).id, req.body); });

  app.register(async (callback) => {
    // The body is kept as bytes and parsed only after the token matched.
    callback.removeContentTypeParser('application/json');
    callback.addContentTypeParser('application/json', { parseAs: 'buffer', bodyLimit: MIRAKL262_WEBHOOK_MAX_BYTES }, (_req, body, done) => done(null, body));
    callback.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: MIRAKL262_WEBHOOK_MAX_BYTES }, (_req, body, done) => done(null, body));
    callback.route({
      method: 'POST',
      url: '/callbacks/mirakl/:endpoint/:token',
      bodyLimit: MIRAKL262_WEBHOOK_MAX_BYTES,
      // The path carries the secret: never logged.
      logLevel: 'silent',
      config: { rateLimit: { max: 240, timeWindow: '1 minute' } },
      errorHandler: (error, _req, reply) => {
        const status = (error as { statusCode?: number }).statusCode;
        reply.code(status === 413 ? 413 : status === 415 ? 415 : 400).header('Cache-Control', 'no-store').type('text/plain; charset=utf-8').send('Event not acknowledged');
      },
      handler: async (req, reply) => {
        const { endpoint, token } = req.params as { endpoint: string; token: string };
        let code: number;
        try {
          code = await handleMirakl262Webhook({ endpointId: String(endpoint), token: String(token), contentType: req.headers['content-type'],
            raw: Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0) }, readOnly);
        } catch (e) {
          code = e instanceof Problem && e.status < 500 ? 409 : 503;
        }
        return reply.code(code).header('Cache-Control', 'no-store').type('text/plain; charset=utf-8').send(code === 200 ? 'OK' : 'Event not acknowledged');
      },
    });
  });
}
