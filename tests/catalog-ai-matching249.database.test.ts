/** DOM-AI-005 on migration 249 (prepared as placeholder 255): category and parameter match proposals for Allegro. The request freezes the
 * product data and the channel candidates/definitions (simulation or a fake Allegro account through the existing
 * channel read), the AI lane (tickCatalogAiMatches) runs one local inference with a fake Ollama, the output is
 * validated against the frozen lists, and the admin accepts with explicit consent and a product-version CAS; the
 * accepted match is readable for the offer form. Same key = same proposal, other body = 409, other tenant = 404,
 * viewer/operator = 403, stale lease → failed, inference lock held → stays queued, product/model change → conflict.
 * Database test on a fresh disposable clone dynaminds_m249_YYYYMMDD_NN; the real migrate() applies 218...249
 * (before() asserts the ledger row 249_catalog_ai). */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { buildApp } from '../server/app';
import { migrate, pool, tenantTx } from '../server/db';
import { seed, DEMO_TENANT } from './fixtures';
import { encrypt } from '../server/security';
import { readScopes, offerWriteScope, type IntegrationContext } from '../server/channel-access';
import { allegroSettingsReadScope } from '../server/allegro-creation';
import { tickCatalogAiMatches } from '../server/catalog-ai-matching';
import { catalogAiMatchesAvailable } from '../server/catalog-ai-matching-routes';
import type { Transport } from '../server/integrations';

assert.equal(process.env.DYNA_TEST, 'true');
const database = new URL(process.env.DATABASE_URL ?? 'invalid://missing');
assert.equal(database.hostname, '127.0.0.1');
assert.equal(database.port, '57084');
assert.match(database.pathname, /^\/dynaminds_m(?:249|25[0123456789]|26[0123])_2026[0-9]{4}_[0-9]{2}$/, 'fresh clone dynaminds_m249_YYYYMMDD_NN (or m250/m251/m252/m253/m254/m255/m256/m257/m258/m259/m260/m261/m262/m263 after 250/251/252/253/254/255/256/257/258/259/260/261/262) required (the real migrate() applies 249)');
pool.options.options = String(pool.options.options).replace('statement_timeout=8000', 'statement_timeout=60000');

const CAT = ['10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002'];
const MODEL = 'qa-local:small';
let app: Awaited<ReturnType<typeof buildApp>>, warehouse = '';
const cookies: Record<string, string> = {};
let calls: { url: string; body: any }[] = [], modelDigest = 'a'.repeat(64), content: any = {};
const json = (v: any, status = 200) => new Response(JSON.stringify(v), { status });
const transport: Transport = async (url, init: any = {}) => {
  const u = new URL(url);
  calls.push({ url, body: init.body ? JSON.parse(String(init.body)) : null });
  if (u.origin === 'http://127.0.0.1:11435') {
    if (u.pathname === '/api/tags')
      return json({ models: [{ name: MODEL, digest: modelDigest, size: 100, details: { format: 'gguf' } }] });
    assert.equal(u.pathname, '/api/chat');
    return json({ model: MODEL, done: true, done_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(content) }, prompt_eval_count: 10, eval_count: 5, total_duration: 1e6 });
  }
  assert.equal(u.hostname, 'api.allegro.pl.allegrosandbox.pl', 'only the fake Allegro sandbox host');
  if (u.pathname === '/sale/products')
    return json({ products: [{ id: CAT[0], name: 'Kubek katalogowy QA', category: { id: '123' } }, { id: CAT[1], name: 'Termos QA', category: { id: '124' } }] });
  if (u.pathname === '/sale/categories/123/parameters' || u.pathname === '/sale/categories/124/parameters')
    return json({ parameters: [
      { id: '11323', name: 'Stan', type: 'dictionary', required: true, options: { describesProduct: false }, restrictions: { multipleChoices: false }, dictionary: [{ id: '11323_1', value: 'Nowy' }, { id: '11323_2', value: 'Używany' }] },
      { id: '1234', name: 'EAN', type: 'string', options: { describesProduct: true } },
    ] });
  throw new Error('Unexpected request ' + url);
};
const ctx: IntegrationContext = {
  transport,
  oauthConfig: () => ({ clientId: 'test', clientSecret: 'fixture', redirectUri: 'http://127.0.0.1:4100/api/oauth/allegro/callback' }),
};
const api = (url: string, method: any = 'GET', payload?: any, who = 'admin') =>
  app.inject({ url: '/api' + url, method, payload, headers: { cookie: cookies[who] } });
