import { before, beforeEach, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../server/app';
import { pool, migrate, tenantTx } from '../server/db';
import { seed } from './fixtures';
import { encrypt, decrypt } from '../server/security';
import { demoWooOrder } from '../server/import-routes';
import { demoAllegroOrder } from '../server/allegro-example';
import { demoShopifyOrder } from '../server/shopify-example';
import { SHOPIFY_VERSION } from '../server/shopify';
import {
  processOrderFieldMappingJob,
  reapOrderFieldMappingJobs,
  createOrderFieldMappingPreview,
} from '../server/order-field-mappings';
import {
  captureOrderFieldMappingSources,
  convertOrderFieldMappingSources,
  orderFieldMappingConnectionHash,
} from '../server/order-field-mappings-source';
import { orderFieldMappingProfileSchema } from '../server/order-field-mappings-schema';
assert.equal(process.env.DYNA_TEST, 'true');
let app: Awaited<ReturnType<typeof buildApp>>,
  cookie = '',
  tenant = '',
  user = '',
  warehouse = '',
  product: any,
  ip = 1;
const remote = new Map<string, any[]>(),
  calls: { url: string; method: string }[] = [];
const req = (path: string, method: any = 'GET', body?: any, headers: any = { cookie }) =>
  app.inject({
    url: '/api' + path,
    method,
    payload: body,
    headers,
    remoteAddress: '127.0.46.' + ip,
  });
async function ok(path: string, method: any = 'GET', body?: any, status = 200) {
  const r = await req(path, method, body);
  assert.equal(r.statusCode, status, path + ' HTTP ' + r.statusCode);
  return r.json() as any;
}
before(async () => {
  await migrate();
  await seed();
  app = await buildApp({
    integrationTransport: async (url, init) => {
      calls.push({ url, method: init?.method ?? 'GET' });
      const u = new URL(url);
      if (u.hostname === 'woo.example.test' && u.pathname.endsWith('/orders'))
        return Response.json(remote.get('woocommerce') ?? []);
      if (u.pathname === '/order/checkout-forms')
        return Response.json({
          checkoutForms: remote.get('allegro') ?? [],
          totalCount: remote.get('allegro')?.length ?? 0,
        });
      if (u.hostname === 'mapping-qa.myshopify.com') {
        const body = JSON.parse(String(init?.body)),
          query = body.query as string;
        const data = query.includes('DynaOrders')
          ? {
              orders: {
                nodes: remote.get('shopify') ?? [],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            }
          : query.includes('DynaOrder(')
            ? {
                shop: { id: 'gid://shopify/Shop/101', myshopifyDomain: u.hostname },
                order: (remote.get('shopify') ?? []).find((o) => o.id === body.variables.id),
              }
            : null;
        assert(data, 'Unexpected Shopify read ' + query.slice(0, 60));
        return Response.json({ data }, { headers: { 'X-Shopify-API-Version': SHOPIFY_VERSION } });
      }
      throw new Error('Unexpected transport ' + url);
    },
  });
  const login = await req('/auth/login', 'POST', {
    email: 'admin@demo.local',
    password: 'DynaDemo!2026',
  });
  assert.equal(login.statusCode, 200, login.body);
  cookie = String(login.headers['set-cookie']).split(';')[0];
  user = (await pool.query("SELECT id FROM users WHERE email='admin@demo.local'")).rows[0].id;
});
beforeEach(async () => {
  ip++;
  remote.clear();
  calls.length = 0;
  tenant = randomUUID();
  warehouse = randomUUID();
  await pool.query(
    "INSERT INTO tenants(id,name,plan) VALUES($1,'B2 mapping isolated','enterprise')",
    [tenant],
  );
  await pool.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'admin')", [
    tenant,
    user,
  ]);
  await pool.query("INSERT INTO warehouses(id,tenant_id,name,code) VALUES($1,$2,'Mapping','MAP')", [
    warehouse,
    tenant,
  ]);
  const switched = await req('/workspaces/switch', 'POST', { tenant_id: tenant });
  assert.equal(switched.statusCode, 200, switched.body);
  cookie = String(switched.headers['set-cookie']).split(';')[0];
  product = await ok(
    '/products',
    'POST',
    {
      sku: 'MAP-' + randomUUID(),
      name: 'Mapping product',
      price: 1000,
      quantity: 10000,
      warehouse_id: warehouse,
    },
    201,
  );
});
after(async () => {
  await app?.close();
  await pool.end();
});
const actor = () => ({ tenantId: tenant, userId: user, role: 'admin' as const });
const field = (type = 'text', extra: any = {}) =>
  ok(
    '/order-fields',
    'POST',
    {
      client_key: randomUUID(),
      key: 'm_' + randomUUID().replaceAll('-', ''),
      label: 'Mapped field',
      type,
      ...extra,
    },
    201,
  );
