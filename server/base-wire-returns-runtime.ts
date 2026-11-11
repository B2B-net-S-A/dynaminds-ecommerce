/** Native port of the Base returns family: 220 order/product/warehouse sidecars +
 * the existing RMA (requestReturn, decideReturn, recordRefund, payment_entries). */
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { Actor } from './domain';
import { ensure } from './errors';
import { tenantTx, tenantReadTx } from './db';
import { parseBaseWireId, type BaseWireJson } from './base-wire-codec';
import { decideReturn, decisionInput, recordRefund, refundInput, requestReturn, returnInput } from './returns';
import { listReturnReasons } from './return-reasons223';
import { createBaseWireReturnsService, type BaseWireReturn, type BaseWireReturnLine, type BaseWireReturnsNative } from './base-wire-returns';

function publicNumber(raw: unknown): number {
  ensure(typeof raw === 'string' && /^[1-9][0-9]*$/.test(raw) && BigInt(raw) <= BigInt(Number.MAX_SAFE_INTEGER), 503, 'Brak trwałej tożsamości Base; wymagany poprawny bootstrap 220');
  return parseBaseWireId(Number(raw), false);
}
const optionalPublic = (raw: unknown) => raw === null ? null : publicNumber(raw);
const idempotencyKey = (clientKey: string) => 'base_wire220:' + clientKey;
// Same derivation as baseWireReturnId: hex digits 1–12 and 14 of the case UUID, + 1.
const RETURN_KEY = "substr(replace(r.id::text,'-',''),1,12)||substr(replace(r.id::text,'-',''),14,1)";
const RETURN_ID = `(('x'||lpad(${RETURN_KEY},16,'0'))::bit(64)::bigint+1)`;
const SECONDS = 'floor(extract(epoch FROM r.created_at))::bigint';
// The native state events written by requestReturn/receiveReturn/decideReturn/recordRefund.
const STATE_EVENTS = ['return.requested', 'return.received', 'return.rejected', 'return.cancelled', 'return.refund_recorded'];

