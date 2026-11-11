import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InPost } from '../server/integrations';

test('existing InPost label uses one authenticated fixed-host GET, exact PDF bytes and A6', async () => {
  const bytes = Buffer.from('%PDF-1.7\ntransport-only fixture\n%%EOF'),
    calls: Array<{ url: string; init: RequestInit }> = [];
  const client = new InPost(
    'sandbox',
    { access_token: 'synthetic-unit-token' },
    async (url, init) => {
      calls.push({ url, init });
      return new Response(bytes, {
        headers: { 'Content-Type': 'application/pdf; charset=binary' },
      });
    },
  );
  assert.deepEqual(await client.label('12345', 2097152), bytes);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(
    calls[0].url,
    'https://sandbox-api-shipx-pl.easypack24.net/v1/shipments/12345/label?format=pdf&type=A6',
  );
  assert.equal(
    new Headers(calls[0].init.headers).get('Authorization'),
    'Bearer synthetic-unit-token',
  );
  assert.equal(calls[0].init.body, undefined);
});

test('label transport has no implicit retry for errors or a thrown uncertain response', async () => {
  for (const status of [401, 429, 500]) {
    let calls = 0;
    const client = new InPost('live', { access_token: 'synthetic-unit-token' }, async () => {
      calls++;
      return new Response('error', { status, headers: { 'Content-Type': 'application/json' } });
    });
    await assert.rejects(() => client.label('12345', 2097152));
    assert.equal(calls, 1);
  }
  let calls = 0;
  const client = new InPost('sandbox', {}, async () => {
    calls++;
    throw Error('synthetic lost response');
  });
  await assert.rejects(() => client.label('12345', 2097152));
  assert.equal(calls, 1);
});

test('cache bound cancels an oversized stream, rejects mislabeled content, and validates its limit before transport', async () => {
  let cancelled = false,
    read = 0,
    calls = 0;
  const client = new InPost('sandbox', {}, async () => {
    calls++;
    return new Response(
      new ReadableStream({
        pull(c) {
          read++;
          c.enqueue(new Uint8Array(1048576));
        },
        cancel() {
          cancelled = true;
        },
      }),
      { headers: { 'Content-Type': 'application/pdf' } },
    );
  });
  await assert.rejects(() => client.label('12345', 2097152), /zbyt duża/);
  assert.equal(calls, 1);
  assert(cancelled);
  assert(read <= 4);
  for (const limit of [0, 1.5, 10485761, Infinity])
    await assert.rejects(() => client.label('12345', limit), /limit/);
  assert.equal(calls, 1);
  const html = new InPost(
    'sandbox',
    {},
    async () =>
      new Response('<html>not PDF</html>', { headers: { 'Content-Type': 'application/pdf' } }),
  );
  await assert.rejects(() => html.label('12345', 2097152), /format/);
});
