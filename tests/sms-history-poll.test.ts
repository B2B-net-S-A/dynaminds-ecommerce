/** SMS history poll (S5 open item): the panel refreshes every 5 s. A reply slower than one tick
 * must still render, and a reply for a page the user already left must not overwrite the page
 * shown. jsdom with a controlled fetch and a hand-driven 5 s interval; no HTTP or DB. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire, registerHooks } from 'node:module';
import './nbp227-ui-dom';
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';
// The panel imports Vite stylesheets; Node gets an empty module for them.
registerHooks({ load: (url, context, next) => (url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : next(url, context)) });
const { SmsPanel } = await import('../web/sms');
const { JSDOM } = createRequire(import.meta.url)('jsdom');

const row = (id: string, number: string) => ({
  id, number, created_at: '2026-10-27T10:00:00.000Z', recipient: '48500100200', payload: 'Treść ' + number,
  parts: 1, encoding: 'GSM-7', state: 'simulated', mode: 'local', delivery: null, error: null,
});
const page = (rows: any[], cursor: string | null = null) => ({ data: rows, meta: { has_more: !!cursor, cursor } });

async function mount() {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/' });
  const old = new Map<string, PropertyDescriptor | undefined>();
  const history: { url: string; resolve: (v: unknown) => void }[] = [];
  const ticks: (() => void)[] = [];
  const realSetInterval = globalThis.setInterval, realClearInterval = globalThis.clearInterval;
  const fetch = (url: string) => {
    const reply = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.startsWith('/api/sms/messages'))
      return new Promise((resolve) => history.push({ url, resolve: (v) => resolve(reply(v)) }));
    if (url.startsWith('/api/sms/templates')) return Promise.resolve(reply({ data: [] }));
    if (url.startsWith('/api/integrations')) return Promise.resolve(reply({ channels: [] }));
    if (url.startsWith('/api/orders')) return Promise.resolve(reply(page([])));
    return Promise.resolve(reply({ data: [] }));
  };
  // Only the panel's 5 s poll is driven by hand; every other interval keeps the real clock.
  const setInterval = (fn: () => void, ms: number, ...rest: any[]) =>
    ms === 5000 ? (ticks.push(fn), -1 - ticks.length) : realSetInterval(fn, ms, ...rest);
  const clearInterval = (id: any) => (typeof id === 'number' && id < 0 ? undefined : realClearInterval(id));
  for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, fetch, setInterval, clearInterval, IS_REACT_ACT_ENVIRONMENT: true })) {
    old.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  }
  const root = createRoot(dom.window.document.getElementById('root'));
  const settle = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); });
  await act(async () => { root.render(createElement(SmsPanel, { admin: false, write: true, refresh: 0, reload: () => {} })); });
  await settle();
  const historyText = () => dom.window.document.querySelector('.sms-panels > section:last-of-type tbody')!.textContent as string;
  return {
    history, historyText, settle,
    tick: async () => { await act(async () => { for (const t of ticks) t(); }); await settle(); },
    click: async (label: string) => {
      const b = [...dom.window.document.querySelectorAll('button')].find((x: any) => x.textContent === label)!;
      assert(b, 'button ' + label);
      await act(async () => { b.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
      await settle();
    },
    close: async () => {
      await act(async () => root.unmount()); dom.window.close();
      for (const [n, d] of old) { if (d) Object.defineProperty(globalThis, n, d); else Reflect.deleteProperty(globalThis, n); }
    },
  };
}

test('a history reply slower than the 5 s poll still renders (no new poll while one is in flight)', async () => {
  const p = await mount();
  try {
    assert.equal(p.history.length, 1);
    await p.tick();
    await p.tick();
    p.history[0].resolve(page([row('m1', 'ZAM-SLOW')]));
    await p.settle();
    assert.match(p.historyText(), /ZAM-SLOW/, 'the reply that arrived after two ticks is shown');
    assert.equal(p.history.length, 1, 'a tick does not start a second history request while the first is in flight');
    await p.tick();
    assert.equal(p.history.length, 2, 'the next tick polls again once the reply arrived');
    p.history[1].resolve(page([row('m2', 'ZAM-NEXT')]));
    await p.settle();
    assert.match(p.historyText(), /ZAM-NEXT/);
  } finally {
    await p.close();
  }
});

test('a late reply for the page the user left never overwrites the page shown', async () => {
  const p = await mount();
  try {
    p.history[0].resolve(page([row('m1', 'ZAM-NEW')], 'c1'));
    await p.settle();
    await p.click('Starsze wiadomości');
    assert.equal(p.history.length, 2);
    assert.match(p.history[1].url, /after=c1/);
    await p.tick();
    assert.equal(p.history.length, 2, 'the older page is in flight; the tick waits');
    await p.click('Odśwież historię');
    assert.equal(p.history.length, 3, 'leaving the page starts a request at once');
    assert.doesNotMatch(p.history[2].url, /after=/);
    p.history[2].resolve(page([row('m3', 'ZAM-FIRST-PAGE')], 'c1'));
    await p.settle();
    assert.match(p.historyText(), /ZAM-FIRST-PAGE/);
    p.history[1].resolve(page([row('m0', 'ZAM-OLD-PAGE')]));
    await p.settle();
    assert.match(p.historyText(), /ZAM-FIRST-PAGE/);
    assert.doesNotMatch(p.historyText(), /ZAM-OLD-PAGE/, 'a reply for the page left is dropped');
  } finally {
    await p.close();
  }
});
