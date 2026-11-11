/** Real Fastify injection + real developer key gate + real 220 sidecars + the native
 * shipments, shipping plans, stored tracking and channels for the four courier reads
 * (getOrderPackages, getPackageDetails, getCourierPackagesStatusHistory, getCouriersList).
 * Fixtures are the clone's own native shipments plus ONE createPackage (native shipDemo)
 * on an existing packed order; every expectation is read back from the native rows.
 * Root-only execution on a fresh disposable clone dynaminds_wireord2_20261023_NN made
 * with 218–221 by the guarded applier. The suite writes once, so a rerun requires a NEW clone.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { pool } from '../server/db';
import { tokenHash } from '../server/security';
import { authenticateBaseWireApiKey } from '../server/developer-api';
import { registerBaseWireRoutes } from '../server/base-wire-routes';
import { createBaseWireOrdersFamily } from '../server/base-wire-orders';
import { createDefaultBaseWireOrdersService } from '../server/base-wire-orders-runtime';
import { createBaseWireFulfillmentFamily, baseWireTrackingStatus } from '../server/base-wire-fulfillment';
import { createDefaultBaseWireFulfillmentService } from '../server/base-wire-fulfillment-runtime';
import { demoShipmentLabelInTx } from '../server/app';

assert.equal(process.env.DYNA_TEST, 'true', 'Explicit isolated test mode required');
const selected = new URL(process.env.DATABASE_URL ?? 'invalid://missing');
assert.equal(selected.hostname, '127.0.0.1');
assert.equal(selected.port, '57084');
assert.match(selected.pathname, /^\/dynaminds_wireord2_20261023_[0-9]{2}$/);
assert.equal(selected.username, 'postgres');
pool.options.query_timeout = 9000;
const KEY_NAME = 'Isolated wire fulfillment next test';
type Owner = { tenant: string; token: string };
let app: ReturnType<typeof Fastify>, a: Owner, aRead: Owner, b: Owner;
let inpost: { id: string; order: string; package_id: number; order_id: number };
let demo: { id: string; order: string; package_id: number; order_id: number };
async function key(tenant: string, scopes: string[]): Promise<Owner> {
  const user = (await pool.query("SELECT user_id FROM memberships WHERE tenant_id=$1 AND role='admin' ORDER BY user_id LIMIT 1", [tenant])).rows[0].user_id;
  const token = 'dyna_api_' + randomBytes(32).toString('hex');
  await pool.query(`INSERT INTO api_keys(id,tenant_id,user_id,name,token_hash,prefix,scopes,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,clock_timestamp()+interval '1 day')`, [randomUUID(), tenant, user, KEY_NAME, tokenHash(token), token.slice(0, 16), scopes]);
  return { tenant, token };
}
async function wire(owner: Owner, method: string, parameters: unknown) {
  return app.inject({ method: 'POST', url: '/connector.php', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-bltoken': owner.token },
    payload: new URLSearchParams({ method, parameters: JSON.stringify(parameters) }).toString() });
}
const success = (r: any) => { assert.equal(r.statusCode, 200, r.body); const d = r.json(); assert.equal(d.status, 'SUCCESS', r.body); return d; };
const refused = (r: any, status: number) => { assert.equal(r.statusCode, status, r.body); const d = r.json(); assert.equal(d.status, 'ERROR');
  assert.deepEqual(Object.keys(d).sort(), ['error_code', 'error_message', 'status']); assert(!/SELECT |stack|dyna_api_/.test(r.body)); return d; };
const orderPublic = async (local: string) => Number((await pool.query('SELECT public_id::text p FROM base_wire220_order_ids WHERE local_id=$1', [local])).rows[0].p);
const packagePublic = async (local: string) => Number((await pool.query('SELECT public_id::text p FROM base_wire220_package_ids WHERE local_id=$1', [local])).rows[0].p);
const epoch = (v: Date | string) => Math.floor(new Date(v).getTime() / 1000);
/** Independent expectation from the native rows (not the port's SQL). */
async function expectedPackages(order: string) {
  const rows = (await pool.query(`SELECT s.*,p.public_id::text public_id FROM shipments s JOIN base_wire220_package_ids p ON p.local_id=s.id
    WHERE s.order_id=$1 ORDER BY p.public_id`, [order])).rows;
  return rows.map(s => {
    const code = s.mode === 'demo' ? 'demo' : s.carrier === 'DPD Polska' ? 'dpd' : s.carrier === 'InPost ShipX' ? 'inpost' : '';
    return { package_id: Number(s.public_id), courier_package_nr: s.tracking_number,
      courier_inner_number: s.external_id && s.external_id !== s.tracking_number ? s.external_id : '', courier_code: code,
      courier_other_name: code ? '' : s.carrier.slice(0, 20), account_id: 0,
      tracking_status_date: epoch(s.tracking_data?.provider_updated_at ?? s.tracking_at ?? s.created_at), tracking_delivery_days: 0,
      tracking_status: baseWireTrackingStatus(s.status), package_type: 0, tracking_url: '', is_return: false };
  });
}

