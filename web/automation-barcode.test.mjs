/** Rule barcode helpers (Uwagi v3 §0). Run: node node_modules/tsx/dist/cli.mjs --test web/automation-barcode.test.mjs */
import test from 'node:test';
import assert from 'node:assert/strict';
import { isRuleBarcode, ruleBarcodeBody, ruleBarcodeText } from './automation-barcode.ts';

test('only AR- plus 10 hex characters is a rule code; product codes are not', () => {
  assert.equal(isRuleBarcode('AR-0A1B2C3D4E'), true);
  assert.equal(isRuleBarcode(' ar-0a1b2c3d4e '), true, 'scanner case and spaces');
  for (const v of ['AR-0A1B2C3D4', 'AR-0A1B2C3D4E5', 'AR-XYZ1234567', '5901234123457', 'PS-AKC-001', ''])
    assert.equal(isRuleBarcode(v), false, v);
});

test('body normalises the code and names the order; result text per run status', () => {
  assert.deepEqual(ruleBarcodeBody(' ar-0a1b2c3d4e ', 'o-1'), { code: 'AR-0A1B2C3D4E', order: 'o-1' });
  assert.equal(ruleBarcodeText({ rule_name: 'Etykieta InPost', status: 'done' }), 'Wykonano akcję „Etykieta InPost”.');
  assert.match(ruleBarcodeText({ rule_name: 'X', status: 'skipped', reason: 'warunki niespełnione' }), /pominięta: warunki niespełnione/);
  assert.match(ruleBarcodeText({ rule_name: 'X', status: 'failed', error: 'brak przewoźnika' }), /nie powiodła się: brak przewoźnika/);
});
