import { legacySerialOrderStatusPayload } from './order-status-cas-helper';
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { buildApp } from '../server/app';
import { migrate, pool, tenantTx } from '../server/db';
import { seed } from './fixtures';
import { processB2bCatalog } from '../server/b2b-network';
import { assertB2bWholeParcelAckInTx } from '../server/b2b-dropship-ack-guard';
import { assertB2bExternalLocalRestockInTx } from '../server/b2b-external-order-intent-guards';
import { publicApiDocument } from '../server/developer-api';

assert.equal(process.env.DYNA_TEST, 'true');
const database = new URL(process.env.DATABASE_URL ?? '');
assert.match(database.pathname, /^\/dynaminds_test_\d+$/);
assert(['localhost', '127.0.0.1', '[::1]'].includes(database.hostname));
type Row = Record<string, any>;
let app: Awaited<ReturnType<typeof buildApp>>;
let buyer = '',
  supplier = '',
  buyerWarehouse = '',
  supplierWarehouse = '';
let buyerUser = '',
  supplierUser = '',
  buyerCookie = '',
  supplierCookie = '',
  viewerCookie = '';
let ip = 1,
  providerCalls = 0;
const transport = async () => {
  ++providerCalls;
  throw Error('Own external order intent safety must never contact an external provider');
};
const request = (
  path: string,
  method: any = 'GET',
  body?: any,
  auth = buyerCookie,
  target = app,
  headers: Record<string, string> = {},
) =>
  target.inject({
    url: '/api' + path,
    method,
    payload: body,
    headers: { cookie: auth, ...headers },
    remoteAddress: '127.0.187.' + ip,
  });
