import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../server/app';
import { pool, migrate, tenantTx } from '../server/db';
import { seed, DEMO_TENANT, SECOND_TENANT } from './fixtures';
import { encrypt } from '../server/security';
import { SHOPIFY_VERSION } from '../server/shopify';
import {
  processTranslation,
  failTranslation,
  queueTranslationInTx,
} from '../server/shopify-translations';
import { tickDeepL } from '../server/deepl-catalog';
import { tick } from '../server/worker';
assert.equal(process.env.DYNA_TEST, 'true');
let app: Awaited<ReturnType<typeof buildApp>>,
  cookie = '',
  other = '',
  viewer = '',
  operator = '',
  warehouse = '',
  otherWarehouse = '',
  deepl = '',
  otherDeepL = '',
  user = '',
  ip = 1;
let calls: any[] = [],
  beforeResponse: (() => Promise<void>) | undefined,
  beforeMutation: (() => Promise<void>) | undefined,
  afterMutation: (() => Promise<void>) | undefined,
  mode = '',
  seq = 950000;
const variants = new Map<string, any>(),
  resources = new Map<string, any>();
const json = (data: any, status = 200) =>
  new Response(JSON.stringify({ data }), {
    status,
    headers: { 'X-Shopify-API-Version': SHOPIFY_VERSION },
  });
const transport = async (url: string, init: RequestInit) => {
  const b = JSON.parse(String(init.body)),
    op = b.query.match(/^(?:query|mutation) (\w+)/)?.[1];
  calls.push({ op, variables: b.variables });
  if (op === 'DynaOffer' || op === 'DynaTranslationProductIdentity') {
    const v = variants.get(b.variables.id ?? b.variables.variantId);
    return json({
      shop: { id: 'gid://shopify/Shop/95', myshopifyDomain: new URL(url).hostname },
      productVariant: { id: v.id, sku: v.sku, product: { id: v.productId, status: 'ACTIVE' } },
    });
  }
  if (op === 'DynaProductTranslation' || op === 'DynaProductTranslationEvidence') {
    const v = variants.get(b.variables.variantId),
      r = resources.get(b.variables.resourceId);
    if (beforeResponse) await beforeResponse();
    return json({
      shop: { id: 'gid://shopify/Shop/95', myshopifyDomain: new URL(url).hostname },
      currentAppInstallation: {
        accessScopes: (r.scopes ?? ['read_products', 'write_translations', 'read_locales']).map(
          (handle: string) => ({ handle }),
        ),
      },
      shopLocales: r.locales ?? [
        { locale: 'pl', name: 'Polski', primary: true, published: true },
        { locale: 'de', name: 'Deutsch', primary: false, published: true },
        { locale: 'en', name: 'English', primary: false, published: true },
        { locale: 'fr', name: 'Français', primary: false, published: false },
      ],
      productVariant: v ? { id: v.id, sku: v.sku, product: { id: v.productId } } : undefined,
      translatableResource: {
        resourceId: b.variables.resourceId,
        translatableContent: r.source,
        translations: (r.translations ?? []).filter((t: any) => t.locale === b.variables.locale),
      },
    });
  }
  if (op === 'DynaProductTranslationRegister') {
    if (beforeMutation) await beforeMutation();
    const r = resources.get(b.variables.resourceId);
    if (mode === 'reject')
      return json({
        translationsRegister: {
          translations: null,
          userErrors: [{ field: ['translations', '0'], message: 'Rejected' }],
        },
      });
    if (mode === 'http500') return json({}, 500);
    const input =
      mode === 'partial' ? b.variables.translations.slice(0, 1) : b.variables.translations;
    for (const f of input) {
      r.translations = r.translations.filter(
        (t: any) => !(t.key === f.key && t.locale === f.locale && t.market === null),
      );
      r.translations.push({
        key: f.key,
        locale: f.locale,
        value: f.value,
        outdated: false,
        updatedAt: new Date().toISOString(),
        market: null,
      });
    }
    if (afterMutation) await afterMutation();
    if (mode === 'lost') throw new Error('PRIVATE_PROVIDER_TOKEN connection lost');
    return json({
      translationsRegister: {
        translations: input.map((f: any) =>
          r.translations.find(
            (t: any) => t.key === f.key && t.locale === f.locale && t.market === null,
          ),
        ),
        userErrors:
          mode === 'partial' ? [{ field: ['translations', '1'], message: 'Digest mismatch' }] : [],
      },
    });
  }
  throw new Error('Unexpected ' + op);
};
const req = (p: string, m: any = 'GET', b?: any, a = cookie) =>
  app.inject({
    url: '/api' + p,
    method: m,
    payload: b,
    headers: { cookie: a },
    remoteAddress: '127.0.11.' + ip,
  });
