import { assertB2bDropshipMergeableInTx } from './b2b-dropship-guards';
import { assertSaleFinancialKind } from './order-fulfillment-kind';
import type { Pool, PoolClient } from 'pg';
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { tenantTx, localConfig } from './db';
import { ensure } from './errors';
import { audit, type Actor } from './domain';
import { localOrderEvent } from './events';
import { enlistWmsActorInTx } from './wms-lots-transaction';
import {
  orderMergeFinancialSnapshotInTx,
  orderMergeCombinedPaymentBalanceInTx,
  transferOrderMergeFinanceInTx,
  effectiveOrderMergePaymentBalanceInTx,
} from './order-merge-payments';
import {
  orderMergeCustodySnapshotInTx,
  transferOrderMergeCustodyInTx,
} from './order-merge-custody';
import * as S from './order-merges-schema';
import {captureOrderMergeDeliverySourcesInTx,projectOrderMergeDeliverySnapshot,type OrderMergeDeliveryFrame} from './order-merge-delivery-inheritance';
import {inheritOrderMergeBuyerAddressInTx,enlistOrderMergeBuyerAddressActorInTx} from './buyer-address';
export * from './order-merges-schema';
type Row = Record<string, any>;
type Access = { role: Actor['role']; manage: boolean };
type Snapshot = {
  orders: Row[];
  items: Row[];
  picks: Row[];
  custody: Row;
  payments: Row;
  blockers: Row;
  origins: Row[];
  buyer_delivery_frames?: OrderMergeDeliveryFrame[];
};
const writeTx = { purchasingAdmission: true } as const;
const readTx = { wmsAdmission: 'read' } as const;
const tables = [
  'order_merge_previews',
  'order_merge_preview_rows',
  'order_merge_executions',
  'order_merge_execution_rows',
  'order_merge_claims',
  'order_merge_origins',
];
function canonical(v: any): string {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v !== null && typeof v === 'object')
    return (
      '{' +
      Object.keys(v)
        .sort()
        .map((k) => JSON.stringify(k) + ':' + canonical(v[k]))
        .join(',') +
      '}'
    );
  return JSON.stringify(v);
}
export const orderMergeHash = (v: unknown) =>
  createHash('sha256').update(canonical(v)).digest('hex');
const bounded = <T>(v: T, limit: number = S.ORDER_MERGE_LIMITS.response_bytes): T => {
  ensure(
    Buffer.byteLength(JSON.stringify(v)) <= limit,
    413,
    'Odpowiedź łączenia zamówień przekracza limit bajtów',
  );
  return v;
};
const requestHash = (a: Actor, b: unknown) =>
  orderMergeHash({
    actor: a.userId,
    key: a.apiKeyId ?? null,
    source: a.apiKeyId ? 'api' : 'manual',
    body: b,
  });
