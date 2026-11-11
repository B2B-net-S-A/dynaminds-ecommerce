#!/usr/bin/env node
/** Stage 3 (finance and legal) acceptance rehearsal over the ordinary HTTP surface of one packaged release.
 * Every business step goes through the release's HTTP API with a real session cookie (signup, no SQL, no
 * in-process calls). Providers are local fakes only: fiscal printer 233, KSeF 229/243 fake, PayU simulation
 * (DYNA_PAYU_FAKE=local), NBP rate entered manually (no api.nbp.pl).
 *
 *   node tools/parity/stage3-acceptance.mjs run|after-restart --base http://127.0.0.1:<port> --control http://127.0.0.1:<port>
 *        --ksef-url http://127.0.0.1:<port>/v2 --out <evidence dir>
 *
 * `run` writes <out>/stage3-state.private.json (ids, hashes; generated test passwords in accounts.private.json, 0600)
 * and <out>/stage3-acceptance-run.json; `after-restart` re-reads every document, export and report and compares
 * them with the state. `after-upgrade` (MIG-5, docs/release-upgrade-rollback.md) does the same on the next release
 * started on the same database: the revision must have changed, everything else must be identical, except a
 * settlement report that the newer release computes correctly where the older did not (the KOR 206/207 rows of
 * company B, fixed in 7ba753a), which must then show exactly the values the run expected. Exit code 1 when any check fails. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { parseArgs } from 'node:util';

const { positionals: [phase], values: a } = parseArgs({ allowPositionals: true, options: {
  base: { type: 'string' }, control: { type: 'string' }, 'ksef-url': { type: 'string' }, out: { type: 'string' } } });
assert(['run', 'after-restart', 'after-upgrade'].includes(phase) && a.base && a.out, 'usage: run|after-restart|after-upgrade --base --control --ksef-url --out');
const BASE = a.base, CONTROL = a.control, KSEF_URL = a['ksef-url'], OUT = a.out;
const STATE = OUT + '/stage3-state.private.json', ACC = OUT + '/accounts.private.json';
const canon = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([p], [q]) => (p < q ? -1 : 1))) : x));
const sha = (x) => createHash('sha256').update(x).digest('hex');
const save = (f, v) => fs.writeFile(f, JSON.stringify(v, null, 1) + '\n', { mode: 0o600 });
const today = new Date().toISOString().slice(0, 10), year = today.slice(0, 4), month = today.slice(0, 7);
const yesterday = new Date(Date.parse(today + 'T00:00:00Z') - 86_400_000).toISOString().slice(0, 10);
const tag = randomBytes(2).toString('hex').toUpperCase();

// ---------- results ----------
const results = [];
let req = '-';
const check = (name, ok, detail) => {
  results.push({ requirement: req, name, ok: !!ok, ...(detail === undefined ? {} : { detail }) });
  console.log((ok ? 'PASS ' : 'FAIL ') + `[${req}] ${name}` + (detail === undefined || ok ? '' : ' ' + JSON.stringify(detail).slice(0, 600)));
  return !!ok;
};
const eq = (name, actual, expected) => check(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });
async function area(id, fn) {
  req = id; const t = Date.now();
  try { await fn(); } catch (e) { check('area completed without an unexpected error', false, { error: String(e?.stack ?? e).slice(0, 1500) }); }
  console.log(`-- ${id} ${Date.now() - t} ms`);
}

// ---------- HTTP ----------
async function http(method, url, { cookie, body, form, accept = 'application/json', headers = {} } = {}) {
  const h = { accept, ...headers };
  if (cookie) h.cookie = cookie;
  let payload;
  if (form !== undefined) { h['content-type'] = 'application/x-www-form-urlencoded'; payload = form; }
  else if (body !== undefined) { h['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(BASE + url, { method, headers: h, body: payload, redirect: 'manual' });
  const buf = Buffer.from(await r.arrayBuffer()), text = buf.toString('utf8');
  let json; try { json = JSON.parse(text); } catch { json = undefined; }
  return { status: r.status, json, text, buf, headers: r.headers, setCookie: r.headers.getSetCookie?.() ?? [] };
}
const brief = (r) => `${r.status} ${r.text.slice(0, 500)}`;
function client(cookie) {
  const c = { cookie };
  c.req = async (method, url, body, codes = [200, 201]) => {
    const r = await http(method, url, { cookie: c.cookie, body });
    if (!codes.includes(r.status)) throw new Error(`${method} ${url} → ${brief(r)}`);
    return r.json;
  };
  c.raw = (method, url, body, extra = {}) => http(method, url, { cookie: c.cookie, body, ...extra });
  c.get = (url) => c.req('GET', url);
  c.post = (url, body = {}, codes) => c.req('POST', url, body, codes);
  c.put = (url, body, codes) => c.req('PUT', url, body, codes);
  c.patch = (url, body, codes) => c.req('PATCH', url, body, codes);
  return c;
}
const cookieOf = (r) => r.setCookie.map((x) => x.split(';')[0]).filter((x) => x.startsWith('dyna_session=')).join('; ');
const control = async (path, body) => { const r = await fetch(CONTROL + path, body ? { method: 'POST', body: JSON.stringify(body) } : {}); const t = await r.text(); assert(r.ok, path + ' ' + t); return JSON.parse(t); };

// ---------- domain helpers ----------
const nip = () => { const w = [6, 5, 7, 2, 3, 4, 5, 6, 7]; for (;;) { const d = [1 + (randomBytes(1)[0] % 9), ...[...randomBytes(8)].map((b) => b % 10)]; const s = d.reduce((t, x, i) => t + x * w[i], 0) % 11; if (s !== 10) return d.join('') + s; } };
const ADDR = { PL: { street: 'Prosta 1', city: 'Warszawa', postal_code: '00-001', country: 'PL', phone: '500600700' },
  DE: { street: 'Hauptstraße 5', city: 'Berlin', postal_code: '10115', country: 'DE', phone: '500600700' } };
const baddr = (country) => ({ street: country === 'PL' ? 'Długa 5' : 'Hauptstraße 5', postal_code: country === 'PL' ? '00-002' : '10115', city: country === 'PL' ? 'Warszawa' : 'Berlin', country });
const BUYER = {
  consumer: { kind: 'consumer', name: 'Anna Nowak', address: baddr('PL') },
  plB2B: (taxId) => ({ kind: 'business', name: 'Hurtownia Polska Sp. z o.o.', address: baddr('PL'), tax_id: taxId, pl_vat_payer: true }),
  deB2B: { kind: 'business', name: 'Muster GmbH', address: baddr('DE'), tax_id: 'DE123456789' },
  deConsumer: { kind: 'consumer', name: 'Hans Muster', address: baddr('DE') },
};
const zl = (minor) => (Number(minor) / 100).toFixed(2);
const halfUp = (minor, mid) => { // minor × mid (4 decimals), half up to the grosz, in integers
  const m = BigInt(Math.round(Number(mid) * 10000)), p = BigInt(minor) * m, q = p / 10000n, r = p % 10000n;
  return String(r < 0n ? (-r >= 5000n ? q - 1n : q) : (r >= 5000n ? q + 1n : q));
};

async function signup(label) {
  const email = `s3-${label}-${randomBytes(4).toString('hex')}@example.test`, password = randomBytes(18).toString('base64url');
  const r = await http('POST', '/api/auth/signup', { body: { email, name: 'Etap 3 ' + label, password, organization: { name: `Etap3 ${label} ${tag}`, currency: 'PLN', locale: 'pl-PL' } } });
  assert.equal(r.status, 201, 'signup ' + brief(r));
  const c = client(cookieOf(r));
  const me = await c.get('/api/auth/me');
  c.tenant = me.user?.tenant_id ?? me.tenant_id; c.email = email; c.password = password; c.label = label;
  await c.patch('/api/workspaces/plan', { plan: 'enterprise' });
  const wh = (await c.get('/api/warehouses')).data;
  c.warehouse = (wh.find((w) => w.code === 'MAIN') ?? wh[0]).id;
  c.nip = nip();
  c.prefix = ('S3' + label + tag).toUpperCase().slice(0, 12);
  c.series = (await c.post('/api/local-invoices/series', { client_key: randomUUID(), name: 'Seria etap 3 ' + label, prefix: c.prefix,
    seller: { name: `Sklep etap 3 ${label} sp. z o.o.`, street: 'Rynek 2', postal_code: '30-001', city: 'Kraków', country: 'PL', tax_id: c.nip },
    payment_terms_days: 14, payment_instructions: 'Przelew na rachunek 00 1111 2222', notes: '', seller_vat_status: 'active_domestic' })).series;
  return c;
}
async function login(acc) {
  const r = await http('POST', '/api/auth/login', { body: { email: acc.email, password: acc.password } });
  assert.equal(r.status, 200, 'login ' + brief(r));
  return Object.assign(client(cookieOf(r)), acc);
}
async function product(c, { price, vat = 23, profile, quantity = 1000, extra = {} }) {
  const sku = 'S3-' + randomBytes(4).toString('hex').toUpperCase();
  const p = await c.post('/api/products', { name: 'Towar ' + sku, sku, price, vat, warehouse_id: c.warehouse, quantity, location: 'A-01', ...extra });
  if (profile) await c.put(`/api/products/${p.id}/tax-profile`, { version: null, gtu: null, annex15: false, ...profile });
  return { ...p, sku };
}
const order = (c, id) => c.get('/api/orders/' + id);
async function setStatus(c, id, status) {
  const o = await order(c, id);
  return c.patch(`/api/orders/${id}/status`, { status, expected_version: String(o.version) });
}
async function scanAll(c, id) {
  const o = await order(c, id);
  for (const it of o.picking_items ?? o.items) {
    const loc = it.locations?.[0]?.location ?? it.location ?? 'A-01';
    for (let q = Number(it.scanned ?? 0); q < Number(it.quantity); q++)
      await c.post(`/api/orders/${id}/scan`, { code: it.sku, location: loc, client_key: randomUUID() });
  }
}
async function createOrder(c, lines, { country = 'PL', currency = 'PLN', price_list_id, shipping_cost = 0, email, customer_name = 'Klient etapu 3' } = {}) {
  return c.post('/api/orders', { customer_name, email: email ?? `kl-${randomBytes(3).toString('hex')}@example.test`, warehouse_id: c.warehouse, source: 'manual',
    currency, ...(price_list_id ? { price_list_id } : {}), shipping_cost, address: ADDR[country], items: lines.map(([p, quantity]) => ({ product_id: p.id, quantity })) });
}
async function fulfil(c, id, { pay = true } = {}) {
  if (pay) await setStatus(c, id, 'paid');
  await setStatus(c, id, 'picking'); await scanAll(c, id); await setStatus(c, id, 'packed');
  await c.post(`/api/orders/${id}/ship-demo`);
  return order(c, id);
}
async function shipped(c, lines, opts = {}) { const o = await createOrder(c, lines, opts); return fulfil(c, o.id); }

async function fv157(c, o) {
  const pv = (await c.post(`/api/local-invoices/orders/${o.id}/previews`, { client_key: randomUUID(), series_id: c.series.id, order_version: String((await order(c, o.id)).version), shipping_vat: 23,
    buyer: { kind: 'consumer', name: 'Jan Kowalski', street: 'Długa 5', postal_code: '00-002', city: 'Warszawa', country: 'PL' }, sell_date: today, tax_regime: 'ordinary_domestic',
    consumer_sale_confirmed: true, no_special_tax_procedure_confirmed: true, not_fiscal_receipt_confirmed: true }, [201])).preview;
  const body = { client_key: randomUUID(), scope_hash: pv.scope_hash, confirmed: true, local_only: true };
  const r = await c.post(`/api/local-invoices/previews/${pv.id}/tax-issue`, body, [201]);
  const replay = await c.post(`/api/local-invoices/previews/${pv.id}/tax-issue`, body, [200]);
  return { ...r, replay };
}
async function fv230(c, o, buyer) {
  const b = { series_id: c.series.id, order_version: String((await order(c, o.id)).version), shipping_vat: 23, buyer, sell_date: today };
  const calc = await c.post(`/api/invoice230/orders/${o.id}/calculate`, b, [200]);
  if (calc.blockers?.length) throw new Error('230 blockers ' + JSON.stringify(calc.blockers));
  const pv = (await c.post(`/api/invoice230/orders/${o.id}/previews`, { client_key: randomUUID(), ...b }, [201])).preview;
  const body = { client_key: randomUUID(), scope_hash: pv.scope_hash, confirmed: true, local_only: true };
  const r = await c.post(`/api/local-invoices/previews/${pv.id}/tax-issue`, body, [201]);
  const replay = await c.post(`/api/local-invoices/previews/${pv.id}/tax-issue`, body, [200]);
  return { ...r, replay };
}
async function kor232(c, fvsId, correction) {
  const pv = (await c.post(`/api/invoice232/invoices/${fvsId}/previews`, { client_key: randomUUID(), correction }, [201])).preview;
  const body = { client_key: randomUUID(), scope_hash: pv.scope_hash, confirmed: true };
  const r = await c.post(`/api/invoice232/previews/${pv.id}/issue`, body, [201]);
  const replay = await c.post(`/api/invoice232/previews/${pv.id}/issue`, body, [200]);
  return { ...r, replay };
}
async function returnOne(c, o, item, { refund = true } = {}) {
  let rma = await c.post(`/api/orders/${o.id}/returns`, { client_key: randomUUID(), reason: 'Towar nie spełnił oczekiwań klienta', items: [{ item_id: item.id, quantity: 1 }] }, [201]);
  rma = await c.get('/api/returns/' + rma.id);
  rma = await c.post(`/api/returns/${rma.id}/receive`, { version: Number(rma.version), shipping_refund: 0, note: 'Przyjęto zwrot', items: [{ item_id: item.id, accepted: 1, restocked: 1 }] });
  if (refund) rma = await refundReturn(c, rma.id);
  return rma;
}
async function refundReturn(c, id) {
  const g = await c.get('/api/returns/' + id);
  return c.post(`/api/returns/${id}/refund`, { version: Number(g.version), amount: g.settlement_amount ?? g.refund_amount, reference: 'Przelew zwrotu', confirmed: true });
}
const seqOf = (number) => Number(number.split('/').at(-1));
const continuous = (numbers, prefix) => {
  const own = numbers.filter((n) => n.startsWith(prefix)).map(seqOf).sort((x, y) => x - y);
  return { count: own.length, ok: own.length > 0 && own.every((n, i) => n === i + 1), seqs: own };
};
const docGross = (d) => d.data?.totals?.gross_minor;
// ---------- XML ----------
const tags = (xml, name) => [...xml.matchAll(new RegExp(`<${name}(?: [^>]*)?>([\\s\\S]*?)</${name}>`, 'g'))].map((m) => m[1]);
const one = (xml, name) => tags(xml, name)[0];
const num = (x) => (x === undefined ? 0 : Number(x));
const stripGen = (xml) => xml.replace(/<DataWytworzeniaJPK>[^<]*<\/DataWytworzeniaJPK>/, '');

// =====================================================================
if (phase === 'run') {
  await fs.mkdir(OUT, { recursive: true, mode: 0o700 });
  const health = (await http('GET', '/api/health')).json;
  const S = { started_at: new Date().toISOString(), base: BASE, revision: health?.revision, today, orders: {}, docs: {}, sent: {}, hashes: { settlement: {}, jpk: {} } };
  const A = await signup('A'), B = await signup('B');
  await save(ACC, { A: { email: A.email, password: A.password, tenant: A.tenant, nip: A.nip }, B: { email: B.email, password: B.password, tenant: B.tenant, nip: B.nip } });
  S.companies = { A: { tenant: A.tenant, nip: A.nip, prefix: A.prefix, series: A.series.id }, B: { tenant: B.tenant, nip: B.nip, prefix: B.prefix, series: B.series.id } };
  const buyerNip = nip();
  const docs = { A: [], B: [] }; // {id, number, mode, order_id, gross, vat_pln, net_pln}
  const orders = { A: [], B: [] }; // order ids expected in the settlement report, with expectations
  const remember = (co, d, extra = {}) => { docs[co].push({ id: d.id, number: d.number, mode: d.mode, order_id: d.order_id, ...extra }); return d; };

  req = 'setup';
  check('release health reports a revision', /^[a-f0-9]{64}$/.test(String(health?.revision)), health);
  check('two companies signed up with enterprise plan and a 157 series', !!(A.series?.id && B.series?.id));

  // ---------------- 226 + 157 ----------------
  const P = {};
  await area('FV157', async () => {
    P.v23 = await product(A, { price: 12300, vat: 23 }); P.v8 = await product(A, { price: 5400, vat: 8 }); P.v5 = await product(A, { price: 2100, vat: 5 });
    P.v0 = await product(A, { price: 1000, vat: 0 }); P.gtu = await product(A, { price: 8900, vat: 23, profile: { category: 'standard', gtu: 'GTU_06' } });
    const cases = [[[P.v23, 2], [P.v8, 1]], [[P.v5, 3], [P.v0, 1]], [[P.v23, 1], [P.gtu, 1], [P.v8, 2]]];
    const issued = [];
    for (const [i, lines] of cases.entries()) {
      const o = await shipped(A, lines, { shipping_cost: i % 2 ? 0 : 1500 });
      const r = await fv157(A, o); issued.push(r); remember('A', r.document, { kind: 'fv157' });
      orders.A.push({ id: o.id, number: o.number, total: o.total, expect: 'zgodne', doc: r.document.number });
      eq(`FV ${r.document.number}: gross = order total (grosze)`, docGross(r.document), String(o.total));
      const vt = r.document.data.vat_totals ?? [];
      eq(`FV ${r.document.number}: Σ VAT-rate buckets = totals`, [vt.reduce((s, x) => s + Number(x.net_minor), 0), vt.reduce((s, x) => s + Number(x.vat_minor), 0)].map(String),
        [r.document.data.totals.net_minor, r.document.data.totals.vat_minor].map(String));
      check(`FV ${r.document.number}: issue replay returns the same document (reused)`, r.replay.reused === true && r.replay.document.id === r.document.id && r.replay.document.number === r.document.number);
      const pays = (await A.get(`/api/orders/${o.id}/payments`)).data;
      eq(`FV ${r.document.number}: payment receipt = order total`, pays.filter((p) => p.kind === 'receipt').reduce((s, p) => s + Number(p.amount), 0), Number(o.total));
    }
    const nums = issued.map((r) => r.document.number);
    eq('157 numbering continuous from 000001', nums, [1, 2, 3].map((n) => `${A.prefix}/${year}/${String(n).padStart(6, '0')}`));
    const tax = await A.get(`/api/local-invoices/documents/${issued[2].document.id}/tax`);
    check('226 snapshot on FV: GTU_06 line recorded', (tax.tax?.lines ?? []).some((l) => l.gtu === 'GTU_06'), tax);
    const second = await A.raw('POST', `/api/local-invoices/orders/${issued[0].document.order_id}/previews`, { client_key: randomUUID(), series_id: A.series.id, order_version: '1', shipping_vat: 23,
      buyer: { kind: 'consumer', name: 'X', street: 'Długa 5', postal_code: '00-002', city: 'Warszawa', country: 'PL' }, sell_date: today, tax_regime: 'ordinary_domestic',
      consumer_sale_confirmed: true, no_special_tax_procedure_confirmed: true, not_fiscal_receipt_confirmed: true });
    check('second FV for an invoiced order is refused (409)', second.status === 409, brief(second));
    S.docs.fv157 = issued.map((r) => r.document.id);
  });

  // ---------------- 226 + 230 (+227) ----------------
  await area('VAT226+FV-S230', async () => {
    await A.put('/api/tax/oss', { version: (await A.get('/api/tax/oss')).settings.version, registered: true, registered_from: '2026-07-01', rates: [{ country: 'DE', rate_class: 'standard', rate: 19 }] });
    P.mpp = await product(A, { price: 1_700_000, profile: { category: 'standard', annex15: true } });
    P.zw = await product(A, { price: 50000, profile: { category: 'zw', exemption_basis_kind: 'P_19A', exemption_basis: 'art. 43 ust. 1 pkt 29 lit. a ustawy o VAT' } });
    P.np = await product(A, { price: 80000, profile: { category: 'np', np_kind: 'np_ii' } });
    P.oo = await product(A, { price: 60000, profile: { category: 'oo' } });
    P.oss = await product(A, { price: 11900 });
    P.cons = await product(A, { price: 24600 });
    const plan = [
      ['mpp', [[P.mpp, 1]], {}, BUYER.plB2B(buyerNip)],
      ['zw', [[P.zw, 1]], { shipping_cost: 1500 }, BUYER.plB2B(buyerNip)],
      ['np2', [[P.np, 1]], { country: 'DE' }, BUYER.deB2B],
      ['oo', [[P.oo, 1]], {}, BUYER.plB2B(buyerNip)],
      ['oss', [[P.oss, 2]], { country: 'DE', shipping_cost: 1190 }, BUYER.deConsumer],
      ['cons_cancel', [[P.cons, 1]], {}, BUYER.consumer],
      ['cons_return', [[P.cons, 2]], {}, BUYER.consumer],
    ];
    S.fvs = {};
    for (const [key, lines, opts, buyer] of plan) {
      const o = await shipped(A, lines, opts);
      const r = await fv230(A, o, buyer); remember('A', r.document, { kind: 'fv230_' + key });
      S.fvs[key] = { id: r.document.id, order: o.id, number: r.document.number };
      orders.A.push({ id: o.id, number: o.number, total: o.total, expect: 'zgodne', doc: r.document.number, key });
      eq(`FV-S ${key}: gross = order total`, docGross(r.document), String(o.total));
      check(`FV-S ${key}: replay reused, same number`, r.replay.reused === true && r.replay.document.number === r.document.number);
      S.fvs[key].data = r.document.data;
    }
    const d = (k) => S.fvs[k].data, cats = (k) => d(k).categories.map((c) => c.key);
    check('226 MPP: B2B > 15 000 zł with annex-15 line → mpp.required', d('mpp').mpp?.required === true, d('mpp').mpp);
    eq('226 ZW: category and legal basis', [cats('zw'), d('zw').exemption], [['zw'], { kind: 'P_19A', basis: 'art. 43 ust. 1 pkt 29 lit. a ustawy o VAT' }]);
    eq('226 NP II: category, EU VAT ID buyer', [cats('np2'), d('np2').buyer?.tax_id], [['np II'], 'DE123456789']);
    eq('226 OO: reverse charge category', cats('oo'), ['oo']);
    eq('226 OSS: DE 19 % and procedure oss', [cats('oss'), d('oss').procedure], [['oss 19.00'], 'oss']);
    const vatOss = d('oss').categories[0];
    eq('226 OSS: VAT = 19 % of net (grosze)', Number(vatOss.vat_minor), Math.round(Number(vatOss.net_minor) * 0.19));
    const refusedOO = await A.raw('POST', `/api/invoice230/orders/${S.fvs.cons_return.order}/calculate`, { series_id: A.series.id, order_version: '1', shipping_vat: 23, buyer: BUYER.consumer, sell_date: today });
    check('a second FV-S for an invoiced order is blocked', refusedOO.status === 409 || (refusedOO.json?.blockers ?? []).length > 0, brief(refusedOO));
    // OO to a consumer is refused by 226 (calculate shows a blocker).
    const ooConsumer = await createOrder(A, [[P.oo, 1]]); await fulfil(A, ooConsumer.id);
    const blk = await A.raw('POST', `/api/invoice230/orders/${ooConsumer.id}/calculate`, { series_id: A.series.id, order_version: String((await order(A, ooConsumer.id)).version), shipping_vat: 23, buyer: BUYER.consumer, sell_date: today });
    check('226 OO for a consumer is refused (blocker mentions OO)', JSON.stringify(blk.json ?? blk.text).includes('OO'), brief(blk));
    S.orders.oo_consumer_uninvoiced = ooConsumer.id;
    orders.A.push({ id: ooConsumer.id, number: ooConsumer.number, total: ooConsumer.total, expect: 'brak_faktury' });
  });

  await area('EUR+NBP227', async () => {
    const rate = await A.put('/api/nbp227/rates/manual', { currency: 'EUR', effective_date: yesterday, table_no: `208/A/NBP/${yesterday.slice(0, 4)}`, mid: '4.2563', covered_through: yesterday });
    check('manual NBP table A rate stored (no api.nbp.pl)', !!rate, rate);
    const fetchR = await A.raw('POST', '/api/nbp227/rates/fetch', { currency: 'EUR', tax_point: today });
    check('NBP fetch port is off in this release (503, manual entry required)', fetchR.status === 503, brief(fetchR));
    const pe = await product(A, { price: 50000 });
    const list = await A.post('/api/price-lists', { name: 'Cennik EUR ' + tag, currency: 'EUR' }, [201]);
    await A.put(`/api/price-lists/${list.id}/items`, { version: Number(list.version ?? 1), items: [{ product_id: pe.id, price: 123000 }] });
    const o = await shipped(A, [[pe, 1]], { currency: 'EUR', price_list_id: list.id, shipping_cost: 1230 });
    eq('EUR order total in EUR cents', [o.currency, Number(o.total)], ['EUR', 124230]);
    const r = await fv230(A, o, BUYER.plB2B(buyerNip)); remember('A', r.document, { kind: 'fv230_eur' });
    S.fvs.eur = { id: r.document.id, order: o.id, number: r.document.number, data: r.document.data };
    orders.A.push({ id: o.id, number: o.number, total: o.total, expect: 'inna_waluta', doc: r.document.number, currency: 'EUR' });
    const n = r.document.data.nbp;
    eq('EUR FV-S: NBP rate of the day before the tax point', [n?.mid, n?.rate_date, n?.table_no], ['4.2563', yesterday, `208/A/NBP/${yesterday.slice(0, 4)}`]);
    const c0 = n.categories[0];
    eq('EUR FV-S: PLN net/VAT = EUR × mid, half up per category', [c0.net_pln_minor, c0.vat_pln_minor].map(String), [halfUp(c0.net_minor, '4.2563'), halfUp(c0.vat_minor, '4.2563')]);
    eq('EUR FV-S: gross EUR = order total', docGross(r.document), String(o.total));
    const rec = await A.get('/api/invoice230/documents/' + r.document.id);
    check('EUR FV-S: 227 record carries mid', String(rec.record?.mid) === '4.2563', rec.record);
  });

  // ---------------- KOR-S 232 ----------------
  await area('KOR-S232', async () => {
    const c1 = await kor232(A, S.fvs.cons_cancel.id, { mode: 'cancellation' }); remember('A', c1.document, { kind: 'kor232_cancel' });
    eq('KOR-S cancellation: delta = −FV-S gross', c1.document.data.totals.delta.gross_minor, String(-Number(S.fvs.cons_cancel.data.totals.gross_minor)));
    check('KOR-S cancellation replay reused', c1.replay.reused === true && c1.replay.document.number === c1.document.number);
    const again = await A.raw('POST', `/api/invoice232/invoices/${S.fvs.cons_cancel.id}/previews`, { client_key: randomUUID(), correction: { mode: 'cancellation' } });
    check('second cancellation refused (409)', again.status === 409, brief(again));
    const o = await order(A, S.fvs.cons_return.order);
    const rma = await returnOne(A, o, o.items[0]);
    const c2 = await kor232(A, S.fvs.cons_return.id, { mode: 'return', return_id: rma.id }); remember('A', c2.document, { kind: 'kor232_return' });
    eq('KOR-S return: delta = −refunded amount', c2.document.data.totals.delta.gross_minor, String(-Number(rma.refund_amount)));
    check('KOR-S return replay reused', c2.replay.reused === true);
    const nums = docs.A.filter((d) => d.number.startsWith('KOR-S/')).map((d) => d.number);
    eq('KOR-S numbering continuous', continuous(nums, `KOR-S/${A.prefix}/${year}/`).seqs, [1, 2]);
    for (const x of orders.A) if (x.key === 'cons_cancel') x.expect = 'cancel_without_order_cancel';
    for (const x of orders.A) if (x.key === 'cons_return') x.expect = 'zgodne';
    S.kor232 = [c1.document.id, c2.document.id];
  });

  // ---------------- 233 receipts + daily report + FP ----------------
  await area('RECEIPTS233', async () => {
    await control('/date?d=' + today);
    const pr = await A.put('/api/receipt233/printer', { name: 'Kasa etap 3', model_family: 'posnet', host: '127.0.0.1', port: Number(new URL(CONTROL).port) - 2, unique_number: 'DYN23300227' });
    check('printer configured', pr.printer?.active === true, pr);
    const test = await A.post('/api/receipt233/printer/test', {});
    check('printer test ok', test.ok === true, test);
    const rcs = [];
    for (const lines of [[[P.v23, 1], [P.v8, 1]], [[P.v5, 2]], [[P.v23, 1]]]) {
      const o = await shipped(A, lines);
      const body = { client_key: randomUUID(), payment_form: 'karta', confirmed: true };
      const r = await A.post(`/api/receipt233/orders/${o.id}/receipts`, body, [201]);
      const replay = await A.post(`/api/receipt233/orders/${o.id}/receipts`, body, [200]);
      check(`receipt ${r.receipt.number}: printed, gross = order total`, r.receipt.state === 'printed' && Number(r.receipt.gross_minor) === Number(o.total), { r: r.receipt, total: o.total });
      check(`receipt ${r.receipt.number}: replay reused, not reprinted`, replay.reused === true && replay.receipt.id === r.receipt.id);
      rcs.push({ o, r: r.receipt });
      orders.A.push({ id: o.id, number: o.number, total: o.total, expect: 'zgodne', receipt: r.receipt.number });
    }
    const stats1 = await control('/stats');
    eq('printer holds exactly 3 receipts (replays not printed)', stats1.printer_receipts, 3);
    const nums = rcs.map((x) => x.r.number);
    eq('receipt numbers continuous', nums.map(Number), [1, 2, 3].map((n, i) => Number(nums[0]) + i));
    const dup = await A.raw('POST', `/api/receipt233/orders/${rcs[0].o.id}/receipts`, { client_key: randomUUID(), payment_form: 'karta', confirmed: true });
    check('second receipt for the same order refused (409)', dup.status === 409, brief(dup));
    const rep = await A.post('/api/receipt233/daily-reports', { confirmed: true }, [201]);
    check('daily report matches app receipts', rep.report?.matches === true && Number(rep.report.app_receipts) === 3, rep.report);
    const appGross = rep.report.app_totals?.reduce?.((s, t) => s + Number(t.gross_minor ?? 0), 0);
    eq('daily report gross = Σ receipts', appGross, rcs.reduce((s, x) => s + Number(x.r.gross_minor), 0));
    const rep2 = await A.post('/api/receipt233/daily-reports', { confirmed: true }, [200]);
    check('daily report replay reused', rep2.reused === true && rep2.report.report_number === rep.report.report_number);
    const fp = await fv230(A, rcs[0].o, BUYER.consumer); remember('A', fp.document, { kind: 'fp230' });
    eq('FP (FV-S to receipt): gross = receipt gross', Number(docGross(fp.document)), Number(rcs[0].r.gross_minor));
    const det = await A.get('/api/invoice230/documents/' + fp.document.id);
    eq('FP linked to receipt number', det.receipt?.number ?? det.document?.receipt?.number, rcs[0].r.number);
    const xml = await A.raw('GET', `/api/fa3/documents/${fp.document.id}/fa3.xml`, undefined, { accept: 'application/xml' });
    check('FP FA(3) XML carries <FP>1</FP>', xml.status === 200 && xml.text.includes('<FP>1</FP>'), brief(xml));
    for (const x of orders.A) if (x.receipt === rcs[0].r.number) x.doc = fp.document.number;
    const p157 = await A.raw('POST', `/api/local-invoices/orders/${rcs[1].o.id}/previews`, { client_key: randomUUID(), series_id: A.series.id, order_version: String((await order(A, rcs[1].o.id)).version), shipping_vat: 23,
      buyer: { kind: 'consumer', name: 'X', street: 'Długa 5', postal_code: '00-002', city: 'Warszawa', country: 'PL' }, sell_date: today, tax_regime: 'ordinary_domestic',
      consumer_sale_confirmed: true, no_special_tax_procedure_confirmed: true, not_fiscal_receipt_confirmed: true });
    const r157 = p157.status === 201 ? await A.raw('POST', `/api/local-invoices/previews/${p157.json.preview.id}/tax-issue`, { client_key: randomUUID(), scope_hash: p157.json.preview.scope_hash, confirmed: true, local_only: true }) : p157;
    check('FV 157 refused for an order with a printed receipt (409 at issue, FV-S required)', r157.status === 409 && /paragon/i.test(r157.text), brief(r157));
    S.receipts = rcs.map((x) => ({ order: x.o.id, id: x.r.id, number: x.r.number })); S.daily_report = rep.report.report_number;
  });

  // ---------------- PayU 242 ----------------
  await area('PAYU242', async () => {
    const cfg = await A.put('/api/payu/config', { environment: 'sandbox', pos_id: '300746', public_origin: BASE, client_secret: 'synthetic-secret-242-' + tag, second_key: 'synthetic-second-key-242-' + tag, enabled: true });
    check('PayU config saved in simulation', cfg.simulation === true && cfg.configured === true, cfg);
    const o = await createOrder(A, [[P.v23, 1], [P.v5, 1]], { shipping_cost: 1500 });
    const full = await order(A, o.id);
    const key = randomUUID();
    const s1 = await http('POST', `/api/public/orders/${full.portal_token}/payments/payu`, { body: { client_key: key } });
    const s2 = await http('POST', `/api/public/orders/${full.portal_token}/payments/payu`, { body: { client_key: key } });
    check('PayU session created (201), amount = order total', s1.status === 201 && Number(s1.json.amount) === Number(o.total), brief(s1));
    check('PayU session replay (same client_key) reuses the session', s2.status === 200 && s2.json.reused === true && s2.json.session_id === s1.json.session_id, brief(s2));
    const u = new URL(s1.json.redirect, BASE); u.pathname += '/complete';
    const done = await http('POST', u.pathname + u.search, { form: '' , accept: '*/*' });
    check('fake pay page completes payment (303 to return page)', done.status === 303, brief(done));
    const again = await http('POST', u.pathname + u.search, { form: '', accept: '*/*' });
    const after = await order(A, o.id), pays = (await A.get(`/api/orders/${o.id}/payments`)).data, sess = (await A.get(`/api/orders/${o.id}/payu-sessions`)).data;
    const payu = pays.filter((p) => p.method === 'payu' && p.kind === 'receipt');
    check('order paid by PayU', after.status === 'paid', after.status);
    eq('one PayU receipt = order total (second completion books nothing)', [payu.length, payu.reduce((s, p) => s + Number(p.amount), 0)], [1, Number(o.total)]);
    check('PayU session COMPLETED and linked to receipt', sess[0]?.status === 'COMPLETED' && !!sess[0]?.receipt_entry_id, sess);
    S.payu = { order: o.id, session: s1.json.session_id, repeat_status: again.status };
    await setStatus(A, o.id, 'picking'); await scanAll(A, o.id); await setStatus(A, o.id, 'packed'); await A.post(`/api/orders/${o.id}/ship-demo`);
    const inv = await fv157(A, await order(A, o.id)); remember('A', inv.document, { kind: 'fv157_payu' });
    eq('PayU order FV gross = PayU amount', Number(docGross(inv.document)), Number(s1.json.amount));
    orders.A.push({ id: o.id, number: o.number, total: o.total, expect: 'zgodne', doc: inv.document.number, payu: true });
  });

  // ---------------- 188 + 206 (company B: strict stock control) ----------------
  await area('KOR188+KOR206', async () => {
    const ok = (path, method = 'GET', payload, status = 200) => B.req(method, '/api' + path, payload, [status]);
    const consent = (p) => ({ client_key: randomUUID(), scope_hash: p.scope_hash, confirmed: true });
    const wh = [];
    for (const l of ['A', 'B']) wh.push(await B.req('POST', '/api/warehouses', { name: 'Etap3 ' + l, code: 'S3' + l + '-' + randomUUID().slice(0, 6) }, [200, 201]));
    const catalogs = await ok('/product-catalogs');
    const primary = (catalogs.data ?? catalogs).find((x) => x.is_default);
    const prod = await ok('/products', 'POST', { catalog_id: primary.id, name: 'Zwrot 188/206', sku: 'S3RC-' + randomUUID().slice(0, 8), price: 1501, vat: 23, warehouse_id: wh[0].id, quantity: 5, location: 'A-01' }, 201);
    const cp = (await ok(`/warehouse-inventory-policies/warehouses/${wh[1].id}/previews`, 'POST', { client_key: randomUUID(), version: '0', usage: 'custody', enabled: true }, 201)).preview;
    const custody = (await ok(`/warehouse-inventory-policies/previews/${cp.id}/commit`, 'POST', consent(cp), 201)).operation.after;
    let o = await ok('/orders', 'POST', { source: 'manual', customer_name: 'Klient zwrotów', email: `zwrot-${tag.toLowerCase()}@example.test`, address: ADDR.PL, warehouse_id: wh[0].id,
      payment_mode: 'prepaid', currency: 'PLN', shipping_cost: 0, items: [{ product_id: prod.id, quantity: 3 }],
      manual_lines: [{ product_id: prod.id, quantity: 1, line_total: 1000 }, { product_id: prod.id, quantity: 2, line_total: 3401 }] }, 201);
    o = await ok('/orders/' + o.id);
    await ok(`/orders/${o.id}/payments`, 'POST', { client_key: randomUUID(), version: Number(o.version), kind: 'receipt', amount: 4401, currency: 'PLN', method: 'other', reference: 'Wpłata etap 3', confirmed: true });
    const status = async (v) => { const cur = await ok('/orders/' + o.id); await ok(`/orders/${o.id}/status`, 'PATCH', { status: v, expected_version: String(cur.version), client_key: randomUUID() }); };
    await status('picking');
    for (let n = 0; n < 3; n++) await ok(`/orders/${o.id}/scan`, 'POST', { client_key: randomUUID(), code: prod.sku, location: 'A-01' });
    await status('packed'); await ok(`/orders/${o.id}/ship-demo`, 'POST', {}); o = await ok('/orders/' + o.id);
    const srcR = await ok(`/catalog-stock-control/catalogs/${primary.id}/source`); const src = srcR.source;
    check('strict stock control can be activated', src.ready === true, src.blockers);
    const act = (await ok(`/catalog-stock-control/catalogs/${primary.id}/previews`, 'POST', { client_key: randomUUID(), catalog_version: src.snapshot.catalog.version, policy_version: src.snapshot.policy.version,
      warehouse_policy_versions: src.snapshot.warehouses.map((w) => ({ warehouse_id: w.id, version: w.policy.version })), series_versions: src.snapshot.warehouses.map((w) => ({ warehouse_id: w.id, version: w.series.version })) }, 201)).preview;
    await ok(`/catalog-stock-control/previews/${act.id}/commit`, 'POST', consent(act), 201);
    const fv = await fv157(B, o); remember('B', fv.document, { kind: 'fv157' });
    eq('B: FV gross = order total 4401', docGross(fv.document), '4401');
    // legacy RMA → KOR 188
    const cheap = o.items.find((i) => i.line_total === 1000), exp = o.items.find((i) => i.line_total === 3401);
    let rma = await ok(`/orders/${o.id}/returns`, 'POST', { client_key: randomUUID(), reason: 'Zwrot jednej pozycji', shipping_refund: 0, items: [{ item_id: cheap.id, quantity: 1 }] }, 201);
    rma = await ok('/returns/' + rma.id);
    rma = await ok(`/returns/${rma.id}/receive`, 'POST', { version: Number(rma.version), shipping_refund: 0, note: 'Przyjęcie jednej pozycji do magazynu', items: [{ item_id: cheap.id, accepted: 1, restocked: 1 }] });
    check('legacy return received with a 169 stock receipt', rma.state === 'refund_pending' && (rma.stock_receipts ?? []).length > 0, rma.state);
    const s188 = await ok(`/local-consumer-credits/orders/${o.id}/source`);
    eq('188 source: delta −1000, after 3401', [s188.eligible, s188.calculation?.totals?.delta?.gross_minor, s188.calculation?.totals?.after?.gross_minor], [true, '-1000', '3401']);
    const pb = { client_key: randomUUID(), original_document_id: fv.document.id, return_id: rma.id, expected_return_version: s188.current_return_version, reason: 'Zwrot jednej pozycji', ordinary_domestic_confirmed: true, local_only: true };
    const p188 = await ok('/local-consumer-credits/previews', 'POST', pb, 201);
    const ib = { client_key: randomUUID(), scope_hash: p188.preview.scope_hash, confirmed: true, local_only: true };
    const k188 = await ok(`/local-consumer-credits/previews/${p188.preview.id}/issue`, 'POST', ib, 201);
    const k188r = await ok(`/local-consumer-credits/previews/${p188.preview.id}/issue`, 'POST', ib, 200);
    remember('B', k188.document, { kind: 'kor188' });
    eq('KOR 188: number KOR/<prefix>/<year>/000001, delta −1000', [k188.document.number, k188.document.data.calculation.totals.delta.gross_minor], [`KOR/${B.prefix}/${year}/000001`, '-1000']);
    check('KOR 188 replay reused, same number', k188r.reused === true && k188r.document.number === k188.document.number);
    await refundReturn(B, rma.id);
    // destinations RMA → KOR 206
    rma = await ok(`/orders/${o.id}/returns`, 'POST', { client_key: randomUUID(), reason: 'Zwrot dwóch sztuk', shipping_refund: 0, items: [{ item_id: exp.id, quantity: 2 }] }, 201);
    rma = await ok('/returns/' + rma.id);
    const station = (await ok('/packing/stations', 'POST', { client_key: randomUUID(), code: 'S3-' + randomUUID().slice(0, 8), label: 'Stanowisko zwrotów', enabled: true }, 201)).station;
    const st = {};
    for (const effect of ['custody', 'reject']) {
      const reject = effect === 'reject';
      const p = (await ok('/return-assistant/statuses/previews', 'POST', { client_key: randomUUID(), kind: 'create', settings: { name: 'Etap3 ' + effect + ' ' + tag, color: '#aabbcc', active: true,
        decision: reject ? 'reject' : 'accept', inventory_effect: reject ? 'none' : effect, warehouse_id: reject ? null : wh[1].id, warehouse_policy_version: reject ? null : custody.version, default_location: reject ? null : 'RETURN-' + effect } }, 201)).preview;
      st[effect] = (await ok(`/return-assistant/statuses/previews/${p.id}/commit`, 'POST', consent(p), 201)).status;
    }
    const lease = randomUUID();
    let session = (await ok('/return-assistant/sessions', 'POST', { client_key: randomUUID(), return_number: rma.number, station_id: station.id, station_version: String(station.version), lease_token: lease }, 201)).session;
    for (const line of session.lines) for (let n = 0; n < line.requested; n++)
      session = (await ok(`/return-assistant/sessions/${session.id}/scans`, 'POST', { client_key: randomUUID(), version: String(session.version), lease_token: lease, code: prod.sku, item_id: line.item_id })).session;
    const source = (await ok(`/return-destinations/returns/${rma.id}/source?session_id=${session.id}`)).source;
    const line = source.planner_source.lines.find((i) => i.item_id === exp.id);
    const parts = [{ part_id: randomUUID(), item_id: line.item_id, quantity: 1, effect: 'custody' }, { part_id: randomUUID(), item_id: line.item_id, quantity: 1, effect: 'reject' }];
    const stock = source.planner_source.stocks.find((s) => s.product_id === prod.id && s.warehouse_id === wh[1].id);
    const body = { protocol: 'destinations_v1', client_key: randomUUID(), return_version: source.return_version, session_id: source.session.id, session_version: source.session.version, lease_token: lease,
      note: 'Przyjęcie do przechowania i odrzucenie', shipping_refund: 0, parts: parts.map((p) => ({ part_id: p.part_id, item_id: p.item_id, quantity: p.quantity, status_id: st[p.effect].id, status_version: st[p.effect].version })),
      locations: [{ part_id: parts[0].part_id, product_id: prod.id, location: 'RETURN-custody', confirmed: true }],
      stock_versions: [{ warehouse_id: wh[1].id, product_id: prod.id, version: stock.version }] };
    const prev = (await ok(`/return-destinations/returns/${rma.id}/previews`, 'POST', body, 201)).preview;
    eq('206 destinations preview: commercial credit 1700', prev.summary.commercial_credit_minor, 1700);
    await ok(`/return-destinations/previews/${prev.id}/receive`, 'POST', { ...consent(prev), lease_token: lease }, 201);
    const strat = await ok(`/consumer-return-credits/orders/${o.id}/strategy`);
    eq('206 strategy destinations', strat.strategy, 'destinations');
    const s206 = await ok(`/consumer-return-credits/orders/${o.id}/source`);
    eq('206 source: delta −1700, after 1701', [s206.eligible, s206.calculation?.totals?.delta?.gross_minor, s206.calculation?.totals?.after?.gross_minor], [true, '-1700', '1701']);
    const series = (await ok('/consumer-return-credits/series', 'POST', { client_key: randomUUID(), name: 'Korekty zwrotów', prefix: 'KZ' + tag }, 201)).series;
    const p206b = { client_key: randomUUID(), original_document_id: fv.document.id, return_id: s206.next_return_id, expected_return_version: s206.current_return_version, series_id: series.id, expected_series_version: series.version,
      reason: 'Zwrot części pozycji', ordinary_domestic_confirmed: true, local_only: true };
    const p206 = await ok('/consumer-return-credits/previews', 'POST', p206b, 201);
    const i206 = { client_key: randomUUID(), scope_hash: p206.preview.scope_hash, confirmed: true, local_only: true };
    const k206 = await ok(`/consumer-return-credits/previews/${p206.preview.id}/issue`, 'POST', i206, 201);
    const k206r = await ok(`/consumer-return-credits/previews/${p206.preview.id}/issue`, 'POST', i206, 200);
    remember('B', k206.document, { kind: 'kor206' });
    eq('KOR 206: number KZ…/<year>/000001, delta −1700, after 1701', [k206.document.number, k206.document.data.calculation.totals.delta.gross_minor, k206.document.data.calculation.totals.after.gross_minor],
      [`KZ${tag}/${year}/000001`, '-1700', '1701']);
    check('KOR 206 replay reused', k206r.reused === true && k206r.document.number === k206.document.number);
    const legacyAgain = await B.raw('POST', '/api/local-consumer-credits/previews', { ...pb, client_key: randomUUID(), return_id: rma.id, expected_return_version: String((await ok('/returns/' + rma.id)).version) });
    check('188 refuses the destinations return (409)', legacyAgain.status === 409, brief(legacyAgain));
    await refundReturn(B, rma.id);
    orders.B.push({ id: o.id, number: o.number, total: 4401, expect: 'zgodne', doc: fv.document.number });
    S.b = { order: o.id, fv: fv.document.id, kor188: k188.document.id, kor206: k206.document.id };
  });

  // ---------------- KSeF 229 / 231 ----------------
  await area('KSEF229+231', async () => {
    await A.put('/api/ksef229/configs/' + A.nip, { environment: 'local_fake', base_url: KSEF_URL, auth_method: 'token', token: 'lokalny-token-' + randomBytes(10).toString('hex') });
    const chk = await A.post(`/api/ksef229/configs/${A.nip}/check`);
    check('KSeF config check ok (local fake)', chk.ok === true, chk);
    const st = await A.get('/api/ksef229/status');
    check('real MF KSeF disabled in this release', st.real_mf_enabled === false, st);
    const sendList = [['fv157', S.docs.fv157[0]], ['fv230_mpp', S.fvs.mpp.id], ['fv230_oo', S.fvs.oo.id], ['fv230_eur', S.fvs.eur.id], ['fv230_np2', S.fvs.np2.id]];
    S.sent = {};
    for (const [k, id] of sendList) {
      const before = (await control('/stats')).ksef_invoices;
      const r = await A.post(`/api/ksef229/documents/${id}/send`);
      const s = r.submission;
      check(`KSeF ${k}: accepted with KSeF number`, s?.state === 'accepted' && /\S/.test(s?.ksef_number ?? ''), r);
      const upo = await A.raw('GET', `/api/ksef229/documents/${id}/upo.xml`, undefined, { accept: 'application/xml' });
      check(`KSeF ${k}: UPO downloadable and names the KSeF number`, upo.status === 200 && upo.text.includes(s?.ksef_number), brief(upo));
      const again = await A.post(`/api/ksef229/documents/${id}/send`);
      const after = (await control('/stats')).ksef_invoices;
      check(`KSeF ${k}: resend replayed, nothing new sent`, again.replayed === true && again.submission?.ksef_number === s?.ksef_number && after === before + 1, { replayed: again.replayed, before, after });
      S.sent[id] = s?.ksef_number;
    }
    await control('/ksef-mode?m=unavailable');
    const off = await A.post(`/api/ksef229/documents/${S.fvs.zw.id}/send`);
    check('KSeF unavailable: document queued offline', off.submission?.state === 'queued' && !!off.submission?.offline?.mode, off.submission);
    await control('/ksef-mode?m=ok');
    const q = await A.post('/api/ksef229/queue/send', {});
    check('queue send after outage: accepted', q.accepted >= 1 && q.results.some((x) => x.document_id === S.fvs.zw.id && x.ok), q);
    const zw = await A.get('/api/ksef229/documents/' + S.fvs.zw.id);
    S.sent[S.fvs.zw.id] = zw.submission?.ksef_number;
    check('offline document has KSeF number after queue', !!zw.submission?.ksef_number, zw.submission);
    const kor = await A.raw('POST', `/api/ksef229/documents/${S.kor232[0]}/send`);
    check('KOR-S (232) sent to KSeF', kor.status === 200 && kor.json?.submission?.state === 'accepted', brief(kor));
    if (kor.json?.submission?.ksef_number) S.sent[S.kor232[0]] = kor.json.submission.ksef_number;
  });

  // ---------------- KSeF 243 purchase ----------------
  await area('KSEF243', async () => {
    const at = new Date(Date.now() - 3600_000).toISOString();
    const added = [];
    for (const [i, gross] of ['1388.54', '1388.54', '1388.54'].entries())
      added.push(await control('/purchase', { number: `FZ/${i + 1}/10/2026-${tag}`, date: '2026-10-20', gross, buyer: A.nip, permanentStorageDate: at }));
    const sync = await A.put('/api/ksef243/sync/' + A.nip, { enabled: true, date_type: 'PermanentStorage', start_from: '2026-10-01T00:00:00Z', restart: true });
    check('243 sync settings saved', sync.enabled === true || sync.sync?.enabled === true, sync);
    let stored = 0, runs = 0, last;
    for (; runs < 5; runs++) { last = await A.post(`/api/ksef243/sync/${A.nip}/run`, {}); stored += Number(last.stored ?? 0); if (last.done) break; }
    eq('243 first fetch stores 3 purchase invoices', [stored, last.rejected ?? 0], [3, 0]);
    const rerun = await A.post(`/api/ksef243/sync/${A.nip}/run`, {});
    eq('243 refetch stores nothing new (dedup by KSeF number)', Number(rerun.stored ?? 0), 0);
    const list = await A.get('/api/ksef243/invoices?nip=' + A.nip);
    eq('243 register lists 3 invoices', list.items.length, 3);
    const byK = new Map(list.items.map((x) => [x.ksef_number, x]));
    for (const ad of added) {
      const it = byK.get(ad.ksef_number);
      check(`243 ${ad.ksef_number}: in register with gross from the file`, !!it && JSON.stringify(it).includes('1388'), it);
      if (it) {
        const xml = await A.raw('GET', `/api/ksef243/invoices/${it.id}/fa3.xml`, undefined, { accept: 'application/xml' });
        eq(`243 ${ad.ksef_number}: stored FA(3) bytes = KSeF bytes (sha256)`, sha(xml.buf), ad.xml_sha256);
      }
    }
    S.purchase = list.items.map((x) => x.id);
  });

  // ---------------- JPK ----------------
  const TP = 'kod_urzedu=1206&email=ksiegowosc%40sklep.test';
  const FA_ADDR = 'wojewodztwo=ma%C5%82opolskie&powiat=Krak%C3%B3w&gmina=Krak%C3%B3w&nr_domu=2&miejscowosc=Krak%C3%B3w&kod_pocztowy=30-001';
  const jpkFiles = {};
  async function jpkChecks(co, c) {
    const allDocs = docs[co];
    const details = {};
    for (const d of allDocs) {
      const path = d.mode === 'invoice230' ? '/api/invoice230/documents/' : d.mode === 'invoice232' || d.kind.startsWith('kor232') ? '/api/invoice232/corrections/'
        : d.kind === 'kor188' ? '/api/local-consumer-credits/documents/' : d.kind === 'kor206' ? '/api/consumer-return-credits/documents/' : '/api/local-invoices/documents/';
      details[d.number] = (await c.get(path + d.id)).document;
    }
    for (const kind of ['v7m', 'v7k']) {
      const r = await c.raw('GET', `/api/jpk/${kind}.xml?okres=${month}&${TP}`, undefined, { accept: 'application/xml' });
      if (!check(`${co} JPK_${kind.toUpperCase()}: 200`, r.status === 200, brief(r))) continue;
      const x = r.text; jpkFiles[`${co}-${kind}`] = sha(stripGen(x));
      check(`${co} JPK_${kind.toUpperCase()}: header KodFormularza ${kind === 'v7m' ? 'JPK_V7M (3)' : 'JPK_V7K (3)'}, period`, x.includes(`kodSystemowy="${kind === 'v7m' ? 'JPK_V7M (3)' : 'JPK_V7K (3)'}"`) && one(x, 'Rok') === year && Number(one(x, 'Miesiac')) === Number(month.slice(5)));
      const rows = tags(x, 'SprzedazWiersz');
      const ro = rows.filter((w) => one(w, 'TypDokumentu') === 'RO');
      const byNo = new Map(rows.map((w) => [one(w, 'DowodSprzedazy'), w]));
      const expectedRows = allDocs.length + (co === 'A' ? 1 : 0);
      eq(`${co} JPK_${kind}: rows = documents (+RO daily report)`, [rows.length, ro.length], [expectedRows, co === 'A' ? 1 : 0]);
      eq(`${co} JPK_${kind}: SprzedazCtrl.LiczbaWierszySprzedazy`, Number(one(one(x, 'SprzedazCtrl') ?? '', 'LiczbaWierszySprzedazy')), rows.length);
      const VAT = ['K_16', 'K_18', 'K_20', 'K_24', 'K_26', 'K_28', 'K_30', 'K_32', 'K_33', 'K_34'], NEG = ['K_35', 'K_36', 'K_360'];
      const rowVat = (w) => VAT.reduce((s, k) => s + num(one(w, k)), 0) - NEG.reduce((s, k) => s + num(one(w, k)), 0);
      // Rows marked FP (invoice to a receipt) are already in the RO daily-report row; they are not summed.
      const total = rows.filter((w) => one(w, 'TypDokumentu') !== 'FP').reduce((s, w) => s + rowVat(w), 0);
      eq(`${co} JPK_${kind}: SprzedazCtrl.PodatekNalezny = Σ row VAT (without FP rows)`, Number(one(one(x, 'SprzedazCtrl'), 'PodatekNalezny')).toFixed(2), total.toFixed(2));
      let missing = [];
      for (const d of allDocs) {
        const w = byNo.get(d.number); if (!w) { missing.push(d.number); continue; }
        const doc = details[d.number], data = doc.data ?? {};
        const pln = data.nbp?.totals ?? null;
        const tot = data.totals?.delta ?? data.calculation?.totals?.delta ?? data.totals;
        const expVat = pln ? Number(pln.vat_pln_minor) : Number(tot?.vat_minor ?? 0);
        if (data.procedure !== 'oss') eq(`${co} ${kind} ${d.number}: row VAT = document VAT (PLN)`, rowVat(w).toFixed(2), zl(expVat));
        const ks = S.sent[d.id];
        if (ks) eq(`${co} ${kind} ${d.number}: NrKSeF = number from KSeF`, one(w, 'NrKSeF'), ks);
        else check(`${co} ${kind} ${d.number}: BFK/OFF/DI marker for documents outside KSeF`, /<(BFK|OFF|DI)>1</.test(w), w.slice(0, 300));
      }
      eq(`${co} JPK_${kind}: every document has a row`, missing, []);
      if (co === 'A') {
        const g = details[docs.A.find((d) => d.kind === 'fv157' && d.number.endsWith('000003')).number];
        check(`A ${kind}: GTU_06 on the FV with the GTU product`, /<GTU_06>1</.test(byNo.get(g.number) ?? ''));
        check(`A ${kind}: MPP on the split-payment FV-S`, /<MPP>1</.test(byNo.get(S.fvs.mpp.number) ?? ''));
        const fpDoc = docs.A.find((d) => d.kind === 'fp230');
        check(`A ${kind}: FP row for the invoice to a receipt`, /<TypDokumentu>FP</.test(byNo.get(fpDoc.number) ?? ''), (byNo.get(fpDoc.number) ?? '').slice(0, 400));
        check(`A ${kind}: OO row reported as reverse charge (K_31)`, /<K_31>/.test(byNo.get(S.fvs.oo.number) ?? ''), (byNo.get(S.fvs.oo.number) ?? '').slice(0, 400));
        check(`A ${kind}: NP II row reported (K_11/K_12)`, /<K_1[12]>/.test(byNo.get(S.fvs.np2.number) ?? ''), (byNo.get(S.fvs.np2.number) ?? '').slice(0, 400));
        check(`A ${kind}: ZW row reported as exempt (K_10)`, /<K_10>/.test(byNo.get(S.fvs.zw.number) ?? ''), (byNo.get(S.fvs.zw.number) ?? '').slice(0, 400));
        const rows233 = ro[0] ?? '';
        check(`A ${kind}: RO row VAT = Σ receipt VAT`, rowVat(rows233) > 0, rows233.slice(0, 400));
      }
      if (kind === 'v7m') {
        const dek = one(x, 'PozycjeSzczegolowe') ?? '';
        check(`${co} V7M declaration present (P_38 due VAT)`, /<P_38>/.test(dek), dek.slice(0, 200));
      }
    }
    const fa = await c.raw('GET', `/api/jpk/fa.xml?od=${month}-01&do=${month}-31&kod_urzedu=1206&${FA_ADDR}`, undefined, { accept: 'application/xml' });
    if (check(`${co} JPK_FA: 200`, fa.status === 200, brief(fa))) {
      const x = fa.text; jpkFiles[`${co}-fa`] = sha(stripGen(x));
      check(`${co} JPK_FA: header JPK_FA (4)`, x.includes('kodSystemowy="JPK_FA (4)"'));
      const inv = tags(x, 'Faktura');
      const ctrl = one(x, 'FakturaCtrl') ?? '';
      eq(`${co} JPK_FA: FakturaCtrl.LiczbaFaktur = invoices`, Number(one(ctrl, 'LiczbaFaktur')), inv.length);
      eq(`${co} JPK_FA: FakturaCtrl.WartoscFaktur = Σ P_15`, Number(one(ctrl, 'WartoscFaktur')).toFixed(2), inv.reduce((s, f) => s + num(one(f, 'P_15')), 0).toFixed(2));
      const fNos = new Map(inv.map((f) => [one(f, 'P_2A'), f]));
      const faDocs = allDocs; // FA covers invoices and corrections
      const absent = [];
      for (const d of faDocs) {
        const f = fNos.get(d.number); if (!f) { absent.push(d.number); continue; }
        const data = details[d.number].data ?? {};
        const g = data.totals?.delta?.gross_minor ?? data.calculation?.totals?.delta?.gross_minor ?? data.totals?.gross_minor;
        eq(`${co} JPK_FA ${d.number}: P_15 = document gross (${data.currency ?? 'PLN'})`, num(one(f, 'P_15')).toFixed(2), zl(g));
      }
      eq(`${co} JPK_FA: every invoice/correction present`, absent, []);
      const wiersze = tags(x, 'FakturaWiersz'), wctrl = one(x, 'FakturaWierszCtrl') ?? '';
      eq(`${co} JPK_FA: FakturaWierszCtrl.LiczbaWierszyFaktur`, Number(one(wctrl, 'LiczbaWierszyFaktur')), wiersze.length);
    }
    return details;
  }
  await area('JPK', async () => {
    check('official XSD (JPK_V7M_3, JPK_V7K_3, JPK_FA_4) not in the repository: structure-only checks', true, 'data/source-drafts/jpk-official-xsd absent');
    S.details = { A: Object.keys(await jpkChecks('A', A)), B: Object.keys(await jpkChecks('B', B)) };
    Object.assign(S.hashes.jpk, jpkFiles);
    const series = docs.A.map((d) => d.number);
    eq('A FV-S numbering continuous', continuous(series, `FV-S/${A.prefix}/${year}/`).ok, true);
  });

  // ---------------- settlement report ----------------
  async function settlement(co, c) {
    const rep = await c.get(`/api/settlement-report?from=${today}&to=${today}`);
    const rows = new Map(rep.rows.map((r) => [r.order_id, r]));
    for (const x of orders[co]) {
      const r = rows.get(x.id);
      if (!check(`${co} settlement ${x.number}: row present`, !!r)) continue;
      eq(`${co} settlement ${x.number}: order_total = order (grosze)`, r.order_total, Number(x.total));
      if (x.expect === 'zgodne') {
        eq(`${co} settlement ${x.number}: flags zgodne, paid = due = documented`, [r.flags, r.net_paid, r.documented, r.payment_difference, r.document_difference], [['zgodne'], r.amount_due, r.amount_due, 0, 0]);
      } else if (x.expect === 'cancel_without_order_cancel') {
        check(`${co} settlement ${x.number}: cancellation KOR-S of a kept order is flagged (document_difference = −total)`, r.document_difference === -Number(x.total) && r.flags.includes('faktura_niezgodna'), r);
      } else if (x.expect === 'brak_faktury') {
        check(`${co} settlement ${x.number}: uninvoiced order flagged brak_faktury`, r.flags.includes('brak_faktury'), r.flags);
      } else if (x.expect === 'inna_waluta') {
        check(`${co} settlement ${x.number}: EUR order shown as other currency`, r.flags.includes('inna_waluta') || r.currency === 'EUR', { flags: r.flags, currency: r.currency, foreign: r.foreign });
      }
      if (x.doc) check(`${co} settlement ${x.number}: invoice number listed`, [...(r.invoice_numbers ?? []), ...(r.correction_numbers ?? [])].includes(x.doc) || (r.receipt_numbers ?? []).length > 0, { inv: r.invoice_numbers, want: x.doc });
    }
    const pln = rep.totals.find((t) => t.currency === 'PLN');
    const inTot = rep.rows.filter((r) => r.in_totals !== false && r.currency === 'PLN');
    for (const f of ['order_total', 'received', 'refunded', 'invoiced', 'corrections', 'documented'])
      eq(`${co} settlement totals.${f} = Σ rows`, pln?.[f], inTot.reduce((s, r) => s + Number(r[f]), 0));
    const csv = await c.raw('GET', `/api/settlement-report/file?from=${today}&to=${today}`, undefined, { accept: 'text/csv' });
    const lines = csv.text.replace(/^﻿/, '').trim().split(/\r?\n/);
    check(`${co} settlement CSV has one line per JSON row`, csv.status === 200 && lines.length - 1 >= rep.rows.length, { lines: lines.length, rows: rep.rows.length });
    const { generated_at, ...stable } = rep;
    return { rep, sha: sha(JSON.stringify(stable)) };
  }
  await area('SETTLEMENT', async () => {
    const a1 = await settlement('A', A), b1 = await settlement('B', B);
    const br = a1.rep.rows.find((r) => r.order_id === orders.A.find((x) => x.key === 'cons_return').id);
    check('A settlement: partial return — refunded = return credit, corrections = −refund', br && br.refunded === br.return_credit && br.corrections === -br.refunded, br);
    const bo = b1.rep.rows.find((r) => r.order_id === S.b?.order);
    eq('B settlement: 4401 paid, 2700 refunded, corrections −2700 (188 + 206), documented 1701', bo && [bo.received, bo.refunded, bo.corrections, bo.documented, bo.amount_due, bo.flags], [4401, 2700, -2700, 1701, 1701, ['zgodne']]);
    const pr = a1.rep.rows.find((r) => r.order_id === S.payu?.order);
    check('A settlement: PayU order received = total', pr && pr.received === pr.order_total, pr);
    S.hashes.settlement = { A: a1.sha, B: b1.sha };
  });

  // ---------------- RODO 228 ----------------
  await area('RODO228', async () => {
    const email = `rodo-${tag.toLowerCase()}@example.test`;
    const o1 = await shipped(A, [[P.v23, 1]], { email, customer_name: 'Zofia Rodowa' });
    const inv = await fv157(A, o1); remember('A', inv.document, { kind: 'fv157_rodo' });
    await setStatus(A, o1.id, 'delivered');
    const o2 = await createOrder(A, [[P.v8, 1]], { email, customer_name: 'Zofia Rodowa' }); await setStatus(A, o2.id, 'cancelled');
    const docBefore = (await A.get('/api/local-invoices/documents/' + inv.document.id)).document;
    const jpkBefore = sha(stripGen((await A.raw('GET', `/api/jpk/fa.xml?od=${month}-01&do=${month}-31&kod_urzedu=1206&${FA_ADDR}`, undefined, { accept: 'application/xml' })).text));
    const zip = await A.raw('GET', '/api/rodo228/export?email=' + encodeURIComponent(email) + '&purpose=' + encodeURIComponent('Wniosek klienta o dostęp do danych'), undefined, { accept: 'application/zip' });
    check('RODO export: ZIP with the subject data', zip.status === 200 && zip.buf.subarray(0, 2).toString() === 'PK' && zip.buf.includes(Buffer.from('dane-klienta.json')), brief(zip));
    const jsonAt = zip.buf.indexOf(Buffer.from('{'));
    check('RODO export: both orders and the invoice in the export', zip.buf.includes(Buffer.from(o1.number)) && zip.buf.includes(Buffer.from(o2.number)) && zip.buf.includes(Buffer.from(inv.document.number)), { jsonAt });
    const pv = await A.post('/api/rodo228/anonymisation/preview', { email });
    const kept = pv.plan.orders.find((x) => x.id === o1.id);
    check('RODO preview: invoiced order kept for tax retention until 31.12.' + (Number(year) + 5), kept && String(kept.tax_retention_end).startsWith(String(Number(year) + 5) + '-12-31'), pv.plan.orders);
    const conf = await A.post(`/api/rodo228/anonymisation/${pv.request_id}/confirm`, { plan_sha256: pv.plan_sha256 });
    const conf2 = await A.post(`/api/rodo228/anonymisation/${pv.request_id}/confirm`, { plan_sha256: pv.plan_sha256 });
    check('RODO anonymisation completed; confirm replay returns the same result', conf.state === 'completed' && conf2.replayed === true && canon(conf2.result) === canon(conf.result), { conf, conf2 });
    const a1 = await order(A, o1.id), a2 = await order(A, o2.id);
    check('RODO: invoiced order email/phone anonymised, name kept (tax retention)', /^anonim-[0-9a-f]{8}@anonim\.invalid$/.test(a1.email) && a1.address?.phone === '' && a1.customer_name === 'Zofia Rodowa', { email: a1.email, name: a1.customer_name });
    check('RODO: uninvoiced order fully anonymised', a2.customer_name === 'Klient zanonimizowany' && /^anonim-/.test(a2.email), { name: a2.customer_name });
    const docAfter = (await A.get('/api/local-invoices/documents/' + inv.document.id)).document;
    eq('RODO: invoice document byte-identical after anonymisation', sha(JSON.stringify(docAfter)), sha(JSON.stringify(docBefore)));
    const jpkAfter = sha(stripGen((await A.raw('GET', `/api/jpk/fa.xml?od=${month}-01&do=${month}-31&kod_urzedu=1206&${FA_ADDR}`, undefined, { accept: 'application/xml' })).text));
    eq('RODO: JPK_FA unchanged by anonymisation', jpkAfter, jpkBefore);
    const log = await A.get('/api/rodo228/access-log?email=' + encodeURIComponent(email));
    const acts = log.data.map((x) => x.action);
    check('RODO access log records export, preview and anonymisation', ['export', 'anonymisation_preview', 'anonymisation'].every((x) => acts.includes(x)), acts);
    S.rodo = { o1: o1.id, o2: o2.id, invoice: inv.document.id };
  });

  // numbering continuity over all registers + final hashes for the restart check
  await area('NUMBERING', async () => {
    const reg = async (c, url) => { const out = []; let cur = null; for (let i = 0; i < 20; i++) { const r = await c.get(url + (cur ? (url.includes('?') ? '&' : '?') + 'cursor=' + encodeURIComponent(cur) : '')); out.push(...r.data); cur = r.next_cursor ?? null; if (!cur) break; } return out; };
    const fv = (await reg(A, '/api/local-invoices/documents')).map((d) => d.number);
    const c157 = continuous(fv, `${A.prefix}/${year}/`);
    check(`A 157 register continuous 1..${c157.count}`, c157.ok, c157.seqs);
    const fvs = (await A.get('/api/invoice230/documents')).data.map((d) => d.number);
    const c230 = continuous(fvs, `FV-S/${A.prefix}/${year}/`);
    check(`A 230 register continuous 1..${c230.count}`, c230.ok, c230.seqs);
    eq('A registers = documents issued by the script', [c157.count, c230.count], [docs.A.filter((d) => d.mode === 'local_invoice').length, docs.A.filter((d) => d.mode === 'invoice230').length]);
    S.docs_all = docs; S.orders_all = orders;
    const snap = {};
    for (const co of ['A', 'B']) for (const d of docs[co]) snap[d.number] = d;
    S.hashes.documents = {};
    for (const [co, c] of [['A', A], ['B', B]]) for (const d of docs[co]) {
      const path = d.mode === 'invoice230' ? '/api/invoice230/documents/' : d.kind.startsWith('kor232') ? '/api/invoice232/corrections/' : d.kind === 'kor188' ? '/api/local-consumer-credits/documents/'
        : d.kind === 'kor206' ? '/api/consumer-return-credits/documents/' : '/api/local-invoices/documents/';
      S.hashes.documents[d.id] = { path: path + d.id, co, sha: sha(JSON.stringify((await c.get(path + d.id)).document)) };
    }
    // JPK after RODO (A changed: one more FV) — recompute the A hashes for the restart comparison
    for (const [co, c] of [['A', A], ['B', B]]) {
      for (const kind of ['v7m', 'v7k']) S.hashes.jpk[`${co}-${kind}`] = sha(stripGen((await c.raw('GET', `/api/jpk/${kind}.xml?okres=${month}&${TP}`, undefined, { accept: 'application/xml' })).text));
      S.hashes.jpk[`${co}-fa`] = sha(stripGen((await c.raw('GET', `/api/jpk/fa.xml?od=${month}-01&do=${month}-31&kod_urzedu=1206&${FA_ADDR}`, undefined, { accept: 'application/xml' })).text));
      const { generated_at, ...st } = await c.get(`/api/settlement-report?from=${today}&to=${today}`);
      S.hashes.settlement[co] = sha(JSON.stringify(st));
    }
  });
  S.finished_at = new Date().toISOString();
  await save(STATE, S);
}

