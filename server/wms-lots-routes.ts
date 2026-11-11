import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ensure } from './errors';
import * as S from './wms-lots-schema';
import * as W from './wms-lots';
export * from './wms-lots-schema';

export function registerWmsLotsRoutes(
  app: FastifyInstance,
  opts: { available: boolean; readOnly: boolean },
) {
  const prefix = '/api/wms-lots';
  const has = (req: FastifyRequest, ...names: string[]) =>
    !req.apiScopes || names.every((n) => req.apiScopes!.includes(n));
  const scopes = (req: FastifyRequest, write = false, cost = false, order = false) =>
    ensure(
      has(
        req,
        'inventory:read',
        ...(write ? ['inventory:write'] : []),
        ...(cost ? ['purchasing:read', ...(write ? ['purchasing:write'] : [])] : []),
        ...(order ? ['orders:read'] : []),
      ),
      403,
      'Brak wymaganych zakresów magazynu, kosztów lub zamówień',
    );
  const actor = (req: FastifyRequest) => {
    const apiKeyId = req.currentUser.api_key_id as string | undefined;
    ensure(
      !req.apiScopes || typeof apiKeyId === 'string',
      401,
      'Brak bieżącego kontekstu klucza API',
    );
    return {
      ...req.actor,
      source: req.apiScopes ? ('api' as const) : ('manual' as const),
      ...(req.apiScopes ? { apiKeyId } : {}),
      canReadValue: has(req, 'purchasing:read'),
    };
  };
  const response = (req: FastifyRequest, result: any) => {
    const role = result.current_role ?? req.actor.role;
    const writer =
      opts.available &&
      !opts.readOnly &&
      ['admin', 'operator'].includes(role) &&
      has(req, 'inventory:read', 'inventory:write');
    const admin = writer && role === 'admin';
    const financial = admin && has(req, 'purchasing:read', 'purchasing:write');
    return {
      ...result,
      available: opts.available,
      read_only: opts.readOnly,
      current_role: role,
      can_read: has(req, 'inventory:read'),
      can_write: writer,
      can_admin: admin,
      can_read_value:
        opts.available &&
        role === 'admin' &&
        has(req, 'purchasing:read') &&
        result.can_read_value !== false,
      can_activate: financial,
      can_receive: financial,
      can_issue: financial,
      can_adjust: financial,
      can_transfer: writer,
      can_return: writer && has(req, 'orders:read', 'orders:write'),
      ...(result.can_scan !== undefined
        ? { can_scan: writer && has(req, 'orders:read', 'orders:write') && result.can_scan }
        : {}),
    };
  };
  const missing = (req: FastifyRequest) =>
    response(req, {
      policy: { enabled: false, version: '0', method: 'FIFO', currency: null, exponent: 2 },
      warehouses: [],
      limits: S.WMS_LOT_LIMITS,
      data: [],
      meta: { cursor: null },
      can_read_value: false,
    });
  const write = (req: FastifyRequest, cost = false) => {
    ensure(!opts.readOnly, 423, 'Kopia jest tylko do odczytu');
    ensure(opts.available, 503, 'Kopia nie zawiera WMS partii');
    scopes(req, true, cost);
  };
  const id = (params: unknown) =>
    z.strictObject({ id: z.uuid().transform((v) => v.toLowerCase()) }).parse(params).id;
  const read = (
    path: string,
    fn: (req: FastifyRequest) => Promise<unknown>,
    cost = false,
    order = false,
  ) => {
    app.get(prefix + path, async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      scopes(req, false, cost, order);
      if (!opts.available) return missing(req);
      const result = response(req, await fn(req));
      ensure(
        Buffer.byteLength(JSON.stringify(result), 'utf8') <= S.WMS_LOT_LIMITS.response_bytes,
        413,
        'Odpowiedź WMS przekracza limit bajtów',
      );
      return result;
    });
  };
  const post = (
    path: string,
    fn: (req: FastifyRequest) => Promise<any>,
    cost: boolean | ((req: FastifyRequest) => boolean),
  ) => {
    app.post(
      prefix + path,
      {
        bodyLimit: S.WMS_LOT_LIMITS.request_bytes,
        onRequest: async (req) => write(req),
        config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      },
      async (req, reply) => {
        write(req, typeof cost === 'function' ? cost(req) : cost);
        const result = await fn(req);
        return reply.code(result.reused ? 200 : 201).send(response(req, result));
      },
    );
  };
  read('', (req) => W.wmsLotsMetadata(actor(req)));
  read('/opening-scope', (req) => W.wmsOpeningScope(actor(req), S.wmsPageQuery.parse(req.query)));
  post(
    '/opening-previews',
    (req) => W.createWmsOpeningPreview(actor(req), S.wmsOpeningInput.parse(req.body)),
    true,
  );
  read('/opening-previews/:id', (req) => W.wmsPreviewDetail(actor(req), id(req.params), 'opening'));
  read('/opening-previews/:id/rows', (req) =>
    W.wmsPreviewRows(actor(req), id(req.params), 'opening', S.wmsPageQuery.parse(req.query)),
  );
  post(
    '/opening-previews/:id/activate',
    (req) => W.activateWmsOpening(actor(req), id(req.params), S.wmsActivateInput.parse(req.body)),
    true,
  );
  post(
    '/receipts',
    (req) => W.receiveWmsReceipt(actor(req), S.wmsReceiveInput.parse(req.body)),
    true,
  );
  post(
    '/movement-previews',
    (req) => W.createWmsMovementPreview(actor(req), S.wmsMovementInput.parse(req.body)),
    (req) => ['issue', 'adjustment'].includes((req.body as { kind?: string })?.kind ?? ''),
  );
  read('/movement-previews/:id', (req) =>
    W.wmsPreviewDetail(actor(req), id(req.params), 'movement'),
  );
  read('/movement-previews/:id/rows', (req) =>
    W.wmsPreviewRows(actor(req), id(req.params), 'movement', S.wmsPageQuery.parse(req.query)),
  );
  // Execute derives financial permissions from the frozen preview in the service, never from its request body.
  post(
    '/movement-previews/:id/execute',
    (req) => W.executeWmsMovement(actor(req), id(req.params), S.wmsExecuteInput.parse(req.body)),
    false,
  );
  read('/positions', (req) => W.wmsLotPositions(actor(req), S.wmsPositionsQuery.parse(req.query)));
  read('/lots/:id/trace', (req) =>
    W.wmsLotTrace(actor(req), id(req.params), S.wmsPageQuery.parse(req.query)),
  );
  read(
    '/valuation',
    (req) => W.wmsValuation(actor(req), S.wmsValuationQuery.parse(req.query)),
    true,
  );
  read('/operations', (req) => W.wmsOperations(actor(req), S.wmsOperationQuery.parse(req.query)));
  read('/operations/:id', (req) => W.wmsOperationDetail(actor(req), id(req.params)));
  read(
    '/orders/:id/allocations',
    (req) => W.wmsOrderAllocations(actor(req), id(req.params), S.wmsPageQuery.parse(req.query)),
    false,
    true,
  );
  read(
    '/orders/:id/return-fragments',
    (req) => W.wmsOrderReturnFragments(actor(req), id(req.params), S.wmsPageQuery.parse(req.query)),
    false,
    true,
  );
}
