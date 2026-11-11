/** Read-only evidence for the owned QA143 fixture; no business writes or retries. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, lstat } from 'node:fs/promises';
import { resolve } from 'node:path';
const root = '<workspace>/app';
assert.equal(resolve(process.env.DYNA_LOCAL_CONFIG_PATH ?? ''), resolve(root, '.local.json'));
const phase = process.argv[2];
assert(['before', 'after-preview', 'after-first', 'after-final', 'after-restart'].includes(phase));
const bytes = await readFile(resolve(root, 'data/proformas-stage143.json'));
assert.equal((await lstat(resolve(root, 'data/proformas-stage143.json'))).mode & 0o777, 0o600);
const state = JSON.parse(bytes.toString());
assert.equal(state.complete, true);
assert.equal(state.pending, null);
assert.equal(state.stage, 143);
const revision = process.env.QA_EXPECTED_REVISION ?? '';
assert.match(revision, /^[a-f0-9]{40}$/);
const sha = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const baselinePath = resolve(root, 'data/proformas-stage143-before.json');
const before = phase === 'before' ? null : JSON.parse(await readFile(baselinePath, 'utf8'));
if (before) assert.equal(before.setup_sha256, createHash('sha256').update(bytes).digest('hex'));
async function get(path: string, auth = true) {
  const r = await fetch('http://127.0.0.1:4100/api' + path, {
    redirect: 'error',
    signal: AbortSignal.timeout(10000),
    headers: auth ? { cookie: state.cookie, 'X-Workspace-ID': state.tenant_id } : {},
  });
  assert.equal(r.status, 200, 'Owned GET ' + path);
  return r.json() as Promise<any>;
}
const health = await get('/health', false);
assert.equal(health.revision, revision);
assert.equal(health.schema_revision, '127_proformas');
assert.equal(health.proformas_available, true);
assert.equal(health.background_workers_enabled, false);
assert.equal(health.restore_preview, false);
const { pool } = await import('../server/db');
try {
  async function snapshot() {
    const c = await pool.connect();
    try {
      await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await c.query("SET LOCAL TimeZone='UTC'");
      const db = (
        await c.query(
          "SELECT current_database() db,current_user actor,host(inet_server_addr()) address,inet_server_port() port,current_setting('transaction_read_only') ro",
        )
      ).rows[0];
      assert.equal(db.db, 'dynaminds');
      assert.equal(db.actor, 'postgres');
      assert.equal(db.port, 55432);
      assert.equal(db.ro, 'on');
      assert(['127.0.0.1', '::1'].includes(db.address));
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
  }
  const native = await snapshot();
  const orders = await Promise.all(state.orders.map((o: any) => get('/orders/' + o.id)));
  const product = await get('/products/' + state.product.id);
  const options = await get('/proformas/options'),
    series = await get('/proformas/series');
  const documents = await get('/documents');
  const details = await Promise.all(
    documents.data.map((d: any) => get('/proformas/documents/' + d.id)),
  );
  assert.deepEqual(await snapshot(), native, 'GET changed owned business rows');
  assert.deepEqual(product.stock, state.born.stock);
  for (let i = 0; i < orders.length; i++) {
    for (const field of [
      'version',
      'status',
      'items',
      'picking_items',
      'shipments',
      'total',
      'shipping_cost',
      'currency',
      'payment',
    ])
      assert.deepEqual(orders[i][field], state.born.orders[i][field], 'Order changed: ' + field);
  }
  const permitted = new Set([
    'documents',
    'audit_events',
    'proforma_series',
    'proforma_series_commands',
    'proforma_previews',
    'proforma_receipts',
    'proforma_counters',
    'proforma_admissions',
  ]);
  if (before)
    for (const [table, rows] of Object.entries(native))
      if (!permitted.has(table))
        assert.deepEqual(rows, before.native[table], 'Unrelated owned table changed: ' + table);
  const expected =
    phase === 'before' || phase === 'after-preview' ? 0 : phase === 'after-first' ? 1 : 3;
  assert.equal(native.documents.length, expected);
  assert.equal(native.proforma_receipts.length, expected);
  assert.equal(native.proforma_admissions.length, expected);
  if (!expected) assert.equal(native.proforma_counters.length, 0, 'Preview consumed a number');
  for (const d of native.documents) {
    assert.equal(d.kind, 'proforma');
    assert.equal(d.mode, 'local');
    const sum = d.data.lines.reduce((t: bigint, l: any) => t + BigInt(l.gross_minor), 0n);
    assert.equal(sum.toString(), d.data.totals.gross_minor);
    const r = native.proforma_receipts.find((r) => r.document_id === d.id);
    assert.equal(r.number, d.number);
    assert.equal(r.scope_hash, d.data.scope_hash);
    assert.deepEqual(r.snapshot.totals, d.data.totals);
  }
  if (expected === 3) {
    assert.equal(native.proforma_counters.length, 2);
    assert.deepEqual(native.proforma_counters.map((c) => c.last_number).sort(), [1, 2]);
  }
  const saved = {
    stage: 143,
    setup_sha256: createHash('sha256').update(bytes).digest('hex'),
    native,
    orders,
    product,
    options,
    series,
    documents,
    details,
  };
  if (phase === 'before')
    await writeFile(baselinePath, JSON.stringify(saved, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
  if (phase === 'after-final')
    await writeFile(
      resolve(root, 'data/proformas-stage143-final.json'),
      JSON.stringify(saved, null, 2) + '\n',
      { flag: 'wx', mode: 0o600 },
    );
  if (phase === 'after-restart') {
    const prior = JSON.parse(
      await readFile(resolve(root, 'data/proformas-stage143-final.json'), 'utf8'),
    );
    assert.deepEqual(native, prior.native, 'Restart changed business evidence');
  }
  const report = {
    stage: 143,
    status: 'PASS',
    phase,
    runtime_revision: revision,
    schema_revision: health.schema_revision,
    owned_tables: Object.keys(native).length,
    snapshots_sha256: sha(native),
    documents: documents.data.map((d: any) => ({
      id: d.id,
      order_id: d.order_id,
      number: d.number,
      kind: d.kind,
      mode: d.mode,
      totals: d.data.totals,
    })),
    counters: native.proforma_counters.map((c) => ({
      series_id: c.series_id,
      year: c.year,
      last_number: c.last_number,
    })),
    order_and_stock_unchanged: true,
    read_only_GETs: true,
    external_provider_verification: false,
  };
  await writeFile(`docs/proformas-native-${phase}.json`, JSON.stringify(report, null, 2) + '\n', {
    flag: 'wx',
  });
  console.log(
    JSON.stringify({
      status: 'PASS',
      phase,
      documents: expected,
      snapshot_sha256: report.snapshots_sha256,
    }),
  );
} finally {
  await pool.end();
}
