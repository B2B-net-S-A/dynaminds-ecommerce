/** Native port of the Base orders family: 220 sidecars + the existing OMS
 * (createOrder, recordPayment, set_workflow order operation, paymentBalance,
 * order fields, order merge preview/execute, 222 order split preview/execute). */
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { createOrder, orderSchema, type Actor } from './domain';
import { ensure } from './errors';
import { tenantTx, tenantReadTx } from './db';
import { parseBaseWireId, type BaseWireJson } from './base-wire-codec';
import { applyOrderAction } from './order-operations';
import type { OrderAction } from './operation-schema';
import { paymentBalance, recordPayment } from './payments';
import { orderMergePaymentSourceIdsInTx, resolveOrderMergeOwnerInTx } from './order-merge-payments';
import { orderMergeClaimInTx } from './order-merge-guards';
import { listOrderFieldsInTx, patchOrderFieldsInTx } from './order-fields';
import type { OrderFieldChange } from './order-fields-schema';
import { createOrderMergePreview, executeOrderMerge } from './order-merges';
import { captureOrderMergeBuyerAddressActor } from './buyer-address';
import { captureOrderSplit222Actor, createOrderSplit222Preview, executeOrderSplit222 } from './order-split222';
import { createBaseWireOrdersService, baseWireOrderProductId, type BaseWireOrder, type BaseWireOrderLine, type BaseWireOrdersNative, type BaseWireOrdersPorts } from './base-wire-orders';

function publicNumber(raw: unknown): number {
  ensure(typeof raw === 'string' && /^[1-9][0-9]*$/.test(raw) && BigInt(raw) <= BigInt(Number.MAX_SAFE_INTEGER), 503, 'Brak trwałej tożsamości Base; wymagany poprawny bootstrap 220');
  return parseBaseWireId(Number(raw), false);
}
const optionalPublic = (raw: unknown) => raw === null ? null : publicNumber(raw);
const idempotencyKey = (clientKey: string) => 'base_wire220:' + clientKey;
const PAYMENT_REFERENCE = 'Base API addOrder paid=1';
// Unix seconds of the native creation time; Base date_add = date_confirmed (LOCAL).
const SECONDS = "floor(extract(epoch FROM o.created_at))::bigint";

