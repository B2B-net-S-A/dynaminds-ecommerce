import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../server/app';
import { pool, migrate } from '../server/db';
import { seed } from './fixtures';
import { tick } from '../server/worker';
import { inWindow } from '../server/automation-v2-eval';
import { scheduleV2TimeChecks } from '../server/automation-v2';
import { DEFAULT_RUN } from '../shared/automation-v2';
assert.equal(process.env.DYNA_TEST, 'true');

let app: FastifyInstance, admin: string, operator: string, viewer: string, other: string, warehouse: string, product: string;
const V2 = '/api/automations/v2';
const req = (url: string, method: any = 'GET', payload?: any, cookie = admin) => app.inject({ url, method, payload, headers: { cookie } });
async function ok(url: string, method: any = 'GET', payload?: any, cookie = admin) {
  const r = await req(url, method, payload, cookie);
  assert.ok(r.statusCode < 300, `${method} ${url}: ${r.statusCode} ${r.body}`);
  return r.json();
}
before(async () => {
  await migrate();
  await seed();
  app = await buildApp();
  const login = async (email: string) => {
    const r = await app.inject({ url: '/api/auth/login', method: 'POST', payload: { email, password: 'DynaDemo!2026' } });
    assert.equal(r.statusCode, 200, r.body);
    return r.headers['set-cookie']!.toString().split(';')[0];
  };
  admin = await login('admin@demo.local');
  operator = await login('operator@demo.local');
  viewer = await login('viewer@demo.local');
  other = await login('other@demo.local');
  warehouse = (await ok('/api/warehouses')).data[0].id;
  product = (await ok('/api/products', 'POST', { name: 'Reguły v2', sku: 'V2-' + randomUUID(), price: 2500, warehouse_id: warehouse, quantity: 1000 })).id;
});
beforeEach(async () => {
  await pool.query("UPDATE automation_rules SET enabled=false,version=version+1 WHERE enabled");
  await pool.query("UPDATE jobs SET state='done',lease_token=NULL WHERE state IN ('pending','running')");
});
after(async () => {
  await app.close();
  await pool.end();
});

async function order(email = 'v2@example.test') {
  return ok('/api/orders', 'POST', {
    customer_name: 'QA reguły',
    email,
    warehouse_id: warehouse,
    items: [{ product_id: product, quantity: 1 }],
    address: { country: 'PL', city: 'Warszawa', phone: '500600700' },
  });
}
const get = (o: any) => ok('/api/orders/' + o.id);
// set_priority writes the „Priorytet” order field (server/automation-v2-effects-org.ts).
const priorityOf = async (o: any) =>
  (await ok('/api/orders/' + o.id + '/fields')).data.find((f: any) => f.definition.key === 'priorytet_zamowienia')?.value?.options_snapshot?.[0]?.label;
const act = (o: any, a: any, c = admin) => ok('/api/orders/' + o.id + '/operations', 'POST', a, c);
async function drain() {
  for (let i = 0; i < 300; i++) if (!(await tick())) return;
  assert.fail('Kolejka nie wygasła w 300 krokach');
}
const leaf = (field: string, op: string, value?: unknown, quantifier?: string) => ({ field, op, value, ...(quantifier ? { quantifier } : {}) });
const body = ({ run, conditions, effects, stop_further, ...top }: any = {}) => ({
  name: 'V2 ' + randomUUID().slice(0, 8),
  trigger: 'order.matches',
  enabled: true,
  ...top,
  config: {
    version: 2,
    group: 'Testy',
    scope: 'orders',
    run: { ...DEFAULT_RUN, ...(run ?? {}) },
    conditions: conditions ?? { match: 'all', items: [] },
    effects: effects ?? [{ type: 'add_tag', params: { tag: 'V2' } }],
    stop_further: stop_further ?? false,
  },
});
const create = (patch: any = {}, cookie = admin) => ok(V2 + '/rules', 'POST', body(patch), cookie);
const runsOf = async (ruleId: string, orderId?: string) =>
  (await pool.query('SELECT * FROM automation_runs WHERE rule_id=$1 AND ($2::uuid IS NULL OR order_id=$2) ORDER BY created_at,id', [ruleId, orderId ?? null])).rows;

