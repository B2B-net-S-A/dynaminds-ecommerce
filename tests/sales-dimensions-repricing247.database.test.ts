/** Migration 247 (prepared as placeholder 252) on a disposable PG04 clone dynaminds_m247_<YYYYMMDD>_NN; the real
 * migrate() applies 247 after 246. Demo tenant of the clone, simulated channels only, no provider HTTP. Rerun = new clone.
 *  1. ANALYTICS-002: the Woo importer records delivery and payment in the import transaction; grouped sales
 *     equal the period report per currency (current and comparison period); operator sees no values;
 *     a replayed import adds nothing; the administrator backfill restores a missing record; RLS and no DELETE.
 *  2. REPRICE-004: exclusion and fixed price per list and SKU with author; previews and scheduled runs respect
 *     them; a change after a preview makes the apply 409; revoked rows stay as history.
 *  3. REPRICE-005/006: a scheduled run records the channel rows in the write transaction; reconcile (route and
 *     worker tick) follows offer-sync: pending → sent → acknowledged with the read price; a later list change is
 *     superseded, a refused write failed; runs and history show the summary. */
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../server/app';
import { pool, tenantTx } from '../server/db';
import { processRepricing, scheduleRepricingDue } from '../server/repricing-schedules';

assert.equal(process.env.DYNA_TEST, 'true', 'Explicit isolated test mode required');
const selected = new URL(process.env.DATABASE_URL ?? 'invalid://missing');
assert.equal(selected.hostname, '127.0.0.1');
assert.equal(selected.port, '57084');
assert.match(selected.pathname, /^\/dynaminds_m(?:24[789]|25[0123456789]|26[0123])_2026[0-9]{4}_[0-9]{2}$/, 'fresh clone dynaminds_m247_YYYYMMDD_NN (or m248/m249/m250/m251/m252/m253/m254/m255/m256/m257/m258/m259/m260/m261/m262/m263 after 248/249/250/251/252/253/254/255/256/257/258/259/260/261/262) required');
pool.options.query_timeout = 120000;
// Shared PG04: the installation guards run before BEGIN take seconds; only this test's own connections get 60 s.
(pool as any).options.options = '-c jit=off -c statement_timeout=60000 -c lock_timeout=8000 -c timezone=UTC';
const DEMO = '11111111-1111-4111-8111-111111111111';
let app: Awaited<ReturnType<typeof buildApp>>;
const auth: Record<string, string> = {};
let warehouse = '';
let today = '';
let yesterday = '';

const req = (path: string, method: any = 'GET', payload?: any, who = 'admin') =>
  app.inject({ url: '/api' + path, method, payload, headers: { cookie: auth[who]!, 'x-workspace-id': DEMO } });
async function ok(path: string, method: any = 'GET', payload?: any, who = 'admin') {
  const r = await req(path, method, payload, who);
  assert(r.statusCode < 300, method + ' ' + path + ' ' + r.statusCode + ' ' + r.body);
  return r.json();
}
async function status(path: string, method: any, payload: any, who: string, code: number, text?: RegExp) {
  const r = await req(path, method, payload, who);
  assert.equal(r.statusCode, code, method + ' ' + path + ' ' + r.body);
  if (text) assert.match(r.json().message ?? r.body, text);
}
async function login(email: string) {
  const r = await app.inject({ url: '/api/auth/login', method: 'POST', payload: { email, password: 'DynaDemo!2026' } });
  assert.equal(r.statusCode, 200, r.body);
  return String(r.headers['set-cookie']).split(';')[0]!;
}
before(async () => {
  app = await buildApp();
  try {
    app.addHook('onError', async (_r, _p, err: any) => console.error('m247 server error', err?.code ?? '', String(err?.message ?? err).slice(0, 300)));
  } catch {}
  for (const who of ['admin', 'operator', 'viewer']) auth[who] = await login(who + '@demo.local');
  warehouse = (await ok('/warehouses')).data[0].id;
  const d = (await pool.query("SELECT to_char((clock_timestamp() AT TIME ZONE 'Europe/Warsaw')::date,'YYYY-MM-DD') d,to_char((clock_timestamp() AT TIME ZONE 'Europe/Warsaw')::date-1,'YYYY-MM-DD') y")).rows[0];
  today = d.d;
  yesterday = d.y;
});
after(async () => {
  await app.close();
  await pool.end();
});

