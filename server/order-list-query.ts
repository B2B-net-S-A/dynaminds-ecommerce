/**
 * Order list query (Uwagi v3 §3): query parameters of GET /api/orders and the parameterized SQL that
 * applies them. Text filters match fragments (ILIKE, `%`/`_` escaped), dates and amounts are inclusive
 * ranges, yes/no filters are absent when "Wszystkie". Keyset pagination by (created_at, id) is kept.
 *
 * Derived values are not stored (sealed orders table): the status filter uses the fulfilment stage of
 * server/order-stage.ts, the payment filter the same ledger sums as the list payment summary, the last
 * status change and delivery date come from order_events, the Allegro login and the buyer comment from
 * the imported raw payload (inbound_orders.raw).
 */
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { stages } from './operation-schema';
import { READY_TO_SHIP, orderFulfilmentStageSql, paymentState, type PaymentState } from './order-stage';
import { customerCommentSql, deliveryMethodSql } from './channel-projection';
import { deliveryMethodOptions, isDeliveryFilterCode, type Option } from '../shared/channel-projection';

export const FULFILMENT_STAGES = [...stages, READY_TO_SHIP] as const;
export const PAYMENT_STATES = ['unpaid', 'paid', 'partial', 'overpaid', 'cod'] as const satisfies readonly PaymentState[];
export const SALE_DOCUMENTS = ['invoice', 'receipt', 'none'] as const;

const blankToUndefined = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);
const text = (max: number) =>
  z.preprocess(blankToUndefined, z.string().trim().max(max, `Najwyżej ${max} znaków`).optional());
const day = z.preprocess(blankToUndefined, z.iso.date('Data w formacie RRRR-MM-DD').optional());
const amount = z.preprocess(
  blankToUndefined,
  z.coerce.number().int('Kwota w groszach').min(0).max(1_000_000_000).optional(),
);
const yesNo = z.preprocess(blankToUndefined, z.enum(['yes', 'no']).optional());
/** Comma list of known codes; an empty list means "no filter". */
const codes = <T extends string>(values: readonly T[], label: string) =>
  z.preprocess(
    blankToUndefined,
    z
      .string()
      .max(400)
      .transform((v, ctx) => {
        const list = [...new Set(v.split(',').map((x) => x.trim()).filter(Boolean))];
        for (const x of list)
          if (!values.includes(x as T)) {
            ctx.addIssue({ code: 'custom', message: `Nieznana wartość filtra ${label}: ${x.slice(0, 40)}` });
            return z.NEVER;
          }
        return list as T[];
      })
      .optional(),
  );
const sources = z.preprocess(
  blankToUndefined,
  z
    .string()
    .max(400)
    .transform((v, ctx) => {
      const list = [...new Set(v.split(',').map((x) => x.trim()).filter(Boolean))];
      if (list.length > 20 || list.some((x) => !/^[a-z0-9_]{1,40}$/.test(x))) {
        ctx.addIssue({ code: 'custom', message: 'Nieprawidłowy kanał sprzedaży' });
        return z.NEVER;
      }
      return list;
    })
    .optional(),
);

/** Delivery groups, their cash on delivery variants and channel methods (shared/channel-projection.ts). */
const deliveryCodes = z.preprocess(
  blankToUndefined,
  z
    .string()
    .max(2000)
    .transform((v, ctx) => {
      const list = [...new Set(v.split(',').map((x) => x.trim()).filter(Boolean))];
      const bad = list.find((x) => !isDeliveryFilterCode(x));
      if (bad !== undefined || list.length > 40) {
        ctx.addIssue({ code: 'custom', message: `Nieznana wartość filtra Sposób wysyłki: ${(bad ?? '').slice(0, 40)}` });
        return z.NEVER;
      }
      return list;
    })
    .optional(),
);

const ranges = [
  ['created_from', 'created_to', 'Dodane'],
  ['status_changed_from', 'status_changed_to', 'Ost. zmiana statusu'],
  ['delivered_from', 'delivered_to', 'Data dostarczenia'],
  ['shipping_from', 'shipping_to', 'Koszt wysyłki'],
  ['total_from', 'total_to', 'Kwota'],
] as const;

