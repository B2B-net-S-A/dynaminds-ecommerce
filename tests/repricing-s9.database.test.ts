/** S9 repricing on a fresh PG04 clone dynaminds_s9_20261026_NN (real migrate() first):
 * a scheduled repricing run (pricing.reprice job, claimed like the worker does) writes the
 * price list, offer-sync carries it to a simulated WooCommerce offer, and the second run and
 * the second sync change nothing (idempotent; the lost acknowledgement of the first plan is
 * reconciled without a new write). No price is ever below the floor. Then: cost in another
 * currency with stored NBP table A rates (missing and stale rate block), the base price list
 * with cycle refusal and the administrator check, filtered newest-first history, and the
 * competitor observation import surviving an app restart. Demo tenant of the clone; no HTTP
 * to any provider. Rerun = new clone. */
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { buildApp } from '../server/app';
import { pool, tenantTx } from '../server/db';
import { processRepricing } from '../server/repricing-schedules';

assert.equal(process.env.DYNA_TEST, 'true', 'Explicit isolated test mode required');
const selected = new URL(process.env.DATABASE_URL ?? 'invalid://missing');
assert.equal(selected.hostname, '127.0.0.1');
assert.equal(selected.port, '57084');
assert.match(selected.pathname, /^\/dynaminds_s9_20261026_[0-9]{2}$/);
pool.options.query_timeout = 120000;
// The shared PG04 runs many lanes at once: the per-transaction installation guards
// (pim_dictionary_valid & co., run on the pool before BEGIN) take 4–9 s there, so the
// connection-level 8 s default cancels them. Only this test raises that default for its
// own new connections; every tenant transaction still sets its own 8 s limit.
(pool as any).options.options = '-c jit=off -c statement_timeout=60000 -c lock_timeout=8000 -c timezone=UTC';
const DEMO = '11111111-1111-4111-8111-111111111111';
let app: Awaited<ReturnType<typeof buildApp>>;
const auth: Record<string, string> = {};
let warehouse = '';
let today = '';

const req = (path: string, method: any = 'GET', payload?: any, who = 'admin', target = app) =>
  target.inject({ url: '/api' + path, method, payload, headers: { cookie: auth[who]!, 'x-workspace-id': DEMO } });
async function ok(path: string, method: any = 'GET', payload?: any, who = 'admin', target = app) {
  const r = await req(path, method, payload, who, target);
  assert(r.statusCode < 300, method + ' ' + path + ' ' + r.statusCode + ' ' + r.body);
  return r.json();
}
async function login(email: string, target = app) {
  const r = await target.inject({ url: '/api/auth/login', method: 'POST', payload: { email, password: 'DynaDemo!2026' } });
  assert.equal(r.statusCode, 200, r.body);
  return String(r.headers['set-cookie']).split(';')[0]!;
}
function traceErrors(target: typeof app) {
  // 500 bodies hide the cause; the test log keeps code and message (no request data).
  try {
    target.addHook('onError', async (_req, _reply, err: any) => {
      console.error('S9 server error', err?.code ?? '', String(err?.message ?? err).slice(0, 300));
    });
  } catch {}
}
before(async () => {
  app = await buildApp();
  traceErrors(app);
  for (const who of ['admin', 'operator', 'viewer']) auth[who] = await login(who + '@demo.local');
  warehouse = (await ok('/warehouses')).data[0].id;
  today = (await pool.query("SELECT to_char((clock_timestamp() AT TIME ZONE 'Europe/Warsaw')::date,'YYYY-MM-DD') d")).rows[0].d;
});
after(async () => {
  await app.close();
  await pool.end();
});

async function product(price = 20000, vat = 23) {
  return ok('/products', 'POST', { name: 'S9 repricing', sku: 'S9-' + randomUUID(), warehouse_id: warehouse, quantity: 10, price, vat });
}
async function list(currency = 'PLN', fallback = currency === 'PLN') {
  return ok('/price-lists', 'POST', { name: 'S9 ' + randomUUID().slice(0, 8), currency, fallback });
}
const root = (l: any) => '/price-lists/' + l.id + '/repricing';
const previewOf = (l: any, ids: string[]) => ok(root(l) + '/previews', 'POST', { client_key: randomUUID(), product_ids: ids });
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

