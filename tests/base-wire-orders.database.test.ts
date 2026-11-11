/** Real Fastify injection + real developer key gate + real 220 sidecars + the
 * native OMS (createOrder, payments, set_workflow). Root-only execution on a fresh
 * disposable clone dynaminds_wireorders_20261023_NN made from the clean 217+218+219
 * template with 220 applied by the guarded applier (nine native guards before and
 * after). The suite writes orders, so a rerun requires a NEW clone (a wireret clone
 * of the same recipe is accepted too).
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { pool, tenantTx } from '../server/db';
import { tokenHash } from '../server/security';
import { authenticateBaseWireApiKey } from '../server/developer-api';
import { registerBaseWireRoutes } from '../server/base-wire-routes';
import { createBaseWireOrdersFamily, baseWireStageStatusId, BASE_WIRE_STAGE_STATUSES } from '../server/base-wire-orders';
import { createDefaultBaseWireOrdersService } from '../server/base-wire-orders-runtime';
import { createProduct } from '../server/catalog';
import { createOrder, orderSchema, productSchema, type Actor } from '../server/domain';
import { paymentBalance } from '../server/payments';

assert.equal(process.env.DYNA_TEST, 'true', 'Explicit isolated test mode required');
const selected = new URL(process.env.DATABASE_URL ?? 'invalid://missing');
assert.equal(selected.hostname, '127.0.0.1');
assert.equal(selected.port, '57084');
assert.match(selected.pathname, /^\/dynaminds_wire(orders|ret)_20261023_[0-9]{2}$/);
assert.equal(selected.username, 'postgres');
pool.options.query_timeout = 9000;
type Owner = { tenant: string; user: string; catalog: string; warehouse: string; currency: string; token: string; actor: Actor };
let app: ReturnType<typeof Fastify>, a: Owner, b: Owner, writeOnly: Owner;
async function key(row: { tenant_id: string; user_id: string; catalog: string; warehouse: string; currency: string }, scopes: string[]): Promise<Owner> {
  const token = 'dyna_api_' + randomBytes(32).toString('hex'), id = randomUUID();
  await pool.query(`INSERT INTO api_keys(id,tenant_id,user_id,name,token_hash,prefix,scopes,expires_at)
    VALUES($1,$2,$3,'Isolated wire orders test',$4,$5,$6,clock_timestamp()+interval '1 day')`, [id, row.tenant_id, row.user_id, tokenHash(token), token.slice(0, 16), scopes]);
  return { tenant: row.tenant_id, user: row.user_id, catalog: row.catalog, warehouse: row.warehouse, currency: row.currency, token,
    actor: { tenantId: row.tenant_id, userId: row.user_id, role: 'admin', source: 'manual' } };
}
async function wire(owner: Owner, method: string, parameters: unknown, headers: Record<string, string> = {}) {
  return app.inject({ method: 'POST', url: '/connector.php',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-bltoken': owner.token, ...headers },
    payload: new URLSearchParams({ method, parameters: JSON.stringify(parameters) }).toString() });
}
const success = (r: any) => { assert.equal(r.statusCode, 200, r.body); const d = r.json(); assert.equal(d.status, 'SUCCESS', r.body); return d; };
const refused = (r: any, status: number) => { assert.equal(r.statusCode, status, r.body); const d = r.json(); assert.equal(d.status, 'ERROR');
  assert.deepEqual(Object.keys(d).sort(), ['error_code','error_message','status']); assert(!/SELECT |stack|dyna_api_/.test(r.body)); return d; };
const publicId = async (table: string, tenant: string, local: string) =>
  Number((await pool.query(`SELECT public_id::text p FROM ${table} WHERE tenant_id=$1 AND local_id=$2`, [tenant, local])).rows[0]?.p);
const localOrder = async (tenant: string, publicOrder: number) =>
  (await pool.query('SELECT local_id FROM base_wire220_order_ids WHERE tenant_id=$1 AND public_id=$2', [tenant, publicOrder])).rows[0]?.local_id as string|undefined;
const stockOf = async (product: string, warehouse: string) =>
  (await pool.query('SELECT on_hand,reserved FROM stock WHERE product_id=$1 AND warehouse_id=$2', [product, warehouse])).rows[0];
const orderCount = async (tenant: string) => (await pool.query('SELECT count(*)::int n FROM orders WHERE tenant_id=$1', [tenant])).rows[0].n as number;
async function nativeProduct(o: Owner, sku: string, quantity: number) {
  return tenantTx(o.tenant, c => createProduct(c, o.actor, productSchema.parse({ name: 'Produkt ' + sku, sku, price: 1999, vat: 23, catalog_id: o.catalog, warehouse_id: o.warehouse, quantity })));
}
/** Same path as POST /api/orders from the UI (session actor, catalog pricing). */
async function nativeOrder(o: Owner, product: string) {
  return tenantTx(o.tenant, c => createOrder(c, o.actor, orderSchema.parse({ customer_name: 'Klient natywny', email: 'native@example.com', warehouse_id: o.warehouse,
    currency: o.currency, items: [{ product_id: product, quantity: 1 }] }), undefined, { fieldSource: 'manual' }));
}
async function nativeStatus(o: Owner, name: string, stage: string) {
  return tenantTx(o.tenant, async c => (await c.query('INSERT INTO workflow_statuses(id,tenant_id,name,color,stage,active) VALUES($1,$2,$3,$4,$5,true) RETURNING id',
    [randomUUID(), o.tenant, name, '#1c8752', stage])).rows[0].id as string);
}
const baseOrder = (o: Owner, product: number, warehouse: number, extra: Record<string, unknown> = {}) => ({
  delivery_fullname: 'Jan Base', email: 'base@example.com', phone: '500600700', delivery_address: 'Prosta 1', delivery_postcode: '00-001',
  delivery_city: 'Warszawa', delivery_country_code: 'PL', currency: o.currency, delivery_price: 10, user_comments: '', invoice_nip: '',
  products: [{ storage: 'db', storage_id: 0, product_id: String(product), variant_id: 0, warehouse_id: warehouse, price_brutto: 25.5, tax_rate: 23, quantity: 2 }],
  ...extra });