export const orderListQuerySchema = z
  .object({
    // Existing parameters.
    status: codes(FULFILMENT_STAGES, 'Status'),
    workflow_status_id: z.uuid().optional(),
    tag: z.string().max(40).optional(),
    search: z.string().max(200).default(''),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    after: z.string().max(300).optional(),
    field_filters: z.string().max(10000).optional(),
    field_columns: z.string().max(1000).optional(),
    // Row 1: order and customer.
    number: text(60),
    external_id: text(100),
    channel: sources,
    customer: text(100),
    phone: text(30),
    email: text(120),
    // Row 2: address and dates.
    allegro_login: text(60),
    city: text(100),
    postal_code: text(20),
    country: text(40),
    created_from: day,
    created_to: day,
    status_changed_from: day,
    status_changed_to: day,
    delivered_from: day,
    delivered_to: day,
    // Row 3: product and shipping.
    ean: text(20),
    sku: text(60),
    delivery: deliveryCodes,
    shipping_from: amount,
    shipping_to: amount,
    payment: codes(PAYMENT_STATES, 'Status płatności'),
    // Row 4: payment and documents.
    total_from: amount,
    total_to: amount,
    currency: z.preprocess(blankToUndefined, z.string().regex(/^[A-Z]{3}$/, 'Waluta to kod ISO, np. PLN').optional()),
    has_note: yesNo,
    has_comment: yesNo,
    sale_document: z.preprocess(blankToUndefined, z.enum(SALE_DOCUMENTS).optional()),
    has_return: yesNo,
  })
  .superRefine((q, ctx) => {
    for (const [from, to, label] of ranges) {
      const a = q[from],
        b = q[to];
      if (a !== undefined && b !== undefined && a > b)
        ctx.addIssue({ code: 'custom', path: [from], message: `${label}: wartość „od” jest większa niż „do”` });
    }
  });
export type OrderListQuery = z.infer<typeof orderListQuerySchema>;

/** Tables of prepared migrations that may be missing in a copy. */
export interface OrderListAvailability {
  salesDimensions: boolean;
  receipts: boolean;
}

/** Escapes LIKE wildcards so a fragment matches literally. */
export const likeFragment = (value: string) => '%' + value.replace(/[\\%_]/g, '\\$&') + '%';

const LIKE = "ESCAPE '\\'";
const WARSAW = "'Europe/Warsaw'";
const STATUS_EVENT_KINDS = [...stages].map((s) => 'order.' + s);

/** SQL: time of the latest status change (status events; the creation time when there is none). */
export const lastStatusChangeSql = (o: string, kindsParam: string) =>
  `coalesce((SELECT max(sc.created_at) FROM order_events sc WHERE sc.tenant_id=${o}.tenant_id AND sc.order_id=${o}.id AND sc.kind=ANY(${kindsParam}::text[])),${o}.created_at)`;
/** SQL: time of the latest 'order.delivered' event, NULL when the order was never delivered. */
export const deliveredAtSql = (o: string) =>
  `(SELECT max(dv.created_at) FROM order_events dv WHERE dv.tenant_id=${o}.tenant_id AND dv.order_id=${o}.id AND dv.kind='order.delivered')`;
const rawExists = (o: string, cond: string) =>
  `EXISTS(SELECT 1 FROM inbound_orders ib WHERE ib.tenant_id=${o}.tenant_id AND ib.order_id=${o}.id AND ${cond})`;
const invoiceSql = (o: string) =>
  `EXISTS(SELECT 1 FROM documents sd WHERE sd.tenant_id=${o}.tenant_id AND sd.order_id=${o}.id AND sd.kind='invoice')`;
const receiptSql = (o: string, available: boolean) =>
  available
    ? `EXISTS(SELECT 1 FROM receipt233_receipts sr WHERE sr.tenant_id=${o}.tenant_id AND sr.order_id=${o}.id AND sr.state<>'failed')`
    : 'FALSE';