async function ok(path: string, method: any = 'GET', body?: any, auth = buyerCookie, target = app) {
  const r = await request(path, method, body, auth, target);
  assert(
    r.statusCode >= 200 && r.statusCode < 300,
    `${method} ${path}: ${r.statusCode} ${r.body.slice(0, 500)}`,
  );
  return r.json() as Row;
}
async function login(email: string, target = app) {
  const r = await request('/auth/login', 'POST', { email, password: 'DynaDemo!2026' }, '', target);
  assert.equal(r.statusCode, 200);
  return String(r.headers['set-cookie']).split(';')[0];
}
async function enter(email: string, tenant: string, target = app) {
  const r = await request(
    '/workspaces/switch',
    'POST',
    { tenant_id: tenant },
    await login(email, target),
    target,
  );
  assert.equal(r.statusCode, 200);
  return String(r.headers['set-cookie']).split(';')[0];
}
before(async () => {
  await migrate();
  await seed();
  app = await buildApp({
    integrationTransport: transport,
    logging: process.env.B2B_EXTERNAL_INTENT_TEST_LOG === 'true',
  });
  buyerUser = (await pool.query("SELECT id FROM users WHERE email='other@demo.local'")).rows[0].id;
  supplierUser = (await pool.query("SELECT id FROM users WHERE email='admin@demo.local'")).rows[0]
    .id;
});
beforeEach(async () => {
  ++ip;
  providerCalls = 0;
  buyer = randomUUID();
  supplier = randomUUID();
  buyerWarehouse = randomUUID();
  supplierWarehouse = randomUUID();
  for (const [tenant, user, wh, label] of [
    [buyer, buyerUser, buyerWarehouse, 'Buyer'],
    [supplier, supplierUser, supplierWarehouse, 'Supplier'],
  ]) {
    await pool.query("INSERT INTO tenants(id,name,plan) VALUES($1,$2,'enterprise')", [
      tenant,
      'Own dropshipping ' + label,
    ]);
    await pool.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'admin')", [
      tenant,
      user,
    ]);
    await pool.query('INSERT INTO warehouses(id,tenant_id,name,code) VALUES($1,$2,$3,$4)', [
      wh,
      tenant,
      label,
      label,
    ]);
  }
  await pool.query(
    "INSERT INTO memberships(tenant_id,user_id,role) SELECT $1,id,'viewer' FROM users WHERE email='viewer@demo.local'",
    [buyer],
  );
  await pool.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'admin')", [
    buyer,
    supplierUser,
  ]);
  buyerCookie = await enter('other@demo.local', buyer);
  supplierCookie = await enter('admin@demo.local', supplier);
  viewerCookie = await enter('viewer@demo.local', buyer);
});
after(async () => {
  try {
    await app?.close();
  } finally {
    await pool.end();
  }
});
async function fixture(options: { on?: boolean; missing?: boolean } = {}): Promise<Row> {
  const source = await ok(
    '/products',
    'POST',
    {
      sku: 'DS-SUP-' + randomUUID(),
      name: 'Own wholesale product',
      price: 1900,
      vat: 23,
      quantity: 30,
      warehouse_id: supplierWarehouse,
    },
    supplierCookie,
  );
  const list = await ok(
    '/price-lists',
    'POST',
    { name: 'Own wholesale list ' + randomUUID(), currency: 'PLN' },
    supplierCookie,
  );
  await ok(
    '/price-lists/' + list.id + '/items',
    'PUT',
    { version: list.version, items: [{ product_id: source.id, price: 700 }] },
    supplierCookie,
  );
  const accountBody = {
    name: 'Own purchasing firm',
    email: 'wholesale-' + randomUUID() + '@example.test',
    warehouse_id: supplierWarehouse,
    price_list_id: list.id,
    address: {
      street: 'Company warehouse 1',
      city: 'Poznań',
      postal_code: '60-001',
      country: 'PL',
    },
    min_total: 0,
    min_quantity: 1,
    quantity_step: 1,
    shipping_cost: 0,
    payment_mode: 'prepaid',
  };
  const account = await ok('/b2b/accounts', 'POST', accountBody, supplierCookie);
  const enabled = await ok(
    '/b2b/accounts/' + account.id,
    'PATCH',
    { ...accountBody, version: account.version, active: true, confirmed: true },
    supplierCookie,
  );
  const invite = await ok(
    '/b2b/accounts/' + account.id + '/network-invite',
    'POST',
    {
      version: enabled.version,
      recipient_email: 'other@demo.local',
      confirmed: true,
    },
    supplierCookie,
  );
  const link = await ok('/b2b/network/accept', 'POST', { token: invite.token, confirmed: true });
  const base = '/b2b/network/links/' + link.id;
  const run = await ok(base + '/refresh', 'POST', { client_key: randomUUID(), confirmed: true });
  for (let i = 0; i < 5; ++i) {
    const current = (await pool.query('SELECT * FROM b2b_catalog_runs WHERE id=$1', [run.id]))
      .rows[0];
    if (current.state === 'done') break;
    assert.equal(current.state, 'queued');
    const job = (
      await pool.query(
        "UPDATE jobs SET state='running',attempts=attempts+1,lease_token=$2,locked_at=now() WHERE id=$1 RETURNING *",
        [current.job_id, randomUUID()],
      )
    ).rows[0];
    await processB2bCatalog(job);
    // Complete the genuinely processed job just as the worker does; no fabricated run success.
    await pool.query(
      "UPDATE jobs SET state='done',lease_token=NULL,locked_at=NULL WHERE id=$1 AND lease_token=$2 AND state='running'",
      [job.id, job.lease_token],
    );
  }
  assert.equal(
    (await pool.query('SELECT state FROM b2b_catalog_runs WHERE id=$1', [run.id])).rows[0].state,
    'done',
  );
  const item = (await ok(base + '/catalog')).data.find(
    (i: Row) => i.source_product_id === source.id,
  );
  assert(item, 'The genuine catalog run must publish the exact supplier product');
  const imported = await ok(base + '/catalog/' + item.id + '/product', 'POST', {
    version: item.version,
    sku: 'DS-LOCAL-' + randomUUID(),
    sale_price: 2500,
    warehouse_id: buyerWarehouse,
    confirmed: true,
  });
  assert.match(imported.product_id, /^[0-9a-f-]{36}$/);
  const local = await ok('/products/' + imported.product_id);
  assert.equal(local.id, imported.product_id);
  if (options.on) {
    await enableWms(buyer, buyerCookie);
    await enableWms(supplier, supplierCookie);
  }
  // A new genuine warehouse has no stock row for this product; preserve the
  // imported product's immutable opening movement in its original warehouse.
  const warehouse = options.missing
    ? await ok('/warehouses', 'POST', {
        name: 'Own empty warehouse ' + randomUUID(),
        code: 'EMPTY-' + randomUUID().slice(0, 8),
      })
    : { id: buyerWarehouse };
  return {
    source,
    list,
    account: enabled,
    link,
    item,
    local,
    warehouse,
    base,
    path: base + '/dropshipping',
  };
}
function quoteBody(f: Row, quantity = 2, extra: Row = {}) {
  assert(f.order.items.length);
  return {
    client_key: randomUUID(),
    customer_order_id: f.order.id,
    fulfillment_basis: 'external_intent',
    intent_version: f.intent.version,
    items: [
      {
        customer_item_id: f.order.items[0].id,
        quantity,
        mappings: [{ product_id: f.local.id, catalog_item_id: f.item.id }],
      },
    ],
    ...extra,
  };
}
async function quote(f: Row, body = quoteBody(f), token?: string) {
  const r = token
    ? await publicRequest(token, f.path + '/quotes', 'POST', body)
    : await request(f.path + '/quotes', 'POST', body);
  assert.equal(r.statusCode, 201, `${r.statusCode}: ${r.body.slice(0, 500)}`);
  return r.json().quote as Row;
}
const consent = (q: Row, client_key = randomUUID()) => ({
  client_key,
  scope_hash: q.scope_hash,
  confirmed: true,
  confirmed_receiver: true,
});
const readScopes = ['products:read', 'inventory:read', 'orders:read', 'purchasing:read'];
const writeScopes = [...readScopes, 'inventory:write', 'orders:write', 'purchasing:write'];
const publicRequest = (token: string, path: string, method: any = 'GET', body?: any) =>
  request('/v1' + path, method, body, '', app, {
    authorization: 'Bearer ' + token,
    'X-Workspace-ID': buyer,
  });
