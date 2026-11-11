/** Analytics reports (S7) on a fresh disposable PG04 clone dynaminds_s7_20261026_NN after the
 * real migrate(): the actual routes with the real membership re-read, RLS snapshot and loaders.
 * Seeds real orders (createProduct/createOrder, payments, status changes) in tenant A and B,
 * moves their created_at onto both 2026 DST changes, then checks:
 * - period buckets (day/week/month) against Warsaw boundaries computed by PostgreSQL,
 * - series sum = totals = chart CSV = /api/reports/sales/summary = native order rows,
 * - status/source filters, per-SKU statistics, customer analysis with masking per role,
 * - the employee report against native audit rows and payment entries; refusals,
 * - the settlement report of the same period (order totals and received payments),
 * - the other tenant is invisible everywhere.
 * Writes only new orders/products in the clone; rerun = NEW clone. */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { pool, tenantTx } from '../server/db';
import { Problem } from '../server/errors';
import { createProduct } from '../server/catalog';
import { cancelOrder, createOrder, orderSchema, productSchema, type Actor } from '../server/domain';
import { advancePaid, confirmOutstanding } from '../server/payments';
import { transitionDirectLegacyOnReturnInTx } from '../server/legacy-return-on-command';
import { registerSalesReportRoutes } from '../server/sales-report-routes';
import { registerSettlementReportRoutes } from '../server/settlement-report-routes';
import { periodBuckets, warsawDay } from '../server/reports-period';
import { SERIES_METRICS } from '../server/reports-model';

assert.equal(process.env.DYNA_TEST, 'true', 'Explicit isolated test mode required');
const selected = new URL(process.env.DATABASE_URL ?? 'invalid://missing');
assert.equal(selected.hostname, '127.0.0.1');
assert.equal(selected.port, '57084');
assert.match(selected.pathname, /^\/dynaminds_s7_20261026_[0-9]{2}$/);
pool.options.query_timeout = 60000;
// The PIM guard of every tenantTx takes several seconds on the shared PG04; same pattern as receipts233.
assert.match(pool.options.options ?? '', /-c statement_timeout=8000 /);
pool.options.options = pool.options.options!.replace('-c statement_timeout=8000 ', '-c statement_timeout=120000 ');

type Who = { tenant: string; user: string; role: string; key?: boolean };
type Owner = { tenant: string; catalog: string; warehouse: string; admin: Who; operator?: Who; viewer?: Who };
let app: FastifyInstance, A: Owner, B: Owner;
const MARK = 's7-' + randomBytes(3).toString('hex');
const ids: Record<string, string> = {};
const actor = (w: Who, role = w.role): Actor => ({ tenantId: w.tenant, userId: w.user, role: role as any, source: 'manual' } as any);
const get = (w: Who, url: string) => app.inject({ url, headers: { 'x-test-as': JSON.stringify(w) } });
const ok = async (w: Who, url: string) => {
  const r = await get(w, url);
  assert.equal(r.statusCode, 200, url + ' ' + r.body);
  return r.json();
};
const version = async (c: any, id: string) => (await c.query('SELECT version::text v FROM orders WHERE id=$1', [id])).rows[0].v as string;

