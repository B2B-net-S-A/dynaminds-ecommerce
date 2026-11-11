#!/usr/bin/env node
// Packaged release for the scale generator (stage 5, manifest section 2): git cut of one commit,
// source contract = the last reviewed contract (N29, migrations ..225) plus every later release migration
// from RELEASE_MIGRATIONS (Native edge + its compiled cold-catalogue pair as runtime source), vite build,
// then the ordinary emitter tools/build/local-package.mjs. File-only: no PostgreSQL, app, worker or network.
//
//   node tools/scale/release-build.mjs --out <new absolute dir> [--commit <40 hex>] \
//     [--base-contract <dir> --base-contract-sha <64 hex>]
//
// Result: <out>/release-canonical (the package), <out>/release-build.json (commit, manifest sha256, package
// sha256 = sha256 of the sorted "sha256  path" list of every package file, contract delta, timings).
// The output directory must not exist; its parent must (runtime packages resolve their locked dependencies
// from an ancestor node_modules, e.g. local-builds/node_modules).
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const REPO = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const N29 = path.resolve(REPO, '../../local-builds/full-base-preview-20261017/base-wire-n29-20261023-01/source-contract');
// Manifest sha256 of the N29 source contract (its prepare-release.result.private.json, manifest_sha256).
const N29_SHA = '548e34291ded9998cef9c7db7392e7ff4a5f377ed833c332e51f0209cd90cc06';
const COLD = 'shared/large-import-dependencies/pim-large-import173-business-traversal-ui/';

const { values: a } = parseArgs({ options: { out: { type: 'string' }, commit: { type: 'string' },
  'base-contract': { type: 'string' }, 'base-contract-sha': { type: 'string' } } });
const sha = (b) => createHash('sha256').update(b).digest('hex');
const json = (x) => Buffer.from(JSON.stringify(x, null, 2) + '\n');
// Contract JSON the package ships (contract/source-release-manifest.json, contract/source-inventory.json) is written
// without indentation: the emitted package was capped at 96 MiB (tools/build/emitted-release.mjs; 128 MiB since
// 26.10) and HEAD on 26.10 was 6.9 KB over it with the indented N29 spelling. Same data; validators parse it and
// pin its sha256.
const compact = (x) => Buffer.from(JSON.stringify(x) + '\n');
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 256 << 20, ...opts });
const log = (...m) => console.log(`[${((performance.now()) / 1000).toFixed(1)}s]`, ...m);

assert(a.out && path.isAbsolute(a.out), '--out <absolute new directory> required');
const OUT = path.resolve(a.out);
await fs.lstat(OUT).then(() => assert.fail('output exists: ' + OUT), (e) => { if (e.code !== 'ENOENT') throw e; });
assert(!OUT.startsWith(REPO + '/'), 'output must be outside the repository');
const commit = a.commit ?? run('git', ['-C', REPO, 'rev-parse', 'HEAD']).trim();
assert(/^[a-f0-9]{40}$/.test(commit), 'full commit sha required');
const BASE = path.resolve(a['base-contract'] ?? N29), BASE_SHA = a['base-contract-sha'] ?? N29_SHA;
assert(/^[a-f0-9]{64}$/.test(BASE_SHA));
assert.equal(sha(await fs.readFile(BASE + '/release.json')), BASE_SHA, 'base source contract manifest sha256 mismatch');
const deps = await fs.realpath(path.join(REPO, 'node_modules'));
const timings = {};
const step = async (name, fn) => { const t = performance.now(); const r = await fn(); timings[name] = Math.round(performance.now() - t); log(name, timings[name], 'ms'); return r; };

process.umask(0o077);
await fs.mkdir(OUT, { mode: 0o700 });
const project = OUT + '/project', contract = OUT + '/source-contract', releaseRoot = OUT + '/release-canonical';

// 1. Exact git cut of the commit (tracked files only; the working tree's uncommitted edits are not in it).
await step('git_archive', async () => {
  await fs.mkdir(project, { mode: 0o700 });
  execFileSync('/bin/sh', ['-c', 'git -C "$0" archive "$1" | tar -x -C "$2"', REPO, commit, project]);
  // The cut has no node_modules: link the locked local dependencies of this checkout; reuse, never copy.
  await fs.symlink(deps, project + '/node_modules', 'dir').catch((e) => { if (e.code !== 'EEXIST') throw e; });
  assert.equal(await fs.realpath(project + '/node_modules'), deps, 'project node_modules must be the locked local dependencies');
});