async function key(scopes = writeScopes) {
  return ok('/developer/keys', 'POST', { name: 'Own dropshipping safety', scopes });
}
async function checkout(f: Row, q: Row, body = consent(q), token?: string) {
  const r = token
    ? await publicRequest(token, f.path + '/quotes/' + q.id + '/checkout', 'POST', body)
    : await request(f.path + '/quotes/' + q.id + '/checkout', 'POST', body);
  assert.equal(r.statusCode, 201, `${r.statusCode}: ${r.body.slice(0, 500)}`);
  return r.json().order as Row;
}
async function snapshot(tenants = [buyer, supplier]) {
  const names = (
    await pool.query(`SELECT DISTINCT c.table_name FROM information_schema.columns c
    JOIN information_schema.tables t USING(table_schema,table_name)
    WHERE c.table_schema='public' AND c.column_name='tenant_id' AND t.table_type='BASE TABLE'
    AND c.table_name NOT IN ('memberships','api_keys','outbound_subscriptions','sessions') ORDER BY 1`)
  ).rows;
  const result: Row = {};
  for (const { table_name: name } of names) {
    assert.match(name, /^[a-z][a-z0-9_]*$/);
    const rows = (
      await pool.query(
        `SELECT to_jsonb(t) row FROM "${name}" t WHERE tenant_id=ANY($1::uuid[]) ORDER BY 1`,
        [tenants],
      )
    ).rows;
    result[name] = createHash('sha256').update(JSON.stringify(rows)).digest('hex');
  }
  return result;
}
async function waitOn(holder: PoolClient, pattern: RegExp) {
  const pid = (await holder.query('SELECT pg_backend_pid() pid')).rows[0].pid;
  const until = Date.now() + 3500;
  while (Date.now() < until) {
    const waits = (
      await pool.query(
        "SELECT query FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND $1=ANY(pg_blocking_pids(pid))",
        [pid],
      )
    ).rows;
    if (waits.some((r) => pattern.test(r.query))) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('The actual dropshipping request did not reach the held database lock');
}
async function grantChange(sql: string, parameters: unknown[]) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query("SET LOCAL statement_timeout='1500ms'");
    await c.query(sql, parameters);
    await c.query('COMMIT');
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
}
async function enableWms(tenant: string, auth: string) {
  const bins = (
    await pool.query(
      'SELECT b.warehouse_id,b.product_id,b.location,b.quantity,s.version::text stock_version FROM stock_locations b JOIN stock s USING(tenant_id,warehouse_id,product_id) WHERE b.tenant_id=$1 AND b.quantity>0 ORDER BY b.product_id,b.location',
      [tenant],
    )
  ).rows;
  const { preview } = await ok(
    '/wms-lots/opening-previews',
    'POST',
    {
      client_key: randomUUID(),
      policy_version: '0',
      currency: 'PLN',
      note: 'Own external-intent safety opening',
      lines: bins.map((b) => ({ ...b, lot_code: 'INTENT-' + b.location, unit_cost_minor: '1379' })),
    },
    auth,
  );
  assert.equal(preview.ready, true);
  await ok(
    '/wms-lots/opening-previews/' + preview.id + '/activate',
    'POST',
    {
      client_key: randomUUID(),
      scope_hash: preview.scope_hash,
      confirmed: true,
      ack_unknown_costs: false,
    },
    auth,
  );
}

const intentPath = '/b2b/external-order-intents';
function intentBody(f: Row, quantity = 3, allocation: Row = {}) {
  const itemId = randomUUID();
  return {
    client_key: randomUUID(),
    order: {
      customer_name: 'Own external-only customer',
      email: 'external-intent@example.test',
      address: {
        street: 'External customer 127',
        city: 'Gdańsk',
        postal_code: '80-001',
        country: 'PL',
        phone: '555000127',
      },
      warehouse_id: f.warehouse.id,
      currency: 'PLN',
      payment_mode: 'cod',
      items: [{ customer_item_id: itemId, product_id: f.local.id, quantity }],
    },
    allocations: [
      {
        customer_item_id: itemId,
        local_quantity: 0,
        external_quantity: quantity,
        unassigned_quantity: 0,
        link_id: f.link.id,
        ...allocation,
      },
    ],
  };
}
function commercialExpectation(
  body: Row,
  product: Row,
  components = [{ product_id: product.id, quantity: 1 }],
) {
  return {
    total: body.order.items.reduce(
      (sum: number, item: Row) => sum + product.price * item.quantity,
      0,
    ),
    currency: 'PLN',
    items: body.order.items.map((item: Row) => ({
      customer_item_id: item.customer_item_id,
      product_id: item.product_id,
      quantity: item.quantity,
      price: product.price,
      vat: product.vat,
      product_version: String(product.version),
      components,
    })),
  };
}
async function createIntent(f: Row, body: Row = intentBody(f), token?: string) {
  const response = token
    ? await publicRequest(token, intentPath + '/orders', 'POST', body)
    : await request(intentPath + '/orders', 'POST', body);
  assert.equal(response.statusCode, 201, response.body.slice(0, 500));
  const result = response.json() as Row;
  assert(result.intent?.id && result.order?.id);
  assert.equal(result.order.items.length, body.order.items.length);
  assert.deepEqual(
    new Set(result.order.items.map((i: Row) => i.id)),
    new Set(body.order.items.map((i: Row) => i.customer_item_id)),
  );
  f.order = result.order;
  f.intent = result.intent;
  return result;
}
async function physicalSnapshot(tenant = buyer) {
  const result: Row = {};
  for (const name of [
    'stock',
    'stock_locations',
    'reservations',
    'reservation_locations',
    'order_pick_items',
    'wms_lots',
    'wms_cost_layers',
    'wms_layer_positions',
    'wms_reservation_layers',
    'wms_layer_movements',
    'wms_issue_fragments',
    'wms_return_fragments',
    'stock_movements',
    'warehouse_documents',
    'warehouse_document_lines',
    'payment_entries',
    'shipments',
  ]) {
    result[name] = (
      await pool.query(`SELECT to_jsonb(t) row FROM "${name}" t WHERE tenant_id=$1 ORDER BY 1`, [
        tenant,
      ])
    ).rows;
  }
  return result;
}

