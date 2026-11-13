import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { buildApp } from '../server/app';
import { migrate, pool } from '../server/db';
import { seed } from './fixtures';
import { withoutApiKeyLastUse } from './api-key-last-use';

assert.equal(process.env.DYNA_TEST, 'true');
const database = new URL(process.env.DATABASE_URL ?? '');
assert(['localhost', '127.0.0.1', '[::1]'].includes(database.hostname));
assert.match(database.pathname, /^\/dynaminds_test_\d+$/);
type Row = Record<string, any>;
let app: Awaited<ReturnType<typeof buildApp>> | undefined;
let tenant = '',
  warehouse = '',
  adminId = '',
  admin = '',
  viewer = '',
  other = '',
  ip = 1;
let providerCalls = 0;
const prefix = '/catalog/file-imports';
const evidence = [
  'catalog_file_import_previews',
  'catalog_file_import_rows',
  'catalog_file_import_executions',
  'catalog_file_import_execution_rows',
];
const cookies = new Map<string, string>();
const transport = async () => {
  ++providerCalls;
  throw Error('Local catalog file imports cannot call providers');
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
    remoteAddress: '127.0.177.' + ip,
  });
}
async function ok(
  path: string,
  method: any = 'GET',
  payload?: any,
  cookie = admin,
  expected = 200,
) {
  const response = await request(path, method, payload, cookie);
  assert.equal(response.statusCode, expected, `${method} ${path}: ${response.body.slice(0, 700)}`);
  return response.json() as Row;
}
async function login(email: string, target = app) {
  const response = await request(
    '/auth/login',
    'POST',
    { email, password: 'DynaDemo!2026' },
    '',
    target,
  );
  assert.equal(response.statusCode, 200);
  return String(response.headers['set-cookie']).split(';')[0];
}
before(async () => {
  await migrate();
  await seed();
  app = await buildApp({
    integrationTransport: transport,
    logging: process.env.CATALOG_FILE_IMPORT_TEST_LOG === 'true',
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
    "INSERT INTO tenants(id,name,plan) VALUES($1,'File import adversarial','enterprise')",
    [tenant],
  );
  await pool.query(
    "INSERT INTO memberships(tenant_id,user_id,role) SELECT $1,id,CASE email WHEN 'viewer@demo.local' THEN 'viewer' ELSE 'admin' END FROM users WHERE email=ANY($2::text[])",
    [tenant, [...cookies.keys()]],
  );
  await pool.query(
    "INSERT INTO warehouses(id,tenant_id,name,code) VALUES($1,$2,'Import warehouse','FI')",
    [warehouse, tenant],
  );
  for (const [email, cookie] of cookies) {
    const response = await request('/workspaces/switch', 'POST', { tenant_id: tenant }, cookie);
    assert.equal(response.statusCode, 200);
    cookies.set(email, String(response.headers['set-cookie']).split(';')[0]);
  }
  admin = cookies.get('admin@demo.local')!;
  viewer = cookies.get('viewer@demo.local')!;
  other = cookies.get('other@demo.local')!;
});
after(async () => {
  try {
    await app?.close();
  } finally {
    await pool.end();
  }
});
async function product(extra: Row = {}) {
  return ok(
    '/products',
    'POST',
    {
      sku: 'FI-' + randomUUID(),
      name: 'Frozen product',
      price: 1234,
      quantity: 10,
      warehouse_id: warehouse,
      ...extra,
    },
    admin,
    201,
  );
}
const cell = (value: unknown) => '"' + String(value).replaceAll('"', '""') + '"';
function input(products: Row[], changes: Row = { name: 'Imported replacement' }, extra: Row = {}) {
  const fields = ['sku', ...Object.keys(changes)];
  return {
    client_key: randomUUID(),
    format: 'csv',
    warehouse_id: warehouse,
    currency: 'PLN',
    mode: 'update',
    identity: 'sku',
    empty_policy: 'skip',
    delimiter: ',',
    mapping: {},
    ignore_readonly_fields: false,
    content:
      fields.join(',') +
      '\r\n' +
      products
        .map((p) => fields.map((k) => cell(k === 'sku' ? p.sku : changes[k])).join(','))
        .join('\r\n') +
      '\r\n',
    ...extra,
  };
}
async function preview(body: Row) {
  return (await ok(prefix + '/preview', 'POST', body, admin, 201)).preview as Row;
}
const consent = (p: Row) => ({
  client_key: randomUUID(),
  scope_hash: p.scope_hash,
  confirmed: true,
});
const execute = (p: Row, body: Row = consent(p), cookie = admin) =>
  request(prefix + '/previews/' + p.id + '/execute', 'POST', body, cookie);
async function snapshot() {
  // IAM withdrawal itself is the explicit fixture mutation, not an import effect.
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
  return withoutApiKeyLastUse(result);
}
async function waitOn(holder: PoolClient, pattern: RegExp) {
  const pid = (await holder.query('SELECT pg_backend_pid() pid')).rows[0].pid,
    deadline = Date.now() + 2500;
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
  assert.fail('Import never actually waited on the independent catalog/product blocker');
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
async function key(scopes: string[]) {
  return ok('/developer/keys', 'POST', { name: 'File import key', scopes }, admin, 201);
}
function publicRequest(token: string, path: string, method: any = 'GET', body?: any) {
  return request('/v1' + path, method, body, '', app, { authorization: 'Bearer ' + token });
}
async function copyRow(c: PoolClient, table: string, where: string, values: unknown[], patch: Row) {
  assert(evidence.includes(table));
  await c.query(
    `INSERT INTO "${table}" SELECT (jsonb_populate_record(NULL::"${table}",to_jsonb(t)||$${values.length + 1}::jsonb)).* FROM "${table}" t WHERE ${where}`,
    [...values, JSON.stringify(patch)],
  );
}

test(
  'hostile XML, typed prototype data and bounded bytes are rejected before any durable import or business write',
  { timeout: 30000 },
  async () => {
    const p = await product(),
      base = input([p]),
      before = await snapshot();
    for (const content of [
      '<!DOCTYPE catalog [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><catalog><product><sku>' +
        p.sku +
        '</sku><name>&xxe;</name></product></catalog>',
      '<!DOCTYPE catalog SYSTEM "https://example.test/never-fetch.dtd"><catalog/>',
      '<catalog>' + '<x>'.repeat(17) + 'bad' + '</x>'.repeat(17) + '</catalog>',
      '<catalog>' + '<product/>'.repeat(100001) + '</catalog>',
    ]) {
      const response = await request(prefix + '/preview', 'POST', {
        ...base,
        format: 'xml',
        content,
      });
      assert.equal(response.statusCode, 422, response.body.slice(0, 700));
      assert.match(String(response.headers['cache-control']), /no-store/);
      assert.equal(response.json().preview, undefined);
    }
    const prototype = await request(prefix + '/preview', 'POST', {
      ...base,
      format: 'xml',
      content:
        '<catalog currency="PLN"><product><sku type="string">' +
        p.sku +
        '</sku><attributes_json type="object"><entry key="__proto__" type="object"><entry key="poison" type="boolean">true</entry></entry></attributes_json></product></catalog>',
    });
    assert.equal(prototype.statusCode, 422);
    const unicode = await request(prefix + '/preview', 'POST', {
      ...base,
      content: 'ą'.repeat(1100000),
    });
    assert.equal(
      unicode.statusCode,
      413,
      'UTF-8 file byte limit is enforced independently from string length and the 4 MiB request cap',
    );
    const huge = await request(prefix + '/preview', 'POST', {
      ...base,
      content: '🧵'.repeat(1100000),
    });
    assert.equal(huge.statusCode, 413, 'HTTP request byte limit precedes parsing');
    assert.deepEqual(await snapshot(), before);
    assert.equal(providerCalls, 0);
  },
);

test('read-only projections, compound public scopes and foreign IDs never grant import writes or leak foreign evidence', async () => {
  const p = await product(),
    body = input([p]),
    plan = await preview(body);
  const read = await key(['products:read']),
    write = await key(['products:write']),
    both = await key(['products:read', 'products:write']);
  for (const path of [prefix + '/options', prefix + '/previews/' + plan.id, prefix + '/history']) {
    const response = await request(path, 'GET', undefined, viewer);
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().can_write, false);
    const viaRead = await publicRequest(read.token, path);
    assert.equal(viaRead.statusCode, 200);
    assert.equal(viaRead.json().can_write, false);
    assert.equal((await publicRequest(write.token, path)).statusCode, 403);
  }
  const before = await snapshot();
  for (const cookie of [viewer])
    assert.equal((await request(prefix + '/preview', 'POST', body, cookie)).statusCode, 403);
  for (const token of [read.token, write.token])
    assert.equal((await publicRequest(token, prefix + '/preview', 'POST', body)).statusCode, 403);
  assert.equal((await request(prefix + '/previews/' + randomUUID())).statusCode, 404);
  assert.deepEqual(await snapshot(), before);
  const made = await publicRequest(
    both.token,
    prefix + '/preview',
    'POST',
    input([p], { category: 'Public import' }),
  );
  assert.equal(made.statusCode, 201, made.body);
  const foreignTenant = randomUUID(),
    foreignId = randomUUID();
  await pool.query("INSERT INTO tenants(id,name,plan) VALUES($1,'Foreign import','enterprise')", [
    foreignTenant,
  ]);
  await pool.query(
    "INSERT INTO products(id,tenant_id,sku,name,price) VALUES($1,$2,'FOREIGN-FILE-SECRET','Foreign hidden',1)",
    [foreignId, foreignTenant],
  );
  const foreignPlan = await preview({
    ...input([]),
    identity: 'id',
    content: 'id,name\r\n' + foreignId + ',Forbidden\r\n',
  });
  assert.equal(foreignPlan.ready, false);
  const detail = await ok(prefix + '/previews/' + foreignPlan.id);
  assert(!JSON.stringify(detail).includes('FOREIGN-FILE-SECRET'));
  assert(!JSON.stringify(detail).includes('Foreign hidden'));
  assert.equal(providerCalls, 0);
});

test(
  'preview waits on the real catalog advisory lock and then rejects a committed administrator withdrawal without history or audit',
  { timeout: 20000 },
  async () => {
    const p = await product(),
      body = input([p]),
      before = await snapshot(),
      holder = await pool.connect();
    let pending: ReturnType<typeof request> | undefined;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        'catalog:' + tenant,
      ]);
      pending = request(prefix + '/preview', 'POST', body);
      await waitOn(holder, /pg_advisory_xact_lock/);
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
  'execution waits on a real product row and late administrator withdrawal rolls back products, aliases, receipts, audit and jobs',
  { timeout: 20000 },
  async () => {
    const p = await product(),
      plan = await preview(input([p], { name: 'Denied import', ean: '117-denied' })),
      before = await snapshot(),
      holder = await pool.connect();
    let pending: ReturnType<typeof request> | undefined;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM products WHERE id=$1 FOR UPDATE', [p.id]);
      pending = execute(plan);
      await waitOn(holder, /products[\s\S]*FOR\s+(UPDATE|SHARE)/i);
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
  'current API revoke, expiry and removed write scope are enforced after actual product waits',
  { timeout: 30000 },
  async () => {
    for (const change of ['revoke', 'expire', 'scope']) {
      const p = await product(),
        credential = await key(['products:read', 'products:write']);
      const created = await publicRequest(
        credential.token,
        prefix + '/preview',
        'POST',
        input([p]),
      );
      assert.equal(created.statusCode, 201, created.body);
      const plan = created.json().preview;
      const before = await snapshot(),
        holder = await pool.connect();
      let pending: ReturnType<typeof request> | undefined;
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT id FROM products WHERE id=$1 FOR UPDATE', [p.id]);
        pending = publicRequest(
          credential.token,
          prefix + '/previews/' + plan.id + '/execute',
          'POST',
          consent(plan),
        );
        await waitOn(holder, /products[\s\S]*FOR\s+(UPDATE|SHARE)/i);
        await grantChange(
          change === 'revoke'
            ? 'UPDATE api_keys SET revoked_at=now() WHERE id=$1'
            : change === 'expire'
              ? "UPDATE api_keys SET expires_at=now()-interval '1 second' WHERE id=$1"
              : "UPDATE api_keys SET scopes=ARRAY['products:read']::text[] WHERE id=$1",
          [credential.id],
        );
        await holder.query('COMMIT');
        assert.equal((await pending).statusCode, change === 'scope' ? 403 : 401);
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
  'a distinct enabled-rule owner can be withdrawn during the final execution FK wait and every tentative import effect rolls back',
  { timeout: 20000 },
  async () => {
    const p = await product();
    const ownerId = (await pool.query("SELECT id FROM users WHERE email='other@demo.local'"))
      .rows[0].id;
    assert.notEqual(ownerId, adminId);
    const rule = await ok(
      '/product-rules',
      'POST',
      {
        client_key: randomUUID(),
        confirm_future_changes: true,
        definition: {
          name: 'Different author after-FK rule',
          event: 'product.updated',
          enabled: true,
          conditions: [],
          actions: [{ type: 'set_category', category: 'Only with current owner consent' }],
        },
      },
      other,
    );
    const storedRule = (
      await pool.query('SELECT approved_by,enabled FROM product_rules WHERE id=$1', [rule.id])
    ).rows[0];
    assert.equal(storedRule.approved_by, ownerId);
    assert.equal(storedRule.enabled, true);
    const plan = await preview(input([p], { name: 'Tentative product and rule writes' }));
    assert(plan.ready);
    assert.equal(plan.active_product_rules, 1);
    const before = await snapshot(),
      holder = await pool.connect();
    let pending: ReturnType<typeof request> | undefined;
    try {
      await holder.query('BEGIN');
      // getHead/scope reads remain possible; the genuine execution FK must wait
      // only after product writes and durable rule-job preparation are tentative.
      await holder.query('SELECT id FROM catalog_file_import_previews WHERE id=$1 FOR UPDATE', [
        plan.id,
      ]);
      pending = execute(plan);
      await waitOn(holder, /INSERT\s+INTO\s+catalog_file_import_executions/i);
      await grantChange("UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2", [
        tenant,
        ownerId,
      ]);
      assert.equal(
        (
          await pool.query('SELECT role FROM memberships WHERE tenant_id=$1 AND user_id=$2', [
            tenant,
            adminId,
          ])
        ).rows[0].role,
        'admin',
      );
      await holder.query('COMMIT');
      const response = await pending;
      assert.equal(response.statusCode, 403, response.body);
      assert.match(String(response.headers['cache-control']), /no-store/);
      assert.deepEqual(
        await snapshot(),
        before,
        'Includes products, aliases, rules, causes, jobs, audit and all import evidence',
      );
      assert.equal(providerCalls, 0);
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
      await pending;
    }
  },
);

test('canonical retries bind actor and original request while completed execution retries add no events, versions or quota', async () => {
  const p = await product(),
    body = input([p], {
      attributes_json: '{"Zebra":"last","Alpha":"first"}',
      name: 'Canonical import',
    });
  const plan = await preview(body),
    before = await snapshot();
  const reordered = Object.fromEntries(Object.entries(body).reverse());
  const replay = await ok(prefix + '/preview', 'POST', reordered);
  assert.equal(replay.reused, true);
  assert.equal(replay.preview.id, plan.id);
  assert.deepEqual(await snapshot(), before);
  assert.equal(
    (
      await request(prefix + '/preview', 'POST', {
        ...body,
        content: body.content.replace('Canonical import', 'Different import'),
      })
    ).statusCode,
    409,
  );
  assert.equal((await request(prefix + '/preview', 'POST', body, other)).statusCode, 409);
  assert.deepEqual(await snapshot(), before);
  const approve = consent(plan),
    made = await execute(plan, approve);
  assert.equal(made.statusCode, 201, made.body);
  const accepted = await snapshot();
  const again = await execute(plan, Object.fromEntries(Object.entries(approve).reverse()));
  assert.equal(again.statusCode, 200);
  assert.equal(again.json().reused, true);
  assert.equal(again.json().execution.id, made.json().execution.id);
  assert.deepEqual(await snapshot(), accepted);
  assert.equal((await execute(plan, { ...approve, scope_hash: 'f'.repeat(64) })).statusCode, 409);
  assert.equal((await execute(plan, approve, other)).statusCode, 409);
  assert.deepEqual(await snapshot(), accepted);
  const stored = (
    await pool.query('SELECT config,request_hash FROM catalog_file_import_previews WHERE id=$1', [
      plan.id,
    ])
  ).rows[0];
  assert.equal(stored.config.content, undefined);
  assert.match(stored.request_hash, /^[a-f0-9]{64}$/);
  assert.equal(providerCalls, 0);
});

test('genuine tenant FK, FORCE RLS, immutable evidence and frozen execution-row comparisons resist raw SQL tampering', async () => {
  const p = await product(),
    plan = await preview(input([p]));
  const made = await execute(plan);
  assert.equal(made.statusCode, 201, made.body);
  const execution = made.json().execution,
    before = await snapshot();
  const flags = (
    await pool.query(
      'SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class WHERE relname=ANY($1::text[])',
      [evidence],
    )
  ).rows;
  assert.equal(flags.length, 4);
  assert(flags.every((r) => r.relrowsecurity && r.relforcerowsecurity));
  for (const table of evidence) {
    await assert.rejects(
      pool.query(`DELETE FROM ${table} WHERE tenant_id=$1`, [tenant]),
      (e: any) => e.code === '23514',
    );
    await assert.rejects(
      pool.query(`UPDATE ${table} SET byte_count=byte_count WHERE tenant_id=$1`, [tenant]),
      (e: any) => e.code === '23514',
    );
  }
  const foreignTenant = randomUUID(),
    foreignId = randomUUID();
  await pool.query("INSERT INTO tenants(id,name) VALUES($1,'Foreign SQL')", [foreignTenant]);
  await pool.query(
    "INSERT INTO products(id,tenant_id,sku,name,price) VALUES($1,$2,'FOREIGN-SQL','Foreign SQL',1)",
    [foreignId, foreignTenant],
  );
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE dyna_app');
    await c.query("SELECT set_config('app.tenant_id',$1,true)", [foreignTenant]);
    for (const table of evidence)
      assert.equal(
        (await c.query(`SELECT count(*)::int n FROM ${table} WHERE tenant_id=$1`, [tenant])).rows[0]
          .n,
        0,
      );
    await c.query('ROLLBACK');
    await c.query('BEGIN');
    const newId = randomUUID();
    await copyRow(c, evidence[0], 'id=$1', [plan.id], { id: newId, client_key: randomUUID() });
    await assert.rejects(
      copyRow(c, evidence[1], 'preview_id=$1 AND index=0', [plan.id], {
        preview_id: newId,
        product_id: foreignId,
        resolved_product_id: foreignId,
      }),
      (e: any) => e.code === '23503',
    );
    await c.query('ROLLBACK');
    await c.query('BEGIN');
    const incomplete = randomUUID();
    await copyRow(c, evidence[0], 'id=$1', [plan.id], { id: incomplete, client_key: randomUUID() });
    await assert.rejects(c.query('COMMIT'), (e: any) => e.code === '23514');
    await c.query('ROLLBACK');
    const fresh = await preview(input([await ok('/products/' + p.id)], { name: 'Next approval' }));
    const approved = (
      await pool.query('SELECT * FROM catalog_file_import_rows WHERE preview_id=$1 AND index=0', [
        fresh.id,
      ])
    ).rows[0];
    const settled = await snapshot();
    await c.query('BEGIN');
    const newExecution = randomUUID();
    await copyRow(c, evidence[2], 'id=$1', [execution.id], {
      id: newExecution,
      preview_id: fresh.id,
      client_key: randomUUID(),
      scope_hash: fresh.scope_hash,
    });
    await assert.rejects(
      copyRow(c, evidence[3], 'execution_id=$1 AND index=0', [execution.id], {
        execution_id: newExecution,
        preview_id: fresh.id,
        before: approved.before,
        after: approved.after,
        before_version: approved.before.version,
        after_version: approved.before.version + 1,
        input: { ...approved.input, name: 'Unapproved injected name' },
        changed_fields: approved.changed_fields,
      }),
      (e: any) => e.code === '23514',
    );
    await c.query('ROLLBACK');
    assert.deepEqual(await snapshot(), settled);
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
  // Additional fresh preview is expected; no tampering ever commits.
  assert.deepEqual(
    (await snapshot()).catalog_file_import_executions,
    before.catalog_file_import_executions,
  );
  assert.equal(providerCalls, 0);
});

test(
  'SQL byte accounting includes row evidence and rejects oversized previews and the 2001st head without business writes',
  { timeout: 30000 },
  async () => {
    const p = await product(),
      plan = await preview(input([p])),
      before = await snapshot(),
      c = await pool.connect();
    try {
      for (const table of evidence.slice(0, 2)) {
        const rows = (
          await c.query(
            `SELECT byte_count,octet_length(to_jsonb(t)::text)::bigint measured FROM ${table} t WHERE tenant_id=$1`,
            [tenant],
          )
        ).rows;
        assert(rows.length);
        assert(rows.every((r) => r.byte_count === r.measured));
      }
      await c.query('BEGIN');
      const id = randomUUID();
      await copyRow(c, evidence[0], 'id=$1', [plan.id], { id, client_key: randomUUID() });
      await assert.rejects(
        copyRow(c, evidence[1], 'preview_id=$1 AND index=0', [plan.id], {
          preview_id: id,
          input: { description: 'x'.repeat(8388608) },
        }),
        (e: any) => e.code === 'P0001' && /eight MiB/.test(e.message),
      );
      await c.query('ROLLBACK');
      await c.query('BEGIN');
      const ids = Array.from({ length: 2000 }, () => ({ id: randomUUID(), key: randomUUID() }));
      await assert.rejects(
        c.query(
          `INSERT INTO catalog_file_import_previews SELECT (jsonb_populate_record(NULL::catalog_file_import_previews,to_jsonb(p)||jsonb_build_object('id',x.id,'client_key',x.key))).* FROM catalog_file_import_previews p CROSS JOIN jsonb_to_recordset($2::jsonb) x(id uuid,key uuid) WHERE p.id=$1`,
          [plan.id, JSON.stringify(ids)],
        ),
        (e: any) => e.code === 'P0001' && /history quota/.test(e.message),
      );
      await c.query('ROLLBACK');
      assert.deepEqual(await snapshot(), before);
      const approve = consent(plan);
      assert.equal((await execute(plan, approve)).statusCode, 201);
      const completed = await snapshot();
      assert.equal((await execute(plan, approve)).statusCode, 200);
      assert.deepEqual(await snapshot(), completed);
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  },
);

test(
  'stale target, component, parent or new SKU claim rejects all writes; concurrent independent consent has exactly one winner',
  { timeout: 20000 },
  async () => {
    const a = await product(),
      b = await product(),
      plan = await preview(input([a, b], { price_minor: '4567', name: 'Atomic changed' }));
    await pool.query('UPDATE products SET version=version+1 WHERE id=$1', [b.id]);
    const before = await snapshot();
    assert.equal((await execute(plan)).statusCode, 409);
    assert.deepEqual(await snapshot(), before);
    const component = await product(),
      bundle = await product({
        kind: 'bundle',
        quantity: 0,
        components: [{ product_id: component.id, quantity: 2 }],
      });
    const related = await preview(
      input([bundle], {
        bundle_components_json: JSON.stringify([{ product_id: component.id, quantity: 3 }]),
      }),
    );
    assert(related.ready);
    await pool.query('UPDATE products SET version=version+1 WHERE id=$1', [component.id]);
    const graph = await snapshot();
    assert.equal((await execute(related)).statusCode, 409);
    assert.deepEqual(await snapshot(), graph);
    const group = await product({ kind: 'group', quantity: 0 }),
      variant = await product({ kind: 'variant', parent_id: group.id });
    const parentPlan = await preview(
      input([variant], { name: 'Variant depends on frozen parent' }),
    );
    assert(parentPlan.ready);
    await pool.query('UPDATE products SET version=version+1 WHERE id=$1', [group.id]);
    const parentState = await snapshot();
    assert.equal((await execute(parentPlan)).statusCode, 409);
    assert.deepEqual(await snapshot(), parentState);
    const claimedSku = 'FI-claimed-' + randomUUID();
    const skuPlan = await preview({
      ...input([]),
      identity: 'id',
      content: 'id,sku,name\r\n' + a.id + ',' + claimedSku + ',Requested rename\r\n',
    });
    assert(skuPlan.ready);
    await product({ sku: claimedSku });
    const claimedState = await snapshot();
    assert.equal((await execute(skuPlan)).statusCode, 409);
    assert.deepEqual(await snapshot(), claimedState);
    const fresh = await preview(input([await ok('/products/' + a.id)], { category: 'One winner' }));
    const responses = await Promise.all([execute(fresh), execute(fresh)]);
    assert.deepEqual(responses.map((r) => r.statusCode).sort(), [201, 409]);
    assert.equal(
      (
        await pool.query(
          'SELECT count(*)::int n FROM catalog_file_import_executions WHERE preview_id=$1',
          [fresh.id],
        )
      ).rows[0].n,
      1,
    );
    assert.equal((await ok('/products/' + a.id)).version, a.version + 1);
  },
);

test('rule revision changes abort the whole import and unchanged imports preserve stock, reservations, order snapshots and event counts', async () => {
  const p = await product();
  const order = await ok(
    '/orders',
    'POST',
    {
      customer_name: 'Frozen buyer',
      email: 'file117@example.test',
      warehouse_id: warehouse,
      payment_mode: 'cod',
      items: [{ product_id: p.id, quantity: 2 }],
    },
    admin,
    201,
  );
  const created = await ok('/product-rules', 'POST', {
    client_key: randomUUID(),
    confirm_future_changes: true,
    definition: {
      name: 'Import rule',
      event: 'product.updated',
      enabled: true,
      conditions: [],
      actions: [{ type: 'set_category', category: 'Rule category' }],
    },
  });
  const plan = await preview(input([p]));
  await ok('/product-rules/' + created.id, 'PUT', {
    version: created.version,
    confirm_future_changes: true,
    definition: { ...created.definition, name: 'Revised import rule' },
  });
  const before = await snapshot();
  assert.equal((await execute(plan)).statusCode, 409);
  assert.deepEqual(await snapshot(), before);
  const noop = await preview(input([p], { name: p.name }));
  assert(noop.ready);
  assert.equal(noop.updated, 0);
  assert.equal(noop.unchanged, 1);
  const staged = await snapshot();
  const done = await execute(noop);
  assert.equal(done.statusCode, 201, done.body);
  const afterNoop = await snapshot();
  for (const [name, rows] of Object.entries(staged))
    if (!name.startsWith('catalog_file_import_') && name !== 'audit_events')
      assert.deepEqual(afterNoop[name], rows, 'NOP changed ' + name);
  assert.equal((await ok('/products/' + p.id)).version, p.version);
  const beforeReal = await snapshot(),
    real = await preview(input([p], { price_minor: '2345', name: 'New catalog name' }));
  const changed = await execute(real);
  assert.equal(changed.statusCode, 201, changed.body);
  const afterReal = await snapshot();
  for (const name of [
    'stock',
    'stock_locations',
    'stock_movements',
    'reservations',
    'reservation_locations',
    'orders',
    'order_items',
    'order_events',
    'listings',
    'outbound_events',
    'outbound_deliveries',
  ])
    assert.deepEqual(afterReal[name], beforeReal[name], 'PIM import changed ' + name);
  assert.equal(
    (
      await pool.query(
        'SELECT count(*)::int n FROM product_rule_causes WHERE tenant_id=$1 AND product_id=$2',
        [tenant, p.id],
      )
    ).rows[0].n,
    1,
  );
  assert(order.id);
  assert.equal(providerCalls, 0);
});

test(
  'read-only malformed writes return 423 before parsing and old copies advertise unavailable import while legacy catalogue export still works',
  { timeout: 30000 },
  async () => {
    const p = await product(),
      plan = await preview(input([p])),
      readonly = await buildApp({ readOnly: true, integrationTransport: transport });
    try {
      let cookie = await login('admin@demo.local', readonly);
      const switched = await request(
        '/workspaces/switch',
        'POST',
        { tenant_id: tenant },
        cookie,
        readonly,
      );
      assert.equal(switched.statusCode, 200);
      cookie = String(switched.headers['set-cookie']).split(';')[0];
      const before = await snapshot();
      for (const path of [prefix + '/preview', prefix + '/previews/' + plan.id + '/execute']) {
        const response = await request(path, 'POST', '{', cookie, readonly, {
          'content-type': 'application/json',
        });
        assert.equal(response.statusCode, 423);
        assert.match(String(response.headers['cache-control']), /no-store/);
      }
      for (const path of [
        prefix + '/options',
        prefix + '/previews/' + plan.id,
        prefix + '/history',
      ]) {
        const response = await request(path, 'GET', undefined, cookie, readonly);
        assert.equal(response.statusCode, 200);
        assert.equal(response.json().read_only, true);
        assert.equal(response.json().can_write, false);
      }
      assert.deepEqual(await snapshot(), before);
    } finally {
      await readonly.close();
    }
    let old: Awaited<ReturnType<typeof buildApp>> | undefined;
    const renamed: string[] = [];
    try {
      for (const table of evidence) {
        await pool.query(`ALTER TABLE ${table} RENAME TO ${table}_safety_hidden`);
        renamed.push(table);
      }
      old = await buildApp({ integrationTransport: transport });
      const metadata = await request(prefix + '/options', 'GET', undefined, admin, old);
      assert.equal(metadata.statusCode, 200);
      assert.equal(metadata.json().available, false);
      assert.equal(metadata.json().can_write, false);
      for (const path of [prefix + '/preview', prefix + '/previews/' + plan.id + '/execute'])
        assert.equal(
          (await request(path, 'POST', '{', admin, old, { 'content-type': 'application/json' }))
            .statusCode,
          503,
        );
      assert.equal(
        (await request('/products/' + p.id, 'GET', undefined, admin, old)).statusCode,
        200,
      );
      assert.equal(
        (
          await request(
            '/catalog/exports/file',
            'POST',
            { format: 'csv', columns: ['sku', 'name'], selection: 'selected', ids: [p.id] },
            admin,
            old,
          )
        ).statusCode,
        200,
      );
    } finally {
      await old?.close();
      for (const table of renamed.reverse())
        await pool.query(`ALTER TABLE ${table}_safety_hidden RENAME TO ${table}`);
    }
    assert.equal(providerCalls, 0);
  },
);
