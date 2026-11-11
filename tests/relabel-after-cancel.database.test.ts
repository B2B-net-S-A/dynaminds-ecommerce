// "Automatyzacje - katalog" row 19: a new label after "Anuluj etykietę" (server/shipment-cancel.ts), migration 268.
// The cancelled label keeps its shipment row (status 'canceled') until a new label takes it over: the sealed order
// guards count every shipment row of an order (order_shipments_dispatch_guard 134/137, hashed by 158/159/160), so the
// order keeps one row and order_shipments_guard (268) moves the old identity to shipment268_replaced_labels.
// Full flows: DEMO, carrier accounts in simulation (DPD, InPost) and carrier APIs on the local fakes (DHL, Poczta
// Polska: sandbox, numbers from the provider): label → Anuluj etykietę → new label → label PDF → hand-over → shipped.
// Refusals: a cancelled label is never printed or handed over, cannot be revived, and its history is immutable.
import { legacySerialOrderStatusPayload } from './order-status-cas-helper';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../server/app';
import { pool, migrate, tenantTx } from '../server/db';
import { seed, DEMO_TENANT } from './fixtures';
import { Problem } from '../server/errors';
import { processDpd } from '../server/dpd-shipping';
import { processShipping, failShipping } from '../server/shipping';
import { processDhl } from '../server/dhl-shipping';
import { processPocztaPolska } from '../server/pocztapolska-shipping';
import { createDhlFake, DHL_FAKE_USER, DHL_FAKE_PASSWORD } from '../server/carrier-dhl-fake';
import { pocztaPolskaFake } from '../server/carrier-pocztapolska-fake';
import { relaxPoolTimeouts } from './failure-helpers';
assert.equal(process.env.DYNA_TEST, 'true');
relaxPoolTimeouts();

const GUARDS = ['ordinary187_valid', 'buyer_address_guards', 'order_merge_delivery209_valid', 'return_credit206_guards', 'ordinary188_structure_valid',
  'return_credit211_metadata_valid', 'large_import173_valid', 'fa3_draft_guards', 'pim_dictionary_valid', 'local_invoice_guards', 'warehouse_wz_issuer_guards',
  'email_inbound_guards', 'catalog_stock_control_guards', 'financial_return_guards', 'stocktake_adjustment_guards', 'warehouse_inventory_policy_guards',
  'catalog_stock_count_guards', 'catalog_stock_return_guards'];
const dhl = createDhlFake();
const pp = pocztaPolskaFake();
const transport = async (url: string, init: RequestInit) => {
  if (url.startsWith('https://sandbox.dhl24.com.pl/')) return dhl.transport(url, init);
  if (url.startsWith('https://en-testwebapi.poczta-polska.pl/')) return pp.transport(url, init);
  throw new Error('unexpected network ' + url);
};

let app: FastifyInstance, admin: string, warehouse: string, dhlChannel: string, ppChannel: string;
const req = (url: string, method: any = 'GET', payload?: any) => app.inject({ url, method, payload, headers: { cookie: admin } });
async function ok(url: string, method: any = 'GET', payload?: any) {
  const r = await req(url, method, payload);
  assert.ok(r.statusCode < 300, `${method} ${url}: ${r.statusCode} ${r.body}`);
  return r.json();
}
async function refused(url: string, method: any, payload: any, status: number, message: RegExp) {
  const r = await req(url, method, payload);
  assert.equal(r.statusCode, status, `${method} ${url}: ${r.body}`);
  assert.match(r.json().message ?? r.body, message, `${method} ${url}`);
}
async function guards() {
  const c = await pool.connect();
  try {
    await c.query('BEGIN READ ONLY');
    await c.query('SET LOCAL search_path TO "$user",public');
    await c.query("SET LOCAL statement_timeout='600s'");
    const out: Record<string, boolean> = {};
    for (const g of GUARDS) out[g] = (await c.query(`SELECT public.${g}() v`)).rows[0].v;
    await c.query('ROLLBACK');
    return out;
  } finally {
    c.release();
  }
}
const allTrue = Object.fromEntries(GUARDS.map((g) => [g, true]));
before(async () => {
  await migrate();
  await seed();
  assert.deepEqual(await guards(), allTrue, 'guards before');
  app = await buildApp({ integrationTransport: transport });
  const r = await app.inject({ url: '/api/auth/login', method: 'POST', payload: { email: 'admin@demo.local', password: 'DynaDemo!2026' } });
  assert.equal(r.statusCode, 200, r.body);
  admin = r.headers['set-cookie']!.toString().split(';')[0];
  warehouse = (await ok('/api/warehouses')).data[0].id;
  dhlChannel = (await ok('/api/integrations', 'POST', {
    provider: 'dhl', name: 'DHL relabel', mode: 'sandbox', credentials: { username: DHL_FAKE_USER, password: DHL_FAKE_PASSWORD }, settings: { sap_account: '1234567' },
  })).id;
  ppChannel = (await ok('/api/integrations', 'POST', {
    provider: 'pocztapolska', name: 'Poczta Polska relabel', mode: 'sandbox', credentials: pp.credentials, settings: { urzad_nadania: pp.settings.urzad_nadania },
  })).id;
});
after(async () => {
  assert.deepEqual(await guards(), allTrue, 'guards after');
  await app.close();
  await pool.end();
});

