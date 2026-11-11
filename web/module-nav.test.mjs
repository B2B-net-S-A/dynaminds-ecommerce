/** Main menu modules, icon rail and options panel (Uwagi v3 §2). Run: node --test web/module-nav.test.mjs */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

test('module menu, options panel and remembered panel state', async (t) => {
  const dom = new JSDOM('<body/>', { url: 'http://127.0.0.1:4106/' }), prior = new Map();
  for (const [k, v] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, Event: dom.window.Event, MouseEvent: dom.window.MouseEvent, IS_REACT_ACT_ENVIRONMENT: true })) {
    prior.set(k, Object.getOwnPropertyDescriptor(globalThis, k));
    Object.defineProperty(globalThis, k, { configurable: true, writable: true, value: v });
  }
  const vite = await createServer({ server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: 'custom', logLevel: 'error' });
  const cfg = await vite.ssrLoadModule(path.resolve('web/module-nav-config.ts'));
  const ui = await vite.ssrLoadModule(path.resolve('web/module-nav.tsx'));
  const { PAGE_SLUGS } = await vite.ssrLoadModule(path.resolve('web/app-route.ts'));
  const { createRoot } = await import('react-dom/client');
  const roots = new Set();
  const render = async (type, props) => {
    const el = document.createElement('div');
    document.body.append(el);
    const root = createRoot(el);
    roots.add(root);
    await act(async () => root.render(React.createElement(type, props)));
    return el;
  };
  try {
    await t.test('every page belongs to exactly one module; admin pages are hidden from others', () => {
      const pages = cfg.navModules.flatMap((m) => m.pages);
      assert.deepEqual([...pages].sort(), Object.keys(PAGE_SLUGS).sort(), 'all 29 pages reachable, none twice');
      for (const m of cfg.navModules)
        for (const o of m.options) if ('page' in o.to) assert.ok(m.pages.includes(o.to.page), m.id + ' option ' + o.key);
      const admin = cfg.visibleModules(true), staff = cfg.visibleModules(false);
      const staffPages = staff.flatMap((m) => m.options.flatMap((o) => ('page' in o.to ? [o.to.page] : [])));
      for (const p of cfg.ADMIN_PAGES) assert.ok(!staffPages.includes(p), p + ' hidden');
      assert.ok(!staff.some((m) => m.id === 'payments'), 'payment imports are admin-only');
      assert.ok(admin.some((m) => m.id === 'payments'));
      assert.ok(admin.length <= 13, 'rail stays short');
      // The accountant (Księgowa, 266) also sees Przelewy i pobrania, and no other admin page.
      const accountant = cfg.visibleModules(false, true);
      const accountantPages = accountant.flatMap((m) => m.options.flatMap((o) => ('page' in o.to ? [o.to.page] : [])));
      assert.ok(accountant.some((m) => m.id === 'payments'), 'payment imports for the accountant');
      assert.deepEqual(cfg.ADMIN_PAGES.filter((p) => accountantPages.includes(p)), ['paymentImports']);
    });
    await t.test('role labels: the accountant is a viewer with the grant, shown as Księgowa', async () => {
      const roles = await vite.ssrLoadModule(path.resolve('web/roles.ts'));
      assert.equal(roles.roleLabel({ role: 'viewer', accountant: true }), 'Księgowa');
      assert.equal(roles.roleLabel({ role: 'viewer' }), 'Tylko odczyt');
      assert.equal(roles.roleLabel({ role: 'accountant' }), 'Księgowa');
      assert.equal(roles.roleLabel({ role: 'operator', accountant: true }), 'Magazynier', 'the grant counts only on a viewer');
      assert.equal(roles.isAccountant({ role: 'admin', accountant: true }), false);
    });
    await t.test('App test helper knows where every option lives', async () => {
      const { optionModules } = await import(path.resolve('tests/app-nav-helper.mjs'));
      const expected = {};
      for (const m of cfg.navModules) if (m.options.length > 1) for (const o of m.options) if ('page' in o.to) expected[o.label] = m.label;
      assert.deepEqual(optionModules, expected);
    });
    await t.test('modules with options open a panel; Przegląd and single-option modules do not', () => {
      const mods = cfg.visibleModules(false);
      const byId = (id) => mods.find((m) => m.id === id);
      assert.equal(cfg.hasPanel(byId('dashboard')), false);
      assert.equal(cfg.hasPanel(byId('orders')), true);
      assert.equal(cfg.hasPanel(byId('catalog')), true);
      // Integrations for a non-admin: only "Kanały i usługi" left, so it is a plain link.
      assert.equal(byId('integrations').options.length, 1);
      assert.equal(cfg.hasPanel(byId('integrations')), false);
      assert.equal(cfg.moduleOfPage(mods, 'wmsLots').id, 'catalog');
      assert.deepEqual(cfg.defaultTarget(byId('catalog')), { page: 'products' });
      const picking = byId('picking').options;
      assert.deepEqual(picking.map((o) => o.to), [{ page: 'picking' }, { path: '/zamowienia/status/w-kompletacji' }, { path: '/zamowienia/status/spakowane' }, { path: '/pakowanie' }]);
      assert.equal(cfg.isOptionActive(picking[0], { page: 'picking', path: '/kompletacja', order: false }), true);
      assert.equal(cfg.isOptionActive(picking[1], { page: 'orders', path: '/zamowienia/status/w-kompletacji', order: false }), true);
      assert.equal(cfg.isOptionActive(picking[1], { page: 'orders', path: '/zamowienia/status/w-kompletacji', order: true }), false, 'nothing is active on an order card');
    });
    await t.test('panel visibility is stored per workspace and person and survives blocked storage', () => {
      assert.equal(cfg.navStorageKey('t1', 'u1'), 'dyna.nav.t1.u1');
      assert.equal(cfg.readPanelHidden('t1', 'u1'), false);
      cfg.writePanelHidden('t1', 'u1', true);
      assert.equal(cfg.readPanelHidden('t1', 'u1'), true);
      assert.equal(cfg.readPanelHidden('t1', 'u2'), false);
      window.localStorage.setItem('dyna.nav.t1.u3', '{broken');
      assert.equal(cfg.readPanelHidden('t1', 'u3'), false);
      const storage = Object.getOwnPropertyDescriptor(window, 'localStorage');
      Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new Error('blocked'); } });
      try {
        assert.equal(cfg.readPanelHidden('t1', 'u1'), false);
        assert.doesNotThrow(() => cfg.writePanelHidden('t1', 'u1', false));
      } finally {
        Object.defineProperty(window, 'localStorage', storage);
      }
    });
    await t.test('collapsed rail shows names as tooltips and marks the active module', async () => {
      const mods = cfg.visibleModules(true);
      const clicked = [];
      let warehouse = 0;
      const el = await render(ui.ModuleMenu, { modules: mods, activeId: 'orders', collapsed: true, onModule: (m) => clicked.push(m.id), onWarehouse: () => warehouse++ });
      const orders = el.querySelector('[data-tooltip="Zamówienia"]');
      assert.equal(orders.getAttribute('aria-current'), 'page');
      assert.equal(orders.getAttribute('aria-label'), 'Zamówienia');
      assert.equal(el.querySelectorAll('[aria-current]').length, 1);
      await act(async () => el.querySelector('[data-tooltip="Asortyment"]').click());
      await act(async () => el.querySelector('[data-tooltip="Moduł magazyniera"]').click());
      assert.deepEqual(clicked, ['catalog']);
      assert.equal(warehouse, 1);
      const expanded = await render(ui.ModuleMenu, { modules: mods, activeId: 'dashboard', collapsed: false, onModule: () => {}, onWarehouse: () => {} });
      assert.equal(expanded.querySelector('[data-tooltip]'), null, 'expanded menu shows names, no tooltips');
      assert.match(expanded.textContent, /Przegląd.*Zamówienia.*Asortyment/);
    });
    await t.test('options panel: one click per option, « hides it', async () => {
      const catalog = cfg.visibleModules(true).find((m) => m.id === 'catalog');
      const picked = [];
      let hidden = 0;
      const el = await render(ui.ModuleOptionsPanel, { module: catalog, view: { page: 'pricing', path: '/cenniki', order: false }, onOption: (o) => picked.push(o.key), onHide: () => hidden++ });
      const options = [...el.querySelectorAll('.module-option')];
      assert.deepEqual(options.map((b) => b.textContent), ['Produkty', 'Cenniki', 'Magazyny', 'Partie i FIFO', 'Inwentaryzacje partii', 'Zakupy i dostawy', 'Reguły produktów']);
      assert.equal(options[1].getAttribute('aria-current'), 'page');
      await act(async () => options[2].click());
      await act(async () => el.querySelector('[aria-label="Ukryj panel"]').click());
      assert.deepEqual(picked, ['inventory']);
      assert.equal(hidden, 1);
    });
  } finally {
    for (const root of roots) await act(async () => root.unmount());
    await vite.close();
    for (const [k, d] of prior) { if (d) Object.defineProperty(globalThis, k, d); else delete globalThis[k]; }
    dom.window.close();
  }
});
