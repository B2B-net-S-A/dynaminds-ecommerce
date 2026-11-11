/** Native order split (222): a validated preview, then ONE execution transaction
 * that moves selected line quantities with their pick quantities, reservations and
 * reservation locations from the parent order to a new child order. stock.reserved
 * is unchanged (the reservation moves between orders). Parent + child totals equal
 * the parent's original total exactly (grosze). Only the 222 evidence tables are
 * written besides the native order rows; nothing is attached to core tables.
 * Field mapping and every local choice: docs/parity/ORDER-SPLIT222-20261023.md. */
import type { Pool, PoolClient } from 'pg';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { tenantTx, tenantReadTx, localConfig } from './db';
import { ensure } from './errors';
import { audit, type Actor } from './domain';
import { localOrderEvent } from './events';
import { tokenHash } from './security';
import { assertSaleFinancialKind } from './order-fulfillment-kind';
import { assertOrderMergeActiveInTx } from './order-merge-guards';
import { lockWarehouseInventoryPoliciesInTx } from './warehouse-inventory-policies';
import { enlistWmsActorInTx } from './wms-lots-transaction';
import { wmsLotsPolicyInTx } from './wms-lots';
import {
  effectiveDeliveryInTx,
  effectiveDeliveryForCreatedOrderInTx,
  prepareCreatedOrderBuyerInstallationInTx,
} from './buyer-address';
import * as S from './order-split222-schema';
export * from './order-split222-schema';

type Row = Record<string, any>;
export type OrderSplit222Snapshot = { order: Row; items: Row[]; picks: Row[]; reservations: Row[]; locations: Row[] };
type PlanLine = {
  index: number;
  item_id: string;
  product_id: string;
  sku: string;
  name: string;
  quantity_before: number;
  move_quantity: number;
  parent_quantity_after: number;
  line_total_before: number;
  child_line_total: number;
  parent_line_total_after: number;
  child_price: number;
  parent_price_after: number;
};
export type OrderSplit222Plan = {
  lines: PlanLine[];
  physical: { product_id: string; parent_after: number; child: number }[];
  shipping: { parent_after: number; child: number };
  totals: { parent_before: number; parent_after: number; child: number };
};
const TABLES = ['order_split222_previews', 'order_split222_executions', 'order_split222_targets'];
const TX = { purchasingAdmission: true } as const;

/** Credential custody: an API-key actor carries only the SHA-256 of the presented
 * key, re-checked against api_keys inside every split transaction. */
const credentials = new WeakMap<Actor, string>();
export function captureOrderSplit222Actor(actor: Actor, credential?: string): Actor {
  const a = Object.freeze({ ...actor });
  if (a.apiKeyId) {
    ensure(typeof credential === 'string' && credential.length > 0, 401, 'Brak kontekstu klucza API');
    credentials.set(a, tokenHash(credential));
  }
  return a;
}

function canonical(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v !== null && typeof v === 'object')
    return '{' + Object.keys(v as Row).sort().map((k) => JSON.stringify(k) + ':' + canonical((v as Row)[k])).join(',') + '}';
  return JSON.stringify(v);
}
export const orderSplit222Hash = (v: unknown) => createHash('sha256').update(canonical(v)).digest('hex');
const requestHash = (a: Actor, kind: string, body: unknown) =>
  orderSplit222Hash({ kind, tenant: a.tenantId, actor: a.userId, key: a.apiKeyId ?? null, body });

export async function orderSplit222Available(c: Pool | PoolClient): Promise<boolean> {
  return Boolean(
    (
      await c.query(
        `SELECT (SELECT bool_and(to_regclass('public.'||n) IS NOT NULL) FROM unnest($1::text[]) n)
          AND to_regprocedure('public.order_split222_immutable()') IS NOT NULL
          AND to_regprocedure('public.order_merge_current_role(uuid,boolean)') IS NOT NULL
          AND to_regprocedure('public.order_merge_key_grant(uuid,uuid,boolean)') IS NOT NULL
          AND to_regprocedure('public.buyer_address_identity(uuid,uuid,uuid,text,text,boolean,boolean)') IS NOT NULL
          AND to_regprocedure('public.base_wire220_allocate_pending(text)') IS NOT NULL AS available`,
        [TABLES],
      )
    ).rows[0].available,
  );
}
async function available(c: PoolClient) {
  ensure(await orderSplit222Available(c), 503, 'Ta kopia nie zawiera modułu podziału zamówień');
}
/** Current membership (pinned) and, for an API key, the presented credential (token hash,
 * not revoked/expired, unchanged role, MFA policy) and current orders+inventory scopes,
 * through the existing SECURITY DEFINER checks of the merge and buyer-address modules.
 * Writes pin the membership/key rows; read-only reads (no row locks possible) re-check
 * the credential, and their scopes were checked by the route from the authenticated key. */
