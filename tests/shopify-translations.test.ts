import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Shopify, SHOPIFY_VERSION } from '../server/shopify';
import {
  prepareProductTranslation,
  translationDescriptionHtml,
  translationReadback,
  productTranslationWrite,
  translationPreviewMatches,
} from '../server/shopify-translation-api';
import { shopifyOAuthInput, shopifyRequestedScopes } from '../server/shopify-auth-input';
const ids = {
  productId: 'gid://shopify/Product/9007199254740993',
  variantId: 'gid://shopify/ProductVariant/9007199254740995',
  locale: 'de',
  shopId: 'gid://shopify/Shop/95',
};
const store = 'https://translation-qa.myshopify.com';
function fixture() {
  return {
    shop: { id: ids.shopId, myshopifyDomain: 'translation-qa.myshopify.com' },
    currentAppInstallation: {
      accessScopes: ['read_products', 'write_translations', 'read_locales'].map((handle) => ({
        handle,
      })),
    },
    shopLocales: [
      { locale: 'pl', name: 'Polski', primary: true, published: true },
      { locale: 'de', name: 'Deutsch', primary: false, published: true },
      { locale: 'en-US', name: 'English US', primary: false, published: true },
      { locale: 'fr', name: 'Français', primary: false, published: false },
    ],
    productVariant: { id: ids.variantId, sku: 'QA-95', product: { id: ids.productId } },
    translatableResource: {
      resourceId: ids.productId,
      translatableContent: [
        { key: 'title', value: 'Kubek', digest: 'title-digest-opaque', locale: 'pl' },
        { key: 'body_html', value: '<p>Opis</p>', digest: 'body-digest-opaque', locale: 'pl' },
        { key: 'handle', value: 'kubek', digest: null, locale: 'pl' },
      ],
      translations: [] as any[],
    },
  };
}
function translated(key = 'title', value = 'Becher', extra: any = {}) {
  return {
    key,
    locale: 'de',
    value,
    outdated: false,
    updatedAt: '2026-10-05T10:00:00Z',
    market: null,
    ...extra,
  };
}
const response = (data: any, status = 200, version = SHOPIFY_VERSION) =>
  new Response(JSON.stringify({ data }), { status, headers: { 'X-Shopify-API-Version': version } });
