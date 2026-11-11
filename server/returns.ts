import { getReturnAcceptanceInTx, returnAcceptedSql } from './return-acceptance';
import { lockWarehouseInventoryPoliciesInTx } from './warehouse-inventory-policies';
import { prepareDestinationParcelReceiveInTx } from './return-destinations-parcel';
import { assertB2bExternalLocalRestockInTx } from './b2b-external-order-intent-guards';
import {
  admitLocalReturnReceiveInTx,
  assertLocalReturnReceiveReplayInTx,
  prepareLocalReturnReceiveInTx,
} from './b2b-return-local-origins';
import { randomBytes, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { paymentBalance, appendPayment } from './payments';
import { audit, event, lockedOrder, type Actor, type AuditActor } from './domain';
import { returnPage, returnQuery, type ReturnQuery } from './return-query';
import { ensure } from './errors';
import { wmsLotsPolicyInTx, returnWmsLotsInTx } from './wms-lots';
import { returnWmsLots } from './wms-lots-workflow-schema';
import { assertRefundRemedyInTx } from './order-fulfillment-kind';
import { parcelReturnOrigins } from './order-parcel-return-values';
import { parcelReturnRequiredInTx, parcelReturnOriginsInTx, prepareParcelReturnRequestInTx, finishParcelReturnRequestInTx, prepareParcelReturnReceiveInTx, lockParcelReturnOrderInTx, prepareParcelReturnDecisionInTx, finishParcelReturnAccessInTx } from './order-parcel-returns';
import { prepareReturnCompletionInTx, assertReturnCompletionInTx, retainNativeReturnCompletionInTx,
  replayReturnCompletionInTx, completeReturnCompletionInTx, pinReturnCompletionInTx, enlistReturnCompletionActorInTx,claimFinancialReturnCompletionInTx,
  type ReturnCompletion } from './return-completion';
import { catalogStockReturnDocumentsInTx } from './catalog-stock-return-effects';
import { attachReturnReasonInTx, returnReasonChoicesInTx } from './return-reasons223';
import {
  returnExchangeAvailable,
  returnExchangeMetadataInTx,
  returnExchangeSubstitutionsAvailable,
} from './return-exchanges';
const quantity = z.number().int().min(0).max(100000);
export const returnInput = z.object({
  client_key: z.uuid(),
  parcel_origins: parcelReturnOrigins.optional(),
  kind: z.enum(['return', 'complaint']).default('return'),
  reason: z.string().trim().min(3).max(2000),
  // Optional 223 dictionary choice; the free-text reason stays the native text (none = "other").
  reason_id: z.uuid().optional(),
  warehouse_id: z.uuid().optional(),
  shipping_refund: z.number().int().min(0).max(1000000).default(0),
  items: z
    .array(z.object({ item_id: z.uuid(), quantity: quantity.min(1) }))
    .min(1)
    .max(100),
});
export const receiveInput = z.object({
  origin_id: z.uuid().optional(),
  wms_lots: returnWmsLots.optional(),
  version: z.coerce.number().int().positive(),
  shipping_refund: z.number().int().min(0).max(1000000).default(0),
  note: z.string().trim().min(3).max(2000),
  items: z
    .array(z.object({ item_id: z.uuid(), accepted: quantity, restocked: quantity }))
    .min(1)
    .max(100),
});
export const decisionInput = z.object({
  version: z.coerce.number().int().positive(),
  decision: z.enum(['reject', 'cancel']),
  note: z.string().trim().min(3).max(2000),
});
export const refundInput = z.object({
  version: z.coerce.number().int().positive(),
  amount: z.number().int().min(0).max(2147483647),
  reference: z.string().trim().min(3).max(200),
  confirmed: z.literal(true),
});
type Input = z.infer<typeof returnInput>;
export async function returnOverview(
  c: PoolClient,
  orderId: string,
  q: ReturnQuery = returnQuery.parse({}),
) {
  const page = await returnPage(c, q, orderId);
  const acceptedSql = await returnAcceptedSql(c, 'r');
  const totals = (
    await c.query(
      `SELECT count(*)::int AS count, coalesce(bool_or(NOT legacy),false) AS has_partial, coalesce(bool_and(state IN ('closed','rejected','cancelled')),true) AS all_cases_decided,
   coalesce(sum(CASE WHEN state='requested' THEN requested_shipping WHEN state IN ('refund_pending','closed') THEN refunded_shipping ELSE 0 END),0)::int AS shipping_used,
   coalesce(sum(refund_amount) FILTER(WHERE ${acceptedSql} IS NOT NULL),0)::bigint AS refund_total, coalesce(sum(refund_amount) FILTER(WHERE refunded_at IS NOT NULL),0)::bigint AS settled_total FROM return_cases r WHERE order_id=$1`,
      [orderId],
    )
  ).rows[0];
  const items = (
    await c.query(
      `SELECT i.id,i.sku,i.name,i.quantity,i.line_total,
    coalesce(sum(CASE WHEN r.state='requested' THEN l.requested WHEN r.state IN ('refund_pending','closed') THEN l.accepted ELSE 0 END),0)::int AS committed,
    coalesce(sum(l.accepted) FILTER(WHERE r.state IN ('refund_pending','closed')),0)::int AS returned
    FROM order_items i LEFT JOIN return_items l ON (l.tenant_id,l.order_id,l.item_id)=(i.tenant_id,i.order_id,i.id)
    LEFT JOIN return_cases r ON (r.tenant_id,r.id)=(l.tenant_id,l.return_id) WHERE i.order_id=$1 GROUP BY i.id ORDER BY i.sku`,
      [orderId],
    )
  ).rows;
  const order = (await c.query('SELECT shipping_cost FROM orders WHERE id=$1', [orderId])).rows[0];
  const invoiceCases = (
    await c.query(
      `SELECT r.* FROM return_cases r WHERE r.order_id=$1 AND NOT r.legacy AND ${acceptedSql} IS NOT NULL AND r.refund_amount>0
    AND NOT EXISTS(SELECT 1 FROM invoice_plans p WHERE p.return_id=r.id AND p.state NOT IN ('preview','cancelled')) ORDER BY r.receipt_sequence,r.id LIMIT 25`,
      [orderId],
    )
  ).rows;
  const balance = page.data.length ? await paymentBalance(c, orderId) : null;
  const parcel = await parcelReturnOriginsInTx(c, orderId);
  return {
    cases: page.data.map((r: any) => ({
      ...r,
      settlement_amount:
        r.settlement?.amount ?? Math.min(r.refund_amount, balance?.overpayment ?? 0),
    })),
    meta: page.meta,
    case_count: totals.count,
    has_partial: totals.has_partial,
    all_cases_decided: totals.all_cases_decided,
    invoice_cases: await Promise.all(
      invoiceCases.map(async (r: any) => ({ ...r, ...(await getReturnAcceptanceInTx(c, r)) })),
    ),
    items: items.map((i) => ({ ...i, available: parcel.required ? parcel.origins.filter(o => o.item_id === i.id).reduce((n, o) => n + o.available, 0) : i.quantity - i.committed })),
    parcel_origins_required: parcel.required,
    parcel_origins: parcel.origins,
    shipping_available: order.shipping_cost - totals.shipping_used,
    refund_total: Number(totals.refund_total),
    settled_total: Number(
      (
        await c.query(
          "SELECT coalesce(sum((settlement->>'amount')::integer),0)::bigint AS n FROM return_cases WHERE order_id=$1 AND settlement IS NOT NULL",
          [orderId],
        )
      ).rows[0].n,
    ),
  };
}
export async function getReturn(c: PoolClient, id: string) {
  const r = (await c.query('SELECT * FROM return_cases WHERE id=$1', [id])).rows[0];
  ensure(r, 404, 'Nie znaleziono sprawy zwrotowej');
  const balance = await paymentBalance(c, r.order_id);
  const exchangeAvailable = await returnExchangeAvailable(c);
  const parcel = await parcelReturnOriginsInTx(c, r.order_id, id);
  return {
    ...r,
    stock_receipts: await catalogStockReturnDocumentsInTx(c, id),
    parcel_origins: parcel.origins,
    parcel_origins_required: parcel.required,
    exchange: exchangeAvailable ? await returnExchangeMetadataInTx(c, r, true) : null,
    substitution_available: exchangeAvailable
      ? await returnExchangeSubstitutionsAvailable(c)
      : false,
    can_exchange:
      exchangeAvailable &&
      !parcel.required &&
      r.kind === 'complaint' &&
      r.state === 'requested' &&
      !r.legacy &&
      !r.receipt,
    ...(await getReturnAcceptanceInTx(c, r)),
    reason_choice: (await returnReasonChoicesInTx(c, [id])).get(id) ?? null,
    settlement_amount: r.settlement?.amount ?? Math.min(r.refund_amount, balance.overpayment),
    items: (
      await c.query('SELECT * FROM return_items WHERE return_id=$1 ORDER BY sku,item_id', [id])
    ).rows,
    documents: (
      await c.query('SELECT id,number,mode FROM documents WHERE return_id=$1 ORDER BY created_at', [
        id,
      ])
    ).rows,
  };
}
export async function lockedReturn(c: PoolClient, id: string) {
  const initial = (await c.query('SELECT order_id FROM return_cases WHERE id=$1', [id])).rows[0];
  ensure(initial, 404, 'Nie znaleziono sprawy zwrotowej');
  const order = await lockedOrder(c, initial.order_id);
  const r = (await c.query('SELECT * FROM return_cases WHERE id=$1 FOR UPDATE', [id])).rows[0];
  return { order, r };
}
async function changed(
  c: PoolClient,
  a: AuditActor,
  orderId: string,
  kind: string,
  detail: any,
  legacy = false,
) {
  await c.query('UPDATE orders SET updated_at=now() WHERE id=$1', [orderId]);
  if (!legacy) await event(c, a.tenantId, orderId, kind, detail);
  await audit(c, a, kind, detail.return_id, detail);
}
export async function requestReturn(
  c: PoolClient,
  a: AuditActor,
  orderId: string,
  input: Input,
  legacy = false,
  submittedBy: 'operator' | 'buyer' = 'operator',
) {
  const warehouseHead = (await c.query('SELECT warehouse_id FROM orders WHERE id=$1', [orderId])).rows[0];
  ensure(warehouseHead, 404, 'Nie znaleziono zamówienia');
  const [warehousePolicy] = await lockWarehouseInventoryPoliciesInTx(c, [input.warehouse_id ?? warehouseHead.warehouse_id]);
  const parcelLocked = await lockParcelReturnOrderInTx(c, a, orderId);
  const o = await lockedOrder(c, orderId);
  ensure(
    o.fulfillment_kind !== 'replacement',
    409,
    'Realizacja zastępcza nie jest drugą sprzedażą; kolejną reklamację obsłuż na oryginalnym zamówieniu',
  );
  const previous = (
    await c.query('SELECT * FROM return_cases WHERE client_key=$1', [input.client_key])
  ).rows[0];
  if (previous) {
    ensure(
      previous.order_id === orderId &&
        previous.submitted_by === submittedBy &&
        isDeepStrictEqual(previous.request, input),
      409,
      'Idempotency key dotyczy innego zgłoszenia',
    );
    const result = await getReturn(c, previous.id);
    await finishParcelReturnAccessInTx(c, a, parcelLocked);
    return result;
  }
  ensure(
    [
      'shipped',
      'delivered',
      'completed',
      'return_initiated',
      'return_received',
      'return_completed',
    ].includes(o.status) || (o.status === 'packed' && await parcelReturnRequiredInTx(c, orderId)),
    409,
    'Zwrot dostępny po wydaniu towaru',
  );
  if (submittedBy === 'buyer') {
    const pending = (
      await c.query(
        "SELECT count(*)::int AS n FROM return_cases WHERE order_id=$1 AND submitted_by='buyer' AND state='requested'",
        [orderId],
      )
    ).rows[0].n;
    ensure(pending < 5, 409, 'Pięć zgłoszeń czeka na decyzję; skontaktuj się ze sprzedawcą');
  }
  const overview = await returnOverview(c, orderId);
  ensure(
    new Set(input.items.map((i) => i.item_id)).size === input.items.length,
    422,
    'Pozycje zwrotu nie mogą się powtarzać',
  );
  ensure(
    input.shipping_refund <= overview.shipping_available,
    409,
    'Dostawa została już zgłoszona lub zwrócona',
  );
  const warehouse = input.warehouse_id ?? o.warehouse_id;
  ensure(warehouse === warehousePolicy.warehouse_id && warehousePolicy.usage === 'sale' && warehousePolicy.enabled,
    409, 'Dotychczasowe przyjęcie zwrotu wymaga magazynu sprzedażowego');
  ensure(
    (await c.query('SELECT id FROM warehouses WHERE id=$1', [warehouse])).rowCount,
    404,
    'Nie znaleziono magazynu przyjęcia',
  );
  const sold = (await c.query('SELECT * FROM order_items WHERE order_id=$1 ORDER BY id', [orderId]))
    .rows;
  for (const i of input.items) {
    const row = overview.items.find((x) => x.id === i.item_id);
    ensure(row, 422, 'Pozycja nie należy do zamówienia');
    ensure(
      i.quantity <= row.available,
      409,
      `Za duża ilość zwrotu: ${row.sku}. Pozostało: ${row.available}`,
    );
  }
  const id = randomUUID(),
    number = `${input.kind === 'complaint' ? 'REK' : 'RMA'}-${new Date().getUTCFullYear()}-${randomBytes(4).toString('hex').toUpperCase()}`;
  const parcelRequest = await prepareParcelReturnRequestInTx(c, a, orderId, id, input, legacy, submittedBy);
  await c.query(
    'INSERT INTO return_cases(id,tenant_id,order_id,warehouse_id,number,kind,reason,legacy,client_key,request,requested_shipping,submitted_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
    [
      id,
      a.tenantId,
      orderId,
      warehouse,
      number,
      input.kind,
      input.reason,
      legacy,
      input.client_key,
      JSON.stringify(input),
      input.shipping_refund,
      submittedBy,
    ],
  );
  if (input.reason_id !== undefined) await attachReturnReasonInTx(c, a, id, input.reason_id);
  for (const item of input.items) {
    const i = sold.find((i) => i.id === item.item_id)!;
    await c.query(
      'INSERT INTO return_items(tenant_id,order_id,return_id,item_id,sku,name,components,requested) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [
        a.tenantId,
        orderId,
        id,
        i.id,
        i.sku,
        i.name,
        JSON.stringify(
          i.components.length ? i.components : [{ product_id: i.product_id, quantity: 1 }],
        ),
        item.quantity,
      ],
    );
  }
  await changed(
    c,
    a,
    orderId,
    'return.requested',
    { return_id: id, number, kind: input.kind, submitted_by: submittedBy },
    legacy,
  );
  await finishParcelReturnRequestInTx(c, a, id, parcelRequest);
  const result = await getReturn(c, id);
  await finishParcelReturnAccessInTx(c, a, parcelLocked);
  return result;
}
// Exact cumulative allocation prevents losing or double-refunding remainder cents across cases.
export const allocatedRefund = (total: number, quantity: number, prior: number, accepted: number) =>
  Number(
    (BigInt(total) * BigInt(prior + accepted)) / BigInt(quantity) -
      (BigInt(total) * BigInt(prior)) / BigInt(quantity),
  );
