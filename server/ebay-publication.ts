import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { Ebay, requireEbayWrite } from './ebay';
import { ensure } from './errors';
import { readEbayOffer, ebaySnapshot, type EbayOfferResource } from './ebay-offers';

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
export async function requireEbayPublication(
  c: PoolClient,
  ch: any,
  expected?: string,
  writing = false,
  checkScope = true,
) {
  ensure(
    ch.settings.simulation || ch.settings.inventory_access === 'orders_inventory_write',
    422,
    'Włącz zapis Inventory eBay',
  );
  if (checkScope) requireEbayWrite(ch);
  const b = (
    await c.query(
      'SELECT account_hash,mode,source FROM ebay_account_bindings WHERE channel_id=$1',
      [ch.id],
    )
  ).rows[0];
  ensure(
    b && b.mode === ch.mode && b.source === (ch.settings.simulation ? 'simulation' : 'trading'),
    409,
    'Najpierw sprawdź tożsamość konta eBay',
  );
  ensure(
    !expected || b.account_hash === expected,
    409,
    'Tożsamość konta eBay zmieniła się od podglądu',
  );
  if (writing)
    ensure(
      !(
        await c.query(
          'SELECT 1 FROM oauth_states WHERE channel_id=$1 AND consumed_at IS NULL AND expires_at>now()',
          [ch.id],
        )
      ).rowCount,
      409,
      'Dokończ lub anuluj rozpoczętą zgodę OAuth eBay',
    );
  return b.account_hash as string;
}
// These checks cover common fixed-price requirements. Category-specific requirements remain eBay's decision.
export function ebayPublicationReadiness(r: EbayOfferResource) {
  const o = r.publication_context?.offer,
    location = r.publication_context?.location;
  ensure(o && location, 422, 'Brak szczegółów szkicu i lokalizacji eBay');
  ensure(
    !r.inventory.inventoryItemGroupKeys?.length && !r.inventory.groupIds?.length,
    422,
    'Grupa wariantów eBay wymaga publikacji całej grupy',
  );
  const missing: string[] = [],
    p = r.inventory.product ?? {},
    a = location.location?.address;
  for (const k of ['title', 'description'])
    if (typeof p[k] !== 'string' || !p[k].trim()) missing.push('product.' + k);
  if (!r.inventory.condition) missing.push('condition');
  if (
    !Array.isArray(p.imageUrls) ||
    !p.imageUrls.length ||
    p.imageUrls.some((x: any) => typeof x !== 'string' || !/^https?:\/\//.test(x))
  )
    missing.push('product.imageUrls');
  for (const k of ['categoryId', 'merchantLocationKey', 'listingDuration'])
    if (typeof o[k] !== 'string' || !o[k].trim()) missing.push(k);
  for (const k of ['paymentPolicyId', 'returnPolicyId', 'fulfillmentPolicyId'])
    if (typeof o.listingPolicies?.[k] !== 'string' || !o.listingPolicies[k].trim())
      missing.push('listingPolicies.' + k);
  if (!(Number(o.pricingSummary?.price?.value) > 0)) missing.push('pricingSummary.price');
  if (
    o.availableQuantity !== undefined &&
    (!Number.isSafeInteger(o.availableQuantity) || o.availableQuantity < 0)
  )
    missing.push('availableQuantity');
  if (
    location.merchantLocationStatus !== 'ENABLED' ||
    !a?.country ||
    !(a.postalCode || (a.city && a.stateOrProvince))
  )
    missing.push('location.address/status');
  ensure(!missing.length, 422, 'Uzupełnij szkic eBay przed publikacją: ' + missing.join(', '));
  ensure(
    o.sku === r.id &&
      o.marketplaceId === r.marketplace_id &&
      o.format === 'FIXED_PRICE' &&
      (!o.offerId || o.offerId === r.offer_id),
    502,
    'Szczegóły eBay wskazują inną ofertę',
  );
  ensure(
    !location.merchantLocationKey || location.merchantLocationKey === o.merchantLocationKey,
    502,
    'eBay zwróciło inną lokalizację',
  );
  return {
    offer_id: r.offer_id,
    sku: r.id,
    marketplace: r.marketplace_id,
    status: r.status,
    title: p.title,
    description: o.listingDescription ?? p.description,
    condition: r.inventory.condition,
    image_urls: p.imageUrls,
    category_id: o.categoryId,
    price: o.pricingSummary.price,
    quantity: r.stock_quantity,
    merchant_location_key: o.merchantLocationKey,
    listing_policies: o.listingPolicies,
    listing_duration: o.listingDuration,
  };
}
export async function readEbayPublication(
  client: Ebay,
  sku: string,
  market: string,
  selected: string,
  fence = async () => {},
  observing = false,
) {
  const r: EbayOfferResource = await readEbayOffer(
    client,
    sku,
    market,
    selected,
    fence,
    true,
    true,
  );
  const offer = await client.request('offer/' + encodeURIComponent(selected), fence, 'inventory');
  ensure(
    offer.sku === sku &&
      offer.marketplaceId === market &&
      offer.format === 'FIXED_PRICE' &&
      (!offer.offerId || offer.offerId === selected),
    502,
    'Szczegóły eBay wskazują inną ofertę',
  );
  const hasLocation =
    typeof offer.merchantLocationKey === 'string' &&
    offer.merchantLocationKey.length > 0 &&
    offer.merchantLocationKey.length <= 36 &&
    !['.', '..'].includes(offer.merchantLocationKey);
  ensure(observing || hasLocation, 422, 'Uzupełnij merchantLocationKey w szkicu eBay');
  const location = hasLocation
    ? await client.request(
        'location/' + encodeURIComponent(offer.merchantLocationKey),
        fence,
        'inventory',
      )
    : null;
  const summary = r.offers.find((x) => x.offerId === selected)!;
  // getOffers and getOffer can expose different optional fields, but shared fields must agree.
  for (const k of [
    'sku',
    'marketplaceId',
    'format',
    'status',
    'availableQuantity',
    'pricingSummary',
    'listing',
    'listingPolicies',
    'merchantLocationKey',
    'categoryId',
    'listingDuration',
  ])
    if (summary[k] !== undefined && offer[k] !== undefined)
      ensure(
        k === 'pricingSummary'
          ? Number(summary[k].price?.value) === Number(offer[k].price?.value) &&
              summary[k].price?.currency === offer[k].price?.currency
          : same(summary[k], offer[k]),
        409,
        'Szkic eBay zmienił się podczas odczytu: ' + k,
      );
  if (offer.pricingSummary?.price)
    offer.pricingSummary.price.value = Number(offer.pricingSummary.price.value).toFixed(2);
  r.publication_context = { offer, location };
  if (!observing) ebayPublicationReadiness(r);
  return r;
}
export function ebayPublicationMatches(r: EbayOfferResource) {
  const o = r.offers.find((x) => x.offerId === r.offer_id),
    detail = r.publication_context?.offer;
  return (
    r.status === 'PUBLISHED' &&
    o?.listing?.listingStatus === 'ACTIVE' &&
    /^[A-Za-z0-9_-]{1,160}$/.test(o.listing.listingId ?? '') &&
    !o.listing.listingOnHold &&
    detail?.status === 'PUBLISHED' &&
    detail.listing?.listingId === o.listing.listingId
  );
}
function publicationContent(r: EbayOfferResource) {
  const s = structuredClone(ebaySnapshot(r));
  s.status = 'UNPUBLISHED';
  const o = s.offers.find((x) => x.offerId === s.offer_id)!;
  o.status = 'UNPUBLISHED';
  delete o.listing;
  if (s.publication_context) {
    s.publication_context.offer.status = 'UNPUBLISHED';
    delete s.publication_context.offer.listing;
  }
  return s;
}
export function simulationEbayPublication(r: EbayOfferResource) {
  ebayPublicationReadiness(r);
  const next = structuredClone(r),
    o = next.offers.find((x) => x.offerId === next.offer_id)!;
  next.status = o.status = 'PUBLISHED';
  o.listing = {
    listingId: 'DEMO-' + createHash('sha256').update(next.offer_id).digest('hex').slice(0, 16),
    listingStatus: 'ACTIVE',
  };
  next.publication_context!.offer.status = 'PUBLISHED';
  next.publication_context!.offer.listing = structuredClone(o.listing);
  return next;
}
export async function executeEbayPublication(
  client: Ebay,
  plan: any,
  checkpoint: (phase: string) => Promise<boolean>,
  acceptObserved = false,
) {
  const before: EbayOfferResource = plan.remote_snapshot;
  let r = await readEbayPublication(
    client,
    plan.remote_id,
    before.marketplace_id,
    before.offer_id,
    undefined,
    acceptObserved || plan.phase !== 'ready',
  );
  if (acceptObserved) return r;
  const matches = () =>
    ebayPublicationMatches(r) && same(publicationContent(r), publicationContent(before));
  if (matches()) return r;
  ensure(
    plan.phase === 'ready',
    409,
    'Niepewny wynik publikacji eBay; uzgodnij odczytem bez ponawiania POST',
  );
  ensure(
    r.status === 'UNPUBLISHED' && same(ebaySnapshot(r), ebaySnapshot(before)),
    409,
    'Szkic eBay zmienił się od podglądu',
  );
  if (
    !(await client.mutationCheckpoint(
      '/sell/inventory/v1/offer/' + encodeURIComponent(before.offer_id) + '/publish',
      'POST',
      () => checkpoint('write_started'),
    ))
  )
    return null;
  const published = await client.publishOffer(before.offer_id);
  if (!(await checkpoint('verify'))) return null;
  r = await readEbayPublication(
    client,
    plan.remote_id,
    before.marketplace_id,
    before.offer_id,
    undefined,
    true,
  );
  ensure(
    matches() && r.publication_context!.offer.listing.listingId === published.listingId,
    502,
    'eBay nie potwierdziło całej publikacji; wymagany odczyt',
  );
  return r;
}
