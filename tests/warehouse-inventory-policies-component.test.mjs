import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { webcrypto } from 'node:crypto';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

// Actual ReactDOM production panel, controlled HTTP. No native database/intake proof.
const id = n => `${String(n).padStart(8, '0')}-1610-4161-8161-161161161161`;
const tenant = id(1), user = id(2), scope = `${tenant}:${user}:admin:false`, sha = 'b'.repeat(64);
const flags = { available: true, read_only: false, can_read: true, can_manage: true, current_role: 'admin' };
const consent = 'Sprawdziłem magazyn, przeznaczenie, aktywność i blokady. Zatwierdzam tę zmianę polityki.';
function fixture() {
  const f = { flags: { ...flags }, tenant, user, writes: [], reads: [], results: new Map(), lost: false, malformed: false, statusCode: 0, heldOptions: null, blockers: [] };
  f.warehouses = [{ id: id(20), name: 'Kontrola', code: 'HOLD', policy: { usage: 'sale', enabled: true, version: '0' } }];
  f.options = () => ({ ...f.flags, warehouses: structuredClone(f.warehouses), next_cursor: null });
  f.fetch = async (url, init = {}) => {
    const u = new URL(String(url), 'http://127.0.0.1'), p = u.pathname.replace(/^\/api/, ''), method = init.method ?? 'GET';
    if (method === 'GET') {
      f.reads.push(p + u.search);
      if (p === '/auth/me') return Response.json({ user: { tenant_id: f.tenant, id: f.user, role: f.flags.current_role } });
      if (p === '/warehouse-inventory-policies/options') {
        if (f.heldOptions) return f.heldOptions;
        if (f.torn) return Response.json({ detail: 'Niespójny moduł polityki magazynu' }, { status: 503 });
        return Response.json(f.options());
      }
      if (p === '/warehouse-inventory-policies/history') {
        const kind = u.searchParams.get('kind'), entity = kind === 'preview' ? f.preview : f.operation;
        return Response.json({ ...f.flags, kind, data: entity ? [{ id: entity.id, warehouse_id: entity.warehouse_id, client_key: entity.client_key, created_at: entity.created_at }] : [], next_cursor: null });
      }
      if (p.includes('/operations/')) return Response.json({ ...f.flags, operation: structuredClone(f.operation) });
      if (p.includes('/previews/')) return Response.json({ ...f.flags, preview: structuredClone(f.preview) });
      if (p === '/inventory') {
        assert.equal(u.searchParams.get('warehouse_id'), id(20));
        return Response.json({ data: [{ warehouse_id: id(20), product_id: id(30), sku: 'TEST-SKU', name: 'Towar fizyczny', on_hand: 7, reserved: 2, physical_available: 5, sellable_available: 0, inventory_usage: 'custody', inventory_enabled: true, inventory_policy_version: '4' }], meta: { has_more: false, cursor: null } });
      }
      throw Error('Unexpected GET ' + p);
    }
    assert.equal(method, 'POST'); const b = JSON.parse(init.body); f.writes.push({ path: p, raw: init.body, body: b });
    if (f.statusCode) return Response.json({ detail: 'Controlled status' }, { status: f.statusCode });
    let d = f.results.get(b.client_key);
    if (d) d = { ...structuredClone(d), ...f.flags, reused: true };
    else if (p === '/warehouse-inventory-policies/warehouses/' + id(20) + '/previews') {
      const w = f.warehouses[0];
      f.preview = { id: id(50), warehouse_id: w.id, client_key: b.client_key, request: b, scope_hash: sha, snapshot: { warehouse: { id: w.id, name: w.name, code: w.code }, before: structuredClone(w.policy), after: { usage: b.usage, enabled: b.enabled }, blockers: [...f.blockers] }, ready: f.blockers.length === 0, created_at: '2026-10-07T10:00:00Z', expires_at: new Date(Date.now() + 900000).toISOString() };
      d = { ...f.flags, preview: structuredClone(f.preview), reused: false }; f.results.set(b.client_key, structuredClone(d));
    } else if (p === '/warehouse-inventory-policies/previews/' + id(50) + '/commit') {
      assert.equal(f.preview.ready, true, 'occupied preview must never commit');
      const before = f.preview.snapshot.before, after = { ...f.preview.snapshot.after, version: String(BigInt(before.version) + 1n) };
      f.operation = { id: id(60), warehouse_id: id(20), preview_id: id(50), client_key: b.client_key, scope_hash: sha, before, after, revision_id: id(70), created_at: '2026-10-07T10:00:00Z' };
      f.warehouses[0].policy = structuredClone(after);
      d = { ...f.flags, operation: structuredClone(f.operation), reused: false }; f.results.set(b.client_key, structuredClone(d));
    } else throw Error('Unexpected POST ' + p);
    if (f.lost) throw TypeError('Controlled lost ACK');
    if (f.malformed) { d = structuredClone(d); if (d.operation) d.operation.warehouse_id = id(99); else d.preview.request.version = '99'; }
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
test('warehouse inventory policies mounted controlled component', async t => {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://127.0.0.1' }), saved = new Map(), oldFetch = globalThis.fetch;
  for (const [key, v] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, MouseEvent: dom.window.MouseEvent, Event: dom.window.Event, crypto: webcrypto, IS_REACT_ACT_ENVIRONMENT: true })) { saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: v }); }
  const vite = await createServer({ server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: 'custom', logLevel: 'error' });
  const { createRoot } = await import('react-dom/client'), ui = await vite.ssrLoadModule(path.resolve('web/warehouse-inventory-policies.tsx')), api = await vite.ssrLoadModule(path.resolve('web/api.ts'));
  const mounts = [];
  function reset(f) { globalThis.fetch = f.fetch; api.setWorkspace(f.tenant); ui.resetWarehouseInventoryPoliciesContext(''); ui.resetWarehouseInventoryPoliciesContext(scope); }
  async function mount(props = {}) {
    const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
    const h = { container, props: { contextKey: scope, readOnly: false, ...props }, async render(p = {}) { h.props = { ...h.props, ...p }; await act(async () => root.render(React.createElement(ui.WarehouseInventoryPoliciesPanel, h.props))); }, async close() { await act(async () => root.unmount()); container.remove(); } };
    mounts.push(h); await h.render(); return h;
  }
  async function ready(h) { await until(() => [...h.container.querySelectorAll('select')].some(e => e.closest('label').textContent.includes('Magazyn polityki')) && !button(h, 'Odczytaj polityki magazynów').disabled, 'fresh warehouse options'); }
  async function prepare(h) { await ready(h); await value(field(h, 'Magazyn polityki'), id(20)); await value(field(h, 'Przeznaczenie magazynu'), 'custody'); await click(button(h, 'Przygotuj podgląd polityki magazynu')); await until(() => h.container.textContent.includes('Pełny zapisany podgląd polityki') && !button(h, 'Odczytaj polityki magazynów').disabled, 'full frozen preview'); }
  try {
    await t.test('version0, full before/after, separate consent, immutable operation history', async () => {
      const f = fixture(); reset(f); const h = await mount(); await prepare(h);
      assert.equal(f.writes.length, 1); assert.equal(f.writes[0].body.version, '0'); assert.ok(h.container.querySelector('.wip-review').textContent.includes('Kontrola (HOLD)')); assert.equal(button(h, 'Zapisz zatwierdzoną politykę magazynu').disabled, true);
      await click(field(h, consent)); await click(button(h, 'Zapisz zatwierdzoną politykę magazynu')); await until(() => h.container.textContent.includes('Polityka zapisana — historyczna rewizja 1') && !button(h, 'Odczytaj polityki magazynów').disabled, 'confirmed operation');
      assert.equal(f.writes.length, 2); assert.equal(f.operation.after.version, '1'); assert.equal(f.writes[1].body.confirmed, true);
      f.warehouses[0].policy = { usage: 'sale', enabled: true, version: '2' }; await click(button(h, 'Odczytaj polityki magazynów')); await ready(h); await click(button(h, 'Odczytaj historię polityk')); await until(() => h.container.textContent.includes('Otwórz pełny zapis polityki'), 'history headers'); await click(button(h, 'Otwórz pełny zapis polityki ' + id(60)));
      await until(() => h.container.querySelector('.wip-review')?.textContent.includes('historyczna rewizja 1'), 'historic proof independent of current policy'); assert.ok(h.container.querySelector('.wip-review').textContent.includes('Magazyn poza sprzedażą')); assert.equal(f.writes.length, 2); await h.close();
    });
    await t.test('occupied warehouse blockers forbid consent/commit; editing invalidates review', async () => {
      const f = fixture(); f.blockers = ['STOCK_NOT_EMPTY', 'WMS_NOT_EMPTY', 'OPEN_PURCHASES']; reset(f); const h = await mount(); await prepare(h);
      assert.ok(h.container.textContent.includes('Magazyn ma zapas lub rezerwacje.')); assert.ok(h.container.textContent.includes('Partie WMS mają zapas lub rezerwacje.')); assert.ok(h.container.textContent.includes('Pozostają otwarte zakupy.'));
      assert.equal(field(h, consent).disabled, true); assert.equal(button(h, 'Zapisz zatwierdzoną politykę magazynu').disabled, true); assert.equal(f.writes.length, 1);
      await value(field(h, 'Przeznaczenie magazynu'), 'sale'); assert.ok(!h.container.querySelector('.wip-review')); assert.equal(f.writes.length, 1); await h.close();
    });
    await t.test('physical5 is not sellable0; numbers and policy version come from actual inventory DTO', async () => {
      const f = fixture(); reset(f); const h = await mount(); await ready(h); await value(field(h, 'Magazyn polityki'), id(20)); await click(button(h, 'Odczytaj fizyczny i sprzedażowy zapas')); await until(() => h.container.querySelector('tbody tr'), 'inventory view');
      const cells = [...h.container.querySelectorAll('tbody tr td')].map(e => e.textContent); assert.deepEqual(cells.slice(1, 5), ['7', '2', '5', '0']); assert.ok(cells[5].includes('wersja 4')); assert.equal(f.writes.length, 0); await h.close();
    });
    await t.test('lost ACK survives remount and GET; 429/malformed2xx preserve exact commit until validated retry', async () => {
      const f = fixture(); reset(f); const h = await mount(); await prepare(h); await click(field(h, consent)); f.lost = true; await click(button(h, 'Zapisz zatwierdzoną politykę magazynu'));
      await until(() => h.container.textContent.includes('Controlled lost ACK'), 'unknown commit'); const original = f.writes[1]; assert.ok(ui.warehouseInventoryPoliciesWriteLocked(scope)); await h.close(); f.lost = false;
      const next = await mount({ externalWriteBlocked: true }); await ready(next); await click(button(next, 'Odczytaj historię polityk')); await until(() => next.container.textContent.includes('Otwórz pełny zapis polityki'), 'GET history'); assert.ok(ui.warehouseInventoryPoliciesWriteLocked(scope));
      f.statusCode = 429; await click(button(next, 'Ponów dokładną próbę polityki magazynu')); await until(() => next.container.textContent.includes('Controlled status'), 'rate response'); assert.ok(ui.warehouseInventoryPoliciesWriteLocked(scope));
      f.statusCode = 0; f.malformed = true; await click(button(next, 'Ponów dokładną próbę polityki magazynu')); await until(() => next.container.textContent.includes('nie odpowiada dokładnej zgodzie'), 'foreign warehouse malformed success'); assert.ok(ui.warehouseInventoryPoliciesWriteLocked(scope));
      f.malformed = false; await click(button(next, 'Ponów dokładną próbę polityki magazynu')); await until(() => !ui.warehouseInventoryPoliciesWriteLocked(scope), 'validated exact replay');
      for (const w of f.writes.slice(2)) { assert.equal(w.path, original.path); assert.equal(w.raw, original.raw); } assert.equal(f.results.size, 2); await next.close();
    });
    await t.test('known409 requires fresh preview; external lock during held preflight prevents fresh POST', async () => {
      const f = fixture(); reset(f); const h = await mount(); await prepare(h); await click(field(h, consent)); f.statusCode = 409; await click(button(h, 'Zapisz zatwierdzoną politykę magazynu')); await until(() => !ui.warehouseInventoryPoliciesWriteLocked(scope), 'known terminal reject'); assert.ok(!h.container.querySelector('.wip-review')); assert.equal(f.operation, undefined);
      f.statusCode = 0; let resolve; f.heldOptions = new Promise(r => { resolve = r; }); const startReads = f.reads.length; await click(button(h, 'Przygotuj podgląd polityki magazynu')); await until(() => f.reads.slice(startReads).some(p => p.startsWith('/warehouse-inventory-policies/options')), 'held fresh preflight');
      await h.render({ externalWriteBlocked: true }); f.heldOptions = null; await act(async () => { resolve(Response.json(f.options())); await Promise.resolve(); }); await until(() => !ui.warehouseInventoryPoliciesWriteLocked(scope), 'preflight release'); assert.equal(f.writes.length, 2); await h.close();
    });
    await t.test('late old actor rejected; readonly history allowed; absent and torn503 distinct', async () => {
      const f = fixture(); reset(f); let resolve; f.heldOptions = new Promise(r => { resolve = r; }); const h = await mount(); await until(() => f.reads.some(p => p.includes('/options')), 'old actor read');
      f.heldOptions = null; f.tenant = id(3); f.flags = { ...flags, current_role: 'viewer', can_manage: false, read_only: true }; api.setWorkspace(f.tenant); await h.render({ contextKey: `${f.tenant}:${user}:viewer:true`, readOnly: true }); await ready(h);
      await act(async () => { resolve(Response.json({ ...flags, warehouses: [{ ...f.warehouses[0], name: 'FOREIGN OLD ACTOR' }], next_cursor: null })); await Promise.resolve(); }); await tick(); assert.ok(!h.container.textContent.includes('FOREIGN OLD ACTOR'));
      await value(field(h, 'Magazyn polityki'), id(20)); assert.equal(button(h, 'Przygotuj podgląd polityki magazynu').closest('fieldset').disabled, true); await click(button(h, 'Odczytaj historię polityk')); await until(() => f.reads.some(p => p.includes('/history')), 'readonly history'); assert.equal(f.writes.length, 0); await h.close();
      const absent = fixture(); absent.flags.available = false; absent.flags.can_manage = false; reset(absent); const a = await mount(); await ready(a); assert.ok(a.container.textContent.includes('Konfiguracja polityki nie jest dostępna w tej kopii.')); await value(field(a, 'Magazyn polityki'), id(20)); assert.equal(button(a, 'Przygotuj podgląd polityki magazynu').closest('fieldset').disabled, true); assert.equal(absent.writes.length, 0); await a.close();
      const torn = fixture(); torn.torn = true; reset(torn); const b = await mount(); await until(() => b.container.textContent.includes('Niespójny moduł polityki magazynu'), 'torn503 visible'); assert.ok(!b.container.textContent.includes('Konfiguracja polityki nie jest dostępna w tej kopii.')); assert.equal(torn.writes.length, 0); await b.close();
    });
  } finally {
    for (const h of mounts) if (h.container.isConnected) await h.close(); await vite.close(); dom.window.close(); globalThis.fetch = oldFetch;
    for (const [key, d] of saved) if (d) Object.defineProperty(globalThis, key, d); else delete globalThis[key];
  }
});