test('przebieg harmonogramu zapisuje ceny nie niższe niż minimum, oferta Woo dostaje cenę, drugi przebieg i synchronizacja nic nie zmieniają', async () => {
  const { encrypt } = await import('../server/security');
  const { processOfferSync } = await import('../server/offer-sync');
  const { processOfferJob } = await import('../server/offers');
  const products = [await product(), await product(), await product()];
  const l = await list();
  let rule = await ok(root(l), 'PUT', { version: 0, config: { strategy: 'competitor', fee_bps: 500, min_margin_bps: 1500, observation_minutes: 600, rounding: { step: 100, ending: 99 } } });
  const observed = new Date(Date.now() - 60000).toISOString();
  // Competitors: far below cost (must stop at the floor), slightly above the floor, high.
  rule = await ok(root(l) + '/inputs', 'PUT', { version: rule.version, items: [
    { product_id: products[0].id, net_cost: 10000, competitor_price: 5000, observed_at: observed, source: 'S9 rival A' },
    { product_id: products[1].id, net_cost: 10000, competitor_price: 15500, observed_at: observed, source: 'S9 rival B' },
    { product_id: products[2].id, net_cost: 10000, competitor_price: 40000, observed_at: observed, source: 'S9 rival C' },
  ] });
  const cfg = (await ok(root(l) + '/schedule', 'PUT', { version: 0, enabled: true, rule_config_version: rule.config_version, interval_minutes: 60, batch_size: 2, confirmed: true })).schedule;
  const first = await ok(root(l) + '/schedule/run', 'POST', { version: cfg.version, client_key: randomUUID() });
  const done = await drainRun(first.id ?? first.run?.id);
  assert.equal(done.state, 'success', JSON.stringify(done));
  assert.equal(done.changed, 3);
  const previews = (await pool.query('SELECT result FROM repricing_previews WHERE schedule_run_id=$1', [done.id])).rows.flatMap((r) => r.result);
  assert.equal(previews.length, 3);
  for (const row of previews) {
    assert.equal(row.strategy, 'competitor');
    assert(row.proposed_price >= row.floor, JSON.stringify(row));
    assert.equal(row.proposed_price % 100, 99);
    // floor covers cost, VAT, fee and minimum margin
    assert(BigInt(row.floor) * 100n * BigInt(10000 - 1500 - 500) >= 10000n * 123n * 10000n);
  }
  const prices = await listItems(l);
  const floor = previews.find((r) => r.product_id === products[0].id).floor;
  assert.equal(prices.get(products[0].id), Math.ceil((floor - 99) / 100) * 100 + 99); // rival at 50 zł: floor, rounded up
  assert.equal(prices.get(products[2].id), 39999);
  for (const p of products) assert(prices.get(p.id)! >= floor);
  const version = (await ok('/price-lists/' + l.id + '/items')).list.version;

  // Offer-sync of the price list to a simulated Woo channel (no provider HTTP).
  const channel = randomUUID();
  await tenantTx(DEMO, (c) => c.query("INSERT INTO channels(id,tenant_id,provider,name,mode,credentials,settings) VALUES($1,$2,'woocommerce','S9 simulation','sandbox',$3,$4)",
    [channel, DEMO, encrypt({ consumer_key: 'fixture', consumer_secret: 'fixture' }), JSON.stringify({ store_url: 'https://shop.example', simulation: true })]));
  for (const [n, p] of products.entries())
    await ok('/integrations/' + channel + '/mappings', 'POST', { external_id: String(910000 + n), sku: p.sku });
  await ok('/integrations/' + channel + '/offer-sync', 'PATCH', { version: 0, enabled: true, warehouse_id: warehouse, price_list_id: l.id, stock: false, price: true, interval_seconds: 30, verify_seconds: 3600 });
  const noHttp = { transport: async () => { throw Error('Unexpected provider HTTP'); } };
  const sync = async () => {
    const job = await ok('/integrations/' + channel + '/offer-sync', 'POST', {});
    await processOfferSync(await claim(job.id), noHttp);
    return (await pool.query('SELECT payload FROM jobs WHERE id=$1', [job.id])).rows[0].payload.stats;
  };
  const s1 = await sync();
  assert.equal(s1.queued, 3, JSON.stringify(s1));
  const plans = (await pool.query("SELECT * FROM offer_plans WHERE channel_id=$1 AND state='queued'", [channel])).rows;
  assert.equal(plans.length, 3);
  for (const plan of plans) {
    assert.equal(plan.payload.regular_price, (prices.get(plan.product_id)! / 100).toFixed(2));
    await processOfferJob(await claim(plan.job_id), noHttp);
  }
  assert.equal((await pool.query("SELECT count(*)::int n FROM offer_plans WHERE channel_id=$1 AND state='done' AND result->>'scope'='local_simulation'", [channel])).rows[0].n, 3);
  // The sync has not acknowledged the plans yet (lost ACK); the next sync reconciles them
  // from the stored result without a second write.
  assert.equal((await pool.query('SELECT count(*)::int n FROM offer_sync_items WHERE channel_id=$1 AND NOT plan_acknowledged', [channel])).rows[0].n, 3);

  // Second repricing run: same inputs, nothing changes; list version stays.
  await pool.query("UPDATE repricing_schedules SET next_at=now() WHERE price_list_id=$1", [l.id]);
  const cfg2 = (await ok(root(l) + '/schedule')).schedule;
  const second = await ok(root(l) + '/schedule/run', 'POST', { version: cfg2.version, client_key: randomUUID() });
  const done2 = await drainRun(second.id ?? second.run?.id);
  assert.equal(done2.state, 'success');
  assert.equal(done2.changed, 0);
  assert.equal(done2.unchanged, 3);
  assert.equal((await ok('/price-lists/' + l.id + '/items')).list.version, version);
  assert.deepEqual(await listItems(l), prices);

  const s2 = await sync();
  assert.equal(s2.queued, 0, JSON.stringify(s2));
  assert.equal(s2.skipped, 3, JSON.stringify(s2));
  assert.equal((await pool.query('SELECT count(*)::int n FROM offer_plans WHERE channel_id=$1', [channel])).rows[0].n, 3);
  assert.equal((await pool.query("SELECT count(*)::int n FROM offer_sync_items WHERE channel_id=$1 AND plan_acknowledged AND state='verified'", [channel])).rows[0].n, 3);
  const s3 = await sync();
  assert.equal(s3.queued + s3.unchanged, 0, JSON.stringify(s3));
  await pool.query('UPDATE offer_sync_configs SET enabled=false WHERE channel_id=$1', [channel]);
  await ok(root(l) + '/schedule', 'PUT', { version: (await ok(root(l) + '/schedule')).schedule.version, enabled: false, rule_config_version: rule.config_version, interval_minutes: 60, batch_size: 2, confirmed: true });
  console.log('S9 run: changed', done.changed, 'then', done2.changed, '; prices', JSON.stringify([...prices.values()]), '; floor', floor, '; plans', plans.length);
});

