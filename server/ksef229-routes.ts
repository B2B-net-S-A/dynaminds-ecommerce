/** Routes of the 229 KSeF step. Settings (Ustawienia → KSeF): administrator with a session only;
 * the secret is write-only (masked in every reply). Sending, offline issue, status and the
 * "Kolejka KSeF": administrator or operator (session, or API key with documents:write); reading
 * the status, the UPO and the sent file: any role (or documents:read). Always registered;
 * without 229 every call is 503, writes in a read-only copy 423. */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { tenantReadTx, tenantTx } from './db';
import { ensure } from './errors';
import { KSEF_BASE_URLS, KSEF_REAL_ENABLED } from './ksef229-client';
import { ksefConfigInput, ksefNipParam, ksefOfflineInput, ksefQueueInput, warsawDay } from './ksef229-model';
import {
  checkConnection, documentKsef, downloadOf, listConfigsInTx, markOffline, queueInTx, refreshDocument, saveConfigInTx, sendDocument, sendQueue,
  type Ksef229Options, type KsefActor,
} from './ksef229';
import type { Fa3Request } from './fa3-documents';

export type Ksef229Service = {
  configs(a: KsefActor): Promise<unknown[]>; saveConfig(a: KsefActor, nip: string, body: z.infer<typeof ksefConfigInput>): Promise<unknown>;
  check(a: KsefActor, nip: string): Promise<unknown>; document(a: KsefActor, id: string): Promise<unknown>;
  send(req: Fa3Request, a: KsefActor, id: string): Promise<unknown>; offline(req: Fa3Request, a: KsefActor, id: string, body: z.infer<typeof ksefOfflineInput>): Promise<unknown>;
  refresh(req: Fa3Request, a: KsefActor, id: string): Promise<unknown>; download(a: KsefActor, id: string, what: 'upo' | 'xml'): Promise<{ body: string; filename: string }>;
  queue(a: KsefActor): Promise<unknown[]>; sendQueue(req: Fa3Request, a: KsefActor, ids: string[] | undefined): Promise<unknown>;
};
export function ksef229Service(o: Ksef229Options): Ksef229Service {
  return {
    configs: a => tenantReadTx(a.tenantId, c => listConfigsInTx(c)),
    saveConfig: (a, nip, b) => tenantTx(a.tenantId, c => saveConfigInTx(c, a, nip, b, o.key)),
    check: (a, nip) => checkConnection(a, nip, o),
    document: (a, id) => documentKsef(a, id, o),
    send: (req, a, id) => sendDocument(req, a, id, o),
    offline: (req, a, id, b) => markOffline(req, a, id, b.mode, b.emergency_end, o),
    refresh: (req, a, id) => refreshDocument(req, a, id, o),
    download: (a, id, what) => downloadOf(a, id, what),
    queue: a => tenantReadTx(a.tenantId, c => queueInTx(c, warsawDay((o.now ?? (() => new Date()))()))),
    sendQueue: (req, a, ids) => sendQueue(req, a, ids, o),
  };
}
export type Ksef229RouteOptions = { available: boolean; readOnly: boolean; service: Ksef229Service };

const id = (p: unknown) => z.strictObject({ id: z.uuid().transform(v => v.toLowerCase()) }).parse(p).id;
const empty = z.strictObject({});
const READ = ['admin', 'operator', 'viewer'], WRITE = ['admin', 'operator'];

