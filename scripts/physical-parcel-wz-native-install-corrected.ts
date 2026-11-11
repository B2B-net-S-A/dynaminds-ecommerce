/** Genuine root 167->168 installation on the accepted regular-catalog WZ clone.
 * Uses the established migrate(), no seed/reset/app/worker or external request. */
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import pg from 'pg';
import { captureDatabase } from '../data/source-drafts/b2b-financial-return162-root-capture189';
const hash = (v: Buffer | string) => createHash('sha256').update(v).digest('hex');
async function ref(r: { path: string; sha256: string }) { const b = await readFile(r.path); assert.equal(hash(b), r.sha256); return JSON.parse(b.toString()); }
const base = resolve('data/qa-physical-parcel-wz-1791439394750');
const baselineRef = { path: resolve(base, 'baseline1/result.private.json'), sha256: '5d2dbc436484135fa7962492089031c5ff0632b078b21152fb7b7945ff51f8c3' };
const baseline = await ref(baselineRef), prep = await ref(baseline.preparation), input = await ref(prep.input);
assert.equal(input.database, 'dynaminds_test_1791439394750');
const u = new URL(input.environment.DATABASE_URL); assert.equal(u.hostname, '127.0.0.1'); assert.equal(u.port, '55432'); assert.equal(u.pathname, '/' + input.database);
const cfgBytes = await readFile(input.configuration.path); assert.equal(hash(cfgBytes), input.configuration.sha256); const cfg = JSON.parse(cfgBytes.toString());
assert.equal(resolve(input.environment.DYNA_LOCAL_CONFIG_PATH), resolve(input.configuration.path));
const adoption = await ref({ path: resolve(base, 'sql-correction1/result.json'), sha256: '57a8de1c4d54080b58fb6bcd9e4065f99ace9815b1fe5389f9e1909a3c83dfad' });
for (const [p, h] of Object.entries(adoption.actual_sources) as [string, string][]) assert.equal(hash(await readFile(p)), h);
assert.equal(hash(await readFile('server/168_physical_parcel_wz.sql')), '1ccedd12d27cf4a3fb2f54775fb1e3d413249487d0ad6ea0f27f694b191e6304');
const directory = resolve(base, 'install1'); await mkdir(directory, { mode: 0o700 });
async function save(n: string, v: unknown) { const path = resolve(directory, n), bytes = Buffer.from(JSON.stringify(v, null, 2) + '\n'); await writeFile(path, bytes, { flag: 'wx', mode: 0o600 }); return { path, sha256: hash(bytes) }; }
const sources: Record<string, string> = {};
async function tree(d: string) { for (const e of await readdir(d, { withFileTypes: true })) { const p = d + '/' + e.name; if (e.isDirectory()) await tree(p); else if (e.isFile() && /\.(ts|tsx|sql|css)$/.test(e.name)) sources[p] = hash(await readFile(p)); } }
await tree('server'); await tree('web'); for (const p of ['scripts/physical-parcel-wz-native-install-corrected.ts', 'data/source-drafts/b2b-financial-return162-root-capture189.ts', 'scripts/stocktake-adjustments-native164-preservation.ts', 'scripts/return-destinations-native162-restore-readback.ts', 'package.json', 'package-lock.json']) sources[p] = hash(await readFile(p)); const sourcesRef = await save('sources.private.json', sources);
const make = (name: string) => new pg.Client({ host: '127.0.0.1', port: 55432, user: 'postgres', password: cfg.dbPassword, database: name });
async function exclusive() { const c = make('postgres'); try { await c.connect(); assert.equal((await c.query("SELECT count(*)::int n FROM pg_stat_activity WHERE datname=ANY($1::text[]) AND backend_type='client backend'", [[prep.source, input.database]])).rows[0].n, 0); } finally { await c.end(); } }
async function capture(name: string, own = false) { const c = make(name); try { await c.connect(); const s = await captureDatabase(c, false); for (const guard of ['competitor_observation_guards', 'buyer_address_guards', 'operative_delivery_valid']) s.guards[guard] = (await c.query('SELECT ' + guard + '() ok')).rows[0].ok; if (own) s.guards.parcel_physical_wz_valid = (await c.query('SELECT parcel_physical_wz_valid() ok')).rows[0].ok; assert(Object.values(s.guards).every(v => v === true)); return s; } finally { await c.end(); } }
await exclusive(); const before = await capture(input.database), sourceBefore = await capture(prep.source); assert.deepEqual(before, await ref(baseline.after)); assert.deepEqual(sourceBefore, await ref(baseline.source_after));
const beforeRef = await save('before.private.json', before), sourceBeforeRef = await save('source-before.private.json', sourceBefore);
Object.assign(process.env, input.environment, { DYNA_TEST: 'true', DYNA_WORKER_DISABLED: 'true', DYNA_IMAGE_DIR: input.images, DYNA_PG_TOOLS: input.pg_tools });
const { pool, migrate } = await import('../server/db'); let failure: unknown, result: unknown, stage = 'migrate';
try {
  await migrate(); stage = 'full_preservation'; const after = await capture(input.database, true);
  assert.equal(Object.keys(after.graph.rows).length, 566); assert.equal(after.graph.rows.migrations.length, 168);
  for (const [name, rows] of Object.entries(before.graph.rows)) assert.deepEqual(name === 'migrations' ? after.graph.rows[name].filter(r => r.row.name !== '168_physical_parcel_wz') : after.graph.rows[name], rows, 'Every old global row literal: ' + name);
  assert.deepEqual(after.primary_keys.filter(r => before.primary_keys.some(b => b.relname === r.relname)), before.primary_keys); assert.deepEqual(after.sequences, before.sequences); assert.deepEqual(after.views, before.views);
  const old = before.graph.exact_metadata, now = after.graph.exact_metadata;
  for (const key of ['relations', 'tables', 'triggers'] as const) for (const r of old[key]) assert.deepEqual(now[key].find((n: any) => n.oid === r.oid), r, 'Existing exact metadata ' + key);
  const certificate = after.graph.rows.parcel_physical_wz_certificate[0]?.row; assert(certificate); assert.equal(after.graph.rows.parcel_physical_wz_certificate.length, 1);
  assert.deepEqual(certificate.original151_manifest, before.graph.rows.warehouse_wz_issuer_manifest[0].row); assert.deepEqual(certificate.original167_certificate, before.graph.rows.operative_delivery_certificate[0].row);
  const replacements = new Set(['warehouse_wz_issuer_prepare', 'warehouse_wz_issuer_commercial', 'warehouse_wz_issuer_complete', 'warehouse_wz_issuer_guards']);
  for (const f of old.functions) { const n = now.functions.find((r: any) => r.oid === f.oid); assert(n); if (replacements.has(f.meta.proname)) {
    const name = f.meta.proname; assert.equal(certificate.predecessor_functions[name].body, f.meta.prosrc); assert.equal(certificate.predecessor_functions[name].definition, f.definition); assert.equal(certificate.successor_functions[name].body, n.meta.prosrc); assert.equal(certificate.successor_functions[name].definition, n.definition);
    assert.deepEqual({ ...n, definition: f.definition, meta: { ...n.meta, prosrc: f.meta.prosrc } }, f, 'Only four certified same-OID body changes');
  } else assert.deepEqual(n, f, 'Every other original function literal'); }
  const tables = now.tables.filter((r: any) => !old.tables.some((b: any) => b.oid === r.oid)); assert.equal(tables.length, 4); assert(tables.every((r: any) => r.relname.startsWith('parcel_physical_wz_')));
  const foreignKeys = tables.flatMap((t: any) => t.constraints.filter((k: any) => k.meta.contype === 'f')); assert.equal(foreignKeys.length, 10);
  const triggers = now.triggers.filter((r: any) => !old.triggers.some((b: any) => b.oid === r.oid)), ri = triggers.filter((r: any) => r.meta.tgisinternal); assert.equal(ri.length, 40);
  for (const fk of foreignKeys) { const linked = ri.filter((r: any) => r.meta.tgconstraint === fk.meta.oid); assert.equal(linked.length, 4); assert.deepEqual(linked.map((r: any) => r.meta.tgrelid).sort(), [fk.meta.conrelid, fk.meta.conrelid, fk.meta.confrelid, fk.meta.confrelid].sort()); }
  assert(triggers.filter((r: any) => !r.meta.tgisinternal).every((r: any) => r.relname.startsWith('parcel_physical_wz_') && r.meta.tgname.startsWith('parcel_physical_wz_')));
  for (const r of now.relations.filter((r: any) => !old.relations.some((b: any) => b.oid === r.oid))) assert(r.relname.startsWith('parcel_physical_wz_'));
  for (const f of now.functions.filter((r: any) => !old.functions.some((b: any) => b.oid === r.oid))) assert(f.signature.startsWith('parcel_physical_wz_'));
  for (const name of ['parcel_physical_wz_previews', 'parcel_physical_wz_mappings', 'parcel_physical_wz_bindings']) assert.deepEqual(after.graph.rows[name], []);
  assert.deepEqual({ ...after.guards, parcel_physical_wz_valid: undefined }, { ...before.guards, parcel_physical_wz_valid: undefined });
  const sourceAfter = await capture(prep.source); assert.deepEqual(sourceAfter, sourceBefore); for (const [p, h] of Object.entries(sources)) assert.equal(hash(await readFile(p)), h); assert.equal(hash(await readFile(input.configuration.path)), input.configuration.sha256);
  result = { status: 'ROOT_PHYSICAL_WZ_168_INSTALL_PASS', database: input.database, tables: 566, migrations: 168, guards: 24, all_old_global_rows_literal: true, old_metadata_same_oids_except_four_certified_bodies: true, child_foreign_keys: 10, owned_internal_ri: 40, old151_and167_certificates_literal: true, source_whole_exact: true, native_business_flow: 'NOT_RUN', strict_public_bo_activation: 'NOT_READY_HTTP_503', baseline: baselineRef, sources: sourcesRef, before: beforeRef, source_before: sourceBeforeRef, after: await save('after.private.json', after), source_after: await save('source-after.private.json', sourceAfter) };
} catch (e) { failure = e; await save('failure.private.json', { stage, name: (e as Error)?.name, message: (e as Error)?.message, code: (e as any)?.code, stack: (e as Error)?.stack }); }
finally { try { await pool.end(); await exclusive(); await save('cleanup.private.json', { status: failure ? 'FAILED' : 'PASS', pool_and_observers_closed: true }); } catch (e) { failure ??= e; } }
if (failure) { console.log(JSON.stringify({ status: 'ROOT_PHYSICAL_WZ_168_INSTALL_FAILED', directory, stage })); process.exitCode = 1; }
else console.log(JSON.stringify({ status: 'ROOT_PHYSICAL_WZ_168_INSTALL_PASS', result: await save('result.private.json', result) }));
