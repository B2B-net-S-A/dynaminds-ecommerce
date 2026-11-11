import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  shipmentLabelBatchPreviewInput,
  shipmentLabelBatchQueueInput,
  shipmentLabelBatchHistoryInput,
  shipmentLabelBatchChildKey,
} from '../server/shipment-label-batch-values';

const preview = () => ({
  client_key: randomUUID(),
  station_id: randomUUID(),
  station_version: '1',
  printer_id: randomUUID(),
  printer_version: '9223372036854775807',
  copies: 1,
  shipments: [
    { shipment_id: randomUUID().toLowerCase(), order_version: '2', asset_id: randomUUID() },
    { shipment_id: randomUUID(), order_version: '3', asset_id: randomUUID() },
  ],
});

test('explicit shipment order is retained while all UUIDs become canonical', () => {
  const body = preview();
  body.shipments[0].shipment_id = body.shipments[0].shipment_id.toUpperCase();
  const parsed = shipmentLabelBatchPreviewInput.parse(body);
  assert.deepEqual(
    parsed.shipments.map((row) => row.asset_id),
    body.shipments.map((row) => row.asset_id),
  );
  assert.equal(parsed.shipments[0].shipment_id, body.shipments[0].shipment_id.toLowerCase());
  assert.equal(parsed.printer_version, '9223372036854775807');
});

test('duplicate shipment, unknown fields and unsafe versions cannot request a second copy', () => {
  const body = preview();
  assert.equal(
    shipmentLabelBatchPreviewInput.safeParse({
      ...body,
      shipments: [body.shipments[0], { ...body.shipments[0], asset_id: randomUUID() }],
    }).success,
    false,
  );
  for (const version of ['0', '01', '-1', '1.0', '9223372036854775808'])
    assert.equal(
      shipmentLabelBatchPreviewInput.safeParse({ ...body, printer_version: version }).success,
      false,
    );
  assert.equal(
    shipmentLabelBatchPreviewInput.safeParse({ ...body, provider_fetch: true }).success,
    false,
  );
  for (const copies of [0, 11, 1.5, '1'])
    assert.equal(shipmentLabelBatchPreviewInput.safeParse({ ...body, copies }).success, false);
});

test('one to fifty whole shipments are accepted, never truncated', () => {
  const body = preview();
  const shipments = Array.from({ length: 50 }, () => ({
    shipment_id: randomUUID(),
    order_version: '1',
    asset_id: randomUUID(),
  }));
  assert.equal(shipmentLabelBatchPreviewInput.parse({ ...body, shipments }).shipments.length, 50);
  assert.equal(shipmentLabelBatchPreviewInput.safeParse({ ...body, shipments: [] }).success, false);
  assert.equal(
    shipmentLabelBatchPreviewInput.safeParse({
      ...body,
      shipments: [...shipments, ...body.shipments],
    }).success,
    false,
  );
});

test('queue requires exact consent/hash; history pagination is bounded and typed', () => {
  const body = { client_key: randomUUID(), scope_hash: 'a'.repeat(64), confirmed: true };
  assert.deepEqual(shipmentLabelBatchQueueInput.parse(body), body);
  for (const change of [
    { confirmed: false },
    { scope_hash: 'A'.repeat(64) },
    { asset_id: randomUUID() },
  ])
    assert.equal(shipmentLabelBatchQueueInput.safeParse({ ...body, ...change }).success, false);
  assert.equal(shipmentLabelBatchHistoryInput.parse({ kind: 'execution' }).limit, 50);
  assert.equal(shipmentLabelBatchHistoryInput.parse({ kind: 'preview', limit: '1' }).limit, 1);
  for (const limit of [0, 51, 1.5])
    assert.equal(
      shipmentLabelBatchHistoryInput.safeParse({ kind: 'preview', limit }).success,
      false,
    );
});

test('child keys are deterministic and separated by parent/shipment/operation', () => {
  const parent = randomUUID(),
    shipment = randomUUID();
  const key = shipmentLabelBatchChildKey(parent, shipment, 'preview');
  assert.match(key, /^[a-f0-9]{8}-[a-f0-9]{4}-8[a-f0-9]{3}-a[a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.equal(
    key,
    shipmentLabelBatchChildKey(parent.toUpperCase(), shipment.toUpperCase(), 'preview'),
  );
  assert.notEqual(key, shipmentLabelBatchChildKey(parent, shipment, 'queue'));
  assert.notEqual(key, shipmentLabelBatchChildKey(randomUUID(), shipment, 'preview'));
  assert.notEqual(key, shipmentLabelBatchChildKey(parent, randomUUID(), 'preview'));
});
