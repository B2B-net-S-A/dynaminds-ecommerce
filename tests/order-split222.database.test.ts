/** Native 222 order split on a real disposable clone: the actual session routes
 * (Fastify injection with the request actor the auth hook would set), the actual
 * Base connector.php addOrderBySplit (real developer key gate), and the native OMS
 * (createProduct, createOrder, recordPayment, transition, scan, cancelOrder). Every
 * expectation is read back from the native rows. Refusal fixtures that need a foreign
 * subsystem (document, parcel plan, merge history, return, external intent, buyer
 * address sidecar, WMS policy) are inserted directly with session_replication_role
 * =replica: the split refusal reads only the relationship, so the row is enough.
 * Root-only execution on a fresh clone dynaminds_split_20261023_NN made from the clean
 * 217 template with 218–222 by the guarded applier. The suite writes; rerun = NEW clone.
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
import { createBaseWireOrdersFamily, baseWireOrderProductId } from '../server/base-wire-orders';
import { createDefaultBaseWireOrdersService } from '../server/base-wire-orders-runtime';
import { registerOrderSplit222Routes } from '../server/order-split222-routes';
import { createProduct } from '../server/catalog';
import { createOrder, orderSchema, productSchema, transition, scan, cancelOrder, type Actor } from '../server/domain';
import { recordPayment } from '../server/payments';

assert.equal(process.env.DYNA_TEST, 'true', 'Explicit isolated test mode required');
const selected = new URL(process.env.DATABASE_URL ?? 'invalid://missing');
assert.equal(selected.hostname, '127.0.0.1');
assert.equal(selected.port, '57084');
assert.match(selected.pathname, /^\/dynaminds_split_20261023_[0-9]{2}$/);
assert.equal(selected.username, 'postgres');
pool.options.query_timeout = 9000;
const KEY_NAME = 'Isolated order split 222 test';
const ALL = ['orders:read', 'orders:write', 'inventory:read', 'inventory:write'];
type Owner = { tenant: string; user: string; warehouse: string; catalog: string; currency: string; actor: Actor };
type Key = { id: string; token: string; scopes: string[] };
let session: FastifyInstance, wire: FastifyInstance, a: Owner, b: Owner;
let keys: { all: Key; read: Key; noInventory: Key; bAll: Key };
const tag = randomBytes(4).toString('hex');
let p1: Row, p2: Row, bProduct: Row;
type Row = Record<string, any>;
let o: Record<string, string>;

async function key(owner: Owner, scopes: string[]): Promise<Key> {
  const token = 'dyna_api_' + randomBytes(32).toString('hex'), id = randomUUID();
  await pool.query(`INSERT INTO api_keys(id,tenant_id,user_id,name,token_hash,prefix,scopes,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,clock_timestamp()+interval '1 day')`, [id, owner.tenant, owner.user, KEY_NAME, tokenHash(token), token.slice(0, 16), scopes]);
  return { id, token, scopes };
}
/** The request actor the real auth hook sets: session (cookie) or API key (Bearer). */
type As = { owner: Owner; role?: Actor['role']; key?: Key; credential?: string };
function call(as: As, method: 'GET' | 'POST', url: string, payload?: unknown) {
  const headers: Record<string, string> = { 'x-test-as': JSON.stringify({ tenant: as.owner.tenant, user: as.owner.user, role: as.role ?? 'admin',
    key: as.key ? { id: as.key.id, scopes: as.key.scopes } : null }) };
  if (as.key) headers.authorization = 'Bearer ' + (as.credential ?? as.key.token);
  return session.inject({ method, url, headers, ...(payload === undefined ? {} : { payload: payload as any }) });
}
async function base(k: Key, method: string, parameters: unknown, headers: Record<string, string> = {}) {
  return wire.inject({ method: 'POST', url: '/connector.php', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-bltoken': k.token, ...headers },
    payload: new URLSearchParams({ method, parameters: JSON.stringify(parameters) }).toString() });
}
const ok = (r: any, status: number) => { assert.equal(r.statusCode, status, r.body); return r.json(); };
const refused = (r: any, status: number, pattern?: RegExp) => {
  assert.equal(r.statusCode, status, r.body); assert(!/SELECT |stack|dyna_api_/.test(r.body), r.body);
  if (pattern) assert.match(r.json().error, pattern); return r.json();
};
const baseOk = (r: any) => { assert.equal(r.statusCode, 200, r.body); const d = r.json(); assert.equal(d.status, 'SUCCESS', r.body); return d; };
const baseRefused = (r: any, status: number) => { assert.equal(r.statusCode, status, r.body); const d = r.json(); assert.equal(d.status, 'ERROR', r.body); return d; };
const items = async (order: string) => (await pool.query('SELECT id,product_id,quantity,price,line_total,scanned FROM order_items WHERE order_id=$1 ORDER BY product_id,id', [order])).rows;
const picks = async (order: string) => (await pool.query('SELECT product_id,quantity,scanned FROM order_pick_items WHERE order_id=$1 ORDER BY product_id', [order])).rows;
const reservations = async (order: string) => (await pool.query('SELECT product_id,quantity,state FROM reservations WHERE order_id=$1 ORDER BY product_id', [order])).rows;
const located = async (order: string) => (await pool.query('SELECT product_id,sum(quantity)::int q FROM reservation_locations WHERE order_id=$1 GROUP BY product_id ORDER BY product_id', [order])).rows;
const header = async (order: string) => (await pool.query('SELECT * FROM orders WHERE id=$1', [order])).rows[0];
const stock = async (product: string, warehouse: string) => (await pool.query('SELECT on_hand,reserved FROM stock WHERE product_id=$1 AND warehouse_id=$2', [product, warehouse])).rows[0];
const evidence = async (order: string) => (await pool.query('SELECT (SELECT count(*)::int FROM order_split222_previews WHERE parent_order_id=$1) previews,(SELECT count(*)::int FROM order_split222_executions WHERE parent_order_id=$1) executions', [order])).rows[0];
const facts = async (order: string) => ({ header: await header(order), items: await items(order), picks: await picks(order), reservations: await reservations(order),
  located: await located(order), evidence: await evidence(order) });
