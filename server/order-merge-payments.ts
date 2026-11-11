import { commercialSaleScopeInTx, commercialSaleScopeReadonlyInTx } from './commercial-sale-scope';
import type { PoolClient } from 'pg';
import type { Actor } from './domain';
import { ensure } from './errors';

export type OrderMergeTransferInput = {
  execution_id: string;
  source_order_ids: string[];
  target_order_id: string;
  merge_mode: 'technical_merge' | 'into_main_order';
};
type Row = Record<string, any>;
const scope = async (c: PoolClient) => {
  const t = (await c.query("SELECT nullif(current_setting('app.tenant_id',true),'') AS tenant"))
    .rows[0].tenant;
  ensure(t, 403, 'Brak kontekstu firmy');
  return t as string;
};
async function claimsAvailable(c: PoolClient) {
  return Boolean(
    (await c.query("SELECT to_regclass('public.order_merge_claims') IS NOT NULL AS available"))
      .rows[0].available,
  );
}
async function ownOrder(c: PoolClient, id: string) {
  const tenant = await scope(c);
  const o = (await c.query('SELECT * FROM orders WHERE tenant_id=$1 AND id=$2', [tenant, id]))
    .rows[0];
  ensure(o, 404, 'Nie znaleziono własnego zamówienia');
  return o as Row;
}

/** The original payment entry remains on its original order, including later reversals. */
export async function resolveOrderMergeOwnerInTx(c: PoolClient, orderId: string): Promise<string> {
  await ownOrder(c, orderId);
  if (!(await claimsAvailable(c))) return orderId;
  const tenant = await scope(c);
  const rows = (
    await c.query(
      `WITH RECURSIVE owners AS (
      SELECT $2::uuid AS id, ARRAY[$2::uuid] AS path, false AS cycle
      UNION ALL
      SELECT m.target_order_id, o.path||m.target_order_id, m.target_order_id=ANY(o.path)
      FROM owners o JOIN order_merge_claims m ON m.tenant_id=$1 AND m.source_order_id=o.id
      WHERE NOT o.cycle AND cardinality(o.path)<=1000
    ) SELECT id,path,cycle FROM owners ORDER BY cardinality(path) DESC LIMIT 1`,
      [tenant, orderId],
    )
  ).rows[0];
  ensure(
    rows && !rows.cycle && rows.path.length <= 1000,
    409,
    'Nieprawidłowy łańcuch scalonych zamówień',
  );
  await ownOrder(c, rows.id);
  return rows.id as string;
}

