import { legacySerialOrderStatusPayload } from './order-status-cas-helper';
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../server/app';
import { pool, migrate } from '../server/db';
import { seed } from './fixtures';
import { amazonSecrets, amazonConfig } from './amazon-fixture';
import { amazonFulfillmentFixture } from './amazon-fulfillment-fixture';
import { processAmazonFulfillment } from '../server/amazon-fulfillment';
import { processSupplierOrderJob, SUPPLIER_ORDER_JOB } from '../server/automation-v2-effects-supply';
import { DEFAULT_RUN } from '../shared/automation-v2';
import { tick } from '../server/worker';
assert.equal(process.env.DYNA_TEST, 'true');

let app: FastifyInstance, admin: string, warehouse: string, supplier: string;
let f = amazonFulfillmentFixture();
const ctx = { transport: (u: string, i: RequestInit) => f.transport(u, i) };
const V2 = '/api/automations/v2';
// Fixtures do minutes of user work in milliseconds; reset the Amazon read quota as tests/amazon-fulfillment.test.ts does.
const req = async (url: string, method: any = 'GET', payload?: any, cookie = admin) => {
  await pool.query("DELETE FROM amazon_api_buckets WHERE family<>'shipment_write'");
  return app.inject({ url, method, payload, headers: { cookie } });
};
async function ok(url: string, method: any = 'GET', payload?: any, cookie = admin) {
  const r = await req(url, method, payload, cookie);
  assert.ok(r.statusCode < 300, `${method} ${url}: ${r.statusCode} ${r.body}`);
  return r.json();
}
before(async () => {
  await migrate();
  await seed();
  app = await buildApp({ integrationTransport: ctx.transport });
  const r = await app.inject({ url: '/api/auth/login', method: 'POST', payload: { email: 'admin@demo.local', password: 'DynaDemo!2026' } });
  assert.equal(r.statusCode, 200, r.body);
  admin = r.headers['set-cookie']!.toString().split(';')[0];
  warehouse = (await ok('/api/warehouses')).data[0].id;
  supplier = (await ok('/api/suppliers', 'POST', { name: 'Dostawca reguł', code: randomUUID() })).id;
});
beforeEach(async () => {
  f = amazonFulfillmentFixture();
  await pool.query('DELETE FROM amazon_api_buckets');
  await pool.query('UPDATE automation_rules SET enabled=false,version=version+1 WHERE enabled');
  await pool.query("UPDATE jobs SET state='done',lease_token=NULL WHERE state IN ('pending','running')");
});
after(async () => {
  await app.close();
  await pool.end();
});

const rule = (effects: any[]) =>
  ok(V2 + '/rules', 'POST', {
    name: 'Zaopatrzenie ' + randomUUID().slice(0, 8),
    trigger: 'order.matches',
    enabled: true,
    config: {
      version: 2,
      group: 'Testy',
      scope: 'orders',
      run: { ...DEFAULT_RUN, manual_button: true, auto: false },
      conditions: { match: 'all', items: [] },
      effects,
      stop_further: false,
    },
  });
async function run(ruleId: string, orderId: string) {
  const [r] = (await ok(V2 + '/rules/' + ruleId + '/run', 'POST', { order_ids: [orderId] })).runs;
  const row = (await pool.query('SELECT state,error,result FROM automation_runs WHERE id=$1', [r.id])).rows[0];
  return { status: r.status as string, error: r.error as string | null, effects: (row.result?.effects ?? []) as any[] };
}
async function drain() {
  for (let i = 0; i < 300; i++) if (!(await tick(ctx))) return;
  assert.fail('Kolejka nie wygasła w 300 krokach');
}
const claim = async (id: string) =>
  (await pool.query("UPDATE jobs SET state='running',attempts=attempts+1,locked_at=now(),lease_token=$2 WHERE id=$1 RETURNING *", [id, randomUUID()])).rows[0];

