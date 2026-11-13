import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { PoolClient } from 'pg';
import { buildApp } from '../server/app';
import { migrate, pool } from '../server/db';
import { seed } from './fixtures';
import { openCatalogExport } from '../server/catalog-export';
import { withHistoricalCatalogModules } from './catalog-export-historical-fixture';
import { withoutApiKeyLastUse } from './api-key-last-use';
import { assertPimIncomplete, tenantDataDigest } from './torn-module-fixture';

assert.equal(process.env.DYNA_TEST, 'true');
const database = new URL(process.env.DATABASE_URL ?? '');
assert(['localhost', '127.0.0.1', '[::1]'].includes(database.hostname));
assert.match(database.pathname, /^\/dynaminds_test_\d+$/);
type Row = Record<string, any>;
let app: Awaited<ReturnType<typeof buildApp>> | undefined;
let tenant = '',
  warehouse = '',
  emptyWarehouse = '',
  list = '',
  adminId = '',
  admin = '',
  viewer = '',
  ip = 1;
let providerCalls = 0;
const cookies = new Map<string, string>();
const transport = async () => {
  ++providerCalls;
  throw new Error('Source exports cannot call providers');
};
const request = (
  path: string,
  method: any = 'GET',
  payload?: any,
  cookie = admin,
  target = app,
  headers: Record<string, string> = {},
) => {
  assert(target);
  return target.inject({
    url: '/api' + path,
    method,
    payload,
    headers: { cookie, ...headers },
    remoteAddress: '127.0.166.' + ip,
  });
};
async function ok(path: string, method: any = 'GET', payload?: any, cookie = admin, status = 200) {
  const r = await request(path, method, payload, cookie);
  assert.equal(r.statusCode, status, `${method} ${path}: ${r.body.slice(0, 1000)}`);
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
    logging: process.env.CATALOG_EXPORT_SOURCE_TEST_LOG === 'true',
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
  emptyWarehouse = randomUUID();
  list = randomUUID();
  await pool.query(
    "INSERT INTO tenants(id,name,plan) VALUES($1,'Source export safety','enterprise')",
    [tenant],
  );
  await pool.query(
    `INSERT INTO memberships(tenant_id,user_id,role)
    SELECT $1,id,CASE email WHEN 'admin@demo.local' THEN 'admin' ELSE 'viewer' END FROM users WHERE email=ANY($2::text[])`,
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
    "INSERT INTO warehouses(id,tenant_id,name,code) VALUES($1,$3,'Own warehouse source','SRC'),($2,$3,'Own empty warehouse','EMPTY')",
    [warehouse, emptyWarehouse, tenant],
  );
  await pool.query(
    "INSERT INTO price_lists(id,tenant_id,name,currency,active,fallback) VALUES($1,$2,'Own source list','PLN',true,false)",
    [list, tenant],
  );
});
after(async () => {
  try {
    await app?.close();
  } finally {
    await pool.end();
  }
});
const actor = (apiKeyId?: string) => ({
  tenantId: tenant,
  userId: adminId,
  role: 'admin' as const,
  ...(apiKeyId ? { apiKeyId } : {}),
});
const definition = (extra: Row = {}) => ({
  format: 'csv',
  columns: ['sku', 'inventory_json', 'prices_json'],
  headers: {},
  spreadsheet_safe: false,
  warehouse_ids: [warehouse],
  price_list_ids: [list],
  ...extra,
});
const input = (ids: string[], extra: Row = {}) => ({
  ...definition(),
  selection: 'selected',
  ids,
  ...extra,
});
async function product(extra: Row = {}) {
  const p = await ok(
    '/products',
    'POST',
    {
      sku: 'SOURCES-' + randomUUID(),
      name: 'Before source snapshot',
      price: 1234,
      quantity: 7,
      location: 'A-01',
      warehouse_id: warehouse,
      ...extra,
    },
    admin,
    201,
  );
  await pool.query(
    'INSERT INTO price_list_items(tenant_id,price_list_id,product_id,price) VALUES($1,$2,$3,4567)',
    [tenant, list, p.id],
  );
  return p;
}
async function key(scopes: string[]) {
  return ok('/developer/keys', 'POST', { name: 'Source export safety', scopes }, admin, 201);
}
async function snapshot() {
  const names = (
    await pool.query(`SELECT DISTINCT c.table_name FROM information_schema.columns c
    JOIN information_schema.tables t USING(table_schema,table_name) WHERE c.table_schema='public'
    AND c.column_name='tenant_id' AND t.table_type='BASE TABLE'
    AND c.table_name NOT IN ('memberships','api_keys','outbound_subscriptions') ORDER BY 1`)
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
async function waitOn(holder: PoolClient, pattern: RegExp, relation?: 'warehouses' | 'stock') {
  const pid = (await holder.query('SELECT pg_backend_pid() pid')).rows[0].pid,
    deadline = Date.now() + 2500;
  while (Date.now() < deadline) {
    const rows = (
      await pool.query(
        `SELECT query FROM pg_stat_activity WHERE datname=current_database()
      AND wait_event_type='Lock' AND $1=ANY(pg_blocking_pids(pid))
      AND ($2::text IS NULL OR EXISTS(SELECT 1 FROM pg_locks l WHERE l.pid=pg_stat_activity.pid
        AND l.locktype='relation' AND l.relation=to_regclass('public.'||$2) AND NOT l.granted))`,
        [pid, relation ?? null],
      )
    ).rows;
    if (rows.some((r) => pattern.test(r.query))) return;
    await new Promise((done) => setTimeout(done, 10));
  }
  assert.fail('Actual export never waited on the independently held source table');
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
    const parts: Buffer[] = [];
    for await (const chunk of file.stream) parts.push(Buffer.from(chunk));
    return Buffer.concat(parts).toString('utf8');
  } finally {
    await file.dispose();
  }
}
function csv(text: string): Row[] {
  const rows: string[][] = [];
  let row: string[] = [],
    cell = '',
    quoted = false;
  text = text.replace(/^\ufeff/, '');
  for (let i = 0; i < text.length; ++i) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') {
        cell += '"';
        ++i;
      } else quoted = !quoted;
    } else if (!quoted && c === ',') {
      row.push(cell);
      cell = '';
    } else if (!quoted && (c === '\r' || c === '\n')) {
      if (c === '\r' && text[i + 1] === '\n') ++i;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  assert.equal(quoted, false);
  assert.equal(cell, '');
  assert.deepEqual(row, []);
  const headers = rows.shift();
  assert(headers);
  return rows.map((r) => {
    assert.equal(r.length, headers.length);
    return Object.fromEntries(headers.map((h, i) => [h, r[i]]));
  });
}

