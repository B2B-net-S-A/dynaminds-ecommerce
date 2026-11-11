/** S8 on migration 249 (prepared as placeholder 255): DOM-AI-001 style reaches the prompt, is frozen and bounds the description;
 * DOM-AI-003 batch generation with a result per item (feeder respects the per-firm queue, product changed before
 * feed = conflict, one failed item never blocks the others, bulk approval per item, idempotent key, tenant and role
 * checks); DOM-AI-002 typed PIM parameters (definitions frozen from PIM, values validated per type, accepted one by
 * one, written through PIM preview/apply with its CAS, replay, stale product refused).
 * Database test on a fresh disposable clone dynaminds_m249_YYYYMMDD_NN of the restored template; the real migrate()
 * applies 218...249 (before() asserts the ledger row 249_catalog_ai). The local model is a fake transport. */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../server/app';
import { migrate, pool, tenantTx, localConfig } from '../server/db';
import { createPimService, capturePimAuthority } from '../server/pim-dictionaries/service';
import { seed } from './fixtures';
import { tickCatalogAi } from '../server/catalog-ai';
import { feedCatalogAiBatches } from '../server/catalog-ai-batches';
import { tickCatalogAiAttributes, applyCatalogAiAttributes } from '../server/catalog-ai-attributes';
import type { Transport } from '../server/integrations';

assert.equal(process.env.DYNA_TEST, 'true');
const database = new URL(process.env.DATABASE_URL ?? 'invalid://missing');
assert.equal(database.hostname, '127.0.0.1');
assert.equal(database.port, '57084');
assert.match(database.pathname, /^\/dynaminds_m(?:249|25[0123456789]|26[0123])_2026[0-9]{4}_[0-9]{2}$/, 'fresh clone dynaminds_m249_YYYYMMDD_NN (or m250/m251/m252/m253/m254/m255/m256/m257/m258/m259/m260/m261/m262/m263 after 250/251/252/253/254/255/256/257/258/259/260/261/262) required (the real migrate() applies 249)');
pool.options.options = String(pool.options.options).replace('statement_timeout=8000', 'statement_timeout=60000');

let app: Awaited<ReturnType<typeof buildApp>>;
const cookies: Record<string, string> = {};
let warehouse = '';
const chats: { system: string; user: any }[] = [];
let answer: (user: any, system: string) => unknown = () => ({ name: 'Nazwa AI', description: 'Opis AI.' });
const transport: Transport = async (url, init) => {
  if (url.endsWith('/api/tags'))
    return Response.json({ models: [{ name: 'qa-local:small', digest: 'a'.repeat(64), size: 100, details: { format: 'gguf' } }] });
  assert(url.endsWith('/api/chat'), url);
  const b = JSON.parse(String(init?.body));
  const user = JSON.parse(b.messages[1].content), system = b.messages[0].content;
  chats.push({ system, user });
  return Response.json({ model: b.model, done: true, done_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(answer(user, system)) } });
};
const api = (url: string, method: any = 'GET', payload?: any, who = 'admin') =>
  app.inject({ url: '/api' + url, method, payload, headers: { cookie: cookies[who] } });
async function ok(url: string, method: any = 'GET', payload?: any, who = 'admin') {
  const r = await api(url, method, payload, who);
  assert(r.statusCode < 300, method + ' ' + url + ' ' + r.statusCode + ' ' + r.body);
  return r.json();
}
const product = (name: string, extra: any = {}) =>
  ok('/products', 'POST', { sku: 'AI255-' + randomUUID().slice(0, 8), name, description: 'Stalowy kubek 350 ml.', attributes: { Kolor: 'czarny' }, price: 2500, quantity: 3, warehouse_id: warehouse, ...extra });
const change = async (id: string, extra: any) => ok('/products/' + id, 'PATCH', { ...(await ok('/products/' + id)), ...extra });
async function drain() { for (let i = 0; i < 40; i++) if (!(await tickCatalogAi(transport)) && !(await tickCatalogAiAttributes(transport))) return; }
const style = { tone: 'marketing', length: 'short' };
let pause: { reached: () => void; released: Promise<void> } | undefined;

