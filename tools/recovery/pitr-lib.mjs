// Pure parts of the physical backup / point-in-time recovery tooling (tools/recovery/pitr.mjs).
// No Docker and no database here, so every rule below is unit-tested (tests/recovery-pitr.test.mjs).
import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from 'node:crypto';
import { closeSync, lstatSync, openSync, readFileSync, readSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

export const SET_SCHEMA = 'dyna-recovery-set/v1';
export const STAGE5_CONTAINER = 'dyna-scale-pg18';
export const RESTORE_COMMAND = '/usr/local/bin/dyna-wal-restore /wal-archive-src %f %p';
const CONTAINER = /^dyna-[a-z0-9][a-z0-9-]{0,40}$/;
const POINT = /^[a-z0-9_-]{1,63}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;
const HEX64 = /^[a-f0-9]{64}$/;
const fail = (m) => { throw new Error(m); };

// ---- command line ----
const COMMANDS = {
  'base-backup': { value: ['source', 'sets', 'files', 'keys', 'config', 'passphrase-file', 'label'], flag: [], required: ['source', 'sets'] },
  restore: { value: ['set', 'target', 'target-time', 'target-name', 'state', 'passphrase-file', 'archive-volume', 'files-mirror'], flag: ['latest'], required: ['set', 'target'] },
  'files-sync': { value: ['files', 'mirror'], flag: [], required: ['files', 'mirror'] },
  'verify-set': { value: ['set'], flag: [], required: ['set'] },
  prune: { value: ['sets', 'source', 'keep'], flag: ['apply'], required: ['sets', 'source', 'keep'] },
  'restore-point': { value: ['source', 'name'], flag: [], required: ['source', 'name'] },
};
const PATHS = new Set(['sets', 'files', 'keys', 'config', 'passphrase-file', 'set', 'state', 'mirror', 'files-mirror']);
function absolute(name, v) {
  if (!isAbsolute(v) || resolve(v) !== v) fail(`--${name} must be an absolute, normalized path: ${v}`);
  return v;
}
export function parseCli(argv) {
  const [command, ...rest] = argv;
  const spec = COMMANDS[command] ?? fail(`unknown command ${command ?? '(none)'}; one of ${Object.keys(COMMANDS).join(', ')}`);
  const o = { config: [] };
  for (let i = 0; i < rest.length; i++) {
    const name = rest[i].startsWith('--') ? rest[i].slice(2) : fail(`unexpected argument ${rest[i]}`);
    if (spec.flag.includes(name)) { o[name] = true; continue; }
    if (!spec.value.includes(name)) fail(`unknown option --${name}`);
    const v = rest[++i];
    if (v === undefined || v.startsWith('--')) fail(`--${name} needs a value`);
    if (name === 'config') { o.config.push(absolute(name, v)); continue; }
    if (o[name] !== undefined) fail(`--${name} given twice`);
    o[name] = PATHS.has(name) ? absolute(name, v) : v;
  }
  for (const r of spec.required) if (o[r] === undefined) fail(`--${r} is required for ${command}`);
  for (const k of ['source', 'target']) if (o[k] !== undefined && !CONTAINER.test(o[k])) fail(`--${k}: container name must match ${CONTAINER}, got ${o[k]}`);
  if (o['archive-volume'] !== undefined && !CONTAINER.test(o['archive-volume'])) fail(`--archive-volume: volume name must match ${CONTAINER}`);
  for (const k of ['label', 'name']) if (o[k] !== undefined && !POINT.test(o[k])) fail(`--${k}: restore point name must match ${POINT}`);
  if (o.keys && !o['passphrase-file']) fail('--keys needs --passphrase-file (keys are stored sealed)');
  if (command === 'prune' && !/^[1-9]\d{0,2}$/.test(o.keep)) fail('--keep must be an integer 1..999');
  const opts = Object.fromEntries(Object.entries(o).map(([k, v]) => [k.replaceAll('-', '_'), v]));
  if (command === 'restore') {
    const modes = [o['target-time'] !== undefined, o['target-name'] !== undefined, o.latest === true].filter(Boolean).length;
    if (modes !== 1) fail('restore needs exactly one of --target-time, --target-name, --latest');
    if (o['target-time'] !== undefined) {
      if (!ISO.test(o['target-time']) || !Number.isFinite(Date.parse(o['target-time']))) fail('--target-time must be an ISO 8601 instant with Z or offset');
      opts.target_mode = 'time';
    } else if (o['target-name'] !== undefined) {
      if (!POINT.test(o['target-name'])) fail(`--target-name: restore point name must match ${POINT}`);
      opts.target_mode = 'name';
    } else opts.target_mode = 'latest';
  }
  return { command, opts };
}
export function assertRestoreTarget(manifest, target) {
  if (target === manifest.source.container) fail(`refused: a restore never restores over the source container ${target}`);
  if (target === STAGE5_CONTAINER) fail(`refused: the stage 5 instance ${STAGE5_CONTAINER} is never a restore target`);
}

// ---- cluster identity ----
/** First page of a WAL segment (XLogLongPageHeaderData, little endian). */
export function walSegmentHeader(buf) {
  if (buf.length < 40) fail('WAL header too short');
  if ((buf.readUInt16LE(2) & 0x0002) === 0) fail('not the first page of a WAL segment (no long header)');
  return { magic: buf.readUInt16LE(0), timeline: buf.readUInt32LE(4), system_identifier: buf.readBigUInt64LE(24).toString(),
    wal_segment_size: buf.readUInt32LE(32), block_size: buf.readUInt32LE(36) };
}
/** WAL segment file holding `lsn` ('X/Y'), as PostgreSQL names it (XLogFileName). */
export function walFileName(timeline, lsn, segSize) {
  const m = /^([0-9A-F]{1,8})\/([0-9A-F]{1,8})$/i.exec(lsn) ?? fail(`bad LSN ${lsn}`);
  const pos = (BigInt('0x' + m[1]) << 32n) | BigInt('0x' + m[2]), size = BigInt(segSize), perLog = 0x100000000n / size;
  const segno = pos / size, hex = (v) => v.toString(16).toUpperCase().padStart(8, '0');
  return hex(BigInt(timeline)) + hex(segno / perLog) + hex(segno % perLog);
}
/** Identity of a pg_basebackup backup_manifest (version 2, PostgreSQL 17+); the identifier is read as text, not as a JSON number. */
export function backupManifestIdentity(text) {
  const j = JSON.parse(text);
  if (j['PostgreSQL-Backup-Manifest-Version'] !== 2) fail('backup_manifest: version 2 (PostgreSQL 17+) with System-Identifier expected');
  const id = /"System-Identifier"\s*:\s*(\d{1,20})\s*[,}]/.exec(text)?.[1] ?? fail('backup_manifest: System-Identifier missing');
  const r = j['WAL-Ranges']?.[0] ?? fail('backup_manifest: WAL-Ranges missing');
  return { system_identifier: id, timeline: r.Timeline, start_lsn: r['Start-LSN'].toUpperCase(), end_lsn: r['End-LSN'].toUpperCase() };
}
export function assertSameSystem(expected, observed, what) {
  if (!/^\d{1,20}$/.test(String(expected)) || String(expected) !== String(observed))
    fail(`system identifier mismatch (${what}): backup set ${expected}, ${what} ${observed}`);
}

