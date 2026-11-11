import type { PoolClient } from 'pg';
import { ensure } from './errors';

/** Legacy fulfillment operates on the whole original reservation. */
export async function assertNoOrderParcelPlanInTx(c: PoolClient, orderId: string) {
  const metadata = (await c.query(`SELECT
    current_user AS role,
    to_regclass('public.order_parcel_plans') IS NOT NULL AS present,
    to_regprocedure('order_parcel_guards()') IS NOT NULL AS guards,
    to_regprocedure('order_parcel_installed()') IS NOT NULL AS marker`)).rows[0];
  if (!metadata.present && !metadata.guards && !metadata.marker) {
    ensure(metadata.role !== 'dyna_app',503,'Moduł paczek jest niekompletny');
    ensure(!(await c.query("SELECT 1 FROM migrations WHERE name='134_order_parcels'")).rowCount,
      503,'Moduł paczek jest niekompletny');
    return;
  }
  ensure(metadata.present && metadata.guards && metadata.marker, 503,
    'Moduł paczek jest niekompletny');
  ensure((await c.query('SELECT order_parcel_guards() AND order_parcel_installed() AS valid')).rows[0].valid,
    503, 'Moduł paczek jest niekompletny');
  ensure(!(await c.query('SELECT 1 FROM order_parcel_plans WHERE order_id=$1 LIMIT 1',
    [orderId])).rowCount, 409,
    'Zamówienie ma zatwierdzony podział na paczki. Wydawaj towar przez plan paczek');
}