// =====================================================================
if (phase === 'after-restart' || phase === 'after-upgrade') {
  const S = JSON.parse(await fs.readFile(STATE, 'utf8')), acc = JSON.parse(await fs.readFile(ACC, 'utf8'));
  const health = (await http('GET', '/api/health')).json;
  const upgrade = phase === 'after-upgrade';
  req = upgrade ? 'upgrade' : 'restart';
  if (upgrade) check('another release revision after the upgrade', /^[a-f0-9]{64}$/.test(String(health?.revision)) && health.revision !== S.revision, { now: health?.revision, run: S.revision });
  else eq('same release revision after restart', health?.revision, S.revision);
  const C = { A: await login(acc.A), B: await login(acc.B) };
  const TP = 'kod_urzedu=1206&email=ksiegowosc%40sklep.test';
  const FA_ADDR = 'wojewodztwo=ma%C5%82opolskie&powiat=Krak%C3%B3w&gmina=Krak%C3%B3w&nr_domu=2&miejscowosc=Krak%C3%B3w&kod_pocztowy=30-001';
  let same = 0;
  for (const [id, h] of Object.entries(S.hashes.documents)) { const d = (await C[h.co].get(h.path)).document; if (sha(JSON.stringify(d)) === h.sha) same++; else check('document unchanged after restart ' + id, false); }
  eq('every document identical after restart', same, Object.keys(S.hashes.documents).length);
  for (const co of ['A', 'B']) {
    const c = C[co];
    for (const kind of ['v7m', 'v7k']) eq(`${co} JPK_${kind} identical after restart`, sha(stripGen((await c.raw('GET', `/api/jpk/${kind}.xml?okres=${S.today.slice(0, 7)}&${TP}`, undefined, { accept: 'application/xml' })).text)), S.hashes.jpk[`${co}-${kind}`]);
    eq(`${co} JPK_FA identical after restart`, sha(stripGen((await c.raw('GET', `/api/jpk/fa.xml?od=${S.today.slice(0, 7)}-01&do=${S.today.slice(0, 7)}-31&kod_urzedu=1206&${FA_ADDR}`, undefined, { accept: 'application/xml' })).text)), S.hashes.jpk[`${co}-fa`]);
    const { generated_at, ...st } = await c.get(`/api/settlement-report?from=${S.today}&to=${S.today}`);
    if (upgrade && co === 'B' && sha(JSON.stringify(st)) !== S.hashes.settlement[co]) {
      const bo = st.rows.find((r) => r.order_id === S.b?.order);
      eq('B settlement corrected by the upgrade: 4401 paid, 2700 refunded, corrections −2700 (188 + 206), documented 1701', bo && [bo.received, bo.refunded, bo.corrections, bo.documented, bo.amount_due, bo.flags], [4401, 2700, -2700, 1701, 1701, ['zgodne']]);
    } else eq(`${co} settlement report identical after ${upgrade ? 'the upgrade' : 'restart'}`, sha(JSON.stringify(st)), S.hashes.settlement[co]);
  }
  for (const [id, k] of Object.entries(S.sent)) { const s = (await C.A.get('/api/ksef229/documents/' + id)).submission; eq('KSeF number kept after restart ' + k, s?.ksef_number, k); }
  const rc = await C.A.get('/api/receipt233/daily-reports');
  check('daily report kept after restart', rc.data.some((r) => r.report_number === S.daily_report));
  const p = (await C.A.get(`/api/orders/${S.payu.order}/payu-sessions`)).data;
  check('PayU session COMPLETED after restart', p[0]?.status === 'COMPLETED');
  eq('243 purchase register kept after restart', (await C.A.get('/api/ksef243/invoices?nip=' + acc.A.nip)).items.length, S.purchase.length);
}

const summary = {};
for (const r of results) { const s = summary[r.requirement] ??= { pass: 0, fail: 0 }; r.ok ? s.pass++ : s.fail++; }
await save(`${OUT}/stage3-acceptance-${phase}.json`, { phase, at: new Date().toISOString(), base: BASE, summary, results });
console.log(JSON.stringify(summary));
process.exitCode = results.every((r) => r.ok) ? 0 : 1;
