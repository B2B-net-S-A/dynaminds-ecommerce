// Pure, deterministic plan of the scale dataset. No database access here: the writer turns
// these records into ordinary domain calls. Distributions follow docs/parity/acceptance-profile.v1.json.
import { createHash } from 'node:crypto';
import { stream, int, pick, weighted, uuidFrom } from './prng.mjs';
import { FIRST_NAMES, LAST_NAMES, CITIES, STREETS, CATEGORIES, ADJECTIVES } from './vocabulary.mjs';

// v2 (26.10.2026): bundle order lines (2 %, their components carry the demand) and the WMS lot plan
// of A/C/E (opening stock with unknown/known cost, two FIFO receipt waves with known/zero cost).
export const PLAN_VERSION = 'dyna-scale-plan/v2';
export const FULL = Object.freeze({ tenants: 5, skus: 100000, orders: 100000, days: 180 });
export const DEFAULT_SEED = 'dyna-scale-20261025';
export const DEFAULT_AS_OF = '2026-10-25T00:00:00.000Z';
export const SLOTS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
/** Profile slots A, C, E carry WMS lots; the writer reports whether it could apply this. */
export const WMS_LOTS = Object.freeze({ A: true, B: false, C: true, D: false, E: true });
export const STATUS_WEIGHTS = [['draft', 10], ['confirmed', 15], ['picking', 15], ['packed', 10], ['shipped', 40], ['cancelled', 5], ['returned', 5]];
export const LINE_BUCKETS = [[[1, 1], 40], [[2, 3], 40], [[4, 10], 15], [[11, 20], 5]];
export const UNIT_BUCKETS = [[[1, 5], 95], [[6, 20], 5]];
/** Share of order lines that sell a bundle (same as the bundle share of the catalogue). */
export const BUNDLE_LINE_PERCENT = 2;
/** WMS lot tenants: share of stocked non-hot SKUs whose opening stock is taken over at the WMS opening
 * (legacy stock before the policy, lot origin "opening"); the rest arrives through PZ receipts. */
export const OPENING_PERCENT = 5;
export const OPENING_UNKNOWN_COST_PERCENT = 70;
export const RECEIPT_ZERO_COST_PERCENT = 5;
export const FIRST_WAVE_SHARE = 0.6;
export const WAREHOUSES_PER_TENANT = 2;
export const LOCATIONS_PER_WAREHOUSE = 20;
const DAY_MS = 86_400_000;
const BLOCK = 100; // per 100 SKUs: 2 groups (variant parents), 8 variants, 88 simple, 2 bundles (last, after their components)
const SIMPLE_FROM = 10, SIMPLE_TO = 98;

const positive = (name, v) => {
  if (!Number.isInteger(v) || v < 1) throw new Error(`--${name} musi być dodatnią liczbą całkowitą (jest: ${v})`);
  return v;
};
const split = (total, parts) => Array.from({ length: parts }, (_, i) => Math.floor(total / parts) + (i < total % parts ? 1 : 0));

/** Explicit --tenants/--skus/--orders/--days win over --scale-factor (which scales the full profile). */
export function resolveParams(input = {}) {
  const sf = input.scaleFactor ?? 1;
  if (!(typeof sf === 'number' && sf > 0 && sf <= 1)) throw new Error('--scale-factor musi być w (0, 1]');
  const tenants = positive('tenants', input.tenants ?? Math.max(2, Math.min(FULL.tenants, Math.round(FULL.tenants * sf))));
  if (tenants > SLOTS.length) throw new Error(`Najwyżej ${SLOTS.length} firm`);
  const skus = positive('skus', input.skus ?? Math.round(FULL.skus * sf));
  const orders = positive('orders', input.orders ?? Math.round(FULL.orders * sf));
  const days = positive('days', input.days ?? FULL.days);
  const seed = String(input.seed ?? DEFAULT_SEED);
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(seed)) throw new Error('--seed: 1–64 znaki A-Z a-z 0-9 . _ -');
  const asOf = new Date(input.asOf ?? DEFAULT_AS_OF);
  if (Number.isNaN(asOf.getTime())) throw new Error('--as-of nie jest datą');
  const skuSplit = split(skus, tenants), orderSplit = split(orders, tenants);
  const tag = createHash('sha256').update(seed).digest('hex').slice(0, 8);
  const perTenant = skuSplit.map((s, i) => {
    if (s < BLOCK) throw new Error(`Firma ${SLOTS[i]} ma ${s} SKU; minimum ${BLOCK} na firmę`);
    return { slot: SLOTS[i], skus: s, orders: orderSplit[i], wms_lots: WMS_LOTS[SLOTS[i]] ?? false };
  });
  return Object.freeze({ version: PLAN_VERSION, seed, tag, tenants, skus, orders, days, scaleFactor: sf, asOf: asOf.toISOString(), perTenant });
}

