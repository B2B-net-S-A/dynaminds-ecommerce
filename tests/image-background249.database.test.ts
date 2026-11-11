/** DOM-AI-004 on migration 249 (prepared as placeholder 255; section catalog_ai_image): background removal creates a NEW product image.
 * Queue -> local processor (fake Transport; no real processor is called) -> ready with a new product_images row and
 * lineage; original row and file untouched; products unchanged until an administrator accepts (CAS + audit +
 * version bump); stale version 409; reject keeps everything; processor failures end as failed with a safe message
 * and no image left behind; idempotent client_key; viewer/operator/other tenant denied; a stale lease cannot publish.
 * Database test on a fresh disposable clone dynaminds_m249_YYYYMMDD_NN; the real migrate() applies 218...249
 * (before() asserts the ledger row 249_catalog_ai). */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import type { Transport } from '../server/integrations';

assert.equal(process.env.DYNA_TEST, 'true');
const database = new URL(process.env.DATABASE_URL ?? 'invalid://missing');
assert.equal(database.hostname, '127.0.0.1');
assert.equal(database.port, '57084');
assert.match(database.pathname, /^\/dynaminds_m(?:249|25[0123456789]|26[0123])_2026[0-9]{4}_[0-9]{2}$/, 'fresh clone dynaminds_m249_YYYYMMDD_NN (or m250/m251/m252/m253/m254/m255/m256/m257/m258/m259/m260/m261/m262/m263 after 250/251/252/253/254/255/256/257/258/259/260/261/262) required (the real migrate() applies 249)');
// Image files of this test live in a private temporary directory, set before the server modules load.
const imageDir = mkdtempSync(join(tmpdir(), 'dyna-image-bg-'));
process.env.DYNA_IMAGE_DIR = imageDir;
delete process.env.DYNA_IMAGE_BG_URL;

function chunk(type: string, data: Buffer) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  return Buffer.concat([len, Buffer.from(type, 'ascii'), data, Buffer.alloc(4)]);
}
function png(colorType: number, seed = 0) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(2, 0);
  ihdr.writeUInt32BE(2, 4);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.from([seed, 1, 2, 3, 4]))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

let db: typeof import('../server/db'), bg: typeof import('../server/image-background');
let app: any, warehouse = '';
const cookies: Record<string, string> = {};
let mode: 'ok' | 'throw' | 'status' | 'jpeg' | 'opaque' | 'huge' | 'hang' = 'ok';
let hook: (() => Promise<void>) | undefined;
let calls: { url: string; init: RequestInit }[] = [];
let resultBytes = png(6, 9);
const transport: Transport = async (url, init) => {
  calls.push({ url, init });
  if (hook) await hook();
  if (mode === 'throw') throw new Error('raw private processor diagnostic');
  if (mode === 'hang')
    return new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(new Error('raw timeout detail'))));
  if (mode === 'status') return new Response('raw processor stack trace', { status: 500 });
  const body =
    mode === 'jpeg' ? Buffer.from([255, 216, 255, 224, 0, 0, 255, 217])
    : mode === 'opaque' ? png(2)
    : mode === 'huge' ? Buffer.concat([resultBytes, Buffer.alloc(600000)])
    : resultBytes;
  return new Response(body, { status: 200, headers: { 'Content-Type': mode === 'jpeg' ? 'image/jpeg' : 'image/png' } });
};
const api = (url: string, method: any = 'GET', payload?: any, who = 'admin') =>
  app.inject({ url: '/api' + url, method, payload, headers: { cookie: cookies[who] } });
async function ok(url: string, method: any = 'GET', payload?: any, who = 'admin', status?: number) {
  const r = await api(url, method, payload, who);
  if (status) assert.equal(r.statusCode, status, method + ' ' + url + ' ' + r.body);
  else assert(r.statusCode < 300, method + ' ' + url + ' ' + r.statusCode + ' ' + r.body);
  return r.json();
}
async function product() {
  const img = await ok('/product-images', 'POST', { data: png(2, Math.floor(Math.random() * 200)).toString('base64') }, 'admin', 201);
  const other = await ok('/product-images', 'POST', { data: png(6, 7).toString('base64') }, 'admin', 201);
  const p = await ok('/products', 'POST', { sku: 'BG-' + randomUUID(), name: 'Kubek tło', price: 1000, quantity: 1, warehouse_id: warehouse, images: [other.url, img.url] }, 'admin', 201);
  return { p, img, other };
}
const queue = (p: any, imageId: string, client_key = randomUUID(), version = p.version, who = 'admin') =>
  api('/products/' + p.id + '/ai/images', 'POST', { client_key, image_id: imageId, version }, who);
