import type { PoolClient } from 'pg';
import { ensure } from './errors';
import { b2bExternalIntentStateInTx } from './b2b-external-order-intent-guards';

/** Whole-order remote ACKs cannot assign supplier goods to a local-only parcel. */
export async function assertB2bWholeParcelAckInTx(c: PoolClient, orderId: string) {
  const intent = await b2bExternalIntentStateInTx(c, orderId);
  ensure(
    !intent ||
      intent.items.every((item) => item.external_quantity === 0 && item.unassigned_quantity === 0),
    409,
    'Zewnętrzny lub nieprzydzielony zakres wymaga osobnego przekazania dokładnych paczek i pozycji do kanału sprzedaży',
  );
  const tables = (
    await c.query(
      `SELECT to_regclass('public.b2b_dropship_lines') IS NOT NULL lines,
       to_regclass('public.b2b_dropship_orders') IS NOT NULL orders,
       to_regprocedure('public.b2b_dropship_installed()') IS NOT NULL installed_probe`,
    )
  ).rows[0];
  const installed = tables.installed_probe
    ? (await c.query('SELECT b2b_dropship_installed() installed')).rows[0].installed
    : false;
  if (!tables.lines && !tables.orders && !installed) return;
  ensure(tables.lines && tables.orders, 503, 'Historia dostaw zewnętrznych jest niekompletna');
  ensure(
    !(
      await c.query(
        `SELECT 1 FROM b2b_dropship_lines l
    JOIN b2b_dropship_orders d ON(d.tenant_id,d.id)=(l.tenant_id,l.order_id)
    WHERE l.customer_order_id=$1 AND d.state='ordered' LIMIT 1`,
        [orderId],
      )
    ).rowCount,
    409,
    'Części realizowane przez dostawców wymagają osobnego przekazania paczek i pozycji do kanału sprzedaży',
  );
}
