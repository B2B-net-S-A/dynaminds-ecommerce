import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
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
      throw Error('Local stock ABA proof cannot contact providers');
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
async function snapshot(tenant: string) {
  const names = (
    await pool.query(
      "SELECT c.table_name FROM information_schema.columns c JOIN information_schema.tables t USING(table_schema,table_name) WHERE c.table_schema='public' AND c.column_name='tenant_id' AND t.table_type='BASE TABLE' AND c.table_name<>'sessions' ORDER BY 1",
    )
  ).rows;
  const result: Row = {};
  for (const { table_name: name } of names) {
    assert(/^[a-z][a-z0-9_]*$/.test(name));
    result[name] = (
      await pool.query(`SELECT to_jsonb(t) row FROM "${name}" t WHERE tenant_id=$1 ORDER BY 1`, [
        tenant,
      ])
    ).rows;
  }
  return result;
}

test('stock file absent-to-zero-to-absent ABA changes its durable epoch and rejects execution without any receipt or other-firm effects', async () => {
  const tenant = randomUUID(),
    main = randomUUID(),
    empty = randomUUID();
  const user = (await pool.query("SELECT id FROM users WHERE email='admin@demo.local'")).rows[0].id;
  await pool.query(
    "INSERT INTO tenants(id,name,plan) VALUES($1,'Own stock absence ABA','enterprise')",
    [tenant],
  );
  await pool.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'admin')", [
    tenant,
    user,
  ]);
  for (const [id, code] of [
    [main, 'ABA-MAIN'],
    [empty, 'ABA-EMPTY'],
  ])
    await pool.query('INSERT INTO warehouses(id,tenant_id,name,code) VALUES($1,$2,$3,$3)', [
      id,
      tenant,
      code,
    ]);
  let cookie = '';
  const req = (url: string, method: any = 'GET', payload?: any) =>
    app.inject({
      url: '/api' + url,
      method,
      payload,
      headers: { cookie },
      remoteAddress: '127.6.115.1',
    });
  const login = await req('/auth/login', 'POST', {
    email: 'admin@demo.local',
    password: 'DynaDemo!2026',
  });
  assert.equal(login.statusCode, 200);
  cookie = String(login.headers['set-cookie']).split(';')[0];
  const switched = await req('/workspaces/switch', 'POST', { tenant_id: tenant });
  assert.equal(switched.statusCode, 200);
  cookie = String(switched.headers['set-cookie']).split(';')[0];
  const created = await req('/products', 'POST', {
    name: 'Absent stock source',
    sku: 'ABA-' + randomUUID(),
    price: 2500,
    vat: 23,
    warehouse_id: main,
    quantity: 0,
    location: 'A-01',
  });
  assert.equal(created.statusCode, 201);
  const product = created.json();
  const preview = await req('/stock-file-imports/previews', 'POST', {
    client_key: randomUUID(),
    file_name: 'absence.csv',
    note: 'Explicit zero, not guessed availability',
    definition: {
      format: 'csv',
      xml_mode: 'positions',
      delimiter: ';',
      identity: 'sku',
      identity_field: 'Kod',
      spreadsheet_safe: false,
      empty_policy: 'skip',
    },
    targets: [
      {
        warehouse_id: empty,
        quantity_scope: 'position',
        mapping: { quantity: 'Stan' },
        default_location: 'A-01',
      },
    ],
    resolutions: [],
    content: `Kod;Stan\n${product.sku};0`,
  });
  assert.equal(preview.statusCode, 201, preview.body.slice(0, 500));
  const made = preview.json().preview;
  assert.equal(made.summary.invalid, 0);
  assert.equal(made.summary.changed, 0);
  const frozen = (
    await pool.query('SELECT payload FROM stock_file_import_previews WHERE id=$1', [made.id])
  ).rows[0].payload.snapshot;
  assert.deepEqual(frozen.stock, []);
  assert.deepEqual(frozen.bins, []);
  assert.deepEqual(frozen.epochs, []);
  const otherBefore = await snapshot(DEMO_TENANT);
  const owner = await pool.connect();
  try {
    await owner.query('BEGIN');
    await owner.query("SELECT set_config('app.tenant_id',$1,true)", [tenant]);
    await owner.query('SELECT purchasing_source_admit()');
    // Genuine owner fixture DML; no disabled guards or fabricated epoch writes.
    // Zero avoids a journal delta that would independently invalidate the preview.
    await owner.query(
      "INSERT INTO stock(tenant_id,warehouse_id,product_id,on_hand,reserved,location) VALUES($1,$2,$3,0,0,'A-01')",
      [tenant, empty, product.id],
    );
    assert.equal(
      (
        await owner.query(
          'SELECT count(*)::int n FROM stock_locations WHERE tenant_id=$1 AND warehouse_id=$2 AND product_id=$3',
          [tenant, empty, product.id],
        )
      ).rows[0].n,
      1,
    );
    await owner.query(
      'DELETE FROM stock_locations WHERE tenant_id=$1 AND warehouse_id=$2 AND product_id=$3',
      [tenant, empty, product.id],
    );
    await owner.query(
      'DELETE FROM stock WHERE tenant_id=$1 AND warehouse_id=$2 AND product_id=$3',
      [tenant, empty, product.id],
    );
    const actual = (
      await owner.query('SELECT stock_file_import_snapshot($1) snapshot', [
        JSON.stringify({ warehouse_ids: [empty], product_ids: [product.id] }),
      ])
    ).rows[0].snapshot;
    assert.equal(actual.epochs.length, 1);
    assert.equal(actual.epochs[0].warehouse_id, empty);
    assert.equal(actual.epochs[0].product_id, product.id);
    assert.equal(actual.epochs[0].version, '2');
    assert.deepEqual(
      { ...actual, epochs: [] },
      frozen,
      'Every visible basis and journal is exactly unchanged; the durable epoch alone detects ABA',
    );
    await owner.query('COMMIT');
  } finally {
    try {
      await owner.query('ROLLBACK');
    } finally {
      owner.release();
    }
  }
  const beforeExecute = await snapshot(tenant);
  const denied = await req(`/stock-file-imports/previews/${made.id}/execute`, 'POST', {
    client_key: randomUUID(),
    scope_hash: made.scope_hash,
    confirmed: true,
    ack_unknown_loss_warehouse_ids: [],
    ack_surplus_warehouse_ids: [],
  });
  assert.equal(denied.statusCode, 409, denied.body.slice(0, 500));
  assert.match(String(denied.headers['cache-control']), /no-store/);
  assert.deepEqual(await snapshot(tenant), beforeExecute);
  assert.deepEqual(beforeExecute.stock_file_import_executions, []);
  assert.deepEqual(beforeExecute.stock_file_import_admissions, []);
  assert.deepEqual(beforeExecute.stock_file_import_core_witnesses, []);
  assert.deepEqual(beforeExecute.inventory_bulk_edit_previews, []);
  assert.deepEqual(beforeExecute.wms_stocktakes, []);
  assert.deepEqual(await snapshot(DEMO_TENANT), otherBefore);
});
