// Background lanes order_import and stock_sync of the profile (config.background) against the official local
// WooCommerce stores of tools/local/official-woo (README there: install, REST keys, bindings, namespace forwarder).
//
// Roles, each with its own credentials:
//   - release (dyna-load-app only, one process: the lanes assume exclusive workers): --local-woo-stores selection with
//     the store's *importer* key, --local-woo-reads (orders.sync read lane + order import) and --local-woo-stock
//     (offer.sync / offer.write). It reaches 127.0.0.1:1844x of the database container's namespace = forwarder.
//   - driver (this host process): the *producer* key. Before the run it creates the run's Woo products (one per
//     mapped DYNAMINDS product, stock = available on MAIN); during warmup and phases it creates one fresh Woo source
//     order per store every 7.5 s (profile >= 6/min/tenant, see WOO) with 3 distinct mapped lines.
// Stock updates follow from that: WooCommerce reduces its stock when the order is placed, the import reserves in
// DYNAMINDS on the next read (<= 60 s later), and the 30 s offer.sync writes the DYNAMINDS quantity back in between
// and after, so each line yields up to two accepted Woo stock writes (offer.write, verified readback).
// Completions are read from the database (import receipts done, offer plans verified); see run.mjs monitor.
import https from 'node:https';
import { readFileSync, lstatSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { SLOTS, pickOf } from './lib.mjs';

// order_every_ms: 8 orders/min/store, above the profile's 6 because imports arrive in one batch per read (period ~61 s,
// dry run -63: 4-5 in some complete minutes at exactly 6/min). products/min_available: the scale dataset has no simple
// product with >= 100 available on MAIN (max bucket 50-99); 80 products with >= 30 keep stock for a full profile
// (561 orders x 3 lines / 80 = 22 units each).
export const WOO = Object.freeze({ order_every_ms: 7500, order_lines: 3, products: 80, read_interval_s: 60, stock_interval_s: 30, stock_verify_s: 60,
  // server/local-woo-orders-read.ts: one orders.sync reads every order of the store, at most 1000 (x-wp-total).
  read_ceiling: 1000, ceiling_margin: 50, min_available: 30 });
const sha = (b) => createHash('sha256').update(b).digest('hex');
const ORIGIN = (i) => `https://localhost:${18443 + i}`;

/** Tenant slot A..E ↔ store a..e, in order, at least `min` stores (profile local_official_woo_instances_min). */
export function assignStores(stores, min = 2) {
  if (!Array.isArray(stores) || stores.length < min || stores.length > SLOTS.length) throw new Error(`at least ${min} and at most ${SLOTS.length} Woo stores required`);
  return stores.map((store, i) => {
    if (store.slot !== SLOTS[i].toLowerCase()) throw new Error(`store ${SLOTS[i].toLowerCase()} expected at position ${i}`);
    if (store.origin !== ORIGIN(i)) throw new Error(`store ${store.slot}: origin ${ORIGIN(i)} required`);
    return { tenant: SLOTS[i], store };
  });
}
function ownPrivate(file) {
  const s = lstatSync(file);
  if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || s.uid !== process.getuid() || (s.mode & 0o777) !== 0o600) throw new Error(`${file}: own regular 0600 file required`);
  return readFileSync(file);
}
/** Bindings from `operator.mjs bindings` (paths + digests). Key values are read here, kept in memory only. */
export async function loadBindings(file) {
  const bytes = ownPrivate(file), b = JSON.parse(bytes.toString('utf8'));
  if (b.schema !== 'dynaminds-official-woo-store-bindings/v1') throw new Error('Woo bindings schema');
  const assigned = assignStores(b.stores, 1);
  const pin = (p) => { const body = ownPrivate(p.path); if (sha(body) !== p.sha256) throw new Error(`${p.path}: digest differs from bindings`); return body; };
  const seen = new Set();
  const stores = assigned.map(({ store }) => {
    pin(store.ca);
    for (const k of ['importer', 'producer']) if (!store[k].path.endsWith(`/rest_${k}_${store.slot}.json`)) throw new Error(`store ${store.slot}: ${k} key must be rest_${k}_${store.slot}.json`);
    for (const k of ['importer', 'producer']) { if (seen.has(store[k].sha256)) throw new Error('distinct REST key files required'); seen.add(store[k].sha256); }
    const keys = Object.fromEntries(['importer', 'producer'].map((k) => [k, JSON.parse(pin(store[k]).toString('utf8'))]));
    return { ...store, ca_pem: readFileSync(store.ca.path), keys };
  });
  return { sha256: sha(bytes), root: b.root, stores, public: { schema: b.schema, stores: b.stores.map(({ slot, origin, ca, importer, producer }) => ({ slot, origin, ca, importer, producer })) } };
}
/** What the release may read: copies of the CA and the importer key in the run's private directory (0700, removed at
 * the end). The owned store root (producer key, CA key, admin and database passwords) never enters a container. */
