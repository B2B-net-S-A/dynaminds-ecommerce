/** Narrow read-only acceptance of the already completed own QA136 HTTPS fetch. */
import assert from 'node:assert/strict';
import { readFile, writeFile, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pool } from '../server/db';
import { decrypt } from '../server/security';
import { wmsLotsHash } from '../server/wms-lots';

const ledger = '<workspace>/app/data/supplier-remote-feeds-stage136.json';
const revision = process.env.QA_EXPECTED_REVISION;
assert.match(revision ?? '', /^[a-f0-9]{40}$/);
assert.equal((await lstat(ledger)).mode & 0o777, 0o600);
const state = JSON.parse(await readFile(ledger, 'utf8'));
assert.equal(state.tenant_id, '626b2805-d3eb-4513-8a81-9529fcfab4f1');
assert.equal(state.pending, null);
assert.equal(state.worker_attempt.phase, 'OBSERVED_SUCCESS');
const receipt = JSON.parse(
  await readFile('docs/supplier-remote-feeds-native-process.json', 'utf8'),
);
assert.equal(receipt.revision, revision);
const sid = receipt.fetch.source_id;
const fid = receipt.fetch.id;
const pid = receipt.fetch.preview_id;
const hash = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const forbidden = new Set([
  'url',
  'url_cipher',
  'auth_cipher',
  'request_cipher',
  'password',
  'token',
  'Authorization',
  'lease_token',
  'request_hash',
  'expected_items',
  'raw_content',
  'top_xid',
  'transaction_started_at',
]);
function checkPublic(value: unknown) {
  if (Array.isArray(value)) return value.forEach(checkPublic);
  if (value && typeof value === 'object') {
    for (const [key, v] of Object.entries(value)) {
      assert(!forbidden.has(key), 'Unexpected private DTO field: ' + key);
      checkPublic(v);
    }
  }
}
async function get(path: string): Promise<any> {
  const r = await fetch('http://127.0.0.1:4100/api' + path, {
    headers: { cookie: state.cookie },
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(r.status, 200, path);
  if (path.startsWith('/supplier-file-'))
    assert.match(r.headers.get('cache-control') ?? '', /no-store/);
  const value = await r.json();
  checkPublic(value);
  return value;
}
try {
  const health = await get('/health');
  assert.equal(health.revision, revision);
  assert.equal(health.schema_revision, '119_supplier_remote_feeds');
  assert.equal(health.background_workers_enabled, false);
  assert.equal(health.restore_preview, false);
  const remote = await get(`/supplier-file-sources/${sid}/remote`);
  assert.equal(remote.remote.version, 1);
  assert.equal(remote.remote.source_version, 2);
  assert.equal(remote.remote.display_host, 'raw.githubusercontent.com');
  assert.equal(remote.remote.has_credentials, false);
  const history = await get(`/supplier-file-sources/${sid}/fetches`);
  assert.equal(history.meta.total, 1);
  assert.equal(history.data.length, 1);
  assert.equal(history.data[0].id, fid);
  const detail = await get(`/supplier-file-fetches/${fid}`);
  const preview = (await get(`/supplier-file-previews/${pid}`)).preview;
  const summary = {
    total: 52,
    valid: 44,
    invalid: 8,
    new: 44,
    changed: 0,
    unchanged: 0,
    missing: 0,
  };
  assert.deepEqual(detail.fetch.summary, summary);
  assert.deepEqual(preview.summary, summary);
  assert.equal(detail.fetch.state, 'success');
  assert.equal(detail.fetch.http_status, 200);
  assert.equal(detail.fetch.attempt, 1);
  assert.equal(detail.fetch.run_id, null);
  assert.equal(detail.run, null);
  assert.equal(preview.can_apply, false);
  assert.equal(preview.executed_run_id, null);
  assert.equal(preview.rows.length, 52);
  assert.deepEqual(
    preview.rows.map((r: any) => r.index),
    Array.from({ length: 52 }, (_, i) => i),
  );
  assert.equal(preview.rows.filter((r: any) => r.status === 'invalid').length, 8);
  assert.equal(preview.rows.filter((r: any) => r.status === 'new').length, 44);
  const schedule = await get(`/supplier-file-sources/${sid}/feed-schedule`);
  assert.equal(schedule.schedule.enabled, false);
  assert.equal(schedule.schedule.publish.enabled, false);
  const c = await pool.connect();
  let sql: any;
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await c.query("SET LOCAL statement_timeout='8s'");
    const f = (
      await c.query(
        'SELECT source_id,source_version,remote_version,actor_id,api_key_id,client_key,schedule_version,state,attempt,job_id,preview_id,run_id,raw_hash,decoded_bytes,summary FROM supplier_file_fetch_runs WHERE tenant_id=$1 AND id=$2',
        [state.tenant_id, fid],
      )
    ).rows[0];
    const p = (
      await c.query(
        'SELECT actor_id,api_key_id,client_key,source_id,source_version,raw_hash,raw_bytes,raw_content,scope_hash,payload FROM supplier_file_previews WHERE tenant_id=$1 AND id=$2',
        [state.tenant_id, pid],
      )
    ).rows[0];
    assert.equal(f.actor_id, state.user_id);
    assert.equal(f.api_key_id, null);
    assert.equal(f.schedule_version, null);
    assert.equal(p.actor_id, f.actor_id);
    assert.equal(p.api_key_id, f.api_key_id);
    assert.equal(p.client_key, fid);
    assert.equal(p.source_id, sid);
    assert.equal(p.source_version, 2);
    assert.equal(p.raw_hash, f.raw_hash);
    const raw = Buffer.from(decrypt(p.raw_content).content, 'utf8');
    assert.equal(hash(raw), f.raw_hash);
    assert.equal(raw.length, f.decoded_bytes);
    assert.equal(raw.length, p.raw_bytes);
    assert.equal(wmsLotsHash(p.payload), p.scope_hash);
    assert.deepEqual(p.payload.summary, summary);
    const storedRows = (
      await c.query(
        'SELECT index,payload FROM supplier_file_preview_rows WHERE tenant_id=$1 AND preview_id=$2 ORDER BY index',
        [state.tenant_id, pid],
      )
    ).rows;
    assert.equal(storedRows.length, 52);
    for (const row of storedRows) assert.deepEqual(row.payload, p.payload.rows[row.index]);
    const job = (
      await c.query(
        "SELECT state,attempts,kind,payload->>'fetch_id' fetch_id,lease_token IS NULL lease_released FROM jobs WHERE tenant_id=$1 AND id=$2",
        [state.tenant_id, f.job_id],
      )
    ).rows[0];
    assert.equal(job.state, 'done');
    assert.equal(job.attempts, 1);
    assert.equal(job.kind, 'supplier.file.fetch');
    assert.equal(job.fetch_id, fid);
    assert.equal(job.lease_released, true);
    const counts: Record<string, number> = {};
    for (const name of [
      'supplier_catalog_items',
      'supplier_file_runs',
      'supplier_file_run_rows',
      'products',
      'stock',
      'stock_movements',
      'purchase_orders',
      'purchase_receipts',
      'warehouse_documents',
      'orders',
    ]) {
      counts[name] = (
        await c.query(`SELECT count(*)::integer n FROM "${name}" WHERE tenant_id=$1`, [
          state.tenant_id,
        ])
      ).rows[0].n;
      assert.equal(counts[name], 0, 'Own fixture current non-empty table: ' + name);
    }
    const secretColumns = [
      ['supplier_file_remotes', 'url_cipher'],
      ['supplier_file_remotes', 'auth_cipher'],
      ['supplier_file_remote_revisions', 'url_cipher'],
      ['supplier_file_remote_revisions', 'auth_cipher'],
      ['supplier_file_remote_revisions', 'request_cipher'],
      ['supplier_file_remote_revisions', 'request_hash'],
      ['supplier_file_previews', 'raw_content'],
    ];
    const privileges = [];
    for (const [table, column] of secretColumns) {
      const canSelect = (
        await c.query("SELECT has_column_privilege('dyna_app',$1,$2,'SELECT') allowed", [
          table,
          column,
        ])
      ).rows[0].allowed;
      assert.equal(canSelect, false);
      privileges.push({ table, column, app_select: canSelect });
    }
    sql = {
      raw_bytes: raw.length,
      raw_hash: hash(raw),
      scope_hash: p.scope_hash,
      exact_preview_rows: storedRows.length,
      job,
      current_own_zero_counts: counts,
      private_column_privileges: privileges,
    };
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
  await writeFile(
    'docs/supplier-remote-feeds-native-readback.json',
    JSON.stringify(
      {
        status: 'PASS_HTTPS_INVALID_PREVIEW_NO_PUBLICATION',
        revision,
        schema_revision: health.schema_revision,
        tenant_id: state.tenant_id,
        source_id: sid,
        fetch_id: fid,
        preview_id: pid,
        summary,
        api_get_only: true,
        sql_read_only: true,
        business_writes_by_helper: 0,
        remote: remote.remote,
        schedule: schedule.schedule,
        sql,
        own_prefetch_preservation_claimed: false,
        positive_publication_verified: false,
        commercial_supplier_verified: false,
        automatic_worker_loop_verified: false,
        full_goal_complete: false,
      },
      null,
      2,
    ) + '\n',
    { flag: 'wx' },
  );
  console.log(
    'QA136_READBACK_PASS: genuine HTTPS, 52 immutable rows/8 invalid; current own catalog/products/stock/orders/PZ empty; no publication',
  );
} finally {
  await pool.end();
}