async function incoming(c: PoolClient, ids: string[]) {
  const tenant = await scope(c);
  const roots = [...new Set(ids)].sort();
  ensure(roots.length > 0 && roots.length <= 101, 422, 'Nieprawidłowy zakres zamówień');
  const n = (
    await c.query(
      'SELECT count(*)::integer AS n FROM orders WHERE tenant_id=$1 AND id=ANY($2::uuid[])',
      [tenant, roots],
    )
  ).rows[0].n;
  ensure(n === roots.length, 404, 'Nie znaleziono wszystkich własnych zamówień');
  if (!(await claimsAvailable(c))) return roots;
  const rows = (
    await c.query(
      `WITH RECURSIVE sources(id) AS (
      SELECT unnest($2::uuid[])
      UNION
      SELECT m.source_order_id FROM sources s JOIN order_merge_claims m ON m.tenant_id=$1 AND m.target_order_id=s.id
    ) SELECT id FROM sources ORDER BY id LIMIT 10001`,
      [tenant, roots],
    )
  ).rows;
  ensure(rows.length <= 10000, 409, 'Historia scalania przekracza obsługiwany zakres');
  return rows.map((r) => r.id as string);
}
export async function orderMergePaymentSourceIdsInTx(c: PoolClient, orderId: string) {
  return incoming(c, [await resolveOrderMergeOwnerInTx(c, orderId)]);
}
const safe = (n: bigint) => {
  const value = Number(n);
  ensure(Number.isSafeInteger(value), 409, 'Saldo przekracza obsługiwany zakres');
  return value;
};
async function balance(c: PoolClient, ids: string[], o: Row, strictCurrency = false) {
  const tenant = await scope(c);
  const bad = (
    await c.query(
      'SELECT 1 FROM payment_entries WHERE tenant_id=$1 AND order_id=ANY($2::uuid[]) AND currency<>$3 LIMIT 1',
      [tenant, ids, o.currency],
    )
  ).rowCount;
  ensure(!strictCurrency || !bad, 409, 'Waluta rejestru płatności różni się od waluty scalania');
  const x = (
    await c.query(
      `SELECT coalesce(sum(p.amount) FILTER(WHERE coalesce(r.kind,p.kind) IN ('receipt','courier_collection')),0)::text received,
      coalesce(sum(p.amount) FILTER(WHERE coalesce(r.kind,p.kind)='refund'),0)::text refunded,
      coalesce(sum(p.amount) FILTER(WHERE coalesce(r.kind,p.kind)='courier_collection'),0)::text collected,
      coalesce(sum(p.amount) FILTER(WHERE coalesce(r.kind,p.kind)='courier_remittance'),0)::text remitted,
      coalesce(sum(p.fee) FILTER(WHERE coalesce(r.kind,p.kind)='courier_remittance'),0)::text fees
     FROM payment_entries p LEFT JOIN payment_entries r
      ON (r.tenant_id,r.order_id,r.id)=(p.tenant_id,p.order_id,p.reversal_of)
     WHERE p.tenant_id=$1 AND p.order_id=ANY($2::uuid[])`,
      [tenant, ids],
    )
  ).rows[0];
  const returnCredit = BigInt(
    (
      await c.query(
        "SELECT coalesce(sum(refund_amount),0)::text n FROM return_cases WHERE tenant_id=$1 AND order_id=ANY($2::uuid[]) AND state IN ('refund_pending','closed')",
        [tenant, ids],
      )
    ).rows[0].n,
  );
  const saleScopes = [];
  const readOnly=(await c.query("SELECT current_setting('transaction_read_only') ro")).rows[0]?.ro;
  ensure(readOnly==='on'||readOnly==='off',503,'Nieznany tryb transakcji salda');
  for(const id of ids)saleScopes.push(await (readOnly==='on'?commercialSaleScopeReadonlyInTx:commercialSaleScopeInTx)(c,id));
  const cancelledCredit = saleScopes.reduce((sum,s)=>sum+BigInt(s?.cancelled_credit_minor??'0'),0n);
  const credit = returnCredit + cancelledCredit;
  const received = BigInt(x.received),
    refunded = BigInt(x.refunded),
    collected = BigInt(x.collected),
    remitted = BigInt(x.remitted),
    fees = BigInt(x.fees);
  const nominal =
    o.status === 'cancelled' ? 0n : BigInt(o.total) > credit ? BigInt(o.total) - credit : 0n;
  const net = received - refunded;
  return {
    currency: o.currency as string,
    payment_mode: o.payment_mode as string,
    received: safe(received),
    refunded: safe(refunded),
    credit: safe(credit),
    return_credit: safe(returnCredit),
    cancelled_credit: safe(cancelledCredit),
    nominal: safe(nominal),
    net: safe(net),
    amount_due: safe(nominal > net ? nominal - net : 0n),
    overpayment: safe(net > nominal ? net - nominal : 0n),
    collected: safe(collected),
    remitted: safe(remitted),
    fees: safe(fees),
    courier_due: safe(collected - remitted - fees),
  };
}
export async function effectiveOrderMergePaymentBalanceInTx(c: PoolClient, orderId: string) {
  const owner = await resolveOrderMergeOwnerInTx(c, orderId);
  const ids = await incoming(c, [owner]);
  return balance(c, ids, await ownOrder(c, owner), ids.length > 1);
}
export async function orderMergeOriginalPaymentBalanceInTx(c: PoolClient, orderId: string) {
  const o = await ownOrder(c, orderId);
  if (
    (await c.query("SELECT to_regclass('public.order_merge_origins') IS NOT NULL AS available"))
      .rows[0].available
  ) {
    const origin = (
      await c.query('SELECT header FROM order_merge_origins WHERE tenant_id=$1 AND order_id=$2', [
        await scope(c),
        orderId,
      ])
    ).rows[0];
    if (origin) return balance(c, [orderId], origin.header);
  }
  return balance(c, [orderId], o);
}

/** Buyer money must never include a later aggregate receipt/refund on a reused main ID.
 * Closed source IDs still have an unambiguous original ledger. A reused main ID
 * needs explicit source allocation before its later owner money can be public. */
