import { ensure } from './errors';
import { imageUrl } from './domain';
import { sourceHash } from './catalog-source-normalize';
import { shopifyId } from './shopify';

const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const numeric = (id: string) => id.split('/').at(-1)!;
function images(media: any, issues: string[]) {
  ensure(
    Array.isArray(media?.nodes) && typeof media.pageInfo?.hasNextPage === 'boolean',
    502,
    'Niepełne media katalogu Shopify',
  );
  const urls = media.nodes.map((n: any) => (n?.__typename === 'MediaImage' ? n.image?.url : null));
  const valid = urls.filter(
    (u: any) => typeof u === 'string' && u.startsWith('https://') && imageUrl.safeParse(u).success,
  );
  if (valid.length !== urls.length || media.pageInfo.hasNextPage || valid.length > 10)
    issues.push('Pominięto media inne niż zdjęcia, nieprawidłowe adresy lub zdjęcia ponad limit');
  return [...new Set<string>(valid)].slice(0, 10);
}
function attributes(options: any[], group: boolean, issues: string[]) {
  ensure(Array.isArray(options), 502, 'Brak parametrów katalogu Shopify');
  const out: Record<string, string> = Object.create(null);
  for (const a of options.slice(0, 50)) {
    const name = text(a?.name),
      value = group ? a?.optionValues?.map((v: any) => text(v.name)).join(', ') : text(a?.value);
    ensure(typeof value === 'string', 502, 'Niepełny parametr katalogu Shopify');
    if (name.length > 80 || value.length > 500) issues.push('Skrócono nazwę lub wartość parametru');
    if (name && value) out[name.slice(0, 80)] = value.slice(0, 500);
  }
  if (options.length > 50) issues.push('Zaimportujemy pierwsze 50 parametrów');
  return out;
}
/** Product GIDs identify local groups; every saleable row retains its ProductVariant GID. */
export function normalizeShopifyCatalog(raw: any, run: any, group = false) {
  const p = raw?.product,
    productId = shopifyId(p?.id, 'Product'),
    variantId = shopifyId(raw?.id, 'ProductVariant');
  ensure(
    typeof p.hasOnlyDefaultVariant === 'boolean' &&
      typeof p.isGiftCard === 'boolean' &&
      ['ACTIVE', 'DRAFT', 'ARCHIVED', 'UNLISTED'].includes(p.status) &&
      Number.isFinite(Date.parse(p.updatedAt)),
    502,
    'Niepełny produkt katalogu Shopify',
  );
  ensure(
    raw.inventoryItem &&
      typeof raw.inventoryItem.requiresShipping === 'boolean' &&
      typeof raw.inventoryItem.tracked === 'boolean' &&
      typeof raw.taxable === 'boolean' &&
      typeof raw.requiresComponents === 'boolean',
    502,
    'Niepełny wariant katalogu Shopify',
  );
  shopifyId(raw.inventoryItem.id, 'InventoryItem');
  const issues: string[] = [],
    kind = group ? 'group' : p.hasOnlyDefaultVariant ? 'simple' : 'variant';
  const id = group ? productId : variantId,
    parent = kind === 'variant' ? productId : null;
  const sku = group ? '' : text(raw.sku),
    localSku = sku || `SH-${group ? 'GROUP-' : ''}${run.channel_id.slice(0, 8)}-${numeric(id)}`;
  if (!sku) issues.push('Brak SKU u dostawcy; proponowany symbol lokalny można zmienić');
  if (localSku.length > 80) issues.push('SKU przekracza 80 znaków; podaj krótszy symbol lokalny');
  const unsupported =
    p.isGiftCard || (!group && (!raw.inventoryItem.requiresShipping || raw.requiresComponents));
  if (unsupported)
    issues.push(
      'Karta podarunkowa, produkt cyfrowy lub zestaw komponentów wymaga osobnego procesu',
    );
  const vat = group || raw.taxable ? run.vat : 0;
  let price: number | null = group ? 0 : null;
  if (!group) {
    if (typeof raw.price === 'string' && /^\d{1,10}(\.\d{1,2})?$/.test(raw.price)) {
      const [whole, fraction = ''] = raw.price.split('.');
      let cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
      if (!run.context.prices_include_tax && raw.taxable)
        cents = (cents * BigInt(100 + vat) + 50n) / 100n;
      if (cents <= 100000000n) price = Number(cents);
    }
    if (price === null) issues.push('Nie można odczytać ceny; podaj jawną cenę lokalną');
    if (raw.compareAtPrice != null)
      issues.push('Import używa bieżącej ceny wariantu; cena porównawcza pozostaje w sklepie');
  }
  let quantity: number | null = group ? 0 : null;
  if (!group && run.import_stock) {
    const level = raw.inventoryItem.inventoryLevel;
    if (level) {
      ensure(
        level.item?.id === raw.inventoryItem.id && level.location?.id === run.location_id,
        502,
        'Stan Shopify dotyczy innego towaru lub lokalizacji',
      );
      const quantities = level.quantities;
      ensure(
        Array.isArray(quantities) && quantities.length === 1 && quantities[0]?.name === 'available',
        502,
        'Niepełny stan dostępny Shopify',
      );
      const n = quantities[0].quantity;
      if (
        raw.inventoryItem.tracked &&
        level.isActive === true &&
        level.location.isActive === true &&
        level.location.fulfillsOnlineOrders === true &&
        Number.isInteger(n) &&
        n >= 0 &&
        n <= 10000000
      )
        quantity = n;
    }
    if (quantity === null)
      issues.push(
        'Brak jednoznacznej ilości w wybranej lokalizacji; wpisz stan początkowy albo importuj bez stanów',
      );
  }
  const productImages = images(p.media, issues),
    variantImages = group ? [] : images(raw.media, issues);
  const combined = [...new Set([...variantImages, ...productImages])];
  if (combined.length > 10) issues.push('Zdjęcia ograniczono do 10');
  const description = text(p.description),
    ean = group ? '' : text(raw.barcode);
  if (description.length > 10000) issues.push('Opis skrócono do 10000 znaków');
  if (ean.length > 32) issues.push('Pominięto kod kreskowy przekraczający 32 znaki');
  const source = {
    external_id: id,
    parent_external_id: parent,
    kind,
    unsupported,
    sku: localSku,
    source_sku: sku,
    name: `${text(p.title) || 'Produkt Shopify'}${kind === 'variant' ? ' — ' + text(raw.title) : ''}`.slice(
      0,
      200,
    ),
    description: description.slice(0, 10000),
    ean: ean.length <= 32 ? ean : '',
    category: (text(p.productType) || 'Shopify').slice(0, 80),
    attributes: p.hasOnlyDefaultVariant
      ? {}
      : attributes(group ? p.options : raw.selectedOptions, group, issues),
    images: combined.slice(0, 10),
    price,
    vat,
    currency: run.context.currency,
    quantity,
    active: p.status === 'ACTIVE' || p.status === 'UNLISTED',
    source_status: p.status,
    product_id: productId,
    product_updated_at: p.updatedAt,
    inventory_item_id: group ? null : raw.inventoryItem.id,
    location_id: group || !run.import_stock ? null : run.location_id,
    taxable: group ? null : raw.taxable,
    regular_price: group ? null : raw.price,
  };
  return {
    external_id: id,
    parent_external_id: parent,
    kind,
    source,
    source_hash: sourceHash(source),
    issues,
  };
}

