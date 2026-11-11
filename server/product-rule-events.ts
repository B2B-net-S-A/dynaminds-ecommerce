import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { Actor } from './domain';
import { scheduleProductRuleBatchInTx } from './product-rules';

export type CatalogProductEvent = {
  product_id: string;
  event: 'product.created' | 'product.updated';
  cause_id: string;
};
// Old restored copies can still read their catalogue without the new tables.
// Admission belongs to the source transaction: a queue conflict rolls back the source too.
export async function emitCatalogProductEvents(
  c: PoolClient,
  a: Actor,
  events: CatalogProductEvent[],
) {
  if (!events.length) return;
  if (!(await c.query("SELECT to_regclass('public.product_rules') present")).rows[0].present)
    return;
  return scheduleProductRuleBatchInTx(c, a, events, { origin: 'catalog' });
}
export function emitCatalogProductEvent(
  c: PoolClient,
  a: Actor,
  product: string,
  event: CatalogProductEvent['event'],
  causeId = randomUUID(),
) {
  return emitCatalogProductEvents(c, a, [{ product_id: product, event, cause_id: causeId }]);
}