export async function orderMergesAvailable(c: Pool | PoolClient) {
  return Boolean(
    (
      await c.query(
        `SELECT
    (SELECT bool_and(to_regclass('public.'||n) IS NOT NULL) FROM unnest($1::text[]) n)
    AND to_regprocedure('public.order_merge_current_role(uuid,boolean)') IS NOT NULL
    AND to_regprocedure('public.order_merge_key_grant(uuid,uuid,boolean)') IS NOT NULL
    AND to_regclass('public.order_merge_custody_transfers') IS NOT NULL
    AND to_regprocedure('public.order_merge_transfer_custody(uuid)') IS NOT NULL
    AND to_regprocedure('public.order_merge_custody_snapshot(uuid[])') IS NOT NULL
    AND to_regprocedure('public.order_merge_operational_guard()') IS NOT NULL
    AND to_regprocedure('public.order_merge_delivery209_inherit(uuid,uuid,uuid,text,text,text,integer,text)') IS NOT NULL AS available`,
        [tables],
      )
    ).rows[0].available,
  );
}
async function access(c: PoolClient, a: Actor, write = false, pin = true): Promise<Access> {
  const role = (await c.query('SELECT order_merge_current_role($1,$2) role', [a.userId, pin]))
    .rows[0].role;
  ensure(['admin', 'operator', 'viewer'].includes(role), 403, 'Brak aktualnego członkostwa firmy');
  ensure(!write || role === 'admin', 403, 'Łączenie zamówień wymaga administratora');
  let manage = role === 'admin';
  if (a.apiKeyId && pin) {
    const g = (
      await c.query('SELECT order_merge_key_grant($1,$2,$3) grant_result', [
        a.userId,
        a.apiKeyId,
        write,
      ])
    ).rows[0].grant_result;
    ensure(g !== 'invalid', 401, 'Klucz API wygasł lub został cofnięty');
    ensure(
      g === 'ok' || (!write && g === 'read_only'),
      403,
      'Wymagane aktualne scope zamówień i magazynu',
    );
    manage = manage && g === 'ok';
  }
  return { role, manage };
}
const flags = (a: Access) => ({
  available: true,
  current_role: a.role,
  can_read: true,
  can_preview: a.manage,
  can_execute: a.manage,
  can_read_value: a.role === 'admin',
  read_only: false,
});
async function available(c: PoolClient) {
  ensure(
    await orderMergesAvailable(c),
    503,
    'Ta kopia nie zawiera pełnego modułu łączenia zamówień',
  );
}
async function admission(c: PoolClient, a: Actor) {
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    'order.merge.proof:' + a.tenantId,
  ]);
  await c.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))', [
    'catalog:' + a.tenantId,
  ]);
}
async function rows(
  c: PoolClient,
  table: string,
  ids: string[],
  order: string,
  lock = false,
): Promise<Row[]> {
  const json =
    table === 'orders'
      ? "to_jsonb(t)||jsonb_build_object('version',t.version::text)"
      : 'to_jsonb(t)';
  return (
    await c.query(
      `SELECT ${json} row FROM ${table} t WHERE ${table === 'orders' ? 'id' : 'order_id'}=ANY($1::uuid[]) ORDER BY ${order}${lock ? ' FOR UPDATE OF t' : ''}`,
      [ids],
    )
  ).rows.map((r) => r.row);
}
async function capture(
  c: PoolClient,
  ids: string[],
  lock: boolean,
): Promise<Snapshot> {
  await assertB2bDropshipMergeableInTx(c, ids);
  const orders = await rows(c, 'orders', ids, 't.id', lock);
  ensure(
    orders.length === ids.length,
    404,
    'Nie znaleziono wszystkich zamówień w tej firmie',
  );
  // Both preview and execution call capture after locking their source/main order headers.
  for (const order of orders) assertSaleFinancialKind(order);
  ensure(
    !(
      await c.query(
        'SELECT 1 FROM order_merge_claims WHERE source_order_id=ANY($1::uuid[]) LIMIT 1',
        [ids],
      )
    ).rowCount,
    409,
    'Wybrane zamówienie zostało już zastąpione przez innego właściciela realizacji',
  );
  const buyer_delivery_frames = await captureOrderMergeDeliverySourcesInTx(
    c,
    orders[0].tenant_id,
    orders,
    localConfig.encryptionKey,
  );
  const items = await rows(c, 'order_items', ids, 't.order_id,t.id', lock);
  ensure(
    items.length > 0 && items.length <= S.ORDER_MERGE_LIMITS.lines,
    422,
    'Wybierz od 1 do 10000 pozycji handlowych',
  );
  const picks = await rows(
    c,
    'order_pick_items',
    ids,
    't.order_id,t.product_id',
    lock,
  );
  if (lock) {
    await c.query(
      'SELECT warehouse_id,product_id FROM stock WHERE (warehouse_id,product_id) IN (SELECT warehouse_id,product_id FROM reservations WHERE order_id=ANY($1::uuid[])) ORDER BY warehouse_id,product_id FOR UPDATE',
      [ids],
    );
    // All mutable children are locked after their parent orders; parent UPDATE locks also fence new FK children.
  }
  const blockers: Row = {};
  for (const table of [
    'shipments',
    'documents',
    'return_cases',
    'shipping_plans',
    'dpd_shipping_plans',
    'invoice_plans',
    'order_status_plans',
    'odoo_invoice_exports',
    'ebay_fulfillment_plans',
    'amazon_fulfillment_plans',
    'shopify_fulfillment_plans',
    'picking_wave_orders',
    'packing_sessions',
  ]) {
    if (
      !(await c.query('SELECT to_regclass($1) present', ['public.' + table]))
        .rows[0].present
    )
      continue;
    blockers[table] = await rows(
      c,
      table,
      ids,
      table === 'picking_wave_orders' ? 't.order_id,t.wave_id' : 't.id',
      false,
    );
  }
  if (blockers.picking_wave_orders?.length)
    blockers.picking_wave_orders = (
      await c.query(
        `SELECT to_jsonb(m)||jsonb_build_object('wave_state',w.state,'wave_version',w.version::text) row FROM picking_wave_orders m JOIN picking_waves w ON(w.tenant_id,w.id)=(m.tenant_id,m.wave_id) WHERE m.order_id=ANY($1::uuid[]) ORDER BY m.order_id,m.wave_id`,
        [ids],
      )
    ).rows.map((r) => r.row);
  const origins = (
    await c.query(
      `SELECT DISTINCT ON (x.target_item_id) x.target_item_id,x.row->>'root_source_order_id' root_order,x.row->>'root_source_item_id' root_item
    FROM order_merge_execution_rows x JOIN order_merge_executions e ON(e.tenant_id,e.id)=(x.tenant_id,x.execution_id)
    WHERE target_item_id=ANY($1::uuid[]) ORDER BY x.target_item_id,e.created_at DESC,e.id DESC`,
      [items.map((i) => i.id)],
    )
  ).rows;
  const custody = await orderMergeCustodySnapshotInTx(c, ids);
  const payments = await orderMergeFinancialSnapshotInTx(c, ids);
  return JSON.parse(
    JSON.stringify({
      orders,
      items,
      picks,
      custody,
      payments,
      blockers,
      origins,
      buyer_delivery_frames,
    }),
  ) as Snapshot;
}
/** The preview's receiver check: every source has the main order's buyer, address, B2B account and effective
 * delivery (209 frame). A conflict needs the administrator's explicit receiver confirmation at execution. */
function hasReceiverConflict(snapshot: Snapshot, main: Row): boolean {
  const receiver = (o: Row) => {
    const frame = snapshot.buyer_delivery_frames?.find((f) => f.order_id === o.id);
    return orderMergeHash([o.customer_name, o.email, o.address, o.b2b_account_id ?? null, frame?.effective_kind, frame?.effective_hash]);
  };
  return snapshot.orders.some((o) => receiver(o) !== receiver(main));
}
/**
 * Read-only check of a candidate merge with the module's own capture and conflict rules (automation proposals):
 * no lock, no preview row, no actor authority. It never replaces the preview: the administrator's preview re-runs
 * every check under locks and the execution re-verifies the snapshot.
 */
