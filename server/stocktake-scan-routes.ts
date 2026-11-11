import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ensure } from './errors';
import * as S from './stocktake-scans-schema';
import * as W from './stocktake-scans';
export * from './stocktake-scans-schema';
export function registerStocktakeScanRoutes(
  app: FastifyInstance,
  opts: { available: boolean; readOnly: boolean },
) {
  const has = (r: FastifyRequest, ...scopes: string[]) =>
    !r.apiScopes || scopes.every((s) => r.apiScopes!.includes(s));
  const actor = (r: FastifyRequest) => {
    const key = r.currentUser.api_key_id as string | undefined;
    ensure(!r.apiScopes || key, 401, 'Brak bieżącego klucza API');
    return {
      ...r.actor,
      source: r.apiScopes ? ('api' as const) : ('manual' as const),
      ...(r.apiScopes ? { apiKeyId: key } : {}),
    };
  };
  const uuid = z.uuid().transform((v) => v.toLowerCase());
  const parentParams = z.strictObject({ id: uuid });
  const detailParams = z.strictObject({ id: uuid, scan_id: uuid });
  const ids = (r: FastifyRequest) => parentParams.parse(r.params);
  const check = (r: FastifyRequest, write = false) => {
    if (write) {
      ensure(!opts.readOnly, 423, 'Kopia jest tylko do odczytu');
      ensure(opts.available, 503, 'Kopia nie zawiera skanowania spisów');
    }
    ensure(
      has(r, 'inventory:read', ...(write ? ['inventory:write'] : [])),
      403,
      'Brak zakresów liczenia zapasu',
    );
  };
  const response = (r: FastifyRequest, data: any) => {
    const writer = has(r, 'inventory:read', 'inventory:write') && !opts.readOnly && opts.available;
    const value = {
      ...data,
      available: opts.available && data.available !== false,
      read_only: opts.readOnly,
      can_resolve: opts.available && data.available !== false && data.can_resolve !== false,
      can_scan: writer && data.can_scan === true,
      can_replay: writer && data.can_replay === true,
    };
    ensure(
      Buffer.byteLength(JSON.stringify(value)) <= S.STOCKTAKE_SCAN_LIMITS.response_bytes,
      413,
      'Odpowiedź skanu przekracza limit',
    );
    return value;
  };
  for (const [prefix, engine] of [
    ['/api/wms-lots/stocktakes', 'wms'],
    ['/api/stocktakes', 'quantity'],
  ] as const) {
    const read = (suffix: string, fn: (r: FastifyRequest) => Promise<any>) =>
      app.get(prefix + '/:id' + suffix, async (r, reply) => {
        reply.header('Cache-Control', 'no-store');
        check(r);
        if (!opts.available)
          return response(r, {
            engine,
            current_role: r.actor.role,
            can_resolve: false,
            can_scan: false,
            can_replay: false,
            limits: S.STOCKTAKE_SCAN_LIMITS,
            data: [],
            meta: { cursor: null, total: 0 },
          });
        return response(r, await fn(r));
      });
    const post = (suffix: string, fn: (r: FastifyRequest) => Promise<any>) =>
      app.post(
        prefix + '/:id' + suffix,
        {
          bodyLimit: S.STOCKTAKE_SCAN_LIMITS.request_bytes,
          onRequest: async (r) => check(r, true),
        },
        async (r, reply) => {
          check(r, true);
          const value = await fn(r);
          reply.header('Cache-Control', 'no-store');
          return reply.code(value.reused ? 200 : 201).send(response(r, value));
        },
      );
    read('/scan-metadata', (r) => W.stocktakeScanMetadata(actor(r), engine, ids(r).id));
    read('/scan-candidates', (r) =>
      W.stocktakeScanCandidates(
        actor(r),
        engine,
        ids(r).id,
        S.stocktakeScanCandidatesQuery.parse(r.query),
      ),
    );
    post('/scan-start', (r) =>
      W.startStocktakeScan(actor(r), engine, ids(r).id, S.stocktakeScanStartInput.parse(r.body)),
    );
    post('/scans', (r) =>
      W.incrementStocktakeScan(
        actor(r),
        engine,
        ids(r).id,
        S.stocktakeScanIncrementInput.parse(r.body),
      ),
    );
    read('/scans', (r) =>
      W.stocktakeScanHistory(
        actor(r),
        engine,
        ids(r).id,
        S.stocktakeScanHistoryQuery.parse(r.query),
      ),
    );
    read('/scans/:scan_id', (r) => {
      const p = detailParams.parse(r.params);
      return W.stocktakeScanDetail(actor(r), engine, p.id, p.scan_id);
    });
  }
}
