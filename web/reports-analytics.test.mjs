import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

const tenant = '00000001-1000-4000-8000-000000000001', user = '00000002-1000-4000-8000-000000000001';
const buckets = [
  { key: '2026-10-24', label: '24.10.2026', from: '2026-10-24', to: '2026-10-24', from_at: '2026-10-23T22:00:00.000Z', to_exclusive_at: '2026-10-24T22:00:00.000Z', hours: 24 },
  { key: '2026-10-25', label: '25.10.2026', from: '2026-10-25', to: '2026-10-25', from_at: '2026-10-24T22:00:00.000Z', to_exclusive_at: '2026-10-25T23:00:00.000Z', hours: 25 },
  { key: '2026-10-26', label: '26.10.2026', from: '2026-10-26', to: '2026-10-26', from_at: '2026-10-25T23:00:00.000Z', to_exclusive_at: '2026-10-26T23:00:00.000Z', hours: 24 },
];
const point = (key, orders, q, total) => ({ key, orders, commercial_quantity: q, goods_gross_minor: total, goods_net_minor: total, delivery_gross_minor: '0', total_gross_minor: total });
const periods = (value) => {
  const strip = (o) => (value ? o : Object.fromEntries(Object.entries(o).filter(([k]) => !k.endsWith('_minor'))));
  return {
    current_role: value ? 'admin' : 'operator', can_read_value: value, read_only: false, as_of: '2026-10-26T10:00:00.000Z', buckets,
    series: [{ currency: 'PLN', points: [point('2026-10-24', '1', '2', '21500'), point('2026-10-25', '2', '2', '62500'), point('2026-10-26', '0', '0', '0')].map(strip), totals: strip(point('', '3', '4', '84000')) }],
    by_source: [strip({ currency: 'PLN', source: 'manual', ...point('', '3', '4', '84000') })],
    by_status: [strip({ currency: 'PLN', status: 'new', ...point('', '3', '4', '84000') })],
    options: { sources: ['manual'], statuses: ['new'] },
  };
};
const customers = { current_role: 'operator', can_read_value: false, personal_data: 'masked', summary: { customers: 2, new_customers: 1, returning_customers: 1, repeat_in_period: 0, orders: 3, orders_without_email: 1 },
  currencies: [{ currency: 'PLN', customers: 2, new_customers: 1, returning_customers: 1, orders: 3 }], countries: [{ country: 'PL', currency: 'PLN', customers: 2, orders: 3 }],
  top_customers: [{ rank: 1, currency: 'PLN', email: 'j***@e***.test', customer_name: 'J. K.', country: 'PL', kind: 'returning', orders: 1, lifetime_orders: 2 }] };

test('ReportAnalytics: chart bars and data table equal the series, values hidden for operators, masked customers, admin-only tab', async (t) => {
  const dom = new JSDOM('<!doctype html><body/>', { url: 'http://127.0.0.1/' }), saved = new Map(), oldFetch = globalThis.fetch;
  for (const [k, v] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, Event: dom.window.Event, MouseEvent: dom.window.MouseEvent, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(k, Object.getOwnPropertyDescriptor(globalThis, k));
    Object.defineProperty(globalThis, k, { configurable: true, writable: true, value: v });
  }
  const vite = await createServer({ server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: 'custom', logLevel: 'error' });
  const { createRoot } = await import('react-dom/client');
  const api = await vite.ssrLoadModule(path.resolve('web/api.ts'));
  const m = await vite.ssrLoadModule(path.resolve('web/reports-analytics.tsx'));
  const calls = [];
  let value = true;
  globalThis.fetch = async (url) => {
    const u = new URL(String(url), 'http://127.0.0.1');
    calls.push(u.pathname + u.search);
    if (u.pathname === '/api/reports/sales/periods') return Response.json(periods(value));
    if (u.pathname === '/api/reports/customers') return Response.json(customers);
    return Response.json({ detail: 'Niedostępne w teście' }, { status: 404 });
  };
  api.setWorkspace(tenant);
  const tick = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  async function until(fn, note) { for (let n = 0; n < 80; n++) { if (fn()) return; await tick(); } assert(fn(), note); }
  async function mount(role) {
    const el = document.createElement('div');
    document.body.append(el);
    const root = createRoot(el);
    await act(async () => root.render(React.createElement(m.ReportAnalytics, { workspaceId: tenant, contextKey: `${tenant}:${user}:${role}`, readOnly: false })));
    return { el, close: async () => { await act(async () => root.unmount()); el.remove(); } };
  }
  const submit = (h) => act(async () => h.el.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  try {
    await t.test('money formatting is exact for large and negative values', () => {
      assert.equal(m.analyticsMoney('123456789012345678', 'PLN'), '1 234 567 890 123 456,78 PLN');
      assert.equal(m.analyticsMoney('-1500', 'EUR'), '−15,00 EUR');
      assert.equal(m.analyticsMoney(null, 'PLN'), '—');
    });
    await t.test('admin: one bar per bucket, accessible label, table totals, CSV hint, employees tab', async () => {
      value = true;
      const h = await mount('admin');
      await submit(h);
      await until(() => h.el.querySelector('figure svg'), 'chart');
      const bars = h.el.querySelectorAll('rect.bar');
      assert.equal(bars.length, 3);
      assert.deepEqual([...bars].map((b) => b.querySelector('title').textContent), ['24.10.2026: 215,00 PLN', '25.10.2026: 625,00 PLN', '26.10.2026: 0,00 PLN']);
      assert.match(h.el.querySelector('svg').getAttribute('aria-label'), /3 okresów, razem 840,00 PLN/);
      assert.equal(h.el.querySelector('tfoot').textContent, 'Razem34840,00 PLN0,00 PLN840,00 PLN');
      assert(h.el.textContent.includes('25.10.2026 (25 h)'), 'DST day marked');
      assert([...h.el.querySelectorAll('[role=tab]')].some((b) => b.textContent === 'Pracownicy'));
      assert.match(calls.at(-1), /granularity=day/);
      await h.close();
    });
    await t.test('operator: quantities only, no employees tab, masked customers', async () => {
      value = false;
      const h = await mount('operator');
      await submit(h);
      await until(() => h.el.querySelector('figure svg'), 'chart');
      assert(!h.el.textContent.includes('PLN ') && !/\d,\d\d PLN/.test(h.el.textContent), 'no amounts');
      assert(h.el.textContent.includes('Kwoty są ukryte'));
      assert.equal([...h.el.querySelectorAll('[role=tab]')].some((b) => b.textContent === 'Pracownicy'), false);
      await act(async () => [...h.el.querySelectorAll('[role=tab]')].find((b) => b.textContent === 'Klienci').dispatchEvent(new MouseEvent('click', { bubbles: true })));
      await until(() => h.el.textContent.includes('Najwięksi klienci'), 'customers');
      assert(h.el.textContent.includes('zamaskowane'));
      assert(h.el.textContent.includes('j***@e***.test'));
      await h.close();
    });
  } finally {
    globalThis.fetch = oldFetch;
    await vite.close();
    for (const [k, d] of saved) d ? Object.defineProperty(globalThis, k, d) : delete globalThis[k];
  }
});
