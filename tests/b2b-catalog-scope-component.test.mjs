import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { webcrypto } from 'node:crypto';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

// Actual ReactDOM consumer of planned WIRE159, controlled HTTP only.
// NOT_ROUTED / NOT_MOUNTED in the application / NOT_EXECUTED by the author.
const id = n => `${n.toString(16).padStart(8, '0')}-1590-4159-8159-159159159159`;
const tenant = id(1), user = id(2), context = `${tenant}:${user}:admin:false`, entityId = id(5), digest = 'a'.repeat(64);
const stamp = '2026-10-07T09:00:00.000Z';
const flags = { available: true, read_only: false, current_role: 'admin', can_read: true, can_manage: true, can_read_inventory: true };
const capabilities = { protocol: 'catalog_scope_v1', first_configuration_only: true, publication_available: false, import_available: false };
const catalog = (n, wh, list, name) => ({ id: id(n), name, version: '1', active: true, is_default: n === 10, languages: ['pl', 'en'], default_language: 'pl', warehouse_ids: [id(wh)], price_list_ids: [id(list)] });
function fixture(side = 'supplier') {
  const f = { side, tenant, user, flags: { ...flags }, writes: [], reads: [], receipts: new Map(), lost: false, malformed: false, status: 0, heldSource: null, sourceCalls: 0, entityVersion: '1', scope: null };
  f.catalogs = [catalog(10, 20, 30, 'Domyślny'), catalog(11, 21, 31, 'Osobny')];
  f.resources = { catalogs: f.catalogs, warehouses: [{ id: id(20), name: 'MAIN', code: 'MAIN' }, { id: id(21), name: 'SECOND', code: 'SECOND' }], price_lists: [{ id: id(30), name: 'PLN oferta', currency: 'PLN', version: '1', active: true }, { id: id(31), name: 'EUR oferta', currency: 'EUR', version: '2', active: true }], languages: ['pl', 'en'] };
  f.entity = () => side === 'supplier' ? { id: entityId, name: 'Własne konto', version: f.entityVersion, active: true, warehouse_id: f.scope?.warehouse_id ?? id(20), price_list_id: f.scope?.price_list_id ?? id(30) } : { id: entityId, version: f.entityVersion, supplier_name: 'Partner', account_id: id(6), paused: true, schedule_minutes: 30 };
  f.project = value => {
    const v = structuredClone(value);
    if (f.flags.can_read_inventory) return v;
    for (const c of v.resources?.catalogs ?? []) c.warehouse_ids = [];
    if (v.resources?.warehouses) v.resources.warehouses = [];
    if (v.source?.account) v.source.account.warehouse_id = null;
    for (const scope of [v.scope, v.source?.scope, v.operation?.scope]) if (scope?.kind === 'supplier') scope.warehouse_id = null;
    for (const p of [v.preview, v.operation]) {
      if (!p) continue;
      p.snapshot.catalog.warehouse_ids = [];
      if (side === 'supplier') {
        p.snapshot.before.warehouse_id = null; p.snapshot.resources.warehouse = null;
        if (p.before) p.before.warehouse_id = null;
        if (p.after) p.after.warehouse_id = null;
        if (p.request?.warehouse_id) p.request.warehouse_id = null;
        if ('can_commit' in p) p.can_commit = false;
      }
    }
    return v;
  };
  f.options = () => f.project({ ...f.flags, source: { kind: side, entity_id: entityId, [side === 'supplier' ? 'account' : 'link']: f.entity(), scope: f.scope }, scope: f.scope, resources: structuredClone(f.resources), capabilities, can_preview: f.flags.can_manage && !f.flags.read_only && !f.scope });
  f.entityPath = side === 'supplier' ? `/b2b/accounts/${entityId}/catalog-scope` : `/b2b/network/links/${entityId}/catalog-scope`;
  f.fetch = async (url, init = {}) => {
    const u = new URL(String(url), 'http://127.0.0.1'), route = u.pathname.replace(/^\/api/, ''), method = init.method ?? 'GET';
    if (method === 'GET') {
      f.reads.push(route + u.search);
      if (route === '/auth/me') return Response.json({ user: { tenant_id: f.tenant, id: f.user, role: f.flags.current_role } });
      if (route === f.entityPath) { f.sourceCalls++; if (f.heldSource) return f.heldSource; return Response.json(f.options()); }
      if (route === f.entityPath + '/history') return Response.json({ ...f.flags, data: f.operation ? [{ id: f.operation.id, preview_id: f.operation.preview_id, kind: side, entity_id: entityId, scope_hash: digest, created_at: stamp }] : [], next_cursor: null });
      if (route === '/b2b/catalog-scope/operations/' + id(41)) return Response.json(f.project({ ...f.flags, operation: f.operation }));
      if (route === '/b2b/catalog-scope/previews/' + id(40)) return Response.json(f.project({ ...f.flags, preview: f.preview }));
      throw Error('Unexpected controlled GET ' + route);
    }
    assert.equal(method, 'POST');
    const body = JSON.parse(init.body); f.writes.push({ path: route, raw: init.body, body });
    if (f.status) return Response.json({ detail: 'Controlled known HTTP status' }, { status: f.status });
    let d = f.receipts.get(body.client_key);
    if (d) d = { ...structuredClone(d), reused: true };
    else if (route === f.entityPath + '/previews') {
      const c = f.catalogs.find(c => c.id === (body.catalog_id ?? body.target_catalog_id)); assert.ok(c);
      const before = side === 'supplier' ? { id: entityId, version: f.entityVersion, warehouse_id: id(20), price_list_id: id(30), active: true } : { id: entityId, version: f.entityVersion, account_id: id(6), paused: true, schedule_minutes: 30 };
      const resources = side === 'supplier' ? { warehouse: f.resources.warehouses.find(w => w.id === body.warehouse_id), price_list: { id: body.price_list_id, version: '2', currency: 'EUR', active: true }, language: body.language } : { supplier: { name: 'Partner', account_id: id(6) } };
      f.preview = { id: id(40), kind: side, entity_id: entityId, catalog_id: c.id, request: structuredClone(body), scope_hash: digest, snapshot: { protocol: 'catalog_scope_v1', kind: side, entity_id: entityId, before, catalog: structuredClone(c), resources, scope_before: null }, ready: true, created_at: stamp, expires_at: new Date(Date.now() + 900000).toISOString(), committed_operation_id: null, can_commit: true };
      d = { ...f.flags, preview: structuredClone(f.preview), reused: false }; f.receipts.set(body.client_key, structuredClone(d));
    } else if (route === '/b2b/catalog-scope/previews/' + id(40) + '/commit') {
      const s = f.preview.snapshot, after = side === 'supplier' ? { ...s.before, version: '2', warehouse_id: s.resources.warehouse.id, price_list_id: s.resources.price_list.id } : { ...s.before, version: '2' };
      f.scope = { protocol: 'catalog_scope_v1', kind: side, ...(side === 'supplier' ? { account_id: entityId, catalog_id: s.catalog.id, warehouse_id: s.resources.warehouse.id, price_list_id: s.resources.price_list.id, language: s.resources.language } : { link_id: entityId, target_catalog_id: s.catalog.id }), version: '1', operation_id: id(41), created_at: stamp };
      f.entityVersion = '2'; f.operation = { id: id(41), preview_id: f.preview.id, kind: side, entity_id: entityId, scope_hash: digest, request: structuredClone(body), snapshot: structuredClone(s), before: s.before, after, scope: structuredClone(f.scope), created_at: stamp };
      d = { ...f.flags, operation: structuredClone(f.operation), scope: structuredClone(f.scope), reused: false }; f.receipts.set(body.client_key, structuredClone(d));
    } else throw Error('Unexpected controlled POST ' + route);
    if (f.lost) throw TypeError('Controlled lost ACK');
    if (f.malformed) { d = structuredClone(d); if (d.operation) d.operation.after.version = '1'; else delete d.preview.scope_hash; }
    return Response.json(d, { status: 201 });
  };
  return f;
}
async function tick() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); }
async function until(fn, note) { for (let i = 0; i < 100; i++) { if (fn()) return; await tick(); } assert.ok(fn(), note); }
function button(h, text) { const b = [...h.container.querySelectorAll('button')].find(b => b.textContent === text); assert.ok(b, text); return b; }
function select(h, label) { const s = h.container.querySelector(`select[aria-label="${label}"]`); assert.ok(s, label); return s; }
async function value(el, text) { await act(async () => { Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set.call(el, text); el.dispatchEvent(new Event('change', { bubbles: true })); }); }
async function click(el) { assert.equal(el.disabled, false); assert.equal(el.closest('fieldset')?.disabled ?? false, false); await act(async () => el.dispatchEvent(new MouseEvent('click', { bubbles: true }))); }

