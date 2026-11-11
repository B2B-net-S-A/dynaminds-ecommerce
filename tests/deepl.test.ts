import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../server/app';
import { pool, migrate, tenantTx } from '../server/db';
import { seed, DEMO_TENANT, SECOND_TENANT } from './fixtures';
import { DeepL } from '../server/deepl';
import { processDeepL, failDeepL, tickDeepL } from '../server/deepl-catalog';
import { tick } from '../server/worker';
import { processCatalogAi } from '../server/catalog-ai';
import type { Transport } from '../server/integrations';
assert.equal(process.env.DYNA_TEST, 'true');
let app: Awaited<ReturnType<typeof buildApp>>,
  cookie: string,
  other: string,
  viewer: string,
  operator: string,
  warehouse: string,
  channel: string;
let calls: { url: string; init: any }[] = [],
  usage: any,
  status = 200,
  rawFailure = false,
  malformed = false,
  hook: (() => Promise<void>) | undefined;
const langs = [
  {
    lang: 'pl',
    name: 'Polish',
    usable_as_source: true,
    usable_as_target: true,
    status: 'stable',
    features: {},
  },
  {
    lang: 'en',
    name: 'English',
    usable_as_source: true,
    usable_as_target: false,
    status: 'stable',
    features: {},
  },
  {
    lang: 'en-US',
    name: 'English US',
    usable_as_source: false,
    usable_as_target: true,
    status: 'stable',
    features: {},
  },
  {
    lang: 'de',
    name: 'German',
    usable_as_source: true,
    usable_as_target: true,
    status: 'stable',
    features: { formality: { status: 'stable' } },
  },
  {
    lang: 'xx',
    name: 'Beta',
    usable_as_source: true,
    usable_as_target: true,
    status: 'beta',
    features: {},
  },
];
const transport: Transport = async (url, init) => {
  calls.push({ url, init });
  if (url.includes('/v3/languages')) return Response.json(langs);
  if (url.endsWith('/v2/usage')) return Response.json(usage);
  assert(url.endsWith('/v2/translate'));
  if (hook) await hook();
  if (rawFailure) throw Error('SECRET private provider error');
  if (status !== 200)
    return new Response('SECRET private provider body', {
      status,
      headers: { 'Retry-After': '9' },
    });
  if (malformed) return Response.json({ translations: [] });
  const b = JSON.parse(String(init?.body));
  return Response.json({
    translations: b.text.map((s: string, i: number) => ({
      text: i ? 'Stainless steel, 350 ml. Black.' : 'Steel mug 350 ml',
      detected_source_language: 'PL',
      billed_characters: [...s].length,
      model_type_used: 'quality_optimized',
    })),
  });
};
const req = (p: string, method: any = 'GET', payload?: any, auth = cookie) =>
  app.inject({ url: '/api' + p, method, payload, headers: { cookie: auth } });
