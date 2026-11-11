import type { PoolClient } from 'pg';
import { ensure } from './errors';

type Row = Record<string, unknown>;
export type OrderFulfillmentKind = 'sale' | 'replacement';
export type ReturnRemedy = 'refund' | 'exchange';

/** Missing keys belong to legacy schemas; present null/unknown values fail closed. */
export function orderFulfillmentKind(row: Row): OrderFulfillmentKind {
  if (!Object.hasOwn(row, 'fulfillment_kind')) return 'sale';
  ensure(
    row.fulfillment_kind === 'sale' || row.fulfillment_kind === 'replacement',
    409,
    'Nieprawidłowy rodzaj realizacji zamówienia',
  );
  return row.fulfillment_kind;
}

export function returnRemedy(row: Row): ReturnRemedy {
  if (!Object.hasOwn(row, 'remedy')) return 'refund';
  ensure(
    row.remedy === 'refund' || row.remedy === 'exchange',
    409,
    'Nieprawidłowy sposób rozpatrzenia zwrotu',
  );
  return row.remedy;
}

export function assertSaleFinancialKind(row: Row): void {
  ensure(
    orderFulfillmentKind(row) === 'sale',
    409,
    'Wymiana gwarancyjna nie jest sprzedażą ani rozliczeniem pieniężnym',
  );
}

export function assertRefundRemedy(row: Row): void {
  ensure(
    returnRemedy(row) === 'refund',
    409,
    'Wymiana gwarancyjna nie uprawnia do zwrotu środków ani korekty sprzedaży',
  );
}

/** The caller owns order locks; this helper never changes role, tenant, or transaction state. */
export async function readOrderFulfillmentKindInTx(
  c: PoolClient,
  id: string,
): Promise<OrderFulfillmentKind> {
  const row = (
    await c.query(
      "SELECT to_jsonb(o) AS row FROM orders o WHERE o.id=$1 AND o.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid",
      [id],
    )
  ).rows[0]?.row;
  ensure(row, 404, 'Nie znaleziono własnego zamówienia');
  return orderFulfillmentKind(row);
}

export async function assertSaleFinancialOrderInTx(c: PoolClient, id: string): Promise<void> {
  ensure(
    (await readOrderFulfillmentKindInTx(c, id)) === 'sale',
    409,
    'Wymiana gwarancyjna nie jest sprzedażą ani rozliczeniem pieniężnym',
  );
}

export async function assertRefundRemedyInTx(c: PoolClient, id: string): Promise<void> {
  const row = (
    await c.query(
      "SELECT to_jsonb(r) AS row FROM return_cases r WHERE r.id=$1 AND r.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid",
      [id],
    )
  ).rows[0]?.row;
  ensure(row, 404, 'Nie znaleziono własnej sprawy zwrotowej');
  assertRefundRemedy(row);
}
