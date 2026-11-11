/** Exercise the real SQL commit gates; no surrogate validator or disconnected ledger. */
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { buildApp } from '../server/app';
import { migrate, pool } from '../server/db';
import { seed } from './fixtures';

assert.equal(process.env.DYNA_TEST, 'true');
const database = new URL(process.env.DATABASE_URL ?? '');
assert(['localhost', '127.0.0.1', '[::1]'].includes(database.hostname));
assert.match(database.pathname, /^\/dynaminds_test_\d+$/);

let app: Awaited<ReturnType<typeof buildApp>>,
  cookie = '',
  user = '',
  ip = 1,
  calls = 0;
type Fixture = { tenant: string; warehouse: string; product: string; layer: string };
let f: Fixture;
const req = (path: string, method: any = 'GET', body?: any) =>
  app.inject({
    url: '/api' + path,
    method,
    payload: body,
    headers: { cookie },
    remoteAddress: '127.0.123.' + ip,
  });
async function ok(path: string, method: any = 'GET', body?: any) {
  const r = await req(path, method, body);
  assert(r.statusCode >= 200 && r.statusCode < 300, `${method} ${path}: HTTP ${r.statusCode}`);
  return r.json() as any;
}
before(async () => {
  await migrate();
  await seed();
  app = await buildApp({
    logging: process.env.WMS_TEST_LOG === 'true',
    integrationTransport: async () => {
      ++calls;
      throw Error('Validation scope fixtures never call providers');
    },
  });
  const r = await req('/auth/login', 'POST', {
    email: 'admin@demo.local',
    password: 'DynaDemo!2026',
  });
  assert.equal(r.statusCode, 200);
  cookie = String(r.headers['set-cookie']).split(';')[0];
  user = (await pool.query("SELECT id FROM users WHERE email='admin@demo.local'")).rows[0].id;
});
async function switchTenant(tenant: string) {
  const r = await req('/workspaces/switch', 'POST', { tenant_id: tenant });
  assert.equal(r.statusCode, 200);
  cookie = String(r.headers['set-cookie']).split(';')[0];
}
async function fixture(): Promise<Fixture> {
  const tenant = randomUUID(),
    warehouse = randomUUID();
  await pool.query(
    "INSERT INTO tenants(id,name,plan) VALUES($1,'Protected validation scopes','enterprise')",
    [tenant],
  );
  await pool.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'admin')", [
    tenant,
    user,
  ]);
  await pool.query(
    "INSERT INTO warehouses(id,tenant_id,name,code) VALUES($1,$2,'Validation warehouse','VALID')",
    [warehouse, tenant],
  );
  await switchTenant(tenant);
  const p = await ok('/products', 'POST', {
    sku: 'SCOPE-' + randomUUID(),
    name: 'Real scoped stock',
    price: 2500,
    warehouse_id: warehouse,
    quantity: 4,
    location: 'A-01',
  });
  const stock = (
    await pool.query(
      'SELECT version FROM stock WHERE tenant_id=$1 AND warehouse_id=$2 AND product_id=$3',
      [tenant, warehouse, p.id],
    )
  ).rows[0];
  const { preview } = await ok('/wms-lots/opening-previews', 'POST', {
    client_key: randomUUID(),
    policy_version: '0',
    currency: 'PLN',
    note: 'Actual opening before adversarial SQL',
    lines: [
      {
        warehouse_id: warehouse,
        product_id: p.id,
        location: 'A-01',
        quantity: 4,
        stock_version: stock.version,
        lot_code: 'SCOPE-LOT',
        unit_cost_minor: '101',
      },
    ],
  });
  assert.equal(preview.ready, true);
  await ok('/wms-lots/opening-previews/' + preview.id + '/activate', 'POST', {
    client_key: randomUUID(),
    scope_hash: preview.scope_hash,
    confirmed: true,
    ack_unknown_costs: false,
  });
  const layer = (await pool.query('SELECT id FROM wms_cost_layers WHERE tenant_id=$1', [tenant]))
    .rows;
  assert.equal(layer.length, 1);
  return { tenant, warehouse, product: p.id, layer: layer[0].id };
}
beforeEach(async () => {
  ++ip;
  calls = 0;
  f = await fixture();
});
after(async () => {
  try {
    await app?.close();
  } finally {
    await pool.end();
  }
});
const tables = [
  'stock',
  'stock_locations',
  'stock_movements',
  'stock_location_movements',
  'wms_policies',
  'wms_operations',
  'wms_lots',
  'wms_cost_layers',
  'wms_layer_positions',
  'wms_layer_movements',
  'wms_reservation_layers',
  'wms_issue_fragments',
  'wms_return_fragments',
  'orders',
  'reservations',
  'audit_events',
  'jobs',
];
async function snapshot(tenant = f.tenant) {
  const result: Record<string, unknown> = {};
  for (const table of tables)
    result[table] = (
      await pool.query(`SELECT to_jsonb(t) row FROM ${table} t WHERE tenant_id=$1 ORDER BY 1`, [
        tenant,
      ])
    ).rows;
  return result;
}
async function raw(callback: (c: PoolClient) => Promise<void>) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query("SET LOCAL statement_timeout='5000ms'");
    await c.query("SELECT set_config('app.tenant_id',$1,true)", [f.tenant]);
    await c.query('SET LOCAL ROLE dyna_app');
    await callback(c);
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
}
const integrity = (error: any) => error.code === '23514';
async function touch(c: PoolClient, product = f.product, warehouse = f.warehouse) {
  const r = await c.query(
    'UPDATE stock SET on_hand=on_hand WHERE warehouse_id=$1 AND product_id=$2 RETURNING product_id',
    [warehouse, product],
  );
  assert.equal(r.rowCount, 1);
}
async function privateCount(c: PoolClient) {
  await c.query('SET LOCAL ROLE NONE');
  const n = (
    await c.query(
      'SELECT count(*)::int n FROM wms_validation_scopes WHERE transaction_id=pg_current_xact_id()',
    )
  ).rows[0].n;
  await c.query('SET LOCAL ROLE dyna_app');
  return n as number;
}
async function emptyCollector() {
  assert.equal(
    (await pool.query('SELECT count(*)::int n FROM wms_validation_scopes')).rows[0].n,
    0,
  );
  assert.equal(calls, 0);
}