export async function releaseCopies(assigned, priv) {
  const dir = join(priv, 'woo'); mkdirSync(dir, { mode: 0o700 });
  return assigned.map(({ tenant, store }) => {
    const copy = (pin, name) => { const body = ownPrivate(pin.path); if (sha(body) !== pin.sha256) throw new Error(`${pin.path}: digest differs`); const p = join(dir, name); writeFileSync(p, body, { mode: 0o600, flag: 'wx' }); return { path: p, sha256: pin.sha256 }; };
    return { tenant, store: { slot: store.slot, origin: store.origin, ca: copy(store.ca, `${store.slot}-ca.pem`), importer: copy(store.importer, `${store.slot}-importer.json`) } };
  });
}
/** docker run arguments that hide the owned store root inside a container whose workspace mount contains it. */
export function maskArgs(root, workspace) {
  return root.startsWith(workspace + sep) ? ['--mount', `type=tmpfs,destination=${root},tmpfs-mode=0700,tmpfs-size=65536`] : [];
}
/** GET /api/integrations/:id/offer-sync: nothing of the stock lane in flight, so disabling fails no job. */
export function stockQuiet(state) {
  return !(state.jobs ?? []).some((j) => ['pending', 'running'].includes(j.state)) && !(state.data ?? []).some((x) => x.plan_state === 'queued');
}
/** Release process start order (index 0 = dyna-load-app). With Woo the app starts last: both lanes park a channel
 * for good on any error (no automatic retry), and a worker's startup (ACL / runtime generation) holds locks longer
 * than the app pool's lock_timeout (dry run -62: read A-C and stock A-E parked before setup). */
