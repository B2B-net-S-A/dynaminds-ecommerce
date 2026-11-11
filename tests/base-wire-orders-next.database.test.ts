/** Real Fastify injection + real developer key gate + real 220 sidecars + the native
 * OMS for the second orders batch (getOrdersByEmail/Phone, getOrderExtraFields,
 * setOrderFields, setOrderPayment, getOrderPaymentsHistory, setOrdersMerge).
 * Fixtures are created once with direct native calls (createProduct + createOrder in ONE
 * transaction, createOrderField); every expectation is read back from the native rows.
 * Root-only execution on a fresh disposable clone dynaminds_wireord2_20261023_NN made
 * with 218–221 by the guarded applier. The suite writes, so a rerun requires a NEW clone.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { pool, tenantTx } from '../server/db';
import { tokenHash } from '../server/security';
import { authenticateBaseWireApiKey } from '../server/developer-api';
import { registerBaseWireRoutes } from '../server/base-wire-routes';
import { createBaseWireOrdersFamily, baseWireExtraFieldId, baseWireStageStatusId } from '../server/base-wire-orders';
import { createDefaultBaseWireOrdersService } from '../server/base-wire-orders-runtime';
import { createProduct } from '../server/catalog';
import { createOrder, orderSchema, productSchema, type Actor } from '../server/domain';
import { createOrderField } from '../server/order-fields';
import { paymentBalance } from '../server/payments';

assert.equal(process.env.DYNA_TEST, 'true', 'Explicit isolated test mode required');
const selected = new URL(process.env.DATABASE_URL ?? 'invalid://missing');
assert.equal(selected.hostname, '127.0.0.1');
assert.equal(selected.port, '57084');
assert.match(selected.pathname, /^\/dynaminds_wireord2_20261023_[0-9]{2}$/);
assert.equal(selected.username, 'postgres');
pool.options.query_timeout = 9000;
const KEY_NAME = 'Isolated wire orders next test';
const ALL = ['orders:read', 'orders:write', 'inventory:read', 'inventory:write', 'order-fields:read', 'order-fields:write'];
type Owner = { tenant: string; user: string; token: string };
let app: ReturnType<typeof Fastify>, a: Owner, aRead: Owner, b: Owner;
const tag = randomBytes(4).toString('hex'), email = `wire2-${tag}@example.com`, phone = '+48 600 ' + tag.slice(0, 3);
/** Native orders of A (local UUIDs): payment, fields, two to merge. */
let orders: { pay: string; fields: string; m1: string; m2: string };
let textField: string, selectField: string, paper: string;
async function key(tenant: string, user: string, scopes: string[]): Promise<Owner> {
  const token = 'dyna_api_' + randomBytes(32).toString('hex');
  await pool.query(`INSERT INTO api_keys(id,tenant_id,user_id,name,token_hash,prefix,scopes,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,clock_timestamp()+interval '1 day')`, [randomUUID(), tenant, user, KEY_NAME, tokenHash(token), token.slice(0, 16), scopes]);
  return { tenant, user, token };
}
async function wire(owner: Owner, method: string, parameters: unknown, headers: Record<string, string> = {}) {
  return app.inject({ method: 'POST', url: '/connector.php', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-bltoken': owner.token, ...headers },
    payload: new URLSearchParams({ method, parameters: JSON.stringify(parameters) }).toString() });
}
const success = (r: any) => { assert.equal(r.statusCode, 200, r.body); const d = r.json(); assert.equal(d.status, 'SUCCESS', r.body); return d; };
const refused = (r: any, status: number) => { assert.equal(r.statusCode, status, r.body); const d = r.json(); assert.equal(d.status, 'ERROR');
  assert.deepEqual(Object.keys(d).sort(), ['error_code', 'error_message', 'status']); assert(!/SELECT |stack|dyna_api_/.test(r.body)); return d; };
const orderPublic = async (local: string) => Number((await pool.query('SELECT public_id::text p FROM base_wire220_order_ids WHERE local_id=$1', [local])).rows[0]?.p);
const entries = async (order: string) => (await pool.query('SELECT kind,amount,method,reference,note FROM payment_entries WHERE order_id=$1 ORDER BY created_at,id', [order])).rows;
const header = async (order: string) => (await pool.query('SELECT customer_name,email,address,note,shipping_cost,currency,payment_mode,status,total,version::int FROM orders WHERE id=$1', [order])).rows[0];
const net = (order: string, tenant: string) => tenantTx(tenant, async c => Number((await paymentBalance(c, order)).net));