before(async () => {
  for (const name of ['base_wire220_order_ids', 'base_wire220_order_status_ids', 'base_wire220_product_ids', 'base_wire220_warehouse_ids'])
    assert.notEqual((await pool.query('SELECT to_regclass($1) n', ['public.' + name])).rows[0].n, null, 'Clone needs committed 220: ' + name);
  assert.equal((await pool.query("SELECT count(*)::int n FROM api_keys WHERE name='Isolated wire orders test'")).rows[0].n, 0, 'Fresh clone required; no rerun');
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
  a = await key(rows[0], ['orders:read', 'orders:write']); b = await key(rows[1], ['orders:read', 'orders:write']);
  writeOnly = await key(rows[0], ['orders:write']);
  app = Fastify();
  registerBaseWireRoutes(app, { readOnly: false, families: [createBaseWireOrdersFamily({ available: true, service: createDefaultBaseWireOrdersService({ readOnly: false, mergeClaims: true }) })],
    authenticate: (token, scope) => authenticateBaseWireApiKey(token, scope, true) });
  await app.ready();
});
after(async () => { await app?.close(); await pool.end(); });

test('a native (UI/REST) order without an ID yet appears in getOrders with the same numeric order_id', async () => {
  const p = await nativeProduct(a, 'WO-N-' + randomBytes(4).toString('hex'), 10);
  const order = await nativeOrder(a, p.id);
  assert.equal((await pool.query('SELECT count(*)::int n FROM base_wire220_order_ids WHERE local_id=$1', [order.id])).rows[0].n, 0, 'orders have no insert trigger');
  const got = success(await wire(a, 'getOrders', { date_confirmed_from: Math.floor(new Date(order.created_at).getTime() / 1000) })).orders;
  const id = await publicId('base_wire220_order_ids', a.tenant, order.id);
  assert(Number.isSafeInteger(id) && id > 0);
  const dto = got.find((x: any) => x.order_id === id);
  assert(dto, 'native order listed');
  assert.equal(dto.delivery_fullname, 'Klient natywny'); assert.equal(dto.email, 'native@example.com'); assert.equal(dto.order_source, 'personal');
  assert.equal(dto.products.length, 1); assert.equal(dto.products[0].product_id, String(await publicId('base_wire220_product_ids', a.tenant, p.id)));
  assert.equal(dto.products[0].price_brutto, 19.99); assert.equal(dto.payment_done, 0); assert.equal(dto.order_status_id, baseWireStageStatusId('new'));
  assert.equal(dto.products[0].warehouse_id, await publicId('base_wire220_warehouse_ids', a.tenant, a.warehouse));
  assert(!JSON.stringify(got).includes(order.id), 'numeric identities only');
  // The single-order read returns the same identity; the second tenant does not see it.
  assert.deepEqual(success(await wire(a, 'getOrders', { order_id: id })).orders.map((x: any) => x.order_id), [id]);
  assert.deepEqual(success(await wire(b, 'getOrders', { order_id: id })).orders, []);
});

