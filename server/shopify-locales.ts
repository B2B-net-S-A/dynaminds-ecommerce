import { tenantTx } from './db';
import { type Actor } from './domain';
import { ensure } from './errors';
import { channelRead, loadChannel, type IntegrationContext } from './channel-access';
import { shopifyAccountPolicy } from './shopify-oauth';
import { importConnectionHash } from './imports';
import { effectiveShopifyScopes } from './shopify-auth-input';
import { Shopify, shopifyStore } from './shopify';

export async function readShopifyLocales(actor: Actor, id: string, ctx: IntegrationContext = {}) {
  const original = await loadChannel(actor.tenantId, id);
  const policy = async () =>
    tenantTx(actor.tenantId, async (c) => {
      ensure(
        (await c.query('SELECT offer_sync_is_admin($1) ok', [actor.userId])).rows[0]?.ok,
        403,
        'Odczyt języków wymaga administratora',
      );
      const ch = (await c.query('SELECT * FROM channels WHERE id=$1 FOR SHARE', [id])).rows[0];
      ensure(ch?.provider === 'shopify', 404, 'Nie znaleziono kanału Shopify');
      ensure(
        importConnectionHash(ch) === importConnectionHash(original),
        409,
        'Połączenie Shopify zmieniło się podczas odczytu',
      );
      await shopifyAccountPolicy(c, ch);
      return (await c.query('SELECT * FROM shopify_account_bindings WHERE channel_id=$1', [id]))
        .rows[0];
    });
  const b = await policy();
  if (original.settings.simulation) {
    ensure(b?.source === 'simulation', 409, 'Najpierw zakończ lokalne połączenie Shopify');
    const scopes = effectiveShopifyScopes(b.scopes);
    ensure(
      scopes.includes('read_locales') || scopes.includes('read_markets_home'),
      403,
      'Połącz ponownie przykład z uprawnieniem tłumaczeń',
    );
    return {
      shopId: b.shop_id,
      scopes,
      locales: [
        { locale: 'pl', name: 'Polski', primary: true, published: true },
        { locale: 'de', name: 'Niemiecki', primary: false, published: true },
        { locale: 'en', name: 'Angielski', primary: false, published: true },
        { locale: 'fr', name: 'Francuski', primary: false, published: false },
      ],
      source: 'local_simulation',
      storeUrl: b.store_url,
    };
  }
  const value = await channelRead(
    actor.tenantId,
    id,
    (client) =>
      (client as Shopify).translationLocales(b?.shop_id, async () => {
        await policy();
      }),
    ctx,
    true,
    async () => {
      await policy();
    },
  );
  await policy();
  return { ...value, source: 'graphql', storeUrl: shopifyStore(original.settings.store_url) };
}