const mapping = (d: any, source: any = { kind: 'woo_customer_note' }, extra: any = {}) => ({
  source,
  field_id: d.id,
  definition_version: d.version,
  type: d.type,
  conversion: { kind: 'direct' },
  on_missing: 'error',
  ...extra,
});
async function channel(provider = 'woocommerce', simulation = true) {
  const id = randomUUID(),
    settings =
      provider === 'woocommerce'
        ? { simulation, store_url: 'https://woo.example.test' }
        : provider === 'shopify'
          ? { simulation, store_url: 'https://mapping-qa.myshopify.com' }
          : { simulation, oauth_connection_id: randomUUID() };
  const credentials =
    provider === 'woocommerce'
      ? { consumer_key: 'map-key', consumer_secret: 'map-secret' }
      : { access_token: 'map-token-1234567890', refresh_token: 'map-refresh' };
  const ch = (
    await pool.query(
      "INSERT INTO channels(id,tenant_id,provider,name,mode,credentials,settings,status,token_expires_at,oauth_scopes) VALUES($1,$2,$3,'Mapping','sandbox',$4,$5,$6,now()+interval '2 days',$7) RETURNING *",
      [
        id,
        tenant,
        provider,
        encrypt(credentials),
        JSON.stringify(settings),
        simulation ? 'simulation' : 'authorized_read',
        provider === 'allegro' ? ['allegro:api:orders:read'] : [],
      ],
    )
  ).rows[0];
  const external =
    provider === 'shopify'
      ? 'gid://shopify/ProductVariant/701'
      : provider === 'allegro'
        ? 'demo-offer-1'
        : '701';
  await ok('/integrations/' + id + '/mappings', 'POST', {
    external_id: external,
    sku: product.sku,
  });
  return ch;
}
const profile = async (ch: any, mappings: any[]) =>
  (
    await ok(
      '/order-field-mappings/profiles',
      'POST',
      {
        client_key: randomUUID(),
        channel_id: ch.id,
        label: 'Mapping profile',
        enabled: true,
        mappings,
      },
      201,
    )
  ).profile;
const raw = (note = 'raw note', id = Math.floor(Math.random() * 900000) + 100000) => ({
  ...structuredClone(demoWooOrder),
  id,
  customer_note: note,
  date_paid: null,
  status: 'on-hold',
});
async function heads(ch: any) {
  const all: any[] = [];
  let cursor: string | undefined;
  do {
    const p = await ok(
      '/order-field-mappings/sources?' +
        new URLSearchParams({ channel_id: ch.id, ...(cursor ? { cursor } : {}) }),
    );
    all.push(...p.data);
    cursor = p.meta.cursor;
  } while (cursor);
  return all;
}
async function stage(ch: any, raws: any[]) {
  for (let i = 0; i < raws.length; i += 50)
    await ok('/integrations/' + ch.id + '/stage-orders', 'POST', { data: raws.slice(i, i + 50) });
  return (await heads(ch)).filter((s) => raws.some((r) => String(r.id) === s.external_id));
}
const initial = (p: any, s: any) =>
  ok(
    '/order-field-mappings/previews',
    'POST',
    {
      client_key: randomUUID(),
      kind: 'initial',
      profile_id: p.id,
      profile_version: p.version,
      inbound_id: s.inbound_id,
      observation_id: s.observation_id,
      source_hash: s.source_hash,
      warehouse_id: warehouse,
    },
    201,
  );
const importBody = (p: any) => ({
  client_key: randomUUID(),
  consent: { scope_hash: p.scope_hash, local_only: true },
});
const imported = (p: any, b = importBody(p), status = 201) =>
  ok('/order-field-mappings/previews/' + p.id + '/import', 'POST', b, status);