async function access(c: PoolClient, a: Actor, write: boolean) {
  const role = (await c.query('SELECT public.order_merge_current_role($1,$2) AS role', [a.userId, write])).rows[0]?.role;
  ensure(['admin', 'operator', 'viewer'].includes(role), 403, 'Brak aktualnego członkostwa firmy');
  ensure(!write || role === 'admin' || role === 'operator', 403, 'Podział zamówienia wymaga roli administratora lub operatora');
  if (a.apiKeyId) {
    const hash = credentials.get(a);
    ensure(hash, 401, 'Brak kontekstu klucza API');
    try {
      await c.query('SELECT public.buyer_address_identity($1,$2,$3,$4,$5,false,$6)', [a.tenantId, a.userId, a.apiKeyId, hash, role, write]);
    } catch (e: any) {
      ensure(!['28000', '40001', '42501'].includes(e?.code), e?.code === '28000' ? 401 : e?.code === '40001' ? 409 : 403,
        e?.code === '28000' ? 'Klucz API wygasł lub został cofnięty' : e?.code === '40001' ? 'Rola konta zmieniła się; ponów operację' : 'Brak aktualnych uprawnień klucza API');
      throw e;
    }
    if (write) {
      const grant = (await c.query('SELECT public.order_merge_key_grant($1,$2,true) AS g', [a.userId, a.apiKeyId])).rows[0].g;
      ensure(grant !== 'invalid', 401, 'Klucz API wygasł lub został cofnięty');
      ensure(grant === 'ok', 403, 'Wymagane scope: orders:read, inventory:read, orders:write, inventory:write');
    }
  }
  return role as Actor['role'];
}

/** Every relationship that makes a split unsafe without its own policy. Tables the
 * app role cannot read are covered by the readable parent facts listed here. */
