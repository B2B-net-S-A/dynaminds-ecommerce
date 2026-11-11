import { z } from 'zod';
import { ensure } from './errors';
import { effectiveShopifyScopes } from './shopify-auth-input';

// Keep Shopify's exact locale. en, en-US and en-GB are distinct destinations.
export const shopifyTranslationLocale = z
  .string()
  .max(35)
  .regex(/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/);
const gid = (kind: string) =>
  z.string().regex(new RegExp('^gid://shopify/' + kind + '/[1-9]\\d{0,19}$'));
const text = (max: number) =>
  z
    .string()
    .max(max)
    .refine((v) => !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(v));
const digest = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[^\s\x00-\x1f\x7f]+$/);
export const translationKeys = ['title', 'body_html'] as const;
const key = z.enum(translationKeys);
const localeSchema = z.object({
  locale: shopifyTranslationLocale,
  name: text(200).min(1),
  primary: z.boolean(),
  published: z.boolean(),
});
export type ShopifyLocale = z.infer<typeof localeSchema>;
const contextSchema = z.object({
  shop: z.object({ id: gid('Shop'), myshopifyDomain: z.string() }),
  currentAppInstallation: z.object({
    accessScopes: z.array(z.object({ handle: z.string().regex(/^[a-z_]{1,100}$/) })).max(200),
  }),
  shopLocales: z.array(localeSchema).min(1).max(20),
});
export function parseTranslationContext(
  raw: unknown,
  domain: string,
  expectedShopId?: string,
  product = false,
) {
  const p = contextSchema.safeParse(raw);
  ensure(p.success, 502, 'Niepełna konfiguracja języków Shopify');
  const d = p.data;
  ensure(
    d.shop.myshopifyDomain === domain && (!expectedShopId || d.shop.id === expectedShopId),
    502,
    'Tłumaczenia dotyczą innego sklepu Shopify',
  );
  const scopes = effectiveShopifyScopes(d.currentAppInstallation.accessScopes.map((s) => s.handle));
  ensure(
    scopes.includes('read_locales') || scopes.includes('read_markets_home'),
    403,
    'Shopify wymaga uprawnienia read_locales',
  );
  if (product)
    ensure(
      ['read_products', 'read_translations'].every((s) => scopes.includes(s)),
      403,
      'Shopify wymaga read_products i read_translations',
    );
  ensure(
    new Set(d.shopLocales.map((l) => l.locale.toLowerCase())).size === d.shopLocales.length &&
      d.shopLocales.filter((l) => l.primary).length === 1,
    502,
    'Niejednoznaczna lista języków Shopify',
  );
  return { shopId: d.shop.id, scopes, locales: d.shopLocales };
}
const contentSchema = z.object({
  key: text(128).min(1),
  value: text(256 * 1024).nullable(),
  digest: digest.nullable(),
  locale: shopifyTranslationLocale,
});
const translationSchema = z.object({
  key: text(128).min(1),
  locale: shopifyTranslationLocale,
  value: text(256 * 1024).nullable(),
  outdated: z.boolean(),
  updatedAt: z.string().datetime({ offset: true }).nullable(),
  market: z.object({ id: gid('Market') }).nullable(),
});
export const translationFields = 'key locale value outdated updatedAt market { id }';
const resourceSchema = z.object({
  productVariant: z
    .object({
      id: gid('ProductVariant'),
      sku: text(200).nullable(),
      product: z.object({ id: gid('Product') }),
    })
    .nullable()
    .optional(),
  translatableResource: z
    .object({
      resourceId: gid('Product'),
      translatableContent: z.array(contentSchema).max(100),
      translations: z.array(translationSchema).max(2000),
    })
    .nullable(),
});
export type ShopifyProductTranslation = ReturnType<typeof parseProductTranslation>;
export function parseProductTranslation(
  raw: unknown,
  domain: string,
  ids: { productId: string; variantId: string; locale: string; shopId?: string },
  evidenceOnly = false,
) {
  const ctx = parseTranslationContext(raw, domain, ids.shopId, true);
  const p = resourceSchema.safeParse(raw);
  ensure(p.success, 502, 'Niepełna treść tłumaczenia produktu Shopify');
  const d = p.data,
    r = d.translatableResource;
  ensure(
    (evidenceOnly ||
      (d.productVariant?.id === ids.variantId && d.productVariant.product.id === ids.productId)) &&
      (r ? r.resourceId === ids.productId : evidenceOnly),
    502,
    'Shopify zwrócił inny produkt lub wariant',
  );
  const primary = ctx.locales.find((l) => l.primary)!;
  ensure(
    evidenceOnly || ctx.locales.some((l) => l.locale === ids.locale),
    422,
    'Język nie jest włączony w sklepie Shopify',
  );
  ensure(
    new Set((r?.translatableContent ?? []).map((f) => f.key)).size ===
      (r?.translatableContent.length ?? 0),
    502,
    'Powtórzone pola źródłowe Shopify',
  );
  ensure(
    new Set((r?.translations ?? []).map((f) => JSON.stringify([f.key, f.market?.id ?? null])))
      .size === (r?.translations.length ?? 0) &&
      (r?.translations ?? []).every((f) => f.locale === ids.locale),
    502,
    'Niejednoznaczne tłumaczenia Shopify',
  );
  const source = (r?.translatableContent ?? []).filter((f) =>
    translationKeys.includes(f.key as any),
  );
  ensure(
    source.every((f) => f.locale === primary.locale),
    502,
    'Treść źródłowa dotyczy innego języka Shopify',
  );
  // Explicit market overrides are retained, never confused with the global destination.
  return {
    ...ctx,
    productId: ids.productId,
    variantId: ids.variantId,
    sku: evidenceOnly ? null : d.productVariant!.sku,
    variantObserved: !evidenceOnly,
    resourcePresent: Boolean(r),
    locale: ids.locale,
    source,
    translations: (r?.translations ?? []).filter((f) => translationKeys.includes(f.key as any)),
  };
}
export const productTranslationWrite = z
  .object({
    resourceId: gid('Product'),
    translations: z
      .array(
        z
          .object({
            key,
            locale: shopifyTranslationLocale,
            value: text(64 * 1024),
            translatableContentDigest: digest,
          })
          .strict(),
      )
      .min(1)
      .max(2),
  })
  .strict()
  .superRefine((b, ctx) => {
    if (
      new Set(b.translations.map((f) => f.key)).size !== b.translations.length ||
      new Set(b.translations.map((f) => f.locale)).size !== 1
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Jedna operacja dotyczy jednego języka i unikalnych pól',
      });
    for (const f of b.translations)
      if (f.key === 'title' && (!f.value.trim() || f.value.length > 500 || /[\r\n]/.test(f.value)))
        ctx.addIssue({ code: 'custom', message: 'Nieprawidłowy tytuł tłumaczenia' });
  });
