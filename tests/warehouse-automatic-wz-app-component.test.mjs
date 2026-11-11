import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { webcrypto } from 'node:crypto';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';
import { navigateApp } from './app-nav-helper.mjs';

// Actual App, canonical reset/subscription, account chooser and both warehouse
// configuration panels. Controlled HTTP only; unrelated editors are unavailable.
const id = n => `${String(n).padStart(8, '0')}-1670-4167-8167-167167167167`;
const tenant = id(1), user = id(2), scope = `${tenant}:${user}:admin:false`, sha = 'c'.repeat(64);
const consent = 'Sprawdziłem magazyn, serię i moment wystawienia. Zatwierdzam tę konfigurację WZ.';
const prepareLabel = 'Przygotuj podgląd konfiguracji WZ', commitLabel = 'Zapisz zatwierdzoną konfigurację WZ', retryLabel = 'Ponów dokładną próbę konfiguracji WZ';
function fixture() {
  const actors = new Map([
    [tenant, { id: user, tenant_id: tenant, role: 'admin', restore: false, capability: true }],
    [id(3), { id: id(4), tenant_id: id(3), role: 'admin', restore: false, capability: false }],
    [id(6), { id: user, tenant_id: id(6), role: 'admin', restore: true, capability: true }],
  ]);
  const f = { current: tenant, reads: [], writes: [], authWrites: [], unexpected: [], results: new Map(), previews: [], operations: [], lost: false, heldAck: null, heldHealth: null, policyLost: true, policyReply: null };
  f.actor = () => actors.get(f.current);
  f.user = () => { const { restore, capability, ...actor } = f.actor(); return { ...actor, name: 'Własny administrator App WZ', tenant_name: 'Własna firma App WZ', plan: 'pro', mfa_required: false }; };
  f.flags = () => ({ available: f.actor().capability, configuration_available: f.actor().capability, issuer_available: false, current_role: f.actor().role, can_read: true, can_manage: f.actor().capability && !f.actor().restore, read_only: f.actor().restore });
  f.policyFlags = () => ({ available: true, current_role: f.actor().role, can_read: true, can_manage: !f.actor().restore, read_only: f.actor().restore });
  f.warehouse = { id: id(20), name: 'Magazyn App WZ', code: 'APP', policy: { usage: 'sale', enabled: true, version: '0' }, configuration: { warehouse_id: id(20), version: '0', series_id: null, settings: null } };
  f.options = () => ({ ...f.flags(), warehouses: [{ id: f.warehouse.id, name: f.warehouse.name, code: f.warehouse.code, configuration: structuredClone(f.warehouse.configuration) }], next_cursor: null, limits: { warehouses: 200, page: 50 } });
  f.health = () => ({ schema_revision: '150_warehouse_automatic_wz', restore_preview: f.actor().restore, warehouse_automatic_wz_configuration_available: f.actor().capability, warehouse_automatic_wz_issuer_available: false, warehouse_inventory_policies_available: true, stocktake_adjustments_available: false });
  f.fetch = async (url, init = {}) => {
    const u = new URL(String(url), 'http://127.0.0.1'), p = u.pathname.replace(/^\/api/, ''), method = init.method ?? 'GET';
    if (p !== '/health') assert.equal(new Headers(init.headers).get('X-Workspace-ID'), f.current, 'Actual api.ts tenant header');
    // Topbar bell of the v2 automation notifications (Uwagi v3 lane M, web/automation-v2-notifications.tsx)
    // polls on mount and every minute; it is outside this scenario, so it is answered and not recorded.
    if (method === 'GET' && p === '/automations/v2/notifications') return Response.json({ unread: 0, data: [] });
    if (method === 'GET') {
      f.reads.push({ path: p + u.search, tenant: f.current });
      if (p === '/auth/me') return Response.json({ user: f.user() });
      if (p === '/health') return f.heldHealth ?? Response.json(f.health());
      if (p === '/workspaces') return Response.json({ data: [...actors].map(([id, a]) => ({ id, name: a.restore ? 'Własna kopia WZ' : a.capability ? 'Własna firma App WZ' : 'Firma bez konfiguracji WZ' })) });
      if (p === '/warehouses') return Response.json({ data: [{ id: f.warehouse.id, name: f.warehouse.name, code: f.warehouse.code }] });
      if (p === '/warehouse-automatic-wz/options') return Response.json(f.options());
      if (p === '/warehouse-automatic-wz/history') {
        const kind = u.searchParams.get('kind'); return Response.json({ ...f.flags(), kind, data: structuredClone(kind === 'operation' ? f.operations : f.previews), next_cursor: null });
      }
      if (p.startsWith('/warehouse-automatic-wz/operations/')) return Response.json({ ...f.flags(), operation: structuredClone(f.operations.find(o => p.endsWith(o.id))) });
      if (p.startsWith('/warehouse-automatic-wz/previews/')) return Response.json({ ...f.flags(), preview: structuredClone(f.previews.find(o => p.endsWith(o.id))) });
      if (p === '/warehouse-inventory-policies/options') return Response.json({ ...f.policyFlags(), warehouses: [{ id: f.warehouse.id, name: f.warehouse.name, code: f.warehouse.code, policy: f.warehouse.policy }], next_cursor: null });
      if (p === '/warehouse-inventory-policies/history') return Response.json({ ...f.policyFlags(), kind: u.searchParams.get('kind'), data: [], next_cursor: null });
      if (p === '/inventory' || p === '/inventory/movements') return Response.json({ data: [], meta: { has_more: false, cursor: null } });
      if (['/dashboard', '/orders/status-counts', '/stocktakes', '/wms-lots', '/stock-file-imports/options', '/stock-locations', '/warehouse-documents'].includes(p)) return Response.json({ detail: 'Controlled unrelated editor unavailable' }, { status: 503 });
    } else if (method === 'POST' && p === '/workspaces/switch') {
      const b = JSON.parse(init.body); assert.ok(actors.has(b.tenant_id)); f.authWrites.push({ path: p, tenant: f.current }); f.current = b.tenant_id; return Response.json({ user: f.user() });
    } else if (method === 'POST' && p === '/warehouse-inventory-policies/warehouses/' + id(20) + '/previews') {
      const b = JSON.parse(init.body); f.writes.push({ path: p, raw: init.body, body: b, tenant: f.current });
      if (!f.policyReply) f.policyReply = { ...f.policyFlags(), reused: false, preview: { id: id(80), warehouse_id: id(20), client_key: b.client_key, request: b, scope_hash: sha, snapshot: { warehouse: { id: id(20), name: f.warehouse.name, code: f.warehouse.code }, before: f.warehouse.policy, after: { usage: b.usage, enabled: b.enabled }, blockers: [] }, ready: true, created_at: '2026-10-07T12:00:00Z', expires_at: new Date(Date.now() + 900000).toISOString() } };
      if (f.policyLost) throw TypeError('Controlled foreign policy lost ACK'); return Response.json({ ...f.policyReply, reused: true });
    } else if (method === 'POST' && p.startsWith('/warehouse-automatic-wz/')) {
      assert.equal(f.actor().restore, false); assert.equal(f.actor().capability, true);
      const b = JSON.parse(init.body); f.writes.push({ path: p, raw: init.body, body: b, tenant: f.current }); let d = f.results.get(b.client_key);
      if (d) d = { ...structuredClone(d), ...f.flags(), reused: true };
      else if (p === '/warehouse-automatic-wz/warehouses/' + id(20) + '/previews') {
        const before = structuredClone(f.warehouse.configuration), after = { warehouse_id: id(20), version: String(BigInt(b.expected_version) + 1n), series_id: before.series_id ?? id(40), settings: structuredClone(b.settings) };
        const preview = { id: id(50), warehouse_id: id(20), client_key: b.client_key, request: structuredClone(b), scope_hash: sha, snapshot: { warehouse: { id: id(20), name: f.warehouse.name, code: f.warehouse.code }, before, after }, ready: true, can_commit: true, operation_id: null, created_at: '2026-10-07T12:00:00Z', expires_at: new Date(Date.now() + 900000).toISOString() };
        f.previews.push(preview); d = { ...f.flags(), preview: structuredClone(preview), reused: false }; f.results.set(b.client_key, structuredClone(d));
      } else if (p === '/warehouse-automatic-wz/previews/' + id(50) + '/commit') {
        const preview = f.previews[0], operation = { id: id(60), warehouse_id: id(20), preview_id: preview.id, client_key: b.client_key, request: structuredClone(b), scope_hash: sha, snapshot: structuredClone(preview.snapshot), before: structuredClone(preview.snapshot.before), after: structuredClone(preview.snapshot.after), revision_id: id(70), created_at: '2026-10-07T12:00:01Z' };
        f.operations.push(operation); f.warehouse.configuration = structuredClone(operation.after); preview.can_commit = false; preview.operation_id = operation.id; d = { ...f.flags(), operation: structuredClone(operation), reused: false }; f.results.set(b.client_key, structuredClone(d));
      } else throw Error('Unexpected controlled WZ mutation ' + p);
      if (f.lost) throw TypeError('Controlled WZ lost ACK'); if (f.heldAck) return f.heldAck; return Response.json(d, { status: 201 });
    }
    f.unexpected.push({ path: p, method }); throw Error('Unexpected actual App request ' + method + ' ' + p);
  };
  return f;
}
async function tick() { await act(async () => { await new Promise(r => setTimeout(r, 0)); }); }
async function until(check, note) { for (let i = 0; i < 100; i++) { if (check()) return; await tick(); } assert.ok(check(), note); }
function button(h, text) { const e = [...h.container.querySelectorAll('button')].find(e => e.textContent.trim() === text); assert.ok(e, text); return e; }
function field(h, text) { const e = [...h.container.querySelectorAll('label')].find(e => e.firstChild?.textContent === text || e.textContent.trim() === text)?.querySelector('select,input'); assert.ok(e, text); return e; }
async function click(e) { assert.ok(e); assert.equal(e.matches(':disabled'), false); await act(async () => e.dispatchEvent(new MouseEvent('click', { bubbles: true }))); }
async function select(e, v) { assert.equal(e.matches(':disabled'), false); await act(async () => { Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set.call(e, v); e.dispatchEvent(new Event('change', { bubbles: true })); }); }
async function navigate(h, name) { await navigateApp(h.container, name, click); }