const BLOCKERS: ReadonlyArray<readonly [string, string, string]> = [
  ...['payment_entries', 'payment_import_allocation_rows', 'payment_import_receipts', 'source_payment_checks'].map(
    (t) => [t, 'order_id', 'płatności'] as const),
  ...['documents', 'invoice_plans', 'odoo_invoice_exports', 'local_invoice_previews', 'local_invoice_receipts', 'proforma_previews',
    'proforma_receipts', 'proforma_batch_preview_rows', 'proforma_batch_execution_rows', 'local_consumer_credit_documents',
    'local_consumer_credit_previews', 'local_consumer_credit_receipts', 'return_credit206_documents', 'return_credit206_previews',
    'return_credit206_receipts', 'b2b_quotes'].map((t) => [t, 'order_id', 'dokumenty'] as const),
  ...['shipments', 'shipping_plans', 'dpd_shipping_plans', 'order_parcel_plans', 'order_parcel_previews', 'order_parcel_allocations',
    'order_parcel_dispatches', 'order_parcel_commercial_origins', 'order_parcel_releases', 'order_parcel_release_previews',
    'order_parcel_return_claims', 'order_parcel_return_receipts', 'shipment_label_batch_preview_rows', 'packed_label_print_intents',
    'print_job_label_sources', 'print_label_previews'].map((t) => [t, 'order_id', 'plan paczek lub przesyłki'] as const),
  ...['picking_wave_orders', 'picking_wave_scans', 'packing_sessions', 'packing_previews', 'packing_receipts', 'packing_photos',
    'packing_photo_confirmations', 'order_batch_items', 'stock_movements', 'stock_location_movements', 'wms_issue_fragments',
    'wms_operations', 'wms_reservation_layers', 'wms_return_fragments'].map((t) => [t, 'order_id', 'skany, kompletację lub ruchy magazynowe'] as const),
  ['order_merge_claims', 'source_order_id', 'historię łączenia'],
  ['order_merge_claims', 'target_order_id', 'historię łączenia'],
  ['order_merge_origins', 'order_id', 'historię łączenia'],
  ['order_merge_executions', 'main_order_id', 'historię łączenia'],
  ['order_merge_executions', 'target_order_id', 'historię łączenia'],
  ...['return_cases', 'return_items', 'b2b_return_local_origins', 'b2b_network_returns', 'b2b_network_return_lines',
    'b2b_dropship_return_previews'].map((t) => [t, 'order_id', 'zwroty lub reklamacje'] as const),
  ['b2b_dropship_return_cases', 'order_id', 'zwroty lub reklamacje'],
  ['return_exchanges', 'original_order_id', 'zwroty lub reklamacje'],
  ['return_exchanges', 'replacement_order_id', 'zwroty lub reklamacje'],
  ['return_exchange_items', 'original_order_id', 'zwroty lub reklamacje'],
  ['return_exchange_replacements', 'replacement_order_id', 'zwroty lub reklamacje'],
  ...['b2b_external_order_intents', 'b2b_external_import_executions', 'b2b_dropship_lines', 'b2b_dropship_supplier_orders',
    'b2b_dropship_actions', 'b2b_network_order_lines', 'b2b_network_receipts', 'b2b_network_receipt_lines', 'amazon_fulfillment_plans',
    'amazon_fulfillment_simulations', 'ebay_fulfillment_plans', 'ebay_fulfillment_receipts', 'ebay_fulfillment_simulations',
    'shopify_fulfillment_plans', 'shopify_fulfillment_simulations', 'shopify_dispatch_evidence', 'order_status_plans',
    'order_status_simulations', 'inbound_orders', 'local_woo_order_import_receipts', 'order_local_financial_fences'].map(
    (t) => [t, 'order_id', 'zewnętrzne zlecenia lub intencje realizacji'] as const),
  ['b2b_external_order_intent_revisions', 'dropship_order_id', 'zewnętrzne zlecenia lub intencje realizacji'],
  ['b2b_dropship_lines', 'customer_order_id', 'zewnętrzne zlecenia lub intencje realizacji'],
  ['b2b_dropship_orders', 'customer_order_id', 'zewnętrzne zlecenia lub intencje realizacji'],
  ['b2b_dropship_orders', 'supplier_order_id', 'zewnętrzne zlecenia lub intencje realizacji'],
  ['b2b_dropship_quotes', 'customer_order_id', 'zewnętrzne zlecenia lub intencje realizacji'],
  ['b2b_network_orders', 'source_order_id', 'zewnętrzne zlecenia lub intencje realizacji'],
  ['order_source_lines', 'source_order_id', 'zewnętrzne zlecenia lub intencje realizacji'],
  ['buyer_address_state', 'order_id', 'zmieniony adres dostawy lub dostęp kupującego'],
  ['buyer_address_receipts', 'order_id', 'zmieniony adres dostawy lub dostęp kupującego'],
];
async function blockers(c: PoolClient, order: Row): Promise<string[]> {
  const present = (
    await c.query(
      `SELECT x.t,x.col FROM unnest($1::text[],$2::text[]) x(t,col) JOIN pg_attribute a ON a.attrelid=to_regclass('public.'||x.t)
        AND a.attname=x.col AND NOT a.attisdropped WHERE has_table_privilege(to_regclass('public.'||x.t),'SELECT')`,
      [BLOCKERS.map((b) => b[0]), BLOCKERS.map((b) => b[1])],
    )
  ).rows as { t: string; col: string }[];
  const reasons: string[] = [];
  if (order.b2b_account_id) reasons.push('zewnętrzne zlecenia lub intencje realizacji');
  if (!present.length) return reasons;
  const hits = (
    await c.query(
      // Identifiers come from the fixed BLOCKERS list above, never from a request.
      'SELECT ARRAY[' + present.map((p) => `EXISTS(SELECT 1 FROM public."${p.t}" WHERE "${p.col}"=$1)`).join(',') + '] AS hits',
      [order.id],
    )
  ).rows[0].hits as boolean[];
  present.forEach((p, i) => {
    const reason = BLOCKERS.find((b) => b[0] === p.t && b[1] === p.col)![2];
    if (hits[i] && !reasons.includes(reason)) reasons.push(reason);
  });
  const merged = (await c.query("SELECT to_regclass('public.order_merge_executions') IS NOT NULL p")).rows[0].p
    ? (await c.query('SELECT 1 FROM order_merge_executions WHERE $1=ANY(source_ids) LIMIT 1', [order.id])).rowCount
    : 0;
  if (merged && !reasons.includes('historię łączenia')) reasons.push('historię łączenia');
  return reasons;
}

