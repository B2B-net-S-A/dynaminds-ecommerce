/** Explicit local host bridge. Default file sink is evidence of saved bytes, never printed paper. */
import { constants } from 'node:fs';
import { open, lstat, mkdir, realpath, rename, unlink, link } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { setTimeout as pause } from 'node:timers/promises';
import { z } from 'zod';
import {
  PRINT_BRIDGE_API_ORIGIN, PRINT_BRIDGE_MAX_BYTES, printBridgeConfig, printBridgeMode,
  printBridgeFileName, verifyPrintBridgeBytes, printBridgeCupsArgs, printBridgeCupsReference,
  printBridgeJournalDecision, printBridgeSafeFailure,
  type PrintBridgeConfig, type PrintBridgeMode,
} from '../server/print-bridge-values';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const controlRoot = join(root, 'data', 'print-bridge');
let base = '', currentPath = '', lockPath = '';
const uuid = z.uuid().transform((v) => v.toLowerCase());
const version = z.string().regex(/^[1-9][0-9]{0,18}$/).refine((v) =>
  /^[1-9][0-9]{0,18}$/.test(v) && BigInt(v) <= 9223372036854775807n);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const claimBody = z.strictObject({ client_key: uuid, version, lease_token: uuid });
const ackBody = z.strictObject({
  client_key: uuid, version, lease_token: uuid,
  result: z.enum(['file_saved', 'spool_submitted']), content_sha256: hash,
  artifact_name: z.string().max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/).optional(),
  spool_job_id: z.string().max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/).optional(),
});
const jobShape = z.object({ id: uuid, printer_id: uuid, version,
  state: z.string(), lease_expires_at: z.string().nullable().optional(),
  content_sha256: hash, content_bytes: z.number().int().min(1).max(PRINT_BRIDGE_MAX_BYTES),
  format: z.enum(['pdf','zpl']), copies: z.number().int().min(1).max(10),
});
const contentShape = z.object({
  job_id: uuid, version, format: z.enum(['pdf','zpl']), copies: z.number().int().min(1).max(10),
  content_sha256: hash, content_bytes: z.number().int().min(1).max(PRINT_BRIDGE_MAX_BYTES),
  content_base64: z.string().max(Math.ceil(PRINT_BRIDGE_MAX_BYTES / 3) * 4),
  lease_expires_at: z.string(),
  printer_snapshot: z.object({ id: uuid, version, name: z.string(), station_id: z.string().nullable(),
    format: z.enum(['pdf','zpl']), output_mode: z.enum(['file','cups']), cups_queue: z.string().nullable(), enabled: z.boolean() }),
});
type Content = z.infer<typeof contentShape>;
const journalShape = z.strictObject({
  journal_version: z.literal(1), state: z.enum(['claim_intent','claimed','dispatch_intent','ack_intent','complete','empty','reconciled']),
  config: printBridgeConfig, job_id: uuid, claim: claimBody,
  job_version: version.optional(), content: contentShape.optional(), ack: ackBody.optional(),
  saved_at: z.string(),
});
type Journal = z.infer<typeof journalShape>;
let stopped = false;
const shutdown = new AbortController();
const stop = () => { stopped = true; shutdown.abort(); };

