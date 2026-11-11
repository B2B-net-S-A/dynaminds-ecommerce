/** Own QA135 response-contract check. GET only; never retries or creates a business write. */
import assert from 'node:assert/strict';
import { readFile, writeFile, lstat } from 'node:fs/promises';
const ledgerPath =
  '<workspace>/app/data/supplier-file-source-stage135.json';
assert.equal((await lstat(ledgerPath)).mode & 0o777, 0o600);
const state = JSON.parse(await readFile(ledgerPath, 'utf8'));
assert.equal(state.tenant_id, '675f4d1d-4adf-4b8e-9747-019057faf862');
assert.equal(state.pending, null);
const checkpoint = JSON.parse(
  await readFile('docs/supplier-file-source-native-xml-readback.json', 'utf8'),
);
const read = async (path) => {
  const response = await fetch('http://127.0.0.1:4100/api' + path, {
    headers: { cookie: state.cookie },
  });
  assert.equal(response.status, 200);
  if (path.startsWith('/supplier-file-'))
    assert.match(response.headers.get('cache-control'), /no-store/);
  return response.json();
};
const health = await read('/health');
assert.equal(health.revision, checkpoint.revision);
assert.equal(health.schema_revision, '118_supplier_file_sources');
assert.equal(health.background_workers_enabled, false);
const source = checkpoint.rows.supplier_sources[0];
const history = await read('/supplier-file-sources/' + source.id + '/history');
assert.equal(history.meta.total, 2);
assert.equal(history.meta.has_more, false);
assert.equal(history.data.length, 2);
const proofs = [];
for (const run of history.data) {
  const p = checkpoint.rows.supplier_file_previews.find((row) => row.id === run.preview_id);
  assert(p);
  assert.equal(run.source_id, source.id);
  assert.equal(run.scope_hash, p.scope_hash);
  assert.match(run.scope_hash, /^[a-f0-9]{64}$/);
  assert.equal(run.raw_hash, p.raw_hash);
  assert.equal(run.source_version, p.source_version);
  assert.deepEqual(run.config_snapshot, p.payload.config_snapshot);
  assert.equal(run.summary.total, 2);
  assert.equal(run.rows.length, 2);
  assert.equal(run.missing.length, 0);
  assert.deepEqual(
    run.rows.map((row) => row.index),
    [0, 1],
  );
  assert(run.rows.every((row) => row.item_id && row.after?.snapshot));
  const preview = (await read('/supplier-file-previews/' + p.id)).preview;
  assert.equal(preview.scope_hash, run.scope_hash);
  assert.equal(preview.executed_run_id, run.id);
  assert.equal(preview.can_apply, false);
  proofs.push({
    run_id: run.id,
    preview_id: p.id,
    source_version: run.source_version,
    scope_hash: run.scope_hash,
    raw_hash: run.raw_hash,
    complete_receipts: 2,
  });
}
await writeFile(
  'docs/supplier-file-source-native-api-readback.json',
  JSON.stringify(
    {
      status: 'PASS',
      revision: health.revision,
      tenant_id: state.tenant_id,
      get_only: true,
      business_writes: 0,
      exact_manual_retry_verified: false,
      proofs,
    },
    null,
    2,
  ) + '\n',
  { flag: 'wx' },
);
console.log('NATIVE_API_READBACK_PASS: two immutable results; GET only; scope/receipts complete');