before(async () => {
  for (const name of ['base_wire220_order_ids', 'base_wire220_product_ids'])
    assert.notEqual((await pool.query('SELECT to_regclass($1) n', ['public.' + name])).rows[0].n, null, 'Clone needs committed 220: ' + name);
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
  const [ra, rb] = rows;
  a = await key(ra.tenant_id, ra.user_id, ALL); aRead = await key(ra.tenant_id, ra.user_id, ['orders:read', 'order-fields:read']);
  b = await key(rb.tenant_id, rb.user_id, ALL);
  const actor: Actor = { tenantId: a.tenant, userId: a.user, role: 'admin', source: 'manual' };
  // One transaction: one product and four native orders of one buyer (POST /api/orders path).
  orders = await tenantTx(a.tenant, async c => {
    const p = await createProduct(c, actor, productSchema.parse({ name: 'Produkt ' + tag, sku: 'W2-' + tag, price: 1999, vat: 23, catalog_id: ra.catalog, warehouse_id: ra.warehouse, quantity: 20 }));
    const one = async () => (await createOrder(c, actor, orderSchema.parse({ customer_name: 'Klient Wire', email, warehouse_id: ra.warehouse, currency: ra.currency,
      address: { street: 'Prosta 1', city: 'Warszawa', postal_code: '00-001', country: 'PL', phone }, items: [{ product_id: p.id, quantity: 1 }] }), undefined, { fieldSource: 'manual' })).id as string;
    return { pay: await one(), fields: await one(), m1: await one(), m2: await one() };
  });
  const text = await createOrderField(actor, { client_key: randomUUID(), key: 'wire_note_' + tag, type: 'text', label: 'Uwagi ' + tag, enabled: true, display: 'always',
    position: 0, read_role: 'team', write_role: 'operator', required_on: [], config: {}, options: [] });
  paper = randomUUID();
  const choice = await createOrderField(actor, { client_key: randomUUID(), key: 'wire_pack_' + tag, type: 'select', label: 'Opakowanie ' + tag, enabled: true, display: 'always',
    position: 1, read_role: 'team', write_role: 'operator', required_on: [], config: {}, options: [{ id: paper, label: 'Papier', enabled: true }, { id: randomUUID(), label: 'Folia', enabled: true }] });
  textField = text.id; selectField = choice.id;
  app = Fastify();
  registerBaseWireRoutes(app, { readOnly: false, families: [createBaseWireOrdersFamily({ available: true,
    service: createDefaultBaseWireOrdersService({ readOnly: false, mergeClaims: true, orderMerges: true, sessionName: 'dyna_session' }) })],
    authenticate: (token, scope) => authenticateBaseWireApiKey(token, scope, true) });
  await app.ready();
});
after(async () => { await app?.close(); await pool.end(); });

test('getOrdersByEmail/Phone match the native buyer exactly, newest first, foreign tenant isolated', async () => {
  const got = success(await wire(aRead, 'getOrdersByEmail', { email: email.toUpperCase() })).orders;
  const expected = (await pool.query(`SELECT s.public_id::text p,floor(extract(epoch FROM o.created_at))::int t FROM orders o JOIN base_wire220_order_ids s ON s.local_id=o.id
    WHERE o.tenant_id=$1 AND lower(o.email)=$2 ORDER BY floor(extract(epoch FROM o.created_at)) DESC,s.public_id DESC`, [a.tenant, email])).rows;
  assert.equal(expected.length, 4, 'getOrdersByEmail allocated the native orders first');
  assert.deepEqual(got, expected.map(r => ({ order_id: Number(r.p), order_status_id: baseWireStageStatusId('new'), date_in_status: r.t, date_add: r.t })));
  const byPhone = success(await wire(aRead, 'getOrdersByPhone', { phone })).orders;
  assert.deepEqual(byPhone.map((o: any) => [o.order_id, o.delivery_fullname, o.delivery_company]), expected.map(r => [Number(r.p), 'Klient Wire', '']));
  assert.deepEqual(success(await wire(b, 'getOrdersByEmail', { email })).orders, []);
  refused(await wire(aRead, 'getOrdersByEmail', {}), 422);
});