async function product(price = 20000, vat = 23) {
  return ok('/products', 'POST', { name: 'P247', sku: 'P247-' + randomUUID(), warehouse_id: warehouse, quantity: 50, price, vat });
}
async function wooChannel(name: string) {
  const { encrypt } = await import('../server/security');
  const id = randomUUID();
  await tenantTx(DEMO, (c) => c.query("INSERT INTO channels(id,tenant_id,provider,name,mode,credentials,settings) VALUES($1,$2,'woocommerce',$3,'sandbox',$4,$5)",
    [id, DEMO, name, encrypt({ consumer_key: 'fixture', consumer_secret: 'fixture' }), JSON.stringify({ store_url: 'https://shop.example', simulation: true })]));
  return id;
}
const wooOrder = (id: number, external: number, shipping: any, payment: { method: string; title: string }) => ({
  id, status: 'processing', currency: 'PLN', date_paid: payment.method === 'cod' ? null : '2026-10-27T10:00:00',
  payment_method: payment.method, payment_method_title: payment.title,
  billing: { first_name: 'Anna', last_name: 'Test', email: `m247-${id}@example.test`, address_1: 'Testowa 1', city: 'Kraków', postcode: '30-001', country: 'PL', phone: '' },
  shipping_total: '10.00', shipping_tax: '2.30', total: '135.30', customer_note: '',
  shipping_lines: [shipping],
  line_items: [{ id: id * 10, product_id: external, variation_id: 0, name: 'P247 produkt', sku: '', quantity: 1, total: '100.00', total_tax: '23.00' }],
  fee_lines: [],
});

