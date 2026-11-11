import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { PoolClient } from 'pg';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { networkTx as tx, networkScope as scope, networkAdmin as admin } from './b2b-network';
import {
  networkOrder as lookupOrder,
  networkSupplierBuyerOrder,
  networkOrderDetail as orderDetail,
  networkCatalogLocks as catalogs,
  networkLocalProducts as products,
} from './b2b-network-orders';
import { audit, cancelOrder } from './domain';
import { requestReturn, returnInput, decideReturn, getReturn } from './returns';
import { createWarehouseDocument, postWarehouseDocument, warehouseSchema } from './warehouse';
import { ensure } from './errors';
import { withdrawNetworkDecisionInTx } from './b2b-network-decisions';
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const version = z.number().int().positive(),
  reason = z.string().trim().min(3).max(2000);
const cancelInput = z
  .object({ version, client_key: z.uuid(), reason, confirmed: z.literal(true) })
  .strict();
const returnSchema = z
  .object({
    version,
    client_key: z.uuid(),
    kind: z.enum(['return', 'complaint']),
    reason,
    shipping_refund: z.number().int().min(0).max(1000000),
    confirmed: z.literal(true),
    lines: z
      .array(
        z.object({ product_id: z.uuid(), quantity: z.number().int().min(1).max(100000) }).strict(),
      )
      .min(1)
      .max(100),
  })
  .strict()
  .refine(
    (b) => new Set(b.lines.map((i) => i.product_id)).size === b.lines.length,
    'Produkt występuje więcej niż raz',
  );
