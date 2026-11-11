import { legacySerialOrderStatusPayload } from './order-status-cas-helper';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../server/app';
import { pool, migrate, tenantTx } from '../server/db';
import { seed, DEMO_TENANT } from './fixtures';
import { encrypt } from '../server/security';
import { processShipping, failShipping } from '../server/shipping';
import { tick } from '../server/worker';
import { audit, type Actor } from '../server/domain';
import { SHIPMENT_STATUSES, shipmentStatusOf } from '../shared/shipment-status';
import { evaluate, type OrderContext } from '../server/automation-v2-eval';
import { fieldMeta } from '../server/automation-v2-fields';
import { parseRuleV2 } from '../server/automation-v2-schema';
import { defaultRules, ensureDefaultRulesInTx } from '../server/automation-v2-catalog';
assert.equal(process.env.DYNA_TEST, 'true');

const NOW = Date.parse('2026-11-10T12:00:00Z');
const DAY = 86_400_000;
const rule = (key: string) => {
  const r = defaultRules().find((x) => x.key === key);
  assert.ok(r, 'Brak reguły domyślnej ' + key);
  return r;
};
const ctx = (values: Record<string, unknown>): OrderContext => ({ order_id: 'o1', number: 'N-1', values, lines: [], types: {} });
const matches = (key: string, values: Record<string, unknown>) => evaluate(rule(key).config.conditions, ctx(values), fieldMeta, NOW).matched;

test('every default rule is a valid, editable v2 rule in the group „Domyślne” with a stable key', () => {
  const rules = defaultRules();
  assert.deepEqual(rules.map((r) => r.key), ['paid_to_new', 'shipped_tracking', 'delivered_tracking', 'completed_after_delivery']);
  for (const r of rules) {
    const parsed = parseRuleV2({ name: r.name, trigger: r.trigger, enabled: true, config: r.config }, {});
    assert.equal(parsed.error, undefined, r.name);
    assert.equal(r.config.group, 'Domyślne');
  }
  assert.equal(rule('shipped_tracking').name, 'Nadane z danych przewoźnika');
  assert.equal(rule('completed_after_delivery').name, 'Dostarczone → Zakończone po 14 dniach');
});

test('„Nadane z danych przewoźnika”: a label waiting for handover with a carrier in-transit status', () => {
  // The rule lists the labelled carrier groups (Odebrana, W drodze…), not raw provider codes, so the editor shows it in Polish.
  const statusLeaf: any = rule('shipped_tracking').config.conditions.items.find((i: any) => i.field === 'shipping.shipment_status');
  assert.ok(statusLeaf.value.every((v: string) => (SHIPMENT_STATUSES as readonly string[]).includes(v)), String(statusLeaf.value));
  // The engine context carries the carrier code and its group (server/automation-v2-context.ts).
  for (const s of ['collected_from_sender', 'taken_by_courier', 'in_transit', 'out_for_delivery', 'delivered'])
    assert.equal(matches('shipped_tracking', { 'order.status': 'ready_to_ship', 'shipping.shipment_status': [s, shipmentStatusOf(s)] }), true, s);
  // Not yet handed over, or the order is not waiting for handover.
  assert.equal(matches('shipped_tracking', { 'order.status': 'ready_to_ship', 'shipping.shipment_status': ['confirmed'] }), false);
  assert.equal(matches('shipped_tracking', { 'order.status': 'shipped', 'shipping.shipment_status': ['in_transit'] }), false);
  assert.equal(matches('shipped_tracking', { 'order.status': 'picking', 'shipping.shipment_status': ['in_transit'] }), false);
});

test('„Dostarczone → Zakończone”: only a delivered order in that status for more than 14 days', () => {
  const at = (days: number) => new Date(NOW - days * DAY).toISOString();
  assert.equal(matches('completed_after_delivery', { 'order.status': 'delivered', 'order.time_in_status': at(15) }), true);
  assert.equal(matches('completed_after_delivery', { 'order.status': 'delivered', 'order.time_in_status': at(13) }), false);
  assert.equal(matches('completed_after_delivery', { 'order.status': 'shipped', 'order.time_in_status': at(30) }), false);
});

// Database: seeding, upgrade and the shipped flow.
let app: FastifyInstance, cookie: string, adminId: string, warehouse: string;
const req = (url: string, method: any = 'GET', payload?: any) => app.inject({ url, method, payload, headers: { cookie } });
async function ok(url: string, method: any = 'GET', payload?: any) {
  const r = await req(url, method, payload);
  assert.ok(r.statusCode < 300, `${method} ${url}: ${r.statusCode} ${r.body}`);
  return r.json();
}
const failing = async () => {
  throw new Error('Symulacja nie wysyła zapytań do przewoźnika');
};
before(async () => {
  await migrate();
  await seed();
  app = await buildApp({ integrationTransport: failing as any });
  const r = await app.inject({ url: '/api/auth/login', method: 'POST', payload: { email: 'admin@demo.local', password: 'DynaDemo!2026' } });
  assert.equal(r.statusCode, 200, r.body);
  cookie = r.headers['set-cookie']!.toString().split(';')[0];
  adminId = (await ok('/api/auth/me')).user.id;
  warehouse = (await ok('/api/warehouses')).data[0].id;
});
after(async () => {
  await app.close();
  await pool.end();
});

