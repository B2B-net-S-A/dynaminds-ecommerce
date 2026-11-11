/** Pure S9 repricing rules (no database): min/max bounds, rounding to a grosz step with
 * an ending, cost conversion with a dated NBP table A rate (missing or stale rate blocks),
 * the base price-list chain with cycle detection, and the history cursor. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateReprice, repricingConfig } from '../server/repricing';
import {
  convertMinor,
  costInListCurrency,
  pickRepricingRate,
  roundPrice,
  walkBaseChain,
  historyAfter,
  historyCursor,
  parseHistoryCursor,
  type RepricingRate,
} from '../server/repricing-rules';

const product = { id: 'p', sku: 'SKU-1', version: 1, vat: 23, active: true, kind: 'simple' };
const now = Date.parse('2026-10-26T10:00:00Z');
const eur: RepricingRate = { currency: 'EUR', effective_date: '2026-10-23', table_no: '206/A/NBP/2026', mid: '4.2512' };
const usd: RepricingRate = { currency: 'USD', effective_date: '2026-10-23', table_no: '206/A/NBP/2026', mid: '3.6650' };
const rates = new Map([['EUR', eur], ['USD', usd]]);

test('granice min/max: kandydat poniżej minimum podnoszony do minimum, powyżej maksimum obniżany', () => {
  const low = calculateReprice(repricingConfig.parse({ strategy: 'competitor', min_price: 15000, max_price: 30000 }), product,
    { net_cost: 1000, competitor_price: 500, observed_at: new Date(now - 1000).toISOString() }, 20000, now);
  assert.equal(low.proposed_price, 15000);
  assert.equal(low.floor, 15000);
  const high = calculateReprice(repricingConfig.parse({ strategy: 'competitor', max_price: 30000 }), product,
    { net_cost: 1000, competitor_price: 90000, observed_at: new Date(now - 1000).toISOString() }, 20000, now);
  assert.equal(high.proposed_price, 30000);
  const impossible = calculateReprice(repricingConfig.parse({ max_price: 1000 }), product,
    { net_cost: 10000 }, 20000, now);
  assert.equal(impossible.state, 'blocked');
  assert.equal(impossible.proposed_price, null);
  assert.throws(() => repricingConfig.parse({ min_price: 40000, max_price: 30000 }));
});

test('zaokrąglenie do kroku z końcówką nigdy nie schodzi poniżej minimum i respektuje maksimum', () => {
  assert.equal(roundPrice(14471, 14471, 18000, { step: 100, ending: 99 }), 14499);
  assert.equal(roundPrice(14400, 14400, 18000, { step: 100, ending: 0 }), 14400);
  assert.equal(roundPrice(14401, 14401, 18000, { step: 100, ending: 0 }), 14500);
  assert.equal(roundPrice(14401, 14401, 18000, { step: 50, ending: 49 }), 14449);
  assert.equal(roundPrice(14401, 10000, 18000, { step: 1000, ending: 990 }), 14990);
  assert.equal(roundPrice(17999, 10000, 18000, { step: 1000, ending: 990 }), 17990);
  assert.equal(roundPrice(17995, 17995, 18000, { step: 1000, ending: 990 }), null);
  assert.equal(roundPrice(1, 0, 18000, { step: 10, ending: 9 }), 9);
  assert.equal(roundPrice(0, 0, 5, { step: 10, ending: 9 }), null);
  assert.equal(roundPrice(12345, 12345, 18000, null), 12345);
  // Competitor strategies prefer rounding down so the undercut stays below the rival.
  assert.equal(roundPrice(11900, 5000, 18000, { step: 1000, ending: 990 }, 'down'), 10990);
  assert.equal(roundPrice(11900, 11000, 18000, { step: 1000, ending: 990 }, 'down'), 11990);
  assert.equal(roundPrice(11990, 5000, 18000, { step: 1000, ending: 990 }, 'down'), 11990);
  const rival = calculateReprice(repricingConfig.parse({ strategy: 'competitor', undercut_amount: 100, rounding: { step: 1000, ending: 990 } }), product,
    { net_cost: 1000, competitor_price: 12000, observed_at: new Date(now - 1000).toISOString() }, 20000, now);
  assert.equal(rival.proposed_price, 10990);
  for (let candidate = 0; candidate < 3000; candidate += 7)
    for (const r of [{ step: 10, ending: 9 }, { step: 100, ending: 90 }, { step: 500, ending: 499 }] as const) {
      const floor = Math.max(0, candidate - 13), max = 2600;
      const out = roundPrice(Math.min(candidate, max), floor, max, r);
      if (out === null) continue;
      assert(out >= floor && out <= max && out % r.step === r.ending, `${candidate} ${JSON.stringify(r)} → ${out}`);
    }
});

test('konfiguracja zaokrąglenia: końcówka mniejsza od kroku, ,99 nie łączy się z nowym zaokrągleniem', () => {
  assert.equal(repricingConfig.parse({ rounding: { step: 100, ending: 49 } }).rounding!.ending, 49);
  for (const rounding of [{ step: 100, ending: 100 }, { step: 7, ending: 0 }, { step: 100, ending: -1 }, { step: 100, ending: 1.5 }])
    assert.throws(() => repricingConfig.parse({ rounding }), JSON.stringify(rounding));
  assert.throws(() => repricingConfig.parse({ ending: 99, rounding: { step: 100, ending: 99 } }));
  const c = repricingConfig.parse({ strategy: 'cost_margin', rounding: { step: 100, ending: 90 }, max_price: 100000 });
  const r = calculateReprice(c, product, { net_cost: 10000 }, 20000, now);
  assert.equal(r.proposed_price, 15390);
  assert(r.proposed_price! >= r.floor!);
  const tight = calculateReprice({ ...c, max_price: 15380 }, product, { net_cost: 10000 }, 20000, now);
  assert.equal(tight.state, 'change');
  assert.equal(tight.proposed_price, 15290);
  const none = calculateReprice({ ...c, max_price: 13680 }, product, { net_cost: 10000 }, 20000, now);
  assert.equal(none.state, 'blocked');
  assert.match(none.reason!, /Zaokrąglenie/);
});

test('przeliczenie przez kursy NBP: zaokrąglenie kosztu w górę do grosza, kurs krzyżowy przez PLN', () => {
  assert.equal(convertMinor(10000, 'PLN', 'PLN', rates, 'ceil'), 10000);
  assert.equal(convertMinor(10000, 'EUR', 'PLN', rates, 'ceil'), 42512);
  assert.equal(convertMinor(10001, 'EUR', 'PLN', rates, 'ceil'), 42517); // 42516.2512 → 42517
  assert.equal(convertMinor(10001, 'EUR', 'PLN', rates, 'half_up'), 42516);
  assert.equal(convertMinor(42512, 'PLN', 'EUR', rates, 'ceil'), 10000);
  assert.equal(convertMinor(42513, 'PLN', 'EUR', rates, 'ceil'), 10001);
  assert.equal(convertMinor(10000, 'EUR', 'USD', rates, 'ceil'), 11600); // 10000*4.2512/3.6650 = 11599.45
  assert.equal(convertMinor(0, 'EUR', 'PLN', rates, 'ceil'), 0);
  assert.equal(convertMinor(100000000, 'EUR', 'PLN', rates, 'ceil'), null);
  assert.throws(() => convertMinor(100, 'GBP', 'PLN', rates, 'ceil'));
});

test('kurs NBP z datą: brak lub starszy niż limit blokuje, przyszły nie jest używany', () => {
  assert.deepEqual(pickRepricingRate(eur, 'EUR', '2026-10-26', 7), { rate: eur });
  assert.deepEqual(pickRepricingRate(eur, 'EUR', '2026-10-30', 7), { rate: eur });
  const stale = pickRepricingRate(eur, 'EUR', '2026-10-31', 7);
  assert('refusal' in stale && /starszy niż 7 dni/.test(stale.refusal) && /23\.10\.2026/.test(stale.refusal));
  const missing = pickRepricingRate(undefined, 'EUR', '2026-10-26', 7);
  assert('refusal' in missing && /Brak kursu NBP/.test(missing.refusal));
  assert.throws(() => pickRepricingRate({ ...eur, effective_date: '2026-10-27' }, 'EUR', '2026-10-26', 7));
});

test('koszt w innej walucie niż cennik: przeliczony koszt wchodzi do minimum, odmowa kursu blokuje SKU', () => {
  const config = repricingConfig.parse({ cost_currency: 'EUR', fee_bps: 500 });
  const today = '2026-10-26';
  const converted = costInListCurrency({ net_cost: 10000, source: 'QA' }, config, 'PLN', rates, today);
  assert('input' in converted);
  assert.equal(converted.input.net_cost, 42512);
  assert.deepEqual(converted.fx, { cost_currency: 'EUR', list_currency: 'PLN', net_cost_original: 10000, net_cost: 42512,
    rates: [{ currency: 'EUR', effective_date: '2026-10-23', table_no: '206/A/NBP/2026', mid: '4.2512' }] });
  const r = calculateReprice(config, product, converted.input, null, now);
  assert(BigInt(r.floor!) * 100n * 8500n >= 42512n * 123n * 10000n);
  const blocked = costInListCurrency({ net_cost: 10000 }, config, 'PLN', new Map(), today);
  assert('refusal' in blocked && /Brak kursu NBP \(tabela A, EUR\)/.test(blocked.refusal));
  const same = costInListCurrency({ net_cost: 10000 }, repricingConfig.parse({}), 'EUR', new Map(), today);
  assert('input' in same && same.fx === null && same.input.net_cost === 10000);
  const stale = costInListCurrency({ net_cost: 10000 }, repricingConfig.parse({ cost_currency: 'EUR', max_rate_age_days: 2 }), 'PLN', rates, today);
  assert('refusal' in stale && /starszy niż 2 dni/.test(stale.refusal));
  assert.throws(() => repricingConfig.parse({ max_rate_age_days: 0 }));
  assert.throws(() => repricingConfig.parse({ max_rate_age_days: 32 }));
});

test('łańcuch cenników bazowych: cykl i zbyt długi łańcuch są odrzucane', () => {
  const links: Record<string, string | null> = { A: 'B', B: 'C', C: null, X: 'Y', Y: 'X', L1: 'L2', L2: 'L3', L3: 'L4', L4: 'L5', L5: 'L6', L6: 'L7', L7: null };
  assert.deepEqual(walkBaseChain('A', (id) => links[id] ?? null), { chain: ['B', 'C'] });
  assert.deepEqual(walkBaseChain('C', (id) => links[id] ?? null), { chain: [] });
  const cycle = walkBaseChain('X', (id) => links[id] ?? null);
  assert('refusal' in cycle && /cykl/i.test(cycle.refusal));
  const self = walkBaseChain('S', () => 'S');
  assert('refusal' in self && /cykl/i.test(self.refusal));
  const long = walkBaseChain('L1', (id) => links[id] ?? null);
  assert('refusal' in long && /zbyt długi/.test(long.refusal));
  assert.throws(() => repricingConfig.parse({ base_price_list_id: 'not-a-uuid' }));
});

test('kursor historii zachowuje mikrosekundy i odrzuca dowolny tekst', () => {
  const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
  const c = historyCursor('2026-10-26T10:00:00.123456Z', id);
  assert.deepEqual(parseHistoryCursor(c), { at: '2026-10-26T10:00:00.123456Z', id });
  for (const bad of ['', 'x', id, '2026-10-26T10:00:00Z|' + id, c + 'x', "2026-10-26T10:00:00.123456Z|' OR 1=1"])
    assert.throws(() => parseHistoryCursor(bad), bad);
  assert.deepEqual(historyAfter(undefined), { at: null, id: null });
  assert.deepEqual(historyAfter(c), { at: '2026-10-26T10:00:00.123456Z', id });
  assert.throws(() => historyAfter(id), (e: any) => e.status === 422);
});
