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
type Row = Record<string, any>;
let app: Awaited<ReturnType<typeof buildApp>> | undefined;
let tenant = '',
  warehouse = '',
  supplier = '',
  adminId = '',
  admin = '',
  viewer = '',
  other = '',
  ip = 1;
let providerCalls = 0;
const prefix = '/replenishment';
const evidence = [
  'replenishment_previews',
  'replenishment_rows',
  'replenishment_executions',
  'replenishment_execution_rows',
];
const cookies = new Map<string, string>();
const transport = async () => {
  ++providerCalls;
  throw Error('Local replenishment cannot contact providers');
};
function request(
  path: string,
  method: any = 'GET',
  payload?: any,
  cookie = admin,
  target = app,
  headers: Record<string, string> = {},
) {
  assert(target);
  return target.inject({
    method,
    url: '/api' + path,
    payload,
    headers: { cookie, ...headers },
    remoteAddress: '127.0.178.' + ip,
  });
}
async function ok(path: string, method: any = 'GET', body?: any, cookie = admin, status = 200) {
  const r = await request(path, method, body, cookie);
  assert.equal(r.statusCode, status, `${method} ${path}: ${r.body.slice(0, 900)}`);
  if (path.startsWith(prefix)) assert.equal(r.headers['cache-control'], 'no-store', path);
  return r.json() as Row;
}
async function login(email: string, target = app) {
  const r = await request('/auth/login', 'POST', { email, password: 'DynaDemo!2026' }, '', target);
  assert.equal(r.statusCode, 200);
  return String(r.headers['set-cookie']).split(';')[0];
}
before(async () => {
  await migrate();
  await seed();
  app = await buildApp({
    integrationTransport: transport,
    logging: process.env.REPLENISHMENT_TEST_LOG === 'true',
  });
  for (const email of ['admin@demo.local', 'viewer@demo.local', 'other@demo.local'])
    cookies.set(email, await login(email));
  adminId = (await pool.query("SELECT id FROM users WHERE email='admin@demo.local'")).rows[0].id;
});
beforeEach(async () => {
  ++ip;
  providerCalls = 0;
  tenant = randomUUID();
  warehouse = randomUUID();
  await pool.query(
    "INSERT INTO tenants(id,name,plan) VALUES($1,'Replenishment adversarial','enterprise')",
    [tenant],
  );
  await pool.query(
    "INSERT INTO memberships(tenant_id,user_id,role) SELECT $1,id,CASE email WHEN 'viewer@demo.local' THEN 'viewer' ELSE 'admin' END FROM users WHERE email=ANY($2::text[])",
    [tenant, [...cookies.keys()]],
  );
  await pool.query(
    "INSERT INTO warehouses(id,tenant_id,name,code) VALUES($1,$2,'Replenishment warehouse','RP')",
    [warehouse, tenant],
  );
  for (const [email, cookie] of cookies) {
    const r = await request('/workspaces/switch', 'POST', { tenant_id: tenant }, cookie);
    assert.equal(r.statusCode, 200);
    cookies.set(email, String(r.headers['set-cookie']).split(';')[0]);
  }
  admin = cookies.get('admin@demo.local')!;
  viewer = cookies.get('viewer@demo.local')!;
  other = cookies.get('other@demo.local')!;
  const r = await request('/suppliers', 'POST', {
    name: 'Local supplier',
    code: 'S-' + randomUUID(),
  });
  assert.equal(r.statusCode, 201, r.body);
  supplier = r.json().id;
});
after(async () => {
  try {
    await app?.close();
  } finally {
    await pool.end();
  }
});
async function product(extra: Row = {}) {
  const r = await request('/products', 'POST', {
    sku: 'RP-' + randomUUID(),
    name: 'Physical replenishment product',
    price: 9999,
    quantity: 10,
    warehouse_id: warehouse,
    ...extra,
  });
  assert.equal(r.statusCode, 201, r.body);
  return r.json() as Row;
}
const definition = (extra: Row = {}) => ({
  enabled: true,
  minimum_quantity: 20,
  target_quantity: 40,
  supplier_id: supplier,
  supplier_sku: 'LOCAL-317',
  currency: 'PLN',
  minimum_order_quantity: 1,
  order_multiple: 1,
  unit_cost_minor: 317,
  cost_valid_until: new Date(Date.now() + 86400000).toISOString(),
  confirm_cost: true,
  expected_date: null,
  ...extra,
});
async function policy(p: Row, extra: Row = {}) {
  return (
    await ok(
      prefix + '/policies',
      'POST',
      {
        client_key: randomUUID(),
        warehouse_id: warehouse,
        product_id: p.id,
        definition: definition(extra),
      },
      admin,
      201,
    )
  ).policy as Row;
}
const selection = (products: Row[], policies: Row[]) => ({
  client_key: randomUUID(),
  warehouse_id: warehouse,
  items: products.map((p, i) => ({
    product_id: p.id,
    product_version: Number(p.version),
    policy_version: Number(policies[i].version),
  })),
});
async function fixture(extra: Row = {}) {
  const p = await product(),
    pol = await policy(p, extra);
  return { p, pol, body: selection([p], [pol]) };
}
async function preview(body: Row, cookie = admin) {
  return (await ok(prefix + '/previews', 'POST', body, cookie, 201)).preview as Row;
}
const consent = (p: Row) => ({
  client_key: randomUUID(),
  scope_hash: p.scope_hash,
  confirmed: true,
});
const execute = (p: Row, body: Row = consent(p), cookie = admin) =>
  request(prefix + '/previews/' + p.id + '/execute', 'POST', body, cookie);
async function key(scopes: string[]) {
  const r = await request('/developer/keys', 'POST', { name: 'Replenishment safety', scopes });
  assert.equal(r.statusCode, 201, r.body);
  return r.json() as Row;
}
const readScopes = ['products:read', 'inventory:read', 'purchasing:read'];
const writeScopes = [...readScopes, 'purchasing:write'];
const publicRequest = (token: string, path: string, method: any = 'GET', body?: any) =>
  request('/v1' + path, method, body, '', app, { authorization: 'Bearer ' + token });
