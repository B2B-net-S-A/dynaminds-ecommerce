import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { SaxesParser } from 'saxes';
import type { PoolClient } from 'pg';
import { buildApp } from '../server/app';
import { migrate, pool, tenantTx } from '../server/db';
import { seed } from './fixtures';
import { productCatalogFixture, productCatalogFacts, productCatalogCreate, productCatalogConsent } from './product-catalogs-fixture';
import { catalogExportFileInput, catalogExportDefinitionInput, openCatalogExport, catalogExportPreview } from '../server/catalog-export';
import { catalogExportSourceFrame } from '../server/catalog-export-sources';
import { previewProductCatalog, commitProductCatalog } from '../server/product-catalogs';
import { pimIncomplete, tenantDataDigest } from './torn-module-fixture';

assert.equal(process.env.DYNA_TEST, 'true');
const db = new URL(process.env.DATABASE_URL ?? '');
assert(['localhost', '127.0.0.1', '[::1]'].includes(db.hostname));
assert.match(db.pathname, /^\/dynaminds_test_\d+$/);
let app: Awaited<ReturnType<typeof buildApp>>;
let providerCalls = 0;
const transport = async (): Promise<never> => { providerCalls++; throw Error('Catalog export never calls providers'); };
before(async () => { await migrate(); await seed(); app = await buildApp({ integrationTransport: transport }); });
after(async () => { try { await app?.close(); } finally { await pool.end(); } });
const definition = (extra: Record<string, unknown> = {}) => ({ format: 'csv', columns: ['id', 'sku', 'price_minor'], headers: {}, spreadsheet_safe: false, ...extra });
async function catalog(f: Awaited<ReturnType<typeof productCatalogFixture>>) {
  const p = (await f.ok('/product-catalogs/previews', 'POST', productCatalogCreate(f), 201)).preview;
  return (await f.ok('/product-catalogs/previews/' + p.id + '/commit', 'POST', productCatalogConsent(p), 201)).catalog;
}
async function product(f: Awaited<ReturnType<typeof productCatalogFixture>>, catalog_id: string, price = 1701) {
  return f.ok('/products', 'POST', { name: 'Own selected export product', sku: 'EXPORT158-' + randomUUID(), price, quantity: 0, warehouse_id: f.spare.id, catalog_id }, 201);
}
const proof = (preview: any) => ({ catalog_version: preview.catalog_version, scope_hash: preview.scope_hash });
function spyPoolClients(wrap: (client: PoolClient) => PoolClient) {
  const original = pool.connect, connect = pool.connect.bind(pool);
  // Pool.query uses connect(callback); direct callers use connect(): Promise.
  // Preserve both overloads and the real release function from node-postgres.
  (pool as any).connect = (callback?: (...args: any[]) => void) => {
    if (typeof callback !== 'function') return connect().then(wrap);
    return connect((error, client, release) => {
      if (error || !client || typeof release !== 'function') {
        callback(error || new Error('Pool did not return a releasable client')); return;
      }
      let wrapped: PoolClient;
      try { wrapped = wrap(client); }
      catch (failure) {
        const cause = failure instanceof Error ? failure : new Error('Client spy setup failed');
        release(cause); callback(cause); return;
      }
      callback(null, wrapped, release);
    });
  };
  return original;
}
async function change(f: Awaited<ReturnType<typeof productCatalogFixture>>, head: any, extra: Record<string, unknown>) {
  const body = { client_key: randomUUID(), kind: 'update', catalog_id: head.id, version: head.version,
    settings: { name: head.name, active: head.active, languages: head.languages, default_language: head.default_language, warehouse_ids: head.warehouse_ids, price_list_ids: head.price_list_ids, ...extra } };
  const p = (await f.ok('/product-catalogs/previews', 'POST', body, 201)).preview;
  assert.equal(p.ready, true);
  return f.ok('/product-catalogs/previews/' + p.id + '/commit', 'POST', productCatalogConsent(p), 201);
}

