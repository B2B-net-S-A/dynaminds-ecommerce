import type { PoolClient } from 'pg';
import { ensure } from './errors';

export type B2bExternalIntentState = {
  version: number;
  state: 'open' | 'closed';
  items: Array<{
    customer_item_id: string;
    quantity: number;
    local_quantity: number;
    external_quantity: number;
    unassigned_quantity: number;
    link_id: string | null;
    committed_quantity: number;
    dispatched_quantity: number;
  }>;
  local_quantity: number;
  unassigned_quantity: number;
  uncommitted_quantity: number;
};

async function present(c: PoolClient) {
  const probe = (
    await c.query(`SELECT
    to_regclass('public.b2b_external_order_intents') IS NOT NULL head,
    to_regclass('public.b2b_external_order_intent_revisions') IS NOT NULL revisions,
    to_regclass('public.b2b_external_order_allocation_proofs') IS NOT NULL proofs,
    to_regclass('public.b2b_external_order_created_orders') IS NOT NULL created_orders,
    to_regprocedure('public.b2b_external_intent_installed()') IS NOT NULL installed_probe,
    to_regprocedure('public.b2b_external_intent_complete()') IS NOT NULL completion,
    to_regprocedure('public.b2b_external_allocate(uuid,uuid,uuid,jsonb,boolean)') IS NOT NULL allocate,
    to_regprocedure('public.b2b_external_create_proof(uuid,uuid)') IS NOT NULL create_proof,
    to_regprocedure('public.b2b_external_fields_write_allowed(uuid,uuid,boolean)') IS NOT NULL field_grant,
    to_regprocedure('public.b2b_external_intent_fulfilled(uuid)') IS NOT NULL intent_fulfilled,
    to_regprocedure('public.b2b_dropship_fulfillment(uuid)') IS NOT NULL fulfillment`)
  ).rows[0];
  const installed = probe.installed_probe
    ? Boolean((await c.query('SELECT b2b_external_intent_installed() installed')).rows[0].installed)
    : false;
  if (!probe.head && !probe.revisions && !probe.proofs && !probe.created_orders && !installed)
    return false;
  ensure(
    probe.head &&
      probe.revisions &&
      probe.proofs &&
      probe.created_orders &&
      probe.installed_probe &&
      probe.completion &&
      probe.allocate &&
      probe.create_proof &&
      probe.field_grant &&
      probe.intent_fulfilled &&
      probe.fulfillment,
    503,
    'Trwały rejestr intencji realizacji jest niekompletny',
  );
  return true;
}

export async function b2bExternalIntentStateInTx(
  c: PoolClient,
  orderId: string,
): Promise<B2bExternalIntentState | null> {
  if (!(await present(c))) return null;
  const head = (
    await c.query('SELECT * FROM b2b_external_order_intents WHERE order_id=$1', [orderId])
  ).rows[0];
  if (!head) return null;
  const proof = (await c.query('SELECT b2b_dropship_fulfillment($1) rows', [orderId])).rows[0]
    .rows as Array<{ id: string; state: string; dispatched: boolean }>;
  const dispatched = proof.filter((d) => d.state === 'ordered' && d.dispatched).map((d) => d.id);
  const commitments = (
    await c.query(
      `SELECT l.customer_item_id,
    sum(l.quantity)::int committed_quantity,
    coalesce(sum(l.quantity) FILTER(WHERE d.id=ANY($2::uuid[])),0)::int dispatched_quantity
    FROM b2b_dropship_lines l JOIN b2b_dropship_orders d ON(d.tenant_id,d.id)=(l.tenant_id,l.order_id)
    WHERE l.customer_order_id=$1 AND d.state='ordered' GROUP BY l.customer_item_id`,
      [orderId, dispatched],
    )
  ).rows;
  const items = (head.allocations as Array<Record<string, any>>).map((allocation) => {
    const original = (head.original_items as Array<Record<string, any>>).find(
      (i) => i.id === allocation.customer_item_id,
    );
    const commitment = commitments.find((i) => i.customer_item_id === allocation.customer_item_id);
    ensure(original, 503, 'Brakuje pierwotnej pozycji przydziału');
    const item = {
      customer_item_id: String(allocation.customer_item_id),
      quantity: Number(original.quantity),
      local_quantity: Number(allocation.local_quantity),
      external_quantity: Number(allocation.external_quantity),
      unassigned_quantity: Number(allocation.unassigned_quantity),
      link_id: allocation.link_id as string | null,
      committed_quantity: Number(commitment?.committed_quantity ?? 0),
      dispatched_quantity: Number(commitment?.dispatched_quantity ?? 0),
    };
    ensure(
      item.local_quantity + item.external_quantity + item.unassigned_quantity === item.quantity &&
        item.committed_quantity <= item.external_quantity &&
        item.dispatched_quantity <= item.committed_quantity,
      503,
      'Historia realizacji narusza zapisany przydział',
    );
    return item;
  });
  return {
    version: Number(head.version),
    state: head.state,
    items,
    local_quantity: items.reduce((n, i) => n + i.local_quantity, 0),
    unassigned_quantity: items.reduce((n, i) => n + i.unassigned_quantity, 0),
    uncommitted_quantity: items.reduce((n, i) => n + i.external_quantity - i.committed_quantity, 0),
  };
}