async function ok(url: string, method: any = 'GET', payload?: any, status?: number) {
  const r = await api(url, method, payload);
  if (status) assert.equal(r.statusCode, status, method + ' ' + url + ' ' + r.body);
  else assert(r.statusCode < 300, method + ' ' + url + ' ' + r.statusCode + ' ' + r.body);
  return r.json();
}
async function product(extra: any = {}) {
  return ok('/products', 'POST', { sku: 'M255-' + randomUUID().slice(0, 8), name: 'Kubek QA', description: 'Stalowy kubek 350 ml.', attributes: { Kolor: 'czarny', Stan: 'Nowy' }, price: 2500, quantity: 5, warehouse_id: warehouse, ...extra }, 201);
}
async function channel(simulation: boolean) {
  const id = randomUUID();
  await tenantTx(DEMO_TENANT, (c) => c.query(
    "INSERT INTO channels(id,tenant_id,name,provider,mode,settings,credentials,oauth_scopes,token_expires_at) VALUES($1,$2,'Allegro M255','allegro','sandbox',$3,$4,$5,now()+interval '1 hour')",
    [id, DEMO_TENANT, JSON.stringify({ simulation }), encrypt({ access_token: 'fixture', refresh_token: 'refresh' }), [readScopes, offerWriteScope, allegroSettingsReadScope].join(' ')]));
  return id;
}
const queue = (p: any, ch: string, extra: any = {}) => ({ version: p.version, client_key: randomUUID(), model: MODEL, integration_id: ch, ...extra });
const row = async (id: string) => (await pool.query('SELECT * FROM catalog_ai_match_proposals WHERE id=$1', [id])).rows[0];

before(async () => {
  await migrate();
  assert.equal((await pool.query("SELECT count(*)::int n FROM migrations WHERE name='249_catalog_ai'")).rows[0].n, 1, 'migrate() applied 249');
  await seed();
  app = await buildApp({ integrationTransport: transport, oauthConfig: ctx.oauthConfig });
  // buildApp registers the DOM-AI-005 routes itself once 249 is installed (registerCatalogAiRoutes, extensions.matches).
  assert.equal(await catalogAiMatchesAvailable(pool), true);
  for (const who of ['admin', 'viewer', 'operator', 'other']) {
    const r = await app.inject({ url: '/api/auth/login', method: 'POST', payload: { email: who + '@demo.local', password: 'DynaDemo!2026' } });
    assert.equal(r.statusCode, 200, r.body);
    cookies[who] = r.headers['set-cookie']!.toString().split(';')[0];
  }
  warehouse = (await ok('/warehouses')).data[0].id;
});
beforeEach(async () => {
  await pool.query("UPDATE catalog_ai_match_proposals SET state='cancelled' WHERE state='queued'");
  calls = [];
  modelDigest = 'a'.repeat(64);
  content = { candidate_id: CAT[0], reason: 'Kubek', parameters: [{ id: '11323', values: ['Nowy'] }, { id: '999', values: ['x'] }, { id: '11323', value_ids: ['11323_9'] }] };
});
after(async () => {
  await app.close();
  await pool.end();
});