async function snapshot() {
  const names = (
    await pool.query(`SELECT DISTINCT c.table_name FROM information_schema.columns c JOIN information_schema.tables t USING(table_schema,table_name)
    WHERE c.table_schema='public' AND c.column_name='tenant_id' AND t.table_type='BASE TABLE'
    AND c.table_name NOT IN ('memberships','api_keys','outbound_subscriptions','sessions') ORDER BY 1`)
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
async function waitOn(holder: PoolClient, pattern: RegExp) {
  const pid = (await holder.query('SELECT pg_backend_pid() pid')).rows[0].pid,
    deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const rows = (
      await pool.query(
        "SELECT query FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND $1=ANY(pg_blocking_pids(pid))",
        [pid],
      )
    ).rows;
    if (rows.some((r) => pattern.test(r.query))) return;
    await new Promise((done) => setTimeout(done, 10));
  }
  assert.fail('The actual replenishment request never waited on the independent SQL blocker');
}
async function grantChange(sql: string, values: unknown[]) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query("SET LOCAL statement_timeout='1500ms'");
    await c.query(sql, values);
    await c.query('COMMIT');
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
}
async function epoch() {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.tenant_id',$1,true)", [tenant]);
    const n = (await c.query('SELECT purchasing_source_version()::text n')).rows[0].n;
    await c.query('ROLLBACK');
    return BigInt(n);
  } finally {
    c.release();
  }
}
async function po(p: Row, quantity = 3) {
  const r = await request('/purchase-orders', 'POST', {
    supplier_id: supplier,
    warehouse_id: warehouse,
    currency: 'PLN',
    lines: [{ product_id: p.id, quantity, unit_cost: 317, supplier_sku: 'LOCAL-317' }],
  });
  assert.equal(r.statusCode, 201, r.body);
  return r.json() as Row;
}
async function copiedRow(
  c: PoolClient,
  table: string,
  where: string,
  values: unknown[],
  patch: Row,
) {
  assert(evidence.includes(table));
  await c.query(
    `INSERT INTO "${table}" SELECT (jsonb_populate_record(NULL::"${table}",to_jsonb(t)||$${values.length + 1}::jsonb)).* FROM "${table}" t WHERE ${where}`,
    [...values, JSON.stringify(patch)],
  );
}

test('quantity-only readers never see frozen costs and public reads require all three scopes; mutations require current admin and purchasing write', async () => {
  const f = await fixture(),
    p = await preview(f.body),
    read = await key(readScopes),
    write = await key(writeScopes),
    incomplete = await key(['products:read', 'purchasing:read']);
  const before = await snapshot();
  for (const path of [
    prefix + '/options',
    prefix + '/policies?warehouse_id=' + warehouse,
    prefix + '/previews/' + p.id,
    prefix + '/previews/' + p.id + '/rows',
  ]) {
    const r = await request(path, 'GET', undefined, viewer);
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().can_read_value, false);
    const text = r.body;
    for (const field of [
      'unit_cost_minor',
      'line_total_minor',
      'cost_valid_until',
      'cost_confirmed_at',
    ])
      assert(!text.includes('"' + field + '"'), field + ' leaked');
    assert.equal((await publicRequest(incomplete.token, path)).statusCode, 403);
    assert.equal((await publicRequest(read.token, path)).statusCode, 200);
  }
  assert.equal((await request(prefix + '/previews', 'POST', f.body, viewer)).statusCode, 403);
  assert.equal(
    (await publicRequest(read.token, prefix + '/previews', 'POST', f.body)).statusCode,
    403,
  );
  assert.equal(
    (
      await publicRequest(write.token, prefix + '/previews', 'POST', {
        ...f.body,
        client_key: randomUUID(),
      })
    ).statusCode,
    201,
  );
  // The last authorized preview is an explicit effect, not part of denial evidence.
  assert.deepEqual((await snapshot()).purchase_orders, before.purchase_orders);
  assert.deepEqual((await snapshot()).stock, before.stock);
  assert.equal(providerCalls, 0);
});

test(
  'real source admission wait allows role withdrawal to commit and rejects preview without durable or business effects',
  { timeout: 20000 },
  async () => {
    const f = await fixture(),
      before = await snapshot(),
      holder = await pool.connect();
    let pending: ReturnType<typeof request> | undefined;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        'purchasing.source:' + tenant,
      ]);
      pending = request(prefix + '/previews', 'POST', f.body);
      await waitOn(holder, /purchasing_source_admit/);
      await grantChange("UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2", [
        tenant,
        adminId,
      ]);
      await holder.query('COMMIT');
      assert.equal((await pending).statusCode, 403);
      assert.deepEqual(await snapshot(), before);
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
      await pending;
    }
  },
);

test(
  'real product wait during execute rechecks administrator and atomically rolls back every draft, epoch, receipt and audit',
  { timeout: 20000 },
  async () => {
    const f = await fixture(),
      p = await preview(f.body),
      before = await snapshot(),
      holder = await pool.connect();
    let pending: ReturnType<typeof request> | undefined;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM products WHERE id=$1 FOR UPDATE', [f.p.id]);
      pending = execute(p);
      await waitOn(holder, /products[\s\S]*FOR SHARE/i);
      await grantChange("UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2", [
        tenant,
        adminId,
      ]);
      await holder.query('COMMIT');
      assert.equal((await pending).statusCode, 403);
      assert.deepEqual(await snapshot(), before);
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
      await pending;
    }
  },
);

test(
  'late user FK wait permits role withdrawal and rolls back preview rows, quota bytes and audit',
  { timeout: 20000 },
  async () => {
    const f = await fixture(),
      before = await snapshot(),
      holder = await pool.connect();
    let pending: ReturnType<typeof request> | undefined;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [adminId]);
      pending = request(prefix + '/previews', 'POST', f.body);
      await waitOn(holder, /INSERT INTO (replenishment_previews|audit_events)/i);
      await grantChange("UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2", [
        tenant,
        adminId,
      ]);
      await holder.query('COMMIT');
      assert.equal((await pending).statusCode, 403);
      assert.deepEqual(await snapshot(), before);
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
      await pending;
    }
  },
);

