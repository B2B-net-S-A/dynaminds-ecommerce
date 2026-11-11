// Determinism and distribution of the stage 5 scale-data plan (tools/scale). Pure: no database.
// Run: node --test tests/scale-generator.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stream, uuidFrom } from '../tools/scale/prng.mjs';
import { resolveParams, planDigest, productPlan, productBase, productKind, orderPlan, orderSteps, customerPlan, tenantPlan, demand,
  hotCount, STATUS_WEIGHTS, FULL, PLAN_VERSION, BUNDLE_LINE_PERCENT, OPENING_PERCENT, OPENING_UNKNOWN_COST_PERCENT,
  RECEIPT_ZERO_COST_PERCENT } from '../tools/scale/plan.mjs';
import { loadCheckpoint, saveCheckpoint, tenantProgress } from '../tools/scale/checkpoint.mjs';
import { orderSegments, receiptDocuments } from '../tools/scale/writer.mjs';
import { dayRanges, dayWindow, dayOf, offsetSeconds, formatOffset, parseOffset, installNodeClock, setNodeOffset, DAY_MS } from '../tools/scale/simclock.mjs';

const small = { seed: 'unit-test', tenants: 2, skus: 300, orders: 200 };

test('same seed and parameters give the same plan hashes, section by section', () => {
  const a = planDigest(resolveParams(small)), b = planDigest(resolveParams({ ...small }));
  assert.equal(a.sha256, b.sha256);
  assert.deepEqual(a.sections, b.sections);
  assert.deepEqual(Object.keys(a.sections), ['params', 'tenant:A', 'products:A', 'customers:A', 'orders:A', 'tenant:B', 'products:B', 'customers:B', 'orders:B']);
  assert.equal(a.sections['products:A'].rows, 150);
  assert.equal(a.sections['orders:B'].rows, 100);
});

test('the plan is pinned: a change of generator semantics shows up as a new digest', () => {
  // Checkpoints bind to this digest; change it only together with PLAN_VERSION and the manifest.
  assert.equal(PLAN_VERSION, 'dyna-scale-plan/v2');
  assert.equal(planDigest(resolveParams(small)).sha256, PINNED_SMALL);
});

test('another seed, as-of or size changes the data; tenant and record identity follow the seed', () => {
  const base = planDigest(resolveParams(small));
  const seed = planDigest(resolveParams({ ...small, seed: 'unit-test-2' }));
  assert.notEqual(seed.sha256, base.sha256);
  for (const k of ['products:A', 'customers:A', 'orders:A']) assert.notEqual(seed.sections[k].sha256, base.sections[k].sha256);
  const asOf = planDigest(resolveParams({ ...small, asOf: '2026-11-01T00:00:00Z' }));
  // As-of moves order dates and (lot tenant A only) lot expiry dates, nothing else in the catalogue.
  assert.equal(asOf.sections['products:B'].sha256, base.sections['products:B'].sha256, 'as-of leaves a non-lot catalogue alone');
  const pa = resolveParams(small), pb = resolveParams({ ...small, asOf: '2026-11-01T00:00:00Z' }), da = demand(pa, 0);
  const noExpiry = (x) => JSON.stringify(x, (k, v) => (k === 'expiry_date' ? undefined : v));
  for (let i = 0; i < 150; i++) assert.equal(noExpiry(productPlan(pb, 0, i, da)), noExpiry(productPlan(pa, 0, i, da)));
  assert.notEqual(asOf.sections['orders:A'].sha256, base.sections['orders:A'].sha256);
  const p1 = resolveParams(small), p2 = resolveParams({ ...small, seed: 'unit-test-2' });
  assert.notEqual(tenantPlan(p1, 0).owner.email, tenantPlan(p2, 0).owner.email, 'two seeds never share a tenant');
  assert.notEqual(orderPlan(p1, 0, 0).key, orderPlan(p2, 0, 0).key);
});

test('random access: record N is identical whatever is generated before it (resume safety)', () => {
  const p = resolveParams(small);
  const late = [orderPlan(p, 1, 99), productBase(p, 1, 149), customerPlan(p, 1, 39)];
  for (let j = 0; j < 100; j++) orderPlan(p, 1, j);
  assert.deepEqual([orderPlan(p, 1, 99), productBase(p, 1, 149), customerPlan(p, 1, 39)], late);
  assert.deepEqual(orderPlan(resolveParams(small), 0, 7), orderPlan(p, 0, 7));
});

