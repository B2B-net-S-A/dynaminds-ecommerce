// "Znajdź punkt DHL" on the DHL order panel: exact request, rendered points, refused malformed answer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import React, { act } from 'react';
import * as jsx from 'react/jsx-runtime';
import { createRoot } from 'react-dom/client';
import { createRequire } from 'node:module';
const { JSDOM } = createRequire(import.meta.url)('jsdom');
const CH = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const point = {
  id: '100000838', name: 'DHL POP Kiosk', type: 'POP',
  address: { street: 'Marszałkowska 1', postalCode: '00838', city: 'Warszawa' },
  location: null, hours: [{ day: 'MON', open: '08:00', close: '20:00' }], description: '',
};
function load(api: (path: string) => Promise<unknown>) {
  const code = transformSync(readFileSync(new URL('../web/dhl-points.tsx', import.meta.url), 'utf8'), {
    loader: 'tsx', format: 'cjs', jsx: 'automatic', target: 'es2022',
  }).code;
  const m = { exports: {} as any };
  new Function('module', 'require', code)(m, (k: string) =>
    ({ react: React, 'react/jsx-runtime': jsx, 'lucide-react': { Search: () => null }, './api': { api } })[k],
  );
  return m.exports;
}
async function mount(reply: unknown) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'https://local.example/' });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Event: dom.window.Event, IS_REACT_ACT_ENVIRONMENT: true });
  const calls: string[] = [];
  const mod = load(async (path) => {
    calls.push(path);
    return reply;
  });
  const target = dom.window.document.getElementById('root')!, root = createRoot(target);
  await act(async () => root.render(React.createElement(mod.DhlPointsLookup, { channelId: CH, defaultPostcode: '00-838', defaultCity: 'Warszawa' })));
  await act(async () => target.querySelector('form')!.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })));
  return { target, calls, mod, close: async () => { await act(async () => root.unmount()); dom.window.close(); } };
}
test('lookup sends postcode and city to the channel route and lists name, address, type and id', async () => {
  const t = await mount({ channel_id: CH, scope: 'external_sandbox', count: 1, data: [point] });
  try {
    assert.deepEqual(t.calls, ['/integrations/' + CH + '/dhl-points?postcode=00-838&city=Warszawa']);
    const text = t.target.textContent!;
    for (const s of ['Znajdź punkt DHL', 'DHL POP Kiosk', 'Marszałkowska 1', '00-838 Warszawa', 'POP · ID 100000838', 'sandbox DHL24'])
      assert.ok(text.includes(s), s);
  } finally {
    await t.close();
  }
});
test('malformed or foreign-channel answer is refused with a Polish message, nothing listed', async () => {
  for (const bad of [
    { channel_id: CH, scope: 'external_sandbox', count: 1, data: [{ ...point, raw: 'x', id: '' }] },
    { channel_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', scope: 'external_api', count: 1, data: [point] },
    { channel_id: CH, scope: 'external_api', count: 1, data: [point], extra: 1 },
  ]) {
    const t = await mount(bad);
    try {
      assert.match(t.target.querySelector('[role="alert"]')!.textContent!, /niepoprawna/);
      assert.ok(!t.target.textContent!.includes('Marszałkowska'));
    } finally {
      await t.close();
    }
  }
});
