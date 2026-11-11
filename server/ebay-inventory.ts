import { z } from 'zod';
import { createHash } from 'node:crypto';
import { Ebay, ebayBase } from './ebay';
import { ensure, Problem } from './errors';
import { imageUrl } from './domain';
import { sourceHash } from './catalog-source-normalize';
export const ebaySku = z
  .string()
  .min(1)
  .max(50)
  .regex(/^[^\x00-\x1f\x7f]+$/);
const groupKey = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[^\x00-\x1f\x7f]+$/);
export const ebayGroupId = (key: string) =>
  'ebay-group:' + createHash('sha256').update(key).digest('hex');
/** Consume only the offset from a provider link; all requests retain our fixed origin and filters. */
function nextOffset(client: Ebay, raw: any, path: string, params: URLSearchParams, offset: number) {
  if (!raw.next) return null;
  let u: URL;
  try {
    u = new URL(raw.next);
  } catch {
    throw new Problem(502, 'Nieprawidłowa następna strona Inventory eBay');
  }
  ensure(
    u.origin === ebayBase(client.mode) &&
      u.pathname === '/sell/inventory/v1/' + path &&
      !u.username &&
      !u.password &&
      !u.hash &&
      [...u.searchParams.keys()].every((k) => k === 'offset' || params.has(k)) &&
      [...params].every(
        ([k, v]) =>
          k === 'offset' || (u.searchParams.getAll(k).length === 1 && u.searchParams.get(k) === v),
      ) &&
      u.searchParams.getAll('offset').length === 1 &&
      /^\d{1,7}$/.test(u.searchParams.get('offset') ?? ''),
    502,
    'Następna strona zmienia zakres Inventory eBay',
  );
  const next = Number(u.searchParams.get('offset'));
  ensure(next > offset && next <= 1000000, 502, 'Brak postępu paginacji Inventory eBay');
  return next;
}
export async function ebayInventoryPage(
  client: Ebay,
  path: string,
  key: string,
  offset: number,
  filters: Record<string, string>,
  fence: () => Promise<void>,
) {
  const params = new URLSearchParams({ ...filters, limit: '25', offset: String(offset) });
  const raw = await client.request(path + '?' + params, fence, 'inventory');
  const rows = raw[key] ?? (raw.total === 0 ? [] : undefined);
  ensure(
    Number.isSafeInteger(raw.total) &&
      raw.total >= 0 &&
      raw.total <= 1000000 &&
      raw.limit === 25 &&
      Array.isArray(rows) &&
      rows.length <= 25 &&
      (raw.size === undefined || raw.size === rows.length) &&
      rows.length <= raw.total,
    502,
    'Nieprawidłowe metadane strony Inventory eBay',
  );
  const next = nextOffset(client, raw, path, params, offset);
  ensure(next === null || rows.length > 0, 502, 'Pusta strona z dalszym kursorem Inventory eBay');
  ensure(
    offset !== 0 || next !== null || rows.length === raw.total,
    502,
    'Brak dalszej strony Inventory eBay',
  );
  return { rows, next, total: raw.total };
}
export async function readEbayCatalogPage(
  client: Ebay,
  offset: number,
  marketplace: string,
  fence: () => Promise<void>,
) {
  const result = await ebayInventoryPage(
    client,
    'inventory_item',
    'inventoryItems',
    offset,
    {},
    fence,
  );
  const groups = new Map<string, any>();
  const seen = new Set<string>();
  const rows: any[] = [];
  for (const item of result.rows) {
    const sku = ebaySku.parse(item?.sku);
    ensure(!seen.has(sku), 502, 'Powtórzone SKU na stronie Inventory eBay');
    seen.add(sku);
    const keys = item.inventoryItemGroupKeys ?? item.groupIds ?? [];
    ensure(
      Array.isArray(keys) && keys.length <= 20 && keys.every((k) => groupKey.safeParse(k).success),
      502,
      'Nieprawidłowe grupy Inventory eBay',
    );
    let group: any = null;
    if (keys.length === 1) {
      const key = keys[0];
      if (!groups.has(key)) {
        const g = await client.request(
          'inventory_item_group/' + encodeURIComponent(key),
          fence,
          'inventory',
        );
        ensure(
          g.inventoryItemGroupKey === key &&
            Array.isArray(g.variantSKUs) &&
            g.variantSKUs.length > 0 &&
            g.variantSKUs.length <= 250 &&
            new Set(g.variantSKUs).size === g.variantSKUs.length &&
            g.variantSKUs.every((s: any) => ebaySku.safeParse(s).success),
          502,
          'Niepełna grupa Inventory eBay',
        );
        groups.set(key, g);
      }
      group = groups.get(key);
      ensure(group.variantSKUs.includes(sku), 502, 'SKU nie należy do zwróconej grupy eBay');
    }
    const offers: any[] = [];
    const offerIds = new Set<string>();
    let offerOffset = 0,
      unavailable = false,
      total: number | undefined;
    for (let n = 0; n < 10; n++) {
      let response: Awaited<ReturnType<typeof ebayInventoryPage>>;
      try {
        response = await ebayInventoryPage(
          client,
          'offer',
          'offers',
          offerOffset,
          { sku, marketplace_id: marketplace },
          fence,
        );
      } catch (e) {
        if (!(e instanceof Problem && e.status === 404 && n === 0)) throw e;
        unavailable = true;
        break; // Preserve uncertainty; no source price can be inferred.
      }
      ensure(
        total === undefined || total === response.total,
        409,
        'Liczba ofert eBay zmieniła się podczas odczytu',
      );
      total = response.total;
      for (const o of response.rows) {
        ensure(
          o.sku === sku &&
            o.marketplaceId === marketplace &&
            typeof o.offerId === 'string' &&
            o.offerId.length > 0 &&
            o.offerId.length <= 160 &&
            !offerIds.has(o.offerId) &&
            ['FIXED_PRICE', 'AUCTION'].includes(o.format) &&
            ['PUBLISHED', 'UNPUBLISHED'].includes(o.status),
          502,
          'Niepełna, powtórzona lub obca oferta Inventory eBay',
        );
        offerIds.add(o.offerId);
        offers.push(o);
      }
      if (response.next === null) {
        ensure(offers.length === total, 409, 'Niepełny zbiór ofert eBay');
        break;
      }
      ensure(n < 9, 422, 'Przekroczono limit ofert jednego SKU eBay');
      offerOffset = response.next;
    }
    rows.push({ item, group, offers, offers_unavailable: unavailable });
  }
  return { ...result, rows };
}
const plain = (v: any) =>
  typeof v === 'string'
    ? v
        .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
    : '';