const reconcile = (p: any, s: any[], policy = 'fill_unset') =>
  ok(
    '/order-field-mappings/previews',
    'POST',
    {
      client_key: randomUUID(),
      kind: 'reconcile',
      profile_id: p.id,
      profile_version: p.version,
      policy,
      orders: s.map((s) => ({
        inbound_id: s.inbound_id,
        observation_id: s.observation_id,
        source_hash: s.source_hash,
        order_id: s.order_id,
        order_version: s.order_version,
      })),
    },
    201,
  );
const queueBody = (p: any, ids = p.data.map((r: any) => r.row_id)) => ({
  client_key: randomUUID(),
  selected_rows: ids,
  consent: {
    scope_hash: p.scope_hash,
    selected_count: ids.length,
    policy: p.policy,
    local_only: true,
  },
});
const queue = (p: any, b = queueBody(p), status = 201) =>
  ok('/order-field-mappings/previews/' + p.id + '/queue', 'POST', b, status);
async function claimed(id: string) {
  return (
    await pool.query(
      "UPDATE jobs SET state='running',attempts=attempts+1,lease_token=$2,locked_at=now() WHERE id=(SELECT job_id FROM order_field_mapping_executions WHERE id=$1) RETURNING *",
      [id, randomUUID()],
    )
  ).rows[0];
}
async function run(id: string) {
  await processOrderFieldMappingJob(await claimed(id));
  return ok('/order-field-mappings/executions/' + id);
}
async function baseline() {
  return (
    await pool.query(
      'SELECT (SELECT count(*)::int FROM order_field_values WHERE tenant_id=$1) values,(SELECT count(*)::int FROM order_field_value_events WHERE tenant_id=$1) history,(SELECT count(*)::int FROM orders WHERE tenant_id=$1) orders,(SELECT count(*)::int FROM payment_entries WHERE tenant_id=$1) ledger,(SELECT count(*)::int FROM order_events WHERE tenant_id=$1) events,(SELECT sum(reserved)::int FROM stock WHERE tenant_id=$1) reserved',
      [tenant],
    )
  ).rows[0];
}
async function existing(ch: any, count: number) {
  const raws = Array.from({ length: count }, (_, i) => raw('mapped ' + i, 700000 + i)),
    sources = await stage(ch, raws);
  const orders = (
    await pool.query(
      "INSERT INTO orders(id,tenant_id,number,source,channel_id,external_id,customer_name,email,warehouse_id,total,portal_token) SELECT gen_random_uuid(),$1,'MAP-'||g,'woocommerce',$2,(700000+g)::text,'Mapping existing','mapping@example.test',$3,10001,gen_random_uuid()::text FROM generate_series(0,$4-1)g RETURNING id,external_id",
      [tenant, ch.id, warehouse, count],
    )
  ).rows;
  for (const o of orders)
    await pool.query(
      "UPDATE inbound_orders SET order_id=$2,state='imported',imported_hash=source_hash WHERE id=$1",
      [sources.find((s) => s.external_id === o.external_id).inbound_id, o.id],
    );
  return stage(ch, raws);
}

