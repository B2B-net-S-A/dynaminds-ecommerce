/** ANALYTICS-002: sales grouped by source, delivery or payment, per currency, with an optional
 * comparison period. Same order set, snapshot, role re-read and value masking as the other analytics
 * reports (server/reports-analytics.ts): the sum of the groups equals the period report for the same
 * scope. Delivery and payment come from order_sales_dimensions (migration 247): an order
 * without a record is "unknown" (payment: "cod" when the order itself is cash on delivery). */
import type { PoolClient } from 'pg';
import { ensure } from './errors';
import {
  salesReportAccess as access,
  salesReportSnapshot as snapshot,
  salesReportFacts as facts,
  salesReportProject as project,
  type SalesReportActor as Actor,
  type SalesReportCaps as Caps,
} from './sales-reports';
import { countOrders, guarded, params, scopeFilters, scoped, sourceOptions } from './reports-analytics';
import { compareGroups, groupQuery, type GroupDimension, type GroupQuery, type GroupRow } from './reports-groups-model';
import { parseReportQuery, reportStatuses } from './reports-model';
import { DELIVERY_LABELS, DELIVERY_METHODS, PAYMENT_LABELS, PAYMENT_METHODS, salesDimensionsAvailable, backfillOrderSalesDimensionsInTx } from './sales-dimensions';
import { tenantTx } from './db';
import { audit } from './domain';

const GROUP_SQL: Record<GroupDimension, string> = {
  source: 'o.source',
  delivery: "coalesce(d.delivery_method,'unknown')",
  payment: "coalesce(d.payment_method,CASE WHEN po.payment_mode='cod' THEN 'cod' ELSE 'unknown' END)",
};

async function grouped(c: PoolClient, caps: Caps, q: GroupQuery, asOf: string, from: string, to: string, dims: boolean) {
  const p = params({ ...q, from, to }, asOf);
  const orders = await countOrders(c, caps, { ...q, from, to }, asOf);
  const join = dims
    ? `LEFT JOIN order_sales_dimensions d ON (d.tenant_id,d.order_id)=(o.tenant_id,o.id) JOIN orders po ON (po.tenant_id,po.id)=(o.tenant_id,o.id)`
    : `LEFT JOIN (SELECT NULL::uuid tenant_id,NULL::uuid order_id,NULL::text delivery_method,NULL::text payment_method) d ON false JOIN orders po ON (po.tenant_id,po.id)=(o.tenant_id,o.id)`;
  const rows = (
    await c.query(
      facts(caps) +
        `, scoped_facts AS (SELECT o.* FROM order_facts o WHERE ${scoped})
      SELECT o.currency,${GROUP_SQL[q.group_by]} AS "group",count(*)::int orders,sum(o.total)::text total_gross_minor,sum(o.shipping_cost)::text delivery_gross_minor,
        count(*) FILTER (WHERE d.order_id IS NULL)::int unrecorded
      FROM scoped_facts o ${join} GROUP BY 1,2 ORDER BY 1,2`,
      p,
    )
  ).rows as (GroupRow & { unrecorded: number })[];
  ensure(rows.reduce((s, r) => s + r.orders, 0) === orders, 500, 'Grupy nie obejmują wszystkich zamówień zakresu');
  return { rows, orders, unrecorded: rows.reduce((s, r) => s + r.unrecorded, 0) };
}
const label = (g: GroupDimension, key: string) =>
  g === 'delivery' ? DELIVERY_LABELS[key as keyof typeof DELIVERY_LABELS] ?? key : g === 'payment' ? PAYMENT_LABELS[key as keyof typeof PAYMENT_LABELS] ?? key : key;
const totals = (rows: readonly GroupRow[]) => {
  const t = new Map<string, { orders: number; total: bigint; delivery: bigint }>();
  for (const r of rows) {
    const x = t.get(r.currency) ?? { orders: 0, total: 0n, delivery: 0n };
    t.set(r.currency, { orders: x.orders + r.orders, total: x.total + BigInt(r.total_gross_minor), delivery: x.delivery + BigInt(r.delivery_gross_minor) });
  }
  return [...t].sort(([a], [b]) => (a < b ? -1 : 1)).map(([currency, x]) => ({ currency, orders: x.orders, total_gross_minor: x.total.toString(), delivery_gross_minor: x.delivery.toString() }));
};

