import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { PoolClient } from 'pg';
import { buildApp } from '../server/app';
import { migrate, pool } from '../server/db';
import { seed, SECOND_TENANT } from './fixtures';
import { publicApiDocument } from '../server/developer-api';
import { withHistoricalCatalogModules } from './catalog-export-historical-fixture';
import { withoutApiKeyLastUse } from './api-key-last-use';
import {
  CATALOG_EXPORT_LIMITS,
  CATALOG_EXPORT_TEMP_DIR,
  openCatalogExport,
  spoolCatalogExport,
} from '../server/catalog-export';

assert.equal(process.env.DYNA_TEST, 'true');
const database = new URL(process.env.DATABASE_URL ?? '');
assert(['localhost', '127.0.0.1', '[::1]'].includes(database.hostname));
assert.match(database.pathname, /^\/dynaminds_test_\d+$/);

type Row = Record<string, any>;
let app: Awaited<ReturnType<typeof buildApp>>;
let tenant = '',
  warehouse = '',
  adminId = '',
  admin = '',
  viewer = '',
  ip = 1;
let providerCalls = 0;
const cookies = new Map<string, string>();
const spoolDirectory = CATALOG_EXPORT_TEMP_DIR;
const filePath = '/catalog/exports/file';
const optionsPath = '/catalog/exports/options';
const transport = async () => {
  ++providerCalls;
  throw new Error('Catalog export safety cannot call any provider');
};
const request = (
  path: string,
  method: any = 'GET',
  payload?: any,
  cookie = admin,
  target = app,
  headers: Record<string, string> = {},
) =>
  target.inject({
    url: '/api' + path,
    method,
    payload,
    headers: { cookie, ...headers },
    remoteAddress: '127.0.164.' + ip,
  });
