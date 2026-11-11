import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Problem } from '../server/errors';
import {
  DHL_PICKUP_MIN_WINDOW_MINUTES,
  dhlEventTime,
  dhlPdf,
  dhlPickupWindow,
  dhlReference,
  dhlStatus,
  parseDhlInput,
  splitStreet,
  validNrb,
} from '../server/carrier-dhl-values';
import { NOW, syntheticNrb, validInput } from './fixtures/dhl/inputs';
const rejects = (fn: () => unknown, status: number, re?: RegExp) =>
  assert.throws(fn, (e: unknown) => e instanceof Problem && e.status === status && (!re || re.test(e.message)));

test('input normalizes the postcode and fills defaults like the DPD input', () => {
  const v = parseDhlInput(validInput);
  assert.equal(v.sender.postalCode, '00838');
  assert.equal(v.receiver.countryCode, 'PL');
  assert.equal(v.cod, 0);
  assert.equal(v.insurance, 0);
});

test('postcode, weight and COD validation reject before any request', () => {
  rejects(() => parseDhlInput({ ...validInput, receiver: { ...validInput.receiver, postalCode: '3114' } }), 422, /kod pocztowy/);
  rejects(() => parseDhlInput({ ...validInput, receiver: { ...validInput.receiver, postalCode: 'AB-123' } }), 422);
  rejects(() => parseDhlInput({ ...validInput, weight: 31.6 }), 422);
  rejects(() => parseDhlInput({ ...validInput, weight: 0 }), 422);
  rejects(() => parseDhlInput({ ...validInput, weight: 1.234 }), 422);
  const nrb = syntheticNrb();
  rejects(() => parseDhlInput({ ...validInput, cod: 1_100_001, insurance: 2_000_000, cod_bank_account: nrb }), 422);
  rejects(() => parseDhlInput({ ...validInput, cod: 12.5, insurance: 100, cod_bank_account: nrb }), 422);
  rejects(() => parseDhlInput({ ...validInput, cod: 10000, insurance: 5000, cod_bank_account: nrb }), 422, /obejmować pobranie/);
  rejects(() => parseDhlInput({ ...validInput, cod: 10000, insurance: 10000 }), 422, /NRB/);
  rejects(() => parseDhlInput({ ...validInput, cod: 10000, insurance: 10000, cod_bank_account: nrb.slice(0, 25) + ((Number(nrb[25]) + 1) % 10) }), 422, /NRB/);
  assert.equal(parseDhlInput({ ...validInput, cod: 10000, insurance: 10000, cod_bank_account: 'PL' + nrb }).cod, 10000);
  rejects(() => parseDhlInput({ ...validInput, content: 'x\u0001y' }), 422);
});

test('NRB checksum', () => {
  assert.equal(validNrb(syntheticNrb()), true);
  assert.equal(validNrb('PL ' + syntheticNrb().replace(/(\d{4})/g, '$1 ')), true);
  assert.equal(validNrb('00' + syntheticNrb().slice(2)), false);
  assert.equal(validNrb('123'), false);
});

test('street is split into street, house and apartment number', () => {
  const a = parseDhlInput(validInput).sender;
  assert.deepEqual(splitStreet(a), { street: 'Prosta', houseNumber: '5', apartmentNumber: '12' });
  assert.deepEqual(splitStreet({ ...a, address: 'Aleje Jerozolimskie 123A' }), { street: 'Aleje Jerozolimskie', houseNumber: '123A' });
  assert.deepEqual(splitStreet({ ...a, address: 'Rynek', houseNumber: '7' }), { street: 'Rynek', houseNumber: '7', apartmentNumber: undefined });
  rejects(() => splitStreet({ ...a, address: 'Rynek Główny' }), 422, /numerem domu/);
});

test('idempotency key maps to a stable short DHL reference', () => {
  const r = dhlReference('order-123:shipment-1');
  assert.match(r, /^DY[0-9A-F]{20}$/);
  assert.equal(dhlReference('order-123:shipment-1'), r);
  assert.notEqual(dhlReference('order-123:shipment-2'), r);
  rejects(() => dhlReference('short'), 422);
  rejects(() => dhlReference('bad key with spaces'), 422);
});

test('event time is Polish local time; DST gap rejected, autumn overlap takes the later instant', () => {
  assert.equal(dhlEventTime('2026-07-01 12:00:00'), '2026-07-01T10:00:00.000Z');
  assert.equal(dhlEventTime('2026-12-01T12:00'), '2026-12-01T11:00:00.000Z');
  assert.equal(dhlEventTime('2026-10-25 02:30:00'), '2026-10-25T01:30:00.000Z');
  rejects(() => dhlEventTime('2026-03-29 02:30:00'), 502);
  rejects(() => dhlEventTime('2026-02-30 10:00:00'), 502);
  rejects(() => dhlEventTime('yesterday'), 502);
});

test('pickup window: future, ≤14 days, weekday, minimum length, postcode hours', () => {
  assert.equal(DHL_PICKUP_MIN_WINDOW_MINUTES, 120);
  dhlPickupWindow('2026-10-26', '11:00', '15:00', undefined, NOW);
  dhlPickupWindow('2026-10-27', '09:00', '11:00', { from: '09:00', to: '17:00', saturday: false }, NOW);
  rejects(() => dhlPickupWindow('2026-10-26', '09:00', '15:00', undefined, NOW), 422, /przyszłości/);
  rejects(() => dhlPickupWindow('2026-10-25', '11:00', '15:00', undefined, NOW), 422, /przyszłości/);
  rejects(() => dhlPickupWindow('2026-11-10', '11:00', '15:00', undefined, NOW), 422, /14 dni/);
  rejects(() => dhlPickupWindow('2026-11-01', '11:00', '15:00', undefined, NOW), 422, /poniedziałku/);
  rejects(() => dhlPickupWindow('2026-10-31', '11:00', '15:00', undefined, NOW), 422, /sobota/);
  dhlPickupWindow('2026-10-31', '10:00', '13:00', { from: '09:00', to: '14:00', saturday: true }, NOW);
  rejects(() => dhlPickupWindow('2026-10-27', '12:00', '13:30', undefined, NOW), 422, /2 godziny/);
  rejects(() => dhlPickupWindow('2026-10-27', '15:00', '12:00', undefined, NOW), 422);
  rejects(() => dhlPickupWindow('2026-10-27', '08:00', '12:00', { from: '09:00', to: '17:00', saturday: false }, NOW), 422, /09:00–17:00/);
  rejects(() => dhlPickupWindow('2026-10-27', '8:00', '12:00', undefined, NOW), 422);
});

test('tracking codes map to app statuses; unknown codes do not change status', () => {
  assert.equal(dhlStatus('DOR'), 'delivered');
  assert.equal(dhlStatus('DWP'), 'out_for_delivery');
  assert.equal(dhlStatus('ZWD'), 'returned_to_sender');
  assert.equal(dhlStatus('XYZ'), null);
});

test('label PDF must be canonical base64 of a PDF', () => {
  const pdf = Buffer.from('%PDF-1.4\n%%EOF');
  assert.deepEqual(dhlPdf(pdf.toString('base64')), pdf);
  rejects(() => dhlPdf(Buffer.from('<html>').toString('base64')), 502);
  rejects(() => dhlPdf(''), 502);
  rejects(() => dhlPdf('not base64!'), 502);
  rejects(() => dhlPdf(null), 502);
});
