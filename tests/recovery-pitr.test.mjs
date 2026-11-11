// Pure parts of the physical backup / PITR tooling (tools/recovery/pitr-lib.mjs).
// No Docker, no database. Run: node --test tests/recovery-pitr.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  parseCli, walSegmentHeader, assertSameSystem, assertRestoreTarget, validateManifest, buildManifest,
  verifySetFiles, walFileName, backupManifestIdentity, drillExtrapolation, sealSecret, openSecret, readPassphraseFile, recoveryConf, rpoWindow, extrapolate, prunePlan,
} from '../tools/recovery/pitr-lib.mjs';

const sha = (b) => createHash('sha256').update(b).digest('hex');
const SYSID = '7700762086550167594';
function tmp() { const d = mkdtempSync(join(tmpdir(), 'pitr-')); return { d, done: () => rmSync(d, { recursive: true, force: true }) }; }
function manifest(over = {}) {
  return buildManifest({
    id: '20261027T040000Z-dyna-scale-pg18', created_at: '2026-10-27T04:00:00.000Z',
    source: { container: 'dyna-scale-pg18', archive_volume: 'dyna-scale-pg18-wal-archive', system_identifier: SYSID, server_version: '18.4',
      timeline: 1, wal_segment_size: 16777216, start_wal: '00000001000000000000002C', start_lsn: '0/2C000028', stop_lsn: '0/2C000158' },
    base: [{ path: 'base/base.tar.zst', bytes: 3, sha256: sha('abc') }],
    files: [{ path: 'files/product-images/0b6db542-ba63-4a94-b6fb-3c088e4a4aba', bytes: 1, sha256: sha('x') }],
    keys: { path: 'keys/local-config.json.sealed', bytes: 10, sha256: 'a'.repeat(64) },
    config: [{ path: 'config/postgresql.scale.conf', bytes: 2, sha256: 'b'.repeat(64) }],
    ...over,
  });
}

// ---- argument validation ----
test('restore needs exactly one target: time, restore point name or latest', () => {
  const base = ['restore', '--set', '/abs/set', '--target', 'dyna-recovery-t1'];
  assert.equal(parseCli([...base, '--latest']).opts.target_mode, 'latest');
  const t = parseCli([...base, '--target-time', '2026-10-27T04:05:06.123Z']).opts;
  assert.equal(t.target_mode, 'time'); assert.equal(t.target_time, '2026-10-27T04:05:06.123Z');
  assert.equal(parseCli([...base, '--target-name', 'before_queue_drill']).opts.target_name, 'before_queue_drill');
  assert.throws(() => parseCli(base), /exactly one of --target-time, --target-name, --latest/);
  assert.throws(() => parseCli([...base, '--latest', '--target-name', 'x']), /exactly one/);
  assert.throws(() => parseCli([...base, '--target-time', '27.10.2026 04:05']), /ISO 8601 instant with Z or offset/);
  assert.throws(() => parseCli([...base, '--target-time', '2026-10-27T04:05:06']), /ISO 8601 instant with Z or offset/);
  assert.throws(() => parseCli([...base, '--target-name', "x'; DROP"]), /restore point name/);
});

test('names, paths and unknown options are refused before anything runs', () => {
  assert.throws(() => parseCli(['base-backup', '--source', 'postgres', '--sets', '/abs']), /container name/);
  assert.throws(() => parseCli(['base-backup', '--source', 'dyna-scale-pg18', '--sets', 'relative/dir']), /absolute/);
  assert.throws(() => parseCli(['base-backup', '--source', 'dyna-scale-pg18', '--sets', '/abs/../etc']), /normalized/);
  assert.throws(() => parseCli(['base-backup', '--source', 'dyna-scale-pg18', '--sets', '/abs', '--bogus', '1']), /unknown option --bogus/);
  assert.throws(() => parseCli(['base-backup', '--source', 'dyna-scale-pg18']), /--sets is required/);
  assert.throws(() => parseCli(['base-backup', '--source', 'dyna-scale-pg18', '--sets', '/abs', '--passphrase', 'secret']), /unknown option --passphrase/,
    'the passphrase never travels on argv');
  assert.throws(() => parseCli(['explode']), /unknown command/);
  const ok = parseCli(['base-backup', '--source', 'dyna-scale-pg18', '--sets', '/abs/sets', '--files', '/abs/img', '--keys', '/abs/local-config.json',
    '--config', '/abs/a.conf', '--config', '/abs/b.json', '--passphrase-file', '/abs/pass']);
  assert.deepEqual(ok.opts.config, ['/abs/a.conf', '/abs/b.json']);
  assert.equal(ok.opts.passphrase_file, '/abs/pass');
  assert.throws(() => parseCli(['base-backup', '--source', 'dyna-scale-pg18', '--sets', '/abs', '--keys', '/abs/local-config.json']),
    /--keys needs --passphrase-file/);
  assert.deepEqual(parseCli(['files-sync', '--files', '/abs/img', '--mirror', '/abs/mirror']).opts, { config: [], files: '/abs/img', mirror: '/abs/mirror' });
  assert.equal(parseCli(['restore', '--set', '/abs/s', '--target', 'dyna-recovery-t1', '--latest', '--files-mirror', '/abs/mirror']).opts.files_mirror, '/abs/mirror');
});