test('catalog: grouped options, money units, unsupported effects and triggers', async () => {
  const c = await ok(V2 + '/catalog', 'GET', undefined, viewer);
  const status = c.fields.find((f: any) => f.key === 'order.status');
  assert.ok(status.options.some((o: any) => o.value === 'ready_to_ship' && o.group === 'W realizacji'));
  assert.equal(c.fields.find((f: any) => f.key === 'order.total').unit, 'money');
  assert.equal(c.fields.find((f: any) => f.key === 'product.sku').per_line, true);
  assert.ok(c.fields.find((f: any) => f.key === 'warehouse.id').options.some((o: any) => o.value === warehouse));
  assert.equal(c.effects.find((e: any) => e.type === 'assign_warehouse').supported, false);
  assert.equal(c.effects.find((e: any) => e.type === 'merge_orders').supported, undefined);
  assert.equal(c.effects.find((e: any) => e.type === 'split_order').supported, undefined);
  assert.equal(c.effects.find((e: any) => e.type === 'add_tag').supported, undefined);
  assert.notEqual(c.triggers.find((t: any) => t.key === 'stock.changed').supported, false);
  assert.deepEqual(c.operators.bool, ['is_true', 'is_false']);
  assert.ok(Array.isArray(c.groups));
});

test('defaults are seeded once for an admin, never duplicated, and hidden from v1', async () => {
  const first = (await ok(V2 + '/rules')).data;
  assert.ok(first.some((r: any) => r.name === 'Opłacone → Nowe' && r.trigger === 'order.matches'));
  assert.ok(first.some((r: any) => r.trigger === 'shipment.status_changed'));
  const again = (await ok(V2 + '/rules')).data;
  assert.equal(again.filter((r: any) => r.name === 'Opłacone → Nowe').length, 1);
  const v1 = (await ok('/api/automations')).data;
  assert.ok(!v1.some((r: any) => String(r.trigger).startsWith('v2:')));
});

test('CRUD: admin only, stale version 409, versions with before/after, copy disabled, order, delete', async () => {
  assert.equal((await req(V2 + '/rules', 'POST', body(), operator)).statusCode, 403);
  const bad = await req(V2 + '/rules', 'POST', body({ conditions: { match: 'all', items: [leaf('order.status', 'gt', 1)] } }));
  assert.equal(bad.statusCode, 422);
  assert.match(bad.json().message ?? bad.body, /Operator/);
  const foreign = await req(V2 + '/rules', 'POST', body({ conditions: { match: 'all', items: [leaf('warehouse.id', 'in', [randomUUID()])] } }));
  assert.equal(foreign.statusCode, 422);
  const r = await create();
  assert.equal(r.trigger, 'order.matches');
  assert.equal(r.barcode, null);
  const updated = await ok(V2 + '/rules/' + r.id, 'PUT', { ...body({ name: 'Zmieniona', run: { barcode: true } }), version: r.version });
  assert.equal(updated.version, r.version + 1);
  assert.match(updated.barcode, /^AR-[0-9A-F]{10}$/);
  assert.equal((await req(V2 + '/rules/' + r.id, 'PUT', { ...body(), version: r.version })).statusCode, 409);
  const versions = (await ok(V2 + '/rules/' + r.id + '/versions')).data;
  assert.equal(versions[0].after.name, 'Zmieniona');
  assert.equal(versions[0].before.name, r.name);
  assert.equal(versions[1].before, null);
  const copy = await ok(V2 + '/rules/' + r.id + '/copy', 'POST', {});
  assert.equal(copy.enabled, false);
  assert.match(copy.name, /kopia/);
  assert.deepEqual(await ok(V2 + '/rules/order', 'PATCH', { ids: [copy.id, r.id] }), { ok: true });
  const listed = (await ok(V2 + '/rules')).data.filter((x: any) => [copy.id, r.id].includes(x.id));
  assert.deepEqual(listed.map((x: any) => x.id), [copy.id, r.id]);
  assert.deepEqual(await ok(V2 + '/rules/' + copy.id, 'DELETE'), { ok: true });
  assert.equal((await pool.query('SELECT 1 FROM automation_rules WHERE id=$1', [copy.id])).rowCount, 0);
  // A rule with runs is only hidden.
  const o = await order();
  await ok(V2 + '/rules/' + r.id, 'PUT', { ...body({ name: 'Zmieniona', run: { manual_button: true } }), version: updated.version });
  await ok(V2 + '/rules/' + r.id + '/run', 'POST', { order_ids: [o.id] });
  await ok(V2 + '/rules/' + r.id, 'DELETE');
  assert.equal((await pool.query('SELECT enabled FROM automation_rules WHERE id=$1', [r.id])).rows[0].enabled, false);
  assert.ok(!(await ok(V2 + '/rules')).data.some((x: any) => x.id === r.id));
  // Other tenants see nothing.
  assert.equal((await req(V2 + '/rules/' + r.id + '/versions', 'GET', undefined, other)).json().data.length, 0);
});