for (const on of [false, true]) {
  test(`external-intent creation rechecks current admin after a genuine product wait and rolls back all evidence (${on ? 'WMS ON' : 'WMS OFF'})`, async () => {
    const f = await fixture({ on }),
      body = intentBody(f),
      before = await snapshot(),
      physical = await physicalSnapshot();
    const holder = await pool.connect();
    let pending: ReturnType<typeof request> | undefined;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM products WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [
        buyer,
        f.local.id,
      ]);
      pending = request(intentPath + '/orders', 'POST', body);
      await waitOn(holder, /products/i);
      await grantChange(
        "UPDATE memberships SET role='operator' WHERE tenant_id=$1 AND user_id=$2",
        [buyer, buyerUser],
      );
      await holder.query('ROLLBACK');
      const refused = await pending;
      assert.equal(refused.statusCode, 403);
      assert.match(String(refused.headers['cache-control']), /no-store/);
      assert.deepEqual(await snapshot(), before);
      assert.deepEqual(await physicalSnapshot(), physical);
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
      if (pending) await pending;
      await pool.query("UPDATE memberships SET role='admin' WHERE tenant_id=$1 AND user_id=$2", [
        buyer,
        buyerUser,
      ]);
    }
    await createIntent(f, body);
    assert.deepEqual(
      await physicalSnapshot(),
      physical,
      'Successful external-only create also has no physical or payment effect',
    );
    assert.equal(providerCalls, 0);
  });
}

for (const on of [false, true]) {
  test(`external-intent initial fields do not pin membership before a genuine later intent INSERT wait (${on ? 'WMS ON' : 'WMS OFF'})`, async () => {
    const f = await fixture({ on });
    const field = await ok('/order-fields', 'POST', {
      client_key: randomUUID(),
      key: 'late_' + randomUUID().replaceAll('-', ''),
      label: 'Own initial field before later intent wait',
      type: 'text',
    });
    const body: Row = intentBody(f);
    body.order.initial_fields = [
      {
        field_id: field.id,
        definition_version: field.version,
        type: 'text',
        value: 'This value must roll back after late withdrawal',
      },
    ];
    const before = await snapshot(),
      physical = await physicalSnapshot();
    const holder = await pool.connect();
    let pending: ReturnType<typeof request> | undefined;
    try {
      await holder.query('BEGIN');
      // SHARE permits the earlier detail SELECT but blocks the later INSERT,
      // after createOrder has actually written initial field evidence.
      await holder.query('LOCK TABLE b2b_external_order_intents IN SHARE MODE');
      pending = request(intentPath + '/orders', 'POST', body);
      await waitOn(holder, /INSERT INTO b2b_external_order_intents/i);
      await grantChange(
        "UPDATE memberships SET role='operator' WHERE tenant_id=$1 AND user_id=$2",
        [buyer, buyerUser],
      );
      await holder.query('ROLLBACK');
      const refused = await pending;
      assert.equal(refused.statusCode, 403, refused.body);
      assert.deepEqual(await snapshot(), before);
      assert.deepEqual(await physicalSnapshot(), physical);
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
      if (pending) await pending;
      await pool.query("UPDATE memberships SET role='admin' WHERE tenant_id=$1 AND user_id=$2", [
        buyer,
        buyerUser,
      ]);
    }
    const accepted = await createIntent(f, body);
    assert.equal(accepted.order.id, f.order.id);
    assert.equal(
      (await ok('/orders/' + f.order.id + '/fields')).data.find(
        (v: Row) => v.definition.id === field.id,
      )?.value.value,
      body.order.initial_fields[0].value,
    );
    assert.equal(providerCalls, 0);
  });
}

test('intent evidence forces tenant RLS and private proof isolation; raw incomplete, foreign and immutable writes cannot commit', async () => {
  const f = await fixture();
  await createIntent(f);
  const before = await snapshot();
  const tables = [
    'b2b_external_order_intents',
    'b2b_external_order_intent_revisions',
    'b2b_external_order_allocation_proofs',
    'b2b_external_order_created_orders',
  ];
  for (const table of tables)
    assert.deepEqual(
      (
        await pool.query(
          'SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid=$1::regclass',
          ['public.' + table],
        )
      ).rows[0],
      { relrowsecurity: true, relforcerowsecurity: true },
      table,
    );
  assert.equal(
    (await request(intentPath + '/orders/' + f.order.id, 'GET', undefined, supplierCookie))
      .statusCode,
    404,
  );
  const revision = (
    await pool.query(
      'SELECT * FROM b2b_external_order_intent_revisions WHERE tenant_id=$1 AND intent_id=$2',
      [buyer, f.intent.id],
    )
  ).rows[0];
  assert(revision && revision.kind === 'create');
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE dyna_app');
    await c.query("SELECT set_config('app.tenant_id',$1,true)", [supplier]);
    for (const table of tables.slice(0, 2))
      assert.equal(
        (await c.query(`SELECT count(*)::int n FROM ${table} WHERE tenant_id=$1`, [buyer])).rows[0]
          .n,
        0,
        table,
      );
    for (const table of tables.slice(2)) {
      await c.query('SAVEPOINT private_proof');
      await assert.rejects(c.query(`SELECT 1 FROM ${table} LIMIT 1`), { code: '42501' });
      await c.query('ROLLBACK TO SAVEPOINT private_proof');
      assert.equal(
        (
          await pool.query(
            "SELECT has_table_privilege('dyna_app',$1,'SELECT,INSERT,UPDATE,DELETE') allowed",
            ['public.' + table],
          )
        ).rows[0].allowed,
        false,
      );
    }
    // A genuine existing buyer intent is not a supplier-scoped parent. The
    // missing-own-parent branch must retain the real composite foreign key.
    await assert.rejects(
      c.query(
        `INSERT INTO b2b_external_order_intent_revisions(tenant_id,id,intent_id,actor_id,client_key,request_hash,request,kind,version,before_snapshot,after_snapshot)
      VALUES($1,$2,$3,$4,$5,$6,$7,'create',1,NULL,$8)`,
        [
          supplier,
          randomUUID(),
          f.intent.id,
          supplierUser,
          randomUUID(),
          revision.request_hash,
          revision.request,
          revision.after_snapshot,
        ],
      ),
      { code: '23503' },
    );
    await c.query('ROLLBACK');
    for (const sql of [
      'DELETE FROM b2b_external_order_intents WHERE tenant_id=$1',
      'DELETE FROM b2b_external_order_intent_revisions WHERE tenant_id=$1',
      "UPDATE b2b_external_order_intent_revisions SET after_snapshot='{}'::jsonb WHERE tenant_id=$1",
      "UPDATE b2b_external_order_intents SET initial_request='{}'::jsonb,version=version+1 WHERE tenant_id=$1",
      "UPDATE b2b_external_order_intents SET allocations=jsonb_set(allocations,'{0}',(allocations->0)-'external_quantity'),version=version+1 WHERE tenant_id=$1",
    ]) {
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.tenant_id',$1,true)", [buyer]);
      await assert.rejects(c.query(sql, [buyer]), { code: '23514' });
      await c.query('ROLLBACK');
    }
    // A superficially valid next version without its immutable revision must
    // fail deferred completeness at COMMIT, rolling back the actual head.
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE dyna_app');
    await c.query("SELECT set_config('app.tenant_id',$1,true)", [buyer]);
    await c.query(
      'UPDATE b2b_external_order_intents SET version=version+1 WHERE tenant_id=$1 AND id=$2',
      [buyer, f.intent.id],
    );
    await assert.rejects(c.query('COMMIT'), { code: '23514' });
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
  assert.deepEqual(await snapshot(), before);
  assert.equal(providerCalls, 0);
});

