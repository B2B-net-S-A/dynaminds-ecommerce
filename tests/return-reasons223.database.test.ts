/** Native 223 return reason dictionary on a real disposable clone: the actual session
 * routes (Fastify injection with the request actor the auth hook would set), the native
 * RMA (requestReturn through POST /api/orders/:id/returns, returnPage, getReturn), and
 * the actual Base connector.php (getOrderReturnReasonsList, addOrderReturn,
 * getOrderReturns) with the real developer key gate. Every expectation is read back
 * from the native rows. Root-only execution on a fresh clone dynaminds_pimgaps_20261023_NN
 * made from the clean 217 template with 218–223 by the guarded applier. The suite
 * writes; rerun = NEW clone.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, tenantTx } from '../server/db';
import { Problem } from '../server/errors';
import { tokenHash } from '../server/security';
import { authenticateBaseWireApiKey } from '../server/developer-api';
import { registerBaseWireRoutes } from '../server/base-wire-routes';
import { createBaseWireOrdersFamily } from '../server/base-wire-orders';
import { createDefaultBaseWireOrdersService } from '../server/base-wire-orders-runtime';
import { createBaseWireReturnsFamily, baseWireReturnId } from '../server/base-wire-returns';
import { createDefaultBaseWireReturnsService } from '../server/base-wire-returns-runtime';
import { registerReturnRoutes } from '../server/return-routes';
import { registerReturnReasons223Routes } from '../server/return-reasons223-routes';
import { createProduct } from '../server/catalog';
import { productSchema, scan, shipDemo, type Actor } from '../server/domain';
import { transitionDirectLegacyOnReturnInTx } from '../server/legacy-return-on-command';
import { requestReturn, returnInput } from '../server/returns';

assert.equal(process.env.DYNA_TEST, 'true', 'Explicit isolated test mode required');
const selected = new URL(process.env.DATABASE_URL ?? 'invalid://missing');
assert.equal(selected.hostname, '127.0.0.1');
assert.equal(selected.port, '57084');
assert.match(selected.pathname, /^\/dynaminds_pimgaps_20261023_[0-9]{2}$/);
assert.equal(selected.username, 'postgres');
pool.options.query_timeout = 9000;
const KEY_NAME = 'Isolated return reasons 223 test';
type Owner = { tenant: string; user: string; catalog: string; warehouse: string; currency: string; actor: Actor };
type Key = { id: string; token: string; scopes: string[] };
let session: FastifyInstance, wire: FastifyInstance, a: Owner, b: Owner;
let keys: { a: Key; aRead: Key; aConfigure: Key; b: Key };
const tag = randomBytes(4).toString('hex');

async function key(owner: Owner, scopes: string[]): Promise<Key> {
  const token = 'dyna_api_' + randomBytes(32).toString('hex'), id = randomUUID();
  await pool.query(`INSERT INTO api_keys(id,tenant_id,user_id,name,token_hash,prefix,scopes,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,clock_timestamp()+interval '1 day')`, [id, owner.tenant, owner.user, KEY_NAME, tokenHash(token), token.slice(0, 16), scopes]);
  return { id, token, scopes };
}
type As = { owner: Owner; role?: Actor['role']; key?: Key };
function call(as: As, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) {
  const headers = { 'x-test-as': JSON.stringify({ tenant: as.owner.tenant, user: as.owner.user, role: as.role ?? 'admin',
    key: as.key ? { id: as.key.id, scopes: as.key.scopes } : null }) };
  return session.inject({ method, url, headers, ...(payload === undefined ? {} : { payload: payload as any }) });
}
async function base(k: Key, method: string, parameters: unknown) {
  return wire.inject({ method: 'POST', url: '/connector.php', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-bltoken': k.token },
    payload: new URLSearchParams({ method, parameters: JSON.stringify(parameters) }).toString() });
}
const ok = (r: any, status: number) => { assert.equal(r.statusCode, status, r.body); return r.json(); };
const refused = (r: any, status: number, pattern?: RegExp) => {
  assert.equal(r.statusCode, status, r.body); assert(!/SELECT |stack|dyna_api_/.test(r.body), r.body);
  if (pattern) assert.match(r.json().error, pattern); return r.json();
};
const baseOk = (r: any) => { assert.equal(r.statusCode, 200, r.body); const d = r.json(); assert.equal(d.status, 'SUCCESS', r.body); return d; };
const baseRefused = (r: any, status: number) => { assert.equal(r.statusCode, status, r.body); const d = r.json(); assert.equal(d.status, 'ERROR', r.body); return d; };
const publicId = async (table: string, tenant: string, local: string) =>
  Number((await pool.query(`SELECT public_id::text p FROM ${table} WHERE tenant_id=$1 AND local_id=$2`, [tenant, local])).rows[0]?.p);
const version = async (c: any, id: string) => (await c.query('SELECT version::text v FROM orders WHERE id=$1', [id])).rows[0].v as string;
const reasonRows = async (tenant: string) => (await pool.query('SELECT id,public_id::text p,name,active,version FROM return_reasons223 WHERE tenant_id=$1 ORDER BY public_id', [tenant])).rows;
const caseReason = async (returnId: string) => (await pool.query('SELECT reason_id,reason_name,actor_id FROM return_case_reasons223 WHERE return_id=$1', [returnId])).rows;

/** Base addOrder (paid) of 3 units, then native picking, scans, packed and a demo shipment. */
async function shippedOrder(o: Owner, k: Key) {
  const sku = 'RR-' + tag + '-' + randomBytes(2).toString('hex');
  const p = await tenantTx(o.tenant, c => createProduct(c, o.actor, productSchema.parse({ name: 'Produkt ' + sku, sku, price: 1999, vat: 23, catalog_id: o.catalog, warehouse_id: o.warehouse, quantity: 10 })));
  const pid = await publicId('base_wire220_product_ids', o.tenant, p.id), wid = await publicId('base_wire220_warehouse_ids', o.tenant, o.warehouse);
  const order = baseOk(await base(k, 'addOrder', { delivery_fullname: 'Jan Base', email: 'base@example.com', phone: '500600700', delivery_address: 'Prosta 1',
    delivery_postcode: '00-001', delivery_city: 'Warszawa', delivery_country_code: 'PL', currency: o.currency, paid: 1, delivery_price: 10,
    products: [{ storage: 'db', product_id: String(pid), warehouse_id: wid, price_brutto: 25.5, tax_rate: 23, quantity: 3 }] })).order_id as number;
  const local = (await pool.query('SELECT local_id FROM base_wire220_order_ids WHERE tenant_id=$1 AND public_id=$2', [o.tenant, order])).rows[0].local_id as string;
  await tenantTx(o.tenant, async c => transitionDirectLegacyOnReturnInTx(c, o.actor, local, 'picking', await version(c, local)));
  const location = (await pool.query('SELECT location FROM reservation_locations WHERE order_id=$1', [local])).rows[0]?.location;
  for (let n = 0; n < 3; n++) await tenantTx(o.tenant, c => scan(c, o.actor, local, sku, location, undefined, { client_key: randomUUID() }));
  await tenantTx(o.tenant, async c => transitionDirectLegacyOnReturnInTx(c, o.actor, local, 'packed', await version(c, local)));
  await tenantTx(o.tenant, c => shipDemo(c, o.actor, local));
  const item = (await pool.query('SELECT id FROM order_items WHERE order_id=$1', [local])).rows[0].id as string;
  return { order, local, item, pid, sku };
}

