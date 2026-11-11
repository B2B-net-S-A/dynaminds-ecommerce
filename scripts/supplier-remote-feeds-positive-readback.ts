/** Root-run, GET/SQL READ ONLY acceptance; never fetches a supplier or applies a preview. */
import assert from 'node:assert/strict';
import { readFile, writeFile, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { pool } from '../server/db';
import { decrypt } from '../server/security';
import { wmsLotsHash } from '../server/wms-lots';

const phase = process.argv[2];
assert(['before', 'after', 'failed'].includes(phase), 'Use before|after|failed');
assert.notEqual(process.env.DYNA_TEST, 'true');
const revision = process.env.QA_EXPECTED_REVISION;
assert.match(revision ?? '', /^03eff0b[a-f0-9]{33}$/);
const ledgerPath =
  '<workspace>/app/data/supplier-remote-feeds-stage136.json';
const ledgerBytes = await readFile(ledgerPath);
assert.equal((await lstat(ledgerPath)).mode & 0o777, 0o600);
const state = JSON.parse(ledgerBytes.toString('utf8'));
assert.equal(state.tenant_id, '626b2805-d3eb-4513-8a81-9529fcfab4f1');
assert.equal(state.pending, null);
const selection = JSON.parse(
  await readFile('docs/supplier-remote-feeds-positive-selection.json', 'utf8'),
);
assert.equal(selection.source_id, '40065436-1460-40ca-b754-bdec930b59aa');
const negative = JSON.parse(
  await readFile('docs/supplier-remote-feeds-native-readback.json', 'utf8'),
);
assert.equal(negative.status, 'PASS_HTTPS_INVALID_PREVIEW_NO_PUBLICATION');
assert.notEqual(negative.source_id, selection.source_id);
const bytes = await readFile('docs/supplier-remote-feeds-positive-fixture.csv');
const sha = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
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
function publicOnly(v: unknown): void {
  if (Array.isArray(v)) return v.forEach(publicOnly);
  if (v && typeof v === 'object')
    for (const [k, x] of Object.entries(v)) {
      assert(!forbidden.has(k), 'Private DTO field: ' + k);
      publicOnly(x);
    }
}
async function get(path: string): Promise<any> {
  const response = await fetch('http://127.0.0.1:4100/api' + path, {
    headers: { cookie: state.cookie },
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(response.status, 200, path);
  if (path !== '/health') assert.match(response.headers.get('cache-control') ?? '', /no-store/);
  const result = await response.json();
  publicOnly(result);
  return result;
}
// Fixed, inspected tenant tables: no policy/default warehouse rows are misclassified as goods.
const protectedTables = [
  'products',
  'product_images',
  'bundle_components',
  'stock',
  'stock_movements',
  'stock_locations',
  'reservation_locations',
  'stock_location_movements',
  'stock_location_operations',
  'wms_lots',
  'wms_cost_layers',
  'wms_layer_positions',
  'wms_reservation_layers',
  'wms_layer_movements',
  'wms_operations',
  'wms_issue_fragments',
  'wms_return_fragments',
  'purchase_orders',
  'purchase_order_lines',
  'purchase_receipts',
  'purchase_receipt_lines',
  'warehouse_documents',
  'warehouse_document_lines',
  'orders',
  'order_items',
  'order_pick_items',
  'payment_entries',
];
async function fingerprint(c: PoolClient, table: string, predicate: string, params: unknown[]) {
  assert.match(table, /^[a-z_]+$/);
  // Exclude secret-bearing fields before even computing the public evidence hash.
  const row =
    "to_jsonb(q)-ARRAY['url_cipher','auth_cipher','request_cipher','raw_content','request_hash','lease_token']";
  return (
    await c.query(
      `SELECT count(*)::integer count,encode(sha256(convert_to(coalesce(jsonb_agg(${row} ORDER BY (${row})::text),'[]'::jsonb)::text,'UTF8')),'hex') sha256 FROM "${table}" q WHERE ${predicate}`,
      params,
    )
  ).rows[0];
}
async function negativeGraph(c: PoolClient) {
  const graph: Record<string, unknown> = {};
  for (const table of [
    'supplier_sources',
    'supplier_file_source_configs',
    'supplier_file_source_revisions',
    'supplier_file_remotes',
    'supplier_file_remote_revisions',
    'supplier_file_feed_schedules',
    'supplier_file_feed_schedule_revisions',
    'supplier_file_fetch_runs',
    'supplier_file_previews',
    'supplier_file_runs',
  ]) {
    graph[table] = await fingerprint(
      c,
      table,
      `tenant_id=$1 AND ${table === 'supplier_sources' ? 'id' : 'source_id'}=$2`,
      [state.tenant_id, negative.source_id],
    );
  }
  graph.rows = await fingerprint(
    c,
    'supplier_file_preview_rows',
    'tenant_id=$1 AND preview_id=$2',
    [state.tenant_id, negative.preview_id],
  );
  return graph;
}
try {
  const health = await get('/health');
  assert.equal(health.revision, revision);
  assert.equal(health.schema_revision, '119_supplier_remote_feeds');
  assert.equal(health.background_workers_enabled, false);
  assert.equal(health.restore_preview, false);
  assert.equal(health.supplier_remote_feeds_available, true);
  const before: any =
    phase !== 'before'
      ? JSON.parse(await readFile('docs/supplier-remote-feeds-positive-before.json', 'utf8'))
      : null;
  if (before) {
    assert.equal(before.status, 'PASS_BEFORE_POSITIVE_PROCESS');
    assert.equal(before.fixture_sha256, sha(bytes));
    assert.equal(before.revision, revision);
  }
  let api: any = null;
  let receipt: any = null;
  if (phase === 'failed') {
    receipt = JSON.parse(
      await readFile('docs/supplier-remote-feeds-positive-process.json', 'utf8'),
    );
    assert.equal(receipt.status, 'PUBLIC_HTTPS_SYNTHETIC_NOT_SUCCESSFUL');
    assert.equal(receipt.fetch.source_id, selection.source_id);
    const detail = await get(`/supplier-file-fetches/${receipt.fetch.id}`);
    assert.equal(detail.fetch.state, 'failed');
    assert.equal(detail.fetch.http_status, 402);
    assert.equal(detail.fetch.error_code, 'HTTP_STATUS');
    assert.equal(detail.fetch.attempt, 1);
    assert.equal(detail.fetch.preview_id, null);
    assert.equal(detail.fetch.run_id, null);
    assert.equal(detail.preview, null);
    assert.equal(detail.run, null);
    api = detail;
  }
  if (phase === 'after') {
    receipt = JSON.parse(
      await readFile('docs/supplier-remote-feeds-positive-process.json', 'utf8'),
    );
    assert.equal(receipt.status, 'PUBLIC_HTTPS_SYNTHETIC_PREVIEW_RECEIVED');
    assert.equal(receipt.revision, revision);
    assert.equal(receipt.fetch.source_id, selection.source_id);
    assert.equal(receipt.fixture_sha256, sha(bytes));
    const detail = await get(`/supplier-file-fetches/${receipt.fetch.id}`);
    const previewReply = await get(`/supplier-file-previews/${receipt.fetch.preview_id}`);
    const history = await get(`/supplier-file-sources/${selection.source_id}/history`);
    const remote = await get(`/supplier-file-sources/${selection.source_id}/remote`);
    assert.equal(detail.fetch.state, 'success');
    assert.equal(detail.fetch.attempt, 1);
    assert.equal(detail.fetch.run_id, null);
    assert.equal(detail.run, null);
    assert.equal(history.meta.total, 1);
    assert.equal(history.data.length, 1);
    const run = history.data[0],
      p = previewReply.preview;
    assert.equal(p.can_apply, false);
    assert.equal(p.executed_run_id, run.id);
    assert.equal(p.source_version, 2);
    assert.equal(p.raw_hash, sha(bytes));
    assert.equal(p.rows.length, 2);
    assert.deepEqual(p.summary, {
      total: 2,
      valid: 2,
      invalid: 0,
      new: 2,
      changed: 0,
      unchanged: 0,
      missing: 0,
    });
    assert.equal(run.source_version, 2);
    assert.equal(run.raw_hash, sha(bytes));
    assert.equal(run.rows.length, 2);
    assert.equal(run.missing.length, 0);
    assert.equal(remote.remote.display_host, 'httpbingo.org');
    assert.equal(remote.remote.auth_kind, 'none');
    assert.equal(remote.remote.has_credentials, false);
    api = { preview: p, run, fetch: detail.fetch }; // Kept in RAM only; public report contains IDs/counts/hashes.
  }
  const c = await pool.connect();
  const physical: Record<string, unknown> = {};
  let graph: any,
    proof: any = null;
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await c.query("SET LOCAL TIME ZONE 'UTC'");
    await c.query("SET LOCAL statement_timeout='8s'");
    assert.equal((await c.query('SELECT current_database() name')).rows[0].name, 'dynaminds');
    for (const table of protectedTables) {
      physical[table] = await fingerprint(c, table, 'tenant_id=$1', [state.tenant_id]);
      assert.equal((physical[table] as any).count, 0, table);
    }
    graph = await negativeGraph(c);
    if (before) {
      assert.deepEqual(physical, before.protected_tables);
      assert.deepEqual(graph, before.negative_graph);
    }
    const source = (
      await c.query('SELECT kind,version FROM supplier_sources WHERE tenant_id=$1 AND id=$2', [
        state.tenant_id,
        selection.source_id,
      ])
    ).rows[0];
    assert.deepEqual(source, { kind: 'file', version: 2 });
    const items = (
      await c.query(
        'SELECT id,remote_product_id,remote_variant_id,product_id,version,file_run_id,snapshot FROM supplier_catalog_items WHERE tenant_id=$1 AND source_id=$2 ORDER BY remote_product_id',
        [state.tenant_id, selection.source_id],
      )
    ).rows;
    if (phase !== 'after') {
      assert.equal(items.length, 0);
      assert.equal(
        (
          await c.query(
            'SELECT count(*)::integer n FROM supplier_file_previews WHERE tenant_id=$1 AND source_id=$2',
            [state.tenant_id, selection.source_id],
          )
        ).rows[0].n,
        0,
      );
      assert.equal(
        (
          await c.query(
            'SELECT count(*)::integer n FROM supplier_file_runs WHERE tenant_id=$1 AND source_id=$2',
            [state.tenant_id, selection.source_id],
          )
        ).rows[0].n,
        0,
      );
      if (phase === 'failed') {
        const f = (
          await c.query(
            'SELECT f.state,f.attempt,f.preview_id,f.run_id,f.http_status,f.error_code,j.state job_state,j.attempts,j.lease_token IS NULL lease_released FROM supplier_file_fetch_runs f JOIN jobs j ON(j.tenant_id,j.id)=(f.tenant_id,f.job_id) WHERE f.tenant_id=$1 AND f.id=$2',
            [state.tenant_id, receipt.fetch.id],
          )
        ).rows[0];
        assert.equal(f.state, 'failed');
        assert.equal(f.attempt, 1);
        assert.equal(f.http_status, 402);
        assert.equal(f.error_code, 'HTTP_STATUS');
        assert.equal(f.preview_id, null);
        assert.equal(f.run_id, null);
        assert.equal(f.job_state, 'done');
        assert.equal(f.attempts, 1);
        assert.equal(f.lease_released, true);
        proof = {
          fetch_id: receipt.fetch.id,
          ...f,
          source_catalogue_items: 0,
          source_previews: 0,
          source_runs: 0,
        };
      }
    } else {
      assert.equal(items.length, 2);
      const p = (
        await c.query('SELECT * FROM supplier_file_previews WHERE tenant_id=$1 AND id=$2', [
          state.tenant_id,
          api.preview.id,
        ])
      ).rows[0];
      const raw = Buffer.from(decrypt(p.raw_content).content, 'utf8');
      assert.deepEqual(raw, bytes);
      assert.equal(p.raw_hash, sha(bytes));
      assert.equal(p.scope_hash, wmsLotsHash(p.payload));
      assert.equal(p.actor_id, state.user_id);
      assert.equal(p.api_key_id, null);
      assert.equal(p.client_key, receipt.fetch.id);
      assert.deepEqual(api.preview.rows, p.payload.rows);
      const pr = (
        await c.query(
          'SELECT payload FROM supplier_file_preview_rows WHERE tenant_id=$1 AND preview_id=$2 ORDER BY index',
          [state.tenant_id, p.id],
        )
      ).rows;
      assert.deepEqual(
        pr.map((x) => x.payload),
        p.payload.rows,
      );
      const run = (
        await c.query('SELECT * FROM supplier_file_runs WHERE tenant_id=$1 AND id=$2', [
          state.tenant_id,
          api.run.id,
        ])
      ).rows[0];
      assert.equal(run.preview_id, p.id);
      assert.equal(run.actor_id, state.user_id);
      assert.equal(run.api_key_id, null);
      assert.equal(run.payload.raw_hash, sha(bytes));
      assert.equal(run.payload.source_version, 2);
      assert.equal(run.source_id, selection.source_id);
      const rr = (
        await c.query(
          'SELECT payload FROM supplier_file_run_rows WHERE tenant_id=$1 AND run_id=$2 ORDER BY index',
          [state.tenant_id, run.id],
        )
      ).rows;
      assert.equal(rr.length, 2);
      for (let i = 0; i < items.length; i++) {
        const item = items[i],
          expected = i === 0 ? ['QA136-A', 10001, 7] : ['QA136-B', 0, 0];
        assert.equal(item.remote_product_id, expected[0]);
        assert.equal(item.remote_variant_id, '');
        assert.equal(item.product_id, null);
        assert.equal(item.version, 1);
        assert.equal(item.file_run_id, run.id);
        assert.equal(item.snapshot.unit_cost, expected[1]);
        assert.equal(item.snapshot.quantity, expected[2]);
        assert.equal(item.snapshot.file_preview_id, p.id);
        assert.equal(item.snapshot.file_run_id, run.id);
        assert.equal(item.snapshot.raw_hash, sha(bytes));
        assert.equal(item.snapshot.source_version, 2);
        assert(
          api.run.rows.some(
            (r: any) =>
              r.item_id === item.id &&
              r.after.snapshot.unit_cost === expected[1] &&
              r.after.snapshot.quantity === expected[2],
          ),
        );
        const stored = rr.find((x) => x.payload.item_id === item.id);
        assert(stored);
        assert.deepEqual(
          api.run.rows.find((r: any) => r.item_id === item.id).after,
          stored.payload.after,
        );
      }
      const f = (
        await c.query(
          'SELECT f.state,f.attempt,f.run_id,f.preview_id,f.raw_hash,f.decoded_bytes,j.state job_state,j.attempts,j.kind,j.payload FROM supplier_file_fetch_runs f JOIN jobs j ON(j.tenant_id,j.id)=(f.tenant_id,f.job_id) WHERE f.tenant_id=$1 AND f.id=$2',
          [state.tenant_id, receipt.fetch.id],
        )
      ).rows[0];
      assert.equal(f.state, 'success');
      assert.equal(f.attempt, 1);
      assert.equal(f.run_id, null);
      assert.equal(f.preview_id, p.id);
      assert.equal(f.raw_hash, sha(bytes));
      assert.equal(f.decoded_bytes, bytes.length);
      assert.equal(f.job_state, 'done');
      assert.equal(f.attempts, 1);
      assert.equal(f.kind, 'supplier.file.fetch');
      assert.equal(f.payload.fetch_id, receipt.fetch.id);
      proof = {
        fetch_id: receipt.fetch.id,
        preview_id: p.id,
        run_id: run.id,
        rows: 2,
        raw_decrypt_equals_fixture: true,
        catalogue_sha256: sha(JSON.stringify(items)),
        manual_fetch_run_id_null: true,
      };
    }
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
  assert.equal(sha(await readFile(ledgerPath)), sha(ledgerBytes));
  const report = {
    status:
      phase === 'before'
        ? 'PASS_BEFORE_POSITIVE_PROCESS'
        : phase === 'failed'
          ? 'PASS_HTTP_ERROR_NO_PREVIEW_NO_PUBLICATION'
          : 'PASS_POSITIVE_MANUAL_APPLY_READBACK',
    revision,
    schema_revision: '119_supplier_remote_feeds',
    tenant_id: state.tenant_id,
    source_id: selection.source_id,
    ledger_sha256: sha(ledgerBytes),
    fixture_sha256: sha(bytes),
    protected_tables: physical,
    negative_graph: graph,
    proof,
    api_get_only: true,
    sql_read_only: true,
    helper_business_writes: 0,
    all_tenant_tables_claimed: false,
    full_goal_complete: false,
    commercial_supplier_verified: false,
    scheduler_verified: false,
  };
  await writeFile(
    `docs/supplier-remote-feeds-positive-${phase}.json`,
    JSON.stringify(report, null, 2) + '\n',
    { flag: 'wx' },
  );
  console.log(`QA136_POSITIVE_${phase.toUpperCase()}_PASS`);
} catch {
  console.error(
    'QA136_POSITIVE_READBACK_FAILED: no secrets emitted; inspect root-controlled assertion locally.',
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
