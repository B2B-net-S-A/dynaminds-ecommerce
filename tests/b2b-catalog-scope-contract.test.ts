import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { buildApp } from '../server/app';
import { migrate, pool } from '../server/db';
import { seed } from './fixtures';
import { productCatalogFixture, productCatalogFacts } from './product-catalogs-fixture';
import { publicApiDocument } from '../server/developer-api';

assert.equal(process.env.DYNA_TEST, 'true');
const database = new URL(process.env.DATABASE_URL ?? '');
assert(['localhost', '127.0.0.1', '[::1]'].includes(database.hostname));
assert.match(database.pathname, /^\/dynaminds_test_\d+$/);
let core: Awaited<ReturnType<typeof buildApp>>;
before(async () => {
  await migrate(); await seed();
  assert((await pool.query("SELECT 1 FROM migrations WHERE name='143_catalog_export_catalogs'")).rowCount);
  if (!(await pool.query("SELECT to_regprocedure('public.b2b_catalog_scope_installed()') r")).rows[0].r)
    await pool.query(await readFile(resolve('server/144_b2b_catalog_scopes.sql'), 'utf8'));
  core = await buildApp({ integrationTransport: async () => { throw Error('No provider in configuration contracts'); } });
});
after(async () => { try { await core?.close(); } finally { await pool.end(); } });

/** Actual central auth, route aliases and restore-cookie boundary;144 remains
 * applied exclusively by this disposable suite, not the migration registry. */
async function mounted(readOnly = false, previewPort = 4199) {
  return buildApp({ readOnly, previewPort, integrationTransport: async () => { throw Error('No provider in configuration contracts'); } });
}
async function fixture() {
  const f = await productCatalogFixture(core);
  const accountBody = { name: 'Own route scope', email: randomUUID() + '@example.test', warehouse_id: f.warehouse, price_list_id: f.list.id,
    address: { street: 'Own154', postal_code: '00-159', city: 'Warszawa', country: 'PL' }, payment_mode: 'prepaid' };
  const account = await f.ok('/b2b/accounts', 'POST', accountBody, 201);
  const app = await mounted();
  const options = await app.inject({ url: '/api/b2b/accounts/' + account.id + '/catalog-scope', headers: { cookie: f.cookie } });
  assert.equal(options.statusCode, 200);
  const catalog = options.json().resources.catalogs.find((c: any) => c.is_default); assert(catalog);
  const input = { client_key: randomUUID(), account_version: String(account.version), catalog_id: catalog.id, catalog_version: catalog.version, warehouse_id: f.warehouse, price_list_id: f.list.id, language: catalog.default_language };
  return { ...f, account, accountBody, app, input };
}
const ident = (name: string) => { assert.match(name, /^[a-z][a-z0-9_]*$/); return '"' + name + '"'; };