const returnSql = (o: string) =>
  `(${o}.status LIKE 'return\\_%' OR EXISTS(SELECT 1 FROM return_cases rc WHERE rc.tenant_id=${o}.tenant_id AND rc.order_id=${o}.id AND rc.state<>'cancelled'))`;

/**
 * SQL text of the payment state over the lateral `pn` (net, nominal): the same rules as paymentState()
 * in server/order-stage.ts.
 */
export const paymentStateSql = (o: string) =>
  `(CASE WHEN pn.net>pn.nominal THEN 'overpaid' WHEN pn.net>=pn.nominal THEN 'paid' WHEN ${o}.payment_mode='cod' THEN 'cod' WHEN pn.net>0 THEN 'partial' ELSE 'unpaid' END)`;

export class OrderListParams {
  readonly values: unknown[] = [];
  bind(value: unknown) {
    this.values.push(value);
    return '$' + this.values.length;
  }
}

/**
 * WHERE conditions of the filters (without pagination), joined with AND; 'TRUE' when none is set.
 * Uses alias `o` and the lateral `pn` for the payment state.
 */
export function orderListConditions(
  q: OrderListQuery,
  p: OrderListParams,
  available: OrderListAvailability,
): string {
  const and: string[] = [];
  const like = (column: string, value: string | undefined) => {
    if (value !== undefined) and.push(`${column} ILIKE ${p.bind(likeFragment(value))} ${LIKE}`);
  };
  const range = (column: string, from: unknown, to: unknown, cast: string) => {
    if (from !== undefined) and.push(`${column}>=${p.bind(from)}::${cast}`);
    if (to !== undefined) and.push(`${column}<=${p.bind(to)}::${cast}`);
  };
  /** Inclusive calendar days in Polish time. */
  const days = (column: string, from: string | undefined, to: string | undefined) => {
    if (from !== undefined) and.push(`${column}>=(${p.bind(from)}::date::timestamp AT TIME ZONE ${WARSAW})`);
    if (to !== undefined) and.push(`${column}<((${p.bind(to)}::date+1)::timestamp AT TIME ZONE ${WARSAW})`);
  };

  if (q.status?.length) and.push(`${orderFulfilmentStageSql('o')}=ANY(${p.bind(q.status)}::text[])`);
  if (q.workflow_status_id) and.push(`o.workflow_status_id=${p.bind(q.workflow_status_id)}::uuid`);
  if (q.tag) and.push(`${p.bind(q.tag)}::text=ANY(o.tags)`);
  if (q.search) {
    const s = p.bind(likeFragment(q.search));
    and.push(`(o.number ILIKE ${s} ${LIKE} OR o.customer_name ILIKE ${s} ${LIKE} OR o.email ILIKE ${s} ${LIKE})`);
  }

  like('o.number', q.number);
  like('o.external_id', q.external_id);
  if (q.channel?.length) and.push(`o.source=ANY(${p.bind(q.channel)}::text[])`);
  if (q.customer !== undefined) {
    const s = p.bind(likeFragment(q.customer));
    and.push(
      `(o.customer_name ILIKE ${s} ${LIKE} OR o.address->>'company' ILIKE ${s} ${LIKE} OR o.address->>'nip' ILIKE ${s} ${LIKE} OR o.address->>'tax_id' ILIKE ${s} ${LIKE})`,
    );
  }
  if (q.phone !== undefined) {
    const digits = q.phone.replace(/\D/g, '');
    const s = p.bind(likeFragment(q.phone));
    and.push(
      digits
        ? `(o.address->>'phone' ILIKE ${s} ${LIKE} OR regexp_replace(coalesce(o.address->>'phone',''),'\\D','','g') LIKE ${p.bind('%' + digits + '%')})`
        : `o.address->>'phone' ILIKE ${s} ${LIKE}`,
    );
  }
  like('o.email', q.email);

  if (q.allegro_login !== undefined)
    and.push(rawExists('o', `ib.raw->'buyer'->>'login' ILIKE ${p.bind(likeFragment(q.allegro_login))} ${LIKE}`));
  like("o.address->>'city'", q.city);
  like("o.address->>'postal_code'", q.postal_code);
  like("o.address->>'country'", q.country);
  days('o.created_at', q.created_from, q.created_to);
  if (q.status_changed_from !== undefined || q.status_changed_to !== undefined)
    days(lastStatusChangeSql('o', p.bind(STATUS_EVENT_KINDS)), q.status_changed_from, q.status_changed_to);
  days(deliveredAtSql('o'), q.delivered_from, q.delivered_to);

  if (q.ean !== undefined)
    and.push(
      `EXISTS(SELECT 1 FROM order_items fi JOIN products fp ON fp.tenant_id=fi.tenant_id AND fp.id=fi.product_id WHERE fi.tenant_id=o.tenant_id AND fi.order_id=o.id AND fp.ean ILIKE ${p.bind(likeFragment(q.ean))} ${LIKE})`,
    );
  if (q.sku !== undefined) {
    const s = p.bind(likeFragment(q.sku));
    and.push(
      `EXISTS(SELECT 1 FROM order_items fi LEFT JOIN products fp ON fp.tenant_id=fi.tenant_id AND fp.id=fi.product_id WHERE fi.tenant_id=o.tenant_id AND fi.order_id=o.id AND (fi.sku ILIKE ${s} ${LIKE} OR fp.sku ILIKE ${s} ${LIKE}))`,
    );
  }
  if (q.delivery?.length) {
    if (!available.salesDimensions) throw new OrderListUnavailable('Sposób wysyłki nie jest dostępny w tej kopii (brak migracji 247)');
    and.push(deliveryMethodSql('o', p.bind(q.delivery)));
  }
  range('o.shipping_cost', q.shipping_from, q.shipping_to, 'integer');
  if (q.payment?.length) and.push(`${paymentStateSql('o')}=ANY(${p.bind(q.payment)}::text[])`);

  range('o.total', q.total_from, q.total_to, 'integer');
  if (q.currency) and.push(`o.currency=${p.bind(q.currency)}`);
  if (q.has_note) and.push(`${q.has_note === 'no' ? 'NOT ' : ''}(btrim(o.note)<>'')`);
  if (q.has_comment) and.push(`${q.has_comment === 'no' ? 'NOT ' : ''}${customerCommentSql('o')}`);
  if (q.sale_document === 'invoice') and.push(invoiceSql('o'));
  else if (q.sale_document === 'receipt') and.push(receiptSql('o', available.receipts));
  else if (q.sale_document === 'none')
    and.push(`NOT ${invoiceSql('o')} AND NOT ${receiptSql('o', available.receipts)}`);
  if (q.has_return) and.push(`${q.has_return === 'no' ? 'NOT ' : ''}${returnSql('o')}`);
  return and.length ? and.join(' AND ') : 'TRUE';
}

