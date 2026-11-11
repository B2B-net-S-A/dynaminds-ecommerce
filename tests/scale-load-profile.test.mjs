// Load driver: profile compliance beyond run -05 (docs/scale/LOAD-DRIVER-PROFILE-COMPLIANCE-20261029.md):
// warmup/phases/cold attempts against config.timing, cold start summary, background lanes, B/D manual OFF stock
// operations, hot SKUs, finite-stock contention and the post-run reconciliation verdict.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, existsSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planCompliance, profileDeviations, coldStartSummary, businessReady, laneWindows, backgroundReport, classifyConflict, contentionRace,
  isContentionCommand, contentionClients, mixCycle, taskAt, aggregate, renderMarkdown, rng, uuid4, SLOTS, CONTENTION_CLIENTS, reconciliationVerdict, RECONCILE_GUARDS } from '../tools/scale/load/lib.mjs';

const profile = JSON.parse(readFileSync(new URL('../docs/parity/acceptance-profile.v1.json', import.meta.url), 'utf8')).config;
const timing = profile.timing;
const PROFILE_PHASES = [{ id: 'steady12', clients: 12, duration_s: 1800 }, { id: 'steady24', clients: 24, duration_s: 1800 }];

test('timing: the profile plan (600 s warmup, 2 × 1800 s, 3 cold attempts) is an acceptance run; any deviation needs --dry-run', () => {
  assert.deepEqual(planCompliance({ timing, warmup: 600, phases: PROFILE_PHASES, coldAttempts: 3, dryRun: false }),
    { dry_run: false, timing_as_profile: true, deviations: [], acceptance_run: true });
  // run -05: --warmup 60 and one cold start per process
  assert.throws(() => planCompliance({ timing, warmup: 60, phases: PROFILE_PHASES, coldAttempts: 1, dryRun: false }), /warmup 60 s \(profile 600 s\).*cold start 1 attempt/);
  const dry = planCompliance({ timing, warmup: 30, phases: [{ id: 'steady12', clients: 12, duration_s: 180 }, { id: 'steady24', clients: 24, duration_s: 180 }], coldAttempts: 3, dryRun: true });
  assert.equal(dry.acceptance_run, false);
  assert.deepEqual(dry.deviations, ['warmup 30 s (profile 600 s)', 'phases steady12:12:180,steady24:24:180 (profile steady12:12:1800,steady24:24:1800)']);
  // a dry run with the profile timing is still not an acceptance run
  assert.equal(planCompliance({ timing, warmup: 600, phases: PROFILE_PHASES, coldAttempts: 3, dryRun: true }).acceptance_run, false);
  assert.deepEqual(profileDeviations({ timing, warmup: 600, phases: PROFILE_PHASES.slice(0, 1), coldAttempts: 3 }), ['phases steady12:12:1800 (profile steady12:12:1800,steady24:24:1800)']);
});