test('actual App automatic WZ mount and actor interlocks — controlled HTTP', async t => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://127.0.0.1/' }), descriptors = new Map(), oldFetch = globalThis.fetch, mounts = [];
  for (const [key, v] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, location: dom.window.location, localStorage: dom.window.localStorage, HTMLElement: dom.window.HTMLElement, MouseEvent: dom.window.MouseEvent, Event: dom.window.Event, CustomEvent: dom.window.CustomEvent, FormData: dom.window.FormData, crypto: webcrypto, IS_REACT_ACT_ENVIRONMENT: true })) { descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: v }); }
  const oldScroll = dom.window.HTMLElement.prototype.scrollIntoView; dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  let vite; const mainPath = path.resolve('web/main.tsx');
  try {
    vite = await createServer({ server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: 'custom', logLevel: 'error', plugins: [{ name: 'actual-app-without-final-bootstrap', enforce: 'pre', transform(code, file) {
      if (file.split('?')[0] !== mainPath) return; const start = code.lastIndexOf("\ncreateRoot(document.getElementById('root')!)"); assert.ok(start > 0, 'Only final browser bootstrap removed'); return { code: code.slice(0, start) + '\nexport { App as AppUnderTest };\n', map: null };
    } }] });
    const { createRoot } = await import('react-dom/client'), main = await vite.ssrLoadModule(mainPath), ui = await vite.ssrLoadModule(path.resolve('web/warehouse-automatic-wz.tsx')), policies = await vite.ssrLoadModule(path.resolve('web/warehouse-inventory-policies.tsx')), api = await vite.ssrLoadModule(path.resolve('web/api.ts'));
    async function mount(f) {
      globalThis.fetch = f.fetch; api.setWorkspace(tenant); ui.resetWarehouseAutomaticWzContext(''); policies.resetWarehouseInventoryPoliciesContext(''); const container = document.createElement('div'); document.body.append(container); const root = createRoot(container), h = { container, async close() { await act(async () => root.unmount()); container.remove(); } }; mounts.push(h);
      await act(async () => root.render(React.createElement(React.StrictMode, null, React.createElement(main.AppUnderTest)))); await until(() => container.querySelector('.sidebar nav'), 'Actual authenticated App'); return h;
    }
    async function inventory(h) { await navigate(h, 'Magazyny'); await until(() => h.container.querySelector('.warehouse-automatic-wz select') && !button(h, 'Odczytaj konfiguracje WZ').matches(':disabled'), 'Actual config panel fresh options'); }
    async function prepare(h) { await inventory(h); await select(field(h, 'Magazyn automatycznych WZ'), id(20)); await click(field(h, 'Włącz automatyczne WZ dla tego magazynu')); await click(button(h, prepareLabel)); await until(() => h.container.textContent.includes('Pełny zapisany podgląd konfiguracji WZ') && !ui.warehouseAutomaticWzLocked(scope), 'Full actual preview'); }
    async function unknown(h, f) { await prepare(h); await click(field(h, consent)); f.lost = true; await click(button(h, commitLabel)); await until(() => h.container.textContent.includes('Controlled WZ lost ACK') && !button(h, retryLabel).matches(':disabled'), 'Actual unknown commit'); assert.ok(ui.warehouseAutomaticWzLocked(scope)); assert.equal(ui.warehouseAutomaticWzLocked('warehouse-automatic-wz:' + scope), false); }
    async function switchWorkspace(h, f, next) { const start = f.reads.length; await select(h.container.querySelector('select[aria-label="Aktywna organizacja"]'), next); await until(() => f.current === next && h.container.querySelector('select[aria-label="Aktywna organizacja"]')?.value === next && f.reads.slice(start).some(r => r.path === '/health' && r.tenant === next), 'Actual scope switch and health request'); await tick(); }

    await t.test('real App mount uses config capability and own lock does not reject first preview/consent/commit', async () => {
      const f = fixture(), h = await mount(f);
      try {
        await prepare(h); assert.equal(f.writes.length, 1); assert.equal(f.writes[0].body.expected_version, '0'); assert.equal(button(h, commitLabel).matches(':disabled'), true); assert.ok(h.container.textContent.includes('Wystawianie WZ przy wydaniu nie jest jeszcze dostępne.'));
        await click(field(h, consent)); await click(button(h, commitLabel)); await until(() => h.container.textContent.includes('Konfiguracja WZ zapisana — historyczna wersja 1') && !button(h, 'Odczytaj konfiguracje WZ').matches(':disabled'), 'Receipt retained after actual onChanged→App reload');
        assert.equal(f.writes.length, 2); assert.equal(f.operations.length, 1); assert.equal(button(h, 'Zmień konto').matches(':disabled'), false); assert.deepEqual(f.unexpected, []);
      } finally { await h.close(); }
    });
    await t.test('unknown commit survives real navigation, blocks sibling fresh write and chooser, history never ACKs, own replay works', async () => {
      const f = fixture(), h = await mount(f);
      try {
        await unknown(h, f); const original = f.writes[1]; assert.equal(button(h, 'Zmień konto').matches(':disabled'), true); assert.equal(button(h, 'Zmień konto').title, 'Najpierw potwierdź wynik zmiany magazynowej'); // web/main.tsx: one title for the automatic WZ and BO169 stock locks
        await select(field(h, 'Magazyn polityki'), id(20)); assert.equal(button(h, 'Przygotuj podgląd polityki magazynu').matches(':disabled'), true);
        await navigate(h, 'Przegląd'); assert.equal(h.container.querySelector('.warehouse-automatic-wz'), null); assert.ok(ui.warehouseAutomaticWzLocked(scope)); assert.equal(button(h, 'Zmień konto').matches(':disabled'), true); await inventory(h);
        await click(button(h, 'Odczytaj historię WZ')); await until(() => h.container.textContent.includes('Otwórz pełny zapis WZ'), 'History actual GET'); assert.equal(f.writes.length, 2); assert.ok(ui.warehouseAutomaticWzLocked(scope));
        await click(button(h, 'Otwórz pełny zapis WZ ' + id(60))); await until(() => h.container.textContent.includes('historyczna wersja 1') && !button(h, retryLabel).matches(':disabled'), 'Unknown still present after full receipt read'); assert.ok(ui.warehouseAutomaticWzLocked(scope));
        f.lost = false; await click(button(h, retryLabel)); await until(() => !ui.warehouseAutomaticWzLocked(scope) && !button(h, 'Zmień konto').matches(':disabled'), 'Actual exact replay unlocks App'); assert.equal(f.writes[2].raw, original.raw); assert.equal(f.writes[2].path, original.path); assert.equal(f.operations.length, 1); assert.deepEqual(f.unexpected, []);
      } finally { await h.close(); }
    });
    await t.test('fresh synchronous chooser getter blocks same-turn account switch before disabled subscription renders', async () => {
      const f = fixture(), h = await mount(f);
      try {
        await prepare(h); await click(field(h, consent)); const chooser = button(h, 'Zmień konto'), commit = button(h, commitLabel); assert.equal(chooser.disabled, false); let resolve; f.heldAck = new Promise(r => { resolve = r; });
        await act(async () => { commit.dispatchEvent(new MouseEvent('click', { bubbles: true })); assert.ok(ui.warehouseAutomaticWzLocked(scope), 'In-flight registry published synchronously'); assert.equal(chooser.disabled, false, 'Still-enabled DOM must rely on fresh getter before the subscription render'); chooser.dispatchEvent(new MouseEvent('click', { bubbles: true })); await Promise.resolve(); });
        await until(() => f.operations.length === 1, 'Held ACK reached server'); assert.ok(h.container.querySelector('.sidebar nav'), 'Client identity was not cleared by stale enabled chooser'); assert.equal(h.container.querySelector('input[name="email"]'), null); assert.equal(button(h, 'Zmień konto').matches(':disabled'), true); assert.deepEqual(f.authWrites, []); assert.ok(!h.container.textContent.includes(retryLabel));
        f.heldAck = null; const ack = f.results.get(f.writes[1].body.client_key); await act(async () => { resolve(Response.json(ack)); await Promise.resolve(); }); await until(() => !ui.warehouseAutomaticWzLocked(scope) && !button(h, 'Zmień konto').matches(':disabled'), 'Validated held ACK clears chooser guard'); assert.equal(f.writes.length, 2); assert.deepEqual(f.unexpected, []);
      } finally { await h.close(); }
    });
    await t.test('foreign policy unknown blocks WZ fresh preview, foreign own exact retry remains possible', async () => {
      const f = fixture(), h = await mount(f);
      try {
        await inventory(h); await until(() => h.container.querySelector('.warehouse-inventory-policies select') && !button(h, 'Odczytaj polityki magazynów').matches(':disabled'), 'Actual sibling policy options'); await select(field(h, 'Magazyn polityki'), id(20)); await select(field(h, 'Przeznaczenie magazynu'), 'custody'); await click(button(h, 'Przygotuj podgląd polityki magazynu')); await until(() => h.container.textContent.includes('Controlled foreign policy lost ACK'), 'Foreign actual pending');
        assert.ok(policies.warehouseInventoryPoliciesWriteLocked(scope)); await select(field(h, 'Magazyn automatycznych WZ'), id(20)); assert.equal(button(h, prepareLabel).matches(':disabled'), true); assert.equal(ui.warehouseAutomaticWzLocked(scope), false); const original = f.writes[0]; f.policyLost = false;
        await click(button(h, 'Ponów dokładną próbę polityki magazynu')); await until(() => !policies.warehouseInventoryPoliciesWriteLocked(scope) && !button(h, prepareLabel).matches(':disabled'), 'Sibling exact retry unlocks WZ'); assert.equal(f.writes[1].raw, original.raw); assert.equal(f.writes[1].path, original.path); await click(button(h, prepareLabel)); await until(() => h.container.textContent.includes('Pełny zapisany podgląd konfiguracji WZ'), 'Fresh WZ after sibling resolution'); assert.equal(f.writes.length, 3); assert.deepEqual(f.unexpected, []);
      } finally { await h.close(); }
    });
    await t.test('closed-panel pending purges on actor switch; health reset hides previous capability until new result', async () => {
      const f = fixture(), h = await mount(f);
      try {
        await unknown(h, f); await navigate(h, 'Przegląd'); let resolve; f.heldHealth = new Promise(r => { resolve = r; }); await switchWorkspace(h, f, id(3)); assert.equal(ui.warehouseAutomaticWzLocked(scope), false); await navigate(h, 'Magazyny'); await until(() => h.container.querySelector('.warehouse-automatic-wz') && h.container.textContent.includes('Konfiguracja automatycznych WZ nie jest dostępna w tej kopii.'), 'Health reset cannot reuse previous true capability');
        assert.ok(!h.container.textContent.includes(retryLabel)); assert.equal(h.container.querySelector('.warehouse-automatic-wz select'), null); f.heldHealth = null; await act(async () => { resolve(Response.json(f.health())); await Promise.resolve(); }); await tick(); assert.equal(f.writes.length, 2); assert.equal(ui.warehouseAutomaticWzLocked(`${id(3)}:${id(4)}:admin:false`), false);
        await switchWorkspace(h, f, tenant); await inventory(h); assert.ok(!h.container.textContent.includes(retryLabel)); assert.equal(f.writes.length, 2); assert.deepEqual(f.unexpected, []);
      } finally { await h.close(); }
    });
    await t.test('restore canonical fourth field purges prior attempt; full saved operation remains readable without writes', async () => {
      const f = fixture(), h = await mount(f);
      try {
        await unknown(h, f); await navigate(h, 'Przegląd'); await switchWorkspace(h, f, id(6)); await until(() => h.container.textContent.includes('Kopia odtworzona · tylko odczyt'), 'Real copy banner'); await inventory(h); assert.equal(ui.warehouseAutomaticWzLocked(scope), false); assert.equal(ui.warehouseAutomaticWzLocked(`${id(6)}:${user}:admin:true`), false); assert.ok(!h.container.textContent.includes(retryLabel));
        await select(field(h, 'Magazyn automatycznych WZ'), id(20)); assert.equal(button(h, prepareLabel).matches(':disabled'), true); await click(button(h, 'Odczytaj historię WZ')); await until(() => h.container.textContent.includes('Otwórz pełny zapis WZ'), 'Read-only full history list'); await click(button(h, 'Otwórz pełny zapis WZ ' + id(60))); await until(() => h.container.textContent.includes('Konfiguracja WZ zapisana — historyczna wersja 1'), 'Read-only historical confirmation'); assert.equal(f.writes.length, 2); assert.deepEqual(f.unexpected, []);
      } finally { await h.close(); }
    });
  } finally {
    try { for (const h of mounts) if (h.container.isConnected) await h.close(); }
    finally { if (vite) await vite.close(); dom.window.HTMLElement.prototype.scrollIntoView = oldScroll; globalThis.fetch = oldFetch; dom.window.close(); for (const [key, descriptor] of descriptors) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
  }
});