test('scale factor maps to the frozen full profile; explicit sizes win; bad input is refused', () => {
  const full = resolveParams({});
  assert.deepEqual([full.tenants, full.skus, full.orders, full.days], [FULL.tenants, FULL.skus, FULL.orders, FULL.days]);
  assert.deepEqual(full.perTenant.map((t) => [t.slot, t.skus, t.orders, t.wms_lots]),
    [['A', 20000, 20000, true], ['B', 20000, 20000, false], ['C', 20000, 20000, true], ['D', 20000, 20000, false], ['E', 20000, 20000, true]]);
  const tiny = resolveParams({ scaleFactor: 0.01 });
  assert.deepEqual([tiny.tenants, tiny.skus, tiny.orders, tiny.days], [2, 1000, 1000, 180]);
  assert.equal(resolveParams({ scaleFactor: 0.01, tenants: 3, skus: 900 }).perTenant[2].skus, 300);
  assert.throws(() => resolveParams({ skus: 150, tenants: 2 }), /minimum 100/);
  assert.throws(() => resolveParams({ scaleFactor: 2 }), /scale-factor/);
  assert.throws(() => resolveParams({ seed: 'a b' }), /seed/);
  assert.throws(() => resolveParams({ orders: 0 }), /orders/);
  assert.throws(() => resolveParams({ asOf: 'jutro' }), /as-of/);
});

test('one full-size tenant follows the profile distributions within 2 percentage points', () => {
  const p = resolveParams({ seed: 'unit-test', tenants: 1, skus: 20000, orders: 20000 });
  const n = 20000, statuses = {}, lines = { 1: 0, '2_3': 0, '4_10': 0, '11_20': 0 }, units = { small: 0, large: 0 };
  let lineTotal = 0;
  for (let j = 0; j < n; j++) {
    const o = orderPlan(p, 0, j);
    statuses[o.status] = (statuses[o.status] ?? 0) + 1;
    const l = o.lines.length;
    lines[l === 1 ? 1 : l <= 3 ? '2_3' : l <= 10 ? '4_10' : '11_20']++;
    for (const x of o.lines) { units[x.quantity <= 5 ? 'small' : 'large']++; lineTotal++; assert(x.quantity >= 1 && x.quantity <= 20); }
    assert.equal(new Set(o.lines.map((x) => x.index)).size, l, 'distinct products per order');
    if (j) assert(o.placed_at >= orderPlan(p, 0, j - 1).placed_at, 'placed_at grows with the index');
  }
  const pct = (v, total = n) => (100 * v) / total;
  for (const [s, w] of STATUS_WEIGHTS) assert(Math.abs(pct(statuses[s]) - w) <= 2, `${s} ${pct(statuses[s])}`);
  for (const [k, w] of [[1, 40], ['2_3', 40], ['4_10', 15], ['11_20', 5]]) assert(Math.abs(pct(lines[k]) - w) <= 2, `lines ${k}`);
  assert(Math.abs(pct(units.small, lineTotal) - 95) <= 2);
  const first = Date.parse(orderPlan(p, 0, 0).placed_at), last = Date.parse(orderPlan(p, 0, n - 1).placed_at);
  assert(Date.parse(p.asOf) - first > 179 * 86400000 && Date.parse(p.asOf) - last < 86400000, 'orders span the 180 days');
});