test('mounted normal/v1 routes use actual compound keys, strict input, actor-key exact replay and bounded history', async () => {
  const f = await fixture();
  try {
    const reader = await f.ok('/developer/keys', 'POST', { name: 'Read catalog', scopes: ['products:read'] }, 201);
    const partial = await f.ok('/developer/keys', 'POST', { name: 'No inventory grant', scopes: ['products:read', 'products:write'] }, 201);
    const writer = await f.ok('/developer/keys', 'POST', { name: 'Catalog supplier writer', scopes: ['products:read', 'products:write', 'inventory:read'] }, 201);
    const second = await f.ok('/developer/keys', 'POST', { name: 'Second catalog supplier writer', scopes: ['products:read', 'products:write', 'inventory:read'] }, 201);
    const beforeRows = await productCatalogFacts(f.tenant), path = '/api/v1/b2b/accounts/' + f.account.id + '/catalog-scope';
    const headers = (key: any) => ({ authorization: 'Bearer ' + key.token });
    const read = await f.app.inject({ url: path, headers: headers(reader) }); assert.equal(read.statusCode, 200);
    assert.equal(read.json().can_manage, false); assert.equal(read.json().source.account.warehouse_id, null);
    assert.deepEqual(read.json().resources.warehouses, []);
    for (const key of [reader, partial]) assert.equal((await f.app.inject({ method: 'POST', url: path + '/previews', headers: headers(key), payload: f.input })).statusCode, 403);
    const malformed = await f.app.inject({ method: 'POST', url: path + '/previews', headers: headers(writer), payload: { ...f.input, tenant_id: f.tenant } }); assert.equal(malformed.statusCode, 422);
    assert.deepEqual(await productCatalogFacts(f.tenant), beforeRows);
    const created = await f.app.inject({ method: 'POST', url: path + '/previews', headers: headers(writer), payload: f.input }); assert.equal(created.statusCode, 201);
    assert.match(String(created.headers['cache-control']), /no-store/);
    const p = created.json().preview, afterPreview = await productCatalogFacts(f.tenant);
    const replay = await f.app.inject({ method: 'POST', url: path + '/previews', headers: headers(writer), payload: f.input }); assert.equal(replay.statusCode, 200); assert.equal(replay.json().reused, true);
    assert.deepEqual(replay.json().preview, p); assert.deepEqual(await productCatalogFacts(f.tenant), afterPreview);
    const consent = { client_key: randomUUID(), scope_hash: p.scope_hash, confirmed: true }, commit = '/api/v1/b2b/catalog-scope/previews/' + p.id + '/commit';
    assert.equal((await f.app.inject({ method: 'POST', url: commit, headers: headers(second), payload: consent })).statusCode, 409);
    assert.deepEqual(await productCatalogFacts(f.tenant), afterPreview);
    const accepted = await f.app.inject({ method: 'POST', url: commit, headers: headers(writer), payload: consent }); assert.equal(accepted.statusCode, 201);
    const after = await productCatalogFacts(f.tenant), repeated = await f.app.inject({ method: 'POST', url: commit, headers: headers(writer), payload: consent }); assert.equal(repeated.statusCode, 200);
    assert.deepEqual(repeated.json().operation, accepted.json().operation); assert.deepEqual(await productCatalogFacts(f.tenant), after);
    for (const prefix of ['/api', '/api/v1']) {
      const history = await f.app.inject({ url: prefix + '/b2b/accounts/' + f.account.id + '/catalog-scope/history?kind=operation&limit=1', headers: { cookie: f.cookie } });
      assert.equal(history.statusCode, 200); assert.equal(history.json().data[0].id, accepted.json().operation.id); assert.equal(history.json().next_cursor, null);
      assert.equal(Object.hasOwn(history.json().data[0], 'snapshot'), false);
      assert.equal((await f.app.inject({ url: prefix + '/b2b/accounts/' + f.account.id + '/catalog-scope/history?limit=51', headers: { cookie: f.cookie } })).statusCode, 422);
    }
    assert.deepEqual(await productCatalogFacts(f.tenant), after);
    const document = publicApiDocument() as any;
    assert.deepEqual(document.paths['/b2b/accounts/{account_id}/catalog-scope/previews'].post['x-required-scopes'], ['products:read', 'products:write', 'inventory:read']);
    assert.deepEqual(document.paths['/b2b/network/links/{link_id}/catalog-scope/previews'].post['x-required-scopes'], ['products:read', 'products:write', 'purchasing:read', 'purchasing:write']);
    const commitDocument = document.paths['/b2b/catalog-scope/previews/{id}/commit'].post;
    assert.deepEqual(commitDocument['x-kind-required-scopes'].supplier, ['inventory:read']);
    assert.deepEqual(commitDocument['x-kind-required-scopes'].buyer, ['purchasing:read', 'purchasing:write']);
    assert.equal(publicApiDocument({ readOnly: true }).paths['/b2b/catalog-scope/previews/{id}/commit'], undefined);
  } finally { await f.app.close(); }
});