test('addOrder(paid=1) creates one fully paid native order with native reservations; replay adds nothing', async () => {
  const p = await nativeProduct(a, 'WO-A-' + randomBytes(4).toString('hex'), 10);
  const pid = await publicId('base_wire220_product_ids', a.tenant, p.id), wid = await publicId('base_wire220_warehouse_ids', a.tenant, a.warehouse);
  const clientKey = randomUUID(), before = await orderCount(a.tenant), parameters = baseOrder(a, pid, wid, { paid: 1, admin_comments: 'Z Base' });
  const first = success(await wire(a, 'addOrder', parameters, { 'idempotency-key': clientKey }));
  assert.deepEqual(Object.keys(first).sort(), ['order_id', 'status']);
  const local = await localOrder(a.tenant, first.order_id);
  assert(local, 'numeric identity allocated in the same transaction');
  const o = (await pool.query('SELECT status,total,shipping_cost,source,customer_name,email,note,address,payment_mode,warehouse_id FROM orders WHERE id=$1', [local])).rows[0];
  assert.deepEqual({ ...o, address: undefined }, { status: 'paid', total: 6100, shipping_cost: 1000, source: 'manual', customer_name: 'Jan Base', email: 'base@example.com',
    note: 'Z Base', address: undefined, payment_mode: 'prepaid', warehouse_id: a.warehouse });
  assert.deepEqual(o.address, { street: 'Prosta 1', city: 'Warszawa', postal_code: '00-001', country: 'PL', phone: '500600700' });
  assert.deepEqual((await pool.query('SELECT quantity,price,line_total FROM order_items WHERE order_id=$1', [local])).rows, [{ quantity: 2, price: 2550, line_total: 5100 }]);
  const payments = (await pool.query("SELECT kind,amount,currency,reference FROM payment_entries WHERE order_id=$1", [local])).rows;
  assert.deepEqual(payments, [{ kind: 'receipt', amount: 6100, currency: a.currency, reference: 'Base API addOrder paid=1' }]);
  const balance = await tenantTx(a.tenant, c => paymentBalance(c, local));
  assert.equal(balance.amount_due, 0); assert.equal(balance.net, 6100);
  // Native reservation rules: stock row reserved and a reservation per product.
  assert.deepEqual(await stockOf(p.id, a.warehouse), { on_hand: 10, reserved: 2 });
  assert.deepEqual((await pool.query("SELECT quantity,state FROM reservations WHERE order_id=$1", [local])).rows, [{ quantity: 2, state: 'active' }]);
  // Lost-ACK retry with the same key and body: same order_id, no second order/payment/reservation.
  assert.deepEqual(success(await wire(a, 'addOrder', parameters, { 'idempotency-key': clientKey })), first);
  assert.equal(await orderCount(a.tenant), before + 1);
  assert.equal((await pool.query('SELECT count(*)::int n FROM payment_entries WHERE order_id=$1', [local])).rows[0].n, 1);
  assert.deepEqual(await stockOf(p.id, a.warehouse), { on_hand: 10, reserved: 2 });
  refused(await wire(a, 'addOrder', { ...parameters, paid: 0 }, { 'idempotency-key': clientKey }), 409);
  // Base read sees the native result.
  const dto = success(await wire(a, 'getOrders', { order_id: first.order_id })).orders[0];
  assert.equal(dto.payment_done, 61); assert.equal(dto.delivery_price, 10); assert.equal(dto.admin_comments, 'Z Base');
  assert.deepEqual(dto.products.map((x: any) => [x.product_id, x.variant_id, x.quantity, x.price_brutto, x.tax_rate]), [[String(pid), '0', 2, 25.5, 23]]);
  // Write requires read; unknown/foreign products and unmapped data have no effect.
  refused(await wire(writeOnly, 'addOrder', parameters), 403);
  const bp = await nativeProduct(b, 'WO-B-' + randomBytes(4).toString('hex'), 5);
  refused(await wire(a, 'addOrder', baseOrder(a, await publicId('base_wire220_product_ids', b.tenant, bp.id), wid)), 404);
  refused(await wire(a, 'addOrder', baseOrder(a, pid, wid, { user_comments: 'Proszę szybko' })), 422);
  refused(await wire(b, 'addOrder', baseOrder(b, pid, await publicId('base_wire220_warehouse_ids', b.tenant, b.warehouse))), 404);
  assert.equal(await orderCount(a.tenant), before + 1);
  assert.deepEqual(await stockOf(p.id, a.warehouse), { on_hand: 10, reserved: 2 });
});