test('a restore never targets the source container or the stage 5 instance', () => {
  const m = manifest();
  assert.throws(() => assertRestoreTarget(m, 'dyna-scale-pg18'), /never restores over the source container/);
  assert.throws(() => assertRestoreTarget({ ...m, source: { ...m.source, container: 'dyna-recovery-src' } }, 'dyna-scale-pg18'), /stage 5 instance/);
  assert.doesNotThrow(() => assertRestoreTarget(m, 'dyna-recovery-t1'));
});

// ---- cluster identity ----
function walHeader({ magic = 0xd118, info = 0x0002, tli = 1, sysid = BigInt(SYSID), seg = 16777216, blck = 8192 } = {}) {
  const b = Buffer.alloc(40);
  b.writeUInt16LE(magic, 0); b.writeUInt16LE(info, 2); b.writeUInt32LE(tli, 4); b.writeBigUInt64LE(0x2c000000n, 8);
  b.writeBigUInt64LE(sysid, 24); b.writeUInt32LE(seg, 32); b.writeUInt32LE(blck, 36);
  return b;
}
test('the WAL long page header yields the system identifier, timeline and segment size', () => {
  const h = walSegmentHeader(walHeader());
  assert.deepEqual(h, { magic: 0xd118, timeline: 1, system_identifier: SYSID, wal_segment_size: 16777216, block_size: 8192 });
  assert.throws(() => walSegmentHeader(walHeader({ info: 0 })), /not the first page of a WAL segment/);
  assert.throws(() => walSegmentHeader(Buffer.alloc(10)), /short/);
});

test('the WAL file name of an LSN follows timeline / log / segment numbering', () => {
  assert.equal(walFileName(1, '0/2C000028', 16777216), '00000001000000000000002C');
  assert.equal(walFileName(2, '1/A0000000', 16777216), '0000000200000001000000A0');
  assert.equal(walFileName(3, '12/FF123456', 1073741824), '000000030000001200000003');
  assert.throws(() => walFileName(1, 'zz', 16777216), /LSN/);
});

test('the backup_manifest system identifier is read exactly (beyond 2^53)', () => {
  const text = `{ "PostgreSQL-Backup-Manifest-Version": 2,\n"System-Identifier": ${SYSID},\n"Files": [],\n` +
    `"WAL-Ranges": [\n{ "Timeline": 1, "Start-LSN": "0/2e000028", "End-LSN": "0/2e000158" }\n] }`;
  assert.deepEqual(backupManifestIdentity(text), { system_identifier: SYSID, timeline: 1, start_lsn: '0/2E000028', end_lsn: '0/2E000158' });
  assert.throws(() => backupManifestIdentity('{"PostgreSQL-Backup-Manifest-Version": 1, "Files": []}'), /version 2/);
});

test('a WAL archive or restored cluster of another system identifier is refused', () => {
  assert.doesNotThrow(() => assertSameSystem(SYSID, SYSID, 'WAL archive'));
  assert.throws(() => assertSameSystem(SYSID, '7700762086550167595', 'WAL archive'),
    /system identifier mismatch \(WAL archive\): backup set 7700762086550167594, WAL archive 7700762086550167595/);
  assert.throws(() => assertSameSystem(SYSID, '', 'restored cluster'), /system identifier mismatch/);
});

