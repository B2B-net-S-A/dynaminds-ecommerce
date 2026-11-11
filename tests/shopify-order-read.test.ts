import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { Shopify, SHOPIFY_VERSION } from '../server/shopify';
import { demoShopifyOrder } from '../server/shopify-example';
import { buildApp } from '../server/app';
import { pool, migrate, tenantTx } from '../server/db';
import { seed, DEMO_TENANT } from './fixtures';
import { encrypt } from '../server/security';
import { importSourceHash, shopifyOrderHash, importOrder } from '../server/imports';
import type { Transport } from '../server/integrations';

assert.equal(process.env.DYNA_TEST, 'true');
const settings = { store_url: 'https://order-read-qa.myshopify.com' };
const credentials = { access_token: 'qa-controlled-shopify-order-read-token' };
const fixture = (id = 98701, time = '2026-10-05T04:00:00.000Z'): any => ({
  ...structuredClone(demoShopifyOrder),
  id: 'gid://shopify/Order/' + id,
  updatedAt: time,
});
const response = (data: any) =>
  new Response(JSON.stringify({ data }), {
    headers: { 'X-Shopify-API-Version': SHOPIFY_VERSION },
  });
const page = (nodes: any[], size: number, cursor: string | null, prefix: string) => {
  const start = cursor ? Number(cursor.split(':').at(-1)) : 0;
  return {
    nodes: structuredClone(nodes.slice(start, start + size)),
    pageInfo: {
      hasNextPage: start + size < nodes.length,
      endCursor: nodes.length ? prefix + ':' + Math.min(start + size, nodes.length) : null,
    },
  };
};
let remote: any = fixture(),
  calls: string[] = [],
  hook: ((name: string, data: any) => Promise<void>) | undefined;
const transport: Transport = async (url, init) => {
  assert.equal(url, settings.store_url + '/admin/api/' + SHOPIFY_VERSION + '/graphql.json');
  const body = JSON.parse(String(init.body)),
    name = body.query.match(/^query (\w+)/)?.[1];
  assert.ok(name, 'Only GraphQL reads are allowed');
  calls.push(name);
  const shop = { id: 'gid://shopify/Shop/87', myshopifyDomain: 'order-read-qa.myshopify.com' };
  const raw = remote ? structuredClone(remote) : null;
  if (raw && ['DynaOrder', 'DynaOrders'].includes(name)) {
    raw.lineItems = page(raw.lineItems.nodes, 10, null, 'lines');
    raw.shippingLines = page(raw.shippingLines.nodes, 5, null, 'shipping');
  }
  let data: any;
  if (name === 'DynaOrder') data = { shop, order: raw };
  else if (name === 'DynaOrders')
    data = {
      orders: {
        nodes: raw ? [raw] : [],
        pageInfo: { hasNextPage: false, endCursor: raw ? 'orders:1' : null },
      },
    };
  else {
    const field = name === 'DynaLines' ? 'lineItems' : 'shippingLines';
    data = {
      order: remote
        ? {
            id: remote.id,
            updatedAt: remote.updatedAt,
            [field]: page(remote[field].nodes, 20, body.variables.after, field),
          }
        : null,
    };
  }
  await hook?.(name, data);
  return response(data);
};
let app: FastifyInstance,
  cookie: string,
  other: string,
  viewer: string,
  warehouse: string,
  adminId: string;
const req = (url: string, method: any = 'GET', payload?: any, session = cookie) =>
  app.inject({ url: '/api' + url, method, payload, headers: { cookie: session } });
