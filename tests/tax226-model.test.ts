/** Pure 226 tax rules: profile/OSS input validation, the tax category of a line and MPP. No IO. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TAX_PROFILE, deriveLineTax, mppRequirement, ossSettingsInput, taxProfileInput, type OssState, type TaxBuyer, type TaxProfile } from '../server/tax226-model';

const consumerPL: TaxBuyer = { kind: 'consumer', country: 'PL' };
const profile = (p: Partial<TaxProfile>): TaxProfile => ({ ...DEFAULT_TAX_PROFILE, version: 3, ...p });
const oss: OssState = { registered: true, registered_from: '2026-07-01', rates: [{ country: 'DE', rate_class: 'standard', rate: '19.00' }, { country: 'DE', rate_class: 'reduced_1', rate: '7.00' }] };
const facts = (d: ReturnType<typeof deriveLineTax>) => { assert('facts' in d, JSON.stringify(d)); return d.facts; };
const refusal = (d: ReturnType<typeof deriveLineTax>, re: RegExp) => { assert('refusal' in d, JSON.stringify(d)); assert.match(d.refusal, re); };

test('profile input: ZW needs basis kind and text; NP needs its kind; others refuse stray fields', () => {
  const ok = { version: null, gtu: null, annex15: false };
  assert.equal(taxProfileInput.parse({ ...ok, category: 'standard' }).oss_rate_class, 'standard');
  assert.equal(taxProfileInput.parse({ ...ok, category: 'zw', exemption_basis_kind: 'P_19A', exemption_basis: '  art. 43 ust. 1 pkt 18 ustawy o VAT ' }).exemption_basis, 'art. 43 ust. 1 pkt 18 ustawy o VAT');
  for (const bad of [{ category: 'zw' }, { category: 'zw', exemption_basis_kind: 'P_19B' }, { category: 'zw', exemption_basis: 'x' }, { category: 'zw', exemption_basis_kind: 'P_19C', exemption_basis: '   ' },
    { category: 'zw', exemption_basis_kind: 'P_19A', exemption_basis: 'x'.repeat(257) }, { category: 'standard', exemption_basis_kind: 'P_19A', exemption_basis: 'x' },
    { category: 'np' }, { category: 'oo', np_kind: 'np_i' }, { category: 'xx' }])
    assert.equal(taxProfileInput.safeParse({ ...ok, ...bad }).success, false, JSON.stringify(bad));
  for (const gtu of ['GTU_00', 'GTU_14', 'GTU_1', 'gtu_01']) assert.equal(taxProfileInput.safeParse({ ...ok, category: 'standard', gtu }).success, false, gtu);
  for (const gtu of ['GTU_01', 'GTU_13']) assert.equal(taxProfileInput.parse({ ...ok, category: 'standard', gtu }).gtu, gtu);
  assert.equal(taxProfileInput.safeParse({ ...ok, category: 'standard', extra: 1 }).success, false);
});

test('OSS input: registration needs a valid start date, rates unique, 0..30 with two decimals, PL refused', () => {
  const ok = { version: 2, registered: true, registered_from: '2026-07-01', rates: [{ country: 'DE', rate_class: 'standard', rate: 19 }, { country: 'FR', rate_class: 'reduced_1', rate: 5.5 }] };
  assert.equal(ossSettingsInput.parse(ok).rates.length, 2);
  assert.equal(ossSettingsInput.parse({ version: null, registered: false, registered_from: null, rates: [] }).registered, false);
  for (const bad of [{ registered_from: null }, { registered: false }, { registered_from: '2026-02-30' }, { rates: [{ country: 'PL', rate_class: 'standard', rate: 23 }] },
    { rates: [{ country: 'DE', rate_class: 'standard', rate: 19 }, { country: 'DE', rate_class: 'standard', rate: 7 }] },
    { rates: [{ country: 'DE', rate_class: 'standard', rate: 30.01 }] }, { rates: [{ country: 'DE', rate_class: 'standard', rate: 19.123 }] }, { rates: [{ country: 'DE', rate_class: 'standard', rate: -1 }] }])
    assert.equal(ossSettingsInput.safeParse({ ...ok, ...bad }).success, false, JSON.stringify(bad));
});

test('domestic ordinary rates map to FA(3) codes; shipping never carries GTU or annex 15', () => {
  assert.deepEqual(facts(deriveLineTax({ kind: 'item', vat_rate: 23, profile: profile({ gtu: 'GTU_06', annex15: true }) }, consumerPL, null, '2026-10-23')),
    { category: 'standard', rate: '23.00', rate_code: '23', exemption_basis_kind: null, exemption_basis: null, np_kind: null, gtu: 'GTU_06', annex15: true, profile_version: 3 });
  assert.equal(facts(deriveLineTax({ kind: 'item', vat_rate: 0, profile: DEFAULT_TAX_PROFILE }, consumerPL, null, '2026-10-23')).rate_code, '0 KR');
  assert.equal(facts(deriveLineTax({ kind: 'item', vat_rate: 8, profile: DEFAULT_TAX_PROFILE }, consumerPL, null, '2026-10-23')).profile_version, null);
  const ship = facts(deriveLineTax({ kind: 'shipping', vat_rate: 5, profile: profile({ gtu: 'GTU_01', annex15: true, category: 'zw', exemption_basis_kind: 'P_19A', exemption_basis: 'x' }) }, consumerPL, null, '2026-10-23'));
  assert.deepEqual([ship.category, ship.rate_code, ship.gtu, ship.annex15, ship.profile_version], ['standard', '5', null, false, null]);
});

test('ZW keeps its basis; OO and NP refuse buyers that do not meet their conditions', () => {
  const zw = facts(deriveLineTax({ kind: 'item', vat_rate: 23, profile: profile({ category: 'zw', exemption_basis_kind: 'P_19B', exemption_basis: 'art. 132 ust. 1 lit. i dyrektywy 2006/112/WE' }) }, consumerPL, null, '2026-10-23'));
  assert.deepEqual([zw.rate, zw.rate_code, zw.exemption_basis_kind], [null, 'zw', 'P_19B']);
  const oo = profile({ category: 'oo' });
  refusal(deriveLineTax({ kind: 'item', vat_rate: 23, profile: oo }, consumerPL, null, '2026-10-23'), /czynnym podatnikiem VAT w Polsce/);
  refusal(deriveLineTax({ kind: 'item', vat_rate: 23, profile: oo }, { kind: 'business', country: 'PL', pl_vat_payer: false }, null, '2026-10-23'), /czynnym podatnikiem/);
  assert.equal(facts(deriveLineTax({ kind: 'item', vat_rate: 23, profile: oo }, { kind: 'business', country: 'PL', pl_vat_payer: true }, null, '2026-10-23')).rate_code, 'oo');
});

test('NP II = art. 100 ust. 1 pkt 4 (art. 28b) for an EU taxable person; NP I = outside PL without them and OSS, refused for a PL buyer', () => {
  const np1 = profile({ category: 'np', np_kind: 'np_i' }), np2 = profile({ category: 'np', np_kind: 'np_ii' }), line = (p: TaxProfile) => ({ kind: 'item' as const, vat_rate: 23, profile: p });
  refusal(deriveLineTax(line(np2), { kind: 'business', country: 'DE', eu_vat_id: false }, null, '2026-10-23'), /NP II.*numerem VAT UE/);
  refusal(deriveLineTax(line(np2), { kind: 'business', country: 'PL', eu_vat_id: true }, null, '2026-10-23'), /NP II.*spoza Polski/);
  refusal(deriveLineTax(line(np2), { kind: 'business', country: 'US', eu_vat_id: true }, null, '2026-10-23'), /NP II.*spoza Polski/);
  refusal(deriveLineTax(line(np2), { kind: 'consumer', country: 'DE', eu_vat_id: true }, null, '2026-10-23'), /NP II.*podatnikiem/);
  const ii = facts(deriveLineTax(line(np2), { kind: 'business', country: 'DE', eu_vat_id: true }, null, '2026-10-23'));
  assert.deepEqual([ii.category, ii.rate, ii.rate_code, ii.np_kind], ['np', null, 'np II', 'np_ii']);
  refusal(deriveLineTax(line(np1), consumerPL, null, '2026-10-23'), /NP I .*poza Polską/);
  refusal(deriveLineTax(line(np1), { kind: 'business', country: 'PL', eu_vat_id: true, pl_vat_payer: true }, null, '2026-10-23'), /NP I .*poza Polską/);
  for (const buyer of [{ kind: 'consumer', country: 'US' }, { kind: 'business', country: 'NO' }] as TaxBuyer[]) {
    const i = facts(deriveLineTax(line(np1), buyer, null, '2026-10-23'));
    assert.deepEqual([i.category, i.rate, i.rate_code, i.np_kind], ['np', null, 'np I', 'np_i'], JSON.stringify(buyer));
  }
  const missing = taxProfileInput.safeParse({ version: null, gtu: null, annex15: false, category: 'np' });
  assert(!missing.success);
  assert.match(missing.error.issues[0].message, /NP I \(poza krajem, bez art\. 100 ust\. 1 pkt 4 i OSS\) albo NP II \(usługi z art\. 100 ust\. 1 pkt 4/);
});

test('OSS applies only to EU consumers with a registration valid on the sell date and a destination rate', () => {
  const de: TaxBuyer = { kind: 'consumer', country: 'DE' }, line = { kind: 'item' as const, vat_rate: 23, profile: profile({ oss_rate_class: 'reduced_1' }) };
  assert.deepEqual([facts(deriveLineTax(line, de, oss, '2026-10-23')).rate, facts(deriveLineTax(line, de, oss, '2026-10-23')).rate_code], ['7.00', 'oss']);
  assert.equal(facts(deriveLineTax({ kind: 'shipping', vat_rate: 23, profile: DEFAULT_TAX_PROFILE }, de, oss, '2026-07-01')).rate, '19.00');
  refusal(deriveLineTax(line, de, oss, '2026-06-30'), /rejestracji OSS/);
  refusal(deriveLineTax(line, de, null, '2026-10-23'), /rejestracji OSS/);
  refusal(deriveLineTax(line, de, { ...oss, registered: false, registered_from: null }, '2026-10-23'), /rejestracji OSS/);
  refusal(deriveLineTax(line, { kind: 'consumer', country: 'FR' }, oss, '2026-10-23'), /Brak stawki OSS dla FR/);
  refusal(deriveLineTax(line, { kind: 'business', country: 'DE', eu_vat_id: true }, oss, '2026-10-23'), /WDT/);
});

test('MPP: only B2B, strictly over 15 000 PLN gross and with an annex-15 line', () => {
  const b2b: TaxBuyer = { kind: 'business', country: 'PL', pl_vat_payer: true };
  assert.equal(mppRequirement(b2b, 1_500_001n, 1n).required, true);
  assert.equal(mppRequirement(b2b, 1_500_000n, 1_500_000n).required, false);
  assert.equal(mppRequirement(b2b, 9_000_000n, 0n).required, false);
  assert.match(mppRequirement(consumerPL, 9_000_000n, 9_000_000n).reason, /konsument|nie jest podatnikiem/);
});
