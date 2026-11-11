/** Source-only QA119: real local setup, independent Chrome flow readback, restart.
 * Never runs preview/execute. Unknown setup writes require manual readback. */
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile, lstat } from 'node:fs/promises';
import { pool } from '../server/db';
import type { PoolClient } from 'pg';
type Json = Record<string, any>;
type Fingerprint = Record<string, { count: number; sha256: string }>;
const phase = process.argv[2],
  revision = process.env.QA_EXPECTED_REVISION;
assert(['setup', 'readback', 'restart'].includes(phase));
assert(revision && /^[a-f0-9]{7,40}$/.test(revision));
const statePath = 'data/replenishment-forecast-stage119.json';
const sha = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
async function save(s: Json, fresh = false) {
  if (!fresh) assert.equal((await lstat(statePath)).mode & 0o077, 0);
  await writeFile(statePath, JSON.stringify(s, null, 2), {
    mode: 0o600,
    ...(fresh ? { flag: 'wx' } : {}),
  });
}
async function call(
  s: Json,
  path: string,
  method = 'GET',
  body?: Json,
  expected = 200,
  headers: Record<string, string> = {},
) {
  const r = await fetch('http://127.0.0.1:4100/api' + path, {
    method,
    signal: AbortSignal.timeout(15000),
    headers: {
      ...(s.cookie ? { cookie: s.cookie, 'X-Workspace-ID': s.tenant } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  assert.equal(
    r.status,
    expected,
    `${method} ${path}: HTTP ${r.status}, expected ${expected}; read back uncertain setup manually`,
  );
  return { data: (await r.json()) as Json, response: r };
}
async function mutate(s: Json, path: string, body: Json, expected = 201, method = 'POST') {
  assert(!s.pending, 'Unresolved setup write: manual readback required');
  const headers: Record<string, string> =
    path === '/orders' ? { 'Idempotency-Key': randomUUID() } : {};
  s.pending = { path, method, body, expected, headers };
  await save(s);
  const result = await call(s, path, method, body, expected, headers);
  s.pending = null;
  await save(s);
  return result;
}
async function snapshot(c: PoolClient, s: Json): Promise<Fingerprint> {
  const names: string[] = (
    await c.query(`SELECT t.table_name FROM information_schema.tables t
    JOIN information_schema.columns k ON (k.table_schema,k.table_name)=(t.table_schema,t.table_name)
    WHERE t.table_schema='public' AND t.table_type='BASE TABLE' AND k.column_name='tenant_id'
    AND t.table_name<>'sessions' ORDER BY t.table_name`)
  ).rows.map((r) => r.table_name);
  const out: Fingerprint = {};
  for (const name of [...names, 'tenants', 'users']) {
    assert(/^[a-z_][a-z0-9_]*$/.test(name));
    const field = name === 'tenants' || name === 'users' ? 'id' : 'tenant_id';
    const value = name === 'users' ? s.user : s.tenant;
    const rows = (
      await c.query(`SELECT to_jsonb(t) AS row FROM "${name}" t WHERE ${field}=$1 ORDER BY 1`, [
        value,
      ])
    ).rows;
    out[name] = { count: rows.length, sha256: sha(rows) };
  }
  assert(out.jobs && out.purchasing_source_versions && out.stock);
  return out;
}
async function stock(s: Json) {
  return (
    await pool.query(
      'SELECT on_hand,reserved,available FROM stock WHERE tenant_id=$1 AND warehouse_id=$2 AND product_id=$3',
      [s.tenant, s.warehouse.id, s.product.id],
    )
  ).rows[0];
}
try {
  const health = (await call({}, '/health')).data;
  assert.equal(health.revision, revision);
  assert.equal(health.restore_preview, false);
  assert.equal(health.replenishment_plans_available, true);
  // Schema name supplied by root after final migration lands, never guessed.
  const expectedSchema = '100_replenishment_forecast';
  assert.equal(health.schema_revision, expectedSchema);
  if (phase === 'setup') {
    const suffix = randomUUID().slice(0, 8),
      s: Json = {
        stage: 119,
        runtime_revision: revision,
        schema_revision: expectedSchema,
        email: `qa119-forecast-${suffix}@demo.local`,
        password: `DynaQa119!${randomUUID()}`,
        setup_complete: false,
        pending: null,
        chrome_verified: false,
      };
    await save(s, true);
    const signed = await mutate(s, '/auth/signup', {
      email: s.email,
      password: s.password,
      name: 'QA119 Prognoza',
      organization: { name: 'QA119 Prognoza zakupów ' + suffix, currency: 'PLN', locale: 'pl-PL' },
    });
    const cookie = signed.response.headers.get('set-cookie');
    assert(cookie);
    s.cookie = cookie.split(';')[0];
    s.tenant = signed.data.user.tenant_id;
    s.user = signed.data.user.id;
    await save(s);
    const options = (await call(s, '/replenishment/options')).data;
    assert.equal(options.forecast_available, true);
    assert.equal(options.current_role, 'admin');
    s.warehouse = (await call(s, '/warehouses')).data.data[0];
    assert(s.warehouse?.id);
    s.product = (
      await mutate(s, '/products', {
        sku: 'QA119-' + suffix,
        ean: '001190000001',
        name: 'QA119 Prognoza popytu',
        price: 1999,
        quantity: 12,
        warehouse_id: s.warehouse.id,
      })
    ).data;
    const order = (quantity: number, name: string) => ({
      customer_name: name,
      email: 'qa119@example.test',
      warehouse_id: s.warehouse.id,
      items: [{ product_id: s.product.id, quantity }],
    });
    s.shipped_order = (await mutate(s, '/orders', order(7, 'QA119 Wydanie DEMO'))).data;
    for (const status of ['paid', 'picking'])
      await mutate(s, `/orders/${s.shipped_order.id}/status`, { status }, 200, 'PATCH');
    for (let i = 0; i < 7; i++)
      await mutate(s, `/orders/${s.shipped_order.id}/scan`, { code: s.product.sku }, 200);
    await mutate(s, `/orders/${s.shipped_order.id}/status`, { status: 'packed' }, 200, 'PATCH');
    s.shipped_order = (await mutate(s, `/orders/${s.shipped_order.id}/ship-demo`, {}, 200)).data;
    assert.equal(s.shipped_order.status, 'shipped');
    s.reservation_order = (await mutate(s, '/orders', order(2, 'QA119 Rezerwacja aktywna'))).data;
    s.supplier = (
      await mutate(s, '/suppliers', { name: 'QA119 Dostawca lokalny', code: 'QA119-' + suffix })
    ).data;
    const purchase = (quantity: number, reference: string) => ({
      supplier_id: s.supplier.id,
      warehouse_id: s.warehouse.id,
      currency: 'PLN',
      reference,
      lines: [{ product_id: s.product.id, quantity, unit_cost: 317, supplier_sku: '' }],
    });
    s.manual_draft = (
      await mutate(s, '/purchase-orders', purchase(3, 'QA119 istniejący szkic'))
    ).data;
    const ordered = (await mutate(s, '/purchase-orders', purchase(4, 'QA119 istniejąca dostawa')))
      .data;
    s.manual_ordered = (
      await mutate(s, `/purchase-orders/${ordered.id}/place`, { version: ordered.version }, 200)
    ).data;
    s.policy = (
      await mutate(s, '/replenishment/policies', {
        client_key: randomUUID(),
        warehouse_id: s.warehouse.id,
        product_id: s.product.id,
        definition: {
          enabled: true,
          minimum_quantity: 0,
          target_quantity: 0,
          supplier_id: s.supplier.id,
          supplier_sku: '',
          currency: 'PLN',
          minimum_order_quantity: 4,
          order_multiple: 6,
          unit_cost_minor: 317,
          cost_valid_until: new Date(Date.now() + 86400000).toISOString(),
          expected_date: null,
          confirm_cost: true,
        },
      })
    ).data.policy;
    assert(s.policy?.id);
    assert.deepEqual(await stock(s), { on_hand: 5, reserved: 2, available: 3 });
    for (const table of ['replenishment_previews', 'replenishment_executions'])
      assert.equal(
        (await pool.query(`SELECT count(*)::int n FROM ${table} WHERE tenant_id=$1`, [s.tenant]))
          .rows[0].n,
        0,
      );
    s.setup_complete = true;
    await save(s);
    await writeFile(
      'docs/replenishment-forecast-native-setup-qa.json',
      JSON.stringify(
        {
          status: 'PASS_SETUP_ONLY',
          revision,
          schema_revision: expectedSchema,
          own_tenant: s.tenant,
          stock: { on_hand: 5, reserved: 2, available: 3 },
          gross_shipped: 7,
          returned: 0,
          incoming_draft: 3,
          incoming_ordered: 4,
          forecast_previews: 0,
          forecast_executions: 0,
          expected_ui: {
            lookback_days: 7,
            coverage_days: 14,
            target: '14',
            recommended: '6',
            line_total_minor: '1902',
          },
          chrome_verified: false,
          real_provider_operations: false,
          full_goal_complete: false,
        },
        null,
        2,
      ),
    );
    console.log(JSON.stringify({ phase, status: 'PASS_SETUP_ONLY', own_tenant: s.tenant }));
  } else {
    assert.equal((await lstat(statePath)).mode & 0o077, 0);
    const s: Json = JSON.parse(await readFile(statePath, 'utf8'));
    assert(s.stage === 119 && s.setup_complete && !s.pending);
    assert.equal(s.runtime_revision, revision);
    assert.equal(s.schema_revision, expectedSchema);
    const me = (await call(s, '/auth/me')).data;
    assert.equal(me.user.id, s.user);
    assert.equal(me.user.tenant_id, s.tenant);
    assert.equal(me.user.role, 'admin');
    const c = await pool.connect();
    let checkpoint: Fingerprint;
    try {
      await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await c.query("SET LOCAL TIME ZONE 'UTC'");
      const previews = (
        await c.query(
          'SELECT * FROM replenishment_previews WHERE tenant_id=$1 ORDER BY created_at,id',
          [s.tenant],
        )
      ).rows;
      const executions = (
        await c.query(
          'SELECT * FROM replenishment_executions WHERE tenant_id=$1 ORDER BY created_at,id',
          [s.tenant],
        )
      ).rows;
      assert.equal(previews.length, 2);
      assert.equal(executions.length, 2);
      const proofHashes: Json = {};
      for (const [i, p] of previews.entries()) {
        assert.deepEqual(p.config.forecast, { lookback_days: 7, coverage_days: 14 });
        const rows = (
          await c.query('SELECT * FROM replenishment_rows WHERE tenant_id=$1 AND preview_id=$2', [
            s.tenant,
            p.id,
          ])
        ).rows;
        assert.equal(rows.length, 1);
        const r = rows[0],
          d = r.snapshot.demand;
        assert(d && d.semantic === 'warehouse_shipment_gross_v1');
        assert.equal(d.shipped_quantity, '7');
        assert.equal(d.shipment_movement_count, '1');
        assert.equal(d.return_movement_count, '0');
        assert.equal(p.actor_id, s.user);
        assert.equal(d.restocked_return_quantity, '0');
        assert.equal(d.coverage_target, '14');
        assert.equal(d.lookback_days, 7);
        assert.equal(d.coverage_days, 14);
        assert.equal(p.config.forecast_window.from, d.from);
        assert.equal(p.config.forecast_window.to, d.to);
        assert.equal(Date.parse(d.to) - Date.parse(d.from), 7 * 86400000);
        assert.equal(r.result.effective_minimum_quantity, '14');
        assert.equal(r.result.effective_target_quantity, '14');
        assert.equal(r.result.recommended_quantity, i === 0 ? '6' : '0');
        assert.equal(r.result.projected_available, i === 0 ? '10' : '16');
        assert.equal(r.status, i === 0 ? 'purchase' : 'unchanged');
        if (i === 0) {
          assert.equal(r.result.line_total_minor, '1902');
          assert.equal(r.result.available, '3');
        } else assert.equal(r.result.available, '5');
        const e = executions.find((e) => e.preview_id === p.id);
        assert(e);
        assert.equal(e.actor_id, s.user);
        const er = (
          await c.query(
            'SELECT * FROM replenishment_execution_rows WHERE tenant_id=$1 AND execution_id=$2',
            [s.tenant, e.id],
          )
        ).rows;
        assert.equal(er.length, 1);
        assert.deepEqual(er[0].snapshot.demand, d);
        proofHashes[p.id] = sha({ preview: p, rows, execution: e, execution_rows: er });
      }
      assert.equal(executions[0].groups.length, 1);
      assert.equal(executions[1].groups.length, 0);
      const generated = executions[0].groups[0].purchase_order_id;
      const po = (
        await c.query('SELECT * FROM purchase_orders WHERE tenant_id=$1 AND id=$2', [
          s.tenant,
          generated,
        ])
      ).rows[0];
      assert(
        po &&
          po.state === 'partial' &&
          po.version === 3 &&
          po.replenishment_execution_id === executions[0].id,
      );
      const line = (
        await c.query('SELECT * FROM purchase_order_lines WHERE tenant_id=$1 AND order_id=$2', [
          s.tenant,
          generated,
        ])
      ).rows[0];
      assert.deepEqual(
        [line.quantity, line.received_quantity, line.closed_quantity, line.unit_cost],
        [6, 2, 0, 317],
      );
      assert.equal(
        (
          await c.query('SELECT count(*)::int n FROM purchase_orders WHERE tenant_id=$1', [
            s.tenant,
          ])
        ).rows[0].n,
        3,
      );
      assert.equal(
        (
          await c.query('SELECT count(*)::int n FROM purchase_receipts WHERE tenant_id=$1', [
            s.tenant,
          ])
        ).rows[0].n,
        1,
      );
      const physical = (
        await c.query(
          'SELECT on_hand,reserved,available FROM stock WHERE tenant_id=$1 AND warehouse_id=$2 AND product_id=$3',
          [s.tenant, s.warehouse.id, s.product.id],
        )
      ).rows[0];
      assert.deepEqual(physical, { on_hand: 7, reserved: 2, available: 5 });
      checkpoint = await snapshot(c, s);
      if (s.accepted_checkpoint) {
        assert.deepEqual(checkpoint, s.accepted_checkpoint);
        assert.deepEqual(proofHashes, s.accepted_proof_hashes);
      } else {
        assert.equal(phase, 'readback', 'Readback checkpoint required before restart');
        s.accepted_checkpoint = checkpoint;
        s.accepted_proof_hashes = proofHashes;
      }
      await c.query('COMMIT');
      s.preview_ids = previews.map((p) => p.id);
      s.execution_ids = executions.map((e) => e.id);
      s.generated_po_id = generated;
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
    }
    for (const kind of ['previews', 'executions'])
      for (const id of kind === 'previews' ? s.preview_ids : s.execution_ids) {
        const detail = (await call(s, `/replenishment/${kind}/${id}`)).data;
        const head = detail[kind === 'previews' ? 'preview' : 'execution'];
        assert.equal(head.id, id);
        assert.deepEqual(head.config.forecast, { lookback_days: 7, coverage_days: 14 });
        const page = (await call(s, `/replenishment/${kind}/${id}/rows?limit=100`)).data;
        assert.equal(page.current_role, 'admin');
        assert.equal(page.data.length, 1);
        assert.equal(page.meta.cursor, null);
        assert.equal(page.data[0].demand.shipped_quantity, '7');
        assert.equal(page.data[0].demand.restocked_return_quantity, '0');
      }
    const history = (await call(s, '/replenishment/executions?warehouse_id=' + s.warehouse.id))
      .data;
    assert.equal(history.data.length, 2);
    assert.equal(history.meta.cursor, null);
    if (phase === 'restart') s.restart_verified = true;
    else s.readback_verified = true;
    if (process.env.QA_FORECAST_CHROME_VERIFIED === 'true') s.chrome_verified = true;
    await save(s);
    const report = {
      status: 'PASS',
      phase,
      revision,
      schema_revision: expectedSchema,
      own_tenant: s.tenant,
      gross_shipped: '7',
      returned: '0',
      coverage_target: '14',
      first_purchase: '6',
      first_total_minor: '1902',
      received: 2,
      next_recommended: '0',
      stock: { on_hand: 7, reserved: 2, available: 5 },
      preview_count: 2,
      execution_count: 2,
      own_checkpoint_tables: Object.keys(checkpoint).length,
      checkpoint_sha256: sha(checkpoint),
      immutable_proof_sha256: sha(s.accepted_proof_hashes),
      chrome_verified: s.chrome_verified === true,
      real_provider_operations: false,
      full_goal_complete: false,
    };
    await writeFile(
      `docs/replenishment-forecast-native-${phase}-qa.json`,
      JSON.stringify(report, null, 2),
    );
    console.log(
      JSON.stringify({
        phase,
        status: 'PASS',
        checkpoint_tables: Object.keys(checkpoint).length,
        chrome_verified: report.chrome_verified,
      }),
    );
  }
} finally {
  await pool.end();
}
