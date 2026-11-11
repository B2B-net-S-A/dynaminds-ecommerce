import { createHash } from 'node:crypto';
import { z } from 'zod';
import { Ebay } from './ebay';
import { ebaySku, ebayInventoryPage } from './ebay-inventory';
import { ensure } from './errors';
import { demoEbayCatalog } from './ebay-example';

export const ebayOfferId = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9_-]+$/);
const qty = z.number().int().min(0).max(2147483647);
const money = z.object({
  value: z
    .string()
    .max(30)
    .regex(/^\d+(\.\d{1,2})?$/)
    .refine((v) => {
      const [whole, fraction = ''] = v.split('.');
      const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
      return Number.isSafeInteger(cents) && cents <= 2147483647;
    }),
  currency: z.string().regex(/^[A-Z]{3}$/),
});
function canonical(v: any): any {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object')
    return Object.fromEntries(
      Object.keys(v)
        .sort()
        .map((k) => [k, canonical(v[k])]),
    );
  return v;
}
const same = (a: any, b: any) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
function resource(
  sku: string,
  inventory: any,
  offers: any[],
  marketplace: string,
  selected?: string,
  allowInactive = false,
  publication = false,
) {
  ebaySku.parse(sku);
  ensure(
    inventory && typeof inventory === 'object' && !Array.isArray(inventory),
    502,
    'Niepełne Inventory eBay',
  );
  const quantity = inventory.availability?.shipToLocationAvailability?.quantity;
  ensure(
    publication || qty.safeParse(quantity).success,
    502,
    'Brak całkowitej dostępności Inventory eBay',
  );
  ensure(!inventory.sku || inventory.sku === sku, 502, 'Inventory eBay zwróciło inne SKU');
  ensure(
    offers.length <= 250 &&
      offers.every((o) => o && typeof o === 'object' && !Array.isArray(o)) &&
      new Set(offers.map((o) => o.offerId)).size === offers.length,
    502,
    'Powtórzone oferty eBay',
  );
  for (const o of offers) {
    ensure(
      ebayOfferId.safeParse(o.offerId).success &&
        (o.status !== 'PUBLISHED' || qty.safeParse(o.availableQuantity).success),
      502,
      'Nieprawidłowe ID lub dostępność oferty eBay',
    );
    ensure(
      o.sku === sku &&
        /^EBAY_[A-Z_]{2,20}$/.test(o.marketplaceId) &&
        ['FIXED_PRICE', 'AUCTION'].includes(o.format) &&
        ['PUBLISHED', 'UNPUBLISHED'].includes(o.status),
      502,
      'Niepełna lub obca oferta eBay',
    );
  }
  const eligible = offers.filter(
    (o) =>
      o.marketplaceId === marketplace &&
      o.format === 'FIXED_PRICE' &&
      (o.status === 'PUBLISHED' || (allowInactive && !!selected)) &&
      (!selected || o.offerId === selected),
  );
  ensure(
    eligible.length === 1,
    422,
    'Wybierz jednoznaczne ID opublikowanej oferty FIXED_PRICE dla tego SKU i rynku eBay',
  );
  const o = eligible[0];
  ensure(
    qty.safeParse(quantity).success || (publication && qty.safeParse(o.availableQuantity).success),
    502,
    'Brak całkowitej dostępności eBay',
  );
  ensure(
    quantity === undefined || qty.safeParse(quantity).success,
    502,
    'Nieprawidłowa dostępność Inventory eBay',
  );
  ensure(
    money.safeParse(o.pricingSummary?.price).success,
    502,
    'Niepełna cena wybranej oferty eBay',
  );
  // Equivalent decimal formatting must not turn a successful mutation into a false conflict.
  offers = structuredClone(offers);
  for (const offer of offers)
    if (money.safeParse(offer.pricingSummary?.price).success)
      offer.pricingSummary.price.value = Number(offer.pricingSummary.price.value).toFixed(2);
  ensure(
    allowInactive ||
      (o.listing?.listingId && o.listing.listingStatus === 'ACTIVE' && !o.listing.listingOnHold),
    409,
    'Oferta eBay nie jest aktywna lub została wstrzymana',
  );
  return {
    id: sku,
    inventory: structuredClone(inventory),
    offers: structuredClone(offers).sort((a, b) => a.offerId.localeCompare(b.offerId)),
    offer_id: o.offerId,
    marketplace_id: marketplace,
    currency: o.pricingSummary.price.currency,
    regular_price: Number(o.pricingSummary.price.value).toFixed(2),
    stock_quantity: Math.min(quantity ?? o.availableQuantity, o.availableQuantity ?? quantity),
    status: o.status,
  };
}
export type EbayOfferResource = ReturnType<typeof resource> & {
  publication_context?: { offer: any; location: any };
};
export async function readEbayOffer(
  client: Ebay,
  sku: string,
  marketplace: string,
  selected?: string,
  fence = async () => {},
  allowInactive = false,
  publication = false,
) {
  ebaySku.parse(sku);
  const inventory = await client.request(
    'inventory_item/' + encodeURIComponent(sku),
    fence,
    'inventory',
  );
  const offers: any[] = [];
  let offset = 0,
    total: number | undefined;
  // All marketplaces and formats are needed: stock is a shared SKU pool, even for a price-only preview.
  for (let n = 0; n < 10; n++) {
    const p = await ebayInventoryPage(client, 'offer', 'offers', offset, { sku }, fence);
    ensure(
      total === undefined || total === p.total,
      409,
      'Zbiór ofert eBay zmienił się podczas odczytu',
    );
    total = p.total;
    offers.push(...p.rows);
    if (p.next === null) {
      ensure(offers.length === total, 409, 'Niepełny zbiór ofert eBay');
      return resource(sku, inventory, offers, marketplace, selected, allowInactive, publication);
    }
    ensure(n < 9, 422, 'Przekroczono limit ofert SKU eBay');
    offset = p.next;
  }
  throw new Error('Unreachable eBay pagination');
}
export function ebaySnapshot(r: EbayOfferResource) {
  return {
    id: r.id,
    inventory: r.inventory,
    offers: r.offers,
    offer_id: r.offer_id,
    marketplace_id: r.marketplace_id,
    currency: r.currency,
    regular_price: r.regular_price,
    stock_quantity: r.stock_quantity,
    status: r.status,
    ...(r.publication_context ? { publication_context: r.publication_context } : {}),
  };
}
export function ebayPayload(r: EbayOfferResource, quantity?: number, price?: number) {
  const selected = r.offers.find((o) => o.offerId === r.offer_id)!;
  const fields: any = { offerId: r.offer_id };
  if (quantity !== undefined) {
    qty.parse(quantity);
    ensure(
      !selected.lotSize || selected.lotSize === 1,
      422,
      'Stan oferty eBay sprzedawanej w partiach wymaga przelicznika jednostek',
    );
    const auctions = r.offers.filter((o) => o.status === 'PUBLISHED' && o.format === 'AUCTION');
    ensure(
      quantity >= auctions.reduce((s, o) => s + o.availableQuantity, 0),
      409,
      'Lokalna dostępność jest mniejsza od ilości przydzielonej aktywnym aukcjom eBay',
    );
    fields.availableQuantity = quantity;
  }
  if (price !== undefined) {
    ensure(
      Number.isSafeInteger(price) && price > 0 && price <= 2147483647,
      422,
      'Cena eBay musi być dodatnia',
    );
    fields.price = { value: (price / 100).toFixed(2), currency: r.currency };
  }
  ensure(quantity !== undefined || price !== undefined, 422, 'Wybierz cenę lub stan eBay');
  return {
    requests: [
      {
        sku: r.id,
        ...(quantity !== undefined ? { shipToLocationAvailability: { quantity } } : {}),
        offers: [fields],
      },
    ],
  };
}
export function ebayExpected(before: EbayOfferResource, payload: any) {
  const r = structuredClone(before),
    request = payload.requests[0];
  ensure(
    request.sku === r.id && request.offers.length === 1 && request.offers[0].offerId === r.offer_id,
    422,
    'Plan eBay zmienia inny zakres',
  );
  if (request.shipToLocationAvailability)
    r.inventory.availability.shipToLocationAvailability.quantity =
      request.shipToLocationAvailability.quantity;
  const o = r.offers.find((o) => o.offerId === r.offer_id)!,
    fields = request.offers[0];
  if (fields.availableQuantity !== undefined) o.availableQuantity = fields.availableQuantity;
  if (fields.price) o.pricingSummary.price = fields.price;
  r.stock_quantity = Math.min(
    r.inventory.availability.shipToLocationAvailability.quantity,
    o.availableQuantity,
  );
  r.regular_price = Number(o.pricingSummary.price.value).toFixed(2);
  return r;
}
export function ebayMatches(payload: any, r: EbayOfferResource) {
  const request = payload.requests?.[0],
    fields = request?.offers?.[0];
  if (!request || request.sku !== r.id || fields?.offerId !== r.offer_id) return false;
  const o = r.offers.find((o) => o.offerId === fields.offerId);
  return (
    !!o &&
    (!request.shipToLocationAvailability ||
      r.inventory.availability.shipToLocationAvailability.quantity ===
        request.shipToLocationAvailability.quantity) &&
    (fields.availableQuantity === undefined || o.availableQuantity === fields.availableQuantity) &&
    (!fields.price ||
      (Number(o.pricingSummary.price.value) === Number(fields.price.value) &&
        o.pricingSummary.price.currency === fields.price.currency))
  );
}
export function ebayAffectedOffers(r: EbayOfferResource, payload: any) {
  const after = ebayExpected(r, payload);
  return r.offers.map((o) => ({
    offer_id: o.offerId,
    marketplace: o.marketplaceId,
    format: o.format,
    status: o.status,
    price_changes: !!payload.requests[0].offers[0].price && o.offerId === r.offer_id,
    price_before: o.pricingSummary?.price ?? null,
    price_after: after.offers.find((x) => x.offerId === o.offerId)!.pricingSummary?.price ?? null,
    quantity_before:
      o.status !== 'PUBLISHED'
        ? null
        : Math.min(
            r.inventory.availability.shipToLocationAvailability.quantity,
            o.availableQuantity,
          ),
    quantity_after:
      o.status !== 'PUBLISHED'
        ? null
        : Math.min(
            after.inventory.availability.shipToLocationAvailability.quantity,
            after.offers.find((x) => x.offerId === o.offerId)!.availableQuantity,
          ),
  }));
}
/** A durable phase must be committed before this callback reaches POST. No mutation replay on recovery. */
export async function executeEbaySync(
  client: Ebay,
  plan: any,
  checkpoint: (phase: string) => Promise<boolean>,
  acceptObserved = false,
) {
  const before: EbayOfferResource = plan.remote_snapshot;
  let r = await readEbayOffer(
    client,
    plan.remote_id,
    before.marketplace_id,
    before.offer_id,
    undefined,
    acceptObserved || plan.phase !== 'ready',
  );
  if (acceptObserved) return r;
  const expected = ebayExpected(before, plan.payload);
  if (same(ebaySnapshot(r), ebaySnapshot(expected))) return r;
  ensure(
    plan.phase === 'ready',
    409,
    'Niepewny lub częściowy zapis eBay; uzgodnij wynik bez powtarzania POST',
  );
  ensure(
    same(ebaySnapshot(r), ebaySnapshot(before)),
    409,
    'Inventory lub oferty SKU eBay zmieniły się od podglądu',
  );
  if (
    !(await client.mutationCheckpoint('/sell/inventory/v1/bulk_update_price_quantity', 'POST', () =>
      checkpoint('write_started'),
    ))
  )
    return null;
  await client.updatePriceQuantity(plan.payload);
  if (!(await checkpoint('verify'))) return null;
  r = await readEbayOffer(
    client,
    plan.remote_id,
    before.marketplace_id,
    before.offer_id,
    undefined,
    true,
  );
  ensure(
    same(ebaySnapshot(r), ebaySnapshot(expected)),
    502,
    'eBay nie potwierdziło całego zakresu zmiany; wymagany odczyt',
  );
  return r;
}
export function simulationEbayOffer(
  ch: any,
  listing: any,
  selected?: string,
  allowInactive = false,
): EbayOfferResource {
  if (listing.last_result?.ebay_offer_snapshot) {
    const v = listing.last_result.ebay_offer_snapshot;
    const r: EbayOfferResource = resource(
      listing.external_id,
      v.inventory,
      v.offers,
      ch.settings.marketplace_id ?? 'EBAY_DE',
      selected ?? v.offer_id,
      allowInactive,
      allowInactive,
    );
    if (allowInactive && v.publication_context)
      r.publication_context = structuredClone(v.publication_context);
    return r;
  }
  const demo = demoEbayCatalog().find((x) => x.item.sku === listing.external_id);
  const inventory = demo
    ? structuredClone(demo.item)
    : {
        availability: {
          shipToLocationAvailability: { quantity: listing.last_result?.stock_quantity ?? 0 },
        },
        product: { title: 'eBay DEMO' },
      };
  const offers = demo?.offers ?? [
    {
      offerId:
        'DEMO-' + createHash('sha256').update(listing.external_id).digest('hex').slice(0, 16),
      sku: listing.external_id,
      marketplaceId: ch.settings.marketplace_id ?? 'EBAY_DE',
      format: 'FIXED_PRICE',
      status: 'PUBLISHED',
      availableQuantity: listing.last_result?.stock_quantity ?? 0,
      pricingSummary: {
        price: {
          value: (listing.price / 100).toFixed(2),
          currency: listing.price_currency ?? 'PLN',
        },
      },
      listing: { listingId: 'DEMO-listing', listingStatus: 'ACTIVE' },
    },
  ];
  return resource(
    listing.external_id,
    inventory,
    offers,
    ch.settings.marketplace_id ?? 'EBAY_DE',
    selected,
    allowInactive,
    allowInactive,
  );
}

export { resource as ebayOfferResource };