async function order(o: Owner, opts: { price: number; qty: number; email: string; name?: string; country?: string; source?: string; shipping?: number; at: string; pay?: Who; flow?: 'new' | 'paid' | 'packed' | 'cancelled' }) {
  const sku = `${MARK}-${Object.keys(ids).length}`;
  const p = await tenantTx(o.tenant, (c) => createProduct(c, actor(o.admin), productSchema.parse({ name: 'Kubek ' + sku, sku, price: opts.price, vat: 23, catalog_id: o.catalog, warehouse_id: o.warehouse, quantity: 50 })));
  const id = (
    await tenantTx(o.tenant, (c) =>
      createOrder(c, actor(o.admin), orderSchema.parse({ customer_name: opts.name ?? 'Jan Testowy', email: opts.email, warehouse_id: o.warehouse, currency: 'PLN', source: opts.source ?? 'manual',
        shipping_cost: opts.shipping ?? 0, address: { street: 'Prosta 1', city: 'Warszawa', postal_code: '00-001', country: opts.country ?? 'PL', phone: '500600700' }, items: [{ product_id: p.id, quantity: opts.qty }] })),
    )
  ).id as string;
  const flow = opts.flow ?? 'new';
  const payer = opts.pay ?? o.admin;
  if (flow === 'cancelled') await tenantTx(o.tenant, (c) => cancelOrder(c, actor(o.admin), id));
  if (flow === 'paid' || flow === 'packed')
    await tenantTx(o.tenant, async (c) => {
      await confirmOutstanding(c, actor(payer), id);
      await advancePaid(c, actor(payer), id);
    });
  if (flow === 'packed') await tenantTx(o.tenant, async (c) => transitionDirectLegacyOnReturnInTx(c, actor(o.admin), id, 'picking', await version(c, id)));
  // Backdating is a fixture step: the workspace quota trigger forbids moving created_at,
  // so it runs with triggers off for this one row of the disposable clone.
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query("SET LOCAL session_replication_role='replica'");
    await c.query('UPDATE orders SET created_at=$2 WHERE id=$1', [id, opts.at]);
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
  return { id, sku };
}

async function owner(exclude: string | null): Promise<Owner> {
  const r = (
    await pool.query(
      `SELECT m.tenant_id,m.user_id,c.id catalog,(SELECT min(w.warehouse_id::text) FROM product_catalog_warehouses w WHERE w.catalog_id=c.id) warehouse
    FROM (SELECT DISTINCT ON(tenant_id) tenant_id,user_id FROM memberships WHERE role='admin' ORDER BY tenant_id,user_id) m
    JOIN product_catalogs c ON c.tenant_id=m.tenant_id AND c.is_default AND c.active
    WHERE (SELECT currency FROM tenants t WHERE t.id=m.tenant_id)='PLN' AND m.tenant_id IS DISTINCT FROM $1::uuid
    AND NOT coalesce((SELECT enabled FROM wms_policies x WHERE x.tenant_id=m.tenant_id),false)
    AND NOT coalesce((SELECT require_mfa FROM workspace_security_policies x WHERE x.tenant_id=m.tenant_id),false)
    AND NOT (public.catalog_stock_control_policy(c.id)->>'strict')::boolean
    AND EXISTS(SELECT 1 FROM product_catalog_warehouses w WHERE w.catalog_id=c.id)
    ORDER BY EXISTS(SELECT 1 FROM memberships x WHERE x.tenant_id=m.tenant_id AND x.role='operator') AND EXISTS(SELECT 1 FROM memberships x WHERE x.tenant_id=m.tenant_id AND x.role='viewer') DESC,
      (SELECT plan FROM tenants t WHERE t.id=m.tenant_id)='enterprise' DESC,m.tenant_id LIMIT 1`,
      [exclude],
    )
  ).rows[0];
  assert(r, 'seed needs an eligible tenant');
  const member = async (role: string) => {
    const u = (await pool.query('SELECT user_id FROM memberships WHERE tenant_id=$1 AND role=$2 ORDER BY user_id LIMIT 1', [r.tenant_id, role])).rows[0];
    return u ? { tenant: r.tenant_id, user: u.user_id, role } : undefined;
  };
  return { tenant: r.tenant_id, catalog: r.catalog, warehouse: r.warehouse, admin: { tenant: r.tenant_id, user: r.user_id, role: 'admin' }, operator: await member('operator'), viewer: await member('viewer') };
}

const P = 'from=2026-10-24&to=2026-10-26';
let today = '';

