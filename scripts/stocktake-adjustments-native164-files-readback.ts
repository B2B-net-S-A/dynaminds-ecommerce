/** ROOT ONLY, SOURCE AUTHORED; no execution by author.
 * Invoke absolute WT source with primary app cwd after native/recovery gates.
 * Requires DYNA_LOCAL_CONFIG_PATH=<primary>/.local.json, DYNA_WORKER_DISABLED=true,
 * APP_REVISION=QA_EXPECTED_REVISION=39baa5a6a7ebdeba00e7ca59e7669c0982bdb8ec,
 * QA164_FILES_CONFIRM=READ_ONLY_ORIGINAL_2361_FILES_EXACT,
 * QA164_ORIGINAL_FILES_BEFORE_SHA256=071922...eb6c5, QA164_CONFIG_SHA256=9a2c...b660,
 * QA164_FILES_SOURCE_SHA256=<this source SHA256>.
 * Only pinned147 manifest files are read; no rediscovery/rebase/new exclusions.
 * One primary health GET; no DB/login/POST/backup/restore/worker/provider.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

type Pin = { sha256: string; mode: number; size: number };
const ROOT = '<workspace>/app';
const CONFIG = resolve(ROOT, '.local.json');
const BEFORE = resolve(ROOT, 'data/return-destinations-native162-before.json');
const BEFORE_SHA = '0719220227136bac1f59ef240d8d3e3df08836fdd205dc5281b8c01ba31eb6c5';
const CONFIG_SHA = '9a2c81811d1ffdb6c52aabdd77dddf3ac1975bd8cc2c2d2957882b338dd7b660';
const REVISION = '39baa5a6a7ebdeba00e7ca59e7669c0982bdb8ec';
const SOURCE = fileURLToPath(import.meta.url);
const INTENT = resolve(ROOT, 'data/stocktake-adjustments-native164-files-intent.json');
const OUTPUT = resolve(ROOT, 'data/stocktake-adjustments-native164-files-readback.json');
const PUBLIC = resolve(ROOT, 'docs/stocktake-adjustments-native164-files-readback.json');
const exclusions = [
  { path: 'data/return-destinations-native161-runtime-dev.private.log', reason: 'Active native runtime stdout/stderr can grow during reads and restart.' },
  { path: 'data/return-destinations-native162-runtime-dev.private.log', reason: 'Planned native restart stdout/stderr is created and grows during restart.' },
];
const sha = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');
let step = 'preflight';
let filePathSha256: string | null = null;

async function directory(path: string) {
  const s = await lstat(path); assert(s.isDirectory() && !s.isSymbolicLink());
  assert.equal(await realpath(path), path);
}
async function absent(path: string) {
  try { await lstat(path); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; throw e; }
  throw Error('Exclusive custody already exists');
}
async function wx(path: string, value: unknown) {
  await directory(dirname(path)); const bytes = JSON.stringify(value, null, 2) + '\n';
  assert(Buffer.byteLength(bytes) <= 2 * 1024 * 1024);
  const f = await open(path, 'wx', 0o600);
  try { await f.writeFile(bytes); await f.sync(); } finally { await f.close(); }
  const d = await open(dirname(path), 'r'); try { await d.sync(); } finally { await d.close(); }
  return sha(bytes);
}
async function privateRead(path: string, max: number) {
  const s = await lstat(path); assert(s.isFile() && !s.isSymbolicLink());
  assert.equal(s.mode & 0o777, 0o600); assert(s.size > 0 && s.size <= max);
  const f = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const stable = (n: typeof s) => { assert(n.isFile()); for (const k of ['dev', 'ino', 'mode', 'size', 'mtimeMs'] as const) assert.equal(n[k], s[k]); };
  try { stable(await f.stat()); const b = await f.readFile(); assert.equal(b.length, s.size); stable(await f.stat()); stable(await lstat(path)); return b; }
  finally { await f.close(); }
}
async function stableHash(path: string): Promise<Pin> {
  const s = await lstat(path); assert(s.isFile() && !s.isSymbolicLink());
  assert(Number.isSafeInteger(s.size) && s.size >= 0);
  const stable = (n: typeof s) => { assert(n.isFile() && !n.isSymbolicLink()); for (const k of ['dev', 'ino', 'mode', 'size', 'mtimeMs'] as const) assert.equal(n[k], s[k]); };
  const f = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    stable(await f.stat()); const hash = createHash('sha256'); let bytes = 0;
    for await (const chunk of createReadStream(path, { fd: f.fd, autoClose: false })) { hash.update(chunk); bytes += chunk.length; }
    assert.equal(bytes, s.size); stable(await f.stat()); stable(await lstat(path));
    return { sha256: hash.digest('hex'), mode: s.mode & 0o777, size: s.size };
  } finally { await f.close(); }
}
async function pinnedPath(key: string) {
  assert(key === '.local.json' || key.startsWith('data/'));
  const segments = key.split('/'); assert(segments.every(v => v.length > 0 && v !== '.' && v !== '..' && !v.includes('\\') && !v.includes('\0')));
  const path = resolve(ROOT, key); assert(path.startsWith(ROOT + '/'));
  // O_NOFOLLOW checks the leaf. realpath checks every ancestor without allowing
  // a directory symlink to redirect a pinned path outside the original root.
  await directory(dirname(path)); assert.equal(await realpath(path), path);
  return path;
}
async function health() {
  const r = await fetch('http://127.0.0.1:4100/api/health', { method: 'GET', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15000) });
  assert.equal(r.status, 200); assert(r.body); const reader = r.body.getReader(); const parts: Buffer[] = []; let size = 0;
  try { for (;;) { const v = await reader.read(); if (v.done) break; size += v.value.length; assert(size <= 65536); parts.push(Buffer.from(v.value)); } }
  finally { await reader.cancel().catch(() => undefined); }
  const h = JSON.parse(Buffer.concat(parts).toString('utf8'));
  assert.equal(h.status, 'ok'); assert.equal(h.mode, 'local'); assert.equal(h.restore_preview, false);
  assert.equal(h.background_workers_enabled, false); assert.equal(h.revision, REVISION);
  assert.equal(h.schema_revision, '149_stocktake_adjustments'); assert.equal(h.stocktake_adjustments_available, true);
  return { revision: h.revision as string, schema_revision: h.schema_revision as string };
}
async function main() {
  assert.equal(await realpath(process.cwd()), ROOT); await directory(ROOT); await directory(resolve(ROOT, 'data')); await directory(resolve(ROOT, 'docs'));
  assert.equal(process.env.DYNA_TEST, undefined); assert.equal(process.env.DATABASE_URL, undefined);
  assert.equal(process.env.DYNA_LOCAL_CONFIG_PATH, CONFIG); assert.equal(process.env.DYNA_WORKER_DISABLED, 'true');
  assert.equal(process.env.APP_REVISION, REVISION); assert.equal(process.env.QA_EXPECTED_REVISION, REVISION);
  assert.equal(process.env.QA164_FILES_CONFIRM, 'READ_ONLY_ORIGINAL_2361_FILES_EXACT');
  assert.equal(process.env.QA164_ORIGINAL_FILES_BEFORE_SHA256, BEFORE_SHA); assert.equal(process.env.QA164_CONFIG_SHA256, CONFIG_SHA);
  assert.match(process.env.QA164_FILES_SOURCE_SHA256 ?? '', /^[a-f0-9]{64}$/);
  const sourcePin = await stableHash(SOURCE); assert(sourcePin.size < 1024 * 1024); assert.equal(sourcePin.sha256, process.env.QA164_FILES_SOURCE_SHA256);
  await absent(INTENT); await absent(OUTPUT); await absent(PUBLIC);
  const beforeBytes = await privateRead(BEFORE, 512 * 1024 * 1024); assert.equal(sha(beforeBytes), BEFORE_SHA);
  const before = JSON.parse(beforeBytes.toString('utf8'));
  assert.equal(before.stage, 162); assert.equal(before.phase, 'before'); assert.equal(before.status, 'READ_ONLY_CAPTURED');
  assert.equal(before.schema, '147_return_destination_statuses'); assert.equal(before.revision, 'ca1f3e68221e8acdca01a77db0f2ea605d2e009a');
  assert.deepEqual(before.excluded_live_files, exclusions);
  const files: Record<string, Pin> = before.capture?.files; assert(files && typeof files === 'object' && !Array.isArray(files));
  const keys = Object.keys(files).sort(); assert.equal(keys.length, 2361); assert(Object.hasOwn(files, '.local.json'));
  let expectedBytes = 0;
  for (const key of keys) {
    const pin = files[key]; assert.deepEqual(Object.keys(pin).sort(), ['mode', 'sha256', 'size']); assert.match(pin.sha256, /^[a-f0-9]{64}$/);
    assert(Number.isInteger(pin.mode) && pin.mode >= 0 && pin.mode <= 0o777); assert(Number.isSafeInteger(pin.size) && pin.size >= 0);
    assert(!exclusions.some(x => x.path === key)); expectedBytes += pin.size; assert(Number.isSafeInteger(expectedBytes));
    await pinnedPath(key);
  }
  assert.equal(expectedBytes, 6689546043); assert.equal(files['.local.json'].sha256, CONFIG_SHA); assert.equal(files['.local.json'].mode, 0o600);
  assert.equal(sha(await privateRead(CONFIG, 65536)), CONFIG_SHA);
  await wx(INTENT, { stage: 164, status: 'READ_ONLY_FILE_VERIFICATION_INTENT', original_before_sha256: BEFORE_SHA, source_sha256: sourcePin.sha256, config_sha256: CONFIG_SHA, expected_revision: REVISION, expected_files: keys.length, excluded_live_files: exclusions });
  step = 'original-pinned-files';
  for (const key of keys) { filePathSha256 = sha(key); assert.deepEqual(await stableHash(await pinnedPath(key)), files[key]); }
  filePathSha256 = null; step = 'final-custody';
  assert.equal(sha(await privateRead(BEFORE, 512 * 1024 * 1024)), BEFORE_SHA);
  assert.equal(sha(await privateRead(CONFIG, 65536)), CONFIG_SHA); assert.deepEqual(await stableHash(SOURCE), sourcePin);
  const runtime = await health(); assert.equal(sha(await privateRead(CONFIG, 65536)), CONFIG_SHA);
  assert.equal(sha(await privateRead(BEFORE, 512 * 1024 * 1024)), BEFORE_SHA); assert.deepEqual(await stableHash(SOURCE), sourcePin);
  const report = { stage: 164, status: 'ORIGINAL_PINNED_FILE_CUSTODY164_PASS', runtime_revision: runtime.revision, schema_revision: runtime.schema_revision,
    original_manifest_schema: before.schema, migration_before_sha256: BEFORE_SHA, source_sha256: sourcePin.sha256, config_sha256: CONFIG_SHA,
    original_pinned_files: keys.length, original_files_size: expectedBytes, all_original_pinned_bytes_mode_size_exact: true,
    config_included: true, nofollow_and_stability_checked: true, baseline_rebased: false, new_files_outside_original_baseline_included: false,
    excluded_live_files: exclusions, database_rows_verified_here: false, provider_verified: false, full_goal_complete: false, health_gets: 1, mutations: 0 };
  step = 'exclusive-output'; const privateSha = await wx(OUTPUT, report); await wx(PUBLIC, { ...report, private_sha256: privateSha });
  console.log(JSON.stringify({ ...report, private_sha256: privateSha }));
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { await main(); }
  catch (e) {
    const frame = e instanceof Error ? e.stack?.match(/stocktake-adjustments-native164-files-readback\.ts:(\d+):(\d+)/) : undefined;
    console.log(JSON.stringify({ stage: 164, status: 'FAIL', step, code: (e as { code?: string }).code === 'ERR_ASSERTION' ? 'ERR_ASSERTION' : 'FILE_CUSTODY_FAILURE',
      source_line: frame ? Number(frame[1]) : null, source_column: frame ? Number(frame[2]) : null, file_path_sha256: filePathSha256 }));
    process.exitCode = 1;
  }
}
