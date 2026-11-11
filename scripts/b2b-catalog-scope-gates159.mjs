import assert from 'node:assert/strict';
import pg from 'pg';
import { readFileSync, openSync, closeSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

// Fixed local infrastructure and an exclusively created disposable database.
// Passwords remain in RAM/environment; public output contains only evidence.
const groups = {
  service: ['tests/b2b-catalog-scope.test.ts'],
  contract: ['tests/b2b-catalog-scope-contract.test.ts'],
  adapters: ['tests/b2b-catalog-scope-adapters.test.ts'],
  commerce: ['tests/b2b-catalog-commerce-scopes.test.ts'],
  network: ['tests/b2b-catalog-network-scopes.test.ts'],
  dropshipping: ['tests/b2b-catalog-dropshipping-scopes.test.ts'],
  migration: ['tests/b2b-catalog-scope-migration.test.ts'],
  key_safety: ['tests/b2b-catalog-bind-key-safety.test.ts'],
  legacy_network: ['tests/b2b-network.test.ts', 'tests/b2b-network-orders.test.ts'],
  legacy_orders: ['tests/b2b-network-orders.test.ts'],
  image_compat: ['tests/b2b-network.test.ts'],
  merge_counters: ['tests/order-merge-counters.test.ts'],
  scope_registered: [
    'tests/b2b-catalog-scope.test.ts', 'tests/b2b-catalog-scope-contract.test.ts',
    'tests/b2b-catalog-scope-adapters.test.ts', 'tests/b2b-catalog-network-scopes.test.ts',
    'tests/b2b-catalog-commerce-scopes.test.ts', 'tests/b2b-catalog-dropshipping-scopes.test.ts',
    'tests/b2b-catalog-scope-migration.test.ts', 'tests/b2b-catalog-bind-key-safety.test.ts',
  ],
  merge_regression: ['tests/order-merges.test.ts', 'tests/order-merge-custody.test.ts'],
  merge_isolation: ['tests/b2b-catalog-scope.test.ts', 'tests/order-merge-counters.test.ts'],
};
const patterns = { image_compat: '^cached supplier image retains exact bytes' };
const [group, phase] = process.argv.slice(2);
assert.equal(process.argv.length, 4);
assert(Object.hasOwn(groups, group)); assert.match(phase, /^[a-z][a-z0-9-]{0,50}$/);
assert(!process.env.DATABASE_URL, 'Parent must not select an existing database');
const configPath = '<workspace>/app/.local.json';
const configStat = statSync(configPath); assert(configStat.isFile()); assert.equal(configStat.mode & 0o777, 0o600);
const { dbPassword } = JSON.parse(readFileSync(configPath, 'utf8')); assert.equal(typeof dbPassword, 'string');
const sources = ['server/db.ts', 'server/144_b2b_catalog_scopes.sql', 'server/b2b-catalog-scope-schema.ts',
  'server/b2b-catalog-scope-routes.ts', 'server/b2b-catalog-scope.ts', 'server/b2b-catalog-scope-adapters.ts',
  'server/b2b-network.ts', 'server/b2b-network-orders.ts', 'server/b2b-network-dropshipping.ts', 'server/b2b.ts',
  'server/app.ts', 'server/developer-api.ts', 'server/145_order_merge_counters.sql', ...groups[group]];
const sourceSha = Object.fromEntries(sources.map(path => [path, createHash('sha256').update(readFileSync(path)).digest('hex')]));
const log = resolve('docs', `b2b-catalog-${group}159-${phase}.txt`);
const evidence = resolve('docs', `b2b-catalog-${group}159-${phase}.json`);
const fd = openSync(log, 'wx', 0o644);
const name = `dynaminds_test_${process.pid}`;
const admin = new pg.Client({ host: '127.0.0.1', port: 55432, user: 'postgres', password: dbPassword, database: 'postgres' });
let created = false, code = 1;
try {
  await admin.connect();
  // Every scratch schema shares this server's lock-entry budget. Keep one
  // database gate admitted at a time without changing the live server config.
  // The session lock is released by admin.end(), including a failed child.
  await admin.query('SELECT pg_advisory_lock($1)', [982376159]);
  await admin.query(`CREATE DATABASE ${name}`); created = true;
  const url = new URL(`postgres://postgres@127.0.0.1:55432/${name}`); url.password = dbPassword;
  const child = spawn(process.execPath, ['--import', 'tsx', '--test', '--test-concurrency=1',
    ...(patterns[group] ? ['--test-name-pattern', patterns[group]] : []), ...groups[group]], {
    env: { ...process.env, DYNA_LOCAL_CONFIG_PATH: configPath, DYNA_TEST: 'true', DYNA_WORKER_DISABLED: 'true', DATABASE_URL: url.href },
    stdio: ['ignore', fd, fd],
  });
  code = await new Promise((accept, reject) => { child.once('error', reject); child.once('exit', value => accept(value ?? 1)); });
} finally {
  closeSync(fd);
  if (created) await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
  await admin.end();
}
const drift = sources.filter(path => createHash('sha256').update(readFileSync(path)).digest('hex') !== sourceSha[path]);
writeFileSync(evidence, JSON.stringify({ stage: 159, group, phase, exit_code: code, source_sha256_at_launch: sourceSha,
  source_drift_during_run: drift, scratch_database_removed: created, serialized_database_gate: true,
  log_sha256: createHash('sha256').update(readFileSync(log)).digest('hex'), provider_verified: false, native_verified: false }, null, 2) + '\n', { flag: 'wx', mode: 0o644 });
console.log(JSON.stringify({ group, phase, exit_code: code, source_drift: drift.length, scratch_database_removed: created, evidence }));
process.exitCode = code || (drift.length ? 1 : 0);
