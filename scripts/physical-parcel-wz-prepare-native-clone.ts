/** Root-owned preparation: one fresh local clone for physical parcel WZ acceptance.
 * Preserves the complete accepted XML source; no migration, seed, app or workers. */
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import pg from 'pg';
import { captureDatabase } from '../data/source-drafts/b2b-financial-return162-root-capture189';
const hash = (v: Buffer | string) => createHash('sha256').update(v).digest('hex');
async function ref(r: { path: string; sha256: string }) {
  const b = await readFile(r.path); assert.equal(hash(b), r.sha256); return JSON.parse(b.toString());
}
const base = resolve('data/qa-fa3-xml-1791436044774');
const accepted = await ref({ path: resolve(base, 'restored-xml-api1/result.private.json'), sha256: '3ab30cbf518f2197d84fe46c02b3f7945f67e82938e2510ca20f6b8c039398a4' });
const original = await ref({ path: resolve(base, 'input.private.json'), sha256: '45940aa7576bbdf8c8edc13802f94656bdbab317db4d0550a482d3b5c0c52406' });
const source = original.database; assert.equal(source, 'dynaminds_test_1791436044774'); assert.equal(accepted.source_database, source);
const url = new URL(original.environment.DATABASE_URL);
assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.port, '55432'); assert.equal(url.pathname, '/' + source);
assert.equal(resolve(original.environment.DYNA_LOCAL_CONFIG_PATH), resolve(original.configuration.path));
const cfgBytes = await readFile(original.configuration.path); assert.equal(hash(cfgBytes), original.configuration.sha256);
const st = await lstat(original.configuration.path); assert(st.isFile() && !st.isSymbolicLink() && (st.mode & 0o777) === 0o600);
const cfg = JSON.parse(cfgBytes.toString()), database = 'dynaminds_test_' + Date.now(); assert.match(database, /^dynaminds_test_[0-9]{13}$/);
const directory = resolve('data/qa-physical-parcel-wz-' + database.slice(-13)); await mkdir(directory, { mode: 0o700 });
async function save(n: string, value: unknown) {
  const path = resolve(directory, n), bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n');
  await writeFile(path, bytes, { flag: 'wx', mode: 0o600 }); return { path, sha256: hash(bytes) };
}
const make = (name: string) => new pg.Client({ host: '127.0.0.1', port: 55432, user: 'postgres', password: cfg.dbPassword, database: name });
async function capture(name: string) {
  const c = make(name); try {
    await c.connect(); const s = await captureDatabase(c, false);
    for (const guard of ['competitor_observation_guards', 'buyer_address_guards', 'operative_delivery_valid'])
      s.guards[guard] = (await c.query('SELECT ' + guard + '() ok')).rows[0].ok;
    assert(Object.values(s.guards).every(v => v === true)); return s;
  } finally { await c.end(); }
}
const admin = make('postgres'); await admin.connect();
let failure: unknown, result: unknown;
try {
  const names = async () => (await admin.query('SELECT datname FROM pg_database ORDER BY datname')).rows;
  const roles = async () => (await admin.query('SELECT to_jsonb(r) row FROM pg_roles r ORDER BY rolname')).rows;
  const members = async () => (await admin.query('SELECT to_jsonb(m) row FROM pg_auth_members m ORDER BY roleid,member,grantor')).rows;
  const exclusive = async () => assert.equal((await admin.query("SELECT count(*)::int n FROM pg_stat_activity WHERE datname=ANY($1::text[]) AND backend_type='client backend'", [[source, database]])).rows[0].n, 0);
  await exclusive(); const beforeNames = await names(), beforeRoles = await roles(), beforeMembers = await members();
  const before = await capture(source); assert.deepEqual(before, await ref(accepted.source_after), 'Complete source continuity from accepted XML recovery');
  assert.equal(Object.keys(before.graph.rows).length, 562); assert.equal(before.graph.rows.migrations.length, 167); assert.equal(Object.keys(before.guards).length, 23);
  const beforeRef = await save('source-before.private.json', before);
  await exclusive(); await admin.query('CREATE DATABASE "' + database + '" WITH TEMPLATE "' + source + '"');
  const copy = await capture(database), after = await capture(source); assert.deepEqual(after, before);
  for (const key of ['rows', 'metadata'] as const) assert.deepEqual(copy.graph[key], before.graph[key], 'Complete portable clone ' + key);
  assert.deepEqual(copy.guards, before.guards); assert.deepEqual(copy.primary_keys, before.primary_keys); assert.deepEqual(copy.sequences, before.sequences); assert.deepEqual(copy.views, before.views);
  assert.deepEqual(await roles(), beforeRoles); assert.deepEqual(await members(), beforeMembers);
  assert.deepEqual(await names(), [...beforeNames, { datname: database }].sort((a, b) => a.datname.localeCompare(b.datname)));
  const configPath = resolve(directory, 'configuration.private.json'); await writeFile(configPath, cfgBytes, { flag: 'wx', mode: 0o600 }); url.pathname = '/' + database;
  const input = { ...original, database, directory, environment: { ...original.environment, DATABASE_URL: url.toString(), DYNA_LOCAL_CONFIG_PATH: configPath }, configuration: { ...original.configuration, path: configPath } };
  const inputRef = await save('input.private.json', input), copyRef = await save('copy.private.json', copy), afterRef = await save('source-after.private.json', after);
  await exclusive(); assert.equal(hash(await readFile(original.configuration.path)), original.configuration.sha256);
  result = { status: 'ROOT_PHYSICAL_WZ_NEW_167_CLONE_PASS', source, database, tables: 562, migrations: 167, guards: 23, source_whole_exact: true, all_portable_rows_metadata_literal: true, only_one_database_added: true, roles_memberships_literal: true, clients_closed: true, migration_seed_app_workers: false, native_wz_business_flow: 'NOT_RUN', input: inputRef, source_before: beforeRef, source_after: afterRef, copy: copyRef, accepted_xml_copy_api: { path: resolve(base, 'restored-xml-api1/result.private.json'), sha256: '3ab30cbf518f2197d84fe46c02b3f7945f67e82938e2510ca20f6b8c039398a4' }, runner_sha256: hash(await readFile('scripts/physical-parcel-wz-prepare-native-clone.ts')) };
} catch (e) {
  failure = e; await save('failure.private.json', { name: (e as Error)?.name, message: (e as Error)?.message, stack: (e as Error)?.stack });
} finally { try { await admin.end(); } catch (e) { failure ??= e; } }
if (failure) { console.log(JSON.stringify({ status: 'ROOT_PHYSICAL_WZ_CLONE_FAILED', directory })); process.exitCode = 1; }
else console.log(JSON.stringify({ status: 'ROOT_PHYSICAL_WZ_NEW_167_CLONE_PASS', database, result: await save('preparation.private.json', result) }));
