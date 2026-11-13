import type { QueryResult } from 'pg';
import { pool } from '../server/db';
/** Shipment identity, COD amount and the first dispatch are immutable for the
 * application (order_shipments_guard, 133/134/234). A fixture that needs a
 * carrier shipment of another environment, or a deliberately tampered row the
 * application must reject, rewrites it with triggers off — superuser test
 * connection only, same as automation-v2-effects-supply.database.test.ts. */
export async function rewriteShipmentFixture(
  sql: string,
  params: unknown[] = [],
): Promise<QueryResult> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL session_replication_role=replica');
    const r = await c.query(sql, params);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}
