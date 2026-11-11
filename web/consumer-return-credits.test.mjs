/** Real React interactions with controlled local DTOs; no HTTP listener, database or provider. */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import vm from 'node:vm';
import React, {act} from 'react';
import {JSDOM} from 'jsdom';
import {createServer, transformWithOxc} from 'vite';
const id = n => `${String(n).padStart(8, '0')}-1000-4000-8000-000000000001`;
const tenant = id(1), user = id(2), order = id(3), ret = id(4), invoice = id(5), invoiceReceipt = id(6), returnReceipt = id(7), seriesId = id(8), previewId = id(9), docId = id(10), receiptId = id(11);
const context = tenant + ':' + user + ':operator', rootPath = '/api/consumer-return-credits';
const props = (patch = {}) => ({orderId: order, returnId: ret, contextKey: context, readOnly: false, externalWriteBlocked: false, onChanged() {}, ...patch});
const flags = (patch = {}) => ({available: true, can_read: true, can_preview: true, can_issue: true, read_only: false, current_role: 'operator', ...patch});
const money = (gross = '0', net = gross, vat = '0') => ({gross_minor: gross, net_minor: net, vat_minor: vat});
function calculation(zero = false) {
  const before = zero ? money() : money('1230', '1000', '230'), after = money(), delta = zero ? money() : money('-1230', '-1000', '-230');
  return {schema: 'consumer-return-credit-calculation/v2', currency: 'PLN', tax_method: 'gross_line_half_up', original_document_id: invoice, original_receipt_id: invoiceReceipt, original_number: 'FV/OWN/2026/000001', original_scope_hash: 'a'.repeat(64), return_id: ret, return_receipt_id: returnReceipt, receipt_sequence: 1, financial_hash: 'b'.repeat(64), previous_chain_hash: 'c'.repeat(64), physical_history_hash: 'd'.repeat(64), rows: [
    {ordinal: 0, kind: 'item', item_id: id(12), product_id: id(13), name: 'Własny produkt', sku: 'SKU', unit: 'szt.', vat_rate: 23, before: {...before, quantity: '1'}, after: {...after, quantity: '0'}, delta: {...delta, quantity: '-1'}, affected: true},
    {ordinal: 1, kind: 'shipping', item_id: null, product_id: null, name: 'Dostawa', sku: '', unit: 'usł.', vat_rate: 23, before: {...money(), quantity: '1'}, after: {...money(), quantity: '1'}, delta: {...money(), quantity: '0'}, affected: false},
  ], totals: {before, after, delta}, vat_totals: [{vat_rate: 23, before, after, delta}]};
}
const serie = () => ({id: seriesId, version: '7', name: 'Korekty zwrotów', prefix: 'KOR-ZWROT', enabled: true});
const original = () => ({document: {id: invoice, order_id: order, kind: 'invoice', mode: 'local_invoice', number: 'FV/OWN/2026/000001'}, receipt: {id: invoiceReceipt}});
const source = (patch = {}) => ({...flags(), original: original(), acceptances: [], previous_credits: [], credit_families: [], physical_protocols: [], series: [serie()], next_return_id: ret, current_return_version: '5', eligible: true, eligibility_reason: null, calculation: calculation(), physical_history_hash: 'd'.repeat(64), ...patch});
function preview(body) {
  return {id: previewId, original_document_id: invoice, return_id: ret, scope_hash: 'e'.repeat(64), calculation_hash: 'f'.repeat(64), expires_at: '2050-01-01T00:00:00Z', can_issue: true, issued_document_id: null, snapshot: {schema: 'consumer-return-credit/v2', original_document: original().document, correction_series: structuredClone(f.source.series.find(s => s.id === body.series_id) ?? serie()), calculation: f.source.calculation, reason: body.reason, return_version: body.expected_return_version, issue_date: '2026-10-17', local_only: true, ksef_state: 'not_submitted', fiscalized: false}};
}
let f;
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return {promise, resolve}; };
test('ordinary consumer credit UI: strategy, series, exact custody and quantity/money distinctions', async t => {
  const dom = new JSDOM('<!doctype html><body/>', {url: 'http://127.0.0.1/'}), saved = new Map(), oldFetch = globalThis.fetch;
  for (const [k, v] of Object.entries({window: dom.window, document: dom.window.document, navigator: dom.window.navigator, localStorage: dom.window.localStorage, HTMLElement: dom.window.HTMLElement, Event: dom.window.Event, MouseEvent: dom.window.MouseEvent, IS_REACT_ACT_ENVIRONMENT: true})) { saved.set(k, Object.getOwnPropertyDescriptor(globalThis, k)); Object.defineProperty(globalThis, k, {configurable: true, writable: true, value: v}); }
  const vite = await createServer({server: {middlewareMode: true, hmr: false, ws: false, watch: null}, appType: 'custom', logLevel: 'error'});
  const {createRoot} = await import('react-dom/client');
  const {LocalConsumerCreditPanel, consumerCreditsLocked} = await vite.ssrLoadModule(path.resolve('web/local-consumer-credits.tsx'));
  const {ConsumerReturnCreditRegister} = await vite.ssrLoadModule(path.resolve('web/consumer-return-credits.tsx'));
  const {ReturnsPanel} = await vite.ssrLoadModule(path.resolve('web/returns.tsx'));
  const api = await vite.ssrLoadModule(path.resolve('web/api.ts')), handles = [];
  const lockName = 'dyna:consumer-return-credit:v1:' + tenant + ':' + user + ':exclusive', activeLocks = new Set();
  const locks = {async request(name, options, fn) {
    assert.equal(name, lockName); assert.deepEqual(options, {mode: 'exclusive', ifAvailable: true});
    if (f.webLockBusy || activeLocks.has(name)) return fn(null);
    activeLocks.add(name); try { return await fn({name, mode: 'exclusive'}); } finally { activeLocks.delete(name); }
  }};
  const setLocks = value => Object.defineProperty(navigator, 'locks', {configurable: true, value});
  const storageProto = Object.getPrototypeOf(localStorage), removeItem = storageProto.removeItem;
  storageProto.removeItem = function(key) { if (key === 'dyna:consumer-return-credit:v1:' + tenant + ':' + user) assert(activeLocks.has(lockName), 'custody clear must remain inside the actor lock'); return removeItem.call(this, key); };
  function reset() {
    assert.equal(activeLocks.size, 0); setLocks(locks); localStorage.clear(); api.setWorkspace(tenant);
    f = {calls: [], source: source(), strategy: {order_id: order, strategy: 'destinations', available: true, read_only: false}, commands: new Map(), me: 0, mePatch: {}, postMode: '', previewPatch: null, sourceHold: null, posts: []};
    globalThis.fetch = async (url, init = {}) => {
      const u = new URL(String(url), 'http://127.0.0.1'); assert.equal(u.origin, 'http://127.0.0.1'); assert.equal(new Headers(init.headers).get('X-Workspace-ID'), tenant);
      const body = init.body ? JSON.parse(init.body) : undefined; f.calls.push({path: u.pathname + u.search, method: init.method, body});
      if (u.pathname === '/api/auth/me') { f.me++; return Response.json({restore_preview: false, user: {id: user, tenant_id: tenant, role: 'operator'}, ...f.mePatch, ...(f.demoteAt && f.me >= f.demoteAt ? {user: {id: user, tenant_id: tenant, role: 'viewer'}} : {})}); }
      if (u.pathname === '/api/b2b/dropshipping-returns/returns/' + ret + '/context') { assert.equal(init.method, 'GET'); return Response.json({detail: 'Poza zakresem tego kontrolowanego scenariusza'}, {status: 404}); }
      if (u.pathname.endsWith('/strategy')) return f.strategyStatus ? Response.json({detail: 'PRIVATE_SQL_207'}, {status: f.strategyStatus}) : Response.json(f.strategy);
      if (u.pathname.startsWith('/api/local-consumer-credits/')) { assert.equal(init.method, 'GET'); assert(u.pathname.endsWith('/source')); return f.legacyStatus ? Response.json({detail: 'PRIVATE_SQL_188_206_207'}, {status: f.legacyStatus}) : Response.json({original: original(), previous_credits: [], eligible: false}); }
      if (u.pathname === rootPath + '/orders/' + order + '/source') return f.sourceHold ? f.sourceHold.promise : Response.json(f.source);
      if (u.pathname === rootPath + '/documents') return Response.json({...flags(f.readOnly ? {read_only: true, can_preview: false, can_issue: false} : {}), data: f.register ?? [], next_cursor: f.cursor ?? null});
      if (u.pathname === rootPath + '/previews/' + previewId && init.method === 'GET') return Response.json({...flags(), preview: f.p});
      if (u.pathname === rootPath + '/documents/' + docId && init.method === 'GET') return Response.json({...flags(f.readOnly ? {read_only: true, can_preview: false, can_issue: false} : {}), ...f.issued});
      if (u.pathname.startsWith(rootPath + '/commands/')) { assert(activeLocks.has(lockName), 'manual command lookup must remain inside the actor lock'); assert.equal(init.method, 'GET'); const key = u.pathname.split('/').at(-1), command = f.commands.get(key); assert.equal(u.searchParams.get('operation'), command?.operation); if (f.commandHold) return f.commandHold.promise; return command ? Response.json(f.commandPatch ? {...command, ...f.commandPatch} : command) : Response.json({detail: 'Not found'}, {status: 404}); }
      assert.equal(init.method, 'POST'); assert(u.pathname.startsWith(rootPath)); assert(activeLocks.has(lockName), 'every series/preview/issue POST must remain inside the actor lock'); const retained = JSON.parse(localStorage.getItem('dyna:consumer-return-credit:v1:' + tenant + ':' + user)); assert.equal(retained.schema, 'consumer-return-credit-custody/v3'); assert.equal(retained.clientKey, body.client_key); assert.equal(retained.method, init.method); assert.equal('/api' + retained.resource, u.pathname); assert.deepEqual(retained.requestBody, body); assert(Buffer.byteLength(JSON.stringify(retained)) <= 4096); f.posts.push({path: u.pathname, body});
      let command;
      if (u.pathname === rootPath + '/series') { assert.deepEqual(Object.keys(body).sort(), ['client_key', 'name', 'prefix']); assert.equal(body.name, f.desiredSeries?.name ?? 'Korekty zwrotów'); assert.equal(body.prefix, f.desiredSeries?.prefix ?? 'KOR-ZWROT'); const created = {...serie(), id: f.createdSeriesId ?? seriesId, name: body.name, prefix: body.prefix}; f.source = {...f.source, series: [...f.source.series, created]}; command = {...flags(), operation: 'series', series: created}; }
      else if (u.pathname === rootPath + '/previews') { assert.deepEqual(Object.keys(body).sort(), ['client_key', 'expected_return_version', 'expected_series_version', 'local_only', 'ordinary_domestic_confirmed', 'original_document_id', 'reason', 'return_id', 'series_id']); assert.equal(body.original_document_id, invoice); assert.equal(body.return_id, ret); assert.equal(body.expected_return_version, '5'); assert.equal(body.expected_series_version, '7'); assert.equal(body.series_id, f.expectedSeriesId ?? seriesId); assert.equal(body.ordinary_domestic_confirmed, true); assert.equal(body.local_only, true); f.p = {...preview(body), ...f.previewPatch}; command = {...flags(), operation: 'preview', preview: f.p}; }
      else { assert.equal(u.pathname, rootPath + '/previews/' + previewId + '/issue'); assert.deepEqual(Object.keys(body).sort(), ['client_key', 'confirmed', 'local_only', 'scope_hash']); assert.equal(body.scope_hash, f.p.scope_hash); assert.equal(body.confirmed, true); assert.equal(body.local_only, true);
        const number = 'KOR-ZWROT/2026/000001';
        f.issued = {document: {id: docId, order_id: order, return_id: ret, original_document_id: invoice, kind: 'correction', mode: 'consumer_return_credit', number, created_at: '2026-10-17T10:00:00Z', data: {...f.p.snapshot, number, preview_id: previewId, scope_hash: f.p.scope_hash, year: 2026, sequence: 1}}, receipt: {id: receiptId, document_id: docId, preview_id: previewId, original_document_id: invoice, original_receipt_id: invoiceReceipt, return_id: ret, return_receipt_id: returnReceipt, receipt_sequence: 1, client_key: body.client_key, scope_hash: f.p.scope_hash, calculation_hash: f.p.calculation_hash, year: 2026, sequence: 1, number, actor_id: user, api_key_id: null}};
        command = {...flags(), operation: 'issue', ...f.issued};
      }
      command = {...command, client_key: body.client_key, actor_id: user, api_key_id: null, reused: false}; f.commands.set(body.client_key, command);
      if (f.postMode === 'lost') throw Error('Connection lost after server command');
      if (f.postMode === 'hold') return f.postHold.promise;
      if (f.postMode === 'rollback') return Response.json({detail: 'PRIVATE_SQL_207', write_outcome: 'failed_before_write', actor_id: user, tenant_id: tenant, operation: command.operation, client_key: body.client_key}, {status: 409});
      if (f.postMode === 'foreignRollback') return Response.json({write_outcome: 'failed_before_write', actor_id: id(99), tenant_id: tenant, operation: command.operation, client_key: body.client_key}, {status: 409});
      return Response.json(command, {status: 201});
    };
  }
  const tick = () => act(async () => { await new Promise(r => setTimeout(r, 0)); });
  async function until(fn) { for (let n = 0; n < 70; n++) { if (fn()) return; await tick(); } assert(fn(), 'React did not settle'); }
  async function mount(p = props(), Component = LocalConsumerCreditPanel) { const el = document.createElement('div'); document.body.append(el); const r = createRoot(el), h = {el, async render(next) { await act(async () => r.render(React.createElement(Component, next))); }, async close() { if (el.isConnected) { await act(async () => r.unmount()); el.remove(); } }}; handles.push(h); await h.render(p); return h; }
  const button = (h, label) => [...h.el.querySelectorAll('button')].find(b => b.textContent === label);
  async function click(h, label) { const b = button(h, label); assert(b && !b.disabled, label); await act(async () => b.dispatchEvent(new MouseEvent('click', {bubbles: true}))); }
  async function confirm(h) { const c = h.el.querySelector('[aria-label="Potwierdzenie korekty"]'); assert(c && !c.disabled); await act(async () => c.dispatchEvent(new MouseEvent('click', {bubbles: true}))); }
  async function input(h, label, value) { const el = h.el.querySelector(`[aria-label="${label}"]`); assert(el && !el.disabled); await act(async () => { Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, value); el.dispatchEvent(new Event('input', {bubbles: true})); }); }
  const ready = h => until(() => h.el.textContent.includes('Faktura źródłowa:'));
  const safe = h => { for (const s of ['PRIVATE_SQL', 'consumer-return-credit/v2', 'destinations', 'no_commercial_change', '207', '206', '188', tenant, user]) assert(!h.el.textContent.includes(s), s); };
  const postCount = () => f.calls.filter(c => c.method === 'POST').length;
  try {
    await t.test('independent execution contexts serialize actual durable custody through lost ACK and manual recovery', async () => {
      reset();
      const plain = async file => (await transformWithOxc(fs.readFileSync(path.resolve(file), 'utf8'), file)).code.replace(/^import .*$/gm, '').replace(/\nexport\s*\{[\s\S]*?\};?\s*$/, '').replace(/^export /gm, '');
      const script = await plain('web/consumer-return-credit-lock.ts') + '\n' + await plain('web/consumer-return-credits.tsx');
      const shared = new Map(), storage = () => ({getItem: key => shared.get(key) ?? null, setItem: (key, value) => shared.set(key, value), removeItem: key => shared.delete(key)});
      let locked = false, postsA = 0, postsB = 0, recoverReads = 0;
      const release = deferred(), primitive = async (name, options, fn) => { assert.equal(name, lockName); assert.equal(options.mode, 'exclusive'); assert.equal(options.ifAvailable, true); if (locked) return fn(null); locked = true; try { return await fn({name, mode: 'exclusive'}); } finally { locked = false; } };
      const tab = () => vm.runInNewContext(script + ';({read,retain,clear,withReturnCreditCustodyLock})', {navigator: {locks: {request: primitive}}, localStorage: storage(), TextEncoder});
      const A = tab(), B = tab(), actor = tenant + ':' + user;
      const heldA = {schema: 'consumer-return-credit-custody/v2', actor, operation: 'preview', clientKey: id(80), orderId: order, returnId: ret, previewId: null, seriesName: null, seriesPrefix: null}, heldB = {...heldA, clientKey: id(81)};
      assert.equal(A.read(actor), null); assert.equal(B.read(actor), null);
      const first = A.withReturnCreditCustodyLock(actor, async () => { A.retain(heldA); postsA++; await release.promise; throw Error('ACK lost A'); });
      const lost = assert.rejects(first, /ACK lost A/);
      await assert.rejects(B.withReturnCreditCustodyLock(actor, async () => { B.retain(heldB); postsB++; }), /Inna karta/);
      assert.equal(postsA, 1); assert.equal(postsB, 0); release.resolve(); await lost;
      await assert.rejects(B.withReturnCreditCustodyLock(actor, async () => { B.retain(heldB); postsB++; }));
      await assert.rejects(B.withReturnCreditCustodyLock(actor, async () => B.clear(heldB)));
      assert.equal(postsB, 0); assert.equal(JSON.stringify(tab().read(actor)), JSON.stringify(heldA));
      await B.withReturnCreditCustodyLock(actor, async () => { recoverReads++; assert.equal(JSON.stringify(B.read(actor)), JSON.stringify(heldA)); B.clear(heldA); });
      assert.equal(recoverReads, 1); assert.equal(A.read(actor), null); assert.equal(postsA + postsB, 1);
      // Different tenants/users do not share the same lock, even with the same order.
      const H = await vite.ssrLoadModule(path.resolve('web/consumer-return-credit-lock.ts'));
      for (const foreignActor of [id(91) + ':' + user, tenant + ':' + id(92)]) await H.withReturnCreditCustodyLock(foreignActor, async () => {}, {async request(name, options, fn) { assert.equal(name, 'dyna:consumer-return-credit:v1:' + foreignActor + ':exclusive'); return fn({name}); }});
      await assert.rejects(H.withReturnCreditCustodyLock('bad actor', async () => { throw Error('must not run'); }, locks));
    });
    await t.test('strategy unavailable, missing route or malformed DTO never falls back to legacy source', async () => {
      for (const patch of [{strategy: {order_id: order, strategy: 'destinations', available: false, read_only: false}}, {strategyStatus: 404}, {strategy: {order_id: id(90), strategy: 'legacy', available: true, read_only: false}}, {strategy: {order_id: order, strategy: 'destinations', available: true}}, {strategy: {order_id: order, strategy: 'other', available: true, read_only: false}}]) {
        reset(); Object.assign(f, patch); const h = await mount(); await until(() => h.el.querySelector('[role="alert"]')); assert(!f.calls.some(c => c.path.includes('/source'))); assert.equal(postCount(), 0); safe(h); await h.close();
      }
      reset(); f.strategy.strategy = 'legacy'; const h = await mount(); await until(() => f.calls.some(c => c.path.startsWith('/api/local-consumer-credits/'))); assert(!f.calls.some(c => c.path.startsWith(rootPath + '/orders/' + order + '/source'))); assert.equal(postCount(), 0); await h.close();
      reset(); f.strategy.strategy = 'legacy'; f.legacyStatus = 503; const error = await mount(); await until(() => error.el.querySelector('[role="alert"]')); safe(error); assert.equal(postCount(), 0); await error.close();
    });
    await t.test('mount only reads source; explicit preview and issue send exact current versions and show persisted number/print', async () => {
      reset(); let changed = 0; const h = await mount(props({onChanged() { changed++; }})); await ready(h); assert.equal(postCount(), 0); assert(!h.el.textContent.includes('KOR-ZWROT/2026/')); assert(button(h, 'Przygotuj podgląd korekty').disabled); safe(h);
      await confirm(h); await click(h, 'Przygotuj podgląd korekty'); await until(() => button(h, 'Wystaw numerowaną korektę')); assert.equal(postCount(), 1); assert(h.el.textContent.includes('-12,30 PLN')); assert(button(h, 'Wystaw numerowaną korektę').disabled); assert(!consumerCreditsLocked(context)); assert(!h.el.querySelector('a[href*="/consumer-return-credits/documents/"]'));
      await confirm(h); await click(h, 'Wystaw numerowaną korektę'); await until(() => h.el.textContent.includes('KOR-ZWROT/2026/000001')); assert.equal(postCount(), 2); assert.equal(changed, 1); assert.equal(h.el.querySelector('a[href*="/consumer-return-credits/documents/"]').getAttribute('href'), rootPath + '/documents/' + docId + '/print'); assert.notEqual(f.posts[0].body.client_key, f.posts[1].body.client_key); assert(!consumerCreditsLocked(context)); safe(h); await h.close();
    });
    await t.test('missing or busy Web Locks refuse all three UI commands before IAM, retention or POST', async () => {
      for (const unavailable of ['missing', 'busy']) for (const operation of ['series', 'preview', 'issue']) {
        reset(); if (operation === 'series') f.source = source({series: []});
        const h = await mount(); await ready(h);
        if (operation === 'issue') { await confirm(h); await click(h, 'Przygotuj podgląd korekty'); await until(() => button(h, 'Wystaw numerowaną korektę')); }
        if (operation !== 'series') await confirm(h);
        const before = postCount(), meBefore = f.me;
        setLocks(unavailable === 'missing' ? undefined : locks); f.webLockBusy = unavailable === 'busy';
        await click(h, operation === 'series' ? 'Utwórz serię korekt' : operation === 'preview' ? 'Przygotuj podgląd korekty' : 'Wystaw numerowaną korektę');
        await until(() => h.el.querySelector('[role="alert"]')); assert.equal(postCount(), before); assert.equal(f.me, meBefore); assert(!consumerCreditsLocked(context)); assert.equal(activeLocks.size, 0); await h.close();
      }
    });
    await t.test('missing or busy lock preserves v1/v2 original series custody; explicit recovery alone uses original GET', async () => {
      for (const schema of ['consumer-return-credit-custody/v1', 'consumer-return-credit-custody/v2']) for (const unavailable of ['missing', 'busy']) {
        reset(); f.source = source({series: []}); f.postMode = 'lost'; let h = await mount(); await ready(h); await click(h, 'Utwórz serię korekt'); await until(() => h.el.textContent.includes('Nie potwierdzono wyniku')); await h.close();
        const key = 'dyna:consumer-return-credit:v1:' + tenant + ':' + user, original = JSON.parse(localStorage.getItem(key));
        original.schema = schema; delete original.method; delete original.resource; delete original.requestBody; if (schema.endsWith('/v1')) { delete original.seriesName; delete original.seriesPrefix; } localStorage.setItem(key, JSON.stringify(original));
        const exact = localStorage.getItem(key); f.postMode = ''; setLocks(unavailable === 'missing' ? undefined : locks); f.webLockBusy = unavailable === 'busy';
        h = await mount(); await ready(h); const before = f.calls.length; assert(!f.calls.some(c => c.path.includes('/commands/')));
        await click(h, 'Odczytaj oryginalny wynik'); await until(() => h.el.textContent.includes('Zapisana próba nadal'));
        assert.equal(f.calls.length, before); assert.equal(localStorage.getItem(key), exact); assert.equal(postCount(), 1);
        setLocks(locks); f.webLockBusy = false; await click(h, 'Odczytaj oryginalny wynik'); await until(() => !consumerCreditsLocked(context));
        assert.deepEqual(f.calls.filter(c => c.path.includes('/commands/')).map(c => [c.method, c.path]), [['GET', rootPath + '/commands/' + original.clientKey + '?operation=series']]); assert.equal(postCount(), 1); await h.close();
      }
    });
    await t.test('manual recovery keeps the lock through delayed readback and fresh IAM; second panel cannot reconcile or clear it', async () => {
      reset(); f.postMode = 'lost'; const first = await mount(); await ready(first); await confirm(first); await click(first, 'Przygotuj podgląd korekty'); await until(() => first.el.textContent.includes('Nie potwierdzono wyniku'));
      const original = localStorage.getItem('dyna:consumer-return-credit:v1:' + tenant + ':' + user), second = await mount(); await ready(second); f.commandHold = deferred();
      await click(first, 'Odczytaj oryginalny wynik'); await until(() => f.calls.filter(c => c.path.includes('/commands/')).length === 1); assert(activeLocks.has(lockName));
      await click(second, 'Odczytaj oryginalny wynik'); await until(() => second.el.textContent.includes('Zapisana próba nadal')); assert.equal(f.calls.filter(c => c.path.includes('/commands/')).length, 1); assert.equal(localStorage.getItem('dyna:consumer-return-credit:v1:' + tenant + ':' + user), original);
      f.mePatch = {restore_preview: true}; const command = f.commands.get(JSON.parse(original).clientKey); await act(async () => f.commandHold.resolve(Response.json(command))); await until(() => !activeLocks.has(lockName));
      assert.equal(localStorage.getItem('dyna:consumer-return-credit:v1:' + tenant + ':' + user), original); assert(consumerCreditsLocked(context)); assert.equal(postCount(), 1); await first.close(); await second.close();
      f.commandHold = null; f.mePatch = {}; const remount = await mount(); await ready(remount); assert.equal(postCount(), 1); await click(remount, 'Odczytaj oryginalny wynik'); await until(() => !consumerCreditsLocked(context)); assert.equal(postCount(), 1); await remount.close();
    });
    await t.test('failed journal write and a newly pending legacy financial command still refuse dispatch inside the lock', async () => {
      reset(); const quota = await mount(); await ready(quota); await confirm(quota); const setItem = storageProto.setItem;
      storageProto.setItem = function() { throw Error('controlled storage quota exceeded'); };
      try { await click(quota, 'Przygotuj podgląd korekty'); await until(() => quota.el.querySelector('[role="alert"]')); assert.equal(postCount(), 0); assert(!consumerCreditsLocked(context)); assert.equal(activeLocks.size, 0); } finally { storageProto.setItem = setItem; await quota.close(); }
      reset(); const h = await mount(); await ready(h); await confirm(h); const waiting = deferred(); f.sourceHold = waiting;
      await click(h, 'Przygotuj podgląd korekty'); await until(() => activeLocks.has(lockName));
      const legacyKey = 'dyna:consumer-credit:v1:' + tenant + ':' + user, original = JSON.stringify({schema: 'consumer-credit-custody/v1', actor: tenant + ':' + user, operation: 'preview', clientKey: id(86), orderId: id(87), returnId: id(88), previewId: null});
      localStorage.setItem(legacyKey, original); await act(async () => waiting.resolve(Response.json(f.source))); await until(() => h.el.querySelector('[role="alert"]'));
      assert.equal(postCount(), 0); assert.equal(localStorage.getItem(legacyKey), original); assert(consumerCreditsLocked(context)); assert.equal(activeLocks.size, 0); await h.close();
    });
    await t.test('no commercial change has no write controls or fictitious number; zero-price quantity return still permits preview', async () => {
      reset(); f.source = source({eligible: false, eligibility_reason: 'no_commercial_change', calculation: null}); const h = await mount(); await ready(h); assert(h.el.textContent.includes('nie zmienia ilości ani wartości')); assert(h.el.textContent.includes('Nie powstaje dokument ani numer')); assert.equal(h.el.querySelectorAll('button').length, 0); assert.equal(postCount(), 0); safe(h); await h.close();
      reset(); f.source = source({calculation: calculation(true)}); const zero = await mount(); await ready(zero); await confirm(zero); await click(zero, 'Przygotuj podgląd korekty'); await until(() => !!zero.el.querySelector('table')); assert(zero.el.textContent.includes('Łączna korekta 0,00 PLN')); assert(zero.el.textContent.includes('1 / 0')); assert.equal(postCount(), 1); await zero.close();
    });
    await t.test('actual ReturnsPanel embeds a sealed all-rejected inspection without inventing financial receipt or legacy fallback', async () => {
      const returnsProps = () => ({contextKey: context, readOnly: false, write: false, onChanged() {}, order: {id: order, number: 'ZAM-LOCAL', version: '9', status: 'completed', currency: 'PLN', items: [], documents: [{id: invoice, mode: 'local_invoice', kind: 'invoice'}], returns: {items: [], meta: {cursor: null}, cases: [{id: ret, order_id: order, version: '4', number: 'ZW/2026/000001', kind: 'return', state: 'rejected', received_at: null, accepted_at: null, receipt_sequence: 0, legacy: false, created_at: '2026-10-17T10:00:00Z', reason: 'Towar nie został przyjęty', items: [], stock_receipts: []}]}}});
      reset(); f.source = source({acceptances: [], rejected_inspections: [{return_id: ret, receipt_id: id(40), completed_at: '2026-10-17T10:00:00.000001Z', evidence_hash: 'a'.repeat(64)}], current_return_version: null, next_return_id: null, eligible: false, eligibility_reason: 'no_commercial_change', calculation: null});
      const h = await mount(returnsProps(), ReturnsPanel); await until(() => h.el.textContent.includes('Nie powstaje dokument ani numer')); assert(h.el.textContent.includes('Odrzucone')); assert.equal(postCount(), 0); assert(!h.el.querySelector('a[href*="consumer-credits"]')); assert(!button(h, 'Przygotuj podgląd korekty')); assert(!button(h, 'Utwórz serię korekt')); safe(h); await h.close();
      reset(); f.strategy.strategy = 'legacy'; const ordinary = await mount(returnsProps(), ReturnsPanel); await until(() => f.calls.filter(c => c.path === '/api/auth/me').length >= 2); await tick(); assert(!f.calls.some(c => c.path.startsWith('/api/local-consumer-credits/'))); assert(!f.calls.some(c => c.path.includes('/consumer-return-credits/orders/') && c.path.includes('/source'))); assert(!ordinary.el.textContent.includes('Korekta do zwrotu')); assert.equal(postCount(), 0); await ordinary.close();
      reset(); f.strategy.available = false; const unavailable = await mount(returnsProps(), ReturnsPanel); await until(() => unavailable.el.textContent.includes('Korekta jest obecnie niedostępna')); assert(!f.calls.some(c => c.path.startsWith('/api/local-consumer-credits/'))); assert.equal(postCount(), 0); safe(unavailable); await unavailable.close();
    });
    await t.test('series creation is explicit, business named and journalled before POST', async () => {
      reset(); f.source = source({series: []}); const h = await mount(); await ready(h); assert.equal(postCount(), 0); assert(!button(h, 'Przygotuj podgląd korekty')); f.postMode = 'lost'; await click(h, 'Utwórz serię korekt'); await until(() => h.el.textContent.includes('Nie potwierdzono wyniku')); assert(consumerCreditsLocked(context)); assert.equal(postCount(), 1); f.postMode = ''; await click(h, 'Odczytaj oryginalny wynik'); await until(() => !!button(h, 'Przygotuj podgląd korekty')); assert.equal(postCount(), 1); assert(!consumerCreditsLocked(context)); assert(f.calls.some(c => c.path.includes('?operation=series'))); safe(h); await h.close();
    });
    await t.test('custom business series retains exact desired name/prefix across lost ACK and remount', async () => {
      reset(); f.source = source({series: []}); f.desiredSeries = {name: 'Korekty drugiego magazynu', prefix: 'ZWROT-MAG2'}; f.postMode = 'lost'; let h = await mount(); await ready(h);
      await input(h, 'Nazwa serii korekt', f.desiredSeries.name); await input(h, 'Prefiks serii korekt', 'zły/prefiks'); assert(button(h, 'Utwórz serię korekt').disabled); assert.equal(postCount(), 0);
      await input(h, 'Prefiks serii korekt', f.desiredSeries.prefix); await click(h, 'Utwórz serię korekt'); await until(() => consumerCreditsLocked(context)); assert.equal(postCount(), 1);
      const held = JSON.parse(localStorage.getItem('dyna:consumer-return-credit:v1:' + tenant + ':' + user)); assert.equal(held.seriesName, f.desiredSeries.name); assert.equal(held.seriesPrefix, f.desiredSeries.prefix); await h.close();
      f.postMode = ''; h = await mount(); await ready(h); const command = f.commands.get(held.clientKey); f.commandPatch = {series: {...command.series, prefix: 'INNY'}};
      await click(h, 'Odczytaj oryginalny wynik'); await until(() => h.el.textContent.includes('Zapisana próba nadal')); assert(consumerCreditsLocked(context)); f.commandPatch = null;
      await click(h, 'Odczytaj oryginalny wynik'); await until(() => !consumerCreditsLocked(context)); await ready(h); assert(h.el.textContent.includes('Korekty drugiego magazynu')); assert(h.el.textContent.includes('ZWROT-MAG2')); assert.equal(postCount(), 1); await h.close();
    });
    await t.test('another numbering series can be added without replacing the existing one; capacity and an active preview block it', async () => {
      reset(); const originalSeries = structuredClone(f.source.series); f.createdSeriesId = id(99); f.desiredSeries = {name: 'Druga numeracja', prefix: 'ZWROT-DRUGI'};
      const h = await mount(); await ready(h); await click(h, 'Dodaj serię korekt'); assert(!button(h, 'Przygotuj podgląd korekty')); await click(h, 'Anuluj dodawanie serii'); assert.equal(postCount(), 0);
      await click(h, 'Dodaj serię korekt'); await input(h, 'Nazwa serii korekt', f.desiredSeries.name); await input(h, 'Prefiks serii korekt', f.desiredSeries.prefix); await click(h, 'Utwórz serię korekt');
      await until(() => !!button(h, 'Przygotuj podgląd korekty')); assert.equal(postCount(), 1); assert.equal(f.source.series.length, 2); assert.deepEqual(f.source.series[0], originalSeries[0]); assert.equal(h.el.querySelector('[aria-label="Seria korekt"]').value, id(99)); assert(!consumerCreditsLocked(context)); await h.close();
      reset(); f.source.series = Array.from({length: 100}, (_, n) => ({...serie(), id: id(1000 + n), prefix: 'ZWROT-' + n})); const full = await mount(); await ready(full); assert(button(full, 'Dodaj serię korekt').disabled); assert.equal(postCount(), 0); await full.close();
      reset(); const previewed = await mount(); await ready(previewed); await confirm(previewed); await click(previewed, 'Przygotuj podgląd korekty'); await until(() => !!button(previewed, 'Wystaw numerowaną korektę')); assert(button(previewed, 'Dodaj serię korekt').disabled); await previewed.close();
    });
    await t.test('unknown ACK remains locked across remount; only explicit exact command GET recovers, never replay POST', async () => {
      reset(); f.postMode = 'lost'; let h = await mount(); await ready(h); await confirm(h); await click(h, 'Przygotuj podgląd korekty'); await until(() => consumerCreditsLocked(context)); assert.equal(postCount(), 1); const key = f.posts[0].body.client_key;
      for (let n = 0; n < 4; n++) await tick(); assert(!f.calls.some(c => c.path.includes('/commands/'))); await h.close(); f.postMode = ''; h = await mount(); await ready(h); assert(button(h, 'Przygotuj podgląd korekty').disabled); assert.equal(postCount(), 1);
      f.commandPatch = {actor_id: id(90)}; await click(h, 'Odczytaj oryginalny wynik'); await until(() => h.el.textContent.includes('Zapisana próba nadal')); assert(consumerCreditsLocked(context)); assert(!h.el.querySelector('table')); f.commandPatch = null;
      await click(h, 'Odczytaj oryginalny wynik'); await until(() => !!button(h, 'Wystaw numerowaną korektę')); assert(!consumerCreditsLocked(context)); assert.equal(postCount(), 1); assert(f.calls.filter(c => c.path.includes('/commands/')).every(c => c.path === rootPath + '/commands/' + key + '?operation=preview' && c.method === 'GET')); await h.close();
    });
    await t.test('v3 preview persists original reason/body and versions across reload; recovery ignores changed form and current series', async () => {
      reset(); f.postMode = 'lost'; let h = await mount(); await ready(h);
      const originalReason = 'Uzgodniony zwrot z uszkodzonym opakowaniem';
      await input(h, 'Przyczyna korekty', originalReason); await confirm(h); await click(h, 'Przygotuj podgląd korekty'); await until(() => h.el.textContent.includes('Nie potwierdzono wyniku'));
      const key = 'dyna:consumer-return-credit:v1:' + tenant + ':' + user, raw = localStorage.getItem(key), held = JSON.parse(raw);
      assert.equal(held.schema, 'consumer-return-credit-custody/v3'); assert.equal(held.resource, '/consumer-return-credits/previews'); assert.equal(held.method, 'POST'); assert.deepEqual(held.requestBody, f.posts[0].body); assert.equal(held.requestBody.reason, originalReason); assert.equal(held.requestBody.expected_return_version, '5'); assert.equal(held.requestBody.expected_series_version, '7');
      await h.close(); f.postMode = ''; f.source.current_return_version = '6'; f.source.series[0].version = '8'; h = await mount(); await ready(h);
      assert.equal(localStorage.getItem(key), raw); assert.equal(postCount(), 1); assert.equal(h.el.querySelector('[aria-label="Przyczyna korekty"]').value, 'Zwrot towaru');
      await click(h, 'Odczytaj oryginalny wynik'); await until(() => !consumerCreditsLocked(context)); assert.equal(postCount(), 1); assert(button(h, 'Wystaw numerowaną korektę')); assert.equal(f.p.snapshot.reason, originalReason); assert.equal(f.p.snapshot.return_version, '5'); assert.equal(f.p.snapshot.correction_series.version, '7'); assert.equal(h.el.querySelector('[aria-label="Przyczyna korekty"]').value, originalReason); assert.equal(h.el.querySelector('[aria-label="Seria korekt z podglądu"]').value, 'Korekty zwrotów · KOR-ZWROT · wersja 7'); await h.close();
    });
    await t.test('recovered preview displays its original selected series even when current options rename or omit it', async () => {
      for (const currentSeries of ['renamed', 'removed', 'none']) {
        reset(); const chosen = {...serie(), id: id(97), name: 'Korekty sklep detaliczny', prefix: 'KOR-DETAL'};
        f.source.series.push(chosen); f.expectedSeriesId = chosen.id; f.postMode = 'lost'; let h = await mount(); await ready(h);
        await act(async () => { const select = h.el.querySelector('[aria-label="Seria korekt"]'); select.value = chosen.id; select.dispatchEvent(new Event('change', {bubbles: true})); });
        const reason = 'Zwrot po uzgodnieniu z klientem'; await input(h, 'Przyczyna korekty', reason); await confirm(h); await click(h, 'Przygotuj podgląd korekty'); await until(() => h.el.textContent.includes('Nie potwierdzono wyniku'));
        const key = 'dyna:consumer-return-credit:v1:' + tenant + ':' + user, raw = localStorage.getItem(key), originalBody = structuredClone(f.posts[0].body);
        assert.equal(originalBody.series_id, chosen.id); await h.close(); f.postMode = '';
        f.source.series = currentSeries === 'none' ? [] : currentSeries === 'removed' ? [serie()] : [serie(), {...chosen, name: 'Nowa nazwa bieżącej serii', prefix: 'KOR-NOWA', version: '8'}];
        h = await mount(); await ready(h); assert.equal(localStorage.getItem(key), raw); assert.equal(postCount(), 1);
        await click(h, 'Odczytaj oryginalny wynik'); await until(() => !!h.el.querySelector('[aria-label="Seria korekt z podglądu"]'));
        assert.equal(h.el.querySelector('[aria-label="Seria korekt z podglądu"]').value, 'Korekty sklep detaliczny · KOR-DETAL · wersja 7');
        assert.equal(h.el.querySelector('[aria-label="Przyczyna korekty"]').value, reason); assert(h.el.querySelector('[aria-label="Przyczyna korekty"]').disabled);
        assert(!h.el.querySelector('[aria-label="Seria korekt"]')); assert(!button(h, 'Utwórz serię korekt')); assert(button(h, 'Wystaw numerowaną korektę').disabled);
        assert(!consumerCreditsLocked(context)); assert.equal(postCount(), 1); assert.deepEqual(f.posts[0].body, originalBody); assert.equal(f.calls.filter(c => c.path.includes('/commands/')).length, 1); await h.close();
      }
    });
    await t.test('validly shaped but wrong original preview intent cannot release v3 after reload', async () => {
      for (const alter of [
        h => h.requestBody.reason = 'Inna przyczyna zwrotu',
        h => h.requestBody.original_document_id = id(95),
        h => h.requestBody.expected_return_version = '6',
        h => h.requestBody.series_id = id(96),
        h => h.requestBody.expected_series_version = '8',
      ]) {
        reset(); f.postMode = 'lost'; let h = await mount(); await ready(h); await confirm(h); await click(h, 'Przygotuj podgląd korekty'); await until(() => h.el.textContent.includes('Nie potwierdzono wyniku')); await h.close();
        const key = 'dyna:consumer-return-credit:v1:' + tenant + ':' + user, held = JSON.parse(localStorage.getItem(key)); alter(held); const raw = JSON.stringify(held); localStorage.setItem(key, raw); f.postMode = ''; h = await mount(); await ready(h);
        await click(h, 'Odczytaj oryginalny wynik'); await until(() => h.el.textContent.includes('Zapisana próba nadal')); assert.equal(localStorage.getItem(key), raw); assert(consumerCreditsLocked(context)); assert(!button(h, 'Wystaw numerowaną korektę')); assert.equal(postCount(), 1); assert.equal(f.calls.filter(c => c.path.includes('/commands/')).length, 1); await h.close();
      }
      reset(); f.previewPatch = {snapshot: {...preview({reason: 'Oryginalna inna przyczyna', expected_return_version: '5'}).snapshot}}; const h = await mount(); await ready(h); await confirm(h); await click(h, 'Przygotuj podgląd korekty'); await until(() => h.el.textContent.includes('Nie potwierdzono wyniku')); assert(consumerCreditsLocked(context)); assert.equal(postCount(), 1); await h.close();
    });
    await t.test('v3 issue keeps exact scope/resource/body across reload and rejects wrong receipt or exposed request', async () => {
      for (const mode of ['correct', 'scope', 'receipt', 'request']) {
        reset(); let h = await mount(); await ready(h); await confirm(h); await click(h, 'Przygotuj podgląd korekty'); await until(() => button(h, 'Wystaw numerowaną korektę')); f.postMode = 'lost'; await confirm(h); await click(h, 'Wystaw numerowaną korektę'); await until(() => h.el.textContent.includes('Nie potwierdzono wyniku')); await h.close();
        const key = 'dyna:consumer-return-credit:v1:' + tenant + ':' + user, held = JSON.parse(localStorage.getItem(key)); assert.equal(held.operation, 'issue'); assert.equal(held.resource, '/consumer-return-credits/previews/' + previewId + '/issue'); assert.deepEqual(held.requestBody, f.posts[1].body);
        if (mode === 'scope') {held.requestBody.scope_hash = '9'.repeat(64); localStorage.setItem(key, JSON.stringify(held));}
        const command = f.commands.get(held.clientKey);
        if (mode === 'receipt') f.commandPatch = {receipt: {...command.receipt, scope_hash: '9'.repeat(64)}};
        if (mode === 'request') f.commandPatch = {request: {...held.requestBody, confirmed: false}};
        const raw = localStorage.getItem(key); f.postMode = ''; f.source = source({eligible: false, eligibility_reason: 'already_credited', calculation: null, previous_credits: [{return_id: ret, document_id: docId}], credit_families: [{document_id: docId, receipt_id: receiptId, family: 'destinations'}]}); h = await mount(); await ready(h); await click(h, 'Odczytaj oryginalny wynik');
        if (mode === 'correct') {await until(() => !consumerCreditsLocked(context) && h.el.querySelector('a[href*="/consumer-return-credits/documents/"]'));}
        else {await until(() => h.el.textContent.includes('Zapisana próba nadal')); assert.equal(localStorage.getItem(key), raw); assert(consumerCreditsLocked(context)); assert(!h.el.querySelector('a[href*="/consumer-return-credits/documents/"]'));}
        assert.equal(postCount(), 2); await h.close();
      }
    });
    await t.test('malformed v3 request extras, credentials, resource, method and bounds stay locked without POST or lookup', async () => {
      for (const alter of [
        h => h.requestBody.password = 'Never persisted by UI', h => h.requestBody.reason = 'x'.repeat(501),
        h => h.requestBody.reason = 'x'.repeat(5000), h => h.requestBody.client_key = id(98),
        h => delete h.requestBody.reason, h => h.requestBody.local_only = false,
        h => h.resource = '/consumer-return-credits/previews/' + previewId + '/issue',
        h => h.resource = 'https://example.test/previews', h => h.method = 'PATCH',
        h => h.requestBody.actor_id = user, h => h.token = 'unexpected',
      ]) {
        reset(); f.postMode = 'lost'; let h = await mount(); await ready(h); await confirm(h); await click(h, 'Przygotuj podgląd korekty'); await until(() => h.el.textContent.includes('Nie potwierdzono wyniku')); await h.close();
        const key = 'dyna:consumer-return-credit:v1:' + tenant + ':' + user, held = JSON.parse(localStorage.getItem(key)); alter(held); const raw = JSON.stringify(held); localStorage.setItem(key, raw); f.postMode = ''; h = await mount(); await ready(h); await until(() => h.el.textContent.includes('Nie można bezpiecznie odczytać zapisanej próby')); assert(consumerCreditsLocked(context)); assert.equal(localStorage.getItem(key), raw); assert.equal(postCount(), 1); assert(!f.calls.some(c => c.path.includes('/commands/'))); assert(button(h, 'Przygotuj podgląd korekty').disabled); await h.close();
      }
    });
    await t.test('legacy v1/v2 preview and issue can read original result but never fabricate intent or clear/activate it', async () => {
      for (const schema of ['consumer-return-credit-custody/v1', 'consumer-return-credit-custody/v2']) for (const operation of ['preview', 'issue']) {
        reset(); let h = await mount(); await ready(h); await confirm(h);
        if (operation === 'issue') {await click(h, 'Przygotuj podgląd korekty'); await until(() => button(h, 'Wystaw numerowaną korektę')); await confirm(h);}
        f.postMode = 'lost'; await click(h, operation === 'preview' ? 'Przygotuj podgląd korekty' : 'Wystaw numerowaną korektę'); await until(() => h.el.textContent.includes('Nie potwierdzono wyniku')); await h.close();
        const key = 'dyna:consumer-return-credit:v1:' + tenant + ':' + user, held = JSON.parse(localStorage.getItem(key)); held.schema = schema; delete held.method; delete held.resource; delete held.requestBody; if (schema.endsWith('/v1')) {delete held.seriesName; delete held.seriesPrefix;} const raw = JSON.stringify(held); localStorage.setItem(key, raw); f.postMode = ''; const posts = postCount(); h = await mount(); await ready(h); await click(h, 'Odczytaj oryginalny wynik'); await until(() => h.el.textContent.includes('Starsza zapisana próba nie zawiera pełnych danych żądania')); assert.equal(localStorage.getItem(key), raw); assert(consumerCreditsLocked(context)); assert.equal(postCount(), posts); assert.equal(f.calls.filter(c => c.path.includes('/commands/')).length, 1); assert(!button(h, 'Wystaw numerowaną korektę')); assert(!h.el.querySelector('a[href*="/consumer-return-credits/documents/"]')); await h.close();
      }
    });
    await t.test('bad preview arithmetic and foreign rollback cannot clear custody; exact acknowledged rollback may clear it', async () => {
      for (const mode of ['badPreview', 'foreignRollback', 'rollback']) {
        reset(); if (mode === 'badPreview') f.previewPatch = {return_id: id(90)}; else f.postMode = mode; const h = await mount(); await ready(h); await confirm(h); await click(h, 'Przygotuj podgląd korekty'); await until(() => h.el.querySelector('[role="alert"]')); assert.equal(postCount(), 1); assert.equal(consumerCreditsLocked(context), mode !== 'rollback'); assert(!h.el.querySelector('table')); safe(h); await h.close();
      }
      reset(); f.source.calculation.totals.delta.net_minor = '-999'; const h = await mount(); await until(() => h.el.querySelector('[role="alert"]')); assert.equal(postCount(), 0); assert(!button(h, 'Przygotuj podgląd korekty')); await h.close();
    });
    await t.test('late source, context, read-only and IAM demotion hide data and prevent POST', async () => {
      for (const patch of [{contextKey: tenant + ':' + id(90) + ':operator'}, {contextKey: tenant + ':' + user + ':viewer'}]) {
        reset(); const d = deferred(); f.sourceHold = d; const h = await mount(); await until(() => f.calls.some(c => c.path.includes('/source'))); await h.render(props(patch)); await act(async () => d.resolve(Response.json(f.source))); await tick(); assert(!h.el.textContent.includes('FV/OWN/')); assert.equal(postCount(), 0); await h.close();
      }
      reset(); const h = await mount(); await ready(h); f.demoteAt = f.me + 1; await confirm(h); await click(h, 'Przygotuj podgląd korekty'); await until(() => h.el.querySelector('[role="alert"]')); assert.equal(postCount(), 0); assert(!h.el.textContent.includes('FV/OWN/')); await h.close();
      reset(); f.mePatch = {restore_preview: true}; const copy = await mount(); await ready(copy); await confirm(copy); await click(copy, 'Przygotuj podgląd korekty'); await until(() => copy.el.querySelector('[role="alert"]')); assert.equal(postCount(), 0); assert(!consumerCreditsLocked(context)); await copy.close();
    });
    await t.test('a lost command response after unmount remains locked without exposing old result', async () => {
      reset(); f.postMode = 'hold'; const d = deferred(); f.postHold = d; const h = await mount(); await ready(h); await confirm(h); await click(h, 'Przygotuj podgląd korekty'); await until(() => postCount() === 1); assert(consumerCreditsLocked(context)); await h.close(); await act(async () => d.resolve(Response.json(f.commands.get(f.posts[0].body.client_key)))); await tick(); assert(consumerCreditsLocked(context)); assert.equal(postCount(), 1); assert.equal(h.el.textContent, '');
    });
    await t.test('previous legacy and current correction print links follow authoritative family without new writes', async () => {
      reset(); f.source = source({eligible: false, eligibility_reason: 'already_credited', calculation: null, previous_credits: [{return_id: ret, document_id: docId}], credit_families: [{document_id: docId, receipt_id: receiptId, family: 'legacy'}]});
      const legacy = await mount(); await ready(legacy); assert.equal(legacy.el.querySelector('a').getAttribute('href'), '/api/local-consumer-credits/documents/' + docId + '/print'); assert(!f.calls.some(c => c.path === rootPath + '/documents/' + docId)); assert.equal(postCount(), 0); await legacy.close();
      reset(); const issued = await mount(); await ready(issued); await confirm(issued); await click(issued, 'Przygotuj podgląd korekty'); await until(() => button(issued, 'Wystaw numerowaną korektę')); await confirm(issued); await click(issued, 'Wystaw numerowaną korektę'); await until(() => issued.el.querySelector('a')); await issued.close();
      f.source = source({eligible: false, eligibility_reason: 'already_credited', calculation: null, previous_credits: [{return_id: ret, document_id: docId}], credit_families: [{document_id: docId, receipt_id: receiptId, family: 'destinations'}]}); const postBefore = postCount(), own = await mount(); await ready(own); assert(own.el.textContent.includes('KOR-ZWROT/2026/000001')); assert.equal(own.el.querySelector('a').getAttribute('href'), rootPath + '/documents/' + docId + '/print'); assert.equal(postCount(), postBefore); await own.close();
    });
    await t.test('backend permission/series changes are re-read before explicit mutation and block stale confirmation', async () => {
      for (const change of [() => { f.source.can_preview = false; }, () => { f.source.can_issue = false; }, () => { f.source.series = []; }, () => { f.source.current_role = 'viewer'; }]) {
        reset(); const h = await mount(); await ready(h); await confirm(h); change(); await click(h, 'Przygotuj podgląd korekty'); await until(() => h.el.querySelector('[role="alert"]')); assert.equal(postCount(), 0); assert(!consumerCreditsLocked(context)); assert(!h.el.querySelector('table')); await h.close();
      }
      reset(); const h = await mount(props({externalWriteBlocked: true})); await ready(h); assert(button(h, 'Przygotuj podgląd korekty').disabled); assert.equal(postCount(), 0); await h.close();
    });
    await t.test('register reads new persisted family and pagination is explicit', async () => {
      reset(); f.register = [{id: docId, order_id: order, original_document_id: invoice, return_id: ret, number: 'KOR-ZWROT/2026/000001', totals: money('-1230', '-1000', '-230')}]; f.cursor = docId;
      const h = await mount({contextKey: context, refresh: 0}, ConsumerReturnCreditRegister); await until(() => h.el.textContent.includes('KOR-ZWROT/2026/000001')); assert.equal(postCount(), 0); assert.equal(f.calls.filter(c => c.path.startsWith(rootPath + '/documents')).length, 1); assert.equal(h.el.querySelector('a[href*="/consumer-return-credits/"]').getAttribute('href'), rootPath + '/documents/' + docId + '/print'); await click(h, 'Następne 50 korekt do zwrotów'); await until(() => f.calls.some(c => c.path === rootPath + '/documents?cursor=' + docId)); assert.equal(postCount(), 0); safe(h); await h.close();
    });
    await t.test('authorized restore copy reads existing correction/register but cannot mutate or clear original custody', async () => {
      reset(); const setup = await mount(); await ready(setup); await confirm(setup); await click(setup, 'Przygotuj podgląd korekty'); await until(() => button(setup, 'Wystaw numerowaną korektę')); await confirm(setup); await click(setup, 'Wystaw numerowaną korektę'); await until(() => setup.el.querySelector('a')); await setup.close();
      const before = postCount(), held = {schema: 'consumer-return-credit-custody/v2', actor: tenant + ':' + user, operation: 'issue', clientKey: f.posts[1].body.client_key, orderId: order, returnId: ret, previewId, seriesName: null, seriesPrefix: null};
      localStorage.setItem('dyna:consumer-return-credit:v1:' + tenant + ':' + user, JSON.stringify(held));
      f.readOnly = true; f.mePatch = {restore_preview: true, read_only: true}; f.strategy.read_only = true;
      f.source = source({...flags({read_only: true, can_preview: false, can_issue: false}), current_return_version: null, eligible: false, eligibility_reason: 'already_credited', calculation: null, previous_credits: [{return_id: ret, document_id: docId}], credit_families: [{document_id: docId, receipt_id: receiptId, family: 'destinations'}]});
      const h = await mount(props({readOnly: true})); await until(() => h.el.textContent.includes('KOR-ZWROT/2026/000001')); assert.equal(h.el.querySelector('a').getAttribute('href'), rootPath + '/documents/' + docId + '/print'); assert(button(h, 'Odczytaj oryginalny wynik').disabled); assert(consumerCreditsLocked(context)); assert(!f.calls.some(c => c.path.includes('/commands/'))); assert.equal(postCount(), before); await h.close();
      // Even stale parent props must not let a fresh restore identity release the original key.
      const stale = await mount(props()); await ready(stale); await click(stale, 'Odczytaj oryginalny wynik'); await until(() => stale.el.textContent.includes('Zapisana próba nadal')); assert(consumerCreditsLocked(context)); assert(!f.calls.some(c => c.path.includes('/commands/'))); assert.equal(postCount(), before); await stale.close();
      f.register = [{id: docId, order_id: order, original_document_id: invoice, return_id: ret, number: 'KOR-ZWROT/2026/000001', totals: money('-1230', '-1000', '-230')}];
      const register = await mount({contextKey: context, refresh: 0}, ConsumerReturnCreditRegister); await until(() => register.el.textContent.includes('KOR-ZWROT/2026/000001')); assert.equal(postCount(), before); assert(consumerCreditsLocked(context)); await register.close();
      // The earlier family also remains readable through the authoritative legacy strategy.
      f.strategy.strategy = 'legacy'; const legacy = await mount(props({readOnly: true})); await until(() => legacy.el.textContent.includes('Faktura źródłowa:')); assert.equal(postCount(), before); assert(consumerCreditsLocked(context)); await legacy.close();
    });
  } finally {
    for (const h of handles) await h.close(); await vite.close(); globalThis.fetch = oldFetch; storageProto.removeItem = removeItem;
    for (const [k, v] of saved) { if (v) Object.defineProperty(globalThis, k, v); else delete globalThis[k]; } dom.window.close();
  }
});