const party = { name: 'QA Etykieta', address: 'Testowa 1', city: 'Warszawa', postalCode: '01-354', phone: '500600700', email: 'qa@example.test' };
const NRB = '61109010140000071219812874';
/** A packed COD order of 2 × 50 zł (amount due 10 000 gr). */
async function packed() {
  const product = await ok('/api/products', 'POST', { sku: 'RL-' + randomUUID().slice(0, 10), name: 'Etykieta', price: 5000, vat: 23, warehouse_id: warehouse, quantity: 10 });
  const order = await ok('/api/orders', 'POST', {
    customer_name: party.name, payment_mode: 'cod', email: party.email, warehouse_id: warehouse,
    address: { street: party.address, city: party.city, postal_code: party.postalCode, country: 'PL', phone: party.phone },
    items: [{ product_id: product.id, quantity: 2 }],
  });
  const status = async (s: string) =>
    ok(`/api/orders/${order.id}/status`, 'PATCH', await legacySerialOrderStatusPayload((p) => req(p), `/api/orders/${order.id}/status`, { status: s }));
  await status('picking');
  for (let n = 0; n < 2; n++) await ok(`/api/orders/${order.id}/scan`, 'POST', { code: product.sku });
  await status('packed');
  return { o: await ok('/api/orders/' + order.id), p: product };
}
const carrierInput = (ch: string) => ({ channel_id: ch, sender: party, receiver: party, weight: 1.25, dimensions: { length: 20, width: 15, height: 10 }, content: 'Towar testowy', cod: 10000, insurance: 10000 });
const confirm = { confirm_external: true, ack_contract_rate: true };
const shipments = async (orderId: string) =>
  (await pool.query('SELECT * FROM shipments WHERE order_id=$1 ORDER BY created_at,id', [orderId])).rows;
const replaced = async (orderId: string) =>
  (await pool.query('SELECT * FROM shipment268_replaced_labels WHERE order_id=$1 ORDER BY replaced_at,id', [orderId])).rows;
