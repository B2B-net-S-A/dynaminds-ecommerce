import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHmac } from 'node:crypto';
import { pool, migrate, tenantTx } from '../server/db';
import { seed, DEMO_TENANT, SECOND_TENANT } from './fixtures';
import { buildApp } from '../server/app';
import { encrypt, decrypt } from '../server/security';
import { demoShopifyOrder } from '../server/shopify-example';
import { SHOPIFY_VERSION } from '../server/shopify';
import {
  shopifyWebhookOrder,
  processShopifyWebhook,
  failShopifyWebhook,
  shopifyWebhookDomain,
} from '../server/shopify-webhooks';
import { tick } from '../server/worker';
import type { Transport } from '../server/integrations';
assert.equal(process.env.DYNA_TEST, 'true');
const secret = 'qa-shopify-webhook-secret-not-real-2026',
  store = 'https://webhook-qa.myshopify.com';
let raw: any = structuredClone(demoShopifyOrder),
  calls = 0,
  hook: (() => Promise<void>) | undefined;
const transport: Transport = async (url, init) => {
  calls++;
  assert.equal(url, store + '/admin/api/' + SHOPIFY_VERSION + '/graphql.json');
  const b = JSON.parse(String(init.body));
  assert.match(b.query, /^query DynaOrder\(/);
  const data = {
    shop: { id: 'gid://shopify/Shop/88', myshopifyDomain: 'webhook-qa.myshopify.com' },
    order: structuredClone(raw),
  };
  await hook?.();
  return new Response(JSON.stringify({ data }), {
    headers: { 'X-Shopify-API-Version': SHOPIFY_VERSION },
  });
};
let app: Awaited<ReturnType<typeof buildApp>>,
  cookie = '',
  other = '',
  viewer = '',
  adminId = '',
  warehouse = '';
const req = (url: string, method: any = 'GET', payload?: any, auth = cookie) =>
  app.inject({ url: '/api' + url, method, payload, headers: { cookie: auth } });
const ok = async (url: string, method: any = 'GET', payload?: any) => {
  const r = await req(url, method, payload);
  assert(r.statusCode < 300, r.body);
  return r.json();
};
before(async () => {
  await migrate();
  await seed();
  app = await buildApp({ integrationTransport: transport });
  const login = async (email: string) =>
    (await req('/auth/login', 'POST', { email, password: 'DynaDemo!2026' }, '')).headers[
      'set-cookie'
    ]!.toString().split(';')[0];
  cookie = await login('admin@demo.local');
  other = await login('other@demo.local');
  viewer = await login('viewer@demo.local');
  adminId = (await ok('/auth/me')).user.id;
  warehouse = (await ok('/warehouses')).data[0].id;
});
beforeEach(async () => {
  raw = structuredClone(demoShopifyOrder);
  calls = 0;
  hook = undefined;
  await pool.query(
    "UPDATE jobs SET state='done',lease_token=NULL,locked_at=NULL WHERE kind='shopify.webhook'",
  );
});
after(async () => {
  await app.close();
  await pool.end();
});
async function fixture(simulation = false) {
  const id = randomUUID();
  await tenantTx(DEMO_TENANT, (c) =>
    c.query(
      "INSERT INTO channels(id,tenant_id,provider,name,mode,credentials,settings) VALUES($1,$2,'shopify','Webhook QA','sandbox',$3,$4)",
      [
        id,
        DEMO_TENANT,
        encrypt(simulation ? {} : { access_token: 'qa-shopify-read-token-2026' }),
        JSON.stringify({ store_url: store, ...(simulation ? { simulation: true } : {}) }),
      ],
    ),
  );
  await ok(`/integrations/${id}/shopify-webhooks`, 'PATCH', {
    version: 0,
    enabled: true,
    ...(simulation ? {} : { signing_secret: secret }),
  });
  const ch = (await pool.query('SELECT * FROM channels WHERE id=$1', [id])).rows[0],
    cfg = (await pool.query('SELECT * FROM shopify_webhook_configs WHERE channel_id=$1', [id]))
      .rows[0];
  return { id, ch, key: decrypt(cfg.signing_secret).secret, cfg };
}
type F = Awaited<ReturnType<typeof fixture>>;
function delivery(
  f: F,
  body = JSON.stringify({ id: 98001, admin_graphql_api_id: raw.id, note: 'Zażółć gęślą' }),
  extra: Record<string, string> = {},
) {
  return {
    body,
    headers: {
      'content-type': 'application/json',
      'x-shopify-hmac-sha256': createHmac('sha256', f.key).update(body).digest('base64'),
      'x-shopify-shop-domain': shopifyWebhookDomain(f.ch),
      'x-shopify-api-version': SHOPIFY_VERSION,
      'x-shopify-topic': 'orders/updated',
      'x-shopify-webhook-id': randomUUID(),
      'x-shopify-event-id': randomUUID(),
      ...extra,
    },
  };
}
const send = (f: F, d: ReturnType<typeof delivery>) =>
  app.inject({
    method: 'POST',
    url: '/api/webhooks/shopify/' + f.id,
    payload: d.body,
    headers: d.headers,
  });
async function accept(f: F, d = delivery(f)) {
  const r = await send(f, d);
  assert.equal(r.statusCode, 200, r.body);
  return r.json();
}
const history = (f: F) => ok(`/integrations/${f.id}/shopify-webhooks`);
const inbound = (f: F) =>
  tenantTx(
    DEMO_TENANT,
    async (c) => (await c.query('SELECT * FROM inbound_orders WHERE channel_id=$1', [f.id])).rows,
  );
const job = (id: string) =>
  tenantTx(
    DEMO_TENANT,
    async (c) => (await c.query('SELECT * FROM jobs WHERE id=$1', [id])).rows[0],
  );
const claim = (id: string) =>
  tenantTx(
    DEMO_TENANT,
    async (c) =>
      (
        await c.query(
          "UPDATE jobs SET state='running',lease_token=$2,locked_at=now(),attempts=attempts+1 WHERE id=$1 RETURNING *",
          [id, randomUUID()],
        )
      ).rows[0],
  );

test('raw HMAC rejects altered bytes, wrong store, duplicate header values, unsupported topic and version before queueing', async () => {
  const f = await fixture(),
    d = delivery(f);
  for (const [change, status] of [
    [{ body: d.body + ' ' }, 401],
    [{ headers: { ...d.headers, 'x-shopify-hmac-sha256': 'bad' } }, 401],
    [{ headers: { ...d.headers, 'x-shopify-shop-domain': 'another.myshopify.com' } }, 401],
    [
      {
        headers: {
          ...d.headers,
          'x-shopify-hmac-sha256':
            d.headers['x-shopify-hmac-sha256'] + ', ' + d.headers['x-shopify-hmac-sha256'],
        },
      },
      401,
    ],
    [{ headers: { ...d.headers, 'x-shopify-topic': 'app/uninstalled' } }, 422],
    [{ headers: { ...d.headers, 'x-shopify-api-version': '2026-07' } }, 422],
  ] as const)
    assert.equal((await send(f, { ...d, ...change } as any)).statusCode, status);
  assert.equal((await history(f)).deliveries.length, 0);
  assert.equal(calls, 0);
});
test('order/refund numeric IDs above 2^53 retain all digits and mismatched or fractional identifiers fail', () => {
  const literal = '820982911946154508';
  for (const body of [
    '{"id":' + literal + '}',
    '{"id":' + literal + ',"admin_graphql_api_id":"gid://shopify/Order/' + literal + '"}',
  ])
    assert.equal(
      shopifyWebhookOrder(Buffer.from(body), 'orders/create'),
      'gid://shopify/Order/' + literal,
    );
  assert.equal(
    shopifyWebhookOrder(Buffer.from('{"order_id":' + literal + '}'), 'refunds/create'),
    'gid://shopify/Order/' + literal,
  );
  for (const body of [
    '{"id":1.1}',
    '{"id":-1}',
    '{"id":1e30}',
    '{"id":2,"admin_graphql_api_id":"gid://shopify/Order/1"}',
    '[]',
    '{"admin_graphql_api_id":"gid://shopify/Refund/1"}',
  ])
    assert.throws(() => shopifyWebhookOrder(Buffer.from(body), 'orders/create'));
});
test('receipt and job are durable before ACK; retries deduplicate individual IDs and event ID only correlates', async () => {
  const f = await fixture(),
    d = delivery(f),
    first = await accept(f, d),
    again = await accept(f, d);
  assert.equal(first.duplicate, false);
  assert.equal(again.duplicate, true);
  assert.equal(again.job_id, first.job_id);
  assert.equal((await job(first.job_id)).state, 'pending');
  const next = await accept(
    f,
    delivery(f, undefined, { 'x-shopify-event-id': d.headers['x-shopify-event-id'] }),
  );
  assert.notEqual(next.job_id, first.job_id);
  assert.equal((await history(f)).deliveries.length, 2);
  assert.equal(calls, 0);
  const conflict = delivery(f, d.body + ' ', {
    'x-shopify-webhook-id': d.headers['x-shopify-webhook-id'],
    'x-shopify-event-id': d.headers['x-shopify-event-id'],
  });
  assert.equal((await send(f, conflict)).statusCode, 409);
});
test('simultaneous duplicate deliveries allocate one receipt and one job', async () => {
  const f = await fixture(),
    d = delivery(f),
    results = await Promise.all(Array.from({ length: 12 }, () => send(f, d)));
  for (const r of results) assert.equal(r.statusCode, 200, r.body);
  assert.equal(results.filter((r) => !r.json().duplicate).length, 1);
  assert.equal((await history(f)).deliveries.length, 1);
});
test('signed payload prices/status/PII are discarded and fresh GraphQL data are staged without creating OMS', async () => {
  const f = await fixture(),
    accepted = await accept(
      f,
      delivery(
        f,
        JSON.stringify({
          id: 98001,
          status: 'cancelled',
          total_price: '0.01',
          email: 'PRIVATE_WEBHOOK_PII',
          admin_graphql_api_id: raw.id,
        }),
      ),
    );
  const j = await claim(accepted.job_id);
  await processShopifyWebhook(j, { transport });
  assert.equal(calls, 1);
  const rows = await inbound(f);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].normalized.total, 3299);
  assert.equal(rows[0].order_id, null);
  const receipt = (
    await pool.query('SELECT * FROM shopify_webhook_deliveries WHERE id=$1', [accepted.delivery_id])
  ).rows[0];
  assert(!JSON.stringify(receipt).includes('PRIVATE_WEBHOOK_PII'));
  assert(!('payload' in receipt));
  assert.equal(receipt.outcome, 'processed');
  await processShopifyWebhook(j, { transport });
  assert.equal(calls, 1);
  assert.equal((await inbound(f)).length, 1);
});
test('older delayed jobs never replace a newer periodic/manual observation', async () => {
  const f = await fixture(),
    latest = structuredClone(raw);
  latest.updatedAt = '2026-10-05T04:01:00.000Z';
  latest.note = 'newer';
  await ok(`/integrations/${f.id}/stage-orders`, 'POST', { data: [latest] });
  const before = await inbound(f);
  const accepted = await accept(f);
  await processShopifyWebhook(await claim(accepted.job_id), { transport });
  assert.deepEqual(await inbound(f), before);
  assert.equal((await history(f)).deliveries[0].result.observation, 'older_ignored');
});
test('queue limit is enforced atomically under concurrent arrivals and a refused message can be retried', async () => {
  const f = await fixture();
  await tenantTx(DEMO_TENANT, async (c) => {
    for (let n = 0; n < 199; n++)
      await c.query(
        "INSERT INTO jobs(id,tenant_id,kind,payload,dedup_key) VALUES($1,$2,'shopify.webhook',$3,$4)",
        [randomUUID(), DEMO_TENANT, JSON.stringify({ channel_id: f.id }), 'cap-' + randomUUID()],
      );
  });
  const ds = [delivery(f), delivery(f)],
    results = await Promise.all(ds.map((d) => send(f, d)));
  assert.deepEqual(results.map((r) => r.statusCode).sort(), [200, 503]);
  assert.equal((await history(f)).deliveries.length, 1);
  const rejected = ds[results.findIndex((r) => r.statusCode === 503)];
  await pool.query(
    "UPDATE jobs SET state='done' WHERE payload->>'channel_id'=$1 AND NOT payload ? 'delivery_id'",
    [f.id],
  );
  assert.equal((await accept(f, rejected)).duplicate, false);
});
test('OAuth contention refuses a delivery with503 before channel locks and unchanged retry admits it once', async () => {
  const f = await fixture(),
    d = delivery(f),
    blocker = await pool.connect();
  try {
    await blocker.query('BEGIN');
    await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      'shopify-oauth:' + DEMO_TENANT,
    ]);
    const receiving = send(f, d);
    let waiting = false;
    // A deadline, not a poll count: on a loaded runner the receiver reaches the grant lock later than 0.4 s.
    for (const until = Date.now() + 30000; Date.now() < until; ) {
      waiting = (
        await pool.query(
          "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory' AND query LIKE '%pg_advisory_xact_lock_shared%') AS waiting",
        )
      ).rows[0].waiting;
      if (waiting) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert(waiting, 'Receiver must wait on the OAuth grant before locking a channel');
    await blocker.query('SELECT id FROM channels WHERE id=$1 FOR UPDATE NOWAIT', [f.id]);
    const refused = await receiving;
    assert.equal(refused.statusCode, 503, 'Webhook admission must expose retryable backpressure');
    assert.equal(
      (
        await pool.query(
          'SELECT count(*)::int n FROM shopify_webhook_deliveries WHERE channel_id=$1',
          [f.id],
        )
      ).rows[0].n,
      0,
    );
    assert.equal(
      (await pool.query("SELECT count(*)::int n FROM jobs WHERE payload->>'channel_id'=$1", [f.id]))
        .rows[0].n,
      0,
    );
    assert.equal((await inbound(f)).length, 0);
    await blocker.query('COMMIT');
    assert.equal((await accept(f, d)).duplicate, false);
    assert.equal((await accept(f, d)).duplicate, true);
    assert.equal((await history(f)).deliveries.length, 1);
    assert.equal(calls, 0);
  } finally {
    await blocker.query('ROLLBACK');
    blocker.release();
  }
});
test('retry concurrent with the final worker wait returns409 while one worker completes one delivery', async () => {
  const f = await fixture(),
    accepted = await accept(f),
    j = await claim(accepted.job_id),
    blocker = await pool.connect(),
    pending: Promise<unknown>[] = [];
  try {
    await blocker.query('BEGIN');
    const blockerPid = (await blocker.query('SELECT pg_backend_pid() pid')).rows[0].pid;
    // The last pre-HTTP lease fence has completed when this transport hook runs.
    // Hold only the job, forcing finalization to wait with its real SQL locks.
    hook = async () => {
      hook = undefined;
      await blocker.query('SELECT id FROM jobs WHERE id=$1 FOR UPDATE', [j.id]);
    };
    const working = processShopifyWebhook(j, { transport });
    pending.push(working);
    void working.catch(() => {});
    const waitFor = async (sql: string, params: unknown[]) => {
      // A deadline, not a poll count: on a loaded runner the worker reaches the job lock later than 3 s.
      for (const until = Date.now() + 30000; Date.now() < until; ) {
        const row = (await pool.query(sql, params)).rows[0];
        if (row) return row;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.fail('Expected actual PostgreSQL lock wait was not reached');
    };
    const waitingWorker = await waitFor(
      "SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND $1::int=ANY(pg_blocking_pids(pid)) AND query LIKE '%FROM jobs%'",
      [blockerPid],
    );
    const retrying = req(`/shopify-webhook-deliveries/${accepted.delivery_id}/retry`, 'POST', {});
    pending.push(retrying);
    await waitFor(
      "SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND pid<>$2 AND ($1::int=ANY(pg_blocking_pids(pid)) OR $2::int=ANY(pg_blocking_pids(pid))) AND (query LIKE '%shopify_webhook_configs%' OR query LIKE '%FROM jobs%')",
      [blockerPid, waitingWorker.pid],
    );
    await blocker.query('COMMIT');
    await working;
    const rejected = await retrying;
    assert.equal(rejected.statusCode, 409, 'Running/completed delivery cannot be retried');
    const receipt = (await history(f)).deliveries;
    assert.equal(receipt.length, 1);
    assert.equal(receipt[0].id, accepted.delivery_id);
    assert.equal(receipt[0].outcome, 'processed');
    assert.equal((await job(j.id)).state, 'done');
    assert.equal((await inbound(f)).length, 1);
    assert.equal(calls, 1);
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int n FROM audit_events WHERE tenant_id=$1 AND action='shopify.webhook.processed' AND entity_id=$2",
          [DEMO_TENANT, accepted.delivery_id],
        )
      ).rows[0].n,
      1,
    );
    await processShopifyWebhook(j, { transport });
    assert.equal(calls, 1);
    assert.equal((await inbound(f)).length, 1);
  } finally {
    hook = undefined;
    await blocker.query('ROLLBACK');
    blocker.release();
    await Promise.allSettled(pending);
  }
});
test('lost lease before HTTP or during the response cannot stage or complete another worker lease', async () => {
  for (const during of [false, true]) {
    const f = await fixture(),
      accepted = await accept(f),
      j = await claim(accepted.job_id);
    const lose = () =>
      tenantTx(DEMO_TENANT, (c) =>
        c.query('UPDATE jobs SET lease_token=$2 WHERE id=$1', [j.id, randomUUID()]),
      );
    if (during)
      hook = async () => {
        hook = undefined;
        await lose();
      };
    else await lose();
    await processShopifyWebhook(j, { transport });
    assert.equal((await inbound(f)).length, 0);
    assert.equal((await job(j.id)).state, 'running');
  }
});
test('pause/configuration change, role revocation, OAuth pause and changed credentials stop queued and in-flight reads', async () => {
  for (const during of [false, true])
    for (const kind of ['pause', 'role', 'oauth', 'credentials']) {
      const f = await fixture(),
        accepted = await accept(f),
        j = await claim(accepted.job_id),
        beforeCalls = calls;
      const change = () =>
        kind === 'role'
          ? pool.query("UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2", [
              DEMO_TENANT,
              adminId,
            ])
          : kind === 'pause'
            ? pool.query(
                'UPDATE shopify_webhook_configs SET enabled=false,version=version+1 WHERE channel_id=$1',
                [f.id],
              )
            : kind === 'oauth'
              ? pool.query("UPDATE channels SET status='shopify_oauth_pending' WHERE id=$1", [f.id])
              : pool.query('UPDATE channels SET credentials=$2 WHERE id=$1', [
                  f.id,
                  encrypt({ access_token: 'changed-qa-token-2026' }),
                ]);
      if (during)
        hook = async () => {
          hook = undefined;
          await change();
        };
      else await change();
      try {
        await processShopifyWebhook(j, { transport });
      } catch (e) {
        await failShopifyWebhook(j, e);
      }
      assert.equal((await inbound(f)).length, 0);
      assert.equal((await job(j.id)).state, 'done');
      assert.equal(
        (
          await pool.query('SELECT outcome FROM shopify_webhook_deliveries WHERE id=$1', [
            accepted.delivery_id,
          ])
        ).rows[0].outcome,
        'stopped',
      );
      if (!during) assert.equal(calls, beforeCalls);
      await pool.query("UPDATE memberships SET role='admin' WHERE tenant_id=$1 AND user_id=$2", [
        DEMO_TENANT,
        adminId,
      ]);
    }
});
test('worker failures retry with backoff; terminal failures can be retried against current unchanged connection', async () => {
  const f = await fixture(),
    accepted = await accept(f),
    j = await claim(accepted.job_id);
  await failShopifyWebhook(j, Error('PRIVATE_PROVIDER_BODY_AND_SECRET'));
  let current = await job(j.id);
  assert.equal(current.state, 'pending');
  assert(!current.error.includes('PRIVATE'));
  assert(new Date(current.run_at).getTime() > Date.now());
  await pool.query('UPDATE jobs SET attempts=max_attempts-1 WHERE id=$1', [j.id]);
  const last = await claim(j.id);
  await failShopifyWebhook(last, Error('PRIVATE'));
  assert.equal((await job(j.id)).state, 'failed');
  assert.equal((await history(f)).deliveries[0].outcome, 'failed');
  await ok(`/shopify-webhook-deliveries/${accepted.delivery_id}/retry`, 'POST', {});
  await processShopifyWebhook(await claim(j.id), { transport });
  assert.equal((await job(j.id)).state, 'done');
  assert.equal((await history(f)).deliveries[0].outcome, 'processed');
});
test('stopped delivery can resume after reenable but never across a changed token/grant', async () => {
  const f = await fixture(),
    d = delivery(f),
    accepted = await accept(f, d),
    j = await claim(accepted.job_id);
  await ok(`/integrations/${f.id}/shopify-webhooks`, 'PATCH', { version: 1, enabled: false });
  await processShopifyWebhook(j, { transport });
  assert.equal((await send(f, delivery(f))).statusCode, 409);
  assert.equal((await accept(f, d)).duplicate, true);
  await ok(`/integrations/${f.id}/shopify-webhooks`, 'PATCH', { version: 2, enabled: true });
  await ok(`/shopify-webhook-deliveries/${accepted.delivery_id}/retry`, 'POST', {});
  await processShopifyWebhook(await claim(j.id), { transport });
  assert.equal((await inbound(f)).length, 1);
  const failed = await accept(f);
  await pool.query('UPDATE jobs SET max_attempts=1 WHERE id=$1', [failed.job_id]);
  await failShopifyWebhook(await claim(failed.job_id), Error('controlled failure'));
  await pool.query('UPDATE channels SET credentials=$2 WHERE id=$1', [
    f.id,
    encrypt({ access_token: 'new-qa-token-for-reconnect' }),
  ]);
  await ok(`/integrations/${f.id}/shopify-webhooks`, 'PATCH', {
    version: 3,
    enabled: true,
    signing_secret: secret,
  });
  assert.equal(
    (await req(`/shopify-webhook-deliveries/${failed.delivery_id}/retry`, 'POST', {})).statusCode,
    409,
  );
});
test('current admin, CAS version and tenant RLS protect configuration/history/retry; secrets never return', async () => {
  const f = await fixture(),
    accepted = await accept(f);
  for (const [auth, status] of [
    [other, 404],
    [viewer, 403],
  ] as const) {
    assert.equal(
      (await req(`/integrations/${f.id}/shopify-webhooks`, 'GET', undefined, auth)).statusCode,
      status,
    );
    assert.equal(
      (
        await req(
          `/integrations/${f.id}/shopify-webhooks`,
          'PATCH',
          { version: 1, enabled: false },
          auth,
        )
      ).statusCode,
      status,
    );
    assert.equal(
      (await req(`/shopify-webhook-deliveries/${accepted.delivery_id}/retry`, 'POST', {}, auth))
        .statusCode,
      status,
    );
  }
  assert.equal(
    (await req(`/integrations/${f.id}/shopify-webhooks`, 'PATCH', { version: 0, enabled: false }))
      .statusCode,
    409,
  );
  assert(!JSON.stringify(await history(f)).includes(secret));
  assert.equal(
    (
      await tenantTx(SECOND_TENANT, (c) =>
        c.query('SELECT * FROM shopify_webhook_deliveries WHERE id=$1', [accepted.delivery_id]),
      )
    ).rowCount,
    0,
  );
  await assert.rejects(
    tenantTx(DEMO_TENANT, (c) =>
      c.query("UPDATE shopify_webhook_deliveries SET topic='orders/paid' WHERE id=$1", [
        accepted.delivery_id,
      ]),
    ),
    /immutable/,
  );
  await assert.rejects(
    tenantTx(DEMO_TENANT, (c) =>
      c.query('DELETE FROM shopify_webhook_deliveries WHERE id=$1', [accepted.delivery_id]),
    ),
    /permission/,
  );
});
test('simulation secrets differ per channel and full native worker path stages a signed example without provider calls', async () => {
  const f = await fixture(true),
    otherChannel = await fixture(true);
  assert.notEqual(f.key, otherChannel.key);
  const result = await ok(`/integrations/${f.id}/shopify-webhooks/example`, 'POST', {
    kind: 'created',
  });
  assert.equal((await send(otherChannel, delivery(f))).statusCode, 401);
  await pool.query("UPDATE jobs SET run_at='2000-01-01' WHERE id=$1", [result.job_id]);
  assert.equal(await tick({ transport }), true);
  assert.equal((await job(result.job_id)).state, 'done');
  assert.equal((await inbound(f)).length, 1);
  assert.equal(calls, 0);
});
test('simulation callback stages newer source changes only in the buffer after an imported OMS order', async () => {
  const f = await fixture(true);
  const first = await ok(`/integrations/${f.id}/shopify-webhooks/example`, 'POST', {
    kind: 'created',
  });
  await processShopifyWebhook(await claim(first.job_id), { transport });
  const p = await ok('/products', 'POST', {
    sku: 'SW-' + randomUUID(),
    name: 'Webhook QA',
    price: 1500,
    vat: 23,
    warehouse_id: warehouse,
    quantity: 10,
  });
  await ok(`/integrations/${f.id}/mappings`, 'POST', {
    external_id: 'gid://shopify/ProductVariant/701',
    sku: p.sku,
  });
  const source = (await inbound(f))[0],
    order = await ok(`/imports/${source.id}/commit`, 'POST', {
      warehouse_id: warehouse,
      expected_hash: source.source_hash,
    });
  const before = await ok('/orders/' + order.id),
    stock = (await pool.query('SELECT on_hand,reserved FROM stock WHERE product_id=$1', [p.id]))
      .rows;
  const next = await ok(`/integrations/${f.id}/shopify-webhooks/example`, 'POST', {
    kind: 'cancelled',
  });
  await processShopifyWebhook(await claim(next.job_id), { transport });
  assert.deepEqual(await ok('/orders/' + order.id), before);
  assert.deepEqual(
    (await pool.query('SELECT on_hand,reserved FROM stock WHERE product_id=$1', [p.id])).rows,
    stock,
  );
  assert.notEqual((await inbound(f))[0].source_hash, source.source_hash);
  assert.equal(calls, 0);
});
test('read-only preview blocks public receiver and configuration before processing', async () => {
  const f = await fixture(true),
    d = delivery(f),
    preview = await buildApp({ readOnly: true, integrationTransport: transport });
  try {
    for (const [url, method, payload] of [
      [`/webhooks/shopify/${f.id}`, 'POST', d.body],
      [`/integrations/${f.id}/shopify-webhooks`, 'PATCH', { version: 1, enabled: false }],
    ] as const) {
      const r = await preview.inject({ url: '/api' + url, method, payload, headers: d.headers });
      assert.equal(r.statusCode, 423);
    }
    assert.equal(calls, 0);
    assert.equal((await history(f)).deliveries.length, 0);
  } finally {
    await preview.close();
  }
});
test('receiver is absent on a legacy schema without its optional configuration table', async () => {
  const f = await fixture(true);
  await pool.query(
    'ALTER TABLE shopify_webhook_configs RENAME TO shopify_webhook_configs_legacy_test',
  );
  let legacy: Awaited<ReturnType<typeof buildApp>> | undefined;
  try {
    legacy = await buildApp({ integrationTransport: transport });
    const r = await legacy.inject({
      method: 'POST',
      url: '/api/webhooks/shopify/' + randomUUID(),
      payload: { id: 98001 },
    });
    assert.equal(r.statusCode, 404);
    const sync = await legacy.inject({
      url: '/api/integrations/' + f.id + '/sync',
      headers: { cookie },
    });
    assert.equal(sync.statusCode, 200);
    assert.equal(sync.json().shopify_webhooks_available, false);
    assert.equal(
      (await legacy.inject({ url: '/api/health' })).json().shopify_webhooks_available,
      false,
    );
  } finally {
    await legacy?.close();
    await pool.query(
      'ALTER TABLE shopify_webhook_configs_legacy_test RENAME TO shopify_webhook_configs',
    );
  }
});
test('valid HMAC with malformed JSON and missing order ID creates no durable receipt', async () => {
  const f = await fixture();
  assert.equal((await send(f, delivery(f, '{bad'))).statusCode, 400);
  assert.equal((await send(f, delivery(f, '{}'))).statusCode, 422);
  assert.equal((await history(f)).deliveries.length, 0);
});

