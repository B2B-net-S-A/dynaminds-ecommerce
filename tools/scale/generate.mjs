#!/usr/bin/env node
// Deterministic scale-data generator (stage 5). Plan: tools/scale/plan.mjs; writes: tools/scale/writer.mjs.
//
//   DYNA_TEST=true DATABASE_URL=postgres://…@127.0.0.1:<port>/dynaminds_scale_YYYYMMDD_NN \
//   DYNA_LOCAL_CONFIG_PATH=<config.json> node node_modules/tsx/dist/cli.mjs tools/scale/generate.mjs \
//     [--scale-factor 0.01] [--tenants N] [--skus N] [--orders N] [--days N] [--seed S] [--as-of ISO]
//     [--connections 4] [--product-batch 100] [--order-batch 25] [--checkpoint path] [--report path] [--plan-only]
//     [--simulate-days --faketime-file <path>] [--release <release-build.json>]
//
// --release (manifest section 2): the writes run inside a packaged release built by tools/scale/release-build.mjs,
// through its ordinary factory (schema gate installed, no per-transaction schema preflight) and its emitted
// chunks (tools/scale/release-runtime.mjs); plain `node` is enough. DATABASE_URL must use the postgres owner
// whose password is DYNA_LOCAL_CONFIG_PATH's dbPassword (the factory checks it). Without --release the
// source tree runs under tsx and every tenantTx pays the schema preflights (manifest section 7).
//
// --simulate-days (dedicated Docker PostgreSQL with libfaketime only, tools/scale/docker): the catalogue,
// WMS opening and PZ receipts are written on the day before the window, then the orders of each planned
// day are written with the database and Node clocks set to that day (06:00 UTC + elapsed time), so
// created_at and every other now() in the ordinary paths carry the historical day. All tenant lanes
// meet at a barrier before the clock moves; at the end the clock returns to real time.
//
// Same seed + parameters = same plan digest; a rerun with the same checkpoint continues where the last
// batch committed and never creates a second copy of a record (SKU, order note marker, client keys).
import { resolve } from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { resolveParams, planDigest, tenantPlan, demand, orderPlan } from './plan.mjs';
import { loadCheckpoint, saveCheckpoint, tenantProgress } from './checkpoint.mjs';
import { checkGuards, tenantCounts, databaseStats, historySpread, wmsCounts, clockProbe } from './inspect.mjs';
import { installNodeClock, setSimulatedTime, dayWindow, dayRanges, realIso, writeOffsetFile, setNodeOffset, acquireClockLock, DAY_MS } from './simclock.mjs';

const { values: a } = parseArgs({ options: {
  'scale-factor': { type: 'string' }, tenants: { type: 'string' }, skus: { type: 'string' }, orders: { type: 'string' },
  days: { type: 'string' }, seed: { type: 'string' }, 'as-of': { type: 'string' }, connections: { type: 'string', default: '4' },
  'product-batch': { type: 'string', default: '100' }, 'order-batch': { type: 'string', default: '25' }, 'tx-mode': { type: 'string', default: 'step' },
  checkpoint: { type: 'string' }, report: { type: 'string' }, 'plan-only': { type: 'boolean', default: false },
  'guard-timeout-ms': { type: 'string', default: '60000' }, 'simulate-days': { type: 'boolean', default: false },
  'faketime-file': { type: 'string' }, release: { type: 'string' }, retries: { type: 'string', default: '40' }, 'day-hour-utc': { type: 'string', default: '6' } } });
const num = (v) => (v === undefined ? undefined : Number(v));
const params = resolveParams({ scaleFactor: num(a['scale-factor']), tenants: num(a.tenants), skus: num(a.skus), orders: num(a.orders),
  days: num(a.days), seed: a.seed, asOf: a['as-of'] });
const t0 = performance.now();
const digest = planDigest(params);
console.log(`plan ${params.version} seed=${params.seed} tag=${params.tag} tenants=${params.tenants} skus=${params.skus} orders=${params.orders} days=${params.days}`);
console.log(`plan sha256 ${digest.sha256} (${Math.round(performance.now() - t0)} ms)`);
if (a['plan-only']) { console.log(JSON.stringify(digest.sections, null, 1)); process.exit(0); }

