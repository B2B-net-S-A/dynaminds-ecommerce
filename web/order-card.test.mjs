/** Actual order card (web/order-card.tsx) with its real header, aside, products, section editing,
 * notes and message dialog; every other panel is a recording stub. Controlled fetch, no server/PG. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import React, { act } from 'react';
import { transformSync } from 'esbuild';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

const id = (n) => n.toString(16).padStart(8, '0') + '-1000-4000-8000-000000000001';
const baseOrder = () => ({
  id: id(1), tenant_id: id(2), version: '7', number: 'DE-1', status: 'paid', currency: 'PLN', source: 'woocommerce', external_id: 'WC-77',
  payment_mode: 'prepaid', total: 16889, shipping_cost: 1699, customer_name: 'Monika Kozłowska', email: 'monika@example.test',
  created_at: '2026-11-05T12:26:00Z', note: '', tags: [],
  address: { street: 'Wojska Polskiego 11', postal_code: '70-470', city: 'Szczecin', country: 'PL', phone: '' },
  payment: { amount_due: 0, net: 16889, received: 16889 },
  items: [{ id: id(3), product_id: id(4), sku: 'PS-1', name: 'Młynek', quantity: 2, price: 7595, line_total: 15190 }],
  picking_items: [{ id: id(5), product_id: id(4), sku: 'PS-1', name: 'Młynek', quantity: 2, scanned: 1, locations: [{ location: 'A-01-02' }] }],
  events: [], shipments: [], documents: [], returns: { has_partial: false },
});

test('order card: header by stage, sections edited one at a time, locks, history and messages', async (t) => {
  const dom = new JSDOM('<body/>', { url: 'http://127.0.0.1:4106/' }), prior = new Map(), oldFetch = globalThis.fetch;
  for (const [k, v] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement,
    Event: dom.window.Event, MouseEvent: dom.window.MouseEvent, KeyboardEvent: dom.window.KeyboardEvent, PopStateEvent: dom.window.PopStateEvent, Node: dom.window.Node,
    requestAnimationFrame: (f) => setTimeout(f, 0), IS_REACT_ACT_ENVIRONMENT: true })) {
    prior.set(k, Object.getOwnPropertyDescriptor(globalThis, k));
    Object.defineProperty(globalThis, k, { configurable: true, writable: true, value: v });
  }
  const vite = await createServer({ server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: 'custom', logLevel: 'error' });
  const api = await vite.ssrLoadModule(path.resolve('web/api.ts'));
  const { createRoot } = await import('react-dom/client');
  api.setWorkspace(id(2));
  // Compile the card as is; own pieces are real modules, other panels are stubs.
  const source = fs.readFileSync(path.resolve('web/order-card.tsx'), 'utf8');
  const own = /^(\.\/order-card-|\.\/order-detail-parts$|\.\/order-section-api$|\.\/order-stage$|\.\/api$|\.\.\/shared\/|react$|lucide-react$)/;
  const seen = {};
  const stub = (name) => /^[A-Z]/.test(name) ? (p) => { seen[name] = p; return React.createElement('div', null, p.children); }
    : name.startsWith('subscribe') ? () => () => {} : name === 'getPrintJobsMutationState' ? () => ({ locked: false }) : name.startsWith('create') ? () => ({}) : () => false;
  const modules = {};
  for (const [, spec] of source.matchAll(/from '([^']+)'/g)) {
    if (modules[spec]) continue;
    if (spec === 'react') { modules[spec] = React; continue; }
    if (own.test(spec)) {
      const file = spec.startsWith('../') ? path.resolve('web', spec + '.ts') : spec.startsWith('.') ? path.resolve('web', spec + (fs.existsSync(path.resolve('web', spec + '.tsx')) ? '.tsx' : '.ts')) : spec;
      modules[spec] = await vite.ssrLoadModule(file);
      continue;
    }
    modules[spec] = new Proxy({}, { get: (_, k) => (k === '__esModule' ? true : typeof k === 'string' ? stub(k) : undefined), has: () => true });
  }
  const jsxRuntime = await import('react/jsx-runtime');
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', transformSync(source, { loader: 'tsx', format: 'cjs', target: 'es2022', jsx: 'automatic' }).code)(
    (spec) => (spec === 'react/jsx-runtime' ? jsxRuntime : modules[spec]), mod, mod.exports);
  const { OrderDetail } = mod.exports;

  let order, requests = [], extra = () => undefined;
  globalThis.fetch = async (url, init = {}) => {
    const r = { url: String(url), method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : undefined };
    requests.push(r);
    const custom = extra(r);
    if (custom) return custom;
    if (r.method === 'GET' && r.url.endsWith('/api/orders/' + order.id)) return Response.json(order);
    if (r.url.endsWith('/sms/templates')) return Response.json({ data: [{ id: id(20), name: 'Wysłano', active: true, version: 3 }] });
    if (r.url.endsWith('/integrations')) return Response.json({ channels: [] });
    return Response.json(r.method === 'GET' ? { data: [] } : {});
  };
  const roots = new Set();
  const tick = () => act(async () => new Promise((r) => setTimeout(r, 5)));
  async function until(check, message) {
    for (let i = 0; i < 100; i++) { if (check()) return; await tick(); }
    assert.fail(message);
  }
  async function mount(props = {}) {
    const el = document.createElement('div');
    document.body.append(el);
    const root = createRoot(el);
    roots.add(root);
    const calls = { back: 0, open: [], packing: 0, notices: [] };
    const all = { splitAvailable: false, split222Available: false, admin: true, workspaceId: id(2), userId: id(6), packingContextKey: id(2) + ':' + id(6) + ':admin',
      warehousePolicyWriteBlocked: false, readOnly: false, id: order.id, refresh: 0, write: true, notify: (m, e) => calls.notices.push([m, !!e]),
      reload: () => {}, onBack: () => calls.back++, onOpenOrder: (x) => calls.open.push(x), ...props };
    await act(async () => root.render(React.createElement(OrderDetail, all)));
    const h = {
      el, calls,
      async render(patch) { Object.assign(all, patch); await act(async () => root.render(React.createElement(OrderDetail, { ...all }))); },
      text: () => el.textContent.replace(/\s+/g, ' '),
      button: (text) => { const all = [...document.querySelectorAll('button')], norm = (b) => b.textContent.replace(/\s+/g, ' ').trim(); return all.find((b) => norm(b) === text) ?? all.find((b) => norm(b).includes(text)); },
      labelled: (label) => document.querySelector(`[aria-label="${label}"]`),
      dialog: () => document.querySelector('[role="dialog"]'),
      async click(target) { const b = typeof target === 'string' ? h.button(target) : target; assert(b, 'missing ' + target); assert(!b.disabled, 'disabled ' + target); await act(async () => b.click()); },
      async type(input, value) {
        const proto = input.tagName === 'TEXTAREA' ? dom.window.HTMLTextAreaElement.prototype : input.tagName === 'SELECT' ? dom.window.HTMLSelectElement.prototype : dom.window.HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, value);
        await act(async () => input.dispatchEvent(new dom.window.Event(input.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })));
      },
      field: (formLabel, text) => [...document.querySelectorAll(`form[aria-label="${formLabel}"] label`)].find((l) => l.textContent.startsWith(text)).querySelector('input,select,textarea'),
      async close() { await act(async () => root.unmount()); roots.delete(root); el.remove(); },
    };
    await until(() => el.querySelector('.order-card-header'), 'card did not load');
    return h;
  }
  try {
    await t.test('header: breadcrumb, badges, meta and stage actions without "Edytuj zamówienie"; neighbours from listIds', { timeout: 10000 }, async () => {
      order = baseOrder();
      const h = await mount({ listIds: [id(30), order.id, id(31)] });
      assert.match(h.el.querySelector('.order-breadcrumb').textContent, /Zamówienia.*Nowe.*DE-1/);
      assert.match(h.el.querySelector('.order-card-title').textContent, /DE-1.*Nowe.*Opłacone/);
      assert.match(h.el.querySelector('.order-card-meta').textContent, /WooCommerce.*ID źródłowe WC-77.*168,89/);
      assert(h.button('Wystaw dokument'));
      assert(h.button('Przekaż do kompletacji'));
      assert.equal(h.button('Edytuj zamówienie'), undefined);
      assert(h.el.querySelector('details.order-more > summary'));
      await h.click('Poprzednie');
      await h.click('Następne');
      assert.deepEqual(h.calls.open, [id(30), id(31)]);
      await h.click(h.el.querySelector('button[title="Lista zamówień"]'));
      assert.equal(h.calls.back, 1);
      await h.close();
      order = baseOrder();
      const alone = await mount();
      assert.equal(alone.button('Poprzednie'), undefined, 'no neighbours without the list');
      await alone.close();
    });

    await t.test('picking: Kontynuuj pakowanie, scan bar and per-line scan; packed: Generuj etykietę opens the shipping tab', { timeout: 10000 }, async () => {
      order = { ...baseOrder(), status: 'picking' };
      const h = await mount({ onOpenPacking: () => h.calls.packing++ });
      await h.click('Kontynuuj pakowanie');
      assert.equal(h.calls.packing, 1);
      assert.match(h.text(), /PRODUKTY · 1 POZYCJA/);
      assert.match(h.el.querySelector('.order-scan-bar').textContent, /Zeskanowano 1 z 2.*50%/);
      assert.match(h.el.querySelector('.order-products tbody').textContent, /A-01-02.*1\/2/);
      assert(h.button('Oznacz jako spakowane').disabled, 'packing needs every scan');
      assert(h.el.querySelector('form.scan-form'));
      await h.close();
      order = { ...baseOrder(), status: 'packed' };
      const p = await mount();
      // §7: a packed order without a label offers the DEMO label, not a direct dispatch.
      assert(p.button('Generuj etykietę DEMO'));
      assert.equal(p.button('Przekaż kurierowi (DEMO)'), undefined);
      await p.click('Generuj etykietę');
      assert.equal(p.el.querySelector('#order-tab-logistics').getAttribute('aria-selected'), 'true');
      assert.equal(p.el.querySelector('#order-tabpanel-logistics').hidden, false);
      await p.close();
      order = { ...baseOrder(), status: 'packed', fulfilment_stage: 'ready_to_ship' };
      const r = await mount();
      assert(r.button('Przekaż kurierowi (DEMO)'), 'Gotowe do nadania hands the parcel to the courier');
      assert.equal(r.button('Generuj etykietę DEMO'), undefined);
      await r.close();
      // §1/§6: an unpaid prepaid order is confirmed in the Płatność section, not by a status button.
      order = { ...baseOrder(), status: 'new', payment_mode: 'prepaid' };
      const u = await mount();
      assert.equal(u.button('Oznacz jako opłacone'), undefined);
      await u.click('Potwierdź wpłatę');
      assert.match(u.text(), /Zapisz płatność/);
      await u.close();
    });

    await t.test('missing phone: warning, "Dodaj" opens the customer form; confirm lists only this section; legacy save', { timeout: 10000 }, async () => {
      order = baseOrder();
      const h = await mount();
      assert.match(h.text(), /⚠ Brak telefonu \(wymagany przez kuriera\)/);
      assert(h.button('Wyślij SMS').disabled);
      await h.click('Dodaj');
      await h.type(h.field('Edycja: Dane klienta', 'Telefon'), '600 100 200');
      await h.click('Zapisz dane klienta');
      const dialog = h.dialog();
      assert.match(dialog.textContent, /Zapisać zmiany: Dane klienta\?/);
      assert.deepEqual([...dialog.querySelectorAll('.order-change-list li')].map((li) => li.textContent), ['Telefon: — → 600 100 200']);
      assert.match(dialog.textContent, /tylko w tym systemie — nie trafi do kanału WooCommerce/);
      await h.click('Wróć');
      assert(h.labelled('Edycja: Dane klienta'), 'Wróć keeps the form');
      await h.click('Zapisz dane klienta');
      requests = [];
      await h.click([...h.dialog().querySelectorAll('button')].find((b) => b.textContent === 'Zapisz'));
      const patch = requests.find((r) => r.method === 'PATCH');
      assert(patch.url.endsWith(`/api/orders/${order.id}/customer`));
      assert.equal(patch.body.phone, '600 100 200');
      assert.equal(patch.body.expected_version, '7');
      await until(() => !h.labelled('Edycja: Dane klienta'), 'form closes after save');
      await h.close();
    });

    await t.test('one section at a time: a dirty section asks Zapisz / Porzuć zmiany; section endpoint with payment note', { timeout: 10000 }, async () => {
      order = { ...baseOrder(), section_values: {}, address: { ...baseOrder().address, phone: '600100200' } };
      const h = await mount();
      await h.click(h.labelled('Edytuj: Dane klienta'));
      await h.type(h.field('Edycja: Dane klienta', 'Firma'), 'ACME');
      await h.click(h.labelled('Edytuj: Płatność'));
      assert.match(h.dialog().textContent, /W sekcji „Dane klienta” są niezapisane zmiany/);
      await h.click('Porzuć zmiany');
      assert.equal(h.labelled('Edycja: Dane klienta'), null);
      assert(h.labelled('Edycja: Płatność'));
      await h.type(h.field('Edycja: Płatność', 'Status płatności'), 'partial');
      await h.type(h.field('Edycja: Płatność', 'Kwota wpłaty'), '50,00');
      await h.type(h.field('Edycja: Płatność', 'Nr transakcji'), 'TX-9');
      await h.click('Zapisz płatność');
      const dialog = h.dialog();
      assert.deepEqual([...dialog.querySelectorAll('.order-change-list li')].map((li) => li.textContent.replace(/\s/g, ' ')),
        ['Status płatności: Opłacone → Częściowo', 'Kwota wpłaty: 168,89 zł → 50,00 zł', 'Nr transakcji: — → TX-9']);
      assert.match(dialog.textContent, /Zapis uruchomi reguły automatyzacji/);
      requests = [];
      await h.click([...dialog.querySelectorAll('button')].find((b) => b.textContent === 'Zapisz'));
      const patch = requests.find((r) => r.method === 'PATCH');
      assert(patch.url.endsWith(`/api/orders/${order.id}/sections/payment`));
      assert.deepEqual(patch.body, { expected_version: 7, values: { state: 'partial', amount: 5000, paid_at: '', reference: 'TX-9', method: 'transfer' } });
      await h.close();
    });

    await t.test('a dirty section saved from the switch question opens the next one afterwards; 423 shows the lock reason', { timeout: 10000 }, async () => {
      order = { ...baseOrder(), section_values: {}, address: { ...baseOrder().address, phone: '600100200' } };
      const h = await mount();
      await h.click(h.labelled('Edytuj: Dane klienta'));
      await h.type(h.field('Edycja: Dane klienta', 'Firma'), 'ACME');
      await h.click(h.labelled('Edytuj: Dane do faktury'));
      await h.click([...h.dialog().querySelectorAll('button')].find((b) => b.textContent === 'Zapisz'));
      assert.match(h.dialog().textContent, /Firma: — → ACME/);
      await h.click([...h.dialog().querySelectorAll('button')].find((b) => b.textContent === 'Zapisz'));
      await until(() => h.labelled('Edycja: Dane do faktury'), 'next section opens after the save');
      await h.close();
      order = { ...baseOrder(), section_values: {} };
      extra = (r) => r.method === 'PATCH' ? Response.json({ detail: 'Sekcja zablokowana', lock: { locked: true, reason: 'Najpierw anuluj etykietę u przewoźnika', action: 'cancel_label' } }, { status: 423 }) : undefined;
      const l = await mount();
      await l.click(l.labelled('Edytuj: Adres dostawy'));
      await l.type(l.field('Edycja: Adres dostawy', 'Miejscowość'), 'Police');
      await l.click('Zapisz adres dostawy');
      await l.click([...l.dialog().querySelectorAll('button')].find((b) => b.textContent === 'Zapisz'));
      await until(() => l.calls.notices.some(([m, e]) => e && m === 'Najpierw anuluj etykietę u przewoźnika'), 'lock reason reaches the person');
      assert.equal(l.labelled('Edycja: Adres dostawy'), null, 'locked section closes its form');
      extra = () => undefined;
      await l.close();
    });

    await t.test('locked sections show a padlock with the reason; correction opens documents; read-only hides edits', { timeout: 10000 }, async () => {
      order = { ...baseOrder(), section_values: {}, section_locks: { invoice: { locked: true, reason: 'Zmiana tylko przez korektę', action: 'correction' } } };
      const h = await mount();
      assert.equal(h.labelled('Edytuj: Dane do faktury'), null);
      const card = h.el.querySelector('[aria-label="Dane do faktury"]');
      assert.match(card.querySelector('.order-section-lock').textContent, /Zmiana tylko przez korektę/);
      await h.click([...card.querySelectorAll('button')].find((b) => b.textContent === 'Wystaw korektę'));
      assert.equal(h.el.querySelector('#order-tab-documents').getAttribute('aria-selected'), 'true');
      await h.close();
      order = { ...baseOrder(), status: 'shipped', shipments: [{ id: id(9), tracking_number: 'TRK-1', carrier: 'InPost', mode: 'demo', dispatched_at: '2026-11-06T10:00:00Z' }] };
      const s = await mount();
      assert.match(s.el.querySelector('[aria-label="Adres dostawy"] .order-section-lock').textContent, /anuluj etykietę/);
      assert.match(s.text(), /Przesyłka: TRK-1/);
      await s.close();
      order = baseOrder();
      const r = await mount({ readOnly: true });
      assert.equal(r.el.querySelectorAll('.order-section-edit').length, 0);
      assert.equal(r.button('Wyślij e-mail'), undefined);
      await r.close();
    });

    await t.test('an open products edit closes when a fresh read locks the lines', { timeout: 10000 }, async () => {
      order = { ...baseOrder(), section_values: {} };
      const h = await mount();
      await h.click('✎ Edytuj');
      assert(h.button('Usuń'), 'line edit open');
      order = { ...order, version: '8', shipping_active: true };
      await h.render({ refresh: 1 });
      await until(() => h.el.querySelector('.order-products .order-section-lock'), 'fresh read shows the lock');
      assert.equal(h.button('Usuń'), undefined, 'line edit closed');
      assert.equal(h.el.querySelector('.order-products input[type="number"]'), null);
      await h.close();
    });
    await t.test('history renders section edits and filters them by section', { timeout: 10000 }, async () => {
      order = { ...baseOrder(), events: [
        { id: id(40), kind: 'order.created', detail: {}, created_at: '2026-11-05T12:26:00Z' },
        { id: id(41), kind: 'order.section_edited', created_at: '2026-11-06T09:00:00Z',
          detail: { section: 'payment', actor_name: 'Anna Nowak', changes: [{ field: 'state', label: 'Status płatności', before: 'Nieopłacone', after: 'Opłacone' }] } },
      ] };
      const h = await mount();
      const timeline = () => h.el.querySelector('.order-notes .timeline').textContent;
      assert.match(timeline(), /Edycja: Płatność · .* · Anna Nowak/);
      assert.match(timeline(), /Status płatności: Nieopłacone → Opłacone/);
      await h.type(h.labelled('Sekcja historii'), 'customer');
      assert.doesNotMatch(timeline(), /Edycja: Płatność/);
      assert.match(timeline(), /Brak zdarzeń/);
      await h.type(h.labelled('Sekcja historii'), 'payment');
      assert.match(timeline(), /Edycja: Płatność/);
      assert.doesNotMatch(timeline(), /Utworzono zamówienie/);
      await h.close();
    });

    await t.test('SMS button opens the template compose dialog: preview, then the confirmed operation', { timeout: 10000 }, async () => {
      order = { ...baseOrder(), address: { ...baseOrder().address, phone: '600100200' } };
      extra = (r) => r.url.endsWith('/operations/preview')
        ? Response.json({ allowed: true, result: [{ sms: { recipient: '48600100200', payload: 'Zamówienie DE-1 wysłane', mode: 'local' } }], actions: [{ ...r.body, template_version: 3 }], order_version: '7' })
        : undefined;
      const h = await mount();
      await h.click('Wyślij SMS');
      assert.match(h.dialog().textContent, /Wyślij SMS do klienta.*600100200/);
      await until(() => h.dialog().querySelector('select option[value="' + id(20) + '"]'), 'templates load');
      await h.type(h.dialog().querySelector('select'), id(20));
      requests = [];
      await h.click('Pokaż podgląd');
      await until(() => h.button('Zapisz symulację SMS'), 'preview shown');
      assert.match(h.dialog().textContent, /Zamówienie DE-1 wysłane/);
      await h.click('Zapisz symulację SMS');
      const sent = requests.find((r) => r.url.endsWith(`/orders/${order.id}/operations`));
      assert.equal(sent.body.confirmed, true);
      assert.equal(sent.body.type, 'sms');
      assert.equal(sent.body.order_version, '7');
      await until(() => !h.dialog(), 'dialog closes after queueing');
      extra = () => undefined;
      await h.close();
    });

    await t.test('buyer portal actions live in the KLIENT ⋯ menu', { timeout: 10000 }, async () => {
      order = { ...baseOrder(), portal_enabled: true, portal_token: 'test-only' };
      const h = await mount();
      const menu = h.labelled('Więcej akcji klienta').closest('details');
      assert(menu.querySelector('a[href="/api/public/orders/test-only"]'));
      assert([...menu.querySelectorAll('button')].some((b) => b.textContent === 'Nowy link kupującego'));
      assert([...menu.querySelectorAll('button')].some((b) => b.textContent === 'Wyłącz link kupującego'));
      await h.close();
    });
  } finally {
    for (const root of roots) await act(async () => root.unmount());
    await vite.close();
    globalThis.fetch = oldFetch;
    for (const [k, d] of prior) { if (d) Object.defineProperty(globalThis, k, d); else delete globalThis[k]; }
    dom.window.close();
  }
});
