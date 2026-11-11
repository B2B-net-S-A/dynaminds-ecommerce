import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import React, {act} from 'react';
import {JSDOM} from 'jsdom';
import {createServer} from 'vite';

const id = n => `${String(n).padStart(8, '0')}-1000-4000-8000-000000000001`;
const tenant = id(1), user = id(2), job = id(3), channel = id(4);
const props = {tenantId: tenant, userId: user, admin: true, readOnly: false, jobId: job, kind: 'orders.sync'};
const cut = (jobId = job, state = 'pending', once = false, attempts = 0) => ({scope: 'sandbox_manual_once',
  job: {id: jobId, kind: 'orders.sync', state, attempts, max_attempts: 1, lease_active: state === 'running'}, plan: null,
  once_intent_recorded: once, completed: state === 'done', continuation_required: state === 'pending' && once,
  automatic_retry: false, provider_acceptance: false});
const defer = () => {let resolve; const promise = new Promise(r => {resolve = r;}); return {promise, resolve};};

test('ordinary sandbox job UI uses actual React/api with controlled fetch only; no provider/DB/listener', async t => {
  const dom = new JSDOM('<!doctype html><body/>', {url: 'http://127.0.0.1/'}), saved = new Map(), originalFetch = globalThis.fetch;
  for (const [k, v] of Object.entries({window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Event: dom.window.Event, MouseEvent: dom.window.MouseEvent,
    CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true})) {
    saved.set(k, Object.getOwnPropertyDescriptor(globalThis, k));
    Object.defineProperty(globalThis, k, {value: v, configurable: true, writable: true});
  }
  const queues = new Map();
  Object.defineProperty(navigator, 'locks', {configurable: true, value: {request: async (key, _options, fn) => {
    const previous = queues.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(fn); queues.set(key, next);
    try {return await next;} finally {if (queues.get(key) === next) queues.delete(key);}
  }}});
  const vite = await createServer({server: {middlewareMode: true, hmr: false, ws: false, watch: null}, appType: 'custom', logLevel: 'error'});
  const {createRoot} = await import('react-dom/client');
  const ui = await vite.ssrLoadModule(path.resolve('web/ordinary-connector-job.tsx'));
  const {SyncPanel} = await vite.ssrLoadModule(path.resolve('web/sync.tsx'));
  const api = await vite.ssrLoadModule(path.resolve('web/api.ts'));
  const handles = []; let f;
  const tick = () => act(async () => {await new Promise(r => setTimeout(r, 0));});
  async function until(fn) {for (let i = 0; i < 60; i++) {if (fn()) return; await tick();} assert(fn(), 'expected controlled UI state');}
  function reset() {
    window.localStorage.clear(); api.setWorkspace(tenant);
    f = {reads: [], posts: [], available: true, role: 'admin', preview: false, user, job: cut(), meReads: 0,
      demoteAtMe: 0, lost: false, post401: false, malformedAck: false, read500: false, holdJob: null, holdPost: null, keepFresh: false, changed: 0};
    globalThis.fetch = async (url, init = {}) => {
      const parsed = new URL(String(url), 'http://127.0.0.1'), p = parsed.pathname.replace(/^\/api/, ''), method = init.method ?? 'GET';
      assert.equal(parsed.origin, 'http://127.0.0.1', 'only a mocked application endpoint is allowed');
      if (p !== '/health') assert.equal(new Headers(init.headers).get('X-Workspace-ID'), tenant);
      if (method === 'GET') {
        f.reads.push(p);
        if (p === '/health') return Response.json({ordinary_connector_jobs_available: f.available});
        if (p === '/auth/me') {f.meReads++; return Response.json({restore_preview: f.preview,
          user: {id: f.user, tenant_id: tenant, role: f.demoteAtMe && f.meReads >= f.demoteAtMe ? 'viewer' : f.role, api_key_id: null}});}
        if (p === '/integrations/' + channel + '/sync') return Response.json({channel: {id: channel, provider: 'allegro', simulation: false, sync_enabled: false, sync_interval: 60},
          jobs: [{...f.job.job, phase: 'bootstrap', page: '1', created_at: '2026-10-17T00:00:00Z'}], deliveries: []});
        assert.equal(p, '/local-operator/connector-jobs/' + job);
        if (f.holdJob) {const held = f.holdJob; f.holdJob = null; return held.promise;}
        if (f.read500) return Response.json({detail: 'PRIVATE_PROVIDER_SECRET'}, {status: 500});
        return Response.json(f.job);
      }
      assert.equal(method, 'POST'); assert.equal(p, '/local-operator/connector-jobs/' + job + '/run-once');
      assert.deepEqual(JSON.parse(init.body), {}); f.posts.push({path: p, method});
      if (f.holdPost) await f.holdPost.promise;
      if (!f.keepFresh) f.job = cut(job, 'done', true, 1);
      if (f.lost) throw TypeError('CONTROLLED_RESPONSE_LOST');
      if (f.post401) return Response.json({code: 'AUTH_SESSION_EXPIRED', detail: 'PRIVATE_PROVIDER_SECRET'}, {status: 401});
      return Response.json(f.malformedAck ? cut(id(99), 'done', true, 1) : f.job);
    };
  }
  async function mount(p = props, Component = ui.OrdinaryConnectorJobControl) {
    const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
    const h = {container, root, async render(next) {await act(async () => root.render(React.createElement(Component, next)));},
      async close() {await act(async () => root.unmount()); container.remove();}};
    handles.push(h); await h.render(p); return h;
  }
  const button = (h, label) => [...h.container.querySelectorAll('button')].find(b => b.textContent === label);
  const readButton = h => button(h, 'Odczytaj zadanie i dostęp do sandboxa');
  const runButton = h => button(h, 'Wykonaj raz w sandboxie');
  async function click(element) {assert(element && !element.disabled, element?.textContent); await act(async () => element.dispatchEvent(new MouseEvent('click', {bubbles: true})));}
  async function prepare(h) {await click(readButton(h)); await until(() => !!runButton(h)); await click(h.container.querySelector('input[type=checkbox]')); assert(!runButton(h).disabled);}
  try {
    await t.test('strict exact-job DTO/freshness reject wrong identity, capability flags, attempted and unknown cuts', () => {
      assert(ui.freshOrdinaryConnectorJob(ui.readOrdinaryConnectorJob(cut(), job, 'orders.sync')));
      for (const mutate of [v => v.job.id = id(50), v => v.job.kind = 'email.send', v => v.scope = 'live', v => v.automatic_retry = true,
        v => v.provider_acceptance = true, v => v.secret = 'PRIVATE_PROVIDER_SECRET', v => v.job.attempts = -1, v => v.completed = true]) {
        const value = cut(); mutate(value); assert.throws(() => ui.readOrdinaryConnectorJob(value, job, 'orders.sync'));
      }
      for (const value of [cut(job, 'running', true, 1), cut(job, 'failed', true, 1), cut(job, 'done', true, 1), cut(job, 'pending', true, 0)])
        assert.equal(ui.freshOrdinaryConnectorJob(ui.readOrdinaryConnectorJob(value, job, 'orders.sync')), false);
    });
    await t.test('plan freshness matches exact backend create/buy/refresh pairs per kind', () => {
      const allowed = {
        shipping: ['queued:ready', 'buy_queued:buy_ready', 'queued:refresh_ready'],
        'offer.write': ['queued:ready'], 'shipping.dpd': ['queued:ready'], 'dpd.collection': ['queued:ready'],
      };
      for (const [kind, pairs] of Object.entries(allowed)) {
        for (const state of ['queued', 'buy_queued', 'done']) for (const phase of ['ready', 'buy_ready', 'refresh_ready']) {
          const value = cut(); value.job.kind = kind; value.plan = {id: id(10), state, phase};
          const parsed = ui.readOrdinaryConnectorJob(value, job, kind);
          assert.equal(ui.freshOrdinaryConnectorJob(parsed), pairs.includes(state + ':' + phase), kind + ' ' + state + ':' + phase);
        }
        const noPlan = cut(); noPlan.job.kind = kind;
        assert.equal(ui.freshOrdinaryConnectorJob(ui.readOrdinaryConnectorJob(noPlan, job, kind)), false);
      }
      const syncWithPlan = cut(); syncWithPlan.plan = {id: id(10), state: 'queued', phase: 'ready'};
      assert.equal(ui.freshOrdinaryConnectorJob(ui.readOrdinaryConnectorJob(syncWithPlan, job, 'orders.sync')), false);
    });
    await t.test('no implicit reads/writes; explicit consent produces exactly one POST and original-job GET readback', async () => {
      reset(); const h = await mount({...props, onChanged: () => f.changed++}); assert.equal(f.reads.length, 0); assert.equal(f.posts.length, 0);
      await click(readButton(h)); await until(() => !!runButton(h)); assert(runButton(h).disabled); await click(h.container.querySelector('input'));
      await act(async () => {runButton(h).dispatchEvent(new MouseEvent('click', {bubbles: true})); runButton(h)?.dispatchEvent(new MouseEvent('click', {bubbles: true}));});
      await until(() => h.container.textContent.includes('Zakończone'));
      assert.equal(f.posts.length, 1); assert.equal(f.changed, 1); assert(f.reads.filter(p => p.endsWith('/' + job)).length >= 3);
      assert.equal(runButton(h), undefined); assert(!h.container.textContent.includes('PRIVATE_PROVIDER_SECRET')); await h.close();
    });
    await t.test('disabled capability, nonadmin, read-only and external block never dispatch', async () => {
      for (const change of [{admin: false}, {readOnly: true}]) {reset(); const h = await mount({...props, ...change}); assert.equal(readButton(h), undefined); assert.equal(f.reads.length, 0); await h.close();}
      reset(); f.available = false; const h = await mount(); await click(readButton(h)); await until(() => !readButton(h).disabled); assert.equal(runButton(h), undefined); assert(h.container.textContent.includes('wyłączone w tym uruchomieniu')); assert.equal(f.posts.length, 0); await h.close();
      reset(); const locked = await mount({...props, externalWriteBlocked: true}); await click(readButton(locked)); await until(() => !!runButton(locked)); assert(runButton(locked).disabled); assert(locked.container.querySelector('input').disabled); assert.equal(f.posts.length, 0); await locked.close();
    });
    await t.test('fresh own read is required; foreign job and late role downgrade refuse before any POST', async () => {
      reset(); f.job = cut(id(99)); const h = await mount(); await click(readButton(h)); await until(() => !!h.container.querySelector('[role=alert]')); assert.equal(runButton(h), undefined); assert.equal(f.posts.length, 0); await h.close();
      reset(); const own = await mount(); await prepare(own); f.demoteAtMe = f.meReads + 2; await click(runButton(own)); await until(() => !!own.container.querySelector('[role=alert]')); assert.equal(f.posts.length, 0); await own.close();
    });
    await t.test('lost POST response with still-pending server cut blocks after GET refresh and remount, never auto-retries', async () => {
      reset(); f.lost = true; f.keepFresh = true; let h = await mount(); await prepare(h); await click(runButton(h)); await until(() => !!h.container.querySelector('[role=alert]')); assert.equal(f.posts.length, 1);
      await click(readButton(h)); await until(() => !readButton(h).disabled); assert.equal(runButton(h), undefined); await h.close();
      h = await mount(); const n = f.posts.length; await click(readButton(h)); await until(() => !readButton(h).disabled); assert.equal(f.posts.length, n); assert.equal(runButton(h), undefined); await h.close();
    });
    await t.test('POST401 or malformed ACK remains uncertain; readback can show completion without another write', async () => {
      for (const mode of ['post401', 'malformedAck']) {reset(); f[mode] = true; const h = await mount(); await prepare(h); await click(runButton(h)); await until(() => !!h.container.querySelector('[role=alert]')); assert.equal(f.posts.length, 1);
        assert(!h.container.textContent.includes('PRIVATE_PROVIDER_SECRET')); await click(readButton(h)); await until(() => h.container.textContent.includes('Zakończone')); assert.equal(f.posts.length, 1); assert.equal(runButton(h), undefined); await h.close();}
    });
    await t.test('attempted/unknown/failed job has only GET refresh and no execution button', async () => {
      for (const state of ['running', 'failed', 'pending']) {reset(); f.job = cut(job, state, true, state === 'pending' ? 0 : 1); const h = await mount(); await click(readButton(h)); await until(() => !readButton(h).disabled); assert.equal(runButton(h), undefined); assert.equal(f.posts.length, 0); assert(readButton(h)); await h.close();}
    });
    await t.test('stale principal response never restores a write action', async () => {
      reset(); const late = defer(); f.holdJob = late; const h = await mount(); await click(readButton(h)); await until(() => f.reads.some(p => p.endsWith('/' + job)));
      await h.render({...props, userId: id(80)}); await act(async () => late.resolve(Response.json(cut()))); await tick(); assert.equal(runButton(h), undefined); assert.equal(f.posts.length, 0); await h.close();
    });
    await t.test('browser tab lock plus sent marker prevent a second mounted control from dispatching the same job', async () => {
      reset(); const a = await mount(), b = await mount(); await prepare(a); await prepare(b); const held = defer(); f.holdPost = held;
      await click(runButton(a)); await until(() => f.posts.length === 1); await click(runButton(b)); assert.equal(f.posts.length, 1); held.resolve(); await until(() => !!b.container.querySelector('[role=alert]')); await until(() => a.container.textContent.includes('Zakończone')); assert.equal(f.posts.length, 1); await a.close(); await b.close();
    });
    await t.test('500 GET remains generic, refreshes GET only and does not expose server details', async () => {
      reset(); f.read500 = true; const h = await mount(); await click(readButton(h)); await until(() => !!h.container.querySelector('[role=alert]')); assert(!h.container.textContent.includes('PRIVATE_PROVIDER_SECRET')); assert.equal(f.posts.length, 0); f.read500 = false; await click(readButton(h)); await until(() => !!runButton(h)); assert(runButton(h).disabled); assert.equal(f.posts.length, 0); await h.close();
    });
    await t.test('actual SyncPanel exposes the row action and removes generic retry for this manual connector path', async () => {
      reset(); f.job = cut(job, 'failed', true, 1); const h = await mount({channelId: channel, connectorContext: props}, SyncPanel); await until(() => !!readButton(h));
      assert.equal(button(h, 'Ponów'), undefined); assert.equal(f.posts.length, 0); await click(readButton(h)); await until(() => !readButton(h).disabled); assert.equal(runButton(h), undefined); await h.close();
    });
  } finally {
    for (const h of handles) {try {await h.close();} catch {}}
    await vite.close(); globalThis.fetch = originalFetch; dom.window.close();
    for (const [k, descriptor] of saved) {if (descriptor) Object.defineProperty(globalThis, k, descriptor); else delete globalThis[k];}
  }
});
