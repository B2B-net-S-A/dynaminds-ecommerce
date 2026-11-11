import { assertB2bWholeParcelAckInTx } from './b2b-dropship-ack-guard';
import { shopifyAccountPolicy } from './shopify-oauth';
import { shopifyGrantCredentials } from './shopify-auth-input';
import { createHash, randomUUID } from 'node:crypto';
import pg, { type PoolClient } from 'pg';
import { holdingDbLock, lockDbClient } from './db-lock-holder';
import { z } from 'zod';
import { pool, tenantTx } from './db';
import { audit, type Actor } from './domain';
import { ensure, Problem } from './errors';
import { decrypt } from './security';
import { channelRead, loadChannel, type IntegrationContext } from './channel-access';
import { Shopify, normalizeShopify, shopifyId } from './shopify';
import { shopifyFulfillmentBody } from './shopify-fulfillment-api';
import { commerceHash } from './order-status';
import { fenceSync } from './offer-sync';
import { orderMergeOriginInTx } from './order-merge-guards';
import { resolveOrderMergeOwnerInTx } from './order-merge-payments';
export const shopifyFulfillmentHash = (v: unknown) =>
  createHash('sha256')
    .update(
      JSON.stringify(v, (_k, x) =>
        x && typeof x === 'object' && !Array.isArray(x)
          ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b)))
          : x,
      ),
    )
    .digest('hex');
const hash = shopifyFulfillmentHash;
export const shopifyFulfillmentIdentity = (ch: any) =>
  hash([ch.provider, ch.mode, ch.settings, shopifyGrantCredentials(ch)]);
export const shopifyFulfillmentInput = z
  .object({
    company: shopifyFulfillmentBody.shape.trackingInfo.shape.company,
    notify_customer: z.boolean().default(false),
    client_key: z.uuid().optional(),
    shipment_id: z.uuid().optional(),
    lines: z
      .array(
        z
          .object({
            remote_line_id: z.string().regex(/^gid:\/\/shopify\/LineItem\/[1-9]\d{0,19}$/),
            quantity: z.number().int().min(1).max(1000000),
          })
          .strict(),
      )
      .min(1)
      .max(100)
      .optional(),
  })
  .strict()
  .superRefine((v, c) => {
    if (
      v.lines &&
      (!v.client_key || new Set(v.lines.map((x) => x.remote_line_id)).size !== v.lines.length)
    )
      c.addIssue({
        code: 'custom',
        message: 'Wymagany klucz próby i niepowtórzone pozycje Shopify',
      });
    if (!v.lines && (v.client_key || v.shipment_id))
      c.addIssue({ code: 'custom', message: 'Klucz i przesyłka wymagają jawnego wyboru pozycji' });
  });
