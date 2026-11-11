import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { webcrypto } from 'node:crypto';
import React, { act, StrictMode } from 'react';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

// Real component and API helper; deferred HTTP responses only. No SQL/stock model.
const hold = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const row = (name) => ({product_id: 'product-' + name, location: name + '-01', sku: 'SKU-' + name, name, quantity: 8, reserved: 1, available: 7, version: '3'});
const page = (names, cursor = null) => Response.json({data: names.map(row), meta: {cursor}});
const history = (name) => Response.json({data: [{id: name, created_at: '2026-10-18T10:00:00Z', location: name + '-01', delta: 1, kind: 'count', note: 'HISTORY-' + name}]});
const failure = (detail) => Response.json({detail}, {status: 503});
function fixture() {
  return {requests: [], handler: null, async fetch(url, options = {}) {
    const request = {url: new URL(url, 'http://127.0.0.1'), method: options.method ?? 'GET', body: options.body ? JSON.parse(options.body) : null, headers: options.headers};
    this.requests.push(request);
    const response = this.handler?.(request);
    if (response) return await response;
    if (request.url.pathname === '/api/warehouses') return Response.json({data: [{id: 'wa', name: 'Warehouse A'}, {id: 'wb', name: 'Warehouse B'}]});
    if (request.url.pathname === '/api/stock-locations') return page(['A', 'B'], 'next&cursor+');
    if (request.url.pathname === '/api/stock-location-movements') return history(request.url.searchParams.get('product_id').slice(8));
    throw Error('Unexpected controlled request: ' + request.method + ' ' + request.url.pathname);
  }};
}
async function tick() { await act(async () => { await new Promise(r => setTimeout(r, 0)); }); }
async function until(fn, message) { for (let i = 0; i < 80; i++) { if (fn()) return; await tick(); } assert.ok(fn(), message); }
const buttons = (h) => [...h.container.querySelectorAll('button')];
function button(h, text) { const el = buttons(h).find(b => b.textContent === text); assert.ok(el, 'Missing button ' + text); return el; }
function field(h, label) { const el = [...h.container.querySelectorAll('label')].find(v => v.textContent.includes(label))?.querySelector('input,select'); assert.ok(el, 'Missing field ' + label); return el; }
async function click(el) { assert.equal(el.disabled, false); await act(async () => { el.dispatchEvent(new MouseEvent('click', {bubbles: true})); }); }
async function value(el, next) {
  await act(async () => {
    const proto = el.tagName === 'SELECT' ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, next);
    el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', {bubbles: true}));
  });
}
async function settle(held, response) { await act(async () => { held.resolve(response); }); await tick(); }
async function open(h, name) { await click(h.container.querySelector(`[aria-label="Lokalizacja SKU-${name} ${name}-01"]`)); }
async function ready(h) { await until(() => h.container.textContent.includes('SKU-A'), 'First page must load'); }
async function prepareWrite(h) {
  await value(field(h, 'Lokalizacja docelowa'), 'Z-01');
  await value(field(h, 'Powód operacji'), 'Controlled move');
  await click(h.container.querySelector('input[type=checkbox]'));
}

