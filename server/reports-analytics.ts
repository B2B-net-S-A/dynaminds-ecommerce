/** Analytics reports (S7): sales by period/source/status with a chart series (001, 006),
 * per-SKU product statistics (004), customer analysis (003) and the employee activity
 * report from the audit log (005).
 *
 * Every report reuses the sales-report building blocks: the role re-read from
 * memberships before and after the read (409 when it changed in between), one
 * REPEATABLE READ snapshot under dyna_app with RLS on app.tenant_id, the Warsaw
 * calendar period and the same economic order set (non-cancelled, merge sources and
 * replacement orders excluded). Values (…_minor) are visible only to value readers. */
import type { PoolClient } from 'pg';
import { pool } from './db';
import { ensure } from './errors';
import {
  salesReportAccess as access,
  salesReportSnapshot as snapshot,
  salesReportFacts as facts,
  salesReportWithin as within,
  salesReportEconomic as economic,
  salesReportProject as project,
  salesReportFilters as filters,
  type SalesReportActor as Actor,
  type SalesReportAccess as Access,
  type SalesReportCaps as Caps,
} from './sales-reports';
import { foldSeries, periodBuckets, REPORT_TIME_ZONE, type DayRow } from './reports-period';
import {
  aggregateSkuStats,
  customerQuery,
  DEFAULT_PRICE_EDGES,
  employeeQuery,
  maskEmail,
  maskName,
  parseReportQuery,
  periodFileQuery,
  periodQuery,
  productFileQuery,
  productQuery,
  reportStatuses,
  SERIES_METRICS,
  seriesCsv,
  skuCsv,
  type ScopeQuery,
  type SkuPriceRow,
} from './reports-model';

const ORDER_LIMIT = 100000;
const SKU_GROUP_LIMIT = 50000;
const SKU_PAGE = 500;
type Row = Record<string, any>;

/** IAM before and after the snapshot; a role or key change in between is a 409. */
export async function guarded<T>(a: Actor, run: (acl: Access) => Promise<T>): Promise<{ result: T; acl: Access }> {
  const early = await access(a);
  const result = await run(early);
  const final = await access(a);
  ensure(JSON.stringify(early) === JSON.stringify(final), 409, 'Uprawnienia zmieniły się podczas odczytu. Odczytaj raport ponownie.');
  return { result, acl: final };
}

export const params = (q: ScopeQuery, asOf: string) => [q.from, q.to, q.warehouse_id ?? null, q.currency ?? null, asOf, q.sources ?? null, q.statuses ?? null];
/** Outer predicate on an order alias `o` that already carries the economic and warehouse/currency scope. */
export const scoped = `${within('o.created_at')} AND ($6::text[] IS NULL OR o.source=ANY($6)) AND ($7::text[] IS NULL OR o.status=ANY($7))`;

export async function scopeFilters(c: PoolClient, q: ScopeQuery) {
  return { ...(await filters(c, q)), sources: q.sources ?? null, statuses: q.statuses ?? null };
}
/** Same order set as order_facts: economic, non-cancelled, with at least one item. */
function orderSet(caps: Caps) {
  return `FROM orders o WHERE o.created_at<=$5::timestamptz AND o.status<>'cancelled' AND ${economic(caps)}
    AND ($3::uuid IS NULL OR o.warehouse_id=$3) AND ($4::text IS NULL OR o.currency=$4)
    AND EXISTS(SELECT 1 FROM order_items i WHERE (i.tenant_id,i.order_id)=(o.tenant_id,o.id)) AND ${scoped}`;
}
export async function countOrders(c: PoolClient, caps: Caps, q: ScopeQuery, asOf: string) {
  const n = Number((await c.query(`SELECT count(*)::int n ${orderSet(caps)}`, params(q, asOf))).rows[0].n);
  ensure(n <= ORDER_LIMIT, 413, 'Raport przekracza 100000 zamówień. Zawęź daty lub filtry.');
  return n;
}
export async function sourceOptions(c: PoolClient) {
  return (await c.query('SELECT DISTINCT source FROM orders ORDER BY source LIMIT 50')).rows.map((r) => r.source as string);
}

