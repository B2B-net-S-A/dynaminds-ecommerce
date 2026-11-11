import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { webcrypto } from 'node:crypto';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

// Actual production ReactDOM panel with controlled HTTP, not native dispatch proof.
const id = n => `${String(n).padStart(8, '0')}-1670-4167-8167-167167167167`;
const tenant = id(1), user = id(2), scope = `${tenant}:${user}:admin:false`, sha = 'a'.repeat(64);
const flags = { available: true, configuration_available: true, issuer_available: false, current_role: 'admin', can_read: true, can_manage: true, read_only: false };
const consent = 'Sprawdziłem magazyn, serię i moment wystawienia. Zatwierdzam tę konfigurację WZ.';
const prepareLabel = 'Przygotuj podgląd konfiguracji WZ', commitLabel = 'Zapisz zatwierdzoną konfigurację WZ', retryLabel = 'Ponów dokładną próbę konfiguracji WZ';
function fixture() {
  const f = { tenant, user, flags: { ...flags }, reads: [], writes: [], results: new Map(), lost: false, malformed: false, statusCode: 0, heldOptions: null, heldAck: null, previews: [], operations: [] };
  f.warehouses = [{ id: id(20), name: 'Magazyn wysyłkowy', code: 'SALE', configuration: { warehouse_id: id(20), version: '0', series_id: null, settings: null } }];
  f.options = (rows = f.warehouses, cursor = null) => ({ ...f.flags, warehouses: structuredClone(rows), next_cursor: cursor, limits: { warehouses: 200, page: 50, preview_ttl_seconds: 900 } });
  f.fetch = async (url, init = {}) => {
    const u = new URL(String(url), 'http://127.0.0.1'), p = u.pathname.replace(/^\/api/, ''), method = init.method ?? 'GET';
    if (method === 'GET') {
      f.reads.push(p + u.search);
      if (p === '/auth/me') return Response.json({ user: { tenant_id: f.tenant, id: f.user, role: f.flags.current_role } });
      if (p === '/warehouse-automatic-wz/options') {
        if (f.heldOptions) return f.heldOptions;
        if (f.torn) return Response.json({ detail: 'Niepełna instalacja konfiguracji WZ' }, { status: 503 });
        if (f.pageOptions) return Response.json(f.pageOptions(u.searchParams.get('cursor')));
        return Response.json(f.options());
      }
      if (p === '/warehouse-automatic-wz/history') {
        const kind = u.searchParams.get('kind'), rows = kind === 'preview' ? f.previews : f.operations;
        return Response.json({ ...f.flags, kind, data: structuredClone(rows.filter(v => !u.searchParams.get('warehouse_id') || v.warehouse_id === u.searchParams.get('warehouse_id'))), next_cursor: null });
      }
      if (p.startsWith('/warehouse-automatic-wz/previews/')) {
        const preview = f.previews.find(v => p.endsWith(v.id)); assert.ok(preview); return Response.json({ ...f.flags, preview: structuredClone(preview) });
      }
      if (p.startsWith('/warehouse-automatic-wz/operations/')) {
        const operation = f.operations.find(v => p.endsWith(v.id)); assert.ok(operation); return Response.json({ ...f.flags, operation: structuredClone(operation) });
      }
      throw Error('Unexpected controlled GET ' + p);
    }
    assert.equal(method, 'POST'); const b = JSON.parse(init.body); f.writes.push({ path: p, body: b, raw: init.body });
    if (f.statusCode) return Response.json({ detail: 'Controlled status ' + f.statusCode }, { status: f.statusCode });
    let d = f.results.get(b.client_key);
    if (d) d = { ...structuredClone(d), ...f.flags, reused: true };
    else if (p === '/warehouse-automatic-wz/warehouses/' + id(20) + '/previews') {
      const w = f.warehouses[0], before = structuredClone(w.configuration), after = { warehouse_id: w.id, version: String(BigInt(b.expected_version) + 1n), series_id: before.series_id ?? id(40), settings: structuredClone(b.settings) };
      const preview = { id: id(50 + f.previews.length), warehouse_id: w.id, client_key: b.client_key, request: structuredClone(b), scope_hash: sha, snapshot: { warehouse: { id: w.id, name: w.name, code: w.code }, before, after }, ready: true, can_commit: true, operation_id: null, created_at: '2026-10-07T12:00:00Z', expires_at: new Date(Date.now() + 900000).toISOString() };
      f.previews.push(preview); d = { ...f.flags, preview: structuredClone(preview), reused: false }; f.results.set(b.client_key, structuredClone(d));
    } else if (p.startsWith('/warehouse-automatic-wz/previews/') && p.endsWith('/commit')) {
      const preview = f.previews.find(v => p.includes(v.id)); assert.ok(preview); assert.equal(b.scope_hash, preview.scope_hash);
      const operation = { id: id(60 + f.operations.length), warehouse_id: preview.warehouse_id, preview_id: preview.id, client_key: b.client_key, request: structuredClone(b), scope_hash: preview.scope_hash, snapshot: structuredClone(preview.snapshot), before: structuredClone(preview.snapshot.before), after: structuredClone(preview.snapshot.after), revision_id: id(70 + f.operations.length), created_at: '2026-10-07T12:00:01Z' };
      f.operations.push(operation); f.warehouses[0].configuration = structuredClone(operation.after); preview.operation_id = operation.id; preview.can_commit = false;
      d = { ...f.flags, operation: structuredClone(operation), reused: false }; f.results.set(b.client_key, structuredClone(d));
    } else throw Error('Unexpected controlled POST ' + p);
    if (f.lost) throw TypeError('Controlled lost ACK');
    if (f.malformed) { d = structuredClone(d); if (d.operation) { d.operation.after.version = '99'; d.operation.snapshot.after.version = '99'; } else d.preview.request.settings.prefix = 'OTHER'; }
    if (f.heldAck) return f.heldAck;
    return Response.json(d, { status: 201 });
  };
  return f;
}
async function tick() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); }
async function until(fn, message) { for (let i = 0; i < 100; i++) { if (fn()) return; await tick(); } assert.ok(fn(), message); }
function button(h, text) { const e = [...h.container.querySelectorAll('button')].find(e => e.textContent === text); assert.ok(e, text); return e; }
function field(h, text) { const e = [...h.container.querySelectorAll('label')].find(e => e.firstChild?.textContent === text || e.textContent.trim() === text)?.querySelector('input,select'); assert.ok(e, text); return e; }
async function click(e) { assert.equal(e.disabled, false); assert.equal(e.closest('fieldset')?.disabled ?? false, false); await act(async () => e.dispatchEvent(new MouseEvent('click', { bubbles: true }))); }
async function value(e, v) { const proto = e.tagName === 'SELECT' ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype; await act(async () => { Object.getOwnPropertyDescriptor(proto, 'value').set.call(e, v); e.dispatchEvent(new Event(e.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); }); }
test('automatic WZ configuration mounted controlled ReactDOM', async t => {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://127.0.0.1' }), descriptors = new Map(), oldFetch = globalThis.fetch;
  for (const [key, v] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, MouseEvent: dom.window.MouseEvent, Event: dom.window.Event, crypto: webcrypto, IS_REACT_ACT_ENVIRONMENT: true })) { descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: v }); }
  const vite = await createServer({ server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: 'custom', logLevel: 'error' });
  const { createRoot } = await import('react-dom/client'), ui = await vite.ssrLoadModule(path.resolve('web/warehouse-automatic-wz.tsx')), api = await vite.ssrLoadModule(path.resolve('web/api.ts'));
  const mounts = [];
  function reset(f) { globalThis.fetch = f.fetch; api.setWorkspace(f.tenant); ui.resetWarehouseAutomaticWzContext(''); ui.resetWarehouseAutomaticWzContext(scope); }
  async function mount(props = {}) {
    const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
    const h = { container, props: { contextKey: scope, available: true, readOnly: false, ...props }, async render(p = {}) { h.props = { ...h.props, ...p }; await act(async () => root.render(React.createElement(ui.WarehouseAutomaticWzPanel, h.props))); }, async close() { await act(async () => root.unmount()); container.remove(); } };
    mounts.push(h); await h.render(); return h;
  }
  async function ready(h) { await until(() => h.container.querySelector('select') && !button(h, 'Odczytaj konfiguracje WZ').disabled, 'full options settled'); }
  async function prepare(h) { await ready(h); await value(field(h, 'Magazyn automatycznych WZ'), id(20)); await click(field(h, 'Włącz automatyczne WZ dla tego magazynu')); await value(field(h, 'Nazwa serii WZ'), 'WZ wysyłkowe'); await value(field(h, 'Prefiks serii WZ'), 'WZ-SALE'); await click(button(h, prepareLabel)); await until(() => h.container.textContent.includes('Pełny zapisany podgląd konfiguracji WZ') && !ui.warehouseAutomaticWzLocked(h.props.contextKey), 'full validated preview ACK'); }
  async function commit(h) { await click(field(h, consent)); await click(button(h, commitLabel)); await until(() => h.container.textContent.includes('Konfiguracja WZ zapisana') && !ui.warehouseAutomaticWzLocked(h.props.contextKey) && !button(h, 'Odczytaj konfiguracje WZ').disabled, 'validated commit ACK and current options'); }
  try {
    await t.test('version0, full review, separate consent, one system series and issuer unavailable are truthful', async () => {
      const f = fixture(); reset(f); const h = await mount(); await prepare(h);
      assert.equal(f.writes.length, 1); assert.equal(f.writes[0].body.expected_version, '0'); assert.deepEqual(f.writes[0].body.settings, { enabled: true, moment: 'physical_dispatch', series_name: 'WZ wysyłkowe', prefix: 'WZ-SALE' });
      assert.equal(button(h, commitLabel).disabled, true); assert.ok(h.container.textContent.includes('Wystawianie WZ przy wydaniu nie jest jeszcze dostępne.')); assert.ok(h.container.querySelector('.waw-review').textContent.includes(id(40)));
      await commit(h); assert.equal(f.operations.length, 1); assert.equal(f.operations[0].after.version, '1'); assert.equal(f.writes[1].body.confirmed, true); assert.ok(h.container.textContent.includes('Nie potwierdza wystawienia dokumentu WZ ani wysyłki.'));
      await value(field(h, 'Prefiks serii WZ'), 'WZ-NEW'); assert.ok(!h.container.querySelector('.waw-review')); await click(button(h, prepareLabel)); await until(() => h.container.textContent.includes('Pełny zapisany podgląd') && !ui.warehouseAutomaticWzLocked(scope), 'new review');
      assert.equal(f.writes[2].body.expected_version, '1'); assert.equal(f.previews[1].snapshot.after.series_id, id(40)); assert.equal(button(h, commitLabel).disabled, true); await commit(h); assert.equal(f.operations[1].after.version, '2'); assert.equal(f.operations[1].after.series_id, id(40)); await h.close();
    });
    await t.test('historic full operation is distinct from current version and never acknowledges lost commit', async () => {
      const f = fixture(); reset(f); const h = await mount(); await prepare(h); await click(field(h, consent)); f.lost = true; await click(button(h, commitLabel)); await until(() => h.container.textContent.includes('Controlled lost ACK'), 'lost commit'); const original = f.writes[1]; await h.close();
      f.lost = false; f.warehouses[0].configuration = { ...f.warehouses[0].configuration, version: '2', settings: { ...f.warehouses[0].configuration.settings, prefix: 'LATER' } };
      const next = await mount({ externalWriteBlocked: true }); await ready(next); assert.ok(ui.warehouseAutomaticWzLocked(scope)); await click(button(next, 'Odczytaj historię WZ')); await until(() => next.container.textContent.includes('Otwórz pełny zapis WZ'), 'history page'); await click(button(next, 'Otwórz pełny zapis WZ ' + id(60))); await until(() => next.container.textContent.includes('historyczna wersja 1'), 'full historic receipt');
      assert.ok(ui.warehouseAutomaticWzLocked(scope)); assert.equal(f.writes.length, 2); await click(button(next, retryLabel)); await until(() => !ui.warehouseAutomaticWzLocked(scope) && !button(next, 'Odczytaj konfiguracje WZ').disabled, 'exact retry only clears'); assert.equal(f.writes[2].path, original.path); assert.equal(f.writes[2].raw, original.raw); assert.equal(f.operations.length, 1); assert.ok(next.container.textContent.includes('historyczna wersja 1')); await value(field(next, 'Magazyn automatycznych WZ'), id(20)); assert.ok(next.container.textContent.includes('LATER')); await next.close();
    });
    await t.test('held ACK shows progress without retry, then lost ACK exposes exact manual retry', async () => {
      const f = fixture(); reset(f); const h = await mount(); await prepare(h); let resolve; f.heldAck = new Promise(r => { resolve = r; }); await click(field(h, consent)); await click(button(h, commitLabel)); await until(() => f.writes.length === 2, 'held actual POST');
      assert.ok(h.container.textContent.includes('Trwa zapis konfiguracji WZ.')); assert.ok(!h.container.textContent.includes('Wynik zapisu konfiguracji WZ jest niepewny.')); assert.ok(![...h.container.querySelectorAll('button')].some(e => e.textContent === retryLabel));
      f.heldAck = null; await act(async () => { resolve(Promise.reject(new TypeError('Controlled held lost ACK'))); await Promise.resolve(); }); await until(() => h.container.textContent.includes('Controlled held lost ACK'), 'lost ACK settled');
      const original = f.writes[1]; assert.ok(h.container.textContent.includes('Wynik zapisu konfiguracji WZ jest niepewny.')); await click(button(h, retryLabel)); await until(() => !ui.warehouseAutomaticWzLocked(scope), 'known same key replay'); assert.equal(f.writes[2].raw, original.raw); await h.close();
    });
    await t.test('preview lost ACK survives remount; 408/429 and forged version preserve exact commit', async () => {
      const f = fixture(); reset(f); const h = await mount(); await ready(h); await value(field(h, 'Magazyn automatycznych WZ'), id(20)); f.lost = true; await click(button(h, prepareLabel)); await until(() => h.container.textContent.includes('Controlled lost ACK'), 'unknown preview'); const birth = f.writes[0]; await h.close();
      f.lost = false; const next = await mount(); await ready(next); await click(button(next, retryLabel)); await until(() => next.container.textContent.includes('Pełny zapisany podgląd') && !ui.warehouseAutomaticWzLocked(scope), 'same preview recovered'); assert.equal(f.writes[1].raw, birth.raw); assert.equal(f.previews.length, 1);
      await click(field(next, consent)); f.lost = true; await click(button(next, commitLabel)); await until(() => next.container.textContent.includes('Controlled lost ACK'), 'unknown commit'); const original = f.writes[2]; f.lost = false;
      for (const code of [408, 429]) { f.statusCode = code; await click(button(next, retryLabel)); await until(() => next.container.textContent.includes('Controlled status ' + code), 'retry status'); assert.ok(ui.warehouseAutomaticWzLocked(scope)); }
      f.statusCode = 0; f.malformed = true; await click(button(next, retryLabel)); await until(() => next.container.textContent.includes('Zapis nie zachowuje wersji'), 'forged successful reply'); assert.ok(ui.warehouseAutomaticWzLocked(scope));
      f.malformed = false; await click(button(next, retryLabel)); await until(() => !ui.warehouseAutomaticWzLocked(scope), 'validated retry'); for (const w of f.writes.slice(3)) { assert.equal(w.path, original.path); assert.equal(w.raw, original.raw); } assert.equal(f.operations.length, 1); await next.close();
    });
    await t.test('known validation refusal clears attempt; current foreign lock after preflight stops fresh POST', async () => {
      const f = fixture(); reset(f); const h = await mount(); await prepare(h); await click(field(h, consent)); f.statusCode = 422; await click(button(h, commitLabel)); await until(() => h.container.textContent.includes('Controlled status 422') && !ui.warehouseAutomaticWzLocked(scope), 'known refusal'); assert.equal(f.operations.length, 0); assert.ok(!h.container.querySelector('.waw-review'));
      f.statusCode = 0; let resolve; f.heldOptions = new Promise(r => { resolve = r; }); const prior = f.reads.length; await click(button(h, prepareLabel)); await until(() => f.reads.slice(prior).some(v => v.startsWith('/warehouse-automatic-wz/options')), 'preflight held'); await h.render({ externalWriteBlocked: true }); f.heldOptions = null; await act(async () => { resolve(Response.json(f.options())); await Promise.resolve(); }); await until(() => !ui.warehouseAutomaticWzLocked(scope), 'preflight released'); assert.equal(f.writes.length, 2); await h.close();
    });
    await t.test('current grant loss purges attempts; restore can read complete history but cannot write', async () => {
      const f = fixture(); reset(f); const h = await mount(); await prepare(h); await commit(h); await value(field(h, 'Prefiks serii WZ'), 'OTHER'); f.lost = true; await click(button(h, prepareLabel)); await until(() => h.container.textContent.includes('Controlled lost ACK'), 'unknown preview'); const count = f.writes.length;
      f.lost = false; f.flags.can_manage = false; await click(button(h, retryLabel)); await until(() => h.container.textContent.includes('Brak aktualnego prawa'), 'fresh revoked grant'); assert.equal(f.writes.length, count); assert.equal(ui.warehouseAutomaticWzLocked(scope), false); assert.ok(!h.container.textContent.includes('WZ wysyłkowe')); await h.close();
      f.flags = { ...flags, can_manage: false, read_only: true }; const restoredScope = `${tenant}:${user}:admin:true`; const r = await mount({ contextKey: restoredScope, readOnly: true }); await ready(r); await value(field(r, 'Magazyn automatycznych WZ'), id(20)); assert.equal(button(r, prepareLabel).closest('fieldset').disabled, true); await click(button(r, 'Odczytaj historię WZ')); await until(() => r.container.textContent.includes('Otwórz pełny zapis WZ'), 'restore history'); await click(button(r, 'Otwórz pełny zapis WZ ' + id(60))); await until(() => r.container.textContent.includes('historyczna wersja 1'), 'restore immutable receipt'); assert.equal(f.writes.length, count); await r.close();
    });
    await t.test('grant revoked while ACK held prevents late publication and clears old actor data', async () => {
      const f = fixture(); reset(f); let changed = 0; const h = await mount({ onChanged: () => { changed++; } }); await prepare(h); let resolve; f.heldAck = new Promise(r => { resolve = r; }); await click(field(h, consent)); await click(button(h, commitLabel)); await until(() => f.operations.length === 1, 'server commit before held ACK');
      const ack = structuredClone(f.results.get(f.writes[1].body.client_key)); f.flags.can_manage = false; f.heldAck = null; await act(async () => { resolve(Response.json(ack)); await Promise.resolve(); }); await until(() => h.container.textContent.includes('Odebrano dostęp do konfiguracji WZ.'), 'fresh post ACK denial');
      assert.equal(ui.warehouseAutomaticWzLocked(scope), false); assert.equal(changed, 0); assert.ok(!h.container.textContent.includes('Konfiguracja WZ zapisana')); assert.ok(!h.container.textContent.includes('WZ wysyłkowe')); assert.equal(f.writes.length, 2); await h.close();
    });
    await t.test('late old actor GET cannot publish after canonical context change', async () => {
      const f = fixture(); reset(f); let resolve; f.heldOptions = new Promise(r => { resolve = r; }); const old = f.options(); old.warehouses[0].name = 'OLD ACTOR SECRET'; const h = await mount(); await until(() => f.reads.some(v => v.includes('/options')), 'old actor request');
      f.heldOptions = null; f.tenant = id(3); api.setWorkspace(f.tenant); await h.render({ contextKey: `${f.tenant}:${user}:admin:false` }); await ready(h); await act(async () => { resolve(Response.json(old)); await Promise.resolve(); }); await tick(); assert.ok(!h.container.textContent.includes('OLD ACTOR SECRET')); assert.equal(f.writes.length, 0); await h.close();
    });
    await t.test('warehouse pages append completely; duplicate page fails closed; absent and torn remain distinct', async () => {
      const f = fixture(); reset(f); const rows = Array.from({ length: 51 }, (_, n) => ({ id: id(100 + n), name: 'Magazyn ' + n, code: 'WH' + n, configuration: { warehouse_id: id(100 + n), version: '0', series_id: null, settings: null } })); f.pageOptions = cursor => f.options(cursor ? rows.slice(50) : rows.slice(0, 50), cursor ? null : id(149));
      const h = await mount(); await ready(h); assert.equal(field(h, 'Magazyn automatycznych WZ').options.length, 51); await click(button(h, 'Dalsze magazyny WZ')); await until(() => field(h, 'Magazyn automatycznych WZ').options.length === 52, 'all 51 warehouses'); assert.equal(f.writes.length, 0); await h.close();
      const duplicate = fixture(); duplicate.pageOptions = () => duplicate.options(duplicate.warehouses, id(20)); reset(duplicate); const d = await mount(); await ready(d); await click(button(d, 'Dalsze magazyny WZ')); await until(() => d.container.textContent.includes('Powtórzona strona magazynów WZ'), 'duplicate rejected'); assert.equal(field(d, 'Magazyn automatycznych WZ').options.length, 2); await d.close();
      const absent = fixture(); absent.flags.available = absent.flags.configuration_available = absent.flags.can_manage = false; reset(absent); const a = await mount(); await ready(a); assert.ok(a.container.textContent.includes('Konfiguracja automatycznych WZ nie jest dostępna w tej kopii.')); await value(field(a, 'Magazyn automatycznych WZ'), id(20)); assert.equal(button(a, prepareLabel).closest('fieldset').disabled, true); assert.equal(absent.writes.length, 0); await a.close();
      const torn = fixture(); torn.torn = true; reset(torn); const x = await mount(); await until(() => x.container.textContent.includes('Niepełna instalacja konfiguracji WZ'), 'torn503'); assert.ok(!x.container.textContent.includes('Konfiguracja automatycznych WZ nie jest dostępna w tej kopii.')); assert.equal(torn.writes.length, 0); await x.close();
      const unavailable = fixture(); reset(unavailable); const u = await mount({ available: false }); assert.ok(u.container.textContent.includes('Konfiguracja automatycznych WZ nie jest dostępna w tej kopii.')); assert.equal(unavailable.reads.length, 0); await u.close();
    });
  } finally {
    for (const h of mounts) if (h.container.isConnected) await h.close(); await vite.close(); dom.window.close(); globalThis.fetch = oldFetch;
    for (const [key, descriptor] of descriptors) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
  }
});
