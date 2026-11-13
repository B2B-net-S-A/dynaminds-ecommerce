import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../server/app';
import { migrate, pool } from '../server/db';
import { seed } from './fixtures';
import { withoutApiKeyLastUse } from './api-key-last-use';
import { returnAssistantFixture } from './return-assistant-fixture';

// Metadata compatibility mutations below are confined to the disposable native test DB.
assert.equal(process.env.DYNA_TEST, 'true');
const database = new URL(process.env.DATABASE_URL ?? '');
assert(['localhost', '127.0.0.1', '[::1]'].includes(database.hostname));
assert.match(database.pathname, /^\/dynaminds_test_\d+$/);
type Row = Record<string, any>;
type Fixture = Awaited<ReturnType<typeof returnAssistantFixture>>;
let app: Awaited<ReturnType<typeof buildApp>>;
const transport = async (): Promise<never> => { throw Error('Assistant HTTP contracts cannot call providers'); };
before(async () => { await migrate(); await seed(); app = await buildApp({ integrationTransport: transport }); });
after(async () => { try { await app?.close(); } finally { await pool.end(); } });

async function facts(tenant: string) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await c.query("SET LOCAL TimeZone='UTC'");
    const names = (await c.query("SELECT table_name FROM information_schema.tables t WHERE table_schema='public' AND table_type='BASE TABLE' AND table_name<>'sessions' AND EXISTS(SELECT 1 FROM information_schema.columns k WHERE k.table_schema=t.table_schema AND k.table_name=t.table_name AND k.column_name='tenant_id') ORDER BY 1")).rows;
    const result: Row = {};
    for (const { table_name } of names) {
      assert.match(table_name, /^[a-z][a-z0-9_]*$/);
      result[table_name] = (await c.query(`SELECT to_jsonb(x) row FROM "${table_name}" x WHERE tenant_id=$1 ORDER BY 1`, [tenant])).rows;
    }
    await c.query('COMMIT'); return withoutApiKeyLastUse(result);
  } finally { await c.query('ROLLBACK').catch(() => undefined); c.release(); }
}
function noStore(r: { headers: Row }) { assert.match(String(r.headers['cache-control']), /no-store/); }
function png(width = 1, height = 1) {
  const chunk = (name: string, bytes: Buffer) => {
    const kind = Buffer.from(name), size = Buffer.alloc(4), crc = Buffer.alloc(4);
    size.writeUInt32BE(bytes.length); crc.writeUInt32BE(crc32(Buffer.concat([kind, bytes])));
    return Buffer.concat([size, kind, bytes, crc]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const stride = 1 + width * 3, pixels = Buffer.alloc(stride * height, 127);
  for (let row = 0; row < height; row++) pixels[row * stride] = 0;
  // Level zero exercises the HTTP base64 size boundary using an actual valid PNG.
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels, { level: 0 })), chunk('IEND', Buffer.alloc(0))]);
}
async function key(f: Fixture) { return f.ok('/developer/keys', 'POST', { name: 'Own assistant HTTP contracts', scopes: ['orders:read', 'orders:write'] }, 201); }
async function start(f: Fixture, token?: string) {
  const lease = randomUUID();
  const body = { client_key: randomUUID(), return_number: f.rma.number, station_id: f.station.id, station_version: String(f.station.version), lease_token: lease };
  const r = token ? await app.inject({ method: 'POST', url: '/api/v1/return-assistant/sessions', headers: { authorization: 'Bearer ' + token }, payload: body, remoteAddress: '127.154.2.1' }) : await f.request('/return-assistant/sessions', 'POST', body);
  assert.equal(r.statusCode, 201, r.body); return { lease, session: r.json().session };
}