export async function orderMergeEligibilityInTx(
  c: PoolClient,
  mainOrderId: string,
  ids: string[],
): Promise<{ conflicts: string[]; receiver_conflict: boolean }> {
  const snapshot = await capture(c, [...ids].sort(), false);
  const main = snapshot.orders.find((o) => o.id === mainOrderId);
  ensure(main, 404, 'Nie znaleziono zamówienia głównego');
  return { conflicts: conflicts(snapshot), receiver_conflict: hasReceiverConflict(snapshot, main) };
}
function physical(s: Snapshot): Row[] {
  const layers = s.custody.layers ?? [];
  return (layers.length ? layers : (s.custody.locations ?? []))
    .filter((r: Row) => r.state === undefined || r.state === 'active')
    .map((r: Row) => ({
      source_order_id: r.order_id,
      product_id: r.product_id,
      warehouse_id: r.warehouse_id,
      location: r.location,
      layer_id: r.layer_id ?? null,
      quantity: r.quantity,
      scanned: r.scanned,
    }));
}
function conflicts(s: Snapshot): string[] {
  const out: string[] = [];
  if (new Set(s.orders.map((o) => o.currency)).size !== 1) out.push('different_currency');
  if (new Set(s.orders.map((o) => o.warehouse_id)).size !== 1) out.push('different_warehouse');
  if (new Set(s.orders.map((o) => o.payment_mode)).size !== 1) out.push('different_payment_mode');
  for (const o of s.orders)
    if (!['new', 'paid', 'picking', 'packed'].includes(o.status))
      out.push('not_pre_fulfillment:' + o.id);
  for (const name of ['shipments', 'documents', 'return_cases'])
    if (s.blockers[name]?.length) out.push('existing_' + name);
  for (const name of [
    'shipping_plans',
    'dpd_shipping_plans',
    'invoice_plans',
    'order_status_plans',
    'odoo_invoice_exports',
    'ebay_fulfillment_plans',
    'amazon_fulfillment_plans',
    'shopify_fulfillment_plans',
  ])
    if (
      s.blockers[name]?.some(
        (p: Row) => p.phase !== 'ready' || ['done', 'dispatched'].includes(p.state),
      )
    )
      out.push('provider_attempt:' + name);
  if (s.blockers.picking_wave_orders?.some((r: Row) => r.active && r.wave_state === 'picking'))
    out.push('active_picking_wave');
  if (s.blockers.packing_sessions?.some((r: Row) => r.state === 'active'))
    out.push('active_packing_session');
  if ((s.custody.reservations ?? []).some((r: Row) => r.state !== 'active'))
    out.push('non_active_reservation');
  return out;
}
function commercial(s: Snapshot): Row[] {
  const origins = new Map(s.origins.map((r) => [r.target_item_id, r]));
  return s.items.map((i, index) => ({
    index,
    source_order_id: i.order_id,
    source_item_id: i.id,
    product_id: i.product_id,
    sku: i.sku,
    name: i.name,
    quantity: i.quantity,
    scanned: i.scanned,
    price: i.price,
    vat: i.vat,
    line_total: i.line_total,
    components: i.components,
    root_source_order_id: origins.get(i.id)?.root_order ?? i.order_id,
    root_source_item_id: origins.get(i.id)?.root_item ?? i.id,
  }));
}
function aggregatePicks(s: Snapshot): Row[] {
  const result = new Map<string, Row>();
  for (const p of s.picks) {
    const previous = result.get(p.product_id);
    if (previous) {
      previous.quantity += p.quantity;
      previous.scanned += p.scanned;
    } else
      result.set(p.product_id, {
        product_id: p.product_id,
        sku: p.sku,
        name: p.name,
        ean: p.ean,
        quantity: p.quantity,
        scanned: p.scanned,
      });
  }
  for (const p of result.values())
    ensure(
      Number.isSafeInteger(p.quantity) && p.quantity <= 2147483647 && p.scanned <= p.quantity,
      422,
      'Łączna ilość fizyczna przekracza obsługiwany zakres',
    );
  return [...result.values()].sort((a, b) => a.product_id.localeCompare(b.product_id));
}
const moneyKeys = new Set([
  'price',
  'line_total',
  'total',
  'total_minor',
  'shipping_cost',
  'payment_balance',
  'received',
  'refunded',
  'net',
  'nominal',
  'amount_due',
  'overpayment',
  'credit',
  'fees',
  'collected',
  'remitted',
  'courier_due',
]);
function project(v: any, value: boolean): any {
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map((x) => project(x, value));
  if (v && typeof v === 'object')
    return Object.fromEntries(
      Object.entries(v)
        .filter(
          ([k]) =>
            ![
              'portal_token',
              'request_hash',
              'api_key_id',
              'byte_count',
              'snapshot',
              'before_snapshot',
              'after_snapshot',
            ].includes(k),
        )
        .map(([k, x]) => [k, !value && moneyKeys.has(k) ? null : project(x, value)]),
    );
  return v;
}
function head(r: Row, x: Access) {
  const value = project(
    Object.fromEntries(
      [
        'id',
        'preview_id',
        'merge_mode',
        'main_order_id',
        'target_order_id',
        'source_count',
        'total',
        'sum_delivery_costs',
        'total_minor',
        'shipping_cost',
        'target_status',
        'payment_balance',
        'receiver_conflict',
        'physical_count',
        'physical_quantity',
        'physical_scanned',
        'scope_hash',
        'ready',
        'conflicts',
        'state',
        'created_at',
        'expires_at',
      ]
        .filter((k) => r[k] !== undefined)
        .map((k) => [k, r[k]]),
    ),
    x.role === 'admin',
  );
  value.total = r.total;
  const main = (r.snapshot ?? r.before_snapshot)?.orders?.find(
    (o: Row) => o.id === r.main_order_id,
  );
  value.currency = main?.currency;
  value.payment_mode = main?.payment_mode;
  return value;
}
function sourceView(o: Row, s: Snapshot, x: Access) {
  const delivery = s.buyer_delivery_frames?.find((f) => f.order_id === o.id);
  const effective_delivery = delivery
    ? projectOrderMergeDeliverySnapshot(o, delivery, localConfig.encryptionKey)
    : null;
  const pay = (s.payments.orders ?? []).find((r: Row) => r.order_id === o.id);
  const picks = s.picks.filter((p) => p.order_id === o.id);
  return project(
    {
      ...Object.fromEntries(
        [
          'id',
          'number',
          'status',
          'version',
          'customer_name',
          'email',
          'address',
          'currency',
          'warehouse_id',
          'payment_mode',
          'total',
          'shipping_cost',
          'source',
          'channel_id',
          'external_id',
          'tags',
          'note',
        ].map((k) => [k, o[k]]),
      ),
      effective_delivery,
      payment_balance: pay?.balance ?? null,
      physical_quantity: picks.reduce((n, r) => n + r.quantity, 0),
      physical_scanned: picks.reduce((n, r) => n + r.scanned, 0),
    },
    x.role === 'admin',
  );
}
/** Historical projection uses only the immutable execution that captured this origin. */
export function orderMergeOriginDeliveryFrames(tenantId:string,origin:Row):OrderMergeDeliveryFrame[]|undefined {
  const parent=origin.parent_snapshot,orders=parent?.orders;
  const uuid=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
  ensure(uuid(origin.execution_id)&&origin.execution_id===origin.parent_execution_id&&Array.isArray(orders)&&orders.length>=2&&orders.length<=100,503,'Niekompletna historia źródła MERGE');
  ensure(orders.every((o:Row)=>o&&uuid(o.id)&&o.tenant_id===tenantId)&&new Set(orders.map((o:Row)=>o.id)).size===orders.length,503,'Obca historia źródła MERGE');
  const source=orders.find((o:Row)=>o.id===origin.header?.id);
  ensure(source&&source.tenant_id===tenantId&&orderMergeHash(source)===orderMergeHash(origin.header),503,'Zmieniony historyczny nagłówek MERGE');
  if(!Object.hasOwn(parent,'buyer_delivery_frames'))return undefined; // explicit pre209 history limit, never current-state fallback
  const frames=parent.buyer_delivery_frames;
  ensure(Array.isArray(frames)&&frames.length===orders.length&&new Set(frames.map((f:Row)=>f?.order_id)).size===orders.length,503,'Niekompletne historyczne adresy MERGE');
  for(const frame of frames){
    const order=orders.find((o:Row)=>o.id===frame?.order_id);ensure(order,503,'Obce historyczne powiązanie adresu MERGE');
    projectOrderMergeDeliverySnapshot(order,frame,localConfig.encryptionKey);
  }
  return frames;
}
function cursor(index: number, bind: unknown) {
  const body = Buffer.from(JSON.stringify({ index, bind: orderMergeHash(bind) })).toString(
    'base64url',
  );
  const signature = createHmac('sha256', localConfig.encryptionKey)
    .update(body)
    .digest('base64url');
  return body + '.' + signature;
}
function page<T>(data: T[], q: S.OrderMergePageQuery, bind: unknown) {
  let index = 0;
  if (q.cursor) {
    const [body, sig, ...rest] = q.cursor.split('.');
    ensure(body && sig && !rest.length, 422, 'Nieprawidłowy kursor');
    const actual = createHmac('sha256', localConfig.encryptionKey).update(body).digest();
    const provided = Buffer.from(sig, 'base64url');
    ensure(
      actual.length === provided.length && timingSafeEqual(actual, provided),
      422,
      'Nieprawidłowy kursor',
    );
    let decoded: Row;
    try {
      decoded = JSON.parse(Buffer.from(body, 'base64url').toString());
    } catch {
      ensure(false, 422, 'Nieprawidłowy kursor');
    }
    ensure(
      decoded.bind === orderMergeHash(bind),
      409,
      'Zakres lub uprawnienia kursora zmieniły się',
    );
    ensure(Number.isInteger(decoded.index) && decoded.index >= 0, 422, 'Nieprawidłowy kursor');
    index = decoded.index;
  }
  const result = data.slice(index, index + q.limit);
  return {
    data: result,
    meta: {
      total: data.length,
      cursor: index + result.length < data.length ? cursor(index + result.length, bind) : null,
    },
  };
}
function bind(a: Actor, x: Access, kind: string, id: string) {
  return { tenant: a.tenantId, actor: a.userId, key: a.apiKeyId ?? null, role: x.role, kind, id };
}
async function early(a: Actor, write: boolean) {
  return tenantTx(
    a.tenantId,
    async (c) => {
      await available(c);
      return access(c, a, write);
    },
    readTx,
  );
}
export async function orderMergeOptions(a: Actor) {
  return tenantTx(
    a.tenantId,
    async (c) => {
      const exists = await orderMergesAvailable(c);
      let x: Access;
      if (exists) x = await access(c, a);
      else {
        const r = (await c.query('SELECT role FROM memberships WHERE user_id=$1', [a.userId]))
          .rows[0]?.role;
        ensure(['admin', 'operator', 'viewer'].includes(r), 403, 'Brak członkostwa');
        if (a.apiKeyId) {
          const k = (
            await c.query(
              'SELECT scopes,revoked_at,expires_at>clock_timestamp() valid FROM api_keys WHERE id=$1 AND user_id=$2',
              [a.apiKeyId, a.userId],
            )
          ).rows[0];
          ensure(k && k.valid && !k.revoked_at, 401, 'Nieaktywny klucz API');
          ensure(
            ['orders:read', 'inventory:read'].every((s) => k.scopes.includes(s)),
            403,
            'Brak scope odczytu',
          );
        }
        x = { role: r, manage: false };
      }
      return {
        ...flags(x),
        available: exists,
        limits: S.ORDER_MERGE_LIMITS,
        modes: ['technical_merge', 'into_main_order'],
      };
    },
    readTx,
  );
}
export async function createOrderMergePreview(a: Actor, input: unknown) {
  const b = S.orderMergePreviewInput.parse(input);
  bounded(b, S.ORDER_MERGE_LIMITS.request_bytes);
  await early(a, true);
  return tenantTx(
    a.tenantId,
    async (c) => {
      await available(c);
      await access(c, a, true, false);
      await admission(c, a);
      const previous = (
        await c.query(
          'SELECT * FROM order_merge_previews WHERE client_key=$1',
          [b.client_key],
        )
      ).rows[0];
      if (previous) {
        ensure(
          previous.request_hash === requestHash(a, b),
          409,
          'Klucz został użyty z inną operacją lub aktorem',
        );
        const x = await access(c, a, true);
        await enlistOrderMergeBuyerAddressActorInTx(
          c,
          a,
          previous.main_order_id,
          localConfig.encryptionKey,
        );
        return { ...flags(x), preview: head(previous, x), reused: true };
      }
      ensure(
        (await c.query('SELECT count(*)::int n FROM order_merge_previews'))
          .rows[0].n < S.ORDER_MERGE_LIMITS.previews,
        429,
        'Limit podglądów łączenia zamówień',
      );
      const ids = [b.main_order_id, ...b.order_ids_to_merge].sort(),
        snapshot = await capture(c, ids, true),
        lineRows = commercial(snapshot),
        phys = physical(snapshot),
        picks = aggregatePicks(snapshot);
      ensure(
        phys.length <= S.ORDER_MERGE_LIMITS.lines,
        422,
        'Przekroczono 10000 alokacji fizycznych',
      );
      bounded(snapshot, S.ORDER_MERGE_LIMITS.preview_bytes);
      const main = snapshot.orders.find((o) => o.id === b.main_order_id)!;
      const issues = conflicts(snapshot);
      const shipping = b.sum_delivery_costs
        ? snapshot.orders.reduce((n, o) => n + BigInt(o.shipping_cost), 0n)
        : BigInt(main.shipping_cost);
      const total = lineRows.reduce(
        (n, i) => n + BigInt(i.line_total),
        shipping,
      );
      ensure(
        total <= 2147483647n && shipping <= 2147483647n,
        422,
        'Łączna wartość przekracza obsługiwany zakres',
      );
      const balance: Row =
        issues.includes('different_currency') ||
        issues.includes('different_payment_mode')
          ? {}
          : await orderMergeCombinedPaymentBalanceInTx(c, ids, {
              total: Number(total),
              currency: main.currency,
              payment_mode: main.payment_mode,
              status: 'new',
            });
      const status = picks.some((p) => p.scanned > 0)
        ? 'picking'
        : main.payment_mode === 'cod' || balance.amount_due === 0
          ? 'paid'
          : 'new';
      const receiverConflict = hasReceiverConflict(snapshot, main);
      await enlistOrderMergeBuyerAddressActorInTx(
        c,
        a,
        main.id,
        localConfig.encryptionKey,
      );
      const id = randomUUID(),
        target = b.merge_mode === 'into_main_order' ? main.id : randomUUID(),
        scope = orderMergeHash({ request: b, snapshot });
      const p = (
        await c.query(
          `INSERT INTO order_merge_previews(id,tenant_id,actor_id,api_key_id,source,client_key,request_hash,request,scope_hash,snapshot,source_ids,main_order_id,target_order_id,merge_mode,sum_delivery_costs,total,source_count,ready,receiver_conflict,conflicts,total_minor,shipping_cost,target_status,payment_balance,physical_count,physical_quantity,physical_scanned,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,clock_timestamp()+interval '15 minutes') RETURNING *`,
          [
            id,
            a.tenantId,
            a.userId,
            a.apiKeyId ?? null,
            a.apiKeyId ? 'api' : 'manual',
            b.client_key,
            requestHash(a, b),
            b,
            scope,
            snapshot,
            ids,
            main.id,
            target,
            b.merge_mode,
            b.sum_delivery_costs,
            lineRows.length,
            ids.length,
            issues.length === 0,
            receiverConflict,
            JSON.stringify(issues),
            Number(total),
            Number(shipping),
            status,
            balance,
            phys.length,
            picks.reduce((n, r) => n + r.quantity, 0),
            picks.reduce((n, r) => n + r.scanned, 0),
          ],
        )
      ).rows[0];
      for (let start = 0; start < lineRows.length; start += 100)
        await c.query(
          `INSERT INTO order_merge_preview_rows(tenant_id,preview_id,index,row) SELECT $1,$2,(r->>'index')::integer,r FROM jsonb_array_elements($3::jsonb) r`,
          [a.tenantId, id, JSON.stringify(lineRows.slice(start, start + 100))],
        );
      await audit(c, a, 'order.merge.preview', id, {
        source_ids: ids,
        scope_hash: scope,
        merge_mode: b.merge_mode,
      });
      await c.query('SET CONSTRAINTS ALL IMMEDIATE');
      const x = await access(c, a, true);
      return { ...flags(x), preview: head(p, x), reused: false };
    },
    writeTx,
  );
}
async function load(c: PoolClient, kind: 'preview' | 'execution', id: string) {
  const r = (
    await c.query(
      `SELECT * FROM order_merge_${kind === 'preview' ? 'previews' : 'executions'} WHERE id=$1`,
      [id],
    )
  ).rows[0];
  ensure(r, 404, 'Nie znaleziono dowodu łączenia zamówień');
  return r;
}
const snap = (r: Row, kind: string): Snapshot =>
  kind === 'preview' ? r.snapshot : r.before_snapshot;
