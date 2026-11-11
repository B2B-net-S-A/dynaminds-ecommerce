/** Executed adapter, service, registered handler and React component with controlled
 * ports only. No database, listening HTTP server or provider account is used.
 * These checks do not certify PostgreSQL RLS, provider grants or the installed app.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as crypto from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { transformSync } from 'esbuild';
import { z } from 'zod';
import { ensure, Problem } from '../server/errors';

const require = createRequire(import.meta.url);
function compiled(file: string, ports: Record<string, unknown>) {
  const module = { exports: {} as any };
  const code = transformSync(readFileSync(new URL('../' + file, import.meta.url), 'utf8'), {
    loader: file.endsWith('tsx') ? 'tsx' : 'ts', format: 'cjs', target: 'es2022', jsx: 'automatic',
  }).code;
  new Function('module', 'exports', 'require', code)(module, module.exports, (name: string) => {
    assert(Object.hasOwn(ports, name), 'Unexpected module port: ' + name);
    return ports[name];
  });
  return module.exports;
}
const noCall = () => { throw new Error('Unexpected controlled port'); };
const security = { decrypt: (value: any) => value,
  tokenHash: (value: string) => crypto.createHash('sha256').update(value).digest('hex') };
const errors = { ensure, Problem };
const apiLimits = compiled('server/ebay-api-limits.ts', {
  'node:crypto': crypto, './db': {pool: {query: noCall}, tenantTx: noCall}, './errors': errors,
});
const ebay = compiled('server/ebay.ts', {
  'node:crypto': crypto, 'node:timers/promises': {setTimeout}, zod: {z},
  './security': security, './errors': errors,
  './ebay-api-limits': {...apiLimits, ebayLimitedTransport: (_mode: string, _id: string, base: any) => base},
});
const seller = compiled('server/ebay-seller-settings.ts', {
  zod: {z}, './ebay': ebay, './ebay-api-limits': apiLimits, './errors': errors,
  './ebay-inventory': {ebayInventoryPage: noCall},
});
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const actor = {tenantId: id(1), userId: id(2), role: 'admin'};
const channel = {id: id(3), tenant_id: actor.tenantId, provider: 'ebay', mode: 'sandbox',
  settings: {simulation: false}, credentials: {client_id: 'APP-ID', client_secret: 'PRIVATE-SECRET',
    refresh_token: 'PRIVATE-REFRESH', access_token: 'PRIVATE-SELLER'}};
const session = security.tokenHash('browser-cookie');
const raw = () => ({rateLimits: [{apiContext: 'sell', apiName: 'inventory', apiVersion: 'v1',
  resources: [{name: 'updateOffer', rates: [
    {limit: 5000, remaining: 4900, count: 100, reset: '2026-10-19T00:00:00.000Z', timeWindow: 86400},
    {limit: 10, remaining: 0, reset: '2026-10-18T23:01:00.000Z', timeWindow: 1},
  ]}]}]});

function harness() {
  const state = {channel: structuredClone(channel) as any, admin: true, session: true,
    afterRequest: undefined as undefined | ((index: number) => void)};
  const calls: {url: string; init: any}[] = [], transactions: any[] = [];
  const replies: (() => Response | Promise<Response>)[] = [];
  const transport = async (url: string, init: any) => {
    calls.push({url, init});
    const reply = replies.shift(); assert(reply, 'Unexpected provider request');
    const result = await reply(); state.afterRequest?.(calls.length); return result;
  };
  let authorityChecks = 0;
  const cachedEbayApiLimits = async (a: any, cookie: string, target: string) => {
    ++authorityChecks;
    ensure(state.session && cookie === session && a.userId === actor.userId, 401, 'Expired session');
    ensure(state.admin, 403, 'Revoked admin');
    ensure(a.tenantId === state.channel.tenant_id && target === state.channel.id, 404, 'Foreign channel');
    return {provider_quota_read: false};
  };
  const tenantTx = async (tenant: string, work: any) => {
    const tx = {tenant, closed: false, queries: [] as string[]}; transactions.push(tx);
    const snapshot = structuredClone(state.channel);
    try {return await work({query: async (sql: string, args: unknown[]) => {
      tx.queries.push(sql); assert.match(sql, /^SELECT /);
      if (sql.startsWith('SELECT offer_sync_is_admin')) {
        assert.deepEqual(args, [actor.userId]); return {rows: [{ok: state.admin}]};
      }
      assert.equal(sql, 'SELECT * FROM channels WHERE id=$1 FOR SHARE');
      assert.deepEqual(args, [channel.id]);
      return {rows: tenant === snapshot.tenant_id ? [snapshot] : []};
    }});} finally {tx.closed = true;}
  };
  const api = compiled('server/ebay-provider-quota.ts', {
    zod: {z}, './db': {tenantTx}, './errors': errors, './security': security,
    './integrations': {safeFetch: noCall}, './ebay': ebay, './ebay-api-limits': apiLimits,
    './ebay-seller-settings': seller, './ebay-oauth': {cachedEbayApiLimits},
  });
  const token = () => Response.json({access_token: 'PRIVATE-APP-TOKEN', expires_in: 7200,
    token_type: 'Application Access Token', scope: ebay.EBAY_TRADING_SCOPE});
  const enqueue = (quota: () => Response | Promise<Response> = () => Response.json(raw())) => {
    replies.push(token, quota);
  };
  return {state, calls, transactions, replies, api, token, enqueue,
    checkCount: () => authorityChecks,
    read: (a: any = actor, cookie = session, target = channel.id) =>
      api.readEbayProviderQuota(a, cookie, target, {transport})};
}

test('official application quota preserves separate windows, unknown count and provider values', () => {
  const h = harness(), input = raw(), before = structuredClone(input);
  const rows = h.api.parseEbayProviderQuota(input);
  assert.deepEqual(rows, [
    {api_context: 'sell', api_name: 'inventory', api_version: 'v1', resource: 'updateOffer',
      limit: 5000, remaining: 4900, count: 100, reset: '2026-10-19T00:00:00.000Z', window_seconds: 86400},
    {api_context: 'sell', api_name: 'inventory', api_version: 'v1', resource: 'updateOffer',
      limit: 10, remaining: 0, count: null, reset: '2026-10-18T23:01:00.000Z', window_seconds: 1},
  ]);
  assert.deepEqual(input, before);
  assert.deepEqual(h.api.parseEbayProviderQuota({rateLimits: []}), []);
  const zero = raw(); zero.rateLimits[0].resources[0].rates[0] = {
    limit: 0, remaining: 0, count: 100, reset: '2026-10-19T00:00:00.000Z', timeWindow: 86400};
  assert.equal(h.api.parseEbayProviderQuota(zero)[0].limit, 0);
});

test('malformed, duplicate, incomplete and excessive quota observations fail closed', () => {
  const h = harness();
  const mutations: ((v: any) => void)[] = [
    v => {delete v.rateLimits;}, v => {v.rateLimits[0].apiContext = 'unknown';},
    v => {delete v.rateLimits[0].apiVersion;},
    v => {v.rateLimits.push(structuredClone(v.rateLimits[0]));},
    v => {v.rateLimits[0].resources.push(structuredClone(v.rateLimits[0].resources[0]));},
    v => {v.rateLimits[0].resources[0].rates.push({...v.rateLimits[0].resources[0].rates[0]});},
    v => {v.rateLimits[0].resources[0].name = 'bad\nname';},
    v => {v.rateLimits[0].resources[0].rates[0].limit = Number.MAX_SAFE_INTEGER + 1;},
    v => {v.rateLimits[0].resources[0].rates[0].remaining = 5001;},
    v => {v.rateLimits[0].resources[0].rates[0].count = -1;},
    v => {v.rateLimits[0].resources[0].rates[0].timeWindow = 0;},
    v => {v.rateLimits[0].resources[0].rates[0].reset = '2026-10-19T00:00:00';},
    v => {v.errors = [{message: 'PRIVATE-PROVIDER-ERROR'}];},
    v => {v.warnings = [{message: 'partial result'}];},
    v => {v.rateLimits = Array.from({length: 101}, () => structuredClone(v.rateLimits[0]));},
  ];
  for (const mutate of mutations) {
    const value = raw(); mutate(value);
    assert.throws(() => h.api.parseEbayProviderQuota(value), (e: any) => e.status === 502
      && !e.message.includes('PRIVATE'));
  }
});

test('sandbox and live use application grant, exact GET and no seller-token rotation', async () => {
  for (const mode of ['sandbox', 'live']) {
    const h = harness(); h.state.channel.mode = mode; h.enqueue();
    const original = structuredClone(h.state.channel), result = await h.read();
    assert.equal(result.source, 'ebay_developer_analytics'); assert.equal(result.scope, 'application');
    assert.equal(result.mode, mode); assert.equal(result.status, 'observed');
    assert.equal(result.rows.length, 2); assert(Number.isFinite(Date.parse(result.observed_at)));
    assert.equal(h.calls.length, 2); const [token, quota] = h.calls;
    const base = mode === 'sandbox' ? 'https://api.sandbox.ebay.com' : 'https://api.ebay.com';
    assert.equal(token.url, base + '/identity/v1/oauth2/token'); assert.equal(token.init.method, 'POST');
    assert.equal(token.init.headers.Authorization, 'Basic ' + Buffer.from('APP-ID:PRIVATE-SECRET').toString('base64'));
    assert.deepEqual([...new URLSearchParams(token.init.body)], [
      ['grant_type', 'client_credentials'], ['scope', ebay.EBAY_TRADING_SCOPE],
    ]);
    assert.equal(quota.url, base + '/developer/analytics/v1_beta/rate_limit/');
    assert.equal(quota.init.method, 'GET'); assert.equal(quota.init.redirect, 'error');
    assert.equal(quota.init.body, undefined); assert(quota.init.signal instanceof AbortSignal);
    assert.equal(quota.init.headers.Authorization, 'Bearer PRIVATE-APP-TOKEN');
    assert.deepEqual(h.state.channel, original);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE|access_token|client_id|client_secret|refresh_token/);
    assert(h.checkCount() >= 5); assert(h.transactions.every(tx => tx.closed));
    assert(h.transactions.every(tx => tx.queries.length === 2));
  }
});

test('204 and an empty 200 observation mean no data, never zero or unlimited quota', async () => {
  for (const response of [() => new Response(null, {status: 204}), () => Response.json({rateLimits: []})]) {
    const h = harness(); h.enqueue(response); const result = await h.read();
    assert.equal(result.status, 'no_data'); assert.deepEqual(result.rows, []);
    assert.equal(h.calls.length, 2); assert(!Object.hasOwn(result, 'limit'));
  }
});

test('HTTP errors, invalid JSON/type and response cap stop without retries or private provider errors', async () => {
  for (const status of [401, 403, 429, 500, 503]) {
    const h = harness(); h.enqueue(() => new Response('PRIVATE-PROVIDER-ERROR', {status}));
    await assert.rejects(h.read(), (e: any) => e.status === ([401, 403, 429].includes(status) ? status : 502)
      && !e.message.includes('PRIVATE'));
    assert.equal(h.calls.length, 2);
  }
  for (const response of [
    () => new Response('{', {headers: {'content-type': 'application/json'}}),
    () => new Response(JSON.stringify(raw()), {headers: {'content-type': 'text/html'}}),
    () => Response.json({rateLimits: null}),
    () => Response.json({rateLimits: [], errors: [{message: 'PRIVATE'}]}),
  ]) {
    const h = harness(); h.enqueue(response);
    await assert.rejects(h.read(), (e: any) => e.status === 502 && !e.message.includes('PRIVATE'));
    assert.equal(h.calls.length, 2);
  }
  let cancelled = false;
  const h = harness(); h.enqueue(() => new Response(new ReadableStream({
    start(c) {c.enqueue(new Uint8Array(1024 * 1024 + 1));}, cancel() {cancelled = true;},
  }), {headers: {'content-type': 'application/json'}}));
  await assert.rejects(h.read(), (e: any) => e.status === 502);
  assert(cancelled); assert.equal(h.calls.length, 2);
  const network = harness(); network.replies.push(network.token, () => {throw new Error('PRIVATE');});
  await assert.rejects(network.read(), (e: any) => e.status === 502 && !e.message.includes('PRIVATE'));
  assert.equal(network.calls.length, 2);
});

test('application-token rejection or missing scope never falls back to seller credentials', async () => {
  for (const response of [
    () => new Response('PRIVATE', {status: 401}),
    () => Response.json({access_token: 'PRIVATE', expires_in: 7200, token_type: 'Bearer', scope: 'wrong'}),
    () => Response.json({access_token: 'PRIVATE', expires_in: 7200, token_type: 'User Access Token'}),
  ]) {
    const h = harness(); h.replies.push(response);
    await assert.rejects(h.read(), (e: any) => [401, 502].includes(e.status));
    assert.equal(h.calls.length, 1);
    assert.equal(h.state.channel.credentials.access_token, 'PRIVATE-SELLER');
  }
});

test('foreign, revoked, expired and simulation contexts refuse before network', async () => {
  const cases: [((h: ReturnType<typeof harness>) => void), number][] = [
    [h => {h.state.admin = false;}, 403], [h => {h.state.session = false;}, 401],
    [h => {h.state.channel.tenant_id = id(99);}, 404],
    [h => {h.state.channel.settings.simulation = true;}, 422],
    [h => {h.state.channel.provider = 'other';}, 404],
    [h => {h.state.channel.mode = 'other';}, 422],
  ];
  for (const [mutate, status] of cases) {
    const h = harness(); mutate(h);
    await assert.rejects(h.read(), (e: any) => e.status === status); assert.equal(h.calls.length, 0);
  }
  const h = harness(); await assert.rejects(h.read({...actor, role: 'viewer'}), (e: any) => e.status === 403);
  await assert.rejects(h.read(actor, 'wrong'), (e: any) => e.status === 401); assert.equal(h.calls.length, 0);
});

test('role, session and channel changes during OAuth or quota read discard the observation', async () => {
  for (const index of [1, 2]) for (const change of ['role', 'session', 'connection']) {
    const h = harness(); h.enqueue();
    h.state.afterRequest = n => {if (n !== index) return;
      if (change === 'role') h.state.admin = false;
      if (change === 'session') h.state.session = false;
      if (change === 'connection') h.state.channel.credentials.client_secret = 'ROTATED';
    };
    await assert.rejects(h.read(), (e: any) => e.status === ({role: 403, session: 401, connection: 409}[change]));
    assert.equal(h.calls.length, index); assert(h.transactions.every(tx => tx.closed));
  }
});

test('Analytics family is exact and isolated from seller and arbitrary eBay endpoints', () => {
  for (const mode of ['sandbox', 'live']) {
    const base = ebay.ebayBase(mode), path = '/developer/analytics/v1_beta/rate_limit/';
    assert.equal(apiLimits.ebayApiFamily(mode, base + path), 'analytics');
    for (const tail of ['rate_limit', 'user_rate_limit/', 'rate_limit/?api_name=inventory', 'rate_limit/child'])
      assert.throws(() => apiLimits.ebayApiFamily(mode, base + '/developer/analytics/v1_beta/' + tail));
    assert.throws(() => apiLimits.ebayApiFamily(mode, base + path + '#fragment'));
    assert.throws(() => apiLimits.ebayApiFamily(mode, 'https://foreign.example' + path));
    assert.equal(apiLimits.ebayApiFamily(mode, base + '/sell/inventory/v1/offer'), 'inventory');
  }
});

test('actual registered explicit read action checks admin, strict body and browser cookie binding', async () => {
  const routes = new Map<string, any>(), calls: any[] = [];
  const context = {transport: noCall};
  const module = compiled('server/sync-routes.ts', {
    'node:crypto': crypto, zod: {z}, './db': {pool: {}, tenantTx: noCall}, './errors': errors,
    './security': security, './domain': {audit: noCall}, './amazon-account': {},
    './channel-access': {}, './sync': {}, './import-routes': {},
    './ebay-provider-quota': {readEbayProviderQuota: async (...args: any[]) => {calls.push(args); return 'quota';}},
    './ebay-oauth': {ebayCallbackPath: '/api/oauth/ebay/callback'},
  });
  const register = (verb: string) => (path: string, handler: any) => routes.set(verb + ' ' + path, handler);
  module.registerSyncRoutes({get: register('GET'), post: register('POST'), patch: register('PATCH'),
    register: (plugin: any) => plugin({post: register('POST'),
      removeContentTypeParser() {}, addContentTypeParser() {}})}, context, 'own_session');
  const route = '/api/integrations/:id/ebay/provider-quota/read', handler = routes.get('POST ' + route);
  assert(handler); assert(!routes.has('GET ' + route));
  const req = {actor, cookies: {own_session: 'browser-cookie', dyna_session: 'wrong'}, params: {id: channel.id}, body: {}};
  assert.equal(await handler(req), 'quota'); assert.deepEqual(calls[0], [actor, session, channel.id, context]);
  await assert.rejects(handler({...req, actor: {...actor, role: 'viewer'}}), (e: any) => e.status === 403);
  await assert.rejects(handler({...req, body: {api_name: 'inventory'}}), (e: any) => e instanceof z.ZodError);
  await assert.rejects(handler({...req, params: {id: 'bad'}}), (e: any) => e instanceof z.ZodError);
  assert.equal(calls.length, 1);
});

test('actual UI fetches provider quota only on click, distinguishes local counters and refuses stale-channel results', async () => {
  const React = await import('react'), {JSDOM} = require('jsdom');
  const dom = new JSDOM('<!doctype html><body/>', {url: 'http://127.0.0.1/'}), saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({window: dom.window, document: dom.window.document,
    navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, Event: dom.window.Event,
    MouseEvent: dom.window.MouseEvent, IS_REACT_ACT_ENVIRONMENT: true})) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {configurable: true, writable: true, value});
  }
  const {createRoot} = await import('react-dom/client');
  const calls: {path: string; method: string}[] = [];
  let simulation = false, deferred: ((value: any) => void) | undefined;
  const observed = {source: 'ebay_developer_analytics', scope: 'application', mode: 'sandbox',
    observed_at: '2026-10-18T23:00:00.000Z', status: 'observed', rows: harness().api.parseEbayProviderQuota(raw())};
  let next: () => any = () => observed;
  const api = async (path: string, method = 'GET', body?: unknown) => {
    calls.push({path, method});
    if (method === 'GET') {
      assert(path.endsWith('/ebay/api-limits')); return {scope: simulation ? 'local_simulation' : 'local_observation',
        concurrency_limit: 4, families: [{family: 'inventory', active_requests: 2, limited_responses: '7'}]};
    }
    assert(path.endsWith('/ebay/provider-quota/read')); assert.equal(method, 'POST'); assert.deepEqual(body, {});
    return next();
  };
  const {EbayApiLimits} = compiled('web/ebay-api-limits.tsx', {
    react: React, 'react/jsx-runtime': require('react/jsx-runtime'), './api': {api, date: (v: string) => v},
  });
  const el = document.createElement('div'); document.body.append(el); const root = createRoot(el);
  const tick = () => React.act(async () => {await setTimeout(0);});
  const until = async (condition: () => boolean) => {for (let n = 0; n < 40 && !condition(); n++) await tick(); assert(condition());};
  const render = async (id: string) => React.act(async () => {root.render(React.createElement(EbayApiLimits, {channelId: id}));});
  const button = () => [...el.querySelectorAll('button')].find(b => b.textContent?.startsWith('Odczytaj limity przyznane'))!;
  const click = async () => React.act(async () => {button().click();});
  try {
    await render(channel.id); await until(() => Boolean(button() && !button().disabled));
    assert.equal(calls.length, 1); assert(calls.every(c => c.method === 'GET'));
    await click(); await until(() => el.textContent!.includes('updateOffer'));
    assert(el.textContent!.includes('nie jest limitem konta sprzedawcy'));
    assert(el.textContent!.includes('Brak danych')); assert(el.textContent!.includes('2 / 4'));
    assert(el.textContent!.includes('86400') || el.textContent!.includes('86\u00a0400'));
    const providerCalls = () => calls.filter(c => c.method === 'POST').length;
    assert.equal(providerCalls(), 1); await tick(); assert.equal(providerCalls(), 1);
    next = () => ({...observed, status: 'no_data', rows: []});
    await click(); await until(() => el.textContent!.includes('Nie oznacza to zerowej ani nieograniczonej puli'));
    next = () => {throw new Error('Odczyt przerwany');};
    await click(); await until(() => el.querySelector('[role="alert"]')?.textContent === 'Odczyt przerwany');
    assert(!el.textContent!.includes('updateOffer')); assert.equal(providerCalls(), 3);
    next = () => new Promise(resolve => {deferred = resolve;});
    await click(); assert(deferred); await render(id(4)); await tick();
    await React.act(async () => deferred!({...observed, rows: [{...observed.rows[0], resource: 'STALE-OLD-CHANNEL'}]}));
    assert(!el.textContent!.includes('STALE-OLD-CHANNEL'));
    simulation = true; await render(id(5)); await until(() => Boolean(button()?.disabled));
    const before = calls.length; await click(); assert.equal(calls.length, before);
    assert(el.textContent!.includes('Przykład lokalny nie potwierdza limitów eBay'));
  } finally {
    await React.act(async () => root.unmount()); el.remove(); dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete (globalThis as any)[key];
    }
  }
});
