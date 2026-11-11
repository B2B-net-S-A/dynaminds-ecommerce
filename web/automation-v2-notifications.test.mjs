import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { createServer } from 'vite';

// Topbar bell of the "Powiadom zespół" in-app notifications against a fake /api/automations/v2/notifications.
async function setup(t) {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://127.0.0.1/' }), saved = new Map(), oldFetch = globalThis.fetch;
  for (const [k, v] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, Event: dom.window.Event, MouseEvent: dom.window.MouseEvent, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(k, Object.getOwnPropertyDescriptor(globalThis, k));
    Object.defineProperty(globalThis, k, { configurable: true, writable: true, value: v });
  }
  const server = {
    calls: [],
    fail: false,
    data: [
      { id: 'n1', created_at: '2026-11-10T08:00:00.000Z', rule_name: 'Adres do sprawdzenia', order_id: 'o1', order_number: 'ZAM-101', message: 'Sprawdź adres', read: false },
      { id: 'n2', created_at: '2026-11-09T08:00:00.000Z', rule_name: 'Duże zamówienie', order_id: 'o2', order_number: 'ZAM-102', message: 'Zadzwoń do klienta', read: false },
      { id: 'n3', created_at: '2026-11-08T08:00:00.000Z', rule_name: 'Stare', order_id: null, order_number: null, message: 'Przeczytane wcześniej', read: true },
    ],
  };
  const unread = () => server.data.filter((n) => !n.read).length;
  globalThis.fetch = async (url, init = {}) => {
    const p = new URL(String(url), 'http://127.0.0.1').pathname.replace(/^\/api/, ''), method = init.method ?? 'GET';
    server.calls.push(method + ' ' + p);
    if (server.fail) return Response.json({ detail: 'Błąd' }, { status: 500 });
    if (p === '/automations/v2/notifications') return Response.json({ unread: unread(), data: structuredClone(server.data) });
    if (p === '/automations/v2/notifications/read-all') { server.data.forEach((n) => (n.read = true)); return Response.json({ ok: true, unread: 0 }); }
    const m = p.match(/^\/automations\/v2\/notifications\/(\w+)\/read$/);
    if (m) { server.data.find((n) => n.id === m[1]).read = true; return Response.json({ ok: true, unread: unread() }); }
    return Response.json({ detail: 'nieznana ścieżka ' + p }, { status: 404 });
  };
  const vite = await createServer({ server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: 'custom', logLevel: 'error' });
  const React = await import('react'), { createRoot } = await import('react-dom/client');
  const mod = await vite.ssrLoadModule(path.resolve('web/automation-v2-notifications.tsx'));
  const el = document.createElement('div');
  document.body.append(el);
  const root = createRoot(el);
  t.after(async () => {
    await React.act(async () => root.unmount());
    await vite.close();
    globalThis.fetch = oldFetch;
    for (const [k, d] of saved) d ? Object.defineProperty(globalThis, k, d) : delete globalThis[k];
  });
  const act = (fn) => React.act(async () => { await fn(); });
  const until = async (fn, note) => {
    for (let i = 0; i < 200; i++) { if (fn()) return; await act(() => new Promise((r) => setTimeout(r, 5))); }
    assert.ok(fn(), note);
  };
  const button = (text) => [...el.querySelectorAll('button')].find((b) => b.textContent.trim() === text || (b.getAttribute('aria-label') ?? '').startsWith(text));
  const click = (node) => act(() => node.click());
  const render = (node) => act(() => root.render(node));
  return { React, mod, el, server, until, button, click, render };
}