async function detail(a: Actor, id: string, kind: 'preview' | 'execution') {
  return tenantTx(
    a.tenantId,
    async (c) => {
      await available(c);
      const r = await load(c, kind, id),
        x = await access(c, a);
      return bounded({ ...flags(x), [kind]: head(r, x), meta: { total: r.total } });
    },
    readTx,
  );
}
export const orderMergePreviewDetail = (a: Actor, id: string) => detail(a, id, 'preview');
export const orderMergeExecutionDetail = (a: Actor, id: string) => detail(a, id, 'execution');
/** Read the original committed command only. Absence is never evidence of rollback. */
export async function orderMergeOriginalCommand(a: Actor, key: string, operation: 'preview' | 'execute') {
  const clientKey = S.orderMergeExecuteInput.shape.client_key.parse(key);
  ensure(operation === 'preview' || operation === 'execute', 422, 'Nieprawidłowa operacja');
  return tenantTx(a.tenantId, async c => {
    await available(c);
    await access(c, a);
    const table = operation === 'preview' ? 'order_merge_previews' : 'order_merge_executions';
    const r = (await c.query(`SELECT * FROM ${table} WHERE tenant_id=$1 AND client_key=$2`, [a.tenantId, clientKey])).rows[0];
    ensure(r && r.actor_id === a.userId && (r.api_key_id ?? null) === (a.apiKeyId ?? null), 404, 'Nie znaleziono oryginalnego wyniku');
    const request = (operation === 'preview' ? S.orderMergePreviewInput : S.orderMergeExecuteInput).parse(r.request);
    ensure(request.client_key === clientKey && r.request_hash === requestHash(a, request), 409, 'Nie można potwierdzić oryginalnej komendy');
    const x = await access(c, a);
    return bounded({...flags(x), operation, client_key: clientKey, actor_id: a.userId, api_key_id: a.apiKeyId ?? null,
      request, [operation === 'preview' ? 'preview' : 'execution']: head(r, x), meta: {total: r.total}});
  }, readTx);
}
async function collection(
  a: Actor,
  id: string,
  kind: 'preview' | 'execution',
  type: 'rows' | 'sources' | 'physical',
  query: unknown = {},
) {
  const q = S.orderMergePageQuery.parse(query);
  return tenantTx(
    a.tenantId,
    async (c) => {
      await available(c);
      const r = await load(c, kind, id),
        snapshot = snap(r, kind);
      let data: Row[];
      if (type === 'rows')
        data = (
          await c.query(
            `SELECT row${kind === 'execution' ? ',target_item_id' : ''} FROM order_merge_${kind === 'preview' ? 'preview' : 'execution'}_rows WHERE ${kind === 'preview' ? 'preview_id' : 'execution_id'}=$1 ORDER BY index`,
            [id],
          )
        ).rows.map((z) => ({
          ...z.row,
          ...(z.target_item_id ? { target_item_id: z.target_item_id } : {}),
        }));
      else data = type === 'sources' ? snapshot.orders : physical(snapshot);
      const x = await access(c, a);
      if (type === 'sources') data = data.map((o) => sourceView(o, snapshot, x));
      else if (type === 'rows')
        data = data.map((row) => {
          const value = project(row, x.role === 'admin');
          value.quantity = row.quantity;
          value.scanned = row.scanned;
          return value;
        });
      return bounded({ ...flags(x), ...page(data, q, bind(a, x, kind + ':' + type, id)) });
    },
    readTx,
  );
}
export const orderMergePreviewRows = (a: Actor, id: string, q?: unknown) =>
  collection(a, id, 'preview', 'rows', q);