/** A filter that needs a table this copy does not have. */
export class OrderListUnavailable extends Error {}

export interface OrderListPaging {
  page: string;
  limit: string;
}
/** Keyset page and limit (one extra row tells whether there is a next page). */
export function orderListPaging(
  p: OrderListParams,
  cursor: { date: string; id: string } | null,
  limit: number,
): OrderListPaging {
  const page = cursor
    ? ` AND (o.created_at,o.id)<(${p.bind(cursor.date)}::timestamptz,${p.bind(cursor.id)}::uuid)`
    : '';
  return { page, limit: p.bind(limit + 1) };
}

/**
 * The full list query. Bind the conditions and the paging first; `extraSql` (custom field filters)
 * uses parameters numbered after `p.values`, and its parameters are appended after them.
 */
export function orderListSql(input: {
  conditions: string;
  paging: OrderListPaging;
  paymentSummarySql: string;
  operationalPredicate: string;
  extraSql?: string;
}): string {
  const { page, limit } = input.paging;
  return (
    "SELECT o.*,to_char(o.created_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS cursor_time," +
    '(SELECT row_to_json(w) FROM workflow_statuses w WHERE w.id=o.workflow_status_id) AS workflow_status,' +
    '(SELECT sum(quantity)::int FROM order_items WHERE order_id=o.id) AS item_count,' +
    '(SELECT count(*)::int FROM order_items WHERE order_id=o.id) AS line_count,' +
    '(SELECT name FROM order_items WHERE order_id=o.id ORDER BY sku,id LIMIT 1) AS first_item_name,' +
    `ps.summary AS payment_summary,${orderFulfilmentStageSql('o')} AS fulfilment_stage,` +
    "(SELECT coalesce(json_agg(json_build_object('id',d.id,'number',d.number) ORDER BY d.created_at,d.id),'[]'::json) FROM documents d WHERE d.tenant_id=o.tenant_id AND d.order_id=o.id AND d.kind='invoice') AS invoice_documents" +
    ` FROM orders o CROSS JOIN LATERAL (SELECT ${input.paymentSummarySql} AS summary) ps` +
    " CROSS JOIN LATERAL (SELECT coalesce((ps.summary->>'net')::numeric,0) AS net," +
    " CASE WHEN o.status='cancelled' THEN 0 ELSE greatest(o.total-coalesce((ps.summary->>'credit')::numeric,0),0) END AS nominal) pn" +
    ` WHERE ${input.conditions}${page}${input.extraSql ?? ''} AND ${input.operationalPredicate}` +
    ` ORDER BY o.created_at DESC,o.id DESC LIMIT ${limit}`
  );
}

