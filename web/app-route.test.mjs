/** Address scheme of the office app (Uwagi v3 §8). Run: node node_modules/tsx/dist/cli.mjs --test web/app-route.test.mjs */
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<body/>', { url: 'http://127.0.0.1:4106/' });
for (const k of ['window', 'location', 'history', 'CustomEvent', 'Event'])
  Object.defineProperty(globalThis, k, { configurable: true, writable: true, value: dom.window[k] });
const r = await import('./app-route.ts');
const { fulfilmentSlugs, legacyOrderStatusGroups, orderStatusGroups } = await import('./order-stage.ts');

test('every page has a unique Polish address that parses back to the page', () => {
  const slugs = Object.values(r.PAGE_SLUGS);
  assert.equal(new Set(slugs).size, slugs.length);
  for (const page of Object.keys(r.PAGE_SLUGS)) {
    const route = r.parseAppPath(r.pagePath(page));
    if (page === 'orders') assert.deepEqual(route, { kind: 'orders', filter: { status: '', workflow: '' } });
    else assert.deepEqual(route, { kind: 'page', page });
  }
  assert.deepEqual(r.parseAppPath('/'), { kind: 'page', page: 'dashboard' });
  assert.deepEqual(r.parseAppPath('/przeglad'), { kind: 'page', page: 'dashboard' });
  assert.equal(r.pagePath('dashboard'), '/');
  assert.equal(r.pagePath('products'), '/produkty');
  // /b2b/<uuid> is the B2B portal, so the office page must not live under /b2b.
  assert.ok(!slugs.some((s) => s === 'b2b'));
});

test('status addresses: stage, group and custom status, both directions', () => {
  for (const [stage, slug] of Object.entries(fulfilmentSlugs)) {
    const filter = { status: stage, workflow: '' };
    assert.equal(r.orderStatusPath(filter), '/zamowienia/status/' + slug);
    assert.deepEqual(r.parseAppPath('/zamowienia/status/' + slug), { kind: 'orders', filter });
  }
  assert.deepEqual(orderStatusGroups.map((g) => g.slug), ['kategoria-nowe', 'w-realizacji', 'zrealizowane', 'niezrealizowane', 'pozostale']);
  const stageSlugs = new Set(Object.values(fulfilmentSlugs));
  for (const g of [...orderStatusGroups, ...legacyOrderStatusGroups]) assert.ok(!stageSlugs.has(g.slug), g.slug + ' is not a stage slug');
  for (const g of orderStatusGroups) {
    const filter = { status: g.stages.join(','), workflow: '' };
    // A one-stage category (Niezrealizowane = Anulowane) is addressed by the stage; the category slug stays an alias.
    const slug = g.stages.length === 1 ? fulfilmentSlugs[g.stages[0]] : g.slug;
    assert.equal(r.orderStatusPath(filter), '/zamowienia/status/' + slug);
    assert.deepEqual(r.parseAppPath(r.orderStatusPath(filter)), { kind: 'orders', filter });
    assert.deepEqual(r.parseAppPath('/zamowienia/status/' + g.slug), { kind: 'orders', filter });
  }
  assert.deepEqual(r.parseAppPath('/zamowienia/status/kategoria-nowe'), { kind: 'orders', filter: { status: 'paid,new', workflow: '' } });
  assert.deepEqual(r.parseAppPath('/zamowienia/status/nowe'), { kind: 'orders', filter: { status: 'paid', workflow: '' } }, 'nowe stays the stage');
  // Old links (groups before the categories) still open the same orders.
  const legacy = {
    'do-realizacji': 'paid,picking,packed,ready_to_ship',
    wysylka: 'shipped,delivered,completed',
    'zwroty-i-anulowane': 'return_initiated,return_received,return_completed,cancelled',
    platnosci: 'new',
  };
  for (const [slug, status] of Object.entries(legacy))
    assert.deepEqual(r.parseAppPath('/zamowienia/status/' + slug), { kind: 'orders', filter: { status, workflow: '' } }, slug);
  assert.equal(r.orderStatusPath({ status: legacy['do-realizacji'], workflow: '' }), '/zamowienia/status/do-realizacji');
  assert.equal(r.orderStatusPath({ status: legacy.wysylka, workflow: '' }), '/zamowienia/status/zrealizowane', 'the category names the same stages');
  const id = '0000000a-1000-4000-8000-000000000001';
  assert.equal(r.orderStatusPath({ status: '', workflow: id }), '/zamowienia/status/wlasny/' + id);
  assert.deepEqual(r.parseAppPath('/zamowienia/status/wlasny/' + id.toUpperCase()), { kind: 'orders', filter: { status: '', workflow: id } });
  assert.equal(r.orderStatusPath({ status: '', workflow: '' }), '/zamowienia');
  // A comma list that is no group has no address: the list of all orders.
  assert.equal(r.orderStatusPath({ status: 'paid,shipped', workflow: '' }), '/zamowienia');
  assert.deepEqual(r.parseAppPath('/zamowienia/status/nie-ma'), { kind: 'unknown' });
  assert.deepEqual(r.parseAppPath('/zamowienia/status/wlasny/zly-id'), { kind: 'unknown' });
  assert.deepEqual(r.parseAppPath('/zamowienia/status'), { kind: 'unknown' });
});

