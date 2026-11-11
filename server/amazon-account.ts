import type { PoolClient } from 'pg';
import { tokenHash, decrypt } from './security';
import { ensure } from './errors';
export const amazonSellerHash = (ch: any, sellerId = ch.settings.selling_partner_id) =>
  tokenHash(JSON.stringify([ch.mode, ch.settings.region, sellerId]));
export async function amazonAccountPolicy(c: PoolClient, ch: any) {
  ensure(ch?.provider === 'amazon', 422, 'Wymagany kanał Amazon');
  ensure(ch.status !== 'amazon_oauth_pending', 409, 'Dokończ lub anuluj połączenie OAuth Amazon');
  ensure(
    ch.settings.simulation || decrypt(ch.credentials).refresh_token,
    422,
    'Połącz konto Amazon przez OAuth lub podaj refresh token',
  );
  if (
    !(await c.query("SELECT to_regclass('public.amazon_account_bindings') present")).rows[0].present
  )
    return null;
  const b = (await c.query('SELECT * FROM amazon_account_bindings WHERE channel_id=$1', [ch.id]))
    .rows[0];
  if (b)
    ensure(
      b.seller_hash === amazonSellerHash(ch) &&
        b.mode === ch.mode &&
        b.region === ch.settings.region &&
        b.grant_hash === tokenHash(ch.credentials),
      409,
      'Konto lub grant Amazon zmieniono poza OAuth; przywróć pierwotne połączenie',
    );
  return b;
}
