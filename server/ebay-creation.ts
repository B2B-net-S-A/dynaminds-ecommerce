import { z } from 'zod';
import { Ebay } from './ebay';
import { ebaySku, ebayInventoryPage } from './ebay-inventory';
import { ebayOfferResource, type EbayOfferResource } from './ebay-offers';
import { ensure, Problem } from './errors';

const id = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9_-]+$/);
export const ebayCreationInput = z
  .object({
    sku: ebaySku.refine((v) => v.trim() === v && !['.', '..'].includes(v)),
    category_id: z.string().regex(/^[1-9]\d{0,14}$/),
    merchant_location_key: z
      .string()
      .min(1)
      .max(36)
      .regex(/^[^\x00-\x1f\x7f]+$/)
      .refine((v) => !['.', '..'].includes(v)),
    payment_policy_id: id,
    return_policy_id: id,
    fulfillment_policy_id: id,
    content_language: z
      .enum([
        'pl-PL',
        'de-DE',
        'en-GB',
        'en-US',
        'en-AU',
        'en-CA',
        'fr-CA',
        'fr-FR',
        'it-IT',
        'es-ES',
        'nl-NL',
        'nl-BE',
        'fr-BE',
        'de-AT',
        'de-CH',
      ])
      .default('pl-PL'),
    condition: z
      .enum([
        'NEW',
        'NEW_OTHER',
        'NEW_WITH_DEFECTS',
        'LIKE_NEW',
        'USED_EXCELLENT',
        'USED_VERY_GOOD',
        'USED_GOOD',
        'USED_ACCEPTABLE',
        'FOR_PARTS_OR_NOT_WORKING',
        'SELLER_REFURBISHED',
        'CERTIFIED_REFURBISHED',
        'EXCELLENT_REFURBISHED',
        'VERY_GOOD_REFURBISHED',
        'GOOD_REFURBISHED',
        'PRE_OWNED_EXCELLENT',
        'PRE_OWNED_FAIR',
      ])
      .default('NEW'),
    condition_description: z.string().trim().max(1000).optional(),
    reuse_inventory_plan_id: z.uuid().optional(),
    verify_settings: z.boolean().default(false),
    aspects: z
      .record(z.string().min(1).max(40), z.array(z.string().trim().min(1).max(50)).min(1).max(30))
      .refine((v) => Object.keys(v).length <= 50)
      .optional(),
  })
  .strict();
