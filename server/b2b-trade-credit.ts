/** B2B-007 trade credit (migration 246). A supplier gives a B2B account a credit line (currency, limit, term). Every
 * checkout of that account (portal, network purchase, dropshipping) is then charged to the line inside the checkout
 * transaction, under the line's row lock: an overdue balance, another currency or a limit that the order would
 * exceed throws, so the whole checkout rolls back and nothing is booked. The exposure is never stored; it is the
 * open balance (paymentBalance().amount_due, the order card and settlement report figure) of the charged orders,
 * so a payment, a return credit or a cancellation settles the credit by itself. */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { tenantReadTx, tenantTx } from './db';
import { audit, event, type Actor } from './domain';
import { ensure, Problem } from './errors';
import { paymentBalance } from './payments';
import { tradeCreditInstalled } from './b2b-trade-credit-release';
import {
  tradeCreditDecision,
  tradeCreditDueAt,
  tradeCreditLineInput,
  tradeCreditSummary,
  type TradeCreditOpenCharge,
  type TradeCreditSummary,
} from './b2b-trade-credit-model';

export type TradeCreditChannel = 'portal' | 'network' | 'dropship';
interface LineRow {
  id: string;
  tenant_id: string;
  account_id: string;
  currency: string;
  limit_minor: number;
  term_days: number;
  active: boolean;
  version: number;
  updated_at: Date;
}
const lineOf = (r: any): LineRow => ({ ...r, limit_minor: Number(r.limit_minor) });
const publicLine = (l: LineRow) => ({ id: l.id, currency: l.currency, limit_minor: l.limit_minor, term_days: l.term_days, active: l.active, version: l.version, updated_at: l.updated_at });

async function dbNow(c: PoolClient): Promise<Date> {
  return (await c.query('SELECT now() AS now')).rows[0].now as Date;
}
async function line(c: PoolClient, tenantId: string, accountId: string, lock: boolean): Promise<LineRow | null> {
  const r = (await c.query('SELECT * FROM b2b254_trade_lines WHERE tenant_id=$1 AND account_id=$2' + (lock ? ' FOR UPDATE' : ''), [tenantId, accountId])).rows[0];
  return r ? lineOf(r) : null;
}
interface OpenCharge extends TradeCreditOpenCharge {
  number: string;
  amount_minor: number;
  channel: TradeCreditChannel;
}
/** Every charged order with its current open balance (in the supplier's scope). The full paymentBalance (the
 * order card figure) runs only for orders that may still be open: a cancelled order owes nothing, and an order
 * outside any merge whose own net payments reach its total owes nothing either (amount_due = max(0, nominal − net)
 * with nominal ≤ total). Settled history therefore costs one set-based query, not ~10 queries per order. */
async function charges(c: PoolClient, tenantId: string, accountId: string): Promise<OpenCharge[]> {
  const merges = (await c.query("SELECT to_regclass('public.order_merge_claims') IS NOT NULL AS ok")).rows[0].ok === true;
  const merged = merges
    ? 'EXISTS(SELECT 1 FROM order_merge_claims m WHERE m.tenant_id=t.tenant_id AND (m.source_order_id=t.order_id OR m.target_order_id=t.order_id))'
    : 'false';
  const rows = (await c.query(
    `SELECT t.order_id,t.due_at,t.amount_minor,t.channel,o.number,
       (o.status<>'cancelled' AND (${merged} OR (
         SELECT coalesce(sum(p.amount) FILTER(WHERE coalesce(r.kind,p.kind) IN ('receipt','courier_collection')),0)
              - coalesce(sum(p.amount) FILTER(WHERE coalesce(r.kind,p.kind)='refund'),0)
         FROM payment_entries p LEFT JOIN payment_entries r ON (r.tenant_id,r.order_id,r.id)=(p.tenant_id,p.order_id,p.reversal_of)
         WHERE p.tenant_id=t.tenant_id AND p.order_id=t.order_id) < o.total)) AS maybe_open
     FROM b2b254_trade_charges t
     JOIN orders o ON (o.tenant_id,o.id)=(t.tenant_id,t.order_id)
     WHERE t.tenant_id=$1 AND t.account_id=$2 ORDER BY t.due_at,t.order_id`,
    [tenantId, accountId],
  )).rows;
  const out: OpenCharge[] = [];
  for (const r of rows)
    out.push({
      order_id: r.order_id, due_at: r.due_at, number: String(r.number), amount_minor: Number(r.amount_minor), channel: r.channel,
      amount_due: r.maybe_open ? (await paymentBalance(c, r.order_id)).amount_due : 0,
    });
  return out;
}
async function state(c: PoolClient, tenantId: string, accountId: string, l: LineRow) {
  const open = await charges(c, tenantId, accountId);
  const now = await dbNow(c);
  return { now, open, summary: tradeCreditSummary(l, open, now) };
}
function assertScope(c: PoolClient, tenantId: string) {
  return c.query("SELECT current_setting('app.tenant_id',true) AS t").then((r) => ensure(r.rows[0].t === tenantId, 500, 'Kredyt kupiecki wymaga kontekstu dostawcy'));
}

