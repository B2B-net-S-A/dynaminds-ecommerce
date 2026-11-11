#!/usr/bin/env node
// Stage 5 load test orchestrator (host side). See tools/scale/load/README.md and
// docs/scale/MEASUREMENT-MANIFEST-20261025.md section 5.
//
//   node tools/scale/load/run.mjs --release <release-build.json> --db dynaminds_scale_YYYYMMDD_NN --tag <plan tag> \
//     --out <new run directory> [--phases steady12:12:1800,steady24:24:1800] [--warmup 600] [--workers 2]
//     [--rate-limit-per-min 60…100000]   (DYNA_RATE_LIMIT_PER_MIN of the release; unset = its default 600)
//     [--cold-attempts 3] [--hot-skus 4] [--dry-run]   (a plan off the profile timing needs --dry-run; README "Profile compliance")
//     [--woo <woo-store-bindings.private.json>]   (background lanes order_import / stock_sync on the official local
//     WooCommerce stores, tools/local/official-woo `bindings`; woo.mjs. Without it both lanes are recorded blocked.)
//
// Topology (all local Docker, nothing published): every process runs in the network namespace of the database
// container (dyna-scale-pg18), because the packaged release accepts only a loopback database session on the
// server's own port (manifest section 7 item 11) and its CLI listens on 127.0.0.1 only.
//   - setup        tools/scale/load/setup.mjs (release factory): owner sessions, one automation rule per tenant
//   - dyna-load-app       release CLI on 127.0.0.1:4101 with --scoped-automation (HTTP + in-process worker)
//   - dyna-load-worker-N  further release CLIs on 4102… with --scoped-automation (worker processes, no client traffic)
//   - dyna-load-<phase>-cNN  one container per client, source address 127.0.0.<11+N> (own rate-limit bucket)
//   - monitor (this process, via the published 127.0.0.1:$SCALE_PG_PORT, default 57090): queue depth, oldest pending job, automation
//     completion lag, pg_stat_activity samples, docker stats; host load average.
// Output in --out (0700): run.json (report), SUMMARY.md, samples/prep/monitor NDJSON, container logs.
// Secrets (database URL, session cookies) live in --out/private (0700) and are deleted at the end.
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync, appendFileSync, copyFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join, resolve, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadavg, cpus, totalmem } from 'node:os';
import { parseArgs } from 'node:util';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { aggregate, summarizeMonitor, renderMarkdown, hostPause, batteryRefusal, onBatteryPower, queueSample, queueDrained, lagDue, rateLimitOption, rateLimitRecord, monitorPort, replyHealthRecord,
  planCompliance, coldStartSummary, businessReady, backgroundReport, rng } from './lib.mjs';
import { WOO, loadBindings, assignStores, releaseCopies, maskArgs, processStartOrder, orderCapacity, wooProductBody, wooOrderBody, appSelection, wooLaneRows, wooRequest } from './woo.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const pg = createRequire(join(REPO, 'package.json'))('pg');
const NODE_IMAGE = process.env.SCALE_NODE_IMAGE ?? 'node:22.23.0-trixie-slim@sha256:cfd8f2a5bc50526aee08e88970979f92722828e7dcc6d8983607fb8bff4bdb82';
const PG = process.env.SCALE_PG_CONTAINER ?? 'dyna-scale-pg18';
const STATE = process.env.SCALE_PG_STATE ?? join(REPO, 'data/scale/pg18-docker');
const MONITOR_PORT = monitorPort(process.env);
const PORT = 4101;
const PROFILE = JSON.parse(readFileSync(join(REPO, 'docs/parity/acceptance-profile.v1.json'), 'utf8')).config, MIX = PROFILE.http.mix;
// Background lanes without --woo (profile background.lanes; never recorded as passed). Both need the official local
// WooCommerce of the profile (background.dependencies: official_local_woo_required_for_import_and_sync, >= 2 instances),
// tools/local/official-woo; there is no local Woo fake (docs/scale/LOAD-DRIVER-PROFILE-COMPLIANCE-20261029.md section 3).
const BACKGROUND_BLOCKED = Object.freeze({
  order_import: 'run without --woo: needs the official local WooCommerce stores (profile background.dependencies, tools/local/official-woo)',
  stock_sync: 'run without --woo: needs the official local WooCommerce stores (profile background.dependencies, tools/local/official-woo)',
});
const { values: a } = parseArgs({ options: { release: { type: 'string' }, db: { type: 'string' }, tag: { type: 'string' }, out: { type: 'string' },
  phases: { type: 'string', default: 'steady12:12:1800,steady24:24:1800' }, warmup: { type: 'string', default: '600' }, workers: { type: 'string', default: '2' },
  seed: { type: 'string', default: 'dyna-load-20261027' }, hold: { type: 'boolean', default: false }, 'drain-s': { type: 'string', default: '120' },
  'allow-battery': { type: 'boolean', default: false }, 'rate-limit-per-min': { type: 'string' },
  'cold-attempts': { type: 'string', default: String(PROFILE.timing.cold.attempts) }, 'hot-skus': { type: 'string', default: '4' }, 'dry-run': { type: 'boolean', default: false },
  woo: { type: 'string' } } });
