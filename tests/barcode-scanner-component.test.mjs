import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

// Mounted camera scanner with fake BarcodeDetector/getUserMedia; a real phone camera is not exercised.
async function until(fn, note) {
  for (let i = 0; i < 150; i++) {
    if (fn()) return;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  }
  assert.ok(fn(), note);
}
const domError = (name) => Object.assign(new Error(name), { name });

test('barcode scanner component', async (t) => {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://127.0.0.1/' }),
    saved = new Map();
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Event: dom.window.Event,
    MouseEvent: dom.window.MouseEvent,
    BarcodeDetector: undefined,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  dom.window.HTMLMediaElement.prototype.play = async () => {};
  const vite = await createServer({ server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: 'custom', logLevel: 'error' });
  const { createRoot } = await import('react-dom/client'),
    ui = await vite.ssrLoadModule(path.resolve('web/barcode-scanner.tsx'));
  const mounts = [];
  function camera({ formats = ['ean_13', 'code_128', 'qr_code', 'aztec'], reads = [[]], denied } = {}) {
    const c = { requests: [], stopped: 0, detectorFormats: null, detects: 0 };
    const track = { stop: () => c.stopped++ };
    globalThis.BarcodeDetector = class {
      constructor(options) {
        c.detectorFormats = options.formats;
      }
      static async getSupportedFormats() {
        return formats;
      }
      async detect(source) {
        assert.equal(source.tagName, 'VIDEO');
        return reads[Math.min(c.detects++, reads.length - 1)];
      }
    };
    Object.defineProperty(dom.window.navigator, 'mediaDevices', {
      configurable: true,
      value: {
        async getUserMedia(constraints) {
          c.requests.push(constraints);
          if (denied) throw domError(denied);
          return { getTracks: () => [track] };
        },
      },
    });
    return c;
  }
  async function mount(props = {}) {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const h = {
      container,
      reads: [],
      text: () => container.textContent,
      button: (label) => [...container.querySelectorAll('button')].find((b) => b.textContent.trim() === label),
      alert: () => container.querySelector('[role="alert"]')?.textContent,
      async close() {
        await act(async () => root.unmount());
        container.remove();
      },
    };
    mounts.push(h);
    // The host keeps its own text input; the scanner only adds the camera path next to it.
    await act(async () =>
      root.render(
        React.createElement('form', null,
          React.createElement('input', { 'aria-label': 'Kod produktu' }),
          React.createElement(ui.BarcodeScanner, { onDetected: (code) => h.reads.push(code), ...props }),
        ),
      ),
    );
    return h;
  }
  async function click(el) {
    assert.ok(el, 'button exists');
    await act(async () => el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
  }
  function reset() {
    globalThis.BarcodeDetector = undefined;
    delete dom.window.navigator.mediaDevices;
    delete dom.window.isSecureContext;
  }
  try {
    await t.test('without BarcodeDetector only a Polish fallback note is shown next to the input', async () => {
      reset();
      const h = await mount();
      assert.equal(h.container.querySelectorAll('button').length, 0);
      assert.match(h.text(), /Ta przeglądarka nie obsługuje skanowania kodów aparatem\. Wpisz kod ręcznie albo użyj skanera USB\/Bluetooth\./);
      assert.ok(h.container.querySelector('input[aria-label="Kod produktu"]'));
      await h.close();
    });

    await t.test('an insecure page explains that the camera needs HTTPS', async () => {
      reset();
      camera();
      dom.window.isSecureContext = false;
      const h = await mount();
      assert.match(h.text(), /Aparat działa tylko przez HTTPS lub na localhost/);
      await h.close();
    });

    await t.test('permission denied shows a clear message, reads nothing and allows a retry', async () => {
      reset();
      const c = camera({ denied: 'NotAllowedError' });
      const h = await mount();
      await click(h.button('Skanuj aparatem'));
      await until(() => !!h.alert(), 'denied message');
      assert.match(h.alert(), /^Brak zgody na użycie aparatu\. Zezwól na dostęp w ustawieniach przeglądarki\. Wpisz kod ręcznie/);
      assert.deepEqual(c.requests, [{ video: { facingMode: { ideal: 'environment' } }, audio: false }]);
      assert.deepEqual(h.reads, []);
      assert.ok(h.container.querySelector('.scanner-view').hidden, 'viewfinder closed');
      assert.ok(h.button('Spróbuj aparatu ponownie'));
      await h.close();
    });

    await t.test('missing camera and busy camera have their own messages', async () => {
      for (const [name, text] of [['NotFoundError', /Nie znaleziono aparatu/], ['NotReadableError', /Aparat jest zajęty/]]) {
        reset();
        camera({ denied: name });
        const h = await mount();
        await click(h.button('Skanuj aparatem'));
        await until(() => !!h.alert(), name);
        assert.match(h.alert(), text);
        await h.close();
      }
    });

    await t.test('a detector without the warehouse formats falls back without opening the camera', async () => {
      reset();
      const c = camera({ formats: ['aztec', 'pdf417'] });
      const h = await mount();
      await click(h.button('Skanuj aparatem'));
      await until(() => !!h.alert(), 'formats message');
      assert.match(h.alert(), /nie rozpoznaje kodów EAN, Code 128 ani QR/);
      assert.equal(c.requests.length, 0);
      await h.close();
    });

    await t.test('back camera read is reported once, trimmed, and the camera is released', async () => {
      reset();
      const c = camera({ reads: [[], [{ rawValue: ' 5901234123457 ', format: 'ean_13' }]] });
      const h = await mount();
      await click(h.button('Skanuj aparatem'));
      await until(() => h.reads.length === 1, 'detected');
      assert.deepEqual(h.reads, ['5901234123457']);
      assert.deepEqual(c.detectorFormats, ['ean_13', 'code_128', 'qr_code']);
      assert.equal(c.stopped, 1);
      assert.ok(h.container.querySelector('.scanner-view').hidden);
      await act(async () => new Promise((r) => setTimeout(r, 300)));
      assert.equal(h.reads.length, 1, 'single read per tap');
      assert.ok(h.button('Skanuj aparatem'));
      await h.close();
    });

    await t.test('stopping or disabling the scanner releases the camera without a read', async () => {
      reset();
      const c = camera({ reads: [[]] });
      const h = await mount();
      await click(h.button('Skanuj aparatem'));
      await until(() => !!h.button('Zatrzymaj aparat') && c.requests.length === 1 && c.detects > 0, 'scanning');
      await click(h.button('Zatrzymaj aparat'));
      assert.equal(c.stopped, 1);
      const seen = c.detects;
      await act(async () => new Promise((r) => setTimeout(r, 300)));
      assert.equal(c.detects, seen, 'polling stopped');
      assert.deepEqual(h.reads, []);
      await h.close();
    });
  } finally {
    for (const h of mounts) if (h.container.isConnected) await h.close();
    await vite.close();
    dom.window.close();
    for (const [key, descriptor] of saved)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
  }
});