// ------------------------------------------------------------------ 001 + 006
async function periodData(a: Actor, q: ReturnType<typeof periodQuery.parse>) {
  return guarded(a, () =>
    snapshot(a, async (c, caps, asOf) => {
      const f = await scopeFilters(c, q),
        orders = await countOrders(c, caps, q, asOf);
      const rows = (
        await c.query(
          facts(caps) +
            `, scoped_facts AS (SELECT o.*,(o.created_at AT TIME ZONE '${REPORT_TIME_ZONE}')::date::text AS day FROM order_facts o WHERE ${scoped})
      SELECT currency,day,source,status,GROUPING(day)::int g_day,GROUPING(source)::int g_source,GROUPING(status)::int g_status,
        count(*)::int orders,sum(commercial_quantity)::text commercial_quantity,sum(goods_gross_minor)::text goods_gross_minor,
        sum(goods_net_minor)::text goods_net_minor,sum(shipping_cost)::text delivery_gross_minor,sum(total)::text total_gross_minor
      FROM scoped_facts GROUP BY GROUPING SETS((currency,day),(currency,source),(currency,status)) ORDER BY currency,day,source,status`,
          params(q, asOf),
        )
      ).rows;
      const metric = (r: Row) => Object.fromEntries(SERIES_METRICS.map((m) => [m, String(r[m])]));
      const days = rows.filter((r) => r.g_day === 0) as DayRow[];
      const buckets = periodBuckets(q.from, q.to, q.granularity);
      const series = foldSeries(days, buckets, q.granularity, SERIES_METRICS);
      ensure(series.reduce((s, x) => s + Number(x.totals.orders), 0) === orders, 500, 'Seria nie obejmuje wszystkich zamówień zakresu');
      return {
        filters: f,
        as_of: asOf,
        granularity: q.granularity,
        buckets,
        series,
        totals: series.map((s) => ({ currency: s.currency, ...s.totals })),
        by_source: rows.filter((r) => r.g_source === 0).map((r) => ({ currency: r.currency, source: r.source, ...metric(r) })),
        by_status: rows.filter((r) => r.g_status === 0).map((r) => ({ currency: r.currency, status: r.status, ...metric(r) })),
        options: { sources: await sourceOptions(c), statuses: reportStatuses },
        warnings: ['status_is_current_not_historical', 'cancelled_orders_are_not_sales', 'snapshot_vat_is_not_provider_tax_proof'],
      };
    }),
  );
}
export async function salesReportPeriods(a: Actor, input: unknown) {
  const { result, acl } = await periodData(a, parseReportQuery(periodQuery, input));
  return { ...project(result, acl.can_read_value), ...acl };
}
export async function salesReportPeriodsCsv(a: Actor, input: unknown) {
  const q = parseReportQuery(periodFileQuery, input);
  const { result, acl } = await periodData(a, q);
  return { csv: seriesCsv(q.from, q.to, q.granularity, result.series, acl.can_read_value, q.spreadsheet_safe), filename: `sprzedaz-okresy-${q.from}-${q.to}.csv` };
}