test('simulation: queue once per key, AI lane proposes; a simulated match is never accepted (M6); consent with version CAS records an Allegro match', async () => {
  const p = await product(), ch = await channel(true), body = queue(p, ch);
  const m = await ok('/products/' + p.id + '/ai/matches', 'POST', body, 201);
  assert.equal(m.state, 'queued');
  assert.equal(m.phrase, 'Kubek QA');
  assert.equal(m.snapshot.scope, 'local_simulation');
  assert.equal(m.simulated, true);
  assert.equal((await ok('/products/' + p.id + '/ai/matches', 'POST', body, 201)).id, m.id, 'same key and body = same proposal');
  assert.equal((await api('/products/' + p.id + '/ai/matches', 'POST', { ...body, phrase: 'inna' })).statusCode, 409);
  assert.equal((await api('/products/' + p.id + '/ai/matches', 'POST', queue({ ...p, version: p.version + 1 }, ch))).statusCode, 409);
  assert.equal((await api('/products/' + p.id + '/ai/matches', 'POST', queue(p, ch, { model: 'brak:1b' }))).statusCode, 422);
  assert.equal(calls.filter((c) => c.url.includes('allegro')).length, 0, 'simulation reads no provider');

  assert.equal(await tickCatalogAiMatches(transport), true);
  assert.equal(await tickCatalogAiMatches(transport), false);
  const chat = calls.find((c) => c.url.endsWith('/api/chat'))!;
  const sent = JSON.parse(chat.body.messages[1].content);
  assert.deepEqual(Object.keys(sent.product).sort(), ['attributes', 'category', 'description', 'name']);
  assert(!chat.body.messages[1].content.includes(p.sku), 'no SKU');
  assert.equal(chat.body.keep_alive, 0);

  let list = await ok('/products/' + p.id + '/ai/matches?integration_id=' + ch);
  assert.equal(list.available, true);
  assert.equal(list.accepted, null);
  const ready = list.data.find((x: any) => x.id === m.id);
  assert.equal(ready.state, 'ready');
  assert.equal(ready.proposal.category_id, '123');
  assert.deepEqual(ready.proposal.parameters.map((x: any) => [x.id, x.value, x.current]), [['11323', { valuesIds: ['11323_1'] }, 'Nowy']]);
  assert.deepEqual(ready.proposal.rejected.map((x: any) => x.id), ['999', '11323']);

  const accept = { approve: true, version: p.version, candidate_id: CAT[0], category_id: '123', parameters: ['11323'] };
  // M6: a local simulation's candidates and parameters are examples, not the channel's catalogue.
  const simulated = await api('/ai/catalog/matches/' + m.id + '/accept', 'POST', accept);
  assert.equal(simulated.statusCode, 409, simulated.body);
  assert.match(simulated.body, /symulacji/);
  assert.equal((await row(m.id)).state, 'ready', 'the simulated proposal stays a proposal');
  assert.equal((await ok('/products/' + p.id + '/ai/matches?integration_id=' + ch)).accepted, null);
  assert.equal((await ok('/ai/catalog/matches/' + m.id + '/reject', 'POST', {})).match.state, 'rejected', 'it can still be rejected');

  // The same decision on a proposal read from the (fake) Allegro account is accepted.
  const live = await channel(false);
  const n = await ok('/products/' + p.id + '/ai/matches', 'POST', queue(p, live), 201);
  assert.equal(n.simulated, false);
  assert.equal(await tickCatalogAiMatches(transport), true);
  assert.equal((await row(n.id)).state, 'ready');
  assert.equal((await api('/ai/catalog/matches/' + n.id + '/accept', 'POST', { ...accept, version: p.version + 1 })).statusCode, 409);
  assert.equal((await api('/ai/catalog/matches/' + n.id + '/accept', 'POST', { ...accept, approve: false })).statusCode, 422);
  assert.equal((await api('/ai/catalog/matches/' + n.id + '/accept', 'POST', { ...accept, parameters: ['999'] })).statusCode, 422);
  assert.equal((await api('/ai/catalog/matches/' + n.id + '/accept', 'POST', { ...accept, category_id: '124' })).statusCode, 422);
  const done = await ok('/ai/catalog/matches/' + n.id + '/accept', 'POST', accept);
  assert.equal(done.reused, false);
  assert.equal(done.match.state, 'accepted');
  assert.deepEqual(done.match.accepted, { provider: 'allegro', candidate_id: CAT[0], catalog_product_id: CAT[0], category_id: '123', parameters: [{ id: '11323', valuesIds: ['11323_1'] }] });
  assert.equal((await ok('/ai/catalog/matches/' + n.id + '/accept', 'POST', accept)).reused, true);
  assert.equal((await api('/ai/catalog/matches/' + n.id + '/accept', 'POST', { ...accept, parameters: [] })).statusCode, 409);
  list = await ok('/products/' + p.id + '/ai/matches?integration_id=' + live);
  assert.equal(list.accepted.id, n.id);
  assert.equal((await pool.query('SELECT version FROM products WHERE id=$1', [p.id])).rows[0].version, p.version, 'accepting does not touch the product');
  await assert.rejects(pool.query("UPDATE catalog_ai_match_proposals SET source='{}' WHERE id=$1", [n.id]), /immutable/);
  await assert.rejects(pool.query("UPDATE catalog_ai_match_proposals SET state='rejected' WHERE id=$1", [n.id]), /immutable/);
  const actions = (await pool.query('SELECT action FROM audit_events WHERE entity_id=$1 ORDER BY created_at', [n.id])).rows.map((r) => r.action);
  assert.deepEqual([...new Set(actions)].sort(), ['catalog.ai.match.accept', 'catalog.ai.match.finish', 'catalog.ai.match.queue']);
});