async function ok(p: string, method: any = 'GET', payload?: any, auth = cookie, code = 200) {
  const r = await req(p, method, payload, auth);
  assert.equal(r.statusCode, code, r.body);
  return r.json();
}
before(async () => {
  await migrate();
  await seed();
  app = await buildApp({ integrationTransport: transport });
  async function auth(email: string) {
    const r = await ok('/auth/login', 'POST', { email, password: 'DynaDemo!2026' }, '');
    return String(
      (await req('/auth/login', 'POST', { email, password: 'DynaDemo!2026' }, '')).headers[
        'set-cookie'
      ],
    ).split(';')[0];
  }
  cookie = await auth('admin@demo.local');
  other = await auth('other@demo.local');
  viewer = await auth('viewer@demo.local');
  operator = await auth('operator@demo.local');
  warehouse = (await ok('/warehouses')).data[0].id;
  channel = (
    await ok(
      '/integrations',
      'POST',
      {
        provider: 'deepl',
        name: 'DeepL QA',
        mode: 'live',
        credentials: { api_key: 'test-deepl-key:fx' },
        settings: { api_plan: 'free' },
      },
      cookie,
      200,
    )
  ).id;
});
beforeEach(async () => {
  await pool.query(
    "UPDATE deepl_catalog_drafts SET state='cancelled' WHERE state IN ('queued','prepared')",
  );
  await pool.query(
    "UPDATE jobs SET state='done' WHERE kind='catalog.deepl' AND state IN ('pending','running')",
  );
  await pool.query('DELETE FROM deepl_key_cooldowns');
  process.env.DYNA_ALLOW_EXTERNAL_TRANSLATION = 'true';
  // The preceding AI suite deliberately fills the global test queue. Release only its
  // unfinished synthetic jobs in this isolated database; production limits stay unchanged.
  await pool.query("UPDATE ai_catalog_drafts SET state='cancelled' WHERE state='queued'");
  await pool.query(
    "UPDATE jobs SET state='done' WHERE kind='catalog.ai' AND state IN ('pending','running')",
  );
  calls = [];
  usage = { character_count: 10, character_limit: 500000 };
  status = 200;
  rawFailure = false;
  malformed = false;
  hook = undefined;
});
after(async () => {
  delete process.env.DYNA_ALLOW_EXTERNAL_TRANSLATION;
  await app.close();
  await pool.end();
});
async function product(extra: any = {}) {
  return ok(
    '/products',
    'POST',
    {
      sku: 'DEEPL-' + randomUUID(),
      name: 'Kubek QA 🧋',
      description: 'Stal nierdzewna, 350 ml.',
      price: 3000,
      quantity: 10,
      warehouse_id: warehouse,
      ...extra,
    },
    cookie,
    201,
  );
}
async function preview(p: any, extra: any = {}) {
  return ok(
    '/products/' + p.id + '/deepl/preview',
    'POST',
    {
      version: p.version,
      client_key: randomUUID(),
      channel_id: channel,
      source_lang: 'pl',
      target_lang: 'en-US',
      formality: 'default',
      ...extra,
    },
    cookie,
    201,
  );
}
const queue = (d: any, extra: any = {}, auth = cookie) =>
  req(
    '/deepl/drafts/' + d.id + '/queue',
    'POST',
    { confirm_external: true, max_characters: d.characters, ...extra },
    auth,
  );
const apply = (d: any, extra: any = {}) =>
  req('/deepl/drafts/' + d.id + '/apply', 'POST', {
    approve: true,
    version: d.source_version,
    name: 'Reviewed steel mug',
    description: 'Reviewed description',
    ...extra,
  });
async function current(d: any) {
  return (await pool.query('SELECT * FROM deepl_catalog_drafts WHERE id=$1', [d.id])).rows[0];
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
  await pool.query('DELETE FROM deepl_key_cooldowns');
  const j = await job(d);
  try {
    await processDeepL(j, { transport });
  } catch (e) {
    await failDeepL(j, e);
  }
  return current(d);
}
const posts = () => calls.filter((c) => c.url.endsWith('/v2/translate'));
async function queued(p: any, extra: any = {}) {
  const d = await preview(p, extra),
    r = await queue(d);
  assert.equal(r.statusCode, 200, r.body);
  return r.json();
}

