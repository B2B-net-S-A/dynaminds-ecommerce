import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { createServer } from 'vite';
import { catalog } from './automation-v2-fixture.mjs';

// Asortyment tab of automation rules v2: product rules (/api/product-rules) next to v2 product-scope rules, toggle, run log.
const definition = (name, enabled, priority, event = 'product.updated') => ({
  name, event, enabled, priority,
  conditions: [{ field: 'sku', op: 'prefix', value: 'AB' }],
  actions: [{ type: 'set_category', category: 'Nowości' }],
});
const productRule = (id, name, enabled, priority) => ({ id, version: 3, name, event: 'product.updated', enabled, approved_at: enabled ? '2026-11-09T08:00:00.000Z' : null, approved_by: 'u1', definition: definition(name, enabled, priority) });
const v2Rule = {
  id: 'v1', name: 'Nowy produkt v2', trigger: 'order.matches', enabled: true, priority: 0, version: 1, updated_at: '2026-11-09T08:00:00.000Z', barcode: null,
  config: { version: 2, group: '', scope: 'products', run: { auto: true, delay_minutes: 0, mode: 'continuous', hours: null, manual_button: false, barcode: false }, conditions: { match: 'all', items: [] }, effects: [{ type: 'add_tag', params: { tag: 'X' } }], stop_further: false },
};

async function setup(t, { readOnlyCopy = false } = {}) {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://127.0.0.1/' }), saved = new Map(), oldFetch = globalThis.fetch;
  for (const [k, v] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, Event: dom.window.Event, MouseEvent: dom.window.MouseEvent, CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(k, Object.getOwnPropertyDescriptor(globalThis, k));
    Object.defineProperty(globalThis, k, { configurable: true, writable: true, value: v });
  }
  const server = { rules: [productRule('p2', 'Kategoria Nowości', false, 20), productRule('p1', 'Atrybut sezon', true, 10)], calls: [], stale: false };
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url), 'http://127.0.0.1'), p = u.pathname.replace(/^\/api/, ''), method = init.method ?? 'GET', body = init.body ? JSON.parse(init.body) : undefined;
    server.calls.push({ method, path: p + u.search, body });
    if (p === '/automations/v2/catalog') return Response.json(catalog);
    if (p === '/automations/v2/rules') return Response.json({ data: [v2Rule] });
    if (p === '/product-rules' && server.fail) return Response.json({ detail: 'Błąd serwera' }, { status: 500 });
    if (p === '/product-rules') return Response.json({ available: true, read_only: readOnlyCopy, price_tags_available: true, data: structuredClone(server.rules), meta: { cursor: null } });
    const m = p.match(/^\/product-rules\/([^/]+)$/);
    if (m && method === 'PUT') {
      const i = server.rules.findIndex((r) => r.id === m[1]), cur = server.rules[i];
      if (server.stale || body.version !== cur.version) return Response.json({ detail: 'Reguła zmieniła się' }, { status: 409 });
      if (body.definition.enabled && !body.confirm_future_changes) return Response.json({ detail: 'Włączenie wymaga zgody' }, { status: 422 });
      server.rules[i] = { ...cur, version: cur.version + 1, enabled: body.definition.enabled, definition: body.definition };
      return Response.json(server.rules[i]);
    }
    if (p === '/product-rule-runs') return Response.json({
      data: [
        { id: 'run1', event: 'product.updated', origin: 'catalog', state: 'done', scope_hash: 'a', error: null, result: { changed: 4, skipped: 1 }, created_at: '2026-11-09T10:00:00.000Z', finished_at: null, product_count: 5 },
        { id: 'run2', event: 'product.created', origin: 'manual', state: 'failed', scope_hash: 'b', error: 'Produkt zmienił się w trakcie', result: {}, created_at: '2026-11-09T09:00:00.000Z', finished_at: null, product_count: 2 },
      ],
      meta: { cursor: null },
    });
    return Response.json({ detail: 'nieznana ścieżka ' + p }, { status: 404 });
  };
  const vite = await createServer({ server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: 'custom', logLevel: 'error' });
  const React = await import('react'), { createRoot } = await import('react-dom/client');
  const page = await vite.ssrLoadModule(path.resolve('web/automation-v2.tsx'));
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
  const all = (sel) => [...el.querySelectorAll(sel)];
  const button = (text) => all('button').find((b) => b.textContent.trim() === text);
  const byLabel = (label) => el.querySelector(`[aria-label="${label}"]`);
  const click = (node) => act(() => node.click());
  const notes = [];
  const open = async (props, ready = () => el.textContent.includes('Atrybut sezon') && el.textContent.includes('Produkt zmienił się w trakcie')) => {
    await act(() => root.render(React.createElement(page.AutomationRulesV2, { admin: true, notify: (m, e) => notes.push([m, !!e]), ...props })));
    await until(() => all('[role=tab]').length, 'tabs rendered');
    await click(all('[role=tab]').find((b) => b.textContent === 'Asortyment'));
    await until(ready, 'Asortyment tab rendered');
  };
  return { el, server, until, all, button, byLabel, click, notes, open };
}

