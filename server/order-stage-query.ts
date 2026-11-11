/**
 * Query helpers around the fulfilment stage and payment state (server/order-stage.ts, Uwagi v3 §1/§7):
 * one place for the list filter, the status counters and the order card, so "Gotowe do nadania" and
 * "Nieopłacone" mean the same everywhere.
 */
import type { PoolClient } from 'pg';
import { orderFulfilmentStageSql, paymentState, type PaymentState } from './order-stage';

/**
 * Filter on the fulfilment stage of orders aliased `alias`, as one SQL boolean with exactly one parameter
 * ($paramIndex, text[]). `stages` null or empty = no filter. 'ready_to_ship' matches packed orders with an
 * undispatched label and 'packed' matches only the packed orders without one; other codes match orders.status.
 */
export function stageFilterSql(
  alias: string,
  stages: string[] | null | undefined,
  paramIndex: number,
): { sql: string; params: [string[] | null] } {
  const p = `$${paramIndex}::text[]`;
  const derived = (stages ?? []).some((s) => s === 'packed' || s === 'ready_to_ship');
  // Without packed/ready_to_ship the stage equals orders.status, which keeps the status index usable.
  const stage = derived ? orderFulfilmentStageSql(alias) : `${alias}.status`;
  return { sql: `(${p} IS NULL OR ${stage}=ANY(${p}))`, params: [stages?.length ? stages : null] };
}

/**
 * SQL text: payment state of the order aliased `alias`, from a list payment summary expression (a json
 * {net, credit} like the order list's correlated subquery). Same rule as paymentState(); nominal is
 * the total less accepted return credit, 0 for a cancelled order.
 */
export function paymentStateSql(alias: string, summarySql: string): string {
  // The summary is evaluated once (ps0) and read twice.
  const nominal = `(CASE WHEN ${alias}.status='cancelled' THEN 0 ELSE greatest(${alias}.total-coalesce((ps0.s->>'credit')::numeric,0),0) END)`;
  return `(SELECT CASE WHEN ps.net>ps.nominal THEN 'overpaid' WHEN ps.net>=ps.nominal THEN 'paid' WHEN ${alias}.payment_mode='cod' THEN 'cod' WHEN ps.net>0 THEN 'partial' ELSE 'unpaid' END FROM (SELECT coalesce((ps0.s->>'net')::numeric,0) AS net,${nominal} AS nominal FROM (SELECT (${summarySql})::jsonb AS s) ps0) ps)`;
}

/** Payment state of a list row: {status, total, payment_mode} plus payment_summary {net, credit}. */
export function paymentStateFromSummary(row: {
  status: string;
  total: number | string;
  payment_mode?: string | null;
  payment_summary?: { net?: number | string; credit?: number | string } | null;
}): PaymentState {
  const net = Number(row.payment_summary?.net ?? 0), credit = Number(row.payment_summary?.credit ?? 0);
  const nominal = row.status === 'cancelled' ? 0 : Math.max(Number(row.total) - credit, 0);
  return paymentState({ payment_mode: row.payment_mode, net, nominal });
}

/** Order card: adds fulfilment_stage and payment_state (from the card's own payment balance). */
export async function orderWithStageInTx<T extends { id: string; payment: { payment_mode?: string | null; net: number; nominal: number } }>(
  c: PoolClient,
  card: T,
) {
  const stage = (
    await c.query<{ stage: string }>(`SELECT ${orderFulfilmentStageSql('o')} AS stage FROM orders o WHERE o.id=$1`, [card.id])
  ).rows[0]?.stage;
  return { ...card, fulfilment_stage: stage, payment_state: paymentState(card.payment) };
}
