/** Operator order edit: buyer data and sale lines through the real routes (Fastify injection with
 * the request actor the auth hook sets), the native OMS for order setup, and custody (picks,
 * reservations, locations, stock.reserved), totals and payment due read back from the rows.
 * buildApp is not used: its PIM preflight exceeds the 8 s statement budget on a cold local clone. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, migrate, tenantTx } from '../server/db';
import { Problem } from '../server/errors';
import { createOrder, cancelOrder, orderSchema, productSchema, transition, getOrder, type Actor } from '../server/domain';
import { createProduct } from '../server/catalog';
import { createWmsOpeningPreview, activateWmsOpening, receiveWmsReceipt } from '../server/wms-lots';
import { registerOrderEditRoutes } from '../server/order-edit-routes';
import { seed, DEMO_TENANT } from './fixtures';
assert.equal(process.env.DYNA_TEST, 'true');
type Row = Record<string, any>;
let app: FastifyInstance, warehouse: string;
let products: Row[];
const roles: Record<string, Actor> = {};
const admin = 'admin', operator = 'operator', viewer = 'viewer';
const req = (p: string, method: any = 'GET', payload?: unknown, as = admin) =>
  app.inject({ url: '/api' + p, method, ...(payload === undefined ? {} : { payload: payload as any }), headers: { 'x-test-as': as } });
async function ok(p: string, method: any = 'GET', payload?: unknown, as = admin) {
  const r = await req(p, method, payload, as);
  assert(r.statusCode < 300, r.body);
  return r.json();
}
const native = <T>(fn: (c: any) => Promise<T>) => tenantTx(DEMO_TENANT, fn);
const read = (id: string): Promise<Row> => native((c) => getOrder(c, id));
const status = (o: Row, to: string): Promise<Row> =>
  native((c) => transition(c, roles.admin, o.id, to, undefined, undefined, undefined, undefined, String(o.version)));
async function refused(r: Promise<any>, status: number, pattern?: RegExp) {
  const res = await r;
  assert.equal(res.statusCode, status, res.body);
  assert(!/SELECT |stack/.test(res.body), res.body);
  if (pattern) assert.match(res.json().detail, pattern);
  return res.json();
}
const product = (sku: string) => products.find((p) => p.sku === sku)!;
const stock = async (productId: string) =>
  (await pool.query('SELECT on_hand,reserved FROM stock WHERE product_id=$1 AND warehouse_id=$2', [productId, warehouse])).rows[0];
async function custody(orderId: string) {
  const picks = (await pool.query('SELECT product_id,quantity FROM order_pick_items WHERE order_id=$1 ORDER BY product_id', [orderId])).rows;
  const reservations = (
    await pool.query("SELECT product_id,quantity FROM reservations WHERE order_id=$1 AND state='active' ORDER BY product_id", [orderId])
  ).rows;
  const located = (
    await pool.query(
      `SELECT l.product_id,sum(l.quantity)::int quantity FROM reservation_locations l JOIN reservations r USING(tenant_id,order_id,product_id)
        WHERE l.order_id=$1 AND r.state='active' GROUP BY l.product_id ORDER BY l.product_id`,
      [orderId],
    )
  ).rows;
  return { picks, reservations, located };
}
/** Every active reservation equals its pick quantity and its located quantity. */
async function assertCustody(orderId: string, expected: Record<string, number>) {
  const { picks, reservations, located } = await custody(orderId);
  const want = Object.entries(expected)
    .map(([sku, quantity]) => ({ product_id: product(sku).id, quantity }))
    .sort((a, b) => a.product_id.localeCompare(b.product_id));
  assert.deepEqual(picks, want);
  assert.deepEqual(reservations, want);
  assert.deepEqual(located, want);
}
async function order(lines: [string, number][], extra: Row = {}): Promise<Row> {
  return native((c) =>
    createOrder(c, roles.admin, orderSchema.parse({
      customer_name: 'Monika Kozłowska',
      email: `edit-${randomUUID()}@example.test`,
      warehouse_id: warehouse,
      address: { street: 'Wojska Polskiego 11', city: 'Szczecin', postal_code: '70-470', phone: '600100200' },
      shipping_cost: 1699,
      items: lines.map(([sku, quantity]) => ({ product_id: product(sku).id, quantity })),
      ...extra,
    })),
  );
}
const customer = (o: Row, patch: Row = {}) => ({
  expected_version: String(o.version),
  customer_name: o.customer_name,
  email: o.email,
  phone: o.address.phone ?? '',
  street: o.address.street,
  postal_code: o.address.postal_code,
  city: o.address.city,
  ...patch,
});
before(async () => {
  await migrate();
  await seed();
  for (const role of ['admin', 'operator', 'viewer'] as const) {
    const id = (await pool.query('SELECT id FROM users WHERE email=$1', [role + '@demo.local'])).rows[0].id;
    roles[role] = { tenantId: DEMO_TENANT, userId: id, role, source: 'manual' };
  }
  warehouse = (await pool.query("SELECT id FROM warehouses WHERE tenant_id=$1 AND code='WAW'", [DEMO_TENANT])).rows[0].id;
  products = (await pool.query('SELECT * FROM products WHERE tenant_id=$1', [DEMO_TENANT])).rows;
  app = Fastify();
  app.decorateRequest('actor');
  app.decorateRequest('apiScopes');
  app.addHook('onRequest', async (r) => {
    r.actor = roles[String(r.headers['x-test-as'])];
    r.apiScopes = undefined;
  });
  // The app's error contract: Problem status + detail, Zod 422 as "path: message".
  app.setErrorHandler((err: any, _r, reply) => {
    if (err instanceof Problem) return reply.code(err.status).send({ detail: err.message });
    if (err instanceof z.ZodError)
      return reply.code(422).send({ detail: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
    process.stderr.write('UNEXPECTED ' + String(err?.code ?? '') + ' ' + String(err?.message ?? err) + '\n');
    return reply.code(500).send({ detail: 'Nieoczekiwany błąd serwera' });
  });
  registerOrderEditRoutes(app);
  await app.ready();
});
after(async () => {
  await app.close();
  await pool.end();
});

test('customer edit changes buyer and delivery fields with a version check and an event with values', async () => {
  const o = await order([['LAMP-001', 1]]);
  const changed = await ok(
    '/orders/' + o.id + '/customer',
    'PATCH',
    customer(o, { customer_name: 'Monika Nowak', email: 'monika.nowak@example.test', phone: '+48 600 100 300', street: 'Kolorowa 5' }),
    operator,
  );
  assert.equal(changed.customer_name, 'Monika Nowak');
  assert.equal(changed.email, 'monika.nowak@example.test');
  assert.deepEqual(
    { street: changed.address.street, city: changed.address.city, postal_code: changed.address.postal_code, phone: changed.address.phone },
    { street: 'Kolorowa 5', city: 'Szczecin', postal_code: '70-470', phone: '+48 600 100 300' },
  );
  assert.equal(changed.address.country, 'PL', 'fields outside the form are kept');
  assert(BigInt(changed.version) > BigInt(o.version));
  const e = changed.events.find((x: Row) => x.kind === 'order.customer_updated');
  assert.deepEqual(e.detail.fields, ['customer_name', 'email', 'street', 'phone']);
  // Uwagi v3 §6 (client decision): the history keeps the values before and after, covered by RODO.
  assert.deepEqual(e.detail.changes.map((x: Row) => [x.field, x.after]), [
    ['customer_name', 'Monika Nowak'], ['email', 'monika.nowak@example.test'], ['street', 'Kolorowa 5'], ['phone', '+48 600 100 300'],
  ]);
  assert.equal(e.detail.actor_id, roles.operator.userId);
  // An unchanged submit writes nothing.
  const same = await ok('/orders/' + o.id + '/customer', 'PATCH', customer(changed));
  assert.equal(same.version, changed.version);
});

test('customer edit refuses stale version, viewer, invalid data and a cancelled order', async () => {
  const o = await order([['CUP-003', 1]]);
  await refused(req('/orders/' + o.id + '/customer', 'PATCH', customer(o, { expected_version: String(Number(o.version) + 5) })), 409, /Odśwież/);
  await refused(req('/orders/' + o.id + '/customer', 'PATCH', customer(o), viewer), 403);
  await refused(req('/orders/' + o.id + '/customer', 'PATCH', customer(o, { email: 'brak-maila' })), 422, /e-mail/);
  await refused(req('/orders/' + o.id + '/customer', 'PATCH', customer(o, { email: '' })), 422, /e-mail/);
  await refused(req('/orders/' + o.id + '/customer', 'PATCH', customer(o, { customer_name: 'X' })), 422, /2 znaki/);
  await refused(req('/orders/' + o.id + '/customer', 'PATCH', customer(o, { phone: 'abc' })), 422, /Telefon/);
  await refused(req('/orders/' + o.id + '/customer', 'PATCH', { ...customer(o), note: 'x' }), 422);
  const cancelled = await status(o, 'cancelled');
  await refused(req('/orders/' + o.id + '/customer', 'PATCH', customer(cancelled)), 409, /przed nadaniem/);
  await refused(req('/orders/' + randomUUID() + '/customer', 'PATCH', customer(o)), 404);
});

test('adding a product prices it, reserves stock and moves the total and payment due', async () => {
  const lamp = product('LAMP-001'), bag = product('BAG-002');
  const o = await order([['LAMP-001', 2]]);
  const bagStock = await stock(bag.id);
  const added = await ok('/orders/' + o.id + '/items', 'POST', { expected_version: String(o.version), product_id: bag.id, quantity: 3 }, operator);
  const line = added.items.find((i: Row) => i.product_id === bag.id);
  assert.deepEqual({ quantity: line.quantity, price: line.price, line_total: line.line_total, sku: line.sku, vat: line.vat },
    { quantity: 3, price: bag.price, line_total: bag.price * 3, sku: 'BAG-002', vat: bag.vat });
  assert.equal(added.total, 1699 + lamp.price * 2 + bag.price * 3);
  assert.equal(added.payment.amount_due, added.total);
  assert.equal((await stock(bag.id)).reserved, bagStock.reserved + 3);
  await assertCustody(o.id, { 'LAMP-001': 2, 'BAG-002': 3 });
  const e = added.events.find((x: Row) => x.kind === 'order.item_added');
  assert.deepEqual(e.detail, { sku: 'BAG-002', quantity: 3, line_total: bag.price * 3 });
  // By SKU as well.
  const bySku = await ok('/orders/' + o.id + '/items', 'POST', { expected_version: String(added.version), sku: 'CUP-003', quantity: 1 });
  assert(bySku.items.some((i: Row) => i.sku === 'CUP-003'));
  await assertCustody(o.id, { 'LAMP-001': 2, 'BAG-002': 3, 'CUP-003': 1 });
});

test('adding refuses duplicates, unknown products, bad quantities, too little stock, stale version and viewer', async () => {
  const o = await order([['HEAD-004', 1]]);
  const v = String(o.version), url = '/orders/' + o.id + '/items';
  await refused(req(url, 'POST', { expected_version: v, product_id: product('HEAD-004').id, quantity: 1 }), 409, /już w zamówieniu/);
  await refused(req(url, 'POST', { expected_version: v, product_id: randomUUID(), quantity: 1 }), 404, /Nie znaleziono produktu/);
  await refused(req(url, 'POST', { expected_version: v, sku: 'NIE-MA-TAKIEGO', quantity: 1 }), 404);
  await refused(req(url, 'POST', { expected_version: v, product_id: product('MAT-008').id, quantity: 0 }), 422, /większa od zera/);
  await refused(req(url, 'POST', { expected_version: v, product_id: product('MAT-008').id, quantity: -2 }), 422);
  await refused(req(url, 'POST', { expected_version: v, product_id: product('MAT-008').id, quantity: 1.5 }), 422, /całkowitą/);
  await refused(req(url, 'POST', { expected_version: v, quantity: 1 }), 422, /product_id albo sku/);
  await refused(req(url, 'POST', { expected_version: v, product_id: product('DESK-006').id, quantity: 99999 }), 409, /Za mało towaru: DESK-006/);
  await refused(req(url, 'POST', { expected_version: String(Number(v) + 1), product_id: product('MAT-008').id, quantity: 1 }), 409, /Odśwież/);
  await refused(req(url, 'POST', { expected_version: v, product_id: product('MAT-008').id, quantity: 1 }, viewer), 403);
  // Nothing changed after the refusals.
  const after = await read(o.id);
  assert.equal(after.version, o.version);
  assert.equal(after.items.length, 1);
  await assertCustody(o.id, { 'HEAD-004': 1 });
});

test('quantity change and removal keep custody, totals and stock exact; the last line stays', async () => {
  const cup = product('CUP-003'), cable = product('CABLE-007');
  const before = { cup: await stock(cup.id), cable: await stock(cable.id) };
  const o = await order([['CUP-003', 2], ['CABLE-007', 1]]);
  const cupLine = o.items.find((i: Row) => i.product_id === cup.id), cableLine = o.items.find((i: Row) => i.product_id === cable.id);
  const up = await ok('/orders/' + o.id + '/items/' + cupLine.id, 'PATCH', { expected_version: String(o.version), quantity: 5 });
  assert.equal(up.items.find((i: Row) => i.id === cupLine.id).line_total, cup.price * 5);
  assert.equal(up.total, 1699 + cup.price * 5 + cable.price);
  assert.equal((await stock(cup.id)).reserved, before.cup.reserved + 5);
  await assertCustody(o.id, { 'CUP-003': 5, 'CABLE-007': 1 });
  assert.deepEqual(up.events.find((x: Row) => x.kind === 'order.item_quantity_changed').detail, { sku: 'CUP-003', from: 2, to: 5 });
  const down = await ok('/orders/' + o.id + '/items/' + cupLine.id, 'PATCH', { expected_version: String(up.version), quantity: 1 });
  assert.equal(down.total, 1699 + cup.price + cable.price);
  assert.equal((await stock(cup.id)).reserved, before.cup.reserved + 1);
  await assertCustody(o.id, { 'CUP-003': 1, 'CABLE-007': 1 });
  await refused(req('/orders/' + o.id + '/items/' + cupLine.id, 'PATCH', { expected_version: String(down.version), quantity: 0 }), 422);
  await refused(req('/orders/' + o.id + '/items/' + randomUUID(), 'PATCH', { expected_version: String(down.version), quantity: 2 }), 404);
  const removed = await ok('/orders/' + o.id + '/items/' + cableLine.id + '?expected_version=' + down.version, 'DELETE');
  assert.equal(removed.items.length, 1);
  assert.equal(removed.total, 1699 + cup.price);
  assert.equal(removed.payment.amount_due, removed.total);
  assert.equal((await stock(cable.id)).reserved, before.cable.reserved);
  await assertCustody(o.id, { 'CUP-003': 1 });
  assert.deepEqual(removed.events.find((x: Row) => x.kind === 'order.item_removed').detail, { sku: 'CABLE-007', quantity: 1 });
  await refused(req('/orders/' + o.id + '/items/' + cupLine.id + '?expected_version=' + removed.version, 'DELETE'), 409, /co najmniej jedną pozycję/);
  await refused(req('/orders/' + o.id + '/items/' + cupLine.id + '?expected_version=' + removed.version, 'DELETE', undefined, viewer), 403);
  await refused(req('/orders/' + o.id + '/items/' + cupLine.id, 'DELETE'), 422);
  // A removed product can come back: its released reservation is reused.
  const back = await ok('/orders/' + o.id + '/items', 'POST', { expected_version: String(removed.version), product_id: cable.id, quantity: 2 });
  assert.equal(back.total, 1699 + cup.price + cable.price * 2);
  assert.equal((await stock(cable.id)).reserved, before.cable.reserved + 2);
  await assertCustody(o.id, { 'CUP-003': 1, 'CABLE-007': 2 });
  // Cancelling after edits releases exactly what the edits reserved.
  await status(back, 'cancelled');
  assert.equal((await stock(cup.id)).reserved, before.cup.reserved);
  assert.equal((await stock(cable.id)).reserved, before.cable.reserved);
});

test('lines are locked once picking starts', async () => {
  const o = await order([['BOTTLE-005', 1]]);
  const paid = await status(o, 'paid');
  // A paid (ready to fulfil) order stays editable before picking.
  const edited = await ok('/orders/' + o.id + '/items/' + paid.items[0].id, 'PATCH', { expected_version: String(paid.version), quantity: 2 });
  assert.equal(edited.payment.amount_due, product('BOTTLE-005').price, 'the added unit is due again');
  assert.equal(edited.status, 'new', 'the surcharge sends the order back to Nieopłacone');
  await assert.rejects(status(edited, 'picking'), (e: any) => e.status === 409);
  const done = await ok('/orders/' + o.id + '/items/' + paid.items[0].id, 'PATCH', { expected_version: String(edited.version), quantity: 1 });
  assert.equal(done.status, 'paid', 'what was paid covers the order again, so it is Nowe');
  assert.equal(done.payment.amount_due, 0);
  const picking = await status(done, 'picking');
  await refused(
    req('/orders/' + o.id + '/items', 'POST', { expected_version: String(picking.version), product_id: product('MAT-008').id, quantity: 1 }),
    409,
    /przed rozpoczęciem kompletacji/,
  );
  await refused(req('/orders/' + o.id + '/items/' + picking.items[0].id, 'PATCH', { expected_version: String(picking.version), quantity: 3 }), 409);
  // Buyer data stays editable until shipping.
  const named = await ok('/orders/' + o.id + '/customer', 'PATCH', customer(picking, { customer_name: 'Kompletacja Trwa' }));
  assert.equal(named.customer_name, 'Kompletacja Trwa');
});

test('a surcharge on a paid prepaid order reopens payment; cash on delivery and an unpaid order keep their stage', async () => {
  const o = await order([['CUP-003', 1]]);
  const paid = await status(o, 'paid');
  const added = await ok('/orders/' + o.id + '/items', 'POST', { expected_version: String(paid.version), product_id: product('CABLE-007').id, quantity: 1 });
  assert.equal(added.status, 'new');
  assert.equal(added.payment.amount_due, product('CABLE-007').price);
  assert(added.events.some((e: Row) => e.kind === 'order.payment_reopened' && e.detail.amount_due === product('CABLE-007').price));
  // Removing the surcharge line leaves the received money covering the order: back to paid ("Nowe").
  const cable = added.items.find((i: Row) => i.sku === 'CABLE-007');
  const back = await ok('/orders/' + o.id + '/items/' + cable.id + '?expected_version=' + added.version, 'DELETE');
  assert.equal(back.status, 'paid');
  assert(back.events.some((e: Row) => e.kind === 'order.paid' && e.detail.scope === 'order_edit'));
  // Cash on delivery: the courier collects the edited total, the order stays ready to fulfil.
  const cod = await order([['CUP-003', 1]], { payment_mode: 'cod' });
  assert.equal(cod.status, 'paid');
  const codAdded = await ok('/orders/' + cod.id + '/items', 'POST', { expected_version: String(cod.version), product_id: product('CABLE-007').id, quantity: 1 });
  assert.equal(codAdded.status, 'paid');
  // An unpaid prepaid order stays Nieopłacone after edits: nothing was received.
  const unpaid = await order([['CUP-003', 1]]);
  const grown = await ok('/orders/' + unpaid.id + '/items/' + unpaid.items[0].id, 'PATCH', { expected_version: String(unpaid.version), quantity: 2 });
  assert.equal(grown.status, 'new');
  const shrunk = await ok('/orders/' + unpaid.id + '/items/' + unpaid.items[0].id, 'PATCH', { expected_version: String(grown.version), quantity: 1 });
  assert.equal(shrunk.status, 'new');
  await status(back, 'cancelled');
  await status(codAdded, 'cancelled');
  await status(shrunk, 'cancelled');
});

// WMS lots on. Lots are a tenant policy and the opening needs a tenant without active reservations,
// so these tests use an own tenant, enabled and stocked the way tests/wms-lots-flow.test.ts does it:
// an empty opening, then receipts that create FIFO layers.
const lots = 'lots';
const lot = { tenant: '', warehouse: '', products: {} as Record<string, Row> };
type Query = (sql: string, params: unknown[]) => Promise<Row[]>;
const fromPool: Query = async (sql, params) => (await pool.query(sql, params)).rows;
const inLots = <T>(fn: (c: any) => Promise<T>) => tenantTx(lot.tenant, fn);
async function receiveLayer(sku: string, quantity: number, location = 'A-01') {
  const p = lot.products[sku];
  const version = (await fromPool('SELECT version::text v FROM stock WHERE tenant_id=$1 AND warehouse_id=$2 AND product_id=$3',
    [lot.tenant, lot.warehouse, p.id]))[0]?.v ?? '0';
  const policy = (await fromPool('SELECT version::text v FROM wms_policies WHERE tenant_id=$1', [lot.tenant]))[0].v;
  await receiveWmsReceipt(roles[lots], {
    client_key: randomUUID(),
    policy_version: policy,
    warehouse_id: lot.warehouse,
    stock_versions: [{ warehouse_id: lot.warehouse, product_id: p.id, version }],
    lines: [{ product_id: p.id, location, quantity, lot_code: 'PARTIA-' + randomUUID(), unit_cost_minor: '1000', currency: 'PLN' }],
    note: 'Dostawa partii',
    confirmed: true,
  });
}
async function lotsTenant() {
  if (lot.tenant) return;
  lot.tenant = randomUUID();
  lot.warehouse = randomUUID();
  await pool.query("INSERT INTO tenants(id,name,plan) VALUES($1,'Edycja pozycji z partiami','enterprise')", [lot.tenant]);
  await pool.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'admin')", [lot.tenant, roles.admin.userId]);
  await pool.query("INSERT INTO warehouses(id,tenant_id,name,code) VALUES($1,$2,'Partie FIFO','LOT-E')", [lot.warehouse, lot.tenant]);
  roles[lots] = { tenantId: lot.tenant, userId: roles.admin.userId, role: 'admin', source: 'manual' };
  for (const sku of ['LOT-P', 'LOT-Q', 'LOT-R', 'LOT-S'])
    lot.products[sku] = await inLots((c) =>
      createProduct(c, roles[lots], productSchema.parse({
        name: 'Partia ' + sku, sku: sku + '-' + randomUUID().slice(0, 8), price: 2500, vat: 23,
        warehouse_id: lot.warehouse, quantity: 0, location: 'A-01',
      })),
    );
  const { preview } = await createWmsOpeningPreview(roles[lots], {
    client_key: randomUUID(), policy_version: '0', currency: 'PLN', note: 'Puste otwarcie partii', lines: [],
  });
  assert.equal(preview.ready, true);
  await activateWmsOpening(roles[lots], preview.id, {
    client_key: randomUUID(), scope_hash: preview.scope_hash, confirmed: true, ack_unknown_costs: false,
  });
  // P has two layers in one bin (2, then 10), Q and R one layer each, S one layer in A-01 (1) and the next in B-01 (5).
  for (const [sku, quantity, location] of [['LOT-P', 2], ['LOT-P', 10], ['LOT-Q', 6], ['LOT-R', 3], ['LOT-S', 1], ['LOT-S', 5, 'B-01']] as const)
    await receiveLayer(sku, quantity, location);
}
const lotInput = (lines: [string, number][]) =>
  orderSchema.parse({
    customer_name: 'Partie Klient',
    email: `partie-${randomUUID()}@example.test`,
    warehouse_id: lot.warehouse,
    address: { street: 'Magazynowa 2', city: 'Poznań', postal_code: '60-001', phone: '600200300' },
    shipping_cost: 0,
    items: lines.map(([sku, quantity]) => ({ product_id: lot.products[sku].id, quantity })),
  });
const lotOrder = (lines: [string, number][]): Promise<Row> => inLots((c) => createOrder(c, roles[lots], lotInput(lines)));
/** The order's custody and the tenant's layer positions and stock, without the order id. */
async function lotState(q: Query, orderId: string) {
  const own = [lot.tenant, orderId];
  return {
    picks: await q('SELECT product_id,quantity FROM order_pick_items WHERE tenant_id=$1 AND order_id=$2 ORDER BY 1', own),
    reservations: await q("SELECT product_id,quantity FROM reservations WHERE tenant_id=$1 AND order_id=$2 AND state='active' ORDER BY 1", own),
    located: await q(
      `SELECT l.product_id,l.location,l.quantity FROM reservation_locations l JOIN reservations r USING(tenant_id,order_id,product_id)
        WHERE l.tenant_id=$1 AND l.order_id=$2 AND r.state='active' ORDER BY 1,2`,
      own,
    ),
    layers: await q(
      "SELECT product_id,layer_id,location,quantity FROM wms_reservation_layers WHERE tenant_id=$1 AND order_id=$2 AND state='active' ORDER BY 1,2,3",
      own,
    ),
    positions: await q('SELECT product_id,layer_id,location,quantity,reserved FROM wms_layer_positions WHERE tenant_id=$1 ORDER BY 1,2,3', [lot.tenant]),
    stock: await q('SELECT product_id,on_hand,reserved FROM stock WHERE tenant_id=$1 ORDER BY 1', [lot.tenant]),
  };
}
/** What a fresh createOrder with these lines reserves now in place of the edited order, read inside
 * a transaction that cancels the edited order, creates the fresh one and is then rolled back. */
async function freshState(orderId: string, lines: [string, number][]) {
  const rollback = new Error('rollback');
  let state: unknown;
  await assert.rejects(
    inLots(async (c) => {
      await cancelOrder(c, roles[lots], orderId);
      const fresh = await createOrder(c, roles[lots], lotInput(lines));
      state = await lotState(async (sql, params) => (await c.query(sql, params)).rows, fresh.id);
      throw rollback;
    }),
    (e) => {
      if (e !== rollback) throw e;
      return true;
    },
  );
  return state;
}
async function assertLikeFresh(orderId: string, lines: [string, number][]) {
  assert.deepEqual(await lotState(fromPool, orderId), await freshState(orderId, lines));
}
const lotItem = (o: Row, sku: string) => o.items.find((i: Row) => i.product_id === lot.products[sku].id);

test('with WMS lots, add, raise, lower and remove reserve the layers a fresh order would, and cancel releases all', async () => {
  await lotsTenant();
  const P = lot.products['LOT-P'], Q = lot.products['LOT-Q'];
  const o = await lotOrder([['LOT-P', 2]]);
  const added = await ok('/orders/' + o.id + '/items', 'POST', { expected_version: String(o.version), product_id: Q.id, quantity: 2 }, lots);
  assert.equal(added.total, P.price * 2 + Q.price * 2);
  await assertLikeFresh(o.id, [['LOT-P', 2], ['LOT-Q', 2]]);
  // P had its whole first layer; the raise keeps it and takes 3 from the next layer, as FIFO does.
  const up = await ok('/orders/' + o.id + '/items/' + lotItem(o, 'LOT-P').id, 'PATCH', { expected_version: String(added.version), quantity: 5 }, lots);
  assert.equal(up.total, P.price * 5 + Q.price * 2);
  await assertLikeFresh(o.id, [['LOT-P', 5], ['LOT-Q', 2]]);
  const pLayers = (await lotState(fromPool, o.id)).layers.filter((l) => l.product_id === P.id);
  assert.deepEqual(pLayers.map((l) => l.quantity).sort(), [2, 3]);
  const down = await ok('/orders/' + o.id + '/items/' + lotItem(o, 'LOT-P').id, 'PATCH', { expected_version: String(up.version), quantity: 2 }, lots);
  await assertLikeFresh(o.id, [['LOT-P', 2], ['LOT-Q', 2]]);
  const removed = await ok('/orders/' + o.id + '/items/' + lotItem(added, 'LOT-Q').id + '?expected_version=' + down.version, 'DELETE', undefined, lots);
  assert.equal(removed.items.length, 1);
  assert.equal(removed.total, P.price * 2);
  await assertLikeFresh(o.id, [['LOT-P', 2]]);
  // Cancelling after the edits releases every layer the order ever held.
  await inLots((c) => cancelOrder(c, roles[lots], o.id));
  const after = await lotState(fromPool, o.id);
  assert.deepEqual(after.layers, []);
  assert(after.positions.every((p) => p.reserved === 0), JSON.stringify(after.positions));
  assert(after.stock.every((s) => s.reserved === 0), JSON.stringify(after.stock));
  assert.deepEqual(
    await fromPool('SELECT DISTINCT state FROM wms_reservation_layers WHERE tenant_id=$1 AND order_id=$2', [lot.tenant, o.id]),
    [{ state: 'released' }],
  );
});

/** The order's reservation layer rows of one product in every state, and its in-place resize records. */
async function lotRows(orderId: string, sku: string) {
  const own = [lot.tenant, orderId, lot.products[sku].id];
  return {
    rows: await fromPool(
      'SELECT layer_id,location,quantity,state FROM wms_reservation_layers WHERE tenant_id=$1 AND order_id=$2 AND product_id=$3 ORDER BY 1,2',
      own,
    ),
    resizes: Number((await fromPool('SELECT count(*) n FROM wms_order_line_resizes WHERE tenant_id=$1 AND order_id=$2 AND product_id=$3', own))[0].n),
  };
}

test('with WMS lots, raising and lowering one layer resizes its row in place like a fresh order, and cancel releases it', async () => {
  await lotsTenant();
  const R = lot.products['LOT-R'];
  const o = await lotOrder([['LOT-R', 1]]);
  const url = '/orders/' + o.id + '/items/' + lotItem(o, 'LOT-R').id;
  const [layer] = (await lotRows(o.id, 'LOT-R')).rows;
  const up = await ok(url, 'PATCH', { expected_version: String(o.version), quantity: 2 }, lots);
  assert.equal(up.total, R.price * 2);
  await assertLikeFresh(o.id, [['LOT-R', 2]]);
  assert.deepEqual(await lotRows(o.id, 'LOT-R'), { rows: [{ ...layer, quantity: 2 }], resizes: 1 });
  const down = await ok(url, 'PATCH', { expected_version: String(up.version), quantity: 1 }, lots);
  assert.equal(down.total, R.price);
  await assertLikeFresh(o.id, [['LOT-R', 1]]);
  assert.deepEqual(await lotRows(o.id, 'LOT-R'), { rows: [layer], resizes: 2 });
  // The resize record is immutable evidence, also for the table owner.
  await assert.rejects(pool.query('DELETE FROM wms_order_line_resizes WHERE tenant_id=$1 AND order_id=$2', [lot.tenant, o.id]), /niezmienny/);
  await inLots((c) => cancelOrder(c, roles[lots], o.id));
  const after = await lotState(fromPool, o.id);
  assert.deepEqual(after.layers, []);
  assert(after.positions.every((p) => p.reserved === 0), JSON.stringify(after.positions));
  assert(after.stock.every((s) => s.reserved === 0), JSON.stringify(after.stock));
  assert.deepEqual((await lotRows(o.id, 'LOT-R')).rows, [{ ...layer, state: 'released' }]);
});

test('with WMS lots, a layer released by a lowering is taken back by the next raise, like a fresh order', async () => {
  await lotsTenant();
  const o = await lotOrder([['LOT-P', 2]]);
  const url = '/orders/' + o.id + '/items/' + lotItem(o, 'LOT-P').id;
  let v = String(o.version);
  for (const quantity of [5, 2, 5, 3]) {
    v = String((await ok(url, 'PATCH', { expected_version: v, quantity }, lots)).version);
    await assertLikeFresh(o.id, [['LOT-P', quantity]]);
  }
  // The first layer (2) stays whole; the second row went 3, released, 3 again, then 1, never a second row.
  const { rows } = await lotRows(o.id, 'LOT-P');
  assert.deepEqual(rows.map((r) => [r.quantity, r.state]).sort(), [[1, 'active'], [2, 'active']]);
  await inLots((c) => cancelOrder(c, roles[lots], o.id));
  assert((await lotState(fromPool, o.id)).stock.every((s) => s.reserved === 0));
});

test('with WMS lots, too few layers, emptying a held bin and a re-add are refused and change nothing', async () => {
  await lotsTenant();
  const P = lot.products['LOT-P'], Q = lot.products['LOT-Q'];
  const o = await lotOrder([['LOT-R', 1], ['LOT-Q', 1], ['LOT-S', 2]]);
  const v = String(o.version), rUrl = '/orders/' + o.id + '/items/' + lotItem(o, 'LOT-R').id;
  const before = await lotState(fromPool, o.id);
  await refused(req(rUrl, 'PATCH', { expected_version: v, quantity: 4 }, lots), 409, /Za mało towaru|Brak dostępnych warstw/);
  await refused(req('/orders/' + o.id + '/items', 'POST', { expected_version: v, product_id: P.id, quantity: 13 }, lots), 409, /Za mało towaru|Brak dostępnych warstw/);
  // S holds 1 in A-01 and 1 in B-01; FIFO for 1 drops B-01, and a held reservation location never drops to zero.
  await refused(req('/orders/' + o.id + '/items/' + lotItem(o, 'LOT-S').id, 'PATCH', { expected_version: v, quantity: 1 }, lots), 409, /partiach WMS.*opróżniłby lokalizację/);
  assert.deepEqual(await lotState(fromPool, o.id), before);
  assert.equal((await inLots((c) => getOrder(c, o.id))).version, o.version);
  const removed = await ok('/orders/' + o.id + '/items/' + lotItem(o, 'LOT-Q').id + '?expected_version=' + v, 'DELETE', undefined, lots);
  await assertLikeFresh(o.id, [['LOT-R', 1], ['LOT-S', 2]]);
  await refused(
    req('/orders/' + o.id + '/items', 'POST', { expected_version: String(removed.version), product_id: Q.id, quantity: 1 }, lots),
    409,
    /usuniętego z zamówienia/,
  );
  await assertLikeFresh(o.id, [['LOT-R', 1], ['LOT-S', 2]]);
  // Picking still locks the lines.
  const paid = await inLots((c) => transition(c, roles[lots], o.id, 'paid', undefined, undefined, undefined, undefined, String(removed.version)));
  const picking = await inLots((c) => transition(c, roles[lots], o.id, 'picking', undefined, undefined, undefined, undefined, String(paid.version)));
  await refused(
    req('/orders/' + o.id + '/items', 'POST', { expected_version: String(picking.version), product_id: P.id, quantity: 1 }, lots),
    409,
    /przed rozpoczęciem kompletacji/,
  );
  await inLots((c) => cancelOrder(c, roles[lots], o.id));
  assert((await lotState(fromPool, o.id)).stock.every((s) => s.reserved === 0));
});
