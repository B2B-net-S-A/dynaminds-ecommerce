import {
  shopifySubscriptionFields,
  parseShopifySubscription,
  subscriptionBody,
  subscriptionId,
} from './shopify-subscription-api';
import { effectiveShopifyScopes } from './shopify-auth-input';
import {
  parseTranslationContext,
  parseProductTranslation,
  productTranslationWrite,
  parseTranslationRegistration,
  shopifyTranslationLocale,
  translationFields,
} from './shopify-translation-api';
import {
  shopifyFulfillmentBody,
  shopifyFulfillmentOrderFields,
  shopifyFulfillmentLineFields,
  shopifyFulfillmentFields,
  shopifyFulfillmentPage,
  shopifyFulfillmentCollection,
} from './shopify-fulfillment-api';
import { setTimeout } from 'node:timers/promises';
import { ensure, Problem } from './errors';
import type { Transport } from './integrations';

export const SHOPIFY_VERSION = '2026-10';
export function shopifyStore(value: string) {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    throw new Problem(422, 'Wymagany adres HTTPS sklepu myshopify.com');
  }
  ensure(
    u.protocol === 'https:' &&
      /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.myshopify\.com$/.test(u.hostname) &&
      !u.port &&
      !u.username &&
      !u.password &&
      u.pathname === '/' &&
      !u.search &&
      !u.hash,
    422,
    'Wymagana domena konkretnego sklepu https://nazwa.myshopify.com',
  );
  return u.origin;
}
export function shopifyToken(value: string) {
  ensure(
    typeof value === 'string' && value.length >= 16 && value.length <= 4096 && !/\s/.test(value),
    422,
    'Nieprawidłowy token aplikacji Shopify',
  );
  return value;
}
export function shopifyId(value: unknown, kind: string) {
  ensure(
    typeof value === 'string' &&
      new RegExp('^gid://shopify/' + kind + '/[1-9]\\d{0,19}$').test(value),
    422,
    'Nieprawidłowy identyfikator Shopify ' + kind,
  );
  return value;
}
export function shopifyCursor(value: unknown): string | null {
  ensure(
    value === null ||
      value === undefined ||
      (typeof value === 'string' &&
        value.length > 0 &&
        value.length <= 2048 &&
        !/[\x00-\x1f]/.test(value)),
    422,
    'Nieprawidłowy cursor Shopify',
  );
  return value == null ? null : (value as string);
}
export function shopifyOrderTime(value: unknown): number | null {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)
  )
    return null;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 19) === value.slice(0, 19)
    ? time
    : null;
}
function connection(raw: any, limit: number, kind: string, after: string | null = null) {
  ensure(
    raw &&
      Array.isArray(raw.nodes) &&
      raw.nodes.length <= limit &&
      typeof raw.pageInfo?.hasNextPage === 'boolean',
    502,
    'Nieprawidłowa strona Shopify ' + kind,
  );
  const ids = raw.nodes.map((n: any) => shopifyId(n?.id, kind));
  ensure(new Set(ids).size === ids.length, 502, 'Powtórzone rekordy Shopify ' + kind);
  const cursor = shopifyCursor(raw.pageInfo.endCursor);
  ensure(
    !raw.pageInfo.hasNextPage || (raw.nodes.length > 0 && cursor && cursor !== after),
    502,
    'Brak postępu paginacji Shopify ' + kind,
  );
  return {
    data: raw.nodes as any[],
    has_more: raw.pageInfo.hasNextPage as boolean,
    next_cursor: cursor,
  };
}
const moneyFields = '{ presentmentMoney { amount currencyCode } }';
const lineFields = `id name sku quantity currentQuantity unfulfilledQuantity requiresShipping isGiftCard
  variant { id } sellingPlan { name } customAttributes { key value } duties { id }
  originalTotalSet ${moneyFields} discountAllocations { allocatedAmountSet ${moneyFields} }
  taxLines { priceSet ${moneyFields} }`;
const shippingFields = `id isRemoved originalPriceSet ${moneyFields} discountedPriceSet ${moneyFields} taxLines { priceSet ${moneyFields} }`;
const pageFields = 'pageInfo { hasNextPage endCursor }';
const orderFields = `id name updatedAt edited cancelledAt displayFinancialStatus displayFulfillmentStatus
  presentmentCurrencyCode taxesIncluded email note paymentGatewayNames refunds { id }
  shippingAddress { firstName lastName company address1 address2 city zip countryCodeV2 phone }
  totalPriceSet ${moneyFields} currentTotalPriceSet ${moneyFields} totalReceivedSet ${moneyFields}
  totalRefundedSet ${moneyFields} totalTipReceivedSet ${moneyFields} totalTaxSet ${moneyFields}
  currentTotalAdditionalFeesSet ${moneyFields} currentTotalDutiesSet ${moneyFields}
  totalCashRoundingAdjustment { paymentSet ${moneyFields} refundSet ${moneyFields} }
  lineItems(first:10) { nodes { ${lineFields} } ${pageFields} }
  shippingLines(first:5) { nodes { ${shippingFields} } ${pageFields} }`;
const publicationFields =
  'id autoPublish supportsFuturePublishing catalog { __typename id title status }';
const fulfillmentRawFields = orderFields
  .replace('lineItems(first:10)', 'lineItems(first:100)')
  .replace('shippingLines(first:5)', 'shippingLines(first:20)');