/** Trusted typed148 bridge. An internal callback alone never permits a different
 * physical path: private SQL must identify this actor/key/RMA in this exact TX.
 */
async function certifyDestinationCoreInTx(c: PoolClient, a: AuditActor, id: string,
  admissionId: string, action: 'receive' | 'reject', input: unknown) {
  ensure(z.uuid().safeParse(admissionId).success && a.userId, 403, 'Przyjęcie wymaga własnego dopuszczenia operatora');
  const context = (await c.query("SELECT current_user role,session_user owner,current_setting('app.tenant_id',true) tenant")).rows[0];
  ensure(context.owner === 'postgres' && context.role === 'dyna_app' && context.tenant === a.tenantId,
    403, 'Przyjęcie wymaga własnej transakcji operatora');
  let failed = false;
  try {
    await c.query('RESET ROLE');
    ensure((await c.query("SELECT to_regprocedure('public.return_destination_admission_scope(uuid,uuid,uuid,uuid)') IS NOT NULL AND to_regprocedure('public.return_destination_installed()') IS NOT NULL AND to_regprocedure('public.return_destination_guards()') IS NOT NULL present")).rows[0].present,
      503, 'Niekompletne przyjęcie zwrotu do magazynów');
    ensure((await c.query('SELECT return_destination_installed() AND return_destination_guards() ok')).rows[0].ok,
      503, 'Niekompletne przyjęcie zwrotu do magazynów');
    const scope = (await c.query('SELECT return_destination_admission_scope($1,$2,$3,$4) scope',
      [admissionId, id, a.userId, a.apiKeyId ?? null])).rows[0].scope;
    ensure(scope && scope.action === action && scope.plan?.protocol === 'destinations_v1' &&
      scope.plan.return_id === id && scope.wms_operation_id === admissionId &&
      isDeepStrictEqual(scope.receive_input, input), 409, 'Dopuszczenie nie odpowiada dokładnej decyzji o zwrocie');
    return scope;
  } catch (error) { failed = true; throw error; }
  finally { try { await c.query('SET LOCAL ROLE dyna_app'); } catch (error) { if (!failed) throw error; } }
}
// Older accepted history may lack a sequenced receipt identity. Preserve replay
// readback, but never manufacture an identity or report a new unsequenced receipt.
function returnReceiveOutcome<T extends Record<string, any>>(result: T, reused: boolean) {
  const identity = typeof result.id === 'string' &&
    Number.isInteger(result.receipt_sequence) && result.receipt_sequence > 0
    ? { return_id: result.id, receipt_sequence: result.receipt_sequence } : null;
  ensure(reused || identity, 503, 'Brak trwałej tożsamości nowego przyjęcia zwrotu');
  return { ...result, reused, receive_receipt: identity };
}
export async function receiveReturn(
  c: PoolClient,
  a: Actor,
  id: string,
  input: z.infer<typeof receiveInput>,
  legacy = false,
  internal: { exchangeAdmissionId?: string; destinationAdmissionId?: string;
    applyDestinationPhysical?: () => Promise<void>; beforeFinish?: () => Promise<void>;
    completion?: ReturnCompletion } = {},
) {
  const completion = internal.completion ?? await prepareReturnCompletionInTx(c, a, {
    return_id: id, protocol: legacy ? 'legacy_status' : 'rma', request: input,
  });
  assertReturnCompletionInTx(c, a, completion, id, input);
  const destination = Boolean(internal.destinationAdmissionId);
  let destinationScope: { parcel_payload: unknown } | undefined;
  ensure(!internal.applyDestinationPhysical || destination, 409, 'Adapter fizyczny nie ma dopuszczenia');
  if (destination) {
    ensure(!internal.exchangeAdmissionId && typeof internal.applyDestinationPhysical === 'function' &&
      typeof internal.beforeFinish === 'function', 409, 'Niekompletny adapter przyjęcia zwrotu');
    destinationScope = await certifyDestinationCoreInTx(c, a, id, internal.destinationAdmissionId!, 'receive', input);
  }
  a = await enlistReturnCompletionActorInTx(c,a,completion);
  const warehouseHead = (await c.query('SELECT order_id,warehouse_id FROM return_cases WHERE id=$1', [id])).rows[0];
  ensure(warehouseHead, 404, 'Nie znaleziono zwrotu');
  const [warehousePolicy] = await lockWarehouseInventoryPoliciesInTx(c, [warehouseHead.warehouse_id]);
  const parcelOrderId = warehouseHead.order_id;
  if (parcelOrderId) await lockParcelReturnOrderInTx(c, a, parcelOrderId);
  await admitLocalReturnReceiveInTx(c, a, id);
  const lotPolicy = await wmsLotsPolicyInTx(c);
  const { order: o, r } = await lockedReturn(c, id);
  const exchange = Boolean(internal.exchangeAdmissionId);
  ensure(
    exchange || r.remedy !== 'exchange',
    409,
    'Wymianę przyjmij przez dedykowaną zgodę reklamacyjną',
  );
  if (exchange)
    ensure(
      (
        await c.query('SELECT return_exchange_receive_admission($1,$2,$3) ok', [
          internal.exchangeAdmissionId,
          id,
          JSON.stringify(input),
        ])
      ).rows[0].ok,
      409,
      'Brak bieżącej zgody na przyjęcie wymiany',
    );
  await assertCoordinatedReturnWriteInTx(c, id);
  ensure(
    (await c.query('SELECT b2b_network_return_dispatched($1) dispatched', [id])).rows[0]
      .dispatched !== false,
    409,
    'Odbiorca B2B nie potwierdził jeszcze wydania zwrotu przez WZ',
  );
  ensure(
    !r.legacy || legacy || Boolean(input.wms_lots && lotPolicy.enabled),
    409,
    'Pełny zwrot przyjmij przez dotychczasowy proces lub wybierz jego partie WMS',
  );
  if (r.receipt) {
    await assertLocalReturnReceiveReplayInTx(c, a, id, input);
    ensure(
      isDeepStrictEqual(r.receipt, input),
      409,
      'Przyjęcie jest już zapisane z innymi ilościami',
    );
    await replayReturnCompletionInTx(c, a, completion);
    const result = await getReturn(c, id);
    if (!internal.completion) await pinReturnCompletionInTx(c, a, completion);
    return returnReceiveOutcome(result, true);
  }
  ensure(destination || r.warehouse_id === warehousePolicy.warehouse_id && warehousePolicy.usage === 'sale' && warehousePolicy.enabled,
    409, 'Dotychczasowe przyjęcie zwrotu wymaga magazynu sprzedażowego');
  ensure(destination || !input.wms_lots || lotPolicy.enabled, 409, 'Najpierw aktywuj magazyn partii');
  ensure(
    destination || !lotPolicy.enabled || input.wms_lots || input.items.every((i) => i.restocked === 0),
    409,
    'Przyjęcie zwrotu w WMS wymaga wyboru fragmentów pierwotnego wydania',
  );
  ensure(
    r.state === 'requested' && Number(r.version) === input.version,
    409,
    'Sprawa zmieniła się; odśwież przed przyjęciem',
  );
  await claimFinancialReturnCompletionInTx(c,a,completion);
  const localProof = await prepareLocalReturnReceiveInTx(c, a, id, input);
  const parcelReceive = destination
    ? await prepareDestinationParcelReceiveInTx(c, a, o.id, id, input, destinationScope!.parcel_payload)
    : await prepareParcelReturnReceiveInTx(c, a, o.id, id, input);
  ensure(input.shipping_refund <= r.requested_shipping, 422, 'Zwrot dostawy przekracza zgłoszenie');
  const lines = (
    await c.query(
      'SELECT l.*,i.quantity,i.line_total FROM return_items l JOIN order_items i ON (i.tenant_id,i.order_id,i.id)=(l.tenant_id,l.order_id,l.item_id) WHERE l.return_id=$1 ORDER BY l.item_id',
      [id],
    )
  ).rows;
  ensure(
    input.items.length === lines.length &&
      new Set(input.items.map((i) => i.item_id)).size === lines.length &&
      lines.every((l) => input.items.some((i) => i.item_id === l.item_id)),
    422,
    'Rozpatrz wszystkie zgłoszone pozycje',
  );
  const physical = new Map<string, number>();
  let amount = input.shipping_refund,
    accepted = 0;
  for (const line of lines) {
    const i = input.items.find((i) => i.item_id === line.item_id)!;
    ensure(
      i.accepted <= line.requested && i.restocked <= i.accepted,
      422,
      'Ilość przyjęta lub przywracana do sprzedaży przekracza zgłoszenie',
    );
    const prior = Number(
      (
        await c.query(
          "SELECT coalesce(sum(l.accepted),0) AS n FROM return_items l JOIN return_cases r ON (r.tenant_id,r.id)=(l.tenant_id,l.return_id) WHERE l.order_id=$1 AND l.item_id=$2 AND r.state IN ('refund_pending','closed')",
          [o.id, line.item_id],
        )
      ).rows[0].n,
    );
    ensure(prior + i.accepted <= line.quantity, 409, 'Przyjęto już tę ilość w innej sprawie');
    const refund = exchange
      ? 0
      : allocatedRefund(line.line_total, line.quantity, prior, i.accepted);
    amount += refund;
    accepted += i.accepted;
    await assertB2bExternalLocalRestockInTx(c, o.id, i.item_id, i.restocked);
    await c.query(
      'UPDATE return_items SET accepted=$1,restocked=$2,refund_amount=$3 WHERE return_id=$4 AND item_id=$5',
      [i.accepted, i.restocked, refund, id, i.item_id],
    );
    for (const component of line.components)
      if (i.restocked)
        physical.set(
          component.product_id,
          (physical.get(component.product_id) ?? 0) + i.restocked * component.quantity,
        );
  }
  ensure(accepted > 0, 422, 'Przyjmij przynajmniej jedną sztukę lub odrzuć zgłoszenie');
  if (destination) await internal.applyDestinationPhysical!();
  const restockBins = new Map<string, Map<string, number>>();
  let legacyUnknown: { product_id: string; quantity: number; location: string }[] | undefined;
  if (!destination && lotPolicy.enabled && physical.size) {
    const wms = input.wms_lots!;
    ensure(wms.policy_version === lotPolicy.version, 409, 'Polityka WMS zmieniła wersję');
    ensure(
      wms.stock_versions.length === physical.size &&
        new Set(wms.stock_versions.map((v) => v.product_id)).size === physical.size,
      422,
      'Podaj dokładnie wersje fizycznych produktów tego zwrotu',
    );
    const fragments = (
      await c.query(
        `SELECT id,product_id,quantity FROM wms_issue_fragments
      WHERE order_id=$1 ORDER BY product_id,id`,
        [o.id],
      )
    ).rows;
    ensure(
      new Set(wms.picks.map((p) => p.issue_fragment_id)).size === wms.picks.length,
      422,
      'Fragment wydania występuje więcej niż raz',
    );
    for (const pick of wms.picks) {
      const fragment = fragments.find((f) => f.id === pick.issue_fragment_id);
      ensure(
        fragment && physical.has(fragment.product_id),
        422,
        'Fragment nie należy do przywracanych składników tego zamówienia',
      );
      const bins = restockBins.get(fragment.product_id) ?? new Map<string, number>();
      bins.set(pick.location, (bins.get(pick.location) ?? 0) + pick.quantity);
      restockBins.set(fragment.product_id, bins);
    }
    if (!fragments.length) {
      ensure(wms.picks.length === 0, 422, 'Historyczne wydanie nie zawiera znanych fragmentów WMS');
      legacyUnknown = [...physical].map(([product_id, quantity]) => ({
        product_id,
        quantity,
        location: 'ZWROT',
      }));
      for (const [product, quantity] of physical)
        restockBins.set(product, new Map([['ZWROT', quantity]]));
    }
    ensure(
      [...physical].every(
        ([product, quantity]) =>
          [...(restockBins.get(product)?.values() ?? [])].reduce((a, b) => a + b, 0) === quantity,
      ),
      422,
      'Fragmenty muszą odpowiadać całej przywracanej ilości fizycznych składników',
    );
    for (const version of [...wms.stock_versions].sort((x, y) =>
      x.product_id.localeCompare(y.product_id),
    )) {
      ensure(
        version.warehouse_id === r.warehouse_id && physical.has(version.product_id),
        422,
        'Wersja zapasu dotyczy obcego zakresu zwrotu',
      );
      const current = (
        await c.query(
          `SELECT version FROM stock
        WHERE warehouse_id=$1 AND product_id=$2 FOR UPDATE`,
          [r.warehouse_id, version.product_id],
        )
      ).rows[0];
      ensure(
        (current?.version ?? '0') === version.version,
        409,
        'Zapas zwrotu zmienił wersję. Odczytaj ponownie cały zakres',
      );
    }
  }
  for (const [product, qty] of (destination ? [] : [...physical.entries()].sort(([a], [b]) => a.localeCompare(b)))) {
    ensure(Number.isSafeInteger(qty) && qty <= 10000000, 422, 'Za duża ilość składnika');
    await c.query(
      "INSERT INTO stock(tenant_id,warehouse_id,product_id,location) VALUES($1,$2,$3,'ZWROT') ON CONFLICT DO NOTHING",
      [a.tenantId, r.warehouse_id, product],
    );
    const s = (
      await c.query(
        'SELECT on_hand FROM stock WHERE warehouse_id=$1 AND product_id=$2 FOR UPDATE',
        [r.warehouse_id, product],
      )
    ).rows[0];
    ensure(s.on_hand + qty <= 2147483647, 409, 'Stan po przyjęciu przekracza limit');
    const bins = restockBins.get(product) ?? new Map([['ZWROT', qty]]);
    for (const [location, quantity] of [...bins].sort(([x], [y]) =>
      Buffer.compare(Buffer.from(x), Buffer.from(y)),
    )) {
      await c.query("SELECT set_config('app.stock_location',$1,true)", [location]);
      await c.query('UPDATE stock SET on_hand=on_hand+$1 WHERE warehouse_id=$2 AND product_id=$3', [
        quantity,
        r.warehouse_id,
        product,
      ]);
      await c.query("SELECT set_config('app.stock_location','',true)");
    }
    await c.query(
      "INSERT INTO stock_movements(id,tenant_id,product_id,warehouse_id,order_id,delta,kind,return_id,note) VALUES($1,$2,$3,$4,$5,$6,'return',$7,$8)",
      [randomUUID(), a.tenantId, product, r.warehouse_id, o.id, qty, id, r.number],
    );
  }
  await c.query(
    exchange
      ? "UPDATE return_cases SET remedy='exchange',state='closed',receipt=$2,refunded_shipping=$3,refund_amount=$4,decision_note=$5,received_at=now(),receipt_sequence=(SELECT coalesce(max(receipt_sequence),0)+1 FROM return_cases WHERE order_id=$6),version=version+1,updated_at=now() WHERE id=$1"
      : "UPDATE return_cases SET state='refund_pending',receipt=$2,refunded_shipping=$3,refund_amount=$4,decision_note=$5,received_at=now(),receipt_sequence=(SELECT coalesce(max(receipt_sequence),0)+1 FROM return_cases WHERE order_id=$6),version=version+1,updated_at=now() WHERE id=$1",
    [id, JSON.stringify(input), input.shipping_refund, amount, input.note, o.id],
  );
  if (!destination && lotPolicy.enabled && physical.size) {
    const wms = input.wms_lots!;
    await returnWmsLotsInTx(
      c,
      a,
      {
        client_key: wms.client_key,
        kind: 'return',
        policy_version: wms.policy_version,
        request: input,
        order_id: o.id,
        return_id: id,
      },
      {
        order_id: o.id,
        return_id: id,
        warehouse_id: r.warehouse_id,
        picks: wms.picks,
        ...(legacyUnknown ? { legacy_unknown: legacyUnknown } : {}),
      },
    );
  }
  const overview = await returnOverview(c, o.id);
  if (overview.items.every((i) => i.returned === i.quantity))
    await c.query(
      "UPDATE orders SET status='return_received',workflow_status_id=NULL WHERE id=$1",
      [o.id],
    );
  await changed(
    c,
    a,
    o.id,
    'return.received',
    {
      return_id: id,
      number: r.number,
      refund_amount: amount,
      accepted,
      restocked: input.items.reduce((n, i) => n + i.restocked, 0),
    },
    legacy,
  );
  // Trusted transaction adapters finish their own evidence/FK writes before
  // the existing custody seals and late authorization pins. Never wire to input.
  await internal.beforeFinish?.();
  retainNativeReturnCompletionInTx(c, a, completion, { local: localProof, parcel: parcelReceive });
  if (!internal.completion) {
    await completeReturnCompletionInTx(c, a, completion);
    await c.query('SET CONSTRAINTS ALL IMMEDIATE');
    const result = await getReturn(c, id);
    await pinReturnCompletionInTx(c, a, completion);
    return returnReceiveOutcome(result, false);
  }
  const result = await getReturn(c, id);
  return returnReceiveOutcome(result, false);
}
export async function decideReturn(
  c: PoolClient,
  a: AuditActor,
  id: string,
  input: z.infer<typeof decisionInput>,
  internal: { destinationAdmissionId?: string; beforeFinish?: () => Promise<void> } = {},
) {
  if (internal.destinationAdmissionId) {
    ensure(input.decision === 'reject' && typeof internal.beforeFinish === 'function', 409,
      'Niekompletny adapter odrzucenia zwrotu');
    await certifyDestinationCoreInTx(c, a, id, internal.destinationAdmissionId, 'reject', input);
  }
  const parcelOrderId = (await c.query('SELECT order_id FROM return_cases WHERE id=$1', [id])).rows[0]?.order_id;
  const parcelLocked = parcelOrderId ? await lockParcelReturnOrderInTx(c, a, parcelOrderId) : false;
  const { order, r } = await lockedReturn(c, id);
  await assertCoordinatedReturnWriteInTx(c, id);
  const state = input.decision === 'reject' ? 'rejected' : 'cancelled';
  if (r.state === state && r.decision_note === input.note) {
    const result = await getReturn(c, id);
    await finishParcelReturnAccessInTx(c, a, parcelLocked);
    return result;
  }
  ensure(!r.legacy, 409, 'Historyczny pełny zwrot obsłuż przez dotychczasowy proces');
  ensure(
    r.state === 'requested' && Number(r.version) === input.version,
    409,
    'Sprawa została już rozpatrzona',
  );
  await prepareParcelReturnDecisionInTx(c, a, order.id, id, input);
  await c.query(
    'UPDATE return_cases SET state=$2,decision_note=$3,version=version+1,updated_at=now() WHERE id=$1',
    [id, state, input.note],
  );
  await changed(c, a, order.id, 'return.' + state, {
    return_id: id,
    number: r.number,
    note: input.note,
  });
  await internal.beforeFinish?.();
  const result = await getReturn(c, id);
  await finishParcelReturnAccessInTx(c, a, parcelLocked);
  return result;
}
export async function recordRefund(
  c: PoolClient,
  a: Actor,
  id: string,
  input: z.infer<typeof refundInput>,
) {
  const { order, r } = await lockedReturn(c, id);
  await assertRefundRemedyInTx(c, id);
  if (r.settlement) {
    ensure(
      isDeepStrictEqual(r.settlement, input),
      409,
      'Potwierdzenie zwrotu ma już inną referencję',
    );
    return getReturn(c, id);
  }
  ensure(
    r.state === 'refund_pending' && Number(r.version) === input.version,
    409,
    'Zwrot nie jest gotowy do rozliczenia lub zmienił się',
  );
  const balance = await paymentBalance(c, order.id);
  const payout = Math.min(r.refund_amount, balance.overpayment);
  ensure(
    input.amount === payout,
    422,
    'Kwota potwierdzenia musi odpowiadać środkom dostępnym do oddania; odśwież saldo',
  );
  if (payout > 0)
    await appendPayment(c, a, order.id, 'return:' + id, input, {
      kind: 'refund',
      amount: payout,
      currency: order.currency,
      method: 'return_confirmation',
      reference: input.reference,
      return_id: id,
    });
  await c.query(
    "UPDATE return_cases SET state='closed',settlement=$2,refunded_at=now(),version=version+1,updated_at=now() WHERE id=$1",
    [id, JSON.stringify(input)],
  );
  const overview = await returnOverview(c, order.id);
  if (overview.items.every((i) => i.returned === i.quantity) && overview.all_cases_decided)
    await c.query(
      "UPDATE orders SET status='return_completed',workflow_status_id=NULL WHERE id=$1",
      [order.id],
    );
  await changed(c, a, order.id, 'return.refund_recorded', {
    return_id: id,
    number: r.number,
    amount: input.amount,
    reference: input.reference,
    scope: 'operator_confirmation_no_payment_call',
  });
  return getReturn(c, id);
}
export async function prepareLegacyReturnCompletionInTx(c: PoolClient, a: Actor, orderId: string) {
  const r = (await c.query("SELECT * FROM return_cases WHERE order_id=$1 AND legacy AND state='requested' ORDER BY id", [orderId])).rows[0];
  ensure(r, 409, 'Brak zgłoszonego pełnego zwrotu');
  const lines = (await getReturn(c, r.id)).items;
  const input = receiveInput.parse({ version: Number(r.version), shipping_refund: r.requested_shipping,
    note: 'Przyjęto cały zwrot do sprzedaży',
    items: lines.map((i: { item_id: string; requested: number }) => ({ item_id: i.item_id, accepted: i.requested, restocked: i.requested })),
  });
  return { completion: await prepareReturnCompletionInTx(c, a, { return_id: r.id, protocol: 'legacy_status', request: input }), id: r.id, input };
}
export async function legacyReturn(c: PoolClient, a: Actor, o: any, status: string,
  prepared?: Awaited<ReturnType<typeof prepareLegacyReturnCompletionInTx>>) {
  const cases = (await c.query('SELECT * FROM return_cases WHERE order_id=$1 ORDER BY id', [o.id]))
    .rows;
  ensure(
    cases.every((r) => r.legacy),
    409,
    'Zamówienie ma sprawy częściowe. Obsłuż przyjęcie i rozliczenie w rejestrze zwrotów',
  );
  if (status === 'return_initiated') {
    const items = (
      await c.query('SELECT id,quantity FROM order_items WHERE order_id=$1 ORDER BY id', [o.id])
    ).rows;
    await requestReturn(
      c,
      a,
      o.id,
      returnInput.parse({
        client_key: randomUUID(),
        reason: 'Pełny zwrot zamówienia',
        shipping_refund: o.shipping_cost,
        items: items.map((i) => ({ item_id: i.id, quantity: i.quantity })),
      }),
      true,
    );
  } else if (status === 'return_received') {
    const r = cases.find((r) => r.state === 'requested');
    ensure(r, 409, 'Brak zgłoszonego pełnego zwrotu');
    const lines = (await getReturn(c, r.id)).items;
    ensure(!prepared || prepared.id === r.id, 409, 'Pełny zwrot zmienił się od przygotowania');
    await receiveReturn(
      c,
      a,
      r.id,
      prepared?.input ?? {
        version: Number(r.version),
        shipping_refund: r.requested_shipping,
        note: 'Przyjęto cały zwrot do sprzedaży',
        items: lines.map((i: any) => ({
          item_id: i.item_id,
          accepted: i.requested,
          restocked: i.requested,
        })),
      },
      true,
      prepared ? { completion: prepared.completion } : {},
    );
  } else if (status === 'return_completed') {
    await c.query(
      "UPDATE return_cases SET state='closed',version=version+1,updated_at=now() WHERE order_id=$1 AND legacy AND state='refund_pending'",
      [o.id],
    );
  }
}
export async function returnDocument(c: PoolClient, a: Actor, id: string) {
  const { order: o, r } = await lockedReturn(c, id);
  await assertRefundRemedyInTx(c, id);
  ensure(!r.legacy, 409, 'Korektę pełnego zwrotu wystaw przez dotychczasowy proces');
  ensure(
    (await getReturnAcceptanceInTx(c, r)).accepted_at &&
      !['requested', 'rejected', 'cancelled'].includes(r.state),
    409,
    'Korekta dostępna po przyjęciu zwrotu',
  );
  const prior = (await c.query("SELECT * FROM documents WHERE return_id=$1 AND mode='demo'", [id]))
    .rows[0];
  if (prior) return prior;
  ensure(
    !(
      await c.query(
        "SELECT id FROM documents WHERE order_id=$1 AND kind='correction' AND mode='demo' AND return_id IS NULL",
        [o.id],
      )
    ).rowCount,
    409,
    'Zamówienie ma już pełną korektę DEMO',
  );
  const original = (
    await c.query("SELECT * FROM documents WHERE order_id=$1 AND kind='invoice' AND mode='demo'", [
      o.id,
    ])
  ).rows[0];
  ensure(original, 409, 'Najpierw wystaw dokument sprzedaży DEMO');
  const lines = (
    await c.query('SELECT * FROM return_items WHERE return_id=$1 AND accepted>0 ORDER BY sku', [id])
  ).rows;
  const items = lines.map((l) => {
    const i = original.data.items.find((i: any) => i.id === l.item_id);
    ensure(i, 409, 'Pozycja nie istnieje na dokumencie pierwotnym');
    return {
      id: i.id,
      name: i.name,
      sku: i.sku,
      quantity: l.accepted,
      vat: i.vat,
      gross: l.refund_amount,
      net: Math.round((l.refund_amount * 100) / (100 + i.vat)),
    };
  });
  const data = {
    ...original.data,
    total: -r.refund_amount,
    shipping_cost: r.refunded_shipping,
    items,
    original: { id: original.id, number: original.number },
    return_number: r.number,
    return_id: r.id,
  };
  const doc = (
    await c.query(
      "INSERT INTO documents(id,tenant_id,order_id,number,kind,data,return_id) VALUES($1,$2,$3,$4,'correction',$5,$6) RETURNING *",
      [
        randomUUID(),
        a.tenantId,
        o.id,
        `DEMO-KOR/${new Date().getUTCFullYear()}/${randomBytes(4).toString('hex').toUpperCase()}`,
        JSON.stringify(data),
        id,
      ],
    )
  ).rows[0];
  await audit(c, a, 'return.document', doc.id, { return_id: id, total: data.total, mode: 'demo' });
  return doc;
}