before(async () => {
  for (const name of ['return_reasons223', 'return_case_reasons223', 'base_wire220_order_ids', 'order_split222_executions'])
    assert.notEqual((await pool.query('SELECT to_regclass($1) n', ['public.' + name])).rows[0].n, null, 'Clone needs committed 223: ' + name);
  assert.equal((await pool.query('SELECT count(*)::int n FROM api_keys WHERE name=$1', [KEY_NAME])).rows[0].n, 0, 'Fresh clone required; no rerun');
  const rows = (await pool.query(`SELECT m.tenant_id,m.user_id,c.id catalog,(SELECT min(w.warehouse_id::text) FROM product_catalog_warehouses w WHERE w.catalog_id=c.id) warehouse,
      (SELECT currency FROM tenants t WHERE t.id=m.tenant_id) currency
    FROM (SELECT DISTINCT ON(tenant_id) tenant_id,user_id FROM memberships WHERE role='admin' ORDER BY tenant_id,user_id) m
    JOIN product_catalogs c ON c.tenant_id=m.tenant_id AND c.is_default AND c.active
    WHERE NOT coalesce((SELECT enabled FROM wms_policies x WHERE x.tenant_id=m.tenant_id),false)
    AND NOT coalesce((SELECT require_mfa FROM workspace_security_policies x WHERE x.tenant_id=m.tenant_id),false)
    AND NOT (public.catalog_stock_control_policy(c.id)->>'strict')::boolean
    AND EXISTS(SELECT 1 FROM product_catalog_warehouses w WHERE w.catalog_id=c.id)
    ORDER BY (SELECT plan FROM tenants t WHERE t.id=m.tenant_id)='enterprise' DESC,m.tenant_id LIMIT 2`)).rows;
  assert.equal(rows.length, 2);
  const owner = (r: any): Owner => ({ tenant: r.tenant_id, user: r.user_id, warehouse: r.warehouse, catalog: r.catalog, currency: r.currency,
    actor: { tenantId: r.tenant_id, userId: r.user_id, role: 'admin', source: 'manual' } });
  a = owner(rows[0]); b = owner(rows[1]);
  keys = { a: await key(a, ['orders:read', 'orders:write']), aRead: await key(a, ['orders:read']), aConfigure: await key(a, ['orders:read', 'returns:configure']),
    b: await key(b, ['orders:read', 'orders:write']) };
  session = Fastify();
  session.decorateRequest('actor'); session.decorateRequest('currentUser'); session.decorateRequest('apiScopes');
  session.addHook('onRequest', async (req: any) => {
    const as = JSON.parse(String(req.headers['x-test-as']));
    req.actor = { tenantId: as.tenant, userId: as.user, role: as.role, ...(as.key ? { apiKeyId: as.key.id, source: 'api' } : {}) };
    req.currentUser = { id: as.user, tenant_id: as.tenant, role: as.role, ...(as.key ? { api_key_id: as.key.id } : {}) };
    req.apiScopes = as.key ? as.key.scopes : undefined;
  });
  session.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof Problem) return reply.code(err.status).send({ error: err.message });
    if (err instanceof z.ZodError) return reply.code(422).send({ error: err.issues.map(i => i.message).join('; ') });
    return reply.code(500).send({ error: 'Błąd serwera' });
  });
  registerReturnReasons223Routes(session, { available: true, readOnly: false });
  registerReturnRoutes(session, { sessionName: 'dyna_session' });
  await session.ready();
  wire = Fastify();
  registerBaseWireRoutes(wire, { readOnly: false, families: [
    createBaseWireOrdersFamily({ available: true, service: createDefaultBaseWireOrdersService({ readOnly: false, mergeClaims: true }) }),
    createBaseWireReturnsFamily({ available: true, service: createDefaultBaseWireReturnsService({ readOnly: false, reasons: true }) })],
    authenticate: (token, scope) => authenticateBaseWireApiKey(token, scope, true) });
  await wire.ready();
});
after(async () => { await session?.close(); await wire?.close(); await pool.end(); });

