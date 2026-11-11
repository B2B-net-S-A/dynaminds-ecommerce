/** Real Fastify injection + real developer key gate + real 220 sidecars + the
 * native OMS/WMS/shipping (createOrder, picking waves, shipDemo, the demo label page).
 * Root-only execution on a fresh disposable clone dynaminds_wirefulfil_20261023_NN made
 * from the clean 217+218+219 template with 220 applied by the guarded applier (nine
 * native guards before and after). The suite writes, so a rerun requires a NEW clone.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { pool, tenantTx } from '../server/db';
import { tokenHash } from '../server/security';
import { authenticateBaseWireApiKey } from '../server/developer-api';
import { registerBaseWireRoutes } from '../server/base-wire-routes';
import { createBaseWireOrdersFamily } from '../server/base-wire-orders';
import { createDefaultBaseWireOrdersService } from '../server/base-wire-orders-runtime';
import { createBaseWireFulfillmentFamily, baseWirePickListId } from '../server/base-wire-fulfillment';
import { createDefaultBaseWireFulfillmentService } from '../server/base-wire-fulfillment-runtime';
import { demoShipmentLabelInTx } from '../server/app';
import { createProduct } from '../server/catalog';
import { productSchema, type Actor } from '../server/domain';
import { scanWave } from '../server/picking-waves';
import { transitionDirectLegacyOnReturnInTx } from '../server/legacy-return-on-command';

assert.equal(process.env.DYNA_TEST, 'true', 'Explicit isolated test mode required');
const selected = new URL(process.env.DATABASE_URL ?? 'invalid://missing');
assert.equal(selected.hostname, '127.0.0.1');
assert.equal(selected.port, '57084');
assert.match(selected.pathname, /^\/dynaminds_wirefulfil_20261023_[0-9]{2}$/);
assert.equal(selected.username, 'postgres');
pool.options.query_timeout = 9000;
type Owner = { tenant: string; user: string; catalog: string; warehouse: string; currency: string; token: string; actor: Actor };
let app: ReturnType<typeof Fastify>, a: Owner, b: Owner, readOnlyKey: Owner;
async function key(row: { tenant_id: string; user_id: string; catalog: string; warehouse: string; currency: string }, scopes: string[]): Promise<Owner> {
  const token = 'dyna_api_' + randomBytes(32).toString('hex'), id = randomUUID();
  await pool.query(`INSERT INTO api_keys(id,tenant_id,user_id,name,token_hash,prefix,scopes,expires_at)
    VALUES($1,$2,$3,'Isolated wire fulfillment test',$4,$5,$6,clock_timestamp()+interval '1 day')`, [id, row.tenant_id, row.user_id, tokenHash(token), token.slice(0, 16), scopes]);
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
const count = async (sql: string, params: unknown[]) => (await pool.query(`SELECT count(*)::int n FROM ${sql}`, params)).rows[0].n as number;
async function nativeProduct(o: Owner, sku: string, quantity: number) {
  return tenantTx(o.tenant, c => createProduct(c, o.actor, productSchema.parse({ name: 'Produkt ' + sku, sku, price: 1999, vat: 23, catalog_id: o.catalog, warehouse_id: o.warehouse, quantity })));
}
/** Base addOrder (paid=1): a paid native order with reservations, eligible for a picking wave. */
async function baseOrder(o: Owner, sku: string) {
  const p = await nativeProduct(o, sku, 10);
  const pid = await publicId('base_wire220_product_ids', o.tenant, p.id), wid = await publicId('base_wire220_warehouse_ids', o.tenant, o.warehouse);
  const order = success(await wire(o, 'addOrder', { delivery_fullname: 'Jan Base', email: 'base@example.com', phone: '500600700', delivery_address: 'Prosta 1',
    delivery_postcode: '00-001', delivery_city: 'Warszawa', delivery_country_code: 'PL', currency: o.currency, paid: 1,
    products: [{ storage: 'db', product_id: String(pid), warehouse_id: wid, price_brutto: 25.5, tax_rate: 23, quantity: 2 }] })).order_id as number;
  return { order, local: await localOrder(o.tenant, order), sku, product: p.id };
}