export interface TradeCreditCharge {
  amount_minor: number;
  currency: string;
  due_at: Date;
  available_minor: number;
}
/** Called by every B2B checkout right after the supplier order exists, in the supplier's scope. Without an active
 * line nothing happens (the prepaid flow is unchanged); a refusal throws and rolls the checkout back. */
export async function chargeTradeCreditInTx(c: PoolClient, account: { id: string; tenant_id: string; payment_mode: string }, orderId: string, channel: TradeCreditChannel): Promise<TradeCreditCharge | null> {
  if (!(await tradeCreditInstalled(c))) return null;
  await assertScope(c, account.tenant_id);
  const l = await line(c, account.tenant_id, account.id, true);
  if (!l?.active) return null;
  ensure(account.payment_mode === 'prepaid', 409, 'Kredyt kupiecki obsługuje konta płacące przelewem, nie za pobraniem');
  const order = (await c.query('SELECT currency FROM orders WHERE id=$1', [orderId])).rows[0];
  ensure(order, 500, 'Brak zamówienia dostawcy dla kredytu kupieckiego');
  const amount = (await paymentBalance(c, orderId)).amount_due;
  const s = await state(c, account.tenant_id, account.id, l);
  const d = tradeCreditDecision({ line: l, exposure: s.summary.exposure_minor, overdue: s.summary.overdue_minor, amount, currency: order.currency });
  if (!d.ok) throw new Problem(d.status, d.message, d.code);
  if (!d.charge) return null;
  const due = tradeCreditDueAt(s.now, l.term_days);
  await c.query(
    'INSERT INTO b2b254_trade_charges(tenant_id,order_id,account_id,line_id,channel,currency,amount_minor,exposure_before_minor,limit_minor,due_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
    [account.tenant_id, orderId, account.id, l.id, channel, l.currency, amount, s.summary.exposure_minor, l.limit_minor, due],
  );
  await audit(c, { tenantId: account.tenant_id, userId: null }, 'b2b.trade_credit.charged', orderId, {
    account_id: account.id, line_id: l.id, channel, amount_minor: amount, currency: l.currency, exposure_before_minor: s.summary.exposure_minor, limit_minor: l.limit_minor, due_at: due.toISOString(),
  });
  // Released credit makes the order ready to fulfil: new ("Nieopłacone") -> paid ("Nowe").
  const released = await c.query(
    "UPDATE orders SET status='paid',workflow_status_id=NULL,updated_at=clock_timestamp() WHERE id=$1 AND status='new'",
    [orderId],
  );
  if (released.rowCount) await event(c, account.tenant_id, orderId, 'order.paid', { from: 'new', scope: 'trade_credit' });
  return { amount_minor: amount, currency: l.currency, due_at: due, available_minor: d.available_after };
}

export interface TradeCreditView {
  available: boolean;
  line: ReturnType<typeof publicLine> | null;
  summary: TradeCreditSummary | null;
  orders: { order_id: string; number: string; channel: TradeCreditChannel; amount_minor: number; amount_due: number; due_at: Date; overdue: boolean }[];
}
/** The balance of one account as both sides see it (supplier scope). */
export async function tradeCreditViewInTx(c: PoolClient, tenantId: string, accountId: string): Promise<TradeCreditView> {
  if (!(await tradeCreditInstalled(c))) return { available: false, line: null, summary: null, orders: [] };
  const l = await line(c, tenantId, accountId, false);
  if (!l) return { available: true, line: null, summary: null, orders: [] };
  const s = await state(c, tenantId, accountId, l);
  return {
    available: true,
    line: publicLine(l),
    summary: s.summary,
    orders: s.open.filter((o) => o.amount_due > 0).slice(0, 100).map((o) => ({
      order_id: o.order_id, number: o.number, channel: o.channel, amount_minor: o.amount_minor, amount_due: o.amount_due, due_at: o.due_at, overdue: o.due_at.getTime() < s.now.getTime(),
    })),
  };
}