/** Direct fixture row of a foreign subsystem; triggers and FK checks are skipped on purpose. */
async function replica(sql: string, values: unknown[]) {
  const c = await pool.connect();
  try { await c.query("SET session_replication_role='replica'"); await c.query(sql, values); }
  finally { await c.query("SET session_replication_role='origin'"); c.release(); }
}
const line = (order: Row, product: string) => order.items.find((i: Row) => i.product_id === product);

before(async () => {
  for (const name of ['order_split222_previews', 'order_split222_executions', 'order_split222_targets', 'base_wire220_order_ids'])
    assert.notEqual((await pool.query('SELECT to_regclass($1) n', ['public.' + name])).rows[0].n, null, 'Clone needs committed 222: ' + name);
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
  const owner = (r: Row): Owner => ({ tenant: r.tenant_id, user: r.user_id, warehouse: r.warehouse, catalog: r.catalog, currency: r.currency,
    actor: { tenantId: r.tenant_id, userId: r.user_id, role: 'admin', source: 'manual' } });
  a = owner(rows[0]); b = owner(rows[1]);
  keys = { all: await key(a, ALL), read: await key(a, ['orders:read', 'inventory:read']), noInventory: await key(a, ['orders:read', 'orders:write', 'inventory:read']),
    bAll: await key(b, ALL) };
  // One native transaction per company: products (on_hand 50) and every order of the suite.
  const order = (c: any, owner: Owner, lines: [string, number][], extra: Row = {}) => createOrder(c, owner.actor, orderSchema.parse({
    customer_name: 'Klient Split', email: `split-${tag}@example.com`, warehouse_id: owner.warehouse, currency: owner.currency,
    address: { street: 'Prosta 1', city: 'Warszawa', postal_code: '00-001', country: 'PL', phone: '500600700' },
    items: lines.map(([product_id, quantity]) => ({ product_id, quantity })), ...extra }), undefined, { fieldSource: 'manual' }).then(x => x.id as string);
  o = await tenantTx(a.tenant, async c => {
    p1 = await createProduct(c, a.actor, productSchema.parse({ name: 'Kubek ' + tag, sku: 'SPL-1-' + tag, price: 1999, vat: 23, catalog_id: a.catalog, warehouse_id: a.warehouse, quantity: 50 }));
    p2 = await createProduct(c, a.actor, productSchema.parse({ name: 'Talerz ' + tag, sku: 'SPL-2-' + tag, price: 2999, vat: 23, catalog_id: a.catalog, warehouse_id: a.warehouse, quantity: 50 }));
    const both = (extra: Row = {}) => order(c, a, [[p1.id, 3], [p2.id, 2]], { shipping_cost: 1500, ...extra });
    const ids: Record<string, string> = { main: await both({ payment_mode: 'cod' }), wire: await order(c, a, [[p1.id, 2]], { shipping_cost: 1000 }) };
    for (const name of ['pay', 'doc', 'parcel', 'merge', 'ret', 'ext', 'addr', 'picking', 'shape']) ids[name] = await both({ payment_mode: name === 'picking' ? 'cod' : 'prepaid' });
    const version = Number((await c.query('SELECT version FROM orders WHERE id=$1', [ids.pay])).rows[0].version);
    await recordPayment(c, a.actor, ids.pay, { client_key: randomUUID(), version, kind: 'receipt', amount: 100, fee: 0, currency: a.currency, method: 'bank_transfer',
      reference: 'Częściowa wpłata', note: '', confirmed: true } as any);
    await transition(c, a.actor, ids.picking, 'picking');
    return ids;
  });
  const bIds = await tenantTx(b.tenant, async c => {
    bProduct = await createProduct(c, b.actor, productSchema.parse({ name: 'Obcy ' + tag, sku: 'SPL-B-' + tag, price: 999, vat: 23, catalog_id: b.catalog, warehouse_id: b.warehouse, quantity: 10 }));
    return { bOrder: await order(c, b, [[bProduct.id, 2]]) };
  });
  o = { ...o, ...bIds };
  session = Fastify();
  session.decorateRequest('actor');session.decorateRequest('currentUser');session.decorateRequest('apiScopes');
  session.addHook('onRequest', async (req: any) => {
    const as = JSON.parse(String(req.headers['x-test-as']));
    req.actor = { tenantId: as.tenant, userId: as.user, role: as.role, ...(as.key ? { apiKeyId: as.key.id, source: 'api' } : {}) };
    req.currentUser = { id: as.user, tenant_id: as.tenant, role: as.role, ...(as.key ? { api_key_id: as.key.id } : {}) };
    req.apiScopes = as.key ? as.key.scopes : undefined;
  });
  session.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof Problem) return reply.code(err.status).send({ error: err.message });
    if (err instanceof z.ZodError) return reply.code(422).send({ error: err.issues.map(i => i.message).join('; ') });
    // Unexpected failures are a test failure: keep the cause visible in the TAP output.
    process.stderr.write('UNEXPECTED ' + String(err?.code ?? '') + ' ' + String(err?.message ?? err) + '\n');
    return reply.code(500).send({ error: 'Nieoczekiwany błąd serwera' });
  });
  registerOrderSplit222Routes(session, { available: true, readOnly: false });
  await session.ready();
  wire = Fastify();
  registerBaseWireRoutes(wire, { readOnly: false, families: [createBaseWireOrdersFamily({ available: true,
    service: createDefaultBaseWireOrdersService({ readOnly: false, mergeClaims: true, orderSplits: true }) })],
    authenticate: (token, scope) => authenticateBaseWireApiKey(token, scope, true) });
  await wire.ready();
});
after(async () => { await session?.close(); await wire?.close(); await pool.end(); });