test('setOrderPayment: payment_done is the TOTAL; exactly one delta receipt, a replay records nothing', async () => {
  const id = await orderPublic(orders.pay), before = await header(orders.pay);
  assert.equal(before.status, 'new'); assert.equal(await net(orders.pay, a.tenant), 0);
  success(await wire(a, 'setOrderPayment', { order_id: id, payment_done: 10, payment_date: 1760000000, payment_comment: 'Zaliczka', external_payment_id: 'PAY-' + tag }));
  // The same total again (a plain Base retry without Idempotency-Key): no second entry.
  success(await wire(a, 'setOrderPayment', { order_id: id, payment_done: '10.00', payment_date: 1760000000, payment_comment: 'Zaliczka', external_payment_id: 'PAY-' + tag }));
  assert.deepEqual(await entries(orders.pay), [{ kind: 'receipt', amount: 1000, method: 'other', reference: 'Base API setOrderPayment PAY-' + tag, note: 'Zaliczka' }]);
  assert.equal(await net(orders.pay, a.tenant), 1000);
  // Up to the order value under an Idempotency-Key: one delta; the replay returns the stored response.
  const key = randomUUID(), full = before.total / 100;
  success(await wire(a, 'setOrderPayment', { order_id: id, payment_done: full }, { 'idempotency-key': key }));
  success(await wire(a, 'setOrderPayment', { order_id: id, payment_done: full }, { 'idempotency-key': key }));
  assert.deepEqual((await entries(orders.pay)).map(e => e.amount), [1000, before.total - 1000]);
  assert.equal(await net(orders.pay, a.tenant), before.total);
  assert.equal((await header(orders.pay)).status, 'paid', 'native paid promotion');
  // A lower total, a foreign tenant and a read-only key change nothing.
  assert.equal(refused(await wire(a, 'setOrderPayment', { order_id: id, payment_done: 5 }), 422).error_code, 'LOCAL_BASE_WIRE_PAYMENT_DECREASE');
  refused(await wire(b, 'setOrderPayment', { order_id: id, payment_done: full + 5 }), 404);
  refused(await wire(aRead, 'setOrderPayment', { order_id: id, payment_done: full + 5 }), 403);
  assert.equal((await entries(orders.pay)).length, 2);
  // History: running totals from the same native ledger.
  const t = (await pool.query('SELECT floor(extract(epoch FROM created_at))::int t FROM payment_entries WHERE order_id=$1 ORDER BY created_at,id', [orders.pay])).rows.map(r => r.t);
  const entry = (paid_before: number, paid_after: number, external_payment_id: string, date: number, comment: string) =>
    ({ paid_before, paid_after, total_price: full, currency: before.currency, external_payment_id, date, comment });
  assert.deepEqual(success(await wire(aRead, 'getOrderPaymentsHistory', { order_id: id })).payments, [entry(0, 10, 'PAY-' + tag, t[0], 'Zaliczka')]);
  assert.deepEqual(success(await wire(aRead, 'getOrderPaymentsHistory', { order_id: id, show_full_history: true })).payments,
    [entry(0, 10, 'PAY-' + tag, t[0], 'Zaliczka'), entry(10, full, '', t[1], '')]);
  refused(await wire(b, 'getOrderPaymentsHistory', { order_id: id }), 404);
});

