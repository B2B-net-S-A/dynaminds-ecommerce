/** ACCOUNT-002: web amount and date helpers follow the tenant region from /api/auth/me
 * (pl-PL by default), and another organization starts from the default region again. */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { currentRegion, date, money, setRegion, setWorkspace } from '../web/api';

const nbsp = (s: string) => s.replace(/[  ]/g, ' ');
const AT = '2026-10-26T14:05:00Z';
const expectedDate = (locale: string) =>
  new Date(AT).toLocaleString(locale, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
afterEach(() => { setWorkspace(null); setRegion(null); });

test('default region is pl-PL with PLN', () => {
  setRegion(null);
  assert.deepEqual(currentRegion(), { locale: 'pl-PL', currency: 'PLN' });
  assert.equal(nbsp(money(123456)), '1234,56 zł');
  assert.equal(date(AT), expectedDate('pl-PL'));
});

test('en-GB tenant: pound amounts with a point and English month names', () => {
  setRegion({ locale: 'en-GB', currency: 'GBP' });
  assert.equal(money(123456), '£1,234.56');
  assert.equal(nbsp(money(123456, 'PLN')), 'PLN 1,234.56', 'explicit currency of the amount wins');
  assert.match(date(AT), /Oct/);
  assert.equal(date(AT), expectedDate('en-GB'));
});

test('de-DE tenant: euro with a comma decimal and German month names', () => {
  setRegion({ locale: 'de-DE', currency: 'EUR' });
  assert.equal(nbsp(money(123456)), '1.234,56 €');
  assert.match(date(AT), /Okt/);
  assert.equal(date(AT), expectedDate('de-DE'));
  assert.notEqual(date(AT), expectedDate('pl-PL'));
});

test('unknown or malformed values fall back to pl-PL/PLN', () => {
  setRegion({ locale: 'xx-YY', currency: 'euro' });
  assert.deepEqual(currentRegion(), { locale: 'pl-PL', currency: 'PLN' });
  setRegion({ locale: 42, currency: null } as never);
  assert.deepEqual(currentRegion(), { locale: 'pl-PL', currency: 'PLN' });
});

test('switching organization resets the region until the new user arrives', () => {
  setWorkspace('tenant-a');
  setRegion({ locale: 'de-DE', currency: 'EUR' });
  setWorkspace('tenant-a');
  assert.equal(currentRegion().locale, 'de-DE', 'same organization keeps its region');
  setWorkspace('tenant-b');
  assert.deepEqual(currentRegion(), { locale: 'pl-PL', currency: 'PLN' });
  setRegion({ locale: 'en-GB', currency: 'GBP' });
  setWorkspace(null);
  assert.deepEqual(currentRegion(), { locale: 'pl-PL', currency: 'PLN' });
});
