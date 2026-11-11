#!/usr/bin/env node
/** MIG-5: data written by release N keeps working after the upgrade to N+1 (docs/release-upgrade-rollback.md).
 * Business flows over the ordinary HTTP surface of the running release (session cookie, no SQL), next to
 * tools/parity/stage3-acceptance.mjs (finance areas). Two companies of its own:
 *  - C: portal link, orders, payments, FV 157 / FV-S 230, return + refund + KOR-S 232, KSeF (local fake);
 *  - D: WMS lots (opening, PZ with lot and cost, FIFO issue on shipment, valuation).
 *
 *   node tools/parity/upgrade-acceptance.mjs seed|verify|continue --base http://127.0.0.1:<port> --ksef-url http://127.0.0.1:<port>/v2 --out <dir>
 *
 * seed (on N): writes the entities, some finished and some half-way (paid not shipped, shipped not returned), and
 *   <out>/upgrade-state.private.json (ids, expected amounts, sha256 of every read model) + accounts (0600).
 * verify (on N+1 after the upgrade, or on N after a rollback): every read model of the seed is identical
 *   (orders, portal data, documents, payments, WMS positions/valuation/operations).
 * continue (on N+1): finishes the half-way work on the N data and adds new work, every amount exact to the grosz:
 *   ship + FV of the paid order, portal return + refund + KOR-S 232 of the N invoice, KSeF send with the N config,
 *   WMS PZ + FIFO shipment + return into the original lot fragment, settlement report rows `zgodne`.
 * Exit code 1 when any check fails; <out>/upgrade-acceptance-<phase>.json lists every check. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { parseArgs } from 'node:util';

const { positionals: [phase], values: a } = parseArgs({ allowPositionals: true, options: {
  base: { type: 'string' }, 'ksef-url': { type: 'string' }, out: { type: 'string' }, label: { type: 'string' } } });
assert(['seed', 'verify', 'continue'].includes(phase) && a.base && a.out, 'usage: seed|verify|continue --base --ksef-url --out [--label]');
const BASE = a.base, OUT = a.out, STATE = OUT + '/upgrade-state.private.json', ACC = OUT + '/upgrade-accounts.private.json';
const LABEL = a.label ?? phase;
const sha = (x) => createHash('sha256').update(typeof x === 'string' ? x : JSON.stringify(canonical(x))).digest('hex');
const canonical = (v) => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])])) : v;
const save = (f, v) => fs.writeFile(f, JSON.stringify(v, null, 1) + '\n', { mode: 0o600 });
const today = new Date().toISOString().slice(0, 10);
const tag = randomBytes(2).toString('hex').toUpperCase();

const results = [];
let req = '-';
const check = (name, ok, detail) => {
  results.push({ requirement: req, name, ok: !!ok, ...(detail === undefined ? {} : { detail }) });
  console.log((ok ? 'PASS ' : 'FAIL ') + `[${req}] ${name}` + (detail === undefined || ok ? '' : ' ' + JSON.stringify(detail).slice(0, 800)));
  return !!ok;
};
const eq = (name, actual, expected) => check(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });
async function area(id, fn) {
  req = id; const t = Date.now();
  try { await fn(); } catch (e) { check('area completed without an unexpected error', false, { error: String(e?.stack ?? e).slice(0, 1500) }); }
  console.log(`-- ${id} ${Date.now() - t} ms`);
}

async function http(method, url, { cookie, body, accept = 'application/json' } = {}) {
  const h = { accept };
  if (cookie) h.cookie = cookie;
  if (body !== undefined) h['content-type'] = 'application/json';
  const r = await fetch(BASE + url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = undefined; }
  return { status: r.status, json, text, setCookie: r.headers.getSetCookie?.() ?? [] };
}
const brief = (r) => `${r.status} ${r.text.slice(0, 500)}`;
function client(cookie) {
  const c = { cookie };
  c.req = async (method, url, body, codes = [200, 201]) => {
    const r = await http(method, url, { cookie: c.cookie, body });
    if (!codes.includes(r.status)) throw new Error(`${method} ${url} → ${brief(r)}`);
    return r.json;
  };
  c.raw = (method, url, body) => http(method, url, { cookie: c.cookie, body });
  c.get = (url) => c.req('GET', url);
  c.post = (url, body = {}, codes) => c.req('POST', url, body, codes);
  c.put = (url, body, codes) => c.req('PUT', url, body, codes);
  c.patch = (url, body, codes) => c.req('PATCH', url, body, codes);
  return c;
}
const cookieOf = (r) => r.setCookie.map((x) => x.split(';')[0]).filter((x) => x.startsWith('dyna_session=')).join('; ');
const nip = () => { const w = [6, 5, 7, 2, 3, 4, 5, 6, 7]; for (;;) { const d = [1 + (randomBytes(1)[0] % 9), ...[...randomBytes(8)].map((b) => b % 10)]; const s = d.reduce((t, x, i) => t + x * w[i], 0) % 11; if (s !== 10) return d.join('') + s; } };
const ADDR = { street: 'Prosta 1', city: 'Warszawa', postal_code: '00-001', country: 'PL', phone: '500600700' };
const PLB2B = (taxId) => ({ kind: 'business', name: 'Hurtownia Polska Sp. z o.o.', address: { street: 'Długa 5', postal_code: '00-002', city: 'Warszawa', country: 'PL' }, tax_id: taxId, pl_vat_payer: true });

async function signup(label) {
  const email = `mig5-${label}-${randomBytes(4).toString('hex')}@example.test`, password = randomBytes(18).toString('base64url');
  const r = await http('POST', '/api/auth/signup', { body: { email, name: 'Aktualizacja ' + label, password, organization: { name: `Aktualizacja ${label} ${tag}`, currency: 'PLN', locale: 'pl-PL' } } });
  assert.equal(r.status, 201, 'signup ' + brief(r));
  const c = client(cookieOf(r));
  await c.patch('/api/workspaces/plan', { plan: 'enterprise' });
  const wh = (await c.get('/api/warehouses')).data;
  c.account = { email, password, warehouse: (wh.find((w) => w.code === 'MAIN') ?? wh[0]).id, nip: nip(), prefix: ('MG' + label + tag).slice(0, 12) };
  c.account.series = (await c.post('/api/local-invoices/series', { client_key: randomUUID(), name: 'Seria aktualizacji ' + label, prefix: c.account.prefix,
    seller: { name: `Sklep aktualizacji ${label} sp. z o.o.`, street: 'Rynek 2', postal_code: '30-001', city: 'Kraków', country: 'PL', tax_id: c.account.nip },
    payment_terms_days: 14, payment_instructions: 'Przelew na rachunek 00 1111 2222', notes: '', seller_vat_status: 'active_domestic' })).series.id;
  return c;
}
async function login(acc) {
  const r = await http('POST', '/api/auth/login', { body: { email: acc.email, password: acc.password } });
  assert.equal(r.status, 200, 'login ' + brief(r));
  return Object.assign(client(cookieOf(r)), { account: acc });
}
const product = async (c, { price, vat = 23, quantity, location = 'A-01' }) => {
  const sku = 'MG-' + randomBytes(4).toString('hex').toUpperCase();
  return { ...(await c.post('/api/products', { name: 'Towar ' + sku, sku, price, vat, warehouse_id: c.account.warehouse, quantity, location })), sku };
};
const order = (c, id) => c.get('/api/orders/' + id);
const setStatus = async (c, id, status) => c.patch(`/api/orders/${id}/status`, { status, expected_version: String((await order(c, id)).version) });
async function scanAll(c, id) {
  const o = await order(c, id);
  if (o.wms_lots_enabled) { // lot tenants: every reserved FIFO layer is scanned by its layer_id
    for (const l of (await c.get(`/api/wms-lots/orders/${id}/allocations`)).data.filter((x) => x.state === 'active')) {
      const sku = o.picking_items.find((p) => p.product_id === l.product_id).sku;
      for (let q = Number(l.scanned); q < Number(l.quantity); q++) await c.post(`/api/orders/${id}/scan`, { code: sku, location: l.location, layer_id: l.layer_id, client_key: randomUUID() });
    }
    return;
  }
  for (const it of o.picking_items ?? o.items) {
    const loc = it.locations?.[0]?.location ?? it.location ?? 'A-01';
    for (let q = Number(it.scanned ?? 0); q < Number(it.quantity); q++) await c.post(`/api/orders/${id}/scan`, { code: it.sku, location: loc, client_key: randomUUID() });
  }
}
const createOrder = (c, lines, shipping_cost = 0) => c.post('/api/orders', { customer_name: 'Klient aktualizacji', email: `kl-${randomBytes(3).toString('hex')}@example.test`,
  warehouse_id: c.account.warehouse, source: 'manual', currency: 'PLN', shipping_cost, address: ADDR, items: lines.map(([p, quantity]) => ({ product_id: p.id, quantity })) });
const pay = async (c, id) => { const o = await order(c, id);
  return c.post(`/api/orders/${id}/payments`, { client_key: randomUUID(), version: Number(o.version), kind: 'receipt', amount: Number(o.total), currency: 'PLN', method: 'other', reference: 'Wpłata ' + o.number, confirmed: true }); };
async function ship(c, id) { await setStatus(c, id, 'picking'); await scanAll(c, id); await setStatus(c, id, 'packed'); await c.post(`/api/orders/${id}/ship-demo`); return order(c, id); }
async function fv157(c, id) {
  const pv = (await c.post(`/api/local-invoices/orders/${id}/previews`, { client_key: randomUUID(), series_id: c.account.series, order_version: String((await order(c, id)).version), shipping_vat: 23,
    buyer: { kind: 'consumer', name: 'Jan Kowalski', street: 'Długa 5', postal_code: '00-002', city: 'Warszawa', country: 'PL' }, sell_date: today, tax_regime: 'ordinary_domestic',
    consumer_sale_confirmed: true, no_special_tax_procedure_confirmed: true, not_fiscal_receipt_confirmed: true }, [201])).preview;
  return (await c.post(`/api/local-invoices/previews/${pv.id}/tax-issue`, { client_key: randomUUID(), scope_hash: pv.scope_hash, confirmed: true, local_only: true }, [201])).document;
}
async function fv230(c, id, buyer) {
  const b = { series_id: c.account.series, order_version: String((await order(c, id)).version), shipping_vat: 23, buyer, sell_date: today };
  const pv = (await c.post(`/api/invoice230/orders/${id}/previews`, { client_key: randomUUID(), ...b }, [201])).preview;
  return (await c.post(`/api/local-invoices/previews/${pv.id}/tax-issue`, { client_key: randomUUID(), scope_hash: pv.scope_hash, confirmed: true, local_only: true }, [201])).document;
}
async function kor232(c, fvsId, correction) {
  const pv = (await c.post(`/api/invoice232/invoices/${fvsId}/previews`, { client_key: randomUUID(), correction }, [201])).preview;
  return (await c.post(`/api/invoice232/previews/${pv.id}/issue`, { client_key: randomUUID(), scope_hash: pv.scope_hash, confirmed: true }, [201])).document;
}
const gross = (d) => Number(d.data?.totals?.gross_minor);

// Read models compared between phases: what an operator and a buyer see. Volatile request-time fields are dropped.
const VOLATILE = new Set(['generated_at', 'snapshot_at', 'now', 'server_time', 'expires_in', 'can_write', 'can_admin', 'can_read', 'can_read_value', 'available', 'read_only', 'current_role']);
const stable = (v) => Array.isArray(v) ? v.map(stable) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).filter(([k]) => !VOLATILE.has(k)).map(([k, x]) => [k, stable(x)])) : v;
/** Read model fields of release N: a later release may add fields, never change or drop these. */
const projectOnto = (seen, now) => Array.isArray(seen) ? (Array.isArray(now) ? seen.map((x, i) => projectOnto(x, now[i])) : now)
  : seen && typeof seen === 'object' ? (now && typeof now === 'object' && !Array.isArray(now) ? Object.fromEntries(Object.keys(seen).map((k) => [k, projectOnto(seen[k], now[k])])) : now) : now;