test('order.matches continuous fires each time the order newly meets the conditions; once only once', async () => {
  const cont = await create({ conditions: { match: 'all', items: [leaf('order.tags', 'in', ['T1'])] }, effects: [{ type: 'add_note', params: { note: 'ciągła' } }] });
  const once = await create({ run: { mode: 'once' }, conditions: { match: 'all', items: [leaf('order.tags', 'in', ['T1'])] }, effects: [{ type: 'add_note', params: { note: 'raz' } }] });
  const o = await order();
  await drain();
  assert.equal((await runsOf(cont.id, o.id)).length, 0);
  await act(o, { type: 'add_tag', tag: 'T1' });
  await drain();
  // A second change while still matching does not fire again.
  await act(o, { type: 'add_tag', tag: 'Inny' });
  await drain();
  await act(o, { type: 'remove_tag', tag: 'T1' });
  await drain();
  await act(o, { type: 'add_tag', tag: 'T1' });
  await drain();
  const c = await runsOf(cont.id, o.id);
  assert.deepEqual(c.map((r) => r.state), ['done', 'done']);
  assert.equal(c[0].definition.source, 'auto');
  assert.deepEqual((await runsOf(once.id, o.id)).map((r) => r.state), ['done']);
  const card = await get(o);
  assert.match(card.note, /ciągła/);
  const history = (await pool.query("SELECT detail FROM order_events WHERE order_id=$1 AND kind='automation.rule_applied' ORDER BY created_at", [o.id])).rows;
  assert.ok(history.some((h) => /^Reguła V2 .*: Dodano notatkę/.test(h.detail.message)));
  const log = (await ok(V2 + '/runs?rule_id=' + cont.id)).data;
  assert.equal(log.length, 2);
  assert.equal(log[0].order_number, o.number);
});

test('event trigger, priority order and stop_further', async () => {
  const first = await create({ trigger: 'order.status_changed', stop_further: true, conditions: { match: 'all', items: [leaf('order.status', 'in', ['paid'])] }, effects: [{ type: 'add_tag', params: { tag: 'Pierwsza' } }] });
  const second = await create({ trigger: 'order.status_changed', effects: [{ type: 'add_tag', params: { tag: 'Druga' } }] });
  await ok(V2 + '/rules/order', 'PATCH', { ids: [first.id, second.id] });
  const o = await order();
  await act(o, { type: 'set_status', status: 'paid' });
  await drain();
  const tags = (await get(o)).tags;
  assert.ok(tags.includes('Pierwsza'));
  assert.ok(!tags.includes('Druga'));
  assert.equal((await runsOf(first.id, o.id))[0].definition.source, 'event');
  // Without stop_further the lower rule runs too.
  await ok(V2 + '/rules/' + first.id, 'PUT', { ...body({ name: first.name, trigger: 'order.status_changed', conditions: { match: 'all', items: [leaf('order.status', 'in', ['picking'])] }, effects: [{ type: 'add_tag', params: { tag: 'Pierwsza' } }] }), version: first.version });
  await act(o, { type: 'set_status', status: 'picking' });
  await drain();
  assert.ok((await get(o)).tags.includes('Druga'));
});