let damaged: any, size: any;
test('dictionary: admin creates/renames/deactivates; identity survives renames; roles, scopes, names and tenants are enforced', async () => {
  assert.deepEqual(ok(await call({ owner: a }, 'GET', '/api/return-reasons'), 200).data, []);
  damaged = ok(await call({ owner: a }, 'POST', '/api/return-reasons', { name: '  Uszkodzony w transporcie ' }), 201);
  assert.deepEqual({ name: damaged.name, active: damaged.active, position: damaged.position, version: damaged.version }, { name: 'Uszkodzony w transporcie', active: true, position: 0, version: 1 });
  size = ok(await call({ owner: a, key: keys.aConfigure }, 'POST', '/api/return-reasons', { name: 'Zły rozmiar' }), 201);
  assert.equal(size.position, 1);
  assert(size.public_id > damaged.public_id);
  // Refusals: operator/viewer, key without returns:configure, duplicate name (case-insensitive), short name, unknown field.
  refused(await call({ owner: a, role: 'operator' }, 'POST', '/api/return-reasons', { name: 'Inny' }), 403);
  refused(await call({ owner: a, role: 'viewer' }, 'POST', '/api/return-reasons', { name: 'Inny' }), 403);
  refused(await call({ owner: a, key: keys.a }, 'POST', '/api/return-reasons', { name: 'Inny' }), 403, /returns:configure/);
  refused(await call({ owner: a }, 'POST', '/api/return-reasons', { name: 'USZKODZONY W TRANSPORCIE' }), 409);
  refused(await call({ owner: a }, 'POST', '/api/return-reasons', { name: 'ab' }), 422);
  refused(await call({ owner: a }, 'POST', '/api/return-reasons', { name: 'Inny', public_id: 5 }), 422);
  assert.equal((await reasonRows(a.tenant)).length, 2);
  // Rename keeps UUID and public ID; a stale version is 409; deactivation hides it from the default list only.
  const renamed = ok(await call({ owner: a }, 'PATCH', '/api/return-reasons/' + size.id, { version: 1, name: 'Niewłaściwy rozmiar' }), 200);
  assert.deepEqual([renamed.id, renamed.public_id, renamed.version], [size.id, size.public_id, 2]);
  refused(await call({ owner: a }, 'PATCH', '/api/return-reasons/' + size.id, { version: 1, active: false }), 409);
  refused(await call({ owner: a }, 'PATCH', '/api/return-reasons/' + size.id, { version: 2, name: 'Uszkodzony w transporcie' }), 409);
  size = ok(await call({ owner: a }, 'PATCH', '/api/return-reasons/' + size.id, { version: 2, active: false }), 200);
  assert.deepEqual(ok(await call({ owner: a, role: 'viewer' }, 'GET', '/api/return-reasons'), 200).data.map((r: any) => r.id), [damaged.id]);
  assert.deepEqual(ok(await call({ owner: a, key: keys.aRead }, 'GET', '/api/return-reasons?include_inactive=true'), 200).data.map((r: any) => [r.id, r.active]),
    [[damaged.id, true], [size.id, false]]);
  // Tenant isolation: B sees nothing and cannot change A's reason.
  assert.deepEqual(ok(await call({ owner: b }, 'GET', '/api/return-reasons?include_inactive=true'), 200).data, []);
  refused(await call({ owner: b }, 'PATCH', '/api/return-reasons/' + damaged.id, { version: 1, name: 'Przejęty' }), 404);
  assert.deepEqual((await reasonRows(a.tenant)).map(r => [r.id, r.name, r.active, r.version]),
    [[damaged.id, 'Uszkodzony w transporcie', true, 1], [size.id, 'Niewłaściwy rozmiar', false, 3]]);
  const audits = (await pool.query("SELECT action FROM audit_events WHERE tenant_id=$1 AND action LIKE 'return_reason.%' ORDER BY created_at", [a.tenant])).rows.map(r => r.action);
  assert.deepEqual(audits, ['return_reason.create', 'return_reason.create', 'return_reason.update', 'return_reason.update']);
  // The database refuses deleting a reason and changing its identity even for the owner.
  await assert.rejects(pool.query('DELETE FROM return_reasons223 WHERE id=$1', [damaged.id]), /immutable/);
  await assert.rejects(pool.query('UPDATE return_reasons223 SET name=$2 WHERE id=$1', [damaged.id, 'Bez wersji']), /immutable/);
  // Unavailable schema answers 503 for every route.
  const off = Fastify(); off.decorateRequest('actor'); off.decorateRequest('apiScopes'); off.decorateRequest('currentUser');
  off.addHook('onRequest', async (req: any) => { req.actor = a.actor; });
  off.setErrorHandler((err: any, _q, reply) => reply.code(err.status ?? 500).send({ error: err.message }));
  registerReturnReasons223Routes(off, { available: false, readOnly: false });
  assert.equal((await off.inject({ method: 'GET', url: '/api/return-reasons' })).statusCode, 503);
  await off.close();
});

