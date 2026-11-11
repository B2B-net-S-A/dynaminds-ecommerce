/** Process one separate, first-attempt synthetic HTTPS fixture job; no global worker tick. */
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile, lstat } from 'node:fs/promises';
import { pool } from '../server/db';
import { decrypt } from '../server/security';
import {
  processSupplierRemoteFetch,
  failSupplierRemoteFetch,
} from '../server/supplier-remote-feeds';

const oldLedger =
  '<workspace>/app/data/supplier-remote-feeds-stage136.json';
const privateAttempt =
  '<workspace>/app/data/supplier-remote-feeds-stage136-positive-process.json';
const fetchId = process.argv[2];
const revision = process.env.QA_EXPECTED_REVISION;
assert.match(fetchId ?? '', /^[a-f0-9-]{36}$/);
assert.match(revision ?? '', /^[a-f0-9]{40}$/);
assert.equal((await lstat(oldLedger)).mode & 0o777, 0o600);
const state = JSON.parse(await readFile(oldLedger, 'utf8'));
assert.equal(state.tenant_id, '626b2805-d3eb-4513-8a81-9529fcfab4f1');
assert.equal(state.pending, null);
assert.equal(state.worker_attempt.phase, 'OBSERVED_SUCCESS');
assert.notEqual(fetchId, state.worker_attempt.fetch_id);
const prior = JSON.parse(await readFile('docs/supplier-remote-feeds-native-readback.json', 'utf8'));
assert.equal(prior.status, 'PASS_HTTPS_INVALID_PREVIEW_NO_PUBLICATION');
const bytes = await readFile('docs/supplier-remote-feeds-positive-fixture.csv');
const url =
  'https://httpbingo.org/base64/' + bytes.toString('base64url') + '?content-type=text%2Fcsv';
const health = (await (await fetch('http://127.0.0.1:4100/api/health')).json()) as any;
assert.equal(health.revision, revision);
assert.equal(health.schema_revision, '119_supplier_remote_feeds');
assert.equal(health.background_workers_enabled, false);
assert.equal(health.restore_preview, false);
let attempt: any = { fetch_id: fetchId, revision, phase: 'PREPARED_NO_AUTOMATIC_REPEAT' };
try {
  const c = await pool.connect();
  let job: any;
  try {
    await c.query('BEGIN');
    assert.equal((await c.query('SELECT current_database() name')).rows[0].name, 'dynaminds');
    const f = (
      await c.query(
        'SELECT f.*,s.name,s.kind,r.url_cipher,r.auth_cipher FROM supplier_file_fetch_runs f JOIN supplier_sources s ON(s.tenant_id,s.id)=(f.tenant_id,f.source_id) JOIN supplier_file_remotes r ON(r.tenant_id,r.source_id)=(f.tenant_id,f.source_id) WHERE f.tenant_id=$1 AND f.id=$2 FOR UPDATE OF f',
        [state.tenant_id, fetchId],
      )
    ).rows[0];
    assert(f && f.kind === 'file' && f.state === 'queued');
    assert.equal(f.name, 'QA136 HTTPS SYNTHETIC CSV');
    assert.equal(f.actor_id, state.user_id);
    assert.equal(f.api_key_id, null);
    assert.equal(f.schedule_version, null);
    assert.equal(f.auth_cipher, null);
    assert(decrypt(f.url_cipher).url === url, 'Own fixture URL mismatch');
    assert.equal(f.source_version, 2);
    assert.equal(f.remote_version, 1);
    assert.notEqual(f.source_id, prior.source_id);
    // Fail before any claim if a previous attempt file exists, even after a lost acknowledgement.
    await writeFile(privateAttempt, JSON.stringify(attempt, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
    job = (
      await c.query(
        "UPDATE jobs SET state='running',attempts=attempts+1,locked_at=clock_timestamp(),lease_token=$3 WHERE tenant_id=$1 AND id=$2 AND state='pending' AND attempts=0 AND lease_token IS NULL AND kind='supplier.file.fetch' AND payload->>'fetch_id'=$4 RETURNING *",
        [state.tenant_id, f.job_id, randomUUID(), fetchId],
      )
    ).rows[0];
    assert(job);
    attempt = {
      ...attempt,
      job_id: job.id,
      source_id: f.source_id,
      phase: 'CLAIMING_NO_AUTOMATIC_REPEAT',
    };
    await writeFile(privateAttempt, JSON.stringify(attempt, null, 2) + '\n', { mode: 0o600 });
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
  try {
    await processSupplierRemoteFetch(job);
  } catch (e) {
    await failSupplierRemoteFetch(job, e);
  }
  const f = (
    await pool.query(
      'SELECT id,source_id,job_id,state,http_status,wire_bytes,decoded_bytes,wire_hash,raw_hash,preview_id,run_id,error_code,summary FROM supplier_file_fetch_runs WHERE tenant_id=$1 AND id=$2',
      [state.tenant_id, fetchId],
    )
  ).rows[0];
  attempt.phase = 'OBSERVED_' + f.state.toUpperCase();
  await writeFile(privateAttempt, JSON.stringify(attempt, null, 2) + '\n', { mode: 0o600 });
  await writeFile(
    'docs/supplier-remote-feeds-positive-process.json',
    JSON.stringify(
      {
        status:
          f.state === 'success'
            ? 'PUBLIC_HTTPS_SYNTHETIC_PREVIEW_RECEIVED'
            : 'PUBLIC_HTTPS_SYNTHETIC_NOT_SUCCESSFUL',
        revision,
        tenant_id: state.tenant_id,
        fetch: f,
        fixture_bytes: bytes.length,
        fixture_sha256: createHash('sha256').update(bytes).digest('hex'),
        genuine_https_transport: true,
        controlled_response_data: true,
        transport_injected: false,
        scheduler_called: false,
        global_queue_tick: false,
        commercial_supplier_verified: false,
      },
      null,
      2,
    ) + '\n',
    { flag: 'wx' },
  );
  console.log({
    state: f.state,
    http_status: f.http_status,
    decoded_bytes: f.decoded_bytes,
    summary: f.summary,
    error_code: f.error_code,
  });
  assert.equal(f.state, 'success');
  assert.equal(f.http_status, 200);
  assert.equal(f.raw_hash, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(f.decoded_bytes, bytes.length);
  assert.equal(f.summary.invalid, 0);
  assert.equal(f.summary.total, 2);
  assert.equal(f.run_id, null);
} finally {
  await pool.end();
}
