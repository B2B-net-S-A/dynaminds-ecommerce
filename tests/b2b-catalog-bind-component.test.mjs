import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { webcrypto } from 'node:crypto';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

// Actual B2bNetwork and ProductPicker with controlled HTTP. No database,
// native browser, commercial provider or physical-stock evidence is claimed.
const id = n => `${n.toString(16).padStart(8, '0')}-1590-4159-8159-159159159159`;
const tenant = id(1), user = id(2), linkId = id(5), itemId = id(6);
const legacy = `${tenant}:${user}:admin`, context = `${legacy}:false`;
const source = `/b2b/network/links/${linkId}`;
const bindPath = `${source}/catalog/${itemId}/bind`;
const target = { id: id(10), name: 'Katalog docelowy kupującego', version: '2' };
const ownProduct = { id: id(50), catalog_id: target.id, name: 'Własny produkt', sku: 'OWN',
  kind: 'simple', active: true, version: 3, price: 1700, available: 7, reserved: 0 };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { resolve, promise }; };
function fixture() {
  const f = { reads: [], writes: [], receipts: new Map(), bound: null, lost: false,
    malformed: false, status: 0, heldAuth: null, heldProducts: null, target: { ...target } };
  f.catalog = () => ({ target_catalog: f.target, next: null, last_at: '2026-10-07T09:00:00Z',
    data: [{ id: itemId, version: f.bound ? 2 : 1, published: true, product_id: f.bound,
      snapshot: { sku: 'SUP-1', name: 'Oferta dostawcy', kind: 'simple', price: 800,
        currency: 'PLN', available: 900, description: 'Opis oferty', attributes: {}, images: [] } }] });
  f.fetch = async (url, init = {}) => {
    const u = new URL(String(url), 'http://127.0.0.1');
    const p = u.pathname.replace(/^\/api/, ''), method = init.method ?? 'GET';
    assert.equal(new Headers(init.headers).get('X-Workspace-ID'), tenant);
    if (method === 'GET') {
      f.reads.push(p + u.search);
      if (p === '/auth/me') return f.heldAuth ? f.heldAuth.promise : Response.json({ user: { id: user, tenant_id: tenant, role: 'admin' } });
      if (p === '/b2b/network/links') return Response.json({ data: [{ id: linkId, version: 1,
        paused: false, supplier_name: 'Własny dostawca B2B', schedule_minutes: 30 }], next: null, currency: 'PLN' });
      if (p === '/b2b/accounts') return Response.json({ data: [], next: null });
      if (p === '/warehouses') return Response.json({ data: [{ id: id(20), name: 'MAIN' }] });
      if (p === source + '/runs' || p === source + '/orders') return Response.json({ data: [], next: null });
      if (p === source + '/dropshipping/options') return Response.json({ available: false,
        read_only: false, current_role: 'admin', can_manage: false, can_read: true, can_read_value: false });
      if (p === source + '/catalog') return Response.json(f.catalog());
      if (p === '/products') {
        assert.ok(u.searchParams.get('catalog_id'), 'Picker always sends the server-selected catalog');
        if (f.heldProducts) return f.heldProducts.promise;
        const cat = u.searchParams.get('catalog_id');
        const data = u.searchParams.has('after')
          ? [{ ...ownProduct, id: id(51), kind: 'variant', sku: 'VAR', name: 'Własny wariant', catalog_id: cat }]
          : [{ ...ownProduct, catalog_id: cat }, { ...ownProduct, id: id(52), kind: 'bundle', sku: 'BUNDLE', catalog_id: cat },
            { ...ownProduct, id: id(53), kind: 'group', sku: 'GROUP', catalog_id: cat },
            { ...ownProduct, id: id(54), active: false, sku: 'INACTIVE', catalog_id: cat }];
        return Response.json({ data, meta: { has_more: !u.searchParams.has('after'), cursor: u.searchParams.has('after') ? null : id(99) } });
      }
      throw Error('Unexpected controlled GET ' + p);
    }
    assert.equal(method, 'POST'); assert.equal(p, bindPath);
    const body = JSON.parse(init.body); f.writes.push({ path: p, raw: init.body, body });
    if (f.status) return Response.json({ detail: 'Controlled terminal or uncertain HTTP response' }, { status: f.status });
    let reply = f.receipts.get(body.client_key);
    if (reply) reply = { ...structuredClone(reply), reused: true };
    else {
      assert.equal(body.version, 1); assert.equal(body.confirmed, true);
      assert.ok([id(50), id(51)].includes(body.product_id));
      f.bound = body.product_id;
      reply = { binding: { id: id(60), item_id: itemId, link_id: linkId, product_id: body.product_id,
        item_version_before: 1, item_version_after: 2, quantity: 0, supplier_available: 900,
        created_at: '2026-10-07T09:00:00Z' }, reused: false };
      f.receipts.set(body.client_key, structuredClone(reply));
    }
    if (f.lost) throw TypeError('Controlled lost bind ACK after stored receipt');
    if (f.malformed) { reply = structuredClone(reply); reply.binding.product_id = id(77); }
    return Response.json(reply);
  };
  return f;
}
async function tick() { await act(async () => { await new Promise(r => setTimeout(r, 0)); }); }
async function until(fn, note) { for (let i = 0; i < 100; i++) { if (fn()) return; await tick(); } assert.ok(fn(), note); }
function button(h, label) { const b = [...h.container.querySelectorAll('button')].find(b => b.textContent.trim() === label); assert.ok(b, label); return b; }
function named(h, label) { const el = h.container.querySelector(`[aria-label="${label}"]`); assert.ok(el, label); return el; }
async function click(el) { assert.equal(el.matches(':disabled'), false); await act(async () => el.dispatchEvent(new MouseEvent('click', { bubbles: true }))); }
async function choose(el, value) { assert.equal(el.matches(':disabled'), false); await act(async () => { Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set.call(el, value); el.dispatchEvent(new Event('change', { bubbles: true })); }); }

