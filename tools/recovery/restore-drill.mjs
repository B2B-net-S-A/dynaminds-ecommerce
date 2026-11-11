#!/usr/bin/env node
// Timed restore drill (goal condition 11): database + files + keys + configuration + services + a non-empty
// job queue, restored to a new, empty container at a target time. See tools/recovery/README.md.
//
//   node tools/recovery/restore-drill.mjs --src dyna-recovery-src --template dynaminds_scale_20261026_04 \
//     --db dynaminds_scale_20261027_91 --release <release-build.json> --dir <drill dir> \
//     --passphrase-file <0600 file> [--orders 10] [--target dyna-recovery-t1] [--from prepare|restore]
//
// prepare (source, untimed): clone the template, seed phase 1 through the release API (owned rule
//   order.created → add_note with its local worker on, one image, N orders = N pending jobs), base backup
//   set (files snapshot, sealed keys, configuration), seed phase 2 (N more orders + one image, only in WAL
//   and the files mirror), files-sync, target time T, a canary row after T, WAL switch.
// restore (timed = RTO): pitr restore to T on a new container, canary check, pending queue check, release
//   CLI with --scoped-automation, guards + drain-once + API checks, restart and re-check (no double effects).
// Never touches dyna-scale-pg18: the source is a container restored from its base backup.
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { REPO, docker, exists, psql, netnsNode, netnsNodeService, now, run } from './docker.mjs';
import { baseBackup, filesSync, restore } from './pitr.mjs';
import { STAGE5_CONTAINER, drillExtrapolation } from './pitr-lib.mjs';

const { values: a } = parseArgs({ options: { src: { type: 'string' }, template: { type: 'string' }, db: { type: 'string' },
  release: { type: 'string' }, dir: { type: 'string' }, 'passphrase-file': { type: 'string' }, orders: { type: 'string', default: '10' },
  target: { type: 'string', default: 'dyna-recovery-t1' }, from: { type: 'string', default: 'prepare' }, port: { type: 'string', default: '18190' } } });