test(
  'late revoke, expiry and read/write scope removal are checked after real product waits',
  { timeout: 30000 },
  async () => {
    for (const change of ['revoke', 'expiry', 'read', 'write']) {
      const f = await fixture(),
        credential = await key(writeScopes),
        r = await publicRequest(credential.token, prefix + '/previews', 'POST', f.body);
      assert.equal(r.statusCode, 201, r.body);
      const p = r.json().preview,
        before = await snapshot(),
        holder = await pool.connect();
      let pending: ReturnType<typeof request> | undefined;
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT id FROM products WHERE id=$1 FOR UPDATE', [f.p.id]);
        pending = publicRequest(
          credential.token,
          prefix + '/previews/' + p.id + '/execute',
          'POST',
          consent(p),
        );
        await waitOn(holder, /products[\s\S]*FOR SHARE/i);
        await grantChange(
          change === 'revoke'
            ? 'UPDATE api_keys SET revoked_at=now() WHERE id=$1'
            : change === 'expiry'
              ? "UPDATE api_keys SET expires_at=now()-interval '1 minute' WHERE id=$1"
              : 'UPDATE api_keys SET scopes=$2::text[] WHERE id=$1',
          change === 'read'
            ? [credential.id, writeScopes.filter((x) => x !== 'inventory:read')]
            : change === 'write'
              ? [credential.id, readScopes]
              : [credential.id],
        );
        await holder.query('COMMIT');
        assert.equal((await pending).statusCode, ['revoke', 'expiry'].includes(change) ? 401 : 403);
        assert.deepEqual(await snapshot(), before);
      } finally {
        await holder.query('ROLLBACK');
        holder.release();
        await pending;
      }
    }
  },
);

test(
  'privileged owner without GUC takes the global gate, invalidates the actual tenant and blocks live planning until commit',
  { timeout: 20000 },
  async () => {
    const f = await fixture(),
      draft = await po(f.p),
      oldEpoch = await epoch(),
      holder = await pool.connect();
    let pending: ReturnType<typeof request> | undefined;
    try {
      await holder.query('BEGIN');
      await holder.query("SELECT set_config('app.tenant_id','',true)");
      await holder.query(
        'UPDATE purchase_order_lines SET quantity=quantity+1 WHERE tenant_id=$1 AND order_id=$2',
        [tenant, draft.id],
      );
      pending = request(prefix + '/previews', 'POST', f.body);
      await waitOn(holder, /purchasing_source_admit/);
      await holder.query('COMMIT');
      const r = await pending;
      assert.equal(r.statusCode, 201, r.body);
      assert((await epoch()) > oldEpoch);
      const rows = await ok(prefix + '/previews/' + r.json().preview.id + '/rows');
      assert.equal(rows.data[0].incoming_draft_quantity, '4');
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
      await pending;
    }
  },
);

test('new raw PO phantom and raw line ABA invalidate approved plans even when stock and all line values return to the same state', async () => {
  const f = await fixture(),
    draft = await po(f.p),
    p = await preview(f.body),
    oldStock = (await snapshot()).stock,
    beforeEpoch = await epoch();
  await pool.query(
    'UPDATE purchase_order_lines SET quantity=quantity+1 WHERE tenant_id=$1 AND order_id=$2',
    [tenant, draft.id],
  );
  await pool.query(
    'UPDATE purchase_order_lines SET quantity=quantity-1 WHERE tenant_id=$1 AND order_id=$2',
    [tenant, draft.id],
  );
  assert((await epoch()) >= beforeEpoch + 2n);
  const afterExplicit = await snapshot();
  assert.equal((await execute(p)).statusCode, 409);
  assert.deepEqual(await snapshot(), afterExplicit);
  assert.deepEqual(afterExplicit.stock, oldStock);
  const fresh = await preview({ ...f.body, client_key: randomUUID() }),
    newId = randomUUID();
  await pool.query(
    `INSERT INTO purchase_orders(id,tenant_id,number,supplier_id,warehouse_id,currency,supplier_snapshot,created_by)
    SELECT $1,tenant_id,$2,supplier_id,warehouse_id,currency,supplier_snapshot,created_by FROM purchase_orders WHERE id=$3`,
    [newId, 'RAW-' + newId, draft.id],
  );
  await pool.query(
    'INSERT INTO purchase_order_lines SELECT tenant_id,$1,product_id,sku,name,supplier_sku,quantity,received_quantity,closed_quantity,unit_cost FROM purchase_order_lines WHERE order_id=$2',
    [newId, draft.id],
  );
  const phantom = await snapshot();
  assert.equal((await execute(fresh)).statusCode, 409);
  assert.deepEqual(await snapshot(), phantom);
});

test(
  'absent stock INSERT really waits on source admission and raw stock delete/reinsert ABA changes the private source marker',
  { timeout: 20000 },
  async () => {
    // Genuine historical catalogue presence without a stock row; no detached
    // movement rows or deleted received quantities are used to fake absence.
    const ownProduct = (
      await pool.query(
        "INSERT INTO products(id,tenant_id,sku,name,price) VALUES($1,$2,$3,'Legacy absent stock',100) RETURNING *",
        [randomUUID(), tenant, 'ABS-' + randomUUID()],
      )
    ).rows[0];
    const ownPolicy = await policy(ownProduct),
      f = { p: ownProduct, pol: ownPolicy, body: selection([ownProduct], [ownPolicy]) };
    const p = await preview(f.body),
      holder = await pool.connect(),
      writer = await pool.connect();
    let pending: Promise<any> | undefined;
    try {
      await holder.query('BEGIN');
      await holder.query("SELECT set_config('app.tenant_id',$1,true)", [tenant]);
      await holder.query('SELECT purchasing_source_admit()');
      await writer.query('BEGIN');
      await writer.query('SET LOCAL ROLE dyna_app');
      await writer.query("SELECT set_config('app.tenant_id',$1,true)", [tenant]);
      pending = writer.query(
        'INSERT INTO stock(tenant_id,warehouse_id,product_id,on_hand,reserved) VALUES($1,$2,$3,0,0)',
        [tenant, warehouse, f.p.id],
      );
      await waitOn(holder, /INSERT INTO stock/i);
      await holder.query('COMMIT');
      await pending;
      await writer.query('COMMIT');
      const afterInsert = await snapshot();
      assert.equal((await execute(p)).statusCode, 409);
      assert.deepEqual(await snapshot(), afterInsert);
      const p2 = await preview({ ...f.body, client_key: randomUUID() }),
        stockBefore = afterInsert.stock,
        oldEpoch = await epoch();
      await writer.query('BEGIN');
      await writer.query('DELETE FROM stock_locations WHERE tenant_id=$1 AND product_id=$2', [
        tenant,
        f.p.id,
      ]);
      await writer.query('DELETE FROM stock WHERE tenant_id=$1 AND product_id=$2', [
        tenant,
        f.p.id,
      ]);
      await writer.query(
        'INSERT INTO stock(tenant_id,warehouse_id,product_id,on_hand,reserved) VALUES($1,$2,$3,0,0)',
        [tenant, warehouse, f.p.id],
      );
      await writer.query('COMMIT');
      assert.deepEqual((await snapshot()).stock, stockBefore);
      assert((await epoch()) > oldEpoch);
      const afterABA = await snapshot();
      assert.equal((await execute(p2)).statusCode, 409);
      assert.deepEqual(await snapshot(), afterABA);
    } finally {
      await holder.query('ROLLBACK');
      await pending?.catch(() => {});
      await writer.query('ROLLBACK');
      holder.release();
      writer.release();
    }
  },
);

