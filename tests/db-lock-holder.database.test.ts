/** A job whose session advisory lock connection dies must not commit again (fail closed), and a second worker can
 * take the same lock and finish the work alone. Uses the real lockDbClient/holdingDbLock and the real tenantTx.
 *
 * Fresh PG04 clone dynaminds_pgerr30_YYYYMMDD_NN of the restored template; migrate() runs here:
 *   DYNA_TEST=true DYNA_LOCAL_CONFIG_PATH=<pg04-test-config.json> DATABASE_URL=postgres://postgres:…@127.0.0.1:57084/dynaminds_pgerr30_…
 *   node node_modules/tsx/dist/cli.mjs --test tests/db-lock-holder.database.test.ts
 * The clone gets one scratch table pgerr30_lock_effects (dyna_app may insert, emptied at start); nothing else is written. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { migrate, pool, tenantTx } from '../server/db';
import { holdingDbLock, lockDbClient, LockConnectionLostError } from '../server/db-lock-holder';

assert.equal(process.env.DYNA_TEST, 'true');
const url = new URL(process.env.DATABASE_URL ?? 'invalid://missing');
assert.equal(url.hostname, '127.0.0.1');
assert.match(url.pathname, /^\/dynaminds_pgerr30_2026[0-9]{4}_[0-9]{2}$/, 'fresh clone dynaminds_pgerr30_YYYYMMDD_NN required');
const admin = new pg.Client({ connectionString: process.env.DATABASE_URL, application_name: 'pgerr30-lock-admin' });
let tenant = '';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function gate() { let open!: () => void; const promise = new Promise<void>((r) => { open = r; }); return { promise, open }; }

before(async () => {
  await migrate();
  await admin.connect();
  tenant = (await admin.query('SELECT id FROM tenants ORDER BY id LIMIT 1')).rows[0].id;
  await admin.query('CREATE TABLE IF NOT EXISTS pgerr30_lock_effects(tenant_id uuid NOT NULL, job text NOT NULL, step int NOT NULL)');
  await admin.query('GRANT SELECT, INSERT ON pgerr30_lock_effects TO dyna_app');
  await admin.query('TRUNCATE pgerr30_lock_effects'); // a rerun on the same clone starts empty
});
after(async () => { await admin.end(); await pool.end(); });

const effects = async (job: string) => (await admin.query('SELECT step FROM pgerr30_lock_effects WHERE job=$1 ORDER BY step', [job])).rows.map((r) => r.step);
const lockPid = async (key: string) => (await admin.query(
  "SELECT pid FROM pg_locks WHERE locktype='advisory' AND granted AND (classid::bigint<<32 | objid::bigint) = hashtextextended($1,0) LIMIT 1", [key])).rows[0]?.pid as number | undefined;

/** The shape of every lock site: own lock client, session lock, steps committed through tenantTx under the lock. */
async function job(name: string, key: string, steps: number, between?: (step: number, lock: pg.Client) => Promise<void>) {
  const lock = lockDbClient(new pg.Client({ connectionString: pool.options.connectionString }), 'test-lock-' + name);
  await lock.connect();
  try {
    return await holdingDbLock(lock, async () => {
      await lock.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [key]);
      for (let step = 1; step <= steps; step++) {
        await tenantTx(tenant, async (c) => { await c.query('INSERT INTO pgerr30_lock_effects(tenant_id,job,step) VALUES($1,$2,$3)', [tenant, name, step]); });
        if (between) await between(step, lock);
      }
      return 'done';
    });
  } finally {
    // The race variant paused the lock socket; let the pending FATAL/end through before ending the client.
    (lock as unknown as { connection: { stream: { resume(): void } } }).connection.stream.resume();
    await lock.end().catch(() => {});
  }
}

for (const variant of ['the lock client sees the error', 'the error has not reached the lock client yet'] as const) {
  test(`lock connection terminated mid-job (${variant}): no further commit, a second worker takes over`, { timeout: 300_000 }, async () => {
    const key = 'pgerr30-lock-' + (variant.startsWith('the lock client') ? 'a' : 'b');
    const first = 'first-' + key, second = 'second-' + key;
    const resume = gate(), paused = gate();
    const running = job(first, key, 3, async (step, lock) => {
      if (step !== 1) return;
      // Race variant: the FATAL from the terminated backend stays unread on the lock socket.
      if (variant !== 'the lock client sees the error') (lock as unknown as { connection: { stream: { pause(): void } } }).connection.stream.pause();
      paused.open();
      await resume.promise;
    }).then((v) => v, (e: unknown) => e);
    await paused.promise;
    const pid = await lockPid(key);
    assert(pid, 'the first job holds the lock');
    assert.equal((await admin.query('SELECT pg_terminate_backend($1) ok', [pid])).rows[0].ok, true);
    // A second worker gets the same lock once the dead session released it, and does the whole job.
    assert.equal(await job(second, key, 3), 'done');
    if (variant === 'the lock client sees the error') await sleep(200);
    resume.open();
    const outcome = await running;
    assert(outcome instanceof LockConnectionLostError, 'the first job is refused: ' + String(outcome));
    assert.equal((outcome as LockConnectionLostError).code, 'LOCK_CONNECTION_LOST');
    assert.equal((outcome as LockConnectionLostError).status, 503);
    assert.deepEqual(await effects(first), [1], 'nothing of the first job committed after its lock was lost');
    assert.deepEqual(await effects(second), [1, 2, 3]);
  });
}

test('an intact lock commits normally, a task left running after the holder ended is not refused, a failed try-lock demands nothing', async () => {
  let leftover: Promise<unknown> | undefined;
  assert.equal(await job('intact', 'pgerr30-lock-c', 2, async (step) => {
    if (step === 2) leftover = sleep(500).then(() => tenantTx(tenant, async (c) => { await c.query('INSERT INTO pgerr30_lock_effects(tenant_id,job,step) VALUES($1,$2,9)', [tenant, 'intact']); }));
  }), 'done');
  await leftover;
  assert.deepEqual(await effects('intact'), [1, 2, 9]);
  const holder = new pg.Client({ connectionString: pool.options.connectionString });
  await holder.connect();
  try {
    await holder.query('SELECT pg_advisory_lock(hashtextextended($1,0))', ['pgerr30-lock-d']);
    const lock = lockDbClient(new pg.Client({ connectionString: pool.options.connectionString }), 'test-lock-try');
    await lock.connect();
    try {
      const got = await holdingDbLock(lock, async () => {
        const ok = (await lock.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) ok', ['pgerr30-lock-d'])).rows[0].ok;
        await tenantTx(tenant, async (c) => { await c.query('INSERT INTO pgerr30_lock_effects(tenant_id,job,step) VALUES($1,$2,1)', [tenant, 'try-refused']); });
        return ok;
      });
      assert.equal(got, false);
      assert.deepEqual(await effects('try-refused'), [1], 'a lock never acquired is not demanded at commit');
    } finally { await lock.end(); }
  } finally { await holder.end(); }
});
