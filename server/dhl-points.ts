import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { tenantTx } from './db';
import { ensure } from './errors';
import { channelRead, type IntegrationContext } from './channel-access';
import { Dhl, type DhlPoint } from './carrier-dhl';

// DHL points.search (WebAPI2 getNearestServicepoints): read-only lookup of DHL service points
// (POP / Parcelshop) for the tenant's DHL account. Informational only: delivery to a point is not
// sent in createShipments yet (open sandbox question 10).
export const DHL_POINTS_LIMIT = 50;
export const dhlPointsQuery = z
  .object({
    postcode: z
      .string()
      .trim()
      .regex(/^\d{2}-?\d{3}$/, 'Wymagany polski kod pocztowy')
      .transform((v) => v.replace('-', '')),
    city: z.string().trim().min(1).max(50).regex(/^[^\x00-\x1f\x7f]*$/, 'Nieprawidłowe miasto').optional(),
    radius: z.coerce.number().int().min(1).max(50).default(5),
  })
  .strict();
export type DhlPointsQuery = z.infer<typeof dhlPointsQuery>;
export type DhlPointsScope = 'local_simulation' | 'external_sandbox' | 'external_api';
export interface DhlPointsAnswer {
  channel_id: string;
  scope: DhlPointsScope;
  count: number;
  data: DhlPoint[];
}

/** Only the known, already validated fields; at most DHL_POINTS_LIMIT points and 7 hour rows. */
export function publicDhlPoints(points: readonly DhlPoint[]): DhlPoint[] {
  return points.slice(0, DHL_POINTS_LIMIT).map((p) => ({
    id: p.id,
    name: p.name,
    type: p.type,
    address: { street: p.address.street, postalCode: p.address.postalCode, city: p.address.city },
    location: p.location ? { lat: p.location.lat, lng: p.location.lng } : null,
    hours: p.hours.slice(0, 7).map((h) => ({ day: h.day, open: h.open, close: h.close })),
    description: p.description,
  }));
}

export async function readDhlPoints(client: Dhl, q: DhlPointsQuery): Promise<DhlPoint[]> {
  return publicDhlPoints(await client.points(q));
}

/** Fixed local list of the "przykład lokalny" channel; no request leaves the process. */
export function simulatedDhlPoints(q: DhlPointsQuery): DhlPoint[] {
  const city = q.city ?? 'Warszawa';
  return publicDhlPoints([
    {
      id: 'DEMO-POP-' + q.postcode,
      name: 'DHL POP — przykład lokalny',
      type: 'POP',
      address: { street: 'Przykładowa 1', postalCode: q.postcode, city },
      location: null,
      hours: [{ day: 'MON', open: '08:00', close: '20:00' }],
      description: 'Punkt przykładowy; dane lokalne, nie z DHL24',
    },
    {
      id: 'DEMO-PS-' + q.postcode,
      name: 'DHL Parcelshop — przykład lokalny',
      type: 'PARCELSHOP',
      address: { street: 'Przykładowa 2', postalCode: q.postcode, city },
      location: null,
      hours: [{ day: 'MON', open: '10:00', close: '18:00' }],
      description: 'Punkt przykładowy; dane lokalne, nie z DHL24',
    },
  ]);
}

export async function searchDhlPoints(
  tenantId: string,
  channelId: string,
  q: DhlPointsQuery,
  ctx: IntegrationContext = {},
): Promise<DhlPointsAnswer> {
  const ch = await tenantTx(
    tenantId,
    async (c) => (await c.query('SELECT id,provider,mode,settings FROM channels WHERE id=$1', [channelId])).rows[0],
  );
  ensure(ch?.provider === 'dhl', 404, 'Nie znaleziono konta DHL');
  const answer = (scope: DhlPointsScope, data: DhlPoint[]): DhlPointsAnswer => ({
    channel_id: ch.id,
    scope,
    count: data.length,
    data,
  });
  if (ch.settings?.simulation) return answer('local_simulation', simulatedDhlPoints(q));
  const data = await channelRead(
    tenantId,
    channelId,
    async (client) => {
      ensure(client instanceof Dhl, 422, 'Wymagane DHL');
      return readDhlPoints(client, q);
    },
    ctx,
    true,
    (current) => ensure(current.provider === 'dhl', 404, 'Nie znaleziono konta DHL'),
  );
  return answer(ch.mode === 'sandbox' ? 'external_sandbox' : 'external_api', data);
}

export function registerDhlPointRoutes(app: FastifyInstance, ctx: IntegrationContext = {}) {
  app.get('/api/integrations/:id/dhl-points', async (req) => {
    ensure(['admin', 'operator'].includes(req.actor.role), 403, 'Brak uprawnień do wyszukiwania punktów DHL');
    const id = z.object({ id: z.uuid() }).parse(req.params).id;
    return searchDhlPoints(req.actor.tenantId, id, dhlPointsQuery.parse(req.query ?? {}), ctx);
  });
}
