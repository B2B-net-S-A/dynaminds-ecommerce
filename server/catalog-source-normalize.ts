import { createHash } from 'node:crypto';
import { z } from 'zod';
import { cents } from './imports';
import { imageUrl } from './domain';
import { ensure } from './errors';
export const sourceHash = (v: unknown) =>
  createHash('sha256').update(JSON.stringify(v)).digest('hex');
export const sourceId = z
  .union([
    z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    z.string().regex(/^[1-9]\d{0,14}$/),
  ])
  .transform(String);
const plain = (v: unknown) =>
  typeof v === 'string'
    ? v
        .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(
          /&(?:amp|lt|gt|quot|apos|nbsp);/g,
          (s) =>
            ({
              '&amp;': '&',
              '&lt;': '<',
              '&gt;': '>',
              '&quot;': '"',
              '&apos;': "'",
              '&nbsp;': ' ',
            })[s]!,
        )
        .replace(/\s+/g, ' ')
        .trim()
    : '';
export function normalizeSource(raw: any, run: any, parent?: string) {
  const id = sourceId.parse(raw?.id);
  const issues: string[] = [];
  if (parent && raw.parent_id != null)
    ensure(String(raw.parent_id) === parent, 502, 'Źródło zwróciło wariant innej grupy');
  const kind = parent
    ? 'variant'
    : raw.type === 'variable'
      ? 'group'
      : raw.type === 'simple'
        ? 'simple'
        : 'unsupported';
  const sku = typeof raw.sku === 'string' ? raw.sku.trim() : '';
  const localSku = sku || `WC-${run.channel_id.slice(0, 8)}-${id}`;
  if (!sku) issues.push('Brak SKU u dostawcy; proponowany symbol lokalny można zmienić');
  if (localSku.length > 80) issues.push('SKU przekracza 80 znaków; podaj krótszy symbol lokalny');
  if (kind === 'unsupported' || raw.virtual || raw.downloadable)
    issues.push('Ten typ produktu nie jest obsługiwany przez import fizycznego katalogu');
  let price: number | null = null;
  const vat = raw.tax_status === 'none' ? 0 : run.vat;
  if (kind === 'group') price = 0;
  else
    try {
      const n = cents(raw.regular_price);
      price =
        run.context.prices_include_tax || raw.tax_status === 'none'
          ? n
          : Math.floor((n * (100 + vat) + 50) / 100);
      ensure(price <= 100000000, 422, 'Cena przekracza limit katalogu');
    } catch {
      price = null;
      issues.push('Nie można odczytać ceny regularnej; podaj jawną cenę lokalną');
    }
  if (raw.on_sale || raw.sale_price)
    issues.push('Import używa ceny regularnej; promocja pozostaje w sklepie');
  const known =
    raw.manage_stock === true &&
    Number.isInteger(raw.stock_quantity) &&
    raw.stock_quantity >= 0 &&
    raw.stock_quantity <= 10000000;
  if (kind !== 'group' && !known)
    issues.push(
      'Brak jednoznacznej ilości; stan początkowy wymaga wpisania liczby albo importu bez stanów',
    );
  const sourceImages = Array.isArray(raw.images) ? raw.images : raw.image ? [raw.image] : [];
  const images = sourceImages
    .map((i: any) => i?.src)
    .filter(
      (s: any) =>
        typeof s === 'string' && s.startsWith('https://') && imageUrl.safeParse(s).success,
    )
    .slice(0, 10);
  if (images.length !== sourceImages.length)
    issues.push('Pominięto nieprawidłowe zdjęcia lub zdjęcia ponad limit 10');
  const attributes: Record<string, string> = Object.create(null);
  const all = Array.isArray(raw.attributes) ? raw.attributes : [];
  for (const a of all.slice(0, 50)) {
    const name = plain(a?.name).slice(0, 80);
    const value = plain(
      parent ? a?.option : Array.isArray(a?.options) ? a.options.join(', ') : '',
    ).slice(0, 500);
    if (name && value) attributes[name] = value;
  }
  if (all.length > 50) issues.push('Zaimportujemy pierwsze 50 parametrów');
  const description = plain(raw.description || raw.short_description);
  if (description.length > 10000) issues.push('Opis skrócono do 10000 znaków');
  const source = {
    external_id: id,
    parent_external_id: parent ?? null,
    kind,
    unsupported: kind === 'unsupported' || Boolean(raw.virtual || raw.downloadable),
    sku: localSku,
    source_sku: sku,
    name: (plain(raw.name) || `Produkt WooCommerce ${id}`).slice(0, 200),
    description: description.slice(0, 10000),
    ean: plain(raw.global_unique_id).slice(0, 32),
    category: (plain(raw.categories?.[0]?.name) || 'WooCommerce').slice(0, 80),
    attributes,
    images,
    price,
    vat,
    currency: run.context.currency,
    quantity: kind === 'group' ? 0 : known ? raw.stock_quantity : null,
    active: raw.status === 'publish',
    tax_class: plain(raw.tax_class).slice(0, 200),
    source_status: plain(raw.status).slice(0, 80),
  };
  return {
    external_id: id,
    parent_external_id: parent ?? null,
    kind,
    source,
    source_hash: sourceHash(source),
    issues,
  };
}
export const demoCatalog = (parent?: string, page = 1) =>
  page !== 1
    ? []
    : parent === '702'
      ? [
          {
            id: 703,
            sku: 'DEMO-BLUE',
            name: 'Koszulka — niebieska',
            status: 'publish',
            regular_price: '39.99',
            tax_status: 'taxable',
            manage_stock: true,
            stock_quantity: 6,
            attributes: [{ name: 'Kolor', option: 'Niebieski' }],
          },
          {
            id: 704,
            sku: 'DEMO-RED',
            name: 'Koszulka — czerwona',
            status: 'publish',
            regular_price: '42.50',
            tax_status: 'taxable',
            manage_stock: true,
            stock_quantity: 7,
            attributes: [{ name: 'Kolor', option: 'Czerwony' }],
          },
        ]
      : parent
        ? []
        : [
            {
              id: 701,
              type: 'simple',
              sku: 'DEMO-IMPORT',
              name: 'Produkt z przykładowego sklepu',
              status: 'publish',
              regular_price: '31.67',
              tax_status: 'taxable',
              manage_stock: true,
              stock_quantity: 20,
              description: '<p>Lokalny katalog demonstracyjny.</p>',
              attributes: [{ name: 'Materiał', options: ['Bawełna'] }],
            },
            {
              id: 702,
              type: 'variable',
              sku: 'DEMO-GROUP',
              name: 'Koszulka — grupa wariantów',
              status: 'publish',
              variations: [703, 704],
              attributes: [{ name: 'Kolor', options: ['Niebieski', 'Czerwony'] }],
            },
          ];
