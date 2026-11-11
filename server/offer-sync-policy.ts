import { amazonAccountPolicy } from './amazon-account';
import { amazonOfferIdentity } from './amazon-offers';
import { ebayConnectionHash } from './ebay';
import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { ensure } from './errors';
export const connectionHash = (ch: any) =>
  ch.provider === 'ebay'
    ? ebayConnectionHash(ch)
    : createHash('sha256')
        .update(JSON.stringify({ provider: ch.provider, mode: ch.mode, settings: ch.settings }))
        .digest('hex');
export const offerConnectionHash = (ch: any) =>
  ch.provider === 'amazon'
    ? createHash('sha256')
        .update(connectionHash(ch) + amazonOfferIdentity(ch))
        .digest('hex')
    : connectionHash(ch);
// Locks precede job locks everywhere: config -> job -> plan. No network in this transaction.
export async function syncPolicy(
  c: PoolClient,
  channelId: string,
  version: number,
  actorId: string,
  lock = false,
) {
  const cfg = (
    await c.query(
      'SELECT * FROM offer_sync_configs WHERE channel_id=$1' + (lock ? ' FOR SHARE' : ''),
      [channelId],
    )
  ).rows[0];
  const ch = (
    await c.query('SELECT id,provider,mode,settings,credentials,status FROM channels WHERE id=$1', [
      channelId,
    ])
  ).rows[0];
  const member = (await c.query('SELECT offer_sync_is_admin($1) AS authorized', [actorId])).rows[0];
  if (ch?.provider === 'amazon') {
    try {
      await amazonAccountPolicy(c, ch);
    } catch {
      return false;
    }
  }
  return Boolean(
    cfg?.enabled &&
    cfg.version === version &&
    cfg.actor_id === actorId &&
    member?.authorized &&
    ch &&
    cfg.connection_hash === offerConnectionHash(ch) &&
    (ch.settings.simulation || cfg.external_authorized),
  );
}
export async function requireSyncPolicy(
  c: PoolClient,
  channelId: string,
  version: number,
  actorId: string,
) {
  ensure(
    await syncPolicy(c, channelId, version, actorId, true),
    409,
    'Harmonogram ofert wyłączono lub zmieniono; nowy zapis został zatrzymany',
  );
}