before(async () => {
  for (const name of ['base_wire220_order_ids', 'base_wire220_package_ids', 'base_wire220_product_ids', 'base_wire220_warehouse_ids'])
    assert.notEqual((await pool.query('SELECT to_regclass($1) n', ['public.' + name])).rows[0].n, null, 'Clone needs committed 220: ' + name);
  assert.equal((await pool.query("SELECT count(*)::int n FROM api_keys WHERE name='Isolated wire fulfillment test'")).rows[0].n, 0, 'Fresh clone required; no rerun');
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
    createBaseWireFulfillmentFamily({ available: true, pickListsAvailable: true, service: createDefaultBaseWireFulfillmentService({ demoLabel: demoShipmentLabelInTx }) })],
    authenticate: (token, scope) => authenticateBaseWireApiKey(token, scope, true) });
  await app.ready();
});
after(async () => { await app?.close(); await pool.end(); });

test('getOrderSources lists personal and the own native order-source channels only', async () => {
  for (const o of [a, b]) {
    const got = success(await wire(o, 'getOrderSources', {})).sources;
    const channels = (await pool.query(`SELECT provider,array_agg(name ORDER BY name,id) names FROM channels WHERE tenant_id=$1
      AND provider IN('allegro','woocommerce','prestashop','shopify','odoo','ebay','amazon','mirakl') GROUP BY provider`, [o.tenant])).rows;
    const expected: Record<string, unknown> = { personal: { '0': 'Osobiście / telefonicznie' } };
    for (const c of channels) expected[c.provider] = { '0': c.names.join(', ') };
    if (await count('b2b_accounts WHERE tenant_id=$1', [o.tenant])) expected.b2b = { '0': 'B2B' };
    assert.deepEqual(got, expected);
  }
  success(await wire(readOnlyKey, 'getOrderSources', {}));
});

