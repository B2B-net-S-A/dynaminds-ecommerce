#!/usr/bin/env node
// Recovery drill on the full stage 5 dataset (goal condition 11): database, files, keys, configuration,
// services and a non-empty queue restored into a new container after a simulated loss; RPO and RTO measured.
// See docs/scale/RECOVERY-DRILL-FULL-20261029.md and tools/recovery/README.md.
//
//   node tools/recovery/full-drill.mjs --dataset dyna-scale-full-pg18 --db dynaminds_scale_20261029_03 \
//     --release <release-build.json> --local-config <dataset local-config.json> --dir <drill dir> \
//     --passphrase-file <0600 file> [--orders 100] [--readback 5] [--src dyna-recovery-full-src]
//     [--target dyna-recovery-full-t1] [--from source|seed|disaster|restore]
//
// source   (untimed) base backup of the dataset instance (read only for it), restored --latest into the new
//          drill source container (the "production" stand-in; the dataset container is never written).
// seed     (untimed) on the drill source through the release API: read-back sample, rule order.created →
//          add_note with its local worker on, image, N orders = N pending jobs; base backup set (files, sealed
//          keys, configuration); N more orders + image (WAL and files mirror only); files-sync; row counts of
//          every table per tenant = the recovery point (nothing writes the drill database after this).
// disaster acknowledged commits every 100 ms into recovery_rpo.rpo_probe, kill -9 of the drill source just
//          before its next archive_timeout switch (worst case); the data volume counts as lost.
// restore  (timed from the kill = RTO) PITR of the set + WAL archive (--latest) into a new container, RPO from
//          the probe, row counts compared, pending queue checked, files/keys/config placed, release CLI cold
//          start with --scoped-automation, 10 + 2 guards, queue drained once, API read-back; restart re-check.
import { spawn } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { REPO, docker, exists, psql, netnsNode, netnsNodeService, now, run } from './docker.mjs';
import { baseBackup, filesSync, restore } from './pitr.mjs';
import { STAGE5_CONTAINER, rpoWindow } from './pitr-lib.mjs';

const { values: a } = parseArgs({ options: { dataset: { type: 'string', default: 'dyna-scale-full-pg18' }, db: { type: 'string' },
  release: { type: 'string' }, 'local-config': { type: 'string' }, dir: { type: 'string' }, 'passphrase-file': { type: 'string' },
  orders: { type: 'string', default: '100' }, readback: { type: 'string', default: '5' },
  'readback-owners': { type: 'string', default: 'scale-5076fb8f-_@scale.example.test' }, email: { type: 'string', default: 'scale-5076fb8f-b@scale.example.test' },
  src: { type: 'string', default: 'dyna-recovery-full-src' }, target: { type: 'string', default: 'dyna-recovery-full-t1' },
  from: { type: 'string', default: 'source' }, port: { type: 'string', default: '18190' },
  'rate-ms': { type: 'string', default: '100' }, 'margin-ms': { type: 'string', default: '2500' } } });
for (const k of ['db', 'release', 'local-config', 'dir', 'passphrase-file']) if (!a[k]) throw new Error(`--${k} required`);
if (!/^dynaminds_scale_\d{8}_\d{2}$/.test(a.db)) throw new Error('--db must be dynaminds_scale_YYYYMMDD_NN');
for (const c of [a.src, a.target]) if (c === a.dataset || c === STAGE5_CONTAINER || !/^dyna-recovery-[a-z0-9-]+$/.test(c))
  throw new Error(`refused: ${c} (drill containers are new dyna-recovery-* containers, never the dataset or stage 5 instance)`);
const STEPS = ['source', 'seed', 'disaster', 'restore'];
if (!STEPS.includes(a.from)) throw new Error(`--from ${STEPS.join('|')}`);

