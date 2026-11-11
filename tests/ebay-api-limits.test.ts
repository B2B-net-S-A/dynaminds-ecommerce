import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pool, migrate, tenantTx } from '../server/db';
import { seed, DEMO_TENANT } from './fixtures';
import { Ebay, ebayBase } from '../server/ebay';
import {
  EbayApiWait,
  acquireEbayApi,
  releaseEbayApi,
  ebayApplicationHash,
  ebayApiScope,
  ebayRetryUntil,
  ebayApiFamily,
  ebayLimitedTransport,
  reserveEbayTransport,
  sendEbayReserved,
  deferEbayApiJob,
  ebayApiStatus,
} from '../server/ebay-api-limits';
assert.equal(process.env.DYNA_TEST, 'true');
const appHash = ebayApplicationHash('sandbox', 'QA-APP'),
  url = ebayBase('sandbox') + '/sell/inventory/v1/offer';
before(async () => {
  await migrate();
  await seed();
});
beforeEach(async () => {
  await pool.query('DELETE FROM ebay_api_leases; DELETE FROM ebay_api_buckets');
});
after(() => pool.end());
const count = async () =>
  Number((await pool.query('SELECT count(*) FROM ebay_api_leases')).rows[0].count);
async function cool(family = 'inventory', seconds = 3600) {
  const p = await acquireEbayApi(appHash, family, url, 'GET');
  await releaseEbayApi(p);
  await pool.query(
    'UPDATE ebay_api_buckets SET cooldown_until=clock_timestamp()+make_interval(secs=>$2) WHERE scope_hash=$1',
    [p.scope, seconds],
  );
}
test('API limit: sixteen concurrent admissions share four durable slots and do not overrun', async () => {
  const results = await Promise.allSettled(
    Array.from({ length: 16 }, () => acquireEbayApi(appHash, 'inventory', url, 'GET')),
  );
  const permits = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
  assert.equal(permits.length, 4);
  assert.equal(await count(), 4);
  for (const r of results)
    if (r.status === 'rejected') {
      assert(r.reason instanceof EbayApiWait);
      assert.equal(r.reason.reason, 'concurrency');
    }
  await Promise.all(permits.map(releaseEbayApi));
  assert.equal(await count(), 0);
});
test('API limit: application, environment and API families have independent slots', async () => {
  const permits = await Promise.all(
    Array.from({ length: 4 }, () => acquireEbayApi(appHash, 'inventory', url, 'GET')),
  );
  await assert.rejects(acquireEbayApi(appHash, 'inventory', url, 'GET'), EbayApiWait);
  for (const [app, family] of [
    [appHash, 'fulfillment'],
    [ebayApplicationHash('live', 'QA-APP'), 'inventory'],
    [ebayApplicationHash('sandbox', 'OTHER'), 'inventory'],
  ])
    permits.push(await acquireEbayApi(app, family, url, 'GET'));
  await Promise.all(permits.map(releaseEbayApi));
});
test('API limit: responses hold a slot through streaming, cancel and body errors', async () => {
  let bodyController: ReadableStreamDefaultController<Uint8Array>;
  const wrapped = ebayLimitedTransport(
    'sandbox',
    'QA-APP',
    async () =>
      new Response(
        new ReadableStream({
          start(c) {
            bodyController = c;
          },
        }),
      ),
  );
  const r = await wrapped(url, { method: 'GET' });
  assert.equal(await count(), 1);
  bodyController!.enqueue(new TextEncoder().encode('hello'));
  bodyController!.close();
  assert.equal(await r.text(), 'hello');
  assert.equal(await count(), 0);
  const second = await wrapped(url, { method: 'GET' });
  await second.body!.cancel();
  assert.equal(await count(), 0);
  const third = await wrapped(url, { method: 'GET' });
  bodyController!.error(Error('body failed'));
  await assert.rejects(third.text(), /body failed/);
  assert.equal(await count(), 0);
});
test('API limit: expired crash slots are reclaimed and HTTP runs without bucket locks', async () => {
  await acquireEbayApi(appHash, 'inventory', url, 'GET');
  await pool.query("UPDATE ebay_api_leases SET expires_at=now()-interval '1 second'");
  const wrapped = ebayLimitedTransport('sandbox', 'QA-APP', async () => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT 1 FROM ebay_api_buckets WHERE scope_hash=$1 FOR UPDATE NOWAIT', [
        ebayApiScope(appHash, 'inventory'),
      ]);
      await c.query('ROLLBACK');
    } finally {
      c.release();
    }
    return new Response(null, { status: 204 });
  });
  await wrapped(url, { method: 'GET' });
  assert.equal(await count(), 0);
});
test('API limit: Retry-After preserves long seconds and HTTP date, with bounded fallback only for invalid values', () => {
  const now = Date.parse('2026-10-04T10:00:00Z');
  assert.equal(ebayRetryUntil('3600', now), '2026-10-04T11:00:00.000Z');
  assert.equal(ebayRetryUntil('Sun, 04 Oct 2026 12:00:00 GMT', now), '2026-10-04T12:00:00.000Z');
  assert.equal(ebayRetryUntil('0', now), new Date(now).toISOString());
  assert.equal(ebayRetryUntil('0.5', now), new Date(now + 500).toISOString());
  for (const h of [null, 'junk', '-1', '1e99'])
    assert.equal(ebayRetryUntil(h, now), new Date(now + 60000).toISOString());
});
test('API limit: provider 429 blocks a second connector of the same application without another HTTP request', async () => {
  let calls = 0;
  const base = async () => {
    calls++;
    return new Response('{}', { status: 429, headers: { 'retry-after': '3600' } });
  };
  const first = ebayLimitedTransport('sandbox', 'QA-APP', base),
    second = ebayLimitedTransport('sandbox', 'QA-APP', base);
  const r = await first(url, { method: 'GET' });
  await r.text();
  await assert.rejects(
    second(url, { method: 'GET' }),
    (e) => e instanceof EbayApiWait && e.reason === 'cooldown',
  );
  assert.equal(calls, 1);
  assert.equal(await count(), 0);
  const status = await ebayApiStatus(appHash);
  assert.equal(status.families[0].family, 'inventory');
  assert.equal(status.families[0].limited_responses, '1');
  assert.equal(status.provider_quota_read, false);
});
test('API limit: a received 429 never shortens an existing longer cooldown', async () => {
  const wrapped = ebayLimitedTransport(
    'sandbox',
    'QA-APP',
    async () => new Response('{}', { status: 429, headers: { 'retry-after': '30' } }),
  );
  const p = await reserveEbayTransport(wrapped, url, 'GET');
  await cool('inventory', 7200);
  const until = (await pool.query('SELECT cooldown_until FROM ebay_api_buckets')).rows[0]
    .cooldown_until;
  const r = await sendEbayReserved(wrapped, p, url, { method: 'GET' });
  await r.text();
  assert.equal(
    (
      await pool.query('SELECT cooldown_until FROM ebay_api_buckets')
    ).rows[0].cooldown_until.getTime(),
    until.getTime(),
  );
});
test('API limit: read 429 defers immediately with one HTTP rather than truncating an hour to five seconds', async () => {
  let calls = 0;
  const ebay = new Ebay('sandbox', { access_token: 'QA-TOKEN', client_id: 'QA-APP' }, async () => {
    calls++;
    return new Response('{}', { status: 429, headers: { 'retry-after': '3600' } });
  });
  const start = Date.now();
  await assert.rejects(ebay.request('offer', undefined, 'inventory'), EbayApiWait);
  assert.equal(calls, 1);
  assert(Date.now() - start < 2000);
});
test('API limit: admission is before mutation checkpoint and an aborted checkpoint releases its slot', async () => {
  let calls = 0,
    checkpoint = 0;
  const ebay = new Ebay('sandbox', { access_token: 'QA-TOKEN', client_id: 'QA-APP' }, async () => {
    calls++;
    return Response.json({});
  });
  await cool();
  await assert.rejects(
    ebay.mutationCheckpoint('/sell/inventory/v1/offer', 'POST', async () => {
      checkpoint++;
      return true;
    }),
    EbayApiWait,
  );
  assert.equal(checkpoint, 0);
  assert.equal(calls, 0);
  await pool.query("UPDATE ebay_api_buckets SET cooldown_until='-infinity'");
  assert.equal(
    await ebay.mutationCheckpoint('/sell/inventory/v1/offer', 'POST', async () => false),
    false,
  );
  assert.equal(await count(), 0);
  await assert.rejects(
    ebay.mutationCheckpoint('/sell/inventory/v1/offer', 'POST', async () => {
      throw Error('changed');
    }),
    /changed/,
  );
  assert.equal(await count(), 0);
});
test('API limit: reserved request rejects changed method, application and expired lease before HTTP', async () => {
  let calls = 0;
  const base = async () => {
    calls++;
    return Response.json({});
  };
  const a = ebayLimitedTransport('sandbox', 'QA-APP', base),
    b = ebayLimitedTransport('sandbox', 'OTHER', base);
  const p = await reserveEbayTransport(a, url, 'POST');
  await assert.rejects(sendEbayReserved(b, p, url, { method: 'POST' }), /nie odpowiada/);
  assert.equal(await count(), 0);
  const p2 = await reserveEbayTransport(a, url, 'POST');
  await pool.query("UPDATE ebay_api_leases SET expires_at=now()-interval '1 second'");
  await assert.rejects(sendEbayReserved(a, p2, url, { method: 'POST' }), /wygasło/);
  const p3 = await reserveEbayTransport(a, url, 'POST');
  await assert.rejects(sendEbayReserved(a, p3, url, { method: 'PUT' }), /nie odpowiada/);
  assert.equal(calls, 0);
  assert.equal(await count(), 0);
});
test('API limit: job wait refunds the attempt and stale or foreign lease cannot change it', async () => {
  const id = randomUUID(),
    lease = randomUUID();
  await tenantTx(DEMO_TENANT, (c) =>
    c.query(
      "INSERT INTO jobs(id,tenant_id,kind,payload,state,attempts,max_attempts,lease_token,locked_at,dedup_key) VALUES($1,$2,'sync','{}','running',1,1,$3,now(),$4)",
      [id, DEMO_TENANT, lease, id],
    ),
  );
  const until = new Date(Date.now() + 3600000).toISOString(),
    wait = new EbayApiWait(until, 'inventory', 'cooldown');
  assert.equal(
    await deferEbayApiJob({ id, tenant_id: DEMO_TENANT, lease_token: randomUUID() }, wait),
    true,
  );
  assert.equal(
    (await pool.query('SELECT state FROM jobs WHERE id=$1', [id])).rows[0].state,
    'running',
  );
  await deferEbayApiJob({ id, tenant_id: DEMO_TENANT, lease_token: lease }, wait);
  const job = (await pool.query('SELECT * FROM jobs WHERE id=$1', [id])).rows[0];
  assert.equal(job.state, 'pending');
  assert.equal(job.attempts, 0);
  assert.equal(job.provider_wait_until.toISOString(), until);
  assert.equal(job.lease_token, null);
});
test('API limit: provider control tables are inaccessible to company role and transport enforces API origin', async () => {
  for (const table of ['ebay_api_buckets', 'ebay_api_leases'])
    for (const permission of ['SELECT', 'INSERT', 'UPDATE', 'DELETE'])
      assert.equal(
        (
          await pool.query('SELECT has_table_privilege($1,$2,$3) allowed', [
            'dyna_app',
            table,
            permission,
          ])
        ).rows[0].allowed,
        false,
      );
  for (const url of [
    'https://evil.invalid/sell/inventory/v1/offer',
    'https://api.ebay.com/sell/inventory/v1/offer',
    'https://api.sandbox.ebay.com/sell/inventory/v1/offer#x',
    'https://api.sandbox.ebay.com/unknown',
  ])
    assert.throws(() => ebayApiFamily('sandbox', url));
  assert.equal(ebayApiFamily('sandbox', 'https://api.sandbox.ebay.com/ws/api.dll'), 'trading');
});

test('API limit: runtime token-only connector cannot silently bypass the application gate', () => {
  const before = process.env.DYNA_TEST;
  try {
    process.env.DYNA_TEST = 'false';
    assert.throws(
      () => ebayLimitedTransport('sandbox', undefined, async () => Response.json({})),
      /identyfikatora aplikacji/,
    );
  } finally {
    process.env.DYNA_TEST = before;
  }
});