export function normalizeEbayCatalog(raw: any, run: any, asGroup = false) {
  const item = raw.item,
    group = raw.group,
    offers = raw.offers;
  const sku = ebaySku.parse(item.sku),
    key = group?.inventoryItemGroupKey;
  const id = asGroup ? ebayGroupId(groupKey.parse(key)) : sku;
  const keys = item.inventoryItemGroupKeys ?? item.groupIds ?? [];
  const unsupported = !asGroup && (keys.length > 1 || (!!keys.length && !group));
  const kind = asGroup ? 'group' : unsupported ? 'unsupported' : group ? 'variant' : 'simple';
  const parent = kind === 'variant' ? ebayGroupId(key) : null;
  const p = asGroup ? group : (item.product ?? {});
  const issues: string[] = [];
  if (unsupported) issues.push('Wiele grup lub brak klucza grupy: wymagane uzgodnienie wariantu');
  const attrs: Record<string, string> = Object.create(null);
  const entries = Object.entries({ ...group?.aspects, ...p.aspects });
  for (const [k, v] of entries.slice(0, 50)) {
    if (!Array.isArray(v) || !v.every((s) => typeof s === 'string')) {
      issues.push('Pominięto nieprawidłowy parametr');
      continue;
    }
    const name = plain(k),
      value = plain(v.join(', '));
    if (name.length > 80 || value.length > 500) issues.push('Skrócono parametr do limitu katalogu');
    if (name && value) attrs[name.slice(0, 80)] = value.slice(0, 500);
  }
  if (entries.length > 50) issues.push('Parametry ograniczono do 50');
  const urls = p.imageUrls ?? [];
  ensure(Array.isArray(urls), 502, 'Nieprawidłowa galeria eBay');
  const valid = [
    ...new Set<string>(
      urls.filter(
        (v: any) =>
          typeof v === 'string' && v.startsWith('https://') && imageUrl.safeParse(v).success,
      ),
    ),
  ];
  if (valid.length !== urls.length || valid.length > 10)
    issues.push('Pominięto nieprawidłowe lub nadmiarowe zdjęcia (limit 10)');
  const eligible = offers.filter((o: any) => o.format === 'FIXED_PRICE');
  const selected = eligible.length === 1 ? eligible[0] : null;
  let price: number | null = asGroup ? 0 : null;
  const currency = asGroup
    ? run.context.currency
    : (selected?.pricingSummary?.price?.currency ?? null);
  if (
    !asGroup &&
    selected &&
    [
      'PLN',
      'EUR',
      'USD',
      'GBP',
      'CZK',
      'SEK',
      'NOK',
      'DKK',
      'CHF',
      'AUD',
      'CAD',
      'NZD',
      'HKD',
    ].includes(currency) &&
    typeof selected.pricingSummary?.price?.value === 'string' &&
    /^\d{1,8}(\.\d{1,2})?$/.test(selected.pricingSummary.price.value)
  ) {
    const [whole, frac = ''] = selected.pricingSummary.price.value.split('.');
    let amount = BigInt(whole) * 100n + BigInt(frac.padEnd(2, '0'));
    if (!run.context.prices_include_tax) amount = (amount * BigInt(100 + run.vat) + 50n) / 100n;
    if (amount <= 100000000n && !selected.tax?.applyTax && !selected.tax?.thirdPartyTaxCategory)
      price = Number(amount);
  }
  if (!asGroup && price === null)
    issues.push('Brak jednoznacznej ceny FIXED_PRICE; wpisz cenę lokalną');
  if (!asGroup && raw.offers_unavailable)
    issues.push('API ofert zwróciło HTTP 404; dostępność ofert niepotwierdzona');
  if (!asGroup && offers.some((o: any) => o.format === 'AUCTION'))
    issues.push('Oferta aukcyjna zachowana w podglądzie; cena startowa nie jest ceną lokalną');
  const lot = !asGroup && offers.some((o: any) => o.lotSize !== undefined && o.lotSize !== 1);
  if (lot) issues.push('Oferta zbiorcza lotSize wymaga osobnego mapowania jednostek');
  const qty = item.availability?.shipToLocationAvailability?.quantity;
  const quantity = asGroup ? 0 : Number.isInteger(qty) && qty >= 0 && qty <= 10000000 ? qty : null;
  if (!asGroup && quantity === null) issues.push('Dostępność eBay nieznana');
  const description = plain(p.description);
  if (description.length > 10000) issues.push('Skrócono opis do 10000 znaków');
  const source = {
    external_id: id,
    parent_external_id: parent,
    kind,
    unsupported: unsupported || lot,
    sku: asGroup ? `EB-GROUP-${run.channel_id.slice(0, 8)}-${id.slice(-12)}` : sku.trim(),
    source_sku: asGroup ? null : sku,
    name: (plain(p.title) || (asGroup ? 'Grupa eBay ' + key : 'Produkt eBay ' + sku)).slice(0, 200),
    description: description.slice(0, 10000),
    ean: plain(p.ean?.[0]).slice(0, 32),
    category: 'eBay',
    attributes: attrs,
    images: valid.slice(0, 10),
    price,
    vat: run.vat,
    currency,
    quantity,
    active: true,
    source_status: asGroup ? 'GROUP' : (selected?.status ?? 'UNKNOWN'),
    ebay: asGroup
      ? { group_key: key, variant_skus: group.variantSKUs, varies_by: group.variesBy ?? null }
      : {
          sku,
          locale: item.locale ?? null,
          group_key: key ?? null,
          condition: item.condition ?? null,
          availability: item.availability ?? null,
          offers,
          selected_offer_id: selected?.offerId ?? null,
          offers_unavailable: !!raw.offers_unavailable,
          stock_scope: 'external_availability',
        },
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
