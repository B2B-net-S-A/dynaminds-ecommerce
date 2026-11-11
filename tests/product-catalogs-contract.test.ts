import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../server/app';
import { migrate, pool } from '../server/db';
import { publicApiDocument } from '../server/developer-api';
import { seed } from './fixtures';
import { productCatalogFixture, productCatalogFacts, productCatalogCreate, productCatalogConsent } from './product-catalogs-fixture';

// Root executes this file only in its disposable native harness. Never primary.
assert.equal(process.env.DYNA_TEST, 'true');
const db = new URL(process.env.DATABASE_URL ?? '');
assert(['localhost', '127.0.0.1', '[::1]'].includes(db.hostname));
assert.match(db.pathname, /^\/dynaminds_test_\d+$/);
const transport = async (): Promise<never> => { throw Error('Catalog HTTP contracts cannot call providers'); };
let app: Awaited<ReturnType<typeof buildApp>>;
before(async () => { await migrate(); await seed(); app = await buildApp({ integrationTransport: transport }); });
after(async () => { try { await app?.close(); } finally { await pool.end(); } });
const ident = (name: string) => { assert.match(name, /^[a-z][a-z0-9_]*$/); return '"' + name + '"'; };

test('genuinely absent 142 has neutral GET/HEAD options, legacy product reads, and preparse 503 writes normal/v1', async () => {
  const f = await productCatalogFixture(app), beforeRows = await productCatalogFacts(f.tenant);
  const funcs = (await pool.query("SELECT oid,proname FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'product_catalog_%' ORDER BY oid")).rows;
  const relations = (await pool.query("SELECT oid,relname,relkind FROM pg_class WHERE relnamespace='public'::regnamespace AND relname LIKE 'product_catalog%' ORDER BY oid")).rows;
  assert(funcs.length >= 23); assert.equal(relations.filter(r => r.relkind === 'r').length, 7);
  assert(relations.every(r => ['r', 'i'].includes(r.relkind)));
  const marker = (await pool.query("SELECT name,applied_at::text applied_at FROM migrations WHERE name='142_product_catalogs'")).rows[0]; assert(marker);
  const c = await pool.connect(); let hidden = false;
  try {
    await c.query('BEGIN');
    for (const fn of funcs) {
      const signature = (await c.query('SELECT $1::oid::regprocedure::text signature', [fn.oid])).rows[0].signature;
      await c.query(`ALTER FUNCTION ${signature} RENAME TO ${ident('qa157_hidden_fn_' + fn.oid)}`);
    }
    // Index names also count as partial pg_class artifacts; hide all seven tables
    // and their indexes without dropping rows, grants, constraints or OIDs.
    for (const r of relations) await c.query(`ALTER ${r.relkind === 'i' ? 'INDEX' : 'TABLE'} ${ident(r.relname)} RENAME TO ${ident('qa157_hidden_rel_' + r.oid)}`);
    await c.query('ALTER TABLE products RENAME COLUMN catalog_id TO qa157_hidden_catalog_id');
    await c.query("DELETE FROM migrations WHERE name='142_product_catalogs'");
    await c.query('COMMIT'); hidden = true;
    for (const prefix of ['/api', '/api/v1']) {
      const options = await app.inject({ url: prefix + '/product-catalogs/options', headers: { cookie: f.cookie } });
      assert.equal(options.statusCode, 200); assert.match(String(options.headers['cache-control']), /no-store/);
      assert.equal(options.json().available, false); assert.equal(options.json().can_manage, false); assert.deepEqual(options.json().catalogs, []);
      const head = await app.inject({ method: 'HEAD', url: prefix + '/product-catalogs/options', headers: { cookie: f.cookie } });
      assert.equal(head.statusCode, 200); assert.equal(head.body, '');
      const legacy = await app.inject({ url: prefix + '/products/' + f.product.id, headers: { cookie: f.cookie } });
      assert.equal(legacy.statusCode, 200); assert.equal(legacy.json().id, f.product.id); assert.equal(legacy.json().sku, f.product.sku);
      const list = await app.inject({ url: prefix + '/products?search=' + encodeURIComponent(f.product.sku), headers: { cookie: f.cookie } });
      assert.equal(list.statusCode, 200); assert(list.json().data.some((p: { id: string }) => p.id === f.product.id));
      for (const path of ['/previews', '/previews/' + randomUUID() + '/commit']) {
        const write = await app.inject({ method: 'POST', url: prefix + '/product-catalogs' + path, headers: { cookie: f.cookie, 'content-type': 'application/json' }, payload: '{' });
        assert.equal(write.statusCode, 503);
      }
    }
  } finally {
    await c.query('ROLLBACK');
    if (hidden) {
      await c.query('BEGIN');
      await c.query('ALTER TABLE products RENAME COLUMN qa157_hidden_catalog_id TO catalog_id');
      for (const r of relations) await c.query(`ALTER ${r.relkind === 'i' ? 'INDEX' : 'TABLE'} ${ident('qa157_hidden_rel_' + r.oid)} RENAME TO ${ident(r.relname)}`);
      for (const fn of funcs) {
        const signature = (await c.query('SELECT $1::oid::regprocedure::text signature', [fn.oid])).rows[0].signature;
        await c.query(`ALTER FUNCTION ${signature} RENAME TO ${ident(fn.proname)}`);
      }
      await c.query('INSERT INTO migrations(name,applied_at) VALUES($1,$2::timestamptz)', [marker.name, marker.applied_at]);
      await c.query('COMMIT');
    }
    c.release();
  }
  assert.deepEqual(await productCatalogFacts(f.tenant), beforeRows);
});

