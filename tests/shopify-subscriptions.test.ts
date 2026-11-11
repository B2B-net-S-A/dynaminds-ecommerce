import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pool, migrate, tenantTx } from '../server/db';
import { seed, DEMO_TENANT } from './fixtures';
import { buildApp } from '../server/app';
import { encrypt } from '../server/security';
import { Shopify, SHOPIFY_VERSION } from '../server/shopify';
import {
  processShopifySubscription,
  failShopifySubscription,
} from '../server/shopify-subscriptions';
import type { Transport } from '../server/integrations';
assert.equal(process.env.DYNA_TEST, 'true');
const store = 'https://subscriptions-qa.myshopify.com',
  secret = 'qa-webhook-client-secret-2026';
let remote: any[] = [],
  reads = 0,
  writes = 0,
  lost = false,
  rejectWrite = false,
  hook: (() => Promise<void>) | undefined,
  next = 1000,
  appVersion = SHOPIFY_VERSION,
  appClient = 'qa-client-89';
const transport: Transport = async (url, init) => {
  assert.equal(url, store + '/admin/api/' + SHOPIFY_VERSION + '/graphql.json');
  const b = JSON.parse(String(init.body));
  let data: any;
  if (b.query.startsWith('query DynaWebhookSubscriptions')) {
    reads++;
    await hook?.();
    data = {
      app: { id: 'gid://shopify/App/89', apiKey: appClient, webhookApiVersion: appVersion },
      shop: { id: 'gid://shopify/Shop/89', myshopifyDomain: 'subscriptions-qa.myshopify.com' },
      webhookSubscriptions: {
        nodes: structuredClone(remote),
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    };
  } else if (b.query.startsWith('mutation DynaWebhookSubscriptionCreate')) {
    writes++;
    const row = {
      id: 'gid://shopify/WebhookSubscription/' + next++,
      ...b.variables.webhookSubscription,
      topic: b.variables.topic,
      filter: null,
      apiVersion: { handle: SHOPIFY_VERSION },
    };
    if (!rejectWrite) remote.push(row);
    if (lost) throw Error('PRIVATE_PROVIDER_RESPONSE');
    data = {
      webhookSubscriptionCreate: {
        webhookSubscription: rejectWrite ? null : row,
        userErrors: rejectWrite ? [{ field: ['topic'], message: 'PRIVATE_DETAIL' }] : [],
      },
    };
  } else if (b.query.startsWith('mutation DynaWebhookSubscriptionDelete')) {
    writes++;
    remote = remote.filter((r) => r.id !== b.variables.id);
    if (lost) throw Error('PRIVATE_PROVIDER_RESPONSE');
    data = {
      webhookSubscriptionDelete: { deletedWebhookSubscriptionId: b.variables.id, userErrors: [] },
    };
  } else throw Error('Unexpected API operation');
  return new Response(JSON.stringify({ data }), {
    headers: { 'X-Shopify-API-Version': SHOPIFY_VERSION },
  });
};
let app: Awaited<ReturnType<typeof buildApp>>,
  cookie = '',
  other = '',
  viewer = '',
  adminId = '';
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
});
beforeEach(async () => {
  remote = [];
  reads = 0;
  writes = 0;
  lost = false;
  rejectWrite = false;
  appVersion = SHOPIFY_VERSION;
  appClient = 'qa-client-89';
  hook = undefined;
  await pool.query(
    "UPDATE jobs SET state='done',lease_token=NULL,locked_at=NULL WHERE kind='shopify.subscription'",
  );
});
after(async () => {
  await app.close();
  await pool.end();
});
async function fixture(sim = false) {
  const id = randomUUID();
  await tenantTx(DEMO_TENANT, (c) =>
    c.query(
      "INSERT INTO channels(id,tenant_id,provider,name,mode,credentials,settings) VALUES($1,$2,'shopify','Subscriptions QA','sandbox',$3,$4)",
      [
        id,
        DEMO_TENANT,
        encrypt(sim ? {} : { access_token: 'qa-shopify-read-token-2026' }),
        JSON.stringify({ store_url: store, ...(sim ? { simulation: true } : {}) }),
      ],
    ),
  );
  await ok(`/integrations/${id}/shopify-webhooks`, 'PATCH', {
    version: 0,
    enabled: true,
    ...(sim ? {} : { signing_secret: secret }),
  });
  return { id, uri: `https://subscriptions.example.com/api/webhooks/shopify/${id}` };
}
const history = (f: any) => ok(`/integrations/${f.id}/shopify-subscriptions`);
const preview = (f: any, topic = 'ORDERS_CREATE') =>
  ok(`/integrations/${f.id}/shopify-subscriptions/preview`, 'POST', {
    operation: 'create',
    topic,
    uri: f.uri,
  });
