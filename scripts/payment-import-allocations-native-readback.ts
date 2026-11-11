/** Root-only readback of the owned QA141 fixture. No login, execution, retry or DB writes. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = '<workspace>/app';
assert.equal(resolve(process.env.DYNA_LOCAL_CONFIG_PATH ?? ''), resolve(root, '.local.json'));
const phase = process.argv[2];
assert(['before', 'after-first', 'after-final', 'after-restart'].includes(phase));
const revision = process.env.QA_EXPECTED_REVISION ?? '';
assert.match(revision, /^[a-f0-9]{40}$/);
const schema = process.env.QA_EXPECTED_SCHEMA ?? '125_payment_import_allocation_source_projection';
assert(
  ['124_payment_import_allocations', '125_payment_import_allocation_source_projection'].includes(
    schema,
  ),
);
const privatePath = resolve(root, 'data/payment-import-allocations-stage141.json');
const stat = await lstat(privatePath);
assert(stat.isFile() && !stat.isSymbolicLink());
assert.equal(stat.mode & 0o777, 0o600);
const bytes = await readFile(privatePath);
const state = JSON.parse(bytes.toString());
assert.equal(state.stage, 141);
assert.equal(state.complete, true);
assert.equal(state.pending, null);
const checkpoint = resolve(root, 'data/payment-import-allocations-stage141-before.json');
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const byteHash = (v: Buffer) => createHash('sha256').update(v).digest('hex');
const beforeBytes = phase === 'before' ? null : await readFile(checkpoint);
const before = beforeBytes ? JSON.parse(beforeBytes.toString()) : null;
if (before) assert.equal(before.setup_sha256, byteHash(bytes));
async function get(path: string, auth = true) {
  const r = await fetch('http://127.0.0.1:4100/api' + path, {
    redirect: 'error',
    signal: AbortSignal.timeout(10000),
    headers: auth ? { cookie: state.cookie, 'X-Workspace-ID': state.tenant_id } : {},
  });
  assert.equal(r.status, 200, 'Own GET ' + path);
  return r.json() as Promise<any>;
}
const health = await get('/health', false);
assert.equal(health.revision, revision);
assert.equal(health.schema_revision, schema);
assert.equal(health.payment_import_allocations_available, true);
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
      assert(['127.0.0.1', '::1'].includes(db.address));
      assert.equal(db.port, 55432);
      assert.equal(db.ro, 'on');
      const tables = (
        await c.query(
          `SELECT table_name FROM information_schema.tables t WHERE table_schema='public' AND table_type='BASE TABLE' AND table_name<>'sessions' AND EXISTS(SELECT 1 FROM information_schema.columns k WHERE k.table_schema=t.table_schema AND k.table_name=t.table_name AND k.column_name='tenant_id') ORDER BY table_name`,
        )
      ).rows;
      const rows: Record<string, any[]> = {};
      for (const { table_name: name } of tables) {
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
  const src = await get(
    '/payment-import-allocations/options?source_preview_id=' +
      state.legacy_preview.id +
      '&source_row_id=' +
      state.legacy_detail.data[0].row_id,
  );
  const history = await get('/payment-import-allocations/history');
  const executions = await Promise.all(
    history.data.map((e: any) => get('/payment-import-allocations/executions/' + e.id)),
  );
  // A new database snapshot observes any effects of GETs; reusing one RR snapshot would hide them.
  assert.deepEqual(await snapshot(), native, 'GET changed owned business data');
  assert.deepEqual(product.stock, state.born.stock);
  for (let i = 0; i < orders.length; i++) {
    assert.equal(orders[i].id, state.orders[i].id);
    for (const key of [
      'items',
      'picking_items',
      'shipments',
      'documents',
      'total',
      'shipping_cost',
      'currency',
    ])
      assert.deepEqual(
        orders[i][key],
        state.born.orders[i][key],
        'Sale/fulfillment changed: ' + key,
      );
  }
  const entries = native.payment_entries;
  const expected =
    phase === 'before'
      ? [0, 0, 0]
      : phase === 'after-first'
        ? [10000, 20000, 0]
        : [10000, 20000, 5000];
  for (let i = 0; i < orders.length; i++) {
    const own = entries.filter((e) => e.order_id === orders[i].id);
    assert.equal(own.length, expected[i] ? 1 : 0);
    if (expected[i]) {
      assert.equal(own[0].kind, 'receipt');
      assert.equal(own[0].amount, expected[i]);
      assert.equal(own[0].fee, 0);
      assert.equal(own[0].currency, 'PLN');
      assert.equal(own[0].method, 'bank_csv');
      assert.equal(orders[i].status, 'paid');
    } else assert.equal(orders[i].status, state.born.orders[i].status);
    assert.equal(orders[i].payment.received, expected[i]);
    assert.equal(orders[i].payment.amount_due, orders[i].total - expected[i]);
  }
  const count = phase === 'before' ? 0 : phase === 'after-first' ? 1 : 2;
  assert.equal(native.payment_import_allocation_executions.length, count);
  assert.equal(native.payment_import_allocation_rows.length, expected.filter(Boolean).length);
  assert.equal(history.data.length, count);
  assert.equal(history.next_cursor, null);
  assert.equal(native.payment_import_allocation_sources.length, count ? 1 : 0);
  assert.equal(native.payment_import_claims.length, count ? 1 : 0);
  assert.equal(src.source.source_version, count);
  assert.equal(
    src.source.remaining_amount_minor,
    phase === 'before' ? '35000' : phase === 'after-first' ? '5000' : '0',
  );
  assert.equal(src.source.remaining_fee_minor, '0');
  assert.equal(src.source.can_allocate, count < 2);
  if (count) {
    const claim = native.payment_import_claims[0];
    assert.equal(claim.state, 'applied');
    assert.equal(claim.execution_id, null);
    assert.equal(claim.row_id, null);
    assert.equal(claim.allocation_source_id, native.payment_import_allocation_sources[0].id);
    for (const execution of executions) {
      assert.equal(execution.execution.summary.currency, 'PLN');
      for (const row of execution.allocations)
        assert(
          entries.some(
            (e) =>
              e.id === row.entry_id && e.order_id === row.order_id && e.amount === row.amount_minor,
          ),
        );
    }
  }
  if (before) {
    const allowed = new Set([
      'orders',
      'payment_entries',
      'order_events',
      'audit_events',
      'order_local_financial_fences',
      ...Object.keys(native).filter((name) => name.startsWith('payment_import_allocation_')),
      'payment_import_claims',
    ]);
    for (const name of Object.keys(native))
      if (!allowed.has(name))
        assert.deepEqual(
          native[name],
          before.native[name],
          'Unrelated owned table changed: ' + name,
        );
    for (const name of [
      'payment_entries',
      'order_events',
      'audit_events',
      'payment_import_allocation_previews',
    ])
      for (const old of before.native[name])
        assert(
          native[name].some((row) => hash(row) === hash(old)),
          'Historical row changed: ' + name,
        );
    assert.equal(byteHash(await readFile(checkpoint)), byteHash(beforeBytes!));
  } else {
    await writeFile(
      checkpoint,
      JSON.stringify(
        { stage: 141, setup_sha256: byteHash(bytes), native, orders, source: src },
        null,
        2,
      ) + '\n',
      { flag: 'wx', mode: 0o600 },
    );
  }
  if (count === 2) {
    const secondPath = resolve(root, 'data/payment-import-allocations-stage141-before-second.json');
    const secondBytes = await readFile(secondPath);
    const second = JSON.parse(secondBytes.toString());
    assert.equal(second.tenant_id, state.tenant_id);
    for (const name of [
      'payment_entries',
      'order_events',
      'audit_events',
      'payment_import_claims',
      ...Object.keys(native).filter((name) => name.startsWith('payment_import_allocation_')),
    ])
      for (const old of second.native[name])
        assert(
          native[name].some((row) => hash(row) === hash(old)),
          'First-round evidence changed: ' + name,
        );
    assert.equal(byteHash(await readFile(secondPath)), byteHash(secondBytes));
    const finalPath = resolve(root, 'data/payment-import-allocations-stage141-after-final.json');
    if (phase === 'after-final')
      await writeFile(
        finalPath,
        JSON.stringify({ stage: 141, setup_sha256: byteHash(bytes), native }, null, 2) + '\n',
        { flag: 'wx', mode: 0o600 },
      );
    else {
      const finalBytes = await readFile(finalPath);
      const finalState = JSON.parse(finalBytes.toString());
      assert.equal(finalState.setup_sha256, byteHash(bytes));
      assert.deepEqual(native, finalState.native, 'Business data changed across restart');
      assert.equal(byteHash(await readFile(finalPath)), byteHash(finalBytes));
    }
  }
  assert.equal(byteHash(await readFile(privatePath)), byteHash(bytes));
  const report = {
    stage: 141,
    phase,
    status: 'OWN_NATIVE_READBACK_PASS',
    revision,
    schema_revision: health.schema_revision,
    tenant_id: state.tenant_id,
    own_tenant_tables: Object.keys(native).length,
    setup_sha256: byteHash(bytes),
    snapshot_sha256: hash(native),
    source_version: count,
    received_minor: expected.map(String),
    posted_minor: String(expected.reduce((a, b) => a + b, 0)),
    remaining_amount_minor: src.source.remaining_amount_minor,
    remaining_fee_minor: src.source.remaining_fee_minor,
    execution_count: count,
    shared_claim_count: native.payment_import_claims.length,
    sale_fulfillment_stock_preserved: true,
    get_reads_effect_free: true,
    sessions_excluded: true,
    provider_verified: false,
    retry_verified: false,
    restart_verified: phase === 'after-restart',
    restore_verified: false,
    full_goal_complete: false,
  };
  await writeFile(
    'docs/payment-import-allocations-native-' + phase + '.json',
    JSON.stringify(report, null, 2) + '\n',
    { flag: 'wx', mode: 0o600 },
  );
  console.log(JSON.stringify(report));
} finally {
  await pool.end();
}
