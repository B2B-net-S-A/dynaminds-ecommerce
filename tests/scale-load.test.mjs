import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, chmodSync, existsSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostPause, phasePauses, onBatteryPower, batteryRefusal, FULL_PROFILE_MIN_S } from '../tools/scale/load/lib.mjs';
import { mixCycle, taskAt, rng, uuid4, bucketOf, histogram, addSample, mergeHist, quantile, summarize, orderTotal, lineRefund, cursorBefore,
  negativeFragments, transferFragments, returnPicks, oneShotFixture, aggregate, summarizeMonitor, renderMarkdown, OPERATIONS, SLOTS } from '../tools/scale/load/lib.mjs';
import { queueSample, queueDrained, QUEUE_FULL_EVERY_S } from '../tools/scale/load/lib.mjs';
import { lagDue, LAG_EVERY_S } from '../tools/scale/load/lib.mjs';
import { rateLimitOption, rateLimitRecord, RATE_LIMIT_DEFAULT_PER_MIN } from '../tools/scale/load/lib.mjs';
import { monitorPort } from '../tools/scale/load/lib.mjs';
import { replyHealthRecord } from '../tools/scale/load/lib.mjs';
import { createPreparedScaleHttpOperationBindings, validateFullBaseScaleHttpFixture, SCALE_HTTP_PORT_SOURCE_PINS } from '../scripts/full-base-scale-http-ports.mjs';
import { validateScaleHttpRequest } from '../scripts/full-base-scale-driver.mjs';

const profile = JSON.parse(readFileSync(new URL('../docs/parity/acceptance-profile.v1.json', import.meta.url), 'utf8'));
const mix = profile.config.http.mix;

test('the cycle has exactly the profile percentages and spreads every operation over the 100 slots', () => {
  const c = mixCycle(mix);
  assert.equal(c.length, 100);
  for (const m of mix) assert.equal(c.filter((x) => x === m.id).length, m.percent, m.id);
  // interleaved: each operation of ≥5 % appears in every 25-slot window
  for (let w = 0; w < 100; w += 25) for (const m of mix) assert(c.slice(w, w + 25).includes(m.id), `${m.id} missing in window ${w}`);
  assert.throws(() => mixCycle(mix.slice(1)), /100 percent/);
  assert.throws(() => mixCycle(mix.map((m) => (m.id === 'order_list' ? { ...m, class: 'write' } : m))), /bad mix/);
});

test('clients together walk one sequence: 20 % per tenant and the exact mix per tenant', () => {
  const c = mixCycle(mix);
  for (const clients of [12, 24]) {
    const tasks = [];
    for (let client = 0; client < clients; client++) for (let k = 0; k < 500 * 5 / clients * 2; k++) tasks.push(taskAt(c, client, clients, k));
    const ns = tasks.map((t) => t.n).sort((a, b) => a - b);
    assert.deepEqual(ns.slice(0, 1000), Array.from({ length: 1000 }, (_, i) => i), 'no gaps or repeats in the global sequence');
    const first = tasks.filter((t) => t.n < 2500);
    for (const s of SLOTS) {
      const mine = first.filter((t) => t.tenant_slot === s);
      assert.equal(mine.length, 500);
      for (const m of mix) assert.equal(mine.filter((t) => t.operation === m.id).length, m.percent * 5, `${s} ${m.id}`);
    }
  }
  assert.throws(() => taskAt(c, 12, 12, 0), /bad task/);
});