test('Fixed Free/Pro hosts, key/plan consistency, auth header and v3 stable language roles', async () => {
  const client = new DeepL({ api_plan: 'free' }, { api_key: 'test-deepl-key:fx' }, transport);
  const languages = await client.languages();
  assert.equal(languages.length, 4);
  assert.equal(languages.find((l) => l.lang === 'en')!.usable_as_target, false);
  assert.equal(calls[0].url, 'https://api-free.deepl.com/v3/languages?resource=translate_text');
  assert.equal(calls[0].init.headers.Authorization, 'DeepL-Auth-Key test-deepl-key:fx');
  assert.equal(calls[0].init.redirect, 'error');
  assert.equal(
    new DeepL({ api_plan: 'pro' }, { api_key: 'test-deepl-key' }, transport).base,
    'https://api.deepl.com',
  );
  assert.throws(() => new DeepL({ api_plan: 'pro' }, { api_key: 'test-deepl-key:fx' }, transport));
  assert.throws(
    () =>
      new DeepL(
        { api_plan: 'free', base: 'http://127.0.0.1' },
        { api_key: 'test-deepl-key:fx' },
        transport,
      ),
  );
  assert.equal((await req('/integrations/' + channel + '/test', 'POST', {})).statusCode, 200);
});
test('Preview sends no product text; explicit character budget/consent and external opt-in are required', async () => {
  const p = await product(),
    d = await preview(p);
  assert.equal(d.characters, [...p.name, ...p.description].length);
  assert.equal(posts().length, 0);
  for (const c of calls) assert.equal(c.init.body, undefined);
  assert.equal((await queue(d, { confirm_external: false })).statusCode, 422);
  assert.equal((await queue(d, { max_characters: 1 })).statusCode, 422);
  delete process.env.DYNA_ALLOW_EXTERNAL_TRANSLATION;
  assert.equal((await queue(d)).statusCode, 423);
  assert.equal(posts().length, 0);
});
test('Idempotent preview, queue, dispatch and apply preserve source and stock/price; en-US locale saved separately', async () => {
  const p = await product(),
    key = randomUUID(),
    d = await preview(p, { client_key: key });
  assert.equal((await preview(p, { client_key: key })).id, d.id);
  assert.equal(
    (
      await req('/products/' + p.id + '/deepl/preview', 'POST', {
        version: p.version,
        client_key: key,
        channel_id: channel,
        source_lang: 'pl',
        target_lang: 'de',
      })
    ).statusCode,
    409,
  );
  const q = (await queue(d)).json();
  assert.equal((await queue(d)).json().job_id, q.job_id);
  const ready = await work(q);
  assert.equal(ready.state, 'ready');
  assert.equal(posts().length, 1);
  const body = JSON.parse(String(posts()[0].init.body));
  assert.deepEqual(body.text, [p.name, p.description]);
  assert.equal(body.target_lang, 'EN-US');
  assert.equal(body.show_billed_characters, true);
  assert.equal(body.preserve_formatting, true);
  assert.equal((await ok('/products/' + p.id)).version, p.version);
  assert.equal((await apply(ready)).statusCode, 200);
  assert.equal((await apply(ready)).json().reused, true);
  assert.equal((await apply(ready, { name: 'Other title' })).statusCode, 409);
  const final = await ok('/products/' + p.id),
    hist = await ok('/products/' + p.id + '/deepl');
  assert.equal(final.name, p.name);
  assert.equal(final.description, p.description);
  assert.equal(final.price, p.price);
  assert.equal(final.stock.length, 1);
  assert.equal(final.stock[0].on_hand, 10);
  assert.equal(final.stock[0].reserved, 0);
  assert.equal(String(final.stock[0].version), '0');
  assert.equal(final.version, p.version + 1);
  assert.equal(hist.translations[0].locale, 'en-us');
  assert.equal(hist.translations[0].ai_draft_id, null);
  assert.equal(hist.translations[0].deepl_draft_id, d.id);
  assert.deepEqual(hist.data[0].source, { name: p.name, description: p.description });
  assert.equal(hist.data[0].output.name, 'Steel mug 350 ml');
  assert.equal(hist.data[0].reviewed_text.name, 'Reviewed steel mug');
});
test('Empty description is supported and sent as one text', async () => {
  const d = await queued(await product({ description: '' })),
    ready = await work(d);
  assert.equal(ready.output.description, '');
  assert.equal(JSON.parse(String(posts()[0].init.body)).text.length, 1);
});
test('Unsupported beta/target-only source/source-only target and formal register rejected before POST', async () => {
  const p = await product();
  for (const pair of [
    { source_lang: 'en-US' },
    { target_lang: 'en' },
    { target_lang: 'xx' },
    { formality: 'more' },
    { target_lang: 'pl' },
  ]) {
    assert.equal(
      (
        await req('/products/' + p.id + '/deepl/preview', 'POST', {
          version: p.version,
          client_key: randomUUID(),
          channel_id: channel,
          source_lang: 'pl',
          target_lang: 'en-US',
          ...pair,
        })
      ).statusCode,
      422,
    );
  }
  assert.equal((await preview(p, { target_lang: 'de', formality: 'more' })).state, 'prepared');
  assert.equal(posts().length, 0);
});
test('Account and API key character quotas validated and refreshed immediately before dispatch', async () => {
  const p = await product();
  usage = {
    character_count: 1,
    character_limit: 500000,
    api_key_character_count: 9,
    api_key_character_limit: 10,
  };
  assert.equal(
    (
      await req('/products/' + p.id + '/deepl/preview', 'POST', {
        version: p.version,
        client_key: randomUUID(),
        channel_id: channel,
        source_lang: 'pl',
        target_lang: 'en-US',
      })
    ).statusCode,
    422,
  );
  usage = { character_count: 0, character_limit: 500000 };
  const d = await queued(p);
  usage = { character_count: 500000, character_limit: 500000 };
  const failed = await work(d);
  assert.equal(failed.state, 'failed');
  assert.equal(failed.attempted_at, null);
  assert.equal(posts().length, 0);
  usage = { character_count: 0, character_limit: 500000, api_key_character_limit: 100 };
  await assert.rejects(() =>
    new DeepL({ api_plan: 'free' }, { api_key: 'test-deepl-key:fx' }, transport).usage(),
  );
});
test('Current role and tenant scope enforced on preview, queue, history and apply', async () => {
  const p = await product(),
    d = await preview(p);
  assert.equal(
    (await req('/products/' + p.id + '/deepl', 'GET', undefined, other)).statusCode,
    404,
  );
  assert.equal((await queue(d, {}, other)).statusCode, 404);
  assert.equal((await queue(d, {}, viewer)).statusCode, 403);
  assert.equal((await queue(d, {}, operator)).statusCode, 403);
  assert.equal(
    (await req('/integrations/' + channel + '/deepl', 'GET', undefined, other)).statusCode,
    404,
  );
  assert.equal(
    (await req('/products/' + p.id + '/deepl', 'GET', undefined, viewer)).statusCode,
    403,
  );
});
test('Product and channel changes before dispatch prevent billable POST', async () => {
  const p = await product(),
    d = await queued(p);
  await pool.query('UPDATE products SET version=version+1 WHERE id=$1', [p.id]);
  assert.equal((await work(d)).state, 'conflict');
  assert.equal(posts().length, 0);
  const d2 = await queued(await product());
  await pool.query(
    'UPDATE channels SET settings=settings||\'{"changed":true}\'::jsonb WHERE id=$1',
    [channel],
  );
  assert.equal((await work(d2)).state, 'conflict');
  assert.equal(posts().length, 0);
  await pool.query("UPDATE channels SET settings=settings-'changed' WHERE id=$1", [channel]);
});
test('Product change while translating preserves paid result as conflict and prevents apply', async () => {
  const p = await product(),
    d = await queued(p);
  hook = async () => {
    await pool.query('UPDATE products SET version=version+1 WHERE id=$1', [p.id]);
  };
  const out = await work(d);
  assert.equal(out.state, 'conflict');
  assert.equal(out.output.name, 'Steel mug 350 ml');
  assert.equal(out.usage.billed_characters, d.characters);
  assert.equal((await apply(out)).statusCode, 409);
});
test('Role revoked during POST preserves returned output/usage without applying', async () => {
  const d = await queued(await product()),
    a = (await pool.query("SELECT id FROM users WHERE email='admin@demo.local'")).rows[0];
  hook = async () => {
    await pool.query("UPDATE memberships SET role='viewer' WHERE user_id=$1 AND tenant_id=$2", [
      a.id,
      DEMO_TENANT,
    ]);
  };
  try {
    const out = await work(d);
    assert.equal(out.state, 'conflict');
    assert(out.output);
    assert(out.usage);
    assert.match(out.error, /uprawnienia/);
  } finally {
    await pool.query("UPDATE memberships SET role='admin' WHERE user_id=$1 AND tenant_id=$2", [
      a.id,
      DEMO_TENANT,
    ]);
  }
});
test('Cancel before dispatch prevents POST; attempted dispatch cannot be cancelled; ready result can be discarded', async () => {
  const d = await queued(await product());
  await ok('/deepl/drafts/' + d.id + '/cancel', 'POST', {});
  assert.equal((await work(d)).state, 'cancelled');
  assert.equal(posts().length, 0);
  const d2 = await queued(await product());
  hook = async () => {
    assert.equal((await req('/deepl/drafts/' + d2.id + '/cancel', 'POST', {})).statusCode, 409);
  };
  const ready = await work(d2);
  assert.equal(ready.state, 'ready');
  await ok('/deepl/drafts/' + d2.id + '/cancel', 'POST', {});
  assert.equal((await current(d2)).state, 'cancelled');
});
for (const code of [429, 529])
  test(`HTTP ${code} rejection is retried with backoff, at most three attempts`, async () => {
    const d = await queued(await product());
    status = code;
    assert.equal((await work(d)).state, 'queued');
    let j = (await pool.query('SELECT * FROM jobs WHERE id=$1', [d.job_id])).rows[0];
    assert.equal(j.state, 'pending');
    assert(new Date(j.run_at).getTime() > Date.now() + 7000);
    assert.equal((await current(d)).attempted_at, null);
    await work(d);
    const out = await work(d);
    assert.equal(out.state, 'failed');
    assert.equal(posts().length, 3);
    assert(!out.error.includes('SECRET'));
  });