test('097 validates explicit bounded UUID source configuration and does not rewrite any old profile receipt or identity', async () => {
  const old = { format: 'csv', columns: ['sku', 'name'], headers: {}, spreadsheet_safe: true };
  const body = { name: 'Old literal definition', definition: old, client_key: randomUUID() };
  const created = await ok('/catalog/export-profiles', 'POST', body, admin, 201);
  const before = await snapshot();
  const stored = (
    await pool.query(
      'SELECT definition,initial_request,request_hash FROM catalog_export_profiles WHERE id=$1',
      [created.profile.id],
    )
  ).rows[0];
  assert.deepEqual(stored.definition, old);
  assert.deepEqual(stored.initial_request, { name: body.name, definition: old });
  assert(!Object.hasOwn(stored.definition, 'warehouse_ids'));
  assert(!Object.hasOwn(stored.definition, 'price_list_ids'));
  const currentValidator = (await pool.query("SELECT oid,proowner,proacl,pg_get_functiondef(oid) definition FROM pg_proc WHERE oid='public.catalog_export_profile_definition_valid(jsonb)'::regprocedure")).rows[0];
  try {
    await pool.query(
      await readFile(new URL('../server/097_catalog_export_sources.sql', import.meta.url), 'utf8'),
    );
  assert.deepEqual(await snapshot(), before);
  const valid = {
    ...definition(),
    columns: [
      'id',
      'sku',
      'ean',
      'name',
      'description',
      'price_minor',
      'vat_rate',
      'category',
      'active',
      'kind',
      'weight_g',
      'length_mm',
      'width_mm',
      'height_mm',
      'manufacturer',
      'attributes_json',
      'images_json',
      'variants_json',
      'bundle_components_json',
      'translations_json',
      'inventory_json',
      'prices_json',
    ],
  };
  const examples = [
    { ...valid, warehouse_ids: undefined },
    { ...valid, price_list_ids: undefined },
    { ...valid, warehouse_ids: [] },
    { ...valid, warehouse_ids: [warehouse, warehouse] },
    { ...valid, warehouse_ids: ['11111111-AAAA-4AAA-8AAA-111111111111'] },
    { ...valid, warehouse_ids: [warehouse.replace(/-/g, '')] },
    { ...valid, warehouse_ids: [null] },
    { ...valid, warehouse_ids: Array.from({ length: 11 }, () => randomUUID()) },
    { ...old, warehouse_ids: [warehouse] },
    { ...old, price_list_ids: [list] },
    { ...valid, headers: { inventory_json: 'Same', prices_json: 'same' } },
    { ...valid, format: null },
  ];
  assert.equal(
    (
      await pool.query('SELECT catalog_export_profile_definition_valid($1::jsonb) valid', [
        JSON.stringify(valid),
      ])
    ).rows[0].valid,
    true,
  );
  for (const invalid of examples) {
    assert.equal(
      (
        await pool.query('SELECT catalog_export_profile_definition_valid($1::jsonb) valid', [
          JSON.stringify(invalid),
        ])
      ).rows[0].valid,
      false,
    );
  }
  } finally {
    // Keep the exact current validator/OID/ACL contract; restoring 097 would
    // leave installed 143 deliberately torn for every following scope test.
    await pool.query(currentValidator.definition);
    assert.deepEqual((await pool.query("SELECT oid,proowner,proacl,pg_get_functiondef(oid) definition FROM pg_proc WHERE oid='public.catalog_export_profile_definition_valid(jsonb)'::regprocedure")).rows[0], currentValidator);
  }
  const replay = await ok('/catalog/export-profiles', 'POST', body);
  assert.equal(replay.reused, true);
  assert.deepEqual(await snapshot(), before);
});