async function assertCoordinatedReturnWriteInTx(c: PoolClient, id: string) {
  const exists = (
    await c.query(
      "SELECT to_regprocedure('public.b2b_dropship_return_write_allowed(uuid)') IS NOT NULL present",
    )
  ).rows[0].present;
  if (exists)
    ensure(
      (await c.query('SELECT b2b_dropship_return_write_allowed($1) allowed', [id])).rows[0].allowed,
      409,
      'Powiązany zwrot obsłuż przez koordynowane przyjęcie lub decyzję',
    );
  else if (
    (
      await c.query(
        "SELECT EXISTS(SELECT 1 FROM migrations WHERE name='111_b2b_dropshipping_returns') installed",
      )
    ).rows[0].installed
  )
    ensure(false, 503, 'Niekompletna kopia koordynowanych zwrotów');
}
/** Nonphysical acceptance: the private SQL proof derives partner caps and all retail credit. */
export async function applyPartnerReturnAcceptanceInTx(
  c: PoolClient,
  a: Actor,
  id: string,
  proofId: string,
) {
  const { order } = await lockedReturn(c, id);
  await c.query('SELECT b2b_dropship_return_apply_partner($1)', [proofId]);
  await changed(c, a, order.id, 'return.partner_accepted', { return_id: id, proof_id: proofId });
  return getReturn(c, id);
}