test('order card and packing screen by order number', () => {
  assert.equal(r.orderPath('DE-20261030-91827EB8'), '/zamowienia/DE-20261030-91827EB8');
  assert.deepEqual(r.parseAppPath('/zamowienia/DE-20261030-91827EB8'), { kind: 'order', ref: 'DE-20261030-91827EB8' });
  assert.equal(r.orderPath('A/1 B'), '/zamowienia/A%2F1%20B');
  assert.deepEqual(r.parseAppPath(r.orderPath('A/1 B')), { kind: 'order', ref: 'A/1 B' });
  assert.deepEqual(r.parseAppPath('/zamowienia/%E0%A4%A'), { kind: 'unknown' }, 'broken escape is not an order');
  assert.deepEqual(r.parseAppPath('/zamowienia/a/b'), { kind: 'unknown' });
  assert.equal(r.packingPath('DE-1'), '/pakowanie/DE-1');
  assert.equal(r.packingPath(), '/pakowanie');
  assert.deepEqual(r.parseAppPath('/pakowanie/DE-1'), { kind: 'packing', ref: 'DE-1' });
  assert.deepEqual(r.parseAppPath('/pakowanie'), { kind: 'packing', ref: null });
  assert.deepEqual(r.parseAppPath('/wms'), { kind: 'packing', ref: null });
});

test('unknown addresses are reported as unknown', () => {
  for (const p of ['/nie-ma-takiej', '/produkty/x', '/b2b', '/zamowieniax'])
    assert.deepEqual(r.parseAppPath(p), { kind: 'unknown' }, p);
  assert.ok(r.samePath('/', '/przeglad'));
  assert.ok(r.samePath('/produkty/', '/produkty'));
  assert.ok(!r.samePath('/produkty', '/cenniki'));
});

test('query string API for list filters and navigation requests', () => {
  history.replaceState(null, '', '/zamowienia/status/nowe#x');
  let routeEvents = 0;
  window.addEventListener(r.ROUTE_EVENT, () => routeEvents++);
  const before = history.length;
  r.setRouteQuery({ q: 'kowalski', page: '', channel: null, sort: 'date' });
  assert.equal(location.pathname + location.search + location.hash, '/zamowienia/status/nowe?q=kowalski&sort=date#x');
  assert.equal(history.length, before, 'replace by default');
  r.setRouteQuery(new URLSearchParams('q=nowak'), { replace: false });
  assert.equal(location.search, '?q=nowak');
  assert.equal(history.length, before + 1);
  assert.equal(r.getRouteQuery().get('q'), 'nowak');
  r.setRouteQuery({});
  assert.equal(location.search, '');
  assert.equal(routeEvents, 3);
  const seen = [];
  window.addEventListener(r.NAVIGATE_EVENT, (e) => seen.push(e.detail));
  r.navigateTo(r.orderPath('DE-1'));
  r.navigateTo('/produkty?q=a', { replace: true });
  assert.deepEqual(seen, [{ path: '/zamowienia/DE-1', replace: undefined }, { path: '/produkty?q=a', replace: true }]);
  assert.equal(location.pathname, '/zamowienia/status/nowe', 'navigateTo itself does not touch history; the App does');
});
