import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../server/app';
import { pool, migrate, tenantTx } from '../server/db';
import { seed, DEMO_TENANT, SECOND_TENANT } from './fixtures';
import {
  pumpBatch,
  tickDeepLBatches,
  processBatchJob,
  failBatchJob,
} from '../server/deepl-batches';
import { tickDeepL } from '../server/deepl-catalog';
import { tick } from '../server/worker';
import type { Transport } from '../server/integrations';
assert.equal(process.env.DYNA_TEST, 'true');
let app: Awaited<ReturnType<typeof buildApp>>,
  cookie: string,
  other: string,
  viewer: string,
  operator: string,
  channel: string,
  otherChannel: string,
  warehouse: string;
let calls: { url: string; init: any }[] = [],
  status = 200,
  malformed = false,
  invalid = false,
  network = false,
  usage: any,
  hook: (() => Promise<void>) | undefined;
const languages = ['pl', 'de', 'en-US', 'fr', 'es', 'it', 'nl'].map((lang) => ({
  lang,
  name: lang,
  usable_as_source: lang === 'pl',
  usable_as_target: lang !== 'pl',
  status: 'stable',
  features: {},
}));
const transport: Transport = async (url, init) => {
  calls.push({ url, init });
  if (url.includes('/v3/languages')) return Response.json(languages);
  if (url.endsWith('/v2/usage')) return Response.json(usage);
  assert(url.endsWith('/v2/translate'));
  if (hook) await hook();
  if (network) throw Error('PRIVATE_SECRET provider');
  if (status !== 200)
    return new Response('PRIVATE_SECRET provider', { status, headers: { 'Retry-After': '9' } });
  const b = JSON.parse(String(init?.body));
  if (malformed) return Response.json({ translations: [] });
  return Response.json({
    translations: b.text.map((s: string, i: number) => ({
      text: invalid && i === 0 ? '<script>unsafe</script>' : s,
      detected_source_language: 'PL',
      billed_characters: [...s].length,
      model_type_used: 'quality_optimized',
    })),
  });
};
const req = (path: string, method: any = 'GET', payload?: any, auth = cookie) =>
  app.inject({ url: '/api' + path, method, payload, headers: { cookie: auth } });
async function ok(path: string, method: any = 'GET', payload?: any, auth = cookie, code = 200) {
  const r = await req(path, method, payload, auth);
  assert.equal(r.statusCode, code, r.body);
  return r.json();
}
before(async () => {
  await migrate();
  await seed();
  app = await buildApp({ integrationTransport: transport });
  async function login(email: string) {
    const r = await req('/auth/login', 'POST', { email, password: 'DynaDemo!2026' }, '');
    assert.equal(r.statusCode, 200, r.body);
    return String(r.headers['set-cookie']).split(';')[0];
  }
  cookie = await login('admin@demo.local');
  other = await login('other@demo.local');
  viewer = await login('viewer@demo.local');
  operator = await login('operator@demo.local');
  warehouse = (await ok('/warehouses')).data[0].id;
  const connection = {
    provider: 'deepl',
    name: 'Bulk QA',
    mode: 'live',
    credentials: { api_key: 'bulk-test:fx' },
    settings: { api_plan: 'free' },
  };
  channel = (await ok('/integrations', 'POST', connection)).id;
  otherChannel = (await ok('/integrations', 'POST', connection, other)).id;
});
beforeEach(async () => {
  await pool.query(
    "UPDATE deepl_catalog_batches SET state='cancelled' WHERE state IN ('prepared','queued')",
  );
  await pool.query(
    "UPDATE deepl_catalog_drafts SET state='cancelled' WHERE state IN ('prepared','queued')",
  );
  await pool.query(
    "UPDATE ai_catalog_drafts SET state='cancelled' WHERE state IN ('prepared','queued')",
  );
  await pool.query(
    "UPDATE jobs SET state='done',lease_token=NULL,locked_at=NULL WHERE kind IN ('catalog.deepl','catalog.deepl.batch','catalog.ai') AND state IN ('pending','running')",
  );
  await pool.query('DELETE FROM deepl_key_cooldowns');
  calls = [];
  status = 200;
  malformed = false;
  invalid = false;
  network = false;
  hook = undefined;
  usage = { character_count: 0, character_limit: 50000000 };
  process.env.DYNA_ALLOW_EXTERNAL_TRANSLATION = 'true';
});
after(async () => {
  delete process.env.DYNA_ALLOW_EXTERNAL_TRANSLATION;
  await app.close();
  await pool.end();
});
const posts = () => calls.filter((c) => c.url.endsWith('/v2/translate'));
async function product(extra: any = {}) {
  return ok(
    '/products',
    'POST',
    {
      sku: 'BULK-' + randomUUID(),
      name: 'Kubek 🧋',
      description: 'Stal 350 ml.',
      price: 3000,
      quantity: 10,
      warehouse_id: warehouse,
      ...extra,
    },
    cookie,
    201,
  );
}
function body(ps: any[], extra: any = {}) {
  return {
    client_key: randomUUID(),
    channel_id: channel,
    source_lang: 'pl',
    target_langs: ['de', 'en-US'],
    products: ps.map((p) => ({ id: p.id, version: p.version })),
    ...extra,
  };
}
async function preview(ps: any[], extra: any = {}) {
  return ok('/deepl/batches/preview', 'POST', body(ps, extra), cookie, 201);
}
const queue = (b: any, extra: any = {}, auth = cookie) =>
  req(
    '/deepl/batches/' + b.id + '/queue',
    'POST',
    { confirm_external: true, max_characters: b.characters, ...extra },
    auth,
  );
