/** Operator edit of an order before fulfilment: buyer data and sale lines.
 * Lines change only before picking, never with scans, documents, shipping/parcel plans,
 * merge/split history, returns or external intents. Physical custody follows
 * the lines exactly as createOrder reserves it: order_pick_items, reservations,
 * reservation_locations and stock.reserved. Location rows cannot be deleted by the app
 * role, so a product that leaves the order keeps its rows under a released reservation
 * (the same state a cancellation leaves) and a later re-add reuses them.
 * With WMS lots on, a new product reserves its FIFO layers exactly as createOrder does
 * (reserveWmsLotsInTx), a removed one releases them as cancelOrder does (releaseWmsLotsInTx),
 * and a quantity change takes the fresh FIFO allocation where the immutable layer rows allow
 * it (resizeWmsLotsInTx), refusing otherwise. */
import type { PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ensure } from './errors';
import { audit, event, getOrder, lockedOrder, type Actor } from './domain';
import { paymentBalance } from './payments';
import { prices } from './pricing';
import { binStock } from './stock-locations';
import { wmsLotsPolicyInTx, reserveWmsLotsInTx, releaseWmsLotsInTx, resizeWmsLotsInTx } from './wms-lots';
import { enlistWmsActorInTx } from './wms-lots-transaction';
import { orderFulfillmentKind } from './order-fulfillment-kind';
import { lockWarehouseInventoryPoliciesInTx } from './warehouse-inventory-policies';
import {
  productCatalogsAvailable,
  resolveProductCatalogInTx,
  assertProductCatalogWarehouseInTx,
} from './product-catalogs';

type Row = Record<string, any>;
/** `new` waits for payment (Nieopłacone), `paid` is ready to fulfil (Nowe); both are before picking. */
export const ORDER_LINE_EDIT_STATUSES = ['new', 'paid'];
export const ORDER_CUSTOMER_EDIT_STATUSES = ['new', 'paid', 'picking', 'packed'];
const CUSTOMER_FIELD_LABELS: Record<string, string> = {
  customer_name: 'Imię i nazwisko',
  email: 'E-mail',
  street: 'Ulica i numer',
  postal_code: 'Kod pocztowy',
  city: 'Miejscowość',
  phone: 'Telefon',
};
export const ORDER_EDIT_CONFLICT = 'Zamówienie zmieniło się. Odśwież dane przed edycją.';

const expectedVersion = z
  .string({ error: 'Brak wersji zamówienia. Odśwież kartę zamówienia.' })
  .regex(/^\d+$/, 'Nieprawidłowa wersja zamówienia')
  .max(30, 'Nieprawidłowa wersja zamówienia');
const quantity = z
  .number({ error: 'Podaj ilość jako liczbę' })
  .int('Ilość musi być liczbą całkowitą')
  .min(1, 'Ilość musi być większa od zera')
  .max(100000, 'Za duża ilość produktu');
export const orderCustomerInput = z.strictObject({
  expected_version: expectedVersion,
  customer_name: z
    .string({ error: 'Podaj nazwę klienta' })
    .trim()
    .min(2, 'Nazwa klienta musi mieć co najmniej 2 znaki')
    .max(200, 'Nazwa klienta może mieć najwyżej 200 znaków'),
  email: z
    .string({ error: 'Podaj adres e-mail' })
    .trim()
    .max(254, 'Adres e-mail jest za długi')
    .pipe(z.email('Nieprawidłowy adres e-mail').or(z.literal(''))),
  phone: z
    .string()
    .trim()
    .max(30, 'Telefon może mieć najwyżej 30 znaków')
    .regex(/^[0-9+()\s-]*$/, 'Telefon może zawierać tylko cyfry, spacje oraz znaki + - ( )')
    .default(''),
  street: z.string().trim().max(200, 'Ulica może mieć najwyżej 200 znaków').default(''),
  postal_code: z.string().trim().max(20, 'Kod pocztowy może mieć najwyżej 20 znaków').default(''),
  city: z.string().trim().max(100, 'Miejscowość może mieć najwyżej 100 znaków').default(''),
});
export const orderItemAddInput = z
  .strictObject({
    expected_version: expectedVersion,
    product_id: z.uuid('Nieprawidłowy identyfikator produktu').optional(),
    sku: z.string().trim().min(1, 'Podaj SKU').max(120, 'SKU jest za długie').optional(),
    quantity,
  })
  .refine((b) => (b.product_id === undefined) !== (b.sku === undefined), {
    message: 'Wskaż produkt: product_id albo sku',
    path: ['product_id'],
  });