test('the validation collector is private and dyna_app cannot read, clear or manufacture pending scopes', async () => {
  const relation = (
    await pool.query(
      "SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='public.wms_validation_scopes'::regclass",
    )
  ).rows[0];
  assert.equal(relation.relrowsecurity, true);
  assert.equal(relation.relforcerowsecurity, true);
  for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) {
    assert.equal(
      (
        await pool.query(
          "SELECT has_table_privilege('dyna_app','public.wms_validation_scopes',$1) allowed",
          [privilege],
        )
      ).rows[0].allowed,
      false,
    );
  }
  for (const sql of [
    'SELECT * FROM wms_validation_scopes',
    'DELETE FROM wms_validation_scopes',
    'UPDATE wms_validation_scopes SET scope_id=scope_id',
  ]) {
    await assert.rejects(
      raw((c) => c.query(sql).then(() => undefined)),
      (e: any) => e.code === '42501',
    );
  }
  const funcs = (
    await pool.query(
      `SELECT p.oid,p.proname,has_function_privilege('dyna_app',p.oid,'EXECUTE') allowed
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'
    AND p.proname=ANY($1::text[])`,
      [
        [
          'wms_validate_quantity_scope',
          'wms_validate_operation_scope',
          'wms_enqueue_validation_scopes',
          'wms_flush_validation_scope',
        ],
      ],
    )
  ).rows;
  assert.equal(funcs.length, 4, 'All real protected collector/validator helpers must exist');
  for (const fn of funcs)
    assert.equal(
      fn.allowed,
      false,
      'Direct EXECUTE would let app callers alter the protected validation queue: ' + fn.proname,
    );
  await emptyCollector();
});

test('repeated writes coalesce one pending product scope, flush removes it, and later writes are validated again', async () => {
  const before = await snapshot();
  await raw(async (c) => {
    for (let i = 0; i < 20; ++i) await touch(c);
    assert.equal(
      await privateCount(c),
      1,
      'Quantity checks must coalesce by actual warehouse/product',
    );
    await c.query('SET CONSTRAINTS ALL IMMEDIATE');
    assert.equal(await privateCount(c), 0);
    await touch(c);
    assert.equal(
      await privateCount(c),
      0,
      'A subsequent IMMEDIATE statement is validated and cleared',
    );
    await c.query('SET CONSTRAINTS ALL DEFERRED');
    await touch(c);
    assert.equal(await privateCount(c), 1, 'Validation is not a once-per-transaction cached bit');
    await c.query('SET CONSTRAINTS ALL IMMEDIATE');
    assert.equal(await privateCount(c), 0);
  });
  assert.deepEqual(await snapshot(), before);
  await emptyCollector();
});

