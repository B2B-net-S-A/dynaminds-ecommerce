/** Security review M6 on migration 246 (prepared as placeholder 254): FORCE ROW LEVEL SECURITY on payu242_*,
 * audit238_event_keys and the 244 tables custom_event_defs and custom_event_calls.
 * The two owner-pool reads of server/payu242.ts that run before the tenant is known (the notification's
 * configuration lookup in handlePayu242Notification, the session lookup in payu242ReturnState) keep working,
 * because the pool's login owns the tables and bypasses RLS (superuser), exactly like the 610 tables that already
 * have FORCE (orders read by portal token in the same flow). The last test shows what FORCE would do to an owner
 * without that bypass, for the payu tables and for orders alike, so the requirement is not new.
 * PayU runs as the local fake (DYNA_PAYU_FAKE=local). Clone dynaminds_m246_<YYYYMMDD>_NN; the real
 * migrate() applies 246. Custom events (244) still define, raise once per client key and list their calls under FORCE. */
process.env.DYNA_PAYU_FAKE = 'local';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../server/app';
import { migrate, pool } from '../server/db';
import { payu242Fake, payu242FakeNotification, payu242FakeReturnPath, payu242ReturnState } from '../server/payu242';
import { PAYU242_NOTIFY_IPS } from '../server/payu242-session';
import { seed, DEMO_TENANT } from './fixtures';

assert.equal(process.env.DYNA_TEST, 'true');
const database = new URL(process.env.DATABASE_URL ?? 'invalid://missing');
assert.equal(database.hostname, '127.0.0.1');
assert.equal(database.port, '57084');
assert.match(database.pathname, /^\/dynaminds_m(?:24[6789]|25[0123456789]|26[0123])_2026[0-9]{4}_[0-9]{2}$/, 'fresh clone dynaminds_m246_YYYYMMDD_NN (or m247/m248/m249/m250/m251/m252/m253/m254/m255/m256/m257/m258/m259/m260/m261/m262/m263 after 247/248/249/250/251/252/253/254/255/256/257/258/259/260/261/262) required');
pool.options.options = String(pool.options.options).replace('statement_timeout=8000', 'statement_timeout=60000');

const M6 = ['payu242_configs', 'payu242_sessions', 'payu242_notifications', 'payu242_refunds', 'audit238_event_keys', 'custom_event_defs', 'custom_event_calls'];
let app: Awaited<ReturnType<typeof buildApp>>;
let admin = '', warehouse = '', configId = '';
const api = (url: string, method: any = 'GET', payload?: any, headers: Record<string, string> = { cookie: admin }) =>
  app.inject({ url: '/api' + url, method, payload, headers: { ...headers, ...(url === '/orders' || url === '/v1/orders' ? { 'idempotency-key': randomUUID() } : {}) } });
async function ok(url: string, method: any = 'GET', payload?: any, headers?: Record<string, string>) {
  const r = await api(url, method, payload, headers);
  assert(r.statusCode < 300, url + ' ' + r.statusCode + ' ' + r.body);
  return r.json();
}
before(async () => {
  await migrate();
  assert((await pool.query("SELECT EXISTS(SELECT FROM migrations WHERE name='246_b2b_trade_credit_directory') ok")).rows[0].ok, 'migrate() applied 246');
  await seed();
  app = await buildApp();
  const r = await app.inject({ url: '/api/auth/login', method: 'POST', payload: { email: 'admin@demo.local', password: 'DynaDemo!2026' } });
  admin = r.headers['set-cookie']!.toString().split(';')[0];
  warehouse = (await ok('/warehouses')).data[0].id;
});
after(async () => {
  await app.close();
  await pool.end();
});

test('the seven M6 tables and the four own 246 tables have RLS enabled and forced', async () => {
  const rows = (await pool.query("SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class WHERE relnamespace='public'::regnamespace AND relname=ANY($1) ORDER BY relname",
    [[...M6, 'b2b254_trade_lines', 'b2b254_trade_charges', 'b2b254_directory_profiles', 'b2b254_directory_requests']])).rows;
  assert.equal(rows.length, 11);
  for (const r of rows) assert.deepEqual([r.relname, r.relrowsecurity, r.relforcerowsecurity], [r.relname, true, true]);
  const login = (await pool.query("SELECT r.rolsuper OR r.rolbypassrls AS bypass, pg_get_userbyid(c.relowner)=current_user AS owns FROM pg_roles r, pg_class c WHERE r.rolname=current_user AND c.oid='public.payu242_configs'::regclass")).rows[0];
  assert.deepEqual(login, { bypass: true, owns: true }, 'the owner pool owns the tables and bypasses RLS');
});