before(async () => {
  await migrate();
  assert.equal((await pool.query("SELECT count(*)::int n FROM migrations WHERE name='249_catalog_ai'")).rows[0].n, 1, 'migrate() applied 249');
  await seed();
  // The template carries old pending jobs; the AI lane must only see this file's work.
  await pool.query("UPDATE jobs SET state='done',lease_token=NULL WHERE kind='catalog.ai' AND state IN ('pending','running')");
  app = await buildApp({ integrationTransport: transport });
  // M1: the same apply path with a PIM service (same SQL as the app's) whose apply can be paused at its start.
  const realPim = createPimService({ sessionName: 'dyna_session', readOnly: false, cursorKey: localConfig.encryptionKey, transaction: (actor, _write, work) => tenantTx(actor.tenantId, work) });
  const pausedPim = {
    editorSource: realPim.editorSource,
    preview: realPim.preview,
    apply: async (...args: Parameters<typeof realPim.apply>) => {
      if (pause) { pause.reached(); await pause.released; }
      return realPim.apply(...args);
    },
  };
  app.post('/api/test/m1/attributes/:id/apply', async (req: any) => applyCatalogAiAttributes(req.actor, capturePimAuthority(req, 'dyna_session'), pausedPim, req.params.id, req.body));
  for (const who of ['admin', 'viewer', 'operator', 'other']) {
    const r = await app.inject({ url: '/api/auth/login', method: 'POST', payload: { email: who + '@demo.local', password: 'DynaDemo!2026' } });
    assert.equal(r.statusCode, 200, r.body);
    cookies[who] = r.headers['set-cookie']!.toString().split(';')[0];
  }
  warehouse = (await ok('/warehouses')).data[0].id;
});
beforeEach(async () => {
  await pool.query("UPDATE ai_catalog_drafts SET state='cancelled' WHERE state='queued'");
  await pool.query("UPDATE jobs SET state='done' WHERE kind='catalog.ai' AND state IN ('pending','running')");
  chats.length = 0;
  answer = () => ({ name: 'Nazwa AI', description: 'Opis AI.' });
});
after(async () => {
  await app.close();
  await pool.end();
});

test('DOM-AI-001 style is frozen in the draft, reaches the prompt and bounds the description length', async () => {
  const p = await product('Kubek stylowy');
  const key = randomUUID();
  const body = { version: p.version, client_key: key, model: 'qa-local:small', destination: 'catalog', locale: 'pl', style };
  const d = await ok('/products/' + p.id + '/ai', 'POST', body);
  assert.deepEqual(d.source.style, style);
  assert.equal((await api('/products/' + p.id + '/ai', 'POST', { ...body, style: { tone: 'technical', length: 'short' } })).statusCode, 409, 'same key, other style');
  answer = () => ({ name: 'Kubek, który pokochasz', description: 'x'.repeat(401) });
  await drain();
  const failed = (await ok('/products/' + p.id + '/ai')).data.find((x: any) => x.id === d.id);
  assert.equal(failed.state, 'failed');
  assert.match(failed.error, /wybranej długości/);
  assert.match(chats[0].system, /marketing tone.*at most 400 characters, in Polish/s);
  assert.deepEqual(Object.keys(chats[0].user.product).sort(), ['attributes', 'category', 'description', 'name'], 'style is not product data');
  answer = () => ({ name: 'Kubek, który pokochasz', description: 'Stalowy kubek 350 ml na co dzień.' });
  const d2 = await ok('/products/' + p.id + '/ai', 'POST', { ...body, client_key: randomUUID() });
  await drain();
  assert.equal((await ok('/products/' + p.id + '/ai')).data.find((x: any) => x.id === d2.id).state, 'ready');
  assert.equal((await ok('/products/' + p.id)).name, 'Kubek stylowy', 'nothing applied without approval');
});