const row = async (id: string) => (await db.pool.query('SELECT * FROM catalog_ai_image_jobs WHERE id=$1', [id])).rows[0];
const productRow = async (id: string) => (await db.pool.query('SELECT version,images FROM products WHERE id=$1', [id])).rows[0];
const imageCount = async () => (await db.pool.query('SELECT count(*)::int n FROM product_images')).rows[0].n;

before(async () => {
  db = await import('../server/db');
  db.pool.options.options = String(db.pool.options.options).replace('statement_timeout=8000', 'statement_timeout=60000');
  const { seed } = await import('./fixtures');
  const { buildApp } = await import('../server/app');
  bg = await import('../server/image-background');
  await db.migrate();
  assert.equal((await db.pool.query("SELECT count(*)::int n FROM migrations WHERE name='249_catalog_ai'")).rows[0].n, 1, 'migrate() applied 249');
  await seed();
  app = await buildApp({ integrationTransport: transport });
  // buildApp registers the DOM-AI-004 routes itself once 249 is installed (registerCatalogAiRoutes, extensions.images).
  assert.equal(await bg.imageBackgroundAvailable(), true);
  for (const who of ['admin', 'viewer', 'operator', 'other']) {
    const r = await app.inject({ url: '/api/auth/login', method: 'POST', payload: { email: who + '@demo.local', password: 'DynaDemo!2026' } });
    assert.equal(r.statusCode, 200, r.body);
    cookies[who] = String(r.headers['set-cookie']).split(';')[0];
  }
  warehouse = (await ok('/warehouses')).data[0].id;
});
after(async () => {
  await app?.close();
  await db?.pool.end();
});

