import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { webcrypto } from 'node:crypto';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';
import { navigateApp } from './app-nav-helper.mjs';

// Real App → ReturnQueue →139 session/scanner →148 controller/parts editor.
// Only browser bootstrap is removed. HTTP is controlled; this is neither native
// stock/SQL acceptance nor a substitute for provider, restore or Chrome proof.
const id = n => `${String(n).padStart(8, '0')}-1621-4162-8162-162162162162`;
const tenant = id(1), user = id(2), returnId = id(3), orderId = id(4), sessionId = id(5), itemId = id(6), productId = id(7);
const scope = `${tenant}:${user}:admin:false`, hash = 'a'.repeat(64);
const station = { id: id(8), version: '1', code: 'RMA-APP', label: 'Własna kontrola App', enabled: true };
const warehouse = { id: id(12), name: 'Własny magazyn App', code: 'APP', policy: { usage: 'sale', enabled: true, version: '0' } };
const line = { item_id: itemId, product_id: productId, ordinal: 1, sku: 'SAME-APP', name: 'Historyczna pozycja App', requested: 1, original_quantity: 1, line_total: 1700, components: [{ product_id: productId, quantity: 1 }], codes: [{ code: 'SAME-APP', kind: 'historical_sku' }] };
const status = { status_id: id(10), version: '1', revision_id: id(11), active: true, name: 'Odrzucone App', color: '#2563eb', decision: 'reject', inventory_effect: 'none', warehouse_id: null, warehouse_policy_version: null, default_location: null };
const consentText = 'Sprawdziłem wszystkie części, magazyny, lokalizacje i źródłowe wydania. Potwierdzam jeden zapis przyjęcia.';
function fixture() {
  const f = { current: tenant, restore: false, capability: true, reads: [], writes: [], switches: [], unexpected: [], replies: new Map(), lease: '', lost: false, preview: null, operation: null };
  f.user = () => ({ id: f.current === tenant ? user : id(91), tenant_id: f.current, role: f.current === tenant ? 'admin' : 'viewer', name: 'Własny operator App', tenant_name: 'Własna firma App', plan: 'pro', mfa_required: false });
  f.flags = () => ({ available: true, read_only: f.restore, current_role: f.user().role, can_read: true, can_write: !f.restore && f.current === tenant });
  f.intakeFlags = () => ({ ...f.flags(), intake_available: f.capability, can_read_value: false });
  f.session = { id: sessionId, return_id: returnId, order_id: orderId, state: 'active', version: '1', station, lease_generation: 1, owner_id: user, can_control: true, can_receive_locally: true, fulfillment_origin: 'ordinary', lease_expires_at: new Date(Date.now() + 3600000).toISOString(), draft: { parts: [], note: '', shipping_refund: 0 }, scanned: [], lines: [line], photos: [], return_case: { id: returnId, number: 'RMA-APP162', version: 1, state: 'requested', warehouse_id: warehouse.id, requested_shipping: 0 }, order: { id: orderId, number: 'ORDER-APP162', version: '3', currency: 'PLN', wms_lots_enabled: false }, receipt_id: null };
  f.source = () => ({ protocol: 'destinations_v1', session: { id: sessionId, return_id: returnId, order_id: orderId, state: f.session.state, version: f.session.version, station_id: station.id, lease_generation: '1', lease_expires_at: f.session.lease_expires_at, can_control: f.session.state === 'active' && f.flags().can_write }, return_version: '1', return_case: structuredClone(f.session.return_case), order: structuredClone(f.session.order), lines: [{ ...line, ordinal: 0 }], station, scanned: structuredClone(f.session.scanned), photos: [], warehouses: [], origins: [], planner_source: { return_id: returnId, order_id: orderId, currency: 'PLN', requested_shipping_refund: 0, lines: [{ item_id: itemId, ordinal: 0, ordered_quantity: 1, requested: 1, prior_accepted: 0, scanned_quantity: f.session.scanned[0]?.quantity ?? 0, line_total_minor: 1700, components: line.components }], statuses: [status], warehouse_policies: [], catalog_assignments: [], stocks: [], wms: { enabled: false, policy_version: '0', issue_fragments: [] } } });
  f.fetch = async (url, init = {}) => {
    const u = new URL(String(url), 'http://127.0.0.1'), p = u.pathname.replace(/^\/api/, ''), method = init.method ?? 'GET';
    if (p !== '/health') assert.equal(new Headers(init.headers).get('X-Workspace-ID'), f.current, 'Actual api.ts scopes every request to the active workspace');
    // Topbar bell of the v2 automation notifications (Uwagi v3 lane M, web/automation-v2-notifications.tsx)
    // polls on mount and every minute; it is outside this scenario, so it is answered and not recorded.
    if (method === 'GET' && p === '/automations/v2/notifications') return Response.json({ unread: 0, data: [] });
    if (method === 'GET') {
      f.reads.push({ path: p + u.search, tenant: f.current });
      if (p === '/auth/me') return Response.json({ user: f.user() });
      if (p === '/health') return Response.json({ restore_preview: f.restore, return_destinations_available: f.capability, warehouse_inventory_policies_available: true });
      if (p === '/workspaces') return Response.json({ data: [{ id: tenant, name: 'Własna firma App' }, { id: id(90), name: 'Inny aktor viewer' }] });
      if (p === '/returns') {
        const state = u.searchParams.get('state'), r = f.session.return_case;
        return Response.json({ data: f.current === tenant && (!state || state === r.state) ? [{ id: returnId, order_id: orderId, number: r.number, order_number: f.session.order.number, customer_name: 'Własny klient App', submitted_by: 'operator', created_at: '2026-10-07T12:00:00Z', kind: 'return', state: r.state, currency: 'PLN', refund_amount: 0, items: [{ requested: 1, accepted: 0 }] }] : [], meta: { has_more: false, cursor: null } });
      }
      if (p === '/return-assistant/settings') return Response.json({ ...f.flags(), can_save_settings: f.flags().can_write, can_manage_queue: f.flags().can_write, settings: { version: '0', values: { auto_next: false, hide_accepted: false, name_source: 'historical', product_sort: 'historical', thumbnail_size: 'none', case_fields: ['number'], product_fields: ['sku', 'name', 'quantity', 'line_total'] } } });
      if (p === '/return-assistant/options') return Response.json({ ...f.flags(), stations: [station], limits: {} });
      if (p === `/return-assistant/sessions/${sessionId}`) return Response.json({ ...f.flags(), session: { ...structuredClone(f.session), can_control: f.session.state === 'active' && f.flags().can_write } });
      if (p === '/return-destinations/options') return Response.json({ ...f.intakeFlags(), limits: {} });
      if (p === `/return-destinations/returns/${returnId}/source`) { assert.equal(u.searchParams.get('session_id'), sessionId); assert.equal(u.searchParams.has('lease_token'), false); return Response.json({ ...f.intakeFlags(), source: f.source(), limits: {} }); }
      if (p === `/return-destinations/returns/${returnId}/history`) return Response.json({ ...f.intakeFlags(), data: f.operation ? [Object.fromEntries(['id', 'preview_id', 'session_id', 'return_id', 'order_id', 'created_at', 'action', 'scope_hash', 'summary'].map(k => [k, f.operation[k]]))] : [], next_cursor: null });
      if (p === `/return-destinations/operations/${id(21)}`) return Response.json({ ...f.intakeFlags(), operation: structuredClone(f.operation), return_case: f.session.return_case });
      if (p === '/warehouses') return Response.json({ data: [{ id: warehouse.id, name: warehouse.name, code: warehouse.code }] });
      if (p === '/warehouse-inventory-policies/options') return Response.json({ ...f.flags(), can_manage: f.flags().can_write, warehouses: [warehouse], next_cursor: null });
      if (p === '/inventory' || p === '/inventory/movements') return Response.json({ data: [], meta: { has_more: false, cursor: null } });
      if (['/dashboard', '/orders/status-counts', '/stocktakes', '/wms-lots', '/stock-file-imports/options', '/stock-locations', '/warehouse-documents'].includes(p)) return Response.json({ detail: 'Controlled unrelated workspace unavailable' }, { status: 503 });
    } else if (p === '/workspaces/switch') {
      assert.equal(method, 'POST'); const b = JSON.parse(init.body); assert.ok([tenant, id(90)].includes(b.tenant_id)); f.switches.push(b); f.current = b.tenant_id; return Response.json({ user: f.user() });
    } else {
      assert.equal(method, 'POST'); assert.equal(f.current, tenant); assert.equal(f.restore, false);
      const b = JSON.parse(init.body); f.writes.push({ path: p, method, raw: init.body, body: b, tenant: f.current });
      if (p === '/return-assistant/sessions') { assert.equal(b.return_number, 'RMA-APP162'); assert.equal(b.station_id, station.id); assert.match(b.lease_token, /^[a-f0-9-]{36}$/); f.lease = b.lease_token; return Response.json({ ...f.flags(), session: structuredClone(f.session) }, { status: 201 }); }
      if (p === `/return-assistant/sessions/${sessionId}/scans`) { assert.equal(b.lease_token, f.lease); assert.equal(b.code, line.sku); f.session.scanned = [{ item_id: itemId, quantity: 1 }]; f.session.version = '2'; return Response.json({ ...f.flags(), session: structuredClone(f.session) }); }
      let reply = f.replies.get(b.client_key);
      if (reply) reply = { ...structuredClone(reply), reused: true };
      else if (p === `/return-destinations/returns/${returnId}/previews`) {
        assert.equal(b.lease_token, f.lease); assert.equal(b.session_id, sessionId); assert.equal(b.session_version, '2'); const { lease_token, ...request } = b, source = f.source();
        const summary = { accepted: 0, restocked_to_sale: 0, received_into_custody: 0, rejected: 1, commercial_credit_minor: 0, shipping_refund_minor: 0 };
        const plan = { protocol: 'destinations_v1', order_id: orderId, return_id: returnId, currency: 'PLN', parts: b.parts.map(part => ({ ...part, status, refund_minor: 0, components: line.components })), decisions: [], arrivals: [], stock_effects: [], fragments: [], summary };
        const snapshot = { protocol: 'destinations_v1', session: source.session, return_case: source.return_case, order: source.order, lines: source.lines, station, scanned: source.scanned, photos: [], warehouses: [], origins: [], source: source.planner_source, request, plan };
        f.preview = { id: id(20), kind: 'preview', protocol: 'destinations_v1', session_id: sessionId, return_id: returnId, order_id: orderId, scope_hash: hash, created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 900000).toISOString(), action: 'reject', request, core_input: { version: 1, decision: 'reject', note: b.note }, summary, snapshot, operation_id: null, can_receive: true };
        reply = { ...f.intakeFlags(), preview: f.preview, reused: false }; f.replies.set(b.client_key, structuredClone(reply));
      } else if (p === `/return-destinations/previews/${id(20)}/receive`) {
        assert.equal(b.lease_token, f.lease); const { lease_token, ...request } = b;
        f.operation = { id: id(21), kind: 'operation', protocol: 'destinations_v1', preview_id: id(20), session_id: sessionId, return_id: returnId, order_id: orderId, scope_hash: hash, created_at: new Date().toISOString(), action: 'reject', request, snapshot: structuredClone(f.preview.snapshot), core_input: f.preview.core_input, summary: f.preview.summary, result: { id: returnId, number: 'RMA-APP162', state: 'rejected', version: 2, refund_amount: 0, refunded_shipping: 0, received_at: null } };
        f.session.state = 'completed'; f.session.can_control = false; f.session.receipt_id = f.operation.id; f.session.return_case.state = 'rejected'; f.session.return_case.version = 2;
        reply = { ...f.intakeFlags(), operation: f.operation, return_case: f.session.return_case, reused: false }; f.replies.set(b.client_key, structuredClone(reply));
      } else { f.unexpected.push({ path: p, method }); throw Error('Unexpected controlled mutation: ' + p); }
      if (f.lost) throw TypeError('Controlled lost App intake ACK'); return Response.json(reply, { status: 201 });
    }
    f.unexpected.push({ path: p, method }); throw Error(`Unexpected controlled App request: ${method} ${p}`);
  };
  return f;
}
async function tick() { await act(async () => { await new Promise(r => setTimeout(r, 0)); }); }
async function until(check, note) { for (let i = 0; i < 100; i++) { if (check()) return; await tick(); } assert.ok(check(), note); }
function button(h, name) { const e = [...h.container.querySelectorAll('button')].find(e => e.textContent.trim() === name); assert.ok(e, name); return e; }
function field(h, name) { const e = [...h.container.querySelectorAll('label')].find(e => e.firstChild?.textContent.trim() === name)?.querySelector('input,select,textarea'); assert.ok(e, name); return e; }
async function click(e) { assert.ok(e); assert.equal(e.matches(':disabled'), false); await act(async () => e.dispatchEvent(new MouseEvent('click', { bubbles: true }))); }
async function value(e, text) { assert.ok(e); const proto = e.tagName === 'SELECT' ? window.HTMLSelectElement.prototype : e.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype; await act(async () => { Object.getOwnPropertyDescriptor(proto, 'value').set.call(e, text); e.dispatchEvent(new Event(e.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); }); }
async function navigate(h, name) { await navigateApp(h.container, name, click); }
async function submit(h, name) { await act(async () => button(h, name).closest('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))); }

test('actual App destinations intake and actor interlock — controlled HTTP', async t => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://127.0.0.1/' }), saved = new Map(), oldFetch = globalThis.fetch, mounts = [];
  for (const [key, v] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, location: dom.window.location, localStorage: dom.window.localStorage, HTMLElement: dom.window.HTMLElement, MouseEvent: dom.window.MouseEvent, Event: dom.window.Event, CustomEvent: dom.window.CustomEvent, FormData: dom.window.FormData, crypto: webcrypto, IS_REACT_ACT_ENVIRONMENT: true })) { saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: v }); }
  const oldScroll = dom.window.HTMLElement.prototype.scrollIntoView; dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  const mainPath = path.resolve('web/main.tsx'); let vite;
  try {
    vite = await createServer({ server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: 'custom', logLevel: 'error', plugins: [{ name: 'actual-app-without-bootstrap', enforce: 'pre', transform(code, file) {
      if (file.split('?')[0] !== mainPath) return; const start = code.lastIndexOf("\ncreateRoot(document.getElementById('root')!)"); assert.ok(start > 0, 'Only final browser bootstrap removed'); return { code: code.slice(0, start) + '\nexport { App as AppUnderTest };\n', map: null };
    } }] });
    const { createRoot } = await import('react-dom/client'), main = await vite.ssrLoadModule(mainPath), intake = await vite.ssrLoadModule(path.resolve('web/return-destinations-intake.tsx')), assistant = await vite.ssrLoadModule(path.resolve('web/return-assistant.tsx')), api = await vite.ssrLoadModule(path.resolve('web/api.ts'));
    async function mount(f) {
      globalThis.fetch = f.fetch; api.setWorkspace(tenant); assistant.resetReturnAssistantContext('', false); intake.resetReturnDestinationsIntakeContext('');
      const container = document.createElement('div'); document.body.append(container); const root = createRoot(container), h = { container, async close() { await act(async () => root.unmount()); container.remove(); } }; mounts.push(h);
      await act(async () => root.render(React.createElement(React.StrictMode, null, React.createElement(main.AppUnderTest)))); await until(() => container.querySelector('.sidebar nav'), 'Authenticated actual App'); return h;
    }
    async function returns(h, f, all = false) {
      await navigate(h, 'Zwroty i reklamacje'); await until(() => h.container.querySelector('.return-queue-filters select'), 'Actual queue filters mounted'); if (all) await value(field(h, 'Status sprawy'), ''); await until(() => h.container.querySelector('button[aria-label="Asystent zwrotu RMA-APP162"]'), 'Actual RMA queue row');
      await click(h.container.querySelector('button[aria-label="Asystent zwrotu RMA-APP162"]')); await until(() => h.container.textContent.includes('Stanowisko kontroli') || h.container.textContent.includes('Odczytaj zapamiętaną sesję'), 'Actual assistant mounted');
    }
    async function startAndPreview(h, f) {
      await returns(h, f); await value(field(h, 'Stanowisko kontroli'), station.id); await submit(h, 'Rozpocznij kontrolę zwrotu'); await until(() => h.container.textContent.includes('Skan SKU lub EAN'), 'Session created by real parent mutation');
      await value(field(h, 'Skan SKU lub EAN'), line.sku); await submit(h, 'Skanuj jedną sztukę zwrotu'); await until(() => h.container.textContent.includes('Skontrolowano 1 szt.'), 'Durable controlled scan');
      await until(() => [...h.container.querySelectorAll('button')].some(e => e.textContent.trim() === 'Przyjęcie do wybranych magazynów' && !e.matches(':disabled')), 'Actual health capability and own session permit mode selection'); await click(button(h, 'Przyjęcie do wybranych magazynów')); await until(() => h.container.textContent.includes('Kontrola pozycji 1:'), 'Actual148 source through canonical App context');
      await value(field(h, 'Status początkowy wszystkich pozycji'), status.status_id + ':1'); await click(button(h, 'Utwórz części wszystkich pozycji')); await value(h.container.querySelector('[aria-label="Notatka przyjęcia"]'), 'Pełna kontrola App'); await click(button(h, 'Przygotuj pełny podgląd przyjęcia')); await until(() => h.container.textContent.includes('Pełny zapisany podgląd przyjęcia'), 'Frozen preview');
    }
    async function receive(h) { await click([...h.container.querySelectorAll('input[type=checkbox]')].find(e => e.parentElement.textContent === consentText)); await click(button(h, 'Zatwierdź przyjęcie do wybranych magazynów')); }
    await t.test('App health capability reaches real ReturnQueue/139/148 and actual receipt refreshes list without replacing the open review', async () => {
      const f = fixture(), h = await mount(f); try {
        await startAndPreview(h, f); assert.equal(f.writes.length, 3); assert.equal(button(h, 'Zatwierdź przyjęcie do wybranych magazynów').matches(':disabled'), true); assert.equal(intake.returnDestinationsIntakeWriteLocked(scope), false);
        const reads = f.reads.filter(r => r.path.startsWith('/returns?')).length; await receive(h); await until(() => h.container.textContent.includes('Przyjęcie zapisane') && f.reads.filter(r => r.path.startsWith('/returns?')).length > reads && f.reads.some(r => r.path === `/return-assistant/sessions/${sessionId}`), 'Root onChanged reload and completed139 readback');
        assert.equal(f.writes.length, 4); assert.equal(f.writes[2].body.protocol, 'destinations_v1'); assert.equal(f.writes[2].body.lease_token, f.writes[0].body.lease_token); assert.equal(f.session.state, 'completed'); assert.equal(h.container.querySelector('button[aria-label="Asystent zwrotu RMA-APP162"]'), null, 'Requested queue refresh reflects rejected case');
        await click(button(h, 'Odczytaj historię przyjęcia')); await until(() => h.container.textContent.includes('Otwórz pełne przyjęcie ' + f.operation.id), 'Root refresh preserves actual open receipt/history'); await click(button(h, 'Otwórz pełne przyjęcie ' + f.operation.id)); assert.equal(f.writes.length, 4, 'History never receives again'); assert.deepEqual(f.unexpected, []);
      } finally { await h.close(); }
    });
    await t.test('closed pending intake survives App navigation, blocks fresh warehouse config and allows its own exact manual retry', async () => {
      const f = fixture(), h = await mount(f); try {
        await startAndPreview(h, f); f.lost = true; await receive(h); await until(() => h.container.textContent.includes('Wynik wysłanej próby jest niepewny'), 'Retained App request'); const attempt = structuredClone(f.writes.at(-1)); assert.equal(intake.returnDestinationsIntakeWriteLocked(scope), true); assert.equal(intake.returnDestinationsIntakeWriteLocked('return-intake:' + scope), false);
        await navigate(h, 'Przegląd'); await navigate(h, 'Magazyny'); await until(() => h.container.querySelector('.warehouse-inventory-policies select') && !button(h, 'Odczytaj polityki magazynów').matches(':disabled'), 'Actual sibling policy panel'); await value(field(h, 'Magazyn polityki'), warehouse.id); assert.equal(button(h, 'Przygotuj podgląd polityki magazynu').matches(':disabled'), true, 'Main subscriber blocks a fresh sibling mutation'); assert.equal(f.writes.length, 4);
        const sourceReads = f.reads.filter(r => r.path.startsWith(`/return-destinations/returns/${returnId}/source`)).length;
        await returns(h, f, true); await until(() => !button(h, 'Odczytaj zapamiętaną sesję').matches(':disabled'), 'Explicit own session read'); await click(button(h, 'Odczytaj zapamiętaną sesję')); await until(() => h.container.textContent.includes('Ponów dokładną próbę przyjęcia') && !button(h, 'Ponów dokładną próbę przyjęcia').matches(':disabled'), 'Own retained retry excludes its own global lock'); assert.equal(f.writes.length, 4, 'Navigation and source reads never autoPOST'); assert.equal(f.reads.filter(r => r.path.startsWith(`/return-destinations/returns/${returnId}/source`)).length, sourceReads, 'Recovery pins options/grants without fresh eligibility read');
        f.lost = false; await click(button(h, 'Ponów dokładną próbę przyjęcia')); await until(() => !intake.returnDestinationsIntakeWriteLocked(scope) && h.container.textContent.includes('Przyjęcie zapisane'), 'Exact validated reply'); assert.equal(f.writes.length, 5); assert.equal(f.writes.at(-1).raw, attempt.raw); assert.equal(f.writes.at(-1).path, attempt.path); assert.deepEqual(f.unexpected, []);
      } finally { await h.close(); }
    });
    await t.test('App actor replacement purges an intake attempt while its panel is closed', async () => {
      const f = fixture(), h = await mount(f); try {
        await startAndPreview(h, f); f.lost = true; await receive(h); await until(() => intake.returnDestinationsIntakeWriteLocked(scope), 'Retained original scope'); await navigate(h, 'Przegląd');
        await value(h.container.querySelector('select[aria-label="Aktywna organizacja"]'), id(90)); await until(() => f.current === id(90) && h.container.querySelector('select[aria-label="Aktywna organizacja"]')?.value === id(90) && f.reads.some(r => r.path === '/health' && r.tenant === id(90)), 'Actual actor switch'); assert.equal(intake.returnDestinationsIntakeWriteLocked(scope), false); assert.equal(f.writes.length, 4);
        await navigate(h, 'Zwroty i reklamacje'); await until(() => h.container.textContent.includes('Brak spraw dla wybranych filtrów.'), 'Foreign actor has no original cases'); assert.ok(!h.container.textContent.includes('Ponów dokładną próbę przyjęcia')); assert.deepEqual(f.unexpected, []);
      } finally { await h.close(); }
    });
    await t.test('restored App completed session opens148 history without RAM lease, while missing capability has no intake entry', async () => {
      const f = fixture(), h = await mount(f); try {
        await startAndPreview(h, f); await receive(h); await until(() => h.container.textContent.includes('Przyjęcie zapisane'), 'Controlled operation for immutable history');
      } finally { await h.close(); }
      f.restore = true; const before = f.writes.length, restored = await mount(f); try {
        await until(() => restored.container.textContent.includes('Kopia odtworzona · tylko odczyt'), 'Actual App restore health'); await returns(restored, f, true); await value(field(restored, 'Identyfikator sesji z historii'), sessionId); await click(button(restored, 'Odczytaj znaną sesję')); await until(() => restored.container.textContent.includes('Historia przyjęcia do wybranych magazynów'), 'Completed actual session has readonly opener, no manufactured lease');
        assert.ok(![...restored.container.querySelectorAll('button')].some(e => e.textContent.trim() === 'Przyjęcie do wybranych magazynów')); await click(button(restored, 'Historia przyjęcia do wybranych magazynów')); await until(() => restored.container.textContent.includes('Odczytaj historię przyjęcia'), 'Readonly148 access'); await click(button(restored, 'Odczytaj historię przyjęcia')); await until(() => restored.container.textContent.includes('Otwórz pełne przyjęcie ' + f.operation.id), 'Immutable operation header'); await click(button(restored, 'Otwórz pełne przyjęcie ' + f.operation.id)); await until(() => restored.container.textContent.includes('Przyjęcie zapisane'), 'Full historical snapshot'); assert.equal(f.writes.length, before); assert.equal(restored.container.querySelector('[aria-label="Notatka przyjęcia"]'), null); assert.deepEqual(f.unexpected, []);
      } finally { await restored.close(); }
      f.restore = false; f.capability = false; const unavailable = await mount(f); try {
        await returns(unavailable, f, true); await value(field(unavailable, 'Identyfikator sesji z historii'), sessionId); await click(button(unavailable, 'Odczytaj znaną sesję')); await until(() => unavailable.container.textContent.includes('Zakończona'), 'Completed139 remains readable without148 capability'); assert.ok(!unavailable.container.querySelector('.return-destinations-intake')); assert.ok(!unavailable.container.textContent.includes('Historia przyjęcia do wybranych magazynów')); assert.equal(f.writes.length, before); assert.deepEqual(f.unexpected, []);
      } finally { await unavailable.close(); }
    });
  } finally {
    for (const h of mounts) if (h.container.isConnected) await h.close(); if (vite) await vite.close(); globalThis.fetch = oldFetch; dom.window.HTMLElement.prototype.scrollIntoView = oldScroll;
    for (const [key, v] of saved) { if (v) Object.defineProperty(globalThis, key, v); else delete globalThis[key]; } dom.window.close();
  }
});