// ------------------------------------------------------------------ 004
async function productData(a: Actor, q: ReturnType<typeof productQuery.parse>) {
  const edges = q.price_edges ?? [...DEFAULT_PRICE_EDGES];
  return guarded(a, () =>
    snapshot(a, async (c, caps, asOf) => {
      const f = await scopeFilters(c, q);
      await countOrders(c, caps, q, asOf);
      const rows = (
        await c.query(
          facts(caps) +
            ` SELECT i.sku,o.currency,round(i.line_total::numeric/i.quantity)::text unit_price_minor,
        (array_agg(i.name ORDER BY o.created_at DESC,i.id))[1] AS name,to_char(max(o.created_at) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') latest_at,
        count(*)::int lines,sum(i.quantity)::text quantity,sum(i.line_total)::text gross_minor,sum(i.net_minor)::text net_minor,
        sum(i.accepted_quantity)::text returned_quantity,sum(i.returned_gross_minor)::text returned_gross_minor,sum(i.returned_net_minor)::text returned_net_minor
      FROM item_facts i JOIN order_facts o ON o.id=i.order_id WHERE ${scoped} AND i.quantity>0
      GROUP BY i.sku,o.currency,round(i.line_total::numeric/i.quantity) LIMIT ${SKU_GROUP_LIMIT + 1}`,
          params(q, asOf),
        )
      ).rows as SkuPriceRow[];
      ensure(rows.length <= SKU_GROUP_LIMIT, 413, 'Statystyka przekracza 50000 grup cen. Zawęź daty lub filtry.');
      const stats = aggregateSkuStats(rows, edges);
      const totals = new Map<string, Record<string, bigint>>();
      for (const s of stats) {
        const t = totals.get(s.currency) ?? { skus: 0n, quantity: 0n, returned_quantity: 0n, gross_minor: 0n, returned_gross_minor: 0n, net_minor: 0n };
        t.skus += 1n;
        for (const k of ['quantity', 'returned_quantity', 'gross_minor', 'returned_gross_minor', 'net_minor'] as const) t[k] += BigInt(s[k]);
        totals.set(s.currency, t);
      }
      return {
        filters: f,
        as_of: asOf,
        price_edges_minor: edges.map(String),
        stats,
        totals: [...totals].sort(([x], [y]) => (x < y ? -1 : 1)).map(([currency, t]) => ({ currency, ...Object.fromEntries(Object.entries(t).map(([k, v]) => [k, v.toString()])) })),
        warnings: ['returns_are_cohort_until_as_of', 'unit_price_is_rounded_line_gross_per_unit', 'cancelled_orders_are_not_sales'],
        options: { sources: await sourceOptions(c), statuses: reportStatuses },
        edges,
      };
    }),
  );
}
export async function productStatsReport(a: Actor, input: unknown) {
  const { result, acl } = await productData(a, parseReportQuery(productQuery, input));
  const { edges: _edges, stats, ...rest } = result;
  const visible = acl.can_read_value ? stats : stats.map(({ price_bands: _bands, ...s }) => s);
  return {
    ...project({ ...rest, data: visible.slice(0, SKU_PAGE) }, acl.can_read_value),
    meta: { total: stats.length, shown: Math.min(stats.length, SKU_PAGE) },
    ...acl,
  };
}
export async function productStatsCsv(a: Actor, input: unknown) {
  const q = parseReportQuery(productFileQuery, input);
  const { result, acl } = await productData(a, q);
  return { csv: skuCsv(result.stats, result.edges, acl.can_read_value, q.spreadsheet_safe), filename: `produkty-${q.from}-${q.to}.csv` };
}

