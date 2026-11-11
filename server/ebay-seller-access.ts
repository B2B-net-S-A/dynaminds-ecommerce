import { tenantTx } from './db';
import type { Actor } from './domain';
import { ensure } from './errors';
import { decrypt } from './security';
import { channelRead, loadChannel, type IntegrationContext } from './channel-access';
import { Ebay, ebayConnectionHash } from './ebay';
import { safeFetch } from './integrations';

export function requireEbaySellerSettings(ch: any) {
  ensure(
    ch.settings.simulation ||
      (ch.settings.seller_settings_read === true &&
        ['orders_inventory', 'orders_inventory_write'].includes(ch.settings.inventory_access)),
    422,
    'Włącz odczyt Inventory i warunków sprzedaży, a następnie połącz eBay z sell.account.readonly',
  );
}

/** Every request, including OAuth, retains the initiating tenant, admin and account binding. */
export async function ebaySellerAccess<T>(
  actor: Actor,
  id: string,
  seller: boolean,
  read: (client: Ebay, ch: any, fence: () => Promise<void>) => Promise<T>,
  demo: (ch: any) => T,
  ctx: IntegrationContext = {},
) {
  const ch = await loadChannel(actor.tenantId, id);
  ensure(ch.provider === 'ebay', 422, 'Wymagana integracja eBay');
  const connection = ebayConnectionHash(ch);
  let account: string | undefined;
  const fence = async () => {
    await tenantTx(actor.tenantId, async (c) => {
      ensure(
        (await c.query('SELECT offer_sync_is_admin($1) authorized', [actor.userId])).rows[0]
          .authorized,
        403,
        'Wymagana aktualna rola administratora',
      );
      const current = (await c.query('SELECT * FROM channels WHERE id=$1', [id])).rows[0];
      ensure(
        current && ebayConnectionHash(current) === connection,
        409,
        'Połączenie eBay zmieniło się podczas odczytu',
      );
      if (seller) requireEbaySellerSettings(current);
      const binding = (
        await c.query(
          'SELECT account_hash,mode,source FROM ebay_account_bindings WHERE channel_id=$1',
          [id],
        )
      ).rows[0];
      ensure(
        binding &&
          binding.mode === ch.mode &&
          binding.source === (ch.settings.simulation ? 'simulation' : 'trading'),
        409,
        'Najpierw sprawdź tożsamość konta eBay',
      );
      ensure(
        !account || account === binding.account_hash,
        409,
        'Tożsamość konta eBay zmieniła się podczas odczytu',
      );
      account = binding.account_hash;
      ensure(
        !(
          await c.query(
            'SELECT 1 FROM oauth_states WHERE channel_id=$1 AND consumed_at IS NULL AND expires_at>now()',
            [id],
          )
        ).rowCount,
        409,
        'Dokończ lub anuluj rozpoczętą zgodę OAuth eBay',
      );
    });
  };
  await fence();
  const guarded: IntegrationContext = {
    ...ctx,
    transport: async (url, init) => {
      await fence();
      return (ctx.transport ?? safeFetch)(url, init);
    },
  };
  const result = ch.settings.simulation
    ? demo(ch)
    : seller
      ? await channelRead(
          actor.tenantId,
          id,
          async (client) => {
            ensure(client instanceof Ebay, 422, 'Wymagana integracja eBay');
            return read(client, ch, fence);
          },
          guarded,
          true,
          fence,
        )
      : await read(
          new Ebay(ch.mode, decrypt(ch.credentials), guarded.transport ?? safeFetch),
          ch,
          fence,
        );
  await fence();
  return { ...result, scope: ch.settings.simulation ? 'local_simulation' : 'external_read' };
}
