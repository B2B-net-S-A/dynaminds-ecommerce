/**
 * Automation rules v2: the order context that conditions see (shared/automation-v2.ts CONDITION_FIELD_KEYS).
 * One batched, tenant-scoped (RLS of the caller's tenantTx) and parameterized load for up to 500 orders.
 * Optional modules (sales dimensions, logistics, CRM, order fields, merges, splits, MCF) are read only
 * when their tables exist in this copy.
 */
import type { PoolClient } from 'pg';
import type { ValueType } from '../shared/automation-v2';
import type { OrderContext } from './automation-v2-eval';
import { EXTRA_FIELD_PREFIX } from './automation-v2-fields';
import { orderFulfilmentStageSql, paymentState } from './order-stage';
import { paymentBalance } from './payments';
import { loadChannelProjections } from './channel-projection';
import { shipmentStatusOf } from '../shared/shipment-status';

type Row = Record<string, any>;
const obj = (v: unknown): Row => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Row) : {});
const str = (v: unknown) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : typeof v === 'string' && v ? new Date(v).toISOString() : null);

async function tables(c: PoolClient, names: string[]): Promise<Set<string>> {
  const r = await c.query(
    "SELECT n FROM unnest($1::text[]) n WHERE to_regclass('public.'||n) IS NOT NULL",
    [names],
  );
  return new Set(r.rows.map((x) => x.n));
}

const groupBy = (rows: Row[], key = 'order_id') => {
  const m = new Map<string, Row[]>();
  for (const r of rows) m.set(r[key], [...(m.get(r[key]) ?? []), r]);
  return m;
};

function invoiceOf(address: Row, raw: Row, edited?: Row) {
  // Invoice data edited in the order card (lane E: latest 'order.section_edited' of section invoice) wins.
  const inv = edited ? obj(edited) : obj(address.invoice);
  const allegro = obj(raw.invoice);
  const allegroAddress = obj(allegro.address);
  const nip =
    str(inv.nip) || str(address.nip) || str(obj(allegroAddress.company).taxId) || str(raw.billing?.nip) || '';
  const wants =
    typeof inv.wants_invoice === 'boolean'
      ? inv.wants_invoice
      : typeof address.wants_invoice === 'boolean'
        ? address.wants_invoice
        : allegro.required === true || Boolean(nip);
  const street = str(inv.street) || str(allegroAddress.street);
  const postal = str(inv.postal_code) || str(allegroAddress.zipCode);
  const city = str(inv.city) || str(allegroAddress.city);
  const norm = (v: string) => v.trim().toLocaleLowerCase('pl-PL').replace(/\s+/g, ' ');
  const differs =
    Boolean(street || postal || city) &&
    (norm(street) !== norm(str(address.street)) ||
      norm(postal) !== norm(str(address.postal_code)) ||
      norm(city) !== norm(str(address.city)));
  return { wants, nip, differs };
}

function pickupPoint(address: Row, raw: Row): string {
  const pp = obj(obj(raw.delivery).pickupPoint);
  return str(address.locker_code) || str(address.pickup_point) || str(pp.id) || str(pp.name) || str(raw.shipping_lines?.[0]?.meta_data?.find?.((m: Row) => /paczkomat|point/i.test(str(m.key)))?.value) || '';
}