before(async () => {
  assert.equal((await pool.query("SELECT count(*)::int n FROM migrations WHERE name='233_fiscal_receipts'")).rows[0].n, 1, 'clone after migrate()');
  A = await owner(null);
  B = await owner(A.tenant);
  assert(A.operator && A.viewer, 'tenant A needs operator and viewer');
  for (const t of [A.tenant, B.tenant])
    assert.equal(
      (await pool.query(`SELECT count(*)::int n FROM orders WHERE tenant_id=$1 AND ((created_at>='2026-10-23' AND created_at<'2026-10-28') OR (created_at>='2026-03-27' AND created_at<'2026-04-01') OR created_at<'2026-10-01')`, [t])).rows[0].n,
      0,
      'Fresh clone required: the test windows must be empty',
    );
  today = (await pool.query("SELECT to_char((clock_timestamp() AT TIME ZONE 'Europe/Warsaw')::date,'YYYY-MM-DD') d")).rows[0].d;
  // Tenant B first: an earlier order of the e-mail that is new in A, and one in the A window.
  ids.b_old = (await order(B, { price: 999, qty: 1, email: 'nowy.s7@example.test', at: '2026-09-01T10:00:00Z' })).id;
  ids.b_in = (await order(B, { price: 777, qty: 1, email: 'obcy.s7@example.test', at: '2026-10-25T10:00:00Z', flow: 'paid' })).id;
  // Tenant A.
  const o1 = await order(A, { price: 10000, qty: 2, shipping: 1500, email: 'Klient.S7@Example.test', name: 'Jan Kowalski', at: '2026-10-24T21:59:59Z', flow: 'packed' }); // Warsaw 24.10 23:59:59 CEST
  ids.o1 = o1.id;
  ids.o2 = (await order(A, { price: 2500, qty: 1, email: 'klient.s7@example.test', name: 'Jan Kowalski', at: '2026-10-25T01:30:00Z' })).id; // 02:30 CET, second pass
  ids.o3 = (await order(A, { price: 60000, qty: 1, email: 'nowy.s7@example.test', name: 'Ewa Nowa', country: 'DE', source: 'woocommerce', at: '2026-10-25T22:59:59Z', flow: 'paid', pay: A.operator })).id; // 25.10 23:59:59 CET
  ids.o4 = (await order(A, { price: 4000, qty: 1, email: 'anulowany.s7@example.test', at: '2026-10-25T12:00:00Z', flow: 'cancelled' })).id;
  ids.o5 = (await order(A, { price: 3000, qty: 3, email: 'stary.s7@example.test', name: 'Adam Stary', at: '2026-10-25T23:00:00Z' })).id; // 26.10 00:00 CET
  ids.old = (await order(A, { price: 1000, qty: 1, email: 'stary.s7@example.test', name: 'Adam Stary', at: '2026-09-15T10:00:00Z' })).id;
  ids.noemail = (await order(A, { price: 1200, qty: 1, email: '', name: 'Bez Maila', source: 'amazon', at: '2026-10-24T08:00:00Z' })).id; // 24.10 10:00 CEST; never after the read (as_of)
  // Spring change: both instants are on Warsaw 29.03 (a 23-hour day).
  ids.s1 = (await order(A, { price: 500, qty: 1, email: 'wiosna.s7@example.test', at: '2026-03-28T23:30:00Z' })).id; // 00:30 CET
  ids.s2 = (await order(A, { price: 700, qty: 1, email: 'wiosna.s7@example.test', at: '2026-03-29T21:59:00Z' })).id; // 23:59 CEST
  app = Fastify();
  app.decorateRequest('actor');
  app.decorateRequest('apiScopes');
  app.decorateRequest('currentUser');
  app.addHook('onRequest', async (req: any) => {
    const w = JSON.parse(String(req.headers['x-test-as'])) as Who;
    req.actor = { tenantId: w.tenant, userId: w.user, role: w.role, source: w.key ? 'api' : 'session', ...(w.key ? { apiKeyId: randomUUID() } : {}) };
    if (w.key) req.apiScopes = ['orders:read', 'inventory:read', 'purchasing:read'];
  });
  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof Problem) return reply.code(err.status).send({ detail: err.message });
    if (err?.issues) return reply.code(422).send({ detail: 'walidacja' });
    process.stderr.write('s7 test 500: ' + String(err?.message ?? err).slice(0, 400) + '\n');
    return reply.code(500).send({ detail: 'Nieoczekiwany błąd serwera' });
  });
  registerSalesReportRoutes(app, { readOnly: false });
  registerSettlementReportRoutes(app, { readOnly: false });
  await app.ready();
});
after(async () => {
  await app?.close();
  await pool.end();
});