/**
 * List estimate of the card balance per row: ledger net and accepted return credit of the order and its
 * merged sources (per-line cancellation credit stays on the order card), plus the payment state.
 */
export function withPaymentFields<T extends Record<string, any>>(row: T) {
  const { payment_summary, ...rest } = row;
  const { net, credit } = payment_summary ?? { net: 0, credit: 0 };
  const nominal = row.status === 'cancelled' ? 0 : Math.max(Number(row.total) - Number(credit), 0);
  return {
    ...rest,
    quantity_total: row.item_count ?? 0,
    payment_received: Number(net),
    amount_due: Math.max(nominal - Number(net), 0),
    payment_state: paymentState({ payment_mode: row.payment_mode, net: Number(net), nominal }),
  };
}

/** Option lists of the filter panel taken from the tenant's data. */
export async function orderListFilterOptions(c: PoolClient, available: OrderListAvailability) {
  const channels = (await c.query('SELECT DISTINCT source FROM orders ORDER BY source LIMIT 100')).rows.map(
    (r) => r.source as string,
  );
  const currencies = (await c.query('SELECT DISTINCT currency FROM orders ORDER BY currency LIMIT 50')).rows.map(
    (r) => r.currency as string,
  );
  const delivery = available.salesDimensions
    ? (
        await c.query(
          'SELECT DISTINCT delivery_method FROM order_sales_dimensions ORDER BY delivery_method LIMIT 20',
        )
      ).rows.map((r) => r.delivery_method as string)
    : [];
  // Sposób wysyłki: one list of the shop's methods (with cash on delivery variants) and the channels' own methods.
  const channelMethods = available.salesDimensions
    ? (
        await c.query(
          "SELECT DISTINCT provider,delivery_label AS label FROM order_sales_dimensions WHERE delivery_label<>'' ORDER BY 1,2 LIMIT 300",
        )
      ).rows.map((r) => ({ provider: r.provider as string, label: r.label as string }))
    : [];
  const delivery_options: Option[] = deliveryMethodOptions(channelMethods).map((o) => ({
    value: o.value,
    label: o.value.includes(':') && !o.label.toLowerCase().startsWith((o.group ?? '').toLowerCase()) ? `${o.group}: ${o.label}` : o.label,
  }));
  return {
    channels,
    currencies,
    delivery_methods: [...delivery, ...delivery_options.map((o) => o.value).filter((v) => !delivery.includes(v))],
    delivery_options,
    delivery_available: available.salesDimensions,
  };
}