const dispatchSchema = z.object({ version, confirmed: z.literal(true) }).strict();
const withdrawSchema = z.object({ version, reason, confirmed: z.literal(true) }).strict();
const recoverySchema = z
  .object({
    version,
    client_key: z.uuid(),
    confirmed: z.literal(true),
    lines: z
      .array(
        z
          .object({
            product_id: z.uuid(),
            quantity: z.number().int().min(1).max(100000),
            location: z.string().trim().min(1).max(80),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict()
  .refine(
    (b) => new Set(b.lines.map((i) => i.product_id)).size === b.lines.length,
    'Produkt występuje więcej niż raz',
  );
async function supplierOrder(c: PoolClient, o: any, lock = true) {
  const view = await networkSupplierBuyerOrder(c, o, lock);
  ensure(
    !view.origin,
    409,
    'Zwrot historycznego źródła po połączeniu wymaga uzgodnienia ze sprzedawcą',
  );
  return view.header;
}
async function order(c: PoolClient, id: string, lock = false) {
  const o = await lookupOrder(c, id, lock);
  // Authorize the original buyer before any replay, RMA lookup or mutation.
  // The source-order lock also keeps a concurrent merge from changing this
  // authorization while the supplier case is read or updated.
  await supplierOrder(c, o, lock);
  await scope(c, o.tenant_id);
  return o;
}
async function ownReturn(c: PoolClient, o: any, id: string) {
  const r = (
    await c.query('SELECT * FROM b2b_network_returns WHERE id=$1 AND order_id=$2 FOR UPDATE', [
      id,
      o.id,
    ])
  ).rows[0];
  ensure(r, 404, 'Nie znaleziono zgłoszenia B2B');
  return r;
}
async function supplierCase(c: PoolClient, o: any, r: any, lock = false) {
  await supplierOrder(c, o, lock);
  const s = (
    await c.query(
      "SELECT r.id FROM return_cases r JOIN orders o ON(o.tenant_id,o.id)=(r.tenant_id,r.order_id) WHERE r.id=$1 AND r.order_id=$2 AND o.b2b_account_id=$3 AND r.submitted_by='buyer'" +
        (lock ? ' FOR UPDATE OF r' : ''),
      [r.source_return_id, o.source_order_id, o.account_id],
    )
  ).rows[0];
  ensure(s, 404, 'Nie znaleziono zgłoszenia u dostawcy');
  return getReturn(c, s.id);
}
function safeCase(r: any, currency: string) {
  return {
    number: r.number,
    kind: r.kind,
    state: r.state,
    reason: r.reason,
    decision_note: r.decision_note,
    refund_amount: r.refund_amount,
    requested_shipping: r.requested_shipping,
    refunded_shipping: r.refunded_shipping,
    currency,
    received_at: r.received_at,
    refunded_at: r.refunded_at,
    settled_amount: r.refunded_at ? (r.settlement?.amount ?? 0) : 0,
    items: r.items.map((i: any) => ({
      item_id: i.item_id,
      sku: i.sku,
      name: i.name,
      requested: i.requested,
      accepted: i.accepted,
      restocked: i.restocked,
      refund_amount: i.refund_amount,
    })),
    documents: r.documents,
  };
}
async function recoveryPage(c: PoolClient, returnId: string, after?: string) {
  const rows = (
    await c.query(
      'SELECT r.id,r.document_id,r.created_at,d.number FROM b2b_network_return_recoveries r JOIN warehouse_documents d ON(d.tenant_id,d.id)=(r.tenant_id,r.document_id) WHERE r.return_id=$1 AND ($2::uuid IS NULL OR r.id>$2) ORDER BY r.id LIMIT 26',
      [returnId, after ?? null],
    )
  ).rows;
  return { data: rows.slice(0, 25), next: rows.length > 25 ? rows[24].id : null };
}
async function detail(c: PoolClient, o: any, r: any) {
  const source = await supplierCase(c, o, r);
  await scope(c, o.tenant_id);
  const lines = (
    await c.query(
      'SELECT x.*,p.sku,p.name FROM b2b_network_return_lines x JOIN products p ON(p.tenant_id,p.id)=(x.tenant_id,x.product_id) WHERE x.return_id=$1 ORDER BY x.product_id',
      [r.id],
    )
  ).rows;
  const recoveries = await recoveryPage(c, r.id);
  const wz = r.dispatch_document_id
    ? (
        await c.query('SELECT id,number FROM warehouse_documents WHERE id=$1', [
          r.dispatch_document_id,
        ])
      ).rows[0]
    : null;
  return {
    ...r,
    lines,
    recoveries: recoveries.data,
    recoveries_next: recoveries.next,
    dispatch_document: wz,
    supplier: safeCase(source, o.currency),
  };
}
export function registerB2bNetworkReturnRoutes(app: FastifyInstance) {
  const base = '/api/b2b/network/orders/:orderId',
    id = (r: any, n: string) => z.uuid().parse(r.params[n]);
  app.post(base + '/cancel', async (r) => {
    const a = r.actor,
      b = cancelInput.parse(r.body),
      input = { client_key: b.client_key, reason: b.reason };
    return tx(a.tenantId, async (c) => {
      await admin(c, a);
      const o = await order(c, id(r, 'orderId'), true);
      if (o.cancel_request) {
        ensure(
          isDeepStrictEqual(o.cancel_request, input),
          409,
          'Zakup anulowano z innym kluczem lub powodem',
        );
        return orderDetail(c, o);
      }
      ensure(
        o.version === b.version && ['ordered', 'cancelled'].includes(o.state),
        409,
        'Zakup zmienił się lub przyjęto już towar',
      );
      ensure(
        !(
          await c.query('SELECT 1 FROM b2b_network_order_lines WHERE order_id=$1 AND received>0', [
            o.id,
          ])
        ).rowCount,
        409,
        'Przyjęty towar obsłuż przez zwrot',
      );
      await supplierOrder(c, o);
      await cancelOrder(c, { tenantId: o.supplier_tenant_id, userId: null }, o.source_order_id);
      await audit(
        c,
        { tenantId: o.supplier_tenant_id, userId: null },
        'b2b.network.buyer_cancel',
        o.source_order_id,
        { buyer_order_id: o.id, reason: b.reason },
      );
      // 251 (B2B-004-X): a pending supplier decision is withdrawn with the purchase.
      await withdrawNetworkDecisionInTx(c, o, a, b.reason);
      await scope(c, a.tenantId);
      const updated = (
        await c.query(
          "UPDATE b2b_network_orders SET state='cancelled',version=version+1,cancel_request=$2,cancelled_at=now() WHERE id=$1 RETURNING *",
          [o.id, JSON.stringify(input)],
        )
      ).rows[0];
      await audit(c, a, 'b2b.network.cancel', o.id, { reason: b.reason });
      return orderDetail(c, updated);
    });
  });
  app.post(base + '/returns', async (r) => {
    const a = r.actor,
      b = returnSchema.parse(r.body),
      input = {
        kind: b.kind,
        reason: b.reason,
        shipping_refund: b.shipping_refund,
        lines: [...b.lines].sort((x, y) => x.product_id.localeCompare(y.product_id)),
      },
      fingerprint = hash(input);
    return tx(a.tenantId, async (c) => {
      await admin(c, a);
      const o = await order(c, id(r, 'orderId'), true);
      const old = (
        await c.query('SELECT * FROM b2b_network_returns WHERE order_id=$1 AND client_key=$2', [
          o.id,
          b.client_key,
        ])
      ).rows[0];
      if (old) {
        ensure(old.fingerprint === fingerprint, 409, 'Klucz zgłoszenia użyto z innymi danymi');
        return detail(c, o, old);
      }
      ensure(
        o.version === b.version && o.state !== 'cancelled',
        409,
        'Zakup zmienił się lub został anulowany',
      );
      const lines = (
        await c.query(
          "SELECT l.*,coalesce((SELECT sum(x.quantity-x.recovered) FROM b2b_network_return_lines x JOIN b2b_network_returns r ON(r.tenant_id,r.id)=(x.tenant_id,x.return_id) WHERE x.order_id=l.order_id AND x.product_id=l.product_id AND r.state<>'cancelled'),0)::int committed FROM b2b_network_order_lines l WHERE l.order_id=$1 ORDER BY l.product_id FOR UPDATE",
          [o.id],
        )
      ).rows;
      for (const i of input.lines) {
        const l = lines.find((l) => l.product_id === i.product_id);
        ensure(l, 422, 'Produkt nie należy do zakupu');
        ensure(
          i.quantity <= l.received - l.committed,
          409,
          'Zgłoszenie przekracza przyjęte i niezgłoszone ilości',
        );
      }
      await supplierOrder(c, o);
      const sourceItems = (
        await c.query('SELECT id,product_id FROM order_items WHERE order_id=$1', [
          o.source_order_id,
        ])
      ).rows;
      const mapped = input.lines.map((i) => {
        const l = lines.find((l) => l.product_id === i.product_id)!,
          s = sourceItems.find((s) => s.product_id === l.source_product_id);
        ensure(s, 409, 'Źródłowa pozycja zakupu jest niedostępna');
        return { ...i, item_id: s.id };
      });
      const sr = await requestReturn(
        c,
        { tenantId: o.supplier_tenant_id, userId: null },
        o.source_order_id,
        returnInput.parse({
          client_key: randomUUID(),
          kind: b.kind,
          reason: b.reason,
          shipping_refund: b.shipping_refund,
          items: mapped.map((i) => ({ item_id: i.item_id, quantity: i.quantity })),
        }),
        false,
        'buyer',
      );
      await scope(c, a.tenantId);
      const row = (
        await c.query(
          'INSERT INTO b2b_network_returns(id,tenant_id,order_id,supplier_tenant_id,source_return_id,client_key,fingerprint,input,source_number,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *',
          [
            randomUUID(),
            a.tenantId,
            o.id,
            o.supplier_tenant_id,
            sr.id,
            b.client_key,
            fingerprint,
            JSON.stringify(input),
            sr.number,
            a.userId,
          ],
        )
      ).rows[0];
      for (const i of mapped)
        await c.query(
          'INSERT INTO b2b_network_return_lines(tenant_id,order_id,return_id,product_id,source_item_id,quantity) VALUES($1,$2,$3,$4,$5,$6)',
          [a.tenantId, o.id, row.id, i.product_id, i.item_id, i.quantity],
        );
      await c.query('UPDATE b2b_network_orders SET version=version+1 WHERE id=$1', [o.id]);
      await audit(c, a, 'b2b.network.return.request', row.id, {
        order_id: o.id,
        source_return_id: sr.id,
      });
      return detail(c, o, row);
    });
  });
  app.get(base + '/returns', async (r) =>
    tx(r.actor.tenantId, async (c) => {
      const o = await order(c, id(r, 'orderId')),
        q = z.object({ after: z.uuid().optional() }).strict().parse(r.query);
      const rows = (
        await c.query(
          'SELECT * FROM b2b_network_returns WHERE order_id=$1 AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT 26',
          [o.id, q.after ?? null],
        )
      ).rows;
      // Page is bounded; each supplier case is authorized against its originating order.
      const data = [];
      for (const row of rows.slice(0, 25)) {
        await scope(c, o.tenant_id);
        data.push(await detail(c, o, row));
      }
      return { data, next: rows.length > 25 ? rows[24].id : null };
    }),
  );
  const returns = base + '/returns/:returnId';
  app.get(returns + '/recoveries', async (r) =>
    tx(r.actor.tenantId, async (c) => {
      const o = await order(c, id(r, 'orderId')),
        rr = await ownReturn(c, o, id(r, 'returnId')),
        q = z.object({ after: z.uuid().optional() }).strict().parse(r.query);
      await supplierCase(c, o, rr);
      await scope(c, o.tenant_id);
      return recoveryPage(c, rr.id, q.after);
    }),
  );
  app.get(returns, async (r) =>
    tx(r.actor.tenantId, async (c) => {
      const o = await order(c, id(r, 'orderId'));
      return detail(c, o, await ownReturn(c, o, id(r, 'returnId')));
    }),
  );
  app.post(returns + '/dispatch', async (r) => {
    const a = r.actor,
      b = dispatchSchema.parse(r.body);
    return tx(a.tenantId, async (c) => {
      await admin(c, a);
      const o = await order(c, id(r, 'orderId'), true),
        rr = await ownReturn(c, o, id(r, 'returnId'));
      if (rr.dispatch_document_id) return detail(c, o, rr);
      ensure(
        rr.state === 'requested' && rr.version === b.version,
        409,
        'Zgłoszenie zmieniło się lub jest wycofane',
      );
      await catalogs(c, [a.tenantId, o.supplier_tenant_id]);
      const sr = await supplierCase(c, o, rr, true);
      ensure(sr.state === 'requested', 409, 'Dostawca rozpatrzył zgłoszenie; odśwież jego decyzję');
      await scope(c, a.tenantId);
      const lines = (
        await c.query(
          'SELECT product_id,quantity FROM b2b_network_return_lines WHERE return_id=$1 ORDER BY product_id',
          [rr.id],
        )
      ).rows;
      await products(
        c,
        o.warehouse_id,
        lines.map((i) => i.product_id),
        false,
      );
      const draft = await createWarehouseDocument(
          c,
          a,
          warehouseSchema.parse({
            kind: 'issue',
            warehouse_id: o.warehouse_id,
            reference: rr.source_number,
            note: 'Wysłanie zwrotu B2B ' + rr.id,
            lines,
          }),
        ),
        wz = await postWarehouseDocument(c, a, draft.id, draft.version);
      const updated = (
        await c.query(
          "UPDATE b2b_network_returns SET state='dispatched',version=version+1,dispatch_document_id=$2,dispatch_request=$3,dispatched_at=now() WHERE id=$1 RETURNING *",
          [rr.id, wz.id, JSON.stringify(b)],
        )
      ).rows[0];
      await c.query('UPDATE b2b_network_orders SET version=version+1 WHERE id=$1', [o.id]);
      await audit(c, a, 'b2b.network.return.dispatch', rr.id, { document_id: wz.id });
      return detail(c, o, updated);
    });
  });
  app.post(returns + '/cancel', async (r) => {
    const a = r.actor,
      b = withdrawSchema.parse(r.body),
      input = { reason: b.reason };
    return tx(a.tenantId, async (c) => {
      await admin(c, a);
      const o = await order(c, id(r, 'orderId'), true),
        rr = await ownReturn(c, o, id(r, 'returnId'));
      if (rr.cancel_request) {
        ensure(
          isDeepStrictEqual(rr.cancel_request, input),
          409,
          'Zgłoszenie wycofano z innym powodem',
        );
        return detail(c, o, rr);
      }
      ensure(
        rr.state === 'requested' && !rr.dispatch_document_id && rr.version === b.version,
        409,
        'Wysłanego zwrotu nie można wycofać',
      );
      const sr = await supplierCase(c, o, rr, true);
      if (sr.state === 'requested')
        await decideReturn(c, { tenantId: o.supplier_tenant_id, userId: null }, sr.id, {
          version: Number(sr.version),
          decision: 'cancel',
          note: b.reason,
        });
      else
        ensure(
          ['rejected', 'cancelled'].includes(sr.state),
          409,
          'Dostawca przyjął już zwrot; uzgodnij rozliczenie',
        );
      await scope(c, a.tenantId);
      const updated = (
        await c.query(
          "UPDATE b2b_network_returns SET state='cancelled',version=version+1,cancel_request=$2,cancelled_at=now() WHERE id=$1 RETURNING *",
          [rr.id, JSON.stringify(input)],
        )
      ).rows[0];
      await c.query('UPDATE b2b_network_orders SET version=version+1 WHERE id=$1', [o.id]);
      await audit(c, a, 'b2b.network.return.cancel', rr.id, input);
      return detail(c, o, updated);
    });
  });
  app.post(returns + '/recoveries', async (r) => {
    const a = r.actor,
      b = recoverySchema.parse(r.body),
      input = { lines: [...b.lines].sort((x, y) => x.product_id.localeCompare(y.product_id)) },
      fingerprint = hash(input);
    return tx(a.tenantId, async (c) => {
      await admin(c, a);
      const o = await order(c, id(r, 'orderId'), true),
        rr = await ownReturn(c, o, id(r, 'returnId'));
      const old = (
        await c.query(
          'SELECT * FROM b2b_network_return_recoveries WHERE return_id=$1 AND client_key=$2',
          [rr.id, b.client_key],
        )
      ).rows[0];
      if (old) {
        ensure(
          old.fingerprint === fingerprint,
          409,
          'Klucz odbioru użyto z innymi ilościami lub lokalizacjami',
        );
        return old;
      }
      ensure(
        rr.state === 'dispatched' && rr.dispatch_document_id && rr.version === b.version,
        409,
        'Zwrot zmienił się lub nie został wysłany',
      );
      await catalogs(c, [a.tenantId, o.supplier_tenant_id]);
      const sr = await supplierCase(c, o, rr, true);
      ensure(
        ['rejected', 'cancelled', 'refund_pending', 'closed'].includes(sr.state),
        409,
        'Dostawca jeszcze nie rozpatrzył zwrotu',
      );
      await scope(c, a.tenantId);
      const lines = (
        await c.query(
          'SELECT * FROM b2b_network_return_lines WHERE return_id=$1 ORDER BY product_id FOR UPDATE',
          [rr.id],
        )
      ).rows;
      for (const i of input.lines) {
        const l = lines.find((l) => l.product_id === i.product_id);
        ensure(l, 422, 'Produkt nie należy do zwrotu');
        const accepted = ['refund_pending', 'closed'].includes(sr.state)
          ? (sr.items.find((x: any) => x.item_id === l.source_item_id)?.accepted ?? 0)
          : 0;
        ensure(
          i.quantity <= l.quantity - l.recovered - accepted,
          409,
          'Odbiór przekracza ilość nieprzyjętą przez dostawcę',
        );
      }
      await products(
        c,
        o.warehouse_id,
        input.lines.map((i) => i.product_id),
        false,
      );
      const draft = await createWarehouseDocument(
          c,
          a,
          warehouseSchema.parse({
            kind: 'receipt',
            warehouse_id: o.warehouse_id,
            reference: rr.source_number,
            note: 'Powrót nieprzyjętego zwrotu B2B ' + rr.id,
            lines: input.lines,
          }),
        ),
        pz = await postWarehouseDocument(c, a, draft.id, draft.version);
      const rec = (
        await c.query(
          'INSERT INTO b2b_network_return_recoveries(id,tenant_id,return_id,document_id,client_key,fingerprint,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',
          [randomUUID(), a.tenantId, rr.id, pz.id, b.client_key, fingerprint, a.userId],
        )
      ).rows[0];
      for (const i of input.lines) {
        await c.query(
          'INSERT INTO b2b_network_return_recovery_lines(tenant_id,return_id,recovery_id,product_id,quantity,location) VALUES($1,$2,$3,$4,$5,$6)',
          [a.tenantId, rr.id, rec.id, i.product_id, i.quantity, i.location],
        );
        await c.query(
          'UPDATE b2b_network_return_lines SET recovered=recovered+$3 WHERE return_id=$1 AND product_id=$2',
          [rr.id, i.product_id, i.quantity],
        );
      }
      await c.query('UPDATE b2b_network_returns SET version=version+1 WHERE id=$1', [rr.id]);
      await c.query('UPDATE b2b_network_orders SET version=version+1 WHERE id=$1', [o.id]);
      await audit(c, a, 'b2b.network.return.recover', rr.id, { document_id: pz.id });
      return rec;
    });
  });
}