test('getOrderExtraFields + setOrderFields change only the mapped native order fields', async () => {
  const listed = success(await wire(aRead, 'getOrderExtraFields', {})).extra_fields;
  // Native option order (GET /api/order-fields lists options by id).
  const nativeOptions = (await pool.query('SELECT label FROM order_field_options WHERE field_id=$1 AND enabled ORDER BY id', [selectField])).rows.map(r => r.label);
  assert.deepEqual([...nativeOptions].sort(), ['Folia', 'Papier']);
  assert.deepEqual(listed.filter((f: any) => [baseWireExtraFieldId(textField), baseWireExtraFieldId(selectField)].includes(f.extra_field_id)), [
    { extra_field_id: baseWireExtraFieldId(textField), name: 'Uwagi ' + tag, editor_type: 'text' },
    { extra_field_id: baseWireExtraFieldId(selectField), name: 'Opakowanie ' + tag, editor_type: 'select', options: nativeOptions }]);
  assert(!success(await wire(b, 'getOrderExtraFields', {})).extra_fields.some((f: any) => f.name.endsWith(tag)), 'foreign definitions invisible');
  const id = await orderPublic(orders.fields), before = await header(orders.fields);
  const values = async () => (await pool.query('SELECT field_id,text_value,option_values,source FROM order_field_values WHERE order_id=$1 ORDER BY field_id', [orders.fields])).rows;
  // Header fields are refused, even empty, with no change.
  for (const field of ['admin_comments', 'delivery_address', 'email'])
    assert.equal(refused(await wire(a, 'setOrderFields', { order_id: id, [field]: '' }), 422).error_code, 'LOCAL_BASE_WIRE_UNSUPPORTED_FIELD');
  refused(await wire(aRead, 'setOrderFields', { order_id: id, custom_extra_fields: { [baseWireExtraFieldId(textField)]: 'x' } }), 403);
  refused(await wire(b, 'setOrderFields', { order_id: id, custom_extra_fields: { [baseWireExtraFieldId(textField)]: 'x' } }), 404);
  assert.deepEqual(await values(), []);
  success(await wire(a, 'setOrderFields', { order_id: id, custom_extra_fields: { [baseWireExtraFieldId(textField)]: 'Zadzwonić', [baseWireExtraFieldId(selectField)]: 'Papier' } }));
  assert.deepEqual(await values(), [{ field_id: textField, text_value: 'Zadzwonić', option_values: null, source: 'api' },
    { field_id: selectField, text_value: null, option_values: [paper], source: 'api' }].sort((x, y) => x.field_id.localeCompare(y.field_id)));
  const afterHeader = await header(orders.fields);
  assert.deepEqual({ ...afterHeader, version: 0 }, { ...before, version: 0 }, 'native header untouched');
  assert.equal(afterHeader.version, before.version + 1, 'native order-field write bumps the version');
  // Empty string clears the value natively.
  success(await wire(a, 'setOrderFields', { order_id: id, custom_extra_fields: { [baseWireExtraFieldId(textField)]: '' } }));
  assert.deepEqual((await values()).map(v => v.field_id), [selectField]);
});

test('setOrdersMerge runs the native technical merge: a new merged order with a 220 ID, replayed once', async () => {
  const [m1, m2] = [await orderPublic(orders.m1), await orderPublic(orders.m2)];
  const body = { main_order_id: m1, order_ids_to_merge: [m2], merge_mode: 'technical_merge', sum_delivery_costs: true };
  refused(await wire(aRead, 'setOrdersMerge', body), 403);
  refused(await wire(b, 'setOrdersMerge', body), 404);
  const executions = async () => (await pool.query('SELECT id,target_order_id,merge_mode FROM order_merge_executions WHERE tenant_id=$1 AND main_order_id=$2', [a.tenant, orders.m1])).rows;
  assert.deepEqual(await executions(), []);
  const key = randomUUID();
  const merged = success(await wire(a, 'setOrdersMerge', body, { 'idempotency-key': key })).merged_order_id;
  const done = await executions();
  assert.equal(done.length, 1); assert.equal(done[0].merge_mode, 'technical_merge');
  assert.equal(merged, await orderPublic(done[0].target_order_id), 'merged_order_id is the native target order');
  const target = await header(done[0].target_order_id), sources = [await header(orders.m1), await header(orders.m2)];
  assert.equal((await pool.query('SELECT source FROM orders WHERE id=$1', [done[0].target_order_id])).rows[0].source, 'order_merge');
  assert.equal(target.total, sources[0].total + sources[1].total);
  assert.equal(target.customer_name, 'Klient Wire');
  // The same Idempotency-Key replays the native preview and execution: no second merge.
  assert.deepEqual(success(await wire(a, 'setOrdersMerge', body, { 'idempotency-key': key })), { status: 'SUCCESS', merged_order_id: merged });
  assert.equal((await executions()).length, 1);
  // getOrders hides merged sources like GET /api/orders and lists the merged order.
  assert.deepEqual(success(await wire(aRead, 'getOrders', { order_id: m2 })).orders, []);
  assert.equal(success(await wire(aRead, 'getOrders', { order_id: merged })).orders.length, 1);
});

test('addOrderBySplit without the 222 split schema answers 503 (no native port), nothing is written', async () => {
  const before = (await pool.query('SELECT count(*)::int n FROM orders')).rows[0].n;
  refused(await wire(a, 'addOrderBySplit', { order_id: 1, items_to_split: [{ order_product_id: 1, quantity: 1 }] }), 503);
  assert.equal((await pool.query('SELECT count(*)::int n FROM orders')).rows[0].n, before);
});