// ---- manifest ----
test('manifest round-trips and rejects unsafe paths, bad digests and unsealed keys', () => {
  const m = manifest();
  assert.equal(m.schema, 'dyna-recovery-set/v1');
  assert.deepEqual(validateManifest(JSON.parse(JSON.stringify(m))), m);
  assert.throws(() => validateManifest({ ...m, schema: 'other' }), /schema/);
  assert.throws(() => manifest({ files: [{ path: '../escape', bytes: 1, sha256: sha('x') }] }), /unsafe path/);
  assert.throws(() => manifest({ files: [{ path: '/etc/passwd', bytes: 1, sha256: sha('x') }] }), /unsafe path/);
  assert.throws(() => manifest({ base: [{ path: 'base/base.tar.zst', bytes: 3, sha256: 'xyz' }] }), /sha256/);
  assert.throws(() => manifest({ keys: { path: 'keys/local-config.json', bytes: 10, sha256: 'a'.repeat(64) } }), /keys must be sealed/);
  assert.throws(() => manifest({ source: { ...m.source, system_identifier: '12ab' } }), /system_identifier/);
  assert.throws(() => manifest({ base: [] }), /base backup/);
  assert.throws(() => validateManifest({ ...m, extra: 1 }), /unexpected field extra/);
});

test('set verification recomputes every recorded file and refuses a changed one or a group-readable key', () => {
  const t = tmp();
  try {
    for (const [p, body] of [['base/base.tar.zst', 'abc'], ['files/product-images/0b6db542-ba63-4a94-b6fb-3c088e4a4aba', 'x'],
      ['keys/local-config.json.sealed', '0123456789'], ['config/postgresql.scale.conf', 'ok']]) {
      mkdirSync(join(t.d, p, '..'), { recursive: true }); writeFileSync(join(t.d, p), body, { mode: 0o600 });
    }
    const m = manifest({ keys: { path: 'keys/local-config.json.sealed', bytes: 10, sha256: sha('0123456789') },
      config: [{ path: 'config/postgresql.scale.conf', bytes: 2, sha256: sha('ok') }] });
    assert.deepEqual(verifySetFiles(t.d, m), { checked: 4, bytes: 16 });
    chmodSync(join(t.d, 'keys/local-config.json.sealed'), 0o640);
    assert.throws(() => verifySetFiles(t.d, m), /keys\/local-config.json.sealed must be 0600/);
    chmodSync(join(t.d, 'keys/local-config.json.sealed'), 0o600);
    writeFileSync(join(t.d, 'config/postgresql.scale.conf'), 'OK');
    assert.throws(() => verifySetFiles(t.d, m), /config\/postgresql.scale.conf: sha256 differs/);
  } finally { t.done(); }
});

// ---- keys ----
test('sealed keys open only with the same passphrase and refuse tampering', () => {
  const secret = Buffer.from(JSON.stringify({ dbPassword: 'p', encryptionKey: 'e'.repeat(64) }));
  const sealed = sealSecret(secret, 'correct horse battery staple');
  assert(!sealed.includes(secret), 'ciphertext does not contain the plaintext');
  assert.deepEqual(openSecret(sealed, 'correct horse battery staple'), secret);
  assert.throws(() => openSecret(sealed, 'wrong passphrase value'), /wrong passphrase or changed key file/);
  const bad = Buffer.from(sealed); bad[bad.length - 20] ^= 1;
  assert.throws(() => openSecret(bad, 'correct horse battery staple'), /wrong passphrase or changed key file/);
  assert.throws(() => openSecret(Buffer.from('nope'), 'x'.repeat(12)), /not a sealed recovery key file/);
});

test('the passphrase comes only from a private regular file of the operator', () => {
  const t = tmp();
  try {
    const f = join(t.d, 'pass');
    writeFileSync(f, 'correct horse battery staple\n', { mode: 0o600 });
    assert.equal(readPassphraseFile(f), 'correct horse battery staple');
    chmodSync(f, 0o644);
    assert.throws(() => readPassphraseFile(f), /passphrase file must be 0600/);
    chmodSync(f, 0o600);
    const link = join(t.d, 'link'); symlinkSync(f, link);
    assert.throws(() => readPassphraseFile(link), /regular file, not a symlink/);
    writeFileSync(join(t.d, 'short'), 'short\n', { mode: 0o600 });
    assert.throws(() => readPassphraseFile(join(t.d, 'short')), /at least 12 characters/);
    assert.throws(() => readPassphraseFile(join(t.d, 'missing')), /passphrase file/);
  } finally { t.done(); }
});

