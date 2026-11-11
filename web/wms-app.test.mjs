/** Packer module (/wms): real WmsApp component, mocked fetch; no server, no PG. Run: node --test web/wms-app.test.mjs */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

const id = (n) => n.toString(16).padStart(8, '0') + '-1000-4000-8000-000000000001';
const today = new Date().toISOString();
const yesterday = new Date(Date.now() - 36 * 3600e3).toISOString();
const row = (n, status, extra = {}) => ({
  id: id(n), number: 'DE-' + n, status, version: '3', customer_name: 'Klient ' + n, note: '', item_count: 1,
  address: { city: 'Warszawa' }, payment_mode: 'prepaid', total: 1000, currency: 'PLN',
  created_at: `2026-11-0${n % 9 + 1}T10:00:00Z`, updated_at: today, ...extra,
});
const line = (extra = {}) => ({ id: id(90), product_id: id(91), sku: 'SKU-1', ean: '5901', name: 'Młynek', quantity: 1, scanned: 0,
  locations: [{ location: 'A-01', state: 'active', scanned: 0, quantity: 1 }], ...extra });
const detail = (base, extra = {}) => ({ ...base, items: [{ name: 'Młynek', sku: 'SKU-1', quantity: 1 }], picking_items: [line()],
  events: [], shipments: [], ...extra });

