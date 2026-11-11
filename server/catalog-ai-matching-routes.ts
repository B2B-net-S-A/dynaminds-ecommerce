import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { ensure } from './errors';
import type { Transport } from './integrations';
import { withAllegroRequestContext, type IntegrationContext } from './channel-access';
import {
  matchRequest,
  queueCatalogAiMatch,
  listCatalogAiMatches,
  acceptCatalogAiMatch,
  rejectCatalogAiMatch,
  cancelCatalogAiMatch,
} from './catalog-ai-matching';

/** True when the prepared migration (catalog_ai_match_proposals) is installed in this database. */
export async function catalogAiMatchesAvailable(pool: Pool): Promise<boolean> {
  return Boolean((await pool.query("SELECT to_regclass('public.catalog_ai_match_proposals') present")).rows[0].present);
}

/** DOM-AI-005 routes. Admin only; guards (role, read-only copy, missing table) run before any database access. */
export function registerCatalogAiMatchRoutes(
  app: FastifyInstance,
  options: { available: boolean; readOnly: boolean; transport?: Transport; context?: IntegrationContext },
) {
  const admin = (req: any) => ensure(req.actor?.role === 'admin', 403, 'Dopasowanie AI jest dostępne dla administratora');
  const write = (req: any) => {
    admin(req);
    ensure(!options.readOnly, 423, 'Podgląd odtworzonej kopii jest tylko do odczytu. Operacja nie została wykonana.');
    ensure(options.available, 503, 'Kopia nie zawiera modułu dopasowania AI');
  };
  const id = (req: FastifyRequest) => z.object({ id: z.uuid() }).parse(req.params).id;
  app.get('/api/products/:id/ai/matches', async (req: any) => {
    admin(req);
    const q = z.object({ integration_id: z.uuid().optional() }).parse(req.query);
    if (!options.available) return { available: false, accepted: null, data: [] };
    return listCatalogAiMatches(req.actor, id(req), q.integration_id);
  });
  app.post('/api/products/:id/ai/matches', async (req: any, reply) => {
    write(req);
    const input = matchRequest.parse(req.body);
    return reply.code(201).send(
      await queueCatalogAiMatch(req.actor, id(req), input, {
        transport: options.transport,
        context: withAllegroRequestContext(options.context ?? {}, req),
      }),
    );
  });
  app.post('/api/ai/catalog/matches/:id/accept', async (req: any) => {
    write(req);
    return acceptCatalogAiMatch(req.actor, id(req), req.body);
  });
  app.post('/api/ai/catalog/matches/:id/reject', async (req: any) => {
    write(req);
    return rejectCatalogAiMatch(req.actor, id(req), req.body);
  });
  app.post('/api/ai/catalog/matches/:id/cancel', async (req: any) => {
    write(req);
    return cancelCatalogAiMatch(req.actor, id(req));
  });
}
