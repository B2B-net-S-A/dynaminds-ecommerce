/** Real Fastify injection + real developer key gate + real 220 sidecars + the
 * native OMS/RMA (createOrder, picking, shipDemo, requestReturn, receiveReturn,
 * decideReturn, recordRefund). Root-only execution on a fresh disposable clone
 * dynaminds_wireret_20261023_NN made from the clean restore template with 218–221
 * applied by the guarded applier (nine native guards before and after). The suite
 * writes, so a rerun requires a NEW clone.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { pool, tenantTx } from '../server/db';
import { tokenHash } from '../server/security';
import { authenticateBaseWireApiKey } from '../server/developer-api';
import { registerBaseWireRoutes } from '../server/base-wire-routes';
import { createBaseWireOrdersFamily, baseWireStageStatusId } from '../server/base-wire-orders';
import { createDefaultBaseWireOrdersService } from '../server/base-wire-orders-runtime';
import { createBaseWireReturnsFamily, baseWireReturnId, baseWireReturnStatusId, BASE_WIRE_RETURN_STATUSES } from '../server/base-wire-returns';
import { createDefaultBaseWireReturnsService } from '../server/base-wire-returns-runtime';
import { createProduct } from '../server/catalog';
import { productSchema, scan, shipDemo, type Actor } from '../server/domain';
import { transitionDirectLegacyOnReturnInTx } from '../server/legacy-return-on-command';
import { getReturn, receiveReturn, requestReturn, returnInput } from '../server/returns';
import { returnPage, returnQuery } from '../server/return-query';

assert.equal(process.env.DYNA_TEST, 'true', 'Explicit isolated test mode required');
const selected = new URL(process.env.DATABASE_URL ?? 'invalid://missing');
assert.equal(selected.hostname, '127.0.0.1');
assert.equal(selected.port, '57084');
assert.match(selected.pathname, /^\/dynaminds_(wireret|pimgaps)_20261023_[0-9]{2}$/);
assert.equal(selected.username, 'postgres');
pool.options.query_timeout = 9000;
type Owner = { tenant: string; user: string; catalog: string; warehouse: string; currency: string; token: string; actor: Actor };
let app: ReturnType<typeof Fastify>, a: Owner, b: Owner, readOnlyKey: Owner;
async function key(row: { tenant_id: string; user_id: string; catalog: string; warehouse: string; currency: string }, scopes: string[]): Promise<Owner> {
  const token = 'dyna_api_' + randomBytes(32).toString('hex'), id = randomUUID();
  await pool.query(`INSERT INTO api_keys(id,tenant_id,user_id,name,token_hash,prefix,scopes,expires_at)
    VALUES($1,$2,$3,'Isolated wire returns test',$4,$5,$6,clock_timestamp()+interval '1 day')`, [id, row.tenant_id, row.user_id, tokenHash(token), token.slice(0, 16), scopes]);
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
  (await pool.query('SELECT local_id FROM base_wire220_order_ids WHERE tenant_id=$1 AND public_id=$2', [tenant, publicOrder])).rows[0]?.local_id as string;
const version = async (c: any, id: string) => (await c.query('SELECT version::text v FROM orders WHERE id=$1', [id])).rows[0].v as string;
const count = async (sql: string, params: unknown[]) => (await pool.query(`SELECT count(*)::int n FROM ${sql}`, params)).rows[0].n as number;
async function nativeProduct(o: Owner, sku: string, quantity: number) {
  return tenantTx(o.tenant, c => createProduct(c, o.actor, productSchema.parse({ name: 'Produkt ' + sku, sku, price: 1999, vat: 23, catalog_id: o.catalog, warehouse_id: o.warehouse, quantity })));
}
/** Base addOrder (paid=1) of `quantity` units at 25.50 + 10.00 delivery. */
async function baseOrder(o: Owner, quantity: number) {
  const sku = 'WR-' + randomBytes(4).toString('hex'), p = await nativeProduct(o, sku, quantity + 5);
  const pid = await publicId('base_wire220_product_ids', o.tenant, p.id), wid = await publicId('base_wire220_warehouse_ids', o.tenant, o.warehouse);
  const order = success(await wire(o, 'addOrder', { delivery_fullname: 'Jan Base', email: 'base@example.com', phone: '500600700', delivery_address: 'Prosta 1',
    delivery_postcode: '00-001', delivery_city: 'Warszawa', delivery_country_code: 'PL', currency: o.currency, paid: 1, delivery_price: 10,
    products: [{ storage: 'db', product_id: String(pid), warehouse_id: wid, price_brutto: 25.5, tax_rate: 23, quantity }] })).order_id as number;
  return { order, local: await localOrder(o.tenant, order), sku, pid, product: p.id };
}
/** Native fulfilment: picking, scans, packed, demo shipment (the same functions as the UI). */
async function ship(o: Owner, x: { local: string; sku: string }, quantity: number) {
  await tenantTx(o.tenant, async c => transitionDirectLegacyOnReturnInTx(c, o.actor, x.local, 'picking', await version(c, x.local)));
  const location = (await pool.query('SELECT location FROM reservation_locations WHERE order_id=$1', [x.local])).rows[0]?.location;
  for (let n = 0; n < quantity; n++) await tenantTx(o.tenant, c => scan(c, o.actor, x.local, x.sku, location, undefined, { client_key: randomUUID() }));
  await tenantTx(o.tenant, async c => transitionDirectLegacyOnReturnInTx(c, o.actor, x.local, 'packed', await version(c, x.local)));
  await tenantTx(o.tenant, c => shipDemo(c, o.actor, x.local));
}
const nativeCase = async (id: string) => (await pool.query('SELECT id,tenant_id,order_id,number,state,kind,reason,requested_shipping,refund_amount,settlement,version::text v FROM return_cases WHERE id=$1', [id])).rows[0];
const caseOf = async (tenant: string, returnId: number) =>
  (await pool.query(`SELECT id FROM return_cases WHERE tenant_id=$1 AND (('x'||lpad(substr(replace(id::text,'-',''),1,12)||substr(replace(id::text,'-',''),14,1),16,'0'))::bit(64)::bigint+1)=$2`,
    [tenant, returnId])).rows.map(r => r.id as string);