/** Loads the v2 condition context for orders of the current tenant. Missing orders are absent from the map. */
export async function loadOrderContexts(c: PoolClient, orderIds: string[], now = new Date()): Promise<Map<string, OrderContext>> {
  const ids = [...new Set(orderIds)].slice(0, 500);
  const out = new Map<string, OrderContext>();
  if (!ids.length) return out;
  const has = await tables(c, [
    'order_sales_dimensions', 'product_logistics', 'crm_order_links', 'order_field_values', 'order_merge_executions',
    'order_merge_origins', 'order_split222_executions', 'amazon_fulfillment_plans', 'inbound_orders', 'shipping_plans',
    'email_messages', 'sms_messages', 'return_cases',
  ]);
  const orders = (
    await c.query(
      `SELECT o.*,${orderFulfilmentStageSql('o')} AS stage,ch.provider AS channel_provider,ch.name AS channel_name
       FROM orders o LEFT JOIN channels ch ON (ch.tenant_id,ch.id)=(o.tenant_id,o.channel_id) WHERE o.id=ANY($1::uuid[])`,
      [ids],
    )
  ).rows;
  if (!orders.length) return out;
  const found = orders.map((o) => o.id);
  const q = async (sql: string, params: unknown[] = [found]) => (await c.query(sql, params)).rows;
  const items = groupBy(
    await q(
      `SELECT i.order_id,i.sku,i.name,i.quantity,i.price,p.ean,p.category,p.kind,
        ${has.has('product_logistics') ? 'pl.manufacturer,pl.weight_grams' : 'NULL::text manufacturer,NULL::int weight_grams'},
        (coalesce((SELECT r.quantity FROM reservations r WHERE (r.tenant_id,r.order_id,r.product_id)=(i.tenant_id,i.order_id,i.product_id) AND r.state IN ('active','consumed')),0)
         + greatest(coalesce((SELECT s.on_hand-s.reserved FROM stock s WHERE (s.tenant_id,s.warehouse_id,s.product_id)=(o.tenant_id,o.warehouse_id,i.product_id)),0),0)) >= i.quantity AS stock_ok
       FROM order_items i JOIN orders o ON (o.tenant_id,o.id)=(i.tenant_id,i.order_id)
       JOIN products p ON (p.tenant_id,p.id)=(i.tenant_id,i.product_id)
       ${has.has('product_logistics') ? 'LEFT JOIN product_logistics pl ON (pl.tenant_id,pl.product_id)=(i.tenant_id,i.product_id)' : ''}
       WHERE i.order_id=ANY($1::uuid[]) ORDER BY i.order_id,i.sku`,
    ),
  );
  const since = new Map(
    (
      await q(
        `SELECT e.order_id,max(e.created_at) at FROM order_events e JOIN orders o ON (o.tenant_id,o.id)=(e.tenant_id,e.order_id)
         WHERE e.order_id=ANY($1::uuid[]) AND (e.kind='order.'||o.status OR e.kind='order.workflow_changed') GROUP BY 1`,
      )
    ).map((r) => [r.order_id, r.at]),
  );
  const reopened = new Map(
    (
      await q(
        "SELECT order_id,max(created_at) at FROM order_events WHERE order_id=ANY($1::uuid[]) AND kind='order.payment_reopened' GROUP BY 1",
      )
    ).map((r) => [r.order_id, r.at]),
  );
  const dims = new Map(
    has.has('order_sales_dimensions')
      ? (await q('SELECT * FROM order_sales_dimensions WHERE order_id=ANY($1::uuid[])')).map((r) => [r.order_id, r])
      : [],
  );
  const raws = new Map(
    has.has('inbound_orders')
      ? (
          await q(
            'SELECT DISTINCT ON (order_id) order_id,raw FROM inbound_orders WHERE order_id=ANY($1::uuid[]) ORDER BY order_id,created_at DESC,id',
          )
        ).map((r) => [r.order_id, obj(r.raw)])
      : [],
  );
  // Section edits of the order card (Uwagi v3 §6): the latest values per section are the order's current data.
  const edited = new Map<string, Row>();
  for (const r of await q(
    "SELECT DISTINCT ON (order_id,detail->>'section') order_id,detail->>'section' AS section,detail->'values' AS v FROM order_events WHERE order_id=ANY($1::uuid[]) AND kind='order.section_edited' AND detail->>'section' IN ('invoice','delivery_method','payment') ORDER BY order_id,detail->>'section',created_at DESC,id DESC",
  ))
    edited.set(r.order_id + ':' + r.section, obj(r.v));
  const shipments = groupBy(await q('SELECT order_id,carrier,status,dispatched_at FROM shipments WHERE order_id=ANY($1::uuid[]) ORDER BY created_at,id'));
  const plans = groupBy(
    has.has('shipping_plans')
      ? await q("SELECT order_id,state,input FROM shipping_plans WHERE order_id=ANY($1::uuid[]) AND state NOT IN ('cancelled') ORDER BY created_at,id")
      : [],
  );
  const history = await q(
    `SELECT o.id order_id,
      (SELECT count(*)::int FROM orders x WHERE x.tenant_id=o.tenant_id AND o.email<>'' AND lower(x.email)=lower(o.email) AND x.id<>o.id AND x.created_at<=o.created_at) previous_orders,
      ${has.has('return_cases') ? `(SELECT count(*)::int FROM return_cases r JOIN orders x ON (x.tenant_id,x.id)=(r.tenant_id,r.order_id) WHERE r.tenant_id=o.tenant_id AND o.email<>'' AND lower(x.email)=lower(o.email))` : '0'} previous_returns
     FROM orders o WHERE o.id=ANY($1::uuid[])`,
  );
  const prior = new Map(history.map((r) => [r.order_id, r]));
  const crm = groupBy(
    has.has('crm_order_links')
      ? await q(
          'SELECT l.order_id,cc.status_id FROM crm_order_links l JOIN crm_clients cc ON (cc.tenant_id,cc.id)=(l.tenant_id,l.client_id) WHERE l.order_id=ANY($1::uuid[]) AND cc.deleted_at IS NULL',
        )
      : [],
  );
  const extra = groupBy(
    has.has('order_field_values')
      ? await q(
          `SELECT v.order_id,d.key,d.type,v.text_value,v.number_value,v.date_value,v.option_values,v.file_id
           FROM order_field_values v JOIN order_field_definitions d ON (d.tenant_id,d.id)=(v.tenant_id,v.field_id)
           WHERE v.order_id=ANY($1::uuid[]) AND d.enabled`,
        )
      : [],
  );
  const definitions = has.has('order_field_values')
    ? await q('SELECT key,type FROM order_field_definitions WHERE enabled ORDER BY position,key LIMIT 200', [])
    : [];
  const merged = new Set<string>(
    has.has('order_merge_executions')
      ? (await q('SELECT target_order_id id FROM order_merge_executions WHERE target_order_id=ANY($1::uuid[])')).map((r) => r.id)
      : [],
  );
  const origins = new Set<string>(
    has.has('order_merge_origins')
      ? (await q('SELECT order_id id FROM order_merge_origins WHERE order_id=ANY($1::uuid[])')).map((r) => r.id)
      : [],
  );
  const splits = new Set<string>(
    has.has('order_split222_executions')
      ? (
          await q(
            'SELECT parent_order_id id FROM order_split222_executions WHERE parent_order_id=ANY($1::uuid[]) UNION SELECT child_order_id FROM order_split222_executions WHERE child_order_id=ANY($1::uuid[])',
          )
        ).map((r) => r.id)
      : [],
  );
  const mcf = new Set<string>(
    has.has('amazon_fulfillment_plans')
      ? (await q("SELECT DISTINCT order_id id FROM amazon_fulfillment_plans WHERE order_id=ANY($1::uuid[]) AND state NOT IN ('preview','cancelled','failed')")).map((r) => r.id)
      : [],
  );
  const docs = groupBy(await q('SELECT order_id,kind FROM documents WHERE order_id=ANY($1::uuid[])'));
  const ran = groupBy(
    await q(
      "SELECT DISTINCT order_id,rule_id::text FROM automation_runs WHERE order_id=ANY($1::uuid[]) AND state='done' AND definition->>'engine'='v2'",
    ),
  );
  const sent = groupBy([
    ...(has.has('email_messages')
      ? await q(
          // A team e-mail (snapshot.team_user_id) went to staff, not to the buyer: it is no "template sent".
          "SELECT DISTINCT m.order_id,b.template_id::text FROM email_messages m JOIN email_batches b ON (b.tenant_id,b.id)=(m.tenant_id,m.batch_id) WHERE m.order_id=ANY($1::uuid[]) AND b.template_id IS NOT NULL AND NOT m.snapshot ? 'team_user_id'",
        )
      : []),
    ...(has.has('sms_messages')
      ? await q(
          'SELECT DISTINCT m.order_id,b.template_id::text FROM sms_messages m JOIN sms_batches b ON (b.tenant_id,b.id)=(m.tenant_id,m.batch_id) WHERE m.order_id=ANY($1::uuid[]) AND b.template_id IS NOT NULL',
        )
      : []),
  ]);
  // Channel data (comment, site, flags, ship-by, operator, delivery method, parcel size) with their fallbacks.
  const channel = await loadChannelProjections(c, found);
  const types: Record<string, ValueType> = {};
  for (const d of definitions) types[EXTRA_FIELD_PREFIX + d.key] = extraType(d.type);

  for (const o of orders) {
    const address = obj(o.address);
    const raw = raws.get(o.id) ?? obj(o.source_snapshot);
    const provider = str(o.channel_provider) || str(o.source);
    const lines = items.get(o.id) ?? [];
    const d = dims.get(o.id);
    let balance: { net: number; nominal: number; amount_due: number } | null = null;
    try {
      await c.query('SAVEPOINT v2_balance');
      balance = await paymentBalance(c, o.id);
      await c.query('RELEASE SAVEPOINT v2_balance');
    } catch {
      // A merged/foreign ledger the balance refuses to project: fall back to the order nominal.
      await c.query('ROLLBACK TO SAVEPOINT v2_balance');
      await c.query('RELEASE SAVEPOINT v2_balance');
    }
    const net = balance?.net ?? 0,
      nominal = balance?.nominal ?? (o.status === 'cancelled' ? 0 : o.total);
    const pstate = paymentState({ payment_mode: o.payment_mode, net, nominal });
    const unpaid = pstate === 'unpaid' || pstate === 'partial' || pstate === 'cod';
    const ch = channel.get(o.id);
    const inv = invoiceOf(address, raw, edited.get(o.id + ':invoice'));
    const editedMethod = edited.get(o.id + ':delivery_method'),
      editedPayment = edited.get(o.id + ':payment');
    const ships = shipments.get(o.id) ?? [];
    const pl = plans.get(o.id) ?? [];
    const lastShip = ships[ships.length - 1];
    const plan = pl[pl.length - 1];
    const planInput = obj(plan?.input);
    const values: Record<string, unknown> = {
      'order.created_at': iso(o.created_at),
      'order.status': o.stage,
      'order.workflow_status': o.workflow_status_id,
      'order.total': o.total,
      'order.total_without_shipping': o.total - (o.shipping_cost ?? 0),
      'order.currency': o.currency,
      'order.line_count': lines.length,
      'order.quantity_total': lines.reduce((n, l) => n + l.quantity, 0),
      'order.weight': lines.reduce((n, l) => n + (l.weight_grams ?? 0) * l.quantity, 0),
      'order.time_in_status': iso(since.get(o.id) ?? o.created_at),
      'order.customer_comment': ch?.customer_comment ?? '',
      'order.internal_note': o.note ?? '',
      'order.tags': o.tags ?? [],
      'order.merged_or_split': [
        ...(merged.has(o.id) ? ['merged'] : []),
        ...(origins.has(o.id) ? ['merge_origin'] : []),
        ...(splits.has(o.id) ? ['split'] : []),
      ],
      'source.channel': provider,
      'source.account': o.channel_id,
      'source.site': ch?.site ?? '',
      'source.flags': ch?.flags ?? [],
      'source.ship_by': ch?.ship_by ?? null,
      'payment.state': pstate,
      'payment.method': o.payment_mode === 'cod' ? 'cod' : (str(editedPayment?.method) || (d?.payment_method ?? 'unknown')),
      'payment.operator': ch?.payment_operator ?? '',
      'payment.cod': o.payment_mode === 'cod',
      'payment.paid_amount': net,
      'payment.due_amount': balance ? balance.amount_due : Math.max(nominal - net, 0),
      'payment.unpaid_for': unpaid && nominal > net ? iso(reopened.get(o.id) ?? o.created_at) : null,
      'shipping.method': ch?.shipping_method ?? ['unknown'],
      'shipping.carrier': lastShip?.carrier ?? (str(editedMethod?.carrier) || str(planInput.provider)) ?? '',
      'shipping.pickup_point': pickupPoint(address, raw),
      'shipping.cost': o.shipping_cost ?? 0,
      // A cancelled label (status 'canceled') is no shipment any more; its status stays visible.
      'shipping.has_shipment': ships.some((s) => s.status !== 'canceled') || pl.some((p) => p.state === 'ready'),
      // Carrier codes and their groups (shared/shipment-status.ts: odebrana, w drodze, w punkcie, doręczona, zwrot, problem).
      'shipping.shipment_status': [...new Set(ships.flatMap((s) => [s.status, shipmentStatusOf(s.status)].filter((v): v is string => !!v)))],
      'shipping.parcel_size': ch?.parcel_size ?? '',
      'customer.email': o.email ?? '',
      'customer.wants_invoice': inv.wants,
      'customer.previous_orders': prior.get(o.id)?.previous_orders ?? 0,
      'customer.previous_returns': prior.get(o.id)?.previous_returns ?? 0,
      'customer.crm_group': (crm.get(o.id) ?? []).map((r) => r.status_id).filter(Boolean),
      'customer.has_phone': Boolean(str(address.phone).trim()),
      'address.country': str(address.country),
      'address.postal_code': str(address.postal_code),
      'address.city': str(address.city),
      'address.differs_from_invoice': inv.differs,
      'warehouse.id': o.warehouse_id,
      'warehouse.external_fulfilment': mcf.has(o.id),
      'documents.issued': (docs.get(o.id) ?? []).length > 0,
      'documents.kind': (docs.get(o.id) ?? []).map((r) => r.kind),
      'time.now': now.toISOString(),
      'time.cutoff': iso(o.created_at),
      'history.rule_ran': (ran.get(o.id) ?? []).map((r) => r.rule_id),
      'history.template_sent': (sent.get(o.id) ?? []).map((r) => r.template_id),
      // Not a condition field; carried for summaries and effects.
      'order.number': o.number,
      'order.version': String(o.version),
      'order.raw_status': o.status,
    };
    for (const x of extra.get(o.id) ?? []) values[EXTRA_FIELD_PREFIX + x.key] = extraValue(x);
    for (const key of Object.keys(types)) if (!(key in values)) values[key] = null;
    out.set(o.id, {
      order_id: o.id,
      number: o.number,
      values,
      lines: lines.map((l) => ({
        'product.sku': l.sku,
        'product.ean': l.ean ?? '',
        'product.name': l.name,
        'product.category': l.category ?? '',
        'product.manufacturer': l.manufacturer ?? '',
        'product.quantity': l.quantity,
        'product.price': l.price,
        'product.stock_sufficient': l.stock_ok === true,
        'product.kind': l.kind,
      })),
      types,
    });
  }
  return out;
}

function extraType(t: string): ValueType {
  return t === 'number' ? 'number' : t === 'date' ? 'date' : ['select', 'radio', 'multi_select'].includes(t) ? 'list' : t === 'file' ? 'bool' : 'text';
}

function extraValue(x: Row): unknown {
  if (x.type === 'number') return x.number_value === null ? null : Number(x.number_value);
  if (x.type === 'date') return x.date_value ? iso(x.date_value) : null;
  if (['select', 'radio', 'multi_select'].includes(x.type)) return x.option_values ?? [];
  if (x.type === 'file') return Boolean(x.file_id);
  return x.text_value ?? '';
}

/** Compact snapshot of the context stored with a run (no personal data beyond the order number). */
export function contextSummary(ctx: OrderContext) {
  const v = ctx.values;
  return {
    id: ctx.order_id,
    number: ctx.number,
    status: v['order.status'],
    workflow_status_id: v['order.workflow_status'],
    payment_state: v['payment.state'],
    total: v['order.total'],
    tags: v['order.tags'],
    version: v['order.version'],
  };
}
