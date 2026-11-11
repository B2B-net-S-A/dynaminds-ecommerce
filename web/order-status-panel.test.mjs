/** Actual React status panel next to the order list; controlled props, no app/server/PG. */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';
const wf = (n, extra = {}) => ({ id: n.toString(16).padStart(8, '0') + '-1000-4000-8000-000000000001', name: 'Własny ' + n, color: '#123456', stage: 'paid', category: null, active: true, ...extra });
test('order status panel: five categories with counters, custom statuses nested by name, filters', async (t) => {
  const dom = new JSDOM('<body/>', { url: 'http://127.0.0.1:4106/' }), prior = new Map();
  for (const [k, v] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, Event: dom.window.Event, MouseEvent: dom.window.MouseEvent, IS_REACT_ACT_ENVIRONMENT: true })) {
    prior.set(k, Object.getOwnPropertyDescriptor(globalThis, k));
    Object.defineProperty(globalThis, k, { configurable: true, writable: true, value: v });
  }
  const vite = await createServer({ server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: 'custom', logLevel: 'error' });
  const mod = await vite.ssrLoadModule(path.resolve('web/order-status-panel.tsx'));
  const { OrderStatusPanel, allOrders, orderStatusFilterSummary, orderStatusBreadcrumb, ordersCountLabel, workflowPanelNodes } = mod;
  const { statusNames } = await vite.ssrLoadModule(path.resolve('web/api.ts'));
  const { createRoot } = await import('react-dom/client');
  const roots = new Set();
  async function mount(props) {
    const el = document.createElement('div');
    document.body.append(el);
    const root = createRoot(el);
    roots.add(root);
    let current = props;
    const h = {
      el,
      async render(patch = {}) { current = { ...current, ...patch }; await act(async () => root.render(React.createElement(OrderStatusPanel, current))); },
      async close() { await act(async () => root.unmount()); roots.delete(root); el.remove(); },
    };
    await h.render();
    return h;
  }
  // Exact label match. A category and a stage can both be called "Nowe": row() is a status row, head() a category.
  const button = (h, text) => [...h.el.querySelectorAll('button')].find((b) => (b.querySelector('.status-panel-label') ?? b.firstChild)?.textContent === text);
  const row = (h, text) => [...h.el.querySelectorAll('button.status-panel-item, button.status-panel-parent')].find((b) => b.querySelector('.status-panel-label')?.textContent === text);
  const head = (h, text) => [...h.el.querySelectorAll('button.status-panel-group-head')].find((b) => b.firstChild?.textContent === text);
  const section = (h, label) => h.el.querySelector('section[aria-label="' + label + '"]');
  const labels = (el) => [...el.querySelectorAll(':scope > ul > li')].map((li) => li.querySelector('.status-panel-label').textContent);
  // Custom statuses: one by its stage (Nowe), one with its own category, two (+ one named like them) under "Pakowanie".
  const problem = wf(3, { name: 'Problem', stage: 'paid', category: 'not_completed', color: '#D23B3B' });
  const dpd = wf(4, { name: 'Pakowanie / Do zebrania DPD', stage: 'picking' });
  const inpost = wf(5, { name: 'Pakowanie/W realizacji InPost', stage: 'packed' });
  const packing = wf(6, { name: 'Pakowanie', stage: 'picking' });
  const counts = { statuses: { new: 3, paid: 4, picking: 2, packed: 1, ready_to_ship: 2, shipped: 11, delivered: 136, cancelled: 4, return_received: 1 }, workflow: { [wf(1).id]: 5, [problem.id]: 2, [dpd.id]: 1, [inpost.id]: 3, [packing.id]: 4 }, total: 164 };
  try {
    await t.test('five categories in order with stage counts and sums', async () => {
      const h = await mount({ counts, workflows: [], filter: allOrders, onSelect: () => {} });
      assert.deepEqual([...h.el.querySelectorAll('section')].map((x) => x.getAttribute('aria-label')), ['Nowe', 'W realizacji', 'Zrealizowane', 'Niezrealizowane', 'Pozostałe']);
      assert.match(button(h, 'Wszystkie zamówienia').textContent, /164$/);
      assert.match(head(h, 'Nowe').textContent, /7$/, 'Nowe + Nieopłacone');
      assert.match(head(h, 'W realizacji').textContent, /5$/);
      assert.match(head(h, 'Zrealizowane').textContent, /147$/);
      assert.match(head(h, 'Niezrealizowane').textContent, /4$/);
      assert.match(head(h, 'Pozostałe').textContent, /1$/);
      assert.deepEqual(labels(section(h, 'Nowe')), ['Nowe', 'Nieopłacone']);
      assert.deepEqual(labels(section(h, 'W realizacji')), ['W kompletacji', 'Spakowane', 'Gotowe do nadania']);
      assert.deepEqual(labels(section(h, 'Zrealizowane')), ['Nadane', 'Dostarczone', 'Zakończone']);
      assert.deepEqual(labels(section(h, 'Niezrealizowane')), ['Anulowane']);
      assert.deepEqual(labels(section(h, 'Pozostałe')), ['Zwrot zgłoszony', 'Zwrot przyjęty', 'Zwrot zakończony']);
      // The panel lists code new as "Nieopłacone" (panelLabel); "Czeka na wpłatę" is the status column's label.
      assert.match(row(h, 'Nieopłacone').textContent, /3$/);
      assert.match(row(h, statusNames.paid).textContent, /4$/);
      assert.match(row(h, 'Zakończone').textContent, /0$/);
      assert.match(row(h, 'Gotowe do nadania').textContent, /2$/);
      assert.equal(button(h, 'Wszystkie zamówienia').getAttribute('aria-current'), 'true');
      assert.equal(h.el.querySelectorAll('[aria-current]').length, 1);
      assert.equal(section(h, 'Statusy własne'), null, 'no separate custom status section');
      assert.equal(button(h, 'Zarządzaj'), undefined, 'manage link only when allowed');
      assert.equal(button(h, '+ Dodaj status'), undefined);
      await h.close();
    });
    await t.test('loading counters show a placeholder, not zero', async () => {
      const h = await mount({ counts: null, workflows: [dpd], filter: allOrders, onSelect: () => {} });
      assert.match(row(h, statusNames.paid).textContent, /…$/);
      assert.match(row(h, 'Pakowanie').textContent, /…$/);
      await h.close();
    });
    await t.test('a zero bucket stays visible with 0', async () => {
      const h = await mount({ counts: { ...counts, statuses: { ...counts.statuses, paid: 0 } }, workflows: [], filter: allOrders, onSelect: () => {} });
      assert.match(row(h, statusNames.paid).textContent, /0$/);
      assert.match(head(h, 'Nowe').textContent, /3$/);
      await h.close();
    });
    await t.test('custom statuses sit in their category; category sums do not add them again', async () => {
      const h = await mount({ counts, workflows: [wf(1), problem, dpd, inpost, wf(2, { active: false })], filter: allOrders, onSelect: () => {} });
      assert.deepEqual(labels(section(h, 'Nowe')), ['Nowe', 'Nieopłacone', 'Własny 1'], 'category of its stage');
      assert.deepEqual(labels(section(h, 'Niezrealizowane')), ['Anulowane', 'Problem'], 'own category beats the stage (paid)');
      assert.ok(!labels(section(h, 'Nowe')).includes('Problem'));
      assert.match(row(h, 'Problem').textContent, /2$/);
      assert.match(head(h, 'Nowe').textContent, /7$/);
      assert.match(head(h, 'Niezrealizowane').textContent, /4$/);
      assert.equal(row(h, 'Własny 2'), undefined, 'inactive custom status is hidden');
      await h.close();
    });
    await t.test('two-level names nest under a collapsible parent with the sum of its children', async () => {
      const seen = [];
      const h = await mount({ counts, workflows: [inpost, dpd], filter: allOrders, onSelect: (f) => seen.push(f) });
      const parent = row(h, 'Pakowanie');
      assert.ok(parent.classList.contains('status-panel-parent'), 'no status named Pakowanie: the row only toggles');
      assert.match(parent.textContent, /4$/, '1 + 3');
      assert.deepEqual([...parent.closest('li').querySelectorAll('ul.status-panel-children .status-panel-label')].map((x) => x.textContent), ['Do zebrania DPD', 'W realizacji InPost']);
      assert.match(row(h, 'Do zebrania DPD').textContent, /1$/);
      assert.match(head(h, 'W realizacji').textContent, /5$/, 'children are inside the stage counts');
      await act(async () => parent.click());
      assert.equal(row(h, 'Do zebrania DPD'), undefined, 'collapsed');
      assert.equal(h.el.querySelector('[aria-label="Rozwiń: Pakowanie"]').getAttribute('aria-expanded'), 'false');
      assert.match(row(h, 'Pakowanie').textContent, /4$/, 'parent count stays visible');
      await act(async () => h.el.querySelector('[aria-label="Rozwiń: Pakowanie"]').click());
      await act(async () => row(h, 'W realizacji InPost').click());
      assert.deepEqual(seen, [{ status: '', workflow: inpost.id }], 'toggling the parent selects nothing');
      await h.close();
    });
    await t.test('a status named like the parent makes the parent selectable and still collapsible', async () => {
      const seen = [];
      const h = await mount({ counts, workflows: [dpd, packing, inpost], filter: allOrders, onSelect: (f) => seen.push(f) });
      const parent = row(h, 'Pakowanie');
      assert.ok(parent.classList.contains('status-panel-item'));
      assert.match(parent.textContent, /8$/, 'own 4 + children 1 + 3');
      assert.equal(labels(section(h, 'W realizacji')).filter((x) => x === 'Pakowanie').length, 1, 'listed once');
      await act(async () => parent.click());
      assert.deepEqual(seen, [{ status: '', workflow: packing.id }]);
      await h.render({ filter: { status: '', workflow: packing.id } });
      assert.equal(row(h, 'Pakowanie').getAttribute('aria-current'), 'true');
      await act(async () => h.el.querySelector('[aria-label="Zwiń: Pakowanie"]').click());
      assert.equal(row(h, 'Do zebrania DPD'), undefined);
      assert.ok(row(h, 'Pakowanie'));
      await h.close();
    });
    await t.test('selection calls back with status, category or custom status filter', async () => {
      const seen = [];
      let manage = 0;
      const h = await mount({ counts, workflows: [wf(1), wf(2, { active: false })], filter: allOrders, onSelect: (f) => seen.push(f), onManage: () => manage++ });
      await act(async () => row(h, statusNames.paid).click());
      await act(async () => head(h, 'W realizacji').click());
      await act(async () => head(h, 'Nowe').click());
      await act(async () => row(h, 'Własny 1').click());
      await act(async () => button(h, 'Wszystkie zamówienia').click());
      assert.deepEqual(seen, [
        { status: 'paid', workflow: '' },
        { status: 'picking,packed,ready_to_ship', workflow: '' },
        { status: 'paid,new', workflow: '' },
        { status: '', workflow: wf(1).id },
        { status: '', workflow: '' },
      ]);
      assert.match(row(h, 'Własny 1').textContent, /5$/);
      await act(async () => button(h, 'Zarządzaj').click());
      await act(async () => button(h, '+ Dodaj status').click());
      assert.equal(manage, 2, '"+ Dodaj status" opens the manager when no separate handler is given');
      await h.render({ filter: { status: 'paid', workflow: '' } });
      assert.equal(row(h, statusNames.paid).getAttribute('aria-current'), 'true');
      assert.equal(button(h, 'Wszystkie zamówienia').getAttribute('aria-current'), null);
      await h.render({ filter: { status: 'picking,packed,ready_to_ship', workflow: '' } });
      assert.equal(head(h, 'W realizacji').getAttribute('aria-current'), 'true');
      await h.render({ filter: { status: '', workflow: wf(1).id } });
      assert.equal(row(h, 'Własny 1').getAttribute('aria-current'), 'true');
      await h.render({ disabled: true });
      assert([...h.el.querySelectorAll('button.status-panel-item, button.status-panel-group-head')].every((b) => b.disabled));
      await h.close();
    });
    await t.test('a category collapses and expands without changing the selection', async () => {
      const seen = [];
      const h = await mount({ counts, workflows: [], filter: allOrders, onSelect: (f) => seen.push(f) });
      await act(async () => h.el.querySelector('[aria-label="Zwiń: Zrealizowane"]').click());
      assert.equal(row(h, 'Nadane'), undefined);
      assert.equal(h.el.querySelector('[aria-label="Rozwiń: Zrealizowane"]').getAttribute('aria-expanded'), 'false');
      assert.match(head(h, 'Zrealizowane').textContent, /147$/, 'category count stays visible');
      await act(async () => h.el.querySelector('[aria-label="Rozwiń: Zrealizowane"]').click());
      assert.ok(row(h, 'Nadane'));
      assert.deepEqual(seen, []);
      await h.close();
    });
    await t.test('workflowPanelNodes builds the tree per category', () => {
      const all = [dpd, inpost, packing, problem, wf(1)];
      const nodes = workflowPanelNodes(all, 'in_progress');
      assert.deepEqual(nodes.map((n) => [n.kind, n.kind === 'parent' ? n.name : n.label]), [['parent', 'Pakowanie']]);
      assert.equal(nodes[0].self.id, packing.id);
      assert.deepEqual(nodes[0].children.map((c) => c.label), ['Do zebrania DPD', 'W realizacji InPost']);
      assert.deepEqual(workflowPanelNodes(all, 'not_completed').map((n) => n.label), ['Problem']);
      assert.deepEqual(workflowPanelNodes(all, 'new').map((n) => n.label), ['Własny 1']);
      assert.deepEqual(workflowPanelNodes([wf(2, { active: false })], 'new'), []);
    });
    await t.test('breadcrumb above the list', () => {
      assert.deepEqual(orderStatusBreadcrumb({ status: 'paid', workflow: '' }, []), ['Zamówienia', 'Nowe', 'Nowe']);
      assert.deepEqual(orderStatusBreadcrumb({ status: 'new', workflow: '' }, []), ['Zamówienia', 'Nowe', 'Nieopłacone']);
      assert.deepEqual(orderStatusBreadcrumb({ status: 'cancelled', workflow: '' }, []), ['Zamówienia', 'Niezrealizowane', 'Anulowane']);
      assert.deepEqual(orderStatusBreadcrumb({ status: 'shipped,delivered,completed', workflow: '' }, []), ['Zamówienia', 'Zrealizowane']);
      assert.deepEqual(orderStatusBreadcrumb({ status: 'paid,picking,packed,ready_to_ship', workflow: '' }, []), ['Zamówienia', 'Do realizacji'], 'old link');
      assert.deepEqual(orderStatusBreadcrumb({ status: '', workflow: wf(1).id }, [wf(1)]), ['Zamówienia', 'Nowe', 'Własny 1']);
      assert.deepEqual(orderStatusBreadcrumb({ status: '', workflow: problem.id }, [problem]), ['Zamówienia', 'Niezrealizowane', 'Problem']);
      assert.deepEqual(orderStatusBreadcrumb({ status: '', workflow: dpd.id }, [dpd]), ['Zamówienia', 'W realizacji', 'Pakowanie', 'Do zebrania DPD']);
      assert.deepEqual(orderStatusBreadcrumb({ status: '', workflow: dpd.id }, []), ['Zamówienia', 'Status własny'], 'before statuses load');
      assert.deepEqual(orderStatusBreadcrumb(allOrders, []), ['Zamówienia']);
    });
    await t.test('list heading names the selection with its count', () => {
      assert.deepEqual(orderStatusFilterSummary(allOrders, counts, []), { title: 'Wszystkie zamówienia', count: 164 });
      assert.deepEqual(orderStatusFilterSummary({ status: 'picking,packed,ready_to_ship', workflow: '' }, counts, []), { title: 'W realizacji', count: 5 });
      assert.deepEqual(orderStatusFilterSummary({ status: 'paid,new', workflow: '' }, counts, []), { title: 'Nowe', count: 7 });
      assert.equal(orderStatusFilterSummary({ status: 'ready_to_ship', workflow: '' }, { ...counts, statuses: {} }, []).count, 0, 'missing key counts as 0');
      assert.deepEqual(orderStatusFilterSummary({ status: 'new', workflow: '' }, counts, []), { title: 'Nieopłacone', count: 3 });
      assert.deepEqual(orderStatusFilterSummary({ status: 'shipped,delivered,completed', workflow: '' }, counts, []), { title: 'Zrealizowane', count: 147 });
      assert.deepEqual(orderStatusFilterSummary({ status: '', workflow: wf(1).id }, counts, [wf(1)]), { title: 'Własny 1', count: 5 });
      assert.equal(orderStatusFilterSummary(allOrders, null, []).count, null);
      assert.deepEqual([1, 3, 5, 12, 22, 25].map(ordersCountLabel), ['1 zamówienie', '3 zamówienia', '5 zamówień', '12 zamówień', '22 zamówienia', '25 zamówień']);
    });
  } finally {
    for (const root of roots) await act(async () => root.unmount());
    await vite.close();
    for (const [k, d] of prior) { if (d) Object.defineProperty(globalThis, k, d); else delete globalThis[k]; }
    dom.window.close();
  }
});
