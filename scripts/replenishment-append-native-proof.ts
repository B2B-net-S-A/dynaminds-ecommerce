/** Source-only own QA120: setup has no preview/execute. Independent Chrome
 * append readback and exact accepted-checkpoint restart; no auto retry. */
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { pool } from '../server/db';
import type { PoolClient } from 'pg';
type Json = Record<string, any>;
type Fingerprint = Record<string, { count: number; sha256: string }>;
const phase = process.argv[2],
  revision = process.env.QA_EXPECTED_REVISION;
assert(['setup', 'recover-setup', 'readback', 'restart'].includes(phase));
assert(revision && /^[a-f0-9]{7,40}$/.test(revision));
const statePath = 'data/replenishment-append-stage120.json';
const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
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
  status = 200,
  headers: Record<string, string> = {},
) {
  if (phase === 'recover-setup') assert.equal(method, 'GET', 'Recovery is strictly read-only');
  const response = await fetch('http://127.0.0.1:4100/api' + path, {
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
    response.status,
    status,
    `${method} ${path}: HTTP${response.status}; manual readback required for uncertain setup`,
  );
  return { response, data: (await response.json()) as Json };
}
async function mutate(s: Json, path: string, body: Json, status = 201) {
  assert.equal(phase, 'setup');
  assert(!s.pending, 'Resolve prior setup write by manual readback');
  assert(
    !path.includes('/previews') && !path.includes('/execute'),
    'No plan preview or execution inside helper',
  );
  const headers: Record<string, string> =
    path === '/orders' ? { 'Idempotency-Key': randomUUID() } : {};
  s.pending = { path, method: 'POST', body, status, headers };
  await save(s);
  const r = await call(s, path, 'POST', body, status, headers);
  s.pending = null;
  await save(s);
  return r;
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
    const key = ['tenants', 'users'].includes(name) ? 'id' : 'tenant_id';
    const rows = (
      await c.query(`SELECT to_jsonb(t) row FROM "${name}" t WHERE ${key}=$1 ORDER BY 1`, [
        name === 'users' ? s.user : s.tenant,
      ])
    ).rows;
    out[name] = { count: rows.length, sha256: sha(rows) };
  }
  assert(out.jobs && out.stock && out.replenishment_execution_rows);
  return out;
}
function times(row: Json) {
  const result = { ...row };
  for (const key of ['created_at', 'updated_at'])
    if (result[key]) {
      const n = Date.parse(result[key]);
      assert(Number.isFinite(n));
      result[key] = new Date(n).toISOString();
    }
  return result;
}
function verifySetupPolicy(
  p: Json,
  s: Json,
  product: string,
  minimum: number,
  target: number,
  cost: number,
  code: string,
) {
  assert(p && p.product_id === product && p.warehouse_id === s.warehouse.id && p.version === 1);
  const expected = {
    enabled: true,
    minimum_quantity: minimum,
    target_quantity: target,
    supplier_id: s.supplier.id,
    supplier_sku: code,
    currency: 'PLN',
    minimum_order_quantity: 1,
    order_multiple: 1,
    unit_cost_minor: cost,
    expected_date: null,
  };
  for (const [key, value] of Object.entries(expected))
    assert.deepEqual(p[key], value, `Setup policy ${key}`);
  assert(
    typeof p.cost_confirmed_at === 'string' && Number.isFinite(Date.parse(p.cost_confirmed_at)),
  );
  assert(typeof p.cost_valid_until === 'string' && Date.parse(p.cost_valid_until) > Date.now());
  const age = Date.parse(p.cost_valid_until) - Date.parse(p.created_at);
  assert(age > 86340000 && age < 86460000, 'Original one-day known cost expiry');
}
async function finalizeSetup(s: Json, expectedSchema: string) {
  assert(
    s.stage === 120 &&
      !s.setup_complete &&
      !s.pending &&
      !s.accepted_checkpoint &&
      !s.accepted_evidence_sha256,
  );
  verifySetupPolicy(s.policy, s, s.product.id, 6, 11, 317, 'QA120-A');
  verifySetupPolicy(s.new_policy, s, s.new_product.id, 1, 4, 211, 'QA120-C');
  const c = await pool.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await c.query("SET LOCAL TIME ZONE 'UTC'");
    const targetBefore = (
      await c.query('SELECT to_jsonb(p) row FROM purchase_orders p WHERE tenant_id=$1 AND id=$2', [
        s.tenant,
        s.target.id,
      ])
    ).rows[0].row;
    const linesBefore = (
      await c.query(
        'SELECT to_jsonb(l) row FROM purchase_order_lines l WHERE tenant_id=$1 AND order_id=$2 ORDER BY product_id',
        [s.tenant, s.target.id],
      )
    ).rows.map((r) => r.row);
    const stockBefore = (
      await c.query('SELECT to_jsonb(t) row FROM stock t WHERE tenant_id=$1 ORDER BY product_id', [
        s.tenant,
      ])
    ).rows;
    const reservationsBefore = (
      await c.query(
        'SELECT to_jsonb(t) row FROM reservations t WHERE tenant_id=$1 ORDER BY order_id,product_id',
        [s.tenant],
      )
    ).rows;
    assert(targetBefore && targetBefore.id === s.target.id && targetBefore.tenant_id === s.tenant);
    assert.equal(targetBefore.supplier_id, s.supplier.id);
    assert.equal(targetBefore.warehouse_id, s.warehouse.id);
    assert.equal(targetBefore.currency, 'PLN');
    assert.equal(targetBefore.reference, s.target.reference);
    assert.equal(targetBefore.note, s.target.note);
    assert.equal(targetBefore.expected_date, s.target.expected_date);
    assert.equal(
      (await c.query('SELECT count(*)::int n FROM purchase_orders WHERE tenant_id=$1', [s.tenant]))
        .rows[0].n,
      1,
    );
    assert.equal(
      (await c.query('SELECT count(*)::int n FROM products WHERE tenant_id=$1', [s.tenant])).rows[0]
        .n,
      3,
    );
    assert.equal(
      (await c.query('SELECT count(*)::int n FROM suppliers WHERE tenant_id=$1', [s.tenant]))
        .rows[0].n,
      1,
    );
    assert.equal(
      (
        await c.query('SELECT count(*)::int n FROM purchase_receipts WHERE tenant_id=$1', [
          s.tenant,
        ])
      ).rows[0].n,
      0,
    );
    assert.equal(linesBefore.length, 2);
    for (const [id, quantity, cost, code] of [
      [s.product.id, 2, 317, 'QA120-A'],
      [s.untouched.id, 3, 421, 'QA120-B'],
    ]) {
      const line = linesBefore.find((l) => l.product_id === id);
      assert(line);
      assert.deepEqual(
        [
          line.quantity,
          line.unit_cost,
          line.supplier_sku,
          line.received_quantity,
          line.closed_quantity,
        ],
        [quantity, cost, code, 0, 0],
      );
    }
    assert.equal(stockBefore.length, 3);
    for (const [id, on_hand, reserved, available] of [
      [s.product.id, 5, 2, 3],
      [s.untouched.id, 4, 0, 4],
      [s.new_product.id, 0, 0, 0],
    ]) {
      const stock = stockBefore.find((r) => r.row.product_id === id)?.row;
      assert(stock);
      assert.equal(stock.warehouse_id, s.warehouse.id);
      assert.deepEqual(
        [stock.on_hand, stock.reserved, stock.available],
        [on_hand, reserved, available],
      );
    }
    assert.equal(reservationsBefore.length, 1);
    const reservation = reservationsBefore[0].row;
    assert.deepEqual(
      [
        reservation.order_id,
        reservation.product_id,
        reservation.warehouse_id,
        reservation.quantity,
        reservation.state,
      ],
      [s.reservation.id, s.product.id, s.warehouse.id, 2, 'active'],
    );
    for (const [key, value] of Object.entries({
      target_before: targetBefore,
      lines_before: linesBefore,
      stock_before: stockBefore,
      reservations_before: reservationsBefore,
    })) {
      if (s[key] !== undefined)
        assert.deepEqual(s[key], value, 'Do not overwrite prior setup evidence');
      else s[key] = value;
    }
    for (const table of ['replenishment_previews', 'replenishment_executions'])
      assert.equal(
        (await c.query(`SELECT count(*)::int n FROM ${table} WHERE tenant_id=$1`, [s.tenant]))
          .rows[0].n,
        0,
      );
    await c.query('COMMIT');
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    c.release();
  }
  assert.equal(s.lines_before.length, 2);
  assert.equal(s.target_before.version, 1);
  assert.equal(s.target_before.state, 'draft');
  s.setup_complete = true;
  await save(s);
  const report = {
    status: 'PASS_SETUP_ONLY',
    setup_recovered: phase === 'recover-setup',
    revision,
    schema_revision: expectedSchema,
    own_tenant: s.tenant,
    target_id: s.target.id,
    before_quantity: 2,
    untouched_quantity: 3,
    before_total_minor: '1897',
    expected_append_quantity: 6,
    expected_after_quantity: 8,
    expected_after_total_minor: '4643',
    expected_added_sku_quantity: 4,
    expected_new_po_count: 0,
    plan_previews: 0,
    plan_executions: 0,
    chrome_verified: false,
    provider_operations: false,
    full_goal_complete: false,
  };
  await writeFile(
    'docs/replenishment-append-native-setup-qa.json',
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify({ phase, status: report.status, own_tenant: s.tenant }));
}
try {
  const health = (await call({}, '/health')).data;
  assert.equal(health.revision, revision);
  assert.equal(health.restore_preview, false);
  const expectedSchema = process.env.QA_EXPECTED_SCHEMA;
  assert(expectedSchema && /^101_[a-z0-9_]+$/.test(expectedSchema));
  assert.equal(health.schema_revision, expectedSchema);
  assert.equal(health.replenishment_plans_available, true);
  if (phase === 'setup') {
    const suffix = randomUUID().slice(0, 8),
      s: Json = {
        stage: 120,
        runtime_revision: revision,
        schema_revision: expectedSchema,
        email: `qa120-append-${suffix}@demo.local`,
        password: `DynaQa120!${randomUUID()}`,
        setup_complete: false,
        pending: null,
        chrome_verified: false,
      };
    await save(s, true);
    const signup = await mutate(s, '/auth/signup', {
      email: s.email,
      password: s.password,
      name: 'QA120 Dopisanie do szkicu',
      organization: { name: 'QA120 Otwarte zakupy ' + suffix, currency: 'PLN', locale: 'pl-PL' },
    });
    const cookie = signup.response.headers.get('set-cookie');
    assert(cookie);
    s.cookie = cookie.split(';')[0];
    s.tenant = signup.data.user.tenant_id;
    s.user = signup.data.user.id;
    await save(s);
    const options = (await call(s, '/replenishment/options')).data;
    assert.equal(options.append_available, true);
    assert.equal(options.current_role, 'admin');
    s.warehouse = (await call(s, '/warehouses')).data.data[0];
    assert(s.warehouse?.id);
    s.product = (
      await mutate(s, '/products', {
        sku: 'QA120-A-' + suffix,
        name: 'QA120 Pozycja zwiększana',
        price: 1999,
        quantity: 5,
        warehouse_id: s.warehouse.id,
      })
    ).data;
    s.untouched = (
      await mutate(s, '/products', {
        sku: 'QA120-B-' + suffix,
        name: 'QA120 Pozycja zachowana',
        price: 2499,
        quantity: 4,
        warehouse_id: s.warehouse.id,
      })
    ).data;
    s.new_product = (
      await mutate(s, '/products', {
        sku: 'QA120-C-' + suffix,
        name: 'QA120 Nowa pozycja szkicu',
        price: 1599,
        quantity: 0,
        warehouse_id: s.warehouse.id,
      })
    ).data;
    s.reservation = (
      await mutate(s, '/orders', {
        customer_name: 'QA120 Rezerwacja',
        email: 'qa120@example.test',
        warehouse_id: s.warehouse.id,
        items: [{ product_id: s.product.id, quantity: 2 }],
      })
    ).data;
    s.supplier = (
      await mutate(s, '/suppliers', { name: 'QA120 Dostawca lokalny', code: 'QA120-' + suffix })
    ).data;
    s.target = (
      await mutate(s, '/purchase-orders', {
        supplier_id: s.supplier.id,
        warehouse_id: s.warehouse.id,
        currency: 'PLN',
        reference: 'QA120 Zachowana referencja ' + suffix,
        note: 'QA120 Nie zmieniaj tej notatki',
        expected_date: new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10),
        lines: [
          { product_id: s.product.id, quantity: 2, unit_cost: 317, supplier_sku: 'QA120-A' },
          { product_id: s.untouched.id, quantity: 3, unit_cost: 421, supplier_sku: 'QA120-B' },
        ],
      })
    ).data;
    s.policy = (
      await mutate(s, '/replenishment/policies', {
        client_key: randomUUID(),
        warehouse_id: s.warehouse.id,
        product_id: s.product.id,
        definition: {
          enabled: true,
          minimum_quantity: 6,
          target_quantity: 11,
          supplier_id: s.supplier.id,
          supplier_sku: 'QA120-A',
          currency: 'PLN',
          minimum_order_quantity: 1,
          order_multiple: 1,
          unit_cost_minor: 317,
          cost_valid_until: new Date(Date.now() + 86400000).toISOString(),
          expected_date: null,
          confirm_cost: true,
        },
      })
    ).data.policy;
    s.new_policy = (
      await mutate(s, '/replenishment/policies', {
        client_key: randomUUID(),
        warehouse_id: s.warehouse.id,
        product_id: s.new_product.id,
        definition: {
          enabled: true,
          minimum_quantity: 1,
          target_quantity: 4,
          supplier_id: s.supplier.id,
          supplier_sku: 'QA120-C',
          currency: 'PLN',
          minimum_order_quantity: 1,
          order_multiple: 1,
          unit_cost_minor: 211,
          cost_valid_until: new Date(Date.now() + 86400000).toISOString(),
          expected_date: null,
          confirm_cost: true,
        },
      })
    ).data.policy;
    await finalizeSetup(s, expectedSchema);
  } else if (phase === 'recover-setup') {
    assert.equal((await lstat(statePath)).mode & 0o077, 0);
    const s: Json = JSON.parse(await readFile(statePath, 'utf8'));
    assert(
      s.stage === 120 &&
        s.setup_complete === false &&
        !s.pending &&
        !s.accepted_checkpoint &&
        !s.accepted_evidence_sha256,
    );
    assert.equal(s.runtime_revision, revision);
    assert.equal(s.schema_revision, expectedSchema);
    for (const id of [
      s.user,
      s.tenant,
      s.warehouse?.id,
      s.product?.id,
      s.untouched?.id,
      s.new_product?.id,
      s.reservation?.id,
      s.supplier?.id,
      s.target?.id,
      s.policy?.id,
    ])
      assert(
        typeof id === 'string' && /^[a-f0-9-]{36}$/.test(id),
        'Known own fixture IDs required',
      );
    assert(
      typeof s.cookie === 'string' && typeof s.email === 'string' && typeof s.password === 'string',
    );
    const me = (await call(s, '/auth/me')).data.user;
    assert.equal(me.id, s.user);
    assert.equal(me.tenant_id, s.tenant);
    assert.equal(me.role, 'admin');
    const policies = (
      await call(
        s,
        '/replenishment/policies?' +
          new URLSearchParams({ warehouse_id: s.warehouse.id, limit: '100' }),
      )
    ).data;
    assert.equal(policies.available, true);
    assert.equal(policies.current_role, 'admin');
    assert.equal(policies.can_read_value, true);
    assert.equal(policies.data.length, 2);
    assert.equal(policies.meta.total, 2);
    assert.equal(policies.meta.cursor, null);
    const known = policies.data.filter((p: Json) => p.product_id === s.new_product.id);
    assert.equal(known.length, 1);
    const newPolicy = (await call(s, '/replenishment/policies/' + known[0].id)).data.policy;
    if (s.new_policy) assert.deepEqual(s.new_policy, newPolicy);
    else s.new_policy = newPolicy;
    const oldPolicy = (await call(s, '/replenishment/policies/' + s.policy.id)).data.policy;
    assert.deepEqual(oldPolicy, s.policy, 'Original policy changed after setup');
    verifySetupPolicy(oldPolicy, s, s.product.id, 6, 11, 317, 'QA120-A');
    verifySetupPolicy(newPolicy, s, s.new_product.id, 1, 4, 211, 'QA120-C');
    await finalizeSetup(s, expectedSchema);
  } else {
    assert.equal((await lstat(statePath)).mode & 0o077, 0);
    const s: Json = JSON.parse(await readFile(statePath, 'utf8'));
    assert(s.stage === 120 && s.setup_complete && !s.pending);
    assert.equal(s.runtime_revision, revision);
    assert.equal(s.schema_revision, expectedSchema);
    const me = (await call(s, '/auth/me')).data.user;
    assert.equal(me.id, s.user);
    assert.equal(me.tenant_id, s.tenant);
    assert.equal(me.role, 'admin');
    const c = await pool.connect();
    let checkpoint: Fingerprint = {};
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
      assert.equal(previews.length, 1);
      assert.equal(executions.length, 1);
      const p = previews[0],
        e = executions[0];
      assert.equal(e.preview_id, p.id);
      assert.equal(e.actor_id, s.user);
      assert.equal(p.actor_id, s.user);
      assert.deepEqual(p.config.draft_targets, [
        { supplier_id: s.supplier.id, currency: 'PLN', purchase_order_id: s.target.id, version: 1 },
      ]);
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
      assert.equal(rows.length, 2);
      assert.equal(erows.length, 2);
      const r = rows.find((r) => r.product_id === s.product.id)!;
      assert(r);
      const n = rows.find((r) => r.product_id === s.new_product.id)!;
      assert(n);
      assert.equal(n.status, 'purchase');
      assert.equal(n.result.recommended_quantity, '4');
      assert.equal(n.result.available, '0');
      assert.equal(n.result.projected_available, '0');
      assert.equal(n.result.line_total_minor, '844');
      assert.equal(r.status, 'purchase');
      for (const [key, value] of Object.entries({
        available: '3',
        incoming_draft_quantity: '2',
        incoming_ordered_quantity: '0',
        projected_available: '5',
        recommended_quantity: '6',
        line_total_minor: '1902',
      }))
        assert.equal(r.result[key], value);
      assert.equal(p.groups.length, 1);
      assert.equal(e.groups.length, 1);
      const d = p.groups[0].destination;
      assert.equal(d.kind, 'existing_draft');
      assert.equal(d.purchase_order_id, s.target.id);
      assert.equal(d.version, 1);
      assert.equal(d.line_count_before, 2);
      assert.equal(d.line_count_after, 3);
      assert.equal(d.total_before_minor, '1897');
      assert.equal(d.total_after_minor, '4643');
      assert.deepEqual(times(d.snapshot.head), times(s.target_before));
      assert.deepEqual(d.snapshot.lines, s.lines_before);
      assert.deepEqual(e.groups[0].destination, d);
      assert.equal(e.groups[0].purchase_order_id, s.target.id);
      assert.equal(e.groups[0].version, 2);
      for (const original of rows) {
        const copy = erows.find((er) => er.preview_row_id === original.id);
        assert(copy);
        assert.deepEqual(copy.snapshot, original.snapshot);
        assert.deepEqual(copy.result, original.result);
      }
      const current = (
        await c.query(
          'SELECT to_jsonb(p) row FROM purchase_orders p WHERE tenant_id=$1 AND id=$2',
          [s.tenant, s.target.id],
        )
      ).rows[0].row;
      assert.equal(current.version, 2);
      assert.equal(current.state, 'draft');
      assert(Date.parse(current.updated_at) >= Date.parse(s.target_before.updated_at));
      assert.deepEqual(
        { ...current, version: s.target_before.version, updated_at: s.target_before.updated_at },
        s.target_before,
      );
      const lines = (
        await c.query(
          'SELECT to_jsonb(l) row FROM purchase_order_lines l WHERE tenant_id=$1 AND order_id=$2 ORDER BY product_id',
          [s.tenant, s.target.id],
        )
      ).rows.map((r) => r.row);
      assert.equal(lines.length, 3);
      for (const original of s.lines_before) {
        const now = lines.find((l) => l.product_id === original.product_id);
        assert(now);
        assert.equal(now.quantity, original.product_id === s.product.id ? 8 : 3);
        assert.deepEqual({ ...now, quantity: original.quantity }, original);
      }
      const added = lines.find((l) => l.product_id === s.new_product.id);
      assert(added);
      assert.equal(added.quantity, 4);
      assert.equal(added.unit_cost, 211);
      assert.equal(added.supplier_sku, 'QA120-C');
      assert.equal(added.sku, s.new_product.sku);
      assert.equal(added.name, s.new_product.name);
      assert.equal(added.received_quantity, 0);
      assert.equal(added.closed_quantity, 0);
      assert.equal(
        (
          await c.query('SELECT count(*)::int n FROM purchase_orders WHERE tenant_id=$1', [
            s.tenant,
          ])
        ).rows[0].n,
        1,
      );
      assert.equal(
        (
          await c.query('SELECT count(*)::int n FROM purchase_receipts WHERE tenant_id=$1', [
            s.tenant,
          ])
        ).rows[0].n,
        0,
      );
      assert.deepEqual(
        (
          await c.query(
            'SELECT to_jsonb(t) row FROM stock t WHERE tenant_id=$1 ORDER BY product_id',
            [s.tenant],
          )
        ).rows,
        s.stock_before,
      );
      assert.deepEqual(
        (
          await c.query(
            'SELECT to_jsonb(t) row FROM reservations t WHERE tenant_id=$1 ORDER BY order_id,product_id',
            [s.tenant],
          )
        ).rows,
        s.reservations_before,
      );
      const evidenceHash = sha({ p, e, rows, erows });
      checkpoint = await snapshot(c, s);
      if (s.accepted_checkpoint) {
        assert.deepEqual(checkpoint, s.accepted_checkpoint);
        assert.equal(evidenceHash, s.accepted_evidence_sha256);
      } else {
        assert.equal(phase, 'readback', 'Initial readback required before restart');
        s.accepted_checkpoint = checkpoint;
        s.accepted_evidence_sha256 = evidenceHash;
      }
      s.preview_ids = [p.id];
      s.execution_ids = [e.id];
      await c.query('COMMIT');
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
    }
    for (const kind of ['previews', 'executions'])
      for (const id of kind === 'previews' ? s.preview_ids : s.execution_ids) {
        const result = (await call(s, `/replenishment/${kind}/${id}`)).data;
        const head = result[kind === 'previews' ? 'preview' : 'execution'];
        assert.equal(head.id, id);
        assert.equal(head.groups[0].destination.purchase_order_id, s.target.id);
        const page = (await call(s, `/replenishment/${kind}/${id}/rows?limit=100`)).data;
        assert.equal(page.current_role, 'admin');
        assert.equal(page.data.length, 2);
        assert.equal(page.meta.cursor, null);
        assert.equal(
          page.data.find((r: Json) => r.product_id === s.product.id)?.recommended_quantity,
          '6',
        );
        assert.equal(
          page.data.find((r: Json) => r.product_id === s.new_product.id)?.recommended_quantity,
          '4',
        );
      }
    const history = (await call(s, '/replenishment/executions?warehouse_id=' + s.warehouse.id))
      .data;
    assert.equal(history.data.length, 1);
    assert.equal(history.data[0].groups[0].destination.purchase_order_id, s.target.id);
    if (phase === 'restart') s.restart_verified = true;
    else s.readback_verified = true;
    if (process.env.QA_APPEND_CHROME_VERIFIED === 'true') s.chrome_verified = true;
    await save(s);
    const report = {
      status: 'PASS',
      phase,
      revision,
      schema_revision: expectedSchema,
      own_tenant: s.tenant,
      existing_target: s.target.id,
      appended_quantity: 6,
      touched_before: 2,
      touched_after: 8,
      untouched_quantity: 3,
      original_total_minor: '1897',
      final_total_minor: '4643',
      new_line_quantity: 4,
      purchase_orders: 1,
      new_purchase_orders: 0,
      metadata_preserved: true,
      stock_reservations_exact: true,
      checkpoint_tables: Object.keys(checkpoint).length,
      checkpoint_sha256: sha(checkpoint),
      immutable_evidence_sha256: s.accepted_evidence_sha256,
      chrome_verified: s.chrome_verified === true,
      provider_operations: false,
      full_goal_complete: false,
    };
    await writeFile(
      `docs/replenishment-append-native-${phase}-qa.json`,
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
