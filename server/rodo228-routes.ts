/** Session routes of the 228 RODO tools, administrator only: the customer's data export
 * (ZIP with JSON and CSV), anonymisation preview and confirmation, the access register,
 * the anonymisation requests, the fields kept until their due date and the register
 * retention. Always registered; without 228 every call is 503, in a read-only copy 423. */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { tenantReadTx, tenantTx } from './db';
import { ensure } from './errors';
import { subjectInput, warsawDay } from './rodo228-model';
import {
  actorNames, confirmAnonymisation, exportCustomer, listAccessLogInTx, listRequestsInTx, listRetainedInTx, previewAnonymisation, purgeAccessLogInTx,
  saveSettingsInTx, settingsInTx, type RodoActor, type RodoOptions,
} from './rodo228';

export type Rodo228Service = {
  exportCustomer: typeof exportCustomer; previewAnonymisation: typeof previewAnonymisation; confirmAnonymisation: typeof confirmAnonymisation;
  accessLog(a: RodoActor, query: unknown, key: string): Promise<{ data: Record<string, any>[]; next: string | null }>;
  names: typeof actorNames; requests(a: RodoActor): Promise<unknown[]>; retained(a: RodoActor, today: string, onlyDue: boolean): Promise<unknown[]>;
  settings(a: RodoActor): Promise<unknown>; saveSettings(a: RodoActor, body: unknown): Promise<unknown>; purge(a: RodoActor): Promise<number>;
};
export const defaultRodo228Service: Rodo228Service = {
  exportCustomer, previewAnonymisation, confirmAnonymisation,
  accessLog: (a, q, key) => tenantReadTx(a.tenantId, c => listAccessLogInTx(c, a, q, key)),
  names: actorNames,
  requests: a => tenantReadTx(a.tenantId, c => listRequestsInTx(c)),
  retained: (a, today, onlyDue) => tenantReadTx(a.tenantId, c => listRetainedInTx(c, today, onlyDue)),
  settings: a => tenantReadTx(a.tenantId, c => settingsInTx(c)),
  saveSettings: (a, body) => tenantTx(a.tenantId, c => saveSettingsInTx(c, a, body)),
  purge: a => tenantTx(a.tenantId, c => purgeAccessLogInTx(c)),
};
export type Rodo228RouteOptions = { available: boolean; readOnly: boolean; pool: Pool; key: string; now?: () => Date; service?: Rodo228Service };

const id = (p: unknown) => z.strictObject({ id: z.uuid().transform(v => v.toLowerCase()) }).parse(p).id;
const purposeOf = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 160) : 'Wniosek klienta o dostęp do danych (art. 15 i 20 RODO)');

export function registerRodo228Routes(app: FastifyInstance, opts: Rodo228RouteOptions) {
  const service = opts.service ?? defaultRodo228Service, o: RodoOptions = { key: opts.key, ...(opts.now ? { now: opts.now } : {}) };
  const admin = (req: FastifyRequest, write: boolean): RodoActor => {
    ensure(opts.available, 503, 'Narzędzia RODO (migracja 228) są niedostępne w tej kopii');
    const a = (req as any).actor as RodoActor | undefined;
    ensure(a?.userId && !(req as any).apiScopes && !a.apiKeyId && a.source !== 'api', 403, 'Narzędzia RODO wymagają sesji administratora (klucz API nie wystarczy)');
    ensure(a.role === 'admin', 403, 'Eksport, anonimizacja i rejestr dostępu do danych osobowych są dostępne tylko dla administratora');
    ensure(!write || !opts.readOnly, 423, 'Ta kopia jest tylko do odczytu — rejestr dostępu nie może zostać zapisany');
    return { tenantId: a.tenantId, userId: a.userId, role: a.role, source: 'manual' };
  };
  const subjectOf = (raw: Record<string, unknown>) => subjectInput.parse(Object.fromEntries(Object.entries(raw).filter(([k]) => ['crm_client_id', 'email', 'phone'].includes(k))));

  app.get('/api/rodo228/status', async req => {
    const a = admin(req, false);
    return { available: true, read_only: opts.readOnly, today: warsawDay((opts.now ?? (() => new Date()))()), settings: await service.settings(a) };
  });
  // Export is a write: the access register records it before the archive leaves.
  app.get('/api/rodo228/export', async (req, reply) => {
    const raw = z.record(z.string(), z.string()).parse(req.query ?? {});
    ensure(Object.keys(raw).every(k => ['crm_client_id', 'email', 'phone', 'purpose'].includes(k)), 422, 'Nieznany parametr eksportu');
    const a = admin(req, true), r = await service.exportCustomer(a, subjectOf(raw), purposeOf(raw.purpose), o);
    const stamp = warsawDay((opts.now ?? (() => new Date()))());
    reply.header('Content-Type', 'application/zip').header('Content-Disposition', `attachment; filename="dane-klienta-${stamp}.zip"`)
      .header('Cache-Control', 'private, no-store').header('X-Content-Type-Options', 'nosniff');
    return reply.send(r.archive);
  });
  app.post('/api/rodo228/anonymisation/preview', async req => {
    const a = admin(req, true);
    return service.previewAnonymisation(a, subjectOf(z.record(z.string(), z.unknown()).parse(req.body ?? {})), o);
  });
  app.post('/api/rodo228/anonymisation/:id/confirm', async req => {
    const a = admin(req, true), b = z.strictObject({ plan_sha256: z.string().regex(/^[a-f0-9]{64}$/, 'Brak potwierdzenia podglądu') }).parse(req.body ?? {});
    return service.confirmAnonymisation(a, id(req.params), b.plan_sha256, o);
  });
  app.get('/api/rodo228/access-log', async req => {
    const a = admin(req, false), page = await service.accessLog(a, req.query, opts.key);
    const names = await service.names(opts.pool, a.tenantId, [...new Set(page.data.map(r => r.actor_id))], [...new Set(page.data.map(r => r.api_key_id).filter(Boolean))]);
    return { ...page, data: page.data.map(r => ({ ...r, actor: names.users[r.actor_id] ?? null, api_key: r.api_key_id ? names.keys[r.api_key_id] ?? null : null })) };
  });
  app.post('/api/rodo228/access-log/purge', async req => ({ deleted: await service.purge(admin(req, true)) }));
  app.get('/api/rodo228/requests', async req => ({ data: await service.requests(admin(req, false)) }));
  app.get('/api/rodo228/retained', async req => {
    const q = z.strictObject({ due: z.enum(['1', '0']).default('0') }).parse(req.query ?? {}), a = admin(req, false);
    const today = warsawDay((opts.now ?? (() => new Date()))());
    return { today, data: await service.retained(a, today, q.due === '1') };
  });
  app.put('/api/rodo228/settings', async req => ({ settings: await service.saveSettings(admin(req, true), req.body) }));
}
