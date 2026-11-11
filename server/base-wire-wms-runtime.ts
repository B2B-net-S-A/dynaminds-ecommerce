/** Native port of the Base WMS family: 220 warehouse/product/catalog sidecars + the existing
 * warehouse documents (createWarehouseDocument, editWarehouseDocument, postWarehouseDocument),
 * purchasing (supplierSave, purchaseSave, purchaseAction, purchaseReceipt) and stocktake rows. */
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { Actor } from './domain';
import { ensure } from './errors';
import { pool, tenantTx, tenantReadTx } from './db';
import { parseBaseWireId, type BaseWireJson } from './base-wire-codec';
import { warehouseSchema, versionSchema, createWarehouseDocument, editWarehouseDocument, postWarehouseDocument } from './warehouse';
import { supplierInput, supplierSave, purchaseInput, purchaseVersion, purchaseFinish, purchaseReceive, purchaseSave, purchaseAction, purchaseReceipt } from './purchasing';
import { createBaseWireWmsService, type BaseWireWmsEntity, type BaseWireWmsKind, type BaseWireWmsLine, type BaseWireWmsNative } from './base-wire-wms';

function publicNumber(raw: unknown): number {
  ensure(typeof raw === 'string' && /^[1-9][0-9]*$/.test(raw) && BigInt(raw) <= BigInt(Number.MAX_SAFE_INTEGER), 503, 'Brak trwałej tożsamości Base; wymagany poprawny bootstrap 220');
  return parseBaseWireId(Number(raw), false);
}
const optionalPublic = (raw: unknown) => raw === null ? null : publicNumber(raw);
const seconds = (raw: unknown) => Number(raw ?? 0);
const idempotencyKey = (clientKey: string) => 'base_wire220:' + clientKey;
// Same derivation as baseWireWmsId: hex digits 1–12 and 14 of the native UUID, + 1.
const key = (column: string) => `substr(replace(${column}::text,'-',''),1,12)||substr(replace(${column}::text,'-',''),14,1)`;
const derived = (column: string) => `(('x'||lpad(${key(column)},16,'0'))::bit(64)::bigint+1)`;
const epoch = (expression: string) => `coalesce(floor(extract(epoch FROM ${expression}))::bigint,0)::text`;
const TABLES: Record<BaseWireWmsEntity, { table: string; filter: string }> = {
  document: { table: 'warehouse_documents', filter: "AND x.kind IN('receipt','issue','transfer')" },
  purchase: { table: 'purchase_orders', filter: '' },
  supplier: { table: 'suppliers', filter: '' },
  stocktake: { table: 'stocktakes', filter: '' },
};
// The native REST schemas require ≥1 line; the Base draft is created empty first (the tables allow it).
const emptyDocument = warehouseSchema.extend({ lines: z.array(warehouseSchema.shape.lines.element).max(200) });
const purchaseDraft = purchaseInput.extend({ lines: z.array(purchaseInput.shape.lines.element).max(200) });
const PRODUCT = `p.ean,s.public_id::text AS public_id,cs.public_id::text AS catalog_public_id
  FROM products p LEFT JOIN base_wire220_product_ids s ON(s.tenant_id,s.local_id)=(p.tenant_id,p.id)
  LEFT JOIN base_wire220_catalog_ids cs ON(cs.tenant_id,cs.local_id)=(p.tenant_id,p.catalog_id)`;
const line = (l: Record<string, any>): BaseWireWmsLine => ({ product_id: l.product_id, product_public_id: publicNumber(l.public_id),
  catalog_public_id: publicNumber(l.catalog_public_id), name: l.name, sku: l.sku, ean: l.ean ?? null, quantity: l.quantity });