test('session split moves the selected quantities exactly; totals, picks, reservations and locations reconcile; replay returns the same child', async () => {
  const parent = o.main, before = await facts(parent), stockBefore = [await stock(p1.id, a.warehouse), await stock(p2.id, a.warehouse)];
  assert.equal(before.header.total, 3 * 1999 + 2 * 2999 + 1500);
  const l1 = line(before, p1.id), l2 = line(before, p2.id), clientKey = randomUUID();
  const body = { client_key: clientKey, items: [{ item_id: l1.id, quantity: 1 }, { item_id: l2.id, quantity: 2 }], shipping_cost_to_child: 500 };
  const first = ok(await call({ owner: a }, 'POST', `/api/orders/${parent}/splits/previews`, body), 201);
  const p = first.preview;
  assert.equal(first.reused, false); assert.equal(first.can_split, true);
  assert.deepEqual([p.parent_total_before, p.child_total, p.parent_total_after, p.child_shipping_cost, p.parent_shipping_cost_after],
    [before.header.total, 1999 + 2 * 2999 + 500, before.header.total - (1999 + 2 * 2999 + 500), 500, 1000]);
  assert.deepEqual(p.lines.map((x: Row) => [x.item_id, x.move_quantity, x.parent_quantity_after, x.child_line_total, x.parent_line_total_after]).sort(),
    [[l1.id, 1, 2, 1999, 3998], [l2.id, 2, 0, 5998, 0]].sort());
  // A preview changes no native row.
  assert.deepEqual({ ...(await facts(parent)), evidence: undefined }, { ...before, evidence: undefined });
  // Exact replay of the preview: same preview; the same key with another body is refused.
  const again = ok(await call({ owner: a }, 'POST', `/api/orders/${parent}/splits/previews`, body), 200);
  assert.equal(again.reused, true); assert.equal(again.preview.id, p.id);
  refused(await call({ owner: a }, 'POST', `/api/orders/${parent}/splits/previews`, { ...body, shipping_cost_to_child: 400 }), 409, /Klucz został użyty/);
  // Execute with a different scope is refused without effect.
  refused(await call({ owner: a }, 'POST', `/api/order-splits/${p.id}/execute`, { client_key: randomUUID(), scope_hash: 'f'.repeat(64) }), 409, /inny zakres/);
  const executeKey = randomUUID();
  const done = ok(await call({ owner: a }, 'POST', `/api/order-splits/${p.id}/execute`, { client_key: executeKey, scope_hash: p.scope_hash }), 201);
  const e = done.execution, child = e.child_order_id;
  assert.equal(done.reused, false); assert.equal(e.parent_order_id, parent); assert.notEqual(child, parent);
  // Parent keeps P1×2 (and its shipping 1000); the full P2 line moved.
  const pa = await facts(parent), ch = await facts(child);
  assert.deepEqual(pa.items.map((i: Row) => [i.id, i.product_id, i.quantity, i.price, i.line_total]), [[l1.id, p1.id, 2, 1999, 3998]]);
  assert.deepEqual(ch.items.map((i: Row) => [i.product_id, i.quantity, i.price, i.line_total]).sort(), [[p1.id, 1, 1999, 1999], [p2.id, 2, 2999, 5998]].sort());
  assert.equal(pa.header.total + ch.header.total, before.header.total, 'parent + child = original total (grosze)');
  assert.deepEqual([pa.header.total, pa.header.shipping_cost, ch.header.total, ch.header.shipping_cost], [3998 + 1000, 1000, 1999 + 5998 + 500, 500]);
  assert.equal(Number(pa.header.version) > Number(before.header.version), true);
  assert.deepEqual(pa.picks, [{ product_id: p1.id, quantity: 2, scanned: 0 }]);
  assert.deepEqual(ch.picks, [{ product_id: p1.id, quantity: 1, scanned: 0 }, { product_id: p2.id, quantity: 2, scanned: 0 }].sort((x, y) => x.product_id.localeCompare(y.product_id)));
  assert.deepEqual(pa.reservations, [{ product_id: p1.id, quantity: 2, state: 'active' }]);
  assert.deepEqual(ch.reservations, ch.picks.map((x: Row) => ({ product_id: x.product_id, quantity: x.quantity, state: 'active' })));
  assert.deepEqual(pa.located, [{ product_id: p1.id, q: 2 }]);
  assert.deepEqual(ch.located, ch.picks.map((x: Row) => ({ product_id: x.product_id, q: x.quantity })));
  // stock.reserved is unchanged: the reservation moved between orders.
  assert.deepEqual([await stock(p1.id, a.warehouse), await stock(p2.id, a.warehouse)], stockBefore);
  // The child inherits the business header with its own identity, number and totals.
  for (const k of ['customer_name', 'email', 'address', 'currency', 'payment_mode', 'status', 'warehouse_id', 'note', 'tags', 'fulfillment_kind'])
    assert.deepEqual(ch.header[k], pa.header[k], k);
  assert.deepEqual([ch.header.source, ch.header.number, ch.header.channel_id, ch.header.external_id], ['order_split', pa.header.number + '-S1', null, null]);
  assert.notEqual(ch.header.portal_token, pa.header.portal_token);
  assert.equal((await pool.query('SELECT count(*)::int n FROM base_wire220_order_ids WHERE local_id=$1', [child])).rows[0].n, 1, 'child has its 220 identity');
  // Evidence and lineage.
  assert.deepEqual(e.targets.map((t: Row) => [t.source_item_id, t.quantity, t.line_total, t.parent_quantity_after]).sort(), [[l1.id, 1, 1999, 2], [l2.id, 2, 5998, 0]].sort());
  assert.deepEqual(ch.items.map((i: Row) => i.id).sort(), e.targets.map((t: Row) => t.target_item_id).sort());
  assert.deepEqual((await pool.query("SELECT order_id=$1 AS parent,kind FROM order_events WHERE order_id=ANY($2::uuid[]) AND detail->>'execution_id'=$3 ORDER BY kind",
    [parent, [parent, child], e.id])).rows, [{ parent: false, kind: 'order.created' }, { parent: true, kind: 'order.split' }]);
  // Replay of the execute: the same child, no second child; a second key on the same preview is refused.
  const replay = ok(await call({ owner: a }, 'POST', `/api/order-splits/${p.id}/execute`, { client_key: executeKey, scope_hash: p.scope_hash }), 200);
  assert.equal(replay.reused, true); assert.equal(replay.execution.child_order_id, child);
  refused(await call({ owner: a }, 'POST', `/api/order-splits/${p.id}/execute`, { client_key: randomUUID(), scope_hash: p.scope_hash }), 409, /już wykonano/);
  assert.deepEqual(await evidence(parent), { previews: 1, executions: 1 });
  assert.equal((await pool.query('SELECT count(*)::int n FROM orders WHERE number LIKE $1', [pa.header.number + '-S%'])).rows[0].n, 1);
  // Reads: preview (with its execution), execution, lineage of both orders.
  assert.equal(ok(await call({ owner: a }, 'GET', `/api/order-splits/previews/${p.id}`), 200).preview.execution_id, e.id);
  assert.equal(ok(await call({ owner: a, role: 'viewer' }, 'GET', `/api/order-splits/executions/${e.id}`), 200).execution.child_order_id, child);
  assert.deepEqual(ok(await call({ owner: a }, 'GET', `/api/orders/${parent}/splits`), 200).children.map((x: Row) => x.id), [e.id]);
  assert.equal(ok(await call({ owner: a }, 'GET', `/api/orders/${child}/splits`), 200).origin.id, e.id);
  // The child's buyer-address installation leaves the module guard true; the evidence is append-only.
  assert.equal((await pool.query('SELECT public.buyer_address_guards() v')).rows[0].v, true);
  await assert.rejects(pool.query('UPDATE order_split222_executions SET child_total=0 WHERE id=$1', [e.id]), /immutable/);
  await assert.rejects(pool.query('DELETE FROM order_split222_targets WHERE execution_id=$1', [e.id]), /immutable/);
});

