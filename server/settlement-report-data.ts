/** Database facts for the settlement report. Read-only, inside one tenant snapshot
 * (tenantReadTx: REPEATABLE READ, READ ONLY, role dyna_app with RLS); every query also
 * filters tenant_id explicitly. No new tables: orders, payment_entries, return_cases,
 * documents (demo/external/simulation/local_invoice/invoice230/b2b_invoice/b2b_correction),
 * local_consumer_credit_documents (188), return_credit206_documents (206/207), invoice232_corrections (KOR-S), receipt233_receipts (fiscal receipts) and commercial sale scopes (204). */
import type { PoolClient } from 'pg';
import { tenantReadTx } from './db';
import { ensure } from './errors';
import { commercialSaleScopeReadonlyInTx } from './commercial-sale-scope';
import { orderMergePaymentSourceIdsInTx } from './order-merge-payments';
import {
  SETTLEMENT_LIMITS,
  reconcileOrder,
  settlementTotals,
  type DocumentFact,
  type OrderFacts,
  type PaymentFact,
  type PaymentKind,
  type ReceiptFact,
  type SettlementQuery,
  type SettlementRow,
  type SettlementTotals,
} from './settlement-report';

export type SettlementReport = {
  from: string;
  to: string;
  currency: string | null;
  generated_at: string;
  rows: SettlementRow[];
  totals: SettlementTotals[];
};
type Row = Record<string, any>;
const big = (v: unknown) => BigInt(String(v ?? '0'));
const exists = async (c: PoolClient, name: string) =>
  Boolean((await c.query('SELECT to_regclass($1) IS NOT NULL AS ok', ['public.' + name])).rows[0].ok);
const push = <K, V>(m: Map<K, V[]>, k: K, v: V) => {
  const list = m.get(k);
  if (list) list.push(v);
  else m.set(k, [v]);
};

/** Signed gross and currency of every invoice/correction kind the app stores. */
const documentSql = `SELECT d.order_id,d.kind,d.mode,d.number,
  CASE d.mode
    WHEN 'local_invoice' THEN d.data#>>'{totals,gross_minor}'
    WHEN 'invoice230' THEN d.data#>>'{totals,gross_minor}'
    WHEN 'b2b_invoice' THEN d.data#>>'{fiscal_snapshot,totals,gross_minor}'
    WHEN 'b2b_correction' THEN d.data#>>'{calculation,totals,delta,gross_minor}'
    ELSE d.data->>'total' END AS gross,
  CASE d.mode
    WHEN 'b2b_invoice' THEN d.data#>>'{fiscal_snapshot,currency}'
    WHEN 'b2b_correction' THEN coalesce(d.data#>>'{calculation,currency}',d.data#>>'{calculation,fiscal_snapshot,currency}')
    ELSE d.data->>'currency' END AS currency
 FROM documents d WHERE d.tenant_id=$1 AND d.order_id=ANY($2::uuid[]) AND d.kind IN ('invoice','correction')
 ORDER BY d.created_at,d.id`;