/** Locks the parent (warehouse policy first, like lockedOrder) and all its custody rows. */
async function capture(c: PoolClient, orderId: string): Promise<OrderSplit222Snapshot> {
  const head = (await c.query('SELECT warehouse_id FROM orders WHERE id=$1', [orderId])).rows[0];
  ensure(head, 404, 'Nie znaleziono zamówienia');
  await lockWarehouseInventoryPoliciesInTx(c, [head.warehouse_id]);
  const order = (
    await c.query("SELECT to_jsonb(o)||jsonb_build_object('version',o.version::text) AS row FROM orders o WHERE id=$1 FOR UPDATE", [orderId])
  ).rows[0]?.row;
  ensure(order && order.warehouse_id === head.warehouse_id, 409, 'Magazyn zamówienia zmienił się');
  await assertOrderMergeActiveInTx(c, orderId);
  const rows = async (table: string, order: string) =>
    (await c.query(`SELECT to_jsonb(t) AS row FROM ${table} t WHERE order_id=$1 ORDER BY ${order} FOR UPDATE`, [orderId])).rows.map(
      (r) => r.row,
    );
  const snapshot = {
    order,
    items: await rows('order_items', 't.id'),
    picks: await rows('order_pick_items', 't.product_id'),
    reservations: await rows('reservations', 't.product_id'),
    locations: await rows('reservation_locations', 't.product_id,t.location'),
  };
  return JSON.parse(JSON.stringify(snapshot)) as OrderSplit222Snapshot;
}
/** Every refusal is a 409 with the reason; nothing is written before it. */
async function admit(c: PoolClient, s: OrderSplit222Snapshot) {
  const o = s.order;
  assertSaleFinancialKind(o);
  ensure(['new', 'paid'].includes(o.status), 409, 'Podział jest możliwy tylko dla zamówienia nowego lub opłaconego przed kompletacją');
  ensure(!(await wmsLotsPolicyInTx(c)).enabled, 409, 'Podział zamówień nie jest dostępny przy włączonych partiach WMS');
  const reasons = await blockers(c, o);
  ensure(!reasons.length, 409, 'Nie można podzielić zamówienia, które ma ' + reasons.join(', '));
  ensure(
    [...s.items, ...s.picks, ...s.locations].every((r) => r.scanned === 0),
    409,
    'Nie można podzielić zamówienia, które ma skany, kompletację lub ruchy magazynowe',
  );
  for (const r of s.reservations)
    ensure(
      r.state === 'active' && r.consumed_quantity === 0 && r.released_quantity === 0 && r.warehouse_id === o.warehouse_id,
      409,
      'Rezerwacja zamówienia nie jest aktywna w całości',
    );
  for (const l of s.locations)
    ensure(l.consumed_quantity === 0 && l.released_quantity === 0, 409, 'Rezerwacja lokalizacji nie jest aktywna w całości');
  for (const p of s.picks) {
    const r = s.reservations.find((x) => x.product_id === p.product_id);
    ensure(r && r.quantity === p.quantity, 409, 'Rezerwacja nie odpowiada ilości do kompletacji');
    const located = s.locations.filter((l) => l.product_id === p.product_id).reduce((n, l) => n + l.quantity, 0);
    ensure(located === r.quantity, 409, 'Rezerwacja nie ma pełnego przydziału lokalizacji');
  }
  ensure(s.reservations.length === s.picks.length, 409, 'Rezerwacja nie odpowiada ilości do kompletacji');
}
function recipe(item: Row): { product_id: string; quantity: number }[] {
  return Array.isArray(item.components) && item.components.length
    ? item.components.map((x: Row) => ({ product_id: x.product_id, quantity: Number(x.quantity) }))
    : [{ product_id: item.product_id, quantity: 1 }];
}
/** Exact grosze: a line priced price×quantity moves price×moved; any other line
 * moves floor(total×moved/quantity) and the remainder stays with the parent. */
export function orderSplit222Plan(s: OrderSplit222Snapshot, b: S.OrderSplit222PreviewInput): OrderSplit222Plan {
  const o = s.order;
  const lines: PlanLine[] = b.items.map((want, index) => {
    const i = s.items.find((x) => x.id === want.item_id);
    ensure(i, 404, 'Pozycja nie należy do tego zamówienia');
    ensure(want.quantity <= i.quantity, 422, 'Ilość do przeniesienia przekracza ilość pozycji');
    const exact = BigInt(i.price) * BigInt(i.quantity) === BigInt(i.line_total);
    const child = exact ? i.price * want.quantity : Number((BigInt(i.line_total) * BigInt(want.quantity)) / BigInt(i.quantity));
    const rest = i.quantity - want.quantity, parentTotal = i.line_total - child;
    return {
      index, item_id: i.id, product_id: i.product_id, sku: i.sku, name: i.name,
      quantity_before: i.quantity, move_quantity: want.quantity, parent_quantity_after: rest,
      line_total_before: i.line_total, child_line_total: child, parent_line_total_after: parentTotal,
      child_price: exact ? i.price : Math.floor(child / want.quantity),
      parent_price_after: exact || rest === 0 ? i.price : Math.floor(parentTotal / rest),
    };
  });
  const remaining = s.items.filter((i) => !lines.some((l) => l.item_id === i.id && l.parent_quantity_after === 0));
  ensure(remaining.length > 0, 422, 'Zamówienie źródłowe musi zachować co najmniej jedną pozycję');
  ensure(b.shipping_cost_to_child <= o.shipping_cost, 422, 'Przenoszona dostawa przekracza koszt dostawy zamówienia');
  const moved = new Map<string, number>();
  for (const l of lines)
    for (const part of recipe(s.items.find((i) => i.id === l.item_id)!))
      moved.set(part.product_id, (moved.get(part.product_id) ?? 0) + part.quantity * l.move_quantity);
  const physical = [...moved].sort(([x], [y]) => x.localeCompare(y)).map(([product_id, child]) => {
    const pick = s.picks.find((p) => p.product_id === product_id);
    ensure(pick && child <= pick.quantity, 409, 'Ilość fizyczna składnika nie odpowiada kompletacji zamówienia');
    return { product_id, parent_after: pick.quantity - child, child };
  });
  const child = lines.reduce((n, l) => n + l.child_line_total, 0) + b.shipping_cost_to_child;
  const parentAfter = o.total - child;
  ensure(parentAfter >= 0 && Number.isSafeInteger(child) && child <= 2147483647, 422, 'Wartość podziału przekracza wartość zamówienia');
  return {
    lines,
    physical,
    shipping: { parent_after: o.shipping_cost - b.shipping_cost_to_child, child: b.shipping_cost_to_child },
    totals: { parent_before: o.total, parent_after: parentAfter, child },
  };
}
function previewView(p: Row) {
  return {
    id: p.id, parent_order_id: p.parent_order_id, client_key: p.client_key, scope_hash: p.scope_hash,
    parent_total_before: p.parent_total_before, parent_total_after: p.parent_total_after, child_total: p.child_total,
    child_shipping_cost: p.child_shipping_cost, parent_shipping_cost_after: p.plan.shipping.parent_after,
    currency: p.snapshot.order.currency, lines: p.plan.lines, physical: p.plan.physical,
    created_at: new Date(p.created_at).toISOString(), expires_at: new Date(p.expires_at).toISOString(),
  };
}
function executionView(e: Row, targets: Row[]) {
  return {
    id: e.id, preview_id: e.preview_id, parent_order_id: e.parent_order_id, child_order_id: e.child_order_id,
    child_number: e.after_snapshot.child?.number, client_key: e.client_key, scope_hash: e.scope_hash,
    parent_total_before: e.parent_total_before, parent_total_after: e.parent_total_after, child_total: e.child_total,
    child_shipping_cost: e.child_shipping_cost, currency: e.before_snapshot.order.currency,
    targets: targets.map((t) => ({
      index: t.index, source_item_id: t.source_item_id, target_item_id: t.target_item_id, product_id: t.product_id,
      quantity: t.quantity, line_total: t.line_total, parent_quantity_after: t.parent_quantity_after,
      parent_line_total_after: t.parent_line_total_after,
    })),
    created_at: new Date(e.created_at).toISOString(),
  };
}
async function lock(c: PoolClient, a: Actor, orderId: string) {
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['order.split222:' + a.tenantId + ':' + orderId]);
}
const flags = (role: Actor['role']) => ({ available: true, current_role: role, can_split: role === 'admin' || role === 'operator' });