async function models(S, C, D) {
  const out = {};
  for (const [k, id] of Object.entries(S.c.orders)) {
    out['C order ' + k] = await order(C, id);
    out['C payments ' + k] = (await C.get(`/api/orders/${id}/payments`)).data;
  }
  out['C portal data'] = (await http('GET', `/api/public/orders/${S.c.portal_token}/data`)).json;
  for (const [k, d] of Object.entries(S.c.documents)) out['C document ' + k] = (await C.get(d.path + d.id)).document;
  out['C ksef config'] = (await C.get('/api/ksef229/configs')).data ?? null;
  for (const [k, id] of Object.entries(S.d.orders)) out['D order ' + k] = await order(D, id);
  out['D wms positions'] = await D.get('/api/wms-lots/positions?product_id=' + S.d.product);
  out['D wms valuation'] = await D.get('/api/wms-lots/valuation?product_id=' + S.d.product);
  out['D wms operations'] = await D.get('/api/wms-lots/operations');
  for (const [k, id] of Object.entries(S.d.orders)) out['D wms allocations ' + k] = await D.get(`/api/wms-lots/orders/${id}/allocations`);
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, stable(v)]));
}
const valuationMinor = (v) => Number(v.valuation.known_minor);

// =====================================================================
if (phase === 'seed') {
  await fs.mkdir(OUT, { recursive: true, mode: 0o700 });
  const health = (await http('GET', '/api/health')).json;
  const S = { seeded_at: new Date().toISOString(), revision: health?.revision, today, c: { orders: {}, documents: {}, expect: {} }, d: { orders: {} } };
  const C = await signup('C'), D = await signup('D');
  await save(ACC, { C: C.account, D: D.account });
  S.c.series = C.account.series; S.c.prefix = C.account.prefix;

  await area('SEED-C orders, payments, documents, portal', async () => {
    const p1 = await product(C, { price: 1999, vat: 23, quantity: 50, location: 'A-01' }), p2 = await product(C, { price: 4550, vat: 8, quantity: 50, location: 'A-02' });
    S.c.products = { p1: p1.id, p2: p2.id };
    // finished in N: shipped, FV-S 230 (B2B) and paid; returned later in N+1 through the portal (KOR-S 232)
    const done = await createOrder(C, [[p1, 2], [p2, 1]], 1500); await pay(C, done.id); const shipped = await ship(C, done.id);
    eq('C shipped order total = 2×19.99 + 45.50 + 15.00 (grosze)', Number(shipped.total), 2 * 1999 + 4550 + 1500);
    const fvs = await fv230(C, done.id, PLB2B(nip()));
    eq('C FV-S 230 gross = order total', gross(fvs), Number(shipped.total));
    S.c.orders.shipped = done.id; S.c.documents.fvs = { id: fvs.id, number: fvs.number, path: '/api/invoice230/documents/' };
    S.c.portal_token = shipped.portal_token;
    check('C portal link exists for the shipped order', /\S{16,}/.test(String(S.c.portal_token)), shipped.portal_token);
    const portal = await http('GET', `/api/public/orders/${S.c.portal_token}/data`);
    check('C portal data readable without a session', portal.status === 200, brief(portal));
    // half-way in N: paid, not shipped; shipped and invoiced in N+1
    const paid = await createOrder(C, [[p2, 3]], 0); await pay(C, paid.id);
    eq('C paid order total = 3×45.50', Number((await order(C, paid.id)).total), 3 * 4550);
    S.c.orders.paid = paid.id;
    // created in N, never paid: cancelled in N+1
    const open = await createOrder(C, [[p1, 1]], 999); S.c.orders.open = open.id;
    // FV 157 of a shipped order in N; KSeF config in N, sending in N+1
    const v = await createOrder(C, [[p1, 3]], 0); await pay(C, v.id); await ship(C, v.id);
    const fv = await fv157(C, v.id);
    eq('C FV 157 gross = 3×19.99', gross(fv), 3 * 1999);
    S.c.orders.fv157 = v.id; S.c.documents.fv157 = { id: fv.id, number: fv.number, path: '/api/local-invoices/documents/' };
    if (a['ksef-url']) {
      await C.put('/api/ksef229/configs/' + C.account.nip, { environment: 'local_fake', base_url: a['ksef-url'], auth_method: 'token', token: 'lokalny-token-' + randomBytes(10).toString('hex') });
      check('C KSeF config check ok (local fake)', (await C.post(`/api/ksef229/configs/${C.account.nip}/check`)).ok === true);
    }
  });

  await area('SEED-D WMS lots', async () => {
    const w = await product(D, { price: 2500, vat: 23, quantity: 10, location: 'B-01' });
    S.d.product = w.id;
    const meta = await D.get('/api/wms-lots');
    const scope = await D.get('/api/wms-lots/opening-scope');
    const bins = (scope.data ?? scope.rows ?? scope.lines ?? []).filter((b) => b.product_id === w.id);
    eq('D opening scope: one bin of 10', bins.map((b) => [b.location, Number(b.quantity)]), [['B-01', 10]]);
    const policy = String(meta.policy?.version ?? meta.policy_version ?? meta.version ?? '0');
    const pv = (await D.post('/api/wms-lots/opening-previews', { client_key: randomUUID(), policy_version: policy, currency: 'PLN', note: 'Otwarcie partii przed aktualizacją',
      lines: bins.map((b) => ({ warehouse_id: b.warehouse_id, product_id: b.product_id, location: b.location, quantity: Number(b.quantity), stock_version: String(b.stock_version), lot_code: 'L-OPEN', unit_cost_minor: '1000' })) }, [200, 201])).preview;
    check('D opening preview ready', pv.ready === true, pv.issues);
    await D.post(`/api/wms-lots/opening-previews/${pv.id}/activate`, { client_key: randomUUID(), scope_hash: pv.scope_hash, confirmed: true, ack_unknown_costs: false }, [200, 201]);
    S.d.receipts = [await receipt(D, w, 5, 'L-PZ1', '1200')];
    const o = await createOrder(D, [[w, 12]], 0); await pay(D, o.id); await ship(D, o.id);
    S.d.orders.fifo = o.id;
    const val = await D.get('/api/wms-lots/valuation?product_id=' + w.id);
    S.d.valuation_after_seed = val;
    eq('D valuation after FIFO issue of 12 (10×10.00 open, 2×12.00 PZ1): 3×12.00 left', valuationMinor(val), 3 * 1200);
  });

  S.models = await models(S, C, D);
  S.models_sha = Object.fromEntries(Object.entries(S.models).map(([k, v]) => [k, sha(v)]));
  S.finished_at = new Date().toISOString();
  await save(STATE, S);
}