test('Warsaw buckets agree with PostgreSQL AT TIME ZONE and place the DST-edge orders correctly', async () => {
  for (const [from, to] of [['2026-10-24', '2026-10-26'], ['2026-03-28', '2026-03-30']]) {
    const body = await ok(A.admin, `/api/reports/sales/periods?from=${from}&to=${to}&granularity=day`);
    for (const b of body.buckets) {
      const sql = (await pool.query(`SELECT $1::date::timestamp AT TIME ZONE 'Europe/Warsaw' a,($2::date+1)::timestamp AT TIME ZONE 'Europe/Warsaw' b`, [b.from, b.to])).rows[0];
      assert.deepEqual([b.from_at, b.to_exclusive_at], [sql.a.toISOString(), sql.b.toISOString()], b.key);
    }
    assert.equal(body.filters.from_at, body.buckets[0].from_at);
    assert.equal(body.filters.to_exclusive_at, body.buckets.at(-1).to_exclusive_at);
  }
  const autumn = await ok(A.admin, `/api/reports/sales/periods?${P}&granularity=day`);
  assert.deepEqual(autumn.buckets.map((b: any) => b.hours), [24, 25, 24]);
  const pln = autumn.series.find((s: any) => s.currency === 'PLN');
  // 24.10: o1 (23:59:59) + no-email order; 25.10: o2 (02:30 second pass) + o3 (23:59:59); 26.10: o5 (00:00). o4 cancelled.
  assert.deepEqual(pln.points.map((p: any) => p.orders), ['2', '2', '1']);
  assert.deepEqual(pln.points.map((p: any) => p.total_gross_minor), ['22700', '62500', '9000']);
  const spring = await ok(A.admin, '/api/reports/sales/periods?from=2026-03-28&to=2026-03-30&granularity=day');
  assert.deepEqual(spring.buckets.map((b: any) => b.hours), [24, 23, 24]);
  assert.deepEqual(spring.series[0].points.map((p: any) => p.orders), ['0', '2', '0']);
  for (const id of [ids.o1, ids.o2, ids.o3, ids.o5, ids.s1, ids.s2]) {
    const at = (await pool.query('SELECT created_at FROM orders WHERE id=$1', [id])).rows[0].created_at.toISOString();
    const local = (await pool.query(`SELECT ($1::timestamptz AT TIME ZONE 'Europe/Warsaw')::date::text d`, [at])).rows[0].d;
    assert.equal(warsawDay(at), local, id);
  }
});

