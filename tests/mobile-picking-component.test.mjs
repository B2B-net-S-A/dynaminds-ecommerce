import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { webcrypto } from 'node:crypto';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

// Mounted phone picking view with a controlled picking-wave API; no SQL, camera or device proof.
const id = (n) => `${String(n).padStart(8, '0')}-2610-4261-8261-261261261261`;
const wave = id(1),
  workspace = id(9),
  uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const group = (n, location, quantity, scanned = 0) => ({
  product_id: id(100 + n),
  sku: 'SKU-' + n,
  ean: '590000000000' + n,
  name: 'Produkt ' + n,
  location,
  quantity,
  scanned,
  destinations: [
    { order_id: id(200 + n), number: 'ZAM-' + n, slot: n, quantity, scanned, status: 'picking' },
  ],
});
function fixture(groups, state = 'picking') {
  const f = { version: 5, state, groups: structuredClone(groups), posts: [], gets: [], plan: [] };
  f.detail = (scan) => ({
    ...(scan ? { reused: false, scan } : {}),
    wave: { id: wave, name: 'Poranna trasa', state: f.state, version: String(f.version), warehouse_name: 'Główny', warehouse_id: id(2) },
    orders: [],
    groups: structuredClone(f.groups),
    progress: {
      quantity: f.groups.reduce((n, g) => n + g.quantity, 0),
      scanned: f.groups.reduce((n, g) => n + g.scanned, 0),
      cancelled_orders: 0,
    },
    scans: [],
  });
  f.fetch = async (url, init = {}) => {
    const u = new URL(String(url), 'http://127.0.0.1'),
      p = u.pathname.replace(/^\/api/, ''),
      method = init.method ?? 'GET';
    assert.equal(init.headers['X-Workspace-ID'], workspace);
    if (method === 'GET' && p === '/picking-waves/' + wave) {
      f.gets.push(p);
      return Response.json(f.detail());
    }
    if (method === 'GET' && p === '/picking-waves/' + wave + '/scan-result') {
      const prior = f.applied?.get(u.searchParams.get('client_key'));
      return Response.json({ version: String(f.version), state: f.state, scan: prior ?? null });
    }
    if (method === 'POST' && p === '/picking-waves/' + wave + '/scans') {
      const body = JSON.parse(init.body);
      f.posts.push(body);
      const step = f.plan.shift() ?? 'ok';
      if (step === 'network') throw new TypeError('Failed to fetch');
      if (typeof step === 'object') return Response.json({ detail: step.detail }, { status: step.status });
      f.applied ??= new Map();
      if (f.applied.has(body.client_key)) return Response.json({ ...f.detail(f.applied.get(body.client_key)), reused: true });
      if (body.version !== String(f.version))
        return Response.json({ detail: 'Partia zmieniła się. Odśwież przed kolejnym skanem.' }, { status: 409 });
      const g = f.groups.find((x) => x.location === body.location && [x.sku, x.ean].includes(body.code));
      if (!g) return Response.json({ detail: 'Kod nie należy do tej partii' }, { status: 422 });
      g.scanned++;
      g.destinations[0].scanned++;
      f.version++;
      const scan = { order_id: g.destinations[0].order_id, number: g.destinations[0].number, slot: g.destinations[0].slot, product_id: g.product_id, sku: g.sku, location: g.location, version: String(f.version) };
      f.applied.set(body.client_key, scan);
      if (step === 'lost') throw new TypeError('Failed to fetch');
      return Response.json(f.detail(scan));
    }
    throw Error('Unexpected ' + method + ' ' + p);
  };
  return f;
}
async function until(fn, note) {
  for (let i = 0; i < 100; i++) {
    if (fn()) return;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
  assert.ok(fn(), note);
}

test('mobile picking view', async (t) => {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://127.0.0.1/' }),
    saved = new Map(),
    oldFetch = globalThis.fetch;
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Event: dom.window.Event,
    KeyboardEvent: dom.window.KeyboardEvent,
    MouseEvent: dom.window.MouseEvent,
    sessionStorage: dom.window.sessionStorage,
    localStorage: dom.window.localStorage,
    crypto: webcrypto,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const vite = await createServer({ server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: 'custom', logLevel: 'error' });
  const { createRoot } = await import('react-dom/client'),
    ui = await vite.ssrLoadModule(path.resolve('web/mobile-picking.tsx')),
    model = await vite.ssrLoadModule(path.resolve('web/mobile-picking-model.ts')),
    api = await vite.ssrLoadModule(path.resolve('web/api.ts'));
  const mounts = [];
  async function mount(f, props = {}) {
    globalThis.fetch = f.fetch;
    api.setWorkspace(workspace);
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const h = {
      container,
      closed: 0,
      text: () => container.textContent,
      input: () => container.querySelector('.mpick-scan input'),
      button: (label) => [...container.querySelectorAll('button')].find((b) => b.textContent.trim() === label),
      bin: () => container.querySelector('.mpick-bin strong')?.textContent,
      async close() {
        await act(async () => root.unmount());
        container.remove();
      },
    };
    mounts.push(h);
    await act(async () =>
      root.render(React.createElement(ui.MobilePicking, { waveId: wave, workspaceId: workspace, write: true, onClose: () => h.closed++, ...props })),
    );
    await until(() => h.bin() || h.text().includes('Wszystko zebrane') || h.text().includes('zamknięta'), 'wave read');
    return h;
  }
  async function type(el, value) {
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(el, value);
      el.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
  }
  async function key(el, name, extra = {}) {
    let event;
    await act(async () => {
      event = new dom.window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...extra });
      el.dispatchEvent(event);
    });
    return event;
  }
  async function click(el) {
    assert.ok(el, 'button exists');
    await act(async () => el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
  }
  const settle = (f, n) => until(() => f.posts.length === n && !document.querySelector('.mpick-scan input')?.disabled, 'scan settled');
  try {
    await t.test('queue follows numeric location order, skips done tasks and puts skipped ones last', () => {
      const groups = [group(1, 'B1', 1), group(2, 'A10', 2), group(3, 'A2', 1, 1), group(4, 'A2', 3)];
      assert.deepEqual(model.pickQueue(groups).map((g) => g.location + ':' + g.sku), ['A2:SKU-4', 'A10:SKU-2', 'B1:SKU-1']);
      assert.deepEqual(model.pickQueue(groups, [model.groupKey(groups[3])]).map((g) => g.sku), ['SKU-2', 'SKU-1', 'SKU-4']);
      assert.deepEqual(model.pickStats(groups), { tasks: 4, tasksDone: 1, pieces: 7, scanned: 1 });
      assert.equal(model.scanPayload({ wave: { version: '7' } }, '   ', 'A2', id(5)), 'Zeskanuj lub wpisz kod produktu.');
      assert.match(model.scanPayload({ wave: { version: '7' } }, 'x'.repeat(81), 'A2', id(5)), /ponad 80 znaków/);
      assert.deepEqual(model.scanPayload({ wave: { version: '7' } }, ' 590 ', 'A2', id(5)), { version: '7', code: '590', location: 'A2', client_key: id(5) });
    });

    await t.test('one location at a time with progress and the next locations listed', async () => {
      const f = fixture([group(1, 'B1', 1), group(2, 'A10', 2), group(3, 'A2', 1, 1), group(4, 'A2', 3)]);
      const h = await mount(f);
      assert.equal(h.bin(), 'A2');
      assert.ok(h.text().includes('Produkt 4'));
      assert.ok(h.text().includes('1 / 7 szt.'));
      assert.ok(h.text().includes('Pozycje zebrane: 1 z 4'));
      assert.deepEqual([...h.container.querySelectorAll('.mpick-next li strong')].map((e) => e.textContent), ['A10', 'B1']);
      await click(h.button('Pomiń — wróć do tej pozycji na końcu'));
      assert.equal(h.bin(), 'A10');
      assert.deepEqual([...h.container.querySelectorAll('.mpick-next li strong')].map((e) => e.textContent), ['B1', 'A2']);
      assert.equal(f.posts.length, 0, 'skipping never writes');
      await h.close();
    });

    await t.test('Enter submits version, code, task location and a fresh client_key; receipt shows the basket', async () => {
      const f = fixture([group(1, 'A1', 2), group(2, 'B2', 1)]);
      const h = await mount(f);
      await type(h.input(), ' 5900000000001 ');
      const enter = await key(h.input(), 'Enter');
      assert.ok(enter.defaultPrevented);
      await settle(f, 1);
      assert.deepEqual(Object.keys(f.posts[0]).sort(), ['client_key', 'code', 'location', 'version']);
      assert.equal(f.posts[0].version, '5');
      assert.equal(f.posts[0].code, '5900000000001');
      assert.equal(f.posts[0].location, 'A1');
      assert.match(f.posts[0].client_key, uuid);
      assert.equal(h.container.querySelector('.mpick-receipt strong').textContent, '1');
      assert.ok(h.text().includes('1 / 3 szt.'));
      assert.equal(h.input().value, '', 'code cleared for the next scan');
      assert.equal(sessionStorage.getItem(model.waveScanStorageKey(workspace, wave)), null);
      // Tab suffix from a wedge scanner submits too, with the version returned by the previous scan.
      await type(h.input(), 'SKU-1');
      const tab = await key(h.input(), 'Tab');
      assert.ok(tab.defaultPrevented);
      await settle(f, 2);
      assert.equal(f.posts[1].version, '6');
      assert.notEqual(f.posts[1].client_key, f.posts[0].client_key);
      assert.equal(h.bin(), 'B2', 'finished location advances to the next one');
      await h.close();
    });

    await t.test('Tab on an empty field, Shift+Tab and key repeat do not submit', async () => {
      const f = fixture([group(1, 'A1', 2)]);
      const h = await mount(f);
      assert.equal((await key(h.input(), 'Tab')).defaultPrevented, false);
      await type(h.input(), 'SKU-1');
      assert.equal((await key(h.input(), 'Tab', { shiftKey: true })).defaultPrevented, false);
      await key(h.input(), 'Enter', { repeat: true });
      await act(async () => new Promise((r) => setTimeout(r, 0)));
      assert.equal(f.posts.length, 0);
      await h.close();
    });

    await t.test('a rejected code shows the server message and leaves no pending scan', async () => {
      const f = fixture([group(1, 'A1', 2)]);
      const h = await mount(f);
      await type(h.input(), 'OBCY-KOD');
      await key(h.input(), 'Enter');
      await settle(f, 1);
      assert.equal(h.container.querySelector('[role="alert"]').textContent, 'Kod nie należy do tej partii');
      assert.equal(h.container.querySelector('.mpick-notice'), null);
      assert.equal(sessionStorage.getItem(model.waveScanStorageKey(workspace, wave)), null);
      assert.equal(h.input().disabled, false, 'operator can scan again at once');
      await h.close();
    });

    await t.test('a version conflict re-reads the wave', async () => {
      const f = fixture([group(1, 'A1', 2)]);
      const h = await mount(f);
      f.version = 8; // another device scanned meanwhile
      await type(h.input(), 'SKU-1');
      await key(h.input(), 'Enter');
      await settle(f, 1);
      await until(() => f.gets.length === 2, 'wave re-read after 409');
      assert.match(h.container.querySelector('[role="alert"]').textContent, /Partia zmieniła się/);
      await type(h.input(), 'SKU-1');
      await key(h.input(), 'Enter');
      await settle(f, 2);
      assert.equal(f.posts[1].version, '8');
      await h.close();
    });

    await t.test('a lost response keeps the scan pending and retries with the same client_key', async () => {
      const f = fixture([group(1, 'A1', 3)]);
      f.plan.push('lost');
      const h = await mount(f);
      await type(h.input(), 'SKU-1');
      await key(h.input(), 'Enter');
      await until(() => !!h.container.querySelector('.mpick-notice'), 'pending notice');
      assert.match(h.container.querySelector('[role="alert"]').textContent, /Brak potwierdzenia skanu/);
      const stored = JSON.parse(sessionStorage.getItem(model.waveScanStorageKey(workspace, wave)));
      assert.equal(stored.client_key, f.posts[0].client_key);
      assert.equal(h.input().disabled, true, 'no new scan while one is unconfirmed');
      await click(h.button('Ponów ten sam skan'));
      await until(() => !h.container.querySelector('.mpick-notice'), 'pending cleared');
      assert.equal(f.posts[1].client_key, f.posts[0].client_key);
      assert.deepEqual(f.posts[1], f.posts[0]);
      assert.equal(f.groups[0].scanned, 1, 'the retry did not count the piece twice');
      assert.equal(sessionStorage.getItem(model.waveScanStorageKey(workspace, wave)), null);
      await h.close();
    });

    await t.test('a stored pending scan from the desktop board is recovered via scan-result', async () => {
      const f = fixture([group(1, 'A1', 3)]);
      const key = id(77);
      f.applied = new Map([[key, { order_id: id(201), number: 'ZAM-1', slot: 4, product_id: id(101), sku: 'SKU-1', location: 'A1', version: '5' }]]);
      sessionStorage.setItem(model.waveScanStorageKey(workspace, wave), JSON.stringify({ version: '4', code: 'SKU-1', location: 'A1', client_key: key }));
      const h = await mount(f);
      assert.ok(h.container.querySelector('.mpick-notice'));
      await click(h.button('Sprawdź wynik'));
      await until(() => !h.container.querySelector('.mpick-notice'), 'recovered');
      assert.equal(h.container.querySelector('.mpick-receipt strong').textContent, '4');
      assert.equal(f.posts.length, 0);
      await h.close();
    });

    await t.test('read-only, closed and finished waves offer no scan input', async () => {
      const ro = await mount(fixture([group(1, 'A1', 1)]), { write: false });
      assert.equal(ro.input(), null);
      assert.ok(ro.text().includes('tylko do odczytu'));
      await ro.close();
      const closed = await mount(fixture([group(1, 'A1', 1)], 'cancelled'));
      assert.equal(closed.input(), null);
      assert.ok(closed.text().includes('Partia jest zamknięta'));
      await closed.close();
      const done = await mount(fixture([group(1, 'A1', 1, 1)]));
      assert.ok(done.text().includes('Wszystko zebrane'));
      await click(done.button('Wróć do partii'));
      assert.equal(done.closed, 1);
      await done.close();
    });

    await t.test('a camera read submits the scan for the current location', async () => {
      const track = { stopped: 0, stop() { this.stopped++; } };
      globalThis.BarcodeDetector = class {
        async detect() { return [{ rawValue: '5900000000001', format: 'ean_13' }]; }
      };
      Object.defineProperty(dom.window.navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => ({ getTracks: () => [track] }) } });
      dom.window.HTMLMediaElement.prototype.play = async () => {};
      try {
        const f = fixture([group(1, 'A1', 2)]);
        const h = await mount(f);
        await click(h.button('Skanuj kod aparatem'));
        await settle(f, 1);
        assert.equal(f.posts[0].code, '5900000000001');
        assert.equal(f.posts[0].location, 'A1');
        assert.equal(f.posts[0].version, '5');
        assert.equal(track.stopped, 1, 'camera released before the write');
        assert.equal(h.container.querySelector('.mpick-receipt strong').textContent, '1');
        await h.close();
      } finally {
        delete globalThis.BarcodeDetector;
        delete dom.window.navigator.mediaDevices;
      }
    });

    await t.test('desktop wave board opens the phone view and accepts a Tab-suffixed location scan', async () => {
      const board = await vite.ssrLoadModule(path.resolve('web/picking-waves.tsx'));
      const f = fixture([group(1, 'A1', 2)]),
        inner = f.fetch;
      f.fetch = async (url, init = {}) => {
        const p = new URL(String(url), 'http://127.0.0.1').pathname.replace(/^\/api/, '');
        if (p === '/warehouses') return Response.json({ data: [{ id: id(2), name: 'Główny' }] });
        if (p === '/picking-waves') return Response.json({ data: [{ id: wave, name: 'Poranna trasa', state: 'picking', order_count: 1, created_at: '2026-10-23T08:00:00Z' }], next: null });
        if (p === '/picking-waves/candidates') return Response.json({ data: [], next: null });
        return inner(url, init);
      };
      globalThis.fetch = f.fetch;
      api.setWorkspace(workspace);
      const container = document.createElement('div');
      document.body.append(container);
      const root = createRoot(container);
      const button = (label) => [...container.querySelectorAll('button')].find((b) => b.textContent.trim() === label);
      await act(async () => root.render(React.createElement(board.PickingWorkspace, { individual: null, refresh: 0, workspaceId: workspace, write: true, onOrder: () => {} })));
      await until(() => !![...container.querySelectorAll('.wave-list button')].length, 'wave list');
      await click(container.querySelector('.wave-list button'));
      await until(() => !!button('Zbieraj na telefonie'), 'wave detail');
      await click(button('Zbieraj na telefonie'));
      await until(() => container.querySelector('.mpick .mpick-bin strong')?.textContent === 'A1', 'phone view');
      await click(button('← Partia'));
      await until(() => !container.querySelector('.mpick'), 'phone view closed');
      const [codeField, locationField] = container.querySelectorAll('.wave-scan input');
      await type(codeField, 'SKU-1');
      await type(locationField, 'A1');
      const tab = await key(locationField, 'Tab');
      assert.ok(tab.defaultPrevented, 'Tab suffix on the last field submits');
      await until(() => f.posts.length === 1 && !codeField.disabled, 'desktop scan');
      assert.equal(f.posts[0].code, 'SKU-1');
      assert.equal(f.posts[0].location, 'A1');
      assert.equal(document.activeElement, codeField, 'focus returns to the code field for the next scan');
      assert.equal(sessionStorage.getItem(model.waveScanStorageKey(workspace, wave)), null);
      await act(async () => root.unmount());
      container.remove();
    });

    await t.test('without BarcodeDetector the text input stays with a Polish fallback note', async () => {
      const h = await mount(fixture([group(1, 'A1', 1)]));
      assert.ok(h.input());
      assert.match(h.container.querySelector('.scanner-note').textContent, /nie obsługuje skanowania kodów aparatem/);
      assert.equal(h.button('Skanuj kod aparatem'), undefined);
      await h.close();
    });
  } finally {
    for (const h of mounts) if (h.container.isConnected) await h.close();
    await vite.close();
    dom.window.close();
    globalThis.fetch = oldFetch;
    for (const [key, descriptor] of saved)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
  }
});