test('CSV/XML export one explicit catalog with assigned sources, exact scope headers and no commerce/provider effects', async () => {
  const f = await productCatalogFixture(app), selected = await catalog(f), own = await product(f, selected.id);
  const options = await f.ok('/catalog/exports/options?catalog_id=' + selected.id);
  assert.equal(options.catalog_available, true); assert.equal(options.catalog.id, selected.id);
  assert.equal(options.count.matched_products, 1);
  assert.deepEqual(options.sources.warehouses.data.map((r: any) => r.id), [f.spare.id]);
  assert.deepEqual(options.sources.price_lists.data.map((r: any) => r.id), [f.list.id]);
  const beforeRows = await productCatalogFacts(f.tenant);
  for (const format of ['csv', 'xml']) {
    const body = definition({ format, catalog_id: selected.id, columns: ['id', 'sku', 'inventory_json', 'prices_json'], warehouse_ids: [f.spare.id], price_list_ids: [f.list.id] });
    const preview = await f.ok('/catalog/exports/preview', 'POST', body);
    assert.equal(preview.catalog.id, selected.id); assert.equal(preview.catalog_version, selected.version); assert.match(preview.scope_hash, /^[a-f0-9]{64}$/);
    assert.equal(preview.sample.length, 1); assert.equal(preview.sample[0].product_id, own.id);
    assert.equal(preview.sample[0].inventory_json[0].warehouse_id, f.spare.id); assert.equal(preview.sample[0].inventory_json[0].on_hand, 0);
    assert.equal(preview.sample[0].prices_json[0].price_list_id, f.list.id);
    const file = await f.request('/catalog/exports/file', 'POST', { ...body, ...proof(preview) });
    assert.equal(file.statusCode, 200); assert.equal(file.headers['x-product-catalog-id'], selected.id); assert.equal(String(file.headers['x-product-catalog-version']), selected.version);
    assert.equal(file.headers['x-catalog-export-scope-hash'], preview.scope_hash); assert.equal(String(file.headers['x-catalog-export-count']), '1');
    assert(file.body.includes(own.sku)); assert(!file.body.includes(f.product.sku));
    if (format === 'xml') { let products = 0; const parser = new SaxesParser(); parser.on('opentag', node => { if (node.name === 'product') products++; }); parser.write(file.body).close(); assert.equal(products, 1); }
  }
  assert.deepEqual(await productCatalogFacts(f.tenant), beforeRows); assert.equal(providerCalls, 0);
});

test('selected products cannot cross pools; unassigned/foreign sources and altered scope all fail without partial exports or writes', async () => {
  const f = await productCatalogFixture(app), other = await productCatalogFixture(app), selected = await catalog(f), own = await product(f, selected.id);
  const initial = await productCatalogFacts(f.tenant), otherInitial = await productCatalogFacts(other.tenant);
  for (const extra of [
    { selection: 'selected', ids: [own.id, f.product.id] },
    { columns: ['sku', 'inventory_json'], warehouse_ids: [f.warehouse] },
    { columns: ['sku', 'prices_json'], price_list_ids: [(await other.ok('/price-lists')).data[0].id] },
  ]) assert.equal((await f.request('/catalog/exports/preview', 'POST', definition({ catalog_id: selected.id, ...extra }))).statusCode, 409);
  assert.equal((await f.request('/catalog/exports/preview', 'POST', definition({ catalog_id: other.defaultCatalog.id }))).statusCode, 404);
  const body = definition({ catalog_id: selected.id }), preview = await f.ok('/catalog/exports/preview', 'POST', body);
  assert.equal((await f.request('/catalog/exports/file', 'POST', body)).statusCode, 422);
  assert.equal((await f.request('/catalog/exports/file', 'POST', { ...body, ...proof(preview), scope_hash: '0'.repeat(64) })).statusCode, 409);
  assert.equal((await f.request('/catalog/exports/file', 'POST', { ...body, ...proof(preview), search: own.sku })).statusCode, 409);
  assert.deepEqual(await productCatalogFacts(f.tenant), initial); assert.deepEqual(await productCatalogFacts(other.tenant), otherInitial);
});