for (const k of ['src', 'db', 'release', 'dir', 'passphrase-file']) if (!a[k]) throw new Error(`--${k} required`);
if (a.src === STAGE5_CONTAINER || a.target === STAGE5_CONTAINER) throw new Error('the drill never runs on the stage 5 instance itself');
if (!/^dynaminds_scale_\d{8}_\d{2}$/.test(a.db)) throw new Error('--db must be dynaminds_scale_YYYYMMDD_NN');
const sha = (b) => createHash('sha256').update(b).digest('hex');
const rb = JSON.parse(readFileSync(a.release, 'utf8'));
const reportPath = join(a.dir, 'drill-report.json');
const report = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, 'utf8')) : { schema: 'dyna-recovery-drill/v1' };
const save = () => writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
const log = (m) => console.error(`[${new Date().toISOString()}] ${m}`);
const priv = (p) => { mkdirSync(p, { recursive: true, mode: 0o700 }); chmodSync(p, 0o700); return p; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Private application state for one container: local config copy, image dir, env file with the database URL. */
function appState(dir, localConfig, container) {
  priv(dir); priv(join(dir, 'files', 'product-images'));
  const cfg = join(dir, 'local-config.json');
  if (!existsSync(cfg)) { copyFileSync(localConfig, cfg); chmodSync(cfg, 0o600); }
  const password = JSON.parse(readFileSync(cfg, 'utf8')).dbPassword;
  const url = `postgres://postgres:${encodeURIComponent(password)}@127.0.0.1:5432/${a.db}`;
  const envFile = join(dir, 'app.env.private');
  writeFileSync(envFile, [`DATABASE_URL=${url}`, `DYNA_LOCAL_CONFIG_PATH=${realpathSync(cfg)}`, `DYNA_IMAGE_DIR=${realpathSync(join(dir, 'files', 'product-images'))}`,
    'DYNA_TEST=true', 'DYNA_WORKER_DISABLED=true', 'TZ=UTC', ''].join('\n'), { mode: 0o600 });
  chmodSync(envFile, 0o600);
  // Release CLI selection (ordinary-local-cli: private 0600 file + its sha256 on the command line).
  const selection = join(dir, 'selection.private.json');
  writeFileSync(selection, JSON.stringify({ releaseDirectory: rb.release_directory, manifestSha: rb.release_manifest_sha256, expectedOwner: 'postgres',
    databaseUrl: url, localConfigurationPath: realpathSync(cfg), revision: rb.release_manifest_sha256 }), { mode: 0o600 });
  chmodSync(selection, 0o600);
  return { dir: realpathSync(dir), envFile, selection: realpathSync(selection), selectionSha: sha(readFileSync(selection)), container };
}
const drill = (st, args) => netnsNode(st.container, 'dyna-recovery-drill-app', { envFile: st.envFile }, ['tools/recovery/drill-app.mjs', ...args]);
const lastJson = (s) => JSON.parse(s.trim().split('\n').filter((l) => l.startsWith('{')).pop());

async function waitArchived(container) {
  const want = psql(container, 'postgres', 'SELECT pg_walfile_name(pg_switch_wal())');
  for (let i = 0; i < 240; i++) {
    const last = psql(container, 'postgres', 'SELECT coalesce(last_archived_wal,\'\') FROM pg_stat_archiver');
    if (last >= want) return want;
    await sleep(250);
  }
  throw new Error(`${want} not archived within 60 s`);
}

async function prepare() {
  const run_id = `r${Date.now().toString(36)}`;
  report.run = run_id; report.source = { container: a.src, template: a.template, db: a.db };
  report.release = { commit: rb.commit, release_manifest_sha256: rb.release_manifest_sha256, package_tree_sha256: rb.package_tree_sha256 };
  if (psql(a.src, 'postgres', `SELECT count(*) FROM pg_database WHERE datname='${a.db}'`) === '0')
    psql(a.src, 'postgres', `CREATE DATABASE ${a.db} TEMPLATE ${a.template}`);
  const srcState = appState(join(a.dir, 'src-app'), join(a.dir, 'src-state', 'local-config.json'), a.src);
  let t = now();
  log('seed phase 1 (release factory, API)');
  report.seed1 = lastJson(drill(srcState, ['seed', '--release', a.release, '--state', srcState.dir, '--email', 'scale-5076fb8f-b@scale.example.test',
    '--orders', a.orders, '--run', run_id, '--phase', '1']));
  report.seed1.ms = now() - t;
  log('base backup of the source');
  report.base_backup = baseBackup({ source: a.src, sets: join(a.dir, 'sets'), files: join(srcState.dir, 'files', 'product-images'),
    keys: join(srcState.dir, 'local-config.json'), passphrase_file: a['passphrase-file'], label: `drill_${run_id}`,
    config: [join(REPO, 'tools/scale/docker/postgresql.scale.conf'), join(REPO, 'tools/scale/docker/compose.yml'), join(REPO, 'tools/scale/docker/Dockerfile'), a.release] });
  t = now();
  log('seed phase 2 (after the base backup: WAL only)');
  report.seed2 = lastJson(drill(srcState, ['seed', '--release', a.release, '--state', srcState.dir, '--email', 'scale-5076fb8f-b@scale.example.test',
    '--orders', a.orders, '--run', run_id, '--phase', '2']));
  report.seed2.ms = now() - t;
  report.files_sync = filesSync({ files: join(srcState.dir, 'files', 'product-images'), mirror: join(a.dir, 'files-mirror') });
  psql(a.src, 'postgres', 'CREATE TABLE IF NOT EXISTS drill_canary(label text PRIMARY KEY, at timestamptz NOT NULL DEFAULT clock_timestamp())');
  psql(a.src, 'postgres', `INSERT INTO drill_canary(label) VALUES ('before-${run_id}')`);
  await sleep(1000);
  report.target_time = psql(a.src, 'postgres', `SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`);
  await sleep(1000);
  psql(a.src, 'postgres', `INSERT INTO drill_canary(label) VALUES ('after-${run_id}')`);
  report.archived_through = await waitArchived(a.src);
  const seeded = JSON.parse(readFileSync(join(srcState.dir, 'seed.json'), 'utf8'));
  report.source_pending_at_target = Number(psql(a.src, a.db,
    `SELECT count(*) FROM jobs WHERE id = ANY('{${seeded.jobs.join(',')}}'::uuid[]) AND state='pending' AND attempts=0`));
  report.source_db_bytes = Number(psql(a.src, 'postgres', 'SELECT sum(pg_database_size(datname))::bigint FROM pg_database'));
  save();
}

async function restorePhase() {
  if (exists('container', a.target)) throw new Error(`${a.target} exists; remove it (and its volumes) for a fresh drill`);
  const set = report.base_backup.set, seed = JSON.parse(readFileSync(join(a.dir, 'src-app', 'seed.json'), 'utf8'));
  const T0 = now(), phases = {};
  log(`restore ${set} → ${a.target} at ${report.target_time}`);
  const r = await restore({ set, target: a.target, target_mode: 'time', target_time: report.target_time, state: join(a.dir, `${a.target}-state`),
    passphrase_file: a['passphrase-file'], files_mirror: join(a.dir, 'files-mirror', 'product-images') });
  report.restore = r; Object.assign(phases, r.phases_ms); delete phases.total_ms;
  let t = now();
  // Only this run's rows: a source container reused for a later drill still holds the earlier runs' canaries.
  const canary = psql(a.target, 'postgres', `SELECT string_agg(label, ',' ORDER BY label) FROM drill_canary WHERE label IN ('before-${report.run}','after-${report.run}')`);
  const pending = Number(psql(a.target, a.db, `SELECT count(*) FROM jobs WHERE id = ANY('{${seed.jobs.join(',')}}'::uuid[]) AND state='pending' AND attempts=0`));
  report.after_restore = { canary, canary_ok: canary === `before-${report.run}`, pending_seeded_jobs: pending, expected_pending: seed.jobs.length };
  if (!report.after_restore.canary_ok || pending !== seed.jobs.length) { save(); throw new Error(`restore check failed: ${JSON.stringify(report.after_restore)}`); }
  // Restored files/keys go where the release expects them: the restored local config, image dir from the set + mirror.
  const st = appState(join(a.dir, `${a.target}-app`), join(a.dir, `${a.target}-state`, 'local-config.json'), a.target);
  run('sh', ['-c', `cp -p "$0"/* "$1"/`, join(a.dir, `${a.target}-state`, 'files', 'product-images'), join(st.dir, 'files', 'product-images')]);
  phases.checks_ms = now() - t;
  const cli = [join(rb.release_directory, 'runtime/server/ordinary-local-cli.mjs'), st.selection, st.selectionSha, a.port, '--scoped-automation'];
  const start = async (label) => {
    const t1 = now();
    const svc = netnsNodeService(a.target, 'dyna-recovery-app', { envFile: st.envFile }, cli, (l) => l.includes('ORDINARY_LOCAL_APP_LISTENING'), 15 * 60 * 1000);
    report[label] = { line: JSON.parse(await svc.started), ms: now() - t1 };
    return svc;
  };
  log('start the release CLI (--scoped-automation)');
  let svc = await start('service_start');
  phases.service_start_ms = report.service_start.ms;
  t = now();
  log('verify: guards, queue drained once, API');
  report.verify = lastJson(drill(st, ['verify', '--state', join(a.dir, 'src-app'), '--port', a.port, '--timeout-ms', '600000']));
  phases.verify_and_drain_ms = now() - t;
  report.rto_ms = now() - T0;
  report.phases_ms = phases;
  save();
  log('restart: no second effect');
  docker('stop', '-t', '60', 'dyna-recovery-app');
  await new Promise((r2) => svc.child.on('exit', r2));
  svc = await start('service_restart');
  await sleep(15000);
  report.verify_after_restart = lastJson(drill(st, ['verify', '--state', join(a.dir, 'src-app'), '--port', a.port, '--timeout-ms', '60000']));
  docker('stop', '-t', '60', 'dyna-recovery-app');
  report.extrapolation = drillExtrapolation(report, process.env);
  save();
  console.log(JSON.stringify({ rto_ms: report.rto_ms, phases_ms: phases, verify_ok: report.verify.ok, restart_ok: report.verify_after_restart.ok }, null, 2));
}

priv(a.dir);
if (a.from === 'prepare') await prepare();
await restorePhase();
