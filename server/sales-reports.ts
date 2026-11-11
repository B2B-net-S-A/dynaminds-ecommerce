import { createHmac, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { pool, localConfig } from './db';
import { ensure } from './errors';
import { spoolCatalogExport } from './catalog-export';
import { partnerReturnAcceptanceAvailable, returnAcceptedExpression } from './return-acceptance';
import { returnExchangeAvailable } from './return-exchanges';

export const SALES_REPORT_LIMITS = {
  days: 366,
  page_rows: 100,
  export_rows: 100000,
  file_bytes: 67108864,
} as const;
const currencies = ['PLN', 'EUR', 'USD', 'GBP', 'CZK'] as const;
const calendarDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => {
    const d = new Date(v + 'T00:00:00Z');
    return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, 'Niepoprawna data kalendarzowa');
const fields = {
  from: calendarDate,
  to: calendarDate,
  warehouse_id: z
    .uuid()
    .transform((v) => v.toLowerCase())
    .optional(),
  currency: z.enum(currencies).optional(),
};
function validDates(q: { from: string; to: string }) {
  const days = (Date.parse(q.to) - Date.parse(q.from)) / 86400000 + 1;
  return days >= 1 && days <= SALES_REPORT_LIMITS.days;
}
export const salesReportQuery = z
  .strictObject(fields)
  .refine(validDates, 'Zakres wymaga od 1 do 366 dat');
export const salesReportPageQuery = z
  .strictObject({
    ...fields,
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z.string().min(1).max(1500).optional(),
  })
  .refine(validDates, 'Zakres wymaga od 1 do 366 dat');
export const salesReportFileQuery = z
  .strictObject({
    ...fields,
    kind: z.enum(['orders', 'returns']),
    spreadsheet_safe: z
      .enum(['true', 'false'])
      .default('true')
      .transform((v) => v === 'true'),
  })
  .refine(validDates, 'Zakres wymaga od 1 do 366 dat');
type Query = z.infer<typeof salesReportQuery>;
type Actor = { tenantId: string; userId: string; role: string; apiKeyId?: string };
type Row = Record<string, any>;
type Access = { current_role: string; can_read_value: boolean };
type Caps = { claims: boolean; costs: boolean; partnerReturns: boolean; exchanges: boolean };
const timeZone = 'Europe/Warsaw';

/** Fresh IAM transaction is deliberately separate from the historical RR snapshot.
 * No membership/key locks survive into a business table wait. */
async function access(a: Actor): Promise<Access> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query("SET LOCAL statement_timeout='8s'");
    const role = (
      await c.query('SELECT role FROM memberships WHERE tenant_id=$1 AND user_id=$2 FOR SHARE', [
        a.tenantId,
        a.userId,
      ])
    ).rows[0]?.role;
    ensure(
      ['admin', 'operator', 'viewer'].includes(role),
      403,
      'Brak aktualnego dostępu do raportów',
    );
    let financial = role === 'admin';
    if (a.apiKeyId) {
      const key = (
        await c.query(
          `SELECT revoked_at IS NULL AND (expires_at IS NULL OR expires_at>clock_timestamp()) valid,scopes FROM api_keys WHERE tenant_id=$1 AND user_id=$2 AND id=$3 FOR SHARE`,
          [a.tenantId, a.userId, a.apiKeyId],
        )
      ).rows[0];
      ensure(key?.valid, 401, 'Klucz API wygasł lub został cofnięty');
      ensure(
        ['orders:read', 'inventory:read'].every((s) => key.scopes.includes(s)),
        403,
        'Wymagane scope orders:read i inventory:read',
      );
      financial &&= key.scopes.includes('purchasing:read');
    }
    await c.query('COMMIT');
    return { current_role: role, can_read_value: financial };
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}
async function capabilities(c: PoolClient): Promise<Caps> {
  const r = (
    await c.query(`SELECT to_regclass('public.order_merge_claims') IS NOT NULL claims,
    to_regclass('public.wms_issue_fragments') IS NOT NULL AND to_regclass('public.wms_return_fragments') IS NOT NULL costs`)
  ).rows[0];
  return {
    ...r,
    partnerReturns: await partnerReturnAcceptanceAvailable(c),
    exchanges: await returnExchangeAvailable(c),
  };
}
async function snapshot<T>(a: Actor, fn: (c: PoolClient, caps: Caps, asOf: string) => Promise<T>) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await c.query('SET LOCAL ROLE dyna_app');
    await c.query("SELECT set_config('app.tenant_id',$1,true)", [a.tenantId]);
    await c.query("SET LOCAL TimeZone='UTC'");
    await c.query("SET LOCAL statement_timeout='8s'");
    const asOf = (
      await c.query('SELECT transaction_timestamp() as_of')
    ).rows[0].as_of.toISOString();
    const result = await fn(c, await capabilities(c), asOf);
    await c.query('COMMIT');
    return result;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}