test('a split child is picked natively and cancelling the split parent releases only its own reservation', async () => {
  const child = (await pool.query('SELECT child_order_id FROM order_split222_executions WHERE parent_order_id=$1', [o.main])).rows[0].child_order_id;
  const before = await stock(p1.id, a.warehouse);
  // COD child: new -> picking, then every unit scanned through its moved locations.
  await tenantTx(a.tenant, async c => {
    await transition(c, a.actor, child, 'picking');
    await scan(c, a.actor, child, p1.sku);
    for (let i = 0; i < 2; i++) await scan(c, a.actor, child, p2.sku);
  });
  assert.deepEqual((await picks(child)).map(x => x.scanned === x.quantity), [true, true]);
  assert.deepEqual((await items(child)).map(x => x.scanned === x.quantity), [true, true]);
  assert.equal((await pool.query('SELECT sum(scanned)::int s FROM reservation_locations WHERE order_id=$1', [child])).rows[0].s, 3);
  // Cancel the parent: only its 2 reserved units are released; the child stays reserved.
  await tenantTx(a.tenant, c => cancelOrder(c, a.actor, o.main));
  assert.equal((await header(o.main)).status, 'cancelled');
  assert.deepEqual(await stock(p1.id, a.warehouse), { on_hand: before.on_hand, reserved: before.reserved - 2 });
  assert.deepEqual(await reservations(o.main), [{ product_id: p1.id, quantity: 2, state: 'released' }]);
  assert.deepEqual((await reservations(child)).map(r => r.state), ['active', 'active']);
});