test('product births may change count between pure reads, but catalog configuration drift invalidates the reviewed file scope', async () => {
  const f = await productCatalogFixture(app), selected = await catalog(f), first = await product(f, selected.id);
  const body = definition({ catalog_id: selected.id }), preview = await f.ok('/catalog/exports/preview', 'POST', body);
  assert.equal(preview.count.matched_products, 1);
  const second = await product(f, selected.id, 2300), beforeFile = await productCatalogFacts(f.tenant);
  const file = await f.request('/catalog/exports/file', 'POST', { ...body, ...proof(preview) });
  assert.equal(file.statusCode, 200); assert.equal(String(file.headers['x-catalog-export-count']), '2'); assert(file.body.includes(first.sku)); assert(file.body.includes(second.sku));
  assert.deepEqual(await productCatalogFacts(f.tenant), beforeFile);
  await change(f, selected, { name: 'Own changed catalog configuration' });
  const changed = await productCatalogFacts(f.tenant);
  assert.equal((await f.request('/catalog/exports/file', 'POST', { ...body, ...proof(preview) })).statusCode, 409);
  assert.deepEqual(await productCatalogFacts(f.tenant), changed);
});

test('profile stores the explicit catalog; exact birth replay preserves the historical request after catalog archive', async () => {
  const f = await productCatalogFixture(app), selected = await catalog(f);
  const body = { client_key: randomUUID(), name: 'Own reusable selected pool', definition: definition({ catalog_id: selected.id }) };
  const created = await f.ok('/catalog/export-profiles', 'POST', body, 201);
  assert.equal(created.profile.definition.catalog_id, selected.id);
  assert.equal(created.profile.definition.catalog_version, undefined); assert.equal(created.profile.definition.scope_hash, undefined);
  const beforeDenied = await productCatalogFacts(f.tenant);
  assert.equal((await f.request('/catalog/export-profiles', 'POST', { ...body, client_key: randomUUID(), name: 'Own invalid source pool', definition: definition({ catalog_id: selected.id, columns: ['sku', 'inventory_json'], warehouse_ids: [f.warehouse] }) })).statusCode, 409);
  assert.deepEqual(await productCatalogFacts(f.tenant), beforeDenied);
  await change(f, selected, { active: false });
  const accepted = await productCatalogFacts(f.tenant), replay = await f.ok('/catalog/export-profiles', 'POST', body, 200);
  assert.equal(replay.reused, true); assert.deepEqual(replay.profile, created.profile); assert.deepEqual(await productCatalogFacts(f.tenant), accepted);
  assert.equal((await f.request('/catalog/exports/preview', 'POST', created.profile.definition)).statusCode, 409);
  assert.deepEqual(await productCatalogFacts(f.tenant), accepted);
});

test('omitted catalog preserves legacy definition/request parsing and original source-frame JSON exactly', async () => {
  const raw = definition(); assert.deepEqual(catalogExportDefinitionInput.parse(raw), raw);
  const parsed = catalogExportFileInput.parse(raw); assert.equal(Object.hasOwn(parsed, 'catalog_id'), false); assert.equal(Object.hasOwn(parsed, 'catalog_version'), false); assert.equal(Object.hasOwn(parsed, 'scope_hash'), false);
  const f = await productCatalogFixture(app), beforeRows = await productCatalogFacts(f.tenant);
  const preview = await f.ok('/catalog/exports/preview', 'POST', raw); assert.equal(Object.hasOwn(preview, 'catalog'), false); assert.equal(Object.hasOwn(preview, 'scope_hash'), false);
  const file = await f.request('/catalog/exports/file', 'POST', raw); assert.equal(file.statusCode, 200); assert.equal(file.headers['x-product-catalog-id'], undefined); assert(file.body.includes(f.product.sku));
  assert.deepEqual(await productCatalogFacts(f.tenant), beforeRows);
});

