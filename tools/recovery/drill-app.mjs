#!/usr/bin/env node
// Application side of the restore drill (tools/recovery/restore-drill.mjs). Runs inside the packaged
// release, in the database container's network namespace (tools/recovery/docker.mjs netnsNode).
//
//   seed   --release <release-build.json> --state <dir> --email <tenant owner> --orders N --run <id> [--phase 1|2]
//          Through the ordinary API of the release (factory with the scoped automation processor available,
//          no HTTP listener, so nothing is claimed here). Phase 1: one owned automation rule order.created →
//          add_note with its local worker switched on, one product image, N orders. Phase 2 (same run, after
//          the base backup): one more image and N more orders. Leaves one pending `automation` job per order.
//          Writes <state>/seed.json (ids, digests; no secrets) and <state>/session.private (0600, session
//          token for the post-restore API checks; never printed).
//          --readback N (phase 1, before any drill write): for every tenant owner matching --readback-owners
//          (SQL LIKE), N orders and N invoice230 documents picked by md5(id), read through the API; the
//          canonical-JSON sha256 of each response goes to <state>/readback.private.json (0600, with the
//          sessions and bodies; never printed).
//   verify --state <dir> --port P [--timeout-ms T]
//          Against the restored database and the running release CLI on 127.0.0.1:P: the ten guards (session
//          jit=off, timezone=UTC), the seeded queue drained exactly once (job attempts, runs, note markers,
//          note events), and API reads with the restored session (rule worker state, image bytes, order).
//          Also warehouse_wz_issuer_guards() and email_inbound_guards(), and, when readback.private.json exists,
//          the same API reads compared with the source responses (canonical-JSON sha256).
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { checkGuards } from '../scale/inspect.mjs';

const { values: a, positionals: [mode] } = parseArgs({ allowPositionals: true, options: {
  release: { type: 'string' }, state: { type: 'string' }, email: { type: 'string' }, orders: { type: 'string', default: '20' },
  run: { type: 'string' }, phase: { type: 'string', default: '1' }, port: { type: 'string' }, 'timeout-ms': { type: 'string', default: '300000' },
  readback: { type: 'string', default: '0' }, 'readback-owners': { type: 'string' } } });
const sha = (b) => createHash('sha256').update(b).digest('hex');
const SESSION = 'dyna_session';
// 1×1 PNG: the image format check needs a real PNG signature.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
function expect(res, codes, what) {
  if (!codes.includes(res.statusCode)) throw new Error(`${what}: HTTP ${res.statusCode} ${res.body.slice(0, 300)}`);
  return res.body ? res.json() : null;
}
const marker = (run) => `drill-note-${run}`;
const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === 'object'
  ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
const bodyDigest = (text) => sha(JSON.stringify(canon(JSON.parse(text))));

/** Source side of the API read-back: sample orders and invoice230 documents of every matching tenant owner. */
async function captureReadback({ app, db, ws }) {
  const n = Number(a.readback);
  if (!a['readback-owners']) throw new Error('--readback needs --readback-owners <LIKE pattern>');
  const owners = (await db.pool.query(`SELECT u.id,u.name,u.email,m.tenant_id FROM users u JOIN memberships m ON m.user_id=u.id AND m.role='admin'
    WHERE u.email LIKE $1 ORDER BY u.email`, [a['readback-owners']])).rows;
  if (!owners.length) throw new Error('no read-back owners');
  const sessions = {}, entries = [];
  for (const o of owners) {
    const { token } = await ws.loginWorkspace({ id: o.id, name: o.name, email: o.email });
    sessions[o.tenant_id] = token;
    const pick = async (sql) => (await db.pool.query(sql, [o.tenant_id, n])).rows.map((r) => r.id);
    const paths = [
      ...(await pick('SELECT id FROM orders WHERE tenant_id=$1 ORDER BY md5(id::text) LIMIT $2')).map((id) => `/api/orders/${id}`),
      ...(await pick("SELECT id FROM documents WHERE tenant_id=$1 AND mode='invoice230' ORDER BY md5(id::text) LIMIT $2")).map((id) => `/api/invoice230/documents/${id}`),
    ];
    for (const path of paths) {
      const res = await app.inject({ method: 'GET', url: path, cookies: { [SESSION]: token } });
      if (res.statusCode !== 200) throw new Error(`read-back ${path}: HTTP ${res.statusCode}`);
      entries.push({ tenant_id: o.tenant_id, path, status: res.statusCode, sha256: bodyDigest(res.body), body: res.body });
    }
  }
  writeFileSync(join(a.state, 'readback.private.json'), JSON.stringify({ sessions, entries }) + '\n', { mode: 0o600, flag: 'wx' });
  return { owners: owners.length, reads: entries.length };
}