test('setOrderStatus changes the native status; the change is visible natively and in getOrders', async () => {
  const p = await nativeProduct(a, 'WO-S-' + randomBytes(4).toString('hex'), 5);
  const pid = await publicId('base_wire220_product_ids', a.tenant, p.id), wid = await publicId('base_wire220_warehouse_ids', a.tenant, a.warehouse);
  const picking = await nativeStatus(a, 'Kompletowanie ' + randomBytes(3).toString('hex'), 'picking');
  const sid = await publicId('base_wire220_order_status_ids', a.tenant, picking);
  const listed = success(await wire(a, 'getOrderStatusList', {})).statuses;
  assert.deepEqual(listed.find((s: any) => s.id === sid), { id: sid, name: (await pool.query('SELECT name FROM workflow_statuses WHERE id=$1', [picking])).rows[0].name,
    color: '#1c8752', group_id: 0, is_primary: 0, name_for_customer: (await pool.query('SELECT name FROM workflow_statuses WHERE id=$1', [picking])).rows[0].name });
  assert(!success(await wire(b, 'getOrderStatusList', {})).statuses.some((s: any) => s.id === sid), 'second tenant isolated');
  const order = success(await wire(a, 'addOrder', baseOrder(a, pid, wid, { paid: 1 }))).order_id, local = (await localOrder(a.tenant, order))!;
  // Foreign tenant cannot move A's order nor use A's status.
  const bStatus = await publicId('base_wire220_order_status_ids', b.tenant, await nativeStatus(b, 'Obcy ' + randomBytes(3).toString('hex'), 'paid'));
  refused(await wire(b, 'setOrderStatus', { order_id: order, status_id: bStatus }), 404);
  refused(await wire(a, 'setOrderStatus', { order_id: order, status_id: bStatus }), 404);
  refused(await wire(writeOnly, 'setOrderStatus', { order_id: order, status_id: sid }), 403);
  assert.equal((await pool.query('SELECT status,workflow_status_id FROM orders WHERE id=$1', [local])).rows[0].status, 'paid');
  assert.deepEqual(success(await wire(a, 'setOrderStatus', { order_id: order, status_id: sid })), { status: 'SUCCESS' });
  assert.deepEqual((await pool.query('SELECT status,workflow_status_id FROM orders WHERE id=$1', [local])).rows[0], { status: 'picking', workflow_status_id: picking });
  assert.equal((await pool.query("SELECT count(*)::int n FROM order_events WHERE order_id=$1 AND kind='order.workflow_changed'", [local])).rows[0].n, 1);
  assert.equal(success(await wire(a, 'getOrders', { order_id: order })).orders[0].order_status_id, sid);
  assert.deepEqual(success(await wire(a, 'getOrders', { status_id: sid })).orders.map((x: any) => x.order_id), [order]);
  // An impossible native transition (picking -> new) is refused by the native rules.
  const fresh = await publicId('base_wire220_order_status_ids', a.tenant, await nativeStatus(a, 'Nowe ' + randomBytes(3).toString('hex'), 'new'));
  refused(await wire(a, 'setOrderStatus', { order_id: order, status_id: fresh }), 409);
  assert.equal((await pool.query('SELECT status FROM orders WHERE id=$1', [local])).rows[0].status, 'picking');
});