// Do not substitute config.available=false for actual old-schema availability discovery.
test('wholly absent assistant schema is neutral on options and refuses malformed writes before parsing', async () => {
  const f = await returnAssistantFixture(app), beforeRows = await facts(f.tenant);
  const tables = ['return_assistant_sessions', 'return_assistant_operations', 'return_assistant_photos', 'return_assistant_previews', 'return_assistant_receipts', 'return_assistant_admissions'];
  const functions = (await pool.query("SELECT p.oid,p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname LIKE 'return_assistant_%' ORDER BY p.oid")).rows;
  assert(functions.length > 20);
  const marker = (await pool.query("SELECT name,applied_at::text AS applied_at FROM migrations WHERE name='139_return_assistant'")).rows[0]; assert(marker);
  const c = await pool.connect(); let hidden = false;
  try {
    await c.query('BEGIN');
    for (const fn of functions) {
      assert.match(fn.proname, /^return_assistant_[a-z_]+$/);
      const signature = (await c.query('SELECT $1::oid::regprocedure::text signature', [fn.oid])).rows[0].signature;
      await c.query(`ALTER FUNCTION ${signature} RENAME TO qa154_hidden_${fn.oid}`);
    }
    for (const table of tables) await c.query(`ALTER TABLE ${table} RENAME TO qa154_hidden_${table}`);
    await c.query("DELETE FROM migrations WHERE name='139_return_assistant'"); await c.query('COMMIT'); hidden = true;
    for (const prefix of ['/api', '/api/v1']) {
      const r = await app.inject({ url: prefix + '/return-assistant/options', headers: { cookie: f.cookie }, remoteAddress: '127.154.2.2' });
      assert.equal(r.statusCode, 200, r.body); noStore(r); const dto = r.json();
      assert.equal(dto.available, false); assert.equal(dto.can_write, false); assert.deepEqual(dto.stations, []);
      const head = await app.inject({ method: 'HEAD', url: prefix + '/return-assistant/options', headers: { cookie: f.cookie }, remoteAddress: '127.154.2.2' });
      assert.equal(head.statusCode, 200, head.body); assert.equal(head.body, ''); noStore(head);
      for (const path of ['/sessions', '/sessions/' + randomUUID() + '/photos', '/previews/' + randomUUID() + '/receive']) {
        const denied = await app.inject({ method: 'POST', url: prefix + '/return-assistant' + path, headers: { cookie: f.cookie, 'content-type': 'application/json' }, payload: '{', remoteAddress: '127.154.2.2' });
        assert.equal(denied.statusCode, 503, denied.body); noStore(denied);
      }
    }
  } finally {
    await c.query('ROLLBACK');
    if (hidden) {
      await c.query('BEGIN');
      for (const table of tables) await c.query(`ALTER TABLE qa154_hidden_${table} RENAME TO ${table}`);
      for (const fn of functions) {
        const signature = (await c.query('SELECT $1::oid::regprocedure::text signature', [fn.oid])).rows[0].signature;
        await c.query(`ALTER FUNCTION ${signature} RENAME TO ${fn.proname}`);
      }
      await c.query('INSERT INTO migrations(name,applied_at) VALUES($1,$2)', [marker.name, marker.applied_at]); await c.query('COMMIT');
    }
    c.release();
  }
  assert.deepEqual(await facts(f.tenant), beforeRows);
});

test('a missing assistant table or disabled physical witness fails closed on fresh HTTP probes', async () => {
  const f = await returnAssistantFixture(app), beforeRows = await facts(f.tenant);
  for (const kind of ['table', 'trigger']) {
    try {
      if (kind === 'table') await pool.query('ALTER TABLE return_assistant_photos RENAME TO qa154_torn_photos');
      else await pool.query('ALTER TABLE stock_movements DISABLE TRIGGER return_assistant_witness');
      for (const prefix of ['/api', '/api/v1']) {
        const r = await app.inject({ url: prefix + '/return-assistant/options', headers: { cookie: f.cookie }, remoteAddress: '127.154.2.3' });
        assert.equal(r.statusCode, 503, r.body); noStore(r);
        const denied = await app.inject({ method: 'POST', url: prefix + '/return-assistant/sessions', headers: { cookie: f.cookie, 'content-type': 'application/json' }, payload: '{', remoteAddress: '127.154.2.3' });
        assert.equal(denied.statusCode, 503, denied.body); noStore(denied);
      }
    } finally {
      if (kind === 'table') await pool.query('ALTER TABLE qa154_torn_photos RENAME TO return_assistant_photos');
      else await pool.query('ALTER TABLE stock_movements ENABLE TRIGGER return_assistant_witness');
    }
  }
  assert.deepEqual(await facts(f.tenant), beforeRows);
});