test('application cannot bypass epoch privileges or own scope, and zero-row statements never advance the source epoch', async () => {
  const f = await fixture(),
    draft = await po(f.p),
    old = await epoch(),
    c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.tenant_id',$1,true)", [tenant]);
    await c.query('SET LOCAL ROLE dyna_app');
    await assert.rejects(c.query('UPDATE purchasing_source_versions SET version=0'), {
      code: '42501',
    });
    await c.query('ROLLBACK');
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.tenant_id',$1,true)", [tenant]);
    await c.query('SET LOCAL ROLE dyna_app');
    await assert.rejects(
      c.query('INSERT INTO purchasing_stock_changes(tenant_id) VALUES($1)', [tenant]),
      { code: '42501' },
    );
    await c.query('ROLLBACK');
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE dyna_app');
    await c.query("SELECT set_config('app.tenant_id','',true)");
    await assert.rejects(c.query('UPDATE purchase_orders SET note=note WHERE id=$1', [draft.id]), {
      code: '42501',
    });
    await c.query('ROLLBACK');
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.tenant_id',$1,true)", [tenant]);
    await c.query('SET LOCAL ROLE dyna_app');
    await c.query('UPDATE purchase_order_lines SET quantity=quantity WHERE order_id=$1', [
      randomUUID(),
    ]);
    await c.query('COMMIT');
    assert.equal(await epoch(), old);
    const triggers = (
      await pool.query(
        `SELECT c.relname,t.tgname FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE NOT t.tgisinternal AND t.tgname LIKE 'purchasing_source_%' ORDER BY 1,2`,
      )
    ).rows;
    for (const table of [
      'purchase_orders',
      'purchase_order_lines',
      'purchase_receipts',
      'purchase_receipt_lines',
      'b2b_network_orders',
      'b2b_network_order_lines',
      'b2b_network_receipts',
      'b2b_network_receipt_lines',
      'stock',
    ])
      assert.equal(triggers.filter((t) => t.relname === table).length, 4, table);
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
});

