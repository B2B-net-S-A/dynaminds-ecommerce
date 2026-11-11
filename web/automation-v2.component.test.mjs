import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { createServer } from 'vite';
import { catalog } from './automation-v2-fixture.mjs';

// Mounted v2 rules page, editor and manual buttons against a fake /api/automations/v2 (fixture catalog).
const run = (over = {}) => ({ auto: true, delay_minutes: 0, mode: 'continuous', hours: null, manual_button: false, barcode: false, ...over });
const rule = (id, name, group, scope = 'orders', extra = {}) => ({
  id, name, trigger: 'order.matches', enabled: true, priority: 0, version: 1, updated_at: '2026-11-09T08:00:00.000Z', barcode: null,
  config: { version: 2, group, scope, run: run(), conditions: { match: 'all', items: [] }, effects: [{ type: 'add_tag', params: { tag: 'X' } }], stop_further: false },
  ...extra,
});
function seed() {
  const r1 = rule('r1', 'W realizacji paczkomat', 'Wysyłka', 'orders', { version: 2, barcode: 'AR-0001' });
  r1.config.run = run({ barcode: true, manual_button: true, delay_minutes: 5 });
  r1.config.conditions = { match: 'all', items: [{ field: 'order.status', op: 'in', value: ['paid'] }, { field: 'shipping.method', op: 'in', value: ['inpost'] }] };
  r1.config.effects = [{ type: 'set_status', params: { status: 'wf:paczkomat' } }, { type: 'add_tag', params: { tag: 'Paczkomat' } }];
  return [r1, rule('r2', 'Opłacone online', 'Płatności'), rule('r4', 'Kurier DPD', 'Wysyłka'), rule('r3', 'Nowy produkt', '', 'products')];
}

