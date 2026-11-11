import {
  effectiveOrderMergePaymentBalanceInTx,
  orderMergeOriginalPaymentBalanceInTx,
  orderMergePaymentSourceIdsInTx,
  resolveOrderMergeOwnerInTx,
} from './order-merge-payments';
import { orderMergeClaimInTx } from './order-merge-guards';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { Actor } from './domain';
import { ensure } from './errors';
import { insertAuditEvent } from './audit-log';
import { tradeCreditReleasedInTx } from './b2b-trade-credit-release';
import { event, localOrderEvent } from './events';
import { stampLocalFinancialVersion } from './local-financial-policy';
import { assertSaleFinancialOrderInTx, assertRefundRemedyInTx } from './order-fulfillment-kind';
const amount = z.number().int().min(0).max(2147483647);
export const paymentInput = z
  .object({
    client_key: z.uuid(),
    version: z.coerce.number().int().positive(),
    kind: z.enum(['receipt', 'courier_collection', 'courier_remittance', 'refund']),
    amount,
    fee: amount.default(0),
    currency: z.enum(['PLN', 'EUR', 'USD', 'GBP', 'CZK']),
    method: z.enum(['bank_transfer', 'cash', 'card', 'other']).default('bank_transfer'),
    reference: z.string().trim().min(3).max(200),
    note: z.string().trim().max(2000).default(''),
    shipment_id: z.uuid().optional(),
    confirmed: z.literal(true),
  })
  .strict()
  .refine(
    (b) =>
      b.amount + b.fee > 0 && (b.kind === 'courier_remittance' || (b.amount > 0 && b.fee === 0)),
    'Nieprawidłowa kwota lub prowizja',
  );
export const reversalInput = z
  .object({
    client_key: z.uuid(),
    version: z.coerce.number().int().positive(),
    entry_id: z.uuid(),
    reason: z.string().trim().min(3).max(2000),
    confirmed: z.literal(true),
  })
  .strict();
export const localFinancialContext = z.strictObject({
  effects: z.literal('local_financial_only'),
  provenance: z.strictObject({
    execution_id: z.uuid(),
    row_id: z.uuid(),
    preview_id: z.uuid(),
  }),
});
export type LocalFinancialContext = z.infer<typeof localFinancialContext>;
export const financialPaymentEntry = z
  .strictObject({
    kind: z.enum(['receipt', 'courier_collection', 'courier_remittance']),
    amount,
    fee: amount.default(0),
    currency: paymentInput.shape.currency,
    method: z.enum(['bank_csv', 'courier_csv', 'bank_csv_cod']),
    reference: paymentInput.shape.reference,
    note: paymentInput.shape.note,
    shipment_id: z.uuid().optional(),
  })
  .refine(
    (b) =>
      b.amount + b.fee > 0 && (b.kind === 'courier_remittance' || (b.amount > 0 && b.fee === 0)),
    'Nieprawidłowa kwota lub prowizja',
  )
  .refine(
    (b) =>
      b.method === 'courier_csv'
        ? b.kind !== 'receipt'
        : b.method === 'bank_csv'
          ? b.kind === 'receipt'
          : b.kind === 'courier_remittance',
    'Metoda importu nie odpowiada rodzajowi wpisu',
  );
export type FinancialPaymentEntry = z.input<typeof financialPaymentEntry>;
const financialKey = z
  .string()
  .min(1)
  .max(240)
  .regex(/^[^\x00-\x1f\x7f]+$/);
