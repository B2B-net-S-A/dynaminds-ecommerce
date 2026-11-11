import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../server/app';
import { migrate, pool } from '../server/db';
import { seed } from './fixtures';
import { wmsLotsHash } from '../server/wms-lots';

assert.equal(process.env.DYNA_TEST, 'true');
assert.match(new URL(process.env.DATABASE_URL ?? '').pathname, /^\/dynaminds_test_\d+$/);
let app: Awaited<ReturnType<typeof buildApp>>,
  cookie = '',
  tenant = '',
  warehouse = '',
  user = '',
  product = '',
  layer = '';
async function ok(
  path: string,
  method: 'GET' | 'POST' = 'GET',
  payload?: Record<string, unknown>,
): Promise<Record<string, any>> {
  const response = await app.inject({
    url: '/api' + path,
    method,
    payload,
    headers: { cookie },
    remoteAddress: '127.0.124.1',
  });
  assert(
    response.statusCode >= 200 && response.statusCode < 300,
    `${method} ${path}: HTTP ${response.statusCode}`,
  );
  return response.json() as Record<string, any>;
}
before(async () => {
  await migrate();
  await seed();
  app = await buildApp({
    integrationTransport: async () => {
      throw Error('No providers in validation scope fixture');
    },
  });
  const auth = await app.inject({
    url: '/api/auth/login',
    method: 'POST',
    payload: { email: 'admin@demo.local', password: 'DynaDemo!2026' },
    remoteAddress: '127.0.124.2',
  });
  assert.equal(auth.statusCode, 200);
  cookie = String(auth.headers['set-cookie']).split(';')[0];
  user = (await pool.query("SELECT id FROM users WHERE email='admin@demo.local'")).rows[0].id;
  tenant = randomUUID();
  warehouse = randomUUID();
  await pool.query(
    "INSERT INTO tenants(id,name,plan) VALUES($1,'Validation scopes synthetic','enterprise')",
    [tenant],
  );
  await pool.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'admin')", [
    tenant,
    user,
  ]);
  await pool.query(
    "INSERT INTO warehouses(id,tenant_id,name,code) VALUES($1,$2,'Scope warehouse','VALIDATE')",
    [warehouse, tenant],
  );
  const sw = await app.inject({
    url: '/api/workspaces/switch',
    method: 'POST',
    payload: { tenant_id: tenant },
    headers: { cookie },
    remoteAddress: '127.0.124.1',
  });
  assert.equal(sw.statusCode, 200);
  cookie = String(sw.headers['set-cookie']).split(';')[0];
  const p = await ok('/products', 'POST', {
    sku: 'SCOPE-' + randomUUID(),
    name: 'Collector fixture',
    price: 100,
    warehouse_id: warehouse,
    quantity: 257,
    location: 'A-01',
  });
  product = p.id;
  const version = (
    await pool.query('SELECT version FROM stock WHERE tenant_id=$1 AND product_id=$2', [
      tenant,
      product,
    ])
  ).rows[0].version;
  const { preview } = await ok('/wms-lots/opening-previews', 'POST', {
    client_key: randomUUID(),
    policy_version: '0',
    currency: 'PLN',
    note: 'Known source for scope validation',
    lines: [
      {
        warehouse_id: warehouse,
        product_id: product,
        location: 'A-01',
        quantity: 257,
        stock_version: version,
        lot_code: 'SCOPE-LOT',
        unit_cost_minor: null,
      },
    ],
  });
  await ok('/wms-lots/opening-previews/' + preview.id + '/activate', 'POST', {
    client_key: randomUUID(),
    scope_hash: preview.scope_hash,
    confirmed: true,
    ack_unknown_costs: true,
  });
  layer = (await pool.query('SELECT id FROM wms_cost_layers WHERE tenant_id=$1', [tenant])).rows[0]
    .id;
});
after(async () => {
  try {
    await app?.close();
  } finally {
    await pool.end();
  }
});

