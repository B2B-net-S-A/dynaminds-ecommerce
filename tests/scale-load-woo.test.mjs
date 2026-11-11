// Load driver: background lanes order_import / stock_sync against the official local WooCommerce stores
// (tools/scale/load/woo.mjs, lib.mjs backgroundReport). Pure functions only; no store, Docker or database.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { assignStores, releaseCopies, maskArgs, processStartOrder, stockQuiet, orderCapacity, wooProductBody, wooOrderBody, appSelection, loadBindings, wooLaneRows, laneCommands, WOO } from '../tools/scale/load/woo.mjs';
import { backgroundReport, rng } from '../tools/scale/load/lib.mjs';

const profile = JSON.parse(await fs.readFile(new URL('../docs/parity/acceptance-profile.v1.json', import.meta.url))).config;
const sha = (b) => createHash('sha256').update(b).digest('hex');
const store = (slot, i) => ({ slot, origin: `https://localhost:${18443 + i}`, ca: { path: '/r/secrets/ca.pem', sha256: 'c'.repeat(64) },
  importer: { path: `/r/secrets/rest_importer_${slot}.json`, sha256: String(i).repeat(64) }, producer: { path: `/r/secrets/rest_producer_${slot}.json`, sha256: String(i + 5).repeat(64) } });

test('profile rates drive the lane settings: 6 orders and >= 12 stock updates per tenant per minute', () => {
  const lanes = Object.fromEntries(profile.background.lanes.map((l) => [l.id, l.per_tenant_per_minute]));
  // Imports arrive in one batch per read (period = claim + 60 s, observed ~61 s in dry run -63); a complete minute then
  // holds ~ rate x 60/61 minus the drain at 1/s, which at exactly 6/min gave 4-5 in some minutes. 8/min keeps >= 6.
  assert(60000 / WOO.order_every_ms >= lanes.order_import + 2);
  // Every order line changes one mapped product twice (Woo reduces at once, the import reserves later), and
  // offer.sync runs every 30 s; 3 distinct lines × 6 orders = 18 product changes per minute >= 12.
  assert(WOO.order_lines * lanes.order_import >= lanes.stock_sync);
  assert.equal(WOO.read_interval_s, 60); assert.equal(WOO.stock_interval_s, 30); assert(WOO.stock_verify_s >= 60);
  assert(WOO.products >= WOO.order_lines * 4, 'distinct products across the lines of one sync window');
  // Full profile (600 s warmup + 2 x 1800 s): every mapped product keeps stock for its share of the order lines.
  assert(Math.ceil(orderCapacity({ total: 0, seconds: 4200 }).planned * WOO.order_lines / WOO.products) <= WOO.min_available * 0.8);
  assert(profile.background.dependencies.official_local_woo_required_for_import_and_sync);
  assert(profile.background.dependencies.local_official_woo_instances_min <= 5);
});

test('stores: tenant slot A..E binds store a..e only, at least the profile minimum, no duplicates', () => {
  const s = ['a', 'b', 'c', 'd', 'e'].map(store);
  assert.deepEqual(assignStores(s).map((x) => [x.tenant, x.store.slot]), [['A', 'a'], ['B', 'b'], ['C', 'c'], ['D', 'd'], ['E', 'e']]);
  assert.deepEqual(assignStores(s.slice(0, 2), 2).map((x) => x.tenant), ['A', 'B']);
  assert.throws(() => assignStores(s.slice(0, 1), 2), /at least 2/);
  assert.throws(() => assignStores([s[1], s[0]]), /store a/);
  assert.throws(() => assignStores([s[0], s[0]]));
  assert.throws(() => assignStores([{ ...s[0], origin: 'https://localhost:8443' }]));
});