export const orderItemQuantityInput = z.strictObject({ expected_version: expectedVersion, quantity });
export const orderItemRemoveInput = z.strictObject({ expected_version: expectedVersion });

/** Fixed relationship list (never request input): [table, column, reason, extra SQL filter]. */
export type Blocker = readonly [string, string, string, string?];
export const DELIVERY_BLOCKERS: readonly Blocker[] = [
  ['shipments', 'order_id', 'utworzoną przesyłkę', "status<>'canceled'"],
  ['shipping_plans', 'order_id', 'przygotowaną przesyłkę', "state NOT IN ('preview','cancelled')"],
  ['order_parcel_plans', 'order_id', 'plan paczek'],
  ['b2b_dropship_supplier_orders', 'order_id', 'zlecenie dropshippingu'],
  ['b2b_dropship_orders', 'customer_order_id', 'zlecenie dropshippingu'],
];
export const LINE_BLOCKERS: readonly Blocker[] = [
  ...DELIVERY_BLOCKERS,
  ['documents', 'order_id', 'wystawione dokumenty'],
  ['invoice_plans', 'order_id', 'wystawione dokumenty', "state NOT IN ('preview','cancelled')"],
  ['odoo_invoice_exports', 'order_id', 'wystawione dokumenty', "state NOT IN ('preview','cancelled')"],
  ...['local_invoice_receipts', 'proforma_receipts', 'local_consumer_credit_documents', 'receipt233_receipts'].map(
    (t) => [t, 'order_id', 'wystawione dokumenty'] as const,
  ),
  ...['picking_wave_orders', 'packing_sessions', 'order_batch_items', 'stock_movements'].map(
    (t) => [t, 'order_id', 'kompletację lub ruchy magazynowe'] as const,
  ),
  // With WMS lots every order has its reserve operation and unscanned layer rows; anything further blocks.
  ['wms_operations', 'order_id', 'kompletację lub ruchy magazynowe', "kind<>'reserve'"],
  ['wms_reservation_layers', 'order_id', 'kompletację lub ruchy magazynowe', "(scanned>0 OR state='consumed')"],
  ['order_merge_claims', 'source_order_id', 'historię łączenia'],
  ['order_merge_claims', 'target_order_id', 'historię łączenia'],
  ['order_merge_origins', 'order_id', 'historię łączenia'],
  ['order_merge_executions', 'main_order_id', 'historię łączenia'],
  ['order_merge_executions', 'target_order_id', 'historię łączenia'],
  ['order_split222_executions', 'parent_order_id', 'historię podziału'],
  ['return_cases', 'order_id', 'zwroty lub reklamacje'],
  ...['b2b_external_order_intents', 'b2b_external_import_executions', 'b2b_network_order_lines',
    'amazon_fulfillment_plans', 'ebay_fulfillment_plans', 'shopify_fulfillment_plans'].map(
    (t) => [t, 'order_id', 'zewnętrzne zlecenia realizacji'] as const,
  ),
  ['b2b_dropship_lines', 'customer_order_id', 'zewnętrzne zlecenia realizacji'],
  ['b2b_network_orders', 'source_order_id', 'zewnętrzne zlecenia realizacji'],
  ['order_source_lines', 'source_order_id', 'zewnętrzne zlecenia realizacji'],
];
/** Reasons of every present relationship. Tables this copy or role cannot read are skipped. */
export async function blockers(c: PoolClient, orderId: string, list: readonly Blocker[]): Promise<string[]> {
  const present = (
    await c.query(
      `SELECT x.t,x.col FROM unnest($1::text[],$2::text[]) x(t,col) JOIN pg_attribute a ON a.attrelid=to_regclass('public.'||x.t)
        AND a.attname=x.col AND NOT a.attisdropped WHERE has_table_privilege(to_regclass('public.'||x.t),'SELECT')`,
      [list.map((b) => b[0]), list.map((b) => b[1])],
    )
  ).rows as { t: string; col: string }[];
  const checks = list.filter((b) => present.some((p) => p.t === b[0] && p.col === b[1]));
  if (!checks.length) return [];
  const hits = (
    await c.query(
      // Identifiers and filters come from the fixed lists above, never from a request.
      'SELECT ARRAY[' +
        checks
          .map(([t, col, , extra]) => `EXISTS(SELECT 1 FROM public."${t}" WHERE "${col}"=$1${extra ? ' AND ' + extra : ''})`)
          .join(',') +
        '] AS hits',
      [orderId],
    )
  ).rows[0].hits as boolean[];
  return [...new Set(checks.filter((_, i) => hits[i]).map((b) => b[2]))];
}
/** A buyer-portal delivery change lives in the 166 sidecar and wins over orders.address. */
export async function buyerDeliveryChanged(c: PoolClient, orderId: string): Promise<boolean> {
  const readable = (
    await c.query(
      "SELECT to_regclass('public.buyer_address_state') IS NOT NULL AND has_table_privilege('public.buyer_address_state','SELECT') AS ok",
    )
  ).rows[0].ok;
  if (!readable) return false;
  return Boolean(
    (await c.query('SELECT 1 FROM buyer_address_state WHERE order_id=$1 AND delivery_version>0', [orderId])).rowCount,
  );
}