const plan = (id: string) => tenantTx(DEMO_TENANT, async (c) => (await c.query('SELECT * FROM shipping_plans WHERE id=$1', [id])).rows[0]);
async function lease(jobId: string) {
  return (await pool.query("UPDATE jobs SET state='running',lease_token=$2,attempts=attempts+1,locked_at=now() WHERE id=$1 RETURNING *", [jobId, randomUUID()])).rows[0];
}
async function run(kind: 'dpd' | 'inpost' | 'dhl' | 'pp', jobId: string) {
  const job = await lease(jobId);
  try {
    if (kind === 'dpd') await processDpd(job, { transport: async () => assert.fail('simulation makes no HTTP call') });
    else if (kind === 'inpost') await processShipping(job, { transport: async () => assert.fail('simulation makes no HTTP call') });
    else if (kind === 'dhl') await processDhl(job, { transport });
    else await processPocztaPolska(job, { transport });
  } catch (e) {
    if (!(e instanceof Problem)) throw e;
    await failShipping(job, e);
    throw e;
  }
}
/** DPD in simulation: preview → queue → job; returns the plan. */
async function dpdLabel(orderId: string) {
  const ch = (await ok('/api/dpd-shipping/example', 'POST', {})).channel_id;
  const preview = await ok(`/api/orders/${orderId}/dpd-shipping/preview`, 'POST', carrierInput(ch));
  await run('dpd', (await ok(`/api/dpd-shipping/${preview.id}/queue`, 'POST', confirm)).job_id);
  return plan(preview.id);
}
/** The order's single shipment, the order stage and the label PDF of the new label. */
async function assertNewLabel(orderId: string, shipmentId: string, carrier: string, oldTracking: string) {
  const rows = await shipments(orderId);
  assert.equal(rows.length, 1, 'the new label took over the cancelled row');
  assert.equal(rows[0].id, shipmentId);
  assert.equal(rows[0].carrier, carrier);
  assert.notEqual(rows[0].status, 'canceled');
  assert.notEqual(rows[0].tracking_number, oldTracking);
  assert.equal(rows[0].dispatched_at, null);
  const o = await ok('/api/orders/' + orderId);
  assert.deepEqual([o.status, o.fulfilment_stage], ['packed', 'ready_to_ship']);
  assert.equal(o.replaced_labels.at(-1).tracking_number, oldTracking, 'the cancelled label stays in the order history');
  assert.equal(o.replaced_labels.at(-1).replaced_by, rows[0].tracking_number);
  const label = await req('/api/shipments/' + shipmentId + '/label');
  assert.equal(label.statusCode, 200, label.body);
  // A DEMO or simulation label is the local HTML label with the new number; a provider label is its stored PDF.
  if (rows[0].mode === 'demo') {
    assert.match(String(label.headers['content-type']), /text\/html/);
    assert(label.body.includes(rows[0].tracking_number) && !label.body.includes(oldTracking), 'the new number, never the cancelled one');
  } else assert.equal(label.rawPayload.subarray(0, 5).toString(), '%PDF-');
  return rows[0];
}
const shipped = async (orderId: string) => {
  const o = await ok('/api/orders/' + orderId);
  assert.equal(o.status, 'shipped');
  const rows = await shipments(orderId);
  assert.equal(rows.length, 1);
  assert.ok(rows[0].dispatched_at, 'the new label was handed over');
};

test('DEMO: label → Anuluj etykietę → Nowa etykieta DEMO → Przekaż kurierowi → shipped; cancelling twice keeps both labels in history', async () => {
  const { o } = await packed();
  await ok(`/api/orders/${o.id}/demo-label`, 'POST', {});
  const [first] = await shipments(o.id);
  const c = await ok(`/api/orders/${o.id}/cancel-label`, 'POST', {});
  assert.deepEqual([c.status, c.fulfilment_stage], ['packed', 'packed']);
  // The cancelled label is neither handed over nor printed.
  await refused(`/api/orders/${o.id}/ship-demo`, 'POST', {}, 409, /utwórz nową etykietę/);
  await refused(`/api/shipments/${first.id}/label`, 'GET', undefined, 409, /anulowana/);
  await ok(`/api/orders/${o.id}/demo-label`, 'POST', {});
  const second = await assertNewLabel(o.id, first.id, 'Symulator lokalny', first.tracking_number);
  // A second cancellation and a third label: both cancelled labels stay in the history, oldest first.
  await ok(`/api/orders/${o.id}/cancel-label`, 'POST', {});
  await ok(`/api/orders/${o.id}/demo-label`, 'POST', {});
  const third = await assertNewLabel(o.id, first.id, 'Symulator lokalny', second.tracking_number);
  assert.deepEqual((await replaced(o.id)).map((r) => [r.tracking_number, r.replaced_by]), [
    [first.tracking_number, second.tracking_number],
    [second.tracking_number, third.tracking_number],
  ]);
  await ok(`/api/orders/${o.id}/ship-demo`, 'POST', {});
  await shipped(o.id);
});

test('carrier account in simulation (DPD): label → Anuluj etykietę → new DPD label → hand-over → shipped', async () => {
  const { o } = await packed();
  const p1 = await dpdLabel(o.id);
  assert.equal(p1.state, 'ready');
  const [first] = await shipments(o.id);
  await ok(`/api/orders/${o.id}/cancel-label`, 'POST', {});
  assert.equal((await plan(p1.id)).state, 'cancelled');
  const p2 = await dpdLabel(o.id);
  assert.equal(p2.state, 'ready');
  assert.equal(p2.shipment_id, first.id, 'the new plan binds the row it took over');
  await assertNewLabel(o.id, first.id, 'DPD Polska', first.tracking_number);
  await ok(`/api/dpd-shipping/${p2.id}/dispatch`, 'POST', {});
  await shipped(o.id);
});

