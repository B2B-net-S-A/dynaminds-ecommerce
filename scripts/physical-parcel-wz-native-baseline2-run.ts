/** Root-owned baseline witness on the fresh WZ clone. No migration or reset.
 * A genuine regular-catalog physical parcel currently refuses automatic WZ;
 * preserve this observed baseline and complete native fixture for the successor.
 * Strict public BO activation remains separately NOT_READY_HTTP_503; this gate
 * does not bypass it or claim strict-catalog end-to-end acceptance. */
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import pg from 'pg';
import { captureDatabase } from '../data/source-drafts/b2b-financial-return162-root-capture189';
import { createPhysicalWzNativeFixture } from '../data/source-drafts/physical-parcel-wz-native-fixture';
const hash = (v: Buffer | string) => createHash('sha256').update(v).digest('hex');
async function ref(r: { path: string; sha256: string }) { const b = await readFile(r.path); assert.equal(hash(b), r.sha256); return JSON.parse(b.toString()); }
const base = resolve('data/qa-physical-parcel-wz-1791438089610');
const prepRef = { path: resolve(base, 'preparation.private.json'), sha256: '88c5598a4ccd9d93cd613fbe63d8c2dfbbf97ac8b1b5ced12ef179b38e3febd0' };
const prep = await ref(prepRef), input = await ref(prep.input); assert.equal(input.database, 'dynaminds_test_1791438089610');
const u = new URL(input.environment.DATABASE_URL); assert.equal(u.hostname, '127.0.0.1'); assert.equal(u.port, '55432'); assert.equal(u.pathname, '/' + input.database);
const cfgBytes = await readFile(input.configuration.path); assert.equal(hash(cfgBytes), input.configuration.sha256); const cfg = JSON.parse(cfgBytes.toString());
assert.equal(resolve(input.environment.DYNA_LOCAL_CONFIG_PATH), resolve(input.configuration.path));
const directory = resolve(base, 'baseline1'); await mkdir(directory, { mode: 0o700 });
async function save(n: string, v: unknown) { const path = resolve(directory, n), b = Buffer.from(JSON.stringify(v, null, 2) + '\n'); await writeFile(path, b, { flag: 'wx', mode: 0o600 }); return { path, sha256: hash(b) }; }
const sources: Record<string, string> = {};
async function tree(d: string) { for (const e of await readdir(d, { withFileTypes: true })) { const p = d + '/' + e.name; if (e.isDirectory()) await tree(p); else if (e.isFile() && /\.(ts|tsx|sql|css)$/.test(e.name)) sources[p] = hash(await readFile(p)); } }
await tree('server'); await tree('web');
for (const p of ['scripts/physical-parcel-wz-native-baseline2-run.ts', 'data/source-drafts/physical-parcel-wz-native-fixture.ts', 'data/source-drafts/b2b-financial-return162-root-capture189.ts', 'package.json', 'package-lock.json']) sources[p] = hash(await readFile(p));
const sourcesRef = await save('sources.private.json', sources);
const make = (database: string) => new pg.Client({ host: '127.0.0.1', port: 55432, user: 'postgres', password: cfg.dbPassword, database });
async function exclusive() { const c = make('postgres'); try { await c.connect(); assert.equal((await c.query("SELECT count(*)::int n FROM pg_stat_activity WHERE datname=ANY($1::text[]) AND backend_type='client backend'", [[prep.source, input.database]])).rows[0].n, 0); } finally { await c.end(); } }
async function capture(database: string) { const c = make(database); try { await c.connect(); const s = await captureDatabase(c, false); for (const guard of ['competitor_observation_guards', 'buyer_address_guards', 'operative_delivery_valid']) s.guards[guard] = (await c.query('SELECT ' + guard + '() ok')).rows[0].ok; assert(Object.values(s.guards).every(v => v === true)); return s; } finally { await c.end(); } }
await exclusive(); const before = await capture(input.database), sourceBefore = await capture(prep.source);
assert.deepEqual(before, await ref(prep.copy)); assert.deepEqual(sourceBefore, await ref(prep.source_after));
const beforeRef = await save('before.private.json', before), sourceBeforeRef = await save('source-before.private.json', sourceBefore);
Object.assign(process.env, input.environment, { DYNA_TEST: 'true', DYNA_WORKER_DISABLED: 'true', DYNA_IMAGE_DIR: input.images, DYNA_PG_TOOLS: input.pg_tools });
let providers = 0; const previousFetch = globalThis.fetch;
const deniedFetch: typeof fetch = async () => { ++providers; throw Error('External fetch forbidden in WZ baseline'); }; globalThis.fetch = deniedFetch;
const { pool } = await import('../server/db'), { buildApp } = await import('../server/app');
const app = await buildApp({ logging: false, backgroundWorkersEnabled: false, integrationTransport: async () => { ++providers; throw Error('External transport forbidden in WZ baseline'); } });
let failure: unknown, result: unknown, stage = 'genuine_fixture';
try {
  const fixture = await createPhysicalWzNativeFixture({ app, strictCatalog: false, automaticWz: true, remoteAddress: '127.168.1.1', tag: 'regular catalog shared-component baseline' });
  const fixtureRef = await save('fixture.private.json', fixture), afterFixture = await capture(input.database), afterFixtureRef = await save('after-fixture.private.json', afterFixture);
  assert.equal(Object.keys(afterFixture.graph.rows).length, 562); assert.equal(afterFixture.graph.rows.migrations.length, 167);
  for (const [name, rows] of Object.entries(before.graph.rows)) { const current = new Set(afterFixture.graph.rows[name].map(r => hash(JSON.stringify(r)))); for (const old of rows) assert(current.has(hash(JSON.stringify(old))), 'Every pre-existing row retained: ' + name); }
  assert.deepEqual(afterFixture.graph.metadata, before.graph.metadata); assert.deepEqual(afterFixture.graph.exact_metadata, before.graph.exact_metadata); assert.deepEqual(afterFixture.guards, before.guards); assert.deepEqual(afterFixture.primary_keys, before.primary_keys); assert.deepEqual(afterFixture.views, before.views);
  stage = 'actual_baseline_dispatch_refusal';
  const request = { client_key: randomUUID(), scope_hash: fixture.plan.scope_hash, confirmed: true };
  const response = await app.inject({ method: 'POST', url: '/api/order-parcels/plans/' + fixture.plan.id + '/parcels/0/dispatch', headers: { cookie: fixture.credentials.cookie }, remoteAddress: '127.168.1.1', payload: request });
  const responseRef = await save('refusal.private.json', { request, status: response.statusCode, body: response.body });
  assert.equal(response.statusCode, 409, 'Existing physical protocol refuses WZ instead of inventing historical items');
  const after = await capture(input.database); assert.deepEqual(after, afterFixture, 'Full562 zero after refused physical WZ dispatch');
  const sourceAfter = await capture(prep.source); assert.deepEqual(sourceAfter, sourceBefore);
  for (const [p, h] of Object.entries(sources)) assert.equal(hash(await readFile(p)), h); assert.equal(hash(await readFile(input.configuration.path)), input.configuration.sha256); assert.equal(providers, 0);
  result = { status: 'ROOT_PHYSICAL_WZ_GENUINE_167_BASELINE_PASS', database: input.database, tables: 562, migrations: 167, guards: 23, genuine_signups: 1, strict_catalog_http_producer: false, strict_catalog_public_activation: 'NOT_READY_HTTP_503', automatic_wz_http_producer: true, historical_kit_split_and_shared_product: true, actual_409_refusal: true, refused_dispatch_all562_zero: true, every_preexisting_row_retained: true, old_metadata_literal: true, source_whole_exact: true, provider_calls: providers, workers_seed_migration_listener: false, native168_success: 'NOT_RUN', preparation: prepRef, sources: sourcesRef, before: beforeRef, source_before: sourceBeforeRef, fixture: fixtureRef, after_fixture: afterFixtureRef, refusal: responseRef, after: await save('after.private.json', after), source_after: await save('source-after.private.json', sourceAfter) };
} catch (e) { failure = e; await save('failure.private.json', { stage, name: (e as Error)?.name, message: (e as Error)?.message, stack: (e as Error)?.stack }); }
finally {
  const closed = await Promise.allSettled([app.close()]); const appClosed = closed.every(r => r.status === 'fulfilled');
  if (!appClosed) failure ??= Error('Owned app closure failed');
  try { await pool.end(); await exclusive(); assert.equal(providers, 0); assert.equal(globalThis.fetch, deniedFetch); await save('cleanup.private.json', { status: failure ? 'FAILED' : 'PASS', app_closed: appClosed, pool_and_observers_closed: true, provider_calls: providers }); } catch (e) { failure ??= e; }
  globalThis.fetch = previousFetch;
}
if (failure) { console.log(JSON.stringify({ status: 'ROOT_PHYSICAL_WZ_BASELINE_FAILED', directory, stage })); process.exitCode = 1; }
else console.log(JSON.stringify({ status: 'ROOT_PHYSICAL_WZ_GENUINE_167_BASELINE_PASS', result: await save('result.private.json', result) }));