// ---- supplier_order ----
async function product(stock: number) {
  return ok('/api/products', 'POST', { name: 'Zaopatrzenie', sku: 'SUP-' + randomUUID(), price: 999, warehouse_id: warehouse, quantity: stock });
}
const definition = (validUntil: string) => ({
  enabled: true,
  minimum_quantity: 5,
  target_quantity: 20,
  supplier_id: supplier,
  supplier_sku: 'DOST-1',
  currency: 'PLN',
  minimum_order_quantity: 1,
  order_multiple: 1,
  unit_cost_minor: 317,
  cost_valid_until: validUntil,
  confirm_cost: true,
  expected_date: null,
});
async function policy(productId: string) {
  return ok('/api/replenishment/policies', 'POST', {
    client_key: randomUUID(),
    warehouse_id: warehouse,
    product_id: productId,
    definition: definition(new Date(Date.now() + 86400000).toISOString()),
  });
}
const plainOrder = (productId: string, quantity: number) =>
  ok('/api/orders', 'POST', {
    customer_name: 'QA zaopatrzenie',
    email: 'supply@example.test',
    warehouse_id: warehouse,
    items: [{ product_id: productId, quantity }],
    address: { country: 'PL', city: 'Warszawa', phone: '500600700' },
  });
/** Stock 10: an order of 8 loses its reservation and another order takes 6, so 4 of the 8 are missing. */
async function shortOrder(productId: string) {
  const o = await plainOrder(productId, 8);
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query("UPDATE stock SET reserved=reserved-8 WHERE product_id=$1 AND warehouse_id=$2", [productId, warehouse]);
    await c.query("UPDATE reservations SET state='released' WHERE order_id=$1", [o.id]);
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
  await plainOrder(productId, 6);
  return o;
}
const supplierJob = async (orderId: string) =>
  (await pool.query("SELECT * FROM jobs WHERE kind=$1 AND payload->>'order_id'=$2", [SUPPLIER_ORDER_JOB, orderId])).rows;

test('supplier_order: short line → module preview + local draft PO for the policy supplier; repeat = no change', async () => {
  const p = await product(10);
  await policy(p.id);
  const o = await shortOrder(p.id);
  const r = await rule([{ type: 'supplier_order', params: {} }]);
  const first = await run(r.id, o.id);
  assert.equal(first.status, 'done', first.error ?? '');
  assert.equal(first.effects[0].changed, true);
  assert.match(first.effects[0].message, new RegExp(`${p.sku} \\(brak 4\\)`));
  const [job] = await supplierJob(o.id);
  assert.equal(job.state, 'pending');
  const out = await processSupplierOrderJob(await claim(job.id));
  assert.equal(out?.state, 'done', out?.message ?? 'brak wyniku');
  assert.equal(out?.purchase_order_ids?.length, 1);
  const po = (await pool.query('SELECT * FROM purchase_orders WHERE id=$1', [out!.purchase_order_ids![0]])).rows[0];
  assert.equal(po.state, 'draft');
  assert.equal(po.supplier_id, supplier);
  assert.ok(po.replenishment_execution_id);
  const lines = (await pool.query('SELECT product_id,quantity,unit_cost FROM purchase_order_lines WHERE order_id=$1', [po.id])).rows;
  assert.deepEqual(lines, [{ product_id: p.id, quantity: 16, unit_cost: 317 }]);
  assert.equal((await pool.query("SELECT state FROM jobs WHERE id=$1", [job.id])).rows[0].state, 'done');
  const ev = (await pool.query("SELECT detail FROM order_events WHERE order_id=$1 AND kind='automation.supplier_order'", [o.id])).rows;
  assert.equal(ev.length, 1);
  assert.match(ev[0].detail.message, /Utworzono szkic zamówienia do dostawcy/);
  // Same order again: nothing new is queued.
  const again = await run(r.id, o.id);
  assert.equal(again.status, 'done');
  assert.equal(again.effects[0].changed, false);
  assert.match(again.effects[0].message, /już zlecone/);
  assert.equal((await supplierJob(o.id)).length, 1);
  // A retried lease does nothing twice.
  assert.equal(await processSupplierOrderJob({ ...job, lease_token: randomUUID() }), null);
});