test('product-only keys cannot read warehouse assignments from all/scoped catalog metadata or preview', async () => {
  const f = await productCatalogFixture(app), selected = await catalog(f); await product(f, selected.id);
  const productKey = await f.ok('/developer/keys', 'POST', { name: 'Own product-only export', scopes: ['products:read'] }, 201);
  const inventoryKey = await f.ok('/developer/keys', 'POST', { name: 'Own inventory export', scopes: ['products:read', 'inventory:read'] }, 201);
  const warehouseRows = (await pool.query('SELECT id,name,code FROM warehouses WHERE tenant_id=$1', [f.tenant])).rows;
  const unchanged = await productCatalogFacts(f.tenant);
  const noWarehouses = (reply: Awaited<ReturnType<typeof f.request>>) => {
    assert.equal(reply.statusCode, 200);
    for (const row of warehouseRows) for (const field of ['id', 'name', 'code']) {
      if (typeof row[field] === 'string' && row[field].length) assert(!reply.body.includes(row[field]), 'Restricted warehouse metadata must stay private');
    }
    const data = reply.json();
    if (data.catalog) assert.deepEqual(data.catalog.warehouse_ids, []);
    for (const head of data.catalogs ?? []) assert.deepEqual(head.warehouse_ids, []);
    return data;
  };
  for (const path of ['/catalog/exports/options', '/catalog/exports/options?catalog_id=' + selected.id]) {
    const data = noWarehouses(await f.request(path, 'GET', undefined, productKey));
    assert.equal(data.sources.allow_inventory, false); assert.deepEqual(data.sources.warehouses.data, []);
    assert(data.sources.price_lists.data.some((list: any) => list.id === f.list.id));
    const authorized = await f.ok(path, 'GET', undefined, 200, inventoryKey);
    assert(authorized.sources.warehouses.data.some((row: any) => row.id === f.spare.id));
    assert(authorized.catalogs.some((head: any) => head.warehouse_ids.includes(f.spare.id)));
  }
  const body = definition({ catalog_id: selected.id });
  const restricted = noWarehouses(await f.request('/catalog/exports/preview', 'POST', body, productKey));
  const admin = await f.ok('/catalog/exports/preview', 'POST', body);
  assert.deepEqual(admin.catalog.warehouse_ids, [f.spare.id]);
  assert.equal(restricted.scope_hash, admin.scope_hash, 'Public redaction must not change the complete internal scope hash');
  // Product-only previews keep the same projection even for an inventory-capable
  // key: no inventory scope is pinned unless stock columns are requested.
  noWarehouses(await f.request('/catalog/exports/preview', 'POST', body, inventoryKey));
  const stockBody = definition({ catalog_id: selected.id, columns: ['sku', 'inventory_json'], warehouse_ids: [f.spare.id] });
  const denied = await f.request('/catalog/exports/preview', 'POST', stockBody, productKey);
  assert.equal(denied.statusCode, 403); assert(!denied.headers['content-disposition']);
  const allowed = await f.ok('/catalog/exports/preview', 'POST', stockBody, 200, inventoryKey);
  assert.deepEqual(allowed.catalog.warehouse_ids, [f.spare.id]); assert.equal(allowed.sample[0].inventory_json[0].warehouse_id, f.spare.id);
  assert.deepEqual(await productCatalogFacts(f.tenant), unchanged); assert.equal(providerCalls, 0);
});