test('native stage statuses: listed for every company, returned without a workflow status, set via the native stage transition', async () => {
  for (const o of [a, b]) {
    const ids = success(await wire(o, 'getOrderStatusList', {})).statuses.map((s: any) => s.id);
    assert.deepEqual(ids.slice(-BASE_WIRE_STAGE_STATUSES.length), BASE_WIRE_STAGE_STATUSES.map(s => s.id), 'stages after the own workflow statuses');
    const max = Number((await pool.query('SELECT coalesce(max(public_id),0)::text m FROM base_wire220_order_status_ids')).rows[0].m);
    assert(max < 2147483000, 'no 220 workflow-status ID inside the reserved range');
  }
  const p = await nativeProduct(a, 'WO-G-' + randomBytes(4).toString('hex'), 5);
  const pid = await publicId('base_wire220_product_ids', a.tenant, p.id), wid = await publicId('base_wire220_warehouse_ids', a.tenant, a.warehouse);
  const order = success(await wire(a, 'addOrder', baseOrder(a, pid, wid, { paid: 1 }))).order_id, local = (await localOrder(a.tenant, order))!;
  const dto = async () => success(await wire(a, 'getOrders', { order_id: order })).orders[0];
  assert.equal((await dto()).order_status_id, baseWireStageStatusId('paid'), 'paid=1 promotes natively to paid; no workflow status');
  assert(success(await wire(a, 'getOrders', { status_id: baseWireStageStatusId('paid') })).orders.some((x: any) => x.order_id === order));
  // Impossible native transition (paid -> shipped): native 409, nothing changes.
  refused(await wire(a, 'setOrderStatus', { order_id: order, status_id: baseWireStageStatusId('shipped') }), 409);
  refused(await wire(b, 'setOrderStatus', { order_id: order, status_id: baseWireStageStatusId('picking') }), 404);
  refused(await wire(writeOnly, 'setOrderStatus', { order_id: order, status_id: baseWireStageStatusId('picking') }), 403);
  assert.equal((await pool.query('SELECT status FROM orders WHERE id=$1', [local])).rows[0].status, 'paid');
  // Stage status: native set_status paid -> picking (event + audit), workflow status cleared.
  const key = randomUUID();
  assert.deepEqual(success(await wire(a, 'setOrderStatus', { order_id: order, status_id: baseWireStageStatusId('picking') }, { 'idempotency-key': key })), { status: 'SUCCESS' });
  assert.deepEqual((await pool.query('SELECT status,workflow_status_id FROM orders WHERE id=$1', [local])).rows[0], { status: 'picking', workflow_status_id: null });
  assert.equal((await pool.query("SELECT count(*)::int n FROM order_events WHERE order_id=$1 AND kind='order.picking'", [local])).rows[0].n, 1);
  assert.equal((await pool.query("SELECT count(*)::int n FROM audit_events WHERE entity_id=$1 AND action='order.status'", [local])).rows[0].n >= 1, true);
  assert.equal((await dto()).order_status_id, baseWireStageStatusId('picking'));
  // Replay under the key: same answer, no second transition.
  success(await wire(a, 'setOrderStatus', { order_id: order, status_id: baseWireStageStatusId('picking') }, { 'idempotency-key': key }));
  assert.equal((await pool.query("SELECT count(*)::int n FROM order_events WHERE order_id=$1 AND kind='order.picking'", [local])).rows[0].n, 1);
  // A workflow status of the same stage wins; its stage status cannot drop it (409, no native operation).
  const custom = await nativeStatus(a, 'Kompletacja ' + randomBytes(3).toString('hex'), 'picking');
  success(await wire(a, 'setOrderStatus', { order_id: order, status_id: await publicId('base_wire220_order_status_ids', a.tenant, custom) }));
  assert.equal(refused(await wire(a, 'setOrderStatus', { order_id: order, status_id: baseWireStageStatusId('picking') }), 409).error_code, 'LOCAL_BASE_WIRE_STAGE_STATUS');
  assert.deepEqual((await pool.query('SELECT status,workflow_status_id FROM orders WHERE id=$1', [local])).rows[0], { status: 'picking', workflow_status_id: custom });
  // Native cancellation through the stage status (picking -> cancelled releases reservations natively).
  success(await wire(a, 'setOrderStatus', { order_id: order, status_id: baseWireStageStatusId('cancelled') }));
  assert.deepEqual((await pool.query('SELECT status,workflow_status_id FROM orders WHERE id=$1', [local])).rows[0], { status: 'cancelled', workflow_status_id: null });
  assert.equal((await dto()).order_status_id, baseWireStageStatusId('cancelled'));
});