before(async () => {
  for (const name of ['base_wire220_order_ids', 'base_wire220_package_ids'])
    assert.notEqual((await pool.query('SELECT to_regclass($1) n', ['public.' + name])).rows[0].n, null, 'Clone needs committed 220: ' + name);
  assert.equal((await pool.query('SELECT count(*)::int n FROM api_keys WHERE name=$1', [KEY_NAME])).rows[0].n, 0, 'Fresh clone required; no rerun');
  // A: the company with a native InPost shipment that has a shipping plan and stored tracking.
  const tracked = (await pool.query(`SELECT s.id,s.tenant_id,s.order_id FROM shipments s JOIN shipping_plans p ON p.shipment_id=s.id
    WHERE s.tracking_data IS NOT NULL AND s.carrier='InPost ShipX' ORDER BY s.id LIMIT 1`)).rows[0];
  assert(tracked, 'Clone needs a native InPost shipment with plan and tracking');
  const other = (await pool.query(`SELECT s.tenant_id FROM shipments s WHERE s.tenant_id<>$1 AND EXISTS(SELECT 1 FROM memberships m WHERE m.tenant_id=s.tenant_id AND m.role='admin')
    GROUP BY 1 ORDER BY count(*) DESC,1 LIMIT 1`, [tracked.tenant_id])).rows[0];
  a = await key(tracked.tenant_id, ['orders:read', 'orders:write']); aRead = await key(tracked.tenant_id, ['orders:read']);
  b = await key(other.tenant_id, ['orders:read', 'orders:write']);
  inpost = { id: tracked.id, order: tracked.order_id, package_id: await packagePublic(tracked.id), order_id: await orderPublic(tracked.order_id) };
  app = Fastify();
  registerBaseWireRoutes(app, { readOnly: false, families: [
    createBaseWireOrdersFamily({ available: true, service: createDefaultBaseWireOrdersService({ readOnly: false, mergeClaims: true }) }),
    createBaseWireFulfillmentFamily({ available: true, pickListsAvailable: true, service: createDefaultBaseWireFulfillmentService({ demoLabel: demoShipmentLabelInTx, mergeClaims: true }) })],
    authenticate: (token, scope) => authenticateBaseWireApiKey(token, scope, true) });
  await app.ready();
  // The single write: Base createPackage (native shipDemo) on an existing packed order of A.
  const packed = (await pool.query(`SELECT o.id FROM orders o WHERE o.tenant_id=$1 AND o.status='packed' AND NOT EXISTS(SELECT 1 FROM shipments s WHERE s.order_id=o.id) ORDER BY o.id`, [a.tenant])).rows;
  for (const row of packed) {
    const order_id = await orderPublic(row.id);
    const r = await wire(a, 'createPackage', { order_id, courier_code: 'demo', packages: [{ weight: 2.25, size_length: 40, size_width: 30, size_height: '12.5' }] });
    if (r.statusCode !== 200) continue;
    demo = { id: (await pool.query('SELECT id FROM shipments WHERE order_id=$1', [row.id])).rows[0].id, order: row.id, package_id: r.json().package_id, order_id };
    break;
  }
  assert(demo, 'Clone needs a packed order of A accepted by native shipDemo');
});
after(async () => { await app?.close(); await pool.end(); });

