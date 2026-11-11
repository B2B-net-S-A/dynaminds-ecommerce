import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ensure } from './errors';
import * as S from './packing-workstation-schema';
import * as P from './packing-workstation';
export {
  packingStationCreateInput,
  packingStationPatchInput,
  packingCartonCreateInput,
  packingCartonPatchInput,
  packingPolicyInput,
  packingSessionCreateInput,
  packingLeaseRenewInput,
  packingTakeoverInput,
  packingCancelInput,
  packingScanInput,
  packingPreviewInput,
  packingFinishInput,
  packingPageQuery,
  packingCandidateQuery,
  packingReceiptPageQuery,
  packingFrozenPageQuery,
} from './packing-workstation-schema';
export function registerPackingWorkstationRoutes(
  app: FastifyInstance,
  opts: { available: boolean; readOnly: boolean },
) {
  const scope = (req: any, write = false) => {
    if (req.apiScopes)
      ensure(
        req.apiScopes.includes('orders:read') && (!write || req.apiScopes.includes('orders:write')),
        403,
        'Klucz API nie ma zakresów pakowania',
      );
  };
  const actor = (req: any): S.PackingActor => {
    const id = req.currentUser?.api_key_id;
    ensure(!req.apiScopes || id, 401, 'Brak bieżącej tożsamości klucza');
    return {
      ...req.actor,
      ...(req.apiScopes ? { apiKeyId: id, source: 'api' } : { source: 'manual' }),
      canReadProducts: !req.apiScopes || req.apiScopes.includes('products:read'),
    };
  };
  const lease = (req: any) => {
    const value = req.headers['x-packing-lease'];
    if (value === undefined) return undefined;
    return z.uuid().parse(value).toLowerCase();
  };
  const id = (req: any) => z.strictObject({ id: z.uuid() }).parse(req.params).id.toLowerCase();
  const empty = () => ({
    available: false,
    read_only: opts.readOnly,
    current_role: null,
    can_read: false,
    can_write: false,
    can_admin: false,
    data: [],
    meta: { cursor: null },
    policy: { version: '0', require_parcel_profile: false },
    profile: null,
    session: null,
    preview: null,
    receipt: null,
  });
  const response = (req: any, data: any) => {
    const read = !req.apiScopes || req.apiScopes.includes('orders:read'),
      write = read && (!req.apiScopes || req.apiScopes.includes('orders:write'));
    const role = data.current_role;
    const out = {
      ...data,
      available: true,
      read_only: opts.readOnly,
      can_read: read && Boolean(role),
      can_write: !opts.readOnly && write && ['admin', 'operator'].includes(role),
      can_admin: !opts.readOnly && write && role === 'admin',
    };
    for (const k of ['can_scan', 'can_finish', 'can_takeover'])
      if (Object.hasOwn(out, k)) out[k] = out[k] && out.can_write;
    ensure(
      Buffer.byteLength(JSON.stringify(out), 'utf8') <= S.PACKING_LIMITS.snapshot_bytes,
      413,
      'Odpowiedź pakowania przekracza 5 MiB',
    );
    return out;
  };
  const prewrite = async (req: any) => {
    ensure(!opts.readOnly, 423, 'Podgląd kopii: pakowanie jest wyłączone');
    ensure(opts.available, 503, 'Kopia nie zawiera stanowiska pakowania');
    scope(req, true);
  };
  const get = (url: string, fn: (req: any) => Promise<any>) =>
    app.get('/api/packing' + url, async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!opts.available) return empty();
      scope(req);
      return response(req, await fn(req));
    });
  const write = (method: 'post' | 'patch', url: string, fn: (req: any) => Promise<any>) =>
    app[method](
      '/api/packing' + url,
      { onRequest: prewrite, bodyLimit: S.PACKING_LIMITS.request_bytes },
      async (req, reply) => {
        const r = await fn(req);
        return reply.code(method === 'post' && !r.reused ? 201 : 200).send(response(req, r));
      },
    );
  get('', (req) => P.packingMetadata(actor(req)));
  get('/stations', (req) => P.listPackingStations(actor(req), S.packingPageQuery.parse(req.query)));
  get('/cartons', (req) => P.listPackingCartons(actor(req), S.packingPageQuery.parse(req.query)));
  write('post', '/stations', (req) => P.createPackingStation(actor(req), req.body));
  write('patch', '/stations/:id', (req) => P.patchPackingStation(actor(req), id(req), req.body));
  write('post', '/cartons', (req) => P.createPackingCarton(actor(req), req.body));
  write('patch', '/cartons/:id', (req) => P.patchPackingCarton(actor(req), id(req), req.body));
  write('patch', '/policy', (req) => P.patchPackingPolicy(actor(req), req.body));
  get('/candidates', (req) =>
    P.packingCandidates(actor(req), S.packingCandidateQuery.parse(req.query)),
  );
  write('post', '/sessions', (req) => P.startPackingSession(actor(req), req.body));
  get('/sessions/:id', (req) => P.packingSessionDetail(actor(req), id(req), lease(req)));
  get('/sessions/:id/items', (req) =>
    P.packingSessionItems(actor(req), id(req), S.packingFrozenPageQuery.parse(req.query)),
  );
  get('/sessions/:id/allocations', (req) =>
    P.packingSessionAllocations(actor(req), id(req), S.packingFrozenPageQuery.parse(req.query)),
  );
  write('post', '/sessions/:id/renew', (req) =>
    P.renewPackingLease(actor(req), id(req), req.body, lease(req)),
  );
  write('post', '/sessions/:id/takeover', (req) =>
    P.takeoverPackingSession(actor(req), id(req), req.body),
  );
  write('post', '/sessions/:id/cancel', (req) =>
    P.cancelPackingSession(actor(req), id(req), req.body, lease(req)),
  );
  write('post', '/sessions/:id/scans', (req) =>
    P.scanPackingSession(actor(req), id(req), req.body, lease(req)),
  );
  get('/operations/:id', (req) => P.packingOperationResult(actor(req), id(req)));
  write('post', '/previews', (req) => P.createPackingPreview(actor(req), req.body, lease(req)));
  get('/previews/:id', (req) => P.packingPreviewDetail(actor(req), id(req)));
  get('/previews/:id/items', (req) =>
    P.packingPreviewItems(actor(req), id(req), S.packingFrozenPageQuery.parse(req.query)),
  );
  get('/previews/:id/allocations', (req) =>
    P.packingPreviewAllocations(actor(req), id(req), S.packingFrozenPageQuery.parse(req.query)),
  );
  write('post', '/previews/:id/finish', (req) =>
    P.finishPackingPreview(actor(req), id(req), req.body, lease(req)),
  );
  get('/receipts', (req) =>
    P.packingReceipts(actor(req), S.packingReceiptPageQuery.parse(req.query)),
  );
  get('/receipts/:id', (req) => P.packingReceiptDetail(actor(req), id(req)));
  get('/receipts/:id/items', (req) =>
    P.packingReceiptItems(actor(req), id(req), S.packingFrozenPageQuery.parse(req.query)),
  );
  get('/receipts/:id/allocations', (req) =>
    P.packingReceiptAllocations(actor(req), id(req), S.packingFrozenPageQuery.parse(req.query)),
  );
  get('/orders/:id/profile', (req) => P.orderPackingProfile(actor(req), id(req)));
}