/** `inTx`: an automation rule's own managed tenant transaction; every check below runs unchanged in it. */
export async function createOrderSplit222Preview(a: Actor, orderId: string, input: unknown, inTx?: PoolClient) {
  const id = S.orderSplit222Id.parse(orderId);
  const b = S.orderSplit222PreviewInput.parse(input);
  ensure(Buffer.byteLength(JSON.stringify(b)) <= S.ORDER_SPLIT222_LIMITS.request_bytes, 413, 'Żądanie podziału przekracza limit bajtów');
  const body = { order_id: id, ...b };
  const tx: typeof tenantTx = inTx ? (_tenant, work) => work(inTx) : tenantTx;
  return tx(a.tenantId, async (c) => {
    await available(c);
    const role = await access(c, a, true);
    await lock(c, a, id);
    const previous = (await c.query('SELECT * FROM order_split222_previews WHERE client_key=$1', [b.client_key])).rows[0];
    if (previous) {
      ensure(previous.request_hash === requestHash(a, 'preview', body), 409, 'Klucz został użyty z inną operacją lub aktorem');
      return { ...flags(role), preview: previewView(previous), reused: true };
    }
    ensure(
      (await c.query('SELECT count(*)::int n FROM order_split222_previews')).rows[0].n < S.ORDER_SPLIT222_LIMITS.previews,
      429,
      'Limit podglądów podziału zamówień',
    );
    const snapshot = await capture(c, id);
    await admit(c, snapshot);
    const p = orderSplit222Plan(snapshot, b);
    const previewId = randomUUID(), scope = orderSplit222Hash({ request: body, snapshot });
    const row = (
      await c.query(
        `INSERT INTO order_split222_previews(id,tenant_id,parent_order_id,actor_id,api_key_id,source,client_key,request_hash,request,scope_hash,snapshot,plan,
          parent_total_before,parent_total_after,child_total,child_shipping_cost,moved_lines,expires_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,clock_timestamp()+make_interval(secs=>$18)) RETURNING *`,
        [previewId, a.tenantId, id, a.userId, a.apiKeyId ?? null, a.apiKeyId ? 'api' : 'manual', b.client_key, requestHash(a, 'preview', body),
          body, scope, snapshot, p, p.totals.parent_before, p.totals.parent_after, p.totals.child, p.shipping.child, p.lines.length,
          S.ORDER_SPLIT222_LIMITS.preview_ttl_seconds],
      )
    ).rows[0];
    await audit(c, a, 'order.split.preview', previewId, { order_id: id, scope_hash: scope });
    return { ...flags(role), preview: previewView(row), reused: false };
  }, TX);
}

