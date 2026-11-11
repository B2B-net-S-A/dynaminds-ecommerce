/** One own first manual job, with exact public GitHub fixture and separate immutable attempt custody. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, lstat } from 'node:fs/promises';
import { pool } from '../server/db';
import { decrypt } from '../server/security';
import {
  processSupplierRemoteFetch,
  failSupplierRemoteFetch,
} from '../server/supplier-remote-feeds';

const ledger = '<workspace>/app/data/supplier-remote-feeds-stage137.json';
const attemptPath =
  '<workspace>/app/data/supplier-remote-feeds-stage137-process.json';
const fid = process.argv[2];
const revision = process.env.QA_EXPECTED_REVISION;
assert.match(fid ?? '', /^[a-f0-9-]{36}$/);
assert.match(revision ?? '', /^[a-f0-9]{40}$/);
assert.equal((await lstat(ledger)).mode & 0o777, 0o600);
const state = JSON.parse(await readFile(ledger, 'utf8'));
assert.equal(state.tenant_id, '626b2805-d3eb-4513-8a81-9529fcfab4f1');
assert.equal(state.pending, null);
const fixture = JSON.parse(
  await readFile('docs/supplier-remote-feeds-137-fixture-source.json', 'utf8'),
);
const before = JSON.parse(await readFile('docs/supplier-remote-feeds-137-before.json', 'utf8'));
assert.equal(before.revision, revision);
const health = (await (await fetch('http://127.0.0.1:4100/api/health')).json()) as any;
assert.equal(health.revision, revision);
assert.equal(health.schema_revision, '119_supplier_remote_feeds');
assert.equal(health.background_workers_enabled, false);
assert.equal(health.restore_preview, false);
let attempt: any = { fetch_id: fid, revision, phase: 'PREPARED_NO_AUTOMATIC_REPEAT' };
try {
  const c = await pool.connect();
  let job: any;
  try {
    await c.query('BEGIN');
    assert.equal((await c.query('SELECT current_database() name')).rows[0].name, 'dynaminds');
    const f = (
      await c.query(
        'SELECT f.*,s.name,s.kind,s.currency,r.url_cipher,r.auth_cipher FROM supplier_file_fetch_runs f JOIN supplier_sources s ON(s.tenant_id,s.id)=(f.tenant_id,f.source_id) JOIN supplier_file_remotes r ON(r.tenant_id,r.source_id)=(f.tenant_id,f.source_id) WHERE f.tenant_id=$1 AND f.id=$2 FOR UPDATE OF f',
        [state.tenant_id, fid],
      )
    ).rows[0];
    assert(f && f.kind === 'file' && f.state === 'queued');
    assert.equal(f.name, 'QA137 PUBLIC PRODUCTS CSV');
    assert.equal(f.source_id, state.source_id);
    assert.equal(f.currency, 'USD');
    assert.equal(f.actor_id, state.user_id);
    assert.equal(f.api_key_id, null);
    assert.equal(f.schedule_version, null);
    assert.equal(f.auth_cipher, null);
    assert(decrypt(f.url_cipher).url === fixture.url, 'Own public fixture URL mismatch');
    assert.equal(f.source_version, 2);
    assert.equal(f.remote_version, 1);
    await writeFile(attemptPath, JSON.stringify(attempt, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
    job = (
      await c.query(
        "UPDATE jobs SET state='running',attempts=attempts+1,locked_at=clock_timestamp(),lease_token=$3 WHERE tenant_id=$1 AND id=$2 AND state='pending' AND attempts=0 AND lease_token IS NULL AND kind='supplier.file.fetch' AND payload->>'fetch_id'=$4 RETURNING *",
        [state.tenant_id, f.job_id, randomUUID(), fid],
      )
    ).rows[0];
    assert(job, 'Own first job is not claimable');
    attempt = { ...attempt, job_id: job.id, phase: 'CLAIMING_NO_AUTOMATIC_REPEAT' };
    await writeFile(attemptPath, JSON.stringify(attempt, null, 2) + '\n', { mode: 0o600 });
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
      [state.tenant_id, fid],
    )
  ).rows[0];
  const snapshotClient = await pool.connect();
  let fingerprint: string;
  try {
    await snapshotClient.query('BEGIN READ ONLY');
    await snapshotClient.query("SET LOCAL TIME ZONE 'UTC'");
    fingerprint = (
      await snapshotClient.query(
        "SELECT encode(sha256(convert_to(to_jsonb(f)::text,'UTF8')),'hex') hash FROM supplier_file_fetch_runs f WHERE tenant_id=$1 AND id=$2",
        [state.tenant_id, fid],
      )
    ).rows[0].hash;
    await snapshotClient.query('COMMIT');
  } catch (e) {
    await snapshotClient.query('ROLLBACK');
    throw e;
  } finally {
    snapshotClient.release();
  }
  attempt.phase = 'OBSERVED_' + f.state.toUpperCase();
  await writeFile(attemptPath, JSON.stringify(attempt, null, 2) + '\n', { mode: 0o600 });
  await writeFile(
    'docs/supplier-remote-feeds-137-process.json',
    JSON.stringify(
      {
        status:
          f.state === 'success'
            ? 'PUBLIC_HTTPS_VALID_PREVIEW_RECEIVED'
            : 'PUBLIC_HTTPS_NOT_SUCCESSFUL',
        revision,
        tenant_id: state.tenant_id,
        source_id: state.source_id,
        fetch: f,
        fetch_sql_sha256: fingerprint,
        genuine_https_transport: true,
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
  assert.equal(f.raw_hash, fixture.raw_sha256);
  assert.equal(f.decoded_bytes, fixture.bytes);
  assert.equal(f.summary.invalid, 0);
  assert.equal(f.summary.total, 27);
  assert.equal(f.run_id, null);
} finally {
  await pool.end();
}