test('delay and working hours schedule the run at the next opening (Europe/Warsaw)', async () => {
  const hours = { days: [1, 2, 3, 4, 5], from: '08:00', to: '16:00' };
  const r = await create({ trigger: 'order.created', run: { delay_minutes: 30, hours }, effects: [{ type: 'add_tag', params: { tag: 'Opóźniona' } }] });
  const o = await order();
  await drain();
  const [run] = await runsOf(r.id, o.id);
  assert.equal(run.state, 'queued');
  const job = (await pool.query('SELECT run_at FROM jobs WHERE id=$1', [run.job_id])).rows[0];
  const created = (await pool.query("SELECT created_at FROM order_events WHERE id=$1", [run.event_id])).rows[0].created_at;
  assert.ok(job.run_at.getTime() >= created.getTime() + 30 * 60_000 - 1000);
  assert.ok(inWindow(job.run_at.getTime(), hours));
  assert.ok(!(await get(o)).tags.includes('Opóźniona'));
  await pool.query('UPDATE jobs SET run_at=now() WHERE id=$1', [run.job_id]);
  await drain();
  assert.equal((await runsOf(r.id, o.id))[0].state, 'done');
  assert.ok((await get(o)).tags.includes('Opóźniona'));
});

test('delayed run re-checks conditions at execution time', async () => {
  const r = await create({ trigger: 'order.created', run: { delay_minutes: 60 }, conditions: { match: 'all', items: [leaf('payment.state', 'in', ['unpaid'])] }, effects: [{ type: 'add_tag', params: { tag: 'Przypomnienie' } }] });
  const o = await order();
  await drain();
  await act(o, { type: 'set_status', status: 'paid' });
  const [run] = await runsOf(r.id, o.id);
  await pool.query('UPDATE jobs SET run_at=now() WHERE id=$1', [run.job_id]);
  await drain();
  const after = (await runsOf(r.id, o.id))[0];
  assert.equal(after.state, 'skipped');
  assert.match(after.result.reason, /Warunki/);
});

test('manual run (max 100, operator allowed), manual list, barcode and refusals', async () => {
  const r = await create({ run: { auto: false, manual_button: true, barcode: true }, effects: [{ type: 'set_priority', params: { priority: 'high' } }] });
  const plain = await create({ effects: [{ type: 'add_tag', params: { tag: 'X' } }] });
  const o1 = await order(), o2 = await order();
  const res = await ok(V2 + '/rules/' + r.id + '/run', 'POST', { order_ids: [o1.id, o2.id] }, operator);
  assert.deepEqual(res.runs.map((x: any) => [x.status, x.source]), [['done', 'manual'], ['done', 'manual']]);
  assert.equal(await priorityOf(o1), 'Wysoki');
  assert.equal((await req(V2 + '/rules/' + r.id + '/run', 'POST', { order_ids: [o1.id] }, viewer)).statusCode, 403);
  assert.equal((await req(V2 + '/rules/' + plain.id + '/run', 'POST', { order_ids: [o1.id] })).statusCode, 409);
  assert.equal((await req(V2 + '/rules/' + r.id + '/run', 'POST', { order_ids: Array.from({ length: 101 }, () => randomUUID()) })).statusCode, 422);
  const manual = (await ok(V2 + '/manual?order_id=' + o1.id)).data;
  assert.ok(manual.some((m: any) => m.id === r.id && m.group === 'Testy'));
  assert.ok(!manual.some((m: any) => m.id === plain.id));
  const rules = (await ok(V2 + '/rules')).data;
  const code = rules.find((x: any) => x.id === r.id).barcode;
  const o3 = await order();
  const scanned = await ok(V2 + '/barcode', 'POST', { code: code.toLowerCase(), order: o3.number }, operator);
  assert.equal(scanned.source, 'barcode');
  assert.equal(scanned.status, 'done');
  assert.equal(await priorityOf(o3), 'Wysoki');
  assert.equal((await req(V2 + '/barcode', 'POST', { code: 'AR-0000000000', order: o3.number })).statusCode, 404);
  // Conditions still apply to a manual run.
  const cond = await create({ run: { auto: false, manual_button: true }, conditions: { match: 'all', items: [leaf('order.status', 'in', ['cancelled'])] } });
  const [skip] = (await ok(V2 + '/rules/' + cond.id + '/run', 'POST', { order_ids: [o1.id] })).runs;
  assert.equal(skip.status, 'skipped');
});