test('koszt w EUR dla cennika PLN: brak kursu i stary kurs blokują, aktualny kurs NBP z datą przelicza koszt w górę do grosza', async () => {
  const p = await product();
  const l = await list();
  let rule = await ok(root(l), 'PUT', { version: 0, config: { cost_currency: 'EUR', fee_bps: 500 } });
  rule = await ok(root(l) + '/inputs', 'PUT', { version: rule.version, items: [{ product_id: p.id, net_cost: 2501, source: 'S9 EUR supplier' }] });
  let pv = await previewOf(l, [p.id]);
  assert.equal(pv.result[0].state, 'blocked');
  assert.match(pv.result[0].reason, /Brak kursu NBP \(tabela A, EUR\)/);
  const addRate = (day: number, no: string, mid: string) =>
    pool.query(`INSERT INTO nbp227_rates(tenant_id,currency,effective_date,table_no,mid,covered_through,source,actor_id)
      SELECT $1,'EUR',d,$3||'/A/NBP/'||extract(year FROM d)::int,$4,d,'manual',(SELECT id FROM users WHERE email='admin@demo.local')
      FROM (SELECT $2::date+$5::int AS d) x`, [DEMO, today, no, mid, day]);
  await addRate(-10, '190', '4.3000');
  pv = await previewOf(l, [p.id]);
  assert.equal(pv.result[0].state, 'blocked');
  assert.match(pv.result[0].reason, /starszy niż 7 dni/);
  assert.equal((await req('/repricing-previews/' + pv.id + '/apply', 'POST', { confirmed: true })).statusCode, 409);
  await addRate(-1, '199', '4.2512');
  pv = await previewOf(l, [p.id]);
  const row = pv.result[0];
  assert.equal(row.state, 'change', JSON.stringify(row));
  assert.equal(row.fx.net_cost_original, 2501);
  assert.equal(row.fx.net_cost, 10633); // 25,01 EUR × 4,2512 = 106,322512 PLN → 106,33
  assert.equal(row.fx.rates[0].mid, '4.2512');
  assert.match(row.fx.rates[0].table_no, /^199\/A\/NBP\/\d{4}$/);
  assert(BigInt(row.floor) * 100n * 8500n >= 10633n * 123n * 10000n);
  const applied = await ok('/repricing-previews/' + pv.id + '/apply', 'POST', { confirmed: true });
  assert.equal(applied.state, 'applied');
  // A rate change after the preview invalidates its apply (the snapshot no longer matches).
  const pv2 = await previewOf(l, [p.id]);
  await pool.query("UPDATE nbp227_rates SET mid=4.3100 WHERE tenant_id=$1 AND currency='EUR' AND table_no LIKE '199/%'", [DEMO]);
  assert.equal((await req('/repricing-previews/' + pv2.id + '/apply', 'POST', { confirmed: true })).statusCode, 409);
  await pool.query("UPDATE nbp227_rates SET mid=4.2512 WHERE tenant_id=$1 AND currency='EUR' AND table_no LIKE '199/%'", [DEMO]);
  // Only an administrator changes the cost currency; an operator may edit other fields.
  rule = (await ok(root(l))).rule;
  assert.equal((await req(root(l), 'PUT', { version: rule.version, config: { ...rule.config, cost_currency: 'USD' } }, 'operator')).statusCode, 403);
  assert.equal((await req(root(l), 'PUT', { version: rule.version, config: { ...rule.config, fee_bps: 600 } }, 'viewer')).statusCode, 403);
  const edited = await ok(root(l), 'PUT', { version: rule.version, config: { ...rule.config, fee_bps: 600 } }, 'operator');
  assert.equal(edited.config.cost_currency, 'EUR');
});