export async function salesGroupReport(a: Actor, input: unknown) {
  const q = parseReportQuery(groupQuery, input) as GroupQuery;
  const { result, acl } = await guarded(a, () =>
    snapshot(a, async (c, caps, asOf) => {
      const dims = await salesDimensionsAvailable(c);
      ensure(dims || q.group_by === 'source', 503, 'Kopia nie zawiera wymiarów dostawy i płatności (migracja 247); grupuj po źródle');
      const f = await scopeFilters(c, q);
      const now = await grouped(c, caps, q, asOf, q.from, q.to, dims);
      const before = q.compare_from ? await grouped(c, caps, q, asOf, q.compare_from, q.compare_to!, dims) : null;
      return { f, asOf, dims, now, before, sources: await sourceOptions(c) };
    }),
  );
  const strip = (rows: readonly (GroupRow & { unrecorded: number })[]) => rows.map(({ unrecorded: _u, ...r }) => r);
  // Shares and value changes are derived from amounts: only value readers get them.
  const groups = compareGroups(strip(result.now.rows), result.before ? strip(result.before.rows) : null).map(({ share_bps, total_change_bps, ...r }) => ({
    ...r,
    ...(acl.can_read_value ? { share_bps, ...(result.before ? { total_change_bps } : {}) } : {}),
    label: label(q.group_by, r.group),
  }));
  return {
    ...project(
      {
        filters: { ...result.f, group_by: q.group_by },
        as_of: result.asOf,
        group_by: q.group_by,
        period: { from: q.from, to: q.to, orders: result.now.orders, unrecorded_orders: q.group_by === 'source' ? 0 : result.now.unrecorded },
        compare: result.before ? { from: q.compare_from, to: q.compare_to, orders: result.before.orders, unrecorded_orders: q.group_by === 'source' ? 0 : result.before.unrecorded } : null,
        groups,
        totals: totals(result.now.rows),
        compare_totals: result.before ? totals(result.before.rows) : null,
        dimensions_available: result.dims,
        options: {
          sources: result.sources,
          statuses: reportStatuses,
          group_by: ['source', 'delivery', 'payment'],
          delivery: DELIVERY_METHODS.map((k) => ({ key: k, label: DELIVERY_LABELS[k] })),
          payment: PAYMENT_METHODS.map((k) => ({ key: k, label: PAYMENT_LABELS[k] })),
        },
        warnings: ['status_is_current_not_historical', 'cancelled_orders_are_not_sales', 'delivery_and_payment_recorded_at_import', 'orders_without_record_are_unknown'],
      },
      acl.can_read_value,
    ),
    ...acl,
  };
}

/** Administrator: records the dimensions of orders imported before the migration from their stored inbound order. */
export async function backfillSalesDimensions(a: Actor, readOnly: boolean, body: unknown) {
  ensure((body as { confirmed?: unknown } | null)?.confirmed === true, 422, 'Potwierdź uzupełnienie wymiarów sprzedaży');
  ensure(!readOnly, 423, 'Kopia tylko do odczytu');
  ensure(!a.apiKeyId, 403, 'Raporty analityczne są dostępne tylko w sesji użytkownika');
  const acl = await access(a);
  ensure(acl.current_role === 'admin', 403, 'Uzupełnienie wymiarów sprzedaży jest dostępne tylko dla administratora');
  return tenantTx(a.tenantId, async (c) => {
    ensure(await salesDimensionsAvailable(c), 503, 'Kopia nie zawiera wymiarów dostawy i płatności (migracja 247)');
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['sales-dimensions-backfill:' + a.tenantId]);
    const out = await backfillOrderSalesDimensionsInTx(c, a.tenantId);
    await audit(c, { tenantId: a.tenantId, userId: a.userId, role: 'admin' }, 'reports.sales_dimensions.backfill', null, out);
    return out;
  });
}