async function ok(path: string, method: any = 'GET', payload?: any, cookie = admin, status = 200) {
  const r = await request(path, method, payload, cookie);
  assert.equal(r.statusCode, status, `${method} ${path}: ${r.statusCode}`);
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
    logging: process.env.CATALOG_EXPORT_TEST_LOG === 'true',
  });
  for (const email of ['admin@demo.local', 'viewer@demo.local'])
    cookies.set(email, await login(email));
  adminId = (await pool.query("SELECT id FROM users WHERE email='admin@demo.local'")).rows[0].id;
});
beforeEach(async () => {
  ++ip;
  providerCalls = 0;
  tenant = randomUUID();
  warehouse = randomUUID();
  await pool.query(
    "INSERT INTO tenants(id,name,plan) VALUES($1,'Catalog export adversarial','enterprise')",
    [tenant],
  );
  await pool.query(
    `INSERT INTO memberships(tenant_id,user_id,role)
    SELECT $1,id,CASE email WHEN 'admin@demo.local' THEN 'admin' ELSE 'viewer' END
    FROM users WHERE email=ANY($2::text[])`,
    [tenant, [...cookies.keys()]],
  );
  for (const [email, cookie] of cookies) {
    const r = await request('/workspaces/switch', 'POST', { tenant_id: tenant }, cookie);
    assert.equal(r.statusCode, 200);
    cookies.set(email, String(r.headers['set-cookie']).split(';')[0]);
  }
  admin = cookies.get('admin@demo.local')!;
  viewer = cookies.get('viewer@demo.local')!;
  await pool.query(
    "INSERT INTO warehouses(id,tenant_id,name,code) VALUES($1,$2,'Export warehouse','EX')",
    [warehouse, tenant],
  );
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
      sku: 'EXPORT-' + randomUUID(),
      name: 'Export own product',
      price: 1234,
      warehouse_id: warehouse,
      quantity: 7,
      ...extra,
    },
    admin,
    201,
  );
}
const input = (ids: string[], extra: Row = {}) => ({
  selection: 'selected',
  ids,
  columns: ['id', 'sku', 'ean', 'name'],
  format: 'csv',
  spreadsheet_safe: false,
  ...extra,
});
const actor = () => ({ tenantId: tenant, userId: adminId, role: 'admin' as const });
async function files() {
  return (
    await readdir(spoolDirectory).catch((error) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    })
  ).sort();
}
async function assertFiles(before: string[]) {
  const deadline = Date.now() + 2500;
  while (Date.now() < deadline) {
    if (JSON.stringify(await files()) === JSON.stringify(before)) return;
    await new Promise((done) => setTimeout(done, 10));
  }
  assert.deepEqual(
    await files(),
    before,
    'Only this test export must be cleaned, all earlier files retained',
  );
}
async function snapshot(excludeMembershipUsage = false) {
  // IAM is deliberately changed by grant-race tests. Every business/evidence table remains exact.
  const names = (
    await pool.query(`SELECT DISTINCT c.table_name FROM information_schema.columns c
    JOIN information_schema.tables t USING(table_schema,table_name)
    WHERE c.table_schema='public' AND c.column_name='tenant_id' AND t.table_type='BASE TABLE'
    AND c.table_name NOT IN ('memberships','api_keys','outbound_subscriptions') ORDER BY 1`)
  ).rows;
  const rows: Record<string, unknown> = {};
  for (const { table_name: name } of names) {
    assert(/^[a-z][a-z0-9_]*$/.test(name));
    const usageFilter =
      excludeMembershipUsage && name === 'workspace_usage' ? " AND resource<>'memberships'" : '';
    rows[name] = (
      await pool.query(
        `SELECT to_jsonb(t) row FROM "${name}" t WHERE tenant_id=$1${usageFilter} ORDER BY 1`,
        [tenant],
      )
    ).rows;
  }
  return withoutApiKeyLastUse(rows);
}
async function waitOnProductRead(holder: PoolClient) {
  const pid = (await holder.query('SELECT pg_backend_pid() pid')).rows[0].pid;
  const deadline = Date.now() + 2500;
  while (Date.now() < deadline) {
    const waiting = (
      await pool.query(
        `SELECT query FROM pg_stat_activity WHERE datname=current_database()
      AND wait_event_type='Lock' AND $1=ANY(pg_blocking_pids(pid))`,
        [pid],
      )
    ).rows;
    if (waiting.some((r) => /SELECT/i.test(r.query) && /FROM\s+products\b/i.test(r.query))) return;
    await new Promise((done) => setTimeout(done, 10));
  }
  assert.fail('The real export snapshot never waited on the independently held products table');
}
async function changeGrant(sql: string, values: unknown[]) {
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
async function consume(file: Awaited<ReturnType<typeof openCatalogExport>>) {
  try {
    const bytes: Buffer[] = [];
    for await (const part of file.stream)
      bytes.push(Buffer.isBuffer(part) ? part : Buffer.from(part));
    return Buffer.concat(bytes);
  } finally {
    await file.dispose();
  }
}

test('strict request and explicit own UUID selection reject ambiguous or private fields before file output', async () => {
  const p = await product({ name: 'OWN-EXPORT-SENTINEL' });
  const foreign = (
    await pool.query('SELECT id FROM products WHERE tenant_id=$1 LIMIT 1', [SECOND_TENANT])
  ).rows[0];
  assert(foreign, 'A genuine second-firm product is required');
  const before = await snapshot(),
    originalFiles = await files();
  for (const body of [
    { ...input([p.id]), credentials: true },
    input([p.id], { columns: ['name', 'credentials'] }),
    input([p.id], { columns: ['name', 'name'] }),
    input([p.id, p.id]),
    input([p.id, randomUUID()]),
    input([p.id, foreign.id]),
    input([], {}),
    { ...input([p.id]), selection: 'filtered' },
  ]) {
    const r = await request(filePath, 'POST', body);
    assert.equal(r.statusCode, 422);
    assert.match(String(r.headers['content-type']), /^application\/problem\+json(?:;|$)/);
    assert(!r.headers['content-disposition']);
    assert(!r.body.includes('OWN-EXPORT-SENTINEL'));
  }
  const tooLarge = await request(filePath, 'POST', {
    ...input([p.id]),
    unknown: '😀'.repeat(17000),
  });
  assert.equal(
    tooLarge.statusCode,
    413,
    '64 KiB request bound is measured in encoded bytes before schema',
  );
  await assertFiles(originalFiles);
  assert.deepEqual(await snapshot(), before);
  assert.equal(providerCalls, 0);
});

test('products read scope and viewer access suffice; write-only keys cannot export', async () => {
  const p = await product();
  const readKey = await ok(
    '/developer/keys',
    'POST',
    { name: 'Export read only', scopes: ['products:read'] },
    admin,
    201,
  );
  const writeKey = await ok(
    '/developer/keys',
    'POST',
    { name: 'Export wrong scope', scopes: ['products:write'] },
    admin,
    201,
  );
  const before = await snapshot(),
    originalFiles = await files();
  const headersList: Record<string, string>[] = [{}, { authorization: 'Bearer ' + readKey.token }];
  for (const headers of headersList) {
    const prefix = headers.authorization ? '/v1' : '';
    const cookie = headers.authorization ? '' : viewer;
    const options = await request(
      prefix + optionsPath + '?selection=selected&ids=' + p.id,
      'GET',
      undefined,
      cookie,
      app,
      headers,
    );
    assert.equal(
      options.statusCode,
      200,
      `Read-only options access: ${options.body.slice(0, 1000)}`,
    );
    assert.equal(options.json().can_read, true);
    assert.equal(options.json().count.matched_products, 1);
    for (const format of ['csv', 'xml']) {
      const file = await request(
        prefix + filePath + '?selection=selected&ids=' + p.id + '&columns=id,sku&format=' + format,
        'GET',
        undefined,
        cookie,
        app,
        headers,
      );
      assert.equal(file.statusCode, 200, `Read-only GET file: ${file.body.slice(0, 1000)}`);
      assert(file.body.includes(p.id));
      assert(file.body.includes(p.sku));
      assert.match(
        String(file.headers['content-type']),
        format === 'csv' ? /^text\/csv/ : /^application\/xml/,
      );
      assert.equal(Number(file.headers['content-length']), Buffer.byteLength(file.body));
      assert.match(String(file.headers['cache-control']), /no-store/);
    }
    const r = await request(
      headers.authorization ? '/v1' + filePath : filePath,
      'POST',
      input([p.id]),
      headers.authorization ? '' : viewer,
      app,
      headers,
    );
    assert.equal(r.statusCode, 200, `Read-only export access: ${r.body.slice(0, 1000)}`);
    assert(r.body.includes(p.id));
    assert.match(String(r.headers['cache-control']), /no-store/);
  }
  const denied = await request('/v1' + filePath, 'POST', input([p.id]), '', app, {
    authorization: 'Bearer ' + writeKey.token,
  });
  assert.equal(denied.statusCode, 403);
  for (const path of [optionsPath, filePath]) {
    const deniedGet = await request('/v1' + path, 'GET', undefined, '', app, {
      authorization: 'Bearer ' + writeKey.token,
    });
    assert.equal(deniedGet.statusCode, 403);
  }
  const documentResponse = await request('/v1/openapi');
  assert.equal(documentResponse.statusCode, 200);
  const document = documentResponse.json() as Row;
  for (const [path, method] of [
    [optionsPath, 'get'],
    [filePath, 'get'],
    [filePath, 'post'],
  ]) {
    const operation = document.paths[path]?.[method];
    assert(operation, `Actual OpenAPI must register ${method} ${path}`);
    assert.match(operation.description, /products:read/);
    assert.deepEqual(operation.security, [{ bearerAuth: [] }]);
  }
  const post = document.paths[filePath].post;
  const schema = post.requestBody.content['application/json'].schema;
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.ids.type, 'array');
  assert.equal(schema.properties.ids.maxItems, 500);
  assert.equal(schema.properties.columns.type, 'array');
  assert(!Object.hasOwn(schema.properties, 'credentials'));
  for (const path of [optionsPath, filePath]) {
    assert.deepEqual(
      document.paths[path].get.parameters
        .filter((p: Row) => p.in === 'query')
        .map((p: Row) => p.name)
        .sort(),
      (path === optionsPath
        ? ['selection', 'ids', 'search', 'active', 'catalog_id']
        : [
            'selection',
            'ids',
            'search',
            'active',
            'format',
            'columns',
            'headers',
            'spreadsheet_safe',
            'warehouse_ids',
            'price_list_ids',
            'catalog_id',
            'catalog_version',
            'scope_hash',
          ]
      ).sort(),
    );
  }
  for (const method of ['get', 'post']) {
    const content = document.paths[filePath][method].responses['200'].content;
    assert.equal(content['text/csv'].schema.format, 'binary');
    assert.equal(content['application/xml'].schema.format, 'binary');
  }
  const readonlyDocument = publicApiDocument({ readOnly: true }) as Row;
  assert.match(readonlyDocument.paths[filePath].post.description, /products:read/);
  assert.equal(
    readonlyDocument.paths[filePath].post.requestBody.content['application/json'].schema
      .additionalProperties,
    false,
  );
  assert.deepEqual(
    Object.entries(readonlyDocument.paths).flatMap(([path, methods]) =>
      Object.keys(methods as Row)
        .filter((method) => method !== 'get')
        .map((method) => `${method} ${path}`),
    ),
    ['post ' + filePath, 'post /catalog/exports/preview'],
    'Readonly OpenAPI admits only pure read file/preview POST and no mutations',
  );
  await assertFiles(originalFiles);
  assert.deepEqual(await snapshot(), before);
});

