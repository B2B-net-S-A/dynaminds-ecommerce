// Pure parts of the stage 5 load test (tools/scale/load/README.md): operation schedule from the frozen
// profile mix, latency histograms, expected values the prepared commands carry, one-shot fixtures for the
// source-pinned HTTP bindings (scripts/full-base-scale-http-ports.mjs), the aggregated report and its
// markdown summary. No IO here.
import { createHash } from 'node:crypto';

export const SLOTS = Object.freeze(['A', 'B', 'C', 'D', 'E']);
export const OPERATIONS = Object.freeze({ order_list: 'read', catalog_search: 'read', order_detail: 'read', order_create: 'write',
  reserve_and_status: 'write', payment_or_document: 'write', stock_operation: 'write', return_receive: 'write' });

/** The 100-slot operation cycle of the profile mix (same construction as scripts/full-base-scale-executor.mjs). */
export function mixCycle(mix) {
  if (!Array.isArray(mix) || mix.reduce((n, m) => n + m.percent, 0) !== 100) throw new Error('mix must sum to 100 percent');
  for (const m of mix) if (OPERATIONS[m.id] !== m.class || !Number.isInteger(m.percent) || m.percent <= 0) throw new Error('bad mix entry ' + m.id);
  // Interleave instead of blocks so that a short window (one client, a few minutes) still sees the whole mix.
  const left = Object.fromEntries(mix.map((m) => [m.id, m.percent])), out = [];
  const credit = Object.fromEntries(mix.map((m) => [m.id, 0]));
  for (let i = 0; i < 100; i++) {
    for (const m of mix) credit[m.id] += m.percent;
    const next = mix.filter((m) => left[m.id] > 0).sort((a, b) => credit[b.id] - credit[a.id] || a.id.localeCompare(b.id))[0];
    credit[next.id] -= 100; left[next.id]--; out.push(next.id);
  }
  return Object.freeze(out);
}

/**
 * Task k of client `client` among `clients`: global index n = k·clients + client, so all clients together walk
 * the same sequence as one closed loop would. Tenant = n mod 5 (20 % each); operation = cycle[⌊n/5⌋ mod 100],
 * so every tenant sees the whole mix.
 */
export function taskAt(cycle, client, clients, k) {
  if (!(Number.isInteger(client) && client >= 0 && client < clients && Number.isInteger(k) && k >= 0)) throw new Error('bad task index');
  const n = k * clients + client;
  return { n, tenant_slot: SLOTS[n % 5], operation: cycle[Math.floor(n / 5) % 100] };
}

