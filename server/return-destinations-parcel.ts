/** Certified148 parcel provenance. Payload originates solely in the private SQL
 * admission:138 independently checks it against the same current-TX certificate.
 * Ordinary138 callers retain their original allocator and validation unchanged.
 */
import type { PoolClient } from 'pg';
import type { Actor } from './domain';
import { ensure } from './errors';
import { parcelReturnRequiredInTx } from './order-parcel-returns';

export async function prepareDestinationParcelReceiveInTx(c: PoolClient, actor: Actor,
  orderId: string, returnId: string, input: unknown, privatePayload: unknown): Promise<boolean> {
  if (!await parcelReturnRequiredInTx(c, orderId)) return false;
  const p = privatePayload as { decisions?: unknown; fragments?: unknown } | null;
  ensure(p && Array.isArray(p.decisions) && p.decisions.length > 0 && Array.isArray(p.fragments),
    409, 'Dopuszczenie nie zawiera rzeczywistego pochodzenia zwracanej paczki');
  await c.query('SELECT order_parcel_return_prepare_receive($1,$2,$3,$4,$5)',
    [returnId, actor.userId, actor.apiKeyId ?? null, input, privatePayload]);
  return true;
}