test('inventory scope gates metadata and actual values while product-only configuration and price reads remain permitted', async () => {
  const p = await product();
  const productRead = await key(['products:read']);
  const manager = await key(['products:read', 'products:write']);
  const inventory = await key(['products:read', 'inventory:read']);
  const before = await snapshot();
  const meta = await request('/v1/catalog/exports/options', 'GET', undefined, '', app, {
    authorization: 'Bearer ' + productRead.token,
  });
  assert.equal(meta.statusCode, 200, meta.body);
  assert.equal(meta.json().sources.allow_inventory, false);
  assert.equal(meta.json().sources.warehouses.available, true);
  assert.deepEqual(meta.json().sources.warehouses.data, []);
  assert(!meta.body.includes('Own warehouse source'));
  assert(!meta.body.includes(warehouse));
  assert(meta.json().sources.price_lists.data.some((x: Row) => x.id === list));
  const stockMeta = await request('/v1/catalog/exports/options', 'GET', undefined, '', app, {
    authorization: 'Bearer ' + inventory.token,
  });
  assert.equal(stockMeta.statusCode, 200, stockMeta.body);
  assert.equal(stockMeta.json().sources.allow_inventory, true);
  assert(stockMeta.json().sources.warehouses.data.some((x: Row) => x.id === warehouse));
  for (const endpoint of ['/catalog/exports/file', '/catalog/exports/preview']) {
    const denied = await request('/v1' + endpoint, 'POST', input([p.id]), '', app, {
      authorization: 'Bearer ' + productRead.token,
    });
    assert.equal(denied.statusCode, 403, denied.body);
    assert(!denied.headers['content-disposition']);
    assert(!denied.body.includes('Own warehouse source'));
  }
  const priceOnly = input([p.id], { columns: ['sku', 'prices_json'], warehouse_ids: undefined });
  const priced = await request('/v1/catalog/exports/preview', 'POST', priceOnly, '', app, {
    authorization: 'Bearer ' + productRead.token,
  });
  assert.equal(priced.statusCode, 200, priced.body);
  assert.equal(priced.json().sample[0].prices_json[0].effective_price_minor, 4567);
  assert.deepEqual(await snapshot(), before);
  const saved = await request(
    '/v1/catalog/export-profiles',
    'POST',
    {
      name: 'Configuration without stock privilege',
      definition: definition(),
      client_key: randomUUID(),
    },
    '',
    app,
    { authorization: 'Bearer ' + manager.token },
  );
  assert.equal(saved.statusCode, 201, saved.body);
  assert.equal(saved.json().profile.definition.warehouse_ids[0], warehouse);
  assert.equal(providerCalls, 0);
});

