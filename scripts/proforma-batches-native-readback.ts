/** Read-only evidence for the owned QA144 fixture, never retries business writes. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, lstat } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = '<workspace>/app';
assert.equal(resolve(process.env.DYNA_LOCAL_CONFIG_PATH ?? ''), resolve(root, '.local.json'));
const phase = process.argv[2];
assert(
  [
    'before',
    'after-preview',
    'after-single-denied',
    'after-issue',
    'before-stale-issue',
    'after-stale-denied',
    'after-restart',
  ].includes(phase),
);
const setupPath = resolve(root, 'data/proforma-batches-stage144.json');
const setupBytes = await readFile(setupPath);
assert.equal((await lstat(setupPath)).mode & 0o777, 0o600);
const state = JSON.parse(setupBytes.toString());
assert.equal(state.stage, 144);
assert.equal(state.complete, true);
assert.equal(state.pending, null);
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const privatePath = (p: string) => resolve(root, `data/proforma-batches-stage144-${p}.json`);
const priorPhase = (
  {
    'after-preview': 'before',
    'after-single-denied': 'after-preview',
    'after-issue': 'after-single-denied',
    'after-stale-denied': 'before-stale-issue',
    'after-restart': 'after-stale-denied',
  } as Record<string, string>
)[phase];
const prior = priorPhase ? JSON.parse(await readFile(privatePath(priorPhase), 'utf8')) : null;
if (prior) assert.equal(prior.setup_sha256, createHash('sha256').update(setupBytes).digest('hex'));
const get = async (path: string, auth = true) => {
  const response = await fetch('http://127.0.0.1:4100/api' + path, {
    redirect: 'error',
    signal: AbortSignal.timeout(10000),
    headers: auth ? { cookie: state.cookie, 'X-Workspace-ID': state.tenant_id } : {},
  });
  assert.equal(response.status, 200, 'Owned GET ' + path);
  return response.json() as Promise<any>;
};
const health = await get('/health', false);
assert.equal(health.revision, process.env.QA_EXPECTED_REVISION);
assert.equal(health.schema_revision, '128_proforma_batches');
assert.equal(health.proforma_batches_available, true);
assert.equal(health.background_workers_enabled, false);
assert.equal(health.restore_preview, false);
const { pool } = await import('../server/db');
try {
  const snapshot = async () => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await c.query("SET LOCAL TimeZone='UTC'");
      const db = (
        await c.query(
          "SELECT current_database() db,current_user actor,inet_server_port() port,current_setting('transaction_read_only') ro",
        )
      ).rows[0];
      assert.equal(db.db, 'dynaminds');
      assert.equal(db.actor, 'postgres');
      assert.equal(db.port, 55432);
      assert.equal(db.ro, 'on');
      const names = (
        await c.query(
          "SELECT table_name FROM information_schema.tables t WHERE table_schema='public' AND table_type='BASE TABLE' AND table_name<>'sessions' AND EXISTS(SELECT 1 FROM information_schema.columns k WHERE k.table_schema=t.table_schema AND k.table_name=t.table_name AND k.column_name='tenant_id') ORDER BY table_name",
        )
      ).rows;
      const rows: Record<string, any[]> = {};
      for (const { table_name: name } of names) {
        assert(/^[a-z_][a-z0-9_]*$/.test(name));
        rows[name] = (
          await c.query(`SELECT to_jsonb(q) row FROM "${name}" q WHERE tenant_id=$1 ORDER BY 1`, [
            state.tenant_id,
          ])
        ).rows.map((r) => r.row);
      }
      await c.query('COMMIT');
      return rows;
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
    }
  };
  const native = await snapshot();
  const orders = await Promise.all(state.orders.map((o: any) => get('/orders/' + o.id)));
  const product = await get('/products/' + state.product.id);
  assert.deepEqual(product.stock, state.born.stock, 'Proformas changed owned stock');
  for (const o of orders) {
    const born = state.born.orders.find((b: any) => b.id === o.id);
    for (const key of [
      'status',
      'total',
      'currency',
      'shipping_cost',
      'payment_mode',
      'items',
      'payment',
      'shipments',
      'address',
    ])
      assert.deepEqual(o[key], born[key], 'Proformas changed order ' + key);
  }
  const options = await get('/proformas/options');
  assert.equal(options.batch_available, true);
  const histories: Record<string, any> = {};
  for (const kind of ['preview', 'execution']) {
    histories[kind] = await get('/proformas/batches/history?kind=' + kind);
    assert(Array.isArray(histories[kind].data));
    assert.equal(histories[kind].next_cursor, null);
  }
  const previews = await Promise.all(
    native.proforma_batch_previews.map((p: any) => get('/proformas/batches/previews/' + p.id)),
  );
  const executions = await Promise.all(
    native.proforma_batch_executions.map((p: any) => get('/proformas/batches/executions/' + p.id)),
  );
  assert.equal(hash(await snapshot()), hash(native), 'Owned GET changed business rows');
  const counts = Object.fromEntries(
    Object.entries(native)
      .filter(([name]) => name.startsWith('proforma') || name === 'documents')
      .map(([name, rows]) => [name, rows.length]),
  );
  if (phase === 'before' || phase === 'after-preview' || phase === 'after-single-denied') {
    assert.equal(native.documents.length, 0);
    assert.equal(native.proforma_counters.length, 0);
    assert.equal(native.proforma_batch_executions.length, 0);
  } else {
    assert.equal(native.documents.length, 3);
    assert.equal(native.proforma_receipts.length, 3);
    assert.equal(native.proforma_batch_executions.length, 1);
    assert.equal(native.proforma_batch_execution_rows.length, 3);
    assert.equal(native.proforma_counters.length, 1);
    assert.equal(native.proforma_counters[0].last_number, 3);
    const execution = native.proforma_batch_executions[0];
    const admission = native.proforma_batch_admissions.find((a: any) => a.id === execution.id);
    assert(admission, 'Missing parent admission');
    const sameTransaction = (row: any) => {
      assert.equal(row.top_xid, execution.top_xid, 'Batch spans multiple transactions');
      assert.equal(row.transaction_started_at, execution.transaction_started_at);
    };
    sameTransaction(admission);
    assert.equal(execution.payload.rows.length, 3);
    assert.deepEqual(
      execution.payload.rows.map((r: any) => r.index),
      [0, 1, 2],
    );
    for (const values of [
      execution.payload.rows.map((r: any) => r.order_id),
      execution.payload.rows.map((r: any) => r.receipt.id),
      execution.payload.rows.map((r: any) => r.document.id),
    ])
      assert.equal(new Set(values).size, 3, 'Batch payload is not bijective');
    for (const row of execution.payload.rows) {
      const receipt = native.proforma_receipts.find((r: any) => r.id === row.receipt.id);
      const childAdmission = native.proforma_admissions.find((a: any) => a.id === receipt?.id);
      const document = native.documents.find((d: any) => d.id === row.document.id);
      const link = native.proforma_batch_execution_rows.find(
        (r: any) => r.batch_execution_id === execution.id && r.index === row.index,
      );
      assert(receipt && childAdmission && document && link, 'Incomplete batch graph');
      sameTransaction(receipt);
      sameTransaction(childAdmission);
      assert.equal(receipt.document_id, document.id);
      assert.equal(receipt.order_id, row.order_id);
      assert.equal(link.document_id, document.id);
      assert.equal(link.receipt_id, receipt.id);
      assert.equal(link.order_id, row.order_id);
      assert.equal(link.batch_preview_id, execution.preview_id);
      assert.equal(link.preview_id, row.preview_id);
      const source = native.proforma_batch_preview_rows.find(
        (r: any) => r.batch_preview_id === execution.preview_id && r.index === row.index,
      );
      assert(source, 'Missing parent preview row');
      const { document: _document, receipt: _receipt, ...previewRow } = row;
      assert.equal(hash(source.payload), hash(previewRow));
      assert.equal(hash(link.payload), hash(row));
      assert.equal(hash(document.data), hash(row.document.data));
    }
  }
  if (prior) {
    if (['after-single-denied', 'after-stale-denied', 'after-restart'].includes(phase))
      assert.equal(hash(native), hash(prior.native), 'Denied issue or restart changed owned rows');
    else {
      const allowed = new Set([
        'audit_events',
        'documents',
        ...Object.keys(native).filter((n) => n.startsWith('proforma')),
      ]);
      for (const name of Object.keys(native))
        if (!allowed.has(name))
          assert.equal(
            hash(native[name]),
            hash(prior.native[name]),
            'Unexpected change in owned table ' + name,
          );
    }
  }
  const privateRecord = {
    setup_sha256: createHash('sha256').update(setupBytes).digest('hex'),
    native,
    orders,
    product,
    previews,
    executions,
  };
  await writeFile(privatePath(phase), JSON.stringify(privateRecord, null, 2) + '\n', {
    flag: 'wx',
    mode: 0o600,
  });
  const report = {
    stage: 144,
    phase,
    status: 'PASS',
    runtime_revision: health.revision,
    schema_revision: health.schema_revision,
    owned_tables: Object.keys(native).length,
    owned_snapshot_sha256: hash(native),
    counts,
    documents: native.documents.map((d) => ({
      id: d.id,
      number: d.number,
      kind: d.kind,
      mode: d.mode,
      gross_minor: d.data.totals.gross_minor,
    })),
    stock_and_financial_fulfillment_fields_unchanged: true,
    read_only_GETs: true,
    atomic_graph_verified: native.proforma_batch_executions.length === 1,
    external_provider_verification: false,
    exact_prior_snapshot: ['after-single-denied', 'after-stale-denied', 'after-restart'].includes(
      phase,
    ),
  };
  await writeFile(
    `docs/proforma-batches-native-${phase}.json`,
    JSON.stringify(report, null, 2) + '\n',
    { flag: 'wx' },
  );
  console.log(
    JSON.stringify({
      stage: 144,
      phase,
      status: 'PASS',
      owned_tables: report.owned_tables,
      documents: native.documents.length,
      batch_executions: native.proforma_batch_executions.length,
    }),
  );
} finally {
  await pool.end();
}
