import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { webcrypto } from 'node:crypto';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

// Mounted production component + controlled HTTP, not native/SQL/intake evidence.
const id = n => `${String(n).padStart(8, '0')}-1610-4161-8161-161161161161`;
const tenant = id(1), user = id(2), scope = `${tenant}:${user}:admin:false`, sha = 'a'.repeat(64);
const flags = { available: true, read_only: false, can_read: true, can_manage: true, current_role: 'admin', intake_available: false };
const settings = name => ({ name, color: '#2563eb', active: true, decision: 'accept', inventory_effect: 'sale', warehouse_id: id(20), warehouse_policy_version: '0', default_location: 'RETURN-01' });
const status = (n, s, v = '1') => ({ id: id(n), revision_id: id(n + 100), version: v, settings: structuredClone(s), created_at: '2026-10-07T10:00:00Z', updated_at: '2026-10-07T10:00:00Z' });
function fixture() {
  const f = { flags: { ...flags }, tenant, user, writes: [], reads: [], results: new Map(), lost: false, malformed: false, statusCode: 0, heldOptions: null };
  f.statuses = [status(10, settings('Historyczny status'))];
  f.warehouses = [
    { id: id(20), name: 'Główny', code: 'MAIN', policy: { usage: 'sale', enabled: true, version: '0' } },
    { id: id(21), name: 'Kontrola', code: 'HOLD', policy: { usage: 'custody', enabled: true, version: '3' } },
    { id: id(22), name: 'Wyłączony', code: 'OFF', policy: { usage: 'custody', enabled: false, version: '4' } },
  ];
  f.options = () => ({ ...f.flags, warehouses: structuredClone(f.warehouses), limits: { page: 50, active_statuses: 100 } });
  f.fetch = async (url, init = {}) => {
    const u = new URL(String(url), 'http://127.0.0.1'), p = u.pathname.replace(/^\/api/, ''), method = init.method ?? 'GET';
    if (method === 'GET') {
      f.reads.push(p + u.search);
      if (p === '/auth/me') return Response.json({ user: { tenant_id: f.tenant, id: f.user, role: f.flags.current_role } });
      if (p === '/return-assistant/statuses/options') {
        if (f.heldOptions) return f.heldOptions;
        if (f.torn) return Response.json({ detail: 'Niespójny moduł konfiguracji' }, { status: 503 });
        return Response.json(f.options());
      }
      if (p === '/return-assistant/statuses') return Response.json({ ...f.flags, data: structuredClone(f.statuses), next_cursor: null });
      if (p.endsWith('/history')) return Response.json({ ...f.flags, data: f.operation ? [{ id: f.operation.id, preview_id: f.operation.preview_id, status_id: f.operation.status_id, kind: f.operation.kind, version: f.operation.after.version, created_at: f.operation.created_at }] : [], next_cursor: null });
      if (p.includes('/operations/')) return Response.json({ ...f.flags, operation: structuredClone(f.operation) });
      const s = f.statuses.find(s => s.id === p.split('/').at(-1));
      if (s) return Response.json({ ...f.flags, status: structuredClone(s) });
      throw Error('Unexpected GET ' + p);
    }
    assert.equal(method, 'POST'); const b = JSON.parse(init.body); f.writes.push({ path: p, raw: init.body, body: b });
    if (f.statusCode) return Response.json({ detail: 'Controlled status' }, { status: f.statusCode });
    let d = f.results.get(b.client_key);
    if (d) d = { ...structuredClone(d), reused: true };
    else if (p === '/return-assistant/statuses/previews') {
      const before = b.kind === 'update' ? structuredClone(f.statuses.find(s => s.id === b.status_id)) : null;
      f.preview = { id: id(50), kind: b.kind, status_id: before?.id ?? id(40), request: b, scope_hash: sha, before, after: { id: before?.id ?? id(40), version: before ? String(BigInt(before.version) + 1n) : '1', settings: structuredClone(b.settings) }, resources: { warehouse: f.warehouses.find(w => w.id === b.settings.warehouse_id) ?? null }, ready: true, can_commit: true, operation_id: null, created_at: '2026-10-07T10:00:00Z', expires_at: new Date(Date.now() + 900000).toISOString() };
      d = { ...f.flags, preview: structuredClone(f.preview), reused: false }; f.results.set(b.client_key, structuredClone(d));
    } else if (p === '/return-assistant/statuses/previews/' + id(50) + '/commit') {
      const { can_commit, operation_id, ...snapshot } = structuredClone(f.preview);
      const after = status(f.preview.status_id === id(40) ? 40 : 10, f.preview.after.settings, f.preview.after.version);
      f.operation = { id: id(60), preview_id: f.preview.id, status_id: after.id, kind: f.preview.kind, scope_hash: sha, request: b, before: f.preview.before, after, snapshot, created_at: '2026-10-07T10:00:00Z' };
      f.statuses = [...f.statuses.filter(s => s.id !== after.id), after];
      d = { ...f.flags, operation: structuredClone(f.operation), status: structuredClone(after), reused: false }; f.results.set(b.client_key, structuredClone(d));
    } else throw Error('Unexpected POST ' + p);
    if (f.lost) throw TypeError('Controlled lost ACK');
    if (f.malformed) { d = structuredClone(d); if (d.operation) d.operation.after.version = '99'; else delete d.preview.scope_hash; }
    return Response.json(d, { status: 201 });
  };
  return f;
}
async function tick() { await act(async () => { await new Promise(r => setTimeout(r, 0)); }); }
async function until(fn, note) { for (let i = 0; i < 100; i++) { if (fn()) return; await tick(); } assert.ok(fn(), note); }
function button(h, text) { const e = [...h.container.querySelectorAll('button')].find(e => e.textContent === text); assert.ok(e, text); return e; }
function field(h, text) { const label = [...h.container.querySelectorAll('label')].find(e => e.firstChild?.textContent === text || e.textContent.trim() === text); const e = label?.querySelector('input,select'); assert.ok(e, text); return e; }
async function click(e) { assert.equal(e.disabled, false); assert.equal(e.closest('fieldset')?.disabled ?? false, false); await act(async () => e.dispatchEvent(new MouseEvent('click', { bubbles: true }))); }
async function value(e, v) { const proto = e.tagName === 'SELECT' ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype; await act(async () => { Object.getOwnPropertyDescriptor(proto, 'value').set.call(e, v); e.dispatchEvent(new Event(e.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); }); }
test('return destination statuses mounted controlled component', async t => {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://127.0.0.1' }), saved = new Map(), oldFetch = globalThis.fetch;
  for (const [key, v] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, MouseEvent: dom.window.MouseEvent, Event: dom.window.Event, crypto: webcrypto, IS_REACT_ACT_ENVIRONMENT: true })) { saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: v }); }
  const vite = await createServer({ server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: 'custom', logLevel: 'error' });
  const { createRoot } = await import('react-dom/client'), ui = await vite.ssrLoadModule(path.resolve('web/return-destination-statuses.tsx')), api = await vite.ssrLoadModule(path.resolve('web/api.ts'));
  const mounts = [];
  function reset(f) { globalThis.fetch = f.fetch; api.setWorkspace(f.tenant); ui.resetReturnDestinationStatusesContext(''); ui.resetReturnDestinationStatusesContext(scope); }
  async function mount(props = {}, Component = ui.ReturnDestinationStatusesPanel) {
    const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
    const h = { container, props: { contextKey: scope, readOnly: false, ...props }, async render(p = {}) { h.props = { ...h.props, ...p }; await act(async () => root.render(React.createElement(Component, h.props))); }, async close() { await act(async () => root.unmount()); container.remove(); } };
    mounts.push(h); await h.render(); return h;
  }
  async function ready(h) { await until(() => h.container.textContent.includes('Nowa konfiguracja nie tworzy'), 'fresh options'); }
  async function prepare(h, target = 'sale') {
    await ready(h); await value(field(h, 'Status pozycji'), 'new'); await value(field(h, 'Nazwa statusu'), 'Kontrola nowa');
    if (target === 'reject') await value(field(h, 'Decyzja o sztukach'), 'reject');
    else { await value(field(h, 'Przeznaczenie przyjęcia'), target); const select = field(h, 'Magazyn docelowy'); assert.ok(![...select.options].some(o => o.value === id(22))); await value(select, target === 'custody' ? id(21) : id(20)); await value(field(h, 'Domyślna lokalizacja przyjęcia'), 'RETURN-02'); }
    await click(button(h, 'Przygotuj podgląd statusu zwrotu')); await until(() => h.container.textContent.includes('Pełny zapisany podgląd'), 'durable preview');
  }
  try {
    await t.test('global settings require no order, closed unknown survives reopening and exact retry, restore stays read-only', async () => {
      const f = fixture(); reset(f); const locks = []; const h = await mount({ onLockedChange: v => locks.push(v) }, ui.ReturnDestinationStatusesSettings);
      assert.equal(f.reads.length, 0); await click(button(h, 'Statusy pozycji zwrotu — ustawienia')); await prepare(h, 'reject');
      await click(field(h, 'Sprawdziłem decyzję, przeznaczenie, magazyn, politykę i lokalizację. Zatwierdzam tę rewizję ustawień.')); f.lost = true;
      await click(button(h, 'Zapisz zatwierdzony status zwrotu')); await until(() => h.container.textContent.includes('Ponów dokładną próbę ustawień'), 'unknown global write'); const attempt = f.writes[1];
      await click(button(h, 'Zamknij ustawienia statusów zwrotu')); assert.ok(ui.returnDestinationStatusesWriteLocked(scope)); assert.ok(h.container.textContent.includes('Pozostała dokładna próba')); assert.equal(locks.at(-1), true);
      f.lost = false; await h.render({ externalWriteBlocked: true }); await click(button(h, 'Statusy pozycji zwrotu — ustawienia')); await ready(h);
      await click(button(h, 'Ponów dokładną próbę ustawień zwrotu')); await until(() => h.container.textContent.includes('Konfiguracja zapisana'), 'exact retry through global entry'); assert.equal(f.writes[2].raw, attempt.raw); assert.equal(f.writes[2].path, attempt.path); assert.equal(locks.at(-1), false);
      f.flags.read_only = true; f.flags.can_manage = false; await h.render({ contextKey: `${tenant}:${user}:admin:true`, readOnly: true });
      assert.ok(!h.container.textContent.includes('Konfiguracja zapisana')); await click(button(h, 'Statusy pozycji zwrotu — ustawienia')); await ready(h);
      await click(button(h, 'Odczytaj statusy pozycji zwrotu')); await value(field(h, 'Status pozycji'), id(10)); await until(() => h.container.textContent.includes('Zapisana rewizja 1'), 'readonly global detail');
      assert.equal(button(h, 'Przygotuj podgląd statusu zwrotu').closest('fieldset').disabled, true); assert.equal(f.writes.length, 3); assert.ok(f.reads.every(p => !p.startsWith('/orders/'))); await h.close();
    });
    await t.test('compatible custody selection, full frozen review, separate consent and immutable history', async () => {
      const f = fixture(); reset(f); const h = await mount(); await prepare(h, 'custody');
      assert.equal(f.writes.length, 1); assert.equal(f.writes[0].body.settings.warehouse_id, id(21)); assert.equal(f.writes[0].body.settings.warehouse_policy_version, '3'); assert.ok(h.container.textContent.includes('Kontrola (HOLD)'));
      assert.equal(button(h, 'Zapisz zatwierdzony status zwrotu').disabled, true);
      await click(field(h, 'Sprawdziłem decyzję, przeznaczenie, magazyn, politykę i lokalizację. Zatwierdzam tę rewizję ustawień.')); await click(button(h, 'Zapisz zatwierdzony status zwrotu')); await until(() => h.container.textContent.includes('Konfiguracja zapisana'), 'one commit');
      assert.equal(f.writes.length, 2); assert.equal(f.operation.after.version, '1'); assert.equal(f.writes[1].body.confirmed, true);
      f.statuses = f.statuses.map(s => s.id === id(40) ? status(40, { ...s.settings, name: 'Późniejsza konfiguracja' }, '2') : s);
      await click(button(h, 'Odczytaj statusy pozycji zwrotu')); await value(field(h, 'Status pozycji'), id(40)); await until(() => field(h, 'Nazwa statusu').value === 'Późniejsza konfiguracja', 'current state');
      await click(button(h, 'Odczytaj historię statusu zwrotu')); await until(() => h.container.textContent.includes('Otwórz pełny zapis statusu'), 'history head'); await click(button(h, 'Otwórz pełny zapis statusu ' + id(60))); await until(() => h.container.textContent.includes('historyczna rewizja 1'), 'historical receipt');
      assert.ok(h.container.querySelector('.rds-review').textContent.includes('Kontrola nowa')); assert.equal(f.writes.length, 2); await h.close();
    });
    await t.test('sale implicit policy0 valid, change invalidates consent, reject has no destination', async () => {
      const f = fixture(); reset(f); const h = await mount(); await prepare(h);
      assert.equal(f.writes[0].body.settings.warehouse_policy_version, '0'); await click(field(h, 'Sprawdziłem decyzję, przeznaczenie, magazyn, politykę i lokalizację. Zatwierdzam tę rewizję ustawień.'));
      await value(field(h, 'Decyzja o sztukach'), 'reject'); assert.ok(!h.container.textContent.includes('Pełny zapisany podgląd')); assert.ok(!h.container.querySelector('select').disabled);
      await click(button(h, 'Przygotuj podgląd statusu zwrotu')); await until(() => f.writes.length === 2, 'reject preview'); const s = f.writes[1].body.settings; assert.equal(s.inventory_effect, 'none'); assert.equal(s.warehouse_id, null); assert.equal(s.warehouse_policy_version, null); assert.equal(s.default_location, null); await h.close();
    });
    await t.test('lost commit and malformed2xx retain exact RAM attempt through remount and GET; 429 does not clear', async () => {
      const f = fixture(); reset(f); const h = await mount(); await prepare(h); await click(field(h, 'Sprawdziłem decyzję, przeznaczenie, magazyn, politykę i lokalizację. Zatwierdzam tę rewizję ustawień.')); f.lost = true;
      await click(button(h, 'Zapisz zatwierdzony status zwrotu')); await until(() => h.container.textContent.includes('Ponów dokładną próbę ustawień'), 'unknown'); const first = f.writes[1]; await h.close(); f.lost = false;
      const next = await mount({ externalWriteBlocked: true }); await ready(next); await click(button(next, 'Odczytaj statusy pozycji zwrotu')); assert.ok(ui.returnDestinationStatusesWriteLocked(scope));
      f.statusCode = 429; await click(button(next, 'Ponów dokładną próbę ustawień zwrotu')); assert.ok(ui.returnDestinationStatusesWriteLocked(scope));
      f.statusCode = 0; f.malformed = true; await click(button(next, 'Ponów dokładną próbę ustawień zwrotu')); assert.ok(ui.returnDestinationStatusesWriteLocked(scope));
      f.malformed = false; await click(button(next, 'Ponów dokładną próbę ustawień zwrotu')); await until(() => !ui.returnDestinationStatusesWriteLocked(scope), 'validated replay');
      for (const w of f.writes.slice(2)) { assert.equal(w.raw, first.raw); assert.equal(w.path, first.path); } assert.equal(f.results.size, 2); assert.ok(next.container.textContent.includes('Konfiguracja zapisana')); await next.close();
    });
    await t.test('known stale409 removes consent/head and requires new preview; new key only after known rejection', async () => {
      const f = fixture(); reset(f); const h = await mount(); await prepare(h); await click(field(h, 'Sprawdziłem decyzję, przeznaczenie, magazyn, politykę i lokalizację. Zatwierdzam tę rewizję ustawień.')); f.statusCode = 409;
      await click(button(h, 'Zapisz zatwierdzony status zwrotu')); await until(() => !ui.returnDestinationStatusesWriteLocked(scope), 'known rejection'); assert.ok(!h.container.textContent.includes('Pełny zapisany podgląd')); assert.equal(f.operation, undefined);
      f.statusCode = 0; await click(button(h, 'Przygotuj podgląd statusu zwrotu')); await until(() => f.writes.length === 3, 'fresh preview'); assert.notEqual(f.writes[2].body.client_key, f.writes[1].body.client_key); await h.close();
    });
    await t.test('sibling lock acquired during auth/options preflight prevents POST', async () => {
      const f = fixture(); reset(f); const h = await mount(); await ready(h); await value(field(h, 'Status pozycji'), 'new'); await value(field(h, 'Nazwa statusu'), 'Odrzucenie'); await value(field(h, 'Decyzja o sztukach'), 'reject');
      let resolve; f.heldOptions = new Promise(r => { resolve = r; }); const count = f.reads.length; await click(button(h, 'Przygotuj podgląd statusu zwrotu')); await until(() => f.reads.slice(count).includes('/return-assistant/statuses/options'), 'held preflight');
      await h.render({ externalWriteBlocked: true }); f.heldOptions = null; await act(async () => { resolve(Response.json(f.options())); await Promise.resolve(); }); await until(() => !ui.returnDestinationStatusesWriteLocked(scope), 'lock released before any request'); assert.equal(f.writes.length, 0); await h.close();
    });
    await t.test('late old actor read never displays; readonly allows history but no writes; absent vs torn distinct', async () => {
      const f = fixture(); reset(f); let resolve; f.heldOptions = new Promise(r => { resolve = r; }); const h = await mount(); await until(() => f.reads.includes('/return-assistant/statuses/options'), 'old read');
      f.heldOptions = null; f.tenant = id(3); f.flags = { ...flags, current_role: 'viewer', can_manage: false, read_only: true }; api.setWorkspace(f.tenant);
      await h.render({ contextKey: `${f.tenant}:${user}:viewer:true`, readOnly: true }); await until(() => h.container.textContent.includes('Konfiguracja jest dostępna tylko do odczytu.'), 'readonly actor');
      await act(async () => { resolve(Response.json({ ...flags, warehouses: [{ ...f.warehouses[0], name: 'FOREIGN OLD ACTOR' }] })); await Promise.resolve(); }); await tick(); assert.ok(!h.container.textContent.includes('FOREIGN OLD ACTOR'));
      await click(button(h, 'Odczytaj statusy pozycji zwrotu')); await value(field(h, 'Status pozycji'), id(10)); await until(() => h.container.textContent.includes('Zapisana rewizja 1'), 'read saved status'); assert.equal(button(h, 'Przygotuj podgląd statusu zwrotu').closest('fieldset').disabled, true); assert.equal(f.writes.length, 0); await h.close();
      const absent = fixture(); absent.flags.available = false; absent.warehouses = []; reset(absent); const a = await mount(); await until(() => a.container.textContent.includes('nie jest dostępna w tej kopii'), 'neutral absent'); assert.equal(absent.writes.length, 0); await a.close();
      const torn = fixture(); torn.torn = true; reset(torn); const b = await mount(); await until(() => b.container.textContent.includes('Niespójny moduł'), 'torn503'); assert.ok(!b.container.textContent.includes('nie jest dostępna w tej kopii')); assert.equal(torn.writes.length, 0); await b.close();
    });
  } finally {
    for (const h of mounts) if (h.container.isConnected) await h.close(); await vite.close(); dom.window.close(); globalThis.fetch = oldFetch;
    for (const [key, d] of saved) if (d) Object.defineProperty(globalThis, key, d); else delete globalThis[key];
  }
});
