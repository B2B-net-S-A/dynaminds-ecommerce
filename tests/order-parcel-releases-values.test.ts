import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  orderParcelReleaseInput,
  orderParcelReleasePreviewInput,
  parcelReservationRemainder,
  parcelReservationState,
  releaseOrderParcelRemainderInTx,
} from '../server/order-parcel-release-stock';

test('remainder closure keeps the historical issued and released quantities distinct', () => {
  assert.equal(parcelReservationRemainder(3, 1, 0), 2);
  assert.equal(parcelReservationState(3, 1, 0), 'active');
  assert.equal(parcelReservationRemainder(3, 1, 2), 0);
  assert.equal(parcelReservationState(3, 1, 2), 'released');
  assert.equal(parcelReservationState(3, 0, 3), 'released');
  assert.equal(parcelReservationState(3, 3, 0), 'consumed');
});

test('over-consumption, double release and unsafe quantities fail before physical work', () => {
  for (const tuple of [[3, 1, 3], [3, 4, 0], [3, -1, 0], [3, 1, -1], [3, 0, 0.5], [0, 0, 0], [NaN, 0, 0], [Number.MAX_SAFE_INTEGER + 1, 0, 0]]) {
    assert.throws(() => parcelReservationRemainder(...tuple as [number, number, number]), (e: any) => e.status === 409);
  }
});

test('release consent cannot smuggle a partial subset, physical effect or a second operation', () => {
  const request = { client_key: randomUUID(), scope_hash: 'a'.repeat(64), confirmed: true };
  assert.deepEqual(orderParcelReleaseInput.parse(request), request);
  for (const extra of [{ parcels: [0] }, { quantity: 1 }, { restock: true }, { operation_id: randomUUID() }, { confirmed: false }]) {
    assert.equal(orderParcelReleaseInput.safeParse({ ...request, ...extra }).success, false);
  }
  assert.equal(orderParcelReleaseInput.safeParse({ client_key: request.client_key, scope_hash: request.scope_hash }).success, false);
});

test('preview CAS preserves the full int64 version without accepting lossy numbers', () => {
  const request = { client_key: randomUUID(), order_version: '9223372036854775807' };
  assert.equal(orderParcelReleasePreviewInput.parse(request).order_version, request.order_version);
  for (const version of ['9223372036854775808', '01', '0', '1.5', '1e2', 1, null]) {
    assert.equal(orderParcelReleasePreviewInput.safeParse({ ...request, order_version: version }).success, false);
  }
  const upper = request.client_key.toUpperCase();
  assert.equal(orderParcelReleasePreviewInput.parse({ ...request, client_key: upper }).client_key, request.client_key);
});

test('the stock adapter refuses an absent private admission before any mutation', async () => {
  const queries: string[] = [];
  const client = { query: async (sql: string) => { queries.push(sql); return { rows: [{ r: null }] }; } };
  const actor = { tenantId: randomUUID(), userId: randomUUID(), role: 'admin' };
  const scope: any = { operation_id: randomUUID(), plan_id: randomUUID(), order_id: randomUUID(), pending: [], products: [], summary: {}, wms_enabled: false };
  await assert.rejects(releaseOrderParcelRemainderInTx(client as any, actor as any, scope), (e: any) => e.status === 409);
  assert.equal(queries.length, 1);
  assert.match(queries[0], /^SELECT order_parcel_release_scope/);
});

test('a caller cannot replace the certified pending shipment or quantity with its own capsule', async () => {
  const queries: string[] = [];
  const scope: any = { operation_id: randomUUID(), plan_id: randomUUID(), order_id: randomUUID(), pending: [{ index: 1, shipment_id: randomUUID(), items: [] }], products: [], summary: {}, wms_enabled: false };
  for (const forged of [{ ...scope, order_id: randomUUID() }, { ...scope, pending: [] }, { ...scope, products: [{ product_id: randomUUID(), warehouse_id: randomUUID(), quantity: 1, locations: [], lot_holds: [] }] }]) {
    queries.length = 0;
    const client = { query: async (sql: string) => { queries.push(sql); return { rows: [{ r: scope }] }; } };
    await assert.rejects(releaseOrderParcelRemainderInTx(client as any, { tenantId: randomUUID(), userId: randomUUID(), role: 'admin' } as any, forged), (e: any) => e.status === 409);
    assert.equal(queries.length, 1);
  }
});