test(
  'membership withdrawal commits during a genuine export read wait and no prepared file escapes',
  { timeout: 15000 },
  async () => {
    const p = await product(),
      before = await snapshot(),
      businessBefore = await snapshot(true),
      originalFiles = await files();
    const membershipUsageBefore = (
      await pool.query(
        "SELECT to_jsonb(t) row FROM workspace_usage t WHERE tenant_id=$1 AND resource='memberships' ORDER BY 1",
        [tenant],
      )
    ).rows;
    assert.equal(membershipUsageBefore.length, 1);
    assert.equal(membershipUsageBefore[0].row.used, 2);
    const holder = await pool.connect();
    let pending: ReturnType<typeof openCatalogExport> | undefined;
    try {
      await holder.query('BEGIN');
      await holder.query('LOCK TABLE products IN ACCESS EXCLUSIVE MODE');
      pending = openCatalogExport(actor(), input([p.id]));
      void pending.catch(() => {});
      await waitOnProductRead(holder);
      await changeGrant('DELETE FROM memberships WHERE tenant_id=$1 AND user_id=$2', [
        tenant,
        adminId,
      ]);
      await holder.query('COMMIT');
      await assert.rejects(pending, (error: any) => error.status === 403);
      await assertFiles(originalFiles);
      assert.deepEqual(await snapshot(true), businessBefore);
      const membershipUsageAfter = (
        await pool.query(
          "SELECT to_jsonb(t) row FROM workspace_usage t WHERE tenant_id=$1 AND resource='memberships' ORDER BY 1",
          [tenant],
        )
      ).rows;
      assert.deepEqual(
        membershipUsageAfter,
        [{ row: { ...membershipUsageBefore[0].row, used: 1 } }],
        'Only the deliberate membership DELETE changes its IAM quota counter',
      );
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
      await pending?.catch(() => {});
      // Restore only this deliberately removed grant; later fixtures keep their valid session.
      await pool.query(
        "INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'admin') ON CONFLICT (tenant_id,user_id) DO NOTHING",
        [tenant, adminId],
      );
    }
    await assertFiles(originalFiles);
    assert.deepEqual(await snapshot(), before);
    assert.equal(providerCalls, 0);
  },
);

