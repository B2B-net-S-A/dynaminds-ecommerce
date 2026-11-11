// "Automatyzacje - katalog" row 19: a new label after "Anuluj etykietę" (server/shipment-cancel.ts).
// The cancelled label keeps its permanent shipment row (status 'canceled'). The sealed shipment guards
// (order_shipments_guard 234, order_shipments_dispatch_guard 134/137) count every shipment row of an order,
// and the explicit parcel plan (134/136) needs 2+ parcels that include every existing shipment, so a second
// label of the same order could be created but never handed to the courier. Every label path refuses it up
// front, in Polish, before a label is bought; this test also pins the database refusals that make it so.
import { legacySerialOrderStatusPayload } from './order-status-cas-helper';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../server/app';
import { pool, migrate } from '../server/db';
import { seed, DEMO_TENANT } from './fixtures';
import { processDpd } from '../server/dpd-shipping';
assert.equal(process.env.DYNA_TEST, 'true');

let app: FastifyInstance, admin: string, warehouse: string;
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
before(async () => {
  await migrate();
  await seed();
  app = await buildApp();
  const r = await app.inject({ url: '/api/auth/login', method: 'POST', payload: { email: 'admin@demo.local', password: 'DynaDemo!2026' } });
  assert.equal(r.statusCode, 200, r.body);
  admin = r.headers['set-cookie']!.toString().split(';')[0];
  warehouse = (await ok('/api/warehouses')).data[0].id;
});
after(async () => {
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
const RELABEL = /Etykietę tego zamówienia anulowano/;
const carrierInput = (ch: string) => ({ channel_id: ch, sender: party, receiver: party, weight: 1.25, dimensions: { length: 20, width: 15, height: 10 }, content: 'Towar testowy', cod: 10000, insurance: 10000 });
const inpostInput = (ch: string) => ({
  channel_id: ch, service: 'inpost_locker_standard', target_point: 'WAW01A', cod: 10000, insurance: 10000,
  receiver: { first_name: 'Kupujący', last_name: 'QA', email: 'buyer@example.test', phone: '500600700' },
});
const confirm = { confirm_external: true, ack_contract_rate: true };

/** Every label path (DEMO, InPost, DPD, DHL, Poczta Polska; carrier accounts in simulation) refuses a new label. */
async function assertEveryLabelPathRefused(orderId: string) {
  await refused(`/api/orders/${orderId}/demo-label`, 'POST', {}, 409, RELABEL);
  const inpost = (await ok('/api/shipping/example', 'POST', {})).id;
  const ip = await ok(`/api/orders/${orderId}/shipping/preview`, 'POST', inpostInput(inpost));
  await refused(`/api/shipping-plans/${ip.id}/queue`, 'POST', {}, 409, RELABEL);
  const dpd = (await ok('/api/dpd-shipping/example', 'POST', {})).channel_id;
  const dp = await ok(`/api/orders/${orderId}/dpd-shipping/preview`, 'POST', carrierInput(dpd));
  await refused(`/api/dpd-shipping/${dp.id}/queue`, 'POST', confirm, 409, RELABEL);
  const dhl = (await ok('/api/dhl-shipping/example', 'POST', {})).channel_id;
  const dh = await ok(`/api/orders/${orderId}/dhl-shipping/preview`, 'POST', { ...carrierInput(dhl), cod_bank_account: NRB });
  await refused(`/api/dhl-shipping/${dh.id}/queue`, 'POST', confirm, 409, RELABEL);
  const pp = (await ok('/api/pocztapolska-shipping/example', 'POST', {})).channel_id;
  const pq = await ok(`/api/orders/${orderId}/pocztapolska-shipping/preview`, 'POST', { ...carrierInput(pp), service: 'pocztex_kurier', cod_account: 'PL ' + NRB });
  await refused(`/api/pocztapolska-shipping/${pq.id}/queue`, 'POST', confirm, 409, RELABEL);
  // Nothing was queued and the order did not move.
  const rows = (await pool.query("SELECT count(*)::int n FROM shipping_plans WHERE order_id=$1 AND state NOT IN ('preview','cancelled')", [orderId])).rows[0];
  assert.equal(rows.n, 0);
}

test('DEMO label → Anuluj etykietę: no label path gives a second label; the cancelled one stays in history', async () => {
  const { o } = await packed();
  await ok(`/api/orders/${o.id}/demo-label`, 'POST', {});
  const c = await ok(`/api/orders/${o.id}/cancel-label`, 'POST', {});
  assert.deepEqual([c.status, c.fulfilment_stage], ['packed', 'packed']);
  await assertEveryLabelPathRefused(o.id);
  await refused(`/api/orders/${o.id}/ship-demo`, 'POST', {}, 409, /anulowano/);
  const rows = (await pool.query('SELECT status,dispatched_at FROM shipments WHERE order_id=$1', [o.id])).rows;
  assert.deepEqual(rows.map((r) => [r.status, r.dispatched_at]), [['canceled', null]], 'one cancelled, undispatched label');
  assert.equal((await pool.query('SELECT status FROM orders WHERE id=$1', [o.id])).rows[0].status, 'packed');
});

test('carrier account in simulation (DPD): label → Anuluj etykietę → a new label is refused in Polish', async () => {
  const { o } = await packed();
  const ch = (await ok('/api/dpd-shipping/example', 'POST', {})).channel_id;
  const preview = await ok(`/api/orders/${o.id}/dpd-shipping/preview`, 'POST', carrierInput(ch));
  const q = await ok(`/api/dpd-shipping/${preview.id}/queue`, 'POST', confirm);
  const job = (await pool.query("UPDATE jobs SET state='running',lease_token=$2,attempts=attempts+1,locked_at=now() WHERE id=$1 RETURNING *", [q.job_id, randomUUID()])).rows[0];
  await processDpd(job, { transport: async () => assert.fail('simulation makes no HTTP call') });
  assert.equal((await pool.query('SELECT state FROM shipping_plans WHERE id=$1', [preview.id])).rows[0].state, 'ready');
  assert.equal((await ok(`/api/orders/${o.id}`)).fulfilment_stage, 'ready_to_ship');
  await ok(`/api/orders/${o.id}/cancel-label`, 'POST', {});
  assert.equal((await pool.query('SELECT state FROM shipping_plans WHERE id=$1', [preview.id])).rows[0].state, 'cancelled');
  await assertEveryLabelPathRefused(o.id);
});

test('a parcel preview made before Anuluj etykietę cannot be applied with the cancelled label as a parcel', async () => {
  const { o, p } = await packed();
  await ok(`/api/orders/${o.id}/demo-label`, 'POST', {});
  const label = (await pool.query('SELECT id,cod_expected FROM shipments WHERE order_id=$1', [o.id])).rows[0];
  const source = (await ok(`/api/order-parcels/orders/${o.id}/source`)).source;
  const preview = (await ok(`/api/order-parcels/orders/${o.id}/previews`, 'POST', {
    client_key: randomUUID(), order_version: source.order.version, parcels: [
      { source_kind: 'existing', shipment_id: label.id, cod_minor: label.cod_expected, products: [{ product_id: p.id, quantity: 1 }] },
      { source_kind: 'demo', cod_minor: 10000 - label.cod_expected, products: [{ product_id: p.id, quantity: 1 }] },
    ],
  })).preview;
  await ok(`/api/orders/${o.id}/cancel-label`, 'POST', {});
  await refused(`/api/order-parcels/previews/${preview.id}/apply`, 'POST', { client_key: randomUUID(), scope_hash: preview.scope_hash, confirmed: true }, 409, /anulowanej etykiety nie można przydzielić do planu paczek/);
  assert.equal((await pool.query('SELECT count(*)::int n FROM order_parcel_plans WHERE order_id=$1', [o.id])).rows[0].n, 0);
  assert.equal((await pool.query('SELECT count(*)::int n FROM shipments WHERE order_id=$1', [o.id])).rows[0].n, 1);
});

test('why: the sealed guards refuse handing over a second shipment row, and the parcel plan cannot replace the label', async () => {
  const { o, p } = await packed();
  await ok(`/api/orders/${o.id}/demo-label`, 'POST', {});
  await ok(`/api/orders/${o.id}/cancel-label`, 'POST', {});
  const cancelled = (await pool.query('SELECT id,cod_expected FROM shipments WHERE order_id=$1', [o.id])).rows[0];
  // Parcel plan (server/order-parcels.ts): one parcel is not a plan (2..50, 134_order_parcels.sql:229)…
  const source = (await ok(`/api/order-parcels/orders/${o.id}/source`)).source;
  assert.equal(source.can_preview, true);
  const draft = (parcels: any[]) => ({ client_key: randomUUID(), order_version: source.order.version, parcels });
  const one = await req(`/api/order-parcels/orders/${o.id}/previews`, 'POST', draft([{ source_kind: 'demo', cod_minor: 10000, products: [{ product_id: p.id, quantity: 2 }] }]));
  assert.ok(one.statusCode >= 400 && one.statusCode < 500, one.body);
  // …and every existing shipment, the cancelled label too, must carry goods in the plan (134_order_parcels.sql:282).
  await refused(`/api/order-parcels/orders/${o.id}/previews`, 'POST', draft([
    { source_kind: 'demo', cod_minor: 10000, products: [{ product_id: p.id, quantity: 1 }] },
    { source_kind: 'demo', cod_minor: 0, products: [{ product_id: p.id, quantity: 1 }] },
  ]), 409, /Wszystkie istniejące źródła muszą należeć do planu/);
  // The parcel SQL does not read shipment status: the cancelled label itself must not become a parcel to hand over.
  const withCancelled = draft([
    { source_kind: 'existing', shipment_id: cancelled.id, cod_minor: cancelled.cod_expected, products: [{ product_id: p.id, quantity: 1 }] },
    { source_kind: 'demo', cod_minor: 10000 - cancelled.cod_expected, products: [{ product_id: p.id, quantity: 1 }] },
  ]);
  await refused(`/api/order-parcels/orders/${o.id}/previews`, 'POST', withCancelled, 409, /anulowanej etykiety nie można przydzielić do planu paczek/);
  // Ordinary path: a second DEMO row may be inserted, but not handed over (234_carriers.sql:134) nor shipped (134_order_parcels.sql:459).
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
    const sid = randomUUID();
    assert.equal(await attempt("INSERT INTO shipments(id,tenant_id,order_id,carrier,tracking_number,mode,cod_expected) VALUES($1,$2,$3,'Symulator lokalny',$4,'demo',$5)",
      [sid, DEMO_TENANT, o.id, 'DEMO-RELABEL-' + sid.slice(0, 8), cancelled.cod_expected]), 'ok');
    assert.equal(await attempt('UPDATE shipments SET dispatched_at=now() WHERE id=$1', [sid]), 'Wydanie wielu paczek wymaga jawnego przydziału pozycji');
    assert.equal(await attempt("UPDATE orders SET status='shipped' WHERE id=$1", [o.id]), 'Wydanie wielu paczek wymaga jawnego przydziału pozycji');
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
});
