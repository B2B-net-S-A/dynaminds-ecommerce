import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { webcrypto } from 'node:crypto';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

// Mounted production panel with controlled HTTP. No native BO/SQL proof.
const id = n => `${String(n).padStart(8, '0')}-1690-4169-8169-169169169169`;
const tenant = id(1), user = id(2), catalog = id(10), scope = `${tenant}:${user}:admin:false`;
const sha = 'a'.repeat(64), instant = '2026-10-07T12:00:00.000000Z';
const flags = { available: true, activation_available: true, writers_available: true, can_read: true, can_manage: true, can_read_value: true, current_role: 'admin', read_only: false };
const sourceLabel = 'Odczytaj pełny stan katalogu do BO', prepareLabel = 'Przygotuj podgląd aktywacji i BO', commitLabel = 'Włącz ścisłą kontrolę i zapisz BO', retryLabel = 'Ponów dokładną próbę aktywacji';
const consentLabel = 'Sprawdziłem cały katalog i BO. Włączam ścisłą kontrolę bez zmiany ilości i bez możliwości jej wyłączenia w tym etapie.';
const valueKeys = new Set(['unit_cost_minor', 'value_minor', 'known_value_minor', 'known_quantity', 'zero_cost_quantity', 'unknown_quantity', 'currency', 'exponent', 'rows_sha256']);
function redact(v) { return Array.isArray(v) ? v.map(redact) : v !== null && typeof v === 'object' ? Object.fromEntries(Object.entries(v).filter(([k]) => !valueKeys.has(k)).map(([k, x]) => [k, redact(x)])) : v; }
function fixture({ count = 103, on = true } = {}) {
  const f = { tenant, user, flags: { ...flags }, reads: [], writes: [], previews: [], operations: [], results: new Map(), lost: false, forged: false, status: 0, heldAck: null, heldSource: null, heldGrant: null, heldRows: null, deniedSource: false };
  const warehouses = [
    { id: id(20), name: 'Sprzedaż własna', code: 'SALE', policy: { usage: 'sale', enabled: true, version: '0' }, series: { id: null, version: '0', name: 'Bilans otwarcia', prefix: 'BO' } },
    { id: id(21), name: 'Przechowanie własne', code: 'HOLD', policy: { usage: 'custody', enabled: true, version: '1' }, series: { id: null, version: '0', name: 'Bilans otwarcia', prefix: 'BO' } },
  ];
  f.rows = Array.from({ length: count }, (_, i) => ({ ordinal: i, warehouse_id: id(20), product_id: id(100 + (i < 2 ? 0 : i)), sku: i < 2 ? 'QA169-SAME-PRODUCT' : 'QA169-' + i, name: 'Zapisany produkt ' + (i < 2 ? 0 : i), location: 'A-' + i, quantity: 1, reserved: 0, stock_version: '7', bin_basis_hash: 'b'.repeat(64), layer_id: on ? id(300 + i) : null, lot_id: on ? id(500 + i) : null, position_version: on ? '2' : null, ...(on ? { unit_cost_minor: i === 0 ? '0' : i === 1 ? null : '9007199254740993', value_minor: i === 0 ? '0' : i === 1 ? null : '9007199254740993', currency: 'KWD', exponent: 3 } : {}) }));
  function summary(rows) { const qty = rows.reduce((s, r) => s + r.quantity, 0); return { physical_quantity: String(qty), reserved_quantity: '0', ...(on ? { known_quantity: String(rows.filter(r => r.unit_cost_minor !== null).length), zero_cost_quantity: String(rows.filter(r => r.unit_cost_minor === '0').length), unknown_quantity: String(rows.filter(r => r.unit_cost_minor === null).length), known_value_minor: rows.reduce((s, r) => s + BigInt(r.value_minor ?? '0'), 0n).toString(), currency: 'KWD', exponent: 3 } : {}) }; }
  f.snapshot = { catalog: { id: catalog, name: 'Katalog własny169', version: '3' }, policy: { catalog_id: catalog, version: '0', strict: false, operation_id: null }, warehouses, wms_enabled: on, row_count: count, summary: summary(f.rows), ...(on ? { rows_sha256: 'c'.repeat(64) } : {}) };
  f.source = () => ({ ...f.flags, source: { snapshot: structuredClone(f.snapshot), blockers: f.snapshot.policy.strict ? [{ code: 'ALREADY_STRICT', message: 'Katalog już ma ścisłą kontrolę.' }] : [], ready: !f.snapshot.policy.strict, can_preview: !f.snapshot.policy.strict && f.flags.can_manage } });
  f.project = d => f.flags.can_read_value ? d : redact(d);
  f.fetch = async (url, init = {}) => {
    const u = new URL(String(url), 'http://127.0.0.1'), p = u.pathname.replace(/^\/api/, ''), method = init.method ?? 'GET';
    if (method === 'GET') {
      f.reads.push(p + u.search);
      if (p === '/auth/me') return Response.json({ user: { tenant_id: f.tenant, id: f.user, role: f.flags.current_role } });
      if (p === '/product-catalogs/options') return Response.json({ available: true, can_read: true, catalogs: [{ id: catalog, name: f.snapshot.catalog.name, active: true }] });
      if (p === '/catalog-stock-control/history') {
        if (f.heldGrant && u.searchParams.get('limit') === '1') return f.heldGrant;
        if (f.torn) return Response.json({ detail: 'Niekompletna instalacja BO' }, { status: 503 });
        const limit = Number(u.searchParams.get('limit')); return Response.json(f.project({ ...f.flags, data: structuredClone(f.operations.slice(0, limit)), meta: { cursor: null, limit } }));
      }
      if (p === '/catalog-stock-control/catalogs/' + catalog + '/source') {
        if (f.deniedSource) return Response.json({ detail: 'Zbyt duży nowy source po aktywacji' }, { status: 413 });
        if (f.heldSource) return f.heldSource;
        return Response.json(f.project(f.source()));
      }
      const preview = f.previews.find(v => p.includes(v.id));
      if (p.startsWith('/catalog-stock-control/previews/')) {
        assert.ok(preview);
        if (p.endsWith('/rows')) {
          if (f.heldRows) return f.heldRows;
          const offset = Number(u.searchParams.get('cursor') ?? 0), data = f.rows.slice(offset, offset + 100), next = offset + data.length < f.rows.length ? offset + data.length : null;
          return Response.json(f.project({ ...f.flags, data: f.truncated ? data.slice(0, Math.max(0, data.length - 1)) : structuredClone(data), meta: { cursor: next, limit: 100, total: f.rows.length, scope_hash: preview.scope_hash } }));
        }
        return Response.json(f.project({ ...f.flags, preview: structuredClone(preview) }));
      }
      const operation = f.operations.find(v => p.endsWith('/' + v.id));
      if (p.startsWith('/catalog-stock-control/operations/')) { assert.ok(operation); return Response.json(f.project({ ...f.flags, operation: structuredClone(operation) })); }
      const document = f.operations.flatMap(o => o.documents).find(v => p.includes(v.id));
      if (p.startsWith('/catalog-stock-control/documents/')) {
        assert.ok(document);
        const local = f.rows.filter(r => r.warehouse_id === document.warehouse.id).map((r, i) => ({ ...structuredClone(r), source_ordinal: r.ordinal, ordinal: i }));
        if (p.endsWith('/rows')) { const offset = Number(u.searchParams.get('cursor') ?? 0), data = local.slice(offset, offset + 100); return Response.json(f.project({ ...f.flags, data, meta: { cursor: offset + data.length < local.length ? offset + data.length : null, limit: 100, total: local.length, document_id: document.id } })); }
        if (p.endsWith('/export')) { const format = u.searchParams.get('format'), values = u.searchParams.get('include_values') === 'true' && on; const result = { ...f.flags, document: values ? structuredClone(document) : redact(document), format, filename: 'BO-' + document.id + '.' + format, content_type: format === 'csv' ? 'text/csv; charset=utf-8' : 'application/xml; charset=utf-8', content: format === 'csv' ? '"document_id";"quantity"\r\n"' + document.id + '";"' + count + '"\r\n' : '<bo id="' + document.id + '" quantity="' + count + '"/>', row_count: local.length, values_included: values }; f.beforeExportReply?.(); return Response.json(result); }
        return Response.json(f.project({ ...f.flags, document: structuredClone(document) }));
      }
      throw Error('Unexpected controlled GET ' + p);
    }
    assert.equal(method, 'POST'); const b = JSON.parse(init.body); f.writes.push({ path: p, body: b, raw: init.body });
    if (f.status) return Response.json({ detail: 'Controlled status ' + f.status }, { status: f.status });
    let result = f.results.get(b.client_key);
    if (result) result = { ...structuredClone(result), ...f.flags, reused: true };
    else if (p.endsWith('/previews')) {
      assert.deepEqual(Object.keys(b).sort(), ['catalog_version', 'client_key', 'policy_version', 'series_versions', 'warehouse_policy_versions']);
      const preview = { id: id(800 + f.previews.length), catalog_id: catalog, client_key: b.client_key, request: structuredClone(b), scope_hash: sha, snapshot: structuredClone(f.snapshot), blockers: [], ready: true, row_count: count, created_at: instant, expires_at: new Date(Date.now() + 900000).toISOString(), operation_id: null, can_commit: true }; f.previews.push(preview); result = { ...f.flags, preview: structuredClone(preview), reused: false }; f.results.set(b.client_key, structuredClone(result));
    } else if (p.endsWith('/commit')) {
      const preview = f.previews.find(v => p.includes(v.id)); assert.ok(preview); assert.equal(b.scope_hash, preview.scope_hash); assert.equal(b.confirmed, true);
      const operationId = id(900 + f.operations.length), documents = preview.snapshot.warehouses.map((w, i) => ({ id: id(950 + i), operation_id: operationId, catalog_id: catalog, warehouse: structuredClone(w), kind: 'BO', number: 'BO/2026/000001', series_id: id(980 + i), series_version: '1', year: 2026, sequence: '1', row_count: f.rows.filter(r => r.warehouse_id === w.id).length, summary: summary(f.rows.filter(r => r.warehouse_id === w.id)), created_at: instant }));
      const operation = { id: operationId, catalog_id: catalog, preview_id: preview.id, client_key: b.client_key, request: structuredClone(b), scope_hash: preview.scope_hash, snapshot: structuredClone(preview.snapshot), before: structuredClone(preview.snapshot.policy), after: { catalog_id: catalog, version: '1', strict: true, operation_id: operationId }, documents, created_at: instant }; f.operations.push(operation); f.snapshot.policy = structuredClone(operation.after); preview.operation_id = operationId; preview.can_commit = false; result = { ...f.flags, operation: structuredClone(operation), reused: false }; f.results.set(b.client_key, structuredClone(result));
    } else throw Error('Unexpected controlled POST ' + p);
    if (f.lost) throw TypeError('Controlled lost ACK');
    if (f.forged) { result = structuredClone(result); result.operation.documents[0].row_count++; }
    if (f.heldAck) return f.heldAck;
    return Response.json(f.project(result), { status: result.reused ? 200 : 201 });
  };
  return f;
}
async function tick() { await act(async () => { await new Promise(r => setTimeout(r, 0)); }); }
async function until(fn, message) { for (let i = 0; i < 160; i++) { if (fn()) return; await tick(); } assert.ok(fn(), message); }
function button(h, text) { const b = [...h.container.querySelectorAll('button')].find(v => v.textContent === text); assert.ok(b, text); return b; }
function field(h, text) { const l = [...h.container.querySelectorAll('label')].find(v => v.textContent.startsWith(text)); const e = l?.querySelector('input,select'); assert.ok(e, text); return e; }
async function click(e) { assert.equal(e.disabled, false); await act(async () => e.dispatchEvent(new MouseEvent('click', { bubbles: true }))); }
async function value(e, v) { const proto = e.tagName === 'SELECT' ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype; await act(async () => { Object.getOwnPropertyDescriptor(proto, 'value').set.call(e, v); e.dispatchEvent(new Event(e.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); }); }

test('catalog strict activation169 actual mounted panel controlled HTTP', async t => {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://127.0.0.1' }), oldFetch = globalThis.fetch, descriptors = new Map();
  for (const [key, v] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, Event: dom.window.Event, MouseEvent: dom.window.MouseEvent, crypto: webcrypto, IS_REACT_ACT_ENVIRONMENT: true })) { descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: v }); }
  const vite = await createServer({ server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: 'custom', logLevel: 'error' });
  const ui = await vite.ssrLoadModule(path.resolve('web/catalog-stock-control-panel.tsx')), api = await vite.ssrLoadModule(path.resolve('web/api.ts')), { createRoot } = await import('react-dom/client');
  const mounts = [];
  function reset(f) { globalThis.fetch = f.fetch; api.setWorkspace(f.tenant); ui.resetCatalogStockControlContext(''); ui.resetCatalogStockControlContext(scope); }
  async function mount(props = {}) { const container = document.createElement('div'); document.body.append(container); const root = createRoot(container); const h = { container, props: { contextKey: scope, available: true, readOnly: false, catalogId: catalog, ...props }, async render(p = {}) { h.props = { ...h.props, ...p }; await act(async () => root.render(React.createElement(ui.CatalogStockControlPanel, h.props))); }, async close() { await act(async () => root.unmount()); container.remove(); } }; mounts.push(h); await h.render(); return h; }
  async function ready(h) { await until(() => h.container.querySelector('select')?.value === catalog && !button(h, sourceLabel).disabled && !button(h, 'Odczytaj katalogi do ścisłej kontroli').disabled, 'catalog and current flags settled'); }
  async function prepare(h) { await ready(h); await click(button(h, sourceLabel)); await until(() => [...h.container.querySelectorAll('button')].some(v => v.textContent === prepareLabel && !v.disabled), 'actual source ready'); await click(button(h, prepareLabel)); await until(() => h.container.querySelector('table caption') && !ui.catalogStockControlLocked(h.props.contextKey) && !button(h, 'Odczytaj katalogi do ścisłej kontroli').disabled, 'full manifest preview ready'); }
  async function commit(h) { await click(field(h, consentLabel)); await click(button(h, commitLabel)); await until(() => h.container.textContent.includes('Ścisła kontrola włączona — zapisany wynik') && !ui.catalogStockControlLocked(h.props.contextKey), 'validated immutable operation'); }
  try {
    await t.test('all103 positions and separate irreversible consent produce two numbered BO including empty custody WH', async () => {
      const f = fixture(); reset(f); const h = await mount(); await prepare(h);
      assert.equal(f.writes.length, 1); assert.equal(button(h, commitLabel).disabled, true); assert.ok(f.reads.some(p => p.endsWith('/rows?limit=100&cursor=0'))); assert.ok(f.reads.some(p => p.endsWith('/rows?limit=100&cursor=100'))); assert.equal(h.container.querySelectorAll('tbody tr').length, 100); await click(button(h, 'Następne pozycje BO')); assert.equal(h.container.querySelectorAll('tbody tr').length, 3);
      assert.ok(h.container.textContent.includes('Koszt nieznany') === false); await click(button(h, 'Poprzednie pozycje BO')); assert.ok(h.container.textContent.includes('Koszt nieznany')); assert.ok(h.container.textContent.includes('0,000 KWD')); assert.ok(h.container.textContent.includes('9 007 199 254 740,993 KWD')); await commit(h);
      assert.equal(f.operations.length, 1); assert.equal(f.operations[0].documents.length, 2); assert.equal(f.operations[0].documents[1].row_count, 0); assert.equal(f.writes[1].body.confirmed, true); assert.equal(f.rows[0].stock_version, '7'); assert.equal(f.rows.length, 103);
      const open = [...h.container.querySelectorAll('button')].filter(v => v.textContent === 'Otwórz BO BO/2026/000001')[0]; await click(open); await until(() => h.container.textContent.includes('Pełny zapisany BO BO/2026/000001') && !button(h, 'Pobierz pełny zapisany BO').disabled, 'full historical BO rows'); assert.ok(f.reads.some(p => p.includes('/documents/') && p.endsWith('/rows?limit=100&cursor=100'))); await h.close();
    });
    await t.test('OFF and empty BO have no invented money or series inputs and require consent', async () => {
      const f = fixture({ count: 0, on: false }); reset(f); const h = await mount(); await prepare(h); assert.ok(h.container.textContent.includes('Wycena niedostępna')); assert.equal(h.container.querySelectorAll('tbody tr').length, 0); assert.equal(button(h, commitLabel).disabled, true); await commit(h); assert.equal(f.operations[0].documents.length, 2); assert.ok(f.operations[0].documents.every(d => d.row_count === 0 && d.summary.physical_quantity === '0')); assert.ok(!Object.hasOwn(f.writes[0].body, 'quantity')); assert.ok(!Object.hasOwn(f.writes[0].body, 'unit_cost_minor')); await h.close();
    });
    await t.test('held ACK is progress only, lost ACK remount uses exact replay despite new source413 and history never acknowledges', async () => {
      const f = fixture({ count: 3 }); reset(f); const h = await mount(); await prepare(h); let reject; f.heldAck = new Promise((_, r) => { reject = r; }); await click(field(h, consentLabel)); await click(button(h, commitLabel)); await until(() => f.operations.length === 1, 'server commit held ACK'); assert.ok(h.container.textContent.includes('Trwa zapis aktywacji katalogu.')); assert.ok(!h.container.textContent.includes('Wynik zapisu jest niepewny.')); assert.ok(![...h.container.querySelectorAll('button')].some(v => v.textContent === retryLabel));
      await act(async () => { reject(TypeError('Controlled held lost ACK')); await Promise.resolve(); }); await until(() => h.container.textContent.includes('Controlled held lost ACK'), 'lost ACK visible'); const original = f.writes[1]; await h.close(); f.heldAck = null; f.deniedSource = true; const beforeReads = f.reads.length; const next = await mount({ externalWriteBlocked: true }); await ready(next); assert.ok(ui.catalogStockControlLocked(scope)); assert.equal(f.reads.slice(beforeReads).filter(p => p.includes('/source')).length, 0);
      await click(button(next, 'Odczytaj historię aktywacji katalogu')); await until(() => [...next.container.querySelectorAll('button')].some(v => v.textContent === 'Otwórz aktywację katalogu ' + id(900)), 'actual history read'); await click(button(next, 'Otwórz aktywację katalogu ' + id(900))); await until(() => next.container.textContent.includes('Ścisła kontrola włączona — zapisany wynik'), 'history saved operation'); assert.ok(ui.catalogStockControlLocked(scope)); assert.equal(f.writes.length, 2); await click(button(next, retryLabel)); await until(() => !ui.catalogStockControlLocked(scope), 'manual exact receipt replay'); assert.equal(f.writes[2].raw, original.raw); assert.equal(f.writes[2].path, original.path); assert.equal(f.operations.length, 1); assert.equal(f.reads.slice(beforeReads).filter(p => p.includes('/source')).length, 0); await next.close();
    });
    await t.test('forged document count and408/429 retain the same raw commit until a complete replay', async () => {
      const f = fixture({ count: 3 }); reset(f); const h = await mount(); await prepare(h); f.forged = true; await click(field(h, consentLabel)); await click(button(h, commitLabel)); await until(() => h.container.textContent.includes('Dokumenty BO nie pokrywają'), 'forged2xx rejected'); assert.ok(ui.catalogStockControlLocked(scope)); const original = f.writes[1]; f.forged = false;
      for (const status of [408, 429]) { f.status = status; await click(button(h, retryLabel)); await until(() => h.container.textContent.includes('Controlled status ' + status), 'unknown retry retained'); assert.ok(ui.catalogStockControlLocked(scope)); }
      f.status = 0; await click(button(h, retryLabel)); await until(() => !ui.catalogStockControlLocked(scope), 'complete receipt replay'); for (const w of f.writes.slice(2)) assert.equal(w.raw, original.raw); assert.equal(f.operations.length, 1); await h.close();
    });
    await t.test('truncated manifest never enables consent; writer capabilityfalse and torn503 never fall back to WMS opening', async () => {
      const f = fixture(); reset(f); f.truncated = true; const h = await mount(); await ready(h); await click(button(h, sourceLabel)); await until(() => [...h.container.querySelectorAll('button')].some(v => v.textContent === prepareLabel && !v.disabled), 'source'); await click(button(h, prepareLabel)); await until(() => h.container.textContent.includes('Niepełna, obca lub powtórzona strona'), 'partial manifest rejected'); assert.equal(button(h, commitLabel).disabled, true); assert.equal(f.writes.length, 1); await h.close();
      const no = fixture({ count: 3 }); no.flags.writers_available = false; reset(no); const n = await mount(); await ready(n); await click(button(n, sourceLabel)); await until(() => n.container.textContent.includes('Ścisła kontrola nieaktywna'), 'source without writers'); assert.equal(button(n, prepareLabel).disabled, true); assert.equal(no.writes.length, 0); no.torn = true; await click(button(n, 'Odczytaj historię aktywacji katalogu')); await until(() => n.container.textContent.includes('Niekompletna instalacja BO'), 'partial503'); assert.ok(no.reads.every(p => !p.startsWith('/wms-lots'))); await n.close();
    });
    await t.test('current grant loss before exact retry refuses POST and purges old costs and attempts', async () => {
      const f = fixture({ count: 3 }); reset(f); const h = await mount(); await prepare(h); f.lost = true; await click(field(h, consentLabel)); await click(button(h, commitLabel)); await until(() => h.container.textContent.includes('Controlled lost ACK'), 'unknown commit'); const count = f.writes.length; f.lost = false; f.flags.can_manage = false; f.flags.can_read_value = false; await click(button(h, retryLabel)); await until(() => h.container.textContent.includes('Brak aktualnego prawa'), 'revoked current grant'); assert.equal(f.writes.length, count); assert.equal(ui.catalogStockControlLocked(scope), false); assert.ok(!h.container.textContent.includes('KWD')); assert.ok(!h.container.textContent.includes('9007199254740993')); await h.close();
    });
    await t.test('foreign lock arriving during permission preflight blocks only the fresh request', async () => {
      const f = fixture({ count: 3 }); reset(f); const h = await mount(); await ready(h); await click(button(h, sourceLabel)); await until(() => [...h.container.querySelectorAll('button')].some(v => v.textContent === prepareLabel && !v.disabled), 'source settled'); let resolve; f.heldGrant = new Promise(r => { resolve = r; }); const start = f.reads.length; await click(button(h, prepareLabel)); await until(() => f.reads.slice(start).some(p => p.includes('limit=1')), 'held grant preflight'); await h.render({ externalWriteBlocked: true }); f.heldGrant = null; await act(async () => { resolve(Response.json({ ...f.flags, data: [], meta: { cursor: null, limit: 1 } })); await Promise.resolve(); }); await until(() => !ui.catalogStockControlLocked(scope), 'blocked preflight settled'); assert.equal(f.writes.length, 0); await h.close();
    });
    await t.test('late old actor source never publishes and restore viewer reads immutable BO without POST', async () => {
      const f = fixture({ count: 3 }); reset(f); const h = await mount(); await ready(h); let resolve; f.heldSource = new Promise(r => { resolve = r; }); const old = f.source(); old.source.snapshot.catalog.name = 'OLD ACTOR PRIVATE'; await click(button(h, sourceLabel)); await until(() => f.reads.some(p => p.includes('/source')), 'held source'); f.heldSource = null; f.tenant = id(4); api.setWorkspace(f.tenant); await h.render({ contextKey: `${f.tenant}:${user}:admin:false` }); await ready(h); await act(async () => { resolve(Response.json(old)); await Promise.resolve(); }); await tick(); assert.ok(!h.container.textContent.includes('OLD ACTOR PRIVATE')); assert.equal(f.writes.length, 0); await h.close();
      const r = fixture({ count: 3 }); reset(r); const seed = await mount(); await prepare(seed); await commit(seed); await seed.close(); ui.resetCatalogStockControlContext(''); r.flags = { ...flags, current_role: 'viewer', can_manage: false, can_read_value: false, read_only: true }; const copy = await mount({ contextKey: `${tenant}:${user}:viewer:true`, readOnly: true }); await until(() => copy.container.querySelector('select')?.value === catalog && !button(copy, 'Odczytaj historię aktywacji katalogu').disabled && !button(copy, 'Odczytaj katalogi do ścisłej kontroli').disabled, 'restore history flags'); await click(button(copy, 'Odczytaj historię aktywacji katalogu')); await until(() => [...copy.container.querySelectorAll('button')].some(v => v.textContent === 'Otwórz aktywację katalogu ' + id(900)), 'restore history'); await click(button(copy, 'Otwórz aktywację katalogu ' + id(900))); await until(() => copy.container.textContent.includes('Ścisła kontrola włączona — zapisany wynik'), 'readonly saved activation'); assert.ok(!copy.container.textContent.includes('KWD')); assert.equal(r.writes.length, 2); await copy.close();
    });
    await t.test('observed cost loss during full document read removes the entire prior value graph; history does not mutate registry', async () => {
      const f = fixture({ count: 3 }); reset(f); const h = await mount(); await prepare(h); await commit(h); const before = f.writes.length; f.flags.can_read_value = false; await click([...h.container.querySelectorAll('button')].find(v => v.textContent === 'Otwórz BO BO/2026/000001')); await until(() => h.container.textContent.includes('Pełny zapisany BO BO/2026/000001'), 'redacted full detail'); assert.ok(!h.container.textContent.includes('KWD')); assert.equal(field(h, 'Dołącz historyczną wycenę BO').disabled, true); assert.equal(f.writes.length, before); assert.equal(ui.catalogStockControlLocked(scope), false); await h.close();
    });
    await t.test('CSV/XML envelope handoff uses fresh grants and observed value loss prevents a Blob', async () => {
      // Representative controlled bytes verify browser handoff, not serialized full-file completeness.
      const f = fixture({ count: 3 }); reset(f); const h = await mount(); await prepare(h); await commit(h);
      await click([...h.container.querySelectorAll('button')].find(v => v.textContent === 'Otwórz BO BO/2026/000001')); await until(() => h.container.textContent.includes('Pełny zapisany BO BO/2026/000001') && !button(h, 'Pobierz pełny zapisany BO').disabled, 'complete detail before export');
      const create = URL.createObjectURL, revoke = URL.revokeObjectURL, anchor = window.HTMLAnchorElement.prototype.click, blobs = [], names = [];
      URL.createObjectURL = blob => { blobs.push(blob); return 'blob:controlled-bo'; }; URL.revokeObjectURL = () => {}; window.HTMLAnchorElement.prototype.click = function () { names.push(this.download); };
      try {
        for (const format of ['csv', 'xml']) { await value(field(h, 'Format eksportu BO'), format); await click(button(h, 'Pobierz pełny zapisany BO')); await until(() => names.length === (format === 'csv' ? 1 : 2) && !button(h, 'Pobierz pełny zapisany BO').disabled, 'fresh read handoff ' + format); assert.ok(f.reads.some(p => p.endsWith('/export?format=' + format + '&include_values=false'))); assert.equal(names.at(-1), 'BO-' + id(950) + '.' + format); }
        assert.equal(blobs[0].type, 'text/csv; charset=utf-8'); assert.equal(blobs[1].type, 'application/xml; charset=utf-8');
        await click(field(h, 'Dołącz historyczną wycenę BO')); f.beforeExportReply = () => { f.flags.can_read_value = false; }; await click(button(h, 'Pobierz pełny zapisany BO')); await until(() => h.container.textContent.includes('Odebrano prawo do wyceny eksportu BO.'), 'grant loss before Blob'); assert.equal(blobs.length, 2); assert.equal(f.writes.length, 2); assert.ok(!h.container.textContent.includes('KWD'));
      } finally { URL.createObjectURL = create; URL.revokeObjectURL = revoke; window.HTMLAnchorElement.prototype.click = anchor; await h.close(); }
    });
    await t.test('post-ACK value loss purges the complete operation and refresh retains only its redacted saved receipt', async () => {
      const f = fixture({ count: 3 }); reset(f); let changed = 0; const h = await mount({ onChanged: () => { changed++; } }); await prepare(h); let resolve; f.heldAck = new Promise(r => { resolve = r; }); await click(field(h, consentLabel)); await click(button(h, commitLabel)); await until(() => f.operations.length === 1, 'committed graph before ACK'); const reply = { ...flags, operation: structuredClone(f.operations[0]), reused: false }; f.flags.can_read_value = false;
      await act(async () => { resolve(Response.json(reply)); await Promise.resolve(); }); await until(() => changed === 1 && h.container.textContent.includes('Ścisła kontrola włączona — zapisany wynik') && !ui.catalogStockControlLocked(scope), 'post-ACK fresh grant'); assert.ok(!h.container.textContent.includes('KWD')); assert.equal(f.writes.length, 2);
      await h.render({ refresh: 1 }); await ready(h); await until(() => h.container.textContent.includes('Ścisła kontrola włączona — zapisany wynik'), 'saved receipt after parent reload'); assert.ok(!h.container.textContent.includes('KWD')); assert.equal(changed, 1); assert.equal(f.writes.length, 2); await h.close();
    });
    await t.test('rereading changed source clears previous full review and consent without another write', async () => {
      const f = fixture({ count: 3 }); reset(f); const h = await mount(); await prepare(h); await click(field(h, consentLabel)); assert.equal(button(h, commitLabel).disabled, false); f.snapshot.catalog.version = '4'; f.snapshot.warehouses[0].series.prefix = 'NEWBO'; await click(button(h, sourceLabel)); await until(() => h.container.textContent.includes('Ścisła kontrola nieaktywna') && !button(h, prepareLabel).disabled && !button(h, sourceLabel).disabled, 'changed source finished'); assert.ok(!h.container.textContent.includes('Pełny zapisany podgląd aktywacji i BO')); assert.equal(f.writes.length, 1); assert.ok(!h.container.querySelector('input[type=checkbox]')); await h.close();
    });
  } finally { for (const h of mounts) if (h.container.isConnected) await h.close(); globalThis.fetch = oldFetch; ui.resetCatalogStockControlContext(''); await vite.close(); dom.window.close(); for (const [key, d] of descriptors) { if (d) Object.defineProperty(globalThis, key, d); else delete globalThis[key]; } }
});
