/** Own QA118 firm; setup performs no plan/policy writes. Readback verifies the
 * actual Chrome policy → preview → draft → partial PZ → next NOP process. */
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile, lstat } from 'node:fs/promises';
import { pool } from '../server/db';
type Json = Record<string, any>;
const phase = process.argv[2],
  revision = process.env.QA_EXPECTED_REVISION;
assert(['setup', 'readback'].includes(phase));
assert(revision && /^[a-f0-9]{7,40}$/.test(revision));
const statePath = 'data/replenishment-stage118.json';
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
async function save(s: Json, fresh = false) {
  await writeFile(statePath, JSON.stringify(s, null, 2), {
    mode: 0o600,
    ...(fresh ? { flag: 'wx' } : {}),
  });
}
async function call(s: Json, path: string, method = 'GET', body?: unknown, status = 200) {
  const r = await fetch('http://127.0.0.1:4100/api' + path, {
    method,
    signal: AbortSignal.timeout(15000),
    headers: {
      ...(s.cookie ? { cookie: s.cookie, 'X-Workspace-ID': s.tenant } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await r.text();
  assert.equal(r.status, status, `${method} ${path}: ${text.slice(0, 500)}`);
  return { response: r, data: JSON.parse(text) as Json };
}
async function mutate(s: Json, path: string, body: Json, status = 201) {
  assert(!s.pending, 'Read back the unresolved setup request first');
  s.pending = { path, body, status };
  await save(s);
  const r = (await call(s, path, 'POST', body, status)).data;
  s.pending = null;
  await save(s);
  return r;
}
try {
  const health = (await call({}, '/health')).data;
  assert.equal(health.revision, revision);
  assert.equal(health.schema_revision, '099_replenishment_plans');
  assert.equal(health.replenishment_plans_available, true);
  assert.equal(health.restore_preview, false);
  if (phase === 'setup') {
    const suffix = randomUUID().slice(0, 8);
    const s: Json = {
      stage: 118,
      email: `qa118-purchasing-${suffix}@demo.local`,
      password: process.env.QA_NATIVE_TEST_PASSWORD ?? `DynaQa118!${randomUUID()}`,
      pending: null,
      setup_complete: false,
    };
    await save(s, true);
    s.pending = 'signup';
    await save(s);
    const signup = await call(
      {},
      '/auth/signup',
      'POST',
      {
        email: s.email,
        password: s.password,
        name: 'QA118 Zakupy',
        organization: { name: 'QA118 Plan zakupów ' + suffix, currency: 'PLN', locale: 'pl-PL' },
      },
      201,
    );
    s.cookie = signup.response.headers.get('set-cookie')!.split(';')[0];
    s.tenant = signup.data.user.tenant_id;
    s.user = signup.data.user.id;
    s.pending = null;
    await save(s);
    s.warehouse = (await call(s, '/warehouses')).data.data[0];
    s.product = await mutate(s, '/products', {
      sku: 'QA118-' + suffix,
      ean: '001180000001',
      name: 'QA118 Uzupełnienie zapasu',
      price: 1999,
      quantity: 12,
      warehouse_id: s.warehouse.id,
    });
    s.reservation = await mutate(s, '/orders', {
      customer_name: 'QA118 Rezerwacja',
      email: 'qa118@example.test',
      warehouse_id: s.warehouse.id,
      items: [{ product_id: s.product.id, quantity: 7 }],
    });
    s.supplier = await mutate(s, '/suppliers', {
      name: 'QA118 Dostawca lokalny',
      code: 'QA118-' + suffix,
    });
    const purchase = (quantity: number, reference: string) => ({
      supplier_id: s.supplier.id,
      warehouse_id: s.warehouse.id,
      currency: 'PLN',
      reference,
      lines: [{ product_id: s.product.id, quantity, unit_cost: 1299, supplier_sku: '' }],
    });
    s.manual_draft = await mutate(s, '/purchase-orders', purchase(3, 'QA118 istniejący szkic'));
    const ordered = await mutate(s, '/purchase-orders', purchase(4, 'QA118 oczekująca dostawa'));
    s.manual_ordered = await mutate(
      s,
      '/purchase-orders/' + ordered.id + '/place',
      { version: ordered.version },
      200,
    );
    s.setup_complete = true;
    await save(s);
    assert.equal(
      Number(
        (
          await pool.query('SELECT count(*) FROM replenishment_policies WHERE tenant_id=$1', [
            s.tenant,
          ])
        ).rows[0].count,
      ),
      0,
    );
    await writeFile(
      'docs/replenishment-native-setup-qa.json',
      JSON.stringify(
        {
          status: 'PASS_SETUP_ONLY',
          revision,
          schema_revision: health.schema_revision,
          own_tenant: s.tenant,
          product_id: s.product.id,
          stock: { on_hand: 12, reserved: 7, available: 5 },
          incoming: { draft: 3, ordered: 4 },
          policy_writes: 0,
          plan_writes: 0,
          expected_ui_policy: {
            minimum_quantity: 13,
            target_quantity: 20,
            minimum_order_quantity: 4,
            order_multiple: 6,
            unit_cost_minor: 1299,
          },
          expected_recommendation: 12,
          provider_operations: false,
          full_goal_complete: false,
        },
        null,
        2,
      ),
    );
    console.log(
      JSON.stringify({ phase, status: 'PASS_SETUP_ONLY', email: s.email, tenant: s.tenant }),
    );
  } else {
    assert.equal((await lstat(statePath)).mode & 0o077, 0);
    const s = JSON.parse(await readFile(statePath, 'utf8'));
    assert(s.stage === 118 && s.setup_complete && !s.pending);
    const c = await pool.connect();
    let checkpoint: Json = {};
    try {
      await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await c.query("SET LOCAL TIME ZONE 'UTC'");
      const policies = (
        await c.query('SELECT * FROM replenishment_policies WHERE tenant_id=$1', [s.tenant])
      ).rows;
      assert.equal(policies.length, 1);
      const d = policies[0].definition;
      assert.deepEqual(
        [
          d.minimum_quantity,
          d.target_quantity,
          d.minimum_order_quantity,
          d.order_multiple,
          d.unit_cost_minor,
          d.supplier_id,
        ],
        [13, 20, 4, 6, 1299, s.supplier.id],
      );
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
      const rows = (
        await c.query(
          'SELECT * FROM replenishment_rows WHERE tenant_id=$1 ORDER BY preview_id,index',
          [s.tenant],
        )
      ).rows;
      const first = rows.find((r) => r.preview_id === previews[0].id)!,
        next = rows.find((r) => r.preview_id === previews[1].id)!;
      assert.equal(first.status, 'purchase');
      for (const [key, value] of Object.entries({
        available: '5',
        incoming_draft_quantity: '3',
        incoming_ordered_quantity: '4',
        projected_available: '12',
        recommended_quantity: '12',
        line_total_minor: '15588',
      }))
        assert.equal(first.result[key], value);
      assert.equal(next.status, 'unchanged');
      assert.equal(next.result.available, '11');
      assert.equal(next.result.projected_available, '24');
      assert.equal(next.result.recommended_quantity, '0');
      assert.equal(executions[0].groups.length, 1);
      assert.equal(executions[1].groups.length, 0);
      const generated = executions[0].groups[0].purchase_order_id;
      const po = (
        await c.query('SELECT * FROM purchase_orders WHERE tenant_id=$1 AND id=$2', [
          s.tenant,
          generated,
        ])
      ).rows[0];
      assert.equal(po.state, 'partial');
      assert.equal(po.version, 3);
      assert.equal(po.replenishment_execution_id, executions[0].id);
      const line = (
        await c.query('SELECT * FROM purchase_order_lines WHERE tenant_id=$1 AND order_id=$2', [
          s.tenant,
          generated,
        ])
      ).rows[0];
      assert.deepEqual(
        [line.quantity, line.received_quantity, line.closed_quantity, line.unit_cost],
        [12, 6, 0, 1299],
      );
      const stock = (
        await c.query(
          'SELECT on_hand,reserved,available FROM stock WHERE tenant_id=$1 AND product_id=$2 AND warehouse_id=$3',
          [s.tenant, s.product.id, s.warehouse.id],
        )
      ).rows[0];
      assert.deepEqual(stock, { on_hand: 18, reserved: 7, available: 11 });
      assert.equal(
        Number(
          (
            await c.query(
              'SELECT count(*) FROM purchase_receipts WHERE tenant_id=$1 AND order_id=$2',
              [s.tenant, generated],
            )
          ).rows[0].count,
        ),
        1,
      );
      const names = [
        'tenants',
        'users',
        'memberships',
        'products',
        'stock',
        'stock_locations',
        'reservations',
        'reservation_locations',
        'orders',
        'order_items',
        'order_events',
        'suppliers',
        'purchase_orders',
        'purchase_order_lines',
        'purchase_receipts',
        'purchase_receipt_lines',
        'warehouse_documents',
        'warehouse_document_lines',
        'stock_movements',
        'replenishment_policies',
        'replenishment_previews',
        'replenishment_rows',
        'replenishment_executions',
        'replenishment_execution_rows',
        'purchasing_source_versions',
        'purchasing_stock_changes',
        'audit_events',
        'workspace_usage',
      ];
      for (const name of names) {
        const field = ['tenants', 'users'].includes(name) ? 'id' : 'tenant_id';
        const data = (
          await c.query(`SELECT to_jsonb(t) row FROM "${name}" t WHERE ${field}=$1 ORDER BY 1`, [
            name === 'users' ? s.user : s.tenant,
          ])
        ).rows;
        checkpoint[name] = { count: data.length, sha256: hash(data) };
      }
      if (s.accepted_checkpoint) assert.deepEqual(checkpoint, s.accepted_checkpoint);
      await c.query('COMMIT');
      s.policy_id = policies[0].id;
      s.generated_po_id = generated;
      s.preview_ids = previews.map((p) => p.id);
      s.execution_ids = executions.map((e) => e.id);
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
    }
    for (const id of s.preview_ids) {
      const head = (await call(s, '/replenishment/previews/' + id)).data.preview;
      const rows = (await call(s, '/replenishment/previews/' + id + '/rows')).data;
      assert.equal(rows.scope_hash, head.scope_hash);
      assert.equal(rows.data.length, 1);
    }
    for (const id of s.execution_ids) {
      const head = (await call(s, '/replenishment/executions/' + id)).data.execution;
      const rows = (await call(s, '/replenishment/executions/' + id + '/rows')).data;
      assert.equal(rows.scope_hash, head.scope_hash);
      assert.equal(rows.data.length, 1);
    }
    s.accepted_checkpoint ??= checkpoint;
    await save(s);
    await writeFile(
      'docs/replenishment-native-readback-qa.json',
      JSON.stringify(
        {
          status: 'PASS',
          revision,
          schema_revision: health.schema_revision,
          own_tenant: s.tenant,
          policy_id: s.policy_id,
          generated_po: s.generated_po_id,
          preview_count: 2,
          execution_count: 2,
          planned_quantity: 12,
          received_quantity: 6,
          final_stock: { on_hand: 18, reserved: 7, available: 11 },
          next_projected_available: '24',
          next_recommended_quantity: '0',
          own_checkpoint_tables: Object.keys(checkpoint).length,
          checkpoint_sha256: hash(checkpoint),
          provider_operations: false,
          full_goal_complete: false,
        },
        null,
        2,
      ),
    );
    console.log(
      JSON.stringify({ phase, status: 'PASS', checkpoint_tables: Object.keys(checkpoint).length }),
    );
  }
} finally {
  await pool.end();
}