async function tenant(): Promise<Actor> {
  const id = randomUUID();
  await pool.query("INSERT INTO tenants(id,name,plan) VALUES($1,'Reguły domyślne QA','enterprise')", [id]);
  await pool.query("INSERT INTO memberships(user_id,tenant_id,role) VALUES($1,$2,'admin')", [adminId, id]);
  return { tenantId: id, userId: adminId, role: 'admin' };
}
const ensure = (a: Actor) => tenantTx(a.tenantId, (c) => ensureDefaultRulesInTx(c, a));
const rulesOf = (a: Actor) =>
  tenantTx(a.tenantId, async (c) => (await c.query("SELECT * FROM automation_rules WHERE trigger LIKE 'v2:%' ORDER BY priority,id")).rows);

test('a new tenant gets all defaults once, enabled, in „Domyślne”; an operator never seeds', async () => {
  const a = await tenant();
  assert.equal(await tenantTx(a.tenantId, (c) => ensureDefaultRulesInTx(c, { ...a, role: 'operator' })), false);
  assert.equal(await ensure(a), true);
  assert.equal(await ensure(a), false);
  const rows = await rulesOf(a);
  assert.deepEqual(rows.map((r) => r.name), defaultRules().map((r) => r.name));
  assert.ok(rows.every((r) => r.enabled && r.config.group === 'Domyślne'));
  const keys = (await tenantTx(a.tenantId, async (c) => (await c.query("SELECT detail FROM audit_events WHERE action='automation.v2.defaults' AND entity_id=$1", [a.tenantId])).rows));
  assert.deepEqual(keys.map((k) => k.detail.keys), [defaultRules().map((r) => r.key)]);
});

test('a tenant seeded with the 2 old defaults gets only the new ones; its own rows stay untouched', async () => {
  const a = await tenant();
  // The old one-time seed: two rules in the groups of that time and an audit entry without keys.
  await tenantTx(a.tenantId, async (c) => {
    for (const [i, key] of ['paid_to_new', 'delivered_tracking'].entries()) {
      const r = rule(key);
      await c.query(
        "INSERT INTO automation_rules(id,tenant_id,name,trigger,action,config,enabled,priority,delay_seconds,actor_id) VALUES($1,$2,$3,$4,'actions',$5,true,$6,0,$7)",
        [randomUUID(), a.tenantId, 'Moja nazwa ' + i, 'v2:' + r.trigger, JSON.stringify({ ...r.config, group: 'Statusy' }), i, adminId],
      );
    }
    await audit(c, a, 'automation.v2.defaults', a.tenantId, { rules: 2 });
  });
  assert.equal(await ensure(a), true);
  assert.equal(await ensure(a), false);
  const rows = await rulesOf(a);
  assert.deepEqual(rows.map((r) => r.name), ['Moja nazwa 0', 'Moja nazwa 1', 'Nadane z danych przewoźnika', 'Dostarczone → Zakończone po 14 dniach']);
  assert.deepEqual(rows.map((r) => r.config.group), ['Statusy', 'Statusy', 'Domyślne', 'Domyślne']);
  // A firm already working gets the new defaults switched off; its own rows keep their state.
  assert.deepEqual(rows.map((r) => r.enabled), [true, true, false, false]);
});

test('a tenant that had its own v2 rules (skipped by the old seed) gets only the new defaults', async () => {
  const a = await tenant();
  const own = rule('paid_to_new');
  await tenantTx(a.tenantId, (c) =>
    c.query(
      "INSERT INTO automation_rules(id,tenant_id,name,trigger,action,config,enabled,priority,delay_seconds,actor_id) VALUES($1,$2,'Własna','v2:order.matches','actions',$3,true,0,0,$4)",
      [randomUUID(), a.tenantId, JSON.stringify({ ...own.config, group: 'Moje' }), adminId],
    ),
  );
  assert.equal(await ensure(a), true);
  assert.deepEqual((await rulesOf(a)).map((r) => [r.name, r.enabled]), [['Własna', true], ['Nadane z danych przewoźnika', false], ['Dostarczone → Zakończone po 14 dniach', false]]);
});

test('a deleted or renamed default is never re-created', async () => {
  const a = await tenant();
  await ensure(a);
  const rows = await rulesOf(a);
  await tenantTx(a.tenantId, async (c) => {
    await c.query('DELETE FROM automation_rules WHERE id=$1', [rows.find((r) => r.name === 'Nadane z danych przewoźnika').id]);
    await c.query("UPDATE automation_rules SET config=config||'{\"deleted\":true}'::jsonb,enabled=false WHERE id=$1", [rows.find((r) => r.name === 'Opłacone → Nowe').id]);
    await c.query("UPDATE automation_rules SET name='Zamykanie po zwrocie' WHERE id=$1", [rows.find((r) => r.name.startsWith('Dostarczone → Zakończone')).id]);
  });
  assert.equal(await ensure(a), false);
  const after = await rulesOf(a);
  assert.equal(after.length, rows.length - 1);
  assert.ok(!after.some((r) => r.name === 'Nadane z danych przewoźnika'));
});