test('stock locations: actual component isolates read and write attempts across navigation', async t => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {url: 'http://127.0.0.1/'}), saved = new Map(), oldFetch = globalThis.fetch;
  for (const [key, v] of Object.entries({window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, MouseEvent: dom.window.MouseEvent, Event: dom.window.Event, CustomEvent: dom.window.CustomEvent, crypto: webcrypto, IS_REACT_ACT_ENVIRONMENT: true})) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, {configurable: true, writable: true, value: v});
  }
  const vite = await createServer({server: {middlewareMode: true, hmr: false, ws: false, watch: null}, appType: 'custom', logLevel: 'error'});
  const {createRoot} = await import('react-dom/client'), mod = await vite.ssrLoadModule(path.resolve('web/stock-locations.tsx')), api = await vite.ssrLoadModule(path.resolve('web/api.ts'));
  const mounts = [];
  function mount(f) {
    globalThis.fetch = f.fetch.bind(f); api.setWorkspace('tenant-a');
    const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
    const h = {container, reloads: 0, props: {}, async render(props = {}) { this.props = {...this.props, ...props}; await act(async () => root.render(React.createElement(StrictMode, null, React.createElement(mod.StockLocations, {admin: true, write: true, refresh: 0, reload: () => { h.reloads++; }, ...this.props})))); }, async close() { await act(async () => root.unmount()); container.remove(); }};
    mounts.push(h); return h;
  }
  try {
    await t.test('late first page and failure cannot replace a new warehouse/filter or refresh', async () => {
      const f = fixture(), late = hold(); let held = false;
      f.handler = r => { if (r.url.pathname === '/api/stock-locations') { if (r.url.searchParams.get('warehouse_id') === 'wa' && !held) { held = true; return late.promise; } return page(['CURRENT']); } };
      const h = mount(f); await h.render(); try {
        await until(() => held, 'Initial request held'); await value(field(h, 'Magazyn lokalizacji'), 'wb');
        await until(() => h.container.textContent.includes('SKU-CURRENT'), 'Current warehouse loaded');
        await settle(late, page(['STALE'], 'old-cursor'));
        assert.ok(!h.container.textContent.includes('SKU-STALE')); assert.ok(!buttons(h).some(v => v.textContent === 'Więcej lokalizacji'));
        const failed = hold(); f.handler = r => r.url.pathname === '/api/stock-locations' && r.url.searchParams.get('q') === 'old' ? failed.promise : r.url.pathname === '/api/stock-locations' ? page(['NEW']) : undefined;
        await value(field(h, 'Początek SKU'), 'old'); assert.ok(!h.container.textContent.includes('SKU-CURRENT'));
        await value(field(h, 'Początek SKU'), 'new'); await until(() => h.container.textContent.includes('SKU-NEW'), 'New filter loaded');
        await settle(failed, failure('STALE-LIST-ERROR')); assert.ok(!h.container.textContent.includes('STALE-LIST-ERROR'));
        const refresh = hold(), refreshed = hold(); let reads = 0;
        f.handler = r => r.url.pathname === '/api/stock-locations' ? (++reads === 1 ? refresh.promise : refreshed.promise) : undefined;
        await h.render({refresh: 1}); assert.ok(!h.container.textContent.includes('SKU-NEW'));
        await h.render({refresh: 2}); await settle(refreshed, page(['REFRESHED']));
        await until(() => h.container.textContent.includes('SKU-REFRESHED'), 'Refresh loaded');
        await settle(refresh, page(['STALE-REFRESH'])); assert.ok(!h.container.textContent.includes('SKU-STALE-REFRESH'));
      } finally { await h.close(); }
    });
    await t.test('warehouse lookup failure remains retryable after editing the filter', async () => {
      const f = fixture(); let failed = true;
      f.handler = r => r.url.pathname === '/api/warehouses' && failed ? failure('WAREHOUSE-ERROR') : undefined;
      const h = mount(f); await h.render(); try {
        await until(() => h.container.textContent.includes('WAREHOUSE-ERROR'), 'Warehouse error visible');
        await value(field(h, 'Początek SKU'), 'changed');
        assert.ok(h.container.textContent.includes('WAREHOUSE-ERROR'));
        failed = false; await click(button(h, 'Ponów odczyt magazynów')); await ready(h);
        assert.ok(!h.container.textContent.includes('WAREHOUSE-ERROR'));
        assert.equal(f.requests.find(r => r.url.pathname === '/api/stock-locations').url.searchParams.get('q'), 'changed');
      } finally { await h.close(); }
    });
    await t.test('current first-page failure can be retried without displaying stale data', async () => {
      const f = fixture(); let fail = true; f.handler = r => r.url.pathname === '/api/stock-locations' && fail ? failure('CURRENT-LIST-ERROR') : undefined;
      const h = mount(f); await h.render(); try {
        await until(() => h.container.textContent.includes('CURRENT-LIST-ERROR'), 'Failure visible');
        assert.ok(!h.container.textContent.includes('Wczytywanie lokalizacji'));
        fail = false; await click(button(h, 'Ponów odczyt lokalizacji')); await ready(h);
        assert.ok(!h.container.textContent.includes('CURRENT-LIST-ERROR'));
      } finally { await h.close(); }
    });
    await t.test('pagination is single-flight, retryable, encoded and cannot append to another filter', async () => {
      const f = fixture(), pending = hold(); f.handler = r => r.url.searchParams.has('after') ? pending.promise : undefined;
      const h = mount(f); await h.render(); try {
        await ready(h); const more = button(h, 'Więcej lokalizacji');
        await act(async () => { more.dispatchEvent(new MouseEvent('click', {bubbles: true})); more.dispatchEvent(new MouseEvent('click', {bubbles: true})); });
        assert.equal(f.requests.filter(r => r.url.searchParams.has('after')).length, 1);
        assert.equal(f.requests.find(r => r.url.searchParams.has('after')).url.searchParams.get('after'), 'next&cursor+');
        await settle(pending, failure('PAGE-ERROR')); assert.ok(h.container.textContent.includes('SKU-A'));
        f.handler = r => r.url.searchParams.has('after') ? page(['C']) : undefined;
        await click(button(h, 'Więcej lokalizacji')); await until(() => h.container.textContent.includes('SKU-C'), 'Same cursor retry appended');
        assert.equal(f.requests.filter(r => r.url.searchParams.has('after')).length, 2);
        await value(field(h, 'Początek SKU'), 'reset'); await ready(h);
        const stale = hold(); f.handler = r => r.url.searchParams.has('after') ? stale.promise : r.url.pathname === '/api/stock-locations' ? page(['CURRENT']) : undefined;
        await click(button(h, 'Więcej lokalizacji')); await value(field(h, 'Magazyn lokalizacji'), 'wb');
        await until(() => h.container.textContent.includes('SKU-CURRENT'), 'New warehouse page loaded');
        await settle(stale, page(['STALE-PAGE'], 'bad-cursor'));
        assert.ok(!h.container.textContent.includes('SKU-STALE-PAGE')); assert.ok(!buttons(h).some(b => b.textContent === 'Więcej lokalizacji'));
      } finally { await h.close(); }
    });
    await t.test('history follows the selected row, ignores old failure and retries the current row', async () => {
      const f = fixture(), late = hold(); let failB = true;
      f.handler = r => r.url.pathname === '/api/stock-location-movements' ? r.url.searchParams.get('product_id') === 'product-A' ? late.promise : failB ? failure('CURRENT-HISTORY-ERROR') : history('B') : undefined;
      const h = mount(f); await h.render(); try {
        await ready(h); await open(h, 'A'); await open(h, 'B');
        await until(() => h.container.textContent.includes('CURRENT-HISTORY-ERROR'), 'Current failure visible');
        failB = false; await click(button(h, 'Ponów odczyt historii')); await until(() => h.container.textContent.includes('HISTORY-B'), 'Current history retry loaded');
        await settle(late, failure('STALE-HISTORY-ERROR'));
        assert.ok(h.container.textContent.includes('HISTORY-B')); assert.ok(!h.container.textContent.includes('STALE-HISTORY-ERROR'));
        const held = hold(); f.handler = r => r.url.pathname === '/api/stock-location-movements' ? held.promise : undefined;
        await open(h, 'A'); await click(button(h, 'Zamknij lokalizację')); await settle(held, history('STALE'));
        assert.ok(!h.container.textContent.includes('HISTORY-STALE')); assert.equal(h.container.querySelector('.location-detail'), null);
      } finally { await h.close(); }
    });
    await t.test('returning to the same filter does not inherit a permanently busy old page', async () => {
      const f = fixture(), stale = hold(); let pages = 0;
      f.handler = r => r.url.searchParams.has('after') ? ++pages === 1 ? stale.promise : page(['CURRENT-PAGE']) : undefined;
      const h = mount(f); await h.render(); try {
        await ready(h); await click(button(h, 'Więcej lokalizacji'));
        await value(field(h, 'Początek SKU'), 'different'); await ready(h);
        await value(field(h, 'Początek SKU'), ''); await ready(h);
        assert.equal(button(h, 'Więcej lokalizacji').disabled, false);
        await click(button(h, 'Więcej lokalizacji'));
        await until(() => h.container.textContent.includes('SKU-CURRENT-PAGE'), 'Current pagination remains usable');
        await settle(stale, page(['STALE-PAGE'])); assert.ok(!h.container.textContent.includes('SKU-STALE-PAGE'));
      } finally { await h.close(); }
    });
    await t.test('save is bound to the original warehouse and cannot close a newly selected row', async () => {
      const f = fixture(), ack = hold(); f.handler = r => r.method === 'POST' ? ack.promise : undefined;
      const h = mount(f); await h.render(); try {
        await ready(h); await open(h, 'A'); await prepareWrite(h); await click(button(h, 'Zapisz operację lokalizacji'));
        const writes = f.requests.filter(r => r.method === 'POST'); assert.equal(writes.length, 1);
        assert.deepEqual({...writes[0].body, client_key: '<key>'}, {warehouse_id: 'wa', product_id: 'product-A', location: 'A-01', expected_version: '3', client_key: '<key>', quantity: 1, note: 'Controlled move', destination: 'Z-01'});
        assert.match(writes[0].body.client_key, /^[a-f0-9-]{36}$/); assert.equal(writes[0].headers['X-Workspace-ID'], 'tenant-a');
        await open(h, 'B'); await settle(ack, Response.json({data: {}}));
        assert.equal(h.container.querySelector('.location-detail h3').textContent, 'SKU-B · B-01'); assert.equal(h.reloads, 1);
      } finally { await h.close(); }
    });
    await t.test('scope change fences pending write errors and clears the old form; read-only cannot submit', async () => {
      const f = fixture(), ack = hold(); f.handler = r => r.method === 'POST' ? ack.promise : undefined;
      const h = mount(f); await h.render(); try {
        await ready(h); await open(h, 'A'); await prepareWrite(h); await click(button(h, 'Zapisz operację lokalizacji'));
        await value(field(h, 'Magazyn lokalizacji'), 'wb'); await ready(h); await open(h, 'B');
        await settle(ack, failure('STALE-WRITE-ERROR'));
        assert.ok(!h.container.textContent.includes('STALE-WRITE-ERROR')); assert.equal(h.reloads, 0);
        assert.equal(h.container.querySelector('.location-detail h3').textContent, 'SKU-B · B-01');
        await h.render({readOnly: true}); const form = h.container.querySelector('form');
        await act(async () => { form.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true})); });
        assert.equal(f.requests.filter(r => r.method === 'POST').length, 1);
        await value(field(h, 'Początek SKU'), 'other'); assert.equal(h.container.querySelector('form'), null);
        await act(async () => { form.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true})); });
        assert.equal(f.requests.filter(r => r.method === 'POST').length, 1);
      } finally { await h.close(); }
    });
    await t.test('unmount prevents pending history and save completions from reloading or starting work', async () => {
      const f = fixture(), pendingHistory = hold(), ack = hold(); f.handler = r => r.method === 'POST' ? ack.promise : r.url.pathname === '/api/stock-location-movements' ? pendingHistory.promise : undefined;
      const h = mount(f); await h.render(); await ready(h); await open(h, 'A'); await prepareWrite(h); await click(button(h, 'Zapisz operację lokalizacji'));
      const count = f.requests.length; await h.close(); await settle(pendingHistory, history('STALE')); await settle(ack, Response.json({data: {}}));
      assert.equal(h.reloads, 0); assert.equal(f.requests.length, count); assert.equal(h.container.textContent, '');
    });
  } finally {
    for (const h of mounts) if (h.container.isConnected) await h.close();
    await vite.close(); globalThis.fetch = oldFetch;
    for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
    dom.window.close();
  }
});