test('native case: dictionary choice with free text, "other" without a choice; inactive/foreign refused; visible in register and detail', async () => {
  const x = await shippedOrder(a, keys.a);
  const body = (extra: Record<string, unknown>) => ({ client_key: randomUUID(), kind: 'return', reason: 'Pękła obudowa przy rozpakowaniu', items: [{ item_id: x.item, quantity: 1 }], ...extra });
  refused(await call({ owner: a }, 'POST', `/api/orders/${x.local}/returns`, body({ reason_id: size.id })), 422, /nieaktywny/);
  refused(await call({ owner: a }, 'POST', `/api/orders/${x.local}/returns`, body({ reason_id: randomUUID() })), 404);
  assert.equal((await pool.query('SELECT count(*)::int n FROM return_cases WHERE order_id=$1', [x.local])).rows[0].n, 0, 'refusals leave no case');
  const chosen = ok(await call({ owner: a, role: 'operator' }, 'POST', `/api/orders/${x.local}/returns`, body({ reason_id: damaged.id })), 201);
  assert.equal(chosen.reason, 'Pękła obudowa przy rozpakowaniu');
  assert.deepEqual(chosen.reason_choice, { reason_id: damaged.id, public_id: damaged.public_id, name: 'Uszkodzony w transporcie', active: true });
  assert.deepEqual(await caseReason(chosen.id), [{ reason_id: damaged.id, reason_name: 'Uszkodzony w transporcie', actor_id: a.user }]);
  const other = ok(await call({ owner: a }, 'POST', `/api/orders/${x.local}/returns`, body({})), 201);
  assert.equal(other.reason_choice, null);
  assert.deepEqual(await caseReason(other.id), []);
  // Register (returnPage) and order overview carry the same choice; a later rename shows the current name.
  ok(await call({ owner: a }, 'PATCH', '/api/return-reasons/' + damaged.id, { version: 1, name: 'Uszkodzenie w transporcie' }), 200);
  damaged = (await reasonRows(a.tenant)).find(r => r.id === damaged.id);
  const register = ok(await call({ owner: a }, 'GET', '/api/returns?limit=100'), 200).data;
  assert.equal(register.find((r: any) => r.id === chosen.id).reason_choice.name, 'Uszkodzenie w transporcie');
  assert.equal(register.find((r: any) => r.id === other.id).reason_choice, null);
  assert.equal(ok(await call({ owner: a }, 'GET', `/api/returns/${chosen.id}`), 200).reason_choice.public_id, Number(damaged.p));
  assert.deepEqual(await caseReason(chosen.id), [{ reason_id: damaged.id, reason_name: 'Uszkodzony w transporcie', actor_id: a.user }], 'snapshot name kept');
  // Another company's reason is not visible to A's case (RLS): 404, no case.
  const bReason = ok(await call({ owner: b }, 'POST', '/api/return-reasons', { name: 'Powód firmy B' }), 201);
  refused(await call({ owner: a }, 'POST', `/api/orders/${x.local}/returns`, body({ reason_id: bReason.id })), 404);
  // A buyer actor (no user) cannot attach a dictionary reason.
  await assert.rejects(tenantTx(a.tenant, c => requestReturn(c, { tenantId: a.tenant, userId: null, source: 'system' }, x.local,
    returnInput.parse(body({ reason_id: damaged.id })))), (e: any) => e.status === 422);
  // The chosen reason is immutable in the database.
  await assert.rejects(pool.query('DELETE FROM return_case_reasons223 WHERE return_id=$1', [chosen.id]), /immutable/);
});

