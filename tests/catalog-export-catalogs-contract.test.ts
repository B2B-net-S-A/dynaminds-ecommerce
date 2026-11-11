import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../server/app';
import { migrate, pool } from '../server/db';
import { publicApiDocument } from '../server/developer-api';
import { seed } from './fixtures';
import { productCatalogFixture, productCatalogFacts } from './product-catalogs-fixture';

// Root runs only in its disposable host-native database. No provider or primary calls.
assert.equal(process.env.DYNA_TEST, 'true');
const db = new URL(process.env.DATABASE_URL ?? '');
assert(['localhost', '127.0.0.1', '[::1]'].includes(db.hostname));
assert.match(db.pathname, /^\/dynaminds_test_\d+$/);
let app: Awaited<ReturnType<typeof buildApp>>;
let providerCalls = 0;
const transport = async (): Promise<never> => { providerCalls++; throw Error('Catalog export contract has no provider transport'); };
before(async () => { await migrate(); await seed(); app = await buildApp({ integrationTransport: transport }); });
after(async () => { try { await app?.close(); } finally { await pool.end(); } });
const definition = (f: Awaited<ReturnType<typeof productCatalogFixture>>) => ({
  catalog_id: f.defaultCatalog.id as string, format: 'csv', selection: 'selected', ids: [f.product.id],
  columns: ['id', 'sku', 'price_minor'], headers: {}, spreadsheet_safe: false,
});
const fileQuery = (body: ReturnType<typeof definition>, preview: any) => new URLSearchParams({
  catalog_id: body.catalog_id, catalog_version: preview.catalog_version, scope_hash: preview.scope_hash,
  format: body.format, selection: body.selection, ids: body.ids.join(','), columns: body.columns.join(','), spreadsheet_safe: 'false',
});
function contract(doc: any) {
  for (const [path, method] of [['/catalog/exports/options', 'get'], ['/catalog/exports/preview', 'post'], ['/catalog/exports/file', 'get'], ['/catalog/exports/file', 'post']] as const) {
    const op = doc.paths[path]?.[method]; assert(op, method + ' ' + path);
    assert.deepEqual(op.security, [{ bearerAuth: [] }]); assert.equal(op['x-read-only-operation'], true);
    assert.match(op.description, /products:read/);
  }
  const options = doc.paths['/catalog/exports/options'].get;
  assert(options.parameters.some((p: any) => p.in === 'query' && p.name === 'catalog_id' && p.schema.format === 'uuid' && p.required === false));
  assert(!options.parameters.some((p: any) => ['catalog_version', 'scope_hash'].includes(p.name)), 'options selects scope but does not require an earlier preview');
  const preview = doc.paths['/catalog/exports/preview'].post;
  const previewBody = preview.requestBody.content['application/json'].schema;
  assert.equal(previewBody.additionalProperties, false); assert.equal(previewBody.properties.catalog_id.format, 'uuid');
  assert(!previewBody.required?.includes('catalog_version')); assert(!previewBody.required?.includes('scope_hash'));
  assert(!previewBody.allOf?.some((s: any) => s.if?.required?.includes('catalog_id') && s.then?.required?.includes('catalog_version')), 'first preview never requires its own returned proof');
  const previewResponse = preview.responses['200'].content['application/json'].schema;
  assert(previewResponse.required.includes('sample')); assert(!previewResponse.required.includes('formats'));
  assert.equal(previewResponse.properties.sample.maxItems, 3); assert(previewResponse.properties.catalog_version); assert(previewResponse.properties.scope_hash);
  for (const method of ['get', 'post']) {
    const file = doc.paths['/catalog/exports/file'][method];
    const schema = method === 'get' ? file['x-query-schema'] : file.requestBody.content['application/json'].schema;
    assert(schema.allOf.some((s: any) => s.if?.required?.includes('catalog_id') && s.then?.required?.includes('catalog_version') && s.then.required.includes('scope_hash')));
    assert.deepEqual(schema.dependentRequired.catalog_version, ['catalog_id', 'scope_hash']);
    for (const header of ['X-Product-Catalog-ID', 'X-Product-Catalog-Version', 'X-Catalog-Export-Scope-Hash']) assert(file.responses['200'].headers[header], header);
    assert.equal(file.responses['200'].headers['X-Product-Catalog-ID'].schema.format, 'uuid');
    assert.match(file.description, /nie zamraża wierszy ani count/);
    assert.equal(file.responses['200'].content['text/csv'].schema.format, 'binary');
  }
  const params = doc.paths['/catalog/exports/file'].get.parameters;
  for (const name of ['catalog_id', 'catalog_version', 'scope_hash']) assert(params.some((p: any) => p.in === 'query' && p.name === name && p.required === false && p.description));
}

test('normal/v1 OpenAPI describes scoped read preview versus reviewed file and reusable profile correctly', async () => {
  const f = await productCatalogFixture(app), beforeRows = await productCatalogFacts(f.tenant);
  for (const path of ['/developer/openapi', '/v1/openapi']) {
    const response = await app.inject({ url: '/api' + path, headers: { cookie: f.cookie } }); assert.equal(response.statusCode, 200);
    const doc = response.json(); contract(doc);
    for (const [path, method] of [['/catalog/export-profiles', 'post'], ['/catalog/export-profiles/{id}', 'patch']] as const) {
      const profile = doc.paths[path][method].requestBody.content['application/json'].schema.properties.definition;
      assert.equal(profile.properties.catalog_id.format, 'uuid'); assert(!profile.required?.includes('catalog_id'));
      assert(!Object.hasOwn(profile.properties, 'catalog_version')); assert(!Object.hasOwn(profile.properties, 'scope_hash'));
      assert.match(doc.paths[path][method].description, /świeży podgląd/);
    }
  }
  assert.deepEqual(await productCatalogFacts(f.tenant), beforeRows); assert.equal(providerCalls, 0);
});