test(
  'current API revoke, expiry and read-scope loss override a previously authenticated export snapshot',
  { timeout: 25000 },
  async () => {
    const p = await product();
    for (const kind of ['revoke', 'expire', 'scope']) {
      const key = await ok(
        '/developer/keys',
        'POST',
        { name: 'Export wait ' + kind, scopes: ['products:read'] },
        admin,
        201,
      );
      const before = await snapshot(),
        originalFiles = await files(),
        holder = await pool.connect();
      let pending: ReturnType<typeof openCatalogExport> | undefined;
      try {
        await holder.query('BEGIN');
        await holder.query('LOCK TABLE products IN ACCESS EXCLUSIVE MODE');
        pending = openCatalogExport({ ...actor(), apiKeyId: key.id }, input([p.id]));
        void pending.catch(() => {});
        await waitOnProductRead(holder);
        await changeGrant(
          kind === 'revoke'
            ? 'UPDATE api_keys SET revoked_at=now() WHERE id=$1'
            : kind === 'expire'
              ? "UPDATE api_keys SET expires_at=now()-interval '1 second' WHERE id=$1"
              : "UPDATE api_keys SET scopes=ARRAY['products:write']::text[] WHERE id=$1",
          [key.id],
        );
        await holder.query('COMMIT');
        await assert.rejects(
          pending,
          (error: any) => error.status === (kind === 'scope' ? 403 : 401),
        );
      } finally {
        await holder.query('ROLLBACK');
        holder.release();
        await pending?.catch(() => {});
      }
      await assertFiles(originalFiles);
      assert.deepEqual(await snapshot(), before);
    }
  },
);