before(async () => {
  for (const name of ['base_wire220_order_ids', 'base_wire220_product_ids', 'base_wire220_warehouse_ids', 'return_cases'])
    assert.notEqual((await pool.query('SELECT to_regclass($1) n', ['public.' + name])).rows[0].n, null, 'Clone needs committed 220 and RMA: ' + name);
  assert.equal((await pool.query("SELECT count(*)::int n FROM api_keys WHERE name='Isolated wire returns test'")).rows[0].n, 0, 'Fresh clone required; no rerun');
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
  readOnlyKey = await key(rows[0], ['orders:read']);
  app = Fastify();
  registerBaseWireRoutes(app, { readOnly: false, families: [
    createBaseWireOrdersFamily({ available: true, service: createDefaultBaseWireOrdersService({ readOnly: false, mergeClaims: true }) }),
    createBaseWireReturnsFamily({ available: true, service: createDefaultBaseWireReturnsService({ readOnly: false }) })],
    authenticate: (token, scope) => authenticateBaseWireApiKey(token, scope, true) });
  await app.ready();
});
after(async () => { await app?.close(); await pool.end(); });

test('getOrderReturnStatusList lists the fixed native states for every key with orders:read', async () => {
  for (const o of [a, b, readOnlyKey])
    assert.deepEqual(success(await wire(o, 'getOrderReturnStatusList', {})).statuses.map((s: any) => s.id), BASE_WIRE_RETURN_STATUSES.map(s => s.id));
  // Without the 223 dictionary capability the method answers 503 (return-reasons223.database.test.ts covers it).
  refused(await wire(a, 'getOrderReturnReasonsList', {}), 503);
});

