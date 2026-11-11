/** B2B-007 (migration 246): an order placed on trade credit is released for fulfilment before payment, like cash on
 * delivery (domain.ts status transition, payments.ts fulfillmentPayment). Only a database read; no imports from
 * the payment or order modules, so both can use it without a cycle. */
import type { PoolClient } from 'pg';

type Querier = Pick<PoolClient, 'query'>;
let installed = false;
/** False on a restored copy older than 246: no order is on credit there. Once installed it never goes away. */
export async function tradeCreditInstalled(c: Querier): Promise<boolean> {
  if (!installed)
    installed = (await c.query("SELECT to_regclass('public.b2b254_trade_charges') IS NOT NULL AND to_regclass('public.b2b254_trade_lines') IS NOT NULL AS ok")).rows[0]?.ok === true;
  return installed;
}
export async function tradeCreditReleasedInTx(c: Querier, orderId: string): Promise<boolean> {
  if (!(await tradeCreditInstalled(c))) return false;
  return ((await c.query('SELECT 1 FROM b2b254_trade_charges WHERE order_id=$1', [orderId])).rowCount ?? 0) > 0;
}