async function readonlyCookie(readonly: FastifyInstance, f: Fixture) {
  const login = await readonly.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'admin@demo.local', password: 'DynaDemo!2026' }, remoteAddress: '127.154.2.4' });
  assert.equal(login.statusCode, 200);
  const switched = await readonly.inject({ method: 'POST', url: '/api/workspaces/switch', payload: { tenant_id: f.tenant }, headers: { cookie: String(login.headers['set-cookie']).split(';')[0] }, remoteAddress: '127.154.2.4' });
  assert.equal(switched.statusCode, 200); return String(switched.headers['set-cookie']).split(';')[0];
}
test('restore blocks malformed normal and v1 writes before parsing while photo custody and nested read-only flags remain readable', async () => {
  const f = await returnAssistantFixture(app); let { session, lease } = await start(f);
  const bytes = png(), photoBody = { client_key: randomUUID(), version: String(session.version), lease_token: lease, item_id: f.rma.items[0].item_id, mime: 'image/png', content_base64: bytes.toString('base64') };
  const saved = await f.ok('/return-assistant/sessions/' + session.id + '/photos', 'POST', photoBody, 201); session = saved.session; const photoId = saved.photo.id;
  session = (await f.ok('/return-assistant/sessions/' + session.id + '/scans', 'POST', { client_key: randomUUID(), version: String(session.version), lease_token: lease, code: f.product.sku, item_id: f.rma.items[0].item_id })).session;
  session = (await f.ok('/return-assistant/sessions/' + session.id + '/draft', 'PATCH', { client_key: randomUUID(), version: String(session.version), lease_token: lease, note: 'Read-only original approval remains frozen', shipping_refund: 0, parts: [{ part_id: randomUUID(), item_id: f.rma.items[0].item_id, status: 'sale', quantity: 1 }] })).session;
  const preview = (await f.ok('/return-assistant/sessions/' + session.id + '/previews', 'POST', { client_key: randomUUID(), version: String(session.version), lease_token: lease }, 201)).preview;
  const readonly = await buildApp({ readOnly: true, previewPort: 4194, integrationTransport: transport });
  try {
    const cookie = await readonlyCookie(readonly, f), beforeRows = await facts(f.tenant);
    for (const prefix of ['/api', '/api/v1']) {
      for (const path of ['/sessions', '/sessions/' + session.id + '/photos', '/previews/' + preview.id + '/receive']) {
        const r = await readonly.inject({ method: 'POST', url: prefix + '/return-assistant' + path, headers: { cookie, 'content-type': 'application/json' }, payload: '{', remoteAddress: '127.154.2.4' });
        assert.equal(r.statusCode, 423, r.body);
      }
      for (const path of ['/sessions/' + session.id, '/previews/' + preview.id]) {
        const r = await readonly.inject({ url: prefix + '/return-assistant' + path, headers: { cookie }, remoteAddress: '127.154.2.4' });
        assert.equal(r.statusCode, 200, r.body); noStore(r); const dto = r.json();
        assert.equal(dto.read_only, true); assert.equal(dto.can_write, false);
        if (dto.session) { assert.equal(dto.session.can_control, false); assert.equal(dto.session.can_takeover, false); assert.equal(dto.session.can_receive_locally, false); }
        if (dto.preview) assert.equal(dto.preview.can_receive, false);
      }
      const r = await readonly.inject({ url: prefix + '/return-assistant/photos/' + photoId + '/content', headers: { cookie }, remoteAddress: '127.154.2.4' });
      assert.equal(r.statusCode, 200, r.body); noStore(r); const dto = r.json();
      assert.equal(dto.content_base64, bytes.toString('base64')); assert.equal(dto.sha256, createHash('sha256').update(bytes).digest('hex')); assert.equal(dto.read_only, true); assert.equal(dto.can_write, false);
      const head = await readonly.inject({ method: 'HEAD', url: prefix + '/return-assistant/photos/' + photoId + '/content', headers: { cookie }, remoteAddress: '127.154.2.4' });
      assert.equal(head.statusCode, 200, head.body); assert.equal(head.body, ''); noStore(head);
    }
    assert.deepEqual(await facts(f.tenant), beforeRows);
  } finally { await readonly.close(); }
});

