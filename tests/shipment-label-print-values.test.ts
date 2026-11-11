import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  shipmentLabelPrintPreviewInput,
  shipmentLabelPrintQueueInput,
} from '../server/shipment-label-print-values';

const id = 'b72d895a-68f8-4d9d-8f43-b1f80e29092f';
const preview = {
  client_key: id,
  order_version: '12',
  station_id: id,
  station_version: '3',
  printer_id: id,
  printer_version: '4',
  copies: 1,
};
test('shipment preview accepts only configuration and versions, never caller-supplied label provenance', () => {
  assert.deepEqual(shipmentLabelPrintPreviewInput.parse(preview), preview);
  for (const field of ['content_base64', 'source_kind', 'tracking_number', 'shipping_plan_id'])
    assert.equal(
      shipmentLabelPrintPreviewInput.safeParse({ ...preview, [field]: id }).success,
      false,
    );
  for (const copies of [0, 11, 1.1])
    assert.equal(shipmentLabelPrintPreviewInput.safeParse({ ...preview, copies }).success, false);
});
test('queue consent binds the exact preview scope and rejects implicit or changed confirmation', () => {
  const body = { client_key: id, scope_hash: 'a'.repeat(64), confirmed: true };
  assert.deepEqual(shipmentLabelPrintQueueInput.parse(body), body);
  for (const changed of [
    { confirmed: false },
    { confirmed: 'true' },
    { scope_hash: 'A'.repeat(64) },
    { content_base64: 'JVBERg==' },
  ])
    assert.equal(shipmentLabelPrintQueueInput.safeParse({ ...body, ...changed }).success, false);
});
