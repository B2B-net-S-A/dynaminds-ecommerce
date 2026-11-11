import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { webcrypto } from 'node:crypto';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

// Actual mounted source/supplier components, controlled HTTP only. No DB/provider/native proof.
const id = (n) => `${n.toString(16).padStart(8, '0')}-1570-4157-8157-157157157157`;
const tenant = id(1), user = id(2), context = `${tenant}:${user}:admin:false`;
const channel = id(3), run = id(4), entry = id(5), supplier = id(6);
const flags = { available: true, can_read: true, can_manage: true, read_only: false, current_role: 'admin' };
const catalogs = () => [
  { id: id(10), name: 'Domyślny', active: true, is_default: true, version: '1', settings: { warehouse_ids: [id(20)] } },
  { id: id(11), name: 'Drugi katalog', active: true, is_default: false, version: '1', settings: { warehouse_ids: [id(21)] } },
];
const warehouses = [{ id: id(20), name: 'MAIN', code: 'MAIN' }, { id: id(21), name: 'SECOND', code: 'SECOND' }];
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
function fixture() {
  const f = { reads: [], writes: [], catalogs: catalogs(), flags: { ...flags }, holdOptions: null, holdRun: null, holdAuth: null, authUser: user, conflict: false, candidate: null, malformed: null, lost: false, receipt: null, applied: false, notifications: [] };
  f.options = () => ({ ...f.flags, catalogs: structuredClone(f.catalogs), warehouses, price_lists: [], languages: ['pl'] });
  f.runReply = (cat, name = 'Źródłowy produkt') => ({
    catalog_id: cat, currency: 'PLN',
    run: { id: run, state: 'ready', warehouse_id: id(21), import_stock: false, fetched: 1, created_at: '2026-10-06T12:00:00Z' },
    data: [{ id: entry, external_id: 'EXT-1', kind: 'simple', state: f.applied ? 'applied' : 'staged', source_hash: 'a'.repeat(64), source: { name, sku: 'REMOTE-SKU', price: 1700, currency: 'PLN', quantity: 900, vat: 23 }, candidate_id: f.candidate?.id ?? null, candidate_version: f.candidate?.version, issues: [], ...(f.applied ? { result: { action: f.candidate ? 'linked' : 'created', sku: 'REMOTE-SKU' } } : {}) }],
    counts: [{ kind: 'simple', state: f.applied ? 'applied' : 'staged', count: 1 }], meta: { cursor: null },
  });
  f.fetch = async (url, init = {}) => {
    const u = new URL(String(url), 'http://127.0.0.1'), p = u.pathname.replace(/^\/api/, ''), method = init.method ?? 'GET';
    assert.equal(new Headers(init.headers).get('X-Workspace-ID'), tenant, 'every request uses own workspace');
    if (method === 'GET') {
      f.reads.push(p + u.search);
      if (p === '/auth/me') return f.holdAuth ? f.holdAuth.promise : Response.json({ user: { tenant_id: tenant, id: f.authUser, role: 'admin' } });
      if (p === '/product-catalogs/options') return f.holdOptions ? f.holdOptions.promise : Response.json(f.options());
      if (p === '/warehouses') return Response.json({ data: warehouses });
      if (p === `/integrations/${channel}/catalog-source-runs`) return Response.json({ channel: { id: channel, provider: 'amazon', settings: { simulation: true } }, data: [{ id: run, state: 'ready', created_at: '2026-10-06T12:00:00Z' }] });
      if (p === `/catalog-source-runs/${run}/candidate`) return Response.json({ product: f.candidate, catalog_conflict: f.conflict });
      if (p === `/catalog-source-runs/${run}`) {
        const cat = u.searchParams.get('catalog_id');
        if (f.holdRun?.catalog === cat) return f.holdRun.promise;
        return Response.json(f.runReply(cat));
      }
      if (p === '/supplier-sources') return Response.json({ data: [{ id: supplier, kind: 'file', name: 'Własny plik', supplier_name: 'Dostawca', currency: 'PLN', max_handling_days: 3, version: 1, paused: false }], meta: { cursor: null } });
      if (p === '/workspaces/settings') return Response.json({ tenant: { currency: 'PLN' } });
      if (p === '/supplier-catalog') return Response.json({ data: [{ id: entry, version: 1, sku: 'REMOTE-SKU', name: 'Produkt dostawcy', product_id: null, currency: 'PLN', remote_product_id: 'EXT-1', snapshot: { unit_cost: 700, quantity: 900, tiers: [], active: true, condition: 'new' }, refreshed_at: '2026-10-06T12:00:00Z' }], meta: { cursor: null } });
      if (p === '/products') return Response.json({ data: [], meta: { cursor: null } });
      throw Error('Unexpected fixture GET ' + p);
    }
    const body = JSON.parse(init.body);
    f.writes.push({ path: p, method, raw: init.body, body });
    if (p === `/catalog-source-runs/${run}/apply` && method === 'POST') {
      if (!f.receipt) {
        const linked = body.items[0].expected_product_id !== null;
        f.receipt = { data: [{ entry_id: entry, external_id: 'EXT-1', product_id: body.items[0].expected_product_id ?? id(50), sku: body.items[0].local_sku, kind: 'simple', action: linked ? 'linked' : 'created', local_price: 1700, local_currency: 'PLN' }], created: linked ? 0 : 1, linked: linked ? 1 : 0 };
        f.applied = true;
      } else assert.equal(init.body, f.writes[0].raw, 'receipt replay must match original wire bytes');
      if (f.lost) throw TypeError('Controlled lost ACK after receipt');
      const response = structuredClone(f.receipt);
      if (f.writes.length > 1) { response.data = response.data.map((r) => ({ ...r, reused: true })); response.created = 0; response.linked = 0; }
      if (f.malformed === 'linked-product') response.data[0].product_id = id(99);
      if (f.malformed === 'counts') response.linked = 99;
      return Response.json(response);
    }
    if (p === `/supplier-catalog/${entry}/product` && method === 'POST') return Response.json({ id: id(50), catalog_id: body.catalog_id }, { status: 201 });
    throw Error('Unexpected fixture mutation ' + p);
  };
  return f;
}
async function tick() { await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); }
async function until(predicate, note) { for (let i = 0; i < 100; i++) { if (predicate()) return; await tick(); } assert.ok(predicate(), note); }
function button(h, text) { const el = [...h.container.querySelectorAll('button')].find((b) => b.textContent.trim() === text); assert.ok(el, text); return el; }
function named(h, label) { const el = h.container.querySelector(`[aria-label="${label}"]`); assert.ok(el, label); return el; }
function field(h, label) { const el = [...h.container.querySelectorAll('label')].find((l) => [...l.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').replace(/\s+/g, ' ').trim() === label)?.querySelector('input,select'); assert.ok(el, label); return el; }
async function click(el) { assert.equal(el.disabled, false); assert.equal(el.closest('fieldset')?.disabled ?? false, false); await act(async () => el.dispatchEvent(new MouseEvent('click', { bubbles: true }))); }
async function value(el, v) { const proto = el.tagName === 'SELECT' ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype; await act(async () => { Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v); el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); }); }

test('catalog assignments in actual source and supplier components', async (t) => {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://127.0.0.1/' }), saved = new Map(), originalFetch = globalThis.fetch;
  for (const [key, v] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, MouseEvent: dom.window.MouseEvent, Event: dom.window.Event, FormData: dom.window.FormData, crypto: webcrypto, IS_REACT_ACT_ENVIRONMENT: true })) { saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: v }); }
  const vite = await createServer({ server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: 'custom', logLevel: 'error' });
  const { createRoot } = await import('react-dom/client'), source = await vite.ssrLoadModule(path.resolve('web/catalog-source.tsx')), supplierUI = await vite.ssrLoadModule(path.resolve('web/supplier-catalog.tsx')), catalogUI = await vite.ssrLoadModule(path.resolve('web/product-catalogs.tsx')), api = await vite.ssrLoadModule(path.resolve('web/api.ts'));
  const mounts = [];
  function reset(f) { globalThis.fetch = f.fetch; api.setWorkspace(tenant); source.resetCatalogSourceContext(''); source.resetCatalogSourceContext(context); catalogUI.resetProductCatalogsContext(''); catalogUI.resetProductCatalogsContext(context); }
  async function mount(component = source.CatalogSourcePanel, props = {}) {
    const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
    const h = { container, props: { contextKey: context, readOnly: false, channelId: channel, ...props }, async render(patch = {}) { h.props = { ...h.props, ...patch }; await act(async () => root.render(React.createElement(component, h.props))); }, async close() { await act(async () => root.unmount()); container.remove(); } };
    mounts.push(h); await h.render(); return h;
  }
  async function sourceReady(h, cat = id(11)) {
    await until(() => h.container.querySelector('select[aria-label="Katalog nowych produktów"]')?.options.length === 3, 'own catalog options');
    await value(named(h, 'Katalog nowych produktów'), cat);
    await until(() => h.container.textContent.includes('Źródłowy produkt'), 'scoped source rows');
  }
  async function chooseSourceRow(h) { await click(named(h, 'Wybierz katalog EXT-1')); }
  async function supplierForm(f) {
    const h = await mount(supplierUI.SupplierCatalog, { admin: true, refresh: 0, reload() {}, notify(s) { f.notifications.push(s); } });
    await until(() => h.container.querySelector('select[aria-label="Źródło hurtowni"]')?.options.length === 2, 'supplier source');
    await value(named(h, 'Źródło hurtowni'), supplier); await until(() => h.container.textContent.includes('Pozycja REMOTE-SKU'), 'supplier item'); await click(button(h, 'Pozycja REMOTE-SKU'));
    await until(() => h.container.querySelector('select[aria-label="Katalog nowego produktu"]')?.options.length === 3, 'creation catalogs');
    await act(async () => h.container.querySelector('details').setAttribute('open', ''));
    return h;
  }
  async function prepareSupplier(h) { await value(named(h, 'Katalog nowego produktu'), id(11)); await value(named(h, 'Magazyn nowego produktu'), id(21)); await value(field(h, 'Cena sprzedaży (PLN)'), '17.00'); }
  try {
    await t.test('explicit source catalog scopes candidate conflict and new staged product body', async () => {
      const f = fixture(); reset(f); const h = await mount(); await sourceReady(h);
      assert.ok(f.reads.some((r) => r.startsWith(`/catalog-source-runs/${run}?`) && r.includes('catalog_id=' + id(11))));
      assert.deepEqual([...field(h, 'Magazyn nowych SKU').options].map((o) => o.value), ['', id(21)]);
      f.conflict = true; await click(named(h, 'Sprawdź SKU EXT-1')); await until(() => h.container.textContent.includes('SKU należy do innego katalogu'), 'cross catalog collision visible');
      assert.ok(f.reads.some((r) => r.includes('/candidate?sku=REMOTE-SKU&catalog_id=' + id(11))));
      await chooseSourceRow(h); await click(button(h, 'Zatwierdź wybrane SKU (1)')); await until(() => h.container.querySelector('[role="alert"]')?.textContent.includes('Wybierz inny lokalny kod'), 'collision blocks mutation'); assert.equal(f.writes.length, 0);
      f.conflict = false; await value(named(h, 'SKU lokalny EXT-1'), 'OWN-SECOND'); await click(named(h, 'Sprawdź SKU EXT-1')); await until(() => h.container.textContent.includes('Nowy produkt'), 'own sku checked');
      await click(button(h, 'Zatwierdź wybrane SKU (1)')); await until(() => h.container.textContent.includes('Utworzono 1;'), 'saved source receipt');
      assert.equal(f.writes.length, 1); assert.equal(f.writes[0].body.items[0].catalog_id, id(11)); assert.equal(f.writes[0].body.items[0].local_sku, 'OWN-SECOND'); assert.ok(!('quantity_override' in f.writes[0].body.items[0]), 'supplier quantity is not imported when stock disabled'); await h.close();
    });
    await t.test('late old catalog source GET cannot publish after catalog switch', async () => {
      const f = fixture(); reset(f); const held = deferred(); f.holdRun = { catalog: id(10), ...held }; const h = await mount();
      await until(() => h.container.querySelector('select[aria-label="Katalog nowych produktów"]')?.options.length === 3, 'catalog choices'); await value(named(h, 'Katalog nowych produktów'), id(10));
      await until(() => f.reads.some((r) => r.includes('catalog_id=' + id(10))), 'held old catalog read'); await value(named(h, 'Katalog nowych produktów'), id(11)); await until(() => h.container.textContent.includes('Źródłowy produkt'), 'new catalog data');
      await act(async () => { held.resolve(Response.json(f.runReply(id(10), 'FOREIGN LATE SOURCE'))); await Promise.resolve(); }); await tick();
      assert.ok(!h.container.textContent.includes('FOREIGN LATE SOURCE')); assert.equal(named(h, 'Katalog nowych produktów').value, id(11)); assert.equal(f.writes.length, 0); await h.close();
    });
    await t.test('lost apply ACK survives unmount and GET refresh; exact staged catalog body is replayed', async () => {
      const f = fixture(); reset(f); f.lost = true; const h = await mount(); await sourceReady(h); await chooseSourceRow(h); await click(button(h, 'Zatwierdź wybrane SKU (1)'));
      await until(() => h.container.textContent.includes('Wynik zatwierdzenia jest niepewny'), 'retained request'); const first = f.writes[0]; assert.equal(first.body.items[0].catalog_id, id(11)); await h.close();
      f.lost = false; const next = await mount(undefined, { externalWriteBlocked: true }); await until(() => next.container.textContent.includes('Utworzono · REMOTE-SKU'), 'current row is already applied');
      assert.equal(named(next, 'Katalog nowych produktów').disabled, true); await click(button(next, 'Odśwież przegląd katalogu')); assert.ok(next.container.textContent.includes('Ponów dokładne zatwierdzenie źródła')); assert.equal(f.writes.length, 1);
      await click(button(next, 'Ponów dokładne zatwierdzenie źródła')); await until(() => next.container.textContent.includes('Utworzono 0; powiązano 0.'), 'manual replay resolves with actual non-reused counts');
      assert.equal(f.writes.length, 2); assert.equal(f.writes[1].path, first.path); assert.equal(f.writes[1].raw, first.raw); assert.equal(f.writes[1].body.items[0].catalog_id, id(11), 'do not reconstruct body from now-applied row'); assert.ok(!next.container.textContent.includes('Wynik zatwierdzenia jest niepewny')); await h.close();
    });
    for (const malformed of ['linked-product', 'counts']) await t.test(`malformed source ${malformed} 2xx retains exact linked request until valid replay`, async () => {
      const f = fixture(); f.candidate = { id: id(60), version: 3, price: 1700 }; f.malformed = malformed; reset(f); const h = await mount(); await sourceReady(h); await chooseSourceRow(h);
      await click(button(h, 'Zatwierdź wybrane SKU (1)')); await until(() => h.container.textContent.includes('Wynik zatwierdzenia jest niepewny'), 'invalid receipt retains request');
      assert.equal(f.writes.length, 1); assert.equal(f.writes[0].body.items[0].expected_product_id, id(60)); assert.ok(h.container.textContent.includes('Niepełny wynik zatwierdzenia')); assert.ok(!h.container.textContent.includes('Utworzono 0; powiązano'));
      const first = f.writes[0]; f.malformed = null; await click(button(h, 'Ponów dokładne zatwierdzenie źródła')); await until(() => h.container.textContent.includes('Utworzono 0; powiązano 0.'), 'valid immutable replay resolves');
      assert.equal(f.writes.length, 2); assert.equal(f.writes[1].raw, first.raw); assert.equal(f.receipt.data[0].product_id, id(60)); assert.equal(f.receipt.data[0].action, 'linked'); assert.ok(!h.container.textContent.includes('Wynik zatwierdzenia jest niepewny')); await h.close();
    });
    await t.test('fresh source apply rechecks sibling lock after held permission preflight', async () => {
      const f = fixture(); reset(f); const h = await mount(); await sourceReady(h); await chooseSourceRow(h); const held = deferred(); f.holdOptions = held; const before = f.reads.filter((r) => r === '/product-catalogs/options').length;
      await click(button(h, 'Zatwierdź wybrane SKU (1)')); await until(() => f.reads.filter((r) => r === '/product-catalogs/options').length > before, 'apply preflight held'); await h.render({ externalWriteBlocked: true }); f.holdOptions = null;
      await act(async () => { held.resolve(Response.json(f.options())); await Promise.resolve(); }); await until(() => h.container.textContent.includes('Zatwierdzenie nie zostało wysłane'), 'latest sibling lock refuses fresh write'); assert.equal(f.writes.length, 0); assert.ok(!h.container.textContent.includes('Wynik zatwierdzenia jest niepewny')); await h.close();
    });
    await t.test('supplier creation requires explicit catalog and assigned warehouse, never supplier stock', async () => {
      const f = fixture(); reset(f); const h = await supplierForm(f);
      assert.equal(named(h, 'Katalog nowego produktu').value, ''); assert.equal(button(h, 'Utwórz produkt ze stanem zero').disabled, true); await value(named(h, 'Katalog nowego produktu'), id(11));
      assert.equal(named(h, 'Magazyn nowego produktu').value, ''); assert.deepEqual([...named(h, 'Magazyn nowego produktu').options].map((o) => o.value), ['', id(21)]); assert.equal(button(h, 'Utwórz produkt ze stanem zero').disabled, true);
      await value(named(h, 'Magazyn nowego produktu'), id(21)); await value(field(h, 'Cena sprzedaży (PLN)'), '17.00'); await click(button(h, 'Utwórz produkt ze stanem zero')); await until(() => f.notifications.length === 1, 'supplier create receipt');
      assert.equal(f.writes.length, 1); assert.equal(f.writes[0].path, `/supplier-catalog/${entry}/product`); assert.deepEqual(f.writes[0].body, { version: 1, sku: 'REMOTE-SKU', price: 1700, vat: 23, warehouse_id: id(21), catalog_id: id(11) }); assert.ok(!('quantity' in f.writes[0].body)); await h.close();
    });
    await t.test('supplier preflight rejects withdrawn warehouse assignment before product POST', async () => {
      const f = fixture(); reset(f); const h = await supplierForm(f); await prepareSupplier(h); f.catalogs[1].settings.warehouse_ids = [id(20)]; await click(button(h, 'Utwórz produkt ze stanem zero'));
      await until(() => h.container.textContent.includes('Katalog lub magazyn produktu zmienił się'), 'fresh assignment check'); assert.equal(f.writes.length, 0); assert.equal(f.notifications.length, 0); await h.close();
    });
    await t.test('supplier create cannot cross newly imposed sibling lock during preflight', async () => {
      const f = fixture(); reset(f); const h = await supplierForm(f); await prepareSupplier(h); const held = deferred(); f.holdOptions = held; const before = f.reads.filter((r) => r === '/product-catalogs/options').length;
      await click(button(h, 'Utwórz produkt ze stanem zero')); await until(() => f.reads.filter((r) => r === '/product-catalogs/options').length > before, 'supplier preflight held'); await h.render({ externalWriteBlocked: true }); f.holdOptions = null;
      await act(async () => { held.resolve(Response.json(f.options())); await Promise.resolve(); }); await until(() => h.container.textContent.includes('Zapis nie został wysłany'), 'latest supplier write gate'); assert.equal(f.writes.length, 0); await h.close();
    });
    await t.test('supplier fresh identity preflight rejects another admin in the same workspace', async () => {
      const f = fixture(); reset(f); const h = await supplierForm(f); await prepareSupplier(h); const held = deferred(); f.holdAuth = held;
      await click(button(h, 'Utwórz produkt ze stanem zero')); await until(() => f.reads.includes('/auth/me'), 'current identity read held after catalog preflight');
      await act(async () => { held.resolve(Response.json({ user: { tenant_id: tenant, id: id(90), role: 'admin' } })); await Promise.resolve(); }); await until(() => h.container.textContent.includes('Zmienił się użytkownik lub firma'), 'other same-role actor denied');
      assert.equal(f.writes.length, 0); assert.equal(f.notifications.length, 0); await h.close();
    });
    await t.test('supplier latest sibling lock is rechecked after current identity await', async () => {
      const f = fixture(); reset(f); const h = await supplierForm(f); await prepareSupplier(h); const held = deferred(); f.holdAuth = held;
      await click(button(h, 'Utwórz produkt ze stanem zero')); await until(() => f.reads.includes('/auth/me'), 'identity read pending'); await h.render({ externalWriteBlocked: true });
      await act(async () => { held.resolve(Response.json({ user: { tenant_id: tenant, id: user, role: 'admin' } })); await Promise.resolve(); }); await until(() => h.container.textContent.includes('Zapis nie został wysłany'), 'lock after second await denied');
      assert.equal(f.writes.length, 0); await h.close();
    });
  } finally {
    for (const h of mounts) if (h.container.isConnected) await h.close();
    await vite.close(); dom.window.close(); globalThis.fetch = originalFetch;
    for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
  }
});