test('bell: unread count, open list, mark one, open order, mark all', async (t) => {
  const h = await setup(t);
  const opened = [];
  await h.render(h.React.createElement(h.mod.AutomationNotifications, { onOpenOrder: (id) => opened.push(id) }));
  await h.until(() => h.el.querySelector('.av2-notify-count')?.textContent === '2', 'badge shows 2 unread');
  assert.equal(h.button('Powiadomienia automatyzacji').getAttribute('aria-label'), 'Powiadomienia automatyzacji: 2 nieprzeczytane');
  await h.click(h.button('Powiadomienia automatyzacji'));
  await h.until(() => h.el.textContent.includes('Sprawdź adres'), 'list opened');
  assert.equal(h.el.querySelectorAll('li.unread').length, 2);
  assert.match(h.el.textContent, /Adres do sprawdzenia · /);

  await h.click([...h.el.querySelectorAll('li button')].find((b) => b.textContent.includes('Zadzwoń do klienta')));
  await h.until(() => h.el.querySelector('.av2-notify-count')?.textContent === '1', 'one left');
  assert.ok(h.server.calls.includes('POST /automations/v2/notifications/n2/read'));

  await h.click(h.button('Zamówienie ZAM-101'));
  assert.deepEqual(opened, ['o1']);
  await h.until(() => !h.el.querySelector('.av2-notify-count'), 'opening the order marks it read');
  await h.until(() => !h.el.querySelector('.av2-notify-panel'), 'panel closed after opening the order');

  h.server.data.push({ id: 'n4', created_at: '2026-11-10T09:00:00.000Z', rule_name: 'Nowa', order_id: null, order_number: null, message: 'Nowe', read: false });
  await h.click(h.button('Powiadomienia automatyzacji'));
  await h.until(() => h.el.querySelector('.av2-notify-count')?.textContent === '1', 'refreshed on open');
  await h.click(h.button('Oznacz wszystkie jako przeczytane'));
  await h.until(() => !h.el.querySelector('.av2-notify-count') && !h.el.querySelector('li.unread'), 'all read');
  assert.ok(h.server.calls.includes('POST /automations/v2/notifications/read-all'));
});

test('bell: load failure shows a Polish message instead of the list', async (t) => {
  const h = await setup(t);
  h.server.fail = true;
  await h.render(h.React.createElement(h.mod.AutomationNotifications, {}));
  await h.click(h.button('Powiadomienia automatyzacji'));
  await h.until(() => h.el.textContent.includes('Nie udało się wczytać powiadomień'), 'error shown');
  assert.equal(h.el.querySelector('.av2-notify-count'), null);
});

test('bell: a merge proposal opens the merge panel with the proposed orders', async (t) => {
  const h = await setup(t);
  h.server.data = [
    { id: 'm1', created_at: '2026-11-10T10:00:00.000Z', rule_name: 'Łącz klienta', order_id: 'o2', order_number: 'ZAM-102', message: 'Propozycja połączenia zamówień ZAM-101, ZAM-102', read: false, merge_order_ids: ['o1', 'o2'] },
  ];
  const merged = [];
  await h.render(h.React.createElement(h.mod.AutomationNotifications, { onOpenOrder: () => {}, onOpenMerge: (ids) => merged.push(ids) }));
  await h.click(h.button('Powiadomienia automatyzacji'));
  await h.until(() => h.el.textContent.includes('Propozycja połączenia'), 'list opened');
  await h.click(h.button('Otwórz łączenie zamówień'));
  assert.deepEqual(merged, [['o1', 'o2']]);
  await h.until(() => h.server.calls.includes('POST /automations/v2/notifications/m1/read'), 'opening marks it read');
  await h.until(() => !h.el.querySelector('.av2-notify-panel'), 'panel closed');
});

test('bell: without the merge handler a proposal has no merge button', async (t) => {
  const h = await setup(t);
  h.server.data = [{ id: 'm1', created_at: '2026-11-10T10:00:00.000Z', rule_name: 'Łącz', order_id: null, order_number: null, message: 'Propozycja', read: false, merge_order_ids: ['o1', 'o2'] }];
  await h.render(h.React.createElement(h.mod.AutomationNotifications, {}));
  await h.click(h.button('Powiadomienia automatyzacji'));
  await h.until(() => h.el.textContent.includes('Propozycja'), 'list opened');
  assert.equal(h.button('Otwórz łączenie zamówień'), undefined);
});
