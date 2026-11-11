// Docker helpers shared by the recovery commands (pitr.mjs) and drills. Every command is local Docker;
// none of them carries a password on its command line (trust authentication over the container's own
// loopback, as in the image's pg_hba.conf; the release reads its private config file).
import { spawn, spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const WORKSPACE = resolve(REPO, '../..');
export const IMAGE = process.env.DYNA_PG_IMAGE ?? 'dyna-scale-pg18-faketime:18.4';
export const NODE_IMAGE = process.env.SCALE_NODE_IMAGE ??
  'node:22.23.0-trixie-slim@sha256:cfd8f2a5bc50526aee08e88970979f92722828e7dcc6d8983607fb8bff4bdb82';
export const PGDATA = '/var/lib/postgresql/18/docker';
export const now = () => Date.now();

export function run(cmd, args, { input, allowFail = false } = {}) {
  const r = spawnSync(cmd, args, { input, maxBuffer: 1 << 30 });
  if (r.status !== 0 && !allowFail)
    throw new Error(`${cmd} ${args.slice(0, 4).join(' ')} … exit ${r.status}: ${String(r.stderr).slice(-3000)}`);
  return allowFail ? { status: r.status, stdout: String(r.stdout), stderr: String(r.stderr) } : String(r.stdout);
}
export const docker = (...args) => run('docker', args);
export const exists = (kind, name) => run('docker', [kind, 'inspect', name], { allowFail: true }).status === 0;
export function psql(container, db, sql) {
  return docker('exec', '-i', container, 'psql', '-X', '-At', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', db, '-c', sql).trim();
}
export function mountedVolume(container, destination) {
  return docker('inspect', '-f', `{{range .Mounts}}{{if eq .Destination "${destination}"}}{{.Name}}{{end}}{{end}}`, container).trim();
}
export const uidgid = () => `${process.getuid()}:${process.getgid()}`;

/** Wait until the server in `container` accepts connections and has left recovery. */
export async function waitPromoted(container, timeoutMs) {
  const t0 = now();
  for (;;) {
    const r = run('docker', ['exec', container, 'psql', '-X', '-At', '-U', 'postgres', '-d', 'postgres', '-c', 'SELECT pg_is_in_recovery()'], { allowFail: true });
    if (r.status === 0 && r.stdout.trim() === 'f') return now() - t0;
    const state = run('docker', ['inspect', '-f', '{{.State.Status}}', container], { allowFail: true }).stdout.trim();
    if (state === 'exited') throw new Error(`${container} exited during recovery: ${run('docker', ['logs', '--tail', '40', container], { allowFail: true }).stderr}`);
    if (now() - t0 > timeoutMs) throw new Error(`${container}: not promoted within ${timeoutMs} ms`);
    await new Promise((r2) => setTimeout(r2, 250));
  }
}

/**
 * Node (Linux) in `container`'s network namespace: 127.0.0.1:5432 is that server, as the packaged release's
 * cold identity check requires (tools/scale/docker/README.md, "Release"). Workspace at its own absolute path,
 * caller's uid/gid (the release requires its 0600 config files to belong to the process user).
 */
// envFile (0600): values that carry the database password (DATABASE_URL); never on the docker command line.
export function netnsNodeArgs(container, name, { env = {}, envFile }, args) {
  return ['run', '--rm', '--init', '--name', name, '--network', `container:${container}`, '--user', uidgid(),
    '-v', `${WORKSPACE}:${WORKSPACE}`, '-w', REPO, ...(envFile ? ['--env-file', envFile] : []),
    ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]), NODE_IMAGE, 'node', ...args];
}
export function netnsNode(container, name, env, args) { return docker(...netnsNodeArgs(container, name, env, args)); }
/** Long-running variant (the release CLI): resolves once `ready(line)` matches a stdout line. */
export function netnsNodeService(container, name, env, args, ready, timeoutMs) {
  const child = spawn('docker', netnsNodeArgs(container, name, env, args), { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  const started = new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`${name}: not ready within ${timeoutMs} ms; stderr ${err.slice(-2000)}`)), timeoutMs);
    child.stdout.on('data', (b) => { out += b; for (const l of out.split('\n')) if (ready(l)) { clearTimeout(t); res(l); } });
    child.stderr.on('data', (b) => { err += b; });
    child.on('exit', (code) => { clearTimeout(t); rej(new Error(`${name} exited ${code} before ready; stderr ${err.slice(-2000)}`)); });
  });
  return { child, started, output: () => ({ out, err }) };
}