async function setup(t) {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://127.0.0.1/' }), saved = new Map(), oldFetch = globalThis.fetch;
  for (const [k, v] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, Event: dom.window.Event, MouseEvent: dom.window.MouseEvent, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(k, Object.getOwnPropertyDescriptor(globalThis, k));
    Object.defineProperty(globalThis, k, { configurable: true, writable: true, value: v });
  }
  const server = { rules: seed(), calls: [], stale: false };
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url), 'http://127.0.0.1'), p = u.pathname.replace(/^\/api/, ''), method = init.method ?? 'GET', body = init.body ? JSON.parse(init.body) : undefined;
    server.calls.push({ method, path: p + u.search, body });
    const B = '/automations/v2';
    if (p === B + '/catalog') return Response.json(catalog);
    if (p === B + '/rules' && method === 'GET') return Response.json({ data: structuredClone(server.rules) });
    if (p === B + '/rules' && method === 'POST') { const r = { ...rule('n' + server.calls.length, body.name, body.config.group), ...body, version: 1 }; server.rules.push(r); return Response.json(r); }
    if (p === B + '/rules/order') { const by = new Map(server.rules.map((r) => [r.id, r])); server.rules = body.ids.map((id) => by.get(id)); return new Response(null, { status: 204 }); }
    const m = p.match(/^\/automations\/v2\/rules\/([^/]+)(?:\/(\w+))?$/);
    if (m) {
      const [, id, action] = m, i = server.rules.findIndex((r) => r.id === id), cur = server.rules[i];
      if (!action && method === 'PUT') {
        if (server.stale || body.version !== cur.version) return Response.json({ detail: 'Reguła ma nowszą wersję', code: 'STALE_VERSION' }, { status: 409 });
        const next = { ...cur, ...body, version: cur.version + 1 }; delete next.version_input; server.rules[i] = next; return Response.json(next);
      }
      if (!action && method === 'DELETE') { server.rules.splice(i, 1); return new Response(null, { status: 204 }); }
      if (action === 'copy') { const c = { ...structuredClone(cur), id: cur.id + 'c', name: cur.name + ' (kopia)', version: 1 }; server.rules.push(c); return Response.json(c); }
      if (action === 'preview') return Response.json({ matching: 3, sample: [{ id: 'o1', number: 'ZAM-101' }] });
      if (action === 'test') return Response.json({ matched: false, conditions: [{ path: '0', field: 'order.status', ok: true, actual: 'paid' }, { path: '1', field: 'shipping.method', ok: false, actual: 'dpd' }], effects: [{ type: 'set_status', would: 'status → W realizacji paczkomat' }] });
      if (action === 'versions') return Response.json({ data: [{ version: 2, actor: 'Anna', at: '2026-11-09T09:00:00.000Z', before: { ...cur, config: { ...cur.config, conditions: { match: 'all', items: [cur.config.conditions.items[0]] } } }, after: cur }] });
      if (action === 'run') return Response.json({ runs: body.order_ids.map((o, n) => ({ id: 'run' + n, rule_id: id, rule_name: cur.name, order_id: o, order_number: 'ZAM-' + o, source: 'manual', status: n ? 'failed' : 'done', reason: null, error: n ? 'Brak paczkomatu' : null, created_at: '' })) });
    }
    if (p === B + '/runs') return Response.json({ data: [{ id: 'x1', rule_id: 'r1', rule_name: 'W realizacji paczkomat', order_id: 'o1', order_number: 'ZAM-101', source: 'auto', status: 'failed', reason: null, error: 'Limit API', created_at: '2026-11-09T10:00:00.000Z' }] });
    if (p === B + '/manual') return Response.json({ data: [{ id: 'r1', name: 'W realizacji paczkomat', group: 'Wysyłka' }, { id: 'r4', name: 'Kurier DPD', group: 'Wysyłka' }] });
    if (p === '/orders') return Response.json({ data: [{ id: 'o7', number: 'ZAM-107' }, { id: 'o8', number: 'ZAM-1070' }] });
    return Response.json({ detail: 'nieznana ścieżka ' + p }, { status: 404 });
  };
  const vite = await createServer({ server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: 'custom', logLevel: 'error' });
  const React = await import('react'), { createRoot } = await import('react-dom/client');
  const page = await vite.ssrLoadModule(path.resolve('web/automation-v2.tsx'));
  const manual = await vite.ssrLoadModule(path.resolve('web/automation-manual-buttons.tsx'));
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
  const button = (text) => all('button').find((b) => b.textContent.trim() === text || b.getAttribute('aria-label') === text);
  const byLabel = (label) => el.querySelector(`[aria-label="${label}"]`);
  const click = (node) => act(() => node.click());
  const setValue = (node, value) => act(() => {
    const proto = node.tagName === 'SELECT' ? dom.window.HTMLSelectElement.prototype : node.tagName === 'TEXTAREA' ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(node, value);
    node.dispatchEvent(new dom.window.Event(node.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
  });
  const notes = [];
  const render = (node) => act(() => root.render(node));
  return { React, page, manual, el, server, until, all, button, byLabel, click, setValue, notes, render, notify: (m, e) => notes.push([m, !!e]) };
}

test('rules list: groups, scope tabs, toggle with version, reorder, copy and two-step delete', async (t) => {
  const h = await setup(t);
  await h.render(h.React.createElement(h.page.AutomationRulesV2, { admin: true, notify: h.notify }));
  await h.until(() => h.el.textContent.includes('W realizacji paczkomat'), 'list rendered');
  const groups = h.all('.av2-rule-group h3').map((x) => x.textContent);
  assert.deepEqual(groups, ['Wysyłka', 'Płatności']);
  assert.ok(!h.el.textContent.includes('Nowy produkt'), 'products rule only on the Asortyment tab');
  assert.match(h.el.textContent, /samoczynnie po 5 min, ciągle · przycisk ręczny · kod kreskowy/);
  assert.match(h.el.textContent, /Status zamówienia jest jednym z: Nowe i Metoda dostawy/);

  await h.click(h.byLabel('Reguła W realizacji paczkomat aktywna'));
  await h.until(() => h.server.calls.some((c) => c.method === 'PUT'));
  const put = h.server.calls.find((c) => c.method === 'PUT');
  assert.equal(put.path, '/automations/v2/rules/r1');
  assert.equal(put.body.enabled, false);
  assert.equal(put.body.version, 2);
  assert.equal(put.body.config.version, 2);
  await h.until(() => h.byLabel('Reguła W realizacji paczkomat aktywna').getAttribute('aria-checked') === 'false');

  await h.click(h.byLabel('Przesuń „Kurier DPD” wyżej'));
  await h.until(() => h.server.calls.some((c) => c.method === 'PATCH'));
  assert.deepEqual(h.server.calls.find((c) => c.method === 'PATCH').body, { ids: ['r4', 'r1', 'r2', 'r3'] });
  await h.until(() => h.all('.av2-rule-group')[0].querySelector('tbody tr strong').textContent === 'Kurier DPD', 'order follows server');
  assert.equal(h.notes.filter(([, e]) => e).length, 0, 'empty 204 body is not an error');

  await h.click(h.all('button').filter((b) => b.textContent === 'Zapisz jako nowy')[0]);
  await h.until(() => h.el.textContent.includes('Kurier DPD (kopia)'));

  const del = () => h.all('tr').find((tr) => tr.textContent.includes('Opłacone online')).querySelector('button.danger');
  await h.click(del());
  assert.ok(h.button('Potwierdź usunięcie'), 'delete asks first');
  assert.ok(!h.server.calls.some((c) => c.method === 'DELETE'));
  await h.click(h.button('Potwierdź usunięcie'));
  await h.until(() => !h.el.textContent.includes('Opłacone online'));
  assert.equal(h.notes.at(-1)[0], 'Usunięto regułę „Opłacone online”.');

  await h.click(h.all('[role=tab]').find((b) => b.textContent === 'Asortyment'));
  await h.until(() => h.el.textContent.includes('Nowy produkt'));
  await h.click(h.all('[role=tab]').find((b) => b.textContent === 'Dziennik uruchomień'));
  await h.until(() => h.el.textContent.includes('Limit API'));
  await h.setValue(h.el.querySelector('.av2-runs select'), 'r1');
  await h.until(() => h.server.calls.some((c) => c.path === '/automations/v2/runs?rule_id=r1'));
});

test('editor: picker, grouped status list, money, nested groups, effect reorder, validation, save body', async (t) => {
  const h = await setup(t);
  await h.render(h.React.createElement(h.page.AutomationRulesV2, { admin: true, notify: h.notify, catalog }));
  await h.until(() => h.button('Nowa reguła'));
  await h.click(h.button('Nowa reguła'));
  await h.until(() => h.el.querySelector('form.av2-editor'));
  await h.click(h.button('Zapisz'));
  assert.match(h.el.querySelector('.av2-errors').textContent, /Podaj nazwę.*Dodaj co najmniej jeden efekt/s);
  assert.ok(!h.server.calls.some((c) => c.method === 'POST'), 'invalid draft is not sent');

  await h.setValue(h.el.querySelector('.av2-basics input'), 'W realizacji paczkomat 2');
  // + Dodaj warunek → search without diacritics → pick
  await h.click(h.all('button').find((b) => b.textContent === '+ Dodaj warunek'));
  await h.setValue(h.byLabel('Dodaj warunek: szukaj'), 'status zamow');
  assert.deepEqual(h.all('.av2-picker-list [role=option]').map((b) => b.textContent), ['Status zamówienia']);
  await h.setValue(h.byLabel('Dodaj warunek: szukaj'), '');
  const ghost = h.all('.av2-picker-list [role=option]').find((b) => b.textContent.startsWith('Pole w przygotowaniu'));
  assert.equal(ghost.disabled, true, 'unsupported field disabled with hint');
  await h.click(h.all('.av2-picker-list [role=option]').find((b) => b.textContent === 'Status zamówienia'));
  assert.deepEqual(h.all('.av2-list-group').map((g) => g.textContent), ['Nowe:', 'W realizacji:', 'Zakończone:']);
  await h.click(h.byLabel('Zaznacz wszystkie: W realizacji'));
  assert.equal(h.el.querySelector('.av2-list-pop small').textContent, 'Zaznaczono: 3');
  // money condition: zł typed, grosze stored
  await h.click(h.all('button').find((b) => b.textContent === '+ Dodaj warunek'));
  await h.click(h.all('.av2-picker-list [role=option]').find((b) => b.textContent === 'Wartość zamówienia'));
  await h.setValue(h.byLabel('Wartość zamówienia: wartość'), '150,50');
  // nested group (A lub B), negated
  await h.click(h.all('button').find((b) => b.textContent === '+ Dodaj grupę warunków'));
  await h.setValue(h.byLabel('Łączenie warunków w grupie 3'), 'any');
  await h.click(h.el.querySelector('.av2-group legend input[type=checkbox]'));
  const groupPicker = h.el.querySelector('.av2-group .av2-picker button');
  await h.click(groupPicker);
  await h.click(h.all('.av2-group .av2-picker-list [role=option]').find((b) => b.textContent === 'Klient ma telefon'));
  await h.click(h.all('.av2-logic input')[0]);
  assert.match(h.el.querySelector('.av2-logic').textContent, /LUB: wystarczy jeden warunek/);
  // effects: add two, reorder with keyboard-accessible buttons
  for (const label of ['Dodaj tag', 'Zmień status']) {
    await h.click(h.all('button').find((b) => b.textContent === '+ Dodaj efekt'));
    await h.click(h.all('.av2-picker-list [role=option]').find((b) => b.textContent === label));
  }
  await h.click(h.byLabel('Przesuń efekt 2 wyżej'));
  assert.deepEqual(h.all('.av2-effects tbody tr strong').map((s) => s.textContent), ['Zmień status', 'Dodaj tag']);
  await h.click(h.button('Zapisz'));
  assert.match(h.el.querySelector('.av2-errors').textContent, /Efekt 1: Uzupełnij: Status.*Efekt 2: Uzupełnij: Tag/s);
  const rows = h.all('.av2-effects tbody tr');
  await h.setValue(rows[0].querySelector('select'), 'paid');
  await h.setValue(rows[1].querySelector('input'), 'Paczkomat');
  await h.click(h.all('.av2-section .av2-check input').find((i) => i.parentElement.textContent.startsWith('Nie sprawdzaj kolejnych')));
  await h.click(h.button('Zapisz'));
  await h.until(() => h.server.calls.some((c) => c.method === 'POST'));
  const body = h.server.calls.find((c) => c.method === 'POST').body;
  assert.equal(body.name, 'W realizacji paczkomat 2');
  assert.equal(body.trigger, 'order.matches');
  assert.equal(body.config.version, 2);
  assert.equal(body.config.stop_further, true);
  assert.deepEqual(body.config.conditions, {
    match: 'any',
    items: [
      { field: 'order.status', op: 'in', value: ['picking', 'packed', 'wf:paczkomat'] },
      { field: 'order.total', op: 'eq', value: 15050 },
      { match: 'any', negate: true, items: [{ field: 'customer.has_phone', op: 'is_true' }] },
    ],
  });
  assert.deepEqual(body.config.effects, [{ type: 'set_status', params: { status: 'paid' } }, { type: 'add_tag', params: { tag: 'Paczkomat' } }]);
  await h.until(() => h.notes.some(([m]) => m.startsWith('Zapisano regułę')));
  await h.until(() => h.el.textContent.includes('Podgląd: warunki spełnia dziś 3 zamówienia'), 'preview after first save');
});

test('editor: barcode, preview, test on order by number, version log and 409 stale version', async (t) => {
  const h = await setup(t);
  await h.render(h.React.createElement(h.page.AutomationRulesV2, { admin: true, notify: h.notify }));
  await h.until(() => h.button('Edytuj'));
  await h.click(h.button('Edytuj'));
  await h.until(() => h.el.textContent.includes('Edytujesz akcję automatyczną: W realizacji paczkomat'));
  const svg = h.el.querySelector('.av2-barcode-svg svg');
  assert.ok(svg && svg.querySelectorAll('rect').length > 20, 'Code128 rendered');
  assert.match(svg.textContent, /AR-0001/);
  assert.ok(h.button('Drukuj'));
  assert.equal(h.button('Zapisz').disabled, true, 'nothing to save until changed');
  await h.until(() => h.el.textContent.includes('Podgląd: warunki spełnia dziś 3 zamówienia.'));
  await h.click(h.button('Pokaż'));
  assert.match(h.el.querySelector('.av2-sample').textContent, /ZAM-101/);
  await h.setValue(h.byLabel('Numer zamówienia do testu'), 'zam-107');
  await h.click(h.button('Testuj na zamówieniu'));
  await h.until(() => h.el.querySelector('.av2-test'));
  assert.ok(h.server.calls.some((c) => c.path === '/automations/v2/rules/r1/test' && c.body.order_id === 'o7'), 'exact number picked among hits');
  assert.match(h.el.querySelector('.av2-test').textContent, /ZAM-107: warunki niespełnione.*✓ Status zamówienia · wartość: paid.*✗ Metoda dostawy · wartość: dpd.*status → W realizacji paczkomat/s);
  await h.until(() => h.el.textContent.includes('+ warunek: Metoda dostawy jest jednym z: InPost Paczkomat'));
  assert.match(h.el.querySelector('.av2-log').textContent, /v2 · Anna/);

  await h.setValue(h.el.querySelector('.av2-basics input'), 'Paczkomat — zmiana');
  h.server.stale = true;
  await h.click(h.button('Zapisz'));
  await h.until(() => h.el.textContent.includes('Ktoś zapisał nowszą wersję'));
  h.server.stale = false;
  await h.click(h.button('Wczytaj aktualną wersję'));
  await h.until(() => !h.el.textContent.includes('Ktoś zapisał nowszą wersję'));
  assert.equal(h.el.querySelector('.av2-basics input').value, 'W realizacji paczkomat');
});

test('ManualAutomationButtons: per-order list, run on selected orders, inline result and notify', async (t) => {
  const h = await setup(t);
  let done = 0;
  await h.render(h.React.createElement(h.manual.ManualAutomationButtons, { orderIds: ['o1'], onDone: () => done++ }));
  await h.until(() => h.button('Uruchom akcję ▾'));
  assert.ok(h.server.calls.some((c) => c.path === '/automations/v2/manual?order_id=o1'));
  await h.click(h.button('Uruchom akcję ▾'));
  await h.click(h.all('[role=menuitem]').find((b) => b.textContent === 'Kurier DPD'));
  await h.until(() => h.el.querySelector('[role=status]'));
  assert.equal(h.el.querySelector('[role=status]').textContent, '„Kurier DPD”: wykonano 1');
  assert.equal(done, 1);
  await h.render(h.React.createElement(h.manual.ManualAutomationButtons, { orderIds: ['o1', 'o2'], notify: h.notify }));
  await h.until(() => h.server.calls.some((c) => c.path === '/automations/v2/manual'), 'bulk list without order_id');
  await h.click(h.button('Uruchom akcję ▾'));
  await h.click(h.all('[role=menuitem]').find((b) => b.textContent === 'W realizacji paczkomat'));
  await h.until(() => h.notes.length === 1);
  assert.deepEqual(h.server.calls.find((c) => c.path === '/automations/v2/rules/r1/run').body, { order_ids: ['o1', 'o2'] });
  assert.deepEqual(h.notes[0], ['„W realizacji paczkomat”: wykonano 1, błąd 1 (ZAM-o2: Brak paczkomatu)', true]);
});

test('editor: status change "Ze statusu" / "Na status" lists (empty = dowolny) are saved with the rule', async (t) => {
  const h = await setup(t);
  const withStatus = { ...catalog, triggers: [...catalog.triggers, { key: 'order.status_changed', group: 'Zamówienie', label: 'Zmiana statusu zamówienia' }] };
  await h.render(h.React.createElement(h.page.AutomationRulesV2, { admin: true, notify: h.notify, catalog: withStatus }));
  await h.until(() => h.button('Nowa reguła'));
  await h.click(h.button('Nowa reguła'));
  await h.until(() => h.el.querySelector('form.av2-editor'));
  await h.setValue(h.el.querySelector('.av2-basics input'), 'Z Nowe na W kompletacji');
  assert.equal(h.el.querySelector('.av2-status-change'), null, 'only for the status change trigger');
  const trigger = h.all('select').find((s) => [...s.options].some((o) => o.value === 'order.status_changed'));
  await h.setValue(trigger, 'order.status_changed');
  await h.until(() => h.el.querySelector('.av2-status-change'));
  const summaries = () => h.all('.av2-status-change .av2-list-summary');
  const text = (b) => b.textContent.replace('▾', '').trim();
  assert.deepEqual(summaries().map(text), ['Dowolny', 'Dowolny']);
  assert.equal(h.el.querySelector('.av2-status-change .av2-list-pop'), null, 'lists start closed');
  const pick = async (index, label) => {
    await h.click(summaries()[index]);
    const option = h.all('.av2-status-change .av2-list-option').find((o) => o.textContent.trim() === label);
    await h.click(option.querySelector('input'));
    await h.click(summaries()[index]);
  };
  await pick(0, 'Nowe');
  await pick(1, 'W kompletacji');
  assert.deepEqual(summaries().map(text), ['Nowe', 'W kompletacji']);
  // One condition, so the fake version log (first condition before the change) has something to show.
  await h.click(h.all('button').find((b) => b.textContent === '+ Dodaj warunek'));
  await h.click(h.all('.av2-picker-list [role=option]').find((b) => b.textContent === 'Status zamówienia'));
  await h.click(h.byLabel('Zaznacz wszystkie: W realizacji'));
  await h.click(h.all('button').find((b) => b.textContent === '+ Dodaj efekt'));
  await h.click(h.all('.av2-picker-list [role=option]').find((b) => b.textContent === 'Dodaj tag'));
  await h.setValue(h.all('.av2-effects tbody tr')[0].querySelector('input'), 'Start');
  await h.click(h.button('Zapisz'));
  await h.until(() => h.server.calls.some((c) => c.method === 'POST'));
  const body = h.server.calls.find((c) => c.method === 'POST').body;
  assert.equal(body.trigger, 'order.status_changed');
  assert.deepEqual(body.config.status_change, { from: ['paid'], to: ['picking'] });
});
