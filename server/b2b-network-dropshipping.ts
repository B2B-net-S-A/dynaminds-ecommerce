import {
  b2bExternalIntentStateInTx,
  b2bExternalIntentAssertInTx,
} from './b2b-external-order-intent-guards';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { audit, createOrder, cancelOrder, orderSchema, event, type Actor } from './domain';
import { ensure, Problem } from './errors';
import { networkTx, networkScope as scope, networkLink, networkSource, networkEnlistActorInTx } from './b2b-network';
import { networkCatalogLocks } from './b2b-network-orders';
import { productCatalogsAvailable } from './product-catalogs';
import {
  guardB2BCatalogPairInTx,
  assertB2BCatalogProductsInTx,
  assertB2BBuyerCatalogItemsInTx,
  b2bCatalogScopeMetadataPresent,
  type B2BCatalogPair,
} from './b2b-catalog-scope-adapters';
import { quoteB2b } from './b2b';
import { prices } from './pricing';
import { paymentBalance } from './payments';
import { chargeTradeCreditInTx } from './b2b-trade-credit';
import { wmsLotsHash } from './wms-lots';
import { assertCatalogExportAccess } from './catalog-export';
import { b2bDropshipOrderScopeInTx } from './b2b-dropship-guards';
import * as S from './b2b-network-dropshipping-schema';
import { unboundItemIdsInTx } from './b2b-network-mappings';
import { copyDropshipTrackingInTx, dropshipTrackingInTx } from './b2b-network-tracking';
export * from './b2b-network-dropshipping-schema';
export { registerB2bNetworkDropshippingRoutes } from './b2b-network-dropshipping-routes';
type Row = Record<string, any>;
const readScopes = ['products:read', 'inventory:read', 'orders:read', 'purchasing:read'];
export async function b2bNetworkDropshippingAvailable(c: Pool | PoolClient) {
  return Boolean(
    (
      await c.query(`SELECT bool_and(to_regclass('public.'||name) IS NOT NULL) AND
 to_regprocedure('public.b2b_dropship_transfer_custody(uuid,uuid)') IS NOT NULL AND
 to_regprocedure('public.b2b_dropship_fulfillment(uuid)') IS NOT NULL available
 FROM unnest(ARRAY['b2b_dropship_quotes','b2b_dropship_orders','b2b_dropship_lines','b2b_dropship_actions','b2b_dropship_supplier_orders','b2b_dropship_custody_transfers','b2b_dropship_created_orders']) name`)
    ).rows[0].available,
  );
}
export async function b2bDropshipAccessInTx(c: PoolClient, a: Actor, write = false, pin = false) {
  const role = (await c.query('SELECT b2b_dropship_current_role($1,$2) role', [a.userId, pin]))
    .rows[0].role;
  ensure(
    ['admin', 'operator', 'viewer'].includes(role),
    403,
    'Brak aktualnego członkostwa w firmie',
  );
  ensure(!write || role === 'admin', 403, 'Dropshipping zatwierdza bieżący administrator');
  let canManage = role === 'admin';
  if (a.apiKeyId) {
    const grant = (
      await c.query('SELECT b2b_dropship_key_grant($1,$2,$3,$4) AS grant_result', [
        a.userId,
        a.apiKeyId,
        write,
        pin,
      ])
    ).rows[0].grant_result;
    ensure(grant !== 'invalid', 401, 'Klucz API został cofnięty lub wygasł');
    ensure(grant === 'ok', 403, 'Brak bieżących uprawnień do dropshippingu');
    if (!write)
      canManage =
        canManage &&
        (
          await c.query('SELECT b2b_dropship_key_grant($1,$2,true,false) AS grant_result', [
            a.userId,
            a.apiKeyId,
          ])
        ).rows[0].grant_result === 'ok';
  }
  return {
    available: true,
    read_only: false,
    current_role: role,
    can_read: true,
    can_manage: canManage,
    can_read_value: role === 'admin',
  };
}
export function b2bDropshipProject(value: any, canValue: boolean): any {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((v) => b2bDropshipProject(v, canValue));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(([k]) => canValue || (!k.endsWith('_minor') && k !== 'payment_balance'))
        .map(([k, v]) => [k, b2bDropshipProject(v, canValue)]),
    );
  return value;
}
async function run<T>(
  a: Actor,
  linkId: string,
  write: boolean,
  fn: (c: PoolClient, l: Row) => Promise<T>,
) {
  try {
    return await networkTx(a.tenantId, async (c) => {
      await c.query("SET LOCAL TIME ZONE 'UTC'");
      ensure(await b2bNetworkDropshippingAvailable(c), 503, 'Ta kopia nie obsługuje dropshippingu');
      await b2bDropshipAccessInTx(c, a, write);
      networkEnlistActorInTx(c, a, write, [...readScopes,
        ...(write ? ['inventory:write', 'orders:write', 'purchasing:write'] : [])]);
      if (write)
        await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          'b2b.dropship.proof:' + a.tenantId,
        ]);
      // Historical receipt/cancel paths need the original graph even after
      // a first catalog configuration. Lock derived tenants without reframing
      // that graph, before networkLink's FOR UPDATE and all business rows.
      const ref = (await c.query('SELECT supplier_tenant_id,account_id FROM b2b_links WHERE tenant_id=$1 AND id=$2', [a.tenantId, linkId])).rows[0];
      ensure(ref, 404, 'Nie znaleziono własnego połączenia');
      await networkCatalogLocks(c, [a.tenantId, ref.supplier_tenant_id]);
      const l = await networkLink(c, linkId);
      ensure(l.supplier_tenant_id === ref.supplier_tenant_id && l.account_id === ref.account_id,
        409, 'Połączenie zmieniło się podczas blokowania katalogów');
      const result = await fn(c, l);
      await scope(c, a.tenantId);
      if (write) await c.query('SET CONSTRAINTS ALL IMMEDIATE');
      const flags = await b2bDropshipAccessInTx(c, a, write, true);
      return { ...b2bDropshipProject(result, flags.can_read_value), ...flags };
    });
  } catch (error) {
    const e = error as { code?: string; message?: string };
    if (
      e.code === '23514' &&
      [
        'Brak aktualnej zgody administratora',
        'Brak aktualnego zatwierdzenia operacji',
        'Brak zatwierdzonego anulowania',
      ].includes(e.message ?? '')
    )
      throw new Problem(403, 'Administrator utracił bieżące uprawnienia');
    if (
      e.code === '23514' &&
      [
        'Zmiana narusza zeskanowany lub dostępny zapas',
        'Nie można przywrócić rezerwacji w pierwotnym miejscu',
        'Dropshipping przekracza nieskompletowaną rezerwację',
        'Rezerwacje zmieniły się od wyceny',
      ].includes(e.message ?? '')
    )
      throw new Problem(409, e.message!);
    if (
      e.code === 'P0001' &&
      ['Limit historii dropshippingu', 'Limit rozmiaru historii dropshippingu'].includes(
        e.message ?? '',
      )
    )
      throw new Problem(429, e.message!);
    throw error;
  }
}
const hash = (a: Actor, kind: string, parent: string, body: unknown) =>
  wmsLotsHash({
    tenant_id: a.tenantId,
    actor_id: a.userId,
    api_key_id: a.apiKeyId ?? null,
    kind,
    parent,
    body,
  });
