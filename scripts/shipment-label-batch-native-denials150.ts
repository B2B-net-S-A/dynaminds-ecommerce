/** Root-only QA150 committed retry/denials AFTER all three file_saved ACKs.
 * Authoring does not execute this helper. Never resumes an existing journal.
 * All database operations are read-only; the only POSTs are the six explicitly
 * journalled replay/denial requests. No carrier, bridge, login or queue creation.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { Pool } from 'pg';

const root = '<workspace>/app';
const docs = '<workspace>/worktrees/stock-file-import/docs';
const base = 'http://127.0.0.1:4100/api';
const fixturePath = resolve(root, 'data/shipment-label-batch-stage150.json');
const journalPath = resolve(root, 'data/shipment-label-batch-stage150-denials.json');
const reportPath = resolve(docs, 'shipment-label-batch-native150-denials.json');
const filesReportPath = resolve(docs, 'shipment-label-batch-native150-after-files.json');
const sha = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const digest = (v: unknown) => sha(JSON.stringify(v));
const encode = (v: unknown) => JSON.stringify(v, null, 2) + '\n';
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
type Snapshot = Record<string, { count: number; sha256: string }>;
let database: Pool | undefined;
let step = 'preflight';

async function regular(path: string, privateFile = false) {
  const f = await lstat(path);
  assert(f.isFile() && !f.isSymbolicLink(), 'Regular file required');
  if (privateFile) assert.equal(f.mode & 0o777, 0o600, 'Private file mode');
  return readFile(path);
}
async function exclusive(path: string, value: unknown, mode: number) {
  const f = await open(path, 'wx', mode);
  try {
    await f.writeFile(encode(value));
    await f.sync();
  } finally { await f.close(); }
}
async function atomicJournal(value: unknown) {
  await regular(journalPath, true);
  const tmp = journalPath + '.' + randomUUID() + '.tmp';
  try {
    await exclusive(tmp, value, 0o600);
    await rename(tmp, journalPath);
    const dir = await open(dirname(journalPath), 'r');
    try { await dir.sync(); } finally { await dir.close(); }
  } finally { await unlink(tmp).catch(() => {}); }
}
async function absent(path: string) {
  try { await lstat(path); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw e;
  }
  throw Error('Exclusive QA output already exists; manual inspection required');
}
async function json(response: Response) {
  const bytes = Buffer.from(await response.arrayBuffer());
  assert(bytes.length <= 4 * 1024 * 1024, 'Response bound');
  return JSON.parse(bytes.toString('utf8'));
}

async function main() {
  assert.equal(resolve(process.cwd()), root);
  assert.equal(process.env.DYNA_LOCAL_CONFIG_PATH, resolve(root, '.local.json'));
  assert.notEqual(process.env.DYNA_TEST, 'true');
  assert.equal(process.env.DYNA_WORKER_DISABLED, 'true');
  assert.equal(process.env.QA150_DENIALS_CONFIRM, 'CHECK_COMMITTED_FILE_SAVED_BATCH');
  const revision = process.env.QA_EXPECTED_REVISION ?? '';
  assert.match(revision, /^[a-f0-9]{40}$/);
  await regular(resolve(root, '.local.json'), true);
  for (const dir of [resolve(root, 'data'), docs]) {
    const d = await lstat(dir);
    assert(d.isDirectory() && !d.isSymbolicLink(), 'Controlled output directory');
  }
  await absent(journalPath);
  await absent(reportPath);
  const fixtureBytes = await regular(fixturePath, true);
  const s = JSON.parse(fixtureBytes.toString('utf8'));
  assert.equal(s.stage, 150);
  assert.equal(s.complete, true);
  assert.equal(s.pending, null);
  for (const id of [s.tenant_id, s.user_id]) assert.match(id, uuid);
  assert.equal(typeof s.cookie, 'string');
  assert(s.cookie.length > 0 && !/[\r\n]/.test(s.cookie), 'Valid retained session');
  assert.equal(s.shipments.length, 3);
  assert.equal(s.orders.length, 2);
  assert.equal(s.controlled_transport_callbacks.length, 3);
  const filesBytes = await regular(filesReportPath);
  const files = JSON.parse(filesBytes.toString('utf8'));
  assert.equal(files.stage, 150);
  assert.equal(files.status, 'NATIVE_READBACK_PASS');
  assert.equal(files.phase, 'after-files');
  assert.equal(files.schema_revision, '133_order_shipments');
  assert.equal(files.tenant_id, s.tenant_id);
  assert.equal(files.batches.length, 1);
  assert.equal(files.jobs.length, 3);
  assert(files.jobs.every((j: any) => j.state === 'file_saved' && j.version === '3'));
  assert.equal(files.original_job_bytes_exact, true);

  async function health() {
    const response = await fetch(base + '/health', {
      redirect: 'error', signal: AbortSignal.timeout(10000), cache: 'no-store',
    });
    assert.equal(response.status, 200);
    const h = await json(response);
    assert.equal(h.status, 'ok');
    assert.equal(h.revision, revision);
    assert.equal(h.schema_revision, '133_order_shipments');
    assert.equal(h.mode, 'local');
    assert.equal(h.restore_preview, false);
    assert.equal(h.background_workers_enabled, false);
    assert.equal(h.shipment_label_batches_available, true);
    assert.equal(h.shipment_label_print_available, true);
  }
  await health();
  // Native database module loaded only after exclusive-output/local health checks.
  database = (await import('../server/db')).pool;
  const url = new URL(database.options.connectionString!);
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.port, '55432');
  assert.equal(url.pathname, '/dynaminds');
  const db = database;
  async function snapshot(): Promise<Snapshot> {
    const c = await db.connect();
    try {
      await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await c.query("SET LOCAL TimeZone='UTC'");
      const native = (await c.query("SELECT current_user role,current_database() db,host(inet_server_addr()) host,inet_server_port() port")).rows[0];
      assert.deepEqual(native, { role: 'postgres', db: 'dynaminds', host: '127.0.0.1', port: 55432 });
      const names = (await c.query("SELECT table_name FROM information_schema.tables t WHERE table_schema='public' AND table_type='BASE TABLE' AND table_name<>'sessions' AND (table_name IN('users','tenants') OR EXISTS(SELECT 1 FROM information_schema.columns k WHERE k.table_schema=t.table_schema AND k.table_name=t.table_name AND column_name='tenant_id')) ORDER BY table_name")).rows.map(r => r.table_name as string);
      assert.equal(names.length, 378);
      const result: Snapshot = {};
      for (const name of names) {
        assert.match(name, /^[a-z_][a-z0-9_]*$/);
        const key = ['users', 'tenants'].includes(name) ? 'id' : 'tenant_id';
        const id = name === 'users' ? s.user_id : s.tenant_id;
        const rows = (await c.query(`SELECT to_jsonb(q) row FROM "${name}" q WHERE ${key}=$1 ORDER BY 1`, [id])).rows;
        result[name] = { count: rows.length, sha256: digest(rows) };
      }
      await c.query('COMMIT');
      return result;
    } finally { await c.query('ROLLBACK').catch(() => {}); c.release(); }
  }
  async function get(path: string) {
    const r = await fetch(base + path, {
      headers: { cookie: s.cookie, 'X-Workspace-ID': s.tenant_id },
      redirect: 'error', signal: AbortSignal.timeout(10000), cache: 'no-store',
    });
    assert.equal(r.status, 200, 'Fresh authenticated GET');
    return json(r);
  }
  const baseline = await snapshot();
  assert.deepEqual(baseline, files.snapshot, 'Exact accepted after-files snapshot');
  assert.equal(baseline.print_jobs.count, 3);
  assert.equal(baseline.print_job_events.count, 10);
  assert.equal(baseline.shipment_label_batch_previews.count, 1);
  assert.equal(baseline.shipment_label_batch_executions.count, 1);
  const c = await db.connect();
  let p: any, e: any, children: any[] = [];
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await c.query("SET LOCAL TimeZone='UTC'");
    const parents = (await c.query('SELECT id,scope_hash,actor_id,api_key_id FROM shipment_label_batch_previews WHERE tenant_id=$1', [s.tenant_id])).rows;
    const executions = (await c.query('SELECT id,preview_id,actor_id,api_key_id,request,payload FROM shipment_label_batch_executions WHERE tenant_id=$1', [s.tenant_id])).rows;
    assert.equal(parents.length, 1); assert.equal(executions.length, 1);
    p = parents[0]; e = executions[0];
    assert.equal(p.id, files.batches[0].preview_id);
    assert.equal(e.id, files.batches[0].execution_id);
    assert.equal(e.preview_id, p.id);
    assert.equal(p.actor_id, s.user_id); assert.equal(e.actor_id, s.user_id);
    assert.equal(p.api_key_id, null); assert.equal(e.api_key_id, null);
    assert.deepEqual(Object.keys(e.request).sort(), ['client_key', 'confirmed', 'scope_hash']);
    assert.match(e.request.client_key, uuid); assert.equal(e.request.confirmed, true);
    assert.equal(e.request.scope_hash, p.scope_hash);
    children = (await c.query('SELECT r.index,r.child_preview_id,r.job_id,l.request,j.state,j.version::text FROM shipment_label_batch_execution_rows r JOIN print_job_label_sources l ON(l.tenant_id,l.preview_id,l.job_id)=(r.tenant_id,r.child_preview_id,r.job_id) JOIN print_jobs j ON(j.tenant_id,j.id)=(r.tenant_id,r.job_id) WHERE r.tenant_id=$1 AND r.execution_id=$2 ORDER BY r.index', [s.tenant_id, e.id])).rows;
    assert.deepEqual(children.map(v => v.index), [0, 1, 2]);
    assert.equal(new Set(children.map(v => v.job_id)).size, 3);
    for (const row of children) {
      assert.equal(row.state, 'file_saved'); assert.equal(row.version, '3');
      assert.match(row.child_preview_id, uuid); assert.match(row.request.client_key, uuid);
      assert.equal(row.request.confirmed, true);
      assert.equal(row.child_preview_id, e.payload.rows[row.index].child_preview_id);
      assert.equal(row.job_id, e.payload.rows[row.index].job_id);
    }
    await c.query('COMMIT');
  } finally { await c.query('ROLLBACK').catch(() => {}); c.release(); }
  const route = '/print-jobs/label-batches/previews/' + p.id + '/queue';
  const executionPath = '/print-jobs/label-batches/executions/' + e.id;
  const fresh = await get(executionPath);
  assert.equal(fresh.available, true); assert.equal(fresh.batch_available, true);
  assert.equal(fresh.can_write, true); assert.equal(fresh.read_only, false);
  assert.equal(fresh.current_role, 'admin');
  assert.equal(fresh.execution.id, e.id);
  assert.deepEqual(fresh.execution.progress.map((r: any) => [r.index, r.job_id, r.state, r.version]), children.map(r => [r.index, r.job_id, 'file_saved', '3']));
  assert.deepEqual(await snapshot(), baseline, 'Preflight reads have no business effects');

  const journal: any = {
    stage: 150, revision, schema_revision: '133_order_shipments',
    tenant_id: s.tenant_id, user_id: s.user_id, fixture_sha256: sha(fixtureBytes),
    after_files_report_sha256: sha(filesBytes), before: baseline,
    pending: null, completed: [], complete: false,
  };
  await exclusive(journalPath, journal, 0o600);
  async function check(label: string, path: string, body: any, expected: number, message?: string) {
    step = label;
    await health();
    const before = await snapshot();
    assert.deepEqual(before, baseline, 'No prior operation drift');
    journal.pending = { step: label, method: 'POST', path, body, expected_status: expected, before_sha256: digest(before), received: null };
    await atomicJournal(journal);
    const response = await fetch(base + path, {
      method: 'POST', headers: { cookie: s.cookie, 'X-Workspace-ID': s.tenant_id, 'Content-Type': 'application/json' },
      body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(10000),
    });
    const result = await json(response);
    journal.pending.received = { status: response.status, response_sha256: digest(result) };
    await atomicJournal(journal);
    assert.equal(response.status, expected, 'Exact expected route status');
    if (message) assert.equal(result.detail, message, 'Exact protocol denial');
    if (expected === 422) {
      assert.equal(result.status, 422);
      assert.equal(typeof result.detail, 'string');
      assert(result.detail.includes('confirmed:'), 'Consent schema refusal reached');
    }
    if (expected === 200) {
      assert.equal(result.reused, true);
      assert.deepEqual(result.execution, fresh.execution, 'Exact durable receipt and current final progress');
    }
    const after = await snapshot();
    assert.deepEqual(after, before, 'Every business table including audit remains exact');
    journal.completed.push({ step: label, status: expected, path, body_sha256: digest(body), response_sha256: digest(result), before_sha256: digest(before), after_sha256: digest(after), all_tables_unchanged: 378 });
    journal.pending = null;
    await atomicJournal(journal);
  }
  await check('parent-committed-exact-replay', route, e.request, 200);
  const altered = (p.scope_hash[0] === '0' ? '1' : '0') + p.scope_hash.slice(1);
  await check('parent-same-key-altered-hash', route, { ...e.request, scope_hash: altered }, 409, 'Klucz kolejki partii ma inną treść');
  await check('parent-false-consent', route, { ...e.request, confirmed: false }, 422);
  for (const row of children) {
    await check('standalone-linked-child-' + row.index, '/print-jobs/label-previews/' + row.child_preview_id + '/queue', row.request, 409, 'Pozycję partii można zlecić wyłącznie z całą partią');
  }
  step = 'final-readback';
  assert.deepEqual((await get(executionPath)).execution, fresh.execution);
  const after = await snapshot();
  assert.deepEqual(after, baseline);
  assert.equal(sha(await regular(fixturePath, true)), sha(fixtureBytes), 'Original private fixture bytes unchanged');
  assert.equal(sha(await regular(filesReportPath)), sha(filesBytes), 'Original accepted report bytes unchanged');
  await health();
  assert.equal(journal.completed.length, 6);
  assert.equal(journal.pending, null);
  journal.after = after;
  journal.complete = true;
  await atomicJournal(journal);
  await exclusive(reportPath, {
    stage: 150, status: 'COMMITTED_REPLAY_AND_DENIALS_PASS', revision,
    schema_revision: '133_order_shipments', tenant_id: s.tenant_id,
    preview_id: p.id, execution_id: e.id, own_tables: 378,
    jobs: 3, file_saved: 3, print_events: baseline.print_job_events.count,
    checks: journal.completed, before: baseline, after,
    snapshot_sha256: digest(after), sessions_excluded: true,
    no_new_jobs_events_or_audit: true, fixture_bytes_unchanged: true,
    provider_requests_by_helper: 0, provider_verified: false,
    physical_print_verified: false, lost_ack_verified: false,
    concurrency_verified: false, full_goal_complete: false,
  }, 0o644);
  console.log(JSON.stringify({ status: 'COMMITTED_REPLAY_AND_DENIALS_PASS', checks: 6, own_tables: 378, jobs: 3 }));
}
main().catch(() => {
  // Assertions/HTTP bodies may contain private values: emit only fixed step/code.
  console.error(JSON.stringify({ status: 'QA150_DENIALS_FAILED', step, code: 'PRIVATE_DETAILS_WITHHELD' }));
  process.exitCode = 1;
}).finally(() => database?.end());
