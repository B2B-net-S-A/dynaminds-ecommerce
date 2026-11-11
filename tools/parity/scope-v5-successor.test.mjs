/** Actual file-only historical CODE successor; never executes archived code or accepts runtime. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createScopeSnapshot} from './scope-freeze.mjs';
import {checkInventories} from './check.mjs';
import {loadEvidenceArchive, retainedEvidenceRef} from './evidence-archive.mjs';

const D = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');
const root = path.resolve(D, '../..');
const base = D + '/docs/parity';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const read = async file => JSON.parse(await fs.readFile(file));
const parentBytes = await fs.readFile(base + '/scope.v4.json');
const parent = JSON.parse(parentBytes);
const current = await read(base + '/scope.v5.json');
const envelope = await read(base + '/scope.v5.request.json');
const oldArchiveBytes = await fs.readFile(parent.evidence_archive.path);
const oldArchive = JSON.parse(oldArchiveBytes);
const archive = await read(current.evidence_archive.path);
// V5 and its archive stay pinned history. Files that drifted after v5 are retained by the
// append-only archive named in revalidation.json (docs/parity/scope-inputs/v6/README.md);
// replay borrows only that FILE storage.
const revalidation = (await read(base + '/evidence-archives/revalidation.json')).archive;
const replay = {...envelope.snapshot, evidence_archive: revalidation};
// An archive = the given rows plus only the rows retained after v5, so a historical refusal list stays exact.
async function withLaterDrift(rows, work) {
  const next = await read(revalidation.path);
  const later = next.entries.filter(row => !archive.entries.some(x => JSON.stringify(x) === JSON.stringify(row)));
  const dir = await fs.mkdtemp(base + '/.scope-v5-negative-');
  try {
    const bytes = Buffer.from(JSON.stringify({...archive, entries: [...rows, ...later]}, null, 2) + '\n');
    const file = dir + '/archive.json';
    await fs.writeFile(file, bytes, {flag: 'wx', mode: 0o600});
    await work({path: file, bytes: bytes.length, sha256: sha(bytes)});
  } finally {
    await fs.rm(dir, {recursive: true, force: true});
  }
}
const inputs = await Promise.all(['domains', 'integrations'].map(async name => ({
  name, document: await read(current.inputs[name].path),
})));
const miraklIds = [
  'integration.mirakl.orders.stage',
  'integration.mirakl.orders.import',
  'integration.mirakl.products.link.sku',
];
const historical = {
  path: D + '/server/imports.ts', bytes: 37802,
  sha256: '08f02bb1f0efcfb08ba1502efa9747d8de8bc3201a55843a5c862e5cc49f08c7',
};
async function pinned(ref) {
  const bytes = await fs.readFile(ref.path);
  assert.equal(bytes.length, ref.bytes);
  assert.equal(sha(bytes), ref.sha256);
  return bytes;
}

test('public v5 preserves the whole v4 denominator, input/status authority and all 33 open gaps', async () => {
  assert.equal(parentBytes.length, 2305362);
  assert.equal(sha(parentBytes), 'e8ff03993638cc96afe5eebbababf89454392e524c0b93e9addb07899093e5dd');
  assert.equal(current.version, 5);
  assert.equal(current.requirements.length, 2589);
  assert.deepEqual(current.requirements, parent.requirements);
  assert.deepEqual(current.required_ids, parent.required_ids);
  assert.deepEqual(current.inputs, parent.inputs);
  assert.deepEqual(current.catalogue_inventory, parent.catalogue_inventory);
  assert.deepEqual(current.changes, {added: [], removed: []});
  assert.deepEqual(current.parent, {
    path: base + '/scope.v4.json', bytes: parentBytes.length, sha256: sha(parentBytes),
  });
  const gaps = current.requirements.filter(row => row.kind === 'gap');
  assert.equal(gaps.length, 33);
  assert(gaps.every(row => row.state === 'open'));
  for (const ref of Object.values(current.inputs)) await pinned(ref);
  assert.equal(envelope.schema, 'dynaminds-parity-scope-freeze-request/v1');
  assert.equal(envelope.output, base + '/scope.v5.json');
  assert(!JSON.stringify([envelope, current, archive]).includes('/local-builds/'));
});

test('public archive preserves all nine old rows, payloads and provenance; only one Git blob is added', async () => {
  assert.equal(oldArchiveBytes.length, 7237);
  assert.equal(sha(oldArchiveBytes), '776f1c79fdb9fef03b5612b327b1c42ee88642f5cf9082b8461c8f44ee3d3f64');
  assert.equal(oldArchive.entries.length, 9);
  assert.equal(archive.entries.length, 10);
  assert.deepEqual(archive.entries.slice(0, 9), oldArchive.entries);
  for (const row of oldArchive.entries) await pinned(row.retained_ref);
  const added = archive.entries[9];
  assert.deepEqual(added.original_ref, historical);
  assert.deepEqual(added.source, {
    kind: 'git_blob', repository: D, object: '977041c4bc69eeb6af5b106a667eff087e2d6297',
  });
  assert(added.retained_ref.path.startsWith(base + '/evidence-archives/mirakl-v5-20261019/new-retained/'));
  const retained = await pinned(added.retained_ref);
  const {stdout} = await promisify(execFile)('git', ['-C', D, 'cat-file', 'blob', added.source.object], {
    encoding: 'buffer', maxBuffer: 65536,
  });
  assert.deepEqual(retained, stdout);
  assert.equal(createHash('sha1').update(Buffer.concat([
    Buffer.from('blob ' + retained.length + '\0'), retained,
  ])).digest('hex'), added.source.object);
  assert.notEqual(sha(await fs.readFile(historical.path)), historical.sha256,
    'Historical retained CODE must not be presented as current imports.ts');
  const storage = await loadEvidenceArchive(current.evidence_archive, {root});
  assert.deepEqual(retainedEvidenceRef(storage, historical), added.retained_ref);
  assert.deepEqual(JSON.parse(await fs.readFile(base + '/scope.v4.json')), parent);
  assert.deepEqual(await fs.readFile(parent.evidence_archive.path), oldArchiveBytes);
});

test('old archive refuses the three stale CODE refs; the successor resolves only their historical bytes', async () => {
  assert.equal((await checkInventories(inputs, {root, evidenceArchive: parent.evidence_archive})).valid, false);
  await withLaterDrift(oldArchive.entries, async storage => {
    const before = await checkInventories(inputs, {root, evidenceArchive: storage});
    assert.equal(before.valid, false);
    assert.deepEqual(before.errors.map(row => row.where).sort(),
      miraklIds.map(id => 'integrations:' + id + ':code').sort());
  });
  await assert.rejects(createScopeSnapshot({
    ...envelope.snapshot, evidence_archive: parent.evidence_archive,
  }, {root}), error => error.code === 'INVENTORY_INVALID');
  const storage = await read(revalidation.path);
  for (const row of archive.entries) assert(storage.entries.some(next => JSON.stringify(next) === JSON.stringify(row)));
  const after = await checkInventories(inputs, {root, evidenceArchive: revalidation});
  assert.equal(after.valid, true);
  assert.deepEqual(after.errors, []);
  assert.equal(after.evidence_files_verified, 89);
  assert.equal(after.completion_review_candidate, false);
  assert.equal(after.acceptance_granted_by_checker, false);
  assert(after.inventories.every(row => row.coverage_closed === false));
  for (const id of miraklIds) {
    const row = inputs.find(input => input.name === 'integrations').document.rows.find(row => row.id === id);
    assert.equal(row.status, 'dev_wired_acceptance_unverified');
    assert.equal(row.required_evidence_level, 'account');
    for (const level of ['local', 'sandbox', 'account']) assert.deepEqual(row.evidence[level], []);
    assert(row.evidence.code.some(entry => {
      const ref = entry.ref ?? entry;
      return JSON.stringify(ref) === JSON.stringify(historical) ||
        ref.path === historical.path && ref.bytes === historical.bytes && ref.sha256 === historical.sha256;
    }));
  }
});

test('the existing generator reproduces public v5 exactly but still refuses complete scope', async () => {
  assert.deepEqual(await createScopeSnapshot(replay, {root}), {...current, evidence_archive: revalidation});
  assert.equal(current.snapshot_kind, 'partial');
  assert.equal(current.scope_complete, false);
  assert.equal(current.acceptance_granted, false);
  assert.equal(current.inventory_mutated, false);
  const strict = await checkInventories(inputs, {
    root, evidenceArchive: revalidation, requireComplete: true,
  });
  assert.equal(strict.valid, false);
  assert.equal(strict.completion_review_candidate, false);
  assert.equal(strict.acceptance_granted_by_checker, false);
  await assert.rejects(createScopeSnapshot({
    ...replay, snapshot_kind: 'complete',
  }, {root}), error => error.code === 'SCOPE_STILL_PARTIAL');
});

test('successor refuses replacement of old archive provenance, even when retained bytes still match', async () => {
  const dir = await fs.mkdtemp(base + '/.scope-v5-negative-');
  try {
    const changed = await read(revalidation.path);
    const row = changed.entries[0];
    row.source = {kind: 'file', path: row.retained_ref.path};
    assert.notDeepEqual(row.source, oldArchive.entries[0].source);
    const bytes = Buffer.from(JSON.stringify(changed) + '\n');
    const file = dir + '/archive.json';
    await fs.writeFile(file, bytes, {flag: 'wx', mode: 0o600});
    await assert.rejects(createScopeSnapshot({
      ...envelope.snapshot, evidence_archive: {path: file, bytes: bytes.length, sha256: sha(bytes)},
    }, {root}), error => error.code === 'PARENT_EVIDENCE_ARCHIVE_CHANGED');
  } finally {
    await fs.rm(dir, {recursive: true, force: true});
  }
});