test('run.mjs refuses a non-profile plan without --dry-run before creating the run directory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'scale-load-timing-'));
  try {
    const run = (...extra) => spawnSync(process.execPath, [fileURLToPath(new URL('../tools/scale/load/run.mjs', import.meta.url)), '--release', join(dir, 'missing-release.json'),
      '--db', 'dynaminds_scale_20261029_41', '--tag', 't', '--out', join(dir, 'out'), '--allow-battery', ...extra], { encoding: 'utf8' });
    const refused = run('--warmup', '60');
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /deviates from the profile timing/);
    assert.equal(existsSync(join(dir, 'out')), false);
    const dry = run('--warmup', '60', '--dry-run');
    assert.notEqual(dry.status, 0);
    assert.doesNotMatch(dry.stderr, /deviates from the profile timing/);
    assert.match(dry.stderr, /missing-release\.json/, 'past the gate it fails on the missing release file');
    const badAttempts = run('--cold-attempts', '0', '--dry-run');
    assert.match(badAttempts.stderr, /--cold-attempts/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('cold start: three fresh attempts per process, median and max of start → authenticated read + worker eligibility, each ≤ 180 s', () => {
  const at = (n, ms, ok = true) => ({ attempt: n, listening_ms: ms - 900, business_ready_ms: ms, ok });
  const s = coldStartSummary([at(1, 116000), at(2, 113000), at(3, 121000)], { required: 3, maxMs: 180000 });
  assert.deepEqual({ median: s.median_ms, max: s.max_ms, ok: s.all_within, completed: s.completed }, { median: 116000, max: 121000, ok: true, completed: 3 });
  assert.equal(coldStartSummary([at(1, 116000), at(2, 181000), at(3, 121000)], { required: 3, maxMs: 180000 }).all_within, false, 'one attempt over 180 s');
  assert.equal(coldStartSummary([at(1, 116000), at(2, 100000, false)], { required: 3, maxMs: 180000 }).all_within, false, 'a failed attempt and too few');
  assert.equal(coldStartSummary([at(1, 116000)], { required: 3, maxMs: 180000 }).all_within, false, 'one attempt is not the profile');
  assert.equal(coldStartSummary([at(1, 100000), at(2, 110000)], { required: 2, maxMs: 180000 }).median_ms, 105000);
  const reads = Object.fromEntries(SLOTS.map((s) => [s, 200]));
  assert.equal(businessReady({ health_status: 200, scoped_automation_enabled: true, reads }), true);
  assert.equal(businessReady({ health_status: 200, scoped_automation_enabled: false, reads }), false, 'worker not eligible');
  assert.equal(businessReady({ health_status: 200, scoped_automation_enabled: true, reads: { ...reads, D: 401 } }), false, 'every tenant reads');
  assert.equal(businessReady(null), false);
});

test('background: a lane meets its rate in every complete minute and has a completion in every rolling 60-s window', () => {
  const start = 1_000_000, end = start + 180_000, every = (ms) => Array.from({ length: 180_000 / ms }, (_, i) => start + 500 + i * ms);
  const ok = laneWindows(every(10_000), start, end, 5);
  assert.deepEqual({ c: ok.completions, min: ok.min_complete_minute, rate: ok.rate_ok, win: ok.windows_ok }, { c: 18, min: 6, rate: true, win: true });
  const slow = laneWindows(every(15_000), start, end, 5);
  assert.equal(slow.rate_ok, false); assert.equal(slow.windows_ok, true);
  const gap = laneWindows([...every(5_000).filter((t) => t < start + 60_000 || t > start + 125_000)], start, end, 5);
  assert.equal(gap.windows_ok, false); assert(gap.max_gap_s > 60);
  // automation from the monitor's lag rows (rule ids → slots); import and stock sync blocked with a reason
  const rules = Object.fromEntries(SLOTS.map((s, i) => [`r${i}`, s]));
  const times = every(6_000), rows = [{ kind: 'lag', at: end, lags_ms: [], finished_ms: SLOTS.flatMap(() => times), rule_ids: SLOTS.flatMap((_, i) => times.map(() => `r${i}`)) }];
  rows[0].lags_ms = rows[0].finished_ms.map(() => 500);
  const rep = backgroundReport({ lanes: profile.background.lanes, rows, phases: [{ id: 'steady12', start_ms: start, end_ms: end }], ruleSlots: rules,
    blocked: { order_import: 'no local Woo', stock_sync: 'no local Woo' } });
  assert.equal(rep.lanes.automation.status, 'met');
  assert.equal(rep.lanes.automation.phases.steady12.C.completions, 30);
  assert.deepEqual([rep.lanes.order_import.status, rep.lanes.stock_sync.status], ['blocked', 'blocked']);
  assert.equal(rep.all_ok, false, 'a blocked required lane never passes');
});

test('contention: only the frozen SKU of the command is a labelled shortage; any other shortage stays an error', () => {
  const race = contentionRace('SC-B-0001.2');
  assert.deepEqual(classifyConflict('order_create', 409, 'Za mało towaru: SC-B-0001.2. Dostępne: 0', race), { cause: 'hot_stock_shortage', labelled: true });
  assert.deepEqual(classifyConflict('order_create', 409, 'Za mało towaru: SC-B-0001x2. Dostępne: 0', race), { cause: 'stock_shortage', labelled: false }, 'escaped SKU');
  assert.deepEqual(classifyConflict('order_create', 409, 'Za mało towaru: SC-B-0009. Dostępne: 3', race), { cause: 'stock_shortage', labelled: false });
  assert.deepEqual(classifyConflict('order_create', 409, 'Za mało towaru: SC-B-0001.2. Dostępne: 0'), { cause: 'stock_shortage', labelled: false }, 'without the command race');
  assert.deepEqual(classifyConflict('stock_operation', 409, 'Za mało towaru: SC-B-0001.2. Dostępne: 0', race), { cause: 'stock_shortage', labelled: false }, 'other operation');
  const plan = { product_id: 'p', sku: 'S', available: 4, demand_clients: CONTENTION_CLIENTS };
  assert.equal(isContentionCommand({ eligible: true, done: false, plan }), true);
  assert.equal(isContentionCommand({ eligible: false, done: false, plan }), false);
  assert.equal(isContentionCommand({ eligible: true, done: true, plan }), false);
  assert.equal(isContentionCommand({ eligible: true, done: false, plan: null }), false);
});

test('contention clients: the first three clients whose schedule creates orders for the tenant (not simply clients 0–2)', () => {
  const cycle = mixCycle(profile.http.mix);
  const creates = (clients, c, slot) => Array.from({ length: 500 }, (_, k) => taskAt(cycle, c, clients, k)).some((t) => t.tenant_slot === slot && t.operation === 'order_create');
  // dry run 29.10.2026: with 12 clients, client 0 never creates an order for B (n = 12k mod 4 fixes a quarter of the cycle per tenant)
  assert.equal(creates(12, 0, 'B'), false);
  for (const clients of [12, 24]) for (const slot of SLOTS) {
    const cs = contentionClients(cycle, clients, slot);
    assert.equal(cs.length, CONTENTION_CLIENTS, `${clients} ${slot}`);
    assert.equal(new Set(cs).size, cs.length);
    for (const c of cs) assert(creates(clients, c, slot), `${clients} ${slot} client ${c}`);
  }
  assert.deepEqual(contentionClients(cycle, 12, 'B'), [1, 2, 3]);
});

test('report: hot share of stock_operation and the contention outcome per tenant against the frozen expectation', () => {
  const start = 1_000_000, ph = { id: 'steady12', clients: 12, start_ms: start, end_ms: start + 120_000 };
  const s = (o) => ({ phase: 'steady12', client: 0, start_ms: start + 1000, duration_ms: 50, http_status: 201, outcome: 'success', ...o });
  const samples = [];
  for (const slot of SLOTS) {
    samples.push(s({ tenant_slot: slot, operation: 'order_create', contention: true }));
    for (let i = 1; i < CONTENTION_CLIENTS; i++) samples.push(s({ tenant_slot: slot, operation: 'order_create', contention: true, client: i, http_status: 409, outcome: 'expected_refusal', conflict_cause: 'hot_stock_shortage', no_effect: true }));
    for (let i = 0; i < 4; i++) samples.push(s({ tenant_slot: slot, operation: 'stock_operation', hot: i % 2 === 0 }));
  }
  const plan = { steady12: Object.fromEntries(SLOTS.map((x) => [x, { product_id: 'p' + x, sku: 'S' + x, available: 4, demand_clients: CONTENTION_CLIENTS }])) };
  const r = aggregate({ samples, phases: [ph], contentionPlan: plan }).phases.steady12;
  assert.equal(r.hot.hot_share_percent, 50);
  assert.equal(r.hot.contention.tenants.B.as_expected, true);
  assert.equal(r.hot.contention.all_as_expected, true);
  assert.equal(r.conflicts_409.hot_stock_shortage.labelled, true);
  assert.equal(r.expected_refusals, SLOTS.length * (CONTENTION_CLIENTS - 1));
  // two accepted orders of one finite SKU = more than the frozen expectation (oversell risk) → not as expected
  const two = samples.map((x) => (x.tenant_slot === 'D' && x.contention && x.client === 1 ? { ...x, outcome: 'success', http_status: 201 } : x));
  assert.equal(aggregate({ samples: two, phases: [ph], contentionPlan: plan }).phases.steady12.hot.contention.tenants.D.as_expected, false);
  const md = renderMarkdown({ run_id: 'L1', database: 'd', started_at: 'a', finished_at: 'b', result: aggregate({ samples, phases: [ph], contentionPlan: plan }) });
  assert.match(md, /Hot SKUs: 50 % of stock_operation/);
  assert.match(md, /Finite-stock contention: as expected in A, B, C, D, E/);
});

test('reconciliation: PASS only when ledger, reservations, invoices, jobs, guards and orphans all reconcile', () => {
  const guards = Object.fromEntries(RECONCILE_GUARDS.map((g) => [g, true]));
  const clean = { stock: { rows: 96000, movement_mismatch: 0, location_mismatch: 0, layer_mismatch: 0, reserved_mismatch: 0, available_formula: 0, negative_available: 0, reserved_over_on_hand: 0, reservation_location_mismatch: 0 },
    reservations: { active_on_closed_orders: 0, open_orders_without_active: 0, consumed_on_open_orders: 0 },
    orders: { run_orders: 900, duplicate_client_effects: 0, cross_tenant_warehouse: 0, total_mismatch: 0 },
    invoices: { run_invoices: 40, missing_order: 0, order_not_shipped: 0, duplicate_per_order: 0, gross_mismatch: 0 },
    payments: { run_payments: 40, missing_order: 0, duplicate_client_key: 0, overpaid_orders: 0 },
    jobs: { run_jobs: 900, pending: 0, running: 0, failed: 0 },
    orphans: { documents_without_order: 0, warehouse_documents_without_lines: 0, stock_movements_without_order: 0, manual_off_without_movement: 0, wms_operations_without_document: 0, automation_runs_without_order: 0 },
    guards };
  const ok = reconciliationVerdict(clean);
  assert.equal(ok.status, 'PASS'); assert.deepEqual(ok.failed, []);
  assert(ok.checks.length >= 20 && ok.checks.every((c) => c.ok));
  assert(ok.guards_true >= 12);
  const bad = (patch) => { const f = structuredClone(clean); patch(f); return reconciliationVerdict(f); };
  assert.deepEqual(bad((f) => { f.stock.negative_available = 1; }).failed, ['stock.negative_available']);
  assert.deepEqual(bad((f) => { f.jobs.pending = 3; }).failed, ['jobs.pending']);
  assert.deepEqual(bad((f) => { f.guards.local_invoice_guards = false; }).failed, ['guards.local_invoice_guards']);
  assert.deepEqual(bad((f) => { delete f.guards.pim_dictionary_valid; }).failed, ['guards.pim_dictionary_valid'], 'a guard not evaluated fails');
  assert.deepEqual(bad((f) => { f.orphans.documents_without_order = 2; }).failed, ['orphans.documents_without_order']);
  assert.equal(bad((f) => { delete f.invoices; }).status, 'FAIL', 'a missing section fails');
});

test('preparer B/D: stock_operation is a manual OFF PW/RW correction (source → preview, apply measured), half on the frozen hot SKUs', async () => {
  const { createPreparer } = await import('../tools/scale/load/prepare.mjs');
  const r = rng('manual-off'), main = uuid4(r), hot = [uuid4(r), uuid4(r)], win = Array.from({ length: 6 }, () => uuid4(r)), calls = [];
  const rev = 'e'.repeat(64);
  const api = async (method, route, path, body) => { calls.push({ method, route, path, body });
    if (route === '/api/products') return { status: 200, json: { data: win.map((id, i) => ({ id, kind: i === 0 ? 'variant' : 'simple', active: true, price: 1000, available: 30, sku: 'S' + i, name: 'P ' + i })), meta: { has_more: false, cursor: null } } };
    if (route === '/api/inventory/manual-corrections/source') return { status: 200, json: { source: { revision: rev, stock: { available: 30, default_location: 'A-04' }, bins: [{ location: 'A-04', available: 30 }] } } };
    if (route === '/api/inventory/manual-corrections/previews') return { status: 201, json: { reused: false, can_apply: true, preview: { id: uuid4(r), scope_hash: 'f'.repeat(64), request: body } } };
    if (route === '/api/inventory/manual-corrections/previews/:id') return { status: 200, json: { preview: { receipt_id: null } } };
    return { status: 404, json: { detail: 'nope ' + route } }; };
  const prep = createPreparer({ ctx: { slot: 'B', wms: false, main, hot }, api, r, client: 0, clients: 1, phase: 'steady12' });
  const seen = [];
  for (let i = 0; i < 4; i++) {
    const p = await prep('stock_operation'), c = p.cmd;
    assert.equal(c.kind, 'manual_off');
    assert.deepEqual(Object.keys(c).sort(), ['body', 'client_key', 'expected', 'kind', 'preview_id']);
    assert.deepEqual(c.body, { client_key: c.client_key, scope_hash: 'f'.repeat(64), confirmed: true });
    assert.equal(c.expected.warehouse_id, main); assert.equal(c.expected.location, 'A-04'); assert([1, -1].includes(c.expected.delta));
    const pv = calls.filter((x) => x.route === '/api/inventory/manual-corrections/previews').pop().body;
    assert.deepEqual(Object.keys(pv).sort(), ['client_key', 'delta', 'location', 'note', 'product_id', 'revision', 'warehouse_id']);
    assert.equal(pv.revision, rev); assert.notEqual(pv.client_key, c.client_key, 'consent key differs from the preview key');
    seen.push({ hot: p.hot, product: c.expected.product_id, delta: c.expected.delta });
    assert.equal(await p.noEffect(), true, 'no receipt of the refused preview');
  }
  assert.deepEqual(seen.map((x) => x.hot), [true, false, true, false]);
  for (const x of seen) assert.equal(hot.includes(x.product), x.hot);
  assert(!seen.some((x) => x.product === win[0]), 'manual OFF supports simple products only');
  assert.deepEqual(new Set(seen.map((x) => x.delta)), new Set([1, -1]));
});

test('preparer A/C/E: half of stock_operation reads lot positions of the frozen hot SKUs', async () => {
  const { createPreparer } = await import('../tools/scale/load/prepare.mjs');
  const r = rng('hot-wms'), main = uuid4(r), hot = [uuid4(r)], win = [uuid4(r), uuid4(r)], positions = [];
  const api = async (method, route, path, body) => {
    if (route === '/api/products') return { status: 200, json: { data: win.map((id) => ({ id, kind: 'simple', active: true, price: 1000, available: 30, sku: 'S', name: 'P' })), meta: { has_more: false, cursor: null } } };
    if (route === '/api/wms-lots') return { status: 200, json: { policy: { version: 3, currency: 'PLN' } } };
    if (route === '/api/wms-lots/positions') { const pid = new URL(path, 'http://x').searchParams.get('product_id'); positions.push(pid);
      return { status: 200, json: { data: [{ product_id: pid, location: 'A-1', layer_id: uuid4(r), available: 20, quantity: 20, stock_version: '5' }] } }; }
    if (route === '/api/inventory/adjust/previews') return { status: 201, json: { preview: { id: uuid4(r), ready: true, scope_hash: 'a'.repeat(64), policy_version: '3' } } };
    if (route === '/api/wms-lots/movement-previews/:id/rows') return { status: 200, json: { data: [{ layer_id: uuid4(r), lot_id: uuid4(r), lot_code: 'L', location: 'A-1', quantity: 1, unit_cost_minor: '1', value_minor: '1', currency: 'PLN' }], meta: {} } };
    return { status: 404, json: { detail: 'nope ' + route } }; };
  const prep = createPreparer({ ctx: { slot: 'A', wms: true, main, hot, spare: null }, api, r, client: 0, clients: 1, phase: 'steady12' });
  const p0 = await prep('stock_operation'); assert.equal(p0.hot, true); assert.equal(p0.cmd.expected.product_id, hot[0]);
  const p1 = await prep('stock_operation'); assert.equal(p1.hot, false); assert(win.includes(p1.cmd.expected.product_id));
});

test('preparer: the first order_create of a contention client orders the whole available quantity of the phase SKU', async () => {
  const { createPreparer } = await import('../tools/scale/load/prepare.mjs');
  const r = rng('contention'), main = uuid4(r), sku = uuid4(r), win = Array.from({ length: 30 }, () => uuid4(r)), searches = [];
  const api = async (method, route, path) => {
    if (route === '/api/products') return { status: 200, json: { data: win.map((id) => ({ id, kind: 'simple', active: true, price: 1000, available: 40, sku: 'W', name: 'P' })), meta: { has_more: false, cursor: null } } };
    if (route === '/api/inventory') return { status: 200, json: { data: [{ product_id: sku, available: 4, version: '9' }] } };
    if (route === '/api/orders' && method === 'GET') { searches.push(new URL(path, 'http://x').searchParams.get('search')); return { status: 200, json: { data: [], meta: { has_more: false, cursor: null } } }; }
    return { status: 404, json: { detail: 'nope ' + route } }; };
  const contention = { steady12: { product_id: sku, sku: 'SC-C-1', price: 2500, available: 4, demand_clients: 3 } };
  const prep = createPreparer({ ctx: { slot: 'C', wms: true, main, contention, marker: 'load-Lrun1' }, api, r, client: 2, clients: 12, phase: 'steady12', contentionEligible: true });
  const first = await prep('order_create');
  assert.equal(first.contention, true);
  assert.deepEqual(first.cmd.body.items, [{ product_id: sku, quantity: 4 }]);
  assert.equal(first.cmd.expected.total, 4 * 2500 + first.cmd.body.shipping_cost);
  assert.deepEqual(first.race, contentionRace('SC-C-1'));
  assert.equal(await first.noEffect(), true); assert.deepEqual(searches, [first.cmd.body.email]);
  assert.equal(first.cmd.body.email, 'load-lrun1-c2-steady12-1-hot@scale.example.test', 'run marker and phase: unique across phases and runs');
  const second = await prep('order_create');
  assert.notEqual(second.contention, true, 'once per phase and client');
  assert(second.cmd.body.items.every((i) => i.product_id !== sku));
  assert.equal(second.cmd.body.email, 'load-lrun1-c2-steady12-2@scale.example.test');
  const other = createPreparer({ ctx: { slot: 'C', wms: true, main, contention }, api, r, client: 3, clients: 12, phase: 'steady12' });
  assert.notEqual((await other('order_create')).contention, true, 'clients not in contentionClients order normally');
  const otherPhase = createPreparer({ ctx: { slot: 'C', wms: true, main, contention }, api, r, client: 0, clients: 12, phase: 'steady24', contentionEligible: true });
  assert.notEqual((await otherPhase('order_create')).contention, true, 'no plan for that phase');
});

test('preparer B/D: a manual OFF preview refused on a changed frame is prepared once more, never twice', async () => {
  const { createPreparer, PrepError } = await import('../tools/scale/load/prepare.mjs');
  const r = rng('manual-off-retry'), main = uuid4(r), hot = [uuid4(r)];
  let refusals = 0, sources = 0;
  const api = async (method, route, path, body) => {
    if (route === '/api/inventory/manual-corrections/source') { sources++; return { status: 200, json: { source: { revision: String(sources).repeat(64).slice(0, 64), stock: { available: 9, default_location: 'A-1' }, bins: [{ location: 'A-1', available: 9 }] } } }; }
    if (route === '/api/inventory/manual-corrections/previews') return refusals-- > 0 ? { status: 409, json: { detail: 'Manual OFF native source or authority refused' } }
      : { status: 201, json: { preview: { id: uuid4(r), scope_hash: 'f'.repeat(64), request: body } } };
    if (route === '/api/products') return { status: 200, json: { data: [{ id: uuid4(r), kind: 'simple', active: true, price: 100, available: 9, sku: 'S', name: 'P' }], meta: { has_more: false, cursor: null } } };
    return { status: 404, json: { detail: 'nope' } }; };
  const prep = createPreparer({ ctx: { slot: 'D', wms: false, main, hot }, api, r, client: 0, clients: 1, phase: 'steady12' });
  refusals = 1; const p = await prep('stock_operation');
  assert.equal(p.cmd.kind, 'manual_off'); assert.equal(sources, 2, 'source read again before the second preview');
  refusals = 2; sources = 0;
  await assert.rejects(() => prep('stock_operation'), (e) => e instanceof PrepError && e.status === 409);
  assert.equal(sources, 2);
});