async function receipt(D, w, quantity, lot, cost) {
  const meta = await D.get('/api/wms-lots');
  const pos = await D.get('/api/wms-lots/positions?product_id=' + w.id);
  const stockVersion = String((pos.stock ?? pos.stock_versions ?? [])[0]?.version ?? pos.data?.[0]?.stock_version ?? '0');
  const r = await D.post('/api/wms-lots/receipts', { client_key: randomUUID(), policy_version: String(meta.policy?.version ?? meta.policy_version ?? meta.version),
    warehouse_id: D.account.warehouse, stock_versions: [{ warehouse_id: D.account.warehouse, product_id: w.id, version: stockVersion }],
    lines: [{ product_id: w.id, location: 'B-01', quantity, lot_code: lot, unit_cost_minor: cost, currency: 'PLN', expiry_date: null }], note: 'PZ ' + lot, confirmed: true }, [200, 201]);
  return { lot, quantity, cost, operation: r.operation?.id ?? r.id };
}

// =====================================================================
if (phase === 'verify' || phase === 'continue') {
  const S = JSON.parse(await fs.readFile(STATE, 'utf8')), acc = JSON.parse(await fs.readFile(ACC, 'utf8'));
  const health = (await http('GET', '/api/health')).json;
  const C = await login(acc.C), D = await login(acc.D);
  if (phase === 'verify') await area('VERIFY read models of release N', async () => {
    check('release answers /api/health', /^[a-f0-9]{64}$/.test(String(health?.revision)), health);
    const now = await models(S, C, D);
    let same = 0;
    for (const [k, seen] of Object.entries(S.models)) {
      const projected = projectOnto(seen, now[k]);
      if (sha(projected) === sha(seen)) same++; else check('read model unchanged: ' + k, false, { seen: JSON.stringify(seen).slice(0, 400), now: JSON.stringify(projected).slice(0, 400) });
    }
    eq('every read model of release N unchanged (fields of N, values to the grosz)', same, Object.keys(S.models).length);
  });
  if (phase === 'continue') {
    await area('CONTINUE-C orders and documents of N', async () => {
      const paid = await ship(C, S.c.orders.paid);
      const fv = await fv157(C, paid.id);
      eq('N paid order shipped in N+1: FV 157 gross = 3×45.50', gross(fv), 3 * 4550);
      const open = await order(C, S.c.orders.open);
      await C.patch(`/api/orders/${open.id}/status`, { status: 'cancelled', expected_version: String(open.version) });
      eq('N open order cancelled in N+1', (await order(C, open.id)).status, 'cancelled');
      if (a['ksef-url']) {
        const sent = await C.post(`/api/ksef229/documents/${S.c.documents.fv157.id}/send`);
        check('N FV 157 sent to KSeF in N+1 with the N config', sent.submission?.state === 'accepted' && /\S/.test(sent.submission?.ksef_number ?? ''), sent);
      }
      // the buyer returns one p1 of the N order through the N portal link; refund; KOR-S 232 on the N FV-S
      const shipped = await order(C, S.c.orders.shipped), item = shipped.items.find((i) => i.product_id === S.c.products.p1);
      const pr = await http('POST', `/api/public/orders/${S.c.portal_token}/returns`, { body: { client_key: randomUUID(), reason: 'Zwrot przez portal po aktualizacji', items: [{ item_id: item.id, quantity: 1 }] } });
      check('portal return request on the N link (201)', pr.status === 201, brief(pr));
      const list = (await C.get(`/api/orders/${shipped.id}/returns`)).data ?? [];
      let rma = await C.get('/api/returns/' + (list[0]?.id ?? pr.json?.id));
      rma = await C.post(`/api/returns/${rma.id}/receive`, { version: Number(rma.version), shipping_refund: 0, note: 'Przyjęto zwrot z portalu', items: [{ item_id: item.id, accepted: 1, restocked: 1 }] });
      const g = await C.get('/api/returns/' + rma.id);
      rma = await C.post(`/api/returns/${rma.id}/refund`, { version: Number(g.version), amount: g.settlement_amount ?? g.refund_amount, reference: 'Przelew zwrotu', confirmed: true });
      eq('refund = one p1 (19.99)', Number(rma.refund_amount), 1999);
      const kor = await kor232(C, S.c.documents.fvs.id, { mode: 'return', return_id: rma.id });
      eq('KOR-S 232 on the N FV-S: delta = −19.99', Number(kor.data.totals.delta.gross_minor), -1999);
      const rep = await C.get(`/api/settlement-report?from=${S.today}&to=${today}`);
      const row = (id) => rep.rows.find((r) => r.order_id === id);
      const sr = row(shipped.id);
      eq('settlement: N order paid in N, refunded and corrected in N+1', sr && [sr.received, sr.refunded, sr.corrections, sr.documented, sr.flags], [Number(shipped.total), 1999, -1999, Number(shipped.total) - 1999, ['zgodne']]);
      const pp = row(paid.id);
      eq('settlement: N payment + N+1 FV 157', pp && [pp.received, pp.documented, pp.flags], [3 * 4550, 3 * 4550, ['zgodne']]);
    });
    await area('CONTINUE-D WMS lots of N', async () => {
      const w = { id: S.d.product };
      S.d.receipts.push(await receipt(D, w, 4, 'L-PZ2', '1300'));
      const o = await createOrder(D, [[w, 5]], 0); await pay(D, o.id); await ship(D, o.id);
      const alloc = await D.get(`/api/wms-lots/orders/${o.id}/allocations`);
      const v = await D.get('/api/wms-lots/valuation?product_id=' + w.id);
      eq('FIFO across the N lot PZ1 (3×12.00) and the N+1 lot PZ2 (2×13.00): 2×13.00 left', valuationMinor(v), 2 * 1300);
      check('allocations of the N+1 order name both lots', JSON.stringify(alloc).includes('L-PZ1') && JSON.stringify(alloc).includes('L-PZ2'), alloc);
    });
  }
}

const summary = {};
for (const r of results) { const s = summary[r.requirement] ??= { pass: 0, fail: 0 }; r.ok ? s.pass++ : s.fail++; }
await save(`${OUT}/upgrade-acceptance-${LABEL}.json`, { phase, label: LABEL, at: new Date().toISOString(), base: BASE, summary, results });
console.log(JSON.stringify(summary));
process.exitCode = results.length && results.every((r) => r.ok) ? 0 : 1;