test('foreign, missing and inactive sources are rejected atomically for preview, download and new profile configuration', async () => {
  const p = await product(),
    foreignTenant = randomUUID(),
    foreignWarehouse = randomUUID(),
    foreignList = randomUUID();
  await pool.query(
    "INSERT INTO tenants(id,name,plan) VALUES($1,'Foreign export sources','enterprise')",
    [foreignTenant],
  );
  await pool.query(
    "INSERT INTO warehouses(id,tenant_id,name,code) VALUES($1,$2,'FOREIGN-WH-SENTINEL','FOREIGN')",
    [foreignWarehouse, foreignTenant],
  );
  await pool.query(
    "INSERT INTO price_lists(id,tenant_id,name,currency) VALUES($1,$2,'FOREIGN-LIST-SENTINEL','PLN')",
    [foreignList, foreignTenant],
  );
  const inactive = randomUUID();
  await pool.query(
    "INSERT INTO price_lists(id,tenant_id,name,currency,active) VALUES($1,$2,'Inactive list','PLN',false)",
    [inactive, tenant],
  );
  const before = await snapshot();
  for (const change of [
    { warehouse_ids: [foreignWarehouse] },
    { warehouse_ids: [randomUUID()] },
    { price_list_ids: [foreignList] },
    { price_list_ids: [randomUUID()] },
    { price_list_ids: [inactive] },
  ]) {
    for (const path of ['/catalog/exports/preview', '/catalog/exports/file']) {
      const response = await request(path, 'POST', input([p.id], change));
      assert.equal(response.statusCode, 422, response.body);
      assert(!response.body.includes('FOREIGN-WH-SENTINEL'));
      assert(!response.body.includes('FOREIGN-LIST-SENTINEL'));
      assert(!response.headers['content-disposition']);
    }
    const profile = await request('/catalog/export-profiles', 'POST', {
      name: 'Invalid source profile ' + randomUUID(),
      definition: definition(change),
      client_key: randomUUID(),
    });
    assert.equal(profile.statusCode, 422, profile.body);
  }
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE dyna_app');
    await c.query("SELECT set_config('app.tenant_id',$1,true)", [tenant]);
    assert.equal(
      (await c.query('SELECT id FROM warehouses WHERE id=$1', [foreignWarehouse])).rowCount,
      0,
    );
    assert.equal(
      (await c.query('SELECT id FROM price_lists WHERE id=$1', [foreignList])).rowCount,
      0,
    );
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
  assert.deepEqual(await snapshot(), before);
});

test('source scope and aliases have no implicit all-sources fallback and oversized or duplicate selection produces no artifacts', async () => {
  const p = await product(),
    before = await snapshot();
  for (const change of [
    { warehouse_ids: undefined },
    { price_list_ids: undefined },
    { warehouse_ids: [] },
    { warehouse_ids: [warehouse, warehouse.toUpperCase()] },
    { price_list_ids: Array.from({ length: 11 }, () => randomUUID()) },
    { columns: ['sku'], warehouse_ids: [warehouse], price_list_ids: undefined },
    { columns: ['sku'], warehouse_ids: undefined, price_list_ids: [list] },
    { headers: { inventory_json: 'Same', prices_json: 'same' } },
    { format: 'xml', headers: { inventory_json: 'xmlStock' } },
  ]) {
    const response = await request('/catalog/exports/preview', 'POST', input([p.id], change));
    assert.equal(response.statusCode, 422, response.body);
    assert.equal(response.json().sample, undefined);
  }
  assert.deepEqual(await snapshot(), before);
});