test('DOM-AI-003 batch: result per item, conflict before feed, failed item does not block, bulk approval per item', async () => {
  const [a, b, c] = [await product('Partia A'), await product('Partia B'), await product('Partia C')];
  const key = randomUUID();
  const body = { client_key: key, model: 'qa-local:small', destination: 'catalog', locale: 'pl', style, products: [a, b, c].map((p) => ({ id: p.id, version: p.version })) };
  for (const who of ['viewer', 'operator']) assert.equal((await api('/ai/catalog/batches', 'POST', body, who)).statusCode, 403, who);
  const batch = await ok('/ai/catalog/batches', 'POST', body);
  assert.equal((await ok('/ai/catalog/batches', 'POST', body)).id, batch.id, 'same key = same batch');
  assert.equal((await api('/ai/catalog/batches', 'POST', { ...body, locale: 'en' })).statusCode, 409, 'same key, other body');
  assert.equal((await api('/ai/catalog/batches/' + batch.id, 'GET', undefined, 'other')).statusCode, 404, 'tenant isolation');
  assert.equal((await api('/ai/catalog/batches', 'POST', { ...body, client_key: randomUUID(), products: [{ id: randomUUID(), version: 1 }] })).statusCode, 404, 'unknown product');
  assert.deepEqual((await ok('/ai/catalog/batches/' + batch.id)).items.map((i: any) => i.state), ['waiting', 'waiting', 'waiting']);
  await change(b.id, { name: 'Partia B zmieniona' });
  assert.equal(chats.length, 0, 'nothing inferred before the feeder runs');
  await feedCatalogAiBatches();
  answer = (u) => (u.product.name === 'Partia C' ? { name: 'C', description: '<b>html</b>' } : { name: 'Nowa ' + u.product.name, description: 'Krótki opis.' });
  await drain();
  const view = await ok('/ai/catalog/batches/' + batch.id);
  assert.deepEqual(view.items.map((i: any) => [i.product_name, i.state, i.draft?.state ?? null]), [
    ['Partia A', 'drafted', 'ready'], ['Partia B zmieniona', 'conflict', null], ['Partia C', 'drafted', 'failed'],
  ]);
  assert.match(view.items[1].error, /zmieniono/);
  assert.equal(chats.length, 2, 'the changed product was never sent to the model');
  const items = view.items.map((i: any) => i.product_id);
  assert.equal((await api('/ai/catalog/batches/' + batch.id + '/apply', 'POST', { item_ids: items })).statusCode, 422, 'approval required');
  const applied = await ok('/ai/catalog/batches/' + batch.id + '/apply', 'POST', { approve: true, item_ids: [a.id, c.id] });
  assert.deepEqual(applied.results.map((r: any) => [r.product_id, r.outcome]), [[a.id, 'applied'], [c.id, 'failed']]);
  assert.equal((await ok('/products/' + a.id)).name, 'Nowa Partia A');
  assert.equal((await ok('/products/' + c.id)).name, 'Partia C', 'failed item changed nothing');
  const again = await ok('/ai/catalog/batches/' + batch.id + '/apply', 'POST', { approve: true, item_ids: [a.id] });
  assert.equal(again.results[0].outcome, 'applied', 'replayed approval reuses the applied draft');
  assert.equal((await ok('/products/' + a.id)).version, (await ok('/products/' + a.id)).version);
  const audit = (await pool.query("SELECT action FROM audit_events WHERE entity_id=$1 ORDER BY created_at", [batch.id])).rows.map((r) => r.action);
  assert.deepEqual(audit.filter((x) => x.startsWith('catalog.ai.batch')).slice(0, 2), ['catalog.ai.batch.queue', 'catalog.ai.batch.apply']);
});

test('DOM-AI-003 feeder fills only the free per-firm queue; the rest waits; cancel stops waiting items', async () => {
  const list = [];
  for (let i = 0; i < 11; i++) list.push(await product('Kolejka ' + i));
  const batch = await ok('/ai/catalog/batches', 'POST', { client_key: randomUUID(), model: 'qa-local:small', destination: 'translation', locale: 'en', products: list.map((p) => ({ id: p.id, version: p.version })) });
  await feedCatalogAiBatches();
  let view = await ok('/ai/catalog/batches/' + batch.id);
  assert.equal(view.items.filter((i: any) => i.state === 'drafted').length, 10);
  assert.equal(view.items.filter((i: any) => i.state === 'waiting').length, 1);
  await ok('/ai/catalog/batches/' + batch.id + '/cancel', 'POST', {});
  await feedCatalogAiBatches();
  view = await ok('/ai/catalog/batches/' + batch.id);
  assert.equal(view.state, 'cancelled');
  assert.deepEqual([...new Set(view.items.map((i: any) => i.draft?.state ?? i.state))].sort(), ['cancelled']);
});