test('genuine forced RLS, foreign FK, immutable rows, incomplete commits and forged execution evidence reject atomically', async () => {
  const f = await fixture(),
    priorPO = await po(f.p, 1),
    p = await preview(f.body),
    completed = await execute(p);
  assert.equal(completed.statusCode, 201, completed.body);
  const e = completed.json().execution,
    raw = (await pool.query('SELECT * FROM replenishment_rows WHERE preview_id=$1', [p.id]))
      .rows[0],
    before = await snapshot(),
    c = await pool.connect();
  try {
    for (const table of evidence) {
      await c.query('BEGIN');
      await assert.rejects(
        c.query(`UPDATE "${table}" SET byte_count=byte_count WHERE tenant_id=$1`, [tenant]),
        { code: '23514' },
      );
      await c.query('ROLLBACK');
      await c.query('BEGIN');
      await assert.rejects(c.query(`DELETE FROM "${table}" WHERE tenant_id=$1`, [tenant]), {
        code: '23514',
      });
      await c.query('ROLLBACK');
    }
    const foreign = randomUUID();
    await pool.query("INSERT INTO tenants(id,name) VALUES($1,'Foreign proof')", [foreign]);
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE dyna_app');
    await c.query("SELECT set_config('app.tenant_id',$1,true)", [foreign]);
    for (const table of evidence)
      assert.equal(
        (await c.query(`SELECT count(*)::int n FROM "${table}" WHERE tenant_id=$1`, [tenant]))
          .rows[0].n,
        0,
      );
    await c.query('ROLLBACK');
    await c.query('BEGIN');
    await assert.rejects(
      copiedRow(c, 'replenishment_rows', 'id=$1', [raw.id], {
        id: randomUUID(),
        preview_id: randomUUID(),
      }),
      { code: '23503' },
    );
    await c.query('ROLLBACK');
    await c.query('BEGIN');
    await copiedRow(c, 'replenishment_previews', 'id=$1', [p.id], {
      id: randomUUID(),
      client_key: randomUUID(),
    });
    await assert.rejects(c.query('SET CONSTRAINTS ALL IMMEDIATE'), { code: '23514' });
    await c.query('ROLLBACK');
    await c.query('BEGIN');
    await assert.rejects(
      copiedRow(c, 'replenishment_execution_rows', 'execution_id=$1', [e.id], {
        id: randomUUID(),
        result: { ...raw.result, recommended_quantity: '999999' },
      }),
      { code: '23514' },
    );
    await c.query('ROLLBACK');
    // A committed draft cannot be relabelled as a newly generated PO, even
    // with version one, own supplier/warehouse and a genuine execution UUID.
    await c.query('BEGIN');
    // Rewriting first gives the old tuple this transaction's xmin. The private
    // actual INSERT marker must still reject adoption of that committed head.
    await c.query('UPDATE purchase_orders SET note=note WHERE id=$1', [priorPO.id]);
    await assert.rejects(
      c.query(
        'UPDATE purchase_orders SET replenishment_execution_id=$2,replenishment_group_index=77 WHERE id=$1',
        [priorPO.id, e.id],
      ),
      { code: '23514' },
    );
    await c.query('ROLLBACK');
    const rls = (
      await pool.query(
        'SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class WHERE relname=ANY($1::text[])',
        [
          [
            ...evidence,
            'replenishment_policies',
            'purchasing_source_versions',
            'purchasing_stock_changes',
          ],
        ],
      )
    ).rows;
    assert.equal(rls.length, 7);
    assert(rls.every((t) => t.relrowsecurity && t.relforcerowsecurity));
    assert.deepEqual(await snapshot(), before);
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
});

test('exact execution replay remains immutable after ordinary PO edit/place/receive and refuses different actor or request', async () => {
  const f = await fixture(),
    body = { ...f.body, items: [...f.body.items].reverse() },
    p = await preview(body),
    approved = consent(p),
    first = await execute(p, approved);
  assert.equal(first.statusCode, 201, first.body);
  const e = first.json().execution,
    poRow = (
      await pool.query('SELECT * FROM purchase_orders WHERE replenishment_execution_id=$1', [e.id])
    ).rows[0];
  assert(poRow);
  const changed = await request('/purchase-orders/' + poRow.id, 'PATCH', {
    version: 1,
    supplier_id: supplier,
    warehouse_id: warehouse,
    currency: 'PLN',
    lines: [{ product_id: f.p.id, quantity: 31, unit_cost: 318, supplier_sku: 'EDITED' }],
  });
  assert.equal(changed.statusCode, 200, changed.body);
  const placed = await request('/purchase-orders/' + poRow.id + '/place', 'POST', { version: 2 });
  assert.equal(placed.statusCode, 200, placed.body);
  const received = await request('/purchase-orders/' + poRow.id + '/receive', 'POST', {
    version: 3,
    client_key: randomUUID(),
    lines: [{ product_id: f.p.id, quantity: 1, location: 'A-01' }],
  });
  assert.equal(received.statusCode, 200, received.body);
  const before = await snapshot(),
    retry = await execute(p, {
      confirmed: true,
      scope_hash: approved.scope_hash,
      client_key: approved.client_key,
    });
  assert.equal(retry.statusCode, 200, retry.body);
  assert.equal(retry.json().reused, true);
  assert.deepEqual(retry.json().execution, e);
  assert.deepEqual(await snapshot(), before);
  assert.equal((await execute(p, { ...approved, scope_hash: '0'.repeat(64) })).statusCode, 409);
  assert.equal((await execute(p, approved, other)).statusCode, 409);
  assert.deepEqual(await snapshot(), before);
  assert.equal(providerCalls, 0);
});

test('a stale second product rolls back all drafts and two concurrent approvals produce exactly one durable execution', async () => {
  const a = await fixture(),
    b = await fixture(),
    p = await preview(selection([a.p, b.p], [a.pol, b.pol]));
  await pool.query('UPDATE products SET version=version+1 WHERE id=$1', [b.p.id]);
  const before = await snapshot();
  assert.equal((await execute(p)).statusCode, 409);
  assert.deepEqual(await snapshot(), before);
  const p2 = await preview(selection([a.p], [a.pol])),
    responses = await Promise.all([execute(p2), execute(p2)]);
  assert.deepEqual(responses.map((r) => r.statusCode).sort(), [201, 409]);
  assert.equal(
    (
      await pool.query('SELECT count(*)::int n FROM replenishment_executions WHERE tenant_id=$1', [
        tenant,
      ])
    ).rows[0].n,
    1,
  );
  assert.equal(
    (await pool.query('SELECT count(*)::int n FROM purchase_orders WHERE tenant_id=$1', [tenant]))
      .rows[0].n,
    1,
  );
});

// These fixtures exist only in the disposable dynaminds_test_* database. They
// use INSERT-only copies of a genuine NOP chain; all byte, completeness, scope,
// RLS, foreign-key and quota triggers remain enabled. They prove SQL storage
// guards, not 2000 real API operations or production capacity.
async function thresholdFingerprint(names: string[]) {
  const result: Row = {};
  for (const name of names) {
    assert(/^[a-z][a-z0-9_]*$/.test(name));
    result[name] = (
      await pool.query(
        `WITH hashes AS MATERIALIZED (
          SELECT encode(sha256(convert_to(to_jsonb(t)::text,'UTF8')),'hex') AS h,
            coalesce((to_jsonb(t)->>'byte_count')::bigint,0) AS bytes
          FROM "${name}" t WHERE tenant_id=$1
        ) SELECT count(*)::int AS count,coalesce(sum(bytes),0)::text AS bytes,
          encode(sha256(convert_to(coalesce(string_agg(h,'' ORDER BY h),''),'UTF8')),'hex') AS sha256
        FROM hashes`,
        [tenant],
      )
    ).rows[0];
  }
  return result;
}
const thresholdEffects = [
  'stock',
  'stock_locations',
  'stock_movements',
  'purchase_orders',
  'purchase_order_lines',
  'purchase_receipts',
  'purchase_receipt_lines',
  'warehouse_documents',
  'warehouse_document_lines',
  'jobs',
  'audit_events',
  'purchasing_source_versions',
  'purchasing_stock_changes',
];
async function assertThresholdGuards() {
  const rows = (
    await pool.query(
      `SELECT c.relname,t.tgname,t.tgenabled FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
       WHERE c.relname=ANY($1::text[]) AND NOT t.tgisinternal`,
      [evidence],
    )
  ).rows;
  assert(rows.every((r) => r.tgenabled === 'O'));
  for (const table of evidence) {
    for (const name of ['immutable', 'serialized_bytes', 'budget'])
      assert(
        rows.some((r) => r.relname === table && r.tgname === name),
        `${table}.${name}`,
      );
    const count = (
      await pool.query(
        `SELECT count(*)::int AS n FROM "${table}" t
         WHERE tenant_id=$1 AND byte_count<>octet_length(to_jsonb(t)::text)`,
        [tenant],
      )
    ).rows[0].n;
    assert.equal(count, 0, `${table}: actual database-derived bytes`);
  }
  for (const table of ['replenishment_previews', 'replenishment_executions'])
    assert(rows.some((r) => r.relname === table && r.tgname === 'complete'));
  for (const table of [
    'replenishment_rows',
    'replenishment_executions',
    'replenishment_execution_rows',
  ])
    assert(rows.some((r) => r.relname === table && r.tgname === 'scope'));
}
async function thresholdTransaction(c: PoolClient) {
  await c.query('BEGIN');
  await c.query('SET LOCAL ROLE dyna_app');
  await c.query("SELECT set_config('app.tenant_id',$1,true)", [tenant]);
}
async function thresholdNop() {
  const f = await fixture({
    minimum_quantity: 0,
    target_quantity: 0,
    unit_cost_minor: null,
    cost_valid_until: null,
    confirm_cost: false,
  });
  const p = await preview(f.body),
    approved = consent(p),
    completed = await execute(p, approved);
  assert.equal(completed.statusCode, 201, completed.body);
  const e = completed.json().execution;
  assert.equal(p.unchanged, 1);
  assert.equal(e.groups.length, 0);
  const raw = (await pool.query('SELECT * FROM replenishment_rows WHERE preview_id=$1', [p.id]))
    .rows;
  assert.equal(raw.length, 1);
  return { f, p, approved, e, raw: raw[0] as Row };
}

test(
  'actual quota threshold aggregate 128 MiB includes all four proof tables and rejects atomically below each preview limit',
  { timeout: 120000 },
  async (t) => {
    const { p, raw } = await thresholdNop();
    // The real two-group purchase preview must precede the byte fill, so its
    // later execute passes source CAS and actually reaches the post-PO quota.
    const a = await fixture({ currency: 'PLN' });
    const secondSupplier = await ok(
      '/suppliers',
      'POST',
      { name: 'Quota EUR supplier', code: 'Q-' + randomUUID() },
      admin,
      201,
    );
    const b = await fixture({ currency: 'EUR', supplier_id: secondSupplier.id });
    const purchasePreview = await preview(selection([a.p, b.p], [a.pol, b.pol]));
    assert.equal(purchasePreview.ready, true);
    assert.equal(purchasePreview.purchase, 2);
    assert.equal(purchasePreview.groups.length, 2);
    assert.deepEqual(purchasePreview.groups.map((g: Row) => g.currency).sort(), ['EUR', 'PLN']);
    assert.equal(new Set(purchasePreview.groups.map((g: Row) => g.supplier_id)).size, 2);
    const approved = consent(purchasePreview);
    const c = await pool.connect();
    const businessNames = (
      await pool.query(`SELECT DISTINCT table_name FROM information_schema.columns
      WHERE table_schema='public' AND column_name='tenant_id' AND table_name<>'sessions' ORDER BY table_name`)
    ).rows
      .map((r) => r.table_name as string)
      .filter((name) => !evidence.includes(name));
    assert(businessNames.includes('purchasing_source_versions'));
    assert(businessNames.includes('purchasing_stock_changes'));
    const effectsBefore = await thresholdFingerprint(businessNames);
    const storageLimit = 134217728,
      previewLimit = 8388608;
    try {
      await thresholdTransaction(c);
      // Seventeen complete ~7.5 MiB previews fit below the aggregate limit;
      // no individual preview approaches the separate 8 MiB boundary.
      for (let i = 0; i < 17; i++) {
        const id = randomUUID();
        await c.query(
          `INSERT INTO replenishment_previews
         SELECT (jsonb_populate_record(NULL::replenishment_previews,to_jsonb(p)||
           jsonb_build_object('id',$2::uuid,'client_key',$3::uuid,'byte_count',1,
             'config',p.config||jsonb_build_object('quota_padding',repeat('x',7864320))))).*
         FROM replenishment_previews p WHERE p.id=$1`,
          [p.id, id, randomUUID()],
        );
        await copiedRow(c, 'replenishment_rows', 'id=$1', [raw.id], {
          id: randomUUID(),
          preview_id: id,
          byte_count: 1,
        });
      }
      await c.query('SET CONSTRAINTS ALL IMMEDIATE');
      await c.query('COMMIT');
      const proofBefore = await thresholdFingerprint(evidence);
      const totalBytes = Object.values(proofBefore).reduce((n, r) => n + BigInt(r.bytes), 0n);
      assert(totalBytes <= BigInt(storageLimit));
      assert(totalBytes > BigInt(storageLimit - 524288));
      const sizes = (
        await pool.query(
          `SELECT p.id,p.byte_count+sum(r.byte_count) AS bytes FROM replenishment_previews p
       JOIN replenishment_rows r ON (r.tenant_id,r.preview_id)=(p.tenant_id,p.id)
       WHERE p.tenant_id=$1 GROUP BY p.id`,
          [tenant],
        )
      ).rows;
      assert.equal(sizes.length, 19);
      assert(sizes.every((r) => BigInt(r.bytes) < BigInt(previewLimit)));
      assert(Object.values(proofBefore).every((r) => r.count < 2000));
      await assertThresholdGuards();
      await thresholdTransaction(c);
      await assert.rejects(
        c.query(
          `INSERT INTO replenishment_previews
         SELECT (jsonb_populate_record(NULL::replenishment_previews,to_jsonb(p)||
           jsonb_build_object('id',$2::uuid,'client_key',$3::uuid,'byte_count',1,
             'config',p.config||jsonb_build_object('quota_padding',repeat('x',7864320))))).*
         FROM replenishment_previews p WHERE p.id=$1`,
          [p.id, randomUUID(), randomUUID()],
        ),
        (err: unknown) => {
          assert(err instanceof Error);
          assert.equal((err as Error & { code?: string }).code, 'P0001');
          assert.equal(err.message, 'Replenishment proof storage quota exceeded');
          return true;
        },
      );
      await c.query('ROLLBACK');
      assert.deepEqual(await thresholdFingerprint(evidence), proofBefore);
      assert.deepEqual(await thresholdFingerprint(businessNames), effectsBefore);
      await assertThresholdGuards();

      // Fit one additional legal, complete preview by sizing the typed JSON
      // record without writing it. No byte counter is trusted: INSERT still
      // passes through serialized_bytes, budget, scope, FK and complete guards.
      const boundaryId = randomUUID();
      let rowRecord: Row = (
        await c.query('SELECT to_jsonb(r) AS row FROM replenishment_rows r WHERE id=$1', [raw.id])
      ).rows[0].row;
      rowRecord = { ...rowRecord, id: randomUUID(), preview_id: boundaryId, byte_count: 1 };
      let rowBytes = 0,
        converged = false;
      for (let i = 0; i < 10; i++) {
        const sized = (
          await c.query(
            `SELECT to_jsonb(r) AS row,octet_length(to_jsonb(r)::text) AS bytes
          FROM jsonb_populate_record(NULL::replenishment_rows,$1::jsonb) r`,
            [JSON.stringify(rowRecord)],
          )
        ).rows[0];
        rowRecord = sized.row;
        rowBytes = Number(sized.bytes);
        if (Number(rowRecord.byte_count) === rowBytes) {
          converged = true;
          break;
        }
        rowRecord.byte_count = rowBytes;
      }
      assert(converged, 'typed row byte fixed point');
      const headBytes = Number(BigInt(storageLimit) - totalBytes - 256n) - rowBytes;
      assert(headBytes > 0 && headBytes + rowBytes < previewLimit);
      let headRecord: Row = (
        await c.query('SELECT to_jsonb(p) AS row FROM replenishment_previews p WHERE id=$1', [p.id])
      ).rows[0].row;
      headRecord = {
        ...headRecord,
        id: boundaryId,
        client_key: randomUUID(),
        byte_count: headBytes,
        config: { ...headRecord.config, quota_padding: '' },
      };
      const emptyHeadBytes = Number(
        (
          await c.query(
            `SELECT octet_length(to_jsonb(p)::text) AS bytes
        FROM jsonb_populate_record(NULL::replenishment_previews,$1::jsonb) p`,
            [JSON.stringify(headRecord)],
          )
        ).rows[0].bytes,
      );
      assert(headBytes >= emptyHeadBytes);
      headRecord.config.quota_padding = 'x'.repeat(headBytes - emptyHeadBytes);
      assert.equal(
        Number(
          (
            await c.query(
              `SELECT octet_length(to_jsonb(p)::text) AS bytes
        FROM jsonb_populate_record(NULL::replenishment_previews,$1::jsonb) p`,
              [JSON.stringify(headRecord)],
            )
          ).rows[0].bytes,
        ),
        headBytes,
      );
      await thresholdTransaction(c);
      await c.query(
        'INSERT INTO replenishment_previews SELECT (jsonb_populate_record(NULL::replenishment_previews,$1::jsonb)).*',
        [JSON.stringify({ ...headRecord, byte_count: 1 })],
      );
      await c.query(
        'INSERT INTO replenishment_rows SELECT (jsonb_populate_record(NULL::replenishment_rows,$1::jsonb)).*',
        [JSON.stringify({ ...rowRecord, byte_count: 1 })],
      );
      await c.query('SET CONSTRAINTS ALL IMMEDIATE');
      await c.query('COMMIT');
      await assertThresholdGuards();
      const nearLimit = await thresholdFingerprint(evidence);
      const filledBytes = Object.values(nearLimit).reduce((n, r) => n + BigInt(r.bytes), 0n);
      assert.equal(BigInt(storageLimit) - filledBytes, 256n);
      const boundarySize = (
        await pool.query(
          `SELECT p.byte_count+r.byte_count AS bytes
        FROM replenishment_previews p JOIN replenishment_rows r ON (r.tenant_id,r.preview_id)=(p.tenant_id,p.id)
        WHERE p.id=$1`,
          [boundaryId],
        )
      ).rows[0].bytes;
      assert(BigInt(boundarySize) < BigInt(previewLimit));
      assert.deepEqual(await thresholdFingerprint(businessNames), effectsBefore);
      const late = await execute(purchasePreview, approved);
      assert.equal(late.statusCode, 429, late.body);
      assert.equal(late.json().detail, 'Przekroczono limit przechowywania planów tej organizacji');
      // execute creates both draft groups before inserting its proof head.
      // Exact all-own-business hashes include every PO field/line, the private
      // created_order_ids/xid/source epoch, audit, stocks and all other effects.
      assert.deepEqual(await thresholdFingerprint(evidence), nearLimit);
      assert.deepEqual(await thresholdFingerprint(businessNames), effectsBefore);
      assert.equal(
        (
          await pool.query('SELECT count(*)::int AS n FROM purchase_orders WHERE tenant_id=$1', [
            tenant,
          ])
        ).rows[0].n,
        0,
      );
      assert.equal(
        (
          await pool.query(
            'SELECT count(*)::int AS n FROM purchase_order_lines WHERE tenant_id=$1',
            [tenant],
          )
        ).rows[0].n,
        0,
      );
      assert.equal(
        (
          await pool.query(
            'SELECT count(*)::int AS n FROM replenishment_executions WHERE tenant_id=$1 AND preview_id=$2',
            [tenant, purchasePreview.id],
          )
        ).rows[0].n,
        0,
      );
      await assertThresholdGuards();
      t.diagnostic(
        `Actual proof bytes ${filledBytes}; remaining 256 bytes; two suppliers/currencies; late execute 429; ${businessNames.length} business-table and four evidence SHA256 unchanged; zero partial PO/lines.`,
      );
      assert.equal(providerCalls, 0);
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  },
);

test(
  'actual quota threshold 2000 complete executions permits exact API replays and blocks new preview or duplicate execution',
  { timeout: 120000 },
  async () => {
    const { f, p, approved, e } = await thresholdNop(),
      c = await pool.connect();
    const effectsBefore = await thresholdFingerprint(thresholdEffects);
    try {
      await thresholdTransaction(c);
      await c.query(`CREATE TEMP TABLE quota_copies ON COMMIT DROP AS
      SELECT gen_random_uuid() AS preview_id,gen_random_uuid() AS preview_key,
        gen_random_uuid() AS row_id,gen_random_uuid() AS execution_id,
        gen_random_uuid() AS execution_key,gen_random_uuid() AS execution_row_id
      FROM generate_series(1,1999)`);
      await c.query(
        `INSERT INTO replenishment_previews
      SELECT (jsonb_populate_record(NULL::replenishment_previews,to_jsonb(p)||
        jsonb_build_object('id',m.preview_id,'client_key',m.preview_key,'byte_count',1))).*
      FROM replenishment_previews p CROSS JOIN quota_copies m WHERE p.id=$1`,
        [p.id],
      );
      await c.query(
        `INSERT INTO replenishment_rows
      SELECT (jsonb_populate_record(NULL::replenishment_rows,to_jsonb(r)||
        jsonb_build_object('id',m.row_id,'preview_id',m.preview_id,'byte_count',1))).*
      FROM replenishment_rows r CROSS JOIN quota_copies m WHERE r.preview_id=$1`,
        [p.id],
      );
      await c.query(
        `INSERT INTO replenishment_executions
      SELECT (jsonb_populate_record(NULL::replenishment_executions,to_jsonb(e)||
        jsonb_build_object('id',m.execution_id,'preview_id',m.preview_id,
          'client_key',m.execution_key,'byte_count',1))).*
      FROM replenishment_executions e CROSS JOIN quota_copies m WHERE e.id=$1`,
        [e.id],
      );
      await c.query(
        `INSERT INTO replenishment_execution_rows
      SELECT (jsonb_populate_record(NULL::replenishment_execution_rows,to_jsonb(r)||
        jsonb_build_object('id',m.execution_row_id,'execution_id',m.execution_id,
          'preview_id',m.preview_id,'preview_row_id',m.row_id,'byte_count',1))).*
      FROM replenishment_execution_rows r CROSS JOIN quota_copies m WHERE r.execution_id=$1`,
        [e.id],
      );
      await c.query('SET CONSTRAINTS ALL IMMEDIATE');
      await c.query('COMMIT');
      const before = await thresholdFingerprint(evidence);
      for (const name of evidence) assert.equal(before[name].count, 2000, name);
      assert.equal(
        (
          await pool.query(
            `SELECT count(*)::int AS n FROM replenishment_executions e WHERE e.tenant_id=$1 AND
       (SELECT count(*) FROM replenishment_execution_rows r WHERE r.tenant_id=e.tenant_id AND r.execution_id=e.id)<>1`,
            [tenant],
          )
        ).rows[0].n,
        0,
      );
      assert(Object.values(before).reduce((n, r) => n + BigInt(r.bytes), 0n) < 134217728n);
      await assertThresholdGuards();
      const previewReplay = await request(prefix + '/previews', 'POST', f.body);
      assert.equal(previewReplay.statusCode, 200, previewReplay.body);
      assert.equal(previewReplay.json().reused, true);
      assert.deepEqual(previewReplay.json().preview, p);
      const executionReplay = await execute(p, approved);
      assert.equal(executionReplay.statusCode, 200, executionReplay.body);
      assert.equal(executionReplay.json().reused, true);
      assert.deepEqual(executionReplay.json().execution, e);
      const extraPreview = await request(prefix + '/previews', 'POST', {
        ...f.body,
        client_key: randomUUID(),
      });
      assert.equal(extraPreview.statusCode, 429, extraPreview.body);
      assert.match(extraPreview.body, /Osiągnięto limit trwałych planów/);
      const duplicateExecution = await execute(p, { ...approved, client_key: randomUUID() });
      assert.equal(duplicateExecution.statusCode, 409, duplicateExecution.body);
      assert.match(duplicateExecution.body, /Podgląd został już wykonany/);
      // Every execution has its own immutable preview. Consequently a valid
      // 2001st execution is unreachable while the preview cap is also 2000.
      // Assert the real unique constraint, never bypass it to force a dead quota branch.
      await thresholdTransaction(c);
      await assert.rejects(
        copiedRow(c, 'replenishment_executions', 'id=$1', [e.id], {
          id: randomUUID(),
          client_key: randomUUID(),
          byte_count: 1,
        }),
        (err: unknown) => {
          assert(err instanceof Error);
          const sql = err as Error & { code?: string; constraint?: string };
          assert.equal(sql.code, '23505');
          assert.equal(sql.constraint, 'replenishment_executions_tenant_id_preview_id_key');
          return true;
        },
      );
      await c.query('ROLLBACK');
      assert.deepEqual(await thresholdFingerprint(evidence), before);
      assert.deepEqual(await thresholdFingerprint(thresholdEffects), effectsBefore);
      await assertThresholdGuards();
      assert.equal(providerCalls, 0);
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  },
);

test('database-derived eight MiB budget and 2000-preview cap reject understated bytes without partial evidence', async () => {
  const f = await fixture(),
    p = await preview(f.body),
    before = await snapshot(),
    c = await pool.connect();
  try {
    await c.query('BEGIN');
    await assert.rejects(
      copiedRow(c, 'replenishment_previews', 'id=$1', [p.id], {
        id: randomUUID(),
        client_key: randomUUID(),
        byte_count: 1,
        config: { padding: 'x'.repeat(8388608) },
      }),
      /quota|eight MiB|storage/i,
    );
    await c.query('ROLLBACK');
    await c.query('BEGIN');
    await assert.rejects(
      c.query(
        `INSERT INTO replenishment_previews SELECT (jsonb_populate_record(NULL::replenishment_previews,to_jsonb(p)||jsonb_build_object('id',gen_random_uuid(),'client_key',gen_random_uuid(),'byte_count',1))).* FROM replenishment_previews p CROSS JOIN generate_series(1,2000) WHERE p.id=$1`,
        [p.id],
      ),
      /quota/i,
    );
    await c.query('ROLLBACK');
    assert.deepEqual(await snapshot(), before);
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
});

test('readonly denies every malformed mutation before parsing; absent module leaves old purchasing readable', async () => {
  const f = await fixture(),
    p = await preview(f.body),
    readonly = await buildApp({ readOnly: true, integrationTransport: transport });
  try {
    const cookie = await login('admin@demo.local', readonly);
    const switched = await request(
      '/workspaces/switch',
      'POST',
      { tenant_id: tenant },
      cookie,
      readonly,
    );
    assert.equal(switched.statusCode, 200);
    const ownCookie = String(switched.headers['set-cookie']).split(';')[0],
      before = await snapshot();
    for (const [method, path] of [
      ['POST', prefix + '/policies'],
      ['PATCH', prefix + '/policies/' + f.pol.id],
      ['POST', prefix + '/previews'],
      ['POST', prefix + '/previews/' + p.id + '/execute'],
    ]) {
      const r = await request(path, method, '{', ownCookie, readonly, {
        'content-type': 'application/json',
      });
      assert.equal(r.statusCode, 423);
      assert.equal(r.headers['cache-control'], 'no-store');
    }
    const read = await request(prefix + '/previews/' + p.id, 'GET', undefined, ownCookie, readonly);
    assert.equal(read.statusCode, 200, read.body);
    assert.equal(read.json().read_only, true);
    assert.equal(read.json().can_execute, false);
    assert.deepEqual(await snapshot(), before);
  } finally {
    await readonly.close();
  }
  await pool.query(
    'ALTER TABLE replenishment_execution_rows RENAME TO replenishment_execution_rows_unavailable',
  );
  let older: Awaited<ReturnType<typeof buildApp>> | undefined;
  try {
    older = await buildApp({ integrationTransport: transport });
    const options = await request(prefix + '/options', 'GET', undefined, admin, older);
    assert.equal(options.statusCode, 200, options.body);
    assert.equal(options.json().available, false);
    assert.equal(
      (await request(prefix + '/previews', 'POST', f.body, admin, older)).statusCode,
      503,
    );
    assert.equal(
      (await request('/purchase-orders', 'GET', undefined, admin, older)).statusCode,
      200,
    );
  } finally {
    await older?.close();
    await pool.query(
      'ALTER TABLE replenishment_execution_rows_unavailable RENAME TO replenishment_execution_rows',
    );
  }
});