async function ok(p: string, m: any = 'GET', b?: any, a = cookie, code = 200) {
  const r = await req(p, m, b, a);
  assert.equal(r.statusCode, code, r.body);
  return r.json();
}
async function login(email: string) {
  const r = await req('/auth/login', 'POST', { email, password: 'DynaDemo!2026' }, '');
  assert.equal(r.statusCode, 200, r.body);
  return r.headers['set-cookie']!.toString().split(';')[0];
}
before(async () => {
  await migrate();
  await seed();
  app = await buildApp({ integrationTransport: transport });
  cookie = await login('admin@demo.local');
  other = await login('other@demo.local');
  viewer = await login('viewer@demo.local');
  operator = await login('operator@demo.local');
  warehouse = (await ok('/warehouses')).data[0].id;
  otherWarehouse = (await ok('/warehouses', 'GET', undefined, other)).data[0].id;
  user = (await ok('/auth/me')).user.id;
  deepl = (await ok('/integrations/deepl-example', 'POST', {})).channel_id;
  otherDeepL = (await ok('/integrations/deepl-example', 'POST', {}, other)).channel_id;
});
beforeEach(async () => {
  ip++;
  await pool.query(
    "UPDATE shopify_translation_batches SET state='cancelled' WHERE state<>'cancelled'",
  );
  calls = [];
  beforeResponse = undefined;
  beforeMutation = undefined;
  afterMutation = undefined;
  mode = '';
  await pool.query("UPDATE memberships SET role='admin' WHERE tenant_id=$1 AND user_id=$2", [
    DEMO_TENANT,
    user,
  ]);
  await pool.query(
    "UPDATE shopify_translation_plans SET state='cancelled' WHERE state IN ('preview','queued') AND phase='fresh'",
  );
  await pool.query(
    "UPDATE shopify_translation_plans SET state='uncertain' WHERE state='queued' AND phase='attempted'",
  );
  await pool.query(
    "UPDATE shopify_translation_plans SET state='abandoned' WHERE state='uncertain'",
  );
  await pool.query('DELETE FROM shopify_translation_claims');
  await pool.query(
    "UPDATE jobs SET state='done',lease_token=NULL,locked_at=NULL WHERE kind IN ('shopify.translation','catalog.deepl','catalog.ai') AND state IN ('pending','running')",
  );
  await pool.query(
    "UPDATE deepl_catalog_drafts SET state='cancelled' WHERE state IN ('prepared','queued')",
  );
  await pool.query("UPDATE ai_catalog_drafts SET state='cancelled' WHERE state='queued'");
});
after(async () => {
  await app.close();
  await pool.end();
});
async function approved(p: any, a = cookie, locale = 'de') {
  const d = await ok(
    `/products/${p.id}/deepl/preview`,
    'POST',
    {
      version: p.version,
      client_key: randomUUID(),
      channel_id: a === other ? otherDeepL : deepl,
      source_lang: 'pl',
      target_lang: locale === 'en-us' ? 'en-US' : locale,
      formality: 'default',
    },
    a,
    201,
  );
  await ok(
    `/deepl/drafts/${d.id}/queue`,
    'POST',
    { confirm_external: true, max_characters: d.characters },
    a,
  );
  await tickDeepL({ transport });
  await ok(
    `/deepl/drafts/${d.id}/apply`,
    'POST',
    {
      approve: true,
      version: p.version,
      name: 'Becher 350 ml',
      description: 'Stahlbecher. Volumen 350 ml.',
    },
    a,
  );
  return ok(`/products/${p.id}`, 'GET', undefined, a);
}
async function fixture(a = cookie, shared?: any) {
  let p = await ok(
    '/products',
    'POST',
    {
      sku: 'QA-LOCAL-' + randomUUID(),
      name: 'Kubek stalowy 350 ml',
      description: 'Stal. Pojemność 350 ml.',
      price: 3000,
      quantity: 10,
      warehouse_id: a === other ? otherWarehouse : warehouse,
    },
    a,
    201,
  );
  p = await approved(p, a);
  const ch = await ok(
    '/integrations',
    'POST',
    {
      provider: 'shopify',
      name: 'Translation QA',
      mode: 'sandbox',
      settings: { store_url: shared?.store ?? 'https://qa-' + randomUUID() + '.myshopify.com' },
      credentials: { access_token: 'qa-translations-token-2026' },
    },
    a,
  );
  const id = 'gid://shopify/ProductVariant/' + ++seq,
    productId = shared?.remoteProduct ?? 'gid://shopify/Product/' + ++seq;
  variants.set(id, { id, productId, sku: p.sku });
  if (!resources.has(productId))
    resources.set(productId, {
      source: [
        { key: 'title', value: p.name, digest: 'title-' + seq, locale: 'pl' },
        {
          key: 'body_html',
          value: '<p>' + p.description + '</p>',
          digest: 'body-' + seq,
          locale: 'pl',
        },
      ],
      translations: [],
    });
  const listing = await ok(
    `/integrations/${ch.id}/mappings`,
    'POST',
    { external_id: id, sku: p.sku },
    a,
  );
  return {
    p,
    ch,
    listing,
    remoteProduct: productId,
    store:
      ch.settings?.store_url ??
      (await pool.query('SELECT settings FROM channels WHERE id=$1', [ch.id])).rows[0].settings
        .store_url,
    a,
  };
}
const previewBody = (f: any, extra: any = {}) => ({
  client_key: randomUUID(),
  listing_id: f.listing.id,
  version: f.p.version,
  local_locale: 'de',
  translation_version: 1,
  target_locale: 'de',
  fields: ['title', 'body_html'],
  ...extra,
});
const preview = (f: any, b = previewBody(f)) =>
  ok(`/products/${f.p.id}/shopify-translations/preview`, 'POST', b, f.a);