async function seed() {
  if (!/^[a-z0-9-]{4,40}$/.test(a.run ?? '')) throw new Error('--run <id> required');
  const n = Number(a.orders);
  const { openReleaseRuntime } = await import('../scale/release-runtime.mjs');
  const t0 = Date.now();
  const rt = await openReleaseRuntime({ buildRecord: a.release, connections: 4, factoryOptions: { scopedAutomationEnabled: true } });
  const factoryMs = Date.now() - t0;
  try {
    const { app, db, ws } = rt;
    const user = (await db.pool.query('SELECT id,name,email FROM users WHERE email=$1', [a.email])).rows[0];
    if (!user) throw new Error('no such tenant owner');
    const tenants = (await db.pool.query("SELECT tenant_id FROM memberships WHERE user_id=$1 AND role='admin'", [user.id])).rows;
    if (tenants.length !== 1) throw new Error(`owner has ${tenants.length} admin tenants, expected 1`);
    const tenantId = tenants[0].tenant_id;
    const { token } = await ws.loginWorkspace({ id: user.id, name: user.name, email: user.email });
    const call = (method, url, payload) => app.inject({ method, url, cookies: { [SESSION]: token }, ...(payload ? { payload } : {}) });
    const readback = a.phase === '1' && Number(a.readback) > 0 ? await captureReadback({ app, db, ws }) : null;
    // Phase 1 creates the rule and switches its local worker on; phase 2 (after the base backup) adds orders only.
    const prev = a.phase === '2' ? JSON.parse(readFileSync(join(a.state, 'seed.json'), 'utf8')) : null;
    if (prev && prev.run !== a.run) throw new Error('phase 2 needs the seed.json of the same run');
    let rule, activation;
    if (prev) { rule = { id: prev.rule_id }; activation = { version: prev.rule_version }; }
    else {
      rule = expect(await call('POST', '/api/automations', { name: `Drill odtworzenia ${a.run}`, trigger: 'order.created',
        actions: [{ type: 'add_note', note: marker(a.run) }] }), [200, 201], 'rule');
      activation = expect(await call('POST', `/api/automations/${rule.id}/local-worker`,
        { client_key: randomUUID(), version: String(rule.version), enabled: true }), [201], 'local worker');
    }
    const image = expect(await call('POST', '/api/product-images', { data: PNG }), [201], 'image');
    const warehouse = expect(await call('GET', '/api/warehouses'), [200], 'warehouses').data.find((w) => w.code === 'MAIN');
    const offset = prev ? prev.orders.length : 0;
    const products = (await db.pool.query("SELECT id FROM products WHERE tenant_id=$1 AND sku LIKE 'SC-%' AND kind IN ('simple','variant') ORDER BY sku OFFSET $2 LIMIT $3",
      [tenantId, offset, n])).rows;
    if (products.length < n) throw new Error(`only ${products.length} products`);
    const orders = [...(prev?.orders ?? [])];
    for (let k = offset; k < offset + n; k++) {
      const o = expect(await call('POST', '/api/orders', { customer_name: `Klient drill ${k}`, email: `drill-${a.run}-${k}@scale.example.test`,
        warehouse_id: warehouse.id, address: { street: 'Testowa 1', city: 'Poznań', postal_code: '60-001', country: 'PL', phone: '500000000' },
        shipping_cost: 0, note: `drill-order-${a.run}-${k}`, items: [{ product_id: products[k - offset].id, quantity: 1 }] }), [200, 201], 'order ' + k);
      orders.push(o.id);
    }
    const jobs = (await db.pool.query(`SELECT id,state,attempts FROM jobs WHERE tenant_id=$1 AND kind='automation' AND payload->'rules' @> $2::jsonb ORDER BY id`,
      [tenantId, JSON.stringify([{ id: rule.id, version: activation.version }])])).rows;
    const pending = jobs.filter((j) => j.state === 'pending' && Number(j.attempts) === 0).length;
    if (jobs.length !== orders.length || pending !== orders.length)
      throw new Error(`expected ${orders.length} pending automation jobs, found ${jobs.length} (${pending} pending)`);
    const at = (await db.pool.query("SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') t")).rows[0].t;
    const imageBytes = readFileSync(join(process.env.DYNA_IMAGE_DIR, image.id));
    const out = { schema: 'dyna-recovery-drill-seed/v1', run: a.run, tenant_id: tenantId, owner_id: user.id, rule_id: rule.id,
      rule_version: activation.version, marker: marker(a.run), orders, jobs: jobs.map((j) => j.id),
      images: [...(prev?.images ?? []), { id: image.id, bytes: imageBytes.length, sha256: sha(imageBytes), phase: Number(a.phase) }],
      phases: [...(prev?.phases ?? []), { phase: Number(a.phase), orders: n, seeded_at: at, factory_ms: factoryMs }],
      release: rt.release.release_manifest_sha256 };
    writeFileSync(join(a.state, 'seed.json'), JSON.stringify(out, null, 2) + '\n', { mode: 0o600 });
    writeFileSync(join(a.state, 'session.private'), token, { mode: 0o600, flag: 'w' });
    console.log(JSON.stringify({ status: 'SEEDED', phase: Number(a.phase), pending_jobs: pending, orders: orders.length, rule_id: rule.id, seeded_at: at, factory_ms: factoryMs, readback }));
  } finally { await rt.close(); }
}