test(
  'real stock read wait retains one RR product, price-list revision, stock and override snapshot across a concurrent coherent writer',
  { timeout: 15000 },
  async () => {
    const p = await product(),
      blocker = await pool.connect();
    let pending: ReturnType<typeof openCatalogExport> | undefined;
    try {
      await blocker.query('BEGIN');
      // The coherent writer's stock UPDATE journals a native birth (152), accepted only in its own app.tenant_id.
      await blocker.query("SELECT set_config('app.tenant_id',$1,true)", [tenant]);
      await blocker.query('LOCK TABLE stock IN ACCESS EXCLUSIVE MODE');
      pending = openCatalogExport(
        actor(),
        input([p.id], { columns: ['name', 'inventory_json', 'prices_json'] }),
      );
      void pending.catch(() => {});
      await waitOn(blocker, /(?:LEFT\s+JOIN|FROM)\s+stock\b/i);
      await blocker.query(
        'UPDATE products SET name=$1,price=2222,version=version+1 WHERE tenant_id=$2 AND id=$3',
        ['After coherent writer', tenant, p.id],
      );
      await blocker.query(
        'UPDATE stock SET on_hand=11 WHERE tenant_id=$1 AND warehouse_id=$2 AND product_id=$3',
        [tenant, warehouse, p.id],
      );
      await blocker.query(
        "UPDATE stock_locations SET quantity=11 WHERE tenant_id=$1 AND warehouse_id=$2 AND product_id=$3 AND location='A-01'",
        [tenant, warehouse, p.id],
      );
      await blocker.query(
        'UPDATE price_list_items SET price=9876 WHERE tenant_id=$1 AND price_list_id=$2 AND product_id=$3',
        [tenant, list, p.id],
      );
      await blocker.query('UPDATE price_lists SET version=version+1 WHERE tenant_id=$1 AND id=$2', [
        tenant,
        list,
      ]);
      await blocker.query('COMMIT');
      const afterWriter = await snapshot();
      const row = csv(await consume(await pending))[0];
      assert.equal(row.name, 'Before source snapshot');
      const inventory = JSON.parse(row.inventory_json),
        prices = JSON.parse(row.prices_json);
      assert.equal(inventory[0].on_hand, 7);
      assert.equal(inventory[0].available, 7);
      assert.equal(prices[0].version, 1);
      assert.equal(prices[0].effective_price_minor, 4567);
      const fresh = await ok('/catalog/exports/preview', 'POST', input([p.id]));
      assert.equal(fresh.sample[0].name, 'After coherent writer');
      assert.equal(fresh.sample[0].inventory_json[0].on_hand, 11);
      assert.equal(fresh.sample[0].prices_json[0].version, 2);
      assert.equal(fresh.sample[0].prices_json[0].effective_price_minor, 9876);
      assert.deepEqual(
        await snapshot(),
        afterWriter,
        'Both consistent reads have zero write effects',
      );
    } finally {
      await blocker.query('ROLLBACK').catch(() => {});
      blocker.release();
      await pending?.then(
        (file) => file.dispose(),
        () => {},
      );
    }
  },
);

test(
  'inventory scope loss during an actual source-table wait blocks the prepared file and sample under fresh final authorization',
  { timeout: 25000 },
  async () => {
    const p = await product();
    for (const mode of ['file', 'preview', 'options']) {
      const k = await key(['products:read', 'inventory:read']);
      const before = await snapshot(),
        blocker = await pool.connect();
      let pending: Promise<any> | undefined;
      try {
        await blocker.query('BEGIN');
        await blocker.query(
          mode === 'options'
            ? 'LOCK TABLE warehouses IN ACCESS EXCLUSIVE MODE'
            : 'LOCK TABLE stock IN ACCESS EXCLUSIVE MODE',
        );
        pending =
          mode === 'file'
            ? openCatalogExport(actor(k.id), input([p.id]))
            : request(
                '/v1/catalog/exports/' + mode,
                mode === 'options' ? 'GET' : 'POST',
                mode === 'options' ? undefined : input([p.id]),
                '',
                app,
                { authorization: 'Bearer ' + k.token },
              );
        void pending.catch(() => {});
        await waitOn(
          blocker,
          // The catalog options SD function reads warehouses internally. Require
          // the actual blocked warehouse relation as well as its known SQL call.
          mode === 'options'
            ? /(?:FROM\s+warehouses\b|SELECT\s+product_catalog_options_in_tx\(\))/i
            : /(?:LEFT\s+JOIN|FROM)\s+stock\b/i,
          mode === 'options' ? 'warehouses' : 'stock',
        );
        await changeGrant("UPDATE api_keys SET scopes=ARRAY['products:read']::text[] WHERE id=$1", [
          k.id,
        ]);
        await blocker.query('COMMIT');
        if (mode === 'file') await assert.rejects(pending, (error: any) => error.status === 403);
        else {
          const response = await pending;
          assert.equal(response.statusCode, 403, response.body);
          assert.equal(response.json().sample, undefined);
          assert.equal(response.json().sources, undefined);
          assert(!response.body.includes('Own warehouse source'));
        }
        assert.deepEqual(await snapshot(), before);
      } finally {
        await blocker.query('ROLLBACK').catch(() => {});
        blocker.release();
        await pending?.then(
          (result) => result?.dispose?.(),
          () => {},
        );
      }
    }
  },
);