// ---- target database: isolated owned scale clone only -----------------------------------------
const url = new URL(process.env.DATABASE_URL ?? 'invalid://missing');
const database = url.pathname.slice(1);
const refuse = (why) => { console.error('Odmowa: ' + why); process.exit(2); };
if (process.env.DYNA_TEST !== 'true') refuse('wymagane DYNA_TEST=true (izolowany tryb testowy)');
if (!['127.0.0.1', 'localhost'].includes(url.hostname)) refuse('tylko lokalny Postgres (127.0.0.1)');
if (!/^dynaminds_scale_[0-9]{8}_[0-9]{2}$/.test(database)) refuse('baza musi nazywać się dynaminds_scale_YYYYMMDD_NN (osobny klon), jest: ' + database);
if (!process.env.DYNA_LOCAL_CONFIG_PATH) refuse('wymagane DYNA_LOCAL_CONFIG_PATH (konfiguracja testowa, nie Main)');
const connections = Number(a.connections), productBatch = Number(a['product-batch']), orderBatch = Number(a['order-batch']);
if (!(connections >= 1 && connections <= 8)) refuse('--connections 1..8');
const txMode = a['tx-mode'];
if (!['step', 'batch'].includes(txMode)) refuse('--tx-mode step|batch');
const simulate = a['simulate-days'];
const faketimeFile = a['faketime-file'] ?? process.env.SCALE_FAKETIME_FILE;
if (simulate && !faketimeFile) refuse('--simulate-days wymaga --faketime-file (albo SCALE_FAKETIME_FILE) instancji Docker z libfaketime');
const dayHour = Number(a['day-hour-utc']);
if (!(dayHour >= 0 && dayHour <= 12)) refuse('--day-hour-utc 0..12');
const cpPath = resolve(a.checkpoint ?? `data/scale/${database}-${params.tag}.checkpoint.json`);
const cp = loadCheckpoint(cpPath, { planSha256: digest.sha256, database });
const dbUrl = url.toString();

const guardsBefore = await checkGuards(dbUrl, Number(a['guard-timeout-ms']));
console.log('guards before', JSON.stringify(guardsBefore.values));
if (!guardsBefore.all_true) refuse('strażnicy nie są prawdziwi przed generowaniem');
const statsBefore = await databaseStats(dbUrl);

// The simulated clock must replace Date before any application module is loaded.
const clockLog = [];
const moveClock = async (targetMs, label) => {
  const r = await setSimulatedTime({ file: faketimeFile, targetMs, probe: () => clockProbe(dbUrl) });
  clockLog.push({ label, target: new Date(targetMs).toISOString(), ...r, at: realIso() });
  console.log(`clock ${label}: db ${r.db_now} node ${r.node_now} (offset ${r.offset_seconds}s)`);
};
let releaseClock = () => {};
if (simulate) {
  releaseClock = acquireClockLock(resolve(faketimeFile));
  installNodeClock();
  await moveClock(dayWindow(params, 0).from - DAY_MS + dayHour * 3600_000, 'catalogue');
}
const { openRuntime, setupTenant, loadProducts, writeProducts, writeOrderBatch, findOrders, enableLots, receiptDocuments, writeReceipt } = await import('./writer.mjs');
const releaseBuild = a.release ? resolve(a.release) : undefined;
// One pool connection more than lanes: with --connections ≥ tenants every lane can hold its batch transaction
// while it refreshes the session (authTx needs its own connection); without the spare the pool times out.
const rt = await openRuntime({ connections: connections + 1, release: releaseBuild });
const runtime = rt.release ? { kind: 'release', build_record: releaseBuild, ...rt.release } : { kind: 'source' };
console.log('runtime', JSON.stringify(runtime));
const run = { started_at: realIso(), connections, product_batch: productBatch, order_batch: orderBatch, tx_mode: txMode, simulate_days: simulate, runtime };
cp.runs.push(run);
const stats = Object.fromEntries(params.perTenant.map((pt) => [pt.slot, { products: 0, orders: 0, steps: 0, scans: 0, invoices: 0, returns: 0, refunds: 0,
  opening_lines: 0, receipts: 0, receipt_lines: 0, tx: 0 }]));
const tenants = new Map(), productIds = new Map(), demands = new Map(), dayLog = [];
const began = performance.now();
let lastLog = 0;
const progress = (force = false) => {
  if (!force && performance.now() - lastLog < 5000) return;
  lastLog = performance.now();
  const s = (performance.now() - began) / 1000;
  console.log(`[${s.toFixed(0)}s] ` + params.perTenant.map((pt) => {
    const g = tenantProgress(cp, pt.slot), st = stats[pt.slot];
    return `${pt.slot}:${g.phase} sku ${g.products_next}/${pt.skus} ord ${g.orders_next}/${pt.orders}`;
  }).join(' | ') + ` | ${(Object.values(stats).reduce((x, v) => x + v.products + v.orders, 0) / s).toFixed(1)} rec/s`);
};