// ---- manifest ----
const safePath = (p) => typeof p === 'string' && p.length <= 512 && !isAbsolute(p) &&
  p.split('/').every((s) => s !== '' && s !== '.' && s !== '..' && /^[A-Za-z0-9._-]+$/.test(s));
function entry(e, what) {
  if (!e || typeof e !== 'object') fail(`${what}: entry expected`);
  if (!safePath(e.path)) fail(`${what}: unsafe path ${e.path}`);
  if (!Number.isSafeInteger(e.bytes) || e.bytes < 0) fail(`${what} ${e.path}: bytes`);
  if (!HEX64.test(e.sha256 ?? '')) fail(`${what} ${e.path}: sha256`);
  return { path: e.path, bytes: e.bytes, sha256: e.sha256 };
}
const SOURCE_KEYS = ['container', 'archive_volume', 'system_identifier', 'server_version', 'timeline', 'wal_segment_size', 'start_wal', 'start_lsn', 'stop_lsn'];
export function validateManifest(m) {
  if (!m || m.schema !== SET_SCHEMA) fail(`manifest schema must be ${SET_SCHEMA}`);
  const allowed = new Set(['schema', 'id', 'created_at', 'source', 'base', 'files', 'keys', 'config', 'timings_ms', 'release']);
  for (const k of Object.keys(m)) if (!allowed.has(k)) fail(`manifest: unexpected field ${k}`);
  if (!/^\d{8}T\d{6}Z-[a-z0-9-]{1,60}$/.test(m.id ?? '')) fail('manifest: id');
  if (!ISO.test(m.created_at ?? '')) fail('manifest: created_at');
  const s = m.source ?? fail('manifest: source');
  for (const k of Object.keys(s)) if (!SOURCE_KEYS.includes(k)) fail(`manifest source: unexpected field ${k}`);
  if (!CONTAINER.test(s.container ?? '') || !CONTAINER.test(s.archive_volume ?? '')) fail('manifest source: container / archive_volume');
  if (!/^\d{1,20}$/.test(s.system_identifier ?? '')) fail('manifest source: system_identifier');
  if (!Number.isSafeInteger(s.timeline) || s.timeline < 1 || !Number.isSafeInteger(s.wal_segment_size)) fail('manifest source: timeline / segment size');
  if (!/^[0-9A-F]{24}$/.test(s.start_wal ?? '')) fail('manifest source: start_wal');
  for (const k of ['start_lsn', 'stop_lsn']) if (!/^[0-9A-F]{1,8}\/[0-9A-F]{1,8}$/.test(s[k] ?? '')) fail(`manifest source: ${k}`);
  if (typeof s.server_version !== 'string' || s.server_version.length > 100) fail('manifest source: server_version');
  if (!Array.isArray(m.base) || m.base.length === 0) fail('manifest: base backup files missing');
  if (!Array.isArray(m.files) || !Array.isArray(m.config)) fail('manifest: files / config lists');
  const keys = m.keys === null ? null : entry(m.keys, 'keys');
  if (keys && !keys.path.endsWith('.sealed')) fail('manifest: keys must be sealed (path *.sealed)');
  const out = { schema: SET_SCHEMA, id: m.id, created_at: m.created_at, source: Object.fromEntries(SOURCE_KEYS.map((k) => [k, s[k]])),
    base: m.base.map((e) => entry(e, 'base')), files: m.files.map((e) => entry(e, 'files')), keys, config: m.config.map((e) => entry(e, 'config')) };
  const all = [...out.base, ...out.files, ...(keys ? [keys] : []), ...out.config].map((e) => e.path);
  if (new Set(all).size !== all.length) fail('manifest: duplicate path');
  if (m.timings_ms !== undefined) {
    if (!m.timings_ms || typeof m.timings_ms !== 'object' || !Object.values(m.timings_ms).every((v) => Number.isSafeInteger(v) && v >= 0)) fail('manifest: timings_ms');
    out.timings_ms = { ...m.timings_ms };
  }
  if (m.release !== undefined) out.release = JSON.parse(JSON.stringify(m.release));
  return out;
}
export function buildManifest(input) { return validateManifest({ schema: SET_SCHEMA, ...input }); }