const detail = (b: any, auth = cookie, page = 1) =>
  ok('/deepl/batches/' + b.id + '?page=' + page, 'GET', undefined, auth);
const drafts = async (b: any) =>
  (
    await pool.query(
      'SELECT * FROM deepl_catalog_drafts WHERE batch_id=$1 ORDER BY batch_ordinal',
      [b.id],
    )
  ).rows;
async function queued(ps: any[], extra: any = {}) {
  const b = await preview(ps, extra),
    r = await queue(b);
  assert.equal(r.statusCode, 200, r.body);
  return r.json();
}
async function workUntilFinished(b: any) {
  for (let i = 0; i < 200; i++) {
    await tickDeepLBatches({ transport });
    if (
      (await pool.query('SELECT state FROM deepl_catalog_batches WHERE id=$1', [b.id])).rows[0]
        .state === 'finished'
    )
      return;
  }
  throw Error('Batch not finished');
}
async function claim() {
  return (
    await pool.query(
      "UPDATE jobs SET state='running',attempts=attempts+1,lease_token=$1,locked_at=now() WHERE id=(SELECT id FROM jobs WHERE kind='catalog.deepl.batch' AND state='pending' ORDER BY created_at,id LIMIT 1) RETURNING *",
      [randomUUID()],
    )
  ).rows[0];
}
async function workJob(j: any) {
  try {
    await processBatchJob(j, { transport });
  } catch (e) {
    await failBatchJob(j, e);
  }
}
async function apply(b: any, p: any, extra: any = {}) {
  const all = (await drafts(b)).filter((d) => d.product_id === p.id);
  const ready = all.filter((d) => d.state === 'ready');
  const ds = ready.length ? ready : all;
  return req('/deepl/batches/' + b.id + '/products/' + p.id + '/apply', 'POST', {
    approve: true,
    version: p.version,
    texts: ds.map((d) => ({ draft_id: d.id, ...(d.output ?? d.source) })),
    ...extra,
  });
}

