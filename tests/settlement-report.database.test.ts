/** Settlement report on a real disposable PG04 clone (dynaminds_settle_20261023_NN, or dynaminds_m246/m247_YYYYMMDD_NN after 246/247):
 * the actual route with the real finance-admin authorization (payment imports
 * permission, membership re-read from the database) and the real loader. Every
 * payment figure is compared with the order card balance (paymentBalance) of the
 * same order, and three seeded orders with payment, invoice, correction and return
 * are checked to the grosz against values read from their native rows.
 * Read-only: the suite writes nothing, the clone stays reusable. */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import Fastify, { type FastifyInstance } from 'fastify';
import { pool, tenantReadTx } from '../server/db';
import { Problem } from '../server/errors';
import { paymentBalance } from '../server/payments';
import { registerSettlementReportRoutes } from '../server/settlement-report-routes';
import { totalFields } from '../server/settlement-report';

assert.equal(process.env.DYNA_TEST, 'true', 'Explicit isolated test mode required');
const selected = new URL(process.env.DATABASE_URL ?? 'invalid://missing');
assert.equal(selected.hostname, '127.0.0.1');
assert.equal(selected.port, '57084');
assert.match(selected.pathname, /^\/dynaminds_(?:settle_20261023|m(?:24[6789]|25[0123456789]|26[0123])_2026[0-9]{4})_[0-9]{2}$/);
pool.options.query_timeout = 20000;

const PERIOD = 'from=2026-10-01&to=2026-10-31';
const LCC = '04f60574-6762-41f7-94ca-4d8d7066fc58'; // local invoice + consumer credit 188 + 3 returns
const DEMO_FULL = '20c9d7af-113a-4b85-a2b7-a67c2c08dff9'; // demo invoice + demo correction + refund
const DEMO_SMALL = '4229009d-4dc3-4c16-b96a-f7bd73eaccc2';
type Who = { tenant: string; user: string; role: string };
let app: FastifyInstance;
const users = new Map<string, Who>();

const member = async (tenant: string, role: string): Promise<Who> => {
  const r = (await pool.query('SELECT user_id FROM memberships WHERE tenant_id=$1 AND role=$2 ORDER BY user_id LIMIT 1', [tenant, role])).rows[0];
  assert(r, `seed needs ${role} in ${tenant}`);
  return { tenant, user: r.user_id, role };
};
const get = (w: Who, url: string) => app.inject({ url, headers: { 'x-test-as': JSON.stringify(w) } });
const ownerOf = async (id: string) => (await pool.query('SELECT tenant_id FROM orders WHERE id=$1', [id])).rows[0].tenant_id as string;

before(async () => {
  assert.equal((await pool.query("SELECT to_regclass('public.local_consumer_credit_documents') IS NOT NULL ok")).rows[0].ok, true);
  for (const id of [LCC, DEMO_FULL, DEMO_SMALL]) {
    const t = await ownerOf(id);
    users.set(id, await member(t, 'admin'));
  }
  const demo = await ownerOf(DEMO_SMALL);
  users.set('viewer', await member(demo, 'viewer'));
  users.set('operator', await member(demo, 'operator'));
  app = Fastify();
  app.decorateRequest('actor');
  app.decorateRequest('apiScopes');
  app.addHook('onRequest', async (req: any) => {
    const w = JSON.parse(String(req.headers['x-test-as'])) as Who;
    req.actor = { tenantId: w.tenant, userId: w.user, role: w.role };
  });
  app.setErrorHandler((err: any, _req, reply) =>
    err instanceof Problem ? reply.code(err.status).send({ detail: err.message }) : reply.code(500).send({ detail: 'Nieoczekiwany błąd serwera' }));
  registerSettlementReportRoutes(app, { readOnly: false });
  await app.ready();
});
after(async () => {
  await app?.close();
  await pool.end();
});