for (const k of ['release', 'db', 'tag', 'out']) if (!a[k]) throw new Error(`--${k} required`);
if (!/^dynaminds_scale_\d{8}_\d{2}$/.test(a.db)) throw new Error('--db must be dynaminds_scale_YYYYMMDD_NN');
const phases = a.phases.split(',').map((p) => { const [id, clients, s] = p.split(':'); return { id, clients: Number(clients), duration_s: Number(s) }; });
for (const p of phases) if (!(/^[a-z0-9]{1,20}$/.test(p.id) && p.clients >= 1 && p.clients <= 24 && p.duration_s >= 10)) throw new Error('bad phase ' + JSON.stringify(p));
const warmup = Number(a.warmup), workers = Number(a.workers);
const rateLimit = rateLimitOption(a['rate-limit-per-min']); // null = the release default (nothing in app.env)
const coldAttempts = Number(a['cold-attempts']);
if (!(Number.isInteger(coldAttempts) && coldAttempts >= 1 && coldAttempts <= 5)) throw new Error('--cold-attempts: 1…5');
if (!/^(0|[1-9][0-9]?)$/.test(a['hot-skus'])) throw new Error('--hot-skus: 0…99');
// Profile timing (600 s warmup, 2 × 1800 s, 3 cold starts per process) unless --dry-run, before any side effect.
const compliance = planCompliance({ timing: PROFILE.timing, warmup, phases, coldAttempts, dryRun: a['dry-run'] });
const phaseIds = [...(warmup > 0 ? ['warmup'] : []), ...phases.map((p) => p.id)];
// Power gate before any side effect: on battery a closed lid sleeps the host (full run 28.10.2026, pmset -g log).
const pmset = process.platform === 'darwin' ? (spawnSync('pmset', ['-g', 'batt'], { encoding: 'utf8' }).stdout ?? '') : '';
const refusal = batteryRefusal({ platform: process.platform, pmset, plannedSeconds: warmup + phases.reduce((n, p) => n + p.duration_s, 0), allowBattery: a['allow-battery'] });
if (refusal) { console.error(refusal); process.exit(2); }
const rb =JSON.parse(readFileSync(a.release, 'utf8'));
const sha = (b) => createHash('sha256').update(b).digest('hex');
const log = (m) => console.error(`[${new Date().toISOString()}] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// One mount that holds the repository and the release (they share an ancestor: the workspace).
const commonAncestor = (x, y) => { const p = x.split(sep), q = y.split(sep); let i = 0; while (i < p.length && p[i] === q[i]) i++; return p.slice(0, i).join(sep); };
const WORKSPACE = commonAncestor(realpathSync(REPO), rb.release_directory);
const docker = (...args) => { const r = spawnSync('docker', args, { encoding: 'utf8', maxBuffer: 1 << 26 }); if (r.status !== 0) throw new Error(`docker ${args.slice(0, 3).join(' ')}: ${r.stderr.slice(-1500)}`); return r.stdout; };
const ids = `${process.getuid()}:${process.getgid()}`;
// With --woo the owned store root (producer key, CA key, passwords) is masked in every container (woo.mjs maskArgs);
// the release reads only its copies of the CA and the importer keys in --out/private.
const nodeArgs = (name, envFile, args) => ['run', '--rm', '--init', '--name', name, '--network', `container:${PG}`, '--user', ids, '-v', `${WORKSPACE}:${WORKSPACE}`, ...(woo?.root ? maskArgs(woo.root, WORKSPACE) : []), '-w', REPO,
  ...(envFile ? ['--env-file', envFile] : []), NODE_IMAGE, 'node', ...args];

// ---- run directory and private state ---------------------------------------------------------------------------
if (existsSync(a.out)) throw new Error(`${a.out} exists`);
mkdirSync(a.out, { recursive: true, mode: 0o700 }); chmodSync(a.out, 0o700);
const out = realpathSync(a.out), priv = join(out, 'private'), raw = join(out, 'raw');
for (const d of [priv, raw, join(priv, 'images')]) mkdirSync(d, { mode: 0o700 });
const runId = `L${Date.now().toString(36)}`;
const cfg = JSON.parse(readFileSync(join(STATE, 'local-config.json'), 'utf8'));
copyFileSync(join(STATE, 'local-config.json'), join(priv, 'local-config.json')); chmodSync(join(priv, 'local-config.json'), 0o600);
const dbUrl = `postgres://postgres:${encodeURIComponent(cfg.dbPassword)}@127.0.0.1:5432/${a.db}`;
const envFile = join(priv, 'app.env');
writeFileSync(envFile, [`DATABASE_URL=${dbUrl}`, `DYNA_LOCAL_CONFIG_PATH=${join(priv, 'local-config.json')}`, `DYNA_IMAGE_DIR=${join(priv, 'images')}`,
  'DYNA_TEST=true', 'DYNA_WORKER_DISABLED=true', 'TZ=UTC', ...(rateLimit === null ? [] : [`DYNA_RATE_LIMIT_PER_MIN=${rateLimit}`]), ''].join('\n'), { mode: 0o600 });
const selection = join(priv, 'selection.json');
writeFileSync(selection, JSON.stringify({ releaseDirectory: rb.release_directory, manifestSha: rb.release_manifest_sha256, expectedOwner: 'postgres', databaseUrl: dbUrl,
  localConfigurationPath: join(priv, 'local-config.json'), revision: rb.release_manifest_sha256 }), { mode: 0o600 });
const sessionsFile = join(priv, 'sessions.json');
const report = { schema: 'dyna-load-test/v1', run_id: runId, database: a.db, release: { commit: rb.commit, release_manifest_sha256: rb.release_manifest_sha256, package_tree_sha256: rb.package_tree_sha256 },
  phases_planned: phases, warmup_s: warmup, worker_processes: workers, started_at: new Date().toISOString(), profile_compliance: compliance,
  cold_start: { required: PROFILE.timing.cold.attempts, attempts_per_process: coldAttempts, limit_ms: PROFILE.timing.cold.start_to_authenticated_business_and_worker_ready_ms_max, processes: {}, all_within: false },
  host: { cpus: cpus().length, cpu: cpus()[0]?.model, memory_bytes: totalmem(), loadavg_start: loadavg(),
    power: onBatteryPower(pmset) === null ? 'unknown' : onBatteryPower(pmset) ? 'battery' : 'ac', allow_battery: a['allow-battery'] }, host_pauses: [], topology: null, steps: {} };
const saveReport = () => writeFileSync(join(out, 'run.json'), JSON.stringify(report, null, 1) + '\n', { mode: 0o600 });
// Clock-gap monitor: one sample per second; a gap over 5 s is a host_pause (host sleep or stalled orchestrator).
// Saved to run.json (host_pauses) and raw/monitor.ndjson; the report marks every phase it overlaps NIEWAŻNA.
let clock = { wall: Date.now(), mono: performance.now() };
function sampleClock() {
  const cur = { wall: Date.now(), mono: performance.now() }, p = hostPause(clock, cur); clock = cur;
  if (!p) return;
  report.host_pauses.push(p); appendFileSync(join(raw, 'monitor.ndjson'), JSON.stringify(p) + '\n'); saveReport();
  log(`host pause (${p.cause}): wall ${p.wall_gap_ms} ms, monotonic ${p.mono_gap_ms} ms — overlapping phases are NIEWAŻNA`);
}
const clockTimer = setInterval(sampleClock, 1000); clockTimer.unref();

// ---- long-running release CLIs ------------------------------------------------------------------------------------
const services = [];
function service(name, port) {
  const sel = readFileSync(selection);
  const wooArgs = woo && name === 'dyna-load-app' ? ['--local-woo-stores', woo.selection, sha(readFileSync(woo.selection)), '--local-woo-reads', '--local-woo-stock'] : [];
  const child = spawn('docker', nodeArgs(name, envFile, [join(rb.release_directory, 'runtime/server/ordinary-local-cli.mjs'), selection, sha(sel), String(port), '--scoped-automation', ...wooArgs]), { stdio: ['ignore', 'pipe', 'pipe'] });
  let buf = ''; const logFile = join(raw, `${name}.log`);
  const started = new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`${name} not listening in 15 min`)), 15 * 60 * 1000);
    const on = (b) => { appendFileSync(logFile, b); buf += b; if (buf.includes('ORDINARY_LOCAL_APP_LISTENING')) { clearTimeout(t); res(); } };
    child.stdout.on('data', on); child.stderr.on('data', on);
    child.on('exit', (code) => { clearTimeout(t); rej(new Error(`${name} exited ${code}: ${buf.slice(-1500)}`)); });
  });
  started.catch(() => {}); // awaited by the caller; a start failure must not become an unhandled rejection
  const s = { name, port, child, started, exited: new Promise((r) => child.on('exit', r)) }; services.push(s); return s;
}
function healthOf(s) {
  const h = spawnSync('docker', nodeArgs(`dyna-load-health-${s.port}`, null, ['-e',
    `fetch('http://127.0.0.1:${s.port}/api/health').then(async r=>{if(!r.ok)throw new Error('HTTP '+r.status);process.stdout.write(await r.text())})`]), { encoding: 'utf8' });
  if (h.status !== 0) throw new Error(`${s.name} /api/health: ${h.stderr.slice(-500)}`);
  return JSON.parse(h.stdout);
}
// Business readiness of a fresh CLI (probe.mjs): health with scoped automation, an authenticated read per tenant.
function probeOf(s) {
  const h = spawnSync('docker', nodeArgs(`dyna-load-probe-${s.port}`, null, ['tools/scale/load/probe.mjs', sessionsFile, String(s.port)]), { encoding: 'utf8' });
  try { return JSON.parse(h.stdout.trim().split('\n').pop()); } catch { return { error: `probe exit ${h.status}: ${h.stderr.slice(-300)}` }; }
}
// One cold-start attempt ends: the CLI stops and its container is gone before the next fresh one starts.
async function stopService(s) {
  spawnSync('docker', ['stop', '-t', '60', s.name]); await Promise.race([s.exited, sleep(70000)]);
  for (let i = 0; i < 60 && spawnSync('docker', ['inspect', s.name]).status === 0; i++) await sleep(500);
  services.splice(services.indexOf(s), 1);
}
async function stopAll() {
  for (const s of services) spawnSync('docker', ['stop', '-t', '60', s.name]);
  await Promise.all(services.map((s) => Promise.race([s.exited, sleep(70000)])));
}