test('Base addOrder -> native ship -> addOrderReturn -> native case; status change; refund exactly once; isolation', async () => {
  const x = await baseOrder(a, 2);
  const line = { storage: 'db', product_id: String(x.pid), price_brutto: 25.5, quantity: 1 };
  const ret = { order_id: x.order, admin_comments: 'Uszkodzony w transporcie', delivery_price: 10, email: 'base@example.com', delivery_fullname: 'Jan Base',
    currency: a.currency, products: [line] };
  // Not released yet: the native rule refuses (409), no case.
  refused(await wire(a, 'addOrderReturn', ret), 409);
  await ship(a, x, 2);
  assert.equal(success(await wire(a, 'getOrders', { order_id: x.order })).orders[0].order_status_id, baseWireStageStatusId('shipped'));
  // Read-only key, second tenant and a mismatched buyer have no effect.
  refused(await wire(readOnlyKey, 'addOrderReturn', ret), 403);
  refused(await wire(b, 'addOrderReturn', ret), 404);
  refused(await wire(a, 'addOrderReturn', { ...ret, email: 'obcy@example.com' }), 422);
  refused(await wire(a, 'addOrderReturn', { ...ret, products: [{ ...line, quantity: 3 }] }), 409);
  assert.equal(await count('return_cases WHERE order_id=$1', [x.local]), 0);

  const retKey = randomUUID();
  const created = success(await wire(a, 'addOrderReturn', ret, { 'idempotency-key': retKey }));
  assert.deepEqual(Object.keys(created).sort(), ['return_id', 'status']);
  const cases = (await pool.query('SELECT id FROM return_cases WHERE order_id=$1', [x.local])).rows;
  assert.equal(cases.length, 1, 'one native case');
  const id = cases[0].id as string;
  assert.equal(created.return_id, baseWireReturnId(id), 'return_id derived from the native case UUID');
  assert.deepEqual(await caseOf(a.tenant, created.return_id), [id]);
  const native = await nativeCase(id);
  assert.deepEqual({ tenant: native.tenant_id, state: native.state, kind: native.kind, reason: native.reason, shipping: native.requested_shipping },
    { tenant: a.tenant, state: 'requested', kind: 'return', reason: 'Uszkodzony w transporcie', shipping: 1000 });
  assert.deepEqual((await pool.query('SELECT requested,sku FROM return_items WHERE return_id=$1', [id])).rows, [{ requested: 1, sku: x.sku }]);
  // Visible in the native register (GET /api/returns) and its event trail.
  const page = await tenantTx(a.tenant, c => returnPage(c, returnQuery.parse({}), x.local));
  assert.deepEqual(page.data.map((r: any) => r.id), [id]);
  assert.equal(await count("order_events WHERE order_id=$1 AND kind='return.requested'", [x.local]), 1);
  // Lost-ACK replay: same return_id, still one case; another body under the key is 409.
  assert.deepEqual(success(await wire(a, 'addOrderReturn', ret, { 'idempotency-key': retKey })), created);
  refused(await wire(a, 'addOrderReturn', { ...ret, delivery_price: 0 }, { 'idempotency-key': retKey }), 409);
  assert.equal(await count('return_cases WHERE order_id=$1', [x.local]), 1);

  // getOrderReturns: the Base DTO of the native case; the second tenant sees nothing.
  const dto = success(await wire(readOnlyKey, 'getOrderReturns', { order_id: x.order })).returns;
  assert.equal(dto.length, 1);
  assert.deepEqual({ ...dto[0], products: undefined, date_add: undefined, date_in_status: undefined }, {
    return_id: created.return_id, order_id: x.order, shop_order_id: 0, external_order_id: '', reference_number: native.number,
    order_return_source: 'personal', order_return_source_id: 0, status_id: baseWireReturnStatusId('requested'), date_add: undefined, date_in_status: undefined,
    user_login: '', currency: a.currency, refunded: 0, email: 'base@example.com', phone: '500600700', delivery_price: 10, delivery_fullname: 'Jan Base',
    delivery_company: '', delivery_address: 'Prosta 1', delivery_postcode: '00-001', delivery_city: 'Warszawa', delivery_state: '', delivery_country: '',
    delivery_country_code: 'PL', extra_field_1: '', extra_field_2: '', admin_comments: 'Uszkodzony w transporcie', delivery_package_module: '', delivery_package_nr: '',
    order_return_account_number: '', order_return_iban: '', order_return_swift: '', refund_account_number: '', refund_iban: '', refund_swift: '', fulfillment_status: 0,
    products: undefined });
  assert.match(dto[0].reference_number, /^RMA-/);
  assert.deepEqual(dto[0].products.map((p: any) => [p.product_id, p.variant_id, p.sku, p.quantity, p.price_brutto, p.tax_rate, p.warehouse_id]),
    [[String(x.pid), '0', x.sku, 1, 25.5, 23, await publicId('base_wire220_warehouse_ids', a.tenant, a.warehouse)]]);
  assert(!JSON.stringify(dto).includes(id), 'numeric identities only');
  assert.deepEqual(success(await wire(b, 'getOrderReturns', { return_id: created.return_id })).returns, []);
  assert.deepEqual(success(await wire(b, 'getOrderReturns', {})).returns.filter((r: any) => r.order_id === x.order), []);

  // Status change: a second case for the other unit is cancelled through the native decision.
  const second = success(await wire(a, 'addOrderReturn', { order_id: x.order, products: [line] })).return_id as number;
  const secondId = (await caseOf(a.tenant, second))[0];
  refused(await wire(a, 'setOrderReturnStatus', { return_id: second, status_id: baseWireReturnStatusId('refund_pending') }), 409);
  refused(await wire(b, 'setOrderReturnStatus', { return_id: second, status_id: baseWireReturnStatusId('cancelled') }), 404);
  refused(await wire(readOnlyKey, 'setOrderReturnStatus', { return_id: second, status_id: baseWireReturnStatusId('cancelled') }), 403);
  assert.equal((await nativeCase(secondId)).state, 'requested');
  success(await wire(a, 'setOrderReturnStatus', { return_id: second, status_id: baseWireReturnStatusId('cancelled') }));
  assert.equal((await nativeCase(secondId)).state, 'cancelled');
  assert.equal(await count("order_events WHERE order_id=$1 AND kind='return.cancelled' AND detail->>'return_id'=$2", [x.local, secondId]), 1);
  assert.equal(success(await wire(a, 'getOrderReturns', { return_id: second })).returns[0].status_id, baseWireReturnStatusId('cancelled'));
  success(await wire(a, 'setOrderReturnStatus', { return_id: second, status_id: baseWireReturnStatusId('cancelled') }));
  assert.equal(await count("order_events WHERE order_id=$1 AND kind='return.cancelled'", [x.local]), 1, 'same status: no second decision');

  // Native receive (operator, outside Base), then the refund declaration.
  const refundRequest = { return_id: created.return_id, order_refund_done: 0, refund_date: Math.floor(Date.now() / 1000), refund_comment: 'Przelew', external_refund_id: 'TX-' + randomBytes(3).toString('hex') };
  refused(await wire(a, 'setOrderReturnRefund', { ...refundRequest, order_refund_done: 35.5 }), 409);
  await tenantTx(a.tenant, async c => {
    const r = await getReturn(c, id);
    await receiveReturn(c, a.actor, id, { version: Number(r.version), shipping_refund: 1000, note: 'Przyjęto zwrot Base',
      items: [{ item_id: r.items[0].item_id, accepted: 1, restocked: 1 }] });
  });
  const received = await tenantTx(a.tenant, c => getReturn(c, id));
  assert.equal(received.state, 'refund_pending'); assert.equal(received.refund_amount, 3550);
  const payout = received.settlement_amount as number;
  assert(payout > 0, 'the paid order has funds to give back');
  const refund = { ...refundRequest, order_refund_done: payout / 100 };
  refused(await wire(a, 'setOrderReturnRefund', { ...refund, order_refund_done: payout / 100 + 1 }), 422);
  refused(await wire(b, 'setOrderReturnRefund', refund), 404);
  refused(await wire(readOnlyKey, 'setOrderReturnRefund', refund), 403);
  assert.equal(await count('payment_entries WHERE return_id=$1', [id]), 0);
  const refundKey = randomUUID();
  assert.deepEqual(success(await wire(a, 'setOrderReturnRefund', refund, { 'idempotency-key': refundKey })), { status: 'SUCCESS' });
  const paid = (await pool.query("SELECT kind,amount,reference FROM payment_entries WHERE return_id=$1", [id])).rows;
  assert.deepEqual(paid, [{ kind: 'refund', amount: payout, reference: `${refund.external_refund_id} · Przelew` }]);
  assert.equal((await nativeCase(id)).state, 'closed');
  // Lost-ACK replay with the key, and a replay without it: no second payment; another reference is 409.
  assert.deepEqual(success(await wire(a, 'setOrderReturnRefund', refund, { 'idempotency-key': refundKey })), { status: 'SUCCESS' });
  assert.deepEqual(success(await wire(a, 'setOrderReturnRefund', refund)), { status: 'SUCCESS' });
  assert.equal(refused(await wire(a, 'setOrderReturnRefund', { ...refund, external_refund_id: 'TX-INNY' }), 409).error_code, 'LOCAL_BASE_WIRE_RETURN_REFUNDED');
  assert.equal(await count('payment_entries WHERE return_id=$1', [id]), 1, 'refund recorded exactly once');
  assert.equal(await count("order_events WHERE order_id=$1 AND kind='return.refund_recorded'", [x.local]), 1);
  // Base reads see the native settlement.
  const closed = success(await wire(a, 'getOrderReturns', { return_id: created.return_id })).returns[0];
  assert.deepEqual([closed.status_id, closed.fulfillment_status, closed.refunded], [baseWireReturnStatusId('closed'), 1, payout / 100]);
  assert.deepEqual(success(await wire(readOnlyKey, 'getOrderReturnPaymentsHistory', { return_id: created.return_id })).payments.map((p: any) => ({ ...p, date: undefined })),
    [{ paid_before: 0, paid_after: payout / 100, total_price: 35.5, currency: a.currency, external_payment_id: `${refund.external_refund_id} · Przelew`, date: undefined }]);
  refused(await wire(b, 'getOrderReturnPaymentsHistory', { return_id: created.return_id }), 404);
});