test('Base: getOrderReturnReasonsList lists active reasons; addOrderReturn return_reason_id → native choice; getOrderReturns reads it back', async () => {
  const list = baseOk(await base(keys.aRead, 'getOrderReturnReasonsList', {}));
  assert.deepEqual(list.return_reasons, [{ return_reason_id: Number(damaged.p), name: 'Uszkodzenie w transporcie' }]);
  assert.deepEqual(baseOk(await base(keys.b, 'getOrderReturnReasonsList', {})).return_reasons.map((r: any) => r.name), ['Powód firmy B']);
  const x = await shippedOrder(a, keys.a);
  const line = { storage: 'db', product_id: String(x.pid), price_brutto: 25.5, quantity: 1 };
  const ret = (reason: unknown) => ({ order_id: x.order, admin_comments: 'Klient zgłasza uszkodzenie', email: 'base@example.com', products: [{ ...line, return_reason_id: reason }] });
  baseRefused(await base(keys.a, 'addOrderReturn', ret(Number(size.public_id))), 422);
  baseRefused(await base(keys.a, 'addOrderReturn', ret(2147483000)), 404);
  const bPublic = Number((await reasonRows(b.tenant))[0].p);
  baseRefused(await base(keys.a, 'addOrderReturn', ret(bPublic)), 404);
  assert.equal((await pool.query('SELECT count(*)::int n FROM return_cases WHERE order_id=$1', [x.local])).rows[0].n, 0);
  const created = baseOk(await base(keys.a, 'addOrderReturn', ret(String(damaged.p))));
  const id = (await pool.query('SELECT id,reason FROM return_cases WHERE order_id=$1', [x.local])).rows[0];
  assert.equal(created.return_id, baseWireReturnId(id.id));
  assert.equal(id.reason, 'Klient zgłasza uszkodzenie');
  assert.deepEqual((await caseReason(id.id)).map(r => r.reason_id), [damaged.id]);
  const read = baseOk(await base(keys.aRead, 'getOrderReturns', { return_id: created.return_id }));
  assert.deepEqual(read.returns[0].products.map((p: any) => p.return_reason_id), [Number(damaged.p)]);
  const plain = baseOk(await base(keys.a, 'addOrderReturn', ret(0)));
  assert.deepEqual(baseOk(await base(keys.aRead, 'getOrderReturns', { return_id: plain.return_id })).returns[0].products.map((p: any) => p.return_reason_id), [0]);
});
