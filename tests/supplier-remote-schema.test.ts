import assert from 'node:assert/strict';
import test from 'node:test';
import {
  supplierRemoteUpdateInput,
  supplierRemoteFetchInput,
  supplierFeedScheduleInput,
  supplierRemoteAuthValue,
  supplierRemotePageInput,
} from '../server/supplier-remote-schema.js';

const client_key = '00000000-0000-4000-8000-000000000001';
const remote = {
  client_key,
  version: 0,
  source_version: 1,
  url: 'https://supplier.example/feed.csv?signature=private',
  auth: { action: 'clear' },
  scope: 'delta',
  confirmed: true,
};
const schedule = {
  client_key,
  version: 0,
  source_version: 1,
  remote_version: 1,
  enabled: false,
  interval_minutes: 30,
  confirmed: true,
};

test('signed HTTPS URL survives parsing; unsafe addresses and URL forms are rejected', () => {
  assert.equal(supplierRemoteUpdateInput.parse(remote).url, remote.url);
  for (const url of [
    'http://supplier.example/feed',
    'https://127.0.0.1/feed',
    'https://[::1]/feed',
    'https://168.63.129.16/feed',
    'https://user:pass@supplier.example/feed',
    'https://supplier.example:8443/feed',
    'https://supplier.example/feed#secret',
    'https://supplier.example/feed\n',
  ]) {
    assert.equal(supplierRemoteUpdateInput.safeParse({ ...remote, url }).success, false, url);
  }
});

test('credentials require explicit keep, clear or replace; transport headers cannot be overridden', () => {
  for (const auth of [
    { action: 'keep' },
    { action: 'clear' },
    { action: 'replace', value: { kind: 'header', name: 'X-Api-Key', value: 'private' } },
  ]) {
    assert(supplierRemoteUpdateInput.safeParse({ ...remote, auth }).success);
  }
  for (const auth of [
    undefined,
    { action: 'replace' },
    { action: 'keep', token: 'secret' },
    { action: 'replace', value: { kind: 'header', name: 'Host', value: 'private' } },
    { action: 'replace', value: { kind: 'header', name: 'X-Forwarded-For', value: 'private' } },
  ]) {
    assert.equal(supplierRemoteUpdateInput.safeParse({ ...remote, auth }).success, false);
  }
});

test('secret injection, oversized Basic payload and transport-incompatible Unicode bearer are rejected', () => {
  for (const auth of [
    { kind: 'basic', username: 'name:other', password: 'secret' },
    { kind: 'basic', username: 'u'.repeat(3000), password: 'p'.repeat(1097) },
    { kind: 'bearer', token: '雪' },
    { kind: 'bearer', token: 'secret\r\nHost: evil' },
    { kind: 'header', name: 'X-Api-Key', value: 'a\0b' },
  ])
    assert.equal(supplierRemoteAuthValue.safeParse(auth).success, false);
  assert(
    supplierRemoteAuthValue.safeParse({
      kind: 'basic',
      username: 'u'.repeat(3000),
      password: 'p'.repeat(1096),
    }).success,
  );
});

test('configuration and queue commands require CAS versions, confirmation and strict payload', () => {
  assert(
    supplierRemoteUpdateInput.safeParse({
      ...remote,
      url: undefined,
      auth: { action: 'keep' },
      version: 1,
    }).success,
  );
  for (const change of [
    { confirmed: false },
    { version: -1 },
    { source_version: 0 },
    { deferPrincipalPin: true },
    { url: '', auth: { action: 'clear' } },
  ]) {
    assert.equal(supplierRemoteUpdateInput.safeParse({ ...remote, ...change }).success, false);
  }
  const fetch = { client_key, source_version: 1, remote_version: 1 };
  assert(supplierRemoteFetchInput.safeParse(fetch).success);
  for (const extra of [
    { url: remote.url },
    { auth: { action: 'keep' } },
    { confirmed: true },
    { remote_version: 0 },
  ]) {
    assert.equal(supplierRemoteFetchInput.safeParse({ ...fetch, ...extra }).success, false);
  }
});

test('schedules default to no publication and no withdrawal, with bounded intervals', () => {
  const parsed = supplierFeedScheduleInput.parse(schedule);
  assert.equal(parsed.publish.enabled, false);
  assert.equal(parsed.publish.allow_new, false);
  assert.equal(parsed.publish.withdrawal.enabled, false);
  for (const interval_minutes of [0, 29, 30.5, 10081])
    assert.equal(
      supplierFeedScheduleInput.safeParse({ ...schedule, interval_minutes }).success,
      false,
    );
  assert(supplierFeedScheduleInput.safeParse({ ...schedule, interval_minutes: 10080 }).success);
});

test('withdrawal thresholds reject unbounded values rather than silently clipping them', () => {
  const withdrawal = { enabled: true, min_rows: 1, max_missing: 0, max_missing_percent: 0 };
  for (const invalid of [
    { min_rows: 0 },
    { min_rows: 501 },
    { max_missing: -1 },
    { max_missing: 10001 },
    { max_missing_percent: 101 },
    { max_missing_percent: 0.1 },
  ]) {
    assert.equal(
      supplierFeedScheduleInput.safeParse({
        ...schedule,
        publish: { enabled: true, withdrawal: { ...withdrawal, ...invalid } },
      }).success,
      false,
    );
  }
});

test('history pagination stays bounded and rejects foreign query fields', () => {
  assert.deepEqual(supplierRemotePageInput.parse({ limit: '100', after: client_key }), {
    limit: 100,
    after: client_key,
  });
  for (const query of [
    { limit: '101' },
    { limit: '-1' },
    { limit: '1.5' },
    { after: 'invalid' },
    { tenant_id: client_key },
  ]) {
    assert.equal(supplierRemotePageInput.safeParse(query).success, false);
  }
});
