/** Supplemental QA121 evidence. SELECT-only, no API, checkpoint or runtime mutations. */
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { pool, localConfig } from '../server/db';
type Json = Record<string, any>;
const statePath = 'data/replenishment-automations-stage121.json';
const reportPath = 'docs/replenishment-automations-binding-qa.json';
const expectedCheckpoint = 'eb69116d809d70241a9c46fc5a6a4ab93f988188a7b0205b4204599f56ffeb06';
const sha = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object')
    return Object.fromEntries(
      Object.entries(v)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, value]) => [k, canonical(value)]),
    );
  return v;
}
const setupChanges = [
  'audit_events',
  'idempotency_keys',
  'jobs',
  'order_events',
  'order_items',
  'order_pick_items',
  'orders',
  'purchase_order_lines',
  'purchase_orders',
  'purchasing_source_versions',
  'purchasing_stock_changes',
  'replenishment_automation_rules',
  'replenishment_automation_runs',
  'replenishment_execution_rows',
  'replenishment_executions',
  'replenishment_previews',
  'replenishment_rows',
  'reservation_locations',
  'reservations',
  'stock',
  'workspace_usage',
].sort();
try {
  const stat = await lstat(statePath);
  assert(
    stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0,
    'Private existing state must be a regular 0600 file',
  );
  const stateBytes = await readFile(statePath);
  const s: Json = JSON.parse(stateBytes.toString('utf8'));
  assert(
    s.stage === 121 && s.setup_complete && !s.pending && s.restart_verified === true,
    'Existing accepted QA121 after restart required',
  );
  assert.equal(s.runtime_revision, '231a016', 'Accepted source revision');
  if (process.env.QA_EXPECTED_REVISION)
    assert.equal(
      process.env.QA_EXPECTED_REVISION,
      s.runtime_revision,
      'Expected accepted revision',
    );
  assert.equal(s.schema_revision, '102_replenishment_automations');
  assert.equal(Object.keys(s.accepted_checkpoint).length, 268);
  assert.equal(
    sha(s.accepted_checkpoint),
    expectedCheckpoint,
    'Literal accepted checkpoint must not be replaced',
  );
  assert.equal(
    sha(s.accepted_evidence),
    s.accepted_evidence_sha256,
    'Original saved evidence digest',
  );
  assert.deepEqual(
    s.accepted_evidence.checkpoint,
    s.accepted_checkpoint,
    'Saved evidence carries accepted checkpoint',
  );
  const c = await pool.connect();
  let report: Json;
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await c.query("SET LOCAL TIME ZONE 'UTC'");
    await c.query("SET LOCAL statement_timeout='8s'");
    assert.equal(
      (await c.query("SELECT current_setting('transaction_read_only') v")).rows[0].v,
      'on',
    );
    const migration = await c.query(
      "SELECT name FROM migrations WHERE name='102_replenishment_automations'",
    );
    assert.equal(migration.rowCount, 1);
    const role = await c.query('SELECT role FROM memberships WHERE tenant_id=$1 AND user_id=$2', [
      s.tenant,
      s.user,
    ]);
    assert.equal(role.rowCount, 1);
    assert.equal(role.rows[0].role, 'admin');
    const names: string[] = (
      await c.query(`SELECT t.table_name FROM information_schema.tables t JOIN information_schema.columns k USING(table_schema,table_name)
      WHERE t.table_schema='public' AND t.table_type='BASE TABLE' AND k.column_name='tenant_id' AND t.table_name<>'sessions' ORDER BY t.table_name`)
    ).rows.map((r) => r.table_name);
    const current: Json = {};
    for (const name of [...names, 'tenants', 'users']) {
      assert(/^[a-z_][a-z0-9_]*$/.test(name));
      const identity = ['tenants', 'users'].includes(name) ? 'id' : 'tenant_id';
      const rows = (
        await c.query(`SELECT to_jsonb(t) row FROM "${name}" t WHERE ${identity}=$1 ORDER BY 1`, [
          name === 'users' ? s.user : s.tenant,
        ])
      ).rows;
      current[name] = { count: rows.length, sha256: sha(rows) };
    }
    assert.deepEqual(current, s.accepted_checkpoint, 'All 268 accepted fingerprints remain exact');
    assert.equal(sha(current), expectedCheckpoint);
    assert.deepEqual(
      Object.keys(s.setup_checkpoint).sort(),
      Object.keys(current).sort(),
      'Setup and accepted table scope remains identical',
    );
    const changed = Object.keys(current)
      .filter((k) => JSON.stringify(current[k]) !== JSON.stringify(s.setup_checkpoint[k]))
      .sort();
    assert.deepEqual(
      changed,
      setupChanges,
      'Only explicit Chrome enable/order and worker evidence tables changed since setup',
    );
    const stable = Object.keys(current)
      .filter((k) => !setupChanges.includes(k))
      .sort();
    for (const name of [
      'products',
      'product_sku_aliases',
      'product_logistics',
      'suppliers',
      'warehouses',
      'replenishment_policies',
      'stock_locations',
      'bundle_components',
      'product_translations',
    ]) {
      assert(
        current[name] && stable.includes(name),
        'Base catalog/policy/location must remain unchanged: ' + name,
      );
      assert.deepEqual(current[name], s.setup_checkpoint[name], 'Exact setup fingerprint: ' + name);
    }
    async function own(table: string) {
      assert(/^[a-z_][a-z0-9_]*$/.test(table));
      return (await c.query(`SELECT * FROM "${table}" WHERE tenant_id=$1 ORDER BY id`, [s.tenant]))
        .rows as Json[];
    }
    const rules = await own('replenishment_automation_rules'),
      runs = await own('replenishment_automation_runs'),
      previews = await own('replenishment_previews'),
      executions = await own('replenishment_executions');
    for (const rows of [rules, runs, previews, executions])
      assert.equal(rows.length, 1, 'Exactly one own chain');
    const [rule] = rules,
      [run] = runs,
      [p] = previews,
      [e] = executions;
    assert.equal(rule.id, s.rule.id);
    assert.equal(rule.version, 2);
    assert.equal(run.rule_id, rule.id);
    assert.equal(run.rule_version, rule.version);
    assert.deepEqual(rule.definition, {
      warehouse_id: s.warehouse.id,
      product_ids: [s.product.id],
      enabled: true,
      destination: 'new_drafts',
    });
    assert.deepEqual(
      run.definition,
      rule.definition,
      'Frozen approval definition equals revision2',
    );
    assert.equal(run.state, 'done');
    assert.equal(run.version, 2);
    assert(run.finished_at);
    for (const head of [rule, run, p, e]) {
      assert.equal(head.actor_id, s.user);
      assert.equal(head.source, 'manual');
    }
    assert.equal(run.api_key_id, null);
    assert.equal(rule.api_key_id, null);
    assert.deepEqual(run.crossings, [
      { product_id: s.product.id, before_available: 5, after_available: 2, minimum_quantity: 3 },
    ]);
    const items = (
      await c.query(
        'SELECT product_id,policy_id,policy_version,product_version FROM replenishment_automation_rule_items WHERE tenant_id=$1 AND rule_id=$2 ORDER BY product_id',
        [s.tenant, rule.id],
      )
    ).rows;
    assert.deepEqual(items, [
      {
        product_id: s.product.id,
        policy_id: s.policy.id,
        policy_version: s.policy.version,
        product_version: s.product.version,
      },
    ]);
    assert.deepEqual(
      run.policy_items,
      items,
      'Frozen policy identity/version equals actual approved scope',
    );
    assert.equal(p.id, s.accepted_evidence.preview_id);
    assert.equal(e.id, s.accepted_evidence.execution_id);
    assert.equal(run.id, s.accepted_evidence.run_id);
    assert.equal(p.client_key, run.id, 'Preview idempotency belongs to accepted source run');
    assert.equal(e.client_key, run.id, 'Execution idempotency belongs to accepted source run');
    assert.equal(e.preview_id, p.id);
    assert.equal(run.result.preview_id, p.id);
    assert.equal(run.result.execution_id, e.id);
    assert.equal(p.warehouse_id, s.warehouse.id);
    assert.equal(e.warehouse_id, s.warehouse.id);
    assert.equal(p.ready, true);
    assert.equal(e.state, 'done');
    assert.deepEqual(p.config, {
      client_key: run.id,
      warehouse_id: s.warehouse.id,
      items: [
        {
          product_id: s.product.id,
          product_version: s.product.version,
          policy_version: s.policy.version,
        },
      ],
    });
    const rows = await c.query(
      'SELECT * FROM replenishment_rows WHERE tenant_id=$1 AND preview_id=$2 ORDER BY index',
      [s.tenant, p.id],
    );
    const erows = await c.query(
      'SELECT * FROM replenishment_execution_rows WHERE tenant_id=$1 AND execution_id=$2 ORDER BY index',
      [s.tenant, e.id],
    );
    assert.equal(rows.rowCount, 1);
    assert.equal(erows.rowCount, 1);
    const r = rows.rows[0],
      er = erows.rows[0];
    assert.equal(r.product_id, s.product.id);
    assert.equal(r.policy_id, s.policy.id);
    assert.equal(r.policy_version, s.policy.version);
    assert.equal(r.product_version, s.product.version);
    assert.equal(er.preview_row_id, r.id);
    assert.equal(er.product_id, r.product_id);
    assert.equal(er.policy_id, r.policy_id);
    for (const key of ['input', 'snapshot', 'result', 'errors', 'warnings', 'status'])
      assert.deepEqual(er[key], r[key], 'Exact execution evidence ' + key);
    assert.equal(r.snapshot.product.sku, s.product.sku);
    assert.equal(r.snapshot.policy.id, s.policy.id);
    assert.equal(r.snapshot.policy.version, s.policy.version);
    assert.equal(r.result.recommended_quantity, '8');
    assert.equal(r.result.unit_cost_minor, 317);
    assert.equal(r.result.line_total_minor, '2536');
    const wh = (
      await c.query('SELECT id,name,code FROM warehouses WHERE tenant_id=$1 AND id=$2', [
        s.tenant,
        s.warehouse.id,
      ])
    ).rows[0];
    const scopeRows = rows.rows.map((row) =>
      Object.fromEntries(
        [
          'index',
          'product_id',
          'policy_id',
          'product_version',
          'policy_version',
          'input',
          'snapshot',
          'result',
          'status',
          'errors',
          'warnings',
        ].map((k) => [k, row[k]]),
      ),
    );
    const scopeInput = {
      warehouse: wh,
      source_version: String(p.source_version),
      rows: scopeRows,
      groups: p.groups,
    };
    const verifiedScope = createHmac('sha256', localConfig.encryptionKey)
      .update(sha(canonical(scopeInput)))
      .digest('hex');
    assert.equal(p.scope_hash, verifiedScope, 'Independently reconstructed frozen scope HMAC');
    assert.equal(e.scope_hash, p.scope_hash);
    assert.equal(String(e.before_source_version), String(p.source_version));
    const jobs = await own('jobs');
    assert(
      jobs.every((j) => j.state === 'done' && j.error === null),
      'Own jobs terminal and without error',
    );
    const j = jobs.find((job) => job.id === run.job_id);
    assert(j);
    assert.equal(j.tenant_id, s.tenant);
    assert.equal(j.kind, 'replenishment.automation');
    assert.deepEqual(j.payload, { run_id: run.id });
    assert.equal(j.lease_token, null);
    assert.equal(j.locked_at, null);
    assert.equal(jobs.filter((job) => job.kind === 'replenishment.automation').length, 1);
    const pos = await own('purchase_orders');
    assert.equal(pos.length, 1);
    const po = pos[0];
    assert.equal(po.id, s.accepted_evidence.purchase_order_id);
    assert.equal(po.state, 'draft');
    assert.equal(po.version, 1);
    assert.equal(po.replenishment_execution_id, e.id);
    assert.equal(po.replenishment_group_index, 0);
    assert.deepEqual(run.result.purchase_order_ids, [po.id]);
    assert.equal(e.groups[0].purchase_order_id, po.id);
    assert.equal(e.groups[0].total_minor, '2536');
    const orders = (
      await c.query('SELECT id,status,warehouse_id FROM orders WHERE tenant_id=$1', [s.tenant])
    ).rows;
    assert.deepEqual(orders, [
      { id: s.accepted_evidence.order_id, status: 'new', warehouse_id: s.warehouse.id },
    ]);
    const orderItems = (
      await c.query(
        'SELECT product_id,sku,quantity,scanned,price FROM order_items WHERE tenant_id=$1 AND order_id=$2',
        [s.tenant, orders[0].id],
      )
    ).rows;
    assert.deepEqual(orderItems, [
      { product_id: s.product.id, sku: s.product.sku, quantity: 3, scanned: 0, price: 1299 },
    ]);
    const reserves = (
      await c.query(
        'SELECT product_id,quantity,state FROM reservations WHERE tenant_id=$1 AND order_id=$2',
        [s.tenant, orders[0].id],
      )
    ).rows;
    assert.deepEqual(reserves, [{ product_id: s.product.id, quantity: 3, state: 'active' }]);
    const bins = (
      await c.query(
        'SELECT product_id,quantity,scanned FROM reservation_locations WHERE tenant_id=$1 AND order_id=$2',
        [s.tenant, orders[0].id],
      )
    ).rows;
    assert.equal(bins.length, 1);
    assert.deepEqual(bins[0], { product_id: s.product.id, quantity: 3, scanned: 0 });
    const stock = (
      await c.query(
        'SELECT on_hand,reserved,available FROM stock WHERE tenant_id=$1 AND product_id=$2 AND warehouse_id=$3',
        [s.tenant, s.product.id, s.warehouse.id],
      )
    ).rows;
    assert.deepEqual(stock, [{ on_hand: 5, reserved: 3, available: 2 }]);
    const zeroTables = [
      'purchase_receipts',
      'purchase_receipt_lines',
      'shipments',
      'shipping_plans',
      'dpd_collections',
      'dpd_collection_items',
      'dpd_pickup_claims',
      'dpd_pickup_runs',
      'dpd_pickup_schedules',
      'documents',
      'outbound_events',
      'outbound_deliveries',
      'email_messages',
      'sms_messages',
      'channels',
      'integration_runs',
      'listings',
      'payment_entries',
    ];
    for (const name of zeroTables) {
      assert(current[name], 'Expected effect table present: ' + name);
      assert.equal(current[name].count, 0, 'No own provider/physical/financial effect: ' + name);
      assert.deepEqual(
        current[name],
        s.setup_checkpoint[name],
        'Effect table unchanged from setup: ' + name,
      );
    }
    for (const name of ['stock_movements', 'stock_location_movements']) {
      assert.deepEqual(
        current[name],
        s.setup_checkpoint[name],
        'Original setup quantity journal remains byte-exact: ' + name,
      );
      assert.equal(current[name].count, 1, 'One pre-existing setup movement: ' + name);
    }
    const initialMovement = (
      await c.query(
        'SELECT kind,delta,order_id FROM stock_movements WHERE tenant_id=$1 AND product_id=$2 AND warehouse_id=$3 ORDER BY id',
        [s.tenant, s.product.id, s.warehouse.id],
      )
    ).rows;
    assert.deepEqual(
      initialMovement,
      [{ kind: 'initial', delta: 5, order_id: null }],
      'Original product creation physical journal only; reservation creates no extra physical delta',
    );
    const initialBinMovement = (
      await c.query(
        'SELECT kind,delta,order_id FROM stock_location_movements WHERE tenant_id=$1 AND product_id=$2 AND warehouse_id=$3 ORDER BY id',
        [s.tenant, s.product.id, s.warehouse.id],
      )
    ).rows;
    assert.deepEqual(
      initialBinMovement,
      [{ kind: 'stock_in', delta: 5, order_id: null }],
      'Original bin initialization journal only',
    );
    assert.deepEqual(s.setup_checkpoint.orders.count, 0);
    assert.equal(s.setup_checkpoint.reservations.count, 0);
    report = {
      stage: 121,
      status: 'PASS_READ_ONLY_BINDING_SUPPLEMENT',
      source_revision_reported: s.runtime_revision,
      schema_revision: s.schema_revision,
      transaction: { isolation: 'REPEATABLE READ', read_only: true, timezone: 'UTC' },
      accepted_checkpoint_tables: 268,
      accepted_checkpoint_sha256: expectedCheckpoint,
      accepted_checkpoint_exact: true,
      private_state_unchanged: true,
      original_setup_tables_exact: stable.length,
      original_setup_exact_names: stable,
      changed_from_setup_names: changed,
      binding: {
        rule_id: rule.id,
        rule_version: 2,
        run_id: run.id,
        job_id: run.job_id,
        preview_id: p.id,
        execution_id: e.id,
        purchase_order_id: po.id,
        client_keys_equal_run_id: true,
        definition_exact: true,
        policy_items_exact: true,
        crossing_exact: true,
        scope_hmac_reconstructed: true,
        execution_rows_exact: true,
      },
      business: {
        order_quantity: 3,
        order_scanned: 0,
        on_hand: 5,
        reserved: 3,
        available: 2,
        purchase_quantity: 8,
        unit_cost_minor: 317,
        total_minor: '2536',
        po_state: 'draft',
        additional_physical_movements_after_setup: 0,
        original_setup_stock_movements: 1,
        original_setup_bin_movements: 1,
        original_stock_movement: initialMovement[0],
        original_bin_movement: initialBinMovement[0],
        receipts: 0,
        provider_effect_rows: 0,
        zero_effect_tables: zeroTables,
      },
      no_api_calls: true,
      no_database_writes: true,
      no_checkpoint_rebase: true,
      full_goal_complete: false,
      limitations: [
        'Source revision is the already accepted stored/coordinator revision; this helper does not inspect Git or independently attest deployment.',
        'The approved order and reservation were created through Chrome after setup; they are checked explicitly and against the accepted checkpoint, not falsely claimed unchanged from the empty setup.',
        'Sessions are excluded consistently with the existing 268-table checkpoint; this helper neither logs in nor changes sessions.',
        'Own provider-related tables are empty; this is local-only evidence, not a live provider integration test.',
      ],
    };
    await c.query('COMMIT');
  } catch (error) {
    await c.query('ROLLBACK');
    throw error;
  } finally {
    c.release();
  }
  assert((await readFile(statePath)).equals(stateBytes), 'Existing private state bytes unchanged');
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log(
    JSON.stringify({
      status: report.status,
      checkpoint_tables: 268,
      checkpoint_sha256: expectedCheckpoint,
      setup_tables_exact: report.original_setup_tables_exact,
      binding_exact: true,
      provider_effect_rows: 0,
      full_goal_complete: false,
    }),
  );
} catch (error) {
  console.error(
    JSON.stringify({
      status: 'FAIL',
      message: error instanceof Error ? error.message : 'Unknown failure',
    }),
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
