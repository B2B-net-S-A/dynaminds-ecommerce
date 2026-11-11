#!/usr/bin/env node
// Cold start of the packaged release, measured as the load run measures it (run.mjs `dyna-load-app_ready_ms`):
// from `docker run` of the release CLI (ordinary-local-cli.mjs … --scoped-automation) in the network namespace of
// the database container until its ORDINARY_LOCAL_APP_LISTENING line; then the CLI is stopped. One start at a time.
//
//   node tools/scale/load/coldstart.mjs --release <release-build.json> --db dynaminds_scale_YYYYMMDD_NN --out <new dir> [--runs 2]
//
// Output in --out (0700): run.json (ready_ms per start, host load), cli-N.log. The database URL and the local
// config copy live in --out/private during the run and are deleted at its end.
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cpus, loadavg } from 'node:os';
import { parseArgs } from 'node:util';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const NODE_IMAGE = process.env.SCALE_NODE_IMAGE ?? 'node:22.23.0-trixie-slim@sha256:cfd8f2a5bc50526aee08e88970979f92722828e7dcc6d8983607fb8bff4bdb82';
const PG = process.env.SCALE_PG_CONTAINER ?? 'dyna-scale-pg18';
const STATE = process.env.SCALE_PG_STATE ?? join(REPO, 'data/scale/pg18-docker');
const { values: a } = parseArgs({ options: { release: { type: 'string' }, db: { type: 'string' }, out: { type: 'string' }, runs: { type: 'string', default: '2' }, port: { type: 'string', default: '4111' } } });
for (const k of ['release', 'db', 'out']) if (!a[k]) throw new Error(`--${k} required`);
if (!/^dynaminds_scale_\d{8}_\d{2}$/.test(a.db)) throw new Error('--db must be dynaminds_scale_YYYYMMDD_NN');
const rb = JSON.parse(readFileSync(a.release, 'utf8'));
const sha = (b) => createHash('sha256').update(b).digest('hex');
const commonAncestor = (x, y) => { const p = x.split(sep), q = y.split(sep); let i = 0; while (i < p.length && p[i] === q[i]) i++; return p.slice(0, i).join(sep); };
const WORKSPACE = commonAncestor(commonAncestor(realpathSync(REPO), rb.release_directory), realpathSync(STATE));
if (existsSync(a.out)) throw new Error(`${a.out} exists`);
mkdirSync(a.out, { recursive: true, mode: 0o700 }); chmodSync(a.out, 0o700);
const out = realpathSync(a.out), priv = join(out, 'private');
mkdirSync(join(priv, 'images'), { recursive: true, mode: 0o700 });
const cfg = JSON.parse(readFileSync(join(STATE, 'local-config.json'), 'utf8'));
copyFileSync(join(STATE, 'local-config.json'), join(priv, 'local-config.json')); chmodSync(join(priv, 'local-config.json'), 0o600);
const dbUrl = `postgres://postgres:${encodeURIComponent(cfg.dbPassword)}@127.0.0.1:5432/${a.db}`;
const envFile = join(priv, 'app.env');
writeFileSync(envFile, [`DATABASE_URL=${dbUrl}`, `DYNA_LOCAL_CONFIG_PATH=${join(priv, 'local-config.json')}`, `DYNA_IMAGE_DIR=${join(priv, 'images')}`,
  'DYNA_TEST=true', 'DYNA_WORKER_DISABLED=true', 'TZ=UTC', ''].join('\n'), { mode: 0o600 });
const selection = join(priv, 'selection.json');
writeFileSync(selection, JSON.stringify({ releaseDirectory: rb.release_directory, manifestSha: rb.release_manifest_sha256, expectedOwner: 'postgres', databaseUrl: dbUrl,
  localConfigurationPath: join(priv, 'local-config.json'), revision: rb.release_manifest_sha256 }), { mode: 0o600 });
const report = { schema: 'dyna-coldstart/v1', database: a.db, release: { commit: rb.commit, release_manifest_sha256: rb.release_manifest_sha256, package_tree_sha256: rb.package_tree_sha256 },
  host: { cpus: cpus().length, cpu: cpus()[0]?.model }, started_at: new Date().toISOString(), runs: [] };
const save = () => writeFileSync(join(out, 'run.json'), JSON.stringify(report, null, 1) + '\n', { mode: 0o600 });

function start(i) {
  const name = `dyna-coldstart-${process.pid}-${i}`, logFile = join(out, `cli-${i}.log`), t0 = Date.now(), load0 = loadavg();
  const child = spawn('docker', ['run', '--rm', '--init', '--name', name, '--network', `container:${PG}`, '--user', `${process.getuid()}:${process.getgid()}`,
    '-v', `${WORKSPACE}:${WORKSPACE}`, '-w', REPO, '--env-file', envFile, NODE_IMAGE, 'node',
    join(rb.release_directory, 'runtime/server/ordinary-local-cli.mjs'), selection, sha(readFileSync(selection)), a.port, '--scoped-automation'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let buf = '';
  return new Promise((res) => {
    const done = (row) => { spawnSync('docker', ['stop', '-t', '60', name]); child.once('exit', () => res(row)); if (child.exitCode !== null) res(row); };
    const on = (b) => { appendFileSync(logFile, b); buf += b; if (buf.includes('ORDINARY_LOCAL_APP_LISTENING')) { child.stdout.removeAllListeners('data'); done({ run: i, ready_ms: Date.now() - t0, loadavg_start: load0, loadavg_ready: loadavg() }); } };
    child.stdout.on('data', on); child.stderr.on('data', on);
    child.on('exit', (code) => { if (!buf.includes('ORDINARY_LOCAL_APP_LISTENING')) res({ run: i, failed: true, code, ms: Date.now() - t0, tail: buf.slice(-1500) }); });
  });
}
try {
  for (let i = 1; i <= Number(a.runs); i++) { const row = await start(i); report.runs.push(row); save(); console.error(JSON.stringify(row)); if (row.failed) { process.exitCode = 1; break; } }
} finally {
  report.finished_at = new Date().toISOString(); save();
  rmSync(priv, { recursive: true, force: true });
}
console.log(JSON.stringify({ status: process.exitCode ? 'COLDSTART_FAILED' : 'COLDSTART_DONE', ready_ms: report.runs.map((r) => r.ready_ms ?? null), out }));