async function partialAuthority(c: PoolClient, a: Actor, lock = false) {
  ensure(
    (
      await c.query('SELECT shopify_source_fulfillment_authority($1,$2,true,$3) role', [
        a.userId,
        a.apiKeyId ?? null,
        lock,
      ])
    ).rows[0].role === 'admin',
    403,
    'Brak aktualnej roli lub uprawnień klucza do realizacji Shopify',
  );
}
function receiverIdentity(v: any) {
  return {
    customer_name: String(v.customer_name ?? '')
      .trim()
      .replace(/\s+/g, ' '),
    email: String(v.email ?? '')
      .trim()
      .toLowerCase(),
    address: {
      street: String(v.address?.street ?? '')
        .trim()
        .replace(/\s+/g, ' '),
      city: String(v.address?.city ?? '').trim(),
      postal_code: String(v.address?.postal_code ?? '').replace(/[\s-]/g, ''),
      country: String(v.address?.country ?? '').toUpperCase(),
      phone: String(v.address?.phone ?? '').replace(/[\s+()-]/g, ''),
      locker_code: v.address?.locker_code ?? null,
    },
  };
}
async function admin(c: PoolClient, a: Actor) {
  ensure(
    (await c.query('SELECT offer_sync_is_admin($1) ok', [a.userId])).rows[0]?.ok,
    403,
    'Wymagana aktualna rola administratora',
  );
}
export async function shopifyFulfillmentLocal(c: PoolClient, id: string, lock = false) {
  const o = (await c.query('SELECT * FROM orders WHERE id=$1' + (lock ? ' FOR SHARE' : ''), [id]))
    .rows[0];
  ensure(o, 404, 'Nie znaleziono zamówienia');
  await assertB2bWholeParcelAckInTx(c, id);
  ensure(
    !(await orderMergeOriginInTx(c, id)),
    409,
    'Po połączeniu wybierz konkretne pozycje oryginalnego źródła',
  );
  ensure(
    o.source === 'shopify' && o.channel_id && o.external_id && o.source_snapshot?.items?.length,
    422,
    'Wymagane zaimportowane zamówienie Shopify',
  );
  shopifyId(o.external_id, 'Order');
  const ch = (
    await c.query('SELECT * FROM channels WHERE id=$1' + (lock ? ' FOR SHARE' : ''), [o.channel_id])
  ).rows[0];
  ensure(ch?.provider === 'shopify', 422, 'Brak połączenia Shopify');
  await shopifyAccountPolicy(c, ch);
  const ships = (
    await c.query('SELECT * FROM shipments WHERE order_id=$1' + (lock ? ' FOR SHARE' : ''), [o.id])
  ).rows;
  ensure(
    ships.length === 1 &&
      ships[0].dispatched_at &&
      ['shipped', 'delivered', 'completed'].includes(o.status),
    409,
    'Najpierw przekaż całą przesyłkę kurierowi',
  );
  const s = ships[0];
  ensure(
    ch.settings.simulation || s.mode === ch.mode,
    422,
    'Przesyłka DEMO lub innego środowiska nie może trafić na konto Shopify',
  );
  shopifyFulfillmentBody.shape.trackingInfo.shape.number.parse(s.tracking_number);
  const inbound = (
    await c.query(
      "SELECT raw,source_hash FROM inbound_orders WHERE order_id=$1 AND channel_id=$2 AND state='imported'",
      [o.id, ch.id],
    )
  ).rows[0];
  ensure(inbound, 409, 'Brak pierwotnego importu Shopify');
  const original = normalizeShopify(inbound.raw);
  ensure(
    !original.blockers.length &&
      commerceHash(original) === commerceHash(o, o.source_snapshot.items),
    409,
    'Lokalne dane nie odpowiadają potwierdzonemu importowi Shopify',
  );
  const lines = inbound.raw.lineItems.nodes
    .map((i: any) => ({
      id: shopifyId(i.id, 'LineItem'),
      variant_id: shopifyId(i.variant?.id, 'ProductVariant'),
      sku: i.sku,
      quantity: i.quantity,
    }))
    .sort((a: any, b: any) => a.id.localeCompare(b.id));
  const items = (await c.query('SELECT * FROM order_items WHERE order_id=$1 ORDER BY id', [id]))
    .rows;
  const acceptedReturns = (
    await c.query(
      "SELECT r.id,l.item_id,l.accepted FROM return_items l JOIN return_cases r ON (r.tenant_id,r.id)=(l.tenant_id,l.return_id) WHERE l.order_id=$1 AND l.accepted>0 AND r.state IN ('refund_pending','closed') ORDER BY r.id,l.item_id",
      [id],
    )
  ).rows;
  ensure(!acceptedReturns.length, 409, 'Zwrócone pozycje wymagają uzgodnienia Shopify');
  ensure(
    items.reduce((n, i) => n + i.quantity, 0) ===
      original.items.reduce((n, i) => n + i.quantity, 0) &&
      items.reduce((n, i) => n + i.line_total, 0) ===
        original.items.reduce((n, i) => n + i.line_total, 0),
    409,
    'Lokalne ilości lub wartości pozycji różnią się od importu Shopify',
  );
  const localHash = hash({
    version: o.version,
    status: o.status,
    commerce: commerceHash(o, o.source_snapshot.items),
    source: inbound.source_hash,
    raw: inbound.raw,
    snapshot: o.source_snapshot,
    items,
    shipment: [s.id, s.carrier, s.tracking_number, s.mode, new Date(s.dispatched_at).toISOString()],
  });
  return { o, ch, s, raw: inbound.raw, lines, localHash };
}
export async function shopifySourceFulfillmentAvailable(c: PoolClient) {
  return Boolean(
    (
      await c.query(
        "SELECT to_regclass('public.order_source_lines') IS NOT NULL AND to_regclass('public.shopify_source_fulfillment_requests') IS NOT NULL AND to_regclass('public.shopify_dispatch_evidence') IS NOT NULL ok",
      )
    ).rows[0].ok,
  );
}
const sourceId = (p: any) => p.payload.partial?.source_order_id ?? p.order_id;
async function localForPlan(c: PoolClient, p: any, lock = false) {
  return p.payload.partial
    ? shopifySourceFulfillmentLocal(
        c,
        sourceId(p),
        {
          company: p.payload.fulfillment.trackingInfo.company,
          notify_customer: p.payload.fulfillment.notifyCustomer,
          client_key: p.payload.partial.client_key,
          shipment_id: p.shipment_id,
          lines: p.payload.lines.map((l: any) => ({ remote_line_id: l.id, quantity: l.quantity })),
        },
        lock,
        p.id,
      )
    : shopifyFulfillmentLocal(c, p.order_id, lock);
}
export async function shopifyFulfillmentSources(c: PoolClient, id: string) {
  const ownerId = await resolveOrderMergeOwnerInTx(c, id);
  ensure(ownerId === id, 409, 'Otwórz obecne zamówienie wynikowe');
  const merges = Boolean(
    (await c.query("SELECT to_regclass('public.order_merge_claims') IS NOT NULL ok")).rows[0].ok,
  );
  const rows = merges
    ? (
        await c.query(
          `WITH RECURSIVE sources AS (SELECT $1::uuid id,ARRAY[$1::uuid] path UNION ALL SELECT m.source_order_id,s.path||m.source_order_id FROM sources s JOIN order_merge_claims m ON m.target_order_id=s.id WHERE cardinality(s.path)<1000 AND NOT m.source_order_id=ANY(s.path)) SELECT DISTINCT o.id,coalesce(g.header->>'number',o.number) number,coalesce((g.header->>'channel_id')::uuid,o.channel_id) channel_id,coalesce(g.header->>'external_id',o.external_id) external_id,c.name channel_name FROM sources s JOIN orders o ON o.id=s.id LEFT JOIN order_merge_origins g ON g.order_id=o.id JOIN channels c ON c.id=coalesce((g.header->>'channel_id')::uuid,o.channel_id) WHERE coalesce(g.header->>'source',o.source)='shopify' ORDER BY o.id LIMIT 101`,
          [id],
        )
      ).rows
    : (
        await c.query(
          "SELECT o.id,o.number,o.channel_id,o.external_id,c.name channel_name FROM orders o JOIN channels c ON c.id=o.channel_id WHERE o.id=$1 AND o.source='shopify'",
          [id],
        )
      ).rows;
  ensure(rows.length <= 100, 422, 'Zbyt wiele źródeł Shopify w jednym zamówieniu');
  const data = rows.map((row) => ({
    source_order_id: row.id,
    number: row.number,
    channel_name: row.channel_name,
    external_id: row.external_id,
    owner_order_id: id,
  }));
  return data;
}
export async function shopifySourceFulfillmentLocal(
  c: PoolClient,
  id: string,
  input: z.infer<typeof shopifyFulfillmentInput>,
  lock = false,
  planId?: string,
) {
  ensure(
    await shopifySourceFulfillmentAvailable(c),
    503,
    'Ta kopia nie obsługuje częściowej realizacji źródeł Shopify',
  );
  const ownerId = await resolveOrderMergeOwnerInTx(c, id);
  const locked = (
    await c.query(
      'SELECT * FROM orders WHERE id=ANY($1::uuid[]) ORDER BY id' + (lock ? ' FOR SHARE' : ''),
      [[...new Set([id, ownerId])].sort()],
    )
  ).rows;
  ensure(
    (await resolveOrderMergeOwnerInTx(c, id)) === ownerId,
    409,
    'Właściciel realizacji zmienił się',
  );
  const current = locked.find((o) => o.id === id),
    owner = locked.find((o) => o.id === ownerId);
  ensure(current && owner, 404, 'Nie znaleziono własnego źródła');
  const origin = await orderMergeOriginInTx(c, id),
    o = origin ? { ...origin.header, id } : current;
  ensure(
    o.source === 'shopify' && o.channel_id && o.external_id && o.source_snapshot?.items?.length,
    422,
    'Wymagane oryginalne źródło Shopify',
  );
  shopifyId(o.external_id, 'Order');
  const ch = (
    await c.query('SELECT * FROM channels WHERE id=$1' + (lock ? ' FOR SHARE' : ''), [o.channel_id])
  ).rows[0];
  ensure(ch?.provider === 'shopify', 422, 'Brak połączenia Shopify');
  await shopifyAccountPolicy(c, ch);
  const inbound = (
    await c.query(
      "SELECT id,raw,source_hash,imported_hash FROM inbound_orders WHERE order_id=$1 AND channel_id=$2 AND state='imported'",
      [id, ch.id],
    )
  ).rows[0];
  ensure(inbound, 409, 'Brak pierwotnego importu Shopify');
  const bindings = (
    await c.query(
      'SELECT * FROM order_source_lines WHERE source_order_id=$1 AND channel_id=$2 ORDER BY remote_line_id',
      [id, ch.id],
    )
  ).rows;
  ensure(
    bindings.length && bindings.length <= 100,
    409,
    'Brak kompletnych trwałych powiązań pozycji Shopify',
  );
  const raw = structuredClone(inbound.raw);
  raw.displayFulfillmentStatus = 'UNFULFILLED';
  for (const l of raw.lineItems?.nodes ?? []) l.unfulfilledQuantity = l.quantity;
  const original = normalizeShopify(raw);
  ensure(
    !original.blockers.length &&
      commerceHash(original) === commerceHash(o, o.source_snapshot.items),
    409,
    'Oryginalna treść zamówienia Shopify zmieniła się',
  );
  const originalItems =
    origin?.items ??
    (await c.query('SELECT * FROM order_items WHERE order_id=$1 ORDER BY id', [id])).rows;
  ensure(
    bindings.length === raw.lineItems.nodes.length && bindings.length === originalItems.length,
    409,
    'Powiązania nie obejmują każdej zdalnej pozycji',
  );
  const ownerItems = (
    await c.query(
      'SELECT * FROM order_items WHERE order_id=$1 ORDER BY id' + (lock ? ' FOR SHARE' : ''),
      [ownerId],
    )
  ).rows;
  const roots = (
    await c.query(
      "SELECT DISTINCT ON(x.target_item_id) x.target_item_id,x.row->>'root_source_order_id' root_order,x.row->>'root_source_item_id' root_item FROM order_merge_execution_rows x JOIN order_merge_executions e ON(e.tenant_id,e.id)=(x.tenant_id,x.execution_id) WHERE x.target_item_id=ANY($1::uuid[]) ORDER BY x.target_item_id,e.created_at DESC,e.id DESC",
      [ownerItems.map((i) => i.id)],
    )
  ).rows;
  const lines = bindings.map((b) => {
    const line = raw.lineItems.nodes.find((l: any) => l.id === b.remote_line_id),
      item = originalItems.find((i: any) => i.id === b.source_item_id);
    ensure(
      line &&
        item &&
        b.inbound_id === inbound.id &&
        b.source_hash === (inbound.imported_hash ?? inbound.source_hash) &&
        line.quantity === b.quantity &&
        line.variant?.id === b.external_product_id &&
        item.product_id === b.product_id &&
        item.quantity === b.quantity &&
        item.line_total === b.line_total,
      409,
      'Trwałe powiązanie nie odpowiada oryginalnej pozycji',
    );
    const owned = ownerItems.filter((i) => {
      const r = roots.find((r) => r.target_item_id === i.id);
      return r
        ? r.root_order === id && r.root_item === item.id
        : ownerId === id && i.id === item.id;
    });
    ensure(
      owned.length === 1 &&
        hash({ ...owned[0], id: item.id, order_id: id, scanned: item.scanned }) === hash(item),
      409,
      'Fragment źródłowy nie odpowiada obecnemu właścicielowi',
    );
    return {
      id: b.remote_line_id,
      variant_id: b.external_product_id,
      sku: line.sku,
      quantity: b.quantity,
      source_item_id: b.source_item_id,
      owner_item_id: owned[0].id,
      name: item.name,
      unit_price: item.price,
      line_total: item.line_total,
      vat: item.vat,
      currency: o.currency,
    };
  });
  const ships = (
    await c.query('SELECT * FROM shipments WHERE order_id=$1' + (lock ? ' FOR SHARE' : ''), [
      ownerId,
    ])
  ).rows;
  const s = input.shipment_id
    ? ships.find((s) => s.id === input.shipment_id)
    : ships.length === 1
      ? ships[0]
      : null;
  ensure(
    s?.dispatched_at && ['shipped', 'delivered', 'completed'].includes(owner.status),
    409,
    'Wybierz przekazaną przesyłkę właściciela realizacji',
  );
  ensure(
    ch.settings.simulation || s.mode === ch.mode,
    422,
    'Przesyłka DEMO lub innego środowiska nie może trafić na konto Shopify',
  );
  shopifyFulfillmentBody.shape.trackingInfo.shape.number.parse(s.tracking_number);
  const evidence = (
    await c.query('SELECT * FROM shopify_dispatch_evidence WHERE shipment_id=$1', [s.id])
  ).rows[0];
  ensure(evidence, 409, 'Brak niezmiennego dowodu odbiorcy i pozycji przekazanej paczki');
  ensure(
    evidence.receiver &&
      hash(receiverIdentity(evidence.receiver)) ===
        hash(
          receiverIdentity({ customer_name: o.customer_name, email: o.email, address: o.address }),
        ),
    409,
    'Odbiorca przekazanej paczki różni się od oryginalnego źródła Shopify',
  );
  for (const l of lines) {
    const i = evidence.items.find((i: any) => i.id === l.owner_item_id);
    ensure(
      i &&
        i.quantity === l.quantity &&
        hash(i.components) ===
          hash(originalItems.find((i: any) => i.id === l.source_item_id).components),
      409,
      'Paczka nie potwierdza pełnego fragmentu źródłowego',
    );
  }
  const returned = (
    await c.query(
      "SELECT l.item_id,sum(l.accepted)::int quantity FROM return_items l JOIN return_cases r ON(r.tenant_id,r.id)=(l.tenant_id,l.return_id) WHERE l.order_id=$1 AND r.state IN('refund_pending','closed') GROUP BY l.item_id",
      [ownerId],
    )
  ).rows;
  const account_scope = [
    ch.settings.store_url,
    o.external_id,
    ch.settings.simulation ? current.tenant_id : '',
  ];
  const capacities = (
    await c.query('SELECT * FROM shopify_source_fulfillment_capacity($1::jsonb,$2::uuid)', [
      JSON.stringify(account_scope),
      planId ?? null,
    ])
  ).rows;
  const requested = [...(input.lines ?? [])].sort((a, b) =>
    a.remote_line_id.localeCompare(b.remote_line_id),
  );
  for (const l of requested) {
    const b = lines.find((v) => v.id === l.remote_line_id);
    ensure(b, 422, 'Nieznana zdalna pozycja Shopify');
    const used = Number(capacities.find((v) => v.remote_line_id === b.id)?.quantity ?? 0),
      ret = returned.find((v) => v.item_id === b.owner_item_id)?.quantity ?? 0;
    ensure(
      l.quantity <= Math.max(0, b.quantity - used),
      409,
      'Wybrana ilość przekracza niepotwierdzoną część przekazanej paczki',
    );
  }
  const localHash = hash({
    owner: { id: owner.id, version: owner.version, status: owner.status },
    source: { id, header: o, items: originalItems, bindings },
    items: ownerItems,
    roots,
    returned,
    evidence,
    shipment: [s.id, s.carrier, s.tracking_number, s.mode, new Date(s.dispatched_at).toISOString()],
  });
  return {
    o,
    ch,
    s,
    raw: inbound.raw,
    lines,
    localHash,
    owner,
    account_scope,
    capacities,
    returned,
    partial: {
      source_order_id: id,
      owner_order_id: ownerId,
      client_key: input.client_key,
      api_key_id: null as string | null,
      source_hash: inbound.imported_hash ?? inbound.source_hash,
      bindings: lines,
      requested,
      dispatch_evidence_id: evidence.shipment_id,
    },
  };
}
export function demoShopifyFulfillmentState(raw: any, values: any[] = []) {
  const location = { id: 'gid://shopify/Location/1', isActive: true, fulfillsOnlineOrders: true };
  const fulfilled = new Map<string, number>();
  for (const f of values.filter((v) => v.status === 'SUCCESS'))
    for (const l of f.lines) fulfilled.set(l.id, (fulfilled.get(l.id) ?? 0) + l.quantity);
  const allDone = raw.lineItems.nodes.every((l: any) => (fulfilled.get(l.id) ?? 0) >= l.quantity);
  const orders = [
    {
      id: 'gid://shopify/FulfillmentOrder/98001',
      orderId: raw.id,
      status: allDone ? 'CLOSED' : 'OPEN',
      requestStatus: 'UNSUBMITTED',
      updatedAt: raw.updatedAt,
      supportedActions: allDone ? [] : [{ action: 'CREATE_FULFILLMENT' }],
      assignedLocation: { location },
      lineItems: raw.lineItems.nodes.map((i: any, n: number) => ({
        id: 'gid://shopify/FulfillmentOrderLineItem/' + (980010 + n),
        totalQuantity: i.quantity,
        remainingQuantity: Math.max(0, i.quantity - (fulfilled.get(i.id) ?? 0)),
        requiresShipping: true,
        lineItem: { id: i.id, sku: i.sku, variant: i.variant },
      })),
    },
  ];
  const copied = structuredClone(raw);
  if (values.length) {
    copied.displayFulfillmentStatus = allDone ? 'FULFILLED' : 'PARTIALLY_FULFILLED';
    for (const l of copied.lineItems.nodes)
      l.unfulfilledQuantity = Math.max(0, l.quantity - (fulfilled.get(l.id) ?? 0));
  }
  return {
    raw: copied,
    orders,
    fulfillments: values,
    scopes: [
      'read_orders',
      'read_merchant_managed_fulfillment_orders',
      'write_merchant_managed_fulfillment_orders',
    ],
  };
}
async function readState(
  a: Actor,
  ch: any,
  orderId: string,
  externalId: string,
  ctx: IntegrationContext,
  guard: () => Promise<void>,
) {
  await guard();
  if (ch.settings.simulation)
    return tenantTx(a.tenantId, async (c) => {
      const r = (
        await c.query(
          "SELECT raw FROM inbound_orders WHERE order_id=$1 AND channel_id=$2 AND state='imported'",
          [orderId, ch.id],
        )
      ).rows[0];
      ensure(r?.raw?.id === externalId, 409, 'Brak pierwotnego przykładu Shopify');
      const v =
        (
          await c.query(
            'SELECT fulfillments FROM shopify_fulfillment_simulations WHERE order_id=$1',
            [orderId],
          )
        ).rows[0]?.fulfillments ?? [];
      return demoShopifyFulfillmentState(r.raw, v);
    });
  return channelRead(
    a.tenantId,
    ch.id,
    async (client) => {
      ensure(client instanceof Shopify, 422, 'Wymagany Shopify');
      return client.fulfillmentState(externalId, guard);
    },
    ctx,
    false,
    async (current) => {
      ensure(
        shopifyFulfillmentIdentity(current) === shopifyFulfillmentIdentity(ch),
        409,
        'Połączenie Shopify zmieniono',
      );
      await guard();
    },
  );
}
function matching(values: any[], payload: any, remoteId?: string | null) {
  if (payload.partial) {
    const previous = new Set(payload.partial.previous_fulfillment_ids);
    const related = values.filter((v) =>
      remoteId
        ? v.id === remoteId
        : !previous.has(v.id) &&
          hash(v.lines) === hash(payload.lines) &&
          v.location_id === payload.location_id &&
          v.tracking.some((t: any) => t.number === payload.fulfillment.trackingInfo.number),
    );
    ensure(
      related.length <= 1,
      409,
      'Niejednoznaczna część realizacji Shopify; porównaj zdalne ID',
    );
    if (!related.length) return null;
    const f = related[0],
      t = payload.fulfillment.trackingInfo;
    ensure(
      f.status === 'SUCCESS' &&
        f.location_id === payload.location_id &&
        hash(f.lines) === hash(payload.lines) &&
        hash(f.fulfillment_order_ids) ===
          hash(
            payload.fulfillment.lineItemsByFulfillmentOrder
              .map((v: any) => v.fulfillmentOrderId)
              .sort(),
          ) &&
        f.tracking.length === 1 &&
        f.tracking[0].number === t.number &&
        f.tracking[0].company === t.company,
      409,
      'Zdalna część nie odpowiada wybranym pozycjom i przesyłce',
    );
    return f;
  }
  const t = payload.fulfillment.trackingInfo,
    related = values.filter(
      (v) => v.tracking.some((r: any) => r.number === t.number) || (remoteId && v.id === remoteId),
    );
  ensure(related.length <= 1, 409, 'Niejednoznaczna realizacja Shopify dla numeru śledzenia');
  if (!related.length) return null;
  const f = related[0];
  ensure(
    (!remoteId || f.id === remoteId) &&
      f.status === 'SUCCESS' &&
      f.location_id === payload.location_id &&
      hash(f.lines) === hash(payload.lines) &&
      hash(f.fulfillment_order_ids) ===
        hash(
          payload.fulfillment.fulfillmentOrderIds ??
            payload.fulfillment.lineItemsByFulfillmentOrder
              .map((v: any) => v.fulfillmentOrderId)
              .sort(),
        ) &&
      f.tracking.length === 1 &&
      f.tracking[0].number === t.number &&
      f.tracking[0].company === t.company,
    409,
    'Numer śledzenia, lokalizacja lub pozycje realizacji Shopify nie odpowiadają przesyłce',
  );
  return f;
}
function observed(
  x: Awaited<ReturnType<typeof shopifyFulfillmentLocal>>,
  state: any,
  input: z.infer<typeof shopifyFulfillmentInput>,
) {
  const raw = structuredClone(state.raw);
  ensure(raw.id === x.o.external_id, 409, 'Inne zamówienie Shopify');
  const rawLines = raw.lineItems.nodes;
  ensure(
    hash(
      rawLines
        .map((i: any) => ({
          id: i.id,
          variant_id: i.variant?.id,
          sku: i.sku,
          quantity: i.quantity,
        }))
        .sort((a: any, b: any) => a.id.localeCompare(b.id)),
    ) === hash(x.lines),
    409,
    'ID pozycji, warianty, SKU lub ilości Shopify zmieniły się',
  );
  // Reconciliation can read the original shipment after fulfillment; financial/address edits remain visible.
  raw.displayFulfillmentStatus = 'UNFULFILLED';
  for (const i of rawLines) i.unfulfilledQuantity = i.quantity;
  const normalized = normalizeShopify(raw);
  ensure(
    !normalized.blockers.length &&
      commerceHash(normalized) === commerceHash(x.o, x.o.source_snapshot.items),
    409,
    'Adres, kwoty lub pozycje Shopify zmieniły się',
  );
  const locations = new Set<string>(),
    allocations: any[] = [],
    totals = new Map<string, number>(),
    seen = new Set<string>();
  for (const o of state.orders) {
    ensure(Array.isArray(o.lineItems), 502, 'Brak pozycji zlecenia realizacji Shopify');
    const positive = o.lineItems.filter((l: any) => l.remainingQuantity > 0);
    if (!positive.length) continue;
    ensure(
      o.orderId === x.o.external_id &&
        o.status === 'OPEN' &&
        o.requestStatus === 'UNSUBMITTED' &&
        o.supportedActions?.some((v: any) => v.action === 'CREATE_FULFILLMENT'),
      409,
      'Zlecenie Shopify jest wstrzymane, przydzielone usłudze albo niegotowe',
    );
    const location = o.assignedLocation?.location;
    shopifyId(location?.id, 'Location');
    ensure(
      location.isActive && location.fulfillsOnlineOrders,
      409,
      'Lokalizacja Shopify nie obsługuje realizacji',
    );
    locations.add(location.id);
    const items = [];
    for (const l of positive) {
      const original = x.lines.find((v: any) => v.id === l.lineItem?.id);
      ensure(
        original &&
          !seen.has(l.id) &&
          Number.isInteger(l.totalQuantity) &&
          l.totalQuantity >= l.remainingQuantity &&
          Number.isInteger(l.remainingQuantity) &&
          l.remainingQuantity > 0 &&
          l.remainingQuantity <= 1000000 &&
          l.requiresShipping === true &&
          l.lineItem?.variant?.id === original.variant_id &&
          l.lineItem.sku === original.sku,
        409,
        'Nieprawidłowe przypisanie lub ilość pozycji Shopify',
      );
      seen.add(l.id);
      totals.set(original.id, (totals.get(original.id) ?? 0) + l.remainingQuantity);
      items.push({
        id: shopifyId(l.id, 'FulfillmentOrderLineItem'),
        quantity: l.remainingQuantity,
      });
    }
    allocations.push({
      fulfillmentOrderId: shopifyId(o.id, 'FulfillmentOrder'),
      fulfillmentOrderLineItems: items.sort((a, b) => a.id.localeCompare(b.id)),
    });
  }
  const trackingInfo = { company: input.company, number: x.s.tracking_number },
    base = {
      lines: x.lines.map((l: any) => ({ id: l.id, quantity: l.quantity })),
      location_id: locations.size === 1 ? [...locations][0] : null,
    };
  const existing = state.fulfillments.filter((f: any) =>
    f.tracking.some((t: any) => t.number === trackingInfo.number),
  );
  // Existing full shipments can be adopted by GET; never invent a new set of fulfilled line IDs.
  if (existing.length) {
    const f = existing[0],
      payload = {
        ...base,
        location_id: f.location_id,
        fulfillment: {
          trackingInfo,
          notifyCustomer: input.notify_customer,
          lineItemsByFulfillmentOrder: f.fulfillment_order_ids.map((id: string) => ({
            fulfillmentOrderId: id,
            fulfillmentOrderLineItems: [],
          })),
        },
      };
    matching(state.fulfillments, payload);
    return {
      payload,
      remote: {
        external_id: x.o.external_id,
        local_version: String(x.o.version),
        existing: f.id,
        orders: state.orders,
        fulfillments: state.fulfillments,
      },
    };
  }
  ensure(
    state.scopes.includes('write_merchant_managed_fulfillment_orders'),
    403,
    'Aplikacja Shopify wymaga write_merchant_managed_fulfillment_orders i uprawnienia fulfill_and_ship_orders',
  );
  ensure(
    state.raw.displayFulfillmentStatus === 'UNFULFILLED' &&
      !state.fulfillments.some((f: any) => f.status !== 'CANCELLED'),
    409,
    'Shopify ma wcześniejszą lub częściową realizację; uzgodnij ją przed zapisem',
  );
  ensure(
    locations.size === 1 &&
      x.lines.every((l: any) => totals.get(l.id) === l.quantity) &&
      totals.size === x.lines.length,
    409,
    'Zlecenia Shopify nie pokrywają całej przesyłki w jednej lokalizacji; nie przenosimy ani nie uzupełniamy obcych zleceń',
  );
  const fulfillment = shopifyFulfillmentBody.parse({
    lineItemsByFulfillmentOrder: allocations.sort((a, b) =>
      a.fulfillmentOrderId.localeCompare(b.fulfillmentOrderId),
    ),
    trackingInfo,
    notifyCustomer: input.notify_customer,
  });
  return {
    payload: { ...base, fulfillment },
    remote: {
      external_id: x.o.external_id,
      local_version: String(x.o.version),
      existing: null,
      orders: state.orders,
      fulfillments: state.fulfillments,
    },
  };
}
function observedPartial(
  x: Awaited<ReturnType<typeof shopifySourceFulfillmentLocal>>,
  state: any,
  input: z.infer<typeof shopifyFulfillmentInput>,
) {
  const raw = structuredClone(state.raw);
  ensure(raw.id === x.o.external_id, 409, 'Inne zamówienie Shopify');
  ensure(
    hash(
      raw.lineItems.nodes
        .map((i: any) => ({
          id: i.id,
          variant_id: i.variant?.id,
          sku: i.sku,
          quantity: i.quantity,
        }))
        .sort((a: any, b: any) => a.id.localeCompare(b.id)),
    ) ===
      hash(x.lines.map(({ id, variant_id, sku, quantity }) => ({ id, variant_id, sku, quantity }))),
    409,
    'Zdalne pozycje lub ilości źródła zmieniły się',
  );
  raw.displayFulfillmentStatus = 'UNFULFILLED';
  for (const l of raw.lineItems.nodes) l.unfulfilledQuantity = l.quantity;
  const n = normalizeShopify(raw);
  ensure(
    !n.blockers.length && commerceHash(n) === commerceHash(x.o, x.o.source_snapshot.items),
    409,
    'Zdalny odbiorca, kwoty lub treść źródła zmieniły się',
  );
  ensure(
    state.scopes.includes('write_merchant_managed_fulfillment_orders'),
    403,
    'Brak uprawnienia write_merchant_managed_fulfillment_orders',
  );
  const requested = [...(input.lines ?? [])].sort((a, b) =>
    a.remote_line_id.localeCompare(b.remote_line_id),
  );
  const remaining = new Map(requested.map((l) => [l.remote_line_id, l.quantity])),
    locations = new Set<string>(),
    allocations: any[] = [],
    seen = new Set<string>();
  for (const fo of state.orders) {
    const relevant = fo.lineItems.filter(
      (l: any) => remaining.has(l.lineItem?.id) && l.remainingQuantity > 0,
    );
    if (!relevant.length) continue;
    ensure(
      fo.orderId === x.o.external_id &&
        fo.status === 'OPEN' &&
        fo.requestStatus === 'UNSUBMITTED' &&
        fo.supportedActions?.some((a: any) => a.action === 'CREATE_FULFILLMENT'),
      409,
      'Wybrana pozycja zlecenia Shopify nie jest gotowa',
    );
    const loc = fo.assignedLocation?.location;
    shopifyId(loc?.id, 'Location');
    ensure(
      loc.isActive && loc.fulfillsOnlineOrders,
      409,
      'Lokalizacja Shopify nie obsługuje realizacji',
    );
    const items: any[] = [];
    for (const l of relevant) {
      const original = x.lines.find((v) => v.id === l.lineItem.id);
      ensure(
        original &&
          !seen.has(l.id) &&
          Number.isInteger(l.remainingQuantity) &&
          l.remainingQuantity > 0 &&
          Number.isInteger(l.totalQuantity) &&
          l.totalQuantity >= l.remainingQuantity &&
          l.requiresShipping === true &&
          l.lineItem.variant?.id === original.variant_id &&
          l.lineItem.sku === original.sku,
        409,
        'Nieprawidłowy przydział wybranej pozycji Shopify',
      );
      seen.add(l.id);
      const qty = Math.min(remaining.get(original.id) ?? 0, l.remainingQuantity);
      if (!qty) continue;
      locations.add(loc.id);
      remaining.set(original.id, (remaining.get(original.id) ?? 0) - qty);
      items.push({ id: shopifyId(l.id, 'FulfillmentOrderLineItem'), quantity: qty });
    }
    if (items.length)
      allocations.push({
        fulfillmentOrderId: shopifyId(fo.id, 'FulfillmentOrder'),
        fulfillmentOrderLineItems: items.sort((a, b) => a.id.localeCompare(b.id)),
      });
  }
  ensure(
    locations.size === 1 && [...remaining.values()].every((q) => q === 0),
    409,
    'Wybrane ilości nie są dostępne w jednej lokalizacji Shopify',
  );
  const fulfillment = shopifyFulfillmentBody.parse({
    trackingInfo: { company: input.company, number: x.s.tracking_number },
    notifyCustomer: input.notify_customer,
    lineItemsByFulfillmentOrder: allocations.sort((a, b) =>
      a.fulfillmentOrderId.localeCompare(b.fulfillmentOrderId),
    ),
  });
  const partial = {
    ...x.partial,
    previous_fulfillment_ids: state.fulfillments.map((f: any) => f.id).sort(),
    receiver: { customer_name: x.o.customer_name, email: x.o.email, address: x.o.address },
    returned: x.returned,
    owner_number: x.owner.number,
    source_number: x.o.number,
  };
  return {
    payload: {
      lines: requested.map((l) => ({ id: l.remote_line_id, quantity: l.quantity })),
      location_id: [...locations][0],
      fulfillment,
      partial,
    },
    remote: {
      external_id: x.o.external_id,
      local_version: String(x.owner.version),
      existing: null,
      orders: state.orders,
      fulfillments: state.fulfillments,
    },
  };
}
async function previewPartial(
  a: Actor,
  id: string,
  input: z.infer<typeof shopifyFulfillmentInput>,
  ctx: IntegrationContext,
) {
  const requestHash = hash({ id, input });
  const prior = await tenantTx(a.tenantId, async (c) => {
    await partialAuthority(c, a);
    ensure(
      await shopifySourceFulfillmentAvailable(c),
      503,
      'Częściowa realizacja jest niedostępna',
    );
    const r = (
      await c.query(
        'SELECT * FROM shopify_source_fulfillment_requests WHERE actor_id=$1 AND client_key=$2',
        [a.userId, input.client_key],
      )
    ).rows[0];
    if (!r) return null;
    ensure(r.request_hash === requestHash, 409, 'Klucz próby ma inny zakres');
    return plan(c, r.plan_id);
  });
  if (prior) return prior;
  const x = await tenantTx(a.tenantId, async (c) => {
    await partialAuthority(c, a);
    return shopifySourceFulfillmentLocal(c, id, input);
  });
  const guard = () =>
    tenantTx(a.tenantId, async (c) => {
      await partialAuthority(c, a);
      const y = await shopifySourceFulfillmentLocal(c, id, input, true);
      ensure(
        y.localHash === x.localHash &&
          shopifyFulfillmentIdentity(y.ch) === shopifyFulfillmentIdentity(x.ch),
        409,
        'Źródło, właściciela lub paczkę zmieniono',
      );
    });
  const state = await readState(a, x.ch, id, x.o.external_id, ctx, guard),
    v = observedPartial(x, state, input);
  return tenantTx(a.tenantId, async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      'shopify-source-preview:' + a.tenantId + ':' + a.userId + ':' + input.client_key,
    ]);
    await partialAuthority(c, a);
    const prior = (
      await c.query(
        'SELECT * FROM shopify_source_fulfillment_requests WHERE actor_id=$1 AND client_key=$2',
        [a.userId, input.client_key],
      )
    ).rows[0];
    if (prior) {
      ensure(prior.request_hash === requestHash, 409, 'Klucz próby ma inny zakres');
      return plan(c, prior.plan_id);
    }
    const y = await shopifySourceFulfillmentLocal(c, id, input, true);
    ensure(
      y.localHash === x.localHash &&
        shopifyFulfillmentIdentity(y.ch) === shopifyFulfillmentIdentity(x.ch),
      409,
      'Źródło, właściciela lub paczkę zmieniono',
    );
    v.payload.partial.api_key_id = a.apiKeyId ?? null;
    const p = (
      await c.query(
        'INSERT INTO shopify_fulfillment_plans(id,tenant_id,order_id,shipment_id,channel_id,actor_id,local_hash,connection_hash,account_scope,payload,remote) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *',
        [
          randomUUID(),
          a.tenantId,
          x.owner.id,
          x.s.id,
          x.ch.id,
          a.userId,
          x.localHash,
          shopifyFulfillmentIdentity(x.ch),
          JSON.stringify(x.account_scope),
          JSON.stringify(v.payload),
          JSON.stringify(v.remote),
        ],
      )
    ).rows[0];
    await c.query(
      'INSERT INTO shopify_source_fulfillment_requests(tenant_id,actor_id,client_key,request_hash,plan_id,api_key_id) VALUES($1,$2,$3,$4,$5,$6)',
      [a.tenantId, a.userId, input.client_key, requestHash, p.id, a.apiKeyId ?? null],
    );
    await audit(c, a, 'shopify.fulfillment.preview', p.id, {
      source_order_id: id,
      owner_order_id: x.owner.id,
      partial: true,
    });
    await partialAuthority(c, a, true);
    return p;
  });
}
export async function previewShopifyFulfillment(
  a: Actor,
  id: string,
  input: z.infer<typeof shopifyFulfillmentInput>,
  ctx: IntegrationContext = {},
) {
  if (input.lines) return previewPartial(a, id, input, ctx);
  const x = await tenantTx(a.tenantId, async (c) => {
    await admin(c, a);
    return shopifyFulfillmentLocal(c, id);
  });
  const guard = () =>
    tenantTx(a.tenantId, async (c) => {
      await admin(c, a);
      const current = await shopifyFulfillmentLocal(c, id, true);
      ensure(
        current.localHash === x.localHash &&
          shopifyFulfillmentIdentity(current.ch) === shopifyFulfillmentIdentity(x.ch),
        409,
        'Zamówienie, przesyłkę lub konto zmieniono',
      );
    });
  const state = await readState(a, x.ch, x.o.id, x.o.external_id, ctx, guard),
    v = observed(x, state, input);
  return tenantTx(a.tenantId, async (c) => {
    await admin(c, a);
    const current = await shopifyFulfillmentLocal(c, id, true);
    ensure(
      current.localHash === x.localHash &&
        shopifyFulfillmentIdentity(current.ch) === shopifyFulfillmentIdentity(x.ch),
      409,
      'Zamówienie, przesyłkę lub konto zmieniono',
    );
    const p = (
      await c.query(
        'INSERT INTO shopify_fulfillment_plans(id,tenant_id,order_id,shipment_id,channel_id,actor_id,local_hash,connection_hash,account_scope,payload,remote) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *',
        [
          randomUUID(),
          a.tenantId,
          id,
          x.s.id,
          x.ch.id,
          a.userId,
          x.localHash,
          shopifyFulfillmentIdentity(x.ch),
          JSON.stringify([
            x.ch.settings.store_url,
            x.o.external_id,
            x.ch.settings.simulation ? a.tenantId : '',
          ]),
          JSON.stringify(v.payload),
          JSON.stringify(v.remote),
        ],
      )
    ).rows[0];
    await audit(c, a, 'shopify.fulfillment.preview', p.id, {
      order_id: id,
      simulation: Boolean(x.ch.settings.simulation),
    });
    return p;
  });
}
async function plan(c: PoolClient, id: string, lock = false) {
  const p = (
    await c.query(
      'SELECT * FROM shopify_fulfillment_plans WHERE id=$1' + (lock ? ' FOR UPDATE' : ''),
      [id],
    )
  ).rows[0];
  ensure(p, 404, 'Nie znaleziono planu realizacji Shopify');
  return p;
}
export async function queueShopifyFulfillment(a: Actor, id: string, confirm = false) {
  return tenantTx(a.tenantId, async (c) => {
    let p = await plan(c, id);
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      'shopify-fulfillment-queue:' + a.tenantId,
    ]);
    if (p.payload.partial) await partialAuthority(c, a);
    else await admin(c, a);
    if (p.payload.partial && ['queued', 'done'].includes(p.state)) return p;
    if (p.payload.partial)
      ensure(
        p.actor_id === a.userId && (p.payload.partial.api_key_id ?? null) === (a.apiKeyId ?? null),
        403,
        'Zatwierdź plan w kontekście jego autora',
      );
    const x = await localForPlan(c, p, true);
    if (p.payload.partial) await partialAuthority(c, a);
    else await admin(c, a);
    p = await plan(c, id, true);
    if (['queued', 'done'].includes(p.state)) return p;
    ensure(
      p.state === 'preview' && new Date(p.created_at).getTime() > Date.now() - 1800000,
      409,
      'Podgląd wykorzystano lub wygasł',
    );
    ensure(
      x.localHash === p.local_hash && shopifyFulfillmentIdentity(x.ch) === p.connection_hash,
      409,
      'Zamówienie, przesyłkę lub konto zmieniono',
    );
    ensure(x.ch.settings.simulation || confirm, 422, 'Potwierdź przekazanie realizacji do Shopify');
    ensure(
      (await c.query('SELECT shopify_fulfillment_claim($1) ok', [p.id])).rows[0].ok,
      409,
      'Zamówienie ma wcześniejsze zgłoszenie na tym sklepie Shopify',
    );
    ensure(
      !(
        await c.query(
          "SELECT 1 FROM shopify_fulfillment_plans WHERE order_id=$1 AND (state='queued' OR (state IN ('failed','conflict') AND phase IN ('write_started','verify'))) LIMIT 1",
          [p.order_id],
        )
      ).rowCount,
      409,
      'Trwa wcześniejsze zgłoszenie lub wymaga odczytu',
    );
    ensure(
      (
        await c.query(
          "SELECT count(*)::int n FROM jobs WHERE kind='shopify.fulfillment' AND (state='pending' OR state='running')",
        )
      ).rows[0].n < 100,
      409,
      'Kolejka realizacji Shopify pełna; poczekaj na wcześniejsze wyniki',
    );
    const job = randomUUID();
    await c.query(
      "INSERT INTO jobs(id,tenant_id,kind,payload,dedup_key) VALUES($1,$2,'shopify.fulfillment',$3,$4)",
      [
        job,
        a.tenantId,
        JSON.stringify({ plan_id: p.id, actor_id: a.userId, channel_id: p.channel_id }),
        'shopify.fulfillment:' + p.id,
      ],
    );
    p = (
      await c.query(
        "UPDATE shopify_fulfillment_plans SET state='queued',actor_id=$2,job_id=$3,updated_at=now() WHERE id=$1 RETURNING *",
        [id, a.userId, job],
      )
    ).rows[0];
    await audit(c, a, 'shopify.fulfillment.queue', id, {
      order_id: p.order_id,
      simulation: Boolean(x.ch.settings.simulation),
    });
    if (p.payload.partial) await partialAuthority(c, a, true);
    return p;
  });
}
async function resourceLock<T>(tenant: string, id: string, fn: () => Promise<T>) {
  const scope = await tenantTx(
    tenant,
    async (c) => (await c.query('SELECT shopify_fulfillment_scope($1) scope', [id])).rows[0].scope,
  );
  ensure(scope, 404, 'Brak planu Shopify');
  const c = lockDbClient(new pg.Client({ connectionString: pool.options.connectionString }), 'shopify-fulfillment');
  await c.connect();
  try {
    return await holdingDbLock(c, async () => {
    await c.query("SET statement_timeout='20s'");
    await c.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [
      'shopify-fulfillment:' + scope,
    ]);
    return await fn();
    });
  } finally {
    await c.end();
  }
}
async function checkpoint(job: any, p: any, writing = false) {
  return tenantTx(job.tenant_id, async (c) => {
    ensure(await fenceSync(c, job, true), 409, 'Wygasła dzierżawa realizacji');
    if (p.payload.partial)
      await partialAuthority(c, {
        tenantId: job.tenant_id,
        userId: p.actor_id,
        role: 'admin',
        apiKeyId: p.payload.partial.api_key_id ?? undefined,
      });
    else await admin(c, { tenantId: job.tenant_id, userId: p.actor_id, role: 'admin' });
    const x = writing ? await localForPlan(c, p, true) : null,
      ch =
        x?.ch ??
        (await c.query('SELECT * FROM channels WHERE id=$1 FOR SHARE', [p.channel_id])).rows[0];
    ensure(
      ch &&
        shopifyFulfillmentIdentity(ch) === p.connection_hash &&
        (!x || x.localHash === p.local_hash),
      409,
      'Zamówienie, przesyłkę lub konto zmieniono',
    );
    const latest = await plan(c, p.id, true);
    ensure(
      latest.state === 'queued' && latest.job_id === job.id,
      409,
      'Zapis realizacji zatrzymano',
    );
    ensure(
      (await c.query('SELECT shopify_fulfillment_claim($1) ok', [p.id])).rows[0].ok,
      409,
      'Utracono wyłączność realizacji',
    );
    if (p.payload.partial)
      await partialAuthority(
        c,
        {
          tenantId: job.tenant_id,
          userId: p.actor_id,
          role: 'admin',
          apiKeyId: p.payload.partial.api_key_id ?? undefined,
        },
        true,
      );
  });
}
async function complete(
  c: PoolClient,
  a: Actor,
  p: any,
  found: any,
  unchanged: boolean,
  job?: any,
) {
  if (p.payload.partial) await partialAuthority(c, a);
  else await admin(c, a);
  const ch = (await c.query('SELECT * FROM channels WHERE id=$1 FOR SHARE', [p.channel_id]))
    .rows[0];
  ensure(
    ch && shopifyFulfillmentIdentity(ch) === p.connection_hash,
    409,
    'Połączenie Shopify zmieniono',
  );
  const latest = await plan(c, p.id, true);
  ensure(
    job
      ? latest.state === 'queued' && latest.job_id === job.id
      : ['failed', 'conflict'].includes(latest.state),
    409,
    'Plan realizacji zmieniono',
  );
  const o = (await c.query('SELECT version,status FROM orders WHERE id=$1', [p.order_id])).rows[0];
  await c.query(
    "UPDATE shopify_fulfillment_plans SET state='done',phase='done',remote_id=$2,result=$3,error=NULL,updated_at=now() WHERE id=$1",
    [
      p.id,
      found.id,
      JSON.stringify({
        fulfillment: found,
        unchanged,
        local_status: o.status,
        stale_local: String(o.version) !== p.remote.local_version,
        verified_at: new Date().toISOString(),
      }),
    ],
  );
  if (p.payload.partial)
    await c.query('SELECT shopify_source_fulfillment_confirm($1,$2)', [p.id, found.id]);
  if (job)
    await c.query(
      "UPDATE jobs SET state='done',lease_token=NULL,locked_at=NULL,error=NULL WHERE id=$1 AND lease_token=$2",
      [job.id, job.lease_token],
    );
  await audit(c, a, 'shopify.fulfillment.verified', p.id, {
    order_id: p.order_id,
    remote_id: found.id,
    unchanged,
  });
  if (p.payload.partial) await partialAuthority(c, a, true);
}
export async function processShopifyFulfillment(job: any, ctx: IntegrationContext = {}) {
  const initial = await tenantTx(job.tenant_id, (c) => plan(c, job.payload.plan_id));
  return resourceLock(job.tenant_id, initial.id, async () => {
    const p = await tenantTx(job.tenant_id, (c) => plan(c, initial.id));
    if (p.state !== 'queued')
      return tenantTx(job.tenant_id, async (c) => {
        if (await fenceSync(c, job))
          await c.query(
            "UPDATE jobs SET state='done',lease_token=NULL,locked_at=NULL WHERE id=$1",
            [job.id],
          );
      });
    const a: Actor = {
        tenantId: job.tenant_id,
        userId: p.actor_id,
        role: 'admin',
        ...(p.payload.partial?.api_key_id ? { apiKeyId: p.payload.partial.api_key_id } : {}),
      },
      ch = await loadChannel(job.tenant_id, p.channel_id);
    const guard = () => checkpoint(job, p, p.phase === 'ready');
    await guard();
    if (p.phase === 'ready') {
      const x = await tenantTx(job.tenant_id, (c) => localForPlan(c, p)),
        state = await readState(a, ch, sourceId(p), p.remote.external_id, ctx, guard),
        v = (p.payload.partial ? observedPartial : observed)(x as any, state, {
          ...(p.payload.partial
            ? {
                client_key: p.payload.partial.client_key,
                shipment_id: p.shipment_id,
                lines: p.payload.lines.map((l: any) => ({
                  remote_line_id: l.id,
                  quantity: l.quantity,
                })),
              }
            : {}),
          company: p.payload.fulfillment.trackingInfo.company,
          notify_customer: p.payload.fulfillment.notifyCustomer,
        });
      if (p.payload.partial) (v.payload as any).partial.api_key_id = p.payload.partial.api_key_id;
      if (v.remote.existing)
        return tenantTx(job.tenant_id, async (c) => {
          ensure(await fenceSync(c, job), 409, 'Wygasła dzierżawa');
          await complete(c, a, p, matching(state.fulfillments, p.payload), true, job);
        });
      ensure(
        hash(v.payload) === hash(p.payload) && hash(v.remote) === hash(p.remote),
        409,
        'Przydział lub realizacja Shopify zmieniły się od podglądu',
      );
      const begin = () =>
        tenantTx(job.tenant_id, async (c) => {
          ensure(await fenceSync(c, job, true), 409, 'Wygasła dzierżawa');
          const x = await localForPlan(c, p, true);
          if (p.payload.partial) await partialAuthority(c, a);
          else await admin(c, a);
          ensure(
            x.localHash === p.local_hash && shopifyFulfillmentIdentity(x.ch) === p.connection_hash,
            409,
            'Zmieniono dane przed zapisem',
          );
          const latest = await plan(c, p.id, true);
          ensure(latest.state === 'queued' && latest.phase === 'ready', 409, 'Plan zatrzymano');
          if (p.payload.partial) await partialAuthority(c, a, true);
          await c.query(
            "UPDATE shopify_fulfillment_plans SET phase='write_started',updated_at=now() WHERE id=$1",
            [p.id],
          );
        });
      let remoteId: string;
      if (ch.settings.simulation) {
        await begin();
        await checkpoint(job, p, true);
        remoteId =
          'gid://shopify/Fulfillment/' +
          BigInt('0x' + p.id.replaceAll('-', '').slice(0, 15)).toString();
        await tenantTx(job.tenant_id, async (c) => {
          ensure(await fenceSync(c, job), 409, 'Wygasła dzierżawa');
          if (p.payload.partial) await partialAuthority(c, a);
          else await admin(c, a);
          const x = await localForPlan(c, p, true);
          ensure(
            x.localHash === p.local_hash && shopifyFulfillmentIdentity(x.ch) === p.connection_hash,
            409,
            'Zmieniono dane przed zapisem symulacji',
          );
          const latest = await plan(c, p.id, true);
          ensure(
            latest.state === 'queued' && latest.phase === 'write_started',
            409,
            'Plan zatrzymano',
          );
          if (p.payload.partial) await partialAuthority(c, a, true);
          const f = {
            id: remoteId,
            status: 'SUCCESS',
            order_id: p.remote.external_id,
            location_id: p.payload.location_id,
            lines: p.payload.lines,
            fulfillment_order_ids: p.payload.fulfillment.lineItemsByFulfillmentOrder
              .map((v: any) => v.fulfillmentOrderId)
              .sort(),
            tracking: [p.payload.fulfillment.trackingInfo],
          };
          await c.query(
            'INSERT INTO shopify_fulfillment_simulations(tenant_id,order_id,fulfillments) VALUES($1,$2,$3) ON CONFLICT(tenant_id,order_id) DO UPDATE SET fulfillments=shopify_fulfillment_simulations.fulfillments||excluded.fulfillments',
            [a.tenantId, sourceId(p), JSON.stringify([f])],
          );
        });
      } else
        remoteId = await channelRead(
          job.tenant_id,
          ch.id,
          async (client) => {
            ensure(client instanceof Shopify, 422, 'Wymagany Shopify');
            return client.createFulfillment(
              p.payload.fulfillment,
              p.remote.external_id,
              async () => {
                await checkpoint(job, p, true);
                await begin();
              },
            );
          },
          ctx,
          false,
          async (current) => {
            ensure(
              shopifyFulfillmentIdentity(current) === p.connection_hash,
              409,
              'Połączenie Shopify zmieniono',
            );
            await checkpoint(job, p, true);
          },
        );
      await tenantTx(job.tenant_id, async (c) => {
        ensure(await fenceSync(c, job), 409, 'Wygasła dzierżawa');
        await c.query(
          "UPDATE shopify_fulfillment_plans SET phase='verify',remote_id=$2,updated_at=now() WHERE id=$1 AND state='queued'",
          [p.id, remoteId],
        );
      });
    }
    const readGuard = () => checkpoint(job, p, false);
    const state = await readState(a, ch, sourceId(p), p.remote.external_id, ctx, readGuard),
      latest = await tenantTx(job.tenant_id, (c) => plan(c, p.id)),
      found = matching(state.fulfillments, p.payload, latest.remote_id);
    ensure(
      found,
      502,
      'Shopify nie potwierdził realizacji; następne próby wykonają wyłącznie odczyt',
    );
    await readGuard();
    await tenantTx(job.tenant_id, async (c) => {
      ensure(await fenceSync(c, job), 409, 'Wygasła dzierżawa');
      await complete(c, a, p, found, false, job);
    });
  });
}
export async function failShopifyFulfillment(job: any, e: unknown) {
  return tenantTx(job.tenant_id, async (c) => {
    if (!(await fenceSync(c, job))) return;
    const p = await plan(c, job.payload.plan_id, true),
      terminal =
        (e instanceof Problem && [403, 404, 409, 422].includes(e.status)) ||
        job.attempts >= job.max_attempts,
      message = e instanceof Problem ? e.message : 'Błąd przekazania realizacji Shopify';
    await c.query(
      'UPDATE jobs SET state=$2,lease_token=NULL,locked_at=NULL,error=$3,run_at=now()+make_interval(secs=>least(300,power(2,attempts)::int)) WHERE id=$1',
      [job.id, terminal ? 'failed' : 'pending', message],
    );
    if (terminal)
      await c.query(
        "UPDATE shopify_fulfillment_plans SET state=$2,error=$3,updated_at=now() WHERE id=$1 AND state='queued'",
        [p.id, p.phase === 'ready' ? 'conflict' : 'failed', message],
      );
    await c.query('SELECT shopify_fulfillment_release($1)', [p.id]);
  });
}
export async function cancelShopifyFulfillment(a: Actor, id: string) {
  return tenantTx(a.tenantId, async (c) => {
    await admin(c, a);
    const initial = await plan(c, id);
    if (initial.job_id)
      await c.query('SELECT id FROM jobs WHERE id=$1 FOR UPDATE', [initial.job_id]);
    const p = await plan(c, id, true);
    if (p.state === 'cancelled') return p;
    ensure(
      ['preview', 'queued'].includes(p.state) && p.phase === 'ready',
      409,
      'Realizacja mogła trafić do Shopify; odczytaj wynik',
    );
    if (p.job_id)
      await c.query(
        "UPDATE jobs SET state='failed',lease_token=NULL,locked_at=NULL,error='Anulowano przed zapisem' WHERE id=$1 AND state IN ('pending','running')",
        [p.job_id],
      );
    await c.query(
      "UPDATE shopify_fulfillment_plans SET state='cancelled',updated_at=now() WHERE id=$1",
      [id],
    );
    await c.query('SELECT shopify_fulfillment_release($1)', [id]);
    await audit(c, a, 'shopify.fulfillment.cancel', id, {});
    return plan(c, id);
  });
}
export async function reconcileShopifyFulfillment(
  a: Actor,
  id: string,
  ctx: IntegrationContext = {},
  ack = false,
) {
  const initial = await tenantTx(a.tenantId, (c) => plan(c, id));
  return resourceLock(a.tenantId, initial.id, async () => {
    const p = await tenantTx(a.tenantId, async (c) => {
      await admin(c, a);
      const p = await plan(c, id);
      ensure(
        ['failed', 'conflict'].includes(p.state) && ['write_started', 'verify'].includes(p.phase),
        409,
        'Plan nie wymaga uzgodnienia',
      );
      return p;
    });
    const ch = await loadChannel(a.tenantId, p.channel_id),
      guard = () =>
        tenantTx(a.tenantId, async (c) => {
          await admin(c, a);
          const current = (await c.query('SELECT * FROM channels WHERE id=$1 FOR SHARE', [ch.id]))
            .rows[0];
          ensure(
            current && shopifyFulfillmentIdentity(current) === p.connection_hash,
            409,
            'Połączenie Shopify zmieniono; przywróć pierwotne konto',
          );
        });
    const state = await readState(a, ch, sourceId(p), p.remote.external_id, ctx, guard);
    let found: any = null;
    try {
      found = matching(state.fulfillments, p.payload, p.remote_id);
    } catch (e) {
      if (!(ack && e instanceof Problem && e.status === 409)) throw e;
    }
    ensure(
      found || ack,
      409,
      'Odczyt nie potwierdził realizacji. Sprawdź konto Shopify; zapis nie będzie powtórzony',
    );
    await guard();
    return tenantTx(a.tenantId, async (c) => {
      await admin(c, a);
      const current = (await c.query('SELECT * FROM channels WHERE id=$1 FOR SHARE', [ch.id]))
        .rows[0];
      ensure(
        current && shopifyFulfillmentIdentity(current) === p.connection_hash,
        409,
        'Połączenie Shopify zmieniono',
      );
      const latest = await plan(c, id, true);
      ensure(latest.state === p.state && latest.phase === p.phase, 409, 'Plan zmieniono');
      if (found) await complete(c, a, p, found, false);
      else {
        await c.query(
          "UPDATE shopify_fulfillment_plans SET state='conflict',phase='done',result=$2,error='Rozbieżność uzgodniona ręcznie; brak potwierdzenia zapisu',updated_at=now() WHERE id=$1",
          [
            id,
            JSON.stringify({
              matched: false,
              acknowledged: true,
              fulfillments: state.fulfillments,
            }),
          ],
        );
        await audit(c, a, 'shopify.fulfillment.resolve', id, { matched: false });
      }
      return plan(c, id);
    });
  });
}