test('supplier_order: refusals — no policy, foreign supplier on save, no shortage = no change, plan not ready', async () => {
  const bare = await product(10);
  const o = await shortOrder(bare.id);
  const r = await rule([{ type: 'supplier_order', params: {} }]);
  const refused = await run(r.id, o.id);
  assert.equal(refused.status, 'failed');
  assert.match(refused.error ?? '', new RegExp(`Brak włączonej polityki uzupełnień.*${bare.sku}`));
  assert.equal((await supplierJob(o.id)).length, 0);

  const foreign = await req(V2 + '/rules', 'POST', {
    name: 'Obcy dostawca',
    trigger: 'order.matches',
    enabled: true,
    config: { version: 2, group: 'Testy', scope: 'orders', run: { ...DEFAULT_RUN, manual_button: true, auto: false }, conditions: { match: 'all', items: [] }, effects: [{ type: 'supplier_order', params: { supplier_id: randomUUID() } }], stop_further: false },
  });
  assert.equal(foreign.statusCode, 422);
  assert.match(foreign.body, /Dostawca jest nieaktywny/);

  const plenty = await product(100);
  const fine = await ok('/api/orders', 'POST', { customer_name: 'QA', email: 'ok@example.test', warehouse_id: warehouse, items: [{ product_id: plenty.id, quantity: 1 }], address: { country: 'PL', city: 'Warszawa', phone: '500600700' } });
  const none = await run(r.id, fine.id);
  assert.equal(none.status, 'done');
  assert.equal(none.effects[0].changed, false);
  assert.match(none.effects[0].message, /na stanie/);

  // The module's own validation in the job: a policy disabled after queueing leaves the plan as a
  // preview and fails readably.
  const p = await product(10);
  const pol = (await policy(p.id)).policy;
  const late = await shortOrder(p.id);
  const queued = await run(r.id, late.id);
  assert.equal(queued.status, 'done', queued.error ?? '');
  await ok('/api/replenishment/policies/' + pol.id, 'PATCH', {
    version: pol.version,
    definition: { ...definition(pol.cost_valid_until), enabled: false, confirm_cost: false },
  });
  const [job] = await supplierJob(late.id);
  const out = await processSupplierOrderJob(await claim(job.id));
  assert.equal(out?.state, 'failed');
  assert.match(out?.message ?? '', /Plan uzupełnień wymaga poprawek.*Brak włączonej polityki/);
  assert.ok(out?.preview_id);
  const j = (await pool.query('SELECT state,error FROM jobs WHERE id=$1', [job.id])).rows[0];
  assert.equal(j.state, 'failed');
  assert.match(j.error, /Brak włączonej polityki/);
  assert.equal((await pool.query('SELECT count(*)::int n FROM purchase_order_lines WHERE product_id=$1', [p.id])).rows[0].n, 0);

  // A failed job does not block the order: after the policy is fixed, a new run queues a new job and the
  // worker's tick() creates the draft.
  const fixed = (await ok('/api/replenishment/policies/' + pol.id)).policy;
  await ok('/api/replenishment/policies/' + pol.id, 'PATCH', {
    version: fixed.version,
    definition: { ...definition(pol.cost_valid_until), confirm_cost: false },
  });
  const retry = await run(r.id, late.id);
  assert.equal(retry.status, 'done', retry.error ?? '');
  assert.equal(retry.effects[0].changed, true, retry.effects[0].message);
  const jobs = await supplierJob(late.id);
  assert.equal(jobs.length, 2);
  const fresh = jobs.find((x) => x.id !== job.id)!;
  assert.equal(fresh.state, 'pending');
  await drain();
  assert.equal((await pool.query('SELECT state,error FROM jobs WHERE id=$1', [fresh.id])).rows[0].state, 'done');
  const drafts = (
    await pool.query("SELECT l.quantity FROM purchase_order_lines l JOIN purchase_orders o ON o.id=l.order_id WHERE l.product_id=$1 AND o.state='draft'", [p.id])
  ).rows;
  assert.deepEqual(drafts, [{ quantity: 16 }]);
  // Once the job succeeded, the order is served: a further run changes nothing.
  const served = await run(r.id, late.id);
  assert.equal(served.effects[0].changed, false);
  assert.equal((await supplierJob(late.id)).length, 2);
});