// A statement timeout (57014) is retried: in source mode the schema preflights before every tenantTx
// (pim_dictionary_valid ~7 s against the pool's 8 s limit) time out now and then before any write, and
// every step here is resumable (existing SKUs, order markers, client keys), so a rerun of the batch is
// the same as the restart a person would do. Each retry is counted and printed.
const maxRetries = Number(a.retries), retryLog = [];
async function withRetry(slot, label, fn, before = async () => {}) {
  for (let attempt = 0; ; attempt++) {
    try { return await fn(); } catch (e) {
      if (e?.code !== '57014' || attempt >= maxRetries) throw e;
      const frame = String(e.stack ?? '').split('\n').find((l) => l.includes('/server/') || l.includes('/tools/scale/'))?.trim() ?? '';
      retryLog.push({ slot, label, attempt: attempt + 1, at: realIso(), frame: frame.replace(/^.*\/(server|tools)\//, '$1/') });
      console.log(`retry ${slot} ${label} #${attempt + 1} after statement timeout (${retryLog.at(-1).frame})`);
      await before();
    }
  }
}
const reloadIds = async (tenant, ids) => { const fresh = await loadProducts(rt, tenant); ids.clear(); for (const [k, v] of fresh) ids.set(k, v); };

/** Tenant setup, catalogue and (lot tenants) WMS opening + PZ receipts. */
async function catalogueLane(t) {
  const pt = params.perTenant[t], g = tenantProgress(cp, pt.slot), st = stats[pt.slot];
  const tenant = await withRetry(pt.slot, 'setup', () => setupTenant(rt, tenantPlan(params, t)));
  if (g.tenant_id && g.tenant_id !== tenant.tenantId) throw new Error(`Firma ${pt.slot}: checkpoint wskazuje inną firmę`);
  g.tenant_id = tenant.tenantId;
  if (g.phase === 'setup') g.phase = 'products';
  g.wms_lots_planned = pt.wms_lots;
  saveCheckpoint(cpPath, cp);
  // Fixed cost of one empty ordinary tenantTx here (source mode runs schema preflights per transaction).
  const samples = [];
  for (let k = 0; k < 3; k++) {
    const s0 = performance.now();
    try { await rt.db.tenantTx(tenant.tenantId, (c) => c.query('SELECT 1')); samples.push(performance.now() - s0); } catch (e) { if (e?.code !== '57014') throw e; }
  }
  g.empty_tx_ms = samples.length ? Math.round(Math.min(...samples)) : null;
  const d = demand(params, t), ids = await loadProducts(rt, tenant);
  tenants.set(t, tenant); productIds.set(t, ids); demands.set(t, d);
  const txBefore = g.tx_total ?? 0; g.countTx = () => { g.tx_total = txBefore + st.tx; };
  while (g.products_next < pt.skus) {
    const from = g.products_next, to = Math.min(pt.skus, from + productBatch), t1 = performance.now();
    await withRetry(pt.slot, `products ${from}`, () => writeProducts(rt, params, t, tenant, from, to, d, ids, st), () => reloadIds(tenant, ids));
    g.product_seconds += (performance.now() - t1) / 1000;
    g.products_next = to; g.countTx(); saveCheckpoint(cpPath, cp); progress();
  }
  if (pt.wms_lots) {
    const t1 = performance.now();
    if (g.phase === 'products') { g.wms_opening = await withRetry(pt.slot, 'wms opening', () => enableLots(rt, params, t, tenant, ids, d, st)); g.phase = 'receipts'; g.countTx(); saveCheckpoint(cpPath, cp); }
    const docs = receiptDocuments(params, t, d);
    g.receipts_next ??= 0;
    while (g.receipts_next < docs.length) {
      await withRetry(pt.slot, `pz ${g.receipts_next}`, () => writeReceipt(rt, params, tenant, docs[g.receipts_next], ids, st));
      g.receipts_next++; g.countTx(); saveCheckpoint(cpPath, cp); progress();
    }
    g.receipts_total = docs.length;
    g.lots_seconds = (g.lots_seconds ?? 0) + (performance.now() - t1) / 1000;
    tenant.lots = true;
  }
  g.wms_lots_applied = Boolean(pt.wms_lots);
  if (g.phase !== 'done') g.phase = 'orders';
  saveCheckpoint(cpPath, cp);
}
/** Orders [g.orders_next, until) of tenant t in batches. */
async function orderLane(t, until) {
  const pt = params.perTenant[t], g = tenantProgress(cp, pt.slot), st = stats[pt.slot];
  const tenant = tenants.get(t), ids = productIds.get(t);
  while (g.orders_next < until) {
    const from = g.orders_next, to = Math.min(until, from + orderBatch), t1 = performance.now();
    const batch = Array.from({ length: to - from }, (_, k) => orderPlan(params, t, from + k));
    await withRetry(pt.slot, `orders ${from}`, async () => {
      const existing = await findOrders(rt, tenant, batch.map((o) => o.key));
      await writeOrderBatch(rt, params, t, tenant, batch, ids, existing, txMode, st);
    });
    g.order_seconds += (performance.now() - t1) / 1000;
    g.orders_next = to; g.countTx(); saveCheckpoint(cpPath, cp); progress();
  }
  if (g.orders_next >= pt.orders) { g.phase = 'done'; saveCheckpoint(cpPath, cp); }
}
/** One lane per tenant, at most `connections` at once (createProduct and WMS serialize per tenant anyway). */
async function lanes(work) {
  const queue = params.perTenant.map((_, t) => t);
  await Promise.all(Array.from({ length: Math.min(connections, queue.length) }, async () => {
    while (queue.length) await work(queue.shift());
  }));
}

let failure;
try {
  // One lane per tenant, at most `connections` at once (createProduct serializes per tenant anyway).
  await lanes(catalogueLane);
  if (!simulate) await lanes((t) => orderLane(t, params.perTenant[t].orders));
  else {
    const ranges = params.perTenant.map((_, t) => dayRanges(params, t, (j) => orderPlan(params, t, j).placed_at));
    for (let k = 0; k < params.days; k++) {
      const pending = params.perTenant.map((pt, t) => ranges[t][k][1] > tenantProgress(cp, pt.slot).orders_next);
      if (!pending.some(Boolean)) continue;
      const day = dayWindow(params, k), d0 = performance.now(), before = params.perTenant.map((pt) => tenantProgress(cp, pt.slot).orders_next);
      await moveClock(day.from + dayHour * 3600_000, `day ${k}`); // barrier: every lane is idle here
      await lanes((t) => orderLane(t, ranges[t][k][1]));
      dayLog.push({ day: k, date: new Date(day.from).toISOString().slice(0, 10), seconds: Math.round((performance.now() - d0) / 100) / 10,
        orders: Object.fromEntries(params.perTenant.map((pt, t) => [pt.slot, tenantProgress(cp, pt.slot).orders_next - before[t]])) });
      console.log(`day ${k} ${dayLog.at(-1).date} done in ${dayLog.at(-1).seconds}s`, JSON.stringify(dayLog.at(-1).orders));
    }
  }
} catch (e) { failure = e; console.error('Błąd generowania:', e?.message ?? e); console.error(String(e?.stack ?? '').split('\n').slice(1, 8).join('\n')); }
finally {
  progress(true);
  await rt.close();
  if (simulate) { writeOffsetFile(faketimeFile, 0); setNodeOffset(0); await new Promise((r) => setTimeout(r, 2200)); clockLog.push({ label: 'real', at: realIso() }); releaseClock(); }
}

const seconds = (performance.now() - began) / 1000;
const statsAfter = await databaseStats(dbUrl);
const guardsAfter = await checkGuards(dbUrl, Number(a['guard-timeout-ms']));
const tenantIds = params.perTenant.map((pt) => tenantProgress(cp, pt.slot).tenant_id).filter(Boolean);
const counts = await tenantCounts(dbUrl, tenantIds);
const history = await historySpread(dbUrl, tenantIds);
const wms = await wmsCounts(dbUrl, tenantIds);
const total = Object.values(stats).reduce((s, v) => { for (const [k, n] of Object.entries(v)) s[k] = (s[k] ?? 0) + n; return s; }, {});
const lanesMeasured = Math.min(connections, params.tenants);
// Per-record lane cost measured here, scaled to the full profile (5 tenants × 20k SKU + 20k orders).
// "work" subtracts the measured fixed cost of each tenantTx (schema preflights of the source runtime;
// the packaged ordinary runtime skips them behind its schema gate, so there the two are close).
const perTenant = params.perTenant.map((pt) => { const g = tenantProgress(cp, pt.slot), st = stats[pt.slot];
  const products = Math.max(1, g.products_next), orders = Math.max(1, g.orders_next), overhead = ((g.tx_total ?? st.tx) * (g.empty_tx_ms ?? 0)) / 1000;
  const lane = g.product_seconds + g.order_seconds;
  return { slot: pt.slot, empty_tx_ms: g.empty_tx_ms, tx: g.tx_total ?? st.tx, lane_seconds: lane, tx_overhead_seconds: overhead,
    s_per_product: g.product_seconds / products, s_per_order: g.order_seconds / orders,
    work_s_per_record: Math.max(0, lane - overhead) / (products + orders) }; });
const avg = (k) => perTenant.reduce((s, x) => s + x[k], 0) / perTenant.length;
const fullLaneSeconds = 20000 * avg('s_per_product') + 20000 * avg('s_per_order');
const fullWorkLaneSeconds = 40000 * avg('work_s_per_record');
const waves = Math.ceil(5 / Math.min(connections, 5));
const report = {
  schema: 'dyna-scale-generate-report/v1', database, plan: { sha256: digest.sha256, params },
  run: { ...run, ended_at: realIso(), seconds: Math.round(seconds * 10) / 10, failure: failure ? String(failure.message ?? failure) : null },
  written: total,
  throughput: {
    records_per_s: (total.products + total.orders) / seconds, steps_per_s: total.steps / seconds,
    db_rows_inserted: Number(statsAfter.ins) - Number(statsBefore.ins), db_rows_updated: Number(statsAfter.upd) - Number(statsBefore.upd),
    db_rows_inserted_per_s: (Number(statsAfter.ins) - Number(statsBefore.ins)) / seconds,
    db_commits: Number(statsAfter.commits) - Number(statsBefore.commits),
    db_bytes_before: Number(statsBefore.bytes), db_bytes_after: Number(statsAfter.bytes), per_tenant: perTenant, days: dayLog,
  },
  extrapolation_full_profile: {
    assumption: `5 firm × (20 000 SKU + 20 000 zamówień), ${Math.min(connections, 5)} równoległe tory, tx-mode ${txMode}, koszt rekordu jak w tym biegu (bez wzrostu kosztu z rozmiarem tabel)`,
    runtime: runtime.kind,
    // measured_runtime = this run's runtime (source or release); source_runtime kept for older reports.
    measured_runtime: { lane_hours: fullLaneSeconds / 3600, wall_hours: (fullLaneSeconds * waves) / 3600 },
    source_runtime: { lane_hours: fullLaneSeconds / 3600, wall_hours: (fullLaneSeconds * waves) / 3600 },
    without_tx_preflight: { lane_hours: fullWorkLaneSeconds / 3600, wall_hours: (fullWorkLaneSeconds * waves) / 3600 },
    lanes_measured: lanesMeasured,
  },
  guards: { before: guardsBefore, after: guardsAfter }, counts, history, wms, clock: clockLog, retries: retryLog,
  history_note: simulate
    ? 'created_at = symulowany dzień planu (libfaketime w bazie + przesunięty Date w procesie generatora), zapis zwykłymi ścieżkami.'
    : 'created_at = czas zapisu; plan wyznacza placed_at w oknie dni, ale bez --simulate-days zwykłe ścieżki biorą bieżący czas (patrz manifest).',
};
for (const pt of params.perTenant) delete tenantProgress(cp, pt.slot).countTx;
cp.runs[cp.runs.length - 1] = { ...run, ended_at: report.run.ended_at, seconds: report.run.seconds, written: total, failure: report.run.failure };
saveCheckpoint(cpPath, cp);
const reportPath = resolve(a.report ?? `data/scale/${database}-${params.tag}.report.json`);
mkdirSync(resolve(reportPath, '..'), { recursive: true, mode: 0o700 });
writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
console.log('guards after', JSON.stringify(guardsAfter.values), JSON.stringify(guardsAfter.ms));
console.log('written', JSON.stringify(total));
console.log(`throughput ${report.throughput.records_per_s.toFixed(2)} rec/s, ${report.throughput.steps_per_s.toFixed(2)} steps/s, ${report.throughput.db_rows_inserted_per_s.toFixed(0)} db rows/s`);
const ex = report.extrapolation_full_profile;
console.log(`extrapolated full profile: ${runtime.kind} runtime ${ex.measured_runtime.wall_hours.toFixed(1)} h wall; minus measured empty-tx cost ${ex.without_tx_preflight.wall_hours.toFixed(1)} h wall`);
console.log('per tenant', JSON.stringify(perTenant));
console.log('history', JSON.stringify(history));
console.log('wms', JSON.stringify(wms));
console.log('report', reportPath);
process.exit(failure || !guardsAfter.all_true ? 1 : 0);