for (const variant of ['network', 'http500', 'malformed'])
  test(`Ambiguous POST ${variant} is not retried or exposed`, async () => {
    const d = await queued(await product());
    rawFailure = variant === 'network';
    status = variant === 'http500' ? 500 : 200;
    malformed = variant === 'malformed';
    const out = await work(d);
    assert.equal(out.state, 'uncertain');
    assert(out.attempted_at);
    assert(!out.error.includes('SECRET'));
    assert.equal((await queue(out)).statusCode, 409);
    await tickDeepL({ transport });
    assert.equal(posts().length, 1);
  });
test('Definite quota rejection stops without retry', async () => {
  const d = await queued(await product());
  status = 456;
  const out = await work(d);
  assert.equal(out.state, 'failed');
  assert.match(out.error, /Limit znaków/);
  assert.equal(posts().length, 1);
});
test('Generic OMS reclaimer cannot replay expired DeepL lease; dedicated reclaimer marks uncertainty', async () => {
  const d = await queued(await product());
  await job(d);
  await pool.query('UPDATE deepl_catalog_drafts SET attempted_at=now() WHERE id=$1', [d.id]);
  await pool.query("UPDATE jobs SET locked_at=now()-interval '3 minutes' WHERE id=$1", [d.job_id]);
  await tick({ transport });
  assert.equal(
    (await pool.query('SELECT state FROM jobs WHERE id=$1', [d.job_id])).rows[0].state,
    'running',
  );
  await tickDeepL({ transport });
  assert.equal((await current(d)).state, 'uncertain');
  assert.equal(posts().length, 0);
});
test('Per-key lock defers second worker even across firms, without blocking generic OMS worker', async () => {
  const p = await product(),
    d = await queued(p);
  const wh = (await ok('/warehouses', 'GET', undefined, other)).data[0].id;
  const ch = (
    await ok(
      '/integrations',
      'POST',
      {
        provider: 'deepl',
        name: 'Shared key QA',
        mode: 'live',
        credentials: { api_key: 'test-deepl-key:fx' },
        settings: { api_plan: 'free' },
      },
      other,
      200,
    )
  ).id;
  const op = await ok(
    '/products',
    'POST',
    {
      sku: 'DEEPL-' + randomUUID(),
      name: 'Other cup',
      description: 'Other description',
      price: 1000,
      quantity: 2,
      warehouse_id: wh,
    },
    other,
    201,
  );
  const od = await ok(
    '/products/' + op.id + '/deepl/preview',
    'POST',
    {
      version: op.version,
      client_key: randomUUID(),
      channel_id: ch,
      source_lang: 'pl',
      target_lang: 'de',
    },
    other,
    201,
  );
  const oq = (await queue(od, {}, other)).json();
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((r) => {
      release = r;
    }),
    start = new Promise<void>((r) => {
      entered = r;
    });
  hook = async () => {
    entered();
    await gate;
  };
  const first = work(d);
  await start;
  try {
    await processDeepL(await job(oq), { transport });
    await tick({ transport });
    const j = (await pool.query('SELECT * FROM jobs WHERE id=$1', [oq.job_id])).rows[0];
    assert.equal(j.state, 'pending');
    assert.equal(j.attempts, 0);
    assert.equal(posts().length, 1);
  } finally {
    release();
    await first;
  }
});
test('Frozen history and tenant RLS survive; application cannot delete a draft', async () => {
  const d = await preview(await product());
  await assert.rejects(() =>
    tenantTx(DEMO_TENANT, (c) =>
      c.query('UPDATE deepl_catalog_drafts SET source=$2 WHERE id=$1', [
        d.id,
        JSON.stringify({ name: 'Changed', description: '' }),
      ]),
    ),
  );
  await assert.rejects(() =>
    tenantTx(DEMO_TENANT, (c) => c.query('DELETE FROM deepl_catalog_drafts WHERE id=$1', [d.id])),
  );
  assert.equal(
    (
      await tenantTx(SECOND_TENANT, (c) =>
        c.query('SELECT id FROM deepl_catalog_drafts WHERE id=$1', [d.id]),
      )
    ).rowCount,
    0,
  );
});
test('Local example is explicit simulation, isolated and needs no external opt-in or external HTTP', async () => {
  const ch = await ok('/integrations/deepl-example', 'POST', {});
  assert(ch.simulation);
  delete process.env.DYNA_ALLOW_EXTERNAL_TRANSLATION;
  const d = await queued(await product({ name: 'Kubek stalowy 350 ml' }), {
    channel_id: ch.channel_id,
  });
  const out = await work(d);
  assert.equal(out.output.name, 'Stainless steel mug 350 ml');
  assert.equal(out.simulation, true);
  assert.equal(calls.length, 0);
});
test('Readonly recovery enforces role/tenant on metadata and never contacts provider; five writes blocked', async () => {
  const p = await product(),
    d = await preview(p),
    ro = await buildApp({ readOnly: true, previewPort: 4193, integrationTransport: transport });
  async function auth(email: string) {
    const r = await ro.inject({
      url: '/api/auth/login',
      method: 'POST',
      payload: { email, password: 'DynaDemo!2026' },
    });
    assert.equal(r.statusCode, 200);
    return String(r.headers['set-cookie']).split(';')[0];
  }
  try {
    const a = await auth('admin@demo.local'),
      v = await auth('viewer@demo.local'),
      o = await auth('other@demo.local');
    calls = [];
    const endpoint = '/api/integrations/' + channel + '/deepl';
    assert.equal(
      (await ro.inject({ url: endpoint, headers: { cookie: a } })).json().read_only,
      true,
    );
    assert.equal((await ro.inject({ url: endpoint, headers: { cookie: v } })).statusCode, 403);
    assert.equal((await ro.inject({ url: endpoint, headers: { cookie: o } })).statusCode, 404);
    for (const pth of [
      '/products/' + p.id + '/deepl/preview',
      '/deepl/drafts/' + d.id + '/queue',
      '/deepl/drafts/' + d.id + '/apply',
      '/deepl/drafts/' + d.id + '/cancel',
      '/integrations/deepl-example',
    ])
      assert.equal(
        (
          await ro.inject({
            url: '/api' + pth,
            method: 'POST',
            payload: {},
            headers: { cookie: a },
          })
        ).statusCode,
        423,
      );
    assert.equal(calls.length, 0);
    assert.equal((await ro.inject({ url: endpoint, headers: { cookie } })).statusCode, 401);
  } finally {
    await ro.close();
  }
});
test('Twenty active previews are counted atomically; cancellation releases capacity', async () => {
  const p = await product();
  const results = await Promise.all(
    Array.from({ length: 22 }, () =>
      req('/products/' + p.id + '/deepl/preview', 'POST', {
        version: p.version,
        client_key: randomUUID(),
        channel_id: channel,
        source_lang: 'pl',
        target_lang: 'de',
      }),
    ),
  );
  assert.equal(results.filter((r) => r.statusCode === 201).length, 20);
  assert.equal(results.filter((r) => r.statusCode === 429).length, 2);
  await ok(
    '/deepl/drafts/' + results.find((r) => r.statusCode === 201)!.json().id + '/cancel',
    'POST',
    {},
  );
  assert.equal((await preview(p)).state, 'prepared');
});
test('AI and DeepL can replace the same locale while maintaining a single provenance', async () => {
  const p = await product(),
    d = await queued(p, { target_lang: 'de' });
  const ready = await work(d);
  assert.equal((await apply(ready)).statusCode, 200);
  const aiTransport: Transport = async (url) =>
    url.endsWith('/api/tags')
      ? Response.json({
          models: [
            {
              name: 'qa-deepl-ai:small',
              digest: 'a'.repeat(64),
              size: 100,
              details: { format: 'gguf' },
            },
          ],
        })
      : Response.json({
          model: 'qa-deepl-ai:small',
          done: true,
          done_reason: 'stop',
          message: {
            role: 'assistant',
            content: JSON.stringify({ name: 'Stahlbecher 350 ml', description: 'Aus Edelstahl.' }),
          },
          prompt_eval_count: 5,
          eval_count: 5,
          total_duration: 1000,
        });
  const combined = await buildApp({ integrationTransport: aiTransport });
  try {
    const r = await combined.inject({
      url: '/api/products/' + p.id + '/ai',
      method: 'POST',
      headers: { cookie },
      payload: {
        version: p.version + 1,
        client_key: randomUUID(),
        model: 'qa-deepl-ai:small',
        destination: 'translation',
        locale: 'de',
      },
    });
    assert.equal(r.statusCode, 201, r.body);
    const a = r.json();
    await processCatalogAi(await job(a), aiTransport);
    const applied = await req('/ai/catalog/drafts/' + a.id + '/apply', 'POST', {
      approve: true,
      version: p.version + 1,
      name: 'Stahlbecher 350 ml',
      description: 'Aus Edelstahl.',
    });
    assert.equal(applied.statusCode, 200, applied.body);
    let t = (await ok('/products/' + p.id + '/deepl')).translations[0];
    assert.equal(t.ai_draft_id, a.id);
    assert.equal(t.deepl_draft_id, null);
    const d2 = await queued(await ok('/products/' + p.id), { target_lang: 'de' });
    const ready2 = await work(d2);
    assert.equal((await apply(ready2)).statusCode, 200);
    t = (await ok('/products/' + p.id + '/deepl')).translations[0];
    assert.equal(t.ai_draft_id, null);
    assert.equal(t.deepl_draft_id, d2.id);
    assert.equal(t.version, 3);
  } finally {
    await combined.close();
  }
});
test('Expired preview cannot be queued, dispatched or applied', async () => {
  const d = await preview(await product()),
    id = randomUUID();
  // Insert an already-expired fixture rather than weakening the immutable timestamp trigger.
  await pool.query(
    "INSERT INTO deepl_catalog_drafts SELECT (jsonb_populate_record(NULL::deepl_catalog_drafts,to_jsonb(d)||jsonb_build_object('id',$2::text,'client_key',$3::text,'expires_at',(now()-interval '1 minute')::text))).* FROM deepl_catalog_drafts d WHERE id=$1",
    [d.id, id, randomUUID()],
  );
  let expired = await current({ id });
  assert.equal((await queue(expired)).statusCode, 409);
  const jid = randomUUID();
  await pool.query(
    "INSERT INTO jobs(id,tenant_id,kind,payload,dedup_key,max_attempts) VALUES($1,$2,'catalog.deepl',$3,$4,3)",
    [jid, DEMO_TENANT, JSON.stringify({ draft_id: id, actor_id: d.actor_id }), 'deepl:' + id],
  );
  await pool.query("UPDATE deepl_catalog_drafts SET state='queued',job_id=$2 WHERE id=$1", [
    id,
    jid,
  ]);
  expired = await work(await current({ id }));
  assert.equal(expired.state, 'conflict');
  assert.equal(posts().length, 0);
  await pool.query("UPDATE deepl_catalog_drafts SET state='ready',output=$2 WHERE id=$1", [
    id,
    JSON.stringify({ name: 'Returned translation', description: '' }),
  ]);
  assert.equal((await apply(await current({ id }))).statusCode, 409);
});