test('bindings: digests of CA and both keys are checked, files must be own 0600', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dyna-woo-load-'));
  try {
    const files = {};
    for (const n of ['ca.pem', 'rest_importer_a.json', 'rest_producer_a.json', 'rest_importer_b.json', 'rest_producer_b.json']) {
      const body = n === 'ca.pem' ? 'CA' : JSON.stringify({ consumer_key: 'ck_' + sha(n).slice(0, 40), consumer_secret: 'cs_' + sha('s' + n).slice(0, 40) });
      await fs.writeFile(path.join(root, n), body, { mode: 0o600 }); files[n] = { path: path.join(root, n), sha256: sha(body) };
    }
    const bindings = { schema: 'dynaminds-official-woo-store-bindings/v1', root, stores: ['a', 'b'].map((slot, i) => ({ slot, origin: `https://localhost:${18443 + i}`, ca: files['ca.pem'],
      importer: files[`rest_importer_${slot}.json`], producer: files[`rest_producer_${slot}.json`] })) };
    const file = path.join(root, 'b.json'); await fs.writeFile(file, JSON.stringify(bindings), { mode: 0o600 });
    const loaded = await loadBindings(file);
    assert.equal(loaded.stores.length, 2); assert.equal(loaded.sha256, sha(JSON.stringify(bindings)));
    assert.equal(typeof loaded.stores[0].keys.producer.consumer_key, 'string');
    assert(!JSON.stringify(loaded.public).includes('ck_'), 'public part has no key values');
    assert.equal(loaded.root, root);
    const swapped = structuredClone(bindings); [swapped.stores[1].importer, swapped.stores[1].producer] = [swapped.stores[1].producer, swapped.stores[1].importer];
    await fs.writeFile(file, JSON.stringify(swapped), { mode: 0o600 }); await assert.rejects(loadBindings(file), /rest_importer_b/);
    const shared = structuredClone(bindings); shared.stores[1].producer = shared.stores[1].importer = files['rest_importer_a.json'];
    await fs.writeFile(file, JSON.stringify(shared), { mode: 0o600 }); await assert.rejects(loadBindings(file));
    await fs.writeFile(file, JSON.stringify(bindings), { mode: 0o600 });
    await fs.writeFile(files['rest_producer_b.json'].path, '{"consumer_key":"ck_0","consumer_secret":"cs_0"}', { mode: 0o600 });
    await assert.rejects(loadBindings(file), /digest/);
    await fs.writeFile(file, JSON.stringify({ ...bindings, schema: 'other' }), { mode: 0o600 });
    await assert.rejects(loadBindings(file), /schema/);
    await fs.chmod(file, 0o644); await assert.rejects(loadBindings(file), /0600/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('capacity: the read lane scans at most 1000 orders per store, so a run that would cross it refuses before start', () => {
  assert.deepEqual(orderCapacity({ total: 1, seconds: 4200 }), { ok: true, existing: 1, planned: 561, ceiling: 1000, margin: 50 });
  assert.equal(orderCapacity({ total: 600, seconds: 4200 }).ok, false);
  assert.equal(orderCapacity({ total: 389, seconds: 4200 }).ok, true);
  assert.equal(orderCapacity({ total: 390, seconds: 4200 }).ok, false);
  assert.throws(() => orderCapacity({ total: -1, seconds: 60 }));
});

test('Woo product per mapped DYNAMINDS product: the same SKU (offer sync compares it), stock = available on MAIN, price as string', () => {
  // dry run -63: 300 of 300 offer_sync_items 'SKU produktu zewnętrznego różni się od lokalnego powiązania' with a run SKU.
  const b = wooProductBody('Lk1', 'A', { id: 'p1', sku: 'SKU-1', price: 12.5, available: 140 }, 3);
  assert.deepEqual(b, { name: 'Load Lk1 A SKU-1', type: 'simple', sku: 'SKU-1', regular_price: '12.50', manage_stock: true, stock_quantity: 140, backorders: 'no', status: 'publish' });
  assert.throws(() => wooProductBody('Lk1', 'A', { id: 'p1', sku: 'SKU-1', price: null, available: 140 }, 0));
});

test('Woo source order: processing, PLN, 3 distinct mapped lines, unique billing e-mail per run/tenant/sequence', () => {
  const products = Array.from({ length: 24 }, (_, i) => ({ woo_id: 100 + i }));
  const r = rng('seed'), a = wooOrderBody({ run: 'Lk1', tenant: 'B', n: 7, products, r }), b = wooOrderBody({ run: 'Lk1', tenant: 'B', n: 8, products, r });
  assert.equal(a.status, 'processing'); assert.equal(a.currency, 'PLN'); assert.equal(a.set_paid, false);
  assert.equal(a.billing.email, 'woo-lk1-b-7@scale.example.test'); assert.notEqual(a.billing.email, b.billing.email);
  assert(a.billing.first_name.length + a.billing.last_name.length >= 2);
  assert.equal(a.line_items.length, 3); assert.equal(new Set(a.line_items.map((l) => l.product_id)).size, 3);
  for (const l of a.line_items) { assert(products.some((p) => p.woo_id === l.product_id)); assert.equal(l.quantity, 1); }
  assert(!('fee_lines' in a) && !('shipping_lines' in a));
  assert.doesNotMatch(a.billing.email, /^load-/, 'not counted as a driver HTTP command e-mail by the reconciliation');
});

test('release copies: only CA and importer keys, into the run private dir; the store root is hidden in every container', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dyna-woo-copy-')), priv = path.join(root, 'run-private');
  try {
    await fs.mkdir(path.join(root, 'secrets')); await fs.mkdir(priv, { mode: 0o700 });
    const st = [];
    for (const [i, slot] of ['a', 'b'].entries()) {
      const body = (n) => (n === 'ca.pem' ? 'shared CA' : n + i);
      for (const n of ['ca.pem', `rest_importer_${slot}.json`, `rest_producer_${slot}.json`]) await fs.writeFile(path.join(root, 'secrets', n), body(n), { mode: 0o600 });
      const pin = (n) => ({ path: path.join(root, 'secrets', n), sha256: sha(body(n)) });
      st.push({ slot, origin: `https://localhost:${18443 + i}`, ca: pin('ca.pem'), importer: pin(`rest_importer_${slot}.json`), producer: pin(`rest_producer_${slot}.json`) });
    }
    const copies = await releaseCopies(assignStores(st, 2), priv);
    for (const { store } of copies) {
      for (const k of ['ca', 'importer']) { assert(store[k].path.startsWith(priv + path.sep)); assert.equal(sha(await fs.readFile(store[k].path)), store[k].sha256); assert.equal((await fs.stat(store[k].path)).mode & 0o777, 0o600); }
      assert.equal(store.producer, undefined, 'producer key never copied for the release');
    }
    assert.deepEqual((await fs.readdir(path.join(priv, 'woo'))).sort(), ['a-ca.pem', 'a-importer.json', 'b-ca.pem', 'b-importer.json']);
    assert.deepEqual(maskArgs('/ws/local-builds/official-woo-scale-x', '/ws'), ['--mount', 'type=tmpfs,destination=/ws/local-builds/official-woo-scale-x,tmpfs-mode=0700,tmpfs-size=65536']);
    assert.deepEqual(maskArgs('/elsewhere/official-woo-scale-x', '/ws'), []);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('app selection: one entry per assigned tenant, owner, distinct channel/fixture, importer key and CA pinned', () => {
  const assigned = assignStores(['a', 'b'].map(store), 2);
  const tenants = [{ slot: 'A', tenant_id: 't-a', user_id: 'u-a' }, { slot: 'B', tenant_id: 't-b', user_id: 'u-b' }, { slot: 'C', tenant_id: 't-c', user_id: 'u-c' }];
  const ids = { A: { channel_id: 'ch-a', fixture_id: 'fx-a' }, B: { channel_id: 'ch-b', fixture_id: 'fx-b' } };
  const sel = appSelection(assigned, tenants, ids);
  assert.deepEqual(sel, [
    { fixtureId: 'fx-a', channelId: 'ch-a', tenantId: 't-a', userId: 'u-a', origin: 'https://localhost:18443', ca: store('a', 0).ca, credentials: store('a', 0).importer },
    { fixtureId: 'fx-b', channelId: 'ch-b', tenantId: 't-b', userId: 'u-b', origin: 'https://localhost:18444', ca: store('b', 1).ca, credentials: store('b', 1).importer }]);
  assert(!JSON.stringify(sel).includes('producer'), 'the release never gets the producer key');
  assert.throws(() => appSelection(assigned, tenants, { A: ids.A, B: ids.A }));
});

test('lane commands: read lane 60 s, import after the first read, stock-only offer sync 30 s; stop disables all three', () => {
  const t = { slot: 'A', main: 'w-1' }, cmds = laneCommands({ tenant: t, channelId: 'ch', keys: ['k1', 'k2', 'k3'], versions: { read: '0', import: '0', stock: 0 }, enabled: true });
  assert.deepEqual(cmds.read, { path: '/api/local-fixtures/woocommerce/channels/ch/read-lanes', body: { client_key: 'k1', kind: 'orders.sync', expected_version: '0', enabled: true, interval_seconds: 60, warehouse_id: 'w-1' } });
  assert.deepEqual(cmds.import, { path: '/api/local-fixtures/woocommerce/channels/ch/order-import/commands', body: { client_key: 'k2', expected_version: '0', enabled: true, warehouse_id: 'w-1', confirm_import: true } });
  assert.deepEqual(cmds.stock, { path: '/api/integrations/ch/offer-sync/commands', body: { client_key: 'k3', version: 0, enabled: true, warehouse_id: 'w-1', price_list_id: null, stock: true, price: false, interval_seconds: 30, verify_seconds: 60, confirm_external: true } });
  const stop = laneCommands({ tenant: t, channelId: 'ch', keys: ['k4', 'k5', 'k6'], versions: { read: '1', import: '1', stock: 1 }, enabled: false });
  assert.equal(stop.read.body.enabled, false); assert.equal(stop.import.body.enabled, false); assert.equal(stop.import.body.confirm_import, false); assert.equal(stop.stock.body.enabled, false);
  assert.equal(stop.read.body.expected_version, '1'); assert.equal(stop.stock.body.version, 1);
});

test('background report measures Woo lanes per tenant; tenants without a store are not met, blocked stays blocked', () => {
  const start = 1_000_000, end = start + 180000, phases = [{ id: 'steady12', start_ms: start, end_ms: end }];
  const every = (ms) => Array.from({ length: Math.floor(180000 / ms) }, (_, i) => start + 500 + i * ms);
  const channels = { 'ch-a': 'A', 'ch-b': 'B' };
  const rows = [
    ...wooLaneRows('order_import', every(10000).map((ms) => ({ ch: 'ch-a', ms })), channels, start),
    ...wooLaneRows('order_import', every(10000).map((ms) => ({ ch: 'ch-b', ms })), channels, start),
    ...wooLaneRows('stock_sync', every(4000).map((ms) => ({ ch: 'ch-a', ms })), channels, start),
    ...wooLaneRows('stock_sync', every(6000).map((ms) => ({ ch: 'ch-b', ms })), channels, start),
  ];
  const rep = backgroundReport({ lanes: profile.background.lanes, rows, phases, ruleSlots: {}, woo: { tenants: ['A', 'B'] } });
  const imp = rep.lanes.order_import.phases.steady12, st = rep.lanes.stock_sync.phases.steady12;
  assert.equal(imp.A.rate_ok, true); assert.equal(imp.B.rate_ok, true); assert.equal(imp.C.status, 'no_store'); assert.equal(imp.C.rate_ok, false);
  assert.equal(st.A.rate_ok, true); assert.equal(st.B.rate_ok, false, '10 per minute < 12');
  assert.equal(rep.lanes.order_import.status, 'not_met'); assert.equal(rep.all_ok, false);
  const two = backgroundReport({ lanes: profile.background.lanes.filter((l) => l.id === 'order_import'), rows, phases, ruleSlots: {}, woo: { tenants: ['A', 'B', 'C', 'D', 'E'] } });
  assert.equal(two.lanes.order_import.phases.steady12.C.completions, 0);
  const blocked = backgroundReport({ lanes: profile.background.lanes, rows, phases, ruleSlots: {}, blocked: { stock_sync: 'x' }, woo: { tenants: ['A'] } });
  assert.equal(blocked.lanes.stock_sync.status, 'blocked'); assert.equal(blocked.lanes.order_import.phases.steady12.A.rate_ok, true);
  const none = backgroundReport({ lanes: profile.background.lanes, rows: [], phases, ruleSlots: {} });
  assert.equal(none.lanes.order_import.status, 'not_measured');
});

test('start order: with Woo the app (lanes) starts last, after every worker finished its startup; without Woo unchanged', () => {
  // dry run -62: worker-2's startup (ACL/generation, lock_timeout 8 s in the app pool) overlapped the app's first lane
  // cycles; channels A-C (read) and all five (stock) were parked until restart (no automatic retry by design).
  assert.deepEqual(processStartOrder(2, true), [1, 0]); assert.deepEqual(processStartOrder(3, true), [1, 2, 0]);
  assert.deepEqual(processStartOrder(1, true), [0]); assert.deepEqual(processStartOrder(2, false), [0, 1]);
});

test('stock stop then waits for a quiet channel: no offer.sync pending/running and no queued write plan', () => {
  // dry run -63/-70: disabling under pending lane work failed it and parked the channel; the pause now ends that work
  // without effect (offer-sync-configuration.ts, local-woo-stock-lane.ts), so the driver pauses at once and waits after.
  assert.equal(stockQuiet({ jobs: [{ state: 'done' }, { state: 'failed' }], data: [{ plan_state: 'done' }, { plan_state: null }] }), true);
  assert.equal(stockQuiet({ jobs: [{ state: 'pending' }], data: [] }), false);
  assert.equal(stockQuiet({ jobs: [{ state: 'running' }], data: [] }), false);
  assert.equal(stockQuiet({ jobs: [], data: [{ plan_state: 'queued' }] }), false);
});