test('ANALYTICS-002: import zapisuje dostawę i płatność, grupy = raport okresów w obu okresach, operator bez kwot, powtórka i uzupełnienie', async () => {
  const p = await product();
  const channel = await wooChannel('P247 Woo dimensions');
  await ok('/integrations/' + channel + '/mappings', 'POST', { external_id: '952001', sku: p.sku });
  const base = 9520000 + Math.floor(Math.random() * 10000) * 10;
  const staged = await ok('/integrations/' + channel + '/stage-orders', 'POST', { data: [
    wooOrder(base + 1, 952001, { method_id: 'flexible_shipping_single', method_title: 'InPost Paczkomaty 24/7' }, { method: 'bacs', title: 'Przelew bankowy' }),
    wooOrder(base + 2, 952001, { method_id: 'flat_rate', method_title: 'Kurier DPD' }, { method: 'cod', title: 'Za pobraniem' }),
    wooOrder(base + 3, 952001, { method_id: 'local_pickup', method_title: 'Odbiór osobisty' }, { method: 'stripe', title: 'Karta płatnicza' }),
  ] });
  assert.equal(staged.data.length, 3, JSON.stringify(staged));
  const orders: string[] = [];
  for (const row of staged.data) orders.push((await ok('/imports/' + row.id + '/commit', 'POST', { warehouse_id: warehouse, expected_hash: row.source_hash })).id);
  const dims = (await pool.query('SELECT order_id,delivery_method,delivery_label,payment_method,payment_label,provider,origin FROM order_sales_dimensions WHERE order_id=ANY($1::uuid[]) ORDER BY delivery_method', [orders])).rows;
  assert.deepEqual(dims.map((d) => [d.delivery_method, d.payment_method, d.provider, d.origin]), [
    ['courier', 'cod', 'woocommerce', 'import'], ['parcel_locker', 'transfer', 'woocommerce', 'import'], ['personal_pickup', 'card', 'woocommerce', 'import']]);
  assert.equal(dims.find((d) => d.delivery_method === 'parcel_locker').delivery_label, 'InPost Paczkomaty 24/7');
  // A replayed commit returns the same order and records nothing new.
  const replay = await ok('/imports/' + staged.data[0].id + '/commit', 'POST', { warehouse_id: warehouse, expected_hash: staged.data[0].source_hash });
  assert.equal(replay.id, orders[0]);
  assert.equal((await pool.query('SELECT count(*)::int n FROM order_sales_dimensions WHERE order_id=ANY($1::uuid[])', [orders])).rows[0].n, 3);
  // A manual order has no record: "unknown" delivery, payment from its own mode.
  const manual = await ok('/orders', 'POST', { customer_name: 'Ręczne P247', email: 'm247-manual@example.test', warehouse_id: warehouse, items: [{ product_id: p.id, quantity: 1 }], address: { street: 'A 1', city: 'B', postal_code: '00-001', country: 'PL', phone: '' } });
  assert(manual.id);

  const range = `from=${today}&to=${today}`;
  const periods = await ok(`/reports/sales/periods?${range}&granularity=day`);
  const previous = await ok(`/reports/sales/periods?from=${yesterday}&to=${yesterday}&granularity=day`);
  for (const g of ['source', 'delivery', 'payment']) {
    const r = await ok(`/reports/sales/groups?${range}&compare_from=${yesterday}&compare_to=${yesterday}&group_by=${g}`);
    assert.equal(r.group_by, g);
    assert.equal(r.dimensions_available, true);
    for (const t of periods.totals) {
      const mine = r.groups.filter((x: any) => x.currency === t.currency);
      assert.equal(mine.reduce((s: number, x: any) => s + x.orders, 0), Number(t.orders), g + ' orders ' + t.currency);
      assert.equal(mine.reduce((s: bigint, x: any) => s + BigInt(x.total_gross_minor), 0n).toString(), t.total_gross_minor, g + ' value ' + t.currency);
      assert.equal(r.totals.find((x: any) => x.currency === t.currency).total_gross_minor, t.total_gross_minor);
    }
    for (const t of previous.totals) {
      const mine = r.groups.filter((x: any) => x.currency === t.currency);
      assert.equal(mine.reduce((s: number, x: any) => s + x.compare_orders, 0), Number(t.orders), g + ' compare orders');
      assert.equal(mine.reduce((s: bigint, x: any) => s + BigInt(x.compare_total_gross_minor), 0n).toString(), t.total_gross_minor, g + ' compare value');
    }
    for (const x of r.groups) assert.equal(x.orders_delta, x.orders - x.compare_orders);
  }
  const delivery = await ok(`/reports/sales/groups?${range}&group_by=delivery&sources=woocommerce`);
  const pick = (r: any, k: string) => r.groups.find((x: any) => x.currency === 'PLN' && x.group === k);
  assert(pick(delivery, 'parcel_locker').orders >= 1);
  assert.equal(pick(delivery, 'parcel_locker').label, 'Automat paczkowy');
  assert.equal(delivery.compare, null);
  const payment = await ok(`/reports/sales/groups?${range}&group_by=payment`);
  assert(pick(payment, 'cod').orders >= 1);
  assert(pick(payment, 'unknown').orders >= 1, 'the manual prepaid order has no payment record');
  assert(payment.period.unrecorded_orders >= 1);
  // Operator: counts only, no value fields; API keys are refused like the other analytics reports.
  const op = await ok(`/reports/sales/groups?${range}&group_by=delivery`, 'GET', undefined, 'operator');
  assert.equal(op.can_read_value, false);
  assert(!JSON.stringify(op.groups).includes('_minor'), JSON.stringify(op.groups[0]));
  const opCompare = await ok(`/reports/sales/groups?${range}&group_by=delivery&compare_from=${yesterday}&compare_to=${yesterday}`, 'GET', undefined, 'viewer');
  assert(!/_minor|_bps/.test(JSON.stringify(opCompare.groups)), 'no amounts, shares or value changes for non-value readers');
  assert(/share_bps/.test(JSON.stringify(delivery.groups)), 'admin gets shares');
  await status(`/reports/sales/groups?${range}&group_by=warehouse`, 'GET', undefined, 'admin', 422, /Grupowanie/);
  await status(`/reports/sales/groups?${range}&compare_from=${yesterday}`, 'GET', undefined, 'admin', 422, /obie daty/);

  // Backfill: a record missing (as for an order imported before the migration) is restored from inbound_orders.raw.
  await pool.query('DELETE FROM order_sales_dimensions WHERE order_id=$1', [orders[1]]);
  await status('/reports/sales/dimensions/backfill', 'POST', { confirmed: true }, 'operator', 403);
  await status('/reports/sales/dimensions/backfill', 'POST', {}, 'admin', 422);
  const filled = await ok('/reports/sales/dimensions/backfill', 'POST', { confirmed: true });
  assert(filled.recorded >= 1, JSON.stringify(filled));
  const back = (await pool.query('SELECT delivery_method,payment_method,origin FROM order_sales_dimensions WHERE order_id=$1', [orders[1]])).rows[0];
  assert.deepEqual(back, { delivery_method: 'courier', payment_method: 'cod', origin: 'backfill' });
  // RLS and grants: another tenant sees nothing; the application role cannot delete or rewrite a record.
  assert.equal((await tenantTx(randomUUID(), (c) => c.query('SELECT count(*)::int n FROM order_sales_dimensions'))).rows[0].n, 0);
  await assert.rejects(tenantTx(DEMO, (c) => c.query('DELETE FROM order_sales_dimensions WHERE order_id=$1', [orders[0]])), /permission denied/);
  await assert.rejects(tenantTx(DEMO, (c) => c.query("UPDATE order_sales_dimensions SET payment_method='cash' WHERE order_id=$1", [orders[0]])), /permission denied/);
  console.log('P247 groups: delivery', JSON.stringify(delivery.groups.map((x: any) => [x.group, x.orders])), 'backfill', JSON.stringify(filled));
});