async function drain() {
  for (let i = 0; i < 300; i++) if (!(await tick())) return;
  assert.fail('Kolejka nie wygasła w 300 krokach');
}
async function runJob(jobId: string) {
  const job = await tenantTx(DEMO_TENANT, async (c) =>
    (await c.query("UPDATE jobs SET state='running',lease_token=$2,attempts=attempts+1,locked_at=now() WHERE id=$1 RETURNING *", [jobId, randomUUID()])).rows[0],
  );
  try {
    await processShipping(job, { transport: failing as any });
  } catch (e) {
    await failShipping(job, e);
  }
}
const planOf = (id: string) => tenantTx(DEMO_TENANT, async (c) => (await c.query('SELECT * FROM shipping_plans WHERE id=$1', [id])).rows[0]);

test('carrier data „in transit” on a label waiting for handover marks the order shipped (Nadane)', async () => {
  await ok('/api/automations/v2/rules');
  // Only the default under test is enabled in the demo tenant.
  await pool.query("UPDATE automation_rules SET enabled=(trigger='v2:shipment.status_changed' AND name='Nadane z danych przewoźnika'),version=version+1 WHERE tenant_id=$1 AND trigger LIKE 'v2:%'", [DEMO_TENANT]);
  const p = await ok('/api/products', 'POST', { sku: 'DEF-' + randomUUID().slice(0, 10), name: 'Domyślne QA', price: 10000, vat: 23, warehouse_id: warehouse, quantity: 10 });
  const o = await ok('/api/orders', 'POST', {
    customer_name: 'Odbiorca QA',
    payment_mode: 'cod',
    email: 'defaults@example.test',
    warehouse_id: warehouse,
    address: { street: 'Testowa 1', city: 'Warszawa', postal_code: '00-001', country: 'PL', phone: '500600700' },
    // 2 × 100 zł with a 100 zł advance: 100 zł cash on delivery, as the label states.
    items: [{ product_id: p.id, quantity: 2 }],
  });
  const status = async (s: string) =>
    ok('/api/orders/' + o.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((path) => ok(path), '/api/orders/' + o.id + '/status', { status: s }));
  await ok('/api/orders/' + o.id + '/payments', 'POST', { client_key: randomUUID(), version: Number((await ok('/api/orders/' + o.id)).version), kind: 'receipt', amount: 10000, currency: 'PLN', reference: 'Zaliczka QA', confirmed: true });
  if ((await ok('/api/orders/' + o.id)).status === 'new') await status('paid');
  await status('picking');
  await ok('/api/orders/' + o.id + '/scan', 'POST', { code: p.sku });
  await ok('/api/orders/' + o.id + '/scan', 'POST', { code: p.sku });
  await status('packed');
  const ch = randomUUID();
  await tenantTx(DEMO_TENANT, (c) =>
    c.query("INSERT INTO channels(id,tenant_id,provider,name,mode,credentials,settings) VALUES($1,$2,'inpost','InPost QA',$3,$4,$5)", [
      ch, DEMO_TENANT, 'sandbox', encrypt({ access_token: 'fixture' }), JSON.stringify({ organization_id: '1', simulation: true }),
    ]),
  );
  const plan = await ok('/api/orders/' + o.id + '/shipping/preview', 'POST', {
    channel_id: ch, service: 'inpost_locker_standard', receiver: { first_name: 'Odbiorca', last_name: 'QA', email: 'defaults@example.test', phone: '500600700' },
    target_point: 'WAW01M', template: 'small', weight: 1, cod: 10000, insurance: 10000,
  });
  await runJob((await ok('/api/shipping-plans/' + plan.id + '/queue', 'POST', {})).job_id);
  const quoted = await planOf(plan.id);
  await runJob((await ok('/api/shipping-plans/' + plan.id + '/buy', 'POST', { offer_id: quoted.offers[0].id, confirm_cost: true, ack_unknown_rate: true })).job_id);
  const ready = await planOf(plan.id);
  assert.equal(ready.state, 'ready');
  // Only the automation jobs of this test run: no carrier, tracking or leftover jobs reach the network.
  await pool.query("UPDATE jobs SET state='done',lease_token=NULL WHERE state IN ('pending','running')");
  await drain();
  assert.equal((await ok('/api/orders/' + o.id)).status, 'packed');
  // The carrier reports the parcel on its way although nobody pressed „Nadaj”.
  await pool.query("UPDATE shipments SET tracking_demo_status='out_for_delivery' WHERE id=$1", [ready.shipment_id]);
  await ok('/api/shipments/' + ready.shipment_id + '/tracking', 'POST', {});
  await drain();
  assert.equal((await ok('/api/orders/' + o.id)).status, 'shipped');
  const s = (await pool.query('SELECT dispatched_at FROM shipments WHERE id=$1', [ready.shipment_id])).rows[0];
  assert.ok(s.dispatched_at, 'Nadanie z reguły przekazuje etykietę przewoźnikowi');
});