test('Allegro account: candidates and definitions read through the channel, cancel and reject', async () => {
  const p = await product({ ean: '5901234123457' }), ch = await channel(false);
  const m = await ok('/products/' + p.id + '/ai/matches', 'POST', queue(p, ch), 201);
  assert.equal(m.phrase, '5901234123457', 'EAN is the default catalog phrase');
  assert.equal(m.simulated, false);
  const search = calls.find((c) => c.url.includes('/sale/products'))!;
  assert.equal(new URL(search.url).searchParams.get('phrase'), '5901234123457');
  assert.deepEqual(m.snapshot.candidates.map((c: any) => [c.id, c.category_id]), [[CAT[0], '123'], [CAT[1], '124']]);
  assert.deepEqual(m.snapshot.categories['123'].parameters.map((x: any) => x.id), ['11323'], 'describesProduct dropped');
  assert.equal((await api('/ai/catalog/matches/' + m.id + '/reject', 'POST', {})).statusCode, 409, 'only a ready proposal is rejected');
  assert.equal((await ok('/ai/catalog/matches/' + m.id + '/cancel', 'POST', {})).match.state, 'cancelled');
  assert.equal(await tickCatalogAiMatches(transport), false, 'cancelled proposal is not inferred');

  const n = await ok('/products/' + p.id + '/ai/matches', 'POST', queue(p, ch, { phrase: 'kubek stalowy' }), 201);
  assert.equal(n.phrase, 'kubek stalowy');
  content = { candidate_id: CAT[1], reason: 'Termos', parameters: [{ id: '11323', value_ids: ['11323_2'] }] };
  assert.equal(await tickCatalogAiMatches(transport), true);
  const r = await row(n.id);
  assert.equal(r.state, 'ready');
  assert.equal(r.proposal.category_id, '124');
  assert.equal((await ok('/ai/catalog/matches/' + n.id + '/reject', 'POST', {})).match.state, 'rejected');
  assert.equal((await api('/ai/catalog/matches/' + n.id + '/accept', 'POST', { approve: true, version: p.version, candidate_id: CAT[1], category_id: '124', parameters: [] })).statusCode, 409);
});

test('lane and access: lock held, product or model changed, stale lease, other tenant and roles', async () => {
  const p = await product(), ch = await channel(true);
  const a = await ok('/products/' + p.id + '/ai/matches', 'POST', queue(p, ch), 201);
  const lock = new pg.Client({ connectionString: pool.options.connectionString });
  await lock.connect();
  try {
    assert((await lock.query("SELECT pg_try_advisory_lock(hashtextextended('catalog-ai-inference',0)) l")).rows[0].l);
    assert.equal(await tickCatalogAiMatches(transport), false);
    assert.equal((await row(a.id)).state, 'queued');
  } finally {
    await lock.end();
  }
  await pool.query('UPDATE products SET version=version+1 WHERE id=$1', [p.id]);
  assert.equal(await tickCatalogAiMatches(transport), true);
  assert.equal((await row(a.id)).state, 'conflict');

  const q = { ...p, version: p.version + 1 };
  const b = await ok('/products/' + p.id + '/ai/matches', 'POST', queue(q, ch), 201);
  modelDigest = 'b'.repeat(64);
  assert.equal(await tickCatalogAiMatches(transport), true);
  assert.equal((await row(b.id)).state, 'conflict');
  modelDigest = 'a'.repeat(64);

  const c = await ok('/products/' + p.id + '/ai/matches', 'POST', queue(q, ch), 201);
  await pool.query("UPDATE catalog_ai_match_proposals SET state='running',attempts=1,lease_token=gen_random_uuid(),locked_at=now()-interval '10 minutes' WHERE id=$1", [c.id]);
  assert.equal(await tickCatalogAiMatches(transport), false);
  const stale = await row(c.id);
  assert.equal(stale.state, 'failed');
  assert.equal(stale.lease_token, null);
  assert.match(stale.error, /Dzierżawa/);

  assert.equal((await api('/products/' + p.id + '/ai/matches', 'GET', undefined, 'other')).statusCode, 404);
  assert.equal((await api('/products/' + p.id + '/ai/matches', 'POST', queue(q, ch), 'other')).statusCode, 404);
  assert.equal((await api('/ai/catalog/matches/' + a.id + '/cancel', 'POST', {}, 'other')).statusCode, 404);
  for (const who of ['viewer', 'operator']) {
    assert.equal((await api('/products/' + p.id + '/ai/matches', 'GET', undefined, who)).statusCode, 403);
    assert.equal((await api('/products/' + p.id + '/ai/matches', 'POST', queue(q, ch), who)).statusCode, 403);
  }
});