function client(fn: (b: any) => Promise<Response> | Response) {
  return new Shopify(
    { store_url: store },
    { access_token: 'qa-translations-token-2026' },
    async (url, init) => {
      assert.equal(url, store + '/admin/api/2026-10/graphql.json');
      assert.equal(init.method, 'POST');
      assert.equal(
        new Headers(init.headers).get('X-Shopify-Access-Token'),
        'qa-translations-token-2026',
      );
      return fn(JSON.parse(String(init.body)));
    },
    async () => {},
  );
}
async function snapshot(d = fixture(), locale = 'de') {
  return client(() => response(d)).productTranslation({ ...ids, locale });
}
const status = (code: number) => (e: any) => e.status === code;
test('OAuth translation permission is opt-in, preserves default scopes and includes locale reads', () => {
  const defaultScopes = shopifyRequestedScopes(shopifyOAuthInput.parse({}));
  assert.deepEqual(defaultScopes, [
    'read_inventory',
    'read_locations',
    'read_orders',
    'read_products',
  ]);
  const scopes = shopifyRequestedScopes(shopifyOAuthInput.parse({ translations_write: true }));
  assert(scopes.includes('write_translations') && scopes.includes('read_locales'));
  assert(!scopes.includes('write_products') && !scopes.includes('write_locales'));
});
test('fixed resource read preserves large GIDs, exact locale, source digests and market overrides', async () => {
  const d = fixture();
  d.translatableResource.translations = [
    translated(),
    translated('title', 'Markt', { market: { id: 'gid://shopify/Market/3' } }),
  ];
  let requests = 0,
    guards = 0;
  const r = await client((b) => {
    requests++;
    assert(b.query.startsWith('query DynaProductTranslation'));
    assert.deepEqual(b.variables, {
      resourceId: ids.productId,
      variantId: ids.variantId,
      locale: 'de',
    });
    assert(b.query.includes('translations(locale:$locale)'));
    return response(d);
  }).productTranslation(ids, async () => {
    guards++;
  });
  assert.equal(requests, 1);
  assert.equal(guards, 1);
  assert.equal(r.productId, ids.productId);
  assert.equal(r.source.length, 2);
  assert.equal(r.translations.length, 2);
  assert.equal(r.scopes.includes('read_translations'), true);
});
test('locale metadata read validates shop identity and token scopes without order-data permission', async () => {
  const d = fixture();
  let n = 0;
  const r = await client((b) => {
    n++;
    assert(b.query.startsWith('query DynaTranslationLocales'));
    assert.deepEqual(b.variables, {});
    return response(d);
  }).translationLocales(ids.shopId);
  assert.equal(r.locales.length, 4);
  assert.equal(n, 1);
  d.shop.id = 'gid://shopify/Shop/96';
  await assert.rejects(client(() => response(d)).translationLocales(ids.shopId), status(502));
  d.shop.id = ids.shopId;
  d.currentAppInstallation.accessScopes = [{ handle: 'read_markets_home' }];
  assert.equal((await client(() => response(d)).translationLocales(ids.shopId)).locales.length, 4);
});
test('rejects wrong shop/domain/product/variant/resource and malformed response identities', async () => {
  for (const mutate of [
    (d: any) => {
      d.shop.myshopifyDomain = 'other.myshopify.com';
    },
    (d: any) => {
      d.shop.id = 'gid://shopify/Shop/1';
    },
    (d: any) => {
      d.productVariant.id = 'gid://shopify/ProductVariant/1';
    },
    (d: any) => {
      d.productVariant.product.id = 'gid://shopify/Product/1';
    },
    (d: any) => {
      d.translatableResource.resourceId = 'gid://shopify/Product/1';
    },
    (d: any) => {
      d.productVariant = null;
    },
    (d: any) => {
      d.translatableResource = null;
    },
  ]) {
    const d = fixture();
    mutate(d);
    await assert.rejects(snapshot(d), status(502));
  }
});
test('rejects missing permissions, duplicate locales, missing/multiple primary and case-ambiguous locale list', async () => {
  for (const mutate of [
    (d: any) => {
      d.currentAppInstallation.accessScopes = [{ handle: 'read_locales' }];
    },
    (d: any) => {
      d.currentAppInstallation.accessScopes = [
        { handle: 'read_products' },
        { handle: 'write_translations' },
      ];
    },
    (d: any) => {
      d.shopLocales.push({ ...d.shopLocales[1] });
    },
    (d: any) => {
      d.shopLocales[0].primary = false;
    },
    (d: any) => {
      d.shopLocales[1].primary = true;
    },
    (d: any) => {
      d.shopLocales.push({ ...d.shopLocales[2], locale: 'en-us' });
    },
  ]) {
    const d = fixture();
    mutate(d);
    await assert.rejects(snapshot(d));
  }
});
test('does not collapse regional locales; unpublished and primary destination cannot be prepared', async () => {
  await assert.rejects(snapshot(fixture(), 'en'), status(422));
  await assert.rejects(snapshot(fixture(), 'en-us'), status(422));
  const en = await snapshot(fixture(), 'en-US');
  assert.equal(prepareProductTranslation(en, { name: 'Mug' }).translations[0].locale, 'en-US');
  const primary = await snapshot(fixture(), 'pl'),
    unpublished = await snapshot(fixture(), 'fr');
  assert.throws(() => prepareProductTranslation(primary, { name: 'Kubek' }), status(422));
  assert.throws(() => prepareProductTranslation(unpublished, { name: 'Tasse' }), status(422));
});
test('duplicate fields, wrong source locale, wrong target locale and same-market ambiguity are rejected', async () => {
  for (const mutate of [
    (d: any) => {
      d.translatableResource.translatableContent.push({
        ...d.translatableResource.translatableContent[0],
      });
    },
    (d: any) => {
      d.translatableResource.translatableContent[0].locale = 'en';
    },
    (d: any) => {
      d.translatableResource.translations = [translated('title', 'x', { locale: 'en' })];
    },
    (d: any) => {
      d.translatableResource.translations = [translated(), translated()];
    },
    (d: any) => {
      d.translatableResource.translations = [translated('title', 'x', { outdated: null })];
    },
  ]) {
    const d = fixture();
    mutate(d);
    await assert.rejects(snapshot(d), status(502));
  }
});
test('nullable source content/digest is readable, but unusable fields cannot be written', async () => {
  const d = fixture();
  (d.translatableResource.translatableContent[0] as any).digest = null;
  const s = await snapshot(d);
  assert.throws(() => prepareProductTranslation(s, { name: 'Becher' }), status(422));
  assert.equal(
    prepareProductTranslation(s, { description: 'Opis' }).translations[0].key,
    'body_html',
  );
  (d.translatableResource.translatableContent[1] as any).value = null;
  const empty = await snapshot(d);
  assert.throws(() => prepareProductTranslation(empty, { description: '' }), status(422));
});
test('description uses escaped paragraphs and never interprets local HTML; empty description is explicit', async () => {
  assert.equal(
    translationDescriptionHtml('<script>alert("x")</script> & \'y\'\r\nline\r\n\r\nnext'),
    '<p>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;y&#39;<br>line</p><p>next</p>',
  );
  assert.equal(translationDescriptionHtml(''), '');
  assert.throws(() => translationDescriptionHtml('x\u0000'));
  assert.throws(() => translationDescriptionHtml('x'.repeat(10001)));
  const s = await snapshot(),
    one = prepareProductTranslation(s, { name: 'Becher' });
  assert.equal(one.translations.length, 1);
  assert.equal(prepareProductTranslation(s, { description: '' }).translations[0].value, '');
  assert.throws(() => prepareProductTranslation(s, {}));
  assert.throws(() => prepareProductTranslation(s, { name: ' ' }));
});
test('write requires permission, digest and strict title/field/locale/market boundary before any network', async () => {
  const d = fixture();
  d.currentAppInstallation.accessScopes = [
    { handle: 'read_products' },
    { handle: 'read_translations' },
    { handle: 'read_locales' },
  ];
  const readOnly = await snapshot(d);
  assert.throws(() => prepareProductTranslation(readOnly, { name: 'Becher' }), status(403));
  const input = prepareProductTranslation(await snapshot(), {
    name: 'Becher',
    description: 'Opis',
  });
  const badInputs = [
    { ...input, resourceId: 'gid://shopify/Collection/1' },
    { ...input, translations: [] },
    { ...input, translations: [input.translations[0], input.translations[0]] },
    {
      ...input,
      translations: input.translations.map((t, i) => ({ ...t, locale: i ? 'en' : 'de' })),
    },
    { ...input, translations: [{ ...input.translations[0], marketId: 'gid://shopify/Market/1' }] },
    { ...input, translations: [{ ...input.translations[0], key: 'handle' }] },
    { ...input, translations: [{ ...input.translations[0], translatableContentDigest: '' }] },
    { ...input, translations: [{ ...input.translations[0], value: 'x\ny' }] },
    { ...input, translations: [{ ...input.translations[0], value: 'x'.repeat(501) }] },
  ];
  let n = 0;
  const c = client(() => {
    n++;
    return response({});
  });
  for (const b of badInputs) await assert.rejects(c.registerProductTranslations(b, async () => {}));
  await assert.rejects(c.registerProductTranslations(input, undefined as any), status(422));
  await assert.rejects(c.productTranslation({ ...ids, variantId: 'gid://shopify/Product/1' }));
  assert.equal(n, 0);
});
test('one fixed mutation, guard before transport, partial userErrors retained and no success without readback', async () => {
  const input = prepareProductTranslation(await snapshot(), {
    name: 'Becher',
    description: 'Opis',
  });
  const events: string[] = [];
  const result = await client((b) => {
    events.push('network');
    assert(b.query.startsWith('mutation DynaProductTranslationRegister'));
    assert.deepEqual(b.variables, input);
    return response({
      translationsRegister: {
        translations: [translated()],
        userErrors: [
          { field: ['translations', '1', 'translatableContentDigest'], message: 'Digest mismatch' },
        ],
      },
    });
  }).registerProductTranslations(input, async () => {
    events.push('checkpoint');
  });
  assert.deepEqual(events, ['checkpoint', 'network']);
  assert.equal(result.userErrors.length, 1);
  assert(result.requiresReadback);
  let n = 0;
  await assert.rejects(
    client(() => {
      n++;
      return response({});
    }).registerProductTranslations(input, async () => {
      throw new Error('lease revoked');
    }),
  );
  assert.equal(n, 0);
});
test('ambiguous writes never retry HTTP 429/500/401, throttled GraphQL, version mismatch or lost response', async () => {
  const input = prepareProductTranslation(await snapshot(), { name: 'Becher' });
  for (const mode of ['429', '500', '401', 'throttled', 'version', 'lost', 'malformed']) {
    let n = 0;
    const c = client(() => {
      n++;
      if (mode === 'lost') throw new Error('connection lost');
      if (mode === 'throttled')
        return new Response(JSON.stringify({ errors: [{ extensions: { code: 'THROTTLED' } }] }), {
          headers: { 'X-Shopify-API-Version': SHOPIFY_VERSION },
        });
      if (mode === 'version') return response({}, 200, '2026-07');
      if (mode === 'malformed')
        return response({ translationsRegister: { translations: [], userErrors: null } });
      return response({}, Number(mode));
    });
    await assert.rejects(c.registerProductTranslations(input, async () => {}));
    assert.equal(n, 1, mode);
  }
});
test('reads retry bounded transient failures and recheck guards on every attempt', async () => {
  let n = 0,
    g = 0;
  const c = client(() => (++n < 3 ? response({}, 429) : response(fixture())));
  await c.productTranslation(ids, async () => {
    g++;
  });
  assert.equal(n, 3);
  assert.equal(g, 3);
  n = 0;
  g = 0;
  await assert.rejects(
    client(() => {
      n++;
      return response({}, 500);
    }).translationLocales(ids.shopId, async () => {
      if (++g === 2) throw new Error('revoked');
    }),
  );
  assert.equal(n, 1);
  assert.equal(g, 2);
});
test('registration response rejects wrong locale, unexpected fields/market, duplicate keys and missing selected fields', async () => {
  const input = prepareProductTranslation(await snapshot(), { name: 'Becher' });
  for (const translations of [
    [translated('title', 'x', { locale: 'en' })],
    [translated('title', 'x', { market: { id: 'gid://shopify/Market/2' } })],
    [translated('handle')],
    [translated(), translated()],
    [{ key: 'title', locale: 'de', value: 'x' }],
  ]) {
    await assert.rejects(
      client(() =>
        response({ translationsRegister: { translations, userErrors: [] } }),
      ).registerProductTranslations(input, async () => {}),
      status(502),
    );
  }
  const r = await client(() =>
    response({
      translationsRegister: {
        translations: null,
        userErrors: [{ field: null, message: 'rejected' }],
      },
    }),
  ).registerProductTranslations(input, async () => {});
  assert.equal(r.translations.length, 0);
  assert.equal(r.userErrors.length, 1);
});
test('readback requires exact values, global destination, fresh source digests and non-outdated state', async () => {
  const s = await snapshot(),
    input = prepareProductTranslation(s, { name: 'Becher', description: 'Opis' });
  const d = fixture();
  d.translatableResource.translations = [translated(), translated('body_html', '<p>Opis</p>')];
  assert(translationReadback(await snapshot(d), input).every((f) => f.confirmed));
  for (const mutate of [
    (v: any) => {
      v.translatableResource.translations[0].outdated = true;
    },
    (v: any) => {
      v.translatableResource.translations[0].value = 'Inny';
    },
    (v: any) => {
      v.translatableResource.translations[0].market = { id: 'gid://shopify/Market/2' };
    },
    (v: any) => {
      v.translatableResource.translatableContent[0].digest = 'changed';
    },
    (v: any) => {
      v.translatableResource.translations.shift();
    },
  ]) {
    const v = structuredClone(d);
    mutate(v);
    assert.equal(
      translationReadback(await snapshot(v), input).every((f) => f.confirmed),
      false,
    );
  }
  assert.throws(
    () => translationReadback(s, { ...input, resourceId: 'gid://shopify/Product/1' }),
    status(409),
  );
  assert(productTranslationWrite.safeParse(input).success);
});

