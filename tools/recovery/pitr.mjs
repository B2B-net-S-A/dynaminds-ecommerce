#!/usr/bin/env node
// Physical backup sets and point-in-time restore for the Docker PostgreSQL of stage 5 (tools/scale/docker).
// See tools/recovery/README.md. Commands (all local Docker; arguments validated by pitr-lib.mjs):
//
//   base-backup   --source <container> --sets <dir> [--files <dir>] [--keys <local-config.json> --passphrase-file <f>]
//                 [--config <file>]... [--label <name>]
//   files-sync    --files <dir> --mirror <dir>          append-only copy of new files (between base backups)
//   restore-point --source <container> --name <name>    pg_create_restore_point + WAL switch
//   verify-set    --set <dir>
//   restore       --set <dir> --target <new container> (--target-time ISO | --target-name N | --latest)
//                 [--state <dir>] [--passphrase-file <f>] [--archive-volume <vol>] [--files-mirror <dir>]
//   prune         --sets <dir> --source <container> --keep N [--apply]
//
// The passphrase that seals the keys is read only from --passphrase-file (0600, the operator's own file);
// it is never an argument, an environment value or a log line. Output is JSON without secrets.
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseCli, buildManifest, validateManifest, verifySetFiles, sha256File, walFileName, walSegmentHeader, assertSameSystem,
  assertRestoreTarget, backupManifestIdentity, sealSecret, openSecret, readPassphraseFile, recoveryConf, prunePlan,
} from './pitr-lib.mjs';
import { IMAGE, PGDATA, docker, exists, psql, mountedVolume, uidgid, waitPromoted, run, now } from './docker.mjs';

