/** Shared setup of the relabel tests (tests/relabel-after-cancel*.database.test.ts), migration 268: the app on the local
 * carrier fakes, a DHL and a Poczta Polska sandbox channel, packed COD orders and the job runners. Guard invariance of
 * 268 (18/18 named, demo 16/16, 119/138) is proven by the compiled delta (docs/parity/relabel268-generation-plan.md),
 * not repeated here: on a CI runner two full guard passes per file cost minutes. Not a test file itself. */
import { legacySerialOrderStatusPayload } from './order-status-cas-helper';
import { before, after } from 'node:test';
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
export { pool, DEMO_TENANT };
relaxPoolTimeouts();

const dhl = createDhlFake();
const pp = pocztaPolskaFake();
const transport = async (url: string, init: RequestInit) => {
  if (url.startsWith('https://sandbox.dhl24.com.pl/')) return dhl.transport(url, init);
  if (url.startsWith('https://en-testwebapi.poczta-polska.pl/')) return pp.transport(url, init);
  throw new Error('unexpected network ' + url);
};

let app: FastifyInstance, admin: string, warehouse: string;
export const channels = { dhl: '', pp: '' };
export const req = (url: string, method: any = 'GET', payload?: any) => app.inject({ url, method, payload, headers: { cookie: admin } });
export async function ok(url: string, method: any = 'GET', payload?: any) {
  const r = await req(url, method, payload);
  assert.ok(r.statusCode < 300, `${method} ${url}: ${r.statusCode} ${r.body}`);
  return r.json();
}
export async function refused(url: string, method: any, payload: any, status: number, message: RegExp) {
  const r = await req(url, method, payload);
  assert.equal(r.statusCode, status, `${method} ${url}: ${r.body}`);
  assert.match(r.json().message ?? r.body, message, `${method} ${url}`);
}
before(async () => {
  await migrate();
  await seed();
  app = await buildApp({ integrationTransport: transport });
  const r = await app.inject({ url: '/api/auth/login', method: 'POST', payload: { email: 'admin@demo.local', password: 'DynaDemo!2026' } });
  assert.equal(r.statusCode, 200, r.body);
  admin = r.headers['set-cookie']!.toString().split(';')[0];
  warehouse = (await ok('/api/warehouses')).data[0].id;
  channels.dhl = (await ok('/api/integrations', 'POST', {
    provider: 'dhl', name: 'DHL relabel', mode: 'sandbox', credentials: { username: DHL_FAKE_USER, password: DHL_FAKE_PASSWORD }, settings: { sap_account: '1234567' },
  })).id;
  channels.pp = (await ok('/api/integrations', 'POST', {
    provider: 'pocztapolska', name: 'Poczta Polska relabel', mode: 'sandbox', credentials: pp.credentials, settings: { urzad_nadania: pp.settings.urzad_nadania },
  })).id;
});
after(async () => {
  await app.close();
  await pool.end();
});

export const party = { name: 'QA Etykieta', address: 'Testowa 1', city: 'Warszawa', postalCode: '01-354', phone: '500600700', email: 'qa@example.test' };
export const NRB = '61109010140000071219812874';
/** A packed COD order of 2 × 50 zł (amount due 10 000 gr). */
export async function packed() {
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
export const carrierInput = (ch: string) => ({ channel_id: ch, sender: party, receiver: party, weight: 1.25, dimensions: { length: 20, width: 15, height: 10 }, content: 'Towar testowy', cod: 10000, insurance: 10000 });
export const confirm = { confirm_external: true, ack_contract_rate: true };
export const shipments = async (orderId: string) =>
  (await pool.query('SELECT * FROM shipments WHERE order_id=$1 ORDER BY created_at,id', [orderId])).rows;
export const replaced = async (orderId: string) =>
  (await pool.query('SELECT * FROM shipment268_replaced_labels WHERE order_id=$1 ORDER BY replaced_at,id', [orderId])).rows;
export const plan = (id: string) => tenantTx(DEMO_TENANT, async (c) => (await c.query('SELECT * FROM shipping_plans WHERE id=$1', [id])).rows[0]);
export async function lease(jobId: string) {
  return (await pool.query("UPDATE jobs SET state='running',lease_token=$2,attempts=attempts+1,locked_at=now() WHERE id=$1 RETURNING *", [jobId, randomUUID()])).rows[0];
}
export async function run(kind: 'dpd' | 'inpost' | 'dhl' | 'pp', jobId: string) {
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
export async function dpdLabel(orderId: string) {
  const ch = (await ok('/api/dpd-shipping/example', 'POST', {})).channel_id;
  const preview = await ok(`/api/orders/${orderId}/dpd-shipping/preview`, 'POST', carrierInput(ch));
  await run('dpd', (await ok(`/api/dpd-shipping/${preview.id}/queue`, 'POST', confirm)).job_id);
  return plan(preview.id);
}
/** The order's single shipment, the order stage and the label PDF of the new label. */
export async function assertNewLabel(orderId: string, shipmentId: string, carrier: string, oldTracking: string) {
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
export const shipped = async (orderId: string) => {
  const o = await ok('/api/orders/' + orderId);
  assert.equal(o.status, 'shipped');
  const rows = await shipments(orderId);
  assert.equal(rows.length, 1);
  assert.ok(rows[0].dispatched_at, 'the new label was handed over');
};