test('preview comparison detects targeted source/destination changes but permits unrelated fields', async () => {
  const d = fixture();
  d.translatableResource.translations = [translated()];
  const before = await snapshot(d),
    input = prepareProductTranslation(before, { name: 'New title' });
  assert(translationPreviewMatches(before, await snapshot(d), input));
  const unrelated = structuredClone(d);
  unrelated.translatableResource.translatableContent[1].value = 'new body';
  unrelated.translatableResource.translations.push(translated('body_html', 'new body'));
  assert(translationPreviewMatches(before, await snapshot(unrelated), input));
  for (const mutate of [
    (v: any) => {
      v.translatableResource.translatableContent[0].digest = 'changed';
    },
    (v: any) => {
      v.translatableResource.translatableContent[0].value = 'changed';
    },
    (v: any) => {
      v.translatableResource.translations[0].value = 'changed';
    },
    (v: any) => {
      v.translatableResource.translations[0].updatedAt = '2026-10-05T11:00:00Z';
    },
    (v: any) => {
      v.translatableResource.translations[0].outdated = true;
    },
    (v: any) => {
      v.translatableResource.translations = [];
    },
    (v: any) => {
      v.shopLocales[1].published = false;
    },
    (v: any) => {
      v.productVariant.sku = 'other';
    },
    (v: any) => {
      v.currentAppInstallation.accessScopes = [
        { handle: 'read_products' },
        { handle: 'read_translations' },
        { handle: 'read_locales' },
      ];
    },
  ]) {
    const v = structuredClone(d);
    mutate(v);
    assert.equal(translationPreviewMatches(before, await snapshot(v), input), false);
  }
  const afterWrite = structuredClone(d);
  afterWrite.translatableResource.translations = [translated('title', 'New title')];
  afterWrite.shopLocales[1].published = false;
  assert.equal(translationReadback(await snapshot(afterWrite), input)[0].confirmed, false);
});

