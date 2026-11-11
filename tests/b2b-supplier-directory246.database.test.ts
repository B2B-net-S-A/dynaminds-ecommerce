/** B2B-008 (DOM-B2B-008) on migration 246 (prepared as placeholder 254): the public supplier directory. Opt-in profile without prices,
 * search from another company, a seller's request, the supplier's acceptance through an ordinary network
 * invitation and the existing POST /api/b2b/network/accept; decline, withdraw, replay, roles and isolation.
 * Database test on a disposable clone dynaminds_m246_<YYYYMMDD>_NN; the real migrate() applies 246 after 245. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../server/app';
import { pool, migrate } from '../server/db';
import { seed, DEMO_TENANT, SECOND_TENANT } from './fixtures';

assert.equal(process.env.DYNA_TEST, 'true');
const database = new URL(process.env.DATABASE_URL ?? 'invalid://missing');
assert.equal(database.hostname, '127.0.0.1');
assert.equal(database.port, '57084');
assert.match(database.pathname, /^\/dynaminds_m(?:24[6789]|25[0123456789]|26[0123])_2026[0-9]{4}_[0-9]{2}$/, 'fresh clone dynaminds_m246_YYYYMMDD_NN (or m247/m248/m249/m250/m251/m252/m253/m254/m255/m256/m257/m258/m259/m260/m261/m262/m263 after 247/248/249/250/251/252/253/254/255/256/257/258/259/260/261/262) required');
pool.options.options = String(pool.options.options).replace('statement_timeout=8000', 'statement_timeout=60000');

// The demo company is the supplier, the second company (other@demo.local) is the seller.
let app: any, supplier = '', viewer = '', seller = '', warehouse = '';
const req = (path: string, method: any = 'GET', payload?: any, cookie = supplier) =>
  app.inject({ url: '/api' + path, method, payload, headers: { cookie } });
async function api(path: string, method: any = 'GET', body?: any, cookie = supplier) {
  const r = await req(path, method, body, cookie);
  assert(r.statusCode < 300, method + ' ' + path + ' ' + r.statusCode + ' ' + r.body);
  return r.json();
}
before(async () => {
  await migrate();
  assert((await pool.query("SELECT EXISTS(SELECT FROM migrations WHERE name='246_b2b_trade_credit_directory') ok")).rows[0].ok, 'migrate() applied 246');
  await seed();
  app = await buildApp();
  for (const [email, set] of [
    ['admin@demo.local', (c: string) => (supplier = c)],
    ['viewer@demo.local', (c: string) => (viewer = c)],
    ['other@demo.local', (c: string) => (seller = c)],
  ] as const) {
    const r = await req('/auth/login', 'POST', { email, password: 'DynaDemo!2026' }, '');
    assert.equal(r.statusCode, 200, r.body);
    set(r.headers['set-cookie'].toString().split(';')[0]);
  }
  warehouse = (await api('/warehouses')).data[0].id;
  // A clean directory for the two demo companies (the template has none; reruns on a kept clone do).
  await pool.query('UPDATE b2b254_directory_requests SET state=\'withdrawn\',decided_at=now() WHERE state=\'pending\'');
});
after(async () => {
  await app?.close();
  await pool.end();
});

const profile = (b: any, cookie = supplier) => req('/b2b/directory/profile', 'PUT', { display_name: 'Hurtownia Demo', description: 'Papier i opakowania', city: 'Łódź', country: 'pl', categories: ['papier', 'opakowania'], listed: true, confirmed: true, ...b }, cookie);
const search = (q = '', cookie = seller) => api('/b2b/directory?' + new URLSearchParams({ search: q }), 'GET', undefined, cookie);
const ask = (b: any = {}, cookie = seller) => req('/b2b/directory/requests', 'POST', { supplier_tenant_id: DEMO_TENANT, client_key: randomUUID(), message: 'Prosimy o współpracę', confirmed: true, ...b }, cookie);
async function account() {
  const list = await api('/price-lists', 'POST', { name: 'Cennik katalogu ' + randomUUID().slice(0, 6), currency: 'PLN' });
  const body = { name: 'Sprzedawca z katalogu ' + randomUUID().slice(0, 6), email: randomUUID() + '@example.test', warehouse_id: warehouse, price_list_id: list.id, address: { street: 'Sieciowa 1', city: 'Warszawa', postal_code: '00-001', country: 'PL' }, min_total: 0, min_quantity: 1, quantity_step: 1, shipping_cost: 0, payment_mode: 'prepaid' };
  const a = await api('/b2b/accounts', 'POST', body);
  return api('/b2b/accounts/' + a.id, 'PATCH', { ...body, version: a.version, active: true, confirmed: true });
}
const myVersion = async (cookie = supplier) => (await api('/b2b/directory/profile', 'GET', undefined, cookie)).profile?.version ?? 0;

test('an unlisted profile is invisible; a listed one shows only public fields; only the administrator edits it', async () => {
  assert.equal((await profile({ version: 0 }, viewer)).statusCode, 403);
  const first = await profile({ version: await myVersion(), listed: false });
  assert.equal(first.statusCode, 200, first.body);
  assert(!(await search()).data.some((p: any) => p.tenant_id === DEMO_TENANT), 'not listed');
  assert.equal((await ask()).statusCode, 404, 'an unlisted supplier cannot be asked');
  assert.equal((await profile({ version: 999 })).statusCode, 409);
  const listed = await profile({ version: await myVersion() });
  assert.equal(listed.statusCode, 200, listed.body);
  assert.equal(listed.json().profile.country, 'PL');
  const found = (await search('opakowania')).data.find((p: any) => p.tenant_id === DEMO_TENANT);
  assert.deepEqual(Object.keys(found).sort(), ['categories', 'city', 'connected', 'country', 'description', 'display_name', 'request', 'tenant_id']);
  assert.equal(found.display_name, 'Hurtownia Demo');
  assert(!(await search('', supplier)).data.some((p: any) => p.tenant_id === DEMO_TENANT), 'own profile is not in own search');
  assert.equal((await search('nie-ma-takiego-dostawcy')).data.length, 0);
  // The application role sees other companies' rows only through the listed policy.
  const c = await pool.connect();
  try {
    await c.query('BEGIN'); await c.query('SET LOCAL ROLE dyna_app');
    await c.query("SELECT set_config('app.tenant_id',$1,true)", [SECOND_TENANT]);
    assert.equal((await c.query('SELECT count(*)::int n FROM b2b254_directory_profiles WHERE tenant_id=$1', [DEMO_TENANT])).rows[0].n, 1);
    assert.equal((await c.query('UPDATE b2b254_directory_profiles SET description=$2 WHERE tenant_id=$1', [DEMO_TENANT, 'przejęte'])).rowCount, 0, 'no cross-company write');
    await c.query('ROLLBACK');
  } finally { c.release(); }
});

test('request → accept for an own account → the seller connects through the existing network accept', async () => {
  await profile({ version: await myVersion() });
  const key = randomUUID();
  const sent = await ask({ client_key: key });
  assert.equal(sent.statusCode, 200, sent.body);
  const request = sent.json().request;
  assert.equal(request.state, 'pending');
  assert.equal(request.recipient_email, undefined, 'the requester does not echo its own contact field');
  assert.equal((await ask({ client_key: key })).json().reused, true, 'replay by key');
  assert.equal((await ask({ client_key: key, message: 'Inna treść' })).statusCode, 409, 'same key, other content');
  assert.equal((await ask()).statusCode, 409, 'one open request per supplier');
  assert.equal((await ask({}, viewer)).statusCode, 403);
  assert.equal((await ask({ supplier_tenant_id: SECOND_TENANT })).statusCode, 422, 'own company');
  const inbox = await api('/b2b/directory/requests');
  const incoming = inbox.incoming.find((x: any) => x.id === request.id);
  assert.equal(incoming.recipient_email, 'other@demo.local');
  assert.equal(incoming.requester_name.length > 0, true);
  assert.deepEqual((await api('/b2b/directory/requests', 'GET', undefined, viewer)).incoming, [], 'contact data only for the administrator');
  assert.equal((await req('/b2b/directory/requests/' + request.id + '/invitation', 'POST', { confirmed: true }, seller)).statusCode, 409, 'not accepted yet');
  assert.equal((await req('/b2b/directory/requests/' + request.id + '/accept', 'POST', { account_id: randomUUID(), version: 1, confirmed: true }, seller)).statusCode, 404, 'the seller cannot accept its own request');
  const a = await account();
  assert.equal((await req('/b2b/directory/requests/' + request.id + '/accept', 'POST', { account_id: a.id, version: a.version + 1, confirmed: true })).statusCode, 409, 'stale account version');
  const accepted = await api('/b2b/directory/requests/' + request.id + '/accept', 'POST', { account_id: a.id, version: a.version, confirmed: true });
  assert.equal(accepted.request.state, 'accepted');
  const inv = (await pool.query('SELECT recipient_email,state,account_id FROM b2b_link_invitations WHERE id=(SELECT invitation_id FROM b2b254_directory_requests WHERE id=$1)', [request.id])).rows[0];
  assert.deepEqual(inv, { recipient_email: 'other@demo.local', state: 'pending', account_id: a.id });
  assert.equal((await req('/b2b/directory/requests/' + request.id + '/decline', 'POST', { confirmed: true })).statusCode, 409, 'decided');
  // No prices before the link: the seller has no catalogue route for this supplier yet.
  assert.equal((await search()).data.find((p: any) => p.tenant_id === DEMO_TENANT).connected, false);
  const { token } = await api('/b2b/directory/requests/' + request.id + '/invitation', 'POST', { confirmed: true }, seller);
  assert.match(token, /^[a-f0-9]{64}$/);
  const link = await api('/b2b/network/accept', 'POST', { token, confirmed: true }, seller);
  assert.equal(link.supplier_tenant_id, DEMO_TENANT);
  assert.equal(link.account_id, a.id);
  assert.equal((await search()).data.find((p: any) => p.tenant_id === DEMO_TENANT).connected, true);
  assert.equal((await api('/b2b/directory/requests', 'GET', undefined, seller)).outgoing.find((x: any) => x.id === request.id).connected, true);
  assert.equal((await req('/b2b/directory/requests/' + request.id + '/invitation', 'POST', { confirmed: true }, seller)).statusCode, 409, 'the invitation is used');
  assert.equal((await ask()).statusCode, 409, 'already connected');
  const audit = (await pool.query("SELECT action FROM audit_events WHERE entity_id=$1 ORDER BY created_at", [request.id])).rows.map((r) => r.action);
  assert.deepEqual(audit.filter((x) => x.startsWith('b2b.directory.')), ['b2b.directory.requested', 'b2b.directory.accepted', 'b2b.directory.invitation_opened']);
});

test('decline and withdraw close the request; another company sees neither side of it', async () => {
  // A fresh pair: the supplier is the second company this time, so the existing link above does not apply.
  const v = (await api('/b2b/directory/profile', 'GET', undefined, seller)).profile?.version ?? 0;
  assert.equal((await profile({ display_name: 'Druga hurtownia', version: v }, seller)).statusCode, 200);
  const r1 = (await ask({ supplier_tenant_id: SECOND_TENANT }, supplier)).json().request;
  assert.equal((await req('/b2b/directory/requests/' + r1.id + '/withdraw', 'POST', { confirmed: true }, seller)).statusCode, 404, 'only the requester withdraws');
  assert.equal((await api('/b2b/directory/requests/' + r1.id + '/decline', 'POST', { confirmed: true }, seller)).request.state, 'declined');
  const r2 = (await ask({ supplier_tenant_id: SECOND_TENANT }, supplier)).json().request;
  assert.equal((await api('/b2b/directory/requests/' + r2.id + '/withdraw', 'POST', { confirmed: true }, supplier)).request.state, 'withdrawn');
  assert.equal((await req('/b2b/directory/requests/' + r2.id + '/accept', 'POST', { account_id: randomUUID(), version: 1, confirmed: true }, seller)).statusCode, 409, 'withdrawn');
  const third = randomUUID();
  const c = await pool.connect();
  try {
    await c.query('BEGIN'); await c.query('SET LOCAL ROLE dyna_app');
    await c.query("SELECT set_config('app.tenant_id',$1,true)", [third]);
    assert.equal((await c.query('SELECT count(*)::int n FROM b2b254_directory_requests WHERE id=ANY($1::uuid[])', [[r1.id, r2.id]])).rows[0].n, 0);
    await c.query('ROLLBACK');
  } finally { c.release(); }
  // The supplier's administrator cannot rewrite the requester's message, only the decision columns.
  const d = await pool.connect();
  try {
    await d.query('BEGIN'); await d.query('SET LOCAL ROLE dyna_app');
    await d.query("SELECT set_config('app.tenant_id',$1,true)", [SECOND_TENANT]);
    await assert.rejects(d.query('UPDATE b2b254_directory_requests SET message=$2 WHERE id=$1', [r1.id, 'zmiana']), /permission denied/);
    await d.query('ROLLBACK');
  } finally { d.release(); }
});
