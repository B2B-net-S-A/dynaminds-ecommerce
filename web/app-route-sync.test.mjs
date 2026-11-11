/** Address bar <-> view state with the App's guards (Uwagi v3 §8); mocked fetch, no server.
 * Run: node node_modules/tsx/dist/cli.mjs --test web/app-route-sync.test.mjs */
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<body/>', { url: 'http://127.0.0.1:4106/' });
for (const k of ['window', 'document', 'navigator', 'location', 'history', 'CustomEvent', 'Event', 'PopStateEvent', 'HTMLElement'])
  Object.defineProperty(globalThis, k, { configurable: true, writable: true, value: dom.window[k] });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = (await import('react')).default;
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { useAppRouteSync } = await import('./app-route-sync.ts');
const { navigateTo, parseAppPath } = await import('./app-route.ts');

const ID1 = '00000001-1000-4000-8000-000000000001';
const ID2 = '00000002-1000-4000-8000-000000000002';
const orders = new Map([['DE-1', ID1], ['DE-2', ID2]]);
const calls = [];
globalThis.fetch = async (url) => {
  calls.push(url);
  const reply = (status, body) => ({ ok: status < 300, status, json: async () => body });
  const byNumber = /^\/api\/orders\/by-number\/(.+)$/.exec(url);
  if (byNumber) {
    const n = decodeURIComponent(byNumber[1]);
    return orders.has(n) ? reply(200, { id: orders.get(n), number: n }) : reply(404, { detail: `Nie znaleziono zamówienia ${n}` });
  }
  const ref = /^\/api\/orders\/([0-9a-f-]{36})\/ref$/.exec(url);
  if (ref) {
    const hit = [...orders].find(([, id]) => id === ref[1]);
    return hit ? reply(200, { id: hit[1], number: hit[0] }) : reply(404, { detail: 'Nie znaleziono zamówienia' });
  }
  return reply(404, { detail: 'nieznany adres' });
};
const flush = async () => {
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};
const url = () => location.pathname + location.search + location.hash;

async function mount(start, initialRoute) {
  history.replaceState(null, '', start);
  const h = { blocked: false, packing: [], missing: [], state: null, set: null };
  function Harness() {
    const route = parseAppPath(location.pathname);
    const [page, setPage] = React.useState(route.kind === 'page' ? route.page : route.kind === 'orders' || route.kind === 'order' ? 'orders' : 'dashboard');
    const [selected, setSelected] = React.useState(null);
    const [filter, setFilter] = React.useState(route.kind === 'orders' ? route.filter : { status: '', workflow: '' });
    h.state = { page, selected, filter };
    h.set = { setPage, setSelected, setFilter };
    const go = (p) => {
      if (h.blocked) return false;
      setPage(p); setSelected(null); setFilter({ status: '', workflow: '' });
      return true;
    };
    useAppRouteSync({
      enabled: true,
      view: { page, orderId: selected, filter },
      initialRoute,
      apply: (r) => {
        if (r.kind === 'page') return (page === r.page && !selected) || go(r.page);
        if (page === 'orders' && selected) setSelected(null);
        else if (page !== 'orders' && !go('orders')) return false;
        setFilter(r.filter);
        return true;
      },
      openOrder: (id) => { if (h.blocked) return false; setPage('orders'); setSelected(id); return true; },
      openPacking: (ref) => h.packing.push(ref),
      onMissingOrder: (m) => h.missing.push(m),
    });
    return null;
  }
  const el = document.createElement('div');
  document.body.append(el);
  const root = createRoot(el);
  await act(async () => root.render(React.createElement(Harness)));
  await flush();
  h.close = async () => { await act(async () => root.unmount()); el.remove(); };
  return h;
}
const pop = async (path) => {
  history.pushState(null, '', path);
  await act(async () => window.dispatchEvent(new PopStateEvent('popstate')));
  await flush();
};

test('first load: unknown address becomes the dashboard without a new history entry', async () => {
  const before = history.length;
  const h = await mount('/nie-ma-takiej?x=1');
  assert.equal(url(), '/');
  assert.equal(history.length, before);
  assert.equal(h.state.page, 'dashboard');
  await h.close();
});

test('first load keeps a status list with its query, and an invitation/integration override', async () => {
  let h = await mount('/zamowienia/status/nowe?q=jan');
  assert.deepEqual(h.state.filter, { status: 'paid', workflow: '' });
  assert.equal(url(), '/zamowienia/status/nowe?q=jan');
  await h.close();
  h = await mount('/?integration=connected', { kind: 'page', page: 'integrations' });
  await flush();
  assert.equal(url(), '/integracje?integration=connected', 'query kept for the integration return screen');
  await h.close();
});

test('order by number from the address opens its card; a missing number lands on the list with a message', async () => {
  let h = await mount('/zamowienia/DE-1');
  assert.equal(h.state.selected, ID1);
  assert.equal(url(), '/zamowienia/DE-1');
  await h.close();
  h = await mount('/zamowienia/DE-404');
  assert.deepEqual(h.missing, ['Nie znaleziono zamówienia DE-404']);
  assert.equal(h.state.selected, null);
  assert.equal(url(), '/zamowienia');
  await h.close();
  h = await mount('/zamowienia/' + ID2);
  assert.equal(h.state.selected, ID2);
  assert.equal(url(), '/zamowienia/DE-2', 'uuid address is replaced by the number');
  await h.close();
});

test('view changes push addresses; back/forward re-applies them; a refused step restores the address', async () => {
  const h = await mount('/');
  const start = history.length;
  await act(async () => navigateTo('/produkty'));
  await flush();
  assert.equal(h.state.page, 'products');
  assert.equal(url(), '/produkty');
  assert.equal(history.length, start + 1);
  // Opening an order from a list row (id only) gets the number from the server.
  await act(async () => { h.set.setPage('orders'); h.set.setSelected(ID2); });
  await flush();
  assert.equal(url(), '/zamowienia/DE-2');
  assert.ok(calls.includes('/api/orders/' + ID2 + '/ref'));
  // Status list through the address bar (back/forward).
  await pop('/zamowienia/status/do-realizacji');
  assert.equal(h.state.selected, null);
  assert.deepEqual(h.state.filter, { status: 'paid,picking,packed,ready_to_ship', workflow: '' });
  await pop('/cenniki');
  assert.equal(h.state.page, 'pricing');
  // A pending operation refuses: the view stays and the address goes back to it.
  h.blocked = true;
  await pop('/magazyny');
  assert.equal(h.state.page, 'pricing');
  assert.equal(url(), '/cenniki');
  await act(async () => navigateTo('/raporty'));
  await flush();
  assert.equal(h.state.page, 'pricing');
  assert.equal(url(), '/cenniki', 'refused link leaves the address');
  h.blocked = false;
  // Packing screen goes to the packer module.
  await act(async () => navigateTo('/pakowanie/DE-1'));
  assert.deepEqual(h.packing, ['DE-1']);
  // Query only on the same view: written, no view change.
  await act(async () => navigateTo('/cenniki?kanal=allegro'));
  await flush();
  assert.equal(url(), '/cenniki?kanal=allegro');
  // A new view drops the old list query.
  await act(async () => navigateTo('/zamowienia/status/nadane'));
  await flush();
  assert.equal(url(), '/zamowienia/status/nadane');
  assert.deepEqual(h.state.filter, { status: 'shipped', workflow: '' });
  await h.close();
});
