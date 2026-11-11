import assert from 'node:assert/strict';
import { pool } from '../server/db';
import { seed as seedDemo, DEMO_TENANT, SECOND_TENANT } from '../server/seed';
export { DEMO_TENANT, SECOND_TENANT };
export async function seed() {
  assert.equal(process.env.DYNA_TEST, 'true', 'Fixtures require an isolated test database');
  await seedDemo();
  // Contract suites accumulate synthetic channels/orders. Quota tests create separate Starter
  // organizations with explicit small limits, instead of weakening production plan enforcement.
  await pool.query("UPDATE tenants SET plan='enterprise' WHERE id=ANY($1::uuid[])", [
    [DEMO_TENANT, SECOND_TENANT],
  ]);
}