async function pim(cid: string, body: any) {
  const rev = (await ok(`/product-catalogs/${cid}/pim/dictionary`)).revision;
  const preview = await ok(`/product-catalogs/${cid}/pim/previews`, 'POST', { client_key: randomUUID(), revision: rev, ...body });
  assert.equal(preview.ready, true, JSON.stringify(preview.errors));
  return ok(`/product-catalogs/${cid}/pim/previews/${preview.id}/apply`, 'POST', { client_key: randomUUID(), scope_hash: preview.scope_hash, confirmed: true });
}

test('DOM-AI-002 typed parameters: frozen definitions, per-type validation, per-value acceptance through PIM with CAS', async () => {
  const p = await product('Kubek parametry');
  const cid = (await ok('/products/' + p.id)).catalog_id;
  assert(cid, 'product has a catalog');
  const material = randomUUID(), volume = randomUUID(), color = randomUUID(), black = randomUUID(), white = randomUUID(), category = randomUUID();
  await pim(cid, { kind: 'dictionary', changes: [
    { kind: 'definition_create', id: material, name: 'Materiał ' + material.slice(0, 4), shape: { kind: 'text', max_length: 40 } },
    { kind: 'definition_create', id: volume, name: 'Pojemność ' + volume.slice(0, 4), shape: { kind: 'decimal', scale: 2, unit: 'l', minimum: '0.00', maximum: '5.00' } },
    { kind: 'definition_create', id: color, name: 'Kolor ' + color.slice(0, 4), shape: { kind: 'enum', options: [{ id: black, label: 'Czarny', active: true }, { id: white, label: 'Biały', active: true }] } },
    { kind: 'category_create', id: category, parent_id: null, name: 'Kubki ' + category.slice(0, 4) },
  ] });
  const cat = (await ok(`/product-catalogs/${cid}/pim/dictionary`)).categories.find((x: any) => x.id === category);
  await pim(cid, { kind: 'dictionary', changes: [{ kind: 'category_bindings', id: category, version: cat.version, bindings: [material, volume, color].map((definition_id) => ({ definition_id, required: false })) }] });
  const body = (version: number) => ({ version, client_key: randomUUID(), model: 'qa-local:small', locale: 'pl' });
  assert.equal((await api('/products/' + p.id + '/ai/attributes', 'POST', body(p.version))).statusCode, 422, 'no PIM category yet');
  const s = await ok(`/product-catalogs/${cid}/pim/products/${p.id}`);
  await pim(cid, { kind: 'product_values', rows: [{ product_id: p.id, product_version: s.product_version, state_version: s.state_version, source_hash: s.source_hash, category_id: category, values: [] }] });
  const current = await ok('/products/' + p.id);
  assert.equal((await api('/products/' + p.id + '/ai/attributes', 'POST', body(current.version), 'viewer')).statusCode, 403);
  const q = await ok('/products/' + p.id + '/ai/attributes', 'POST', body(current.version));
  assert.equal(q.state, 'queued');
  assert.deepEqual(q.definitions.map((d: any) => d.id).sort(), [material, volume, color].sort());
  answer = () => ({ values: [
    { definition_id: material, value: 'stal nierdzewna' },
    { definition_id: volume, value: '9.50' },
    { definition_id: color, value: 'Czarny' },
    { definition_id: randomUUID(), value: 'wymyślony' },
  ] });
  await drain();
  assert.match(chats.at(-1)!.system, /Polish/);
  assert(!JSON.stringify(chats.at(-1)!.user).includes(current.sku), 'no SKU, prices or customer data to the model');
  const ready = (await ok('/products/' + p.id + '/ai/attributes')).data.find((x: any) => x.id === q.id);
  assert.equal(ready.state, 'ready');
  assert.deepEqual(ready.output.map((e: any) => e.definition_id).sort(), [material, color].sort());
  assert.deepEqual(ready.refused.map((r: any) => r.reason).sort(), ['Nieznany parametr', 'Wartość poza zakresem 0.00–5.00']);
  assert.deepEqual((await ok(`/product-catalogs/${cid}/pim/products/${p.id}`)).values, [], 'nothing written before approval');
  assert.equal((await api('/ai/catalog/attributes/' + q.id + '/apply', 'POST', { approve: true, definition_ids: [volume] })).statusCode, 422, 'only proposed values');
  const r = await ok('/ai/catalog/attributes/' + q.id + '/apply', 'POST', { approve: true, definition_ids: [material] });
  assert.equal(r.reused, false);
  assert.deepEqual((await ok(`/product-catalogs/${cid}/pim/products/${p.id}`)).values, [{ definition_id: material, kind: 'text', value: 'stal nierdzewna' }]);
  assert.equal((await ok('/ai/catalog/attributes/' + q.id + '/apply', 'POST', { approve: true, definition_ids: [material] })).reused, true);
  assert.equal((await api('/ai/catalog/attributes/' + q.id + '/apply', 'POST', { approve: true, definition_ids: [material, color] })).statusCode, 409, 'other decision after apply');
  const audit = (await pool.query("SELECT action FROM audit_events WHERE entity_id=$1 ORDER BY created_at", [q.id])).rows.map((x) => x.action);
  assert.deepEqual(audit, ['catalog.ai.attributes.queue', 'catalog.ai.attributes.apply']);
  // Stale: the product changes after the proposal; the PIM CAS refuses and nothing is written.
  const q2 = await ok('/products/' + p.id + '/ai/attributes', 'POST', body((await ok('/products/' + p.id)).version));
  answer = () => ({ values: [{ definition_id: color, value: white }] });
  await drain();
  await change(p.id, { name: 'Kubek parametry 2' });
  assert.equal((await api('/ai/catalog/attributes/' + q2.id + '/apply', 'POST', { approve: true, definition_ids: [color] })).statusCode, 409);
  assert.deepEqual((await ok(`/product-catalogs/${cid}/pim/products/${p.id}`)).values.map((v: any) => v.definition_id), [material]);
  assert.equal((await api('/products/' + p.id + '/ai/attributes', 'GET', undefined, 'other')).statusCode, 404, 'tenant isolation');
});