test('Base addOrderBySplit runs the native split, returns the child 220 order ID once per Idempotency-Key', async () => {
  const parent = o.wire, before = await facts(parent);
  // getOrders allocates the parent's numeric ID and exposes the derived order_product_id.
  const listed = baseOk(await base(keys.all, 'getOrders', { date_confirmed_from: Math.floor(new Date(before.header.created_at).getTime() / 1000) })).orders;
  const orderId = Number((await pool.query('SELECT public_id::text p FROM base_wire220_order_ids WHERE local_id=$1', [parent])).rows[0].p);
  const dto = listed.find((x: Row) => x.order_id === orderId);
  assert.equal(dto.products[0].order_product_id, baseWireOrderProductId(before.items[0].id));
  const parameters = { order_id: orderId, items_to_split: [{ order_product_id: dto.products[0].order_product_id, quantity: 1 }], delivery_cost_to_split: 4.5 };
  // Read-only key and a key without inventory:write: refused, nothing changes.
  baseRefused(await base(keys.read, 'addOrderBySplit', parameters), 403);
  baseRefused(await base(keys.noInventory, 'addOrderBySplit', parameters), 403);
  baseRefused(await base(keys.bAll, 'addOrderBySplit', parameters), 404);
  assert.deepEqual(await facts(parent), before);
  const idem = randomUUID();
  const first = baseOk(await base(keys.all, 'addOrderBySplit', parameters, { 'idempotency-key': idem }));
  assert.deepEqual(Object.keys(first).sort(), ['new_order_id', 'status']);
  const child = (await pool.query('SELECT local_id FROM base_wire220_order_ids WHERE public_id=$1', [first.new_order_id])).rows[0].local_id;
  const pa = await facts(parent), ch = await facts(child);
  assert.deepEqual(pa.items.map((i: Row) => [i.quantity, i.line_total]), [[1, 1999]]);
  assert.deepEqual(ch.items.map((i: Row) => [i.product_id, i.quantity, i.line_total]), [[p1.id, 1, 1999]]);
  assert.deepEqual([pa.header.total, pa.header.shipping_cost, ch.header.total, ch.header.shipping_cost], [1999 + 550, 550, 1999 + 450, 450]);
  assert.equal(pa.header.total + ch.header.total, before.header.total);
  assert.deepEqual([pa.reservations, ch.reservations], [[{ product_id: p1.id, quantity: 1, state: 'active' }], [{ product_id: p1.id, quantity: 1, state: 'active' }]]);
  assert.equal((await pool.query('SELECT api_key_id FROM order_split222_executions WHERE child_order_id=$1', [child])).rows[0].api_key_id, keys.all.id);
  // Lost-ACK retry with the same Idempotency-Key and body: the same child, no second split.
  assert.deepEqual(baseOk(await base(keys.all, 'addOrderBySplit', parameters, { 'idempotency-key': idem })), first);
  assert.deepEqual(await evidence(parent), { previews: 1, executions: 1 });
  // Base read of both orders.
  const after = baseOk(await base(keys.all, 'getOrders', { order_id: first.new_order_id })).orders[0];
  assert.deepEqual([after.delivery_price, after.products.map((x: Row) => x.quantity), after.delivery_fullname], [4.5, [1], 'Klient Split']);
  // The parent cannot give away its last unit (an empty source order is refused).
  baseRefused(await base(keys.all, 'addOrderBySplit', { order_id: orderId, items_to_split: [{ order_product_id: dto.products[0].order_product_id, quantity: 1 }] }), 422);
});