const root = (l: any) => '/price-lists/' + l.id + '/repricing';
async function claim(jobId: string) {
  return (await pool.query("UPDATE jobs SET state='running',attempts=attempts+1,lease_token=$2,locked_at=now() WHERE id=$1 AND state='pending' RETURNING *", [jobId, randomUUID()])).rows[0];
}
async function drainRun(runId: string) {
  for (let n = 0; n < 50; n++) {
    const run = (await pool.query('SELECT * FROM repricing_runs WHERE id=$1', [runId])).rows[0];
    if (run.state !== 'queued') return run;
    const job = await claim(run.job_id);
    assert(job, 'job of the run must be pending');
    await processRepricing(job);
  }
  throw Error('run did not finish');
}
const listItems = async (l: any) =>
  new Map((await pool.query('SELECT product_id,price FROM price_list_items WHERE price_list_id=$1', [l.id])).rows.map((r) => [r.product_id, r.price]));

test('REPRICE-004: wykluczenie i cena ręczna z autorem; podgląd i harmonogram je respektują; zmiana po podglądzie = 409', async () => {
  const [p1, p2, p3] = [await product(), await product(), await product()];
  const l = await ok('/price-lists', 'POST', { name: 'P247 ' + randomUUID().slice(0, 8), currency: 'PLN', fallback: true });
  let rule = await ok(root(l), 'PUT', { version: 0, config: { strategy: 'cost_margin', target_margin_bps: 2000 } });
  rule = await ok(root(l) + '/inputs', 'PUT', { version: rule.version, items: [p1, p2, p3].map((p) => ({ product_id: p.id, net_cost: 10000, source: 'P247 koszt' })) });
  const ids = [p1.id, p2.id, p3.id];
  await status(root(l) + '/overrides', 'POST', { product_id: p1.id, mode: 'exclude', reason: 'Promocja producenta', replaces: null }, 'viewer', 403);
  await status(root(l) + '/overrides', 'POST', { product_id: p1.id, mode: 'fixed', reason: 'Bez kwoty', replaces: null }, 'admin', 422);
  const ex = await ok(root(l) + '/overrides', 'POST', { product_id: p1.id, mode: 'exclude', reason: 'Promocja producenta', replaces: null }, 'operator');
  const fx1 = await ok(root(l) + '/overrides', 'POST', { product_id: p2.id, mode: 'fixed', fixed_price: 17990, reason: 'Cena z umowy', replaces: null });
  await status(root(l) + '/overrides', 'POST', { product_id: p2.id, mode: 'fixed', fixed_price: 18990, reason: 'Druga bez CAS', replaces: null }, 'admin', 409, /odśwież/);
  const preview = await ok(root(l) + '/previews', 'POST', { client_key: randomUUID(), product_ids: ids });
  const row = (id: string, pv: any) => pv.result.find((r: any) => r.product_id === id);
  assert.equal(row(p1.id, preview).state, 'override');
  assert.equal(row(p1.id, preview).override.id, ex.id);
  assert.equal(row(p2.id, preview).proposed_price, 17990);
  assert.equal(row(p2.id, preview).override.created_by, (await pool.query("SELECT id FROM users WHERE email='admin@demo.local'")).rows[0].id);
  assert.equal(row(p3.id, preview).state, 'change');
  const computed = row(p3.id, preview).proposed_price;
  assert.equal(row(p2.id, preview).computed_price, computed, 'same cost: the automatic price stays visible');
  // A change of the override after the preview: the apply recompute differs.
  const fx2 = await ok(root(l) + '/overrides', 'POST', { product_id: p2.id, mode: 'fixed', fixed_price: 18990, reason: 'Nowa cena z umowy', replaces: fx1.id });
  assert.equal(fx2.replaces_id, fx1.id);
  await status('/repricing-previews/' + preview.id + '/apply', 'POST', { confirmed: true }, 'admin', 409);
  const fresh = await ok(root(l) + '/previews', 'POST', { client_key: randomUUID(), product_ids: ids });
  await ok('/repricing-previews/' + fresh.id + '/apply', 'POST', { confirmed: true });
  let prices = await listItems(l);
  assert.equal(prices.get(p1.id), undefined, 'excluded: nothing written');
  assert.equal(prices.get(p2.id), 18990);
  assert.equal(prices.get(p3.id), computed);
  // Scheduled run: the excluded SKU is skipped, the fixed one stays.
  const cfg = (await ok(root(l) + '/schedule', 'PUT', { version: 0, enabled: true, rule_config_version: rule.config_version, interval_minutes: 60, batch_size: 2, confirmed: true })).schedule;
  const run = await drainRun((await ok(root(l) + '/schedule/run', 'POST', { version: cfg.version, client_key: randomUUID() })).id);
  assert.equal(run.state, 'success', JSON.stringify(run));
  assert.equal(run.skipped, 1);
  assert.equal(run.changed, 0);
  assert.equal(run.unchanged, 2);
  prices = await listItems(l);
  assert.equal(prices.get(p2.id), 18990);
  // Revoke: history keeps it; the next preview reprices the SKU again.
  await status('/repricing-overrides/' + ex.id + '/revoke', 'POST', { confirmed: true }, 'viewer', 403);
  const revoked = await ok('/repricing-overrides/' + ex.id + '/revoke', 'POST', { confirmed: true, reason: 'Koniec promocji' }, 'operator');
  assert(revoked.revoked_at);
  assert.equal(row(p1.id, await ok(root(l) + '/previews', 'POST', { client_key: randomUUID(), product_ids: ids })).state, 'change');
  const active = await ok(root(l) + '/overrides');
  assert.deepEqual(active.data.map((o: any) => o.id), [fx2.id]);
  const all = await ok(root(l) + '/overrides?state=all');
  assert.equal(all.data.length, 3);
  assert.equal(all.data.find((o: any) => o.id === fx1.id).revoke_reason, 'Zastąpione nowym nadpisaniem');
  assert(all.data.every((o: any) => o.created_by_name), 'author name shown');
  assert.equal((await pool.query("SELECT count(*)::int n FROM audit_events WHERE action IN ('repricing.override','repricing.override.revoke') AND entity_id=ANY($1::uuid[])", [[ex.id, fx1.id, fx2.id]])).rows[0].n, 4);
  await assert.rejects(tenantTx(DEMO, (c) => c.query('DELETE FROM repricing_overrides WHERE id=$1', [ex.id])), /permission denied/);
  const history = await ok(root(l) + '/previews?source=manual');
  assert(history.data.some((h: any) => h.overridden === 1));
  await ok(root(l) + '/schedule', 'PUT', { version: (await ok(root(l) + '/schedule')).schedule.version, enabled: false, rule_config_version: rule.config_version, interval_minutes: 60, batch_size: 2, confirmed: true });
});