test('queue -> processor -> ready: a new image with lineage; original and product unchanged; idempotent key', async () => {
  const { p, img } = await product();
  const original = readFileSync(join(imageDir, img.id));
  const originalRow = (await db.pool.query('SELECT * FROM product_images WHERE id=$1', [img.id])).rows[0];
  const key = randomUUID();
  const first = await queue(p, img.id, key);
  assert.equal(first.statusCode, 201, first.body);
  const job = first.json().job;
  assert.equal(job.state, 'queued');
  const again = await queue(p, img.id, key);
  assert.equal(again.statusCode, 200, again.body);
  assert.equal(again.json().job.id, job.id);
  assert.equal(again.json().replayed, true);
  assert.equal((await queue(p, p.images[0].split('/').at(-1), key)).statusCode, 409, 'same key, other body');
  assert.equal((await queue(p, img.id)).statusCode, 409, 'one open request per image');
  assert.equal((await queue(p, randomUUID())).statusCode, 422, 'image not in the product');
  assert.equal((await queue(p, img.id, randomUUID(), p.version + 5)).statusCode, 409, 'stale version');
  calls = [];
  mode = 'ok';
  assert.equal(await bg.tickImageBackground(transport), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:11436/api/remove');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.redirect, 'error');
  const form = calls[0].init.body as FormData;
  assert.deepEqual([...form.keys()], ['file'], 'only the image bytes are sent');
  assert.deepEqual(Buffer.from(await (form.get('file') as Blob).arrayBuffer()), original);
  const ready = await row(job.id);
  assert.equal(ready.state, 'ready');
  assert.equal(ready.operation, 'background_removed');
  assert.equal(ready.source_image_id, img.id);
  assert(ready.result_image_id && ready.result_image_id !== img.id);
  const result = (await db.pool.query('SELECT * FROM product_images WHERE id=$1', [ready.result_image_id])).rows[0];
  assert.equal(result.mime, 'image/png');
  assert.equal(result.size, resultBytes.length);
  assert.deepEqual(readFileSync(join(imageDir, ready.result_image_id)), resultBytes);
  assert.deepEqual(readFileSync(join(imageDir, img.id)), original, 'original file untouched');
  assert.deepEqual((await db.pool.query('SELECT * FROM product_images WHERE id=$1', [img.id])).rows[0], originalRow);
  assert.deepEqual(await productRow(p.id), { version: p.version, images: p.images }, 'product unchanged until accept');
  const list = await ok('/products/' + p.id + '/ai/images');
  assert.equal(list.available, true);
  assert.deepEqual(list.images.map((x: any) => x.id), p.images.map((u: string) => u.split('/').at(-1)));
  assert.equal(list.data[0].id, job.id);
  assert.equal(list.data[0].result_url, '/api/product-images/' + ready.result_image_id);
  const bytes = await api('/product-images/' + ready.result_image_id);
  assert.equal(bytes.statusCode, 200);
  assert.equal(bytes.headers['content-type'], 'image/png');
  // Accept: stale version refuses and changes nothing; current version swaps the URL in place.
  assert.equal((await api('/ai/catalog/images/' + job.id + '/apply', 'POST', { approve: true, version: p.version + 7 })).statusCode, 409, 'stale version');
  assert.equal((await api('/ai/catalog/images/' + job.id + '/apply', 'POST', { version: p.version })).statusCode, 422, 'approve required');
  assert.deepEqual(await productRow(p.id), { version: p.version, images: p.images });
  assert.equal((await row(job.id)).state, 'ready');
  const applied = await ok('/ai/catalog/images/' + job.id + '/apply', 'POST', { approve: true, version: p.version });
  assert.equal(applied.reused, false);
  const after = await productRow(p.id);
  assert.equal(after.version, p.version + 1);
  assert.deepEqual(after.images, [p.images[0], '/api/product-images/' + ready.result_image_id]);
  assert.equal((await row(job.id)).state, 'applied');
  assert.equal((await row(job.id)).applied_version, p.version + 1);
  assert.equal((await db.pool.query('SELECT count(*)::int n FROM product_images WHERE id=$1', [img.id])).rows[0].n, 1, 'original row kept');
  const audits = (await db.pool.query("SELECT action FROM audit_events WHERE entity_id=$1 ORDER BY created_at", [job.id])).rows.map((r: any) => r.action);
  assert.deepEqual(audits, ['catalog.ai.image.queue', 'catalog.ai.image.ready', 'catalog.ai.image.apply']);
  const replay = await ok('/ai/catalog/images/' + job.id + '/apply', 'POST', { approve: true, version: p.version });
  assert.equal(replay.reused, true);
  assert.equal((await productRow(p.id)).version, p.version + 1, 'replay changes nothing');
});

test('reject keeps the product and both images; a rejected result cannot be applied', async () => {
  const { p, img } = await product();
  const job = (await queue(p, img.id)).json().job;
  mode = 'ok';
  await bg.tickImageBackground(transport);
  const ready = await row(job.id);
  assert.equal(ready.state, 'ready');
  const r = await ok('/ai/catalog/images/' + job.id + '/reject', 'POST', {});
  assert.equal(r.job.state, 'rejected');
  assert.equal((await ok('/ai/catalog/images/' + job.id + '/reject', 'POST', {})).job.state, 'rejected', 'repeat is idempotent');
  assert.equal((await api('/ai/catalog/images/' + job.id + '/apply', 'POST', { approve: true, version: p.version })).statusCode, 409);
  assert.deepEqual(await productRow(p.id), { version: p.version, images: p.images });
  assert.equal((await db.pool.query('SELECT count(*)::int n FROM product_images WHERE id=ANY($1::uuid[])', [[img.id, ready.result_image_id]])).rows[0].n, 2);
  // A queued request is cancelled by the same action.
  const q = (await queue(p, img.id)).json().job;
  assert.equal((await ok('/ai/catalog/images/' + q.id + '/reject', 'POST', {})).job.state, 'cancelled');
  assert.equal(await bg.tickImageBackground(transport), false, 'cancelled is not processed');
});

test('processor failure, non-PNG, opaque PNG, oversized answer and timeout end as failed; no image left behind', async () => {
  const { p, img } = await product();
  const cases: [typeof mode, RegExp][] = [
    ['throw', /niedostępny lub przekroczył czas/],
    ['status', /odrzucił/],
    ['jpeg', /PNG/],
    ['opaque', /przezroczyst/],
    ['huge', /512 KiB/],
    ['hang', /niedostępny lub przekroczył czas/],
  ];
  for (const [m, message] of cases) {
    const job = (await queue(p, img.id)).json().job;
    const images = await imageCount(), files = readdirSync(imageDir).length;
    mode = m;
    assert.equal(await bg.tickImageBackground(transport, 100), true, m);
    const r = await row(job.id);
    assert.equal(r.state, 'failed', m);
    assert.match(r.error, message, m);
    assert.doesNotMatch(r.error, /raw/, m);
    assert.equal(r.result_image_id, null);
    assert.equal(await imageCount(), images, m + ': no image row');
    assert.equal(readdirSync(imageDir).length, files, m + ': no file');
  }
  mode = 'ok';
  assert.deepEqual(await productRow(p.id), { version: p.version, images: p.images });
});

test('a stale lease cannot publish; an expired running lease is failed by the next tick', async () => {
  const { p, img } = await product();
  const job = (await queue(p, img.id)).json().job;
  const images = await imageCount(), files = readdirSync(imageDir).length;
  mode = 'ok';
  // While the processor works, the lease is reaped (as the stale-lease sweep does) and the job is failed.
  hook = async () => {
    await db.pool.query("UPDATE catalog_ai_image_jobs SET state='failed',error='Dzierżawa usuwania tła wygasła; zleć ponownie',lease_token=NULL,locked_at=NULL,finished_at=now() WHERE id=$1", [job.id]);
  };
  try {
    assert.equal(await bg.tickImageBackground(transport), true);
  } finally {
    hook = undefined;
  }
  const r = await row(job.id);
  assert.equal(r.state, 'failed');
  assert.equal(r.result_image_id, null);
  assert.equal(await imageCount(), images, 'no image row published');
  assert.equal(readdirSync(imageDir).length, files, 'result file removed');
  const stale = (await queue(p, img.id)).json().job;
  await db.pool.query("UPDATE catalog_ai_image_jobs SET state='running',attempts=1,lease_token=$2,locked_at=now()-interval '10 minutes' WHERE id=$1", [stale.id, randomUUID()]);
  assert.equal(await bg.tickImageBackground(transport), false);
  const s = await row(stale.id);
  assert.equal(s.state, 'failed');
  assert.match(s.error, /Dzierżawa/);
});

test('viewer and operator are refused; another tenant sees nothing of this tenant', async () => {
  const { p, img } = await product();
  for (const who of ['viewer', 'operator']) {
    assert.equal((await api('/products/' + p.id + '/ai/images', 'GET', undefined, who)).statusCode, 403, who);
    assert.equal((await queue(p, img.id, randomUUID(), p.version, who)).statusCode, 403, who);
  }
  const job = (await queue(p, img.id)).json().job;
  assert.equal((await api('/products/' + p.id + '/ai/images', 'GET', undefined, 'other')).statusCode, 404);
  assert.equal((await queue(p, img.id, randomUUID(), p.version, 'other')).statusCode, 404);
  assert.equal((await api('/ai/catalog/images/' + job.id + '/reject', 'POST', {}, 'other')).statusCode, 404);
  assert.equal((await api('/ai/catalog/images/' + job.id + '/apply', 'POST', { approve: true, version: p.version }, 'other')).statusCode, 404);
  for (const who of ['viewer', 'operator'])
    assert.equal((await api('/ai/catalog/images/' + job.id + '/reject', 'POST', {}, who)).statusCode, 403, who);
  assert.equal((await row(job.id)).state, 'queued');
  await ok('/ai/catalog/images/' + job.id + '/reject', 'POST', {});
});
