/** Source authored only. Root executes with its disposable PostgreSQL harness. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { SaxesParser } from 'saxes';
import { buildApp } from '../server/app';
import { migrate, pool } from '../server/db';
import { publicApiDocument } from '../server/developer-api';
import { seed } from './fixtures';
import { productCatalogFacts } from './product-catalogs-fixture';
import { stocktakeAdjustmentFixture, countedAdjustmentSource, adjustmentActor, type AdjustmentTestRow as Row } from './stocktake-adjustments-fixture';

assert.equal(process.env.DYNA_TEST, 'true');
const database = new URL(process.env.DATABASE_URL ?? '');
assert(['localhost', '127.0.0.1', '[::1]'].includes(database.hostname));
assert.match(database.pathname, /^\/dynaminds_test_\d+$/);
let app: Awaited<ReturnType<typeof buildApp>>, providers = 0;
const base = '/stocktake-adjustments';
before(async () => {
  await migrate(); await seed();
  app = await buildApp({ integrationTransport: async () => { providers++; throw Error('Register contract must not call providers'); } });
});
after(async () => { try { assert.equal(providers, 0); await app?.close(); } finally { await pool.end(); } });

async function genuinePosted(on: boolean) {
  const f = await stocktakeAdjustmentFixture(app, on), source = await countedAdjustmentSource(f);
  const series: Record<string, Row> = {};
  for (const kind of ['PW', 'RW']) series[kind] = (await f.ok(base + '/series', 'POST', {
    client_key: randomUUID(), kind, name: 'Own register ' + kind, prefix: 'REG-' + kind + '-' + randomUUID().slice(0, 8).toUpperCase(),
  }, 201)).series;
  const preview = (await f.ok(base + '/previews', 'POST', {
    client_key: randomUUID(), source_kind: source.source_kind, stocktake_id: source.id, version: source.version,
    ...(on ? { review_id: source.review_id, scope_hash: source.scope_hash } : { review_hash: source.review_hash }),
    pw_series_id: series.PW.id, rw_series_id: series.RW.id,
  }, 201)).preview;
  const posted = await f.ok(base + '/previews/' + preview.id + '/post', 'POST', {
    client_key: randomUUID(), scope_hash: preview.scope_hash, confirmed: true,
  }, 201);
  assert.equal(posted.documents.length, 2);
  for (const d of posted.documents) assert.equal(d.row_count, 3);
  return { f, source, posted };
}
type Born = Awaited<ReturnType<typeof genuinePosted>>;
const born = new Map<boolean, Promise<Born>>();
function fixture(on: boolean) { let value = born.get(on); if (!value) { value = genuinePosted(on); born.set(on, value); } return value; }
const hidden = ['unit_cost_minor', 'value_minor', 'currency', 'exponent', 'known_pw_minor', 'known_rw_minor', 'unknown_pw_quantity', 'unknown_rw_quantity', 'rows_sha256', 'private_scope_nonce', 'nonce', 'scope_hash'];
function noPrivateValue(value: unknown) {
  const json = JSON.stringify(value);
  for (const key of hidden) assert(!json.includes('"' + key + '"'), 'Quantity export/register must omit ' + key);
  const content = (value as Row)?.content;
  if (typeof content === 'string') for (const key of hidden) assert(!content.includes(key), 'Export file itself must omit ' + key);
}
function completeContent(reply: Row, d: Born) {
  // Each genuine PW/RW has exactly one row for each distinct product. A forged
  // row_count cannot disguise an omitted product in either serialized format.
  for (const p of d.f.products) assert.equal(reply.content.split(p.id).length - 1, 1, 'Each actual product UUID occurs exactly once');
  if (reply.format === 'xml') {
    assert(!reply.content.includes('<!DOCTYPE')); const parser = new SaxesParser(); let error: Error | undefined;
    parser.on('error', e => { error = e; }); parser.write(reply.content).close(); assert.equal(error, undefined, 'Export is complete structural XML');
  }
}

test('public v1 register/export contract requires inventory read, preserves old164 paths, and remains readable in restore', () => {
  const document = publicApiDocument(), paths = document.paths as Record<string, any>;
  for (const path of [base + '/register', base + '/documents/{id}/export']) {
    const op = paths[path]?.get; assert(op, path);
    assert.deepEqual(op['x-required-scopes'], ['inventory:read']);
    assert.deepEqual(op['x-value-required-scopes'], ['purchasing:read']);
    assert.equal(op['x-value-required-role'], 'admin');
    assert.equal(paths[path].post, undefined, 'Export/register are GETs, not mutation commands');
  }
  const parameters = paths[base + '/register'].get.parameters;
  for (const name of ['kind', 'source_kind', 'warehouse_id', 'number_prefix', 'from', 'to', 'cursor', 'limit']) assert(parameters.some((p: any) => p.name === name), name);
  assert.equal(parameters.find((p: any) => p.name === 'limit').schema.maximum, 50);
  assert.equal(parameters.find((p: any) => p.name === 'cursor').schema.maxLength, 4096);
  const exporting = paths[base + '/documents/{id}/export'].get.parameters;
  assert.equal(exporting.find((p: any) => p.name === 'format').required, true);
  assert.deepEqual(exporting.find((p: any) => p.name === 'format').schema.enum, ['csv', 'xml']);
  assert(exporting.some((p: any) => p.name === 'include_values'));
  assert(paths[base + '/documents'].get); assert(paths[base + '/documents/{id}/rows'].get);
  assert(paths[base + '/previews/{id}/post'].post, 'Legacy single-post descriptor stays installed');
  const restored = publicApiDocument({ readOnly: true, port: 4198 }).paths as Record<string, any>;
  assert(restored[base + '/register'].get); assert(restored[base + '/documents/{id}/export'].get);
  for (const path of ['/series', '/previews', '/previews/{id}/post']) assert.equal(restored[base + path]?.post, undefined);
});

test('real ON v1 inventory-only register/export omits costs and source hashes; explicit values require current purchasing read', async () => {
  const d = await fixture(true);
  const key = await d.f.ok('/developer/keys', 'POST', { name: 'Own quantity register reader', scopes: ['inventory:read'] }, 201);
  const full = await d.f.ok('/developer/keys', 'POST', { name: 'Own valued register reader', scopes: ['inventory:read', 'purchasing:read'] }, 201);
  const unrelated = await d.f.ok('/developer/keys', 'POST', { name: 'Own unrelated read capability', scopes: ['products:read'] }, 201);
  const before = await productCatalogFacts(d.f.tenant);
  const page = await d.f.ok(base + '/register?limit=50', 'GET', undefined, 200, key);
  assert.equal(page.can_read_value, false); assert.equal(page.data.length, 2); assert.equal(page.meta.cursor, null); noPrivateValue(page);
  for (const document of d.posted.documents) {
    const path = base + '/documents/' + document.id + '/export';
    for (const format of ['csv', 'xml']) {
      const result = await d.f.ok(path + '?format=' + format, 'GET', undefined, 200, key);
      assert.equal(result.values_included, false); assert.equal(result.format, format); assert.equal(result.document.id, document.id);
      assert.equal(result.row_count, 3); assert.equal(result.document.row_count, 3);
      assert.equal(result.content_type, format === 'csv' ? 'text/csv; charset=utf-8' : 'application/xml; charset=utf-8');
      assert.equal(typeof result.content, 'string'); assert(result.content.length > 0); noPrivateValue(result); completeContent(result, d);
      const eligibleButFalse = await d.f.ok(path + '?format=' + format + '&include_values=false', 'GET', undefined, 200, full);
      assert.equal(eligibleButFalse.values_included, false); noPrivateValue(eligibleButFalse);
      assert.equal((await d.f.request(path + '?format=' + format + '&include_values=true', 'GET', undefined, key)).statusCode, 403);
      const valued = await d.f.ok(path + '?format=' + format + '&include_values=true', 'GET', undefined, 200, full);
      assert.equal(valued.values_included, true); assert.equal(valued.can_read_value, true); assert.equal(valued.row_count, 3); completeContent(valued, d);
    }
    assert.equal((await d.f.request(path + '?format=csv', 'GET', undefined, unrelated)).statusCode, 403);
    for (const suffix of ['', '?format=html', '?format=csv&include_values=0', '?format=csv&extra=secret']) assert.equal((await d.f.request(path + suffix)).statusCode, 422);
  }
  assert.equal((await d.f.request(base + '/register', 'GET', undefined, unrelated)).statusCode, 403);
  for (const suffix of ['?limit=51', '?from=2026-10-08T00:00:00Z&to=2026-10-07T00:00:00Z', '?number_prefix=%00', '?kind=INVOICE', '?cost_filter=1']) assert.equal((await d.f.request(base + '/register' + suffix)).statusCode, 422);
  assert.deepEqual(await productCatalogFacts(d.f.tenant), before, 'GET/denials do not allocate document numbers, write audit, or alter physical stock');
});

test('actual opaque cursor binds tenant/user/key/filters/limit and yields deterministic complete PW/RW pages without side effects', async () => {
  const d = await fixture(true), other = await fixture(false);
  const sibling = await adjustmentActor(app, d.f.tenant, 'operator@demo.local'); assert.notEqual(sibling.user, d.f.user);
  const key = await d.f.ok('/developer/keys', 'POST', { name: 'Own cursor bound read key', scopes: ['inventory:read'] }, 201);
  const before = await productCatalogFacts(d.f.tenant), beforeOther = await productCatalogFacts(other.f.tenant);
  const first = await d.f.ok(base + '/register?limit=1'); assert.equal(first.data.length, 1); assert.equal(first.meta.limit, 1);
  const cursor = first.meta.cursor; assert.equal(typeof cursor, 'string'); assert.match(cursor, /^[A-Za-z0-9_-]+$/); assert(cursor.length <= 4096);
  assert(!cursor.includes(first.data[0].id), 'Opaque cursor does not publish source identities or value hashes');
  const nextPath = base + '/register?limit=1&cursor=' + encodeURIComponent(cursor);
  const next = await d.f.ok(nextPath); assert.equal(next.data.length, 1); assert.equal(next.meta.cursor, null);
  assert.deepEqual(new Set([first.data[0].id, next.data[0].id]), new Set(d.posted.documents.map((v: Row) => v.id)));
  assert.deepEqual((await d.f.ok(nextPath)).data, next.data, 'Repeating a read cursor yields the same saved second document');
  for (const suffix of ['limit=2', 'limit=1&kind=PW', 'limit=1&source_kind=quantity', 'limit=1&number_prefix=REG'])
    assert.equal((await d.f.request(base + '/register?' + suffix + '&cursor=' + encodeURIComponent(cursor))).statusCode, 409);
  assert.equal((await sibling.request(nextPath)).statusCode, 409);
  assert.equal((await other.f.request(nextPath)).statusCode, 409);
  assert.equal((await d.f.request(nextPath, 'GET', undefined, key)).statusCode, 409);
  assert.equal((await d.f.request(base + '/register?limit=1&cursor=notAnAuthenticatedCursor')).statusCode, 422);
  assert.equal((await other.f.request(base + '/documents/' + d.posted.documents[0].id + '/export?format=xml')).statusCode, 404);
  assert.equal((await other.f.request(base + '/register?warehouse_id=' + d.f.warehouse.id)).statusCode, 404);
  const literal = await d.f.ok(base + '/register?number_prefix=' + encodeURIComponent(d.posted.documents[0].number));
  assert.deepEqual(literal.data.map((v: Row) => v.id), [d.posted.documents[0].id]); assert.equal(literal.meta.cursor, null);
  const pw = await d.f.ok(base + '/register?kind=PW&source_kind=wms&warehouse_id=' + d.f.warehouse.id);
  assert.deepEqual(pw.data.map((v: Row) => v.id), d.posted.documents.filter((v: Row) => v.kind === 'PW').map((v: Row) => v.id));
  assert.deepEqual(await productCatalogFacts(d.f.tenant), before); assert.deepEqual(await productCatalogFacts(other.f.tenant), beforeOther);
});

test('real restored App permits register/complete export GET while normal/v1 mutations reject malformed JSON before auth/parse', async () => {
  const d = await fixture(false), copy = await buildApp({ readOnly: true, previewPort: 4198 });
  try {
    assert.equal((await copy.inject({ url: '/api' + base + '/register', headers: { cookie: d.f.cookie } })).statusCode, 401, 'Primary cookie is not a copy cookie');
    const remoteAddress = '127.165.1.1';
    const login = await copy.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'admin@demo.local', password: 'DynaDemo!2026' }, remoteAddress });
    assert.equal(login.statusCode, 200);
    const switched = await copy.inject({ method: 'POST', url: '/api/workspaces/switch', payload: { tenant_id: d.f.tenant }, headers: { cookie: String(login.headers['set-cookie']).split(';')[0] }, remoteAddress });
    assert.equal(switched.statusCode, 200); const cookie = String(switched.headers['set-cookie']).split(';')[0];
    const before = await productCatalogFacts(d.f.tenant);
    const page = await copy.inject({ url: '/api' + base + '/register', headers: { cookie }, remoteAddress });
    assert.equal(page.statusCode, 200); assert.equal(page.json().read_only, true); assert.equal(page.json().data.length, 2);
    for (const document of d.posted.documents) {
      const result = await copy.inject({ url: '/api' + base + '/documents/' + document.id + '/export?format=csv', headers: { cookie }, remoteAddress });
      assert.equal(result.statusCode, 200); assert.equal(result.json().read_only, true); assert.equal(result.json().values_included, false); assert.equal(result.json().row_count, 3); noPrivateValue(result.json());
      const explicitValue = await copy.inject({ url: '/api' + base + '/documents/' + document.id + '/export?format=xml&include_values=true', headers: { cookie }, remoteAddress });
      assert.equal(explicitValue.statusCode, 200); assert.equal(explicitValue.json().values_included, false, 'OFF export does not fabricate layer values even for an eligible admin'); noPrivateValue(explicitValue.json());
    }
    for (const namespace of ['/api', '/api/v1']) for (const suffix of ['/series', '/previews', '/previews/' + d.posted.receipt.preview_id + '/post']) {
      const result = await copy.inject({ method: 'POST', url: namespace + base + suffix, payload: '{', headers: { 'content-type': 'application/json' }, remoteAddress });
      assert.equal(result.statusCode, 423, 'Read-only refusal precedes malformed JSON and missing authentication'); assert.equal(result.headers['set-cookie'], undefined);
    }
    assert.deepEqual(await productCatalogFacts(d.f.tenant), before, 'Reads and preparse refusals are inert after deliberate isolated copy login');
  } finally { await copy.close(); }
});