test('real cookie and v1 read key accept first scoped preview, require reviewed file proof, and expose exact headers', async () => {
  const f = await productCatalogFixture(app);
  const key = await f.ok('/developer/keys', 'POST', { name: 'Own scoped export read', scopes: ['products:read'] }, 201);
  const body = definition(f), beforeRows = await productCatalogFacts(f.tenant);
  for (const apiKey of [undefined, key]) {
    const options = await f.ok('/catalog/exports/options?catalog_id=' + body.catalog_id, 'GET', undefined, 200, apiKey);
    assert.equal(options.catalog_available, true); assert.equal(options.catalog.id, body.catalog_id); assert.equal(typeof options.catalog.version, 'string');
    const preview = await f.ok('/catalog/exports/preview', 'POST', body, 200, apiKey);
    assert.equal(preview.catalog.id, body.catalog_id); assert.equal(preview.catalog_version, options.catalog.version); assert.match(preview.scope_hash, /^[a-f0-9]{64}$/);
    assert(preview.sample.some((p: any) => p.product_id === f.product.id)); assert.equal(Object.hasOwn(preview, 'formats'), false);
    const absent = await f.request('/catalog/exports/file', 'POST', body, apiKey); assert.equal(absent.statusCode, 422);
    const versionOnly = await f.request('/catalog/exports/file', 'POST', { ...body, catalog_version: preview.catalog_version }, apiKey); assert.equal(versionOnly.statusCode, 422);
    const wrong = await f.request('/catalog/exports/file', 'POST', { ...body, catalog_version: preview.catalog_version, scope_hash: '0'.repeat(64) }, apiKey); assert.equal(wrong.statusCode, 409);
    for (const file of [
      await f.request('/catalog/exports/file', 'POST', { ...body, catalog_version: preview.catalog_version, scope_hash: preview.scope_hash }, apiKey),
      await f.request('/catalog/exports/file?' + fileQuery(body, preview), 'GET', undefined, apiKey),
    ]) {
      assert.equal(file.statusCode, 200); assert.equal(file.headers['x-product-catalog-id'], body.catalog_id);
      assert.equal(String(file.headers['x-product-catalog-version']), preview.catalog_version); assert.equal(file.headers['x-catalog-export-scope-hash'], preview.scope_hash);
      assert.equal(String(file.headers['x-catalog-export-count']), '1'); assert(file.body.includes(f.product.sku));
    }
  }
  assert.deepEqual(await productCatalogFacts(f.tenant), beforeRows); assert.equal(providerCalls, 0);
});

test('restore retains scoped preview/file pure reads normal/v1 and refuses profile mutation before parsing', async () => {
  const f = await productCatalogFixture(app), body = definition(f);
  const readonly = await buildApp({ readOnly: true, previewPort: 4197, integrationTransport: transport });
  try {
    const rejected = await readonly.inject({ url: '/api/catalog/exports/options', headers: { cookie: f.cookie } }); assert.equal(rejected.statusCode, 401);
    const login = await readonly.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'admin@demo.local', password: 'DynaDemo!2026' } }); assert.equal(login.statusCode, 200);
    const switched = await readonly.inject({ method: 'POST', url: '/api/workspaces/switch', headers: { cookie: String(login.headers['set-cookie']).split(';')[0] }, payload: { tenant_id: f.tenant } }); assert.equal(switched.statusCode, 200);
    const cookie = String(switched.headers['set-cookie']).split(';')[0], beforeRows = await productCatalogFacts(f.tenant);
    for (const prefix of ['/api', '/api/v1']) {
      const options = await readonly.inject({ url: prefix + '/catalog/exports/options?catalog_id=' + body.catalog_id, headers: { cookie } }); assert.equal(options.statusCode, 200); assert.equal(options.json().read_only, true);
      const preview = await readonly.inject({ method: 'POST', url: prefix + '/catalog/exports/preview', headers: { cookie }, payload: body }); assert.equal(preview.statusCode, 200); assert.equal(preview.json().read_only, true);
      const p = preview.json();
      for (const file of [
        await readonly.inject({ method: 'POST', url: prefix + '/catalog/exports/file', headers: { cookie }, payload: { ...body, catalog_version: p.catalog_version, scope_hash: p.scope_hash } }),
        await readonly.inject({ url: prefix + '/catalog/exports/file?' + fileQuery(body, p), headers: { cookie } }),
      ]) { assert.equal(file.statusCode, 200); assert.equal(file.headers['x-catalog-export-scope-hash'], p.scope_hash); assert(file.body.includes(f.product.sku)); }
      for (const path of ['/catalog/export-profiles', '/catalog/export-profiles/' + randomUUID()]) {
        const denied = await readonly.inject({ method: path.endsWith('/export-profiles') ? 'POST' : 'PATCH', url: prefix + path, headers: { cookie, 'content-type': 'application/json' }, payload: '{' }); assert.equal(denied.statusCode, 423);
      }
    }
    const doc = publicApiDocument({ readOnly: true, port: 4197 }) as any; contract(doc);
    assert.equal(doc.paths['/catalog/export-profiles']?.post, undefined); assert.equal(doc.paths['/catalog/export-profiles/{id}']?.patch, undefined);
    assert.deepEqual(await productCatalogFacts(f.tenant), beforeRows); assert.equal(providerCalls, 0);
  } finally { await readonly.close(); }
});
