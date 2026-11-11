import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

/** ANALYTICS-002 groups view and the REPRICE-005/006 channel line (migration 247). */
const tenant = '00000001-1000-4000-8000-000000000001';
const report = (value) => {
  const strip = (o) => (value ? o : Object.fromEntries(Object.entries(o).filter(([k]) => !k.endsWith('_minor'))));
  return {
    current_role: value ? 'admin' : 'operator', can_read_value: value, group_by: 'delivery', dimensions_available: true,
    period: { from: '2026-10-01', to: '2026-10-31', orders: 5, unrecorded_orders: 1 },
    compare: { from: '2026-09-01', to: '2026-09-30', orders: 3, unrecorded_orders: 0 },
    groups: [
      strip({ currency: 'PLN', group: 'courier', label: 'Kurier', orders: 3, compare_orders: 1, orders_delta: 2, total_gross_minor: '30000', compare_total_gross_minor: '10000', total_delta_minor: '20000', total_change_bps: 20000, share_bps: 7500 }),
      strip({ currency: 'PLN', group: 'unknown', label: 'Brak danych o dostawie', orders: 2, compare_orders: 2, orders_delta: 0, total_gross_minor: '10000', compare_total_gross_minor: '4000', total_delta_minor: '6000', total_change_bps: 15000, share_bps: 2500 }),
    ],
    totals: [strip({ currency: 'PLN', orders: 5, total_gross_minor: '40000' })],
    compare_totals: [strip({ currency: 'PLN', orders: 3, total_gross_minor: '14000' })],
  };
};

test('GroupsView: comparison table sums to the totals, operator sees counts only, admin backfill; channel line', async (t) => {
  const dom = new JSDOM('<!doctype html><body/>', { url: 'http://127.0.0.1/' }), saved = new Map(), oldFetch = globalThis.fetch;
  for (const [k, v] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, Event: dom.window.Event, MouseEvent: dom.window.MouseEvent, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(k, Object.getOwnPropertyDescriptor(globalThis, k));
    Object.defineProperty(globalThis, k, { configurable: true, writable: true, value: v });
  }
  const vite = await createServer({ server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: 'custom', logLevel: 'error' });
  const { createRoot } = await import('react-dom/client');
  const api = await vite.ssrLoadModule(path.resolve('web/api.ts'));
  const m = await vite.ssrLoadModule(path.resolve('web/reports-groups.tsx'));
  const ch = await vite.ssrLoadModule(path.resolve('web/repricing-channel.tsx'));
  const calls = [];
  let value = true;
  globalThis.fetch = async (url, init) => {
    const u = new URL(String(url), 'http://127.0.0.1');
    calls.push((init?.method ?? 'GET') + ' ' + u.pathname + u.search);
    if (u.pathname === '/api/reports/sales/groups') return Response.json(report(value));
    if (u.pathname === '/api/reports/sales/dimensions/backfill') return Response.json({ recorded: 1, remaining: 0 });
    return Response.json({ detail: 'Niedostępne w teście' }, { status: 404 });
  };
  api.setWorkspace(tenant);
  const tick = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  async function until(fn, note) { for (let n = 0; n < 80; n++) { if (fn()) return; await tick(); } assert(fn(), note); }
  const filters = { from: '2026-10-01', to: '2026-10-31', currency: '', source: '', status: '' };
  async function mount(admin) {
    const el = document.createElement('div');
    document.body.append(el);
    const root = createRoot(el);
    await act(async () => root.render(React.createElement(m.GroupsView, { filters, admin, readOnly: false, sourceNames: {} })));
    return { el, close: async () => { await act(async () => root.unmount()); el.remove(); } };
  }
  try {
    await t.test('previous period has the same length and ends the day before', () => {
      assert.deepEqual(m.previousPeriod('2026-10-01', '2026-10-31'), { from: '2026-08-31', to: '2026-09-30' });
      assert.deepEqual(m.previousPeriod('2026-03-30', '2026-03-30'), { from: '2026-03-29', to: '2026-03-29' });
      assert.equal(m.bps(20000), '+200,0 %');
      assert.equal(m.bps(-10000), '−100,0 %');
      assert.equal(m.bps(null), '—');
    });
    await t.test('admin: groups, previous period, deltas and totals; backfill offered for unrecorded orders', async () => {
      value = true;
      const h = await mount(true);
      await until(() => h.el.querySelector('tbody tr'), 'table');
      assert.match(calls[0], /group_by=delivery/);
      assert.match(calls[0], /compare_from=2026-08-31&compare_to=2026-09-30/);
      const rows = [...h.el.querySelectorAll('tbody tr')].map((r) => [...r.children].map((c) => c.textContent));
      assert.deepEqual(rows[0], ['Kurier', '3', '1', '+2', '300,00 PLN', '100,00 PLN', '200,00 PLN +200,0 %', '75,0 %']);
      assert.equal(h.el.querySelector('tfoot').textContent, 'Razem PLN53+2400,00 PLN140,00 PLN260,00 PLN100,0 %');
      const button = [...h.el.querySelectorAll('button')].find((b) => b.textContent.includes('Uzupełnij'));
      assert(button, 'backfill offered');
      await act(async () => button.dispatchEvent(new MouseEvent('click', { bubbles: true })));
      await until(() => h.el.textContent.includes('Uzupełniono 1'), 'backfill note');
      assert(calls.some((c) => c === 'POST /api/reports/sales/dimensions/backfill'));
      await h.close();
    });
    await t.test('operator: counts only, no amounts and no backfill', async () => {
      value = false;
      const h = await mount(false);
      await until(() => h.el.querySelector('tbody tr'), 'table');
      assert(!/\d,\d\d PLN/.test(h.el.textContent), 'no amounts');
      assert(h.el.textContent.includes('Kwoty są ukryte'));
      assert.equal(h.el.querySelectorAll('thead th').length, 4);
      assert(![...h.el.querySelectorAll('button')].some((b) => b.textContent.includes('Uzupełnij')));
      await h.close();
    });
    await t.test('channel summary line', () => {
      assert.equal(ch.channelText(null), 'Kanał: brak powiązanych ofert');
      assert.equal(ch.channelText({ total: 3, open: 1, pending: 1, sent: 0, acknowledged: 2, mismatch: 0, failed: 0, superseded: 0 }), 'Kanał: 3 oferty · 2 potwierdzone, 1 czeka');
      assert.equal(ch.channelText({ total: 5, open: 0, pending: 0, sent: 0, acknowledged: 3, mismatch: 1, failed: 1, superseded: 0 }), 'Kanał: 5 ofert · 3 potwierdzone, 1 rozbieżne, 1 błąd');
    });
  } finally {
    globalThis.fetch = oldFetch;
    await vite.close();
    for (const [k, d] of saved) d ? Object.defineProperty(globalThis, k, d) : delete globalThis[k];
  }
});