test('Asortyment: product rules group, active labels, log, toggle off and confirmed toggle on', async (t) => {
  const h = await setup(t);
  await h.open({});
  assert.deepEqual(h.all('.av2-rule-group h3').map((x) => x.textContent), ['Reguły produktów', 'Dziennik reguł produktów', 'Bez grupy']);
  assert.equal(h.el.querySelector('.av2-subhead').textContent, 'Reguły automatyczne asortymentu');
  assert.ok(h.el.textContent.includes('Nowy produkt v2'), 'v2 product-scope rules stay in the tab');
  const rows = h.all('.av2-products .av2-rules tbody tr');
  assert.deepEqual(rows.map((r) => r.querySelector('strong').textContent), ['Atrybut sezon', 'Kategoria Nowości'], 'sorted by priority');
  assert.match(rows[0].textContent, /Po zmianie produktu · warunki: 1 · akcje: 1Aktywna/);
  assert.match(rows[1].textContent, /Wyłączona/);
  assert.equal(h.byLabel('Reguła produktów Atrybut sezon aktywna').getAttribute('aria-checked'), 'true');
  assert.equal(h.all('a').filter((a) => a.textContent === 'Edytuj w module Reguły produktów').length, 2);
  assert.equal(h.el.querySelector('a.button').getAttribute('href'), '/reguly-produktow');

  const log = h.all('.av2-product-runs tbody tr').map((r) => [...r.querySelectorAll('td')].slice(1).map((td) => td.textContent));
  assert.deepEqual(log, [
    ['Po zmianie produktu', 'po zapisie produktu', '5', 'Wykonano', 'zmienione: 4, bez zmian: 1'],
    ['Po utworzeniu produktu', 'ręcznie', '2', 'Błąd', 'Produkt zmienił się w trakcie'],
  ]);
  assert.ok(h.all('.av2-product-runs tbody tr')[1].classList.contains('av2-invalid'));

  await h.click(h.byLabel('Reguła produktów Atrybut sezon aktywna'));
  await h.until(() => h.server.calls.some((c) => c.method === 'PUT'));
  const off = h.server.calls.find((c) => c.method === 'PUT');
  assert.equal(off.path, '/product-rules/p1');
  assert.deepEqual(off.body, { version: 3, definition: definition('Atrybut sezon', false, 10), confirm_future_changes: false });
  await h.until(() => h.byLabel('Reguła produktów Atrybut sezon aktywna').getAttribute('aria-checked') === 'false');
  assert.deepEqual(h.notes.at(-1), ['Wyłączono regułę produktów „Atrybut sezon”.', false]);

  await h.click(h.byLabel('Reguła produktów Kategoria Nowości aktywna'));
  assert.equal(h.server.calls.filter((c) => c.method === 'PUT').length, 1, 'enabling asks for consent first');
  await h.click(h.button('Potwierdź włączenie'));
  await h.until(() => h.server.calls.filter((c) => c.method === 'PUT').length === 2);
  const on = h.server.calls.filter((c) => c.method === 'PUT')[1];
  assert.equal(on.path, '/product-rules/p2');
  assert.deepEqual(on.body, { version: 3, definition: definition('Kategoria Nowości', true, 20), confirm_future_changes: true });
  await h.until(() => h.byLabel('Reguła produktów Kategoria Nowości aktywna').getAttribute('aria-checked') === 'true');

  h.server.stale = true;
  await h.click(h.byLabel('Reguła produktów Kategoria Nowości aktywna'));
  await h.until(() => h.notes.at(-1)[1] === true);
  assert.equal(h.notes.at(-1)[0], 'Reguła została zmieniona przez kogoś innego. Wczytano aktualną listę.');
});

for (const [name, props, readOnlyCopy] of [['readOnly prop', { readOnly: true }, false], ['server read_only', {}, true]])
  test('Asortyment: read-only hides edit links and disables toggles (' + name + ')', async (t) => {
    const h = await setup(t, { readOnlyCopy });
    await h.open(props);
    const toggles = h.all('[aria-label^="Reguła produktów"]');
    assert.equal(toggles.length, 2);
    assert.ok(toggles.every((b) => b.disabled), 'toggles disabled');
    assert.ok(!h.el.textContent.includes('Edytuj w module Reguły produktów'), 'no edit links');
    assert.ok(h.el.textContent.includes('Otwórz moduł Reguły produktów'), 'module still reachable to view');
    await h.click(toggles[0]);
    assert.ok(!h.server.calls.some((c) => c.method === 'PUT'));
  });

test('Asortyment: load error is shown in Polish with retry', async (t) => {
  const h = await setup(t);
  h.server.fail = true;
  await h.open({}, () => h.el.querySelector('[role=alert]'));
  assert.equal(h.el.querySelector('[role=alert]').textContent, 'Nie udało się wczytać reguł produktów: Błąd serwera');
  h.server.fail = false;
  await h.click(h.button('Spróbuj ponownie'));
  await h.until(() => h.el.textContent.includes('Atrybut sezon'), 'retry loads the list');
});

test('Asortyment: non-admin does not call the admin-only product rules API', async (t) => {
  const h = await setup(t);
  await h.open({ admin: false }, () => h.el.textContent.includes('Reguły produktów widzi tylko administrator.'));
  assert.ok(!h.server.calls.some((c) => c.path.startsWith('/product-rule')), 'no admin-only calls');
});