const ok = async (url: string, method: any = 'GET', payload?: any) => {
  const r = await req(url, method, payload);
  assert.ok(r.statusCode >= 200 && r.statusCode < 300, r.body);
  return r.json();
};
before(async () => {
  await migrate();
  await seed();
  app = await buildApp({ integrationTransport: transport });
  const login = async (email: string) =>
    (
      await app.inject({
        url: '/api/auth/login',
        method: 'POST',
        payload: { email, password: 'DynaDemo!2026' },
      })
    ).headers['set-cookie']!.toString().split(';')[0];
  cookie = await login('admin@demo.local');
  other = await login('other@demo.local');
  viewer = await login('viewer@demo.local');
  warehouse = (await ok('/warehouses')).data[0].id;
  adminId = (await pool.query("SELECT id FROM users WHERE email='admin@demo.local'")).rows[0].id;
});
after(async () => {
  await app.close();
  await pool.end();
});
async function channel(simulation = false) {
  const id = randomUUID();
  await tenantTx(DEMO_TENANT, (c) =>
    c.query(
      "INSERT INTO channels(id,tenant_id,provider,name,mode,credentials,settings) VALUES($1,$2,'shopify','Order read QA','sandbox',$3,$4)",
      [
        id,
        DEMO_TENANT,
        encrypt(simulation ? {} : credentials),
        JSON.stringify({ ...settings, ...(simulation ? { simulation: true } : {}) }),
      ],
    ),
  );
  return id;
}
const stage = async (id: string, raw: any) =>
  (await ok('/integrations/' + id + '/stage-orders', 'POST', { data: [raw] })).data[0];
const rows = async (ch: string) => (await ok('/integrations/' + ch + '/imports')).data;
const stored = (id: string) =>
  tenantTx(
    DEMO_TENANT,
    async (c) => (await c.query('SELECT * FROM inbound_orders WHERE id=$1', [id])).rows[0],
  );
const commit = (source: any) =>
  req('/imports/' + source.id + '/commit', 'POST', {
    warehouse_id: warehouse,
    expected_hash: source.source_hash,
  });
async function product(ch: string) {
  const sku = 'SHOPIFY-READ-' + randomUUID().slice(0, 8);
  const p = await ok('/products', 'POST', {
    sku,
    name: 'Read QA',
    price: 9900,
    vat: 23,
    warehouse_id: warehouse,
    quantity: 10,
  });
  await ok('/integrations/' + ch + '/mappings', 'POST', {
    external_id: 'gid://shopify/ProductVariant/701',
    sku,
  });
  return p;
}
const stock = (id: string) =>
  tenantTx(
    DEMO_TENANT,
    async (c) =>
      (await c.query('SELECT on_hand,reserved FROM stock WHERE product_id=$1', [id])).rows[0],
  );