test('each refusal answers 409 (or 4xx for an invalid plan) with no effect', async () => {
  await replica("INSERT INTO documents(id,tenant_id,order_id,number,kind,mode,data) VALUES($1,$2,$3,$4,'proforma','local','{}')", [randomUUID(), a.tenant, o.doc, 'PRO-' + tag]);
  await replica("INSERT INTO order_parcel_plans(id,tenant_id,order_id,preview_id,actor_id,client_key,request_hash,scope_hash,request,payload) VALUES($1,$2,$3,$4,$5,$6,$7,$7,'{}','{}')",
    [randomUUID(), a.tenant, o.parcel, randomUUID(), a.user, randomUUID(), 'a'.repeat(64)]);
  await replica("INSERT INTO order_merge_claims(tenant_id,source_order_id,target_order_id,execution_id,merge_mode) VALUES($1,$2,$3,$4,'technical_merge')", [a.tenant, randomUUID(), o.merge, randomUUID()]);
  await replica("INSERT INTO return_cases(id,tenant_id,order_id,warehouse_id,number,kind,reason) VALUES($1,$2,$3,$4,$5,'return','Zwrot')", [randomUUID(), a.tenant, o.ret, a.warehouse, 'RET-' + tag]);
  await replica("INSERT INTO b2b_external_order_intents(tenant_id,id,order_id,actor_id,client_key,request_hash,initial_request,original_items,allocations) VALUES($1,$2,$3,$4,$5,$6,'{}','[{}]','[{}]')",
    [a.tenant, randomUUID(), o.ext, a.user, randomUUID(), 'a'.repeat(64)]);
  await replica('INSERT INTO buyer_address_state(tenant_id,order_id,version,delivery_version,enabled,last_receipt_id,updated_at) VALUES($1,$2,1,0,false,$3,clock_timestamp())', [a.tenant, o.addr, randomUUID()]);
  const cases: [string, RegExp][] = [['pay', /płatności/], ['doc', /dokumenty/], ['parcel', /plan paczek/], ['merge', /łączenia/], ['ret', /zwroty/], ['ext', /zewnętrzne/],
    ['addr', /adres dostawy/], ['picking', /nowego lub opłaconego/]];
  for (const [name, reason] of cases) {
    const before = await facts(o[name]), first = before.items[0];
    refused(await call({ owner: a }, 'POST', `/api/orders/${o[name]}/splits/previews`, { client_key: randomUUID(), items: [{ item_id: first.id, quantity: 1 }] }), 409, reason);
    assert.deepEqual(await facts(o[name]), before, name + ': no effect');
  }
  // Invalid plans on an eligible order: no preview, no change.
  const shape = await facts(o.shape), [s1, s2] = shape.items;
  const plan = (body: Row) => call({ owner: a }, 'POST', `/api/orders/${o.shape}/splits/previews`, { client_key: randomUUID(), ...body });
  refused(await plan({ items: [{ item_id: s1.id, quantity: s1.quantity }, { item_id: s2.id, quantity: s2.quantity }] }), 422, /co najmniej jedną pozycję/);
  refused(await plan({ items: [{ item_id: s1.id, quantity: s1.quantity + 1 }] }), 422, /przekracza ilość/);
  refused(await plan({ items: [{ item_id: randomUUID(), quantity: 1 }] }), 404);
  refused(await plan({ items: [{ item_id: s1.id, quantity: 1 }], shipping_cost_to_child: 1501 }), 422, /dostawa/);
  refused(await plan({ items: [{ item_id: s1.id, quantity: 1 }, { item_id: s1.id, quantity: 1 }] }), 422);
  refused(await plan({ items: [] }), 422);
  assert.deepEqual(await facts(o.shape), shape);
  // A preview whose order changed afterwards cannot be executed.
  const stale = ok(await plan({ items: [{ item_id: s1.id, quantity: 1 }] }), 201).preview;
  await tenantTx(a.tenant, async c => recordPayment(c, a.actor, o.shape, { client_key: randomUUID(), version: Number((await header(o.shape)).version), kind: 'receipt', amount: 100, fee: 0,
    currency: a.currency, method: 'bank_transfer', reference: 'Wpłata po podglądzie', note: '', confirmed: true } as any));
  const changed = await facts(o.shape);
  refused(await call({ owner: a }, 'POST', `/api/order-splits/${stale.id}/execute`, { client_key: randomUUID(), scope_hash: stale.scope_hash }), 409);
  assert.deepEqual(await facts(o.shape), changed);
});