const queries = {
  translationProductIdentity: `query DynaTranslationProductIdentity($variantId:ID!) { shop { id myshopifyDomain } productVariant(id:$variantId) { id sku product { id } } }`,
  translationLocales: `query DynaTranslationLocales { shop { id myshopifyDomain }
    currentAppInstallation { accessScopes { handle } }
    shopLocales { locale name primary published } }`,
  productTranslation: `query DynaProductTranslation($resourceId:ID!,$variantId:ID!,$locale:String!) {
    shop { id myshopifyDomain } currentAppInstallation { accessScopes { handle } }
    shopLocales { locale name primary published }
    productVariant(id:$variantId) { id sku product { id } }
    translatableResource(resourceId:$resourceId) {
      resourceId translatableContent { key value digest locale }
      translations(locale:$locale) { ${translationFields} }
    }
  }`,
  productTranslationEvidence: `query DynaProductTranslationEvidence($resourceId:ID!,$locale:String!) {
    shop { id myshopifyDomain } currentAppInstallation { accessScopes { handle } }
    shopLocales { locale name primary published }
    translatableResource(resourceId:$resourceId) {
      resourceId translatableContent { key value digest locale }
      translations(locale:$locale) { ${translationFields} }
    }
  }`,
  translationRegister: `mutation DynaProductTranslationRegister($resourceId:ID!,$translations:[TranslationInput!]!) {
    translationsRegister(resourceId:$resourceId,translations:$translations) {
      translations { ${translationFields} } userErrors { field message }
    }
  }`,
  fulfillmentState: `query DynaFulfillmentState($id:ID!,$after:String) { shop { myshopifyDomain } currentAppInstallation { accessScopes { handle } } order(id:$id) { ${fulfillmentRawFields} fulfillmentOrders(first:25,after:$after) { nodes { ${shopifyFulfillmentOrderFields} } ${pageFields} } fulfillmentsCount { count precision } fulfillments(first:100) { ${shopifyFulfillmentFields} } } }`,
  fulfillmentLines: `query DynaFulfillmentLines($id:ID!,$after:String) { shop { myshopifyDomain } fulfillmentOrder(id:$id) { id orderId updatedAt lineItems(first:25,after:$after) { nodes { ${shopifyFulfillmentLineFields} } ${pageFields} } } }`,
  subscriptionList: `query DynaWebhookSubscriptions($after:String) { shop { id myshopifyDomain } app { id apiKey webhookApiVersion } webhookSubscriptions(first:100,after:$after) { nodes { ${shopifySubscriptionFields} } pageInfo { hasNextPage endCursor } } }`,
  subscriptionCreate: `mutation DynaWebhookSubscriptionCreate($topic:WebhookSubscriptionTopic!,$webhookSubscription:WebhookSubscriptionInput!) { webhookSubscriptionCreate(topic:$topic,webhookSubscription:$webhookSubscription) { webhookSubscription { ${shopifySubscriptionFields} } userErrors { field message } } }`,
  subscriptionDelete: `mutation DynaWebhookSubscriptionDelete($id:ID!) { webhookSubscriptionDelete(id:$id) { deletedWebhookSubscriptionId userErrors { field message } } }`,
  fulfillmentCreate: `mutation DynaFulfillmentCreate($fulfillment:FulfillmentInput!) { fulfillmentCreate(fulfillment:$fulfillment) { fulfillment { id order { id } } userErrors { field message } } }`,
  publications: `query DynaPublications($after:String) { shop { myshopifyDomain } publications(first:25,after:$after) { nodes { ${publicationFields} } ${pageFields} } }`,
  publicationOffer: `query DynaPublicationOffer($id:ID!,$publication:ID!) {
    shop { myshopifyDomain }
    publication(id:$publication) { ${publicationFields} }
    productVariant(id:$id) { id sku product { id title status requiresSellingPlan
      variantsCount { count precision } publishedOnPublication(publicationId:$publication) } }
  }`,
  activate: `mutation DynaProductActivate($product:ProductUpdateInput!) { productUpdate(product:$product) { product { id status } userErrors { field message } } }`,
  publish: `mutation DynaProductPublish($id:ID!,$publication:ID!,$input:[PublicationInput!]!) {
    publishablePublish(id:$id,input:$input) { publishable { ... on Product { id publishedOnPublication(publicationId:$publication) } }
      shop { myshopifyDomain } userErrors { field message } }
  }`,
  catalogSettings: `query DynaCatalogSettings { shop { myshopifyDomain currencyCode taxesIncluded } }`,
  catalog: `query DynaCatalog($after:String,$stock:Boolean!,$location:ID!) {
    shop { myshopifyDomain currencyCode taxesIncluded }
    productVariants(first:25,after:$after,sortKey:ID) { nodes {
      id sku title barcode price compareAtPrice taxable requiresComponents selectedOptions { name value }
      media(first:1) { nodes { __typename ... on MediaImage { image { url } } } pageInfo { hasNextPage } }
      inventoryItem { id tracked requiresShipping
        inventoryLevel(locationId:$location,includeInactive:true) @include(if:$stock) { id isActive item { id }
          location { id isActive fulfillsOnlineOrders } quantities(names:["available"]) { name quantity } }
      }
      product { id title description(truncateAt:10001) productType status hasOnlyDefaultVariant isGiftCard updatedAt
        options { name optionValues { name } }
        media(first:11) { nodes { __typename ... on MediaImage { image { url } } } pageInfo { hasNextPage } }
      }
    } ${pageFields} }
  }`,
  test: 'query DynaShop { shop { id name myshopifyDomain currencyCode } currentAppInstallation { accessScopes { handle } } }',
  orders: `query DynaOrders($after:String,$filter:String) { orders(first:5,after:$after,sortKey:UPDATED_AT,query:$filter) { nodes { ${orderFields} } ${pageFields} } }`,
  order: `query DynaOrder($id:ID!) { shop { id myshopifyDomain } order(id:$id) { ${orderFields} } }`,
  lines: `query DynaLines($id:ID!,$after:String) { order(id:$id) { id updatedAt lineItems(first:20,after:$after) { nodes { ${lineFields} } ${pageFields} } } }`,
  shipping: `query DynaShipping($id:ID!,$after:String) { order(id:$id) { id updatedAt shippingLines(first:20,after:$after) { nodes { ${shippingFields} } ${pageFields} } } }`,
  products: `query DynaVariants($after:String) { shop { currencyCode } productVariants(first:25,after:$after) { nodes { id title sku barcode price product { id title status } selectedOptions { name value } } ${pageFields} } }`,
  offer: `query DynaOffer($id:ID!,$price:Boolean!,$stock:Boolean!,$location:ID!) {
    shop { myshopifyDomain currencyCode @include(if:$price) taxesIncluded @include(if:$price) }
    productVariant(id:$id) { id sku product { id status }
      price @include(if:$price) compareAtPrice @include(if:$price) taxable @include(if:$price)
      requiresComponents @include(if:$stock) inventoryPolicy @include(if:$stock)
      inventoryItem @include(if:$stock) { id tracked requiresShipping
        inventoryLevel(locationId:$location,includeInactive:true) { id isActive item { id }
          location { id isActive fulfillsOnlineOrders } quantities(names:["available"]) { name quantity } }
      }
    }
  }`,
  locations: `query DynaLocations($after:String) { shop { myshopifyDomain } locations(first:25,after:$after,includeInactive:true) { nodes { id name isActive fulfillsOnlineOrders } ${pageFields} } }`,
  location: `query DynaLocation($id:ID!) { shop { myshopifyDomain } location(id:$id) { id name isActive fulfillsOnlineOrders } }`,
  price: `mutation DynaOfferPrice($product:ID!,$variants:[ProductVariantsBulkInput!]!) { productVariantsBulkUpdate(productId:$product,variants:$variants,allowPartialUpdates:false) { product { id } productVariants { id price } userErrors { field message } } }`,
  stock: `mutation DynaOfferStock($input:InventorySetQuantitiesInput!,$key:String!) { inventorySetQuantities(input:$input) @idempotent(key:$key) { inventoryAdjustmentGroup { referenceDocumentUri changes { name delta } } userErrors { field message } } }`,
};
export type ShopifyWindow = { from: string | null; to: string };
export function shopifyFilter(window?: ShopifyWindow) {
  if (!window) return null;
  for (const d of [window.from, window.to])
    ensure(
      d === null ||
        (typeof d === 'string' &&
          Number.isFinite(Date.parse(d)) &&
          new Date(d).toISOString() === d),
      422,
      'Nieprawidłowe okno synchronizacji Shopify',
    );
  ensure(
    window.to && (!window.from || window.from <= window.to),
    422,
    'Nieprawidłowe granice synchronizacji Shopify',
  );
  return `${window.from ? `updated_at:>='${window.from}' AND ` : ''}updated_at:<='${window.to}'`;
}
// Only fixed queries/mutations. Reads may retry; writes must be reconciled by the offer worker.
export class Shopify {
  readonly base: string;
  private readonly token: string;
  private readonly clientId?: string;
  constructor(
    settings: Record<string, string>,
    credentials: Record<string, string>,
    private transport: Transport,
    private sleep: (ms: number) => Promise<unknown> = setTimeout,
  ) {
    this.base = shopifyStore(settings.store_url);
    this.token = shopifyToken(credentials.access_token);
    this.clientId = credentials.client_id;
  }
  private async query(
    key: keyof typeof queries,
    variables: Record<string, unknown> = {},
    guard?: () => Promise<void>,
  ) {
    const attempts = [
      'price',
      'stock',
      'activate',
      'publish',
      'fulfillmentCreate',
      'subscriptionCreate',
      'subscriptionDelete',
      'translationRegister',
    ].includes(key)
      ? 1
      : 3;
    for (let attempt = 0; attempt < attempts; attempt++) {
      await guard?.();
      const res = await this.transport(`${this.base}/admin/api/${SHOPIFY_VERSION}/graphql.json`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'X-Shopify-Access-Token': this.token,
        },
        body: JSON.stringify({ query: queries[key], variables }),
      });
      if ((res.status === 429 || res.status >= 500) && attempt + 1 < attempts) {
        const delay = Number(res.headers.get('retry-after') ?? 1);
        await res.body?.cancel();
        await this.sleep(
          Math.min(5000, Math.max(100, Number.isFinite(delay) ? delay * 1000 : 1000)),
        );
        continue;
      }
      ensure(
        res.ok,
        res.status === 401 || res.status === 403 ? res.status : 502,
        'Shopify: HTTP ' + res.status,
      );
      ensure(
        res.headers.get('X-Shopify-API-Version') === SHOPIFY_VERSION,
        502,
        'Shopify zwrócił inną lub niepotwierdzoną wersję API',
      );
      let result: any;
      const reader = res.body?.getReader();
      ensure(reader, 502, 'Brak odpowiedzi Shopify');
      try {
        const chunks: Uint8Array[] = [];
        let size = 0;
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          ensure(size <= 5 * 1024 * 1024, 502, 'Odpowiedź Shopify przekracza 5 MB');
          chunks.push(part.value);
        }
        result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch (e) {
        if (e instanceof Problem) throw e;
        throw new Problem(502, 'Nieprawidłowa odpowiedź JSON Shopify');
      } finally {
        await reader.cancel();
      }
      if (result.errors !== undefined) {
        ensure(Array.isArray(result.errors), 502, 'Nieprawidłowe błędy GraphQL Shopify');
        if (result.errors.length) {
          if (
            result.errors.every((e: any) => e.extensions?.code === 'THROTTLED') &&
            attempt + 1 < attempts
          ) {
            const cost = result.extensions?.cost,
              available = cost?.throttleStatus?.currentlyAvailable,
              restore = cost?.throttleStatus?.restoreRate;
            const delay =
              Number.isFinite(restore) &&
              restore > 0 &&
              Number.isFinite(available) &&
              Number.isFinite(cost.requestedQueryCost)
                ? Math.ceil((Math.max(0, cost.requestedQueryCost - available) / restore) * 1000)
                : 1000;
            await this.sleep(Math.min(5000, Math.max(100, delay)));
            continue;
          }
          throw new Problem(
            result.errors.some((e: any) => e.extensions?.code === 'ACCESS_DENIED') ? 403 : 502,
            'Shopify odrzucił zapytanie GraphQL; sprawdź uprawnienia aplikacji i limity API',
          );
        }
      }
      ensure(result.data && typeof result.data === 'object', 502, 'Brak danych GraphQL Shopify');
      return result.data;
    }
    throw new Problem(502, 'Shopify: wyczerpano limit ponowień');
  }
  async translationLocales(expectedShopId?: string, guard?: () => Promise<void>) {
    if (expectedShopId) shopifyId(expectedShopId, 'Shop');
    const d = await this.query('translationLocales', {}, guard);
    return parseTranslationContext(d, new URL(this.base).hostname, expectedShopId);
  }
  async translationProductIdentity(
    variantId: string,
    guard?: () => Promise<void>,
    expectedShopId?: string,
  ) {
    shopifyId(variantId, 'ProductVariant');
    if (expectedShopId) shopifyId(expectedShopId, 'Shop');
    const d = await this.query('translationProductIdentity', { variantId }, guard);
    this.sameShop(d);
    ensure(
      !expectedShopId || d.shop.id === expectedShopId,
      502,
      'Produkt dotyczy innego sklepu Shopify',
    );
    ensure(
      d.productVariant?.id === variantId &&
        (d.productVariant.sku === null || typeof d.productVariant.sku === 'string'),
      502,
      'Shopify zwrócił inny lub usunięty wariant',
    );
    return {
      id: variantId,
      sku: d.productVariant.sku,
      productId: shopifyId(d.productVariant.product?.id, 'Product'),
    };
  }
  async productTranslation(
    input: { productId: string; variantId: string; locale: string; shopId?: string },
    guard?: () => Promise<void>,
  ) {
    shopifyId(input.productId, 'Product');
    shopifyId(input.variantId, 'ProductVariant');
    if (input.shopId) shopifyId(input.shopId, 'Shop');
    shopifyTranslationLocale.parse(input.locale);
    const d = await this.query(
      'productTranslation',
      {
        resourceId: input.productId,
        variantId: input.variantId,
        locale: input.locale,
      },
      guard,
    );
    return parseProductTranslation(d, new URL(this.base).hostname, input);
  }
  // Post-attempt read only: variant deletion and destination removal are evidence,
  // not authorization to repeat the write. Frozen shop/product IDs remain mandatory.
  async productTranslationEvidence(
    input: { productId: string; variantId: string; locale: string; shopId: string },
    guard?: () => Promise<void>,
  ) {
    shopifyId(input.productId, 'Product');
    shopifyId(input.variantId, 'ProductVariant');
    shopifyId(input.shopId, 'Shop');
    shopifyTranslationLocale.parse(input.locale);
    const d = await this.query(
      'productTranslationEvidence',
      {
        resourceId: input.productId,
        locale: input.locale,
      },
      guard,
    );
    return parseProductTranslation(d, new URL(this.base).hostname, input, true);
  }
  // Internal worker primitive. Caller must durably mark the attempt in guard and reconcile.
  // Deliberately no public write route; OAuth refresh must use channelRead(..., false).
  async registerProductTranslations(input: unknown, guard: () => Promise<void>) {
    const body = productTranslationWrite.parse(input);
    ensure(typeof guard === 'function', 422, 'Zapis tłumaczenia wymaga ochrony zadania');
    const d = await this.query('translationRegister', body, guard);
    return parseTranslationRegistration(d.translationsRegister, body);
  }
  async subscriptions(
    guard?: () => Promise<void>,
    expectedShopId?: string,
    requireCurrentVersion = false,
  ) {
    let after: string | null = null;
    const rows: ReturnType<typeof parseShopifySubscription>[] = [];
    const ids = new Set<string>(),
      cursors = new Set<string>();
    for (let page = 0; page < 20; page++) {
      const d = await this.query('subscriptionList', { after }, guard);
      this.sameShop(d);
      shopifyId(d.shop?.id, 'Shop');
      ensure(
        !expectedShopId || d.shop.id === expectedShopId,
        502,
        'Subskrypcje dotyczą innego sklepu Shopify',
      );
      shopifyId(d.app?.id, 'App');
      ensure(
        typeof d.app.apiKey === 'string' &&
          d.app.apiKey.length > 0 &&
          typeof d.app.webhookApiVersion === 'string' &&
          /^\d{4}-(01|04|07|10)$/.test(d.app.webhookApiVersion),
        502,
        'Niepełna konfiguracja aplikacji Shopify',
      );
      ensure(
        !this.clientId || d.app.apiKey === this.clientId,
        502,
        'Token subskrypcji dotyczy innej aplikacji Shopify',
      );
      ensure(
        !requireCurrentVersion || d.app.webhookApiVersion === SHOPIFY_VERSION,
        409,
        `Ustaw wersję webhooków aplikacji Shopify na ${SHOPIFY_VERSION} przed rejestracją`,
      );
      const collection = d.webhookSubscriptions;
      ensure(
        collection &&
          Array.isArray(collection.nodes) &&
          collection.nodes.length <= 100 &&
          typeof collection.pageInfo?.hasNextPage === 'boolean',
        502,
        'Niepełna lista subskrypcji Shopify',
      );
      for (const n of collection.nodes) {
        const row = parseShopifySubscription(n);
        ensure(!ids.has(row.id), 502, 'Powtórzone ID subskrypcji Shopify');
        ids.add(row.id);
        rows.push(row);
      }
      if (!collection.pageInfo.hasNextPage) return rows.sort((a, b) => a.id.localeCompare(b.id));
      const next = collection.pageInfo.endCursor;
      ensure(
        collection.nodes.length > 0 &&
          typeof next === 'string' &&
          next.length > 0 &&
          next.length <= 2048 &&
          !cursors.has(next),
        502,
        'Nieprawidłowy cursor subskrypcji Shopify',
      );
      cursors.add(next);
      after = next;
    }
    throw new Problem(422, 'Lista subskrypcji Shopify przekracza 2000 rekordów');
  }
  async createSubscription(input: unknown, guard?: () => Promise<void>) {
    const body = subscriptionBody.parse(input);
    const d = await this.query('subscriptionCreate', body, guard),
      p = d.webhookSubscriptionCreate;
    ensure(p && Array.isArray(p.userErrors), 502, 'Niepełny wynik utworzenia subskrypcji Shopify');
    ensure(
      p.userErrors.length === 0,
      422,
      'Shopify odrzucił subskrypcję; sprawdź temat, zakresy i adres HTTPS',
    );
    const row = parseShopifySubscription(p.webhookSubscription);
    ensure(
      row.topic === body.topic &&
        row.uri === body.webhookSubscription.uri &&
        row.format === 'JSON' &&
        row.apiVersion.handle === SHOPIFY_VERSION &&
        !row.filter &&
        JSON.stringify([...row.includeFields].sort()) ===
          JSON.stringify([...body.webhookSubscription.includeFields].sort()),
      502,
      'Utworzona subskrypcja Shopify różni się od zatwierdzonej',
    );
    return row;
  }
  async deleteSubscription(id: string, guard?: () => Promise<void>) {
    subscriptionId.parse(id);
    const d = await this.query('subscriptionDelete', { id }, guard),
      p = d.webhookSubscriptionDelete;
    ensure(p && Array.isArray(p.userErrors), 502, 'Niepełny wynik usunięcia subskrypcji Shopify');
    ensure(p.userErrors.length === 0, 422, 'Shopify odrzucił usunięcie subskrypcji');
    ensure(p.deletedWebhookSubscriptionId === id, 502, 'Shopify usunął inną subskrypcję');
    return id;
  }
  async fulfillmentState(id: string, guard?: () => Promise<void>) {
    shopifyId(id, 'Order');
    let after: string | null = null,
      raw: any = null,
      scopes: string[] = [],
      orders: any[] = [],
      values: any[] = [],
      seen = new Set<string>();
    do {
      const d = await this.query('fulfillmentState', { id, after }, guard);
      this.sameShop(d);
      ensure(d.order?.id === id, 404, 'Nie znaleziono zamówienia Shopify');
      const o = d.order;
      ensure(
        typeof o.updatedAt === 'string' &&
          Number.isFinite(Date.parse(o.updatedAt)) &&
          (!raw || raw.updatedAt === o.updatedAt),
        409,
        'Zamówienie Shopify zmieniło się podczas odczytu realizacji',
      );
      if (!raw) {
        raw = structuredClone(o);
        delete raw.fulfillmentOrders;
        delete raw.fulfillments;
        delete raw.fulfillmentsCount;
        const lines = connection(raw.lineItems, 100, 'LineItem'),
          shipping = connection(raw.shippingLines, 20, 'ShippingLine');
        ensure(
          !lines.has_more && !shipping.has_more,
          422,
          'Nie pobrano wszystkich pozycji zamówienia Shopify',
        );
        ensure(
          Array.isArray(d.currentAppInstallation?.accessScopes),
          403,
          'Brak zakresów aplikacji Shopify',
        );
        scopes = effectiveShopifyScopes(
          d.currentAppInstallation.accessScopes.map((v: any) => v.handle),
        );
        ensure(
          scopes.includes('read_orders') &&
            scopes.includes('read_merchant_managed_fulfillment_orders'),
          403,
          'Wymagane read_orders i read_merchant_managed_fulfillment_orders',
        );
        ensure(
          o.fulfillmentsCount?.precision === 'EXACT' &&
            o.fulfillmentsCount.count === o.fulfillments?.length,
          422,
          'Nie pobrano wszystkich przesyłek Shopify',
        );
        values = shopifyFulfillmentCollection(o.fulfillments, id);
      }
      const page = shopifyFulfillmentPage(o.fulfillmentOrders, 'FulfillmentOrder', 25, after);
      orders.push(...page.data);
      ensure(
        orders.length <= 100 && new Set(orders.map((i) => i.id)).size === orders.length,
        422,
        'Powtórzone lub zbyt liczne zlecenia realizacji Shopify',
      );
      if (!page.more) break;
      ensure(!seen.has(page.cursor), 502, 'Powtórzony cursor realizacji Shopify');
      seen.add(page.cursor);
      after = page.cursor;
    } while (true);
    for (const o of orders) {
      ensure(
        o.orderId === id &&
          typeof o.updatedAt === 'string' &&
          Number.isFinite(Date.parse(o.updatedAt)),
        502,
        'Obce lub niewersjonowane zlecenie realizacji Shopify',
      );
      let page = shopifyFulfillmentPage(o.lineItems, 'FulfillmentOrderLineItem', 25),
        lines = [...page.data];
      const seen = new Set<string>();
      while (page.more) {
        ensure(!seen.has(page.cursor), 502, 'Powtórzony cursor pozycji realizacji Shopify');
        seen.add(page.cursor);
        const d = await this.query('fulfillmentLines', { id: o.id, after: page.cursor }, guard);
        this.sameShop(d);
        ensure(
          d.fulfillmentOrder?.id === o.id &&
            d.fulfillmentOrder.orderId === id &&
            d.fulfillmentOrder.updatedAt === o.updatedAt,
          409,
          'Zlecenie realizacji Shopify zmieniło się podczas odczytu',
        );
        page = shopifyFulfillmentPage(
          d.fulfillmentOrder.lineItems,
          'FulfillmentOrderLineItem',
          25,
          page.cursor,
        );
        lines.push(...page.data);
        ensure(
          lines.length <= 100 && new Set(lines.map((i) => i.id)).size === lines.length,
          422,
          'Powtórzone lub zbyt liczne pozycje realizacji Shopify',
        );
      }
      o.lineItems = lines;
    }
    return {
      raw,
      orders: orders.sort((a, b) => a.id.localeCompare(b.id)),
      fulfillments: values,
      scopes,
    };
  }
  async createFulfillment(body: unknown, orderId: string, guard: () => Promise<void>) {
    const fulfillment = shopifyFulfillmentBody.parse(body);
    shopifyId(orderId, 'Order');
    const d = await this.query('fulfillmentCreate', { fulfillment }, guard),
      p = d.fulfillmentCreate;
    ensure(Array.isArray(p?.userErrors), 502, 'Nieprawidłowy wynik realizacji Shopify');
    ensure(!p.userErrors.length, 422, 'Shopify odrzucił realizację; odczytaj aktualny stan');
    ensure(
      p.fulfillment?.order?.id === orderId,
      502,
      'Shopify zwrócił realizację innego zamówienia',
    );
    return shopifyId(p.fulfillment.id, 'Fulfillment');
  }
  async test() {
    const d = await this.query('test');
    ensure(
      d.shop?.myshopifyDomain === new URL(this.base).hostname,
      502,
      'Shopify zwrócił inny sklep',
    );
    const scopes = d.currentAppInstallation?.accessScopes;
    ensure(
      Array.isArray(scopes) &&
        ['read_orders', 'read_products'].every((s) =>
          effectiveShopifyScopes(scopes.map((v: any) => v.handle)).includes(s),
        ),
      403,
      'Shopify wymaga zakresów read_orders i read_products oraz dostępu do danych kupującego',
    );
    return {
      shop: d.shop,
      scopes: scopes.map((s: any) => s.handle),
      scope: 'read_only',
      historical_orders: scopes.some((s: any) => s.handle === 'read_all_orders'),
    };
  }
  async orders(after?: string | null, window?: ShopifyWindow, guard?: () => Promise<void>) {
    const cursor = shopifyCursor(after),
      filter = shopifyFilter(window);
    const result = connection(
      (await this.query('orders', { after: cursor, filter }, guard)).orders,
      5,
      'Order',
      cursor,
    );
    const rows = [];
    for (const source of result.data) rows.push(await this.completeOrder(source, guard));
    return { ...result, data: rows };
  }
  async order(id: string, guard?: () => Promise<void>, expectedShopId?: string) {
    shopifyId(id, 'Order');
    if (expectedShopId) shopifyId(expectedShopId, 'Shop');
    const d = await this.query('order', { id }, guard);
    this.sameShop(d);
    shopifyId(d.shop?.id, 'Shop');
    ensure(
      !expectedShopId || d.shop.id === expectedShopId,
      409,
      'Shopify zwrócił inne konto sklepu',
    );
    ensure(
      d.order,
      404,
      'Shopify nie udostępnia zamówienia; sprawdź dostęp lub uzgodnij usunięcie',
    );
    ensure(d.order.id === id, 502, 'Shopify zwrócił inne zamówienie');
    return this.completeOrder(d.order, guard);
  }
  private async completeOrder(source: any, guard?: () => Promise<void>) {
    shopifyId(source?.id, 'Order');
    const o = structuredClone(source);
    ensure(shopifyOrderTime(o.updatedAt) !== null, 502, 'Brak wersji zamówienia Shopify');
    for (const [field, key, kind, max] of [
      ['lineItems', 'lines', 'LineItem', 100],
      ['shippingLines', 'shipping', 'ShippingLine', 20],
    ] as const) {
      let page = connection(o[field], field === 'lineItems' ? 10 : 5, kind),
        data = [...page.data];
      const seen = new Set<string>();
      while (page.has_more) {
        const after = page.next_cursor!;
        ensure(!seen.has(after), 502, 'Powtórzony cursor Shopify');
        seen.add(after);
        ensure(
          data.length < max,
          422,
          `Zamówienie Shopify przekracza limit ${max} pozycji ${field}`,
        );
        const next = (await this.query(key, { id: o.id, after }, guard)).order;
        ensure(
          next?.id === o.id && next.updatedAt === o.updatedAt,
          502,
          'Zamówienie Shopify zmieniło się podczas odczytu; ponów całą stronę',
        );
        page = connection(next[field], 20, kind, after);
        data.push(...page.data);
        ensure(
          data.length <= max && new Set(data.map((v) => v.id)).size === data.length,
          502,
          'Niekompletne lub powtórzone pozycje Shopify',
        );
      }
      o[field] = { nodes: data, pageInfo: { hasNextPage: false, endCursor: page.next_cursor } };
    }
    return o;
  }
  async products(after?: string | null) {
    const cursor = shopifyCursor(after),
      d = await this.query('products', { after: cursor });
    return {
      ...connection(d.productVariants, 25, 'ProductVariant', cursor),
      currency: d.shop?.currencyCode,
      prices: 'store_catalog_tax_basis',
    };
  }
  private sameShop(d: any) {
    ensure(
      d.shop?.myshopifyDomain === new URL(this.base).hostname,
      502,
      'Shopify zwrócił inny sklep',
    );
  }
  private catalogContext(d: any) {
    this.sameShop(d);
    ensure(
      ['PLN', 'EUR', 'USD', 'GBP', 'CZK'].includes(d.shop?.currencyCode) &&
        typeof d.shop?.taxesIncluded === 'boolean',
      422,
      'Nieobsługiwana waluta lub brak sposobu wprowadzania cen Shopify',
    );
    return { currency: d.shop.currencyCode, prices_include_tax: d.shop.taxesIncluded };
  }
  async catalogSettings(guard?: () => Promise<void>) {
    return this.catalogContext(await this.query('catalogSettings', {}, guard));
  }
  async catalogPage(
    after: string | null,
    stock: boolean,
    location?: string,
    guard?: () => Promise<void>,
  ) {
    const cursor = shopifyCursor(after);
    if (stock) shopifyId(location, 'Location');
    const d = await this.query(
      'catalog',
      {
        after: cursor,
        stock,
        location: location ?? 'gid://shopify/Location/1',
      },
      guard,
    );
    return {
      ...connection(d.productVariants, 25, 'ProductVariant', cursor),
      context: this.catalogContext(d),
    };
  }
  async locations(after?: string | null) {
    const cursor = shopifyCursor(after),
      d = await this.query('locations', { after: cursor });
    this.sameShop(d);
    return connection(d.locations, 25, 'Location', cursor);
  }
  async location(id: string) {
    shopifyId(id, 'Location');
    const d = await this.query('location', { id });
    this.sameShop(d);
    ensure(d.location?.id === id, 502, 'Shopify nie potwierdził lokalizacji');
    return d.location;
  }
  async offer(id: string, price: boolean, stock: boolean, location?: string) {
    shopifyId(id, 'ProductVariant');
    ensure(price || stock, 422, 'Wybierz cenę lub stan Shopify');
    if (stock) shopifyId(location, 'Location');
    const d = await this.query('offer', {
      id,
      price,
      stock,
      location: location ?? 'gid://shopify/Location/1',
    });
    this.sameShop(d);
    ensure(d.productVariant?.id === id, 502, 'Shopify zwrócił inny lub usunięty wariant');
    return d;
  }
  async publications(after?: string | null) {
    const cursor = shopifyCursor(after),
      d = await this.query('publications', { after: cursor });
    this.sameShop(d);
    const page = connection(d.publications, 25, 'Publication', cursor);
    page.data.forEach(validateShopifyPublication);
    return page;
  }
  async publicationOffer(id: string, publication: string) {
    shopifyId(id, 'ProductVariant');
    shopifyId(publication, 'Publication');
    const d = await this.query('publicationOffer', { id, publication });
    this.sameShop(d);
    ensure(d.productVariant?.id === id, 502, 'Shopify zwrócił inny lub usunięty wariant');
    ensure(d.publication?.id === publication, 422, 'Publikacja Shopify nie jest dostępna');
    validateShopifyPublication(d.publication);
    return d;
  }
  async activateProduct(id: string) {
    shopifyId(id, 'Product');
    const r = (await this.query('activate', { product: { id, status: 'ACTIVE' } })).productUpdate;
    ensure(
      r && Array.isArray(r.userErrors) && !r.userErrors.length,
      502,
      'Shopify odrzucił aktywację; uzgodnij wynik',
    );
    ensure(
      r.product?.id === id && r.product.status === 'ACTIVE',
      502,
      'Shopify nie potwierdził aktywacji właściwego produktu',
    );
  }
  async publishProduct(id: string, publication: string) {
    shopifyId(id, 'Product');
    shopifyId(publication, 'Publication');
    const r = (
      await this.query('publish', { id, publication, input: [{ publicationId: publication }] })
    ).publishablePublish;
    ensure(
      r && Array.isArray(r.userErrors) && !r.userErrors.length,
      502,
      'Shopify odrzucił publikację; uzgodnij wynik',
    );
    this.sameShop(r);
    ensure(
      r.publishable?.id === id && r.publishable.publishedOnPublication === true,
      502,
      'Shopify nie potwierdził publikacji właściwego produktu',
    );
  }
  async setVariantPrice(product: string, id: string, price: string) {
    shopifyId(product, 'Product');
    shopifyId(id, 'ProductVariant');
    ensure(/^\d{1,8}\.\d{2}$/.test(price), 422, 'Nieprawidłowa cena Shopify');
    const r = (await this.query('price', { product, variants: [{ id, price }] }))
      .productVariantsBulkUpdate;
    ensure(
      r && Array.isArray(r.userErrors) && !r.userErrors.length,
      502,
      'Shopify odrzucił zapis ceny; uzgodnij wynik',
    );
    ensure(
      r.product?.id === product &&
        Array.isArray(r.productVariants) &&
        r.productVariants.length === 1 &&
        r.productVariants[0].id === id &&
        Number(r.productVariants[0].price) === Number(price),
      502,
      'Shopify nie potwierdził ceny właściwego wariantu',
    );
  }
  async setInventoryQuantity(
    item: string,
    location: string,
    quantity: number,
    compare: number,
    key: string,
  ) {
    shopifyId(item, 'InventoryItem');
    shopifyId(location, 'Location');
    ensure(
      Number.isInteger(quantity) &&
        quantity >= 0 &&
        quantity <= 2147483647 &&
        Number.isInteger(compare) &&
        Math.abs(compare) <= 2147483647,
      422,
      'Nieprawidłowa ilość Shopify',
    );
    ensure(
      /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/.test(key),
      422,
      'Wymagany klucz planu Shopify',
    );
    const reference = 'dynaminds://offer-plan/' + key;
    const r = (
      await this.query('stock', {
        key,
        input: {
          name: 'available',
          reason: 'correction',
          referenceDocumentUri: reference,
          ignoreCompareQuantity: false,
          quantities: [
            { inventoryItemId: item, locationId: location, quantity, compareQuantity: compare },
          ],
        },
      })
    ).inventorySetQuantities;
    ensure(
      r && Array.isArray(r.userErrors) && !r.userErrors.length,
      502,
      'Shopify odrzucił zapis stanu; uzgodnij wynik',
    );
    ensure(
      r.inventoryAdjustmentGroup?.referenceDocumentUri === reference &&
        Array.isArray(r.inventoryAdjustmentGroup.changes),
      502,
      'Shopify nie potwierdził operacji magazynowej',
    );
  }
}
function amount(bag: any, currency: string, nullable = false) {
  if (nullable && bag === null) return 0;
  const m = bag?.presentmentMoney;
  ensure(m?.currencyCode === currency, 422, 'Niezgodna waluta kupującego Shopify');
  ensure(
    typeof m.amount === 'string' && m.amount.length <= 32 && /^\d+(\.\d{1,2})?$/.test(m.amount),
    422,
    'Kwota Shopify musi mieć najwyżej dwa miejsca po przecinku',
  );
  const [whole, fraction = ''] = m.amount.split('.');
  const value = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  ensure(value <= 2147483647n, 422, 'Kwota Shopify przekracza limit');
  return Number(value);
}
export function normalizeShopify(raw: any) {
  const id = shopifyId(raw.id, 'Order'),
    currency = raw.presentmentCurrencyCode;
  ensure(
    ['PLN', 'EUR', 'USD', 'GBP', 'CZK'].includes(currency) &&
      typeof raw.taxesIncluded === 'boolean',
    422,
    'Nieobsługiwana waluta lub brak trybu podatków Shopify',
  );
  const lines = connection(raw.lineItems, 100, 'LineItem'),
    shipping = connection(raw.shippingLines, 20, 'ShippingLine');
  ensure(!lines.has_more && !shipping.has_more, 422, 'Nie pobrano wszystkich pozycji Shopify');
  const blockers: string[] = [];
  if (raw.edited !== false || raw.cancelledAt !== null)
    blockers.push('Edytowane lub anulowane zamówienie Shopify wymaga uzgodnienia');
  if (raw.displayFulfillmentStatus !== 'UNFULFILLED')
    blockers.push('Zamówienie Shopify zostało już częściowo lub całkowicie zrealizowane');
  ensure(Array.isArray(raw.refunds), 422, 'Brak informacji o refundacjach Shopify');
  if (raw.refunds.length || amount(raw.totalRefundedSet, currency) > 0)
    blockers.push('Refundacja Shopify wymaga uzgodnienia');
  const total = amount(raw.totalPriceSet, currency),
    paidAmount = amount(raw.totalReceivedSet, currency);
  if (amount(raw.currentTotalPriceSet, currency) !== total)
    blockers.push('Zmiana kwoty zamówienia Shopify wymaga uzgodnienia');
  for (const key of [
    'currentTotalAdditionalFeesSet',
    'currentTotalDutiesSet',
    'totalTipReceivedSet',
  ])
    if (amount(raw[key], currency, key !== 'totalTipReceivedSet') > 0)
      blockers.push('Dopłaty, cła lub napiwki Shopify wymagają osobnego rozliczenia');
  // Cash rounding can be signed. Any non-zero adjustment is outside this ledger contract.
  for (const key of ['paymentSet', 'refundSet']) {
    const m = raw.totalCashRoundingAdjustment?.[key]?.presentmentMoney;
    ensure(
      m?.currencyCode === currency &&
        typeof m.amount === 'string' &&
        /^-?\d+(\.\d{1,2})?$/.test(m.amount),
      422,
      'Brak informacji o zaokrągleniach Shopify',
    );
    if (!/^-?0+(\.0{1,2})?$/.test(m.amount))
      blockers.push('Zaokrąglenie gotówkowe Shopify wymaga uzgodnienia');
  }
  const status = raw.displayFinancialStatus;
  if (
    !['PAID', 'PARTIALLY_PAID', 'PENDING', 'AUTHORIZED'].includes(status) ||
    paidAmount > total ||
    (status === 'PAID' && paidAmount !== total) ||
    (['PENDING', 'AUTHORIZED'].includes(status) && paidAmount !== 0) ||
    (status === 'PARTIALLY_PAID' && !(paidAmount > 0 && paidAmount < total))
  )
    blockers.push('Niezgodny lub nieobsługiwany stan płatności Shopify');
  let tax = 0;
  const remoteLineIds = new Set<string>();
  const items = lines.data.map((l: any) => {
    shopifyId(l.id, 'LineItem');
    ensure(!remoteLineIds.has(l.id), 422, 'Powtórzone ID pozycji Shopify');
    remoteLineIds.add(l.id);
    ensure(
      Number.isInteger(l.quantity) && l.quantity > 0 && l.quantity <= 100000,
      422,
      'Nieprawidłowa ilość Shopify',
    );
    ensure(l.variant, 422, 'Usunięty wariant lub niestandardowa pozycja Shopify wymaga mapowania');
    if (l.currentQuantity !== l.quantity || l.unfulfilledQuantity !== l.quantity)
      blockers.push('Zmiana ilości lub częściowa realizacja pozycji Shopify');
    ensure(
      typeof l.requiresShipping === 'boolean' &&
        typeof l.isGiftCard === 'boolean' &&
        Array.isArray(l.duties) &&
        Array.isArray(l.customAttributes),
      422,
      'Niepełne parametry pozycji Shopify',
    );
    if (
      !l.requiresShipping ||
      l.isGiftCard ||
      l.sellingPlan ||
      l.duties.length ||
      l.customAttributes.length
    )
      blockers.push(
        'Cyfrowa, subskrypcyjna lub personalizowana pozycja Shopify wymaga osobnego procesu',
      );
    ensure(
      Array.isArray(l.discountAllocations) && Array.isArray(l.taxLines),
      422,
      'Brak alokacji rabatów lub podatków Shopify',
    );
    const discount = l.discountAllocations.reduce(
      (s: number, d: any) => s + amount(d.allocatedAmountSet, currency),
      0,
    );
    const lineTax = l.taxLines.reduce((s: number, t: any) => s + amount(t.priceSet, currency), 0);
    tax += lineTax;
    const original = amount(l.originalTotalSet, currency);
    ensure(discount <= original, 422, 'Rabat Shopify przekracza wartość pozycji');
    return {
      remote_line_id: l.id,
      external_id: shopifyId(l.variant.id, 'ProductVariant'),
      name: l.name,
      sku: l.sku ?? '',
      quantity: l.quantity,
      line_total: original - discount + (raw.taxesIncluded ? 0 : lineTax),
    };
  });
  let shippingCost = 0;
  for (const s of shipping.data) {
    ensure(
      typeof s.isRemoved === 'boolean' && Array.isArray(s.taxLines),
      422,
      'Niepełna dostawa Shopify',
    );
    if (s.isRemoved) blockers.push('Usunięta dostawa Shopify wymaga uzgodnienia');
    const original = amount(s.originalPriceSet, currency),
      discounted = amount(s.discountedPriceSet, currency);
    ensure(discounted <= original, 422, 'Niezgodny rabat dostawy Shopify');
    const shippingTax = s.taxLines.reduce(
      (sum: number, t: any) => sum + amount(t.priceSet, currency),
      0,
    );
    tax += shippingTax;
    shippingCost += discounted + (raw.taxesIncluded ? 0 : shippingTax);
  }
  ensure(tax === amount(raw.totalTaxSet, currency), 422, 'Suma podatków Shopify jest niezgodna');
  ensure(
    items.reduce((sum: number, i: any) => sum + i.line_total, shippingCost) === total,
    422,
    'Suma pozycji i dostaw Shopify jest niezgodna',
  );
  const a = raw.shippingAddress;
  return {
    external_id: id,
    currency,
    customer_name: [a?.firstName, a?.lastName].filter(Boolean).join(' ') || a?.company,
    email: raw.email,
    address: {
      street: [a?.address1, a?.address2].filter(Boolean).join(' '),
      city: a?.city,
      postal_code: a?.zip,
      country: a?.countryCodeV2,
      phone: a?.phone ?? '',
    },
    shipping_cost: shippingCost,
    total,
    paid: status === 'PAID' && paidAmount === total,
    paid_amount: paidAmount,
    payment_mode: 'prepaid',
    source_status: `${status}/${raw.displayFulfillmentStatus}`,
    note: raw.note ?? '',
    items,
    blockers,
  };
}