test('readonly intent reads work while every malformed mutation is rejected before parsing; missing module fails closed without breaking old catalog reads', async () => {
  const f = await fixture();
  await createIntent(f);
  const readonly = await buildApp({
    readOnly: true,
    previewPort: 4168,
    integrationTransport: transport,
  });
  try {
    const auth = await enter('other@demo.local', buyer, readonly),
      before = await snapshot();
    const options = await ok(intentPath + '/options', 'GET', undefined, auth, readonly);
    assert.equal(options.read_only, true);
    assert.equal(options.can_manage, false);
    const detail = await ok(intentPath + '/orders/' + f.order.id, 'GET', undefined, auth, readonly);
    assert.equal(detail.intent.id, f.intent.id);
    for (const path of [
      intentPath + '/orders',
      ...['allocate', 'cancel', 'reopen'].map(
        (action) => intentPath + '/orders/' + f.order.id + '/' + action,
      ),
    ]) {
      const r = await request(path, 'POST', '{', auth, readonly, {
        'content-type': 'application/json',
      });
      assert.equal(r.statusCode, 423, path);
      assert.match(String(r.headers['cache-control']), /no-store/);
    }
    assert.deepEqual(await snapshot(), before);
  } finally {
    await readonly.close();
  }
  const localProduct = await ok('/products', 'POST', {
    sku: 'OWN-TORN-HISTORY-' + randomUUID(),
    name: 'Own ordinary restock source',
    price: 1000,
    vat: 23,
    quantity: 1,
    warehouse_id: buyerWarehouse,
  });
  const ordinary = await ok('/orders', 'POST', {
    customer_name: 'Own ordinary source',
    email: 'own-ordinary-torn@example.test',
    warehouse_id: buyerWarehouse,
    payment_mode: 'cod',
    items: [{ product_id: localProduct.id, quantity: 1 }],
  });
  const before = await snapshot();
  // The no-intent legacy branch must distinguish true pre108 absence from a
  // damaged installed108 history, rather than admitting a phantom restock.
  await pool.query('ALTER TABLE b2b_dropship_orders RENAME TO b2b_dropship_orders_safety_hidden');
  try {
    await assert.rejects(
      tenantTx(buyer, (c) =>
        assertB2bExternalLocalRestockInTx(c, ordinary.id, ordinary.items[0].id, 1),
      ),
      { status: 503 },
    );
  } finally {
    await pool.query('ALTER TABLE b2b_dropship_orders_safety_hidden RENAME TO b2b_dropship_orders');
  }
  assert.deepEqual(await snapshot(), before);
  // Existing durable intent history must stay closed if a required helper is
  // unavailable. Full module capability=false is not permission to ignore it.
  await pool.query(
    'ALTER FUNCTION b2b_external_intent_complete() RENAME TO b2b_external_intent_complete_safety_hidden',
  );
  try {
    await assert.rejects(
      tenantTx(buyer, (c) => assertB2bWholeParcelAckInTx(c, f.order.id)),
      { status: 503 },
    );
    assert.deepEqual(await snapshot(), before);
  } finally {
    await pool.query(
      'ALTER FUNCTION b2b_external_intent_complete_safety_hidden() RENAME TO b2b_external_intent_complete',
    );
  }
  await pool.query(
    'ALTER TABLE b2b_external_order_intents RENAME TO b2b_external_order_intents_safety_hidden',
  );
  let legacy: Awaited<ReturnType<typeof buildApp>> | undefined;
  try {
    legacy = await buildApp({ integrationTransport: transport });
    const options = await ok(intentPath + '/options', 'GET', undefined, buyerCookie, legacy);
    assert.equal(options.available, false);
    assert.equal(options.can_manage, false);
    const r = await request(intentPath + '/orders', 'POST', intentBody(f), buyerCookie, legacy);
    assert.equal(r.statusCode, 503, r.body);
    assert.match(String(r.headers['cache-control']), /no-store/);
    assert.equal(
      (await request(f.base + '/catalog', 'GET', undefined, buyerCookie, legacy)).statusCode,
      200,
    );
    assert.equal(
      (await request('/products', 'GET', undefined, buyerCookie, legacy)).statusCode,
      200,
    );
  } finally {
    try {
      await legacy?.close();
    } finally {
      await pool.query(
        'ALTER TABLE b2b_external_order_intents_safety_hidden RENAME TO b2b_external_order_intents',
      );
    }
  }
  assert.deepEqual(await snapshot(), before);
  assert.equal(providerCalls, 0);
});