test('cennik bazowy: obecna cena z bazy w innej walucie, zapis wpisu, odrzucony cykl, własna baza i brak cennika', async () => {
  const p = await product();
  const a = await list('PLN', false), b = await list('EUR', false);
  await ok('/price-lists/' + a.id + '/items', 'PUT', { version: a.version, items: [{ product_id: p.id, price: 42512 }] });
  let rb = await ok(root(b), 'PUT', { version: 0, config: { base_price_list_id: a.id, strategy: 'cost_margin', target_margin_bps: 2000 } });
  rb = await ok(root(b) + '/inputs', 'PUT', { version: rb.version, items: [{ product_id: p.id, net_cost: 7000, source: 'S9 EUR cost' }] });
  const pv = await previewOf(b, [p.id]);
  const row = pv.result[0];
  assert.equal(row.current_source, 'base');
  assert.equal(row.current_price, 10000, JSON.stringify(row)); // 425,12 PLN / 4,2512 (latest stored EUR rate)
  assert.equal(row.state, 'change');
  await ok('/repricing-previews/' + pv.id + '/apply', 'POST', { confirmed: true });
  assert.equal((await listItems(b)).get(p.id), row.proposed_price);
  const again = (await previewOf(b, [p.id])).result[0];
  assert.equal(again.current_source, 'list');
  assert.equal(again.state, 'unchanged');
  // A → B closes a cycle; a list cannot be its own base; an unknown base is 404.
  const ra = await ok(root(a), 'PUT', { version: 0, config: {} });
  const cycle = await req(root(a), 'PUT', { version: ra.version, config: { base_price_list_id: b.id } });
  assert.equal(cycle.statusCode, 422, cycle.body);
  assert.match(cycle.json().error ?? cycle.body, /cykl/i);
  assert.equal((await req(root(a), 'PUT', { version: ra.version, config: { base_price_list_id: a.id } })).statusCode, 422);
  assert.equal((await req(root(a), 'PUT', { version: ra.version, config: { base_price_list_id: randomUUID() } })).statusCode, 404);
  assert.equal((await req(root(a), 'PUT', { version: ra.version, config: { base_price_list_id: b.id } }, 'operator')).statusCode, 403);
  // A cycle created behind the API is still detected when prices are computed.
  await pool.query("UPDATE repricing_rules SET config=config||jsonb_build_object('base_price_list_id',$2::text) WHERE price_list_id=$1", [a.id, b.id]);
  await ok('/price-lists/' + b.id + '/items', 'PUT', { version: (await ok('/price-lists/' + b.id + '/items')).list.version, items: [{ product_id: p.id, price: null }] });
  const blocked = (await previewOf(b, [p.id])).result[0];
  assert.equal(blocked.state, 'blocked');
  assert.match(blocked.reason, /cykl/);
});

