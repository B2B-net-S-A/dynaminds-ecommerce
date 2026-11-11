import type {LocalWooStockContext} from './local-woo-stock-context';
import { shopifyAccountPolicy } from './shopify-oauth';
import { shopifyCredentialIdentity } from './shopify-auth-input';
import { amazonAccountPolicy } from './amazon-account';
import { Amazon } from './amazon';
import { amazonSku } from './amazon-catalog';
import {
  amazonOfferIdentity,
  requireAmazonWrite,
  readAmazonOffer,
  amazonOfferPayload,
  amazonOfferMatches,
  simulationAmazonOffer,
} from './amazon-offers';
import { processAmazonOfferJob, deferAmazonOfferWait } from './amazon-offer-job';
import { deferAmazonApiJob } from './amazon-api-limits';
import {
  deferEbayApiJob,
  reserveEbaySimulation,
  releaseEbayApi,
  type EbayApiPermit,
} from './ebay-api-limits';
import {
  ebayCreationInput,
  ebayDraftPayload,
  readEbayDraftState,
  ebayDraftPreflight,
  ebayCreatedMatches,
  ebayOwnedInventory,
  executeEbayCreation,
  simulationEbayCreation,
} from './ebay-creation';
import {
  requireEbayPublication,
  readEbayPublication,
  ebayPublicationReadiness,
  ebayPublicationMatches,
  simulationEbayPublication,
  executeEbayPublication,
} from './ebay-publication';
import { Ebay, requireEbayWrite, ebayConnectionHash } from './ebay';
import { ebaySku } from './ebay-inventory';
import {
  EbayRevisionWait,
  ebayRevisionListings,
  ebayRevisionScope,
  reserveEbayRevisions,
} from './ebay-revision-budget';
import { requireEbaySellerSettings } from './ebay-seller-access';
import {
  readEbayDraftRequirements,
  demoEbayRequirements,
  validateEbayAspects,
} from './ebay-seller-settings';
import {
  ebayOfferId,
  readEbayOffer,
  ebaySnapshot,
  ebayPayload,
  ebayMatches,
  ebayExpected,
  ebayAffectedOffers,
  executeEbaySync,
  simulationEbayOffer,
} from './ebay-offers';
import { randomUUID, createHash } from 'node:crypto';
import pg, { type PoolClient } from 'pg';
import { holdingDbLock, lockDbClient } from './db-lock-holder';
import { z } from 'zod';
import { pool, tenantTx } from './db';
import { audit, type Actor } from './domain';
import { ensure, Problem } from './errors';
import { Allegro, WooCommerce, PrestaShop, safeFetch } from './integrations';
import {
  psOfferId,
  psMoney,
  psDesiredPrice,
  readPrestaOffer,
  prestaSnapshot,
  prestaMatches,
  prestaExpected,
} from './prestashop-offers';
import { Shopify, shopifyId } from './shopify';
import {
  readShopifyOffer,
  shopifyDesiredPrice,
  shopifySnapshot,
  shopifyMatches,
  shopifyExpected,
  simulationShopifyOffer,
} from './shopify-offers';
import { psMicros } from './prestashop-orders';
import {
  loadChannel,
  channelRead,
  withAllegroJobContext,
  offerWriteScope,
  type IntegrationContext,
} from './channel-access';
import { productDetail } from './catalog';
import { warehouseInventoryPoliciesAvailable, lockWarehouseInventoryPoliciesInTx } from './warehouse-inventory-policies';
import { systemActor } from './sync';
import { prices } from './pricing';
import {
  offerConnectionHash as connectionHash,
  requireSyncPolicy,
  syncPolicy,
} from './offer-sync-policy';
import {
  allegroCreationInput,
  allegroCreationContext,
  allegroDraftPayload,
  allegroCreatedMatches,
  allegroSettingsReadScope,
} from './allegro-creation';
import {
  creation,
  groupDefinition,
  variantParent,
  validateParent,
  parentSnapshot,
  attributesMatch,
} from './variable-offers';
export const offerInput = z.object({
  product_id: z.uuid(),
  ebay_offer_id: ebayOfferId.optional(),
  ebay_creation: ebayCreationInput.optional(),
  warehouse_id: z.uuid(),
  listing_id: z.uuid().optional(),
  price_list_id: z.uuid().optional(),
  publication_id: z
    .string()
    .regex(/^gid:\/\/shopify\/Publication\/[1-9]\d{0,19}$/)
    .optional(),
  operation: z.enum(['create_draft', 'create_group', 'create_variant', 'publish', 'sync']),
  parent_external_id: z
    .string()
    .regex(/^(?:[1-9]\d{0,14}|DEMO-[a-f0-9-]{36})$/)
    .optional(),
  variation_axes: z.array(z.string().trim().min(1).max(80)).min(1).max(50).optional(),
  stock: z.boolean().default(true),
  price: z.boolean().default(true),
  allegro: allegroCreationInput.optional(),
});
type Input = z.infer<typeof offerInput>;
function canonical(v: any): any {
  if (Array.isArray(v)) return v.map(canonical);
  if (v instanceof Date) return v.toISOString();
  if (v && typeof v === 'object')
    return Object.fromEntries(
      Object.keys(v)
        .sort()
        .map((k) => [k, canonical(v[k])]),
    );
  return v;
}
const hash = (v: unknown) =>
  createHash('sha256')
    .update(JSON.stringify(canonical(v)))
    .digest('hex');