test('series sum = totals = chart CSV = sales summary = native orders, for every granularity', async () => {
  for (const [w, period] of [[A.admin, P], [A.admin, 'from=2026-10-01&to=2026-10-31'], [B.admin, 'from=2026-10-01&to=2026-10-31'], [A.admin, 'from=2026-03-01&to=2026-10-31']] as const) {
    const summary = await ok(w, '/api/reports/sales/summary?' + period);
    for (const g of ['day', 'week', 'month']) {
      const body = await ok(w, `/api/reports/sales/periods?${period}&granularity=${g}`);
      assert.equal(body.buckets.length, periodBuckets(body.filters.from, body.filters.to, g as any).length);
      for (const s of body.series) {
        for (const m of SERIES_METRICS) assert.equal(s.points.reduce((n: bigint, p: any) => n + BigInt(p[m]), 0n).toString(), s.totals[m], `${g} ${m} points`);
        const sales = summary.sales.find((x: any) => x.currency === s.currency);
        assert(sales, 'summary currency ' + s.currency);
        assert.deepEqual(
          [s.totals.orders, s.totals.commercial_quantity, s.totals.goods_gross_minor, s.totals.goods_net_minor, s.totals.delivery_gross_minor, s.totals.total_gross_minor],
          [String(sales.orders), sales.commercial_quantity, sales.goods_gross_minor, sales.goods_net_minor, sales.delivery_gross_minor, sales.total_gross_minor],
          `${period} ${g} = summary`,
        );
        // Source and status breakdowns partition the same totals.
        for (const part of [body.by_source, body.by_status]) {
          const mine = part.filter((x: any) => x.currency === s.currency);
          assert.equal(mine.reduce((n: bigint, x: any) => n + BigInt(x.total_gross_minor), 0n).toString(), s.totals.total_gross_minor);
        }
      }
      assert.equal(body.series.length, summary.sales.length);
      const csv = await get(w, `/api/reports/sales/periods/file?${period}&granularity=${g}&spreadsheet_safe=false`);
      assert.equal(csv.statusCode, 200);
      assert.match(String(csv.headers['content-type']), /text\/csv/);
      const lines = csv.body.slice(1).trim().split('\r\n').map((l) => l.split(',').map((c) => c.replace(/^"|"$/g, '')));
      for (const s of body.series)
        for (const m of SERIES_METRICS) {
          const i = lines[0].indexOf(m);
          const rows = lines.filter((l) => l[1] === s.currency);
          assert.equal(rows.filter((l) => l[0] === 'okres').reduce((n, l) => n + BigInt(l[i]), 0n).toString(), s.totals[m], `${g} csv rows ${m}`);
          assert.equal(rows.find((l) => l[0] === 'razem')![i], s.totals[m], `${g} csv total ${m}`);
        }
    }
  }
  // Native rows: non-cancelled orders with items in the Warsaw window (no merges or exchanges seeded here).
  const native = (
    await pool.query(
      `SELECT count(*)::text n,sum(total)::text total,sum(shipping_cost)::text delivery FROM orders o WHERE tenant_id=$1 AND status<>'cancelled'
    AND created_at>='2026-10-24'::timestamp AT TIME ZONE 'Europe/Warsaw' AND created_at<'2026-10-27'::timestamp AT TIME ZONE 'Europe/Warsaw'`,
      [A.tenant],
    )
  ).rows[0];
  const t = (await ok(A.admin, '/api/reports/sales/periods?' + P)).totals[0];
  assert.deepEqual([t.orders, t.total_gross_minor, t.delivery_gross_minor], [native.n, native.total, native.delivery]);
  assert.deepEqual([t.orders, t.total_gross_minor, t.commercial_quantity], ['5', '94200', '8']);
});

test('status and source filters narrow every part consistently; cancelled is not a sales status', async () => {
  const fresh = await ok(A.admin, `/api/reports/sales/periods?${P}&statuses=new`);
  assert.deepEqual([fresh.totals[0].orders, fresh.totals[0].total_gross_minor], ['3', '12700']); // o2, o5, no-email
  assert.deepEqual(fresh.by_status.map((x: any) => x.status), ['new']);
  const paid = await ok(A.admin, `/api/reports/sales/periods?${P}&statuses=paid,picking`);
  assert.deepEqual(paid.by_status.map((x: any) => [x.status, x.orders]), [['paid', '1'], ['picking', '1']]);
  const woo = await ok(A.admin, `/api/reports/sales/periods?${P}&sources=woocommerce&granularity=week`);
  assert.deepEqual([woo.totals[0].orders, woo.totals[0].total_gross_minor, woo.by_source.length], ['1', '60000', 1]);
  assert.deepEqual(woo.filters.sources, ['woocommerce']);
  const none = await ok(A.admin, `/api/reports/sales/periods?${P}&sources=allegro`);
  assert.deepEqual([none.series, none.totals], [[], []]);
  const refused = await get(A.admin, `/api/reports/sales/periods?${P}&statuses=cancelled`);
  assert.equal(refused.statusCode, 422);
  assert.match(refused.json().detail, /Nieobsługiwana wartość: statusy/);
  const unknown = await get(A.admin, `/api/reports/sales/periods?${P}&group_by=delivery`);
  assert.equal(unknown.statusCode, 422);
  assert.match(unknown.json().detail, /Nieobsługiwany parametr raportu/);
  // The summary of the same filtered scope cannot be asked (no filter there); filtered series still sum to their totals.
  for (const s of paid.series) assert.equal(s.points.reduce((n: bigint, p: any) => n + BigInt(p.orders), 0n).toString(), s.totals.orders);
});