test('Preview freezes 2 products × 2 languages, Unicode budget, no text POST, canonical idempotency', async () => {
  const ps = [await product({ description: '' }), await product()],
    input = body(ps),
    b = await ok('/deepl/batches/preview', 'POST', input, cookie, 201);
  assert.equal(b.product_count, 2);
  assert.equal(b.draft_count, 4);
  assert.equal(b.characters, ps.reduce((n, p) => n + [...p.name, ...p.description].length, 0) * 2);
  assert.equal(posts().length, 0);
  const ds = await drafts(b);
  assert.equal(ds.length, 4);
  assert(
    ds.every(
      (d) =>
        d.source_version === 1 && new Date(d.expires_at).getTime() === Date.parse(b.expires_at),
    ),
  );
  assert.deepEqual(
    ds.map((d) => d.batch_ordinal),
    [0, 1, 2, 3],
  );
  const n = calls.length,
    replay = await ok(
      '/deepl/batches/preview',
      'POST',
      { ...input, products: [...input.products].reverse(), target_langs: ['EN-us', 'DE'] },
      cookie,
      201,
    );
  assert.equal(replay.id, b.id);
  assert.equal(calls.length, n);
  assert.equal(
    (await req('/deepl/batches/preview', 'POST', { ...input, target_langs: ['de'] })).statusCode,
    409,
  );
});
test('Tenant/role boundaries, duplicate scopes, unsupported language and aggregate quota', async () => {
  const p = await product(),
    b = await preview([p]);
  assert.equal((await req('/deepl/batches/' + b.id, 'GET', undefined, other)).statusCode, 404);
  for (const auth of [viewer, operator]) {
    assert.equal((await req('/deepl/batches', 'GET', undefined, auth)).statusCode, 403);
    assert.equal((await req('/deepl/batches/preview', 'POST', body([p]), auth)).statusCode, 403);
  }
  for (const extra of [
    {
      products: [
        { id: p.id, version: 1 },
        { id: p.id, version: 1 },
      ],
    },
    { target_langs: ['DE', 'de'] },
    { target_langs: ['de', 'xx'] },
    { source_lang: 'en-US' },
  ])
    assert(
      [400, 422].includes(
        (await req('/deepl/batches/preview', 'POST', body([p], extra))).statusCode,
      ),
    );
  assert.equal(
    (await req('/deepl/batches/preview', 'POST', body([p], { channel_id: otherChannel })))
      .statusCode,
    404,
  );
  usage.character_limit = 1;
  assert.equal((await req('/deepl/batches/preview', 'POST', body([p]))).statusCode, 422);
  assert.equal(posts().length, 0);
});
test('Budget consent, opt-in, version check and child action bypass are enforced', async () => {
  const p = await product(),
    b = await preview([p]),
    d = (await drafts(b))[0];
  assert.equal((await queue(b, { confirm_external: false })).statusCode, 422);
  assert.equal((await queue(b, { max_characters: b.characters - 1 })).statusCode, 422);
  delete process.env.DYNA_ALLOW_EXTERNAL_TRANSLATION;
  assert.equal((await queue(b)).statusCode, 423);
  process.env.DYNA_ALLOW_EXTERNAL_TRANSLATION = 'true';
  for (const verb of ['queue', 'cancel', 'apply'])
    assert.equal(
      (
        await req(
          '/deepl/drafts/' + d.id + '/' + verb,
          'POST',
          verb === 'queue'
            ? { confirm_external: true, max_characters: d.characters }
            : verb === 'apply'
              ? { approve: true, version: 1, name: 'Reviewed name', description: '' }
              : {},
        )
      ).statusCode,
      409,
    );
  await pool.query('UPDATE products SET version=version+1 WHERE id=$1', [p.id]);
  assert.equal((await queue(b)).statusCode, 409);
  assert.equal(posts().length, 0);
});
test('Bulk mapping including empty descriptions; all languages atomic, review replay and stock unchanged', async () => {
  const ps = [await product({ description: '' }), await product()],
    b = await queued(ps);
  assert.equal((await queue(b)).statusCode, 200);
  await workUntilFinished(b);
  assert.equal(posts().length, 2);
  for (const c of posts()) {
    const x = JSON.parse(String(c.init.body));
    assert.equal(x.text.length, 3);
    assert.equal(x.show_billed_characters, true);
    assert(['DE', 'EN-US'].includes(x.target_lang));
  }
  for (const p of ps) {
    const ds = (await drafts(b)).filter((d) => d.product_id === p.id);
    assert(ds.every((d) => d.state === 'ready'));
    assert(ds.every((d) => d.output.description === p.description && d.output.name === p.name));
    const reviewed = {
      approve: true,
      version: 1,
      texts: ds.map((d) => ({
        draft_id: d.id,
        name: 'Reviewed ' + d.target_lang,
        description: 'Approved',
      })),
    };
    assert.equal((await apply(b, p, { texts: [reviewed.texts[0]] })).statusCode, 409);
    assert.equal((await apply(b, p, reviewed)).statusCode, 200);
    assert.equal(
      (
        await req('/deepl/batches/' + b.id + '/products/' + p.id + '/apply', 'POST', reviewed)
      ).json().reused,
      true,
    );
    assert.equal(
      (
        await req('/deepl/batches/' + b.id + '/products/' + p.id + '/apply', 'POST', {
          ...reviewed,
          texts: reviewed.texts.map((t) => ({ ...t, name: 'Changed' })),
        })
      ).statusCode,
      409,
    );
    const current = await ok('/products/' + p.id);
    assert.equal(current.version, 2);
    assert.equal(current.price, p.price);
    assert.equal(current.name, p.name);
    assert.equal(
      current.stock.reduce((n: number, r: any) => n + Number(r.on_hand), 0),
      10,
    );
    assert.equal(
      current.stock.reduce((n: number, r: any) => n + Number(r.reserved), 0),
      0,
    );
    const tr = (await pool.query('SELECT * FROM product_translations WHERE product_id=$1', [p.id]))
      .rows;
    assert.equal(tr.length, 2);
    assert(tr.every((t) => t.deepl_draft_id && !t.ai_draft_id));
  }
});
test('Waiting for one language prevents early product apply', async () => {
  const p = await product(),
    b = await queued([p]);
  await tickDeepLBatches({ transport });
  assert.equal((await drafts(b)).filter((d) => d.state === 'ready').length, 1);
  assert.equal((await apply(b, p)).statusCode, 409);
  await workUntilFinished(b);
  assert.equal((await apply(b, p)).statusCode, 200);
});
test('CAS changed before dispatch excludes only affected product from remote charge', async () => {
  const ps = [await product(), await product()],
    b = await queued(ps);
  await pool.query('UPDATE products SET version=version+1 WHERE id=$1', [ps[0].id]);
  await workUntilFinished(b);
  const ds = await drafts(b);
  assert(
    ds
      .filter((d) => d.product_id === ps[0].id)
      .every((d) => d.state === 'conflict' && !d.attempted_at),
  );
  assert(ds.filter((d) => d.product_id === ps[1].id).every((d) => d.state === 'ready'));
  assert(posts().every((c) => JSON.parse(String(c.init.body)).text.length === 2));
});
test('Concurrent source edit after POST retains paid output but blocks application', async () => {
  const p = await product(),
    b = await queued([p]);
  hook = async () => {
    await pool.query('UPDATE products SET version=version+1 WHERE id=$1', [p.id]);
    hook = undefined;
  };
  await workUntilFinished(b);
  const ds = await drafts(b);
  assert(ds.some((d) => d.state === 'conflict' && d.output && d.usage));
  assert.equal((await apply(b, p)).statusCode, 409);
});
test('Cancel pending and in-flight portion retains charge without writing product', async () => {
  const ps = [await product(), await product()],
    b = await queued(ps);
  hook = async () => {
    const r = await ok('/deepl/batches/' + b.id + '/cancel', 'POST', {});
    assert.equal(r.already_started, 2);
    assert.equal(r.cancelled, 2);
    hook = undefined;
  };
  await tickDeepLBatches({ transport });
  const ds = await drafts(b);
  assert(ds.every((d) => d.state === 'cancelled'));
  assert.equal(ds.filter((d) => d.usage && d.output).length, 2);
  assert.equal(posts().length, 1);
  assert.equal((await apply(b, ps[0])).statusCode, 409);
  assert.equal((await ok('/products/' + ps[0].id)).version, 1);
});
test('Cancellation after applied product preserves immutable translations and historical batch', async () => {
  const p = await product(),
    b = await queued([p]);
  await workUntilFinished(b);
  assert.equal((await apply(b, p)).statusCode, 200);
  await ok('/deepl/batches/' + b.id + '/cancel', 'POST', {});
  assert((await drafts(b)).every((d) => d.state === 'applied'));
  assert.equal((await detail(b)).batch.state, 'cancelled');
  assert.equal((await ok('/products/' + p.id)).version, 2);
});
test('Malformed response and network POST failures are uncertain, never replayed, sanitized', async () => {
  for (const failure of ['malformed', 'network', '500']) {
    const p = await product(),
      b = await queued([p], { target_langs: ['de'] });
    malformed = failure === 'malformed';
    network = failure === 'network';
    status = failure === '500' ? 500 : 200;
    const n = posts().length;
    await workUntilFinished(b);
    const ds = await drafts(b);
    assert.equal(ds[0].state, 'uncertain');
    assert(!ds[0].error.includes('PRIVATE_SECRET'));
    await tickDeepLBatches({ transport });
    assert.equal(posts().length, n + 1);
  }
});
test('One invalid result retains known billing; independent outputs remain applicable', async () => {
  const ps = [await product(), await product()],
    b = await queued(ps, { target_langs: ['de'] });
  invalid = true;
  await workUntilFinished(b);
  const ds = await drafts(b);
  assert.equal(ds.filter((d) => d.state === 'failed').length, 1);
  assert(ds.every((d) => d.usage));
  assert(ds.find((d) => d.state === 'failed').output === null);
  assert.equal(ds.filter((d) => d.state === 'ready').length, 1);
  const good = ps.find((p) => ds.some((d) => d.product_id === p.id && d.state === 'ready'));
  assert.equal((await apply(b, good)).statusCode, 200);
});
test('403/456 rejects halt remaining waiting work and cause no automatic paid retry', async () => {
  for (const code of [403, 456]) {
    const ps = [await product(), await product()],
      b = await queued(ps);
    status = code;
    const n = posts().length;
    await workUntilFinished(b);
    assert((await drafts(b)).every((d) => d.state === 'failed'));
    assert.equal(posts().length, n + 1);
    assert((await detail(b)).batch.error);
  }
});
test('429/529 shared-key cooldown blocks a second firm and single translations before provider I/O', async () => {
  const p = await product(),
    b = await queued([p], { target_langs: ['de'] });
  status = 429;
  await tickDeepLBatches({ transport });
  const d = (await drafts(b))[0];
  assert.equal(d.state, 'queued');
  assert.equal(d.attempted_at, null);
  assert.equal((await pool.query('SELECT count(*)::int n FROM deepl_key_cooldowns')).rows[0].n, 1);
  const wh = (await ok('/warehouses', 'GET', undefined, other)).data[0].id,
    p2 = await ok(
      '/products',
      'POST',
      {
        sku: 'OTHER-' + randomUUID(),
        name: 'Other product',
        description: '',
        price: 100,
        quantity: 1,
        warehouse_id: wh,
      },
      other,
      201,
    );
  const b2 = await ok(
    '/deepl/batches/preview',
    'POST',
    body([p2], { channel_id: otherChannel, target_langs: ['de'] }),
    other,
    201,
  );
  assert.equal((await queue(b2, {}, other)).statusCode, 200);
  await pumpBatch();
  const j = await claim(),
    n = calls.length;
  status = 200;
  await workJob(j);
  assert.equal(calls.length, n);
  assert.equal(
    (await pool.query('SELECT state,attempts,run_at FROM jobs WHERE id=$1', [j.id])).rows[0].state,
    'pending',
  );
  const s = await ok(
    '/products/' + p2.id + '/deepl/preview',
    'POST',
    {
      version: 1,
      client_key: randomUUID(),
      channel_id: otherChannel,
      source_lang: 'pl',
      target_lang: 'de',
    },
    other,
    201,
  );
  await ok(
    '/deepl/drafts/' + s.id + '/queue',
    'POST',
    { confirm_external: true, max_characters: s.characters },
    other,
  );
  const beforeCalls = calls.length;
  await tickDeepL({ transport });
  assert.equal(calls.length, beforeCalls);
  // Fixture advances the persisted cooldown; production always honors provider timestamps.
  await pool.query("UPDATE deepl_key_cooldowns SET retry_until=now()-interval '1 second'");
  await pool.query(
    "UPDATE jobs SET run_at=now() WHERE kind='catalog.deepl.batch' AND state='pending'",
  );
  status = 529;
  await tickDeepLBatches({ transport });
  assert.equal(posts().at(-1)?.init.method, 'POST');
  assert.equal(
    (await pool.query('SELECT count(*)::int n FROM deepl_key_cooldowns WHERE retry_until>now()'))
      .rows[0].n,
    1,
  );
});
test('Request packing uses UTF8 JSON byte size, <=20 products and preserves empty fields', async () => {
  const ps = [];
  for (let i = 0; i < 10; i++)
    ps.push(await product({ name: '商品 ' + i, description: '漢'.repeat(9000) }));
  const b = await queued(ps, { target_langs: ['de'] });
  await workUntilFinished(b);
  assert(posts().length >= 3);
  for (const c of posts()) {
    assert(Buffer.byteLength(String(c.init.body)) <= 120 * 1024);
    assert(JSON.parse(String(c.init.body)).text.length <= 40);
  }
  assert((await drafts(b)).every((d) => d.state === 'ready'));
});
test('Shared single/bulk admission leaves exactly one slot and generic OMS worker ignores bulk jobs', async () => {
  const p = await product();
  for (let i = 0; i < 19; i++)
    await ok(
      '/products/' + p.id + '/deepl/preview',
      'POST',
      {
        version: 1,
        client_key: randomUUID(),
        channel_id: channel,
        source_lang: 'pl',
        target_lang: 'de',
      },
      cookie,
      201,
    );
  const ps = [await product(), await product()],
    b = await queued(ps);
  await pumpBatch();
  assert.equal((await drafts(b)).filter((d) => d.state === 'queued').length, 1);
  const bulk = (
    await pool.query(
      "SELECT id,state FROM jobs WHERE kind='catalog.deepl.batch' AND state='pending'",
    )
  ).rows;
  await tick({ transport });
  assert.equal(
    (await pool.query('SELECT state FROM jobs WHERE id=$1', [bulk[0].id])).rows[0].state,
    'pending',
  );
});
test('Full 500 × 6 batch has 3000 drafts, bounded queue, 100 product pages, no lost single history', async () => {
  // Bulk fixture avoids consuming the production HTTP rate limit with setup writes.
  const ps = await tenantTx(
    DEMO_TENANT,
    async (c) =>
      (
        await c.query(
          "INSERT INTO products(id,tenant_id,sku,name,description,price) SELECT gen_random_uuid(),$1,'BULK-SCALE-'||$2||'-'||i,'Scale '||i,'',100 FROM generate_series(1,500)i RETURNING *",
          [DEMO_TENANT, randomUUID()],
        )
      ).rows,
  );
  const single = await ok(
    '/products/' + ps[0].id + '/deepl/preview',
    'POST',
    {
      version: 1,
      client_key: randomUUID(),
      channel_id: channel,
      source_lang: 'pl',
      target_lang: 'de',
    },
    cookie,
    201,
  );
  const start = performance.now(),
    b = await queued(ps, { target_langs: ['de', 'en-US', 'fr', 'es', 'it', 'nl'] });
  assert.equal(b.draft_count, 3000);
  assert.equal((await drafts(b)).length, 3000);
  const last = await detail(b, cookie, 100);
  assert.equal(last.pages, 100);
  assert.equal(last.products.length, 5);
  assert.equal(last.products[0].drafts.length, 6);
  assert.equal((await ok('/products/' + ps[0].id + '/deepl')).data[0].id, single.id);
  await pumpBatch();
  assert.equal((await drafts(b)).filter((d) => d.state === 'queued').length, 19);
  assert.equal(await pumpBatch(), false);
  console.log(
    JSON.stringify({
      measurement: 'bulk-500x6-preview-queue-page100',
      milliseconds: Math.round(performance.now() - start),
      drafts: 3000,
      active: 19,
    }),
  );
  await ok('/deepl/drafts/' + single.id + '/cancel', 'POST', {});
  const processStart = performance.now();
  await workUntilFinished(b);
  const complete = await drafts(b);
  assert.equal(complete.length, 3000);
  assert(complete.every((d) => d.state === 'ready'));
  assert(posts().length >= 150 && posts().length <= 156);
  assert(posts().every((c) => JSON.parse(String(c.init.body)).text.length <= 20));
  assert.equal((await apply(b, ps[0])).statusCode, 200);
  assert.equal((await ok('/products/' + ps[0].id)).version, 2);
  assert.equal(
    (
      await pool.query('SELECT count(*)::int n FROM product_translations WHERE product_id=$1', [
        ps[0].id,
      ])
    ).rows[0].n,
    6,
  );
  console.log(
    JSON.stringify({
      measurement: 'bulk-3000-local-contract-drain',
      milliseconds: Math.round(performance.now() - processStart),
      provider_requests: posts().length,
      ready: 3000,
      applied_sample: 6,
    }),
  );
});
test('Three active batches maximum, tenant RLS, immutable scope and operational cooldown denied', async () => {
  const p = await product(),
    bs: any[] = [];
  for (let i = 0; i < 3; i++) bs.push(await preview([p]));
  assert.equal((await req('/deepl/batches/preview', 'POST', body([p]))).statusCode, 429);
  assert.equal(
    await tenantTx(
      SECOND_TENANT,
      async (c) =>
        (await c.query('SELECT * FROM deepl_catalog_batches WHERE id=$1', [bs[0].id])).rowCount,
    ),
    0,
  );
  await assert.rejects(
    tenantTx(DEMO_TENANT, async (c) =>
      c.query('UPDATE deepl_catalog_batches SET characters=characters+1 WHERE id=$1', [bs[0].id]),
    ),
    /immutable/,
  );
  await assert.rejects(
    tenantTx(DEMO_TENANT, async (c) =>
      c.query('DELETE FROM deepl_catalog_batches WHERE id=$1', [bs[0].id]),
    ),
    /permission denied/,
  );
  await assert.rejects(
    tenantTx(DEMO_TENANT, async (c) => c.query('SELECT * FROM deepl_key_cooldowns')),
    /permission denied/,
  );
  const d = (await drafts(bs[0]))[0];
  await assert.rejects(
    tenantTx(DEMO_TENANT, async (c) =>
      c.query('UPDATE deepl_catalog_drafts SET batch_sku=$2 WHERE id=$1', [d.id, 'changed']),
    ),
    /immutable/,
  );
});
test('History keyset pagination and foreign cursor; read-only preview denies every mutation without provider I/O', async () => {
  const p = await product(),
    b = await preview([p]);
  let first = await ok('/deepl/batches');
  assert.equal(first.data.length, 20);
  assert(first.cursor);
  const second = await ok('/deepl/batches?after=' + first.cursor);
  assert(second.data.every((s: any) => !first.data.some((f: any) => f.id === s.id)));
  assert.equal(
    (await req('/deepl/batches?after=' + b.id, 'GET', undefined, other)).statusCode,
    404,
  );
  const ro = await buildApp({
    readOnly: true,
    integrationTransport: async () => {
      throw Error('READONLY_PROVIDER_CALL');
    },
  });
  try {
    const rejected = await ro.inject({ url: '/api/deepl/batches/' + b.id, headers: { cookie } });
    assert.equal(rejected.statusCode, 401);
    const n = calls.length;
    for (const suffix of [
      '/preview',
      '/' + b.id + '/queue',
      '/' + b.id + '/cancel',
      '/' + b.id + '/products/' + p.id + '/apply',
    ]) {
      const r = await ro.inject({
        url: '/api/deepl/batches' + suffix,
        method: 'POST',
        payload: {},
        headers: { cookie },
      });
      assert.equal(r.statusCode, 423, r.body);
    }
    const login = await ro.inject({
      url: '/api/auth/login',
      method: 'POST',
      payload: { email: 'admin@demo.local', password: 'DynaDemo!2026' },
    });
    assert.equal(login.statusCode, 200, login.body);
    const previewCookie = String(login.headers['set-cookie']).split(';')[0];
    const r = await ro.inject({
      url: '/api/deepl/batches/' + b.id,
      headers: { cookie: previewCookie },
    });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(calls.length, n);
  } finally {
    await ro.close();
  }
});

