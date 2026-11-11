#!/usr/bin/env node
// Correctness reconciliation after a load run (profile config.correctness; run automatically at the end of run.mjs
// once every release CLI has stopped). Read only: one REPEATABLE READ READ ONLY transaction over the five tenants of
// the run, through the published port of the scale instance (like the monitor). The verdict is lib.mjs
// reconciliationVerdict: PASS only when every count below is 0 and every guard is true.
//
//   node tools/scale/load/reconcile.mjs --db dynaminds_scale_YYYYMMDD_NN --tenants <uuid,…×5> --since <ISO run start> --out <reconciliation.json>
//
// Whole state (every stock row of the five tenants, not only rows the run touched):
//   stock         Σ stock_movements.delta = on_hand; Σ stock_locations = on_hand; Σ WMS layer positions = on_hand
//                 (lot tenants); reserved = Σ active reservations (quantity − consumed − released) = Σ active
//                 reservation_locations; available = on_hand − reserved, ≥ 0 (no oversell), reserved ≤ on_hand
//   reservations  open orders (new/paid/picking/packed) hold active reservations, closed orders none
// Run window (created at or after --since):
//   orders        one order per load client key / unique e-mail, warehouse of its own tenant, total = Σ lines + shipping
//   invoices      every run invoice (230 and 157 documents) has its own shipped (or later return_*) order, one per order, gross = order total
//   payments      own order, unique client key, receipts − refunds ≤ order total
//   jobs          nothing pending or running, nothing failed
//   orphans       documents/movements/receipts/operations/automation runs without the record they belong to
//   guards        RECONCILE_GUARDS (the 15 guard functions of runs -02/-05) all true
// Exit 0 on PASS, 1 on FAIL, 2 when it could not run.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import { performance } from 'node:perf_hooks';
import { monitorPort, reconciliationVerdict, RECONCILE_GUARDS } from './lib.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const pg = createRequire(join(REPO, 'package.json'))('pg');
const STATE = process.env.SCALE_PG_STATE ?? join(REPO, 'data/scale/pg18-docker');
const { values: a } = parseArgs({ options: { db: { type: 'string' }, tenants: { type: 'string' }, since: { type: 'string' }, out: { type: 'string' } } });
for (const k of ['db', 'tenants', 'since', 'out']) if (!a[k]) { console.error(`--${k} required`); process.exit(2); }
if (!/^dynaminds_scale_\d{8}_\d{2}$/.test(a.db)) { console.error('--db must be dynaminds_scale_YYYYMMDD_NN'); process.exit(2); }
const tenants = a.tenants.split(',');
if (tenants.length !== 5 || !tenants.every((t) => /^[0-9a-f-]{36}$/.test(t))) { console.error('--tenants: five tenant uuids'); process.exit(2); }
const since = new Date(a.since);
if (Number.isNaN(since.getTime())) { console.error('--since: ISO timestamp'); process.exit(2); }

