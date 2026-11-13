import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { buildApp } from '../server/app';
import { migrate, pool } from '../server/db';
import { DEMO_TENANT, seed } from './fixtures';

assert.equal(process.env.DYNA_TEST, 'true');
const database = new URL(process.env.DATABASE_URL ?? '');
assert(['localhost', '127.0.0.1', '[::1]'].includes(database.hostname));
assert.match(database.pathname, /^\/dynaminds_test_\d+$/);
type Row = Record<string, any>;
let app: Awaited<ReturnType<typeof buildApp>>;
before(async () => {
  await migrate();
  await seed();
  app = await buildApp({
    integrationTransport: async () => {
      throw Error('Physical count import cannot contact providers');
    },
  });
});
after(async () => {
  try {
    await app?.close();
  } finally {
    await pool.end();
  }
});
const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
// Like sessions, auth237_api_key_state is access telemetry: touchApiKey (server/api-key-rotation.ts) stamps
// the key's last use once a minute, and reading all 80 preview pages takes longer than that.
async function snapshot(tenant: string): Promise<Row> {
  const names = (
    await pool.query(
      "SELECT c.table_name FROM information_schema.columns c JOIN information_schema.tables t USING(table_schema,table_name) WHERE c.table_schema='public' AND c.column_name='tenant_id' AND t.table_type='BASE TABLE' AND c.table_name NOT IN('sessions','auth237_api_key_state') ORDER BY 1",
    )
  ).rows;
  const result: Row = {};
  for (const { table_name: name } of names) {
    assert(/^[a-z][a-z0-9_]*$/.test(name));
    const rows = (
      await pool.query(`SELECT to_jsonb(t) row FROM "${name}" t WHERE tenant_id=$1 ORDER BY 1`, [
        tenant,
      ])
    ).rows;
    result[name] = { count: rows.length, sha256: sha(rows) };
  }
  return result;
}