// ---- send_to_fulfilment ----
async function amazonOrder(simulation: boolean) {
  const seller = 'AQATEST' + randomUUID().replaceAll('-', '').slice(0, 16).toUpperCase();
  const ch = (
    await ok('/api/integrations', 'POST', {
      provider: 'amazon',
      name: 'Amazon reguły',
      mode: 'sandbox',
      credentials: amazonSecrets,
      settings: { ...amazonConfig, selling_partner_id: seller, shipment_write: 'true' },
    })
  ).id;
  const p = await ok('/api/products', 'POST', { sku: 'AMR-' + randomUUID(), name: 'Amazon reguły', price: 12300, vat: 23, warehouse_id: warehouse, quantity: 12 });
  await ok(`/api/integrations/${ch}/mappings`, 'POST', { external_id: 'AMAZON-DEMO-SKU', sku: p.sku });
  await ok(`/api/integrations/${ch}/fetch-orders`, 'POST', { page: 1 });
  const inbound = (await ok(`/api/integrations/${ch}/imports`)).data[0];
  const o = await ok(`/api/imports/${inbound.id}/commit`, 'POST', { warehouse_id: warehouse, expected_hash: inbound.source_hash });
  await ok(`/api/orders/${o.id}/payments`, 'POST', {
    client_key: randomUUID(),
    version: Number(o.version),
    kind: 'receipt',
    amount: 24690,
    currency: 'PLN',
    confirmed: true,
    method: 'bank_transfer',
    reference: 'AMR-' + randomUUID(),
  });
  const get = (path: string) => ok('/api' + path);
  await ok(`/api/orders/${o.id}/status`, 'PATCH', await legacySerialOrderStatusPayload(get, `/orders/${o.id}/status`, { status: 'picking' }));
  for (let n = 0; n < 2; n++) await ok(`/api/orders/${o.id}/scan`, 'POST', { code: p.sku });
  await ok(`/api/orders/${o.id}/status`, 'PATCH', await legacySerialOrderStatusPayload(get, `/orders/${o.id}/status`, { status: 'packed' }));
  await ok(`/api/orders/${o.id}/ship-demo`, 'POST', {});
  if (simulation) await pool.query('UPDATE channels SET settings=settings||\'{"simulation":true}\'::jsonb WHERE id=$1', [ch]);
  else {
    // A real carrier shipment of the account's environment; shipment identity is immutable for the app,
    // so the fixture writes it with triggers off (superuser test connection only).
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL session_replication_role=replica');
      await c.query("UPDATE shipments SET mode='sandbox',carrier='QA DPD',tracking_number=$2 WHERE order_id=$1", [o.id, '003' + randomUUID().replaceAll('-', '')]);
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  }
  return o;
}
const plans = async (orderId: string) => (await pool.query('SELECT * FROM amazon_fulfillment_plans WHERE order_id=$1 ORDER BY created_at', [orderId])).rows;

test('send_to_fulfilment: simulation account → module preview + queue, module job completes without HTTP; repeat refused', async () => {
  const o = await amazonOrder(true);
  const r = await rule([{ type: 'send_to_fulfilment', params: { carrier_code: 'DPD' } }]);
  const calls = f.calls.length;
  const first = await run(r.id, o.id);
  assert.equal(first.status, 'done', first.error ?? '');
  assert.match(first.effects[0].message, /Przekazano wysyłkę do Amazon \(symulacja\)/);
  const [plan] = await plans(o.id);
  assert.equal(plan.state, 'queued');
  assert.equal(plan.payload.packageDetail.carrierCode, 'DPD');
  const job = (await pool.query('SELECT * FROM jobs WHERE id=$1', [plan.job_id])).rows[0];
  assert.equal(job.kind, 'amazon.fulfillment');
  await pool.query("DELETE FROM amazon_api_buckets WHERE family<>'shipment_write'");
  await processAmazonFulfillment(await claim(job.id), ctx);
  assert.equal((await plans(o.id))[0].state, 'done');
  assert.equal(f.calls.length, calls, 'symulacja bez połączeń z Amazon');
  const again = await run(r.id, o.id);
  assert.equal(again.status, 'failed');
  assert.match(again.error ?? '', /^Amazon: /);
  assert.equal((await plans(o.id)).length, 1, 'odmowa cofa podgląd reguły');
});

test('send_to_fulfilment: refusals — not an Amazon order, real (non-simulation) account', async () => {
  const p = await product(10);
  const plain = await ok('/api/orders', 'POST', { customer_name: 'QA', email: 'plain@example.test', warehouse_id: warehouse, items: [{ product_id: p.id, quantity: 1 }], address: { country: 'PL', city: 'Warszawa', phone: '500600700' } });
  const r = await rule([{ type: 'send_to_fulfilment', params: { carrier_code: 'DPD' } }]);
  const notAmazon = await run(r.id, plain.id);
  assert.equal(notAmazon.status, 'failed');
  assert.match(notAmazon.error ?? '', /Amazon: Wymagane zaimportowane zamówienie Amazon/);
  const real = await amazonOrder(false);
  const calls = f.calls.length;
  const refused = await run(r.id, real.id);
  assert.equal(refused.status, 'failed');
  assert.match(refused.error ?? '', /trybie symulacji/);
  assert.equal(f.calls.length, calls);
  assert.equal((await plans(real.id)).length, 0);
});