test('buyer HTTP source uses own persisted link and enforces purchasing compound grants without provider effects', async () => {
  const supplier = await fixture(), buyer = await fixture();
  try {
    const active = await supplier.ok('/b2b/accounts/' + supplier.account.id, 'PATCH', { ...supplier.accountBody, version: supplier.account.version, active: true, confirmed: true });
    const invitation = await supplier.ok('/b2b/accounts/' + supplier.account.id + '/network-invite', 'POST', { version: active.version, recipient_email: 'admin@demo.local', confirmed: true });
    const link = await buyer.ok('/b2b/network/accept', 'POST', { token: invitation.token, confirmed: true });
    const productOnly = await buyer.ok('/developer/keys', 'POST', { name: 'Buyer without purchasing', scopes: ['products:read', 'products:write'] }, 201);
    const reader = await buyer.ok('/developer/keys', 'POST', { name: 'Buyer source reader', scopes: ['products:read', 'purchasing:read'] }, 201);
    const writer = await buyer.ok('/developer/keys', 'POST', { name: 'Buyer scope writer', scopes: ['products:read', 'products:write', 'purchasing:read', 'purchasing:write'] }, 201);
    const path = '/api/v1/b2b/network/links/' + link.id + '/catalog-scope';
    const headers = (key: any) => ({ authorization: 'Bearer ' + key.token });
    const beforeRows = await productCatalogFacts(buyer.tenant), supplierRows = await productCatalogFacts(supplier.tenant);
    assert.equal((await buyer.app.inject({ url: path, headers: headers(productOnly) })).statusCode, 403);
    const source = await buyer.app.inject({ url: path, headers: headers(reader) }); assert.equal(source.statusCode, 200); assert.equal(source.json().can_manage, false);
    const target = source.json().resources.catalogs.find((c: any) => c.is_default); assert(target);
    const input = { client_key: randomUUID(), link_version: String(link.version), target_catalog_id: target.id, target_catalog_version: target.version };
    assert.equal((await buyer.app.inject({ method: 'POST', url: path + '/previews', headers: headers(reader), payload: input })).statusCode, 403);
    assert.deepEqual(await productCatalogFacts(buyer.tenant), beforeRows);
    const p = await buyer.app.inject({ method: 'POST', url: path + '/previews', headers: headers(writer), payload: input }); assert.equal(p.statusCode, 201);
    assert.equal(p.json().preview.snapshot.resources.supplier.account_id, supplier.account.id);
    assert.equal(JSON.stringify(p.json()).includes(supplier.tenant), false);
    assert.deepEqual(await productCatalogFacts(supplier.tenant), supplierRows);
  } finally { await supplier.app.close(); await buyer.app.close(); }
});

test('genuinely absent144 exposes neutral GET/HEAD options and refuses malformed normal/v1 writes before JSON parsing', async () => {
  const f = await fixture(), beforeRows = await productCatalogFacts(f.tenant);
  const names = ['b2b_supplier_catalog_scopes', 'b2b_buyer_catalog_scopes', 'b2b_catalog_scope_previews', 'b2b_catalog_scope_operations', 'b2b_catalog_scope_admissions', 'b2b_catalog_bindings'];
  const functions = (await pool.query("SELECT oid,proname FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'b2b_catalog_scope_%' ORDER BY oid")).rows;
  const relations = (await pool.query(`SELECT oid,relname,relkind FROM pg_class WHERE oid=ANY(ARRAY(SELECT to_regclass('public.'||n) FROM unnest($1::text[]) n))
    OR oid IN(SELECT indexrelid FROM pg_index WHERE indrelid=ANY(ARRAY(SELECT to_regclass('public.'||n) FROM unnest($1::text[]) n))) ORDER BY oid`, [names])).rows;
  const c = await pool.connect(); let hidden = false;
  try {
    await c.query('BEGIN');
    for (const column of ['catalog_scope','catalog_scope_hash','api_key_id']) await c.query(`ALTER TABLE b2b_catalog_runs RENAME COLUMN ${ident(column)} TO ${ident('qa159_hidden_' + column)}`);
    for (const fn of functions) { const signature = (await c.query('SELECT $1::oid::regprocedure::text s', [fn.oid])).rows[0].s; await c.query(`ALTER FUNCTION ${signature} RENAME TO ${ident('qa159_hidden_fn_' + fn.oid)}`); }
    for (const r of relations) await c.query(`ALTER ${r.relkind === 'i' ? 'INDEX' : 'TABLE'} ${ident(r.relname)} RENAME TO ${ident('qa159_hidden_rel_' + r.oid)}`);
    await c.query('COMMIT'); hidden = true;
    for (const prefix of ['/api', '/api/v1']) {
      const path = prefix + '/b2b/accounts/' + f.account.id + '/catalog-scope';
      const options = await f.app.inject({ url: path, headers: { cookie: f.cookie } }); assert.equal(options.statusCode, 200); assert.equal(options.json().available, false); assert.equal(options.json().scope, null);
      const head = await f.app.inject({ method: 'HEAD', url: path, headers: { cookie: f.cookie } }); assert.equal(head.statusCode, 200); assert.equal(head.body, '');
      for (const write of [path + '/previews', prefix + '/b2b/catalog-scope/previews/' + randomUUID() + '/commit'])
        assert.equal((await f.app.inject({ method: 'POST', url: write, headers: { cookie: f.cookie, 'content-type': 'application/json' }, payload: '{' })).statusCode, 503);
    }
  } finally {
    await c.query('ROLLBACK');
    if (hidden) {
      await c.query('BEGIN');
      for (const column of ['catalog_scope','catalog_scope_hash','api_key_id']) await c.query(`ALTER TABLE b2b_catalog_runs RENAME COLUMN ${ident('qa159_hidden_' + column)} TO ${ident(column)}`);
      for (const r of relations) await c.query(`ALTER ${r.relkind === 'i' ? 'INDEX' : 'TABLE'} ${ident('qa159_hidden_rel_' + r.oid)} RENAME TO ${ident(r.relname)}`);
      for (const fn of functions) { const signature = (await c.query('SELECT $1::oid::regprocedure::text s', [fn.oid])).rows[0].s; await c.query(`ALTER FUNCTION ${signature} RENAME TO ${ident(fn.proname)}`); }
      await c.query('COMMIT');
    }
    c.release(); await f.app.close();
  }
  assert.deepEqual(await productCatalogFacts(f.tenant), beforeRows);
});