const queue = (p: any) =>
  ok(`/shopify-subscription-plans/${p.id}/queue`, 'POST', { external_authorized: true });
async function claim(p: any) {
  return (
    await pool.query(
      "UPDATE jobs SET state='running',attempts=attempts+1,lease_token=$2,locked_at=now() WHERE id=(SELECT job_id FROM shopify_subscription_plans WHERE id=$1) RETURNING *",
      [p.id, randomUUID()],
    )
  ).rows[0];
}
async function execute(p: any) {
  const j = await claim(p);
  try {
    await processShopifySubscription(j, { transport });
  } catch (e) {
    await failShopifySubscription(j, e);
  }
  return (await pool.query('SELECT * FROM shopify_subscription_plans WHERE id=$1', [p.id])).rows[0];
}
function row(id = 20, uri = 'https://other.example.com/hook') {
  return {
    id: 'gid://shopify/WebhookSubscription/' + id,
    topic: 'ORDERS_CREATE',
    uri,
    format: 'JSON',
    filter: null,
    includeFields: ['id', 'admin_graphql_api_id'],
    apiVersion: { handle: SHOPIFY_VERSION },
  };
}
test('GraphQL list paginates completely and checks identity, duplicate IDs and cursor progress', async () => {
  let n = 0;
  const client = new Shopify(
    { store_url: store },
    { access_token: 'qa-shopify-read-token-2026' },
    async (_url, init) => {
      const b = JSON.parse(String(init.body));
      assert.equal(b.variables.after, n === 0 ? null : 'cursor-1');
      n++;
      return new Response(
        JSON.stringify({
          data: {
            app: { id: 'gid://shopify/App/89', apiKey: appClient, webhookApiVersion: appVersion },
            shop: {
              id: 'gid://shopify/Shop/89',
              myshopifyDomain: 'subscriptions-qa.myshopify.com',
            },
            webhookSubscriptions: {
              nodes: [row(n)],
              pageInfo: { hasNextPage: n === 1, endCursor: n === 1 ? 'cursor-1' : null },
            },
          },
        }),
        { headers: { 'X-Shopify-API-Version': SHOPIFY_VERSION } },
      );
    },
  );
  assert.equal((await client.subscriptions(undefined, 'gid://shopify/Shop/89')).length, 2);
  assert.equal(n, 2);
  const duplicate = new Shopify(
    { store_url: store },
    { access_token: 'qa-shopify-read-token-2026' },
    async () =>
      new Response(
        JSON.stringify({
          data: {
            app: { id: 'gid://shopify/App/89', apiKey: appClient, webhookApiVersion: appVersion },
            shop: {
              id: 'gid://shopify/Shop/89',
              myshopifyDomain: 'subscriptions-qa.myshopify.com',
            },
            webhookSubscriptions: {
              nodes: [row()],
              pageInfo: { hasNextPage: true, endCursor: 'same' },
            },
          },
        }),
        { headers: { 'X-Shopify-API-Version': SHOPIFY_VERSION } },
      ),
  );
  await assert.rejects(duplicate.subscriptions(), /Powtórzone/);
  await assert.rejects(
    new Shopify(
      { store_url: store },
      { access_token: 'qa-shopify-read-token-2026' },
      transport,
    ).subscriptions(undefined, 'gid://shopify/Shop/99'),
    /innego sklepu/,
  );
});
test('create uses minimal fields, one mutation and GET verification; replay queues no extra job', async () => {
  const f = await fixture(),
    p = await preview(f);
  assert.equal(writes, 0);
  assert.deepEqual(p.spec.webhookSubscription.includeFields, ['id', 'admin_graphql_api_id']);
  await queue(p);
  const done = await execute(p);
  assert.equal(done.state, 'done');
  assert.equal(done.phase, 'done');
  assert.equal(writes, 1);
  assert.equal(reads, 3);
  await queue(p);
  assert.equal(writes, 1);
  assert.equal((await history(f)).plans[0].snapshot, undefined);
  assert.equal(
    (
      await req(`/integrations/${f.id}/shopify-subscriptions/preview`, 'POST', {
        operation: 'create',
        topic: 'ORDERS_CREATE',
        uri: f.uri,
      })
    ).statusCode,
    409,
  );
});
test('refund topic requests order_id and receiver URI must match the channel without params or private hosts', async () => {
  const f = await fixture(),
    p = await preview(f, 'REFUNDS_CREATE');
  assert.deepEqual(p.spec.webhookSubscription.includeFields, ['id', 'order_id']);
  for (const uri of [
    'http://example.com' + `/api/webhooks/shopify/${f.id}`,
    'https://127.0.0.1' + `/api/webhooks/shopify/${f.id}`,
    f.uri + '?key=private',
    f.uri + '#fragment',
    f.uri.replace(f.id, randomUUID()),
    'https://local-example.invalid' + `/api/webhooks/shopify/${f.id}`,
  ])
    assert.equal(
      (
        await req(`/integrations/${f.id}/shopify-subscriptions/preview`, 'POST', {
          operation: 'create',
          topic: 'ORDERS_CREATE',
          uri,
        })
      ).statusCode,
      422,
    );
});
test('external write approval is mandatory and pending plans serialize mutations per channel', async () => {
  const f = await fixture(),
    p = await preview(f),
    p2 = await preview(f, 'ORDERS_PAID');
  assert.equal(
    (await req(`/shopify-subscription-plans/${p.id}/queue`, 'POST', {})).statusCode,
    422,
  );
  await queue(p);
  assert.equal(
    (await req(`/shopify-subscription-plans/${p2.id}/queue`, 'POST', { external_authorized: true }))
      .statusCode,
    409,
  );
  assert.equal(writes, 0);
});
test('stale snapshot, expired preview and paused receiver prevent a write', async () => {
  for (const kind of ['snapshot', 'expired', 'pause']) {
    const f = await fixture(),
      p = await preview(f);
    await queue(p);
    if (kind === 'snapshot') remote.push(row());
    else if (kind === 'expired')
      await pool
        .query(
          "UPDATE shopify_subscription_plans SET expires_at=now()-interval '1 minute' WHERE id=$1",
          [p.id],
        )
        .catch(async () => {
          await pool.query(
            'ALTER TABLE shopify_subscription_plans DISABLE TRIGGER shopify_subscription_plan_immutable',
          );
          try {
            await pool.query(
              "UPDATE shopify_subscription_plans SET expires_at=now()-interval '1 minute' WHERE id=$1",
              [p.id],
            );
          } finally {
            await pool.query(
              'ALTER TABLE shopify_subscription_plans ENABLE TRIGGER shopify_subscription_plan_immutable',
            );
          }
        });
    else
      await ok(`/integrations/${f.id}/shopify-webhooks`, 'PATCH', { version: 1, enabled: false });
    const before = writes,
      result = await execute(p);
    assert.equal(result.state, 'failed');
    assert.equal(result.phase, 'fresh');
    assert.equal(writes, before);
    remote = [];
  }
});
test('lost create response is uncertain, automatic reexecution never writes again, reconciliation works after receiver pause', async () => {
  const f = await fixture(),
    p = await preview(f);
  await queue(p);
  lost = true;
  const uncertain = await execute(p);
  assert.equal(uncertain.state, 'uncertain');
  assert.equal(uncertain.phase, 'attempted');
  assert(!uncertain.error.includes('PRIVATE'));
  assert.equal(writes, 1);
  assert.equal(
    (await req(`/shopify-subscription-plans/${p.id}/queue`, 'POST', { external_authorized: true }))
      .statusCode,
    409,
  );
  lost = false;
  await ok(`/integrations/${f.id}/shopify-webhooks`, 'PATCH', { version: 1, enabled: false });
  await ok(`/shopify-subscription-plans/${p.id}/reconcile`, 'POST', {});
  assert.equal(writes, 1);
  assert.equal((await history(f)).plans[0].state, 'done');
});
test('reacquired lease after attempted marker only reads and ambiguous added matches stay uncertain', async () => {
  const f = await fixture(),
    p = await preview(f);
  await queue(p);
  lost = true;
  await execute(p);
  lost = false;
  await pool.query("UPDATE shopify_subscription_plans SET state='queued' WHERE id=$1", [p.id]);
  const done = await execute(p);
  assert.equal(done.state, 'done');
  assert.equal(writes, 1);
  const f2 = await fixture(),
    p2 = await preview(f2);
  await queue(p2);
  lost = true;
  await execute(p2);
  lost = false;
  remote.push({ ...remote.at(-1), id: 'gid://shopify/WebhookSubscription/888' });
  assert.equal(
    (await req(`/shopify-subscription-plans/${p2.id}/reconcile`, 'POST', {})).statusCode,
    409,
  );
  assert.equal((await history(f2)).plans[0].state, 'uncertain');
});
test('delete needs creation ownership and exact current record; uncertain deletion resolves by absence', async () => {
  const f = await fixture();
  remote = [row()];
  assert.equal(
    (
      await req(`/integrations/${f.id}/shopify-subscriptions/preview`, 'POST', {
        operation: 'delete',
        remote_id: remote[0].id,
      })
    ).statusCode,
    409,
  );
  remote = [];
  const p = await preview(f);
  await queue(p);
  const made = await execute(p);
  const remove = await ok(`/integrations/${f.id}/shopify-subscriptions/preview`, 'POST', {
    operation: 'delete',
    remote_id: made.result.remote_id,
  });
  await queue(remove);
  lost = true;
  const uncertain = await execute(remove);
  assert.equal(uncertain.state, 'uncertain');
  assert.equal(remote.length, 0);
  lost = false;
  await ok(`/shopify-subscription-plans/${remove.id}/reconcile`, 'POST', {});
  assert.equal(writes, 2);
  assert.equal((await history(f)).plans[0].state, 'done');
});
test('tenant/admin/immutable plan/attempt marker and no DELETE protect subscription records', async () => {
  const f = await fixture(),
    p = await preview(f);
  assert.equal(
    (await req(`/integrations/${f.id}/shopify-subscriptions`, 'GET', undefined, other)).statusCode,
    404,
  );
  assert.equal(
    (await req(`/integrations/${f.id}/shopify-subscriptions/read`, 'POST', {}, viewer)).statusCode,
    403,
  );
  assert.equal(
    (await req(`/shopify-subscription-plans/${p.id}/queue`, 'POST', {}, other)).statusCode,
    404,
  );
  await assert.rejects(
    tenantTx(DEMO_TENANT, (c) =>
      c.query("UPDATE shopify_subscription_plans SET spec='{}' WHERE id=$1", [p.id]),
    ),
    /immutable/,
  );
  await assert.rejects(
    tenantTx(DEMO_TENANT, (c) =>
      c.query('DELETE FROM shopify_subscription_plans WHERE id=$1', [p.id]),
    ),
    /permission/,
  );
});
test('role revocation and lost lease during read cannot write or complete a different lease', async () => {
  for (const kind of ['role', 'lease']) {
    const f = await fixture(),
      p = await preview(f);
    await queue(p);
    const j = await claim(p);
    let fired = false;
    hook = async () => {
      if (fired) return;
      fired = true;
      if (kind === 'role')
        await pool.query("UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2", [
          DEMO_TENANT,
          adminId,
        ]);
      else await pool.query('UPDATE jobs SET lease_token=$2 WHERE id=$1', [j.id, randomUUID()]);
    };
    try {
      await processShopifySubscription(j, { transport });
    } catch (e) {
      await failShopifySubscription(j, e);
    }
    assert.equal(writes, 0);
    await pool.query("UPDATE memberships SET role='admin' WHERE tenant_id=$1 AND user_id=$2", [
      DEMO_TENANT,
      adminId,
    ]);
    hook = undefined;
  }
});
test('local simulation creates and deletes through the worker without provider calls and leaves other data untouched', async () => {
  const f = await fixture(true);
  f.uri = `https://local-example.invalid/api/webhooks/shopify/${f.id}`;
  const p = await preview(f);
  await queue(p);
  const made = await execute(p);
  assert.equal(made.state, 'done');
  const remove = await ok(`/integrations/${f.id}/shopify-subscriptions/preview`, 'POST', {
    operation: 'delete',
    remote_id: made.result.remote_id,
  });
  await queue(remove);
  assert.equal((await execute(remove)).state, 'done');
  assert.equal(reads, 0);
  assert.equal(writes, 0);
  assert.equal((await history(f)).observation.data.length, 0);
});
test('read-only preview blocks subscription reads/registration/reconciliation before transport', async () => {
  const f = await fixture(),
    p = await preview(f),
    previewApp = await buildApp({ readOnly: true, integrationTransport: transport });
  const before = reads;
  try {
    for (const path of [
      `/integrations/${f.id}/shopify-subscriptions/read`,
      `/integrations/${f.id}/shopify-subscriptions/preview`,
      `/shopify-subscription-plans/${p.id}/queue`,
      `/shopify-subscription-plans/${p.id}/cancel`,
      `/shopify-subscription-plans/${p.id}/reconcile`,
    ])
      assert.equal(
        (
          await previewApp.inject({
            url: '/api' + path,
            method: 'POST',
            payload: {},
            headers: { cookie },
          })
        ).statusCode,
        423,
      );
    assert.equal(reads, before);
    assert.equal(writes, 0);
  } finally {
    await previewApp.close();
  }
});

