/** Root-owned actual physical-WZ business flow after the accepted168 install.
 * Existing genuine cookie/fixture; no seed, migration, listener or worker. */
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import pg from 'pg';
import { captureDatabase } from '../data/source-drafts/b2b-financial-return162-root-capture189';
import { acceptPhysicalParcelWz } from '../data/source-drafts/physical-parcel-wz-native-acceptance2';
const hash = (v: Buffer | string) => createHash('sha256').update(v).digest('hex');
async function ref(r: { path: string; sha256: string }) { const b = await readFile(r.path); assert.equal(hash(b), r.sha256); return JSON.parse(b.toString()); }
const base = resolve('data/qa-physical-parcel-wz-1791439394750');
const installRef = { path: resolve(base, 'install1/result.private.json'), sha256: '3fd1c438298df2da6705e560528084c536fa79dda2d4362d453039af2323b003' };
const install = await ref(installRef), baseline = await ref(install.baseline), prep = await ref(baseline.preparation), input = await ref(prep.input), fixture = await ref(baseline.fixture);
assert.equal(input.database, 'dynaminds_test_1791439394750'); const u = new URL(input.environment.DATABASE_URL); assert.equal(u.hostname, '127.0.0.1'); assert.equal(u.port, '55432'); assert.equal(u.pathname, '/' + input.database);
const cfgBytes = await readFile(input.configuration.path); assert.equal(hash(cfgBytes), input.configuration.sha256); const cfg = JSON.parse(cfgBytes.toString()); assert.equal(resolve(input.environment.DYNA_LOCAL_CONFIG_PATH), resolve(input.configuration.path));
const directory = resolve(base, 'native1'); await mkdir(directory, { mode: 0o700 });
async function save(n: string, v: unknown) { const path = resolve(directory, n), b = Buffer.from(JSON.stringify(v, null, 2) + '\n'); await writeFile(path, b, { flag: 'wx', mode: 0o600 }); return { path, sha256: hash(b) }; }
const sources: Record<string, string> = {};
async function tree(d: string) { for (const e of await readdir(d, { withFileTypes: true })) { const p = d + '/' + e.name; if (e.isDirectory()) await tree(p); else if (e.isFile() && /\.(ts|tsx|sql|css)$/.test(e.name)) sources[p] = hash(await readFile(p)); } }
await tree('server'); await tree('web'); for (const p of ['scripts/physical-parcel-wz-native-flow2-run.ts', 'data/source-drafts/physical-parcel-wz-native-acceptance2.ts', 'data/source-drafts/b2b-financial-return162-root-capture189.ts', 'scripts/stocktake-adjustments-native164-preservation.ts', 'scripts/return-destinations-native162-restore-readback.ts', 'package.json', 'package-lock.json']) sources[p] = hash(await readFile(p));
const installedSources = await ref(install.sources); for (const [p, h] of Object.entries(installedSources) as [string, string][]) assert.equal(hash(await readFile(p)), h);
const sourcesRef = await save('sources.private.json', sources);
const make = (name: string) => new pg.Client({ host: '127.0.0.1', port: 55432, user: 'postgres', password: cfg.dbPassword, database: name });
async function exclusive() { const c = make('postgres'); try { await c.connect(); assert.equal((await c.query("SELECT count(*)::int n FROM pg_stat_activity WHERE datname=ANY($1::text[]) AND backend_type='client backend'", [[prep.source, input.database]])).rows[0].n, 0); } finally { await c.end(); } }
async function capture(name: string, own = false) { const c = make(name); try { await c.connect(); const s = await captureDatabase(c, false); for (const guard of ['competitor_observation_guards', 'buyer_address_guards', 'operative_delivery_valid', ...(own ? ['parcel_physical_wz_valid'] : [])]) s.guards[guard] = (await c.query('SELECT ' + guard + '() ok')).rows[0].ok; assert(Object.values(s.guards).every(v => v === true)); return s; } finally { await c.end(); } }
await exclusive(); const before = await capture(input.database, true), sourceBefore = await capture(prep.source); assert.deepEqual(before, await ref(install.after)); assert.deepEqual(sourceBefore, await ref(install.source_after));
const beforeRef = await save('before.private.json', before), sourceBeforeRef = await save('source-before.private.json', sourceBefore);
Object.assign(process.env, input.environment, { DYNA_TEST: 'true', DYNA_WORKER_DISABLED: 'true', DYNA_IMAGE_DIR: input.images, DYNA_PG_TOOLS: input.pg_tools });
const previousFetch = globalThis.fetch; let providers = 0; const deny: typeof fetch = async () => { ++providers; throw Error('External fetch forbidden in physical WZ flow'); }; globalThis.fetch = deny;
const { pool } = await import('../server/db'), { buildApp } = await import('../server/app');
const app = await buildApp({ logging: false, backgroundWorkersEnabled: false, integrationTransport: async () => { ++providers; throw Error('External transport forbidden in physical WZ flow'); } });
let failure: unknown, result: unknown;const nativeErrors:unknown[]=[];
app.addHook('onError',async(_req,_reply,e)=>{nativeErrors.push({name:e.name,message:e.message,code:(e as any).code,where:(e as any).where,stack:e.stack});});
try {
  const acceptance = await acceptPhysicalParcelWz({ app, fixture, capture: () => capture(input.database, true), save });
  const after = await capture(input.database, true), sourceAfter = await capture(prep.source); assert.deepEqual(sourceAfter, sourceBefore);
  assert.deepEqual(after.graph.metadata, before.graph.metadata); assert.deepEqual(after.graph.exact_metadata, before.graph.exact_metadata); assert.deepEqual(after.primary_keys, before.primary_keys); assert.deepEqual(after.views, before.views); assert.deepEqual(after.guards, before.guards);
  assert.equal(Object.keys(after.graph.rows).length, 566); assert.equal(after.graph.rows.migrations.length, 168);
  for (const name of ['warehouse_wz_issuer_manifest', 'operative_delivery_certificate', 'parcel_physical_wz_certificate', 'migrations']) assert.deepEqual(after.graph.rows[name], before.graph.rows[name]);
  for (const [name, rows] of Object.entries(before.graph.rows)) {
    const unrelated = rows.filter(r => r.row.tenant_id !== fixture.tenant), current = new Set(after.graph.rows[name].map(r => hash(JSON.stringify(r))));
    for (const old of unrelated) assert(current.has(hash(JSON.stringify(old))), 'All foreign/global rows retained: ' + name);
  }
  for (const [p, h] of Object.entries(sources)) assert.equal(hash(await readFile(p)), h); assert.equal(hash(await readFile(input.configuration.path)), input.configuration.sha256); assert.equal(providers, 0);
  result = { status: 'ROOT_PHYSICAL_WZ_168_NATIVE_FLOW_PASS', database: input.database, tables: 566, migrations: 168, guards: 24, acceptance, metadata_and_certificates_literal: true, all_foreign_global_rows_retained: true, source_whole_exact: true, provider_calls: providers, workers_seed_migration_listener: false, strict_public_bo_activation: 'NOT_READY_HTTP_503', install: installRef, sources: sourcesRef, before: beforeRef, source_before: sourceBeforeRef, after: await save('after.private.json', after), source_after: await save('source-after.private.json', sourceAfter), browser:'NOT_RUN', restored_copy:'NOT_RUN', held_iam:'NOT_RUN' };
} catch (e) { failure = e; await save('failure.private.json', { name: (e as Error)?.name, message: (e as Error)?.message, code: (e as any)?.code, stack: (e as Error)?.stack }); }
finally {
  await save('native-errors.private.json',nativeErrors);
  const closed = await Promise.allSettled([app.close()]); const appClosed = closed.every(r => r.status === 'fulfilled'); if (!appClosed) failure ??= Error('Owned app closure failed');
  try { await pool.end(); await exclusive(); assert.equal(providers, 0); assert.equal(globalThis.fetch, deny); await save('cleanup.private.json', { status: failure ? 'FAILED' : 'PASS', app_closed: appClosed, pool_and_observers_closed: true, provider_calls: providers }); } catch (e) { failure ??= e; }
  globalThis.fetch = previousFetch;
}
if (failure) { console.log(JSON.stringify({ status: 'ROOT_PHYSICAL_WZ_168_NATIVE_FAILED', directory })); process.exitCode = 1; }
else console.log(JSON.stringify({ status: 'ROOT_PHYSICAL_WZ_168_NATIVE_FLOW_PASS', result: await save('result.private.json', result) }));