test('singular read hydrates both connections and checks the bound shop ID', async () => {
  remote = fixture();
  calls = [];
  remote.lineItems.nodes = Array.from({ length: 31 }, (_, i) => ({
    ...structuredClone(remote.lineItems.nodes[0]),
    id: 'gid://shopify/LineItem/' + (100 + i),
  }));
  remote.shippingLines.nodes = Array.from({ length: 6 }, (_, i) => ({
    ...structuredClone(remote.shippingLines.nodes[0]),
    id: 'gid://shopify/ShippingLine/' + (100 + i),
  }));
  let fences = 0;
  const result = await new Shopify(settings, credentials, transport).order(
    remote.id,
    async () => {
      fences++;
    },
    'gid://shopify/Shop/87',
  );
  assert.equal(result.lineItems.nodes.length, 31);
  assert.equal(result.shippingLines.nodes.length, 6);
  assert.deepEqual(calls, ['DynaOrder', 'DynaLines', 'DynaLines', 'DynaShipping']);
  assert.equal(fences, 4);
  await assert.rejects(
    new Shopify(settings, credentials, transport).order(
      remote.id,
      undefined,
      'gid://shopify/Shop/88',
    ),
    /inne konto/,
  );
});
test('singular read rejects invalid IDs before HTTP and missing or foreign orders', async () => {
  calls = [];
  remote = fixture();
  await assert.rejects(
    new Shopify(settings, credentials, transport).order('98701'),
    /identyfikator/,
  );
  assert.equal(calls.length, 0);
  await assert.rejects(
    new Shopify(settings, credentials, transport).order('gid://shopify/Order/98702'),
    /inne zamówienie/,
  );
  remote = null;
  await assert.rejects(
    new Shopify(settings, credentials, transport).order('gid://shopify/Order/98701'),
    /nie udostępnia/,
  );
});
test('singular read rejects wrong store, missing timestamp and partial or duplicate connections', async () => {
  for (const mutate of [
    (d: any) => {
      d.shop.myshopifyDomain = 'other.myshopify.com';
    },
    (d: any) => {
      delete d.order.updatedAt;
    },
    (d: any) => {
      delete d.order.lineItems.pageInfo;
    },
    (d: any) => {
      d.order.lineItems.nodes.push(d.order.lineItems.nodes[0]);
    },
    (d: any) => {
      d.order.shippingLines.pageInfo = { hasNextPage: true, endCursor: null };
    },
  ]) {
    remote = fixture();
    hook = async (_name, data) => mutate(data);
    try {
      await assert.rejects(new Shopify(settings, credentials, transport).order(remote.id));
    } finally {
      hook = undefined;
    }
  }
});
test('singular read aborts when the order changes during pagination or a fence is lost', async () => {
  remote = fixture();
  remote.lineItems.nodes = Array.from({ length: 11 }, (_, i) => ({
    ...structuredClone(remote.lineItems.nodes[0]),
    id: 'gid://shopify/LineItem/' + (100 + i),
  }));
  hook = async (name, data) => {
    if (name === 'DynaLines') data.order.updatedAt = '2026-10-05T04:01:00.000Z';
  };
  try {
    await assert.rejects(
      new Shopify(settings, credentials, transport).order(remote.id),
      /zmieniło/,
    );
  } finally {
    hook = undefined;
  }
  calls = [];
  let fences = 0;
  await assert.rejects(
    new Shopify(settings, credentials, transport).order(remote.id, async () => {
      if (++fences === 2) throw Error('lost lease');
    }),
    /lost lease/,
  );
  assert.deepEqual(calls, ['DynaOrder']);
});
test('Shopify observations preserve newer data and do not modify a row on exact replay', async () => {
  const ch = await channel(),
    latest = fixture();
  latest.note = 'newest';
  const s = await stage(ch, latest),
    before = await stored(s.id),
    old = fixture(98701, '2026-10-05T03:59:00.000Z');
  assert.equal((await stage(ch, old)).observation, 'older_ignored');
  const repeat = structuredClone(latest);
  repeat.lineItems.pageInfo.endCursor = 'different-transport-cursor';
  repeat.updatedAt = '2026-10-05T04:00:00Z';
  assert.equal((await stage(ch, repeat)).observation, 'unchanged');
  assert.deepEqual(await stored(s.id), before);
});
test('same timestamp with different data rolls back the whole batch; missing timestamp cannot overwrite valid data', async () => {
  const ch = await channel(),
    s = await stage(ch, fixture()),
    before = await stored(s.id);
  const conflict = fixture();
  conflict.note = 'conflicting same version';
  const r = await req('/integrations/' + ch + '/stage-orders', 'POST', {
    data: [fixture(98702), conflict],
  });
  assert.equal(r.statusCode, 409);
  assert.equal((await rows(ch)).length, 1);
  assert.deepEqual(await stored(s.id), before);
  delete conflict.updatedAt;
  assert.equal(
    (await req('/integrations/' + ch + '/stage-orders', 'POST', { data: [conflict] })).statusCode,
    422,
  );
  assert.deepEqual(await stored(s.id), before);
  const invalid = fixture(98703, '2026-02-30T04:00:00Z');
  assert.equal((await stage(ch, invalid)).state, 'error');
});
test('concurrent first observations converge on newest version and reversed batches do not deadlock', async () => {
  const ch = await channel();
  const observations = Array.from({ length: 8 }, (_, i) =>
    fixture(98701, '2026-10-05T04:00:0' + i + '.000Z'),
  );
  await Promise.all(observations.reverse().map((raw) => stage(ch, raw)));
  const all = await rows(ch);
  assert.equal(all.length, 1);
  assert.equal((await stored(all[0].id)).raw.updatedAt, '2026-10-05T04:00:07.000Z');
  const a = fixture(98710),
    b = fixture(98711);
  const results = await Promise.all(
    [
      [a, b],
      [b, a],
    ].map((data) => req('/integrations/' + ch + '/stage-orders', 'POST', { data })),
  );
  for (const result of results) assert.equal(result.statusCode, 200, result.body);
  assert.equal((await rows(ch)).length, 3);
});
test('legacy source hashes replay without rewriting imported or frozen fingerprints', async () => {
  const ch = await channel(),
    raw = fixture(),
    s = await stage(ch, raw);
  const legacy = importSourceHash(raw);
  await tenantTx(DEMO_TENANT, (c) =>
    c.query('UPDATE inbound_orders SET source_hash=$2 WHERE id=$1', [s.id, legacy]),
  );
  const before = await stored(s.id);
  assert.equal((await stage(ch, raw)).source_hash, legacy);
  assert.deepEqual(await stored(s.id), before);
  assert.notEqual(legacy, shopifyOrderHash(raw));
});
test('fresh import needs the approved hash, checks current API data and reserves exactly once', async () => {
  remote = fixture();
  calls = [];
  const ch = await channel(),
    p = await product(ch),
    s = await stage(ch, remote);
  assert.equal(
    (await req('/imports/' + s.id + '/commit', 'POST', { warehouse_id: warehouse })).statusCode,
    422,
  );
  assert.equal(calls.length, 0);
  const result = await commit(s);
  assert.equal(result.statusCode, 200, result.body);
  assert.equal(result.json().total, 3299);
  assert.deepEqual(calls, ['DynaOrder']);
  assert.equal((await stock(p.id)).reserved, 2);
  calls = [];
  remote = null;
  const replay = await commit(s);
  assert.equal(replay.statusCode, 200, replay.body);
  assert.equal(replay.json().id, result.json().id);
  assert.equal(calls.length, 0);
  assert.equal((await stock(p.id)).reserved, 2);
});
test('provider change refreshes the buffer and requires a second approval before any reservation', async () => {
  remote = fixture();
  const ch = await channel(),
    p = await product(ch),
    s = await stage(ch, remote);
  remote.note = 'source changed';
  remote.updatedAt = '2026-10-05T04:01:00.000Z';
  assert.equal((await commit(s)).statusCode, 409);
  assert.equal((await stock(p.id)).reserved, 0);
  const latest = (await rows(ch))[0];
  assert.notEqual(latest.source_hash, s.source_hash);
  assert.equal((await commit(s)).statusCode, 409);
  assert.equal((await commit(latest)).statusCode, 200);
  assert.equal((await stock(p.id)).reserved, 2);
});
test('older or conflicting API snapshots cannot authorize an import from stale data', async () => {
  for (const kind of ['older', 'conflicting', 'missing']) {
    remote = fixture();
    const ch = await channel(),
      p = await product(ch),
      s = await stage(ch, remote),
      before = await stored(s.id);
    if (kind === 'older') remote.updatedAt = '2026-10-05T03:59:00.000Z';
    if (kind === 'conflicting') remote.note = 'conflict';
    if (kind === 'missing') remote = null;
    assert.equal((await commit(s)).statusCode, kind === 'missing' ? 404 : 409);
    assert.equal((await stock(p.id)).reserved, 0);
    assert.deepEqual(await stored(s.id), before);
  }
});
test('point refresh persists newer source but leaves existing OMS, payment and stock untouched', async () => {
  remote = fixture();
  const ch = await channel(),
    p = await product(ch),
    s = await stage(ch, remote),
    imported = await commit(s);
  assert.equal(imported.statusCode, 200, imported.body);
  const id = imported.json().id,
    before = await ok('/orders/' + id),
    stockBefore = await stock(p.id);
  remote.cancelledAt = '2026-10-05T04:01:00.000Z';
  remote.updatedAt = remote.cancelledAt;
  const refresh = await ok('/integrations/' + ch + '/fetch-order', 'POST', {
    external_id: remote.id,
  });
  assert.equal(refresh.scope, 'external_read_local_write');
  const latest = (await rows(ch))[0];
  assert.equal(latest.source_changed, true);
  assert.equal(latest.state, 'imported');
  assert.deepEqual(await ok('/orders/' + id), before);
  assert.deepEqual(await stock(p.id), stockBefore);
  assert.equal((await commit(latest)).statusCode, 409);
});
test('point refresh enforces tenant, viewer and strictly validated inputs before HTTP', async () => {
  remote = fixture();
  const ch = await channel();
  calls = [];
  for (const [session, status] of [
    [other, 404],
    [viewer, 403],
  ] as const)
    assert.equal(
      (
        await req(
          '/integrations/' + ch + '/fetch-order',
          'POST',
          { external_id: remote.id },
          session,
        )
      ).statusCode,
      status,
    );
  for (const payload of [
    { external_id: '98701' },
    { external_id: remote.id, url: 'https://evil.test' },
  ])
    assert.equal(
      (await req('/integrations/' + ch + '/fetch-order', 'POST', payload)).statusCode,
      422,
    );
  assert.equal(calls.length, 0);
});
test('role revocation, changed connection and OAuth pause during HTTP cannot commit a page or import', async () => {
  for (const operation of ['fetch-order', 'fetch-orders', 'commit'])
    for (const kind of ['role', 'connection', 'oauth']) {
      remote = fixture();
      const ch = await channel(),
        p = await product(ch),
        s = await stage(ch, remote),
        before = await stored(s.id);
      hook = async () => {
        hook = undefined;
        if (kind === 'role')
          await pool.query(
            "UPDATE memberships SET role='viewer' WHERE user_id=$1 AND tenant_id=$2",
            [adminId, DEMO_TENANT],
          );
        else
          await tenantTx(DEMO_TENANT, (c) =>
            kind === 'connection'
              ? c.query(
                  'UPDATE channels SET settings=settings||\'{"changed":true}\'::jsonb WHERE id=$1',
                  [ch],
                )
              : c.query("UPDATE channels SET status='shopify_oauth_pending' WHERE id=$1", [ch]),
          );
      };
      try {
        const r =
          operation === 'commit'
            ? await commit(s)
            : await req(
                '/integrations/' + ch + '/' + operation,
                'POST',
                operation === 'fetch-order' ? { external_id: remote.id } : {},
              );
        assert.equal(r.statusCode, kind === 'role' ? 403 : 409, r.body);
        assert.deepEqual(await stored(s.id), before);
        assert.equal((await stock(p.id)).reserved, 0);
      } finally {
        hook = undefined;
        await pool.query("UPDATE memberships SET role='admin' WHERE user_id=$1 AND tenant_id=$2", [
          adminId,
          DEMO_TENANT,
        ]);
      }
    }
});
test('direct import helper cannot bypass Shopify connection approval', async () => {
  const ch = await channel(true),
    p = await product(ch),
    s = await stage(ch, fixture());
  await assert.rejects(
    importOrder(
      { tenantId: DEMO_TENANT, userId: adminId, role: 'admin' },
      s.id,
      warehouse,
      s.source_hash,
    ),
    /Połączenie/,
  );
  assert.equal((await stock(p.id)).reserved, 0);
});
test('simulation refresh and approved import perform no provider HTTP; restore-preview blocks refresh', async () => {
  const ch = await channel(true),
    s = await stage(ch, fixture());
  await product(ch);
  calls = [];
  assert.equal(
    (await ok('/integrations/' + ch + '/fetch-order', 'POST', { external_id: fixture().id })).scope,
    'local_simulation',
  );
  assert.equal((await commit(s)).statusCode, 200);
  assert.equal(calls.length, 0);
  let restored: FastifyInstance | undefined;
  try {
    restored = await buildApp({ integrationTransport: transport, readOnly: true });
    const result = await restored.inject({
      method: 'POST',
      url: '/api/integrations/' + ch + '/fetch-order',
      payload: { external_id: fixture().id },
    });
    assert.equal(result.statusCode, 423);
    assert.equal(calls.length, 0);
  } finally {
    await restored?.close();
  }
});
