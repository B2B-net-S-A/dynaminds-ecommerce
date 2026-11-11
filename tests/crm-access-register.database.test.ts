/** SEC-013 (stage 3 review M2) on a real disposable clone: a CRM list read writes ONE 228
 * access-register row per request, whose detail names every listed CRM client, so a reader
 * cannot flood the append-only register; the row still reaches the customer's export and
 * the register filters by CRM id and e-mail. Same for connector.php getCrmClients.
 * Root-only on a fresh clone dynaminds_s2_20261026_NN migrated by real migrate(). The suite
 * writes; rerun = NEW clone. */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../server/db';
import { Problem } from '../server/errors';
import { tokenHash } from '../server/security';
import { authenticateBaseWireApiKey } from '../server/developer-api';
import { registerCrmRoutes } from '../server/crm-routes';
import { registerBaseWireCrmRoutes } from '../server/base-wire-crm-routes';
import { observeBaseWireReads } from '../server/base-wire-routes';
import { createDefaultBaseWireCrmService } from '../server/base-wire-crm-runtime';
import { registerRodo228Routes } from '../server/rodo228-routes';
import { rodo228Available } from '../server/rodo228';
import { rodo228CrmAccess, rodo228WireObserver } from '../server/rodo228-hooks';

assert.equal(process.env.DYNA_TEST, 'true', 'Explicit isolated test mode required');
const selected = new URL(process.env.DATABASE_URL ?? 'invalid://missing');
assert.equal(selected.hostname, '127.0.0.1');
assert.equal(selected.port, '57084');
assert.match(selected.pathname, /^\/dynaminds_s2_20261026_[0-9]{2}$/);
assert.equal(selected.username, 'postgres');
pool.options.query_timeout = 20000;

const KEY = 's2-register-test-key-' + randomBytes(8).toString('hex');
const A = '11111111-1111-4111-8111-111111111111';
const N = 100;
let app: FastifyInstance, admin: string, wireToken: string, clients: { id: string; email: string }[] = [];

const call = (method: 'GET' | 'POST', url: string, as: Record<string, unknown> = {}) =>
  app.inject({ method, url, headers: { 'x-test-as': JSON.stringify(as) } });
const ok = (r: any) => { assert.equal(r.statusCode, 200, r.body); return r.json(); };
const count = async () => (await pool.query('SELECT count(*)::int n FROM rodo228_access_log WHERE tenant_id=$1', [A])).rows[0].n as number;
const wire = (method: string, parameters: unknown) => app.inject({ method: 'POST', url: '/connector.php', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-bltoken': wireToken },
  payload: new URLSearchParams({ method, parameters: JSON.stringify(parameters) }).toString() });
/** Files of a stored ZIP by name. */
function unzip(b: Buffer) {
  const end = b.length - 22, out: Record<string, Buffer> = {};
  assert.equal(b.readUInt32LE(end), 0x06054b50);
  let p = b.readUInt32LE(end + 16);
  for (let i = 0; i < b.readUInt16LE(end + 10); i++) {
    const n = b.readUInt16LE(p + 28), size = b.readUInt32LE(p + 24), off = b.readUInt32LE(p + 42), name = b.subarray(p + 46, p + 46 + n).toString();
    out[name] = b.subarray(off + 30 + b.readUInt16LE(off + 26), off + 30 + b.readUInt16LE(off + 26) + size); p += 46 + n;
  }
  return out;
}

before(async () => {
  assert.equal((await pool.query("SELECT count(*)::int n FROM migrations WHERE name='228_rodo'")).rows[0].n, 1, 'Clone needs committed 228');
  assert.equal(await count(), 0, 'Fresh clone required; no rerun');
  assert.equal(await rodo228Available(pool), true);
  admin = (await pool.query("SELECT user_id FROM memberships WHERE tenant_id=$1 AND role='admin' ORDER BY user_id LIMIT 1", [A])).rows[0].user_id;
  const status = (await pool.query('SELECT id FROM crm_statuses WHERE tenant_id=$1 AND is_primary', [A])).rows[0].id;
  for (let i = 0; i < N; i++) {
    const email = `s2-flood-${String(i).padStart(3, '0')}@example.test`;
    const id = (await pool.query('INSERT INTO crm_clients(tenant_id,status_id,profile) VALUES($1,$2,$3::jsonb) RETURNING id::text', [A, status, JSON.stringify({ star: 0, contractor_id: 0,
      login: 's2-flood-' + i, phone: '', email, notes: '', invoice_company: '', invoice_fullname: 'Klient ' + i, invoice_address: '', invoice_postcode: '', invoice_city: '', invoice_state: '',
      invoice_country_code: 'PL', invoice_tax_id: '', delivery_company: '', delivery_fullname: '', delivery_address: '', delivery_postcode: '', delivery_city: '', delivery_state: '', delivery_country_code: '' })])).rows[0].id;
    clients.push({ id, email });
  }
  wireToken = 'dyna_api_' + randomBytes(32).toString('hex');
  const wireKey = randomUUID();
  await pool.query(`INSERT INTO api_keys(id,tenant_id,user_id,name,token_hash,prefix,scopes,expires_at) VALUES($1,$2,$3,'Isolated s2 register test',$4,$5,'{orders:read}',clock_timestamp()+interval '1 day')`,
    [wireKey, A, admin, tokenHash(wireToken), wireToken.slice(0, 16)]);
  await pool.query("INSERT INTO base_wire218_key_scopes(tenant_id,key_id,scope) VALUES($1,$2,'crm:read')", [A, wireKey]);
  observeBaseWireReads(rodo228WireObserver(pool, KEY, () => rodo228Available(pool)));
  app = Fastify();
  app.decorateRequest('actor'); app.decorateRequest('apiScopes');
  app.addHook('preHandler', async (req: any) => {
    if (!req.url.startsWith('/api/')) return;
    const as = JSON.parse(String(req.headers['x-test-as'] ?? '{}'));
    req.actor = { tenantId: A, userId: as.user ?? admin, role: as.role ?? 'admin' };
  });
  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof Problem) return reply.code(err.status).send({ error: err.message });
    if (err instanceof z.ZodError) return reply.code(422).send({ error: err.issues.map(i => i.message).join('; ') });
    process.stderr.write('s2 register test 500: ' + String(err?.message ?? err).slice(0, 400) + '\n');
    return reply.code(500).send({ error: 'Błąd serwera' });
  });
  registerCrmRoutes(app, { available: true, readOnly: false, access: rodo228CrmAccess(pool, KEY) });
  registerBaseWireCrmRoutes(app, { available: true, readOnly: false, service: createDefaultBaseWireCrmService(), authenticate: (t, s) => authenticateBaseWireApiKey(t, s, true) });
  registerRodo228Routes(app, { available: true, readOnly: false, pool, key: KEY, now: () => new Date() });
  await app.ready();
});
after(async () => { observeBaseWireReads(null); await app?.close(); await pool.end(); });

