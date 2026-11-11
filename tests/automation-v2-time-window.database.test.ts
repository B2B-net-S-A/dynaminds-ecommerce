// Automation rules v2: the periodic check of time-dependent rules walks every open order in pages, so a rule like
// "Dostarczone → Zakończone po 14 dniach" also reaches orders that nobody touched for a long time.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../server/app';
import { pool, migrate } from '../server/db';
import { seed, DEMO_TENANT } from './fixtures';
import { scheduleV2TimeChecks } from '../server/automation-v2';
import { DEFAULT_RUN } from '../shared/automation-v2';

assert.equal(process.env.DYNA_TEST, 'true');
let app: FastifyInstance, admin: string;
const req = (url: string, method: any = 'GET', payload?: any) => app.inject({ url, method, payload, headers: { cookie: admin } });
async function ok(url: string, method: any = 'GET', payload?: any) {
  const r = await req(url, method, payload);
  assert.ok(r.statusCode < 300, `${method} ${url}: ${r.statusCode} ${r.body}`);
  return r.json();
}

before(async () => {
  await migrate();
  await seed();
  app = await buildApp();
  const r = await app.inject({ url: '/api/auth/login', method: 'POST', payload: { email: 'admin@demo.local', password: 'DynaDemo!2026' } });
  assert.equal(r.statusCode, 200, r.body);
  admin = r.headers['set-cookie']!.toString().split(';')[0];
});
after(async () => {
  await app.close();
  await pool.end();
});

test('time checks page through all open orders, not only the 100 most recently changed', async () => {
  const warehouse = (await ok('/api/warehouses')).data[0].id;
  const p = await ok('/api/products', 'POST', { name: 'Okno czasu', sku: 'TW-' + randomUUID().slice(0, 8), price: 1000, warehouse_id: warehouse, quantity: 50 });
  for (let i = 0; i < 3; i++)
    await ok('/api/orders', 'POST', { customer_name: 'Okno ' + i, email: 'tw@example.test', warehouse_id: warehouse, payment_mode: 'cod', items: [{ product_id: p.id, quantity: 1 }] });
  await ok('/api/automations/v2/rules', 'POST', {
    name: 'Okno czasu',
    trigger: 'time.schedule',
    enabled: true,
    config: { version: 2, group: 'Czas', scope: 'orders', run: DEFAULT_RUN, conditions: { match: 'all', items: [] }, effects: [{ type: 'add_tag', params: { tag: 'TW' } }], stop_further: false },
  });
  const open = (
    await pool.query("SELECT id FROM orders WHERE tenant_id=$1 AND status NOT IN ('completed','cancelled','return_completed')", [DEMO_TENANT])
  ).rows.map((r) => r.id as string);
  assert.ok(open.length >= 3);
  const seen = new Set<string>();
  for (let i = 0; i < open.length + 2; i++) {
    await scheduleV2TimeChecks([DEMO_TENANT], true, 2);
  }
  const jobs = (await pool.query("SELECT payload FROM jobs WHERE tenant_id=$1 AND payload->>'kind'='time.tick'", [DEMO_TENANT])).rows;
  assert.ok(jobs.length >= Math.ceil(open.length / 2), `pages: ${jobs.length}`);
  for (const j of jobs) {
    assert.ok(j.payload.order_ids.length <= 4, 'one check holds the recent page and the cursor page');
    for (const id of j.payload.order_ids) seen.add(id);
  }
  assert.deepEqual(open.filter((id) => !seen.has(id)), [], 'every open order was checked');
});
