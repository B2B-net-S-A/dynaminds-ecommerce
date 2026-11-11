#!/usr/bin/env node
// Curated demo company for the client demo (tools/demo/demo.sh seed). Runs inside the packaged release
// (tools/scale/release-runtime.mjs: real migrate(), cold validation, schema gate) in the demo PostgreSQL container's
// network namespace, and writes ONLY through the ordinary HTTP routes (app.inject with the session cookie): no SQL
// writes, so every guard and trigger applies as in ordinary use.
//
// History: the demo PostgreSQL preloads libfaketime (tools/scale/docker). The seeder moves the database clock and this
// process' Date together (tools/scale/simclock.mjs) through ~4.5 weeks (28.09–29.10.2026), so orders, payments,
// shipments, invoices, KSeF numbers, receipts and returns carry their business day. At the end the clock is real again.
// The fakes (tools/demo/fakes.mts: KSeF, fiscal printer) follow the same offset file.
//
// Test passwords are generated here and written only to $DEMO_ROOT/private/credentials.json and
// tools/demo/CREDENTIALS.local.md (both 0600, gitignored / outside the repository); never printed.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { installNodeClock, setSimulatedTime, acquireClockLock, writeOffsetFile, setNodeOffset, realIso } from '../scale/simclock.mjs';
import { clockProbe } from '../scale/inspect.mjs';
import { openReleaseRuntime } from '../scale/release-runtime.mjs';
import { Client, injectTransport, key, nipFrom, ean13, prng } from './lib.mjs';
import { demoGuards } from './guards.mjs';
import { seedAllegroOrders } from './seed-allegro.mjs';
import { seedCustomStatuses } from './seed-statuses.mjs';

const ENV = process.env;
for (const k of ['DATABASE_URL', 'DYNA_LOCAL_CONFIG_PATH', 'DEMO_ROOT', 'DEMO_RELEASE', 'DEMO_FAKETIME_FILE', 'DEMO_KSEF_PORT', 'DEMO_PRINTER_PORT'])
  if (!ENV[k]) throw new Error('missing env ' + k);
if (!/\/dynaminds_demo$/.test(new URL(ENV.DATABASE_URL).pathname)) throw new Error('seed writes only to dynaminds_demo');
const ROOT = ENV.DEMO_ROOT, FAKETIME = ENV.DEMO_FAKETIME_FILE;
const CAT = JSON.parse(readFileSync(new URL('./catalog.json', import.meta.url), 'utf8'));
const rand = prng(20261030);
const pick = (a) => a[Math.floor(rand() * a.length)];
const between = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
const t0 = performance.now();
const log = (...m) => console.log(`[${((performance.now() - t0) / 1000).toFixed(0)}s ${new Date().toISOString().slice(0, 16)}]`, ...m);
const summary = { started_at: realIso(), counts: {}, warnings: [] };
const count = (k, n = 1) => { summary.counts[k] = (summary.counts[k] ?? 0) + n; };
const warn = (what, e) => { const m = `${what}: ${String(e?.message ?? e).slice(0, 400)}`; summary.warnings.push(m); log('WARN', m); };

// ---- simulated time (Europe/Warsaw business hours) -----------------------------------------------------------------
const DAY0 = '2026-09-28', DAYS = 32; // 28.09 (Mon) … 29.10 (Thu); 30.10 = the demo day, real time
const offsetH = (date) => (date >= '2026-10-25' ? 1 : 2); // CEST → CET on 25.10.2026
const dateOf = (k) => new Date(Date.parse(DAY0 + 'T12:00:00Z') + k * 86400000).toISOString().slice(0, 10);
const at = (date, h, m = 0) => Date.parse(`${date}T00:00:00Z`) + ((h - offsetH(date)) * 60 + m) * 60000;
const END = at(dateOf(DAYS - 1), 18, 30);
const warsawDay = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Warsaw' }).format(new Date());
installNodeClock();
const unlock = acquireClockLock(FAKETIME);
let clockMoves = 0;
async function moveTo(ms, force = false) {
  if (!force && ms <= Date.now() + 10 * 60000) return; // within 10 min: run now (time only moves forward)
  await setSimulatedTime({ file: FAKETIME, targetMs: ms, probe: () => clockProbe(ENV.DATABASE_URL) });
  clockMoves++;
}
// A hung step must end the run with its name, not stay silent (30.10: one run stalled for an hour).
const withWatchdog = (work, what, ms = 180000) => { let t; return Promise.race([work, new Promise((_, rej) => { t = setTimeout(() => rej(new Error('no answer in ' + ms / 1000 + ' s: ' + what)), ms); })]).finally(() => clearTimeout(t)); };
const backToReal = async () => { writeOffsetFile(FAKETIME, 0); setNodeOffset(0); await new Promise((r) => setTimeout(r, 2200)); };

