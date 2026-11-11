import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateReprice, repricingConfig } from '../server/repricing';
import { rankCompetitorOffers } from '../server/competitor-ranking';

const product = { id: 'p', sku: 'SKU', version: 1, vat: 23, active: true, kind: 'simple' };
const now = 1_790_000_000_000;
function ranked(target: string, state: 'ready' | 'blocked' = 'ready') {
  return { state, reason: state === 'blocked' ? 'insufficient_offers' : null,
    raw_target_gross_minor: state === 'ready' ? target : null };
}
test('offer total minus our delivery and undercut reaches repricer exactly once', () => {
  const basis = rankCompetitorOffers({ productId: 'p', currency: 'PLN', ownSellerId: 'own',
    ownDeliveryGrossMinor: 200n, undercutGrossMinor: 100n, rank: 2, nowMs: now, maxAgeMs: 60_000,
    offers: [
      { offerId: 'a', productId: 'p', sellerId: 'one', currency: 'PLN',
        grossPriceMinor: 1800n, deliveryGrossMinor: 300n, observedAtMs: now - 1000, available: true },
      { offerId: 'b', productId: 'p', sellerId: 'two', currency: 'PLN',
        grossPriceMinor: 2000n, deliveryGrossMinor: 500n, observedAtMs: now - 1000, available: true },
    ] });
  assert.equal(basis.targetGrossMinor, 2200n);
  const result = calculateReprice(repricingConfig.parse({ strategy: 'competitor_rank', undercut_amount: 100 }),
    product, { net_cost: 1000, competitor_price: 9999 }, 3000, now, ranked(basis.targetGrossMinor!.toString()));
  assert.equal(result.proposed_price, 2200);
  assert.equal(result.floor, 1367);
});
test('ranked prices retain cost, fee, VAT, min/max, ending and direction protections', () => {
  const config = repricingConfig.parse({ strategy: 'competitor_rank', fee_bps: 500,
    fixed_net_cost: 100, min_price: 0, max_price: 3000, ending: 99 });
  const result = calculateReprice(config, product, { net_cost: 1000 }, 4000, now, ranked('100'));
  assert.equal(result.floor, 1592);
  assert.equal(result.proposed_price, 1599);
  assert(BigInt(result.proposed_price!) * 100n * 8500n >= 1100n * 123n * 10000n);
  assert.equal(calculateReprice(config, product, { net_cost: 1000 }, 4000, now, ranked('100000')).proposed_price, 2999);
  assert.equal(calculateReprice({ ...config, direction: 'up' }, product, { net_cost: 1000 }, 4000, now,
    ranked('100')).state, 'blocked');
  assert.equal(calculateReprice({ ...config, max_price: 1500 }, product, { net_cost: 1000 }, 4000, now,
    ranked('2000')).state, 'blocked');
});
test('missing or insufficient rank basis cannot fall through to target-margin strategy', () => {
  const config = repricingConfig.parse({ strategy: 'competitor_rank' });
  for (const basis of [undefined, ranked('0', 'blocked'), ranked('-1'), ranked('100000001'), ranked('1.1')])
    assert.equal(calculateReprice(config, product, { net_cost: 1000 }, 3000, now, basis).state, 'blocked');
  assert.equal(calculateReprice(config, product, null, 3000, now, ranked('2000')).state, 'blocked');
  assert.equal(calculateReprice(config, { ...product, active: false }, { net_cost: 1000 }, 3000, now,
    ranked('2000')).state, 'blocked');
  assert.equal(calculateReprice(config, { ...product, kind: 'group' }, { net_cost: 1000 }, 3000, now,
    ranked('2000')).state, 'blocked');
});
test('zero is valid, equal candidate unchanged, and original strategies preserve their arithmetic', () => {
  const config = repricingConfig.parse({ strategy: 'competitor_rank', min_margin_bps: 0 });
  assert.equal(calculateReprice(config, product, { net_cost: 0 }, 0, now, ranked('0')).state, 'unchanged');
  const input = { net_cost: 1000, competitor_price: 2400, observed_at: new Date(now - 1000).toISOString() };
  assert.equal(calculateReprice(repricingConfig.parse({ strategy: 'competitor', undercut_amount: 100 }),
    product, input, 3000, now, ranked('999')).proposed_price, 2300);
  assert.equal(calculateReprice(repricingConfig.parse({ strategy: 'cost_margin' }), product, input, 3000,
    now, ranked('999')).proposed_price, 1538);
});