export type ProductTranslationWrite = z.infer<typeof productTranslationWrite>;
export function translationDescriptionHtml(plain: string) {
  const v = text(10000).parse(plain).replace(/\r\n?/g, '\n');
  if (!v) return '';
  const escaped = v.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
  return escaped
    .split(/\n\n+/)
    .map((p) => '<p>' + p.replace(/\n/g, '<br>') + '</p>')
    .join('');
}
export function prepareProductTranslation(
  snapshot: ShopifyProductTranslation,
  desired: { name?: string; description?: string },
) {
  const p = z
    .object({ name: text(500).min(1).optional(), description: text(10000).optional() })
    .strict()
    .parse(desired);
  const locale = snapshot.locales.find((l) => l.locale === snapshot.locale);
  ensure(
    locale && !locale.primary && locale.published,
    422,
    'Wybierz opublikowany język dodatkowy Shopify',
  );
  ensure(snapshot.scopes.includes('write_translations'), 403, 'Shopify wymaga write_translations');
  const translations: ProductTranslationWrite['translations'] = [];
  for (const k of translationKeys) {
    const value =
      k === 'title'
        ? p.name
        : p.description === undefined
          ? undefined
          : translationDescriptionHtml(p.description);
    if (value === undefined) continue;
    const src = snapshot.source.find((s) => s.key === k);
    ensure(
      src?.digest && src.value !== null,
      422,
      'Brak źródła lub digest pola ' + k + ' w Shopify',
    );
    translations.push({
      key: k,
      locale: snapshot.locale,
      value,
      translatableContentDigest: src.digest,
    });
  }
  return productTranslationWrite.parse({ resourceId: snapshot.productId, translations });
}
// A mutation response is evidence only. The worker must perform a fresh read before completion.
export function parseTranslationRegistration(raw: unknown, input: ProductTranslationWrite) {
  const p = z
    .object({
      translations: z.array(translationSchema).max(2).nullable(),
      userErrors: z
        .array(
          z.object({ field: z.array(z.string().max(200)).max(20).nullable(), message: text(2000) }),
        )
        .max(100),
    })
    .safeParse(raw);
  ensure(p.success, 502, 'Niepełny wynik zapisu tłumaczenia; odczytaj stan Shopify');
  const d = p.data;
  ensure(
    (d.translations ?? []).every(
      (f) =>
        f.market === null &&
        f.locale === input.translations[0].locale &&
        input.translations.some((i) => i.key === f.key),
    ) && new Set((d.translations ?? []).map((f) => f.key)).size === (d.translations ?? []).length,
    502,
    'Shopify zwrócił inne pola tłumaczenia; odczytaj stan',
  );
  return {
    translations: d.translations ?? [],
    userErrors: d.userErrors,
    requiresReadback: true as const,
  };
}
export function translationReadback(
  snapshot: ShopifyProductTranslation,
  input: ProductTranslationWrite,
) {
  productTranslationWrite.parse(input);
  ensure(
    snapshot.productId === input.resourceId && snapshot.locale === input.translations[0].locale,
    409,
    'Odczyt dotyczy innego produktu lub języka',
  );
  const destination = snapshot.locales.find((l) => l.locale === snapshot.locale);
  return input.translations.map((f) => {
    const current = snapshot.translations.find((t) => t.key === f.key && t.market === null),
      source = snapshot.source.find((s) => s.key === f.key);
    return {
      key: f.key,
      expected: f.value,
      observed: current?.value ?? null,
      outdated: current?.outdated ?? null,
      sourceMatches: source?.digest === f.translatableContentDigest,
      confirmed:
        !!destination &&
        destination.published &&
        !destination.primary &&
        !!current &&
        !current.outdated &&
        current.value === f.value &&
        source?.digest === f.translatableContentDigest,
    };
  });
}

