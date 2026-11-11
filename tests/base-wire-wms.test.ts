/** Actual Base WMS family service on a CLOSED native port.
 * The real SQL/RLS/native warehouse, purchasing and stocktake code is covered by
 * base-wire-wms.database.test.ts.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createBaseWireWmsService, createBaseWireWmsFamily, BASE_WIRE_WMS_METHODS, baseWireWmsScope, isBaseWireWmsWrite, baseWireWmsId, baseWireWmsKey,
  BASE_WIRE_PURCHASE_CLOSE_REASON, BASE_WIRE_PURCHASE_CANCEL_REASON, type BaseWireWmsNative, type BaseWireWmsDocumentHead, type BaseWireWmsPurchaseHead,
  type BaseWireWmsSupplier } from '../server/base-wire-wms';
import { baseWireRequiredScopes } from '../server/developer-api';
import { Problem, ensure } from '../server/errors';
import type { Actor } from '../server/domain';
import type { BaseWireJson } from '../server/base-wire-codec';

const uid = (n: number) => `75000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const entityId = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
const actor = (t: number, role: Actor['role'] = 'admin'): Actor => ({ tenantId: uid(t), userId: uid(10 + t), role, apiKeyId: uid(20 + t), source: 'api' });
const product = (n: number) => ({ product_id: uid(100 + n), product_public_id: n, catalog_public_id: 3, name: 'P' + n, sku: 'S-' + n, ean: null, quantity: 0 });
function fixture(opts: { collide?: boolean } = {}) {
  const s = {
    docs: [] as (BaseWireWmsDocumentHead & { tenant: string })[], pos: [] as (BaseWireWmsPurchaseHead & { tenant: string })[],
    suppliers: [{ tenant: uid(1), id: entityId(900), name: 'Stary', code: 'S1', contact_name: 'Jan', email: '', phone: '1', address: 'A', tax_id: '', country: 'PL', active: true, version: 1 }] as (BaseWireWmsSupplier & { tenant: string })[],
    posted: [] as string[], receipts: [] as { id: string; lines: { product_id: string; quantity: number }[] }[], actions: [] as [string, string, string|undefined][],
    idempotency: [] as { tenant: string; key: string; hash: string; response: any }[], next: 1,
    // Native unit costs (minor units) of a PZ of a purchase receipt: document id → product id → purchase order line cost.
    costs: {} as Record<string, Record<string, number>>, costReadable: true, costChecks: 0,
  };
  let state = structuredClone(s);
  const native = (_c: unknown, a: Actor): BaseWireWmsNative => {
    const t = a.tenantId, docs = () => state.docs.filter(d => d.tenant === t), pos = () => state.pos.filter(p => p.tenant === t);
    const pool = (e: string) => e === 'document' ? docs() : e === 'purchase' ? pos() : e === 'supplier' ? state.suppliers.filter(x => x.tenant === t) : t === uid(1) ? [{ id: entityId(800) }] : [];
    return {
      warehouses: async () => t === uid(1) ? [{ id: uid(31), public_id: 11 }, { id: uid(32), public_id: 12 }] : [{ id: uid(33), public_id: 13 }],
      products: async ids => ids.filter(n => n < 50).map(n => ({ id: product(n).product_id, public_id: n })),
      find: async (e, n) => pool(e).filter(x => baseWireWmsId(x.id) === n).map(x => x.id),
      taken: async (e, id, k) => opts.collide === true || pool(e).some(x => x.id !== id && baseWireWmsKey(x.id) === k),
      documents: async f => docs().filter(d => !f.ids || f.ids.includes(d.id)).map(d => ({ id: d.id, kind: d.kind, status: d.status as any, number: 'N', created: 1, posted: 0,
        warehouse_public_id: 11, destination_public_id: null, note: d.note, items: d.lines.length, quantity: d.lines.reduce((n, l) => n + l.quantity, 0),
        purchase_id: state.costs[d.id] ? entityId(999) : null,
        cost: state.costs[d.id] ? d.lines.reduce((n, l) => n + l.quantity * state.costs[d.id][l.product_id], 0) : null })),
      document: async id => { const d = docs().find(x => x.id === id); ensure(d, 404, 'brak'); const { tenant: _t, ...rest } = structuredClone(d); return rest; },
      documentLines: async id => docs().find(x => x.id === id)!.lines.map(l => ({ ...product(Number(l.product_id.slice(-3)) - 100), quantity: l.quantity, location: l.location,
        unit_cost: state.costs[id]?.[l.product_id] ?? null })).sort((p, q) => p.sku.localeCompare(q.sku)),
      costReadable: async () => { state.costChecks++; return state.costReadable; },
      createDocument: async input => { const id = entityId(state.next++); state.docs.push({ tenant: t, id, status: 'draft', version: 1, lines: [], ...input }); return { id, number: 'PZ/' + id.slice(0, 8) }; },
      editDocument: async (head, lines) => { const d = docs().find(x => x.id === head.id)!; ensure(d.version === head.version, 409, 'wersja'); d.lines = structuredClone(lines); d.version++; },
      postDocument: async (id, version) => { const d = docs().find(x => x.id === id)!; ensure(d.version === version, 409, 'wersja'); state.posted.push(id); d.status = 'posted'; d.version++; },
      purchases: async () => [],
      purchase: async id => { const p = pos().find(x => x.id === id); ensure(p, 404, 'brak'); const { tenant: _t, ...rest } = structuredClone(p); return rest; },
      savePurchase: async (input, id, version) => {
        const lines = input.lines.map(l => { const n = Number(l.product_id.slice(-3)) - 100; return { ...product(n), quantity: l.quantity, received: 0, closed: 0, unit_cost: l.unit_cost, supplier_sku: l.supplier_sku, locations: [] }; });
        if (id) { const p = pos().find(x => x.id === id)!; ensure(p.version === version && p.state === 'draft', 409, 'wersja'); Object.assign(p, input, { lines, version: p.version + 1 }); return { id, number: 'ZZ' }; }
        const nid = entityId(state.next++); state.pos.push({ tenant: t, id: nid, state: 'draft', version: 1, ...input, lines }); return { id: nid, number: 'ZZ/' + nid.slice(0, 8) };
      },
      actPurchase: async (id, action, input) => {
        const p = pos().find(x => x.id === id)!; ensure(p.version === input.version, 409, 'wersja'); state.actions.push([id, action, input.reason]);
        if (action === 'place') { ensure(p.state === 'draft', 409, 'stan'); p.state = 'ordered'; }
        else if (action === 'close') { ensure(['ordered', 'partial'].includes(p.state), 409, 'stan'); p.state = 'closed'; for (const l of p.lines) l.closed = l.quantity - l.received; }
        else { ensure(['draft', 'ordered'].includes(p.state), 409, 'stan'); p.state = 'cancelled'; }
        p.version++;
      },
      receivePurchase: async (id, input) => {
        const p = pos().find(x => x.id === id)!; ensure(p.version === input.version && ['ordered', 'partial'].includes(p.state), 409, 'stan');
        for (const r of input.lines) { const l = p.lines.find(x => x.product_id === r.product_id)!; ensure(r.quantity <= l.quantity - l.received - l.closed, 422, 'za dużo'); l.received += r.quantity; }
        state.receipts.push({ id, lines: structuredClone(input.lines) });
        p.state = p.lines.some(l => l.received < l.quantity) ? 'partial' : 'received'; p.version++;
      },
      suppliers: async f => state.suppliers.filter(x => x.tenant === t && (!f.ids || f.ids.includes(x.id))).map(({ tenant: _t, ...x }) => structuredClone(x)),
      saveSupplier: async (input, id, version) => {
        if (id) { const x = state.suppliers.find(y => y.id === id)!; ensure(x.version === version, 409, 'wersja'); Object.assign(x, input, { version: x.version + 1 }); return id; }
        const nid = entityId(state.next++); state.suppliers.push({ tenant: t, id: nid, version: 1, ...input }); return nid;
      },
      stocktakes: async () => [{ id: entityId(800), name: 'Spis', state: 'counting', warehouse_public_id: 11, blind: true, created: 1, posted: 0, items: 1, counted_items: 0,
        quantity: 7, counted_quantity: 0, compliant: 0, not_compliant: 0, missing: 0 }],
      stocktakeLines: async () => [{ ...product(1), id: entityId(801), quantity: 7, location: 'A-01', counted: null }],
      replay: async (k, hash) => { let row = state.idempotency.find(x => x.tenant === t && x.key === k); if (!row) state.idempotency.push(row = { tenant: t, key: k, hash, response: null });
        ensure(row.hash === hash, 409, 'inna treść'); return structuredClone(row.response); },
      remember: async (k, response) => { state.idempotency.find(x => x.tenant === t && x.key === k)!.response = structuredClone(response); },
    };
  };
  const service = createBaseWireWmsService({ native: native as any, supplierCode: () => 'BASE-TEST', transaction: async (_a, _w, _p, work) => {
    const before = structuredClone(state);
    try { return await work({} as any); } catch (e) { state = before; throw e; }
  } });
  return { service, get state() { return state; } };
}
const status = async (p: Promise<unknown>, code: number) => assert.rejects(p, (e: any) => (e instanceof Problem ? e.status : e?.name === 'ZodError' ? 422 : 0) === code);

test('method roster, scopes and family wiring', () => {
  assert.equal(BASE_WIRE_WMS_METHODS.length, 14);
  assert.deepEqual(BASE_WIRE_WMS_METHODS.filter(isBaseWireWmsWrite), ['addInventoryDocument', 'addInventoryDocumentItems', 'setInventoryDocumentStatusConfirmed',
    'addInventoryPurchaseOrder', 'addInventoryPurchaseOrderItems', 'setInventoryPurchaseOrderStatus', 'addInventorySupplier']);
  assert.equal(baseWireWmsScope('getInventoryDocuments'), 'inventory:read');
  assert.equal(baseWireWmsScope('setInventoryDocumentStatusConfirmed'), 'inventory:write');
  assert.equal(baseWireWmsScope('getInventorySuppliers'), 'purchasing:read');
  assert.equal(baseWireWmsScope('setInventoryPurchaseOrderStatus'), 'purchasing:write');
  assert.equal(baseWireWmsScope('getInventoryStocktakeItems'), 'inventory:read');
  assert.deepEqual(baseWireRequiredScopes('purchasing:write'), ['purchasing:read', 'purchasing:write']);
  assert.deepEqual(baseWireRequiredScopes('inventory:write'), ['inventory:read', 'inventory:write']);
  assert.throws(() => isBaseWireWmsWrite('getInventoryDocumentSeries'), (e: any) => e.status === 400);
  const f = createBaseWireWmsFamily({ service: { execute: async () => ({}) }, available: 1 as any });
  assert.equal(f.available, false); assert.equal(f.label, 'WMS');
  // Derived IDs: 52 random bits of the v4 UUID + 1.
  assert.equal(baseWireWmsId('00000000-0000-4000-8000-000000000000'), 1);
  assert.equal(baseWireWmsId('ffffffff-ffff-4fff-bfff-ffffffffffff'), 2 ** 52);
});

test('documents: Base draft, items, confirm exactly once; unsupported types and fields refused', async () => {
  const x = fixture(), A = actor(1);
  await status(x.service.execute(A, 'addInventoryDocument', { warehouse_id: 11, document_type: 1 }), 422);
  await status(x.service.execute(A, 'addInventoryDocument', { warehouse_id: 11, document_type: 4 }), 422);
  await status(x.service.execute(A, 'addInventoryDocument', { warehouse_id: 11, document_type: 0, target_warehouse_id: 12 }), 422);
  await status(x.service.execute(A, 'addInventoryDocument', { warehouse_id: 11, document_type: 0, date_add: 1760000000 }), 422);
  await status(x.service.execute(A, 'addInventoryDocument', { warehouse_id: 11, document_type: 0, unknown: 1 }), 422);
  await status(x.service.execute(A, 'addInventoryDocument', { warehouse_id: 13, document_type: 0 }), 404);
  await status(x.service.execute(actor(1, 'operator'), 'addInventoryDocument', { warehouse_id: 11, document_type: 0 }), 403);
  const mm = await x.service.execute(A, 'addInventoryDocument', { warehouse_id: 11, document_type: 4, target_warehouse_id: '12' });
  assert.equal(x.state.docs[0].kind, 'transfer'); assert.equal(x.state.docs[0].destination_id, uid(32));
  // MM: the native line location is the destination; a source location is refused.
  await status(x.service.execute(A, 'addInventoryDocumentItems', { document_id: mm.document_id, items: [{ product_id: 1, quantity: 1, location_name: 'A' }] }), 422);
  await x.service.execute(A, 'addInventoryDocumentItems', { document_id: mm.document_id, items: [{ product_id: 1, quantity: 2, target_location_name: 'B-9' }] });
  assert.deepEqual(x.state.docs[0].lines, [{ product_id: uid(101), quantity: 2, location: 'B-9' }]);

  const key = uid(70);
  const pz = await x.service.execute(A, 'addInventoryDocument', { warehouse_id: 11, document_type: 0, invoice_no: 'FV1', notes: 'N' }, { clientKey: key });
  assert.deepEqual(await x.service.execute(A, 'addInventoryDocument', { warehouse_id: 11, document_type: 0, invoice_no: 'FV1', notes: 'N' }, { clientKey: key }), pz);
  await status(x.service.execute(A, 'addInventoryDocument', { warehouse_id: 11, document_type: 2 }, { clientKey: key }), 409);
  assert.equal(x.state.docs.length, 2);
  assert.deepEqual({ ref: x.state.docs[1].reference, note: x.state.docs[1].note }, { ref: 'FV1', note: 'N' });
  await status(x.service.execute(A, 'setInventoryDocumentStatusConfirmed', { document_id: pz.document_id }), 422);
  for (const field of ['price', 'batch', 'serial_no', 'expiry_date', 'comments'])
    await status(x.service.execute(A, 'addInventoryDocumentItems', { document_id: pz.document_id, items: [{ product_id: 1, quantity: 1, [field]: field === 'price' ? 2 : 'x' }] }), 422);
  await status(x.service.execute(A, 'addInventoryDocumentItems', { document_id: pz.document_id, items: [{ product_id: 99, quantity: 1 }] }), 404);
  await status(x.service.execute(A, 'addInventoryDocumentItems', { document_id: pz.document_id, items: [{ product_id: 1, quantity: 1 }, { product_id: 1, quantity: 2 }] }), 422);
  const items = await x.service.execute(A, 'addInventoryDocumentItems', { document_id: pz.document_id, items: [{ product_id: 2, quantity: 3, location_name: 'C-1' }, { product_id: 1, quantity: 1 }] });
  assert.deepEqual(items.items, [{ item_id: 2, position: 2 }, { item_id: 1, position: 1 }]);
  assert.deepEqual(x.state.docs[1].lines.map(l => l.location), ['C-1', 'A-01']);
  await status(x.service.execute(A, 'addInventoryDocumentItems', { document_id: pz.document_id, items: [{ product_id: 1, quantity: 1 }] }), 409);
  await status(x.service.execute(actor(2), 'setInventoryDocumentStatusConfirmed', { document_id: pz.document_id }), 404);
  await x.service.execute(A, 'setInventoryDocumentStatusConfirmed', { document_id: pz.document_id });
  await x.service.execute(A, 'setInventoryDocumentStatusConfirmed', { document_id: pz.document_id });
  assert.deepEqual(x.state.posted, [x.state.docs[1].id], 'posted exactly once');
  const listed = (await x.service.execute(A, 'getInventoryDocuments', { filter_document_id: pz.document_id })).documents as any[];
  assert.deepEqual([listed[0].document_type, listed[0].document_status, listed[0].direction, listed[0].source_object_type], [0, 1, 0, 0]);
  assert.deepEqual((await x.service.execute(A, 'getInventoryDocuments', { filter_document_type: 5 })).documents, []);
  assert.deepEqual((await x.service.execute(A, 'getInventoryDocuments', { filter_source_object_type: 1 })).documents, []);
  // An identity collision fails the create and leaves nothing behind.
  const y = fixture({ collide: true });
  await status(y.service.execute(A, 'addInventoryDocument', { warehouse_id: 11, document_type: 0 }), 503);
  assert.equal(y.state.docs.length, 0);
});

test('documents: a PZ of a purchase receipt carries the native purchase cost; manual PZ, MM and keys without purchasing:read get 0', async () => {
  const x = fixture(), A = actor(1);
  const manual = await x.service.execute(A, 'addInventoryDocument', { warehouse_id: 11, document_type: 0 });
  await x.service.execute(A, 'addInventoryDocumentItems', { document_id: manual.document_id, items: [{ product_id: 1, quantity: 2 }] });
  const received = await x.service.execute(A, 'addInventoryDocument', { warehouse_id: 11, document_type: 0 });
  await x.service.execute(A, 'addInventoryDocumentItems', { document_id: received.document_id, items: [{ product_id: 1, quantity: 4 }, { product_id: 2, quantity: 3 }] });
  // Like purchaseReceipt: the PZ lines are the received purchase order lines (unit_cost 12.50 and 3.33).
  x.state.costs[x.state.docs[1].id] = { [uid(101)]: 1250, [uid(102)]: 333 };
  const docs = async () => Object.fromEntries(((await x.service.execute(A, 'getInventoryDocuments', {})).documents as any[]).map(d => [d.document_id, d.total_price]));
  const items = async (id: BaseWireJson) => ((await x.service.execute(A, 'getInventoryDocumentItems', { document_id: id })).items as any[]).map(i => [i.product_id, i.price, i.total_price]);
  assert.deepEqual(await docs(), { [manual.document_id as number]: 0, [received.document_id as number]: 59.99 });
  assert.deepEqual(await items(received.document_id), [[1, 12.5, 50], [2, 3.33, 9.99]]);
  // Natively absent cost: 0, and the key scope is not even read.
  const checks = x.state.costChecks;
  assert.deepEqual(await items(manual.document_id), [[1, 0, 0]]);
  assert.equal(x.state.costChecks, checks);
  // Purchase costs are purchasing:read data (native PO routes): without it the PZ value stays 0.
  x.state.costReadable = false;
  assert.deepEqual(await docs(), { [manual.document_id as number]: 0, [received.document_id as number]: 0 });
  assert.deepEqual(await items(received.document_id), [[1, 0, 0], [2, 0, 0]]);
});
test('purchase orders: create, items, place, absolute receipts, completion closes the remainder, cancel', async () => {
  const x = fixture(), A = actor(1), supplier = baseWireWmsId(entityId(900));
  for (const extra of <Record<string, BaseWireJson>[]>[{ payer_id: 4 }, { invoice_no: 'F' }, { date_cost_invoice_issue: 1 }, { additional_costs: [{ name: 'T', cost: 1 }] }, { packages: [{ courier_code: 'dpd', package_number: '1' }] }])
    await status(x.service.execute(A, 'addInventoryPurchaseOrder', { warehouse_id: 11, supplier_id: supplier, currency: 'PLN', ...extra }), 422);
  await status(x.service.execute(A, 'addInventoryPurchaseOrder', { warehouse_id: 11, supplier_id: 5, currency: 'PLN' }), 404);
  await status(x.service.execute(actor(2), 'addInventoryPurchaseOrder', { warehouse_id: 13, supplier_id: supplier, currency: 'PLN' }), 404);
  const po = await x.service.execute(A, 'addInventoryPurchaseOrder', { warehouse_id: 11, supplier_id: supplier, payer_id: 0, currency: 'PLN', name: 'R', notes: 'N', date_delivery_expected: 1767225600 });
  assert.deepEqual({ ref: x.state.pos[0].reference, date: x.state.pos[0].expected_date, lines: x.state.pos[0].lines.length }, { ref: 'R', date: '2026-01-01', lines: 0 });
  await status(x.service.execute(A, 'setInventoryPurchaseOrderStatus', { order_id: po.order_id, status: 1 }), 422);
  await x.service.execute(A, 'addInventoryPurchaseOrderItems', { order_id: po.order_id, items: [{ product_id: 1, quantity: 4, item_cost: '12.50', supplier_code: 'K' }, { product_id: 2, quantity: 1 }] });
  await x.service.execute(A, 'addInventoryPurchaseOrderItems', { order_id: po.order_id, items: [{ product_id: 1, quantity: 2, item_cost: 12.5, supplier_code: 'K' }] });
  assert.deepEqual(x.state.pos[0].lines.map(l => [l.product_public_id, l.quantity, l.unit_cost, l.supplier_sku]), [[1, 6, 1250, 'K'], [2, 1, 0, '']]);
  await status(x.service.execute(A, 'addInventoryPurchaseOrderItems', { order_id: po.order_id, items: [{ product_id: 1, quantity: 1, item_cost: 1 }] }), 409);
  await status(x.service.execute(A, 'addInventoryPurchaseOrderItems', { order_id: po.order_id, items: [{ product_id: 1, quantity: 1, item_cost: 12.505 }] }), 422);
  await status(x.service.execute(A, 'addInventoryPurchaseOrderItems', { order_id: po.order_id, items: [{ product_id: 1, quantity: 1, location: 'A' }] }), 422);
  await status(x.service.execute(A, 'setInventoryPurchaseOrderStatus', { order_id: po.order_id, status: 2 }), 422);
  await status(x.service.execute(A, 'setInventoryPurchaseOrderStatus', { order_id: po.order_id, status: 6 }), 422);
  await status(x.service.execute(A, 'setInventoryPurchaseOrderStatus', { order_id: po.order_id, status: 1, completed_items: [{ item_id: 1, completed_quantity: 1 }] }), 422);
  await x.service.execute(A, 'setInventoryPurchaseOrderStatus', { order_id: po.order_id, status: 1 });
  await x.service.execute(A, 'setInventoryPurchaseOrderStatus', { order_id: po.order_id, status: 1 });
  assert.deepEqual(x.state.actions.map(a => a[1]), ['place'], 'replayed place is a no-op');
  await status(x.service.execute(A, 'setInventoryPurchaseOrderStatus', { order_id: po.order_id, status: 0 }), 409);
  await status(x.service.execute(A, 'addInventoryPurchaseOrderItems', { order_id: po.order_id, items: [{ product_id: 3, quantity: 1 }] }), 409);
  const partial = { order_id: po.order_id, status: 4, completed_items: [{ item_id: 1, completed_quantity: 2 }] };
  await x.service.execute(A, 'setInventoryPurchaseOrderStatus', partial);
  await x.service.execute(A, 'setInventoryPurchaseOrderStatus', partial);
  assert.deepEqual(x.state.receipts.map(r => r.lines), [[{ product_id: uid(101), quantity: 2 }]], 'absolute quantity: received once');
  await status(x.service.execute(A, 'setInventoryPurchaseOrderStatus', { ...partial, completed_items: [{ item_id: 1, completed_quantity: 1 }] }), 409);
  await status(x.service.execute(A, 'setInventoryPurchaseOrderStatus', { ...partial, completed_items: [{ item_id: 7, completed_quantity: 1 }] }), 404);
  await status(x.service.execute(A, 'setInventoryPurchaseOrderStatus', { order_id: po.order_id, status: 4, completed_items: [{ item_id: 1, completed_quantity: 6 }, { item_id: 2, completed_quantity: 1 }] }), 409);
  assert.equal(x.state.receipts.length, 1, 'a refused status 4 receives nothing');
  await x.service.execute(A, 'setInventoryPurchaseOrderStatus', { order_id: po.order_id, status: 3, completed_items: [{ item_id: 1, completed_quantity: 5 }] });
  assert.deepEqual(x.state.receipts.at(-1)!.lines, [{ product_id: uid(101), quantity: 3 }]);
  assert.deepEqual(x.state.actions.at(-1), [x.state.pos[0].id, 'close', BASE_WIRE_PURCHASE_CLOSE_REASON]);
  assert.equal(x.state.pos[0].state, 'closed');
  await x.service.execute(A, 'setInventoryPurchaseOrderStatus', { order_id: po.order_id, status: 3 });
  assert.equal(x.state.actions.length, 2, 'completed again is a no-op');
  await status(x.service.execute(A, 'setInventoryPurchaseOrderStatus', { order_id: po.order_id, status: 5 }), 409);
  const second = await x.service.execute(A, 'addInventoryPurchaseOrder', { warehouse_id: 11, supplier_id: supplier, currency: 'EUR' });
  await x.service.execute(A, 'setInventoryPurchaseOrderStatus', { order_id: second.order_id, status: 5 });
  assert.deepEqual(x.state.actions.at(-1), [x.state.pos[1].id, 'cancel', BASE_WIRE_PURCHASE_CANCEL_REASON]);
  const items = (await x.service.execute(A, 'getInventoryPurchaseOrderItems', { order_id: po.order_id })).items as any[];
  assert.deepEqual(items.map(i => [i.item_id, i.position, i.quantity, i.completed_quantity, i.item_cost]), [[1, 1, 6, 5, 12.5], [2, 2, 1, 0, 0]]);
  assert.deepEqual((await x.service.execute(A, 'getInventoryPurchaseOrders', { series_id: 3 })).purchase_orders, []);
});

test('suppliers: create with a local code, update keeps omitted fields, unmapped fields refused', async () => {
  const x = fixture(), A = actor(1);
  for (const extra of <Record<string, BaseWireJson>[]>[{ city: 'Łódź' }, { postcode: '00-001' }, { currency: 'EUR' }, { email_copy_to: 'a@b.pl' }, { take_product_cost_from: 'cost' }])
    await status(x.service.execute(A, 'addInventorySupplier', { name: 'Nowy', ...extra }), 422);
  await status(x.service.execute(A, 'addInventorySupplier', { phone: '1' }), 422);
  const created = await x.service.execute(A, 'addInventorySupplier', { name: 'Nowy', email: 'n@example.com', tax_no: '123' });
  const row = x.state.suppliers.find(s => baseWireWmsId(s.id) === created.supplier_id)!;
  assert.deepEqual([row.code, row.email, row.tax_id, row.country, row.active], ['BASE-TEST', 'n@example.com', '123', 'PL', true]);
  const old = baseWireWmsId(entityId(900));
  assert.deepEqual(await x.service.execute(A, 'addInventorySupplier', { supplier_id: old, phone: '2' }), { supplier_id: old });
  assert.deepEqual(x.state.suppliers[0], { tenant: uid(1), id: entityId(900), name: 'Stary', code: 'S1', contact_name: 'Jan', email: '', phone: '2', address: 'A', tax_id: '', country: 'PL', active: true, version: 2 });
  await status(x.service.execute(actor(2), 'addInventorySupplier', { supplier_id: old, phone: '3' }), 404);
  const listed = (await x.service.execute(actor(1, 'viewer'), 'getInventorySuppliers', { filter_id: old })).suppliers;
  assert.deepEqual(listed, [{ supplier_id: old, name: 'Stary', address: 'A', postcode: '', city: '', phone: '2', email: '', email_copy_to: '', currency: '', tax_no: '' }]);
  assert.deepEqual((await x.service.execute(actor(2), 'getInventorySuppliers', { filter_id: old })).suppliers, []);
});

test('stocktakes: native states, blind counts hide expected quantities from non-admins', async () => {
  const x = fixture(), id = baseWireWmsId(entityId(800));
  assert.deepEqual((await x.service.execute(actor(1), 'getInventoryStocktakes', { filter_stocktake_status: 0 })).stocktakes, []);
  assert.deepEqual((await x.service.execute(actor(1), 'getInventoryStocktakes', { filter_stocktake_number: 'INW' })).stocktakes, []);
  const admin = (await x.service.execute(actor(1), 'getInventoryStocktakes', {})).stocktakes as any[];
  assert.deepEqual([admin[0].stocktake_id, admin[0].stocktake_status, admin[0].total_quantity], [id, 2, 7]);
  const viewer = (await x.service.execute(actor(1, 'viewer'), 'getInventoryStocktakes', {})).stocktakes as any[];
  assert.equal(viewer[0].total_quantity, 0);
  const items = (await x.service.execute(actor(1), 'getInventoryStocktakeItems', { stocktake_id: id })).items as any[];
  assert.deepEqual(items.map(i => [i.item_id, i.stocktake_id, i.product_id, i.quantity, i.verified_quantity, i.is_verified, i.location_name]),
    [[baseWireWmsId(entityId(801)), id, 1, 7, 0, false, 'A-01']]);
  assert.equal(((await x.service.execute(actor(1, 'operator'), 'getInventoryStocktakeItems', { stocktake_id: id })).items as any[])[0].quantity, 0);
  await status(x.service.execute(actor(2), 'getInventoryStocktakeItems', { stocktake_id: id }), 404);
});