// ---- tenants -------------------------------------------------------------------------------
function nip(r) {
  const w = [6, 5, 7, 2, 3, 4, 5, 6, 7];
  for (;;) {
    const d = [int(r, 1, 9), ...Array.from({ length: 8 }, () => int(r, 0, 9))];
    const sum = d.reduce((s, x, i) => s + x * w[i], 0) % 11;
    if (sum !== 10) return d.join('') + sum;
  }
}
export function tenantPlan(p, t) {
  const { slot } = p.perTenant[t];
  const r = stream(p.seed, 'tenant', slot);
  return {
    slot,
    name: `SCALE ${p.tag} firma ${slot}`,
    owner: { email: `scale-${p.tag}-${slot.toLowerCase()}@scale.example.test`, name: `Właściciel skali ${slot}` },
    second_warehouse: { name: `Magazyn zapasowy ${slot}`, code: `ZAP-${slot}` },
    seller: { name: `Firma skali ${slot} ${p.tag} sp. z o.o.`, street: `${pick(r, STREETS)} ${int(r, 1, 120)}`, ...cityOf(r), tax_id: nip(r) },
    series: { client_key: uuidFrom(p.seed, 'series', slot), prefix: `S${p.tag.slice(0, 4).toUpperCase()}${slot}` },
    wms_lots: p.perTenant[t].wms_lots,
  };
}
function cityOf(r) {
  const [city, postal] = pick(r, CITIES);
  return { postal_code: postal + String(int(r, 0, 999)).padStart(3, '0'), city, country: 'PL' };
}

// ---- products ------------------------------------------------------------------------------
export function productKind(i) {
  const pos = i % BLOCK;
  return pos < 2 ? 'group' : pos < SIMPLE_FROM ? 'variant' : pos < SIMPLE_TO ? 'simple' : 'bundle';
}
const simpleRank = (i) => Math.floor(i / BLOCK) * (SIMPLE_TO - SIMPLE_FROM) + (i % BLOCK) - SIMPLE_FROM;
export const hotCount = (skus) => Math.min(100, Math.floor(skus / 10));
export const isHot = (i, skus) => productKind(i) === 'simple' && simpleRank(i) < hotCount(skus);
/** Products that ordinary historical orders draw from: stock-keeping, non-hot. */
const sellable = (i, skus) => (productKind(i) === 'variant' || productKind(i) === 'simple') && !isHot(i, skus);
const bundleIndices = (block, skus) => [block + SIMPLE_TO, block + SIMPLE_TO + 1].filter((i) => i < skus && productKind(i) === 'bundle');
const warehouseOf = (i) => (Math.floor(i / BLOCK) % 5 === 4 ? 1 : 0);
export const skuOf = (slot, i) => `SC-${slot}-${String(i).padStart(6, '0')}`;
function ean13(slotIndex, i) {
  const body = '2' + String(slotIndex % 10) + String(i).padStart(10, '0');
  const sum = body.split('').reduce((s, d, k) => s + Number(d) * (k % 2 ? 3 : 1), 0);
  return body + ((10 - (sum % 10)) % 10);
}
const PRICE_BUCKETS = [[[999, 4999], 35], [[5000, 19999], 40], [[20000, 99999], 20], [[100000, 399999], 5]];
const VAT = [[23, 85], [8, 10], [5, 5]];

/** Base attributes of product i, without the demand-derived opening quantity. */
export function productBase(p, t, i) {
  const { slot, skus } = p.perTenant[t];
  const r = stream(p.seed, 'product', slot, i);
  const kind = productKind(i), [category, nouns] = pick(r, CATEGORIES);
  const block = Math.floor(i / BLOCK) * BLOCK, w = warehouseOf(i);
  const base = {
    index: i, sku: skuOf(slot, i), kind, warehouse: w,
    name: `${pick(r, ADJECTIVES)} ${pick(r, nouns)} ${String.fromCharCode(65 + int(r, 0, 25))}${int(r, 10, 999)}`,
    ean: ean13(t, i), category,
    price: Math.round(int(r, ...weighted(r, PRICE_BUCKETS)) / 10) * 10 - 1,
    vat: weighted(r, VAT),
    location: `${w ? 'B' : 'A'}-${String(1 + (i % LOCATIONS_PER_WAREHOUSE)).padStart(2, '0')}`,
    hot: isHot(i, skus),
  };
  if (kind === 'variant') base.parent = block + ((i % BLOCK) < 6 ? 0 : 1);
  if (kind === 'bundle') {
    const n = int(r, 2, 3), comps = new Set();
    for (let k = 0; k < 40 && comps.size < n; k++) {
      const c = block + int(r, SIMPLE_FROM, SIMPLE_TO - 1);
      if (c < skus && !isHot(c, skus)) comps.add(c);
    }
    // From 880 SKUs per tenant on, every simple SKU of block 0 is hot (hotCount 88–100), and a bundle without
    // components is refused by createProduct ("Zestaw wymaga składników"). Such a bundle takes the block's
    // variants (stocked, never hot) instead. Only that case draws more numbers, so smaller plans keep their digest.
    if (comps.size === 0) while (comps.size < n) comps.add(block + int(r, 2, SIMPLE_FROM - 1));
    base.components = [...comps].sort((a, b) => a - b).map((c) => ({ index: c, quantity: int(r, 1, 3) }));
  }
  return base;
}