test('changed owned subscription cannot be deleted and ownership is available beyond the history window', async () => {
  const f = await fixture(),
    p = await preview(f);
  await queue(p);
  const made = await execute(p);
  for (let n = 0; n < 31; n++) await preview(f, 'ORDERS_UPDATED');
  await ok(`/integrations/${f.id}/shopify-subscriptions/read`, 'POST', {});
  assert.equal((await history(f)).plans.length, 30);
  assert(!(await history(f)).plans.some((r: any) => r.id === p.id));
  assert.equal((await history(f)).observation.data[0].managed_by_channel, true);
  remote[0].uri = 'https://someone-else.example.com/changed';
  assert.equal(
    (
      await req(`/integrations/${f.id}/shopify-subscriptions/preview`, 'POST', {
        operation: 'delete',
        remote_id: made.result.remote_id,
      })
    ).statusCode,
    409,
  );
});
test('mutation failures never retry HTTP and provider error details are not surfaced', async () => {
  let calls = 0;
  const client = new Shopify(
    { store_url: store },
    { access_token: 'qa-shopify-read-token-2026' },
    async () => {
      calls++;
      return new Response('PRIVATE', { status: 500 });
    },
    async () => {},
  );
  await assert.rejects(
    client.createSubscription({
      topic: 'ORDERS_CREATE',
      webhookSubscription: {
        uri: 'https://subscriptions.example.com/hook',
        format: 'JSON',
        includeFields: ['id', 'admin_graphql_api_id'],
      },
    }),
    /HTTP 500/,
  );
  assert.equal(calls, 1);
  await assert.rejects(
    client.deleteSubscription('gid://shopify/WebhookSubscription/1'),
    /HTTP 500/,
  );
  assert.equal(calls, 2);
  const f = await fixture(),
    p = await preview(f);
  await queue(p);
  rejectWrite = true;
  const result = await execute(p);
  assert(!result.error.includes('PRIVATE'));
  assert.equal(writes, 1);
});
test('unfinished plans can be cancelled after a configuration change and completed queue replay is read-only', async () => {
  const f = await fixture(),
    p = await preview(f);
  await ok(`/integrations/${f.id}/shopify-webhooks`, 'PATCH', { version: 1, enabled: false });
  await ok(`/shopify-subscription-plans/${p.id}/cancel`, 'POST', {});
  assert.equal((await history(f)).plans[0].state, 'cancelled');
  await ok(`/integrations/${f.id}/shopify-webhooks`, 'PATCH', { version: 2, enabled: true });
  const next = await preview(f);
  await queue(next);
  await execute(next);
  await ok(`/integrations/${f.id}/shopify-webhooks`, 'PATCH', { version: 3, enabled: false });
  await queue(next);
  assert.equal(writes, 1);
});