async function filters(c: PoolClient, q: Query) {
  if (q.warehouse_id)
    ensure(
      (await c.query('SELECT 1 FROM warehouses WHERE id=$1', [q.warehouse_id])).rowCount,
      404,
      'Nie znaleziono własnego magazynu',
    );
  const clocks = (
    await c.query(
      `SELECT $1::date::timestamp AT TIME ZONE 'Europe/Warsaw' from_at,
    ($2::date+1)::timestamp AT TIME ZONE 'Europe/Warsaw' to_exclusive_at`,
      [q.from, q.to],
    )
  ).rows[0];
  return {
    from: q.from,
    to: q.to,
    time_zone: timeZone,
    warehouse_id: q.warehouse_id ?? null,
    currency: q.currency ?? null,
    from_at: clocks.from_at.toISOString(),
    to_exclusive_at: clocks.to_exclusive_at.toISOString(),
  };
}
const params = (q: Query, asOf: string) => [
  q.from,
  q.to,
  q.warehouse_id ?? null,
  q.currency ?? null,
  asOf,
];
const within = (field: string) =>
  `${field}>=$1::date::timestamp AT TIME ZONE 'Europe/Warsaw' AND ${field}<($2::date+1)::timestamp AT TIME ZONE 'Europe/Warsaw'`;
const economic = (caps: Caps) =>
  '(' +
  (caps.claims
    ? `NOT EXISTS(SELECT 1 FROM order_merge_claims cl WHERE (cl.tenant_id,cl.source_order_id)=(o.tenant_id,o.id))`
    : 'TRUE') +
  (caps.exchanges ? " AND o.fulfillment_kind='sale'" : '') +
  ')';

/** Every independent fact is aggregated before joining another fact. Revenue never
 * joins physical layers directly. Historical item VAT is a model basis, not an invoice. */