// ------------------------------------------------------------------ 003
export async function customerReport(a: Actor, input: unknown) {
  const q = parseReportQuery(customerQuery, input);
  const { result, acl } = await guarded(a, () =>
    snapshot(a, async (c, caps, asOf) => {
      const f = await scopeFilters(c, q);
      await countOrders(c, caps, q, asOf);
      const cte = `WITH period_orders AS (
          SELECT o.id,o.currency,o.total,o.created_at,lower(btrim(o.email)) email_key,o.email,o.customer_name,
            nullif(upper(btrim(o.address->>'country')),'') country ${orderSet(caps)}
        ), firsts AS (
          SELECT lower(btrim(o.email)) email_key,min(o.created_at) first_at,count(*)::int lifetime_orders FROM orders o
          WHERE o.created_at<=$5::timestamptz AND o.status<>'cancelled' AND ${economic(caps)}
            AND lower(btrim(o.email)) IN (SELECT email_key FROM period_orders WHERE email_key<>'') GROUP BY 1
        ), per_customer AS (
          SELECT p.email_key,count(*)::int orders,f.first_at,f.lifetime_orders,f.first_at<$1::date::timestamp AT TIME ZONE '${REPORT_TIME_ZONE}' is_returning
          FROM period_orders p JOIN firsts f USING(email_key) GROUP BY p.email_key,f.first_at,f.lifetime_orders
        )`;
      const p = params(q, asOf);
      const summary = (
        await c.query(
          cte +
            ` SELECT (SELECT count(*)::int FROM per_customer) customers,(SELECT count(*)::int FROM per_customer WHERE NOT is_returning) new_customers,
          (SELECT count(*)::int FROM per_customer WHERE is_returning) returning_customers,(SELECT count(*)::int FROM per_customer WHERE orders>1) repeat_in_period,
          (SELECT count(*)::int FROM period_orders) orders,(SELECT count(*)::int FROM period_orders WHERE email_key='') orders_without_email`,
          p,
        )
      ).rows[0];
      const currencies = (
        await c.query(
          cte +
            ` SELECT p.currency,count(DISTINCT p.email_key) FILTER(WHERE p.email_key<>'')::int customers,
          count(DISTINCT p.email_key) FILTER(WHERE p.email_key<>'' AND NOT c.is_returning)::int new_customers,
          count(DISTINCT p.email_key) FILTER(WHERE c.is_returning)::int returning_customers,count(*)::int orders,
          sum(p.total)::text total_gross_minor,coalesce(sum(p.total) FILTER(WHERE p.email_key<>''),0)::text identified_gross_minor,
          coalesce(sum(p.total) FILTER(WHERE c.is_returning),0)::text returning_gross_minor,
          CASE WHEN count(DISTINCT p.email_key) FILTER(WHERE p.email_key<>'')>0 THEN round(sum(p.total) FILTER(WHERE p.email_key<>'')::numeric/count(DISTINCT p.email_key) FILTER(WHERE p.email_key<>''))::text END avg_per_customer_minor
          FROM period_orders p LEFT JOIN per_customer c USING(email_key) GROUP BY p.currency ORDER BY p.currency`,
          p,
        )
      ).rows;
      const countries = (
        await c.query(
          cte +
            ` SELECT coalesce(p.country,'') country,p.currency,count(DISTINCT p.email_key) FILTER(WHERE p.email_key<>'')::int customers,count(*)::int orders,sum(p.total)::text total_gross_minor
          FROM period_orders p GROUP BY 1,2 ORDER BY sum(p.total) DESC,1,2 LIMIT 250`,
          p,
        )
      ).rows;
      const top = (
        await c.query(
          cte +
            `, ranked AS (SELECT p.email_key,p.currency,count(*)::int orders,sum(p.total)::text total_gross_minor,
            (array_agg(p.email ORDER BY p.created_at DESC,p.id))[1] email,(array_agg(p.customer_name ORDER BY p.created_at DESC,p.id))[1] customer_name,
            (array_agg(p.country ORDER BY p.created_at DESC,p.id))[1] country,
            row_number() OVER(PARTITION BY p.currency ORDER BY sum(p.total) DESC,count(*) DESC,p.email_key) n
            FROM period_orders p WHERE p.email_key<>'' GROUP BY p.email_key,p.currency)
          SELECT r.*,c.first_at,c.lifetime_orders,c.is_returning FROM ranked r JOIN per_customer c USING(email_key) WHERE r.n<=20 ORDER BY r.currency,r.n`,
          p,
        )
      ).rows;
      return { f, asOf, summary, currencies, countries, top };
    }),
  );
  const admin = acl.current_role === 'admin';
  const customers = result.top.map((r) => ({
    rank: Number(r.n),
    currency: r.currency,
    email: admin ? r.email : maskEmail(r.email),
    customer_name: admin ? r.customer_name : maskName(r.customer_name),
    country: r.country ?? '',
    kind: r.is_returning ? 'returning' : 'new',
    orders: r.orders,
    lifetime_orders: r.lifetime_orders,
    first_order_at: new Date(r.first_at).toISOString(),
    total_gross_minor: r.total_gross_minor,
  }));
  return {
    ...project(
      {
        filters: { ...result.f, customer_key: 'lower(trim(email))' },
        as_of: result.asOf,
        personal_data: admin ? 'visible' : 'masked',
        summary: result.summary,
        currencies: result.currencies,
        countries: result.countries,
        top_customers: customers,
        warnings: ['returning_means_any_earlier_order_in_workspace', 'orders_without_email_are_not_customers', 'cancelled_orders_are_not_sales'],
      },
      acl.can_read_value,
    ),
    ...acl,
  };
}

// ------------------------------------------------------------------ 005
export const EMPLOYEE_ACTIONS = {
  status: ['order.status'],
  packing: ['packing.finish'],
  payment: ['payment.receipt', 'payment.courier_collection', 'payment.courier_remittance'],
  refund: ['payment.refund'],
} as const;
const allActions = Object.values(EMPLOYEE_ACTIONS).flat();

