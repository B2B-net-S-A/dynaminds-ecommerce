import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ensure } from './errors';
import type { CatalogStockControlActor } from './catalog-stock-control-schema';
import {
  catalogStockCountDocumentList,
  catalogStockCountDocumentDetail,
  catalogStockCountDocumentValue,
  catalogStockCountDocumentExport,
} from './catalog-stock-count-query';

export {
  catalogStockCountQuery,
  catalogStockCountRowsQuery,
  catalogStockCountValueRowsQuery,
  catalogStockCountExportQuery,
} from './catalog-stock-count-query';

const params = z.strictObject({ id: z.uuid().transform(v => v.toLowerCase()) });

/** COUNT reads and explicit value/export intents. The service pins current native IAM before projection. */
export function registerCatalogStockCountRoutes(
  app: FastifyInstance,
  config: { readOnly: boolean },
) {
  const prefix = '/api/catalog-stock-control/count-documents';
  const context = { readOnly: config.readOnly };
  const actor = (req: FastifyRequest): CatalogStockControlActor => {
    ensure(
      !req.apiScopes || req.apiScopes.includes('products:read') && req.apiScopes.includes('inventory:read'),
      403,
      'Wymagane scopes products:read i inventory:read',
    );
    ensure(req.actor && typeof req.actor.userId === 'string', 401, 'Brak aktualnego użytkownika');
    if (!req.apiScopes) return req.actor;
    const key = req.currentUser?.api_key_id;
    ensure(typeof key === 'string', 401, 'Brak aktualnego kontekstu klucza API');
    ensure(!req.actor.apiKeyId || req.actor.apiKeyId === key, 401, 'Kontekst klucza API zmienił się');
    return { ...req.actor, apiKeyId: key, source: 'api' };
  };
  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0].replace(/^\/api\/v1\//, '/api/');
    if (path !== prefix && !path.startsWith(prefix + '/')) return;
    reply.header('Cache-Control', 'no-store');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      ensure(!config.readOnly, 423, 'Odtworzona kopia jest tylko do odczytu');
      ensure(false, 405, 'Rejestr dokumentów COUNT jest tylko do odczytu');
    }
  });
  app.get(prefix, req => catalogStockCountDocumentList(actor(req), req.query, context));
  app.get(prefix + '/:id', req => {
    const current = actor(req);
    return catalogStockCountDocumentDetail(current, params.parse(req.params).id, req.query, context);
  });
  app.get(prefix + '/:id/value', req => {
    const current = actor(req);
    return catalogStockCountDocumentValue(current, params.parse(req.params).id, req.query, context);
  });
  app.get(prefix + '/:id/export', req => {
    const current = actor(req);
    return catalogStockCountDocumentExport(current, params.parse(req.params).id, req.query, context);
  });
}