const T = 't AS (SELECT unnest($1::uuid[]) tenant_id)';
const QUERIES = {
  stock: `WITH ${T},
    s AS (SELECT s.* FROM stock s JOIN t USING (tenant_id)),
    mv AS (SELECT tenant_id, warehouse_id, product_id, sum(delta)::bigint d FROM stock_movements JOIN t USING (tenant_id) GROUP BY 1, 2, 3),
    loc AS (SELECT tenant_id, warehouse_id, product_id, sum(quantity)::bigint q FROM stock_locations JOIN t USING (tenant_id) GROUP BY 1, 2, 3),
    lay AS (SELECT tenant_id, warehouse_id, product_id, sum(quantity)::bigint q FROM wms_layer_positions JOIN t USING (tenant_id) GROUP BY 1, 2, 3),
    res AS (SELECT tenant_id, warehouse_id, product_id, sum(quantity - consumed_quantity - released_quantity)::bigint q FROM reservations JOIN t USING (tenant_id) WHERE state = 'active' GROUP BY 1, 2, 3),
    rl AS (SELECT a.tenant_id, a.warehouse_id, a.product_id, sum(a.quantity - coalesce(a.consumed_quantity, 0) - coalesce(a.released_quantity, 0))::bigint q FROM reservation_locations a
      JOIN reservations z USING (tenant_id, order_id, product_id, warehouse_id) JOIN t ON t.tenant_id = a.tenant_id WHERE z.state = 'active' GROUP BY 1, 2, 3),
    lotwh AS (SELECT DISTINCT tenant_id, warehouse_id FROM wms_layer_positions JOIN t USING (tenant_id))
    SELECT count(*)::int rows,
      count(*) FILTER (WHERE coalesce(mv.d, 0) <> s.on_hand)::int movement_mismatch,
      count(*) FILTER (WHERE coalesce(loc.q, 0) <> s.on_hand)::int location_mismatch,
      count(*) FILTER (WHERE (s.tenant_id, s.warehouse_id) IN (SELECT tenant_id, warehouse_id FROM lotwh) AND coalesce(lay.q, 0) <> s.on_hand)::int layer_mismatch,
      count(*) FILTER (WHERE coalesce(res.q, 0) <> s.reserved)::int reserved_mismatch,
      count(*) FILTER (WHERE rl.q IS NOT NULL AND rl.q <> s.reserved)::int reservation_location_mismatch,
      count(*) FILTER (WHERE s.available <> s.on_hand - s.reserved)::int available_formula,
      count(*) FILTER (WHERE s.available < 0)::int negative_available,
      count(*) FILTER (WHERE s.reserved > s.on_hand)::int reserved_over_on_hand
    FROM s LEFT JOIN mv USING (tenant_id, warehouse_id, product_id) LEFT JOIN loc USING (tenant_id, warehouse_id, product_id)
      LEFT JOIN lay USING (tenant_id, warehouse_id, product_id) LEFT JOIN res USING (tenant_id, warehouse_id, product_id) LEFT JOIN rl USING (tenant_id, warehouse_id, product_id)`,
  reservations: `WITH ${T}, x AS (SELECT o.status, r.state FROM reservations r JOIN orders o ON (o.tenant_id, o.id) = (r.tenant_id, r.order_id) JOIN t ON t.tenant_id = r.tenant_id)
    SELECT count(*) FILTER (WHERE state = 'active' AND status NOT IN ('new', 'paid', 'picking', 'packed'))::int active_on_closed_orders,
      count(*) FILTER (WHERE state = 'consumed' AND status IN ('new', 'paid', 'picking', 'packed'))::int consumed_on_open_orders,
      (SELECT count(*) FROM orders o JOIN t USING (tenant_id) WHERE o.status IN ('new', 'paid', 'picking', 'packed')
        AND NOT EXISTS (SELECT FROM reservations r WHERE (r.tenant_id, r.order_id) = (o.tenant_id, o.id) AND r.state = 'active'))::int open_orders_without_active FROM x`,
  orders: `WITH ${T}, o AS (SELECT o.* FROM orders o JOIN t USING (tenant_id) WHERE o.created_at >= $2)
    SELECT count(*)::int run_orders,
      (SELECT count(*) FROM (SELECT tenant_id, email FROM o WHERE email LIKE 'load-%@scale.example.test' GROUP BY 1, 2 HAVING count(*) > 1) d)::int duplicate_client_effects,
      count(*) FILTER (WHERE NOT EXISTS (SELECT FROM warehouses w WHERE (w.tenant_id, w.id) = (o.tenant_id, o.warehouse_id)))::int cross_tenant_warehouse,
      count(*) FILTER (WHERE o.total <> o.shipping_cost + coalesce((SELECT sum(i.line_total) FROM order_items i WHERE (i.tenant_id, i.order_id) = (o.tenant_id, o.id)), 0))::int total_mismatch FROM o`,
  invoices: `WITH ${T}, d AS (SELECT d.* FROM documents d JOIN t USING (tenant_id) WHERE d.kind = 'invoice' AND d.created_at >= $2)
    SELECT count(*)::int run_invoices,
      count(*) FILTER (WHERE NOT EXISTS (SELECT FROM orders o WHERE (o.tenant_id, o.id) = (d.tenant_id, d.order_id)))::int missing_order,
      count(*) FILTER (WHERE EXISTS (SELECT FROM orders o WHERE (o.tenant_id, o.id) = (d.tenant_id, d.order_id) AND NOT (o.status IN ('shipped', 'delivered') OR o.status LIKE 'return\\_%')))::int order_not_shipped,
      (SELECT count(*) FROM (SELECT x.tenant_id, x.order_id FROM documents x JOIN t USING (tenant_id) WHERE x.kind = 'invoice' AND x.order_id IN (SELECT order_id FROM d)
        GROUP BY 1, 2 HAVING count(*) > 1) z)::int duplicate_per_order,
      (SELECT count(*) FROM invoice230_documents i JOIN orders o ON (o.tenant_id, o.id) = (i.tenant_id, i.order_id) JOIN t ON t.tenant_id = i.tenant_id
        WHERE i.created_at >= $2 AND i.gross_minor::bigint <> o.total)::int gross_mismatch FROM d`,
  payments: `WITH ${T}, p AS (SELECT p.* FROM payment_entries p JOIN t USING (tenant_id) WHERE p.created_at >= $2)
    SELECT count(*)::int run_payments,
      count(*) FILTER (WHERE NOT EXISTS (SELECT FROM orders o WHERE (o.tenant_id, o.id) = (p.tenant_id, p.order_id)))::int missing_order,
      (SELECT count(*) FROM (SELECT tenant_id, client_key FROM p WHERE client_key IS NOT NULL GROUP BY 1, 2 HAVING count(*) > 1) z)::int duplicate_client_key,
      (SELECT count(*) FROM orders o WHERE (o.tenant_id, o.id) IN (SELECT tenant_id, order_id FROM p) AND
        (SELECT coalesce(sum(CASE e.kind WHEN 'receipt' THEN e.amount WHEN 'refund' THEN -e.amount ELSE 0 END), 0) FROM payment_entries e WHERE (e.tenant_id, e.order_id) = (o.tenant_id, o.id)) > o.total)::int overpaid_orders FROM p`,
  jobs: `WITH ${T} SELECT count(*)::int run_jobs, count(*) FILTER (WHERE state = 'pending')::int pending, count(*) FILTER (WHERE state = 'running')::int running,
      count(*) FILTER (WHERE state = 'failed')::int failed FROM jobs j WHERE j.created_at >= $2 AND (j.tenant_id IS NULL OR j.tenant_id IN (SELECT tenant_id FROM t))`,
  orphans: `WITH ${T} SELECT
      (SELECT count(*) FROM documents d JOIN t USING (tenant_id) WHERE d.created_at >= $2 AND d.order_id IS NOT NULL AND NOT EXISTS (SELECT FROM orders o WHERE (o.tenant_id, o.id) = (d.tenant_id, d.order_id)))::int documents_without_order,
      (SELECT count(*) FROM warehouse_documents w JOIN t USING (tenant_id) WHERE w.created_at >= $2 AND NOT EXISTS (SELECT FROM warehouse_document_lines l WHERE (l.tenant_id, l.document_id) = (w.tenant_id, w.id)))::int warehouse_documents_without_lines,
      (SELECT count(*) FROM stock_movements m JOIN t USING (tenant_id) WHERE m.created_at >= $2 AND m.order_id IS NOT NULL AND NOT EXISTS (SELECT FROM orders o WHERE (o.tenant_id, o.id) = (m.tenant_id, m.order_id)))::int stock_movements_without_order,
      (SELECT count(*) FROM manual_inventory_off_receipts r JOIN t USING (tenant_id) WHERE r.created_at >= $2 AND NOT EXISTS (SELECT FROM stock_movements m WHERE (m.tenant_id, m.id) = (r.tenant_id, r.stock_movement_id)))::int manual_off_without_movement,
      (SELECT count(*) FROM wms_operations w JOIN t USING (tenant_id) WHERE w.created_at >= $2 AND w.warehouse_document_id IS NOT NULL AND NOT EXISTS (SELECT FROM warehouse_documents d WHERE (d.tenant_id, d.id) = (w.tenant_id, w.warehouse_document_id)))::int wms_operations_without_document,
      (SELECT count(*) FROM automation_runs r JOIN t USING (tenant_id) WHERE r.created_at >= $2 AND r.order_id IS NOT NULL AND NOT EXISTS (SELECT FROM orders o WHERE (o.tenant_id, o.id) = (r.tenant_id, r.order_id)))::int automation_runs_without_order`,
};