export function registerKsef229Routes(app: FastifyInstance, opts: Ksef229RouteOptions) {
  const s = opts.service;
  const actor = (req: FastifyRequest, o: { roles: string[]; write: boolean; scope?: string; sessionOnly?: boolean }): KsefActor => {
    ensure(opts.available, 503, 'KSeF (migracja 229) jest niedostępny w tej kopii');
    const a = (req as any).actor as (KsefActor & { source?: string }) | undefined, scopes = (req as any).apiScopes as string[] | undefined;
    ensure(a?.userId, 401, 'Brak sesji');
    const api = Boolean(scopes || a.apiKeyId || a.source === 'api');
    ensure(!api || !o.sessionOnly, 403, 'Ustawienia KSeF wymagają sesji administratora (klucz API nie wystarczy)');
    ensure(!api || (o.scope && scopes?.includes(o.scope)), 403, 'Wymagane scope: ' + (o.scope ?? 'sesja'));
    ensure(o.roles.includes(a.role), 403, o.roles.length === 1 ? 'Ustawienia KSeF zmienia tylko administrator' : o.write ? 'Wysyłka do KSeF wymaga roli administratora lub operatora' : 'Brak uprawnień do KSeF');
    ensure(!o.write || !opts.readOnly, 423, 'Ta kopia jest tylko do odczytu');
    return { tenantId: a.tenantId, userId: a.userId, role: a.role, ...(a.apiKeyId ? { apiKeyId: a.apiKeyId } : {}) };
  };
  const fa3 = (req: FastifyRequest) => req as unknown as Fa3Request;
  const noStore = (reply: any) => reply.header('Cache-Control', 'private, no-store');

  app.get('/api/ksef229/status', async (req, reply) => {
    empty.parse(req.query); const a = actor(req, { roles: READ, write: false, scope: 'documents:read' }); noStore(reply);
    return { available: true, read_only: opts.readOnly, real_mf_enabled: KSEF_REAL_ENABLED, mf_environments: KSEF_BASE_URLS,
      can_configure: a.role === 'admin' && !opts.readOnly, can_send: WRITE.includes(a.role) && !opts.readOnly };
  });
  app.get('/api/ksef229/configs', async (req, reply) => {
    empty.parse(req.query); const a = actor(req, { roles: ['admin'], write: false, sessionOnly: true }); noStore(reply);
    return { configs: await s.configs(a) };
  });
  app.put('/api/ksef229/configs/:nip', async (req, reply) => {
    empty.parse(req.query); const a = actor(req, { roles: ['admin'], write: true, sessionOnly: true }); noStore(reply);
    const { nip } = ksefNipParam.parse(req.params);
    return { config: await s.saveConfig(a, nip, ksefConfigInput.parse(req.body)) };
  });
  app.post('/api/ksef229/configs/:nip/check', async (req, reply) => {
    empty.parse(req.query); const a = actor(req, { roles: ['admin'], write: true, sessionOnly: true }); noStore(reply);
    return s.check(a, ksefNipParam.parse(req.params).nip);
  });
  app.get('/api/ksef229/documents/:id', async (req, reply) => {
    empty.parse(req.query); const a = actor(req, { roles: READ, write: false, scope: 'documents:read' }); noStore(reply);
    return s.document(a, id(req.params));
  });
  app.post('/api/ksef229/documents/:id/send', async (req, reply) => {
    empty.parse(req.query); const a = actor(req, { roles: WRITE, write: true, scope: 'documents:write' }); noStore(reply);
    return s.send(fa3(req), a, id(req.params));
  });
  app.post('/api/ksef229/documents/:id/offline', async (req, reply) => {
    empty.parse(req.query); const a = actor(req, { roles: WRITE, write: true, scope: 'documents:write' }); noStore(reply);
    return s.offline(fa3(req), a, id(req.params), ksefOfflineInput.parse(req.body));
  });
  app.post('/api/ksef229/documents/:id/refresh', async (req, reply) => {
    empty.parse(req.query); const a = actor(req, { roles: WRITE, write: true, scope: 'documents:write' }); noStore(reply);
    return s.refresh(fa3(req), a, id(req.params));
  });
  for (const [path, what] of [['upo.xml', 'upo'], ['sent.xml', 'xml']] as const)
    app.get(`/api/ksef229/documents/:id/${path}`, async (req, reply) => {
      empty.parse(req.query); const a = actor(req, { roles: READ, write: false, scope: 'documents:read' });
      const f = await s.download(a, id(req.params), what);
      return noStore(reply).type('application/xml; charset=utf-8').header('X-Content-Type-Options', 'nosniff')
        .header('Content-Disposition', `attachment; filename="${f.filename.replace(/[^A-Za-z0-9._-]/g, '_')}"`).send(f.body);
    });
  app.get('/api/ksef229/queue', async (req, reply) => {
    empty.parse(req.query); const a = actor(req, { roles: READ, write: false, scope: 'documents:read' }); noStore(reply);
    return { today: warsawDay(new Date()), items: await s.queue(a) };
  });
  app.post('/api/ksef229/queue/send', async (req, reply) => {
    empty.parse(req.query); const a = actor(req, { roles: WRITE, write: true, scope: 'documents:write' }); noStore(reply);
    return s.sendQueue(fa3(req), a, ksefQueueInput.parse(req.body ?? {}).ids);
  });
}