async function keyAvailable(c: PoolClient, key: string, table: string) {
  const matches = (
    await c.query(
      `SELECT 'quotes' kind FROM b2b_dropship_quotes WHERE client_key=$1 UNION ALL SELECT 'orders' FROM b2b_dropship_orders WHERE client_key=$1 UNION ALL SELECT 'actions' FROM b2b_dropship_actions WHERE client_key=$1`,
      [key],
    )
  ).rows;
  ensure(
    matches.every((r) => r.kind === table),
    409,
    'Klucz próby należy do innej operacji dropshippingu',
  );
}
function balance(v: Row) {
  return Object.fromEntries(
    [
      'currency',
      'payment_mode',
      'received',
      'refunded',
      'credit',
      'nominal',
      'net',
      'amount_due',
      'overpayment',
      'collected',
      'remitted',
      'fees',
      'courier_due',
    ].map((k) => [k, k === 'currency' || k === 'payment_mode' ? v[k] : String(v[k])]),
  );
}
async function customer(c: PoolClient, id: string) {
  const o = (await c.query('SELECT to_jsonb(o) header FROM orders o WHERE id=$1 FOR UPDATE', [id]))
    .rows[0]?.header;
  ensure(o, 404, 'Nie znaleziono własnego zamówienia klienta');
  ensure(
    ['new', 'paid', 'picking', 'packed'].includes(o.status),
    409,
    'Wybierz niewydane zamówienie klienta',
  );
  ensure(
    !(await c.query('SELECT 1 FROM order_merge_claims WHERE source_order_id=$1', [id])).rowCount,
    409,
    'Źródło scalenia nie jest aktywnym właścicielem realizacji',
  );
  ensure(
    !(
      await c.query(
        'SELECT 1 FROM shipments WHERE order_id=$1 UNION ALL SELECT 1 FROM return_cases WHERE order_id=$1 LIMIT 1',
        [id],
      )
    ).rowCount,
    409,
    'Zamówienie ma już wysyłkę lub sprawę zwrotową',
  );
  ensure(
    !(
      await c.query(
        "SELECT 1 FROM picking_wave_orders wo JOIN picking_waves w ON(w.tenant_id,w.id)=(wo.tenant_id,wo.wave_id) WHERE wo.order_id=$1 AND w.state='picking' UNION ALL SELECT 1 FROM packing_sessions WHERE order_id=$1 AND state='active' LIMIT 1",
        [id],
      )
    ).rowCount,
    409,
    'Najpierw zakończ aktywną falę lub sesję pakowania',
  );
  const items = (
    await c.query(
      'SELECT to_jsonb(i) row FROM order_items i WHERE order_id=$1 ORDER BY id FOR UPDATE',
      [id],
    )
  ).rows.map((r) => r.row);
  ensure(items.length <= 100, 413, 'Dropshipping obsługuje do 100 pozycji zamówienia klienta');
  return { o, items };
}
async function mappings(c: PoolClient, l: Row, productIds: string[]) {
  const data = (
    await c.query(
      `SELECT to_jsonb(ci) row FROM b2b_catalog_items ci WHERE ci.link_id=$1 AND ci.product_id=ANY($2::uuid[]) AND ci.published ORDER BY ci.product_id,ci.id LIMIT 10001 FOR SHARE`,
      [l.id, productIds],
    )
  ).rows.map((r) => r.row);
  ensure(data.length <= 10000, 413, 'Zbyt wiele mapowań składników; zawęź katalog dostawcy');
  // 251 (B2B-003): an unbound offer is not a mapping.
  const unbound = await unboundItemIdsInTx(c, data.map((m) => m.id));
  return unbound.size ? data.filter((m) => !unbound.has(m.id)) : data;
}
async function catalogPair(c: PoolClient, a: Actor, l: Row, expected?: B2BCatalogPair): Promise<B2BCatalogPair | null> {
  if (await productCatalogsAvailable(c))
    return guardB2BCatalogPairInTx(c, { tenantId: a.tenantId, linkId: l.id, ...(expected ? { expected } : {}) });
  // A genuine older copy has neither module. An installed/partial scope on
  // missing catalogs is torn metadata, never an unrestricted consumer path.
  ensure(!(await b2bCatalogScopeMetadataPresent(c)) && !expected, 503, 'Zakres B2B wymaga kompletnych katalogów produktów');
  return null;
}
async function sourceData(c: PoolClient, l: Row, id: string, pair: B2BCatalogPair | null) {
  const { o, items } = await customer(c, id);
  const ids = [
    ...new Set<string>(items.flatMap((i) => i.components.map((x: Row) => x.product_id))),
  ].sort();
  ensure(ids.length <= 10000, 413, 'Za dużo składników fizycznych');
  // Historical commercial rows and their frozen physical recipe must share
  // the selected buyer pool. Check every bounded chunk; never truncate it.
  const ownIds = [...new Set<string>([...ids, ...items.map(i => i.product_id).filter(Boolean)])];
  if (pair) for (let offset = 0; offset < ownIds.length; offset += 500)
    await assertB2BCatalogProductsInTx(c, pair.buyer, ownIds.slice(offset, offset + 500));
  const products = (
    await c.query(
      'SELECT id,sku,name,active,kind FROM products WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE',
      [ids],
    )
  ).rows;
  const ps = new Map(products.map((p) => [p.id, p]));
  const choices = await mappings(c, l, ids);
  const committed = (
    await c.query(
      `SELECT customer_item_id,sum(quantity)::int quantity FROM b2b_dropship_lines li JOIN b2b_dropship_orders d ON(d.tenant_id,d.id)=(li.tenant_id,li.order_id) WHERE li.customer_order_id=$1 AND d.state='ordered' GROUP BY customer_item_id`,
      [id],
    )
  ).rows;
  const quantities = new Map(committed.map((r) => [r.customer_item_id, r.quantity]));
  const intent = await b2bExternalIntentStateInTx(c, id);
  const receiver = { customer_name: o.customer_name, email: o.email, address: o.address };
  return {
    o,
    items,
    products,
    choices,
    receiver,
    intent,
    public: {
      id: o.id,
      ...(intent ? { fulfillment_basis: 'external_intent', intent_version: intent.version } : {}),
      number: o.number,
      version: String(o.version),
      status: o.status,
      currency: o.currency,
      receiver,
      retail: {
        currency: o.currency,
        total_minor: String(o.total),
        shipping_minor: String(o.shipping_cost),
        payment_mode: o.payment_mode,
        payment_balance: balance(await paymentBalance(c, id)),
      },
      lines: items.map((i) => ({
        customer_item_id: i.id,
        product_id: i.product_id,
        sku: i.sku,
        name: i.name,
        quantity: i.quantity,
        scanned: i.scanned,
        committed_quantity: quantities.get(i.id) ?? 0,
        remaining_quantity: intent
          ? Math.max(
              0,
              (intent.items.find((x) => x.customer_item_id === i.id && x.link_id === l.id)
                ?.external_quantity ?? 0) - (quantities.get(i.id) ?? 0),
            )
          : Math.max(0, i.quantity - i.scanned - (quantities.get(i.id) ?? 0)),
        currency: o.currency,
        vat: i.vat,
        unit_price_minor: String(i.price),
        line_total_minor: String(i.line_total),
        components: i.components.map((x: Row) => ({
          product_id: x.product_id,
          sku: ps.get(x.product_id)?.sku ?? '',
          name: ps.get(x.product_id)?.name ?? '',
          quantity: x.quantity,
          mappings: choices
            .filter((ci) => ci.product_id === x.product_id)
            .map((ci) => ({
              catalog_item_id: ci.id,
              source_product_id: ci.source_product_id,
              sku: ci.snapshot.sku,
              name: ci.snapshot.name,
              version: ci.version,
            })),
        })),
      })),
    },
  };
}
function quoteView(q: Row, currentOrderId: string | null = null, a?: Actor) {
  const s = q.snapshot;
  return {
    id: q.id,
    customer_order_id: q.customer_order_id,
    customer_number: s.customer_header.number,
    scope_hash: q.scope_hash,
    expires_at: q.expires_at,
    created_at: q.created_at,
    receiver: s.receiver,
    retail: s.retail,
    wholesale: s.wholesale,
    items: s.items.map((i: Row) => ({
      ...i,
      mappings: i.mappings.map((m: Row) => ({
        ...m,
        ...s.mapping_snapshot.find(
          (x: Row) => x.customer_item_id === i.customer_item_id && x.product_id === m.product_id,
        )?.labels,
      })),
    })),
    ready: true,
    blockers: [],
    current_order_id: currentOrderId,
    can_checkout:
      (!a || (q.actor_id === a.userId && q.api_key_id === (a.apiKeyId ?? null))) &&
      !currentOrderId &&
      new Date(q.expires_at).getTime() > Date.now(),
  };
}
async function ownQuote(c: PoolClient, l: Row, id: string) {
  const q = (
    await c.query('SELECT * FROM b2b_dropship_quotes WHERE link_id=$1 AND id=$2', [l.id, id])
  ).rows[0];
  ensure(q, 404, 'Nie znaleziono wyceny dropshippingu');
  return q;
}
async function ownDrop(c: PoolClient, l: Row, id: string, lock = false) {
  const d = (
    await c.query(
      'SELECT * FROM b2b_dropship_orders WHERE link_id=$1 AND id=$2' + (lock ? ' FOR UPDATE' : ''),
      [l.id, id],
    )
  ).rows[0];
  ensure(d, 404, 'Nie znaleziono dostawy dropshippingowej');
  return d;
}
async function orderView(c: PoolClient, a: Actor, d: Row) {
  await scope(c, a.tenantId);
  const q = (await c.query('SELECT * FROM b2b_dropship_quotes WHERE id=$1', [d.quote_id])).rows[0];
  const reconciled = Boolean(
    (
      await c.query("SELECT 1 FROM b2b_dropship_actions WHERE order_id=$1 AND kind='reconcile'", [
        d.id,
      ])
    ).rowCount,
  );
  const scopeData = await b2bDropshipOrderScopeInTx(c, d.customer_order_id);
  await scope(c, d.supplier_tenant_id);
  const supplier = (
    await c.query('SELECT id,number,status,customer_name,email,address FROM orders WHERE id=$1', [
      d.supplier_order_id,
    ])
  ).rows[0];
  ensure(supplier, 409, 'Brak powiązanego zamówienia dostawcy');
  const shipments = (
    await c.query(
      'SELECT carrier,tracking_number,status,mode,dispatched_at FROM shipments WHERE order_id=$1 ORDER BY id',
      [supplier.id],
    )
  ).rows;
  const payment = balance(await paymentBalance(c, supplier.id));
  await scope(c, a.tenantId);
  const local = (
    await c.query(
      "SELECT coalesce(sum(quantity),0)::int quantity FROM reservations WHERE order_id=$1 AND state='active'",
      [d.customer_order_id],
    )
  ).rows[0].quantity;
  const customerStatus = (
    await c.query('SELECT status FROM orders WHERE id=$1', [d.customer_order_id])
  ).rows[0]?.status;
  const retailBalance = await paymentBalance(c, d.customer_order_id);
  const intent = await b2bExternalIntentStateInTx(c, d.customer_order_id);
  // 251 (B2B-005): supplier parcel numbers copied to the customer order.
  const customerTracking = await dropshipTrackingInTx(c, { id: d.id, tenant_id: d.tenant_id });
  const intentReady =
    !intent ||
    (intent.state === 'open' &&
      intent.unassigned_quantity === 0 &&
      intent.uncommitted_quantity === 0 &&
      intent.items.every((i) => i.dispatched_quantity === i.external_quantity));
  return {
    id: d.id,
    quote_id: d.quote_id,
    customer_order_id: d.customer_order_id,
    customer_number: q.snapshot.customer_header.number,
    supplier_order_id: d.supplier_order_id,
    supplier_number: supplier.number,
    version: d.version,
    state: d.state,
    ...(q.snapshot.fulfillment_basis
      ? {
          fulfillment_basis: q.snapshot.fulfillment_basis,
          intent_version: q.snapshot.intent_snapshot.version,
        }
      : {}),
    receiver: q.snapshot.receiver,
    retail: { ...q.snapshot.retail, payment_balance: balance(retailBalance) },
    wholesale: q.snapshot.wholesale,
    items: quoteView(q).items,
    created_at: d.created_at,
    cancelled_at: d.cancelled_at,
    can_cancel:
      d.state === 'ordered' &&
      !shipments.some((s) => s.dispatched_at) &&
      !['shipped', 'delivered', 'completed'].includes(customerStatus),
    can_reconcile:
      intentReady &&
      d.state === 'ordered' &&
      !reconciled &&
      retailBalance.amount_due === 0 &&
      !['cancelled', 'return_initiated', 'return_received', 'return_completed'].includes(
        customerStatus,
      ) &&
      local === 0 &&
      scopeData?.orders.filter((o) => o.state === 'ordered').every((o) => o.dispatched),
    reconciled,
    customer_tracking: customerTracking,
    fulfillment: {
      status: supplier.status,
      payment_balance: payment,
      shipments,
      historical: false,
      read_only: false,
    },
  };
}
export async function b2bDropshipOptions(a: Actor, linkId: string) {
  // A genuine older copy still performs fresh current read authorization.
  const role = await assertCatalogExportAccess(a, readScopes);
  return networkTx(a.tenantId, async (c) => {
    networkEnlistActorInTx(c, a, false, readScopes);
    const available = await b2bNetworkDropshippingAvailable(c);
    const l = (await c.query('SELECT id FROM b2b_links WHERE id=$1', [linkId])).rows[0];
    ensure(l, 404, 'Nie znaleziono własnego połączenia');
    const flags = available
      ? await b2bDropshipAccessInTx(c, a, false, true)
      : {
          available: false,
          read_only: false,
          current_role: role,
          can_read: true,
          can_manage: false,
          can_read_value: role === 'admin',
        };
    return {
      ...flags,
      limits: S.B2B_DROPSHIP_LIMITS,
      payment_mode: 'prepaid',
      receiver_source: 'customer_order_snapshot',
      local_custody: 'released_unscanned_then_supplier_reserved',
    };
  });
}
export async function b2bDropshipSources(
  a: Actor,
  linkId: string,
  input: z.infer<typeof S.b2bDropshipSourceQuery>,
) {
  return run(a, linkId, false, async (c, l) => {
    const pair = await catalogPair(c, a, l);
    const poolFilter = pair ? `AND NOT EXISTS(SELECT 1 FROM order_items oi LEFT JOIN products p ON(p.tenant_id,p.id)=(oi.tenant_id,oi.product_id)
      WHERE(oi.tenant_id,oi.order_id)=(o.tenant_id,o.id) AND(oi.product_id IS NULL OR p.id IS NULL OR p.catalog_id<>$4))
      AND NOT EXISTS(SELECT 1 FROM order_items oi CROSS JOIN LATERAL jsonb_array_elements(oi.components) part
      LEFT JOIN products p ON p.tenant_id=oi.tenant_id AND p.id=(part->>'product_id')::uuid
      WHERE(oi.tenant_id,oi.order_id)=(o.tenant_id,o.id) AND(p.id IS NULL OR p.catalog_id<>$4))` : '';
    const result = await c.query(
      `SELECT id,number,version::text,status,currency,customer_name,created_at FROM orders o WHERE status IN('new','paid','picking','packed') AND NOT EXISTS(SELECT 1 FROM order_merge_claims WHERE tenant_id=o.tenant_id AND source_order_id=o.id)
        ${poolFilter}
        AND ($1::uuid IS NULL OR id>$1) AND ($2='' OR number ILIKE '%'||$2||'%' OR customer_name ILIKE '%'||$2||'%') ORDER BY id LIMIT $3`,
      [input.cursor ?? null, input.search, input.limit + 1, ...(pair ? [pair.buyer.target_catalog_id] : [])],
    );
    const data = result.rows.slice(0, input.limit);
    return { data, meta: { cursor: result.rows.length > input.limit ? data.at(-1)!.id : null } };
  });
}
export async function b2bDropshipSource(a: Actor, linkId: string, id: string) {
  return run(a, linkId, false, async (c, l) => {
    const pair = await catalogPair(c, a, l);
    return { source: (await sourceData(c, l, id, pair)).public };
  });
}
export async function createB2bDropshipQuote(
  a: Actor,
  linkId: string,
  body: z.infer<typeof S.b2bDropshipQuoteInput>,
) {
  const input = {
    ...body,
    items: [...body.items]
      .map((i) => ({
        ...i,
        mappings: [...i.mappings].sort((x, y) => x.product_id.localeCompare(y.product_id)),
      }))
      .sort((x, y) => x.customer_item_id.localeCompare(y.customer_item_id)),
  };
  const requestHash = hash(a, 'quote', linkId, input);
  return run(a, linkId, true, async (c, l) => {
    await keyAvailable(c, input.client_key, 'quotes');
    const old = (
      await c.query('SELECT * FROM b2b_dropship_quotes WHERE client_key=$1', [input.client_key])
    ).rows[0];
    if (old) {
      ensure(
        old.request_hash === requestHash,
        409,
        'Klucz wyceny należy do innej próby lub aktora',
      );
      const order = (
        await c.query('SELECT id FROM b2b_dropship_orders WHERE quote_id=$1', [old.id])
      ).rows[0];
      return { quote: quoteView(old, order?.id ?? null, a), reused: true };
    }
    const pair = await catalogPair(c, a, l);
    const s = await sourceData(c, l, input.customer_order_id, pair);
    ensure(
      !s.intent ||
        (input.fulfillment_basis === 'external_intent' &&
          input.intent_version === s.intent.version &&
          s.intent.state === 'open'),
      409,
      'Wycena wymaga aktualnej otwartej intencji',
    );
    ensure(s.intent || !input.fulfillment_basis, 409, 'Brak własnej intencji realizacji');
    const selected = input.items.map((i) => {
      const item = s.items.find((x) => x.id === i.customer_item_id);
      ensure(item, 404, 'Pozycja nie należy do tego zamówienia klienta');
      const eligible = s.public.lines.find((x) => x.customer_item_id === item.id)!;
      ensure(
        item.components.length > 0 && i.quantity <= eligible.remaining_quantity,
        409,
        'Przekroczono niewydaną ilość konkretnej pozycji klienta',
      );
      ensure(
        i.mappings.length === item.components.length &&
          item.components.every((x: Row) => i.mappings.some((m) => m.product_id === x.product_id)),
        422,
        'Wybierz mapowanie każdego zamrożonego składnika',
      );
      for (const m of i.mappings)
        ensure(
          s.choices.some((ci) => ci.id === m.catalog_item_id && ci.product_id === m.product_id),
          409,
          'Mapowanie dostawcy jest nieaktualne',
        );
      return {
        customer_item_id: item.id,
        quantity: i.quantity,
        mappings: i.mappings,
        sku: item.sku,
        name: item.name,
        currency: s.o.currency,
        vat: item.vat,
        unit_price_minor: String(item.price),
        line_total_minor: String(item.line_total),
        original_quantity: item.quantity,
        components: item.components,
      };
    });
    const mappingSnapshot = selected.flatMap((i) =>
      i.mappings.map((m) => {
        const ci = s.choices.find((x) => x.id === m.catalog_item_id)!;
        const p = s.products.find((x) => x.id === m.product_id);
        const recipe = i.components.find((x: Row) => x.product_id === m.product_id)!;
        ensure(
          p?.active && ['simple', 'variant'].includes(p.kind),
          409,
          'Składnik fizyczny jest nieaktywny',
        );
        return {
          customer_item_id: i.customer_item_id,
          product_id: m.product_id,
          catalog_item: ci,
          labels: {
            product_sku: p.sku,
            product_name: p.name,
            source_sku: ci.snapshot.sku,
            source_name: ci.snapshot.name,
            source_product_id: ci.source_product_id,
            quantity: recipe.quantity,
          },
        };
      }),
    );
    const supplierQuantities = new Map<string, number>();
    for (const i of selected)
      for (const m of i.mappings) {
        const ci = s.choices.find((x) => x.id === m.catalog_item_id)!;
        const part = i.components.find((x: Row) => x.product_id === m.product_id)!;
        const n = (supplierQuantities.get(ci.source_product_id) ?? 0) + i.quantity * part.quantity;
        ensure(Number.isSafeInteger(n) && n <= 100000, 422, 'Przekroczono ilość fizyczną dostawcy');
        supplierQuantities.set(ci.source_product_id, n);
      }
    ensure(
      supplierQuantities.size <= 100,
      422,
      'Dostawa obsługuje do 100 różnych produktów fizycznych',
    );
    const selectedMappings = [...new Set<string>(selected.flatMap(i => i.mappings.map(m => m.catalog_item_id)))];
    // The supplier's available is checked live against the physical quantities; the rest of the offer snapshot exactly.
    if (pair) for (let offset = 0; offset < selectedMappings.length; offset += 500)
      await assertB2BBuyerCatalogItemsInTx(c, pair, selectedMappings.slice(offset, offset + 500), true, false, supplierQuantities);
    const custody = (await c.query('SELECT b2b_dropship_custody_snapshot($1) snapshot', [s.o.id]))
      .rows[0].snapshot;
    const partner = await networkSource(c, l);
    ensure(
      partner.account.payment_mode === 'prepaid',
      409,
      'Dropshipping wymaga dostawcy rozliczanego przedpłatą',
    );
    const products = (
      await c.query(
        'SELECT to_jsonb(p) row FROM products p WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE',
        [[...supplierQuantities.keys()]],
      )
    ).rows.map((r) => r.row);
    ensure(
      products.length === supplierQuantities.size &&
        products.every((p) => p.active && ['simple', 'variant'].includes(p.kind)),
      409,
      'Dostawca wymaga aktywnych fizycznych produktów',
    );
    const supplierQuote = await quoteB2b(c, partner.account, {
      client_key: input.client_key,
      items: [...supplierQuantities].map(([product_id, quantity]) => ({ product_id, quantity })),
    });
    const frozenQuote = (
      await c.query('SELECT to_jsonb(q) row FROM b2b_quotes q WHERE id=$1', [supplierQuote.id])
    ).rows[0].row;
    const wholesale = {
      currency: supplierQuote.pricing.currency,
      total_minor: String(supplierQuote.total),
      shipping_minor: String(partner.account.shipping_cost),
      payment_mode: 'prepaid',
      bill_to: {
        name: partner.account.name,
        email: partner.account.email,
        tax_id: partner.account.tax_id,
        address: partner.account.address,
      },
      items: products.map((p) => {
        const price = supplierQuote.pricing.items.find((x: Row) => x.product_id === p.id).price;
        return {
          source_product_id: p.id,
          sku: p.sku,
          name: p.name,
          vat: p.vat,
          quantity: supplierQuantities.get(p.id),
          unit_gross_minor: String(price),
          line_total_minor: String(price * supplierQuantities.get(p.id)!),
        };
      }),
    };
    // Supplier quote reads are complete; intent evidence belongs to the buyer.
    await scope(c, a.tenantId);
    const snapshot = {
      customer_header: s.o,
      ...(s.intent
        ? {
            fulfillment_basis: 'external_intent',
            intent_snapshot: (
              await c.query(
                'SELECT b2b_external_intent_snapshot(h) snapshot FROM b2b_external_order_intents h WHERE order_id=$1',
                [s.o.id],
              )
            ).rows[0].snapshot,
          }
        : {}),
      receiver: s.receiver,
      retail: s.public.retail,
      items: selected,
      mapping_snapshot: mappingSnapshot,
      custody,
      ...(pair ? { catalog_scope: pair } : {}),
      link_version: l.version,
      account_version: partner.account.version,
      list: partner.list,
      supplier_quote: frozenQuote,
      supplier_products: products,
      wholesale,
    };
    ensure(
      Buffer.byteLength(JSON.stringify(snapshot)) <= 8 * 1024 * 1024,
      413,
      'Zamrożony zakres wyceny jest zbyt duży',
    );
    const id = randomUUID();
    const q = (
      await c.query(
        `INSERT INTO b2b_dropship_quotes(id,tenant_id,link_id,actor_id,api_key_id,client_key,request_hash,request,snapshot,scope_hash,customer_order_id,supplier_tenant_id,source_quote_id,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
        [
          id,
          a.tenantId,
          l.id,
          a.userId,
          a.apiKeyId ?? null,
          input.client_key,
          requestHash,
          JSON.stringify(input),
          JSON.stringify(snapshot),
          wmsLotsHash(snapshot),
          s.o.id,
          l.supplier_tenant_id,
          supplierQuote.id,
          supplierQuote.expires_at,
        ],
      )
    ).rows[0];
    await audit(c, a, 'b2b.dropship.quote', id, {
      customer_order_id: s.o.id,
      scope_hash: q.scope_hash,
    });
    return { quote: quoteView(q), reused: false };
  });
}
export async function b2bDropshipQuote(a: Actor, linkId: string, id: string) {
  return run(a, linkId, false, async (c, l) => {
    const q = await ownQuote(c, l, id);
    const d = (await c.query('SELECT id FROM b2b_dropship_orders WHERE quote_id=$1', [id])).rows[0];
    return { quote: quoteView(q, d?.id ?? null, a) };
  });
}
export async function checkoutB2bDropship(
  a: Actor,
  linkId: string,
  id: string,
  input: z.infer<typeof S.b2bDropshipCheckoutInput>,
) {
  const requestHash = hash(a, 'checkout', id, input);
  return run(a, linkId, true, async (c, l) => {
    await keyAvailable(c, input.client_key, 'orders');
    const old = (
      await c.query('SELECT * FROM b2b_dropship_orders WHERE client_key=$1 OR quote_id=$2', [
        input.client_key,
        id,
      ])
    ).rows[0];
    if (old) {
      ensure(old.request_hash === requestHash, 409, 'Checkout należy do innej próby lub aktora');
      return { order: await orderView(c, a, old), reused: true };
    }
    const q = await ownQuote(c, l, id);
    ensure(
      q.actor_id === a.userId && q.api_key_id === (a.apiKeyId ?? null),
      409,
      'Wycenę zatwierdza jej pierwotny aktor',
    );
    ensure(
      q.scope_hash === input.scope_hash && new Date(q.expires_at).getTime() > Date.now(),
      409,
      'Wycena wygasła lub zgoda dotyczy innego zakresu',
    );
    const pair = await catalogPair(c, a, l, q.snapshot.catalog_scope);
    ensure(q.snapshot.catalog_scope || !pair || (pair.buyer.mode === 'legacy_default' && pair.supplier.mode === 'legacy_default'),
      409, 'Historyczna wycena nie potwierdza nowego zakresu katalogów B2B');
    const current = await sourceData(c, l, q.customer_order_id, pair);
    ensure(
      isDeepStrictEqual(current.o, q.snapshot.customer_header),
      409,
      'Zamówienie klienta zmieniło się od wyceny',
    );
    if (q.snapshot.fulfillment_basis === 'external_intent')
      ensure(
        current.intent &&
          current.intent.state === 'open' &&
          current.intent.version === q.snapshot.intent_snapshot.version,
        409,
        'Intencja zmieniła się od wyceny',
      );
    const requiredBuyerProducts = new Set<string>(
      q.snapshot.items.flatMap((i: Row) => i.components.map((part: Row) => part.product_id)),
    );
    ensure(
      current.products.filter((p) => requiredBuyerProducts.has(p.id)).length ===
        requiredBuyerProducts.size &&
        current.products
          .filter((p) => requiredBuyerProducts.has(p.id))
          .every((p) => p.active && ['simple', 'variant'].includes(p.kind)),
      409,
      'Składnik fizyczny kupującego został wyłączony lub zmieniony',
    );
    for (const item of q.snapshot.items) {
      const now = current.items.find((i) => i.id === item.customer_item_id);
      ensure(
        now &&
          isDeepStrictEqual(now.components, item.components) &&
          now.price.toString() === item.unit_price_minor &&
          now.line_total.toString() === item.line_total_minor &&
          now.scanned + item.quantity <= now.quantity,
        409,
        'Pozycja handlowa zmieniła się od wyceny',
      );
    }
    for (const m of q.snapshot.mapping_snapshot)
      ensure(
        isDeepStrictEqual(
          current.choices.find((ci) => ci.id === m.catalog_item.id),
          m.catalog_item,
        ),
        409,
        'Mapowanie dostawcy zmieniło się od wyceny',
      );
    const selectedMappings = [...new Set<string>(q.snapshot.mapping_snapshot.map((m: Row) => m.catalog_item.id))];
    // Summed per source product: a repeated product in the frozen quote must not shrink the quantity checked live.
    const frozenQuantities = new Map<string, number>();
    for (const i of q.snapshot.wholesale.items as Row[])
      frozenQuantities.set(i.source_product_id, (frozenQuantities.get(i.source_product_id) ?? 0) + Number(i.quantity));
    if (pair) for (let offset = 0; offset < selectedMappings.length; offset += 500)
      await assertB2BBuyerCatalogItemsInTx(c, pair, selectedMappings.slice(offset, offset + 500), true, false, frozenQuantities);
    ensure(
      isDeepStrictEqual(
        (await c.query('SELECT b2b_dropship_custody_snapshot($1) snapshot', [q.customer_order_id]))
          .rows[0].snapshot,
        q.snapshot.custody,
      ),
      409,
      'Rezerwacje lub skany zmieniły się od wyceny',
    );
    const partner = await networkSource(c, l);
    ensure(
      partner.account.payment_mode === 'prepaid' &&
        partner.account.version === q.snapshot.account_version &&
        l.version === q.snapshot.link_version &&
        isDeepStrictEqual(partner.list, q.snapshot.list),
      409,
      'Warunki kontrahenta zmieniły się od wyceny',
    );
    const sourceQuote = (
      await c.query('SELECT * FROM b2b_quotes WHERE id=$1 FOR UPDATE', [q.source_quote_id])
    ).rows[0];
    ensure(
      sourceQuote &&
        !sourceQuote.order_id &&
        new Date(sourceQuote.expires_at).getTime() > Date.now(),
      409,
      'Źródłowa wycena jest już użyta lub wygasła',
    );
    const productIDs = q.snapshot.wholesale.items.map((i: Row) => i.source_product_id);
    const actualProducts = (
      await c.query(
        'SELECT to_jsonb(p) row FROM products p WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE',
        [productIDs],
      )
    ).rows.map((r) => r.row);
    ensure(
      isDeepStrictEqual(actualProducts, q.snapshot.supplier_products),
      409,
      'Produkty dostawcy zmieniły się od wyceny',
    );
    if (sourceQuote.pricing.catalog_scope)
      ensure(pair && isDeepStrictEqual(pair.supplier, sourceQuote.pricing.catalog_scope),
        409, 'Źródłowa wycena należy do innego zakresu dostawcy');
    else ensure(!pair || pair.supplier.mode === 'legacy_default', 409, 'Źródłowa wycena nie potwierdza zakresu dostawcy');
    ensure(
      (
        await c.query(
          'SELECT product_id FROM price_list_items WHERE price_list_id=$1 AND product_id=ANY($2::uuid[]) ORDER BY product_id FOR SHARE',
          [partner.account.price_list_id, productIDs],
        )
      ).rows.length === productIDs.length,
      409,
      'Dostawca wycofał produkt z katalogu',
    );
    const { catalog_scope: _sourceScope, ...quotedPricing } = sourceQuote.pricing;
    ensure(
      isDeepStrictEqual(
        await prices(c, productIDs, partner.account.price_list_id, l.supplier_tenant_id),
        quotedPricing,
      ),
      409,
      'Ceny dostawcy zmieniły się od wyceny',
    );
    const receiver = q.snapshot.receiver;
    const supplier = await createOrder(
      c,
      { tenantId: l.supplier_tenant_id, userId: null },
      orderSchema.parse({
        customer_name: receiver.customer_name,
        email: receiver.email,
        address: receiver.address,
        warehouse_id: partner.account.warehouse_id,
        price_list_id: partner.account.price_list_id,
        currency: sourceQuote.pricing.currency,
        source: 'b2b',
        payment_mode: 'prepaid',
        shipping_cost: partner.account.shipping_cost,
        items: sourceQuote.input.items,
      }),
    );
    await c.query('UPDATE orders SET b2b_account_id=$2,b2b_snapshot=$3 WHERE id=$1', [
      supplier.id,
      partner.account.id,
      JSON.stringify({
        ...q.snapshot.wholesale.bill_to,
        quote_id: sourceQuote.id,
        account_version: partner.account.version,
      }),
    ]);
    await c.query('UPDATE b2b_quotes SET order_id=$2 WHERE id=$1', [sourceQuote.id, supplier.id]);
    // 246 (B2B-007): the wholesale order of an account with an active credit line is charged to it.
    await chargeTradeCreditInTx(c, partner.account, supplier.id, 'dropship');
    await scope(c, a.tenantId);
    const did = randomUUID();
    const d = (
      await c.query(
        `INSERT INTO b2b_dropship_orders(id,tenant_id,link_id,quote_id,customer_order_id,supplier_tenant_id,supplier_order_id,actor_id,api_key_id,client_key,request_hash,request) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [
          did,
          a.tenantId,
          l.id,
          q.id,
          q.customer_order_id,
          l.supplier_tenant_id,
          supplier.id,
          a.userId,
          a.apiKeyId ?? null,
          input.client_key,
          requestHash,
          JSON.stringify(input),
        ],
      )
    ).rows[0];
    await c.query(
      `INSERT INTO b2b_dropship_lines(tenant_id,order_id,customer_order_id,customer_item_id,quantity,mappings) SELECT $1,$2,$3,customer_item_id,quantity,mappings FROM jsonb_to_recordset($4::jsonb) x(customer_item_id uuid,quantity integer,mappings jsonb)`,
      [a.tenantId, did, q.customer_order_id, JSON.stringify(q.snapshot.items)],
    );
    await scope(c, l.supplier_tenant_id);
    await c.query(
      'INSERT INTO b2b_dropship_supplier_orders(tenant_id,order_id,buyer_tenant_id,dropship_order_id,bill_to,receiver) VALUES($1,$2,$3,$4,$5,$6)',
      [
        l.supplier_tenant_id,
        supplier.id,
        a.tenantId,
        did,
        JSON.stringify(q.snapshot.wholesale.bill_to),
        JSON.stringify(receiver),
      ],
    );
    await scope(c, a.tenantId);
    await c.query('SELECT b2b_dropship_transfer_custody($1,NULL)', [did]);
    await audit(c, a, 'b2b.dropship.checkout', did, {
      customer_order_id: q.customer_order_id,
      supplier_order_id: supplier.id,
      scope_hash: q.scope_hash,
    });
    return { order: await orderView(c, a, d), reused: false };
  });
}
export async function b2bDropshipOrders(
  a: Actor,
  linkId: string,
  input: z.infer<typeof S.b2bDropshipPageQuery>,
) {
  return run(a, linkId, false, async (c, l) => {
    const rows = (
      await c.query(
        'SELECT * FROM b2b_dropship_orders WHERE link_id=$1 AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT $3',
        [l.id, input.cursor ?? null, input.limit + 1],
      )
    ).rows;
    const data = [];
    for (const d of rows.slice(0, input.limit)) data.push(await orderView(c, a, d));
    return { data, meta: { cursor: rows.length > input.limit ? data.at(-1)!.id : null } };
  });
}
export async function b2bDropshipQuotes(
  a: Actor,
  linkId: string,
  input: z.infer<typeof S.b2bDropshipPageQuery>,
) {
  return run(a, linkId, false, async (c, l) => {
    const rows = (
      await c.query(
        'SELECT q.*,d.id current_order_id FROM b2b_dropship_quotes q LEFT JOIN b2b_dropship_orders d ON(d.tenant_id,d.quote_id)=(q.tenant_id,q.id) WHERE q.link_id=$1 AND ($2::uuid IS NULL OR q.id>$2) ORDER BY q.id LIMIT $3',
        [l.id, input.cursor ?? null, input.limit + 1],
      )
    ).rows;
    const data = rows.slice(0, input.limit).map((q) => quoteView(q, q.current_order_id ?? null, a));
    return { data, meta: { cursor: rows.length > input.limit ? data.at(-1)!.id : null } };
  });
}
export async function b2bDropshipOrder(a: Actor, linkId: string, id: string) {
  return run(a, linkId, false, async (c, l) => ({
    order: await orderView(c, a, await ownDrop(c, l, id)),
  }));
}
export async function cancelB2bDropship(
  a: Actor,
  linkId: string,
  id: string,
  input: z.infer<typeof S.b2bDropshipCancelInput>,
) {
  const requestHash = hash(a, 'cancel', id, input);
  return run(a, linkId, true, async (c, l) => {
    await keyAvailable(c, input.client_key, 'actions');
    const old = (
      await c.query('SELECT * FROM b2b_dropship_actions WHERE client_key=$1', [input.client_key])
    ).rows[0];
    if (old) {
      ensure(old.request_hash === requestHash, 409, 'Klucz anulowania należy do innej próby');
      return { order: await orderView(c, a, await ownDrop(c, l, id)), reused: true };
    }
    const d = await ownDrop(c, l, id, true);
    ensure(
      d.state === 'ordered' && d.version === input.version,
      409,
      'Dostawa została zmieniona lub anulowana',
    );
    await customer(c, d.customer_order_id); // blocks issued retail and current merge/wave state
    await networkCatalogLocks(c, [a.tenantId, l.supplier_tenant_id]);
    await scope(c, l.supplier_tenant_id);
    const supplier = (
      await c.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE', [d.supplier_order_id])
    ).rows[0];
    ensure(supplier, 409, 'Brak powiązanego zamówienia dostawcy');
    ensure(
      !(
        await c.query(
          "SELECT 1 FROM shipments WHERE order_id=$1 UNION ALL SELECT 1 FROM shipping_plans WHERE order_id=$1 AND state NOT IN('preview','cancelled') UNION ALL SELECT 1 FROM invoice_plans WHERE order_id=$1 AND state NOT IN('preview','cancelled') UNION ALL SELECT 1 FROM odoo_invoice_exports WHERE order_id=$1 AND state NOT IN('preview','cancelled') LIMIT 1",
          [supplier.id],
        )
      ).rowCount,
      409,
      'Dostawca rozpoczął wysyłkę lub zapis u dostawcy dokumentów',
    );
    if (supplier.status !== 'cancelled')
      await cancelOrder(c, { tenantId: l.supplier_tenant_id, userId: null }, supplier.id);
    await scope(c, a.tenantId);
    const actionId = randomUUID();
    await c.query(
      `INSERT INTO b2b_dropship_actions(id,tenant_id,order_id,actor_id,api_key_id,client_key,kind,request_hash,request,result) VALUES($1,$2,$3,$4,$5,$6,'cancel',$7,$8,$9)`,
      [
        actionId,
        a.tenantId,
        id,
        a.userId,
        a.apiKeyId ?? null,
        input.client_key,
        requestHash,
        JSON.stringify(input),
        JSON.stringify({ supplier_order_id: supplier.id, customer_order_id: d.customer_order_id }),
      ],
    );
    await c.query('SELECT b2b_dropship_transfer_custody($1,$2)', [id, actionId]);
    const updated = (
      await c.query(
        "UPDATE b2b_dropship_orders SET state='cancelled',version=version+1,cancelled_at=clock_timestamp() WHERE id=$1 RETURNING *",
        [id],
      )
    ).rows[0];
    await audit(c, a, 'b2b.dropship.cancel', id, { action_id: actionId, reason: input.reason });
    return { order: await orderView(c, a, updated), reused: false };
  });
}
export async function reconcileB2bDropship(
  a: Actor,
  linkId: string,
  id: string,
  input: z.infer<typeof S.b2bDropshipReconcileInput>,
) {
  const requestHash = hash(a, 'reconcile', id, input);
  return run(a, linkId, true, async (c, l) => {
    await keyAvailable(c, input.client_key, 'actions');
    const old = (
      await c.query('SELECT * FROM b2b_dropship_actions WHERE client_key=$1', [input.client_key])
    ).rows[0];
    if (old) {
      ensure(old.request_hash === requestHash, 409, 'Klucz uzgodnienia należy do innej próby');
      return { order: await orderView(c, a, await ownDrop(c, l, id)), reused: true };
    }
    const d = await ownDrop(c, l, id, true);
    ensure(d.state === 'ordered' && d.version === input.version, 409, 'Dostawa została zmieniona');
    const customerOrder = (
      await c.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE', [d.customer_order_id])
    ).rows[0];
    ensure(
      customerOrder &&
        !['cancelled', 'return_initiated', 'return_received', 'return_completed'].includes(
          customerOrder.status,
        ),
      409,
      'Nie można uzgodnić tego zamówienia klienta',
    );
    const proof = await b2bDropshipOrderScopeInTx(c, d.customer_order_id);
    ensure(proof, 409, 'Brak powiązania realizacji');
    await b2bExternalIntentAssertInTx(c, d.customer_order_id, 'reconcile');
    ensure(
      proof.orders.filter((o) => o.state === 'ordered').every((o) => o.dispatched),
      409,
      'Nie wszystkie części dostawców zostały rzeczywiście wydane',
    );
    ensure(
      !(
        await c.query("SELECT 1 FROM reservations WHERE order_id=$1 AND state='active' LIMIT 1", [
          customerOrder.id,
        ])
      ).rowCount,
      409,
      'Pozostała lokalna rezerwacja; najpierw rzeczywiście wydaj lokalną część',
    );
    ensure(
      (await paymentBalance(c, customerOrder.id)).amount_due === 0,
      409,
      'Rozlicz rzeczywistą należność detaliczną przed uzgodnieniem',
    );
    if (!['shipped', 'delivered', 'completed'].includes(customerOrder.status)) {
      await c.query("UPDATE orders SET status='shipped',updated_at=now() WHERE id=$1", [
        customerOrder.id,
      ]);
      await event(c, a.tenantId, customerOrder.id, 'order.dropship_reconciled', {
        external_quantity: proof.external_quantity,
      });
    }
    const actionId = randomUUID();
    await c.query(
      `INSERT INTO b2b_dropship_actions(id,tenant_id,order_id,actor_id,api_key_id,client_key,kind,request_hash,request,result) VALUES($1,$2,$3,$4,$5,$6,'reconcile',$7,$8,$9)`,
      [
        actionId,
        a.tenantId,
        id,
        a.userId,
        a.apiKeyId ?? null,
        input.client_key,
        requestHash,
        JSON.stringify(input),
        JSON.stringify({ customer_order_id: customerOrder.id, fulfillment: proof }),
      ],
    );
    await audit(c, a, 'b2b.dropship.reconcile', id, { action_id: actionId });
    return { order: await orderView(c, a, d), reused: false };
  });
}
/** 251 (B2B-005): copies the dispatched supplier parcel numbers to the customer order; the same parcels add nothing. */
export async function syncB2bDropshipTracking(a: Actor, linkId: string, id: string) {
  return run(a, linkId, true, async (c, l) => {
    const d = await ownDrop(c, l, id, true);
    const added = await copyDropshipTrackingInTx(c, d);
    if (added) await audit(c, a, 'b2b.dropship.tracking', id, { added });
    return { order: await orderView(c, a, d), added };
  });
}