test('Base addOrder -> addOrderPickList -> native wave -> createPackage -> getLabel, replay-safe and isolated', async () => {
  const x = await baseOrder(a, 'WF-' + randomBytes(4).toString('hex'));
  // A read-only key and the second tenant cannot create a pick list; nothing happens.
  refused(await wire(readOnlyKey, 'addOrderPickList', { order_ids: [x.order] }), 403);
  refused(await wire(b, 'addOrderPickList', { order_ids: [x.order] }), 404);
  assert.equal(await count('picking_wave_orders WHERE order_id=$1', [x.local]), 0);
  const listKey = randomUUID();
  const list = success(await wire(a, 'addOrderPickList', { order_ids: [x.order] }, { 'idempotency-key': listKey }));
  assert.deepEqual(Object.keys(list).sort(), ['pick_list_id', 'status']);
  const wave = (await pool.query(`SELECT w.id,w.state,w.name,w.warehouse_id,w.tenant_id FROM picking_wave_orders m JOIN picking_waves w ON w.id=m.wave_id
    WHERE m.order_id=$1 AND m.active`, [x.local])).rows;
  assert.equal(wave.length, 1, 'native wave contains the order');
  assert.deepEqual({ ...wave[0], id: undefined }, { id: undefined, state: 'picking', name: 'Lista Base API', warehouse_id: a.warehouse, tenant_id: a.tenant });
  assert.equal(list.pick_list_id, baseWirePickListId(wave[0].id));
  assert.equal((await pool.query('SELECT status FROM orders WHERE id=$1', [x.local])).rows[0].status, 'picking');
  // Lost-ACK replay: same pick_list_id, no second wave; another body under the key is 409.
  assert.deepEqual(success(await wire(a, 'addOrderPickList', { order_ids: [x.order] }, { 'idempotency-key': listKey })), list);
  assert.equal(await count('picking_wave_orders WHERE order_id=$1', [x.local]), 1);
  refused(await wire(a, 'addOrderPickList', { order_ids: [x.order, x.order + 1] }, { 'idempotency-key': listKey }), 409);
  // Without a key the native rule refuses an order already in an open wave.
  refused(await wire(a, 'addOrderPickList', { order_ids: [x.order] }), 409);

  // Native picking and packing (the same functions as the wave scanner and the status action).
  const location = (await pool.query('SELECT location FROM reservation_locations WHERE order_id=$1', [x.local])).rows[0].location;
  for (let n = 0; n < 2; n++) await tenantTx(a.tenant, async c => {
    const version = (await c.query('SELECT version::text v FROM picking_waves WHERE id=$1', [wave[0].id])).rows[0].v;
    await scanWave(c, a.actor, wave[0].id, { version, code: x.sku, location, client_key: randomUUID() });
  });
  await tenantTx(a.tenant, async c => transitionDirectLegacyOnReturnInTx(c, a.actor, x.local, 'packed',
    (await c.query('SELECT version::text v FROM orders WHERE id=$1', [x.local])).rows[0].v));

  // createPackage: async couriers and foreign/read-only callers have no effect.
  const parcel = { order_id: x.order, courier_code: 'demo', packages: [{ weight: 1.2, size_length: 30, size_width: 20, size_height: 10 }] };
  assert.equal(refused(await wire(a, 'createPackage', { ...parcel, courier_code: 'inpost' }), 422).error_code, 'LOCAL_BASE_WIRE_COURIER_ASYNC');
  refused(await wire(readOnlyKey, 'createPackage', parcel), 403);
  refused(await wire(b, 'createPackage', parcel), 404);
  refused(await wire(a, 'createPackage', { ...parcel, fields: [{ id: 'cod', value: '1' }] }), 422);
  assert.equal(await count('shipments WHERE order_id=$1', [x.local]), 0);
  const shipKey = randomUUID();
  const pkg = success(await wire(a, 'createPackage', parcel, { 'idempotency-key': shipKey }));
  const shipments = (await pool.query('SELECT id,tracking_number,mode,carrier FROM shipments WHERE order_id=$1', [x.local])).rows;
  assert.equal(shipments.length, 1, 'one native shipment');
  assert.deepEqual({ mode: shipments[0].mode, carrier: shipments[0].carrier }, { mode: 'demo', carrier: 'Symulator lokalny' });
  assert.equal(pkg.package_id, await publicId('base_wire220_package_ids', a.tenant, shipments[0].id), 'returned id is the native 220 package id');
  assert.equal(pkg.package_number, shipments[0].tracking_number);
  assert.deepEqual(pkg.packages, [{ package_id: pkg.package_id, package_number: pkg.package_number, courier_inner_number: '' }]);
  assert.equal((await pool.query('SELECT status FROM orders WHERE id=$1', [x.local])).rows[0].status, 'shipped');
  assert.deepEqual((await pool.query("SELECT detail FROM audit_events WHERE action='base_wire.package.created' AND entity_id=$1", [shipments[0].id])).rows.map(r => r.detail),
    [{ courier_code: 'demo', packages: [{ weight: 1.2, size_length: 30, size_width: 20, size_height: 10 }] }]);
  // Replay: same response, still one shipment; without the key the native rule refuses a second one.
  assert.deepEqual(success(await wire(a, 'createPackage', parcel, { 'idempotency-key': shipKey })), pkg);
  refused(await wire(a, 'createPackage', parcel), 409);
  assert.equal(await count('shipments WHERE order_id=$1', [x.local]), 1);
  // Base getOrders sees the native shipment.
  const dto = success(await wire(a, 'getOrders', { order_id: x.order })).orders[0];
  assert.deepEqual([dto.delivery_package_module, dto.delivery_package_nr], ['Symulator lokalny', pkg.package_number]);

  // getLabel: base64 of the native demo label page, by id or by number, own courier only.
  const native = await tenantTx(a.tenant, c => demoShipmentLabelInTx(c, a.tenant, shipments[0].id));
  for (const selector of [{ package_id: pkg.package_id }, { package_number: pkg.package_number }, { package_id: pkg.package_id, package_number: pkg.package_number }]) {
    const got = success(await wire(readOnlyKey, 'getLabel', { courier_code: 'demo', ...selector }));
    assert.deepEqual(Object.keys(got).sort(), ['extension', 'label', 'status']);
    assert.equal(got.extension, 'html');
    const html = Buffer.from(got.label, 'base64').toString('utf8');
    assert.equal(html, native);
    assert(html.includes('ETYKIETA TESTOWA') && html.includes(pkg.package_number) && html.includes('Jan Base'));
  }
  refused(await wire(b, 'getLabel', { courier_code: 'demo', package_id: pkg.package_id }), 404);
  refused(await wire(a, 'getLabel', { courier_code: 'dpd', package_id: pkg.package_id }), 404);
  refused(await wire(a, 'getLabel', { courier_code: 'demo', package_id: pkg.package_id, package_number: 'DEMO-OBCY' }), 404);
});
