import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { webcrypto } from 'node:crypto';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

// Actual React workspace and shared return registry. HTTP is controlled;
// this does not establish SQL custody, native mobile layout or business receipt proof.
const id = n => `${n.toString(16).padStart(8, '0')}-1550-4155-8155-155155155155`;
const tenant = id(1), user = id(2), context = `${tenant}:${user}:admin:false`;
const flags = { available: true, read_only: false, current_role: 'admin', can_read: true, can_write: true, can_save_settings: true, can_manage_queue: true };
const defaults = () => ({ auto_next: false, hide_accepted: false, name_source: 'historical', product_sort: 'historical', thumbnail_size: 'none', case_fields: ['number', 'order_number', 'created_at', 'kind'], product_fields: ['sku', 'name', 'quantity', 'line_total'] });
const clone = v => structuredClone(v);
const source = count => Array.from({ length: count }, (_, index) => ({ id: id(10 + index), number: `RMA-${index + 1}`, order_id: id(500 + index), order_number: `ORDER-${index + 1}`, kind: 'return', state: 'requested', created_at: '2026-10-06T12:00:00Z' }));
function fixture(count = 2) {
  const f = { rows: source(count), writes: [], reads: [], settings: { version: '0', values: defaults() }, head: null, accepted: new Set(), skipped: new Set(), malformed: false, f: flags, foreignIndex: null };
  f.makeQueue = (ids, navigation = { auto_next: false, hide_accepted: false }) => {
    f.manifest = ids.map(returnId => f.rows.find(r => r.id === returnId)); assert.ok(f.manifest.every(Boolean));
    f.head = { id: id(3000), version: '1', count: ids.length, position: 0, skipped_return_ids: [], navigation, created_at: '2026-10-06T12:00:00Z', updated_at: '2026-10-06T12:00:00Z' };
    return f.head;
  };
  f.fetch = async (url, options = {}) => {
    assert.equal(options.headers['X-Workspace-ID'], tenant);
    const u = new URL(url, 'http://127.0.0.1'), method = options.method;
    if (method === 'GET') {
      f.reads.push(url);
      if (u.pathname === '/api/return-assistant/settings') return Response.json({ ...f.f, settings: clone(f.settings) });
      if (u.pathname === '/api/returns') { const start = Number(u.searchParams.get('after') ?? 0), rows = f.rows.slice(start, start + 50); return Response.json({ data: rows, meta: { cursor: start + 50 < f.rows.length ? String(start + 50) : null } }); }
      if (u.pathname === '/api/return-assistant/queues') return Response.json({ ...f.f, data: f.head ? [clone(f.head)] : [], next_cursor: null });
      if (u.pathname === `/api/return-assistant/queues/${id(3000)}`) return Response.json({ ...f.f, queue: clone(f.head) });
      if (u.pathname === `/api/return-assistant/queues/${id(3000)}/items`) {
        const previous = u.searchParams.get('cursor'), start = previous ? f.manifest.findIndex(r => r.id === previous) + 1 : 0;
        const rows = f.manifest.slice(start, start + 50).map((r, offset) => ({ index: start + offset, return_id: r.id, number: r.number, order_id: r.order_id, order_number: r.order_number, kind: r.kind, created_at: r.created_at, state: f.accepted.has(r.id) ? 'refund_pending' : r.state, accepted: f.accepted.has(r.id), skipped: f.head.skipped_return_ids.includes(r.id), current_session: start + offset === f.foreignIndex ? { id: id(3010), state: 'active', owner_id: id(3011), lease_expires_at: new Date(Date.now() + 900000).toISOString() } : null, receipt_id: f.accepted.has(r.id) ? id(3020) : null }));
        return Response.json({ ...f.f, queue: clone(f.head), data: rows, next_cursor: start + 50 < f.manifest.length ? rows.at(-1).return_id : null });
      }
      if (u.pathname === `/api/return-assistant/receipts/${id(3020)}`) { f.accepted.add(f.rows[0].id); return Response.json({ ...f.f, receipt: { id: id(3020), return_id: f.rows[0].id, session_id: id(3021), action: 'receive' } }); }
      throw Error('Unexpected read: ' + url);
    }
    assert.ok(!u.pathname.includes('/sessions') && !u.pathname.endsWith('/receive'), 'Queue never starts or accepts a session');
    const body = JSON.parse(options.body); f.writes.push({ path: u.pathname, method, body: options.body, parsed: body });
    if (u.pathname === '/api/return-assistant/settings') { assert.equal(method, 'PATCH'); assert.equal(body.version, f.settings.version); f.settings = { version: String(Number(f.settings.version) + 1), values: clone(body.values) }; return Response.json({ ...f.f, settings: clone(f.settings), operation_id: id(3030), reused: false }); }
    if (u.pathname === '/api/return-assistant/queues') { assert.equal(method, 'POST'); if (!f.head) f.makeQueue(body.return_ids, body.navigation); return Response.json(f.malformed ? { ...f.f, reused: false } : { ...f.f, queue: clone(f.head), operation_id: id(3031), reused: f.writes.filter(w => w.method === 'POST').length > 1 }, { status: 201 }); }
    assert.equal(u.pathname, `/api/return-assistant/queues/${id(3000)}`); assert.equal(method, 'PATCH'); assert.equal(body.version, f.head.version);
    f.head = { ...f.head, version: String(Number(f.head.version) + 1), position: body.position, skipped_return_ids: body.skipped_return_ids, navigation: body.navigation };
    return Response.json({ ...f.f, queue: clone(f.head), operation_id: id(3032), reused: false });
  };
  return f;
}
async function tick() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); }
async function until(fn, message) { for (let i = 0; i < 100; ++i) { if (fn()) return; await tick(); } assert.ok(fn(), message); }
function button(h, text) { const b = [...h.container.querySelectorAll('button')].find(v => v.textContent === text); assert.ok(b, text); return b; }
async function click(el) { assert.equal(el.disabled, false, el.textContent); assert.equal(el.closest('fieldset')?.disabled ?? false, false); await act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); }); }
function field(h, text) { return [...h.container.querySelectorAll('label')].find(v => v.firstChild?.textContent === text)?.querySelector('input,select'); }
function check(h, text) { const label = [...h.container.querySelectorAll('label')].find(v => v.textContent.startsWith(text)); assert.ok(label, text); return label.querySelector('input[type=checkbox]'); }
async function value(el, value) { assert.ok(el); await act(async () => { Object.getOwnPropertyDescriptor(el.tagName === 'SELECT' ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype, 'value').set.call(el, value); el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); }); }