test('historia: najnowsze pierwsze, filtry stanu, SKU, strategii i źródła, kursor bez pominięć', async () => {
  const p1 = await product(), p2 = await product();
  const l = await list();
  let rule = await ok(root(l), 'PUT', { version: 0, config: { fee_bps: 500 } });
  rule = await ok(root(l) + '/inputs', 'PUT', { version: rule.version, items: [p1, p2].map((p) => ({ product_id: p.id, net_cost: 10000, source: 'S9 history' })) });
  const made: string[] = [];
  for (const ids of [[p1.id], [p2.id], [p1.id, p2.id]]) made.push((await previewOf(l, ids)).id);
  await ok('/repricing-previews/' + made[0] + '/apply', 'POST', { confirmed: true });
  rule = await ok(root(l), 'PUT', { version: (await ok(root(l))).rule.version, config: { ...rule.config, strategy: 'competitor' } });
  made.push((await previewOf(l, [p2.id])).id);
  await pool.query("UPDATE repricing_previews SET expires_at=now()-interval '1 minute' WHERE id=$1", [made[1]]);
  const all = await ok(root(l) + '/previews');
  assert.deepEqual(all.data.map((r: any) => r.id), [...made].reverse());
  assert.deepEqual(all.data.map((r: any) => r.strategy), ['competitor', 'cost_margin', 'cost_margin', 'cost_margin']);
  assert.equal(all.data[1].count, 2);
  assert.equal(all.data[3].state, 'applied');
  const ids = async (q: string) => (await ok(root(l) + '/previews?' + q)).data.map((r: any) => r.id);
  assert.deepEqual(await ids('state=applied'), [made[0]]);
  assert.deepEqual(await ids('state=expired'), [made[1]]);
  assert.deepEqual(await ids('state=preview'), [made[3], made[2]]);
  assert.deepEqual(await ids('sku=' + encodeURIComponent(p1.sku.slice(3, 20))), [made[2], made[0]]);
  assert.deepEqual(await ids('strategy=competitor'), [made[3]]);
  assert.deepEqual(await ids('source=schedule'), []);
  assert.deepEqual(await ids('sku=' + encodeURIComponent('%')), []);
  const seen: string[] = [];
  let cursor: string | null = null;
  do {
    const page: any = await ok(root(l) + '/previews?limit=1' + (cursor ? '&after=' + encodeURIComponent(cursor) : ''));
    seen.push(...page.data.map((r: any) => r.id));
    cursor = page.meta.cursor;
  } while (cursor);
  assert.deepEqual(seen, [...made].reverse());
  assert.equal((await req(root(l) + '/previews?after=' + randomUUID())).statusCode, 422);
  assert.equal((await req(root(l) + '/runs?after=x')).statusCode, 422);
});

