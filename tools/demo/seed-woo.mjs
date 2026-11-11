#!/usr/bin/env node
// WooCommerce channel of the demo company, bound to one official LOCAL WooCommerce store (tools/local/official-woo,
// https://localhost:18447 = store e by default). Host side; the demo app is reached on http://127.0.0.1:4300.
//
//   node tools/demo/seed-woo.mjs <DEMO_ROOT> <app base>            prepare: store products (producer key, same SKUs),
//                                                                   release copies of the CA + importer key, selection
//   node tools/demo/seed-woo.mjs <DEMO_ROOT> <app base> --lanes    after a restart with the selection: enroll the channel,
//                                                                   map SKUs, stock sync, orders.sync read, import opt-in,
//                                                                   then two store orders that the app imports
//   node tools/demo/seed-woo.mjs <DEMO_ROOT> <app base> --order    one new store order (live demo); prints its number
//   node tools/demo/seed-woo.mjs <DEMO_ROOT> <app base> --refresh-ca
//                                                                   after `operator.mjs renew-tls`: new copy of the store CA
//                                                                   and its pin in the selection (same channel, fixture and
//                                                                   key); the release reads it on its next start
//
// Keys: the release only ever gets the importer key (copy in $DEMO_ROOT/private/woo, 0600). The producer key (create
// store products and orders, like a shop customer would) stays in the store root and in this host process' memory.
// Existing store data is never deleted; products are found again by SKU on a later run.
import https from 'node:https';
import { readFileSync, writeFileSync, mkdirSync, existsSync, lstatSync, copyFileSync, chmodSync, renameSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { Client, fetchTransport, key } from './lib.mjs';

const [ROOT, BASE, mode = '--prepare'] = process.argv.slice(2);
if (!ROOT || !BASE) throw new Error('usage: seed-woo.mjs <DEMO_ROOT> <app base> [--lanes|--order]');
const PRIV = ROOT + '/private', DIR = PRIV + '/woo', STATE = DIR + '/state.json';
const SLOT = process.env.DEMO_WOO_SLOT ?? 'e';
const WOO_ROOT = process.env.DEMO_WOO_ROOT ?? workspace() + '/local-builds/official-woo-scale-20261030-01';
const CAT = JSON.parse(readFileSync(new URL('./catalog.json', import.meta.url), 'utf8'));
const sha = (b) => createHash('sha256').update(b).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...m) => console.log('[woo]', ...m);
/** Nearest ancestor of the repository that holds local-builds/ (works from the main checkout and from a worktree). */
function workspace() { let d = decodeURIComponent(new URL('../..', import.meta.url).pathname).replace(/\/$/, ''); while (d && !existsSync(d + '/local-builds')) d = d.slice(0, d.lastIndexOf('/')); return d; }
function ownPrivate(file) {
  const s = lstatSync(file);
  if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || s.uid !== process.getuid() || (s.mode & 0o777) !== 0o600) throw new Error(`${file}: own regular 0600 file required`);
  return readFileSync(file);
}
const bindings = JSON.parse(ownPrivate(WOO_ROOT + '/woo-store-bindings.private.json'));
const store = bindings.stores.find((s) => s.slot === SLOT);
if (!store) throw new Error('no store ' + SLOT);
const port = Number(new URL(store.origin).port);
const ca = ownPrivate(store.ca.path); if (sha(ca) !== store.ca.sha256) throw new Error('CA digest');
const producerBytes = ownPrivate(store.producer.path); if (sha(producerBytes) !== store.producer.sha256) throw new Error('producer key digest');
const producer = JSON.parse(producerBytes);