export async function b2bExternalIntentAssertInTx(
  c: PoolClient,
  orderId: string,
  kind: 'scan' | 'packed' | 'dispatch' | 'reconcile' | 'merge',
) {
  const state = await b2bExternalIntentStateInTx(c, orderId);
  if (!state) return;
  ensure(
    kind !== 'merge',
    409,
    'Zamówienie z jawnym przydziałem realizacji wymaga zachowania własnych pozycji',
  );
  ensure(state.state === 'open', 409, 'Intencja realizacji jest zamknięta');
  ensure(state.unassigned_quantity === 0, 409, 'Najpierw przydziel wszystkie pozycje zamówienia');
  if (kind !== 'reconcile')
    ensure(
      state.local_quantity > 0,
      409,
      'Zamówienie realizuje dostawca. Odczytaj jego wydanie i uzgodnij realizację zamiast lokalnego pakowania lub nadania.',
    );
  if (kind === 'dispatch' || kind === 'reconcile') {
    ensure(
      state.uncommitted_quantity === 0,
      409,
      'Najpierw zatwierdź wszystkie zewnętrzne zlecenia',
    );
    ensure(
      state.items.every((i) => i.dispatched_quantity === i.external_quantity),
      409,
      'Dostawcy nie potwierdzili jeszcze wydania wszystkich zewnętrznych pozycji',
    );
  }
}

/** Restocking needs original local custody, not a supplier shipment copy. */
export async function assertB2bExternalLocalRestockInTx(
  c: PoolClient,
  orderId: string,
  itemId: string,
  restocked: number,
) {
  if (restocked === 0) return;
  const intent = await b2bExternalIntentStateInTx(c, orderId);
  let localQuantity: number;
  if (intent) {
    const item = intent.items.find((i) => i.customer_item_id === itemId);
    ensure(item, 409, 'Pozycja nie należy do przydziału realizacji');
    localQuantity = item.local_quantity;
  } else {
    const tables = (
      await c.query(`SELECT
      to_regclass('public.b2b_dropship_orders') IS NOT NULL orders,
      to_regclass('public.b2b_dropship_lines') IS NOT NULL lines,
      to_regprocedure('public.b2b_dropship_installed()') IS NOT NULL installed_probe`)
    ).rows[0];
    const installed = tables.installed_probe
      ? Boolean((await c.query('SELECT b2b_dropship_installed() installed')).rows[0].installed)
      : false;
    if (!tables.orders && !tables.lines && !installed) return;
    ensure(
      tables.orders && tables.lines,
      503,
      'Historia zewnętrznych dostaw wymagana do zwrotu jest niekompletna',
    );
    const item = (
      await c.query(
        `SELECT i.quantity,coalesce(sum(l.quantity),0)::int external_quantity
      FROM order_items i LEFT JOIN b2b_dropship_lines l ON(l.tenant_id,l.customer_order_id,l.customer_item_id)=(i.tenant_id,i.order_id,i.id)
      LEFT JOIN b2b_dropship_orders d ON(d.tenant_id,d.id)=(l.tenant_id,l.order_id)
      WHERE i.order_id=$1 AND i.id=$2 AND (l.order_id IS NULL OR d.state='ordered') GROUP BY i.id,i.quantity`,
        [orderId, itemId],
      )
    ).rows[0];
    if (!item || Number(item.external_quantity) === 0) return;
    localQuantity = Number(item.quantity) - Number(item.external_quantity);
  }
  const proof = (
    await c.query(
      `SELECT coalesce(max((line->>'quantity')::int),0)::int issued
    FROM shopify_dispatch_evidence e JOIN shipments s ON(s.tenant_id,s.id,s.order_id)=(e.tenant_id,e.shipment_id,e.order_id)
    CROSS JOIN LATERAL jsonb_array_elements(e.items) line
    WHERE e.order_id=$1 AND s.dispatched_at IS NOT NULL AND line->>'id'=$2`,
      [orderId, itemId],
    )
  ).rows[0];
  const prior = (
    await c.query(
      'SELECT coalesce(sum(restocked),0)::int quantity FROM return_items WHERE order_id=$1 AND item_id=$2',
      [orderId, itemId],
    )
  ).rows[0];
  ensure(
    Number(prior.quantity) + restocked <= Math.min(localQuantity, Number(proof.issued)),
    409,
    'Towar wydany przez dostawcę wymaga osobnej obsługi zwrotu. Do własnego zapasu można przyjąć wyłącznie potwierdzoną lokalną część.',
  );
}
