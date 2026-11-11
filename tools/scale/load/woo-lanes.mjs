#!/usr/bin/env node
// Woo lane setup and stop for a load run, through the ordinary API of the running dyna-load-app with each tenant
// owner's session (run.mjs starts it in the database container's namespace, like probe.mjs). Nothing is printed
// but the result line; the plan and output files are 0600 in the run's private directory.
//   start: enroll the run's channel (POST /api/local-fixtures/woocommerce/channels/:id), map the run's Woo products
//          to DYNAMINDS SKUs (POST /api/integrations/:id/mappings), stock-only offer sync (30 s), orders.sync read
//          lane (60 s); after the first read of every channel is done (it stages the store's older orders, which are
//          never imported), the order import opt-in. Order: no import of an order seen before the opt-in (server
//          local-woo-order-import.ts) and no first read with more than 50 new orders under import.
//   stop:  the same three commands with enabled false (expected versions from start): import and read first, then
//          stock at once. The stock pause ends the lane's work that sent no write without effect (job done with the
//          cause, plan conflict) and lets a write that already left finish its verification; only a genuinely
//          uncertain write stays (failed, reported by the reconciliation). Then wait until the stock channel is quiet
//          (woo.mjs stockQuiet), no read occurrence is queued/running and no import receipt is open.
//
//   node tools/scale/load/woo-lanes.mjs <start|stop> <plan.json> <sessions.json> <port> <out.json>
import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { laneCommands, stockQuiet } from './woo.mjs';

const [mode, planFile, sessionsFile, port, outFile] = process.argv.slice(2);
if (!['start', 'stop'].includes(mode) || !outFile) throw new Error('usage: woo-lanes.mjs <start|stop> <plan> <sessions> <port> <out>');
const plan = JSON.parse(readFileSync(planFile, 'utf8')), sessions = JSON.parse(readFileSync(sessionsFile, 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function call(t, method, path, body) {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, { method, redirect: 'error', signal: AbortSignal.timeout(30000),
    headers: { cookie: t.cookie, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* below */ }
  return { status: r.status, json, text: text.slice(0, 300) };
}
const expect = (res, codes, what) => { if (!codes.includes(res.status)) throw new Error(`${what}: HTTP ${res.status} ${res.text}`); return res.json; };
const result = { mode, tenants: {}, started_at: new Date().toISOString() };
const lanesOf = async (t, ch) => expect(await call(t, 'GET', `/api/local-fixtures/woocommerce/channels/${ch}/read-lanes`), [200], 'read lanes');
const latest = (lanes) => lanes.history?.data?.find((o) => o.kind === 'orders.sync') ?? null;
try {
  const tenants = plan.tenants.map((p) => ({ ...p, session: sessions.tenants.find((t) => t.slot === p.slot) }));
  if (mode === 'start') {
    for (const t of tenants) {
      const s = t.session, r = { channel_id: t.channel_id };
      expect(await call(s, 'POST', `/api/local-fixtures/woocommerce/channels/${t.channel_id}`, { name: t.name }), [201], `${t.slot} enroll`);
      for (const m of t.mappings) expect(await call(s, 'POST', `/api/integrations/${t.channel_id}/mappings`, m), [200, 201], `${t.slot} mapping ${m.external_id}`);
      r.mappings = t.mappings.length;
      const c = laneCommands({ tenant: s, channelId: t.channel_id, keys: [randomUUID(), randomUUID(), randomUUID()], versions: { read: '0', import: '0', stock: 0 }, enabled: true });
      r.stock = { version: expect(await call(s, 'POST', c.stock.path, c.stock.body), [200, 201], `${t.slot} offer sync`).config.version };
      r.read = { version: expect(await call(s, 'POST', c.read.path, c.read.body), [201], `${t.slot} read lane`).version, configured_at: new Date().toISOString() };
      r.pending_import = c.import; result.tenants[t.slot] = r;
    }
    // First read of every channel done before the import opt-in (interval 60 s; first run >= interval after configure).
    const deadline = Date.now() + 180000;
    for (const t of tenants) {
      for (;;) {
        const o = latest(await lanesOf(t.session, t.channel_id));
        if (o?.state === 'done') { result.tenants[t.slot].read.first_done_occurrence = o.id; break; }
        if (o && !['queued', 'running'].includes(o.state)) throw new Error(`${t.slot} first read ${o.state}`);
        if (Date.now() > deadline) throw new Error(`${t.slot} first read not done in 180 s (a parked channel stays parked until restart)`);
        await sleep(2000);
      }
    }
    for (const t of tenants) {
      const r = result.tenants[t.slot], c = r.pending_import; delete r.pending_import;
      r.import = { version: expect(await call(t.session, 'POST', c.path, c.body), [201], `${t.slot} order import`).version, enabled_at: new Date().toISOString() };
    }
  } else {
    const started = JSON.parse(readFileSync(plan.started_file, 'utf8'));
    for (const t of tenants) {
      const v = started.tenants[t.slot], s = t.session, r = { channel_id: t.channel_id };
      const c = laneCommands({ tenant: s, channelId: t.channel_id, keys: [randomUUID(), randomUUID(), randomUUID()], versions: { read: v.read.version, import: v.import.version, stock: v.stock.version }, enabled: false });
      r.import = expect(await call(s, 'POST', c.import.path, c.import.body), [201], `${t.slot} import off`).version;
      r.read = expect(await call(s, 'POST', c.read.path, c.read.body), [201], `${t.slot} read off`).version;
      r.stock = expect(await call(s, 'POST', c.stock.path, c.stock.body), [200, 201], `${t.slot} stock off`).config.version;
      // The job in flight at the pause settles within its own cycle; bounded, recorded, never a retry.
      const quietBy = Date.now() + 60000; let waits = 0, quiet = true;
      while (!stockQuiet(expect(await call(s, 'GET', `/api/integrations/${t.channel_id}/offer-sync?limit=100`), [200], `${t.slot} stock state`))) {
        if (Date.now() > quietBy) { quiet = false; break; }
        waits++; await sleep(250);
      }
      r.stock_quiet = quiet; r.stock_quiet_polls = waits; result.tenants[t.slot] = r;
    }
    const deadline = Date.now() + 120000;
    for (const t of tenants) {
      for (;;) {
        const o = latest(await lanesOf(t.session, t.channel_id));
        const imp = expect(await call(t.session, 'GET', `/api/local-fixtures/woocommerce/channels/${t.channel_id}/order-import`), [200], 'import state');
        const busy = ['queued', 'running'].includes(o?.state) || imp.receipts.some((x) => x.state !== 'done');
        if (!busy) { result.tenants[t.slot].settled = { read: o?.state ?? null, receipts_open: 0 }; break; }
        if (Date.now() > deadline) { result.tenants[t.slot].settled = { read: o?.state ?? null, receipts_open: imp.receipts.filter((x) => x.state !== 'done').length, timeout: true }; break; }
        await sleep(2000);
      }
    }
  }
  result.status = 'OK';
} catch (e) { result.status = 'FAILED'; result.error = String(e.message).slice(0, 800); }
result.finished_at = new Date().toISOString();
writeFileSync(outFile, JSON.stringify(result, null, 1) + '\n', { mode: 0o600 });
console.log(JSON.stringify({ status: result.status, ...(result.error ? { error: result.error } : {}) }));
process.exitCode = result.status === 'OK' ? 0 : 1;