test('balanced raw stock, bin and layer writes still reject COMMIT without their genuine journal', async () => {
  const before = await snapshot();
  await assert.rejects(
    raw(async (c) => {
      await c.query('UPDATE stock SET on_hand=on_hand+1 WHERE warehouse_id=$1 AND product_id=$2', [
        f.warehouse,
        f.product,
      ]);
      // stock_location_reconcile has already moved A-01 to five. Keep the three
      // physical totals balanced so only the missing journal proves rejection.
      await c.query(
        "UPDATE stock_locations SET quantity=5 WHERE warehouse_id=$1 AND product_id=$2 AND location='A-01'",
        [f.warehouse, f.product],
      );
      await c.query(
        'UPDATE wms_layer_positions SET quantity=quantity+1,version=version+1 WHERE layer_id=$1',
        [f.layer],
      );
      await c.query('COMMIT');
    }),
    integrity,
  );
  assert.deepEqual(await snapshot(), before);
  await emptyCollector();
});

test('an already validated product cannot hide a later invalid raw write in the same transaction', async () => {
  const before = await snapshot();
  await assert.rejects(
    raw(async (c) => {
      await touch(c);
      await c.query('SET CONSTRAINTS ALL IMMEDIATE');
      await c.query('SET CONSTRAINTS ALL DEFERRED');
      await c.query(
        'UPDATE wms_layer_positions SET quantity=quantity+1,version=version+1 WHERE layer_id=$1',
        [f.layer],
      );
      await c.query('COMMIT');
    }),
    integrity,
  );
  assert.deepEqual(await snapshot(), before);
  await emptyCollector();
});

test('savepoint rollback preserves outer pending scopes and does not cache a failed IMMEDIATE validation', async () => {
  const before = await snapshot();
  await raw(async (c) => {
    await touch(c);
    assert.equal(await privateCount(c), 1);
    await c.query('SAVEPOINT discarded_write');
    await c.query(
      'UPDATE wms_layer_positions SET quantity=quantity+1,version=version+1 WHERE layer_id=$1',
      [f.layer],
    );
    await c.query('ROLLBACK TO SAVEPOINT discarded_write');
    assert.equal(await privateCount(c), 1);
    await c.query('SET CONSTRAINTS ALL IMMEDIATE');
    assert.equal(await privateCount(c), 0);
    await c.query('SAVEPOINT invalid_immediate');
    await assert.rejects(
      c.query(
        'UPDATE wms_layer_positions SET quantity=quantity+1,version=version+1 WHERE layer_id=$1',
        [f.layer],
      ),
      integrity,
    );
    await c.query('ROLLBACK TO SAVEPOINT invalid_immediate');
    await touch(c);
    assert.equal(await privateCount(c), 0);
    await c.query('SET CONSTRAINTS ALL DEFERRED');
    await c.query(
      'UPDATE wms_layer_positions SET quantity=quantity+1,version=version+1 WHERE layer_id=$1',
      [f.layer],
    );
    await assert.rejects(c.query('SET CONSTRAINTS ALL IMMEDIATE'), integrity);
  });
  assert.deepEqual(await snapshot(), before);
  await emptyCollector();
});

test('switching the ambient tenant cannot discard validation of an earlier actual row tenant', async () => {
  const other = await fixture();
  await switchTenant(f.tenant);
  const before = await snapshot(),
    otherBefore = await snapshot(other.tenant);
  await assert.rejects(
    raw(async (c) => {
      await c.query(
        'UPDATE wms_layer_positions SET quantity=quantity+1,version=version+1 WHERE layer_id=$1',
        [f.layer],
      );
      await c.query("SELECT set_config('app.tenant_id',$1,true)", [other.tenant]);
      await touch(c, other.product, other.warehouse);
      await c.query('COMMIT');
    }),
    integrity,
  );
  assert.deepEqual(await snapshot(), before);
  assert.deepEqual(await snapshot(other.tenant), otherBefore);
  await emptyCollector();
});