export const demoShopifyCatalog = (location: string) => {
  const media = { nodes: [], pageInfo: { hasNextPage: false } };
  const make = (
    id: number,
    product: number,
    sku: string,
    title: string,
    simple: boolean,
    quantity: number,
  ) => ({
    id: `gid://shopify/ProductVariant/${id}`,
    sku,
    title,
    barcode: '',
    price: simple ? '20.00' : '39.99',
    compareAtPrice: null,
    taxable: true,
    requiresComponents: false,
    selectedOptions: simple
      ? [{ name: 'Title', value: 'Default Title' }]
      : [{ name: 'Kolor', value: title }],
    media,
    inventoryItem: {
      id: `gid://shopify/InventoryItem/${id}`,
      tracked: true,
      requiresShipping: true,
      inventoryLevel: {
        id: `gid://shopify/InventoryLevel/${id}`,
        isActive: true,
        item: { id: `gid://shopify/InventoryItem/${id}` },
        location: { id: location, isActive: true, fulfillsOnlineOrders: true },
        quantities: [{ name: 'available', quantity }],
      },
    },
    product: {
      id: `gid://shopify/Product/${product}`,
      title: simple ? 'Produkt Shopify' : 'Koszulka Shopify',
      description: 'Lokalny katalog demonstracyjny.',
      productType: 'Shopify',
      status: 'ACTIVE',
      hasOnlyDefaultVariant: simple,
      isGiftCard: false,
      updatedAt: '2026-10-04T00:00:00Z',
      options: simple
        ? []
        : [{ name: 'Kolor', optionValues: [{ name: 'Niebieski' }, { name: 'Czerwony' }] }],
      media,
    },
  });
  return [
    make(701, 700, 'QA-SHOPIFY', 'Default Title', true, 10),
    make(703, 702, 'SH-DEMO-BLUE', 'Niebieski', false, 6),
    make(704, 702, 'SH-DEMO-RED', 'Czerwony', false, 7),
  ];
};