export async function settlementReportInTx(c: PoolClient, tenantId: string, q: SettlementQuery): Promise<SettlementReport> {
  const orders = (
    await c.query(
      `SELECT id,number,customer_name,created_at,status,payment_mode,currency,total FROM orders
       WHERE tenant_id=$1 AND created_at>=$2::date::timestamp AT TIME ZONE 'Europe/Warsaw'
         AND created_at<($3::date+1)::timestamp AT TIME ZONE 'Europe/Warsaw'
         AND ($4::text IS NULL OR currency=$4)
       ORDER BY created_at,id LIMIT $5`,
      [tenantId, q.from, q.to, q.currency ?? null, SETTLEMENT_LIMITS.orders + 1],
    )
  ).rows as Row[];
  ensure(
    orders.length <= SETTLEMENT_LIMITS.orders,
    422,
    `Okres obejmuje ponad ${SETTLEMENT_LIMITS.orders} zamówień. Zawęź zakres dat.`,
  );
  const ids = orders.map((o) => o.id as string);
  // Merge ledgers: a merged source is settled on its target; the target's ledger
  // projects the incoming sources exactly as the order card balance does.
  const ledger = new Map<string, string[]>(ids.map((id) => [id, [id]]));
  const sourceOf = new Map<string, string>();
  const targets = new Set<string>();
  if (ids.length && (await exists(c, 'order_merge_claims'))) {
    const claims = (
      await c.query(
        `SELECT m.source_order_id,m.target_order_id,t.number target_number FROM order_merge_claims m
         JOIN orders t ON (t.tenant_id,t.id)=(m.tenant_id,m.target_order_id)
         WHERE m.tenant_id=$1 AND (m.source_order_id=ANY($2::uuid[]) OR m.target_order_id=ANY($2::uuid[]))`,
        [tenantId, ids],
      )
    ).rows;
    for (const m of claims) {
      if (ledger.has(m.source_order_id)) sourceOf.set(m.source_order_id, m.target_number);
      if (ledger.has(m.target_order_id)) targets.add(m.target_order_id);
    }
    for (const id of targets) if (!sourceOf.has(id)) ledger.set(id, await orderMergePaymentSourceIdsInTx(c, id));
  }
  const all = [...new Set([...ledger.values()].flat())];
  const payments = new Map<string, PaymentFact[]>();
  const documents = new Map<string, DocumentFact[]>();
  const credits = new Map<string, { credit: bigint; count: number }>();
  const cancelled = new Map<string, bigint>();
  const receipts = new Map<string, ReceiptFact[]>();
  if (all.length) {
    for (const p of (
      await c.query(
        `SELECT p.order_id,p.currency,coalesce(r.kind,p.kind) AS kind,sum(p.amount)::text amount,sum(p.fee)::text fee
         FROM payment_entries p LEFT JOIN payment_entries r ON (r.tenant_id,r.order_id,r.id)=(p.tenant_id,p.order_id,p.reversal_of)
         WHERE p.tenant_id=$1 AND p.order_id=ANY($2::uuid[]) GROUP BY 1,2,3`,
        [tenantId, all],
      )
    ).rows)
      push(payments, p.order_id, { kind: p.kind as PaymentKind, currency: p.currency, amount: big(p.amount), fee: big(p.fee) });
    for (const r of (
      await c.query(
        `SELECT order_id,coalesce(sum(refund_amount) FILTER(WHERE state IN ('refund_pending','closed')),0)::text credit,count(*)::int n
         FROM return_cases WHERE tenant_id=$1 AND order_id=ANY($2::uuid[]) GROUP BY 1`,
        [tenantId, all],
      )
    ).rows)
      credits.set(r.order_id, { credit: big(r.credit), count: r.n });
    for (const d of (await c.query(documentSql, [tenantId, all])).rows)
      push(documents, d.order_id, {
        kind: d.kind,
        source: d.mode,
        number: d.number,
        gross: d.gross !== null && /^-?\d{1,18}$/.test(String(d.gross)) ? BigInt(d.gross) : null,
        currency: d.currency ?? null,
      });
    if (await exists(c, 'local_consumer_credit_documents'))
      for (const d of (
        await c.query(
          `SELECT order_id,number,data#>>'{calculation,totals,delta,gross_minor}' gross,data#>>'{calculation,currency}' currency
           FROM local_consumer_credit_documents WHERE tenant_id=$1 AND order_id=ANY($2::uuid[]) ORDER BY created_at,id`,
          [tenantId, all],
        )
      ).rows)
        push(documents, d.order_id, {
          kind: 'correction',
          source: 'local_consumer_credit',
          number: d.number,
          gross: d.gross !== null && /^-?\d{1,18}$/.test(String(d.gross)) ? BigInt(d.gross) : null,
          currency: d.currency ?? null,
        });
    // Consumer return corrections (206/207, the successor of 188) live in their own ledger too.
    if (await exists(c, 'return_credit206_documents'))
      for (const d of (
        await c.query(
          `SELECT order_id,number,data#>>'{calculation,totals,delta,gross_minor}' gross,data#>>'{calculation,currency}' currency
           FROM return_credit206_documents WHERE tenant_id=$1 AND order_id=ANY($2::uuid[]) ORDER BY created_at,id`,
          [tenantId, all],
        )
      ).rows)
        push(documents, d.order_id, {
          kind: 'correction',
          source: 'consumer_return_credit',
          number: d.number,
          gross: d.gross !== null && /^-?\d{1,18}$/.test(String(d.gross)) ? BigInt(d.gross) : null,
          currency: d.currency ?? null,
        });
    // KOR-S corrections of FV-S invoices (232) live in their own ledger.
    if (await exists(c, 'invoice232_corrections'))
    for (const d of (await c.query(`SELECT order_id,number,gross_delta_minor::text gross,currency FROM invoice232_corrections WHERE tenant_id=$1 AND order_id=ANY($2::uuid[]) ORDER BY created_at,id`, [tenantId, all])).rows)
      push(documents, d.order_id, {
        kind: 'correction',
        source: 'invoice232_correction',
        number: d.number,
        gross: /^-?\d{1,18}$/.test(d.gross) ? BigInt(d.gross) : null,
        currency: d.currency ?? null,
      });
    // Fiscal receipts (233): printed ones document the sale (paid vs receipted); others are in print or failed.
    if (await exists(c, 'receipt233_receipts'))
      for (const r of (await c.query(`SELECT r.order_id,r.state,r.printer_receipt_number,r.gross_minor::text gross,d.number invoice_number FROM receipt233_receipts r
          LEFT JOIN receipt233_invoice_links l ON (l.tenant_id,l.receipt_id)=(r.tenant_id,r.id) LEFT JOIN documents d ON (d.tenant_id,d.id)=(l.tenant_id,l.document_id)
          WHERE r.tenant_id=$1 AND r.order_id=ANY($2::uuid[]) ORDER BY r.created_at,r.id`, [tenantId, all])).rows)
        push(receipts, r.order_id, { number: r.printer_receipt_number, state: r.state, gross: BigInt(r.gross), invoice_number: r.invoice_number ?? null });
    // Cancelled credit exists only for commercial parcel plans (204); the same
    // read-only scope function the order card balance uses computes it.
    if (await exists(c, 'order_parcel_plans'))
      for (const p of (
        await c.query(
          `SELECT DISTINCT order_id FROM order_parcel_plans WHERE tenant_id=$1 AND order_id=ANY($2::uuid[]) AND payload->>'protocol'='commercial_v1'`,
          [tenantId, all],
        )
      ).rows)
        cancelled.set(p.order_id, big((await commercialSaleScopeReadonlyInTx(c, p.order_id))?.cancelled_credit_minor));
  }
  const rows = orders.map((o) => {
    const ids = ledger.get(o.id)!;
    const facts: OrderFacts = {
      order_id: o.id,
      number: o.number,
      customer: o.customer_name,
      created_at: new Date(o.created_at).toISOString(),
      status: o.status,
      payment_mode: o.payment_mode,
      currency: o.currency,
      total: big(o.total),
      merge: {
        role: sourceOf.has(o.id) ? 'source' : targets.has(o.id) ? 'target' : 'none',
        ...(sourceOf.has(o.id) ? { target_number: sourceOf.get(o.id) } : {}),
        ledger_orders: ids.length,
      },
      payments: ids.flatMap((id) => payments.get(id) ?? []),
      documents: ids.flatMap((id) => documents.get(id) ?? []),
      return_credit: ids.reduce((s, id) => s + (credits.get(id)?.credit ?? 0n), 0n),
      cancelled_credit: ids.reduce((s, id) => s + (cancelled.get(id) ?? 0n), 0n),
      returns: ids.reduce((s, id) => s + (credits.get(id)?.count ?? 0), 0),
      receipts: ids.flatMap((id) => receipts.get(id) ?? []),
    };
    return reconcileOrder(facts);
  });
  return {
    from: q.from,
    to: q.to,
    currency: q.currency ?? null,
    generated_at: new Date().toISOString(),
    rows,
    totals: settlementTotals(rows),
  };
}

export function settlementReport(tenantId: string, q: SettlementQuery): Promise<SettlementReport> {
  return tenantReadTx(tenantId, (c) => settlementReportInTx(c, tenantId, q));
}