function ensure(value: unknown, label: string): asserts value { if (!value) throw new Error(label); }
function owned(stat: Awaited<ReturnType<typeof lstat>>) {
  ensure(typeof process.getuid === 'function' && stat.uid === process.getuid(), 'BRIDGE_OWNER_INVALID');
}
async function checkDirectory(path: string, privateDirectory = false) {
  const stat = await lstat(path); owned(stat);
  ensure(stat.isDirectory() && !stat.isSymbolicLink() && (stat.mode & 0o022) === 0, 'BRIDGE_DIRECTORY_INVALID');
  if (privateDirectory) ensure((stat.mode & 0o777) === 0o700, 'BRIDGE_DIRECTORY_NOT_PRIVATE');
  ensure(await realpath(path) === path, 'BRIDGE_DIRECTORY_ALIAS');
}
async function syncDirectory() {
  const handle = await open(base, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}
async function readPrivate(path: string, max = 4 * 1024 * 1024) {
  const stat = await lstat(path); owned(stat);
  ensure(stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o777) === 0o600 && stat.nlink === 1 && stat.size <= max,
    'BRIDGE_PRIVATE_FILE_INVALID');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    ensure(opened.ino === stat.ino && opened.dev === stat.dev, 'BRIDGE_PRIVATE_FILE_CHANGED');
    return await handle.readFile('utf8');
  } finally { await handle.close(); }
}
async function absent(path: string) {
  try { await lstat(path); return false; }
  catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return true; throw err; }
}
async function newPrivate(path: string, data: string | Uint8Array) {
  await checkDirectory(dirname(path), true);
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
  await syncDirectory();
}
async function save(journal: Journal, initial = false) {
  journal.saved_at = new Date().toISOString();
  journalShape.parse(journal);
  if (initial) return newPrivate(currentPath, JSON.stringify(journal));
  await readPrivate(currentPath);
  const temporary = join(base, `.transition-${randomUUID()}.json`);
  await newPrivate(temporary, JSON.stringify(journal));
  await rename(temporary, currentPath); await syncDirectory();
}
async function archive(journal: Journal) {
  ensure(['complete','empty','reconciled'].includes(journal.state), 'BRIDGE_UNRESOLVED_JOURNAL');
  await readPrivate(currentPath);
  // Exclusive link reserves the archive name; no historical journal can be overwritten.
  await link(currentPath, join(base, `completed-${journal.claim.client_key}.json`));
  await unlink(currentPath); await syncDirectory();
}
async function limitedJson(response: Response, limit = 3 * 1024 * 1024) {
  ensure(response.body, 'BRIDGE_HTTP_BODY_MISSING');
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength; ensure(size <= limit, 'BRIDGE_HTTP_BODY_LIMIT'); chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
}
async function request(config: PrintBridgeConfig, path: string, method = 'GET', body?: unknown, lease?: string) {
  ensure(/^\/print-jobs\/(?:jobs(?:\?[^#]*|\/[a-f0-9-]+(?:\/(?:claim|ack|content))?)?|options)$/.test(path), 'BRIDGE_ROUTE_INVALID');
  const headers: Record<string,string> = { 'X-Workspace-ID': config.tenant_id, 'Cache-Control': 'no-store' };
  if (config.api_token) headers.Authorization = `Bearer ${config.api_token}`;
  else headers.Cookie = config.cookie!;
  if (lease) headers['X-Print-Lease'] = uuid.parse(lease);
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(PRINT_BRIDGE_API_ORIGIN + (config.api_token ? '/api/v1' : '/api') + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error',
    signal: AbortSignal.any([shutdown.signal, AbortSignal.timeout(15000)]),
  });
  // No HTTP body is printed, including rejected authorization or provider diagnostics.
  ensure(response.ok, 'BRIDGE_HTTP_REFUSED');
  const value = await limitedJson(response);
  return value;
}
function grants(value: any) {
  ensure(value?.available === true && value?.read_only === false && value?.can_write === true,
    'BRIDGE_GRANT_REFUSED');
}
function liveLease(expires: string) {
  ensure(Number.isFinite(Date.parse(expires)) && Date.parse(expires) - Date.now() > 15000,
    'BRIDGE_LEASE_TOO_SHORT');
}
function decode(content: Content) {
  ensure(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(content.content_base64),
    'BRIDGE_BASE64_INVALID');
  const bytes = Buffer.from(content.content_base64, 'base64');
  ensure(bytes.toString('base64') === content.content_base64, 'BRIDGE_BASE64_INVALID');
  verifyPrintBridgeBytes(bytes, content.format, content.content_sha256, content.content_bytes);
  return bytes;
}
async function cups(queue: string, copies: number, file: string) {
  const args = printBridgeCupsArgs(queue, copies, file);
  return new Promise<string>((ok, fail) => {
    let output = '', overflow = false;
    const child = spawn('/usr/bin/lp', args, { shell: false, env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
      stdio: ['ignore','pipe','pipe'], signal: AbortSignal.any([shutdown.signal, AbortSignal.timeout(15000)]) });
    child.stdout.on('data', (value: Buffer) => {
      output += value.toString('utf8');
      if (Buffer.byteLength(output) > 4096) { overflow = true; child.kill('SIGTERM'); }
    });
    child.stderr.on('data', () => {});
    child.once('error', () => fail(new Error('BRIDGE_CUPS_RESULT_UNKNOWN')));
    child.once('close', (code) => {
      try {
        ensure(code === 0 && !overflow, 'BRIDGE_CUPS_RESULT_UNKNOWN');
        ok(printBridgeCupsReference(output, queue));
      } catch { fail(new Error('BRIDGE_CUPS_RESULT_UNKNOWN')); }
    });
  });
}
async function acknowledge(journal: Journal) {
  ensure(journal.state === 'ack_intent' && journal.ack && journal.content, 'BRIDGE_ACK_NOT_SAVED');
  ensure(journal.ack.version === journal.job_version && journal.ack.lease_token === journal.claim.lease_token &&
    journal.ack.content_sha256 === journal.content.content_sha256 && journal.content.job_id === journal.job_id &&
    journal.content.printer_snapshot.id === journal.config.printer_id, 'BRIDGE_ACK_BINDING_INVALID');
  decode(journal.content);
  if (journal.ack.result === 'file_saved')
    ensure(journal.content.printer_snapshot.output_mode === 'file' &&
      journal.ack.artifact_name === printBridgeFileName(journal.job_id, journal.content.content_sha256, journal.content.format) &&
      !journal.ack.spool_job_id, 'BRIDGE_ACK_BINDING_INVALID');
  else ensure(journal.content.printer_snapshot.output_mode === 'cups' && !journal.ack.artifact_name &&
    journal.ack.spool_job_id?.startsWith(journal.content.printer_snapshot.cups_queue + '-'), 'BRIDGE_ACK_BINDING_INVALID');
  const reply = await request(journal.config, `/print-jobs/jobs/${journal.job_id}/ack`, 'POST', journal.ack);
  grants(reply);
  const job = jobShape.parse(reply.job);
  ensure(job.id === journal.job_id && job.printer_id === journal.config.printer_id &&
    job.state === journal.ack.result && BigInt(job.version) === BigInt(journal.ack.version) + 1n,
    'BRIDGE_ACK_NOT_CONFIRMED');
  ensure(job.content_sha256 === journal.content.content_sha256 && job.content_bytes === journal.content.content_bytes &&
    job.format === journal.content.format && job.copies === journal.content.copies,
    'BRIDGE_ACK_CONTENT_CHANGED');
  journal.state = 'complete'; await save(journal);
  console.log(JSON.stringify({ status: 'PRINT_BRIDGE_ACK_COMPLETE', result: journal.ack.result,
    physical_paper_verified: false }));
}
async function reconcile(journal: Journal) {
  const reply = await request(journal.config, `/print-jobs/jobs/${journal.job_id}`);
  grants(reply);
  const job = jobShape.parse(reply.job);
  ensure(job.id === journal.job_id && job.printer_id === journal.config.printer_id &&
    ['unknown','cancelled'].includes(job.state), 'BRIDGE_RECONCILIATION_NOT_CONFIRMED');
  journal.state = 'reconciled'; await save(journal);
  console.log(JSON.stringify({ status: 'PRINT_BRIDGE_ADMIN_TERMINAL_STATE_CONFIRMED',
    claimed_print_success: false, physical_paper_verified: false }));
}
async function takeProcessLock(mode: PrintBridgeMode) {
  // All starts/recovery serialize on this exclusive gate; two manual recoveries
  // cannot unlink a newly acquired live lock after inspecting the same dead PID.
  const gate = join(base, 'process-gate.lock');
  await newPrivate(gate, JSON.stringify({ pid: process.pid, nonce: randomUUID() }));
  try {
    if (!await absent(lockPath)) {
      ensure(mode === 'retry-ack' || mode === 'reconcile', 'BRIDGE_STALE_LOCK_MANUAL_REVIEW_REQUIRED');
      const prior = z.strictObject({ pid: z.number().int().positive(), nonce: uuid })
        .parse(JSON.parse(await readPrivate(lockPath, 1024)));
      let gone = false;
      try { process.kill(prior.pid, 0); }
      catch (err) { if ((err as NodeJS.ErrnoException).code === 'ESRCH') gone = true; }
      ensure(gone, 'BRIDGE_PROCESS_STILL_PRESENT');
      await unlink(lockPath); await syncDirectory();
    }
    await newPrivate(lockPath, JSON.stringify({ pid: process.pid, nonce: randomUUID() }));
  } finally { await unlink(gate); await syncDirectory(); }
}
async function cycle(config: PrintBridgeConfig) {
  // The server pages DESC. Reach the last page before choosing its last (oldest)
  // queued job; never silently fall back to a newer job at the traversal bound.
  let chosen: z.infer<typeof jobShape> | null = null;
  let cursor: string | null = null, complete = false;
  const seen = new Set<string>(), cursors = new Set<string>();
  if (config.job_id) {
    const exact = await request(config, `/print-jobs/jobs/${config.job_id}`);
    grants(exact); const job = jobShape.parse(exact.job);
    ensure(job.id === config.job_id && job.printer_id === config.printer_id && job.state === 'queued', 'BRIDGE_EXACT_JOB_UNAVAILABLE');
    chosen = job; complete = true;
  } else {
  for (let pageIndex = 0; pageIndex < 40; pageIndex++) {
    const page = await request(config, `/print-jobs/jobs?printer_id=${config.printer_id}&state=queued&limit=50${cursor ? '&cursor=' + cursor : ''}`);
    grants(page); ensure(Array.isArray(page.jobs) && page.jobs.length <= 50, 'BRIDGE_PAGE_INVALID');
    for (const raw of page.jobs) {
      const job = jobShape.parse(raw);
      ensure(job.printer_id === config.printer_id && job.state === 'queued' && !seen.has(job.id), 'BRIDGE_JOB_SCOPE_INVALID');
      seen.add(job.id); chosen = job;
    }
    if (page.next_cursor === null) { complete = true; break; }
    ensure(page.jobs.length > 0, 'BRIDGE_PAGE_INCOMPLETE');
    const next = uuid.parse(page.next_cursor);
    ensure(!cursors.has(next), 'BRIDGE_CURSOR_REPEATED'); cursors.add(next); cursor = next;
  }
  }
  ensure(complete, 'BRIDGE_QUEUE_READ_LIMIT');
  if (!chosen) { console.log(JSON.stringify({ status: 'PRINT_BRIDGE_NO_QUEUED_JOB' })); return false; }
  const journal: Journal = { journal_version: 1, state: 'claim_intent', config,
    job_id: chosen.id, claim: { client_key: randomUUID(), version: chosen.version, lease_token: randomUUID() }, saved_at: '' };
  await save(journal, true); // Durable exact request/principal/token precedes the first POST.
  const claim = await request(config, `/print-jobs/jobs/${chosen.id}/claim`, 'POST', journal.claim);
  grants(claim); const job = jobShape.parse(claim.job);
  ensure(job.id === chosen.id && job.printer_id === config.printer_id && job.state === 'claimed' && job.lease_expires_at,
    'BRIDGE_CLAIM_NOT_CONFIRMED');
  ensure(job.format === chosen.format && job.copies === chosen.copies && job.content_bytes === chosen.content_bytes &&
    job.content_sha256 === chosen.content_sha256, 'BRIDGE_FROZEN_JOB_CHANGED');
  liveLease(job.lease_expires_at);
  journal.state = 'claimed'; journal.job_version = job.version; await save(journal);
  const received = await request(config, `/print-jobs/jobs/${chosen.id}/content`, 'GET', undefined, journal.claim.lease_token);
  const content = contentShape.parse(received);
  ensure(content.job_id === chosen.id && content.version === job.version &&
    content.printer_snapshot.id === config.printer_id && content.printer_snapshot.format === content.format &&
    content.printer_snapshot.enabled, 'BRIDGE_CONTENT_SCOPE_INVALID');
  ensure(content.format === job.format && content.copies === job.copies && content.content_bytes === job.content_bytes &&
    content.content_sha256 === job.content_sha256, 'BRIDGE_FROZEN_CONTENT_CHANGED');
  liveLease(content.lease_expires_at);
  ensure(content.lease_expires_at === job.lease_expires_at, 'BRIDGE_LEASE_CHANGED');
  const bytes = decode(content);
  const filename = printBridgeFileName(chosen.id, content.content_sha256, content.format);
  const file = join(base, filename);
  if (content.printer_snapshot.output_mode === 'cups')
    printBridgeCupsArgs(content.printer_snapshot.cups_queue ?? '', content.copies, file);
  else ensure(content.printer_snapshot.cups_queue === null, 'BRIDGE_FILE_PRINTER_INVALID');
  journal.content = content;
  ensure(Date.parse(content.lease_expires_at) - Date.now() > 35000, 'BRIDGE_LEASE_TOO_SHORT');
  journal.state = 'dispatch_intent'; await save(journal); // Never dispatch before durable intent.
  await newPrivate(file, bytes);
  let ack: z.infer<typeof ackBody> = { client_key: randomUUID(), version: job.version,
    lease_token: journal.claim.lease_token, content_sha256: content.content_sha256, result: 'file_saved', artifact_name: filename };
  if (content.printer_snapshot.output_mode === 'cups') {
    ensure(Date.parse(content.lease_expires_at) - Date.now() > 30000, 'BRIDGE_LEASE_TOO_SHORT');
    const spool_job_id = await cups(content.printer_snapshot.cups_queue!, content.copies, file);
    ack = { client_key: ack.client_key, version: ack.version, lease_token: ack.lease_token,
      content_sha256: ack.content_sha256, result: 'spool_submitted', spool_job_id };
  }
  journal.ack = ack; journal.state = 'ack_intent'; await save(journal);
  await acknowledge(journal);
  return true;
}
async function main() {
  const mode = printBridgeMode(process.argv.slice(2));
  const configPath = process.env.DYNA_PRINT_BRIDGE_CONFIG;
  ensure(configPath && resolve(configPath) === configPath, 'BRIDGE_CONFIG_PATH_REQUIRED');
  const config = printBridgeConfig.parse(JSON.parse(await readPrivate(configPath, 16384)));
  await checkDirectory(root);
  await mkdir(join(root, 'data'), { mode: 0o700 }).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'EEXIST') throw e; });
  await checkDirectory(join(root, 'data'));
  base = join(controlRoot, config.tenant_id, config.printer_id);
  currentPath = join(base, 'current.json'); lockPath = join(base, 'process.lock');
  for (const directory of [controlRoot, join(controlRoot, config.tenant_id), base]) {
    await mkdir(directory, { mode: 0o700 }).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'EEXIST') throw e; });
    await checkDirectory(directory, true);
  }
  let journal = await absent(currentPath) ? null : journalShape.parse(JSON.parse(await readPrivate(currentPath)));
  if (journal) {
    if (!['complete','empty','reconciled'].includes(journal.state))
      ensure(JSON.stringify(journal.config) === JSON.stringify(config), 'BRIDGE_PRINCIPAL_CHANGED');
    ensure(printBridgeJournalDecision(journal.state, mode) !== 'manual_reconcile', 'BRIDGE_UNRESOLVED_JOURNAL');
  } else ensure(mode !== 'retry-ack' && mode !== 'reconcile', 'BRIDGE_JOURNAL_NOT_SAVED');
  // Only explicit ACK retry or read-only reconcile may recover a dead process lock.
  // Neither command can send bytes to an output device or create a fresh claim.
  await takeProcessLock(mode);
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  try {
    if (mode === 'retry-ack') { await acknowledge(journal!); return; }
    if (mode === 'reconcile') { await reconcile(journal!); return; }
    if (journal) { await archive(journal); journal = null; }
    do {
      const processed = await cycle(config);
      if (mode === 'once') return;
      if (processed) {
        const completed = journalShape.parse(JSON.parse(await readPrivate(currentPath)));
        ensure(completed.state === 'complete', 'BRIDGE_ACK_NOT_CONFIRMED'); await archive(completed);
      }
      if (!stopped) await pause(1000, undefined, { signal: shutdown.signal });
    } while (!stopped);
  } finally {
    process.off('SIGINT', stop); process.off('SIGTERM', stop);
    await unlink(lockPath); await syncDirectory();
  }
}
await main().catch(() => { console.error(printBridgeSafeFailure()); process.exitCode = 1; });