test('a genuine catalog change after spool commit is caught by the final fresh scope check before exposing any stream', async () => {
  const f = await productCatalogFixture(app), selected = await catalog(f); await product(f, selected.id);
  const body = definition({ catalog_id: selected.id }), preview = await f.ok('/catalog/exports/preview', 'POST', body);
  // Intercept the real export reader's COMMIT, not a test-only production hook.
  // The SQL/client commit finishes first; ordinary API config then changes before
  // openCatalogExport performs its independent READ COMMITTED final check.
  const queries = new Map<PoolClient, PoolClient['query']>(); let changed = false, intercepted = false;
  const originalConnect = spyPoolClients(c => {
    if (!queries.has(c)) queries.set(c, c.query);
    const query = queries.get(c)!.bind(c); let reader = false;
    (c as any).query = async (...args: any[]) => {
      const sql = typeof args[0] === 'string' ? args[0] : args[0]?.text;
      const result = await (query as any)(...args);
      if (sql === 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY') reader = true;
      if (sql === 'COMMIT' && reader && !intercepted) {
        intercepted = true; await change(f, selected, { name: 'Own config changed after spool' }); changed = true;
      }
      return result;
    };
    return c;
  });
  try {
    await assert.rejects(openCatalogExport(f.actor, { ...body, ...proof(preview) }), (e: any) => e.status === 409 && /katalogu/.test(e.message));
    assert.equal(intercepted, true); assert.equal(changed, true);
  } finally { pool.connect = originalConnect; for (const [client, query] of queries) client.query = query; }
  const accepted = await productCatalogFacts(f.tenant);
  assert.equal((await f.request('/catalog/exports/file', 'POST', { ...body, ...proof(preview) })).statusCode, 409);
  assert.deepEqual(await productCatalogFacts(f.tenant), accepted); assert.equal(providerCalls, 0);
});

test('final preview/file catalogue lock survives a real IAM wait and serializes a genuine configuration commit', async () => {
  const otherUser = (await pool.query("SELECT id FROM users WHERE email='viewer@demo.local'")).rows[0].id as string;
  const waitForBlocked = async (blockingPid: number, matches: (row: { pid: number; query: string }) => boolean) => {
    const deadline = Date.now() + 2500;
    while (Date.now() < deadline) {
      const waiting = (await pool.query<{ pid: number; query: string }>(`SELECT pid,query FROM pg_stat_activity
        WHERE datname=current_database() AND wait_event_type='Lock' AND $1=ANY(pg_blocking_pids(pid))`, [blockingPid])).rows;
      if (waiting.some(matches)) return;
      await new Promise<void>(done => setTimeout(done, 10));
    }
    assert.fail('Actual SQL wait was not observed through pg_blocking_pids');
  };
  for (const mode of ['preview', 'file'] as const) {
    const f = await productCatalogFixture(app), selected = await catalog(f); await product(f, selected.id);
    // An independent own administrator can reach the real config admission while
    // the export principal is held. No global user role or business facts change.
    await pool.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'admin')", [f.tenant, otherUser]);
    const configActor = { ...f.actor, userId: otherUser };
    const configPreview = (await previewProductCatalog(configActor, { client_key: randomUUID(), kind: 'update', catalog_id: selected.id, version: selected.version,
      settings: { name: 'Config after final IAM ' + mode, active: selected.active, languages: selected.languages, default_language: selected.default_language,
        warehouse_ids: selected.warehouse_ids, price_list_ids: selected.price_list_ids } })).preview;
    const body = definition({ catalog_id: selected.id }), p = await f.ok('/catalog/exports/preview', 'POST', body);
    const holder = await pool.connect();
    const queries = new Map<PoolClient, PoolClient['query']>();
    let exportPid = 0, held = false, exportSettled = false, configSettled = false;
    let exporting: Promise<unknown> | undefined, configuring: Promise<unknown> | undefined;
    let file: Awaited<ReturnType<typeof openCatalogExport>> | undefined;
    const holderPid = (await holder.query('SELECT pg_backend_pid() pid')).rows[0].pid as number;
    const originalConnect = spyPoolClients(c => {
      if (!queries.has(c)) queries.set(c, c.query);
      const query = queries.get(c)!.bind(c); let final = false;
      (c as any).query = async (...args: any[]) => {
        const sql = typeof args[0] === 'string' ? args[0] : args[0]?.text;
        if (final && /SELECT role FROM memberships/.test(sql) && !held) {
          await holder.query('BEGIN');
          await holder.query('SELECT role FROM memberships WHERE tenant_id=$1 AND user_id=$2 FOR UPDATE', [f.tenant, f.user]);
          held = true;
        }
        const result = await (query as any)(...args);
        if (sql === 'BEGIN ISOLATION LEVEL READ COMMITTED') {
          final = true; exportPid = (await query('SELECT pg_backend_pid() pid')).rows[0].pid;
        }
        return result;
      };
      return c;
    });
    try {
      exporting = (mode === 'preview' ? catalogExportPreview(f.actor, body) : openCatalogExport(f.actor, { ...body, ...proof(p) }).then(value => { file = value; return value; }))
        .finally(() => { exportSettled = true; });
      // Attach rejection handlers immediately, while retaining original results.
      void exporting.catch(() => {});
      await waitForBlocked(holderPid, row => row.pid === exportPid && /FROM memberships/.test(row.query));
      assert.equal(exportSettled, false);
      configuring = commitProductCatalog(configActor, configPreview.id, productCatalogConsent(configPreview)).finally(() => { configSettled = true; });
      void configuring.catch(() => {});
      await waitForBlocked(exportPid, row => /product_catalog_write/.test(row.query));
      assert.equal(configSettled, false, 'Config commit must wait for the shared catalogue lock through IAM');
      assert.equal((await pool.query('SELECT version::text version FROM product_catalogs WHERE tenant_id=$1 AND id=$2', [f.tenant, selected.id])).rows[0].version, selected.version);
      await holder.query('ROLLBACK');
      await exporting; await configuring;
      assert.equal(exportSettled, true); assert.equal(configSettled, true);
    } finally {
      await holder.query('ROLLBACK').catch(() => {});
      await Promise.allSettled([exporting, configuring].filter((p): p is Promise<unknown> => !!p));
      await file?.dispose();
      pool.connect = originalConnect; for (const [client, query] of queries) client.query = query;
      holder.release();
    }
    assert.equal((await f.request('/catalog/exports/file', 'POST', { ...body, ...proof(p) })).statusCode, 409, 'A subsequent request must reject the changed configuration');
  }
  assert.equal(providerCalls, 0);
});