test('carrier account in simulation (InPost): DEMO label cancelled → InPost label (create, buy) → hand-over → shipped', async () => {
  const { o } = await packed();
  await ok(`/api/orders/${o.id}/demo-label`, 'POST', {});
  const [first] = await shipments(o.id);
  await ok(`/api/orders/${o.id}/cancel-label`, 'POST', {});
  const ch = (await ok('/api/shipping/example', 'POST', {})).id;
  const preview = await ok(`/api/orders/${o.id}/shipping/preview`, 'POST', {
    channel_id: ch, service: 'inpost_locker_standard', target_point: 'WAW01A', template: 'small', weight: 1, cod: 10000, insurance: 10000,
    receiver: { first_name: 'Kupujący', last_name: 'QA', email: 'buyer@example.test', phone: '500600700' },
  });
  await run('inpost', (await ok(`/api/shipping-plans/${preview.id}/queue`, 'POST', {})).job_id);
  const quoted = await plan(preview.id);
  await run('inpost', (await ok(`/api/shipping-plans/${preview.id}/buy`, 'POST', { offer_id: quoted.offers[0].id, confirm_cost: true, ack_unknown_rate: true })).job_id);
  const ready = await plan(preview.id);
  assert.equal(ready.state, 'ready');
  assert.equal(ready.shipment_id, first.id);
  await assertNewLabel(o.id, first.id, 'InPost ShipX', first.tracking_number);
  await ok(`/api/shipping-plans/${preview.id}/dispatch`, 'POST', {});
  await shipped(o.id);
});

test('carrier APIs (DHL, Poczta Polska on the local fakes, sandbox): DEMO label cancelled → provider label → PDF → hand-over → shipped', async () => {
  for (const carrier of [
    { kind: 'dhl' as const, base: 'dhl-shipping', name: 'DHL Parcel Polska', input: () => ({ ...carrierInput(dhlChannel), cod_bank_account: NRB }) },
    { kind: 'pp' as const, base: 'pocztapolska-shipping', name: 'Poczta Polska', input: () => ({ ...carrierInput(ppChannel), service: 'pocztex_kurier', cod_account: 'PL ' + NRB }) },
  ]) {
    const { o } = await packed();
    await ok(`/api/orders/${o.id}/demo-label`, 'POST', {});
    const [first] = await shipments(o.id);
    await ok(`/api/orders/${o.id}/cancel-label`, 'POST', {});
    const preview = await ok(`/api/orders/${o.id}/${carrier.base}/preview`, 'POST', carrier.input());
    await run(carrier.kind, (await ok(`/api/${carrier.base}/${preview.id}/queue`, 'POST', confirm)).job_id);
    const p = await plan(preview.id);
    assert.equal(p.state, 'ready', carrier.name);
    assert.equal(p.shipment_id, first.id);
    const s = await assertNewLabel(o.id, first.id, carrier.name, first.tracking_number);
    assert.equal(s.mode, 'sandbox');
    assert.equal(s.tracking_number, p.remote_id, 'the provider number');
    assert.equal(Number(s.cod_expected), 10000);
    await ok(`/api/${carrier.base}/${preview.id}/dispatch`, 'POST', {});
    await shipped(o.id);
  }
});

