#!/usr/bin/env node
// One closed-loop load client (one request in flight, no think time, no retries; a 409 of a pre-labelled race is an
// expected refusal, lib.mjs EXPECTED_RACES, or the race its command was prepared for: the phase's finite-stock
// contention SKU, lib.mjs contentionRace). Runs in its own container in
// the release's network namespace and binds its own source address 127.0.0.<n>, so the server's per-peer rate
// limit (600/min, server/http-peer-ip.ts) sees one address per client. Started by tools/scale/load/run.mjs.
//
//   node tools/scale/load/client.mjs <config.json>
//   config: { run_id, phase, client, clients, start_at, duration_s, origin, local_address, sessions, out_dir, seed, profile, run_started_at }
//
// Each measured request goes through the source-pinned bindings (scripts/full-base-scale-http-ports.mjs): prepare()
// builds the request from a command prepared just before (tools/scale/load/prepare.mjs, unmeasured, recorded
// separately), complete() checks the response DTO against the exact expectations. Writes NDJSON samples.
import http from 'node:http';
import { readFileSync, openSync, writeSync, closeSync, fsyncSync } from 'node:fs';
import { join } from 'node:path';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { createPreparedScaleHttpOperationBindings, SCALE_HTTP_PORT_SOURCE_PINS } from '../../../scripts/full-base-scale-http-ports.mjs';
import { validateScaleHttpRequest } from '../../../scripts/full-base-scale-driver.mjs';
import { mixCycle, taskAt, rng, oneShotFixture, classifyConflict, contentionClients, OPERATIONS } from './lib.mjs';
import { createPreparer, PrepError, NotBindable } from './prepare.mjs';

const cfg = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const sessions = JSON.parse(readFileSync(cfg.sessions, 'utf8'));
const profile = JSON.parse(readFileSync(cfg.profile, 'utf8')).config;
const cycle = mixCycle(profile.http.mix), timeoutMs = profile.http.timeouts_ms.driver_request;
const origin = new URL(cfg.origin);
const agent = new http.Agent({ keepAlive: true, maxSockets: 1, localAddress: cfg.local_address });
const tag = `${cfg.phase}-c${String(cfg.client).padStart(2, '0')}`;
const files = Object.fromEntries(['samples', 'prep', 'loop'].map((k) => [k, openSync(join(cfg.out_dir, `${tag}.${k}.ndjson`), 'wx', 0o600)]));
const write = (k, rec) => writeSync(files[k], JSON.stringify(rec) + '\n');
const tenants = sessions.tenants.map(({ slot, tenant_id, user_id, cookie }) => ({ slot, tenant_id, user_id, cookie }));
const bindings = tenants.map(({ slot, tenant_id, user_id }) => ({ slot, tenant_id, user_id }));

/** One HTTP exchange; the body is read completely before the clock stops. */
function exchange(method, path, headers, body) {
  return new Promise((resolve) => {
    const t0 = performance.now(), payload = body === null || body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({ host: origin.hostname, port: origin.port, method, path, agent, timeout: timeoutMs,
      headers: { ...headers, ...(payload ? { 'content-length': payload.length } : {}) } }, (res) => {
      const parts = [], ttfb = performance.now() - t0;
      res.on('data', (b) => parts.push(b));
      res.on('end', () => {
        const ms = performance.now() - t0, text = Buffer.concat(parts).toString('utf8');
        let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON body: kept as text */ }
        resolve({ status: res.statusCode, json, text, ms, ttfb, contentType: res.headers['content-type'] ?? '' });
      });
      res.on('error', (e) => resolve({ status: null, error: e.code ?? e.message, ms: performance.now() - t0 }));
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'HTTP_TIMEOUT' })));
    req.on('error', (e) => resolve({ status: null, error: e.code ?? e.message, ms: performance.now() - t0 }));
    if (payload) req.write(payload);
    req.end();
  });
}