const financialReversal = z.strictObject({
  entry_id: reversalInput.shape.entry_id,
  reason: reversalInput.shape.reason,
});
async function financialEvent(
  c: PoolClient,
  a: Actor,
  id: string,
  kind: string,
  detail: Record<string, unknown>,
  context?: LocalFinancialContext,
) {
  if (context)
    return localOrderEvent(c, a.tenantId, id, kind, {
      ...detail,
      effects: context.effects,
      provenance: context.provenance,
    });
  return event(c, a.tenantId, id, kind, detail);
}
async function order(c: PoolClient, id: string, lock = false) {
  if (lock) {
    const owner = await resolveOrderMergeOwnerInTx(c, id);
    await c.query('SELECT id FROM orders WHERE id=$1 FOR UPDATE', [owner]);
    ensure(
      (await resolveOrderMergeOwnerInTx(c, id)) === owner,
      409,
      'Właściciel płatności zmienił się; odśwież zamówienie',
    );
    await assertSaleFinancialOrderInTx(c, id);
    if (owner !== id) await assertSaleFinancialOrderInTx(c, owner);
  }
  const o = (await c.query('SELECT * FROM orders WHERE id=$1', [id])).rows[0];
  ensure(o, 404, 'Nie znaleziono zamówienia');
  return o;
}
export async function paymentBalance(c: PoolClient, id: string) {
  // Historical sources show only their own buyer's money. The active owner
  // projects distinct incoming source ledgers without copying entries.
  return (await orderMergeClaimInTx(c, id))
    ? orderMergeOriginalPaymentBalanceInTx(c, id)
    : effectiveOrderMergePaymentBalanceInTx(c, id);
}
export async function paymentHistory(c: PoolClient, id: string, before?: string) {
  const balance = await paymentBalance(c, id);
  const sourceIds = (await orderMergeClaimInTx(c, id))
    ? [id]
    : await orderMergePaymentSourceIdsInTx(c, id);
  const rows = (
    await c.query(
      `SELECT p.*,r.kind AS reversed_kind,EXISTS(SELECT 1 FROM payment_entries v WHERE v.reversal_of=p.id) AS reversed
 FROM payment_entries p LEFT JOIN payment_entries r ON r.id=p.reversal_of WHERE p.order_id=ANY($1::uuid[]) AND ($2::uuid IS NULL OR (p.created_at,p.id)<(SELECT created_at,id FROM payment_entries WHERE order_id=ANY($1::uuid[]) AND id=$2)) ORDER BY p.created_at DESC,p.id DESC LIMIT 51`,
      [sourceIds, before ?? null],
    )
  ).rows;
  return { balance, data: rows.slice(0, 50), next: rows.length > 50 ? rows[49].id : null };
}
async function replay(c: PoolClient, id: string, key: string, input: unknown) {
  const previous = (
    await c.query('SELECT id,request FROM payment_entries WHERE order_id=$1 AND client_key=$2', [
      id,
      key,
    ])
  ).rows[0];
  if (previous)
    ensure(
      isDeepStrictEqual(previous.request, input),
      409,
      'Klucz potwierdzenia użyty z innymi danymi',
    );
  return previous?.id as string | undefined;
}
export type Entry = {
  kind: string;
  amount: number;
  fee?: number;
  currency: string;
  method: string;
  reference: string;
  note?: string;
  shipment_id?: string;
  return_id?: string;
  reversal_of?: string;
};
export async function appendPayment(
  c: PoolClient,
  a: Actor,
  id: string,
  key: string,
  input: unknown,
  b: Entry,
  context?: LocalFinancialContext,
) {
  const effects = context === undefined ? undefined : localFinancialContext.parse(context);
  const ownerId = await resolveOrderMergeOwnerInTx(c, id);
  await c.query('SELECT id FROM orders WHERE id=$1 FOR UPDATE', [ownerId]);
  ensure(
    (await resolveOrderMergeOwnerInTx(c, id)) === ownerId,
    409,
    'Właściciel płatności zmienił się; odśwież zamówienie',
  );
  // Source receipts and financial imports also enter here; validate both identities under the owner lock.
  await assertSaleFinancialOrderInTx(c, id);
  if (ownerId !== id) await assertSaleFinancialOrderInTx(c, ownerId);
  if (b.return_id) await assertRefundRemedyInTx(c, b.return_id);
  ensure(
    !(
      await c.query(
        "SELECT 1 FROM shipping_plans WHERE order_id=$1 AND state NOT IN ('cancelled','dispatched') AND phase IN ('create_started','numbers_ready','buy_started','refresh_started') LIMIT 1",
        [ownerId],
      )
    ).rowCount,
    409,
    'Przesyłka ma rozpoczęty lub niepewny zapis; najpierw uzgodnij wynik przewoźnika',
  );
  const entry = randomUUID();
  await c.query(
    'INSERT INTO payment_entries(id,tenant_id,order_id,client_key,request,kind,amount,fee,currency,method,reference,note,actor_id,shipment_id,return_id,reversal_of) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)',
    [
      entry,
      a.tenantId,
      id,
      key,
      JSON.stringify(input),
      b.kind,
      b.amount,
      b.fee ?? 0,
      b.currency,
      b.method,
      b.reference,
      b.note ?? '',
      a.userId,
      b.shipment_id ?? null,
      b.return_id ?? null,
      b.reversal_of ?? null,
    ],
  );
  await c.query('UPDATE orders SET updated_at=clock_timestamp() WHERE id=$1', [ownerId]);
  if (effects) await stampLocalFinancialVersion(c, a.tenantId, ownerId);
  // 238: a payment made with an API key also records the key (audit238_event_keys).
  await insertAuditEvent(c, a, 'payment.' + b.kind, id, {
    entry_id: entry,
    amount: b.amount,
    fee: b.fee ?? 0,
    currency: b.currency,
    scope: 'local_confirmation_no_payment_call',
    ...(effects ? { effects: effects.effects, provenance: effects.provenance } : {}),
  });
  await financialEvent(
    c,
    a,
    id,
    'payment.' + b.kind,
    {
      entry_id: entry,
      amount: b.amount,
      currency: b.currency,
    },
    effects,
  );
  return entry;
}
export async function confirmOutstanding(
  c: PoolClient,
  a: Actor,
  id: string,
  method = 'status_confirmation',
) {
  const o = await order(c, id, true),
    balance = await paymentBalance(c, id);
  if (balance.amount_due > 0)
    await appendPayment(
      c,
      a,
      id,
      randomUUID(),
      {},
      {
        kind: 'receipt',
        amount: balance.amount_due,
        currency: o.currency,
        method,
        reference: 'Deklaracja opłacenia przez operatora',
      },
    );
}
async function shipmentSums(c: PoolClient, id: string, shipment: string) {
  const x = (
    await c.query(
      `SELECT coalesce(sum(p.amount) FILTER(WHERE coalesce(r.kind,p.kind)='courier_collection'),0)::bigint AS collected,
 coalesce(sum(p.amount::bigint+p.fee) FILTER(WHERE coalesce(r.kind,p.kind)='courier_remittance'),0)::bigint AS settled
 FROM payment_entries p LEFT JOIN payment_entries r ON r.id=p.reversal_of WHERE p.order_id=$1 AND p.shipment_id=$2`,
      [id, shipment],
    )
  ).rows[0];
  const sums = { collected: Number(x.collected), settled: Number(x.settled) };
  ensure(
    Object.values(sums).every(Number.isSafeInteger),
    409,
    'Saldo przesyłki przekracza obsługiwany zakres',
  );
  return sums;
}
export async function recordPayment(
  c: PoolClient,
  a: Actor,
  id: string,
  b: z.infer<typeof paymentInput>,
) {
  ensure(a.role !== 'viewer', 403, 'Wymagane uprawnienia do zapisu');
  const o = await order(c, id, true);
  const previous = await replay(c, id, b.client_key, b);
  if (previous)
    return { ...(await paymentHistory(c, id)), reused: true, payment_entry_id: previous };
  ensure(Number(o.version) === b.version, 409, 'Zamówienie zmieniło się; odśwież saldo');
  await validatePaymentEntry(c, o, b);
  const entry = await appendPayment(c, a, id, b.client_key, b, b);
  await advancePaid(c, a, id);
  // Outcome belongs to this locked mutation, not to a later history lookup.
  return { ...(await paymentHistory(c, id)), reused: false, payment_entry_id: entry };
}
async function validatePaymentEntry(
  c: PoolClient,
  o: any,
  b: {
    kind: string;
    currency: string;
    amount: number;
    fee: number;
    shipment_id?: string;
  },
) {
  const id = o.id;
  ensure(b.currency === o.currency, 422, 'Waluta potwierdzenia musi odpowiadać zamówieniu');
  const balance = await paymentBalance(c, id);
  if (b.kind === 'refund')
    ensure(
      b.amount <= balance.overpayment && !b.shipment_id,
      422,
      'Zwrot przekracza środki dostępne do oddania',
    );
  if (b.kind === 'receipt') ensure(!b.shipment_id, 422, 'Wpłata bezpośrednia nie wymaga przesyłki');
  if (b.kind.startsWith('courier_')) {
    ensure(
      o.payment_mode === 'cod' && b.shipment_id,
      422,
      'Rozliczenie kuriera wymaga przesyłki COD',
    );
    const s = (
      await c.query('SELECT * FROM shipments WHERE order_id=$1 AND id=$2', [id, b.shipment_id])
    ).rows[0];
    ensure(s && s.dispatched_at, 409, 'Pobranie wymaga przekazanej przesyłki');
    const sums = await shipmentSums(c, id, s.id);
    if (b.kind === 'courier_collection')
      ensure(
        b.amount <= s.cod_expected - sums.collected,
        422,
        'Pobranie przekracza kwotę zleconą kurierowi',
      );
    else
      ensure(
        b.amount + b.fee <= sums.collected - sums.settled,
        422,
        'Rozliczenie przekracza środki pobrane przez kuriera',
      );
  }
}
// Import scope/CAS and the current approving membership are fenced by the caller
// before its first write. These helpers never acquire an execution/global lock.
export async function recordFinancialPaymentInTx(
  c: PoolClient,
  a: Actor,
  id: string,
  key: string,
  request: unknown,
  input: FinancialPaymentEntry,
  context: LocalFinancialContext,
) {
  ensure(a.role === 'admin', 403, 'Import finansowy wymaga administratora');
  const b = financialPaymentEntry.parse(input),
    effects = localFinancialContext.parse(context);
  financialKey.parse(key);
  const o = await order(c, id, true);
  ensure(o.tenant_id === a.tenantId, 404, 'Nie znaleziono zamówienia');
  // Compare exactly the JSON evidence persisted by jsonb, including omitted optional fields.
  const immutableRequest = JSON.parse(JSON.stringify({ request, entry: b, context: effects }));
  const previous = await replay(c, id, key, immutableRequest);
  if (previous) return { entry_id: previous, reused: true };
  await validatePaymentEntry(c, o, b);
  const entry_id = await appendPayment(c, a, id, key, immutableRequest, b, effects);
  await advancePaid(c, a, id, effects);
  return { entry_id, reused: false };
}
export async function advancePaid(
  c: PoolClient,
  a: Actor,
  id: string,
  context?: LocalFinancialContext,
) {
  const effects = context === undefined ? undefined : localFinancialContext.parse(context);
  id = await resolveOrderMergeOwnerInTx(c, id);
  await assertSaleFinancialOrderInTx(c, id);
  const o = await order(c, id);
  if (o.status === 'new' && (await paymentBalance(c, id)).amount_due === 0) {
    await c.query(
      "UPDATE orders SET status='paid',workflow_status_id=NULL,updated_at=clock_timestamp() WHERE id=$1",
      [id],
    );
    if (effects) await stampLocalFinancialVersion(c, a.tenantId, id);
    if (effects)
      await insertAuditEvent(c, a, 'order.paid', id, {
        from: 'new',
        effects: effects.effects,
        provenance: effects.provenance,
        scope: 'local_payment_confirmation',
      });
    await financialEvent(
      c,
      a,
      id,
      'order.paid',
      {
        from: 'new',
        scope: 'local_payment_confirmation',
      },
      effects,
    );
  }
}
export async function reversePayment(
  c: PoolClient,
  a: Actor,
  id: string,
  b: z.infer<typeof reversalInput>,
) {
  ensure(a.role === 'admin', 403, 'Korekta wymaga administratora');
  const o = await order(c, id, true);
  const sources = (await orderMergeClaimInTx(c, id))
    ? [id]
    : await orderMergePaymentSourceIdsInTx(c, id);
  const source = (
    await c.query('SELECT order_id FROM payment_entries WHERE id=$1 AND order_id=ANY($2::uuid[])', [
      b.entry_id,
      sources,
    ])
  ).rows[0];
  ensure(source, 422, 'Nie znaleziono wpisu w historii tego zamówienia');
  if (await replay(c, source.order_id, b.client_key, b)) return paymentHistory(c, id);
  ensure(Number(o.version) === b.version, 409, 'Zamówienie zmieniło się; odśwież saldo');
  const entry = await reversalEntry(c, source.order_id, b.entry_id);
  await appendPayment(c, a, source.order_id, b.client_key, b, { ...entry, note: b.reason });
  return paymentHistory(c, id);
}
export async function reversalEntry(c: PoolClient, id: string, entryId: string): Promise<Entry> {
  const e = (
    await c.query('SELECT * FROM payment_entries WHERE order_id=$1 AND id=$2', [id, entryId])
  ).rows[0];
  ensure(e && e.kind !== 'reversal', 422, 'Nieprawidłowy wpis do korekty');
  ensure(
    !(await c.query('SELECT 1 FROM payment_entries WHERE reversal_of=$1', [e.id])).rowCount,
    409,
    'Wpis został już skorygowany',
  );
  ensure(
    !e.return_id,
    409,
    'Rozliczenie sprawy zwrotowej wymaga osobnej korekty procesu; wpis pozostaje w historii',
  );
  if (e.kind === 'courier_collection') {
    const sums = await shipmentSums(c, id, e.shipment_id);
    ensure(sums.collected - e.amount >= sums.settled, 409, 'Najpierw skoryguj rozliczenie kuriera');
  }
  if (['receipt', 'courier_collection'].includes(e.kind))
    ensure(
      (await effectiveOrderMergePaymentBalanceInTx(c, id)).net >= e.amount,
      409,
      'Najpierw skoryguj zwrot środków',
    );
  return {
    kind: 'reversal',
    amount: -e.amount,
    fee: -e.fee,
    currency: e.currency,
    method: 'correction',
    reference: e.id,
    shipment_id: e.shipment_id ?? undefined,
    reversal_of: e.id,
  };
}
export async function reverseFinancialPaymentInTx(
  c: PoolClient,
  a: Actor,
  id: string,
  key: string,
  request: unknown,
  input: z.input<typeof financialReversal>,
  context: LocalFinancialContext,
) {
  ensure(a.role === 'admin', 403, 'Korekta wymaga administratora');
  const b = financialReversal.parse(input),
    effects = localFinancialContext.parse(context);
  financialKey.parse(key);
  const o = await order(c, id, true);
  ensure(o.tenant_id === a.tenantId, 404, 'Nie znaleziono zamówienia');
  const immutableRequest = JSON.parse(JSON.stringify({ request, reversal: b, context: effects }));
  const previous = await replay(c, id, key, immutableRequest);
  if (previous) return { entry_id: previous, reused: true };
  const entry = await reversalEntry(c, id, b.entry_id);
  const entry_id = await appendPayment(
    c,
    a,
    id,
    key,
    immutableRequest,
    { ...entry, note: b.reason },
    effects,
  );
  return { entry_id, reused: false };
}
export async function fulfillmentPayment(c: PoolClient, o: any, cod?: number) {
  const b = await paymentBalance(c, o.id);
  // 246 (B2B-007): an order on trade credit ships before payment; nothing is collected on delivery.
  ensure(
    o.payment_mode === 'cod' || b.amount_due === 0 || (await tradeCreditReleasedInTx(c, o.id)),
    409,
    'Przedpłata nie pokrywa należności zamówienia',
  );
  const expected = o.payment_mode === 'cod' ? b.amount_due : 0;
  if (cod !== undefined)
    ensure(cod === expected, 409, 'Kwota pobrania różni się od aktualnej należności zamówienia');
  return expected;
}
