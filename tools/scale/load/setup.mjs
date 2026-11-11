#!/usr/bin/env node
// Setup of a load run inside the packaged release (database container's network namespace, like
// tools/recovery/drill-app.mjs): ordinary sessions of the five tenant owners of the scale dataset, and per tenant
// one owned automation rule order.created → add_note with its local worker on, so that every created order gives
// the release's scoped worker real jobs during the run. Writes <out> (0600): tenant ids, owner ids, session cookies,
// MAIN/spare warehouse, invoice series, WMS policy flag, rule ids. Never printed.
// Also freezes, before any request is dispatched, per tenant the hot-SKU set (--hot products with ≥ 50 available on
// MAIN; lot tenants only products with lot positions; B/D simple products with their default bin, the manual OFF
// scope) and per phase one finite-stock contention SKU (2…7 available, below the order window's ≥ 8; lib.mjs
// CONTENTION_*). Chosen by md5(product id ‖ run id), so a run is reproducible from its id; recorded in run.json.
// With --woo-products N (woo.mjs): per tenant N further simple products (>= 100 available on MAIN, not hot, not
// contention) that the run maps to its own Woo store products (background lanes order_import / stock_sync).
//
//   node tools/scale/load/setup.mjs --release <release-build.json> --tag <plan tag> --out <sessions.private.json> --run <id> [--phases warmup,steady12,steady24] [--hot 4] [--woo-products 0]
import { writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { openReleaseRuntime } from '../release-runtime.mjs';
import { SLOTS, CONTENTION_AVAILABLE, CONTENTION_CLIENTS } from './lib.mjs';
import { WOO } from './woo.mjs';

const { values: a } = parseArgs({ options: { release: { type: 'string' }, tag: { type: 'string' }, out: { type: 'string' }, run: { type: 'string' }, phases: { type: 'string', default: '' }, hot: { type: 'string', default: '4' }, 'woo-products': { type: 'string', default: '0' } } });
for (const k of ['release', 'tag', 'out', 'run']) if (!a[k]) throw new Error(`--${k} required`);
const phaseIds = a.phases ? a.phases.split(',') : [], hotCount = Number(a.hot);
if (!(Number.isInteger(hotCount) && hotCount >= 0 && hotCount <= 50)) throw new Error('--hot: 0…50');
const wooCount = Number(a['woo-products']);
if (!(Number.isInteger(wooCount) && wooCount >= 0 && wooCount <= 100)) throw new Error('--woo-products: 0…100');
const lotFilter = `EXISTS (SELECT FROM wms_layer_positions w WHERE (w.tenant_id, w.warehouse_id, w.product_id) = (s.tenant_id, s.warehouse_id, s.product_id) AND w.quantity - w.reserved >= 10)`;
const binFilter = `p.kind = 'simple' AND EXISTS (SELECT FROM stock_locations l WHERE (l.tenant_id, l.warehouse_id, l.product_id, l.location) = (s.tenant_id, s.warehouse_id, s.product_id, s.location))`;
const expect = (res, codes, what) => { if (!codes.includes(res.statusCode)) throw new Error(`${what}: HTTP ${res.statusCode} ${res.body.slice(0, 300)}`); return res.json(); };
const t0 = Date.now();
const rt = await openReleaseRuntime({ buildRecord: a.release, connections: 4, factoryOptions: { scopedAutomationEnabled: true } });
const factoryMs = Date.now() - t0;
try {
  const { app, db, ws } = rt, tenants = [];
  for (const slot of SLOTS) {
    const email = `scale-${a.tag}-${slot.toLowerCase()}@scale.example.test`;
    const user = (await db.pool.query('SELECT id,name,email FROM users WHERE email=$1', [email])).rows[0];
    if (!user) throw new Error(`no owner ${slot}`);
    const ms = (await db.pool.query("SELECT tenant_id FROM memberships WHERE user_id=$1 AND role='admin'", [user.id])).rows;
    if (ms.length !== 1) throw new Error(`owner ${slot} has ${ms.length} admin tenants`);
    const { token } = await ws.loginWorkspace({ id: user.id, name: user.name, email: user.email });
    const call = (method, url, payload) => app.inject({ method, url, cookies: { dyna_session: token }, ...(payload ? { payload } : {}) });
    const warehouses = expect(await call('GET', '/api/warehouses'), [200], 'warehouses').data;
    const series = expect(await call('GET', '/api/local-invoices/series'), [200], 'series').data;
    const wms = expect(await call('GET', '/api/wms-lots'), [200], 'wms').policy;
    const rule = expect(await call('POST', '/api/automations', { name: `Test obciążenia ${a.run}`, trigger: 'order.created', actions: [{ type: 'add_note', note: `load-${a.run}` }] }), [200, 201], 'rule');
    const worker = expect(await call('POST', `/api/automations/${rule.id}/local-worker`, { client_key: randomUUID(), version: String(rule.version), enabled: true }), [201], 'local worker');
    const main = warehouses.find((w) => w.code === 'MAIN')?.id, lots = wms?.enabled === true;
    const hot = hotCount ? (await db.pool.query(`SELECT p.id FROM stock s JOIN products p ON (p.tenant_id, p.id) = (s.tenant_id, s.product_id)
        WHERE s.tenant_id = $1 AND s.warehouse_id = $2 AND p.active AND p.kind IN ('simple', 'variant') AND s.available >= 50 AND ${lots ? lotFilter : binFilter}
        ORDER BY md5(p.id::text || $3) LIMIT $4`, [ms[0].tenant_id, main, a.run, hotCount])).rows.map((x) => x.id) : [];
    if (hot.length !== hotCount) throw new Error(`tenant ${slot}: ${hot.length} of ${hotCount} hot SKUs`);
    const small = phaseIds.length ? (await db.pool.query(`SELECT p.id, p.sku, p.price, s.available FROM stock s JOIN products p ON (p.tenant_id, p.id) = (s.tenant_id, s.product_id)
        WHERE s.tenant_id = $1 AND s.warehouse_id = $2 AND p.active AND p.kind = 'simple' AND p.price IS NOT NULL AND s.available BETWEEN $3 AND $4 AND NOT p.id = ANY($5::uuid[])
        ORDER BY md5(p.id::text || $6) LIMIT $7`, [ms[0].tenant_id, main, CONTENTION_AVAILABLE.min, CONTENTION_AVAILABLE.max, hot, a.run, phaseIds.length])).rows : [];
    if (small.length !== phaseIds.length) throw new Error(`tenant ${slot}: ${small.length} of ${phaseIds.length} contention SKUs`);
    const wooProducts = wooCount ? (await db.pool.query(`SELECT p.id, p.sku, p.price, s.available FROM stock s JOIN products p ON (p.tenant_id, p.id) = (s.tenant_id, s.product_id)
        WHERE s.tenant_id = $1 AND s.warehouse_id = $2 AND p.active AND p.kind = 'simple' AND p.price IS NOT NULL AND s.available >= $3 AND NOT p.id = ANY($4::uuid[])
        ORDER BY md5(p.id::text || $5 || 'woo') LIMIT $6`, [ms[0].tenant_id, main, WOO.min_available, [...hot, ...small.map((x) => x.id)], a.run, wooCount])).rows
      .map((x) => ({ id: x.id, sku: x.sku, price: Number(x.price), available: x.available })) : [];
    if (wooProducts.length !== wooCount) throw new Error(`tenant ${slot}: ${wooProducts.length} of ${wooCount} Woo products`);
    const contention = Object.fromEntries(phaseIds.map((id, i) => [id, { product_id: small[i].id, sku: small[i].sku, price: Number(small[i].price), available: small[i].available, demand_clients: CONTENTION_CLIENTS }]));
    tenants.push({ slot, tenant_id: ms[0].tenant_id, hot, contention, woo_products: wooProducts, user_id: user.id, cookie: `dyna_session=${token}`, main: warehouses.find((w) => w.code === 'MAIN')?.id,
      spare: warehouses.find((w) => w.code === `ZAP-${slot}`)?.id ?? null, series_id: series[0]?.id ?? null, wms: wms?.enabled === true,
      marker: `load-${a.run}`, rule_id: rule.id, rule_version: String(worker.version ?? rule.version) });
  }
  writeFileSync(a.out, JSON.stringify({ schema: 'dyna-load-sessions/v1', run: a.run, tag: a.tag, tenants }, null, 1) + '\n', { mode: 0o600, flag: 'wx' });
  console.log(JSON.stringify({ status: 'SETUP_DONE', factory_ms: factoryMs, tenants: tenants.map((t) => ({ slot: t.slot, wms: t.wms, main: !!t.main, spare: !!t.spare, series: !!t.series_id, hot: t.hot.length, contention: Object.keys(t.contention).length, woo_products: t.woo_products.length })) }));
} finally { await rt.close(); }