async function verify() {
  const s = JSON.parse(readFileSync(join(a.state, 'seed.json'), 'utf8'));
  const token = readFileSync(join(a.state, 'session.private'), 'utf8').trim();
  const url = process.env.DATABASE_URL, out = { status: 'VERIFIED' };
  let t = Date.now();
  const guards = await checkGuards(url);
  out.guards = { all_true: guards.all_true, values: guards.values, ms: Date.now() - t };
  const c = new pg.Client({ connectionString: url, options: '-c jit=off -c timezone=UTC' });
  await c.connect();
  try {
    const q = async (sql, args) => (await c.query(sql, args)).rows;
    t = Date.now();
    const [extra] = await q('SELECT public.warehouse_wz_issuer_guards() warehouse_wz_issuer_guards, public.email_inbound_guards() email_inbound_guards');
    out.extra_guards = { values: extra, all_true: Object.values(extra).every((v) => v === true), ms: Date.now() - t };
    t = Date.now();
    const deadline = t + Number(a['timeout-ms']);
    let jobs;
    for (;;) {
      jobs = await q(`SELECT j.id,j.state,j.attempts FROM jobs j WHERE j.id=ANY($1::uuid[])
        UNION ALL SELECT j.id,j.state,j.attempts FROM automation_runs r JOIN jobs j ON (j.tenant_id,j.id)=(r.tenant_id,r.job_id)
        WHERE r.tenant_id=$2 AND r.rule_id=$3`, [s.jobs, s.tenant_id, s.rule_id]);
      if (jobs.length >= 2 * s.jobs.length && jobs.every((j) => j.state === 'done' || j.state === 'failed')) break;
      if (Date.now() > deadline) throw new Error(`queue not drained in ${a['timeout-ms']} ms: ${JSON.stringify(jobs.reduce((m, j) => ({ ...m, [j.state]: (m[j.state] ?? 0) + 1 }), {}))}`);
      await new Promise((r) => setTimeout(r, 500));
    }
    out.drain_ms = Date.now() - t;
    const runs = await q('SELECT state,count(*)::int n FROM automation_runs WHERE tenant_id=$1 AND rule_id=$2 GROUP BY 1', [s.tenant_id, s.rule_id]);
    const perOrder = await q(`SELECT o.id,(length(o.note)-length(replace(o.note,$2,'')))/length($2) markers,
        (SELECT count(*)::int FROM order_events e WHERE e.tenant_id=o.tenant_id AND e.order_id=o.id AND e.kind='order.note_added') note_events,
        (SELECT count(*)::int FROM automation_runs r WHERE r.tenant_id=o.tenant_id AND r.rule_id=$3 AND r.order_id=o.id) runs
      FROM orders o WHERE o.id=ANY($1::uuid[]) ORDER BY o.id`, [s.orders, s.marker, s.rule_id]);
    const hist = (k) => perOrder.reduce((m, r) => ({ ...m, [r[k]]: (m[r[k]] ?? 0) + 1 }), {});
    out.queue = {
      jobs: jobs.reduce((m, j) => { const k = `${j.state}/attempts=${j.attempts}`; return { ...m, [k]: (m[k] ?? 0) + 1 }; }, {}),
      runs: Object.fromEntries(runs.map((r) => [r.state, r.n])),
      orders: perOrder.length, markers_per_order: hist('markers'), note_events_per_order: hist('note_events'),
      runs_per_order: hist('runs'),
    };
    out.exactly_once = jobs.every((j) => j.state === 'done' && Number(j.attempts) === 1) && perOrder.length === s.orders.length &&
      perOrder.every((r) => Number(r.markers) === 1 && Number(r.note_events) === 1 && Number(r.runs) === 1);
  } finally { await c.end(); }
  const base = `http://127.0.0.1:${a.port}`, get = (p) => fetch(base + p, { headers: { cookie: `${SESSION}=${token}` } });
  t = Date.now();
  const health = await fetch(base + '/api/health');
  const worker = await get(`/api/automations/${s.rule_id}/local-worker`);
  const w = worker.ok ? await worker.json() : null;
  const images = [];
  for (const im of s.images) {
    const r = await get(`/api/product-images/${im.id}`);
    images.push({ id: im.id, phase: im.phase, status: r.status, sha256_matches: r.ok && sha(Buffer.from(await r.arrayBuffer())) === im.sha256 });
  }
  const order = await get(`/api/orders/${s.orders[0]}`);
  const ob = order.ok ? await order.json() : null;
  out.api = { health: health.status, rule_worker: worker.status, rule_state: w?.state ?? null, processor_running: w?.processor_running ?? null,
    rule_jobs: w?.jobs ?? null, images,
    order: order.status, order_marker_once: ob ? (JSON.stringify(ob).split(s.marker).length - 1) === 1 : null, ms: Date.now() - t };
  if (existsSync(join(a.state, 'readback.private.json'))) {
    t = Date.now();
    const rb = JSON.parse(readFileSync(join(a.state, 'readback.private.json'), 'utf8'));
    const reads = [];
    for (const e of rb.entries) {
      const r = await fetch(base + e.path, { headers: { cookie: `${SESSION}=${rb.sessions[e.tenant_id]}` } });
      const text = await r.text();
      const same = r.status === e.status && r.ok && bodyDigest(text) === e.sha256;
      let differing_keys;
      if (!same && r.ok) {
        const x = JSON.parse(e.body), y = JSON.parse(text);
        differing_keys = [...new Set([...Object.keys(x), ...Object.keys(y)])].filter((k) => JSON.stringify(canon(x[k])) !== JSON.stringify(canon(y[k])));
      }
      reads.push({ tenant_id: e.tenant_id, kind: e.path.split('/')[2], status: r.status, same, ...(differing_keys ? { differing_keys } : {}) });
    }
    const by = (k) => reads.reduce((m, r) => ({ ...m, [r[k]]: (m[r[k]] ?? 0) + 1 }), {});
    out.readback = { reads: reads.length, same: reads.filter((r) => r.same).length, per_kind: by('kind'), per_tenant: by('tenant_id'),
      mismatches: reads.filter((r) => !r.same), ms: Date.now() - t };
  }
  out.ok = out.guards.all_true && out.extra_guards.all_true && (!out.readback || out.readback.same === out.readback.reads) && out.exactly_once && out.api.health === 200 && out.api.rule_worker === 200 && images.every((i) => i.sha256_matches) && out.api.order === 200;
  console.log(JSON.stringify(out));
  if (!out.ok) process.exitCode = 1;
}

try { if (mode === 'seed') await seed(); else if (mode === 'verify') await verify(); else throw new Error('mode: seed | verify'); }
catch (e) { console.error(`drill-app: ${e.message}`); process.exitCode = 1; }