// ---- monitor ------------------------------------------------------------------------------------------------------
const monitorRows = [];
const monitorFile = join(raw, 'monitor.ndjson');
const record = (row) => { monitorRows.push(row); appendFileSync(monitorFile, JSON.stringify(row) + '\n'); };
let monitoring = false, draining = false;
async function monitor(rules, since, stockScope) {
  // A dropped connection (dry run -64: the database container hit its memory limit and restarted its server) is
  // recorded and reconnected; without an 'error' listener pg throws it at the process and the run dies mid-phase.
  let lost = false;
  const connect = async () => {
    const x = new pg.Client({ connectionString: `postgres://postgres:${encodeURIComponent(readFileSync(join(STATE, 'secrets/postgres.password'), 'utf8').trim())}@127.0.0.1:${MONITOR_PORT}/${a.db}`,
      application_name: 'dyna-load-monitor' });
    x.on('error', (e) => { lost = true; record({ kind: 'monitor_error', at: Date.now(), error: 'monitor connection: ' + e.message }); });
    await x.connect(); return x;
  };
  let c = await connect(); monitoring = true;
  let lastLag = since, tick = 0, statsBusy = false;
  while (monitoring) {
    const at = Date.now();
    try {
      const act = (await c.query(`SELECT state, coalesce(wait_event_type,'CPU') wt, coalesce(wait_event,'') we,
          left(regexp_replace(query,'\\s+',' ','g'),140) q FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type='client backend'`)).rows;
      const active = act.filter((x) => x.state === 'active'), waits = {}, queries = {};
      for (const x of active) { waits[`${x.wt}:${x.we}`] = (waits[`${x.wt}:${x.we}`] ?? 0) + 1; queries[x.q] = (queries[x.q] ?? 0) + 1; }
      record({ kind: 'activity', at, connections: act.length, active: active.length, idle_in_tx: act.filter((x) => x.state?.startsWith('idle in transaction')).length, waits, queries });
      // Advisory locks with waiters: 64-bit key = classid (high 32 bits) · objid (low 32 bits); named after the run.
      const adv = (await c.query(`SELECT classid::bigint c, objid::bigint o, count(*) FILTER (WHERE NOT granted)::int waiting FROM pg_locks
          WHERE locktype='advisory' AND database=(SELECT oid FROM pg_database WHERE datname=current_database()) GROUP BY 1,2 HAVING count(*) FILTER (WHERE NOT granted)>0`)).rows;
      if (adv.length) record({ kind: 'advisory', at, keys: adv.map((x) => ({ key: `${x.c}:${x.o}`, waiting: x.waiting })) });
      if (tick % 2 === 0) {
        // Pending only each second (index-supported); the full count (a scan of jobs) every 30 s and while draining.
        const qs = queueSample(tick / 2, draining), q = (await c.query(qs.sql, [since])).rows[0];
        record({ kind: 'queue', at, full: qs.full, ...q, load1: loadavg()[0] });
        // Completion lag (a scan of automation_runs) every 30 s, every second while draining or held (lib.mjs lagDue).
        if (lagDue(tick / 2, draining || Boolean(a.hold))) {
          const lags = (await c.query(`SELECT (extract(epoch FROM r.finished_at-o.created_at)*1000)::float8 ms, r.finished_at f, r.rule_id::text rid FROM automation_runs r
            JOIN orders o ON (o.tenant_id,o.id)=(r.tenant_id,r.order_id) WHERE r.rule_id=ANY($1::uuid[]) AND r.finished_at > $2 ORDER BY r.finished_at`, [rules, new Date(lastLag)])).rows;
          if (lags.length) { lastLag = lags[lags.length - 1].f.getTime(); record({ kind: 'lag', at, lags_ms: lags.map((x) => x.ms), finished_ms: lags.map((x) => x.f.getTime()), rule_ids: lags.map((x) => x.rid) }); }
        }
      }
      // Woo lanes every 10 s: import receipts done and verified Woo stock writes of the run's channels (woo.mjs).
      if (woo?.channels && tick % 20 === 10) {
        const ch = Object.keys(woo.channels);
        const imp = (await c.query(`SELECT channel_id::text ch, (extract(epoch FROM completed_at)*1000)::float8 ms FROM local_woo_order_import_receipts
            WHERE channel_id = ANY($1::uuid[]) AND state = 'done' AND completed_at > to_timestamp($2::float8/1000) ORDER BY completed_at`, [ch, woo.cursor.order_import])).rows;
        const st = (await c.query(`SELECT channel_id::text ch, (extract(epoch FROM completed_at)*1000)::float8 ms FROM offer_plans WHERE tenant_id = ANY($3::uuid[]) AND channel_id = ANY($1::uuid[]) AND operation = 'sync'
            AND state = 'done' AND result->>'scope' = 'external_api_verified' AND result->>'desired_applied' = 'true' AND completed_at > to_timestamp($2::float8/1000) ORDER BY completed_at`, [ch, woo.cursor.stock_sync, tenantIds])).rows;
        for (const [lane, xs] of [['order_import', imp], ['stock_sync', st]]) {
          if (xs.length) woo.cursor[lane] = xs[xs.length - 1].ms;
          for (const row of wooLaneRows(lane, xs, woo.channels, at)) record(row);
        }
      }
      // Saleable stock on MAIN per tenant every ~15 s: a run whose dataset runs out stops sending writes (l250-head-01).
      if (tick % 30 === 15) {
        const st = (await c.query(`SELECT s.tenant_id::text t, sum(s.available)::bigint av, count(*) FILTER (WHERE s.available>=8)::int ge8 FROM stock s
            JOIN unnest($1::uuid[], $2::uuid[]) x(t, w) ON (s.tenant_id, s.warehouse_id)=(x.t, x.w) GROUP BY 1`, [stockScope.map((x) => x.tenant_id), stockScope.map((x) => x.main)])).rows;
        const slot = new Map(stockScope.map((x) => [x.tenant_id, x.slot]));
        record({ kind: 'stock', at, tenants: Object.fromEntries(st.map((x) => [slot.get(x.t), { available: Number(x.av), products_ge8: x.ge8 }])) });
      }
      if (tick % 30 === 0 && !statsBusy) {
        statsBusy = true;
        const p = spawn('docker', ['stats', '--no-stream', '--format', '{{json .}}', PG, ...services.map((s) => s.name), ...activeClients]); let s = '';
        p.stdout.on('data', (b) => { s += b; }); p.on('exit', () => { statsBusy = false; record({ kind: 'docker_stats', at, rows: s.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) }); });
      }
    } catch (e) {
      record({ kind: 'monitor_error', at, error: e.message });
      if (lost) { try { await c.end().catch(() => {}); c = await connect(); lost = false; record({ kind: 'monitor_reconnect', at: Date.now() }); } catch { await sleep(2000); } }
    }
    tick++;
    await sleep(Math.max(0, 500 - (Date.now() - at)));
  }
  // Name the observed advisory keys: hashtextextended(<prefix><tenant>, 0) for the key prefixes used in server/*.ts.
  const seen = [...new Set(monitorRows.filter((x) => x.kind === 'advisory').flatMap((x) => x.keys.map((k) => k.key)))];
  if (seen.length) {
    const names = (await c.query(`SELECT p||t AS name, ((h>>32)&4294967295)::text||':'||(h&4294967295)::text AS key FROM unnest($1::text[]) p, unnest($2::text[]) t, LATERAL (SELECT hashtextextended(p||t,0) h) x`,
      [ADVISORY_PREFIXES, tenantIds])).rows;
    const byKey = new Map(names.map((n) => [n.key, n.name.replace(/[0-9a-f-]{36}$/, '<tenant>')]));
    record({ kind: 'advisory_names', at: Date.now(), names: Object.fromEntries(seen.map((k) => [k, byKey.get(k) ?? 'unknown'])) });
  }
  await c.end();
}
const ADVISORY_PREFIXES = ['catalog:', 'rules:', 'order-fields:', 'wms.policy:', 'wms.operations:', 'stock-location:', 'order:', 'invoice:', 'tenant:', 'automation.queue:', 'returns:', 'return.local:', 'wms:', 'order-status-config:'];
let tenantIds = [], activeClients = [];

