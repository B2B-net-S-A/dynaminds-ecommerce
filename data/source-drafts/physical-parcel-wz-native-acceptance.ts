/** AUTHORED / NOT_RUN. Import-safe acceptance of the complete real physical-WZ
 * business flow. Uses an existing genuine fixture and injected full DB capture;
 * no seed, migration, owner writes, generated credentials or provider receipts. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, InjectOptions } from 'fastify';
import type { createPhysicalWzNativeFixture } from './physical-parcel-wz-native-fixture';
type Fixture = Awaited<ReturnType<typeof createPhysicalWzNativeFixture>>;
type Snapshot = { graph: { rows: Record<string, Array<{ row: any }>> } };
export async function acceptPhysicalParcelWz(args: {
  app: FastifyInstance; fixture: Fixture; capture: () => Promise<Snapshot>;
  save: (name: string, value: unknown) => Promise<{ path: string; sha256: string }>;
}) {
  const { app, fixture: f, capture, save } = args;
  const receipts: Array<{ path: string; status: number }> = [];
  const headers = { cookie: f.credentials.cookie };
  async function req(path: string, method: InjectOptions['method'] = 'GET', payload?: InjectOptions['payload']) {
    const r = await app.inject({ url: '/api' + path, method, payload, headers, remoteAddress: '127.168.2.1' });
    receipts.push({ path, status: r.statusCode }); return r;
  }
  async function ok(path: string, method: InjectOptions['method'] = 'GET', body?: InjectOptions['payload'], status = 200): Promise<any> {
    const r = await req(path, method, body); assert.equal(r.statusCode, status, 'Actual physical WZ endpoint ' + method + ' ' + path); return r.json();
  }
  async function zero<T>(label: string, fn: () => Promise<T>): Promise<T> {
    const before = await capture(), result = await fn(); assert.deepEqual(await capture(), before, 'Entire database zero across ' + label); return result;
  }
  const root = '/order-parcels', sourcePath = root + '/plans/' + f.plan.id + '/physical-wz/source';
  const sourceResponse = await zero('normal physical source', () => ok(sourcePath)), source = sourceResponse.source;
  assert.equal(sourceResponse.available, true); assert.equal(sourceResponse.read_only, false); assert.equal(sourceResponse.current_role, 'admin'); assert.equal(sourceResponse.can_write, true);
  assert.equal(source.protocol, 'physical_v1'); assert.equal(source.tenant_id, f.tenant); assert.equal(source.order_id, f.order.id); assert.equal(source.plan_id, f.plan.id); assert.equal(source.plan_scope_hash, f.plan.scope_hash);
  assert.match(source.revision, /^[a-f0-9]{64}$/); assert.equal(source.approved_mapping_id, null); assert.equal(source.items.length, 2);
  const kit = source.items.find((i: any) => i.item_id === f.kit_item.id), simple = source.items.find((i: any) => i.item_id === f.simple_item.id);
  assert(kit && simple); assert.equal(kit.product_id, f.kit.id); assert.equal(kit.quantity, 1); assert.equal(kit.line_total, 1001); assert.equal(kit.vat, 23); assert.equal(kit.currency, 'PLN');
  assert.equal(simple.product_id, f.products[0].id); assert.equal(simple.quantity, 1); assert.equal(simple.line_total, 501); assert.equal(simple.vat, 23); assert.equal(simple.currency, 'PLN');
  assert.deepEqual(new Map(kit.components.map((c: any) => [c.product_id, c.quantity])), new Map([[f.products[0].id, 2], [f.products[1].id, 1]])); assert.deepEqual(simple.components, [{ product_id: f.products[0].id, quantity: 1 }]);
  assert.equal(source.progress.length, 2); assert(source.progress.every((p: any) => p.state === 'pending' && p.dispatch_id === null && p.issued_products.length === 0));
  await zero('v1 physical source', async () => { assert.equal(app.hasRoute({ method: 'GET', url: '/api/v1/order-parcels/plans/:id/physical-wz/source' }), true); assert.deepEqual((await ok('/v1' + sourcePath)).source, source); });
  const previewRequest = { client_key: randomUUID(), revision: source.revision, parcels: f.allocation };
  const bad = structuredClone(previewRequest); bad.client_key = randomUUID(); bad.parcels[0].components[0].item_id = f.simple_item.id;
  await zero('wrong shared-product historical provenance', async () => { assert.equal((await req(root + '/plans/' + f.plan.id + '/physical-wz/previews', 'POST', bad)).statusCode, 409); });
  const stale = { ...previewRequest, client_key: randomUUID(), revision: '0'.repeat(64) };
  await zero('stale full source CAS', async () => { assert.equal((await req(root + '/plans/' + f.plan.id + '/physical-wz/previews', 'POST', stale)).statusCode, 409); });
  const created = await ok(root + '/plans/' + f.plan.id + '/physical-wz/previews', 'POST', previewRequest, 201), preview = created.preview;
  assert.equal(created.reused, false); assert.equal(preview.plan_id, f.plan.id); assert.equal(preview.order_id, f.order.id); assert.equal(preview.client_key, previewRequest.client_key); assert.equal(preview.revision, source.revision); assert.match(preview.scope_hash, /^[a-f0-9]{64}$/);
  assert.match(preview.created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/); assert.match(preview.expires_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/); assert.equal(preview.can_apply, true);
  const canonicalComponents = (rows: any[]) => rows.map(r => ({ item_id: r.item_id, product_id: r.product_id, quantity: r.quantity })).sort((a, b) => (a.item_id + ':' + a.product_id).localeCompare(b.item_id + ':' + b.product_id));
  for (const p of f.allocation) {
    const native = preview.allocation.find((x: any) => x.parcel_index === p.parcel_index); assert(native); assert.equal(native.shipment_id, p.shipment_id); assert.deepEqual(canonicalComponents(native.components), canonicalComponents(p.components));
    const projected = preview.projected_parcels.find((x: any) => x.parcel_index === p.parcel_index); assert(projected); assert.equal(projected.shipment_id, p.shipment_id);
    const actual = projected.commercial_lines.flatMap((l: any) => {
      assert.equal(l.lineage_kind, 'physical_item_components_v1'); assert.equal('quantity' in l, false); assert.equal(l.original_quantity, 1);
      const original = source.items.find((i: any) => i.item_id === l.item_id); assert(original); for (const key of ['product_id', 'name', 'sku', 'line_total', 'vat', 'currency', 'components']) assert.deepEqual(l[key], original[key]);
      return l.component_quantities.map((c: any) => ({ item_id: l.item_id, product_id: c.product_id, quantity: c.quantity }));
    }); assert.deepEqual(canonicalComponents(actual), canonicalComponents(p.components));
  }
  await zero('preview immutable replay with fresh consent availability withheld', async () => { const r = await ok(root + '/plans/' + f.plan.id + '/physical-wz/previews', 'POST', previewRequest); assert.equal(r.reused, true); assert.equal(r.preview.can_apply, false); assert.deepEqual(r.preview, { ...preview, can_apply: false }); });
  await zero('preview readonly detail', async () => { assert.deepEqual((await ok(root + '/physical-wz/previews/' + preview.id)).preview, preview); });
  const applyRequest = { client_key: randomUUID(), scope_hash: preview.scope_hash, confirmed: true };
  const applied = await ok(root + '/physical-wz/previews/' + preview.id + '/apply', 'POST', applyRequest, 201), mapping = applied.mapping;
  assert.equal(applied.reused, false); assert.equal(mapping.classification_origin, 'operator_confirmed'); assert.equal(mapping.preview_id, preview.id); assert.equal(mapping.plan_id, f.plan.id); assert.equal(mapping.scope_hash, preview.scope_hash); assert.match(mapping.projection_hash, /^[a-f0-9]{64}$/);
  assert.deepEqual(mapping.allocation, preview.allocation); assert.deepEqual(mapping.projected_parcels, preview.projected_parcels);
  await zero('mapping exact replay', async () => { const r = await ok(root + '/physical-wz/previews/' + preview.id + '/apply', 'POST', applyRequest); assert.equal(r.reused, true); assert.deepEqual(r.mapping, mapping); });
  const beforeDispatch = await capture(), dispatches: any[] = [], dispatchRequests: any[] = [], documents: any[] = [];
  for (const index of [0, 1]) {
    const request = { client_key: randomUUID(), scope_hash: f.plan.scope_hash, confirmed: true }; dispatchRequests.push(request);
    const response = await ok(root + '/plans/' + f.plan.id + '/parcels/' + index + '/dispatch', 'POST', request);
    assert.equal(response.reused, false); assert.equal(response.dispatch.parcel_index, index); assert.equal(response.dispatch.shipment_id, f.plan.parcels[index].shipment_id); dispatches.push(response.dispatch);
    await zero('native dispatch replay after parcel ' + index, async () => { const replay = await ok(root + '/plans/' + f.plan.id + '/parcels/' + index + '/dispatch', 'POST', request); assert.equal(replay.reused, true); assert.deepEqual(replay.dispatch, response.dispatch); });
    await zero('mapping replay after consumed reservation ' + index, async () => { const r = await ok(root + '/physical-wz/previews/' + preview.id + '/apply', 'POST', applyRequest); assert.equal(r.reused, true); assert.deepEqual(r.mapping, mapping); });
    const stored = (await capture()).graph.rows.warehouse_wz_issuer_documents.filter(r => r.row.tenant_id === f.tenant && r.row.payload.source.plan_id === f.plan.id && r.row.payload.source.parcel_index === index);
    assert.equal(stored.length, 1); const head = stored[0].row.payload; assert.equal(head.source.dispatch_id, response.dispatch.id); assert.equal(head.kind, 'WZ'); assert.equal(head.summary.physical_quantity, 2); assert.equal(String(head.sequence), String(index + 1));
    assert.deepEqual(head.commercial_lines.map(({ allocations: _allocations, ...line }: any) => line), mapping.projected_parcels.find((p: any) => p.parcel_index === index).commercial_lines);
    const detail = await zero('issued WZ detail ' + index, () => ok('/warehouse-wz-issued/documents/' + head.id));
    assert.equal(detail.document.id, head.id); assert.deepEqual(detail.document.commercial_lines, head.commercial_lines); assert.equal(detail.rows.reduce((n: number, r: any) => n + r.quantity, 0), 2);
    assert.deepEqual(new Set(detail.rows.map((r: any) => r.stock_movement_id)), new Set(response.dispatch.receipt.stock_movements.map((r: any) => r.id)));
    assert.deepEqual(new Set(detail.rows.map((r: any) => r.location_movement_id)), new Set(response.dispatch.receipt.location_movements.map((r: any) => r.id)));
    const covered = new Map<string, number>();
    for (const line of head.commercial_lines) {
      assert(Array.isArray(line.allocations) && line.allocations.length > 0);
      const components = new Map<string, number>(), physicalIds = new Set<string>();
      for (const allocation of line.allocations) {
        assert.deepEqual(Object.keys(allocation).sort(), ['physical_id', 'product_id', 'quantity', 'warehouse_id']);
        assert(Number.isSafeInteger(allocation.quantity) && allocation.quantity > 0); assert(!physicalIds.has(allocation.physical_id)); physicalIds.add(allocation.physical_id);
        const physical = detail.rows.find((r: any) => r.physical_id === allocation.physical_id); assert(physical);
        assert.equal(physical.location_movement_id, allocation.physical_id, 'Genuine WMS-OFF physical fragment is the bin movement'); assert.equal(physical.product_id, allocation.product_id); assert.equal(allocation.warehouse_id, head.warehouse.id); assert(allocation.quantity <= physical.quantity);
        components.set(allocation.product_id, (components.get(allocation.product_id) ?? 0) + allocation.quantity); covered.set(allocation.physical_id, (covered.get(allocation.physical_id) ?? 0) + allocation.quantity);
      }
      assert.deepEqual(components, new Map(line.component_quantities.map((c: any) => [c.product_id, c.quantity])));
    }
    assert.equal(covered.size, detail.rows.length); for (const r of detail.rows) assert.equal(covered.get(r.physical_id), r.quantity, 'Full bijective coverage of real physical rows');
    for (const format of ['csv', 'xml']) await zero('issued WZ export ' + index + ' ' + format, async () => {
      const r = await req('/warehouse-wz-issued/documents/' + head.id + '/export?format=' + format); assert.equal(r.statusCode, 200); assert.equal(r.headers['cache-control'], 'no-store');
      const file = r.json(); assert.equal(file.format, format); assert.equal(file.filename, 'WZ-' + head.id + '.' + format); assert.equal(file.row_count, detail.rows.length); assert.equal(file.values_included, false); assert.equal(file.document.id, head.id);
      const quantityOnly = head.commercial_lines.map(({ line_total: _total, vat: _vat, currency: _currency, ...line }: any) => line); assert.deepEqual(file.document.commercial_lines, quantityOnly);
      assert.deepEqual(file.document.summary, { physical_quantity: 2 });
      const json = JSON.stringify(quantityOnly), content = file.content; assert.equal(typeof content, 'string');
      if (format === 'csv') { assert.equal(file.content_type, 'text/csv; charset=utf-8'); assert(content.startsWith('\ufeff')); assert(content.includes('commercial_lines_json')); assert(content.includes(json.replaceAll('"', '""'))); }
      else { assert.equal(file.content_type, 'application/xml; charset=utf-8'); assert(content.startsWith('<?xml version="1.0" encoding="UTF-8"?>')); const escaped = json.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;'); assert(content.includes('<commercial_lines_json>' + escaped + '</commercial_lines_json>')); assert(content.includes('<physical_quantity>2</physical_quantity>')); }
      for (const physical of detail.rows) { assert(content.includes(physical.stock_movement_id)); assert(content.includes(physical.location_movement_id)); }
    });
    documents.push(detail);
  }
  await zero('first receipt replay after complete changed order version', async () => { const r = await ok(root + '/plans/' + f.plan.id + '/parcels/0/dispatch', 'POST', dispatchRequests[0]); assert.equal(r.reused, true); assert.deepEqual(r.dispatch, dispatches[0]); });
  await zero('approved source after all physical dispatches', async () => { const r = await ok(sourcePath); assert.equal(r.source.approved_mapping_id, mapping.id); assert.deepEqual(r.source.items, source.items); assert(r.source.progress.every((p: any) => p.state === 'dispatched')); });
  const after = await capture(), rows = after.graph.rows;
  const oldDocs = beforeDispatch.graph.rows.warehouse_wz_issuer_documents;
  assert.equal(rows.warehouse_wz_issuer_documents.length, oldDocs.length + 2); for (const old of oldDocs) assert(rows.warehouse_wz_issuer_documents.some(r => JSON.stringify(r) === JSON.stringify(old)));
  const sameExcept = (a: any, b: any, mutable: string[]) => {
    const omit = (r: any) => Object.fromEntries(Object.entries(r).filter(([key]) => !mutable.includes(key)));
    assert.deepEqual(omit(a), omit(b));
  };
  for (const [product, issued] of [[f.products[0], 3], [f.products[1], 1]] as const) {
    const b = beforeDispatch.graph.rows.stock.find(r => r.row.tenant_id === f.tenant && r.row.product_id === product.id && r.row.warehouse_id === f.warehouse.id)?.row;
    const a = rows.stock.find(r => r.row.tenant_id === f.tenant && r.row.product_id === product.id && r.row.warehouse_id === f.warehouse.id)?.row; assert(b && a); assert.equal(a.on_hand, b.on_hand - issued); assert.equal(a.reserved, b.reserved - issued); assert.equal(BigInt(a.version), BigInt(b.version) + (product.id === f.products[0].id ? 2n : 1n)); sameExcept(a, b, ['on_hand', 'reserved', 'version']);
    const reservation = rows.reservations.find(r => r.row.tenant_id === f.tenant && r.row.product_id === product.id && r.row.order_id === f.order.id)?.row; assert(reservation); assert.equal(reservation.quantity, issued); assert.equal(reservation.consumed_quantity, issued); assert.equal(reservation.state, 'consumed');
    const oldReservation = beforeDispatch.graph.rows.reservations.find(r => r.row.tenant_id === f.tenant && r.row.product_id === product.id && r.row.order_id === f.order.id)?.row; assert(oldReservation); sameExcept(reservation, oldReservation, ['consumed_quantity', 'state']);
    const bin = rows.stock_locations.find(r => r.row.tenant_id === f.tenant && r.row.product_id === product.id && r.row.warehouse_id === f.warehouse.id && r.row.location === 'A-01')?.row;
    const oldBin = beforeDispatch.graph.rows.stock_locations.find(r => r.row.tenant_id === f.tenant && r.row.product_id === product.id && r.row.warehouse_id === f.warehouse.id && r.row.location === 'A-01')?.row; assert(bin && oldBin); assert.equal(bin.quantity, oldBin.quantity - issued); sameExcept(bin, oldBin, ['quantity']);
    const heldBin = rows.reservation_locations.find(r => r.row.tenant_id === f.tenant && r.row.product_id === product.id && r.row.order_id === f.order.id && r.row.location === 'A-01')?.row;
    const oldHeldBin = beforeDispatch.graph.rows.reservation_locations.find(r => r.row.tenant_id === f.tenant && r.row.product_id === product.id && r.row.order_id === f.order.id && r.row.location === 'A-01')?.row; assert(heldBin && oldHeldBin); assert.equal(heldBin.consumed_quantity, issued); assert.equal(heldBin.scanned, issued); sameExcept(heldBin, oldHeldBin, ['consumed_quantity']);
  }
  for (const table of ['stock_movements', 'stock_location_movements']) {
    const old = beforeDispatch.graph.rows[table], now = rows[table], oldIds = new Set(old.map(r => r.row.id));
    assert.equal(now.length, old.length + 3); for (const r of old) assert(now.some(n => JSON.stringify(n) === JSON.stringify(r)));
    const fresh = now.filter(r => !oldIds.has(r.row.id)).map(r => r.row);
    assert.deepEqual(new Set(fresh.map(r => r.id)), new Set(dispatches.flatMap(d => (table === 'stock_movements' ? d.receipt.stock_movements : d.receipt.location_movements).map((r: any) => r.id))));
    for (const [index, expected] of [[0, [[f.products[0].id, 2]]], [1, [[f.products[0].id, 1], [f.products[1].id, 1]]]] as const) {
      const receiptRows = table === 'stock_movements' ? dispatches[index].receipt.stock_movements : dispatches[index].receipt.location_movements;
      const ids = new Set(receiptRows.map((r: any) => r.id));
      const actual = fresh.filter(r => ids.has(r.id)); assert.equal(actual.length, expected.length);
      for (const [productId, quantity] of expected) {
        const r = actual.find(r => r.product_id === productId); assert(r); assert.equal(r.tenant_id, f.tenant); assert.equal(r.order_id, f.order.id); assert.equal(r.warehouse_id, f.warehouse.id); assert.equal(r.kind, 'shipment'); assert.equal(r.delta, -quantity);
        const receiptRow = receiptRows.find((entry: any) => entry.id === r.id); assert(receiptRow); assert.equal(receiptRow.product_id, productId); assert.equal(receiptRow.warehouse_id, f.warehouse.id); assert.equal(receiptRow.quantity, quantity);
        if (table === 'stock_movements') { assert.equal(r.note, 'parcel:' + dispatches[index].id); assert.equal(r.warehouse_document_id, null); }
        else { assert.equal(r.location, 'A-01'); assert.equal(r.operation_id, dispatches[index].id); }
      }
    }
  }
  for (const table of ['wms_operations', 'wms_issue_fragments', 'wms_layer_movements', 'wms_layer_positions', 'wms_reservation_layers']) assert.deepEqual(rows[table], beforeDispatch.graph.rows[table], 'This genuine WMS-OFF fixture never creates a lot writer');
  const artifact = await save('native-flow.private.json', { source, preview_request: previewRequest, preview, apply_request: applyRequest, mapping, dispatch_requests: dispatchRequests, dispatches, documents, requests: receipts });
  return { status: 'ACTUAL_PHYSICAL_WZ_NATIVE_FLOW_PASS', two_real_issued_wz: true, complete_explicit_mapping: true, truthful_component_lineage: true, all_reads_replays_refusals_full_db_zero: true, full_physical_stock_conservation: true, strict_catalog_public_activation: f.strict ? 'FIXTURE_ENABLED_REQUIRES_SEPARATE_PUBLIC_GATE' : 'NOT_VERIFIED', artifact };
}