test('new external-intent create observes API revoke, expiry and lost compound or initial-field scope after actual product lock waits', async () => {
  const f = await fixture();
  const field = await ok('/order-fields', 'POST', {
    client_key: randomUUID(),
    key: 'wait_' + randomUUID().replaceAll('-', ''),
    label: 'Own fresh field grant',
    type: 'text',
  });
  for (const mode of ['revoke', 'expiry', 'scope', 'field-scope'] as const) {
    const scopes =
      mode === 'field-scope'
        ? [...writeScopes, 'order-fields:read', 'order-fields:write']
        : writeScopes;
    const credential = await key(scopes),
      body: Row = intentBody(f),
      before = await snapshot(),
      holder = await pool.connect();
    if (mode === 'field-scope')
      body.order.initial_fields = [
        {
          field_id: field.id,
          definition_version: field.version,
          type: 'text',
          value: 'Own field grant withdrawn while blocked',
        },
      ];
    let pending: ReturnType<typeof publicRequest> | undefined;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM products WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [
        buyer,
        f.local.id,
      ]);
      pending = publicRequest(credential.token, intentPath + '/orders', 'POST', body);
      await waitOn(holder, /products/i);
      await grantChange(
        mode === 'revoke'
          ? 'UPDATE api_keys SET revoked_at=now() WHERE id=$1'
          : mode === 'expiry'
            ? "UPDATE api_keys SET expires_at=now()-interval '1 second' WHERE id=$1"
            : 'UPDATE api_keys SET scopes=$2::text[] WHERE id=$1',
        mode === 'scope' || mode === 'field-scope'
          ? [
              credential.id,
              scopes.filter(
                (s) => s !== (mode === 'field-scope' ? 'order-fields:write' : 'inventory:write'),
              ),
            ]
          : [credential.id],
      );
      await holder.query('ROLLBACK');
      const refused = await pending;
      assert.equal(
        refused.statusCode,
        mode === 'scope' || mode === 'field-scope' ? 403 : 401,
        mode,
      );
      assert.match(String(refused.headers['cache-control']), /no-store/);
      assert.deepEqual(await snapshot(), before);
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
      if (pending) await pending;
    }
  }
  assert.equal(providerCalls, 0);
});

test('missing and zero stock do not become phantom reservations; ordinary local create and empty packing remain blocked', async () => {
  for (const missing of [false, true]) {
    const f = await fixture({ missing }),
      body = intentBody(f),
      before = await snapshot(),
      physical = await physicalSnapshot();
    assert.equal(
      (
        await pool.query(
          'SELECT count(*)::int n FROM stock WHERE tenant_id=$1 AND product_id=$2 AND warehouse_id=$3',
          [buyer, f.local.id, f.warehouse.id],
        )
      ).rows[0].n,
      missing ? 0 : 1,
    );
    const ordinary = {
      ...body.order,
      items: body.order.items.map((i) => ({ product_id: i.product_id, quantity: i.quantity })),
    };
    assert.equal((await request('/orders', 'POST', ordinary)).statusCode, missing ? 404 : 409);
    assert.deepEqual(await snapshot(), before);
    await createIntent(f, body);
    assert.deepEqual(await physicalSnapshot(), physical);
    await ok('/orders/' + f.order.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => ok(orderPath, 'GET', undefined), '/orders/' + f.order.id + '/status', { status: 'picking' }));
    const refusedPackedPayload = await legacySerialOrderStatusPayload((orderPath) => ok(orderPath), '/orders/' + f.order.id + '/status', { status: 'packed' });
    const pickingBefore = await snapshot();
    for (const [path, method, payload] of [
      ['/orders/' + f.order.id + '/status', 'PATCH', refusedPackedPayload],
      ['/orders/' + f.order.id + '/scan', 'POST', { code: f.local.sku }],
      ['/orders/' + f.order.id + '/ship-demo', 'POST', {}],
    ] as const) {
      const refused = await request(path, method, payload);
      assert.equal(refused.statusCode, 409, path);
      assert.deepEqual(await snapshot(), pickingBefore);
    }
    await assert.rejects(
      tenantTx(buyer, (c) => assertB2bWholeParcelAckInTx(c, f.order.id)),
      { status: 409 },
    );
    assert.deepEqual(await snapshot(), pickingBefore);
    assert.deepEqual(await physicalSnapshot(), physical);
  }
  assert.equal(providerCalls, 0);
});

