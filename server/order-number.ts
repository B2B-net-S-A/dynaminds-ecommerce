import { randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';

/** Local order numbers DE-<UTC yyyymmdd>-<8 uppercase hex>. 32 random bits per day give ~0.012 expected
 * collisions per tenant at ~10 000 orders a day (docs/scale/LOAD-TEST-FULL-20261029.md §4.4), so the
 * insert retries a taken number under a savepoint instead of surfacing orders_tenant_id_number_key. */
const ATTEMPTS = 8;
let suffix: () => string = () => randomBytes(4).toString('hex').toUpperCase();
/** Test seam: forced suffixes to provoke a collision. Refused outside DYNA_TEST. */
export function injectOrderNumberSuffixForTest(next: (() => string) | null): void {
  if (process.env.DYNA_TEST !== 'true') throw new Error('Order number suffix can be injected only in tests');
  suffix = next ?? (() => randomBytes(4).toString('hex').toUpperCase());
}
const numberCollision = (e: unknown) =>
  (e as { code?: string; constraint?: string })?.code === '23505' &&
  (e as { constraint?: string }).constraint === 'orders_tenant_id_number_key';
/** Runs the one orders INSERT with a fresh number until it is not taken (at most ATTEMPTS). Only a
 * number collision is retried; the savepoint undoes the failed INSERT and its triggers alone. */
export async function insertOrderWithNumberInTx(
  c: PoolClient,
  insert: (number: string) => Promise<unknown>,
): Promise<string> {
  const day = new Date().toISOString().slice(0, 10).replaceAll('-', '');
  for (let attempt = 1; ; attempt++) {
    const number = `DE-${day}-${suffix()}`;
    await c.query('SAVEPOINT order_number');
    try {
      await insert(number);
      await c.query('RELEASE SAVEPOINT order_number');
      return number;
    } catch (e) {
      if (!numberCollision(e) || attempt >= ATTEMPTS) throw e;
      await c.query('ROLLBACK TO SAVEPOINT order_number');
      await c.query('RELEASE SAVEPOINT order_number');
    }
  }
}
