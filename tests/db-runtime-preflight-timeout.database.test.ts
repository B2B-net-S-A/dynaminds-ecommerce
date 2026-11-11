/** Opt-in check against a disposable, already migrated clone (source/dev/test mode: no
 * startup schema gate). Every tenantTx first runs the schema validators; they must get the
 * gated startup's 120 s budget, while tenant statements keep the 8 s statement limit and
 * the 8 s lock limit. A validator slower than 8 s is simulated on the real database by
 * appending pg_sleep(9) to the operational validator SELECT on pool clients.
 * Importing this file never imports db/runtime or connects unless opted in.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const directExecution = !!process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
const name = process.env.DYNA_PREFLIGHT_TIMEOUT_TEST_DATABASE;
const optedIn = directExecution && !!name;
const validator = 'SELECT operative_delivery_valid() ok';

test('non-gated tenantTx: schema validators get 120 s, tenant statements keep 8 s', { skip: !optedIn, concurrency: false }, async t => {
  assert.equal(process.env.DYNA_TEST, 'true');
  assert(name && /^dynaminds_s0_\d{8}_\d{2}$/.test(name), 'Explicit disposable clone required');
  const selected = new URL(process.env.DATABASE_URL ?? 'invalid://missing');
  assert.equal(selected.hostname, '127.0.0.1');
  assert.equal(selected.pathname, '/' + name);
  const { pool, tenantTx } = await import('../server/db');
  assert.equal(pool.totalCount, 0);
  assert.match(pool.options.options ?? '', /-c statement_timeout=8000 -c lock_timeout=8000 /);
  let slowed = 0, slow = true;
  pool.on('connect', (client) => {
    const query = client.query;
    (client as any).query = function (text: unknown, ...rest: unknown[]) {
      if (typeof text === 'string' && slow && text.includes(validator)) {
        slowed += 1;
        text = text.replace(validator, `${validator} FROM pg_sleep(9)`);
      }
      return (query as any).call(this, text, ...rest);
    };
  });
  t.after(() => pool.end());
  const tenantId = (await pool.query('SELECT id FROM tenants ORDER BY created_at LIMIT 1')).rows[0].id as string;

  await t.test('validator slower than 8 s does not fail the transaction', async () => {
    const started = Date.now();
    try {
      const limits = await tenantTx(tenantId, async (c) => ({
        statement: (await c.query('SHOW statement_timeout')).rows[0].statement_timeout,
        lock: (await c.query('SHOW lock_timeout')).rows[0].lock_timeout,
      }));
      assert.deepEqual(limits, { statement: '8s', lock: '8s' });
    } finally {
      slow = false;
    }
    assert.equal(slowed, 1);
    assert(Date.now() - started >= 9000, 'the simulated validator really ran');
  });

  await t.test('tenant statement slower than 8 s still fails with 57014', async () => {
    let entered = false;
    await assert.rejects(
      tenantTx(tenantId, async (c) => { entered = true; return c.query('SELECT pg_sleep(9)'); }),
      (e: any) => e?.code === '57014',
    );
    assert.equal(entered, true, 'the timeout came from the tenant statement, not the preflight');
  });

  await t.test('pooled sessions keep the 8 s session limit after the preflight', async () => {
    assert.equal((await pool.query('SHOW statement_timeout')).rows[0].statement_timeout, '8s');
  });
});