test('rng is deterministic and uuid4 is canonical v4', () => {
  const a = rng('x'), b = rng('x');
  assert.deepEqual([a(), a(), a()], [b(), b(), b()]);
  const r = rng('k');
  for (let i = 0; i < 200; i++) assert.match(uuid4(r), /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
});

test('histogram buckets follow the profile resolution and quantiles are upper bounds', () => {
  assert.equal(bucketOf(0), 1); assert.equal(bucketOf(0.2), 1); assert.equal(bucketOf(999.1), 1000); assert.equal(bucketOf(1000.5), 1010);
  assert.equal(bucketOf(9999), 10000); assert.equal(bucketOf(10001), Infinity); assert.throws(() => bucketOf(-1));
  const h = histogram();
  for (let i = 1; i <= 100; i++) addSample(h, i);
  assert.equal(quantile(h, 0.5), 50); assert.equal(quantile(h, 0.95), 95); assert.equal(quantile(h, 0.99), 99);
  addSample(h, 20000);
  assert.equal(summarize(h).max_ms, 20000);
  const all = mergeHist(histogram(), h);
  assert.equal(all.count, 101);
  const o = histogram(); addSample(o, 12000);
  assert.equal(summarize(o).p95_ms, '>10000');
  assert.equal(summarize(histogram()).p95_ms, null);
});

test('expected values: order total, line refund allocation, history cursor', () => {
  const prices = new Map([['p1', 1999], ['p2', 500]]);
  assert.equal(orderTotal([{ product_id: 'p1', quantity: 2 }, { product_id: 'p2', quantity: 1 }], prices, 1500), 1999 * 2 + 500 + 1500);
  assert.throws(() => orderTotal([{ product_id: 'p3', quantity: 1 }], prices, 0), /no price/);
  // 3 units for 1000: floor allocation, the units add up to the line total
  assert.deepEqual([lineRefund(1000, 3, 0, 1), lineRefund(1000, 3, 1, 1), lineRefund(1000, 3, 2, 1)], [333, 333, 334]);
  assert.equal(lineRefund(1000, 3, 0, 3), 1000);
  const c = JSON.parse(Buffer.from(cursorBefore('2026-09-27T06:00:00Z'), 'base64url').toString());
  assert.equal(c.date, '2026-09-27T06:00:00.000000Z');
  assert.match(c.id, /^[f-]+4fff-bfff-f+$/);
});

test('WMS projections: negative and transfer fragments, greedy return picks', () => {
  const rows = [{ layer_id: 'l1', lot_id: 'o1', lot_code: 'L', location: 'A-1', quantity: '2', unit_cost_minor: '150', currency: 'PLN', fifo_sequence: 7, known_minor: '300' },
    { layer_id: 'l2', lot_id: 'o2', lot_code: 'M', location: 'A-1', quantity: 1, unit_cost_minor: null, currency: 'PLN', fifo_sequence: '8', known_minor: '0' }];
  assert.deepEqual(negativeFragments(rows).map((f) => [f.quantity, f.value_minor]), [[2, '300'], [1, null]]);
  assert.deepEqual(transferFragments(rows).map((f) => f.fifo_sequence), ['7', '8']);
  const frags = [{ id: 'b', product_id: 'p', remaining: 1, location: 'X' }, { id: 'a', product_id: 'p', remaining: 1, location: 'Y' }, { id: 'c', product_id: 'q', remaining: 5, location: 'Z' }];
  assert.deepEqual(returnPicks(frags, 'p', 2), [{ issue_fragment_id: 'a', quantity: 1, location: 'Y' }, { issue_fragment_id: 'b', quantity: 1, location: 'X' }]);
  assert.throws(() => returnPicks(frags, 'p', 3), /not enough/);
});

test('a one-shot fixture passes the source-pinned bindings and yields exactly the prepared request', () => {
  const r = rng('fixture');
  const tenants = SLOTS.map((slot, i) => ({ slot, tenant_id: uuid4(r), user_id: uuid4(r), cookie: 'dyna_session=s' + i }));
  const key = uuid4(r), warehouse = uuid4(r), product = uuid4(r);
  const command = { client_key: key, body: { customer_name: 'Klient testowy', email: 'k@example.test', warehouse_id: warehouse, source: 'manual', currency: 'PLN', payment_mode: 'prepaid',
    address: { street: 'Testowa 1', city: 'Poznań', postal_code: '60-001', country: 'PL', phone: '500000000' }, shipping_cost: 0, items: [{ product_id: product, quantity: 2 }], note: 'load' }, expected: { total: 400 } };
  const fixture = oneShotFixture(SCALE_HTTP_PORT_SOURCE_PINS, tenants, 'C', 'order_create', command);
  const bindings = tenants.map(({ slot, tenant_id, user_id }) => ({ slot, tenant_id, user_id }));
  validateFullBaseScaleHttpFixture(fixture, bindings);
  assert(Buffer.byteLength(JSON.stringify(fixture)) < 60000);
  const origin = 'http://127.0.0.1:4101', ports = createPreparedScaleHttpOperationBindings({ origin, bindings, context: { fixture } });
  const task = { request_id: 'run:1', tenant_slot: 'C', operation: 'order_create', sequence: 1, client: 0, phase: 'steady12', measured: true };
  const req = validateScaleHttpRequest(ports.C.order_create.prepare(task), task, origin);
  assert.equal(req.method, 'POST'); assert.equal(req.path, '/api/orders'); assert.deepEqual(req.body, command.body);
  assert.equal(req.headers['idempotency-key'], key); assert.equal(req.headers.cookie, 'dyna_session=s2');
  const order = { id: uuid4(r), tenant_id: tenants[2].tenant_id, version: '1', status: 'new', total: 400, shipping_cost: 0, ...command.body,
    items: [{ id: uuid4(r), product_id: product, quantity: 2, line_total: 400 }], events: [], payment: {}, returns: {} };
  assert.deepEqual(ports.C.order_create.complete({ task, http_status: 201, data: order }), { outcome: 'success', reason: null });
  // the command is consumed once
  assert.throws(() => ports.C.order_create.prepare({ ...task, request_id: 'run:2' }), /EXHAUSTED/);
  // a wrong total is a DTO failure, not a success
  const ports2 = createPreparedScaleHttpOperationBindings({ origin, bindings, context: { fixture } });
  ports2.C.order_create.prepare(task);
  assert.throws(() => ports2.C.order_create.complete({ task, http_status: 201, data: { ...order, total: 401 } }));
});

test('aggregate: per phase, operation and tenant; errors grouped with causes; thresholds; markdown', () => {
  const t0 = 1_000_000;
  const phases = [{ id: 'steady12', clients: 12, start_ms: t0, end_ms: t0 + 120000 }];
  const samples = [];
  for (let i = 0; i < 200; i++) {
    const op = Object.keys(OPERATIONS)[i % 8];
    samples.push({ phase: 'steady12', client: i % 12, tenant_slot: SLOTS[i % 5], operation: op, start_ms: t0 + i * 500, duration_ms: OPERATIONS[op] === 'read' ? 20 + (i % 10) : 900,
      http_status: 200, outcome: 'success', reason: null });
  }
  samples.push({ phase: 'steady12', client: 0, tenant_slot: 'B', operation: 'order_create', start_ms: t0 + 5, duration_ms: 30, http_status: 409, outcome: 'failure', reason: 'HTTP_STATUS', detail: 'Za mało towaru' });
  samples.push({ phase: 'steady12', client: 0, tenant_slot: 'B', operation: 'stock_operation', start_ms: t0 + 6, duration_ms: 0, http_status: null, outcome: 'not_bindable', reason: 'NO_WMS_LOTS' });
  samples.push({ phase: 'steady12', client: 1, tenant_slot: 'A', operation: 'order_list', start_ms: t0 + 7, duration_ms: 5, http_status: 429, outcome: 'failure', reason: 'HTTP_STATUS', detail: 'rate' });
  const r = aggregate({ samples, phases, prep: [{ phase: 'steady12', method: 'GET', route: '/api/orders/:id', status: 200, duration_ms: 12 }] });
  const p = r.phases.steady12;
  assert.equal(p.requests, 202); assert.equal(p.success, 200); assert.equal(p.failures, 2); assert.equal(p.not_bindable, 1); assert.equal(p.http_429, 1);
  assert.equal(p.success_rps, +(200 / 120).toFixed(2)); assert.equal(p.rps_60s_buckets.length, 2);
  assert.equal(p.operations.order_create.failures, 1); assert.equal(p.operations.stock_operation.not_bindable, 1);
  assert.equal(p.operations.order_list.within_threshold, true); assert.equal(p.operations.order_create.within_threshold, true);
  assert.equal(p.errors['order_create 409 HTTP_STATUS'].count, 1); assert.equal(p.errors['order_create 409 HTTP_STATUS'].examples[0].detail, 'Za mało towaru');
  assert.equal(p.prep.calls, 1);
  const monitor = summarizeMonitor([{ kind: 'queue', at: t0 + 1000, pending: 4, oldest_pending_s: 2, load1: 9 }, { kind: 'queue', at: t0 + 2000, pending: 1, oldest_pending_s: 0.5, load1: 10 },
    { kind: 'lag', at: t0 + 3000, lags_ms: [100, 200, 3000] }, { kind: 'activity', at: t0 + 1500, active: 2, waits: { 'Lock:transactionid': 1, CPU: 1 }, queries: { 'SELECT x': 2 } }], phases);
  assert.equal(monitor.steady12.pending_max, 4); assert.equal(monitor.steady12.oldest_pending_max_s, 2); assert.equal(monitor.steady12.completion_lag.count, 3);
  assert.equal(monitor.steady12.top_queries[0].key, 'SELECT x');
  const md = renderMarkdown({ run_id: 'x', database: 'db', started_at: 'a', finished_at: 'b', release: { commit: 'c' }, result: { phases: { steady12: { ...p, monitor: monitor.steady12 } } } });
  assert.match(md, /\| order_create \| write \| 25 \| 1 \|/);
  assert.match(md, /Za mało towaru/);
});

test('preparer: catalog/order commands from API reads; stock operations of non-WMS tenants go through manual OFF (no longer not bindable)', async () => {
  const { createPreparer, NotBindable, PrepError } = await import('../tools/scale/load/prepare.mjs');
  const r = rng('prep'), warehouse = uuid4(r);
  const products = Array.from({ length: 40 }, (_, i) => ({ id: uuid4(r), sku: `SC-5076-${i}`, name: `Kubek ceramiczny ${i}`, kind: 'simple', active: true, price: 100 + i, available: 50 }));
  const calls = [];
  const api = async (method, route, path) => { calls.push(`${method} ${path}`);
    if (route === '/api/products') return { status: 200, json: { data: products, meta: { has_more: false, cursor: null } } };
    return { status: 404, json: { detail: 'nope' } }; };
  const prep = createPreparer({ ctx: { slot: 'B', wms: false, main: warehouse }, api, r, client: 0, clients: 12 });
  const { cmd } = await prep('order_create');
  const prices = new Map(products.map((p) => [p.id, p.price]));
  assert.equal(cmd.expected.total, orderTotal(cmd.body.items, prices, cmd.body.shipping_cost));
  assert.equal(new Set(cmd.body.items.map((i) => i.product_id)).size, cmd.body.items.length);
  assert(cmd.body.items.every((i) => i.quantity >= 1 && i.quantity <= 20));
  const s = await prep('catalog_search');
  assert.equal(s.cmd.query.limit, 50); assert.equal(typeof s.cmd.query.search, 'string');
  const l = await prep('order_list');
  assert.deepEqual(l.cmd.expected, { min_rows: 1, max_rows: 50 });
  await assert.rejects(() => prep('stock_operation'), (e) => e instanceof PrepError && !(e instanceof NotBindable) && /manual-corrections\/source/.test(e.route));
  assert(calls.filter((c) => c.startsWith('GET /api/products')).length <= 2, 'catalogue read once per client (one window from a random id, wrapped once)');
  await assert.rejects(() => prep('order_detail'), /404/);
});

// ---- profile fidelity (28.10): labelled races, 409 causes, mix and write share, skipped commands, stock --------------
test('every 409 gets a cause; only the pre-labelled stock-version races of their own operation are expected refusals', async () => {
  const { classifyConflict, EXPECTED_RACES } = await import('../tools/scale/load/lib.mjs');
  assert.deepEqual(EXPECTED_RACES.map((x) => [x.id, x.operation, x.status]), [['return_stock_version', 'return_receive', 409], ['stock_version', 'stock_operation', 409],
    ['manual_off_source', 'stock_operation', 409]]);
  assert.deepEqual(classifyConflict('stock_operation', 409, 'Manual OFF native source or authority refused'), { cause: 'manual_off_source', labelled: true });
  assert.deepEqual(classifyConflict('return_receive', 409, 'Zapas zwrotu zmienił wersję. Odczytaj ponownie cały zakres'), { cause: 'return_stock_version', labelled: true });
  assert.deepEqual(classifyConflict('stock_operation', 409, 'Stan lub rezerwacja zmieniły wersję'), { cause: 'stock_version', labelled: true });
  // exact native reason required: a prefix or another operation is not the labelled race
  assert.deepEqual(classifyConflict('return_receive', 409, 'Zapas zwrotu zmienił wersję'), { cause: 'version_other', labelled: false });
  assert.deepEqual(classifyConflict('order_create', 409, 'Stan lub rezerwacja zmieniły wersję'), { cause: 'stock_version', labelled: false });
  assert.deepEqual(classifyConflict('order_create', 409, 'Za mało towaru: SC-B-000127. Dostępne: 1'), { cause: 'stock_shortage', labelled: false });
  assert.deepEqual(classifyConflict('reserve_and_status', 409, 'Zamówienie zmieniło się. Odśwież i spróbuj ponownie'), { cause: 'order_version', labelled: false });
  assert.deepEqual(classifyConflict('stock_operation', 409, 'Polityka WMS zmieniła wersję'), { cause: 'policy_version', labelled: false });
  assert.deepEqual(classifyConflict('return_receive', 409, 'Pięć zgłoszeń czeka na decyzję'), { cause: 'other', labelled: false });
  assert.equal(classifyConflict('return_receive', 422, 'Zapas zwrotu zmienił wersję. Odczytaj ponownie cały zakres'), null, 'only 409 may be an expected refusal');
  assert.equal(classifyConflict('order_list', 200, null), null);
});

test('skipped commands are classified: lack of stock vs other preparation refusals', async () => {
  const { skipCause } = await import('../tools/scale/load/lib.mjs');
  assert.equal(skipCause('order_create: 0 only 24 products with stock ≥ 8'), 'stock');
  assert.equal(skipCause('stock_operation: 0 no lot position with available stock'), 'stock');
  assert.equal(skipCause('POST /api/orders: 409 Za mało towaru: SC-A-000018. Dostępne: 1'), 'stock');
  assert.equal(skipCause('return_receive: 0 no returnable line'), 'other');
  assert.equal(skipCause(null), 'other');
});

function fidelitySamples(t0) {
  const samples = [], add = (s) => samples.push({ phase: 'steady12', client: 0, tenant_slot: 'A', http_status: 200, outcome: 'success', reason: null, duration_ms: 10, ...s });
  const c = mixCycle(mix);
  // 200 tasks over 2 minutes in cycle order: exactly the profile mix
  for (let i = 0; i < 200; i++) { const op = c[i % 100]; add({ operation: op, class: OPERATIONS[op], start_ms: t0 + i * 600, duration_ms: OPERATIONS[op] === 'read' ? 20 : 1000 }); }
  return samples;
}

test('aggregate: labelled refusals are requests but not successes, within the 1 % budget, with no-effect evidence; 409s by cause', () => {
  const t0 = 2_000_000, phases = [{ id: 'steady12', clients: 12, start_ms: t0, end_ms: t0 + 120000 }];
  const samples = fidelitySamples(t0);
  const ok = aggregate({ samples, phases, mix }).phases.steady12;
  samples.push({ phase: 'steady12', client: 1, tenant_slot: 'C', operation: 'return_receive', class: 'write', start_ms: t0 + 100, duration_ms: 5, http_status: 409,
    outcome: 'expected_refusal', reason: 'LABELLED_RACE', conflict_cause: 'return_stock_version', no_effect: true, detail: 'Zapas zwrotu zmienił wersję. Odczytaj ponownie cały zakres' });
  samples.push({ phase: 'steady12', client: 2, tenant_slot: 'E', operation: 'stock_operation', class: 'write', start_ms: t0 + 200, duration_ms: 4, http_status: 409,
    outcome: 'expected_refusal', reason: 'LABELLED_RACE', conflict_cause: 'stock_version', no_effect: null, detail: 'Stan lub rezerwacja zmieniły wersję' });
  samples.push({ phase: 'steady12', client: 3, tenant_slot: 'B', operation: 'order_create', class: 'write', start_ms: t0 + 300, duration_ms: 30, http_status: 409,
    outcome: 'failure', reason: 'HTTP_STATUS', conflict_cause: 'stock_shortage', detail: 'Za mało towaru: SC-B-1. Dostępne: 0' });
  samples.push({ phase: 'steady12', client: 3, tenant_slot: 'A', operation: 'stock_operation', class: 'write', start_ms: t0 + 400, duration_ms: 6, http_status: 409,
    outcome: 'failure', reason: 'REFUSAL_HAD_EFFECT', conflict_cause: 'stock_version', no_effect: false, detail: 'Stan lub rezerwacja zmieniły wersję' });
  const p = aggregate({ samples, phases, mix }).phases.steady12;
  assert.equal(p.requests, 204); assert.equal(p.success, 200); assert.equal(p.failures, 2); assert.equal(p.expected_refusals, 2);
  assert.equal(p.success_rps, ok.success_rps, 'refusals are excluded from success throughput');
  assert.deepEqual(p.write, ok.write, 'fast refusals do not improve success percentiles');
  assert.equal(p.expected_refusal_fraction, +(2 / 204).toFixed(4)); assert.equal(p.expected_refusals_within_budget, true);
  assert.deepEqual(p.refusal_no_effect, { confirmed: 1, unconfirmed: 1, had_effect: 1 });
  assert.equal(p.refusal_latency.count, 2);
  assert.deepEqual(p.conflicts_409, {
    return_stock_version: { count: 1, labelled: true, expected_refusals: 1, errors: 0, by_operation: { return_receive: 1 } },
    stock_shortage: { count: 1, labelled: false, expected_refusals: 0, errors: 1, by_operation: { order_create: 1 } },
    stock_version: { count: 2, labelled: true, expected_refusals: 1, errors: 1, by_operation: { stock_operation: 2 } } });
  assert.equal(p.operations.return_receive.expected_refusals, 1); assert.equal(p.operations.return_receive.attempted, ok.operations.return_receive.attempted + 1);
  // budget = 1 % of all requests of the phase: 2 of 204 is within, 3 of 205 is not
  const many = [...samples, { ...samples.at(-4), start_ms: t0 + 500 }];
  assert.equal(aggregate({ samples: many, phases, mix }).phases.steady12.expected_refusals_within_budget, false);
  const md = renderMarkdown({ run_id: 'x', database: 'db', started_at: 'a', finished_at: 'b', release: { commit: 'c' }, result: { phases: { steady12: p } } });
  assert.match(md, /Expected refusals \(labelled races\) 2/); assert.match(md, /409 by cause: return_stock_version 1 \(labelled\)/); assert.match(md, /stock_shortage 1 \(error\)/);
});

test('aggregate: sent mix and write share against the profile, per phase and per 60-s bucket; skipped commands by cause', () => {
  const t0 = 3_000_000, phases = [{ id: 'steady12', clients: 12, start_ms: t0, end_ms: t0 + 120000 }];
  const samples = fidelitySamples(t0);
  let p = aggregate({ samples, phases, mix }).phases.steady12;
  assert.equal(p.mix.write_share_profile_percent, 40); assert.equal(p.mix.write_share_percent, 40);
  assert.deepEqual(p.mix.write_share_60s_buckets, [40, 40]); assert.equal(p.mix.within_tolerance, true); assert.equal(p.mix.max_deviation_pp, 0);
  assert.equal(p.mix.sent_percent.order_create, 15); assert.equal(p.mix.profile_percent.order_list, 25);
  assert.deepEqual(p.skipped, { stock: 0, other: 0, not_bindable: 0 });
  // the l250 failure mode: writes of the second minute are prepared but never sent (no stock) → reads take over the loop
  const starved = samples.map((s) => (s.class === 'write' && s.start_ms >= t0 + 60000
    ? { ...s, outcome: 'prep_failed', reason: 'PREP_FAILED', http_status: null, duration_ms: 0, detail: s.operation === 'stock_operation' ? 'stock_operation: 0 no lot position with available stock' : 'order_create: 0 only 20 products with stock ≥ 8' } : s));
  starved.push({ ...starved[0], outcome: 'prep_failed', reason: 'PREP_FAILED', operation: 'return_receive', class: 'write', detail: 'return_receive: 0 no returnable line', start_ms: t0 + 1 });
  p = aggregate({ samples: starved, phases, mix }).phases.steady12;
  assert.deepEqual(p.skipped, { stock: 40, other: 1, not_bindable: 0 });
  assert.deepEqual(p.mix.write_share_60s_buckets, [40, 0]); assert.equal(p.mix.write_share_min_bucket_percent, 0);
  assert.equal(p.mix.within_tolerance, false); assert.equal(p.mix.write_share_percent, 25);
  const md = renderMarkdown({ run_id: 'x', database: 'db', started_at: 'a', finished_at: 'b', release: { commit: 'c' }, result: { phases: { steady12: p } } });
  assert.match(md, /Write share of sent requests 25 % \(profile 40 %/); assert.match(md, /skipped for lack of stock 40/);
});

test('monitor: per-tenant saleable stock, its consumption per minute and the runway', () => {
  const t0 = 4_000_000, phases = [{ id: 'steady12', clients: 12, start_ms: t0, end_ms: t0 + 120000 }];
  const rows = [{ kind: 'stock', at: t0 + 1000, tenants: { A: { available: 10000, products_ge8: 900 }, B: { available: 8000, products_ge8: 700 } } },
    { kind: 'stock', at: t0 + 61000, tenants: { A: { available: 9400, products_ge8: 880 }, B: { available: 7700, products_ge8: 690 } } },
    { kind: 'stock', at: t0 + 121000, tenants: { A: { available: 8800, products_ge8: 860 }, B: { available: 7400, products_ge8: 680 } } }];
  const m = summarizeMonitor(rows, phases).steady12;
  assert.deepEqual(m.stock.A, { first: 10000, last: 9400, min: 9400, products_ge8_last: 880, consumed_per_min: 600, runway_min: +(9400 / 600).toFixed(1) });
  assert.equal(m.stock.B.consumed_per_min, 300);
});

test('preparer: catalogue windows start at a random id and wrap, so a large catalogue is used beyond its first pages', async () => {
  const { createPreparer } = await import('../tools/scale/load/prepare.mjs');
  const r0 = rng('cat'), warehouse = uuid4(r0);
  const all = Array.from({ length: 2000 }, (_, i) => ({ id: uuid4(r0), sku: `SC-A-${i}`, name: `Kubek ${i}`, kind: 'simple', active: true, price: 100 + i, available: 30 })).sort((a, b) => a.id.localeCompare(b.id));
  const calls = [];
  const api = async (method, route, path) => {
    const u = new URL(path, 'http://x'), after = u.searchParams.get('after'), limit = Number(u.searchParams.get('limit'));
    assert(u.searchParams.getAll('after').length <= 1, 'one keyset cursor per request'); calls.push(path);
    const rows = all.filter((p) => !after || p.id > after), data = rows.slice(0, limit);
    return { status: 200, json: { data, meta: { has_more: rows.length > limit, cursor: rows.length > limit ? data.at(-1).id : null } } };
  };
  const seen = new Set();
  for (let c = 0; c < 6; c++) {
    const prep = createPreparer({ ctx: { slot: 'B', wms: false, main: warehouse }, api, r: rng('cat' + c), client: c, clients: 12 });
    for (let k = 0; k < 3; k++) { const { cmd } = await prep('order_create'); for (const i of cmd.body.items) seen.add(i.product_id); }
  }
  const index = new Map(all.map((p, i) => [p.id, i]));
  assert([...seen].some((id) => index.get(id) >= 600), 'products beyond the first three pages are ordered');
  // a window that starts near the end wraps around to the beginning and still holds three pages
  calls.length = 0;
  let n = 0; const rest = rng('late'), lateR = () => (n++ < 16 ? 0.999 : rest()); // window start ffffffff-…: past every id
  const late = createPreparer({ ctx: { slot: 'B', wms: false, main: warehouse }, api, r: lateR, client: 0, clients: 12 });
  await late('order_create');
  assert(calls.length >= 2 && !calls.at(-1).includes('after=f'), 'wrapped to the start of the catalogue');
});

test('preparer: no-effect readback of a refused return receipt and of a refused WMS adjustment', async () => {
  const { createPreparer } = await import('../tools/scale/load/prepare.mjs');
  const r0 = rng('noeff'), main = uuid4(r0), orderId = uuid4(r0), returnId = uuid4(r0), product = uuid4(r0), layer = uuid4(r0);
  // an unreceived case has receipt_sequence 0 (return_cases default; seen on the refused case of fid61-01)
  let caseRow = { id: returnId, version: 1, receipt_sequence: 0, state: 'requested' };
  let positions = [{ product_id: product, layer_id: layer, location: 'A-01', lot_code: 'L1', quantity: 10, available: 10, stock_version: '5' }];
  const api = async (method, route) => {
    if (route === '/api/orders/:id') return { status: 200, json: { id: orderId, returns: { cases: [caseRow] } } };
    if (route === '/api/wms-lots/positions') return { status: 200, json: { data: positions, meta: {} } };
    return { status: 404, json: {} };
  };
  const prep = createPreparer({ ctx: { slot: 'A', wms: true, main }, api, r: r0, client: 0, clients: 12 });
  const ret = prep.noEffect({ kind: 'return_receive', order_id: orderId, return_id: returnId, version: 1 });
  assert.equal(await ret(), true);
  caseRow = { ...caseRow, version: 2, receipt_sequence: 1, state: 'refund_pending' };
  assert.equal(await ret(), false);
  const plus = prep.noEffect({ kind: 'wms_adjustment', product_id: product, lot_code: 'LOAD-1', quantity: 1 });
  assert.equal(await plus(), true);
  positions = [...positions, { product_id: product, layer_id: uuid4(r0), location: 'A-01', lot_code: 'LOAD-1', quantity: 1, available: 1 }];
  assert.equal(await plus(), false);
  const minus = prep.noEffect({ kind: 'wms_adjustment', product_id: product, layer_id: layer, location: 'A-01', quantity: -1, before: 10 });
  assert.equal(await minus(), true);
  positions = positions.map((p) => (p.layer_id === layer ? { ...p, quantity: 8 } : p));
  assert.equal(await minus(), null, 'a different quantity is unconfirmed (other movements touch the layer), not proof of an effect');
});

// ---- host sleep (full run 28.10.2026: clamshell on battery, pmset -g log; the driver did not notice) --------------
test('host pause: a gap over 5 s between 1-s clock samples, sleep (wall >> monotonic) vs. a stalled process', () => {
  const t = 1_800_000_000_000;
  assert.equal(hostPause({ wall: t, mono: 100 }, { wall: t + 1000, mono: 1100 }), null);
  assert.equal(hostPause({ wall: t, mono: 100 }, { wall: t + 5000, mono: 5100 }), null, 'exactly 5 s is not a pause');
  // macOS: performance.now() (mach_absolute_time) stands still while the host sleeps, Date.now() does not.
  assert.deepEqual(hostPause({ wall: t, mono: 100 }, { wall: t + 600_000, mono: 1100 }),
    { kind: 'host_pause', from_ms: t, to_ms: t + 600_000, at: new Date(t + 600_000).toISOString(), wall_gap_ms: 600_000, mono_gap_ms: 1000, cause: 'host_sleep' });
  const stall = hostPause({ wall: t, mono: 100 }, { wall: t + 7000, mono: 7100 });
  assert.equal(stall.cause, 'process_stall'); assert.equal(stall.wall_gap_ms, 7000);
  assert.equal(hostPause({ wall: t, mono: 100 }, { wall: t + 1000, mono: 9100 }).cause, 'process_stall', 'monotonic gap alone also counts');
});

test('aggregate + markdown: a phase overlapped by a host pause is NIEWAŻNA, the others stay valid', () => {
  const t0 = 2_000_000;
  const phases = [{ id: 'warmup', clients: 2, start_ms: t0, end_ms: t0 + 60000 }, { id: 'steady12', clients: 2, start_ms: t0 + 60000, end_ms: t0 + 120000 }];
  const pause = { kind: 'host_pause', from_ms: t0 + 90000, to_ms: t0 + 700000, at: 'x', wall_gap_ms: 610000, mono_gap_ms: 1000, cause: 'host_sleep' };
  const before = { kind: 'host_pause', from_ms: t0 - 20000, to_ms: t0 - 10000, at: 'y', wall_gap_ms: 10000, mono_gap_ms: 10000, cause: 'process_stall' };
  assert.deepEqual(phasePauses([pause, before], phases[1]), [pause]);
  assert.deepEqual(phasePauses([pause, before], phases[0]), []);
  assert.deepEqual(phasePauses([{ ...pause, from_ms: t0 + 120000 }], phases[1]), [], 'a pause starting at the phase end does not overlap');
  const r = aggregate({ samples: [], phases, hostPauses: [pause, before] });
  assert.equal(r.phases.warmup.valid, true); assert.deepEqual(r.phases.warmup.host_pauses, []);
  assert.equal(r.phases.steady12.valid, false); assert.deepEqual(r.phases.steady12.host_pauses, [pause]);
  assert.equal(aggregate({ samples: [], phases }).phases.steady12.valid, true, 'no pause data = valid (older runs)');
  const md = renderMarkdown({ run_id: 'x', database: 'db', started_at: 'a', finished_at: 'b', release: { commit: 'c' }, result: r });
  assert.match(md, /## steady12: 2 clients, 60 s — NIEWAŻNA/);
  assert.match(md, /host_sleep 610 s/);
  assert.doesNotMatch(md, /## warmup[^\n]*NIEWAŻNA/);
});

test('report.mjs rebuild keeps the host pauses of run.json and marks the phase NIEWAŻNA', () => {
  const dir = mkdtempSync(join(tmpdir(), 'scale-load-report-'));
  try {
    mkdirSync(join(dir, 'raw')); writeFileSync(join(dir, 'raw', 'monitor.ndjson'), '');
    const t0 = 3_000_000;
    writeFileSync(join(dir, 'run.json'), JSON.stringify({ run_id: 'r', database: 'db', started_at: 'a', finished_at: 'b', release: { commit: 'c' },
      phases: [{ id: 'steady24', clients: 24, start_ms: t0, end_ms: t0 + 60000 }],
      host_pauses: [{ kind: 'host_pause', from_ms: t0 + 1000, to_ms: t0 + 9000, at: 'z', wall_gap_ms: 8000, mono_gap_ms: 1000, cause: 'host_sleep' }] }));
    const r = spawnSync(process.execPath, [fileURLToPath(new URL('../tools/scale/load/report.mjs', import.meta.url)), dir], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const run = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8'));
    assert.equal(run.result.phases.steady24.valid, false);
    assert.match(readFileSync(join(dir, 'SUMMARY.md'), 'utf8'), /steady24: 24 clients, 60 s — NIEWAŻNA/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

const AC = "Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t80%; charging; 1:00 remaining present: true\n";
const BATTERY = "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t80%; discharging; 5:00 remaining present: true\n";
test('battery gate: macOS on battery refuses a full-profile run unless --allow-battery', () => {
  assert.equal(onBatteryPower(AC), false); assert.equal(onBatteryPower(BATTERY), true); assert.equal(onBatteryPower(''), null);
  const full = { platform: 'darwin', pmset: BATTERY, plannedSeconds: 600 + 2 * 1800, allowBattery: false };
  assert.match(batteryRefusal(full), /baterii.*--allow-battery/s);
  assert.equal(batteryRefusal({ ...full, allowBattery: true }), null);
  assert.equal(batteryRefusal({ ...full, pmset: AC }), null);
  assert.equal(batteryRefusal({ ...full, platform: 'linux' }), null);
  assert.equal(batteryRefusal({ ...full, plannedSeconds: FULL_PROFILE_MIN_S - 1 }), null, 'a 5-min validation run may use the battery');
  assert.equal(batteryRefusal({ ...full, pmset: '' }), null, 'unknown power source does not block');
});

test('run.mjs refuses to start on battery before creating the run directory; --allow-battery passes the gate', { skip: process.platform !== 'darwin' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'scale-load-battery-'));
  try {
    const bin = join(dir, 'bin'); mkdirSync(bin);
    writeFileSync(join(bin, 'pmset'), `#!/bin/sh\nprintf '%s' "${BATTERY.replace(/\n/g, '\\n').replace(/\t/g, ' ')}"\n`); chmodSync(join(bin, 'pmset'), 0o755);
    const run = (...extra) => spawnSync(process.execPath, [fileURLToPath(new URL('../tools/scale/load/run.mjs', import.meta.url)), '--release', join(dir, 'missing-release.json'),
      '--db', 'dynaminds_scale_20261028_01', '--tag', 't', '--out', join(dir, 'out'), ...extra], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    const refused = run();
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /baterii/);
    assert.equal(existsSync(join(dir, 'out')), false);
    const allowed = run('--allow-battery');
    assert.notEqual(allowed.status, 0);
    assert.doesNotMatch(allowed.stderr, /baterii/);
    assert.match(allowed.stderr, /missing-release\.json/, 'past the gate it fails on the missing release file');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('preparer: order_detail reads dataset orders created before the run, not the newest page the load filled', async () => {
  // full-20261029-01 steady24: after 30 min × 12 clients the 600 newest new/paid/picking/packed/cancelled orders of
  // every tenant were the load's own, so every order_detail failed preparation with "no stable dataset orders".
  const { createPreparer } = await import('../tools/scale/load/prepare.mjs');
  const r = rng('detail'), runStart = Date.parse('2026-10-29T03:05:41.000Z');
  const own = Array.from({ length: 600 }, (_, i) => ({ id: uuid4(r), status: 'new', version: 1, total: 100 + i, note: null }));
  const dataset = Array.from({ length: 48 }, (_, i) => ({ id: uuid4(r), status: 'paid', version: 3, total: 500 + i, note: `scale:5076fb8f:A:${i}` }));
  const calls = [];
  const api = async (method, route, path) => { calls.push(path);
    if (route !== '/api/orders') return { status: 404, json: { detail: 'nope' } };
    const after = new URL(path, 'http://x').searchParams.get('after');
    return { status: 200, json: { data: after === cursorBefore(new Date(runStart).toISOString()) ? dataset : own, meta: { has_more: false, cursor: null } } }; };
  const prep = createPreparer({ ctx: { slot: 'A', wms: true, main: uuid4(r) }, api, r, client: 3, clients: 24, datasetBefore: runStart });
  const { cmd } = await prep('order_detail');
  const mine = dataset.filter((_, i) => i % 24 === 3);
  assert(mine.some((o) => o.id === cmd.order_id));
  assert.equal(calls.length, 1);
  assert.match(calls[0], /^\/api\/orders\?status=new,paid,picking,packed,cancelled&limit=200&after=/);
  // Without the bound the newest page is used (and here holds only the load's own orders).
  const unbounded = createPreparer({ ctx: { slot: 'A', wms: true, main: uuid4(r) }, api, r, client: 3, clients: 24 });
  await assert.rejects(() => unbounded('order_detail'), /no stable dataset orders/);
});

test('preparer: the invoice variant is a 230 preview issued by the native /issue alias, never a 157 preview', async () => {
  // The sealed 157 budget refuses a company's 2001st local invoice for life; full-20261029-01 reached 1 703 in one run.
  const { createPreparer } = await import('../tools/scale/load/prepare.mjs');
  const r = rng('inv230'), oid = uuid4(r), series = uuid4(r), pvId = uuid4(r), calls = [];
  const api = async (method, route, path, body) => { calls.push({ method, route, path, body });
    if (route === '/api/orders' && method === 'GET') return { status: 200, json: { data: [{ id: oid }], meta: { has_more: false, cursor: null } } };
    if (route === '/api/orders/:id') return { status: 200, json: { id: oid, status: 'shipped', version: 4, documents: [], returns: { cases: [] }, customer_name: 'Anna Nowak',
      address: { street: 'Polna 3', postal_code: '60-001', city: 'Poznań', country: 'PL' } } };
    if (route === '/api/invoice230/orders/:id/previews') return { status: 201, json: { preview: { id: pvId, scope_hash: 'c'.repeat(64), snapshot: { totals: { gross_minor: '12300' } } } } };
    return { status: 404, json: { detail: 'nope' } }; };
  const prep = createPreparer({ ctx: { slot: 'B', wms: false, main: uuid4(r), series_id: series }, api, r, client: 0, clients: 1 });
  await assert.rejects(() => prep('payment_or_document')); // first of the pair: payment receipt (no API here)
  const { cmd } = await prep('payment_or_document');
  assert.equal(cmd.kind, 'invoice230_issue');
  assert.deepEqual({ order_id: cmd.order_id, preview_id: cmd.preview_id, expected: cmd.expected }, { order_id: oid, preview_id: pvId, expected: { gross_minor: '12300' } });
  assert.deepEqual(cmd.body, { client_key: cmd.client_key, scope_hash: 'c'.repeat(64), confirmed: true, local_only: true });
  const pv = calls.find((c) => c.route === '/api/invoice230/orders/:id/previews');
  assert.equal(pv.path, `/api/invoice230/orders/${oid}/previews`);
  assert.deepEqual(Object.keys(pv.body).sort(), ['buyer', 'client_key', 'order_version', 'sell_date', 'series_id', 'shipping_vat']);
  assert.deepEqual(pv.body.buyer, { kind: 'consumer', name: 'Anna Nowak', address: { street: 'Polna 3', postal_code: '60-001', city: 'Poznań', country: 'PL' } });
  assert.equal(pv.body.order_version, '4'); assert.equal(pv.body.series_id, series);
  assert(!calls.some((c) => c.route.startsWith('/api/local-invoices')), 'no 157 preview');
});

test('monitor: the 1 s queue sample counts only pending jobs (partial index jobs_claim); the full count is every 30 s and while draining', () => {
  // full-20261029-01: a count over the run's jobs every 1 s was a sequential scan of the whole table (no index on
  // created_at; 7 k -> 102 k rows, 98 ms per sample at 1 M rows), the driver's own growing cost.
  assert.equal(QUEUE_FULL_EVERY_S, 30);
  const fast = queueSample(1, false);
  assert.equal(fast.full, false);
  assert.match(fast.sql, /FROM jobs WHERE state='pending' AND created_at >= to_timestamp\(\$1\/1000\.0\)$/);
  assert.doesNotMatch(fast.sql, /running|done|failed/);
  assert.match(fast.sql, /count\(\*\)::int pending/);
  assert.match(fast.sql, /min\(created_at\) FILTER \(WHERE run_at<=clock_timestamp\(\)\)\)::float8 oldest_pending_s/);
  for (const second of [0, 30, 60]) assert.equal(queueSample(second, false).full, true, `second ${second}`);
  for (const second of [1, 29, 31]) assert.equal(queueSample(second, false).full, false, `second ${second}`);
  assert.equal(queueSample(7, true).full, true, 'every second while draining');
  const full = queueSample(30, false).sql;
  for (const k of ['pending', 'running', 'done', 'failed', 'oldest_pending_s']) assert.match(full, new RegExp(`\\b${k}\\b`));
  assert.match(full, /FROM jobs WHERE created_at >= to_timestamp\(\$1\/1000\.0\)$/);
});

test('drain: ends only on a full queue sample after the drain started with nothing pending or running', () => {
  const t = 1_000_000;
  // A pending-only sample cannot end the drain: it does not count running jobs.
  assert.equal(queueDrained([{ kind: 'queue', at: t + 2000, full: false, pending: 0 }], t), false);
  assert.equal(queueDrained([{ kind: 'queue', at: t + 2000, full: true, pending: 0, running: 1 }], t), false);
  assert.equal(queueDrained([{ kind: 'queue', at: t + 500, full: true, pending: 0, running: 0 }], t), false, 'sample from before drain start + 1 s');
  assert.equal(queueDrained([{ kind: 'queue', at: t + 2000, full: true, pending: 0, running: 0 }, { kind: 'queue', at: t + 3000, full: false, pending: 0 }], t), true);
  assert.equal(queueDrained([{ kind: 'queue', at: t + 2000, full: true, pending: 0, running: 0 }, { kind: 'queue', at: t + 3000, full: true, pending: 2, running: 0 }], t), false, 'the latest full sample decides');
});

test('monitor: the completion lag query runs every 30 s and every second while draining or held', () => {
  // p276: the lag query reads automation_runs by finished_at, which has no index (6 ms at 51 k runs, 139 ms at 509 k);
  // its finished_at cursor loses no run when it runs less often.
  assert.equal(LAG_EVERY_S, 30);
  for (const second of [0, 30, 60]) assert.equal(lagDue(second, false), true, `second ${second}`);
  for (const second of [1, 15, 29, 31]) assert.equal(lagDue(second, false), false, `second ${second}`);
  assert.equal(lagDue(7, true), true, 'every second while draining (or in --hold)');
  const run = readFileSync(new URL('../tools/scale/load/run.mjs', import.meta.url), 'utf8');
  assert.match(run, /if \(lagDue\(tick \/ 2, draining \|\| Boolean\(a\.hold\)\)\) \{/);
  assert.match(run, /record\(\{ kind: 'lag', at, lags_ms: lags\.map\(\(x\) => x\.ms\), finished_ms: lags\.map\(\(x\) => x\.f\.getTime\(\)\), rule_ids: lags\.map\(\(x\) => x\.rid\) \}\)/);
});

test('monitor: a lag counts in the phase of its finish time when the sample carries it, else in the phase of the sample', () => {
  const phases = [{ id: 'a', clients: 1, start_ms: 0, end_ms: 30000 }, { id: 'b', clients: 1, start_ms: 30000, end_ms: 60000 }];
  const m = summarizeMonitor([
    { kind: 'lag', at: 31000, lags_ms: [100, 200, 300], finished_ms: [29000, 29500, 30500] }, // one 30 s sample across the boundary
    { kind: 'lag', at: 40000, lags_ms: [900] }, // an older row without finish times
  ], phases);
  assert.deepEqual([m.a.completion_lag.count, m.a.completion_lag.max_ms], [2, 200]);
  assert.deepEqual([m.b.completion_lag.count, m.b.completion_lag.max_ms], [2, 900]);
});

test('rate limit: --rate-limit-per-min takes a decimal integer 60…100000, the same rule as the server', () => {
  assert.equal(RATE_LIMIT_DEFAULT_PER_MIN, 600);
  assert.equal(rateLimitOption(undefined), null, 'not given: the release default, nothing written to app.env');
  for (const [t, v] of [['60', 60], ['1200', 1200], ['100000', 100000]]) assert.equal(rateLimitOption(t), v);
  for (const t of ['', '59', '100001', '0600', '6e2', '600.0', ' 600', 'abc']) assert.throws(() => rateLimitOption(t), /--rate-limit-per-min/, JSON.stringify(t));
});

test('rate limit: the run records the value the running app reports and refuses a mismatch before any phase', () => {
  const env = (n) => ({ per_address_per_minute: n, window_seconds: 60, source: 'env' });
  const dflt = { per_address_per_minute: 600, window_seconds: 60, source: 'default' };
  assert.deepEqual(rateLimitRecord(null, dflt), { per_address_per_minute: 600, window_seconds: 60, source: 'default', requested: null, reported_by_release: true });
  assert.deepEqual(rateLimitRecord(1200, env(1200)), { per_address_per_minute: 1200, window_seconds: 60, source: 'env', requested: 1200, reported_by_release: true });
  // A release built before 29.10 has the fixed 600 and no rate_limit field in /api/health.
  assert.deepEqual(rateLimitRecord(null, undefined), { per_address_per_minute: 600, window_seconds: 60, source: 'release-fixed', requested: null, reported_by_release: false });
  assert.throws(() => rateLimitRecord(1200, undefined), /does not report rate_limit/);
  assert.throws(() => rateLimitRecord(1200, env(900)), /reports 900/);
  assert.throws(() => rateLimitRecord(1200, { ...env(1200), source: 'default' }), /reports 1200 \(default\)/);
  assert.throws(() => rateLimitRecord(null, env(1200)), /reports 1200 \(env\)/, 'no option: the app must run on its default');
  assert.throws(() => rateLimitRecord(null, { per_address_per_minute: '600', source: 'default' }), /reports/);
  const md = renderMarkdown({ run_id: 'x', database: 'db', started_at: 'a', finished_at: 'b', release: { commit: 'c' }, rate_limit: rateLimitRecord(1200, env(1200)), result: { phases: {} } });
  assert.match(md, /Per-address rate limit 1200\/min \(env DYNA_RATE_LIMIT_PER_MIN, reported by \/api\/health\)\./);
  // run.mjs: the option reaches app.env (setup and every release CLI), and the report takes the app's answer.
  const run = readFileSync(new URL('../tools/scale/load/run.mjs', import.meta.url), 'utf8');
  assert.match(run, /'rate-limit-per-min': \{ type: 'string' \}/);
  assert.match(run, /\.\.\.\(rateLimit === null \? \[\] : \[`DYNA_RATE_LIMIT_PER_MIN=\$\{rateLimit\}`\]\)/);
  assert.match(run, /report\.rate_limit = rateLimitRecord\(rateLimit, /);
});

test('monitor: the published port follows SCALE_PG_PORT with the same pairing rule as scale-pg.sh (full-dataset instance 57091)', () => {
  assert.equal(monitorPort({}), 57090, 'default instance dyna-scale-pg18 on 57090');
  assert.equal(monitorPort({ SCALE_PG_CONTAINER: 'dyna-scale-pg18', SCALE_PG_PORT: '57090' }), 57090);
  assert.equal(monitorPort({ SCALE_PG_CONTAINER: 'dyna-scale-full-pg18', SCALE_PG_PORT: '57091' }), 57091);
  // Another container on the default port would monitor dyna-scale-pg18's database while the run writes elsewhere.
  assert.throws(() => monitorPort({ SCALE_PG_CONTAINER: 'dyna-scale-full-pg18' }), /57090 belongs to dyna-scale-pg18/);
  for (const p of ['4100', '5432', '57084']) assert.throws(() => monitorPort({ SCALE_PG_CONTAINER: 'dyna-scale-full-pg18', SCALE_PG_PORT: p }), /reserved/, p);
  for (const p of ['', 'abc', '0', '65536', '5709.1', ' 57091']) assert.throws(() => monitorPort({ SCALE_PG_CONTAINER: 'dyna-scale-full-pg18', SCALE_PG_PORT: p }), /SCALE_PG_PORT/, JSON.stringify(p));
  const run = readFileSync(new URL('../tools/scale/load/run.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(run, /127\.0\.0\.1:57090/, 'run.mjs takes the monitor port from monitorPort, not a literal');
  assert.match(run, /const MONITOR_PORT = monitorPort\(process\.env\);/);
});

test('reply health: after the drain every release CLI reports its reply warnings and late hook failures; any non-zero is shown', () => {
  const zero = { FST_ERR_REP_ALREADY_SENT: 0, ERR_HTTP_HEADERS_SENT: 0, FST_REPLY_SENT_PROMISE_ERROR: 0, ORDINARY_LATE_HOOK_FAILURE: 0 };
  const health = (w, late) => ({ status: 'ok', reply_warnings: w, ordinary_requests: { active_requests: 1, active_requests_limit: 128, active_tasks: 2, refused_admissions: 0, late_hook_failures: late } });
  const clean = replyHealthRecord([{ name: 'dyna-load-app', health: health(zero, 0) }, { name: 'dyna-load-worker-2', health: health(zero, 0) }]);
  assert.deepEqual(clean, { clean: true, reply_warnings: 0, late_hook_failures: 0, services: [
    { name: 'dyna-load-app', reply_warnings: zero, late_hook_failures: 0, refused_admissions: 0 },
    { name: 'dyna-load-worker-2', reply_warnings: zero, late_hook_failures: 0, refused_admissions: 0 }] });
  const dirty = replyHealthRecord([{ name: 'dyna-load-app', health: health({ ...zero, FST_ERR_REP_ALREADY_SENT: 2 }, 1) }]);
  assert.equal(dirty.clean, false); assert.equal(dirty.reply_warnings, 2); assert.equal(dirty.late_hook_failures, 1);
  // Unreachable CLI (crashed) or a release without the fields: recorded, never clean.
  const gone = replyHealthRecord([{ name: 'dyna-load-app', error: 'ECONNREFUSED' }, { name: 'dyna-load-worker-2', health: { status: 'ok' } }]);
  assert.equal(gone.clean, false); assert.deepEqual(gone.services, [{ name: 'dyna-load-app', error: 'ECONNREFUSED' }, { name: 'dyna-load-worker-2', error: 'no reply_warnings in /api/health' }]);
  const md = (r) => renderMarkdown({ run_id: 'x', database: 'db', started_at: 'a', finished_at: 'b', release: { commit: 'c' }, reply_health: r, result: { phases: {} } });
  assert.match(md(clean), /Reply warnings after the drain \(\/api\/health\): 0, late hook failures 0 — dyna-load-app 0\/0, dyna-load-worker-2 0\/0\./);
  assert.match(md(dirty), /Reply warnings after the drain \(\/api\/health\): 2, late hook failures 1 — dyna-load-app 2\/1 \(FST_ERR_REP_ALREADY_SENT 2\)\. NOT CLEAN\./);
  assert.match(md(gone), /dyna-load-app unreachable \(ECONNREFUSED\), dyna-load-worker-2 unreachable \(no reply_warnings in \/api\/health\)\. NOT CLEAN\./);
  const run = readFileSync(new URL('../tools/scale/load/run.mjs', import.meta.url), 'utf8');
  assert.match(run, /report\.reply_health = replyHealthRecord\(/, 'run.mjs reads every CLI before stopping it');
  assert.ok(run.indexOf('report.reply_health = replyHealthRecord(') < run.indexOf('await stopAll();'));
});