// Digest protects original content only. Existing translations have no remote CAS.
// This comparison is for the worker's last read before its single mutation attempt.
export function translationPreviewMatches(
  before: ShopifyProductTranslation,
  current: ShopifyProductTranslation,
  input: ProductTranslationWrite,
) {
  productTranslationWrite.parse(input);
  const destination = current.locales.find((l) => l.locale === input.translations[0].locale);
  if (
    before.shopId !== current.shopId ||
    before.productId !== current.productId ||
    before.variantId !== current.variantId ||
    before.sku !== current.sku ||
    before.productId !== input.resourceId ||
    before.locale !== input.translations[0].locale ||
    current.locale !== before.locale ||
    !destination ||
    destination.primary ||
    !destination.published ||
    !current.scopes.includes('write_translations')
  )
    return false;
  for (const f of input.translations) {
    const oldSource = before.source.find((s) => s.key === f.key),
      source = current.source.find((s) => s.key === f.key);
    if (
      !oldSource ||
      !source ||
      oldSource.digest !== f.translatableContentDigest ||
      source.digest !== oldSource.digest ||
      source.value !== oldSource.value ||
      source.locale !== oldSource.locale
    )
      return false;
    const oldTarget = before.translations.find((t) => t.key === f.key && t.market === null),
      target = current.translations.find((t) => t.key === f.key && t.market === null);
    if (
      !!oldTarget !== !!target ||
      oldTarget?.value !== target?.value ||
      oldTarget?.outdated !== target?.outdated ||
      oldTarget?.updatedAt !== target?.updatedAt
    )
      return false;
  }
  return true;
}