export function sha256File(path) {
  const h = createHash('sha256'), fd = openSync(path, 'r'), b = Buffer.allocUnsafe(1 << 20);
  try { for (let n; (n = readSync(fd, b, 0, b.length, null)) > 0;) h.update(b.subarray(0, n)); } finally { closeSync(fd); }
  return h.digest('hex');
}
/** Recompute every file the manifest records; all of them must be private regular files of the recorded size and digest. */
export function verifySetFiles(dir, m) {
  let checked = 0, bytes = 0;
  for (const e of [...m.base, ...m.files, ...(m.keys ? [m.keys] : []), ...m.config]) {
    const p = join(dir, e.path), s = lstatSync(p, { throwIfNoEntry: false }) ?? fail(`${e.path}: missing`);
    if (!s.isFile() || s.isSymbolicLink()) fail(`${e.path}: not a regular file`);
    if ((s.mode & 0o077) !== 0) fail(`${e.path} must be 0600 (private), mode ${(s.mode & 0o777).toString(8)}`);
    if (s.size !== e.bytes) fail(`${e.path}: size ${s.size}, manifest ${e.bytes}`);
    if (sha256File(p) !== e.sha256) fail(`${e.path}: sha256 differs from the manifest`);
    checked++; bytes += e.bytes;
  }
  return { checked, bytes };
}

