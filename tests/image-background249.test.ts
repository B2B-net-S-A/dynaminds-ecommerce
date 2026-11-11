/** DOM-AI-004 (migration 249, prepared as placeholder 255; section catalog_ai_image): pure checks without a database. Loopback-only
 * processor address, PNG-with-transparency validation of the processor's answer, safe failure messages, and the
 * shape of the SQL section (own `catalog_ai_image_*` objects only, no ALTER or foreign key to a core table, RLS). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import {
  imageBackgroundBase,
  transparentPng,
  safeImageError,
  IMAGE_BACKGROUND_FAILED,
} from '../server/image-background';
import { Problem } from '../server/errors';

function chunk(type: string, data: Buffer) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  return Buffer.concat([len, Buffer.from(type, 'ascii'), data, Buffer.alloc(4)]);
}
function png(colorType = 6, extra: Buffer[] = [], size: { width?: number; height?: number; depth?: number; idat?: Buffer } = {}) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size.width ?? 2, 0);
  ihdr.writeUInt32BE(size.height ?? 2, 4);
  ihdr[8] = size.depth ?? 8;
  ihdr[9] = colorType;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    ...extra,
    chunk('IDAT', size.idat ?? deflateSync(Buffer.alloc(20))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

test('processor address: numeric loopback http origin only, default port 11436', () => {
  assert.equal(imageBackgroundBase(undefined), 'http://127.0.0.1:11436');
  assert.equal(imageBackgroundBase('http://127.0.0.1:7000'), 'http://127.0.0.1:7000');
  assert.equal(imageBackgroundBase('http://[::1]:7000/'), 'http://[::1]:7000');
  for (const bad of [
    'http://localhost:7000',
    'https://127.0.0.1:7000',
    'http://10.0.0.5:7000',
    'http://user:pw@127.0.0.1:7000',
    'http://127.0.0.1:7000/api',
    'http://127.0.0.1:7000/?x=1',
    'http://example.com',
  ])
    assert.throws(() => imageBackgroundBase(bad), (e: any) => e instanceof Problem && e.status === 422, bad);
});

test('result validation: PNG with alpha or tRNS, complete chunk list, no other formats', () => {
  assert.equal(transparentPng(png(6)).width, 2);
  assert.equal(transparentPng(png(4)).height, 2);
  assert.ok(transparentPng(png(3, [chunk('PLTE', Buffer.alloc(3)), chunk('tRNS', Buffer.from([0]))])));
  const refuse = (b: Buffer, message: RegExp) =>
    assert.throws(() => transparentPng(b), (e: any) => e instanceof Problem && e.status === 502 && message.test(e.message));
  refuse(Buffer.from([255, 216, 255, 0, 255, 217]), /PNG/);
  refuse(Buffer.from('RIFF0000WEBPVP8 '), /PNG/);
  refuse(png(2), /przezroczyst/);
  refuse(png(6).subarray(0, 40), /PNG/);
  refuse(Buffer.alloc(0), /PNG/);
  const huge = png(6);
  huge.writeUInt32BE(20000, 16);
  refuse(huge, /PNG/);
});

test('decompression bomb (M2): pixel count and the uncompressed size from IHDR are capped before the result is stored', () => {
  const refuse = (b: Buffer) =>
    assert.throws(() => transparentPng(b), (e: any) => e instanceof Problem && e.status === 502 && /zbyt duży/.test(e.message));
  // 9000 x 9000 RGBA (81 MP, ~324 MB raw) in a few KiB: a small, highly compressible large-dimension PNG.
  const bomb = png(6, [], { width: 9000, height: 9000, idat: deflateSync(Buffer.alloc(8 * 1024 * 1024)) });
  assert(bomb.length < 64 * 1024, 'the bomb itself is small: ' + bomb.length);
  refuse(bomb);
  refuse(png(6, [], { width: 10000, height: 2600 })); // 26 MP: inside the 10000 px side limit, over 25 MP
  // 25 MP exactly at 16 bits per RGBA channel is ~200 MB raw: within the pixel limit, over the raw-size limit.
  refuse(png(6, [], { width: 5000, height: 5000, depth: 16 }));
  // Inside both limits: 5000 x 5000 RGBA at 8 bits (100 MB raw) and a 10000 x 2500 palette image with tRNS.
  assert.deepEqual(transparentPng(png(6, [], { width: 5000, height: 5000 })), { width: 5000, height: 5000 });
  assert.ok(transparentPng(png(3, [chunk('PLTE', Buffer.alloc(3)), chunk('tRNS', Buffer.from([0]))], { width: 10000, height: 2500 })));
  // A bit depth the colour type does not allow is not a PNG.
  assert.throws(() => transparentPng(png(6, [], { depth: 4 })), (e: any) => e instanceof Problem && e.status === 502 && /PNG/.test(e.message));
});

test('failure messages never carry raw processor or runtime text', () => {
  assert.equal(safeImageError(new Error('ECONNREFUSED raw provider body <html>')), IMAGE_BACKGROUND_FAILED);
  assert.equal(safeImageError('x'), IMAGE_BACKGROUND_FAILED);
  assert.equal(safeImageError(new Problem(502, 'Procesor tła nie zwrócił obrazu PNG')), 'Procesor tła nie zwrócił obrazu PNG');
});

function section() {
  const file = 'server/249_catalog_ai.sql';
  const text = readFileSync(file, 'utf8');
  const m = text.match(/-- BEGIN catalog_ai_image[^\n]*\n([\s\S]*?)-- END catalog_ai_image/);
  assert(m, 'section catalog_ai_image in ' + file);
  return m[1].replace(/--[^\n]*/g, '');
}