test('preview counts current orders; test mode applies nothing', async () => {
  const tag = 'P' + randomUUID().slice(0, 6);
  const a = await order(), b = await order();
  await act(a, { type: 'add_tag', tag });
  await act(b, { type: 'add_tag', tag });
  const r = await create({ conditions: { match: 'all', items: [leaf('order.tags', 'in', [tag])] }, effects: [{ type: 'add_tag', params: { tag: 'Nie' } }, { type: 'cancel_order', params: {} }] });
  const p = await ok(V2 + '/rules/' + r.id + '/preview', 'POST', {});
  assert.equal(p.matching, 2);
  assert.deepEqual(new Set(p.sample.map((s: any) => s.id)), new Set([a.id, b.id]));
  const t = await ok(V2 + '/rules/' + r.id + '/test', 'POST', { order_id: a.id });
  assert.equal(t.matched, true);
  assert.equal(t.conditions[0].ok, true);
  assert.deepEqual(t.effects.map((e: any) => e.type), ['add_tag', 'cancel_order']);
  assert.match(t.effects[1].would, /Anuluje/);
  const card = await get(a);
  assert.ok(!card.tags.includes('Nie'));
  assert.notEqual(card.status, 'cancelled');
  // Unsaved editor state can be tested too.
  const t2 = await ok(V2 + '/rules/' + r.id + '/test', 'POST', { order_id: a.id, rule: body({ conditions: { match: 'all', items: [leaf('customer.has_phone', 'is_false')] } }) });
  assert.equal(t2.matched, false);
});

test('loop protection: a rule never runs twice in one chain', async () => {
  const r = await create({ trigger: 'order.section_edited', effects: [{ type: 'add_note', params: { note: 'pętla' } }] });
  const o = await order();
  await act(o, { type: 'add_tag', tag: 'Start' });
  await drain();
  assert.equal((await runsOf(r.id, o.id)).length, 1);
});

test('effects: payment via ledger, workflow, extra tags, notify, cancel; failure rolls back all effects', async () => {
  const pay = await create({ run: { auto: false, manual_button: true }, effects: [{ type: 'add_tag', params: { tag: 'Zapłacono' } }, { type: 'set_payment', params: { method: 'bank_transfer' } }, { type: 'notify_team', params: { message: 'Sprawdź' } }] });
  const o = await order();
  const [run] = (await ok(V2 + '/rules/' + pay.id + '/run', 'POST', { order_ids: [o.id] })).runs;
  assert.equal(run.status, 'done', JSON.stringify(run));
  const card = await get(o);
  assert.equal(card.status, 'paid');
  assert.ok(card.tags.includes('Zapłacono'));
  assert.equal((await pool.query("SELECT count(*)::int n FROM payment_entries WHERE order_id=$1 AND kind='receipt'", [o.id])).rows[0].n, 1);
  assert.equal((await pool.query("SELECT count(*)::int n FROM order_events WHERE order_id=$1 AND kind='automation.notify'", [o.id])).rows[0].n, 1);
  // A refused effect (automation cannot confirm a missing payment) rolls back the earlier tag of the same rule.
  const fail = await create({ run: { auto: false, manual_button: true }, effects: [{ type: 'add_tag', params: { tag: 'Wycofany' } }, { type: 'set_status', params: { status: 'paid' } }] });
  const o2 = await order();
  const [f] = (await ok(V2 + '/rules/' + fail.id + '/run', 'POST', { order_ids: [o2.id] })).runs;
  assert.equal(f.status, 'failed');
  assert.match(f.error, /wpłat/);
  assert.ok(!(await get(o2)).tags.includes('Wycofany'));
  const msg = (await pool.query("SELECT detail FROM order_events WHERE order_id=$1 AND kind='automation.rule_applied'", [o2.id])).rows[0].detail.message;
  assert.match(msg, /nie wykonano/);
  // Workflow and cancel.
  const w = await ok('/api/workflow-statuses', 'POST', { name: 'V2 ' + randomUUID().slice(0, 8), stage: 'new', color: '#2563eb' });
  const wr = await create({ run: { auto: false, manual_button: true }, effects: [{ type: 'set_workflow', params: { status_id: w.id } }, { type: 'cancel_order', params: {} }] });
  const o3 = await order();
  const [x] = (await ok(V2 + '/rules/' + wr.id + '/run', 'POST', { order_ids: [o3.id] })).runs;
  assert.equal(x.status, 'done', JSON.stringify(x));
  assert.equal((await get(o3)).status, 'cancelled');
  // Webhook must be a registered endpoint; unsupported effects are refused.
  assert.equal((await req(V2 + '/rules', 'POST', body({ effects: [{ type: 'webhook', params: { subscription_id: randomUUID() } }] }))).statusCode, 422);
  assert.equal((await req(V2 + '/rules', 'POST', body({ effects: [{ type: 'webhook', params: { url: 'http://169.254.169.254/' } }] }))).statusCode, 422);
  assert.equal((await req(V2 + '/rules', 'POST', body({ effects: [{ type: 'split_order', params: {} }] }))).statusCode, 422);
});