function woo(method, path, body) {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: '127.0.0.1', port, servername: 'localhost', path, method, ca, rejectUnauthorized: true, agent: false,
      headers: { host: `localhost:${port}`, accept: 'application/json', authorization: 'Basic ' + Buffer.from(`${producer.consumer_key}:${producer.consumer_secret}`).toString('base64'),
        ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}) } }, (res) => {
      let s = ''; res.setEncoding('utf8'); res.on('data', (d) => { s += d; });
      res.on('end', () => { let json = null; try { json = JSON.parse(s); } catch { /* status */ } resolve({ status: res.statusCode, json, total: Number(res.headers['x-wp-total'] ?? NaN) }); });
    });
    req.setTimeout(30000, () => req.destroy(new Error('Woo timeout'))); req.on('error', reject); req.end(payload);
  });
}
const ok = (r, what) => { if (r.status >= 300) throw new Error(`${what}: HTTP ${r.status} ${JSON.stringify(r.json).slice(0, 300)}`); return r.json; };
const writePrivate = (file, data) => { writeFileSync(file + '.tmp', data, { mode: 0o600 }); renameSync(file + '.tmp', file); };
const copy = (pin, name) => { const b = ownPrivate(pin.path); if (sha(b) !== pin.sha256) throw new Error(pin.path + ' digest'); writePrivate(DIR + '/' + name, b); return { path: DIR + '/' + name, sha256: pin.sha256 }; };
const creds = () => JSON.parse(ownPrivate(PRIV + '/credentials.json'));
async function ownerClient() {
  const c = new Client(fetchTransport(BASE)), u = creds().users.find((x) => x.key === 'owner');
  await c.login(u.email, u.password); return c;
}

if (mode === '--prepare') {
  const c = await ownerClient(), me = await c.get('/api/auth/me');
  const user = me.user ?? me;
  const orders = await woo('GET', '/wp-json/wc/v3/orders?per_page=1');
  if (orders.total + 60 > 1000) throw new Error(`store ${SLOT} has ${orders.total} orders; the read ceiling is 1000 (tools/local/official-woo/README.md)`);
  // Store products with the DYNAMINDS SKUs (offer sync compares SKUs); stock = available on MAIN now.
  const whs = (await c.get('/api/warehouses')).data, MAIN = whs.find((w) => w.code === 'MAIN').id;
  const products = (await c.get(`/api/products?warehouse_id=${MAIN}&limit=200`)).data;
  const mapped = [];
  for (const p of CAT.products) {
    const d = products.find((x) => x.sku === p.sku);
    const inv = (await c.get(`/api/inventory?warehouse_id=${MAIN}&product_id=${d.id}`)).data?.[0];
    const body = { name: p.name, type: 'simple', sku: p.sku, regular_price: (p.price / 100).toFixed(2), manage_stock: true, stock_quantity: Number(inv?.available ?? 0),
      backorders: 'no', status: 'publish', description: p.description, short_description: `${p.manufacturer} · ${p.category}` };
    const found = ok(await woo('GET', `/wp-json/wc/v3/products?sku=${encodeURIComponent(p.sku)}`), 'find ' + p.sku);
    const w = found.length ? ok(await woo('PUT', `/wp-json/wc/v3/products/${found[0].id}`, body), 'update ' + p.sku) : ok(await woo('POST', '/wp-json/wc/v3/products', body), 'create ' + p.sku);
    mapped.push({ sku: p.sku, woo_id: w.id, name: p.name, price: p.price });
  }
  // Release copies (0600) of the CA and the importer key; the selection names the owner session user.
  mkdirSync(DIR, { recursive: true, mode: 0o700 }); chmodSync(DIR, 0o700);
  const channelId = randomUUID();
  const sel = [{ fixtureId: randomUUID(), channelId, tenantId: user.tenant_id, userId: user.id, origin: store.origin,
    ca: copy(store.ca, `${SLOT}-ca.pem`), credentials: copy(store.importer, `${SLOT}-importer.json`) }];
  writePrivate(DIR + '/selection.json', JSON.stringify(sel));
  writePrivate(DIR + '/state.json', JSON.stringify({ slot: SLOT, origin: store.origin, channel_id: channelId, products: mapped, orders_before: orders.total }, null, 1));
  writePrivate(PRIV + '/woo-ports', String(port) + '\n');
  writePrivate(PRIV + '/woo-root', WOO_ROOT + '\n');
  log('prepared store', SLOT, store.origin, 'products', mapped.length, 'existing store orders', orders.total);
} else if (mode === '--lanes') {
  const st = JSON.parse(ownPrivate(STATE)), c = await ownerClient(), ch = st.channel_id, base = `/api/local-fixtures/woocommerce/channels/${ch}`;
  const MAIN = (await c.get('/api/warehouses')).data.find((w) => w.code === 'MAIN').id;
  await c.post(base, { name: `Sklep WooCommerce (lokalny, ${new URL(st.origin).host})` }, [201]);
  for (const p of st.products) await c.post(`/api/integrations/${ch}/mappings`, { external_id: String(p.woo_id), sku: p.sku }, [200, 201]);
  await c.post(`/api/integrations/${ch}/offer-sync/commands`, { client_key: key(), version: 0, enabled: true, warehouse_id: MAIN, price_list_id: null, stock: true, price: false,
    interval_seconds: 30, verify_seconds: 60, confirm_external: true }, [200, 201]);
  await c.post(`${base}/read-lanes`, { client_key: key(), kind: 'orders.sync', expected_version: '0', enabled: true, interval_seconds: 60, warehouse_id: MAIN }, [201]);
  const latest = async () => (await c.get(`${base}/read-lanes`)).history?.data?.find((o) => o.kind === 'orders.sync') ?? null;
  for (const deadline = Date.now() + 240000; ;) {
    const o = await latest();
    if (o?.state === 'done') break;
    if (o && !['queued', 'running'].includes(o.state)) throw new Error('first read ' + o.state);
    if (Date.now() > deadline) throw new Error('first read not done in 240 s');
    await sleep(3000);
  }
  await c.post(`${base}/order-import/commands`, { client_key: key(), expected_version: '0', enabled: true, warehouse_id: MAIN, confirm_import: true }, [201]);
  log('channel enrolled, mapped', st.products.length, 'stock sync 30 s, read 60 s, import on');
  const before = await wooOrders(c);
  const made = [await storeOrder(st, 0), await storeOrder(st, 1)];
  await waitImported(c, before + made.length);
} else if (mode === '--order') {
  const st = JSON.parse(ownPrivate(STATE));
  const n = Date.now() % 1000;
  const o = await storeOrder(st, n);
  console.log(`Zamówienie WooCommerce #${o.number} (${o.total} zł) złożone w ${st.origin}; DYNAMINDS pobierze je w ciągu ~1–2 min (Integracje → Lokalne sklepy Woo, Zamówienia).`);
} else if (mode === '--refresh-ca') {
  const file = DIR + '/selection.json', sel = JSON.parse(ownPrivate(file));
  if (!Array.isArray(sel) || !sel.some((x) => x.origin === store.origin)) throw new Error(`selection has no store ${store.origin}; run the seed first`);
  const before = sel.find((x) => x.origin === store.origin).ca.sha256;
  if (before === store.ca.sha256) { log('CA pin already current', store.ca.sha256.slice(0, 12)); process.exit(0); }
  const pin = copy(store.ca, `${SLOT}-ca.pem`);
  writePrivate(file, JSON.stringify(sel.map((x) => (x.origin === store.origin ? { ...x, ca: pin } : x))));
  log('CA pin', before.slice(0, 12), '->', pin.sha256.slice(0, 12), 'for', store.origin, '(the release reads it on its next start)');
} else throw new Error('unknown mode ' + mode);