export async function updateOrderCustomerInTx(
  c: PoolClient,
  a: Actor,
  id: string,
  input: z.infer<typeof orderCustomerInput>,
  actorName: string | null = null,
) {
  const o = await lockedOrder(c, id);
  ensure(String(o.version) === input.expected_version, 409, ORDER_EDIT_CONFLICT);
  ensure(orderFulfillmentKind(o) === 'sale', 409, 'Odbiorca wymiany reklamacyjnej jest zapisany w reklamacji i nie podlega edycji');
  ensure(ORDER_CUSTOMER_EDIT_STATUSES.includes(o.status), 409, 'Dane klienta można zmienić tylko przed nadaniem przesyłki');
  ensure(input.email !== '' || o.source === 'amazon', 422, 'email: Podaj adres e-mail klienta');
  const reasons = await blockers(c, id, DELIVERY_BLOCKERS);
  ensure(!reasons.length, 409, 'Nie można zmienić danych klienta, bo zamówienie ma ' + reasons.join(', ') + '. Najpierw anuluj przesyłkę.');
  const before = o.address ?? {};
  const address = { ...before, street: input.street, postal_code: input.postal_code, city: input.city, phone: input.phone };
  const changed = [
    ...(o.customer_name !== input.customer_name ? ['customer_name'] : []),
    ...(o.email !== input.email ? ['email'] : []),
    ...(['street', 'postal_code', 'city', 'phone'] as const).filter((k) => (before[k] ?? '') !== address[k]),
  ];
  if (!changed.length) return getOrder(c, id);
  if (changed.some((k) => ['street', 'postal_code', 'city', 'phone'].includes(k)))
    ensure(
      !(await buyerDeliveryChanged(c, id)),
      409,
      'Kupujący zmienił adres dostawy w portalu. Aktualny adres dostawy zmienisz w panelu adresu dostawy kupującego.',
    );
  await c.query('UPDATE orders SET customer_name=$2,email=$3,address=$4,updated_at=now() WHERE id=$1', [
    id,
    input.customer_name,
    input.email,
    JSON.stringify(address),
  ]);
  // Client decision (Uwagi v3 §6): the history keeps the values before and after; the RODO export
  // carries them and anonymisation replaces them. The audit log keeps field names only.
  const value = (o: { customer_name: string; email: string }, addr: Row, k: string) =>
    String((k === 'customer_name' ? o.customer_name : k === 'email' ? o.email : addr[k]) ?? '');
  const changes = changed.map((k) => ({
    field: k,
    label: CUSTOMER_FIELD_LABELS[k] ?? k,
    before: value(o, before, k),
    after: value(input, address, k),
  }));
  await event(c, a.tenantId, id, 'order.customer_updated', {
    fields: changed,
    section: 'customer',
    actor_id: a.userId,
    actor_name: actorName,
    changes,
  });
  await audit(c, a, 'order.customer_update', id, { fields: changed });
  return getOrder(c, id);
}