const decimal = (n: number) => (n / 100).toFixed(2);
const escape = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
async function local(c: PoolClient, actor: Actor, b: Input, allowUnavailablePricing = false) {
  await c.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))', [
    'catalog:' + actor.tenantId,
  ]);
  const policiesAvailable = await warehouseInventoryPoliciesAvailable(c);
  const [warehousePolicy] = await lockWarehouseInventoryPoliciesInTx(c, [b.warehouse_id]);
  ensure(
    (await c.query('SELECT id FROM warehouses WHERE id=$1', [b.warehouse_id])).rowCount,
    404,
    'Nie znaleziono magazynu',
  );
  const p = await productDetail(c, b.product_id);
  ensure(
    p.kind !== 'group' ||
      (['create_group', 'publish'].includes(b.operation) && !b.stock && !b.price),
    422,
    'Grupa wymaga osobnej operacji bez ceny i stanu',
  );
  ensure(b.operation !== 'create_group' || p.kind === 'group', 422, 'Wybierz grupę wariantów');
  ensure(
    b.operation !== 'create_variant' || (p.kind === 'variant' && b.parent_external_id),
    422,
    'Wybierz wariant i identyfikator rodzica',
  );
  ensure(
    !b.variation_axes || b.operation === 'create_group',
    422,
    'Parametry wariantowe dotyczą tworzenia grupy',
  );
  const definition =
    b.operation === 'create_group'
      ? await groupDefinition(c, p, b.variation_axes ?? [])
      : undefined;
  const parent = b.operation === 'create_variant' ? await variantParent(c, p) : undefined;
  const ids = p.kind === 'bundle' ? p.components.map((l: any) => l.product_id) : [p.id];
  const components = (
    await c.query('SELECT id,version,active FROM products WHERE id=ANY($1::uuid[]) ORDER BY id', [
      ids,
    ])
  ).rows;
  const stocks = (
    await c.query(
      'SELECT product_id,on_hand,reserved,version FROM stock WHERE warehouse_id=$1 AND product_id=ANY($2::uuid[]) ORDER BY product_id',
      [b.warehouse_id, ids],
    )
  ).rows;
  let quantity = 0;
  if (warehousePolicy.usage === 'sale' && warehousePolicy.enabled && p.active && components.every((x) => x.active))
    quantity =
      p.kind === 'bundle'
        ? Math.min(
            ...p.components.map((l: any) => {
              const s = stocks.find((s) => s.product_id === l.product_id);
              return Math.floor(((s?.on_hand ?? 0) - (s?.reserved ?? 0)) / l.quantity);
            }),
          )
        : (stocks[0]?.on_hand ?? 0) - (stocks[0]?.reserved ?? 0);
  let pricing;
  let pricingUnavailable = false;
  try {
    pricing = b.price ? await prices(c, [p.id], b.price_list_id, actor.tenantId) : null;
  } catch (e) {
    if (!allowUnavailablePricing || !(e instanceof Problem) || ![409, 422].includes(e.status))
      throw e;
    pricingUnavailable = true;
  }
  if (pricing) p.price = pricing.items[0].price;
  return {
    p,
    quantity,
    snapshot: {
      ...(definition ? { definition } : {}),
      ...(parent ? { parent } : {}),
      ...(pricing?.list ? { pricing } : {}),
      ...(pricingUnavailable ? { pricing_unavailable: true } : {}),
      currency:
        pricing?.currency ??
        (await c.query('SELECT currency FROM tenants WHERE id=$1', [actor.tenantId])).rows[0]
          .currency,
      price: p.price,
      vat: p.vat,
      version: p.version,
      components,
      stocks,
      warehouse_id: b.warehouse_id,
      ...(policiesAvailable ? { warehouse_inventory_policy: warehousePolicy } : {}),
    },
  };
}
async function mapping(c: PoolClient, b: Input, ch: any) {
  if (!b.listing_id) return null;
  const l = (await c.query('SELECT * FROM listings WHERE id=$1', [b.listing_id])).rows[0];
  ensure(
    l && l.channel_id === ch.id && l.product_id === b.product_id,
    404,
    'Nie znaleziono powiązanej oferty',
  );
  ensure(l.external_id, 422, 'Brak identyfikatora zewnętrznej oferty');
  return l;
}
function remoteSnapshot(provider: string, r: any, settings?: any): any {
  if (provider === 'amazon') return r;
  if (provider === 'ebay') return ebaySnapshot(r);
  if (provider === 'prestashop') return prestaSnapshot(r);
  if (provider === 'shopify') return shopifySnapshot(r);
  return provider === 'woocommerce'
    ? {
        id: String(r.id),
        sku: r.sku,
        type: r.type ?? null,
        parent_id: r.parent_id ?? 0,
        ...(r.type === 'variable' ? { attributes: r.attributes ?? [] } : {}),
        ...(r._parent ? { parent_signature: parentSnapshot(r._parent) } : {}),
        regular_price: r.regular_price,
        sale_price: r.sale_price ?? '',
        stock_quantity: r.stock_quantity,
        manage_stock: r.manage_stock,
        backorders: r.backorders ?? 'no',
        status: r.status,
        currency: settings?.currency,
        prices_include_tax: settings?.prices_include_tax,
      }
    : {
        id: String(r.id),
        ...(r.external?.id?.startsWith('dyna-')
          ? {
              external: r.external,
              name: r.name,
              productSet: r.productSet,
              parameters: r.parameters,
              delivery: r.delivery,
              afterSalesServices: r.afterSalesServices,
            }
          : {}),
        price: r.sellingMode?.price,
        price_automation: r.sellingMode?.priceAutomation ?? null,
        stock: r.stock,
        publication: r.publication?.status,
      };
}
async function wooSettings(client: WooCommerce) {
  const currency = await client.setting('general', 'woocommerce_currency'),
    tax = await client.setting('tax', 'woocommerce_prices_include_tax');
  ensure(
    typeof currency?.value === 'string' && ['yes', 'no'].includes(tax?.value),
    502,
    'Nie można ustalić waluty lub sposobu wprowadzania cen sklepu',
  );
  return { currency: currency.value, prices_include_tax: tax.value };
}
function simulationResource(ch: any, l: any, ebayInactive = false) {
  if (!l) return null;
  if (ch.provider === 'ebay') return simulationEbayOffer(ch, l, undefined, ebayInactive);
  if (ch.provider === 'shopify') return simulationShopifyOffer(ch, l);
  if (ch.provider === 'prestashop') {
    const parts = psOfferId(l.external_id),
      price = l.last_result?.regular_price ?? decimal(l.price);
    return {
      id: l.external_id,
      sku: l.last_result?.sku ?? '',
      product_id: parts.product,
      combination_id: parts.combination,
      product_price:
        l.last_result?.product_price ?? (parts.combination === '0' ? price : '0.000000'),
      regular_price: price,
      tax_rules_group: 'demo',
      stock_id: '1',
      stock_shop: ch.settings.shop_id ?? '1',
      stock_group: '0',
      stock_quantity: l.last_result?.stock_quantity ?? 0,
      out_of_stock: 0,
      depends_on_stock: 0,
      status: l.last_result?.status ?? 'active',
      currency: ch.settings.currency ?? 'PLN',
      specific_prices: false,
    };
  }
  return ch.provider === 'woocommerce'
    ? {
        id: l.external_id,
        sku: l.last_result?.sku ?? null,
        type: l.last_result?.type ?? (l.parent_external_id ? 'variation' : 'simple'),
        attributes: l.last_result?.attributes ?? [],
        ...(l.parent_external_id ? { parent_id: l.parent_external_id } : {}),
        regular_price: decimal(l.price),
        sale_price: '',
        stock_quantity: l.last_result?.stock_quantity ?? 0,
        manage_stock: true,
        backorders: 'no',
        status: l.last_result?.status ?? 'draft',
      }
    : {
        ...(l.last_result?.allegro_creation_snapshot ?? {}),
        id: l.external_id,
        sellingMode: { price: { amount: decimal(l.price), currency: l.price_currency ?? 'PLN' } },
        stock: { available: l.last_result?.stock_quantity ?? 0, unit: 'UNIT' },
        publication: { status: l.last_result?.status ?? 'INACTIVE' },
      };
}
async function simulationShopifyPublication(actor: Actor, ch: any, l: any, b: any) {
  const r = simulationShopifyOffer(ch, l, b.price, b.stock, b.publication_id);
  if (b.publication_id) {
    ensure(
      b.publication_id === 'gid://shopify/Publication/1',
      422,
      'Nieznana publikacja demonstracyjna',
    );
    r.variants_count = await tenantTx(actor.tenantId, async (c) =>
      Number(
        (
          await c.query(
            "SELECT count(*) FROM listings WHERE channel_id=$1 AND coalesce(last_result->>'product_id','gid://shopify/Product/702')=$2",
            [ch.id, r.product_id],
          )
        ).rows[0].count,
      ),
    );
  }
  if (b.publication_id)
    r.product_title = await tenantTx(
      actor.tenantId,
      async (c) =>
        (
          await c.query(
            'SELECT coalesce(parent.name,p.name) title FROM products p LEFT JOIN products parent ON parent.id=p.parent_id WHERE p.id=$1',
            [l.product_id],
          )
        ).rows[0]?.title ?? r.product_title,
    );
  return r;
}
async function remote(actor: Actor, ch: any, b: Input, l: any, ctx: IntegrationContext) {
  if (ch.settings.simulation && !l)
    ensure(
      !(
        await tenantTx(actor.tenantId, (c) =>
          c.query('SELECT 1 FROM listings WHERE channel_id=$1 AND product_id=$2', [
            ch.id,
            b.product_id,
          ]),
        )
      ).rowCount,
      409,
      'Produkt ma już ofertę w przykładzie lokalnym. Wybierz powiązaną ofertę',
    );
  const amazonFence = async () => {
    if (ch.provider !== 'amazon') return;
    await tenantTx(actor.tenantId, async (c) => {
      const current = (await c.query('SELECT * FROM channels WHERE id=$1', [ch.id])).rows[0];
      if (current?.provider === 'amazon') await amazonAccountPolicy(c, current);
      ensure(
        current && amazonOfferIdentity(current) === amazonOfferIdentity(ch),
        409,
        'Połączenie Amazon zmieniło się podczas podglądu',
      );
      ensure(
        (await c.query('SELECT offer_sync_is_admin($1) authorized', [actor.userId])).rows[0]
          .authorized,
        403,
        'Autor utracił rolę administratora',
      );
      ensure(
        hash(await mapping(c, b, ch)) === hash(l),
        409,
        'Powiązanie Amazon zmieniło się podczas podglądu',
      );
    });
  };
  if (ch.provider === 'amazon' && ch.settings.simulation) {
    ensure(l, 422, 'Wybierz istniejącą ofertę Amazon');
    const resource = simulationAmazonOffer(ch, l);
    return { resource, settings: { currency: resource.currency, prices_include_tax: 'yes' } };
  }
  const ebayFence = async () => {
    if (ch.provider !== 'ebay') return;
    await tenantTx(actor.tenantId, async (c) => {
      const current = (await c.query('SELECT * FROM channels WHERE id=$1', [ch.id])).rows[0];
      ensure(
        current && ebayConnectionHash(current) === ebayConnectionHash(ch),
        409,
        'Połączenie eBay zmieniło się podczas podglądu',
      );
      ensure(
        (await c.query('SELECT offer_sync_is_admin($1) authorized', [actor.userId])).rows[0]
          .authorized,
        403,
        'Autor utracił rolę administratora',
      );
      if (['publish', 'create_draft'].includes(b.operation))
        await requireEbayPublication(c, current, undefined, true, false);
      ensure(
        hash(await mapping(c, b, ch)) === hash(l),
        409,
        'Powiązanie eBay zmieniło się podczas podglądu',
      );
    });
  };
  let parent: any;
  if (b.operation === 'create_variant' && ch.settings.simulation) {
    const localGroup = await tenantTx(actor.tenantId, async (c) =>
      variantParent(c, await productDetail(c, b.product_id)),
    );
    const linkedParent = await tenantTx(
      actor.tenantId,
      async (c) =>
        (
          await c.query(
            'SELECT * FROM listings WHERE channel_id=$1 AND product_id=$2 AND external_id=$3',
            [ch.id, localGroup.id, b.parent_external_id],
          )
        ).rows[0],
    );
    ensure(linkedParent, 422, 'Najpierw utwórz szkic grupy w tym kanale');
    parent = simulationResource(ch, linkedParent);
  }
  if (ch.provider === 'ebay' && b.ebay_creation) {
    const cfg = b.ebay_creation;
    const prior = cfg.reuse_inventory_plan_id
      ? await tenantTx(
          actor.tenantId,
          async (c) =>
            (
              await c.query(
                'SELECT * FROM offer_plans WHERE id=$1 AND channel_id=$2 AND product_id=$3',
                [cfg.reuse_inventory_plan_id, ch.id, b.product_id],
              )
            ).rows[0],
        )
      : undefined;
    let state: any, requirements: any;
    if (cfg.verify_settings) requireEbaySellerSettings(ch);
    if (ch.settings.simulation) {
      const linked = await tenantTx(actor.tenantId, (c) =>
        c.query('SELECT id FROM listings WHERE channel_id=$1 AND external_id=$2', [ch.id, cfg.sku]),
      );
      ensure(!linked.rowCount, 409, 'SKU ma już powiązanie eBay');
      state = {
        inventory: prior?.result?.actual_snapshot?.inventory ?? null,
        offers: [],
        location: {
          merchantLocationKey: cfg.merchant_location_key,
          merchantLocationStatus: 'ENABLED',
          location: { address: { country: 'PL', postalCode: '00-001' } },
        },
      };
      if (cfg.verify_settings) requirements = demoEbayRequirements(cfg, ch.settings.marketplace_id);
    } else
      state = await channelRead(
        actor.tenantId,
        ch.id,
        async (client) => {
          ensure(client instanceof Ebay, 422, 'Wymagany kanał eBay');
          const result = await readEbayDraftState(
            client,
            cfg.sku,
            cfg.merchant_location_key,
            ebayFence,
          );
          if (cfg.verify_settings)
            requirements = await readEbayDraftRequirements(
              client,
              cfg,
              ch.settings.marketplace_id,
              ebayFence,
            );
          return result;
        },
        ctx,
        true,
        async () => ebayFence(),
      );
    ebayDraftPreflight(state, prior);
    return {
      resource: null,
      settings: {
        currency: null,
        prices_include_tax: ch.settings.price_mode === 'net' ? 'no' : 'yes',
        ebay_creation_context: state,
        ...(requirements ? { ebay_seller_requirements: requirements } : {}),
      },
    };
  }
  if (ch.settings.simulation)
    return {
      parent,
      resource:
        ch.provider === 'shopify'
          ? await simulationShopifyPublication(actor, ch, l, b)
          : ch.provider === 'ebay'
            ? simulationEbayOffer(
                ch,
                l,
                b.ebay_offer_id ?? l.last_result?.ebay_offer_snapshot?.offer_id,
                b.operation === 'publish',
              )
            : simulationResource(ch, l),
      settings: {
        currency:
          ch.provider === 'ebay'
            ? simulationEbayOffer(
                ch,
                l,
                b.ebay_offer_id ?? l.last_result?.ebay_offer_snapshot?.offer_id,
                b.operation === 'publish',
              ).currency
            : (ch.settings.currency ?? 'PLN'),
        prices_include_tax:
          ch.provider === 'ebay' && ch.settings.price_mode === 'net' ? 'no' : 'yes',
        ...(b.allegro
          ? {
              allegro_creation: {
                product: { id: b.allegro.product_id },
                selected: [],
                definitions: [],
              },
            }
          : {}),
      },
    };
  return channelRead(
    actor.tenantId,
    ch.id,
    async (client) => {
      if (client instanceof Amazon && l) {
        const resource = await readAmazonOffer(client, l.external_id, b.stock, amazonFence);
        return { resource, settings: { currency: resource.currency, prices_include_tax: 'yes' } };
      }
      if (client instanceof Ebay && l) {
        const resource =
          b.operation === 'publish'
            ? await readEbayPublication(
                client,
                l.external_id,
                ch.settings.marketplace_id,
                b.ebay_offer_id!,
                ebayFence,
              )
            : await readEbayOffer(
                client,
                l.external_id,
                ch.settings.marketplace_id,
                b.ebay_offer_id ?? l.last_result?.ebay_offer_snapshot?.offer_id,
                ebayFence,
              );
        return {
          resource,
          settings: {
            currency: resource.currency,
            prices_include_tax: ch.settings.price_mode === 'net' ? 'no' : 'yes',
          },
        };
      }
      if (client instanceof WooCommerce) {
        const settings = b.price || b.operation !== 'sync' ? await wooSettings(client) : undefined;
        if (l)
          return { resource: await client.product(l.external_id, b.parent_external_id), settings };
        const product = await tenantTx(actor.tenantId, (c) => productDetail(c, b.product_id));
        const parent =
          b.operation === 'create_variant'
            ? await client.product(b.parent_external_id!)
            : undefined;
        const same =
          b.operation === 'create_variant'
            ? await client.variationBySku(b.parent_external_id!, product.sku)
            : await client.bySku(product.sku);
        ensure(
          Array.isArray(same) && same.length === 0,
          409,
          'Produkt o tym SKU już istnieje w sklepie. Najpierw powiąż istniejącą ofertę',
        );
        return { resource: null, settings, parent };
      }
      if (client instanceof Shopify && l) {
        const resource = await readShopifyOffer(
          client,
          l.external_id,
          b.price,
          b.stock,
          ch.settings.inventory_location_id,
          true,
          b.publication_id,
        );
        return {
          resource,
          settings: {
            currency: resource.currency,
            prices_include_tax: resource.prices_include_tax,
          },
        };
      }
      if (client instanceof PrestaShop && l)
        return {
          resource: await readPrestaOffer(client, l.external_id, b.price, b.stock),
          settings: undefined,
        };
      if (client instanceof Allegro && b.allegro)
        return {
          resource: null,
          settings: {
            currency: 'PLN',
            allegro_creation: await allegroCreationContext(client, b.allegro),
          },
        };
      ensure(
        client instanceof Allegro && l,
        422,
        'Tworzenie nowych ofert Allegro wymaga danych katalogowych i warunków sprzedawcy; wybierz istniejącą ofertę',
      );
      return { resource: await client.offer(l.external_id), settings: undefined };
    },
    ctx,
    true,
    ch.provider === 'amazon'
      ? async () => amazonFence()
      : ch.provider === 'ebay'
        ? async () => ebayFence()
        : undefined,
  );
}
export async function previewOffer(
  actor: Actor,
  chId: string,
  b: Input,
  ctx: IntegrationContext = {},
  automatic?: { version: number; job_id: string; lease_token: string },
) {
  ensure(b.price || !b.price_list_id, 422, 'Cennik dotyczy synchronizacji ceny');
  const ch = await loadChannel(actor.tenantId, chId);
  if (ch.provider === 'amazon') await tenantTx(actor.tenantId, (c) => amazonAccountPolicy(c, ch));
  ensure(
    ['woocommerce', 'allegro', 'prestashop', 'shopify', 'ebay', 'amazon'].includes(ch.provider),
    422,
    'Wymagany kanał sprzedaży',
  );
  if (ch.provider === 'amazon')
    ensure(
      b.operation === 'sync' && !b.parent_external_id,
      422,
      'Amazon obsługuje zmianę ceny i dostępności istniejącego SKU',
    );
  if (ch.provider === 'ebay')
    ensure(
      ['sync', 'publish', 'create_draft'].includes(b.operation) && !b.parent_external_id,
      422,
      'eBay obsługuje szkic pojedynczego SKU, synchronizację i publikację Inventory',
    );
  if (ch.provider === 'ebay' && b.operation === 'publish') {
    ensure(
      b.ebay_offer_id && !b.stock && !b.price,
      422,
      'Publikacja eBay wymaga ID szkicu, bez synchronizacji ceny i stanu',
    );
  }
  ensure(
    !b.ebay_creation ||
      (ch.provider === 'ebay' &&
        b.operation === 'create_draft' &&
        b.stock &&
        b.price &&
        !b.ebay_offer_id),
    422,
    'Dane nowego szkicu eBay wymagają tworzenia, ceny i stanu, bez istniejącego ID oferty',
  );
  ensure(
    ch.provider !== 'ebay' || b.operation !== 'create_draft' || b.ebay_creation,
    422,
    'Uzupełnij dane tworzenia szkicu eBay',
  );
  ensure(
    !b.ebay_offer_id || ch.provider === 'ebay',
    422,
    'ID oferty eBay dotyczy wyłącznie kanału eBay',
  );
  if (ch.provider === 'shopify') {
    ensure(
      ['sync', 'publish'].includes(b.operation) && !b.parent_external_id,
      422,
      'Shopify obsługuje istniejący wariant i publikację jego produktu',
    );
    ensure(b.operation !== 'publish' || b.publication_id, 422, 'Wybierz publikację Shopify');
    if (b.stock) shopifyId(ch.settings.inventory_location_id, 'Location');
  }
  ensure(
    !b.publication_id || (ch.provider === 'shopify' && b.operation === 'publish'),
    422,
    'Publikacja dotyczy wyłącznie publikowania produktu Shopify',
  );
  if (ch.provider === 'prestashop')
    ensure(
      b.operation === 'sync' && !b.parent_external_id,
      422,
      'PrestaShop synchronizuje istniejące ID produktu:kombinacji',
    );
  ensure(
    !creation(b.operation) ||
      (!b.listing_id &&
        (ch.provider === 'woocommerce' ||
          (ch.provider === 'allegro' && b.operation === 'create_draft' && b.allegro) ||
          (ch.provider === 'ebay' && b.operation === 'create_draft' && b.ebay_creation))),
    422,
    'Nowy szkic wymaga WooCommerce, danych Allegro albo danych Inventory eBay, bez powiązania',
  );
  ensure(
    !b.allegro ||
      (ch.provider === 'allegro' && b.operation === 'create_draft' && b.stock && b.price),
    422,
    'Dane nowej oferty Allegro wymagają szkicu, ceny i stanu',
  );
  if (ch.provider === 'allegro' && b.allegro && !ch.settings.simulation)
    ensure(
      ch.oauth_scopes.split(' ').includes(allegroSettingsReadScope),
      422,
      'Połącz Allegro ponownie z odczytem ustawień sprzedawcy',
    );
  ensure(creation(b.operation) || b.listing_id, 422, 'Wybierz powiązaną ofertę');
  ensure(
    b.operation !== 'sync' || b.stock || b.price,
    422,
    'Wybierz synchronizację ceny lub stanu',
  );
  const initial = await tenantTx(actor.tenantId, async (c) => ({
    local: await local(c, actor, b),
    listing: await mapping(c, b, ch),
    tenant: (await c.query('SELECT currency FROM tenants WHERE id=$1', [actor.tenantId])).rows[0],
    ebay_account_hash:
      ch.provider === 'ebay' &&
      (b.operation !== 'sync' ||
        ch.settings.simulation ||
        ch.settings.inventory_access === 'orders_inventory_write')
        ? await requireEbayPublication(c, ch, undefined, true, false)
        : undefined,
  }));
  if (b.ebay_creation?.reuse_inventory_plan_id) {
    const prior = await tenantTx(
      actor.tenantId,
      async (c) =>
        (
          await c.query(
            'SELECT * FROM offer_plans WHERE id=$1 AND channel_id=$2 AND product_id=$3',
            [b.ebay_creation!.reuse_inventory_plan_id, ch.id, b.product_id],
          )
        ).rows[0],
    );
    ensure(
      prior && prior.payload?.sku === b.ebay_creation.sku,
      404,
      'Nie znaleziono zachowanego Inventory tego produktu i kanału',
    );
  }
  const { p, quantity, snapshot } = initial.local,
    l = initial.listing;
  if (l && !ch.settings.simulation)
    ensure(
      ch.provider === 'amazon'
        ? amazonSku.safeParse(l.external_id).success
        : ch.provider === 'ebay'
          ? ebaySku.safeParse(l.external_id).success
          : ch.provider === 'prestashop'
            ? Boolean(psOfferId(l.external_id))
            : ch.provider === 'shopify'
              ? Boolean(shopifyId(l.external_id, 'ProductVariant'))
              : /^[1-9]\d{0,18}$/.test(l.external_id),
      422,
      'Identyfikator oferty musi być liczbą dodatnią',
    );
  if (b.parent_external_id && !ch.settings.simulation)
    ensure(
      /^[1-9]\d{0,14}$/.test(b.parent_external_id),
      422,
      'Identyfikator rodzica musi być liczbą dodatnią',
    );
  if (ch.provider === 'allegro')
    ensure(!b.parent_external_id, 422, 'Allegro nie korzysta z identyfikatora rodzica WooCommerce');
  if (ch.provider === 'woocommerce' && b.operation === 'create_draft')
    ensure(
      ['simple', 'bundle'].includes(p.kind),
      422,
      'Nowy wariant wymaga utworzenia grupy i konfiguracji rodzica w WooCommerce',
    );
  const r: any = await remote(actor, ch, b, l, ctx),
    settings = r.settings;
  if (b.operation === 'create_variant')
    ensure(String(r.parent?.id) === b.parent_external_id, 502, 'Dostawca zwrócił inną grupę');
  const variantAttributes =
    b.operation === 'create_variant'
      ? validateParent(r.parent, { ...p, sku: snapshot.parent!.sku }, p.attributes)
      : undefined;
  if (settings && b.price && !b.ebay_creation)
    ensure(
      settings.currency === snapshot.currency,
      422,
      'Waluta sklepu różni się od waluty organizacji; wybierz właściwy cennik walutowy',
    );
  if (ch.provider === 'woocommerce' && r.resource) {
    ensure(String(r.resource.id) === l.external_id, 502, 'Dostawca zwrócił inny produkt');
    ensure(
      !r.resource.sku || r.resource.sku === p.sku,
      409,
      'SKU produktu zewnętrznego różni się od lokalnego powiązania',
    );
    ensure(
      b.parent_external_id
        ? String(r.resource.parent_id) === b.parent_external_id
        : p.kind === 'group'
          ? r.resource.type === 'variable'
          : r.resource.type === 'simple',
      422,
      'Produkt zmienny wymaga identyfikatora rodzica i endpointu wariantu',
    );
    if (b.price)
      ensure(
        !r.resource.sale_price,
        409,
        'Oferta ma cenę promocyjną. Usuń lub rozlicz promocję przed synchronizacją ceny regularnej',
      );
  }
  if (ch.provider === 'allegro' && r.resource && b.price) {
    ensure(
      r.resource.sellingMode?.price?.currency === snapshot.currency,
      422,
      'Waluta oferty Allegro różni się od lokalnej; wymagany cennik walutowy',
    );
    ensure(
      !r.resource.sellingMode?.priceAutomation?.rule,
      409,
      'Oferta Allegro ma aktywną regułę cenową; nie można nadpisać jej ceną ręczną',
    );
  }
  if (ch.provider === 'prestashop') {
    ensure(
      !r.resource.sku || r.resource.sku === p.sku,
      409,
      'SKU PrestaShop różni się od lokalnego powiązania',
    );
    if (b.price) {
      ensure(
        r.resource.currency === snapshot.currency,
        422,
        'Waluta PrestaShop różni się od cennika',
      );
      ensure(
        !r.resource.specific_prices,
        409,
        'Produkt ma ceny specjalne PrestaShop; rozlicz je przed synchronizacją',
      );
    }
  }
  if (ch.provider === 'shopify') {
    ensure(
      !r.resource.sku || r.resource.sku === p.sku,
      409,
      'SKU Shopify różni się od lokalnego powiązania',
    );
    ensure(
      !b.price || r.resource.taxable || p.vat === 0,
      422,
      'Wariant Shopify bez podatku wymaga lokalnej stawki VAT 0',
    );
  }
  if (b.operation === 'publish')
    ensure(p.active, 422, 'Wyłączonego produktu nie można opublikować');
  const amount =
    settings?.prices_include_tax === 'no' ? Math.round((p.price * 100) / (100 + p.vat)) : p.price;
  const id = randomUUID();
  const payload: any =
    ch.provider === 'amazon'
      ? amazonOfferPayload(r.resource, b.stock ? quantity : undefined, b.price ? amount : undefined)
      : ch.provider === 'ebay'
        ? b.ebay_creation
          ? ebayDraftPayload(
              b.ebay_creation,
              p,
              quantity,
              snapshot.currency,
              amount,
              ch.settings.marketplace_id,
              id,
            )
          : b.operation === 'publish'
            ? { offer_id: ebayPublicationReadiness(r.resource).offer_id, publish: true }
            : ebayPayload(r.resource, b.stock ? quantity : undefined, b.price ? amount : undefined)
        : ch.provider === 'prestashop'
          ? {
              ...(b.stock ? { stock_quantity: quantity, out_of_stock: 0 } : {}),
              ...(b.price ? { regular_price: psDesiredPrice(p.price, p.vat) } : {}),
            }
          : ch.provider === 'shopify'
            ? {
                ...(b.operation === 'publish'
                  ? {
                      product_status: r.resource.status === 'UNLISTED' ? 'UNLISTED' : 'ACTIVE',
                      publication_id: b.publication_id,
                      published: true,
                    }
                  : {}),
                ...(b.stock ? { stock_quantity: quantity } : {}),
                ...(b.price
                  ? {
                      regular_price: shopifyDesiredPrice(
                        p.price,
                        p.vat,
                        r.resource.prices_include_tax === 'yes',
                      ),
                    }
                  : {}),
              }
            : ch.provider === 'woocommerce'
              ? {
                  ...(b.stock
                    ? { manage_stock: true, stock_quantity: quantity, backorders: 'no' }
                    : {}),
                  ...(b.price ? { regular_price: decimal(amount) } : {}),
                  ...(b.operation === 'publish' ? { status: 'publish' } : {}),
                }
              : {
                  ...(b.stock ? { stock: { available: quantity, unit: 'UNIT' } } : {}),
                  ...(b.price
                    ? {
                        sellingMode: {
                          price: { amount: decimal(p.price), currency: snapshot.currency },
                        },
                      }
                    : {}),
                  ...(b.operation === 'publish' ? { publication: { status: 'ACTIVE' } } : {}),
                };
  if (ch.provider === 'allegro' && b.allegro)
    Object.assign(payload, allegroDraftPayload(b.allegro, p, quantity, snapshot.currency, id));
  if (creation(b.operation) && ch.provider === 'woocommerce') {
    ensure(
      p.images.every((url: string) => url.startsWith('https://')),
      422,
      'Zdjęcia lokalne nie są dostępne dla sklepu. Przy publikacji użyj publicznych zdjęć HTTPS',
    );
    Object.assign(payload, {
      ...(b.operation !== 'create_variant'
        ? { name: p.name, type: b.operation === 'create_group' ? 'variable' : 'simple' }
        : {}),
      status: 'draft',
      sku: p.sku,
      description: escape(p.description).replace(/\n/g, '<br>'),
      ...(b.operation === 'create_variant'
        ? p.images[0]
          ? { image: { src: p.images[0] } }
          : {}
        : { images: p.images.map((src: string) => ({ src })) }),
      ...(p.ean ? { global_unique_id: p.ean } : {}),
      attributes:
        variantAttributes ??
        snapshot.definition?.attributes ??
        Object.entries(p.attributes).map(([name, value]) => ({
          name,
          visible: true,
          variation: false,
          options: [String(value)],
        })),
      meta_data: [{ key: '_dynaminds_offer_plan', value: id }],
    });
  }
  if (ch.provider === 'ebay' && b.ebay_creation?.verify_settings)
    validateEbayAspects(
      settings.ebay_seller_requirements.category,
      payload.inventory.product.aspects,
    );
  return tenantTx(actor.tenantId, async (c) => {
    if (automatic) {
      await requireSyncPolicy(c, ch.id, automatic.version, actor.userId);
      ensure(
        (
          await c.query(
            "SELECT id FROM jobs WHERE id=$1 AND lease_token=$2 AND state='running' FOR UPDATE",
            [automatic.job_id, automatic.lease_token],
          )
        ).rowCount,
        409,
        'Dzierżawa synchronizacji wygasła',
      );
    }
    if (ch.provider === 'ebay') {
      const latest = (await c.query('SELECT * FROM channels WHERE id=$1 FOR SHARE', [ch.id]))
        .rows[0];
      if (initial.ebay_account_hash)
        await requireEbayPublication(c, latest, initial.ebay_account_hash, true);
      ensure(
        latest && ebayConnectionHash(latest) === ebayConnectionHash(ch),
        409,
        'Połączenie eBay zmieniło się podczas podglądu',
      );
      ensure(
        (await c.query('SELECT offer_sync_is_admin($1) authorized', [actor.userId])).rows[0]
          .authorized,
        403,
        'Autor utracił rolę administratora',
      );
    }
    if (ch.provider === 'amazon') {
      const latest = (await c.query('SELECT * FROM channels WHERE id=$1 FOR SHARE', [ch.id]))
        .rows[0];
      await amazonAccountPolicy(c, latest);
      ensure(
        latest && amazonOfferIdentity(latest) === amazonOfferIdentity(ch),
        409,
        'Połączenie Amazon zmieniło się podczas podglądu',
      );
      ensure(
        (await c.query('SELECT offer_sync_is_admin($1) authorized', [actor.userId])).rows[0]
          .authorized,
        403,
        'Autor utracił rolę administratora',
      );
    }
    const current = await local(c, actor, b);
    ensure(
      hash(current.snapshot) === hash(snapshot),
      409,
      'Dane lokalne zmieniły się podczas podglądu. Przygotuj nowy plan',
    );
    const linked = await mapping(c, b, ch);
    ensure(hash(linked) === hash(l), 409, 'Powiązanie oferty zmieniło się podczas podglądu');
    await c.query(
      `INSERT INTO offer_plans(id,tenant_id,channel_id,product_id,listing_id,actor_id,warehouse_id,operation,input,local_snapshot,remote_snapshot,payload,remote_id,sync_version)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        id,
        actor.tenantId,
        ch.id,
        p.id,
        l?.id ?? null,
        actor.userId,
        b.warehouse_id,
        b.operation,
        JSON.stringify({
          ...b,
          sync_connection_hash: connectionHash(ch),
          ...(ch.provider === 'amazon' ? { amazon_identity_hash: amazonOfferIdentity(ch) } : {}),
          ...(initial.ebay_account_hash ? { ebay_account_hash: initial.ebay_account_hash } : {}),
          ...(ch.provider === 'shopify'
            ? { shopify_credentials_hash: hash(shopifyCredentialIdentity(ch)) }
            : {}),
        }),
        JSON.stringify(snapshot),
        r.resource
          ? JSON.stringify(remoteSnapshot(ch.provider, r.resource, settings))
          : JSON.stringify(
              r.parent
                ? { ...settings, parent_signature: parentSnapshot(r.parent) }
                : (settings ?? null),
            ),
        JSON.stringify(payload),
        l?.external_id ?? null,
        automatic?.version ?? null,
      ],
    );
    await audit(c, actor, 'offer.preview', id, { provider: ch.provider, operation: b.operation });
    return {
      id,
      state: 'preview',
      payload,
      before: r.resource ? remoteSnapshot(ch.provider, r.resource, settings) : null,
      sku: p.sku,
      quantity,
      currency: snapshot.currency,
      price_basis:
        settings?.prices_include_tax === 'no' || ch.provider === 'prestashop' ? 'net' : 'gross',
      scope: ch.settings.simulation ? 'local_simulation' : 'external_read',
      mode: ch.mode,
      provider: ch.provider,
      ...(ch.provider === 'ebay' && b.ebay_creation
        ? {
            draft: {
              sku: payload.sku,
              title: p.name,
              description: p.description,
              condition: b.ebay_creation.condition,
              quantity,
              price: payload.offer.pricingSummary.price,
              marketplace: payload.offer.marketplaceId,
              category: payload.offer.categoryId,
              images: p.images,
              policies: payload.offer.listingPolicies,
              location: payload.offer.merchantLocationKey,
              language: payload.content_language,
              reuses_inventory: !!b.ebay_creation.reuse_inventory_plan_id,
              requirements: settings.ebay_seller_requirements ?? null,
              aspects: payload.inventory.product.aspects,
            },
          }
        : ch.provider === 'ebay' && b.operation === 'publish'
          ? { publication: ebayPublicationReadiness(r.resource) }
          : ch.provider === 'ebay'
            ? {
                affected_offers: ebayAffectedOffers(r.resource, payload),
                revision_budget: {
                  limit: 250,
                  window_hours: 24,
                  listing_ids: ebayRevisionListings(r.resource, payload),
                },
                inventory_quantity:
                  r.resource.inventory.availability.shipToLocationAvailability.quantity,
              }
            : {}),
      warning:
        ch.provider === 'amazon'
          ? 'Zmiana ceny dotyczy ceny podstawowej B2C na wybranym rynku. Rabaty, B2B i reguły automatyczne pozostają aktywne. Stan DEFAULT jest wspólny dla regionalnego konta; FBA nie jest zmieniane.'
          : settings?.prices_include_tax === 'no' || ch.provider === 'prestashop'
            ? 'Cena API jest przeliczona na netto według VAT produktu. Sprawdź klasę podatkową i reguły podatkowe sklepu.'
            : null,
    };
  });
}
async function requireNoShopifyUncertain(c: PoolClient, ch: any, plan: any) {
  if (ch.provider !== 'shopify') return;
  ensure(
    !(
      await c.query(
        `SELECT id FROM offer_plans WHERE channel_id=$1 AND id<>$2
    AND remote_snapshot->>'product_id'=$3 AND state IN ('queued','failed')
    AND phase IN ('write_started','verify') LIMIT 1`,
        [ch.id, plan.id, plan.remote_snapshot.product_id],
      )
    ).rowCount,
    409,
    'Najpierw uzgodnij niepewny zapis innego wariantu tego produktu Shopify',
  );
}
export async function queueOffer(c: PoolClient, actor: Actor, id: string, confirmLive: boolean) {
  // Catalogue writers take this lock before channel/listing rows. Take the read lock first
  // so an import cannot hold the catalogue while waiting on this queue's channel lock.
  await c.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))', [
    'catalog:' + actor.tenantId,
  ]);
  const plan = (await c.query('SELECT * FROM offer_plans WHERE id=$1 FOR UPDATE', [id])).rows[0];
  ensure(plan, 404, 'Nie znaleziono planu oferty');
  ensure(plan.actor_id === actor.userId, 403, 'Plan może zatwierdzić jego autor');
  if (plan.state === 'queued' || plan.state === 'done')
    return { id: plan.id, job_id: plan.job_id, state: plan.state };
  ensure(plan.state === 'preview', 409, 'Przygotuj nowy plan');
  ensure(
    Date.now() - new Date(plan.created_at).getTime() < 1800000,
    409,
    'Podgląd wygasł po 30 minutach',
  );
  const ch = (await c.query('SELECT * FROM channels WHERE id=$1 FOR UPDATE', [plan.channel_id]))
    .rows[0];
  ensure(
    ch.settings.simulation ||
      (ch.mode !== 'live' && !['prestashop', 'shopify', 'ebay', 'amazon'].includes(ch.provider)) ||
      confirmLive,
    422,
    'Potwierdź zapis w rzeczywistym koncie dostawcy',
  );
  if (ch.provider === 'shopify') {
    await shopifyAccountPolicy(c, ch);
    ensure(
      plan.input.shopify_credentials_hash === hash(shopifyCredentialIdentity(ch)),
      409,
      'Zgoda Shopify zmieniła się od podglądu; przygotuj nowy plan',
    );
  }
  if (ch.provider === 'allegro' && !ch.settings.simulation)
    ensure(
      ch.oauth_scopes.split(' ').includes(offerWriteScope),
      422,
      'Połącz konto Allegro z prawem zapisu ofert',
    );
  if (ch.provider === 'ebay') {
    requireEbayWrite(ch);
    await requireEbayPublication(c, ch, plan.input.ebay_account_hash, true);
  }
  if (ch.provider === 'amazon') {
    await amazonAccountPolicy(c, ch);
    requireAmazonWrite(ch);
    ensure(
      plan.input.amazon_identity_hash === amazonOfferIdentity(ch),
      409,
      'Dane dostępu Amazon zmieniły się od podglądu',
    );
    ensure(
      (await c.query('SELECT amazon_offer_claim($1) claimed', [plan.id])).rows[0].claimed,
      409,
      'Dla regionalnego SKU Amazon istnieje oczekujący lub niepewny zapis',
    );
  }
  const current = await local(c, actor, plan.input, true);
  ensure(
    hash(current.snapshot) === hash(plan.local_snapshot),
    409,
    'Cena lub stan zmieniły się od podglądu. Przygotuj nowy plan',
  );
  if (plan.listing_id) {
    const linked = (
      await c.query('SELECT * FROM listings WHERE id=$1 FOR UPDATE', [plan.listing_id])
    ).rows[0];
    ensure(
      linked?.product_id === plan.product_id &&
        linked.channel_id === plan.channel_id &&
        linked.external_id === plan.remote_id,
      409,
      'Powiązanie oferty zmieniło się od podglądu',
    );
  }
  ensure(
    !plan.input.sync_connection_hash || plan.input.sync_connection_hash === connectionHash(ch),
    409,
    'Połączenie zmieniło się od podglądu',
  );
  if (creation(plan.operation))
    ensure(
      !(
        await c.query('SELECT 1 FROM listings WHERE channel_id=$1 AND product_id=$2', [
          ch.id,
          plan.product_id,
        ])
      ).rowCount,
      409,
      'Produkt ma już powiązaną ofertę. Przygotuj plan dla istniejącego powiązania',
    );
  if (ch.provider === 'ebay' && plan.input.ebay_creation)
    ensure(
      !(
        await c.query(
          "SELECT 1 FROM offer_plans WHERE channel_id=$1 AND id<>$2 AND coalesce(remote_id,payload->>'sku')=$3 AND (state='queued' OR (state='failed' AND phase IN ('write_started','verify'))) LIMIT 1",
          [ch.id, plan.id, plan.payload.sku],
        )
      ).rowCount,
      409,
      'Dla tego SKU eBay istnieje oczekujący lub niepewny zapis',
    );
  const active = (
    await c.query(
      "SELECT id FROM offer_plans WHERE channel_id=$1 AND product_id=$2 AND (state='queued' OR (state='failed' AND phase IN ('write_started','verify')))",
      [ch.id, plan.product_id],
    )
  ).rows[0];
  ensure(!active, 409, 'Dla tego produktu trwa już zapis do kanału');
  await requireNoShopifyUncertain(c, ch, plan);
  const job = randomUUID();
  await c.query(
    "INSERT INTO jobs(id,tenant_id,kind,payload,dedup_key) VALUES($1,$2,'offer.write',$3,$4)",
    [
      job,
      actor.tenantId,
      JSON.stringify({ plan_id: id, actor_id: actor.userId, channel_id: ch.id }),
      'offer:' + id,
    ],
  );
  await c.query("UPDATE offer_plans SET state='queued',job_id=$2 WHERE id=$1", [id, job]);
  await audit(c, actor, 'offer.queue', id, {
    confirm_live: confirmLive,
    scope: ch.settings.simulation ? 'local_simulation' : ch.mode,
  });
  return { id, job_id: job, state: 'queued' };
}
async function fenced(c: PoolClient, job: any) {
  return Boolean(
    (
      await c.query(
        "UPDATE jobs SET locked_at=now() WHERE id=$1 AND lease_token=$2 AND state='running' RETURNING id",
        [job.id, job.lease_token],
      )
    ).rowCount,
  );
}
async function offerPhase(
  job: any,
  values: { phase: string; remote_id?: string; operation_id?: string },
  ctx:LocalWooStockContext={},
) {
  return tenantTx(job.tenant_id, async (c) => {
    await ctx.localWooStockFence?.(c,job);
    if (!(await fenced(c, job))) return false;
    if (values.phase === 'write_started') {
      await c.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))', [
        'catalog:' + job.tenant_id,
      ]);
      const plan = (
        await c.query('SELECT * FROM offer_plans WHERE id=$1 FOR UPDATE', [job.payload.plan_id])
      ).rows[0];
      const current = await local(
        c,
        { tenantId: job.tenant_id, userId: plan.actor_id, role: 'admin' },
        plan.input,
        true,
      );
      ensure(
        hash(current.snapshot) === hash(plan.local_snapshot),
        409,
        'Dane lokalne zmieniły się podczas odczytu; przygotuj nowy plan lub uzgodnij wynik',
      );
      ensure(
        (await c.query('SELECT offer_sync_is_admin($1) AS authorized', [plan.actor_id])).rows[0]
          .authorized,
        403,
        'Autor utracił rolę administratora',
      );
      const currentChannel = (
        await c.query('SELECT * FROM channels WHERE id=$1', [plan.channel_id])
      ).rows[0];
      ensure(
        !plan.input.sync_connection_hash ||
          plan.input.sync_connection_hash === connectionHash(currentChannel),
        409,
        'Połączenie zmieniło się od planu',
      );
      if (plan.input.shopify_credentials_hash)
        ensure(
          plan.input.shopify_credentials_hash === hash(shopifyCredentialIdentity(currentChannel)),
          409,
          'Token Shopify zmienił się od planu',
        );
      if (plan?.sync_version)
        await requireSyncPolicy(c, plan.channel_id, plan.sync_version, plan.actor_id);
      if (currentChannel.provider === 'ebay') {
        const accountHash = await requireEbayPublication(
          c,
          currentChannel,
          plan.input.ebay_account_hash,
          true,
        );
        if (plan.operation === 'sync') {
          if (!(await fenced(c, job))) return false;
          const scope = ebayRevisionScope(
            accountHash,
            currentChannel.mode,
            currentChannel.settings.simulation ? job.tenant_id : undefined,
          );
          // Only this trusted service can access the global ledger. Restore tenant role before business writes.
          await c.query('RESET ROLE');
          await reserveEbayRevisions(
            c,
            scope,
            ebayRevisionListings(plan.remote_snapshot, plan.payload),
            plan.id,
          );
          await c.query('SET LOCAL ROLE dyna_app');
        }
      }
    }
    if (!(await fenced(c, job))) return false;
    await c.query(
      'UPDATE offer_plans SET phase=$2,remote_id=coalesce($3,remote_id),operation_id=coalesce($4,operation_id) WHERE id=$1',
      [job.payload.plan_id, values.phase, values.remote_id ?? null, values.operation_id ?? null],
    );
    return true;
  });
}
function matches(ch: any, plan: any, r: any) {
  if (ch.provider === 'amazon') return amazonOfferMatches(r, plan.payload);
  const p = plan.payload;
  if (ch.provider === 'ebay')
    return plan.input?.ebay_creation
      ? ebayCreatedMatches(plan, r)
      : plan.operation === 'publish'
        ? ebayPublicationMatches(r)
        : ebayMatches(p, r);
  if (ch.provider === 'prestashop') return prestaMatches(p, r);
  if (ch.provider === 'shopify') return shopifyMatches(p, r);
  if (ch.provider === 'woocommerce')
    return (
      (!creation(plan.operation) ||
        (r.sku === p.sku &&
          (plan.operation === 'create_variant' || r.name === p.name) &&
          (plan.operation !== 'create_group' || r.type === 'variable') &&
          (plan.operation !== 'create_variant' ||
            String(r.parent_id) === plan.input.parent_external_id) &&
          (!['create_group', 'create_variant'].includes(plan.operation) ||
            attributesMatch(
              p.attributes,
              r.attributes ?? [],
              plan.operation === 'create_variant',
            )) &&
          r.meta_data?.some(
            (m: any) => m.key === '_dynaminds_offer_plan' && m.value === plan.id,
          ))) &&
      (!('regular_price' in p) ||
        decimal(Math.round(Number(r.regular_price) * 100)) === p.regular_price) &&
      (!('stock_quantity' in p) ||
        (r.stock_quantity === p.stock_quantity &&
          r.manage_stock === true &&
          r.backorders === 'no')) &&
      (!('status' in p) || r.status === p.status)
    );
  return (
    (!plan.input?.allegro || allegroCreatedMatches(plan, r)) &&
    (!p.sellingMode ||
      (Number(r.sellingMode?.price?.amount) === Number(p.sellingMode.price.amount) &&
        r.sellingMode?.price?.currency === p.sellingMode.price.currency)) &&
    (!p.stock || (r.stock?.available === p.stock.available && r.stock?.unit === p.stock.unit)) &&
    (!p.publication || r.publication?.status === p.publication.status)
  );
}
export async function processOfferJob(job: any, ctx: LocalWooStockContext = {}) {
  const phase=(j:any,values:{phase:string;remote_id?:string;operation_id?:string})=>offerPhase(j,values,ctx);
  ctx = withAllegroJobContext(ctx, job);
  const actor = await systemActor(job.tenant_id, job.payload.actor_id),
    ch = await loadChannel(job.tenant_id, job.payload.channel_id);
  if (ch.provider === 'amazon') return processAmazonOfferJob(job, actor, ch, ctx);
  const lock = lockDbClient(new pg.Client({ connectionString: pool.options.connectionString }), 'offers');
  let simulationPermit: EbayApiPermit | undefined;
  let operationFailed = false;
  try {
    return await holdingDbLock(lock, async () => {
    await lock.connect();
    const plan = await tenantTx(
      actor.tenantId,
      async (c) =>
        (await c.query('SELECT * FROM offer_plans WHERE id=$1', [job.payload.plan_id])).rows[0],
    );
    ensure(plan?.state === 'queued' && plan.channel_id === ch.id, 409, 'Plan nie jest aktywny');
    const validateConnection = (current: any) => {
      if (plan.input.shopify_credentials_hash)
        ensure(
          plan.input.shopify_credentials_hash === hash(shopifyCredentialIdentity(current)),
          409,
          'Token Shopify zmienił się; przywróć pierwotne połączenie przed uzgodnieniem',
        );
      if (plan.input.sync_connection_hash)
        ensure(
          plan.input.sync_connection_hash === connectionHash(current),
          409,
          'Połączenie zmieniło się od planu; przywróć pierwotne konto przed uzgodnieniem',
        );
    };
    validateConnection(ch);
    const ebayWriteFence = async () => {
      await tenantTx(actor.tenantId, async (c) => {
        const current = (await c.query('SELECT * FROM channels WHERE id=$1', [ch.id])).rows[0];
        validateConnection(current);
        requireEbayWrite(current);
        await requireEbayPublication(c, current, plan.input.ebay_account_hash, true);
        ensure(
          (await c.query('SELECT offer_sync_is_admin($1) authorized', [actor.userId])).rows[0]
            .authorized,
          403,
          'Autor utracił rolę administratora',
        );
        const linked = await mapping(c, plan.input, current);
        ensure(
          plan.input.ebay_creation
            ? !(
                await c.query(
                  'SELECT 1 FROM listings WHERE channel_id=$1 AND (product_id=$2 OR external_id=$3)',
                  [ch.id, plan.product_id, plan.payload.sku],
                )
              ).rowCount
            : linked?.external_id === plan.remote_id,

          409,
          'Powiązanie eBay zmieniło się przed zapisem',
        );
        ensure(
          hash((await local(c, actor, plan.input, true)).snapshot) === hash(plan.local_snapshot),
          409,
          'Dane lokalne zmieniły się przed zapisem eBay',
        );
        if (plan.sync_version) await requireSyncPolicy(c, ch.id, plan.sync_version, actor.userId);
      });
    };
    const networkContext: IntegrationContext = {
      ...ctx,
      transport: async (url, init) => {
        ensure(
          await tenantTx(actor.tenantId, (c) => fenced(c, job)),
          409,
          'Dzierżawa zadania wygasła',
        );
        validateConnection(await loadChannel(actor.tenantId, ch.id));
        if (
          ch.provider === 'ebay' &&
          (new URL(url).pathname === '/sell/inventory/v1/bulk_update_price_quantity' ||
            (init.method === 'POST' &&
              /^\/sell\/inventory\/v1\/offer\/[^/]+\/publish$/.test(new URL(url).pathname)) ||
            (plan.input.ebay_creation &&
              ((init.method === 'PUT' &&
                new URL(url).pathname.startsWith('/sell/inventory/v1/inventory_item/')) ||
                (init.method === 'POST' && new URL(url).pathname === '/sell/inventory/v1/offer'))))
        )
          await ebayWriteFence();
        return (ctx.transport ?? safeFetch)(url, init);
      },
    };
    const findCreated = async (client: WooCommerce) => {
      const found =
        plan.operation === 'create_variant'
          ? await client.variationBySku(plan.input.parent_external_id, p.p.sku)
          : await client.bySku(p.p.sku);
      if (plan.operation !== 'create_variant' || !Array.isArray(found)) return found;
      return Promise.all(
        found.map((v: any) => client.product(String(v.id), plan.input.parent_external_id)),
      );
    };
    if (
      plan.sync_version &&
      !(await tenantTx(actor.tenantId, (c) =>
        syncPolicy(c, ch.id, plan.sync_version, actor.userId),
      ))
    ) {
      ensure(plan.phase !== 'ready', 409, 'Harmonogram ofert wyłączono lub zmieniono');
      job.payload = { ...job.payload, accept_observed: true };
    }
    await lock.query("SET statement_timeout='20s'");
    await lock.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [
      `offer:${actor.tenantId}:${ch.id}:${ch.provider === 'shopify' ? plan.remote_snapshot.product_id : ch.provider === 'ebay' ? (plan.remote_id ?? plan.payload.sku) : plan.product_id}`,
    ]);
    if (!(await tenantTx(actor.tenantId, (c) => fenced(c, job)))) return;
    if (!job.payload.accept_observed)
      await tenantTx(actor.tenantId, (c) => requireNoShopifyUncertain(c, ch, plan));
    const p = await tenantTx(actor.tenantId, (c) =>
      local(c, actor, plan.input, plan.phase !== 'ready' || job.payload.accept_observed),
    );
    if (plan.phase === 'ready')
      ensure(
        hash(p.snapshot) === hash(plan.local_snapshot),
        409,
        'Cena lub stan zmieniły się przed wykonaniem. Przygotuj nowy plan',
      );
    let resource: any;
    if (ch.settings.simulation) {
      if (ch.provider === 'ebay' && plan.operation !== 'sync' && !job.payload.accept_observed)
        simulationPermit = await reserveEbaySimulation(actor.tenantId, ch.mode);
      if (
        !job.payload.accept_observed &&
        !(ch.provider === 'ebay' && plan.operation === 'sync') &&
        !(await phase(job, { phase: 'write_started' }))
      )
        return;
      const l = plan.listing_id
        ? await tenantTx(
            actor.tenantId,
            async (c) =>
              (await c.query('SELECT * FROM listings WHERE id=$1', [plan.listing_id])).rows[0],
          )
        : null;
      resource = job.payload.accept_observed
        ? l
          ? simulationResource(ch, l, plan.operation === 'publish')
          : { id: null, _no_resource: true }
        : {
            ...simulationResource(ch, l, plan.operation === 'publish'),
            id: plan.remote_id ?? 'DEMO-' + plan.id,
            sku: p.p.sku,
            ...plan.payload,
            ...(plan.operation === 'create_variant'
              ? { parent_id: plan.input.parent_external_id, type: 'variation' }
              : {}),
          };
      if (ch.provider === 'shopify') {
        const base = await simulationShopifyPublication(actor, ch, l, plan.input);
        if (plan.input.publication_id && plan.phase === 'ready' && !job.payload.accept_observed)
          ensure(
            hash(shopifySnapshot(base)) === hash(plan.remote_snapshot),
            409,
            'Produkt demonstracyjny zmienił się przed publikacją',
          );
        resource = job.payload.accept_observed
          ? base
          : {
              ...base,
              sku: p.p.sku,
              ...plan.payload,
              ...(plan.input.publication_id ? { status: plan.payload.product_status } : {}),
            };
        resource.capture_price = plan.input.price;
        resource.capture_stock = plan.input.stock;
      }
      if (ch.provider === 'ebay' && plan.input.ebay_creation) {
        if (!job.payload.accept_observed) await ebayWriteFence();
        if (!job.payload.accept_observed && plan.input.ebay_creation.verify_settings) {
          const requirements = demoEbayRequirements(
            plan.input.ebay_creation,
            ch.settings.marketplace_id,
          );
          validateEbayAspects(requirements.category, plan.payload.inventory.product.aspects);
          ensure(
            hash(requirements) === hash(plan.remote_snapshot.ebay_seller_requirements),
            409,
            'Warunki lub wymagania kategorii eBay zmieniły się od podglądu',
          );
        }
        const observed = plan.result?.ebay_simulation_snapshot;
        resource = job.payload.accept_observed
          ? (observed ?? {
              id: plan.payload.sku,
              inventory: null,
              offers: [],
              status: 'ABSENT',
              _no_resource: true,
              _skip_mapping: true,
            })
          : simulationEbayCreation(plan);
        if (!job.payload.accept_observed) {
          const saved = await tenantTx(actor.tenantId, async (c) => {
            if (!(await fenced(c, job))) return false;
            await c.query("UPDATE offer_plans SET phase='verify',result=$2 WHERE id=$1", [
              plan.id,
              JSON.stringify({
                ebay_simulation_snapshot: resource,
                ebay_creation_steps: {
                  inventory_started: true,
                  inventory_verified: true,
                  offer_started: true,
                  offer_verified: true,
                  offer_id: resource.offer_id,
                },
              }),
            ]);
            return true;
          });
          if (!saved) return;
        }
      }
      if (ch.provider === 'ebay' && !plan.input.ebay_creation) {
        const base = simulationEbayOffer(
          ch,
          l,
          plan.remote_snapshot.offer_id,
          plan.operation === 'publish',
        );
        if (plan.operation === 'publish' && !job.payload.accept_observed) await ebayWriteFence();
        if (!job.payload.accept_observed) {
          ensure(
            hash(ebaySnapshot(base)) === hash(plan.remote_snapshot),
            409,
            'Oferty demonstracyjne eBay zmieniły się od podglądu',
          );
          resource =
            plan.operation === 'publish'
              ? simulationEbayPublication(base)
              : ebayExpected(base, plan.payload);
          if (
            plan.operation === 'sync' &&
            hash(ebaySnapshot(base)) !== hash(ebaySnapshot(resource))
          ) {
            simulationPermit = await reserveEbaySimulation(actor.tenantId, ch.mode);
            if (!(await phase(job, { phase: 'write_started' }))) return;
          }
        } else resource = base;
      }
      if (
        ch.provider === 'prestashop' &&
        !job.payload.accept_observed &&
        resource.combination_id === '0' &&
        plan.input.price
      )
        resource.product_price = plan.payload.regular_price;
    } else {
      if (ch.provider === 'allegro' && !job.payload.accept_observed)
        ensure(
          ch.oauth_scopes.split(' ').includes(offerWriteScope),
          422,
          'Brak prawa zapisu ofert Allegro',
        );
      resource = await channelRead(
        actor.tenantId,
        ch.id,
        async (client) => {
          if (client instanceof Ebay && plan.input.ebay_creation)
            return executeEbayCreation(
              client,
              plan,
              async (step, offerId) => {
                await ebayWriteFence();
                return tenantTx(actor.tenantId, async (c) => {
                  if (!(await fenced(c, job))) return false;
                  const current =
                    (
                      await c.query('SELECT result FROM offer_plans WHERE id=$1 FOR UPDATE', [
                        plan.id,
                      ])
                    ).rows[0].result ?? {};
                  const steps = {
                    ...(current.ebay_creation_steps ?? {}),
                    [step]: true,
                    ...(offerId ? { offer_id: offerId } : {}),
                  };
                  await c.query('UPDATE offer_plans SET phase=$2,result=$3 WHERE id=$1', [
                    plan.id,
                    step === 'offer_verified' ? 'verify' : 'write_started',
                    JSON.stringify({ ...current, ebay_creation_steps: steps }),
                  ]);
                  return true;
                });
              },
              Boolean(job.payload.accept_observed),
              plan.input.ebay_creation.verify_settings
                ? async () => {
                    await ebayWriteFence();
                    requireEbaySellerSettings(ch);
                    const requirements = await readEbayDraftRequirements(
                      client,
                      plan.input.ebay_creation,
                      ch.settings.marketplace_id,
                      ebayWriteFence,
                    );
                    validateEbayAspects(
                      requirements.category,
                      plan.payload.inventory.product.aspects,
                    );
                    ensure(
                      hash(requirements) === hash(plan.remote_snapshot.ebay_seller_requirements),
                      409,
                      'Warunki lub wymagania kategorii eBay zmieniły się od podglądu',
                    );
                  }
                : undefined,
            );
          if (client instanceof Ebay)
            return (plan.operation === 'publish' ? executeEbayPublication : executeEbaySync)(
              client,
              plan,
              async (state) => {
                await ebayWriteFence();
                return phase(job, { phase: state });
              },
              Boolean(job.payload.accept_observed),
            );
          if (client instanceof Allegro && !job.payload.accept_observed)
            ensure(
              (await loadChannel(actor.tenantId, ch.id)).oauth_scopes
                .split(' ')
                .includes(offerWriteScope),
              403,
              'Token Allegro nie ma prawa zapisu ofert',
            );
          if (job.payload.accept_observed) {
            if (client instanceof Shopify)
              return readShopifyOffer(
                client,
                plan.remote_id,
                plan.input.price,
                plan.input.stock,
                ch.settings.inventory_location_id,
                false,
                plan.input.publication_id,
              );
            if (client instanceof PrestaShop)
              return readPrestaOffer(client, plan.remote_id, plan.input.price, false, false);
            if (client instanceof WooCommerce) {
              if (plan.remote_id)
                return client.product(plan.remote_id, plan.input.parent_external_id);
              const found = await findCreated(client);
              ensure(
                Array.isArray(found) && found.length <= 1,
                409,
                'Niejednoznaczny wynik odczytu SKU',
              );
              if (!found.length) return { id: null, _no_resource: true };
              ensure(
                found[0].meta_data?.some(
                  (m: any) => m.key === '_dynaminds_offer_plan' && m.value === plan.id,
                ),
                409,
                'Znaleziony produkt nie należy do planu',
              );
              return found[0];
            }
            ensure(client instanceof Allegro, 422, 'Nieobsługiwany kanał');
            if (plan.input.allegro && !plan.remote_id) {
              const found = await client.offersByExternalId(plan.payload.external.id);
              ensure(found.length <= 1, 409, 'Niejednoznaczny wynik tworzenia Allegro');
              if (!found.length) return { id: null, _no_resource: true };
              const result = await client.offer(String(found[0].id));
              ensure(
                result.external?.id === plan.payload.external.id,
                409,
                'Oferta Allegro nie należy do tego planu',
              );
              return result;
            }
            if (plan.operation_id) {
              const operation = await client.offerOperation(plan.remote_id, plan.operation_id);
              if (operation.pending) {
                ensure(
                  Date.now() - new Date(plan.created_at).getTime() < 3600000,
                  422,
                  'Przetwarzanie Allegro trwa ponad godzinę; sprawdź wynik u dostawcy',
                );
                await tenantTx(actor.tenantId, async (c) => {
                  if (await fenced(c, job))
                    await c.query(
                      "UPDATE jobs SET state='pending',attempts=0,lease_token=NULL,locked_at=NULL,run_at=now()+interval '5 seconds' WHERE id=$1",
                      [job.id],
                    );
                });
                return null;
              }
              ensure(
                operation.done,
                422,
                'Operacja Allegro nadal trwa lub wymaga wyjaśnienia u dostawcy',
              );
            }
            const observed = await client.offer(plan.remote_id);
            if (plan.input.allegro)
              ensure(
                observed.external?.id === plan.payload.external.id,
                409,
                'Oferta Allegro nie należy do tego planu',
              );
            return observed;
          }
          if (client instanceof Shopify) {
            let r = await readShopifyOffer(
              client,
              plan.remote_id,
              plan.input.price,
              plan.input.stock,
              ch.settings.inventory_location_id,
              true,
              plan.input.publication_id,
            );
            const steps = { ...(plan.result?.shopify_steps ?? {}) };
            const applied: Record<string, boolean> = {};
            const desiredParts: Record<string, any> = {
              ...(plan.input.price ? { price: { regular_price: plan.payload.regular_price } } : {}),
              ...(plan.input.stock
                ? { stock: { stock_quantity: plan.payload.stock_quantity } }
                : {}),
              ...(plan.input.publication_id
                ? {
                    activation: { product_status: plan.payload.product_status },
                    publication: { publication_id: plan.payload.publication_id, published: true },
                  }
                : {}),
            };
            for (const [key, desired] of Object.entries(desiredParts)) {
              if (steps[key] && shopifyMatches(desired, r)) applied[key] = true;
            }
            const expected = () => shopifyExpected(plan.remote_snapshot, plan.payload, applied);
            ensure(
              hash(shopifySnapshot(r)) === hash(expected()),
              409,
              'Oferta lub zakres Shopify zmienił się; uzgodnij wynik przed dalszym zapisem',
            );
            const record = async (key: string, status: string) =>
              tenantTx(actor.tenantId, async (c) => {
                if (!(await fenced(c, job))) return false;
                steps[key] = status;
                plan.result = { ...(plan.result ?? {}), shopify_steps: steps };
                await c.query('UPDATE offer_plans SET result=$2 WHERE id=$1', [
                  plan.id,
                  JSON.stringify(plan.result),
                ]);
                return true;
              });
            for (const [key, desired] of Object.entries(desiredParts)) {
              if (shopifyMatches(desired, r)) {
                if (steps[key] && !(await record(key, 'verified'))) return null;
                continue;
              }
              ensure(
                !steps[key],
                409,
                'Rozpoczęta próba Shopify nie jest potwierdzona; uzgodnij wynik bez powtarzania mutacji',
              );
              ensure(
                hash(shopifySnapshot(r)) === hash(expected()),
                409,
                'Oferta zmieniła się między częściami zapisu Shopify',
              );
              if (!(await phase(job, { phase: 'write_started' }))) return null;
              if (!(await record(key, 'started'))) return null;
              if (key === 'price')
                await client.setVariantPrice(r.product_id, r.id, plan.payload.regular_price);
              else if (key === 'activation') await client.activateProduct(r.product_id);
              else if (key === 'publication')
                await client.publishProduct(r.product_id, plan.input.publication_id);
              else
                await client.setInventoryQuantity(
                  r.inventory_item_id,
                  r.location_id,
                  plan.payload.stock_quantity,
                  r.stock_quantity,
                  plan.id,
                );
              r = await readShopifyOffer(
                client,
                plan.remote_id,
                plan.input.price,
                plan.input.stock,
                ch.settings.inventory_location_id,
                true,
                plan.input.publication_id,
              );
              ensure(
                shopifyMatches(desired, r),
                502,
                'Shopify nie potwierdził zapisanej części planu',
              );
              applied[key] = true;
              ensure(
                hash(shopifySnapshot(r)) === hash(expected()),
                409,
                'Inne dane oferty zmieniły się podczas zapisu Shopify',
              );
              if (!(await record(key, 'verified'))) return null;
            }
            ensure(matches(ch, plan, r), 502, 'Shopify nie potwierdził całego planu');
            return r;
          }
          if (client instanceof PrestaShop) {
            let r = await readPrestaOffer(
              client,
              plan.remote_id,
              plan.input.price,
              plan.input.stock,
            );
            const steps = { ...(plan.result?.presta_steps ?? {}) };
            const applied: Record<string, boolean> = {};
            for (const key of ['price', 'stock']) {
              const desired =
                key === 'price'
                  ? { regular_price: plan.payload.regular_price }
                  : { stock_quantity: plan.payload.stock_quantity };
              if (steps[key] && prestaMatches(desired, r)) applied[key] = true;
            }
            const expected = () => prestaExpected(plan.remote_snapshot, plan.payload, applied);
            ensure(
              hash(prestaSnapshot(r)) === hash(expected()),
              409,
              'Oferta lub zakres PrestaShop zmienił się; uzgodnij wynik przed dalszym zapisem',
            );
            const record = async (key: string, status: string) =>
              tenantTx(actor.tenantId, async (c) => {
                if (!(await fenced(c, job))) return false;
                steps[key] = status;
                plan.result = { ...(plan.result ?? {}), presta_steps: steps };
                await c.query('UPDATE offer_plans SET result=$2 WHERE id=$1', [
                  plan.id,
                  JSON.stringify(plan.result),
                ]);
                return true;
              });
            for (const key of ['price', 'stock']) {
              if (!(key === 'price' ? plan.input.price : plan.input.stock)) continue;
              const desired =
                key === 'price'
                  ? { regular_price: plan.payload.regular_price }
                  : { stock_quantity: plan.payload.stock_quantity };
              if (prestaMatches(desired, r)) {
                if (steps[key] && !(await record(key, 'verified'))) return null;
                continue;
              }
              ensure(
                !steps[key],
                409,
                'Rozpoczęta próba PrestaShop nie jest potwierdzona; uzgodnij wynik bez powtarzania PATCH',
              );
              ensure(
                !plan.input.price || !r.specific_prices,
                409,
                'Ceny specjalne PrestaShop zmieniły się podczas zapisu',
              );
              ensure(
                hash(prestaSnapshot(r)) === hash(expected()),
                409,
                'Oferta zmieniła się między częściami zapisu PrestaShop',
              );
              if (!(await phase(job, { phase: 'write_started' }))) return null;
              if (!(await record(key, 'started'))) return null;
              if (key === 'price') {
                const variant = r.combination_id !== '0';
                await client.patchOffer(
                  variant ? 'combinations' : 'products',
                  variant ? r.combination_id : r.product_id,
                  {
                    price: variant
                      ? psMoney(psMicros(plan.payload.regular_price) - psMicros(r.product_price))
                      : plan.payload.regular_price,
                  },
                );
              } else
                await client.patchOffer('stock_availables', r.stock_id, {
                  quantity: plan.payload.stock_quantity,
                  out_of_stock: 0,
                });
              r = await readPrestaOffer(client, plan.remote_id, plan.input.price, plan.input.stock);
              ensure(
                prestaMatches(desired, r),
                502,
                'PrestaShop nie potwierdził zapisanej części planu',
              );
              applied[key] = true;
              ensure(
                hash(prestaSnapshot(r)) === hash(expected()),
                409,
                'Inne dane oferty zmieniły się podczas zapisu PrestaShop',
              );
              if (!(await record(key, 'verified'))) return null;
            }
            ensure(matches(ch, plan, r), 502, 'PrestaShop nie potwierdził ceny i stanu');
            return r;
          }
          if (client instanceof WooCommerce) {
            const settings =
              plan.input.price || plan.operation !== 'sync' ? await wooSettings(client) : undefined;
            if (plan.remote_snapshot?.currency)
              ensure(
                settings?.currency === plan.remote_snapshot.currency &&
                  settings?.prices_include_tax === plan.remote_snapshot.prices_include_tax,
                409,
                'Konfiguracja cen sklepu zmieniła się od podglądu',
              );
            if (plan.operation === 'create_variant') {
              const parent = await client.product(plan.input.parent_external_id);
              ensure(
                String(parent?.id) === plan.input.parent_external_id,
                502,
                'Dostawca zwrócił inną grupę',
              );
              if (plan.phase === 'ready')
                ensure(
                  hash(parentSnapshot(parent)) === hash(plan.remote_snapshot.parent_signature),
                  409,
                  'Konfiguracja grupy zmieniła się od podglądu',
                );
              validateParent(parent, { sku: plan.local_snapshot.parent.sku }, p.p.attributes);
            }
            let r: any;
            if (plan.remote_id)
              r = await client.product(plan.remote_id, plan.input.parent_external_id);
            else {
              const found = await findCreated(client);
              ensure(
                Array.isArray(found) && found.length <= 1,
                409,
                'Niejednoznaczne SKU w sklepie',
              );
              if (found.length) {
                r = found[0];
                ensure(
                  r.meta_data?.some(
                    (m: any) => m.key === '_dynaminds_offer_plan' && m.value === plan.id,
                  ),
                  409,
                  'SKU istnieje i nie należy do tego planu. Powiąż ofertę ręcznie',
                );
              }
            }
            if (r && creation(plan.operation) && !plan.remote_id) {
              ensure(
                matches(ch, plan, r),
                409,
                'Utworzony zasób różni się od planu; uzgodnij wynik bez ponownego tworzenia',
              );
              return r;
            }
            if (r && creation(plan.operation) && plan.remote_id && plan.phase !== 'ready') {
              ensure(
                matches(ch, plan, r),
                409,
                'Utworzony zasób różni się od planu; uzgodnij wynik zamiast ponawiać zapis',
              );
              return r;
            }
            if (r && plan.phase !== 'ready' && matches(ch, plan, r)) return r;
            if (plan.phase === 'ready' && plan.remote_id && plan.remote_snapshot)
              ensure(
                hash(remoteSnapshot(ch.provider, r, settings)) === hash(plan.remote_snapshot),
                409,
                'Oferta zewnętrzna zmieniła się od podglądu',
              );
            ensure(
              hash(p.snapshot) === hash(plan.local_snapshot),
              409,
              'Dane lokalne zmieniły się; nie ponawiam wcześniejszego zapisu. Uzgodnij wynik',
            );
            if (!(await phase(job, { phase: 'write_started' }))) return null;
            if (plan.remote_id)
              await client.writeProduct(
                plan.remote_id,
                plan.payload,
                plan.input.parent_external_id,
              );
            else {
              r =
                plan.operation === 'create_variant'
                  ? await client.createVariation(plan.input.parent_external_id, plan.payload)
                  : await client.createProduct(plan.payload);
              ensure(r && r.id, 502, 'Brak identyfikatora utworzonego produktu');
              if (!(await phase(job, { phase: 'verify', remote_id: String(r.id) }))) return null;
            }
            r = await client.product(plan.remote_id ?? String(r.id), plan.input.parent_external_id);
            ensure(
              matches(ch, plan, r),
              502,
              'Dostawca nie potwierdził żądanej ceny, stanu lub publikacji',
            );
            return r;
          }
          ensure(client instanceof Allegro, 422, 'Nieobsługiwany zapis oferty');
          if (plan.input.allegro) {
            let remoteId = plan.remote_id;
            if (!remoteId) {
              const found = await client.offersByExternalId(plan.payload.external.id);
              if (found.length) remoteId = String(found[0].id);
              else {
                ensure(
                  plan.phase === 'ready',
                  409,
                  'Niepewny wynik tworzenia Allegro; uzgodnij odczytem bez ponownego POST',
                );
                ensure(
                  (await loadChannel(actor.tenantId, ch.id)).oauth_scopes
                    .split(' ')
                    .includes(allegroSettingsReadScope),
                  403,
                  'Brak prawa odczytu ustawień Allegro',
                );
                const context = await allegroCreationContext(client, plan.input.allegro);
                ensure(
                  hash(context) === hash(plan.remote_snapshot.allegro_creation),
                  409,
                  'Produkt katalogu lub ustawienia Allegro zmieniły się od podglądu',
                );
                if (!(await phase(job, { phase: 'write_started' }))) return null;
                const created = await client.createDraft(plan.payload);
                remoteId = created.id;
                if (
                  !(await phase(job, {
                    phase: 'verify',
                    remote_id: remoteId,
                    operation_id: created.operationId,
                  }))
                )
                  return null;
                plan.operation_id = created.operationId;
              }
              if (!(await phase(job, { phase: 'verify', remote_id: remoteId }))) return null;
            }
            if (plan.operation_id) {
              const operation = await client.offerOperation(remoteId, plan.operation_id);
              if (operation.pending) {
                ensure(
                  Date.now() - new Date(plan.created_at).getTime() < 3600000,
                  422,
                  'Przetwarzanie Allegro trwa ponad godzinę; uzgodnij wynik',
                );
                await tenantTx(actor.tenantId, async (c) => {
                  if (await fenced(c, job))
                    await c.query(
                      "UPDATE jobs SET state='pending',attempts=0,lease_token=NULL,locked_at=NULL,run_at=now()+interval '5 seconds' WHERE id=$1",
                      [job.id],
                    );
                });
                return null;
              }
              ensure(operation.done, 502, 'Tworzenie Allegro nie zakończyło się poprawnie');
            }
            const result = await client.offer(remoteId);
            ensure(
              matches(ch, plan, result),
              409,
              'Utworzona oferta Allegro różni się od planu; uzgodnij wynik bez ponownego tworzenia',
            );
            return result;
          }
          if (plan.operation_id) {
            const operation = await client.offerOperation(plan.remote_id, plan.operation_id);
            if (operation.pending) {
              ensure(
                Date.now() - new Date(plan.created_at).getTime() < 3600000,
                422,
                'Przetwarzanie Allegro trwa ponad godzinę; sprawdź wynik operacji u dostawcy',
              );
              await tenantTx(actor.tenantId, async (c) => {
                if (!(await fenced(c, job))) return;
                await c.query(
                  "UPDATE jobs SET state='pending',attempts=0,lease_token=NULL,locked_at=NULL,run_at=now()+interval '5 seconds' WHERE id=$1",
                  [job.id],
                );
              });
              return null;
            }
            ensure(
              operation.done,
              502,
              'Asynchroniczna operacja Allegro nie zakończyła się poprawnie',
            );
          }
          let r = await client.offer(plan.remote_id);
          if (plan.phase !== 'ready' && matches(ch, plan, r)) return r;
          if (plan.operation_id)
            throw new Problem(
              409,
              'Operacja Allegro zakończona, ale wynik różni się od planu. Uzgodnij ofertę',
            );
          if (plan.phase === 'ready')
            ensure(
              hash(remoteSnapshot(ch.provider, r)) === hash(plan.remote_snapshot),
              409,
              'Oferta Allegro zmieniła się od podglądu',
            );
          ensure(
            hash(p.snapshot) === hash(plan.local_snapshot),
            409,
            'Dane lokalne zmieniły się; nie ponawiam wcześniejszego zapisu. Uzgodnij wynik',
          );
          if (!(await phase(job, { phase: 'write_started' }))) return null;
          const result = await client.patchOffer(plan.remote_id, plan.payload);
          if (result.accepted) {
            const operation = z.uuid().parse(result.operationId);
            if (!(await phase(job, { phase: 'verify', operation_id: operation }))) return null;
            await tenantTx(actor.tenantId, async (c) => {
              if (!(await fenced(c, job))) return;
              await c.query(
                "UPDATE jobs SET state='pending',attempts=0,lease_token=NULL,locked_at=NULL,run_at=now()+interval '5 seconds' WHERE id=$1",
                [job.id],
              );
            });
            return null;
          }
          r = await client.offer(plan.remote_id);
          ensure(matches(ch, plan, r), 502, 'Allegro nie potwierdziło zmiany oferty');
          return r;
        },
        networkContext,
        false,
        validateConnection,
      );
    }
    if (!resource) return;
    await tenantTx(actor.tenantId, async (c) => {
      await ctx.localWooStockFence?.(c,job);
      if (!(await fenced(c, job))) return;
      if (ch.provider === 'ebay') {
        const currentChannel = (
          await c.query('SELECT * FROM channels WHERE id=$1 FOR SHARE', [ch.id])
        ).rows[0];
        validateConnection(currentChannel);
        const linked = await mapping(c, plan.input, currentChannel);
        ensure(
          plan.input.ebay_creation
            ? !(
                await c.query(
                  'SELECT 1 FROM listings WHERE channel_id=$1 AND (product_id=$2 OR external_id=$3)',
                  [ch.id, plan.product_id, plan.payload.sku],
                )
              ).rowCount
            : linked?.external_id === plan.remote_id,
          409,
          'Powiązanie eBay zmieniło się podczas weryfikacji',
        );
        await requireEbayPublication(c, currentChannel, plan.input.ebay_account_hash);
      }
      const current = await local(c, actor, plan.input, true);
      const id = resource._no_resource ? null : String(resource.id),
        scope = ch.settings.simulation
          ? 'local_simulation'
          : job.payload.accept_observed
            ? 'external_api_observed'
            : 'external_api_verified';
      ensure(
        plan.remote_id === null || id === plan.remote_id,
        502,
        'Dostawca zwrócił inny identyfikator oferty',
      );
      let listing = plan.listing_id;
      if (!listing && !resource._no_resource && !resource._skip_mapping)
        listing = (
          await c.query(
            `INSERT INTO listings(id,tenant_id,channel_id,product_id,external_id,status,price,warehouse_id,parent_external_id,price_currency)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
            [
              randomUUID(),
              actor.tenantId,
              ch.id,
              plan.product_id,
              id,
              ch.settings.simulation ? 'simulation' : 'draft',
              plan.local_snapshot.price,
              plan.warehouse_id,
              plan.input.parent_external_id ?? null,
              plan.local_snapshot.currency,
            ],
          )
        ).rows[0].id;
      const oldResult = listing
        ? ((await c.query('SELECT last_result FROM listings WHERE id=$1', [listing])).rows[0]
            ?.last_result ?? {})
        : {};
      if (listing)
        await c.query(
          'UPDATE listings SET status=$2,warehouse_id=$3,parent_external_id=$4,price=$5,last_result=$6,price_currency=$7 WHERE id=$1',
          [
            listing,
            ch.settings.simulation
              ? 'simulation'
              : (resource.status ?? resource.publication?.status ?? 'synced'),
            plan.warehouse_id,
            plan.input.parent_external_id ?? null,
            plan.input.price && !job.payload.accept_observed
              ? plan.local_snapshot.price
              : (await c.query('SELECT price FROM listings WHERE id=$1', [listing])).rows[0].price,
            JSON.stringify({
              ...(ch.provider === 'allegro'
                ? {
                    ...oldResult,
                    ...(plan.input.allegro
                      ? {
                          allegro_creation_snapshot: {
                            name: resource.name,
                            external: resource.external,
                            productSet: resource.productSet,
                            parameters: resource.parameters,
                            delivery: resource.delivery,
                            afterSalesServices: resource.afterSalesServices,
                          },
                        }
                      : {}),
                  }
                : {}),
              ...(ch.provider === 'shopify' ? { ...oldResult, ...shopifySnapshot(resource) } : {}),
              ...(ch.provider === 'ebay'
                ? {
                    ...oldResult,
                    ebay_offer_snapshot: ebaySnapshot(resource),
                    stock_scope: 'external_availability',
                    inventory_quantity:
                      resource.inventory.availability.shipToLocationAvailability.quantity,
                  }
                : {}),
              ...(ch.provider === 'shopify' && resource.capture_publication
                ? {
                    publications: {
                      ...(oldResult.publications ?? {}),
                      [resource.publication_id]: resource.published,
                    },
                  }
                : {}),
              stock_quantity:
                ch.provider === 'ebay'
                  ? resource.stock_quantity
                  : ch.provider === 'shopify'
                    ? plan.input.stock
                      ? resource.stock_quantity
                      : oldResult.stock_quantity
                    : ch.provider === 'prestashop'
                      ? resource.stock_quantity
                      : job.payload.accept_observed || !plan.input.stock
                        ? (resource.stock_quantity ??
                          resource.stock?.available ??
                          oldResult.stock_quantity)
                        : (plan.payload.stock_quantity ?? plan.payload.stock?.available),
              status: resource.status ?? resource.publication?.status,
              scope,
              ...((ch.provider === 'woocommerce' &&
                ['create_group', 'create_variant'].includes(plan.operation)) ||
              resource.type === 'variable'
                ? { type: resource.type, sku: resource.sku, attributes: resource.attributes ?? [] }
                : {}),
              actual_snapshot: job.payload.accept_observed
                ? remoteSnapshot(ch.provider, resource)
                : undefined,
              ...(ch.provider === 'prestashop'
                ? {
                    regular_price: resource.regular_price,
                    product_price: resource.product_price,
                    sku: resource.sku,
                  }
                : {}),
            }),
            plan.input.price && !job.payload.accept_observed
              ? plan.local_snapshot.currency
              : (await c.query('SELECT price_currency FROM listings WHERE id=$1', [listing]))
                  .rows[0].price_currency,
          ],
        );
      if (ch.provider === 'shopify' && ch.settings.simulation && resource.capture_publication) {
        await c.query(
          `UPDATE listings SET last_result = jsonb_set(
          jsonb_set(coalesce(last_result,'{}'::jsonb),'{status}',to_jsonb($3::text)),
          '{publications}',coalesce(last_result->'publications','{}'::jsonb) || jsonb_build_object($4::text,$5::boolean))
          WHERE channel_id=$1 AND coalesce(last_result->>'product_id','gid://shopify/Product/702')=$2`,
          [
            ch.id,
            resource.product_id,
            resource.status,
            resource.publication_id,
            resource.published,
          ],
        );
      }
      await c.query(
        "UPDATE offer_plans SET state='done',listing_id=$2,remote_id=$3,phase='done',result=$4,completed_at=now(),error=NULL WHERE id=$1",
        [
          plan.id,
          listing,
          id,
          JSON.stringify({
            id,
            scope,
            requested_payload: plan.payload,
            ...(ch.provider === 'ebay' && plan.input.ebay_creation
              ? {
                  ebay_creation_steps:
                    (await c.query('SELECT result FROM offer_plans WHERE id=$1', [plan.id])).rows[0]
                      .result?.ebay_creation_steps ?? {},
                  ebay_offer_id: resource.offer_id ?? null,
                  retained_inventory:
                    ebayOwnedInventory(resource.inventory, plan.payload) &&
                    resource._skip_mapping === true &&
                    resource.offers?.length === 0,
                }
              : {}),
            ...(ch.provider === 'ebay' && plan.operation === 'publish'
              ? {
                  ebay_publication: {
                    offer_id: resource.offer_id,
                    listing_id: resource.publication_context?.offer?.listing?.listingId ?? null,
                    status: resource.status,
                  },
                }
              : {}),
            ...(ch.provider === 'shopify'
              ? { shopify_steps: plan.result?.shopify_steps ?? {} }
              : {}),
            ...(ch.provider === 'prestashop'
              ? { presta_steps: plan.result?.presta_steps ?? {} }
              : {}),
            verified_payload:
              job.payload.accept_observed && !matches(ch, plan, resource)
                ? undefined
                : plan.payload,
            local_changed: hash(current.snapshot) !== hash(plan.local_snapshot),
            desired_applied: resource._no_resource ? false : matches(ch, plan, resource),
            actual_snapshot:
              job.payload.accept_observed && !resource._no_resource
                ? remoteSnapshot(ch.provider, resource)
                : undefined,
          }),
        ],
      );
      await c.query(
        "UPDATE jobs SET state='done',lease_token=NULL,locked_at=NULL,error=NULL WHERE id=$1",
        [job.id],
      );
      await audit(c, actor, 'offer.done', plan.id, { scope, remote_id: id });
    });
    });
  } catch (firstError) {
    operationFailed = true;
    throw firstError;
  } finally {
    if (simulationPermit) await releaseEbayApi(simulationPermit).catch(() => {});
    // A failed connect/body is the primary cause. Always await this client's close,
    // but do not replace that cause with a secondary close failure.
    try { await lock.end(); }
    catch (closeError) { if (!operationFailed) throw closeError; }
  }
}
export async function failOffer(job: any, e: unknown) {
  if (await deferAmazonOfferWait(job, e)) return;
  if (await deferAmazonApiJob(job, e)) return;
  if (await deferEbayApiJob(job, e)) return;
  const message = e instanceof Problem ? e.message : 'Błąd zapisu oferty';
  await tenantTx(job.tenant_id, async (c) => {
    if (!(await fenced(c, job))) return;
    const plan = (await c.query('SELECT phase FROM offer_plans WHERE id=$1', [job.payload.plan_id]))
      .rows[0];
    if (e instanceof EbayRevisionWait && plan.phase === 'ready') {
      await c.query(
        "UPDATE jobs SET state='pending',attempts=greatest(0,attempts-1),error=$2,lease_token=NULL,locked_at=NULL,run_at=$3::timestamptz+interval '1 second' WHERE id=$1",
        [job.id, e.message, e.until],
      );
      await c.query(
        "UPDATE offer_plans SET state='queued',error=$2,result=coalesce(result,'{}'::jsonb)||jsonb_build_object('ebay_revision_wait_until',$3::text) WHERE id=$1",
        [job.payload.plan_id, e.message, e.until],
      );
      return;
    }
    const terminal =
      (e instanceof Problem && [403, 409, 422].includes(e.status)) ||
      job.attempts >= job.max_attempts;
    await c.query(
      'UPDATE jobs SET state=$2,error=$3,lease_token=NULL,locked_at=NULL,run_at=now()+make_interval(secs=>least(300,power(2,attempts)::int)) WHERE id=$1',
      [job.id, terminal ? 'failed' : 'pending', message],
    );
    await c.query('UPDATE offer_plans SET state=$2,error=$3 WHERE id=$1', [
      job.payload.plan_id,
      terminal
        ? e instanceof Problem && e.status === 409 && plan.phase === 'ready'
          ? 'conflict'
          : 'failed'
        : 'queued',
      message,
    ]);
  });
}

export { local as desiredOffer, matches as offerMatches, hash as offerSnapshotHash };