test('many genuine bin/journal mutations enqueue exactly one quantity and one operation scope before flush', async () => {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.tenant_id',$1,true)", [tenant]);
    const operation = randomUUID();
    await c.query(
      `INSERT INTO wms_operations(id,tenant_id,actor_id,client_key,request_hash,kind,source,policy_version,request,result) VALUES($1,$2,$3,$4,$5,'bin_move','manual',1,$6,'{}')`,
      [
        operation,
        tenant,
        user,
        randomUUID(),
        wmsLotsHash({ synthetic: '256 bins' }),
        { synthetic: '256 bins' },
      ],
    );
    await c.query(
      "UPDATE stock_locations SET quantity=1 WHERE tenant_id=$1 AND product_id=$2 AND location='A-01'",
      [tenant, product],
    );
    await c.query(
      "UPDATE wms_layer_positions SET quantity=1,version=version+1 WHERE tenant_id=$1 AND product_id=$2 AND location='A-01'",
      [tenant, product],
    );
    await c.query(
      `INSERT INTO stock_locations(tenant_id,warehouse_id,product_id,location,quantity) SELECT $1,$2,$3,'B'||lpad(n::text,3,'0'),1 FROM generate_series(0,255)n`,
      [tenant, warehouse, product],
    );
    await c.query(
      `INSERT INTO wms_layer_positions(tenant_id,warehouse_id,product_id,location,layer_id,quantity) SELECT $1,$2,$3,'B'||lpad(n::text,3,'0'),$4,1 FROM generate_series(0,255)n`,
      [tenant, warehouse, product, layer],
    );
    await c.query(
      `INSERT INTO wms_layer_movements(id,tenant_id,operation_id,warehouse_id,product_id,location,layer_id,delta,value_delta,kind) VALUES(gen_random_uuid(),$1,$2,$3,$4,'A-01',$5,-256,NULL,'bin_move')`,
      [tenant, operation, warehouse, product, layer],
    );
    await c.query(
      `INSERT INTO wms_layer_movements(id,tenant_id,operation_id,warehouse_id,product_id,location,layer_id,delta,value_delta,kind) SELECT gen_random_uuid(),$1,$2,$3,$4,'B'||lpad(n::text,3,'0'),$5,1,NULL,'bin_move' FROM generate_series(0,255)n`,
      [tenant, operation, warehouse, product, layer],
    );
    assert.deepEqual(
      (
        await c.query(
          'SELECT kind,count(*)::int n FROM wms_validation_scopes WHERE transaction_id=pg_current_xact_id() GROUP BY kind ORDER BY kind',
        )
      ).rows,
      [
        { kind: 'operation', n: 1 },
        { kind: 'quantity', n: 1 },
      ],
    );
    await c.query('SET CONSTRAINTS ALL IMMEDIATE');
    assert.equal(
      (
        await c.query(
          'SELECT count(*)::int n FROM wms_validation_scopes WHERE transaction_id=pg_current_xact_id()',
        )
      ).rows[0].n,
      0,
    );
    await c.query('COMMIT');
    assert.equal(
      (
        await pool.query(
          'SELECT sum(quantity)::int n FROM wms_layer_positions WHERE tenant_id=$1',
          [tenant],
        )
      ).rows[0].n,
      257,
    );
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
});

test('IMMEDIATE evaluates a completed multirow statement, including an equal-and-opposite redistribution', async () => {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.tenant_id',$1,true)", [tenant]);
    // OFF synthetic tenant isolates the legacy invariant from the stricter WMS
    // journal checks; one statement preserves the total only after both rows.
    const other = randomUUID(),
      wh = randomUUID(),
      p = randomUUID();
    await c.query(
      "INSERT INTO tenants(id,name,plan) VALUES($1,'Immediate multirow OFF','enterprise')",
      [other],
    );
    await c.query("SELECT set_config('app.tenant_id',$1,true)", [other]);
    await c.query(
      "INSERT INTO warehouses(id,tenant_id,name,code) VALUES($1,$2,'Immediate','IMM')",
      [wh, other],
    );
    await c.query(
      "INSERT INTO products(id,tenant_id,sku,name,price) VALUES($1,$2,$3,'Immediate fixture',1)",
      [p, other, 'IMM-' + p],
    );
    await c.query(
      "INSERT INTO stock(tenant_id,warehouse_id,product_id,on_hand,reserved,location) VALUES($1,$2,$3,2,0,'A')",
      [other, wh, p],
    );
    await c.query('UPDATE stock_locations SET quantity=1 WHERE tenant_id=$1 AND product_id=$2', [
      other,
      p,
    ]);
    await c.query(
      "INSERT INTO stock_locations(tenant_id,warehouse_id,product_id,location,quantity) VALUES($1,$2,$3,'B',1)",
      [other, wh, p],
    );
    await c.query('SET CONSTRAINTS ALL IMMEDIATE');
    await c.query(
      "UPDATE stock_locations SET quantity=CASE location WHEN 'A' THEN 0 ELSE 2 END WHERE tenant_id=$1 AND product_id=$2",
      [other, p],
    );
    assert.equal(
      (
        await c.query(
          'SELECT count(*)::int n FROM wms_validation_scopes WHERE transaction_id=pg_current_xact_id()',
        )
      ).rows[0].n,
      0,
    );
    await c.query('ROLLBACK');
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
});