test('seeded orders reconcile to the grosz (payment, invoice, correction, return)', async () => {
  const report = async (id: string) => {
    const r = await get(users.get(id)!, '/api/settlement-report?' + PERIOD);
    assert.equal(r.statusCode, 200, r.body);
    const body = r.json();
    const row = body.rows.find((x: any) => x.order_id === id);
    assert(row, 'row for ' + id);
    return { body, row };
  };
  const lcc = (await report(LCC)).row;
  assert.deepEqual(
    [lcc.order_total, lcc.return_credit, lcc.amount_due, lcc.received, lcc.refunded, lcc.net_paid, lcc.payment_difference, lcc.invoiced, lcc.corrections, lcc.documented, lcc.document_difference, lcc.credit_difference],
    // KOR 188 -1000 and KOR 206 -1700 (7ba753a): documented 1701 equals the amount due; only the overpayment remains.
    [4401, 2700, 1701, 4401, 0, 4401, 2700, 4401, -2700, 1701, 0, 0],
  );
  assert.equal(lcc.status, 'nadplata');
  assert.deepEqual(lcc.flags, ['nadplata']);
  assert.deepEqual([lcc.invoice_count, lcc.correction_count, lcc.returns], [1, 2, 3]);
  assert.match(lcc.correction_numbers[0], /^KOR\//);
  const full = (await report(DEMO_FULL)).row;
  assert.deepEqual(
    [full.order_total, full.return_credit, full.amount_due, full.received, full.refunded, full.net_paid, full.invoiced, full.corrections, full.documented, full.credit_difference],
    [26100, 26100, 0, 26100, 26100, 0, 26100, -26100, 0, 0],
  );
  assert.equal(full.status, 'zgodne');
  const small = (await report(DEMO_SMALL)).row;
  assert.deepEqual([small.order_total, small.received, small.refunded, small.invoiced, small.corrections, small.status], [100, 100, 100, 100, -100, 'zgodne']);
});

test('every row matches the order card balance and the native document rows', async () => {
  let checked = 0;
  for (const id of [LCC, DEMO_FULL, DEMO_SMALL]) {
    const w = users.get(id)!;
    const r = await get(w, '/api/settlement-report?' + PERIOD);
    assert.equal(r.statusCode, 200, r.body);
    const { rows, totals } = r.json();
    const expectedCount = Number((await pool.query(`SELECT count(*) n FROM orders WHERE tenant_id=$1
      AND created_at>='2026-10-01'::timestamp AT TIME ZONE 'Europe/Warsaw' AND created_at<'2026-11-01'::timestamp AT TIME ZONE 'Europe/Warsaw'`, [w.tenant])).rows[0].n);
    assert.equal(rows.length, expectedCount);
    for (const row of rows) {
      assert.equal(await ownerOf(row.order_id), w.tenant, 'tenant scope');
      if (!row.in_totals) continue;
      const b = await tenantReadTx(w.tenant, (c) => paymentBalance(c, row.order_id));
      assert.equal(row.currency, b.currency);
      assert.equal(row.received, b.received, row.number + ' received');
      assert.equal(row.refunded, b.refunded, row.number + ' refunded');
      assert.equal(row.return_credit, b.return_credit, row.number + ' return credit');
      assert.equal(row.cancelled_credit, b.cancelled_credit, row.number + ' cancelled credit');
      assert.equal(row.amount_due, b.nominal, row.number + ' nominal');
      assert.equal(row.net_paid, b.net, row.number + ' net');
      assert.equal(row.payment_difference, b.overpayment - b.amount_due, row.number + ' difference');
      assert.equal(row.courier_due, b.courier_due, row.number + ' courier');
      // Documents: independent count of native rows (invoice/correction, 188 credits and 206/207 return corrections).
      const n = (await pool.query(`SELECT (SELECT count(*) FROM documents WHERE order_id=$1 AND kind='invoice')::int inv,
        (SELECT count(*) FROM documents WHERE order_id=$1 AND kind='correction')::int+(SELECT count(*) FROM local_consumer_credit_documents WHERE order_id=$1)::int+(SELECT count(*) FROM return_credit206_documents WHERE order_id=$1)::int cor`, [row.order_id])).rows[0];
      if (row.merge_role === 'none') assert.deepEqual([row.invoice_count, row.correction_count], [n.inv, n.cor], row.number + ' documents');
      assert.equal(row.documented, row.invoiced + row.corrections);
      checked++;
    }
    for (const t of totals)
      for (const k of totalFields)
        assert.equal(t[k], rows.filter((x: any) => x.in_totals && x.currency === t.currency).reduce((s: number, x: any) => s + x[k], 0), `${t.currency} total ${k}`);
  }
  assert(checked >= 3, 'checked ' + checked);
});

test('merged orders: sources shown as scalone and kept out of totals', async () => {
  const claim = (await pool.query('SELECT m.source_order_id,m.target_order_id,o.tenant_id FROM order_merge_claims m JOIN orders o ON o.id=m.source_order_id ORDER BY 1 LIMIT 1')).rows[0];
  if (!claim) return;
  const w = await member(claim.tenant_id, 'admin');
  const { rows } = (await get(w, '/api/settlement-report?from=2026-01-01&to=2026-12-31')).json();
  const src = rows.find((x: any) => x.order_id === claim.source_order_id);
  assert.equal(src.status, 'scalone');
  assert.equal(src.in_totals, false);
  const tgt = rows.find((x: any) => x.order_id === claim.target_order_id);
  if (tgt) assert.equal(tgt.merge_role, 'target');
});

test('CSV export carries the same grosze as JSON', async () => {
  const w = users.get(LCC)!;
  const r = await get(w, '/api/settlement-report/file?' + PERIOD);
  assert.equal(r.statusCode, 200);
  assert.match(String(r.headers['content-type']), /text\/csv/);
  const cells = (l: string) => [...l.matchAll(/"((?:[^"]|"")*)"(?:,|$)/g)].map((m) => m[1].replaceAll('""', '"'));
  const lines = r.body.replace(/^﻿/, '').split('\r\n').filter(Boolean).map(cells);
  const header = lines[0];
  const number = (await pool.query('SELECT number FROM orders WHERE id=$1', [LCC])).rows[0].number;
  const row = lines.find((l) => l[0] === number)!;
  const col = (name: string) => row[header.indexOf(name)];
  assert.deepEqual([col('naleznosc_gr'), col('wplaty_gr'), col('zafakturowano_gr'), col('korekty_gr'), col('roznica_platnosci_gr')], ['1701', '4401', '4401', '-2700', '2700']);
  assert(lines.some((l) => l[0] === 'SUMA PLN'));
});

