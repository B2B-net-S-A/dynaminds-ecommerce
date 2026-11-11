import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

// Mounted packing weight field with a fake navigator.serial port; a physical scale is not exercised.
async function until(fn, note) {
  for (let i = 0; i < 200; i++) {
    if (fn()) return;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  }
  assert.ok(fn(), note);
}
const domError = (name) => Object.assign(new Error(name), { name });
const enc = new TextEncoder();

test('scale weight button', async (t) => {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://127.0.0.1/' }),
    saved = new Map();
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    localStorage: dom.window.localStorage,
    HTMLElement: dom.window.HTMLElement,
    Event: dom.window.Event,
    MouseEvent: dom.window.MouseEvent,
    fetch: undefined,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const vite = await createServer({ server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: 'custom', logLevel: 'error' });
  const { createRoot } = await import('react-dom/client'),
    scale = await vite.ssrLoadModule(path.resolve('web/scale-weight.tsx')),
    form = await vite.ssrLoadModule(path.resolve('web/packing-measurements.tsx'));
  const mounts = [];

  /** Fake Web Serial: `frames` are sent one chunk every 20 ms after open. */
  function serial({ frames = [], granted = false, requestError, openError } = {}) {
    const s = { requested: 0, opened: [], closed: 0, written: '', cancelled: 0 };
    const port = {
      readable: null,
      writable: new WritableStream({ write: (chunk) => void (s.written += new TextDecoder().decode(chunk)) }),
      async open(options) {
        if (openError) throw domError(openError);
        s.opened.push(options);
        let i = 0, timer;
        port.readable = new ReadableStream({
          pull(controller) {
            return new Promise((r) => {
              timer = setTimeout(() => {
                if (i < frames.length) controller.enqueue(enc.encode(frames[i++]));
                r();
              }, 20);
            });
          },
          cancel() {
            clearTimeout(timer);
            s.cancelled++;
          },
        });
      },
      async close() {
        s.closed++;
      },
    };
    Object.defineProperty(dom.window.navigator, 'serial', {
      configurable: true,
      value: {
        async getPorts() {
          return granted ? [port] : [];
        },
        async requestPort() {
          s.requested++;
          if (requestError) throw domError(requestError);
          return port;
        },
      },
    });
    return s;
  }
  function reset() {
    delete dom.window.navigator.serial;
    delete dom.window.isSecureContext;
    dom.window.localStorage.clear();
    globalThis.fetch = undefined;
  }
  function harness(container, root) {
    const h = {
      container,
      weights: [],
      text: () => container.textContent,
      button: (label) => [...container.querySelectorAll('button')].find((b) => b.textContent.trim() === label),
      alert: () => [...container.querySelectorAll('[role="alert"]')].map((n) => n.textContent).join(' '),
      status: () => container.querySelector('.scale-weight-ok')?.textContent,
      weightInput: () => container.querySelector('input[inputmode="decimal"]'),
      select: (label) => [...container.querySelectorAll('label')].find((l) => l.textContent.startsWith(label))?.querySelector('select, input'),
      async close() {
        await act(async () => root.unmount());
        container.remove();
      },
    };
    mounts.push(h);
    return h;
  }
  async function mountButton(props = {}) {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const h = harness(container, root);
    await act(async () =>
      root.render(React.createElement(scale.ScaleWeightButton, { onWeight: (g) => h.weights.push(g), timeoutMs: 300, ...props })),
    );
    return h;
  }
  async function mountForm(props = {}) {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const h = harness(container, root);
    h.changes = [];
    function Host() {
      const [draft, setDraft] = React.useState({ weight_kg: '', length_cm: '30', width_cm: '20', height_cm: '10' });
      return React.createElement(form.PackingMeasurementsForm, {
        draft,
        onChange: (next, validation, source) => {
          h.changes.push({ next, validation, source });
          setDraft(next);
        },
        ...props,
      });
    }
    await act(async () => root.render(React.createElement(Host)));
    return h;
  }
  async function click(el) {
    assert.ok(el, 'element exists');
    await act(async () => el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
  }
  async function choose(el, value) {
    assert.ok(el, 'control exists');
    await act(async () => {
      el.value = value;
      el.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    });
  }

  try {
    await t.test('without Web Serial only a Polish note is shown and manual weight entry stays', async () => {
      reset();
      const h = await mountForm();
      assert.equal(h.button('Pobierz z wagi'), undefined);
      assert.match(h.text(), /Ta przeglądarka nie obsługuje połączenia z wagą \(Web Serial działa w Chrome i Edge na komputerze; Safari i Firefox go nie mają\)\. Wpisz masę ręcznie\./);
      assert.ok(h.weightInput());
      assert.equal(h.weightInput().readOnly, false);
      await h.close();
    });

    await t.test('an insecure page explains that the scale needs HTTPS', async () => {
      reset();
      serial();
      dom.window.isSecureContext = false;
      const h = await mountButton();
      assert.match(h.text(), /Połączenie z wagą działa tylko przez HTTPS lub na localhost/);
      assert.equal(h.button('Pobierz z wagi'), undefined);
      await h.close();
    });

    await t.test('a stable frame fills the weight field in kg and reports grams', async () => {
      reset();
      const s = serial({ frames: ['US,GS,+  1.200kg\r\n', 'ST,GS,+  1.2', '34kg\r\n'] });
      const h = await mountForm();
      await click(h.button('Pobierz z wagi'));
      await until(() => !!h.status(), 'status shown');
      assert.equal(h.status(), 'Pobrano z wagi: 1,234 kg (1234 g).');
      assert.equal(h.weightInput().value, '1,234');
      const last = h.changes.at(-1);
      assert.equal(last.source, 'scale');
      assert.equal(last.validation.measurements.weight_grams, 1234);
      assert.equal(s.requested, 1);
      assert.deepEqual(s.opened, [{ baudRate: 9600, dataBits: 8, stopBits: 1, parity: 'none' }]);
      assert.equal(s.closed, 1, 'port released after the read');
      assert.equal(s.written, '', 'no command in continuous mode');
      assert.ok(h.button('Pobierz z wagi'), 'ready for the next parcel');
      await h.close();
    });

    await t.test('while reading the button is busy and a second click does not open the port again', async () => {
      reset();
      const s = serial({ frames: ['   1.000 kg\r\n', '   1.000 kg\r\n', '   1.000 kg\r\n'], granted: true });
      const h = await mountButton();
      await click(h.button('Pobierz z wagi'));
      const busy = h.button('Czytam wagę…');
      assert.ok(busy?.disabled, 'busy state');
      await click(busy);
      await until(() => h.weights.length === 1, 'read after repeats');
      assert.deepEqual(h.weights, [1000]);
      assert.equal(s.opened.length, 1);
      assert.equal(s.requested, 0, 'previously granted port is reused without a prompt');
      await h.close();
    });

    await t.test('only unstable frames time out without filling the field', async () => {
      reset();
      const s = serial({ frames: Array(30).fill('US,GS,+  1.200kg\r\n') });
      const h = await mountButton();
      await click(h.button('Pobierz z wagi'));
      await until(() => !!h.alert(), 'unstable message');
      assert.match(h.alert(), /^Odczyt z wagi jest niestabilny\. Poczekaj, aż paczka przestanie się ruszać, i spróbuj ponownie\. Wpisz masę ręcznie\.$/);
      assert.deepEqual(h.weights, []);
      assert.equal(s.closed, 1);
      assert.ok(s.cancelled >= 1, 'reader cancelled');
      await h.close();
    });

    await t.test('overload, negative, zero, garbage and silence have their own messages', async () => {
      for (const [frames, text] of [
        [['OL,GS,+9999.999kg\r\n'], /Waga zgłasza przeciążenie/],
        [['ST,GS,-  0.120kg\r\n'], /Waga pokazuje masę ujemną\. Wytaruj wagę/],
        [['ST,GS,+  0.000kg\r\n'], /Waga pokazuje zero\. Połóż gotową paczkę/],
        [['�xx#@!\r\n'], /Nie rozpoznano danych z wagi\. Sprawdź prędkość transmisji/],
        [[], /Waga nie przesłała danych\. Włącz w wadze transmisję ciągłą/],
      ]) {
        reset();
        serial({ frames });
        const h = await mountButton();
        await click(h.button('Pobierz z wagi'));
        await until(() => !!h.alert(), String(text));
        assert.match(h.alert(), text);
        assert.deepEqual(h.weights, []);
        await h.close();
      }
    });

    await t.test('no port chosen, permission denied and busy port explain the fallback', async () => {
      for (const [options, text] of [
        [{ requestError: 'NotFoundError' }, /^Nie wybrano portu wagi\. .*Wpisz masę ręcznie\.$/],
        [{ requestError: 'SecurityError' }, /^Brak zgody na dostęp do portu wagi\./],
        [{ openError: 'NetworkError' }, /^Port wagi jest zajęty przez inną aplikację/],
      ]) {
        reset();
        serial(options);
        const h = await mountButton();
        await click(h.button('Pobierz z wagi'));
        await until(() => !!h.alert(), String(text));
        assert.match(h.alert(), text);
        assert.deepEqual(h.weights, []);
        assert.ok(h.button('Pobierz z wagi'), 'retry possible');
        await h.close();
      }
    });

    await t.test('settings are stored per browser and used for the port and the request command', async () => {
      reset();
      const s = serial({ frames: ['SI     2.500 kg\r\n'] });
      const h = await mountButton();
      await choose(h.select('Prędkość transmisji'), '4800');
      await choose(h.select('Format ramki'), '7E1');
      await choose(h.select('Polecenie odczytu'), 'SI');
      assert.deepEqual(JSON.parse(localStorage.getItem('dyna.packing.scale.v1')), {
        source: 'serial', baudRate: 4800, frame: '7E1', command: 'SI', bridgeUrl: 'http://127.0.0.1:4120',
      });
      await click(h.button('Pobierz z wagi'));
      await until(() => h.weights.length === 1, 'read');
      assert.deepEqual(h.weights, [2500]);
      assert.deepEqual(s.opened, [{ baudRate: 4800, dataBits: 7, stopBits: 1, parity: 'even' }]);
      assert.match(s.written, /^SI\r\n/);
      await h.close();
      const again = await mountButton();
      assert.equal(again.select('Prędkość transmisji').value, '4800', 'restored after remount');
      await again.close();
    });

    await t.test('the opt-in local bridge works without Web Serial', async () => {
      reset();
      const calls = [];
      let replies = [{ status: 'unstable' }, { status: 'stable', grams: 2500 }];
      globalThis.fetch = async (url, init) => {
        calls.push([url, init.credentials]);
        return new Response(JSON.stringify(replies.shift() ?? { status: 'stable', grams: 2500 }), { status: 200 });
      };
      const h = await mountButton({ timeoutMs: 2000 });
      assert.equal(h.button('Pobierz z wagi'), undefined);
      await choose(h.select('Źródło odczytu'), 'bridge');
      assert.ok(h.select('Adres mostka'));
      await click(h.button('Pobierz z wagi'));
      await until(() => h.weights.length === 1, 'bridge read');
      assert.deepEqual(h.weights, [2500]);
      assert.deepEqual(calls[0], ['http://127.0.0.1:4120/reading', 'omit']);
      assert.equal(calls.length, 2);

      globalThis.fetch = async () => {
        throw new TypeError('Failed to fetch');
      };
      await click(h.button('Pobierz z wagi'));
      await until(() => !!h.alert(), 'bridge down');
      assert.match(h.alert(), /^Mostek wagi nie odpowiada pod adresem http:\/\/127\.0\.0\.1:4120\. Uruchom „npm run scale:bridge”/);

      const address = h.select('Adres mostka');
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
        setter.call(address, 'https://scale.example.com');
        address.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
      });
      assert.match(h.text(), /Adres mostka wagi musi mieć postać http:\/\/127\.0\.0\.1:port/);
      assert.equal(h.button('Pobierz z wagi'), undefined, 'non-loopback bridge refused');
      await h.close();
    });

    await t.test('locked or read-only measurements do not offer the scale', async () => {
      reset();
      serial();
      const disabled = await mountForm({ disabled: true });
      assert.ok(disabled.button('Pobierz z wagi').disabled);
      await disabled.close();
      const readOnly = await mountForm({ readOnly: true });
      assert.equal(readOnly.button('Pobierz z wagi'), undefined);
      assert.equal(readOnly.container.querySelector('.scale-weight'), null);
      await readOnly.close();
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