test('REPRICE-005/006: przebieg zapisuje wiersze kanału, uzgodnienie: oczekuje → wysłano → potwierdzono; zmiana ceny = zastąpione, odmowa = błąd', async () => {
  const { processOfferSync } = await import('../server/offer-sync');
  const { processOfferJob } = await import('../server/offers');
  const products = [await product(), await product(), await product()];
  const l = await ok('/price-lists', 'POST', { name: 'P247 ch ' + randomUUID().slice(0, 8), currency: 'PLN', fallback: true });
  let rule = await ok(root(l), 'PUT', { version: 0, config: { strategy: 'cost_margin', target_margin_bps: 2000 } });
  rule = await ok(root(l) + '/inputs', 'PUT', { version: rule.version, items: products.map((p) => ({ product_id: p.id, net_cost: 10000, source: 'P247 koszt' })) });
  const channel = await wooChannel('P247 Woo prices');
  for (const [n, p] of products.entries()) await ok('/integrations/' + channel + '/mappings', 'POST', { external_id: String(953000 + n), sku: p.sku });
  await ok('/integrations/' + channel + '/offer-sync', 'PATCH', { version: 0, enabled: true, warehouse_id: warehouse, price_list_id: l.id, stock: false, price: true, interval_seconds: 30, verify_seconds: 3600 });
  const noHttp = { transport: async () => { throw Error('Unexpected provider HTTP'); } };
  const sync = async () => {
    const job = await ok('/integrations/' + channel + '/offer-sync', 'POST', {});
    await processOfferSync(await claim(job.id), noHttp);
  };
  const cfg = (await ok(root(l) + '/schedule', 'PUT', { version: 0, enabled: true, rule_config_version: rule.config_version, interval_minutes: 60, batch_size: 2, confirmed: true })).schedule;
  const done = await drainRun((await ok(root(l) + '/schedule/run', 'POST', { version: cfg.version, client_key: randomUUID() })).id);
  assert.equal(done.state, 'success');
  assert.equal(done.changed, 3);
  const prices = await listItems(l);
  let ch = await ok('/repricing-runs/' + done.id + '/channel');
  assert.equal(ch.available, true);
  assert.deepEqual(ch.summary, { total: 3, open: 3, pending: 3, sent: 0, acknowledged: 0, mismatch: 0, failed: 0, superseded: 0 });
  for (const r of ch.data) assert.equal(r.expected_price, prices.get(r.product_id));
  const appliedAt = (await pool.query('SELECT applied_at,applied_list_version FROM repricing_previews WHERE schedule_run_id=$1 LIMIT 1', [done.id])).rows[0];
  assert(appliedAt.applied_at, 'channel rows were written with the applied batch');
  // Before any sync: still waiting.
  await status('/repricing-runs/' + done.id + '/channel/reconcile', 'POST', {}, 'viewer', 403);
  ch = await ok('/repricing-runs/' + done.id + '/channel/reconcile', 'POST', {}, 'operator');
  assert.equal(ch.summary.pending, 3);
  await sync();
  // An abandoned preview plan between the write and the real sync plan is not the result.
  const firstQueued = (await pool.query("SELECT * FROM offer_plans WHERE channel_id=$1 AND state='queued' ORDER BY created_at LIMIT 1", [channel])).rows[0];
  const stale = randomUUID();
  await pool.query(`INSERT INTO offer_plans(id,tenant_id,channel_id,product_id,listing_id,actor_id,warehouse_id,operation,state,input,local_snapshot,payload,phase,created_at)
    SELECT $2,tenant_id,channel_id,product_id,listing_id,actor_id,warehouse_id,operation,'preview',input,local_snapshot,payload,'ready',
      (SELECT applied_at FROM repricing_channel_results WHERE run_id=$3 AND product_id=p.product_id LIMIT 1) FROM offer_plans p WHERE id=$1`, [firstQueued.id, stale, done.id]);
  ch = await ok('/repricing-runs/' + done.id + '/channel/reconcile', 'POST', {});
  assert.equal(ch.summary.sent, 3, JSON.stringify(ch.summary));
  assert(!ch.data.some((r: any) => r.plan_id === stale), 'the stale preview is skipped');
  assert(ch.data.every((r: any) => r.plan_id));
  // Writes finish (simulated Woo); the worker tick reconciles without a request.
  const plans = (await pool.query("SELECT * FROM offer_plans WHERE channel_id=$1 AND state='queued'", [channel])).rows;
  for (const plan of plans) await processOfferJob(await claim(plan.job_id), noHttp);
  await scheduleRepricingDue();
  ch = await ok('/repricing-runs/' + done.id + '/channel');
  assert.equal(ch.summary.acknowledged, 3, JSON.stringify(ch.summary));
  for (const r of ch.data) assert.equal(r.remote_price, r.expected_price);
  const runs = await ok(root(l) + '/runs');
  assert.equal(runs.data.find((r: any) => r.id === done.id).channel.acknowledged, 3);
  const history = await ok(root(l) + '/previews?source=schedule');
  assert.equal(history.data.reduce((s: number, h: any) => s + (h.channel?.acknowledged ?? 0), 0), 3);

  // Second run with a higher cost: one list price is edited before the sync (superseded), one write is refused (failed).
  rule = (await ok(root(l))).rule;
  rule = await ok(root(l) + '/inputs', 'PUT', { version: rule.version, items: products.map((p) => ({ product_id: p.id, net_cost: 12000, source: 'P247 koszt 2' })) });
  const cfg2 = (await ok(root(l) + '/schedule')).schedule;
  await pool.query('UPDATE repricing_schedules SET next_at=now() WHERE price_list_id=$1', [l.id]);
  const second = await drainRun((await ok(root(l) + '/schedule/run', 'POST', { version: cfg2.version, client_key: randomUUID() })).id);
  assert.equal(second.changed, 3, JSON.stringify(second));
  const list = (await ok('/price-lists/' + l.id + '/items')).list;
  await ok('/price-lists/' + l.id + '/items', 'PUT', { version: list.version, items: [{ product_id: products[0].id, price: 99999 }] });
  await sync();
  const queued = (await pool.query("SELECT * FROM offer_plans WHERE channel_id=$1 AND state='queued' ORDER BY product_id", [channel])).rows;
  const refused = queued.find((p) => p.product_id === products[1].id);
  await pool.query("UPDATE offer_plans SET state='conflict',error='Oferta zmieniona w kanale' WHERE id=$1", [refused.id]);
  await pool.query("UPDATE jobs SET state='failed' WHERE id=$1", [refused.job_id]);
  for (const plan of queued.filter((p) => p.id !== refused.id)) await processOfferJob(await claim(plan.job_id), noHttp);
  ch = await ok('/repricing-runs/' + second.id + '/channel/reconcile', 'POST', {});
  const by = new Map(ch.data.map((r: any) => [r.product_id, r]));
  assert.equal((by.get(products[0].id) as any).status, 'superseded', JSON.stringify(ch.data));
  assert.equal((by.get(products[1].id) as any).status, 'failed');
  assert.equal((by.get(products[1].id) as any).error, 'Oferta zmieniona w kanale');
  assert.equal((by.get(products[2].id) as any).status, 'acknowledged');
  // Terminal rows are not touched again; the first run stays acknowledged.
  assert.equal((await ok('/repricing-runs/' + done.id + '/channel')).summary.acknowledged, 3);
  await assert.rejects(tenantTx(DEMO, (c) => c.query('DELETE FROM repricing_channel_results WHERE run_id=$1', [done.id])), /permission denied/);
  assert.equal((await tenantTx(randomUUID(), (c) => c.query('SELECT count(*)::int n FROM repricing_channel_results'))).rows[0].n, 0);
  await pool.query('UPDATE offer_sync_configs SET enabled=false WHERE channel_id=$1', [channel]);
  await ok(root(l) + '/schedule', 'PUT', { version: (await ok(root(l) + '/schedule')).schedule.version, enabled: false, rule_config_version: rule.config_version, interval_minutes: 60, batch_size: 2, confirmed: true });
  console.log('P247 channel: first', JSON.stringify((await ok('/repricing-runs/' + done.id + '/channel')).summary), 'second', JSON.stringify(ch.summary));
});