export function createBaseWireWmsNative(c: PoolClient, actor: Actor): BaseWireWmsNative {
  const t = actor.tenantId;
  async function purchaseHead(id: string) {
    const p = (await c.query('SELECT id,state,version,supplier_id,warehouse_id,currency,reference,note,expected_date::text AS expected_date FROM purchase_orders WHERE tenant_id=$1 AND id=$2', [t, id])).rows[0];
    ensure(p, 404, 'Nie znaleziono zamówienia zakupowego');
    const lines = (await c.query(`SELECT l.product_id,l.name,l.sku,l.quantity,l.received_quantity,l.closed_quantity,l.unit_cost,l.supplier_sku,
        coalesce((SELECT array_agg(DISTINCT r.location ORDER BY r.location) FROM purchase_receipt_lines r WHERE (r.tenant_id,r.order_id,r.product_id)=(l.tenant_id,l.order_id,l.product_id)),'{}') AS locations,
        ${PRODUCT} JOIN purchase_order_lines l ON(l.tenant_id,l.product_id)=(p.tenant_id,p.id)
      WHERE l.tenant_id=$1 AND l.order_id=$2 ORDER BY l.sku,l.product_id`, [t, id])).rows;
    return { id: p.id, state: p.state, version: p.version, supplier_id: p.supplier_id, warehouse_id: p.warehouse_id, currency: p.currency, reference: p.reference,
      note: p.note, expected_date: p.expected_date, lines: lines.map(l => ({ ...line(l), received: l.received_quantity, closed: l.closed_quantity, unit_cost: l.unit_cost,
        supplier_sku: l.supplier_sku, locations: l.locations as string[] })) };
  }
  return {
    async warehouses() {
      const rows = (await c.query('SELECT w.id,s.public_id::text AS public_id FROM warehouses w LEFT JOIN base_wire220_warehouse_ids s ON(s.tenant_id,s.local_id)=(w.tenant_id,w.id) WHERE w.tenant_id=$1 ORDER BY s.public_id,w.id', [t])).rows;
      return rows.map(r => ({ id: r.id, public_id: publicNumber(r.public_id) }));
    },
    async products(publicIds) {
      return (await c.query('SELECT local_id,public_id::text AS public_id FROM base_wire220_product_ids WHERE tenant_id=$1 AND public_id=ANY($2::bigint[]) AND local_id IS NOT NULL',
        [t, publicIds])).rows.map(r => ({ id: r.local_id, public_id: publicNumber(r.public_id) }));
    },
    async find(entity, publicId) {
      const e = TABLES[entity];
      return (await c.query(`SELECT x.id FROM ${e.table} x WHERE x.tenant_id=$1 ${e.filter} AND ${derived('x.id')}=$2::bigint ORDER BY x.id`, [t, publicId])).rows.map(r => r.id);
    },
    async taken(entity, id, k) {
      const e = TABLES[entity];
      return !!(await c.query(`SELECT 1 FROM ${e.table} x WHERE x.tenant_id=$1 ${e.filter} AND x.id<>$2 AND ${key('x.id')}=$3 LIMIT 1`, [t, id, k])).rowCount;
    },
    async documents(f) {
      const rows = (await c.query(`SELECT d.id,d.kind,d.status,d.number,${epoch('d.created_at')} AS created,${epoch('d.posted_at')} AS posted,
          w.public_id::text AS warehouse_public_id,dw.public_id::text AS destination_public_id,d.destination_id,d.note,
          (SELECT count(*)::int FROM warehouse_document_lines l WHERE (l.tenant_id,l.document_id)=(d.tenant_id,d.id)) AS items,
          (SELECT coalesce(sum(l.quantity),0)::bigint::text FROM warehouse_document_lines l WHERE (l.tenant_id,l.document_id)=(d.tenant_id,d.id)) AS quantity,
          (SELECT min(r.order_id::text) FROM purchase_receipts r WHERE (r.tenant_id,r.document_id)=(d.tenant_id,d.id)) AS purchase_id,
          (SELECT sum(l.quantity::bigint*pl.unit_cost)::text FROM purchase_receipts r JOIN warehouse_document_lines l ON(l.tenant_id,l.document_id)=(r.tenant_id,r.document_id)
            JOIN purchase_order_lines pl ON(pl.tenant_id,pl.order_id,pl.product_id)=(r.tenant_id,r.order_id,l.product_id) WHERE (r.tenant_id,r.document_id)=(d.tenant_id,d.id)) AS cost
        FROM warehouse_documents d LEFT JOIN base_wire220_warehouse_ids w ON(w.tenant_id,w.local_id)=(d.tenant_id,d.warehouse_id)
        LEFT JOIN base_wire220_warehouse_ids dw ON(dw.tenant_id,dw.local_id)=(d.tenant_id,d.destination_id)
        WHERE d.tenant_id=$1 AND d.kind=ANY($2::text[]) AND d.status IN('draft','posted') AND ($3::text IS NULL OR d.status=$3)
          AND ($4::uuid[] IS NULL OR d.id=ANY($4)) AND ($5::uuid IS NULL OR d.warehouse_id=$5)
          AND ($6::bigint IS NULL OR d.created_at>=to_timestamp($6)) AND ($7::bigint IS NULL OR d.created_at<to_timestamp($7+1))
          AND ($8::uuid[] IS NULL OR EXISTS(SELECT 1 FROM purchase_receipts r WHERE (r.tenant_id,r.document_id)=(d.tenant_id,d.id) AND r.order_id=ANY($8)))
          AND (NOT $9::boolean OR EXISTS(SELECT 1 FROM purchase_receipts r WHERE (r.tenant_id,r.document_id)=(d.tenant_id,d.id)))
        ORDER BY d.created_at,d.id OFFSET $10 LIMIT $11`,
      [t, f.kinds, f.status ?? null, f.ids ?? null, f.warehouse_id ?? null, f.date_from ?? null, f.date_to ?? null, f.purchase_ids ?? null, f.sourced === true, f.offset, f.limit])).rows;
      return rows.map(r => ({ id: r.id, kind: r.kind, status: r.status, number: r.number, created: seconds(r.created), posted: seconds(r.posted),
        warehouse_public_id: publicNumber(r.warehouse_public_id), destination_public_id: r.destination_id === null ? null : publicNumber(r.destination_public_id),
        note: r.note, items: r.items, quantity: Number(r.quantity), purchase_id: r.purchase_id, cost: r.cost === null ? null : Number(r.cost) }));
    },
    async document(id) {
      const d = (await c.query("SELECT id,kind,status,version,warehouse_id,destination_id,reference,note FROM warehouse_documents WHERE tenant_id=$1 AND id=$2 AND kind IN('receipt','issue','transfer')", [t, id])).rows[0];
      ensure(d, 404, 'Nie znaleziono dokumentu magazynowego');
      const lines = (await c.query('SELECT product_id,quantity,location FROM warehouse_document_lines WHERE tenant_id=$1 AND document_id=$2 ORDER BY product_id', [t, id])).rows;
      return { id: d.id, kind: d.kind as BaseWireWmsKind, status: d.status, version: d.version, warehouse_id: d.warehouse_id, destination_id: d.destination_id,
        reference: d.reference, note: d.note, lines: lines.map(l => ({ product_id: l.product_id, quantity: l.quantity, location: l.location })) };
    },
    async documentLines(id) {
      // Native unit cost only on a PZ of a purchase receipt: the purchase order line of the product.
      return (await c.query(`SELECT l.product_id,l.name,l.sku,l.quantity,l.location,pl.unit_cost,${PRODUCT}
          JOIN warehouse_document_lines l ON(l.tenant_id,l.product_id)=(p.tenant_id,p.id)
          LEFT JOIN purchase_receipts r ON(r.tenant_id,r.document_id)=(l.tenant_id,l.document_id)
          LEFT JOIN purchase_order_lines pl ON(pl.tenant_id,pl.order_id,pl.product_id)=(r.tenant_id,r.order_id,l.product_id)
        WHERE l.tenant_id=$1 AND l.document_id=$2 ORDER BY l.sku,l.product_id`, [t, id])).rows.map(l => ({ ...line(l), location: l.location, unit_cost: l.unit_cost ?? null }));
    },
    async costReadable() {
      // Same key check and connection as the catalog export (catalog-export.ts): api_keys is not
      // readable by the tenant role, so the owner pool reads the current, own, unrevoked key.
      if (!actor.apiKeyId) return false;
      return (await pool.query("SELECT scopes @> ARRAY['purchasing:read']::text[] AS allowed FROM api_keys WHERE id=$1 AND tenant_id=$2 AND user_id=$3 AND revoked_at IS NULL AND expires_at>clock_timestamp()",
        [actor.apiKeyId, t, actor.userId])).rows[0]?.allowed === true;
    },
    async createDocument(input) {
      const d = await createWarehouseDocument(c, actor, emptyDocument.parse({ ...input, lines: [] }));
      return { id: d.id, number: d.number };
    },
    async editDocument(head, lines) {
      await editWarehouseDocument(c, actor, head.id, warehouseSchema.extend(versionSchema.shape).parse({ kind: head.kind, warehouse_id: head.warehouse_id,
        destination_id: head.destination_id, reference: head.reference, note: head.note, lines, version: head.version }));
    },
    async postDocument(id, version) { await postWarehouseDocument(c, actor, id, version); },
    async purchases(f) {
      const rows = (await c.query(`SELECT p.id,p.state,p.number,p.reference,p.note,p.currency,p.supplier_id,${epoch('p.created_at')} AS created,
          (SELECT ${epoch('min(e.created_at)')} FROM audit_events e WHERE (e.tenant_id,e.entity_id)=(p.tenant_id,p.id) AND e.action='purchase.place') AS sent,
          (SELECT ${epoch('max(r.created_at)')} FROM purchase_receipts r WHERE (r.tenant_id,r.order_id)=(p.tenant_id,p.id)) AS received,
          CASE WHEN p.state IN('received','closed') THEN ${epoch('p.updated_at')} ELSE '0' END AS completed,
          ${epoch("(p.expected_date::timestamp AT TIME ZONE 'UTC')")} AS expected,w.public_id::text AS warehouse_public_id,
          a.quantity,a.received_quantity,a.cost,a.received_cost,a.items,a.received_items
        FROM purchase_orders p LEFT JOIN base_wire220_warehouse_ids w ON(w.tenant_id,w.local_id)=(p.tenant_id,p.warehouse_id)
        CROSS JOIN LATERAL(SELECT coalesce(sum(l.quantity),0)::bigint::text AS quantity,coalesce(sum(l.received_quantity),0)::bigint::text AS received_quantity,
          coalesce(sum(l.quantity::bigint*l.unit_cost),0)::text AS cost,coalesce(sum(l.received_quantity::bigint*l.unit_cost),0)::text AS received_cost,
          count(*)::int AS items,(count(*) FILTER(WHERE l.received_quantity>0))::int AS received_items
          FROM purchase_order_lines l WHERE (l.tenant_id,l.order_id)=(p.tenant_id,p.id)) a
        WHERE p.tenant_id=$1 AND ($2::uuid IS NULL OR p.warehouse_id=$2) AND ($3::uuid[] IS NULL OR p.supplier_id=ANY($3))
          AND ($4::bigint IS NULL OR p.created_at>=to_timestamp($4)) AND ($5::bigint IS NULL OR p.created_at<to_timestamp($5+1))
          AND ($6::text IS NULL OR strpos(lower(p.number),lower($6))>0)
          AND ($7::uuid IS NULL OR EXISTS(SELECT 1 FROM purchase_order_lines l WHERE (l.tenant_id,l.order_id)=(p.tenant_id,p.id) AND l.product_id=$7))
        ORDER BY p.created_at,p.id OFFSET $8 LIMIT $9`,
      [t, f.warehouse_id ?? null, f.supplier_ids ?? null, f.date_from ?? null, f.date_to ?? null, f.number ?? null, f.product_id ?? null, f.offset, f.limit])).rows;
      return rows.map(r => {
        const money = [r.cost, r.received_cost].map(Number);
        ensure(money.every(Number.isSafeInteger), 422, 'Wartość zamówienia przekracza limit');
        return { id: r.id, state: r.state, number: r.number, reference: r.reference, note: r.note, currency: r.currency, created: seconds(r.created), sent: seconds(r.sent),
          received: seconds(r.received), completed: seconds(r.completed), expected: seconds(r.expected), warehouse_public_id: publicNumber(r.warehouse_public_id),
          supplier_id: r.supplier_id, quantity: Number(r.quantity), received_quantity: Number(r.received_quantity), cost: money[0], received_cost: money[1],
          items: r.items, received_items: r.received_items };
      });
    },
    purchase: purchaseHead,
    async savePurchase(input, id, version) {
      const p = await purchaseSave(c, actor, purchaseDraft.parse(input), id, version);
      return { id: p.id, number: p.number };
    },
    async actPurchase(id, action, input) {
      await purchaseAction(c, actor, id, action, (action === 'place' ? purchaseVersion : purchaseFinish).parse(input));
    },
    async receivePurchase(id, input) {
      // A fresh native receipt key: the Base replay protection is the absolute completed_quantity and the Idempotency-Key.
      await purchaseReceipt(c, actor, id, purchaseReceive.parse({ ...input, client_key: randomUUID() }));
    },
    async suppliers(f) {
      return (await c.query(`SELECT id,name,code,contact_name,email,phone,address,tax_id,country,active,version FROM suppliers
        WHERE tenant_id=$1 AND ($2::uuid[] IS NULL OR id=ANY($2)) AND ($3::text IS NULL OR strpos(lower(name),lower($3))>0) ORDER BY created_at,id LIMIT $4`,
      [t, f.ids ?? null, f.name ?? null, f.limit])).rows.map(r => ({ id: r.id, name: r.name, code: r.code, contact_name: r.contact_name, email: r.email, phone: r.phone,
        address: r.address, tax_id: r.tax_id, country: r.country, active: r.active, version: r.version }));
    },
    async saveSupplier(input, id, version) {
      return (await supplierSave(c, actor, supplierInput.parse(input), id, version)).id as string;
    },
    async stocktakes(f) {
      const rows = (await c.query(`SELECT x.id,x.name,x.state,x.blind,w.public_id::text AS warehouse_public_id,${epoch('x.created_at')} AS created,${epoch('x.posted_at')} AS posted,a.*
        FROM stocktakes x LEFT JOIN base_wire220_warehouse_ids w ON(w.tenant_id,w.local_id)=(x.tenant_id,x.warehouse_id)
        CROSS JOIN LATERAL(SELECT count(*)::int AS items,(count(*) FILTER(WHERE l.counted IS NOT NULL))::int AS counted_items,
          coalesce(sum(l.basis_quantity),0)::bigint::text AS quantity,coalesce(sum(l.counted),0)::bigint::text AS counted_quantity,
          (count(*) FILTER(WHERE l.counted=l.basis_quantity))::int AS compliant,(count(*) FILTER(WHERE l.counted<>l.basis_quantity))::int AS not_compliant,
          (count(*) FILTER(WHERE l.basis_quantity>0 AND l.counted=0))::int AS missing
          FROM stocktake_lines l WHERE (l.tenant_id,l.stocktake_id)=(x.tenant_id,x.id)) a
        WHERE x.tenant_id=$1 AND ($2::uuid[] IS NULL OR x.id=ANY($2)) AND ($3::uuid IS NULL OR x.warehouse_id=$3) AND ($4::text IS NULL OR x.state=$4)
          AND ($5::bigint IS NULL OR x.created_at>=to_timestamp($5)) AND ($6::bigint IS NULL OR x.created_at<to_timestamp($6+1))
        ORDER BY x.created_at,x.id OFFSET $7 LIMIT $8`,
      [t, f.ids ?? null, f.warehouse_id ?? null, f.state ?? null, f.date_from ?? null, f.date_to ?? null, f.offset, f.limit])).rows;
      return rows.map(r => ({ id: r.id, name: r.name, state: r.state, blind: r.blind, warehouse_public_id: publicNumber(r.warehouse_public_id), created: seconds(r.created),
        posted: seconds(r.posted), items: r.items, counted_items: r.counted_items, quantity: Number(r.quantity), counted_quantity: Number(r.counted_quantity),
        compliant: r.compliant, not_compliant: r.not_compliant, missing: r.missing }));
    },
    async stocktakeLines(id) {
      return (await c.query(`SELECT l.id,l.product_id,l.name,l.sku,l.basis_quantity AS quantity,l.location,l.counted,${PRODUCT}
          JOIN stocktake_lines l ON(l.tenant_id,l.product_id)=(p.tenant_id,p.id)
        WHERE l.tenant_id=$1 AND l.stocktake_id=$2 ORDER BY l.product_id,l.location`, [t, id])).rows.map(l => ({ ...line(l), id: l.id, location: l.location, counted: l.counted }));
    },
    async replay(clientKey, requestHash) {
      await c.query('INSERT INTO idempotency_keys(tenant_id,key,request_hash) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [t, idempotencyKey(clientKey), requestHash]);
      const prior = (await c.query('SELECT request_hash,response FROM idempotency_keys WHERE tenant_id=$1 AND key=$2 FOR UPDATE', [t, idempotencyKey(clientKey)])).rows[0];
      ensure(prior?.request_hash === requestHash, 409, 'Klucz polecenia wskazuje inną treść lub klucz API');
      return (prior.response ?? null) as Record<string, BaseWireJson> | null;
    },
    async remember(clientKey, response) {
      await c.query('UPDATE idempotency_keys SET response=$3 WHERE tenant_id=$1 AND key=$2', [t, idempotencyKey(clientKey), JSON.stringify(response)]);
    },
  };
}
export function createDefaultBaseWireWmsService() {
  return createBaseWireWmsService({
    transaction: (actor, writing, purchasing, work) => writing
      ? tenantTx(actor.tenantId, work, purchasing ? { purchasingAdmission: true } : {}) : tenantReadTx(actor.tenantId, work),
    native: (c, actor) => createBaseWireWmsNative(c, actor),
    supplierCode: () => 'BASE-' + randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase(),
  });
}