test('product statistics per SKU reconcile with the summary and carry exact values', async () => {
  for (const period of [P, 'from=2026-10-01&to=2026-10-31']) {
    const body = await ok(A.admin, '/api/reports/products?' + period);
    const summary = await ok(A.admin, '/api/reports/sales/summary?' + period);
    for (const t of body.totals) {
      const s = summary.sales.find((x: any) => x.currency === t.currency);
      assert.deepEqual([t.quantity, t.gross_minor, t.net_minor], [s.commercial_quantity, s.goods_gross_minor, s.goods_net_minor], period);
    }
  }
  const body = await ok(A.admin, '/api/reports/products?' + P + '&price_edges=5000,50000');
  const bySku = (id: string) => body.data.find((s: any) => s.sku === id);
  const o1Sku = (await pool.query('SELECT sku FROM order_items WHERE order_id=$1', [ids.o1])).rows[0].sku;
  const o5Sku = (await pool.query('SELECT sku FROM order_items WHERE order_id=$1', [ids.o5])).rows[0].sku;
  const a = bySku(o1Sku);
  assert.deepEqual([a.quantity, a.gross_minor, a.min_unit_price_minor, a.max_unit_price_minor, a.avg_unit_price_minor, a.returned_quantity], ['2', '20000', '10000', '10000', '10000', '0']);
  assert.deepEqual(a.price_bands.map((b: any) => b.quantity), ['0', '2', '0']);
  assert.deepEqual([bySku(o5Sku).quantity, bySku(o5Sku).gross_minor], ['3', '9000']);
  assert.equal(body.data.some((s: any) => s.sku.startsWith(MARK) && s.gross_minor === '4000'), false, 'cancelled order excluded');
  const csv = await get(A.admin, '/api/reports/products/file?' + P + '&spreadsheet_safe=false');
  assert.equal(csv.statusCode, 200);
  const rows = csv.body.slice(1).trim().split('\r\n');
  assert.equal(rows.length - 1, body.meta.total);
  const head = rows[0].split(',').map((c) => c.replace(/"/g, ''));
  const gi = head.indexOf('gross_minor');
  assert.equal(rows.slice(1).reduce((n, l) => n + BigInt(l.split(',')[gi].replace(/"/g, '')), 0n).toString(), body.totals[0].gross_minor);
  // Operator: quantities only.
  const op = await ok(A.operator!, '/api/reports/products?' + P);
  assert.equal(op.can_read_value, false);
  assert(!/_minor|price_bands/.test(JSON.stringify(op.data)), 'no prices for operator');
  assert.equal(op.data.find((s: any) => s.sku === o1Sku).quantity, '2');
  const opCsv = await get(A.operator!, '/api/reports/products/file?' + P);
  assert(!/_minor|band_/.test(opCsv.body));
});

test('customer analysis: case-insensitive e-mail, new vs returning, countries, masking by role', async () => {
  const body = await ok(A.admin, '/api/reports/customers?' + P);
  assert.equal(body.personal_data, 'visible');
  // klient (o1+o2, new, repeat), nowy (o3, new in A although known in B), stary (o5, returning).
  assert.deepEqual(
    [body.summary.customers, body.summary.new_customers, body.summary.returning_customers, body.summary.repeat_in_period, body.summary.orders, body.summary.orders_without_email],
    [3, 2, 1, 1, 5, 1],
  );
  const summary = await ok(A.admin, '/api/reports/sales/summary?' + P);
  const pln = body.currencies.find((c: any) => c.currency === 'PLN');
  assert.equal(pln.total_gross_minor, summary.sales[0].total_gross_minor);
  assert.deepEqual([pln.identified_gross_minor, pln.returning_gross_minor, pln.avg_per_customer_minor], ['93000', '9000', '31000']);
  assert.deepEqual(body.countries.map((c: any) => [c.country, c.customers, c.orders, c.total_gross_minor]), [['DE', 1, 1, '60000'], ['PL', 2, 4, '34200']]);
  const top = body.top_customers;
  assert.deepEqual(top.map((c: any) => [c.email, c.kind, c.orders, c.total_gross_minor]), [
    ['nowy.s7@example.test', 'new', 1, '60000'],
    ['klient.s7@example.test', 'new', 2, '24000'],
    ['stary.s7@example.test', 'returning', 1, '9000'],
  ]);
  assert.equal(top[2].lifetime_orders, 2);
  for (const w of [A.operator!, A.viewer!]) {
    const masked = await ok(w, '/api/reports/customers?' + P);
    assert.equal(masked.personal_data, 'masked');
    assert.deepEqual(masked.top_customers.map((c: any) => [c.email, c.customer_name]), [['n***@e***.test', 'E. N.'], ['k***@e***.test', 'J. K.'], ['s***@e***.test', 'A. S.']]);
    assert(!/s7@example|Kowalski|Nowa|_minor/.test(JSON.stringify(masked)), 'no personal data or values for ' + w.role);
    assert.equal(masked.summary.customers, 3);
  }
});

test('employee report counts audit events per user, matches native rows and payments; admin only', async () => {
  const q = `from=${today}&to=${today}`;
  const body = await ok(A.admin, '/api/reports/employees?' + q);
  const native = (
    await pool.query(
      `SELECT user_id,count(*) FILTER(WHERE action='order.status')::int s,count(*) FILTER(WHERE action='packing.finish')::int k,
    count(*) FILTER(WHERE action IN ('payment.receipt','payment.courier_collection','payment.courier_remittance'))::int p,count(*) FILTER(WHERE action='payment.refund')::int r
    FROM audit_events WHERE tenant_id=$1 AND created_at>=$2::date::timestamp AT TIME ZONE 'Europe/Warsaw' AND created_at<($2::date+1)::timestamp AT TIME ZONE 'Europe/Warsaw' GROUP BY user_id`,
      [A.tenant, today],
    )
  ).rows.filter((r) => r.s + r.k + r.p + r.r > 0);
  assert.equal(body.employees.length, native.length);
  for (const n of native) {
    const e = body.employees.find((x: any) => x.user_id === n.user_id);
    assert.deepEqual([e.status_changes, e.packings, e.payments, e.refunds], [n.s, n.k, n.p, n.r], n.user_id);
  }
  const admin = body.employees.find((e: any) => e.user_id === A.admin.user);
  const operator = body.employees.find((e: any) => e.user_id === A.operator!.user);
  assert(admin.status_changes >= 1 && admin.payments >= 1, 'admin paid and moved o1');
  assert.equal(admin.role, 'admin');
  assert.equal(operator.role, 'operator');
  assert(operator.payments >= 1, 'operator recorded the o3 payment');
  // Payment amounts per user = payment entries recorded by that user today.
  for (const e of [admin, operator]) {
    const entries = (
      await pool.query(
        `SELECT coalesce(sum(amount),0)::text v FROM payment_entries WHERE tenant_id=$1 AND actor_id=$2 AND kind IN ('receipt','courier_collection','courier_remittance')
      AND created_at>=$3::date::timestamp AT TIME ZONE 'Europe/Warsaw' AND created_at<($3::date+1)::timestamp AT TIME ZONE 'Europe/Warsaw'`,
        [A.tenant, e.user_id, today],
      )
    ).rows[0].v;
    assert.equal(e.amounts.filter((m: any) => m.kind === 'payment').reduce((n: bigint, m: any) => n + BigInt(m.amount_minor), 0n).toString(), entries, e.role);
  }
  assert.equal(body.totals.payments, body.employees.reduce((n: number, e: any) => n + e.payments, 0));
  // Settlement report of the same orders: received = the payments seeded for o1 and o3.
  const settlement = await ok(A.admin, '/api/settlement-report?' + P);
  const rows = settlement.rows.filter((r: any) => [ids.o1, ids.o3].includes(r.order_id));
  assert.equal(rows.reduce((n: number, r: any) => n + Number(r.received), 0), 21500 + 60000);
  // Refusals: operator, viewer, API key; Polish message, no internals.
  for (const w of [A.operator!, A.viewer!, { ...A.admin, key: true }]) {
    const r = await get(w, '/api/reports/employees?' + q);
    assert.equal(r.statusCode, 403, JSON.stringify(w));
    assert.match(r.json().detail, /tylko dla administratora|tylko w sesji użytkownika/);
    assert(!/SELECT|audit_events/.test(r.body));
  }
  // A session role claim is not trusted: an operator claiming admin is refused by the membership re-read.
  const claimed = await get({ ...A.operator!, role: 'admin' }, '/api/reports/employees?' + q);
  assert.equal(claimed.statusCode, 403);
});

test('settlement report and sales periods agree on the order totals of the period', async () => {
  for (const [w, period] of [[A.admin, P], [A.admin, 'from=2026-10-01&to=2026-10-31'], [B.admin, 'from=2026-10-01&to=2026-10-31']] as const) {
    const settlement = await ok(w, '/api/settlement-report?' + period);
    const periods = await ok(w, '/api/reports/sales/periods?' + period);
    const withItems = new Set((await pool.query('SELECT DISTINCT order_id FROM order_items WHERE tenant_id=$1', [w.tenant])).rows.map((r) => r.order_id));
    const kinds = (await pool.query(`SELECT id,${(await pool.query("SELECT 1 FROM information_schema.columns WHERE table_name='orders' AND column_name='fulfillment_kind'")).rowCount ? 'fulfillment_kind' : "'sale'"} k FROM orders WHERE tenant_id=$1`, [w.tenant])).rows;
    const sale = new Set(kinds.filter((r) => r.k === 'sale').map((r) => r.id));
    const by = new Map<string, bigint>();
    for (const r of settlement.rows)
      if (r.in_totals && r.order_status !== 'cancelled' && withItems.has(r.order_id) && sale.has(r.order_id)) by.set(r.currency, (by.get(r.currency) ?? 0n) + BigInt(r.order_total));
    assert.deepEqual(
      Object.fromEntries([...by].map(([k, v]) => [k, v.toString()])),
      Object.fromEntries(periods.totals.map((t: any) => [t.currency, t.total_gross_minor])),
      period,
    );
  }
});

test('the other tenant is invisible in every report', async () => {
  const bOrders = new Set([ids.b_old, ids.b_in]);
  const aBody = JSON.stringify([
    await ok(A.admin, '/api/reports/sales/periods?' + P),
    await ok(A.admin, '/api/reports/products?' + P),
    await ok(A.admin, '/api/reports/customers?' + P),
    await ok(A.admin, `/api/reports/employees?from=${today}&to=${today}`),
  ]);
  assert(!aBody.includes('obcy.s7@example.test'));
  for (const id of bOrders) assert(!aBody.includes(id));
  const bSku = (await pool.query('SELECT sku FROM order_items WHERE order_id=$1', [ids.b_in])).rows[0].sku;
  assert(!aBody.includes(bSku));
  const b = await ok(B.admin, '/api/reports/sales/periods?' + P);
  assert.deepEqual([b.totals.length, b.totals[0].orders, b.totals[0].total_gross_minor], [1, '1', '777']);
  const bc = await ok(B.admin, '/api/reports/customers?' + P);
  assert.deepEqual(bc.top_customers.map((c: any) => c.email), ['obcy.s7@example.test']);
  const be = await ok(B.admin, `/api/reports/employees?from=${today}&to=${today}`);
  assert(be.employees.every((e: any) => e.user_id !== A.operator!.user));
  assert(!JSON.stringify(be).includes(ids.o1));
  // A user of A pretending to read tenant B is refused by the membership re-read.
  const foreign = await get({ tenant: B.tenant, user: A.operator!.user, role: 'admin' }, '/api/reports/sales/periods?' + P);
  assert.equal(foreign.statusCode, 403);
  assert.match(foreign.json().detail, /Brak aktualnego dostępu do raportów/);
});