export function createBaseWireOrdersNative(c: PoolClient, actor: Actor, opts: { mergeClaims: boolean }): BaseWireOrdersNative {
  // Same operational predicate as GET /api/orders: merged source orders are hidden.
  const operational = opts.mergeClaims ? 'AND NOT EXISTS(SELECT 1 FROM order_merge_claims m WHERE m.tenant_id=o.tenant_id AND m.source_order_id=o.id)' : '';
  return {
    async statuses() {
      const rows = (await c.query(`SELECT w.id,w.name,w.color,w.active,s.public_id::text AS public_id FROM workflow_statuses w
        LEFT JOIN base_wire220_order_status_ids s ON(s.tenant_id,s.local_id)=(w.tenant_id,w.id) WHERE w.tenant_id=$1 ORDER BY s.public_id,w.id`, [actor.tenantId])).rows;
      return rows.map(r => ({ id: r.id, public_id: publicNumber(r.public_id), name: r.name, color: r.color, active: r.active }));
    },
    async warehouses() {
      const rows = (await c.query('SELECT w.id,s.public_id::text AS public_id FROM warehouses w LEFT JOIN base_wire220_warehouse_ids s ON(s.tenant_id,s.local_id)=(w.tenant_id,w.id) WHERE w.tenant_id=$1 ORDER BY s.public_id,w.id', [actor.tenantId])).rows;
      return rows.map(r => ({ id: r.id, public_id: publicNumber(r.public_id) }));
    },
    async products(by) {
      if (!by.public_ids.length && !by.skus.length && !by.eans.length) return [];
      const rows = (await c.query(`SELECT p.id,s.public_id::text AS public_id,p.kind,p.parent_id,ps.public_id::text AS parent_public_id,cs.public_id::text AS catalog_public_id,p.sku,p.ean,p.vat
        FROM products p JOIN base_wire220_product_ids s ON(s.tenant_id,s.local_id)=(p.tenant_id,p.id)
        LEFT JOIN base_wire220_product_ids ps ON(ps.tenant_id,ps.local_id)=(p.tenant_id,p.parent_id)
        LEFT JOIN base_wire220_catalog_ids cs ON(cs.tenant_id,cs.local_id)=(p.tenant_id,p.catalog_id)
        WHERE p.tenant_id=$1 AND (s.public_id=ANY($2::bigint[]) OR p.sku=ANY($3::text[]) OR p.ean=ANY($4::text[])) ORDER BY s.public_id`,
      [actor.tenantId, by.public_ids, by.skus, by.eans])).rows;
      return rows.map(r => {
        ensure(r.parent_id === null || r.parent_public_id !== null, 503, 'Brak trwałej tożsamości Base; wymagany poprawny bootstrap 220');
        return { id: r.id, public_id: publicNumber(r.public_id), kind: r.kind, parent_public_id: optionalPublic(r.parent_public_id),
          catalog_public_id: publicNumber(r.catalog_public_id), sku: r.sku, ean: r.ean, vat: r.vat };
      });
    },
    async allocate() { await c.query("SELECT public.base_wire220_allocate_pending('order')"); },
    async order(publicId) {
      const rows = (await c.query('SELECT local_id FROM base_wire220_order_ids WHERE tenant_id=$1 AND public_id=$2::bigint AND local_id IS NOT NULL', [actor.tenantId, publicId])).rows;
      ensure(rows.length <= 1, 503, 'Niespójna mapa zamówień Base');
      return rows[0]?.local_id ?? null;
    },
    async publicId(orderId) {
      const rows = (await c.query('SELECT public_id::text AS public_id FROM base_wire220_order_ids WHERE tenant_id=$1 AND local_id=$2', [actor.tenantId, orderId])).rows;
      ensure(rows.length === 1, 503, 'Brak trwałej tożsamości Base zamówienia');
      return publicNumber(rows[0].public_id);
    },
    async orders(f) {
      // Deterministic LOCAL order: (confirmation second, order_id). The keyset
      // (date_confirmed_from, id_from) continues inside one second without gaps;
      // id_from alone pages by order_id (IDs are not monotonic in creation time).
      const order = f.id_from !== undefined && f.confirmed_from === undefined ? 's.public_id' : f.descending ? `${SECONDS} DESC,s.public_id DESC` : `${SECONDS},s.public_id`;
      const rows = (await c.query(`SELECT o.id,s.public_id::text AS public_id,o.source,o.external_id,ws.public_id::text AS status_public_id,
          ${SECONDS}::text AS created,o.currency,o.payment_mode,o.note,o.email,o.customer_name,o.address,o.shipping_cost,o.status,
          wh.public_id::text AS warehouse_public_id,sh.carrier,sh.tracking_number,
          coalesce((SELECT floor(extract(epoch FROM max(e.created_at)))::bigint FROM order_events e WHERE e.tenant_id=o.tenant_id AND e.order_id=o.id
            AND (e.kind IN('order.created','order.workflow_changed') OR e.kind='order.'||o.status)),${SECONDS})::text AS in_status,
          (EXISTS(SELECT 1 FROM order_pick_items i WHERE i.tenant_id=o.tenant_id AND i.order_id=o.id)
            AND NOT EXISTS(SELECT 1 FROM order_pick_items i WHERE i.tenant_id=o.tenant_id AND i.order_id=o.id AND i.scanned<i.quantity)) AS picked
        FROM base_wire220_order_ids s JOIN orders o ON(o.tenant_id,o.id)=(s.tenant_id,s.local_id)
        LEFT JOIN base_wire220_order_status_ids ws ON(ws.tenant_id,ws.local_id)=(o.tenant_id,o.workflow_status_id)
        LEFT JOIN base_wire220_warehouse_ids wh ON(wh.tenant_id,wh.local_id)=(o.tenant_id,o.warehouse_id)
        LEFT JOIN shipments sh ON(sh.tenant_id,sh.order_id)=(o.tenant_id,o.id)
        WHERE s.tenant_id=$1 ${operational}
          AND ($2::bigint IS NULL OR s.public_id=$2) AND ($3::bigint IS NULL OR ${SECONDS}>=$3)
          AND ($4::bigint IS NULL OR $5::bigint IS NOT NULL OR ${SECONDS}>=$4)
          AND ($5::bigint IS NULL OR $4::bigint IS NOT NULL OR s.public_id>=$5)
          AND ($4::bigint IS NULL OR $5::bigint IS NULL OR (${SECONDS},s.public_id)>=($4::bigint,$5::bigint))
          AND ($6::bigint IS NULL OR ws.public_id=$6) AND ($11::text IS NULL OR (o.workflow_status_id IS NULL AND o.status=$11)) AND ($7::text IS NULL OR lower(o.email)=lower($7))
          AND ($8::text[] IS NULL OR o.source=ANY($8)) AND ($9::text IS NULL OR o.external_id=$9) AND ($12::text IS NULL OR o.address->>'phone'=$12)
        ORDER BY ${order} LIMIT $10`,
      [actor.tenantId, f.public_id ?? null, f.date_from ?? null, f.confirmed_from ?? null, f.id_from ?? null, f.status_public_id ?? null,
        f.email ?? null, f.sources ?? null, f.external_id ?? null, f.limit, f.stage ?? null, f.phone ?? null])).rows;
      if (!rows.length) return [];
      const lines = (await c.query(`SELECT i.id AS item_id,i.order_id,i.name,i.sku,i.quantity,i.line_total,i.vat,p.ean,p.parent_id,s.public_id::text AS public_id,
          ps.public_id::text AS parent_public_id,cs.public_id::text AS catalog_public_id
        FROM order_items i JOIN products p ON(p.tenant_id,p.id)=(i.tenant_id,i.product_id)
        LEFT JOIN base_wire220_product_ids s ON(s.tenant_id,s.local_id)=(p.tenant_id,p.id)
        LEFT JOIN base_wire220_product_ids ps ON(ps.tenant_id,ps.local_id)=(p.tenant_id,p.parent_id)
        LEFT JOIN base_wire220_catalog_ids cs ON(cs.tenant_id,cs.local_id)=(p.tenant_id,p.catalog_id)
        WHERE i.tenant_id=$1 AND i.order_id=ANY($2::uuid[]) ORDER BY i.order_id,s.public_id,i.id`, [actor.tenantId, rows.map(r => r.id)])).rows;
      const out: BaseWireOrder[] = [];
      for (const r of rows) {
        // Same balance as the order card and GET /api/orders/:id/payments (merge-aware).
        const balance = await paymentBalance(c, r.id);
        out.push({ public_id: publicNumber(r.public_id), source: r.source, external_id: r.external_id, status_public_id: optionalPublic(r.status_public_id),
          created: Number(r.created), in_status: Number(r.in_status), currency: r.currency, payment_mode: r.payment_mode, paid: Number(balance.net),
          note: r.note, email: r.email, customer_name: r.customer_name, address: r.address && typeof r.address === 'object' ? r.address : {},
          shipping_cost: r.shipping_cost, carrier: r.carrier, tracking: r.tracking_number, picked: r.picked, status: r.status,
          warehouse_public_id: publicNumber(r.warehouse_public_id),
          lines: lines.filter(l => l.order_id === r.id).map((l): BaseWireOrderLine => {
            ensure(l.parent_id === null || l.parent_public_id !== null, 503, 'Brak trwałej tożsamości Base; wymagany poprawny bootstrap 220');
            return { item_id: l.item_id, product_public_id: publicNumber(l.public_id), parent_public_id: optionalPublic(l.parent_public_id), catalog_public_id: publicNumber(l.catalog_public_id),
              name: l.name, sku: l.sku, ean: l.ean, quantity: l.quantity, line_total: l.line_total, vat: l.vat };
          }) });
      }
      return out;
    },
    async replay(clientKey, requestHash) {
      await c.query('INSERT INTO idempotency_keys(tenant_id,key,request_hash) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [actor.tenantId, idempotencyKey(clientKey), requestHash]);
      const prior = (await c.query('SELECT request_hash,response FROM idempotency_keys WHERE tenant_id=$1 AND key=$2 FOR UPDATE', [actor.tenantId, idempotencyKey(clientKey)])).rows[0];
      ensure(prior?.request_hash === requestHash, 409, 'Klucz polecenia wskazuje inną treść lub klucz API');
      return (prior.response ?? null) as Record<string, BaseWireJson> | null;
    },
    async remember(clientKey, response) {
      await c.query('UPDATE idempotency_keys SET response=$3 WHERE tenant_id=$1 AND key=$2', [actor.tenantId, idempotencyKey(clientKey), JSON.stringify(response)]);
    },
    async create(input) {
      // POST /api/orders semantics for an API key without order-fields:write.
      const order = await createOrder(c, actor, orderSchema.parse(input), undefined, { fieldSource: 'api', fieldWritesAllowed: false });
      return order.id as string;
    },
    async payInFull(orderId) {
      const balance = await paymentBalance(c, orderId);
      if (balance.amount_due <= 0) return;
      const o = (await c.query('SELECT version FROM orders WHERE tenant_id=$1 AND id=$2', [actor.tenantId, orderId])).rows[0];
      ensure(o, 404, 'Nie znaleziono zamówienia');
      await recordPayment(c, actor, orderId, { client_key: randomUUID(), version: Number(o.version), kind: 'receipt', amount: balance.amount_due, fee: 0,
        currency: balance.currency as 'PLN', method: 'other', reference: PAYMENT_REFERENCE, note: '', confirmed: true });
    },
    async setStatus(orderId, statusId) { await applyOrderAction(c, actor, orderId, { type: 'set_workflow', status_id: statusId }); },
    async setStage(orderId, stage) {
      const result = await applyOrderAction(c, actor, orderId, { type: 'set_status', status: stage as Extract<OrderAction, { type: 'set_status' }>['status'] });
      if ((result as { changed?: boolean }).changed !== false) return { kept_workflow: false };
      // Unchanged: the order row is locked by the native operation, so this read is stable.
      const row = (await c.query('SELECT workflow_status_id FROM orders WHERE tenant_id=$1 AND id=$2', [actor.tenantId, orderId])).rows[0];
      return { kept_workflow: row?.workflow_status_id != null };
    },
    async extraFields() {
      // Same definitions, role filter and order as GET /api/order-fields.
      return (await listOrderFieldsInTx(c, actor)).data.map((d: Record<string, any>) => ({ id: d.id, key: d.key, label: d.label, type: d.type,
        version: Number(d.version), enabled: d.enabled === true, options: (d.options ?? []).map((o: Record<string, any>) => ({ id: o.id, label: o.label, enabled: o.enabled === true })) }));
    },
    async patchFields(orderId, changes) {
      // PATCH /api/orders/:id/fields semantics (source api) at the version read under the native lock.
      const o = (await c.query('SELECT version::float8 AS version FROM orders WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [actor.tenantId, orderId])).rows[0];
      ensure(o, 404, 'Nie znaleziono zamówienia');
      await patchOrderFieldsInTx(c, actor, orderId, { client_key: randomUUID(), order_version: Number(o.version), changes: changes as OrderFieldChange[] }, 'api');
    },
    async paymentState(orderId) {
      // recordPayment locks the same owner row; locking it first makes balance + delta one step.
      const owner = await resolveOrderMergeOwnerInTx(c, orderId);
      await c.query('SELECT 1 FROM orders WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [actor.tenantId, owner]);
      const balance = await paymentBalance(c, orderId);
      const o = (await c.query('SELECT version FROM orders WHERE tenant_id=$1 AND id=$2', [actor.tenantId, orderId])).rows[0];
      ensure(o, 404, 'Nie znaleziono zamówienia');
      return { net: Number(balance.net), currency: balance.currency, version: Number(o.version) };
    },
    async receipt(orderId, e) {
      await recordPayment(c, actor, orderId, { client_key: randomUUID(), version: e.version, kind: 'receipt', amount: e.amount, fee: 0,
        currency: e.currency as 'PLN', method: 'other', reference: e.reference, note: e.note, confirmed: true });
    },
    async payments(orderId) {
      // Same ledger sources as GET /api/orders/:id/payments (paymentHistory), oldest first.
      const sources = (await orderMergeClaimInTx(c, orderId)) ? [orderId] : await orderMergePaymentSourceIdsInTx(c, orderId);
      const rows = (await c.query(`SELECT coalesce(r.kind,p.kind) AS kind,p.reversal_of IS NOT NULL AS reversal,p.amount,p.method,p.reference,p.note,
          floor(extract(epoch FROM p.created_at))::bigint::text AS created
        FROM payment_entries p LEFT JOIN payment_entries r ON(r.tenant_id,r.order_id,r.id)=(p.tenant_id,p.order_id,p.reversal_of)
        WHERE p.tenant_id=$1 AND p.order_id=ANY($2::uuid[]) ORDER BY p.created_at,p.id`, [actor.tenantId, sources])).rows;
      const o = (await c.query('SELECT total FROM orders WHERE tenant_id=$1 AND id=$2', [actor.tenantId, orderId])).rows[0];
      ensure(o, 404, 'Nie znaleziono zamówienia');
      return { total: Number(o.total), currency: (await paymentBalance(c, orderId)).currency,
        entries: rows.map(r => ({ kind: r.kind, reversal: r.reversal, amount: Number(r.amount), method: r.method, reference: r.reference, note: r.note, created: Number(r.created) })) };
    },
  };
}
/** POST /api/order-merges/previews then /execute, as the API key itself (same custody as the
 * native v1 Bearer route). Base main_order_id keeps its receiver, so a receiver conflict is
 * the explicit selection of the main order (confirmed_receiver_selection). */
export function createBaseWireOrderMerge(sessionName: string): NonNullable<BaseWireOrdersPorts['merge']> {
  return async (actor, credential, m) => {
    const a = captureOrderMergeBuyerAddressActor({ actor: { tenantId: actor.tenantId, userId: actor.userId, role: actor.role, apiKeyId: actor.apiKeyId, source: 'api' },
      currentUser: { id: actor.userId, tenant_id: actor.tenantId }, headers: { authorization: 'Bearer ' + credential }, cookies: {} }, sessionName);
    const { preview } = await createOrderMergePreview(a, { client_key: m.preview_key, main_order_id: m.main_order_id, order_ids_to_merge: m.order_ids,
      merge_mode: m.merge_mode, sum_delivery_costs: m.sum_delivery_costs });
    const { execution } = await executeOrderMerge(a, { client_key: m.execute_key, preview_id: preview.id, scope_hash: preview.scope_hash, confirmed: true,
      ...(preview.receiver_conflict ? { confirmed_receiver_selection: true } : {}) });
    ensure(typeof execution?.target_order_id === 'string', 503, 'Niekompletny wynik łączenia zamówień');
    return execution.target_order_id as string;
  };
}
/** POST /api/orders/:id/splits/previews then /api/order-splits/:id/execute as the API key
 * itself (presented-key custody). order_product_id is matched against the parent's current
 * lines and the lines it already moved away (so an exact replay maps the same items). */
export function createBaseWireOrderSplit(): NonNullable<BaseWireOrdersPorts['split']> {
  return async (actor, credential, m) => {
    const a = captureOrderSplit222Actor({ tenantId: actor.tenantId, userId: actor.userId, role: actor.role, apiKeyId: actor.apiKeyId, source: 'api' }, credential);
    const ids = await tenantReadTx(actor.tenantId, async c => (await c.query(`SELECT id FROM order_items WHERE tenant_id=$1 AND order_id=$2
      UNION SELECT t.source_item_id FROM order_split222_targets t JOIN order_split222_executions e ON(e.tenant_id,e.id)=(t.tenant_id,t.execution_id)
      WHERE e.tenant_id=$1 AND e.parent_order_id=$2`, [actor.tenantId, m.order_id])).rows.map(r => r.id as string));
    const byPublic = new Map<number, string[]>();
    for (const id of ids) byPublic.set(baseWireOrderProductId(id), [...(byPublic.get(baseWireOrderProductId(id)) ?? []), id]);
    const items = m.items.map(i => {
      const found = byPublic.get(i.order_product_id) ?? [];
      ensure(found.length <= 1, 503, 'Kolizja identyfikatora pozycji Base');
      ensure(found.length === 1, 404, 'Nie znaleziono pozycji zamówienia');
      return { item_id: found[0], quantity: i.quantity };
    });
    const { preview } = await createOrderSplit222Preview(a, m.order_id, { client_key: m.preview_key, items, shipping_cost_to_child: m.shipping_cost_to_child });
    const { execution } = await executeOrderSplit222(a, preview.id, { client_key: m.execute_key, scope_hash: preview.scope_hash });
    ensure(typeof execution?.child_order_id === 'string', 503, 'Niekompletny wynik podziału zamówienia');
    return execution.child_order_id;
  };
}
export function createDefaultBaseWireOrdersService(opts: { readOnly: boolean; mergeClaims: boolean; orderMerges?: boolean; orderSplits?: boolean; sessionName?: string }) {
  return createBaseWireOrdersService({
    transaction: (actor, writing, work) => (writing ? tenantTx : tenantReadTx)(actor.tenantId, work),
    native: (c, actor) => createBaseWireOrdersNative(c, actor, { mergeClaims: opts.mergeClaims }),
    allocateOnRead: opts.readOnly !== true,
    // Order merges need the complete native module and the session namespace of the custody check.
    ...(opts.orderMerges === true && opts.sessionName ? { merge: createBaseWireOrderMerge(opts.sessionName) } : {}),
    // The native split needs the complete 222 schema.
    ...(opts.orderSplits === true ? { split: createBaseWireOrderSplit() } : {}),
  });
}