test('DOM-AI-002 cancel during apply (M1): the PIM write and the proposal state never disagree', async () => {
  const p = await product('Kubek wyścig');
  const cid = (await ok('/products/' + p.id)).catalog_id;
  const material = randomUUID(), category = randomUUID();
  await pim(cid, { kind: 'dictionary', changes: [
    { kind: 'definition_create', id: material, name: 'Materiał ' + material.slice(0, 4), shape: { kind: 'text', max_length: 40 } },
    { kind: 'category_create', id: category, parent_id: null, name: 'Wyścig ' + category.slice(0, 4) },
  ] });
  const cat = (await ok(`/product-catalogs/${cid}/pim/dictionary`)).categories.find((x: any) => x.id === category);
  await pim(cid, { kind: 'dictionary', changes: [{ kind: 'category_bindings', id: category, version: cat.version, bindings: [{ definition_id: material, required: false }] }] });
  const s = await ok(`/product-catalogs/${cid}/pim/products/${p.id}`);
  await pim(cid, { kind: 'product_values', rows: [{ product_id: p.id, product_version: s.product_version, state_version: s.state_version, source_hash: s.source_hash, category_id: category, values: [] }] });
  const q = await ok('/products/' + p.id + '/ai/attributes', 'POST', { version: (await ok('/products/' + p.id)).version, client_key: randomUUID(), model: 'qa-local:small', locale: 'pl' });
  answer = () => ({ values: [{ definition_id: material, value: 'szkło' }] });
  await drain();
  assert.equal((await ok('/products/' + p.id + '/ai/attributes')).data.find((x: any) => x.id === q.id).state, 'ready');
  const values = async () => (await ok(`/product-catalogs/${cid}/pim/products/${p.id}`)).values;
  const before = await values();
  // Pause the apply right before PIM writes (the preview is stored); cancel while it waits there.
  let reached!: () => void, release!: () => void;
  const atPim = new Promise<void>((r) => (reached = r));
  pause = { reached, released: new Promise<void>((r) => (release = r)) };
  let cancel: any;
  const applying = api('/test/m1/attributes/' + q.id + '/apply', 'POST', { approve: true, definition_ids: [material] });
  try {
    await atPim;
    cancel = await api('/ai/catalog/attributes/' + q.id + '/cancel', 'POST', {});
  } finally {
    release();
    pause = undefined;
  }
  const applied = await applying;
  const final = (await ok('/products/' + p.id + '/ai/attributes')).data.find((x: any) => x.id === q.id);
  const after = await values();
  // The invariant: a cancelled proposal never leaves its values written in PIM, an applied one always has them.
  if (final.state === 'cancelled') assert.deepEqual(after, before, 'cancelled proposal, but PIM values changed (cancel ' + cancel.statusCode + ', apply ' + applied.statusCode + ')');
  assert.equal(cancel.statusCode, 409, 'cancel is refused while the proposal is being applied: ' + cancel.body);
  assert.match(cancel.body, /zatwierdzana/);
  assert.equal(applied.statusCode, 200, applied.body);
  assert.equal(final.state, 'applied');
  assert.deepEqual(after, [{ definition_id: material, kind: 'text', value: 'szkło' }]);
  assert.equal((await api('/ai/catalog/attributes/' + q.id + '/cancel', 'POST', {})).statusCode, 409, 'an applied proposal cannot be cancelled');
});

