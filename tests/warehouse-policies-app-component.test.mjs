import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { webcrypto } from 'node:crypto';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';
import { navigateApp } from './app-nav-helper.mjs';

// Actual App/navigation/WorkspaceSwitcher/policy panel. Controlled HTTP only.
// Unrelated stock editors return explicit503; this is not their regression suite.
const id = n => `${String(n).padStart(8, '0')}-1610-4161-8161-161161161161`;
const tenant = id(1), user = id(2), scope = `${tenant}:${user}:admin:false`, sha = 'c'.repeat(64);
const warehouse = { id: id(20), name: 'Własny magazyn App', code: 'APP', policy: { usage: 'sale', enabled: true, version: '0' } };
function fixture() {
  const actors = new Map([
    [tenant, { id: user, tenant_id: tenant, role: 'admin', restore: false }],
    [id(3), { id: id(4), tenant_id: id(3), role: 'viewer', restore: false }],
    [id(6), { id: user, tenant_id: id(6), role: 'admin', restore: true }],
  ]);
  const f = { current: tenant, loggedIn: true, reads: [], writes: [], authWrites: [], unexpected: [], receipts: new Map(), lost: true };
  f.actor = () => actors.get(f.current);
  f.user = () => { const { restore, ...a } = f.actor(); return { ...a, name: 'Własny operator App', tenant_name: 'Własna firma App', plan: 'pro', mfa_required: false }; };
  f.flags = () => ({ available: true, current_role: f.actor().role, read_only: f.actor().restore, can_read: true, can_manage: f.actor().role === 'admin' && !f.actor().restore });
  f.fetch = async (url, init = {}) => {
    const u = new URL(String(url), 'http://127.0.0.1'), p = u.pathname.replace(/^\/api/, ''), method = init.method ?? 'GET';
    if (p !== '/health') assert.equal(new Headers(init.headers).get('X-Workspace-ID'), f.loggedIn ? f.current : null, 'Actual api.ts workspace header');
    // Topbar bell of the v2 automation notifications (Uwagi v3 lane M, web/automation-v2-notifications.tsx)
    // polls on mount and every minute; it is outside this scenario, so it is answered and not recorded.
    if (method === 'GET' && p === '/automations/v2/notifications') return Response.json({ unread: 0, data: [] });
    if (method === 'GET') {
      f.reads.push({ path: p + u.search, tenant: f.current });
      if (p === '/auth/me') return f.loggedIn ? Response.json({ user: f.user() }) : Response.json({ detail: 'Logged out' }, { status: 401 });
      if (p === '/health') return Response.json({ restore_preview: f.actor().restore, warehouse_inventory_policies_available: true });
      if (p === '/workspaces') return Response.json({ data: [{ id: tenant, name: 'Własna firma App' }, { id: id(3), name: 'Inny aktor viewer' }, { id: id(6), name: 'Własna odtworzona kopia' }] });
      if (p === '/warehouses') return Response.json({ data: [{ id: warehouse.id, name: warehouse.name, code: warehouse.code }] });
      if (p === '/warehouse-inventory-policies/options') return Response.json({ ...f.flags(), warehouses: [structuredClone(warehouse)], next_cursor: null });
      if (p === '/warehouse-inventory-policies/history') return Response.json({ ...f.flags(), kind: u.searchParams.get('kind'), data: [], next_cursor: null });
      if (p === '/inventory') return Response.json({ data: [{ product_id: id(30), warehouse_id: warehouse.id, warehouse_name: warehouse.name, name: 'Własny fizyczny zapas App', sku: 'APP-PHYSICAL', location: 'A-01', on_hand: 5, reserved: 1, available: 4, physical_available: 4, sellable_available: 0, inventory_usage: 'custody', inventory_enabled: true, inventory_policy_version: '2' }], meta: { has_more: false, cursor: null } });
      if (p === '/inventory/movements') return Response.json({ data: [], meta: { has_more: false, cursor: null } });
      if (p === '/returns') return Response.json({ data: [], meta: { has_more: false, cursor: null } });
      if (p === '/return-assistant/settings') return Response.json({ detail: 'Controlled unrelated assistant queue unavailable' }, { status: 503 });
      if (p === '/return-assistant/statuses/options') return Response.json({ ...f.flags(), intake_available: false, warehouses: [structuredClone(warehouse)], limits: {} });
      if (p === '/return-assistant/statuses') return Response.json({ ...f.flags(), intake_available: false, data: [{ id: id(90), revision_id: id(91), version: '1', settings: { name: 'Własny status bez zamówienia', color: '#2563eb', active: true, decision: 'accept', inventory_effect: 'sale', warehouse_id: warehouse.id, warehouse_policy_version: '0', default_location: 'RETURN-01' }, created_at: '2026-10-07T12:00:00Z', updated_at: '2026-10-07T12:00:00Z' }], next_cursor: null });
      if (['/dashboard', '/orders/status-counts', '/stocktakes', '/wms-lots', '/stock-file-imports/options', '/stock-locations', '/warehouse-documents'].includes(p)) return Response.json({ detail: 'Controlled unrelated editor unavailable' }, { status: 503 });
    } else if (method === 'POST' && p === '/workspaces/switch') {
      const body = JSON.parse(init.body); assert.ok(actors.has(body.tenant_id)); f.authWrites.push({ path: p, tenant: f.current }); f.current = body.tenant_id; return Response.json({ user: f.user() });
    } else if (method === 'POST' && p === '/auth/logout') {
      f.authWrites.push({ path: p, tenant: f.current }); f.loggedIn = false; return Response.json({ ok: true });
    } else if (method === 'POST' && p === '/auth/login') {
      assert.equal(f.loggedIn, false); f.authWrites.push({ path: p, tenant: f.current }); f.loggedIn = true; return Response.json({ user: f.user() });
    } else if (method === 'POST' && p === '/warehouse-inventory-policies/warehouses/' + warehouse.id + '/previews') {
      assert.equal(f.actor().role, 'admin'); assert.equal(f.actor().restore, false);
      const b = JSON.parse(init.body); f.writes.push({ path: p, raw: init.body, body: b, tenant: f.current }); let d = f.receipts.get(b.client_key);
      if (d) d = { ...structuredClone(d), reused: true };
      else {
        assert.equal(b.version, '0'); assert.equal(b.usage, 'custody'); assert.equal(b.enabled, true);
        const preview = { id: id(50), warehouse_id: warehouse.id, client_key: b.client_key, request: b, scope_hash: sha, snapshot: { warehouse: { id: warehouse.id, name: warehouse.name, code: warehouse.code }, before: structuredClone(warehouse.policy), after: { usage: b.usage, enabled: b.enabled }, blockers: [] }, ready: true, created_at: '2026-10-07T12:00:00Z', expires_at: new Date(Date.now() + 900000).toISOString() };
        d = { ...f.flags(), preview, reused: false }; f.receipts.set(b.client_key, structuredClone(d));
      }
      if (f.lost) throw TypeError('Controlled lost policy preview ACK'); return Response.json(d, { status: 201 });
    }
    f.unexpected.push({ path: p, method }); throw Error(`Unexpected controlled App request: ${method} ${p}`);
  };
  return f;
}
async function tick() { await act(async () => { await new Promise(r => setTimeout(r, 0)); }); }
async function until(check, note) { for (let i = 0; i < 100; i++) { if (check()) return; await tick(); } assert.ok(check(), note); }
function button(h, text) { const e = [...h.container.querySelectorAll('button')].find(e => e.textContent.trim() === text); assert.ok(e, text); return e; }
function field(h, text) { const label = [...h.container.querySelectorAll('label')].find(e => e.firstChild?.textContent === text || e.textContent.trim() === text); const e = label?.querySelector('select,input'); assert.ok(e, text); return e; }
async function click(e) { assert.ok(e); assert.equal(e.matches(':disabled'), false); await act(async () => e.dispatchEvent(new MouseEvent('click', { bubbles: true }))); }
async function select(e, v) { assert.ok(e); assert.equal(e.matches(':disabled'), false); await act(async () => { Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set.call(e, v); e.dispatchEvent(new Event('change', { bubbles: true })); }); }
async function navigate(h, name) { await navigateApp(h.container, name, click); }

