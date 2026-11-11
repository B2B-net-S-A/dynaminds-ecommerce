import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { webcrypto } from 'node:crypto';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

// Actual intake + actual parts widget, controlled HTTP DTO fixtures. No SQL, native,
// stock writes or scan simulation: inspected quantities are supplied durable139 facts.
const id = n => `${String(n).padStart(8, '0')}-1620-4162-8162-162162162162`;
const tenant = id(1), user = id(2), returnId = id(3), orderId = id(4), sessionId = id(5), leaseToken = id(6), sha = 'a'.repeat(64);
const contextKey = `${tenant}:${user}:admin:false`;
const flags = { available: true, read_only: false, current_role: 'admin', can_read: true, can_write: true, intake_available: true, can_read_value: false };
const status = (n, effect) => ({ status_id: id(n), version: '1', revision_id: id(n + 100), active: true, name: effect === 'sale' ? 'Do sprzedaży' : effect === 'custody' ? 'Do kontroli fizycznej' : 'Odrzucone', color: '#2563eb', decision: effect === 'none' ? 'reject' : 'accept', inventory_effect: effect, warehouse_id: effect === 'none' ? null : id(effect === 'sale' ? 20 : 21), warehouse_policy_version: effect === 'none' ? null : effect === 'sale' ? '0' : '1', default_location: effect === 'none' ? null : effect === 'sale' ? 'RETURN-01' : 'CHECK-01' });
const statuses = [status(10, 'sale'), status(11, 'custody'), status(12, 'none')];
function source(wms = true) {
  const physical = [
    { item_id: id(30), ordinal: 0, ordered_quantity: 2, requested: 2, prior_accepted: 0, scanned_quantity: 2, line_total_minor: 2000, components: [{ product_id: id(40), quantity: 1 }] },
    { item_id: id(31), ordinal: 1, ordered_quantity: 1, requested: 1, prior_accepted: 0, scanned_quantity: 1, line_total_minor: 1700, components: [{ product_id: id(40), quantity: 1 }] },
    { item_id: id(32), ordinal: 2, ordered_quantity: 1, requested: 1, prior_accepted: 0, scanned_quantity: 1, line_total_minor: 6000, components: [{ product_id: id(40), quantity: 1 }, { product_id: id(41), quantity: 2 }] },
  ];
  return { protocol: 'destinations_v1', session: { id: sessionId, return_id: returnId, order_id: orderId, state: 'active', version: '4', station_id: id(7), lease_generation: 1, lease_expires_at: new Date(Date.now() + 3600000).toISOString(), can_control: true }, return_version: '1', return_case: { id: returnId, number: 'RMA162', parcel_origins: physical.map((l, i) => ({ origin_id: id(70 + i), dispatch_id: id(80), item_id: l.item_id, requested: l.requested })) }, order: { id: orderId, number: 'ORDER162', currency: 'PLN' }, lines: physical.map(l => ({ item_id: l.item_id, product_id: l.item_id === id(32) ? id(42) : id(40), ordinal: l.ordinal, sku: l.item_id === id(32) ? 'BUNDLE' : 'SAME-A', name: l.item_id === id(32) ? 'Zestaw historyczny' : 'Historyczny produkt A', components: l.components })), station: { id: id(7), label: 'Kontrola 162' }, scanned: physical.map(l => ({ item_id: l.item_id, quantity: l.scanned_quantity })), photos: [{ id: id(8), item_id: id(30) }], warehouses: [{ id: id(20), name: 'Sprzedaż', code: 'MAIN' }, { id: id(21), name: 'Kontrola', code: 'HOLD' }], planner_source: { order_id: orderId, return_id: returnId, currency: 'PLN', requested_shipping_refund: 0, lines: physical, statuses: structuredClone(statuses), warehouse_policies: [{ warehouse_id: id(20), usage: 'sale', enabled: true, version: '0' }, { warehouse_id: id(21), usage: 'custody', enabled: true, version: '1' }], catalog_assignments: [40, 41].map(n => ({ product_id: id(n), warehouse_ids: [id(20), id(21)] })), stocks: [20, 21].flatMap(w => [40, 41].map(p => ({ warehouse_id: id(w), product_id: id(p), exists: true, version: '0', on_hand: 0, reserved: 0 }))), wms: { enabled: wms, policy_version: '1', issue_fragments: wms ? [{ id: id(60), product_id: id(40), layer_id: id(90), order_id: orderId, eligible_item_ids: physical.map(l => l.item_id), quantity: 4, returned_quantity: 0, available: 4, currency: 'PLN' }, { id: id(61), product_id: id(41), layer_id: id(91), order_id: orderId, eligible_item_ids: [id(32)], quantity: 2, returned_quantity: 0, available: 2, currency: 'PLN' }] : [] } } };
}
function fixture(wms = true) {
  const f = { source: source(wms), flags: { ...flags }, reads: [], writes: [], replies: new Map(), lost: false, malformed: false, statusCode: 0, held: null, actorTenant: tenant, actorUser: user };
  f.source.session.lease_generation = '1';
  f.source.planner_source.wms.policy_version = wms ? '1' : '0';
  // Actual148 origin DTO is separate from return_case; physical caps remain the
  // original139/138 issued mapping, never reconstructed by the controller.
  f.source.origins = f.source.planner_source.lines.map((l, i) => ({ origin_id: id(70 + i), dispatch_id: id(80), item_id: l.item_id, parcel_index: 0, shipment_id: id(81), quantity: l.requested, fragments: wms ? l.components.map(c => ({ fragment_id: id(c.product_id === id(40) ? 60 : 61), product_id: c.product_id, quantity: c.quantity * l.requested, available: c.quantity * l.requested })) : [] }));
  delete f.source.return_case.parcel_origins;
  f.fetch = async (url, init = {}) => {
    const p = new URL(String(url), 'http://127.0.0.1').pathname.replace(/^\/api/, ''), method = init.method ?? 'GET';
    if (method === 'GET') {
      f.reads.push(p);
      if (p === '/auth/me') return Response.json({ user: { tenant_id: f.actorTenant, id: f.actorUser, role: f.flags.current_role } });
      if (p === '/return-destinations/options') return Response.json({ ...f.flags, limits: {} });
      if (p === `/return-destinations/returns/${returnId}/source`) return f.held ?? Response.json({ ...f.flags, source: structuredClone(f.source), limits: {} });
      if (p === `/return-destinations/returns/${returnId}/history`) return Response.json({ ...f.flags, data: f.operation ? [{ id: f.operation.id, preview_id: f.operation.preview_id, session_id: sessionId, return_id: returnId, order_id: orderId, created_at: f.operation.created_at, action: f.operation.action, scope_hash: sha, summary: f.operation.summary }] : [], next_cursor: null });
      if (p === `/return-destinations/operations/${id(101)}`) return Response.json({ ...f.flags, operation: f.operation });
      throw Error('Unexpected controlled GET ' + p);
    }
    assert.equal(method, 'POST'); const b = JSON.parse(init.body); f.writes.push({ path: p, raw: init.body, body: b });
    if (f.statusCode) return Response.json({ detail: 'Controlled rejection' }, { status: f.statusCode });
    let reply = f.replies.get(b.client_key);
    if (reply) reply = { ...structuredClone(reply), reused: true };
    else if (p === `/return-destinations/returns/${returnId}/previews`) {
      // Fixture response assembly only. It is not a replacement for server planner tests.
      const parts = b.parts.map(p => { const l = f.source.planner_source.lines.find(l => l.item_id === p.item_id), s = statuses.find(s => s.status_id === p.status_id); return { part_id: p.part_id, item_id: p.item_id, quantity: p.quantity, status: s, refund_minor: s.decision === 'reject' ? 0 : l.line_total_minor / l.ordered_quantity * p.quantity, components: l.components }; });
      const arrivals = parts.flatMap(p => p.status.decision === 'reject' ? [] : p.components.map(c => ({ part_id: p.part_id, item_id: p.item_id, product_id: c.product_id, warehouse_id: p.status.warehouse_id, location: b.locations.find(l => l.part_id === p.part_id && l.product_id === c.product_id).location, quantity: c.quantity * p.quantity, effect: p.status.inventory_effect })));
      const cells = new Map(); for (const a of arrivals) { const key = a.warehouse_id + ':' + a.product_id, old = cells.get(key); cells.set(key, { warehouse_id: a.warehouse_id, product_id: a.product_id, quantity: (old?.quantity ?? 0) + a.quantity, effect: a.effect }); }
      const stock_effects = [...cells.values()].map(c => ({ ...c, before: { exists: true, version: '0', on_hand: 0, reserved: 0, physical_available: 0, sellable_available: 0 }, after: { on_hand: c.quantity, reserved: 0, physical_available: c.quantity, sellable_available: c.effect === 'sale' ? c.quantity : 0 } }));
      const summary = { accepted: parts.filter(p => p.status.decision === 'accept').reduce((n, p) => n + p.quantity, 0), restocked_to_sale: parts.filter(p => p.status.inventory_effect === 'sale').reduce((n, p) => n + p.quantity, 0), received_into_custody: parts.filter(p => p.status.inventory_effect === 'custody').reduce((n, p) => n + p.quantity, 0), rejected: parts.filter(p => p.status.decision === 'reject').reduce((n, p) => n + p.quantity, 0), commercial_credit_minor: parts.reduce((n, p) => n + p.refund_minor, 0), shipping_refund_minor: b.shipping_refund };
      const fragments = (b.wms_lots?.picks ?? []).map(p => { const f = fSourceFragment(p.issue_fragment_id), a = arrivals.find(a => a.part_id === p.part_id && a.product_id === f.product_id); return { ...a, issue_fragment_id: f.id, layer_id: f.layer_id, quantity: p.quantity, currency: 'PLN' }; });
      const { lease_token, ...request } = b;
      const { protocol, planner_source, return_version, ...frame } = structuredClone(f.source);
      planner_source.stocks = planner_source.stocks.filter(s => b.stock_versions.some(v => v.warehouse_id === s.warehouse_id && v.product_id === s.product_id));
      const plan = { protocol, order_id: orderId, return_id: returnId, currency: 'PLN', parts, decisions: [], arrivals, stock_effects, fragments, summary };
      const snapshot = { ...frame, protocol, request, source: planner_source, plan };
      f.preview = { id: id(100), kind: 'preview', protocol, session_id: sessionId, return_id: returnId, order_id: orderId, scope_hash: sha, created_at: '2026-10-07T12:00:00Z', expires_at: new Date(Date.now() + 900000).toISOString(), action: summary.accepted ? 'receive' : 'reject', request, core_input: { version: 1, action: summary.accepted ? 'receive' : 'reject' }, summary, snapshot, operation_id: null, can_receive: true };
      reply = { ...f.flags, preview: f.preview, reused: false }; f.replies.set(b.client_key, structuredClone(reply));
    } else if (p === `/return-destinations/previews/${id(100)}/receive`) {
      const { lease_token, ...request } = b;
      f.operation = { id: id(101), kind: 'operation', protocol: 'destinations_v1', preview_id: id(100), session_id: sessionId, return_id: returnId, order_id: orderId, scope_hash: sha, created_at: '2026-10-07T12:01:00Z', action: f.preview.action, request, snapshot: f.preview.snapshot, core_input: f.preview.core_input, summary: f.preview.summary, result: { id: returnId, number: 'RMA162', state: f.preview.action === 'reject' ? 'rejected' : 'refund_pending', version: 2, refund_amount: f.preview.summary.commercial_credit_minor, refunded_shipping: f.preview.summary.shipping_refund_minor, received_at: f.preview.action === 'reject' ? null : '2026-10-07T12:01:00Z' } };
      reply = { ...f.flags, operation: f.operation, return_case: { ...f.source.return_case }, reused: false }; f.replies.set(b.client_key, structuredClone(reply));
    } else throw Error('Unexpected controlled POST ' + p);
    // Hold only the HTTP acknowledgement after its immutable fixture reply has
    // been recorded. Reads and the mounted controller remain real and responsive.
    if (f.ackHold) await f.ackHold;
    if (f.lost) throw TypeError('Controlled lost ACK');
    if (f.malformed) { reply = structuredClone(reply); delete reply.operation; }
    if (f.badResult && reply.operation) { reply = structuredClone(reply); Object.assign(reply.operation.result, f.badResult); }
    return Response.json(reply, { status: 201 });
    function fSourceFragment(id) { return f.source.planner_source.wms.issue_fragments.find(x => x.id === id); }
  };
  return f;
}
async function tick() { await act(async () => { await new Promise(r => setTimeout(r, 0)); }); }
async function until(fn, note) { for (let i = 0; i < 100; i++) { if (fn()) return; await tick(); } assert.ok(fn(), note); }
function button(h, text) { const e = [...h.container.querySelectorAll('button')].find(e => e.textContent.trim() === text); assert.ok(e, text); return e; }
function label(h, text) { const e = [...h.container.querySelectorAll('label')].find(e => e.firstChild?.textContent === text || e.textContent.trim() === text)?.querySelector('input,select,textarea'); assert.ok(e, text); return e; }
async function click(e) { assert.equal(e.matches(':disabled'), false); await act(async () => e.dispatchEvent(new MouseEvent('click', { bubbles: true }))); }
async function value(e, text) { assert.ok(e); const proto = e.tagName === 'SELECT' ? window.HTMLSelectElement.prototype : e.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype; await act(async () => { Object.getOwnPropertyDescriptor(proto, 'value').set.call(e, text); e.dispatchEvent(new Event(e.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); }); }

test('return destinations intake actual mounted controller — controlled HTTP', async t => {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://127.0.0.1' }), saved = new Map(), oldFetch = globalThis.fetch;
  for (const [k, v] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, MouseEvent: dom.window.MouseEvent, Event: dom.window.Event, crypto: webcrypto, IS_REACT_ACT_ENVIRONMENT: true })) { saved.set(k, Object.getOwnPropertyDescriptor(globalThis, k)); Object.defineProperty(globalThis, k, { configurable: true, writable: true, value: v }); }
  const vite = await createServer({ server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: 'custom', logLevel: 'error' }), mounts = [];
  const { createRoot } = await import('react-dom/client'), ui = await vite.ssrLoadModule(path.resolve('web/return-destinations-intake.tsx')), api = await vite.ssrLoadModule(path.resolve('web/api.ts'));
  function reset(f) { globalThis.fetch = f.fetch; api.setWorkspace(f.actorTenant); ui.resetReturnDestinationsIntakeContext(''); ui.resetReturnDestinationsIntakeContext(contextKey); }
  async function mount(props = {}) {
    const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
    const h = { container, props: { contextKey, readOnly: false, write: true, returnId, orderId, sessionId, leaseToken, ...props }, async render(p = {}) { h.props = { ...h.props, ...p }; await act(async () => root.render(React.createElement(ui.ReturnDestinationsIntakePanel, h.props))); }, async close() { await act(async () => root.unmount()); container.remove(); } }; mounts.push(h); await h.render(); return h;
  }
  async function ready(h) { await until(() => h.container.textContent.includes('Kontrola pozycji 3'), 'Actual139 source'); }
  async function initialize(h, status = 10) { await ready(h); await value(label(h, 'Status początkowy wszystkich pozycji'), id(status) + ':1'); await click(button(h, 'Utwórz części wszystkich pozycji')); await value(h.container.querySelector('[aria-label="Notatka przyjęcia"]'), 'Kontrola oryginalnych sztuk'); }
  async function confirmLocations(h) { for (const e of [...h.container.querySelectorAll('input[aria-label^="Potwierdzam lokalizację składnika"]')]) await click(e); }
  const consentText = 'Sprawdziłem wszystkie części, magazyny, lokalizacje i źródłowe wydania. Potwierdzam jeden zapis przyjęcia.';
  try {
    await t.test('sameSKU prices + whole bundle, split sale/custody, shared fragment caps and full stock union before separate consent', async () => {
      const f = fixture(); reset(f); const h = await mount(); await initialize(h);
      assert.ok(h.container.textContent.includes('20,00')); assert.ok(h.container.textContent.includes('17,00')); assert.ok(h.container.textContent.includes(id(30))); assert.ok(h.container.textContent.includes(id(31)));
      await click(button(h, 'Podziel pozycję 1, część 1')); await value(h.container.querySelector('[aria-label="Status pozycji 1 części 2"]'), id(11) + ':1'); await value(h.container.querySelector('[aria-label="Status pozycji 3 części 1"]'), id(11) + ':1'); await confirmLocations(h);
      const fields = [...h.container.querySelectorAll('input[aria-label^="Fragment "]')]; assert.equal(fields.length, 5); for (const e of fields) await value(e, e.getAttribute('aria-label').includes(id(61)) ? '2' : '1');
      await value(fields[0], '2'); assert.ok(h.container.textContent.includes('przekroczono wspólną pozostałą ilość wydania')); assert.equal(button(h, 'Przygotuj pełny podgląd przyjęcia').matches(':disabled'), true); assert.equal(f.writes.length, 0);
      await value(fields[0], '1'); await click(button(h, 'Przygotuj pełny podgląd przyjęcia')); await until(() => h.container.textContent.includes('Pełny zapisany podgląd przyjęcia'), 'Frozen fullpreview'); const body = f.writes[0].body;
      assert.equal(body.protocol, 'destinations_v1'); assert.equal(body.session_version, '4'); assert.equal(body.lease_token, leaseToken); assert.equal(body.parts.length, 4); assert.equal(body.stock_versions.length, 3); assert.equal(body.locations.length, 5); assert.equal(body.wms_lots.picks.length, 5); assert.ok(h.container.textContent.includes('Kontrola (HOLD)')); assert.ok(h.container.textContent.includes('Do sprzedaży przed → po'));
      assert.ok(h.container.textContent.includes('Pochodzenie wydania: paczka 1')); assert.ok(h.container.textContent.includes(id(70))); assert.ok(h.container.textContent.includes('Fragment pochodzenia ' + id(60))); assert.equal(f.preview.snapshot.return_case.parcel_origins, undefined);
      assert.equal(button(h, 'Zatwierdź przyjęcie do wybranych magazynów').matches(':disabled'), true); await click(label(h, consentText)); await click(button(h, 'Zatwierdź przyjęcie do wybranych magazynów')); await until(() => h.container.textContent.includes('Przyjęcie zapisane'), 'Validated receipt'); assert.equal(f.writes.length, 2); assert.equal(f.operation.summary.restocked_to_sale, 2); assert.equal(f.operation.summary.received_into_custody, 2); assert.equal(f.operation.snapshot.plan.stock_effects.find(c => c.warehouse_id === id(21) && c.product_id === id(41)).after.sellable_available, 0);
      await h.close();
    });
    await t.test('held ACK shows a write in progress; only lost ACK exposes unknown and identical manual retry', async () => {
      const f = fixture(false); reset(f); const h = await mount(); await initialize(h, 12);
      const retryVisible = () => [...h.container.querySelectorAll('button')].some(e => e.textContent.trim() === 'Ponów dokładną próbę przyjęcia');
      let releaseAck; f.ackHold = new Promise(resolve => { releaseAck = resolve; });
      await click(button(h, 'Przygotuj pełny podgląd przyjęcia'));
      await until(() => f.writes.length === 1 && h.container.textContent.includes('Trwa zapis przyjęcia.'), 'Held preview ACK is in flight');
      assert.ok(!h.container.textContent.includes('Wynik wysłanej próby jest niepewny')); assert.equal(retryVisible(), false);
      assert.ok(ui.returnDestinationsIntakeWriteLocked(contextKey)); assert.equal(button(h, 'Przygotuj pełny podgląd przyjęcia').matches(':disabled'), true);
      await act(async () => { releaseAck(); await Promise.resolve(); }); f.ackHold = null;
      await until(() => h.container.textContent.includes('Pełny zapisany podgląd przyjęcia') && !ui.returnDestinationsIntakeWriteLocked(contextKey), 'Valid ACK publishes the preview');
      assert.ok(!h.container.textContent.includes('Trwa zapis przyjęcia.')); assert.equal(retryVisible(), false);
      await click(label(h, consentText)); let loseAck; f.ackHold = new Promise((_resolve, reject) => { loseAck = reject; });
      await click(button(h, 'Zatwierdź przyjęcie do wybranych magazynów'));
      await until(() => f.writes.length === 2 && h.container.textContent.includes('Trwa zapis przyjęcia.'), 'Held receive ACK is in flight');
      const original = f.writes[1]; assert.ok(!h.container.textContent.includes('Wynik wysłanej próby jest niepewny')); assert.equal(retryVisible(), false); assert.ok(!h.container.textContent.includes('Przyjęcie zapisane'));
      await act(async () => { loseAck(TypeError('Controlled lost ACK')); await Promise.resolve(); }); f.ackHold = null;
      await until(() => h.container.textContent.includes('Wynik wysłanej próby jest niepewny') && retryVisible() && !button(h, 'Ponów dokładną próbę przyjęcia').matches(':disabled'), 'Lost ACK enables exact manual retry');
      assert.ok(!h.container.textContent.includes('Trwa zapis przyjęcia.')); assert.ok(!h.container.textContent.includes('Przyjęcie zapisane')); assert.ok(ui.returnDestinationsIntakeWriteLocked(contextKey)); assert.equal(f.writes.length, 2);
      await click(button(h, 'Ponów dokładną próbę przyjęcia')); await until(() => h.container.textContent.includes('Przyjęcie zapisane') && !ui.returnDestinationsIntakeWriteLocked(contextKey), 'Exact validated replay publishes receipt');
      assert.equal(f.writes.length, 3); assert.equal(f.writes[2].raw, original.raw); assert.equal(f.writes[2].path, original.path); assert.equal(f.writes[2].body.client_key, original.body.client_key); await h.close();
    });
    await t.test('all-reject needs neither locations nor WMS picks; malformed/429/lost ACK survive history and remount exact retry', async () => {
      const f = fixture(); reset(f); const h = await mount(); await initialize(h, 12); assert.equal(h.container.querySelectorAll('input[aria-label^="Potwierdzam lokalizację"]').length, 0); await click(button(h, 'Przygotuj pełny podgląd przyjęcia')); await until(() => h.container.textContent.includes('Pełny zapisany podgląd przyjęcia'), 'Allrejectpreview');
      assert.deepEqual(f.writes[0].body.locations, []); assert.deepEqual(f.writes[0].body.stock_versions, []); assert.equal(f.writes[0].body.wms_lots, undefined); await click(label(h, consentText)); f.lost = true; await click(button(h, 'Zatwierdź przyjęcie do wybranych magazynów')); await until(() => h.container.textContent.includes('Ponów dokładną próbę przyjęcia'), 'Unknown'); const original = f.writes[1]; await h.close();
      f.lost = false; const sourceReads = f.reads.filter(p => p.endsWith('/source')).length, beforeRemount = f.reads.length;
      const next = await mount({ externalWriteBlocked: true }); await until(() => next.container.textContent.includes('Wynik wysłanej próby jest niepewny') && !button(next, 'Ponów dokładną próbę przyjęcia').matches(':disabled'), 'Retained recovery has current options and enabled exact retry');
      assert.ok(f.reads.slice(beforeRemount).includes('/return-destinations/options')); assert.equal(f.reads.filter(p => p.endsWith('/source')).length, sourceReads, 'Remount recovery never reads current source eligibility'); assert.equal(next.container.querySelector('[aria-label="Notatka przyjęcia"]'), null, 'Recovery without source cannot start a fresh draft');
      await click(button(next, 'Odczytaj historię przyjęcia')); assert.ok(ui.returnDestinationsIntakeWriteLocked(contextKey));
      f.statusCode = 429; await click(button(next, 'Ponów dokładną próbę przyjęcia')); assert.ok(ui.returnDestinationsIntakeWriteLocked(contextKey)); f.statusCode = 0; f.malformed = true; await click(button(next, 'Ponów dokładną próbę przyjęcia')); assert.ok(ui.returnDestinationsIntakeWriteLocked(contextKey));
      f.malformed = false; await click(button(next, 'Ponów dokładną próbę przyjęcia')); await until(() => !ui.returnDestinationsIntakeWriteLocked(contextKey), 'Exact validated receipt'); for (const w of f.writes.slice(2)) { assert.equal(w.raw, original.raw); assert.equal(w.path, original.path); } assert.ok(next.container.textContent.includes('Przyjęcie zapisane')); await next.close();
    });
    await t.test('OFF durable scan ceiling and confirmed locations; changing status invalidates preview and consent', async () => {
      const f = fixture(false); f.source.planner_source.lines[0].scanned_quantity = 1; reset(f); const h = await mount(); await initialize(h); await confirmLocations(h); assert.ok(h.container.textContent.includes('przekracza trwałą kontrolę 1 sztuk')); assert.equal(f.writes.length, 0);
      await click(button(h, 'Podziel pozycję 1, część 1')); await value(h.container.querySelector('[aria-label="Status pozycji 1 części 2"]'), id(12) + ':1'); await confirmLocations(h); await click(button(h, 'Przygotuj pełny podgląd przyjęcia')); await until(() => h.container.textContent.includes('Pełny zapisany podgląd przyjęcia'), 'OFFpreview'); assert.equal(f.writes[0].body.wms_lots, undefined);
      await click(label(h, consentText)); await value(h.container.querySelector('[aria-label="Status pozycji 2 części 1"]'), id(11) + ':1'); assert.ok(!h.container.textContent.includes('Pełny zapisany podgląd przyjęcia')); assert.equal(f.writes.length, 1); await h.close();
    });
    await t.test('known409 removes stale consent and requires a fresh source and new explicit preview', async () => {
      const f = fixture(false); reset(f); const h = await mount(); await initialize(h, 12); await click(button(h, 'Przygotuj pełny podgląd przyjęcia')); await until(() => h.container.textContent.includes('Pełny zapisany podgląd przyjęcia'), 'Preview before conflict'); await click(label(h, consentText)); f.statusCode = 409;
      await click(button(h, 'Zatwierdź przyjęcie do wybranych magazynów')); await until(() => h.container.textContent.includes('Próba została jednoznacznie odrzucona'), 'Known rejection'); assert.equal(ui.returnDestinationsIntakeWriteLocked(contextKey), false); assert.ok(!h.container.textContent.includes('Pełny zapisany podgląd przyjęcia')); assert.equal(button(h, 'Przygotuj pełny podgląd przyjęcia').matches(':disabled'), true); assert.equal(f.operation, undefined);
      f.statusCode = 0; await click(button(h, 'Odczytaj źródło przyjęcia')); await until(() => !button(h, 'Przygotuj pełny podgląd przyjęcia').matches(':disabled'), 'Fresh source'); assert.equal(f.writes.length, 2, 'GET never retries business mutation'); await click(button(h, 'Przygotuj pełny podgląd przyjęcia')); await until(() => f.writes.length === 3 && h.container.textContent.includes('Pełny zapisany podgląd przyjęcia'), 'New explicit preview'); assert.notEqual(f.writes[2].body.client_key, f.writes[0].body.client_key); assert.equal(button(h, 'Zatwierdź przyjęcie do wybranych magazynów').matches(':disabled'), true); await h.close();
    });
    await t.test('contradictory actual receipt state, credit or RMA identity retains exact consent until valid manual replay', async () => {
      const f = fixture(false); reset(f); const h = await mount(); await initialize(h); await confirmLocations(h); await click(button(h, 'Przygotuj pełny podgląd przyjęcia')); await until(() => h.container.textContent.includes('Pełny zapisany podgląd przyjęcia'), 'Validated preview'); await click(label(h, consentText)); f.badResult = { refund_amount: 0 };
      await click(button(h, 'Zatwierdź przyjęcie do wybranych magazynów')); await until(() => h.container.textContent.includes('Rzeczywisty wynik RMA nie odpowiada'), 'Contradictory receipt rejected'); const attempt = f.writes[1]; assert.ok(ui.returnDestinationsIntakeWriteLocked(contextKey)); assert.ok(!h.container.textContent.includes('Przyjęcie zapisane'));
      for (const bad of [{ state: 'requested' }, { id: id(999) }, { version: 1 }, { refunded_shipping: 1 }]) { f.badResult = bad; await click(button(h, 'Ponów dokładną próbę przyjęcia')); await until(() => !button(h, 'Ponów dokładną próbę przyjęcia').matches(':disabled'), 'Manual replay finished'); assert.ok(ui.returnDestinationsIntakeWriteLocked(contextKey)); assert.ok(!h.container.textContent.includes('Przyjęcie zapisane')); }
      f.badResult = null; await click(button(h, 'Ponów dokładną próbę przyjęcia')); await until(() => !ui.returnDestinationsIntakeWriteLocked(contextKey), 'Valid actual receipt releases attempt'); assert.ok(h.container.textContent.includes('Przyjęcie zapisane')); for (const w of f.writes.slice(2)) { assert.equal(w.raw, attempt.raw); assert.equal(w.path, attempt.path); } await h.close();
    });
    await t.test('late old actor ignored, read-only inspection makes no POST, absent capability truthful, sibling change before POST', async () => {
      const f = fixture(false); reset(f); let resolve; f.held = new Promise(r => { resolve = r; }); const h = await mount(); await until(() => f.reads.includes(`/return-destinations/returns/${returnId}/source`), 'Heldsource');
      f.actorTenant = id(200); f.flags.read_only = true; f.flags.can_write = false; f.held = null; api.setWorkspace(f.actorTenant); await h.render({ contextKey: `${id(200)}:${user}:admin:true`, readOnly: true }); await ready(h);
      await act(async () => { const old = source(false); old.return_case.number = 'FOREIGN OLD RMA'; resolve(Response.json({ ...flags, source: old, limits: {} })); await Promise.resolve(); }); await tick(); assert.ok(!h.container.textContent.includes('FOREIGN OLD RMA')); assert.equal(h.container.querySelector('.return-destination-parts fieldset').disabled, true); assert.equal(f.writes.length, 0); await h.close();
      const absent = fixture(); absent.flags.intake_available = false; absent.source = null; reset(absent); const a = await mount(); await until(() => a.container.textContent.includes('nie jest dostępne w tej kopii'), 'Unavailable'); assert.equal(absent.writes.length, 0); await a.close();
      const foreign = fixture(); reset(foreign); const b = await mount(); await initialize(b, 12); let finish; foreign.held = new Promise(r => { finish = r; }); const count = foreign.reads.length; await click(button(b, 'Przygotuj pełny podgląd przyjęcia')); await until(() => foreign.reads.slice(count).includes(`/return-destinations/returns/${returnId}/source`), 'Heldpreflight'); await b.render({ externalWriteBlocked: true }); foreign.held = null; await act(async () => { finish(Response.json({ ...flags, source: foreign.source, limits: {} })); await Promise.resolve(); }); await until(() => !ui.returnDestinationsIntakeWriteLocked(contextKey), 'No write on foreign lock'); assert.equal(foreign.writes.length, 0); await b.close();
    });
  } finally { for (const h of mounts) if (h.container.isConnected) await h.close(); await vite.close(); dom.window.close(); globalThis.fetch = oldFetch; for (const [k, d] of saved) if (d) Object.defineProperty(globalThis, k, d); else delete globalThis[k]; }
});