test('torn expiry column rejects read and malformed write503 without touching business rows', async () => {
  const f = await fixture(), beforeRows = await productCatalogFacts(f.tenant); let altered = false;
  try {
    await pool.query('ALTER TABLE b2b_catalog_scope_previews RENAME COLUMN expires_at TO qa159_hidden_expiry'); altered = true;
    for (const prefix of ['/api', '/api/v1']) {
      const path = prefix + '/b2b/accounts/' + f.account.id + '/catalog-scope';
      assert.equal((await f.app.inject({ url: path, headers: { cookie: f.cookie } })).statusCode, 503);
      assert.equal((await f.app.inject({ method: 'POST', url: path + '/previews', headers: { cookie: f.cookie, 'content-type': 'application/json' }, payload: '{' })).statusCode, 503);
    }
  } finally { if (altered) await pool.query('ALTER TABLE b2b_catalog_scope_previews RENAME COLUMN qa159_hidden_expiry TO expires_at'); await f.app.close(); }
  assert.deepEqual(await productCatalogFacts(f.tenant), beforeRows);
});

test('actual isolated restore cookie reads history with false controls; malformed writes423 precede parsing in both aliases', async () => {
  const f = await fixture(), readonlyCore = await buildApp({ readOnly: true, previewPort: 4199 }), readonly = await mounted(true, 4199);
  try {
    const p = await f.app.inject({ method: 'POST', url: '/api/b2b/accounts/' + f.account.id + '/catalog-scope/previews', headers: { cookie: f.cookie }, payload: f.input }); assert.equal(p.statusCode, 201);
    const preview = p.json().preview;
    assert.equal((await readonly.inject({ url: '/api/b2b/accounts/' + f.account.id + '/catalog-scope', headers: { cookie: f.cookie } })).statusCode, 401);
    const login = await readonlyCore.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'admin@demo.local', password: 'DynaDemo!2026' } }); assert.equal(login.statusCode, 200);
    const sw = await readonlyCore.inject({ method: 'POST', url: '/api/workspaces/switch', headers: { cookie: String(login.headers['set-cookie']).split(';')[0] }, payload: { tenant_id: f.tenant } }); assert.equal(sw.statusCode, 200);
    const cookie = String(sw.headers['set-cookie']).split(';')[0], beforeRows = await productCatalogFacts(f.tenant);
    for (const prefix of ['/api', '/api/v1']) {
      for (const path of ['/b2b/accounts/' + f.account.id + '/catalog-scope/previews', '/b2b/network/links/' + randomUUID() + '/catalog-scope/previews', '/b2b/catalog-scope/previews/' + preview.id + '/commit'])
        assert.equal((await readonly.inject({ method: 'POST', url: prefix + path, headers: { cookie, 'content-type': 'application/json' }, payload: '{' })).statusCode, 423);
      for (const path of ['/b2b/accounts/' + f.account.id + '/catalog-scope', '/b2b/accounts/' + f.account.id + '/catalog-scope/history', '/b2b/catalog-scope/previews/' + preview.id]) {
        const r = await readonly.inject({ url: prefix + path, headers: { cookie } }); assert.equal(r.statusCode, 200); assert.equal(r.json().read_only, true); assert.equal(r.json().can_manage, false);
        if (r.json().preview) assert.equal(r.json().preview.can_commit, false);
      }
    }
    assert.deepEqual(await productCatalogFacts(f.tenant), beforeRows);
  } finally { await f.app.close(); await readonly.close(); await readonlyCore.close(); }
});