let listed: string[] = [];
test('one CRM list page of 100 clients writes one register row naming every listed client', async () => {
  const before = await count();
  const page = ok(await call('GET', '/api/crm/clients?limit=100&search=s2-flood', { role: 'viewer' }));
  listed = page.data.map((x: any) => x.id);
  assert.equal(listed.length, N);
  assert.equal(await count() - before, 1, 'one register row per list request, not one per client');
  const row = (await pool.query("SELECT action,channel,resource,crm_client_id::text,subject_hash,detail FROM rodo228_access_log WHERE tenant_id=$1 AND action='list' ORDER BY accessed_at DESC,id DESC LIMIT 1", [A])).rows[0];
  assert.deepEqual([row.action, row.channel, row.resource], ['list', 'session', 'GET /api/crm/clients']);
  assert.deepEqual(row.detail.crm_client_ids, listed);
  assert.equal(row.detail.count, N);
  assert.equal(row.crm_client_id, listed[0]);
  assert(!/@example\.test/.test(JSON.stringify(row)), 'no e-mail or phone in the register row');
});

test('50 list calls of 100 clients grow the register by 50 rows (was 5000); purge has nothing to remove', async () => {
  const before = await count();
  for (let i = 0; i < 50; i++) ok(await call('GET', '/api/crm/clients?limit=100&search=s2-flood', { role: 'viewer' }));
  assert.equal(await count() - before, 50);
  assert.equal(ok(await call('POST', '/api/rodo228/access-log/purge')).deleted, 0);
});

test('an empty list page writes nothing', async () => {
  const before = await count();
  assert.equal(ok(await call('GET', '/api/crm/clients?limit=100&search=nikogo-takiego-s2')).data.length, 0);
  assert.equal(await count(), before);
});

test('the register filters by CRM id and e-mail find the list row of a client that was not first on the page', async () => {
  const target = clients.find(c => c.id === listed[57])!;
  const byId = ok(await call('GET', '/api/rodo228/access-log?action=list&limit=200&crm_client_id=' + target.id));
  assert(byId.data.length >= 51, 'every list call that showed the client: ' + byId.data.length);
  assert(byId.data.every((r: any) => r.action === 'list' && r.detail.crm_client_ids.includes(target.id)));
  const byEmail = ok(await call('GET', '/api/rodo228/access-log?action=list&limit=200&email=' + encodeURIComponent(target.email)));
  assert.equal(byEmail.data.length, byId.data.length);
  const other = ok(await call('GET', '/api/rodo228/access-log?action=list&crm_client_id=' + randomUUID()));
  assert.equal(other.data.length, 0);
});

test('the export of a listed client (by CRM id and by e-mail) contains the list accesses', async () => {
  const target = clients.find(c => c.id === listed[99])!;
  for (const q of ['crm_client_id=' + target.id, 'email=' + encodeURIComponent(target.email)]) {
    const r = await call('GET', '/api/rodo228/export?' + q);
    assert.equal(r.statusCode, 200, r.body);
    const data = JSON.parse(unzip(r.rawPayload)['dane-klienta.json']!.toString('utf8'));
    assert(data.rejestr_dostepu.filter((x: any) => x.czynnosc === 'list').length >= 51, q);
  }
});

test('connector.php getCrmClients writes one register row per call naming the local CRM clients', async () => {
  const before = await count();
  const w = await wire('getCrmClients', { page: 1 });
  assert.equal(w.statusCode, 200, w.body); assert.equal(w.json().status, 'SUCCESS', w.body);
  const returned = Object.keys(w.json().clients ?? {}).length || (Array.isArray(w.json().clients) ? w.json().clients.length : 0);
  assert(returned > 1, 'wire page returns several clients: ' + returned);
  assert.equal(await count() - before, 1);
  const row = (await pool.query("SELECT channel,resource,detail FROM rodo228_access_log WHERE tenant_id=$1 AND resource='connector.php getCrmClients'", [A])).rows;
  assert.equal(row.length, 1);
  assert.equal(row[0].channel, 'api');
  assert.equal(row[0].detail.count, row[0].detail.crm_client_ids.length);
  assert(row[0].detail.crm_client_ids.length >= 1);
});