async function storeOrder(st, n) {
  const buyers = CAT.customers, b = buyers[(n * 7 + 3) % buyers.length], [first, ...rest] = b.name.split(' ');
  const lines = [st.products[(n * 5 + 2) % st.products.length], st.products[(n * 3 + 11) % st.products.length]].filter((p, i, a) => a.indexOf(p) === i);
  const who = { first_name: first, last_name: rest.join(' '), address_1: b.street, city: b.city, postcode: b.postal_code, country: 'PL' };
  const email = b.name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ł/g, 'l').replace(/\s+/g, '.') + '@example.com';
  const o = ok(await woo('POST', '/wp-json/wc/v3/orders', { status: 'processing', currency: 'PLN', set_paid: true, payment_method: 'bacs', payment_method_title: 'Przelew online',
    billing: { ...who, email, phone: b.phone }, shipping: who, line_items: lines.map((p) => ({ product_id: p.woo_id, quantity: 1 })),
    shipping_lines: [{ method_id: 'flat_rate', method_title: 'Kurier', total: '16.99' }] }), 'store order');
  log('store order', o.number, o.total);
  return { id: o.id, number: String(o.number), total: o.total };
}
async function wooOrders(c) { return ((await c.get('/api/orders?limit=200')).data ?? []).filter((o) => o.source === 'woocommerce').length; }
async function waitImported(c, want) {
  for (const deadline = Date.now() + 300000; ;) {
    const n = await wooOrders(c);
    if (n >= want) { log('imported store orders, now', n); return; }
    if (Date.now() > deadline) throw new Error(`store orders not imported in 300 s (${n}/${want})`);
    await sleep(5000);
  }
}
