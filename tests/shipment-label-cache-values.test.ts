import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  shipmentLabelCacheAcquireInput,
  shipmentLabelCacheReconcileInput,
  shipmentLabelCachePageInput,
} from '../server/shipment-label-cache-values';
import { shipmentLabelPrintPreviewInput } from '../server/shipment-label-print-values';

const acquire = () => ({ client_key: randomUUID(), order_version: '9223372036854775807',
  source_hash: '0123456789abcdef'.repeat(4), confirmed_existing_label: true as const });

test('acquire retains exact bigint CAS and canonical principal request identity', () => {
  const body = acquire();
  const parsed = shipmentLabelCacheAcquireInput.parse({ ...body, client_key: body.client_key.toUpperCase() });
  assert.deepEqual(parsed, body);
  assert.equal(JSON.parse(JSON.stringify(parsed)).order_version, '9223372036854775807');
  for (const order_version of [Number.MAX_SAFE_INTEGER + 1, '9223372036854775808', '01', '1e3', '0'])
    assert.equal(shipmentLabelCacheAcquireInput.safeParse({ ...body, order_version }).success, false);
});

test('acquire cannot supply provider URLs, bytes, credentials or source authority', () => {
  const body = acquire();
  for (const [key, value] of [
    ['url', 'https://attacker.invalid/label'], ['provider', 'inpost'], ['mode', 'live'],
    ['external_id', '123'], ['shipment_id', randomUUID()], ['asset_id', randomUUID()],
    ['content_base64', 'JVBERi0='], ['content_encrypted', 'pretend'], ['headers', { Authorization: 'secret' }],
    ['credentials', { token: 'secret' }], ['skip_source_check', true], ['force_refresh', true],
  ] as const)
    assert.equal(shipmentLabelCacheAcquireInput.safeParse({ ...body, [key]: value }).success, false, key);
});

test('source fingerprint and consent are explicit, without coercion or defaults', () => {
  const body = acquire();
  for (const source_hash of ['', 'f'.repeat(63), 'f'.repeat(65), 'F'.repeat(64), 'x'.repeat(64)])
    assert.equal(shipmentLabelCacheAcquireInput.safeParse({ ...body, source_hash }).success, false);
  for (const confirmed_existing_label of [false, 'true', 1, null, undefined])
    assert.equal(shipmentLabelCacheAcquireInput.safeParse({ ...body, confirmed_existing_label }).success, false);
  const { client_key: omitted, ...withoutKey } = body;
  assert.equal(shipmentLabelCacheAcquireInput.safeParse(withoutKey).success, false);
});

test('manual reconciliation can only explicitly abandon, never fabricate a cache or restart a GET', () => {
  const body = { client_key: randomUUID(), confirmed_abandon: true };
  assert.deepEqual(shipmentLabelCacheReconcileInput.parse(body), body);
  for (const confirmed_abandon of [false, 'true', null, undefined])
    assert.equal(shipmentLabelCacheReconcileInput.safeParse({ ...body, confirmed_abandon }).success, false);
  for (const extra of [{ state: 'ready' }, { asset_id: randomUUID() }, { retry: true },
    { result: 'success' }, { error_code: 'ABANDONED' }, { request_hash: 'a'.repeat(64) }])
    assert.equal(shipmentLabelCacheReconcileInput.safeParse({ ...body, ...extra }).success, false);
});

test('history query is bounded and cursor UUID canonical, without arbitrary filters or SQL-shaped cursor', () => {
  const cursor = randomUUID();
  assert.deepEqual(shipmentLabelCachePageInput.parse({ cursor: cursor.toUpperCase(), limit: '50' }), { cursor, limit: 50 });
  assert.deepEqual(shipmentLabelCachePageInput.parse({}), { limit: 50 });
  for (const query of [{ limit: 0 }, { limit: 51 }, { limit: 1.5 }, { limit: 'Infinity' },
    { cursor: "x' OR true--" }, { after: cursor }, { tenant_id: randomUUID() }, { include_raw: true }])
    assert.equal(shipmentLabelCachePageInput.safeParse(query).success, false);
});

test('146 old preview body remains valid; explicit cached asset selector is a UUID, never caller bytes', () => {
  const oldBody = { client_key: randomUUID(), order_version: '1', station_id: randomUUID(),
    station_version: '1', printer_id: randomUUID(), printer_version: '1', copies: 1 };
  assert.deepEqual(shipmentLabelPrintPreviewInput.parse(oldBody), oldBody);
  const asset = randomUUID();
  assert.deepEqual(shipmentLabelPrintPreviewInput.parse({ ...oldBody, asset_id: asset.toUpperCase() }),
    { ...oldBody, asset_id: asset });
  for (const extra of [{ asset_id: '../asset' }, { asset_id: null }, { asset_id: '' },
    { content_base64: 'JVBERi0=' }, { source_kind: 'inpost_cached' }, { source_hash: 'a'.repeat(64) }])
    assert.equal(shipmentLabelPrintPreviewInput.safeParse({ ...oldBody, ...extra }).success, false);
});