const compactUtc = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
function privateDir(p) { mkdirSync(p, { recursive: true, mode: 0o700 }); chmodSync(p, 0o700); return p; }
function privateCopy(from, to) {
  const s = lstatSync(from);
  if (!s.isFile() || s.isSymbolicLink()) throw new Error(`not a regular file: ${from}`);
  copyFileSync(from, to); chmodSync(to, 0o600);
  return { bytes: lstatSync(to).size, sha256: sha256File(to) };
}
function walkFiles(root, rel = '') {
  const out = [];
  for (const d of readdirSync(join(root, rel), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const r = rel ? `${rel}/${d.name}` : d.name;
    if (d.isDirectory()) out.push(...walkFiles(root, r));
    else if (d.isFile()) out.push(r);
    else throw new Error(`unsupported entry in files directory: ${r}`);
  }
  return out;
}

export function baseBackup(o) {
  const t0 = now(), timings = {};
  const src = o.source;
  const sysid = psql(src, 'postgres', 'SELECT system_identifier FROM pg_control_system()');
  const version = psql(src, 'postgres', 'SHOW server_version');
  const segSize = Number(psql(src, 'postgres', "SELECT setting FROM pg_settings WHERE name='wal_segment_size'"));
  const archiveVolume = mountedVolume(src, '/wal-archive');
  if (!archiveVolume) throw new Error(`${src} has no volume at /wal-archive`);
  if (psql(src, 'postgres', 'SHOW archive_mode') !== 'on') throw new Error(`${src}: archive_mode is not on`);
  const id = `${compactUtc(t0)}-${src}`, dir = join(privateDir(o.sets), id);
  mkdirSync(dir, { mode: 0o700 }); // fails if the set already exists
  const baseDir = privateDir(join(dir, 'base'));
  let t = now();
  docker('run', '--rm', '--network', `container:${src}`, '--user', uidgid(), '-v', `${baseDir}:/backup`, IMAGE,
    'pg_basebackup', '-h', '127.0.0.1', '-p', '5432', '-U', 'postgres', '-w', '-D', '/backup', '-Ft', '-X', 'stream',
    '--compress=client-zstd:level=3,workers=4', '--checkpoint=fast', '--manifest-checksums=SHA256', `--label=${o.label ?? id}`);
  timings.base_backup_ms = now() - t;
  const base = readdirSync(baseDir).sort().map((f) => { chmodSync(join(baseDir, f), 0o600); return `base/${f}`; });
  const bm = backupManifestIdentity(readFileSync(join(baseDir, 'backup_manifest'), 'utf8'));
  assertSameSystem(sysid, bm.system_identifier, 'backup_manifest');
  t = now();
  const verified = docker('run', '--rm', '-v', `${baseDir}:/backup:ro`, IMAGE, 'pg_verifybackup', '-n', '/backup').trim();
  timings.verify_ms = now() - t;
  if (!/successfully verified/.test(verified)) throw new Error(`pg_verifybackup: ${verified}`);
  t = now();
  const files = [];
  if (o.files) {
    const root = basename(o.files);
    for (const r of walkFiles(o.files)) {
      const to = join(dir, 'files', root, r);
      privateDir(join(to, '..'));
      files.push({ path: `files/${root}/${r}`, ...privateCopy(join(o.files, r), to) });
    }
  }
  timings.files_ms = now() - t;
  let keys = null;
  if (o.keys) {
    const sealed = sealSecret(readFileSync(o.keys), readPassphraseFile(o.passphrase_file));
    const p = join(privateDir(join(dir, 'keys')), basename(o.keys) + '.sealed');
    writeFileSync(p, sealed, { mode: 0o600, flag: 'wx' });
    keys = { path: `keys/${basename(p)}`, bytes: sealed.length, sha256: sha256File(p) };
  }
  const config = o.config.map((f) => {
    const to = join(privateDir(join(dir, 'config')), basename(f));
    if (existsSync(to)) throw new Error(`two config files named ${basename(f)}`);
    return { path: `config/${basename(f)}`, ...privateCopy(f, to) };
  });
  timings.total_ms = now() - t0;
  const manifest = buildManifest({
    id, created_at: new Date(t0).toISOString(),
    source: { container: src, archive_volume: archiveVolume, system_identifier: sysid, server_version: version, timeline: bm.timeline,
      wal_segment_size: segSize, start_wal: walFileName(bm.timeline, bm.start_lsn, segSize), start_lsn: bm.start_lsn, stop_lsn: bm.end_lsn },
    base: base.map((p) => ({ path: p, bytes: lstatSync(join(dir, p)).size, sha256: sha256File(join(dir, p)) })),
    files, keys, config, timings_ms: timings,
  });
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  return { status: 'BASE_BACKUP_CREATED', set: dir, id, system_identifier: sysid, start_wal: manifest.source.start_wal,
    base_bytes: manifest.base.reduce((n, e) => n + e.bytes, 0), files: files.length, keys_sealed: !!keys, config: config.length, timings_ms: timings };
}

export function filesSync(o) {
  const root = basename(o.files), dest = privateDir(join(o.mirror, root));
  let copied = 0, present = 0;
  for (const r of walkFiles(o.files)) {
    const to = join(dest, r);
    if (existsSync(to)) {
      if (sha256File(to) !== sha256File(join(o.files, r))) throw new Error(`files-sync: ${r} changed after it was mirrored (files are immutable)`);
      present++; continue;
    }
    privateDir(join(to, '..'));
    privateCopy(join(o.files, r), to + '.part');
    run('mv', [to + '.part', to]);
    copied++;
  }
  return { status: 'FILES_SYNCED', mirror: dest, copied, present };
}

export function restorePoint(o) {
  const lsn = psql(o.source, 'postgres', `SELECT pg_create_restore_point('${o.name}')`);
  psql(o.source, 'postgres', 'SELECT pg_switch_wal()');
  return { status: 'RESTORE_POINT_CREATED', name: o.name, lsn, at: new Date().toISOString() };
}

export function readSet(dir) {
  const m = validateManifest(JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')));
  return m;
}

/** First bytes of an archived segment (plain or .zst) inside the archive volume. */
function archivedHeader(volume, name) {
  const out = run('docker', ['run', '--rm', '-v', `${volume}:/a:ro`, '--entrypoint', 'sh', IMAGE, '-c',
    `if [ -f /a/${name}.zst ]; then zstd -q -dc /a/${name}.zst | head -c 40 | od -An -tx1 -v; elif [ -f /a/${name} ]; then head -c 40 /a/${name} | od -An -tx1 -v; else exit 3; fi`],
  { allowFail: true });
  if (out.status === 3) throw new Error(`WAL archive ${volume} does not contain ${name} (start of the base backup)`);
  if (out.status !== 0) throw new Error(`reading ${name} from ${volume}: ${out.stderr}`);
  return Buffer.from(out.stdout.replace(/\s+/g, ''), 'hex');
}

export async function restore(o) {
  const t0 = now(), phases = {};
  let t = now();
  const m = readSet(o.set);
  assertRestoreTarget(m, o.target);
  const integrity = verifySetFiles(o.set, m);
  const volume = o.archive_volume ?? m.source.archive_volume;
  assertSameSystem(m.source.system_identifier, walSegmentHeader(archivedHeader(volume, m.source.start_wal)).system_identifier, 'WAL archive');
  assertSameSystem(m.source.system_identifier, backupManifestIdentity(readFileSync(join(o.set, 'base', 'backup_manifest'), 'utf8')).system_identifier, 'backup_manifest');
  const verified = docker('run', '--rm', '-v', `${join(o.set, 'base')}:/backup:ro`, IMAGE, 'pg_verifybackup', '-n', '/backup').trim();
  if (!/successfully verified/.test(verified)) throw new Error(`pg_verifybackup: ${verified}`);
  // Open the sealed keys before touching Docker volumes: a wrong passphrase stops the restore here.
  let keys = null;
  if (o.state && m.keys) {
    if (!o.passphrase_file) throw new Error('the set holds sealed keys: --passphrase-file is required');
    keys = openSecret(readFileSync(join(o.set, m.keys.path)), readPassphraseFile(o.passphrase_file));
  }
  phases.verify_set_ms = now() - t;

  const dataVol = `${o.target}-data`, walVol = `${o.target}-wal-archive`;
  for (const [k, n] of [['container', o.target], ['volume', dataVol], ['volume', walVol]])
    if (exists(k, n)) throw new Error(`refused: ${k} ${n} already exists (a restore goes to a new, empty container and volumes)`);
  t = now();
  docker('volume', 'create', dataVol); docker('volume', 'create', walVol);
  const conf = recoveryConf(o);
  // Root helper on the empty volume: extract base + streamed WAL, recovery settings, ownership as the image's postgres.
  docker('run', '--rm', '-v', `${dataVol}:/var/lib/postgresql`, '-v', `${walVol}:/wal-archive`, '-v', `${join(o.set, 'base')}:/set:ro`,
    '-e', `RECOVERY_CONF=${conf}`, '--entrypoint', 'sh', IMAGE, '-c',
    `set -eu; mkdir -p ${PGDATA}; zstd -q -dc /set/base.tar.zst | tar -xf - -C ${PGDATA};
     mkdir -p ${PGDATA}/pg_wal; if [ -f /set/pg_wal.tar.zst ]; then zstd -q -dc /set/pg_wal.tar.zst | tar -xf - -C ${PGDATA}/pg_wal; else tar -xf /set/pg_wal.tar -C ${PGDATA}/pg_wal; fi;
     printf '%s' "$RECOVERY_CONF" >> ${PGDATA}/postgresql.auto.conf; touch ${PGDATA}/recovery.signal;
     chown -R postgres:postgres /var/lib/postgresql /wal-archive; chmod 0700 ${PGDATA} /wal-archive`);
  phases.base_restore_ms = now() - t;

  t = now();
  docker('run', '-d', '--name', o.target, '--shm-size', '2g', '--stop-timeout', '120', '-e', 'SCALE_FAKETIME=off', '-e', 'TZ=UTC',
    '-v', `${dataVol}:/var/lib/postgresql`, '-v', `${walVol}:/wal-archive`, '-v', `${volume}:/wal-archive-src:ro`, IMAGE);
  await waitPromoted(o.target, 60 * 60 * 1000);
  phases.wal_replay_ms = now() - t;
  const restoredSysid = psql(o.target, 'postgres', 'SELECT system_identifier FROM pg_control_system()');
  assertSameSystem(m.source.system_identifier, restoredSysid, 'restored cluster');
  for (const k of ['restore_command', 'recovery_target_time', 'recovery_target_name', 'recovery_target_inclusive', 'recovery_target_action', 'recovery_target_timeline'])
    psql(o.target, 'postgres', `ALTER SYSTEM RESET ${k}`);
  psql(o.target, 'postgres', 'SELECT pg_reload_conf()');
  const logs = run('docker', ['logs', o.target], { allowFail: true });
  const lastTx = /last completed transaction was at log time ([0-9: .+-]+)/.exec(logs.stderr + logs.stdout)?.[1] ?? null;
  const stopping = /recovery stopping [^\n]*/.exec(logs.stderr + logs.stdout)?.[0] ?? null;
  const timeline = Number(psql(o.target, 'postgres', 'SELECT timeline_id FROM pg_control_checkpoint()'));

  t = now();
  const restored = { files: 0, files_from_mirror: 0, keys: null, config: 0 };
  if (o.state) {
    privateDir(o.state);
    for (const e of m.files) {
      const to = join(o.state, e.path);
      privateDir(join(to, '..'));
      const c = privateCopy(join(o.set, e.path), to);
      if (c.sha256 !== e.sha256) throw new Error(`${e.path}: restored copy differs`);
      restored.files++;
    }
    if (o.files_mirror) {
      for (const r of walkFiles(o.files_mirror)) {
        const to = join(o.state, 'files', basename(o.files_mirror), r);
        if (existsSync(to)) continue;
        privateDir(join(to, '..')); privateCopy(join(o.files_mirror, r), to); restored.files_from_mirror++;
      }
    }
    if (keys) {
      const to = join(o.state, basename(m.keys.path, '.sealed'));
      writeFileSync(to, keys, { mode: 0o600, flag: 'wx' });
      restored.keys = relative(o.state, to);
    }
    for (const e of m.config) { privateDir(join(o.state, 'config')); privateCopy(join(o.set, e.path), join(o.state, e.path)); restored.config++; }
  }
  phases.files_keys_config_ms = now() - t;
  phases.total_ms = now() - t0;
  return { status: 'RESTORED', target: o.target, data_volume: dataVol, wal_archive_volume: walVol, source_archive_volume: volume,
    set: m.id, target_mode: o.target_mode, target_time: o.target_time ?? null, target_name: o.target_name ?? null,
    system_identifier: restoredSysid, timeline, recovery_stopping: stopping, last_completed_transaction: lastTx,
    set_integrity: integrity, restored, phases_ms: phases };
}

export function prune(o) {
  const sets = readdirSync(o.sets).filter((d) => existsSync(join(o.sets, d, 'manifest.json')))
    .map((d) => readSet(join(o.sets, d))).filter((m) => m.source.container === o.source);
  const plan = prunePlan(sets, Number(o.keep));
  const volume = mountedVolume(o.source, '/wal-archive');
  const cleanup = docker('exec', '-u', 'postgres', o.source, 'pg_archivecleanup', ...(o.apply ? [] : ['-n']), '-x', '.zst', '/wal-archive', plan.wal_keep_from)
    .split('\n').filter(Boolean).length;
  if (o.apply) for (const id of plan.drop) run('rm', ['-rf', '--', join(o.sets, id)]);
  return { status: o.apply ? 'PRUNED' : 'PRUNE_PLAN', ...plan, archive_volume: volume, wal_files: cleanup };
}

const COMMANDS = { 'base-backup': baseBackup, 'files-sync': filesSync, 'restore-point': restorePoint, restore, prune,
  'verify-set': (o) => { const m = readSet(o.set); return { status: 'SET_VERIFIED', id: m.id, ...verifySetFiles(o.set, m) }; } };
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const { command, opts } = parseCli(process.argv.slice(2));
    console.log(JSON.stringify(await COMMANDS[command](opts), null, 2));
  } catch (e) { console.error(`pitr: ${e.message}`); process.exitCode = 1; }
}