test('DOM-AI-002 a PIM refusal during apply returns the proposal to review; a retry with the same choice is idempotent', async () => {
  const p = await product('Kubek ponowienie');
  const cid = (await ok('/products/' + p.id)).catalog_id;
  const material = randomUUID(), category = randomUUID();
  await pim(cid, { kind: 'dictionary', changes: [
    { kind: 'definition_create', id: material, name: 'Materiał ' + material.slice(0, 4), shape: { kind: 'text', max_length: 40 } },
    { kind: 'category_create', id: category, parent_id: null, name: 'Ponowienie ' + category.slice(0, 4) },
  ] });
  const cat = (await ok(`/product-catalogs/${cid}/pim/dictionary`)).categories.find((x: any) => x.id === category);
  await pim(cid, { kind: 'dictionary', changes: [{ kind: 'category_bindings', id: category, version: cat.version, bindings: [{ definition_id: material, required: false }] }] });
  const s = await ok(`/product-catalogs/${cid}/pim/products/${p.id}`);
  await pim(cid, { kind: 'product_values', rows: [{ product_id: p.id, product_version: s.product_version, state_version: s.state_version, source_hash: s.source_hash, category_id: category, values: [] }] });
  const q = await ok('/products/' + p.id + '/ai/attributes', 'POST', { version: (await ok('/products/' + p.id)).version, client_key: randomUUID(), model: 'qa-local:small', locale: 'pl' });
  answer = () => ({ values: [{ definition_id: material, value: 'stal' }] });
  await drain();
  // A competing PIM write moves the source: PIM refuses the preview and the proposal is reviewable (and cancellable) again.
  const s2 = await ok(`/product-catalogs/${cid}/pim/products/${p.id}`);
  await pim(cid, { kind: 'product_values', rows: [{ product_id: p.id, product_version: s2.product_version, state_version: s2.state_version, source_hash: s2.source_hash, category_id: category, values: [{ definition_id: material, kind: 'text', value: 'ręcznie' }] }] });
  assert.equal((await api('/ai/catalog/attributes/' + q.id + '/apply', 'POST', { approve: true, definition_ids: [material] })).statusCode, 409);
  const back = (await ok('/products/' + p.id + '/ai/attributes')).data.find((x: any) => x.id === q.id);
  assert.equal(back.state, 'ready');
  assert.equal(back.accepted, null);
  assert.deepEqual((await ok(`/product-catalogs/${cid}/pim/products/${p.id}`)).values, [{ definition_id: material, kind: 'text', value: 'ręcznie' }]);
  assert.equal((await ok('/ai/catalog/attributes/' + q.id + '/cancel', 'POST', {})).cancelled, true);
});
