/** Migration 246 UI (prepared as placeholder 254): the trade-credit panel and balance (B2B-007) and the supplier directory (B2B-008), actual
 * components with a closed local fetch. No API server, database or provider. */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

const tenant = '10000000-1000-4000-8000-000000000254';
const reactProps = (e) => e[Object.keys(e).find((k) => k.startsWith('__reactProps'))];
const button = (el, text) => [...el.querySelectorAll('button')].find((e) => e.textContent.trim() === text);
const submit = async (form) => act(async () => reactProps(form).onSubmit({ preventDefault() {}, currentTarget: form }));
const summary = (o = {}) => ({ currency: 'PLN', limit_minor: 1000050, term_days: 30, active: true, exposure_minor: 25190, available_minor: 974860, overdue_minor: 0, overdue_orders: 0, open_orders: 1, ...o });

test('254 UI: trade credit and supplier directory', async (t) => {
  const dom = new JSDOM('<body/>', { url: 'http://127.0.0.1:4254' });
  const saved = new Map(), oldFetch = globalThis.fetch, roots = new Set();
  for (const [key, value] of Object.entries({
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator, location: dom.window.location,
    HTMLElement: dom.window.HTMLElement, Event: dom.window.Event, FormData: dom.window.FormData, CustomEvent: dom.window.CustomEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  let vite;
  try {
    vite = await createServer({ server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: 'custom', logLevel: 'error' });
    const { B2bTradeCreditPanel, TradeCreditBalance } = await vite.ssrLoadModule(path.resolve('web/b2b-trade-credit.tsx'));
    const { B2bSupplierDirectory } = await vite.ssrLoadModule(path.resolve('web/b2b-supplier-directory.tsx'));
    const { setWorkspace } = await vite.ssrLoadModule(path.resolve('web/api.ts'));
    const { createRoot } = await import('react-dom/client');
    setWorkspace(tenant);
    const settle = () => act(async () => new Promise((r) => setTimeout(r, 20)));
    const mount = async (element) => {
      const el = document.createElement('div');
      document.body.append(el);
      const root = createRoot(el);
      roots.add(root);
      await act(async () => root.render(element));
      await settle();
      return el;
    };

    await t.test('the administrator grants a line in złoty; the request carries exact grosze and the version', async () => {
      const calls = [];
      let view = { available: true, line: null, summary: null, orders: [] };
      globalThis.fetch = async (url, o = {}) => {
        calls.push([o.method ?? 'GET', url, o.body ? JSON.parse(o.body) : null]);
        if (url === '/api/b2b/accounts/a1/trade-credit' && (o.method ?? 'GET') === 'GET') return Response.json(view);
        if (url === '/api/b2b/accounts/a1/trade-credit' && o.method === 'PUT') {
          view = { available: true, line: { id: 'l1', currency: 'PLN', limit_minor: 1000050, term_days: 30, active: true, version: 1 }, summary: summary({ exposure_minor: 0, available_minor: 1000050, open_orders: 0 }), orders: [] };
          return Response.json(view);
        }
        assert.fail('unexpected ' + url);
      };
      const el = await mount(React.createElement(B2bTradeCreditPanel, { accountId: 'a1', accountName: 'Hurt A', admin: true, readOnly: false, onClose() {} }));
      const form = el.querySelector('form');
      form.elements.namedItem('limit').value = '1,234';
      await submit(form);
      await settle();
      assert.match(el.textContent, /najwyżej dwoma miejscami/);
      assert.equal(calls.filter((c) => c[0] === 'PUT').length, 0, 'a wrong amount is not sent');
      form.elements.namedItem('limit').value = '10 000,50';
      form.elements.namedItem('term').value = '30';
      await submit(form);
      await settle();
      assert.deepEqual(calls.find((c) => c[0] === 'PUT')[2], { currency: 'PLN', limit_minor: 1000050, term_days: 30, active: true, version: 0, confirmed: true });
      assert.match(el.textContent, /Zapisano kredyt kupiecki/);
      assert.equal(button(el, 'Zapisz zmiany kredytu') !== undefined, true);
      assert.equal(el.querySelector('form').elements.namedItem('limit').value, '10000,50', 'the saved limit is shown back exactly');
    });

    await t.test('a viewer only reads; the balance warns about money after the term', async () => {
      globalThis.fetch = async () => Response.json({ available: true, line: { id: 'l1', currency: 'PLN', limit_minor: 1000050, term_days: 30, active: true, version: 2 }, summary: summary({ overdue_minor: 25190, overdue_orders: 1 }), orders: [{ number: 'B2B-7', channel: 'network', amount_minor: 25190, amount_due: 25190, due_at: '2026-10-01T10:00:00Z', overdue: true }] });
      const el = await mount(React.createElement(B2bTradeCreditPanel, { accountId: 'a2', accountName: 'Hurt B', admin: false, readOnly: false, onClose() {} }));
      assert.equal(el.querySelector('form'), null);
      assert.match(el.querySelector('[role="alert"]').textContent, /Po terminie: 251,90\s?zł \(1 zam\.\)/);
      assert.match(el.textContent, /B2B-7.*sieć B2B.*po terminie/);
      const none = await mount(React.createElement(TradeCreditBalance, { view: { available: true, line: null, summary: null, orders: [] } }));
      assert.equal(none.textContent, '', 'no line, no balance');
    });

    await t.test('directory: profile opt-in, search, request, accept for an account and connect through network accept', async () => {
      const calls = [];
      let requests = { available: true, outgoing: [], incoming: [{ id: 'r-in', state: 'pending', supplier_tenant_id: tenant, supplier_name: 'Moja hurtownia', requester_name: 'Sklep X', message: 'Chcemy kupować', created_at: '2026-10-27T10:00:00Z', decided_at: null, recipient_email: 'admin@x.test' }] };
      globalThis.fetch = async (url, o = {}) => {
        const m = o.method ?? 'GET', body = o.body ? JSON.parse(o.body) : null;
        calls.push([m, url, body]);
        if (url === '/api/b2b/directory/profile' && m === 'GET') return Response.json({ available: true, profile: null });
        if (url === '/api/b2b/directory/profile' && m === 'PUT') return Response.json({ available: true, profile: { ...body, tenant_id: tenant, version: 1 } });
        if (url.startsWith('/api/b2b/directory?')) return Response.json({ available: true, next: null, data: [{ tenant_id: 's1', display_name: 'Papiernia Y', description: 'Papier', city: 'Łódź', country: 'PL', categories: ['papier'], connected: false, request: null }] });
        if (url === '/api/b2b/directory/requests' && m === 'GET') return Response.json(requests);
        if (url === '/api/b2b/accounts') return Response.json({ data: [{ id: 'acc1', name: 'Konto Sklep X', version: 3, active: true }], next: null });
        if (url === '/api/b2b/directory/requests' && m === 'POST') return Response.json({ request: { id: 'r-out' }, reused: false });
        if (url === '/api/b2b/directory/requests/r-in/accept') {
          requests = { ...requests, incoming: [{ ...requests.incoming[0], state: 'accepted' }], outgoing: [{ id: 'r-out', state: 'accepted', supplier_tenant_id: 's1', supplier_name: 'Papiernia Y', requester_name: 'Moja', message: '', created_at: '2026-10-27T10:00:00Z', decided_at: '2026-10-27T11:00:00Z' }] };
          return Response.json({ request: {}, expires_hours: 24 });
        }
        if (url === '/api/b2b/directory/requests/r-out/invitation') return Response.json({ token: 'a'.repeat(64), accept_path: '/api/b2b/network/accept' });
        if (url === '/api/b2b/network/accept') return Response.json({ id: 'link1' });
        assert.fail('unexpected ' + m + ' ' + url);
      };
      const el = await mount(React.createElement(B2bSupplierDirectory, { admin: true, readOnly: false, contextKey: 'k1' }));
      const profile = el.querySelector('details form');
      profile.elements.namedItem('name').value = 'Moja hurtownia';
      profile.elements.namedItem('categories').value = 'papier, karton';
      profile.elements.namedItem('listed').checked = true;
      await submit(profile);
      await settle();
      assert.deepEqual(calls.find((c) => c[0] === 'PUT')[2], { display_name: 'Moja hurtownia', description: '', city: '', country: 'PL', categories: ['papier', 'karton'], listed: true, version: 0, confirmed: true });
      assert.match(el.textContent, /Profil jest widoczny w katalogu dostawców/);
      assert.match(el.textContent, /Papiernia Y.*Łódź, PL/);
      assert.doesNotMatch(el.textContent, /zł|PLN/, 'no price in the directory');
      await act(async () => button(el, 'Poproś o współpracę').click());
      const ask = el.querySelector('form[aria-label="Prośba o współpracę"]');
      ask.elements.namedItem('message').value = 'Dzień dobry';
      await submit(ask);
      await settle();
      const sent = calls.find((c) => c[0] === 'POST' && c[1] === '/api/b2b/directory/requests')[2];
      assert.equal(sent.supplier_tenant_id, 's1');
      assert.equal(sent.message, 'Dzień dobry');
      assert.match(sent.client_key, /^[0-9a-f-]{36}$/);
      assert.equal(button(el, 'Przyjmij').disabled, true, 'an account must be chosen first');
      const select = el.querySelector('select[aria-label="Konto kontrahenta dla Sklep X"]');
      await act(async () => { reactProps(select).onChange({ target: { value: 'acc1' } }); });
      await act(async () => button(el, 'Przyjmij').click());
      await settle();
      assert.deepEqual(calls.find((c) => c[1] === '/api/b2b/directory/requests/r-in/accept')[2], { account_id: 'acc1', version: 3, confirmed: true });
      await act(async () => button(el, 'Połącz z dostawcą').click());
      await settle();
      assert.deepEqual(calls.find((c) => c[1] === '/api/b2b/network/accept')[2], { token: 'a'.repeat(64), confirmed: true });
      assert.match(el.textContent, /Połączono z dostawcą Papiernia Y/);
    });

    await t.test('directory in a restored-copy preview: nothing writable', async () => {
      globalThis.fetch = async (url) => {
        if (url === '/api/b2b/directory/profile') return Response.json({ available: true, profile: null });
        if (url.startsWith('/api/b2b/directory?')) return Response.json({ available: true, next: null, data: [{ tenant_id: 's1', display_name: 'Papiernia Y', description: '', city: '', country: 'PL', categories: [], connected: false, request: null }] });
        if (url === '/api/b2b/directory/requests') return Response.json({ available: true, outgoing: [], incoming: [] });
        if (url === '/api/b2b/accounts') return Response.json({ data: [], next: null });
        assert.fail('unexpected ' + url);
      };
      const el = await mount(React.createElement(B2bSupplierDirectory, { admin: true, readOnly: true, contextKey: 'k2' }));
      assert.equal(el.querySelector('details form'), null);
      assert.equal(button(el, 'Poproś o współpracę'), undefined);
    });
  } finally {
    for (const root of roots) await act(async () => root.unmount());
    if (vite) await vite.close();
    globalThis.fetch = oldFetch;
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    dom.window.close();
  }
});