export async function orderMergeBuyerPaymentBalanceInTx(c: PoolClient, orderId: string) {
  const tenant = await scope(c);
  await ownOrder(c, orderId);
  const available = (
    await c.query("SELECT to_regclass('public.order_merge_origins') IS NOT NULL AS available")
  ).rows[0].available;
  if (available) {
    const origin = (
      await c.query(
        `SELECT e.merge_mode,e.main_order_id,e.before_snapshot,o.header
         FROM order_merge_origins o JOIN order_merge_executions e
           ON (e.tenant_id,e.id)=(o.tenant_id,o.execution_id)
         WHERE o.tenant_id=$1 AND o.order_id=$2`,
        [tenant, orderId],
      )
    ).rows[0];
    if (origin?.merge_mode === 'into_main_order' && origin.main_order_id === orderId) {
      const frozen = origin.before_snapshot?.payments?.orders?.find(
        (p: Row) => p.order_id === orderId,
      )?.original_balance as
        Awaited<ReturnType<typeof orderMergeOriginalPaymentBalanceInTx>> | undefined;
      ensure(
        frozen &&
          frozen.currency === origin.header.currency &&
          frozen.payment_mode === origin.header.payment_mode,
        409,
        'Brak pierwotnego salda kupującego w historii połączenia',
      );
      return { balance: frozen, payment_as_of_merge: true };
    }
  }
  return {
    balance: await orderMergeOriginalPaymentBalanceInTx(c, orderId),
    payment_as_of_merge: false,
  };
}
export async function orderMergeOriginalCommerceInTx(c: PoolClient, orderId: string) {
  const header = await ownOrder(c, orderId);
  const tenant = await scope(c);
  if (
    (await c.query("SELECT to_regclass('public.order_merge_origins') IS NOT NULL AS available"))
      .rows[0].available
  ) {
    const origin = (
      await c.query(
        'SELECT header,items FROM order_merge_origins WHERE tenant_id=$1 AND order_id=$2',
        [tenant, orderId],
      )
    ).rows[0];
    if (origin) return origin as { header: Row; items: Row[] };
  }
  return {
    header,
    items: (
      await c.query('SELECT * FROM order_items WHERE tenant_id=$1 AND order_id=$2 ORDER BY id', [
        tenant,
        orderId,
      ])
    ).rows as Row[],
  };
}
export async function orderMergeCombinedPaymentBalanceInTx(
  c: PoolClient,
  sourceIds: string[],
  target: {
    total: number;
    currency: string;
    payment_mode: string;
    status?: string;
  },
) {
  const ids = await incoming(c, sourceIds);
  const mismatch = (
    await c.query(
      'SELECT 1 FROM orders WHERE tenant_id=$1 AND id=ANY($2::uuid[]) AND (currency<>$3 OR payment_mode<>$4) LIMIT 1',
      [await scope(c), ids, target.currency, target.payment_mode],
    )
  ).rowCount;
  ensure(!mismatch, 409, 'Scalanie wymaga tej samej waluty i sposobu płatności');
  return balance(c, ids, { ...target, status: target.status ?? 'new' }, true);
}
export async function orderMergeFinancialSnapshotInTx(c: PoolClient, orderIds: string[]) {
  const ids = [...new Set(orderIds)].sort();
  const tenant = await scope(c);
  const orders = [];
  for (const order_id of ids) {
    await ownOrder(c, order_id);
    const sourceIds = await incoming(c, [order_id]);
    orders.push({
      order_id,
      balance: await effectiveOrderMergePaymentBalanceInTx(c, order_id),
      original_balance: await orderMergeOriginalPaymentBalanceInTx(c, order_id),
      entries: (
        await c.query(
          'SELECT to_jsonb(p) row FROM payment_entries p WHERE tenant_id=$1 AND order_id=ANY($2::uuid[]) ORDER BY order_id,created_at,id',
          [tenant, sourceIds],
        )
      ).rows.map((r) => r.row),
      returns: (
        await c.query(
          'SELECT id,order_id,state,refund_amount FROM return_cases WHERE tenant_id=$1 AND order_id=ANY($2::uuid[]) ORDER BY order_id,id',
          [tenant, sourceIds],
        )
      ).rows,
    });
  }
  const claims = (await claimsAvailable(c))
    ? (
        await c.query(
          'SELECT to_jsonb(m) row FROM order_merge_claims m WHERE tenant_id=$1 AND (source_order_id=ANY($2::uuid[]) OR target_order_id=ANY($2::uuid[])) ORDER BY source_order_id',
          [tenant, ids],
        )
      ).rows.map((r) => r.row)
    : [];
  return { orders, claims };
}
export async function transferOrderMergeFinanceInTx(
  c: PoolClient,
  a: Actor,
  input: OrderMergeTransferInput,
) {
  ensure((await scope(c)) === a.tenantId, 403, 'Inna firma');
  const e = (
    await c.query('SELECT * FROM order_merge_executions WHERE tenant_id=$1 AND id=$2', [
      a.tenantId,
      input.execution_id,
    ])
  ).rows[0];
  ensure(
    e &&
      e.actor_id === a.userId &&
      e.target_order_id === input.target_order_id &&
      e.merge_mode === input.merge_mode,
    409,
    'Brak autentycznego wykonania scalania',
  );
  const sources = [...new Set(input.source_order_ids)].sort();
  ensure(
    JSON.stringify([...e.source_ids].sort()) === JSON.stringify(sources),
    409,
    'Inny zakres scalania',
  );
  // No INSERT/UPDATE payment_entries: claims are the economic ownership allocation.
  const target = await ownOrder(c, input.target_order_id);
  return orderMergeCombinedPaymentBalanceInTx(
    c,
    [...sources, input.target_order_id],
    target as {
      total: number;
      currency: string;
      payment_mode: string;
      status: string;
    },
  );
}
