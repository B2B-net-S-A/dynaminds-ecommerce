import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { ensure } from './errors';

export const EBAY_REVISION_LIMIT = 250;
export class EbayRevisionWait extends Error {
  constructor(public readonly until: string) {
    super('Budżet zmian aukcji eBay wyczerpany. Zadanie czeka przed wysłaniem zapisu.');
  }
}
export function ebayRevisionScope(accountHash: string, mode: string, simulationTenant?: string) {
  return createHash('sha256')
    .update(JSON.stringify({ accountHash, mode, simulationTenant: simulationTenant ?? null }))
    .digest('hex');
}
/** Pool quantity affects every published listing of the SKU, including other markets. */
export function ebayRevisionListings(snapshot: any, payload: any): string[] {
  const request = payload.requests?.[0];
  ensure(request && snapshot?.offers, 422, 'Brak zakresu zmiany Inventory eBay');
  const affected = snapshot.offers.filter(
    (o: any) =>
      o.status === 'PUBLISHED' &&
      (request.shipToLocationAvailability !== undefined || o.offerId === snapshot.offer_id),
  );
  const ids = affected.map((o: any) => o.listing?.listingId);
  ensure(
    ids.length &&
      ids.every((id: any) => typeof id === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(id)),
    422,
    'Brak ID jednej z aukcji objętych zmianą eBay',
  );
  return [...new Set<string>(ids)].sort();
}
/** Called by trusted server code on its privileged pool connection inside the phase transaction.
 * Locks contain no network IO. All affected listings are reserved atomically. Count attempts,
 * including uncertain replies, in a conservative rolling 24h window (provider uses calendar days).
 */
export async function reserveEbayRevisions(
  c: PoolClient,
  scope: string,
  ids: string[],
  plan: string,
) {
  const listings = [...new Set(ids)].sort();
  for (const id of listings)
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      `ebay-revision:${scope}:${id}`,
    ]);
  let until: string | undefined;
  for (const id of listings) {
    if (
      (
        await c.query(
          'SELECT 1 FROM ebay_revision_attempts WHERE scope_hash=$1 AND listing_id=$2 AND plan_id=$3',
          [scope, id, plan],
        )
      ).rowCount
    )
      continue;
    const r = (
      await c.query(
        `SELECT attempted_at+interval '24 hours' AS until FROM ebay_revision_attempts
      WHERE scope_hash=$1 AND listing_id=$2 AND attempted_at>statement_timestamp()-interval '24 hours'
      ORDER BY attempted_at DESC OFFSET $3 LIMIT 1`,
        [scope, id, EBAY_REVISION_LIMIT - 1],
      )
    ).rows[0];
    if (r && (!until || new Date(r.until).getTime() > new Date(until).getTime()))
      until = new Date(r.until).toISOString();
  }
  if (until) throw new EbayRevisionWait(until);
  for (const id of listings)
    await c.query(
      'INSERT INTO ebay_revision_attempts(scope_hash,listing_id,plan_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
      [scope, id, plan],
    );
}