// ---- recovery settings ----
test('recovery settings name the archive script and one target, promote at the end', () => {
  assert.equal(recoveryConf({ target_mode: 'time', target_time: '2026-10-27T04:05:06.123Z' }),
    "restore_command = '/usr/local/bin/dyna-wal-restore /wal-archive-src %f %p'\n" +
    "recovery_target_time = '2026-10-27 04:05:06.123+00'\nrecovery_target_inclusive = on\nrecovery_target_action = 'promote'\n" +
    "recovery_target_timeline = 'latest'\n");
  assert.match(recoveryConf({ target_mode: 'name', target_name: 'before_drill' }), /recovery_target_name = 'before_drill'/);
  const latest = recoveryConf({ target_mode: 'latest' });
  assert.doesNotMatch(latest, /recovery_target_(time|name|action) =/);
  assert.match(latest, /restore_command/);
  assert.throws(() => recoveryConf({ target_mode: 'name', target_name: "a'b" }), /restore point name/);
});

// ---- measurements ----
test('data loss window = last acknowledged commit minus last commit present after restore', () => {
  const r = rpoWindow({ acked: [{ seq: 1, at_ms: 1000 }, { seq: 2, at_ms: 2000 }, { seq: 3, at_ms: 61000 }], restored_last: { seq: 2, at_ms: 2000 },
    crash_ms: 61500, restored_count: 2 });
  assert.deepEqual(r, { loss_ms: 59000, rows_lost: 1, crash_to_last_restored_ms: 59500, gap_free: true, unacknowledged_commits_restored: 0 });
  assert.equal(rpoWindow({ acked: [{ seq: 1, at_ms: 1 }, { seq: 2, at_ms: 2 }], restored_last: { seq: 2, at_ms: 2 }, crash_ms: 3 }).loss_ms, 0);
  // A commit can be durable before its acknowledgement reaches the writer (killed in between): not a loss.
  assert.deepEqual(rpoWindow({ acked: [{ seq: 1, at_ms: 1 }], restored_last: { seq: 2, at_ms: 9 }, crash_ms: 10, restored_count: 2 }),
    { loss_ms: 0, rows_lost: 0, crash_to_last_restored_ms: 1, gap_free: true, unacknowledged_commits_restored: 1 });
});

test('extrapolation scales only size-dependent phases and is labelled as such', () => {
  const e = extrapolate({ measured_bytes: 1e9, target_bytes: 2e10,
    phases: [{ name: 'base_restore', ms: 30000, scales: 'bytes' }, { name: 'app_start', ms: 140000, scales: 'const' },
      { name: 'wal_replay', ms: 5000, scales: 'wal', wal_bytes: 1e8, target_wal_bytes: 4e8 }] });
  assert.equal(e.kind, 'extrapolation');
  assert.deepEqual(e.phases.map((p) => [p.name, p.ms]), [['base_restore', 600000], ['app_start', 140000], ['wal_replay', 20000]]);
  assert.equal(e.total_ms, 760000);
  assert.throws(() => extrapolate({ measured_bytes: 0, target_bytes: 1, phases: [] }), /measured_bytes/);
});

test('the drill extrapolation uses the documented assumptions and can be overridden', () => {
  const r = { source_db_bytes: 1176897366, phases_ms: { verify_set_ms: 1372, base_restore_ms: 2071, files_keys_config_ms: 50, checks_ms: 100 },
    verify: { guards: { ms: 15800 }, drain_ms: 63751 } };
  const e = drillExtrapolation(r, {});
  assert.equal(e.kind, 'extrapolation');
  assert.deepEqual(e.phases.map((p) => [p.name, p.ms]), [['verify_set', 25035], ['base_restore', 37790], ['wal_replay', 315935],
    ['files_keys_config_checks', 150], ['service_start_profile_limit', 180000], ['guards_x4', 63200], ['queue_drain', 63751]]);
  assert.equal(e.total_ms, 685861);
  assert.equal(drillExtrapolation(r, { DRILL_TARGET_WAL_BYTES: '0' }).phases[2].ms, 0);
});

test('pruning keeps the newest N sets and the WAL from the oldest kept start segment', () => {
  const sets = [['20261025T000000Z-a', '000000010000000000000010'], ['20261027T000000Z-a', '00000001000000000000002C'],
    ['20261026T000000Z-a', '000000010000000000000020']].map(([id, w]) => ({ id, source: { start_wal: w } }));
  assert.deepEqual(prunePlan(sets, 2), { keep: ['20261027T000000Z-a', '20261026T000000Z-a'], drop: ['20261025T000000Z-a'],
    wal_keep_from: '000000010000000000000020' });
  assert.throws(() => prunePlan(sets, 0), /keep at least one/);
});