test('getOrderReturns pages natively created cases (> 100 for one order) without duplicates or gaps', async () => {
  const total = 103, x = await baseOrder(a, total);
  await ship(a, x, total);
  const item = (await pool.query('SELECT id FROM order_items WHERE order_id=$1', [x.local])).rows[0].id;
  const ids: string[] = [];
  for (let n = 0; n < total; n++) ids.push((await tenantTx(a.tenant, c => requestReturn(c, a.actor, x.local,
    returnInput.parse({ client_key: randomUUID(), reason: 'Natywny zwrot ' + n, items: [{ item_id: item, quantity: 1 }] })))).id);
  const expected = ids.map(baseWireReturnId).sort((p, q) => p - q);
  assert.equal(new Set(expected).size, total, 'no derived-ID collision');
  // Keyset (date_from, id_from) as for getOrders, next page = last date_add, last return_id + 1.
  const seen: number[] = [];let cursor: Record<string, number> = { date_from: 0 }, pages = 0;
  for (;;) {
    const got = success(await wire(a, 'getOrderReturns', { order_id: x.order, ...cursor })).returns;
    assert(got.length <= 100); pages++;
    seen.push(...got.map((r: any) => r.return_id));
    if (got.length < 100) break;
    cursor = { date_from: got.at(-1).date_add, id_from: got.at(-1).return_id + 1 };
  }
  assert.equal(pages, 2); assert.deepEqual([...seen].sort((p, q) => p - q), expected); assert.equal(new Set(seen).size, total);
  // id_from alone pages by return_id ascending.
  const byId = success(await wire(a, 'getOrderReturns', { order_id: x.order, id_from: 1 })).returns.map((r: any) => r.return_id);
  assert.deepEqual(byId, expected.slice(0, 100));
  const rest = success(await wire(a, 'getOrderReturns', { order_id: x.order, id_from: byId.at(-1)! + 1 })).returns.map((r: any) => r.return_id);
  assert.deepEqual(rest, expected.slice(100));
  assert.deepEqual(success(await wire(a, 'getOrderReturns', { order_id: x.order, status_id: baseWireReturnStatusId('closed') })).returns, []);
  assert.deepEqual(success(await wire(b, 'getOrderReturns', { order_id: x.order })).returns, [], 'second tenant isolated');
});