test('existing own product B2B binding — actual mounted caller and picker', async t => {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://127.0.0.1/' });
  const saved = new Map(), savedFetch = globalThis.fetch;
  for (const [k, value] of Object.entries({ window: dom.window, document: dom.window.document,
    navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, MouseEvent: dom.window.MouseEvent,
    Event: dom.window.Event, FormData: dom.window.FormData, crypto: webcrypto, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(k, Object.getOwnPropertyDescriptor(globalThis, k)); Object.defineProperty(globalThis, k, { configurable: true, writable: true, value });
  }
  let vite; const mounts = [];
  try {
    vite = await createServer({ server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: 'custom', logLevel: 'error' });
    const { createRoot } = await import('react-dom/client');
    const { B2bNetwork } = await vite.ssrLoadModule(path.resolve('web/b2b-network.tsx'));
    const api = await vite.ssrLoadModule(path.resolve('web/api.ts'));
    const registry = await vite.ssrLoadModule(path.resolve('web/b2b-dropshipping-returns.tsx'));
    const scope = await vite.ssrLoadModule(path.resolve('web/b2b-catalog-scope.tsx'));
    function reset(f) { globalThis.fetch = f.fetch; api.setWorkspace(tenant); registry.resetDropshipReturnContext('', false); registry.resetDropshipReturnContext(legacy, false); scope.resetB2bCatalogScopeContext(''); scope.resetB2bCatalogScopeContext(context); }
    async function mount(extra = {}) {
      const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
      const h = { container, props: { admin: true, readOnly: false, contextKey: legacy, catalogContextKey: context, ...extra },
        async render(patch = {}) { h.props = { ...h.props, ...patch }; await act(async () => root.render(React.createElement(B2bNetwork, h.props))); },
        async close() { await act(async () => root.unmount()); container.remove(); } };
      mounts.push(h); await h.render(); return h;
    }
    async function selectLink(h) {
      await until(() => [...h.container.querySelectorAll('select option')].some(o => o.value === linkId), 'Actual persisted link');
      const el = [...h.container.querySelectorAll('label')].find(l => l.textContent.startsWith('Wybierz połączenie'))?.querySelector('select');
      assert.ok(el); await choose(el, linkId);
      await until(() => h.container.textContent.includes('Oferta dostawcy') && h.container.textContent.includes('SUP-1'), 'Actual supplier catalog');
    }
    async function open(h) { await selectLink(h); await click(button(h, 'Powiąż istniejący produkt SUP-1')); }
    async function prepare(h, product = id(50)) {
      await open(h); await until(() => named(h, 'Istniejący produkt do oferty B2B').options.length === 2, 'Scoped own active simple product');
      await choose(named(h, 'Istniejący produkt do oferty B2B'), product);
      await click(named(h, 'Potwierdzam powiązanie istniejącego produktu B2B'));
    }
    const save = h => button(h, 'Zapisz powiązanie istniejącego produktu B2B');
    try {
      await t.test('server target scopes full paginated picker; separate consent binds variant without copying price or stock', async () => {
        const f = fixture(); reset(f); const h = await mount();
        try {
          await open(h); await until(() => named(h, 'Istniejący produkt do oferty B2B').options.length === 2, 'First scoped page');
          const picker = named(h, 'Istniejący produkt do oferty B2B');
          assert.deepEqual([...picker.options].map(o => o.value), ['', id(50)], 'Inactive, bundle and group are not eligible');
          assert.equal(save(h).matches(':disabled'), true); assert.equal(f.writes.length, 0);
          await click(button(h, 'Więcej wyników')); await until(() => [...picker.options].some(o => o.value === id(51)), 'Cursor page');
          await choose(picker, id(51)); assert.equal(save(h).matches(':disabled'), true, 'Selection is not consent');
          await click(named(h, 'Potwierdzam powiązanie istniejącego produktu B2B')); await click(save(h));
          await until(() => h.container.textContent.includes('Powiązanie produktu zapisane.'), 'Verified binding receipt');
          assert.equal(f.writes.length, 1); assert.equal(f.writes[0].body.product_id, id(51));
          assert.deepEqual(Object.keys(f.writes[0].body).sort(), ['client_key', 'confirmed', 'product_id', 'version']);
          assert.equal(f.receipts.size, 1); assert.ok(h.container.textContent.includes('Zapis powiązania: ' + id(60)));
          assert.ok(f.reads.filter(p => p.startsWith('/products?')).every(p => p.includes('catalog_id=' + target.id)));
          assert.ok(f.reads.some(p => p.includes('after=' + id(99))));
        } finally { await h.close(); }
      });
      await t.test('lost ACK then malformed replay survives actual unmount and bound GET; own exact retry releases shared lock', async () => {
        const f = fixture(); f.lost = true; reset(f); const h = await mount();
        await prepare(h); await click(save(h)); await until(() => h.container.textContent.includes('Wynik powiązania jest niepewny'), 'Retained bind');
        const first = f.writes[0]; assert.equal(button(h, 'Pobierz aktualny katalog B2B').matches(':disabled'), true); await h.close();
        f.lost = false; f.malformed = true; const next = await mount({ externalWriteBlocked: true });
        try {
          await selectLink(next); await click(button(next, 'Odśwież widok B2B'));
          assert.ok(next.container.textContent.includes('Produkt powiązany')); assert.equal(f.writes.length, 1);
          assert.ok(next.container.textContent.includes('Wynik powiązania jest niepewny'), 'GET cannot turn uncertain mutation into success');
          await click(button(next, 'Ponów dokładne powiązanie B2B'));
          await until(() => next.container.textContent.includes('Niepełne potwierdzenie powiązania'), 'Wrong product receipt rejected');
          assert.ok(next.container.textContent.includes('Wynik powiązania jest niepewny')); assert.equal(f.writes[1].raw, first.raw);
          f.malformed = false; await click(button(next, 'Ponów dokładne powiązanie B2B'));
          await until(() => !next.container.textContent.includes('Wynik powiązania jest niepewny'), 'Valid own replay');
          assert.equal(f.writes.length, 3); assert.equal(f.writes[2].path, first.path); assert.equal(f.writes[2].raw, first.raw);
          assert.equal(f.receipts.size, 1); assert.ok(next.container.textContent.includes('odczyt dokładnego ponowienia'));
        } finally { await next.close(); }
      });
      for (const status of [408, 429]) await t.test(`uncertain HTTP ${status} retains the exact bind body and key`, async () => {
        const f = fixture(); f.status = status; reset(f); const h = await mount();
        try {
          await prepare(h); await click(save(h)); await until(() => h.container.textContent.includes('Wynik powiązania jest niepewny'), 'Uncertain status');
          const first = f.writes[0]; f.status = 0; await click(button(h, 'Ponów dokładne powiązanie B2B'));
          await until(() => !h.container.textContent.includes('Wynik powiązania jest niepewny'), 'Validated exact retry');
          assert.equal(f.writes.length, 2); assert.equal(f.writes[1].raw, first.raw); assert.equal(f.writes[1].path, first.path);
        } finally { await h.close(); }
      });
      for (const status of [414, 422]) await t.test(`known HTTP ${status} clears pending and requires a new explicit consent`, async () => {
        const f = fixture(); f.status = status; reset(f); const h = await mount();
        try {
          await prepare(h); await click(save(h)); await until(() => h.container.textContent.includes('Controlled terminal or uncertain HTTP response') && !named(h, 'Potwierdzam powiązanie istniejącego produktu B2B').checked, 'Known rejection');
          assert.equal(h.container.textContent.includes('Wynik powiązania jest niepewny'), false);
          assert.equal(named(h, 'Potwierdzam powiązanie istniejącego produktu B2B').checked, false);
          assert.equal(save(h).matches(':disabled'), true); assert.equal(f.writes.length, 1);
          assert.equal(button(h, 'Pobierz aktualny katalog B2B').matches(':disabled'), false);
        } finally { await h.close(); }
      });
      await t.test('a genuine sibling lock arriving during auth preflight prevents any POST', async () => {
        const f = fixture(); reset(f); const h = await mount();
        try {
          await prepare(h); const held = deferred(); f.heldAuth = held; const prior = f.reads.length;
          await click(save(h)); await until(() => f.reads.slice(prior).includes('/auth/me'), 'Held fresh auth');
          await h.render({ externalWriteBlocked: true });
          await act(async () => { held.resolve(Response.json({ user: { id: user, tenant_id: tenant, role: 'admin' } })); await Promise.resolve(); });
          await until(() => h.container.textContent.includes('blokuje nowy zapis B2B'), 'Latest fence rejects'); assert.equal(f.writes.length, 0);
        } finally { await h.close(); }
      });
      await t.test('changed target invalidates draft and ignores old catalog product read', async () => {
        const f = fixture(); const held = deferred(); f.heldProducts = held; reset(f); const h = await mount();
        try {
          await open(h); await until(() => f.reads.some(p => p.startsWith('/products?')), 'Old picker GET held');
          f.target = { id: id(11), name: 'Nowy katalog docelowy', version: '3' }; await click(button(h, 'Odśwież widok B2B'));
          await until(() => !h.container.querySelector('[aria-label="Powiązanie istniejącego produktu B2B"]'), 'Old selection purged');
          await act(async () => { held.resolve(Response.json({ data: [{ ...ownProduct, name: 'OLD TARGET LATE PRODUCT' }], meta: { cursor: null } })); await Promise.resolve(); });
          await tick(); assert.ok(!h.container.textContent.includes('OLD TARGET LATE PRODUCT')); assert.equal(f.writes.length, 0);
        } finally { await h.close(); }
      });
      await t.test('missing authoritative catalog disables bind instead of guessing a default', async () => {
        const f = fixture(); f.target = null; reset(f); const h = await mount();
        try {
          await selectLink(h); assert.equal(button(h, 'Powiąż istniejący produkt SUP-1').matches(':disabled'), true);
          assert.ok(h.container.textContent.includes('Ten odczyt go nie udostępnia'));
          assert.equal(f.reads.some(p => p.startsWith('/products?')), false); assert.equal(f.writes.length, 0);
        } finally { await h.close(); }
      });
      await t.test('readOnly replacement during held preflight removes form and never sends bind', async () => {
        const f = fixture(); reset(f); const h = await mount();
        try {
          await prepare(h); const held = deferred(); f.heldAuth = held; const prior = f.reads.length;
          await click(save(h)); await until(() => f.reads.slice(prior).includes('/auth/me'), 'Old auth held');
          await act(async () => registry.resetDropshipReturnContext(legacy, true));
          await h.render({ readOnly: true, catalogContextKey: `${legacy}:true` });
          await act(async () => { held.resolve(Response.json({ user: { id: user, tenant_id: tenant, role: 'admin' } })); await Promise.resolve(); });
          await tick(); assert.equal(h.container.querySelector('[aria-label="Powiązanie istniejącego produktu B2B"]'), null); assert.equal(f.writes.length, 0);
        } finally { await h.close(); }
      });
    } finally { for (const h of mounts) if (h.container.isConnected) await h.close(); }
  } finally {
    try { if (vite) await vite.close(); }
    finally { globalThis.fetch = savedFetch; dom.window.close(); for (const [k, desc] of saved) { if (desc) Object.defineProperty(globalThis, k, desc); else delete globalThis[k]; } }
  }
});