test('XML control failure in a later record rejects the entire spool before response headers', async () => {
  const products = [
    await product({ description: 'XML-FIRST-RECORD' }),
    await product({ description: 'XML-SECOND-RECORD' }),
  ];
  const last = [...products].sort((a, b) => a.id.localeCompare(b.id)).at(-1)!;
  // Existing PIM permits this character. An export must reject it, never silently strip it.
  await pool.query('UPDATE products SET description=$1 WHERE tenant_id=$2 AND id=$3', [
    'XML\u0001ILLEGAL',
    tenant,
    last.id,
  ]);
  const before = await snapshot(),
    originalFiles = await files();
  const r = await request(
    filePath,
    'POST',
    input(
      products.map((p) => p.id),
      { format: 'xml', columns: ['description'] },
    ),
  );
  assert.equal(r.statusCode, 422);
  assert.match(String(r.headers['content-type']), /^application\/problem\+json(?:;|$)/);
  assert(!r.headers['content-disposition']);
  assert(!r.body.includes('<catalog'));
  assert(!r.body.includes('XML-FIRST-RECORD'));
  assert(!r.body.includes('XML-SECOND-RECORD'));
  await assertFiles(originalFiles);
  assert.deepEqual(await snapshot(), before);
});

test(
  'production spool enforces the real 64 MiB UTF8 bound and cleans up on producer failure',
  { timeout: 15000 },
  async () => {
    const originalFiles = await files();
    const chunk = '😀'.repeat(16384); // 65536 bytes, not 16384 bytes.
    let yielded = 0;
    async function* oversized() {
      for (let n = 0; n <= CATALOG_EXPORT_LIMITS.file_bytes / Buffer.byteLength(chunk); ++n) {
        ++yielded;
        yield chunk;
      }
    }
    await assert.rejects(spoolCatalogExport(oversized()), (error: any) => error.status === 413);
    assert.equal(yielded, 1025, 'Real 64 MiB threshold; no production override or capacity claim');
    await assertFiles(originalFiles);
    const injected = new Error('Own synthetic producer failed');
    async function* failed() {
      yield 'valid first record\r\n';
      throw injected;
    }
    await assert.rejects(spoolCatalogExport(failed()), (error) => error === injected);
    await assertFiles(originalFiles);
  },
);

test('private spool has restrictive permissions, exact Unicode bytes and idempotent owned cleanup', async () => {
  const originalFiles = await files();
  async function* text() {
    yield '00113,Łódź,😀\r\n';
    yield Buffer.from('tail\r\n', 'utf8');
  }
  const file = await spoolCatalogExport(text());
  try {
    const created = (await files()).filter((name) => !originalFiles.includes(name));
    assert.equal(created.length, 1);
    assert.equal((await stat(spoolDirectory)).mode & 0o777, 0o700);
    assert.equal((await stat(resolve(spoolDirectory, created[0]))).mode & 0o777, 0o600);
    assert.equal(file.bytes, Buffer.byteLength('00113,Łódź,😀\r\ntail\r\n'));
  } finally {
    await file.dispose();
    await file.dispose();
  }
  await assertFiles(originalFiles);
});

test('producer abort removes its partial private spool without changing earlier files', async () => {
  const originalFiles = await files(),
    controller = new AbortController();
  let returned = false;
  async function* interrupted() {
    try {
      yield Buffer.alloc(65536, 65);
      controller.abort();
      yield 'uncommitted second record';
    } finally {
      returned = true;
    }
  }
  await assert.rejects(
    spoolCatalogExport(interrupted(), controller.signal),
    (error: any) => error.status === 499,
  );
  assert.equal(returned, true, 'Cancellation must close the actual source iterator');
  await assertFiles(originalFiles);
});