const consent = { external_authorized: true, replace_existing: false, confirm_product_scope: true };
const queue = (p: any, b: any = consent, a = cookie) =>
  ok(`/shopify-translation-plans/${p.id}/queue`, 'POST', b, a);
const row = async (p: any) =>
  (await pool.query('SELECT * FROM shopify_translation_plans WHERE id=$1', [p.id])).rows[0];
async function claim(p: any) {
  const j = (
    await pool.query(
      "UPDATE jobs SET state='running',attempts=attempts+1,lease_token=$2,locked_at=now() WHERE id=(SELECT job_id FROM shopify_translation_plans WHERE id=$1) AND state='pending' RETURNING *",
      [p.id, randomUUID()],
    )
  ).rows[0];
  assert(j);
  return j;
}
async function execute(p: any) {
  const j = await claim(p);
  try {
    await processTranslation(j, { transport });
  } catch (e) {
    await failTranslation(j, e);
  }
  return row(p);
}
const writes = () => calls.filter((c) => c.op === 'DynaProductTranslationRegister');
async function bulkFixtures(count = 2, remoteDuplicate = false) {
  const fs = [];
  for (let n = 0; n < count; n++) fs.push(await fixture());
  for (const f of fs.slice(1)) {
    await pool.query('UPDATE listings SET channel_id=$2 WHERE id=$1', [f.listing.id, fs[0].ch.id]);
    f.ch = fs[0].ch;
  }
  if (remoteDuplicate)
    for (const f of fs.slice(1)) {
      variants.get(
        f.listing.external_id ??
          (await pool.query('SELECT external_id FROM listings WHERE id=$1', [f.listing.id])).rows[0]
            .external_id,
      ).productId = fs[0].remoteProduct;
      f.remoteProduct = fs[0].remoteProduct;
    }
  return fs;
}
const bulkBody = (fs: any[], extra: any = {}) => ({
  client_key: randomUUID(),
  channel_id: fs[0].ch.id,
  local_locale: 'de',
  target_locale: 'de',
  fields: ['title', 'body_html'],
  items: fs.map((f) => ({
    product_id: f.p.id,
    listing_id: f.listing.id,
    version: f.p.version,
    translation_version: 1,
  })),
  ...extra,
});
const bulkPreview = (b: any, a = cookie) =>
  ok('/shopify-translation-batches/preview', 'POST', b, a);
const bulkDetail = (b: any, a = cookie) =>
  ok('/shopify-translation-batches/' + b.id, 'GET', undefined, a);
const bulkQueue = (b: any, c: any = consent, a = cookie) =>
  ok('/shopify-translation-batches/' + b.id + '/queue', 'POST', c, a);
