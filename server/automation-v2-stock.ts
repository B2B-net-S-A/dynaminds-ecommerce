/**
 * Automation rules v2 "Zmiana stanu magazynowego" (trigger stock.changed, e.g. delivery of a missing product).
 *
 * Stock is written by many flows (PZ, WZ, MM, stocktakes, corrections, file imports, WMS, returns, SQL-only
 * writers), several of them in sources pinned by the stock writer roster. Instead of hooking every writer, a check
 * once a minute compares on_hand of the products of open orders with the value it saw last time and raises the order
 * event `stock.changed` {product_id, sku, warehouse_id, before, after} for each open order (not shipped, not
 * cancelled) containing a changed product, in the order's own warehouse. The rule then reads the current stock, so
 * the condition "Stan wystarcza" (product.stock_sufficient) can be checked.
 *
 * The last seen values live in one inert `jobs` row per tenant (state 'done', like the v2 rule state rows), so no
 * migration is needed. Only tenants with an enabled stock.changed rule are checked; the first check only records
 * the current values.
 */
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { pool, tenantTx } from './db';
import { automationOnlyEvent } from './automation-v2-triggers';

const STATE_KIND = 'automation.v2.stock_state';
const STATE_KEY = 'v2stock:state';
/** Orders still waiting for goods: a shipped, delivered, returned or cancelled order never gets this event. */
export const STOCK_OPEN_STATUSES = ['new', 'paid', 'picking', 'packed'];
/** Products (warehouse, product) of the most recent open orders followed per tenant; keeps the state row small. */
export const STOCK_TRACKED_LIMIT = 2000;
/**
 * Orders notified per changed product: the oldest open orders first (they wait longest for the delivery). A larger
 * fan-out would write that many history entries and rule evaluations for one stock change.
 */
export const STOCK_ORDERS_PER_CHANGE = 50;
/** Events per check; changes above it keep their old value and are raised by the next check. */
export const STOCK_EVENTS_PER_CHECK = 500;

type Change = { warehouse_id: string; product_id: string; sku: string; before: number; after: number };

/** One check of a tenant inside its transaction; returns the number of events raised. */
export async function checkStockChangesInTx(c: PoolClient, tenantId: string): Promise<number> {
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['automation-v2-stock:' + tenantId]);
  const state = (await c.query('SELECT id,payload FROM jobs WHERE dedup_key=$1 FOR UPDATE', [STATE_KEY])).rows[0];
  const seen: Record<string, number> = state?.payload?.seen ?? {};
  const rows = (
    await c.query(
      `SELECT x.warehouse_id,x.product_id,s.on_hand,p.sku FROM (
         SELECT o.warehouse_id,i.product_id,max(o.created_at) latest FROM orders o
         JOIN order_items i ON (i.tenant_id,i.order_id)=(o.tenant_id,o.id)
         WHERE o.status=ANY($1::text[]) GROUP BY 1,2 ORDER BY latest DESC,1,2 LIMIT $2) x
       JOIN stock s ON (s.tenant_id,s.warehouse_id,s.product_id)=($3,x.warehouse_id,x.product_id)
       JOIN products p ON (p.tenant_id,p.id)=($3,x.product_id)`,
      [STOCK_OPEN_STATUSES, STOCK_TRACKED_LIMIT, tenantId],
    )
  ).rows;
  const next: Record<string, number> = {};
  const changes: Change[] = [];
  for (const r of rows) {
    const key = r.warehouse_id + ':' + r.product_id;
    next[key] = r.on_hand;
    if (key in seen && seen[key] !== r.on_hand)
      changes.push({ warehouse_id: r.warehouse_id, product_id: r.product_id, sku: r.sku, before: seen[key], after: r.on_hand });
  }
  let events = 0;
  for (const ch of changes) {
    const key = ch.warehouse_id + ':' + ch.product_id;
    if (events >= STOCK_EVENTS_PER_CHECK) {
      next[key] = seen[key];
      continue;
    }
    const orders = (
      await c.query(
        `SELECT o.id FROM orders o WHERE o.warehouse_id=$1 AND o.status=ANY($3::text[])
           AND EXISTS(SELECT 1 FROM order_items i WHERE (i.tenant_id,i.order_id)=(o.tenant_id,o.id) AND i.product_id=$2)
         ORDER BY o.created_at,o.id LIMIT $4`,
        [ch.warehouse_id, ch.product_id, STOCK_OPEN_STATUSES, STOCK_ORDERS_PER_CHANGE],
      )
    ).rows;
    for (const o of orders) {
      await automationOnlyEvent(c, tenantId, o.id, 'stock.changed', {
        product_id: ch.product_id,
        sku: ch.sku,
        warehouse_id: ch.warehouse_id,
        before: ch.before,
        after: ch.after,
      });
      events++;
    }
  }
  const payload = JSON.stringify({ seen: next, checked_at: new Date().toISOString() });
  if (state) await c.query('UPDATE jobs SET payload=$2 WHERE id=$1', [state.id, payload]);
  else
    await c.query("INSERT INTO jobs(id,tenant_id,kind,payload,dedup_key,state) VALUES($1,$2,$3,$4,$5,'done')", [
      randomUUID(),
      tenantId,
      STATE_KIND,
      payload,
      STATE_KEY,
    ]);
  return events;
}

let lastStockCheck = 0;
/** Worker step (with the v2 time checks): at most once a minute, tenants with an enabled stock.changed rule. */
export async function scheduleV2StockChecks(tenants?: readonly string[] | null, force = false) {
  if (!force && Date.now() - lastStockCheck < 60_000) return;
  lastStockCheck = Date.now();
  const due = (
    await pool.query(
      "SELECT DISTINCT tenant_id FROM automation_rules WHERE enabled AND trigger='v2:stock.changed' AND ($1::uuid[] IS NULL OR tenant_id=ANY($1::uuid[])) LIMIT 50",
      [tenants ? [...tenants] : null],
    )
  ).rows;
  for (const t of due) await tenantTx(t.tenant_id, (c) => checkStockChangesInTx(c, t.tenant_id));
}
