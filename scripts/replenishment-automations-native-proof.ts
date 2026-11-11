/** Own QA121 only. Setup creates a disabled rule, never a plan or stock crossing.
 * Readback/restart are read-only; actual enable/order/history UI belongs to root. */
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import type { PoolClient } from 'pg';
import { pool } from '../server/db';
type Json = Record<string, any>;
type Fingerprint = Record<string, { count: number; sha256: string }>;
const phase = process.argv[2];
const revision = process.env.QA_EXPECTED_REVISION;
const schema = '102_replenishment_automations';
const statePath = 'data/replenishment-automations-stage121.json';
const prefix = '/replenishment/automations';
assert(['setup', 'recover-setup', 'readback', 'restart'].includes(phase));
assert(revision && /^[a-f0-9]{7,40}$/.test(revision));
const sha = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
async function save(s: Json, fresh = false) {
  if (!fresh) assert.equal((await lstat(statePath)).mode & 0o077, 0);
  await writeFile(statePath, JSON.stringify(s, null, 2), {
    mode: 0o600,
    ...(fresh ? { flag: 'wx' } : {}),
  });
}
async function call(s: Json, path: string, method = 'GET', body?: Json, status = 200) {
  assert(phase === 'setup' || method === 'GET', 'Readback/restart cannot mutate');
  assert(!path.includes('/previews') || method === 'GET', 'No helper-created preview');
  assert(!path.endsWith('/execute'), 'No helper plan execution');
  const response = await fetch('http://127.0.0.1:4100/api' + path, {
    method,
    signal: AbortSignal.timeout(15000),
    headers: {
      ...(s.cookie ? { cookie: s.cookie, 'X-Workspace-ID': s.tenant } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  assert.equal(
    response.status,
    status,
    `${method} ${path}: HTTP${response.status}; resolve uncertain setup by manual readback`,
  );
  return { data: (await response.json()) as Json, response };
}
async function create(
  s: Json,
  key: string,
  path: string,
  body: Json,
  extract: (d: Json) => unknown = (d) => d,
) {
  assert.equal(phase, 'setup');
  assert(!s.pending && !s.setup_complete);
  assert(!path.includes('/previews') && !path.endsWith('/execute') && path !== '/orders');
  if (path === prefix + '/rules') assert.equal(body.definition.enabled, false);
  s.pending = { key, path, method: 'POST', body, expected: 201 };
  await save(s);
  const result = await call(s, path, 'POST', body, 201);
  // Persist the returned identity together with clearing the pending request.
  s[key] = extract(result.data);
  if (path === '/auth/signup') {
    const cookie = result.response.headers.get('set-cookie');
    assert(cookie);
    s.cookie = cookie.split(';')[0];
    s.user = result.data.user.id;
    s.tenant = result.data.user.tenant_id;
  }
  s.pending = null;
  await save(s);
}
async function snapshot(c: PoolClient, s: Json): Promise<Fingerprint> {
  const names: string[] = (
    await c.query(`SELECT t.table_name FROM information_schema.tables t
    JOIN information_schema.columns k USING(table_schema,table_name)
    WHERE t.table_schema='public' AND t.table_type='BASE TABLE' AND k.column_name='tenant_id'
    AND t.table_name<>'sessions' ORDER BY t.table_name`)
  ).rows.map((r) => r.table_name);
  const out: Fingerprint = {};
  for (const name of [...names, 'tenants', 'users']) {
    assert(/^[a-z_][a-z0-9_]*$/.test(name));
    const key = ['tenants', 'users'].includes(name) ? 'id' : 'tenant_id';
    const rows = (
      await c.query(`SELECT to_jsonb(t) row FROM "${name}" t WHERE ${key}=$1 ORDER BY 1`, [
        name === 'users' ? s.user : s.tenant,
      ])
    ).rows;
    out[name] = { count: rows.length, sha256: sha(rows) };
  }
  assert(
    out.jobs && out.stock && out.replenishment_automation_runs && out.replenishment_execution_rows,
  );
  return out;
}
async function ownTransaction<T>(s: Json, fn: (c: PoolClient) => Promise<T>) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await c.query("SET LOCAL TIME ZONE 'UTC'");
    const user = (
      await c.query(
        'SELECT u.id,m.tenant_id,m.role FROM users u JOIN memberships m ON m.user_id=u.id WHERE u.id=$1 AND m.tenant_id=$2',
        [s.user, s.tenant],
      )
    ).rows[0];
    assert(
      user && user.tenant_id === s.tenant && user.role === 'admin',
      'Own synthetic administrator only',
    );
    const result = await fn(c);
    await c.query('COMMIT');
    return result;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}
async function report(name: string, data: Json) {
  await writeFile(
    `docs/replenishment-automations-native-${name}-qa.json`,
    JSON.stringify(data, null, 2),
  );
  console.log(
    JSON.stringify({
      phase,
      status: data.status,
      checks: data.checks,
      chrome_verified: data.chrome_verified,
    }),
  );
}
async function finalizeSetup(s: Json) {
  assert(
    s.stage === 121 &&
      s.setup_complete === false &&
      !s.pending &&
      !s.setup_checkpoint &&
      !s.accepted_checkpoint &&
      !s.accepted_evidence_sha256,
  );
  assert.equal(s.runtime_revision, revision);
  assert.equal(s.schema_revision, schema);
  for (const id of [
    s.user,
    s.tenant,
    s.warehouse?.id,
    s.product?.id,
    s.supplier?.id,
    s.policy?.id,
    s.rule?.id,
  ])
    assert(typeof id === 'string' && /^[a-f0-9-]{36}$/.test(id), 'Existing own IDs required');
  const me = (await call(s, '/auth/me')).data.user;
  assert.equal(me.id, s.user);
  assert.equal(me.tenant_id, s.tenant);
  assert.equal(me.role, 'admin');
  const currentRule = (await call(s, prefix + '/rules/' + s.rule.id)).data.rule;
  assert.deepEqual(currentRule, s.rule, 'Original disabled rule unchanged');
  const currentPolicy = (await call(s, '/replenishment/policies/' + s.policy.id)).data.policy;
  assert.deepEqual(currentPolicy, s.policy, 'Original policy unchanged');
  for (const [key, value] of Object.entries({
    product_id: s.product.id,
    warehouse_id: s.warehouse.id,
    version: 1,
    enabled: true,
    minimum_quantity: 3,
    target_quantity: 10,
    supplier_id: s.supplier.id,
    supplier_sku: 'QA121-A',
    currency: 'PLN',
    minimum_order_quantity: 1,
    order_multiple: 1,
    unit_cost_minor: 317,
    expected_date: null,
  }))
    assert.deepEqual(currentPolicy[key], value, `Original policy ${key}`);
  assert(Date.parse(currentPolicy.cost_valid_until) > Date.now());
  assert(
    typeof currentPolicy.cost_confirmed_at === 'string' &&
      Number.isFinite(Date.parse(currentPolicy.cost_confirmed_at)),
  );
  assert.deepEqual(currentRule.definition, {
    warehouse_id: s.warehouse.id,
    product_ids: [s.product.id],
    enabled: false,
    destination: 'new_drafts',
  });
  assert.deepEqual(currentRule.policy_items, [
    {
      product_id: s.product.id,
      policy_id: s.policy.id,
      policy_version: 1,
      product_version: s.product.version,
    },
  ]);
  assert.equal(s.rule.version, 1);
  assert.equal(s.rule.definition.enabled, false);
  const evidence = await ownTransaction(s, async (c) => {
    const products = (
      await c.query(
        'SELECT id,sku,name,version,price FROM products WHERE tenant_id=$1 ORDER BY id',
        [s.tenant],
      )
    ).rows;
    assert.equal(products.length, 1);
    assert.deepEqual(products[0], {
      id: s.product.id,
      sku: s.product.sku,
      name: s.product.name,
      version: s.product.version,
      price: 1299,
    });
    const suppliers = (
      await c.query('SELECT id,name,code FROM suppliers WHERE tenant_id=$1 ORDER BY id', [s.tenant])
    ).rows;
    assert.equal(suppliers.length, 1);
    assert.deepEqual(suppliers[0], {
      id: s.supplier.id,
      name: s.supplier.name,
      code: s.supplier.code,
    });
    const wh = (
      await c.query('SELECT id,name,code FROM warehouses WHERE tenant_id=$1 ORDER BY id', [
        s.tenant,
      ])
    ).rows;
    assert.deepEqual(wh, [{ id: s.warehouse.id, name: s.warehouse.name, code: s.warehouse.code }]);
    for (const table of ['replenishment_policies', 'replenishment_automation_rules'])
      assert.equal(
        (await c.query(`SELECT count(*)::int n FROM ${table} WHERE tenant_id=$1`, [s.tenant]))
          .rows[0].n,
        1,
      );
    const stocks = (
      await c.query(
        'SELECT to_jsonb(t) row FROM stock t WHERE tenant_id=$1 ORDER BY warehouse_id,product_id',
        [s.tenant],
      )
    ).rows;
    assert.equal(stocks.length, 1);
    assert.deepEqual(
      [stocks[0].row.on_hand, stocks[0].row.reserved, stocks[0].row.available],
      [5, 0, 5],
    );
    for (const table of [
      'orders',
      'replenishment_automation_runs',
      'replenishment_previews',
      'replenishment_executions',
      'purchase_orders',
    ]) {
      assert.equal(
        (await c.query(`SELECT count(*)::int n FROM ${table} WHERE tenant_id=$1`, [s.tenant]))
          .rows[0].n,
        0,
        `Setup has no ${table}`,
      );
    }
    assert.equal(
      (
        await c.query(
          'SELECT count(*)::int n FROM reservations r JOIN orders o ON (o.tenant_id,o.id)=(r.tenant_id,r.order_id) WHERE o.tenant_id=$1',
          [s.tenant],
        )
      ).rows[0].n,
      0,
    );
    return { initial_stock: stocks[0].row, setup_checkpoint: await snapshot(c, s) };
  });
  Object.assign(s, evidence, { setup_complete: true });
  await save(s);
  await report(phase === 'recover-setup' ? 'setup-recovered' : 'setup', {
    stage: 121,
    setup_recovered: phase === 'recover-setup',
    status: 'PASS',
    source_revision: revision,
    schema_revision: schema,
    chrome_verified: false,
    checks: 7,
    disabled_rule_id: s.rule.id,
    product_sku: s.product.sku,
    warehouse_id: s.warehouse.id,
    next_ui:
      'Odczytaj reguły → edytuj QA121 → włącz + potwierdź przyszłe lokalne szkice → zapisz. Utwórz zamówienie 3 sztuk. Odczytaj uruchomienie i szkic 8 sztuk / 25,36 PLN netto.',
  });
}
try {
  const health = (await call({}, '/health')).data;
  assert.equal(health.revision, revision);
  assert.equal(health.schema_revision, schema);
  assert.equal(health.restore_preview, false);
  assert.equal(health.replenishment_automations_available, true);
  if (phase === 'setup') {
    const suffix = randomUUID().slice(0, 8);
    const s: Json = {
      stage: 121,
      runtime_revision: revision,
      schema_revision: schema,
      setup_complete: false,
      pending: null,
      chrome_verified: false,
      email: `qa121-stock-low-${suffix}@demo.local`,
      password: `DynaQa121!${randomUUID()}`,
    };
    await save(s, true);
    await create(s, 'signup', '/auth/signup', {
      email: s.email,
      password: s.password,
      name: 'QA121 Automatyczny zakup',
      organization: {
        name: 'QA121 Przekroczenie minimum ' + suffix,
        currency: 'PLN',
        locale: 'pl-PL',
      },
    });
    // The signup response is private. It remains exclusively in the 0600 file.
    const options = (await call(s, prefix + '/options')).data;
    assert.equal(options.available, true);
    assert.equal(options.can_manage, true);
    assert.equal(options.current_role, 'admin');
    const warehouses = (await call(s, '/warehouses')).data.data;
    assert.equal(warehouses.length, 1, 'Own newly created firm has one explicit fixture warehouse');
    s.warehouse = warehouses[0];
    await save(s);
    await create(s, 'product', '/products', {
      sku: 'QA121-STOCK-' + suffix,
      name: 'QA121 Uzupełnienie po rezerwacji',
      price: 1299,
      quantity: 5,
      warehouse_id: s.warehouse.id,
    });
    await create(s, 'supplier', '/suppliers', {
      name: 'QA121 Dostawca lokalny ' + suffix,
      code: 'QA121-' + suffix,
    });
    await create(
      s,
      'policy',
      '/replenishment/policies',
      {
        client_key: randomUUID(),
        warehouse_id: s.warehouse.id,
        product_id: s.product.id,
        definition: {
          enabled: true,
          minimum_quantity: 3,
          target_quantity: 10,
          supplier_id: s.supplier.id,
          supplier_sku: 'QA121-A',
          currency: 'PLN',
          minimum_order_quantity: 1,
          order_multiple: 1,
          unit_cost_minor: 317,
          cost_valid_until: new Date(Date.now() + 86400000).toISOString(),
          expected_date: null,
          confirm_cost: true,
        },
      },
      (d) => d.policy,
    );
    await create(
      s,
      'rule',
      prefix + '/rules',
      {
        client_key: randomUUID(),
        name: 'QA121 Minimum po rezerwacji',
        definition: {
          warehouse_id: s.warehouse.id,
          product_ids: [s.product.id],
          enabled: false,
          destination: 'new_drafts',
        },
      },
      (d) => d.rule,
    );
    await finalizeSetup(s);
  } else if (phase === 'recover-setup') {
    assert.equal((await lstat(statePath)).mode & 0o077, 0);
    const s: Json = JSON.parse(await readFile(statePath, 'utf8'));
    await finalizeSetup(s);
  } else {
    assert.equal((await lstat(statePath)).mode & 0o077, 0);
    const s: Json = JSON.parse(await readFile(statePath, 'utf8'));
    assert(s.stage === 121 && s.setup_complete && !s.pending);
    assert.equal(s.runtime_revision, revision);
    assert.equal(s.schema_revision, schema);
    const me = (await call(s, '/auth/me')).data.user;
    assert.equal(me.id, s.user);
    assert.equal(me.tenant_id, s.tenant);
    assert.equal(me.role, 'admin');
    if (phase === 'restart') {
      assert(
        s.accepted_checkpoint && s.accepted_evidence_sha256,
        'Never replace or invent accepted checkpoint',
      );
      const current = await ownTransaction(s, (c) => snapshot(c, s));
      assert.deepEqual(
        current,
        s.accepted_checkpoint,
        'Exact own business data after restart, including jobs/tenant/user; sessions alone excluded',
      );
      s.restart_verified = true;
      await save(s);
      await report('restart', {
        stage: 121,
        status: 'PASS',
        source_revision: revision,
        schema_revision: schema,
        checks: Object.keys(current).length,
        own_tables: Object.keys(current).length,
        checkpoint_sha256: sha(current),
        chrome_verified: s.chrome_verified === true,
      });
    } else {
      const evidence = await ownTransaction(s, async (c) => {
        const rules = (
          await c.query(
            'SELECT * FROM replenishment_automation_rules WHERE tenant_id=$1 ORDER BY id',
            [s.tenant],
          )
        ).rows;
        assert.equal(rules.length, 1);
        const rule = rules[0];
        assert.equal(rule.id, s.rule.id);
        assert.equal(rule.actor_id, s.user);
        assert.equal(rule.version, 2);
        assert.deepEqual(rule.definition, {
          warehouse_id: s.warehouse.id,
          product_ids: [s.product.id],
          enabled: true,
          destination: 'new_drafts',
        });
        const stock = (
          await c.query(
            'SELECT to_jsonb(t) row FROM stock t WHERE tenant_id=$1 ORDER BY warehouse_id,product_id',
            [s.tenant],
          )
        ).rows;
        assert.equal(stock.length, 1);
        assert.deepEqual(
          [stock[0].row.on_hand, stock[0].row.reserved, stock[0].row.available],
          [5, 3, 2],
        );
        const orders = (
          await c.query(
            'SELECT id,status,warehouse_id FROM orders WHERE tenant_id=$1 ORDER BY id',
            [s.tenant],
          )
        ).rows;
        assert.equal(orders.length, 1);
        assert.equal(orders[0].warehouse_id, s.warehouse.id);
        assert.equal(orders[0].status, 'new');
        const reservations = (
          await c.query(
            'SELECT r.order_id,r.product_id,r.quantity FROM reservations r JOIN orders o ON (o.tenant_id,o.id)=(r.tenant_id,r.order_id) WHERE o.tenant_id=$1 ORDER BY r.order_id,r.product_id',
            [s.tenant],
          )
        ).rows;
        assert.deepEqual(reservations, [
          { order_id: orders[0].id, product_id: s.product.id, quantity: 3 },
        ]);
        const runs = (
          await c.query(
            'SELECT * FROM replenishment_automation_runs WHERE tenant_id=$1 ORDER BY id',
            [s.tenant],
          )
        ).rows;
        assert.equal(runs.length, 1);
        const run = runs[0];
        assert.equal(run.rule_id, rule.id);
        assert.equal(run.rule_version, 2);
        assert.equal(run.actor_id, s.user);
        assert.equal(run.state, 'done');
        assert.deepEqual(run.crossings, [
          {
            product_id: s.product.id,
            before_available: 5,
            after_available: 2,
            minimum_quantity: 3,
          },
        ]);
        const job = (
          await c.query('SELECT kind,state,payload FROM jobs WHERE tenant_id=$1 AND id=$2', [
            s.tenant,
            run.job_id,
          ])
        ).rows[0];
        assert(job);
        assert.equal(job.kind, 'replenishment.automation');
        assert.equal(job.state, 'done');
        assert.deepEqual(job.payload, { run_id: run.id });
        const previews = (
          await c.query('SELECT * FROM replenishment_previews WHERE tenant_id=$1 ORDER BY id', [
            s.tenant,
          ])
        ).rows;
        const executions = (
          await c.query('SELECT * FROM replenishment_executions WHERE tenant_id=$1 ORDER BY id', [
            s.tenant,
          ])
        ).rows;
        assert.equal(previews.length, 1);
        assert.equal(executions.length, 1);
        const p = previews[0],
          e = executions[0];
        assert.equal(run.result.preview_id, p.id);
        assert.equal(run.result.execution_id, e.id);
        assert.equal(e.preview_id, p.id);
        assert.equal(p.actor_id, s.user);
        assert.equal(e.actor_id, s.user);
        assert.equal(p.warehouse_id, s.warehouse.id);
        assert.equal(p.ready, true);
        const rows = (
          await c.query('SELECT * FROM replenishment_rows WHERE tenant_id=$1 AND preview_id=$2', [
            s.tenant,
            p.id,
          ])
        ).rows;
        const erows = (
          await c.query(
            'SELECT * FROM replenishment_execution_rows WHERE tenant_id=$1 AND execution_id=$2',
            [s.tenant, e.id],
          )
        ).rows;
        assert.equal(rows.length, 1);
        assert.equal(erows.length, 1);
        const r = rows[0],
          er = erows[0];
        assert.equal(r.product_id, s.product.id);
        assert.equal(r.status, 'purchase');
        for (const [key, value] of Object.entries({
          available: '2',
          incoming_draft_quantity: '0',
          incoming_ordered_quantity: '0',
          projected_available: '2',
          recommended_quantity: '8',
          line_total_minor: '2536',
        }))
          assert.equal(r.result[key], value);
        assert.equal(r.result.unit_cost_minor, 317);
        assert.equal(r.result.currency, 'PLN');
        assert.equal(er.preview_row_id, r.id);
        assert.deepEqual(er.snapshot, r.snapshot);
        assert.deepEqual(er.result, r.result);
        assert.equal(p.groups.length, 1);
        assert.equal(e.groups.length, 1);
        assert.equal(e.groups[0].total_minor, '2536');
        const pos = (
          await c.query('SELECT * FROM purchase_orders WHERE tenant_id=$1 ORDER BY id', [s.tenant])
        ).rows;
        assert.equal(pos.length, 1);
        const po = pos[0];
        assert.equal(po.state, 'draft');
        assert.equal(po.version, 1);
        assert.equal(po.supplier_id, s.supplier.id);
        assert.equal(po.warehouse_id, s.warehouse.id);
        assert.equal(po.currency, 'PLN');
        assert.equal(e.groups[0].purchase_order_id, po.id);
        assert.deepEqual(run.result.purchase_order_ids, [po.id]);
        const lines = (
          await c.query(
            'SELECT product_id,quantity,unit_cost,received_quantity,closed_quantity,supplier_sku FROM purchase_order_lines WHERE tenant_id=$1 AND order_id=$2 ORDER BY product_id',
            [s.tenant, po.id],
          )
        ).rows;
        assert.deepEqual(lines, [
          {
            product_id: s.product.id,
            quantity: 8,
            unit_cost: 317,
            received_quantity: 0,
            closed_quantity: 0,
            supplier_sku: 'QA121-A',
          },
        ]);
        assert.equal(
          (
            await c.query('SELECT count(*)::int n FROM purchase_receipts WHERE tenant_id=$1', [
              s.tenant,
            ])
          ).rows[0].n,
          0,
        );
        const memberships = (
          await c.query('SELECT role FROM memberships WHERE tenant_id=$1 AND user_id=$2', [
            s.tenant,
            s.user,
          ])
        ).rows;
        assert.equal(memberships.length, 1);
        assert.equal(memberships[0].role, 'admin');
        return {
          rule_id: rule.id,
          rule_version: rule.version,
          run_id: run.id,
          preview_id: p.id,
          execution_id: e.id,
          purchase_order_id: po.id,
          order_id: orders[0].id,
          crossing: run.crossings,
          recommended_quantity: '8',
          total_minor: '2536',
          checkpoint: await snapshot(c, s),
        };
      });
      const apiRun = (await call(s, prefix + '/runs/' + evidence.run_id)).data;
      assert.equal(apiRun.current_role, 'admin');
      assert.equal(apiRun.can_manage, true);
      assert.equal(apiRun.can_read_value, true);
      assert.equal(apiRun.run.state, 'done');
      assert.equal(apiRun.run.can_cancel, false);
      assert.deepEqual(apiRun.run.crossings, evidence.crossing);
      assert.equal(apiRun.run.result.execution_id, evidence.execution_id);
      for (const [kind, id] of [
        ['previews', evidence.preview_id],
        ['executions', evidence.execution_id],
      ]) {
        const head = (await call(s, '/replenishment/' + kind + '/' + id)).data[
          kind === 'previews' ? 'preview' : 'execution'
        ];
        assert.equal(head.total, 1);
        assert.equal(head.purchase, 1);
        assert.equal(head.groups.length, 1);
        const page = (await call(s, '/replenishment/' + kind + '/' + id + '/rows?limit=100')).data;
        assert.equal(page.meta.total, 1);
        assert.equal(page.meta.cursor, null);
        assert.equal(page.data.length, 1);
        assert.equal(page.data[0].recommended_quantity, '8');
      }
      const po = (await call(s, '/purchase-orders/' + evidence.purchase_order_id)).data;
      assert.equal(po.state, 'draft');
      assert.equal(po.lines.length, 1);
      assert.equal(po.lines[0].quantity, 8);
      const reread = await ownTransaction(s, (c) => snapshot(c, s));
      assert.deepEqual(reread, evidence.checkpoint, 'All readback API calls are inert');
      const evidenceHash = sha(evidence);
      if (s.accepted_checkpoint) {
        assert.deepEqual(
          s.accepted_checkpoint,
          evidence.checkpoint,
          'Do not rebase accepted own data',
        );
        assert.equal(s.accepted_evidence_sha256, evidenceHash);
      } else {
        s.accepted_checkpoint = evidence.checkpoint;
        s.accepted_evidence_sha256 = evidenceHash;
        s.accepted_evidence = evidence;
      }
      s.chrome_verified =
        s.chrome_verified === true || process.env.QA_AUTOMATIONS_CHROME_VERIFIED === 'true';
      s.restart_verified = false;
      await save(s);
      await report('readback', {
        stage: 121,
        status: 'PASS',
        source_revision: revision,
        schema_revision: schema,
        checks: 18,
        own_tables: Object.keys(evidence.checkpoint).length,
        checkpoint_sha256: sha(evidence.checkpoint),
        chrome_verified: s.chrome_verified,
        rule_version: evidence.rule_version,
        runs: 1,
        previews: 1,
        executions: 1,
        purchase_orders: 1,
        purchase_quantity: '8',
        total_minor: '2536',
        local_draft_only: true,
      });
    }
  }
} catch (e) {
  console.error(
    JSON.stringify({
      phase,
      status: 'FAIL',
      message: e instanceof Error ? e.message : 'Unknown error; no credentials printed',
    }),
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