async function nextNumber(c: PoolClient, parent: Row) {
  const n = (await c.query('SELECT count(*)::int n FROM order_split222_executions WHERE parent_order_id=$1', [parent.id])).rows[0].n;
  for (let k = n + 1; k <= n + 50; k++) {
    const number = `${parent.number}-S${k}`;
    if (!(await c.query('SELECT 1 FROM orders WHERE number=$1', [number])).rowCount) return number;
  }
  return 'SPLIT-' + randomBytes(6).toString('hex').toUpperCase();
}

/** `inTx`: see createOrderSplit222Preview. */
export async function executeOrderSplit222(a: Actor, previewId: string, input: unknown, inTx?: PoolClient) {
  const id = S.orderSplit222Id.parse(previewId);
  const b = S.orderSplit222ExecuteInput.parse(input);
  const body = { preview_id: id, ...b };
  const tx: typeof tenantTx = inTx ? (_tenant, work) => work(inTx) : tenantTx;
  return tx(a.tenantId, async (c) => {
    await available(c);
    const role = await access(c, a, true);
    const prior = (await c.query('SELECT * FROM order_split222_executions WHERE client_key=$1', [b.client_key])).rows[0];
    if (prior) {
      ensure(prior.request_hash === requestHash(a, 'execute', body), 409, 'Klucz został użyty z inną operacją lub aktorem');
      const targets = (await c.query('SELECT * FROM order_split222_targets WHERE execution_id=$1 ORDER BY index', [prior.id])).rows;
      return { ...flags(role), execution: executionView(prior, targets), reused: true };
    }
    const p = (await c.query('SELECT * FROM order_split222_previews WHERE id=$1', [id])).rows[0];
    ensure(p, 404, 'Nie znaleziono podglądu podziału');
    ensure(p.actor_id === a.userId && (p.api_key_id ?? null) === (a.apiKeyId ?? null), 403, 'Podgląd należy do innego aktora');
    ensure(p.scope_hash === b.scope_hash, 409, 'Zatwierdzono inny zakres podziału');
    await lock(c, a, p.parent_order_id);
    ensure(!(await c.query('SELECT 1 FROM order_split222_executions WHERE preview_id=$1', [p.id])).rowCount, 409, 'Podgląd już wykonano z innym kluczem');
    ensure((await c.query('SELECT expires_at>clock_timestamp() AS valid FROM order_split222_previews WHERE id=$1', [p.id])).rows[0].valid, 409, 'Podgląd wygasł; przygotuj nowy');
    const wms = enlistWmsActorInTx(c, a, { orders: true });
    const installation = await prepareCreatedOrderBuyerInstallationInTx(c, a.tenantId);
    const snapshot = await capture(c, p.parent_order_id);
    ensure(orderSplit222Hash({ request: p.request, snapshot }) === p.scope_hash, 409, 'Zamówienie, pozycje lub rezerwacje zmieniły się; przygotuj nowy podgląd');
    await admit(c, snapshot);
    const parent = snapshot.order, x: OrderSplit222Plan = p.plan, childId = randomUUID(), executionId = randomUUID();
    // Child header: the full parent business header with a new identity and its own totals.
    const columns = (
      await c.query("SELECT attname FROM pg_attribute WHERE attrelid='orders'::regclass AND attnum>0 AND NOT attisdropped AND attgenerated='' ORDER BY attnum")
    ).rows.map((r) => r.attname as string);
    const now = new Date().toISOString(), number = await nextNumber(c, parent);
    const header = { ...parent, id: childId, number, source: 'order_split', external_id: null, channel_id: null, source_snapshot: null,
      portal_token: randomBytes(24).toString('hex'), version: '1', created_at: now, updated_at: now,
      total: x.totals.child, shipping_cost: x.shipping.child };
    const identifiers = columns.map((n) => '"' + n.replaceAll('"', '""') + '"').join(',');
    await c.query(`INSERT INTO orders(${identifiers}) SELECT ${identifiers} FROM jsonb_populate_record(NULL::orders,$1::jsonb)`, [JSON.stringify(header)]);
    const targets: Row[] = [];
    for (const l of x.lines) {
      const item = snapshot.items.find((i) => i.id === l.item_id)!, target = randomUUID();
      await c.query(
        'INSERT INTO order_items(id,tenant_id,order_id,product_id,name,sku,quantity,price,vat,line_total,components) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
        [target, a.tenantId, childId, item.product_id, item.name, item.sku, l.move_quantity, l.child_price, item.vat, l.child_line_total, JSON.stringify(item.components)],
      );
      if (l.parent_quantity_after === 0) await c.query('DELETE FROM order_items WHERE id=$1', [item.id]);
      else
        await c.query('UPDATE order_items SET quantity=$2,price=$3,line_total=$4 WHERE id=$1', [item.id, l.parent_quantity_after, l.parent_price_after, l.parent_line_total_after]);
      targets.push({ ...l, target_item_id: target });
    }
    for (const ph of x.physical) {
      const pick = snapshot.picks.find((r) => r.product_id === ph.product_id)!;
      const reservation = snapshot.reservations.find((r) => r.product_id === ph.product_id)!;
      await c.query('INSERT INTO order_pick_items(id,tenant_id,order_id,product_id,sku,name,ean,quantity) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
        [randomUUID(), a.tenantId, childId, ph.product_id, pick.sku, pick.name, pick.ean, ph.child]);
      await c.query('INSERT INTO reservations(tenant_id,order_id,product_id,warehouse_id,quantity) VALUES($1,$2,$3,$4,$5)',
        [a.tenantId, childId, ph.product_id, reservation.warehouse_id, ph.child]);
      // Locations in their stable order: the child takes the first units, the parent keeps the
      // rest. A fully taken location row moves to the child (location rows are never deleted).
      let left = ph.child;
      for (const l of snapshot.locations.filter((r) => r.product_id === ph.product_id)) {
        const take = Math.min(left, l.quantity);
        if (take === 0) break;
        if (take === l.quantity)
          await c.query('UPDATE reservation_locations SET order_id=$4 WHERE order_id=$1 AND product_id=$2 AND location=$3', [parent.id, ph.product_id, l.location, childId]);
        else {
          await c.query('UPDATE reservation_locations SET quantity=quantity-$4 WHERE order_id=$1 AND product_id=$2 AND location=$3', [parent.id, ph.product_id, l.location, take]);
          await c.query('INSERT INTO reservation_locations(tenant_id,order_id,product_id,warehouse_id,location,quantity) VALUES($1,$2,$3,$4,$5,$6)',
            [a.tenantId, childId, ph.product_id, l.warehouse_id, l.location, take]);
        }
        left -= take;
      }
      ensure(left === 0, 409, 'Rezerwacja nie ma pełnego przydziału lokalizacji');
      if (ph.parent_after === 0) {
        await c.query('DELETE FROM reservations WHERE order_id=$1 AND product_id=$2', [parent.id, ph.product_id]);
        await c.query('DELETE FROM order_pick_items WHERE id=$1', [pick.id]);
      } else {
        await c.query('UPDATE reservations SET quantity=$3 WHERE order_id=$1 AND product_id=$2', [parent.id, ph.product_id, ph.parent_after]);
        await c.query('UPDATE order_pick_items SET quantity=$2 WHERE id=$1', [pick.id, ph.parent_after]);
      }
    }
    await c.query('UPDATE orders SET total=$2,shipping_cost=$3,updated_at=clock_timestamp() WHERE id=$1', [parent.id, x.totals.parent_after, x.shipping.parent_after]);
    // Exact reconciliation of the committed rows, not of the plan.
    const sums = (
      await c.query(
        `SELECT o.id,o.total,o.shipping_cost,o.number,(SELECT coalesce(sum(line_total),0)::bigint FROM order_items i WHERE i.order_id=o.id) lines
          FROM orders o WHERE o.id=ANY($1::uuid[])`,
        [[parent.id, childId]],
      )
    ).rows;
    const pRow = sums.find((r) => r.id === parent.id)!, cRow = sums.find((r) => r.id === childId)!;
    ensure(BigInt(pRow.total) + BigInt(cRow.total) === BigInt(parent.total), 500, 'Suma podziału nie odpowiada wartości zamówienia');
    ensure(BigInt(pRow.shipping_cost) + BigInt(cRow.shipping_cost) === BigInt(parent.shipping_cost), 500, 'Suma dostawy nie odpowiada zamówieniu');
    ensure(
      BigInt(pRow.lines) + BigInt(cRow.lines) === BigInt(snapshot.items.reduce((n, i) => n + i.line_total, 0)),
      500,
      'Suma pozycji nie odpowiada zamówieniu',
    );
    const custody = (
      await c.query(
        `SELECT r.product_id,sum(r.quantity)::int q,(SELECT coalesce(sum(l.quantity),0)::int FROM reservation_locations l WHERE l.order_id=ANY($1::uuid[]) AND l.product_id=r.product_id) l,
          (SELECT coalesce(sum(p.quantity),0)::int FROM order_pick_items p WHERE p.order_id=ANY($1::uuid[]) AND p.product_id=r.product_id) p
          FROM reservations r WHERE r.order_id=ANY($1::uuid[]) GROUP BY r.product_id ORDER BY r.product_id`,
        [[parent.id, childId]],
      )
    ).rows;
    ensure(
      custody.length === snapshot.reservations.length &&
        custody.every((r) => {
          const before = snapshot.reservations.find((x) => x.product_id === r.product_id);
          return before && r.q === before.quantity && r.l === before.quantity && r.p === before.quantity;
        }),
      500,
      'Rezerwacje po podziale nie odpowiadają rezerwacjom zamówienia',
    );
    await c.query("SELECT public.base_wire220_allocate_pending('order')");
    const after = {
      parent: { id: parent.id, total: Number(pRow.total), shipping_cost: Number(pRow.shipping_cost) },
      child: { id: childId, number: cRow.number, total: Number(cRow.total), shipping_cost: Number(cRow.shipping_cost) },
      targets: targets.map((t) => ({ source_item_id: t.item_id, target_item_id: t.target_item_id, quantity: t.move_quantity })),
      physical: x.physical,
    };
    const e = (
      await c.query(
        `INSERT INTO order_split222_executions(id,tenant_id,preview_id,parent_order_id,child_order_id,actor_id,api_key_id,source,client_key,request_hash,request,scope_hash,
          before_snapshot,after_snapshot,parent_total_before,parent_total_after,child_total,child_shipping_cost)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
        [executionId, a.tenantId, p.id, parent.id, childId, a.userId, a.apiKeyId ?? null, a.apiKeyId ? 'api' : 'manual', b.client_key,
          requestHash(a, 'execute', body), body, p.scope_hash, snapshot, after, x.totals.parent_before, x.totals.parent_after, x.totals.child, x.shipping.child],
      )
    ).rows[0];
    const targetRows: Row[] = [];
    for (const t of targets)
      targetRows.push(
        (
          await c.query(
            `INSERT INTO order_split222_targets(tenant_id,execution_id,index,source_item_id,target_item_id,product_id,quantity,line_total,parent_quantity_after,parent_line_total_after)
             VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
            [a.tenantId, executionId, t.index, t.item_id, t.target_item_id, t.product_id, t.move_quantity, t.child_line_total, t.parent_quantity_after, t.parent_line_total_after],
          )
        ).rows[0],
      );
    await localOrderEvent(c, a.tenantId, parent.id, 'order.split', { execution_id: executionId, child_order_id: childId });
    await localOrderEvent(c, a.tenantId, childId, 'order.created', { split_from: parent.id, execution_id: executionId });
    await audit(c, wms, 'order.split.execute', executionId, { preview_id: p.id, parent_order_id: parent.id, child_order_id: childId, scope_hash: p.scope_hash });
    // The child's effective delivery is the inherited order address (installation proof as createOrder).
    const delivery = installation
      ? await effectiveDeliveryForCreatedOrderInTx(c, a.tenantId, childId, localConfig.encryptionKey, installation)
      : await effectiveDeliveryInTx(c, a.tenantId, childId, localConfig.encryptionKey);
    ensure(delivery, 500, 'Brak adresu dostawy zamówienia wynikowego');
    await c.query('SET CONSTRAINTS ALL IMMEDIATE');
    return { ...flags(role), execution: executionView(e, targetRows), reused: false };
  }, TX);
}

