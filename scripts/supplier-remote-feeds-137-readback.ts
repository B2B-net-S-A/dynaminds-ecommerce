/** Root-run QA137: local GET/SQL READ ONLY; no supplier fetch, login, apply or state rewrite. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Pool, PoolClient } from 'pg';
import { parseSupplierFileSource } from '../server/supplier-file-source-parse';
import { supplierFileSourceConfig } from '../server/supplier-file-source-schema';

const sha = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const json = async (path: string) => JSON.parse(await readFile(path, 'utf8'));
const one = (rows: any[]) => {
  assert.equal(rows.length, 1, 'Expected one own row');
  return rows[0];
};
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
] as const;
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
function publicOnly(value: unknown): void {
  if (Array.isArray(value)) return value.forEach(publicOnly);
  if (value && typeof value === 'object')
    for (const [k, v] of Object.entries(value)) {
      assert(!forbidden.has(k), 'Private DTO field');
      publicOnly(v);
    }
}
async function fingerprint(c: PoolClient, table: string, predicate: string, params: unknown[]) {
  assert.match(table, /^[a-z_]+$/);
  // The historical graph never exposes even hashes of encrypted credentials or private request hashes.
  const row =
    "to_jsonb(q)-ARRAY['url_cipher','auth_cipher','request_cipher','raw_content','request_hash','lease_token']";
  return one(
    (
      await c.query(
        `SELECT count(*)::integer count,encode(sha256(convert_to(coalesce(jsonb_agg(${row} ORDER BY (${row})::text),'[]'::jsonb)::text,'UTF8')),'hex') sha256 FROM "${table}" q WHERE ${predicate}`,
        params,
      )
    ).rows,
  );
}
async function sourceGraph(c: PoolClient, tenant: string, source: string) {
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
    'supplier_catalog_items',
  ])
    graph[table] = await fingerprint(
      c,
      table,
      `q.tenant_id=$1 AND q.${table === 'supplier_sources' ? 'id' : 'source_id'}=$2`,
      [tenant, source],
    );
  graph.preview_rows = await fingerprint(
    c,
    'supplier_file_preview_rows',
    'q.tenant_id=$1 AND q.preview_id IN(SELECT id FROM supplier_file_previews WHERE tenant_id=$1 AND source_id=$2)',
    [tenant, source],
  );
  graph.run_rows = await fingerprint(
    c,
    'supplier_file_run_rows',
    'q.tenant_id=$1 AND q.run_id IN(SELECT id FROM supplier_file_runs WHERE tenant_id=$1 AND source_id=$2)',
    [tenant, source],
  );
  graph.jobs = await fingerprint(
    c,
    'jobs',
    'q.tenant_id=$1 AND q.id IN(SELECT job_id FROM supplier_file_fetch_runs WHERE tenant_id=$1 AND source_id=$2)',
    [tenant, source],
  );
  return graph;
}

let databasePool: Pool | undefined;
let step = 'preflight';
try {
  const phase = process.argv[2];
  assert(['before', 'after'].includes(phase), 'Use before|after');
  assert.notEqual(process.env.DYNA_TEST, 'true');
  const revision = process.env.QA_EXPECTED_REVISION;
  assert.match(revision ?? '', /^[a-f0-9]{40}$/);
  const ledgerPath =
    '<workspace>/app/data/supplier-remote-feeds-stage137.json';
  const stat = await lstat(ledgerPath);
  assert(stat.isFile() && !stat.isSymbolicLink());
  assert.equal(stat.mode & 0o777, 0o600);
  const ledgerBytes = await readFile(ledgerPath),
    state = JSON.parse(ledgerBytes.toString('utf8'));
  assert.equal(state.tenant_id, '626b2805-d3eb-4513-8a81-9529fcfab4f1');
  assert.equal(state.user_id, 'e325b963-f3eb-44a6-bd0a-cd18f20483e6');
  assert.equal(state.pending, null);
  assert.equal(state.runtime, revision);
  assert.match(state.source_id, /^[a-f0-9-]{36}$/);
  assert.equal(typeof state.cookie, 'string');
  assert(state.cookie.length > 0);
  const fixture = await readFile('docs/supplier-remote-feeds-137-fixture.csv');
  const fixtureSource = await json('docs/supplier-remote-feeds-137-fixture-source.json');
  const transport = await json('docs/supplier-remote-feeds-137-transport-preflight.json');
  assert.equal(fixture.length, 2646);
  assert.equal(sha(fixture), fixtureSource.raw_sha256);
  assert.equal(fixtureSource.rows, 27);
  assert.equal(fixtureSource.bytes, fixture.length);
  assert.equal(fixtureSource.public_demo, true);
  assert.equal(new URL(fixtureSource.url).hostname, 'raw.githubusercontent.com');
  assert.equal(transport.status, 200);
  assert.equal(transport.fixture_exact, true);
  assert.equal(transport.genuine_transport, true);
  assert.equal(transport.injected_transport, false);
  assert.equal(transport.raw_hash, sha(fixture));
  const config = supplierFileSourceConfig.parse({
    format: 'csv',
    delimiter: ',',
    fields: {
      remote_id: { path: 'ID', value_type: 'text' },
      name: { path: 'Item', value_type: 'text' },
      cost_minor: { path: 'COGS', value_type: 'decimal_money' },
      quantity: { path: 'Inventory', value_type: 'integer' },
    },
  });
  const expected = parseSupplierFileSource(fixture.toString('utf8'), config, 'USD', 2);
  assert.equal(expected.length, 27);
  assert.equal(new Set(expected.map((r) => r.remote_product_id)).size, 27);
  assert(expected.every((r) => r.errors.length === 0 && r.snapshot !== null));
  const negative = await json('docs/supplier-remote-feeds-native-readback.json');
  const failed = await json('docs/supplier-remote-feeds-positive-process.json');
  assert.equal(negative.status, 'PASS_HTTPS_INVALID_PREVIEW_NO_PUBLICATION');
  assert.equal(failed.status, 'PUBLIC_HTTPS_SYNTHETIC_NOT_SUCCESSFUL');
  assert.equal(failed.fetch.http_status, 402);
  const oldSources = [negative.source_id, failed.fetch.source_id];
  assert.equal(new Set([...oldSources, state.source_id]).size, 3);
  const before =
    phase === 'after' ? await json('docs/supplier-remote-feeds-137-before.json') : null;
  if (before) {
    assert.equal(before.status, 'PASS_BEFORE_PUBLIC_HTTPS_FETCH');
    assert.equal(before.revision, revision);
    assert.equal(before.source_id, state.source_id);
    assert.equal(before.fixture_sha256, sha(fixture));
  }
  async function get(path: string): Promise<any> {
    const response = await fetch('http://127.0.0.1:4100/api' + path, {
      headers: { cookie: state.cookie },
      signal: AbortSignal.timeout(10000),
      redirect: 'error',
    });
    assert.equal(response.status, 200, 'Own local GET failed');
    if (path !== '/health') assert.match(response.headers.get('cache-control') ?? '', /no-store/);
    const body = await response.json();
    publicOnly(body);
    return body;
  }
  step = 'health';
  const health = await get('/health');
  assert.equal(health.revision, revision);
  assert.equal(health.schema_revision, '119_supplier_remote_feeds');
  assert.equal(health.background_workers_enabled, false);
  assert.equal(health.restore_preview, false);
  assert.equal(health.supplier_remote_feeds_available, true);
  const remote = await get(`/supplier-file-sources/${state.source_id}/remote`);
  const schedule = await get(`/supplier-file-sources/${state.source_id}/feed-schedule`);
  assert.equal(remote.remote.display_host, 'raw.githubusercontent.com');
  assert.equal(remote.remote.version, 1);
  assert.equal(remote.remote.source_version, 2);
  assert.equal(remote.remote.auth_kind, 'none');
  assert.equal(remote.remote.has_credentials, false);
  assert.equal(remote.remote.scope, 'delta');
  assert.equal(schedule.schedule.enabled, false);
  let receipt: any = null,
    detail: any = null,
    previewReply: any = null,
    apiRun: any = null;
  if (phase === 'after') {
    step = 'api_manual_receipt';
    receipt = await json('docs/supplier-remote-feeds-137-process.json');
    assert.equal(receipt.status, 'PUBLIC_HTTPS_VALID_PREVIEW_RECEIVED');
    assert.equal(receipt.revision, revision);
    assert.equal(receipt.tenant_id, state.tenant_id);
    assert.equal(receipt.source_id, state.source_id);
    assert.equal(receipt.fetch.source_id, state.source_id);
    assert.equal(receipt.genuine_https_transport, true);
    assert.equal(receipt.transport_injected, false);
    assert.equal(receipt.fetch.raw_hash, sha(fixture));
    assert.equal(receipt.fetch.run_id, null);
    detail = await get(`/supplier-file-fetches/${receipt.fetch.id}`);
    previewReply = await get(`/supplier-file-previews/${receipt.fetch.preview_id}`);
    const history = await get(`/supplier-file-sources/${state.source_id}/history`);
    assert.equal(history.meta.total, 1);
    assert.equal(history.data.length, 1);
    apiRun = history.data[0];
    assert.equal(detail.fetch.id, receipt.fetch.id);
    assert.equal(detail.fetch.state, 'success');
    assert.equal(detail.fetch.attempt, 1);
    assert.equal(detail.fetch.http_status, 200);
    assert.equal(detail.fetch.run_id, null);
    assert.equal(detail.fetch.raw_hash, sha(fixture));
    assert.equal(detail.preview.id, receipt.fetch.preview_id);
    assert.equal(detail.preview.executed_run_id, apiRun.id);
    assert.equal(detail.run.id, apiRun.id);
    assert.equal(previewReply.preview.can_apply, false);
    assert.equal(previewReply.preview.executed_run_id, apiRun.id);
    assert.equal(apiRun.rows.length, 27);
    assert.equal(apiRun.missing.length, 0);
  }
  // db.ts can create config on import; require the existing local config before loading it.
  const local = await lstat(resolve(process.env.DYNA_LOCAL_CONFIG_PATH ?? '.local.json'));
  assert(local.isFile() && !local.isSymbolicLink());
  databasePool = (await import('../server/db')).pool;
  const { decrypt } = await import('../server/security');
  const { wmsLotsHash } = await import('../server/wms-lots');
  const c = await databasePool.connect();
  const physical: Record<string, unknown> = {},
    graphs: Record<string, unknown> = {};
  let proof: any = null;
  try {
    step = 'sql_readback';
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await c.query("SET LOCAL TIME ZONE 'UTC'");
    await c.query("SET LOCAL statement_timeout='8s'");
    assert.equal(one((await c.query('SELECT current_database() name')).rows).name, 'dynaminds');
    for (const table of protectedTables) {
      const digest = await fingerprint(c, table, 'q.tenant_id=$1', [state.tenant_id]);
      assert.equal(digest.count, 0, 'Protected goods table is nonempty');
      physical[table] = digest;
    }
    for (const id of oldSources) graphs[id] = await sourceGraph(c, state.tenant_id, id);
    if (before) {
      assert.deepEqual(physical, before.protected_tables);
      assert.deepEqual(graphs, before.earlier_source_graphs);
    }
    const source = one(
      (
        await c.query(
          'SELECT s.*,cfg.config FROM supplier_sources s JOIN supplier_file_source_configs cfg ON(cfg.tenant_id,cfg.source_id)=(s.tenant_id,s.id) WHERE s.tenant_id=$1 AND s.id=$2',
          [state.tenant_id, state.source_id],
        )
      ).rows,
    );
    assert.equal(source.kind, 'file');
    assert.equal(source.name, 'QA137 PUBLIC PRODUCTS CSV');
    assert.equal(source.currency, 'USD');
    assert.equal(source.version, 2);
    assert.equal(source.supplier_id, 'd5719777-dbed-4e52-8ace-dabcf9d2f31b');
    assert.equal(source.max_handling_days, 2);
    assert.deepEqual(source.config, config);
    const remoteSql = one(
      (
        await c.query('SELECT * FROM supplier_file_remotes WHERE tenant_id=$1 AND source_id=$2', [
          state.tenant_id,
          state.source_id,
        ])
      ).rows,
    );
    assert.equal(remoteSql.actor_id, state.user_id);
    assert.equal(remoteSql.api_key_id, null);
    assert.equal(remoteSql.auth_cipher, null);
    assert(
      decrypt(remoteSql.url_cipher).url === fixtureSource.url,
      'Own public fixture URL mismatch',
    );
    const items = (
      await c.query(
        'SELECT id,remote_product_id,remote_variant_id,product_id,version,file_run_id,snapshot,sku,name FROM supplier_catalog_items WHERE tenant_id=$1 AND source_id=$2 ORDER BY remote_product_id',
        [state.tenant_id, state.source_id],
      )
    ).rows;
    const counts = one(
      (
        await c.query(
          'SELECT (SELECT count(*)::int FROM supplier_file_fetch_runs WHERE tenant_id=$1 AND source_id=$2) fetches,(SELECT count(*)::int FROM supplier_file_previews WHERE tenant_id=$1 AND source_id=$2) previews,(SELECT count(*)::int FROM supplier_file_runs WHERE tenant_id=$1 AND source_id=$2) runs',
          [state.tenant_id, state.source_id],
        )
      ).rows,
    );
    if (phase === 'before') {
      assert.equal(items.length, 0);
      assert.deepEqual(counts, { fetches: 0, previews: 0, runs: 0 });
    } else {
      assert.deepEqual(counts, { fetches: 1, previews: 1, runs: 1 });
      assert.equal(items.length, 27);
      const p = one(
        (
          await c.query('SELECT * FROM supplier_file_previews WHERE tenant_id=$1 AND id=$2', [
            state.tenant_id,
            receipt.fetch.preview_id,
          ])
        ).rows,
      );
      assert.equal(p.source_id, state.source_id);
      assert.equal(p.actor_id, state.user_id);
      assert.equal(p.api_key_id, null);
      assert.equal(p.source_version, 2);
      assert.equal(p.client_key, receipt.fetch.id);
      assert.deepEqual(Buffer.from(decrypt(p.raw_content).content, 'utf8'), fixture);
      assert.equal(p.raw_bytes, fixture.length);
      assert.equal(p.raw_hash, sha(fixture));
      assert.equal(p.scope_hash, wmsLotsHash(p.payload));
      assert.deepEqual(p.payload.config_snapshot, config);
      assert.deepEqual(p.payload.summary, {
        total: 27,
        valid: 27,
        invalid: 0,
        new: 27,
        changed: 0,
        unchanged: 0,
        missing: 0,
      });
      assert.deepEqual(previewReply.preview.rows, p.payload.rows);
      assert.deepEqual(detail.preview.rows, p.payload.rows);
      const previewRows = (
        await c.query(
          'SELECT index,payload FROM supplier_file_preview_rows WHERE tenant_id=$1 AND preview_id=$2 ORDER BY index',
          [state.tenant_id, p.id],
        )
      ).rows;
      assert.deepEqual(
        previewRows.map((r) => r.index),
        expected.map((r) => r.index),
      );
      assert.deepEqual(
        previewRows.map((r) => r.payload),
        p.payload.rows,
      );
      const run = one(
        (
          await c.query('SELECT * FROM supplier_file_runs WHERE tenant_id=$1 AND id=$2', [
            state.tenant_id,
            apiRun.id,
          ])
        ).rows,
      );
      assert.equal(run.preview_id, p.id);
      assert.equal(run.source_id, state.source_id);
      assert.equal(run.actor_id, state.user_id);
      assert.equal(run.api_key_id, null);
      assert.equal(run.payload.raw_hash, sha(fixture));
      assert.equal(run.payload.source_version, 2);
      assert.deepEqual(run.payload.summary, p.payload.summary);
      const rows = (
        await c.query(
          'SELECT index,item_id,payload FROM supplier_file_run_rows WHERE tenant_id=$1 AND run_id=$2 ORDER BY index',
          [state.tenant_id, run.id],
        )
      ).rows;
      assert.equal(rows.length, 27);
      assert.deepEqual(
        rows.map((r) => r.index),
        expected.map((r) => r.index),
      );
      assert.equal(new Set(rows.map((r) => r.item_id)).size, 27);
      for (const original of expected) {
        const r = p.payload.rows[original.index];
        assert.equal(r.remote_product_id, original.remote_product_id);
        assert.equal(r.remote_variant_id, '');
        assert.deepEqual(r.errors, []);
        assert.equal(r.status, 'new');
        assert.equal(r.before, null);
        assert.equal(r.item_id, null);
        assert.equal(r.expected_version, null);
        const { connection_hash, source_version, ...normalized } = r.snapshot;
        assert.match(connection_hash, /^[a-f0-9]{64}$/);
        assert.equal(source_version, 2);
        assert.deepEqual(normalized, original.snapshot);
        const item = one(
          items.filter(
            (x) => x.remote_product_id === original.remote_product_id && x.remote_variant_id === '',
          ),
        );
        assert.equal(item.product_id, null);
        assert.equal(item.version, 1);
        assert.equal(item.file_run_id, run.id);
        assert.equal(item.sku, original.sku);
        assert.equal(item.name, original.name);
        const { file_preview_id, file_run_id, raw_hash, ...published } = item.snapshot;
        assert.equal(file_preview_id, p.id);
        assert.equal(file_run_id, run.id);
        assert.equal(raw_hash, sha(fixture));
        assert.deepEqual(published, r.snapshot);
        const rr = rows[original.index];
        assert.equal(rr.item_id, item.id);
        assert.equal(rr.payload.item_id, item.id);
        assert.deepEqual(rr.payload.after.snapshot, item.snapshot);
        assert.equal(rr.payload.after.version, item.version);
        assert.equal(rr.payload.after.product_id, null);
        const apiRow = apiRun.rows[original.index];
        assert.equal(apiRow.item_id, item.id);
        assert.deepEqual(apiRow.after, rr.payload.after);
        assert.deepEqual(detail.run.rows[original.index].after, rr.payload.after);
      }
      const f = one(
        (
          await c.query(
            "SELECT f.*,encode(sha256(convert_to(to_jsonb(f)::text,'UTF8')),'hex') fetch_sql_sha256 FROM supplier_file_fetch_runs f WHERE tenant_id=$1 AND id=$2",
            [state.tenant_id, receipt.fetch.id],
          )
        ).rows,
      );
      assert.equal(f.fetch_sql_sha256, receipt.fetch_sql_sha256);
      assert.equal(f.actor_id, state.user_id);
      assert.equal(f.api_key_id, null);
      assert.equal(f.source_id, state.source_id);
      assert.equal(f.source_version, 2);
      assert.equal(f.remote_version, 1);
      assert.equal(f.schedule_version, null);
      assert.equal(f.state, 'success');
      assert.equal(f.phase, 'success');
      assert.equal(f.attempt, 1);
      assert.equal(f.http_status, 200);
      assert.equal(f.raw_hash, sha(fixture));
      assert.equal(f.decoded_bytes, fixture.length);
      assert.equal(f.preview_id, p.id);
      assert.equal(f.run_id, null);
      assert.equal(f.error_code, null);
      const job = one(
        (
          await c.query(
            'SELECT kind,payload,state,attempts,lease_token IS NULL lease_released FROM jobs WHERE tenant_id=$1 AND id=$2',
            [state.tenant_id, f.job_id],
          )
        ).rows,
      );
      assert.equal(job.kind, 'supplier.file.fetch');
      assert.equal(job.payload.fetch_id, f.id);
      assert.equal(job.state, 'done');
      assert.equal(job.attempts, 1);
      assert.equal(job.lease_released, true);
      // Compare full catalogue receipts losslessly: PostgreSQL checks timestamptz at microsecond precision.
      const fullReceipts = one(
        (
          await c.query(
            `SELECT count(*)::int n FROM supplier_file_run_rows r JOIN supplier_catalog_items i ON(i.tenant_id,i.id)=(r.tenant_id,r.item_id)
         WHERE r.tenant_id=$1 AND r.run_id=$2
         AND (to_jsonb(i)-ARRAY['tenant_id','source_id','refreshed_at'])=((r.payload->'after')-'refreshed_at')
         AND i.refreshed_at=(r.payload->'after'->>'refreshed_at')::timestamptz`,
            [state.tenant_id, run.id],
          )
        ).rows,
      );
      assert.equal(fullReceipts.n, 27);
      proof = {
        fetch_id: f.id,
        preview_id: p.id,
        run_id: run.id,
        rows: 27,
        fetch_sql_sha256: f.fetch_sql_sha256,
        fetch_unchanged_since_process: true,
        raw_decrypt_equals_fixture: true,
        typed_preview_rows_exact: true,
        typed_run_rows_exact: true,
        full_catalogue_receipts_exact: true,
        receipt_timestamp_comparison: 'postgres_timestamptz_microseconds',
        catalogue_sha256: sha(JSON.stringify(items)),
        catalogue_items: 27,
        currency: 'USD',
        cost_basis: 'net',
        linked_local_products: 0,
        manual_fetch_run_id_null: true,
        fetch_get_manual_run_visible: true,
      };
    }
    await c.query('COMMIT');
  } catch (error) {
    await c.query('ROLLBACK');
    throw error;
  } finally {
    c.release();
  }
  step = 'immutable_inputs';
  assert.equal(sha(await readFile(ledgerPath)), sha(ledgerBytes));
  assert.equal((await lstat(ledgerPath)).mode & 0o777, 0o600);
  assert.equal(sha(await readFile('docs/supplier-remote-feeds-137-fixture.csv')), sha(fixture));
  const report = {
    status:
      phase === 'before'
        ? 'PASS_BEFORE_PUBLIC_HTTPS_FETCH'
        : 'PUBLIC_HTTPS_MANUAL_PUBLICATION_PASS',
    revision,
    schema_revision: '119_supplier_remote_feeds',
    tenant_id: state.tenant_id,
    source_id: state.source_id,
    fixture_sha256: sha(fixture),
    fixture_bytes: fixture.length,
    ledger_sha256: sha(ledgerBytes),
    ledger_unchanged_within_read_operation: true,
    protected_tables: physical,
    earlier_source_graphs: graphs,
    proof,
    api_get_only: true,
    sql_read_only: true,
    helper_business_writes: 0,
    sessions_excluded: true,
    all_tenant_tables_claimed: false,
    commercial_supplier_verified: false,
    provider_verified: false,
    scheduler_verified: false,
    restore_verified: false,
    full_goal_complete: false,
  };
  step = 'new_report';
  await writeFile(
    `docs/supplier-remote-feeds-137-${phase}.json`,
    JSON.stringify(report, null, 2) + '\n',
    { flag: 'wx' },
  );
  console.log(report.status);
} catch (error) {
  const code =
    error && typeof error === 'object' && 'code' in error && /^[A-Z0-9_]+$/.test(String(error.code))
      ? String(error.code)
      : 'ASSERTION_OR_PREFLIGHT';
  const frame =
    error instanceof Error
      ? error.stack?.match(/supplier-remote-feeds-137-readback\.ts:(\d+):\d+/)?.[1]
      : undefined;
  console.error(
    JSON.stringify({ status: 'QA137_READBACK_FAIL', step, code, source_line: frame ?? null }),
  );
  process.exitCode = 1;
} finally {
  await databasePool?.end();
}