test('refusals: a live label blocks a new one; a cancelled label is no parcel; the cancelled one is never revived, handed over or rewritten', async () => {
  const { o, p } = await packed();
  await ok(`/api/orders/${o.id}/demo-label`, 'POST', {});
  await refused(`/api/orders/${o.id}/demo-label`, 'POST', {}, 409, /Najpierw|ma już etykietę/);
  const label = (await shipments(o.id))[0];
  // A parcel preview made before Anuluj etykietę cannot be applied with the cancelled label as a parcel.
  const source = (await ok(`/api/order-parcels/orders/${o.id}/source`)).source;
  const preview = (await ok(`/api/order-parcels/orders/${o.id}/previews`, 'POST', {
    client_key: randomUUID(), order_version: source.order.version, parcels: [
      { source_kind: 'existing', shipment_id: label.id, cod_minor: label.cod_expected, products: [{ product_id: p.id, quantity: 1 }] },
      { source_kind: 'demo', cod_minor: 10000 - label.cod_expected, products: [{ product_id: p.id, quantity: 1 }] },
    ],
  })).preview;
  await ok(`/api/orders/${o.id}/cancel-label`, 'POST', {});
  await refused(`/api/order-parcels/previews/${preview.id}/apply`, 'POST', { client_key: randomUUID(), scope_hash: preview.scope_hash, confirmed: true }, 409, /anulowanej etykiety nie można przydzielić do planu paczek/);
  // The database itself (order_shipments_guard 268), whatever the application does.
  const c = await pool.connect();
  const attempt = async (sql: string, args: unknown[]) => {
    await c.query('SAVEPOINT s');
    try {
      await c.query(sql, args);
      await c.query('RELEASE SAVEPOINT s');
      return 'ok';
    } catch (e) {
      await c.query('ROLLBACK TO SAVEPOINT s');
      return (e as Error).message;
    }
  };
  try {
    await c.query('BEGIN');
    const REPLACE = 'Anulowaną etykietę zastępuje tylko nowa etykieta przed nadaniem';
    assert.equal(await attempt("UPDATE shipments SET status='created' WHERE id=$1", [label.id]), REPLACE, 'no revival of the cancelled label');
    assert.equal(await attempt('UPDATE shipments SET dispatched_at=now() WHERE id=$1', [label.id]), 'Anulowanej etykiety nie można wydać');
    assert.equal(await attempt("UPDATE shipments SET status='created',tracking_number='DEMO-NEW-1',dispatched_at=now() WHERE id=$1", [label.id]), REPLACE, 'no new label handed over in the same step');
    const other = (await packed()).o;
    assert.equal(await attempt("UPDATE shipments SET status='created',tracking_number='DEMO-NEW-2',order_id=$2 WHERE id=$1", [label.id, other.id]), REPLACE, 'never moved to another order');
    assert.match(await attempt("UPDATE shipments SET status='created',tracking_number='DEMO-NEW-3',carrier='' WHERE id=$1", [label.id]), /jawnej tożsamości przewoźnika/, 'the new label passes the checks of an inserted one');
    // A valid replacement writes the history, which is immutable.
    assert.equal(await attempt("UPDATE shipments SET status='created',tracking_number='DEMO-NEW-4' WHERE id=$1", [label.id]), 'ok');
    const h = (await c.query('SELECT id,tracking_number,replaced_by FROM shipment268_replaced_labels WHERE shipment_id=$1', [label.id])).rows;
    assert.deepEqual(h.map((r) => [r.tracking_number, r.replaced_by]), [[label.tracking_number, 'DEMO-NEW-4']]);
    assert.equal(await attempt("UPDATE shipment268_replaced_labels SET tracking_number='X' WHERE id=$1", [h[0].id]), 'Historia zastąpionych etykiet jest niezmienna');
    assert.equal(await attempt('DELETE FROM shipment268_replaced_labels WHERE id=$1', [h[0].id]), 'Historia zastąpionych etykiet jest niezmienna');
    // The cancelled number never comes back: not after a second cancellation on the same row, not on another order.
    const REVIVE = 'Numer anulowanej etykiety nie wraca do obiegu';
    assert.equal(await attempt("UPDATE shipments SET status='canceled' WHERE id=$1", [label.id]), 'ok');
    assert.equal(await attempt("UPDATE shipments SET status='created',tracking_number=$2 WHERE id=$1", [label.id, label.tracking_number]), REVIVE);
    assert.equal(await attempt(
      "INSERT INTO shipments(id,tenant_id,order_id,carrier,tracking_number,mode,cod_expected) VALUES($1,$2,$3,$4,$5,'demo',0)",
      [randomUUID(), DEMO_TENANT, other.id, label.carrier, label.tracking_number],
    ), REVIVE);
    // The application role only reads its tenant's history.
    await c.query('SET LOCAL ROLE dyna_app');
    assert.match(await attempt(
      "INSERT INTO shipment268_replaced_labels(tenant_id,shipment_id,order_id,carrier,tracking_number,mode,cod_expected,label_created_at,replaced_by) VALUES($1,$2,$3,'x','y','demo',0,now(),'z')",
      [DEMO_TENANT, label.id, o.id],
    ), /permission denied/);
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
  assert.equal((await shipments(o.id))[0].status, 'canceled', 'the rolled back attempts changed nothing');
});