test('import obserwacji konkurencji przetrwa restart aplikacji i zasila ranking', async () => {
  const p = await product();
  const l = await list();
  const rule = await ok(root(l), 'PUT', { version: 0, config: { strategy: 'competitor_rank', undercut_amount: 100, fee_bps: 0 } });
  await ok(root(l) + '/inputs', 'PUT', { version: rule.version, items: [{ product_id: p.id, net_cost: 1000, source: 'S9 rank cost' }] });
  const base = '/price-lists/' + l.id + '/competitor-observations';
  const prof = await ok(base + '/profile', 'PUT', { version: 0, profile: { source_namespace: 's9.local', own_seller_id: 'own', rank: 1, own_delivery_gross_minor: '0', max_age_minutes: 600 } });
  const at = new Date(Date.now() - 60000).toISOString().replace(/\.(\d{3})Z$/, '.$1000Z');
  const key = randomUUID();
  const imported = await ok(base + '/batches', 'POST', { client_key: key, profile_version: prof.profile.version, local_observations_confirmed: true, observations: [
    { product_id: p.id, source_namespace: 's9.local', offer_id: 'o-1', seller_id: 'rival-1', currency: 'PLN', price_gross_minor: '3000', delivery_gross_minor: '0', available: true, observed_at: at },
    { product_id: p.id, source_namespace: 's9.local', offer_id: 'o-2', seller_id: 'rival-2', currency: 'PLN', price_gross_minor: '3500', delivery_gross_minor: '0', available: true, observed_at: at },
  ] });
  const stored = (await ok(base + '/observations')).data;
  assert.equal(stored.length, 2);
  // Restart: the first app is closed; a new app and an independent connection read the rows.
  await app.close();
  app = await buildApp();
  traceErrors(app);
  for (const who of ['admin', 'operator', 'viewer']) auth[who] = await login(who + '@demo.local');
  const direct = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await direct.connect();
  try {
    const rows = (await direct.query("SELECT offer_id,price_gross_minor::text p,observed_at FROM competitor_observations WHERE price_list_id=$1 ORDER BY offer_id", [l.id])).rows;
    assert.deepEqual(rows.map((r) => [r.offer_id, r.p]), [['o-1', '3000'], ['o-2', '3500']]);
  } finally {
    await direct.end();
  }
  const restarted = (await ok(base + '/observations')).data;
  assert.deepEqual(restarted, stored);
  const replay = await ok(base + '/batches', 'POST', { client_key: key, profile_version: prof.profile.version, local_observations_confirmed: true, observations: [
    { product_id: p.id, source_namespace: 's9.local', offer_id: 'o-1', seller_id: 'rival-1', currency: 'PLN', price_gross_minor: '3000', delivery_gross_minor: '0', available: true, observed_at: at },
    { product_id: p.id, source_namespace: 's9.local', offer_id: 'o-2', seller_id: 'rival-2', currency: 'PLN', price_gross_minor: '3500', delivery_gross_minor: '0', available: true, observed_at: at },
  ] });
  assert.equal(replay.reused, true);
  assert.equal(replay.batch.id, imported.batch.id);
  const pv = await previewOf(l, [p.id]);
  assert.equal(pv.result[0].state, 'change', JSON.stringify(pv.result[0]).slice(0, 800));
  assert.equal(pv.result[0].proposed_price, 2900);
  assert(pv.result[0].proposed_price >= pv.result[0].floor);
});