async function admitLineEdit(c: PoolClient, a: Actor, id: string, expected: string) {
  // As createOrder and cancelOrder: the order writer is pinned by the final WMS role check.
  enlistWmsActorInTx(c, a, { orders: true });
  await c.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))', [`catalog:${a.tenantId}`]);
  const o = await lockedOrder(c, id);
  ensure(String(o.version) === expected, 409, ORDER_EDIT_CONFLICT);
  ensure(orderFulfillmentKind(o) === 'sale', 409, 'Pozycji wymiany reklamacyjnej nie można edytować');
  ensure(
    ORDER_LINE_EDIT_STATUSES.includes(o.status),
    409,
    'Pozycje można zmieniać tylko przed rozpoczęciem kompletacji',
  );
  ensure(
    !['order_split', 'order_merge'].includes(o.source),
    409,
    'Pozycji zamówienia powstałego z podziału lub łączenia nie można edytować',
  );
  await lockWarehouseInventoryPoliciesInTx(c, [o.warehouse_id], { sellable: true });
  const reasons = await blockers(c, id, LINE_BLOCKERS);
  ensure(!reasons.length, 409, 'Nie można zmienić pozycji, bo zamówienie ma ' + reasons.join(', '));
  return o;
}
function recipe(item: Row): { product_id: string; quantity: number }[] {
  return Array.isArray(item.components) && item.components.length
    ? item.components.map((x: Row) => ({ product_id: x.product_id, quantity: Number(x.quantity) }))
    : [{ product_id: item.product_id, quantity: 1 }];
}
/** New quantity per location: every kept row stays >=1 (rows are never deleted), current
 * placement is preserved first, then further free bins in location order. */