var rt;
try {
  await moveTo(at(DAY0, 7, 0), true); // back to the first day of the history
  log('clock', new Date().toISOString(), '→ opening the release runtime');
  rt = await openReleaseRuntime({ buildRecord: ENV.DEMO_RELEASE, connections: 4 });
  // libfaketime: the first time call of a kept backend after a jump can still return the old day (a 157 preview got
  // expires_at 20 min before its issue, 30.10). Idle sessions close at once, so every request gets a new backend.
  rt.db.pool.options.idleTimeoutMillis = 1;
  log('release', rt.release.commit, rt.release.release_manifest_sha256.slice(0, 12));
  await seed(rt);
  summary.finished_at = realIso();
} finally {
  await backToReal();
  unlock();
  if (rt) await rt.close();
}
summary.clock_moves = clockMoves;
const guards = await demoGuards(ENV.DATABASE_URL);
summary.guards = guards;
writeFileSync(ROOT + '/private/seed-summary.json', JSON.stringify(summary, null, 1) + '\n', { mode: 0o600 });
log('counts', JSON.stringify(summary.counts));
log('warnings', summary.warnings.length, 'guards all true:', guards.all_true);
if (!guards.all_true) { console.error(JSON.stringify(guards.values)); process.exit(1); }

// =====================================================================================================================
async function seed(rt) {
  const T = injectTransport(rt.app);
  const users = Object.fromEntries(CAT.users.map((u) => [u.key, { ...u, password: randomBytes(18).toString('base64url') }]));
  const owner = new Client(T), wh = new Client(T);
  const logins = new Map();
  async function fresh(c, u) { // sessions live 8 h of (simulated) time
    if (Date.now() - (logins.get(c) ?? 0) < 6 * 3600000) return c;
    await c.login(u.email, u.password); logins.set(c, Date.now()); return c;
  }
  const O = () => fresh(owner, users.owner), M = () => fresh(wh, users.warehouse);

  // ---- company, users, warehouses ----------------------------------------------------------------------------------
  await owner.post('/api/auth/signup', { email: users.owner.email, name: users.owner.name, password: users.owner.password,
    organization: { name: CAT.company.name, currency: 'PLN', locale: 'pl-PL' } }, [201]);
  logins.set(owner, Date.now());
  await owner.patch('/api/workspaces/plan', { plan: 'enterprise' });
  for (const u of [users.warehouse, users.accounting]) {
    const inv = await owner.post('/api/workspaces/invitations', { email: u.email, role: u.role }, [201]);
    const c = new Client(T);
    await c.post('/api/auth/signup', { email: u.email, name: u.name, password: u.password, invitation_token: inv.token }, [201]);
  }
  writeCredentials(users);
  await owner.post('/api/warehouses', { name: CAT.warehouses[1].name, code: CAT.warehouses[1].code });
  const whs = (await owner.get('/api/warehouses')).data;
  const MAIN = whs.find((w) => w.code === 'MAIN').id, ZGI = whs.find((w) => w.code === CAT.warehouses[1].code).id;
  summary.tenant_id = (await owner.get('/api/auth/me')).user?.tenant_id;
  log('company', CAT.company.name, 'users', Object.keys(users).length);

  // ---- documents setup: invoice series, KSeF (local fake), fiscal printer (local fake) ----------------------------
  const sellerNip = nipFrom(prng(4711));
  const series = (await owner.post('/api/local-invoices/series', { client_key: key(), name: 'Faktury sprzedaży', prefix: CAT.company.series_prefix,
    seller: { name: CAT.company.name, street: CAT.company.street, postal_code: CAT.company.postal_code, city: CAT.company.city, country: 'PL', tax_id: sellerNip },
    payment_terms_days: 7, payment_instructions: CAT.company.payment_instructions, notes: 'Dziękujemy za zakupy w Pracowni Smaków!', seller_vat_status: 'active_domestic' })).series;
  await owner.put('/api/ksef229/configs/' + sellerNip, { environment: 'local_fake', base_url: `http://127.0.0.1:${ENV.DEMO_KSEF_PORT}/v2`, auth_method: 'token',
    token: 'demo-lokalny-' + randomBytes(12).toString('hex') });
  const kc = await owner.post(`/api/ksef229/configs/${sellerNip}/check`);
  if (!kc.ok) throw new Error('KSeF fake check failed ' + JSON.stringify(kc).slice(0, 300));
  await owner.put('/api/receipt233/printer', { name: 'Kasa fiskalna — biuro Łódź', model_family: 'posnet', host: '127.0.0.1', port: Number(ENV.DEMO_PRINTER_PORT), unique_number: 'DMO26103001' });
  const pt = await owner.post('/api/receipt233/printer/test', {});
  if (!pt.ok) throw new Error('printer test failed ' + JSON.stringify(pt).slice(0, 300));
  summary.seller_nip = sellerNip;
  // Carrier channels in their local simulation mode (no provider account, no external call); InPost is used for parcels.
  for (const p of ['/api/dpd-shipping/example', '/api/dhl-shipping/example', '/api/pocztapolska-shipping/example'])
    try { await owner.post(p, {}); count('carrier_simulations'); } catch (e) { warn('carrier example ' + p, e); }

  // ---- catalogue with pictures, opening stock with lots ---------------------------------------------------------------
  const P = {};
  const imgDir = ROOT + '/private/product-images';
  const images = new Set(readdirSync(imgDir));
  for (const [i, p] of CAT.products.entries()) {
    let imgs = [];
    if (images.has(p.sku + '.jpg')) imgs = [(await owner.post('/api/product-images', { data: readFileSync(`${imgDir}/${p.sku}.jpg`).toString('base64') }, [201])).url];
    const opening = Math.round(p.qty * 0.6);
    P[p.sku] = { ...p, opening, ...(await owner.post('/api/products', { name: p.name, sku: p.sku, ean: ean13('590' + String(612340000 + i * 7)), price: p.price, vat: p.vat,
      category: p.category, description: p.description, images: imgs, warehouse_id: MAIN, quantity: opening, location: p.location, weight_grams: p.weight_grams,
      manufacturer: p.manufacturer, tags: [p.category.toLowerCase()] }, [201])) };
    count('products');
  }
  const prods = Object.values(P);
  await moveTo(at(DAY0, 7, 40));
  let pol = (await owner.get('/api/wms-lots')).policy;
  const scope = await owner.get('/api/wms-lots/opening-scope');
  const bySku = new Map(prods.map((p) => [p.id, p]));
  const opv = (await owner.post('/api/wms-lots/opening-previews', { client_key: key(), policy_version: String(pol.version), currency: 'PLN',
    note: 'Otwarcie magazynu z partiami — stan z inwentaryzacji 27.09.2026', lines: scope.data.map((b) => ({ warehouse_id: b.warehouse_id, product_id: b.product_id,
      location: b.location, quantity: b.quantity, stock_version: String(b.stock_version), lot_code: bySku.get(b.product_id).lot, unit_cost_minor: String(bySku.get(b.product_id).cost) })) }, [201])).preview;
  if (!opv.ready) throw new Error('WMS opening not ready');
  await owner.post(`/api/wms-lots/opening-previews/${opv.id}/activate`, { client_key: key(), scope_hash: opv.scope_hash, confirmed: true }, [201]);
  log('WMS lots on, opening lines', scope.data.length);

  const stockVersion = async (w, p) => { const j = await (await O()).get(`/api/inventory?warehouse_id=${w}&product_id=${p}`); return j.data?.[0]?.version != null ? String(j.data[0].version) : '0'; };
  async function pz(w, lines, note, lotSuffix, costUp = 1) {
    pol = (await (await O()).get('/api/wms-lots')).policy;
    const sv = []; for (const l of lines) sv.push({ warehouse_id: w, product_id: l.p.id, version: await stockVersion(w, l.p.id) });
    const today = warsawDay();
    await owner.post('/api/wms-lots/receipts', { client_key: key(), policy_version: String(pol.version), warehouse_id: w, stock_versions: sv, note, confirmed: true,
      lines: lines.map((l) => ({ product_id: l.p.id, location: w === MAIN ? l.p.location : 'Z-' + l.p.location.slice(0, 4), quantity: l.q,
        lot_code: l.p.lot.replace(/^([A-Z])\d{4}/, `$1${today.slice(2, 4)}${today.slice(5, 7)}`) + lotSuffix, unit_cost_minor: String(Math.round(l.p.cost * costUp)), currency: 'PLN',
        ...(l.p.expiry_days ? { expiry_date: new Date(Date.now() + l.p.expiry_days * 86400000).toISOString().slice(0, 10) } : {}) })) }, [201]);
    count('wms_receipts'); count('wms_receipt_lines', lines.length);
  }
  await moveTo(at(DAY0, 8, 30));
  await pz(MAIN, prods.map((p) => ({ p, q: p.qty - p.opening })), 'PZ: dostawa startowa od dostawców (kawa, miody, przetwory, akcesoria)', '-A');
  await pz(ZGI, prods.filter((p) => ['Miody', 'Przetwory', 'Kawa'].includes(p.category)).map((p) => ({ p, q: Math.round(p.qty / 3) })), 'PZ: zapas sezonowy — Magazyn Zgierz', '-Z');

  // B2B customers in CRM (optional module; refusal is recorded, not fatal).
  const B2B = CAT.businesses.map((b, i) => ({ ...b, nip: nipFrom(prng(9000 + i)) }));
  for (const b of B2B) {
    try { await owner.post('/api/crm/clients', { client_key: key(), email: b.email, phone: b.phone, invoice_company: b.name, invoice_address: b.street, invoice_postcode: b.postal_code,
      invoice_city: b.city, invoice_country_code: 'PL', invoice_tax_id: b.nip, delivery_company: b.name, delivery_address: b.street, delivery_postcode: b.postal_code, delivery_city: b.city,
      delivery_country_code: 'PL', notes: 'Klient hurtowy (HoReCa), faktura VAT z NIP, płatność przelewem.' }, [200, 201]); count('crm_clients'); } catch (e) { warn('CRM client ' + b.name, e); }
  }

  // ---- order plan ---------------------------------------------------------------------------------------------------
  const plan = [];
  // Stock on MAIN available by day k (opening + PZ waves below, minus the MM transfer and the damage), with a margin:
  // an order line that would cross it is left out, so no planned order meets "Za mało towaru".
  const supply = (p, k) => Math.floor(0.85 * (p.qty + (k >= 9 && ['Kawa', 'Miody', 'Przetwory'].includes(p.category) ? Math.round(p.qty * 0.4) : 0)
    + (k >= 18 && p.category !== 'Książki' ? Math.round(p.qty * 0.35) : 0) + (k >= 25 && ['Kawa', 'Herbata', 'Akcesoria'].includes(p.category) ? Math.round(p.qty * 0.3) : 0)
    - (p.sku === 'PS-MIO-001' ? 12 : 0) - (p.sku === 'PS-PRZ-001' ? 1 : 0)));
  const used = new Map();
  const consumers = CAT.customers.map((c) => ({ ...c, email: c.name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ł/g, 'l').replace(/\s+/g, '.') + '@example.com' }));
  for (let k = 0; k < DAYS; k++) {
    const date = dateOf(k), dow = new Date(date + 'T12:00:00Z').getUTCDay(), weekend = dow === 0 || dow === 6;
    const n = k === DAYS - 1 ? 7 : weekend ? between(2, 3) : between(4, 7);
    for (let j = 0; j < n; j++) {
      const b2b = !weekend && rand() < 0.12;
      const hour = b2b ? between(8, 15) : between(7, 21);
      const lines = [];
      const pool = b2b ? prods.filter((p) => ['Kawa', 'Herbata', 'Miody', 'Przetwory', 'Oliwy i octy'].includes(p.category)) : prods;
      for (let l = 0, nl = b2b ? between(2, 4) : between(1, 3); l < nl; l++) {
        const p = pick(pool); if (lines.some((x) => x.p === p)) continue;
        const q = b2b ? between(4, 10) : (rand() < 0.75 ? 1 : 2);
        if ((used.get(p.sku) ?? 0) + q > supply(p, k)) continue;
        used.set(p.sku, (used.get(p.sku) ?? 0) + q);
        lines.push({ p, q });
      }
      if (!lines.length) continue;
      plan.push({ k, date, created: at(date, hour, between(0, 59)), b2b, buyer: b2b ? pick(B2B) : pick(consumers), lines,
        locker: !b2b && rand() < 0.55, method: b2b ? 'bank_transfer' : pick(['card', 'card', 'other', 'bank_transfer']) });
    }
  }
  plan.sort((a, b) => a.created - b.created);
  // Business outcomes (deterministic): a few unpaid → cancelled, documents by buyer, returns on older FV-S orders.
  const consumerIdx = plan.map((o, i) => (o.b2b ? -1 : i)).filter((i) => i >= 0);
  for (const i of consumerIdx) plan[i].doc = rand() < 0.42 ? 'fv' : rand() < 0.55 ? 'receipt' : 'fvs';
  for (const o of plan) if (o.b2b) o.doc = 'fvs_b2b';
  const early = consumerIdx.filter((i) => plan[i].k < DAYS - 6);
  for (const i of [early[5], early[33], early[71], early[104]].filter((x) => x !== undefined)) { plan[i].cancel = true; plan[i].doc = null; }
  const fvsOld = consumerIdx.filter((i) => plan[i].doc === 'fvs' && plan[i].k < DAYS - 9 && !plan[i].cancel);
  fvsOld.slice(0, 5).forEach((i, n) => { plan[i].ret = n === 4 ? 'requested' : n === 3 ? 'received' : 'refunded'; });
  const lastDayUnpaid = plan.filter((o) => o.k === DAYS - 1).slice(-2); for (const o of lastDayUnpaid) o.method = 'bank_transfer';
  const shipFee = (o) => (o.b2b ? 0 : o.lines.reduce((s, l) => s + l.p.price * l.q, 0) >= 20000 ? 0 : o.locker ? 1399 : 1699);

  // ---- events -------------------------------------------------------------------------------------------------------
  const events = [];
  const nextWork = (ms, h) => { let d = new Date(ms + 86400000).toISOString().slice(0, 10); for (;;) { const w = new Date(d + 'T12:00:00Z').getUTCDay(); if (w !== 0 && w !== 6) break; d = new Date(Date.parse(d + 'T12:00:00Z') + 86400000).toISOString().slice(0, 10); } return at(d, h, between(0, 50)); };
  for (const o of plan) {
    events.push({ t: o.created, o, kind: 'create' });
    if (o.cancel) { events.push({ t: nextWork(o.created, 10), o, kind: 'cancel' }); continue; }
    const paidAt = o.created + (o.method === 'bank_transfer' ? between(90, 420) : between(2, 25)) * 60000;
    if (o.k === DAYS - 1 && lastDayUnpaid.includes(o)) continue; // awaiting bank transfer on the demo day
    events.push({ t: paidAt, o, kind: 'pay' });
    if (o.k === DAYS - 1) continue; // the last day stays in the warehouse pipeline (liveDayState)
    // Paid before noon on a working day → shipped the same afternoon; otherwise the next working morning.
    const pl = new Date(paidAt + offsetH(o.date) * 3600000), pd = pl.toISOString().slice(0, 10);
    const shipAt = pl.getUTCHours() < 12 && pl.getUTCDay() % 6 !== 0 ? at(pd, between(13, 15), between(0, 50)) : nextWork(paidAt, between(9, 12));
    events.push({ t: shipAt, o, kind: 'ship' });
    if (o.doc) events.push({ t: shipAt + 15 * 60000, o, kind: 'doc' });
    const delivered = shipAt + between(20, 44) * 3600000;
    events.push({ t: delivered, o, kind: 'delivered' });
    if (o.ret) {
      const req = delivered + between(2, 4) * 86400000;
      events.push({ t: req, o, kind: 'return_request' });
      if (o.ret !== 'requested') events.push({ t: req + 2 * 86400000, o, kind: 'return_receive' });
      if (o.ret === 'refunded') events.push({ t: req + 2 * 86400000 + 3 * 3600000, o, kind: 'return_refund' });
    }
  }
  // Each order's own events must follow one another (checked before the first order is written).
  const byOrder = new Map();
  for (const e of events) { if (!byOrder.has(e.o)) byOrder.set(e.o, []); byOrder.get(e.o).push(e.t); }
  for (const [o, ts] of byOrder) if (ts.some((t, i) => i > 0 && t <= ts[i - 1])) throw new Error('order plan out of sequence ' + JSON.stringify(ts.map((t) => new Date(t).toISOString())) + ' ' + o.date);
  // Warehouse operations between the orders.
  const W = (d, h, kind, fn) => events.push({ t: at(dateOf(d), h, 5), kind, fn });
  W(4, 14, 'wms', () => transfer(P['PS-MIO-001'], 12, 'MM: przesunięcie miodu lipowego do Zgierza (sklep stacjonarny)'));
  W(9, 9, 'wms', () => pz(MAIN, prods.filter((p) => ['Kawa', 'Miody', 'Przetwory'].includes(p.category)).map((p) => ({ p, q: Math.round(p.qty * 0.4) })), 'PZ: dostawa tygodniowa — palarnia i pasieka', '-B', 1.02));
  W(12, 11, 'wms', () => damage(P['PS-PRZ-001'], 'Stłuczka słoika przy kompletacji — protokół szkody 1/10/2026'));
  W(18, 9, 'wms', () => pz(MAIN, prods.filter((p) => !['Książki'].includes(p.category)).map((p) => ({ p, q: Math.round(p.qty * 0.35) })), 'PZ: dostawa przed sezonem świątecznym', '-C', 1.03));
  W(25, 10, 'wms', () => pz(MAIN, prods.filter((p) => ['Kawa', 'Herbata', 'Akcesoria'].includes(p.category)).map((p) => ({ p, q: Math.round(p.qty * 0.3) })), 'PZ: dostawa uzupełniająca', '-D', 1.03));
  for (let k = 0; k < DAYS; k++) events.push({ t: at(dateOf(k), 21, 30), kind: 'daily' });
  events.sort((a, b) => a.t - b.t);

  const receiptDays = new Set();
  let n = 0, inpostId;
  for (const e of events) {
    if (e.t > END) continue;
    await moveTo(e.t);
    try { await withWatchdog(run(e), `${e.kind} ${e.o?.number ?? ''}`); } catch (err) { err.message = `${e.kind} ${e.o?.number ?? ''} @${new Date(e.t).toISOString()}: ${err.message}`; throw err; }
    if (++n % 50 === 0) log('events', n, 'orders', summary.counts.orders ?? 0);
  }
  await moveTo(END + 20 * 60000);
  await liveDayState();
  // Allegro orders with channel data for the rule conditions and the card (tools/demo/seed-allegro.mjs).
  try {
    const r = await seedAllegroOrders(await O(), { warehouseId: MAIN, prices: new Map(prods.map((p) => [p.sku, p.price])) });
    count('allegro_orders', r.numbers.length);
    summary.allegro_orders = r.numbers;
  } catch (e) { warn('Allegro orders', e); }
  // Custom statuses in the Sellasist categories, two-level names and "Problem" (tools/demo/seed-statuses.mjs).
  try {
    const names = await seedCustomStatuses(await O());
    count('custom_statuses', names.length);
  } catch (e) { warn('Custom statuses', e); }

  // ---- event handlers -----------------------------------------------------------------------------------------------
  async function run(e) {
    const o = e.o;
    switch (e.kind) {
      case 'create': {
        const c = await O(), a = o.buyer;
        const r = await c.post('/api/orders', { customer_name: a.name, email: a.email, warehouse_id: MAIN, source: 'manual', currency: 'PLN', payment_mode: 'prepaid',
          shipping_cost: shipFee(o), note: o.b2b ? 'Zamówienie hurtowe — faktura VAT na firmę' : (o.locker ? 'Dostawa do Paczkomatu InPost' : 'Dostawa kurierem'),
          address: { street: a.street, city: a.city, postal_code: a.postal_code, country: 'PL', phone: a.phone, ...(o.locker ? { locker_code: lockerOf(a) } : {}) },
          items: o.lines.map((l) => ({ product_id: l.p.id, quantity: l.q })) }, [201]);
        o.id = r.id; o.number = r.number; count('orders'); return;
      }
      case 'cancel': { const c = await O(); await status(c, o, 'cancelled'); count('cancelled'); return; }
      case 'pay': {
        const c = await O(), d = await c.get('/api/orders/' + o.id);
        await c.post(`/api/orders/${o.id}/payments`, { client_key: key(), version: Number(d.version), kind: 'receipt', amount: Number(d.payment.amount_due), currency: 'PLN',
          method: o.method, reference: o.method === 'card' ? 'Płatność kartą online' : o.method === 'other' ? 'BLIK' : `Przelew ${o.number}`, confirmed: true });
        count('payments'); return;
      }
      case 'ship': return ship(o);
      case 'doc': return documentFor(o);
      case 'delivered': { const c = await M(); await status(c, o, 'delivered'); count('delivered'); return; }
      case 'return_request': {
        const c = await M(), d = await c.get('/api/orders/' + o.id);
        const line = d.items.find((i) => i.quantity >= 1);
        const rc = await c.post(`/api/orders/${o.id}/returns`, { client_key: key(), reason: pick(['Produkt niezgodny z opisem — klient oczekiwał innego smaku', 'Zmiana decyzji klienta (odstąpienie od umowy w 14 dni)', 'Uszkodzone opakowanie przy dostawie']),
          items: [{ item_id: line.id, quantity: 1 }] }, [201]);
        o.returnId = rc.id; o.returnItem = line; count('returns'); return;
      }
      case 'return_receive': {
        const c = await M(), rc = await c.get('/api/returns/' + o.returnId);
        pol = (await c.get('/api/wms-lots')).policy;
        const frags = (await c.get(`/api/wms-lots/orders/${o.id}/return-fragments`)).data.filter((f) => f.product_id === o.returnItem.product_id && Number(f.remaining) > 0);
        await c.post(`/api/returns/${o.returnId}/receive`, { version: Number(rc.version), shipping_refund: 0, note: 'Paczka zwrotna przyjęta, towar sprawdzony i przyjęty na stan',
          items: [{ item_id: o.returnItem.id, accepted: 1, restocked: 1 }],
          wms_lots: { client_key: key(), policy_version: String(pol.version), stock_versions: [{ warehouse_id: rc.warehouse_id ?? MAIN, product_id: o.returnItem.product_id, version: await stockVersion(rc.warehouse_id ?? MAIN, o.returnItem.product_id) }],
            picks: [{ issue_fragment_id: frags[0].id, quantity: 1, location: frags[0].location }] } });
        count('returns_received'); return;
      }
      case 'return_refund': {
        const c = await O(), g = await c.get('/api/returns/' + o.returnId);
        await c.post(`/api/returns/${o.returnId}/refund`, { version: Number(g.version), amount: g.settlement_amount ?? g.refund_amount, reference: 'Zwrot środków przelewem na rachunek klienta', confirmed: true });
        count('refunds');
        if (o.fvsId) {
          const kor = await issueKorS(o.fvsId, { mode: 'return', return_id: o.returnId });
          await ksef(kor.id); count('kor_s');
        }
        return;
      }
      case 'daily': {
        const day = warsawDay();
        if (!receiptDays.has(day)) return;
        const c = await O(); await c.post('/api/receipt233/daily-reports', { confirmed: true }, [200, 201]); count('daily_reports'); return;
      }
      case 'wms': try { await e.fn(); } catch (err) { warn('WMS operation', err); } return;
      default: throw new Error('unknown event ' + e.kind);
    }
  }
  async function status(c, o, s) { const d = await c.get('/api/orders/' + o.id); return c.patch(`/api/orders/${o.id}/status`, { status: s, expected_version: String(d.version) }); }
  async function ship(o, until = 'shipped') {
    const m = await M();
    await status(m, o, 'picking');
    if (until === 'picking') return;
    let d = await m.get('/api/orders/' + o.id);
    const sku = new Map((d.picking_items ?? d.items).map((i) => [i.product_id, i.sku]));
    const al = (await m.get(`/api/wms-lots/orders/${o.id}/allocations`)).data.filter((x) => x.state === 'active');
    for (const a of al) for (let u = 0; u < Number(a.quantity) - Number(a.scanned); u++)
      await m.post(`/api/orders/${o.id}/scan`, { code: sku.get(a.product_id), location: a.location, layer_id: a.layer_id, client_key: key() });
    await status(m, o, 'packed');
    if (until === 'packed') return;
    if (o.locker) {
      const c = await O(), [first, ...rest] = o.buyer.name.split(' ');
      const sp = await c.post(`/api/orders/${o.id}/shipping/preview`, { channel_id: await inpost(), service: 'inpost_locker_standard', target_point: lockerOf(o.buyer), template: o.lines.length > 2 ? 'medium' : 'small',
        receiver: { first_name: first, last_name: rest.join(' ') || first, email: o.buyer.email, phone: o.buyer.phone } });
      const req = key();
      await c.post(`/api/orders/${o.id}/local-carrier/${req}/bind`, { plan_id: sp.id }, [201]);
      const q = await c.post(`/api/orders/${o.id}/local-carrier/${req}/run`, { action: 'quote' }, [201]);
      await c.post(`/api/shipping-plans/${sp.id}/buy`, { offer_id: String(q.plan.offers[0].id) });
      await c.post(`/api/orders/${o.id}/local-carrier/${req}/run`, { action: 'buy' }, [201]);
      await c.post(`/api/shipping-plans/${sp.id}/dispatch`, {});
      count('shipments_inpost_sim');
    } else { await m.post(`/api/orders/${o.id}/ship-demo`, {}); count('shipments_demo'); }
  }
  async function inpost() { if (!inpostId) inpostId = (await (await O()).post('/api/shipping/example', {})).id; return inpostId; }
  async function documentFor(o) {
    const c = await O(), d = await c.get('/api/orders/' + o.id), a = o.buyer, today = warsawDay();
    if (o.doc === 'receipt') {
      await c.post(`/api/receipt233/orders/${o.id}/receipts`, { client_key: key(), payment_form: o.method === 'card' ? 'karta' : o.method === 'other' ? 'mobilna' : 'przelew', confirmed: true }, [201]);
      receiptDays.add(today); count('receipts'); return;
    }
    if (o.doc === 'fv') {
      const pv = (await c.post(`/api/local-invoices/orders/${o.id}/previews`, { client_key: key(), series_id: series.id, order_version: String(d.version), shipping_vat: 23,
        buyer: { kind: 'consumer', name: a.name, street: a.street, postal_code: a.postal_code, city: a.city, country: 'PL' }, sell_date: today, tax_regime: 'ordinary_domestic',
        consumer_sale_confirmed: true, no_special_tax_procedure_confirmed: true, not_fiscal_receipt_confirmed: true }, [201])).preview;
      const doc = (await c.post(`/api/local-invoices/previews/${pv.id}/tax-issue`, { client_key: key(), scope_hash: pv.scope_hash, confirmed: true, local_only: true }, [201])).document;
      count('fv'); if (o.k < DAYS - 1) await ksef(doc.id); return;
    }
    const buyer = o.doc === 'fvs_b2b'
      ? { kind: 'business', name: a.name, address: { street: a.street, postal_code: a.postal_code, city: a.city, country: 'PL' }, tax_id: a.nip, pl_vat_payer: true }
      : { kind: 'consumer', name: a.name, address: { street: a.street, postal_code: a.postal_code, city: a.city, country: 'PL' } };
    const pv = (await c.post(`/api/invoice230/orders/${o.id}/previews`, { client_key: key(), series_id: series.id, order_version: String(d.version), shipping_vat: 23, buyer, sell_date: today }, [201])).preview;
    const doc = (await c.post(`/api/local-invoices/previews/${pv.id}/tax-issue`, { client_key: key(), scope_hash: pv.scope_hash, confirmed: true, local_only: true }, [201])).document;
    o.fvsId = doc.id; count(o.doc === 'fvs_b2b' ? 'fvs_b2b' : 'fvs_consumer');
    if (o.k < DAYS - 1) await ksef(doc.id);
  }
  async function ksef(id) {
    const r = await (await O()).post(`/api/ksef229/documents/${id}/send`, {});
    if (r.submission?.state !== 'accepted') throw new Error('KSeF not accepted ' + JSON.stringify(r.submission).slice(0, 300));
    count('ksef_accepted');
  }
  async function issueKorS(fvsId, correction) {
    const c = await O();
    const pv = (await c.post(`/api/invoice232/invoices/${fvsId}/previews`, { client_key: key(), correction }, [201])).preview;
    return (await c.post(`/api/invoice232/previews/${pv.id}/issue`, { client_key: key(), scope_hash: pv.scope_hash, confirmed: true }, [201])).document;
  }
  async function transfer(p, q, note) {
    const c = await O(); pol = (await c.get('/api/wms-lots')).policy;
    const mv = (await c.post('/api/wms-lots/movement-previews', { client_key: key(), policy_version: String(pol.version), kind: 'transfer', product_id: p.id, warehouse_id: MAIN, location: p.location,
      quantity: q, destination_warehouse_id: ZGI, destination_location: 'Z-' + p.location.slice(0, 4), note,
      stock_versions: [{ warehouse_id: MAIN, product_id: p.id, version: await stockVersion(MAIN, p.id) }, { warehouse_id: ZGI, product_id: p.id, version: await stockVersion(ZGI, p.id) }] }, [200, 201])).preview;
    await c.post(`/api/wms-lots/movement-previews/${mv.id}/execute`, { client_key: key(), scope_hash: mv.scope_hash, confirmed: true }, [200, 201]);
    count('wms_transfers');
  }
  async function damage(p, note) {
    const c = await O(); pol = (await c.get('/api/wms-lots')).policy;
    const pos = (await c.get(`/api/wms-lots/positions?warehouse_id=${MAIN}&product_id=${p.id}`)).data.filter((x) => Number(x.available) > 0);
    const mv = (await c.post('/api/wms-lots/movement-previews', { client_key: key(), policy_version: String(pol.version), kind: 'adjustment', product_id: p.id, warehouse_id: MAIN, location: pos[0].location,
      quantity: -1, layer_ids: [pos[0].layer_id], note, stock_versions: [{ warehouse_id: MAIN, product_id: p.id, version: await stockVersion(MAIN, p.id) }] }, [200, 201])).preview;
    await c.post(`/api/wms-lots/movement-previews/${mv.id}/execute`, { client_key: key(), scope_hash: mv.scope_hash, confirmed: true }, [200, 201]);
    count('wms_adjustments');
  }
  // The demo morning: a few of the last orders stay in the warehouse pipeline (picking, packed) for the live walk-through.
  async function liveDayState() {
    const last = plan.filter((o) => o.k === DAYS - 1 && o.id && !o.cancel);
    await O();
    const d = (o) => owner.get('/api/orders/' + o.id);
    let staged = 0;
    for (const o of last) {
      const s = (await d(o)).status;
      if (s === 'paid' && staged === 0) { await ship(o, 'picking'); staged++; } else if (s === 'paid' && staged === 1) { await ship(o, 'packed'); staged++; }
    }
    summary.live_states = Object.fromEntries(await Promise.all(last.map(async (o) => [o.number, (await d(o)).status])));
  }
}

function lockerOf(a) { return a.city.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ł/gi, 'L').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3) + '0' + (1 + (a.name.length % 8)) + 'M'; }

function writeCredentials(users) {
  const json = { url: 'http://127.0.0.1:4300', users: Object.values(users).map(({ key: k, name, email, role, label, password }) => ({ key: k, name, email, role, label, password })) };
  writeFileSync(ROOT + '/private/credentials.json', JSON.stringify(json, null, 1) + '\n', { mode: 0o600 });
  const md = ['# Konta demo (lokalne, testowe) — NIE COMMITOWAĆ', '', `Adres: ${json.url}`, '', '| rola | osoba | e-mail | hasło |', '|---|---|---|---|',
    ...json.users.map((u) => `| ${u.label} | ${u.name} | ${u.email} | \`${u.password}\` |`), '',
    'Hasła wygenerował `tools/demo/seed.mjs` dla bazy demo. Nowy `demo.sh seed` tworzy nowe hasła; `demo.sh reset` zachowuje te.', ''].join('\n');
  writeFileSync(new URL('./CREDENTIALS.local.md', import.meta.url), md, { mode: 0o600 });
}