test('post-attempt evidence query is product-bound and does not depend on a surviving variant', async () => {
  const d: any = fixture();
  delete d.productVariant;
  const s = await client((b) => {
    assert(b.query.startsWith('query DynaProductTranslationEvidence'));
    assert(!b.query.includes('productVariant'));
    assert.deepEqual(b.variables, { resourceId: ids.productId, locale: 'de' });
    return response(d);
  }).productTranslationEvidence(ids);
  assert.equal(s.variantObserved, false);
  assert.equal(s.resourcePresent, true);
  assert.equal(s.variantId, ids.variantId);
  assert.equal(s.sku, null);
  await assert.rejects(client(() => response(d)).productTranslation(ids), status(502));
});
test('deleted resource or missing locale is negative post-attempt evidence; strict reads and foreign-shop evidence stay blocked', async () => {
  const d: any = fixture(),
    planned = prepareProductTranslation(await snapshot(), { name: 'Becher' });
  d.translatableResource = null;
  d.productVariant = null;
  const absent = await client(() => response(d)).productTranslationEvidence(ids);
  assert.equal(absent.resourcePresent, false);
  assert(translationReadback(absent, planned).every((f) => !f.confirmed));
  await assert.rejects(client(() => response(d)).productTranslation(ids), status(502));
  d.shop.id = 'gid://shopify/Shop/96';
  await assert.rejects(client(() => response(d)).productTranslationEvidence(ids), status(502));
  const e = fixture();
  e.shopLocales = e.shopLocales.filter((l) => l.locale !== 'de');
  const missing = await client(() => response(e)).productTranslationEvidence(ids);
  assert(translationReadback(missing, planned).every((f) => !f.confirmed));
  await assert.rejects(client(() => response(e)).productTranslation(ids), status(422));
});
