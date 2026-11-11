import { z } from 'zod';
import { Amazon, AMAZON_MARKETS, amazonSettings } from './amazon';
import { amazonSku, amazonCatalogHash } from './amazon-catalog';
import { ensure, Problem } from './errors';
export const AMAZON_OFFER_DATA =
  'summaries,attributes,offers,fulfillmentAvailability,relationships,issues';
export const amazonOfferIdentity = (ch: any) => {
  const { listing_write: _write, ...settings } = ch.settings;
  return amazonCatalogHash({ mode: ch.mode, settings, credentials: ch.credentials });
};
export function requireAmazonWrite(ch: any) {
  ensure(ch.provider === 'amazon', 422, 'Wymagany kanał Amazon');
  if (!ch.settings.simulation) {
    ensure(
      ch.settings.listing_write === true,
      422,
      'Włącz zapis ofert Amazon w konfiguracji połączenia',
    );
    ensure(
      amazonSettings.parse(ch.settings).selling_partner_id,
      422,
      'Uzupełnij identyfikator sprzedawcy Amazon',
    );
  }
}
function minor(value: unknown) {
  const s = typeof value === 'number' ? String(value) : value;
  ensure(
    typeof s === 'string' && /^\d{1,10}(\.\d{1,2})?$/.test(s),
    502,
    'Nieprawidłowa cena Amazon',
  );
  const [a, b = ''] = s.split('.');
  return Number(a) * 100 + Number(b.padEnd(2, '0'));
}
export function amazonOfferSnapshot(raw: any, marketplace: string, stores = [marketplace]) {
  amazonSku.parse(raw?.sku);
  ensure(
    raw.attributes && typeof raw.attributes === 'object' && !Array.isArray(raw.attributes),
    502,
    'Brak atrybutów oferty Amazon',
  );
  const summaries = z
    .array(
      z
        .object({ marketplaceId: z.string(), productType: z.string().min(1).max(200) })
        .passthrough(),
    )
    .min(1)
    .max(30)
    .parse(raw.summaries);
  const selected = summaries.filter((s) => s.marketplaceId === marketplace);
  ensure(selected.length === 1, 502, 'Brak jednoznacznej oferty Amazon na wybranym rynku');
  ensure(
    !raw.relationships?.some((g: any) => g.relationships?.some((r: any) => r.childSkus?.length)),
    422,
    'Grupa Amazon nie ma własnego stanu ani ceny sprzedaży',
  );
  const prices = (raw.attributes.purchasable_offer ?? []).filter(
    (p: any) => p.marketplace_id === marketplace && (!p.audience || p.audience === 'ALL'),
  );
  ensure(prices.length <= 1, 502, 'Niejednoznaczna cena podstawowa Amazon');
  const base = prices[0];
  let basePrice: number | null = null;
  // Only an undated base schedule is a single deterministic price. Timed price schedules require separate planning.
  if (base?.our_price?.length === 1 && base.our_price[0].schedule?.length === 1) {
    const schedule = base.our_price[0].schedule[0];
    if (!schedule.start_at && !schedule.end_at) basePrice = minor(schedule.value_with_tax);
  }
  const offers = (raw.offers ?? []).filter(
    (o: any) =>
      o.marketplaceId === marketplace &&
      o.offerType === 'B2C' &&
      (!o.audience || o.audience.value === 'ALL'),
  );
  ensure(offers.length <= 1, 502, 'Niejednoznaczna aktualna cena B2C Amazon');
  const availability = z
    .array(
      z
        .object({
          fulfillmentChannelCode: z.string(),
          quantity: z.number().int().min(0).max(2147483647).optional(),
        })
        .passthrough(),
    )
    .max(30)
    .parse(raw.fulfillmentAvailability ?? []);
  const fbm = availability.filter((a) => a.fulfillmentChannelCode === 'DEFAULT');
  ensure(fbm.length <= 1, 502, 'Niejednoznaczny stan FBM Amazon');
  return {
    id: raw.sku,
    sku: raw.sku,
    marketplace_id: marketplace,
    product_type: selected[0].productType,
    currency: base?.currency ?? offers[0]?.price?.currencyCode ?? null,
    regular_price: basePrice === null ? null : (basePrice / 100).toFixed(2),
    base_price_minor: basePrice,
    current_b2c_price_minor: offers[0] ? minor(offers[0].price?.amount) : null,
    current_b2c_currency: offers[0]?.price?.currencyCode ?? null,
    stock_quantity: fbm[0]?.quantity ?? null,
    regional_markets: [...stores].sort(),
    listing_markets: summaries.map((s) => s.marketplaceId).sort(),
    attributes: raw.attributes,
    offers: raw.offers ?? [],
    fulfillmentAvailability: availability,
    relationships: raw.relationships ?? [],
    // The snapshot excludes mutable timestamps and unrelated processing issues.
  };
}
export async function readAmazonOffer(
  client: Amazon,
  sku: string,
  stock: boolean,
  fence?: () => Promise<void>,
) {
  amazonSku.parse(sku);
  const s = client.settings;
  ensure(s.selling_partner_id, 422, 'Uzupełnij identyfikator sprzedawcy Amazon');
  let stores = [s.marketplace_id];
  if (stock) {
    const p = await client.read('/sellers/v1/marketplaceParticipations', {}, fence);
    const payload = z
      .array(
        z.object({
          marketplace: z.object({ id: z.string() }),
          participation: z.object({
            isParticipating: z.boolean(),
            hasSuspendedListings: z.boolean(),
          }),
        }),
      )
      .min(1)
      .max(40)
      .parse(p.payload);
    ensure(
      payload.every((p) => AMAZON_MARKETS[p.marketplace.id]),
      422,
      'Konto ma nieobsługiwany rynek Amazon; sprawdź zakres wspólnego stanu',
    );
    stores = payload
      .filter(
        (p) => AMAZON_MARKETS[p.marketplace.id] === s.region && p.participation.isParticipating,
      )
      .map((p) => p.marketplace.id)
      .sort();
    ensure(
      stores.includes(s.marketplace_id) &&
        stores.length <= 20 &&
        new Set(stores).size === stores.length,
      422,
      'Nieprawidłowy zakres regionalnego konta Amazon',
    );
    ensure(
      !payload.some(
        (p) => p.marketplace.id === s.marketplace_id && p.participation.hasSuspendedListings,
      ),
      409,
      'Wybrany rynek Amazon ma zawieszone oferty',
    );
  }
  const raw = await client.read(
    `/listings/2021-08-01/items/${s.selling_partner_id}/${encodeURIComponent(sku)}`,
    { marketplaceIds: stores.join(','), includedData: AMAZON_OFFER_DATA },
    fence,
  );
  ensure(raw.sku === sku, 502, 'Amazon zwrócił inne SKU');
  return amazonOfferSnapshot(raw, s.marketplace_id, stores);
}
export function amazonOfferPayload(r: any, quantity?: number, amount?: number) {
  const patches: any[] = [];
  if (quantity !== undefined) {
    ensure(
      (r.attributes.fulfillment_availability ?? []).filter(
        (a: any) => a.fulfillment_channel_code === 'DEFAULT',
      ).length === 1,
      422,
      'Brak jednoznacznego atrybutu DEFAULT Amazon',
    );
    ensure(
      r.stock_quantity !== null,
      422,
      'Oferta nie ma dostępności FBM DEFAULT; zmiana sposobu realizacji wymaga osobnego procesu',
    );
    patches.push({
      op: 'merge',
      path: '/attributes/fulfillment_availability',
      value: [
        {
          fulfillment_channel_code: 'DEFAULT',
          quantity: z.number().int().min(0).max(2147483647).parse(quantity),
        },
      ],
    });
  }
  if (amount !== undefined) {
    ensure(
      r.base_price_minor !== null && ['PLN', 'EUR', 'USD', 'GBP', 'CZK'].includes(r.currency),
      422,
      'Brak jednoznacznej ceny podstawowej lub obsługiwanej waluty Amazon',
    );
    ensure(
      z.number().int().positive().max(999999999999).safeParse(amount).success,
      422,
      'Cena Amazon musi być dodatnia',
    );
    patches.push({
      op: 'merge',
      path: '/attributes/purchasable_offer',
      value: [
        {
          marketplace_id: r.marketplace_id,
          currency: r.currency,
          audience: 'ALL',
          our_price: [{ schedule: [{ value_with_tax: amount / 100 }] }],
        },
      ],
    });
  }
  ensure(patches.length > 0, 422, 'Wybierz cenę lub stan');
  return { productType: r.product_type, patches };
}
export function amazonOfferMatches(r: any, payload: any) {
  return (
    r.product_type === payload.productType &&
    payload.patches.every((p: any) =>
      p.path === '/attributes/fulfillment_availability'
        ? r.stock_quantity === p.value[0].quantity &&
          (r.attributes.fulfillment_availability ?? []).some(
            (a: any) =>
              a.fulfillment_channel_code === 'DEFAULT' && a.quantity === p.value[0].quantity,
          )
        : r.marketplace_id === p.value[0].marketplace_id &&
          r.currency === p.value[0].currency &&
          r.base_price_minor ===
            Math.round(p.value[0].our_price[0].schedule[0].value_with_tax * 100),
    )
  );
}
export function amazonPreserved(r: any, payload: any) {
  const attrs = structuredClone(r.attributes);
  for (const a of attrs.purchasable_offer ?? []) a.audience ??= 'ALL';
  for (const p of payload.patches) {
    if (p.path === '/attributes/fulfillment_availability') {
      for (const a of attrs.fulfillment_availability ?? [])
        if (a.fulfillment_channel_code === 'DEFAULT') delete a.quantity;
    } else
      for (const a of attrs.purchasable_offer ?? [])
        if (
          a.marketplace_id === r.marketplace_id &&
          (!a.audience || a.audience === 'ALL') &&
          a.currency === r.currency
        )
          delete a.our_price;
  }
  return amazonCatalogHash({
    attrs,
    product_type: r.product_type,
    sku: r.sku,
    regional_markets: r.regional_markets,
    listing_markets: r.listing_markets,
  });
}
export function simulationAmazonOffer(ch: any, listing: any) {
  if (listing.last_result?.amazon_offer_snapshot)
    return structuredClone(listing.last_result.amazon_offer_snapshot);
  const s = listing.last_result?.amazon ?? {};
  const market = ch.settings.marketplace_id ?? 'A1C3SOZRARQ6R3';
  const currency = listing.price_currency ?? 'PLN';
  const quantity =
    s.availability?.find((a: any) => a.fulfillmentChannelCode === 'DEFAULT')?.quantity ?? 8;
  const attributes = {
    ...s.attributes,
    purchasable_offer: [
      {
        marketplace_id: market,
        currency,
        audience: 'ALL',
        our_price: [{ schedule: [{ value_with_tax: (listing.price ?? 12345) / 100 }] }],
      },
    ],
    fulfillment_availability: [
      { fulfillment_channel_code: 'DEFAULT', quantity, lead_time_to_ship_max_days: 2 },
    ],
  };
  return amazonOfferSnapshot(
    {
      sku: listing.external_id,
      summaries: [{ marketplaceId: market, productType: s.product_type ?? 'PRODUCT' }],
      attributes,
      offers: [
        {
          marketplaceId: market,
          offerType: 'B2C',
          price: { currencyCode: currency, amount: ((listing.price ?? 12345) / 100).toFixed(2) },
        },
      ],
      fulfillmentAvailability: [{ fulfillmentChannelCode: 'DEFAULT', quantity }],
    },
    market,
  );
}
export function simulationAmazonPatch(before: any, payload: any) {
  const r = structuredClone(before);
  for (const p of payload.patches) {
    const value = p.value[0];
    if (p.path === '/attributes/fulfillment_availability') {
      r.stock_quantity = value.quantity;
      r.fulfillmentAvailability.find((a: any) => a.fulfillmentChannelCode === 'DEFAULT').quantity =
        value.quantity;
      r.attributes.fulfillment_availability.find(
        (a: any) => a.fulfillment_channel_code === 'DEFAULT',
      ).quantity = value.quantity;
    } else {
      const base = r.attributes.purchasable_offer.find(
        (a: any) => a.marketplace_id === r.marketplace_id && (!a.audience || a.audience === 'ALL'),
      );
      base.our_price = value.our_price;
      r.base_price_minor = Math.round(value.our_price[0].schedule[0].value_with_tax * 100);
      r.regular_price = (r.base_price_minor / 100).toFixed(2);
      // Demonstration has no promotion or automatic pricing.
      r.current_b2c_price_minor = r.base_price_minor;
      r.offers.find(
        (o: any) => o.marketplaceId === r.marketplace_id && o.offerType === 'B2C',
      ).price.amount = r.regular_price;
    }
  }
  return r;
}
export class AmazonOfferWait extends Problem {
  constructor(public readonly until: string) {
    super(429, 'Amazon przetwarza zmianę; oczekujemy na odczyt ceny i dostępności');
  }
}