test('actual App warehouse policy scope and readonly navigation — controlled HTTP', async t => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://127.0.0.1/' }), saved = new Map(), savedFetch = globalThis.fetch;
  for (const [k, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, location: dom.window.location, localStorage: dom.window.localStorage, HTMLElement: dom.window.HTMLElement, MouseEvent: dom.window.MouseEvent, Event: dom.window.Event, CustomEvent: dom.window.CustomEvent, FormData: dom.window.FormData, crypto: webcrypto, IS_REACT_ACT_ENVIRONMENT: true })) { saved.set(k, Object.getOwnPropertyDescriptor(globalThis, k)); Object.defineProperty(globalThis, k, { configurable: true, writable: true, value }); }
  const oldScroll = dom.window.HTMLElement.prototype.scrollIntoView; dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  const mainPath = path.resolve('web/main.tsx'), mounts = []; let vite;
  try {
    vite = await createServer({ server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: 'custom', logLevel: 'error', plugins: [{ name: 'actual-app-without-final-bootstrap', enforce: 'pre', transform(code, file) {
      if (file.split('?')[0] !== mainPath) return; const start = code.lastIndexOf("\ncreateRoot(document.getElementById('root')!)"); assert.ok(start > 0, 'Only final browser bootstrap removed'); return { code: code.slice(0, start) + '\nexport { App as AppUnderTest };\n', map: null };
    } }] });
    const { createRoot } = await import('react-dom/client'), main = await vite.ssrLoadModule(mainPath), ui = await vite.ssrLoadModule(path.resolve('web/warehouse-inventory-policies.tsx')), api = await vite.ssrLoadModule(path.resolve('web/api.ts'));
    async function mount(f) {
      globalThis.fetch = f.fetch; api.setWorkspace(tenant); ui.resetWarehouseInventoryPoliciesContext(''); const container = document.createElement('div'); document.body.append(container); const root = createRoot(container), h = { container, async close() { await act(async () => root.unmount()); container.remove(); } }; mounts.push(h);
      await act(async () => root.render(React.createElement(React.StrictMode, null, React.createElement(main.AppUnderTest)))); await until(() => container.querySelector('.sidebar nav'), 'Actual authenticated App'); return h;
    }
    async function policies(h) { await navigate(h, 'Magazyny'); await until(() => h.container.querySelector('.warehouse-inventory-policies select') && !button(h, 'Odczytaj polityki magazynów').matches(':disabled'), 'Actual policy mount and fresh options'); }
    async function unknown(h, f) {
      await policies(h); await select(field(h, 'Magazyn polityki'), warehouse.id); await select(field(h, 'Przeznaczenie magazynu'), 'custody'); await click(button(h, 'Przygotuj podgląd polityki magazynu'));
      await until(() => h.container.textContent.includes('Controlled lost policy preview ACK') && !button(h, 'Ponów dokładną próbę polityki magazynu').matches(':disabled'), 'Retained actual preview request'); assert.equal(f.writes.length, 1); assert.ok(ui.warehouseInventoryPoliciesWriteLocked(scope)); assert.equal(ui.warehouseInventoryPoliciesWriteLocked('warehouse-policy:' + scope), false, 'React key is not actor registry identity');
    }
    async function switchWorkspace(h, f, next) {
      const start = f.reads.length; await select(h.container.querySelector('select[aria-label="Aktywna organizacja"]'), next);
      await until(() => f.current === next && h.container.querySelector('select[aria-label="Aktywna organizacja"]')?.value === next && f.reads.slice(start).some(r => r.path === '/health' && r.tenant === next), 'Actual actor switch and fresh health'); await tick();
    }
    await t.test('admin without orders opens global return status settings and reads actual status list without a mutation', async () => {
      const f = fixture(), h = await mount(f);
      try {
        await navigate(h, 'Zwroty i reklamacje'); await until(() => h.container.textContent.includes('Brak spraw dla wybranych filtrów.'), 'Empty own return queue');
        const opener = button(h, 'Statusy pozycji zwrotu — ustawienia'); assert.equal(opener.getAttribute('aria-expanded'), 'false');
        assert.ok(!f.reads.some(r => r.path.startsWith('/return-assistant/statuses')), 'Global settings remain closed until explicit open');
        await click(opener); await until(() => h.container.querySelector('.return-destination-statuses select[aria-label="Status pozycji zwrotu"]') && !button(h, 'Odczytaj statusy pozycji zwrotu').matches(':disabled'), 'Actual global settings options loaded');
        await click(button(h, 'Odczytaj statusy pozycji zwrotu')); await until(() => [...h.container.querySelectorAll('select[aria-label="Status pozycji zwrotu"] option')].some(o => o.value === id(90) && o.textContent.includes('Własny status bez zamówienia')), 'Actual status list loaded');
        assert.ok(f.reads.some(r => r.path === '/return-assistant/statuses/options' && r.tenant === tenant)); assert.ok(f.reads.some(r => r.path === '/return-assistant/statuses?limit=50' && r.tenant === tenant));
        assert.ok(!f.reads.some(r => r.path.startsWith('/orders') && r.path !== '/orders/status-counts'), 'No order dependency (the dashboard stage counters are not part of the return settings)'); assert.equal(f.writes.length, 0); assert.equal(f.authWrites.length, 0); assert.deepEqual(f.unexpected, []);
      } finally { await h.close(); }
    });
    await t.test('inventory navigation shows separated stock, preserves pending through unmount, own exact retry is reachable', async () => {
      const f = fixture(), h = await mount(f);
      try {
        await unknown(h, f); await until(() => h.container.textContent.includes('Własny fizyczny zapas App'), 'Real InventoryPanel row'); assert.ok(h.container.textContent.includes('Fizycznie dostępne')); assert.ok(h.container.textContent.includes('Dostępne do sprzedaży'));
        const first = f.writes[0]; await navigate(h, 'Przegląd'); assert.equal(h.container.querySelector('.warehouse-inventory-policies'), null); assert.ok(ui.warehouseInventoryPoliciesWriteLocked(scope)); await policies(h);
        await click(button(h, 'Odczytaj historię polityk')); await until(() => !button(h, 'Ponów dokładną próbę polityki magazynu').matches(':disabled'), 'History only read'); assert.ok(ui.warehouseInventoryPoliciesWriteLocked(scope)); assert.equal(f.writes.length, 1, 'GET/remount never POST');
        f.lost = false; await click(button(h, 'Ponów dokładną próbę polityki magazynu')); await until(() => !ui.warehouseInventoryPoliciesWriteLocked(scope) && h.container.textContent.includes('Pełny zapisany podgląd polityki'), 'Validated own exact retry'); assert.equal(f.writes.length, 2); assert.equal(f.writes[1].raw, first.raw); assert.equal(f.writes[1].path, first.path); assert.equal(f.receipts.size, 1); assert.deepEqual(f.unexpected, []);
      } finally { await h.close(); }
    });
    await t.test('global App reset purges closed-panel pending on actor/role replacement and does not resurrect on return', async () => {
      const f = fixture(), h = await mount(f);
      try {
        await unknown(h, f); await navigate(h, 'Przegląd'); await switchWorkspace(h, f, id(3)); assert.equal(ui.warehouseInventoryPoliciesWriteLocked(scope), false, 'Reset works while policy panel is absent'); await navigate(h, 'Magazyny'); assert.equal(h.container.querySelector('.warehouse-inventory-policies'), null, 'Current App mounts this admin config only for admin');
        await switchWorkspace(h, f, tenant); await policies(h); assert.ok(!h.container.textContent.includes('Ponów dokładną próbę polityki magazynu')); assert.equal(f.writes.length, 1); assert.deepEqual(f.unexpected, []);
      } finally { await h.close(); }
    });
    await t.test('restore context purges old attempt, keeps admin policy inspection and disables mutation', async () => {
      const f = fixture(), h = await mount(f);
      try {
        await unknown(h, f); await navigate(h, 'Przegląd'); await switchWorkspace(h, f, id(6)); await until(() => h.container.textContent.includes('Kopia odtworzona · tylko odczyt'), 'Real restore banner'); assert.equal(ui.warehouseInventoryPoliciesWriteLocked(scope), false); await policies(h);
        await select(field(h, 'Magazyn polityki'), warehouse.id); assert.equal(button(h, 'Przygotuj podgląd polityki magazynu').matches(':disabled'), true); assert.ok(h.container.textContent.includes('Polityki magazynów są dostępne tylko do odczytu.')); assert.ok(!h.container.textContent.includes('Ponów dokładną próbę polityki magazynu'));
        await click(button(h, 'Odczytaj historię polityk')); await until(() => !button(h, 'Odczytaj historię polityk').matches(':disabled'), 'Readonly history'); assert.equal(f.writes.length, 1); assert.deepEqual(f.unexpected, []);
      } finally { await h.close(); }
    });
    await t.test('logout while panel is closed purges actor RAM; actual login cannot resurrect the request', async () => {
      const f = fixture(), h = await mount(f);
      try {
        await unknown(h, f); await navigate(h, 'Przegląd'); await click(h.container.querySelector('button[title="Wyloguj"]')); await until(() => h.container.querySelector('input[name="email"]') && !ui.warehouseInventoryPoliciesWriteLocked(scope), 'Actual logout and global reset');
        const form = h.container.querySelector('input[name="email"]').closest('form'); await act(async () => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))); await until(() => h.container.querySelector('.sidebar nav'), 'Actual controlled login'); await policies(h);
        assert.ok(!h.container.textContent.includes('Ponów dokładną próbę polityki magazynu')); assert.equal(f.writes.length, 1); assert.equal(f.authWrites.filter(w => w.path === '/auth/logout').length, 1); assert.equal(f.authWrites.filter(w => w.path === '/auth/login').length, 1); assert.deepEqual(f.unexpected, []);
      } finally { await h.close(); }
    });
    const returnsUI = await vite.ssrLoadModule(path.resolve('web/returns.tsx'));
    const statusesUI = await vite.ssrLoadModule(path.resolve('web/return-destination-statuses.tsx'));
    const legacy = await vite.ssrLoadModule(path.resolve('web/b2b-dropshipping-returns.tsx'));
    const legacyContext = `${tenant}:${user}:admin`;
    const order = { id: id(70), version: 1, status: 'shipped', currency: 'PLN', documents: [], wms_lots_enabled: false,
      items: [{ id: id(71), sku: 'OWN-RMA', name: 'Własna pozycja', quantity: 3, price: 1000, vat: 23, line_total: 3000 }],
      returns: { items: [{ id: id(71), sku: 'OWN-RMA', name: 'Własna pozycja', quantity: 3, returned: 0, available: 3 }], cases: [], refund_total: 0, settled_total: 0, shipping_available: 0, meta: { cursor: null } } };
    async function mountReturns(f) {
      globalThis.fetch = f; api.setWorkspace(tenant); statusesUI.resetReturnDestinationStatusesContext(''); statusesUI.resetReturnDestinationStatusesContext(scope); ui.resetWarehouseInventoryPoliciesContext(''); ui.resetWarehouseInventoryPoliciesContext(scope); legacy.resetDropshipReturnContext(legacyContext, false);
      const container = document.createElement('div'); document.body.append(container); const root = createRoot(container), h = { container, props: { order, contextKey: legacyContext, readOnly: false, write: true, onChanged: () => {} }, async render(p = {}) { h.props = { ...h.props, ...p }; await act(async () => root.render(React.createElement(returnsUI.ReturnsPanel, h.props))); }, async close() { await act(async () => root.unmount()); container.remove(); } }; mounts.push(h); await h.render(); return h;
    }
    await t.test('actual ReturnsPanel status unknown blocks fresh RMA while its panel is closed; own147 exact retry stays reachable', async () => {
      const writes = [], flags = { available: true, read_only: false, current_role: 'admin', can_read: true, can_manage: true, intake_available: false }; let lost = true, reply;
      const h = await mountReturns(async (url, init = {}) => {
        const p = new URL(String(url), 'http://127.0.0.1').pathname;
        if (init.method === 'GET') {
          if (p === '/api/auth/me') return Response.json({ user: { tenant_id: tenant, id: user, role: 'admin' } });
          if (p === '/api/return-assistant/statuses/options') return Response.json({ ...flags, warehouses: [warehouse], limits: {} });
        } else if (p === '/api/return-assistant/statuses/previews') {
          const b = JSON.parse(init.body); writes.push({ raw: init.body, path: p });
          if (!reply) reply = { ...flags, reused: false, preview: { id: id(80), kind: 'create', status_id: id(81), request: b, scope_hash: sha, before: null, after: { id: id(81), version: '1', settings: b.settings }, resources: { warehouse: null }, ready: true, can_commit: true, operation_id: null, created_at: '2026-10-07T12:00:00Z', expires_at: new Date(Date.now() + 900000).toISOString() } };
          if (lost) throw TypeError('Controlled status lost ACK'); return Response.json({ ...reply, reused: true });
        }
        throw Error('Unexpected Returns settings request ' + p);
      });
      try {
        await click(button(h, 'Statusy pozycji zwrotu — ustawienia')); await until(() => h.container.querySelector('select[aria-label="Status pozycji zwrotu"]'), 'Real147 settings caller'); await select(field(h, 'Status pozycji'), 'new');
        const name = h.container.querySelector('input[aria-label="Nazwa statusu zwrotu"]'); await act(async () => { Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(name, 'Odrzucenie App'); name.dispatchEvent(new Event('input', { bubbles: true })); }); await select(field(h, 'Decyzja o sztukach'), 'reject'); await click(button(h, 'Przygotuj podgląd statusu zwrotu'));
        await until(() => h.container.textContent.includes('Controlled status lost ACK'), 'Unknown147 receipt'); assert.equal(statusesUI.returnDestinationStatusesWriteLocked(scope), true); assert.equal(button(h, 'Nowa sprawa zwrotowa').matches(':disabled'), true);
        await click(button(h, 'Zamknij ustawienia statusów zwrotu')); assert.equal(h.container.querySelector('.return-destination-statuses'), null); assert.equal(button(h, 'Nowa sprawa zwrotowa').matches(':disabled'), true, 'Subscription is independent of inner settings mount');
        await click(button(h, 'Statusy pozycji zwrotu — ustawienia')); await until(() => !button(h, 'Ponów dokładną próbę ustawień zwrotu').matches(':disabled'), 'Own147 retry without self lock'); lost = false; await click(button(h, 'Ponów dokładną próbę ustawień zwrotu')); await until(() => !statusesUI.returnDestinationStatusesWriteLocked(scope), 'Validated147 exact replay');
        assert.equal(writes.length, 2); assert.equal(writes[0].raw, writes[1].raw); assert.equal(writes[0].path, writes[1].path); assert.equal(button(h, 'Nowa sprawa zwrotowa').matches(':disabled'), false);
      } finally { await h.close(); }
    });
    await t.test('latest foreign block rejects synthetic fresh RMA submit but preserved own ordinary retry can bypass it', async () => {
      const writes = []; let lost = true;
      const h = await mountReturns(async (url, init = {}) => { assert.equal(url, '/api/orders/' + order.id + '/returns'); assert.equal(init.method, 'POST'); writes.push(init.body); if (lost) throw TypeError('Controlled ordinary RMA lost ACK'); return Response.json({ id: id(90), reused: true }); });
      try {
        await click(button(h, 'Nowa sprawa zwrotowa')); const form = h.container.querySelector('.return-form'); form.querySelector('textarea[name="reason"]').value = 'Własny zwrot jednej sztuki'; form.querySelector('input[name="qty-' + id(71) + '"]').value = '1';
        await h.render({ externalWriteBlocked: true }); assert.equal(button(h, 'Zapisz zgłoszenie').matches(':disabled'), true); await act(async () => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))); assert.equal(writes.length, 0);
        await h.render({ externalWriteBlocked: false }); await act(async () => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))); await until(() => h.container.textContent.includes('Controlled ordinary RMA lost ACK'), 'Own legacy attempt retained');
        await h.render({ externalWriteBlocked: true }); assert.equal(button(h, 'Ponów dokładną próbę sprawy').matches(':disabled'), false); lost = false; await click(button(h, 'Ponów dokładną próbę sprawy')); await until(() => writes.length === 2 && !h.container.textContent.includes('Ponów dokładną próbę sprawy'), 'Validated ordinary exact retry'); assert.equal(writes[0], writes[1]);
      } finally { await h.close(); }
    });
  } finally {
    try { for (const h of mounts) if (h.container.isConnected) await h.close(); }
    finally { if (vite) await vite.close(); dom.window.HTMLElement.prototype.scrollIntoView = oldScroll; globalThis.fetch = savedFetch; dom.window.close(); for (const [k, d] of saved) if (d) Object.defineProperty(globalThis, k, d); else delete globalThis[k]; }
  }
});