const sha = (b) => createHash('sha256').update(b).digest('hex');
const rb = JSON.parse(readFileSync(a.release, 'utf8'));
const reportPath = join(a.dir, 'full-drill-report.json');
const priv = (p) => { mkdirSync(p, { recursive: true, mode: 0o700 }); chmodSync(p, 0o700); return p; };
priv(a.dir);
const report = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, 'utf8')) : { schema: 'dyna-recovery-full-drill/v1' };
const save = () => writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
const log = (m) => console.error(`[${new Date().toISOString()}] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = (ms) => new Date(ms).toISOString();
const lastJson = (s) => JSON.parse(s.trim().split('\n').filter((l) => l.startsWith('{')).pop());

/** Private application state for one container: local config copy, image dir, env file and CLI selection. */
function appState(dir, localConfig, container) {
  priv(dir); priv(join(dir, 'files', 'product-images'));
  const cfg = join(dir, 'local-config.json');
  if (!existsSync(cfg)) { copyFileSync(localConfig, cfg); chmodSync(cfg, 0o600); }
  const url = `postgres://postgres:${encodeURIComponent(JSON.parse(readFileSync(cfg, 'utf8')).dbPassword)}@127.0.0.1:5432/${a.db}`;
  const envFile = join(dir, 'app.env.private');
  writeFileSync(envFile, [`DATABASE_URL=${url}`, `DYNA_LOCAL_CONFIG_PATH=${realpathSync(cfg)}`, `DYNA_IMAGE_DIR=${realpathSync(join(dir, 'files', 'product-images'))}`,
    'DYNA_TEST=true', 'DYNA_WORKER_DISABLED=true', 'TZ=UTC', ''].join('\n'), { mode: 0o600 });
  chmodSync(envFile, 0o600);
  const selection = join(dir, 'selection.private.json');
  writeFileSync(selection, JSON.stringify({ releaseDirectory: rb.release_directory, manifestSha: rb.release_manifest_sha256, expectedOwner: 'postgres',
    databaseUrl: url, localConfigurationPath: realpathSync(cfg), revision: rb.release_manifest_sha256 }), { mode: 0o600 });
  chmodSync(selection, 0o600);
  return { dir: realpathSync(dir), envFile, selection: realpathSync(selection), selectionSha: sha(readFileSync(selection)), container };
}
const drill = (st, args) => netnsNode(st.container, 'dyna-recovery-full-drill-app', { envFile: st.envFile }, ['tools/recovery/drill-app.mjs', ...args]);