async function placeLocations(
  c: PoolClient,
  a: Actor,
  o: Row,
  product: Row,
  target: number,
  rows: Row[],
) {
  ensure(
    target >= rows.length,
    409,
    `Ilości ${product.sku} nie można zmniejszyć poniżej ${rows.length} szt.: tyle lokalizacji ma jej rezerwacja`,
  );
  const bins = await binStock(c, o.warehouse_id, product.id);
  const capacity = new Map<string, number>(bins.map((b) => [b.location, Math.max(0, Number(b.available))]));
  // The order's own rows (active reservation) are free for it.
  for (const r of rows) capacity.set(r.location, (capacity.get(r.location) ?? 0) + r.quantity);
  const plan = new Map<string, number>();
  let left = target;
  for (const r of rows) {
    ensure((capacity.get(r.location) ?? 0) >= 1, 409, `Za mało towaru ${product.sku} w lokalizacji ${r.location}`);
    plan.set(r.location, 1);
    left--;
  }
  const grow = (location: string, limit: number) => {
    const take = Math.min(left, Math.max(0, limit - (plan.get(location) ?? 0)));
    if (take > 0) plan.set(location, (plan.get(location) ?? 0) + take);
    left -= take;
  };
  for (const r of rows) grow(r.location, Math.min(r.quantity, capacity.get(r.location) ?? 0));
  for (const r of rows) grow(r.location, capacity.get(r.location) ?? 0);
  for (const b of bins) if (!rows.some((r) => r.location === b.location)) grow(b.location, capacity.get(b.location) ?? 0);
  ensure(left === 0, 409, `Brak dostępnego towaru ${product.sku} w lokalizacjach magazynu`);
  for (const [location, q] of plan) {
    const row = rows.find((r) => r.location === location);
    if (!row)
      await c.query(
        'INSERT INTO reservation_locations(tenant_id,order_id,product_id,warehouse_id,location,quantity) VALUES($1,$2,$3,$4,$5,$6)',
        [a.tenantId, o.id, product.id, o.warehouse_id, location, q],
      );
    else if (row.quantity !== q)
      await c.query('UPDATE reservation_locations SET quantity=$4 WHERE order_id=$1 AND product_id=$2 AND location=$3', [
        o.id,
        product.id,
        location,
        q,
      ]);
  }
}
/** Bring picks, reservations, locations and stock.reserved to the current sale lines. */
async function syncCustody(c: PoolClient, a: Actor, o: Row) {
  const lots = (await wmsLotsPolicyInTx(c)).enabled;
  const items = (await c.query('SELECT product_id,quantity,components FROM order_items WHERE order_id=$1', [o.id])).rows;
  const need = new Map<string, number>();
  for (const i of items)
    for (const part of recipe(i)) need.set(part.product_id, (need.get(part.product_id) ?? 0) + part.quantity * i.quantity);
  const picks = (await c.query('SELECT * FROM order_pick_items WHERE order_id=$1 ORDER BY product_id FOR UPDATE', [o.id])).rows;
  const reservations = (await c.query('SELECT * FROM reservations WHERE order_id=$1 ORDER BY product_id FOR UPDATE', [o.id])).rows;
  const locations = (
    await c.query('SELECT * FROM reservation_locations WHERE order_id=$1 ORDER BY product_id,location FOR UPDATE', [o.id])
  ).rows;
  ensure(
    picks.every((p) => p.scanned === 0) && locations.every((l) => l.scanned === 0),
    409,
    'Zamówienie ma już skany kompletacji',
  );
  const products = [...new Set([...need.keys(), ...picks.map((p) => p.product_id as string)])].sort();
  for (const productId of products) {
    const target = need.get(productId) ?? 0;
    const pick = picks.find((p) => p.product_id === productId);
    const r = reservations.find((x) => x.product_id === productId);
    const held = r?.state === 'active' ? r.quantity : 0;
    if (target === (pick?.quantity ?? 0) && target === held) continue;
    ensure(!r || ['active', 'released'].includes(r.state), 409, 'Rezerwacja produktu nie jest aktywna');
    ensure(
      !r || (r.consumed_quantity ?? 0) === 0 && (r.released_quantity ?? 0) === 0,
      409,
      'Rezerwacja produktu została częściowo wydana lub zwolniona',
    );
    ensure(Number.isSafeInteger(target) && target <= 10000000, 422, 'Za duża ilość składnika');
    const p = (
      await c.query(
        'SELECT p.id,p.sku,p.name,p.ean,p.active,p.kind,s.available FROM products p JOIN stock s ON s.product_id=p.id AND s.tenant_id=p.tenant_id WHERE p.id=$1 AND s.warehouse_id=$2 FOR UPDATE OF s',
        [productId, o.warehouse_id],
      )
    ).rows[0];
    ensure(p, 404, 'Produkt nie istnieje w magazynie zamówienia');
    if (target > held) {
      ensure(p.active && ['simple', 'variant'].includes(p.kind), 422, `Składnik ${p.sku} jest nieaktywny lub nie jest produktem fizycznym`);
      ensure(p.available >= target - held, 409, `Za mało towaru: ${p.sku}. Dostępne: ${p.available}`);
    }
    if (target !== held)
      await c.query('UPDATE stock SET reserved=reserved+$1 WHERE product_id=$2 AND warehouse_id=$3', [
        target - held,
        productId,
        o.warehouse_id,
      ]);
    // Location rows reference their reservation (immediate FK): the reservation row comes first.
    if (!r && target > 0)
      await c.query('INSERT INTO reservations(tenant_id,order_id,product_id,warehouse_id,quantity) VALUES($1,$2,$3,$4,$5)', [
        a.tenantId,
        o.id,
        productId,
        o.warehouse_id,
        target,
      ]);
    else if (r && target > 0)
      await c.query("UPDATE reservations SET quantity=$3,state='active' WHERE order_id=$1 AND product_id=$2", [
        o.id,
        productId,
        target,
      ]);
    else if (r && r.state === 'active')
      await c.query("UPDATE reservations SET state='released' WHERE order_id=$1 AND product_id=$2", [o.id, productId]);
    const lot = { order_id: o.id, product_id: productId, warehouse_id: o.warehouse_id, quantity: target };
    if (lots && target === 0) await releaseWmsLotsInTx(c, a, o.id, productId);
    // A product new to the order reserves its layers and locations exactly as createOrder does.
    else if (lots && !r) await reserveWmsLotsInTx(c, a, lot);
    else if (lots) await resizeWmsLotsInTx(c, a, { ...lot, revision: String(o.version) });
    // The reservation is active now, so binStock counts its existing rows as held by this order.
    else if (target > 0)
      await placeLocations(c, a, o, p, target, locations.filter((l) => l.product_id === productId));
    if (!pick && target > 0)
      await c.query(
        'INSERT INTO order_pick_items(id,tenant_id,order_id,product_id,sku,name,ean,quantity) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
        [randomUUID(), a.tenantId, o.id, productId, p.sku, p.name, p.ean ?? '', target],
      );
    else if (pick && target > 0) await c.query('UPDATE order_pick_items SET quantity=$2 WHERE id=$1', [pick.id, target]);
    else if (pick) await c.query('DELETE FROM order_pick_items WHERE id=$1', [pick.id]);
  }
}
/** Total follows the line change exactly: shipping + sum of lines, as in createOrder. */
async function applyTotal(c: PoolClient, o: Row, lineDelta: number) {
  const total = Number(o.total) + lineDelta;
  ensure(Number.isSafeInteger(total) && total >= 0 && total <= 2147483647, 422, 'Wartość zamówienia przekracza limit');
  await c.query('UPDATE orders SET total=$2,updated_at=now() WHERE id=$1', [o.id, total]);
}
/** After a line edit the payment stage follows the prepaid balance (decision 6.11.2026): an order ready to
 * fulfil (paid, "Nowe") that now costs more than was paid goes back to new ("Nieopłacone"), so the surcharge
 * reaches the payment desk like any bank transfer; an order in new whose received money covers the edited
 * total moves to paid. Cash on delivery collects the new total at the door, and trade credit covers its order. */