export async function employeeReport(a: Actor, input: unknown) {
  const q = parseReportQuery(employeeQuery, input);
  const early = await access(a);
  ensure(early.current_role === 'admin' && !a.apiKeyId, 403, 'Raport pracowników jest dostępny tylko dla administratora');
  const { result, acl } = await guarded(a, () =>
    snapshot(a, async (c, _caps, asOf) => {
      const p = [q.from, q.to, allActions, asOf];
      const where = `e.action=ANY($3::text[]) AND e.created_at<=$4::timestamptz AND ${within('e.created_at')}`;
      const counts = (
        await c.query(
          `SELECT e.user_id,count(*) FILTER(WHERE e.action=ANY($5))::int status_changes,count(*) FILTER(WHERE e.action=ANY($6))::int packings,
          count(*) FILTER(WHERE e.action=ANY($7))::int payments,count(*) FILTER(WHERE e.action=ANY($8))::int refunds,
          count(DISTINCT e.entity_id)::int orders_touched,min(e.created_at) first_at,max(e.created_at) last_at
          FROM audit_events e WHERE ${where} GROUP BY e.user_id ORDER BY count(*) DESC,e.user_id NULLS LAST`,
          [...p, EMPLOYEE_ACTIONS.status, EMPLOYEE_ACTIONS.packing, EMPLOYEE_ACTIONS.payment, EMPLOYEE_ACTIONS.refund],
        )
      ).rows;
      const statuses = (
        await c.query(
          `SELECT e.user_id,coalesce(e.detail->>'to','') to_status,count(*)::int n FROM audit_events e WHERE ${where} AND e.action='order.status' GROUP BY 1,2 ORDER BY 1,2`,
          p,
        )
      ).rows;
      const money = (
        await c.query(
          `SELECT e.user_id,CASE WHEN e.action='payment.refund' THEN 'refund' ELSE 'payment' END kind,coalesce(e.detail->>'currency','') currency,count(*)::int n,
          coalesce(sum((e.detail->>'amount')::bigint) FILTER(WHERE e.detail->>'amount' ~ '^-?[0-9]{1,15}$'),0)::text amount_minor,
          count(*) FILTER(WHERE NOT coalesce(e.detail->>'amount' ~ '^-?[0-9]{1,15}$',false))::int without_amount
          FROM audit_events e WHERE ${where} AND e.action LIKE 'payment.%' GROUP BY 1,2,3 ORDER BY 1,2,3`,
          p,
        )
      ).rows;
      const { warehouse_id: _w, currency: _c, ...f } = await filters(c, q);
      return { f, asOf, counts, statuses, money };
    }),
  );
  ensure(acl.current_role === 'admin', 403, 'Raport pracowników jest dostępny tylko dla administratora');
  const ids = result.counts.map((r) => r.user_id).filter(Boolean);
  // users and memberships are outside the dyna_app grant; read by id, scoped to this tenant's events.
  const people = new Map(
    (
      await pool.query(
        `SELECT u.id,u.name,u.email,m.role FROM users u LEFT JOIN memberships m ON (m.user_id,m.tenant_id)=(u.id,$1) WHERE u.id=ANY($2::uuid[])`,
        [a.tenantId, ids],
      )
    ).rows.map((r) => [r.id, r]),
  );
  const employees = result.counts.map((r) => {
    const who = r.user_id ? people.get(r.user_id) : null;
    return {
      user_id: r.user_id,
      name: r.user_id ? (who?.name ?? '') : 'Zdarzenia systemowe',
      email: who?.email ?? '',
      role: who?.role ?? null,
      status_changes: r.status_changes,
      packings: r.packings,
      payments: r.payments,
      refunds: r.refunds,
      orders_touched: r.orders_touched,
      first_at: new Date(r.first_at).toISOString(),
      last_at: new Date(r.last_at).toISOString(),
      status_targets: result.statuses.filter((s) => s.user_id === r.user_id).map((s) => ({ status: s.to_status, count: s.n })),
      amounts: result.money.filter((m) => m.user_id === r.user_id).map((m) => ({ kind: m.kind, currency: m.currency, count: m.n, amount_minor: m.amount_minor, without_amount: m.without_amount })),
    };
  });
  const sum = (k: 'status_changes' | 'packings' | 'payments' | 'refunds') => employees.reduce((s, e) => s + e[k], 0);
  return {
    filters: result.f,
    as_of: result.asOf,
    actions: EMPLOYEE_ACTIONS,
    employees,
    totals: { status_changes: sum('status_changes'), packings: sum('packings'), payments: sum('payments'), refunds: sum('refunds') },
    warnings: ['audit_log_is_the_source', 'packing_counts_finished_packing_sessions'],
    ...acl,
  };
}