// ---- customers -----------------------------------------------------------------------------
export const customerCount = (orders) => Math.max(1, Math.ceil(orders / 2.5));
const ascii = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ł/g, 'l').replace(/Ł/g, 'L').toLowerCase();
export function customerPlan(p, t, c) {
  const { slot } = p.perTenant[t];
  const r = stream(p.seed, 'customer', slot, c);
  const first = pick(r, FIRST_NAMES), last = pick(r, LAST_NAMES);
  return {
    index: c, name: `${first} ${last}`,
    email: `${ascii(first)}.${ascii(last)}.${c}@${slot.toLowerCase()}.scale.example.test`,
    address: { street: `${pick(r, STREETS)} ${int(r, 1, 200)}${r() < 0.4 ? '/' + int(r, 1, 80) : ''}`, ...cityOf(r), phone: '5' + String(int(r, 0, 99999999)).padStart(8, '0') },
  };
}

// ---- orders --------------------------------------------------------------------------------
const eligibleCache = new Map();
/** [sellable by warehouse, bundles with at least one component by warehouse] */
function eligible(p, t) {
  const key = `${p.seed}|${p.perTenant[t].slot}|${p.perTenant[t].skus}`;
  let e = eligibleCache.get(key);
  if (!e) {
    const { skus } = p.perTenant[t];
    e = [[[], []], [[], []]];
    for (let i = 0; i < skus; i++) if (sellable(i, skus)) e[0][warehouseOf(i)].push(i);
    for (let b = 0; b < skus; b += BLOCK)
      for (const i of bundleIndices(b, skus)) if (productBase(p, t, i).components.length) e[1][warehouseOf(i)].push(i);
    eligibleCache.set(key, e);
  }
  return e;
}
export function orderPlan(p, t, j) {
  const { slot, orders } = p.perTenant[t];
  const r = stream(p.seed, 'order', slot, j);
  const status = weighted(r, STATUS_WEIGHTS);
  const [pools, bundlePools] = eligible(p, t), wanted = weighted(r, [[0, 80], [1, 20]]);
  const warehouse = pools[wanted].length ? wanted : 1 - wanted; // tiny plans may have no SKU in the second warehouse
  const pool = pools[warehouse], bundles = bundlePools[warehouse];
  const lineCount = Math.min(pool.length, int(r, ...weighted(r, LINE_BUCKETS)));
  const chosen = new Set();
  for (let guard = 0; chosen.size < lineCount && guard < 64 * lineCount; guard++) {
    const bundle = bundles.length > 0 && r() * 100 < BUNDLE_LINE_PERCENT;
    const from = bundle ? bundles : pool;
    chosen.add(from[Math.floor(r() * from.length)]);
  }
  const lines = [...chosen].map((index) => ({ index, quantity: int(r, ...weighted(r, UNIT_BUCKETS)) }));
  const span = p.days * DAY_MS, start = Date.parse(p.asOf) - span;
  const o = {
    index: j, key: `scale:${p.tag}:${slot}:${j}`,
    customer: Math.floor(customerCount(orders) * r() ** 1.6),
    warehouse, status, lines,
    shipping_cost: weighted(r, [[0, 20], [999, 25], [1299, 25], [1499, 20], [1899, 10]]),
    placed_at: new Date(start + Math.floor(((j + r()) / orders) * span)).toISOString(),
  };
  if (status === 'cancelled') o.cancel_from = weighted(r, [['new', 60], ['paid', 40]]);
  if (status === 'shipped' || status === 'returned') o.invoice = status === 'returned' || r() < 0.8;
  if (status === 'returned') o.return = { line: 0, quantity: int(r, 1, lines[0].quantity) };
  return o;
}
/** Ordinary steps that bring a new order to its planned state, in order. */
export function orderSteps(o) {
  const to = { draft: [], confirmed: ['pay'], picking: ['pay', 'pick'], packed: ['pay', 'pick', 'scan', 'pack'],
    shipped: ['pay', 'pick', 'scan', 'pack', 'ship'], returned: ['pay', 'pick', 'scan', 'pack', 'ship'],
    cancelled: o.cancel_from === 'paid' ? ['pay', 'cancel'] : ['cancel'] }[o.status];
  const steps = ['create', ...to];
  if (o.invoice) steps.push('invoice');
  if (o.return) steps.push('return_request', 'return_receive', 'return_refund');
  return steps;
}