// ---- keys: sealed with a passphrase the operator keeps outside the set ----
const MAGIC = Buffer.from('DYNARS01');
const kdf = (pass, salt) => scryptSync(pass, salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
export function sealSecret(plain, passphrase) {
  const salt = randomBytes(16), iv = randomBytes(12), head = Buffer.concat([MAGIC, salt, iv]);
  const c = createCipheriv('aes-256-gcm', kdf(passphrase, salt), iv);
  c.setAAD(head);
  return Buffer.concat([head, c.update(plain), c.final(), c.getAuthTag()]);
}
export function openSecret(sealed, passphrase) {
  if (sealed.length < 52 || !sealed.subarray(0, 8).equals(MAGIC)) fail('not a sealed recovery key file');
  const salt = sealed.subarray(8, 24), iv = sealed.subarray(24, 36), head = sealed.subarray(0, 36);
  try {
    const d = createDecipheriv('aes-256-gcm', kdf(passphrase, salt), iv);
    d.setAAD(head); d.setAuthTag(sealed.subarray(sealed.length - 16));
    return Buffer.concat([d.update(sealed.subarray(36, sealed.length - 16)), d.final()]);
  } catch { fail('cannot open the sealed keys: wrong passphrase or changed key file'); }
}
export function readPassphraseFile(path) {
  const s = lstatSync(path, { throwIfNoEntry: false }) ?? fail(`passphrase file ${path} does not exist`);
  if (s.isSymbolicLink() || !s.isFile()) fail('passphrase file must be a regular file, not a symlink');
  if ((s.mode & 0o077) !== 0) fail(`passphrase file must be 0600, mode ${(s.mode & 0o777).toString(8)}`);
  if (typeof process.getuid === 'function' && s.uid !== process.getuid()) fail('passphrase file must belong to the operator');
  const v = readFileSync(path, 'utf8').replace(/\r?\n$/, '');
  if (v.length < 12) fail('passphrase must have at least 12 characters');
  return v;
}

// ---- recovery settings (appended to postgresql.auto.conf of the restored data directory) ----
export function recoveryConf(t) {
  let s = `restore_command = '${RESTORE_COMMAND}'\n`;
  if (t.target_mode === 'time') {
    const iso = new Date(t.target_time).toISOString();
    s += `recovery_target_time = '${iso.replace('T', ' ').replace('Z', '+00')}'\nrecovery_target_inclusive = on\n`;
  } else if (t.target_mode === 'name') {
    if (!POINT.test(t.target_name ?? '')) fail(`restore point name must match ${POINT}`);
    s += `recovery_target_name = '${t.target_name}'\n`;
  } else if (t.target_mode !== 'latest') fail('target_mode');
  if (t.target_mode !== 'latest') s += "recovery_target_action = 'promote'\n";
  return s + "recovery_target_timeline = 'latest'\n";
}

// ---- measurements ----
/** acked: commits the writer saw acknowledged; restored_last: newest row present after the restore. */
export function rpoWindow({ acked, restored_last, crash_ms, restored_count }) {
  const last = acked.reduce((a, b) => (b.seq > a.seq ? b : a));
  return { loss_ms: Math.max(0, last.at_ms - restored_last.at_ms), rows_lost: Math.max(0, last.seq - restored_last.seq),
    crash_to_last_restored_ms: crash_ms - restored_last.at_ms, gap_free: restored_count === undefined ? null : restored_count === restored_last.seq,
    // committed and durable, but the acknowledgement had not reached the writer when it was killed
    unacknowledged_commits_restored: Math.max(0, restored_last.seq - last.seq) };
}
export function extrapolate({ measured_bytes, target_bytes, phases }) {
  if (!(measured_bytes > 0) || !(target_bytes > 0)) fail('extrapolate: measured_bytes and target_bytes must be > 0');
  const out = phases.map((p) => {
    const f = p.scales === 'bytes' ? target_bytes / measured_bytes : p.scales === 'wal' ? p.target_wal_bytes / p.wal_bytes : p.scales === 'const' ? 1 : fail(`extrapolate: scales ${p.scales}`);
    return { name: p.name, measured_ms: p.ms, scales: p.scales, ms: Math.round(p.ms * f) };
  });
  return { kind: 'extrapolation', measured_bytes, target_bytes, phases: out, total_ms: out.reduce((n, p) => n + p.ms, 0) };
}
/**
 * Restore drill → full stage 5 dataset. Clearly an extrapolation (docs/scale/RECOVERY-DRILL-20261027.md section 7):
 * size-bound phases scale with the cluster size (default 20 GiB), WAL replay with the WAL since the last base backup
 * (default 100 GB) at the measured replay throughput (section 4: 3 786 543 272 B in 11 963 ms), the release start at the
 * profile's cold-start limit (180 s), the guards with a ×4 margin, the queue drain as measured.
 */
export function drillExtrapolation(r, env = {}) {
  const p = r.phases_ms, v = r.verify, n = (k, d) => Number(env[k] ?? d);
  return extrapolate({ measured_bytes: r.source_db_bytes, target_bytes: n('DRILL_TARGET_BYTES', 20 * 1024 ** 3), phases: [
    { name: 'verify_set', ms: p.verify_set_ms, scales: 'bytes' }, { name: 'base_restore', ms: p.base_restore_ms, scales: 'bytes' },
    { name: 'wal_replay', ms: n('DRILL_REPLAY_MS', 11963), scales: 'wal', wal_bytes: n('DRILL_REPLAY_WAL_BYTES', 3786543272),
      target_wal_bytes: n('DRILL_TARGET_WAL_BYTES', 100e9) },
    { name: 'files_keys_config_checks', ms: p.files_keys_config_ms + p.checks_ms, scales: 'const' },
    { name: 'service_start_profile_limit', ms: n('DRILL_SERVICE_START_MS', 180000), scales: 'const' },
    { name: 'guards_x4', ms: 4 * v.guards.ms, scales: 'const' },
    { name: 'queue_drain', ms: v.drain_ms, scales: 'const' }] });
}
export function prunePlan(sets, keep) {
  if (!(keep >= 1)) fail('prune: keep at least one base backup');
  const sorted = [...sets].sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  const kept = sorted.slice(0, keep);
  return { keep: kept.map((s) => s.id), drop: sorted.slice(keep).map((s) => s.id), wal_keep_from: kept[kept.length - 1].source.start_wal };
}