test('bulk reviewed translations freeze exact mappings, queue atomically, and confirm all without changing catalog/stock', async () => {
  const fs = await bulkFixtures(),
    body = bulkBody(fs),
    b = await bulkPreview(body);
  assert.equal(b.summary.ready, 2);
  assert.equal(b.summary.total, 2);
  assert.equal(writes().length, 0);
  assert.equal((await bulkPreview(body)).id, b.id);
  assert.equal(
    (await ok('/shopify-translation-plans/' + b.items[0].plan_id)).local_snapshot.product_version,
    2,
  );
  const selected = await ok(
    '/shopify-translation-batches/selection?product_ids=' + fs.map((f) => f.p.id).join(','),
  );
  assert.equal(selected.products.length, 2);
  assert.equal(selected.products[0].translations[0].locale, 'de');
  const queued = await bulkQueue(b);
  assert.equal(queued.summary.queued, 2);
  assert.equal((await bulkQueue(b)).id, b.id);
  for (const i of queued.items) assert.equal((await execute(i.plan)).state, 'done');
  const done = await bulkDetail(b);
  assert.equal(done.state, 'done');
  assert.equal(done.summary.done, 2);
  for (const item of done.items) {
    assert.equal(item.plan.result.fields.length, 2);
    assert(item.plan.result.fields.every((f: any) => f.confirmed && f.sourceMatches));
    assert(item.plan.result.fields.every((f: any) => !('expected' in f) && !('observed' in f)));
  }
  assert.equal(writes().length, 2);
  for (const f of fs) {
    const p = await ok('/products/' + f.p.id);
    assert.equal(p.version, 2);
    assert.equal(p.name, 'Kubek stalowy 350 ml');
    assert.equal(p.price, 3000);
    assert.equal(
      (await pool.query('SELECT on_hand FROM stock WHERE product_id=$1', [f.p.id])).rows[0].on_hand,
      10,
    );
  }
  await ok(
    '/shopify-translation-batches/' + b.id + '/queue',
    'POST',
    { ...consent, replace_existing: true },
    cookie,
    409,
  );
});
test('stale one-row version rejects entire queue and rolls back every job, claim and consent', async () => {
  const fs = await bulkFixtures(),
    b = await bulkPreview(bulkBody(fs));
  await pool.query('UPDATE products SET version=version+1 WHERE id=$1', [fs[1].p.id]);
  await ok('/shopify-translation-batches/' + b.id + '/queue', 'POST', consent, cookie, 409);
  const d = await bulkDetail(b);
  assert.equal(d.batch_state, 'preview');
  assert(d.items.every((i: any) => i.plan.state === 'preview'));
  assert.equal(writes().length, 0);
  assert.equal(
    (
      await pool.query(
        'SELECT count(*) n FROM shopify_translation_claims WHERE plan_id=ANY($1::uuid[])',
        [d.items.map((i: any) => i.plan_id)],
      )
    ).rows[0].n,
    '0',
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*) n FROM jobs WHERE kind='shopify.translation' AND payload->>'plan_id'=ANY($1::text[])",
        [d.items.map((i: any) => i.plan_id)],
      )
    ).rows[0].n,
    '0',
  );
});
test('sibling variants of same remote product cannot queue a contradictory batch', async () => {
  const fs = await bulkFixtures(2, true),
    b = await bulkPreview(bulkBody(fs));
  assert.equal(b.summary.ready, 2);
  await ok('/shopify-translation-batches/' + b.id + '/queue', 'POST', consent, cookie, 409);
  assert((await bulkDetail(b)).items.every((i: any) => i.plan.state === 'preview'));
  assert.equal(writes().length, 0);
});
test('mixed valid and failed previews expose per-SKU errors and block any queue, with idempotent retry', async () => {
  const fs = await bulkFixtures(),
    body = bulkBody(fs);
  body.items[1].translation_version = 8;
  const b = await bulkPreview(body);
  assert.equal(b.summary.ready, 1);
  assert.equal(b.summary.failed, 1);
  assert.match(b.items[1].error, /Odśwież/);
  assert.equal(b.items[1].plan_id, null);
  const before = calls.length;
  const again = await bulkPreview(body);
  assert.equal(again.id, b.id);
  assert.equal(calls.length, before);
  await ok('/shopify-translation-batches/' + b.id + '/queue', 'POST', consent, cookie, 409);
  await ok(
    '/shopify-translation-batches/preview',
    'POST',
    { ...body, fields: ['title'] },
    cookie,
    409,
  );
});
test('whole-product, replacement and external consent are required for all frozen rows, no partial scheduling', async () => {
  const fs = await bulkFixtures();
  resources.get(fs[1].remoteProduct).translations = [
    { key: 'title', locale: 'de', value: 'Alt', outdated: false, updatedAt: null, market: null },
  ];
  const b = await bulkPreview(bulkBody(fs));
  assert.equal(b.needs_replace, true);
  assert.equal(b.summary.needs_replace, 1);
  for (const c of [
    { ...consent, confirm_product_scope: false },
    { ...consent, external_authorized: false },
    consent,
  ])
    await ok('/shopify-translation-batches/' + b.id + '/queue', 'POST', c, cookie, 422);
  assert.equal(
    (
      await pool.query(
        'SELECT count(*) n FROM shopify_translation_plans WHERE id=ANY($1::uuid[]) AND consent IS NOT NULL',
        [b.items.map((i: any) => i.plan_id)],
      )
    ).rows[0].n,
    '0',
  );
  assert.equal(writes().length, 0);
  assert.equal((await bulkQueue(b, { ...consent, replace_existing: true })).summary.queued, 2);
});
test('partial delivery retains uncertain claim; cancel affects only fresh rows; reconcile never repeats mutation', async () => {
  const fs = await bulkFixtures(3),
    b = await bulkQueue(await bulkPreview(bulkBody(fs)));
  assert.equal((await execute(b.items[0].plan)).state, 'done');
  mode = 'lost';
  assert.equal((await execute(b.items[1].plan)).state, 'uncertain');
  mode = '';
  const uncertain = await bulkDetail(b);
  assert.equal(uncertain.state, 'uncertain');
  assert.equal(uncertain.summary.done, 1);
  assert.equal(uncertain.summary.uncertain, 1);
  assert.equal(uncertain.summary.queued, 1);
  const cancelled = await ok('/shopify-translation-batches/' + b.id + '/cancel', 'POST', {});
  assert.equal(cancelled.summary.cancelled, 1);
  assert.equal(cancelled.summary.uncertain, 1);
  assert.equal(
    (
      await pool.query('SELECT count(*) n FROM shopify_translation_claims WHERE plan_id=$1', [
        b.items[1].plan_id,
      ])
    ).rows[0].n,
    '1',
  );
  await ok('/shopify-translation-plans/' + b.items[1].plan_id + '/reconcile', 'POST', {});
  const final = await bulkDetail(b);
  assert.equal(final.state, 'partial');
  assert.equal(final.summary.done, 2);
  assert.equal(final.summary.cancelled, 1);
  assert.equal(writes().length, 2);
});
test('no-op rows finish by reading while other rows publish once, frozen snapshots remain', async () => {
  const fs = await bulkFixtures(),
    b = await bulkPreview(bulkBody(fs));
  const f = fs[0];
  resources.get(f.remoteProduct).translations = (
    await ok('/shopify-translation-plans/' + b.items[0].plan_id)
  ).spec.translations.map((t: any) => ({
    key: t.key,
    locale: t.locale,
    value: t.value,
    outdated: false,
    updatedAt: null,
    market: null,
  }));
  // A new preview is required for the changed remote state.
  await ok('/shopify-translation-batches/' + b.id + '/cancel', 'POST', {});
  const next = await bulkQueue(await bulkPreview(bulkBody(fs)));
  for (const i of next.items) assert.equal((await execute(i.plan)).state, 'done');
  assert.equal(writes().length, 1);
  const done = await bulkDetail(next);
  assert.equal(done.summary.done, 2);
  for (const item of done.items) {
    assert.equal(item.plan.result.fields.length, 2);
    assert(item.plan.result.fields.every((f: any) => f.confirmed && f.sourceMatches));
    assert(item.plan.result.fields.every((f: any) => !('expected' in f) && !('observed' in f)));
  }
  assert.equal(done.items[0].plan.attempted_at, null);
});
test('selection/preview reject cross-tenant mappings, duplicate products, and more than100; viewer cannot inspect', async () => {
  const fs = await bulkFixtures(),
    b = await bulkPreview(bulkBody(fs));
  for (const p of [
    '/shopify-translation-batches',
    '/shopify-translation-batches/' + b.id,
    '/shopify-translation-batches/selection?product_ids=' + fs[0].p.id,
  ])
    await ok(p, 'GET', undefined, viewer, 403);
  await ok('/shopify-translation-batches/' + b.id, 'GET', undefined, other, 404);
  await ok(
    '/shopify-translation-batches/selection?product_ids=' + fs[0].p.id,
    'GET',
    undefined,
    other,
    404,
  );
  await ok('/shopify-translation-batches/preview', 'POST', bulkBody(fs), other, 404);
  const duplicate = bulkBody(fs);
  duplicate.items[1] = duplicate.items[0];
  await ok('/shopify-translation-batches/preview', 'POST', duplicate, cookie, 422);
  await ok(
    '/shopify-translation-batches/preview',
    'POST',
    { ...bulkBody(fs), items: Array.from({ length: 101 }, () => bulkBody(fs).items[0]) },
    cookie,
    422,
  );
  await pool.query("UPDATE memberships SET role='operator' WHERE user_id=$1 AND tenant_id=$2", [
    user,
    DEMO_TENANT,
  ]);
  await ok('/shopify-translation-batches/' + b.id + '/queue', 'POST', consent, cookie, 403);
});
test('batch and item RLS/scope are immutable and recovery forbids all provider work before transport', async () => {
  const fs = await bulkFixtures(),
    body = bulkBody(fs),
    b = await bulkPreview(body);
  await tenantTx(SECOND_TENANT, async (c) => {
    assert.equal(
      (await c.query('SELECT id FROM shopify_translation_batches WHERE id=$1', [b.id])).rowCount,
      0,
    );
    assert.equal(
      (
        await c.query('SELECT position FROM shopify_translation_batch_items WHERE batch_id=$1', [
          b.id,
        ])
      ).rowCount,
      0,
    );
  });
  for (const q of [
    "UPDATE shopify_translation_batches SET target_locale='en' WHERE id=$1",
    "UPDATE shopify_translation_batch_items SET sku='tampered' WHERE batch_id=$1",
    'UPDATE shopify_translation_batch_items SET plan_id=NULL WHERE batch_id=$1',
  ])
    await assert.rejects(
      tenantTx(DEMO_TENANT, (c) => c.query(q, [b.id])),
      /immutable|check constraint/,
    );
  const recovery = await buildApp({ readOnly: true, integrationTransport: transport });
  const recoveryLogin = await recovery.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email: 'admin@demo.local', password: 'DynaDemo!2026' },
  });
  const recoveryCookie = recoveryLogin.headers['set-cookie']!.toString().split(';')[0];
  const n = calls.length;
  for (const [path, payload] of [
    ['/shopify-translation-batches/preview', body],
    ['/shopify-translation-batches/' + b.id + '/queue', consent],
    ['/shopify-translation-batches/' + b.id + '/cancel', {}],
    ['/shopify-translation-batches/' + b.id + '/resume', {}],
  ] as const) {
    const r = await recovery.inject({
      method: 'POST',
      url: '/api' + path,
      payload,
      headers: { cookie: recoveryCookie },
      remoteAddress: '127.0.19.1',
    });
    assert.equal(r.statusCode, 423, r.body);
  }
  const read = await recovery.inject({
    url: '/api/shopify-translation-batches/' + b.id,
    headers: { cookie: recoveryCookie },
    remoteAddress: '127.0.19.1',
  });
  assert.equal(read.statusCode, 200, read.body);
  assert.equal(read.json().read_only, true);
  assert.equal(calls.length, n);
  await recovery.close();
});
test('concurrent identical preview uses one builder; interrupted building resumes the same child keys with GET only', async () => {
  const fs = await bulkFixtures(1),
    body = bulkBody(fs);
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>((r) => (release = r)),
    seen = new Promise<void>((r) => (started = r));
  beforeResponse = async () => {
    started();
    await gate;
  };
  const first = bulkPreview(body);
  await seen;
  const second = await bulkPreview(body);
  assert.equal(second.state, 'building');
  assert.equal(second.summary.pending, 1);
  release();
  const complete = await first;
  assert.equal(complete.id, second.id);
  assert.equal(complete.summary.ready, 1);
  assert.equal(calls.filter((c) => c.op === 'DynaProductTranslation').length, 1);
  beforeResponse = undefined;
  await ok('/shopify-translation-batches/' + complete.id + '/cancel', 'POST', {});
  const interrupted = bulkBody(fs);
  let changed = false;
  beforeResponse = async () => {
    if (!changed) {
      changed = true;
      await pool.query("UPDATE memberships SET role='operator' WHERE tenant_id=$1 AND user_id=$2", [
        DEMO_TENANT,
        user,
      ]);
    }
  };
  await ok('/shopify-translation-batches/preview', 'POST', interrupted, cookie, 403);
  const created = (
    await pool.query('SELECT id,state FROM shopify_translation_batches WHERE client_key=$1', [
      interrupted.client_key,
    ])
  ).rows[0];
  assert.equal(created.state, 'building');
  const key = (
    await pool.query('SELECT client_key FROM shopify_translation_batch_items WHERE batch_id=$1', [
      created.id,
    ])
  ).rows[0].client_key;
  await pool.query("UPDATE memberships SET role='admin' WHERE tenant_id=$1 AND user_id=$2", [
    DEMO_TENANT,
    user,
  ]);
  beforeResponse = undefined;
  const resumed = await ok('/shopify-translation-batches/' + created.id + '/resume', 'POST', {});
  assert.equal(resumed.id, created.id);
  assert.equal(resumed.summary.ready, 1);
  assert.equal(
    (
      await pool.query('SELECT client_key FROM shopify_translation_batch_items WHERE batch_id=$1', [
        created.id,
      ])
    ).rows[0].client_key,
    key,
  );
  assert.equal(writes().length, 0);
});
test('twelve simultaneous distinct builders do not retain tenant-pool slots during provider GET', async () => {
  const fs = await bulkFixtures(1);
  let seen = 0,
    release!: () => void,
    timedOut = false;
  const barrier = new Promise<void>((r) => (release = r));
  const timer = setTimeout(() => {
    timedOut = true;
    release();
  }, 6000);
  beforeResponse = async () => {
    seen++;
    if (seen === 12) release();
    await barrier;
  };
  try {
    const results = await Promise.all(Array.from({ length: 12 }, () => bulkPreview(bulkBody(fs))));
    assert.equal(timedOut, false, 'builders starved the tenant pool');
    assert.equal(seen, 12);
    assert(results.every((b) => b.summary.ready === 1));
    assert.equal(new Set(results.map((b) => b.id)).size, 12);
    assert.equal(writes().length, 0);
  } finally {
    clearTimeout(timer);
    beforeResponse = undefined;
    release();
  }
});
test('batch claim conflict rolls back all other childjobs and a cancelled request is resumable', async () => {
  const fs = await bulkFixtures(),
    b = await bulkPreview(bulkBody(fs));
  const independent = await preview(fs[0]);
  await queue(independent);
  await ok('/shopify-translation-batches/' + b.id + '/queue', 'POST', consent, cookie, 409);
  assert((await bulkDetail(b)).items.every((i: any) => i.plan.state === 'preview'));
  assert.equal(
    (
      await pool.query(
        'SELECT count(*) n FROM shopify_translation_claims WHERE plan_id=ANY($1::uuid[])',
        [b.items.map((i: any) => i.plan_id)],
      )
    ).rows[0].n,
    '0',
  );
  const cancelled = await ok('/shopify-translation-batches/' + b.id + '/cancel', 'POST', {});
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(
    (await ok('/shopify-translation-batches/' + b.id + '/cancel', 'POST', {})).state,
    'cancelled',
  );
  assert.equal(writes().length, 0);
});
async function cloneBatch(b: any, extra: any = {}) {
  const id = randomUUID();
  await pool.query(
    'INSERT INTO shopify_translation_batches SELECT (jsonb_populate_record(NULL::shopify_translation_batches,to_jsonb(b)||$2::jsonb)).* FROM shopify_translation_batches b WHERE id=$1',
    [b.id, JSON.stringify({ id, client_key: randomUUID(), ...extra })],
  );
  return { id };
}
test('expiry, tenant batch capacity and keyset history with tied microsecond times are enforced', async () => {
  const fs = await bulkFixtures(1),
    b = await bulkPreview(bulkBody(fs)),
    expired = await cloneBatch(b, { expires_at: '2020-01-01T00:00:00Z' });
  await ok('/shopify-translation-batches/' + expired.id + '/queue', 'POST', consent, cookie, 409);
  for (let n = 0; n < 18; n++) await cloneBatch(b);
  const rs = await Promise.all([
    req('/shopify-translation-batches/preview', 'POST', bulkBody(fs)),
    req('/shopify-translation-batches/preview', 'POST', bulkBody(fs)),
  ]);
  assert.deepEqual(rs.map((r) => r.statusCode).sort(), [200, 429]);
  await pool.query(
    "UPDATE shopify_translation_batches SET state='cancelled' WHERE state='preview'",
  );
  for (let n = 0; n < 25; n++)
    await cloneBatch(b, { state: 'cancelled', created_at: '2026-10-01T00:00:00.123456Z' });
  const seen = new Set<string>();
  let page: any = { meta: { cursor: null } },
    pages = 0;
  do {
    page = await ok(
      '/shopify-translation-batches' +
        (page.meta.cursor ? '?cursor=' + encodeURIComponent(page.meta.cursor) : ''),
    );
    for (const row of page.data) {
      assert(!seen.has(row.id));
      seen.add(row.id);
    }
    pages++;
  } while (page.meta.cursor);
  assert.equal(
    seen.size,
    Number(
      (
        await pool.query('SELECT count(*) n FROM shopify_translation_batches WHERE tenant_id=$1', [
          DEMO_TENANT,
        ])
      ).rows[0].n,
    ),
  );
  assert(pages >= 3);
  await ok('/shopify-translation-batches?cursor=bad', 'GET', undefined, cookie, 422);
  assert.equal(writes().length, 0);
});
test('older backup without batch table advertises unavailable and blocks provider actions before queries', async () => {
  await pool.query(
    'ALTER TABLE shopify_translation_batches RENAME TO qa_hidden_shopify_translation_batches',
  );
  let legacy: Awaited<ReturnType<typeof buildApp>> | undefined;
  const n = calls.length;
  try {
    legacy = await buildApp({ readOnly: true, integrationTransport: transport });
    const login = await legacy.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: 'admin@demo.local', password: 'DynaDemo!2026' },
      }),
      auth = login.headers['set-cookie']!.toString().split(';')[0];
    const r = await legacy.inject({
      url: '/api/shopify-translation-batches',
      headers: { cookie: auth },
    });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().available, false);
    assert.equal(r.json().read_only, true);
    assert.deepEqual(r.json().data, []);
    const write = await legacy.inject({
      method: 'POST',
      url: '/api/shopify-translation-batches/preview',
      headers: { cookie: auth },
      payload: {},
    });
    assert.equal(write.statusCode, 423, write.body);
    assert.equal(calls.length, n);
  } finally {
    await legacy?.close();
    await pool.query(
      'ALTER TABLE qa_hidden_shopify_translation_batches RENAME TO shopify_translation_batches',
    );
  }
});
test('batch prelocks all children before global admission; a competing single queue cannot deadlock or be absorbed', async () => {
  const fs = await bulkFixtures(),
    b = await bulkPreview(bulkBody(fs));
  const children = [...b.items].sort((x: any, y: any) => x.plan_id.localeCompare(y.plan_id));
  const last = children[1],
    c = await pool.connect();
  let pending: ReturnType<typeof req> | undefined;
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE dyna_app');
    await c.query("SELECT set_config('app.tenant_id',$1,true)", [DEMO_TENANT]);
    await c.query("SET LOCAL statement_timeout='2s'");
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      'shopify.translation.plan:' + last.plan_id,
    ]);
    pending = req('/shopify-translation-batches/' + b.id + '/queue', 'POST', consent);
    let waiting = false;
    for (let n = 0; n < 100; n++) {
      waiting = !!(
        await pool.query(
          "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory') waiting",
        )
      ).rows[0].waiting;
      if (waiting) break;
      await new Promise((r) => setTimeout(r, 5));
    }
    assert(waiting, 'batch did not reach the conflicting planlock');
    await queueTranslationInTx(
      c,
      { tenantId: DEMO_TENANT, userId: user, role: 'admin' },
      last.plan_id,
      consent,
    );
    await c.query('COMMIT');
    const result = await pending;
    assert.equal(result.statusCode, 409, result.body);
    const after = await bulkDetail(b);
    assert.equal(after.batch_state, 'preview');
    assert.equal(after.consent, null);
    assert.equal(
      after.items.find((i: any) => i.plan_id === children[0].plan_id).plan.state,
      'preview',
    );
    assert.equal(writes().length, 0);
  } finally {
    await c.query('ROLLBACK');
    c.release();
    await pending;
  }
});
