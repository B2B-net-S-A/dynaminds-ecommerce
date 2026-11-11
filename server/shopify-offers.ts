import type { Shopify } from './shopify';
import { shopifyId, demoShopifyPublication } from './shopify';
import { ensure } from './errors';

export function shopifyCents(value: unknown) {
  ensure(
    typeof value === 'string' && /^\d{1,8}(?:\.\d{1,2})?$/.test(value),
    502,
    'Nieprawidłowa cena Shopify',
  );
  const [whole, fraction = ''] = value.split('.');
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  ensure(cents <= 2147483647n, 502, 'Cena Shopify przekracza limit');
  return cents;
}
const money = (cents: bigint) => cents / 100n + '.' + String(cents % 100n).padStart(2, '0');
export function shopifyDesiredPrice(price: number, vat: number, included: boolean) {
  ensure(
    Number.isInteger(price) &&
      price >= 0 &&
      price <= 2147483647 &&
      Number.isInteger(vat) &&
      vat >= 0 &&
      vat <= 100,
    422,
    'Nieprawidłowa cena lub VAT',
  );
  const denominator = BigInt(100 + vat);
  return money(included ? BigInt(price) : (BigInt(price) * 100n + denominator / 2n) / denominator);
}
export async function readShopifyOffer(
  client: Shopify,
  external: string,
  price: boolean,
  stock: boolean,
  location?: string,
  validateWrites = true,
  publication?: string,
) {
  ensure(price || stock || publication, 422, 'Wybierz zakres Shopify');
  const publishing = publication ? await client.publicationOffer(external, publication) : null;
  const d = price || stock ? await client.offer(external, price, stock, location) : publishing,
    v = d.productVariant;
  if (publishing)
    ensure(
      v.product?.id === publishing.productVariant.product?.id &&
        v.product.status === publishing.productVariant.product.status &&
        v.sku === publishing.productVariant.sku,
      409,
      'Produkt Shopify zmienił się podczas odczytu',
    );
  const r: any = {
    id: external,
    sku: v.sku ?? '',
    product_id: shopifyId(v.product?.id, 'Product'),
    status: v.product.status,
    capture_price: price,
    capture_stock: stock,
  };
  ensure(
    typeof r.sku === 'string' && ['ACTIVE', 'DRAFT', 'ARCHIVED', 'UNLISTED'].includes(r.status),
    502,
    'Niepełne dane wariantu Shopify',
  );
  if (publishing) {
    const p = publishing.productVariant.product,
      pub = publishing.publication;
    ensure(
      typeof p.title === 'string' &&
        p.title.length > 0 &&
        p.title.length <= 1024 &&
        typeof p.requiresSellingPlan === 'boolean' &&
        typeof p.publishedOnPublication === 'boolean' &&
        Number.isSafeInteger(p.variantsCount?.count) &&
        p.variantsCount.count > 0 &&
        ['EXACT', 'AT_LEAST'].includes(p.variantsCount.precision),
      502,
      'Brak zakresu publikacji produktu Shopify',
    );
    Object.assign(r, {
      capture_publication: true,
      publication_id: publication,
      published: p.publishedOnPublication,
      publication_title: pub.catalog?.title ?? pub.id,
      publication_catalog_id: pub.catalog?.id ?? null,
      publication_catalog_status: pub.catalog?.status ?? null,
      product_title: p.title,
      variants_count: p.variantsCount.count,
      variants_count_precision: p.variantsCount.precision,
      requires_selling_plan: p.requiresSellingPlan,
    });
  }
  if (price) {
    ensure(
      /^[A-Z]{3}$/.test(d.shop.currencyCode) &&
        typeof d.shop.taxesIncluded === 'boolean' &&
        typeof v.taxable === 'boolean',
      502,
      'Brak konfiguracji cen Shopify',
    );
    Object.assign(r, {
      regular_price: money(shopifyCents(v.price)),
      compare_at_price: v.compareAtPrice === null ? null : money(shopifyCents(v.compareAtPrice)),
      currency: d.shop.currencyCode,
      prices_include_tax: d.shop.taxesIncluded ? 'yes' : 'no',
      taxable: v.taxable,
    });
  }
  if (stock) {
    const item = v.inventoryItem,
      level = item?.inventoryLevel;
    const itemId = shopifyId(item?.id, 'InventoryItem');
    ensure(
      typeof item.tracked === 'boolean' &&
        typeof item.requiresShipping === 'boolean' &&
        typeof v.requiresComponents === 'boolean' &&
        ['DENY', 'CONTINUE'].includes(v.inventoryPolicy),
      502,
      'Brak polityki stanów Shopify',
    );
    ensure(
      level &&
        typeof level.id === 'string' &&
        level.id.length <= 512 &&
        /^gid:\/\/shopify\/InventoryLevel\/[1-9]\d*(?:\?inventory_item_id=[1-9]\d*)?$/.test(
          level.id,
        ) &&
        level.item?.id === itemId &&
        level.location?.id === location,
      502,
      'Brak stanu właściwego wariantu i lokalizacji Shopify',
    );
    ensure(
      [level.isActive, level.location.isActive, level.location.fulfillsOnlineOrders].every(
        (f) => typeof f === 'boolean',
      ),
      502,
      'Brak aktywności lokalizacji Shopify',
    );
    const quantities = level.quantities;
    ensure(
      Array.isArray(quantities) &&
        quantities.length === 1 &&
        quantities[0].name === 'available' &&
        Number.isInteger(quantities[0].quantity) &&
        Math.abs(quantities[0].quantity) <= 2147483647,
      502,
      'Nieprawidłowy stan available Shopify',
    );
    Object.assign(r, {
      inventory_item_id: itemId,
      location_id: location,
      inventory_level_id: level.id,
      stock_quantity: quantities[0].quantity,
      tracked: item.tracked,
      requires_shipping: item.requiresShipping,
      requires_components: v.requiresComponents,
      inventory_policy: v.inventoryPolicy,
      level_active: level.isActive,
      location_active: level.location.isActive,
      fulfills_online_orders: level.location.fulfillsOnlineOrders,
    });
    ensure(
      !validateWrites ||
        (r.tracked &&
          r.requires_shipping &&
          !r.requires_components &&
          r.level_active &&
          r.location_active &&
          r.fulfills_online_orders),
      422,
      'Stan Shopify wymaga śledzonego produktu fizycznego, aktywnej lokalizacji online i osobnej polityki dla zestawów natywnych',
    );
  }
  return r;
}
export function shopifySnapshot(r: any) {
  const keys = ['id', 'sku', 'product_id', 'status', 'capture_price', 'capture_stock'];
  if (r.capture_publication)
    keys.push(
      'capture_publication',
      'publication_id',
      'published',
      'publication_title',
      'publication_catalog_id',
      'publication_catalog_status',
      'product_title',
      'variants_count',
      'variants_count_precision',
      'requires_selling_plan',
    );
  if (r.capture_price)
    keys.push('regular_price', 'compare_at_price', 'currency', 'prices_include_tax', 'taxable');
  if (r.capture_stock)
    keys.push(
      'inventory_item_id',
      'location_id',
      'inventory_level_id',
      'stock_quantity',
      'tracked',
      'requires_shipping',
      'requires_components',
      'inventory_policy',
      'level_active',
      'location_active',
      'fulfills_online_orders',
    );
  return Object.fromEntries(keys.map((k) => [k, r[k] ?? null]));
}
export function shopifyMatches(payload: any, r: any) {
  return (
    (!('regular_price' in payload) ||
      shopifyCents(r.regular_price) === shopifyCents(payload.regular_price)) &&
    (!('stock_quantity' in payload) || r.stock_quantity === payload.stock_quantity) &&
    (!('product_status' in payload) || r.status === payload.product_status) &&
    (!('publication_id' in payload) ||
      (r.publication_id === payload.publication_id && r.published === payload.published))
  );
}
export function shopifyExpected(snapshot: any, payload: any, applied: Record<string, boolean>) {
  return {
    ...snapshot,
    ...(applied.price ? { regular_price: payload.regular_price } : {}),
    ...(applied.stock ? { stock_quantity: payload.stock_quantity } : {}),
    ...(applied.activation ? { status: payload.product_status } : {}),
    ...(applied.publication ? { published: payload.published } : {}),
  };
}
export function simulationShopifyOffer(
  ch: any,
  l: any,
  price = true,
  stock = true,
  publication?: string,
) {
  return {
    ...(publication
      ? {
          capture_publication: true,
          publication_id: publication,
          published: l.last_result?.publications?.[publication] ?? false,
          publication_title: demoShopifyPublication.catalog.title,
          publication_catalog_id: demoShopifyPublication.catalog.id,
          publication_catalog_status: 'ACTIVE',
          product_title: l.last_result?.product_title ?? 'Produkt demonstracyjny Shopify',
          variants_count: 1,
          variants_count_precision: 'EXACT',
          requires_selling_plan: false,
        }
      : {}),
    id: shopifyId(l.external_id, 'ProductVariant'),
    sku: l.last_result?.sku ?? '',
    product_id: l.last_result?.product_id ?? 'gid://shopify/Product/702',
    status: l.last_result?.status ?? 'ACTIVE',
    capture_price: price,
    capture_stock: stock,
    regular_price: l.last_result?.regular_price ?? money(BigInt(l.price)),
    compare_at_price: null,
    currency: ch.settings.currency ?? 'PLN',
    prices_include_tax: l.last_result?.prices_include_tax ?? 'yes',
    taxable: l.last_result?.taxable ?? true,
    inventory_item_id: l.last_result?.inventory_item_id ?? 'gid://shopify/InventoryItem/703',
    location_id: ch.settings.inventory_location_id,
    inventory_level_id: 'gid://shopify/InventoryLevel/704?inventory_item_id=703',
    stock_quantity: l.last_result?.stock_quantity ?? 0,
    tracked: true,
    requires_shipping: true,
    requires_components: false,
    inventory_policy: 'DENY',
    level_active: true,
    location_active: true,
    fulfills_online_orders: true,
  };
}