export async function settlePaymentStage(c: PoolClient, a: Actor, o: Row) {
  if (!['new', 'paid'].includes(o.status) || o.payment_mode !== 'prepaid') return;
  if ((await c.query('SELECT 1 FROM b2b254_trade_charges WHERE tenant_id=$1 AND order_id=$2', [a.tenantId, o.id])).rowCount)
    return;
  const balance = await paymentBalance(c, o.id);
  const due = Number(balance.amount_due), received = Number(balance.received);
  if (o.status === 'paid' && due > 0) {
    await c.query("UPDATE orders SET status='new',updated_at=now() WHERE id=$1 AND status='paid'", [o.id]);
    await event(c, a.tenantId, o.id, 'order.payment_reopened', { from: 'paid', to: 'new', amount_due: due });
  } else if (o.status === 'new' && due === 0 && received > 0) {
    await c.query("UPDATE orders SET status='paid',updated_at=now() WHERE id=$1 AND status='new'", [o.id]);
    await event(c, a.tenantId, o.id, 'order.paid', { from: 'new', to: 'paid', scope: 'order_edit' });
  }
}
async function lineOf(c: PoolClient, orderId: string, itemId: string) {
  const line = (await c.query('SELECT * FROM order_items WHERE id=$1 AND order_id=$2 FOR UPDATE', [itemId, orderId])).rows[0];
  ensure(line, 404, 'Nie znaleziono pozycji zamówienia');
  return line;
}