export type EbayCreationInput = z.infer<typeof ebayCreationInput>;
const tag = (plan: string) => `<!-- dynaminds-offer-plan:${plan} -->`;
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
function contains(actual: any, desired: any): boolean {
  if (Array.isArray(desired)) return Array.isArray(actual) && same(actual, desired);
  if (desired && typeof desired === 'object')
    return !!actual && Object.entries(desired).every(([k, v]) => contains(actual[k], v));
  return actual === desired;
}
const escaped = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
export function ebayDraftPayload(
  input: EbayCreationInput,
  p: any,
  quantity: number,
  currency: string,
  price: number,
  market: string,
  plan: string,
) {
  ensure(
    ['simple', 'bundle'].includes(p.kind) && p.active,
    422,
    'Nowy szkic eBay wymaga aktywnego produktu pojedynczego lub zestawu',
  );
  ensure(p.name?.trim() && p.name.length <= 80, 422, 'Tytuł eBay musi mieć od 1 do 80 znaków');
  ensure(p.description?.trim(), 422, 'Uzupełnij opis produktu przed utworzeniem szkicu eBay');
  const description = escaped(p.description).replace(/\n/g, '<br>') + tag(plan);
  ensure(description.length <= 4000, 422, 'Opis eBay z formatowaniem przekracza 4000 znaków');
  ensure(
    Array.isArray(p.images) &&
      p.images.length > 0 &&
      p.images.length <= 24 &&
      p.images.every((value: string) => {
        try {
          const u = new URL(value);
          return (
            u.protocol === 'https:' &&
            !u.username &&
            !u.password &&
            !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)
          );
        } catch {
          return false;
        }
      }),
    422,
    'eBay wymaga publicznych zdjęć HTTPS; lokalna galeria nie jest dostępna dla dostawcy',
  );
  ensure(
    Number.isSafeInteger(quantity) && quantity >= 0 && quantity <= 2147483647,
    422,
    'Nieprawidłowa ilość szkicu eBay',
  );
  ensure(
    Number.isSafeInteger(price) && price > 0 && price <= 2147483647 && /^[A-Z]{3}$/.test(currency),
    422,
    'Szkic eBay wymaga dodatniej ceny i waluty cennika',
  );
  const aspects =
    input.aspects ??
    Object.fromEntries(Object.entries(p.attributes ?? {}).map(([k, v]) => [k, [String(v)]]));
  ensure(
    Object.keys(aspects).length <= 50 &&
      Object.entries(aspects).every(([k, v]) => k.length <= 40 && v.every((x) => x.length <= 50)),
    422,
    'Parametry eBay: maksymalnie 50, nazwa do 40 i wartość do 50 znaków',
  );
  const inventory = {
    availability: { shipToLocationAvailability: { quantity } },
    condition: input.condition,
    ...(input.condition_description ? { conditionDescription: input.condition_description } : {}),
    product: {
      title: p.name,
      description,
      imageUrls: p.images,
      aspects,
      ...(p.ean ? { ean: [p.ean] } : {}),
    },
  };
  return {
    ebay_draft: true,
    sku: input.sku,
    content_language: input.content_language,
    plan_marker: plan,
    inventory,
    offer: {
      sku: input.sku,
      marketplaceId: market,
      format: 'FIXED_PRICE',
      categoryId: input.category_id,
      availableQuantity: quantity,
      merchantLocationKey: input.merchant_location_key,
      listingDuration: 'GTC',
      listingDescription: description,
      includeCatalogProductDetails: false,
      listingPolicies: {
        paymentPolicyId: input.payment_policy_id,
        returnPolicyId: input.return_policy_id,
        fulfillmentPolicyId: input.fulfillment_policy_id,
      },
      pricingSummary: { price: { value: (price / 100).toFixed(2), currency } },
    },
  };
}
async function optionalInventory(client: Ebay, sku: string, fence: () => Promise<void>) {
  try {
    return await client.request('inventory_item/' + encodeURIComponent(sku), fence, 'inventory');
  } catch (e) {
    if (e instanceof Problem && e.status === 404) return null;
    throw e;
  }
}
export async function readEbayDraftState(
  client: Ebay,
  sku: string,
  locationKey: string,
  fence = async () => {},
) {
  const inventory = await optionalInventory(client, sku, fence),
    offers: any[] = [];
  let offset = 0,
    total: number | undefined;
  for (let n = 0; n < 10; n++) {
    let page;
    try {
      page = await ebayInventoryPage(client, 'offer', 'offers', offset, { sku }, fence);
    } catch (e) {
      if (n === 0 && e instanceof Problem && e.status === 404) {
        total = 0;
        break;
      }
      throw e;
    }
    ensure(
      total === undefined || total === page.total,
      409,
      'Zbiór ofert eBay zmienił się podczas odczytu',
    );
    total = page.total;
    offers.push(...page.rows);
    ensure(offers.length <= 250, 422, 'Przekroczono limit ofert SKU eBay');
    if (page.next === null) {
      ensure(offers.length === total, 409, 'Niepełny zbiór ofert SKU eBay');
      break;
    }
    ensure(n < 9, 422, 'Przekroczono limit stron ofert SKU eBay');
    offset = page.next;
  }
  ensure(
    new Set(offers.map((o) => o.offerId)).size === offers.length &&
      offers.every((o) => id.safeParse(o.offerId).success && o.sku === sku),
    502,
    'Nieprawidłowe lub obce oferty SKU eBay',
  );
  ensure(
    !inventory || !inventory.sku || inventory.sku === sku,
    502,
    'Inventory eBay zwróciło inne SKU',
  );
  const location = await client.request(
    'location/' + encodeURIComponent(locationKey),
    fence,
    'inventory',
  );
  ensure(
    !location.merchantLocationKey || location.merchantLocationKey === locationKey,
    502,
    'eBay zwróciło inną lokalizację',
  );
  return { inventory, offers, location };
}
export function ebayDraftPreflight(state: any, previous?: any) {
  const address = state.location?.location?.address;
  ensure(
    state.location?.merchantLocationStatus === 'ENABLED' &&
      address?.country &&
      (address.postalCode || (address.city && address.stateOrProvince)),
    422,
    'Wybierz włączoną lokalizację eBay z kompletnym adresem',
  );
  ensure(state.offers.length === 0, 409, 'SKU ma już ofertę eBay; wybierz istniejące powiązanie');
  if (previous) {
    ensure(
      previous.state === 'done' &&
        previous.operation === 'create_draft' &&
        previous.result?.retained_inventory === true,
      409,
      'Najpierw zamknij niepewny poprzedni wynik przez odczyt',
    );
    ensure(
      ebayOwnedInventory(state.inventory, previous.payload),
      409,
      'Zachowany Inventory nie odpowiada poprzedniemu planowi',
    );
  } else
    ensure(!state.inventory, 409, 'SKU Inventory już istnieje; nie nadpisujemy obcego rekordu');
}
export function ebayOwnedInventory(inventory: any, payload: any) {
  return (
    !!inventory?.product?.description?.includes(tag(payload.plan_marker)) &&
    contains(inventory, payload.inventory) &&
    !inventory.inventoryItemGroupKeys?.length &&
    !inventory.groupIds?.length
  );
}
function offerMatches(offer: any, payload: any) {
  const expected = structuredClone(payload.offer);
  // Decimal representation is not a business change.
  const actual = structuredClone(offer);
  if (actual?.pricingSummary?.price)
    actual.pricingSummary.price.value = Number(actual.pricingSummary.price.value).toFixed(2);
  return (
    actual?.status === 'UNPUBLISHED' &&
    !actual.listing &&
    actual.listingDescription?.includes(tag(payload.plan_marker)) &&
    contains(actual, expected)
  );
}
export function ebayCreatedMatches(plan: any, r: any) {
  return (
    !r._no_resource &&
    !r._skip_mapping &&
    ebayOwnedInventory(r.inventory, plan.payload) &&
    r.offers?.length === 1 &&
    offerMatches(r.offers[0], plan.payload) &&
    offerMatches(r.publication_context?.offer, plan.payload)
  );
}
async function observedResource(client: Ebay, plan: any, state: any): Promise<any> {
  const payload = plan.payload;
  if (state.offers.length === 1) {
    const summary = state.offers[0],
      offer = await client.request(
        'offer/' + encodeURIComponent(summary.offerId),
        undefined,
        'inventory',
      );
    ensure(
      offer.sku === payload.sku && (!offer.offerId || offer.offerId === summary.offerId),
      502,
      'Szczegóły eBay wskazują inne SKU lub ofertę',
    );
    if (
      state.inventory &&
      offerMatches(summary, payload) &&
      offerMatches(offer, payload) &&
      ebayOwnedInventory(state.inventory, payload)
    ) {
      const r: EbayOfferResource = ebayOfferResource(
        payload.sku,
        state.inventory,
        state.offers,
        payload.offer.marketplaceId,
        summary.offerId,
        true,
        true,
      );
      r.publication_context = { offer, location: state.location };
      return r;
    }
    return {
      id: payload.sku,
      inventory: state.inventory,
      offers: state.offers,
      offer_id: summary.offerId,
      marketplace_id: payload.offer.marketplaceId,
      status: summary.status,
      publication_context: { offer, location: state.location },
      _skip_mapping: true,
    };
  }
  return {
    id: payload.sku,
    inventory: state.inventory,
    offers: state.offers,
    marketplace_id: payload.offer.marketplaceId,
    status: state.offers.length
      ? 'UNCONFIRMED_OFFERS'
      : state.inventory
        ? 'INVENTORY_ONLY'
        : 'ABSENT',
    _skip_mapping: true,
    _no_resource: !state.inventory && !state.offers.length,
  };
}
export async function executeEbayCreation(
  client: Ebay,
  plan: any,
  checkpoint: (step: string, offerId?: string) => Promise<boolean>,
  acceptObserved = false,
  validateSettings?: () => Promise<void>,
) {
  const payload = plan.payload,
    steps = plan.result?.ebay_creation_steps ?? {};
  let state = await readEbayDraftState(client, payload.sku, payload.offer.merchantLocationKey);
  if (acceptObserved) return observedResource(client, plan, state);
  if (steps.offer_started) {
    const r = await observedResource(client, plan, state);
    ensure(
      ebayCreatedMatches(plan, r) && (!steps.offer_id || r.offer_id === steps.offer_id),
      409,
      'Niepewny wynik utworzenia szkicu eBay; uzgodnij przez odczyt bez ponawiania POST',
    );
    return r;
  }
  if (!steps.inventory_started) {
    ensure(
      plan.phase === 'ready' && same(state, plan.remote_snapshot.ebay_creation_context),
      409,
      'SKU lub lokalizacja eBay zmieniły się od podglądu',
    );
    ensure(state.offers.length === 0, 409, 'SKU ma już ofertę eBay');
    await validateSettings?.();
    if (
      !(await client.mutationCheckpoint(
        '/sell/inventory/v1/inventory_item/' + encodeURIComponent(payload.sku),
        'PUT',
        () => checkpoint('inventory_started'),
      ))
    )
      return null;
    await client.createInventory(payload.sku, payload.inventory, payload.content_language);
    state = await readEbayDraftState(client, payload.sku, payload.offer.merchantLocationKey);
  }
  ensure(
    ebayOwnedInventory(state.inventory, payload) && !state.offers.length,
    409,
    'Inventory nie potwierdza planu; uzgodnij przez odczyt bez ponawiania PUT',
  );
  ensure(
    same(state.location, plan.remote_snapshot.ebay_creation_context.location),
    409,
    'Lokalizacja eBay zmieniła się przed utworzeniem oferty',
  );
  if (!(await checkpoint('inventory_verified'))) return null;
  await validateSettings?.();
  if (
    !(await client.mutationCheckpoint('/sell/inventory/v1/offer', 'POST', () =>
      checkpoint('offer_started'),
    ))
  )
    return null;
  const result = await client.createOffer(payload.offer, payload.content_language);
  if (!(await checkpoint('offer_verified', result.offerId))) return null;
  state = await readEbayDraftState(client, payload.sku, payload.offer.merchantLocationKey);
  const r = await observedResource(client, plan, state);
  ensure(
    ebayCreatedMatches(plan, r) && r.offer_id === result.offerId,
    502,
    'eBay nie potwierdziło całego szkicu; wymagany odczyt',
  );
  return r;
}
export function simulationEbayCreation(plan: any) {
  const payload = plan.payload,
    offer = {
      ...structuredClone(payload.offer),
      offerId: 'DEMO-' + plan.id,
      status: 'UNPUBLISHED',
    };
  const r: EbayOfferResource = ebayOfferResource(
    payload.sku,
    structuredClone(payload.inventory),
    [offer],
    payload.offer.marketplaceId,
    offer.offerId,
    true,
    true,
  );
  r.publication_context = {
    offer,
    location: structuredClone(plan.remote_snapshot.ebay_creation_context.location),
  };
  return r;
}