test('refusals: viewer and operator → 403, stale session role → 403, bad dates → 400, other tenant invisible', async () => {
  for (const key of ['viewer', 'operator']) {
    const r = await get(users.get(key)!, '/api/settlement-report?' + PERIOD);
    assert.equal(r.statusCode, 403, r.body);
    assert.equal(r.json().detail, 'Wymagany aktualny administrator finansów');
  }
  // Session claims admin, membership says viewer: the database membership wins.
  const stale = { ...users.get('viewer')!, role: 'admin' };
  assert.equal((await get(stale, '/api/settlement-report?' + PERIOD)).statusCode, 403);
  const admin = users.get(DEMO_SMALL)!;
  for (const q of ['from=2026-10-32&to=2026-10-31', 'from=2026-10-31&to=2026-10-01', 'from=2026-10-01', 'from=2026-10-01&to=2026-10-31&x=1']) {
    const r = await get(admin, '/api/settlement-report?' + q);
    assert.equal(r.statusCode, 400, q + ' ' + r.body);
    assert(!/SELECT |stack|at \//.test(r.body), r.body);
  }
  const other = users.get(LCC)!;
  assert.notEqual(other.tenant, admin.tenant);
  const { rows } = (await get(other, '/api/settlement-report?' + PERIOD)).json();
  assert(!rows.some((x: any) => x.order_id === DEMO_SMALL || x.order_id === DEMO_FULL));
});