test('pure preview/file remain available with isolated restore sessions and v1 compound catalog proof', async () => {
  const f = await productCatalogFixture(app), selected = await catalog(f), own = await product(f, selected.id);
  const readonly = await buildApp({ readOnly: true, previewPort: 4198, integrationTransport: transport });
  try {
    const denied = await readonly.inject({ url: '/api/catalog/exports/options', headers: { cookie: f.cookie } }); assert.equal(denied.statusCode, 401);
    const login = await readonly.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'admin@demo.local', password: 'DynaDemo!2026' } }); assert.equal(login.statusCode, 200);
    const switched = await readonly.inject({ method: 'POST', url: '/api/workspaces/switch', payload: { tenant_id: f.tenant }, headers: { cookie: String(login.headers['set-cookie']).split(';')[0] } }); assert.equal(switched.statusCode, 200);
    const cookie = String(switched.headers['set-cookie']).split(';')[0], beforeRows = await productCatalogFacts(f.tenant);
    for (const prefix of ['/api', '/api/v1']) {
      const options = await readonly.inject({ url: prefix + '/catalog/exports/options?catalog_id=' + selected.id, headers: { cookie } }); assert.equal(options.statusCode, 200); assert.equal(options.json().read_only, true);
      const body = definition({ catalog_id: selected.id }), r = await readonly.inject({ method: 'POST', url: prefix + '/catalog/exports/preview', headers: { cookie }, payload: body }); assert.equal(r.statusCode, 200);
      const p = r.json(); assert.equal(p.catalog.id, selected.id); assert.equal(p.read_only, true);
      const file = await readonly.inject({ method: 'POST', url: prefix + '/catalog/exports/file', headers: { cookie }, payload: { ...body, ...proof(p) } }); assert.equal(file.statusCode, 200); assert(file.body.includes(own.sku)); assert(!file.body.includes(f.product.sku));
      assert.equal(file.headers['x-catalog-export-scope-hash'], p.scope_hash);
      const write = await readonly.inject({ method: 'POST', url: prefix + '/catalog/export-profiles', headers: { cookie, 'content-type': 'application/json' }, payload: '{' }); assert.equal(write.statusCode, 423);
    }
    assert.deepEqual(await productCatalogFacts(f.tenant), beforeRows);
  } finally { await readonly.close(); }
});