test('B2B first catalog scope actual mounted consumer — controlled HTTP only', async t => {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://127.0.0.1/' }), descriptors = new Map(), savedFetch = globalThis.fetch;
  for (const [k, v] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, Event: dom.window.Event, MouseEvent: dom.window.MouseEvent, FormData: dom.window.FormData, crypto: webcrypto, IS_REACT_ACT_ENVIRONMENT: true })) { descriptors.set(k, Object.getOwnPropertyDescriptor(globalThis, k)); Object.defineProperty(globalThis, k, { configurable: true, writable: true, value: v }); }
  const vite = await createServer({ server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: 'custom', logLevel: 'error' });
  const { createRoot } = await import('react-dom/client'), ui = await vite.ssrLoadModule(path.resolve('web/b2b-catalog-scope.tsx')), api = await vite.ssrLoadModule(path.resolve('web/api.ts'));
  const mounted = [];
  async function mountConsumer(Component, props) {
    const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
    const h = { container, props, async render(patch = {}) { h.props = { ...h.props, ...patch }; await act(async () => root.render(React.createElement(Component, h.props))); }, async close() { await act(async () => root.unmount()); container.remove(); } }; mounted.push(h); await h.render(); return h;
  }
  function reset(f) { globalThis.fetch = f.fetch; api.setWorkspace(f.tenant); ui.resetB2bCatalogScopeContext(''); ui.resetB2bCatalogScopeContext(context); }
  async function mount(f, extra = {}) {
    const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
    const h = { container, props: { contextKey: context, readOnly: false, kind: f.side, entityId, ...extra }, async render(patch = {}) { h.props = { ...h.props, ...patch }; await act(async () => root.render(React.createElement(ui.B2bCatalogScopePanel, h.props))); }, async close() { await act(async () => root.unmount()); container.remove(); } };
    mounted.push(h); await h.render(); return h;
  }
  async function ready(h) { await until(() => h.container.querySelector('select[aria-label="Katalog dostawcy"],select[aria-label="Katalog docelowy"]'), 'full source'); }
  async function configured(h, f) { await ready(h); await value(select(h, f.side === 'supplier' ? 'Katalog dostawcy' : 'Katalog docelowy'), id(11)); if (f.side === 'supplier') { await value(select(h, 'Magazyn dostępności'), id(21)); await value(select(h, 'Cennik oferty'), id(31)); await value(select(h, 'Język oferty'), 'en'); } }
  async function preview(h, f) { await configured(h, f); await click(button(h, 'Przygotuj podgląd zakresu B2B')); await until(() => h.container.textContent.includes('Podgląd zakresu do zapisania') && !ui.b2bCatalogScopeWriteLocked(context), 'durable preview'); }
  async function consent(h) { const c = h.container.querySelector('.pc-check input'); assert.ok(c); await click(c); }
  try {
    await t.test('installed publication/import boolean capabilities permit explicit configuration without automatic writes', async () => {
      const f = fixture(), options = f.options;
      f.options = () => ({ ...options(), capabilities: { ...capabilities, publication_available: true, import_available: true } });
      reset(f); const h = await mount(f);
      await configured(h, f); assert.equal(f.writes.length, 0, 'Available consumer flags do not start publication or import');
      await click(button(h, 'Przygotuj podgląd zakresu B2B'));
      await until(() => h.container.textContent.includes('Podgląd zakresu do zapisania') && !ui.b2bCatalogScopeWriteLocked(context), 'True capability booleans remain valid');
      assert.equal(f.writes.length, 1); assert.equal(f.writes[0].path, f.entityPath + '/previews'); await h.close();
    });
    await t.test('supplier explicit assigned resources, cleared selection, separate consent and immutable history', async () => {
      const f = fixture(); reset(f); const h = await mount(f); await configured(h, f);
      assert.deepEqual([...select(h, 'Magazyn dostępności').options].map(o => o.value), ['', id(21)]);
      await value(select(h, 'Katalog dostawcy'), id(10)); assert.equal(select(h, 'Magazyn dostępności').value, ''); assert.equal(select(h, 'Cennik oferty').value, ''); assert.equal(select(h, 'Język oferty').value, '');
      await preview(h, f); assert.equal(f.writes.length, 1); assert.equal(f.writes[0].body.catalog_id, id(11)); assert.equal(f.writes[0].body.account_version, '1'); assert.equal(f.writes[0].body.warehouse_id, id(21));
      assert.equal(button(h, 'Zapisz zatwierdzony zakres B2B').disabled, true); assert.ok(h.container.textContent.includes('SECOND')); await consent(h); await click(button(h, 'Zapisz zatwierdzony zakres B2B'));
      await until(() => h.container.textContent.includes('Konfiguracja B2B zapisana'), 'actual receipt'); assert.equal(f.writes.length, 2); assert.equal(f.scope.version, '1'); assert.equal(f.entityVersion, '2');
      await click(button(h, 'Odczytaj historię zakresu B2B')); await until(() => h.container.textContent.includes('Otwórz pełny zapis'), 'headers'); await click([...h.container.querySelectorAll('button')].find(b => b.textContent.startsWith('Otwórz pełny zapis'))); assert.equal(f.writes.length, 2); await h.close();
    });
    await t.test('buyer creates target scope while preserving paused and scheduling values', async () => {
      const f = fixture('buyer'); reset(f); const h = await mount(f); await preview(h, f); assert.deepEqual(Object.keys(f.writes[0].body).sort(), ['client_key', 'link_version', 'target_catalog_id', 'target_catalog_version']); await consent(h); await click(button(h, 'Zapisz zatwierdzony zakres B2B')); await until(() => h.container.textContent.includes('Konfiguracja B2B zapisana'), 'buyer saved'); assert.equal(f.operation.after.paused, true); assert.equal(f.operation.after.schedule_minutes, 30); assert.equal(f.scope.target_catalog_id, id(11)); await h.close();
    });
    await t.test('lost committed ACK and malformed replay retain exact request across unmount and history; sibling block permits own replay', async () => {
      const f = fixture(); reset(f); const h = await mount(f); await preview(h, f); await consent(h); f.lost = true; await click(button(h, 'Zapisz zatwierdzony zakres B2B')); await until(() => h.container.textContent.includes('Ponów dokładną próbę'), 'lost receipt retained'); const first = f.writes[1]; await h.close(); f.lost = false; f.malformed = true;
      const next = await mount(f, { externalWriteBlocked: true }); await until(() => next.container.textContent.includes('Zapisane przypisanie'), 'current source hydrated'); assert.ok(ui.b2bCatalogScopeWriteLocked(context)); await click(button(next, 'Odczytaj historię zakresu B2B')); assert.ok(ui.b2bCatalogScopeWriteLocked(context)); await click(button(next, 'Ponów dokładną próbę zakresu B2B')); assert.ok(ui.b2bCatalogScopeWriteLocked(context)); assert.equal(f.writes[2].raw, first.raw);
      f.malformed = false; await click(button(next, 'Ponów dokładną próbę zakresu B2B')); await until(() => !ui.b2bCatalogScopeWriteLocked(context), 'exact replay'); assert.equal(f.writes[3].raw, first.raw); assert.equal(f.writes[3].path, first.path); assert.equal(f.receipts.size, 2); await next.close();
    });
    await t.test('408 and 429 retain exact preview; capability unavailable denies replay until explicit refresh', async () => {
      const f = fixture(); reset(f); const h = await mount(f); await configured(h, f); f.status = 408; await click(button(h, 'Przygotuj podgląd zakresu B2B')); await until(() => h.container.textContent.includes('Ponów dokładną próbę'), '408 retained'); const first = f.writes[0]; f.status = 429; await click(button(h, 'Ponów dokładną próbę zakresu B2B')); assert.ok(ui.b2bCatalogScopeWriteLocked(context));
      f.flags.available = false; f.status = 0; await click(button(h, 'Ponów dokładną próbę zakresu B2B')); assert.equal(f.writes.length, 2); assert.ok(ui.b2bCatalogScopeWriteLocked(context)); f.flags.available = true; await click(button(h, 'Odczytaj konfigurację B2B')); await click(button(h, 'Ponów dokładną próbę zakresu B2B')); await until(() => !ui.b2bCatalogScopeWriteLocked(context), 'exact restored read'); assert.equal(f.writes[1].raw, first.raw); assert.equal(f.writes[2].raw, first.raw); await h.close();
    });
    await t.test('late old actor read is ignored; new readonly actor cannot POST', async () => {
      const f = fixture(); reset(f); let release; f.heldSource = new Promise(r => { release = r; }); const h = await mount(f); await until(() => f.sourceCalls === 1, 'old read held');
      f.heldSource = null; f.tenant = id(3); f.flags.current_role = 'viewer'; f.flags.can_manage = false; f.flags.read_only = true; const next = `${f.tenant}:${user}:viewer:true`; api.setWorkspace(f.tenant); await h.render({ contextKey: next, readOnly: true }); await until(() => h.container.textContent.includes('Konfiguracja jest dostępna tylko do odczytu.'), 'new actor');
      const old = f.options(); old.flags = flags; old.resources.catalogs[0].name = 'SECRET OLD ACTOR'; await act(async () => { release(Response.json(old)); await Promise.resolve(); }); await tick(); assert.ok(!h.container.textContent.includes('SECRET OLD ACTOR')); assert.equal(button(h, 'Przygotuj podgląd zakresu B2B').disabled, true); assert.equal(f.writes.length, 0); await h.close();
    });
    await t.test('genuine sibling block arriving during preflight prevents fresh POST', async () => {
      const f = fixture(); reset(f); const h = await mount(f); await configured(h, f); let release; f.heldSource = new Promise(r => { release = r; }); const prior = f.sourceCalls;
      await click(button(h, 'Przygotuj podgląd zakresu B2B')); await until(() => f.sourceCalls > prior, 'fresh preflight held'); await h.render({ externalWriteBlocked: true }); const raw = f.options(); await act(async () => { release(Response.json(raw)); await Promise.resolve(); }); await until(() => !ui.b2bCatalogScopeWriteLocked(context), 'denied before POST'); assert.equal(f.writes.length, 0); assert.ok(h.container.textContent.includes('Inna operacja blokuje')); await h.close();
    });
    await t.test('inventory access loss clears prior full result and reads redacted immutable history without inventing warehouse data', async () => {
      const f = fixture(); reset(f); const h = await mount(f); await preview(h, f); await consent(h); await click(button(h, 'Zapisz zatwierdzony zakres B2B')); await until(() => h.container.textContent.includes('Konfiguracja B2B zapisana') && !ui.b2bCatalogScopeWriteLocked(context), 'full operation');
      f.flags.can_read_inventory = false; f.flags.can_manage = false; await click(button(h, 'Odczytaj konfigurację B2B')); assert.ok(!h.container.textContent.includes('SECOND')); assert.ok(!h.container.textContent.includes(id(21)));
      await click(button(h, 'Odczytaj wynik pierwszej konfiguracji')); await until(() => h.container.textContent.includes('Dane magazynu niedostępne przy tym uprawnieniu.'), 'redacted saved result'); assert.ok(!h.container.textContent.includes(id(21))); assert.equal(f.writes.length, 2); await h.close();
    });
    await t.test('closing during held fresh preflight cancels unsent write rather than silently POST after unmount', async () => {
      const f = fixture(); reset(f); const h = await mount(f); await configured(h, f); let release; f.heldSource = new Promise(r => { release = r; }); const prior = f.sourceCalls;
      await click(button(h, 'Przygotuj podgląd zakresu B2B')); await until(() => f.sourceCalls > prior, 'preflight held'); await h.close(); await act(async () => { release(Response.json(f.options())); await Promise.resolve(); }); await until(() => !ui.b2bCatalogScopeWriteLocked(context), 'unsent write released'); assert.equal(f.writes.length, 0);
    });
    await t.test('actual supplier account caller opens configuration with the canonical actor and explicit account id', async () => {
      const f = fixture(); reset(f); const legacy = `${tenant}:${user}:admin`;
      const returns = await vite.ssrLoadModule(path.resolve('web/b2b-dropshipping-returns.tsx')); returns.resetDropshipReturnContext(legacy, false);
      const { B2bPanel } = await vite.ssrLoadModule(path.resolve('web/b2b.tsx')); const original = f.fetch;
      globalThis.fetch = async (url, init = {}) => { const p = new URL(String(url), 'http://127.0.0.1').pathname;
        if (p === '/api/b2b/accounts') return Response.json({ data: [{ ...f.entity(), email: 'own@example.invalid', min_quantity: 1, quantity_step: 1 }], next: null });
        if (p === '/api/warehouses') return Response.json({ data: f.resources.warehouses });
        return original(url, init);
      };
      const h = await mountConsumer(B2bPanel, { admin: true, contextKey: legacy, catalogContextKey: context, readOnly: false }); await until(() => h.container.textContent.includes('Zakres katalogu B2B'), 'account loaded'); await click(button(h, 'Zakres katalogu B2B')); await until(() => h.container.querySelector('select[aria-label="Katalog dostawcy"]'), 'mounted actual supplier scope'); assert.equal(f.writes.length, 0); assert.ok(f.reads.includes(f.entityPath)); await h.close();
    });
    await t.test('actual buyer link caller opens target configuration while sibling block leaves reads available', async () => {
      const f = fixture('buyer'); reset(f); const { B2bNetwork } = await vite.ssrLoadModule(path.resolve('web/b2b-network.tsx')); const original = f.fetch;
      globalThis.fetch = async (url, init = {}) => { const p = new URL(String(url), 'http://127.0.0.1').pathname;
        if (p === '/api/b2b/network/links') return Response.json({ data: [f.entity()], next: null, currency: 'PLN' });
        if (p === '/api/b2b/accounts') return Response.json({ data: [], next: null });
        if (p === '/api/warehouses') return Response.json({ data: f.resources.warehouses });
        if (p === `/api/b2b/network/links/${entityId}/runs` || p === `/api/b2b/network/links/${entityId}/orders`) return Response.json({ data: [], next: null });
        if (p === `/api/b2b/network/links/${entityId}/dropshipping/options`) return Response.json({ available: false, read_only: false, current_role: 'admin', can_manage: false, can_read: true, can_read_value: false });
        return original(url, init);
      };
      const h = await mountConsumer(B2bNetwork, { admin: true, contextKey: `${tenant}:${user}:admin`, catalogContextKey: context, readOnly: false, externalWriteBlocked: true });
      await until(() => [...h.container.querySelectorAll('select option')].some(o => o.value === entityId), 'persisted link choices');
      const choice = [...h.container.querySelectorAll('label')].find(l => l.textContent.startsWith('Wybierz połączenie')).querySelector('select'); await value(choice, entityId);
      await click(button(h, 'Zakres katalogu odbiorcy B2B')); await until(() => h.container.querySelector('select[aria-label="Katalog docelowy"]'), 'actual mounted buyer scope'); assert.equal(button(h, 'Przygotuj podgląd zakresu B2B').disabled, true); assert.equal(button(h, 'Odczytaj konfigurację B2B').disabled, false); assert.equal(f.writes.length, 0); await h.close();
    });
    await t.test('actual purchase quote rechecks external blocking after held parent auth preflight without posting', async () => {
      const f = fixture(); reset(f); const { B2bNetworkOrders } = await vite.ssrLoadModule(path.resolve('web/b2b-network-orders.tsx'));
      let release, authStarted = false, blocked = false; const original = f.fetch;
      globalThis.fetch = async (url, init = {}) => { const p = new URL(String(url), 'http://127.0.0.1').pathname;
        if (p === `/api/b2b/network/links/${entityId}/orders`) return Response.json({ data: [], next: null });
        if (p === '/api/auth/me') { authStarted = true; return new Promise(r => { release = r; }); }
        return original(url, init);
      };
      const guard = ui.b2bCatalogSiblingWriteGuard(context, () => !blocked);
      const h = await mountConsumer(B2bNetworkOrders, { link: { id: entityId, paused: false }, warehouses: f.resources.warehouses, cart: [{ id: id(51), snapshot: { name: 'Own item', sku: 'OWN', price: 1000, currency: 'PLN', available: 5 }, quantity: 1 }], setCart: () => {}, admin: true, readOnly: false, guardFreshWrite: guard });
      const form = h.container.querySelector('form'); assert.ok(form); await act(async () => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))); await until(() => authStarted, 'auth held before quote'); blocked = true; await h.render({ externalWriteBlocked: true }); await act(async () => { release(Response.json({ user: { tenant_id: tenant, id: user, role: 'admin' } })); await Promise.resolve(); }); await until(() => h.container.textContent.includes('blokuje') || h.container.textContent.includes('wstrzymany'), 'new lock rejected'); assert.equal(f.writes.length, 0); await h.close();
    });
  } finally {
    for (const h of mounted) if (h.container.isConnected) await h.close(); await vite.close(); dom.window.close(); globalThis.fetch = savedFetch;
    for (const [k, descriptor] of descriptors) { if (descriptor) Object.defineProperty(globalThis, k, descriptor); else delete globalThis[k]; }
  }
});