test('getOrderPackages returns the native shipments of own orders (demo, simulated InPost, multi-parcel)', async () => {
  for (const x of [inpost, demo]) assert.deepEqual(success(await wire(aRead, 'getOrderPackages', { order_id: x.order_id })).packages, await expectedPackages(x.order));
  const got = success(await wire(aRead, 'getOrderPackages', { order_id: demo.order_id })).packages;
  assert.deepEqual([got.length, got[0].package_id, got[0].courier_code, got[0].tracking_status], [1, demo.package_id, 'demo', 1]);
  // A simulated InPost shipment (mode demo) is the demo courier, as in getLabel; its native status is delivered.
  assert.deepEqual(success(await wire(aRead, 'getOrderPackages', { order_id: inpost.order_id })).packages.map((p: any) => [p.courier_code, p.tracking_status]), [['demo', 5]]);
  // The other company's orders, including one with several parcels if the clone has it.
  const orders = (await pool.query('SELECT order_id FROM shipments WHERE tenant_id=$1 GROUP BY 1 ORDER BY count(*) DESC,1 LIMIT 3', [b.tenant])).rows;
  for (const { order_id } of orders) {
    const expected = await expectedPackages(order_id);
    assert.deepEqual(success(await wire(b, 'getOrderPackages', { order_id: await orderPublic(order_id) })).packages, expected);
    assert(expected.length >= 1);
  }
  // An own order without shipments: empty list, not 404.
  const bare = (await pool.query('SELECT o.id FROM orders o WHERE o.tenant_id=$1 AND NOT EXISTS(SELECT 1 FROM shipments s WHERE s.order_id=o.id) ORDER BY o.id LIMIT 1', [a.tenant])).rows[0];
  if (bare) assert.deepEqual(success(await wire(aRead, 'getOrderPackages', { order_id: await orderPublic(bare.id) })).packages, []);
  refused(await wire(aRead, 'getOrderPackages', { order_id: demo.order_id, with_history: 1 }), 422);
});

test('getPackageDetails matches the shipping plan (InPost) and the recorded createPackage parcel (demo)', async () => {
  const plan = (await pool.query('SELECT input,selected_offer FROM shipping_plans WHERE shipment_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1', [inpost.id])).rows[0];
  const s = (await pool.query('SELECT s.cod_expected,o.currency FROM shipments s JOIN orders o ON o.id=s.order_id WHERE s.id=$1', [inpost.id])).rows[0];
  const locker = plan.input.service === 'inpost_locker_standard';
  const d = success(await wire(aRead, 'getPackageDetails', { package_id: inpost.package_id }));
  assert.deepEqual(Object.keys(d).sort(), ['additional_fields', 'package_details', 'status']);
  assert.deepEqual(d.additional_fields, []);
  assert.deepEqual(d.package_details, [{ weight: plan.input.weight, weight_unit: 'kg',
    length: locker ? 0 : plan.input.dimensions.length / 10, width: locker ? 0 : plan.input.dimensions.width / 10, height: locker ? 0 : plan.input.dimensions.height / 10,
    size_unit: locker ? '' : 'cm', size_template: locker ? plan.input.template : '', is_custom: !locker,
    cod_value: s.cod_expected / 100, cod_currency: s.currency, insurance_value: plan.input.insurance / 100, insurance_currency: 'PLN',
    cost_value: plan.selected_offer?.rate == null ? 0 : plan.selected_offer.rate / 100, cost_currency: plan.selected_offer?.rate == null ? '' : plan.selected_offer.currency,
    type: '', pickup_date: 0, service: plan.input.service, additional_services: [], courier_packaging_type: '' }]);
  // Demo: the parcel recorded with the shipment in createPackage's own transaction.
  const recorded = (await pool.query(`SELECT e.detail FROM audit_events e JOIN shipments s ON s.id=e.entity_id AND s.created_at=e.created_at
    WHERE e.action='base_wire.package.created' AND e.entity_id=$1`, [demo.id])).rows;
  assert.deepEqual(recorded.map(r => r.detail.packages), [[{ weight: 2.25, size_length: 40, size_width: 30, size_height: 12.5 }]]);
  const dc = (await pool.query('SELECT s.cod_expected,o.currency FROM shipments s JOIN orders o ON o.id=s.order_id WHERE s.id=$1', [demo.id])).rows[0];
  assert.deepEqual(success(await wire(aRead, 'getPackageDetails', { package_id: demo.package_id })).package_details, [{ weight: 2.25, weight_unit: 'kg',
    length: 40, width: 30, height: 12.5, size_unit: 'cm', size_template: '', is_custom: true, cod_value: dc.cod_expected / 100, cod_currency: dc.currency,
    insurance_value: 0, insurance_currency: '', cost_value: 0, cost_currency: '', type: '', pickup_date: 0, service: '', additional_services: [], courier_packaging_type: '' }]);
  // A demo shipment made in the panel (no recorded parcel, no plan): units stay empty.
  const panel = (await pool.query(`SELECT s.id FROM shipments s WHERE s.tenant_id=$1 AND s.channel_id IS NULL AND s.id<>$2 AND NOT EXISTS(SELECT 1 FROM audit_events e
    WHERE e.entity_id=s.id AND e.action='base_wire.package.created') ORDER BY s.id LIMIT 1`, [b.tenant, demo.id])).rows[0];
  const pd = success(await wire(b, 'getPackageDetails', { package_id: await packagePublic(panel.id) })).package_details[0];
  assert.deepEqual([pd.weight, pd.weight_unit, pd.size_unit, pd.is_custom, pd.insurance_currency], [0, '', '', false, '']);
});