async function ageBatch(b: any, column: 'preview_until' | 'expires_at') {
  // Controlled clock fixture only in the disposable DYNA_TEST database.
  assert.equal(process.env.DYNA_TEST, 'true');
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('ALTER TABLE deepl_catalog_batches DISABLE TRIGGER deepl_batch_immutable');
    await c.query(
      `UPDATE deepl_catalog_batches SET ${column}=now()-interval '1 minute' WHERE id=$1`,
      [b.id],
    );
    await c.query('ALTER TABLE deepl_catalog_batches ENABLE TRIGGER deepl_batch_immutable');
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}
test('Expired preview cannot queue; execution expiry blocks remote POST and preserves source', async () => {
  const p = await product(),
    b = await preview([p]);
  await ageBatch(b, 'preview_until');
  assert.equal((await queue(b)).statusCode, 409);
  await tickDeepLBatches({ transport });
  assert.equal((await detail(b)).batch.state, 'expired');
  assert((await drafts(b)).every((d) => d.state === 'cancelled'));
  const b2 = await queued([p]);
  await pumpBatch();
  await ageBatch(b2, 'expires_at');
  await tickDeepLBatches({ transport });
  assert.equal(posts().length, 0);
  assert.equal((await detail(b2)).batch.state, 'expired');
  assert((await drafts(b2)).every((d) => !['prepared', 'queued', 'ready'].includes(d.state)));
  assert.equal((await apply(b2, p)).statusCode, 409);
});
test('Expiry during remote POST retains usage as conflict instead of applicable ready output', async () => {
  const p = await product(),
    b = await queued([p], { target_langs: ['de'] });
  hook = async () => {
    await ageBatch(b, 'expires_at');
    hook = undefined;
  };
  await tickDeepLBatches({ transport });
  const d = (await drafts(b))[0];
  assert.equal(d.state, 'conflict');
  assert(d.output && d.usage);
  assert.equal((await apply(b, p)).statusCode, 409);
});
test('Lease recovery with paid marker is uncertain; no duplicate provider call', async () => {
  const p = await product(),
    b = await queued([p], { target_langs: ['de'] });
  await pumpBatch();
  const j = await claim();
  await pool.query("UPDATE jobs SET locked_at=now()-interval '3 minutes' WHERE id=$1", [j.id]);
  await pool.query('UPDATE deepl_catalog_drafts SET attempted_at=now() WHERE job_id=$1', [j.id]);
  await tickDeepLBatches({ transport });
  assert.equal((await drafts(b))[0].state, 'uncertain');
  assert.equal(posts().length, 0);
  await workJob(j);
  assert.equal(posts().length, 0);
});
test('Partial language failure allows one atomic review of the exact remaining ready set', async () => {
  const p = await product(),
    b = await queued([p]);
  invalid = true;
  await tickDeepLBatches({ transport });
  invalid = false;
  await workUntilFinished(b);
  const ds = await drafts(b);
  assert.deepEqual(ds.map((d) => d.state).sort(), ['failed', 'ready']);
  assert.equal((await apply(b, p)).statusCode, 200);
  assert.equal((await ok('/products/' + p.id)).version, 2);
  assert.equal(
    (
      await pool.query('SELECT count(*)::int n FROM product_translations WHERE product_id=$1', [
        p.id,
      ])
    ).rows[0].n,
    1,
  );
});
test('Two overlapping batches cannot overwrite a newer reviewed product version', async () => {
  const p = await product(),
    b1 = await queued([p]),
    b2 = await queued([p]);
  await workUntilFinished(b1);
  await workUntilFinished(b2);
  assert.equal((await apply(b1, p)).statusCode, 200);
  assert.equal((await apply(b2, p)).statusCode, 409);
  assert.equal((await ok('/products/' + p.id)).version, 2);
  assert((await drafts(b2)).every((d) => d.state === 'ready'));
});
test('Role or channel change after consent stops waiting work before provider I/O', async () => {
  const p = await product(),
    b = await queued([p]);
  await pool.query(
    'UPDATE channels SET settings=settings||\'{"api_plan":"pro"}\'::jsonb WHERE id=$1',
    [channel],
  );
  try {
    await workUntilFinished(b);
    assert((await drafts(b)).every((d) => d.state === 'conflict'));
    assert.equal(posts().length, 0);
  } finally {
    await pool.query(
      'UPDATE channels SET settings=settings||\'{"api_plan":"free"}\'::jsonb WHERE id=$1',
      [channel],
    );
  }
  const b2 = await queued([p]),
    member = (
      await pool.query(
        "SELECT user_id FROM memberships WHERE tenant_id=$1 AND role='admin' ORDER BY user_id LIMIT 1",
        [DEMO_TENANT],
      )
    ).rows[0];
  await pool.query("UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2", [
    DEMO_TENANT,
    member.user_id,
  ]);
  try {
    await tickDeepLBatches({ transport });
    assert((await drafts(b2)).every((d) => d.state === 'conflict'));
    assert.equal(posts().length, 0);
  } finally {
    await pool.query("UPDATE memberships SET role='admin' WHERE tenant_id=$1 AND user_id=$2", [
      DEMO_TENANT,
      member.user_id,
    ]);
  }
});