function facts(caps: Caps, events = false, scoped = false) {
  const accepted = returnAcceptedExpression(caps.partnerReturns);
  const issues = caps.costs
    ? `SELECT f.order_id,f.product_id,f.currency,sum(f.quantity)::numeric quantity,
    sum(CASE WHEN f.unit_cost_minor IS NULL THEN f.quantity ELSE 0 END)::numeric unknown_quantity,
    coalesce(sum(f.value_minor),0)::numeric known_minor FROM wms_issue_fragments f
    JOIN active_orders o ON (o.tenant_id,o.id)=(f.tenant_id,f.order_id) WHERE f.created_at<=$5::timestamptz GROUP BY f.order_id,f.product_id,f.currency`
    : `SELECT NULL::uuid order_id,NULL::uuid product_id,NULL::text currency,0::numeric quantity,0::numeric unknown_quantity,0::numeric known_minor WHERE false`;
  const restocks = caps.costs
    ? `SELECT f.order_id,f.product_id,i.currency,sum(f.quantity)::numeric quantity,
    sum(CASE WHEN i.unit_cost_minor IS NULL THEN f.quantity ELSE 0 END)::numeric unknown_quantity,
    coalesce(sum(f.value_minor),0)::numeric known_minor FROM wms_return_fragments f
    JOIN wms_issue_fragments i ON (i.tenant_id,i.id)=(f.tenant_id,f.issue_fragment_id)
    JOIN active_orders o ON (o.tenant_id,o.id)=(f.tenant_id,f.order_id) WHERE f.created_at<=$5::timestamptz GROUP BY f.order_id,f.product_id,i.currency`
    : `SELECT NULL::uuid order_id,NULL::uuid product_id,NULL::text currency,0::numeric quantity,0::numeric unknown_quantity,0::numeric known_minor WHERE false`;
  const warrantyCosts =
    caps.exchanges && caps.costs
      ? `SELECT x.original_order_id order_id,
       coalesce(sum(f.value_minor) FILTER(WHERE f.currency=o.currency),0)::numeric known_minor,
       sum(CASE WHEN f.unit_cost_minor IS NULL THEN f.quantity ELSE 0 END)::numeric unknown_quantity,
       bool_or(f.currency<>o.currency) currency_mismatch
       FROM return_exchanges x JOIN active_orders o ON (o.tenant_id,o.id)=(x.tenant_id,x.original_order_id)
       JOIN wms_issue_fragments f ON (f.tenant_id,f.order_id)=(x.tenant_id,x.replacement_order_id)
       WHERE x.created_at<=$5::timestamptz AND f.created_at<=$5::timestamptz GROUP BY x.original_order_id`
      : `SELECT NULL::uuid order_id,0::numeric known_minor,0::numeric unknown_quantity,false currency_mismatch WHERE false`;
  return `WITH report_parameters AS (SELECT $1::date from_date,$2::date to_date,$3::uuid warehouse_id,$4::text currency,$5::timestamptz as_of), active_orders AS (
    SELECT o.id,o.tenant_id,o.number,o.created_at,o.warehouse_id,o.currency,o.status,o.source,o.shipping_cost,o.total
    FROM orders o WHERE o.created_at<=$5::timestamptz AND o.status<>'cancelled' AND ${economic(caps)}
    AND ${events ? 'TRUE' : '(($3::uuid IS NULL OR o.warehouse_id=$3) AND ($4::text IS NULL OR o.currency=$4))'} AND ${scoped ? 'o.id=ANY($6::uuid[])' : 'TRUE'}
  ), returned_lines AS (
    SELECT r.id return_id,r.number,r.order_id,r.warehouse_id,r.received_at,${accepted} accepted_at,r.refunded_shipping,r.receipt_sequence,
      x.item_id,${caps.exchanges ? "CASE WHEN r.remedy='exchange' THEN 0 ELSE x.accepted END" : 'x.accepted'} accepted,x.accepted physically_accepted,x.restocked,x.refund_amount,i.line_total,i.vat,
      coalesce(sum(x.refund_amount) OVER(PARTITION BY x.item_id ORDER BY ${accepted},r.receipt_sequence,r.id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0) prior
    FROM return_cases r JOIN return_items x ON (x.tenant_id,x.return_id)=(r.tenant_id,r.id)
    JOIN order_items i ON (i.tenant_id,i.order_id,i.id)=(x.tenant_id,x.order_id,x.item_id)
    JOIN active_orders o ON (o.tenant_id,o.id)=(r.tenant_id,r.order_id)
    WHERE ${accepted} IS NOT NULL AND ${accepted}<=$5::timestamptz
  ), returned_values AS (
    SELECT *,round((line_total::numeric-prior)*100/(100+vat))-round((line_total::numeric-prior-refund_amount)*100/(100+vat)) net_minor FROM returned_lines
  ), returned_items AS (
    SELECT item_id,sum(accepted)::numeric accepted_quantity,sum(physically_accepted)::numeric physically_accepted_quantity,sum(restocked)::numeric restocked_quantity,
      sum(refund_amount)::numeric gross_minor,sum(net_minor)::numeric net_minor FROM returned_values GROUP BY item_id
  ), item_facts AS (
    SELECT i.*,round(i.line_total::numeric*100/(100+i.vat)) net_minor,
      coalesce(r.accepted_quantity,0) accepted_quantity,coalesce(r.physically_accepted_quantity,0) physically_accepted_quantity,coalesce(r.restocked_quantity,0) restocked_quantity,
      coalesce(r.gross_minor,0) returned_gross_minor,coalesce(r.net_minor,0) returned_net_minor
    FROM order_items i JOIN active_orders o ON (o.tenant_id,o.id)=(i.tenant_id,i.order_id)
    LEFT JOIN returned_items r ON r.item_id=i.id
  ), goods AS (
    SELECT order_id,sum(quantity)::numeric commercial_quantity,sum(line_total)::numeric goods_gross_minor,sum(net_minor)::numeric goods_net_minor,
      sum(accepted_quantity) accepted_quantity,sum(physically_accepted_quantity) physically_accepted_quantity,sum(restocked_quantity) restocked_quantity,
      sum(returned_gross_minor) returned_goods_gross_minor,sum(returned_net_minor) returned_goods_net_minor FROM item_facts GROUP BY order_id
  ), returned_shipping AS (
    SELECT r.order_id,sum(r.refunded_shipping)::numeric returned_delivery_gross_minor FROM return_cases r JOIN active_orders o ON (o.tenant_id,o.id)=(r.tenant_id,r.order_id)
    WHERE ${accepted} IS NOT NULL AND ${accepted}<=$5::timestamptz GROUP BY r.order_id
  ), expected AS (
    SELECT i.order_id,(x->>'product_id')::uuid product_id,sum(i.quantity::numeric*(x->>'quantity')::numeric) quantity
    FROM item_facts i CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_array_length(i.components)>0 THEN i.components ELSE jsonb_build_array(jsonb_build_object('product_id',i.product_id,'quantity',1)) END) x GROUP BY i.order_id,(x->>'product_id')::uuid
  ), issues AS (${issues}), restocks AS (${restocks}), physical_costs AS (
    SELECT coalesce(i.order_id,r.order_id) order_id,coalesce(i.product_id,r.product_id) product_id,coalesce(i.currency,r.currency) currency,
      coalesce(i.quantity,0) issued_quantity,coalesce(r.quantity,0) restocked_quantity,
      coalesce(i.unknown_quantity,0)-coalesce(r.unknown_quantity,0) unknown_quantity,
      coalesce(i.known_minor,0) issued_known_minor,coalesce(r.known_minor,0) restocked_known_minor
    FROM issues i FULL JOIN restocks r USING(order_id,product_id,currency)
  ), issued_quantities AS (SELECT order_id,product_id,sum(quantity) quantity FROM issues GROUP BY order_id,product_id), required AS (
    SELECT coalesce(e.order_id,i.order_id) order_id,coalesce(sum(e.quantity),0) physical_quantity,sum(greatest(coalesce(e.quantity,0)-coalesce(i.quantity,0),0)) missing_issue_quantity,
      bool_or(coalesce(i.quantity,0)>coalesce(e.quantity,0)) quantity_mismatch FROM expected e FULL JOIN issued_quantities i USING(order_id,product_id) GROUP BY coalesce(e.order_id,i.order_id)
  ), cost_orders AS (
    SELECT p.order_id,sum(p.unknown_quantity) unknown_cost_quantity,
      coalesce(sum(p.issued_known_minor) FILTER(WHERE p.currency=o.currency),0) issued_known_cost_minor,
      coalesce(sum(p.restocked_known_minor) FILTER(WHERE p.currency=o.currency),0) restocked_known_cost_minor,
      bool_or(p.currency<>o.currency) currency_mismatch FROM physical_costs p JOIN active_orders o ON o.id=p.order_id GROUP BY p.order_id
  ), warranty_costs AS (${warrantyCosts}), order_facts AS (
    SELECT o.*,g.commercial_quantity,g.goods_gross_minor,g.goods_net_minor,g.accepted_quantity,g.physically_accepted_quantity,g.restocked_quantity,
      g.returned_goods_gross_minor,g.returned_goods_net_minor,coalesce(rs.returned_delivery_gross_minor,0) returned_delivery_gross_minor,
      coalesce(e.physical_quantity,0) physical_quantity,coalesce(e.missing_issue_quantity,0) missing_issue_quantity,coalesce(e.quantity_mismatch,false) quantity_mismatch,
      coalesce(c.unknown_cost_quantity,0)+coalesce(w.unknown_quantity,0) unknown_cost_quantity,
      coalesce(c.issued_known_cost_minor,0)+coalesce(w.known_minor,0) issued_known_cost_minor,
      coalesce(w.known_minor,0) warranty_known_cost_minor,
      coalesce(c.restocked_known_cost_minor,0) restocked_known_cost_minor,
      coalesce(c.currency_mismatch,false) OR coalesce(w.currency_mismatch,false) currency_mismatch,
      EXISTS(SELECT 1 FROM item_facts i WHERE i.order_id=o.id AND jsonb_array_length(i.components)=0) physical_snapshot_unavailable,
      ${caps.costs ? 'false' : 'true'} cost_module_unavailable,
      (SELECT min(s.dispatched_at) FROM shipments s WHERE (s.tenant_id,s.order_id)=(o.tenant_id,o.id)) dispatched_at
    FROM active_orders o JOIN goods g ON g.order_id=o.id LEFT JOIN required e ON e.order_id=o.id
    LEFT JOIN cost_orders c ON c.order_id=o.id LEFT JOIN returned_shipping rs ON rs.order_id=o.id
    LEFT JOIN warranty_costs w ON w.order_id=o.id
  )`;
}
function dec(v: unknown) {
  const value = String(v ?? '0');
  ensure(/^-?\d+$/.test(value), 500, 'Niepoprawna dokładna liczba raportu');
  return BigInt(value).toString();
}
const iso = (v: Date | string | null) => (v == null ? null : new Date(v).toISOString());
function orderView(r: Row): Row {
  const reasons = [
    ...(BigInt(dec(r.missing_issue_quantity)) > 0n ? ['missing_issue_cost'] : []),
    ...(BigInt(dec(r.unknown_cost_quantity)) !== 0n ? ['unknown_layer_cost'] : []),
    ...(r.currency_mismatch ? ['cost_currency_mismatch'] : []),
    ...(r.quantity_mismatch ? ['physical_quantity_mismatch'] : []),
    ...(r.physical_snapshot_unavailable ? ['physical_snapshot_unavailable'] : []),
    ...(r.cost_module_unavailable ? ['wms_cost_module_unavailable'] : []),
  ];
  const currentNet = BigInt(dec(r.goods_net_minor)) - BigInt(dec(r.returned_goods_net_minor));
  const netCost =
    BigInt(dec(r.issued_known_cost_minor)) - BigInt(dec(r.restocked_known_cost_minor));
  const result: Row = {
    id: r.id,
    number: r.number,
    created_at: iso(r.created_at),
    dispatched_at: iso(r.dispatched_at),
    warehouse_id: r.warehouse_id,
    currency: r.currency,
    status: r.status,
    source: r.source,
    tax_basis: 'order_item_snapshot',
    cost_complete: reasons.length === 0,
    cost_reasons: reasons,
    delivery_gross_minor: dec(r.shipping_cost),
    total_gross_minor: dec(r.total),
    current_goods_net_minor: currentNet.toString(),
    net_known_cost_minor: netCost.toString(),
    margin_minor: reasons.length ? null : (currentNet - netCost).toString(),
  };
  for (const k of [
    'commercial_quantity',
    'physical_quantity',
    'accepted_quantity',
    'physically_accepted_quantity',
    'restocked_quantity',
    'goods_gross_minor',
    'goods_net_minor',
    'returned_goods_gross_minor',
    'returned_goods_net_minor',
    'returned_delivery_gross_minor',
    'issued_known_cost_minor',
    'warranty_known_cost_minor',
    'restocked_known_cost_minor',
    'unknown_cost_quantity',
    'missing_issue_quantity',
  ])
    result[k] = dec(r[k]);
  return result;
}
const privateKeys = new Set([
  'cost_complete',
  'cost_reasons',
  'unknown_cost_quantity',
  'missing_issue_quantity',
  'unknown_quantity',
  'complete_order_count',
  'incomplete_order_count',
  'issued_unknown_quantity',
  'restocked_unknown_quantity',
  'net_unknown_quantity',
]);
function project(value: any, allowed: boolean): any {
  if (allowed || value == null) return value;
  if (Array.isArray(value)) return value.map((v) => project(v, allowed));
  if (typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([k]) => !k.endsWith('_minor') && !privateKeys.has(k))
      .map(([k, v]) => [k, project(v, allowed)]),
  );
}
function base(f: unknown, asOf: string, acl: Access) {
  return { filters: f, as_of: asOf, ...acl };
}
function bind(a: Actor, q: Query, kind: string, acl: Access) {
  return JSON.stringify({
    tenant: a.tenantId,
    user: a.userId,
    from: q.from,
    to: q.to,
    warehouse: q.warehouse_id ?? null,
    currency: q.currency ?? null,
    kind,
    ...acl,
  });
}
type After = { at: string; id: string };
function cursor(after: After, binding: string) {
  const value = Buffer.from(JSON.stringify({ after, binding })).toString('base64url');
  return (
    value + '.' + createHmac('sha256', localConfig.encryptionKey).update(value).digest('base64url')
  );
}
function position(value: string | undefined, binding: string): After | null {
  if (!value) return null;
  const [v, s, ...rest] = value.split('.');
  ensure(v && s && rest.length === 0, 422, 'Niepoprawny cursor');
  const expected = createHmac('sha256', localConfig.encryptionKey).update(v).digest(),
    signature = Buffer.from(s, 'base64url');
  ensure(
    signature.length === expected.length && timingSafeEqual(signature, expected),
    422,
    'Niepoprawny cursor',
  );
  let data: any;
  try {
    data = JSON.parse(Buffer.from(v, 'base64url').toString());
  } catch {
    ensure(false, 422, 'Niepoprawny cursor');
  }
  ensure(data.binding === binding, 409, 'Cursor dotyczy innego zakresu lub uprawnień');
  ensure(
    typeof data.after?.at === 'string' &&
      data.after.at.length <= 80 &&
      Number.isFinite(Date.parse(data.after.at)) &&
      z.uuid().safeParse(data.after.id).success,
    422,
    'Niepoprawny cursor',
  );
  return data.after;
}
function headScope(caps: Caps, kind: string) {
  if (kind === 'orders')
    return {
      from: 'orders o',
      clock: 'o.created_at',
      id: 'o.id',
      where: `o.created_at<=$5::timestamptz AND ($3::uuid IS NULL OR o.warehouse_id=$3) AND ($4::text IS NULL OR o.currency=$4)`,
      order: 'o.id',
    };
  const accepted = returnAcceptedExpression(caps.partnerReturns);
  return {
    from: 'return_cases r JOIN orders o ON (o.tenant_id,o.id)=(r.tenant_id,r.order_id)',
    clock: accepted,
    id: 'r.id',
    where: `${accepted} IS NOT NULL AND ${accepted}<=$5::timestamptz AND ($3::uuid IS NULL OR r.warehouse_id=$3) AND ($4::text IS NULL OR o.currency=$4)`,
    order: 'r.order_id',
  };
}
async function rowCount(c: PoolClient, caps: Caps, q: Query, asOf: string, kind: string) {
  const h = headScope(caps, kind);
  return Number(
    (
      await c.query(
        `SELECT count(*)::int total FROM ${h.from} WHERE o.status<>'cancelled' AND ${economic(caps)} AND ${h.where} AND ${within(h.clock)}`,
        params(q, asOf),
      )
    ).rows[0].total,
  );
}
async function rows(
  c: PoolClient,
  caps: Caps,
  q: Query,
  asOf: string,
  kind: string,
  after: After | null,
  limit: number,
) {
  const h = headScope(caps, kind);
  const heads = (
    await c.query(
      `SELECT ${h.id} id,${h.order} order_id,${h.clock}::text cursor_at FROM ${h.from}
    WHERE o.status<>'cancelled' AND ${economic(caps)} AND ${h.where} AND ${within(h.clock)}
    AND ($6::timestamptz IS NULL OR (${h.clock},${h.id})<($6::timestamptz,$7::uuid)) ORDER BY ${h.clock} DESC,${h.id} DESC LIMIT $8`,
      [...params(q, asOf), after?.at ?? null, after?.id ?? null, limit + 1],
    )
  ).rows;
  const more = heads.length > limit,
    chosen = heads.slice(0, limit);
  if (!chosen.length) return { data: [] as Row[], more: false, last: null };
  const p = [...params(q, asOf), [...new Set(chosen.map((r) => r.order_id))]];
  let data: Row[];
  if (kind === 'orders')
    data = (
      await c.query(
        facts(caps, false, true) + ` SELECT * FROM order_facts ORDER BY created_at DESC,id DESC`,
        p,
      )
    ).rows.map(orderView);
  else
    data = (
      await c.query(
        facts(caps, true, true) +
          ` SELECT r.id,r.number,r.order_id,o.number order_number,r.received_at,${caps.exchanges ? 'r.remedy' : "'refund'::text"} remedy,${returnAcceptedExpression(caps.partnerReturns)} accepted_at,
    CASE WHEN r.received_at IS NOT NULL THEN 'physical' ELSE 'partner' END acceptance_kind,r.warehouse_id,o.currency,
    coalesce(sum(v.physically_accepted),0)::text accepted_quantity,coalesce(sum(v.restocked),0)::text restocked_quantity,
    coalesce(sum(v.refund_amount),0)::text goods_gross_minor,coalesce(sum(v.net_minor),0)::text goods_net_minor,
    r.refunded_shipping::text delivery_gross_minor,r.refund_amount::text total_gross_minor
    FROM return_cases r JOIN active_orders o ON (o.tenant_id,o.id)=(r.tenant_id,r.order_id)
    LEFT JOIN returned_values v ON v.return_id=r.id WHERE r.id=ANY($7::uuid[])
    GROUP BY r.id,o.number,o.currency ORDER BY accepted_at DESC,r.id DESC`,
        [...p, chosen.map((r) => r.id)],
      )
    ).rows.map((r) => ({ ...r, received_at: iso(r.received_at), accepted_at: iso(r.accepted_at) }));
  const last = chosen[chosen.length - 1];
  return { data, more, last: { at: last.cursor_at, id: last.id } as After };
}
async function page(a: Actor, input: unknown, kind: string) {
  const q = salesReportPageQuery.parse(input),
    early = await access(a),
    binding = bind(a, q, kind, early),
    start = position(q.cursor, binding);
  const result = await snapshot(a, async (c, caps, asOf) => {
    const f = await filters(c, q),
      total = await rowCount(c, caps, q, asOf, kind);
    ensure(
      total <= SALES_REPORT_LIMITS.export_rows,
      413,
      'Raport przekracza 100000 rekordów. Zawęź daty.',
    );
    const chunk = await rows(c, caps, q, asOf, kind, start, q.limit);
    return {
      data: chunk.data,
      meta: { total, cursor: chunk.more && chunk.last ? cursor(chunk.last, binding) : null },
      filters: f,
      as_of: asOf,
    };
  });
  const final = await access(a);
  ensure(
    JSON.stringify(early) === JSON.stringify(final),
    409,
    'Uprawnienia zmieniły się podczas odczytu. Odczytaj raport ponownie.',
  );
  return { ...project(result, final.can_read_value), ...final };
}
export const salesReportOrders = (a: Actor, q: unknown) => page(a, q, 'orders');
export const salesReportReturns = (a: Actor, q: unknown) => page(a, q, 'returns');
export async function salesReportOptions(a: Actor) {
  await access(a);
  const result = await snapshot(a, async (c) => {
    const wh = (await c.query('SELECT id,name,code FROM warehouses ORDER BY name,id LIMIT 201'))
      .rows;
    return {
      available: true,
      time_zone: timeZone,
      currencies,
      warehouses: { data: wh.slice(0, 200), capped: wh.length > 200 },
      limits: SALES_REPORT_LIMITS,
    };
  });
  return { ...result, ...(await access(a)) };
}
export async function salesReportOrderDetail(a: Actor, id: string, input: unknown) {
  const q = salesReportQuery.parse(input);
  id = z.uuid().parse(id).toLowerCase();
  await access(a);
  const result = await snapshot(a, async (c, caps, asOf) => {
    const f = await filters(c, q),
      p = [...params(q, asOf), [id]];
    const r = (
      await c.query(
        facts(caps, false, true) +
          ` SELECT * FROM order_facts o WHERE o.id=ANY($6::uuid[]) AND ${within('o.created_at')}`,
        p,
      )
    ).rows[0];
    ensure(r, 404, 'Nie znaleziono bieżącego zamówienia w zakresie raportu');
    const lines = (
      await c.query(
        facts(caps, false, true) +
          ` SELECT id,product_id,sku,name,quantity::text,vat,line_total::text line_total_minor,net_minor::text,
      accepted_quantity::text,physically_accepted_quantity::text,restocked_quantity::text,returned_gross_minor::text,returned_net_minor::text FROM item_facts WHERE order_id=ANY($6::uuid[]) ORDER BY id LIMIT 10001`,
        p,
      )
    ).rows;
    const costs = (
      await c.query(
        facts(caps, false, true) +
          ` SELECT p.product_id,p.currency,p.issued_quantity::text,p.restocked_quantity::text,p.unknown_quantity::text,
      p.issued_known_minor::text,p.restocked_known_minor::text,k.sku,k.name FROM physical_costs p
      LEFT JOIN order_pick_items k ON (k.order_id,k.product_id)=(p.order_id,p.product_id)
      WHERE p.order_id=ANY($6::uuid[]) ORDER BY p.product_id,p.currency LIMIT 10001`,
        p,
      )
    ).rows;
    ensure(
      lines.length <= 10000 && costs.length <= 10000,
      413,
      'Szczegóły przekraczają 10000 pozycji',
    );
    return {
      ...base(f, asOf, { current_role: '', can_read_value: false }),
      order: orderView(r),
      commercial_lines: lines.map((l) => ({ ...l, margin_minor: null })),
      physical_costs: costs,
    };
  });
  const final = await access(a);
  return { ...project(result, final.can_read_value), ...final };
}
export async function salesReportSummary(a: Actor, input: unknown) {
  const q = salesReportQuery.parse(input);
  await access(a);
  const result = await snapshot(a, async (c, caps, asOf) => {
    const f = await filters(c, q),
      p = params(q, asOf);
    const total = await rowCount(c, caps, q, asOf, 'orders');
    ensure(total <= 100000, 413, 'Raport przekracza 100000 zamówień. Zawęź daty.');
    const sales = (
      await c.query(
        facts(caps) +
          ` SELECT currency,count(*)::int orders,sum(commercial_quantity)::text commercial_quantity,
      sum(goods_gross_minor)::text goods_gross_minor,sum(goods_net_minor)::text goods_net_minor,
      sum(shipping_cost)::text delivery_gross_minor,sum(total)::text total_gross_minor
      FROM order_facts o WHERE ${within('o.created_at')} GROUP BY currency ORDER BY currency`,
        p,
      )
    ).rows;
    const current = (
      await c.query(
        facts(caps) +
          ` SELECT currency,count(*)::int orders,
      sum(goods_net_minor-returned_goods_net_minor)::text current_goods_net_minor,
      sum(issued_known_cost_minor-restocked_known_cost_minor)::text net_known_cost_minor,
      sum(unknown_cost_quantity)::text unknown_cost_quantity,sum(missing_issue_quantity)::text missing_issue_quantity,
      count(*) FILTER(WHERE missing_issue_quantity=0 AND unknown_cost_quantity=0 AND NOT currency_mismatch AND NOT quantity_mismatch AND NOT physical_snapshot_unavailable AND NOT cost_module_unavailable)::int complete_order_count,
      count(*) FILTER(WHERE missing_issue_quantity<>0 OR unknown_cost_quantity<>0 OR currency_mismatch OR quantity_mismatch OR physical_snapshot_unavailable OR cost_module_unavailable)::int incomplete_order_count,
      CASE WHEN bool_and(missing_issue_quantity=0 AND unknown_cost_quantity=0 AND NOT currency_mismatch AND NOT quantity_mismatch AND NOT physical_snapshot_unavailable AND NOT cost_module_unavailable)
      THEN sum(goods_net_minor-returned_goods_net_minor-issued_known_cost_minor+restocked_known_cost_minor)::text ELSE NULL END margin_minor
      FROM order_facts o WHERE ${within('o.created_at')} GROUP BY currency ORDER BY currency`,
        p,
      )
    ).rows;
    const returned = (
      await c.query(
        facts(caps, true) +
          ` SELECT o.currency,count(DISTINCT r.id)::int cases,
      coalesce(sum(x.accepted_quantity),0)::text accepted_quantity,coalesce(sum(x.restocked_quantity),0)::text restocked_quantity,
      coalesce(sum(x.goods_gross_minor),0)::text goods_gross_minor,coalesce(sum(x.goods_net_minor),0)::text goods_net_minor,
      sum(r.refunded_shipping)::text delivery_gross_minor,sum(r.refund_amount)::text total_gross_minor
      FROM return_cases r JOIN active_orders o ON (o.tenant_id,o.id)=(r.tenant_id,r.order_id)
      LEFT JOIN (SELECT return_id,sum(physically_accepted) accepted_quantity,sum(restocked) restocked_quantity,sum(refund_amount) goods_gross_minor,sum(net_minor) goods_net_minor FROM returned_values GROUP BY return_id) x ON x.return_id=r.id
      WHERE ${returnAcceptedExpression(caps.partnerReturns)} IS NOT NULL AND ${returnAcceptedExpression(caps.partnerReturns)}<=$5::timestamptz AND ${within(returnAcceptedExpression(caps.partnerReturns))} AND ($3::uuid IS NULL OR r.warehouse_id=$3) AND ($4::text IS NULL OR o.currency=$4) GROUP BY o.currency ORDER BY o.currency`,
        p,
      )
    ).rows;
    const costSql = caps.costs
      ? `SELECT currency,sum(issued_quantity)::text issued_quantity,sum(restocked_quantity)::text restocked_quantity,
      sum(issued_unknown_quantity)::text issued_unknown_quantity,sum(restocked_unknown_quantity)::text restocked_unknown_quantity,(sum(issued_unknown_quantity)-sum(restocked_unknown_quantity))::text net_unknown_quantity,sum(issued_known_minor)::text issued_known_minor,sum(restocked_known_minor)::text restocked_known_minor FROM (
      SELECT i.currency,i.quantity::numeric issued_quantity,0::numeric restocked_quantity,CASE WHEN i.unit_cost_minor IS NULL THEN i.quantity ELSE 0 END::numeric issued_unknown_quantity,0::numeric restocked_unknown_quantity,coalesce(i.value_minor,0)::numeric issued_known_minor,0::numeric restocked_known_minor
      FROM wms_issue_fragments i JOIN active_orders o ON (o.tenant_id,o.id)=(i.tenant_id,i.order_id) WHERE i.created_at<=$5::timestamptz AND ${within('i.created_at')} AND ($3::uuid IS NULL OR i.warehouse_id=$3) AND ($4::text IS NULL OR i.currency=$4)
      UNION ALL SELECT i.currency,0,f.quantity,0,(CASE WHEN i.unit_cost_minor IS NULL THEN f.quantity ELSE 0 END)::numeric,0,coalesce(f.value_minor,0)
      FROM wms_return_fragments f JOIN wms_issue_fragments i ON (i.tenant_id,i.id)=(f.tenant_id,f.issue_fragment_id) JOIN active_orders o ON (o.tenant_id,o.id)=(f.tenant_id,f.order_id)
      WHERE f.created_at<=$5::timestamptz AND ${within('f.created_at')} AND ($3::uuid IS NULL OR f.warehouse_id=$3) AND ($4::text IS NULL OR i.currency=$4)
      ${
        caps.exchanges
          ? `UNION ALL SELECT i.currency,i.quantity,0,(CASE WHEN i.unit_cost_minor IS NULL THEN i.quantity ELSE 0 END)::numeric,0,coalesce(i.value_minor,0),0
      FROM wms_issue_fragments i JOIN return_exchanges x ON (x.tenant_id,x.replacement_order_id)=(i.tenant_id,i.order_id)
      JOIN active_orders o ON (o.tenant_id,o.id)=(x.tenant_id,x.original_order_id)
      WHERE i.created_at<=$5::timestamptz AND x.created_at<=$5::timestamptz AND ${within('i.created_at')} AND ($3::uuid IS NULL OR i.warehouse_id=$3) AND ($4::text IS NULL OR i.currency=$4)`
          : ''
      }) t GROUP BY currency ORDER BY currency`
      : `SELECT NULL::text currency WHERE false`;
    const costs = (await c.query(facts(caps, true) + ' ' + costSql, p)).rows;
    return {
      ...base(f, asOf, { current_role: '', can_read_value: false }),
      sales,
      returns: returned,
      costs,
      cohort_current: current,
      warnings: [
        'booking_and_return_and_cost_periods_are_separate',
        'cohort_margin_is_current_as_of',
        'snapshot_vat_is_not_provider_tax_proof',
        'delivery_vat_and_delivery_cost_not_in_margin',
        ...(caps.exchanges
          ? [
              'replacement_issue_cost_attributed_to_original_sale',
              'exchange_acceptance_does_not_reduce_sales_units',
            ]
          : []),
        ...(!caps.costs ? ['wms_cost_module_unavailable'] : []),
      ],
    };
  });
  const final = await access(a);
  return { ...project(result, final.can_read_value), ...final };
}
const orderColumns = [
  'id',
  'number',
  'created_at',
  'dispatched_at',
  'warehouse_id',
  'currency',
  'status',
  'source',
  'commercial_quantity',
  'physical_quantity',
  'accepted_quantity',
  'physically_accepted_quantity',
  'restocked_quantity',
  'tax_basis',
  'goods_gross_minor',
  'goods_net_minor',
  'delivery_gross_minor',
  'total_gross_minor',
  'returned_goods_gross_minor',
  'returned_goods_net_minor',
  'returned_delivery_gross_minor',
  'current_goods_net_minor',
  'issued_known_cost_minor',
  'warranty_known_cost_minor',
  'restocked_known_cost_minor',
  'net_known_cost_minor',
  'unknown_cost_quantity',
  'missing_issue_quantity',
  'cost_complete',
  'cost_reasons',
  'margin_minor',
];
const returnColumns = [
  'id',
  'number',
  'order_id',
  'order_number',
  'received_at',
  'accepted_at',
  'acceptance_kind',
  'remedy',
  'warehouse_id',
  'currency',
  'accepted_quantity',
  'restocked_quantity',
  'goods_gross_minor',
  'goods_net_minor',
  'delivery_gross_minor',
  'total_gross_minor',
];
const csvValue = (v: any, safe: boolean) => {
  let text = v == null ? '' : Array.isArray(v) ? v.join('|') : String(v);
  if (safe && (/^[\s]*[=+\-@]/u.test(text) || /^0\d+$/u.test(text))) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
};
const activeFiles = new Set<string>();
export async function openSalesReportFile(a: Actor, input: unknown, signal?: AbortSignal) {
  const q = salesReportFileQuery.parse(input),
    early = await access(a);
  ensure(
    !activeFiles.has(a.tenantId) && activeFiles.size < 3,
    429,
    'Trwa przygotowanie eksportu. Spróbuj po jego zakończeniu.',
  );
  activeFiles.add(a.tenantId);
  let artifact: Awaited<ReturnType<typeof spoolCatalogExport>> | undefined;
  try {
    const prepared = await snapshot(a, async (c, caps, asOf) => {
      ensure(!signal?.aborted, 499, 'Eksport przerwany');
      const f = await filters(c, q),
        count = await rowCount(c, caps, q, asOf, q.kind);
      ensure(count <= 100000, 413, 'Eksport przekracza 100000 rekordów');
      const columns = (q.kind === 'orders' ? orderColumns : returnColumns).filter(
        (k) => early.can_read_value || (!k.endsWith('_minor') && !privateKeys.has(k)),
      );
      async function* chunks() {
        yield '\ufeff' + columns.map((k) => csvValue(k, false)).join(',') + '\r\n';
        let next: After | null = null,
          actual = 0;
        while (true) {
          ensure(!signal?.aborted, 499, 'Eksport przerwany');
          const chunk = await rows(c, caps, q, asOf, q.kind, next, 100);
          for (const row of chunk.data) {
            actual++;
            yield columns.map((k) => csvValue(row[k], q.spreadsheet_safe)).join(',') + '\r\n';
          }
          if (!chunk.more) break;
          next = chunk.last;
        }
        ensure(actual === count, 500, 'Niepełny zakres eksportu');
      }
      artifact = await spoolCatalogExport(chunks(), signal);
      return { filters: f, as_of: asOf, count };
    });
    const final = await access(a);
    ensure(
      JSON.stringify(final) === JSON.stringify(early),
      403,
      'Uprawnienia zmieniły się podczas przygotowania pliku',
    );
    ensure(!signal?.aborted, 499, 'Eksport przerwany');
    const file = artifact!;
    const fd = await open(file.path, constants.O_RDONLY | constants.O_NOFOLLOW),
      stream = fd.createReadStream({ autoClose: true });
    let disposal: Promise<void> | undefined;
    const abort = () => {
      stream.destroy();
      void dispose().catch(() => {});
    };
    const dispose = () => {
      if (disposal) return disposal;
      signal?.removeEventListener('abort', abort);
      disposal = (async () => {
        stream.destroy();
        try {
          await file.dispose();
        } finally {
          activeFiles.delete(a.tenantId);
        }
      })();
      return disposal;
    };
    signal?.addEventListener('abort', abort, { once: true });
    stream.once('close', () => {
      void dispose().catch(() => {});
    });
    if (signal?.aborted) {
      await dispose();
      ensure(false, 499, 'Eksport przerwany');
    }
    return { ...prepared, ...final, stream, path: file.path, bytes: file.bytes, dispose, abort };
  } catch (e) {
    await artifact?.dispose();
    activeFiles.delete(a.tenantId);
    throw e;
  }
}
/** Shared building blocks for the analytics reports (S7): the same IAM re-read,
 * the same RR snapshot under dyna_app/RLS and the same economic order facts, so
 * period series, SKU statistics and customer values reconcile with the summary. */
export {
  access as salesReportAccess,
  snapshot as salesReportSnapshot,
  facts as salesReportFacts,
  within as salesReportWithin,
  economic as salesReportEconomic,
  project as salesReportProject,
  filters as salesReportFilters,
  dec as salesReportDecimal,
  csvValue as salesReportCsvValue,
  calendarDate as salesReportCalendarDate,
  validDates as salesReportValidDates,
  currencies as salesReportCurrencies,
};
export type { Actor as SalesReportActor, Access as SalesReportAccess, Caps as SalesReportCaps };