const preparers = new Map();
for (const t of sessions.tenants) {
  const api = async (method, route, path, body) => {
    const res = await exchange(method, path, { cookie: t.cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body ?? null);
    write('prep', { phase: cfg.phase, client: cfg.client, tenant_slot: t.slot, method, route, status: res.status, duration_ms: +res.ms.toFixed(2), at: Date.now(), ...(res.error ? { error: res.error } : {}) });
    if (res.status === null) throw new PrepError(`${method} ${route}`, 0, res.error);
    return res;
  };
  preparers.set(t.slot, createPreparer({ ctx: t, api, r: rng(`${cfg.seed}:${cfg.run_id}:${cfg.phase}:${cfg.client}:${t.slot}`), client: cfg.client, clients: cfg.clients,
    datasetBefore: cfg.run_started_at == null ? null : Date.parse(cfg.run_started_at), phase: cfg.phase,
    contentionEligible: Boolean(t.contention?.[cfg.phase]) && contentionClients(cycle, cfg.clients, t.slot, t.contention[cfg.phase].demand_clients).includes(cfg.client) }));
}

const detailOf = (res) => (res.json && typeof res.json === 'object' ? (res.json.detail ?? res.json.title ?? res.json.error ?? res.json.message ?? null) : (res.text ?? '').slice(0, 200));
async function one(k) {
  const t = taskAt(cycle, cfg.client, cfg.clients, k), slot = t.tenant_slot, op = t.operation;
  const task = Object.freeze({ request_id: `${cfg.run_id}:${cfg.phase}:${cfg.client}:${k}`, sequence: t.n, client: cfg.client, tenant_slot: slot, operation: op, phase: cfg.phase, measured: true });
  const base = { phase: cfg.phase, client: cfg.client, k, n: t.n, tenant_slot: slot, operation: op };
  let prepared;
  const p0 = performance.now();
  try { prepared = await preparers.get(slot)(op); }
  catch (e) {
    if (e instanceof NotBindable) return write('samples', { ...base, start_ms: Date.now(), duration_ms: 0, http_status: null, outcome: 'not_bindable', reason: 'NOT_BINDABLE', detail: e.message });
    await new Promise((r) => setTimeout(r, 200)); // a refused preparation must not spin into the per-address rate limit
    return write('samples', { ...base, start_ms: Date.now(), duration_ms: 0, http_status: e.status ?? null, outcome: 'prep_failed', reason: 'PREP_FAILED',
      detail: e instanceof PrepError ? `${e.route}: ${e.status} ${e.detail ?? ''}`.slice(0, 300) : String(e?.stack ?? e).slice(0, 300) });
  }
  const prepMs = performance.now() - p0;
  const ports = createPreparedScaleHttpOperationBindings({ origin: cfg.origin, bindings, context: { fixture: oneShotFixture(SCALE_HTTP_PORT_SOURCE_PINS, tenants, slot, op, prepared.cmd) } });
  let request;
  try { request = validateScaleHttpRequest(ports[slot][op].prepare(task), task, cfg.origin); }
  catch (e) { return write('samples', { ...base, start_ms: Date.now(), duration_ms: 0, http_status: null, outcome: 'prep_failed', reason: 'BINDING_REFUSED_COMMAND', detail: String(e.message).slice(0, 300) }); }
  const startMs = Date.now();
  const res = await exchange(request.method, request.path, { ...request.headers, 'x-request-id': task.request_id }, request.body);
  const sample = { ...base, start_ms: startMs, duration_ms: +res.ms.toFixed(2), ttfb_ms: res.ttfb == null ? null : +res.ttfb.toFixed(2), prep_ms: +prepMs.toFixed(1), http_status: res.status, class: OPERATIONS[op],
    ...(prepared.hot ? { hot: true } : {}), ...(prepared.contention ? { contention: true } : {}) };
  if (res.status === null) return write('samples', { ...sample, outcome: 'failure', reason: res.error === 'HTTP_TIMEOUT' ? 'HTTP_TIMEOUT' : 'HTTP_ERROR', detail: res.error });
  if (res.ms >= timeoutMs) return write('samples', { ...sample, outcome: 'failure', reason: 'HTTP_TIMEOUT', detail: null });
  // 409: classified by its exact native reason. A pre-labelled race (lib.mjs EXPECTED_RACES) is an expected refusal:
  // not retried (profile: no automatic retry of writes), its no-effect checked by an unmeasured readback.
  const conflict = classifyConflict(op, res.status, detailOf(res), prepared.race ?? null);
  if (conflict) {
    const detail = String(detailOf(res) ?? '').slice(0, 300);
    if (!conflict.labelled) return write('samples', { ...sample, outcome: 'failure', reason: 'HTTP_STATUS', conflict_cause: conflict.cause, detail });
    let noEffect = null;
    try { noEffect = (await prepared.noEffect?.()) ?? null; } catch { noEffect = null; }
    return write('samples', { ...sample, outcome: noEffect === false ? 'failure' : 'expected_refusal', reason: noEffect === false ? 'REFUSAL_HAD_EFFECT' : 'LABELLED_RACE',
      conflict_cause: conflict.cause, no_effect: noEffect, detail });
  }
  try {
    if (!String(res.contentType).toLowerCase().startsWith('application/json') || res.json === null) throw Object.assign(new Error('json-response-required'), { protocol: true });
    const out = ports[slot][op].complete(Object.freeze({ task, http_status: res.status, data: res.json }));
    if (out.outcome !== 'success') return write('samples', { ...sample, outcome: 'failure', reason: out.reason ?? 'BINDING_OUTCOME', detail: null });
  } catch (e) {
    const ok = res.status >= 200 && res.status < 300;
    return write('samples', { ...sample, outcome: 'failure', reason: ok ? (e.protocol ? 'HTTP_PROTOCOL_INVALID' : 'HTTP_DTO_INVALID') : 'HTTP_STATUS',
      detail: ok ? String(e.message).slice(0, 300) : String(detailOf(res) ?? '').slice(0, 300) });
  }
  prepared.after?.(res.json);
  return write('samples', { ...sample, outcome: 'success', reason: null });
}

const end = cfg.start_at + cfg.duration_s * 1000;
if (Date.now() < cfg.start_at) await new Promise((r) => setTimeout(r, cfg.start_at - Date.now()));
// Event-loop delay of this client over the phase: evidence that measured latency is not the driver's own queueing.
const loop = monitorEventLoopDelay({ resolution: 10 }); loop.enable();
let k = 0;
while (Date.now() < end) await one(k++);
loop.disable();
const ms = (ns) => +(ns / 1e6).toFixed(2);
write('loop', { phase: cfg.phase, client: cfg.client, p50_ms: ms(loop.percentile(50)), p99_ms: ms(loop.percentile(99)), max_ms: ms(loop.max) });
for (const f of Object.values(files)) { fsyncSync(f); closeSync(f); }
agent.destroy();
process.stdout.write(JSON.stringify({ status: 'CLIENT_DONE', tag, tasks: k }) + '\n');
