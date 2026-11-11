import test from 'node:test';
import assert from 'node:assert/strict';
import { rankCompetitorOffers, type CompetitorOffer, type CompetitorRankingInput } from '../server/competitor-ranking';

const now = 1791420000000;
const offer = (offerId: string, sellerId: string, price: bigint, delivery: bigint, extra: Partial<CompetitorOffer> = {}): CompetitorOffer =>
  ({ offerId, sellerId, productId: 'sku-a', currency: 'PLN', grossPriceMinor: price, deliveryGrossMinor: delivery,
    observedAtMs: now - 1000, available: true, ...extra });
const input = (offers: CompetitorOffer[], extra: Partial<CompetitorRankingInput> = {}): CompetitorRankingInput =>
  ({ productId: 'sku-a', currency: 'PLN', ownSellerId: 'own-shop', ownDeliveryGrossMinor: 499n,
    undercutGrossMinor: 1n, rank: 1, nowMs: now, maxAgeMs: 60000, offers, ...extra });

test('gross delivered totals change rank; explicit own delivery and undercut produce exact product target', () => {
  const offers = [offer('cheap-product', 'seller-a', 9000n, 2000n), offer('cheap-total', 'seller-b', 10001n, 499n)];
  const first = rankCompetitorOffers(input(offers));
  assert.equal(first.state, 'ready'); assert.equal(first.selected?.offerId, 'cheap-total');
  assert.deepEqual(first.rankedOffers.map(o => [o.offerId, o.totalGrossMinor, o.rank]), [['cheap-total',10500n,1],['cheap-product',11000n,2]]);
  assert.equal(first.targetGrossMinor, 10000n);
  const second = rankCompetitorOffers(input(offers, { rank: 2, ownDeliveryGrossMinor: 1000n, undercutGrossMinor: 5n }));
  assert.equal(second.targetGrossMinor, 9995n); assert.equal(second.selected?.offerId, 'cheap-product');
  assert.equal(rankCompetitorOffers(input(offers, { rank: 3 })).reason, 'insufficient_offers');
});

test('own seller, other product/currency, unavailable and future/stale observations never become rank targets', () => {
  const offers = [offer('self','own-shop',1n,0n),offer('other-product','s',1n,0n,{productId:'sku-b'}),
    offer('eur','s',1n,0n,{currency:'EUR'}),offer('absent','s',1n,0n,{available:false}),
    offer('future','s',1n,0n,{observedAtMs:now+1}),offer('old','s',1n,0n,{observedAtMs:now-60001}),
    offer('boundary','s',1000n,100n,{observedAtMs:now-60000})];
  const result = rankCompetitorOffers(input(offers));
  assert.equal(result.selected?.offerId,'boundary'); assert.equal(result.targetGrossMinor,600n);
  assert.deepEqual(result.excludedOffers.map(x=>[x.offer.offerId,x.reason]), [['absent','unavailable'],['eur','other_currency'],
    ['future','future_observation'],['old','stale_observation'],['other-product','other_product'],['self','own_seller']]);
  const allExcluded=rankCompetitorOffers(input(offers.slice(0,-1)));
  assert.equal(allExcluded.reason,'insufficient_offers'); assert.equal(allExcluded.targetGrossMinor,null);
});

test('equal delivered totals have stable seller/offer tie ordering independent of source order, without input aliases', () => {
  const offers=[offer('z','seller-z',999n,1n),offer('b','seller-a',1000n,0n),offer('a','seller-a',1n,999n)];
  const before=structuredClone(offers);
  const expected=rankCompetitorOffers(input(offers,{rank:2}));
  assert.deepEqual(expected.rankedOffers.map(x=>x.offerId),['a','b','z']);assert.equal(expected.selected?.offerId,'b');
  for(const source of [[offers[2],offers[0],offers[1]],[...offers].reverse()])assert.deepEqual(rankCompetitorOffers(input(source,{rank:2})),expected);
  assert.deepEqual(offers,before); offers[1].grossPriceMinor=99999n;
  assert.equal(expected.selected?.grossPriceMinor,1000n); assert.equal(expected.targetGrossMinor,500n);
});

test('zero stays a real price; negative and out-of-writer-bound targets block without clamping or truncation', () => {
  const zero=rankCompetitorOffers(input([offer('zero','s',0n,500n)]));
  assert.equal(zero.state,'ready');assert.equal(zero.targetGrossMinor,0n);
  const below=rankCompetitorOffers(input([offer('p','s',0n,499n)]));
  assert.equal(below.reason,'target_below_zero');assert.equal(below.targetGrossMinor,null);
  const above=rankCompetitorOffers(input([offer('p','s',100000000n,100000000n)],{ownDeliveryGrossMinor:0n,undercutGrossMinor:0n}));
  assert.equal(above.reason,'target_above_price_bound');assert.equal(above.rankedOffers[0].totalGrossMinor,200000000n);
  assert.equal(rankCompetitorOffers(input([offer('p','s',100000000n,0n)],{ownDeliveryGrossMinor:0n,undercutGrossMinor:0n})).targetGrossMinor,100000000n);
});

test('malformed or ambiguous inputs refuse the whole ranking, including duplicate offer IDs and non-bigint money', () => {
  const good=input([offer('one','seller-a',1n,1n)]);
  const bad: unknown[]=[null,{...good,rank:0},{...good,rank:1.5},{...good,rank:1001},{...good,nowMs:NaN},
    {...good,maxAgeMs:0},{...good,maxAgeMs:604800001},{...good,currency:'pln'}, {...good,ownDeliveryGrossMinor:-1n},
    {...good,undercutGrossMinor:1},{...good,offers:[...good.offers,offer('one','seller-b',2n,2n)]},
    {...good,offers:[{...good.offers[0],grossPriceMinor:'1'}]}, {...good,offers:[{...good.offers[0],deliveryGrossMinor:100000001n}]},
    {...good,offers:[{...good.offers[0],observedAtMs:Infinity}]}, {...good,offers:[{...good.offers[0],available:1}]},
    {...good,offers:[{...good.offers[0],sellerId:' own-shop'}]}];
  for(const value of bad)assert.throws(()=>rankCompetitorOffers(value as CompetitorRankingInput),/Niepoprawne jawne dane/);
  assert.equal(rankCompetitorOffers(input([])).reason,'insufficient_offers');
});