test('OAuth refuses active jobs, then pauses the receiver and rejects retry of failed deliveries', async () => {
  const f = await fixture();
  await pool.query('UPDATE channels SET credentials=$2 WHERE id=$1', [
    f.id,
    encrypt({
      access_token: 'qa-shopify-read-token-2026',
      client_id: 'qa_client_088',
      client_secret: secret,
    }),
  ]);
  await ok(`/integrations/${f.id}/shopify-webhooks`, 'PATCH', { version: 1, enabled: true });
  const receipt = (await send(f, delivery(f))).json();
  assert.equal(
    (await req(`/integrations/${f.id}/shopify-oauth/start`, 'POST', { confirm_same_account: true }))
      .statusCode,
    409,
  );
  assert.equal((await history(f)).config.enabled, true);
  await pool.query("UPDATE jobs SET state='failed',error='QA terminal failure' WHERE id=$1", [
    receipt.job_id,
  ]);
  await pool.query("UPDATE shopify_webhook_deliveries SET outcome='failed' WHERE job_id=$1", [
    receipt.job_id,
  ]);
  const started = await ok(`/integrations/${f.id}/shopify-oauth/start`, 'POST', {
    confirm_same_account: true,
  });
  assert(started);
  const cfg = (await history(f)).config;
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.version, 3);
  assert.equal(
    (await req(`/shopify-webhook-deliveries/${receipt.delivery_id}/retry`, 'POST', {})).statusCode,
    409,
  );
  assert.equal(calls, 0);
  assert.equal((await inbound(f)).length, 0);
  await ok(`/integrations/${f.id}/shopify-oauth/cancel`, 'POST', {});
});