test(
  'real client disconnect cancels a held export query and releases its one-tenant admission',
  { timeout: 15000 },
  async () => {
    const p = await product(),
      before = await snapshot(),
      originalFiles = await files();
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    const controller = new AbortController(),
      holder = await pool.connect();
    let pending: Promise<Response> | undefined;
    try {
      await holder.query('BEGIN');
      await holder.query('LOCK TABLE products IN ACCESS EXCLUSIVE MODE');
      pending = fetch(origin + '/api' + filePath, {
        method: 'POST',
        headers: { cookie: admin, 'Content-Type': 'application/json' },
        body: JSON.stringify(input([p.id])),
        signal: controller.signal,
      });
      void pending.catch(() => {});
      await waitOnProductRead(holder);
      await assert.rejects(
        openCatalogExport(actor(), input([p.id])),
        (error: any) => error.status === 429,
      );
      controller.abort();
      await assert.rejects(pending, (error: any) => error.name === 'AbortError');
      await holder.query('COMMIT');
    } finally {
      controller.abort();
      await holder.query('ROLLBACK');
      holder.release();
      await pending?.catch(() => {});
    }
    await assertFiles(originalFiles);
    // File cleanup can precede async request cleanup; wait only for the genuine slot.
    const deadline = Date.now() + 2500;
    let file: Awaited<ReturnType<typeof openCatalogExport>> | undefined;
    while (Date.now() < deadline && !file) {
      try {
        file = await openCatalogExport(actor(), input([p.id]));
      } catch (error: any) {
        assert.equal(error.status, 429);
        await new Promise((done) => setTimeout(done, 10));
      }
    }
    assert(file, 'Disconnected export must release the real per-tenant admission');
    assert((await consume(file)).toString('utf8').includes(p.id));
    await assertFiles(originalFiles);
    assert.deepEqual(await snapshot(), before);
    assert.equal(providerCalls, 0);
  },
);

test('read-only preview permits pure CSV/XML download while retaining strict parser and current ACL', async () => {
  const p = await product();
  let ro: Awaited<ReturnType<typeof buildApp>> | undefined;
  try {
    ro = await buildApp({ readOnly: true, integrationTransport: transport });
    let cookie = await login('admin@demo.local', ro);
    const switched = await request('/workspaces/switch', 'POST', { tenant_id: tenant }, cookie, ro);
    assert.equal(switched.statusCode, 200);
    cookie = String(switched.headers['set-cookie']).split(';')[0];
    const before = await snapshot(),
      originalFiles = await files();
    const options = await request(optionsPath, 'GET', undefined, cookie, ro);
    assert.equal(options.statusCode, 200);
    assert.equal(options.json().read_only, true);
    assert.equal(options.json().can_read, true);
    assert.match(String(options.headers['cache-control']), /no-store/);
    for (const format of ['csv', 'xml']) {
      const r = await request(filePath, 'POST', input([p.id], { format }), cookie, ro);
      assert.equal(r.statusCode, 200, r.body);
      assert(r.body.includes(p.id));
      assert.equal(Number(r.headers['content-length']), Buffer.byteLength(r.body));
      assert.match(String(r.headers['cache-control']), /no-store/);
    }
    const malformed = await request(filePath, 'POST', '{', cookie, ro, {
      'content-type': 'application/json',
    });
    assert.equal(
      malformed.statusCode,
      400,
      'Pure read POST is allowed, malformed JSON must still fail',
    );
    await assertFiles(originalFiles);
    assert.deepEqual(await snapshot(), before);
  } finally {
    await ro?.close();
  }
});

test('older optional PIM modules expose unavailable capabilities and preserve core export without writes', async () => {
  const p = await product(),
    before = await snapshot(),
    originalFiles = await files();
  const renamed: string[] = [];
  await withHistoricalCatalogModules(pool, async () => {
  try {
    // Read-only compatibility simulation; no product INSERT/UPDATE runs while aliases are renamed.
    for (const table of ['product_logistics', 'product_translations', 'product_sku_aliases']) {
      await pool.query(`ALTER TABLE ${table} RENAME TO ${table}_hidden_export_safety`);
      renamed.push(table);
    }
    const meta = await request(optionsPath);
    assert.equal(meta.statusCode, 200);
    assert.equal(meta.json().product_logistics_available, false);
    assert.equal(meta.json().product_translations_available, false);
    const r = await request(
      filePath,
      'POST',
      input([p.id], {
        format: 'xml',
        columns: ['id', 'sku', 'weight_g', 'manufacturer', 'translations_json'],
      }),
    );
    assert.equal(r.statusCode, 200);
    assert(r.body.includes(p.id));
    assert(r.body.includes(p.sku));
    assert.match(r.body, /<weight_g nil="true"\s*\/>/);
    assert.match(r.body, /<manufacturer nil="true"\s*\/>/);
    assert.match(r.body, /<translations_json type="array"><\/translations_json>/);
  } finally {
    for (const table of renamed.reverse())
      await pool.query(`ALTER TABLE ${table}_hidden_export_safety RENAME TO ${table}`);
  }
  });
  await assertFiles(originalFiles);
  assert.deepEqual(await snapshot(), before);
});