/** Units each stock-keeping product needs over all planned orders (cancelled orders reserve before
 * release); a bundle line needs its components' quantities. */
export function demand(p, t) {
  const d = new Map(), add = (i, q) => d.set(i, (d.get(i) ?? 0) + q), comps = new Map();
  for (let j = 0; j < p.perTenant[t].orders; j++)
    for (const l of orderPlan(p, t, j).lines) {
      if (productKind(l.index) !== 'bundle') { add(l.index, l.quantity); continue; }
      if (!comps.has(l.index)) comps.set(l.index, productBase(p, t, l.index).components);
      for (const c of comps.get(l.index)) add(c.index, c.quantity * l.quantity);
    }
  return d;
}
/** Product with its opening quantity: planned demand plus a buffer; hot SKUs open at exactly 20. */
export function productPlan(p, t, i, demandMap) {
  const b = productBase(p, t, i);
  const stocked = b.kind === 'simple' || b.kind === 'variant';
  const buffer = int(stream(p.seed, 'buffer', p.perTenant[t].slot, i), 5, 40);
  const pp = { ...b, quantity: !stocked ? 0 : b.hot ? 20 : (demandMap.get(i) ?? 0) + buffer };
  if (p.perTenant[t].wms_lots && stocked) pp.lots = lotPlan(p, t, pp);
  return pp;
}
const unitCost = (price) => String(Math.max(1, Math.round(price * 0.55)));
/** How a lot tenant's stock arrives: either opening stock (one lot, cost unknown or known) or PZ waves
 * (wave 1 holds FIRST_WAVE_SHARE, wave 2 the rest; FIFO sells wave 1 first). Hot SKUs: one PZ lot of 20. */
export function lotPlan(p, t, pp) {
  const { slot } = p.perTenant[t];
  const r = stream(p.seed, 'lots', slot, pp.index);
  const code = (w) => `L${p.tag.slice(0, 4).toUpperCase()}${slot}-${pp.index}-${w}`;
  const expiry = r() < 0.3 ? new Date(Date.parse(p.asOf) + int(r, 90, 720) * DAY_MS).toISOString().slice(0, 10) : null;
  if (!pp.hot && r() * 100 < OPENING_PERCENT)
    return { opening: { quantity: pp.quantity, lot_code: code(0), unit_cost_minor: r() * 100 < OPENING_UNKNOWN_COST_PERCENT ? null : unitCost(pp.price) } };
  const cost = r() * 100 < RECEIPT_ZERO_COST_PERCENT ? '0' : unitCost(pp.price);
  const first = pp.hot ? pp.quantity : Math.ceil(pp.quantity * FIRST_WAVE_SHARE);
  const receipts = [{ wave: 1, quantity: first, lot_code: code(1), unit_cost_minor: cost, expiry_date: expiry }];
  if (pp.quantity - first > 0) receipts.push({ wave: 2, quantity: pp.quantity - first, lot_code: code(2), unit_cost_minor: cost, expiry_date: expiry });
  return { receipts };
}

/** SHA-256 over the canonical JSON of every planned record, plus per-section digests. */
export function planDigest(p) {
  const all = createHash('sha256'), sections = {};
  const section = (name, rows) => {
    const h = createHash('sha256');
    let n = 0;
    for (const row of rows) { const line = JSON.stringify(row) + '\n'; h.update(line); all.update(name + '\t' + line); n++; }
    sections[name] = { rows: n, sha256: h.digest('hex') };
  };
  section('params', [p]);
  p.perTenant.forEach((pt, t) => {
    const d = demand(p, t);
    section(`tenant:${pt.slot}`, [tenantPlan(p, t)]);
    section(`products:${pt.slot}`, (function* () { for (let i = 0; i < pt.skus; i++) yield productPlan(p, t, i, d); })());
    section(`customers:${pt.slot}`, (function* () { for (let c = 0; c < customerCount(pt.orders); c++) yield customerPlan(p, t, c); })());
    section(`orders:${pt.slot}`, (function* () { for (let j = 0; j < pt.orders; j++) yield orderPlan(p, t, j); })());
  });
  return { sha256: all.digest('hex'), sections };
}