/** Row count of every table of the drill database, per tenant (tables with tenant_id) or in total ('*'). */
function tableCounts(container, db) {
  const tables = psql(container, db, `SELECT c.relname || '|' || EXISTS (SELECT 1 FROM pg_attribute t WHERE t.attrelid=c.oid AND t.attname='tenant_id' AND NOT t.attisdropped)
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p') AND NOT c.relispartition ORDER BY 1`)
    .split('\n').filter(Boolean).map((l) => l.split('|'));
  const sql = tables.map(([t, tenant]) => tenant === 'true'
    ? `SELECT '${t}', tenant_id::text, count(*) FROM public."${t}" GROUP BY 2` : `SELECT '${t}', '*', count(*) FROM public."${t}"`).join('\nUNION ALL ') + ';';
  const t0 = now();
  const out = run('docker', ['exec', '-i', container, 'psql', '-X', '-At', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', db, '-c', 'SET jit=off', '-f', '-'], { input: sql });
  const counts = {};
  for (const l of out.split('\n')) { const [t, tenant, n] = l.split('|'); if (n !== undefined && t !== 'SET') (counts[tenant] ??= {})[t] = Number(n); }
  const rows = Object.values(counts).reduce((s, m) => s + Object.values(m).reduce((x, y) => x + y, 0), 0);
  return { tables: tables.length, rows, ms: now() - t0, counts };
}
function compareCounts(x, y) {
  const diffs = [];
  for (const tenant of new Set([...Object.keys(x.counts), ...Object.keys(y.counts)]))
    for (const t of new Set([...Object.keys(x.counts[tenant] ?? {}), ...Object.keys(y.counts[tenant] ?? {})])) {
      const p = x.counts[tenant]?.[t] ?? 0, q = y.counts[tenant]?.[t] ?? 0;
      if (p !== q) diffs.push({ tenant, table: t, source: p, restored: q });
    }
  return diffs;
}
const summaryCounts = (c, tenants) => Object.fromEntries(tenants.map((id) => [id, Object.fromEntries(
  ['products', 'orders', 'order_items', 'order_events', 'documents', 'payment_entries', 'return_cases', 'stock_movements', 'wms_lots', 'wms_operations', 'jobs']
    .map((t) => [t, c.counts[id]?.[t] ?? 0]))]));
const scaleTenants = (container) => psql(container, a.db, `SELECT m.tenant_id FROM users u JOIN memberships m ON m.user_id=u.id AND m.role='admin'
  WHERE u.email LIKE '${a['readback-owners'].replace(/'/g, "''")}' ORDER BY u.email`).split('\n').filter(Boolean);
const jobSummary = (container) => Object.fromEntries(psql(container, a.db, "SELECT kind||'/'||state, count(*) FROM jobs GROUP BY 1 ORDER BY 1")
  .split('\n').filter(Boolean).map((l) => { const [k, n] = l.split('|'); return [k, Number(n)]; }));
const clusterBytes = (c) => Number(psql(c, 'postgres', 'SELECT sum(pg_database_size(datname))::bigint FROM pg_database'));

async function stepSource() {
  report.dataset = { container: a.dataset, db: a.db, system_identifier: psql(a.dataset, 'postgres', 'SELECT system_identifier FROM pg_control_system()'),
    db_bytes: Number(psql(a.dataset, 'postgres', `SELECT pg_database_size('${a.db}')`)), cluster_bytes: clusterBytes(a.dataset) };
  report.release = { commit: rb.commit, release_manifest_sha256: rb.release_manifest_sha256, package_tree_sha256: rb.package_tree_sha256, build_record: a.release };
  log(`row counts of ${a.dataset}/${a.db} (read only)`);
  const c = tableCounts(a.dataset, a.db);
  writeFileSync(join(a.dir, 'counts-dataset.json'), JSON.stringify(c) + '\n', { mode: 0o600 });
  report.dataset.counts = { tables: c.tables, rows: c.rows, ms: c.ms };
  report.dataset.jobs = jobSummary(a.dataset);
  log(`base backup of ${a.dataset} (only pg_basebackup touches it)`);
  report.dataset_backup = baseBackup({ source: a.dataset, sets: join(a.dir, 'sets-dataset'), config: [], label: 'full_drill_dataset' });
  log(`restore --latest into the drill source ${a.src}`);
  report.source_restore = await restore({ set: report.dataset_backup.set, target: a.src, target_mode: 'latest' });
  const s = tableCounts(a.src, a.db);
  report.source_restore.counts_equal_dataset = compareCounts(c, s).length === 0;
  report.source_restore.archive = psql(a.src, 'postgres', "SELECT current_setting('archive_mode')||' '||current_setting('archive_timeout')");
  report.source_restore.alter_system = psql(a.src, 'postgres', "SELECT string_agg(name||'='||setting||coalesce(unit,''), ', ' ORDER BY name) FROM pg_settings WHERE sourcefile LIKE '%postgresql.auto.conf'");
  save();
}

async function stepSeed() {
  const run_id = `f${Date.now().toString(36)}`;
  report.run = run_id;
  const st = appState(join(a.dir, 'src-app'), a['local-config'], a.src);
  const seedArgs = (phase) => ['seed', '--release', a.release, '--state', st.dir, '--email', a.email, '--orders', a.orders, '--run', run_id, '--phase', phase];
  let t = now();
  log('seed phase 1 (read-back sample, rule + worker, image, orders) through the release API');
  report.seed1 = { ...lastJson(drill(st, [...seedArgs('1'), '--readback', a.readback, '--readback-owners', a['readback-owners']])), ms: now() - t };
  log('base backup set of the drill source (files, sealed keys, configuration)');
  report.base_backup = baseBackup({ source: a.src, sets: join(a.dir, 'sets'), files: join(st.dir, 'files', 'product-images'),
    keys: join(st.dir, 'local-config.json'), passphrase_file: a['passphrase-file'], label: `full_drill_${run_id}`,
    config: [join(REPO, 'tools/scale/docker/postgresql.scale.conf'), join(REPO, 'tools/scale/docker/compose.yml'), join(REPO, 'tools/scale/docker/Dockerfile'), a.release] });
  t = now();
  log('seed phase 2 (after the base backup: WAL and files mirror only)');
  report.seed2 = { ...lastJson(drill(st, seedArgs('2'))), ms: now() - t };
  report.files_sync = filesSync({ files: join(st.dir, 'files', 'product-images'), mirror: join(a.dir, 'files-mirror') });
  log('row counts at the recovery point');
  const c = tableCounts(a.src, a.db);
  writeFileSync(join(a.dir, 'counts-source.json'), JSON.stringify(c) + '\n', { mode: 0o600 });
  const seeded = JSON.parse(readFileSync(join(st.dir, 'seed.json'), 'utf8'));
  report.recovery_point = { at: iso(now()), tables: c.tables, rows: c.rows, ms: c.ms, jobs: jobSummary(a.src),
    seeded_pending: Number(psql(a.src, a.db, `SELECT count(*) FROM jobs WHERE id = ANY('{${seeded.jobs.join(',')}}'::uuid[]) AND state='pending' AND attempts=0`)),
    seeded_jobs: seeded.jobs.length, cluster_bytes: clusterBytes(a.src) };
  save();
}

async function stepDisaster() {
  const archiveTimeoutS = Number(psql(a.src, 'postgres', "SELECT setting FROM pg_settings WHERE name='archive_timeout'"));
  if (psql(a.src, 'postgres', "SELECT count(*) FROM pg_database WHERE datname='recovery_rpo'") === '0') psql(a.src, 'postgres', 'CREATE DATABASE recovery_rpo');
  psql(a.src, 'recovery_rpo', 'DROP TABLE IF EXISTS rpo_probe');
  psql(a.src, 'recovery_rpo', 'CREATE TABLE rpo_probe(seq bigint PRIMARY KEY, at timestamptz NOT NULL DEFAULT clock_timestamp())');
  // Writer: one session, autocommit, synchronous_commit=on — a returned row is a durable local commit.
  const w = spawn('docker', ['exec', '-i', a.src, 'psql', '-X', '-At', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'recovery_rpo'], { stdio: ['pipe', 'pipe', 'pipe'] });
  const acked = [];
  let buf = '';
  w.stdout.on('data', (b) => {
    buf += b; const lines = buf.split('\n'); buf = lines.pop();
    for (const l of lines) { const [seq, ms] = l.split('|'); if (/^\d+$/.test(seq)) acked.push({ seq: Number(seq), at_ms: Number(ms) }); }
  });
  w.stderr.on('data', () => {}); w.stdin.on('error', () => {});
  let seq = 0, writing = true;
  (async () => { while (writing) { seq++; w.stdin.write(`INSERT INTO rpo_probe(seq) VALUES (${seq}) RETURNING seq, (extract(epoch FROM at)*1000)::bigint;\n`); await sleep(Number(a['rate-ms'])); } })();
  const archived = () => psql(a.src, 'postgres', "SELECT coalesce(last_archived_wal,'')||'|'||coalesce((extract(epoch FROM last_archived_time)*1000)::bigint::text,'0') FROM pg_stat_archiver").split('|');
  // Two archive_timeout switches while writing: the first archives the seed's last segment, the second times the kill.
  const [w0] = archived();
  let last, switches = 0, prev = w0;
  while (switches < 2) { last = archived(); if (last[0] !== prev && acked.length > 0) { switches++; prev = last[0]; } if (switches < 2) await sleep(200); }
  const killAt = Number(last[1]) + archiveTimeoutS * 1000 - Number(a['margin-ms']);
  log(`archived ${last[0]} at ${iso(Number(last[1]))}; kill -9 at ${iso(killAt)}`);
  while (now() < killAt) await sleep(50);
  const beforeKill = archived();
  const crash = now();
  docker('kill', '--signal', 'KILL', a.src);
  writing = false; await sleep(500); w.kill('SIGKILL');
  report.disaster = { archive_timeout_s: archiveTimeoutS, last_switch: { wal: last[0], archived_at: iso(Number(last[1])) }, archived_before_kill: beforeKill[0],
    crash_ms: crash, crash_at: iso(crash), acked: { count: acked.length, last: acked[acked.length - 1] },
    pending_seeded_jobs_at_crash: report.recovery_point.seeded_pending };
  writeFileSync(join(a.dir, 'rpo-acked.json'), JSON.stringify(acked) + '\n', { mode: 0o600 });
  log(`killed ${a.src}; ${acked.length} acknowledged probe commits, last seq ${report.disaster.acked.last.seq}`);
  save();
}

async function stepRestore() {
  if (exists('container', a.target)) throw new Error(`${a.target} exists; use a new --target for a fresh restore`);
  const set = report.base_backup.set, seed = JSON.parse(readFileSync(join(a.dir, 'src-app', 'seed.json'), 'utf8'));
  // The RTO clock starts at the kill when the restore follows it directly; a repeated restore counts from its own start.
  const T0 = a.from === 'restore' ? now() : report.disaster.crash_ms, phases = {};
  report.rto_from = a.from === 'restore' ? 'restore start (repeat)' : 'kill -9 of the drill source';
  phases.detect_to_restore_ms = now() - T0;
  log(`restore ${set} --latest → ${a.target}`);
  const r = await restore({ set, target: a.target, target_mode: 'latest', state: join(a.dir, `${a.target}-state`),
    passphrase_file: a['passphrase-file'], files_mirror: join(a.dir, 'files-mirror', 'product-images') });
  report.restore = r; Object.assign(phases, r.phases_ms); delete phases.total_ms;
  let t = now();
  const acked = JSON.parse(readFileSync(join(a.dir, 'rpo-acked.json'), 'utf8'));
  const [rseq, rms, rcount] = psql(a.target, 'recovery_rpo', 'SELECT max(seq), (extract(epoch FROM max(at))*1000)::bigint, count(*) FROM rpo_probe').split('|').map(Number);
  report.rpo = { ...rpoWindow({ acked, restored_last: { seq: rseq, at_ms: rms }, crash_ms: report.disaster.crash_ms, restored_count: rcount }),
    restored_last: { seq: rseq, at: iso(rms) }, last_acked_at: iso(report.disaster.acked.last.at_ms) };
  phases.rpo_probe_ms = now() - t;
  t = now();
  const c = tableCounts(a.target, a.db);
  writeFileSync(join(a.dir, `counts-${a.target}.json`), JSON.stringify(c) + '\n', { mode: 0o600 });
  const diffs = compareCounts(JSON.parse(readFileSync(join(a.dir, 'counts-source.json'), 'utf8')), c);
  const tenants = scaleTenants(a.target);
  report.counts = { tables: c.tables, rows: c.rows, equal_to_recovery_point: diffs.length === 0, diffs: diffs.slice(0, 50), ms: c.ms,
    scale_tenants: summaryCounts(c, tenants) };
  phases.row_counts_ms = now() - t;
  t = now();
  const pending = Number(psql(a.target, a.db, `SELECT count(*) FROM jobs WHERE id = ANY('{${seed.jobs.join(',')}}'::uuid[]) AND state='pending' AND attempts=0`));
  report.after_restore = { pending_seeded_jobs: pending, expected_pending: seed.jobs.length, jobs: jobSummary(a.target) };
  if (!report.counts.equal_to_recovery_point || pending !== seed.jobs.length) { save(); throw new Error(`restore check failed: ${JSON.stringify({ diffs: diffs.length, pending })}`); }
  const st = appState(join(a.dir, `${a.target}-app`), join(a.dir, `${a.target}-state`, 'local-config.json'), a.target);
  run('sh', ['-c', `cp -p "$0"/* "$1"/`, join(a.dir, `${a.target}-state`, 'files', 'product-images'), join(st.dir, 'files', 'product-images')]);
  phases.queue_and_app_state_ms = now() - t;
  const cli = [join(rb.release_directory, 'runtime/server/ordinary-local-cli.mjs'), st.selection, st.selectionSha, a.port, '--scoped-automation'];
  const start = async (label) => {
    const t1 = now();
    const svc = netnsNodeService(a.target, 'dyna-recovery-full-app', { envFile: st.envFile }, cli, (l) => l.includes('ORDINARY_LOCAL_APP_LISTENING'), 20 * 60 * 1000);
    report[label] = { line: JSON.parse(await svc.started), ms: now() - t1 };
    return svc;
  };
  log('cold start of the release CLI (--scoped-automation) on the restored database');
  let svc = await start('service_start');
  phases.service_start_ms = report.service_start.ms;
  t = now();
  log('verify: 10 + 2 guards, queue drained once, API read-back');
  report.verify = lastJson(drill(st, ['verify', '--state', join(a.dir, 'src-app'), '--port', a.port, '--timeout-ms', '900000']));
  phases.verify_and_drain_ms = now() - t;
  report.rto_ms = now() - T0;
  report.phases_ms = phases;
  report.jobs_after_drain = jobSummary(a.target);
  save();
  log(`RTO ${report.rto_ms} ms; restart: no second effect`);
  docker('stop', '-t', '60', 'dyna-recovery-full-app');
  await new Promise((r2) => svc.child.on('exit', r2));
  svc = await start('service_restart');
  await sleep(15000);
  report.verify_after_restart = lastJson(drill(st, ['verify', '--state', join(a.dir, 'src-app'), '--port', a.port, '--timeout-ms', '120000']));
  docker('stop', '-t', '60', 'dyna-recovery-full-app');
  await new Promise((r2) => svc.child.on('exit', r2));
  report.target_cluster_bytes = clusterBytes(a.target);
  save();
  console.log(JSON.stringify({ rpo: report.rpo, rto_ms: report.rto_ms, phases_ms: phases, counts_equal: report.counts.equal_to_recovery_point,
    verify_ok: report.verify.ok, restart_ok: report.verify_after_restart.ok }, null, 2));
}

const run_steps = { source: stepSource, seed: stepSeed, disaster: stepDisaster, restore: stepRestore };
for (const s of STEPS.slice(STEPS.indexOf(a.from))) { log(`step ${s}`); await run_steps[s](); }