test('torn critical column or disabled deferred graph refuses metadata and malformed writes with 503', async () => {
  const f = await productCatalogFixture(app), beforeRows = await productCatalogFacts(f.tenant);
  // Commit temporary scratch-only DDL so HTTP connections can observe it; keeping
  // ALTER open in another transaction would only test a metadata-lock timeout.
  for (const kind of ['column', 'trigger'] as const) {
    let altered = false;
    try {
      await pool.query(kind === 'column' ? 'ALTER TABLE product_catalogs RENAME COLUMN version TO qa157_hidden_version' : 'ALTER TABLE product_catalog_admissions DISABLE TRIGGER product_catalog_admissions_complete'); altered = true;
      for (const prefix of ['/api', '/api/v1']) {
        for (const path of ['/options', '', '/' + f.defaultCatalog.id]) {
          const r = await app.inject({ url: prefix + '/product-catalogs' + path, headers: { cookie: f.cookie } }); assert.equal(r.statusCode, 503);
        }
        const w = await app.inject({ method: 'POST', url: prefix + '/product-catalogs/previews', headers: { cookie: f.cookie, 'content-type': 'application/json' }, payload: '{' }); assert.equal(w.statusCode, 503);
      }
    } finally {
      if (altered) await pool.query(kind === 'column' ? 'ALTER TABLE product_catalogs RENAME COLUMN qa157_hidden_version TO version' : 'ALTER TABLE product_catalog_admissions ENABLE TRIGGER product_catalog_admissions_complete');
    }
    assert.deepEqual(await productCatalogFacts(f.tenant), beforeRows);
  }
});