test('getCourierPackagesStatusHistory returns the stored native tracking events, no provider request', async () => {
  const td = (await pool.query('SELECT tracking_data FROM shipments WHERE id=$1', [inpost.id])).rows[0].tracking_data;
  assert(td.tracking_details.length >= 1);
  const expected = [...td.tracking_details].sort((x: any, y: any) => Date.parse(x.datetime) - Date.parse(y.datetime))
    .map((e: any) => ({ tracking_status_date: epoch(e.datetime), courier_status_code: e.code ?? e.status, tracking_status: baseWireTrackingStatus(e.status) }));
  const before = (await pool.query('SELECT tracking_revision,tracking_at FROM shipments WHERE id=$1', [inpost.id])).rows[0];
  const got = success(await wire(aRead, 'getCourierPackagesStatusHistory', { package_ids: [inpost.package_id, demo.package_id] }));
  assert.deepEqual(got.packages_history, { [inpost.package_id]: expected, [demo.package_id]: [] });
  // Read-only: no tracking read was started (revision/time unchanged).
  assert.deepEqual((await pool.query('SELECT tracking_revision,tracking_at FROM shipments WHERE id=$1', [inpost.id])).rows[0], before);
  refused(await wire(aRead, 'getCourierPackagesStatusHistory', { package_ids: [inpost.package_id, inpost.package_id] }), 422);
  refused(await wire(aRead, 'getCourierPackagesStatusHistory', { package_ids: Array.from({ length: 101 }, (_, i) => i + 1) }), 422);
});

test('foreign company: orders and packages are 404, the batch is all-or-nothing', async () => {
  const foreign = (await pool.query('SELECT id,order_id FROM shipments WHERE tenant_id=$1 ORDER BY id LIMIT 1', [b.tenant])).rows[0];
  const fp = await packagePublic(foreign.id);
  refused(await wire(b, 'getOrderPackages', { order_id: inpost.order_id }), 404);
  refused(await wire(b, 'getPackageDetails', { package_id: demo.package_id }), 404);
  refused(await wire(b, 'getCourierPackagesStatusHistory', { package_ids: [inpost.package_id] }), 404);
  refused(await wire(aRead, 'getOrderPackages', { order_id: await orderPublic(foreign.order_id) }), 404);
  refused(await wire(aRead, 'getPackageDetails', { package_id: fp }), 404);
  refused(await wire(aRead, 'getCourierPackagesStatusHistory', { package_ids: [inpost.package_id, fp] }), 404);
  refused(await wire(aRead, 'getOrderPackages', { order_id: Number.MAX_SAFE_INTEGER }), 404);
  // A merged source order is hidden as in getOrders (operational predicate).
  const merged = (await pool.query('SELECT tenant_id,source_order_id FROM order_merge_claims ORDER BY tenant_id,source_order_id LIMIT 1')).rows[0];
  if (merged) {
    const m = await key(merged.tenant_id, ['orders:read']), order_id = await orderPublic(merged.source_order_id);
    assert.deepEqual(success(await wire(m, 'getOrders', { order_id })).orders, []);
    refused(await wire(m, 'getOrderPackages', { order_id }), 404);
  }
});

test('getCouriersList: demo always, inpost/dpd only with a native shipping channel; read-only key suffices', async () => {
  for (const o of [aRead, b]) {
    const providers = (await pool.query("SELECT DISTINCT provider FROM channels WHERE tenant_id=$1 AND provider IN('inpost','dpd') ORDER BY provider", [o.tenant])).rows.map(r => r.provider);
    const names: Record<string, string> = { dpd: 'DPD Polska', inpost: 'InPost ShipX' };
    assert.deepEqual(success(await wire(o, 'getCouriersList', {})).couriers, [{ code: 'demo', name: 'Symulator lokalny' }, ...providers.map(code => ({ code, name: names[code] }))]);
  }
  assert.deepEqual(success(await wire(aRead, 'getCouriersList', {})).couriers.map((c: any) => c.code), ['demo', 'inpost']);
  refused(await wire(aRead, 'getCouriersList', { courier_code: 'demo' }), 422);
  // The read-only key is refused for writes only.
  refused(await wire(aRead, 'createPackage', { order_id: demo.order_id, courier_code: 'demo', packages: [{ weight: 1 }] }), 403);
});
