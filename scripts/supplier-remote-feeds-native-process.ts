/** One explicitly selected manual QA136 job; never ticks the global queue or scheduler. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, lstat } from 'node:fs/promises';
import { pool } from '../server/db';
import {
  processSupplierRemoteFetch,
  failSupplierRemoteFetch,
} from '../server/supplier-remote-feeds';

const ledger = '<workspace>/app/data/supplier-remote-feeds-stage136.json';
const fetchId = process.argv[2];
const expected = process.env.QA_EXPECTED_REVISION;
assert.match(fetchId ?? '', /^[a-f0-9-]{36}$/);
assert.match(expected ?? '', /^[a-f0-9]{40}$/);
assert.notEqual(process.env.DYNA_TEST, 'true');
assert.equal((await lstat(ledger)).mode & 0o777, 0o600);
const state = JSON.parse(await readFile(ledger, 'utf8'));
assert(state.organization.startsWith('QA136 Remote feed '));
assert.equal(state.pending, null);
assert(!state.worker_attempt, 'Never claim a second attempt after an uncertain result');
const healthResponse = await fetch('http://127.0.0.1:4100/api/health');
assert.equal(healthResponse.status, 200);
const health = (await healthResponse.json()) as any;
assert.equal(health.revision, expected);
assert.equal(health.schema_revision, '119_supplier_remote_feeds');
assert.equal(health.supplier_remote_feeds_available, true);
assert.equal(health.background_workers_enabled, false);
assert.equal(health.restore_preview, false);
const save = () => writeFile(ledger, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
try {
  const c = await pool.connect();
  let job: any;
  try {
    await c.query('BEGIN');
    const f = (
      await c.query(
        `SELECT f.*,s.kind FROM supplier_file_fetch_runs f JOIN supplier_sources s ON (s.tenant_id,s.id)=(f.tenant_id,f.source_id) WHERE f.tenant_id=$1 AND f.id=$2 FOR UPDATE OF f`,
        [state.tenant_id, fetchId],
      )
    ).rows[0];
    assert(f && f.kind === 'file' && f.state === 'queued');
    assert.equal(f.actor_id, state.user_id);
    assert.equal(f.api_key_id, null);
    assert.equal(f.schedule_version, null);
    job = (
      await c.query(
        `UPDATE jobs SET state='running',attempts=attempts+1,locked_at=clock_timestamp(),lease_token=$3 WHERE tenant_id=$1 AND id=$2 AND state='pending' AND attempts=0 AND lease_token IS NULL AND kind='supplier.file.fetch' AND payload->>'fetch_id'=$4 RETURNING *`,
        [state.tenant_id, f.job_id, randomUUID(), fetchId],
      )
    ).rows[0];
    assert(job, 'Own first queued job was not claimable');
    state.worker_attempt = {
      fetch_id: fetchId,
      job_id: job.id,
      phase: 'CLAIMING_NO_AUTOMATIC_REPEAT',
    };
    await save();
    await c.query('COMMIT');
  } catch (error) {
    await c.query('ROLLBACK');
    throw error;
  } finally {
    c.release();
  }
  // Uses the genuine DNS/TLS/HTTPS transport, with no injected dependencies.
  try {
    await processSupplierRemoteFetch(job);
  } catch (error) {
    await failSupplierRemoteFetch(job, error);
  }
  const f = (
    await pool.query(
      'SELECT id,source_id,job_id,state,http_status,wire_bytes,decoded_bytes,wire_hash,raw_hash,preview_id,run_id,error_code FROM supplier_file_fetch_runs WHERE tenant_id=$1 AND id=$2',
      [state.tenant_id, fetchId],
    )
  ).rows[0];
  state.worker_attempt.phase = 'OBSERVED_' + f.state.toUpperCase();
  await save();
  await writeFile(
    'docs/supplier-remote-feeds-native-process.json',
    JSON.stringify(
      {
        status:
          f.state === 'success' ? 'OWN_MANUAL_FETCH_RECEIVED' : 'OWN_MANUAL_FETCH_NOT_SUCCESSFUL',
        revision: health.revision,
        tenant_id: state.tenant_id,
        fetch: f,
        controlled_transport: false,
        genuine_https_transport: true,
        global_queue_tick: false,
        scheduler_called: false,
        commercial_supplier_verified: false,
        full_goal_complete: false,
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
    preview_created: Boolean(f.preview_id),
    catalogue_published: Boolean(f.run_id),
    error_code: f.error_code,
  });
  assert.equal(f.state, 'success', 'Read durable state before considering another request');
  assert.equal(f.http_status, 200);
  assert(f.preview_id);
  assert.equal(f.run_id, null);
} finally {
  await pool.end();
}