export function processStartOrder(workers, withWoo) {
  const all = Array.from({ length: workers }, (_, i) => i);
  return withWoo ? [...all.slice(1), 0] : all;
}
/** A run that would push a store past the read ceiling refuses before any effect (the read would fail mid-run). */
export function orderCapacity({ total, seconds }) {
  if (!(Number.isInteger(total) && total >= 0 && seconds > 0)) throw new Error('order capacity input');
  const planned = Math.floor(seconds * 1000 / WOO.order_every_ms) + 1;
  return { ok: total + planned + WOO.ceiling_margin <= WOO.read_ceiling, existing: total, planned, ceiling: WOO.read_ceiling, margin: WOO.ceiling_margin };
}
export function wooProductBody(run, tenant, p, i) {
  if (!(Number.isFinite(Number(p.price)) && p.price !== null && Number.isInteger(p.available) && p.available >= 0)) throw new Error(`product ${p.id}: price and stock required`);
  // Woo SKU = DYNAMINDS SKU: offer sync refuses a listing whose external SKU differs from the mapped product.
  return { name: `Load ${run} ${tenant} ${p.sku}`, type: 'simple', sku: p.sku, regular_price: Number(p.price).toFixed(2),
    manage_stock: true, stock_quantity: p.available, backorders: 'no', status: 'publish' };
}
export function wooOrderBody({ run, tenant, n, products, r }) {
  const pool = [...products], lines = [];
  while (lines.length < WOO.order_lines) { const p = pickOf(r, pool); pool.splice(pool.indexOf(p), 1); lines.push({ product_id: p.woo_id, quantity: 1 }); }
  const who = { first_name: 'Load', last_name: `Woo ${tenant} ${n}`, address_1: 'Testowa 1', city: 'Warszawa', postcode: '00-001', country: 'PL' };
  return { status: 'processing', currency: 'PLN', set_paid: false, payment_method: 'bacs', payment_method_title: 'Przelew',
    billing: { ...who, email: `woo-${run}-${tenant}-${n}@scale.example.test`.toLowerCase() }, shipping: who, line_items: lines };
}
/** --local-woo-stores entries: owner session user, own channel/fixture ids, CA and the importer key (never producer). */
export function appSelection(assigned, tenants, ids) {
  const seen = new Set(), out = [];
  for (const { tenant, store } of assigned) {
    const t = tenants.find((x) => x.slot === tenant), id = ids[tenant];
    if (!t || !id) throw new Error(`tenant ${tenant}: owner and channel ids required`);
    for (const v of [id.channel_id, id.fixture_id]) { if (seen.has(v)) throw new Error('distinct channel and fixture ids required'); seen.add(v); }
    out.push({ fixtureId: id.fixture_id, channelId: id.channel_id, tenantId: t.tenant_id, userId: t.user_id, origin: store.origin, ca: store.ca, credentials: store.importer });
  }
  return out;
}
/** Ordinary session commands of one tenant (woo-lanes.mjs). Stop = the same three with enabled false. */
export function laneCommands({ tenant, channelId, keys, versions, enabled }) {
  const base = `/api/local-fixtures/woocommerce/channels/${channelId}`;
  return {
    read: { path: `${base}/read-lanes`, body: { client_key: keys[0], kind: 'orders.sync', expected_version: versions.read, enabled, interval_seconds: WOO.read_interval_s, warehouse_id: tenant.main } },
    import: { path: `${base}/order-import/commands`, body: { client_key: keys[1], expected_version: versions.import, enabled, warehouse_id: tenant.main, confirm_import: enabled } },
    stock: { path: `/api/integrations/${channelId}/offer-sync/commands`, body: { client_key: keys[2], version: versions.stock, enabled, warehouse_id: tenant.main, price_list_id: null, stock: true, price: false,
      interval_seconds: WOO.stock_interval_s, verify_seconds: WOO.stock_verify_s, confirm_external: true } },
  };
}
/** Monitor rows of completed lane effects (kind woo_done), slot-resolved from the run's channel ids. */
export function wooLaneRows(lane, items, channels, at) {
  const xs = items.filter((x) => channels[x.ch]);
  return xs.length ? [{ kind: 'woo_done', lane, at, slots: xs.map((x) => channels[x.ch]), finished_ms: xs.map((x) => x.ms) }] : [];
}

// ---- store HTTP (host side; pinned CA, no redirects, no proxy) ----------------------------------------------------
export function wooRequest(store, method, path, body, { timeoutMs = 30000 } = {}) {
  const port = Number(new URL(store.origin).port), k = store.keys.producer, payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const req = https.request({ hostname: '127.0.0.1', port, servername: 'localhost', path, method, ca: store.ca_pem, rejectUnauthorized: true, minVersion: 'TLSv1.2', agent: false,
      headers: { host: `localhost:${port}`, accept: 'application/json', authorization: 'Basic ' + Buffer.from(`${k.consumer_key}:${k.consumer_secret}`).toString('base64'),
        ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}) } }, (res) => {
      let s = ''; res.setEncoding('utf8'); res.on('data', (d) => { s += d; if (s.length > 4 << 20) req.destroy(new Error('Woo response too large')); });
      res.on('end', () => { let json = null; try { json = JSON.parse(s); } catch { /* status says enough */ }
        resolve({ status: res.statusCode, json, total: res.headers['x-wp-total'] === undefined ? null : Number(res.headers['x-wp-total']), ms: +(performance.now() - t0).toFixed(1) }); });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('Woo request timeout')));
    req.on('error', reject); req.end(payload);
  });
}