/** Deterministic small PRNG (mulberry32) seeded from a string; the driver's choices are reproducible. */
export function rng(seed) {
  let a = createHash('sha256').update(String(seed)).digest().readUInt32LE(0);
  return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
export const pickOf = (r, list) => list[Math.floor(r() * list.length)];

/** Version 4 UUID from a PRNG (the bindings require canonical v4 client keys). */
export function uuid4(r) {
  const b = Array.from({ length: 16 }, () => Math.floor(r() * 256));
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// ---- histograms (profile: ≤1 ms below 1 s, ≤10 ms below 10 s) --------------------------------------------
export function bucketOf(ms) {
  if (!(Number.isFinite(ms) && ms >= 0)) throw new Error('bad latency');
  return ms > 10000 ? Infinity : ms <= 1000 ? Math.max(1, Math.ceil(ms)) : Math.ceil(ms / 10) * 10;
}
export function histogram() { return { count: 0, max: 0, sum: 0, bins: new Map() }; }
export function addSample(h, ms) { const b = bucketOf(ms); h.bins.set(b, (h.bins.get(b) ?? 0) + 1); h.count++; h.sum += ms; h.max = Math.max(h.max, ms); return h; }
export function mergeHist(into, h) { for (const [b, n] of h.bins) into.bins.set(b, (into.bins.get(b) ?? 0) + n); into.count += h.count; into.sum += h.sum; into.max = Math.max(into.max, h.max); return into; }
/** Upper bucket bound of the f-quantile (nearest rank); null for no samples, Infinity when it falls in the overflow bucket. */
export function quantile(h, f) {
  if (!h.count) return null;
  const target = Math.ceil(h.count * f); let seen = 0;
  for (const [b, n] of [...h.bins].sort((x, y) => x[0] - y[0])) { seen += n; if (seen >= target) return b; }
  return Infinity;
}
export function summarize(h) {
  const q = (f) => { const v = quantile(h, f); return v === Infinity ? '>10000' : v; };
  return { count: h.count, p50_ms: q(0.5), p95_ms: q(0.95), p99_ms: q(0.99), max_ms: h.count ? +h.max.toFixed(1) : null, mean_ms: h.count ? +(h.sum / h.count).toFixed(1) : null };
}

// ---- expected values of prepared commands -------------------------------------------------------------------
/** Order total as createOrder computes it: shipping + Σ price·quantity (minor units, no discounts without a price list). */
export function orderTotal(items, prices, shipping) {
  return items.reduce((s, i) => { const p = prices.get(i.product_id); if (!Number.isSafeInteger(p)) throw new Error('no price for ' + i.product_id); return s + p * i.quantity; }, shipping);
}
/** Refund of `accepted` more units of one order line after `prior` accepted ones (server/returns.ts allocation). */
export function lineRefund(lineTotal, quantity, prior, accepted) {
  const L = BigInt(lineTotal), Q = BigInt(quantity);
  return Number((L * BigInt(prior + accepted)) / Q - (L * BigInt(prior)) / Q);
}
/** Order list cursor (base64url of {date,id}) that pages rows created before `iso` (list order: created_at DESC, id DESC). */
export function cursorBefore(iso) {
  const date = new Date(iso).toISOString().replace(/\.(\d{3})Z$/, '.$1000Z');
  return Buffer.from(JSON.stringify({ date, id: 'ffffffff-ffff-4fff-bfff-ffffffffffff' })).toString('base64url');
}
/** Preview rows (GET /api/wms-lots/movement-previews/:id/rows) → fragments of a negative adjustment. */
export function negativeFragments(rows) {
  return rows.map((r) => ({ layer_id: r.layer_id, lot_id: r.lot_id, lot_code: r.lot_code, location: r.location, quantity: Number(r.quantity),
    unit_cost_minor: r.unit_cost_minor ?? null, value_minor: r.unit_cost_minor == null ? null : String(BigInt(r.unit_cost_minor) * BigInt(r.quantity)), currency: r.currency }));
}
/** Preview rows → fragments of a transfer. */
export function transferFragments(rows) {
  return rows.map((r) => ({ layer_id: r.layer_id, lot_id: r.lot_id, lot_code: r.lot_code, location: r.location, quantity: Number(r.quantity),
    unit_cost_minor: r.unit_cost_minor ?? null, currency: r.currency, fifo_sequence: String(r.fifo_sequence) }));
}
/** Greedy picks of returned units over the order's issue fragments (same order as tools/scale/writer.mjs). */
export function returnPicks(fragments, productId, units) {
  let need = units; const picks = [];
  for (const f of [...fragments].filter((x) => x.product_id === productId && Number(x.remaining) > 0).sort((a, b) => a.id.localeCompare(b.id))) {
    if (need <= 0) break;
    const q = Math.min(need, Number(f.remaining)); picks.push({ issue_fragment_id: f.id, quantity: q, location: f.location }); need -= q;
  }
  if (need > 0) throw new Error('not enough issued units to return');
  return picks;
}

// ---- one-shot fixtures for the source-pinned bindings -----------------------------------------------------------
// The bindings take a finite five-tenant fixture with all eight queues non-empty and consume each write command once.
// The driver prepares every write just before it is sent (current versions), so each measured request gets its own
// fixture: the prepared command in its queue, structurally valid placeholders in the others (never sent).
const zid = (n) => `${n.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;
function placeholders(i) {
  const n = 0x10000 * (i + 1), w = zid(n + 3), p = zid(n + 2), o = zid(n + 1);
  return {
    order_list: [{ query: { limit: 50 }, expected: { min_rows: 0, max_rows: 50 } }],
    catalog_search: [{ query: { limit: 50, search: 'x' }, expected: { min_rows: 0, max_rows: 50 } }],
    order_detail: [{ order_id: o, expected: { version: '1', status: 'new', total: 1 } }],
    order_create: [{ client_key: zid(n + 10), body: { customer_name: 'Placeholder', email: 'p@example.test', warehouse_id: w, source: 'manual', currency: 'PLN', payment_mode: 'prepaid',
      address: { street: '', city: '', postal_code: '', country: 'PL', phone: '' }, shipping_cost: 0, items: [{ product_id: p, quantity: 1 }], note: '' }, expected: { total: 1 } }],
    reserve_and_status: [{ order_id: o, client_key: zid(n + 11), body: { status: 'picking', expected_version: '1' }, expected: { total: 1 } }],
    payment_or_document: [{ kind: 'payment_receipt', order_id: o, client_key: zid(n + 12), body: { client_key: zid(n + 12), version: 1, kind: 'receipt', amount: 1, fee: 0, currency: 'PLN',
      method: 'bank_transfer', reference: 'placeholder', note: '', confirmed: true }, expected: { amount_due: 0, net: 1 } }],
    stock_operation: [{ client_key: zid(n + 14), body: { protocol: 'wms_adjustment090', preview_id: zid(n + 21), client_key: zid(n + 14), scope_hash: 'a'.repeat(64), confirmed: true },
      expected: { product_id: p, warehouse_id: w, policy_version: '1', signed_delta: 1 } }],
    return_receive: [{ return_id: zid(n + 22), order_id: o, client_key: zid(n + 15), body: { version: 1, shipping_refund: 0, note: 'placeholder', items: [{ item_id: zid(n + 4), accepted: 1, restocked: 1 }] },
      expected: { refund_amount: 1, receipt_sequence: 1 } }],
  };
}
/** Fixture with `command` as the only case of (slot, operation); `tenants` = [{slot, tenant_id, user_id, cookie}] × 5. */
export function oneShotFixture(sourcePins, tenants, slot, operation, command) {
  if (tenants.length !== 5) throw new Error('five tenants required');
  return { schema: 'dynaminds-full-base-scale-http-fixture/v1', source_pins: { ...sourcePins },
    tenants: tenants.map((t, i) => { const cases = placeholders(i); if (t.slot === slot) cases[operation] = [command];
      return { slot: t.slot, tenant_id: t.tenant_id, user_id: t.user_id, cookie: t.cookie, cases }; }) };
}

// ---- expected contention (profile limits.expected_contention) ---------------------------------------------------
// "Only deliberately pre-labelled hot-SKU/version races may refuse": 409 with the exact native reason, ≤ 1 % of all
// requests, excluded from success throughput, no automatic retry of writes (http.model), no effect (reconciled).
// Both races are on the stock row version of one (warehouse, product): the prepared command carries the version it
// read, and any other writer of that product (another client's order reservation, a scan, the worker) bumps it.
// B/D (no WMS lots) correct stock through the manual OFF PW/RW protocol (server/manual-inventory-off.ts): its apply
// re-reads the whole frame (stock row, bins, active holds) and refuses a changed frame with SQLSTATE 40001, which the
// service maps to this one 409 text (`controlled`); the client reads back that no receipt of the preview exists.
export const EXPECTED_RACES = Object.freeze([
  Object.freeze({ id: 'return_stock_version', operation: 'return_receive', status: 409, reason: 'Zapas zwrotu zmienił wersję. Odczytaj ponownie cały zakres' }),
  Object.freeze({ id: 'stock_version', operation: 'stock_operation', status: 409, reason: 'Stan lub rezerwacja zmieniły wersję' }),
  Object.freeze({ id: 'manual_off_source', operation: 'stock_operation', status: 409, reason: 'Manual OFF native source or authority refused' }),
]);
export const EXPECTED_REFUSAL_BUDGET = 0.01;
const CONFLICT_CAUSES = [[/^Za mało towaru: /, 'stock_shortage'], [/^Zamówienie zmieniło się/, 'order_version'], [/^Polityka (WMS|partii) zmieniła/, 'policy_version'],
  [/zmienił[aoy]? (się|wersję)/i, 'version_other']];
/** Cause of a 409 (null for any other status); `labelled` only for the exact race of its own operation, or for the
 * race the command itself was prepared for (`commandRace`, e.g. contentionRace of a frozen finite-stock SKU). */
export function classifyConflict(operation, status, detail, commandRace = null) {
  if (status !== 409) return null;
  const text = String(detail ?? '');
  if (commandRace && commandRace.operation === operation && new RegExp(commandRace.pattern).test(text)) return { cause: commandRace.id, labelled: true };
  const race = EXPECTED_RACES.find((x) => x.reason === text);
  if (race) return { cause: race.id, labelled: race.operation === operation };
  return { cause: CONFLICT_CAUSES.find(([re]) => re.test(text))?.[1] ?? 'other', labelled: false };
}

// ---- hot SKUs and finite-stock contention (profile http.mix stock_operation, correctness.reconciliation 5) --------
// Half of stock_operation targets a frozen per-tenant hot-SKU set. In each phase the first order_create of the first
// CONTENTION_CLIENTS clients that create orders for a tenant (contentionClients) orders the whole available quantity of that phase's frozen contention SKU
// (2…7 available at setup: below the order window's ≥ 8, so no other command picks it). Demand = clients × available
// > available, so at most one order succeeds and every other one is refused by the native stock check
// (server/domain.ts createOrder: "Za mało towaru: <sku>. Dostępne: <n>"), a pre-labelled race of that command only.
export const CONTENTION_CLIENTS = 3;
export const CONTENTION_AVAILABLE = Object.freeze({ min: 2, max: 7 });
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function contentionRace(sku) {
  return { id: 'hot_stock_shortage', operation: 'order_create', status: 409, pattern: `^Za mało towaru: ${escapeRe(sku)}\\. Dostępne: \\d+$` };
}
/** The clients that send the contention command of a tenant in a phase: the first `demand` clients whose schedule has an
 * order_create for that tenant at all. A client's tasks n = k·clients + client fix n mod 4 (clients 12 or 24), so with
 * tenant = n mod 5 each client sees only a quarter of the cycle per tenant, and some clients never create an order for
 * some tenant (dry run 29.10.2026: clients 0–2 sent only 2 of 3 commands for B, C, D). */
export function contentionClients(cycle, clients, slot, demand = CONTENTION_CLIENTS) {
  const out = [];
  for (let c = 0; c < clients && out.length < demand; c++)
    for (let k = 0; k < 500; k++) { const t = taskAt(cycle, c, clients, k); if (t.tenant_slot === slot && t.operation === 'order_create') { out.push(c); break; } }
  return out;
}
/** Is the next measured order_create of this client the contention command of (phase, tenant)? Once per phase. */
export function isContentionCommand({ eligible, done, plan }) {
  return Boolean(plan) && !done && eligible === true;
}
/** Per phase: hot share of stock_operation, contention outcome per tenant against the frozen expectation. */
function hotReport(measured, mine, phaseId, contentionPlan) {
  const stock = measured.filter((s) => s.operation === 'stock_operation'), hot = stock.filter((s) => s.hot === true);
  const by = (xs, o) => xs.filter((s) => s.outcome === o).length;
  const tenants = {};
  for (const slot of SLOTS) {
    const plan = contentionPlan?.[phaseId]?.[slot] ?? null, xs = mine.filter((s) => s.contention === true && s.tenant_slot === slot);
    const sent = xs.filter((s) => SENT.has(s.outcome)), success = by(sent, 'success'), refused = by(sent, 'expected_refusal'), failures = by(sent, 'failure');
    const demand = plan?.demand_clients ?? null;
    tenants[slot] = { planned: Boolean(plan), sku: plan?.sku ?? null, available_at_setup: plan?.available ?? null, demand_clients: demand, sent: sent.length, success, refused, failures,
      not_sent: xs.length - sent.length,
      // Frozen expectation: every planned command sent, at most one accepted, the rest refused with the exact reason.
      as_expected: Boolean(plan) && sent.length === demand && success <= 1 && failures === 0 && refused === demand - success && refused >= 1 };
  }
  const planned = Object.values(tenants).filter((t) => t.planned);
  return { stock_operation_sent: stock.length, hot_sent: hot.length, hot_share_percent: stock.length ? +((100 * hot.length) / stock.length).toFixed(1) : 0,
    hot_success: by(hot, 'success'), hot_refusals: by(hot, 'expected_refusal'), hot_failures: by(hot, 'failure'),
    contention: { tenants, all_as_expected: planned.length === SLOTS.length && planned.every((t) => t.as_expected) } };
}

// ---- profile timing compliance (config.timing) ---------------------------------------------------------------------
/** Deviations of a planned run from the profile timing: warmup, phases, cold-start attempts. */
export function profileDeviations({ timing, warmup, phases, coldAttempts }) {
  const out = [];
  if (warmup !== timing.warmup_seconds) out.push(`warmup ${warmup} s (profile ${timing.warmup_seconds} s)`);
  const want = timing.measurement_phases.map((p) => `${p.id}:${p.http_clients}:${p.duration_seconds}`), got = phases.map((p) => `${p.id}:${p.clients}:${p.duration_s}`);
  if (want.join(',') !== got.join(',')) out.push(`phases ${got.join(',')} (profile ${want.join(',')})`);
  if (coldAttempts !== timing.cold.attempts) out.push(`cold start ${coldAttempts} attempt(s) per process (profile ${timing.cold.attempts})`);
  return out;
}
/** run.json profile_compliance; a run that deviates from the profile timing needs --dry-run (and is not an acceptance run). */
export function planCompliance({ timing, warmup, phases, coldAttempts, dryRun }) {
  const deviations = profileDeviations({ timing, warmup, phases, coldAttempts });
  if (deviations.length && !dryRun) throw new Error(`the plan deviates from the profile timing (${deviations.join('; ')}); only a --dry-run may do that`);
  return { dry_run: Boolean(dryRun), timing_as_profile: deviations.length === 0, deviations, acceptance_run: !dryRun && deviations.length === 0 };
}

/** Cold start of one process over its sequential attempts (profile timing.cold): each attempt is a fresh container,
 * timed from `docker run` to an authenticated ordinary read of every tenant plus worker eligibility. */
export function coldStartSummary(attempts, { required, maxMs }) {
  const ok = attempts.filter((x) => x.ok), ms = ok.map((x) => x.business_ready_ms).sort((x, y) => x - y);
  const median = ms.length ? (ms.length % 2 ? ms[(ms.length - 1) / 2] : Math.round((ms[ms.length / 2 - 1] + ms[ms.length / 2]) / 2)) : null;
  return { attempts, required, completed: ok.length, median_ms: median, max_ms: ms.length ? ms[ms.length - 1] : null, limit_ms: maxMs,
    all_within: ok.length === attempts.length && attempts.length >= required && ms.every((x) => x <= maxMs) };
}
/** Readiness of one fresh process (probe.mjs output): /api/health with scoped automation on, an authenticated read per tenant. */
export function businessReady(probe) {
  return Boolean(probe && probe.health_status === 200 && probe.scoped_automation_enabled === true && probe.reads && SLOTS.every((s) => probe.reads[s] === 200));
}

// ---- post-run reconciliation (profile config.correctness; tools/scale/load/reconcile.mjs) -------------------------
// The guard functions evaluated read-only after migration in runs -02/-05 (data/scale/load/full-20261029-05/extra/tooling).
export const RECONCILE_GUARDS = Object.freeze(['ordinary187_valid', 'buyer_address_guards', 'order_merge_delivery209_valid', 'return_credit206_guards',
  'ordinary188_structure_valid', 'return_credit211_metadata_valid', 'large_import173_valid', 'fa3_draft_guards', 'pim_dictionary_valid',
  'local_invoice_guards', 'warehouse_wz_issuer_guards', 'email_inbound_guards', 'catalog_stock_control_guards', 'financial_return_guards', 'stocktake_adjustment_guards']);
// Every count must be 0 (mismatches, orphans, unfinished jobs); counts named run_* / rows are context, not checks.
const RECONCILE_ZERO = Object.freeze({
  stock: ['movement_mismatch', 'location_mismatch', 'layer_mismatch', 'reserved_mismatch', 'reservation_location_mismatch', 'available_formula', 'negative_available', 'reserved_over_on_hand'],
  reservations: ['active_on_closed_orders', 'open_orders_without_active', 'consumed_on_open_orders'],
  orders: ['duplicate_client_effects', 'cross_tenant_warehouse', 'total_mismatch'],
  invoices: ['missing_order', 'order_not_shipped', 'duplicate_per_order', 'gross_mismatch'],
  payments: ['missing_order', 'duplicate_client_key', 'overpaid_orders'],
  jobs: ['pending', 'running', 'failed'],
  orphans: ['documents_without_order', 'warehouse_documents_without_lines', 'stock_movements_without_order', 'manual_off_without_movement', 'wms_operations_without_document', 'automation_runs_without_order'],
});
/** facts (reconcile.mjs queries) → { status: PASS|FAIL, checks, failed, guards_true }. A missing count or guard fails. */
export function reconciliationVerdict(facts) {
  const checks = [];
  for (const [section, keys] of Object.entries(RECONCILE_ZERO)) for (const k of keys) {
    const v = facts?.[section]?.[k]; checks.push({ id: `${section}.${k}`, value: v ?? null, ok: v === 0 });
  }
  for (const g of RECONCILE_GUARDS) { const v = facts?.guards?.[g]; checks.push({ id: `guards.${g}`, value: v ?? null, ok: v === true }); }
  const failed = checks.filter((c) => !c.ok).map((c) => c.id), guardsTrue = RECONCILE_GUARDS.filter((g) => facts?.guards?.[g] === true).length;
  return { status: failed.length === 0 && guardsTrue >= 12 ? 'PASS' : 'FAIL', checks, failed, guards_true: guardsTrue };
}

// ---- background lanes (profile config.background) ------------------------------------------------------------------
/** Completions of one lane of one tenant in one phase: rate in every complete minute, and every rolling 60-s window
 * (the longest gap between consecutive completions, the phase start and end included) holds at least one. */
export function laneWindows(times, startMs, endMs, perMinute) {
  const xs = times.filter((t) => t >= startMs && t < endMs).sort((x, y) => x - y), buckets = [];
  for (let t = startMs; t + 60000 <= endMs + 1; t += 60000) buckets.push(xs.filter((x) => x >= t && x < t + 60000).length);
  let gap = 0, prev = startMs; for (const x of [...xs, endMs]) { gap = Math.max(gap, x - prev); prev = x; }
  const minBucket = buckets.length ? Math.min(...buckets) : null;
  return { completions: xs.length, per_minute_required: perMinute, min_complete_minute: minBucket, max_gap_s: +(gap / 1000).toFixed(1),
    rate_ok: minBucket !== null && minBucket >= perMinute, windows_ok: gap <= 60000 };
}
/** run.json background: per phase, lane and tenant. automation = finished runs of the run's rules (monitor lag rows);
 * order_import / stock_sync = import receipts done and verified Woo stock writes (monitor woo_done rows, woo.mjs) of
 * the tenants with a store (`woo.tenants`); a tenant without a store is `no_store`, never met. A lane the run could
 * not drive is recorded as blocked with its reason (profile: never set a required lane false). */
export function backgroundReport({ lanes, rows, phases, ruleSlots, blocked = {}, woo = null }) {
  const done = { automation: new Map(SLOTS.map((s) => [s, []])), order_import: new Map(SLOTS.map((s) => [s, []])), stock_sync: new Map(SLOTS.map((s) => [s, []])) };
  for (const r of rows.filter((x) => x.kind === 'lag' && Array.isArray(x.rule_ids))) r.rule_ids.forEach((id, i) => done.automation.get(ruleSlots[id])?.push(r.finished_ms[i]));
  for (const r of rows.filter((x) => x.kind === 'woo_done' && done[x.lane])) r.slots.forEach((s, i) => done[r.lane].get(s)?.push(r.finished_ms[i]));
  const out = { lanes: {}, all_ok: true };
  for (const lane of lanes) {
    if (blocked[lane.id]) { out.lanes[lane.id] = { status: 'blocked', reason: blocked[lane.id], per_tenant_per_minute: lane.per_tenant_per_minute }; out.all_ok = false; continue; }
    const measured = lane.id === 'automation' || (woo && done[lane.id]);
    if (!measured) { out.lanes[lane.id] = { status: 'not_measured', per_tenant_per_minute: lane.per_tenant_per_minute }; out.all_ok = false; continue; }
    const has = (s) => lane.id === 'automation' || woo.tenants.includes(s), per = {};
    for (const ph of phases) per[ph.id] = Object.fromEntries(SLOTS.map((s) => {
      const w = laneWindows(done[lane.id].get(s), ph.start_ms, ph.end_ms, lane.per_tenant_per_minute);
      return [s, has(s) ? w : { ...w, status: 'no_store', rate_ok: false }];
    }));
    const ok = Object.values(per).every((p) => Object.values(p).every((x) => x.rate_ok && x.windows_ok));
    out.lanes[lane.id] = { status: ok ? 'met' : 'not_met', per_tenant_per_minute: lane.per_tenant_per_minute, phases: per };
    if (!ok) out.all_ok = false;
  }
  return out;
}
/** Cause of a command that was prepared but not sent: the dataset ran out of saleable stock, or anything else. */
export function skipCause(detail) {
  return /products with stock ≥|no lot position with available stock|Za mało towaru/.test(String(detail ?? '')) ? 'stock' : 'other';
}

// ---- report ------------------------------------------------------------------------------------------------------
export const THRESHOLDS = Object.freeze({ read: { p95: 500, p99: 1000 }, write: { p95: 4000, p99: 8000 } });
const num = (v) => (v === '>10000' ? Infinity : v);
const pct = (n, d) => (d ? +((100 * n) / d).toFixed(1) : 0);
const SENT = new Set(['success', 'failure', 'expected_refusal']);

/** Sent mix against the profile mix (tolerance 2 pp), write share per phase and per complete 60-s bucket. */
function mixReport(mix, sent, ph, tolerance = 2) {
  const profile = Object.fromEntries(mix.map((m) => [m.id, m.percent]));
  const sentPercent = Object.fromEntries(mix.map((m) => [m.id, pct(sent.filter((s) => s.operation === m.id).length, sent.length)]));
  const writes = (xs) => xs.filter((s) => OPERATIONS[s.operation] === 'write').length;
  const buckets = [];
  for (let t = ph.start_ms; t + 60000 <= ph.end_ms + 1; t += 60000) { const b = sent.filter((s) => s.start_ms >= t && s.start_ms < t + 60000); buckets.push(pct(writes(b), b.length)); }
  const dev = Math.max(...mix.map((m) => Math.abs(sentPercent[m.id] - m.percent)));
  const writeProfile = mix.filter((m) => m.class === 'write').reduce((n, m) => n + m.percent, 0), writeShare = pct(writes(sent), sent.length);
  return { profile_percent: profile, sent_percent: sentPercent, max_deviation_pp: +dev.toFixed(1), tolerance_pp: tolerance, write_share_profile_percent: writeProfile,
    write_share_percent: writeShare, write_share_60s_buckets: buckets, write_share_min_bucket_percent: buckets.length ? Math.min(...buckets) : null,
    within_tolerance: dev <= tolerance && Math.abs(writeShare - writeProfile) <= tolerance && buckets.every((b) => Math.abs(b - writeProfile) <= tolerance) };
}

// ---- host pauses and power (full run 28.10.2026: the laptop slept, clamshell on battery) -------------------------
export const HOST_PAUSE_MS = 5000;
/**
 * Two consecutive 1-s clock samples {wall: Date.now(), mono: performance.now()}. A gap over thresholdMs on either
 * clock = the host or the orchestrator stood still. On macOS the monotonic clock (mach_absolute_time) does not
 * advance while the host sleeps, so wall ≫ mono marks sleep; both large marks a stalled process.
 */
export function hostPause(prev, cur, thresholdMs = HOST_PAUSE_MS) {
  const wall = cur.wall - prev.wall, mono = cur.mono - prev.mono;
  if (!(Math.max(wall, mono) > thresholdMs)) return null;
  return { kind: 'host_pause', from_ms: prev.wall, to_ms: cur.wall, at: new Date(cur.wall).toISOString(), wall_gap_ms: Math.round(wall), mono_gap_ms: Math.round(mono),
    cause: wall - mono > thresholdMs ? 'host_sleep' : 'process_stall' };
}
/** Host pauses overlapping the phase window [start_ms, end_ms). */
export const phasePauses = (pauses, ph) => pauses.filter((p) => p.from_ms < ph.end_ms && p.to_ms > ph.start_ms);
/** `pmset -g batt` output → true on battery, false on AC, null when unknown. */
export function onBatteryPower(pmset) {
  const m = /Now drawing from '([^']+)'/.exec(pmset ?? '');
  return m ? m[1] === 'Battery Power' : null;
}
/** Planned warmup + phases from one 1800-s profile phase up count as a full-profile run (5-min validation does not). */
export const FULL_PROFILE_MIN_S = 1800;
/** Polish refusal message, or null when the run may start. */
export function batteryRefusal({ platform, pmset, plannedSeconds, allowBattery }) {
  if (platform !== 'darwin' || allowBattery || plannedSeconds < FULL_PROFILE_MIN_S || onBatteryPower(pmset) !== true) return null;
  return 'Laptop pracuje na baterii (pmset -g batt). Pełny profil obciążenia wymaga zasilacza: na baterii z zamkniętą klapą macOS ' +
    'usypia hosta i unieważnia pomiar (bieg 28.10.2026). Podłącz zasilacz albo uruchom świadomie z --allow-battery.';
}

/**
 * samples: terminal records of measured requests {phase, client, tenant_slot, operation, start_ms (epoch), duration_ms,
 * http_status, outcome success|failure|not_bindable, reason, detail}. phases: [{id, clients, duration_s, start_ms, end_ms}].
 */
export function aggregate({ samples, phases, monitor = null, prep = [], mix = null, loops = [], hostPauses = [], contentionPlan = null }) {
  const out = { phases: {} };
  for (const ph of phases) {
    const mine = samples.filter((s) => s.phase === ph.id);
    // Measured = an HTTP request was sent: success, failure, or an expected refusal (labelled race, 409 with the exact
    // reason; excluded from success throughput and percentiles, latency shown separately). not_bindable (no bindings
    // variant) and prep_failed (unmeasured preparation refused) send nothing; reported separately with their causes.
    const measured = mine.filter((s) => SENT.has(s.outcome));
    const refusals = measured.filter((s) => s.outcome === 'expected_refusal');
    const prepFailed = mine.filter((s) => s.outcome === 'prep_failed');
    const ok = measured.filter((s) => s.outcome === 'success');
    const keyed = new Map(), add = (k, s) => { if (!keyed.has(k)) keyed.set(k, histogram()); addSample(keyed.get(k), s.duration_ms); };
    for (const s of ok) { add(`op:${s.operation}`, s); add(`op_tenant:${s.operation}:${s.tenant_slot}`, s); add(`class:${OPERATIONS[s.operation]}`, s); add('all', s); }
    const failures = measured.filter((s) => s.outcome === 'failure'), failHist = histogram();
    for (const s of failures) addSample(failHist, s.duration_ms);
    const durS = (ph.end_ms - ph.start_ms) / 1000;
    const buckets = [];
    for (let t = ph.start_ms; t + 60000 <= ph.end_ms + 1; t += 60000) buckets.push(ok.filter((s) => s.start_ms >= t && s.start_ms < t + 60000).length / 60);
    const ops = {};
    for (const op of Object.keys(OPERATIONS)) {
      const h = keyed.get(`op:${op}`) ?? histogram(), sm = summarize(h), th = THRESHOLDS[OPERATIONS[op]];
      const tenants = Object.fromEntries(SLOTS.map((sl) => [sl, summarize(keyed.get(`op_tenant:${op}:${sl}`) ?? histogram())]));
      ops[op] = { ...sm, class: OPERATIONS[op], attempted: measured.filter((s) => s.operation === op).length,
        failures: failures.filter((s) => s.operation === op).length, expected_refusals: refusals.filter((s) => s.operation === op).length, prep_failed: prepFailed.filter((s) => s.operation === op).length, not_bindable: mine.filter((s) => s.operation === op && s.outcome === 'not_bindable').length,
        within_threshold: h.count > 0 && num(sm.p95_ms) <= th.p95 && num(sm.p99_ms) <= th.p99,
        tenants_within_threshold: SLOTS.every((sl) => !tenants[sl].count || (num(tenants[sl].p95_ms) <= th.p95 && num(tenants[sl].p99_ms) <= th.p99)), tenants };
    }
    const errors = {};
    for (const s of failures) { const k = `${s.operation} ${s.http_status ?? '-'} ${s.reason}`; errors[k] ??= { count: 0, examples: [] }; errors[k].count++; if (errors[k].examples.length < 3) errors[k].examples.push({ tenant: s.tenant_slot, detail: s.detail ?? null }); }
    const prepErrors = {};
    for (const s of prepFailed) { const k = `${s.operation} ${s.reason}: ${String(s.detail ?? '').slice(0, 120)}`; prepErrors[k] = (prepErrors[k] ?? 0) + 1; }
    const statuses = {}; for (const s of measured) statuses[s.http_status ?? 'none'] = (statuses[s.http_status ?? 'none'] ?? 0) + 1;
    // Every 409 by cause (the client classifies with classifyConflict; older samples are classified here).
    const conflicts = {};
    for (const s of measured.filter((x) => x.http_status === 409)) {
      const cause = s.conflict_cause ?? classifyConflict(s.operation, 409, s.detail)?.cause, c = conflicts[cause] ??= { count: 0, labelled: false, expected_refusals: 0, errors: 0, by_operation: {} };
      c.count++; c.by_operation[s.operation] = (c.by_operation[s.operation] ?? 0) + 1;
      if (s.outcome === 'expected_refusal' || EXPECTED_RACES.some((x) => x.id === cause && x.operation === s.operation)) c.labelled = true;
      if (s.outcome === 'expected_refusal') c.expected_refusals++; else c.errors++;
    }
    const refusalHist = histogram(); for (const s of refusals) addSample(refusalHist, s.duration_ms);
    const races = {}; for (const s of refusals) races[s.conflict_cause] = (races[s.conflict_cause] ?? 0) + 1;
    const skipped = { stock: prepFailed.filter((s) => skipCause(s.detail) === 'stock').length, other: prepFailed.filter((s) => skipCause(s.detail) !== 'stock').length,
      not_bindable: mine.filter((s) => s.outcome === 'not_bindable').length };
    const myLoops = loops.filter((l) => l.phase === ph.id);
    const pauses = phasePauses(hostPauses, ph);
    out.phases[ph.id] = { clients: ph.clients, duration_s: +durS.toFixed(1), valid: pauses.length === 0, host_pauses: pauses, requests: measured.length, success: ok.length, failures: failures.length,
      expected_refusals: refusals.length, expected_refusal_fraction: measured.length ? +(refusals.length / measured.length).toFixed(4) : 0,
      expected_refusals_within_budget: refusals.length <= EXPECTED_REFUSAL_BUDGET * measured.length, refusals_by_race: races, refusal_latency: summarize(refusalHist),
      refusal_no_effect: { confirmed: refusals.filter((s) => s.no_effect === true).length, unconfirmed: refusals.filter((s) => s.no_effect !== true).length,
        had_effect: failures.filter((s) => s.reason === 'REFUSAL_HAD_EFFECT').length },
      conflicts_409: Object.fromEntries(Object.entries(conflicts).sort(([x], [y]) => x.localeCompare(y))), skipped,
      mix: mix ? mixReport(mix, measured, ph) : null,
      hot: hotReport(measured, mine, ph.id, contentionPlan),
      driver_loop_delay_ms: myLoops.length ? { clients: myLoops.length, p99_max: Math.max(...myLoops.map((l) => l.p99_ms)), max: Math.max(...myLoops.map((l) => l.max_ms)) } : null,
      not_bindable: mine.filter((s) => s.outcome === 'not_bindable').length, prep_failed: prepFailed.length, prep_errors: prepErrors, http_429: measured.filter((s) => s.http_status === 429).length, http_5xx: measured.filter((s) => s.http_status >= 500).length,
      timeouts: measured.filter((s) => s.reason === 'HTTP_TIMEOUT').length, success_rps: +(ok.length / durS).toFixed(2), rps_60s_buckets: buckets.map((b) => +b.toFixed(2)),
      tenant_share_percent: Object.fromEntries(SLOTS.map((sl) => [sl, measured.length ? +(100 * measured.filter((s) => s.tenant_slot === sl).length / measured.length).toFixed(1) : 0])),
      all: summarize(keyed.get('all') ?? histogram()), read: summarize(keyed.get('class:read') ?? histogram()), write: summarize(keyed.get('class:write') ?? histogram()),
      failed_requests_latency: summarize(failHist), statuses, operations: ops, errors,
      prep: summarizePrep(prep.filter((p) => p.phase === ph.id)), monitor: monitor?.[ph.id] ?? null };
  }
  return out;
}
function summarizePrep(prep) {
  const h = histogram(); for (const p of prep) addSample(h, p.duration_ms);
  const by = {}; for (const p of prep) { const k = `${p.method} ${p.route} ${p.status}`; by[k] = (by[k] ?? 0) + 1; }
  return { calls: prep.length, http_429: prep.filter((p) => p.status === 429).length, latency: summarize(h), by_route_status: by };
}

/** Worker queue sample of the monitor (once per second). jobs keeps every done job and has no index on created_at, so
 * counting the run's jobs by state is a sequential scan whose cost grows with the run (full-20261029-01: 7 k -> 102 k
 * rows; 98 ms per sample at 1 M rows). Each second counts only the pending jobs, which the partial index jobs_claim
 * (state='pending') serves; running/done/failed (the full scan) come every QUEUE_FULL_EVERY_S seconds, and every second
 * while draining, where the running count decides the end. $1 = run start (epoch ms). */
export const QUEUE_FULL_EVERY_S = 30;
const QUEUE_PENDING_SQL = `SELECT count(*)::int pending,
 extract(epoch FROM clock_timestamp()-min(created_at) FILTER (WHERE run_at<=clock_timestamp()))::float8 oldest_pending_s
 FROM jobs WHERE state='pending' AND created_at >= to_timestamp($1/1000.0)`;
const QUEUE_FULL_SQL = `SELECT count(*) FILTER (WHERE state='pending')::int pending, count(*) FILTER (WHERE state='running')::int running,
 count(*) FILTER (WHERE state='done')::int done, count(*) FILTER (WHERE state='failed')::int failed,
 extract(epoch FROM clock_timestamp()-min(created_at) FILTER (WHERE state='pending' AND run_at<=clock_timestamp()))::float8 oldest_pending_s
 FROM jobs WHERE created_at >= to_timestamp($1/1000.0)`;
export function queueSample(second, draining) {
  const full = draining || second % QUEUE_FULL_EVERY_S === 0;
  return { full, sql: full ? QUEUE_FULL_SQL : QUEUE_PENDING_SQL };
}
/** The drain ends on the latest full queue sample taken at least 1 s after it started, with nothing pending or running. */
export function queueDrained(rows, drainStart) {
  const q = rows.filter((x) => x.kind === 'queue' && x.full && x.at > drainStart + 1000).pop();
  return Boolean(q && q.pending === 0 && q.running === 0);
}

/** The completion lag query reads automation_runs by finished_at, which has no index (6 ms at 51 k runs, 139 ms at 509 k),
 * so it runs every LAG_EVERY_S seconds and every second while draining (or held); its finished_at cursor loses no run.
 * Each lag row carries the finish times, so summarizeMonitor counts a lag in the phase it finished in. */
export const LAG_EVERY_S = 30;
export function lagDue(second, often) {
  return often || second % LAG_EVERY_S === 0;
}

/** Monitor rows → per-phase summary (queue depth, oldest pending age, worker completion lag, pg_stat_activity). */
export function summarizeMonitor(rows, phases) {
  const out = {};
  for (const ph of phases) {
    const q = rows.filter((r) => r.kind === 'queue' && r.at >= ph.start_ms && r.at < ph.end_ms);
    const a = rows.filter((r) => r.kind === 'activity' && r.at >= ph.start_ms && r.at < ph.end_ms);
    // Completion lag can exceed the 10 s histogram range, so exact nearest-rank quantiles of the raw values.
    // A lag counts in the phase of its finish time; rows without finish times (before p276) in the phase of the sample.
    const lags = rows.filter((x) => x.kind === 'lag').flatMap((r) => r.lags_ms.map((v, i) => [r.finished_ms?.[i] ?? r.at, v]))
      .filter(([t]) => t >= ph.start_ms && t < ph.end_ms).map(([, v]) => Math.max(0, v)).sort((x, y) => x - y);
    const lq = (f) => (lags.length ? Math.round(lags[Math.min(lags.length - 1, Math.ceil(lags.length * f) - 1)]) : null);
    const lag = { count: lags.length, p50_ms: lq(0.5), p95_ms: lq(0.95), p99_ms: lq(0.99), max_ms: lags.length ? Math.round(lags[lags.length - 1]) : null };
    const depth = q.map((r) => r.pending), oldest = q.map((r) => r.oldest_pending_s ?? 0);
    const waits = {}, queries = {}; let active = 0;
    for (const r of a) { active += r.active; for (const [k, n] of Object.entries(r.waits)) waits[k] = (waits[k] ?? 0) + n; for (const [k, n] of Object.entries(r.queries)) queries[k] = (queries[k] ?? 0) + n; }
    const top = (m, n) => Object.entries(m).sort((x, y) => y[1] - x[1]).slice(0, n).map(([k, v]) => ({ key: k, samples: v, share: a.length ? +(v / Math.max(1, active)).toFixed(3) : 0 }));
    const sorted = (xs) => [...xs].sort((x, y) => x - y), pct = (xs, f) => (xs.length ? sorted(xs)[Math.min(xs.length - 1, Math.ceil(xs.length * f) - 1)] : null);
    const names = Object.assign({}, ...rows.filter((x) => x.kind === 'advisory_names').map((x) => x.names)), advisory = {};
    for (const r of rows.filter((x) => x.kind === 'advisory' && x.at >= ph.start_ms && x.at < ph.end_ms)) for (const k of r.keys) { const n = names[k.key] ?? k.key; advisory[n] = (advisory[n] ?? 0) + k.waiting; }
    // docker stats (every ~15 s): CPU % (100 = one core) and memory per container.
    const unit = { B: 1, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3, kB: 1e3, MB: 1e6, GB: 1e9 }, bytes = (x) => { const m = /^([\d.]+)\s*([A-Za-z]+)/.exec(x ?? ''); return m ? Number(m[1]) * (unit[m[2]] ?? 1) : 0; };
    const containers = {};
    for (const r of rows.filter((x) => x.kind === 'docker_stats' && x.at >= ph.start_ms && x.at < ph.end_ms)) for (const c of r.rows) {
      const k = containers[c.Name] ??= { samples: 0, cpu_percent_sum: 0, cpu_percent_max: 0, mem_max_bytes: 0 };
      const cpu = parseFloat(c.CPUPerc); k.samples++; k.cpu_percent_sum += cpu; k.cpu_percent_max = Math.max(k.cpu_percent_max, cpu); k.mem_max_bytes = Math.max(k.mem_max_bytes, bytes(String(c.MemUsage).split('/')[0].trim()));
    }
    for (const k of Object.values(containers)) { k.cpu_percent_mean = +(k.cpu_percent_sum / k.samples).toFixed(1); delete k.cpu_percent_sum; }
    // Saleable stock on MAIN per tenant (sum of available, products with ≥ 8 available) and its consumption.
    const st = rows.filter((x) => x.kind === 'stock' && x.at >= ph.start_ms && x.at < ph.end_ms), stock = {};
    if (st.length) for (const slot of Object.keys(st[0].tenants)) {
      const xs = st.filter((x) => x.tenants[slot]), a = xs[0], b = xs[xs.length - 1], minutes = (b.at - a.at) / 60000;
      const per = minutes > 0 ? +((a.tenants[slot].available - b.tenants[slot].available) / minutes).toFixed(1) : null;
      stock[slot] = { first: a.tenants[slot].available, last: b.tenants[slot].available, min: Math.min(...xs.map((x) => x.tenants[slot].available)),
        products_ge8_last: b.tenants[slot].products_ge8, consumed_per_min: per, runway_min: per > 0 ? +(b.tenants[slot].available / per).toFixed(1) : null };
    }
    out[ph.id] = { containers, stock, advisory_waiters_by_key: advisory, queue_samples: q.length, pending_max: depth.length ? Math.max(...depth) : null, pending_p95: pct(depth, 0.95),
      oldest_pending_p95_s: pct(oldest, 0.95), oldest_pending_max_s: oldest.length ? Math.max(...oldest) : null,
      completion_lag: lag, activity_samples: a.length, active_backends_mean: a.length ? +(active / a.length).toFixed(2) : null,
      top_waits: top(waits, 8), top_queries: top(queries, 10), load_avg_1m_max: q.length ? Math.max(...q.map((r) => r.load1 ?? 0)) : null };
  }
  return out;
}

// Per-address limit of the measured release: DYNA_RATE_LIMIT_PER_MIN (server/rate-limit-config.ts, owner decision
// 29.10.2026, docs/scale/LOAD-TEST-FULL-20261029.md §4.1). Same rule as the server; unset = the release default 600.
export const RATE_LIMIT_DEFAULT_PER_MIN = 600;
/** Published host port of the scale instance for the run's monitor: SCALE_PG_PORT (default 57090), paired with
 * SCALE_PG_CONTAINER by the rule of tools/scale/docker/scale-pg.sh (57090 is dyna-scale-pg18's; Main/PG04 ports refused). */
export function monitorPort(env) {
  const container = env.SCALE_PG_CONTAINER ?? 'dyna-scale-pg18', text = env.SCALE_PG_PORT ?? '57090';
  const n = /^[1-9][0-9]{0,4}$/.test(text) ? Number(text) : NaN;
  if (!(n >= 1 && n <= 65535)) throw new Error(`SCALE_PG_PORT: decimal port 1…65535 required, got ${JSON.stringify(text)}`);
  if ([4100, 5432, 57084].includes(n)) throw new Error(`SCALE_PG_PORT ${n} is reserved (Main/PG04)`);
  if (container !== 'dyna-scale-pg18' && n === 57090) throw new Error(`port 57090 belongs to dyna-scale-pg18; give ${container} its own SCALE_PG_PORT`);
  return n;
}
export function rateLimitOption(text) {
  if (text === undefined) return null;
  const n = /^[1-9][0-9]{1,5}$/.test(text) ? Number(text) : NaN;
  if (!(n >= 60 && n <= 100000)) throw new Error(`--rate-limit-per-min: decimal integer 60…100000 required, got ${JSON.stringify(text)}`);
  return n;
}
/** run.json rate_limit: what the running app reports in /api/health (rate_limit), checked against the request. */
export function rateLimitRecord(requested, reported) {
  if (reported === undefined || reported === null) {
    // Releases before 29.10 have the fixed 600 and no field; they cannot apply a requested value.
    if (requested !== null) throw new Error(`release does not report rate_limit in /api/health; --rate-limit-per-min ${requested} cannot be applied`);
    return { per_address_per_minute: RATE_LIMIT_DEFAULT_PER_MIN, window_seconds: 60, source: 'release-fixed', requested: null, reported_by_release: false };
  }
  const expected = requested ?? RATE_LIMIT_DEFAULT_PER_MIN, source = requested === null ? 'default' : 'env';
  if (reported.per_address_per_minute !== expected || reported.source !== source || reported.window_seconds !== 60)
    throw new Error(`app reports ${reported.per_address_per_minute} (${reported.source}) per address per minute, expected ${expected} (${source})`);
  return { per_address_per_minute: expected, window_seconds: 60, source, requested, reported_by_release: true };
}

/** run.json reply_health: /api/health of every release CLI after the drain (reply_warnings, ordinary_requests).
 * Run full-20261029-02 died on a second reply of one request; since 423497f the release counts such replies. */
export function replyHealthRecord(services) {
  const out = services.map(({ name, health, error }) => {
    if (error !== undefined) return { name, error };
    const w = health?.reply_warnings, o = health?.ordinary_requests;
    if (!w || typeof w !== 'object' || !o) return { name, error: 'no reply_warnings in /api/health' };
    return { name, reply_warnings: { ...w }, late_hook_failures: o.late_hook_failures, refused_admissions: o.refused_admissions };
  });
  const ok = out.filter((s) => s.error === undefined);
  const reply_warnings = ok.reduce((n, s) => n + Object.values(s.reply_warnings).reduce((a, b) => a + b, 0), 0);
  const late_hook_failures = ok.reduce((n, s) => n + s.late_hook_failures, 0);
  return { clean: ok.length === out.length && out.length > 0 && reply_warnings === 0 && late_hook_failures === 0, reply_warnings, late_hook_failures, services: out };
}

const fmt = (v) => (v === null || v === undefined ? '–' : String(v));
export function renderMarkdown(report) {
  const L = [`# Load test ${report.run_id}`, '', `Release ${report.release?.commit ?? '?'} · database ${report.database} · ${report.started_at} → ${report.finished_at}`, ''];
  const rl = report.rate_limit;
  if (rl) L.push(`Per-address rate limit ${rl.per_address_per_minute}/min (${rl.source === 'env' ? 'env DYNA_RATE_LIMIT_PER_MIN' : rl.source}, ` +
    `${rl.reported_by_release ? 'reported by /api/health' : 'release without the field, fixed in code'}).`, '');
  const pc = report.profile_compliance;
  if (pc) L.push(`Profile timing: ${pc.timing_as_profile ? 'as the profile' : `DEVIATES (${pc.deviations.join('; ')})`}${pc.dry_run ? ' — DRY RUN, not an acceptance run' : ''}.`, '');
  const cs = report.cold_start;
  if (cs) L.push(`Cold start (start → authenticated read of every tenant + worker eligible, limit ${cs.limit_ms / 1000} s): ` +
    Object.entries(cs.processes).map(([n, x]) => `${n} ${x.attempts.map((y) => (y.ok ? `${(y.business_ready_ms / 1000).toFixed(1)} s` : 'FAILED')).join(' / ')} (median ${x.median_ms === null ? '–' : (x.median_ms / 1000).toFixed(1)} s, max ${x.max_ms === null ? '–' : (x.max_ms / 1000).toFixed(1)} s)`).join('; ') +
    ` — ${cs.all_within ? 'within' : 'NOT MET'}.`, '');
  const bg = report.background;
  if (bg) L.push(`Background lanes: ${Object.entries(bg.lanes).map(([k, v]) => `${k} ${v.status}${v.reason ? ` (${v.reason})` : ''}`).join(', ')}.`, '');
  for (const [k, v] of Object.entries(bg?.lanes ?? {})) for (const [ph, per] of Object.entries(v.phases ?? {}))
    L.push(`- ${k} ${ph} (≥ ${v.per_tenant_per_minute}/min): ${Object.entries(per).map(([s, x]) => x.status === 'no_store' ? `${s} no store` : `${s} ${x.completions} (min ${x.min_complete_minute ?? '–'}/min, gap ${x.max_gap_s} s)${x.rate_ok && x.windows_ok ? '' : ' NOT MET'}`).join(', ')}`);
  if (bg && Object.values(bg.lanes).some((v) => v.phases)) L.push('');
  const rc = report.reconciliation;
  if (rc) L.push(`Reconciliation after the run: ${rc.status}${rc.failed?.length ? ` — failed ${rc.failed.join(', ')}` : ''}${rc.guards_true !== undefined ? ` (${rc.guards_true} guards true)` : ''}${rc.error ? ` — ${rc.error}` : ''}.`, '');
  const rh = report.reply_health;
  if (rh) L.push(`Reply warnings after the drain (/api/health): ${rh.reply_warnings}, late hook failures ${rh.late_hook_failures} — ` +
    rh.services.map((s) => s.error !== undefined ? `${s.name} unreachable (${s.error})` : `${s.name} ${Object.values(s.reply_warnings).reduce((a, b) => a + b, 0)}/${s.late_hook_failures}` +
      (Object.entries(s.reply_warnings).some(([, v]) => v) ? ` (${Object.entries(s.reply_warnings).filter(([, v]) => v).map(([k, v]) => `${k} ${v}`).join(', ')})` : '')).join(', ') +
    `.${rh.clean ? '' : ' NOT CLEAN.'}`, '');
  for (const [id, p] of Object.entries(report.result.phases)) {
    L.push(`## ${id}: ${p.clients} clients, ${p.duration_s} s${p.valid === false ? ' — NIEWAŻNA' : ''}`, '');
    if (p.valid === false) L.push(`NIEWAŻNA: host pause during the phase — ${p.host_pauses.map((x) => `${x.cause} ${Math.round(x.wall_gap_ms / 1000)} s ` +
      `(${new Date(x.from_ms).toISOString()} → ${new Date(x.to_ms).toISOString()})`).join('; ')}. The measurement of this phase does not count.`, '');
    L.push(
      `Requests ${p.requests}, success ${p.success} (${p.success_rps} RPS), failures ${p.failures}, 429 ${p.http_429}, 5xx ${p.http_5xx}, timeouts ${p.timeouts}; not sent: not bindable ${p.not_bindable}, preparation refused ${p.prep_failed}.`,
      `60-s buckets (success RPS): ${p.rps_60s_buckets.join(', ')}. Tenant share: ${Object.entries(p.tenant_share_percent).map(([k, v]) => `${k} ${v} %`).join(', ')}.`, '');
    if (p.expected_refusals !== undefined) L.push(
      `Expected refusals (labelled races) ${p.expected_refusals} (${(100 * p.expected_refusal_fraction).toFixed(2)} % of requests, budget 1 %: ${p.expected_refusals_within_budget ? 'within' : 'EXCEEDED'}; ` +
        `no effect confirmed ${p.refusal_no_effect.confirmed}, unconfirmed ${p.refusal_no_effect.unconfirmed}, had effect ${p.refusal_no_effect.had_effect}; latency p95 ${fmt(p.refusal_latency.p95_ms)} ms; not retried).`,
      `409 by cause: ${Object.entries(p.conflicts_409).map(([k, c]) => `${k} ${c.count} (${c.labelled ? 'labelled' : 'error'}${c.labelled && c.errors ? `, ${c.errors} error` : ''})`).join(', ') || 'none'}.`);
    if (p.mix) L.push(`Write share of sent requests ${p.mix.write_share_percent} % (profile ${p.mix.write_share_profile_percent} %, 60-s buckets ${p.mix.write_share_60s_buckets.join(', ')}), ` +
      `max operation deviation ${p.mix.max_deviation_pp} pp (tolerance ${p.mix.tolerance_pp} pp): ${p.mix.within_tolerance ? 'within' : 'OUTSIDE'}.`);
    if (p.skipped) L.push(`Not sent: skipped for lack of stock ${p.skipped.stock}, other preparation refusals ${p.skipped.other}, not bindable ${p.skipped.not_bindable}.` +
      (p.driver_loop_delay_ms ? ` Driver event-loop delay: p99 ≤ ${p.driver_loop_delay_ms.p99_max} ms, max ${p.driver_loop_delay_ms.max} ms over ${p.driver_loop_delay_ms.clients} clients.` : ''));
    if (p.hot) { const c = p.hot.contention.tenants, planned = SLOTS.filter((x) => c[x].planned);
      L.push(`Hot SKUs: ${p.hot.hot_share_percent} % of stock_operation (${p.hot.hot_sent} of ${p.hot.stock_operation_sent}; ${p.hot.hot_success} ok, ${p.hot.hot_refusals} refused, ${p.hot.hot_failures} failed).` +
        (planned.length ? ` Finite-stock contention: ${p.hot.contention.all_as_expected ? `as expected in ${planned.join(', ')}` : 'NOT AS EXPECTED'} — ` +
          planned.map((x) => `${x} ${c[x].sku} (${c[x].available_at_setup} available, ${c[x].demand_clients} demands): ${c[x].success} ok / ${c[x].refused} refused / ${c[x].failures} failed${c[x].not_sent ? ` / ${c[x].not_sent} not sent` : ''}`).join('; ') + '.' : ''));
    }
    L.push('',
      '| operation | class | n ok | fail | p50 | p95 | p99 | max | threshold p95/p99 | met |', '|---|---|---|---|---|---|---|---|---|---|');
    for (const [op, o] of Object.entries(p.operations)) { const t = THRESHOLDS[o.class];
      L.push(`| ${op} | ${o.class} | ${o.count} | ${o.failures}${o.expected_refusals ? ` (+${o.expected_refusals} refused)` : ''}${o.not_bindable ? ` (+${o.not_bindable} not bindable)` : ''}${o.prep_failed ? ` (+${o.prep_failed} not prepared)` : ''} | ${fmt(o.p50_ms)} | ${fmt(o.p95_ms)} | ${fmt(o.p99_ms)} | ${fmt(o.max_ms)} | ${t.p95}/${t.p99} | ${o.count ? (o.within_threshold && o.tenants_within_threshold ? 'yes' : 'no') : '–'} |`); }
    L.push(`| all reads | | ${p.read.count} | | ${fmt(p.read.p50_ms)} | ${fmt(p.read.p95_ms)} | ${fmt(p.read.p99_ms)} | ${fmt(p.read.max_ms)} | | |`,
      `| all writes | | ${p.write.count} | | ${fmt(p.write.p50_ms)} | ${fmt(p.write.p95_ms)} | ${fmt(p.write.p99_ms)} | ${fmt(p.write.max_ms)} | | |`, '');
    if (Object.keys(p.prep_errors).length) { L.push('Preparation refused (no measured request sent):', ''); for (const [k, n] of Object.entries(p.prep_errors)) L.push(`- ${n} × ${k}`); L.push(''); }
    if (Object.keys(p.errors).length) { L.push('Errors:', ''); for (const [k, e] of Object.entries(p.errors)) L.push(`- ${k}: ${e.count} — ${e.examples.map((x) => `${x.tenant}: ${String(x.detail ?? '').slice(0, 160)}`).join(' | ')}`); L.push(''); }
    const m = p.monitor;
    if (m) L.push(`Workers: pending max ${fmt(m.pending_max)}, oldest pending p95 ${fmt(m.oldest_pending_p95_s)} s / max ${fmt(m.oldest_pending_max_s)} s, completion lag p50 ${fmt(m.completion_lag.p50_ms)} / p95 ${fmt(m.completion_lag.p95_ms)} / p99 ${fmt(m.completion_lag.p99_ms)} ms (${m.completion_lag.count} jobs).`,
      `pg_stat_activity: ${m.activity_samples} samples, active backends mean ${fmt(m.active_backends_mean)}; top waits ${m.top_waits.map((w) => `${w.key} ${w.samples}`).join(', ')}.`,
      `Containers (docker stats): ${Object.entries(m.containers ?? {}).map(([n, c]) => `${n} CPU mean ${c.cpu_percent_mean} % / max ${c.cpu_percent_max} %, RSS max ${(c.mem_max_bytes / 2 ** 30).toFixed(2)} GiB`).join('; ') || '–'}; host load (1 min) max ${fmt(m.load_avg_1m_max)}.`,
      `Saleable stock on MAIN (units, first → last, consumed/min, runway): ${Object.entries(m.stock ?? {}).map(([k, s]) => `${k} ${s.first} → ${s.last} (${fmt(s.consumed_per_min)}/min, ${fmt(s.runway_min)} min, ${s.products_ge8_last} SKU ≥ 8)`).join('; ') || '–'}.`,
      `Advisory lock waiters (sum over samples): ${Object.entries(m.advisory_waiters_by_key ?? {}).sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k} ${v}`).join(', ') || '–'}.`, '',
      'Top active queries (samples):', '', ...m.top_queries.map((q) => `- ${q.samples} × \`${q.key.replace(/`/g, "'")}\``), '');
    L.push(`Unmeasured preparation: ${p.prep.calls} calls, 429 ${p.prep.http_429}, p95 ${fmt(p.prep.latency.p95_ms)} ms.`, '');
  }
  return L.join('\n') + '\n';
}