// ---- clients ------------------------------------------------------------------------------------------------------
async function runPhase(ph) {
  const startAt = Date.now() + 8000, runs = [];
  activeClients = Array.from({ length: ph.clients }, (_, i) => `dyna-load-${ph.id}-c${String(i).padStart(2, '0')}`);
  for (let i = 0; i < ph.clients; i++) {
    const name = activeClients[i], file = join(priv, `${name}.json`);
    writeFileSync(file, JSON.stringify({ run_id: runId, phase: ph.id, client: i, clients: ph.clients, start_at: startAt, duration_s: ph.duration_s, origin: `http://127.0.0.1:${PORT}`,
      run_started_at: report.started_at,
      local_address: `127.0.0.${11 + i}`, sessions: sessionsFile, out_dir: raw, seed: a.seed, profile: join(REPO, 'docs/parity/acceptance-profile.v1.json') }), { mode: 0o600 });
    const child = spawn('docker', nodeArgs(name, null, ['tools/scale/load/client.mjs', file]), { stdio: ['ignore', 'pipe', 'pipe'] });
    let o = ''; child.stdout.on('data', (b) => { o += b; }); child.stderr.on('data', (b) => { o += b; });
    runs.push(new Promise((r) => child.on('exit', (code) => { writeFileSync(join(raw, `${name}.log`), o); r({ name, code }); })));
  }
  const ends = await Promise.all(runs);
  activeClients = [];
  return { start_ms: startAt, end_ms: startAt + ph.duration_s * 1000, exits: ends };
}
const readNdjson = (suffix) => readdirSync(raw).filter((f) => f.endsWith(suffix)).flatMap((f) => readFileSync(join(raw, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));

// ---- Woo source orders (driver side, producer key): one per store every WOO.order_every_ms ------------------------
const wooFile = join(raw, 'woo-producer.ndjson');
function startProducer() {
  woo.producing = true; woo.inflight = new Set();
  for (const { tenant, store } of woo.assigned) {
    const products = woo.products[tenant], r = rng(`${a.seed}-${runId}-woo-${tenant}`);
    (async () => {
      let n = 0, next = Date.now();
      while (woo.producing) {
        const k = ++n, sent = Date.now(), body = wooOrderBody({ run: runId, tenant, n: k, products, r });
        const p = wooRequest(store, 'POST', '/wp-json/wc/v3/orders', body).then((x) => ({ status: x.status, ms: x.ms, woo_order_id: x.json?.id ?? null, woo_status: x.json?.status ?? null }), (e) => ({ status: 0, error: String(e.message).slice(0, 200) }))
          .then((x) => appendFileSync(wooFile, JSON.stringify({ kind: 'woo_order', tenant, n: k, at: sent, lines: body.line_items.length, ...x }) + '\n'));
        woo.inflight.add(p); p.finally(() => woo.inflight.delete(p));
        next += WOO.order_every_ms; await sleep(Math.max(0, next - Date.now()));
      }
    })();
  }
}
async function stopProducer() { if (!woo?.producing) return; woo.producing = false; await Promise.allSettled([...woo.inflight]); }
async function wooLanes(mode) {
  const file = join(priv, `woo-lanes-${mode}.json`), t = Date.now();
  const child = spawn('docker', nodeArgs(`dyna-load-woo-${mode}`, null, ['tools/scale/load/woo-lanes.mjs', mode, woo.plan, sessionsFile, String(PORT), file]), { stdio: ['ignore', 'pipe', 'pipe'] });
  let o = ''; child.stdout.on('data', (b) => { o += b; }); child.stderr.on('data', (b) => { o += b; });
  const code = await new Promise((r) => child.on('exit', r)); writeFileSync(join(raw, `woo-lanes-${mode}.log`), o.slice(-20000));
  const res = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { status: 'FAILED', error: `woo-lanes exit ${code}: ${o.slice(-500)}` };
  report.woo[`lanes_${mode}`] = { ...res, ms: Date.now() - t }; saveReport();
  if (res.status !== 'OK') throw new Error(`woo lanes ${mode}: ${res.error}`);
  if (mode === 'start') writeFileSync(woo.plan, JSON.stringify({ ...JSON.parse(readFileSync(woo.plan, 'utf8')), started_file: file }), { mode: 0o600 });
}

let failed = null, sessions = null, woo = null;
try {
  if (a.woo) {
    // Stores before any effect: pinned bindings, >= profile minimum, read ceiling not crossed by this run.
    const b = await loadBindings(resolve(a.woo));
    if (!b.root || realpathSync(b.root) !== b.root || !b.stores.every((s) => [s.ca, s.importer, s.producer].every((p) => p.path.startsWith(b.root + sep)))) throw new Error('Woo bindings: every pinned file inside the bindings root');
    const assigned = assignStores(b.stores, PROFILE.background.dependencies.local_official_woo_instances_min).map(({ tenant, store }) => ({ tenant, store: b.stores.find((x) => x.slot === store.slot) }));
    const seconds = warmup + phases.reduce((n, p) => n + p.duration_s, 0) + 300, capacity = {};
    for (const { tenant, store } of assigned) {
      const x = await wooRequest(store, 'GET', '/wp-json/wc/v3/orders?per_page=1');
      if (x.status !== 200 || !Number.isInteger(x.total)) throw new Error(`Woo store ${store.slot}: orders read HTTP ${x.status}`);
      capacity[tenant] = orderCapacity({ total: x.total, seconds });
      if (!capacity[tenant].ok) throw new Error(`Woo store ${store.slot}: ${x.total} orders + ${capacity[tenant].planned} planned would cross the ${WOO.read_ceiling}-order read ceiling; use a fresh store root`);
    }
    woo = { assigned, capacity, bindings_sha256: b.sha256, root: b.root };
    report.woo = { bindings_sha256: b.sha256, stores: b.public.stores, tenants: assigned.map((x) => x.tenant), capacity, settings: WOO };
    saveReport();
  }
  log(`run ${runId}: setup (release factory) + ${workers} release CLIs, workspace mount ${WORKSPACE}`);
  // One factory at a time: started together, the release CLIs fail their start (ORDINARY_LOCAL_START_FAILED,
  // dry run 27.10.2026); one after another each passes. Setup → app → further worker processes.
  const t0 = Date.now();
  const st = spawnSync('docker', nodeArgs('dyna-load-setup', envFile, ['tools/scale/load/setup.mjs', '--release', a.release, '--tag', a.tag, '--out', sessionsFile, '--run', runId, '--phases', phaseIds.join(','), '--hot', a['hot-skus'], '--woo-products', woo ? String(WOO.products) : '0']), { encoding: 'utf8', maxBuffer: 1 << 26 });
  writeFileSync(join(raw, 'setup.log'), st.stdout + st.stderr);
  if (st.status !== 0) throw new Error('setup failed: ' + (st.stderr || st.stdout).slice(-2000));
  report.steps.setup = { ...JSON.parse(st.stdout.trim().split('\n').pop()), ms: Date.now() - t0 };
  sessions = JSON.parse(readFileSync(sessionsFile, 'utf8'));
  // Frozen before any request is dispatched (profile binding_and_evidence: hot-SKU set in the run manifest).
  report.hot_skus = Object.fromEntries(sessions.tenants.map((t) => [t.slot, t.hot ?? []]));
  report.contention_plan = Object.fromEntries(phaseIds.map((id) => [id, Object.fromEntries(sessions.tenants.filter((t) => t.contention?.[id]).map((t) => [t.slot, t.contention[id]]))]));
  saveReport();
  if (woo) {
    // This run's Woo products (one per mapped DYNAMINDS product, stock = available on MAIN), channel and fixture ids.
    const t3 = Date.now(), ids = {}, plan = [];
    woo.products = {}; woo.channels = {}; woo.cursor = { order_import: 0, stock_sync: 0 };
    await Promise.all(woo.assigned.map(async ({ tenant, store }) => {
      const t = sessions.tenants.find((x) => x.slot === tenant), made = [];
      for (const [i, p] of t.woo_products.entries()) {
        // A product with this SKU from an earlier run of the same store is reused and reset to this run's stock.
        const body = wooProductBody(runId, tenant, p, i), found = await wooRequest(store, 'GET', `/wp-json/wc/v3/products?sku=${encodeURIComponent(p.sku)}`);
        if (found.status !== 200 || !Array.isArray(found.json) || found.json.length > 1) throw new Error(`Woo store ${store.slot}: product lookup HTTP ${found.status}`);
        const x = found.json.length ? await wooRequest(store, 'PUT', `/wp-json/wc/v3/products/${found.json[0].id}`, body) : await wooRequest(store, 'POST', '/wp-json/wc/v3/products', body);
        if (![200, 201].includes(x.status) || !Number.isInteger(x.json?.id) || x.json.sku !== p.sku || x.json.stock_quantity !== p.available) throw new Error(`Woo store ${store.slot}: product ${found.json.length ? 'update' : 'create'} HTTP ${x.status}`);
        made.push({ woo_id: x.json.id, product_id: p.id, sku: p.sku, stock: p.available });
      }
      woo.products[tenant] = made;
    }));
    for (const { tenant } of woo.assigned) {
      ids[tenant] = { channel_id: randomUUID(), fixture_id: randomUUID() }; woo.channels[ids[tenant].channel_id] = tenant;
      plan.push({ slot: tenant, channel_id: ids[tenant].channel_id, name: `Woo ${runId} ${tenant}`, mappings: woo.products[tenant].map((x) => ({ external_id: String(x.woo_id), sku: x.sku })) });
    }
    woo.selection = join(priv, 'woo-stores.json'); woo.plan = join(priv, 'woo-plan.json');
    writeFileSync(woo.selection, JSON.stringify(appSelection(await releaseCopies(woo.assigned, priv), sessions.tenants, ids)), { mode: 0o600 });
    writeFileSync(woo.plan, JSON.stringify({ tenants: plan }), { mode: 0o600 });
    report.woo.channels = Object.fromEntries(Object.entries(ids).map(([k, v]) => [k, v.channel_id]));
    report.woo.products = Object.fromEntries(Object.entries(woo.products).map(([k, v]) => [k, v]));
    report.steps.woo_products = { ms: Date.now() - t3, per_tenant: WOO.products }; saveReport();
  }
  // Cold start (profile timing.cold): per process `coldAttempts` sequential fresh containers, each timed from docker run
  // to business readiness (probe.mjs); every attempt but the last stops again, the last one serves the run.
  const svcs = [];
  for (const i of processStartOrder(workers, Boolean(woo))) {
    const name = i === 0 ? 'dyna-load-app' : `dyna-load-worker-${i + 1}`, attempts = [];
    for (let k = 1; k <= coldAttempts; k++) {
      appendFileSync(join(raw, `${name}.log`), `--- cold start attempt ${k} ${new Date().toISOString()}\n`);
      const t1 = Date.now(), s = service(name, PORT + i);
      await s.started; const listening = Date.now() - t1, probe = probeOf(s), ready = Date.now() - t1;
      attempts.push({ attempt: k, listening_ms: listening, business_ready_ms: ready, ok: businessReady(probe), probe, loadavg: loadavg() });
      report.cold_start.processes[name] = coldStartSummary(attempts, { required: report.cold_start.required, maxMs: report.cold_start.limit_ms }); saveReport();
      if (!businessReady(probe)) throw new Error(`${name} attempt ${k}: not business-ready ${JSON.stringify(probe)}`);
      if (k < coldAttempts) await stopService(s); else { svcs.push(s); report.steps[`${name}_ready_ms`] = listening; }
    }
  }
  svcs.sort((x, y) => x.port - y.port); // app (4101) first for health, rate limit and Woo
  report.cold_start.all_within = Object.values(report.cold_start.processes).every((x) => x.all_within);
  report.steps.services_ready_ms = Date.now() - t0;
  // Effective per-address limit as every release CLI reports it (/api/health rate_limit). A mismatch with
  // --rate-limit-per-min, or a requested value on a release without the field, refuses before any phase.
  const reported = svcs.map((s) => healthOf(s).rate_limit);
  for (const r of reported.slice(1)) rateLimitRecord(rateLimit, r);
  report.rate_limit = rateLimitRecord(rateLimit, reported[0]);
  report.topology = { network: `container:${PG} (shared namespace)`, app: `127.0.0.1:${PORT}`, worker_processes: svcs.map((s) => ({ name: s.name, port: s.port, scoped_automation: true })),
    client_addresses: '127.0.0.11 … 127.0.0.34, one container per client', rules: sessions.tenants.map((t) => ({ slot: t.slot, rule_id: t.rule_id })) };
  saveReport();
  if (woo) {
    const h = healthOf(svcs[0]);
    report.woo.health = Object.fromEntries(Object.entries(h).filter(([k]) => k.startsWith('local_woo')));
    if (h.local_woo_read_processor_running !== true || h.local_woo_stock_processor_running !== true || h.local_woo_stock_blocked_channels !== 0) throw new Error('Woo lanes not ready before setup: ' + JSON.stringify(report.woo.health));
    await wooLanes('start');
    const after = healthOf(svcs[0]); report.woo.health_after_setup = Object.fromEntries(Object.entries(after).filter(([k]) => k.startsWith('local_woo')));
    if (after.local_woo_stock_blocked_channels !== 0) throw new Error('Woo stock lane parked a channel during setup: ' + JSON.stringify(report.woo.health_after_setup));
  }
  const since = Date.now();
  tenantIds = sessions.tenants.map((t) => t.tenant_id);
  const mon = monitor(sessions.tenants.map((t) => t.rule_id), since, sessions.tenants.map(({ slot, tenant_id, main }) => ({ slot, tenant_id, main })));
  const all = [...(warmup > 0 ? [{ id: 'warmup', clients: phases[0].clients, duration_s: warmup }] : []), ...phases];
  report.phases = [];
  if (woo) startProducer();
  for (const ph of all) {
    log(`phase ${ph.id}: ${ph.clients} clients × ${ph.duration_s} s`);
    const r = await runPhase(ph);
    report.phases.push({ ...ph, ...r }); saveReport();
    const bad = r.exits.filter((x) => x.code !== 0);
    if (bad.length) throw new Error(`${bad.length} clients exited non-zero in ${ph.id}: ${bad.map((b) => b.name).join(',')}`);
  }
  // --hold (driver development): keep the release running; `<out>/next-phase` = "id:clients:seconds" runs one more
  // phase and writes <out>/hold-<id>.md; `<out>/stop` ends the run (drain, report, cleanup as usual).
  while (a.hold && !existsSync(join(out, 'stop'))) {
    const f = join(out, 'next-phase');
    if (!existsSync(f)) { await sleep(1000); continue; }
    const [id, clients, s] = readFileSync(f, 'utf8').trim().split(':'); rmSync(f);
    const ph = { id, clients: Number(clients), duration_s: Number(s) }, r = await runPhase(ph);
    report.phases.push({ ...ph, ...r }); saveReport();
    const one = [{ id, clients: ph.clients, start_ms: r.start_ms, end_ms: r.end_ms }];
    const res = aggregate({ samples: readNdjson('.samples.ndjson'), prep: readNdjson('.prep.ndjson'), loops: readNdjson('.loop.ndjson'), mix: MIX, phases: one, monitor: summarizeMonitor(monitorRows, one), hostPauses: report.host_pauses, contentionPlan: report.contention_plan });
    writeFileSync(join(out, `hold-${id}.md`), renderMarkdown({ ...report, result: res }) + '\nexits: ' + JSON.stringify(r.exits) + '\n');
  }
  if (woo) {
    await stopProducer();
    const h = healthOf(svcs[0]); report.woo.health_before_stop = Object.fromEntries(Object.entries(h).filter(([k]) => k.startsWith('local_woo')));
    await wooLanes('stop');
  }
  log('drain: waiting for pending jobs of this run');
  const drainStart = Date.now(); let drained = false; draining = true;
  while (Date.now() - drainStart < Number(a['drain-s']) * 1000) {
    if (queueDrained(monitorRows, drainStart)) { drained = true; break; }
    await sleep(1000);
  }
  report.steps.drain = { drained, ms: Date.now() - drainStart };
  monitoring = false; await mon;
} catch (e) { failed = e; report.error = String(e.stack ?? e).slice(0, 4000); log('FAILED ' + e.message); }
finally {
  monitoring = false;
  await stopProducer();
  // Reply warnings and late hook failures of every CLI before it stops (also after a failure: a dead CLI is recorded).
  report.reply_health = replyHealthRecord(services.map((s) => { try { return { name: s.name, health: healthOf(s) }; } catch (e) { return { name: s.name, error: String(e.message).slice(0, 300) }; } }));
  await stopAll();
  for (const n of docker('ps', '-a', '--format', '{{.Names}}').split('\n').filter((x) => x.startsWith('dyna-load-'))) spawnSync('docker', ['rm', '-f', n]);
}
// Woo side after the run (release stopped): lane rows per channel in the database, the producer's orders, and the
// stock readback of every mapped product (Woo stock_quantity vs DYNAMINDS on_hand − reserved on MAIN).
if (woo?.channels) {
  try { report.woo.summary = await wooSummary(); } catch (e) { report.woo.summary = { error: String(e.message).slice(0, 500) }; }
  saveReport();
}
async function wooSummary() {
  const c = new pg.Client({ connectionString: `postgres://postgres:${encodeURIComponent(readFileSync(join(STATE, 'secrets/postgres.password'), 'utf8').trim())}@127.0.0.1:${MONITOR_PORT}/${a.db}`, application_name: 'dyna-load-woo-summary' });
  c.on('error', () => {}); // a lost connection surfaces as the failed query below, recorded in report.woo.summary
  await c.connect();
  try {
    const ch = Object.keys(woo.channels), slot = (x) => woo.channels[x.ch];
    const group = (rows) => { const o = {}; for (const x of rows) { const s = slot(x); o[s] ??= {}; o[s][x.k] = x.n; } return o; };
    const receipts = group((await c.query(`SELECT channel_id::text ch, state k, count(*)::int n FROM local_woo_order_import_receipts WHERE channel_id = ANY($1::uuid[]) GROUP BY 1, 2`, [ch])).rows);
    const plans = group((await c.query(`SELECT channel_id::text ch, state || ':' || coalesce(result->>'scope', '-') || ':' || coalesce(result->>'desired_applied', '-') k, count(*)::int n FROM offer_plans WHERE tenant_id = ANY($2::uuid[]) AND channel_id = ANY($1::uuid[]) GROUP BY 1, 2`, [ch, tenantIds])).rows);
    const jobs = group((await c.query(`SELECT payload->>'channel_id' ch, kind || ':' || state k, count(*)::int n FROM jobs WHERE tenant_id = ANY($2::uuid[]) AND payload->>'channel_id' = ANY($1::text[]) GROUP BY 1, 2`, [ch, tenantIds])).rows);
    const inbound = group((await c.query(`SELECT channel_id::text ch, 'inbound' k, count(*)::int n FROM inbound_orders WHERE channel_id = ANY($1::uuid[]) GROUP BY 1`, [ch])).rows);
    const producer = {};
    for (const x of existsSync(wooFile) ? readFileSync(wooFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []) {
      const p = (producer[x.tenant] ??= { sent: 0, created: 0, failed: 0, max_ms: 0 }); p.sent++; if (x.status === 201) p.created++; else p.failed++; p.max_ms = Math.max(p.max_ms, x.ms ?? 0);
    }
    const readback = {};
    for (const { tenant, store } of woo.assigned) {
      const main = sessions.tenants.find((t) => t.slot === tenant).main, products = woo.products[tenant];
      const local = new Map((await c.query('SELECT product_id::text id, (on_hand - reserved)::int q FROM stock WHERE warehouse_id = $1 AND product_id = ANY($2::uuid[])', [main, products.map((x) => x.product_id)])).rows.map((x) => [x.id, x.q]));
      let equal = 0; const differ = [];
      for (const p of products) { const x = await wooRequest(store, 'GET', `/wp-json/wc/v3/products/${p.woo_id}`); const q = x.json?.stock_quantity; if (q === local.get(p.product_id)) equal++; else differ.push({ woo_id: p.woo_id, woo: q ?? null, dynaminds: local.get(p.product_id) ?? null }); }
      const total = await wooRequest(store, 'GET', '/wp-json/wc/v3/orders?per_page=1');
      readback[tenant] = { products: products.length, equal, differ, store_orders_total: total.total };
    }
    return { receipts, offer_plans: plans, jobs, inbound, producer, readback };
  } finally { await c.end(); }
}
// Correctness reconciliation (reconcile.mjs) once every release CLI has stopped: ledger, reservations, invoices,
// payments, jobs, orphans, guards; raw/reconciliation.json, PASS/FAIL in run.json and SUMMARY.md.
if (tenantIds.length === 5) {
  log('reconciliation');
  const t2 = Date.now(), rc = spawnSync(process.execPath, [join(REPO, 'tools/scale/load/reconcile.mjs'), '--db', a.db, '--tenants', tenantIds.join(','), '--since', report.started_at,
    '--out', join(raw, 'reconciliation.json')], { encoding: 'utf8', env: process.env, maxBuffer: 1 << 24 });
  let line = null; try { line = JSON.parse(rc.stdout.trim().split('\n').pop()); } catch { /* reported below */ }
  report.reconciliation = line ? { ...line, file: 'raw/reconciliation.json', ms: Date.now() - t2 } : { status: 'FAIL', error: `reconcile exit ${rc.status}: ${(rc.stderr || rc.stdout).slice(-500)}`, ms: Date.now() - t2 };
} else report.reconciliation = { status: 'not_run', error: 'setup did not finish' };
sampleClock(); clearInterval(clockTimer);
const measuredPhases = (report.phases ?? []).map((p) => ({ id: p.id, clients: p.clients, start_ms: p.start_ms, end_ms: p.end_ms }));
const samples = readNdjson('.samples.ndjson'), prep = readNdjson('.prep.ndjson');
report.result = aggregate({ samples, prep, loops: readNdjson('.loop.ndjson'), mix: MIX, phases: measuredPhases, monitor: summarizeMonitor(monitorRows, measuredPhases), hostPauses: report.host_pauses,
  contentionPlan: report.contention_plan ?? null });
report.background = backgroundReport({ lanes: PROFILE.background.lanes, rows: monitorRows, phases: measuredPhases,
  ruleSlots: Object.fromEntries((sessions?.tenants ?? []).map((t) => [t.rule_id, t.slot])), blocked: woo ? {} : BACKGROUND_BLOCKED, woo: woo ? { tenants: woo.assigned.map((x) => x.tenant) } : null });
report.finished_at = new Date().toISOString(); report.host.loadavg_end = loadavg();
saveReport();
writeFileSync(join(out, 'SUMMARY.md'), renderMarkdown(report), { mode: 0o600 });
rmSync(priv, { recursive: true, force: true }); // database URL, session cookies, local config copy
log(`report ${join(out, 'run.json')}, summary ${join(out, 'SUMMARY.md')}`);
if (failed || report.reconciliation.status !== 'PASS') process.exitCode = 1;
