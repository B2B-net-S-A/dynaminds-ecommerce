/** Lane L: the demo company's Allegro orders (tools/demo/seed-allegro.mjs) through the ordinary routes, with the
 * 16 demo guards before and after, and their channel data as the rule conditions see it. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../server/app';
import { pool, migrate, tenantTx } from '../server/db';
import { seed, DEMO_TENANT } from './fixtures';
import { loadOrderContexts } from '../server/automation-v2-context';
// @ts-expect-error plain JavaScript demo tools
import { Client, injectTransport } from '../tools/demo/lib.mjs';
// @ts-expect-error plain JavaScript demo tools
import { seedAllegroOrders, allegroDemoOrders } from '../tools/demo/seed-allegro.mjs';
// @ts-expect-error plain JavaScript demo tools
import { demoGuards } from '../tools/demo/guards.mjs';
assert.equal(process.env.DYNA_TEST, 'true');

let app: FastifyInstance, client: any, warehouse: string;
const NOW = Date.parse('2026-11-10T09:00:00Z');
before(async () => {
  await migrate();
  await seed();
  app = await buildApp();
  client = new Client(injectTransport(app));
  await client.login('admin@demo.local', 'DynaDemo!2026');
  warehouse = (await client.get('/api/warehouses')).data[0].id;
});
after(async () => {
  await app.close();
  await pool.end();
});

test('demo Allegro orders import with Smart, company, allegro.cz, ship-by, comments, PayU / Allegro Finanse and COD locker', async () => {
  const before = await demoGuards(process.env.DATABASE_URL);
  assert.equal(before.count, 16);
  assert.equal(before.all_true, true, JSON.stringify(before.values));
  const skus = [...new Set(allegroDemoOrders(NOW).flatMap((o: any) => o.lines.map((l: any) => l[0])))] as string[];
  const prices = new Map<string, number>();
  for (const [i, sku] of skus.entries()) {
    const price = 1500 + i * 700;
    await client.post('/api/products', { name: 'Demo ' + sku, sku, price, vat: 23, warehouse_id: warehouse, quantity: 50 }, [201]);
    prices.set(sku, price);
  }
  const r = await seedAllegroOrders(client, { warehouseId: warehouse, prices, nowMs: NOW });
  assert.equal(r.numbers.length, 4);
  const after = await demoGuards(process.env.DATABASE_URL);
  assert.equal(after.all_true, true, JSON.stringify(after.values));

  const ids = (await pool.query('SELECT id,external_id FROM orders WHERE number=ANY($1::text[])', [r.numbers])).rows;
  const ctx = await tenantTx(DEMO_TENANT, (c) => loadOrderContexts(c, ids.map((x) => x.id)));
  const by = Object.fromEntries(ids.map((x) => [x.external_id, ctx.get(x.id)!.values]));
  const smart = by['ps-alg-0001'], company = by['ps-alg-0002'], cz = by['ps-alg-0003'], cod = by['ps-alg-0004'];
  assert.deepEqual(smart['source.flags'], ['smart']);
  assert.equal(smart['payment.operator'], 'payu');
  assert.ok((smart['shipping.method'] as string[]).includes('allegro:allegro-paczkomaty-inpost'));
  assert.match(smart['order.customer_comment'] as string, /prezent/);
  assert.equal(smart['source.ship_by'], '2026-11-11T15:00:00.000Z');
  assert.deepEqual(company['source.flags'], ['business', 'invoice']);
  assert.equal(company['payment.operator'], 'allegro_finance');
  assert.equal(cz['source.site'], 'allegro.cz');
  assert.equal(cz['payment.operator'], 'allegro_finance');
  assert.deepEqual(cod['source.flags'], ['smart']);
  assert.equal(cod['payment.operator'], 'cod');
  assert.deepEqual(cod['shipping.method'], ['parcel_locker', 'parcel_locker_cod', 'allegro:allegro-paczkomaty-inpost-pobranie']);
  assert.equal(cod['payment.cod'], true);
});