export function createBaseWireReturnsNative(c: PoolClient, actor: Actor, reasons = false): BaseWireReturnsNative {
  const lines = async (orderIds: string[]) => (await c.query(`SELECT i.id,i.order_id,i.sku,i.name,i.quantity,i.line_total,i.vat,p.ean,p.parent_id,
      s.public_id::text AS public_id,ps.public_id::text AS parent_public_id,cs.public_id::text AS catalog_public_id
    FROM order_items i JOIN products p ON(p.tenant_id,p.id)=(i.tenant_id,i.product_id)
    LEFT JOIN base_wire220_product_ids s ON(s.tenant_id,s.local_id)=(p.tenant_id,p.id)
    LEFT JOIN base_wire220_product_ids ps ON(ps.tenant_id,ps.local_id)=(p.tenant_id,p.parent_id)
    LEFT JOIN base_wire220_catalog_ids cs ON(cs.tenant_id,cs.local_id)=(p.tenant_id,p.catalog_id)
    WHERE i.tenant_id=$1 AND i.order_id=ANY($2::uuid[]) ORDER BY i.order_id,s.public_id,i.id`, [actor.tenantId, orderIds])).rows.map(l => {
    ensure(l.parent_id === null || l.parent_public_id !== null, 503, 'Brak trwałej tożsamości Base; wymagany poprawny bootstrap 220');
    return { item_id: l.id as string, order_id: l.order_id as string, name: l.name as string, product_public_id: publicNumber(l.public_id),
      parent_public_id: optionalPublic(l.parent_public_id), catalog_public_id: publicNumber(l.catalog_public_id), sku: l.sku as string,
      ean: l.ean as string|null, quantity: l.quantity as number, line_total: l.line_total as number, vat: l.vat as number };
  });
  return {
    async allocate() { await c.query("SELECT public.base_wire220_allocate_pending('order')"); },
    async order(publicId) {
      const rows = (await c.query('SELECT local_id FROM base_wire220_order_ids WHERE tenant_id=$1 AND public_id=$2::bigint AND local_id IS NOT NULL', [actor.tenantId, publicId])).rows;
      ensure(rows.length <= 1, 503, 'Niespójna mapa zamówień Base');
      return rows[0]?.local_id ?? null;
    },
    async snapshot(orderId) {
      const o = (await c.query('SELECT id,currency,email,customer_name,address,warehouse_id FROM orders WHERE tenant_id=$1 AND id=$2', [actor.tenantId, orderId])).rows[0];
      ensure(o, 404, 'Nie znaleziono zamówienia');
      return { id: o.id, currency: o.currency, email: o.email, customer_name: o.customer_name, warehouse_id: o.warehouse_id,
        address: o.address && typeof o.address === 'object' ? o.address : {}, lines: await lines([orderId]) };
    },
    async warehouses() {
      const rows = (await c.query('SELECT w.id,s.public_id::text AS public_id FROM warehouses w LEFT JOIN base_wire220_warehouse_ids s ON(s.tenant_id,s.local_id)=(w.tenant_id,w.id) WHERE w.tenant_id=$1 ORDER BY s.public_id,w.id', [actor.tenantId])).rows;
      return rows.map(r => ({ id: r.id, public_id: publicNumber(r.public_id) }));
    },
    async find(publicId) {
      return (await c.query(`SELECT r.id FROM return_cases r WHERE r.tenant_id=$1 AND ${RETURN_ID}=$2::bigint ORDER BY r.id`, [actor.tenantId, publicId])).rows.map(r => r.id);
    },
    async taken(returnId, key) {
      return !!(await c.query(`SELECT 1 FROM return_cases r WHERE r.tenant_id=$1 AND r.id<>$2 AND ${RETURN_KEY}=$3 LIMIT 1`, [actor.tenantId, returnId, key])).rowCount;
    },
    async returns(f) {
      // Deterministic LOCAL order: (creation second, return_id); id_from alone pages by return_id.
      const order = f.id_from !== undefined && f.date_from === undefined ? RETURN_ID : `${SECONDS},${RETURN_ID}`;
      const rows = (await c.query(`SELECT r.id,s.public_id::text AS order_public_id,o.external_id,r.number,r.state,${SECONDS}::text AS created,
          coalesce((SELECT floor(extract(epoch FROM max(e.created_at)))::bigint FROM order_events e WHERE e.tenant_id=r.tenant_id AND e.order_id=r.order_id
            AND e.kind=ANY($8::text[]) AND e.detail->>'return_id'=r.id::text),${SECONDS})::text AS in_status,
          o.currency,coalesce((r.settlement->>'amount')::bigint,0)::text AS refunded,o.email,o.customer_name,o.address,
          CASE WHEN r.state IN('refund_pending','closed') THEN r.refunded_shipping ELSE r.requested_shipping END AS shipping,
          r.reason,${reasons ? '(SELECT d.public_id::text FROM return_case_reasons223 x JOIN return_reasons223 d ON(d.tenant_id,d.id)=(x.tenant_id,x.reason_id) WHERE (x.tenant_id,x.return_id)=(r.tenant_id,r.id))' : 'NULL::text'} AS reason_public_id,
          wh.public_id::text AS warehouse_public_id
        FROM return_cases r JOIN orders o ON(o.tenant_id,o.id)=(r.tenant_id,r.order_id)
        JOIN base_wire220_order_ids s ON(s.tenant_id,s.local_id)=(o.tenant_id,o.id)
        LEFT JOIN base_wire220_warehouse_ids wh ON(wh.tenant_id,wh.local_id)=(r.tenant_id,r.warehouse_id)
        WHERE r.tenant_id=$1 AND ($2::bigint IS NULL OR s.public_id=$2) AND ($3::uuid[] IS NULL OR r.id=ANY($3))
          AND ($4::bigint IS NULL OR $5::bigint IS NOT NULL OR ${SECONDS}>=$4)
          AND ($5::bigint IS NULL OR $4::bigint IS NOT NULL OR ${RETURN_ID}>=$5)
          AND ($4::bigint IS NULL OR $5::bigint IS NULL OR (${SECONDS},${RETURN_ID})>=($4::bigint,$5::bigint))
          AND ($6::text IS NULL OR r.state=$6)
        ORDER BY ${order} LIMIT $7`,
      [actor.tenantId, f.order_public_id ?? null, f.return_ids ?? null, f.date_from ?? null, f.id_from ?? null, f.state ?? null, f.limit, STATE_EVENTS])).rows;
      if (!rows.length) return [];
      const items = (await c.query('SELECT return_id,item_id,requested FROM return_items WHERE tenant_id=$1 AND return_id=ANY($2::uuid[]) ORDER BY return_id,item_id',
        [actor.tenantId, rows.map(r => r.id)])).rows;
      const sold = await lines([...new Set((await c.query('SELECT DISTINCT order_id FROM return_items WHERE tenant_id=$1 AND return_id=ANY($2::uuid[])',
        [actor.tenantId, rows.map(r => r.id)])).rows.map(r => r.order_id as string))]);
      return rows.map((r): BaseWireReturn => ({
        id: r.id, order_public_id: publicNumber(r.order_public_id), external_id: r.external_id, number: r.number, state: r.state,
        created: Number(r.created), in_status: Number(r.in_status), currency: r.currency, refunded: Number(r.refunded), email: r.email,
        customer_name: r.customer_name, address: r.address && typeof r.address === 'object' ? r.address : {}, shipping: r.shipping,
        reason: r.reason, reason_public_id: optionalPublic(r.reason_public_id), warehouse_public_id: publicNumber(r.warehouse_public_id),
        lines: items.filter(i => i.return_id === r.id).map((i): BaseWireReturnLine => {
          const line = sold.find(l => l.item_id === i.item_id);
          ensure(line, 503, 'Niespójna pozycja zwrotu');
          const { order_id: _order, ...rest } = line;
          return { ...rest, requested: i.requested };
        }),
      }));
    },
    async state(returnId) {
      const r = (await c.query('SELECT id,state,version::text AS version,settlement FROM return_cases WHERE tenant_id=$1 AND id=$2', [actor.tenantId, returnId])).rows[0];
      ensure(r, 404, 'Nie znaleziono zwrotu');
      const s = r.settlement;
      return { id: r.id, state: r.state, version: Number(r.version),
        settlement: s && typeof s === 'object' ? { amount: Number(s.amount), reference: String(s.reference ?? '') } : null };
    },
    async payments(returnId) {
      const total = (await c.query('SELECT refund_amount FROM return_cases WHERE tenant_id=$1 AND id=$2', [actor.tenantId, returnId])).rows[0];
      ensure(total, 404, 'Nie znaleziono zwrotu');
      const rows = (await c.query(`SELECT amount,currency,reference,floor(extract(epoch FROM created_at))::bigint::text AS date FROM payment_entries
        WHERE tenant_id=$1 AND return_id=$2 AND kind='refund' ORDER BY created_at,id`, [actor.tenantId, returnId])).rows;
      return { total: total.refund_amount, entries: rows.map(r => ({ amount: r.amount, currency: r.currency, reference: r.reference, date: Number(r.date) })) };
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
    async reasons() {
      ensure(reasons, 503, 'Słownik powodów zwrotu jest niedostępny');
      return (await listReturnReasons(c)).map(r => ({ public_id: r.public_id, name: r.name }));
    },
    async request(orderId, { reason_public_id: reasonPublicId, ...input }) {
      let reasonId: string | undefined;
      if (reasonPublicId !== undefined) {
        ensure(reasons, 503, 'Słownik powodów zwrotu jest niedostępny');
        reasonId = (await c.query('SELECT id FROM return_reasons223 WHERE tenant_id=$1 AND public_id=$2::bigint', [actor.tenantId, reasonPublicId])).rows[0]?.id;
        ensure(reasonId, 404, 'Nie znaleziono powodu zwrotu');
      }
      const r = await requestReturn(c, actor, orderId, returnInput.parse({ ...input, client_key: randomUUID(), ...(reasonId ? { reason_id: reasonId } : {}) }));
      return r.id as string;
    },
    async decide(returnId, input) { await decideReturn(c, actor, returnId, decisionInput.parse(input)); },
    async refund(returnId, input) { await recordRefund(c, actor, returnId, refundInput.parse(input)); },
  };
}
export function createDefaultBaseWireReturnsService(opts: { readOnly: boolean; reasons?: boolean }) {
  return createBaseWireReturnsService({
    transaction: (actor, writing, work) => (writing ? tenantTx : tenantReadTx)(actor.tenantId, work),
    native: (c, actor) => createBaseWireReturnsNative(c, actor, opts.reasons === true),
    allocateOnRead: opts.readOnly !== true,
    reasons: opts.reasons === true,
  });
}
