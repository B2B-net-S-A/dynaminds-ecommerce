import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../server/app';
import { pool, migrate, tenantTx } from '../server/db';
import { seed, DEMO_TENANT, SECOND_TENANT } from './fixtures';
import { encrypt } from '../server/security';
import { SHOPIFY_VERSION } from '../server/shopify';
import { processTranslation, failTranslation } from '../server/shopify-translations';
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
      ...(op === 'DynaProductTranslation'
        ? { productVariant: v ? { id: v.id, sku: v.sku, product: { id: v.productId } } : null }
        : {}),
      translatableResource: r.deleted
        ? null
        : {
            resourceId: b.variables.resourceId,
            translatableContent: r.source,
            translations: (r.translations ?? []).filter(
              (t: any) => t.locale === b.variables.locale,
            ),
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
test('approved local translation → immutable preview → consent → one mutation → readback, with source/stock/price preserved', async () => {
  const f = await fixture(),
    b = previewBody(f),
    p = await preview(f, b);
  assert.equal(p.local_snapshot.product_version, 2);
  assert.equal(writes().length, 0);
  const before = (
    await pool.query('SELECT to_jsonb(s) data FROM stock s WHERE product_id=$1', [f.p.id])
  ).rows;
  assert.equal((await preview(f, b)).id, p.id);
  assert.equal(p.remote_product_id, f.remoteProduct);
  await queue(p);
  assert.equal((await queue(p)).reused, true);
  const done = await execute(p);
  assert.equal(done.state, 'done', done.error);
  assert.equal(writes().length, 1);
  assert(done.result.fields.every((f: any) => f.confirmed));
  assert.equal(done.phase, 'done');
  assert(done.attempted_at);
  assert.equal((await ok(`/products/${f.p.id}`)).price, 3000);
  assert.equal((await ok(`/products/${f.p.id}`)).version, 2);
  assert.deepEqual(
    (await pool.query('SELECT to_jsonb(s) data FROM stock s WHERE product_id=$1', [f.p.id])).rows,
    before,
  );
  assert.equal(
    (await pool.query('SELECT 1 FROM shopify_translation_claims WHERE plan_id=$1', [p.id]))
      .rowCount,
    0,
  );
  const detail = await ok(`/shopify-translation-plans/${p.id}`);
  assert.equal(detail.observations.length, 2);
  assert.equal(detail.result.mutation_response.requiresReadback, true);
  assert.equal((await queue(p)).state, 'done');
  assert.equal(writes().length, 1);
});
test('real write needs external and whole-product consent; different replay body and client-key reuse are rejected', async () => {
  const f = await fixture(),
    b = previewBody(f),
    p = await preview(f, b);
  for (const input of [
    { ...consent, external_authorized: false },
    { ...consent, confirm_product_scope: false },
  ])
    assert.equal(
      (await req(`/shopify-translation-plans/${p.id}/queue`, 'POST', input)).statusCode,
      422,
    );
  await queue(p);
  assert.equal(
    (
      await req(`/shopify-translation-plans/${p.id}/queue`, 'POST', {
        ...consent,
        replace_existing: true,
      })
    ).statusCode,
    409,
  );
  assert.equal(
    (
      await req(`/products/${f.p.id}/shopify-translations/preview`, 'POST', {
        ...b,
        fields: ['title'],
      })
    ).statusCode,
    409,
  );
  assert.equal(writes().length, 0);
});
test('replacement consent required; unrelated market overrides preserved', async () => {
  const f = await fixture(),
    r = resources.get(f.remoteProduct);
  r.translations = [
    {
      key: 'title',
      locale: 'de',
      value: 'Alt',
      outdated: false,
      updatedAt: '2026-10-05T00:00:00Z',
      market: null,
    },
    {
      key: 'title',
      locale: 'de',
      value: 'Markt',
      outdated: false,
      updatedAt: null,
      market: { id: 'gid://shopify/Market/7' },
    },
  ];
  const p = await preview(f);
  assert(p.needs_replace);
  assert.equal(
    (await req(`/shopify-translation-plans/${p.id}/queue`, 'POST', consent)).statusCode,
    422,
  );
  await queue(p, { ...consent, replace_existing: true });
  assert.equal((await execute(p)).state, 'done');
  assert.equal(r.translations.find((t: any) => t.market !== null).value, 'Markt');
});
test('already matching snapshot completes by read without any write or attempted timestamp', async () => {
  const f = await fixture(),
    r = resources.get(f.remoteProduct);
  r.translations = ['title', 'body_html'].map((key) => ({
    key,
    locale: 'de',
    value: key === 'title' ? 'Becher 350 ml' : '<p>Stahlbecher. Volumen 350 ml.</p>',
    outdated: false,
    updatedAt: null,
    market: null,
  }));
  const p = await preview(f);
  await queue(p);
  const done = await execute(p);
  assert.equal(done.state, 'done');
  assert.equal(done.attempted_at, null);
  assert.equal(writes().length, 0);
});
test('local product/translation/mapping and source facts changes stop stale queue or worker before mutation', async () => {
  for (const type of ['version', 'translation', 'mapping', 'facts']) {
    const f = await fixture(),
      p = await preview(f);
    await queue(p);
    if (type === 'version')
      await pool.query('UPDATE products SET version=version+1 WHERE id=$1', [f.p.id]);
    if (type === 'facts')
      await pool.query("UPDATE products SET name='Inne źródło',version=version+1 WHERE id=$1", [
        f.p.id,
      ]);
    if (type === 'translation')
      await pool.query(
        "UPDATE product_translations SET name='Inne',version=version+1 WHERE product_id=$1",
        [f.p.id],
      );
    if (type === 'mapping')
      await pool.query(
        "UPDATE listings SET external_id='gid://shopify/ProductVariant/1' WHERE id=$1",
        [f.listing.id],
      );
    const done = await execute(p);
    assert.equal(done.state, 'conflict', done.error);
    assert.equal(done.attempted_at, null);
  }
  assert.equal(writes().length, 0);
});
test('remote source digest, destination value/time and write scope changes invalidate preview before mutation', async () => {
  for (const type of ['digest', 'destination', 'time', 'scope']) {
    const f = await fixture(),
      r = resources.get(f.remoteProduct);
    r.translations = [
      {
        key: 'title',
        locale: 'de',
        value: 'Alt',
        outdated: false,
        updatedAt: '2026-10-05T00:00:00Z',
        market: null,
      },
    ];
    const p = await preview(f);
    await queue(p, { ...consent, replace_existing: true });
    if (type === 'digest') r.source[0].digest = 'new';
    if (type === 'destination') r.translations[0].value = 'Other';
    if (type === 'time') r.translations[0].updatedAt = '2026-10-05T01:00:00Z';
    if (type === 'scope') r.scopes = ['read_products', 'read_translations', 'read_locales'];
    assert.equal((await execute(p)).state, 'conflict');
  }
  assert.equal(writes().length, 0);
});
test('lost response retains claim; read reconciliation succeeds without a second mutation, even after local edit', async () => {
  const f = await fixture(),
    p = await preview(f);
  await queue(p);
  mode = 'lost';
  const failed = await execute(p);
  assert.equal(failed.state, 'uncertain');
  assert.equal(writes().length, 1);
  assert(!failed.error.includes('PRIVATE_PROVIDER_TOKEN'));
  const another = await preview(f);
  assert.equal(
    (await req(`/shopify-translation-plans/${another.id}/queue`, 'POST', consent)).statusCode,
    409,
  );
  await pool.query('UPDATE products SET version=version+1 WHERE id=$1', [f.p.id]);
  mode = '';
  const result = await ok(`/shopify-translation-plans/${p.id}/reconcile`, 'POST', {});
  assert.equal(result.state, 'done');
  assert.equal(writes().length, 1);
  assert.equal((await row(p)).state, 'done');
});
test('partial result stores response/evidence and requires explicit acknowledgement before a new publication', async () => {
  const f = await fixture(),
    p = await preview(f);
  await queue(p);
  mode = 'partial';
  const partial = await execute(p);
  assert.equal(partial.state, 'uncertain');
  assert.equal(partial.result.mutation_response.userErrors.length, 1);
  assert.equal(
    (await ok(`/shopify-translation-plans/${p.id}/reconcile`, 'POST', {})).state,
    'uncertain',
  );
  assert.equal(
    (await req(`/shopify-translation-plans/${p.id}/acknowledge`, 'POST', {})).statusCode,
    422,
  );
  assert.equal(
    (
      await ok(`/shopify-translation-plans/${p.id}/acknowledge`, 'POST', {
        acknowledge_unconfirmed: true,
      })
    ).state,
    'abandoned',
  );
  assert.equal(writes().length, 1);
  const next = await preview(f);
  await queue(next);
  mode = '';
  assert.equal((await execute(next)).state, 'done');
  assert.equal(writes().length, 2);
});
test('definite provider rejection and HTTP500 never retry a mutation automatically', async () => {
  for (const errorMode of ['reject', 'http500']) {
    const f = await fixture(),
      p = await preview(f);
    await queue(p);
    mode = errorMode;
    assert.equal((await execute(p)).state, 'uncertain');
  }
  assert.equal(writes().length, 2);
});
test('cancel while a read is running stops the job before attempt; cancellation cannot undo attempted writes', async () => {
  const f = await fixture(),
    p = await preview(f);
  await queue(p);
  beforeResponse = async () => {
    beforeResponse = undefined;
    await ok(`/shopify-translation-plans/${p.id}/cancel`, 'POST', {});
  };
  await execute(p);
  assert.equal((await row(p)).state, 'cancelled');
  assert.equal(writes().length, 0);
  const next = await preview(f);
  await queue(next);
  mode = 'lost';
  await execute(next);
  assert.equal(
    (await req(`/shopify-translation-plans/${next.id}/cancel`, 'POST', {})).statusCode,
    409,
  );
});
test('revoked role after response or changed connection before write blocks mutation; viewer/other tenant cannot read/approve', async () => {
  const f = await fixture(),
    p = await preview(f);
  for (const auth of [viewer, operator, other])
    for (const path of [
      `/products/${f.p.id}/shopify-translations`,
      `/shopify-translation-plans/${p.id}`,
    ])
      assert([403, 404].includes((await req(path, 'GET', undefined, auth)).statusCode));
  await queue(p);
  beforeResponse = async () => {
    await pool.query("UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2", [
      DEMO_TENANT,
      user,
    ]);
  };
  assert.equal((await execute(p)).state, 'failed');
  assert.equal(writes().length, 0);
  await pool.query("UPDATE memberships SET role='admin' WHERE tenant_id=$1 AND user_id=$2", [
    DEMO_TENANT,
    user,
  ]);
  beforeResponse = undefined;
  const next = await preview(f);
  await queue(next);
  await pool.query('UPDATE channels SET credentials=$2 WHERE id=$1', [
    f.ch.id,
    encrypt({ access_token: 'qa-new-token-2026' }),
  ]);
  assert.equal((await execute(next)).state, 'conflict');
  assert.equal(writes().length, 0);
});
test('global claim prevents sibling variants and other firms from writing same store/product/locale concurrently', async () => {
  const f = await fixture(),
    otherFirm = await fixture(other, { store: f.store, remoteProduct: f.remoteProduct }),
    p = await preview(f),
    q = await preview(otherFirm);
  const results = await Promise.all([
    req(`/shopify-translation-plans/${p.id}/queue`, 'POST', consent),
    req(`/shopify-translation-plans/${q.id}/queue`, 'POST', consent, other),
  ]);
  assert.deepEqual(results.map((r) => r.statusCode).sort(), [200, 409]);
  assert.equal((await pool.query('SELECT * FROM shopify_translation_claims')).rowCount, 1);
  const winner = results[0].statusCode === 200 ? p : q,
    auth = results[0].statusCode === 200 ? cookie : other;
  await ok(`/shopify-translation-plans/${winner.id}/cancel`, 'POST', {}, auth);
  await queue(
    results[0].statusCode === 200 ? q : p,
    consent,
    results[0].statusCode === 200 ? other : cookie,
  );
});
test('RLS/immutable plans, append-only observations, protected consent and owner-only claims', async () => {
  const f = await fixture(),
    p = await preview(f);
  await queue(p);
  await execute(p);
  assert.equal(
    (
      await tenantTx(SECOND_TENANT, (c) =>
        c.query('SELECT * FROM shopify_translation_plans WHERE id=$1', [p.id]),
      )
    ).rowCount,
    0,
  );
  for (const sql of [
    "UPDATE shopify_translation_plans SET spec='{}' WHERE id=$1",
    "UPDATE shopify_translation_plans SET consent='{}' WHERE id=$1",
    'DELETE FROM shopify_translation_plans WHERE id=$1',
    "UPDATE shopify_translation_observations SET data='{}' WHERE plan_id=$1",
    'DELETE FROM shopify_translation_observations WHERE plan_id=$1',
  ])
    await assert.rejects(tenantTx(DEMO_TENANT, (c) => c.query(sql, [p.id])));
  await assert.rejects(
    tenantTx(DEMO_TENANT, (c) => c.query('SELECT * FROM shopify_translation_claims')),
  );
  assert.equal(
    (
      await tenantTx(SECOND_TENANT, (c) =>
        c.query('SELECT shopify_translation_claimed($1) ok', [p.id]),
      )
    ).rows[0].ok,
    false,
  );
});
test('expired lease after attempt remains uncertain; reaper and old worker cannot repeat POST', async () => {
  const f = await fixture(),
    p = await preview(f);
  await queue(p);
  const job = await claim(p);
  afterMutation = async () => {
    await pool.query("UPDATE jobs SET locked_at=now()-interval '3 minutes' WHERE id=$1", [job.id]);
    await tick({ transport });
  };
  await assert.rejects(processTranslation(job, { transport }));
  const current = await row(p);
  assert.equal(current.state, 'uncertain');
  assert.equal(writes().length, 1);
  afterMutation = undefined;
  await processTranslation(job, { transport });
  assert.equal(writes().length, 1);
  assert.equal(
    (await ok(`/shopify-translation-plans/${p.id}/reconcile`, 'POST', {})).state,
    'done',
  );
  assert.equal(writes().length, 1);
});
test('local example publishes/reconciles durably without any external request', async () => {
  const f = await fixture(),
    example = await ok('/integrations/shopify-example', 'POST', {}),
    start = await ok(`/integrations/${example.channel_id}/shopify-oauth/start`, 'POST', {
      translations_write: true,
    });
  await ok('/oauth/shopify/finish', 'POST', { return_url: start.demo_return_url });
  const listing = await ok(`/integrations/${example.channel_id}/mappings`, 'POST', {
    external_id: 'gid://shopify/ProductVariant/701',
    sku: f.p.sku,
  });
  const sim = { ...f, ch: { id: example.channel_id }, listing };
  calls = [];
  const p = await preview(sim);
  assert(p.remote_snapshot.simulation);
  await queue(p, { ...consent, external_authorized: false });
  assert.equal((await execute(p)).state, 'done');
  assert.equal(calls.length, 0);
});
test('preview pagination and recovery mode expose local evidence only; all supplier actions return423', async () => {
  const f = await fixture(),
    p = await preview(f);
  await queue(p);
  await execute(p);
  const ro = await buildApp({ readOnly: true, integrationTransport: transport });
  try {
    const login = await ro.inject({
        url: '/api/auth/login',
        method: 'POST',
        payload: { email: 'admin@demo.local', password: 'DynaDemo!2026' },
      }),
      auth = login.headers['set-cookie']!.toString().split(';')[0],
      count = calls.length;
    for (const path of [
      `/api/products/${f.p.id}/shopify-translations`,
      `/api/shopify-translation-plans/${p.id}`,
    ])
      assert.equal((await ro.inject({ url: path, headers: { cookie: auth } })).statusCode, 200);
    for (const suffix of ['queue', 'cancel', 'reconcile', 'acknowledge'])
      assert.equal(
        (
          await ro.inject({
            url: `/api/shopify-translation-plans/${p.id}/${suffix}`,
            method: 'POST',
            headers: { cookie: auth },
            payload: {},
          })
        ).statusCode,
        423,
      );
    assert.equal(calls.length, count);
  } finally {
    await ro.close();
  }
  assert.equal((await req(`/products/${f.p.id}/shopify-translations?cursor=bad`)).statusCode, 422);
});

test('duplicate workers sharing a lease leave one active publisher in charge', async () => {
  const f = await fixture(),
    p = await preview(f);
  await queue(p);
  const j = await claim(p);
  let entered!: () => void, resume!: () => void;
  const waiting = new Promise<void>((r) => {
    entered = r;
  });
  const barrier = new Promise<void>((r) => {
    resume = r;
  });
  beforeResponse = async () => {
    beforeResponse = undefined;
    entered();
    await barrier;
  };
  const first = processTranslation(j, { transport });
  await waiting;
  await processTranslation(j, { transport });
  assert.equal((await row(p)).state, 'queued');
  assert.equal(writes().length, 0);
  resume();
  await first;
  assert.equal((await row(p)).state, 'done');
  assert.equal(writes().length, 1);
});

test('last transport fence blocks local change after the durable attempt marker', async () => {
  const f = await fixture(),
    p = await preview(f);
  await queue(p);
  // Test DB only: model a local edit exactly between the durable marker and HTTP dispatch.
  await pool.query(`CREATE FUNCTION qa_translation_edit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF OLD.phase='fresh' AND NEW.phase='attempted' THEN
      UPDATE products SET version=version+1 WHERE id=NEW.product_id;
    END IF; RETURN NEW; END $$;
    CREATE TRIGGER qa_translation_edit AFTER UPDATE ON shopify_translation_plans FOR EACH ROW EXECUTE FUNCTION qa_translation_edit()`);
  try {
    const result = await execute(p);
    assert.equal(result.state, 'uncertain');
    assert.equal(result.phase, 'attempted');
    assert.equal(writes().length, 0);
    assert.equal(
      (await ok(`/shopify-translation-plans/${p.id}/reconcile`, 'POST', {})).state,
      'uncertain',
    );
    assert.equal(writes().length, 0);
  } finally {
    await pool.query(
      'DROP TRIGGER qa_translation_edit ON shopify_translation_plans; DROP FUNCTION qa_translation_edit()',
    );
  }
});

test('same idempotency key across different products is a409 conflict under concurrent previews', async () => {
  const f = await fixture(),
    g = await fixture(),
    key = randomUUID();
  const replies = await Promise.all(
    [f, g].map((x) =>
      req(
        `/products/${x.p.id}/shopify-translations/preview`,
        'POST',
        previewBody(x, { client_key: key }),
      ),
    ),
  );
  assert.deepEqual(replies.map((r) => r.statusCode).sort(), [200, 409]);
  assert.equal(
    (
      await pool.query(
        'SELECT count(*)::int n FROM shopify_translation_plans WHERE tenant_id=$1 AND client_key=$2',
        [DEMO_TENANT, key],
      )
    ).rows[0].n,
    1,
  );
  assert.equal(writes().length, 0);
});

async function cloned(p: any, extra: any) {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO shopify_translation_plans SELECT (jsonb_populate_record(NULL::shopify_translation_plans,to_jsonb(p)||$2::jsonb)).* FROM shopify_translation_plans p WHERE id=$1`,
    [p.id, JSON.stringify({ id, client_key: randomUUID(), ...extra })],
  );
  return row({ id });
}

test('expired preview and lease before attempt fail without POST; claims are released', async () => {
  const f = await fixture(),
    p = await preview(f);
  const expired = await cloned(p, { expires_at: '2020-01-01T00:00:00Z' });
  assert.equal(
    (await req(`/shopify-translation-plans/${expired.id}/queue`, 'POST', consent)).statusCode,
    409,
  );
  await queue(p);
  const j = await claim(p);
  await pool.query("UPDATE jobs SET locked_at=now()-interval '3 minutes' WHERE id=$1", [j.id]);
  await tick({ transport });
  assert.equal((await row(p)).state, 'failed');
  await processTranslation(j, { transport });
  assert.equal(writes().length, 0);
  assert.equal(
    (
      await pool.query('SELECT count(*)::int n FROM shopify_translation_claims WHERE plan_id=$1', [
        p.id,
      ])
    ).rows[0].n,
    0,
  );
});

test('keyset pages preserve submillisecond timestamps and identical timestamp ties', async () => {
  const f = await fixture(),
    p = await preview(f),
    ids = [p.id];
  await ok(`/shopify-translation-plans/${p.id}/cancel`, 'POST', {});
  for (let i = 0; i < 24; i++)
    ids.push(
      (
        await cloned(p, {
          state: 'cancelled',
          created_at: '2026-10-05T01:02:03.123456Z',
          expires_at: '2026-10-05T01:17:03.123456Z',
        })
      ).id,
    );
  const first = await ok(`/products/${f.p.id}/shopify-translations`);
  assert.equal(first.data.length, 20);
  assert(first.meta.cursor);
  const second = await ok(`/products/${f.p.id}/shopify-translations?cursor=${first.meta.cursor}`);
  assert.equal(second.data.length, 5);
  assert.equal(second.meta.cursor, null);
  assert.deepEqual([...first.data, ...second.data].map((x: any) => x.id).sort(), ids.sort());
  const reads = [];
  for (let i = 0; i < 15; i++) {
    const id = randomUUID();
    reads.push(id);
    await pool.query(
      "INSERT INTO shopify_translation_observations(id,tenant_id,plan_id,data,source,created_at) VALUES($1,$2,$3,'{}','graphql','2026-10-05T01:02:03.123456Z')",
      [id, DEMO_TENANT, p.id],
    );
  }
  const a = await ok(`/shopify-translation-plans/${p.id}`);
  const b = await ok(`/shopify-translation-plans/${p.id}?cursor=${a.meta.cursor}`);
  assert.equal(a.observations.length, 10);
  assert.equal(b.observations.length, 5);
  assert.deepEqual(
    [...a.observations, ...b.observations].map((x: any) => x.id).sort(),
    reads.sort(),
  );
  assert.equal(b.meta.cursor, null);
});

test('store domain aliases cannot bypass shop/product/locale claim; different locales can queue', async () => {
  const f = await fixture(),
    g = await fixture(other, { remoteProduct: f.remoteProduct });
  const p = await preview(f),
    q = await preview(g);
  assert.notEqual(p.store_url, q.store_url);
  await queue(p);
  assert.equal(
    (await req(`/shopify-translation-plans/${q.id}/queue`, 'POST', consent, other)).statusCode,
    409,
  );
  const en = await preview(f, previewBody(f, { target_locale: 'en' }));
  await queue(en);
  assert.equal(
    (
      await pool.query(
        'SELECT count(*)::int n FROM shopify_translation_claims WHERE shop_id=$1 AND remote_product_id=$2',
        [p.shop_id, p.remote_product_id],
      )
    ).rows[0].n,
    2,
  );
});

test('twenty active previews cap and locale publication change block stale work', async () => {
  const f = await fixture(),
    p = await preview(f);
  for (let i = 0; i < 19; i++) await cloned(p, {});
  assert.equal(
    (await req(`/products/${f.p.id}/shopify-translations/preview`, 'POST', previewBody(f)))
      .statusCode,
    429,
  );
  await queue(p);
  resources.get(f.remoteProduct).locales = [
    { locale: 'pl', name: 'Polski', primary: true, published: true },
    { locale: 'de', name: 'Deutsch', primary: false, published: false },
  ];
  assert.equal((await execute(p)).state, 'conflict');
  assert.equal(writes().length, 0);
});

test('post-attempt reconciliation survives a new token for the same frozen shop, with no retry', async () => {
  const f = await fixture(),
    p = await preview(f);
  await queue(p);
  mode = 'lost';
  assert.equal((await execute(p)).state, 'uncertain');
  await pool.query('UPDATE channels SET credentials=$2 WHERE id=$1', [
    f.ch.id,
    encrypt({ access_token: 'qa-replacement-token-same-shop' }),
  ]);
  mode = '';
  const done = await ok(`/shopify-translation-plans/${p.id}/reconcile`, 'POST', {});
  assert.equal(done.state, 'done');
  assert.equal(writes().length, 1);
});

test('new credentials never authorize an old unattempted write or a different frozen store read', async () => {
  const f = await fixture(),
    p = await preview(f);
  await pool.query('UPDATE channels SET credentials=$2 WHERE id=$1', [
    f.ch.id,
    encrypt({ access_token: 'qa-other-grant-before-queue' }),
  ]);
  assert.equal(
    (await req(`/shopify-translation-plans/${p.id}/queue`, 'POST', consent)).statusCode,
    409,
  );
  assert.equal(writes().length, 0);
  const g = await fixture(),
    q = await preview(g);
  await queue(q);
  mode = 'lost';
  assert.equal((await execute(q)).state, 'uncertain');
  await pool.query(
    "UPDATE channels SET credentials=$2,settings=jsonb_set(settings,'{store_url}',to_jsonb('https://different.myshopify.com'::text)) WHERE id=$1",
    [g.ch.id, encrypt({ access_token: 'qa-other-store-grant' })],
  );
  mode = '';
  assert.equal(
    (await req(`/shopify-translation-plans/${q.id}/reconcile`, 'POST', {})).statusCode,
    409,
  );
  assert.equal(
    (
      await req(`/shopify-translation-plans/${q.id}/acknowledge`, 'POST', {
        acknowledge_unconfirmed: true,
      })
    ).statusCode,
    409,
  );
  assert.equal((await row(q)).state, 'uncertain');
  assert.equal(writes().length, 1);
});

test('post-attempt product read survives deleted variant; removed locale or product is negative evidence that can be acknowledged', async () => {
  for (const change of ['variant', 'locale', 'product']) {
    const f = await fixture(),
      p = await preview(f);
    await queue(p);
    mode = 'lost';
    assert.equal((await execute(p)).state, 'uncertain');
    mode = '';
    const r = resources.get(f.remoteProduct);
    if (change === 'variant') variants.delete(f.listing.external_id);
    if (change === 'locale')
      r.locales = [{ locale: 'pl', name: 'Polski', primary: true, published: true }];
    if (change === 'product') r.deleted = true;
    const result = await ok(`/shopify-translation-plans/${p.id}/reconcile`, 'POST', {});
    assert.equal(result.state, change === 'variant' ? 'done' : 'uncertain');
    const detail = await ok(`/shopify-translation-plans/${p.id}`);
    assert.equal(detail.observations[0].data.variant_observed, false);
    assert.equal(detail.observations[0].data.resource_present, change !== 'product');
    if (change !== 'variant')
      assert.equal(
        (
          await ok(`/shopify-translation-plans/${p.id}/acknowledge`, 'POST', {
            acknowledge_unconfirmed: true,
          })
        ).state,
        'abandoned',
      );
    assert.equal(writes().filter((w) => w.variables.resourceId === f.remoteProduct).length, 1);
  }
});