test('Retry-After is never shortened, including HTTP date; a delay past preview expiry stops', async () => {
  const client = (header: string) =>
    new DeepL(
      { api_plan: 'free' },
      { api_key: 'test-deepl-key:fx' },
      async () => new Response('', { status: 429, headers: { 'Retry-After': header } }),
    );
  await assert.rejects(
    () => client('600').languages(),
    (e: any) => e.retryAfter === 600,
  );
  const date = new Date(Date.now() + 600000).toUTCString();
  await assert.rejects(
    () => client(date).languages(),
    (e: any) => e.retryAfter >= 599 && e.retryAfter <= 600,
  );
  const d = await queued(await product()),
    j = await job(d);
  let rejection: unknown;
  try {
    await processDeepL(j, {
      transport: async (url, init) =>
        url.endsWith('/v2/translate')
          ? new Response('', { status: 429, headers: { 'Retry-After': '3600' } })
          : transport(url, init),
    });
  } catch (e) {
    rejection = e;
  }
  assert(rejection);
  await failDeepL(j, rejection);
  // Explicit failure handling uses the returned rejection; no second POST is scheduled.

  assert.equal((await current(d)).state, 'failed');
  assert.equal(
    (await pool.query('SELECT state FROM jobs WHERE id=$1', [d.job_id])).rows[0].state,
    'failed',
  );
});