test('WMS packer module', async (t) => {
  const dom = new JSDOM('<body/>', { url: 'http://127.0.0.1:4106/wms' }), prior = new Map(), oldFetch = globalThis.fetch;
  for (const [k, v] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Event: dom.window.Event, IS_REACT_ACT_ENVIRONMENT: true })) {
    prior.set(k, Object.getOwnPropertyDescriptor(globalThis, k));
    Object.defineProperty(globalThis, k, { configurable: true, writable: true, value: v });
  }
  const vite = await createServer({ server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: 'custom', logLevel: 'error' });
  const api = await vite.ssrLoadModule(path.resolve('web/api.ts'));
  const { WmsApp, isWmsPath, wmsOrderRef } = await vite.ssrLoadModule(path.resolve('web/wms-app.tsx'));
  const { createRoot } = await import('react-dom/client');
  api.setWorkspace(id(2));
  let requests = [], handler;
  globalThis.fetch = async (url, init = {}) => {
    const r = { url: String(url), method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : undefined };
    requests.push(r);
    const answer = await handler(r);
    if (answer === 'network') throw new TypeError('Failed to fetch'); // the request may have reached the server
    const [status, body] = answer;
    return Response.json(body, { status });
  };
  const gate = () => { let open; const p = new Promise((r) => { open = r; }); return { p, open }; };
  const orderGets = (oid) => requests.filter((r) => r.method === 'GET' && r.url.endsWith(`/orders/${oid}`)).length;
  const settle = () => act(async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0)); });
  const roots = new Set();
  async function mount(props = {}) {
    const el = document.createElement('div');
    document.body.append(el);
    const root = createRoot(el);
    roots.add(root);
    await act(async () => root.render(React.createElement(WmsApp, { user: { id: id(6), tenant_id: id(2), name: 'Kamil', role: 'operator' },
      readOnly: false, onLogout: () => {}, onOffice: () => {}, ...props })));
    await settle();
    return { el, async close() { await act(async () => root.unmount()); roots.delete(root); el.remove(); } };
  }
  const button = (h, text) => [...h.el.querySelectorAll('button')].find((b) => b.textContent.trim().startsWith(text));
  const click = async (b) => { assert(b, 'button exists'); await act(async () => b.click()); await settle(); };
  const type = async (input, value) => {
    const set = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
    await act(async () => { set.call(input, value); input.dispatchEvent(new dom.window.Event('input', { bubbles: true })); });
  };
  const submit = async (form) => { await act(async () => form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }))); await settle(); };

  const fresh = row(1, 'paid', { created_at: '2026-11-01T08:00:00Z' }), started = row(2, 'picking', { created_at: '2026-11-03T08:00:00Z', note: 'Pakować osobno' });
  const lists = (r) => {
    const q = new URL(r.url, 'http://x').searchParams.get('status');
    if (q === 'paid,picking') return [200, { data: [started, fresh], meta: { has_more: false } }]; // API order: newest first
    if (q === 'packed') return [200, { data: [row(3, 'packed')], meta: { has_more: false } }];
    if (q === 'shipped') return [200, { data: [row(4, 'shipped'), row(5, 'shipped', { updated_at: yesterday })], meta: { has_more: false } }];
    return null;
  };
  try {
    await t.test('path helper matches /wms only', () => {
      assert.equal(isWmsPath('/wms'), true); assert.equal(isWmsPath('/wms/x'), true); assert.equal(isWmsPath('/wmsx'), false); assert.equal(isWmsPath('/'), false);
    });

    await t.test('tabs render with counts, oldest order first, returns disabled', async () => {
      requests = [];
      handler = (r) => lists(r) ?? (r.url.includes('/orders/') ? [200, detail(fresh)] : [404, { detail: 'brak' }]);
      const h = await mount();
      const tabs = [...h.el.querySelectorAll('[role=tab]')].map((b) => b.textContent.replace(/\s+/g, ' ').trim());
      assert.deepEqual(tabs.slice(0, 4), ['Do spakowania 2', 'Spakowane 1', 'Wysłane dziś 1', 'Zwroty wkrótce']);
      assert.equal(button(h, 'Zwroty').disabled, true);
      const numbers = [...h.el.querySelectorAll('.wms-row-id strong')].map((e) => e.textContent);
      assert.deepEqual(numbers, ['DE-1', 'DE-2']);
      assert.match(h.el.textContent, /Pakować osobno/);
      assert(h.el.querySelectorAll('.wms-row .wms-big').length === 2);
      await click(button(h, 'Wysłane dziś'));
      assert.deepEqual([...h.el.querySelectorAll('.wms-row-id strong')].map((e) => e.textContent), ['DE-4']);
      await h.close();
    });

    await t.test('Pakuj on a new order sends PATCH picking before anything else; scan posts the right body', async () => {
      requests = [];
      let current = detail(fresh, { status: 'picking', version: '4' });
      handler = (r) => {
        if (r.method === 'PATCH') return [200, current];
        if (r.method === 'POST' && r.url.endsWith('/scan')) {
          current = { ...current, version: '5', picking_items: [line({ scanned: 1 })] };
          return [200, current];
        }
        return lists(r) ?? [200, current];
      };
      const h = await mount();
      const before = requests.length;
      await click(h.el.querySelector(`button[aria-label="Pakuj DE-1"]`));
      const after = requests.slice(before);
      assert.equal(after[0].method, 'PATCH');
      assert(after[0].url.endsWith(`/api/orders/${fresh.id}/status`));
      assert.deepEqual(after[0].body, { status: 'picking', expected_version: '3' });
      assert.match(h.el.textContent, /0 \/ 1 zeskanowane/);
      const packed = button(h, 'Spakowane');
      assert.equal(packed.disabled, true, 'disabled until all scanned');
      const input = h.el.querySelector('input[placeholder^="Zeskanuj produkt"]');
      assert.equal(document.activeElement, input, 'scan field focused');
      await type(input, ' 5901 ');
      await submit(input.form);
      const scan = requests.find((r) => r.url.endsWith('/scan'));
      assert.deepEqual(scan.body, { code: '5901' }, 'one location, no lots: plain body');
      assert.match(h.el.textContent, /1 \/ 1 zeskanowane/);
      assert.equal(button(h, 'Spakowane').disabled, false);
      assert.equal(document.activeElement, h.el.querySelector('input[placeholder^="Zeskanuj produkt"]'), 'focus returns after scan');
      await h.close();
    });

    await t.test('a printed rule code (AR-…) runs the automation rule for the open order, not a product scan', async () => {
      requests = [];
      const current = detail(fresh, { status: 'picking', version: '4' });
      handler = (r) => {
        if (r.method === 'POST' && r.url.endsWith('/automations/v2/barcode'))
          return [200, { id: 'run-1', rule_name: 'Etykieta InPost', status: 'done', order_id: fresh.id }];
        return lists(r) ?? [200, current];
      };
      const h = await mount();
      await click(h.el.querySelector(`button[aria-label="Pakuj DE-1"]`));
      const input = h.el.querySelector('input[placeholder^="Zeskanuj produkt"]');
      await type(input, 'ar-0a1b2c3d4e');
      await submit(input.form);
      const run = requests.find((r) => r.url.endsWith('/automations/v2/barcode'));
      assert.deepEqual(run.body, { code: 'AR-0A1B2C3D4E', order: fresh.id });
      assert.equal(requests.filter((r) => r.url.endsWith('/scan')).length, 0, 'no product scan for a rule code');
      assert.match(h.el.textContent, /Wykonano akcję „Etykieta InPost”/);
      await h.close();
    });

    await t.test('scan with lots and several bins sends location and client_key', async () => {
      requests = [];
      const two = [{ location: 'A-01', state: 'active', scanned: 1, quantity: 1 }, { location: 'B-02', state: 'active', scanned: 0, quantity: 1 }];
      const current = detail(started, { wms_lots_enabled: true, picking_items: [line({ quantity: 2, scanned: 1, locations: two })] });
      handler = (r) => lists(r) ?? [200, current];
      const h = await mount();
      await click(h.el.querySelector(`button[aria-label="Pakuj DE-2"]`));
      assert(!requests.some((r) => r.method === 'PATCH'), 'picking order opens without a status change');
      const input = h.el.querySelector('input[placeholder^="Zeskanuj produkt"]');
      await type(input, 'SKU-1');
      await submit(input.form);
      const scan = requests.find((r) => r.url.endsWith('/scan'));
      assert.equal(scan.body.code, 'SKU-1');
      assert.equal(scan.body.location, 'B-02');
      assert.match(scan.body.client_key, /^[0-9a-f-]{36}$/);
      assert.match(h.el.querySelector('.wms-note').textContent, /Pakować osobno/);
      await h.close();
    });

    await t.test('409 on scan shows the message, reloads the order and retries the same body; 400 on packed is visible', async () => {
      requests = [];
      let scanStatus = 409;
      const current = detail(started);
      handler = (r) => {
        if (r.url.endsWith('/scan')) return scanStatus === 409 ? [409, { detail: 'Ten produkt jest już skompletowany' }] : [200, { ...current, picking_items: [line({ scanned: 1 })] }];
        if (r.method === 'PATCH') return [400, { detail: 'Uzupełnij pola pakowania' }];
        return lists(r) ?? [200, current];
      };
      const h = await mount();
      await click(h.el.querySelector(`button[aria-label="Pakuj DE-2"]`));
      const input = h.el.querySelector('input[placeholder^="Zeskanuj produkt"]');
      await type(input, '5901');
      const gets = () => requests.filter((r) => r.method === 'GET' && r.url.endsWith(`/orders/${started.id}`)).length;
      const n = gets();
      await submit(input.form);
      assert.match(h.el.querySelector('[role=alert]').textContent, /Ten produkt jest już skompletowany/);
      assert.equal(gets(), n + 1, '409 reloads the order');
      scanStatus = 200;
      await click(button(h, 'Spróbuj ponownie'));
      const scans = requests.filter((r) => r.url.endsWith('/scan'));
      assert.equal(scans.length, 2);
      assert.deepEqual(scans[1].body, scans[0].body);
      assert.equal(h.el.querySelector('[role=alert]'), null);
      await click(button(h, 'Spakowane'));
      const patch = requests.find((r) => r.method === 'PATCH');
      assert.deepEqual(patch.body, { status: 'packed', expected_version: '3' });
      assert.match(h.el.querySelector('[role=alert]').textContent, /Uzupełnij pola pakowania/);
      await h.close();
    });

    await t.test('report a problem adds a [WMS] note through an inline field; packed order ships and returns to the list', async () => {
      requests = [];
      const current = detail(row(3, 'packed'), { picking_items: [line({ scanned: 1 })] });
      handler = (r) => {
        if (r.url.endsWith('/operations')) return [200, { ok: true }];
        if (r.url.endsWith('/ship-demo')) return [200, { ...current, status: 'shipped' }];
        return lists(r) ?? [200, current];
      };
      const h = await mount();
      await click(button(h, 'Spakowane'));
      await click(h.el.querySelector('button[aria-label="Nadaj DE-3"]'));
      await click(button(h, 'Zgłoś problem'));
      const field = h.el.querySelector('#wms-problem-text');
      assert(field.labels[0].textContent.includes('Opisz problem'));
      await type(field, 'Uszkodzone opakowanie');
      await submit(field.form);
      assert.deepEqual(requests.find((r) => r.url.endsWith('/operations')).body, { type: 'add_note', note: '[WMS] Uszkodzone opakowanie' });
      assert.match(h.el.textContent, /Zgłoszenie zapisane/);
      await click(button(h, 'Nadaj przesyłkę'));
      assert(requests.some((r) => r.method === 'POST' && r.url.endsWith(`/orders/${current.id}/ship-demo`)));
      assert.match(h.el.textContent, /Zamówienie DE-3 nadane/);
      assert(h.el.querySelector('[role=tablist]'), 'back on the list');
      await h.close();
    });

    const scanInput = (h) => h.el.querySelector('input[placeholder^="Zeskanuj produkt"]');
    const scanNow = async (h, value) => { await type(scanInput(h), value); await submit(scanInput(h).form); };

    await t.test('scan without an answer reloads the order and offers no blind resend', async () => {
      requests = [];
      let current = detail(started);
      handler = (r) => {
        if (r.url.endsWith('/scan')) { current = { ...current, version: '4', picking_items: [line({ scanned: 1 })] }; return 'network'; }
        return lists(r) ?? [200, current];
      };
      const h = await mount();
      await click(h.el.querySelector(`button[aria-label="Pakuj DE-2"]`));
      const n = orderGets(started.id);
      await scanNow(h, '5901');
      assert.equal(orderGets(started.id), n + 1, 'order reloaded after the unanswered scan');
      assert.match(h.el.querySelector('[role=alert]').textContent, /Nie wiemy, czy skan „5901” dotarł — sprawdź licznik/);
      assert.equal(button(h, 'Spróbuj ponownie'), undefined, 'no resend button');
      assert.match(h.el.textContent, /1 \/ 1 zeskanowane/, 'the real count from the server');
      assert.equal(requests.filter((r) => r.url.endsWith('/scan')).length, 1);
      await h.close();
    });

    await t.test('problem report without an answer: a note already saved is not offered again', async () => {
      requests = [];
      let current = detail(started);
      handler = (r) => {
        if (r.url.endsWith('/operations')) { current = { ...current, note: `${current.note}\n${r.body.note}` }; return [502, { detail: 'Bad gateway' }]; }
        return lists(r) ?? [200, current];
      };
      const h = await mount();
      await click(h.el.querySelector(`button[aria-label="Pakuj DE-2"]`));
      await click(button(h, 'Zgłoś problem'));
      await type(h.el.querySelector('#wms-problem-text'), 'Brak towaru');
      await submit(h.el.querySelector('#wms-problem-text').form);
      assert.equal(h.el.querySelector('[role=alert]'), null);
      assert.match(h.el.textContent, /Zgłoszenie zapisane/);
      assert.equal(requests.filter((r) => r.url.endsWith('/operations')).length, 1);
      await h.close();
    });

    await t.test('a queued scan picks its bin from the order after the previous scan', async () => {
      requests = [];
      const bins = [{ location: 'A-01', state: 'active', scanned: 0, quantity: 1 }, { location: 'B-02', state: 'active', scanned: 0, quantity: 1 }];
      let current = detail(started, { picking_items: [line({ quantity: 2, locations: bins })] });
      const first = gate();
      let calls = 0;
      handler = async (r) => {
        if (r.url.endsWith('/scan')) {
          if (calls++ === 0) await first.p;
          const l = current.picking_items[0];
          current = { ...current, picking_items: [{ ...l, scanned: l.scanned + 1,
            locations: l.locations.map((b) => (b.location === r.body.location ? { ...b, scanned: b.scanned + 1 } : b)) }] };
          return [200, current];
        }
        return lists(r) ?? [200, current];
      };
      const h = await mount();
      await click(h.el.querySelector(`button[aria-label="Pakuj DE-2"]`));
      await scanNow(h, 'SKU-1');
      await scanNow(h, 'SKU-1');
      assert.equal(requests.filter((r) => r.url.endsWith('/scan')).length, 1, 'second scan waits in the queue');
      first.open();
      await settle();
      const scans = requests.filter((r) => r.url.endsWith('/scan'));
      assert.deepEqual(scans.map((s) => s.body.location), ['A-01', 'B-02']);
      assert.match(h.el.textContent, /2 \/ 2 zeskanowane/);
      await h.close();
    });

    await t.test('a failed scan stops the queue and keeps its error visible', async () => {
      requests = [];
      let current = detail(started, { picking_items: [line({ quantity: 3, locations: [] })] });
      const first = gate();
      let calls = 0;
      handler = async (r) => {
        if (r.url.endsWith('/scan')) {
          if (calls++ === 0) await first.p;
          if (r.body.code === 'XXX') return [422, { detail: 'Kod nie należy do tego zamówienia' }];
          current = { ...current, picking_items: [{ ...current.picking_items[0], scanned: current.picking_items[0].scanned + 1 }] };
          return [200, current];
        }
        return lists(r) ?? [200, current];
      };
      const h = await mount();
      await click(h.el.querySelector(`button[aria-label="Pakuj DE-2"]`));
      await scanNow(h, 'SKU-1');
      await scanNow(h, 'XXX');
      await scanNow(h, '5901');
      first.open();
      await settle();
      assert.deepEqual(requests.filter((r) => r.url.endsWith('/scan')).map((s) => s.body.code), ['SKU-1', 'XXX'], 'third scan not sent');
      const alert = h.el.querySelector('[role=alert]').textContent;
      assert.match(alert, /Skan „XXX”: Kod nie należy do tego zamówienia/);
      assert.match(alert, /Nie wysłano kolejnych skanów \(1\): 5901/);
      assert.match(h.el.textContent, /1 \/ 3 zeskanowane/);
      await h.close();
    });

    await t.test('list rows never fetch the order; a server summary is shown when present', async () => {
      requests = [];
      const summarized = row(3, 'packed', { first_item_name: 'Młynek', line_count: 2, quantity_total: 3, item_count: 3 });
      handler = (r) => {
        const q = new URL(r.url, 'http://x').searchParams.get('status');
        if (q === 'packed') return [200, { data: [summarized], meta: { has_more: false } }];
        return lists(r) ?? [200, detail(fresh)];
      };
      const h = await mount();
      assert.equal(requests.filter((r) => /\/orders\/[0-9a-f-]{36}$/.test(r.url)).length, 0, 'no GET /orders/:id');
      assert.deepEqual([...h.el.querySelectorAll('.wms-row-items')].map((e) => e.textContent), ['1 szt.', '1 szt.']);
      await click(button(h, 'Spakowane'));
      assert.equal(h.el.querySelector('.wms-row-items').textContent, '3 szt. · Młynek + 1 inne');
      assert.equal(requests.filter((r) => /\/orders\/[0-9a-f-]{36}$/.test(r.url)).length, 0);
      await h.close();
    });

    await t.test('"Do spakowania" follows the cursor through all pages and shows the oldest first', async () => {
      requests = [];
      const p1 = [row(7, 'paid', { created_at: '2026-11-07T08:00:00Z' }), row(6, 'picking', { created_at: '2026-11-06T08:00:00Z' })];
      const p2 = [row(5, 'paid', { created_at: '2026-10-20T08:00:00Z' })];
      handler = (r) => {
        const u = new URL(r.url, 'http://x');
        if (u.searchParams.get('status') === 'paid,picking')
          return u.searchParams.get('after') === 'c1' ? [200, { data: p2, meta: { has_more: false, cursor: null } }]
            : [200, { data: p1, meta: { has_more: true, cursor: 'c1' } }];
        return lists(r) ?? [404, { detail: 'brak' }];
      };
      const h = await mount();
      assert(requests.some((r) => r.url.includes('status=paid,picking') && r.url.includes('after=c1')), 'second page requested');
      assert.deepEqual([...h.el.querySelectorAll('.wms-row-id strong')].map((e) => e.textContent), ['DE-5', 'DE-6', 'DE-7']);
      assert.match(button(h, 'Do spakowania').textContent, /3$/, 'all pages loaded, no "+"');
      assert.doesNotMatch(h.el.textContent, /najnowszych z ponad/);
      await h.close();
    });

    await t.test('after "Spakowane" focus moves to "Nadaj przesyłkę"', async () => {
      requests = [];
      let current = detail(started, { picking_items: [line({ scanned: 1 })] });
      handler = (r) => {
        if (r.method === 'PATCH') { current = { ...current, status: 'packed', version: '4' }; return [200, current]; }
        return lists(r) ?? [200, current];
      };
      const h = await mount();
      await click(h.el.querySelector(`button[aria-label="Pakuj DE-2"]`));
      await click(button(h, 'Spakowane'));
      assert.match(h.el.textContent, /Spakowane\. Teraz nadaj przesyłkę/);
      assert.equal(document.activeElement, button(h, 'Nadaj przesyłkę'));
      await h.close();
    });

    await t.test('read-only user sees lists but cannot start picking', async () => {
      requests = [];
      handler = (r) => lists(r) ?? [200, detail(fresh)];
      const h = await mount({ readOnly: true });
      await click(h.el.querySelector('button[aria-label="Podgląd DE-1"]'));
      assert(!requests.some((r) => r.method !== 'GET'));
      assert.equal(button(h, 'Spakowane'), undefined);
      assert.equal(h.el.querySelector('input[placeholder^="Zeskanuj produkt"]'), null, 'no product scan in read-only mode');
      await h.close();
    });

    await t.test('list load failure is shown in Polish with retry', async () => {
      requests = [];
      let fail = true;
      handler = (r) => (fail ? [500, { detail: 'Błąd serwera' }] : lists(r));
      const h = await mount();
      assert.match(h.el.querySelector('[role=alert]').textContent, /Błąd serwera/);
      fail = false;
      await click(button(h, 'Spróbuj ponownie'));
      assert.equal(h.el.querySelector('[role=alert]'), null);
      assert.equal(h.el.querySelectorAll('.wms-row').length, 2);
      await h.close();
    });
    await t.test('/pakowanie/<number> opens that order; opening and leaving an order report the address', async () => {
      assert.equal(isWmsPath('/pakowanie'), true);
      assert.equal(isWmsPath('/pakowanie/DE-2'), true);
      assert.equal(isWmsPath('/pakowaniex'), false);
      assert.equal(wmsOrderRef('/pakowanie/DE-2'), 'DE-2');
      assert.equal(wmsOrderRef('/pakowanie'), null);
      assert.equal(wmsOrderRef('/wms'), null);
      requests = [];
      const current = detail(started);
      handler = (r) => {
        if (r.url.endsWith('/orders/by-number/DE-2')) return [200, { id: started.id, number: 'DE-2', status: 'picking', version: '3' }];
        if (r.url.endsWith('/orders/by-number/DE-404')) return [404, { detail: 'Nie znaleziono zamówienia DE-404' }];
        return lists(r) ?? [200, current];
      };
      const routes = [];
      const h = await mount({ routeOrder: 'DE-2', onRouteOrder: (n) => routes.push(n) });
      assert(requests.some((r) => r.url.endsWith('/orders/by-number/DE-2')));
      assert(!requests.some((r) => r.method === 'PATCH'), 'an order already in picking is not started again');
      assert(button(h, '‹ Wróć do listy'), 'packing screen is open');
      await click(button(h, '‹ Wróć do listy'));
      assert.deepEqual(routes, [null]);
      await h.close();
      const missing = await mount({ routeOrder: 'DE-404', onRouteOrder: (n) => routes.push(n) });
      assert.match(missing.el.textContent, /Nie znaleziono zamówienia DE-404/);
      assert.equal(button(missing, '‹ Wróć do listy'), undefined);
      await missing.close();
      const list = await mount({ routeOrder: null, onRouteOrder: (n) => routes.push(n) });
      handler = (r) => (r.method === 'PATCH' ? [200, detail(fresh, { status: 'picking', version: '4' })] : lists(r) ?? [200, detail(fresh, { status: 'picking' })]);
      await click(list.el.querySelector('button[aria-label="Pakuj DE-1"]'));
      assert.deepEqual(routes, [null, 'DE-1']);
      await list.close();
    });

    await t.test('Zgłoś brak at a line posts order.item_missing with the order line id; a failure keeps the key', async () => {
      requests = [];
      const itemId = id(95);
      const current = detail(started, { items: [{ id: itemId, name: 'Młynek', sku: 'SKU-1', quantity: 3 }], picking_items: [line({ quantity: 3, scanned: 1 })] });
      let fail = true;
      handler = (r) => {
        if (r.url.endsWith('/orders/by-number/DE-2')) return [200, { id: started.id, number: 'DE-2', status: 'picking', version: '3' }];
        if (r.method === 'POST' && r.url.endsWith('/missing')) {
          if (fail) { fail = false; return [409, { detail: 'Brak zgłosisz w zamówieniu w realizacji' }]; }
          return [200, { event_id: id(96), item_id: itemId, sku: 'SKU-1', quantity_missing: r.body.quantity_missing, replayed: false }];
        }
        return lists(r) ?? [200, current];
      };
      const h = await mount({ routeOrder: 'DE-2', onRouteOrder: () => {} });
      await click(button(h, 'Zgłoś brak'));
      const form = h.el.querySelector('form.item-missing-form');
      const qty = form.querySelector('input[type=number]');
      assert.equal(qty.value, '2', 'defaults to the pieces not scanned yet');
      await type(qty, '5');
      await submit(form);
      assert.match(h.el.textContent, /Podaj liczbę od 1 do 3/);
      assert(!requests.some((r) => r.url.endsWith('/missing')), 'invalid quantity is not sent');
      await type(qty, '2');
      await submit(form);
      const first = requests.filter((r) => r.url.endsWith('/missing'));
      assert.equal(first.length, 1);
      assert(first[0].url.endsWith(`/api/orders/${started.id}/items/${itemId}/missing`));
      assert.equal(first[0].body.quantity_missing, 2);
      assert.match(h.el.textContent, /Brak zgłosisz w zamówieniu w realizacji/);
      await submit(h.el.querySelector('form.item-missing-form'));
      const sent = requests.filter((r) => r.url.endsWith('/missing'));
      assert.equal(sent.length, 2);
      assert.equal(sent[1].body.client_key, sent[0].body.client_key, 'a retry reuses the key');
      assert.match(h.el.textContent, /Zgłoszono brak: SKU-1 · 2 szt\./);
      assert.equal(h.el.querySelector('form.item-missing-form'), null);
      await h.close();
    });
  } finally {
    for (const root of roots) await act(async () => root.unmount());
    await vite.close();
    globalThis.fetch = oldFetch;
    for (const [k, d] of prior) { if (d) Object.defineProperty(globalThis, k, d); else delete globalThis[k]; }
    dom.window.close();
  }
});
