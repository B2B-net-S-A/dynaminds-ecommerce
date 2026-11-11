import { legacySerialOrderStatusPayload } from './order-status-cas-helper';
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../server/app';
import { pool, migrate, tenantTx } from '../server/db';
import { seed, DEMO_TENANT, SECOND_TENANT } from './fixtures';
import {
  processCatalogAi,
  failCatalogAi,
  aiBase,
  aiModels,
  tickCatalogAi,
} from '../server/catalog-ai';
import { tick } from '../server/worker';
import type { Transport } from '../server/integrations';
assert.equal(process.env.DYNA_TEST, 'true');
let app: Awaited<ReturnType<typeof buildApp>>,
  cookie: string,
  other: string,
  viewer: string,
  operator: string,
  warehouse: string;
let calls: { url: string; init: any }[] = [],
  result: any,
  modelDigest = 'a'.repeat(64),
  failure = false,
  hook: (() => Promise<void>) | undefined;
const transport: Transport = async (url, init) => {
  calls.push({ url, init });
  if (failure) throw Error('raw private provider diagnostic');
  if (url.endsWith('/api/tags'))
    return Response.json({
      models: [
        { name: 'qa-local:small', digest: modelDigest, size: 100, details: { format: 'gguf' } },
      ],
    });
  assert(url.endsWith('/api/chat'));
  if (hook) await hook();
  return Response.json(result);
};
const req = (p: string, method: any = 'GET', payload?: any, auth = cookie) =>
  app.inject({ url: '/api' + p, method, payload, headers: { cookie: auth } });
async function ok(p: string, method: any = 'GET', payload?: any, auth = cookie, status = 200) {
  const r = await req(p, method, payload, auth);
  assert.equal(r.statusCode, status, r.body);
  return r.json();
}
before(async () => {
  await migrate();
  await seed();
  app = await buildApp({ integrationTransport: transport });
  const auth = async (email: string) => {
    const r = await req('/auth/login', 'POST', { email, password: 'DynaDemo!2026' }, '');
    assert.equal(r.statusCode, 200);
    return String(r.headers['set-cookie']).split(';')[0];
  };
  cookie = await auth('admin@demo.local');
  other = await auth('other@demo.local');
  viewer = await auth('viewer@demo.local');
  operator = await auth('operator@demo.local');
  warehouse = (await ok('/warehouses')).data[0].id;
});
beforeEach(async () => {
  await pool.query("UPDATE ai_catalog_drafts SET state='cancelled' WHERE state='queued'");
  await pool.query(
    "UPDATE jobs SET state='done' WHERE kind='catalog.ai' AND state IN ('pending','running')",
  );
  calls = [];
  modelDigest = 'a'.repeat(64);
  failure = false;
  hook = undefined;
  result = {
    model: 'qa-local:small',
    done: true,
    done_reason: 'stop',
    message: {
      role: 'assistant',
      content: JSON.stringify({
        name: 'Kubek stalowy 350 ml',
        description: 'Kubek ze stali, 350 ml. Kolor czarny.',
      }),
    },
    prompt_eval_count: 50,
    eval_count: 30,
    total_duration: 10000000,
  };
});
after(async () => {
  await app.close();
  await pool.end();
});
async function product(extra: any = {}) {
  return ok(
    '/products',
    'POST',
    {
      sku: 'AI-' + randomUUID(),
      name: 'Kubek QA',
      description: 'Stalowy kubek 350 ml.',
      attributes: { Kolor: 'czarny', Materiał: 'stal' },
      price: 2500,
      quantity: 10,
      warehouse_id: warehouse,
      ...extra,
    },
    cookie,
    201,
  );
}
async function queued(p: any, extra: any = {}) {
  return ok(
    '/products/' + p.id + '/ai',
    'POST',
    {
      version: p.version,
      client_key: randomUUID(),
      model: 'qa-local:small',
      destination: 'catalog',
      locale: 'pl',
      ...extra,
    },
    cookie,
    201,
  );
}
async function job(d: any) {
  return (
    await pool.query(
      "UPDATE jobs SET state='running',attempts=attempts+1,lease_token=$2,locked_at=now() WHERE id=$1 RETURNING *",
      [d.job_id, randomUUID()],
    )
  ).rows[0];
}
async function work(d: any) {
  const j = await job(d);
  try {
    await processCatalogAi(j, transport);
  } catch (e) {
    await failCatalogAi(j, e);
  }
  return (await pool.query('SELECT * FROM ai_catalog_drafts WHERE id=$1', [d.id])).rows[0];
}
async function change(p: any, extra: any = {}) {
  const current = await ok('/products/' + p.id);
  return ok('/products/' + p.id, 'PATCH', { ...current, ...extra });
}
const text = { name: 'Kubek stalowy 350 ml', description: 'Kubek ze stali, 350 ml. Kolor czarny.' };
const apply = (d: any, extra: any = {}) =>
  req('/ai/catalog/drafts/' + d.id + '/apply', 'POST', {
    approve: true,
    version: d.source_version,
    ...text,
    ...extra,
  });