test('actual v1 accepts a canonical photo above the former 768KiB boundary, replays exactly and rejects invalid/oversize photos without effects', async () => {
  const f = await returnAssistantFixture(app), writer = await key(f); let { session, lease } = await start(f, writer.token);
  const bytes = png(900, 300); assert(bytes.length > 768 * 1024 && bytes.length <= 1048576);
  const url = '/api/v1/return-assistant/sessions/' + session.id + '/photos';
  const headers = { authorization: 'Bearer ' + writer.token };
  const body = { client_key: randomUUID(), version: String(session.version), lease_token: lease, item_id: f.rma.items[0].item_id, mime: 'image/png', content_base64: bytes.toString('base64') };
  const first = await app.inject({ method: 'POST', url, headers, payload: body, remoteAddress: '127.154.2.5' });
  assert.equal(first.statusCode, 201, first.body); noStore(first); const dto = first.json(); session = dto.session;
  assert.equal(dto.photo.byte_count, bytes.length); assert.equal(dto.photo.sha256, createHash('sha256').update(bytes).digest('hex'));
  const afterRows = await facts(f.tenant);
  const replay = await app.inject({ method: 'POST', url, headers, payload: body, remoteAddress: '127.154.2.5' });
  assert.equal(replay.statusCode, 200, replay.body); assert.equal(replay.json().reused, true); assert.deepEqual(replay.json().photo, dto.photo); assert.deepEqual(await facts(f.tenant), afterRows);
  const read = await app.inject({ url: '/api/v1/return-assistant/photos/' + dto.photo.id + '/content', headers, remoteAddress: '127.154.2.5' });
  assert.equal(read.statusCode, 200, read.body); assert.equal(read.json().content_base64, bytes.toString('base64'));
  const over = png(1200, 300); assert(over.length > 1048576); assert(over.toString('base64').length < 1500000);
  for (const [content, status] of [[Buffer.concat([bytes, Buffer.from([0])]).toString('base64'), 422], [over.toString('base64'), 422], ['A'.repeat(1600000), 413]] as const) {
    const r = await app.inject({ method: 'POST', url, headers, payload: { ...body, client_key: randomUUID(), version: String(session.version), content_base64: content }, remoteAddress: '127.154.2.5' });
    assert.equal(r.statusCode, status, r.body); assert.deepEqual(await facts(f.tenant), afterRows);
  }
  const reader = await f.ok('/developer/keys', 'POST', { name: 'Own photo read-only custody', scopes: ['orders:read'] }, 201);
  const beforeRead = await facts(f.tenant), readerHeaders = { authorization: 'Bearer ' + reader.token };
  const readable = await app.inject({ url: '/api/v1/return-assistant/photos/' + dto.photo.id + '/content', headers: readerHeaders, remoteAddress: '127.154.2.5' });
  assert.equal(readable.statusCode, 200, readable.body); assert.equal(readable.json().content_base64, body.content_base64); assert.equal(readable.json().can_write, false);
  const denied = await app.inject({ method: 'POST', url, headers: readerHeaders, payload: { ...body, client_key: randomUUID(), version: String(session.version) }, remoteAddress: '127.154.2.5' });
  assert.equal(denied.statusCode, 403, denied.body); assert.deepEqual(await facts(f.tenant), beforeRead);
});
