/** Pure ranking of comparable offer totals. No provider, clock, database or price write. */
export type CompetitorOffer = {
  offerId: string;
  productId: string;
  sellerId: string;
  currency: string;
  grossPriceMinor: bigint;
  deliveryGrossMinor: bigint;
  observedAtMs: number;
  available: boolean;
};
export type CompetitorRankingInput = {
  productId: string;
  currency: string;
  ownSellerId: string;
  ownDeliveryGrossMinor: bigint;
  undercutGrossMinor: bigint;
  /** Rank counts offers, not distinct sellers. Each offer must have a unique stable ID. */
  rank: number;
  nowMs: number;
  maxAgeMs: number;
  offers: readonly CompetitorOffer[];
};
export type ExclusionReason = 'other_product' | 'own_seller' | 'unavailable' |
  'other_currency' | 'future_observation' | 'stale_observation';
export type RankedCompetitorOffer = CompetitorOffer & { totalGrossMinor: bigint; rank: number };
export type CompetitorRankingResult = {
  basis: Omit<CompetitorRankingInput, 'offers'>;
  rankedOffers: readonly RankedCompetitorOffer[];
  excludedOffers: readonly { offer: CompetitorOffer; reason: ExclusionReason }[];
} & ({ state: 'ready'; reason: null; selected: RankedCompetitorOffer; targetGrossMinor: bigint } |
  { state: 'blocked'; reason: 'insufficient_offers' | 'target_below_zero' | 'target_above_price_bound';
    selected: RankedCompetitorOffer | null; targetGrossMinor: null });

// Existing price-list/repricing amount bound. Total price+delivery may exceed it;
// the resulting product price still must fit the native writer's amount domain.
const maximumPriceMinor = 100000000n;
const maximumAgeMs = 10080 * 60000;
const maximumOffers = 1000;
function requireInput(condition: boolean): asserts condition {
  if (!condition) throw new Error('Niepoprawne jawne dane rankingu konkurencji.');
}
function identifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200 && value.trim() === value;
}
function currency(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Z]{3}$/.test(value);
}
function money(value: unknown): value is bigint {
  return typeof value === 'bigint' && value >= 0n && value <= maximumPriceMinor;
}
function instant(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 8640000000000000;
}
const compareText = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

/**
 * Select gross product+delivery at rank N, then subtract undercut and the seller's
 * explicit delivery basis. A ready target is only a competitor input: integration
 * MUST retain native cost/margin, min/max, direction and price-ending validation,
 * source/version/IAM fences, frozen preview and separate consent before any write.
 */
export function rankCompetitorOffers(input: CompetitorRankingInput): CompetitorRankingResult {
  requireInput(Boolean(input) && typeof input === 'object' && !Array.isArray(input));
  requireInput(identifier(input.productId) && identifier(input.ownSellerId) && currency(input.currency));
  requireInput(money(input.ownDeliveryGrossMinor) && money(input.undercutGrossMinor));
  requireInput(Number.isSafeInteger(input.rank) && input.rank >= 1 && input.rank <= maximumOffers);
  requireInput(instant(input.nowMs) && Number.isSafeInteger(input.maxAgeMs) && input.maxAgeMs >= 1 && input.maxAgeMs <= maximumAgeMs);
  requireInput(Array.isArray(input.offers) && input.offers.length <= maximumOffers);
  const basis = { productId: input.productId, currency: input.currency, ownSellerId: input.ownSellerId,
    ownDeliveryGrossMinor: input.ownDeliveryGrossMinor, undercutGrossMinor: input.undercutGrossMinor,
    rank: input.rank, nowMs: input.nowMs, maxAgeMs: input.maxAgeMs };
  const eligible: Omit<RankedCompetitorOffer, 'rank'>[] = [];
  const excludedOffers: { offer: CompetitorOffer; reason: ExclusionReason }[] = [];
  const seen = new Set<string>();
  for (const value of input.offers) {
    requireInput(Boolean(value) && typeof value === 'object' && !Array.isArray(value));
    requireInput(identifier(value.offerId) && identifier(value.productId) && identifier(value.sellerId) && currency(value.currency));
    requireInput(money(value.grossPriceMinor) && money(value.deliveryGrossMinor) && instant(value.observedAtMs) && typeof value.available === 'boolean');
    requireInput(!seen.has(value.offerId)); seen.add(value.offerId);
    // Copy only the public mathematical inputs; do not retain mutable input aliases.
    const offer: CompetitorOffer = { offerId: value.offerId, productId: value.productId, sellerId: value.sellerId,
      currency: value.currency, grossPriceMinor: value.grossPriceMinor, deliveryGrossMinor: value.deliveryGrossMinor,
      observedAtMs: value.observedAtMs, available: value.available };
    const reason: ExclusionReason | null = offer.productId !== input.productId ? 'other_product' :
      offer.sellerId === input.ownSellerId ? 'own_seller' : !offer.available ? 'unavailable' :
      offer.currency !== input.currency ? 'other_currency' : offer.observedAtMs > input.nowMs ? 'future_observation' :
      input.nowMs - offer.observedAtMs > input.maxAgeMs ? 'stale_observation' : null;
    if (reason) excludedOffers.push({ offer, reason });
    else eligible.push({ ...offer, totalGrossMinor: offer.grossPriceMinor + offer.deliveryGrossMinor });
  }
  eligible.sort((a, b) => a.totalGrossMinor < b.totalGrossMinor ? -1 : a.totalGrossMinor > b.totalGrossMinor ? 1 :
    compareText(a.sellerId, b.sellerId) || compareText(a.offerId, b.offerId));
  excludedOffers.sort((a, b) => compareText(a.offer.offerId, b.offer.offerId));
  const rankedOffers = eligible.map((offer, index) => ({ ...offer, rank: index + 1 }));
  const selected = rankedOffers[input.rank - 1] ?? null;
  const common = { basis, rankedOffers, excludedOffers };
  if (!selected) return { ...common, state: 'blocked', reason: 'insufficient_offers', selected: null, targetGrossMinor: null };
  const target = selected.totalGrossMinor - input.undercutGrossMinor - input.ownDeliveryGrossMinor;
  if (target < 0n) return { ...common, state: 'blocked', reason: 'target_below_zero', selected, targetGrossMinor: null };
  if (target > maximumPriceMinor) return { ...common, state: 'blocked', reason: 'target_above_price_bound', selected, targetGrossMinor: null };
  return { ...common, state: 'ready', reason: null, selected, targetGrossMinor: target };
}
