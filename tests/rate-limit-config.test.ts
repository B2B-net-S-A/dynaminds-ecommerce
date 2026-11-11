/** Per-address rate limit of the installation (DYNA_RATE_LIMIT_PER_MIN, docs/scale/LOAD-TEST-FULL-20261029.md §4.1).
 * No database: the setting parser, the same registration buildApp uses over real loopback HTTP, and the
 * startup refusals of server/index.ts and the ordinary release CLI. buildApp wiring and /api/health are in
 * tests/rate-limit-config.database.test.ts. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import {
  readRateLimitSetting,
  registerAddressRateLimit,
  RateLimitConfigurationError,
  DEFAULT_RATE_LIMIT_PER_MIN,
  RATE_LIMIT_ENV,
} from '../server/rate-limit-config';

const root = fileURLToPath(new URL('..', import.meta.url));

test('unset means the previous fixed value 600 per minute, reported as the default', () => {
  assert.equal(DEFAULT_RATE_LIMIT_PER_MIN, 600);
  assert.equal(RATE_LIMIT_ENV, 'DYNA_RATE_LIMIT_PER_MIN');
  assert.deepEqual(readRateLimitSetting({}), { per_address_per_minute: 600, window_seconds: 60, source: 'default' });
  assert(Object.isFrozen(readRateLimitSetting({})));
});

test('a decimal integer 60…100000 is applied and reported as coming from the environment', () => {
  for (const [text, value] of [['60', 60], ['600', 600], ['1200', 1200], ['100000', 100000]] as const)
    assert.deepEqual(readRateLimitSetting({ DYNA_RATE_LIMIT_PER_MIN: text }), { per_address_per_minute: value, window_seconds: 60, source: 'env' });
});

test('anything else refuses with a Polish operator message instead of falling back to 600', () => {
  for (const text of ['', ' ', '59', '0', '-600', '100001', '1000000', '0600', '600 ', ' 600', '600\n', '6e2', '0x258', '600.0', '600.5', '+600', 'abc', '600/min', '٦٠٠']) {
    assert.throws(() => readRateLimitSetting({ DYNA_RATE_LIMIT_PER_MIN: text }), (e: unknown) => {
      assert(e instanceof RateLimitConfigurationError, JSON.stringify(text));
      assert.equal(e.code, 'RATE_LIMIT_CONFIG_INVALID');
      assert.match(e.message, /^DYNA_RATE_LIMIT_PER_MIN wymaga liczby całkowitej od 60 do 100000/);
      assert(e.message.includes(JSON.stringify(text)), 'the refused value is named');
      return true;
    });
  }
  // A long value is cut in the message (it is configuration, not a secret, but the line stays short).
  assert.throws(() => readRateLimitSetting({ DYNA_RATE_LIMIT_PER_MIN: 'x'.repeat(500) }), (e: Error) => e.message.length < 400);
});

async function serve(setting: ReturnType<typeof readRateLimitSetting>) {
  const app = Fastify();
  await registerAddressRateLimit(app, setting);
  app.get('/ping', async () => ({ ok: true }));
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  assert(address && typeof address === 'object');
  return { app, url: `http://127.0.0.1:${address.port}/ping` };
}
/** n sequential requests from this process's one loopback address; status codes in order. */
async function statuses(url: string, n: number) {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const r = await fetch(url);
    await r.arrayBuffer();
    out.push(r.status);
  }
  return out;
}

test('HTTP: at the default the 601st request in a minute from one address gets 429', async () => {
  const { app, url } = await serve(readRateLimitSetting({}));
  try {
    const s = await statuses(url, 601);
    assert.deepEqual(s.slice(0, 600).filter((x) => x !== 200), []);
    assert.equal(s[600], 429);
  } finally { await app.close(); }
});

test('HTTP: with DYNA_RATE_LIMIT_PER_MIN=700 the 601st request passes and the 701st gets 429', async () => {
  const { app, url } = await serve(readRateLimitSetting({ DYNA_RATE_LIMIT_PER_MIN: '700' }));
  try {
    const s = await statuses(url, 701);
    assert.equal(s[600], 200);
    assert.deepEqual(s.slice(0, 700).filter((x) => x !== 200), []);
    assert.equal(s[700], 429);
  } finally { await app.close(); }
});

test('server/index.ts refuses an invalid value before migrate() touches the database', () => {
  // DATABASE_URL points at a closed loopback port: reaching migrate() would fail with a connection error instead.
  const r = spawnSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'server/index.ts'], {
    cwd: root, encoding: 'utf8', timeout: 60000,
    env: { ...process.env, DYNA_RATE_LIMIT_PER_MIN: '10', DATABASE_URL: 'postgres://postgres:x@127.0.0.1:9/dynaminds_rl29_none', PORT: '1' },
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /DYNA_RATE_LIMIT_PER_MIN wymaga liczby całkowitej od 60 do 100000/);
  assert.doesNotMatch(r.stderr, /ECONNREFUSED|migrat/i);
});

test('the ordinary release CLI refuses before reading its selection and prints the Polish message with its code', async () => {
  const { main, ordinaryLocalStartFailure } = await import('../server/ordinary-local-cli');
  const before = process.env.DYNA_RATE_LIMIT_PER_MIN;
  process.env.DYNA_RATE_LIMIT_PER_MIN = 'sześćset';
  try {
    // The selection path does not exist: a check after reading it would fail with ENOENT instead.
    const e = await main(['/nonexistent-rl29/selection.json', 'a'.repeat(64), '4101']).then(() => undefined, (x: unknown) => x);
    assert(e instanceof RateLimitConfigurationError);
    const line = ordinaryLocalStartFailure(e);
    assert.equal(line.status, 'ORDINARY_LOCAL_START_FAILED');
    assert.equal(line.code, 'RATE_LIMIT_CONFIG_INVALID');
    assert.match(line.message!, /^DYNA_RATE_LIMIT_PER_MIN wymaga liczby całkowitej od 60 do 100000.*"sześćset"/);
  } finally {
    if (before === undefined) delete process.env.DYNA_RATE_LIMIT_PER_MIN; else process.env.DYNA_RATE_LIMIT_PER_MIN = before;
  }
});
