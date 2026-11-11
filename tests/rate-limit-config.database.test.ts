/** buildApp applies DYNA_RATE_LIMIT_PER_MIN per client address and reports the effective value in /api/health
 * (docs/scale/LOAD-TEST-FULL-20261029.md §4.1). Runs on a fresh PG04 clone dynaminds_rl29_20261029_NN of the
 * restored template migrated to HEAD; it only reads (health) and writes nothing. */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../server/app';
import { pool } from '../server/db';
import { RateLimitConfigurationError } from '../server/rate-limit-config';

assert.equal(process.env.DYNA_TEST, 'true');
const database = new URL(process.env.DATABASE_URL ?? 'invalid://missing');
assert.equal(database.hostname, '127.0.0.1');
assert.equal(database.port, '57084');
assert.match(database.pathname, /^\/dynaminds_(?:rl29|m262)_20261029_[0-9]{2}$/, "fresh clone dynaminds_rl29_20261029_NN (or the m262 integration clone) required");

const saved = process.env.DYNA_RATE_LIMIT_PER_MIN;
const setEnv = (v: string | undefined) => { if (v === undefined) delete process.env.DYNA_RATE_LIMIT_PER_MIN; else process.env.DYNA_RATE_LIMIT_PER_MIN = v; };
after(async () => { setEnv(saved); await pool.end(); });

/** n health requests from one address; statuses in order, and the last 200 body. */
async function burst(app: Awaited<ReturnType<typeof buildApp>>, address: string, n: number) {
  const statuses: number[] = [];
  let health: Record<string, unknown> | undefined;
  for (let i = 0; i < n; i++) {
    const r = await app.inject({ method: 'GET', url: '/api/health', remoteAddress: address });
    statuses.push(r.statusCode);
    if (r.statusCode === 200) health = r.json();
  }
  return { statuses, health };
}

test('unset: /api/health reports 600 from the default and the 601st request from one address gets 429', async () => {
  setEnv(undefined);
  const app = await buildApp();
  try {
    const { statuses, health } = await burst(app, '127.0.0.21', 601);
    assert.deepEqual(statuses.slice(0, 600).filter((s) => s !== 200), []);
    assert.equal(statuses[600], 429);
    assert.deepEqual(health!.rate_limit, { per_address_per_minute: 600, window_seconds: 60, source: 'default' });
    // Another address keeps its own bucket.
    assert.equal((await app.inject({ method: 'GET', url: '/api/health', remoteAddress: '127.0.0.22' })).statusCode, 200);
  } finally { await app.close(); }
});

test('DYNA_RATE_LIMIT_PER_MIN=900: the 601st request passes, /api/health reports 900 from env, the 901st gets 429', async () => {
  setEnv('900');
  const app = await buildApp();
  try {
    const { statuses, health } = await burst(app, '127.0.0.23', 901);
    assert.equal(statuses[600], 200);
    assert.deepEqual(statuses.slice(0, 900).filter((s) => s !== 200), []);
    assert.equal(statuses[900], 429);
    assert.deepEqual(health!.rate_limit, { per_address_per_minute: 900, window_seconds: 60, source: 'env' });
  } finally { await app.close(); }
});

test('an invalid value refuses buildApp before any route exists', async () => {
  setEnv('600 per minute');
  await assert.rejects(buildApp(), (e: unknown) => e instanceof RateLimitConfigurationError && /DYNA_RATE_LIMIT_PER_MIN wymaga/.test(e.message));
});