const chats = () => calls.filter((c) => c.url.endsWith('/api/chat'));
test('AI endpoint is numeric loopback only; remote URLs, credentials, query and redirects are excluded', () => {
  assert.equal(aiBase(), 'http://127.0.0.1:11435');
  for (const u of [
    'https://example.com',
    'http://localhost:11435',
    'http://127.0.0.1.evil.test',
    'http://127.0.0.1:11435/api',
    'http://u:p@127.0.0.1:11435',
    'http://127.0.0.1:11435?x=1',
  ])
    assert.throws(() => aiBase(u));
});
test('Inference contract uses schema, bounded options, no tools/customer/price data and cannot apply by itself', async () => {
  const p = await product(),
    before = await ok('/products/' + p.id),
    d = await queued(p),
    ready = await work(d);
  assert.equal(ready.state, 'ready');
  assert.deepEqual(await ok('/products/' + p.id), before);
  const call = chats()[0],
    b = JSON.parse(call.init.body);
  assert.equal(call.init.redirect, 'error');
  assert.equal(b.stream, false);
  assert.equal(b.keep_alive, 0);
  assert.equal(b.options.num_ctx, 16384);
  assert.equal(b.tools, undefined);
  assert.match(b.messages[0].content, /Both output fields must be written in Polish/);
  assert.deepEqual(Object.keys(JSON.parse(b.messages[1].content).product).sort(), [
    'attributes',
    'category',
    'description',
    'name',
  ]);
  assert.equal(b.format.additionalProperties, false);
  assert.equal(chats().length, 1);
});
test('Reviewed title/description apply once; SKU, money, attributes, components and stock remain exact', async () => {
  const p = await product(),
    before = await ok('/products/' + p.id),
    d = await work(await queued(p));
  assert.equal((await apply(d, { name: 'Tytuł po przeglądzie' })).statusCode, 200);
  const after = await ok('/products/' + p.id);
  assert.deepEqual(
    { ...after, name: before.name, description: before.description, version: before.version },
    before,
  );
  assert.equal(after.name, 'Tytuł po przeglądzie');
  assert.equal((await apply(d, { name: 'Tytuł po przeglądzie' })).json().reused, true);
  assert.equal((await apply(d, { name: 'Inna treść' })).statusCode, 409);
});
test('Translation stores its locale while preserving main content and invalidates other stale drafts', async () => {
  const p = await product(),
    old = await queued(p),
    d = await work(await queued(p, { destination: 'translation', locale: 'en' }));
  assert.match(
    JSON.parse(chats()[0].init.body).messages[0].content,
    /Translate both product name and description faithfully into English/,
  );
  assert.equal((await apply(d)).statusCode, 200);
  const after = await ok('/products/' + p.id);
  assert.equal(after.name, p.name);
  assert.equal(after.description, p.description);
  const h = await ok('/products/' + p.id + '/ai');
  assert.equal(h.translations[0].locale, 'en');
  assert.equal(h.translations[0].name, text.name);
  assert.equal((await work(old)).state, 'conflict');
});
test('Consent and text schema required; markup, extra commands and invalid text cannot be saved', async () => {
  const d = await work(await queued(await product()));
  assert.equal((await apply(d, { approve: false })).statusCode, 422);
  assert.equal((await apply(d, { description: '<script>alert(1)</script>' })).statusCode, 422);
  assert.equal((await apply(d, { price: 1 })).statusCode, 422);
  assert.equal((await apply(d, { name: 'x' })).statusCode, 422);
});
test('Queue deduplicates request key and rejects altered payload', async () => {
  const p = await product(),
    key = randomUUID(),
    d = await queued(p, { client_key: key });
  calls = [];
  assert.equal((await queued(p, { client_key: key })).id, d.id);
  assert.equal(calls.length, 0);
  assert.equal(
    (
      await req('/products/' + p.id + '/ai', 'POST', {
        version: p.version,
        client_key: key,
        model: 'qa-local:small',
        destination: 'catalog',
        locale: 'de',
      })
    ).statusCode,
    409,
  );
});
test('Current product version is checked before inference and apply', async () => {
  const p = await product(),
    d = await queued(p);
  await change(p, { description: 'Aktualny opis operatora' });
  calls = [];
  assert.equal((await work(d)).state, 'conflict');
  assert.equal(chats().length, 0);
  const p2 = await product(),
    d2 = await work(await queued(p2));
  await change(p2, { name: 'Nowy tytuł operatora' });
  assert.equal((await apply(d2)).statusCode, 409);
  assert.equal((await ok('/products/' + p2.id)).name, 'Nowy tytuł operatora');
});
test('Product change during inference retains result as conflict without applying', async () => {
  const p = await product(),
    d = await queued(p);
  hook = () => change(p, { name: 'Tytuł zmieniony podczas AI' });
  const r = await work(d);
  assert.equal(r.state, 'conflict');
  assert.deepEqual(r.output, text);
  assert.equal((await apply(d)).statusCode, 409);
});
test('Model digest is frozen and changed weights prevent dispatch', async () => {
  const d = await queued(await product());
  modelDigest = 'b'.repeat(64);
  calls = [];
  assert.equal((await work(d)).state, 'conflict');
  assert.equal(chats().length, 0);
});
test('Malformed, HTML or truncated model output fails without catalog changes', async () => {
  for (const body of [
    {
      ...result,
      message: { role: 'assistant', content: '{"name":"Xx","description":"<b>test</b>"}' },
    },
    { ...result, message: { role: 'assistant', content: 'not JSON' } },
    { ...result, done_reason: 'length' },
  ]) {
    const p = await product(),
      d = await queued(p);
    result = body;
    assert.equal((await work(d)).state, 'failed');
    assert.equal((await ok('/products/' + p.id)).name, p.name);
  }
});
test('Local transport failure has safe diagnostics and no automatic second inference', async () => {
  const d = await queued(await product());
  failure = true;
  const r = await work(d);
  assert.equal(r.state, 'failed');
  assert(!JSON.stringify(r).includes('raw private'));
  failure = false;
  await work(d);
  assert.equal(chats().length, 0);
});
test('Cancellation before dispatch prevents inference; during inference suppresses its result', async () => {
  const d = await queued(await product());
  await ok('/ai/catalog/drafts/' + d.id + '/cancel', 'POST', {});
  calls = [];
  assert.equal((await work(d)).state, 'cancelled');
  assert.equal(chats().length, 0);
  const d2 = await queued(await product());
  hook = () => ok('/ai/catalog/drafts/' + d2.id + '/cancel', 'POST', {});
  const r = await work(d2);
  assert.equal(r.state, 'cancelled');
  assert.equal(r.output, null);
});
test('Expired source cannot infer or apply', async () => {
  const d = await work(await queued(await product()));
  await pool.query('ALTER TABLE ai_catalog_drafts DISABLE TRIGGER ai_catalog_immutable');
  try {
    await pool.query(
      "UPDATE ai_catalog_drafts SET expires_at=now()-interval '1 minute' WHERE id=$1",
      [d.id],
    );
  } finally {
    await pool.query('ALTER TABLE ai_catalog_drafts ENABLE TRIGGER ai_catalog_immutable');
  }
  assert.equal((await apply(d)).statusCode, 409);
});
test('Foreign firm and nonadmins cannot read, queue or apply AI drafts', async () => {
  const p = await product(),
    d = await work(await queued(p));
  assert.equal((await req('/products/' + p.id + '/ai', 'GET', undefined, other)).statusCode, 404);
  assert.equal(
    (
      await req(
        '/ai/catalog/drafts/' + d.id + '/apply',
        'POST',
        { approve: true, version: p.version, ...text },
        other,
      )
    ).statusCode,
    404,
  );
  for (const auth of [operator, viewer]) {
    assert.equal((await req('/ai/catalog/runtime', 'GET', undefined, auth)).statusCode, 403);
    assert.equal(
      (
        await req(
          '/products/' + p.id + '/ai',
          'POST',
          {
            version: p.version,
            client_key: randomUUID(),
            model: 'qa-local:small',
            locale: 'pl',
            destination: 'catalog',
          },
          auth,
        )
      ).statusCode,
      403,
    );
  }
});
test('Revoked admin before generation prevents model invocation', async () => {
  const d = await queued(await product());
  await pool.query("UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2", [
    DEMO_TENANT,
    d.actor_id,
  ]);
  calls = [];
  try {
    assert.equal((await work(d)).state, 'failed');
    assert.equal(chats().length, 0);
  } finally {
    await pool.query("UPDATE memberships SET role='admin' WHERE tenant_id=$1 AND user_id=$2", [
      DEMO_TENANT,
      d.actor_id,
    ]);
  }
});
test('Stale lease cannot publish inference result', async () => {
  const d = await queued(await product());
  hook = async () => {
    await pool.query('UPDATE jobs SET lease_token=$2 WHERE id=$1', [d.job_id, randomUUID()]);
  };
  await work(d);
  const row = (await pool.query('SELECT state,output FROM ai_catalog_drafts WHERE id=$1', [d.id]))
    .rows[0];
  assert.deepEqual(row, { state: 'queued', output: null });
});
test('RLS hides foreign drafts and source/output are immutable; app cannot delete history', async () => {
  const d = await work(await queued(await product()));
  await tenantTx(SECOND_TENANT, async (c) => {
    assert.equal(
      (await c.query('SELECT id FROM ai_catalog_drafts WHERE id=$1', [d.id])).rowCount,
      0,
    );
  });
  await assert.rejects(
    tenantTx(DEMO_TENANT, (c) =>
      c.query("UPDATE ai_catalog_drafts SET source='{}' WHERE id=$1", [d.id]),
    ),
    /immutable/,
  );
  await assert.rejects(
    tenantTx(DEMO_TENANT, (c) =>
      c.query("UPDATE ai_catalog_drafts SET output='{}' WHERE id=$1", [d.id]),
    ),
    /immutable/,
  );
  await assert.rejects(
    tenantTx(DEMO_TENANT, (c) => c.query('DELETE FROM ai_catalog_drafts WHERE id=$1', [d.id])),
    /permission/,
  );
});
test('Own pending limit is atomic for concurrent enqueue; capacity reused after cancellation', async () => {
  const p = await product();
  const results = await Promise.all(
    Array.from({ length: 12 }, () =>
      req('/products/' + p.id + '/ai', 'POST', {
        version: p.version,
        client_key: randomUUID(),
        model: 'qa-local:small',
        destination: 'catalog',
        locale: 'pl',
      }),
    ),
  );
  assert.equal(results.filter((r) => r.statusCode === 201).length, 10);
  assert.equal(results.filter((r) => r.statusCode === 429).length, 2);
  const d = results.find((r) => r.statusCode === 201)!.json();
  await ok('/ai/catalog/drafts/' + d.id + '/cancel', 'POST', {});
  assert.equal((await queued(p)).state, 'queued');
});
test('Readonly restore runtime does not contact models and rejects generation/apply/cancel', async () => {
  const p = await product(),
    d = await queued(p),
    ro = await buildApp({ readOnly: true, previewPort: 4192, integrationTransport: transport });
  try {
    const l = await ro.inject({
        url: '/api/auth/login',
        method: 'POST',
        payload: { email: 'admin@demo.local', password: 'DynaDemo!2026' },
      }),
      auth = String(l.headers['set-cookie']).split(';')[0];
    calls = [];
    const r = await ro.inject({ url: '/api/ai/catalog/runtime', headers: { cookie: auth } });
    assert.equal(r.json().generation_allowed, false);
    assert.equal(calls.length, 0);
    for (const path of [
      '/products/' + p.id + '/ai',
      '/ai/catalog/drafts/' + d.id + '/apply',
      '/ai/catalog/drafts/' + d.id + '/cancel',
    ])
      assert.equal(
        (
          await ro.inject({
            url: '/api' + path,
            method: 'POST',
            payload: {},
            headers: { cookie: auth },
          })
        ).statusCode,
        423,
      );
  } finally {
    await ro.close();
  }
});
test('Local model discovery excludes cloud/oversized entries and validates catalog shape', async () => {
  const m = await aiModels(async () =>
    Response.json({
      models: [
        { name: 'bad:cloud', digest: 'a'.repeat(64), size: 100, details: { format: 'gguf' } },
        {
          name: 'huge:latest',
          digest: 'b'.repeat(64),
          size: 9 * 1024 ** 3,
          details: { format: 'gguf' },
        },
      ],
    }),
  );
  assert.deepEqual(m, []);
  await assert.rejects(
    aiModels(async () => Response.json({ models: [null] })),
    /katalog/,
  );
});
test('Oversized input and oversized response are rejected without partial catalog changes', async () => {
  const p = await product({
    description: 'a'.repeat(10000),
    attributes: { x: 'b'.repeat(500), y: 'b'.repeat(500), z: 'b'.repeat(500), w: 'b'.repeat(500) },
  });
  assert.equal(
    (
      await req('/products/' + p.id + '/ai', 'POST', {
        version: p.version,
        client_key: randomUUID(),
        model: 'qa-local:small',
        destination: 'catalog',
        locale: 'pl',
      })
    ).statusCode,
    422,
  );
  const p2 = await product(),
    d = await queued(p2);
  result = { ...result, message: { role: 'assistant', content: 'x'.repeat(300000) } };
  assert.equal((await work(d)).state, 'failed');
  assert.equal((await ok('/products/' + p2.id)).version, p2.version);
});
test('Global inference lock defers another firm while OMS automation continues', async () => {
  await pool.query("UPDATE jobs SET state='done' WHERE kind<>'catalog.ai'");
  const p = await product();
  const rule = await ok('/automations', 'POST', {
    name: 'AI lane OMS proof',
    trigger: 'order.paid',
    note: 'OMS keeps running',
  });
  try {
    const o = await ok(
      '/orders',
      'POST',
      {
        email: 'qa-ai-lane@demo.local',
        customer_name: 'QA AI lane',
        warehouse_id: warehouse,
        items: [{ product_id: p.id, quantity: 1 }],
      },
      cookie,
      201,
    );
    await ok('/orders/' + o.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => ok(orderPath, 'GET', undefined), '/orders/' + o.id + '/status', { status: 'paid' }));
    const otherWarehouse = (await ok('/warehouses', 'GET', undefined, other)).data[0].id;
    const foreignProduct = await ok(
      '/products',
      'POST',
      {
        sku: 'AI-FOREIGN-' + randomUUID(),
        name: 'QA other firm',
        price: 100,
        quantity: 1,
        warehouse_id: otherWarehouse,
      },
      other,
      201,
    );
    const d = await queued(p),
      d2 = await ok(
        '/products/' + foreignProduct.id + '/ai',
        'POST',
        {
          version: foreignProduct.version,
          client_key: randomUUID(),
          model: 'qa-local:small',
          destination: 'catalog',
          locale: 'pl',
        },
        other,
        201,
      );
    assert.notEqual(d.tenant_id, d2.tenant_id);
    let release!: () => void, start!: () => void;
    const entered = new Promise<void>((r) => (start = r)),
      held = new Promise<void>((r) => (release = r));
    hook = async () => {
      start();
      await held;
    };
    const first = processCatalogAi(await job(d), transport);
    await entered;
    try {
      await processCatalogAi(await job(d2), transport);
      assert.equal(
        (await pool.query('SELECT state FROM jobs WHERE id=$1', [d2.job_id])).rows[0].state,
        'pending',
      );
      for (let n = 0; n < 10; n++) {
        await tick();
        if ((await ok('/orders/' + o.id)).note === 'OMS keeps running') break;
      }
      assert.equal((await ok('/orders/' + o.id)).note, 'OMS keeps running');
      assert.equal(chats().length, 1);
    } finally {
      release();
      await first;
    }
    hook = undefined;
    assert.equal((await work(d2)).state, 'ready');
    assert.equal(chats().length, 2);
  } finally {
    await pool.query('UPDATE automation_rules SET enabled=false WHERE id=$1', [rule.id]);
  }
});
test('Terminal lease recovery frees pending capacity without replaying inference', async () => {
  const d = await queued(await product()),
    j = await job(d);
  await pool.query("UPDATE jobs SET locked_at=now()-interval '3 minutes' WHERE id=$1", [j.id]);
  calls = [];
  await tickCatalogAi(transport);
  assert.equal(
    (await pool.query('SELECT state FROM ai_catalog_drafts WHERE id=$1', [d.id])).rows[0].state,
    'failed',
  );
  assert.equal(chats().length, 0);
});
test('Global capacity is atomic across five separate firms and is reusable after cancellation', async () => {
  for (let n = 0; n < 5; n++) {
    const signup = await req('/auth/signup', 'POST', {
      email: randomUUID() + '@example.test',
      password: 'LocalAiCapacity!2026',
      name: 'QA capacity',
      organization: { name: 'QA capacity ' + n },
    });
    assert.equal(signup.statusCode, 201, signup.body);
    const auth = String(signup.headers['set-cookie']).split(';')[0];
    const wh = (await ok('/warehouses', 'GET', undefined, auth)).data[0].id;
    const p = await ok(
      '/products',
      'POST',
      { sku: 'AI-CAP-' + n, name: 'QA capacity', price: 100, quantity: 1, warehouse_id: wh },
      auth,
      201,
    );
    for (let i = 0; i < (n === 4 ? 9 : 10); i++)
      await ok(
        '/products/' + p.id + '/ai',
        'POST',
        {
          version: p.version,
          client_key: randomUUID(),
          model: 'qa-local:small',
          destination: 'catalog',
          locale: 'pl',
        },
        auth,
        201,
      );
  }
  const p = await product();
  const request = () =>
    req('/products/' + p.id + '/ai', 'POST', {
      version: p.version,
      client_key: randomUUID(),
      model: 'qa-local:small',
      destination: 'catalog',
      locale: 'pl',
    });
  const race = await Promise.all([request(), request()]);
  assert.deepEqual(race.map((r) => r.statusCode).sort(), [201, 429]);
  assert.equal(Number((await pool.query('SELECT catalog_ai_pending_count() n')).rows[0].n), 50);
  await ok(
    '/ai/catalog/drafts/' + race.find((r) => r.statusCode === 201)!.json().id + '/cancel',
    'POST',
    {},
  );
  assert.equal((await request()).statusCode, 201);
  assert.equal(chats().length, 0);
});