test('application webhook version is checked before preview and again before first write; old-version reads stay available', async () => {
  const f = await fixture();
  appVersion = '2026-07';
  assert.equal(
    (
      await req(`/integrations/${f.id}/shopify-subscriptions/preview`, 'POST', {
        operation: 'create',
        topic: 'ORDERS_CREATE',
        uri: f.uri,
      })
    ).statusCode,
    409,
  );
  assert.equal(
    (await req(`/integrations/${f.id}/shopify-subscriptions/read`, 'POST', {})).statusCode,
    200,
  );
  assert.equal(writes, 0);
  appVersion = SHOPIFY_VERSION;
  const p = await preview(f);
  await queue(p);
  appVersion = '2026-07';
  const failed = await execute(p);
  assert.equal(failed.state, 'failed');
  assert.equal(failed.phase, 'fresh');
  assert.equal(failed.attempted_at, null);
  assert.equal(writes, 0);
});
test('known OAuth client cannot inspect subscriptions with a token belonging to another app', async () => {
  const client = new Shopify(
    { store_url: store },
    { access_token: 'qa-shopify-read-token-2026', client_id: 'expected-client' },
    transport,
  );
  await assert.rejects(client.subscriptions(), /innej aplikacji/);
  assert.equal(writes, 0);
});
