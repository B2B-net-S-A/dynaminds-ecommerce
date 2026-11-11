import type { PoolClient } from 'pg';
import { ensure } from './errors';
import { getReturn } from './returns';
import { getReturnAcceptanceInTx, returnAcceptedSql } from './return-acceptance';
export async function returnInvoiceSnapshot(
  c: PoolClient,
  id: string,
  orderId: string,
  channel: string,
  mode: string,
  ignorePlan?: string,
) {
  const r = await getReturn(c, id);
  const acceptance = await getReturnAcceptanceInTx(c, r);
  const acceptedSql = await returnAcceptedSql(c);
  ensure(
    r.order_id === orderId && acceptance.accepted_at && !r.legacy,
    409,
    'Wybierz przyjętą sprawę częściową tego zamówienia',
  );
  ensure(r.refund_amount > 0, 422, 'Sprawa bez kwoty nie wymaga korekty pieniężnej');
  ensure(
    !(
      await c.query(
        "SELECT id FROM invoice_plans WHERE order_id=$1 AND kind='correction' AND mode=$2 AND (state IN ('queued','failed') OR (return_id IS NULL AND state NOT IN ('preview','cancelled'))) AND ($3::uuid IS NULL OR id<>$3)",
        [orderId, mode, ignorePlan ?? null],
      )
    ).rowCount,
    409,
    'Najpierw uzgodnij poprzednią korektę; pełna korekta nie może łączyć się z częściową',
  );
  const prior = (
    await c.query(
      `SELECT r.id,r.receipt_sequence,r.refunded_shipping,r.refund_amount,p.document_id FROM return_cases r LEFT JOIN invoice_plans p ON p.tenant_id=r.tenant_id AND p.return_id=r.id AND p.channel_id=$3 AND p.mode=$4 AND p.state='done' WHERE r.order_id=$1 AND ${acceptedSql} IS NOT NULL AND r.receipt_sequence<$2 AND NOT r.legacy ORDER BY r.receipt_sequence,r.id`,
      [orderId, r.receipt_sequence, channel, mode],
    )
  ).rows;
  // A zero-value case needs no provider correction, but still consumes its accepted units.
  for (const previous of prior) {
    const amount = previous.refund_amount;
    ensure(
      previous.document_id || amount === 0,
      409,
      'Najpierw wystaw korektę wcześniejszej przyjętej sprawy',
    );
  }
  const previousItems = prior.length
    ? (
        await c.query(
          'SELECT item_id,sum(accepted)::int AS accepted,sum(refund_amount)::int AS refund_amount FROM return_items WHERE return_id=ANY($1::uuid[]) GROUP BY item_id ORDER BY item_id',
          [prior.map((r) => r.id)],
        )
      ).rows
    : [];
  return {
    id: r.id,
    number: r.number,
    receipt_sequence: r.receipt_sequence,
    refund_amount: r.refund_amount,
    shipping_cost: r.refunded_shipping,
    items: r.items
      .filter((i: any) => i.accepted > 0)
      .map((i: any) => ({
        item_id: i.item_id,
        accepted: i.accepted,
        refund_amount: i.refund_amount,
      })),
    prior: prior.map((r) => ({
      id: r.id,
      document_id: r.document_id,
      shipping_cost: r.refunded_shipping,
    })),
    prior_items: previousItems,
  };
}
export function partialCorrectionPositions(original: any, items: any[], s: any) {
  const decimal = (n: number) => (n / 100).toFixed(2);
  const positions: any[] = [];
  for (const selected of s.items) {
    const index = items.findIndex((i) => i.id === selected.item_id),
      previous = s.prior_items.find((i: any) => i.item_id === selected.item_id);
    ensure(index >= 0, 409, 'Pozycja sprawy nie istnieje na zamówieniu');
    const p = original.payload.positions[index];
    const before = {
      ...p,
      quantity: items[index].quantity - (previous?.accepted ?? 0),
      total_price_gross: decimal(items[index].line_total - (previous?.refund_amount ?? 0)),
      kind: 'correction_before',
    };
    const after = {
      ...p,
      quantity: before.quantity - selected.accepted,
      total_price_gross: decimal(
        items[index].line_total - (previous?.refund_amount ?? 0) - selected.refund_amount,
      ),
      kind: 'correction_after',
    };
    ensure(
      after.quantity >= 0 && Number(after.total_price_gross) >= 0,
      409,
      'Korekta przekracza pozostałą pozycję',
    );
    positions.push({
      ...p,
      quantity: -selected.accepted,
      total_price_gross: decimal(-selected.refund_amount),
      kind: 'correction',
      correction_before_attributes: before,
      correction_after_attributes: after,
    });
  }
  if (s.shipping_cost) {
    const p = original.payload.positions[items.length];
    ensure(p, 409, 'Brak dostawy na fakturze');
    const originalShipping = Math.round(Number(p.total_price_gross) * 100),
      beforeAmount =
        originalShipping - s.prior.reduce((n: number, r: any) => n + r.shipping_cost, 0),
      afterAmount = beforeAmount - s.shipping_cost;
    ensure(afterAmount >= 0, 409, 'Korekta przekracza pozostałą dostawę');
    const before = {
        ...p,
        quantity: beforeAmount ? 1 : 0,
        total_price_gross: decimal(beforeAmount),
        kind: 'correction_before',
      },
      after = {
        ...p,
        quantity: afterAmount ? 1 : 0,
        total_price_gross: decimal(afterAmount),
        kind: 'correction_after',
      };
    positions.push({
      ...p,
      quantity: after.quantity - before.quantity,
      total_price_gross: decimal(-s.shipping_cost),
      kind: 'correction',
      correction_before_attributes: before,
      correction_after_attributes: after,
    });
  }
  return positions;
}
