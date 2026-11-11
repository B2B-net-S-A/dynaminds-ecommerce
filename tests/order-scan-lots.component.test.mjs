// Top scan field of the order card in a company with lots: it must send the retry key server/domain.ts requires.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test, { after } from 'node:test';
import { createServer } from 'vite';

const vite = await createServer({ server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: 'custom', logLevel: 'error' });
after(() => vite.close());
const { orderScanBody, orderScanErrorMessage } = await vite.ssrLoadModule(path.resolve('web/order-scan.ts'));
const key = 'a'.repeat(8) + '-1111-4111-8111-' + 'b'.repeat(12);

test('with lots every scan carries a new retry key', () => {
  let n = 0;
  const body = () => orderScanBody({ code: 'PS-1', location: '', lotsEnabled: true, newKey: () => { n += 1; return key; } });
  assert.deepEqual(body(), { code: 'PS-1', client_key: key });
  body();
  assert.equal(n, 2);
});

test('without lots the request is unchanged', () => {
  const newKey = () => assert.fail('no key without lots');
  assert.deepEqual(orderScanBody({ code: 'PS-1', location: '', lotsEnabled: false, newKey }), { code: 'PS-1' });
  assert.deepEqual(orderScanBody({ code: 'PS-1', location: 'A-01', lotsEnabled: false, newKey }), { code: 'PS-1', location: 'A-01' });
});

test('technical lot refusals point to the lots section; other messages stay', () => {
  for (const server of ['W lokalizacji przypisano kilka warstw. Wybierz layer_id', 'Brak nieskompletowanej przypisanej warstwy w tej lokalizacji']) {
    const shown = orderScanErrorMessage(server);
    assert.match(shown, /Partie i alokacje magazynowe/);
    assert.doesNotMatch(shown, /layer_id|warstw/);
  }
  assert.equal(orderScanErrorMessage('Kod nie należy do tego zamówienia'), 'Kod nie należy do tego zamówienia');
});

test('the order card uses them for the top field', () => {
  const main = readFileSync(path.resolve('web/order-card.tsx'), 'utf8');
  const form = main.slice(main.indexOf('className="scan-form"'), main.indexOf('placeholder="Zeskanuj lub wpisz SKU / EAN"'));
  assert.match(form, /orderScanBody\(\{ code, location: pickLocation, lotsEnabled: o\.wms_lots_enabled === true, newKey: \(\) => crypto\.randomUUID\(\) \}\)/);
  assert.match(main, /notify\(orderScanErrorMessage\(/);
});