test('getOrders pages over more than 100 orders without duplicates or gaps (local keyset in one second)', async () => {
  const p = await nativeProduct(a, 'WO-P-' + randomBytes(4).toString('hex'), 200);
  const start = Number((await pool.query('SELECT floor(extract(epoch FROM now()))::bigint::text s')).rows[0].s);
  // 130 native createOrder calls in ONE transaction: identical created_at, i.e. the
  // undocumented >100-orders-in-one-second case that Base's "+1 s" rule cannot page.
  const created = await tenantTx(a.tenant, async c => {
    const ids: string[] = [];
    for (let n = 0; n < 130; n++) ids.push((await createOrder(c, a.actor, orderSchema.parse({ customer_name: 'Klient natywny', email: 'native@example.com',
      warehouse_id: a.warehouse, currency: a.currency, items: [{ product_id: p.id, quantity: 1 }] }), undefined, { fieldSource: 'manual' })).id);
    return ids;
  });
  assert.equal((await pool.query('SELECT count(DISTINCT floor(extract(epoch FROM created_at)))::int n FROM orders WHERE id=ANY($1::uuid[])', [created])).rows[0].n, 1);
  const pid = await publicId('base_wire220_product_ids', a.tenant, p.id), wid = await publicId('base_wire220_warehouse_ids', a.tenant, a.warehouse);
  const viaBase = success(await wire(a, 'addOrder', baseOrder(a, pid, wid))).order_id;
  const seen: number[] = [], pages: number[] = [];
  let cursor: Record<string, number> = { date_confirmed_from: start };
  for (;;) {
    const page = success(await wire(a, 'getOrders', cursor)).orders;
    pages.push(page.length); seen.push(...page.map((x: any) => x.order_id));
    for (let n = 1; n < page.length; n++)
      assert(page[n - 1].date_confirmed < page[n].date_confirmed || (page[n - 1].date_confirmed === page[n].date_confirmed && page[n - 1].order_id < page[n].order_id), 'stable order');
    if (page.length < 100) break;
    const last = page.at(-1);
    cursor = { date_confirmed_from: last.date_confirmed, id_from: last.order_id + 1 };
  }
  assert(pages[0] === 100 && pages.length >= 2, JSON.stringify(pages));
  assert.equal(new Set(seen).size, seen.length, 'no duplicates');
  const expected = (await pool.query(`SELECT s.public_id::text p FROM orders o JOIN base_wire220_order_ids s ON(s.tenant_id,s.local_id)=(o.tenant_id,o.id)
    WHERE o.tenant_id=$1 AND floor(extract(epoch FROM o.created_at))>=$2
    AND NOT EXISTS(SELECT 1 FROM order_merge_claims m WHERE m.tenant_id=o.tenant_id AND m.source_order_id=o.id)
    ORDER BY floor(extract(epoch FROM o.created_at)),s.public_id`, [a.tenant, start])).rows.map(r => Number(r.p));
  assert.deepEqual(seen, expected, 'no gaps');
  for (const id of created) assert(seen.includes(await publicId('base_wire220_order_ids', a.tenant, id)));
  assert(seen.includes(viaBase));
  // id_from alone pages by order_id: the same continuation rule is lossless.
  const byId: number[] = [];
  for (let from = Math.min(...seen); ;) {
    const page = success(await wire(a, 'getOrders', { id_from: from })).orders.map((x: any) => x.order_id);
    byId.push(...page);
    if (page.length < 100) break;
    from = page.at(-1) + 1;
  }
  const expectedById = (await pool.query(`SELECT s.public_id::text p FROM orders o JOIN base_wire220_order_ids s ON(s.tenant_id,s.local_id)=(o.tenant_id,o.id)
    WHERE o.tenant_id=$1 AND s.public_id>=$2 AND NOT EXISTS(SELECT 1 FROM order_merge_claims m WHERE m.tenant_id=o.tenant_id AND m.source_order_id=o.id)
    ORDER BY s.public_id`, [a.tenant, Math.min(...seen)])).rows.map(r => Number(r.p));
  assert.deepEqual(byId, expectedById);
  // The second tenant's paging never includes A's orders.
  const other = success(await wire(b, 'getOrders', { date_confirmed_from: start })).orders.map((x: any) => x.order_id);
  assert(!other.some((x: number) => seen.includes(x)));
});