test('run_rule runs another rule in the same chain; history.rule_ran sees it', async () => {
  const target = await create({ run: { auto: false, manual_button: true }, effects: [{ type: 'add_tag', params: { tag: 'Cel' } }] });
  const caller = await create({ run: { auto: false, manual_button: true }, effects: [{ type: 'run_rule', params: { rule_id: target.id } }] });
  const o = await order();
  const [r] = (await ok(V2 + '/rules/' + caller.id + '/run', 'POST', { order_ids: [o.id] })).runs;
  assert.equal(r.status, 'done', JSON.stringify(r));
  assert.ok((await get(o)).tags.includes('Cel'));
  const ran = await create({ run: { auto: false, manual_button: true }, conditions: { match: 'all', items: [leaf('history.rule_ran', 'in', [caller.id])] }, effects: [{ type: 'add_tag', params: { tag: 'Po' } }] });
  const [h] = (await ok(V2 + '/rules/' + ran.id + '/run', 'POST', { order_ids: [o.id] })).runs;
  assert.equal(h.status, 'done');
  assert.equal((await req(V2 + '/rules/' + caller.id, 'PUT', { ...body({ effects: [{ type: 'run_rule', params: { rule_id: caller.id } }] }), version: caller.version })).statusCode, 422);
});

test('time checks fire order.matches rules with relative dates once the order ages', async () => {
  const r = await create({ conditions: { match: 'all', items: [leaf('order.time_in_status', 'older_than', { amount: 1, unit: 'hours' }), leaf('order.tags', 'in', ['Stare'])] }, effects: [{ type: 'add_tag', params: { tag: 'Przeterminowane' } }] });
  const o = await order();
  await act(o, { type: 'add_tag', tag: 'Stare' });
  await drain();
  assert.equal((await runsOf(r.id, o.id)).length, 0);
  // The order has been in its status for 2 hours (orders.created_at is immutable, so the status event is backdated).
  await pool.query("INSERT INTO order_events(id,tenant_id,order_id,kind,detail,created_at) SELECT gen_random_uuid(),tenant_id,id,'order.'||status,'{}',now()-interval '2 hours' FROM orders WHERE id=$1", [o.id]);
  await scheduleV2TimeChecks(null, true);
  await drain();
  const runs = await runsOf(r.id, o.id);
  assert.deepEqual(runs.map((x) => x.state), ['done']);
  assert.equal(runs[0].definition.source, 'schedule');
  assert.ok((await get(o)).tags.includes('Przeterminowane'));
});

test('per-line any/all and nested negated groups against real orders', async () => {
  const r = await create({
    run: { auto: false, manual_button: true },
    conditions: {
      match: 'all',
      items: [
        leaf('product.quantity', 'gte', 1, 'all'),
        leaf('product.stock_sufficient', 'is_true', undefined, 'all'),
        { match: 'any', negate: true, items: [leaf('address.country', 'in', ['DE']), leaf('customer.has_phone', 'is_false')] },
        leaf('payment.state', 'in', ['unpaid']),
        leaf('order.total', 'gt', 0),
        leaf('time.now', 'within_last', { amount: 5, unit: 'minutes' }),
      ],
    },
    effects: [{ type: 'add_tag', params: { tag: 'Wiersze' } }],
  });
  const o = await order();
  const t = await ok(V2 + '/rules/' + r.id + '/test', 'POST', { order_id: o.id });
  assert.equal(t.matched, true, JSON.stringify(t.conditions));
});