export function validateShopifyPublication(p: any) {
  shopifyId(p?.id, 'Publication');
  ensure(
    typeof p.autoPublish === 'boolean' && typeof p.supportsFuturePublishing === 'boolean',
    502,
    'Niepełne dane publikacji Shopify',
  );
  if (p.catalog !== null) {
    ensure(
      ['AppCatalog', 'MarketCatalog', 'CompanyLocationCatalog'].includes(p.catalog?.__typename),
      502,
      'Nieznany katalog publikacji Shopify',
    );
    shopifyId(p.catalog.id, p.catalog.__typename);
    ensure(
      typeof p.catalog.title === 'string' &&
        p.catalog.title.length > 0 &&
        p.catalog.title.length <= 1024 &&
        ['ACTIVE', 'DRAFT', 'ARCHIVED'].includes(p.catalog.status),
      502,
      'Niepełne dane katalogu publikacji Shopify',
    );
  }
  return p;
}
export const demoShopifyPublication = {
  id: 'gid://shopify/Publication/1',
  autoPublish: false,
  supportsFuturePublishing: true,
  catalog: {
    __typename: 'AppCatalog',
    id: 'gid://shopify/AppCatalog/1',
    title: 'Sklep demonstracyjny Shopify',
    status: 'ACTIVE',
  },
};