test('catalogue: kinds per 100 SKUs, exactly 100 hot SKUs at 20 units, stock covers every planned order', () => {
  const p = resolveParams({ seed: 'unit-test', tenants: 1, skus: 20000, orders: 20000 });
  const d = demand(p, 0), kinds = {};
  let hot = 0;
  for (let i = 0; i < 20000; i++) {
    const x = productPlan(p, 0, i, d);
    kinds[x.kind] = (kinds[x.kind] ?? 0) + 1;
    if (x.hot) { hot++; assert.equal(x.quantity, 20); assert(!d.has(i), 'historical orders never consume hot SKUs'); }
    else if (x.kind === 'simple' || x.kind === 'variant') assert(x.quantity >= (d.get(i) ?? 0) + 5);
    else assert.equal(x.quantity, 0);
    if (x.kind === 'variant') assert.equal(productBase(p, 0, x.parent).kind, 'group');
    if (x.kind === 'bundle') {
      // createProduct refuses a bundle without components; block 0 has only hot simple SKUs at this size → its variants
      assert(x.components.length >= 2, `bundle ${i} has components`);
      for (const c of x.components) { assert(c.index < i); assert.equal(productBase(p, 0, c.index).kind, i < 100 ? 'variant' : 'simple'); assert(!productBase(p, 0, c.index).hot); }
    }
    assert(/^2\d{12}$/.test(x.ean) && eanValid(x.ean), x.ean);
  }
  assert.deepEqual(kinds, { group: 400, variant: 1600, simple: 17600, bundle: 400 });
  assert.equal(hot, 100);
  assert.equal(hotCount(500), 50);
});