const params = z.object({ id: z.uuid() });
async function ownAccount(c: PoolClient, id: string, lock: boolean) {
  const a = (await c.query('SELECT id,tenant_id,payment_mode FROM b2b_accounts WHERE id=$1' + (lock ? ' FOR UPDATE' : ''), [id])).rows[0];
  ensure(a, 404, 'Nie znaleziono kontrahenta');
  return a as { id: string; tenant_id: string; payment_mode: string };
}
async function saveLine(c: PoolClient, a: Actor, accountId: string, body: unknown) {
  ensure(a.role === 'admin', 403, 'Kredyt kupiecki ustawia administrator');
  const b = tradeCreditLineInput.parse(body);
  ensure(await tradeCreditInstalled(c), 409, 'Kredyt kupiecki wymaga migracji 246; ta kopia bazy jej nie ma');
  const account = await ownAccount(c, accountId, true);
  ensure(account.payment_mode === 'prepaid', 409, 'Kredyt kupiecki obsługuje konta płacące przelewem, nie za pobraniem');
  const old = await line(c, a.tenantId, accountId, true);
  if (!old) {
    ensure(b.version === 0, 409, 'Kredyt kupiecki zmienił się; odśwież dane');
    const id = randomUUID();
    await c.query(
      'INSERT INTO b2b254_trade_lines(tenant_id,account_id,id,currency,limit_minor,term_days,active,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [a.tenantId, accountId, id, b.currency, b.limit_minor, b.term_days, b.active, a.userId],
    );
    await audit(c, a, 'b2b.trade_credit.line_created', id, { account_id: accountId, currency: b.currency, limit_minor: b.limit_minor, term_days: b.term_days, active: b.active });
  } else {
    ensure(b.version === old.version, 409, 'Kredyt kupiecki zmienił się; odśwież dane');
    if (b.currency !== old.currency)
      ensure((await state(c, a.tenantId, accountId, old)).summary.exposure_minor === 0, 409, 'Waluty kredytu nie można zmienić, dopóki są nierozliczone zamówienia');
    await c.query(
      'UPDATE b2b254_trade_lines SET currency=$3,limit_minor=$4,term_days=$5,active=$6,updated_by=$7,version=version+1,updated_at=now() WHERE tenant_id=$1 AND account_id=$2',
      [a.tenantId, accountId, b.currency, b.limit_minor, b.term_days, b.active, a.userId],
    );
    await audit(c, a, 'b2b.trade_credit.line_updated', old.id, {
      account_id: accountId, before: { currency: old.currency, limit_minor: old.limit_minor, term_days: old.term_days, active: old.active },
      after: { currency: b.currency, limit_minor: b.limit_minor, term_days: b.term_days, active: b.active },
    });
  }
  return tradeCreditViewInTx(c, a.tenantId, accountId);
}

/** Supplier side (/api/b2b/accounts/:id/trade-credit) and the network buyer's view of its supplier's line. The
 * portal buyer's view is registered with the portal session in b2b.ts. */
export function registerB2bTradeCreditRoutes(app: FastifyInstance): void {
  app.get('/api/b2b/accounts/:id/trade-credit', (r: any) =>
    tenantReadTx(r.actor.tenantId, async (c) => {
      const { id } = params.parse(r.params);
      await ownAccount(c, id, false);
      return tradeCreditViewInTx(c, r.actor.tenantId, id);
    }),
  );
  app.put('/api/b2b/accounts/:id/trade-credit', (r: any) => {
    ensure(r.actor.role === 'admin', 403, 'Kredyt kupiecki ustawia administrator');
    const { id } = params.parse(r.params);
    return tenantTx(r.actor.tenantId, (c) => saveLine(c, r.actor, id, r.body));
  });
  app.get('/api/b2b/network/links/:id/trade-credit', (r: any) =>
    tenantReadTx(r.actor.tenantId, async (c) => {
      const { id } = params.parse(r.params);
      const l = (await c.query('SELECT supplier_tenant_id,account_id FROM b2b_links WHERE id=$1', [id])).rows[0];
      ensure(l, 404, 'Nie znaleziono połączenia');
      // The link is the buyer's own; the supplier's line and orders are read in the supplier's scope.
      await c.query("SELECT set_config('app.tenant_id',$1,true)", [l.supplier_tenant_id]);
      const view = await tradeCreditViewInTx(c, l.supplier_tenant_id, l.account_id);
      return { ...view, orders: view.orders.map(({ order_id: _id, ...o }) => o) };
    }),
  );
}
