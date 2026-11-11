import {
  b2bExternalIntentAssertInTx,
  b2bExternalIntentStateInTx,
} from './b2b-external-order-intent-guards';
import type { PoolClient } from 'pg';
import { ensure } from './errors';
async function installed(c: PoolClient) {
  const exists = (
    await c.query("SELECT to_regprocedure('public.b2b_dropship_installed()') IS NOT NULL present")
  ).rows[0].present;
  return exists
    ? Boolean((await c.query('SELECT b2b_dropship_installed() installed')).rows[0].installed)
    : false;
}
async function present(c: PoolClient) {
  const state = (
    await c.query("SELECT to_regclass('public.b2b_dropship_orders') IS NOT NULL present")
  ).rows[0];
  ensure(state.present || !(await installed(c)), 503, 'Brakuje trwałego rejestru dropshippingu');
  return Boolean(state.present);
}
export async function b2bDropshipBillToInTx(
  c: PoolClient,
  orderId: string,
): Promise<{
  name: string;
  email: string;
  tax_id: string;
  address: Record<string, string>;
} | null> {
  const state = (
    await c.query("SELECT to_regclass('public.b2b_dropship_supplier_orders') IS NOT NULL present")
  ).rows[0];
  ensure(
    state.present || !(await installed(c)),
    503,
    'Brakuje zamrożonego odbiorcy dokumentu dropshippingowego',
  );
  if (!state.present) return null;
  return (
    (await c.query('SELECT bill_to FROM b2b_dropship_supplier_orders WHERE order_id=$1', [orderId]))
      .rows[0]?.bill_to ?? null
  );
}
export async function assertB2bDropshipCancelableInTx(c: PoolClient, orderId: string) {
  if (!(await present(c))) return;
  ensure(
    !(
      await c.query(
        "SELECT 1 FROM b2b_dropship_orders WHERE customer_order_id=$1 AND state='ordered' LIMIT 1",
        [orderId],
      )
    ).rowCount,
    409,
    'Najpierw anuluj zewnętrzne dostawy i przywróć rezerwacje klienta',
  );
}
export async function assertB2bDropshipMergeableInTx(c: PoolClient, ids: string[]) {
  for (const id of [...ids].sort()) await b2bExternalIntentAssertInTx(c, id, 'merge');
  const tables = (
    await c.query(
      "SELECT to_regclass('public.b2b_dropship_orders') IS NOT NULL buyer,to_regclass('public.b2b_dropship_supplier_orders') IS NOT NULL supplier",
    )
  ).rows[0];
  ensure(
    !(await installed(c)) || (tables.buyer && tables.supplier),
    503,
    'Brakuje trwałych powiązań dropshippingu',
  );
  if (tables.buyer)
    ensure(
      !(
        await c.query(
          "SELECT 1 FROM b2b_dropship_orders WHERE customer_order_id=ANY($1::uuid[]) AND state='ordered' LIMIT 1",
          [ids],
        )
      ).rowCount,
      409,
      'Aktywnej dostawy dropshippingowej nie można scalać',
    );
  if (tables.supplier)
    ensure(
      !(
        await c.query(
          'SELECT 1 FROM b2b_dropship_supplier_orders WHERE order_id=ANY($1::uuid[]) LIMIT 1',
          [ids],
        )
      ).rowCount,
      409,
      'Zamrożonego zamówienia dostawcy nie można scalać',
    );
}
// Only supplier-bound parcels are constrained. Normalize the actual carrier
// payload exactly as the immutable dispatch witness does; lockers prove no street.
export async function assertB2bDropshipParcelReceiverInTx(
  c: PoolClient,
  orderId: string,
  input: { provider?: string; service?: string; receiver?: Record<string, any> },
  payload: Record<string, any>,
) {
  const exists = (
    await c.query("SELECT to_regclass('public.b2b_dropship_supplier_orders') IS NOT NULL present")
  ).rows[0].present;
  ensure(
    exists || !(await installed(c)),
    503,
    'Brakuje zamrożonego odbiorcy dostawy dropshippingowej',
  );
  if (!exists) return;
  const binding = (
    await c.query('SELECT receiver FROM b2b_dropship_supplier_orders WHERE order_id=$1', [orderId])
  ).rows[0];
  if (!binding) return;
  let receiver: unknown = null;
  if (input.provider === 'dpd') {
    const r = payload.packages?.[0]?.receiver;
    if (r)
      receiver = {
        customer_name: r.name,
        email: r.email,
        address: {
          street: r.address,
          city: r.city,
          postal_code: r.postalCode,
          country: r.countryCode,
          phone: r.phone,
        },
      };
  } else if (input.provider === 'dhl' || input.provider === 'pocztapolska') {
    // Same projection as shopify_capture_dispatch() (234): the validated input receiver; a pickup point proves no street.
    const r = input.receiver;
    if (r && input.service !== 'pocztex_punkt')
      receiver = {
        customer_name: r.name,
        email: r.email,
        address: {
          street: r.address,
          city: r.city,
          postal_code: r.postalCode,
          country: r.countryCode,
          phone: r.phone,
        },
      };
  } else if ((input.provider ?? 'inpost') === 'inpost' && input.service === 'inpost_courier_standard') {
    const r = payload.receiver;
    if (r?.address)
      receiver = {
        customer_name: `${r.first_name} ${r.last_name}`,
        email: r.email,
        address: {
          street: `${r.address.street} ${r.address.building_number}`,
          city: r.address.city,
          postal_code: r.address.post_code,
          country: r.address.country_code,
          phone: r.phone,
        },
      };
  }
  ensure(
    receiver &&
      (
        await c.query('SELECT $1::jsonb=$2::jsonb valid', [
          JSON.stringify(receiver),
          JSON.stringify(binding.receiver),
        ])
      ).rows[0].valid,
    409,
    'Paczka dostawcy wymaga dokładnie zatwierdzonego odbiorcy ulicznego',
  );
}
export async function assertB2bDropshipDispatchInTx(c: PoolClient, orderId: string) {
  await b2bExternalIntentAssertInTx(c, orderId, 'dispatch');
  if (!(await present(c))) return;
  ensure(
    (
      await c.query(
        "SELECT to_regprocedure('public.b2b_dropship_fulfillment(uuid)') IS NOT NULL present",
      )
    ).rows[0].present,
    503,
    'Brakuje dowodu realizacji dropshippingu',
  );
  const rows = (await c.query('SELECT b2b_dropship_fulfillment($1) rows', [orderId])).rows[0]
    .rows as Array<{ state: string; dispatched: boolean }>;
  ensure(
    rows.filter((r) => r.state === 'ordered').every((r) => r.dispatched),
    409,
    'Najpierw wydaj wszystkie części zamówienia u dostawców',
  );
  if (rows.some((r) => r.state === 'ordered'))
    ensure(
      (
        await c.query("SELECT 1 FROM reservations WHERE order_id=$1 AND state='active' LIMIT 1", [
          orderId,
        ])
      ).rowCount,
      409,
      'Całkowicie zewnętrzną realizację uzgodnij bez tworzenia pustej lokalnej paczki',
    );
  const binding = (
    await c.query('SELECT receiver FROM b2b_dropship_supplier_orders WHERE order_id=$1', [orderId])
  ).rows[0];
  if (binding)
    ensure(
      (
        await c.query(
          'SELECT customer_name=$2 AND email=$3 AND address=$4::jsonb valid FROM orders WHERE id=$1',
          [
            orderId,
            binding.receiver.customer_name,
            binding.receiver.email,
            JSON.stringify(binding.receiver.address),
          ],
        )
      ).rows[0]?.valid,
      409,
      'Odbiorca dostawcy nie odpowiada zatwierdzonej dostawie',
    );
}
export async function b2bDropshipOrderScopeInTx(c: PoolClient, orderId: string) {
  if (!(await present(c))) return null;
  ensure(
    (
      await c.query(
        "SELECT to_regprocedure('public.b2b_dropship_fulfillment(uuid)') IS NOT NULL present",
      )
    ).rows[0].present,
    503,
    'Brakuje dowodu realizacji dropshippingu',
  );
  const orders = (await c.query('SELECT b2b_dropship_fulfillment($1) rows', [orderId])).rows[0]
    .rows as Array<{ id: string; state: string; dispatched: boolean }>;
  if (!orders.length) return null;
  const dispatched = new Set(
    orders.filter((o) => o.dispatched && o.state === 'ordered').map((o) => o.id),
  );
  const lines = (
    await c.query(
      `SELECT i.id customer_item_id,i.quantity original_quantity,coalesce(sum(l.quantity) FILTER(WHERE d.state='ordered'),0)::int external_committed_quantity,
 coalesce(sum(l.quantity) FILTER(WHERE d.state='ordered' AND d.id=ANY($2::uuid[])),0)::int external_dispatched_quantity
 FROM order_items i LEFT JOIN b2b_dropship_lines l ON(l.tenant_id,l.customer_order_id,l.customer_item_id)=(i.tenant_id,i.order_id,i.id)
 LEFT JOIN b2b_dropship_orders d ON(d.tenant_id,d.id)=(l.tenant_id,l.order_id) WHERE i.order_id=$1 GROUP BY i.id,i.quantity ORDER BY i.id`,
      [orderId, [...dispatched]],
    )
  ).rows;
  const intent = await b2bExternalIntentStateInTx(c, orderId);
  const items = lines.map((l) => ({
    ...l,
    local_required_quantity: intent
      ? intent.items.find((item) => item.customer_item_id === l.customer_item_id)!.local_quantity
      : l.original_quantity - l.external_committed_quantity,
    ...(intent
      ? {
          external_intended_quantity: intent.items.find(
            (item) => item.customer_item_id === l.customer_item_id,
          )!.external_quantity,
          unassigned_quantity: intent.items.find(
            (item) => item.customer_item_id === l.customer_item_id,
          )!.unassigned_quantity,
        }
      : {}),
  }));
  return {
    items,
    orders,
    external_quantity: items.reduce((n, i) => n + i.external_committed_quantity, 0),
    external_dispatched_quantity: items.reduce((n, i) => n + i.external_dispatched_quantity, 0),
    local_required_quantity: items.reduce((n, i) => n + i.local_required_quantity, 0),
    ...(intent
      ? {
          external_intended_quantity: intent.items.reduce((n, i) => n + i.external_quantity, 0),
          unassigned_quantity: intent.unassigned_quantity,
          uncommitted_quantity: intent.uncommitted_quantity,
        }
      : {}),
    reconciled: Boolean(
      (
        await c.query(
          "SELECT 1 FROM b2b_dropship_actions a JOIN b2b_dropship_orders d ON(d.tenant_id,d.id)=(a.tenant_id,a.order_id) WHERE d.customer_order_id=$1 AND a.kind='reconcile' LIMIT 1",
          [orderId],
        )
      ).rowCount,
    ),
  };
}