test('real v1 keys enforce compound scopes and key-bound preview/commit replay, matching OpenAPI', async () => {
  const f = await productCatalogFixture(app);
  const read = await f.ok('/developer/keys', 'POST', { name: 'Own catalog read only', scopes: ['products:read'] }, 201);
  const write = await f.ok('/developer/keys', 'POST', { name: 'Own catalog write only', scopes: ['products:write'] }, 201);
  const both = await f.ok('/developer/keys', 'POST', { name: 'Own catalog compound', scopes: ['products:read', 'products:write'] }, 201);
  const beforeRows = await productCatalogFacts(f.tenant), body = productCatalogCreate(f);
  assert.equal((await f.request('/product-catalogs/options', 'GET', undefined, read)).statusCode, 200);
  assert.equal((await f.ok('/product-catalogs/options', 'GET', undefined, 200, read)).can_manage, false);
  for (const key of [read, write]) assert.equal((await f.request('/product-catalogs/previews', 'POST', body, key)).statusCode, 403);
  assert.deepEqual(await productCatalogFacts(f.tenant), beforeRows);
  const p = (await f.ok('/product-catalogs/previews', 'POST', body, 201, both)).preview;
  const consent = productCatalogConsent(p), pending = await productCatalogFacts(f.tenant);
  // A cookie representing the same user does not adopt an API-key-bound proof.
  assert.equal((await f.request('/product-catalogs/previews/' + p.id + '/commit', 'POST', consent)).statusCode, 409);
  assert.deepEqual(await productCatalogFacts(f.tenant), pending);
  const result = await f.ok('/product-catalogs/previews/' + p.id + '/commit', 'POST', consent, 201, both);
  const committed = await productCatalogFacts(f.tenant);
  const replay = await f.ok('/product-catalogs/previews/' + p.id + '/commit', 'POST', consent, 200, both);
  assert.equal(replay.reused, true); assert.deepEqual(replay.operation, result.operation); assert.deepEqual(await productCatalogFacts(f.tenant), committed);
  const doc = publicApiDocument() as any;
  for (const [path, method] of [['/product-catalogs/options', 'get'], ['/product-catalogs/previews', 'post'], ['/product-catalogs/previews/{id}/commit', 'post']] as const) {
    const operation = doc.paths[path]?.[method]; assert(operation, method + ' ' + path);
    assert.deepEqual(operation['x-required-scopes'], method === 'get' ? ['products:read'] : ['products:read', 'products:write']);
  }
});

test('isolated restore login reads frozen catalog graphs, primary cookie is refused, malformed writes return 423 before parse', async () => {
  const f = await productCatalogFixture(app), p = (await f.ok('/product-catalogs/previews', 'POST', productCatalogCreate(f), 201)).preview;
  const result = await f.ok('/product-catalogs/previews/' + p.id + '/commit', 'POST', productCatalogConsent(p), 201);
  const readonly = await buildApp({ readOnly: true, previewPort: 4197, integrationTransport: transport });
  try {
    const foreignSession = await readonly.inject({ url: '/api/product-catalogs/options', headers: { cookie: f.cookie } }); assert.equal(foreignSession.statusCode, 401);
    const login = await readonly.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'admin@demo.local', password: 'DynaDemo!2026' } }); assert.equal(login.statusCode, 200);
    const switched = await readonly.inject({ method: 'POST', url: '/api/workspaces/switch', headers: { cookie: String(login.headers['set-cookie']).split(';')[0] }, payload: { tenant_id: f.tenant } }); assert.equal(switched.statusCode, 200);
    const cookie = String(switched.headers['set-cookie']).split(';')[0], beforeRows = await productCatalogFacts(f.tenant);
    for (const prefix of ['/api', '/api/v1']) {
      for (const path of ['/previews', '/previews/' + p.id + '/commit']) {
        const r = await readonly.inject({ method: 'POST', url: prefix + '/product-catalogs' + path, headers: { cookie, 'content-type': 'application/json' }, payload: '{' }); assert.equal(r.statusCode, 423);
      }
      for (const path of ['/options', '', '/' + result.catalog.id, '/previews/' + p.id, '/operations/' + result.operation.id, '/previews?kind=operation']) {
        const r = await readonly.inject({ url: prefix + '/product-catalogs' + path, headers: { cookie } }); assert.equal(r.statusCode, 200); assert.match(String(r.headers['cache-control']), /no-store/);
        const b = r.json(); assert.equal(b.read_only, true); assert.equal(b.can_manage, false);
        if (b.preview) { assert.equal(b.preview.can_commit, false); assert.equal(b.preview.id, p.id); }
        if (b.operation) assert.deepEqual(b.operation, result.operation);
      }
    }
    assert.deepEqual(await productCatalogFacts(f.tenant), beforeRows);
  } finally { await readonly.close(); }
});