test('public create/detail and OpenAPI expose typed intents with compound read grants and preserve additional-field write authorization', async () => {
  const f = await fixture(),
    full = await key(),
    read = await key(readScopes),
    missingProducts = await key(writeScopes.filter((s) => s !== 'products:read'));
  const field = await ok('/order-fields', 'POST', {
    client_key: randomUUID(),
    key: 'intent_' + randomUUID().replaceAll('-', ''),
    label: 'Own intent context',
    type: 'text',
  });
  const fieldBody: Row = intentBody(f);
  fieldBody.expected_commercial_snapshot = commercialExpectation(fieldBody, f.local);
  fieldBody.order.initial_fields = [
    {
      field_id: field.id,
      definition_version: field.version,
      type: 'text',
      value: 'Own field value',
    },
  ];
  const before = await snapshot();
  for (const [credential, body] of [
    [missingProducts, intentBody(f)],
    [full, fieldBody],
  ] as const) {
    const denied = await publicRequest(credential.token, intentPath + '/orders', 'POST', body);
    assert.equal(denied.statusCode, 403);
    assert.deepEqual(await snapshot(), before);
  }
  const withFields = await key([...writeScopes, 'order-fields:read', 'order-fields:write']);
  const created = await createIntent(f, fieldBody, withFields.token),
    accepted = await snapshot();
  const detail = await publicRequest(read.token, intentPath + '/orders/' + created.order.id);
  assert.equal(detail.statusCode, 200, detail.body);
  assert.equal(detail.json().order.id, created.order.id);
  assert.equal(detail.json().can_manage, false);
  assert.equal(
    (await publicRequest(missingProducts.token, intentPath + '/orders/' + created.order.id))
      .statusCode,
    403,
  );
  assert.deepEqual(await snapshot(), accepted);
  const document = (await ok('/v1/openapi')) as Row;
  for (const [path, method] of [
    [intentPath + '/options', 'get'],
    [intentPath + '/orders', 'get'],
    [intentPath + '/orders', 'post'],
    [intentPath + '/orders/{id}', 'get'],
  ] as const) {
    const operation = document.paths[path]?.[method];
    assert(operation, `Actual OpenAPI registers ${method} ${path}`);
    for (const scope of readScopes) assert(operation['x-required-scopes'].includes(scope), scope);
  }
  const schema =
    document.paths[intentPath + '/orders'].post.requestBody.content['application/json'].schema;
  assert.equal(schema.additionalProperties, false);
  assert(schema.properties.order && schema.properties.allocations);
  assert(!Object.hasOwn(schema.properties, 'allow_negative_stock'));
  const readonlyDocument = publicApiDocument({ readOnly: true }) as Row;
  assert(!readonlyDocument.paths[intentPath + '/orders']?.post);
  // Actual server product mutations occur after approval; the failed create
  // must roll back its provisional commerce, identity, events and intent proof.
  for (const mode of ['price', 'vat', 'version'] as const) {
    const product = await ok('/products/' + f.local.id),
      stale: Row = intentBody(f);
    stale.expected_commercial_snapshot = commercialExpectation(stale, product);
    await ok('/products/' + product.id, 'PATCH', {
      ...product,
      components: [],
      ...(mode === 'price'
        ? { price: product.price + 100 }
        : mode === 'vat'
          ? { vat: 8 }
          : { name: product.name + ' version changed' }),
    });
    const beforeDrift = await snapshot();
    const refused = await publicRequest(withFields.token, intentPath + '/orders', 'POST', stale);
    assert.equal(refused.statusCode, 409, mode + ': ' + refused.body);
    assert.deepEqual(await snapshot(), beforeDrift);
  }
  const bundle = await ok('/products', 'POST', {
    sku: 'OWN-INTENT-RECIPE-' + randomUUID(),
    name: 'Own intent recipe CAS',
    price: 9900,
    vat: 23,
    warehouse_id: buyerWarehouse,
    quantity: 0,
    kind: 'bundle',
    components: [{ product_id: f.local.id, quantity: 1 }],
  });
  const staleRecipe: Row = intentBody({ ...f, local: bundle });
  staleRecipe.expected_commercial_snapshot = commercialExpectation(staleRecipe, bundle, [
    { product_id: f.local.id, quantity: 1 },
  ]);
  await ok('/products/' + bundle.id, 'PATCH', {
    ...bundle,
    components: [{ product_id: f.local.id, quantity: 2 }],
  });
  const beforeRecipe = await snapshot();
  const recipeRefused = await publicRequest(
    withFields.token,
    intentPath + '/orders',
    'POST',
    staleRecipe,
  );
  assert.equal(recipeRefused.statusCode, 409, recipeRefused.body);
  assert.deepEqual(await snapshot(), beforeRecipe);
  assert.equal(providerCalls, 0);
});

test('foreign physical identity, unconserved allocation and local fallback cannot bypass zero-stock admission or exact create replay', async () => {
  const f = await fixture(),
    body = intentBody(f),
    before = await snapshot();
  for (const [payload, status] of [
    [{ ...body, allow_negative_stock: true }, 422],
    [{ ...body, order: { ...body.order, skip_reservation: true } }, 422],
    [{ ...body, allocations: body.allocations.map((a) => ({ ...a, external_quantity: 4 })) }, 422],
    [
      {
        ...body,
        order: {
          ...body.order,
          items: body.order.items.map((i) => ({ ...i, product_id: f.source.id })),
        },
      },
      404,
    ],
  ] as const) {
    const refused = await request(intentPath + '/orders', 'POST', payload);
    assert.equal(refused.statusCode, status);
    assert.deepEqual(await snapshot(), before);
  }
  const created = await createIntent(f, body),
    accepted = await snapshot();
  const sameKeyOtherBody = {
    ...body,
    order: { ...body.order, note: 'A different economic request' },
  };
  assert.equal((await request(intentPath + '/orders', 'POST', sameKeyOtherBody)).statusCode, 409);
  const otherAdmin = await enter('admin@demo.local', buyer);
  assert.equal((await request(intentPath + '/orders', 'POST', body, otherAdmin)).statusCode, 409);
  assert.deepEqual(await snapshot(), accepted);
  const replay = await request(
    intentPath + '/orders',
    'POST',
    Object.fromEntries(Object.entries(body).reverse()),
  );
  assert.equal(replay.statusCode, 200, replay.body);
  assert.equal(replay.json().reused, true);
  assert.equal(replay.json().order.id, created.order.id);
  assert.deepEqual(await snapshot(), accepted);
  const allocation = {
    client_key: randomUUID(),
    version: created.intent.version,
    confirmed: true,
    allocations: body.allocations.map((a) => ({ ...a, local_quantity: 1, external_quantity: 2 })),
  };
  const noLocal = await request(
    intentPath + '/orders/' + created.order.id + '/allocate',
    'POST',
    allocation,
  );
  assert.equal(noLocal.statusCode, 409, noLocal.body);
  assert.deepEqual(await snapshot(), accepted);
  assert.equal(providerCalls, 0);
});

