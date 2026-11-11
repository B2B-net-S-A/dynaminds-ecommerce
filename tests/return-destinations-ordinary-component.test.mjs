import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { webcrypto } from 'node:crypto';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

// Actual ordinary ReturnsPanel, controlled delayed HTTP responses. This verifies
// UI pagination isolation after an intake-triggered order refresh, not SQL/IAM.
const id = n => `${String(n).padStart(8, '0')}-1620-4162-8162-162162162162`;
const tenant = id(1), user = id(2), orderId = id(3);
const contextKey = `${tenant}:${user}:operator`;
function order(version = '1', cursor = 'page-v1') {
  return {
    id: orderId, version, currency: 'PLN', status: 'shipped', fulfillment_kind: 'local',
    items: [], documents: [], wms_lots_enabled: false,
    returns: { cases: [], items: [], refund_total: 0, settled_total: 0, shipping_available: 0, meta: { cursor } },
  };
}
function oldCase() {
  return { id: id(10), version: '1', state: 'rejected', number: 'STALE-RMA-148',
    kind: 'return', created_at: '2026-10-07T10:00:00Z', reason: 'Stara strona', items: [] };
}
async function tick() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); }
async function until(predicate, note) {
  for (let i = 0; i < 80; ++i) { if (predicate()) return; await tick(); }
  assert.ok(predicate(), note);
}
function more(h) { return [...h.container.querySelectorAll('button')].find(e => e.textContent === 'Starsze zgłoszenia'); }

test('ordinary returns pagination after destinations refresh: controlled mounted component', async t => {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://127.0.0.1' });
  const saved = new Map(), originalFetch = globalThis.fetch;
  for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document,
    navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, Event: dom.window.Event,
    CustomEvent: dom.window.CustomEvent, crypto: webcrypto, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  const vite = await createServer({ server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: 'custom', logLevel: 'error' });
  const mounts = [];
  try {
    const { createRoot } = await import('react-dom/client');
    const ui = await vite.ssrLoadModule(path.resolve('web/returns.tsx'));
    const api = await vite.ssrLoadModule(path.resolve('web/api.ts'));
    const registry = await vite.ssrLoadModule(path.resolve('web/b2b-dropshipping-returns.tsx'));
    const intake = await vite.ssrLoadModule(path.resolve('web/return-destinations-intake.tsx'));
    async function mount(extra = {}) {
      const requests = [], callbacks = [];
      globalThis.fetch = (url, init = {}) => {
        const p = new URL(String(url), 'http://127.0.0.1');
        assert.equal(init.method, 'GET', 'Pagination never performs a business write');
        assert.equal(p.pathname, `/api/orders/${orderId}/returns`);
        let resolve;
        const promise = new Promise(r => { resolve = r; });
        requests.push({ cursor: p.searchParams.get('after'), resolve });
        return promise;
      };
      api.setWorkspace(tenant);
      registry.resetDropshipReturnContext(contextKey, false);
      intake.resetReturnDestinationsIntakeContext(`${contextKey}:false`);
      const container = document.createElement('div'); document.body.append(container);
      const root = createRoot(container);
      const h = { container, requests, callbacks,
        props: { order: order(), contextKey, readOnly: false, write: true, onChanged: () => callbacks.push('changed'), ...extra },
        async render(patch = {}) { h.props = { ...h.props, ...patch }; await act(async () => root.render(React.createElement(ui.ReturnsPanel, h.props))); },
        async close() { if (!container.isConnected) return; await act(async () => root.unmount()); container.remove(); },
      };
      mounts.push(h); await h.render(); return h;
    }
    async function clickMore(h) { assert.ok(more(h)); assert.equal(more(h).disabled, false); await act(async () => more(h).click()); }
    async function reply(request, body, status = 200) {
      await act(async () => { request.resolve(Response.json(body, { status })); await Promise.resolve(); }); await tick();
    }

    await t.test('old success cannot append cases, replace cursor or clear a newer pending read after order.version changes', async () => {
      const h = await mount(); await clickMore(h);
      assert.equal(h.requests[0].cursor, 'page-v1');
      await h.render({ order: order('2', 'page-v2') });
      await clickMore(h); assert.equal(h.requests[1].cursor, 'page-v2');
      await reply(h.requests[0], { cases: [oldCase()], meta: { cursor: 'stale-next' } });
      assert.ok(!h.container.textContent.includes('STALE-RMA-148'));
      assert.equal(more(h).disabled, true, 'Old finally cannot unlock the new generation');
      await reply(h.requests[1], { cases: [], meta: { cursor: 'fresh-next' } });
      await until(() => !more(h).disabled, 'Current read releases only its own busy state');
      await clickMore(h); assert.equal(h.requests[2].cursor, 'fresh-next');
      await reply(h.requests[2], { cases: [], meta: { cursor: null } });
      assert.equal(more(h), undefined); assert.deepEqual(h.callbacks, []); await h.close();
    });

    await t.test('late denied read from old actor/readOnly scope cannot deny the new scope; current denial still applies', async () => {
      const h = await mount(); await clickMore(h);
      const nextContext = `${tenant}:${user}:viewer`;
      registry.resetDropshipReturnContext(nextContext, true);
      intake.resetReturnDestinationsIntakeContext(`${nextContext}:true`);
      await h.render({ contextKey: nextContext, readOnly: true, write: false, order: order('1', 'copy-page') });
      await reply(h.requests[0], { detail: 'OLD SCOPE DENIED' }, 403);
      assert.ok(!h.container.textContent.includes('OLD SCOPE DENIED'));
      assert.ok(!h.container.textContent.includes('Dostęp do formularzy zwrotu został wstrzymany'));
      await clickMore(h); assert.equal(h.requests[1].cursor, 'copy-page');
      await reply(h.requests[1], { detail: 'CURRENT SCOPE DENIED' }, 403);
      assert.ok(h.container.textContent.includes('CURRENT SCOPE DENIED'));
      assert.ok(h.container.textContent.includes('Dostęp do formularzy zwrotu został wstrzymany'));
      assert.deepEqual(h.callbacks, []); await h.close();
    });

    await t.test('generation rejects an old response even when order version and actor return to the same identity', async () => {
      const h = await mount(); await clickMore(h);
      await h.render({ order: order('2', 'middle-page') });
      await h.render({ order: order('1', 'reopened-page') });
      await reply(h.requests[0], { cases: [oldCase()], meta: { cursor: null } });
      assert.ok(!h.container.textContent.includes('STALE-RMA-148'));
      await clickMore(h); assert.equal(h.requests[1].cursor, 'reopened-page');
      await reply(h.requests[1], { cases: [], meta: { cursor: null } });
      assert.equal(more(h), undefined); assert.deepEqual(h.callbacks, []); await h.close();
    });
  } finally {
    for (const h of mounts) await h.close();
    await vite.close(); dom.window.close(); globalThis.fetch = originalFetch;
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name];
    }
  }
});