export async function orderSplit222PreviewDetail(a: Actor, previewId: string) {
  const id = S.orderSplit222Id.parse(previewId);
  return tenantReadTx(a.tenantId, async (c) => {
    await available(c);
    const role = await access(c, a, false);
    const p = (await c.query('SELECT * FROM order_split222_previews WHERE id=$1', [id])).rows[0];
    ensure(p, 404, 'Nie znaleziono podglądu podziału');
    const executed = (await c.query('SELECT id FROM order_split222_executions WHERE preview_id=$1', [id])).rows[0]?.id ?? null;
    return { ...flags(role), preview: { ...previewView(p), execution_id: executed } };
  });
}
export async function orderSplit222ExecutionDetail(a: Actor, executionId: string) {
  const id = S.orderSplit222Id.parse(executionId);
  return tenantReadTx(a.tenantId, async (c) => {
    await available(c);
    const role = await access(c, a, false);
    const e = (await c.query('SELECT * FROM order_split222_executions WHERE id=$1', [id])).rows[0];
    ensure(e, 404, 'Nie znaleziono wykonania podziału');
    const targets = (await c.query('SELECT * FROM order_split222_targets WHERE execution_id=$1 ORDER BY index', [id])).rows;
    return { ...flags(role), execution: executionView(e, targets) };
  });
}
/** Split lineage of one order: the executions where it is the parent, and its own origin. */
export async function orderSplit222Lineage(a: Actor, orderId: string) {
  const id = S.orderSplit222Id.parse(orderId);
  return tenantReadTx(a.tenantId, async (c) => {
    await available(c);
    const role = await access(c, a, false);
    ensure((await c.query('SELECT 1 FROM orders WHERE id=$1', [id])).rowCount, 404, 'Nie znaleziono zamówienia');
    const list = async (where: string) => {
      const rows = (await c.query(`SELECT * FROM order_split222_executions WHERE ${where}=$1 ORDER BY created_at,id`, [id])).rows;
      const out = [];
      for (const e of rows)
        out.push(executionView(e, (await c.query('SELECT * FROM order_split222_targets WHERE execution_id=$1 ORDER BY index', [e.id])).rows));
      return out;
    };
    return { ...flags(role), order_id: id, children: await list('parent_order_id'), origin: (await list('child_order_id'))[0] ?? null };
  });
}