test('foreign tenant isolated; viewer, read-only key and a wrong credential refused', async () => {
  const first = (await items(o.shape))[0], body = () => ({ client_key: randomUUID(), items: [{ item_id: first.id, quantity: 1 }] });
  const before = await facts(o.shape);
  refused(await call({ owner: b }, 'POST', `/api/orders/${o.shape}/splits/previews`, body()), 404);
  refused(await call({ owner: a, role: 'viewer' }, 'POST', `/api/orders/${o.shape}/splits/previews`, body()), 403);
  refused(await call({ owner: a, key: keys.read }, 'POST', `/api/orders/${o.shape}/splits/previews`, body()), 403, /scope/);
  refused(await call({ owner: a, key: keys.noInventory }, 'POST', `/api/orders/${o.shape}/splits/previews`, body()), 403, /inventory:write/);
  refused(await call({ owner: a, key: keys.all, credential: 'dyna_api_' + 'a'.repeat(64) }, 'POST', `/api/orders/${o.shape}/splits/previews`, body()), 401);
  assert.deepEqual(await facts(o.shape), before);
  const preview = (await pool.query('SELECT id FROM order_split222_previews WHERE parent_order_id=$1', [o.shape])).rows[0].id;
  refused(await call({ owner: b }, 'GET', `/api/order-splits/previews/${preview}`), 404);
  refused(await call({ owner: b }, 'GET', `/api/orders/${o.shape}/splits`), 404);
  // A full-scope API key (the /api/v1 path) may read the preview.
  assert.equal(ok(await call({ owner: a, key: keys.all }, 'GET', `/api/order-splits/previews/${preview}`), 200).preview.id, preview);
});

test('a company with WMS lots enabled is refused with 409 and no effect', async () => {
  const before = await facts(o.bOrder);
  await replica("INSERT INTO wms_policies(tenant_id,enabled,version,method,currency,exponent,opening_operation_id) VALUES($1,true,1,'FIFO',$2,2,$3)", [b.tenant, b.currency, randomUUID()]);
  refused(await call({ owner: b }, 'POST', `/api/orders/${o.bOrder}/splits/previews`, { client_key: randomUUID(), items: [{ item_id: before.items[0].id, quantity: 1 }] }), 409, /partiach WMS/);
  assert.deepEqual(await facts(o.bOrder), before);
});