export async function addOrderItemInTx(c: PoolClient, a: Actor, id: string, input: z.infer<typeof orderItemAddInput>) {
  const o = await admitLineEdit(c, a, id, input.expected_version);
  const product = (
    await c.query(
      input.product_id ? 'SELECT * FROM products WHERE id=$1 FOR SHARE' : 'SELECT * FROM products WHERE sku=$1 FOR SHARE',
      [input.product_id ?? input.sku],
    )
  ).rows[0];
  ensure(product, 404, 'Nie znaleziono produktu');
  ensure(product.active && product.kind !== 'group', 422, 'Produkt jest nieaktywny lub jest grupą wariantów');
  ensure(
    !(await c.query('SELECT 1 FROM order_items WHERE order_id=$1 AND product_id=$2', [id, product.id])).rowCount,
    409,
    'Produkt jest już w zamówieniu. Zmień ilość w jego pozycji.',
  );
  if (await productCatalogsAvailable(c)) {
    await resolveProductCatalogInTx(c, product.catalog_id);
    await assertProductCatalogWarehouseInTx(c, product.catalog_id, o.warehouse_id);
  }
  const quote = await prices(c, [product.id], o.price_list_id ?? undefined, a.tenantId);
  ensure(quote.currency === o.currency, 422, 'Waluta ceny produktu nie zgadza się z walutą zamówienia');
  const price = quote.items[0].price;
  const components =
    product.kind === 'bundle'
      ? (await c.query('SELECT product_id,quantity FROM bundle_components WHERE bundle_id=$1 ORDER BY product_id', [product.id])).rows
      : [{ product_id: product.id, quantity: 1 }];
  ensure(components.length > 0, 422, 'Zestaw nie ma składników');
  const lineTotal = price * input.quantity;
  ensure(Number.isSafeInteger(lineTotal) && lineTotal <= 2147483647, 422, 'Nieprawidłowa kwota pozycji');
  await c.query(
    'INSERT INTO order_items(id,tenant_id,order_id,product_id,name,sku,quantity,price,vat,line_total,components) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
    [randomUUID(), a.tenantId, id, product.id, product.name, product.sku, input.quantity, price, product.vat, lineTotal, JSON.stringify(components)],
  );
  await syncCustody(c, a, o);
  await applyTotal(c, o, lineTotal);
  await event(c, a.tenantId, id, 'order.item_added', { sku: product.sku, quantity: input.quantity, line_total: lineTotal });
  await settlePaymentStage(c, a, o);
  await audit(c, a, 'order.item_add', id, { product_id: product.id, quantity: input.quantity, line_total: lineTotal });
  return getOrder(c, id);
}

export async function updateOrderItemInTx(
  c: PoolClient,
  a: Actor,
  id: string,
  itemId: string,
  input: z.infer<typeof orderItemQuantityInput>,
) {
  const o = await admitLineEdit(c, a, id, input.expected_version);
  const line = await lineOf(c, id, itemId);
  if (line.quantity === input.quantity) return getOrder(c, id);
  const lineTotal = line.price * input.quantity;
  ensure(Number.isSafeInteger(lineTotal) && lineTotal <= 2147483647, 422, 'Nieprawidłowa kwota pozycji');
  await c.query('UPDATE order_items SET quantity=$2,line_total=$3 WHERE id=$1', [itemId, input.quantity, lineTotal]);
  await syncCustody(c, a, o);
  await applyTotal(c, o, lineTotal - line.line_total);
  await event(c, a.tenantId, id, 'order.item_quantity_changed', { sku: line.sku, from: line.quantity, to: input.quantity });
  await settlePaymentStage(c, a, o);
  await audit(c, a, 'order.item_quantity', id, { item_id: itemId, from: line.quantity, to: input.quantity });
  return getOrder(c, id);
}

export async function removeOrderItemInTx(
  c: PoolClient,
  a: Actor,
  id: string,
  itemId: string,
  input: z.infer<typeof orderItemRemoveInput>,
) {
  const o = await admitLineEdit(c, a, id, input.expected_version);
  const line = await lineOf(c, id, itemId);
  const count = (await c.query('SELECT count(*)::int n FROM order_items WHERE order_id=$1', [id])).rows[0].n;
  ensure(count > 1, 409, 'Zamówienie musi mieć co najmniej jedną pozycję. Aby zrezygnować z całości, anuluj zamówienie.');
  await c.query('DELETE FROM order_items WHERE id=$1', [itemId]);
  await syncCustody(c, a, o);
  await applyTotal(c, o, -line.line_total);
  await event(c, a.tenantId, id, 'order.item_removed', { sku: line.sku, quantity: line.quantity });
  await settlePaymentStage(c, a, o);
  await audit(c, a, 'order.item_remove', id, { item_id: itemId, product_id: line.product_id, quantity: line.quantity });
  return getOrder(c, id);
}