test('stock file public API executes and replays 500 source products across 8 warehouses with all 4000 rows, exact journals and isolated receipts', async () => {
  const tenant = randomUUID(),
    warehouses = Array.from({ length: 8 }, () => randomUUID()).sort(),
    products = Array.from({ length: 500 }, (_, i) => ({
      id: randomUUID(),
      sku: `CAPACITY-${String(i).padStart(3, '0')}`,
      name: `Own measured product ${i}`,
    }));
  const user = (await pool.query("SELECT id FROM users WHERE email='admin@demo.local'")).rows[0].id;
  await pool.query(
    "INSERT INTO tenants(id,name,plan) VALUES($1,'Own 500 x 8 stock counts','enterprise')",
    [tenant],
  );
  await pool.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'admin')", [
    tenant,
    user,
  ]);
  const owner = await pool.connect();
  try {
    await owner.query('BEGIN');
    // Fixture only: 4000 stock rows in one statement pass per-row warehouse policy guards (~13 ms per
    // row, 13.11.2026) and exceeded the ordinary 8 s statement_timeout on CI. The API under test keeps 8 s.
    await owner.query("SET LOCAL statement_timeout='120s'");
    await owner.query("SELECT set_config('app.tenant_id',$1,true)", [tenant]);
    await owner.query('SELECT purchasing_source_admit()');
    await owner.query(
      "INSERT INTO warehouses(id,tenant_id,name,code) SELECT id,$1,'Own capacity warehouse ' || ord,'CAP-' || ord FROM unnest($2::uuid[]) WITH ORDINALITY x(id,ord)",
      [tenant, warehouses],
    );
    await owner.query(
      'INSERT INTO products(id,tenant_id,sku,name,price,vat) SELECT id,$1,sku,name,2500,23 FROM jsonb_to_recordset($2::jsonb) x(id uuid,sku text,name text)',
      [tenant, JSON.stringify(products)],
    );
    // Synthetic starting layout, genuine stock/bin/epoch triggers and constraints remain enabled.
    await owner.query(
      "INSERT INTO stock(tenant_id,warehouse_id,product_id,on_hand,reserved,location) SELECT $1,w.id,p.id,2,0,'A-01' FROM unnest($2::uuid[]) w(id) CROSS JOIN unnest($3::uuid[]) p(id)",
      [tenant, warehouses, products.map((p) => p.id)],
    );
    await owner.query('COMMIT');
  } finally {
    try {
      await owner.query('ROLLBACK');
    } finally {
      owner.release();
    }
  }
  let cookie = '';
  const cookieRequest = (path: string, payload: Row) =>
    app.inject({
      url: '/api' + path,
      method: 'POST',
      payload,
      headers: { cookie },
      remoteAddress: '127.7.115.1',
    });
  const login = await cookieRequest('/auth/login', {
    email: 'admin@demo.local',
    password: 'DynaDemo!2026',
  });
  assert.equal(login.statusCode, 200);
  cookie = String(login.headers['set-cookie']).split(';')[0];
  const switched = await cookieRequest('/workspaces/switch', { tenant_id: tenant });
  assert.equal(switched.statusCode, 200);
  cookie = String(switched.headers['set-cookie']).split(';')[0];
  const minted = await cookieRequest('/developer/keys', {
    name: 'Own full capacity stock import',
    scopes: ['products:read', 'inventory:read', 'inventory:write'],
  });
  assert.equal(minted.statusCode, 201);
  const key = minted.json();
  assert.match(key.token, /^dyna_api_[a-f0-9]{64}$/);
  const request = async (
    path: string,
    method: any = 'GET',
    payload?: Row,
    status = 200,
  ): Promise<Row> => {
    const response = await app.inject({
      url: '/api/v1/stock-file-imports' + path,
      method,
      payload,
      headers: { authorization: 'Bearer ' + key.token },
      remoteAddress: '127.7.115.2',
    });
    assert.equal(response.statusCode, status, `${method} ${path}: ${response.body.slice(0, 500)}`);
    assert.match(String(response.headers['cache-control']), /no-store/);
    return response.json();
  };
  const ownRows = async (table: string) =>
    (
      await pool.query(`SELECT to_jsonb(t) row FROM "${table}" t WHERE tenant_id=$1 ORDER BY 1`, [
        tenant,
      ])
    ).rows;
  const otherBefore = await snapshot(DEMO_TENANT),
    originalLocations = await ownRows('stock_location_movements'),
    originalProducts = await ownRows('products'),
    originalEpochs = await ownRows('stock_file_import_epochs');
  assert.equal(originalLocations.length, 4000);
  const body = {
    client_key: randomUUID(),
    file_name: '500-products-8-warehouses.csv',
    note: 'Every physical position was measured as one',
    definition: {
      format: 'csv',
      xml_mode: 'positions',
      delimiter: ';',
      identity: 'sku',
      identity_field: 'Kod',
      spreadsheet_safe: false,
      empty_policy: 'skip',
    },
    targets: warehouses.map((warehouse_id, i) => ({
      warehouse_id,
      quantity_scope: 'position',
      mapping: { quantity: `Stan${i}` },
      default_location: 'A-01',
    })),
    resolutions: [],
    content: [
      'Kod;' + warehouses.map((_, i) => `Stan${i}`).join(';'),
      ...products.map((p) => p.sku + ';' + warehouses.map(() => '1').join(';')),
    ].join('\n'),
  };
  const made = (await request('/previews', 'POST', body, 201)).preview;
  assert.equal(made.summary.source_rows, 500);
  assert.equal(made.summary.products, 500);
  assert.equal(made.summary.positions, 4000);
  assert.equal(made.summary.changed, 4000);
  assert.equal(made.summary.invalid, 0);
  assert.equal(made.summary.conflicts, 0);
  assert.equal(made.targets.length, 8);
  for (const target of made.targets) assert.equal(target.summary.changed, 500);
  const afterPreview = await snapshot(tenant);
  assert.equal(afterPreview.stock_file_import_previews.count, 1);
  assert.equal(afterPreview.inventory_bulk_edit_previews.count, 0);
  assert.equal(afterPreview.wms_stocktakes.count, 0);
  async function allRows(kind: 'previews' | 'executions', id: string) {
    const rows: Row[] = [],
      cursors = new Set<string>();
    let cursor: string | null = null,
      pages = 0;
    do {
      const page = await request(
        `/${kind}/${id}/rows${cursor === null ? '' : '?cursor=' + cursor}`,
      );
      assert.equal(page.total, 4000);
      assert.equal(page.rows.length, 50);
      rows.push(...page.rows);
      pages++;
      assert(pages <= 80, 'No cursor cycle or extra page');
      cursor = page.next_cursor;
      if (cursor !== null) {
        assert(!cursors.has(cursor));
        cursors.add(cursor);
      }
    } while (cursor !== null);
    assert.equal(pages, 80);
    assert.deepEqual(
      rows.map((r) => r.index),
      Array.from({ length: 4000 }, (_, i) => i),
    );
    assert.equal(
      new Set(rows.map((r) => JSON.stringify([r.product_id, r.warehouse_id, r.location]))).size,
      4000,
    );
    for (const r of rows) {
      assert.equal(r.status, 'changed');
      assert.equal(r.before.quantity, 2);
      assert.equal(r.after.quantity, 1);
      assert.equal(r.input.quantity, 1);
      assert.equal(r.location, 'A-01');
      assert(products.some((p) => p.id === r.product_id));
      assert(warehouses.includes(r.warehouse_id));
    }
    return rows;
  }
  const previewRows = await allRows('previews', made.id);
  assert.deepEqual(await snapshot(tenant), afterPreview, 'All preview pages are read-only');
  const consent = {
    client_key: randomUUID(),
    scope_hash: made.scope_hash,
    confirmed: true,
    ack_unknown_loss_warehouse_ids: [],
    ack_surplus_warehouse_ids: [],
  };
  const done = (await request(`/previews/${made.id}/execute`, 'POST', consent, 201)).execution;
  assert.equal(done.preview_id, made.id);
  assert.equal(done.summary.changed, 4000);
  const executionRows = await allRows('executions', done.id);
  assert.deepEqual(
    executionRows.map((r) => [r.index, r.product_id, r.warehouse_id]),
    previewRows.map((r) => [r.index, r.product_id, r.warehouse_id]),
  );
  const stock = (await pool.query('SELECT * FROM stock WHERE tenant_id=$1', [tenant])).rows;
  assert.equal(stock.length, 4000);
  for (const s of stock) {
    assert.equal(s.on_hand, 1);
    assert.equal(s.reserved, 0);
    assert.equal(s.version, '1');
  }
  const bins = (await pool.query('SELECT * FROM stock_locations WHERE tenant_id=$1', [tenant]))
    .rows;
  assert.equal(bins.length, 4000);
  assert(bins.every((b) => b.location === 'A-01' && b.quantity === 1));
  const movements = (await pool.query('SELECT * FROM stock_movements WHERE tenant_id=$1', [tenant]))
      .rows,
    locationChanges = (
      await pool.query(
        "SELECT * FROM stock_location_movements WHERE tenant_id=$1 AND kind='count'",
        [tenant],
      )
    ).rows;
  assert.equal(movements.length, 4000);
  assert(
    movements.every((m) => m.kind === 'location_count' && m.delta === -1 && m.order_id === null),
  );
  assert.equal(locationChanges.length, 4000);
  assert(locationChanges.every((m) => m.location === 'A-01' && m.delta === -1));
  const expected = products.flatMap((p) => warehouses.map((w) => JSON.stringify([p.id, w]))).sort();
  assert.deepEqual(
    movements.map((m) => JSON.stringify([m.product_id, m.warehouse_id])).sort(),
    expected,
  );
  assert.deepEqual(
    locationChanges.map((m) => JSON.stringify([m.product_id, m.warehouse_id])).sort(),
    expected,
  );
  assert.deepEqual(
    (await ownRows('stock_location_movements')).filter((m) => m.row.kind === 'stock_in'),
    originalLocations,
  );
  assert.deepEqual(await ownRows('products'), originalProducts);
  assert.deepEqual(await ownRows('stock_file_import_epochs'), originalEpochs);
  const core = (
    await pool.query('SELECT * FROM inventory_bulk_edit_executions WHERE tenant_id=$1', [tenant])
  ).rows;
  assert.equal(core.length, 8);
  assert.deepEqual(core.map((c) => c.total).sort(), Array(8).fill(500));
  assert(core.every((c) => c.changed === 500 && c.unchanged === 0 && c.state === 'done'));
  const receipts = (
    await pool.query('SELECT * FROM inventory_bulk_edit_execution_rows WHERE tenant_id=$1', [
      tenant,
    ])
  ).rows;
  assert.equal(receipts.length, 4000);
  assert(
    receipts.every(
      (r) =>
        r.operation === 'count' &&
        r.status === 'changed' &&
        r.operation_ids.length === 1 &&
        r.before_stock_version === '0' &&
        r.after_stock_version === '1',
    ),
  );
  assert.deepEqual(
    receipts.flatMap((r) => r.operation_ids).sort(),
    locationChanges.map((m) => m.operation_id).sort(),
  );
  const completed = await snapshot(tenant);
  assert.equal(completed.stock_file_import_executions.count, 1);
  assert.equal(completed.inventory_bulk_edit_previews.count, 8);
  assert.equal(completed.inventory_bulk_edit_rows.count, 4000);
  assert.equal(completed.stock_location_operations.count, 4000);
  assert.equal(completed.wms_operations.count, 0);
  assert.equal(completed.reservations.count, 0);
  const causalTables = new Set([
    'stock',
    'stock_locations',
    'stock_movements',
    'stock_location_movements',
    'stock_location_operations',
    'purchasing_stock_changes',
    'audit_events',
    'inventory_bulk_edit_previews',
    'inventory_bulk_edit_rows',
    'inventory_bulk_edit_executions',
    'inventory_bulk_edit_execution_rows',
    'stock_file_import_executions',
    'stock_file_import_admissions',
    'stock_file_import_core_witnesses',
  ]);
  for (const name of Object.keys(afterPreview))
    if (!causalTables.has(name))
      assert.deepEqual(
        completed[name],
        afterPreview[name],
        `No unrelated own business effects in ${name}`,
      );
  const retry = await request(`/previews/${made.id}/execute`, 'POST', consent);
  assert.equal(retry.reused, true);
  assert.equal(retry.execution.id, done.id);
  assert.deepEqual(
    await snapshot(tenant),
    completed,
    'Exact whole-file replay adds no physical, audit, receipt or counter rows',
  );
  assert.deepEqual(await snapshot(DEMO_TENANT), otherBefore);
});
