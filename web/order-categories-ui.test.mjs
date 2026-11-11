/** Status categories in the office UI (Uwagi v3 §0): colour palette, custom status manager rules, counts in the
 * automation status list. Run: node --test web/order-categories-ui.test.mjs */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

test('status categories in the office UI', async (t) => {
  const dom = new JSDOM('<body/>', { url: 'http://127.0.0.1:4106/' }), prior = new Map(), oldFetch = globalThis.fetch;
  for (const [k, v] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, Event: dom.window.Event, MouseEvent: dom.window.MouseEvent, CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true })) {
    prior.set(k, Object.getOwnPropertyDescriptor(globalThis, k));
    Object.defineProperty(globalThis, k, { configurable: true, writable: true, value: v });
  }
  const vite = await createServer({ server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: 'custom', logLevel: 'error' });
  const stage = await vite.ssrLoadModule(path.resolve('web/order-stage.ts'));
  const form = await vite.ssrLoadModule(path.resolve('web/workflow-status-form.ts'));
  const fields = await vite.ssrLoadModule(path.resolve('web/automation-v2-fields.tsx'));
  const { createRoot } = await import('react-dom/client');
  const roots = new Set();
  try {
    await t.test('palette: the stage colours, each once, each with a name', () => {
      const colours = stage.statusPalette.map((p) => p.color.toLowerCase());
      assert.equal(new Set(colours).size, colours.length, 'unique colours');
      assert.deepEqual(new Set(colours), new Set(Object.values(stage.fulfilmentColors).map((c) => c.toLowerCase())), 'every stage colour offered');
      for (const p of stage.statusPalette) assert.match(p.label, /^\S+ — \S/, p.color + ' has a meaning');
      assert.equal(stage.statusPalette.find((p) => p.color === '#D23B3B').label, 'Czerwony — wymaga reakcji');
    });
    await t.test('two-level names: compose, length limit, slash in a child', () => {
      assert.equal(form.composeWorkflowName('Pakowanie', ' Do zebrania DPD '), 'Pakowanie / Do zebrania DPD');
      assert.equal(form.composeWorkflowName('', 'Problem'), 'Problem');
      assert.equal(form.workflowNameError('', 'Problem'), '');
      assert.equal(form.workflowNameError('Pakowanie', 'x'.repeat(68)), '', '9 + 3 + 68 = 80');
      assert.match(form.workflowNameError('Pakowanie', 'x'.repeat(69)), /81 znaków; dopuszczalne jest 80/);
      assert.match(form.workflowNameError('Pakowanie', 'A/B'), /„\/”/);
      assert.equal(form.workflowNameError('', 'Pakowanie / A'), '', 'a typed two-level name is allowed without a parent');
    });
    await t.test('parent choices: parents and top-level statuses of the same category, not the edited one', () => {
      const rows = [
        { id: '1', name: 'Pakowanie / Do zebrania DPD', stage: 'picking', category: null },
        { id: '2', name: 'Pakowanie / InPost', stage: 'packed', category: null },
        { id: '3', name: 'Kontrola', stage: 'picking', category: null },
        { id: '4', name: 'Problem', stage: 'paid', category: 'not_completed' },
        { id: '5', name: 'Czeka na klienta', stage: 'paid', category: null },
      ];
      assert.deepEqual(form.workflowParentOptions(rows, 'in_progress'), ['Kontrola', 'Pakowanie']);
      assert.deepEqual(form.workflowParentOptions(rows, 'in_progress', '3'), ['Pakowanie']);
      assert.deepEqual(form.workflowParentOptions(rows, 'not_completed'), ['Problem']);
      assert.deepEqual(form.workflowParentOptions(rows, 'new'), ['Czeka na klienta'], 'Problem has its own category');
    });
    await t.test('status option counts: stages, custom statuses, group totals without double counting', () => {
      const counts = { statuses: { paid: 4, picking: 2, packed: 1 }, workflow: { abc: 3 }, total: 7 };
      assert.equal(fields.statusOptionCount('order.status', 'picking', counts), 2);
      assert.equal(fields.statusOptionCount('order.status', 'wf:abc', counts), 3);
      assert.equal(fields.statusOptionCount('order.status', 'shipped', counts), 0);
      assert.equal(fields.statusOptionCount('order.workflow_status', 'abc', counts), 3);
      const group = [{ value: 'picking', label: 'W kompletacji' }, { value: 'packed', label: 'Spakowane' }, { value: 'wf:abc', label: 'Paczkomat' }];
      assert.equal(fields.statusGroupCount('order.status', group, counts), 3, 'custom status is inside its stage');
      assert.equal(fields.statusGroupCount('order.workflow_status', [{ value: 'abc', label: 'Paczkomat' }], counts), 3);
    });
    const mount = async (props) => {
      const el = document.createElement('div');
      document.body.append(el);
      const root = createRoot(el);
      roots.add(root);
      await act(async () => root.render(React.createElement(fields.ListValueEditor, props)));
      await act(async () => new Promise((r) => setTimeout(r, 0)));
      return el;
    };
    const options = [
      { group: 'Nowe', value: 'paid', label: 'Nowe' },
      { group: 'Nowe', value: 'new', label: 'Nieopłacone' },
      { group: 'W realizacji', value: 'picking', label: 'W kompletacji' },
      { group: 'W realizacji', value: 'wf:abc', label: 'Paczkomat' },
    ];
    await t.test('the status list shows counts per option and per category', async () => {
      const calls = [];
      globalThis.fetch = async (url) => {
        calls.push(String(url));
        return Response.json({ statuses: { paid: 4, new: 1, picking: 2 }, workflow: { abc: 2 }, total: 7 });
      };
      const el = await mount({ options, value: [], onChange: () => {}, label: 'Status realizacji', countField: 'order.status' });
      assert.deepEqual(calls, ['/api/orders/status-counts'], 'fetched once');
      assert.deepEqual([...el.querySelectorAll('.av2-list-group')].map((g) => g.textContent), ['Nowe (5):', 'W realizacji (2):']);
      assert.deepEqual([...el.querySelectorAll('.av2-list-option')].map((o) => o.textContent), ['Nowe4', 'Nieopłacone1', 'W kompletacji2', 'Paczkomat2']);
    });
    await t.test('without counts the list still works and says why', async () => {
      globalThis.fetch = async () => Response.json({ detail: 'Brak uprawnień' }, { status: 403 });
      const el = await mount({ options, value: [], onChange: () => {}, label: 'Status realizacji', countField: 'order.status' });
      assert.deepEqual([...el.querySelectorAll('.av2-list-group')].map((g) => g.textContent), ['Nowe:', 'W realizacji:']);
      assert.equal(el.querySelectorAll('.av2-list-count').length, 0);
      assert.match(el.querySelector('.av2-list-pop').textContent, /Liczby zamówień niedostępne: Brak uprawnień/);
    });
    await t.test('other list fields do not fetch counts', async () => {
      const calls = [];
      globalThis.fetch = async (url) => (calls.push(String(url)), Response.json({}));
      const el = await mount({ options: [{ value: 'PLN', label: 'PLN' }], value: [], onChange: () => {}, label: 'Waluta', countField: 'order.currency' });
      assert.deepEqual(calls, []);
      assert.equal(el.querySelector('.av2-list-option').textContent, 'PLN');
    });
  } finally {
    for (const root of roots) await act(async () => root.unmount());
    await vite.close();
    globalThis.fetch = oldFetch;
    for (const [k, d] of prior) { if (d) Object.defineProperty(globalThis, k, d); else delete globalThis[k]; }
    dom.window.close();
  }
});