test('SQL section creates only own catalog_ai_image_* objects with forced RLS and no DELETE', () => {
  const sql = section();
  const created = [...sql.matchAll(/CREATE\s+(?:UNIQUE\s+)?(TABLE|INDEX|FUNCTION|TRIGGER|POLICY)\s+([a-z_0-9]+)/gi)];
  assert(created.length >= 5);
  for (const [, kind, name] of created)
    if (kind.toUpperCase() !== 'POLICY') assert.match(name, /^catalog_ai_image_[a-z_]+$/, kind + ' ' + name);
    else assert.equal(name, 'tenant_scope');
  for (const [, , name] of created) assert.doesNotMatch(name, /[0-9]/, 'no number in names');
  assert.doesNotMatch(sql, /\bREFERENCES\b/i, 'no foreign key to a core table');
  assert.doesNotMatch(sql, /\bDELETE\b|\bTRUNCATE\b|\bDROP\b/i);
  const alters = [...sql.matchAll(/ALTER\s+TABLE\s+([a-z_0-9]+)/gi)].map((x) => x[1]);
  assert.deepEqual([...new Set(alters)], ['catalog_ai_image_jobs'], 'only own tables are altered (RLS switches)');
  const ons = [...sql.matchAll(/\bON\s+(?:TABLE\s+)?([a-z_0-9]+)/gi)].map((x) => x[1]);
  for (const t of ons) assert.match(t, /^catalog_ai_image_/, 'ON ' + t);
  assert.match(sql, /ALTER TABLE catalog_ai_image_jobs ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /ALTER TABLE catalog_ai_image_jobs FORCE ROW LEVEL SECURITY/);
  assert.match(
    sql,
    /CREATE POLICY tenant_scope ON catalog_ai_image_jobs TO dyna_app USING \(tenant_id=nullif\(current_setting\('app\.tenant_id',true\),''\)::uuid\) WITH CHECK \(tenant_id=nullif\(current_setting\('app\.tenant_id',true\),''\)::uuid\)/,
  );
  assert.match(sql, /GRANT SELECT,INSERT,UPDATE ON TABLE catalog_ai_image_jobs TO dyna_app/);
  for (const sealed of ['warehouse_wz_issuer', 'catalog_stock_', 'local_invoice_', 'pim_dictionary_', 'large_import_'])
    assert(!sql.includes(sealed), sealed);
});

test('routes: missing table answers available:false and 503 for writes; a restored copy refuses writes with 423', async () => {
  const Fastify = (await import('fastify')).default;
  const { registerImageBackgroundRoutes } = await import('../server/image-background-routes');
  const make = async (options: { available: boolean; readOnly: boolean }) => {
    const app = Fastify();
    app.addHook('onRequest', async (req: any) => {
      req.actor = { tenantId: '00000000-0000-4000-8000-000000000001', userId: '00000000-0000-4000-8000-000000000002', role: 'admin' };
    });
    app.setErrorHandler((e: any, _req, reply) => reply.code(e.status ?? 500).send({ detail: e.message }));
    registerImageBackgroundRoutes(app, options);
    await app.ready();
    return app;
  };
  const id = '00000000-0000-4000-8000-000000000003';
  const writes = [`/api/products/${id}/ai/images`, `/api/ai/catalog/images/${id}/apply`, `/api/ai/catalog/images/${id}/reject`];
  const missing = await make({ available: false, readOnly: false });
  const get = await missing.inject({ url: `/api/products/${id}/ai/images` });
  assert.equal(get.statusCode, 200);
  assert.equal(get.json().available, false);
  for (const url of writes) assert.equal((await missing.inject({ url, method: 'POST', payload: {} })).statusCode, 503, url);
  await missing.close();
  const copy = await make({ available: true, readOnly: true });
  for (const url of writes) {
    const r = await copy.inject({ url, method: 'POST', payload: {} });
    assert.equal(r.statusCode, 423, url);
    assert.match(r.json().detail, /tylko do odczytu/);
  }
  await copy.close();
});