/** Manual reservation (automation effects) is admitted exactly like a line edit: a sale before picking,
 * not from a split/merge, without documents, shipping, scans or external custody. */
async function admitReservationEdit(c: PoolClient, a: Actor, id: string) {
  enlistWmsActorInTx(c, a, { orders: true });
  await c.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))', [`catalog:${a.tenantId}`]);
  const o = await lockedOrder(c, id);
  ensure(orderFulfillmentKind(o) === 'sale', 409, 'Rezerwacji wymiany reklamacyjnej nie można zmieniać ręcznie');
  ensure(ORDER_LINE_EDIT_STATUSES.includes(o.status), 409, 'Rezerwację można zmienić tylko przed rozpoczęciem kompletacji');
  ensure(
    !['order_split', 'order_merge'].includes(o.source),
    409,
    'Rezerwacji zamówienia powstałego z podziału lub łączenia nie można zmieniać ręcznie',
  );
  await lockWarehouseInventoryPoliciesInTx(c, [o.warehouse_id], { sellable: true });
  const reasons = await blockers(c, id, LINE_BLOCKERS);
  ensure(!reasons.length, 409, 'Nie można zmienić rezerwacji, bo zamówienie ma ' + reasons.join(', '));
  return o;
}
/** Reserves the order's physical lines again as a line edit does (syncCustody). False when every line is reserved. */
export async function reserveOrderStockInTx(c: PoolClient, a: Actor, id: string): Promise<boolean> {
  const o = await admitReservationEdit(c, a, id);
  const missing = (
    await c.query(
      `SELECT 1 FROM order_pick_items p LEFT JOIN reservations r ON (r.tenant_id,r.order_id,r.product_id)=(p.tenant_id,p.order_id,p.product_id)
        WHERE p.order_id=$1 AND (r.state IS DISTINCT FROM 'active' OR r.quantity<>p.quantity) LIMIT 1`,
      [id],
    )
  ).rowCount;
  if (!missing) return false;
  await syncCustody(c, a, o);
  await c.query('UPDATE orders SET updated_at=now() WHERE id=$1', [id]);
  await event(c, a.tenantId, id, 'order.stock_reserved', {});
  await audit(c, a, 'order.stock_reserve', id, {});
  return true;
}
/** Releases the order's active reservations as cancelOrder does, keeping the order open. Picking refuses
 * an order with a released reservation (domain transition) until reserveOrderStockInTx reserves it again.
 * False when nothing is reserved. */
export async function releaseOrderStockInTx(c: PoolClient, a: Actor, id: string): Promise<boolean> {
  await admitReservationEdit(c, a, id);
  // WMS layer rows are immutable once released; re-reserving them is not a supported path.
  ensure(!(await wmsLotsPolicyInTx(c)).enabled, 409, 'Przy partiach WMS rezerwację zwalnia anulowanie zamówienia');
  const reservations = (
    await c.query("SELECT * FROM reservations WHERE order_id=$1 AND state='active' ORDER BY product_id FOR UPDATE", [id])
  ).rows;
  if (!reservations.length) return false;
  for (const r of reservations)
    await c.query('UPDATE stock SET reserved=reserved-$1 WHERE product_id=$2 AND warehouse_id=$3', [
      r.quantity,
      r.product_id,
      r.warehouse_id,
    ]);
  await c.query("UPDATE reservations SET state='released' WHERE order_id=$1 AND state='active'", [id]);
  await c.query('UPDATE orders SET updated_at=now() WHERE id=$1', [id]);
  await event(c, a.tenantId, id, 'order.stock_released', { products: reservations.length });
  await audit(c, a, 'order.stock_release', id, { products: reservations.map((r) => r.product_id) });
  return true;
}