test('142/143 hidden in the full schema is a torn install: catalogue export fails closed without writes and works again once restored', async () => {
  const f = await productCatalogFixture(app), initial = await productCatalogFacts(f.tenant);
  const sourceDefinition = definition({ columns: ['sku', 'inventory_json'], warehouse_ids: [f.warehouse] });
  const originalFrame = await tenantTx(f.tenant, c => catalogExportSourceFrame(c, sourceDefinition, f.tenant), { wmsAdmission: 'read' });
  assert.deepEqual(Object.keys(originalFrame).sort(), ['price_lists', 'tenant_id', 'warehouses']);
  const funcs = (await pool.query("SELECT oid,proname FROM pg_proc WHERE pronamespace='public'::regnamespace AND (proname LIKE 'product_catalog_%' OR proname LIKE 'catalog_export_catalogs_%') ORDER BY oid")).rows;
  const relations = (await pool.query("SELECT oid,relname,relkind FROM pg_class WHERE relnamespace='public'::regnamespace AND relname LIKE 'product_catalog%' ORDER BY oid")).rows;
  assert(funcs.length >= 26); assert.equal(relations.filter(r => r.relkind === 'r').length, 7); assert(relations.every(r => ['r', 'i'].includes(r.relkind)));
  const markers = (await pool.query("SELECT name,applied_at::text applied_at FROM migrations WHERE name=ANY($1::text[]) ORDER BY name", [['142_product_catalogs', '143_catalog_export_catalogs']])).rows; assert.equal(markers.length, 2);
  const ident = (name: string) => { assert.match(name, /^[a-z][a-z0-9_]*$/); return '"' + name + '"'; };
  const c = await pool.connect(); let hidden = false;
  try {
    await c.query('BEGIN');
    for (const fn of funcs) {
      const signature = (await c.query('SELECT $1::oid::regprocedure::text signature', [fn.oid])).rows[0].signature;
      await c.query(`ALTER FUNCTION ${signature} RENAME TO ${ident('qa158_hidden_fn_' + fn.oid)}`);
    }
    for (const r of relations) await c.query(`ALTER ${r.relkind === 'i' ? 'INDEX' : 'TABLE'} ${ident(r.relname)} RENAME TO ${ident('qa158_hidden_rel_' + r.oid)}`);
    await c.query('ALTER TABLE products RENAME COLUMN catalog_id TO qa158_hidden_catalog_id');
    await c.query('DELETE FROM migrations WHERE name=ANY($1::text[])', [markers.map(m => m.name)]);
    await c.query('COMMIT'); hidden = true;
    // Not an older copy: the PIM integrity guards see a torn installation and the
    // tenant transaction fails closed, with no write.
    const digest = await tenantDataDigest();
    await assert.rejects(tenantTx(f.tenant, client => catalogExportSourceFrame(client, sourceDefinition, f.tenant), { wmsAdmission: 'read' }), pimIncomplete);
    assert.deepEqual(await tenantDataDigest(), digest);
  } finally {
    await c.query('ROLLBACK');
    if (hidden) {
      await c.query('BEGIN'); await c.query('ALTER TABLE products RENAME COLUMN qa158_hidden_catalog_id TO catalog_id');
      for (const r of relations) await c.query(`ALTER ${r.relkind === 'i' ? 'INDEX' : 'TABLE'} ${ident('qa158_hidden_rel_' + r.oid)} RENAME TO ${ident(r.relname)}`);
      for (const fn of funcs) { const signature = (await c.query('SELECT $1::oid::regprocedure::text signature', [fn.oid])).rows[0].signature; await c.query(`ALTER FUNCTION ${signature} RENAME TO ${ident(fn.proname)}`); }
      for (const marker of markers) await c.query('INSERT INTO migrations(name,applied_at) VALUES($1,$2::timestamptz)', [marker.name, marker.applied_at]);
      await c.query('COMMIT');
    }
    c.release();
  }
  assert.deepEqual(await tenantTx(f.tenant, client => catalogExportSourceFrame(client, sourceDefinition, f.tenant), { wmsAdmission: 'read' }), originalFrame);
  const restored = await app.inject({ url: '/api/catalog/exports/options', headers: { cookie: f.cookie } });
  assert.equal(restored.statusCode, 200, restored.body); assert.equal(restored.json().catalog_available, true);
  assert.deepEqual(await productCatalogFacts(f.tenant), initial); assert.equal(providerCalls, 0);
});
