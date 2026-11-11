import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { ensure } from './errors';
import { createIntegrationRecoveryQuery } from './integration-recovery-query';

const rawQuery = z.strictObject({
  provider: z.enum(['shopify', 'amazon', 'ebay']).optional(),
  execution: z.enum(['all', 'live', 'simulation']).optional(),
  limit: z.literal('50').optional(),
  after: z.string().min(1).max(2048).optional(),
});
/** Parse actual URL text so duplicate keys cannot be silently collapsed by the
 * framework query parser. Null is represented solely by an omitted parameter. */
export function normalizeIntegrationRecoveryQuery(url: string) {
  const params = new URLSearchParams(url.includes('?') ? url.slice(url.indexOf('?') + 1) : '');
  const raw: Record<string, string> = {};
  for (const [key, value] of params) {
    ensure(!Object.hasOwn(raw, key), 422, 'Powtórzony parametr kolejki');
    ensure(['provider', 'execution', 'limit', 'after'].includes(key), 422, 'Nieznany parametr kolejki');
    raw[key] = value;
  }
  const parsed = rawQuery.parse(raw);
  return {
    provider: parsed.provider ?? null,
    execution: parsed.execution ?? 'all',
    limit: 50 as const,
    after: parsed.after ?? null,
  };
}

/** GET only. The existing app onRoute/publicOperations mechanism registers v1
 * aliases; this module does not invent an auth or provider operation. */
export function registerIntegrationRecoveryRoutes(
  app: FastifyInstance,
  context: { pool: Pool; cursorKey: string; sessionName: string; readOnly: boolean },
) {
  const service = createIntegrationRecoveryQuery({
    pool: context.pool,
    cursorKey: context.cursorKey,
    sessionName: context.sessionName,
    restorePreview: context.readOnly,
  });
  app.get('/api/integrations/recovery-queue', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    return service.list(req, normalizeIntegrationRecoveryQuery(req.url));
  });
  app.get('/api/integrations/recovery-queue/identity', async (req, reply) => {
    ensure(![...new URLSearchParams(req.url.includes('?') ? req.url.slice(req.url.indexOf('?') + 1) : '')].length, 422, 'Tożsamość kolejki nie przyjmuje parametrów');
    reply.header('cache-control', 'no-store');
    return service.identity(req);
  });
}