const out = { schema: 'dyna-load-reconciliation/v1', database: a.db, since: since.toISOString(), tenants, started_at: new Date().toISOString(), facts: {}, ms: {} };
const password = readFileSync(join(STATE, 'secrets/postgres.password'), 'utf8').trim();
const c = new pg.Client({ connectionString: `postgres://postgres:${encodeURIComponent(password)}@127.0.0.1:${monitorPort(process.env)}/${a.db}`, application_name: 'dyna-load-reconcile', options: '-c jit=off -c timezone=UTC' });
try {
  await c.connect();
  await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); await c.query("SET LOCAL statement_timeout='900s'"); await c.query('SET LOCAL search_path TO "$user",public');
  for (const [k, sql] of Object.entries(QUERIES)) {
    const t0 = performance.now(); out.facts[k] = (await c.query(sql, k === 'stock' || k === 'reservations' ? [tenants] : [tenants, since])).rows[0]; out.ms[k] = Math.round(performance.now() - t0);
  }
  out.facts.guards = {};
  for (const g of RECONCILE_GUARDS) { const t0 = performance.now(); out.facts.guards[g] = (await c.query(`SELECT public.${g}() v`)).rows[0].v; out.ms[`guard:${g}`] = Math.round(performance.now() - t0); }
  await c.query('ROLLBACK');
} catch (e) {
  out.error = String(e.message).slice(0, 500);
} finally { await c.end().catch(() => {}); }
Object.assign(out, out.error ? { status: 'FAIL', failed: ['reconciliation_error'], checks: [] } : reconciliationVerdict(out.facts));
out.finished_at = new Date().toISOString();
writeFileSync(a.out, JSON.stringify(out, null, 1) + '\n', { mode: 0o600 });
console.log(JSON.stringify({ status: out.status, failed: out.failed, guards_true: out.guards_true ?? 0, error: out.error ?? null }));
process.exitCode = out.status === 'PASS' ? 0 : 1;