for (const on of [false, true]) {
  test(`external-only RMA cannot manufacture buyer restock, while genuine non-restock acceptance remains available (${on ? 'WMS ON' : 'WMS OFF'})`, async () => {
    const f = await fixture({ on });
    await createIntent(f);
    const q = await quote(f, quoteBody(f, 3)),
      forwarded = await checkout(f, q);
    // Both ledgers receive explicit independent synthetic payment receipts via API.
    // The supplier performs real scans and an actual local DEMO dispatch; there is
    // no fabricated buyer issue or copied supplier parcel in the buyer ledger.
    const customerBeforePayment = await ok('/orders/' + f.order.id);
    await ok('/orders/' + f.order.id + '/payments', 'POST', {
      client_key: randomUUID(),
      version: Number(customerBeforePayment.version),
      kind: 'receipt',
      amount: 7500,
      currency: 'PLN',
      method: 'bank_transfer',
      reference: 'Own retail receipt 127',
      confirmed: true,
    });
    const supplierOrder = await ok(
      '/orders/' + forwarded.supplier_order_id,
      'GET',
      undefined,
      supplierCookie,
    );
    await ok(
      '/orders/' + supplierOrder.id + '/payments',
      'POST',
      {
        client_key: randomUUID(),
        version: Number(supplierOrder.version),
        kind: 'receipt',
        amount: 2100,
        currency: 'PLN',
        method: 'bank_transfer',
        reference: 'Own wholesale receipt 127',
        confirmed: true,
      },
      supplierCookie,
    );
    assert.equal(
      (await ok('/orders/' + supplierOrder.id, 'GET', undefined, supplierCookie)).status,
      'paid',
    );
    await ok(
      '/orders/' + supplierOrder.id + '/status',
      'PATCH',
      await legacySerialOrderStatusPayload((orderPath) => ok(orderPath, 'GET', undefined, supplierCookie), '/orders/' + supplierOrder.id + '/status', { status: 'picking' }),
      supplierCookie,
    );
    const layers = (
      await pool.query(
        "SELECT layer_id,location,quantity FROM wms_reservation_layers WHERE tenant_id=$1 AND order_id=$2 AND product_id=$3 AND state='active' ORDER BY layer_id,location",
        [supplier, supplierOrder.id, f.source.id],
      )
    ).rows;
    if (on) {
      assert.equal(
        layers.reduce((sum, layer) => sum + layer.quantity, 0),
        3,
      );
      for (const layer of layers)
        for (let n = 0; n < layer.quantity; n++)
          await ok(
            '/orders/' + supplierOrder.id + '/scan',
            'POST',
            {
              code: f.source.sku,
              location: layer.location,
              layer_id: layer.layer_id,
              client_key: randomUUID(),
            },
            supplierCookie,
          );
    } else {
      assert.equal(layers.length, 0);
      for (let n = 0; n < 3; n++)
        await ok(
          '/orders/' + supplierOrder.id + '/scan',
          'POST',
          { code: f.source.sku, client_key: randomUUID() },
          supplierCookie,
        );
    }
    await ok(
      '/orders/' + supplierOrder.id + '/status',
      'PATCH',
      await legacySerialOrderStatusPayload((orderPath) => ok(orderPath, 'GET', undefined, supplierCookie), '/orders/' + supplierOrder.id + '/status', { status: 'packed' }),
      supplierCookie,
    );
    await ok('/orders/' + supplierOrder.id + '/ship-demo', 'POST', {}, supplierCookie);
    await ok(f.path + '/orders/' + forwarded.id + '/reconcile', 'POST', {
      client_key: randomUUID(),
      version: forwarded.version,
      confirmed: true,
    });
    const customer = await ok('/orders/' + f.order.id);
    assert.equal(customer.status, 'shipped');
    assert(customer.items.every((i: Row) => i.scanned === 0));
    const r = await ok('/orders/' + customer.id + '/returns', 'POST', {
      client_key: randomUUID(),
      reason: 'Own external customer return must not create buyer warehouse stock',
      items: [{ item_id: customer.items[0].id, quantity: 1 }],
    });
    const body = {
      version: Number(r.version),
      shipping_refund: 0,
      note: 'Own external-only non-restock acceptance',
      items: [{ item_id: customer.items[0].id, accepted: 1, restocked: 1 }],
    };
    const before = await snapshot(),
      physical = await physicalSnapshot();
    const refused = await request('/returns/' + r.id + '/receive', 'POST', body);
    assert.equal(refused.statusCode, 409, refused.body);
    assert.deepEqual(await snapshot(), before);
    // Physical receipt needs actual selected fulfillment provenance even for
    // damaged goods. A financial-only goodwill decision is a separate workflow.
    const noPhysicalOrigin = await request('/returns/' + r.id + '/receive', 'POST', {
      ...body,
      items: body.items.map((i) => ({ ...i, restocked: 0 })),
    });
    assert.equal(noPhysicalOrigin.statusCode, 409, noPhysicalOrigin.body);
    assert.deepEqual(await snapshot(), before);
    assert.deepEqual(await physicalSnapshot(), physical);
    assert.deepEqual(
      (
        await pool.query(
          'SELECT on_hand,reserved FROM stock WHERE tenant_id=$1 AND product_id=$2',
          [supplier, f.source.id],
        )
      ).rows[0],
      { on_hand: 27, reserved: 0 },
    );
    assert.equal(providerCalls, 0);
  });
}