test('after FORCE a PayU notification (config lookup by id) and the return page (session lookup) still work end to end', async () => {
  const saved = await ok('/payu/config', 'PUT', { environment: 'sandbox', pos_id: '300746', public_origin: 'https://sklep.example.test', client_secret: 'synthetic-secret-254-aaaa', second_key: 'synthetic-second-key-254' });
  configId = (await pool.query('SELECT id FROM payu242_configs WHERE tenant_id=$1', [DEMO_TENANT])).rows[0].id;
  assert.equal(saved.configured, true);
  const p = await ok('/products', 'POST', { name: 'PayU 254', sku: 'P254-' + randomUUID().slice(0, 8), price: 4321, quantity: 5, warehouse_id: warehouse });
  const o = await ok('/orders/' + (await ok('/orders', 'POST', { customer_name: 'Kupujący', email: 'k254@example.test', warehouse_id: warehouse, items: [{ product_id: p.id, quantity: 1 }], shipping_cost: 0 })).id);
  const start = await app.inject({ url: '/api/public/orders/' + o.portal_token + '/payments/payu', method: 'POST', payload: { client_key: randomUUID() }, remoteAddress: '203.0.113.7' });
  assert.equal(start.statusCode, 201, start.body);
  const s = (await pool.query('SELECT * FROM payu242_sessions WHERE id=$1', [start.json().session_id])).rows[0];
  payu242Fake(configId)!.setStatus(s.provider_order_id, 'COMPLETED');
  const n = payu242FakeNotification(s.provider_order_id)!;
  const r = await app.inject({ method: 'POST', url: n.path, payload: n.body, headers: { 'content-type': 'application/json', ...n.headers }, remoteAddress: PAYU242_NOTIFY_IPS.sandbox[1] });
  assert.equal(r.statusCode, 200, 'handlePayu242Notification found the configuration through the owner pool');
  const booked = (await pool.query("SELECT amount FROM payment_entries WHERE order_id=$1 AND method='payu'", [o.id])).rows;
  assert.deepEqual(booked.map((b) => b.amount), [4321]);
  const secret = new URL('http://x' + payu242FakeReturnPath(s.provider_order_id)!).searchParams.get('s');
  const back = await payu242ReturnState(s.id, secret);
  assert.deepEqual([back.status, back.booked, back.amount], ['COMPLETED', true, 4321], 'payu242ReturnState read the session through the owner pool');
  await assert.rejects(payu242ReturnState(s.id, 'x'.repeat(43)), /Nie znaleziono płatności/);
});

test('an API-key action still records its key in audit238_event_keys under FORCE', async () => {
  const k = await ok('/developer/keys', 'POST', { name: 'M6 254', scopes: ['products:read', 'products:write'] });
  const r = await api('/v1/products', 'POST', { name: 'Klucz 254', sku: 'K254-' + randomUUID().slice(0, 8), price: 100, quantity: 1, warehouse_id: warehouse }, { authorization: 'Bearer ' + k.token });
  assert(r.statusCode < 300, r.body);
  const rows = (await pool.query('SELECT k.api_key_id FROM audit238_event_keys k JOIN audit_events e ON e.id=k.event_id WHERE e.entity_id=$1', [r.json().id])).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].api_key_id, k.id);
});

test('custom events (244) under FORCE: define, raise once per client key, list the calls; another company sees nothing', async () => {
  const p = await ok('/products', 'POST', { name: 'Zdarzenie 246', sku: 'E246-' + randomUUID().slice(0, 8), price: 1000, quantity: 5, warehouse_id: warehouse });
  const o = await ok('/orders', 'POST', { customer_name: 'Kupujący', email: 'e246@example.test', warehouse_id: warehouse, items: [{ product_id: p.id, quantity: 1 }], shipping_cost: 0 });
  const key = 'm6_' + randomUUID().slice(0, 8).replace(/-/g, '');
  const d = await ok('/custom-events', 'POST', { key, name: 'M6 246' });
  const client_key = randomUUID();
  const first = await ok('/custom-events/' + key + '/raise', 'POST', { order_id: o.id, client_key });
  const again = await ok('/custom-events/' + key + '/raise', 'POST', { order_id: o.id, client_key });
  assert.deepEqual([first.replayed, again.replayed, again.call.id], [false, true, first.call.id], 'the same client key is the same call');
  const calls = await ok('/custom-events/' + d.id + '/calls');
  assert.deepEqual(calls.data.map((x: any) => x.id), [first.call.id]);
  const r = await app.inject({ url: '/api/auth/login', method: 'POST', payload: { email: 'other@demo.local', password: 'DynaDemo!2026' } });
  const other = r.headers['set-cookie']!.toString().split(';')[0];
  assert(!(await ok('/custom-events', 'GET', undefined, { cookie: other })).data.some((x: any) => x.id === d.id), 'tenant isolation');
  assert.equal((await pool.query('SELECT count(*)::int n FROM custom_event_calls WHERE definition_id=$1', [d.id])).rows[0].n, 1, 'the owner pool still reads the history');
});

test('why the bypass matters: an owner without it would see no row under FORCE, for payu242_configs and orders alike', async () => {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const role = 'p254_owner_' + randomUUID().slice(0, 8).replace(/-/g, '');
    await c.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
    await c.query(`ALTER TABLE payu242_configs OWNER TO ${role}`);
    await c.query(`ALTER TABLE orders OWNER TO ${role}`);
    await c.query(`SET LOCAL ROLE ${role}`);
    const seen = async () => [
      (await c.query('SELECT count(*)::int n FROM payu242_configs WHERE id=$1', [configId])).rows[0].n,
      (await c.query('SELECT count(*)::int n FROM orders WHERE tenant_id=$1', [DEMO_TENANT])).rows[0].n > 0,
    ];
    assert.deepEqual(await seen(), [0, false], 'FORCE hides both from a non-bypass owner outside a tenant scope');
    await c.query('RESET ROLE');
    await c.query('ALTER TABLE payu242_configs NO FORCE ROW LEVEL SECURITY');
    await c.query(`SET LOCAL ROLE ${role}`);
    assert.deepEqual(await seen(), [1, false], 'only the unforced table would still answer');
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
});