// 2. Source contract: base + drifted runtime-source rows + every newer release migration.
const delta = await step('source_contract', async () => {
  await fs.cp(BASE, contract, { recursive: true, errorOnExist: true, force: false });
  const before = JSON.parse(await fs.readFile(contract + '/release.json', 'utf8')), m = structuredClone(before);
  const replaced = [], added = [], natives = [];
  for (const [i, r] of m.files.entries()) {
    if (r.role !== 'runtime-source') continue;
    const b = await fs.readFile(project + '/' + r.path);
    if (sha(b) !== r.sha256) { m.files[i] = { ...r, bytes: b.length, sha256: sha(b) }; await fs.writeFile(contract + '/' + r.path, b); replaced.push(r.path); }
  }
  const { RELEASE_MIGRATIONS } = await import(pathToFileURL(project + '/' + COLD + 'migration-manifest.mjs'));
  const ii = m.files.findIndex((r) => r.role === 'source-inventory'), inv = JSON.parse(await fs.readFile(contract + '/' + m.files[ii].path, 'utf8'));
  for (const r of RELEASE_MIGRATIONS) {
    if (m.native_contract.sql_graph.some((e) => e.id === r.native_id)) continue;
    const b = await fs.readFile(project + '/server/' + r.file);
    assert.equal(b.length, r.bytes); assert.equal(sha(b), r.sha256, 'migration pin ' + r.name);
    const edge = { id: r.native_id, path: 'native/' + r.file, sha256: sha(b) };
    await fs.writeFile(contract + '/' + edge.path, b);
    m.files.push({ path: edge.path, bytes: b.length, sha256: edge.sha256, role: 'native-sql' });
    m.native_contract.sql_graph.push(edge); inv.source_graph.push(edge); natives.push(r.native_id);
    for (const name of [COLD + r.cold.source_contract, COLD + r.cold.compatibility]) {
      if (m.files.some((f) => f.path === name)) continue;
      const s = await fs.readFile(project + '/' + name);
      await fs.mkdir(path.dirname(contract + '/' + name), { recursive: true }); await fs.writeFile(contract + '/' + name, s);
      m.files.push({ path: name, bytes: s.length, sha256: sha(s), role: 'runtime-source' }); added.push(name);
    }
  }
  const invBytes = compact(inv); await fs.writeFile(contract + '/' + m.files[ii].path, invBytes);
  m.files[ii] = { ...m.files[ii], bytes: invBytes.length, sha256: sha(invBytes) };
  m.version = `1.0.0-full-base-scale-${commit.slice(0, 12)}.${RELEASE_MIGRATIONS.at(-1).number}`;
  const mb = compact(m); await fs.writeFile(contract + '/release.json', mb);
  const { validateRelease } = await import(pathToFileURL(project + '/tools/build/portable-release.mjs'));
  const { assertProjectContractMembers } = await import(pathToFileURL(project + '/tools/build/local-package.mjs'));
  await validateRelease(contract, { expectedManifestSha: sha(mb) }); await assertProjectContractMembers(project, m);
  return { parent_manifest_sha256: BASE_SHA, manifest_sha256: sha(mb), version: m.version, replaced_runtime: replaced, added_runtime: added,
    added_native: natives, files: m.files.length, native_edges: m.native_contract.sql_graph.length, last_migration: RELEASE_MIGRATIONS.at(-1).name };
});

// 3. Frontend of the same cut (the package ships the complete hashed dist).
await step('vite_build', async () => {
  const out = run(process.execPath, ['node_modules/vite/bin/vite.js', 'build'], { cwd: project });
  await fs.writeFile(OUT + '/vite.log', out);
});

// 4. Ordinary emitter (the copy inside the cut, so builder and validators are those of the same commit).
const emitted = await step('emit', async () => {
  const args = [project + '/tools/build/local-package.mjs', '--project', project, '--source-contract', contract, '--source-manifest-sha', delta.manifest_sha256];
  JSON.parse(run(process.execPath, [...args, '--output', releaseRoot, '--check-only'], { cwd: project }));
  const out = run(process.execPath, [...args, '--output', releaseRoot], { cwd: project });
  await fs.writeFile(OUT + '/emit.log', out);
  return JSON.parse(out.trim().split('\n').at(-1));
});
assert.equal(emitted.status, 'ACTUAL_EMITTED_LOCAL_PACKAGE_BYTES_VERIFIED_NOT_INSTALLED');

// 5. Package identity: release.json sha256 (pins every member) and a digest of the whole tree.
const files = [];
for (const rel of (await fs.readdir(releaseRoot, { recursive: true })).sort()) {
  const p = path.join(releaseRoot, rel); if (!(await fs.lstat(p)).isFile()) continue;
  files.push(`${sha(await fs.readFile(p))}  ${rel}`);
}
const listing = files.join('\n') + '\n';
await fs.writeFile(OUT + '/release-canonical.sha256', listing);
const manifestSha = sha(await fs.readFile(releaseRoot + '/release.json'));
assert.equal(manifestSha, emitted.manifest_sha256);
const record = {
  schema: 'dyna-scale-release-build/v1', built_at: new Date().toISOString(), commit, node: process.version,
  release_directory: releaseRoot, release_manifest_sha256: manifestSha, package_tree_sha256: sha(listing), package_files: files.length,
  package_bytes: emitted.bytes, metafile: releaseRoot + '.esbuild-metafile.json', metafile_sha256: sha(await fs.readFile(releaseRoot + '.esbuild-metafile.json')),
  source_contract: delta, timings_ms: timings,
};
await fs.writeFile(OUT + '/release-build.json', json(record), { mode: 0o600 });
console.log(JSON.stringify(record, null, 1));