export const orderMergePreviewSources = (a: Actor, id: string, q?: unknown) =>
  collection(a, id, 'preview', 'sources', q);
export const orderMergePreviewPhysical = (a: Actor, id: string, q?: unknown) =>
  collection(a, id, 'preview', 'physical', q);
export const orderMergeExecutionRows = (a: Actor, id: string, q?: unknown) =>
  collection(a, id, 'execution', 'rows', q);
export const orderMergeExecutionSources = (a: Actor, id: string, q?: unknown) =>
  collection(a, id, 'execution', 'sources', q);
export const orderMergeExecutionPhysical = (a: Actor, id: string, q?: unknown) =>
  collection(a, id, 'execution', 'physical', q);
export async function executeOrderMerge(a: Actor, input: unknown) {
  const b = S.orderMergeExecuteInput.parse(input);
  await early(a, true);
  return tenantTx(
    a.tenantId,
    async (c) => {
      await available(c);
      await access(c, a, true, false);
      await admission(c, a);
      const prior = (
        await c.query(
          'SELECT * FROM order_merge_executions WHERE client_key=$1',
          [b.client_key],
        )
      ).rows[0];
      if (prior) {
        ensure(
          prior.request_hash === requestHash(a, b),
          409,
          'Klucz został użyty z inną operacją lub aktorem',
        );
        const x = await access(c, a, true);
        await enlistOrderMergeBuyerAddressActorInTx(
          c,
          a,
          prior.target_order_id,
          localConfig.encryptionKey,
        );
        return { ...flags(x), execution: head(prior, x), reused: true };
      }
      const p = await load(c, 'preview', b.preview_id);
      ensure(
        p.actor_id === a.userId &&
          (p.api_key_id ?? null) === (a.apiKeyId ?? null),
        403,
        'Podgląd należy do innego aktora',
      );
      ensure(p.ready, 409, 'Podgląd zawiera nierozwiązane konflikty');
      ensure(p.scope_hash === b.scope_hash, 409, 'Zatwierdzono inny zakres');
      ensure(
        !p.receiver_conflict || b.confirmed_receiver_selection === true,
        422,
        'Potwierdź jawnie wybór odbiorcy zamówienia głównego',
      );
      ensure(
        (
          await c.query(
            'SELECT expires_at>clock_timestamp() valid FROM order_merge_previews WHERE id=$1',
            [p.id],
          )
        ).rows[0].valid,
        409,
        'Podgląd wygasł',
      );
      ensure(
        !(
          await c.query(
            'SELECT 1 FROM order_merge_executions WHERE preview_id=$1',
            [p.id],
          )
        ).rowCount,
        409,
        'Podgląd już wykonano z innym kluczem',
      );
      ensure(
        (await c.query('SELECT count(*)::int n FROM order_merge_executions'))
          .rows[0].n < S.ORDER_MERGE_LIMITS.executions,
        429,
        'Limit historii łączenia zamówień',
      );
      const snapshot = await capture(c, p.source_ids, true);
      ensure(
        orderMergeHash({ request: p.request, snapshot }) === p.scope_hash,
        409,
        'Nagłówki, płatności lub alokacje zmieniły się; przygotuj nowy podgląd',
      );
      const executionId = randomUUID(),
        target = p.target_order_id,
        main = snapshot.orders.find((o) => o.id === p.main_order_id)!,
        lineRows = commercial(snapshot),
        picks = aggregatePicks(snapshot);
      enlistWmsActorInTx(c, a, { orders: true, adminOnly: true });
      for (const o of snapshot.orders)
        await c.query(
          `INSERT INTO order_merge_origins(tenant_id,order_id,header,items,execution_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT(tenant_id,order_id) DO NOTHING`,
          [
            a.tenantId,
            o.id,
            o,
            JSON.stringify(snapshot.items.filter((i) => i.order_id === o.id)),
            executionId,
          ],
        );
      if (p.merge_mode === 'technical_merge') {
        // Copy the full business header, then replace only new local identity and derived totals/state.
        const columns = (
          await c.query(
            `SELECT attname FROM pg_attribute WHERE attrelid='orders'::regclass AND attnum>0 AND NOT attisdropped AND attgenerated='' ORDER BY attnum`,
          )
        ).rows.map((r) => r.attname as string);
        const header = {
          ...main,
          id: target,
          number: 'MERGE-' + randomBytes(6).toString('hex').toUpperCase(),
          source: 'order_merge',
          external_id: null,
          channel_id: null,
          source_snapshot: null,
          portal_token: randomBytes(24).toString('hex'),
          version: '1',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          status: p.target_status,
          workflow_status_id: null,
          total: p.total_minor,
          shipping_cost: p.shipping_cost,
        };
        const identifiers = columns
          .map((name) => '"' + name.replaceAll('"', '""') + '"')
          .join(',');
        await c.query(
          `INSERT INTO orders(${identifiers}) SELECT ${identifiers} FROM jsonb_populate_record(NULL::orders,$1::jsonb)`,
          [JSON.stringify(header)],
        );
      } else
        await c.query(
          'UPDATE orders SET total=$2,shipping_cost=$3,status=$4,workflow_status_id=NULL,updated_at=clock_timestamp() WHERE id=$1',
          [target, p.total_minor, p.shipping_cost, p.target_status],
        );
      const targetRows: Row[] = [];
      for (const row of lineRows) {
        const id =
          p.merge_mode === 'into_main_order' && row.source_order_id === target
            ? row.source_item_id
            : randomUUID();
        targetRows.push({ ...row, target_item_id: id });
      }
      for (let start = 0; start < targetRows.length; start += 100) {
        const batch = targetRows
          .slice(start, start + 100)
          .filter(
            (r) =>
              !(
                p.merge_mode === 'into_main_order' &&
                r.source_order_id === target
              ),
          );
        if (batch.length)
          await c.query(
            `INSERT INTO order_items(id,tenant_id,order_id,product_id,sku,name,quantity,scanned,price,vat,line_total,components)
      SELECT (r->>'target_item_id')::uuid,$1,$2,(r->>'product_id')::uuid,r->>'sku',r->>'name',(r->>'quantity')::integer,(r->>'scanned')::integer,(r->>'price')::integer,(r->>'vat')::integer,(r->>'line_total')::integer,r->'components' FROM jsonb_array_elements($3::jsonb) r`,
            [a.tenantId, target, JSON.stringify(batch)],
          );
      }
      for (let start = 0; start < picks.length; start += 100)
        await c.query(
          `INSERT INTO order_pick_items(id,tenant_id,order_id,product_id,sku,name,ean,quantity,scanned)
      SELECT gen_random_uuid(),$1,$2,(r->>'product_id')::uuid,r->>'sku',r->>'name',r->>'ean',(r->>'quantity')::integer,(r->>'scanned')::integer FROM jsonb_array_elements($3::jsonb) r
      ON CONFLICT(tenant_id,order_id,product_id) DO UPDATE SET quantity=EXCLUDED.quantity,scanned=EXCLUDED.scanned`,
          [a.tenantId, target, JSON.stringify(picks.slice(start, start + 100))],
        );
      const targetHeader = (
        await c.query('SELECT to_jsonb(o) row FROM orders o WHERE id=$1', [
          target,
        ])
      ).rows[0].row;
      assertSaleFinancialKind(targetHeader);
      const after = { target: targetHeader, items: targetRows, picks };
      bounded(after, S.ORDER_MERGE_LIMITS.preview_bytes);
      const e = (
        await c.query(
          `INSERT INTO order_merge_executions(id,tenant_id,preview_id,actor_id,api_key_id,source,client_key,request_hash,request,scope_hash,source_ids,main_order_id,target_order_id,merge_mode,sum_delivery_costs,total,source_count,receiver_conflict,total_minor,shipping_cost,target_status,payment_balance,physical_count,physical_quantity,physical_scanned,before_snapshot,after_snapshot)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27) RETURNING *`,
          [
            executionId,
            a.tenantId,
            p.id,
            a.userId,
            a.apiKeyId ?? null,
            a.apiKeyId ? 'api' : 'manual',
            b.client_key,
            requestHash(a, b),
            b,
            p.scope_hash,
            p.source_ids,
            p.main_order_id,
            target,
            p.merge_mode,
            p.sum_delivery_costs,
            p.total,
            p.source_count,
            p.receiver_conflict,
            p.total_minor,
            p.shipping_cost,
            p.target_status,
            p.payment_balance,
            p.physical_count,
            p.physical_quantity,
            p.physical_scanned,
            snapshot,
            after,
          ],
        )
      ).rows[0];
      if (p.merge_mode === 'technical_merge') {
        // The 209 inheritance checks the local role itself and raises 40001 on a change. An administrator withdrawn
        // during the stock wait is refused here as by the final grant (403), not as an unexpected database error.
        await access(c, a, true);
        const delivery = snapshot.buyer_delivery_frames?.find(
          (f) => f.order_id === main.id,
        );
        ensure(
          delivery,
          409,
          'Podgląd nie zawiera dowodu adresu; przygotuj nowy podgląd',
        );
        await inheritOrderMergeBuyerAddressInTx(
          c,
          a,
          {
            tenant_id: a.tenantId,
            execution_id: executionId,
            merge_preview_id: p.id,
            scope_hash: p.scope_hash,
            source: {
              order: main,
              state: delivery.state,
              buyer_basis_hash: delivery.buyer_basis_hash,
            },
            target_order_id: target,
          },
          localConfig.encryptionKey,
        );
      } else
        await enlistOrderMergeBuyerAddressActorInTx(
          c,
          a,
          target,
          localConfig.encryptionKey,
        );
      const transfer = {
        execution_id: executionId,
        source_order_ids: p.source_ids,
        target_order_id: target,
        merge_mode: p.merge_mode,
      };
      await transferOrderMergeCustodyInTx(c, a, transfer);
      const balance = await transferOrderMergeFinanceInTx(c, a, transfer);
      ensure(
        orderMergeHash(balance) === orderMergeHash(p.payment_balance),
        409,
        'Saldo docelowe różni się od zatwierdzonego podglądu',
      );
      const claimIds = p.source_ids.filter((id: string) => id !== target);
      await c.query(
        `INSERT INTO order_merge_claims(tenant_id,source_order_id,target_order_id,execution_id,merge_mode) SELECT $1,id,$2,$3,$4 FROM unnest($5::uuid[]) id`,
        [a.tenantId, target, executionId, p.merge_mode, claimIds],
      );
      ensure(
        orderMergeHash(
          await effectiveOrderMergePaymentBalanceInTx(c, target),
        ) === orderMergeHash(p.payment_balance),
        409,
        'Przejęcie źródeł zmieniło saldo',
      );
      for (let start = 0; start < targetRows.length; start += 100)
        await c.query(
          `INSERT INTO order_merge_execution_rows(tenant_id,execution_id,preview_id,index,row,target_item_id)
      SELECT $1,$2,$3,(r->>'index')::integer,r-'target_item_id',(r->>'target_item_id')::uuid FROM jsonb_array_elements($4::jsonb) r`,
          [
            a.tenantId,
            executionId,
            p.id,
            JSON.stringify(targetRows.slice(start, start + 100)),
          ],
        );
      await localOrderEvent(c, a.tenantId, target, 'order.merged', {
        execution_id: executionId,
        source_ids: p.source_ids,
        merge_mode: p.merge_mode,
      });
      await audit(c, a, 'order.merge.execute', executionId, {
        preview_id: p.id,
        target_order_id: target,
        source_ids: p.source_ids,
        scope_hash: p.scope_hash,
      });
      await c.query('SET CONSTRAINTS ALL IMMEDIATE');
      const x = await access(c, a, true);
      return bounded({ ...flags(x), execution: head(e, x), reused: false });
    },
    writeTx,
  );
}
export async function orderMergeHistory(a: Actor, query: unknown = {}) {
  const q = S.orderMergeHistoryQuery.parse(query);
  return tenantTx(
    a.tenantId,
    async (c) => {
      await available(c);
      const data = (
        await c.query(
          `SELECT * FROM (SELECT 'preview' kind,to_jsonb(p) value FROM order_merge_previews p UNION ALL SELECT 'execution',to_jsonb(e) FROM order_merge_executions e) x ORDER BY value->>'created_at' DESC,value->>'id' DESC,kind`,
        )
      ).rows;
      const x = await access(c, a);
      const result = page(data, q, bind(a, x, 'history', 'all'));
      return bounded({
        ...flags(x),
        data: result.data.map((r) => ({ kind: r.kind, ...head(r.value, x) })),
        meta: result.meta,
      });
    },
    readTx,
  );
}
export async function orderMergeLineage(a: Actor, orderId: string) {
  return tenantTx(
    a.tenantId,
    async (c) => {
      await available(c);
      ensure(
        (await c.query('SELECT 1 FROM orders WHERE id=$1', [orderId])).rowCount,
        404,
        'Nie znaleziono zamówienia',
      );
      const claims = (
        await c.query(
          `WITH RECURSIVE chain AS (SELECT c.*,1 depth FROM order_merge_claims c WHERE source_order_id=$1 UNION ALL SELECT c.*,x.depth+1 FROM order_merge_claims c JOIN chain x ON c.source_order_id=x.target_order_id) SELECT source_order_id,target_order_id,execution_id,merge_mode FROM chain ORDER BY depth`,
          [orderId],
        )
      ).rows;
      const original = (
        await c.query(`SELECT o.header,o.items,o.execution_id,e.id parent_execution_id,e.before_snapshot parent_snapshot
          FROM order_merge_origins o LEFT JOIN order_merge_executions e ON(e.tenant_id,e.id)=(o.tenant_id,o.execution_id) WHERE o.order_id=$1`, [orderId])
      ).rows[0];
      // Birth of a technical owner is independent of its later outgoing claim.
      // Only immutable source identity/number is public, never the raw header.
      const birth = (
        await c.query(
          `SELECT id,merge_mode,created_at,main_order_id,
        before_snapshot->'orders' AS sources FROM order_merge_executions
        WHERE target_order_id=$1 AND merge_mode='technical_merge'
        ORDER BY created_at,id LIMIT 1`,
          [orderId],
        )
      ).rows[0];
      const x = await access(c, a);
      const createdBy = birth
        ? project(
            {
              id: birth.id,
              merge_mode: birth.merge_mode,
              created_at: birth.created_at,
              main_order_id: birth.main_order_id,
              sources: birth.sources.map((source: Row) => ({
                id: source.id,
                number: source.number,
              })),
            },
            x.role === 'admin',
          )
        : null;
      const originDeliveryFrames=original?orderMergeOriginDeliveryFrames(a.tenantId,original):undefined;
      const safeOrigin = original
        ? {
            header: sourceView(
              original.header,
              {
                orders: [],
                items: [],
                picks: [],
                origins: [],
                blockers: {},
                payments: { orders: [] },
                custody: {},
                buyer_delivery_frames: originDeliveryFrames,
              },
              x,
            ),
            items: original.items.map((i: Row) =>
              project(
                Object.fromEntries(
                  [
                    'id',
                    'order_id',
                    'product_id',
                    'sku',
                    'name',
                    'quantity',
                    'scanned',
                    'price',
                    'vat',
                    'line_total',
                    'components',
                  ].map((k) => [k, i[k]]),
                ),
                x.role === 'admin',
              ),
            ),
          }
        : null;
      return bounded({
        ...flags(x),
        order_id: orderId,
        owner_order_id: claims.at(-1)?.target_order_id ?? orderId,
        closed_source: claims.length > 0,
        claims,
        created_by: createdBy,
        origin: safeOrigin,
      });
    },
    readTx,
  );
}