test('return assistant queues actual workspace', async t => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://127.0.0.1/' }), saved = new Map(), originalFetch = globalThis.fetch;
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, MouseEvent: dom.window.MouseEvent, Event: dom.window.Event, FormData: dom.window.FormData, crypto: webcrypto, IS_REACT_ACT_ENVIRONMENT: true })) { saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value }); }
  const vite = await createServer({ server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: 'custom', logLevel: 'error' });
  const { createRoot } = await import('react-dom/client'), ui = await vite.ssrLoadModule(path.resolve('web/return-assistant-queues.tsx')), registry = await vite.ssrLoadModule(path.resolve('web/b2b-dropshipping-returns.tsx')), api = await vite.ssrLoadModule(path.resolve('web/api.ts')), presentationUI = await vite.ssrLoadModule(path.resolve('web/return-assistant-presentation.tsx'));
  const mounts = [];
  function reset(ctx = context, readOnly = false) { api.setWorkspace(ctx.split(':')[0]); registry.resetDropshipReturnContext('', false); ui.resetReturnAssistantQueuesContext('', false); ui.resetReturnAssistantQueuesContext(ctx, readOnly); }
  function mount(extra = {}) { const container = document.createElement('div'); document.body.append(container); const root = createRoot(container); const h = { container, props: { contextKey: context, readOnly: false, write: true, onOpenReturn: () => {}, ...extra }, async render(patch = {}) { h.props = { ...h.props, ...patch }; await act(async () => root.render(React.createElement(ui.ReturnAssistantQueuesPanel, h.props))); }, async close() { await act(async () => root.unmount()); container.remove(); } }; mounts.push(h); return h; }
  async function initial(h) { await h.render(); await until(() => h.container.textContent.includes('Ustawienia prezentacji'), 'Settings readable'); }
  async function selectAll(h) { await click(button(h, 'Odczytaj sprawy do wyboru')); await until(() => h.container.querySelector('input[aria-label="Wybierz RMA-1"]'), 'Source loaded'); await click(button(h, 'Zaznacz tylko tę stronę spraw')); }
  async function save(h) { await click(check(h, 'Sprawdziłem wszystkie wybrane sprawy')); await click(button(h, 'Zapisz kolejkę wybranych spraw')); await until(() => h.container.textContent.includes('Zapisana kolejka'), 'Full saved queue loaded'); }
  try {
    await t.test('explicit 200-case selection across four source pages and all manifest pages before save', async () => {
      reset(); const f = fixture(201); globalThis.fetch = f.fetch; const h = mount(); await initial(h); assert.equal(f.writes.length, 0); await selectAll(h);
      for (let page = 1; page < 4; ++page) { await click(button(h, 'Następna strona spraw do wyboru')); await until(() => h.container.querySelector(`input[aria-label="Wybierz RMA-${page * 50 + 1}"]`), 'Next source page'); await click(button(h, 'Zaznacz tylko tę stronę spraw')); }
      assert.ok(h.container.textContent.includes('(200 / 200)')); await click(button(h, 'Następna strona spraw do wyboru')); await until(() => h.container.querySelector('input[aria-label="Wybierz RMA-201"]'), '201st row visible'); assert.equal(h.container.querySelector('input[aria-label="Wybierz RMA-201"]').disabled, true);
      assert.equal(check(h, 'Sprawdziłem wszystkie wybrane sprawy').disabled, true); assert.equal(button(h, 'Zapisz kolejkę wybranych spraw').disabled, true);
      for (let page = 1; page < 4; ++page) await click(button(h, 'Następna strona manifestu'));
      assert.equal(check(h, 'Sprawdziłem wszystkie wybrane sprawy').disabled, false); await save(h); assert.equal(f.writes.length, 1); assert.equal(f.writes[0].parsed.return_ids.length, 200); assert.deepEqual(f.writes[0].parsed.return_ids, f.rows.slice(0, 200).map(r => r.id)); assert.equal(f.reads.filter(p => p.includes('/items?')).length, 4, 'Every durable manifest page read before presenting saved queue'); await h.close();
    });
    await t.test('real settings, dirty guard, verified-receipt-only auto-next, accepted hiding and explicit foreign-session skip', async () => {
      reset(); const f = fixture(3), opened = [], views = []; f.foreignIndex = 1; globalThis.fetch = f.fetch; const h = mount({ onOpenReturn: v => opened.push(v), onViewSettingsChange: v => views.push(v) }); await initial(h);
      await value(field(h, 'Źródło nazwy produktu'), 'current'); await value(field(h, 'Kolejność pozycji'), 'sku'); await value(field(h, 'Miniaturki produktów'), 'large'); await click(check(h, 'Otwieraj następną sprawę po zapisaniu decyzji —')); await click(check(h, 'Ukrywaj przyjęte w roboczym')); await click(button(h, 'Zapisz ustawienia prezentacji')); await until(() => views.at(-1)?.product_sort === 'sku', 'Saved settings applied through actual callback');
      assert.equal(f.settings.values.thumbnail_size, 'large'); assert.equal(f.settings.values.name_source, 'current'); await selectAll(h); await save(h); assert.equal(opened.length, 0, 'Save never opens or starts business case'); await click(button(h, 'Otwórz bieżącą sprawę do przeglądu')); assert.equal(opened[0].returnId, f.rows[0].id); assert.equal(opened[0].viewSettings.name_source, 'current');
      await h.render({ guard: { dirty: true, inFlight: false, unknown: false, hasActiveSession: true } }); assert.equal(button(h, 'Następna sprawa').disabled, true); assert.ok(h.container.textContent.includes('niezapisane oceny'));
      const completion = { returnId: f.rows[0].id, sessionId: id(3021), receiptId: id(3020), action: 'receive' }; await h.render({ completion }); await tick(); assert.equal(f.writes.length, 2, 'Dirty receipt cannot navigate');
      await h.render({ guard: { dirty: false, inFlight: false, unknown: false, hasActiveSession: false } }); await until(() => opened.length === 2, 'Verified receipt navigates once'); assert.equal(opened[1].returnId, f.rows[1].id); assert.equal(f.writes.length, 3); assert.ok(f.reads.some(p => p.endsWith(`/receipts/${id(3020)}`))); assert.ok(h.container.textContent.includes('Widoczne: 2 / 3')); assert.ok(h.container.textContent.includes('Obsługiwana przez innego operatora'));
      await h.render({ completion: clone(completion) }); await tick(); assert.equal(f.writes.length, 3, 'No repeated automatic metadata write'); await click(check(h, 'Pokaż także przyjęte')); assert.ok(h.container.textContent.includes('Uznane — do rozliczenia'));
      await click(button(h, 'Pomiń bieżącą na teraz')); await until(() => f.head.position === 2 && opened.length === 3, 'Explicit skip navigates'); assert.deepEqual(f.head.skipped_return_ids, [f.rows[1].id]); assert.equal(f.writes.filter(w => w.path.includes('/sessions') || w.path.endsWith('/receive')).length, 0); await h.close();
    });
    await t.test('malformed successful create keeps exact shared lock across unmount and history reads; manual retry uses same request', async () => {
      reset(); const f = fixture(2), locks = []; f.malformed = true; globalThis.fetch = f.fetch; const h = mount({ onLockedChange: v => locks.push(v) }); await initial(h); await selectAll(h); await click(check(h, 'Sprawdziłem wszystkie wybrane sprawy')); await click(button(h, 'Zapisz kolejkę wybranych spraw')); await until(() => h.container.textContent.includes('Wynik zapisu'), 'Malformed 2xx remains unknown'); assert.equal(f.writes.length, 1); assert.equal(locks.at(-1), true); const original = clone(f.writes[0]); await h.close();
      const resumed = mount({ onLockedChange: v => locks.push(v) }); await initial(resumed); await until(() => !button(resumed, 'Ponów dokładny zapis kolejki lub ustawień').disabled, 'Exact retry ready'); await click(button(resumed, 'Odczytaj historię kolejek')); await until(() => resumed.container.textContent.includes('Wznów kolejkę z'), 'Immutable known history read'); assert.ok(resumed.container.textContent.includes('Wynik zapisu')); assert.equal(locks.at(-1), true); assert.equal(button(resumed, 'Wznów kolejkę z ' + new Date(f.head.created_at).toLocaleString('pl-PL', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })).disabled, true);
      f.malformed = false; await click(button(resumed, 'Ponów dokładny zapis kolejki lub ustawień')); await until(() => resumed.container.textContent.includes('Zapisana kolejka'), 'Manual exact receipt'); assert.equal(f.writes.length, 2); assert.equal(f.writes[1].body, original.body); assert.equal(f.writes[1].path, original.path); assert.equal(f.writes[1].method, original.method); assert.equal(locks.at(-1), false); await resumed.close();
    });
    await t.test('validated destinations operation opens next case once through its actual endpoint, never a legacy receipt or session write', async () => {
      reset(); const f = fixture(2), opened = []; f.settings.values.auto_next = true;
      const operation = { id: id(3020), kind: 'operation', protocol: 'destinations_v1', return_id: f.rows[0].id, session_id: id(3021), action: 'receive', snapshot: { protocol: 'destinations_v1', session: { id: id(3021), return_id: f.rows[0].id } } };
      globalThis.fetch = async (url, options) => {
        if (url === `/api/return-destinations/operations/${operation.id}`) { assert.equal(options.method, 'GET'); f.reads.push(url); f.accepted.add(f.rows[0].id); return Response.json({ ...flags, intake_available: true, can_read_value: false, operation: clone(operation) }); }
        assert.ok(!url.includes('/receipts/'), 'Destinations completion cannot use legacy139 projection'); return f.fetch(url, options);
      };
      const h = mount({ onOpenReturn: row => opened.push(row) }); await initial(h); await selectAll(h); await save(h); assert.equal(opened.length, 0);
      const completion = { returnId: f.rows[0].id, sessionId: operation.session_id, receiptId: operation.id, action: 'receive', protocol: 'destinations_v1' };
      await h.render({ completion, guard: { dirty: false, inFlight: false, unknown: true, hasActiveSession: false } }); await tick(); assert.equal(f.writes.length, 1, 'Unknown must resolve before receipt navigation');
      await h.render({ guard: { dirty: false, inFlight: false, unknown: false, hasActiveSession: false } }); await until(() => opened.length === 1, 'Actual148 operation verifies next-case navigation');
      assert.equal(opened[0].returnId, f.rows[1].id); assert.equal(f.head.position, 1); assert.equal(f.head.version, '2'); assert.equal(f.writes.length, 2); assert.equal(f.writes[1].method, 'PATCH'); assert.equal(f.writes[1].path, `/api/return-assistant/queues/${f.head.id}`);
      await h.render({ completion: clone(completion) }); await tick(); assert.equal(f.writes.length, 2); assert.equal(f.reads.filter(p => p.includes('/return-destinations/operations/')).length, 1); await h.close();
    });
    await t.test('destinations operation identity and protocol mismatches refuse navigation without marking the receipt handled', async () => {
      for (const flaw of ['id', 'return_id', 'session_id', 'action', 'kind', 'protocol', 'snapshot_protocol', 'snapshot_session']) {
        reset(); const f = fixture(2), opened = []; f.settings.values.auto_next = true;
        const correct = { id: id(3020), kind: 'operation', protocol: 'destinations_v1', return_id: f.rows[0].id, session_id: id(3021), action: 'receive', snapshot: { protocol: 'destinations_v1', session: { id: id(3021), return_id: f.rows[0].id } } };
        let malformed = true;
        globalThis.fetch = async (url, options) => {
          if (url === `/api/return-destinations/operations/${correct.id}`) {
            assert.equal(options.method, 'GET'); f.reads.push(url); const operation = clone(correct);
            if (malformed) { if (flaw === 'snapshot_protocol') operation.snapshot.protocol = 'legacy'; else if (flaw === 'snapshot_session') operation.snapshot.session.id = id(3999); else operation[flaw] = ['id', 'return_id', 'session_id'].includes(flaw) ? id(3999) : 'wrong'; } else f.accepted.add(f.rows[0].id);
            return Response.json({ ...flags, operation });
          }
          assert.ok(!url.includes('/receipts/')); return f.fetch(url, options);
        };
        const completion = { returnId: f.rows[0].id, sessionId: correct.session_id, receiptId: correct.id, action: 'receive', protocol: 'destinations_v1' };
        const h = mount({ onOpenReturn: row => opened.push(row) }); await initial(h); await selectAll(h); await save(h); await h.render({ completion }); await until(() => h.container.textContent.includes('Pokwitowanie nie odpowiada'), flaw);
        for (let i = 0; i < 3; i++) await tick(); assert.equal(f.reads.filter(p => p.includes('/return-destinations/operations/')).length, 1, 'A failed read cannot loop automatically'); assert.equal(f.writes.length, 1); assert.equal(opened.length, 0); assert.equal(f.head.position, 0); await h.close();
        malformed = false; const resumed = mount({ completion, onOpenReturn: row => opened.push(row) }); await initial(resumed); await click(button(resumed, 'Odczytaj historię kolejek')); await until(() => resumed.container.textContent.includes('Wznów kolejkę z'), 'Read durable queue'); await click([...resumed.container.querySelectorAll('button')].find(b => b.textContent.startsWith('Wznów kolejkę z'))); await until(() => opened.length === 1, 'Invalid result was not globally marked handled'); assert.equal(opened[0].returnId, f.rows[1].id); assert.equal(f.writes.length, 2); await resumed.close();
      }
    });
    await t.test('semantically matching stale versions and missing operation metadata retain exact settings and queue retries', async () => {
      reset(); const f = fixture(2), locks = [], attempts = [], receipts = new Map(); let invalid = 'version';
      globalThis.fetch = async (url, options) => {
        if (options.method === 'GET') return f.fetch(url, options);
        const body = JSON.parse(options.body), key = body.client_key;
        attempts.push({ path: url, method: options.method, body: options.body });
        let reply;
        if (receipts.has(key)) reply = { ...clone(receipts.get(key)), reused: true };
        else { reply = await (await f.fetch(url, options)).json(); receipts.set(key, clone(reply)); }
        if (invalid === 'version') { if (reply.settings) reply.settings.version = body.version; else reply.queue.version = options.method === 'POST' ? '2' : body.version; }
        if (invalid === 'operation') delete reply.operation_id;
        if (invalid === 'reused') delete reply.reused;
        if (invalid === 'navigation' && reply.queue) reply.queue.navigation.auto_next = !body.navigation.auto_next;
        if (invalid === 'skipped' && reply.queue) reply.queue.skipped_return_ids = [f.rows[0].id];
        return Response.json(reply);
      };
      const h = mount({ onLockedChange: v => locks.push(v) }); await initial(h);
      await value(field(h, 'Źródło nazwy produktu'), 'current'); await click(button(h, 'Zapisz ustawienia prezentacji'));
      await until(() => h.container.textContent.includes('Wynik zapisu') && !button(h, 'Ponów dokładny zapis kolejki lub ustawień').disabled, 'Same values with old settings version remain unknown');
      assert.equal(locks.at(-1), true); const first = clone(attempts[0]);
      for (const flaw of ['operation', 'reused']) {
        invalid = flaw; const count = attempts.length; await click(button(h, 'Ponów dokładny zapis kolejki lub ustawień'));
        await until(() => attempts.length === count + 1 && !button(h, 'Ponów dokładny zapis kolejki lub ustawień').disabled, 'Incomplete operation metadata remains unknown');
        assert.deepEqual(attempts.at(-1), first); assert.equal(locks.at(-1), true);
      }
      invalid = null; await click(button(h, 'Ponów dokładny zapis kolejki lub ustawień')); await until(() => !h.container.textContent.includes('Wynik zapisu'), 'Exact settings receipt resolves retained write');
      assert.deepEqual(attempts.at(-1), first); assert.equal(locks.at(-1), false); assert.equal(f.writes.length, 1, 'Repeated requests do not apply settings twice');
      await selectAll(h); invalid = 'version'; await click(check(h, 'Sprawdziłem wszystkie wybrane sprawy')); await click(button(h, 'Zapisz kolejkę wybranych spraw'));
      await until(() => h.container.textContent.includes('Wynik zapisu') && !button(h, 'Ponów dokładny zapis kolejki lub ustawień').disabled, 'Create response must have version one');
      const create = clone(attempts.at(-1)); invalid = null; await click(button(h, 'Ponów dokładny zapis kolejki lub ustawień')); await until(() => h.container.textContent.includes('Zapisana kolejka'), 'Exact new queue receipt resolves'); assert.deepEqual(attempts.at(-1), create);
      await click(check(h, 'Otwieraj następną sprawę po zapisaniu decyzji w tej kolejce')); invalid = 'version'; await click(button(h, 'Zapisz ustawienia tej kolejki'));
      await until(() => h.container.textContent.includes('Wynik zapisu') && !button(h, 'Ponów dokładny zapis kolejki lub ustawień').disabled, 'Same position and navigation with stale PATCH version remain unknown');
      const update = clone(attempts.at(-1));
      for (const flaw of ['navigation', 'skipped']) {
        invalid = flaw; const count = attempts.length; await click(button(h, 'Ponów dokładny zapis kolejki lub ustawień'));
        await until(() => attempts.length === count + 1 && !button(h, 'Ponów dokładny zapis kolejki lub ustawień').disabled, 'Nonmatching queue result remains unknown');
        assert.deepEqual(attempts.at(-1), update); assert.equal(locks.at(-1), true);
      }
      invalid = null; await click(button(h, 'Ponów dokładny zapis kolejki lub ustawień')); await until(() => !h.container.textContent.includes('Wynik zapisu'), 'Exact queue update receipt resolves');
      assert.deepEqual(attempts.at(-1), update); assert.equal(f.head.version, '2'); assert.equal(locks.at(-1), false); assert.equal(f.writes.length, 3, 'Each underlying metadata mutation applies once'); await h.close();
    });
    await t.test('restore/viewer history and any manifest case inspection remain GET-only without lease restoration', async () => {
      const viewer = `${tenant}:${user}:viewer:true`; reset(viewer, true); const f = fixture(2), opened = []; f.f = { ...flags, read_only: true, current_role: 'viewer', can_write: false, can_save_settings: false, can_manage_queue: false }; f.makeQueue(f.rows.map(r => r.id)); globalThis.fetch = f.fetch;
      const h = mount({ contextKey: viewer, readOnly: true, write: false, onOpenReturn: v => opened.push(v) }); await initial(h); await click(button(h, 'Odczytaj historię kolejek')); await until(() => h.container.textContent.includes('Wznów kolejkę z'), 'Own header history'); await click([...h.container.querySelectorAll('button')].find(b => b.textContent.startsWith('Wznów kolejkę z'))); await until(() => h.container.textContent.includes('Zapisana kolejka'), 'Full readonly manifest'); await click(button(h, 'Przegląd RMA-2')); assert.equal(opened[0].returnId, f.rows[1].id); assert.equal(f.writes.length, 0); assert.equal(button(h, 'Następna sprawa').disabled, true); assert.equal(field(h, 'Źródło nazwy produktu').closest('fieldset').disabled, true); await h.close();
    });
    await t.test('late old workspace settings and queue references do not publish after actor replacement', async () => {
      reset(); let resolveOld, first = true; globalThis.fetch = async (url, options) => { assert.equal(options.method, 'GET'); assert.equal(url, '/api/return-assistant/settings'); if (first) { first = false; return await new Promise(resolve => { resolveOld = resolve; }); } return Response.json({ ...flags, current_role: 'viewer', can_write: false, can_save_settings: false, can_manage_queue: false, settings: { version: '0', values: defaults() } }); };
      const h = mount(); await h.render(); await until(() => !!resolveOld, 'Old settings read held'); const next = `${id(4000)}:${user}:viewer:false`; await act(async () => { api.setWorkspace(id(4000)); ui.resetReturnAssistantQueuesContext(next, false); }); await h.render({ contextKey: next, write: false }); await until(() => h.container.textContent.includes('Tryb odczytu'), 'Fresh actor read');
      await act(async () => { resolveOld(Response.json({ ...flags, settings: { version: '99', values: { ...defaults(), name_source: 'current', thumbnail_size: 'large' } } })); for (let i = 0; i < 6; ++i) await Promise.resolve(); await new Promise(resolve => setTimeout(resolve, 0)); }); assert.equal(field(h, 'Źródło nazwy produktu').value, 'historical'); assert.equal(field(h, 'Miniaturki produktów').value, 'none'); assert.ok(!h.container.textContent.includes('Zapisana kolejka')); await h.close();
    });
    await t.test('actual read-only presentation honors saved fields and sorting while preserving historical same-SKU identities; foreign metadata is hidden', async () => {
      const line1 = { item_id: id(4100), product_id: id(4101), ordinal: 1, sku: 'SAME', name: 'Historia tania', requested: 1, original_quantity: 2, line_total: 2000, components: [{ product_id: id(4101), quantity: 1 }] };
      const line2 = { ...line1, item_id: id(4102), ordinal: 2, name: 'Historia droga', original_quantity: 1, line_total: 1700 };
      const p = { return_id: id(4103), read_at: '2026-10-06T12:00:00Z', case: { number: 'RMA-PRESENTATION', order_number: 'ORDER-PRESENTATION', created_at: '2026-10-06T12:00:00Z', kind: 'return', customer: 'Visible own customer', commercial_value: 3700, currency: 'PLN' }, lines: [line1, line2].map((line, index) => ({ ...line, historical_name: line.name, current_catalog: { name: index ? 'Alpha aktualne' : 'Zebra aktualne', sku: 'CURRENT-SAME', ean: '123456', image_url: 'https://example.invalid/own-image.png' }, locations: [{ product_id: line.product_id, warehouse_id: id(4104), location: 'RMA-01', quantity: 4 }], stock: [{ product_id: line.product_id, warehouse_id: id(4104), on_hand: 4, reserved: 1, available: 3, version: '2' }] })) };
      const settings = { ...defaults(), name_source: 'current', product_sort: 'name', thumbnail_size: 'large', case_fields: ['number'], product_fields: ['ean', 'locations', 'stock'] };
      globalThis.fetch = async () => { throw Error('Presentation cannot fetch or mutate business data'); };
      const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
      try {
        await act(async () => root.render(React.createElement(presentationUI.ReturnAssistantPresentation, { presentation: p, settings, returnId: p.return_id, lines: [line1, line2] })));
        assert.ok(container.textContent.includes('RMA-PRESENTATION')); assert.ok(!container.textContent.includes('Visible own customer')); assert.ok(!container.textContent.includes('ORDER-PRESENTATION')); const headings = [...container.querySelectorAll('article h3')].map(h => h.textContent); assert.ok(headings[0].includes('Pozycja 2')); assert.ok(headings[1].includes('Pozycja 1')); assert.ok(container.textContent.includes('17,00 PLN')); assert.ok(container.textContent.includes('20,00 PLN')); assert.ok(container.textContent.includes('dostępne 3')); assert.ok(container.textContent.includes('123456')); assert.equal(container.querySelectorAll('img.raq-thumbnail.large').length, 2);
        assert.deepEqual([line1, line2].map(l => l.ordinal), [1, 2], 'Sorting never mutates frozen caller array');
        const ownImage = '/api/product-images/' + id(4110), ownPresentation = clone(p);
        ownPresentation.lines[0].current_catalog.image_url = ownImage;
        ownPresentation.lines[1].current_catalog.image_url = ownImage + '?secret=not-allowed';
        await act(async () => root.render(React.createElement(presentationUI.ReturnAssistantPresentation, { presentation: ownPresentation, settings, returnId: p.return_id, lines: [line1, line2] })));
        assert.equal(container.querySelectorAll('img.raq-thumbnail.large').length, 1, 'Only the exact own product-image UUID path is accepted');
        assert.equal(container.querySelector('img.raq-thumbnail.large').getAttribute('src'), ownImage, 'Existing own product image URI is preserved without rewriting');
        assert.ok(container.textContent.includes('Miniaturka niedostępna'), 'Unexpected relative query is refused rather than loaded');
        await act(async () => root.render(React.createElement(presentationUI.ReturnAssistantPresentation, { presentation: { ...p, return_id: id(4199), case: { ...p.case, customer: 'SECRET FOREIGN' } }, settings, returnId: p.return_id, lines: [line1, line2] })));
        assert.ok(container.textContent.includes('nie odpowiadają tej sprawie')); assert.ok(!container.textContent.includes('SECRET FOREIGN')); assert.equal(container.querySelectorAll('img').length, 0);
      } finally { await act(async () => root.unmount()); container.remove(); }
    });
  } finally {
    for (const h of mounts) if (h.container.isConnected) await h.close(); ui.resetReturnAssistantQueuesContext('', false); api.setWorkspace(null); await vite.close(); globalThis.fetch = originalFetch;
    for (const [key, value] of saved) { if (value) Object.defineProperty(globalThis, key, value); else delete globalThis[key]; } dom.window.close();
  }
});