test('a 096 validator body over hidden 142/143 is a torn install: profiles and exports fail closed without writes, then old profiles and default bytes are unchanged', async () => {
  const body = {
    name: 'Old 115 profile',
    definition: { format: 'csv', columns: ['sku', 'name'], headers: {}, spreadsheet_safe: false },
    client_key: randomUUID(),
  };
  const saved = await ok('/catalog/export-profiles', 'POST', body, admin, 201);
  const p = await product(),
    before = await snapshot();
  const sql096 = await readFile(
    new URL('../server/096_catalog_export_profiles.sql', import.meta.url),
    'utf8',
  );
  const boundary = sql096.indexOf('REVOKE ALL ON FUNCTION');
  assert(boundary > 0);
  const originalValidator = sql096
    .slice(0, boundary)
    .replace(
      'CREATE FUNCTION catalog_export_profile_definition_valid',
      'CREATE OR REPLACE FUNCTION catalog_export_profile_definition_valid',
    );
  const currentValidator = (await pool.query("SELECT oid,proowner,proacl,pg_get_functiondef(oid) definition FROM pg_proc WHERE oid='public.catalog_export_profile_definition_valid(jsonb)'::regprocedure")).rows[0];
  await withHistoricalCatalogModules(pool, async () => {
  try {
    await pool.query(originalValidator);
    // Hidden in the full schema this is a torn install, not an older copy: the PIM
    // integrity guards fail every tenant read and write closed, with no write.
    const digest = await tenantDataDigest();
    for (const path of ['/catalog/exports/file', '/catalog/exports/preview']) {
      // The source admission refuses first (503 before any tenant transaction).
      const response = await request(path, 'POST', input([p.id]));
      assert.equal(response.statusCode, 503, response.body);
      assert(!response.headers['content-disposition']);
    }
    assertPimIncomplete(await request('/catalog/export-profiles', 'POST', {
      name: 'New sources in torn copy',
      definition: definition(),
      client_key: randomUUID(),
    }));
    assertPimIncomplete(await request('/catalog/export-profiles/' + saved.profile.id));
    assert.deepEqual(await tenantDataDigest(), digest);
  } finally {
    await pool.query(currentValidator.definition);
    assert.deepEqual((await pool.query("SELECT oid,proowner,proacl,pg_get_functiondef(oid) definition FROM pg_proc WHERE oid='public.catalog_export_profile_definition_valid(jsonb)'::regprocedure")).rows[0], currentValidator);
  }
  });
  const detail = await ok('/catalog/export-profiles/' + saved.profile.id);
  assert.deepEqual(detail.profile, saved.profile);
  const replay = await ok('/catalog/export-profiles', 'POST', body);
  assert.equal(replay.reused, true);
  const file = await request('/catalog/exports/file', 'POST', {
    ...body.definition,
    selection: 'selected',
    ids: [p.id],
  });
  assert.equal(file.statusCode, 200, file.body);
  assert.equal(file.body, `"sku","name"\r\n"${p.sku}","Before source snapshot"\r\n`);
  assert.deepEqual(await snapshot(), before);
});

