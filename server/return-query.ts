import type { PoolClient } from 'pg';
import { z } from 'zod';
import { Problem } from './errors';
import { getReturnAcceptanceInTx } from './return-acceptance';
import { catalogStockReturnDocumentsInTx } from './catalog-stock-return-effects';
import { returnReasonChoicesInTx } from './return-reasons223';
import {
  returnExchangeAvailable,
  returnExchangeMetadataInTx,
  returnExchangeSubstitutionsAvailable,
} from './return-exchanges';
export const returnQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  after: z.string().max(1600).optional(),
  state: z.enum(['requested', 'refund_pending', 'closed', 'rejected', 'cancelled']).optional(),
  kind: z.enum(['return', 'complaint']).optional(),
  submitted_by: z.enum(['operator', 'buyer']).optional(),
  search: z.string().trim().max(100).default(''),
});
export type ReturnQuery = z.infer<typeof returnQuery>;
function cursor(q: ReturnQuery, orderId?: string) {
  if (!q.after) return null;
  try {
    const v = z
      .object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/),
        id: z.uuid(),
        filter: z.string(),
      })
      .parse(JSON.parse(Buffer.from(q.after, 'base64url').toString()));
    if (!Number.isFinite(Date.parse(v.date)) || v.filter !== filter(q, orderId)) throw new Error();
    return v;
  } catch {
    throw new Problem(422, 'Nieprawidłowy kursor lub zmienione filtry');
  }
}
function filter(q: ReturnQuery, orderId?: string) {
  return JSON.stringify([
    orderId ?? null,
    q.state ?? null,
    q.kind ?? null,
    q.submitted_by ?? null,
    q.search,
  ]);
}
export async function returnPage(c: PoolClient, q: ReturnQuery, orderId?: string) {
  const at = cursor(q, orderId);
  const rows = (
    await c.query(
      `SELECT r.*,o.number AS order_number,o.customer_name,o.currency,
 to_char(r.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_date
 FROM return_cases r JOIN orders o ON (o.tenant_id,o.id)=(r.tenant_id,r.order_id)
 WHERE ($1::uuid IS NULL OR r.order_id=$1) AND ($2::text IS NULL OR r.state=$2)
 AND ($3::text IS NULL OR r.kind=$3) AND ($4::text IS NULL OR r.submitted_by=$4)
 AND ($5='' OR r.number ILIKE $5 OR o.number ILIKE $5 OR o.customer_name ILIKE $5)
 AND ($6::timestamptz IS NULL OR (r.created_at,r.id)<($6::timestamptz,$7::uuid))
 ORDER BY r.created_at DESC,r.id DESC LIMIT $8`,
      [
        orderId ?? null,
        q.state ?? null,
        q.kind ?? null,
        q.submitted_by ?? null,
        q.search ? '%' + q.search + '%' : '',
        at?.date ?? null,
        at?.id ?? null,
        q.limit + 1,
      ],
    )
  ).rows;
  const more = rows.length > q.limit,
    data = rows.slice(0, q.limit),
    last = data.at(-1);
  const lines = data.length
    ? (
        await c.query(
          'SELECT * FROM return_items WHERE return_id=ANY($1::uuid[]) ORDER BY sku,item_id',
          [data.map((r) => r.id)],
        )
      ).rows
    : [];
  const buckets = new Map<string, any[]>();
  for (const line of lines) {
    const b = buckets.get(line.return_id) ?? [];
    b.push(line);
    buckets.set(line.return_id, b);
  }
  const accepted = new Map<string, Awaited<ReturnType<typeof getReturnAcceptanceInTx>>>();
  const exchanges = new Map<string, Awaited<ReturnType<typeof returnExchangeMetadataInTx>>>();
  const stockReceipts = new Map<string, Awaited<ReturnType<typeof catalogStockReturnDocumentsInTx>>>();
  const exchangeAvailable = data.length > 0 && (await returnExchangeAvailable(c));
  const substitutionAvailable =
    exchangeAvailable && (await returnExchangeSubstitutionsAvailable(c));
  const reasonChoices = await returnReasonChoicesInTx(c, data.map((r) => r.id));
  for (const row of data) {
    accepted.set(row.id, await getReturnAcceptanceInTx(c, row));
    stockReceipts.set(row.id, await catalogStockReturnDocumentsInTx(c, row.id));
    if (exchangeAvailable) exchanges.set(row.id, await returnExchangeMetadataInTx(c, row, true));
  }
  return {
    data: data.map(({ cursor_date, ...r }) => ({
      ...r,
      ...accepted.get(r.id),
      stock_receipts: stockReceipts.get(r.id) ?? [],
      exchange: exchanges.get(r.id) ?? null,
      substitution_available: substitutionAvailable,
      can_exchange:
        exchangeAvailable && r.kind === 'complaint' && r.state === 'requested' && !r.legacy,
      reason_choice: reasonChoices.get(r.id) ?? null,
      items: buckets.get(r.id) ?? [],
    })),
    meta: {
      has_more: more,
      cursor:
        more && last
          ? Buffer.from(
              JSON.stringify({ date: last.cursor_date, id: last.id, filter: filter(q, orderId) }),
            ).toString('base64url')
          : null,
    },
  };
}
