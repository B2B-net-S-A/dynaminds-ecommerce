import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from './db';
import { ensure } from './errors';
import { captureOperationalDeliveryAuthority } from './operational-delivery-consumers';
import { parcelUuid, type OrderParcelActor } from './order-parcels-values';
import * as R from './order-parcel-releases';

export function registerOrderParcelReleaseRoutes(app: FastifyInstance, opts: { available: boolean; readOnly: boolean; sessionName: string }) {
  const root = '/api/order-parcel-releases';
  const actor = (req: any): OrderParcelActor => captureOperationalDeliveryAuthority(req,opts.sessionName);
  const id = (req: any) => z.strictObject({ id: parcelUuid }).parse(req.params).id;
  const empty = (req: any) => z.strictObject({}).parse(req.query);
  const mask = (r: any) => ({ ...r, read_only: opts.readOnly, can_write: !opts.readOnly && r.can_write,
    ...(r.source ? { source: { ...r.source, can_release: !opts.readOnly && r.source.can_release } } : {}),
    ...(r.preview ? { preview: { ...r.preview, can_release: !opts.readOnly && r.preview.can_release } } : {}) });
  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0].replace(/^\/api\/v1\//, '/api/');
    if (!path.startsWith(root + '/')) return;
    reply.header('Cache-Control', 'no-store');
    const write = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
    if (write) { ensure(!opts.readOnly, 423, 'Kopia jest tylko do odczytu'); ensure(opts.available && await R.orderParcelReleasesAvailable(pool), 503, 'Kopia nie zawiera zwolnień paczek'); }
    if (req.apiScopes) ensure(req.apiScopes.includes('orders:read') && (!write || req.apiScopes.includes('orders:write')), 403, 'Klucz API nie ma zakresów paczek');
  });
  app.get(root + '/plans/:id/source', async req => { empty(req); await R.orderParcelReleasesAvailable(pool); if (!opts.available) return { available: false, read_only: opts.readOnly, can_write: false, can_read: false, source: null, limits: R.ORDER_PARCEL_RELEASE_LIMITS }; return mask(await R.orderParcelReleaseSource(actor(req), id(req))); });
  app.post(root + '/plans/:id/previews', async (req, reply) => { empty(req); const r = await R.createOrderParcelReleasePreview(actor(req), id(req), R.orderParcelReleasePreviewInput.parse(req.body)); reply.code(r.reused ? 200 : 201); return mask(r); });
  app.get(root + '/previews/:id', async req => { empty(req); return mask(await R.orderParcelReleasePreviewDetail(actor(req), id(req))); });
  app.post(root + '/previews/:id/release', async (req, reply) => { empty(req); const r = await R.executeOrderParcelRelease(actor(req), id(req), R.orderParcelReleaseInput.parse(req.body)); reply.code(r.reused ? 200 : 201); return mask(r); });
  app.get(root + '/releases/:id', async req => { empty(req); return mask(await R.orderParcelReleaseDetail(actor(req), id(req))); });
}