test('readonly stock and price sample/download have no mutations, preserve current scope checks and keep all other POST writes blocked', async () => {
  const p = await product(),
    k = await key(['products:read', 'inventory:read']);
  let ro: Awaited<ReturnType<typeof buildApp>> | undefined;
  try {
    ro = await buildApp({ readOnly: true, integrationTransport: transport });
    let cookie = await login('admin@demo.local', ro);
    const switched = await request('/workspaces/switch', 'POST', { tenant_id: tenant }, cookie, ro);
    assert.equal(switched.statusCode, 200);
    cookie = String(switched.headers['set-cookie']).split(';')[0];
    const before = await snapshot();
    for (const headers of [{}, { authorization: 'Bearer ' + k.token }] as Record<
      string,
      string
    >[]) {
      const pathPrefix = headers.authorization ? '/v1' : '',
        authCookie = headers.authorization ? '' : cookie;
      const preview = await request(
        pathPrefix + '/catalog/exports/preview',
        'POST',
        input([p.id]),
        authCookie,
        ro,
        headers,
      );
      assert.equal(preview.statusCode, 200, preview.body);
      assert.match(String(preview.headers['cache-control']), /no-store/);
      assert.equal(preview.json().sample[0].inventory_json[0].on_hand, 7);
      assert.equal(preview.json().sample[0].prices_json[0].effective_price_minor, 4567);
      for (const format of ['csv', 'xml']) {
        const file = await request(
          pathPrefix + '/catalog/exports/file',
          'POST',
          input([p.id], { format }),
          authCookie,
          ro,
          headers,
        );
        assert.equal(file.statusCode, 200, file.body);
        assert(file.body.includes(p.sku));
        assert.equal(Number(file.headers['content-length']), Buffer.byteLength(file.body));
      }
    }
    const malformed = await request('/catalog/exports/preview', 'POST', '{', cookie, ro, {
      'content-type': 'application/json',
    });
    assert.equal(malformed.statusCode, 400);
    const mutation = await request('/catalog/export-profiles', 'POST', '{', cookie, ro, {
      'content-type': 'application/json',
    });
    assert.equal(mutation.statusCode, 423);
    assert.deepEqual(await snapshot(), before);
  } finally {
    await ro?.close();
  }
  assert.equal(providerCalls, 0);
});

test('empty filtered samples are valid and old exact creation receipts replay after a selected price list later disappears', async () => {
  const beforeEmpty = await snapshot();
  const empty = await ok('/catalog/exports/preview', 'POST', {
    ...definition(),
    selection: 'filtered',
  });
  assert.equal(empty.count.matched_products, 0);
  assert.deepEqual(empty.sample, []);
  assert.deepEqual(await snapshot(), beforeEmpty);
  const body = {
    name: 'Original selected sources',
    definition: definition(),
    client_key: randomUUID(),
  };
  const profile = await ok('/catalog/export-profiles', 'POST', body, admin, 201);
  // Detach through the genuine current catalog CAS/receipt before removing an
  // unused source; the catalog assignment FK must remain enabled throughout.
  const catalogId = (await pool.query('SELECT id FROM product_catalogs WHERE tenant_id=$1 AND is_default', [tenant])).rows[0].id;
  const catalog = (await ok('/product-catalogs/' + catalogId)).catalog;
  assert(catalog.settings.price_list_ids.includes(list));
  const detached = await ok('/product-catalogs/previews', 'POST', {
    client_key: randomUUID(), kind: 'update', catalog_id: catalogId, version: catalog.version,
    settings: { ...catalog.settings, price_list_ids: catalog.settings.price_list_ids.filter((id: string) => id !== list) },
  }, admin, 201);
  assert.equal(detached.preview.ready, true);
  await ok('/product-catalogs/previews/' + detached.preview.id + '/commit', 'POST', {
    client_key: randomUUID(), scope_hash: detached.preview.scope_hash, confirmed: true,
  }, admin, 201);
  // This own list has no items/order references. Its legitimate disappearance
  // must not rewrite the already-issued export-profile creation receipt.
  await pool.query('DELETE FROM price_lists WHERE tenant_id=$1 AND id=$2', [tenant, list]);
  const beforeReplay = await snapshot();
  const replay = await ok('/catalog/export-profiles', 'POST', body);
  assert.equal(replay.reused, true);
  assert.deepEqual(replay.profile, profile.profile);
  const changed = await request('/catalog/export-profiles', 'POST', {
    ...body,
    client_key: randomUUID(),
    name: 'New save must validate source',
  });
  assert.equal(changed.statusCode, 422, changed.body);
  assert.deepEqual(await snapshot(), beforeReplay);
});