test('tenant, customer and order details are well-formed', () => {
  const p = resolveParams(small);
  const t = tenantPlan(p, 0);
  assert(nipValid(t.seller.tax_id), t.seller.tax_id);
  assert.match(t.seller.postal_code, /^\d{2}-\d{3}$/);
  assert.match(t.series.prefix, /^[A-Z0-9][A-Z0-9-]{0,11}$/);
  const c = customerPlan(p, 0, 3);
  assert.match(c.email, /^[a-z]+\.[a-z]+\.3@a\.scale\.example\.test$/);
  assert.match(c.address.postal_code, /^\d{2}-\d{3}$/);
  assert.match(c.address.phone, /^5\d{8}$/);
  assert.match(uuidFrom('x'), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(uuidFrom('a', 1), uuidFrom('a', 1));
  assert.notEqual(uuidFrom('a', 1), uuidFrom('a', 2));
  const r1 = stream('s', 1), r2 = stream('s', 1);
  assert.deepEqual([r1(), r1(), r1()], [r2(), r2(), r2()]);
});

test('order steps and transaction segments for every planned state', () => {
  const o = (status, extra = {}) => ({ status, ...extra });
  assert.deepEqual(orderSteps(o('draft')), ['create']);
  assert.deepEqual(orderSteps(o('picking')), ['create', 'pay', 'pick']);
  assert.deepEqual(orderSteps(o('cancelled', { cancel_from: 'paid' })), ['create', 'pay', 'cancel']);
  assert.deepEqual(orderSteps(o('cancelled', { cancel_from: 'new' })), ['create', 'cancel']);
  const ret = o('returned', { invoice: true, return: { line: 0, quantity: 1 } });
  assert.deepEqual(orderSteps(ret), ['create', 'pay', 'pick', 'scan', 'pack', 'ship', 'invoice', 'return_request', 'return_receive', 'return_refund']);
  assert.deepEqual(orderSegments(ret), { pre: ['create', 'pay', 'pick', 'scan', 'pack', 'ship'], invoice: ['invoice'], post: ['return_request', 'return_receive', 'return_refund'] });
  assert.deepEqual(orderSegments(o('shipped', { invoice: false })), { pre: ['create', 'pay', 'pick', 'scan', 'pack', 'ship'], invoice: [], post: [] });
});

test('checkpoint: atomic 0600 file, refuses another plan or database', () => {
  const dir = mkdtempSync(join(tmpdir(), 'scale-cp-')), path = join(dir, 'sub', 'cp.json');
  try {
    const cp = loadCheckpoint(path, { planSha256: 'a'.repeat(64), database: 'dynaminds_scale_20261025_99' });
    tenantProgress(cp, 'A').orders_next = 25;
    saveCheckpoint(path, cp);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(loadCheckpoint(path, { planSha256: 'a'.repeat(64), database: 'dynaminds_scale_20261025_99' }).tenants.A.orders_next, 25);
    assert.throws(() => loadCheckpoint(path, { planSha256: 'b'.repeat(64), database: 'dynaminds_scale_20261025_99' }), /innego planu/);
    assert.throws(() => loadCheckpoint(path, { planSha256: 'a'.repeat(64), database: 'dynaminds_scale_20261025_98' }), /dotyczy bazy/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('bundles are ordered at the planned share and their components carry the demand', () => {
  const p = resolveParams({ seed: 'unit-test', tenants: 1, skus: 20000, orders: 20000 });
  let lines = 0, bundleLines = 0;
  const expected = new Map();
  for (let j = 0; j < 20000; j++)
    for (const l of orderPlan(p, 0, j).lines) {
      lines++;
      if (productKind(l.index) !== 'bundle') { expected.set(l.index, (expected.get(l.index) ?? 0) + l.quantity); continue; }
      bundleLines++;
      const b = productBase(p, 0, l.index);
      assert(b.components.length >= 1);
      for (const c of b.components) expected.set(c.index, (expected.get(c.index) ?? 0) + c.quantity * l.quantity);
    }
  const share = (100 * bundleLines) / lines;
  assert(Math.abs(share - BUNDLE_LINE_PERCENT) <= 0.5, `bundle lines ${share.toFixed(2)} %`);
  assert.deepEqual(new Map([...demand(p, 0)].sort((a, b) => a[0] - b[0])), new Map([...expected].sort((a, b) => a[0] - b[0])));
  // Bundle orders stay in one warehouse with their components (the order's warehouse holds the stock).
  for (let j = 0; j < 2000; j++) {
    const o = orderPlan(p, 0, j);
    for (const l of o.lines) {
      const b = productBase(p, 0, l.index);
      assert.equal(b.warehouse, o.warehouse);
      for (const c of b.components ?? []) assert.equal(productBase(p, 0, c.index).warehouse, o.warehouse);
    }
  }
});

test('WMS lot plan: A/C/E only; opening (unknown/known cost) or two FIFO receipt waves (known/zero cost)', () => {
  const p = resolveParams({ seed: 'unit-test', tenants: 1, skus: 20000, orders: 20000 });
  const d = demand(p, 0);
  let stocked = 0, opening = 0, unknown = 0, receipts = 0, zero = 0, twoWaves = 0;
  for (let i = 0; i < 20000; i++) {
    const x = productPlan(p, 0, i, d);
    if (x.kind !== 'simple' && x.kind !== 'variant') { assert.equal(x.lots, undefined); continue; }
    stocked++;
    if (x.lots.opening) {
      assert(!x.hot); opening++;
      assert.equal(x.lots.opening.quantity, x.quantity);
      if (x.lots.opening.unit_cost_minor === null) unknown++; else assert.match(x.lots.opening.unit_cost_minor, /^[1-9]\d*$/);
      continue;
    }
    receipts++;
    const r = x.lots.receipts;
    assert.equal(r.reduce((s, y) => s + y.quantity, 0), x.quantity);
    assert.deepEqual(r.map((y) => y.wave), r.length === 2 ? [1, 2] : [1]);
    if (x.hot) assert.deepEqual(r.map((y) => y.quantity), [20]);
    else assert.equal(r[0].quantity, Math.ceil(x.quantity * 0.6));
    if (r.length === 2) twoWaves++;
    if (r[0].unit_cost_minor === '0') zero++;
    assert.equal(new Set(r.map((y) => y.lot_code)).size, r.length);
    for (const y of r) assert(y.expiry_date === null || /^\d{4}-\d{2}-\d{2}$/.test(y.expiry_date));
  }
  const pct = (a, b) => (100 * a) / b;
  assert(Math.abs(pct(opening, stocked - 100) - OPENING_PERCENT) <= 1, `opening ${pct(opening, stocked)}`);
  assert(Math.abs(pct(unknown, opening) - OPENING_UNKNOWN_COST_PERCENT) <= 5, `unknown ${pct(unknown, opening)}`);
  assert(Math.abs(pct(zero, receipts) - RECEIPT_ZERO_COST_PERCENT) <= 1, `zero ${pct(zero, receipts)}`);
  assert(twoWaves > receipts * 0.9, 'almost every receipt product gets a second, younger lot');
  const two = resolveParams({ seed: 'unit-test', tenants: 2, skus: 300, orders: 200 });
  assert.deepEqual(two.perTenant.map((t) => t.wms_lots), [true, false]);
  for (let i = 0; i < 150; i++) assert.equal(productPlan(two, 1, i, demand(two, 1)).lots, undefined, 'tenant B keeps WMS lots off');
});

test('PZ documents: each planned receipt exactly once, per wave and warehouse, at most 500 lines, stable', () => {
  const p = resolveParams({ seed: 'unit-test', tenants: 1, skus: 2000, orders: 2000 });
  const d = demand(p, 0), docs = receiptDocuments(p, 0, d), again = receiptDocuments(p, 0, d);
  assert.deepEqual(docs, again);
  const seen = new Map();
  let lastWave = 0;
  for (const doc of docs) {
    assert(doc.lines.length >= 1 && doc.lines.length <= 500);
    assert(doc.wave >= lastWave, 'wave 1 documents come before wave 2 (FIFO order of the layers)');
    lastWave = doc.wave;
    for (const l of doc.lines) {
      const k = `${l.index}:${doc.wave}`;
      assert(!seen.has(k)); seen.set(k, l.quantity);
      assert.equal(productBase(p, 0, l.index).warehouse, doc.warehouse);
    }
  }
  let planned = 0;
  for (let i = 0; i < 2000; i++) for (const r of productPlan(p, 0, i, d).lots?.receipts ?? []) { planned++; assert.equal(seen.get(`${i}:${r.wave}`), r.quantity); }
  assert.equal(seen.size, planned);
  assert(receiptDocuments(p, 0, d, 100).every((x) => x.lines.length <= 100));
});

test('simulated days: contiguous order ranges per day inside the window, offsets and the Node clock', () => {
  const p = resolveParams({ ...small, days: 7 });
  for (let t = 0; t < 2; t++) {
    const ranges = dayRanges(p, t, (j) => orderPlan(p, t, j).placed_at);
    assert.equal(ranges.length, 7);
    assert.deepEqual([ranges[0][0], ranges[6][1]], [0, p.perTenant[t].orders]);
    for (let k = 0; k < 7; k++) {
      if (k) assert.equal(ranges[k][0], ranges[k - 1][1]);
      const w = dayWindow(p, k);
      for (let j = ranges[k][0]; j < ranges[k][1]; j++) {
        const at = Date.parse(orderPlan(p, t, j).placed_at);
        assert(at >= w.from && at < w.to);
        assert.equal(dayOf(p, orderPlan(p, t, j).placed_at), k);
      }
      assert(ranges[k][1] - ranges[k][0] > 0, 'every day of a 7-day window has orders');
    }
  }
  assert.equal(dayWindow(p, 6).to, Date.parse(p.asOf));
  assert.equal(offsetSeconds(1_000_000, 1_500_000), -500);
  assert.equal(formatOffset(-15552000), '-15552000');
  assert.equal(formatOffset(0), '+0');
  assert.equal(parseOffset('-15552000\n'), -15552000);
  assert.equal(parseOffset('+12'), 12);
  assert.throws(() => parseOffset('@2026-01-01 00:00:00'), /format/);
  installNodeClock();
  try {
    const real = Date.now();
    setNodeOffset(-10 * 86400);
    assert(Math.abs(Date.now() - (real - 10 * DAY_MS)) < 5000);
    assert(Math.abs(new Date().getTime() - (real - 10 * DAY_MS)) < 5000);
    assert.equal(new Date('2026-01-02T03:04:05Z').toISOString(), '2026-01-02T03:04:05.000Z', 'explicit dates are untouched');
    assert(new Date() instanceof Date);
  } finally { setNodeOffset(0); }
});

function eanValid(e) {
  const d = e.split('').map(Number);
  return (d.slice(0, 12).reduce((s, x, k) => s + x * (k % 2 ? 3 : 1), 0) + d[12]) % 10 === 0;
}
function nipValid(n) {
  const w = [6, 5, 7, 2, 3, 4, 5, 6, 7], d = n.split('').map(Number);
  return d.length === 10 && w.reduce((s, x, k) => s + x * d[k], 0) % 11 === d[9];
}
// v1 '7823f4b7…0e06dce' → v2 (26.10.2026): order lines may sell bundles (2 %, new draws shift every later
// order), component demand raises opening quantities, and lot tenant A gains its WMS lot plan.
const PINNED_SMALL = '5a002cb1eacab292b86897000f83a9d0ec9593e3012fb6ca1697c4f8e083247e';