test('initial six types preserve exact Unicode/decimal/date/options and source provenance atomically; receipt retry never repeats reservations or payment', async () => {
  const defs = [
      await field(),
      await field('number', { config: { scale: 0 } }),
      await field('date'),
      await field('select', { options: [{ id: randomUUID(), label: 'S', enabled: true }] }),
      await field('radio', { options: [{ id: randomUUID(), label: 'R', enabled: true }] }),
      await field('multi_select', {
        options: [
          { id: randomUUID(), label: 'M1', enabled: true },
          { id: randomUUID(), label: 'M2', enabled: true },
        ],
      }),
    ],
    ch = await channel();
  const mappings = defs.map((d, i) =>
      mapping(
        d,
        { kind: 'woo_meta', key: 'key' + i },
        i >= 3
          ? {
              conversion: {
                kind: 'option_map',
                input: i === 5 ? 'array' : 'scalar',
                codes: d.options.map((o: any, j: number) => ({
                  code: 'code' + j,
                  option_id: o.id,
                })),
              },
            }
          : {},
      ),
    ),
    p = await profile(ch, mappings),
    source = {
      ...raw(),
      date_paid: '2026-10-05T10:00:00',
      meta_data: [
        { key: 'key0', value: '😀'.repeat(4000) },
        { key: 'key1', value: '123456789012345678' },
        { key: 'key2', value: '2024-02-29' },
        { key: 'key3', value: 'code0' },
        { key: 'key4', value: 'code0' },
        { key: 'key5', value: ['code1', 'code0'] },
      ],
    };
  const s = (await stage(ch, [source]))[0],
    preview = await initial(p, s);
  assert.equal(preview.summary.ready, 1);
  assert.equal(preview.data[0].order_summary.stock_action, 'reserve_on_import');
  const b = importBody(preview),
    before = await baseline(),
    result = await imported(preview, b);
  assert.equal(result.execution.state, 'done');
  assert(!JSON.stringify(result.order).includes('123456789012345678'));
  assert.equal((await baseline()).reserved - before.reserved, 3);
  assert.equal((await baseline()).ledger - before.ledger, 1);
  const vs = (
    await pool.query('SELECT payload,source,provenance FROM order_field_values WHERE order_id=$1', [
      result.order.id,
    ])
  ).rows;
  assert.equal(vs.length, 6);
  assert(
    vs.every(
      (v) => v.source === 'channel_import' && v.provenance.execution_id === result.execution.id,
    ),
  );
  assert(vs.some((v) => v.payload.value === '😀'.repeat(4000)));
  assert(vs.some((v) => v.payload.value === '123456789012345678'));
  assert(vs.some((v) => Array.isArray(v.payload.value) && v.payload.value.length === 2));
  const base = await baseline(),
    again = await imported(preview, b, 200);
  assert.equal(again.execution.id, result.execution.id);
  assert.deepEqual(await baseline(), base);
  assert.equal(
    (
      await req('/order-field-mappings/previews/' + preview.id + '/import', 'POST', {
        ...b,
        consent: { ...b.consent, scope_hash: 'a'.repeat(64) },
      })
    ).statusCode,
    409,
  );
  const events = (
    await pool.query('SELECT provenance FROM order_field_value_events WHERE order_id=$1', [
      result.order.id,
    ])
  ).rows;
  assert(events.every((e) => e.provenance.profile_id === p.id));
  assert(
    !(
      await pool.query('SELECT detail::text FROM order_events WHERE order_id=$1', [result.order.id])
    ).rows.some((e) => e.detail.includes('123456789012345678')),
  );
  const encrypted = (
    await pool.query('SELECT * FROM order_field_source_observations WHERE id=$1', [
      s.observation_id,
    ])
  ).rows[0];
  assert.equal(
    Buffer.from(decrypt(encrypted.encrypted_bytes).content_base64, 'base64').length,
    encrypted.byte_count,
  );
  assert(!JSON.stringify(preview).includes('encrypted_bytes'));
});
test('actual Woo/Allegro/Shopify read adapters stage approved surfaces and initial preserves the ordinary import protocol', async () => {
  for (const provider of ['woocommerce', 'allegro', 'shopify']) {
    const ch = await channel(provider, false),
      d = await field(),
      kind =
        provider === 'woocommerce'
          ? 'woo_customer_note'
          : provider === 'allegro'
            ? 'allegro_message_to_seller'
            : 'shopify_note',
      p = await profile(ch, [mapping(d, { kind })]);
    const source =
      provider === 'woocommerce'
        ? raw('READ-WOO', 880111)
        : provider === 'allegro'
          ? {
              ...structuredClone(demoAllegroOrder),
              messageToSeller: 'READ-ALLEGRO',
              buyer: { ...demoAllegroOrder.buyer, login: 'buyer-login' },
              delivery: { ...demoAllegroOrder.delivery, method: { name: 'Carrier' } },
            }
          : { ...structuredClone(demoShopifyOrder), note: 'READ-SHOPIFY' };
    remote.set(provider, [source]);
    await ok('/integrations/' + ch.id + '/fetch-orders', 'POST', {});
    const s = (await heads(ch))[0];
    assert(s.observation_id);
    const preview = await initial(p, s),
      body = importBody(preview),
      result = await imported(preview, body);
    assert.equal(result.order.source, provider);
    assert.equal(
      (
        await pool.query('SELECT text_value FROM order_field_values WHERE order_id=$1', [
          result.order.id,
        ])
      ).rows[0].text_value,
      provider === 'woocommerce'
        ? 'READ-WOO'
        : provider === 'allegro'
          ? 'READ-ALLEGRO'
          : 'READ-SHOPIFY',
    );
    const later = {
      ...source,
      ...(provider === 'woocommerce'
        ? { customer_note: 'LATER-WOO' }
        : provider === 'allegro'
          ? { messageToSeller: 'LATER-ALLEGRO' }
          : { note: 'LATER-SHOPIFY', updatedAt: '2026-10-05T10:00:00.000Z' }),
    };
    remote.set(provider, [later]);
    await ok('/integrations/' + ch.id + '/fetch-orders', 'POST', {});
    assert.notEqual((await heads(ch))[0].source_hash, s.source_hash);
    const durableEffects = async () => ({
      counts: await baseline(),
      rows: (
        await pool.query(
          `SELECT
            (SELECT to_jsonb(o) FROM orders o WHERE id=$2 AND tenant_id=$1) AS order_row,
            (SELECT jsonb_agg(to_jsonb(v) ORDER BY field_id) FROM order_field_values v WHERE order_id=$2 AND tenant_id=$1) AS values,
            (SELECT jsonb_agg(to_jsonb(s) ORDER BY product_id,warehouse_id) FROM stock s WHERE tenant_id=$1) AS stock`,
          [tenant, result.order.id],
        )
      ).rows[0],
    });
    const beforeRetry = await durableEffects(),
      readsBeforeRetry = calls.length,
      replay = await imported(preview, body, 200);
    assert.equal(replay.reused, true);
    assert.equal(replay.order.id, result.order.id);
    assert.equal(replay.execution.id, result.execution.id);
    assert.deepEqual(await durableEffects(), beforeRetry);
    assert.equal(calls.length, readsBeforeRetry, 'Completed receipt retry must not refetch source');
    assert.equal(
      (
        await req('/order-field-mappings/previews/' + preview.id + '/import', 'POST', {
          ...body,
          consent: { ...body.consent, scope_hash: 'a'.repeat(64) },
        })
      ).statusCode,
      409,
    );
    assert.deepEqual(await durableEffects(), beforeRetry);
  }
  assert(calls.some((c) => c.url.includes('/wp-json/wc/v3/orders')));
  assert(calls.some((c) => c.url.includes('/order/checkout-forms')));
  assert(calls.some((c) => c.url.includes('/graphql.json')));
  assert(
    calls.every(
      (c) => c.method === 'GET' || (c.method === 'POST' && c.url.includes('/graphql.json')),
    ),
  );
});
test('source parser exact selectors reject duplicate/object/float/missing/code/date and optional missing remains visible no-op', async () => {
  const d = await field(),
    ch = await channel(),
    p = await profile(ch, [mapping(d, { kind: 'woo_meta', key: 'ExactKey' })]);
  for (const meta of [
    [
      { key: 'ExactKey', value: 'x' },
      { key: 'ExactKey', value: 'x' },
    ],
    [{ key: 'ExactKey', value: { x: 'x' } }],
    [{ key: 'ExactKey', value: 0.1 }],
    [],
  ]) {
    const s = (await stage(ch, [{ ...raw(), meta_data: meta }]))[0],
      preview = await initial(p, s);
    assert.equal(preview.summary.invalid, 1);
    assert.equal(
      (
        await req(
          '/order-field-mappings/previews/' + preview.id + '/import',
          'POST',
          importBody(preview),
        )
      ).statusCode,
      409,
    );
  }
  const changed = (
      await ok('/order-field-mappings/profiles/' + p.id, 'PATCH', {
        client_key: randomUUID(),
        version: p.version,
        label: p.label,
        enabled: true,
        mappings: [{ ...p.mappings[0], on_missing: 'skip' }],
      })
    ).profile,
    s = (await stage(ch, [raw()]))[0],
    preview = await initial(changed, s);
  assert.equal(preview.summary.no_op, 1);
  assert.equal(preview.data[0].skipped[0].reason, 'source_missing');
  const result = await imported(preview);
  assert.equal(result.execution.result.changed_orders, 0);
  assert.equal((await baseline()).values, 0);
  const n = { ...mapping(d), type: 'number' as const },
    source = captureOrderFieldMappingSources('woocommerce', { customer_note: 0.1 }, [n]);
  assert.equal(source[0].status, 'invalid');
  assert(convertOrderFieldMappingSources([n], source).issues.length);
  const number = await field('number', { config: { scale: 2 } }),
    date = await field('date'),
    select = await field('select', {
      options: [{ id: randomUUID(), label: 'Exact choice', enabled: true }],
    }),
    typedMappings = [
      mapping(number, { kind: 'woo_meta', key: 'amount' }),
      mapping(date, { kind: 'woo_meta', key: 'date' }),
      mapping(
        select,
        { kind: 'woo_meta', key: 'choice' },
        {
          conversion: {
            kind: 'option_map',
            input: 'scalar',
            codes: [{ code: 'known', option_id: select.options[0].id }],
          },
        },
      ),
    ];
  const typed = (
    await ok('/order-field-mappings/profiles/' + p.id, 'PATCH', {
      client_key: randomUUID(),
      version: changed.version,
      label: 'Exact typed',
      enabled: true,
      mappings: typedMappings,
    })
  ).profile;
  for (const values of [
    ['1.001', '2024-02-29', 'known'],
    ['1.00', '2023-02-29', 'known'],
    ['1.00', '2024-02-29', 'unknown'],
  ]) {
    const source = (
        await stage(ch, [
          {
            ...raw(),
            meta_data: values.map((value, i) => ({ key: ['amount', 'date', 'choice'][i], value })),
          },
        ])
      )[0],
      plan = await initial(typed, source);
    assert.equal(plan.summary.invalid, 1);
    assert.equal(
      (await req('/order-field-mappings/previews/' + plan.id + '/import', 'POST', importBody(plan)))
        .statusCode,
      409,
    );
  }
  assert(
    !orderFieldMappingProfileSchema.safeParse({
      client_key: randomUUID(),
      channel_id: ch.id,
      label: 'Bad',
      enabled: true,
      mappings: [{ ...p.mappings[0], type: 'file' }],
    }).success,
  );
});
test('ordinary import never opts in; profile CAS/replay is immutable and changed listing/profile invalidate initial consent', async () => {
  const d = await field(),
    ch = await channel(),
    profileBody = {
      client_key: randomUUID(),
      channel_id: ch.id,
      label: 'CAS',
      enabled: true,
      mappings: [mapping(d)],
    },
    p = (await ok('/order-field-mappings/profiles', 'POST', profileBody, 201)).profile;
  assert.equal((await ok('/order-field-mappings/profiles', 'POST', profileBody)).profile.id, p.id);
  assert.equal(
    (await req('/order-field-mappings/profiles', 'POST', { ...profileBody, label: 'changed' }))
      .statusCode,
    409,
  );
  const r = raw(),
    s = (await stage(ch, [r]))[0],
    preview = await initial(p, s),
    ordinary = await ok('/imports/' + s.inbound_id + '/commit', 'POST', {
      warehouse_id: warehouse,
    });
  assert(ordinary.id);
  assert.equal((await baseline()).values, 0);
  assert.equal(
    (
      await req(
        '/order-field-mappings/previews/' + preview.id + '/import',
        'POST',
        importBody(preview),
      )
    ).statusCode,
    409,
  );
  const r2 = raw(),
    s2 = (await stage(ch, [r2]))[0],
    pr = await initial(p, s2);
  await pool.query('UPDATE listings SET product_id=$2 WHERE channel_id=$1', [
    ch.id,
    (
      await ok(
        '/products',
        'POST',
        {
          sku: 'MAP-other',
          name: 'Other mapping',
          price: 1000,
          quantity: 10,
          warehouse_id: warehouse,
        },
        201,
      )
    ).id,
  ]);
  const base = await baseline();
  assert.equal(
    (await req('/order-field-mappings/previews/' + pr.id + '/import', 'POST', importBody(pr)))
      .statusCode,
    409,
  );
  assert.deepEqual(await baseline(), base);
  await ok('/integrations/' + ch.id + '/mappings', 'POST', {
    external_id: '701',
    sku: product.sku,
  });
  const pr2 = await initial(p, (await stage(ch, [r2]))[0]);
  await ok('/order-field-mappings/profiles/' + p.id, 'PATCH', {
    client_key: randomUUID(),
    version: 1,
    label: 'Revision2',
    enabled: true,
    mappings: p.mappings,
  });
  assert.equal(
    (await req('/order-field-mappings/previews/' + pr2.id + '/import', 'POST', importBody(pr2)))
      .statusCode,
    409,
  );
});
test('reconcile100 is atomic, fills unset without clobbering empty manual values, exact selection/retry and no-op do not repeat effects', async () => {
  const d = await field(),
    ch = await channel(),
    p = await profile(ch, [mapping(d)]),
    sources = await existing(ch, 100);
  await ok('/orders/' + sources[0].order_id + '/fields', 'PATCH', {
    client_key: randomUUID(),
    order_version: 1,
    changes: [{ field_id: d.id, definition_version: d.version, type: 'text', value: '' }],
  });
  sources[0].order_version = 2;
  const preview = await reconcile(p, sources),
    ids = (
      await pool.query(
        'SELECT id FROM order_field_mapping_rows WHERE preview_id=$1 ORDER BY position',
        [preview.id],
      )
    ).rows.map((r) => r.id);
  assert.equal(preview.summary.ready, 99);
  assert.equal(preview.summary.no_op, 1);
  const b = queueBody(preview, ids),
    q = await queue(preview, b);
  assert.equal((await queue(preview, b, 200)).execution.id, q.execution.id);
  const base = await baseline(),
    done = await run(q.execution.id);
  assert.equal(done.state, 'done');
  assert.equal(done.result.changed_orders, 99);
  assert.equal(done.result.no_op_orders, 1);
  assert.equal((await baseline()).events, base.events);
  assert.equal((await baseline()).ledger, base.ledger);
  assert.equal((await baseline()).reserved, base.reserved);
  assert.equal(
    (
      await pool.query('SELECT text_value FROM order_field_values WHERE order_id=$1', [
        sources[0].order_id,
      ])
    ).rows[0].text_value,
    '',
  );
  const fresh = await heads(ch),
    noop = await reconcile(p, fresh),
    noOpBody = queueBody(
      noop,
      (
        await pool.query(
          'SELECT id FROM order_field_mapping_rows WHERE preview_id=$1 ORDER BY position',
          [noop.id],
        )
      ).rows.map((r) => r.id),
    ),
    prior = await baseline();
  assert.equal((await run((await queue(noop, noOpBody)).execution.id)).result.changed_orders, 0);
  assert.deepEqual(await baseline(), prior);
});
test('last actual write failure rolls back100 mapped values/history/versions and stops terminal job replay; cancel/reaper keep scope', async () => {
  const d = await field(),
    ch = await channel(),
    p = await profile(ch, [mapping(d)]),
    sources = await existing(ch, 100),
    preview = await reconcile(p, sources),
    ids = (
      await pool.query(
        'SELECT id FROM order_field_mapping_rows WHERE preview_id=$1 ORDER BY position',
        [preview.id],
      )
    ).rows.map((r) => r.id),
    q = await queue(preview, queueBody(preview, ids)),
    last = sources[sources.length - 1].order_id;
  await pool.query(
    `CREATE FUNCTION fail_mapping_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.order_id='${last}'::uuid THEN RAISE EXCEPTION 'controlled last mapping write failure'; END IF; RETURN NEW; END $$`,
  );
  await pool.query(
    'CREATE TRIGGER fail_mapping_write BEFORE INSERT ON order_field_values FOR EACH ROW EXECUTE FUNCTION fail_mapping_write()',
  );
  const base = await baseline(),
    versions = (
      await pool.query('SELECT id,version FROM orders WHERE tenant_id=$1 ORDER BY id', [tenant])
    ).rows;
  try {
    assert.equal((await run(q.execution.id)).state, 'failed');
    assert.deepEqual(await baseline(), base);
    assert.deepEqual(
      (await pool.query('SELECT id,version FROM orders WHERE tenant_id=$1 ORDER BY id', [tenant]))
        .rows,
      versions,
    );
    await processOrderFieldMappingJob(await claimed(q.execution.id));
    assert.deepEqual(await baseline(), base);
  } finally {
    await pool.query('DROP TRIGGER fail_mapping_write ON order_field_values');
    await pool.query('DROP FUNCTION fail_mapping_write()');
  }
  const next = await reconcile(p, [sources[0]]),
    queued = await queue(next);
  assert.equal(
    (await ok('/order-field-mappings/executions/' + queued.execution.id + '/cancel', 'POST', {}))
      .state,
    'cancelled',
  );
  const again = await queue(next, queueBody(next));
  await pool.query(
    "UPDATE jobs SET state='failed' WHERE id=(SELECT job_id FROM order_field_mapping_executions WHERE id=$1)",
    [again.execution.id],
  );
  assert.equal(await reapOrderFieldMappingJobs(), 1);
  assert.equal(
    (await ok('/order-field-mappings/executions/' + again.execution.id)).state,
    'failed',
  );
  assert.equal(await reapOrderFieldMappingJobs(), 0);
});
test('profile/source grant identity survives Allegro refresh but rejects epoch changes; bearer capabilities reflect exact scopes', async () => {
  const ch = await channel('allegro', false),
    before = orderFieldMappingConnectionHash(ch),
    refresh = {
      ...ch,
      credentials: encrypt({ access_token: 'rotated', refresh_token: 'rotated2' }),
    };
  assert.equal(orderFieldMappingConnectionHash(refresh), before);
  assert.notEqual(
    orderFieldMappingConnectionHash({
      ...refresh,
      settings: { ...ch.settings, oauth_connection_id: randomUUID() },
    }),
    before,
  );
  const key = await ok(
    '/developer/keys',
    'POST',
    { name: 'Mapping read-only', scopes: ['order-fields:read'] },
    201,
  );
  const headers = { authorization: 'Bearer ' + key.token };
  const metadata = await req('/v1/order-field-mappings/metadata', 'GET', undefined, headers);
  assert.equal(metadata.statusCode, 200, metadata.body);
  assert.equal(metadata.json().can_admin, false);
  assert.equal(metadata.json().can_import, false);
  assert.equal(metadata.json().can_reconcile, false);
  assert.equal(
    (await req('/v1/order-field-mappings/previews', 'POST', {}, headers)).statusCode,
    403,
  );
});
test('active preview capacity preserves exact replay and revision keyset keeps equal timestamps', async () => {
  const d = await field(),
    ch = await channel(),
    p = await profile(ch, [mapping(d)]),
    s = (await stage(ch, [raw()]))[0],
    body = {
      client_key: randomUUID(),
      kind: 'initial' as const,
      profile_id: p.id,
      profile_version: p.version,
      inbound_id: s.inbound_id,
      observation_id: s.observation_id,
      source_hash: s.source_hash,
      warehouse_id: warehouse,
    };
  const first = await createOrderFieldMappingPreview(actor(), body);
  for (let i = 1; i < 20; i++)
    await createOrderFieldMappingPreview(actor(), { ...body, client_key: randomUUID() });
  assert.equal((await createOrderFieldMappingPreview(actor(), body)).id, first.id);
  await assert.rejects(
    createOrderFieldMappingPreview(actor(), { ...body, client_key: randomUUID() }),
    (e: any) => e.status === 429,
  );
  // Real profile CAS produces immutable revisions; equal timestamps are forced
  // before the immutable evidence trigger in an explicit owner-only test fixture.
  let current = p;
  for (let i = 0; i < 22; i++)
    current = (
      await ok('/order-field-mappings/profiles/' + p.id, 'PATCH', {
        client_key: randomUUID(),
        version: current.version,
        label: 'Revision ' + i,
        enabled: true,
        mappings: p.mappings,
      })
    ).profile;
  await pool.query('ALTER TABLE order_field_mapping_revisions DISABLE TRIGGER immutable');
  try {
    await pool.query(
      "UPDATE order_field_mapping_revisions SET created_at='2026-10-05T12:00:00.123456Z' WHERE tenant_id=$1",
      [tenant],
    );
  } finally {
    await pool.query('ALTER TABLE order_field_mapping_revisions ENABLE TRIGGER immutable');
  }
  const firstPage = await ok('/order-field-mappings/profiles/' + p.id + '/revisions'),
    next = await ok(
      '/order-field-mappings/profiles/' +
        p.id +
        '/revisions?cursor=' +
        encodeURIComponent(firstPage.meta.cursor),
    );
  assert.equal(new Set([...firstPage.data, ...next.data].map((r) => r.version)).size, 23);
  assert.equal(next.data.length, 3);
});
