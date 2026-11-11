import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ensure } from './errors';
import * as S from './wms-stocktakes-schema';
import * as W from './wms-stocktakes';
export * from './wms-stocktakes-schema';
export function registerWmsStocktakeRoutes(
  app: FastifyInstance,
  opts: { available: boolean; readOnly: boolean },
) {
  const prefix = '/api/wms-lots/stocktakes';
  const has = (r: FastifyRequest, ...scopes: string[]) =>
    !r.apiScopes || scopes.every((s) => r.apiScopes!.includes(s));
  const actor = (r: FastifyRequest) => {
    const apiKeyId = r.currentUser.api_key_id as string | undefined;
    ensure(!r.apiScopes || apiKeyId, 401, 'Brak bieżącego klucza API');
    return {
      ...r.actor,
      source: r.apiScopes ? ('api' as const) : ('manual' as const),
      ...(r.apiScopes ? { apiKeyId } : {}),
      canReadValue: has(r, 'purchasing:read'),
    };
  };
  const flags = (r: FastifyRequest, result: any) => {
    const role = result.current_role ?? r.actor.role;
    const write =
      opts.available &&
      !opts.readOnly &&
      ['admin', 'operator'].includes(role) &&
      has(r, 'inventory:read', 'inventory:write');
    const admin = write && role === 'admin',
      financial = admin && has(r, 'purchasing:read', 'purchasing:write');
    return {
      ...result,
      available: opts.available,
      read_only: opts.readOnly,
      current_role: role,
      can_create: admin && result.policy?.enabled !== false,
      can_count: write,
      can_review: financial,
      can_post: financial,
      can_read_value:
        opts.available &&
        role === 'admin' &&
        has(r, 'purchasing:read') &&
        result.can_read_value !== false,
    };
  };
  const check = (r: FastifyRequest, write = false, cost = false) => {
    if (write) {
      ensure(!opts.readOnly, 423, 'Kopia jest tylko do odczytu');
      ensure(opts.available, 503, 'Kopia nie zawiera inwentaryzacji partii');
    }
    ensure(
      has(
        r,
        'inventory:read',
        ...(write ? ['inventory:write'] : []),
        ...(cost ? ['purchasing:read', 'purchasing:write'] : []),
      ),
      403,
      'Brak wymaganych zakresów spisu',
    );
  };
  const id = (r: FastifyRequest) =>
    z.strictObject({ id: z.uuid().transform((v) => v.toLowerCase()) }).parse(r.params).id;
  const reviewIds = (r: FastifyRequest) =>
    z
      .strictObject({
        id: z.uuid().transform((v) => v.toLowerCase()),
        review_id: z.uuid().transform((v) => v.toLowerCase()),
      })
      .parse(r.params);
  const read = (path: string, fn: (r: FastifyRequest) => Promise<unknown>) =>
    app.get(prefix + path, async (r, reply) => {
      reply.header('Cache-Control', 'no-store');
      check(r);
      if (!opts.available)
        return flags(r, {
          policy: { enabled: false, version: '0', currency: null, exponent: 2 },
          warehouses: [],
          limits: S.WMS_STOCKTAKE_LIMITS,
          data: [],
          meta: { cursor: null },
          can_read_value: false,
        });
      const result = flags(r, await fn(r));
      ensure(
        Buffer.byteLength(JSON.stringify(result)) <= S.WMS_STOCKTAKE_LIMITS.response_bytes,
        413,
        'Odpowiedź spisu przekracza limit',
      );
      return result;
    });
  const post = (path: string, fn: (r: FastifyRequest) => Promise<any>, cost = false) =>
    app.post(
      prefix + path,
      {
        bodyLimit: S.WMS_STOCKTAKE_LIMITS.request_bytes,
        onRequest: async (r) => check(r, true, cost),
      },
      async (r, reply) => {
        check(r, true, cost);
        const result = await fn(r);
        return reply.code(result.reused ? 200 : 201).send(flags(r, result));
      },
    );
  read('/metadata', (r) => W.wmsStocktakeMetadata(actor(r)));
  read('', (r) => W.wmsStocktakeList(actor(r), S.wmsStocktakeListQuery.parse(r.query)));
  post('', (r) => W.createWmsStocktake(actor(r), S.wmsStocktakeCreateInput.parse(r.body)));
  read('/:id', (r) => W.wmsStocktakeDetail(actor(r), id(r)));
  read('/:id/lines', (r) =>
    W.wmsStocktakeLines(actor(r), id(r), S.wmsStocktakePageQuery.parse(r.query)),
  );
  post('/:id/counts', (r) =>
    W.countWmsStocktake(actor(r), id(r), S.wmsStocktakeCountInput.parse(r.body)),
  );
  read('/:id/measurements', (r) =>
    W.wmsStocktakeMeasurements(actor(r), id(r), S.wmsStocktakePageQuery.parse(r.query)),
  );
  post(
    '/:id/reviews',
    (r) => W.reviewWmsStocktake(actor(r), id(r), S.wmsStocktakeReviewInput.parse(r.body)),
    true,
  );
  read('/:id/reviews', (r) =>
    W.wmsStocktakeReviews(actor(r), id(r), S.wmsStocktakePageQuery.parse(r.query)),
  );
  read('/:id/reviews/:review_id', (r) => {
    const p = reviewIds(r);
    return W.wmsStocktakeReviewDetail(actor(r), p.id, p.review_id);
  });
  read('/:id/reviews/:review_id/rows', (r) => {
    const p = reviewIds(r);
    return W.wmsStocktakeReviewRows(
      actor(r),
      p.id,
      p.review_id,
      S.wmsStocktakePageQuery.parse(r.query),
    );
  });
  post(
    '/:id/post',
    (r) => W.postWmsStocktake(actor(r), id(r), S.wmsStocktakePostInput.parse(r.body)),
    true,
  );
  for (const command of ['reopen', 'cancel'] as const)
    post('/:id/' + command, (r) =>
      W.commandWmsStocktake(actor(r), id(r), command, S.wmsStocktakeCommandInput.parse(r.body)),
    );
  read('/:id/posting', (r) => W.wmsStocktakePosting(actor(r), id(r)));
}