test('rolling back a completed flush restores the original dirty scope and its deferred validation event', async () => {
  const before = await snapshot();
  await assert.rejects(
    raw(async (c) => {
      await touch(c);
      assert.equal(await privateCount(c), 1);
      await c.query('SAVEPOINT discarded_flush');
      await c.query('SET CONSTRAINTS ALL IMMEDIATE');
      assert.equal(await privateCount(c), 0);
      await c.query('ROLLBACK TO SAVEPOINT discarded_flush');
      assert.equal(
        await privateCount(c),
        1,
        'Rollback must restore the earlier DELETE from the protected queue',
      );
      // The scope key already exists, so enqueue is ON CONFLICT DO NOTHING. Only
      // restoration of the original pending event can validate this final image.
      await c.query(
        'UPDATE wms_layer_positions SET quantity=quantity+1,version=version+1 WHERE layer_id=$1',
        [f.layer],
      );
      assert.equal(await privateCount(c), 1);
      await c.query('COMMIT');
    }),
    integrity,
  );
  assert.deepEqual(await snapshot(), before);
  await emptyCollector();
});

test('a transaction with an earlier successful flush still rejects a valid-FK extra fragment on a genuine issue', async () => {
  const s = (
    await pool.query(
      'SELECT version FROM stock WHERE tenant_id=$1 AND warehouse_id=$2 AND product_id=$3',
      [f.tenant, f.warehouse, f.product],
    )
  ).rows[0];
  const { preview } = await ok('/wms-lots/movement-previews', 'POST', {
    client_key: randomUUID(),
    policy_version: '1',
    kind: 'issue',
    product_id: f.product,
    warehouse_id: f.warehouse,
    location: 'A-01',
    quantity: 1,
    stock_versions: [{ warehouse_id: f.warehouse, product_id: f.product, version: s.version }],
    note: 'Real issue for late aggregate validation',
  });
  assert.equal(preview.ready, true);
  await ok('/wms-lots/movement-previews/' + preview.id + '/execute', 'POST', {
    client_key: randomUUID(),
    scope_hash: preview.scope_hash,
    confirmed: true,
  });
  const issue = (
    await pool.query('SELECT id FROM wms_issue_fragments WHERE tenant_id=$1', [f.tenant])
  ).rows;
  assert.equal(issue.length, 1);
  const before = await snapshot();
  await assert.rejects(
    raw(async (c) => {
      await touch(c);
      await c.query('SET CONSTRAINTS ALL IMMEDIATE');
      await c.query('SET CONSTRAINTS ALL DEFERRED');
      const added = await c.query(
        `INSERT INTO wms_issue_fragments(id,tenant_id,operation_id,order_id,warehouse_document_id,warehouse_id,product_id,location,layer_id,quantity,unit_cost_minor,value_minor,currency)
      SELECT $1,tenant_id,operation_id,order_id,warehouse_document_id,warehouse_id,product_id,location,layer_id,quantity,unit_cost_minor,value_minor,currency FROM wms_issue_fragments WHERE id=$2 RETURNING id`,
        [randomUUID(), issue[0].id],
      );
      assert.equal(
        added.rowCount,
        1,
        'The fragment must reach deferred validation with all genuine FKs',
      );
      await c.query('COMMIT');
    }),
    integrity,
  );
  assert.deepEqual(await snapshot(), before);
  await emptyCollector();
});

test('independent product scopes are not merged and a bad second product rolls back all first-product writes', async () => {
  const p = await ok('/products', 'POST', {
    sku: 'SCOPE-SECOND-' + randomUUID(),
    name: 'Independent physical scope',
    price: 2500,
    warehouse_id: f.warehouse,
    quantity: 0,
    location: 'A-01',
  });
  const before = await snapshot();
  await assert.rejects(
    raw(async (c) => {
      await touch(c);
      await c.query('UPDATE stock SET on_hand=1 WHERE warehouse_id=$1 AND product_id=$2', [
        f.warehouse,
        p.id,
      ]);
      assert.equal(await privateCount(c), 2);
      await c.query('COMMIT');
    }),
    integrity,
  );
  assert.deepEqual(await snapshot(), before);
  await emptyCollector();
});
